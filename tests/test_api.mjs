import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { listen_local } from './local_port.mjs';
import { API_PROVIDERS, api_base_url, api_check, api_generate, api_history, api_models, api_request, api_response, api_tool_results, read_api_key, save_api_key } from '../runner/discussion_api.mjs';
import { api_lockdown, execute_tool, participant_tools, system_prompt } from '../runner/adapters/api.mjs';
import { BASH_MISSING, find_bash, pi_delivery, session_fits, session_tools } from '../runner/adapters/api_pi.mjs';
import { pi_tool_path } from '../runner/adapters/api_pi_extension.mjs';
import { fetch_page, html_text, is_private_address, run_web_tool, web_search_key } from '../runner/adapters/api_web.mjs';
import { deliver_task, execution_details } from '../runner/adapters/index.mjs';
import { draw_image, launch_discussion, room_settings, validate_preset } from '../runner/discussion_launch.mjs';
import { save_image_settings } from '../runner/image_service.mjs';
import { t } from '../runner/i18n.mjs';
import { save_workflow } from '../runner/workflows.mjs';
import { api, DiscussionStore, load_config } from '../runner/discussion_runner.mjs';
import { FreeRoomRunner } from '../runner/free_runner.mjs';
import { ROUTE_GUIDED_PROMPT_VERSION } from '../runner/scheduler.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SECRET = 'mock-api-key-never-in-room-or-prompt';
// Room executions of API members run in the Pi harness; the tests use the pinned dev copy.
process.env.CODISCUSS_PI_CLI = join(ROOT, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js');

/** A temporary real website and an isolated private configuration directory. */
async function site_fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'codiscuss-api-'));
  const cleanup = [];
  const script = "import sys; from backend.server import DiscussionServer,init_database; init_database(sys.argv[1],seed=False); server=DiscussionServer(('127.0.0.1',0),sys.argv[1]); print(server.server_port,flush=True); server.serve_forever()";
  const child = spawn(process.platform === 'win32' ? 'python' : 'python3', ['-u', '-c', script, join(home, 'site.sqlite3')],
    { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = new Promise(resolve => child.once('close', resolve));
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  t.after(async () => {
    for (const close of cleanup) await close();
    child.kill(); await closed;
    // A Pi process ends a moment after its answer is saved; Windows keeps its files until then.
    for (let attempt = 0; ; attempt++) {
      try { rmSync(home, { recursive: true, force: true }); break; } catch (error) { if (attempt >= 50) throw error; await delay(200); }
    }
  });
  const port = await new Promise((resolve, reject) => {
    child.stdout.once('data', chunk => resolve(Number(String(chunk).trim())));
    child.once('error', reject); child.once('exit', () => reject(new Error(errors)));
  });
  return { home, site: `http://127.0.0.1:${port}`, cleanup };
}

/** An HTTP model fixture records wire payloads; no external model or billing is involved. */
async function model_fixture(t, respond) {
  const calls = [];
  const server = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk;
    const call = { path: request.url.split('?')[0], headers: request.headers, body: text ? JSON.parse(text) : null };
    calls.push(call);
    try {
      const result = await respond(call, calls);
      if (result === undefined) return;
      // Pi streams every request; the runner's own calls (private chat, checks) do not.
      if (call.body?.stream || call.path.includes(':streamGenerateContent')) {
        response.setHeader('Content-Type', 'text/event-stream'); response.end(sse(call, result));
      } else { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(result)); }
    } catch (error) { response.statusCode = 500; response.end(JSON.stringify({ error: error.message })); }
  });
  await listen_local(server);
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { base_url: `http://127.0.0.1:${server.address().port}/custom/v1`, calls, server };
}

/** Return a tool call in any of the four provider protocols. */
function tool_reply(call, name, args = {}) {
  const id = randomUUID();
  if (call.path.endsWith('/responses')) return { status: 'completed', output: [{ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) }] };
  if (call.path.endsWith('/messages')) return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input: args }] };
  if (/generatecontent/i.test(call.path)) return { candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ functionCall: { name, args }, thoughtSignature: 'opaque-signature' }] } }] };
  return { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', reasoning_content: 'opaque-reasoning', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] };
}

/** One non-streaming reply as the server-sent events of a streaming request in the same protocol. */
function sse(call, reply) {
  const data = events => events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
  if (call.path.includes(':streamGenerateContent')) return data([{ ...reply, usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } }]);
  if (call.path.endsWith('/responses')) {
    const output = (reply.output || []).map((item, index) => ({ id: `item_${index}`, ...item }));
    return data([{ type: 'response.created', response: { id: 'resp_1', status: 'in_progress', output: [] } },
      ...output.flatMap((item, index) => [
        { type: 'response.output_item.added', output_index: index, item: item.type === 'function_call' ? { ...item, arguments: '' } : { ...item, content: [] } },
        { type: 'response.output_item.done', output_index: index, item }]),
      { type: 'response.completed', response: { id: 'resp_1', status: reply.status || 'completed', output, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }]);
  }
  if (call.path.endsWith('/messages')) {
    const events = [{ type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], model: call.body.model, stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } }];
    (reply.content || []).forEach((block, index) => events.push(block.type === 'tool_use'
      ? { type: 'content_block_start', index, content_block: { ...block, input: {} } } : { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
    block.type === 'tool_use' ? { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } }
      : { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } }, { type: 'content_block_stop', index }));
    events.push({ type: 'message_delta', delta: { stop_reason: reply.stop_reason }, usage: { output_tokens: 1 } }, { type: 'message_stop' });
    return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
  }
  const { message, finish_reason } = reply.choices[0];
  const delta = { role: 'assistant', ...(message.content ? { content: message.content } : {}), ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}),
    ...(message.tool_calls ? { tool_calls: message.tool_calls.map((tool, index) => ({ index, ...tool })) } : {}) };
  const chunk = { id: 'chunk_1', object: 'chat.completion.chunk', created: 0, model: call.body.model };
  return `${data([{ ...chunk, choices: [{ index: 0, delta, finish_reason: null }] },
    { ...chunk, choices: [{ index: 0, delta: {}, finish_reason }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }])}data: [DONE]\n\n`;
}

/** The text of each user message in a protocol-specific request, in order; tool results are not text. */
function user_texts(call) {
  const items = call.body.input || call.body.messages || call.body.contents || [];
  return items.filter(item => item.role === 'user').map(item => (typeof item.content === 'string' ? item.content
    : (item.content || item.parts || []).map(part => (typeof part === 'string' ? part
      : ['text', 'input_text'].includes(part.type) || (!part.type && typeof part.text === 'string') ? part.text : '')).join('')));
}

/** Read the room prompt of the execution a request belongs to: the latest one, as a member's session keeps earlier ones. */
function room_prompt(call) {
  const text = user_texts(call).findLast(item => item.startsWith('{"room"'));
  return JSON.parse(text.slice(0, text.lastIndexOf('}') + 1));
}

/** Wait on observable effects while continuing real runner ticks. */
async function until(check, tick = async () => {}, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await tick();
    if (await check()) return;
    await delay(15);
  }
  throw new Error('fixture timed out');
}

/** This computer's image service at the mock. */
function save_image_service(home, base_url) {
  save_image_settings(home, { base_url, model: 'gpt-image-2.6-flare', ...save_api_key(home, { base_url, api_key: SECRET }) });
}

/** This computer's image service at the mock, and the room's drawing switch turned on through the owner's setting. */
async function enable_images(home, base_url, started) {
  save_image_service(home, base_url);
  const config = load_config(started.config_path);
  await room_settings(home, { site: config.site, room_id: config.room, token: config.token, image_generation: true });
  return load_config(started.config_path);
}

/** Build local profiles for every visible provider without any installed AI software. */
function profiles(home, base_url) {
  const key = save_api_key(home, { base_url, api_key: SECRET });
  return Object.fromEntries(Object.entries(API_PROVIDERS).map(([name, preset]) => [name, {
    adapter: 'api', base_url, api_protocol: preset.api_protocol, model: `${name}/model.1`, ...key,
  }]));
}

test('provider presets preserve model IDs, separate identity from protocol and bind private keys to URLs', async t => {
  const f = await site_fixture(t);
  assert.equal(API_PROVIDERS.OpenAI.base_url, 'https://api.openai.com/v1');
  assert.equal(API_PROVIDERS.OpenAI.api_protocol, 'responses');
  assert.equal(API_PROVIDERS.Custom.base_url, '');
  assert.equal(API_PROVIDERS.Custom.api_protocol, 'chat');
  assert.equal(api_base_url('https://openrouter.ai/api/v1/'), 'https://openrouter.ai/api/v1');
  assert.throws(() => api_base_url('https://key@example.test/v1'), /凭据/);
  const profile = profiles(f.home, 'https://openrouter.ai/api/v1').Custom;
  profile.api_protocol = 'chat';
  assert.equal(read_api_key(f.home, profile), SECRET);
  assert.ok(!JSON.stringify(profile).includes(SECRET));
  assert.throws(() => read_api_key(f.home, { ...profile, base_url: 'https://api.x.ai/v1' }), /重新填写/);
  const request = api_request(profile, { system: 'test', history: [], tools: participant_tools({ role: 'expert' }) });
  assert.equal(request.path, '/chat/completions');
  assert.equal(request.body.model, 'Custom/model.1');
  assert.ok(!('reasoning_effort' in request.body));
});

test('four protocols authenticate correctly and preserve tool result pairing and opaque reasoning', async t => {
  const f = await site_fixture(t);
  const mock = await model_fixture(t, call => call.path.endsWith('/models') ? { data: [{ id: 'vendor/model.1' }] } : tool_reply(call, 'read_room'));
  for (const api_protocol of ['responses', 'anthropic', 'gemini', 'chat']) {
    const profile = { ...profiles(f.home, mock.base_url).Codex, api_protocol };
    const context = { system: 'test', history: api_history(profile, 'user request'), tools: participant_tools({ role: 'expert' }) };
    const calls = await api_generate(profile, SECRET, context);
    assert.equal(calls[0].name, 'read_room');
    api_tool_results(profile, context.history, [{ ...calls[0], result: { ok: true } }]);
    const wire = mock.calls.at(-1);
    assert.equal(wire.headers[api_protocol === 'anthropic' ? 'x-api-key' : api_protocol === 'gemini' ? 'x-goog-api-key' : 'authorization'],
      ['anthropic', 'gemini'].includes(api_protocol) ? SECRET : `Bearer ${SECRET}`);
    assert.ok(wire.path.startsWith('/custom/v1/'));
    assert.ok(!JSON.stringify(wire.body).includes(SECRET));
    if (api_protocol === 'gemini') assert.equal(context.history[1].parts[0].thoughtSignature, 'opaque-signature');
    if (api_protocol === 'chat') assert.equal(context.history[1].reasoning_content, 'opaque-reasoning');
    assert.equal((await api_models(f.home, profile)).models[0].id, 'vendor/model.1');
    assert.deepEqual(await api_check(f.home, profile), { ok: true });
  }
  const profile = { api_protocol: 'responses' }, history = [];
  api_response(profile, { output: [{ type: 'reasoning', encrypted_content: 'opaque' }, { type: 'function_call', call_id: 'c', name: 'read_room', arguments: '{}' }] }, history);
  assert.equal(history[0].encrypted_content, 'opaque');
});

async function start_free_session(t, { participants, host, title, scheduler, fixture }) {
  const f = fixture || await site_fixture(t);
  const started = await launch_discussion(f.home, { site: f.site, entry: 'web', participants, scheduler,
    room: { title, goal: title, mode: 'free', host, members: Object.keys(participants), submission_id: randomUUID() } },
  { start_service: async () => ({ running: true }) });
  const config = load_config(started.config_path), store = new DiscussionStore(config.directory), log = [];
  const runner = new FreeRoomRunner(config, store, undefined, line => log.push(line));
  f.cleanup.push(() => { runner.stop_children(); store.close(); });
  const before = await api(config, '/discussion');
  const session = await api(config, '/discussion', { action: 'start', revision: before.revision, goal: title });
  assert.equal(session.duplicate, false);
  return { f, started, config, store, runner, log, session: session.session };
}

test('API host tools read the latest roster and expose discussion actions only for a session host request', async t => {
  const ordinary = participant_tools({ mode: 'free', role: 'host' }).map(item => item.name);
  const host = participant_tools({ mode: 'free', role: 'host', discussion_request: { purpose: 'discuss_host' } }).map(item => item.name);
  const expert = participant_tools({ mode: 'free', role: 'member', discussion_request: { purpose: 'discuss' } }).map(item => item.name);
  assert.ok(!ordinary.includes('arrange_turns'));
  assert.ok(host.includes('arrange_turns') && host.includes('save_state') && host.includes('finish_discussion') && host.includes('host_message'));
  assert.ok(expert.includes('submit_chat') && !expert.includes('submit_opinion'));
  assert.ok(!ordinary.includes('host_message') && !expert.includes('host_message'));
});

test('API web tools reach public pages only and stay off for tasks confined to the room', async t => {
  const names = context => participant_tools({ mode: 'free', role: 'member', ...context }).map(item => item.name);
  for (const context of [{ project_access: 'read' }, { project_access: 'write', native_shell: true }]) {
    assert.ok(names({ ...context, web_search_key: 'key' }).includes('web_search') && names(context).includes('web_fetch'));
    assert.ok(!names(context).includes('web_search'), 'no DeepSeek key, no search');
  }
  assert.ok(!names(api_lockdown({ tool_lockdown: true, api_context: {} }).api_context).includes('web_fetch'));
  const group = api_lockdown({ tool_lockdown: true, api_context: {
    role: 'member', allowed_room_tools: ['read_room'], allow_public_web: true,
  } }).api_context;
  const group_tools = participant_tools(group);
  assert.ok(group_tools.some(tool => tool.name === 'web_fetch'));
  await assert.rejects(execute_tool(group, { name: 'write', arguments: { path: 'probe.txt', content: 'synthetic' } }, group_tools), /不允许的工具/);
  await assert.rejects(execute_tool(group, { name: 'edit', arguments: { path: 'probe.txt' } }, group_tools), /不允许的工具/);
  assert.ok(!names({ external_access: true, web_search_key: 'key' }).includes('web_search'));

  for (const address of ['127.0.0.1', '10.1.2.3', '100.71.206.50', '172.16.0.1', '192.168.1.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:127.0.0.1']) assert.ok(is_private_address(address), address);
  for (const address of ['8.8.8.8', '198.18.0.1', '2606:4700:4700::1111']) assert.ok(!is_private_address(address), address);

  let hits = 0;
  const server = createServer((request, response) => {
    hits += 1;
    response.writeHead(302, { location: `http://127.0.0.2:${server.address().port}/secret` }).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}/`;
  const group_fetch = await execute_tool(group, { name: 'web_fetch', arguments: { url: origin } }, group_tools);
  assert.match(group_fetch.result.error, /本机或内网/);
  await assert.rejects(run_web_tool('web_fetch', { url: origin }), /本机或内网/);
  await assert.rejects(run_web_tool('web_fetch', { url: `http://localhost:${server.address().port}/` }), /本机或内网/);
  await assert.rejects(run_web_tool('web_fetch', { url: 'file:///C:/Windows/win.ini' }), /http/);
  assert.equal(hits, 0);
  // A public page must not redirect into a private address: only 127.0.0.2 counts as private here.
  await assert.rejects(fetch_page(origin, { is_blocked: address => address === '127.0.0.2' }), /本机或内网/);
  assert.equal(hits, 1);
});

test('API web search bills only a DeepSeek key, sends it only to the DeepSeek Search API and reports its failures', async t => {
  const home = mkdtempSync(join(tmpdir(), 'codiscuss-web-search-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const openai = { base_url: 'https://api.openai.com/v1' };
  save_api_key(home, { ...openai, api_key: 'openai-key' });
  assert.equal(web_search_key(home, openai, 'openai-key'), '', 'another provider\'s key never pays for search');
  save_api_key(home, { base_url: 'https://api.deepseek.com/v1', api_key: 'saved-deepseek-key' });
  assert.equal(web_search_key(home, openai, 'openai-key'), 'saved-deepseek-key');
  assert.equal(web_search_key(home, { base_url: 'https://api.deepseek.com/v1' }, 'member-key'), 'member-key');

  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const calls = [];
  let reply = new Response(JSON.stringify({ results: [{ url: 'https://example.com/a', title: '步态', snippet: '摘要', summary: '概述', date: null }] }));
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return reply; };
  const found = await run_web_tool('web_search', { query: ' 步态分析 ', limit: 3 }, undefined, 'saved-deepseek-key');
  assert.deepEqual(found, { query: '步态分析', results: [{ title: '步态', url: 'https://example.com/a', snippet: '摘要', summary: '概述' }] });
  assert.equal(calls[0].url, 'https://api.deepseek.com/v1/tools/search');
  assert.equal(calls[0].init.headers.authorization, 'Bearer saved-deepseek-key');
  assert.equal(calls[0].init.redirect, 'error');
  assert.deepEqual(JSON.parse(calls[0].init.body), { query: '步态分析', count: 3, need_content: false });
  reply = new Response(JSON.stringify({ error: { message: 'Insufficient Balance' } }), { status: 402 });
  await assert.rejects(run_web_tool('web_search', { query: '步态' }, undefined, 'saved-deepseek-key'), /HTTP 402：Insufficient Balance/);
});

test('API web tools turn HTML into readable text', () => {
  assert.equal(html_text('<head><title>标题</title></head><script>alert(1)</script><h1>参数&nbsp;表</h1><table><tr><td>量程</td><td>±180&#176;</td></tr></table><ul><li>甲</li></ul>'),
    '参数 表\n量程 | ±180° |\n- 甲');
});

test('pause aborts an in-flight API request and prevents a late tool response from writing', async t => {
  let release;
  const mock = await model_fixture(t, async call => {
    await new Promise(resolve => { release = resolve; });
    return tool_reply(call, 'arrange_turns', { turns: [{ expert: 'Grok', question: '不应写入' }] });
  });
  const f = await site_fixture(t), participants = profiles(f.home, mock.base_url);
  const r = await start_free_session(t, { fixture: f, participants: { Grok: participants.Grok }, host: 'Grok', title: '暂停 API' });
  await until(() => Boolean(release), () => r.runner.tick());
  const discussion = await api(r.config, '/discussion');
  await api(r.config, '/discussion', { action: 'pause', revision: discussion.revision });
  await r.runner.tick(); release(); await delay(50);
  const room = await api(r.config, '');
  assert.equal(room.session.status, 'paused');
  assert.deepEqual((await api(r.config, '/turns')).turns, []);
  assert.equal(mock.calls.length, 1);
});

test('provider errors fail the session request after bounded retries without leaking an upstream key', async t => {
  const mock = await model_fixture(t, () => { throw new Error(`upstream echoed ${SECRET}`); });
  const f = await site_fixture(t), participants = profiles(f.home, mock.base_url);
  const r = await start_free_session(t, { fixture: f, participants: { Grok: participants.Grok }, host: 'Grok', title: 'API 错误' });
  await until(async () => mock.calls.length > 0, () => r.runner.tick());
  // Pi waits 2, 4 and 8 seconds between its retries.
  await until(async () => (await api(r.config, '/inbox')).executions.length === 0, () => r.runner.tick(), 40000);
  const inbox = await api(r.config, '/inbox'), messages = await api(r.config, '/messages');
  assert.ok(!JSON.stringify({ inbox, messages, log: r.log }).includes(SECRET));
  // Pi retries a 5xx a bounded number of times (3 on Pi 1.5.2), then the request fails.
  assert.ok(mock.calls.length > 1 && mock.calls.length <= 5, `${mock.calls.length} model requests`);
});

test('API participants load the shared skills and map CLI commands onto their room tools', () => {
  const host = system_prompt({ participant: 'DeepSeek', role: 'host', mode: 'free', discussion_request: { purpose: 'discuss_host' } });
  const expert = system_prompt({ participant: 'Qwen', role: 'member', mode: 'free', discussion_request: { purpose: 'discuss' } });
  const free = system_prompt({ participant: 'Grok', role: 'host', mode: 'free' });
  for (const prompt of [host, expert, free]) {
    assert.match(prompt, /# 房间参与（discuss-participant）/);
    assert.doesNotMatch(prompt, /^name: discuss/m, 'skill frontmatter stays out of the prompt');
  }
  assert.match(host, /# 房间主持（discuss-host）/);
  assert.match(host, /turn create --plan-file → arrange_turns/);
  assert.doesNotMatch(expert, /# 讨论主持/);
  assert.doesNotMatch(expert, /arrange_turns/, 'experts are not told about host tools');
  for (const prompt of [host, expert, free]) assert.match(prompt, /消息附件用 read_attachment 按 ID 读取.*读不到的以其他成员贴出的为准，不凭文件名猜测/);
  assert.match(free, /message post --kind chat → submit_chat/);
  assert.match(free, /派活用 to，派出的工作结束后都会交回你；房间空闲后要接着推进时填 continue/);
  assert.match(host, /turn roster → read_roster，读后 turn ask → ask_interjection/);
  assert.match(free, /# 开发协作/, 'an API free-room host cannot open references, so it gets the development reference inline');
  assert.doesNotMatch(expert, /# 开发协作/);
  assert.match(free, /# 请求与派活/);
  for (const page of [/# 接力与问题卡/, /# 房间控制与恢复/, /# 工作流/]) assert.match(free, page, 'an API room host gets every occasional host page inline');
  assert.doesNotMatch(free, /## 每次主持任务|# 讨论模式（discuss-session）/, 'a free-room host gets the host core and free-room pages, not the discussion pages');
  assert.match(host, /## 每次主持任务/);
  assert.match(host, /# 讨论主持/);
  for (const page of [/# 房间控制与恢复/, /# 工作流/]) assert.match(host, page, 'an API discussion host gets the pages its discussion page links to');
  assert.doesNotMatch(host, /# 接力与问题卡/);
  for (const page of [/# 讨论开场/, /# 名单变化与异常/, /# 到限与收束/]) {
    assert.match(host, page, 'an API discussion host cannot open a page, so its occasional pages come inline');
    assert.doesNotMatch(free, page);
    assert.doesNotMatch(expert, page);
  }
  const goal = system_prompt({ participant: 'Grok', role: 'host', mode: 'free', goal: { id: 1, status: 'active' } });
  for (const page of [/# Goal 模式主持（discuss-goal）/, /# 开启 Goal/, /# 结束 Goal/]) assert.match(goal, page, 'an API goal host gets the goal pages inline');
  assert.doesNotMatch(free, /# 结束 Goal/);
  assert.match(expert, /# 房间参与（discuss-participant）/);
  assert.match(expert, /# 讨论模式（discuss-session）/);
  assert.doesNotMatch(expert, /# 回答房间请求/, 'discussion experts do not load the free-room page');
  assert.match(free, /# 回答房间请求/);
  assert.match(free, /continue/, 'free-room API participants get the free-room rules, which live in a reference');
  assert.doesNotMatch(expert, /填 continue/, 'discussion rooms do not carry the free-room rules');
});

test('read-aloud sends the saved key only to Volcengine and joins chunked audio', async () => {
  const { save_tts_settings, tts_settings, tts_speak, TTS_BASE_URL } = await import('../runner/tts.mjs');
  const home = mkdtempSync(join(tmpdir(), 'codiscuss-tts-'));
  try {
    await assert.rejects(tts_speak(home, { text: '你好' }), /尚未配置语音/);
    const { api_key_ref } = save_api_key(home, { base_url: TTS_BASE_URL, api_key: SECRET });
    // Settings saved before services could be chosen are read as Volcengine's, so the key and voices carry over.
    writeFileSync(join(home, 'tts-settings.json'), JSON.stringify({ speaker: 'zh_female_vv_uranus_bigtts', speech_rate: 20, context: '自然一点',
      member_voices: { Codex: 'zh_male_m191_uranus_bigtts' }, file_voice: '', api_key_ref }));
    const legacy = tts_settings(home);
    assert.equal(legacy.provider, 'volcengine');
    assert.equal(legacy.api_key_ref, api_key_ref);
    assert.equal(legacy.stt_key_ref, api_key_ref);
    assert.deepEqual(legacy.member_voices, { Codex: 'zh_male_m191_uranus_bigtts' });
    // A tone saved before each service kept its own is Volcengine's; the local service starts with its own default.
    assert.equal(legacy.providers.volcengine.context, '自然一点');
    assert.equal(legacy.providers.local.context, '语气平静克制，语调平稳，娓娓道来。');
    save_tts_settings(home, legacy);
    assert.equal(tts_settings(home).providers.volcengine.api_key_ref, api_key_ref);
    assert.equal(JSON.stringify(tts_settings(home)).includes(SECRET), false);
    let sent;
    const body = `{"code":0,"data":"${Buffer.from('ab').toString('base64')}"}\n{"code":0,"data":null,"sentence":{"text":"}"}}{"code":0,"data":"${Buffer.from('c').toString('base64')}"}{"code":20000000,"message":"ok","data":null}`;
    const section_id = randomUUID();
    const result = await tts_speak(home, { text: '你好', section_id }, { request: async (url, init) => { sent = { url, init }; return new Response(body); } });
    assert.equal(Buffer.from(result.audio, 'base64').toString(), 'abc');
    assert.equal(sent.url, `${TTS_BASE_URL}/api/v3/tts/unidirectional`);
    assert.equal(sent.init.headers['X-Api-Key'], SECRET);
    const request = JSON.parse(sent.init.body);
    assert.equal(request.req_params.audio_params.speech_rate, 20);
    assert.deepEqual(JSON.parse(request.req_params.additions), { context_texts: ['自然一点'], section_id });
    assert.equal(request.req_params.audio_params.enable_subtitle, true);
    // The same paragraph again comes from the local cache without calling the service.
    assert.equal((await tts_speak(home, { text: '你好' }, { request: async () => { throw new Error('not cached'); } })).cached, true);
    // The same paragraph asked twice at once (two devices) is synthesized and billed once.
    let calls = 0;
    const once = { request: async () => { calls += 1; await new Promise(resolve => setTimeout(resolve, 20)); return new Response(body); } };
    const [first, second] = await Promise.all([tts_speak(home, { text: '同时' }, once), tts_speak(home, { text: '同时' }, once)]);
    assert.equal(calls, 1);
    assert.equal(first.audio, second.audio);
    await tts_speak(home, { text: '再见', speaker: 'zh_male_m191_uranus_bigtts', silence_ms: 700 }, { request: async (url, init) => { sent = { url, init }; return new Response(body); } });
    const other = JSON.parse(sent.init.body);
    assert.equal(other.req_params.speaker, 'zh_male_m191_uranus_bigtts');
    assert.equal(JSON.parse(other.req_params.additions).silence_duration, 700);
    await assert.rejects(tts_speak(home, { text: '换一句' }, { request: async () => new Response('{"code":45000000,"message":"denied"}') }), /音色不可用/);
    await assert.rejects(tts_speak(home, { text: '字'.repeat(301) }), /不超过 300 字/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('read-aloud switches to Aliyun or Azure with their own keys, keeping Volcengine for voice input', async () => {
  const { save_tts_settings, tts_settings, tts_speak, TTS_BASE_URL } = await import('../runner/tts.mjs');
  const home = mkdtempSync(join(tmpdir(), 'codiscuss-tts-'));
  try {
    const volc = save_api_key(home, { base_url: TTS_BASE_URL, api_key: 'volc-key' }).api_key_ref;
    const aliyun = save_api_key(home, { base_url: 'https://dashscope.aliyuncs.com', api_key: 'aliyun-key' }).api_key_ref;
    const azure = save_api_key(home, { base_url: 'https://tts.speech.microsoft.com', api_key: 'azure-key' }).api_key_ref;
    save_tts_settings(home, { provider: 'aliyun', speech_rate: 20, providers: { volcengine: { api_key_ref: volc }, aliyun: { api_key_ref: aliyun, speaker: 'longanwen_v3' } } });
    const chosen = tts_settings(home);
    assert.equal(chosen.api_key_ref, aliyun);
    assert.equal(chosen.stt_key_ref, volc, 'voice input keeps the Volcengine key');
    // Aliyun answers over a duplex socket: run-task, then the text and finish-task once started; audio comes as binary frames.
    const sent = [];
    let headers;
    const open = (url, init) => {
      headers = init.headers;
      const reply = (data) => queueMicrotask(() => socket.onmessage({ data }));
      const sentence = (index, words) => JSON.stringify({ header: { event: 'result-generated' }, payload: { output: { type: 'sentence-end', sentence: { index, words } } } });
      const socket = { close: () => {}, send: (data) => {
        const message = JSON.parse(data);
        sent.push(message);
        if (message.header.action === 'run-task') reply(JSON.stringify({ header: { event: 'task-started' } }));
        if (message.header.action !== 'finish-task') return;
        reply(new Uint8Array([1, 2]).buffer);
        reply(sentence(0, [{ text: '你', begin_time: 0, end_time: 200 }, { text: '好', begin_time: 200, end_time: 400 }]));
        reply(sentence(1, [{ text: '啊', begin_time: 0, end_time: 300 }]));
        reply(JSON.stringify({ header: { event: 'task-finished' } }));
      } };
      queueMicrotask(() => socket.onopen());
      return socket;
    };
    const spoken = await tts_speak(home, { text: '你好。啊', silence_ms: 48 }, { open });
    assert.equal(headers.Authorization, 'Bearer aliyun-key');
    assert.deepEqual(sent.map(message => message.header.action), ['run-task', 'continue-task', 'finish-task']);
    assert.equal(sent[0].payload.parameters.voice, 'longanwen_v3');
    assert.equal(sent[0].payload.parameters.rate, 1.2);
    assert.equal(sent[1].payload.input.text, '你好。啊');
    assert.deepEqual(spoken.marks, [{ w: '你', t: 0 }, { w: '好', t: 200 }, { w: '啊', t: 400 }], 'sentence timings are laid end to end');
    assert.equal(Buffer.from(spoken.audio, 'base64').length, 2 + 2 * 96, 'trailing silence is two silent 24 ms frames');
    // Azure needs its region before it is ready, then speaks SSML over REST with the key in its own header.
    const providers = (azure_part) => ({ ...tts_settings(home).providers, azure: azure_part });
    save_tts_settings(home, { ...tts_settings(home), provider: 'azure', providers: providers({ api_key_ref: azure }) });
    assert.equal(tts_settings(home).api_key_ref, '', 'Azure without a region is not ready');
    await assert.rejects(tts_speak(home, { text: '你好' }), /Azure 区域/);
    save_tts_settings(home, { ...tts_settings(home), providers: providers({ api_key_ref: azure, region: 'EastAsia' }) });
    let call;
    const azure_audio = await tts_speak(home, { text: 'a<b' }, { request: async (url, init) => { call = { url, init }; return new Response(new Uint8Array([7])); } });
    assert.equal(call.url, 'https://eastasia.tts.speech.microsoft.com/cognitiveservices/v1');
    assert.equal(call.init.headers['Ocp-Apim-Subscription-Key'], 'azure-key');
    assert.match(call.init.body, /<voice name="zh-CN-XiaoxiaoNeural"><prosody rate="\+20%">a&#60;b<\/prosody>/);
    assert.deepEqual(Buffer.from(azure_audio.audio, 'base64'), Buffer.from([7]));
    await assert.rejects(tts_speak(home, { text: '再试' }, { request: async () => new Response('', { status: 401 }) }), /Azure 拒绝/);
    // OpenAI uses the key already saved for model API members, sends the tone as instructions and answers ADTS AAC.
    save_api_key(home, { base_url: 'https://api.openai.com/v1', api_key: 'openai-key' });
    save_tts_settings(home, { ...tts_settings(home), provider: 'openai' });
    assert.ok(tts_settings(home).api_key_ref, 'the saved OpenAI key is used without entering it again');
    const openai_audio = await tts_speak(home, { text: '你好', silence_ms: 128 }, { request: async (url, init) => { call = { url, init }; return new Response(new Uint8Array([9])); } });
    assert.equal(call.url, 'https://api.openai.com/v1/audio/speech');
    assert.equal(call.init.headers.Authorization, 'Bearer openai-key');
    const body = JSON.parse(call.init.body);
    assert.deepEqual([body.model, body.voice, body.response_format, body.speed, body.instructions],
      ['gpt-4o-mini-tts', 'marin', 'aac', 1.2, '用标准普通话朗读，语气平稳自然，句间自然停顿。']);
    assert.equal(openai_audio.format, 'aac');
    assert.equal(Buffer.from(openai_audio.audio, 'base64').length, 1 + 3 * 11, 'trailing silence is three silent AAC frames');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('read-aloud on the local service uses the token the setup skill saved and starts the service when nothing listens', async () => {
  const { save_tts_settings, tts_release, tts_settings, tts_speak } = await import('../runner/tts.mjs');
  const home = mkdtempSync(join(tmpdir(), 'codiscuss-tts-local-'));
  try {
    // Before any choice the services on this computer are the default once their skills have saved tokens.
    const fresh = mkdtempSync(join(tmpdir(), 'codiscuss-tts-fresh-'));
    assert.deepEqual([tts_settings(fresh).provider, tts_settings(fresh).stt_provider], ['volcengine', 'volcengine']);
    // Editing other settings before installing does not pin the cloud services; only picking one does.
    save_tts_settings(fresh, { speech_rate: 20, providers: tts_settings(fresh).providers });
    save_api_key(fresh, { base_url: 'http://127.0.0.1/yovoice', api_key: 'local-token' });
    save_api_key(fresh, { base_url: 'http://127.0.0.1/crispasr', api_key: 'local-stt-token' });
    assert.deepEqual([tts_settings(fresh).provider, tts_settings(fresh).stt_provider], ['local', 'local']);
    save_tts_settings(fresh, { provider: 'volcengine', providers: tts_settings(fresh).providers });
    save_tts_settings(fresh, { speech_rate: 0, providers: tts_settings(fresh).providers });
    assert.deepEqual([tts_settings(fresh).provider, tts_settings(fresh).stt_provider], ['volcengine', 'local'], 'a picked service stays picked');
    rmSync(fresh, { recursive: true, force: true });
    save_tts_settings(home, { provider: 'local', providers: { local: { context: '慢一点' } } });
    assert.equal(tts_settings(home).api_key_ref, '', 'not ready before the skill saves a token');
    await assert.rejects(tts_speak(home, { text: '你好' }), { message: t('本机语音尚未安装，请在语音设置中选择“让 MOSS 安装”') });
    // A token saved before the service's port could change is bound to its former fixed port, and still serves.
    const token = save_api_key(home, { base_url: 'http://127.0.0.1:18765', api_key: 'local-token' }).api_key_ref;
    assert.equal(tts_settings(home).api_key_ref, token, 'the saved token is picked up without the page');
    // A 24 kHz mono 16-bit WAV with two samples; 1 ms of trailing silence adds 24 more.
    const wav = Buffer.alloc(48);
    wav.write('RIFF', 0); wav.writeUInt32LE(40, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
    wav.write('data', 36); wav.writeUInt32LE(4, 40);
    mkdirSync(join(home, 'yovoice'));
    const lease = join(home, 'yovoice', 'lease');
    // Nothing listens at first; once started, another page request is still generating (409) before this one gets its turn.
    let listening = false, busy = 1, body, converted;
    const request = async (url, init) => {
      if (!listening) throw new TypeError('fetch failed');
      if (busy-- > 0) return new Response('{}', { status: 409 });
      body = JSON.parse(init.body);
      assert.equal(init.headers.Authorization, 'Bearer local-token');
      return new Response(wav);
    };
    const start = async (start_home, key) => { assert.equal(start_home, home); assert.equal(key, 'local-token'); listening = true; };
    const convert = async (convert_home, input) => { converted = input; return Buffer.from([9]); };
    const spoken = await tts_speak(home, { text: '你好', silence_ms: 1 }, { request, start, convert });
    assert(Date.now() - statSync(lease).mtimeMs < 60_000, 'a request renews the service lease');
    // Stopping reading dates the lease back, so the supervisor stops the service at its next check.
    tts_release(home);
    assert(statSync(lease).mtimeMs < 1000);
    assert.deepEqual(body, { text: '你好', modelId: 'qwen3-tts-customvoice-q8', speaker: 'Vivian', language: 'zh', voiceDescription: '慢一点' });
    assert.equal(converted.length, 48 + 48);
    assert.equal(converted.readUInt32LE(40), 4 + 48, 'the data chunk grows by the silence');
    assert.equal(converted.readUInt32LE(4), 96 - 8);
    assert.deepEqual({ ...spoken, audio: Buffer.from(spoken.audio, 'base64') }, { audio: Buffer.from([9]), format: 'm4a', marks: [] });
    // A designed voice asks for its own model with a fixed description and seed, whatever the tone setting says.
    await tts_speak(home, { text: '旁白', speaker: 'voxcpm2_middle_aged_male' }, { request, start, convert });
    assert.equal(body.modelId, 'voxcpm2-bf16');
    assert.equal(body.voxMode, 'design');
    assert.equal(body.seed, 42);
    assert.notEqual(body.voiceDescription, '慢一点');
    assert.equal(body.speaker, undefined);
    const missing = async () => new Response(JSON.stringify({ error: { code: '@yovoice.error.modelRequired' } }), { status: 400 });
    await assert.rejects(tts_speak(home, { text: '未安装', speaker: 'voxcpm2_soft_female' }, { request: missing, start, convert }),
      { message: t('这个音色的模型尚未安装，请让 MOSS 安装') });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('voice input joins ordered parts into one WAV and returns the recognized text', async () => {
  const { stt_part } = await import('../runner/stt.mjs');
  const { save_tts_settings, TTS_BASE_URL } = await import('../runner/tts.mjs');
  const home = mkdtempSync(join(tmpdir(), 'codiscuss-stt-'));
  try {
    const { api_key_ref } = save_api_key(home, { base_url: TTS_BASE_URL, api_key: SECRET });
    save_tts_settings(home, { providers: { volcengine: { api_key_ref } } });
    const upload_id = randomUUID();
    let sent;
    const recognize = async (url, init) => { sent = { url, init };
      return new Response(JSON.stringify({ result: { text: '你好世界' } }), { headers: { 'X-Api-Status-Code': '20000000' } }); };
    assert.deepEqual(await stt_part(home, { upload_id, index: 0, data: Buffer.from([1, 0, 2, 0]).toString('base64') }, recognize), { received: 0 });
    assert.deepEqual(await stt_part(home, { upload_id, index: 1, data: Buffer.from([3, 0]).toString('base64'), final: true }, recognize), { text: '你好世界' });
    assert.equal(sent.init.headers['X-Api-Key'], SECRET);
    assert.equal(sent.init.headers['X-Api-Resource-Id'], 'volc.seedasr.auc');
    const wav = Buffer.from(JSON.parse(sent.init.body).audio.data, 'base64');
    assert.equal(wav.subarray(0, 4).toString(), 'RIFF');
    assert.deepEqual([...wav.subarray(44)], [1, 0, 2, 0, 3, 0]);
    const missing = randomUUID();
    await assert.rejects(stt_part(home, { upload_id: missing, index: 1, data: '', final: true }, recognize), /片段缺失/);
    const silent = async () => new Response('{}', { headers: { 'X-Api-Status-Code': '20000003' } });
    assert.deepEqual(await stt_part(home, { upload_id: randomUUID(), index: 0, data: Buffer.from([0, 0]).toString('base64'), final: true }, silent), { text: '' });
    // OpenAI's transcription uses the OpenAI key already saved and receives the WAV as a form upload.
    save_api_key(home, { base_url: 'https://api.openai.com/v1', api_key: 'openai-key' });
    save_tts_settings(home, { stt_provider: 'openai' });
    const openai = async (url, init) => { sent = { url, init }; return new Response(JSON.stringify({ text: ' 你好 ' })); };
    assert.deepEqual(await stt_part(home, { upload_id: randomUUID(), index: 0, data: Buffer.from([5, 0]).toString('base64'), final: true }, openai), { text: '你好' });
    assert.equal(sent.url, 'https://api.openai.com/v1/audio/transcriptions');
    assert.equal(sent.init.headers.Authorization, 'Bearer openai-key');
    assert.equal(sent.init.body.get('model'), 'gpt-transcribe');
    assert.deepEqual([...Buffer.from(await sent.init.body.get('file').arrayBuffer()).subarray(44)], [5, 0]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('voice input on the local recognizer uses the token its skill saved and starts the service when nothing listens', async () => {
  const { stt_part } = await import('../runner/stt.mjs');
  const { save_tts_settings, tts_settings } = await import('../runner/tts.mjs');
  const home = mkdtempSync(join(tmpdir(), 'codiscuss-stt-local-'));
  try {
    save_tts_settings(home, { stt_provider: 'local' });
    // A page from before voice input could be chosen saves without it, and the choice stays.
    save_tts_settings(home, { speech_rate: 20 });
    assert.equal(tts_settings(home).stt_provider, 'local');
    const part = (final) => ({ upload_id: randomUUID(), index: 0, data: Buffer.from([1, 0, 2, 0]).toString('base64'), final });
    await assert.rejects(stt_part(home, part(true)), { message: t('本机语音识别尚未安装，请在语音设置中选择“让 MOSS 安装”') });
    save_api_key(home, { base_url: 'http://127.0.0.1/crispasr', api_key: 'stt-token' });
    mkdirSync(join(home, 'crispasr'));
    // The port recorded when the service started is where requests go.
    writeFileSync(join(home, 'crispasr', 'port'), '50123');
    let listening = false, sent;
    const request = async (url, init) => {
      if (!listening) throw new TypeError('fetch failed');
      sent = { url, init };
      return new Response(JSON.stringify({ text: ' 你好，Claude。 ', segments: [] }));
    };
    const start = async (start_home, key) => { assert.equal(start_home, home); assert.equal(key, 'stt-token'); listening = true; };
    assert.deepEqual(await stt_part(home, part(true), request, start), { text: '你好，Claude。' });
    assert.equal(sent.url, 'http://127.0.0.1:50123/inference');
    assert.equal(sent.init.headers.Authorization, 'Bearer stt-token');
    const wav = Buffer.from(await sent.init.body.get('file').arrayBuffer());
    assert.deepEqual([wav.subarray(0, 4).toString(), [...wav.subarray(44)]], ['RIFF', [1, 0, 2, 0]]);
    assert.equal(sent.init.body.get('language'), 'zh');
    assert(Date.now() - statSync(join(home, 'crispasr', 'lease')).mtimeMs < 60_000, 'a recognition renews the service lease');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('force-stopping a local speech service ends only its own program listening on its recorded port', async () => {
  const { local_service_stop, local_services } = await import('../runner/tts_providers.mjs');
  const home = mkdtempSync(join(tmpdir(), 'codiscuss-local-speech-'));
  try {
    const owners = { 37641: { pid: 40, name: 'python.exe' }, 50001: { pid: 41, name: 'yovoice.exe' }, 50002: { pid: 42, name: 'other-app.exe' } };
    const killed = [];
    const find = async port => owners[port] || null;
    const lookup = { find, probe: async () => false, kill: async pid => { killed.push(pid); delete owners[50001]; } };
    // Another program on the preferred port is no running service: without a recorded port the next start picks another.
    assert.equal((await local_services(home, lookup)).tts.state, 'stopped');
    mkdirSync(join(home, 'yovoice'));
    mkdirSync(join(home, 'crispasr'));
    writeFileSync(join(home, 'yovoice', 'port'), '50001');
    writeFileSync(join(home, 'crispasr', 'port'), '50002');
    assert.deepEqual([(await local_services(home, lookup)).tts.state, (await local_services(home, lookup)).stt.state], ['running', 'other']);
    await assert.rejects(local_service_stop(home, 'stt', lookup), /其他程序/);
    assert.deepEqual(killed, [], 'a program that is not the service keeps running');
    const after = await local_service_stop(home, 'tts', lookup);
    assert.deepEqual([killed, after.tts.state], [[41], 'stopped']);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

/** A plain text answer in any of the four provider protocols. */
function text_reply(call, text) {
  if (call.path.endsWith('/responses')) return { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] };
  if (call.path.endsWith('/messages')) return { stop_reason: 'end_turn', content: [{ type: 'text', text }] };
  if (call.path.includes(':generateContent')) return { candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text }] } }] };
  return { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: text } }] };
}

for (const busy of [false, true]) {
  test(`Pi stops an execution at its ${busy ? 'total' : 'idle'} time limit`, t => {
    const home = mkdtempSync(join(tmpdir(), 'codiscuss-pi-timeout-'));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    t.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'] });
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    child.kill = () => child.emit('close', null);
    let failure;
    pi_delivery({ cli: 'pi.js', profile: { model: 'm' }, key: '', binding: {}, service_home: home,
      task: { id: 'free-1', directory: home, on_failure: reason => { failure = reason; } },
      context_file: '', system_file: '', prompt: 'go', spawn_process: () => child });
    child.stdout.write('{"type":"tool_execution_start","toolName":"bash","toolCallId":"1"}\n');
    for (let minute = 0; minute < (busy ? 45 : 15); minute++) {
      assert.equal(failure, undefined);
      if (busy) child.stdout.write('{"type":"tool_execution_update"}\n');
      t.mock.timers.tick(60_000);
    }
    t.mock.timers.tick(3000);
    assert.match(failure, busy ? /45 分钟上限/ : /15 分钟没有模型或工具进展/);
    assert.match(child.stdin.read().toString(), /"type":"abort"/);
  });
}

test('a model API member runs as Pi itself: its own tools and skills, the room skills and owner prompts added, codiscuss reaching the room, ending as a CLI turn', async t => {
  const home = mkdtempSync(join(tmpdir(), 'codiscuss-pi-native-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  child.kill = () => child.emit('close', null);
  child.stdin.on('finish', () => setImmediate(() => child.emit('close', 0)));
  let launched, failure;
  const ended = new Promise(resolve => {
    pi_delivery({ cli: 'pi.js', profile: { model: 'm', api_protocol: 'chat' }, key: 'k', binding: {}, service_home: home, native: true,
      skill_directories: [join(home, 'skills')], system_file: join(home, 'append.md'), context_file: join(home, 'context.json'), prompt: '用户在房间点名了你',
      task: { id: 'free-1', directory: home, access_path: join(home, 'access.json'), on_failure: reason => { failure = reason; }, on_exit: resolve },
      spawn_process: (_node, args, options) => { launched = { args, env: options.env }; return child; } });
  });
  const { args, env } = launched;
  for (const flag of ['--system-prompt', '--no-builtin-tools', '--no-context-files', '--no-skills']) assert.ok(!args.includes(flag), `${flag} is not passed`);
  assert.equal(args[args.indexOf('--skill') + 1], join(home, 'skills'));
  assert.equal(args[args.indexOf('--append-system-prompt') + 1], join(home, 'append.md'));
  assert.equal(env.DISCUSS_ACCESS_FILE, join(home, 'access.json'));
  assert.match(child.stdin.read().toString(), /用户在房间点名了你/);
  // It answered through codiscuss in its shell; a normal end is the end of the turn, not a failure.
  child.stdout.write('{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"已提交 #9"}],"stopReason":"stop"}}\n');
  child.stdout.write('{"type":"agent_settled"}\n');
  await ended;
  assert.equal(failure, undefined);
});

test('a read-only check sees the path Pi would open: ~, @, file:// and Git Bash drive paths', () => {
  const home = mkdtempSync(join(tmpdir(), 'codiscuss-pi-paths-'));
  const project = join(home, 'project');
  mkdirSync(project);
  try {
    const at = (given, platform = 'win32') => pi_tool_path(given, project, platform, home);
    assert.equal(at('~/.codiscuss/keys.json'), join(home, '.codiscuss', 'keys.json'));
    assert.equal(at(`@${join(home, 'secret.txt')}`), join(home, 'secret.txt'));
    assert.equal(at(pathToFileURL(join(home, 'secret.txt')).href), join(home, 'secret.txt'));
    assert.equal(at('notes\u00A0a.txt'), join(project, 'notes a.txt'));
    if (process.platform === 'win32') assert.equal(at('/c/Windows/win.ini'), 'C:\\Windows\\win.ini');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('a session is resumed only if Pi restores the tools the run needs: shell for a native run, room tools for a confined one', async t => {
  const home = mkdtempSync(join(tmpdir(), 'codiscuss-pi-legacy-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const sessions = join(home, 'pi', 'sessions');
  mkdirSync(sessions, { recursive: true });
  const file = id => join(sessions, `2026-11-24T00-00-00-000Z_${id}.jsonl`);
  const write = (id, ...systems) => writeFileSync(file(id), [{ type: 'session', version: 3, id }, { type: 'model_change', provider: 'codiscuss', modelId: 'm' },
    ...systems.map(([added, removed = []]) => ({ type: 'message', message: { role: 'system', content: '', sections: { preamble: '提到 submit_chat 也无妨' },
      toolsAdded: added.map(name => ({ name })), ...(removed.length ? { toolsRemoved: removed.map(name => ({ name })) } : {}) } }))]
    .map(item => JSON.stringify(item)).join('\n') + '\n');
  write('old-confined', [['read_room', 'read', 'grep', 'submit_chat', 'web_fetch']]);
  // A native session whose project AGENTS.md happens to mention submit_chat is still native: its tools decide.
  write('old-native', [['read', 'bash', 'edit', 'write', 'web_fetch']]);
  // Later system messages change the loadout: a shell removed afterwards is gone.
  write('shell-removed', [['read', 'bash']], [[], ['bash']]);
  assert.deepEqual([...session_tools(file('old-confined'))].sort(), ['grep', 'read', 'read_room', 'submit_chat', 'web_fetch']);
  assert.equal(session_fits(file('old-confined'), true), false);
  assert.equal(session_fits(file('old-native'), true), true);
  assert.equal(session_fits(file('shell-removed'), true), false);
  const launch = (session_id, native = true) => {
    let args;
    const notes = [];
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    child.kill = () => child.emit('close', null);
    const result = pi_delivery({ cli: 'pi.js', profile: { model: 'm', api_protocol: 'chat' }, key: 'k', binding: { session_id }, service_home: home, native,
      context_file: '', system_file: native ? '' : join(home, 'system.md'), prompt: 'go', task: { id: 'free-1', directory: home, on_note: note => notes.push(note) },
      spawn_process: (_node, given) => { args = given; return child; } });
    child.emit('close', 0);
    return { args, notes, session_id: result.session_id };
  };
  const legacy = launch('old-confined');
  assert.notEqual(legacy.session_id, 'old-confined', 'a new session');
  assert.ok(!legacy.args.includes('--session') && legacy.args.includes('--session-id'));
  assert.ok(legacy.notes.some(note => /旧会话与当前运行方式不兼容，已改用新会话/.test(note)), 'its card says why it forgot');
  const resumed = launch('old-native');
  assert.equal(resumed.session_id, 'old-native', 'a native session is resumed');
  assert.ok(!resumed.notes.some(note => /旧会话/.test(note)));
  // The other way round: a confined run (a member lent to another computer's room) does not resume a native session.
  assert.notEqual(launch('old-native', false).session_id, 'old-native');
  assert.equal(launch('old-confined', false).session_id, 'old-confined');
});

test('on Windows a model API member needs a Bash, found where Pi looks for one', t => {
  const home = mkdtempSync(join(tmpdir(), 'codiscuss-pi-bash-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  assert.equal(find_bash(home, { PATH: '' }, 'win32'), '', 'none: the delivery is refused with how to install Git for Windows');
  mkdirSync(join(home, 'Git', 'bin'), { recursive: true });
  writeFileSync(join(home, 'Git', 'bin', 'bash.exe'), '');
  assert.equal(find_bash(home, { ProgramFiles: home, PATH: '' }, 'win32'), join(home, 'Git', 'bin', 'bash.exe'));
  assert.equal(find_bash(home, { PATH: join(home, 'Git', 'bin') }, 'win32'), join(home, 'Git', 'bin', 'bash.exe'), 'or bash.exe on PATH');
  assert.equal(find_bash(home, {}, 'linux'), 'bash');
  assert.match(BASH_MISSING, /Git for Windows/);
});

test('a Pi session whose automatic compaction fails reports why and leaves the next execution a new session', async t => {
  const home = mkdtempSync(join(tmpdir(), 'codiscuss-pi-compact-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  child.kill = () => child.emit('close', null);
  child.stdin.on('finish', () => setImmediate(() => child.emit('close', 0)));
  const bindings = []; let ended;
  const done = new Promise(resolve => { ended = resolve; });
  pi_delivery({ cli: 'pi.js', profile: { model: 'm', api_protocol: 'chat' }, key: 'k', binding: { session_id: 'old' },
    task: { id: 'free-1', directory: home, on_binding: id => bindings.push(id), on_failure: (reason, details) => ended({ reason, details }) },
    context_file: '', system_file: '', prompt: 'go', service_home: home, spawn_process: () => child });
  for (const event of [{ type: 'compaction_start', reason: 'overflow' },
    { type: 'compaction_end', reason: 'overflow', aborted: false, errorMessage: 'Context overflow recovery failed: Summarization failed' },
    { type: 'agent_settled', aborted: false }]) child.stdout.write(`${JSON.stringify(event)}\n`);
  const { reason, details } = await done;
  assert.match(reason, /上下文压缩失败.*Summarization failed.*新会话/);
  assert.deepEqual(details, { failure_class: 'compaction_failed', retryable: false });
  assert.equal(bindings.at(-1), '', 'the next execution does not reopen the session that cannot be compacted');
});

/** A stand-in room site for execute_tool: it records requests and answers by the handler the test gives. */
async function room_stub(t, handle) {
  const seen = [];
  const server = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk;
    const url = new URL(request.url, 'http://stub');
    const call = { headers: request.headers, method: request.method, path: url.pathname.replace(/^\/api\/rooms\/room-1/, ''), query: url.searchParams, body: text ? JSON.parse(text) : undefined };
    seen.push(call);
    const reply = await handle(call, seen, response);
    if (reply === undefined) return;
    const [status, body] = reply;
    response.writeHead(status, { 'Content-Type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json' });
    response.end(Buffer.isBuffer(body) ? body : JSON.stringify(body));
  });
  await listen_local(server);
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const directory = mkdtempSync(join(tmpdir(), 'codiscuss-tool-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const context = { site: `http://127.0.0.1:${server.address().port}`, room: 'room-1', token: 'member-token', signal: new AbortController().signal,
    role: 'member', participant: 'Grok', execution_id: 7, directory, task_id: 'free-7' };
  return { seen, context };
}

test('an API member explains that cloud attachments need a local software member', async t => {
  const id = 'c'.repeat(32);
  const { seen, context } = await room_stub(t, ({ path }) => path === `/attachments/${id}`
    ? [200, { id, file_name: 'video.mp4', size: 90 * 1024 ** 2, content_type: 'video/mp4', message_id: 9, storage: 'object' }]
    : [200, { id: 9 }]);
  const { result } = await execute_tool(context, { name: 'read_attachment', arguments: { id } }, participant_tools(context));
  assert.equal(result.readable, false);
  assert.match(result.reason, /本机软件成员|local software member/);
  assert.deepEqual(seen.map(call => call.path), [`/attachments/${id}`, '/messages/9']);
});

test('every member gets the event log, only the host the proactive post', () => {
  const host = participant_tools({ role: 'host' });
  const member = participant_tools({ role: 'member' });
  assert.ok(host.find(item => item.name === 'submit_chat').parameters.properties.proactive);
  assert.ok(!member.find(item => item.name === 'submit_chat').parameters.properties.proactive);
  // Every member reads the event log; the service gives one that is not the host only the events that concern it.
  assert.ok(host.some(item => item.name === 'read_events') && member.find(item => item.name === 'read_events').description.includes('只含与你有关的事件'));
  assert.ok(['read_execution', 'read_attachment', 'read_goal'].every(name => member.some(item => item.name === name)));
});

test('the runner captures a last remark only where the adapter declares capture and the service has no answer or refused submit (6)', async t => {
  const { seen, context } = await room_stub(t, () => [200, { message: { id: 1 } }]);
  const runner = { replies: new Map(), denied: new Set(), log() {},
    config: { site: context.site, room: 'room-1', participants: { Cli: { adapter: 'claude' }, Api: { adapter: 'api' } },
      members: { Cli: { token: 'a' }, Api: { token: 'b' } } } };
  const capture = (name, id, outcome) => {
    runner.replies.set(id, '最后一段话');
    return FreeRoomRunner.prototype.capture_reply.call(runner, name, id, { delivery: { last_submission: { outcome } } });
  };
  assert.equal(await capture('Cli', 2, 'rejected'), false, 'a refused submit is reported, not replaced');
  assert.equal(await capture('Cli', 3, 'accepted'), false);
  assert.equal(seen.length, 0);
  assert.equal(await capture('Cli', 4, 'unknown'), true);
  assert.equal(seen[0].body.source, 'auto');
  // A model API member runs as Pi and is captured as a CLI member is.
  assert.equal(await capture('Api', 1, 'unknown'), true);
});

test('a writable API member works with Pi\'s own bash, and the file its command writes counts as its change', async t => {
  const f = await site_fixture(t);
  const project = mkdtempSync(join(tmpdir(), 'codiscuss-pi-shell-'));
  // Execution changes are read from git status, so the project is a repository.
  spawnSync('git', ['init', '-q', project]);
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const mock = await model_fixture(t, (call, calls) => (calls.length === 1
    ? tool_reply(call, 'bash', { command: 'mkdir -p out && echo hi > out/note.txt && env > out/env.txt' }) : text_reply(call, '已写入')));
  const participants = { DeepSeek: { ...profiles(f.home, mock.base_url).DeepSeek, project_access: 'write', cwd: project } };
  const started = await launch_discussion(f.home, { site: f.site, entry: 'web', participants,
    room: { title: 'Pi 命令行', mode: 'free', host: '用户', members: ['DeepSeek'], submission_id: randomUUID() } }, { start_service: async () => ({ running: true }) });
  const config = load_config(started.config_path), store = new DiscussionStore(config.directory), runner = new FreeRoomRunner(config, store);
  f.cleanup.push(() => { runner.stop_children(); store.close(); });
  await api(config, '/messages', { author: '用户', text: '写个文件。', source: 'user', kind: 'chat', to: ['DeepSeek'], submission_id: randomUUID() });
  await until(async () => (await api(config, '')).free.executions.some(item => item.changes.length), () => runner.tick());
  const names = mock.calls[0].body.tools.map(item => item.function?.name);
  assert.ok(names.includes('bash') && !names.includes('glob') && !names.includes('submit_chat'), 'Pi\'s own tools, not ours');
  assert.equal(readFileSync(join(project, 'out', 'note.txt'), 'utf8').trim(), 'hi');
  // The model's shell never sees the API key, though Pi got it from the runner.
  assert.ok(!readFileSync(join(project, 'out', 'env.txt'), 'utf8').includes(SECRET), 'the key is not in the shell environment');
  // Changes are recorded when the process ends, after the answer was saved.
  const execution = (await api(config, '')).free.executions.find(item => item.member === 'DeepSeek');
  assert.deepEqual(execution.changes.sort(), ['out/env.txt', 'out/note.txt']);
});

test('a read-only API member may read but its writes and non-codiscuss commands are refused by the extension, and the reason goes back to the model', async t => {
  const f = await site_fixture(t);
  const project = mkdtempSync(join(tmpdir(), 'codiscuss-pi-readonly-'));
  spawnSync('git', ['init', '-q', project]);
  writeFileSync(join(project, 'readme.txt'), 'hello');
  // Pi may still be closing in the project when the test ends; Windows keeps a running process's directory.
  t.after(async () => {
    for (let attempt = 0; ; attempt++) {
      try { rmSync(project, { recursive: true, force: true }); break; } catch (error) { if (attempt >= 50) throw error; await delay(200); }
    }
  });
  const steps = [
    call => tool_reply(call, 'read', { path: 'readme.txt' }),
    // The service home holds every saved key: outside what a read-only member may read.
    call => tool_reply(call, 'read', { path: join(f.home, 'api-keys', `${key_ref}.json`) }),
    // Pi's own path forms must not slip past the check: a leading @ and a file:// URL name the same file.
    call => tool_reply(call, 'read', { path: `@${join(f.home, 'api-keys', `${key_ref}.json`)}` }),
    call => tool_reply(call, 'read', { path: pathToFileURL(join(f.home, 'api-keys', `${key_ref}.json`)).href }),
    call => tool_reply(call, 'write', { path: `@${join(f.home, 'evil-outside.txt')}`, content: 'x' }),
    call => tool_reply(call, 'write', { path: 'evil.txt', content: 'x' }),
    call => tool_reply(call, 'bash', { command: 'echo x > evil2.txt' }),
    call => tool_reply(call, 'bash', { command: 'codiscuss room view; echo x > evil3.txt' }),
    call => text_reply(call, '只读完成'),
  ];
  let key_ref = '';
  const mock = await model_fixture(t, (call, calls) => steps[Math.min(calls.length, steps.length) - 1](call));
  const participants = { DeepSeek: { ...profiles(f.home, mock.base_url).DeepSeek, project_access: 'read', cwd: project } };
  key_ref = participants.DeepSeek.api_key_ref;
  assert.ok(readFileSync(join(f.home, 'api-keys', `${key_ref}.json`), 'utf8').includes(SECRET), 'the key file holds the key');
  const started = await launch_discussion(f.home, { site: f.site, entry: 'web', participants,
    room: { title: 'Pi 只读', mode: 'free', host: '用户', members: ['DeepSeek'], submission_id: randomUUID() } }, { start_service: async () => ({ running: true }) });
  const config = load_config(started.config_path), store = new DiscussionStore(config.directory), runner = new FreeRoomRunner(config, store);
  f.cleanup.push(() => { runner.stop_children(); store.close(); });
  await api(config, '/messages', { author: '用户', text: '看看项目。', source: 'user', kind: 'chat', to: ['DeepSeek'], submission_id: randomUUID() });
  await until(async () => mock.calls.length >= steps.length, () => runner.tick());
  for (const name of ['evil.txt', 'evil2.txt', 'evil3.txt']) assert.ok(!existsSync(join(project, name)), `${name} was not written`);
  assert.ok(!existsSync(join(f.home, 'evil-outside.txt')), 'an @ path does not write outside');
  const sent = JSON.stringify(mock.calls.at(-1).body);
  assert.ok(sent.includes('hello'), 'reading stays free');
  assert.ok(sent.includes('项目文件只读') && sent.includes('只读时命令只能是 codiscuss'), 'each refusal reaches the model with its reason');
  assert.ok(sent.includes('只读时只能读取项目') && !sent.includes(SECRET), 'the service home is not read');
});

test('Pi reports saved image edits from extension details and drops failed bash or copy-source paths', async t => {
  const home = mkdtempSync(join(tmpdir(), 'codiscuss-pi-edits-'));
  const project = mkdtempSync(join(tmpdir(), 'codiscuss-pi-proj-'));
  t.after(() => { rmSync(home, { recursive: true, force: true }); rmSync(project, { recursive: true, force: true }); });
  const edits = [];
  const fake_pi = () => {
    const child = new EventEmitter();
    child.stdin = { writable: true, write() {}, end() {}, on() {} };
    child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
    child.stderr = new EventEmitter(); child.stderr.setEncoding = () => {};
    child.kill = () => {};
    setImmediate(() => {
      const emit = obj => child.stdout.emit('data', `${JSON.stringify(obj)}\n`);
      const img = join(project, 'images', 'cover.png');
      emit({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'generate_image', args: { prompt: 'cover', save_path: 'images/cover.png' } });
      emit({ type: 'tool_execution_end', toolCallId: 'c1', toolName: 'generate_image', isError: false, result: { details: { codiscuss: { terminal: false, edits: [img] } } } });
      emit({ type: 'tool_execution_start', toolCallId: 'c2', toolName: 'bash', args: { command: 'cp src/in.js out/ok.js' } });
      emit({ type: 'tool_execution_end', toolCallId: 'c2', toolName: 'bash', isError: false, result: {} });
      emit({ type: 'tool_execution_start', toolCallId: 'c3', toolName: 'bash', args: { command: 'echo x > out/fail.js' } });
      emit({ type: 'tool_execution_end', toolCallId: 'c3', toolName: 'bash', isError: true, result: {} });
      emit({ type: 'tool_execution_start', toolCallId: 'c4', toolName: 'submit_chat', args: { text: 'ok' } });
      emit({ type: 'tool_execution_end', toolCallId: 'c4', toolName: 'submit_chat', isError: false, result: { details: { codiscuss: { terminal: true } } } });
      emit({ type: 'agent_settled' });
      child.emit('close', 0);
    });
    return child;
  };
  await new Promise(resolve_done => {
    pi_delivery({ cli: 'pi.js', profile: { model: 'm', api_protocol: 'chat' }, key: 'k', binding: {}, service_home: home,
      project_root: project, native_shell: true, context_file: join(home, 'c.json'), system_file: join(home, 's.md'), prompt: 'hi',
      spawn_process: fake_pi, task: { id: 'free-1', directory: home, on_edits: paths => edits.push(...paths), on_exit: resolve_done } });
  });
  assert.deepEqual(edits, [join(project, 'images', 'cover.png'), join(project, 'out', 'ok.js')]);
});


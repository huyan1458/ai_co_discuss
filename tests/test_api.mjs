import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { API_PROVIDERS, api_base_url, api_check, api_generate, api_history, api_models, api_request, api_response, api_tool_results, read_api_key, save_api_key } from '../runner/discussion_api.mjs';
import { participant_tools, peer_reading_granted, system_prompt } from '../runner/api_participant.mjs';
import { launch_discussion } from '../runner/discussion_launch.mjs';
import { api, DiscussionRunner, DiscussionStore, load_config } from '../runner/discussion_runner.mjs';
import { FreeRoomRunner } from '../runner/free_runner.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SECRET = 'mock-api-key-never-in-room-or-prompt';

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
  t.after(async () => { for (const close of cleanup) await close(); child.kill(); await closed; rmSync(home, { recursive: true, force: true }); });
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
    const call = { path: request.url, headers: request.headers, body: text ? JSON.parse(text) : null };
    calls.push(call);
    try {
      const result = await respond(call, calls);
      if (result === undefined) return;
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(result));
    } catch (error) { response.statusCode = 500; response.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { base_url: `http://127.0.0.1:${server.address().port}/custom/v1`, calls, server };
}

/** Return a tool call in any of the four provider protocols. */
function tool_reply(call, name, args = {}) {
  const id = randomUUID();
  if (call.path.endsWith('/responses')) return { status: 'completed', output: [{ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) }] };
  if (call.path.endsWith('/messages')) return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input: args }] };
  if (call.path.includes(':generateContent')) return { candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ functionCall: { name, args }, thoughtSignature: 'opaque-signature' }] } }] };
  return { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', reasoning_content: 'opaque-reasoning', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] };
}

/** Read the first room prompt from a protocol-specific request. */
function room_prompt(call) {
  const message = (call.body.input || call.body.messages?.filter(item => item.role !== 'system') || call.body.contents)[0];
  return JSON.parse(message.content || message.parts[0].text);
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

/** Build local profiles for every visible provider without any installed AI software. */
function profiles(home, base_url) {
  const key = save_api_key(home, { base_url, api_key: SECRET });
  return Object.fromEntries(Object.entries(API_PROVIDERS).map(([name, preset]) => [name, {
    adapter: 'api', base_url, api_protocol: preset.api_protocol, model: `${name}/model.1`, ...key,
  }]));
}

test('provider presets preserve model IDs, separate identity from protocol and bind private keys to URLs', async t => {
  const f = await site_fixture(t);
  assert.deepEqual(Object.keys(API_PROVIDERS), ['Codex', 'Claude', 'Gemini', 'DeepSeek', 'Qwen', 'Grok']);
  assert.equal(api_base_url('https://openrouter.ai/api/v1/'), 'https://openrouter.ai/api/v1');
  assert.throws(() => api_base_url('https://key@example.test/v1'), /凭据/);
  const profile = profiles(f.home, 'https://openrouter.ai/api/v1').Grok;
  profile.api_protocol = 'chat';
  assert.equal(read_api_key(f.home, profile), SECRET);
  assert.ok(!JSON.stringify(profile).includes(SECRET));
  assert.throws(() => read_api_key(f.home, { ...profile, base_url: 'https://api.x.ai/v1' }), /重新填写/);
  const request = api_request(profile, { system: 'test', history: [], tools: participant_tools({ role: 'expert' }) });
  assert.equal(request.path, '/chat/completions');
  assert.equal(request.body.model, 'Grok/model.1');
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

test('DeepSeek model discovery preserves display names separately from callable model IDs', async t => {
  const f = await site_fixture(t);
  const mock = await model_fixture(t, () => ({ object: 'list', data: [
    { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', object: 'model', owned_by: 'deepseek' },
    { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', object: 'model', owned_by: 'deepseek' },
  ] }));
  const result = await api_models(f.home, profiles(f.home, mock.base_url).DeepSeek);
  assert.deepEqual(result.models, [
    { id: 'deepseek-flash', label: 'DeepSeek-V4.1-Flash' },
    { id: 'deepseek-v4-pro', label: 'DeepSeek-V4-Pro' },
  ]);
  assert.equal(mock.calls[0].path, '/custom/v1/models');
  assert.equal(mock.calls[0].body, null);
});

test('a host-stated reading exception lifts the independent boundary only for the nominated participant', () => {
  const room = { current_turn: { expert: 'DeepSeek', question: '用户明确允许你从他人的对话中了解项目，这是对本轮 initial 独立阅读限制的明确例外。' } };
  assert.equal(peer_reading_granted(room, 'DeepSeek'), true);
  assert.equal(peer_reading_granted(room, 'Claude'), false);
  assert.equal(peer_reading_granted({ current_turn: { expert: 'DeepSeek', question: '请独立论证。' } }, 'DeepSeek'), false);
  assert.equal(peer_reading_granted({ current_turn: null }, 'DeepSeek'), false);
});

test('API host and six providers complete a real round through execution credentials and save API provenance', async t => {
  const f = await site_fixture(t);
  const host_steps = new Map();
  const mock = await model_fixture(t, call => {
    const prompt = room_prompt(call), { room, task } = prompt;
    assert.ok(!JSON.stringify(call.body).includes(SECRET));
    if (task.role === 'expert') {
      assert.equal(room.state_text, undefined);
      assert.equal(room.host_brief, undefined);
      if (room.current_turn.expert === 'DeepSeek') {
        const history = JSON.stringify(call.body);
        assert.ok(!history.includes('Codex 的独立观点：'));
        if (!history.includes('先独立提交观点；')) return tool_reply(call, 'read_messages');
      }
      return tool_reply(call, 'submit_opinion', { text: `${room.current_turn.expert} 的独立观点：保留依据与条件。`, summary: '结论摘要。' });
    }
    if (!room.latest_id) return tool_reply(call, 'arrange_turns', { turns: Object.keys(API_PROVIDERS).map(expert => ({ expert, question: '请独立论证。' })) });
    const step = host_steps.get(room.latest_id) || 0;
    host_steps.set(room.latest_id, step + 1);
    return [() => tool_reply(call, 'read_messages'), () => tool_reply(call, 'host_message', { text: '六位专家已完成观点；保留各自条件。' }),
      () => tool_reply(call, 'save_state', { text: '已核对本轮原文。', brief: '完整讨论已收束。', until: room.latest_id }),
      () => tool_reply(call, 'finish_discussion')][step]();
  });
  const participants = profiles(f.home, mock.base_url);
  const started = await launch_discussion(f.home, { site: f.site, entry: 'web', participants,
    room: { title: 'API 模拟讨论', host: 'Codex', experts: Object.fromEntries(Object.keys(participants).map(name => [name, 'cli'])),
      limits: { max_rounds: 1, on_limit: 'summarize' }, submission_id: randomUUID() } }, { start_service: async () => ({ running: true }) });
  const config = load_config(started.config_path), store = new DiscussionStore(config.directory), runner = new DiscussionRunner(config, store);
  f.cleanup.push(() => { runner.stop_children(); store.close(); });
  try { await until(async () => (await api(config, '')).phase === 'concluded', () => runner.tick()); }
  catch (error) { t.diagnostic(JSON.stringify({ rows: store.pending().map(({ token, ...row }) => row), calls: mock.calls.map(call => ({ path: call.path, role: room_prompt(call).task.role })) })); throw error; }
  const room = await api(config, ''), messages = await api(config, '/messages');
  assert.equal(room.completed_rounds, 1);
  assert.equal(messages.messages.length, 7);
  assert.ok(messages.messages.every(message => message.source === 'api' && message.submitted_by === message.author));
  assert.ok(!readFileSync(started.config_path, 'utf8').includes(SECRET));
  assert.ok(mock.calls.some(call => call.path.includes('/models/Gemini%2Fmodel.1:generateContent')));
});

test('free-room API replies bind to their reserved execution and complete the request', async t => {
  const f = await site_fixture(t);
  const mock = await model_fixture(t, call => tool_reply(call, 'submit_chat', { text: '处理了本次请求。', summary: '已处理。' }));
  const participants = { Grok: profiles(f.home, mock.base_url).Grok };
  const started = await launch_discussion(f.home, { site: f.site, entry: 'web', participants,
    room: { title: '自由房间 API', mode: 'free', host: '用户', members: ['Grok'], submission_id: randomUUID() } }, { start_service: async () => ({ running: true }) });
  const config = load_config(started.config_path), store = new DiscussionStore(config.directory), runner = new FreeRoomRunner(config, store);
  f.cleanup.push(() => { runner.stop_children(); store.close(); });
  await api(config, '/messages', { author: '用户', text: '请处理。', source: 'user', kind: 'chat', to: ['Grok'], submission_id: randomUUID() });
  await until(async () => (await api(config, '/messages')).messages.some(message => message.author === 'Grok'), () => runner.tick());
  const messages = (await api(config, '/messages')).messages;
  assert.equal(messages.find(message => message.author === 'Grok').source, 'api');
});

test('pause aborts an in-flight API request and prevents a late tool response from writing', async t => {
  const f = await site_fixture(t);
  let release;
  const mock = await model_fixture(t, async call => {
    await new Promise(resolve => { release = resolve; });
    return tool_reply(call, 'arrange_turns', { turns: [{ expert: 'Grok', question: '不应写入' }] });
  });
  const started = await launch_discussion(f.home, { site: f.site, entry: 'web', participants: { Grok: profiles(f.home, mock.base_url).Grok },
    room: { title: '暂停 API', host: 'Grok', experts: { Grok: 'cli' }, submission_id: randomUUID() } }, { start_service: async () => ({ running: true }) });
  const config = load_config(started.config_path), store = new DiscussionStore(config.directory), runner = new DiscussionRunner(config, store);
  f.cleanup.push(() => { release?.(); runner.stop_children(); store.close(); });
  await until(() => Boolean(release), () => runner.tick());
  const runtime = (await api(config, '')).runtime;
  await api(config, '/runtime', { action: 'pause', revision: runtime.revision });
  await runner.tick(); release(); await delay(50);
  const room = await api(config, '');
  assert.equal(room.current_turn, null);
  assert.equal(room.runtime.status, 'paused');
  assert.equal(mock.calls.length, 1);
});

test('provider errors pause without leaking an upstream key or repeating the model request', async t => {
  const f = await site_fixture(t);
  const mock = await model_fixture(t, () => { throw new Error(`upstream echoed ${SECRET}`); });
  const started = await launch_discussion(f.home, { site: f.site, entry: 'web', participants: { Grok: profiles(f.home, mock.base_url).Grok },
    room: { title: 'API 错误暂停', host: 'Grok', experts: { Grok: 'cli' }, submission_id: randomUUID() } }, { start_service: async () => ({ running: true }) });
  const config = load_config(started.config_path), store = new DiscussionStore(config.directory), runner = new DiscussionRunner(config, store);
  f.cleanup.push(() => { runner.stop_children(); store.close(); });
  await until(async () => (await api(config, '')).runtime.status === 'paused', () => runner.tick());
  await runner.tick(); await runner.tick();
  const events = await api(config, '/events');
  assert.match(JSON.stringify(events), /HTTP 500/);
  assert.ok(!JSON.stringify(events).includes(SECRET));
  assert.equal(mock.calls.length, 1);
});

test('API participants load the shared skills and map CLI commands onto their room tools', () => {
  const host = system_prompt({ participant: 'DeepSeek', role: 'host', mode: 'brainstorm' });
  const expert = system_prompt({ participant: 'Qwen', role: 'expert', mode: 'brainstorm' });
  const free = system_prompt({ participant: 'Grok', role: 'host', mode: 'free' });
  for (const prompt of [host, expert, free]) {
    assert.match(prompt, /# 讨论参与（discuss-participant）/);
    assert.doesNotMatch(prompt, /^name: discuss/m, 'skill frontmatter stays out of the prompt');
  }
  assert.match(host, /# 讨论主持（discuss-host）/);
  assert.match(host, /turn create --plan-file → arrange_turns/);
  assert.doesNotMatch(expert, /# 讨论主持/);
  assert.doesNotMatch(expert, /arrange_turns/, 'experts are not told about host tools');
  assert.match(free, /submit_chat（派活用 to）/);
  assert.doesNotMatch(free, /# 讨论主持/, 'free-room hosts route work without the discussion host skill');
});

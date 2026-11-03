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
import { listen_local } from './local_port.mjs';
import { API_PROVIDERS, api_base_url, api_check, api_generate, api_history, api_models, api_request, api_response, api_tool_results, read_api_key, save_api_key } from '../runner/discussion_api.mjs';
import { participant_tools, system_prompt } from '../runner/adapters/api.mjs';
import { launch_discussion } from '../runner/discussion_launch.mjs';
import { api, DiscussionStore, load_config } from '../runner/discussion_runner.mjs';
import { FreeRoomRunner } from '../runner/free_runner.mjs';
import { ROUTE_GUIDED_PROMPT_VERSION } from '../runner/scheduler.mjs';

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
  await listen_local(server);
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
  assert.deepEqual(Object.keys(API_PROVIDERS), ['Codex', 'Claude', 'Antigravity', 'DeepSeek', 'Qwen', 'Grok']);
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

test('API host schedules a real session round and providers answer through execution-bound chat writes', async t => {
  const f = await site_fixture(t);
  const host_steps = new Map();
  const mock = await model_fixture(t, call => {
    const prompt = room_prompt(call), { task } = prompt;
    assert.ok(!JSON.stringify(call.body).includes(SECRET));
    if (task.discussion_request?.purpose === 'discuss') {
      return tool_reply(call, 'submit_chat', { text: `${task.discussion_request.source_question || task.discussion_request.question} 已独立核对。`, summary: '依据与条件已保留。' });
    }
    if (task.discussion_request?.cause_kind === 'session_started') {
      const experts = Object.keys(API_PROVIDERS).filter(name => name !== 'Codex');
      return tool_reply(call, 'arrange_turns', { turns: experts.map(expert => ({ expert, question: '请独立论证。' })) });
    }
    const step = host_steps.get(task.execution_id) || 0;
    host_steps.set(task.execution_id, step + 1);
    return [() => tool_reply(call, 'read_messages'),
      () => tool_reply(call, 'host_message', { text: '本轮观点已收齐，正在整理结论。' }),
      () => tool_reply(call, 'save_state', { text: '已核对本轮原文。', brief: '专家观点已按原文整理。', until: prompt.room.latest_id }),
      () => tool_reply(call, 'finish_discussion')][step]();
  });
  const participants = profiles(f.home, mock.base_url);
  const r = await start_free_session(t, { fixture: f, participants, host: 'Codex', title: 'API 模拟讨论' });
  await until(async () => (await api(r.config, '')).session?.status === 'concluded', () => r.runner.tick());
  const room = await api(r.config, ''), messages = await api(r.config, '/messages');
  assert.equal(messages.messages.length, 6);
  assert.deepEqual(messages.messages.map(message => message.author).filter((_, index) => messages.messages[index].kind !== 'moderation').sort(), Object.keys(API_PROVIDERS).filter(name => name !== 'Codex').sort());
  assert.ok(messages.messages.some(message => message.author === 'Codex' && message.kind === 'moderation'));
  assert.ok(messages.messages.every(message => message.source === 'api' && message.submitted_by === message.author));
  assert.ok(!readFileSync(r.started.config_path, 'utf8').includes(SECRET));
  assert.ok(mock.calls.some(call => call.path.includes('/models/Antigravity%2Fmodel.1:generateContent')));
  assert.equal(room.session.status, 'concluded');
});

test('API host tools read the latest roster and expose discussion actions only for a session host request', async t => {
  const ordinary = participant_tools({ mode: 'free', role: 'host' }).map(item => item.name);
  const host = participant_tools({ mode: 'free', role: 'host', discussion_request: { purpose: 'discuss_host' } }).map(item => item.name);
  const expert = participant_tools({ mode: 'free', role: 'member', discussion_request: { purpose: 'discuss' } }).map(item => item.name);
  assert.ok(!ordinary.includes('arrange_turns'));
  assert.ok(host.includes('arrange_turns') && host.includes('save_state') && host.includes('finish_discussion') && host.includes('host_message'));
  assert.ok(expert.includes('submit_chat') && !expert.includes('submit_opinion'));
  assert.ok(!ordinary.includes('host_message') && !expert.includes('host_message'));
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

test('smart scheduling holds the host until its decision, and a confident pick replaces the host', async t => {
  const f = await site_fixture(t);
  let release_decision;
  const decided = new Promise(resolve => { release_decision = resolve; });
  const mock = await model_fixture(t, call => tool_reply(call, 'submit_chat', { text: '已处理。', summary: '已处理。' }));
  const { Grok, DeepSeek } = profiles(f.home, mock.base_url);
  const scheduler = { provider: 'jev', model: 'jev-latest', ...save_api_key(f.home, { base_url: 'https://api.typesafe.ai/v1', api_key: SECRET }) };
  const started = await launch_discussion(f.home, { site: f.site, entry: 'web', participants: { Grok, DeepSeek }, scheduler,
    room: { title: '智能调度', mode: 'free', host: '用户', members: ['Grok', 'DeepSeek'], submission_id: randomUUID() } }, { start_service: async () => ({ running: true }) });
  const decisions = [];
  // The decision is held back: the host must not start before it arrives.
  const fake_fetch = async (url, init) => {
    decisions.push({ url, body: JSON.parse(init.body), authorization: init.headers.Authorization });
    await decided;
    return { ok: true, json: async () => ({ answers: { handler: { type: 'choice', choice: 'DeepSeek', confidence: 0.95, probabilities: { DeepSeek: 0.95, __host__: 0.05 } } } }) };
  };
  const config = load_config(started.config_path), store = new DiscussionStore(config.directory);
  const runner = new FreeRoomRunner(config, store, undefined, () => {}, fake_fetch);
  f.cleanup.push(() => { release_decision(); runner.stop_children(); store.close(); });
  const posted = await api(config, '/messages', { author: '用户', text: '帮我查一下这个接口为什么返回 500。', source: 'user', kind: 'chat', submission_id: randomUUID() });
  const message_id = posted.message.id;
  await until(async () => decisions.length === 1, () => runner.tick());
  for (let round = 0; round < 3; round++) await runner.tick();
  assert.equal((await api(config, '/messages')).messages.some(message => message.author === 'Grok'), false);
  assert.deepEqual((await api(config, '')).free.requests.map(item => item.status), ['pending']);
  assert.equal(decisions[0].url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(decisions[0].authorization, `Bearer ${SECRET}`);
  assert.deepEqual(Object.keys(decisions[0].body.questions.handler.criteria), ['DeepSeek', '__host__', '__all__', '__all_seq__', '__none__']);
  release_decision();
  await until(async () => (await api(config, '')).free.recommendations.some(item => item.status === 'adopted'), () => runner.tick());
  const recommendation = (await api(config, '')).free.recommendations[0];
  assert.deepEqual([recommendation.message_id, recommendation.member, recommendation.status, recommendation.provider, recommendation.confidence],
    [message_id, 'DeepSeek', 'adopted', 'jev', 0.95]);
  await until(async () => (await api(config, '/messages')).messages.some(message => message.author === 'DeepSeek'), () => runner.tick());
  const room = await api(config, '');
  assert.deepEqual(room.free.requests.map(item => [item.member, item.purpose, item.status]), [['Grok', 'route', 'cancelled'], ['DeepSeek', 'ask', 'completed']]);
  assert.equal((await api(config, `/recommendations/${message_id}`, { action: 'adopt', mode: 'interrupt' })).duplicate, true);
  const decision = room.scheduler_decisions.at(-1);
  assert.deepEqual([decision.after_message_id, decision.label, decision.applied, decision.provider, decision.feedback], [message_id, '改由 DeepSeek 回答', 1, 'jev', null]);
  assert.deepEqual(JSON.parse(decision.context), { model: 'jev-latest', threshold: 0.6, wide_threshold: 0.8, mode: 'guided', prompt: ROUTE_GUIDED_PROMPT_VERSION,
    package: JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version });
  assert.deepEqual([decision.detail[0].choice, decision.detail[0].probabilities], ['DeepSeek', { DeepSeek: 0.95, __host__: 0.05 }]);
  await api(config, `/scheduler-decisions/${decision.id}`, { rating: 'bad', should_be: 'Grok', note: '应该先问主持人' });
  const rated = (await api(config, '')).scheduler_decisions.at(-1);
  assert.deepEqual([rated.feedback, rated.should_be, rated.note], ['bad', 'Grok', '应该先问主持人']);
  assert.equal((await api(config, '/backup')).tables.scheduler_decisions[0].note, '应该先问主持人');
  // The bad rating keeps exactly what the model saw, including option descriptions, for the loopback administrator.
  const cases = async () => (await (await fetch(`${f.site}/api/scheduler-feedback`)).json()).cases;
  const [feedback_case] = await cases();
  assert.deepEqual([feedback_case.decision_id, feedback_case.should_be, feedback_case.snapshot.label], [decision.id, 'Grok', '改由 DeepSeek 回答']);
  assert.match(feedback_case.snapshot.input.state, /待处理的用户消息/);
  assert.deepEqual(feedback_case.snapshot.input.questions[0].choices.map(choice => choice.value), ['DeepSeek', '__host__', '__all__', '__all_seq__', '__none__']);
  await assert.rejects(api(config, `/scheduler-decisions/${decision.id}`, { rating: 'bad', note: 'x'.repeat(201) }), /HTTP 400/);
  await assert.rejects(api(config, `/scheduler-decisions/${decision.id}`, { rating: 'great' }), /HTTP 400/);
  await api(config, `/scheduler-decisions/${decision.id}`, { rating: null });
  assert.equal((await api(config, '')).scheduler_decisions.at(-1).feedback, null);
  assert.deepEqual(await cases(), []);
  const backup = await api(config, '/backup');
  assert.deepEqual(backup.tables.member_recommendations.map(row => [row.message_id, row.status, row.mode]), [[message_id, 'adopted', 'interrupt']]);
  assert.ok(!readFileSync(started.config_path, 'utf8').includes(SECRET));
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
  await until(async () => mock.calls.length === 3, () => r.runner.tick());
  await until(async () => (await api(r.config, '/inbox')).executions.length === 0, () => r.runner.tick());
  const inbox = await api(r.config, '/inbox'), messages = await api(r.config, '/messages');
  assert.ok(!JSON.stringify({ inbox, messages, log: r.log }).includes(SECRET));
  assert.equal(mock.calls.length, 3, 'a 5xx is retried twice, then the request fails without a third retry');
});

test('API participants load the shared skills and map CLI commands onto their room tools', () => {
  const host = system_prompt({ participant: 'DeepSeek', role: 'host', mode: 'free', discussion_request: { purpose: 'discuss_host' } });
  const expert = system_prompt({ participant: 'Qwen', role: 'member', mode: 'free', discussion_request: { purpose: 'discuss' } });
  const free = system_prompt({ participant: 'Grok', role: 'host', mode: 'free' });
  for (const prompt of [host, expert, free]) {
    assert.match(prompt, /# 讨论参与（discuss-participant）/);
    assert.doesNotMatch(prompt, /^name: discuss/m, 'skill frontmatter stays out of the prompt');
  }
  assert.match(host, /# 讨论主持（discuss-host）/);
  assert.match(host, /turn create --plan-file → arrange_turns/);
  assert.doesNotMatch(expert, /# 讨论主持/);
  assert.doesNotMatch(expert, /arrange_turns/, 'experts are not told about host tools');
  for (const prompt of [host, expert, free]) assert.match(prompt, /内容你都读不到：以其他成员贴出的为准，不凭文件名猜测/);
  assert.match(free, /message post --kind chat → submit_chat/);
  assert.match(free, /派活用 to；只点名一位且要它做完后回到你时加 handoff/);
  assert.match(host, /turn roster → read_roster，读后 turn ask → ask_interjection/);
  assert.match(free, /# 开发协作/, 'an API free-room host cannot open references, so it gets the development reference inline');
  assert.doesNotMatch(expert, /# 开发协作/);
  assert.match(free, /# 自由协作主持/);
  assert.doesNotMatch(free, /## 自动主持流程|# 协作房间中的讨论参与/, 'a free-room host gets the host core and free-room pages, not the discussion pages');
  assert.match(host, /## 自动主持流程/);
  assert.match(host, /# 讨论主持/);
  assert.match(expert, /# 讨论参与（discuss-participant）/);
  assert.match(expert, /# 协作房间中的讨论参与/);
  assert.doesNotMatch(expert, /# 自由协作房间/, 'discussion experts do not load the free-room page');
  assert.match(free, /# 自由协作房间/);
  assert.match(free, /handoff/, 'free-room API participants get the free-room rules, which live in a reference');
  assert.doesNotMatch(expert, /handoff/, 'discussion rooms do not carry the free-room rules');
});

test('read-aloud sends the saved key only to Volcengine and joins chunked audio', async () => {
  const { save_tts_settings, tts_settings, tts_speak, TTS_BASE_URL } = await import('../runner/tts.mjs');
  const home = mkdtempSync(join(tmpdir(), 'codiscuss-tts-'));
  try {
    await assert.rejects(tts_speak(home, { text: '你好' }), /尚未配置语音/);
    const { api_key_ref } = save_api_key(home, { base_url: TTS_BASE_URL, api_key: SECRET });
    save_tts_settings(home, { speaker: 'zh_female_vv_uranus_bigtts', speech_rate: 20, context: '自然一点', api_key_ref });
    assert.equal(JSON.stringify(tts_settings(home)).includes(SECRET), false);
    let sent;
    const body = `{"code":0,"data":"${Buffer.from('ab').toString('base64')}"}\n{"code":0,"data":null,"sentence":{"text":"}"}}{"code":0,"data":"${Buffer.from('c').toString('base64')}"}{"code":20000000,"message":"ok","data":null}`;
    const section_id = randomUUID();
    const result = await tts_speak(home, { text: '你好', section_id }, async (url, init) => { sent = { url, init }; return new Response(body); });
    assert.equal(Buffer.from(result.audio, 'base64').toString(), 'abc');
    assert.equal(sent.url, `${TTS_BASE_URL}/api/v3/tts/unidirectional`);
    assert.equal(sent.init.headers['X-Api-Key'], SECRET);
    const request = JSON.parse(sent.init.body);
    assert.equal(request.req_params.audio_params.speech_rate, 20);
    assert.deepEqual(JSON.parse(request.req_params.additions), { context_texts: ['自然一点'], section_id });
    assert.equal(request.req_params.audio_params.enable_subtitle, true);
    // The same paragraph again comes from the local cache without calling the service.
    assert.equal((await tts_speak(home, { text: '你好' }, async () => { throw new Error('not cached'); })).cached, true);
    await tts_speak(home, { text: '再见', speaker: 'zh_male_m191_uranus_bigtts', silence_ms: 700 }, async (url, init) => { sent = { url, init }; return new Response(body); });
    const other = JSON.parse(sent.init.body);
    assert.equal(other.req_params.speaker, 'zh_male_m191_uranus_bigtts');
    assert.equal(JSON.parse(other.req_params.additions).silence_duration, 700);
    await assert.rejects(tts_speak(home, { text: '换一句' }, async () => new Response('{"code":45000000,"message":"denied"}')), /音色不可用/);
    await assert.rejects(tts_speak(home, { text: '字'.repeat(301) }), /不超过 300 字/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('voice input joins ordered parts into one WAV and returns the recognized text', async () => {
  const { stt_part } = await import('../runner/stt.mjs');
  const { save_tts_settings, TTS_BASE_URL } = await import('../runner/tts.mjs');
  const home = mkdtempSync(join(tmpdir(), 'codiscuss-stt-'));
  try {
    const { api_key_ref } = save_api_key(home, { base_url: TTS_BASE_URL, api_key: SECRET });
    save_tts_settings(home, { api_key_ref });
    const upload_id = randomUUID();
    let sent;
    const recognize = async (url, init) => { sent = { url, init };
      return new Response(JSON.stringify({ result: { text: '你好世界' } }), { headers: { 'X-Api-Status-Code': '20000000' } }); };
    assert.deepEqual(await stt_part(home, { upload_id, index: 0, data: Buffer.from([1, 0, 2, 0]).toString('base64') }, recognize), { received: 0 });
    assert.deepEqual(await stt_part(home, { upload_id, index: 1, data: Buffer.from([3, 0]).toString('base64'), final: true }, recognize), { text: '你好世界' });
    assert.equal(sent.init.headers['X-Api-Key'], SECRET);
    assert.equal(sent.init.headers['X-Api-Resource-Id'], 'volc.bigasr.auc_turbo');
    const wav = Buffer.from(JSON.parse(sent.init.body).audio.data, 'base64');
    assert.equal(wav.subarray(0, 4).toString(), 'RIFF');
    assert.deepEqual([...wav.subarray(44)], [1, 0, 2, 0, 3, 0]);
    const missing = randomUUID();
    await assert.rejects(stt_part(home, { upload_id: missing, index: 1, data: '', final: true }, recognize), /片段缺失/);
    const silent = async () => new Response('{}', { headers: { 'X-Api-Status-Code': '20000003' } });
    assert.deepEqual(await stt_part(home, { upload_id: randomUUID(), index: 0, data: Buffer.from([0, 0]).toString('base64'), final: true }, silent), { text: '' });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

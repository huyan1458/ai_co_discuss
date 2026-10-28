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
import { API_PROVIDERS, api_base_url, api_check, api_generate, api_status_message, api_history, api_models, api_request, api_response, api_tool_results, read_api_key, save_api_key } from '../runner/discussion_api.mjs';
import { participant_tools, peer_reading_granted, system_prompt } from '../runner/api_participant.mjs';
import { launch_discussion } from '../runner/discussion_launch.mjs';
import { api, DiscussionRunner, DiscussionStore, load_config, peer_round_question } from '../runner/discussion_runner.mjs';
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

test('API HTTP errors say whether to fix the setup or wait, without implying a replay', async t => {
  const f = await site_fixture(t);
  for (const [status, expected] of [[401, /密钥无效或无权访问/], [403, /密钥无效或无权访问/], [404, /地址或模型 ID 不存在/],
    [429, /请求过多或额度已用尽.*先核对房间/], [503, /服务暂时不可用.*先核对房间/], [418, /请核对地址、密钥、模型和请求协议/]]) {
    const server = createServer((request, response) => { response.statusCode = status; response.end('{}'); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const base_url = `http://127.0.0.1:${server.address().port}/custom/v1`;
    await assert.rejects(api_models(f.home, profiles(f.home, base_url).Codex), error => {
      assert.match(error.message, new RegExp(`HTTP ${status}`));
      assert.match(error.message, expected);
      assert.ok(!/稍后重启|立即重试|直接重发/.test(error.message));
      return true;
    });
  }
  assert.equal(api_status_message(200), '模型 API 返回 HTTP 200，请核对地址、密钥、模型和请求协议');
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
      limits: { max_rounds: 2 }, submission_id: randomUUID() } }, { start_service: async () => ({ running: true }) });
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

/** A discussion whose API host opens round 1 (initial phase, then the plan); later host wakes never get an answer. */
async function smart_discussion(t, { named_followup, order, expert_reply, decisions }) {
  const f = await site_fixture(t);
  let host_turns = 0;
  const mock = await model_fixture(t, call => {
    const { room, task } = room_prompt(call);
    if (task.role === 'expert') return expert_reply(call, room);
    host_turns++;
    if (host_turns === 1) return tool_reply(call, 'update_topic', { phase: 'initial' });
    if (host_turns === 2) return tool_reply(call, 'arrange_turns', { turns: order.map(expert => ({ expert, question: '请独立论证。' })) });
    return undefined;
  });
  const { Grok, DeepSeek, Qwen } = profiles(f.home, mock.base_url);
  const scheduler = { provider: 'jev', model: 'jev-latest', ...save_api_key(f.home, { base_url: 'https://api.typesafe.ai/v1', api_key: SECRET }) };
  const started = await launch_discussion(f.home, { site: f.site, entry: 'web', participants: { Grok, DeepSeek, Qwen }, scheduler,
    room: { title: '智能调度讨论', host: 'Grok', experts: { Grok: 'cli', DeepSeek: 'cli', Qwen: 'cli' }, named_followup, submission_id: randomUUID() } },
    { start_service: async () => ({ running: true }) });
  const sent = [];
  const fake_fetch = async (url, init) => {
    sent.push(JSON.parse(init.body));
    return { ok: true, json: async () => { const next = decisions.shift(); return { answers: typeof next === 'function' ? await next() : next }; } };
  };
  const config = load_config(started.config_path), store = new DiscussionStore(config.directory);
  const log = [];
  const runner = new DiscussionRunner(config, store, undefined, line => log.push(line), fake_fetch);
  f.cleanup.push(() => { runner.stop_children(); store.close(); });
  return { config, runner, store, log, sent, host_turns: () => host_turns };
}

test('without named follow-ups smart scheduling opens the next peer round itself and hands back when the provider says so', async t => {
  const choice = (choice, confidence) => ({ type: 'choice', choice, confidence, probabilities: {} });
  const r = await smart_discussion(t, { named_followup: false, order: ['Grok', 'DeepSeek', 'Qwen'],
    expert_reply: (call, room) => tool_reply(call, 'submit_opinion', { text: `${room.current_turn.expert} 的观点。`, summary: '摘要。' }),
    decisions: [{ next: choice('continue', 0.9), first: choice('DeepSeek', 0.7) }, { speaker: choice('Grok', 0.9), obligation: { type: 'noul', noul: 0.9 } }, { speaker: choice('Qwen', 0.9), obligation: { type: 'noul', noul: 0.9 } },
      { next: choice('__host__', 0.95), first: choice('Grok', 0.5) }] });
  await until(async () => r.host_turns() === 3, () => r.runner.tick());
  const room = await api(r.config, '');
  assert.equal(room.named_followup, false);
  assert.equal(room.completed_rounds, 2);
  assert.equal(room.phase, 'discussing');
  const turns = (await api(r.config, '/turns')).turns.slice(-3);
  assert.deepEqual(turns.map(turn => turn.expert), ['DeepSeek', 'Grok', 'Qwen']);
  assert.ok(turns.every(turn => turn.question === peer_round_question(2)));
  assert.deepEqual(Object.keys(r.sent[0].questions.first.criteria), ['Grok', 'DeepSeek']);
  assert.deepEqual(room.scheduler_decisions.map(item => [item.kind, item.applied, item.confidence]), [['round', 1, 0.9], ['round', 1, 0.9], ['round', 1, 0.9], ['round', 0, 0.95]]);
  // What was asked and chosen is stored beside each decision, without the room excerpts.
  assert.deepEqual(room.scheduler_decisions[1].detail.map(item => [item.choice, item.choices]), [['Grok', ['Grok', 'Qwen', '__host__']], ['是', ['是', '否']]]);
});

test('an interjection the provider assigns to one expert is answered next, before the rest of the plan', async t => {
  let release, deepseek_started = false;
  const held = new Promise(resolve => { release = resolve; });
  const r = await smart_discussion(t, { named_followup: true, order: ['DeepSeek', 'Qwen', 'Grok'],
    expert_reply: async (call, room) => {
      if (room.current_turn.expert === 'DeepSeek') { deepseek_started = true; await held; }
      return tool_reply(call, 'submit_opinion', { text: `${room.current_turn.expert} 的观点。`, summary: '摘要。' });
    },
    decisions: [{ handling: { type: 'choice', choice: 'Qwen', confidence: 0.9, probabilities: {} } }] });
  await until(async () => deepseek_started, () => r.runner.tick());
  const posted = await api(r.config, '/messages', { author: '用户', text: '@Qwen 你的方案成本怎么估？', source: 'user', submission_id: randomUUID() });
  release();
  try { await until(async () => (await api(r.config, '')).current_turn?.question?.includes(`#${posted.message.id}`), () => r.runner.tick()); }
  catch (error) {
    const view = await api(r.config, '');
    t.diagnostic(JSON.stringify({ held: view.held_since, turn: view.current_turn, queued: view.queued_turns, decisions: view.scheduler_decisions,
      phase: view.phase, rows: r.store.pending().map(({ token, ...row }) => row), log: r.log }));
    throw error;
  }
  const room = await api(r.config, '');
  assert.equal(room.current_turn.expert, 'Qwen');
  assert.deepEqual(room.queued_turns.map(turn => turn.expert), ['Qwen', 'Grok']);
  assert.deepEqual(Object.keys(r.sent[0].questions.handling.criteria), ['DeepSeek', 'Qwen', '__host__', '__note__']);
  assert.equal(r.host_turns(), 2);
  // The record closes the card that just finished speaking, not the user's message.
  const answer = (await api(r.config, '/messages')).messages.find(message => message.author === 'DeepSeek');
  assert.deepEqual(room.scheduler_decisions.map(item => [item.kind, item.applied, item.after_message_id]), [['interjection', 1, answer.id]]);
});

test('a decision is dropped, and the host handed the room, when a message arrives while it was being made', async t => {
  let release, deepseek_started = false, r;
  const held = new Promise(resolve => { release = resolve; });
  r = await smart_discussion(t, { named_followup: true, order: ['DeepSeek', 'Qwen', 'Grok'],
    expert_reply: async (call, room) => {
      if (room.current_turn.expert === 'DeepSeek') { deepseek_started = true; await held; }
      return tool_reply(call, 'submit_opinion', { text: `${room.current_turn.expert} 的观点。`, summary: '摘要。' });
    },
    decisions: [async () => {
      await api(r.config, '/messages', { author: '用户', text: '补充一句。', source: 'user', submission_id: randomUUID() });
      return { handling: { type: 'choice', choice: 'Qwen', confidence: 0.9, probabilities: {} } };
    }] });
  await until(async () => deepseek_started, () => r.runner.tick());
  await api(r.config, '/messages', { author: '用户', text: '@Qwen 你的方案成本怎么估？', source: 'user', submission_id: randomUUID() });
  release();
  await until(async () => r.log.some(line => line.includes('放弃应用')), () => r.runner.tick());
  const room = await api(r.config, '');
  assert.deepEqual(room.scheduler_decisions.map(item => [item.kind, item.applied]), [['interjection', 0]]);
  assert.ok(room.held_since, 'the new message stays held for the host');
});

test('a roster change mid-round restores the voided plan without waking the host', async t => {
  let release, deepseek_started = false;
  const held = new Promise(resolve => { release = resolve; });
  const r = await smart_discussion(t, { named_followup: false, order: ['DeepSeek', 'Qwen', 'Grok'],
    expert_reply: async (call, room) => {
      if (room.current_turn.expert === 'DeepSeek') { deepseek_started = true; await held; }
      return tool_reply(call, 'submit_opinion', { text: `${room.current_turn.expert} 的观点。`, summary: '摘要。' });
    }, decisions: [] });
  await until(async () => deepseek_started, () => r.runner.tick());
  // Qwen steps away while DeepSeek speaks: the website voids the queued turns.
  const qwen = (await api(r.config, '')).members.find(member => member.name === 'Qwen');
  await api(r.config, `/members/${qwen.id}`, { action: 'away' });
  assert.deepEqual((await api(r.config, '')).queued_turns, []);
  release();
  await until(async () => (await api(r.config, '')).current_turn?.expert === 'Grok', () => r.runner.tick());
  const room = await api(r.config, '');
  assert.equal(room.current_turn.question, '请独立论证。');
  assert.equal(r.host_turns(), 2, 'the host is not woken to re-plan');
  assert.equal(r.sent.length, 0, 'restoring a plan needs no model call');
  assert.deepEqual(room.scheduler_decisions.map(item => [item.label, item.applied, item.confidence]), [['成员有变化：补回原计划（Grok）', 1, null]]);
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
  assert.deepEqual(Object.keys(decisions[0].body.questions.handler.criteria), ['DeepSeek', '__host__', '__all__', '__none__']);
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
  assert.deepEqual(JSON.parse(decision.context), { model: 'jev-latest', threshold: 0.7, wide_threshold: 0.85, prompt: 4,
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
  assert.deepEqual(feedback_case.snapshot.input.questions[0].choices.map(choice => choice.value), ['DeepSeek', '__host__', '__all__', '__none__']);
  await assert.rejects(api(config, `/scheduler-decisions/${decision.id}`, { rating: 'bad', note: 'x'.repeat(201) }), /HTTP 400/);
  await assert.rejects(api(config, `/scheduler-decisions/${decision.id}`, { rating: 'great' }), /HTTP 400/);
  await api(config, `/scheduler-decisions/${decision.id}`, { rating: null });
  assert.equal((await api(config, '')).scheduler_decisions.at(-1).feedback, null);
  assert.deepEqual(await cases(), []);
  const backup = await api(config, '/backup');
  assert.deepEqual(backup.tables.member_recommendations.map(row => [row.message_id, row.status, row.mode]), [[message_id, 'adopted', 'interrupt']]);
  assert.ok(!readFileSync(started.config_path, 'utf8').includes(SECRET));
});

test('smart scheduling below the confidence threshold leaves no recommendation', async t => {
  const f = await site_fixture(t);
  const mock = await model_fixture(t, call => tool_reply(call, 'submit_chat', { text: '主持人处理。', summary: '已处理。' }));
  const { Grok, DeepSeek } = profiles(f.home, mock.base_url);
  const scheduler = { provider: 'decisions', model: 'gpt-6-luna', ...save_api_key(f.home, { base_url: 'https://api.openai.com/v1', api_key: SECRET }) };
  const started = await launch_discussion(f.home, { site: f.site, entry: 'web', participants: { Grok, DeepSeek }, scheduler,
    room: { title: '低置信度', mode: 'free', host: '用户', members: ['Grok', 'DeepSeek'], submission_id: randomUUID() } }, { start_service: async () => ({ running: true }) });
  const fake_fetch = async () => ({ ok: true, json: async () => ({ answers: [{ type: 'choice', name: 'handler', choice: 'DeepSeek', confidence: 0.5,
    probabilities: [{ value: 'DeepSeek', probability: 0.6 }, { value: '__host__', probability: 0.4 }] }] }) });
  const config = load_config(started.config_path), store = new DiscussionStore(config.directory);
  const runner = new FreeRoomRunner(config, store, undefined, () => {}, fake_fetch);
  f.cleanup.push(() => { runner.stop_children(); store.close(); });
  await api(config, '/messages', { author: '用户', text: '大家看看下一步做什么。', source: 'user', kind: 'chat', submission_id: randomUUID() });
  await until(async () => (await api(config, '/messages')).messages.some(message => message.author === 'Grok') && !runner.decisions.size, () => runner.tick());
  const room = await api(config, '');
  assert.deepEqual(room.free.requests.map(item => [item.member, item.purpose]), [['Grok', 'route']]);
  assert.deepEqual(room.free.recommendations, []);
});

test('smart scheduling asks everyone at once without a hand-off, and wakes no one for a plain acknowledgement', async t => {
  const f = await site_fixture(t);
  const mock = await model_fixture(t, call => tool_reply(call, 'submit_chat', { text: '大家好。', summary: '打招呼。' }));
  const { Grok, DeepSeek } = profiles(f.home, mock.base_url);
  const scheduler = { provider: 'jev', model: 'jev-latest', ...save_api_key(f.home, { base_url: 'https://api.typesafe.ai/v1', api_key: SECRET }) };
  const started = await launch_discussion(f.home, { site: f.site, entry: 'web', participants: { Grok, DeepSeek }, scheduler,
    room: { title: '全体', mode: 'free', host: '用户', members: ['Grok', 'DeepSeek'], submission_id: randomUUID() } }, { start_service: async () => ({ running: true }) });
  let choice = '__all__';
  const fake_fetch = async () => ({ ok: true, json: async () => ({ answers: { handler: { type: 'choice', choice, confidence: 0.95, probabilities: { [choice]: 0.95, __host__: 0.05 } } } }) });
  const config = load_config(started.config_path), store = new DiscussionStore(config.directory);
  const runner = new FreeRoomRunner(config, store, undefined, () => {}, fake_fetch);
  f.cleanup.push(() => { runner.stop_children(); store.close(); });
  await api(config, '/messages', { author: '用户', text: '都出来打打招呼。', source: 'user', kind: 'chat', submission_id: randomUUID() });
  const authors = async () => (await api(config, '/messages')).messages.map(message => message.author).filter(author => author !== '用户');
  await until(async () => (await authors()).length === 2, () => runner.tick());
  let room = await api(config, '');
  assert.deepEqual(room.free.requests.map(item => [item.purpose, item.status]), [['all', 'completed'], ['all', 'completed']]);
  assert.match(room.scheduler_decisions.at(-1).label, /^请全体各自回应（/);
  choice = '__none__';
  await api(config, '/messages', { author: '用户', text: '好的，谢谢。', source: 'user', kind: 'chat', submission_id: randomUUID() });
  await until(async () => (await api(config, '')).scheduler_decisions.length === 2, () => runner.tick());
  for (let round = 0; round < 3; round++) await runner.tick();
  room = await api(config, '');
  assert.deepEqual([room.free.requests.at(-1).purpose, room.free.requests.at(-1).status], ['route', 'cancelled']);
  assert.equal(room.scheduler_decisions.at(-1).label, '无需回应，未唤醒任何成员');
  assert.equal((await authors()).length, 2);
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

test('provider errors pause without leaking an upstream key after the bounded retries', async t => {
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
  assert.equal(mock.calls.length, 3, 'a 5xx is retried twice, then the run pauses without a third retry');
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
  for (const prompt of [host, expert, free]) assert.match(prompt, /读不到内容[\s\S]*不得根据文件名猜测/);
  assert.match(free, /submit_chat（派活用 to；单人派活要回到你时加 handoff）/);
  assert.match(free, /# 开发协作/, 'an API free-room host cannot open references, so it gets the development reference inline');
  assert.doesNotMatch(expert, /# 开发协作/);
  assert.match(free, /# 自由协作主持/);
  assert.doesNotMatch(free, /## 自动主持流程|# 讨论房间/, 'a free-room host gets the host core and free-room pages, not the discussion pages');
  assert.match(host, /## 自动主持流程/);
  assert.match(expert, /# 讨论房间/);
  assert.doesNotMatch(expert, /# 自由协作房间/, 'discussion experts do not load the free-room page');
  assert.match(free, /handoff/, 'free-room API participants get the free-room rules, which live in a reference');
  assert.doesNotMatch(expert, /handoff/, 'discussion rooms do not carry the free-room rules');
});

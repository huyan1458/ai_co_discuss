import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { DiscussionRunner, DiscussionStore, load_config } from '../runner/discussion_runner.mjs';
import { DiscussionService, register_room, service_pid, unregister_room } from '../runner/discussion_service.mjs';
import { antigravity_project, claude_exit_error, standalone_claude_env, codex_target, run_program } from '../runner/discussion_adapters.mjs';

/** Exercise the dispatcher against an HTTP contract without starting real software. */
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'discussion-test-'));
  const event = { id: 1, participant: 'Codex', role: 'host', generation: 1, run_id: 'run', status: 'pending' };
  const run = { mode: 'automatic', status: 'running', generation: 1, run_id: 'run' };
  const calls = [];
  const limits = { reached: false };
  const failures = {};
  const reserve_tokens = [];
  const server = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk;
    const body = text ? JSON.parse(text) : null;
    let result;
    if (request.url.includes('/events?')) result = { events: [event], next_after: 1 };
    else if (request.url.endsWith('/events/1')) {
      calls.push(body.action);
      const failure = failures[body.action];
      delete failures[body.action];
      if (failure === 'before') { request.socket.destroy(); return; }
      if (body.action === 'reserve') { event.status = 'dispatched'; reserve_tokens.push(body.execution_token); }
      if (body.action === 'fail') { event.status = 'failed'; event.result = body.reason; run.status = 'paused'; }
      if (failure === 'after') { request.socket.destroy(); return; }
      result = event;
    } else if (request.url.endsWith('/limits')) {
      calls.push('limits');
      run.generation++;
      if (limits.on_limit === 'summarize' && limits.reason !== 'time_limit') { limits.closing = true; event.generation = run.generation; }
      else { run.status = 'paused'; event.status = 'cancelled'; }
      result = { runtime: run, limits, current_turn: null };
    } else if (request.url.endsWith('/runtime')) result = run;
    else result = { runtime: run, limits, current_turn: null };
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(result));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const store = new DiscussionStore(directory);
  t.after(async () => { store.close(); await new Promise(resolve => server.close(resolve)); rmSync(directory, { recursive: true, force: true }); });
  const config = { site: `http://127.0.0.1:${server.address().port}`, room: 'room', token: 'private-token', directory, project: directory, participants: { Codex: { adapter: 'codex' } } };
  return { store, event, run, calls, config, limits, failures, reserve_tokens };
}

test('replayed events and a restarted dispatcher do not deliver a second notification', async t => {
  const f = await fixture(t); let sent = 0;
  const deliver = async () => { sent++; return { status: 'accepted', session_id: 'actual-chat' }; };
  await new DiscussionRunner(f.config, f.store, deliver).tick();
  await new DiscussionRunner(f.config, f.store, deliver).tick();
  assert.equal(sent, 1); assert.equal(f.store.cursor(), 1);
  assert.equal(f.store.binding('Codex').session_id, 'actual-chat');
  assert.equal(f.calls.filter(action => action === 'reserve').length, 1);
});

test('a reached limit pauses before another app can be invoked', async t => {
  const f = await fixture(t); let sent = 0;
  f.limits.reached = true;
  const runner = new DiscussionRunner(f.config, f.store, async () => { sent++; });
  assert.equal(await runner.tick(), 'waiting');
  assert.equal(sent, 0); assert.equal(f.run.status, 'paused');
  assert.deepEqual(f.calls, ['limits']);
});

test('summary handoff dispatches only the replacement host generation', async t => {
  const f = await fixture(t); let sent = 0;
  Object.assign(f.limits, { reached: true, on_limit: 'summarize' });
  await new DiscussionRunner(f.config, f.store, async () => { sent++; return { status: 'accepted' }; }).tick();
  assert.equal(sent, 1); assert.equal(f.event.generation, 2);
  assert.equal(f.calls[0], 'limits');
});

test('summary polling avoids repeated mutations and still pauses at the final deadline', async t => {
  const f = await fixture(t);
  Object.assign(f.limits, { reached: true, on_limit: 'summarize', reason: 'round_limit' });
  const runner = new DiscussionRunner(f.config, f.store, async () => ({ status: 'accepted' }));
  await runner.tick();
  await runner.tick();
  assert.equal(f.calls.filter(action => action === 'limits').length, 1);
  f.limits.reason = 'time_limit';
  assert.equal(await runner.tick(), 'waiting');
  assert.equal(f.calls.filter(action => action === 'limits').length, 2);
  assert.equal(f.run.status, 'paused');
});

test('a lost software receipt waits for business evidence without pausing or redelivering', async t => {
  const f = await fixture(t); let sent = 0;
  const deliver = async () => { sent++; throw new Error('receipt lost'); };
  await new DiscussionRunner(f.config, f.store, deliver).tick();
  assert.equal(f.store.pending()[0].status, 'uncertain');
  f.store.record(1, { sent_at: Date.now() - 120_000 });
  const runner = new DiscussionRunner(f.config, f.store, deliver);
  await runner.tick();
  assert.equal(sent, 1); assert.equal(f.run.status, 'running');
  f.event.status = 'started'; f.event.lease_until = Math.floor(Date.now() / 1000) + 120;
  await runner.tick();
  assert.equal(f.store.pending()[0].status, 'started');
  assert.equal(f.store.pending()[0].error, '');
  f.event.status = 'completed'; await runner.tick();
  assert.equal(f.store.pending().length, 0); assert.equal(sent, 1);
  assert.equal(f.calls.includes('fail'), false);
});

test('queued work can wait beyond one minute and enter after a dispatcher restart', async t => {
  const f = await fixture(t); let sent = 0;
  const deliver = async () => { sent++; return { status: 'accepted', session_id: 'busy-host-chat', receipt: 'queued' }; };
  await new DiscussionRunner(f.config, f.store, deliver).tick();
  f.store.record(1, { sent_at: Date.now() - 31 * 60_000 });
  const runner = new DiscussionRunner(f.config, f.store, deliver);
  await runner.tick();
  assert.equal(f.store.pending()[0].receipt, 'queued');
  assert.equal(f.event.status, 'dispatched'); assert.equal(f.run.status, 'running');
  f.event.status = 'started'; f.event.lease_until = Math.floor(Date.now() / 1000) + 120;
  await runner.tick();
  assert.equal(f.store.pending()[0].status, 'started');
  assert.equal(f.calls.includes('renew'), true); assert.equal(f.calls.includes('fail'), false);
  assert.equal(sent, 1);
});

test('proven non-delivery retries with backoff and the same event, token and prompt', async t => {
  const f = await fixture(t); const attempts = [];
  const deliver = async (adapter, binding, task) => {
    attempts.push({ prompt: task.prompt, access: readFileSync(task.access_path, 'utf8') });
    if (attempts.length === 1) throw Object.assign(new Error('spawn unavailable'), { delivery_status: 'not_sent' });
    return { status: 'accepted' };
  };
  await new DiscussionRunner(f.config, f.store, deliver).tick();
  assert.equal(f.store.pending()[0].status, 'retry_wait');
  assert.ok(f.store.pending()[0].retry_at > Date.now());
  const runner = new DiscussionRunner(f.config, f.store, deliver);
  await runner.tick(); assert.equal(attempts.length, 1);
  f.store.record(1, { retry_at: Date.now() - 1 }); await runner.tick();
  assert.deepEqual(attempts[0], attempts[1]);
  assert.equal(f.store.pending()[0].attempts, 2); assert.equal(f.store.pending()[0].status, 'accepted');
  assert.equal(f.reserve_tokens.length, 1); assert.equal(f.run.status, 'running');
});

test('three confirmed delivery failures pause with the cause and persist across restart', async t => {
  const f = await fixture(t); let sent = 0;
  const deliver = async () => { sent++; throw Object.assign(new Error('executable missing'), { delivery_status: 'not_sent' }); };
  const runner = new DiscussionRunner(f.config, f.store, deliver);
  await runner.tick();
  for (let retry = 0; retry < 2; retry++) { f.store.record(1, { retry_at: 1 }); await runner.tick(); }
  await new DiscussionRunner(f.config, f.store, deliver).tick();
  assert.equal(sent, 3); assert.equal(f.run.status, 'paused');
  const saved = f.store.db.prepare('SELECT * FROM inbox WHERE id=1').get();
  assert.equal(saved.status, 'failed'); assert.match(saved.error, /3 次均确认未送出.*executable missing/);
});

test('saved business evidence prevents a scheduled retry or failure', async t => {
  for (const status of ['started', 'completed']) {
    const f = await fixture(t); let sent = 0;
    const runner = new DiscussionRunner(f.config, f.store, async () => {
      sent++; throw Object.assign(new Error('not sent'), { delivery_status: 'not_sent' });
    });
    await runner.tick(); f.store.record(1, { attempts: 3, retry_at: 1 });
    f.event.status = status; f.event.lease_until = Math.floor(Date.now() / 1000) + 120;
    await runner.tick();
    assert.equal(sent, 1); assert.equal(f.run.status, 'running'); assert.equal(f.calls.includes('fail'), false);
  }
});

test('reserve response loss is reconciled before delivery without changing the token', async t => {
  for (const failure of ['before', 'after']) {
    const f = await fixture(t); let sent = 0;
    const deliver = async () => { sent++; return { status: 'accepted' }; };
    f.failures.reserve = failure;
    await assert.rejects(new DiscussionRunner(f.config, f.store, deliver).tick(), /fetch failed/);
    const token = f.store.pending()[0].token;
    assert.equal(sent, 0); assert.equal(f.store.pending()[0].status, 'reserving');
    await new DiscussionRunner(f.config, f.store, deliver).tick();
    assert.equal(sent, 1); assert.deepEqual(f.reserve_tokens, [token]);
    assert.equal(f.run.status, 'running');
  }
});

test('a restart at the software invocation boundary never blindly resends', async t => {
  const f = await fixture(t); let sent = 0;
  const runner = new DiscussionRunner(f.config, f.store, async () => { sent++; return { status: 'accepted' }; });
  await runner.tick(); f.store.record(1, { status: 'dispatching', sent_at: Date.now() - 120_000 });
  await runner.tick(); assert.equal(sent, 1); assert.equal(f.run.status, 'running');
});

test('an uncertain delivery still obeys the discussion limit', async t => {
  const f = await fixture(t); let sent = 0;
  const runner = new DiscussionRunner(f.config, f.store, async () => { sent++; throw new Error('receipt lost'); });
  await runner.tick(); f.limits.reached = true;
  assert.equal(await runner.tick(), 'waiting');
  assert.equal(sent, 1); assert.equal(f.run.status, 'paused'); assert.equal(f.store.pending().length, 0);
});

test('an expired execution lease still pauses without restarting the AI task', async t => {
  const f = await fixture(t); let sent = 0;
  const runner = new DiscussionRunner(f.config, f.store, async () => { sent++; return { status: 'accepted' }; });
  await runner.tick(); f.event.status = 'started'; f.event.lease_until = Math.floor(Date.now() / 1000) - 1;
  await runner.tick();
  assert.equal(f.run.status, 'paused'); assert.equal(f.event.status, 'failed'); assert.equal(sent, 1);
});

test('Claude errors reported with exit code 0 are recognized, including usage limits', () => {
  const limited = JSON.stringify({ type: 'result', is_error: true, api_error: 'usage_limit_reached', result: "You've hit your session limit · resets 2pm" });
  assert.match(claude_exit_error(0, `${limited}
`), /session limit/);
  assert.equal(claude_exit_error(1, 'not json'), 'Claude 退出码 1');
  assert.equal(claude_exit_error(0, JSON.stringify({ type: 'result', is_error: false, result: '完成' })), '');
});

test('a software error pauses at once with its cause instead of waiting for the lease', async t => {
  const f = await fixture(t);
  const runner = new DiscussionRunner(f.config, f.store, async (adapter, binding, task) => {
    setImmediate(() => task.on_failure('Claude 执行出错：usage limit'));
    return { status: 'accepted' };
  });
  await runner.tick(); await delay(5);
  f.event.status = 'started'; f.event.lease_until = Math.floor(Date.now() / 1000) + 120;
  await runner.tick();
  assert.equal(f.event.status, 'failed'); assert.equal(f.event.result, 'Claude 执行出错：usage limit');
});

test('a session that exits without saving its result pauses after rechecking the event', async t => {
  const f = await fixture(t);
  const runner = new DiscussionRunner(f.config, f.store, async (adapter, binding, task) => {
    setImmediate(() => task.on_exit());
    return { status: 'accepted' };
  });
  await runner.tick(); await delay(5);
  f.event.status = 'started'; f.event.lease_until = Math.floor(Date.now() / 1000) + 120;
  await runner.tick();
  assert.equal(f.event.status, 'failed'); assert.match(f.event.result, /会话已结束，但未保存本次结果/);
});

test('a late Sidecar receipt is reconciled without another request', async t => {
  const f = await fixture(t); let sent = 0;
  f.config.participants.Codex = { adapter: 'antigravity', ipc_directory: f.config.directory };
  const runner = new DiscussionRunner(f.config, f.store, async () => { sent++; return { status: 'sidecar_pending' }; });
  await runner.tick(); f.store.record(1, { sent_at: Date.now() - 120_000 });
  const path = join(f.config.directory, 'event-1.result.json');
  writeFileSync(path, JSON.stringify({ status: 'uncertain', error: 'receipt lost' }));
  await runner.tick(); assert.equal(f.run.status, 'running');
  writeFileSync(path, JSON.stringify({ status: 'accepted', session_id: 'real-session' }));
  await runner.tick(); await runner.tick();
  assert.equal(f.store.pending()[0].status, 'accepted'); assert.equal(f.store.pending()[0].error, '');
  assert.equal(f.store.binding('Codex').session_id, 'real-session'); assert.equal(sent, 1);
});

test('only an executable that never starts is classified as safe to retry', async t => {
  const f = await fixture(t);
  await assert.rejects(run_program(join(f.config.directory, 'missing-executable'), []), error => error.delivery_status === 'not_sent');
  await assert.rejects(run_program(process.execPath, ['-e', 'process.exit(1)']), error => !error.delivery_status);
  await assert.rejects(run_program(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeout: 50 }), error => !error.delivery_status);
});

test('Claude spawn failure can retry without binding an uncreated session', async t => {
  const f = await fixture(t);
  f.config.participants.Codex = { adapter: 'claude', executable: join(f.config.directory, 'missing-executable') };
  const runner = new DiscussionRunner(f.config, f.store);
  await runner.tick(); await delay(10);
  assert.equal(f.store.pending()[0].status, 'retry_wait');
  assert.equal(f.store.binding('Codex').session_id, undefined);
  f.store.record(1, { retry_at: 1 }); await runner.tick();
  assert.equal(f.store.pending()[0].attempts, 2); assert.equal(f.run.status, 'running');
});

test('legacy inbox migration preserves accepted work and its credential', t => {
  const directory = mkdtempSync(join(tmpdir(), 'discussion-legacy-'));
  const db = new DatabaseSync(join(directory, 'runtime.sqlite3'));
  db.exec(`CREATE TABLE inbox(id INTEGER PRIMARY KEY,event TEXT NOT NULL,status TEXT NOT NULL,
    token TEXT NOT NULL,sent_at INTEGER NOT NULL,last_renew INTEGER NOT NULL,error TEXT NOT NULL);
    INSERT INTO inbox VALUES (7,'{}','accepted','original-token',123,0,'');`);
  db.close();
  const store = new DiscussionStore(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const row = store.pending()[0];
  assert.equal(row.id, 7); assert.equal(row.status, 'accepted'); assert.equal(row.token, 'original-token');
  assert.equal(row.sent_at, 123); assert.equal(row.attempts, 0); assert.equal(row.retry_at, 0);
});

test('one data directory cannot silently share cursors across rooms or sites', async t => {
  const f = await fixture(t);
  f.store.scope(f.config, 'run');
  assert.throws(() => f.store.scope({ ...f.config, room: 'another' }, 'run'), /另一站点/);
});

test('project and cwd are optional; configured directories must match real projects', async () => {
  const app = { list_projects: async () => [{ hostId: 'local', projectId: 'project', label: 'Story', path: tmpdir() }] };
  assert.deepEqual(await codex_target(app, {}), { type: 'projectless' });
  assert.equal((await codex_target(app, { project_name: 'Story', cwd: tmpdir() })).projectId, 'project');
  await assert.rejects(codex_target(app, { project_name: 'Story', cwd: join(tmpdir(), 'different') }), /无法唯一匹配/);
  assert.equal(antigravity_project({}).id, 'outside-of-project');
});

test('common cwd is inherited and participant-specific cwd can override it', t => {
  const directory = mkdtempSync(join(tmpdir(), 'discussion-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'other')); writeFileSync(join(directory, 'discuss.py'), '');
  const config_path = join(directory, 'config.json');
  writeFileSync(config_path, JSON.stringify({ site: 'http://localhost:8765', room: 'room', token: 'x'.repeat(32), cli_project: directory,
    cwd: directory, participants: { Claude: { adapter: 'claude', executable: process.execPath }, Gemini: { adapter: 'antigravity', ipc_directory: directory, cwd: join(directory, 'other') } } }));
  const config = load_config(config_path);
  assert.equal(config.participants.Claude.cwd, directory);
  assert.equal(config.participants.Gemini.cwd, join(directory, 'other'));
});

test('a bound runtime rejects changed projects before delivering work', async t => {
  const f = await fixture(t); let sent = 0;
  const deliver = async () => { sent++; return { status: 'accepted', session_id: 'actual-chat' }; };
  await new DiscussionRunner(f.config, f.store, deliver).tick();
  f.config.participants.Codex.cwd = tmpdir();
  await assert.rejects(new DiscussionRunner(f.config, f.store, deliver).tick(), /项目、cwd/);
  assert.equal(sent, 1);
});

test('a paused run keeps the runner waiting for a web restart, and a stopped run ends it', async t => {
  const f = await fixture(t);
  const runner = new DiscussionRunner(f.config, f.store, async () => ({ status: 'accepted' }));
  f.run.status = 'paused';
  assert.equal(await runner.tick(), 'waiting');
  f.run.status = 'stopped';
  assert.equal(await runner.tick(), false);
});

test('conclusion reconciles the final business result before the runner exits', async t => {
  const f = await fixture(t); let sent = 0;
  const runner = new DiscussionRunner(f.config, f.store, async () => { sent++; return { status: 'accepted' }; });
  await runner.tick();
  f.event.status = 'completed'; f.run.status = 'concluded';
  assert.equal(await runner.tick(), false);
  assert.equal(f.store.pending().length, 0);
  assert.equal(sent, 1);
});

test('a delayed Sidecar request after the deadline never invokes the software', async t => {
  const f = await fixture(t);
  f.event.status = 'dispatched'; f.run.deadline = Math.floor(Date.now() / 1000) - 1;
  const access_path = join(f.config.directory, 'access.json');
  writeFileSync(access_path, JSON.stringify({ site: f.config.site, room: f.config.room, token: 'x'.repeat(32) }));
  writeFileSync(join(f.config.directory, 'event-1.request.json'), JSON.stringify({ id: 'event-1', event_id: 1, access_path, prompt: 'not delivered' }));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../runner/discussion_sidecar.mjs', import.meta.url))], {
    windowsHide: true, stdio: 'ignore', env: { ...process.env, CODISCUSS_IPC_DIRECTORY: f.config.directory, ANTIGRAVITY_AGENTAPI_EXE: process.execPath },
  });
  const exited = once(child, 'exit');
  try {
    const receipt = join(f.config.directory, 'event-1.result.json');
    for (let attempt = 0; attempt < 80 && !existsSync(receipt); attempt++) await delay(25);
    const result = JSON.parse(readFileSync(receipt, 'utf8'));
    assert.equal(result.status, 'uncertain');
    assert.match(result.error, /运行已停止或到期，未调用软件/);
  } finally { child.kill(); await exited; }
});

test('omitted cli_project defaults to this repository', t => {
  const directory = mkdtempSync(join(tmpdir(), 'discussion-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'config.json');
  writeFileSync(path, JSON.stringify({ site: 'http://127.0.0.1:8765', room: 'room1', token: 'x'.repeat(32),
    participants: { Gemini: { adapter: 'antigravity', ipc_directory: directory } } }));
  const config = load_config(path);
  assert.equal(config.project, resolve(fileURLToPath(new URL('..', import.meta.url))));
  assert.ok(existsSync(join(config.project, 'discuss.py')));
});

/** Write a minimal valid private room configuration for the service registry. */
function room_config(directory, site, room, name = room) {
  const path = join(directory, `${name}.json`);
  writeFileSync(path, JSON.stringify({ site, room, token: 'x'.repeat(32), data_directory: join(directory, `data-${name}`),
    participants: { Gemini: { adapter: 'antigravity', ipc_directory: directory } } }));
  return path;
}

test('the service ticks every registered room and pauses a room once it is unregistered', async t => {
  const f = await fixture(t);
  const home = mkdtempSync(join(tmpdir(), 'discussion-service-'));
  const first = room_config(home, f.config.site, 'room1');
  const second = room_config(home, f.config.site, 'room2');
  register_room(home, first); register_room(home, second);
  const ticks = [];
  const service = new DiscussionService(home, config => ({ tick: async () => { ticks.push(config.room); return 'waiting'; }, stop_children() {} }));
  t.after(async () => { await service.close(); rmSync(home, { recursive: true, force: true }); });
  await service.tick();
  assert.deepEqual(ticks.sort(), ['room1', 'room2']);
  const status = JSON.parse(readFileSync(join(home, 'status.json'), 'utf8'));
  assert.deepEqual(status.rooms.map(room => room.status), ['paused', 'paused']);
  unregister_room(home, second);
  ticks.length = 0;
  await service.tick();
  assert.deepEqual(ticks, ['room1']);
  assert.ok(!existsSync(join(home, 'data-room2', 'runner.lock')), 'removed room releases its data-directory lock');
});

test('a room failure is reported without stopping the other rooms', async t => {
  const f = await fixture(t);
  const home = mkdtempSync(join(tmpdir(), 'discussion-service-'));
  register_room(home, room_config(home, f.config.site, 'room1'));
  register_room(home, room_config(home, f.config.site, 'room2'));
  const service = new DiscussionService(home, config => ({ stop_children() {},
    tick: async () => { if (config.room === 'room1') throw new Error('HTTP 500'); } }));
  t.after(async () => { await service.close(); rmSync(home, { recursive: true, force: true }); });
  await service.tick();
  const rooms = JSON.parse(readFileSync(join(home, 'status.json'), 'utf8')).rooms;
  assert.deepEqual(rooms.map(room => [room.room, room.status, room.error]), [['room1', 'error', 'HTTP 500'], ['room2', 'running', '']]);
});

test('the same site and room cannot be registered twice', t => {
  const home = mkdtempSync(join(tmpdir(), 'discussion-service-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  register_room(home, room_config(home, 'http://127.0.0.1:8765', 'room1', 'a'));
  assert.throws(() => register_room(home, room_config(home, 'http://127.0.0.1:8765', 'room1', 'b')), /已由/);
});

test('the detached service starts once, reports status and stops on request', async t => {
  const home = mkdtempSync(join(tmpdir(), 'discussion-service-'));
  const script = fileURLToPath(new URL('../runner/discussion_service.mjs', import.meta.url));
  const env = { ...process.env, DISCUSS_SERVICE_HOME: home };
  const run = async (...args) => {
    const child = spawn(process.execPath, [script, ...args], { env });
    let output = ''; child.stdout.on('data', chunk => { output += chunk; });
    const [code] = await once(child, 'close');
    assert.equal(code, 0);
    return JSON.parse(output);
  };
  t.after(async () => { if (service_pid(home)) await run('stop'); rmSync(home, { recursive: true, force: true }); });
  const started = await run('start');
  assert.equal(started.started, true);
  assert.equal((await run('start')).started, false, 'a second start reuses the running service');
  assert.equal((await run('status')).pid, started.pid);
  assert.equal((await run('stop')).running, false);
  assert.equal(service_pid(home), 0);
});

test('a Claude CLI launched from a hosting Claude session drops host variables and keeps its own login', () => {
  const host = { CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'claude-desktop', CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH: '1', PATH: 'bin' };
  const env = standalone_claude_env(host, () => ({ CLAUDE_CODE_OAUTH_TOKEN: 'persisted' }));
  assert.deepEqual(env, { PATH: 'bin', CLAUDE_CODE_OAUTH_TOKEN: 'persisted' });
  const plain = { PATH: 'bin', CLAUDE_CODE_OAUTH_TOKEN: 'own' };
  assert.equal(standalone_claude_env(plain, () => { throw new Error('not read'); }), plain);
});

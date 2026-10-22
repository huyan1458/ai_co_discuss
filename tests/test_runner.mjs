import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { DiscussionRunner, DiscussionStore, load_config, service_drafts, task_files, validate_config } from '../runner/discussion_runner.mjs';
import { cwd_key, FreeRoomRunner, workspace_snapshot } from '../runner/free_runner.mjs';
import { assert_shared_home, DiscussionService, migrate_service_home, read_registry, register_room, service_pid, service_ready, start_service, unregister_room } from '../runner/discussion_service.mjs';
import { launch_discussion, room_models } from '../runner/discussion_launch.mjs';
import { agy_rule, antigravity_project, claude_exit_error, claude_rule_path, standalone_claude_env, codex_target, deliver_task, prepare_agy_project, remove_agy_projects, run_program, TASK_SUBCOMMANDS } from '../runner/discussion_adapters.mjs';
import { save_api_key, saved_api_keys } from '../runner/discussion_api.mjs';

test('API profiles need a bound key but no software or filesystem permission', t => {
  const home = mkdtempSync(join(tmpdir(), 'api-config-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const base_url = 'https://openrouter.ai/api/v1';
  const key = save_api_key(home, { base_url, api_key: 'test-only-key' });
  const input = { site: 'https://discussion.test', room: 'api-room', token: 'owner'.repeat(8), api_home: home, project_access: 'write',
    participants: { Grok: { adapter: 'api', api_protocol: 'chat', base_url, model: 'vendor/model.1', ...key, project_access: 'write', cwd: home } } };
  const config = validate_config(input, home);
  assert.equal(config.participants.Grok.project_access, 'read');
  assert.equal(config.participants.Grok.cwd, undefined);
  assert.equal(config.participants.Grok.executable, undefined);
  assert.throws(() => validate_config({ ...input, participants: { Grok: { ...input.participants.Grok, base_url: 'https://api.x.ai/v1' } } }, home), /重新填写/);
  assert.deepEqual(saved_api_keys(home), { [base_url]: key.api_key_ref });
});

test('a stopped legacy service directory moves with its paths and drafts rewritten', t => {
  const root = mkdtempSync(join(tmpdir(), 'service-move-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const from = join(root, 'legacy'), to = join(root, '.codiscuss'), runtime = join(from, 'launches', 'key', 'runtime');
  const external = join(root, 'external-config.json');
  mkdirSync(runtime, { recursive: true });
  mkdirSync(service_drafts(from, runtime), { recursive: true });
  writeFileSync(join(service_drafts(from, runtime), 'turn-1-submission.json'), '{}');
  const config = { api_home: from, data_directory: runtime, draft_directory: service_drafts(from, runtime), note: `see ${from}` };
  writeFileSync(join(from, 'launches', 'key', 'config.json'), JSON.stringify(config));
  writeFileSync(external, JSON.stringify({ api_home: from, data_directory: join(root, 'elsewhere') }));
  writeFileSync(join(from, 'rooms.json'), JSON.stringify({ configs: [join(from, 'launches', 'key', 'config.json'), external] }));
  writeFileSync(join(from, 'runner.lock'), String(process.pid));
  assert.equal(migrate_service_home(from, to), false);
  rmSync(join(from, 'runner.lock'));
  assert.equal(migrate_service_home(from, to), true);
  const moved_runtime = join(to, 'launches', 'key', 'runtime');
  assert.deepEqual(JSON.parse(readFileSync(join(to, 'launches', 'key', 'config.json'), 'utf8')),
    { ...config, api_home: to, data_directory: moved_runtime, draft_directory: service_drafts(to, moved_runtime) });
  assert.deepEqual(read_registry(to), [join(to, 'launches', 'key', 'config.json'), external]);
  assert.equal(JSON.parse(readFileSync(external, 'utf8')).api_home, to);
  assert.ok(existsSync(join(service_drafts(to, moved_runtime), 'turn-1-submission.json')));
  assert.ok(!existsSync(from));
});

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
    if (request.url.includes('/events?')) result = { events: [event], next_after: event.id };
    else if (request.url.endsWith(`/events/${event.id}`)) {
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
  t.after(async () => { store.close(); await new Promise(resolve => server.close(resolve));
    rmSync(directory, { recursive: true, force: true }); rmSync(`${directory}-drafts`, { recursive: true, force: true }); });
  const config = { site: `http://127.0.0.1:${server.address().port}`, room: 'room', token: 'private-token', directory, project: directory, participants: { Codex: { adapter: 'codex' } } };
  return { store, event, run, calls, config, limits, failures, reserve_tokens };
}

test('room model readback uses registered choices and excludes defaults, paths and credentials', t => {
  const home = mkdtempSync(join(tmpdir(), 'discussion-models-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const path = join(home, 'room.json');
  const config = { site: 'http://127.0.0.1:8765', room: 'models', token: 'private-owner-token'.repeat(3),
    data_directory: join(home, 'runtime'), participants: {
      Codex: { adapter: 'codex_cli', executable: process.execPath, model: 'gpt-6-astra', effort: 'xhigh', session_id: 'private-session' },
      Claude: { adapter: 'claude', executable: process.execPath },
      Gemini: { adapter: 'antigravity', ipc_directory: home, model: 'stale-cli-choice', effort: 'high' },
    } };
  writeFileSync(path, JSON.stringify(config));
  register_room(home, path);
  writeFileSync(join(home, 'launch-settings.json'), JSON.stringify({ participants: { Claude: { model: 'wrong-default', effort: 'max' } } }));
  const input = { site: config.site, room_id: config.room };
  assert.deepEqual(room_models(home, input), { room_id: 'models', participants: {
    Codex: { adapter: 'codex_cli', model: 'gpt-6-astra', effort: 'xhigh' },
    Claude: { adapter: 'claude', model: '', effort: '' },
    Gemini: { adapter: 'antigravity', model: '', effort: '' },
  } });
  config.participants.Gemini = { adapter: 'antigravity_cli', executable: process.execPath, model: 'gemini-4-argon-high' };
  writeFileSync(path, JSON.stringify(config));
  assert.deepEqual(room_models(home, input).participants.Gemini,
    { adapter: 'antigravity_cli', model: 'gemini-4-argon-high', effort: '' });
  assert.deepEqual(room_models(home, { ...input, room_id: 'missing' }).participants, {});
  assert.deepEqual(room_models(home, { ...input, site: 'https://other.example' }).participants, {});
  assert.throws(() => room_models(home, { ...input, room_id: '../models' }), /房间编号无效/);
});

test('agy project records survive a concluded room and are dropped only after the room is deleted', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'discussion-deleted-'));
  const room = { deleted: false };
  const server = createServer((request, response) => {
    response.statusCode = room.deleted ? 404 : 200;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(room.deleted ? { error: '房间不存在' }
      : { title: '已收束', phase: 'concluded', runtime: { mode: 'automatic', status: 'stopped' }, limits: {} }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const store = new DiscussionStore(directory);
  t.after(async () => { store.close(); await new Promise(resolve => server.close(resolve)); rmSync(directory, { recursive: true, force: true }); });
  const record = join(directory, `agy-project-${'a'.repeat(64)}.json`);
  writeFileSync(record, JSON.stringify({ project_id: randomUUID(), session_id: 'kept-session' }));
  const runner = new DiscussionRunner({ site: `http://127.0.0.1:${server.address().port}`, room: 'room', token: 'private-token',
    directory, participants: { Gemini: { adapter: 'antigravity_cli' } } }, store, async () => assert.fail('must not deliver'));
  assert.equal(await runner.tick(), false);
  assert.ok(existsSync(record));
  room.deleted = true;
  await assert.rejects(runner.tick(), /房间不存在/);
  assert.equal(existsSync(record), false);
});

test('replayed events and a restarted dispatcher do not deliver a second notification', async t => {
  const f = await fixture(t); let sent = 0;
  const deliver = async () => { sent++; return { status: 'accepted', session_id: 'actual-chat' }; };
  await new DiscussionRunner(f.config, f.store, deliver).tick();
  await new DiscussionRunner(f.config, f.store, deliver).tick();
  assert.equal(sent, 1); assert.equal(f.store.cursor(), 1);
  assert.equal(f.store.binding('Codex').session_id, 'actual-chat');
  assert.equal(f.calls.filter(action => action === 'reserve').length, 1);
});

test('a participant whose previous process is still exiting is not resumed until it closes', async t => {
  const f = await fixture(t); let sent = 0;
  const runner = new DiscussionRunner(f.config, f.store, async () => { sent++; return { status: 'accepted' }; });
  const previous = new EventEmitter();
  runner.track('Codex', previous);
  await runner.tick();
  assert.equal(sent, 0); assert.equal(f.calls.filter(action => action === 'reserve').length, 0);
  previous.emit('close', 0);
  await runner.tick();
  assert.equal(sent, 1);
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

for (const adapter of ['claude', 'codex_cli', 'antigravity_cli']) {
test(`${adapter} spawn failure can retry without binding an uncreated session`, async t => {
  const f = await fixture(t);
  f.config.participants.Codex = { adapter, executable: join(f.config.directory, 'missing-executable') };
  const runner = new DiscussionRunner(f.config, f.store,
    (config, binding, task) => deliver_task(config, binding, task, undefined, join(f.config.directory, 'user')));
  await runner.tick(); await delay(10);
  assert.equal(f.store.pending()[0].status, 'retry_wait');
  assert.equal(f.store.binding('Codex').session_id, undefined);
  f.store.record(1, { retry_at: 1 }); await runner.tick();
  assert.equal(f.store.pending()[0].attempts, 2); assert.equal(f.run.status, 'running');
});
}

/** Emit real subprocess output in split UTF-8 chunks without invoking an AI account. */
function fake_cli(events, options = {}) {
  const calls = [];
  const config_calls = [];
  const source = `
    const fs = require('node:fs');
    (async () => {
      let input = ''; for await (const chunk of process.stdin) input += chunk;
      fs.writeFileSync('stdin.txt', input);
      process.stderr.write(${JSON.stringify(options.stderr || 'diagnostic 中文')});
      const output = Buffer.from(${JSON.stringify(events.map(event => JSON.stringify(event)).join('\r\n') + '\r\n')});
      const split = Math.max(1, output.indexOf(Buffer.from('中文')) + 1);
      process.stdout.write(output.subarray(0, split));
      await new Promise(resolve => setTimeout(resolve, 5));
      process.stdout.write(output.subarray(split));
      if (${Boolean(options.linger)}) setInterval(() => {}, 1000);
      process.exitCode = ${options.exit_code || 0};
    })();`;
  const spawn_process = (executable, args, settings) => {
    if (args[0] === 'app-server') {
      const name = JSON.parse(args.find(arg => arg.startsWith('default_permissions=')).split('=')[1]);
      const config = { default_permissions: name, permissions: { [name]: {} }, ...options.codex_config };
      const source = `require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
        const request = JSON.parse(line);
        const result = request.id === 1 ? { userAgent: 'Codex Desktop/${options.codex_version || '0.163.0'} (test)' } : { config: ${JSON.stringify(config)} };
        process.stdout.write(JSON.stringify({ id: request.id, result }) + '\\n');
      });`;
      const child = spawn(process.execPath, ['-e', source], settings);
      config_calls.push({ args, child, closed: once(child, 'close') });
      return child;
    }
    const child = spawn(process.execPath, ['-e', source], settings);
    calls.push({ executable, args, settings, child, closed: once(child, 'close') });
    return child;
  };
  return { calls, config_calls, spawn_process };
}

/** Represent the documented startup and terminal events of the two CLI protocols. */
function cli_events(adapter, session_id = 'actual-cli-session') {
  return adapter === 'codex_cli'
    ? [{ type: 'thread.started', thread_id: session_id }, { type: 'item.completed', item: { text: '中文' } }, { type: 'turn.completed' }]
    : [{ event: 'init', conversation_id: session_id }, { event: 'result', result: { conversation_id: session_id, status: 'SUCCESS', response: '中文' } }];
}

/** Capture adapter callbacks and private credentials in an isolated task directory. */
async function cli_delivery_fixture(t, adapter, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'discussion-cli-adapter-'));
  const directory = join(root, 'runtime');
  const user_home = join(root, 'user');
  mkdirSync(directory);
  const draft_directory = join(root, 'drafts');
  mkdirSync(draft_directory);
  const access_path = join(directory, 'access.json');
  writeFileSync(access_path, JSON.stringify({ token: 'test-only', session_id: '' }));
  const bindings = []; const errors = []; let exits = 0;
  const process_fixture = fake_cli(options.events || cli_events(adapter), options);
  t.after(async () => {
    for (const call of [...process_fixture.calls, ...process_fixture.config_calls]) {
      if (call.child.exitCode === null && call.child.signalCode === null) call.child.kill();
      await call.closed;
    }
    rmSync(root, { recursive: true, force: true });
  });
  const task = { id: 'event-1', participant: 'Gemini', directory, draft_directory, access_path, prompt: '讨论中文 "quotes"\n$(literal); `literal`',
    skills_directory: join(directory, 'skills'),
    on_binding: session => bindings.push(session), on_process: () => {},
    on_output: (path, chunk) => appendFileSync(path, chunk), on_failure: error => errors.push(error), on_exit: () => { exits++; } };
  const config = { adapter, executable: process.execPath, ...options.config };
  const result = await deliver_task(config, options.binding || {}, task, process_fixture.spawn_process, user_home);
  await process_fixture.calls[0].closed;
  return { directory, user_home, config, access_path, task, result, bindings, errors, exits, ...process_fixture };
}

for (const source of ['stderr', 'event']) {
test(`codex_cli explains an active writer from ${source} without replacing the original session`, async t => {
  const conflict = 'thread-store conflict: thread original-session already has an active writer';
  const f = await cli_delivery_fixture(t, 'codex_cli', {
    binding: { session_id: 'original-session' }, exit_code: 1,
    events: source === 'event' ? [{ type: 'error', message: conflict }, { type: 'error', message: 'models refresh timed out' }] : [],
    stderr: source === 'stderr' ? `${conflict}\n${'models refresh timed out\n'.repeat(100)}` : undefined,
  });
  assert.match(f.errors[0], /original-session.*active writer/);
  assert.match(f.errors[0], /Codex App 接入/);
  assert.doesNotMatch(f.errors[0], /models refresh/);
  assert.equal(f.calls.length, 1); assert.equal(f.exits, 0); assert.deepEqual(f.bindings, []);
  assert.equal(JSON.parse(readFileSync(f.access_path, 'utf8')).session_id, 'original-session');
});
}

for (const adapter of ['codex_cli', 'antigravity_cli']) {
test(`${adapter} starts headlessly, binds emitted identity and preserves UTF-8 prompt and logs`, async t => {
  const f = await cli_delivery_fixture(t, adapter);
  assert.equal(f.result.status, 'accepted'); assert.deepEqual(f.errors, []); assert.equal(f.exits, 1);
  assert.equal(f.bindings[0], 'actual-cli-session');
  assert.equal(JSON.parse(readFileSync(f.access_path, 'utf8')).session_id, 'actual-cli-session');
  const call = f.calls[0];
  assert.equal(call.settings.cwd, f.task.draft_directory); assert.equal(call.settings.shell, false);
  assert.equal(call.settings.windowsHide, true); assert.ok(call.args.includes(f.task.draft_directory));
  assert.ok(!call.args.some(arg => arg.startsWith('--dangerously')));
  if (adapter === 'codex_cli') {
    assert.equal(call.args[0], 'exec'); assert.ok(call.args.includes('--json'));
    assert.ok(call.args.includes('--skip-git-repo-check')); assert.equal(call.args.at(-1), '-');
    assert.equal(readFileSync(join(f.task.draft_directory, 'stdin.txt'), 'utf8'), f.task.prompt);
    const overrides = call.args.filter((arg, index) => call.args[index - 1] === '-c');
    assert.equal(overrides.length, 3); assert.equal(overrides[2], 'approval_policy="never"');
    assert.match(overrides[1], /extends=":read-only"/); assert.match(overrides[1], /network=\{enabled=true\}/);
    assert.ok(overrides[1].includes(`${JSON.stringify(f.directory.replaceAll('\\', '/'))}="read"`));
    assert.ok(overrides[1].includes(`${JSON.stringify(f.task.draft_directory.replaceAll('\\', '/'))}="write"`));
    assert.deepEqual(f.config_calls[0].args.slice(1), call.args.slice(call.args.indexOf('-c'), call.args.indexOf('--json')));
    assert.ok(!call.args.includes('--add-dir'));
  } else {
    assert.ok(call.args.includes(f.task.skills_directory));
    assert.equal(call.args[call.args.indexOf('-p') + 1], f.task.prompt);
    assert.equal(call.args[call.args.indexOf('--output-format') + 1], 'stream-json');
    assert.equal(call.args[call.args.indexOf('--print-timeout') + 1], '0');
    assert.match(call.args[call.args.indexOf('--project') + 1], /^[a-f0-9-]{36}$/);
    assert.equal(call.args[call.args.indexOf('--mode') + 1], 'accept-edits');
  }
  assert.match(readFileSync(join(f.directory, `${adapter}-event-1.log`), 'utf8'), /中文/);
});

test(`${adapter} resumes only the bound conversation and honors its configured cwd`, async t => {
  const project = mkdtempSync(join(tmpdir(), 'discussion-cwd-')); t.after(() => rmSync(project, { recursive: true, force: true }));
  if (adapter === 'antigravity_cli') {
    // agy runs only in sessions this tool created; an external conversation cannot take the discussion project.
    await assert.rejects(cli_delivery_fixture(t, adapter, { binding: { session_id: 'actual-cli-session' }, config: { cwd: project } }),
      error => error.delivery_status === 'not_sent' && /本工具新建/.test(error.message));
    return;
  }
  const f = await cli_delivery_fixture(t, adapter, { binding: { session_id: 'actual-cli-session' },
    config: { cwd: project, project_access: 'write' } });
  const call = f.calls[0];
  const flag = adapter === 'codex_cli' ? 'resume' : '--conversation';
  assert.equal(call.args[call.args.indexOf(flag) + 1], 'actual-cli-session');
  assert.equal(call.args.includes('--last'), false); assert.equal(call.args.includes('--continue'), false);
  assert.equal(call.args.includes('--project'), false); assert.deepEqual(f.errors, []);
  assert.equal(call.settings.cwd, project);
  if (adapter === 'codex_cli') {
    assert.ok(call.args.findIndex(arg => arg.startsWith('default_permissions=')) > call.args.indexOf('resume'));
    assert.match(call.args.find(arg => arg.startsWith('permissions.')), /extends=":workspace"/);
    assert.equal(call.args[call.args.indexOf('--cd') + 1], project);
  }
});

test(`${adapter} keeps the project cwd when project access is read-only`, async t => {
  const project = mkdtempSync(join(tmpdir(), 'discussion-cwd-')); t.after(() => rmSync(project, { recursive: true, force: true }));
  const f = await cli_delivery_fixture(t, adapter, { config: { cwd: project, project_access: 'read' } });
  const call = f.calls[0];
  assert.equal(call.settings.cwd, project); assert.deepEqual(f.errors, []);
  if (adapter === 'codex_cli') {
    assert.equal(call.args.includes('--mode'), false);
    assert.equal(call.args[call.args.indexOf('--cd') + 1], project);
    assert.match(call.args.find(arg => arg.startsWith('permissions.')), /extends=":read-only"/);
  } else {
    assert.equal(call.args[call.args.indexOf('--mode') + 1], 'accept-edits');
    assert.ok(!call.args.includes(project), 'agy does not attach its cwd a second time');
  }
});

test(`${adapter} never replaces a bound identity when the CLI returns another session`, async t => {
  // agy refuses unmanaged bindings before spawning; its managed binding mismatch is covered by the project test.
  if (adapter === 'antigravity_cli') return;
  const f = await cli_delivery_fixture(t, adapter, { binding: { session_id: 'original-session' } });
  assert.match(f.errors[0], /会话 ID 与绑定不符/); assert.equal(f.exits, 0);
  assert.deepEqual(f.bindings, []);
  assert.equal(JSON.parse(readFileSync(f.access_path, 'utf8')).session_id, 'original-session');
});

test(`${adapter} rejects successful process exit without a terminal CLI result`, async t => {
  const f = await cli_delivery_fixture(t, adapter, { events: cli_events(adapter).slice(0, 1) });
  assert.match(f.errors[0], /未返回成功结束事件/); assert.equal(f.exits, 0);
});

test(`${adapter} reports a nonzero exit without classifying the sent task as retryable`, async t => {
  const f = await cli_delivery_fixture(t, adapter, { events: [], exit_code: 7 });
  assert.match(f.errors[0], /退出码 7/); assert.match(f.errors[0], /diagnostic 中文/);
  assert.equal(f.result.status, 'accepted'); assert.equal(f.exits, 0); assert.deepEqual(f.bindings, []);
});

test(`${adapter} persists a streamed binding and resumes it after a dispatcher restart`, async t => {
  const f = await fixture(t);
  f.config.participants.Codex = { adapter, executable: process.execPath };
  const process_fixture = fake_cli(cli_events(adapter));
  const deliver = (config, binding, task) => deliver_task(config, binding, task, process_fixture.spawn_process, join(f.config.directory, 'user'));
  const runner = new DiscussionRunner(f.config, f.store, deliver);
  await runner.tick(); await process_fixture.calls[0].closed;
  assert.equal(f.store.binding('Codex').session_id, 'actual-cli-session');
  f.event.status = 'completed'; await runner.tick();
  f.event.id = 2; f.event.status = 'pending';
  const restored_store = new DiscussionStore(f.config.directory);
  try {
    await new DiscussionRunner(f.config, restored_store, deliver).tick(); await process_fixture.calls[1].closed;
  } finally { restored_store.close(); }
  const args = process_fixture.calls[1].args;
  assert.equal(args[args.indexOf(adapter === 'codex_cli' ? 'resume' : '--conversation') + 1], 'actual-cli-session');
  assert.equal(JSON.parse(readFileSync(join(f.config.directory, 'event-2.access.json'), 'utf8')).session_id, 'actual-cli-session');
  assert.equal(f.store.pending()[0].attempts, 1);
  if (adapter === 'antigravity_cli') {
    const first_args = process_fixture.calls[0].args;
    assert.equal(args[args.indexOf('--project') + 1], first_args[first_args.indexOf('--project') + 1]);
  }
});

test(`${adapter} is terminated and reported when it runs past the process time cap`, async t => {
  const f = await fixture(t);
  f.config.participants.Codex = { adapter, executable: process.execPath };
  const process_fixture = fake_cli(cli_events(adapter).slice(0, 1), { linger: true });
  const runner = new DiscussionRunner(f.config, f.store,
    (config, binding, task) => deliver_task(config, binding, task, process_fixture.spawn_process, join(f.config.directory, 'user')));
  process.env.CODISCUSS_CLI_MAX_MS = '300';
  try {
    await runner.tick();
    await process_fixture.calls[0].closed;
    assert.match(f.store.pending()[0].error, /仍未结束，已终止/);
  } finally { delete process.env.CODISCUSS_CLI_MAX_MS; runner.stop_children(); }
});

test(`${adapter} is stopped with the runner when its discussion pauses`, async t => {
  const f = await fixture(t);
  f.config.participants.Codex = { adapter, executable: process.execPath };
  const process_fixture = fake_cli(cli_events(adapter).slice(0, 1), { linger: true });
  const runner = new DiscussionRunner(f.config, f.store,
    (config, binding, task) => deliver_task(config, binding, task, process_fixture.spawn_process, join(f.config.directory, 'user')));
  try {
    await runner.tick(); assert.equal(runner.children.size, 1);
    for (let attempt = 0; attempt < 100 && !f.store.binding('Codex').session_id; attempt++) await delay(10);
    assert.equal(f.store.binding('Codex').session_id, 'actual-cli-session', 'identity is available while the CLI is still running');
    f.run.status = 'paused'; assert.equal(await runner.tick(), 'waiting');
    await process_fixture.calls[0].closed;
    assert.equal(runner.children.size, 0); assert.equal(process_fixture.calls.length, 1);
  } finally { runner.stop_children(); }
});
}

for (const options of [{ codex_config: { sandbox_mode: 'workspace-write' } },
  { codex_config: { sandbox_workspace_write: { writable_roots: ['/'] } } }, { codex_config: { permissions: {} } },
  { codex_version: '0.162.0' }, { codex_version: 'unknown' }]) {
test(`codex refuses conflicting or unavailable permission profiles: ${JSON.stringify(options)}`, async t => {
  const f = await fixture(t);
  f.config.participants.Codex = { adapter: 'codex_cli', executable: process.execPath };
  const process_fixture = fake_cli(cli_events('codex_cli'), options);
  const runner = new DiscussionRunner(f.config, f.store,
    (config, binding, task) => deliver_task(config, binding, task, process_fixture.spawn_process));
  await runner.tick();
  await process_fixture.config_calls[0].closed;
  assert.equal(process_fixture.calls.length, 0, 'config inspection must reject before starting an AI turn');
  assert.equal(f.store.binding('Codex').session_id, undefined);
  assert.equal(f.store.pending()[0].status, 'retry_wait');
  assert.match(f.store.pending()[0].error, /未交付讨论任务/);
  if (options.codex_version) assert.match(f.store.pending()[0].error, /0\.163\.0/);
  assert.equal(runner.children.size, 0);
});
}

test('agy separates native project permissions from the selected project and preserves read/write boundaries', async t => {
  const f = await fixture(t);
  const user_home = join(f.config.directory, 'user');
  const projects = join(user_home, '.gemini', 'config', 'projects');
  mkdirSync(projects, { recursive: true });
  const original = { id: 'original', name: 'Original project', settings: { keep: true },
    projectResources: { resources: [{ folder: { folderUri: pathToFileURL(join(f.config.directory, 'source')).href } }] },
    permissionGrants: { permissionGrants: { allow: ['command(*)'] } } };
  const original_path = join(projects, 'original.json');
  const original_text = JSON.stringify(original);
  writeFileSync(original_path, original_text);
  const task = { ...task_files(f.config, f.event, 'test-token', {}), room_title: '架构评审' };
  const config = { project_id: 'original', project_access: 'read' };
  const first = prepare_agy_project(config, {}, task, user_home);
  const read = JSON.parse(readFileSync(join(projects, `${first.project_id}.json`), 'utf8'));
  assert.equal(read.name, `CoDiscuss · 架构评审 · ${task.participant}`);
  const rule = path => `write_file(${resolve(path).replaceAll('\\', '/')})`;
  assert.deepEqual(read.projectResources, original.projectResources);
  assert.deepEqual(read.settings, {});
  assert.deepEqual(read.permissionGrants.permissionGrants.allow, [agy_rule(), rule(task.draft_directory)]);
  assert.ok(read.permissionGrants.permissionGrants.deny.includes(rule(join(f.config.directory, 'source'))));
  for (const path of [task.directory, task.skills_directory, join(user_home, '.gemini')]) {
    assert.ok(read.permissionGrants.permissionGrants.deny.includes(rule(path)));
  }
  assert.ok(read.permissionGrants.permissionGrants.deny.includes('mcp(*)'));
  first.bind('real-session');
  const resumed = prepare_agy_project({ ...config, project_access: 'write' }, { session_id: 'real-session' }, task, user_home);
  assert.equal(resumed.project_id, first.project_id);
  const write = JSON.parse(readFileSync(join(projects, `${first.project_id}.json`), 'utf8')).permissionGrants.permissionGrants;
  assert.ok(write.allow.includes(rule(join(f.config.directory, 'source'))));
  assert.ok(!write.deny.includes(rule(join(f.config.directory, 'source'))));
  assert.ok(write.deny.includes(rule(task.directory)));
  assert.equal(readFileSync(original_path, 'utf8'), original_text);
  assert.throws(() => prepare_agy_project(config, { session_id: 'other-session' }, task, user_home), /会话绑定不符/);
  // Deleting the room removes only the projects it created.
  assert.equal(remove_agy_projects(task.directory, user_home), 1);
  assert.equal(existsSync(join(projects, `${first.project_id}.json`)), false);
  assert.equal(readFileSync(original_path, 'utf8'), original_text);
  assert.equal(remove_agy_projects(task.directory, user_home), 0);
});

test('agy refuses inherited shell bypasses before invoking a model and leaves settings unchanged', async t => {
  const f = await fixture(t);
  const user_home = join(f.config.directory, 'user');
  const cli_path = join(user_home, '.gemini', 'antigravity-cli', 'settings.json');
  const shared_path = join(user_home, '.gemini', 'config', 'config.json');
  mkdirSync(join(user_home, '.gemini', 'antigravity-cli'), { recursive: true });
  mkdirSync(join(user_home, '.gemini', 'config'), { recursive: true });
  const task = task_files(f.config, f.event, 'test-token', {});
  for (const [cli, shared] of [
    [{ toolPermission: 'always-proceed' }, {}], [{ toolPermission: 'proceed-in-sandbox' }, {}],
    [{ permissions: { allow: ['command(*)'] } }, {}],
    [{}, { userSettings: { globalPermissionGrants: { allow: ['unsandboxed_command(*)'] } } }],
    [{}, { userSettings: { globalPermissionGrants: { allow: ['unsandboxed(*)'] } } }],
    [{ permissions: { allow: [agy_rule()] } }, {}],
  ]) {
    writeFileSync(cli_path, JSON.stringify(cli)); writeFileSync(shared_path, JSON.stringify(shared));
    await assert.rejects(deliver_task({ adapter: 'antigravity_cli' }, {}, task,
      () => assert.fail('must reject before spawning'), user_home), error => error.delivery_status === 'not_sent');
    assert.deepEqual(JSON.parse(readFileSync(cli_path, 'utf8')), cli);
    assert.deepEqual(JSON.parse(readFileSync(shared_path, 'utf8')), shared);
  }
  writeFileSync(cli_path, JSON.stringify({ toolPermission: 'request-review', permissions: { allow: ['read_file(*)'] } }));
  writeFileSync(shared_path, JSON.stringify({ userSettings: { globalPermissionGrants: { allow: ['read_url(https://example.com)'] } } }));
  assert.ok(prepare_agy_project({}, {}, task, user_home).project_id);
});

test('agy rejects nested answer storage because native deny rules take priority over allows', async t => {
  const f = await fixture(t);
  const task = task_files(f.config, f.event, 'test-token', {});
  for (const parent of [task.directory, task.skills_directory, join(f.config.directory, 'user', '.gemini')]) {
    assert.throws(() => prepare_agy_project({}, {}, { ...task, draft_directory: join(parent, 'drafts') },
      join(f.config.directory, 'user')), /草稿目录不能位于/);
  }
});

test('each CLI receives the configured model and effort as its own arguments', async t => {
  const codex = await cli_delivery_fixture(t, 'codex_cli', { config: { model: 'gpt-6-astra', effort: 'xhigh' } });
  const codex_args = codex.calls[0].args;
  assert.equal(codex_args[codex_args.indexOf('-m') + 1], 'gpt-6-astra'); assert.equal(codex_args.at(-1), '-');
  assert.ok(codex_args.includes('model_reasoning_effort="xhigh"'));
  const agy = await cli_delivery_fixture(t, 'antigravity_cli', { config: { model: 'gemini-4-argon-high' } });
  const agy_args = agy.calls[0].args;
  assert.equal(agy_args[agy_args.indexOf('--model') + 1], 'gemini-4-argon-high'); assert.ok(agy_args.indexOf('--model') < agy_args.indexOf('-p'));
  const claude = await cli_delivery_fixture(t, 'claude', { events: [{ type: 'result', is_error: false, result: '完成' }], config: { model: 'opus', effort: 'max' } });
  const claude_args = claude.calls[0].args;
  assert.equal(claude_args[claude_args.indexOf('--model') + 1], 'opus');
  assert.equal(claude_args[claude_args.indexOf('--effort') + 1], 'max'); assert.ok(claude_args.indexOf('--effort') < claude_args.indexOf('--allowedTools')); assert.ok(claude_args.indexOf('--model') < claude_args.indexOf('--allowedTools'));
  const plain = await cli_delivery_fixture(t, 'codex_cli');
  assert.equal(plain.calls[0].args.includes('-m'), false);
  assert.equal(plain.calls[0].args.some(arg => arg.startsWith('model_reasoning_effort')), false);
});

test('claude allows only codiscuss website subcommands and draft writes, then user rules', async t => {
  const f = await cli_delivery_fixture(t, 'claude', { events: [{ type: 'result', is_error: false, result: '完成' }],
    config: { allowed_tools: ['Read(//d/materials/**)'] } });
  const args = f.calls[0].args;
  assert.deepEqual(f.errors, []);
  assert.ok(!args.some(arg => arg.startsWith('--dangerously') || arg === '--permission-mode'));
  const directories = args.indexOf('--add-dir');
  assert.deepEqual(args.slice(directories + 1, directories + 4), [f.directory, f.task.draft_directory, f.task.skills_directory]);
  assert.deepEqual(args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--')),
    [...['room', 'message', 'turn', 'state', 'floor', 'execution', 'health', 'schema']
      .flatMap(command => [`Bash(codiscuss ${command} *)`, `PowerShell(codiscuss ${command} *)`]),
    `Edit(${claude_rule_path(f.task.draft_directory)}/**)`, 'Read(//d/materials/**)']);
  assert.ok(!args.includes(`Edit(${claude_rule_path(f.directory)}/**)`));
  assert.ok(!args.some(arg => /(Bash|PowerShell)\(codiscuss (service|launch|run|api|setup|install|local)/.test(arg)));
  assert.equal(args.at(-1), f.task.prompt);
  if (process.platform === 'win32') assert.equal(claude_rule_path('C:\\Data\\room'), '//c/Data/room');
});

test('claude edits a project only when the launch grants write access', async t => {
  const project = mkdtempSync(join(tmpdir(), 'discussion-cwd-')); t.after(() => rmSync(project, { recursive: true, force: true }));
  const result = [{ type: 'result', is_error: false, result: '完成' }];
  for (const project_access of ['read', 'write']) {
    const f = await cli_delivery_fixture(t, 'claude', { events: result, config: { cwd: project, project_access } });
    const call = f.calls[0];
    assert.equal(call.settings.cwd, project);
    assert.equal(call.args.includes(`Edit(${claude_rule_path(project)}/**)`), project_access === 'write');
  }
});

test('tasks state whether the discussion project is read-only or writable', async t => {
  const f = await fixture(t);
  const project = mkdtempSync(join(tmpdir(), 'discussion-cwd-')); t.after(() => rmSync(project, { recursive: true, force: true }));
  const config = load_config_from(f, project, 'write');
  assert.match(task_files(config, f.event, 'token-for-test', {}).prompt, /允许按议题需要修改/);
  const saved = JSON.parse(readFileSync(join(f.config.directory, 'event-1.task.json'), 'utf8'));
  assert.equal(saved.project_access, 'write'); assert.equal(saved.cwd, project);
  assert.equal(saved.draft_directory, `${f.config.directory}-drafts`);
  assert.ok(existsSync(saved.draft_directory));
  assert.match(saved.instructions, /不修改任务、凭据、日志或调度数据库/);
  assert.match(task_files(load_config_from(f, project), f.event, 'token-for-test', {}).prompt, /只读，不修改/);
  assert.match(task_files(f.config, f.event, 'token-for-test', {}).prompt, /未指定讨论项目目录/);
  assert.throws(() => load_config_from(f, project, 'admin'), /read 或 write/);
});

/** Validate the fixture room with a project directory and optional access level. */
function load_config_from(f, project, project_access) {
  return validate_config({ ...f.config, project: undefined, token: 'x'.repeat(32), cwd: project, project_access,
    participants: { Codex: { adapter: 'codex_cli', executable: process.execPath } }, data_directory: f.config.directory }, f.config.directory);
}

test('tasks direct website work to the approved codiscuss subcommands', async t => {
  const f = await fixture(t);
  const task = task_files(f.config, f.event, 'token-for-test', {});
  const saved = JSON.parse(readFileSync(join(f.config.directory, 'event-1.task.json'), 'utf8'));
  // Codex runs commands through PowerShell on Windows, where the npm .ps1 shim is blocked by execution policy.
  const cli = process.platform === 'win32' ? 'codiscuss.cmd' : 'codiscuss';
  assert.equal(saved.cli, cli); assert.deepEqual(saved.subcommands, TASK_SUBCOMMANDS);
  assert(task.prompt.includes(`${cli} execution enter`)); assert.match(task.prompt, /不用 python discuss\.py/);
  const claude = task_files({ ...f.config, participants: { Codex: { adapter: 'claude' } } }, f.event, 'token-for-test', {});
  assert.match(claude.prompt, /接入程序已为本次执行完成 execution enter/);
  assert(!claude.prompt.includes('立即用'));
  const has_rg = process.platform === 'win32' && spawnSync('rg', ['--version'], { stdio: 'ignore' }).status === 0;
  assert.equal(/rg --encoding utf-8/.test(claude.prompt), has_rg);
  const agy = task_files({ ...f.config, participants: { Codex: { adapter: 'antigravity_cli' } } }, f.event, 'token-for-test', {});
  assert.match(agy.prompt, /接入程序已为本次执行完成 execution enter/);
  assert.match(agy.prompt, /turn create --plan-file/);
  const expert = task_files(f.config, { ...f.event, role: 'expert' }, 'token-for-test', {});
  assert.doesNotMatch(expert.prompt, /--plan-file/);
  assert.equal(task.skills_directory, join(f.config.project, '.agents', 'skills'));
});

test('CLI failure results pause immediately even when the process exits with code zero', async t => {
  for (const adapter of ['codex_cli', 'antigravity_cli']) {
    await t.test(adapter, async t => {
      const f = await fixture(t);
      f.config.participants.Codex = { adapter, executable: process.execPath };
      const events = cli_events(adapter).slice(0, 1);
      events.push(adapter === 'codex_cli' ? { type: 'turn.failed', error: { message: 'quota exceeded' } }
        : { event: 'result', result: { status: 'WAITING', response: 'permission required' } });
      const process_fixture = fake_cli(events);
      const runner = new DiscussionRunner(f.config, f.store,
        (config, binding, task) => deliver_task(config, binding, task, process_fixture.spawn_process, join(f.config.directory, 'user')));
      await runner.tick(); await process_fixture.calls[0].closed; await runner.tick();
      assert.equal(f.event.status, 'failed'); assert.equal(f.run.status, 'paused');
      assert.match(f.event.result, /quota exceeded|permission required/);
      assert.equal(process_fixture.calls.length, 1);
    });
  }
});

test('headless CLI configuration does not require App threads or Sidecar directories', t => {
  const directory = mkdtempSync(join(tmpdir(), 'discussion-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'config.json');
  const config = { site: 'http://localhost:8765', room: 'room', token: 'x'.repeat(32),
    participants: { Codex: { adapter: 'codex_cli', executable: process.execPath },
      Gemini: { adapter: 'antigravity_cli', executable: process.execPath } } };
  writeFileSync(path, JSON.stringify(config));
  assert.equal(load_config(path).participants.Codex.adapter, 'codex_cli');
  config.participants.Codex.adapter = 'codex'; writeFileSync(path, JSON.stringify(config));
  assert.throws(() => load_config(path), /来源聊天 ID/);
  config.participants.Codex.adapter = 'codex_cli'; config.participants.Gemini.adapter = 'antigravity';
  writeFileSync(path, JSON.stringify(config)); assert.throws(() => load_config(path), /Sidecar IPC/);
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
  mkdirSync(join(directory, 'other')); mkdirSync(join(directory, 'runner')); writeFileSync(join(directory, 'runner', 'discuss.py'), '');
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

test('an unlimited Sidecar run delivers once after checking the current event and generation', async t => {
  const f = await fixture(t);
  f.event.status = 'dispatched'; f.run.deadline = 0;
  const access_path = join(f.config.directory, 'access.json');
  writeFileSync(access_path, JSON.stringify({ site: f.config.site, room: f.config.room, token: 'x'.repeat(32) }));
  writeFileSync(join(f.config.directory, 'event-1.request.json'), JSON.stringify({ id: 'event-1', event_id: 1, access_path, prompt: 'test' }));
  let calls = 0;
  const source = readFileSync(new URL('../runner/discussion_sidecar.mjs', import.meta.url), 'utf8')
    .replace(/^import .+;\r?$/gm, '').split("\natomic_json(join(directory, 'ready.json')")[0];
  const context = vm.createContext({ process: { env: { CODISCUSS_IPC_DIRECTORY: f.config.directory, ANTIGRAVITY_AGENTAPI_EXE: 'test' } },
    resolve, join, existsSync, readFileSync, writeFileSync, fetch, AbortSignal,
    execFileSync: () => { calls++; return JSON.stringify({ response: { newConversation: { conversationId: 'test-session' } } }); },
    atomic_json: (path, value) => writeFileSync(path, JSON.stringify(value)),
  });
  await vm.runInContext(`${source}\nprocess_request('event-1.request.json')`, context);
  assert.equal(JSON.parse(readFileSync(join(f.config.directory, 'event-1.result.json'), 'utf8')).status, 'accepted');
  await vm.runInContext("process_request('event-1.request.json')", context);
  assert.equal(calls, 1);
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
  assert.ok(existsSync(join(config.project, 'runner', 'discuss.py')));
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
  const first_worker = service.workers.get(first);
  const second_worker = service.workers.get(second);
  assert.equal(first_worker.config.draft_directory, service_drafts(home, first_worker.config.directory));
  assert.ok(first_worker.config.draft_directory.startsWith(join(home, 'drafts')));
  assert.notEqual(first_worker.config.draft_directory, second_worker.config.draft_directory);
  assert.equal(JSON.parse(readFileSync(first, 'utf8')).draft_directory, undefined, 'old configs need no on-disk migration');
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

test('a room deleted on the website is unregistered, while a missing route alone is only reported', async t => {
  const server = createServer((request, response) => {
    response.statusCode = 404;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ error: request.url === '/api/rooms/gone' ? '房间不存在' : '地址不存在' }));
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const site = `http://127.0.0.1:${server.address().port}`;
  const home = mkdtempSync(join(tmpdir(), 'discussion-service-'));
  const gone = room_config(home, site, 'gone'), kept = room_config(home, site, 'kept');
  register_room(home, gone); register_room(home, kept);
  const service = new DiscussionService(home, () => ({ stop_children() {}, tick: async () => { throw new Error('HTTP 404: 地址不存在'); } }));
  t.after(async () => { await service.close(); await new Promise(done => server.close(done)); rmSync(home, { recursive: true, force: true }); });
  await service.tick();
  assert.deepEqual(read_registry(home), [kept]);
  assert.ok(!existsSync(join(home, 'data-gone', 'runner.lock')), 'the deleted room releases its data-directory lock');
  const rooms = JSON.parse(readFileSync(join(home, 'status.json'), 'utf8')).rooms;
  assert.deepEqual(rooms.map(room => [room.room, room.status]), [['kept', 'error']]);
});

test('a resident worker adopts connection corrections but rejects changes to its bound conversation context', async t => {
  const f = await fixture(t);
  const home = mkdtempSync(join(tmpdir(), 'discussion-service-'));
  const path = room_config(home, f.config.site, 'room1');
  register_room(home, path);
  const service = new DiscussionService(home, (config, store) => {
    store.context(config); store.bind('Gemini', 'existing-session');
    return { tick: async () => 'waiting', stop_children() {} };
  });
  t.after(async () => { await service.close(); rmSync(home, { recursive: true, force: true }); });
  await service.tick();
  const worker = service.workers.get(path);
  const previous_version = worker.state.config_version;
  const config = JSON.parse(readFileSync(path, 'utf8'));
  const connection = join(home, 'new-sidecar'); mkdirSync(connection);
  config.participants.Gemini.ipc_directory = connection;
  writeFileSync(path, JSON.stringify(config));
  await service.tick();
  assert.equal(worker.config.participants.Gemini.ipc_directory, connection);
  assert.notEqual(worker.state.config_version, previous_version);
  assert.equal(worker.store.binding('Gemini').session_id, 'existing-session');
  config.participants.Gemini.session_id = 'another-session';
  writeFileSync(path, JSON.stringify(config));
  await service.tick();
  assert.equal(worker.state.status, 'error');
  assert.match(worker.state.error, /身份配置发生变化/);
  assert.equal(worker.store.binding('Gemini').session_id, 'existing-session');
  assert.equal(worker.config.participants.Gemini.session_id, undefined);
});

test('Codex context switch is restricted to the original session and project', async t => {
  const f = await fixture(t);
  const original = { participants: { Codex: { adapter: 'codex_cli', cwd: f.config.directory } } };
  f.store.context(original);
  f.store.bind('Codex', 'original-session');
  const switched = { participants: { Codex: { ...original.participants.Codex, adapter: 'codex', session_id: 'original-session' } } };
  assert.throws(() => f.store.context(switched), /身份配置发生变化/);
  assert.throws(() => f.store.context({ participants: { Codex: { ...switched.participants.Codex, session_id: 'other-session' } } }, true), /身份配置发生变化/);
  assert.throws(() => f.store.context({ participants: { Codex: { ...switched.participants.Codex, cwd: tmpdir() } } }, true), /身份配置发生变化/);
  f.store.context(switched, true);
  f.store.context(switched);
  assert.equal(f.store.binding('Codex').session_id, 'original-session');
});

test('Codex worker waits for its old process to exit before adopting a paused switch', async t => {
  let service;
  t.after(() => service?.close());
  const f = await fixture(t);
  const home = join(f.config.directory, 'service');
  mkdirSync(home);
  const path = join(home, 'config.json');
  const config = { ...f.config, token: 'x'.repeat(32), project: undefined, data_directory: join(home, 'runtime'),
    participants: { Codex: { adapter: 'codex_cli', executable: process.execPath, session_id: 'original-session' } } };
  writeFileSync(path, JSON.stringify(config));
  register_room(home, path);
  const child = { kill() {} }, children = new Set([child]);
  service = new DiscussionService(home, (current, store) => {
    store.context(current);
    return { children, stop_children() {}, tick: async () => f.run.status === 'paused' ? 'waiting' : undefined };
  });
  await service.tick();
  config.participants.Codex.adapter = 'codex';
  writeFileSync(path, JSON.stringify(config));
  await service.tick();
  const worker = service.workers.get(path);
  assert.equal(worker.config.participants.Codex.adapter, 'codex_cli', 'running rooms cannot adopt a switch');
  f.run.status = 'paused';
  await service.tick();
  assert.match(worker.state.error, /等待原 CLI 进程退出/);
  assert.equal(worker.config.participants.Codex.adapter, 'codex_cli');
  children.clear();
  await service.tick();
  assert.equal(worker.config.participants.Codex.adapter, 'codex');
  assert.equal(worker.state.status, 'paused');
});

test('the same site and room cannot be registered twice', t => {
  const home = mkdtempSync(join(tmpdir(), 'discussion-service-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  register_room(home, room_config(home, 'http://127.0.0.1:8765', 'room1', 'a'));
  assert.throws(() => register_room(home, room_config(home, 'http://127.0.0.1:8765', 'room1', 'b')), /已由/);
});

test('invalid software in an existing configuration does not permit another owner for its room', t => {
  const home = mkdtempSync(join(tmpdir(), 'discussion-service-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const original = room_config(home, 'http://127.0.0.1:8765', 'room1', 'a');
  register_room(home, original);
  const config = JSON.parse(readFileSync(original, 'utf8'));
  config.participants = {};
  writeFileSync(original, JSON.stringify(config));
  assert.throws(() => register_room(home, room_config(home, 'http://127.0.0.1:8765', 'room1', 'b')), /已由/);
});

/** Widen overlapping registry writes in separate CLI processes without starting AI or a service. */
function concurrent_registration(home, config, gate, action = 'add') {
  const script = `import fs from 'node:fs'; import { join } from 'node:path';
    import { syncBuiltinESMExports } from 'node:module';
    const [home, config, gate, action] = process.argv.slice(1);
    const read = fs.readFileSync;
    const waiting = new Int32Array(new SharedArrayBuffer(4));
    fs.readFileSync = (...args) => {
      const value = read(...args);
      if (args[0] === join(home, 'rooms.json')) {
        if (action === 'crash') process.exit(37);
        Atomics.wait(waiting, 0, 0, 200);
      }
      return value;
    };
    syncBuiltinESMExports();
    const registry = await import(${JSON.stringify(new URL('../runner/discussion_service.mjs', import.meta.url).href)});
    process.stdout.write('ready');
    while (!fs.existsSync(gate)) Atomics.wait(waiting, 0, 0, 10);
    if (action === 'add') registry.register_room(home, config); else registry.unregister_room(home, config);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, home, config, gate, action], { windowsHide: true });
  let error = '';
  child.stderr.on('data', chunk => { error += chunk; });
  return { child, ready: once(child.stdout, 'data'), done: once(child, 'close').then(([code]) => assert.equal(code, action === 'crash' ? 37 : 0, error)) };
}

for (const action of ['add', 'remove']) test(`concurrent registry ${action} keeps the other process's room change`, async t => {
  const home = mkdtempSync(join(tmpdir(), 'discussion-registry-'));
  const gate = join(home, 'start');
  const first = room_config(home, 'http://127.0.0.1:8765', 'room1');
  const second = room_config(home, 'http://127.0.0.1:8765', 'room2');
  const third = room_config(home, 'http://127.0.0.1:8765', 'room3');
  register_room(home, first);
  const workers = [concurrent_registration(home, action === 'add' ? third : first, gate, action), concurrent_registration(home, second, gate)];
  t.after(() => { workers.forEach(worker => worker.child.kill()); rmSync(home, { recursive: true, force: true }); });
  await Promise.all(workers.map(worker => worker.ready));
  writeFileSync(gate, 'start');
  await Promise.all(workers.map(worker => worker.done));
  assert.deepEqual(read_registry(home).sort(), (action === 'add' ? [first, second, third] : [second]).sort());
  register_room(home, first);
  assert.ok(read_registry(home).includes(first), 'successful concurrent writes release their lock');
});

test('a registry writer exiting mid-update leaves existing rooms and releases the cross-process lock', async t => {
  const home = mkdtempSync(join(tmpdir(), 'discussion-registry-'));
  const gate = join(home, 'start');
  const first = room_config(home, 'http://127.0.0.1:8765', 'room1');
  const second = room_config(home, 'http://127.0.0.1:8765', 'room2');
  register_room(home, first);
  const worker = concurrent_registration(home, first, gate, 'crash');
  t.after(() => { worker.child.kill(); rmSync(home, { recursive: true, force: true }); });
  await worker.ready;
  writeFileSync(gate, 'start');
  await worker.done;
  assert.deepEqual(read_registry(home), [first]);
  register_room(home, second);
  assert.deepEqual(read_registry(home), [first, second]);
});

for (const [name, prefix] of [['discussion_service', []], ['codiscuss', []], ['codiscuss', ['service']]]) {
test(`${[name, ...prefix].join(' ')}: the detached service starts once, reports status and stops on request`, async t => {
  const home = mkdtempSync(join(tmpdir(), 'discussion-service-'));
  const script = fileURLToPath(new URL(`../runner/${name}.mjs`, import.meta.url));
  const env = { ...process.env, DISCUSS_SERVICE_HOME: home };
  const run = async (...args) => {
    const child = spawn(process.execPath, [script, ...prefix, ...args, ...(name === 'codiscuss' ? ['--json'] : [])], { env, cwd: tmpdir() });
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
}

/** Invoke the public CLI from outside the repository, capturing readable output. */
async function run_service_cli(env, ...args) {
  const script = fileURLToPath(new URL('../runner/codiscuss.mjs', import.meta.url));
  const child = spawn(process.execPath, [script, ...args], { env, cwd: tmpdir() });
  let output = ''; let error = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { error += chunk; });
  child.stdin.end();
  const [code] = await once(child, 'close');
  return { code, output, error };
}

test('simultaneous service starts share one process and only its creator reports ownership', async t => {
  const home = mkdtempSync(join(tmpdir(), 'discussion-start-'));
  const env = { ...process.env, DISCUSS_SERVICE_HOME: home };
  t.after(async () => { await run_service_cli(env, 'service', 'stop', '--json'); rmSync(home, { recursive: true, force: true }); });
  const results = await Promise.allSettled([start_service(home), start_service(home)]);
  assert(results.every(result => result.status === 'fulfilled'), JSON.stringify(results));
  assert.equal(new Set(results.map(result => result.value.pid)).size, 1);
  assert.equal(results.filter(result => result.value.started).length, 1);
  assert.equal(results[0].value.pid, service_pid(home));
  assert.equal(results[0].value.ready, true);
});

test('an existing process is reused only after its own readiness receipt arrives', async t => {
  const home = mkdtempSync(join(tmpdir(), 'discussion-ready-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  writeFileSync(join(home, 'runner.lock'), String(process.pid));
  writeFileSync(join(home, 'status.json'), JSON.stringify({ pid: process.pid + 1, updated_at: 1, rooms: [{ room: 'old-room' }] }));
  assert.equal(service_ready(home), false);
  let settled = false;
  const starting = start_service(home).then(result => { settled = true; return result; });
  await delay(250);
  assert.equal(settled, false, 'an alive PID and stale status must not mean ready');
  writeFileSync(join(home, 'status.json'), JSON.stringify({ pid: process.pid, updated_at: 1, ready: true }));
  const ready = await starting;
  assert.equal(ready.pid, process.pid);
  assert.equal(ready.started, false);
  assert.equal(ready.ready, true);
});

test('MSIX redirection fails before service startup or room creation and removes its probe', { skip: process.platform !== 'win32' }, async t => {
  const home = mkdtempSync(join(tmpdir(), 'discussion-msix-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  t.mock.method(realpathSync, 'native', path => join('C:\\Users\\example\\AppData\\Local\\Packages',
    'Example_123', 'LocalCache', 'Local', basename(path)));
  const redirected = /MSIX.*普通终端.*DISCUSS_SERVICE_HOME/;
  assert.throws(() => assert_shared_home(home), redirected);
  await assert.rejects(start_service(home), redirected);
  await assert.rejects(launch_discussion(home, {}), redirected);
  assert.deepEqual(readdirSync(home), [], 'no lock, launch record, or probe may remain');
});

test('service directory checks preserve absent homes and allow an explicit physical recovery path', () => {
  const home = mkdtempSync(join(tmpdir(), 'discussion-path-'));
  try {
    const absent = join(home, 'not-created', 'service');
    assert_shared_home(absent);
    assert.deepEqual(readdirSync(home), []);
    const physical = join(home, 'AppData', 'Local', 'Packages', 'Example_123', 'LocalCache', 'Local', 'service');
    mkdirSync(physical, { recursive: true });
    assert_shared_home(physical);
    assert.deepEqual(readdirSync(physical), []);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('CLI help and status do not start a service; unknown commands fail', async t => {
  const home = mkdtempSync(join(tmpdir(), 'discussion-cli-'));
  const env = { ...process.env, DISCUSS_SERVICE_HOME: home };
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const help = await run_service_cli(env, '--help');
  assert.equal(help.code, 0); assert.match(help.output, /Ctrl\+C/);
  assert.equal(existsSync(join(home, 'runner.lock')), false);
  const status = await run_service_cli(env, 'status');
  assert.equal(status.code, 0); assert.match(status.output, /讨论服务未运行/);
  const invalid = await run_service_cli(env, 'unknown');
  assert.equal(invalid.code, 2); assert.equal(invalid.output, '');
  assert.match(JSON.parse(invalid.error).error.hint, /codiscuss --help/);
  assert.equal(service_pid(home), 0);
});

test('unified help separates website run controls from the resident service', async t => {
  const home = mkdtempSync(join(tmpdir(), 'discussion-cli-'));
  const env = { ...process.env, DISCUSS_SERVICE_HOME: home, DISCUSS_URL: '' };
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const service_help = await run_service_cli(env, 'service', '--help');
  assert.equal(service_help.code, 0); assert.match(service_help.output, /codiscuss service/);
  const room_help = await run_service_cli(env, 'room', '--help');
  assert.equal(room_help.code, 0); assert.match(room_help.output, /codiscuss room/);
  const run_help = await run_service_cli(env, 'run', '--help');
  assert.equal(run_help.code, 0); assert.match(run_help.output, /codiscuss run/);
  const setup_help = await run_service_cli(env, 'setup', '--help');
  assert.equal(setup_help.code, 0); assert.match(setup_help.output, /--no-start/);
  assert.match(setup_help.output, /2=配置待处理/);
  assert.match(setup_help.output, /中文摘要写入 stderr；输出被重定向或加 --json 时结果 JSON 写入 stdout/);
  assert.match(setup_help.output, /codex,claude,antigravity,cursor/);
  assert.match(setup_help.output, /Cursor 当前只安装技能/);
  const local_help = await run_service_cli(env, 'local', '--help');
  assert.equal(local_help.code, 0); assert.match(local_help.output, /codiscuss local/);
  assert.match(local_help.output, /connect SITE/);
  assert.match(local_help.output, /disconnect SITE/);
  assert.equal(existsSync(join(home, 'local')), false);
  const schema = await run_service_cli(env, 'schema', 'message', 'post');
  assert.equal(schema.code, 0); assert.equal(JSON.parse(schema.output).ok, true);
  assert.equal(schema.error, ''); assert.equal(service_pid(home), 0);
});

test('website commands preserve global flags and return clean JSON without starting the service', async t => {
  const home = mkdtempSync(join(tmpdir(), 'discussion-cli-'));
  const paths = [];
  const server = createServer((request, response) => {
    paths.push(request.url);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(request.url === '/api/health' ? { ok: true } : { mode: 'automatic', status: 'paused' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const site = `http://127.0.0.1:${server.address().port}`;
  const env = { ...process.env, DISCUSS_SERVICE_HOME: home, DISCUSS_URL: site };
  t.after(async () => { await new Promise(resolve => server.close(resolve)); rmSync(home, { recursive: true, force: true }); });
  const health = await run_service_cli(env, '--site', site, 'health');
  assert.equal(health.code, 0); assert.equal(health.error, '');
  assert.equal(JSON.parse(health.output).data.ok, true);
  const runtime = await run_service_cli(env, 'run', 'view', 'room');
  assert.equal(runtime.code, 0); assert.equal(runtime.error, '');
  assert.equal(JSON.parse(runtime.output).data.status, 'paused');
  assert.deepEqual(paths, ['/api/health', '/api/rooms/room/runtime']);
  assert.equal(existsSync(join(home, 'runner.lock')), false);
});

test('unified message submission preserves UTF-8 stdin, quoted arguments and caller-relative files', async t => {
  const home = mkdtempSync(join(tmpdir(), 'discussion-cli-'));
  const env = { ...process.env, DISCUSS_SERVICE_HOME: home, DISCUSS_URL: '' };
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const script = fileURLToPath(new URL('../runner/codiscuss.mjs', import.meta.url));
  const body = '完整中文正文\n含 "引号" 与 $字面量';
  const args = ['message', 'post', 'room', '--as', 'Claude', '--turn', '1', '--summary', '中文 简述',
    '--submission-id', 'unified-preview', '--site', 'http://127.0.0.1:1', '--dry-run'];
  const child = spawn(process.execPath, [script, ...args, '--body-file', '-'], { env, cwd: tmpdir() });
  let output = ''; let error = '';
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { error += chunk; });
  child.stdin.end(body);
  const [code] = await once(child, 'close');
  assert.equal(code, 0, error); assert.equal(error, '');
  const preview = JSON.parse(output);
  assert.equal(preview.data.body.text, body); assert.equal(preview.data.body.summary, '中文 简述');
  const file = join(home, '中文 正文.txt'); writeFileSync(file, body);
  const from_file = await run_service_cli(env, ...args, '--body-file', relative(tmpdir(), file));
  assert.equal(from_file.code, 0, from_file.error); assert.equal(from_file.error, '');
  assert.equal(JSON.parse(from_file.output).data.body.text, body);
  assert.equal(service_pid(home), 0);
});

test('a website write with a lost response keeps exit code 3 and is never retried by the unified CLI', async t => {
  const home = mkdtempSync(join(tmpdir(), 'discussion-cli-'));
  const env = { ...process.env, DISCUSS_SERVICE_HOME: home };
  let writes = 0;
  const server = createServer(async (request) => {
    for await (const chunk of request) { void chunk; }
    writes++;
    request.socket.destroy();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); rmSync(home, { recursive: true, force: true }); });
  const result = await run_service_cli(env, 'api', '/api/rooms', '--method', 'POST', '--input', '-',
    '--site', `http://127.0.0.1:${server.address().port}`);
  assert.equal(result.code, 2, 'missing stdin is rejected before sending');
  assert.equal(writes, 0);
  const file = join(home, 'request.json'); writeFileSync(file, JSON.stringify({ title: '测试', submission_id: 'unified-write' }));
  writeFileSync(join(home, 'owner.json'), JSON.stringify({ site: `http://127.0.0.1:${server.address().port}`,
    room: '', submission_id: 'unified-write', token: randomUUID() }));
  const uncertain = await run_service_cli(env, 'api', '/api/rooms', '--method', 'POST', '--input', file,
    '--site', `http://127.0.0.1:${server.address().port}`, '--access-file', join(home, 'owner.json'));
  assert.equal(uncertain.code, 3); assert.equal(uncertain.output, '');
  assert.equal(JSON.parse(uncertain.error).error.outcome, 'unknown');
  assert.equal(writes, 1); assert.equal(service_pid(home), 0);
});

test('the default CLI runs visibly, reports room state and can be stopped from another terminal', async t => {
  const f = await fixture(t);
  f.run.status = 'paused';
  const home = mkdtempSync(join(tmpdir(), 'discussion-cli-'));
  const env = { ...process.env, DISCUSS_SERVICE_HOME: home };
  const config = room_config(home, f.config.site, 'room1');
  const added = await run_service_cli(env, 'add', '--config', config);
  assert.equal(added.code, 0); assert.match(added.output, /已登记房间/);
  writeFileSync(join(home, 'stop.request'), 'stale request');
  const script = fileURLToPath(new URL('../runner/codiscuss.mjs', import.meta.url));
  const child = spawn(process.execPath, [script], { env, cwd: tmpdir() });
  const closed = once(child, 'close');
  let output = ''; child.stdout.on('data', chunk => { output += chunk; });
  try {
    for (let attempt = 0; attempt < 200 && !output.includes('已暂停'); attempt++) await delay(25);
    assert.match(output, /讨论服务已启动/); assert.match(output, /Ctrl\+C/);
    assert.match(output, /room1: 已暂停/);
    assert.equal(service_pid(home), child.pid);
    const duplicate = await run_service_cli(env);
    assert.equal(duplicate.code, 0); assert.match(duplicate.output, new RegExp(`PID ${child.pid}`));
    const status = await run_service_cli(env, 'status');
    assert.match(status.output, /运行中/); assert.match(status.output, /room1：已暂停/);
  } finally {
    if (service_pid(home)) await run_service_cli(env, 'stop');
    else if (child.exitCode === null) child.kill();
    await closed;
    assert.equal(service_pid(home), 0);
    rmSync(home, { recursive: true, force: true });
  }
  assert.match(output, /讨论服务已停止/);
  assert.deepEqual(f.calls, [], 'starting the service never starts a paused discussion');
});

test('the foreground service releases its lock when interrupted', async t => {
  const home = mkdtempSync(join(tmpdir(), 'discussion-cli-'));
  const env = { ...process.env, DISCUSS_SERVICE_HOME: home };
  const script = new URL('../runner/codiscuss.mjs', import.meta.url).href;
  const source = `setTimeout(() => process.emit('SIGINT'), 500); await import(${JSON.stringify(script)});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { env, cwd: tmpdir() });
  let output = ''; child.stdout.on('data', chunk => { output += chunk; });
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const [code] = await once(child, 'close');
  assert.equal(code, 0); assert.match(output, /尚未登记房间/);
  assert.match(output, /讨论服务已启动/); assert.match(output, /讨论服务已停止/);
  assert.equal(existsSync(join(home, 'runner.lock')), false);
});

test('a Claude CLI launched from a hosting Claude session drops host variables and keeps its own login', () => {
  const host = { CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'claude-desktop', CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH: '1', PATH: 'bin' };
  const env = standalone_claude_env(host, () => ({ CLAUDE_CODE_OAUTH_TOKEN: 'persisted' }));
  assert.deepEqual(env, { PATH: 'bin', CLAUDE_CODE_OAUTH_TOKEN: 'persisted' });
  const plain = { PATH: 'bin', CLAUDE_CODE_OAUTH_TOKEN: 'own' };
  assert.equal(standalone_claude_env(plain, () => { throw new Error('not read'); }), plain);
});

/** A minimal free-room website: one member, durable executions keyed by client id. */
async function free_fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'free-room-test-'));
  // `pending` belongs to Claude (id 7); `others` adds members with their own queues.
  const state = { pending: [{ id: 1, message_id: 11 }, { id: 2, message_id: 12 }], others: [], executions: [], calls: [], archived: false, reports: {} };
  const server = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk;
    const body = text ? JSON.parse(text) : null;
    const url = request.url.replace('/api/rooms/room', '');
    let result;
    state.calls.push(`${request.method} ${url}${body?.action ? ` ${body.action}` : ''}`);
    if (url === '/inbox') {
      result = { archived: state.archived, execution_minutes: 20,
        members: [{ id: 7, name: 'Claude', role: state.claude_role || 'member', pending: state.pending }, ...state.others],
        executions: state.executions.filter(item => ['dispatched', 'started'].includes(item.status)) };
    } else if (url === '/executions') {
      let execution = state.executions.find(item => item.client_id === body.client_id);
      if (!execution) {
        const other = state.others.find(item => item.id === body.member_id);
        const queue = other ? other.pending : state.pending;
        execution = { id: state.executions.length + 1, client_id: body.client_id, status: 'dispatched', member: other?.name || 'Claude',
          cwd: body.cwd, created_at: Math.floor(Date.now() / 1000), lease_until: Math.floor(Date.now() / 1000) + 120,
          read_until: 10, requests: queue.map(item => ({ ...item, status: 'delivering' })) };
        state.executions.push(execution);
        if (other) other.pending = []; else state.pending = [];
      }
      result = execution;
    } else if (url.startsWith('/executions/')) {
      const execution = state.executions.find(item => item.id === Number(url.split('/')[2]));
      if (body?.action === 'fail') execution.status = 'failed';
      if (body?.action === 'release') { execution.status = 'cancelled'; state.pending = execution.requests; }
      if (body?.action === 'report') state.reports[execution.id] = body.changes;
      result = execution;
    } else result = { title: '自由单聊', mode: 'free' };
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(result));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const store = new DiscussionStore(directory);
  t.after(async () => { store.close(); await new Promise(resolve => server.close(resolve));
    rmSync(directory, { recursive: true, force: true }); rmSync(`${directory}-drafts`, { recursive: true, force: true }); });
  const config = { site: `http://127.0.0.1:${server.address().port}`, room: 'room', token: 'owner-credential'.repeat(3), mode: 'free',
    directory, project: directory, participants: { Claude: { adapter: 'claude' } }, members: { Claude: { token: 'member-credential'.repeat(3) } } };
  return { state, store, config };
}

for (const outcome of ['accepted', 'cancelled', 'expired']) test(`free Sidecar delivery checks executions and reconciles ${outcome} without resending`, async t => {
  const { state, store, config } = await free_fixture(t);
  config.participants.Claude = { adapter: 'antigravity', ipc_directory: config.directory };
  writeFileSync(join(config.directory, 'ready.json'), JSON.stringify({ pid: process.pid }));
  const runner = new FreeRoomRunner(config, store);
  await runner.tick();
  const request = JSON.parse(readFileSync(join(config.directory, 'free-1.request.json'), 'utf8'));
  assert.equal(request.mode, 'free'); assert.equal(request.event_id, 1);
  if (outcome === 'cancelled') state.executions[0].status = 'cancelled';
  if (outcome === 'expired') state.executions[0].lease_until = 1;
  let invoked = 0;
  const source = readFileSync(new URL('../runner/discussion_sidecar.mjs', import.meta.url), 'utf8')
    .replace(/^import .+;\r?$/gm, '').split("\natomic_json(join(directory, 'ready.json')")[0];
  const context = vm.createContext({ process: { env: { CODISCUSS_IPC_DIRECTORY: config.directory, ANTIGRAVITY_AGENTAPI_EXE: 'test' } },
    resolve, join, existsSync, readFileSync, writeFileSync, fetch, AbortSignal,
    execFileSync: () => { invoked++; return JSON.stringify({ response: { newConversation: { conversationId: 'free-session' } } }); },
    atomic_json: (path, value) => writeFileSync(path, JSON.stringify(value)),
  });
  await vm.runInContext(`${source}\nprocess_request('free-1.request.json')`, context);
  await vm.runInContext("process_request('free-1.request.json')", context);
  assert.equal(invoked, outcome === 'accepted' ? 1 : 0);
  assert.ok(state.calls.includes('GET /executions/1'));
  assert.ok(!state.calls.some(call => call.includes('/runtime') || call.includes('/events')));
  if (outcome === 'accepted') state.executions[0].status = 'completed'; // Fast answers can beat reconciliation.
  await runner.tick(); await runner.tick();
  assert.equal(state.executions.length, 1);
  assert.equal(store.binding('Claude').session_id || '', outcome === 'accepted' ? 'free-session' : '');
});

test('a free room delivers all open requests as one execution with the member credential only', async t => {
  const { state, store, config } = await free_fixture(t);
  const delivered = [];
  const runner = new FreeRoomRunner(config, store, async (adapter, binding, task) => { delivered.push(task); return { session_id: 'claude-session', status: 'accepted' }; });
  await runner.tick();
  await runner.tick();
  assert.equal(delivered.length, 1);
  assert.equal(state.executions.length, 1);
  const task = JSON.parse(readFileSync(join(config.directory, 'free-1.task.json'), 'utf8'));
  assert.deepEqual(task.request_messages, [11, 12]);
  assert.equal(task.read_after, 10);
  assert.match(delivered[0].prompt, /--execution 1/);
  const access = JSON.parse(readFileSync(delivered[0].access_path, 'utf8'));
  assert.equal(access.token, config.members.Claude.token);
  assert.doesNotMatch(readFileSync(delivered[0].access_path, 'utf8') + readFileSync(join(config.directory, 'free-1.task.json'), 'utf8'), /owner-credential/);
  assert.equal(store.binding('Claude').session_id, 'claude-session');
});

test('a free member that exits without answering fails only its own execution', async t => {
  const { state, store, config } = await free_fixture(t);
  const runner = new FreeRoomRunner(config, store, async (adapter, binding, task) => { setImmediate(() => task.on_exit()); return { status: 'accepted' }; });
  await runner.tick();
  await runner.tick();
  assert.equal(state.executions[0].status, 'failed');
  assert.ok(state.calls.includes('POST /executions/1 fail'));
});

test('an interrupted free execution stops only that member and is not redelivered', async t => {
  const { state, store, config } = await free_fixture(t);
  const child = Object.assign(new EventEmitter(), { killed: false, kill() { this.killed = true; this.emit('close'); } });
  const runner = new FreeRoomRunner(config, store, async (adapter, binding, task) => { task.on_process(child); return { status: 'accepted' }; });
  await runner.tick();
  state.executions[0].status = 'cancelled';
  await runner.tick();
  assert.equal(child.killed, true);
  assert.equal(state.executions.length, 1);
});

test('proven non-delivery is released and retried, then fails after three attempts', async t => {
  const { state, store, config } = await free_fixture(t);
  const runner = new FreeRoomRunner(config, store, async () => { throw Object.assign(new Error('未启动'), { delivery_status: 'not_sent' }); });
  for (let index = 0; index < 3; index++) await runner.tick();
  assert.deepEqual(state.executions.map(item => item.status), ['cancelled', 'cancelled', 'failed']);
});

test('a restart between persisting and invoking never resends the free task', async t => {
  const { state, store, config } = await free_fixture(t);
  let calls = 0;
  const first = new FreeRoomRunner(config, store, async () => { calls++; return { status: 'accepted' }; });
  await first.tick();
  first.save('Claude', { status: 'delivering' });
  await new FreeRoomRunner(config, store, async () => { calls++; return { status: 'accepted' }; }).tick();
  assert.equal(calls, 1);
  assert.equal(state.executions[0].status, 'failed');
});

test('free room configurations require a member credential for every participant', t => {
  const directory = mkdtempSync(join(tmpdir(), 'free-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const config = { site: 'http://127.0.0.1:8765', room: 'room', token: 'owner-credential'.repeat(3), mode: 'free',
    participants: { Claude: { adapter: 'claude', executable: process.execPath } } };
  assert.throws(() => validate_config(config, directory), /成员凭证/);
  assert.equal(validate_config({ ...config, members: { Claude: { token: 'member-credential'.repeat(3) } } }, directory).mode, 'free');
});

test('a stopped free process reporting late cannot fail the next execution', async t => {
  const { state, store, config } = await free_fixture(t);
  const tasks = [];
  const runner = new FreeRoomRunner(config, store, async (adapter, binding, task) => { tasks.push(task); return { status: 'accepted' }; });
  await runner.tick();
  state.executions[0].status = 'cancelled';
  await runner.tick();
  state.pending = [{ id: 3, message_id: 13 }];
  await runner.tick();
  assert.equal(tasks.length, 2);
  tasks[0].on_failure('Claude 退出码 null');
  tasks[0].on_exit();
  await runner.tick();
  assert.equal(state.executions[1].status, 'dispatched');
  assert.ok(!state.calls.includes('POST /executions/2 fail'));
});

test('two free members are delivered in parallel, each with its own credential', async t => {
  const { state, store, config } = await free_fixture(t);
  config.participants.Codex = { adapter: 'codex_cli' };
  config.members.Codex = { token: 'codex-credential'.repeat(3) };
  state.others.push({ id: 8, name: 'Codex', pending: [{ id: 3, message_id: 11 }] });
  const tasks = [];
  const runner = new FreeRoomRunner(config, store, async (adapter, binding, task) => { tasks.push(task); return { status: 'accepted' }; });
  await runner.tick();
  assert.deepEqual(tasks.map(task => task.participant), ['Claude', 'Codex']);
  assert.deepEqual(state.executions.map(item => [item.member, item.status]), [['Claude', 'dispatched'], ['Codex', 'dispatched']]);
  assert.equal(JSON.parse(readFileSync(tasks[1].access_path, 'utf8')).token, config.members.Codex.token);
});

test('a free member that left is stopped while the other keeps working', async t => {
  const { state, store, config } = await free_fixture(t);
  config.participants.Codex = { adapter: 'codex_cli' };
  config.members.Codex = { token: 'codex-credential'.repeat(3) };
  state.others.push({ id: 8, name: 'Codex', pending: [{ id: 3, message_id: 11 }] });
  const children = {};
  const runner = new FreeRoomRunner(config, store, async (adapter, binding, task) => {
    children[task.participant] = Object.assign(new EventEmitter(), { killed: false, kill() { this.killed = true; this.emit('close'); } });
    task.on_process(children[task.participant]);
    return { status: 'accepted' };
  });
  await runner.tick();
  state.others = [];
  state.executions[1].status = 'cancelled';
  await runner.tick();
  assert.equal(children.Codex.killed, true);
  assert.equal(children.Claude.killed, false);
  assert.equal(runner.row('Codex').status, 'idle');
});

test('a member whose bound context changes is blocked while new members are adopted', async t => {
  const { state, store, config } = await free_fixture(t);
  config.participants.Claude.cwd = config.directory;
  const runner = new FreeRoomRunner(config, store, async () => ({ status: 'accepted' }));
  runner.adopt({ ...config, participants: { Claude: { adapter: 'claude', cwd: tmpdir() }, Codex: { adapter: 'codex_cli' } },
    members: { ...config.members, Codex: { token: 'codex-credential'.repeat(3) } } });
  assert.ok(runner.config.participants.Codex);
  await runner.tick();
  assert.equal(state.executions[0].status, 'failed');
  assert.match(runner.row('Claude').error, /发生变化/);
});

test('changed files in a Git working tree are reported after the member exits', async t => {
  const { state, store, config } = await free_fixture(t);
  const project = mkdtempSync(join(tmpdir(), 'free-git-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const git = (...args) => spawnSync('git', ['-C', project, ...args], { encoding: 'utf8' });
  if (git('init').status !== 0) return t.skip('git unavailable');
  writeFileSync(join(project, 'index.html'), 'old');
  writeFileSync(join(project, 'keep.txt'), 'same');
  git('add', '.'); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init');
  config.participants.Claude.cwd = project;
  const child = Object.assign(new EventEmitter(), { kill() { this.emit('close'); } });
  const runner = new FreeRoomRunner(config, store, async (adapter, binding, task) => { task.on_process(child); return { status: 'accepted' }; });
  await runner.tick();
  assert.equal(state.executions[0].cwd, cwd_key(project));
  writeFileSync(join(project, 'index.html'), 'new');
  writeFileSync(join(project, 'added.css'), 'x');
  state.executions[0].status = 'completed';
  await runner.tick();
  assert.equal(state.reports[1], undefined, 'reporting waits for the process to exit');
  child.emit('close');
  await runner.tick();
  assert.deepEqual(state.reports[1], ['added.css', 'index.html']);
  state.executions.push({ ...state.executions[0], id: 2 });
  runner.snapshots.set(2, { member: 'Claude', directory: project, before: workspace_snapshot(project) });
  await runner.report_finished(new Set());
  assert.deepEqual(state.reports[2], [], 'a real unchanged Git snapshot is reported explicitly');
  runner.snapshots.set(3, { member: 'Claude', directory: config.directory, before: new Map() });
  await runner.report_finished(new Set());
  assert.equal(state.reports[3], undefined, 'non-Git or unavailable detection is not an empty report');
});

test('the host task explains routing and hand-backs; other members get no dispatch rule', async t => {
  const { state, store, config } = await free_fixture(t);
  state.claude_role = 'host';
  const tasks = [];
  const runner = new FreeRoomRunner(config, store, async (adapter, binding, task) => { tasks.push(task); return { status: 'accepted' }; });
  await runner.tick();
  const task = JSON.parse(readFileSync(join(config.directory, 'free-1.task.json'), 'utf8'));
  assert.equal(task.role, 'host');
  assert.match(task.instructions, /--to 成员名/);
  state.claude_role = 'member';
  state.executions[0].status = 'completed';
  await runner.tick();
  state.pending = [{ id: 9, message_id: 19 }];
  await runner.tick();
  assert.doesNotMatch(JSON.parse(readFileSync(join(config.directory, 'free-2.task.json'), 'utf8')).instructions, /--to 成员名/);
});

test('two instances of one platform keep separate sessions and credentials', async t => {
  const { state, store, config } = await free_fixture(t);
  config.participants['Claude-评审'] = { adapter: 'claude', model: 'opus' };
  config.members['Claude-评审'] = { token: 'reviewer-credential'.repeat(2) };
  state.others.push({ id: 8, name: 'Claude-评审', pending: [{ id: 3, message_id: 11 }] });
  const sessions = { Claude: 'session-main', 'Claude-评审': 'session-review' };
  const delivered = [];
  const runner = new FreeRoomRunner(config, store, async (adapter, binding, task) => {
    delivered.push([task.participant, adapter.model || '', binding.session_id || '']);
    return { status: 'accepted', session_id: sessions[task.participant] };
  });
  await runner.tick();
  assert.deepEqual(delivered, [['Claude', '', ''], ['Claude-评审', 'opus', '']]);
  assert.equal(store.binding('Claude').session_id, 'session-main');
  assert.equal(store.binding('Claude-评审').session_id, 'session-review');
  assert.equal(JSON.parse(readFileSync(join(config.directory, 'free-2.access.json'), 'utf8')).token, config.members['Claude-评审'].token);
});

test('the runner enters an auto-enter execution once even when the session is reported twice, and pauses after a failed enter', async t => {
  const f = await fixture(t);
  const config = { ...f.config, participants: { Codex: { adapter: 'antigravity_cli', executable: process.execPath } } };
  for (const failing of [false, true]) {
    f.event.status = 'pending'; f.calls.length = 0;
    if (failing) f.failures.enter = 'before';
    const runner = new DiscussionRunner(config, f.store, async (adapter, binding, task) => {
      task.on_binding('session-1'); task.on_binding('session-1');
      await new Promise(resolve => setTimeout(resolve, 100));
      return { session_id: 'session-1', status: 'accepted' };
    });
    const row = { id: 1, token: '', attempts: 0 };
    f.store.receive({ events: [f.event], next_after: 1 });
    await runner.dispatch(f.store.pending()[0], f.event);
    assert.equal(f.calls.filter(action => action === 'enter').length, 1);
    if (failing) {
      assert.match(f.store.pending()[0].error, /接入程序进入执行失败/);
      await runner.reconcile(f.store.pending()[0], f.event);
      assert.ok(f.calls.includes('fail'));
      assert.equal(f.event.status, 'failed');
      assert.equal(f.run.status, 'paused');
      f.run.status = 'running';
    }
    f.store.record(1, { status: 'pending', error: '' });
  }
});

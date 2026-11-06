// Private chat turns of a Codex CLI session held by the shared app-server daemon (`codex --remote unix://`), against a
// fake daemon that speaks the proxy's WebSocket framing; no real Codex runs.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { codex_cli } from '../runner/adapters/codex_cli.mjs';
import { execution_details } from '../runner/adapters/index.mjs';

const THREAD = '01a1b0eb-142a-7632-8a11-f4c0a9691c87';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/** One unmasked server text frame. */
function server_frame(text) {
  const payload = Buffer.from(text, 'utf8');
  const head = payload.length < 126 ? Buffer.from([0x81, payload.length])
    : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 255]);
  return Buffer.concat([head, payload]);
}

/** Masked client frames in a buffer → their texts, and what is left over. */
function read_client_frames(buffer) {
  const texts = [];
  while (buffer.length >= 2) {
    let length = buffer[1] & 0x7f, offset = 2;
    if (length === 126) { if (buffer.length < 4) break; length = buffer.readUInt16BE(2); offset = 4; }
    else if (length === 127) { if (buffer.length < 10) break; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
    assert.ok(buffer[1] & 0x80, 'client frames are masked');
    if (buffer.length < offset + 4 + length) break;
    const mask = buffer.subarray(offset, offset + 4);
    const data = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
    for (let index = 0; index < data.length; index++) data[index] ^= mask[index % 4];
    if ((buffer[0] & 0x0f) === 0x1) texts.push(data.toString('utf8'));
    buffer = buffer.subarray(offset + 4 + length);
  }
  return { texts, rest: buffer };
}

/** A child-process lookalike over in-memory streams. */
function fake_child() {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.exitCode = null;
  child.kill = () => { if (child.exitCode === null) { child.exitCode = 0; setImmediate(() => child.emit('close', 0)); } return true; };
  return child;
}

/**
 * A fake daemon: `daemon version` answers per `running`, `proxy` speaks WebSocket and JSON-RPC with `loaded` threads;
 * `on_turn(daemon, turn_id)` scripts the turn's notifications. Any other spawn is the usual delivery (the bridge).
 */
function fake_daemon({ running = true, loaded = [THREAD], on_turn = () => {}, turn_error = '' } = {}) {
  const daemon = { requests: [], spawns: [], deliveries: [], proxies: 0, closed: 0 };
  daemon.spawn_process = (executable, args, settings) => {
    daemon.spawns.push(args.join(' '));
    if (args.join(' ') === 'app-server daemon version') {
      const child = fake_child();
      setImmediate(() => {
        if (running) child.stdout.write(`${JSON.stringify({ cliVersion: '0.163.0', appServerVersion: '0.164.0' })}\n`);
        else child.stderr.write('Error: failed to connect\n');
        child.stdout.end(); child.exitCode = running ? 0 : 1; child.emit('close', child.exitCode);
      });
      return child;
    }
    if (args.join(' ') === 'app-server proxy') return proxy();
    // The usual delivery: the Codex bridge, which here prints one finished turn.
    const source = `require('node:readline').createInterface({ input: process.stdin }).once('line', line => {
      const task = JSON.parse(line);
      for (const event of [{ type: 'thread.started', thread_id: task.thread_id }, { type: 'item.completed', item: { id: '1', type: 'agent_message', text: 'bridge reply' } }, { type: 'turn.completed' }])
        process.stdout.write(JSON.stringify(event) + '\\n');
      process.exit(0);
    });`;
    const child = spawn(process.execPath, ['-e', source], settings);
    daemon.deliveries.push({ executable, args });
    return child;
  };
  const proxy = () => {
    daemon.proxies++;
    const child = fake_child();
    let buffer = Buffer.alloc(0), upgraded = false;
    const send = message => child.stdout.write(server_frame(JSON.stringify(message)));
    daemon.notify = (method, params) => send({ jsonrpc: '2.0', method, params: { threadId: THREAD, ...params } });
    const answer = message => {
      daemon.requests.push(message);
      const { id, method, params } = message;
      if (id === undefined) return;
      const reply = result => send({ jsonrpc: '2.0', id, result });
      if (method === 'initialize') reply({ userAgent: 'codex/0.164.0' });
      else if (method === 'thread/loaded/list') reply({ data: loaded, nextCursor: null });
      else if (method === 'thread/resume') reply({ thread: { id: params.threadId } });
      else if (method === 'turn/start') {
        if (turn_error) return send({ jsonrpc: '2.0', id, error: { message: turn_error } });
        reply({ turn: { id: 'turn-1', status: 'inProgress' } });
        setImmediate(() => on_turn(daemon, 'turn-1'));
      } else if (method === 'turn/steer') {
        reply({ turnId: params.expectedTurnId });
        setImmediate(() => daemon.notify('item/completed', { turnId: 'turn-1', item: { id: 'u2', type: 'userMessage', content: params.input } }));
      } else if (method === 'turn/interrupt') {
        reply({});
        setImmediate(() => daemon.notify('turn/completed', { turn: { id: params.turnId, status: 'interrupted' } }));
      } else send({ jsonrpc: '2.0', id, error: { message: `unknown ${method}` } });
    };
    child.stdin.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        assert.match(buffer.subarray(0, end).toString(), /^GET \/ HTTP\/1\.1[\s\S]*Upgrade: websocket/);
        buffer = buffer.subarray(end + 4);
        upgraded = true;
        child.stdout.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
      }
      const { texts, rest } = read_client_frames(buffer);
      buffer = rest;
      for (const text of texts) answer(JSON.parse(text));
    });
    child.once('close', () => { daemon.closed++; });
    return child;
  };
  daemon.methods = () => daemon.requests.map(request => request.method);
  return daemon;
}

/** A chat task whose callbacks record what the runner would see. */
function chat_task(t) {
  const directory = mkdtempSync(join(tmpdir(), 'codex-daemon-chat-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const access_path = join(directory, 'chat-5.access.json');
  writeFileSync(access_path, JSON.stringify({ session_id: THREAD }));
  const seen = { notes: [], logs: '', processes: [] };
  let settle;
  seen.ended = new Promise(resolve => { settle = resolve; });
  const task = { id: 'chat-5', participant: 'Codex', directory, draft_directory: directory, access_path, prompt: '私聊：先说结论', chat: true,
    on_note: text => seen.notes.push(text), on_output: (path, chunk) => { seen.log_path = path; seen.logs += chunk; },
    on_process: child => seen.processes.push(child), on_binding: () => {}, on_activity: () => {}, on_edits: () => {},
    on_exit: () => settle({}), on_failure: error => settle({ error }) };
  return { task, seen };
}

const config = { adapter: 'codex_cli', executable: 'codex.exe', project_access: 'full', model: 'gpt-x', effort: 'xhigh' };

test('codex_cli chat runs in the daemon thread, keeps its settings, and reports the last remark', async t => {
  const daemon = fake_daemon({ on_turn: (d, turn) => {
    d.notify('turn/started', { turn: { id: turn } });
    d.notify('item/started', { turnId: turn, item: { id: 'c1', type: 'commandExecution', command: 'Get-Date', status: 'inProgress' } });
    d.notify('item/completed', { turnId: turn, item: { id: 'c1', type: 'commandExecution', command: 'Get-Date', aggregatedOutput: 'today', exitCode: 0, status: 'completed' } });
    d.notify('item/completed', { turnId: turn, item: { id: 'm1', type: 'agentMessage', text: '先看一下' } });
    d.notify('item/completed', { turnId: turn, item: { id: 'm2', type: 'agentMessage', text: '结论：可以。' } });
    d.notify('turn/completed', { turn: { id: turn, status: 'completed' } });
  } });
  const { task, seen } = chat_task(t);
  const result = await codex_cli.chat(config, { session_id: THREAD }, task, daemon.spawn_process, task.directory);
  assert.deepEqual({ ...result, steer: typeof result.steer }, { session_id: THREAD, status: 'accepted', capabilities: { stoppable: true, progress: true }, steer: 'function' });
  assert.deepEqual(await seen.ended, {});
  assert.deepEqual(seen.notes, ['先看一下', '结论：可以。']);
  assert.equal(daemon.deliveries.length, 0, 'no separate process takes the thread');
  assert.ok(!daemon.spawns.some(args => /daemon (start|stop|restart)/.test(args)), 'the daemon is never started or stopped');
  const start = daemon.requests.find(request => request.method === 'turn/start').params;
  assert.deepEqual(start, { threadId: THREAD, input: [{ type: 'text', text: '私聊：先说结论' }] }, 'model and effort stay the session own');
  assert.deepEqual(daemon.requests.find(request => request.method === 'thread/resume').params, { threadId: THREAD, excludeTurns: true });
  assert.ok(daemon.methods().indexOf('thread/resume') < daemon.methods().indexOf('turn/start'));
  assert.match(seen.log_path, /codex_cli-chat-5\.log$/);
  const details = execution_details('codex_cli', seen.logs).entries.map(entry => [entry.kind, entry.title, entry.state]);
  assert.deepEqual(details, [['command', 'Get-Date', 'done'], ['message', undefined, undefined], ['message', undefined, undefined]]);
  await delay(10);
  assert.deepEqual([daemon.proxies, daemon.closed], [1, 1], 'the probe link runs the turn and is closed after it');
});

test('codex_cli chat passes an interjection into the daemon turn with turn/steer', async t => {
  const daemon = fake_daemon({ on_turn: (d, turn) => d.notify('turn/started', { turn: { id: turn } }) });
  const { task, seen } = chat_task(t);
  const result = await codex_cli.chat(config, { session_id: THREAD }, task, daemon.spawn_process, task.directory);
  assert.equal(await result.steer('只再跑一次'), true);
  const steer = daemon.requests.find(request => request.method === 'turn/steer').params;
  assert.deepEqual(steer, { threadId: THREAD, expectedTurnId: 'turn-1', input: [{ type: 'text', text: '只再跑一次' }] });
  assert.match(seen.logs, /"type":"codiscuss.interjection","text":"只再跑一次"/);
  daemon.notify('item/completed', { turnId: 'turn-1', item: { id: 'm1', type: 'agentMessage', text: '好的，已收尾' } });
  daemon.notify('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
  assert.deepEqual(await seen.ended, {});
  assert.deepEqual(seen.notes, ['好的，已收尾']);
  assert.equal(await result.steer('太晚了'), false, 'after the turn an interjection is refused');
});

test('codex_cli chat stops a daemon turn with turn/interrupt', async t => {
  const daemon = fake_daemon({ on_turn: (d, turn) => d.notify('turn/started', { turn: { id: turn } }) });
  const { task, seen } = chat_task(t);
  await codex_cli.chat(config, { session_id: THREAD }, task, daemon.spawn_process, task.directory);
  const [handle] = seen.processes;
  const closed = once(handle, 'close');
  assert.equal(handle.kill(), true);
  assert.deepEqual(await seen.ended, { error: '已停止' });
  await closed;
  assert.deepEqual(daemon.requests.find(request => request.method === 'turn/interrupt').params, { threadId: THREAD, turnId: 'turn-1' });
  assert.match(seen.logs, /"type":"turn.failed"/);
});

test('codex_cli chat reports a failed daemon turn and a refused start', async t => {
  const failing = fake_daemon({ on_turn: (d, turn) => d.notify('turn/completed', { turn: { id: turn, status: 'failed', error: { message: 'usage limit' } } }) });
  const first = chat_task(t);
  await codex_cli.chat(config, { session_id: THREAD }, first.task, failing.spawn_process, first.task.directory);
  assert.deepEqual(await first.seen.ended, { error: 'usage limit' });

  const refused = fake_daemon({ turn_error: 'thread is busy' });
  const second = chat_task(t);
  await assert.rejects(codex_cli.chat(config, { session_id: THREAD }, second.task, refused.spawn_process, second.task.directory), /thread is busy/);
});

test('codex_cli chat reports a dropped daemon connection as a failure', async t => {
  let proxy;
  const daemon = fake_daemon({ on_turn: () => {} });
  const spawn_process = (...args) => { const child = daemon.spawn_process(...args); if (args[1].join(' ') === 'app-server proxy') proxy = child; return child; };
  const { task, seen } = chat_task(t);
  await codex_cli.chat(config, { session_id: THREAD }, task, spawn_process, task.directory);
  proxy.exitCode = 1; proxy.emit('close', 1);
  assert.match((await seen.ended).error, /连接中断/);
});

for (const [name, options] of [['the daemon does not hold the thread', { loaded: ['other-thread'] }], ['the daemon is not running', { running: false }]]) {
  test(`codex_cli chat resumes through the usual delivery when ${name}`, async t => {
    const daemon = fake_daemon(options);
    const { task, seen } = chat_task(t);
    const result = await codex_cli.chat(config, { session_id: THREAD }, task, daemon.spawn_process, task.directory);
    assert.equal(result.status, 'accepted');
    assert.deepEqual(await seen.ended, {});
    assert.deepEqual(seen.notes, ['bridge reply']);
    assert.equal(daemon.deliveries.length, 1);
    assert.match(daemon.deliveries[0].args[0], /codex_bridge\.mjs$/);
    assert.equal(daemon.proxies, options.running === false ? 0 : 1, 'a stopped daemon is not even connected to');
    assert.ok(!daemon.methods().includes('turn/start') && !daemon.methods().includes('thread/resume'));
    assert.ok(!daemon.spawns.some(args => /daemon (start|stop|restart)/.test(args)));
    await delay(10);
    assert.equal(daemon.closed, daemon.proxies, 'the probe connection is closed');
    assert.equal(JSON.parse(readFileSync(task.access_path, 'utf8')).session_id, THREAD);
  });
}

// Private chat turns of a taken-over manual Claude member: into its open window through the inbox, or resumed in the
// background when no window holds the session; and how a window turn is followed through the session log.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { claude, watch_window_turn } from '../runner/adapters/claude.mjs';
import { deliver_task, execution_details } from '../runner/adapters/index.mjs';

const line = entry => `${JSON.stringify(entry)}\n`;
const turn_end = line({ type: 'system', subtype: 'turn_duration', durationMs: 2000 });
const text = body => line({ type: 'assistant', message: { content: [{ type: 'text', text: body }] } });

/** A Claude config folder whose registry says `session_id` is open in a window with an inbox at `socket` (or none). */
function claude_home(t, session_id, { socket = '', status = 'idle', waitingFor, pid = process.pid } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'claude-chat-'));
  const sessions = join(home, 'sessions'); mkdirSync(sessions);
  mkdirSync(join(home, 'projects', 'p'), { recursive: true });
  const log = join(home, 'projects', 'p', `${session_id}.jsonl`);
  writeFileSync(log, text('an earlier turn') + turn_end);
  if (pid) {
    writeFileSync(join(sessions, `${pid}.json`), JSON.stringify({ pid, sessionId: session_id, status, waitingFor, ...(socket && { messagingSocketPath: socket }) }));
    writeFileSync(join(sessions, `${pid}.${'a'.repeat(64)}.key`), JSON.stringify({ peerToken: 'peer-token' }));
  }
  const previous = process.env.CLAUDE_CONFIG_DIR; process.env.CLAUDE_CONFIG_DIR = home;
  t.after(() => { if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous; rmSync(home, { recursive: true, force: true }); });
  return { home, log, sessions };
}

/** A local inbox that records the lines each connection writes. */
async function inbox_server(t) {
  const socket = process.platform === 'win32' ? String.raw`\\.\pipe\codiscuss-chat-${randomUUID()}` : join(mkdtempSync(join(tmpdir(), 'inbox-')), 's');
  const received = [];
  const server = createServer(connection => { let data = ''; connection.on('data', chunk => { data += chunk; }); connection.on('end', () => received.push(data.trim().split('\n').map(item => JSON.parse(item)))); });
  await new Promise(resolve_listen => server.listen(socket, resolve_listen)); t.after(() => server.close());
  return { socket, received };
}

/** The callbacks a chat turn reports through, recording what they get. */
function chat_task(directory) {
  const seen = { notes: [], failures: [], exits: 0, output: '' };
  const task = { id: 'chat-12', chat: true, directory, draft_directory: directory, skill_directories: [], access_path: join(directory, 'access.json'),
    prompt: '房主在私聊窗口直接对你说。\n\n现在几点？', inbox: false,
    on_note: note => seen.notes.push(note), on_failure: reason => seen.failures.push(reason), on_exit: () => { seen.exits++; },
    on_output: (path, chunk) => { seen.output += chunk; appendFileSync(path, chunk); }, on_binding: () => {}, on_process: () => {}, on_denials: () => {} };
  writeFileSync(task.access_path, JSON.stringify({ token: 'member', session_id: '' }));
  return { task, seen };
}

const settled = async seen => { for (let waited = 0; !seen.exits && !seen.failures.length && waited < 8000; waited += 20) await delay(20); };
const own = session_id => ({ adapter: 'claude', executable: process.execPath, project_access: 'own', session_id });

test('a chat line to an open Claude window goes through its inbox and reports the turn read from the session log', async t => {
  const session_id = randomUUID();
  const inbox = await inbox_server(t);
  const { log } = claude_home(t, session_id, { socket: inbox.socket });
  const { task, seen } = chat_task(mkdtempSync(join(tmpdir(), 'chat-run-')));
  const spawned = [], processes = [];
  task.on_process = handle => processes.push(handle);
  // A console that cannot be reached leaves the turn unstoppable, and no stop handle is given.
  const result = await claude.chat(own(session_id), { session_id }, task, (...args) => { spawned.push(args); throw new Error('no process'); },
    undefined, { console: () => ({ ok: false, terminal: '', reason: 'AttachConsole 错误 5' }) });
  assert.deepEqual(spawned, [], 'no background process beside the open window');
  assert.equal(result.session_id, session_id);
  assert.deepEqual(result.capabilities, { stoppable: false, progress: true });
  assert.deepEqual(processes, []);
  for (let waited = 0; !inbox.received.length && waited < 2000; waited += 20) await delay(20);
  const [[auth, message]] = inbox.received;
  assert.deepEqual(auth, { type: 'auth', token: 'peer-token' });
  assert.match(message.message.content, /^\[codiscuss:chat-12\] .*房主（也就是你的用户）[\s\S]*现在几点？$/);
  appendFileSync(log, line({ type: 'user', message: { role: 'user', content: `Another Claude session sent a message: ${message.message.content}` } })
    + line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'date' } }] } })
    + line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: '12:00' }] } })
    + text('现在 12 点。') + turn_end);
  await settled(seen);
  assert.deepEqual(seen.failures, []);
  assert.equal(seen.exits, 1);
  assert.equal(seen.notes.at(-1), '现在 12 点。', 'the last remark is the reply');
  const detail = execution_details('claude', readFileSync(join(task.directory, 'claude-chat-12.log'), 'utf8'));
  assert.deepEqual(detail.entries.map(entry => [entry.kind, entry.title ?? entry.body, entry.state]),
    [['command', 'date', 'done'], ['message', '现在 12 点。', undefined]], 'the window turn shows as its steps');
});

test('a chat line to a Claude member whose window is closed resumes the session in the background', async t => {
  const session_id = randomUUID();
  claude_home(t, session_id, { pid: 0 });
  const { task, seen } = chat_task(mkdtempSync(join(tmpdir(), 'chat-run-')));
  const calls = [];
  const spawn_process = (executable, args) => {
    const child = new EventEmitter();
    Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, kill: () => true });
    calls.push(args);
    setImmediate(() => {
      child.emit('spawn');
      child.stdout.end(line({ type: 'assistant', message: { content: [{ type: 'text', text: '后台回答' }] } }) + line({ type: 'result', is_error: false, result: '后台回答' }));
      setImmediate(() => { child.exitCode = 0; child.emit('close', 0); });
    });
    return child;
  };
  const result = await deliver_task(own(session_id), { session_id }, task, spawn_process);
  await settled(seen);
  const args = calls[0];
  assert.equal(args[args.indexOf('--resume') + 1], session_id, 'the same session goes on, unforked');
  assert.ok(!args.includes('--fork-session'));
  assert.deepEqual(result.capabilities, { stoppable: true, progress: true });
  assert.deepEqual(seen.failures, []);
  assert.equal(seen.notes.at(-1), '后台回答');
});

test('a chat line to an open Claude window without an inbox fails with the reason, instead of forking beside it', async t => {
  const session_id = randomUUID();
  claude_home(t, session_id);
  const { task } = chat_task(mkdtempSync(join(tmpdir(), 'chat-run-')));
  await assert.rejects(deliver_task(own(session_id), { session_id }, task, () => { throw new Error('no process'); }), /窗口开着.*收件箱/);
});

test('a chat line whose inbox cannot be reached says the inbox is not a public interface', async t => {
  const session_id = randomUUID();
  claude_home(t, session_id, { socket: process.platform === 'win32' ? String.raw`\\.\pipe\codiscuss-missing-${randomUUID()}` : '/nonexistent/inbox.sock' });
  const { task } = chat_task(mkdtempSync(join(tmpdir(), 'chat-run-')));
  await assert.rejects(deliver_task(own(session_id), { session_id }, task, () => { throw new Error('no process'); }), /不是 Claude Code 的公开接口/);
});

/** Follow a window turn over a fresh log with a fast poll; returns the log, what it reported and the watch. */
function follow(t, options = {}, pid = process.pid) {
  const home = mkdtempSync(join(tmpdir(), 'claude-watch-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const file = join(home, 'session.jsonl');
  writeFileSync(file, line({ type: 'user', message: { content: 'an earlier turn naming [codiscuss:chat-3]' } }) + turn_end);
  const seen = { notes: [], failures: [], exits: 0 };
  const watch = watch_window_turn({ file, offset: readFileSync(file).length, pid, marker: options.marker || '[codiscuss:chat-3]' },
    { on_note: note => seen.notes.push(note), on_failure: reason => seen.failures.push(reason), on_exit: () => { seen.exits++; } },
    { interval: 10, ...options });
  return { file, seen, watch };
}

test('a message the window takes between tool calls of a running turn is followed to that turn\'s end (room task)', async t => {
  const { file, seen } = follow(t, { marker: 'free-9.task.json' });
  appendFileSync(file, line({ type: 'queue-operation', operation: 'remove', reason: 'absorbed_mid_turn', content: '读取 free-9.task.json' })
    + line({ type: 'attachment', attachment: { type: 'queued_command', prompt: 'CoDiscuss 本机服务代房间转达：读取 free-9.task.json', origin: { kind: 'peer' } } })
    + text('好') + turn_end);
  await settled(seen);
  assert.equal(seen.exits, 1, 'a message folded into a running turn no longer hangs until the window closes');
});

test('a chat turn waits for the turn that takes an interjection posted as it ended', async t => {
  const { file, seen, watch } = follow(t, { chat: true });
  appendFileSync(file, line({ type: 'user', message: { content: '[codiscuss:chat-3] 你好' } }) + text('第一段'));
  await delay(50);
  assert.equal(watch.expect('[codiscuss:chat-3+1]'), true);
  appendFileSync(file, turn_end);
  await delay(80);
  assert.equal(seen.exits, 0, 'the interjection has not been taken yet');
  appendFileSync(file, line({ type: 'user', message: { content: '[codiscuss:chat-3+1] 再补一句' } }) + text('回应插话') + turn_end);
  await settled(seen);
  assert.equal(seen.exits, 1);
  assert.deepEqual(seen.notes, ['第一段', '回应插话']);
  assert.equal(watch.expect('[codiscuss:chat-3+2]'), false, 'an ended turn takes no more interjections');
});

test('a chat turn fails with its reason when the window never takes it, waits on a prompt, or closes', async t => {
  const untaken = follow(t, { chat: true, start_after: 50 });
  await settled(untaken.seen);
  assert.match(untaken.seen.failures[0], /没有开始处理/);

  const pid = 999_000 + Math.floor(Math.random() * 999);
  const home = mkdtempSync(join(tmpdir(), 'claude-wait-')); mkdirSync(join(home, 'sessions'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  writeFileSync(join(home, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, status: 'waiting', waitingFor: 'approve Bash' }));
  const waiting = follow(t, { chat: true, waiting_after: 50, env: { CLAUDE_CONFIG_DIR: home } });
  appendFileSync(waiting.file, line({ type: 'user', message: { content: '[codiscuss:chat-3] 跑个命令' } }));
  await settled(waiting.seen);
  assert.match(waiting.seen.failures[0], /停在“approve Bash”/);

  const exited = spawnSync(process.execPath, ['-e', '']).pid || pid;
  const closed = follow(t, { chat: true }, exited);
  await settled(closed.seen);
  assert.match(closed.seen.failures[0], /窗口在这轮私聊结束前关闭/);
});

/** A registry whose record for this process says the window is `status`; `set` changes it. */
function registry(t, status) {
  const home = mkdtempSync(join(tmpdir(), 'claude-state-')); mkdirSync(join(home, 'sessions'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const set = value => writeFileSync(join(home, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, status: value }));
  set(status);
  return { env: { CLAUDE_CONFIG_DIR: home }, set };
}
const interrupted = body => line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: body }] } });
const tool_call = line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't9', name: 'Bash', input: { command: 'node work.mjs' } }] } });
const tool_return = line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't9', content: 'PRIME_COUNT 5' }] } });

test('stopping a window chat turn that is writing sends one Esc at once, only while the window is busy, and ends as stopped', async t => {
  const state = registry(t, 'idle');
  const keys = [];
  const { file, seen, watch } = follow(t, { chat: true, env: state.env, stop_poll: 10, stop_key: () => { keys.push(Date.now()); return { ok: true, terminal: 'conhost' }; } });
  appendFileSync(file, line({ type: 'user', message: { content: '[codiscuss:chat-3] 写一长段' } }));
  await delay(40);
  assert.equal(watch.stop(), true);
  watch.stop();
  await delay(80);
  assert.equal(keys.length, 0, 'a window the registry does not call busy gets no key');
  state.set('busy');
  await delay(80);
  watch.stop();
  await delay(80);
  assert.equal(keys.length, 1, 'one stop, one Esc');
  appendFileSync(file, text('写到一半') + interrupted('[Request interrupted by user]'));
  await settled(seen);
  assert.deepEqual(seen.failures, ['已停止'], 'the interrupt entry ends the turn, which records no turn_duration');
  assert.equal(keys.length, 1);
});

test('stopping a window chat turn waits for its running tool to return before the Esc, and gives up after the wait', async t => {
  const state = registry(t, 'busy');
  const keys = [];
  const stop_key = () => { keys.push(Date.now()); return { ok: true, terminal: 'Windows Terminal' }; };
  const running = follow(t, { chat: true, env: state.env, stop_poll: 10, stop_key });
  appendFileSync(running.file, line({ type: 'user', message: { content: '[codiscuss:chat-3] 跑脚本' } }) + tool_call);
  await delay(40);
  running.watch.stop();
  await delay(80);
  assert.equal(keys.length, 0, 'no Esc while the tool runs: it would read as the user refusing the call');
  appendFileSync(running.file, tool_return);
  await delay(80);
  assert.equal(keys.length, 1, 'the Esc goes once the tool returned and the model writes again');
  appendFileSync(running.file, interrupted('[Request interrupted by user]'));
  await settled(running.seen);
  assert.deepEqual(running.seen.failures, ['已停止']);

  const stuck = follow(t, { chat: true, env: state.env, stop_poll: 10, stop_tool_wait: 60, stop_key });
  appendFileSync(stuck.file, line({ type: 'user', message: { content: '[codiscuss:chat-3] 跑脚本' } }) + tool_call);
  await delay(40);
  stuck.watch.stop();
  await settled(stuck.seen);
  assert.deepEqual(stuck.seen.failures, ['工具仍在执行，未能停止']);
  assert.equal(keys.length, 1, 'no Esc went in while the tool still ran');
});

test('stopping a window chat turn whose Esc cannot be written says why', async t => {
  const state = registry(t, 'busy');
  const { file, seen, watch } = follow(t, { chat: true, env: state.env, stop_poll: 10, stop_key: () => ({ ok: false, reason: '无法连接到这个 Claude 窗口的控制台（AttachConsole 错误 5）' }) });
  appendFileSync(file, line({ type: 'user', message: { content: '[codiscuss:chat-3] 写一长段' } }));
  await delay(40);
  watch.stop();
  await settled(seen);
  assert.deepEqual(seen.failures, ['无法连接到这个 Claude 窗口的控制台（AttachConsole 错误 5）']);
});

test('a window turn interrupted in the window ends there: a chat turn fails with the reason, a room task ends', async t => {
  const chat = follow(t, { chat: true });
  appendFileSync(chat.file, line({ type: 'user', message: { content: '[codiscuss:chat-3] 跑脚本' } }) + tool_call
    + line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't9', is_error: true, content: 'The user doesn\'t want to proceed with this tool use.' }] } })
    + interrupted('[Request interrupted by user for tool use]'));
  await settled(chat.seen);
  assert.deepEqual(chat.seen.failures, ['这一轮在 Claude 窗口里被中断了']);

  const room = follow(t, { marker: 'free-9.task.json' });
  appendFileSync(room.file, line({ type: 'user', message: { content: '读取 free-9.task.json' } }) + interrupted('[Request interrupted by user]'));
  await settled(room.seen);
  assert.equal(room.seen.exits, 1, 'an interrupted room task no longer hangs until the window closes');
});

test('a chat turn in a window whose console is reachable is stoppable; its handle sends the Esc and closes with the turn', async t => {
  const session_id = randomUUID();
  const inbox = await inbox_server(t);
  const { log } = claude_home(t, session_id, { socket: inbox.socket, status: 'busy' });
  const { task, seen } = chat_task(mkdtempSync(join(tmpdir(), 'chat-run-')));
  const calls = [], processes = [];
  task.on_process = handle => processes.push(handle);
  const result = await claude.chat(own(session_id), { session_id }, task, () => { throw new Error('no process'); }, undefined,
    { console: (pid, { escape = false } = {}) => { calls.push({ pid, escape }); return { ok: true, terminal: 'conhost', reason: '' }; } });
  assert.deepEqual(result.capabilities, { stoppable: true, progress: true });
  assert.equal(processes.length, 1);
  const [handle] = processes;
  assert.equal(handle.stop_on_shutdown, false, 'the runner\'s shutdown presses no key in the owner\'s window');
  for (let waited = 0; !inbox.received.length && waited < 2000; waited += 20) await delay(20);
  appendFileSync(log, line({ type: 'user', message: { role: 'user', content: inbox.received[0][1].message.content } }));
  let closed = false;
  handle.once('close', () => { closed = true; });
  handle.kill();
  for (let waited = 0; calls.length < 2 && waited < 4000; waited += 20) await delay(20);
  assert.deepEqual(calls, [{ pid: process.pid, escape: false }, { pid: process.pid, escape: true }]);
  appendFileSync(log, interrupted('[Request interrupted by user]'));
  await settled(seen);
  assert.deepEqual(seen.failures, ['已停止']);
  assert.equal(closed, true);
  assert.match(readFileSync(join(task.directory, 'claude-chat-12.log'), 'utf8'), /"type":"codiscuss.stop","terminal":"conhost","sent":true/);
});

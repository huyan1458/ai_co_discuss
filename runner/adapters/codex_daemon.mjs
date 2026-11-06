/**
 * Private chat turns for a Codex CLI session the owner opened with `codex --remote unix://`, i.e. one held by the shared
 * app-server daemon. The daemon is reached through `codex app-server proxy`, which pipes the daemon's control socket:
 * a WebSocket (HTTP Upgrade, then one JSON-RPC message per text frame). This module never starts or stops the daemon;
 * when it is not running, or does not hold the session, the caller delivers the usual way.
 * Tested against codex-cli 0.163.0 with daemon 0.164.0 (`.dev/plans/执行中插话与引导/EXPERIMENT_私聊_手动终端_2026-11-06.md`).
 */
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import { CALL_TIMEOUT_MS } from './common.mjs';

const VERSION_TIMEOUT_MS = 10_000;
// A chat turn the owner forgot is interrupted after this long, so the connection never stays open for good.
const CHAT_MAX_MS = 60 * 60_000;
// After asking the turn to stop, how long to wait for the daemon's `interrupted` before ending on our side.
const STOP_GRACE_MS = 5_000;
const LIST_PAGE_LIMIT = 20;
const CLIENT_INFO = { name: 'codiscuss', version: '0.1.0' };
const WS_TEXT = 0x1, WS_CONTINUATION = 0x0, WS_CLOSE = 0x8, WS_PING = 0x9, WS_PONG = 0xa;

/** Whether the daemon runs, asked through `daemon version`, which only connects and never starts it. */
export function daemon_running(executable, spawn_process) {
  return new Promise(resolve_running => {
    let child;
    try { child = spawn_process(executable, ['app-server', 'daemon', 'version'], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { resolve_running(false); return; }
    let output = '';
    const timer = setTimeout(() => { child.kill(); resolve_running(false); }, VERSION_TIMEOUT_MS);
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.resume();
    child.once('error', () => { clearTimeout(timer); resolve_running(false); });
    child.once('close', code => {
      clearTimeout(timer);
      let version = null;
      try { version = JSON.parse(output.trim().split('\n').at(-1)); } catch { /* not running */ }
      resolve_running(code === 0 && Boolean(version?.appServerVersion));
    });
  });
}

/** One masked client text frame. */
function client_frame(text, opcode = WS_TEXT) {
  const payload = Buffer.from(text, 'utf8');
  const length = payload.length;
  const head = length < 126 ? Buffer.from([0x80 | opcode, 0x80 | length])
    : length < 65536 ? Buffer.from([0x80 | opcode, 0x80 | 126, length >> 8, length & 255])
      : Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | 127]), (() => { const size = Buffer.alloc(8); size.writeBigUInt64BE(BigInt(length)); return size; })()]);
  const mask = randomBytes(4);
  const body = Buffer.alloc(length);
  for (let index = 0; index < length; index++) body[index] = payload[index] ^ mask[index % 4];
  return Buffer.concat([head, mask, body]);
}

/**
 * Open a JSON-RPC connection to the daemon through `codex app-server proxy` and initialize it.
 * @returns {Promise<{request, notify, on_message, on_close, close}>} `request(method, params)` resolves the result or
 *   rejects with the server's message; `on_message` gets every notification; `on_close` fires once when the link drops.
 */
export async function open_daemon(executable, spawn_process) {
  const child = spawn_process(executable, ['app-server', 'proxy'], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  const events = new EventEmitter();
  let raw = Buffer.alloc(0), upgraded = false, closed = false, next_id = 0;
  let fragments = [];
  const queue = [];
  const close_link = reason => {
    if (closed) return;
    closed = true;
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(new Error(reason)); }
    pending.clear();
    events.emit('close', reason);
  };
  const write = text => {
    if (closed) return;
    if (!upgraded) queue.push(text);
    else child.stdin.write(client_frame(text));
  };
  const deliver = text => {
    let message;
    try { message = JSON.parse(text); } catch { return; }
    if (message.id != null && !message.method && pending.has(message.id)) {
      const { resolve: done, reject, timer } = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(timer);
      message.error ? reject(new Error(message.error.message || 'Codex daemon 请求失败')) : done(message.result);
    } else if (message.method && message.id == null) events.emit('message', message);
  };
  const read = chunk => {
    raw = Buffer.concat([raw, chunk]);
    if (!upgraded) {
      const end = raw.indexOf('\r\n\r\n');
      if (end < 0) return;
      const head = raw.subarray(0, end).toString();
      if (!/^HTTP\/1\.1 101\b/.test(head)) { close_link('Codex daemon 拒绝了连接'); child.kill(); return; }
      raw = raw.subarray(end + 4);
      upgraded = true;
      for (const text of queue.splice(0)) child.stdin.write(client_frame(text));
    }
    while (raw.length >= 2) {
      const fin = raw[0] & 0x80, opcode = raw[0] & 0x0f, masked = raw[1] & 0x80;
      let length = raw[1] & 0x7f, offset = 2;
      if (length === 126) { if (raw.length < 4) return; length = raw.readUInt16BE(2); offset = 4; }
      else if (length === 127) { if (raw.length < 10) return; length = Number(raw.readBigUInt64BE(2)); offset = 10; }
      const mask = masked ? raw.subarray(offset, offset + 4) : null;
      if (masked) offset += 4;
      if (raw.length < offset + length) return;
      const data = Buffer.from(raw.subarray(offset, offset + length));
      if (mask) for (let index = 0; index < data.length; index++) data[index] ^= mask[index % 4];
      raw = raw.subarray(offset + length);
      if (opcode === WS_PING) child.stdin.write(client_frame(data.toString('latin1'), WS_PONG));
      else if (opcode === WS_CLOSE) close_link('Codex daemon 关闭了连接');
      else if (opcode === WS_TEXT || opcode === WS_CONTINUATION) {
        fragments.push(data);
        if (fin) { const text = Buffer.concat(fragments).toString('utf8'); fragments = []; deliver(text); }
      }
    }
  };
  child.stdout.on('data', read);
  child.stderr.resume();
  child.stdin.on('error', () => close_link('与 Codex daemon 的连接中断'));
  child.once('error', error => close_link(`无法连接 Codex daemon：${error.message}`));
  child.once('close', () => close_link('与 Codex daemon 的连接中断'));
  child.stdin.write('GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
    + `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  const request = (method, params) => new Promise((resolve_result, reject) => {
    if (closed) { reject(new Error('与 Codex daemon 的连接中断')); return; }
    const id = ++next_id;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Codex daemon ${method} 超时`)); }, CALL_TIMEOUT_MS);
    pending.set(id, { resolve: resolve_result, reject, timer });
    write(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  });
  const link = {
    request,
    notify: (method, params) => write(JSON.stringify({ jsonrpc: '2.0', method, params })),
    on_message: listener => events.on('message', listener),
    on_close: listener => events.once('close', listener),
    // Ending the proxy only drops this client; the daemon keeps running and keeps the thread loaded.
    close: () => { close_link('连接已关闭'); child.stdin.end(); child.kill(); },
  };
  try {
    await request('initialize', { clientInfo: CLIENT_INFO });
    link.notify('initialized', {});
  } catch (error) { link.close(); throw error; }
  return link;
}

/** Whether the daemon has this thread loaded, i.e. the owner's `--remote` window is on it. */
export async function daemon_holds(link, thread_id) {
  let cursor;
  for (let page = 0; page < LIST_PAGE_LIMIT; page++) {
    const result = await link.request('thread/loaded/list', cursor ? { cursor } : {});
    if ((result?.data || []).includes(thread_id)) return true;
    cursor = result?.nextCursor;
    if (!cursor) return false;
  }
  return false;
}

/**
 * Connect to the running daemon when it holds this thread; null when the daemon is not running or holds other threads
 * (the link is then closed again). Never starts the daemon.
 */
export async function daemon_link(executable, thread_id, spawn_process) {
  if (!thread_id || !await daemon_running(executable, spawn_process)) return null;
  let link;
  try {
    link = await open_daemon(executable, spawn_process);
    if (await daemon_holds(link, thread_id)) return link;
  } catch { /* An unreachable daemon is the same as none. */ }
  link?.close();
  return null;
}

/** The status `codex exec` names for an item's state. */
const exec_status = status => ({ inProgress: 'in_progress', completed: 'completed', failed: 'failed', declined: 'failed' }[status] || status);

/** An app-server thread item in the shape `codex exec --json` prints it (as `codex_bridge.mjs` does); null otherwise. */
export function exec_item(item) {
  if (item.type === 'agentMessage') return { id: item.id, type: 'agent_message', text: item.text || '' };
  if (item.type === 'reasoning') return { id: item.id, type: 'reasoning', text: (item.summary || []).join('\n') };
  if (item.type === 'commandExecution') return { id: item.id, type: 'command_execution', command: item.command || '',
    aggregated_output: item.aggregatedOutput || '', exit_code: item.exitCode ?? null, status: exec_status(item.status) };
  if (item.type === 'fileChange') return { id: item.id, type: 'file_change', changes: item.changes || [], status: exec_status(item.status) };
  if (item.type === 'webSearch') return { id: item.id, type: 'web_search', query: item.query || '' };
  if (item.type === 'mcpToolCall') return { id: item.id, type: 'mcp_tool_call', server: item.server, tool: item.tool,
    arguments: item.arguments, result: item.result, error: item.error, status: exec_status(item.status) };
  if (item.type === 'plan') return { id: item.id, type: 'todo_list', items: [{ text: item.text || '', completed: false }] };
  return null;
}

/**
 * Run one private chat turn in a thread the daemon holds: subscribe with `thread/resume`, start the turn with the
 * thread's own model, effort and permissions (nothing is overridden, and they carry over to later turns), and report
 * through the task's callbacks. Interjections go in with `turn/steer`; `kill()` sends `turn/interrupt`.
 */
export async function daemon_chat(link, thread_id, task) {
  const log_path = resolve(task.directory, `codex_cli-${task.id}.log`);
  const log = event => task.on_output?.(log_path, `${JSON.stringify(event)}\n`);
  const handle = new EventEmitter();
  let turn_id = '', finished = false, stop_requested = false, stop_timer = null;
  const finish = error => {
    if (finished) return;
    finished = true;
    clearTimeout(limit_timer); clearTimeout(stop_timer);
    link.close();
    if (error) task.on_failure?.(error); else task.on_exit?.();
    handle.emit('close', error ? 1 : 0);
  };
  const interrupt = () => link.request('turn/interrupt', { threadId: thread_id, turnId: turn_id }).catch(() => {});
  const limit_timer = setTimeout(() => { if (turn_id) interrupt(); finish(`私聊超过 ${Math.round(CHAT_MAX_MS / 60_000)} 分钟仍未结束，已中断`); }, CHAT_MAX_MS);
  handle.kill = () => {
    if (finished) return false;
    stop_requested = true;
    if (turn_id) interrupt();
    stop_timer = setTimeout(() => finish('已停止'), STOP_GRACE_MS);
    return true;
  };
  link.on_close(reason => finish(reason));
  link.on_message(({ method, params = {} }) => {
    if (finished || params.threadId !== thread_id) return;
    if (params.turn?.id && turn_id && params.turn.id !== turn_id) return;
    if (params.turnId && turn_id && params.turnId !== turn_id) return;
    if (method === 'turn/started') log({ type: 'turn.started' });
    else if (method === 'item/started' || method === 'item/completed') {
      const item = exec_item(params.item || {});
      if (!item) return;
      const done = method === 'item/completed';
      log({ type: done ? 'item.completed' : 'item.started', item });
      if (done && item.type === 'agent_message' && item.text.trim()) task.on_note?.(item.text.trim());
    } else if (method === 'turn/completed') {
      const turn = params.turn || {};
      if (turn.status === 'completed') { log({ type: 'turn.completed', usage: params.usage || {} }); finish(''); return; }
      const reason = turn.status === 'interrupted' ? '已停止' : turn.error?.message || 'Codex 本轮失败';
      log({ type: 'turn.failed', error: { message: reason } });
      finish(reason);
    }
  });
  task.on_process?.(handle);
  try {
    // Subscribing is what brings this client the turn's items; without it only polling would see them.
    await link.request('thread/resume', { threadId: thread_id, excludeTurns: true });
    const started = await link.request('turn/start', { threadId: thread_id, input: [{ type: 'text', text: task.prompt }] });
    turn_id = started?.turn?.id || '';
    if (!turn_id) throw new Error('Codex daemon 未返回本轮编号');
  } catch (error) {
    clearTimeout(limit_timer);
    finished = true;
    link.close();
    handle.emit('close', 1);
    throw error;
  }
  if (stop_requested) interrupt();
  const steer = async text => {
    if (finished) return false;
    try { await link.request('turn/steer', { threadId: thread_id, expectedTurnId: turn_id, input: [{ type: 'text', text }] }); }
    catch { return false; }
    log({ type: 'codiscuss.interjection', text });
    return true;
  };
  return { session_id: thread_id, status: 'accepted', capabilities: { stoppable: true, progress: true }, steer };
}

/** 共享消息桥接：queue 投递到已有聊天，只读对应轮次并保存回复。 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DEFAULT_STATE = resolve(ROOT, 'data/message-bridge.sqlite3');
const DEFAULT_CODEX = process.platform === 'win32' ? 'codex.exe' : 'codex';
const RPC_TIMEOUT_MS = 30_000;
const APP_FRAME_LIMIT = 8 * 1024 * 1024;
const DEFAULT_WAIT_SECONDS = 90;
const DEFAULT_INTERVAL_SECONDS = 2;
const SQLITE_BUSY_MS = 5_000;
const PAGE_SIZE = 20;
const ERROR_LIMIT = 1_000;
const TERMINAL_STATES = new Set(['completed', 'failed']);
const RECORD_FIELDS = new Set([
  'status', 'anchor_turn_id', 'turn_id', 'queue_receipt', 'reply', 'last_error',
]);

const USAGE = `模拟微信消息桥接（Node.js 24+；需要已运行的 Codex 桌面应用）

  node message_bridge.mjs send --thread UUID --message-id ID --text "正文"
  node message_bridge.mjs send ... --enqueue-only
  node message_bridge.mjs watch [--once]
  node message_bridge.mjs status [--message-id ID]

共用选项：--state SQLite路径；--codex 原生可执行文件；--interval 秒（默认2）
send 默认等待最终回复，--timeout 秒调整等待时间（默认90）。
watch 持续处理已保存消息，Ctrl+C 停止；--once 只处理一轮。
输出为 JSON。退出码：0=完成/成功查询，1=错误，2=仍待处理或待核查。
相同编号和内容只提交一次；不确定投递只核对历史，不自动重发。
`;

/** Validate simulated input without altering its original text. */
function validate_message(message) {
  if (message.source && !['simulation', 'weixin'].includes(message.source)) {
    throw new Error('无效的消息来源');
  }
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(message.message_id ?? '')) {
    throw new Error('message-id 需为 1–128 位字母、数字或 _ . : -');
  }
  if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(message.thread_id ?? '')) {
    throw new Error('thread 需为已有聊天 UUID');
  }
  if (typeof message.text !== 'string' || !message.text.trim()) {
    throw new Error('text 不能为空');
  }
}

/** Build a stable exact-match input, retaining the original user text. */
function make_prompt(message, correlation_id) {
  const source = message.source === 'weixin' ? '已绑定微信用户转发' : '本机模拟微信转发';
  return `[${source}；消息编号：${message.message_id}；关联：${correlation_id}]\n`
    + '以下正文由用户通过消息桥接提交，请在当前聊天按正文要求处理。\n\n'
    + message.text;
}

/** Durable inbox and reply storage; queue submission is never retried implicitly. */
export class MessageStore {
  /** Open or initialize this bridge's own SQLite file. */
  constructor(state_path) {
    if (state_path !== ':memory:') mkdirSync(dirname(resolve(state_path)), { recursive: true });
    this.db = new DatabaseSync(state_path);
    this.db.exec(`PRAGMA busy_timeout=${SQLITE_BUSY_MS}; PRAGMA journal_mode=WAL;`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS bridge_messages (
      message_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, text TEXT NOT NULL,
      prompt TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'received',
      anchor_turn_id TEXT, turn_id TEXT, queue_receipt TEXT,
      reply TEXT, last_error TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`);
  }

  /** Insert one simulated message; reject reuse of its ID for another payload. */
  enqueue(message) {
    validate_message(message);
    const thread_id = message.thread_id.toLowerCase();
    const now = Date.now();
    const insertion = this.db.prepare(`INSERT OR IGNORE INTO bridge_messages
      (message_id,thread_id,text,prompt,created_at,updated_at) VALUES (?,?,?,?,?,?)`)
      .run(message.message_id, thread_id, message.text,
        make_prompt(message, randomUUID()), now, now);
    const saved = this.get(message.message_id);
    if (saved.thread_id !== thread_id || saved.text !== message.text) {
      throw new Error('消息编号已用于不同的聊天或正文；请使用新编号');
    }
    return { message: saved, duplicate: insertion.changes === 0 };
  }

  /** Return a stored message, or undefined if it does not exist. */
  get(message_id) {
    return this.db.prepare('SELECT * FROM bridge_messages WHERE message_id=?').get(message_id);
  }

  /** List all messages in receipt order, optionally restricting the ID. */
  list(message_id) {
    if (message_id) return [this.get(message_id)].filter(Boolean);
    return this.db.prepare('SELECT * FROM bridge_messages ORDER BY created_at,message_id').all();
  }

  /** Atomically claim a message before touching the external queue. */
  claim(message_id, anchor_turn_id) {
    return this.db.prepare(`UPDATE bridge_messages SET status='uncertain',
      anchor_turn_id=?,updated_at=? WHERE message_id=? AND status='received'`)
      .run(anchor_turn_id, Date.now(), message_id).changes === 1;
  }

  /** Update nonterminal records without letting stale workers overwrite final replies. */
  record(message_id, fields) {
    const names = Object.keys(fields);
    if (!names.length || names.some(name => !RECORD_FIELDS.has(name))) {
      throw new Error('无效的消息记录字段');
    }
    const assignments = names.map(name => `${name}=?`).join(',');
    this.db.prepare(`UPDATE bridge_messages SET ${assignments},updated_at=?
      WHERE message_id=? AND status NOT IN ('completed','failed')`)
      .run(...names.map(name => fields[name]), Date.now(), message_id);
  }

  /** Record CLI acceptance without downgrading an already observed turn. */
  accepted(message_id, receipt) {
    this.db.prepare(`UPDATE bridge_messages SET status='queued',queue_receipt=?,
      last_error='',updated_at=? WHERE message_id=? AND status='uncertain' AND turn_id IS NULL`)
      .run(receipt, Date.now(), message_id);
  }

  /** Close the bridge database. */
  close() {
    this.db.close();
  }
}

/** Execute a native CLI with argument arrays; no command shell parses user text. */
function run_process(executable, args, timeout_ms = RPC_TIMEOUT_MS) {
  return new Promise((resolve_result, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timed_out = false;
    const timer = setTimeout(() => { timed_out = true; child.kill(); }, timeout_ms);
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (timed_out) reject(new Error('CLI 调用超时，投递结果需核查'));
      else if (code !== 0) reject(new Error(`CLI 退出码 ${code}：${stderr.slice(-ERROR_LIMIT)}`));
      else resolve_result(stdout.trim());
    });
  });
}

/** Read-only JSON-RPC connection to a separate app-server process. */
class AppServerReader {
  /** Save the executable; start() performs the protocol handshake. */
  constructor(executable) {
    this.executable = executable;
    this.pending = new Map();
    this.next_id = 1;
    this.buffer = '';
    this.child = null;
    this.failure = null;
  }

  /** Start only a history reader, never resume or run the desktop thread here. */
  async start() {
    this.child = spawn(this.executable, ['app-server', '--listen', 'stdio://'], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.setEncoding('utf8').on('data', chunk => this.read_lines(chunk));
    this.child.stderr.resume();
    this.child.once('error', error => this.fail(error));
    this.child.once('close', () => this.fail(new Error('App Server 读取连接已关闭')));
    this.child.stdin.on('error', error => this.fail(error));
    await this.request('initialize', {
      clientInfo: { name: 'wechat_sim_bridge', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    this.child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
  }

  /** Resolve JSON-RPC responses; notifications are not used as global idle signals. */
  read_lines(chunk) {
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line);
        const waiter = this.pending.get(message.id);
        if (!waiter) continue;
        this.pending.delete(message.id);
        clearTimeout(waiter.timer);
        if (message.error) waiter.reject(new Error(message.error.message));
        else waiter.resolve(message.result);
      } catch (error) { this.fail(error); }
    }
  }

  /** Send one bounded protocol request and return its result. */
  request(method, params) {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve_result, reject) => {
      const id = this.next_id++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`App Server ${method} 超时`));
      }, RPC_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolve_result, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  /** Reject outstanding reads when this private connection fails. */
  fail(error) {
    this.failure = error;
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
  }

  /** Stop only the reader process created by this bridge. */
  close() {
    this.fail(new Error('读取程序已停止'));
    if (this.child) { this.child.stdin.end(); this.child.kill(); }
  }
}

/** Call the running desktop's app tools without starting an AI turn in another chat. */
export class CodexAppClient {
  /** An explicit pipe is useful for integration tests and non-Windows installations. */
  constructor(pipe_path = process.env.CODEX_APP_TOOLS_PIPE_PATH) {
    this.pipe_path = pipe_path;
    this.pending = new Map();
    this.next_id = 1;
    this.buffer = Buffer.alloc(0);
  }

  /** Discover one running desktop and verify its create_thread tool before claiming work. */
  async open() {
    if (!this.pipe_path) {
      if (process.platform !== 'win32') throw new Error('需要 CODEX_APP_TOOLS_PIPE_PATH');
      const pipes = readdirSync('\\\\.\\pipe\\').filter(name => name.startsWith('codex-app-tools-'));
      if (pipes.length !== 1) throw new Error('需要唯一运行中的 Codex 桌面应用');
      this.pipe_path = `\\\\.\\pipe\\${pipes[0]}`;
    }
    const socket = createConnection(this.pipe_path);
    this.socket = socket;
    socket.on('error', error => { if (this.socket === socket) this.fail(error); });
    socket.on('close', () => { if (this.socket === socket) this.fail(new Error('桌面连接已关闭')); });
    socket.on('data', chunk => { if (this.socket === socket) this.read_frames(chunk); });
    const result = await this.request('tools/list', { threadStartKind: 'all' });
    this.tools = new Map((result.tools ?? []).map(tool => [tool.name, tool]));
    if (!this.tools.has('create_thread')) throw new Error('桌面未提供 create_thread');
  }

  /** Call an available desktop tool with the actual source thread as execution context. */
  async call_tool(name, source_thread_id, arguments_value) {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`桌面未提供 ${name}`);
    const result = await this.request('tools/call', {
      arguments: arguments_value,
      callerSource: 'codex', hostId: 'local', namespace: tool.namespace,
      threadId: source_thread_id, tool: tool.name,
      callId: `weixin-${randomUUID()}`, turnId: `weixin-${randomUUID()}`,
    });
    if (!result.success) throw new Error(`桌面工具 ${name} 未确认成功`);
    for (const item of result.contentItems ?? []) {
      if (item.type !== 'inputText') continue;
      try { return JSON.parse(item.text); }
      catch { /* Only structured tool results identify desktop objects. */ }
    }
    throw new Error(`桌面工具 ${name} 尚未返回结构化结果`);
  }

  /** Read saved projects without loading their chats or exposing their history. */
  async list_projects(source_thread_id) {
    const result = await this.call_tool('list_projects', source_thread_id, {});
    if (!Array.isArray(result?.projects)) throw new Error('桌面项目列表格式无效');
    return result.projects;
  }

  /** Create a fresh chat in the chosen project or without a project. */
  async create_thread(source_thread_id, prompt, title, target = { type: 'projectless' }) {
    const data = await this.call_tool('create_thread', source_thread_id, { prompt, title, target });
    if (!data?.threadId) throw new Error('桌面尚未返回实际 threadId，创建结果需核查');
    return { thread_id: data.threadId, title: data.title || title };
  }

  /** Send the same length-prefixed JSON-RPC frames as the bundled app-tools MCP. */
  request(method, params) {
    return new Promise((resolve_result, reject) => {
      const id = this.next_id++;
      const payload = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      if (payload.length > APP_FRAME_LIMIT) { reject(new Error('桌面请求过长')); return; }
      const frame = Buffer.alloc(4 + payload.length);
      frame.writeUInt32LE(payload.length);
      payload.copy(frame, 4);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('桌面工具回执超时'));
      }, RPC_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolve_result, reject, timer });
      this.socket.write(frame);
    });
  }

  /** Decode fragmented or coalesced frames and settle only their matching request. */
  read_frames(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE();
      if (length > APP_FRAME_LIMIT) { this.fail(new Error('桌面回执过长')); this.socket.destroy(); return; }
      if (this.buffer.length < length + 4) return;
      try {
        const response = JSON.parse(this.buffer.subarray(4, length + 4).toString('utf8'));
        this.buffer = this.buffer.subarray(length + 4);
        const waiter = this.pending.get(response.id);
        if (!waiter) continue;
        this.pending.delete(response.id);
        clearTimeout(waiter.timer);
        if (response.error) waiter.reject(new Error(response.error.message));
        else waiter.resolve(response.result);
      } catch (error) { this.fail(error); this.socket.destroy(); return; }
    }
  }

  /** Reject outstanding operations; callers retain uncertain creation for reconciliation. */
  fail(error) {
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
  }

  /** Close only this client connection, leaving the desktop and its new chat running. */
  close() {
    this.fail(new Error('桌面工具连接已停止'));
    this.socket?.destroy();
    this.buffer = Buffer.alloc(0);
  }
}

/** Native queue sender and history-only reader for the local Codex installation. */
export class CodexClient {
  /** Select a native binary; Windows .cmd/.ps1 wrappers are intentionally unsupported. */
  constructor(executable = DEFAULT_CODEX) {
    if (process.platform === 'win32' && !executable.toLowerCase().endsWith('.exe')) {
      throw new Error('Windows 请通过 --codex 指定原生 codex.exe');
    }
    this.executable = executable;
    this.reader = null;
  }

  /** Verify queue support, then connect the history reader. */
  async open() {
    const help = await run_process(this.executable, ['help', 'queue']);
    if (!help.includes('--thread') || !help.includes('--message')) {
      throw new Error('此 Codex 不支持 queue，请指定兼容版本');
    }
    this.reader = new AppServerReader(this.executable);
    await this.reader.start();
  }

  /** Submit the exact stored prompt to the original desktop conversation. */
  queue(message) {
    return run_process(this.executable, [
      'queue', '--thread', message.thread_id, '--message', message.prompt,
    ]);
  }

  /** Read one saved title without loading history, resuming a thread, or starting a turn. */
  async metadata(thread_id) {
    const reader = new AppServerReader(this.executable);
    try {
      await reader.start();
      return (await reader.request('thread/read', { threadId: thread_id, includeTurns: false })).thread;
    } finally { reader.close(); }
  }

  /** Read a page of stored turns without changing that thread's execution state. */
  list_turns(thread_id, options = {}) {
    return this.reader.request('thread/turns/list', {
      threadId: thread_id, limit: PAGE_SIZE, sortDirection: 'desc', itemsView: 'full', ...options,
    });
  }

  /** Close the private reader, leaving the desktop app and its tasks running. */
  close() {
    this.reader?.close();
    this.reader = null;
  }
}

/** Find only a user-message item with the exact persisted bridge input. */
function matches_input(turn, prompt) {
  return (turn.items ?? []).some(item => item.type === 'userMessage'
    && (item.content ?? []).some(part => part.type === 'text' && part.text === prompt));
}

/** Search newer turns up to the pre-submission anchor, including later pages. */
export async function find_message_turn(client, message) {
  let cursor;
  const seen_cursors = new Set();
  do {
    const page = await client.list_turns(message.thread_id, cursor ? { cursor } : {});
    for (const turn of page.data) {
      if (matches_input(turn, message.prompt)) return turn;
      if (turn.id === message.anchor_turn_id) return null;
    }
    cursor = page.nextCursor;
    if (cursor && seen_cursors.has(cursor)) throw new Error('历史分页游标未前进');
    seen_cursors.add(cursor);
  } while (cursor);
  return null;
}

/** Store only the matched turn's final text and terminal status. */
function record_turn(store, message_id, turn) {
  const fields = { turn_id: turn.id, status: 'waiting', last_error: '' };
  // A foreign app-server can reconstruct an unfinished turn as interrupted.
  // Only a persisted end timestamp confirms a terminal history record.
  const ended = turn.completedAt != null;
  if (ended && turn.status === 'completed') {
    fields.status = 'completed';
    fields.reply = (turn.items ?? [])
      .filter(item => item.type === 'agentMessage' && item.phase === 'final_answer')
      .map(item => item.text).join('\n\n');
  } else if (ended && ['failed', 'interrupted'].includes(turn.status)) {
    fields.status = 'failed';
    fields.last_error = turn.error?.message || `Codex 轮次状态：${turn.status}`;
  }
  store.record(message_id, fields);
}

/** Claim and submit once; failure after the claim remains uncertain for reconciliation. */
async function submit_received(store, client, message) {
  const page = await client.list_turns(message.thread_id, { limit: 1, itemsView: 'notLoaded' });
  if (!store.claim(message.message_id, page.data[0]?.id ?? null)) return;
  try {
    const receipt = await client.queue(message);
    store.accepted(message.message_id, receipt);
  } catch (error) {
    store.record(message.message_id, { last_error: error.message.slice(0, ERROR_LIMIT) });
  }
}

/** Process one message without replaying an uncertain or already queued submission. */
export async function process_message(store, client, message_id) {
  let message = store.get(message_id);
  if (!message || TERMINAL_STATES.has(message.status)) return message;
  try {
    if (message.status === 'received') await submit_received(store, client, message);
    message = store.get(message_id);
    if (TERMINAL_STATES.has(message.status)) return message;
    const turn = await find_message_turn(client, message);
    if (turn) record_turn(store, message_id, turn);
    else if (message.status === 'uncertain' && !message.last_error) {
      store.record(message_id, { last_error: '投递结果待核查：尚未在聊天历史找到本消息，保留记录且不自动重发' });
    }
  } catch (error) {
    store.record(message_id, { last_error: error.message.slice(0, ERROR_LIMIT) });
    throw error;
  }
  return store.get(message_id);
}

/** Omit the internal prompt and expose the simulated inbox/reply record. */
function public_message(message) {
  if (!message) return null;
  const { prompt, anchor_turn_id, ...visible } = message;
  return visible;
}

/** Write machine-readable simulated delivery results to stdout. */
function write_result(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** Parse the three intentionally local commands and their timing options. */
function parse_options(arguments_list) {
  const { values, positionals } = parseArgs({ args: arguments_list, allowPositionals: true, options: {
    thread: { type: 'string' }, 'message-id': { type: 'string' }, text: { type: 'string' },
    codex: { type: 'string', default: DEFAULT_CODEX }, state: { type: 'string', default: DEFAULT_STATE },
    interval: { type: 'string', default: String(DEFAULT_INTERVAL_SECONDS) },
    timeout: { type: 'string', default: String(DEFAULT_WAIT_SECONDS) },
    'enqueue-only': { type: 'boolean' }, once: { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help || !positionals.length) return { help: true };
  if (positionals.length !== 1 || !['send', 'watch', 'status'].includes(positionals[0])) {
    throw new Error('命令需为 send、watch 或 status；使用 --help 查看用法');
  }
  const interval_ms = Number(values.interval) * 1_000;
  const timeout_ms = Number(values.timeout) * 1_000;
  if (!Number.isFinite(interval_ms) || interval_ms < 100
      || !Number.isFinite(timeout_ms) || timeout_ms < 0) throw new Error('interval 至少 0.1 秒；timeout 需非负');
  return { ...values, command: positionals[0], interval_ms, timeout_ms };
}

/** Wait for one stored message while retaining pending work when the wait expires. */
async function wait_for_reply(store, client, options) {
  const deadline = Date.now() + options.timeout_ms;
  do {
    const message = await process_message(store, client, options['message-id']);
    if (TERMINAL_STATES.has(message.status) || message.status === 'uncertain') return message;
    if (Date.now() >= deadline) return message;
    await sleep(Math.min(options.interval_ms, deadline - Date.now()));
  } while (true);
}

/** Submit one simulated incoming message, optionally leaving processing to watch. */
async function send_message(store, options) {
  const { message, duplicate } = store.enqueue({
    message_id: options['message-id'], thread_id: options.thread, text: options.text,
  });
  if (options['enqueue-only'] || TERMINAL_STATES.has(message.status)) {
    write_result({ duplicate, message: public_message(message) });
    return message.status === 'failed' ? 1 : 0;
  }
  const client = new CodexClient(options.codex);
  try {
    await client.open();
    const result = await wait_for_reply(store, client, options);
    write_result({ duplicate, message: public_message(result) });
    return result.status === 'completed' ? 0 : result.status === 'failed' ? 1 : 2;
  } finally { client.close(); }
}

/** Process durable messages until stopped, reconnecting only the private read connection. */
async function watch_messages(store, options) {
  let stopped = false;
  let client = null;
  const stop = () => { stopped = true; client?.close(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    do {
      const pending = store.list().filter(message => !TERMINAL_STATES.has(message.status));
      try {
        if (pending.length && !client) { client = new CodexClient(options.codex); await client.open(); }
        for (const message of pending) {
          if (stopped) break;
          const result = await process_message(store, client, message.message_id);
          if (result.status !== message.status || result.last_error !== message.last_error) {
            write_result({ message: public_message(result) });
          }
        }
      } catch (error) {
        client?.close(); client = null;
        if (options.once) throw error;
        if (!stopped) process.stderr.write(`${JSON.stringify({ error: error.message })}\n`);
      }
      if (options.once || stopped) break;
      await sleep(options.interval_ms);
    } while (!stopped);
    return 0;
  } finally {
    client?.close();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

/** Run a local command; stdout simulates the reply that a future channel would send. */
export async function main(arguments_list = process.argv.slice(2)) {
  const options = parse_options(arguments_list);
  if (options.help) { process.stdout.write(USAGE); return 0; }
  const store = new MessageStore(options.state);
  try {
    if (options.command === 'send') return await send_message(store, options);
    if (options.command === 'watch') return await watch_messages(store, options);
    const messages = store.list(options['message-id']).map(public_message);
    if (options['message-id'] && !messages.length) throw new Error('未找到指定消息');
    write_result({ messages });
    return 0;
  } finally { store.close(); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    process.stderr.write(`${JSON.stringify({ error: error.message })}\n`);
    process.exitCode = 1;
  });
}

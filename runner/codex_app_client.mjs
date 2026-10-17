/** Minimal client for the running Codex desktop's app-tools pipe; never calls model service APIs. */
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { createConnection } from 'node:net';

const RPC_TIMEOUT_MS = 30_000;
const APP_FRAME_LIMIT = 8 * 1024 * 1024;

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
      callId: `codiscuss-${randomUUID()}`, turnId: `codiscuss-${randomUUID()}`,
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

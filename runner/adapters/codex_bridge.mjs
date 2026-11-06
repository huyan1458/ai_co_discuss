/**
 * Run one Codex turn through `codex app-server` and speak `codex exec --json` on stdout, so the Codex CLI adapter keeps
 * its event handling while the owner can interject mid-turn (`turn/steer`), which `codex exec` cannot take.
 *
 * usage: node codex_bridge.mjs <codex executable> [codex app-server options...]
 * stdin: first line `{prompt, thread_id?, cwd, model?, effort?, full?}`; every later line `{steer: text}`.
 * stdout: `thread.started`, `turn.started`, `item.started|completed`, `turn.completed|failed`, `error` events in the
 * shape `codex exec --json` prints. The process exits when the turn ends; exit 1 with the reason on stderr otherwise.
 * One process per execution: an app-server keeps the thread it loaded as its writer until it exits.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const [executable, ...server_args] = process.argv.slice(2);
const pending = new Map();
let next_id = 0;
let thread_id = '';
let turn_id = '';
let finished = false;
const queued_steers = [];

const server = spawn(executable, ['app-server', ...server_args], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
server.stderr.pipe(process.stderr);
server.once('error', error => fail(error.message));
server.once('close', code => { if (!finished) fail(`Codex app-server 意外退出（${code}）`); });

/** Print one exec-shaped event. */
function emit(event) { process.stdout.write(`${JSON.stringify(event)}\n`); }

/** End with a reason; a thread another process holds says so the way `codex exec` does, so the adapter recognizes it. */
function fail(message) {
  if (finished) return;
  finished = true;
  const conflict = /active writer/i.test(message) ? 'thread-store conflict: this thread already has an active writer — ' : '';
  process.stderr.write(`${conflict}${message}\n`);
  server.kill();
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 200).unref();
}

/** One JSON-RPC request; rejects with the server's error message. */
function request(method, params) {
  const id = ++next_id;
  server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

/** The status `codex exec` names for an item's state. */
const exec_status = status => ({ inProgress: 'in_progress', completed: 'completed', failed: 'failed', declined: 'failed' }[status] || status);

/** An app-server thread item in the shape `codex exec` prints it; null for items exec does not show. */
function exec_item(item) {
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

/** Translate one server notification; the turn's end ends this process. */
function notification({ method, params = {} }) {
  if (params.threadId && params.threadId !== thread_id) return;
  if (method === 'turn/started') emit({ type: 'turn.started' });
  else if (method === 'item/started' || method === 'item/completed') {
    const item = exec_item(params.item || {});
    if (item) emit({ type: method === 'item/started' ? 'item.started' : 'item.completed', item });
  } else if (method === 'error') emit({ type: 'error', message: params.error?.message || params.message || 'Codex 返回错误' });
  else if (method === 'turn/completed') {
    const turn = params.turn || {};
    if (turn.status === 'completed') emit({ type: 'turn.completed', usage: params.usage || {} });
    else emit({ type: 'turn.failed', error: { message: turn.error?.message || (turn.status === 'interrupted' ? '本轮已中断' : 'Codex 本轮失败') } });
    finished = true;
    server.kill();
    process.stdout.write('', () => process.exit(0));
  }
}

createInterface({ input: server.stdout, crlfDelay: Infinity }).on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id && pending.has(message.id) && !message.method) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    message.error ? reject(new Error(message.error.message || 'Codex 请求失败')) : resolve(message.result);
  } else if (message.method && message.id === undefined) notification(message);
});

/** Pass an interjection into the running turn; before the turn exists it waits, after the turn it is refused. */
async function steer(text) {
  if (finished) return;
  if (!turn_id) { queued_steers.push(text); return; }
  try { await request('turn/steer', { threadId: thread_id, expectedTurnId: turn_id, input: [{ type: 'text', text }] }); }
  catch (error) { process.stderr.write(`插话未送达：${error.message}\n`); }
}

/** Open or resume the thread, then start the turn with the prompt. */
async function start(task) {
  await request('initialize', { clientInfo: { name: 'codiscuss', version: '0.1.0' } });
  server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} })}\n`);
  // 全放开 has no permission profile; the thread itself runs without sandbox or approval.
  const access = task.full ? { sandbox: 'danger-full-access', approvalPolicy: 'never' } : {};
  const opened = task.thread_id ? await request('thread/resume', { threadId: task.thread_id, cwd: task.cwd, ...access })
    : await request('thread/start', { cwd: task.cwd, ...access });
  thread_id = opened.thread.id;
  emit({ type: 'thread.started', thread_id });
  const started = await request('turn/start', { threadId: thread_id, input: [{ type: 'text', text: task.prompt }],
    ...(task.model ? { model: task.model } : {}), ...(task.effort ? { effort: task.effort } : {}) });
  turn_id = started.turn.id;
  for (const text of queued_steers.splice(0)) await steer(text);
}

let first = true;
createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  let input;
  try { input = JSON.parse(line); } catch { return; }
  if (first) { first = false; start(input).catch(error => fail(error.message)); }
  else if (typeof input.steer === 'string') steer(input.steer);
});

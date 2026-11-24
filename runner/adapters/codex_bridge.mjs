/**
 * Run one Codex turn through `codex app-server` and speak `codex exec --json` on stdout, so the Codex CLI adapter keeps
 * its event handling while the owner can interject mid-turn (`turn/steer`), which `codex exec` cannot take.
 *
 * usage: node codex_bridge.mjs <codex executable> [codex app-server options...]
 * stdin: first line `{prompt, thread_id?, cwd, model?, effort?, full?, images?, developer_instructions?}` (`images`: local
 * image paths sent with the prompt; `developer_instructions`: system-level rules of a new thread); later lines carry `{steer: text, interjection_id?}`.
 * stdout: `thread.started`, `turn.started`, `item.started|completed`, `turn.completed|failed`, `error` events in the
 * shape `codex exec --json` prints. The process exits when the turn ends; exit 1 with the reason on stderr otherwise.
 * One process per execution: an app-server keeps the thread it loaded as its writer until it exits.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { tree_killable } from './common.mjs';

/**
 * The under-development `context_management` feature lets the model call `new_context`, which drops the history without a
 * summary and relies on `notes`/`history` tools to recover it; when those tools fail ("The backend request failed" on
 * every call, 0.163, 2026-11), the turn forgets the room task and ends without answering. Room turns keep Codex's
 * summarizing compaction instead.
 */
const CONTEXT_OVERRIDES = ['-c', 'features.context_management=false'];
const [executable, ...server_args] = process.argv.slice(2);
const pending = new Map();
let next_id = 0;
let thread_id = '';
let turn_id = '';
let finished = false;
const queued_steers = [];
const pending_steers = new Map();
const completed_user_items = new Set();

const server = spawn(executable, ['app-server', ...CONTEXT_OVERRIDES, ...server_args], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
tree_killable(server);
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

/** Forward only bounded software error-code fields, never arbitrary provider error metadata. */
function error_details(error = {}) {
  if (!error || typeof error !== 'object') return {};
  return Object.fromEntries(['codex_error_info', 'codexErrorInfo'].filter(key => typeof error[key] === 'string'
    && error[key].length <= 128).map(key => [key, error[key]]));
}

/** Translate one server notification; the turn's end ends this process. */
function notification({ method, params = {} }) {
  if (params.threadId && params.threadId !== thread_id) return;
  if (method === 'turn/started') emit({ type: 'turn.started' });
  else if (method === 'item/started' || method === 'item/completed') {
    if (method === 'item/completed' && params.threadId === thread_id && params.turnId === turn_id) confirm_steer(params.item);
    const item = exec_item(params.item || {});
    if (item) emit({ type: method === 'item/started' ? 'item.started' : 'item.completed', item });
  } else if (method === 'error') emit({ type: 'error', message: params.error?.message || params.message || 'Codex 返回错误', ...error_details(params.error) });
  else if (method === 'turn/completed') {
    const turn = params.turn || {};
    if (turn.status === 'completed') emit({ type: 'turn.completed', usage: params.usage || {} });
    else emit({ type: 'turn.failed', error: { message: turn.error?.message || (turn.status === 'interrupted' ? '本轮已中断' : 'Codex 本轮失败'), ...error_details(turn.error) } });
    finished = true;
    server.kill();
    process.stdout.write('', () => process.exit(0));
  }
}

/** Match a completed user message to one pending interjection without emitting the message text. */
function confirm_steer(item) {
  if (item?.type !== 'userMessage' || !item.id || completed_user_items.has(item.id)
    || item.content?.length !== 1 || item.content[0].type !== 'text') return;
  completed_user_items.add(item.id);
  const matches = [...pending_steers].filter(([, text]) => text === item.content[0].text);
  for (const [id] of matches) pending_steers.delete(id);
  if (matches.length === 1) emit({ type: 'codiscuss.interjection_confirmed', interjection_id: matches[0][0] });
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
async function steer(text, id) {
  if (finished) return;
  if (!turn_id) { queued_steers.push({ text, id }); return; }
  if (Number.isSafeInteger(id) && id > 0) pending_steers.set(id, text);
  try { await request('turn/steer', { threadId: thread_id, expectedTurnId: turn_id, input: [{ type: 'text', text }] }); }
  catch (error) { pending_steers.delete(id); process.stderr.write(`插话未送达：${error.message}\n`); }
}

/** Open or resume the thread, then start the turn with the prompt. */
async function start(task) {
  await request('initialize', { clientInfo: { name: 'codiscuss', version: '0.1.0' } });
  server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} })}\n`);
  // 全放开 has no permission profile; the thread itself runs without sandbox or approval.
  const access = task.full ? { sandbox: 'danger-full-access', approvalPolicy: 'never' } : {};
  // Codex keeps a thread's developer instructions from its start: a resumed thread ignores new ones (tested 0.169.1).
  const opened = task.thread_id ? await request('thread/resume', { threadId: task.thread_id, cwd: task.cwd, ...access })
    : await request('thread/start', { cwd: task.cwd, ...access, ...(task.developer_instructions ? { developerInstructions: task.developer_instructions } : {}) });
  thread_id = opened.thread.id;
  emit({ type: 'thread.started', thread_id });
  // The task's images go in as `localImage` inputs after the text, as a screenshot attached in Codex itself does.
  const images = (Array.isArray(task.images) ? task.images : []).map(path => ({ type: 'localImage', path }));
  const started = await request('turn/start', { threadId: thread_id, input: [{ type: 'text', text: task.prompt }, ...images],
    ...(task.model ? { model: task.model } : {}), ...(task.effort ? { effort: task.effort } : {}) });
  turn_id = started.turn.id;
  emit({ type: 'codiscuss.turn', thread_id, turn_id, rollout_path: opened.thread.path || '' });
  for (const { text, id } of queued_steers.splice(0)) await steer(text, id);
}

let first = true;
createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  let input;
  try { input = JSON.parse(line); } catch { return; }
  if (first) { first = false; start(input).catch(error => fail(error.message)); }
  else if (typeof input.steer === 'string') steer(input.steer, input.interjection_id);
});

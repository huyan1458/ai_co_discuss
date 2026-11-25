/**
 * Run one Codex turn through `codex app-server` and speak `codex exec --json` on stdout, so the Codex CLI adapter keeps
 * its event handling while the owner can interject mid-turn (`turn/steer`), which `codex exec` cannot take.
 *
 * usage: node codex_bridge.mjs <codex executable> [codex app-server options...]
 * stdin: first line `{prompt, thread_id?, cwd, model?, effort?, full?, images?, developer_instructions?}` (`images`: local
 * image paths sent with the prompt; `developer_instructions`: system-level rules of a new thread); later lines carry an interjection, a linger request or the decision on a proposed follow-up.
 * stdout: `thread.started`, `turn.started`, `item.started|completed`, `turn.completed|failed`, `error` events in the
 * shape `codex exec --json` prints. The process exits when the turn and any tracked background reports end; exit 1 with the reason on stderr otherwise.
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
// A background command's completion never reaches the model's context (unlike a sub-agent's result), so its follow-up
// turn is given the end of the command's output; measured on 0.169.1, 2026-11-25.
const FOLLOWUP_OUTPUT_CHARS = 2000;
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
function request(method, params, timeout_ms) {
  const id = ++next_id;
  server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return new Promise((resolve, reject) => {
    const timer = timeout_ms === undefined ? undefined : setTimeout(() => {
      pending.delete(id);
      reject(new Error('Codex terminal list timed out'));
    }, timeout_ms);
    pending.set(id, { resolve, reject, timer });
  });
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

const ended_turns = new Set();
const running = new Map();
const commands = new Map();
const reports = [];
let offered = [];
let task_options;
let idle = false;
let residual = false;
const TERMINAL_POLL_MS = 1000;
const TERMINAL_LIST_TIMEOUT_MS = 5000;
let checking = null;
let check_timer;
let settling = false;
let rollout_path = '';

/** Track only objects started by the current parent turn. */
function background_start(id, kind, title, origin) {
  if (residual || running.has(id)) return;
  running.set(id, { id, kind, title, origin });
  emit({ type: 'background.started', id, kind, title });
}

/** The provider reports completion on the original turn even after it ended. */
function background_end(id, origin, status, output = '') {
  const work = running.get(id);
  if (!work || work.origin !== origin) return;
  running.delete(id);
  if (ended_turns.has(origin) && status !== 'stopped') {
    reports.push({ id, status, summary: String(work.title || id).slice(0, 300), rootTurnId: origin, ...(output ? { output } : {}) });
  }
  emit({ type: 'background.ended', id, status, pending: Boolean(reports.length || offered.length) });
  if (idle && !settling) setImmediate(next_report);
}

/** A command start alone includes foreground processes. Match the loaded thread's live terminal list. */
function check_terminals(deadline = Date.now() + TERMINAL_LIST_TIMEOUT_MS) {
  if (!commands.size || finished) return checking;
  if (checking) return checking;
  checking = (async () => {
    let cursor;
    const terminals = [];
    do {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      const page = await request('thread/backgroundTerminals/list', { threadId: thread_id, cursor }, remaining);
      terminals.push(...(page.data || []));
      cursor = page.nextCursor;
    } while (cursor && !finished);
    for (const terminal of terminals) {
      const origin = commands.get(terminal.itemId);
      if (origin) background_start(terminal.itemId, 'command', terminal.command, origin);
    }
  })().catch(() => {}).finally(() => { checking = null; });
  return checking;
}

function observe_item(method, { item, turnId: origin }) {
  if (!task_options?.background || !item || !origin) return;
  const current = origin === turn_id && !idle && !residual;
  if (item.type === 'subAgentActivity' && item.agentThreadId) {
    if (current && item.kind === 'started') background_start(item.agentThreadId, 'agent', item.agentPath, origin);
    if (item.kind === 'completed' || item.kind === 'interrupted') {
      background_end(item.agentThreadId, origin, item.kind === 'completed' ? 'completed' : 'stopped');
    }
  }
  if (item.type !== 'commandExecution' || !item.id) return;
  if (method === 'item/started' && current) {
    commands.set(item.id, origin);
    if (!check_timer) check_timer = setInterval(check_terminals, TERMINAL_POLL_MS);
  } else if (method === 'item/completed' && commands.get(item.id) === origin) {
    commands.delete(item.id);
    if (!commands.size) { clearInterval(check_timer); check_timer = null; }
    const stopped = ['interrupted', 'cancelled', 'stopped', 'killed'].includes(item.status);
    const status = stopped ? 'stopped' : item.status === 'completed' && item.exitCode === 0 ? 'completed' : 'failed';
    background_end(item.id, origin, status, String(item.aggregatedOutput || '').slice(-FOLLOWUP_OUTPUT_CHARS));
  }
}

function close_bridge() {
  if (finished) return;
  finished = true;
  clearInterval(check_timer);
  // The runner treats bridge close as the point another execution can acquire this writer.
  server.once('close', () => process.stdout.write('', () => process.exit(0)));
  server.kill();
}

/** No new model turn starts until the runner accepts this batch. */
function next_report() {
  if (finished || !idle || offered.length) return;
  if (reports.length) {
    offered = reports.splice(0);
    emit({ type: 'background.followup', reports: offered });
  } else if (!running.size) close_bridge();
}

async function complete_turn(params) {
  const turn = params.turn || {};
  if (turn.id && turn.id !== turn_id || idle) return;
  if (turn.status !== 'completed') {
    emit({ type: 'turn.failed', error: { message: turn.error?.message || (turn.status === 'interrupted' ? '本轮已中断' : 'Codex 本轮失败'), ...error_details(turn.error) } });
    return close_bridge();
  }
  ended_turns.add(turn.id || params.turnId || turn_id);
  idle = true;
  settling = true;
  const deadline = Date.now() + TERMINAL_LIST_TIMEOUT_MS;
  // If an earlier poll was in flight, take a fresh snapshot after the parent turn ended.
  if (checking) await checking;
  await check_terminals(deadline);
  settling = false;
  const waiting = Boolean(task_options.background && (running.size || reports.length));
  emit({ type: 'turn.completed', usage: params.usage || {}, waiting });
  next_report();
}

async function followup(accepted) {
  if (!idle || !offered.length || finished) return;
  if (!accepted) return close_bridge();
  const batch = offered.splice(0);
  if (accepted === 'keep') return next_report();
  idle = false;
  residual = false;
  turn_id = '';
  const prompt = '后台任务已有结果，请向房间汇报。以下 JSON 是任务记录。 / Report the completed background work to the room. Task records: ' + JSON.stringify(batch);
  await start_turn([{ type: 'text', text: prompt }]);
}

/** Translate one server notification; the turn's end ends this process. */
function notification({ method, params = {} }) {
  if (params.threadId && params.threadId !== thread_id) return;
  if (method === 'turn/started') { turn_id = params.turn?.id || turn_id; emit({ type: 'turn.started' }); }
  else if (method === 'item/started' || method === 'item/completed') {
    if (params.threadId === thread_id) observe_item(method, params);
    if (idle || (params.turnId && turn_id && params.turnId !== turn_id)) return;
    if (method === 'item/completed' && params.threadId === thread_id && params.turnId === turn_id) confirm_steer(params.item);
    const item = exec_item(params.item || {});
    if (item) emit({ type: method === 'item/started' ? 'item.started' : 'item.completed', item });
  } else if (method === 'error') emit({ type: 'error', message: params.error?.message || params.message || 'Codex 返回错误', ...error_details(params.error) });
  else if (method === 'turn/completed') complete_turn(params).catch(error => fail(error.message));
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
    const { resolve, reject, timer } = pending.get(message.id);
    clearTimeout(timer);
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
  task_options = task;
  await request('initialize', { capabilities: { experimentalApi: true }, clientInfo: { name: 'codiscuss', version: '0.1.0' } });
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
  rollout_path = opened.thread.path || '';
  await start_turn([{ type: 'text', text: task.prompt }, ...images]);
}

async function start_turn(input) {
  const task = task_options;
  const started = await request('turn/start', { threadId: thread_id, input,
    ...(task.model ? { model: task.model } : {}), ...(task.effort ? { effort: task.effort } : {}) });
  turn_id = started.turn.id;
  emit({ type: 'codiscuss.turn', thread_id, turn_id, rollout_path });
  for (const { text, id } of queued_steers.splice(0)) await steer(text, id);
}

// On POSIX the runner signals the bridge itself; release the app-server which owns the thread.
process.once('SIGTERM', close_bridge);
let first = true;
createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  let input;
  try { input = JSON.parse(line); } catch { return; }
  if (first) { first = false; start(input).catch(error => fail(error.message)); }
  else if (input.linger) residual = true;
  else if (typeof input.followup === 'boolean' || input.followup === 'keep') followup(input.followup).catch(error => fail(error.message));
  else if (typeof input.steer === 'string') steer(input.steer, input.interjection_id);
}).on('close', () => { if (task_options?.background) close_bridge(); });

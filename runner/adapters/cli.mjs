/**
 * One headless CLI turn, shared by the CLI adapters (Codex CLI, agy CLI). The adapter supplies what differs:
 * `invocation(config, binding, task, user_home)` → `{args, input?, check?, on_session?}`, `lifecycle(state, event, task, bind)`
 * for its documented events, `events` for progress, and optionally `on_stderr(state, text)` and `exit_error(state)`.
 */
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { bind_access, launch_directory, not_sent, tree_killable } from './common.mjs';
import { adapter_capabilities } from './profiles.mjs';

const CLI_DIAGNOSTIC_CHARS = 1000;
// A hung CLI keeps its lease renewed forever when the room sets no execution limit, so cap every process.
const CLI_MAX_RUN_MS = 2 * 60 * 60_000;

/** Persist an emitted identity before the agent reads its execution credential file. */
function bind_cli_session(state, session_id, task) {
  if (typeof session_id !== 'string' || !session_id) throw new Error('CLI 未返回实际会话 ID');
  if (state.session_id && state.session_id !== session_id) throw new Error('CLI 返回的会话 ID 与绑定不符，已停止本次执行');
  task.on_binding(session_id);
  bind_access(task.access_path, session_id);
  state.session_id = session_id;
  state.initialized = true;
}

/** Record lifecycle events and tool commands with timestamps so slow stages can be located from the trace file. */
function trace_cli_event(event, task) {
  if (!task.on_trace) return;
  const item = event.item;
  const command = item?.command ? String(item.command).replace(/^.*?-Command\s+/, '').slice(0, 100) : '';
  const type = event.type ?? event.event ?? 'unknown';
  task.on_trace(item ? `${type}:${item.type}` : type, command ? { command } : {});
}

/** Distinguish process completion from successful CLI output and saved website work. */
function cli_exit_error(adapter, state, code, signal) {
  const own = adapter.exit_error?.(state);
  if (own) return own;
  if (state.error) return state.error;
  if (state.finished && state.completed) return '';
  if (code !== 0) return `CLI ${signal ? `被信号 ${signal} 终止` : `退出码 ${code}`}：${state.diagnostic}`;
  if (!state.initialized) return `CLI 未确认实际会话 ID：${state.diagnostic}`;
  if (!state.completed) return `CLI 未返回成功结束事件：${state.diagnostic}`;
  return '';
}

/** Parse complete UTF-8 JSON lines while keeping raw output in the private task log. */
function monitor_cli(adapter, child, binding, task) {
  const state = { child, session_id: binding.session_id || '', initialized: false, completed: false, error: '', diagnostic: '', responses: new Map(), denials: [] };
  const log_path = resolve(task.directory, `${adapter.id}-${task.id}.log`);
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const max_run_ms = Number(process.env.CODISCUSS_CLI_MAX_MS) || CLI_MAX_RUN_MS;
  state.limit_timer = setTimeout(() => { state.error = `CLI 运行超过 ${Math.round(max_run_ms / 1000)} 秒仍未结束，已终止`; child.kill(); }, max_run_ms);
  child.stdout.on('data', chunk => task.on_output(log_path, chunk));
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => {
    adapter.on_stderr?.(state, state.diagnostic + chunk);
    state.diagnostic = (state.diagnostic + chunk).slice(-CLI_DIAGNOSTIC_CHARS).trim();
    task.on_output(log_path, chunk);
  });
  lines.on('line', line => {
    if (!line.trim()) return;
    let event;
    try { event = JSON.parse(line); }
    catch { state.diagnostic = 'CLI 输出中存在无效 JSON，详情见本机日志'; return; }
    trace_cli_event(event, task);
    const phase = adapter.events.phase(event);
    if (phase) task.on_activity?.(phase, adapter.events.tool(event));
    const note = adapter.events.note(event, state.responses);
    if (note) task.on_note?.(note);
    try { adapter.lifecycle(state, event, task, session_id => bind_cli_session(state, session_id, task)); }
    catch (error) { state.error = error.message; child.kill(); }
  });
  child.once('close', (code, signal) => {
    clearTimeout(state.finish_timer);
    clearTimeout(state.limit_timer);
    task.on_trace?.('cli_closed', { code, signal, killed_after_completed: Boolean(state.finished) });
    if (!state.spawned) return;
    if (state.denials.length) task.on_denials?.(state.denials);
    const error = cli_exit_error(adapter, state, code, signal);
    if (error) task.on_failure(error);
    else task.on_exit?.(state.denial);
  });
  return state;
}

/** Start one headless CLI turn as the adapter describes it; resolves once the process runs. */
export async function cli_delivery(adapter, config, binding, task, spawn_process, user_home) {
  if (binding.session_id) {
    try { bind_access(task.access_path, binding.session_id); }
    catch (error) { throw not_sent(error); }
  }
  let invocation;
  try { invocation = adapter.invocation(config, binding, task, user_home); }
  catch (error) { throw not_sent(error); }
  if (invocation.check) {
    task.on_trace?.('permission_check_start');
    await invocation.check(spawn_process);
    task.on_trace?.('permission_check_done');
  }
  if (task.before_model_start) {
    try { await task.before_model_start(); }
    catch (error) { throw not_sent(error); }
  }
  if (invocation.on_session) {
    const on_binding = task.on_binding;
    task = { ...task, on_binding: session_id => { invocation.on_session(session_id); on_binding(session_id); } };
  }
  let child;
  try {
    child = spawn_process(config.executable, invocation.args, {
      cwd: launch_directory(config, task), windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, DISCUSS_ACCESS_FILE: task.access_path },
    });
  } catch (error) { throw not_sent(error); }
  tree_killable(child);
  const state = monitor_cli(adapter, child, binding, task);
  task.on_process(child);
  await new Promise((resolve_spawn, reject) => {
    child.once('spawn', () => { state.spawned = true; task.on_trace?.('cli_spawned'); resolve_spawn(); });
    child.once('error', error => state.spawned ? task.on_failure(error.message) : reject(not_sent(error)));
  });
  child.stdin.on('error', error => { if (error.code !== 'EPIPE') task.on_failure(error.message); });
  child.stdin.end(invocation.input);
  task.on_trace?.('prompt_sent');
  return { session_id: state.session_id, status: 'accepted', capabilities: adapter_capabilities(adapter.id).delivery };
}

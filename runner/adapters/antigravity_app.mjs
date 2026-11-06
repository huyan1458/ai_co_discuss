/**
 * Antigravity App adapter: each task is written as a request file for the CoDiscuss Sidecar the App runs
 * (`antigravity_sidecar.mjs`), which starts the turn in the App; its receipt is read back on a later check. A room turn
 * runs inside the App, so the runner can neither stop it nor see its progress. A private chat turn is followed through
 * the App's local language server, whose address and token the Sidecar hands over (unpublished internal RPC, tested on
 * App 2.29.0, 2026-11-06). Conversations are read through the agy adapter.
 */
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { atomic_json } from '../files.mjs';
import { antigravity_project, database_settings } from './antigravity_cli.mjs';
import { bind_access, EDIT_TOOLS, not_sent } from './common.mjs';

const IN_APP = { stoppable: false, progress: false };
const FOLLOWED = { stoppable: true, progress: true };
const SERVICE = 'exa.language_server_pb.LanguageServerService';
const UNPUBLISHED = 'App 内部接口未公开，App 版本可能已变';
// How a chat turn is waited for; tests shorten these.
export const CHAT_TIMING = { receipt_ms: 30000, poll_ms: 1000, start_ms: 30000, report_ms: 60000, wait_ms: 2 * 60 * 60 * 1000, rpc_ms: 15000, read_failures: 3 };

/** The running Sidecar's ready record, checked before anything is queued; errors mean nothing was sent. */
function ready_sidecar(config, binding, task) {
  const directory = resolve(config.ipc_directory);
  try {
    mkdirSync(directory, { recursive: true });
    const ready = JSON.parse(readFileSync(join(directory, 'ready.json'), 'utf8'));
    // Only a new conversation is created in the Sidecar's project; an existing one is reached from any project.
    if (!binding.session_id && (config.project_id || config.project_name || config.cwd)) {
      const project = antigravity_project(config);
      if (ready.project_id !== project.id) throw new Error('Sidecar 所属项目与配置不符，请先运行 setup-sidecar');
    }
    try { process.kill(ready.pid, 0); } catch { throw new Error('Antigravity Sidecar 尚未运行'); }
    if (binding.session_id) bind_access(task.access_path, binding.session_id);
    return ready;
  } catch (error) { throw not_sent(error); }
}

/** Write one immutable request; an existing one must be settled by its receipt, never sent twice. */
function queue_request(config, request) {
  const path = join(resolve(config.ipc_directory), `${request.id}.request.json`);
  if (existsSync(path)) throw new Error('Sidecar 请求已存在；必须核对回执，不自动重复发送');
  atomic_json(path, request);
}

/** Queue one immutable request for the official App-managed Sidecar. */
async function deliver(config, binding, task) {
  ready_sidecar(config, binding, task);
  queue_request(config, { id: task.id, event_id: Number(task.id.replace(/^free-/, '')), prompt: task.prompt,
    session_id: binding.session_id || '', access_path: task.access_path });
  return { session_id: binding.session_id || '', status: 'sidecar_pending', capabilities: IN_APP };
}

/** Queue a chat message and wait for the Sidecar to pass it to the App; the conversation ID it went into. */
async function send_chat(config, request) {
  queue_request(config, { ...request, chat: true });
  for (const until = Date.now() + CHAT_TIMING.receipt_ms; Date.now() < until; await sleep(Math.min(CHAT_TIMING.poll_ms, 500))) {
    const result = receipt(config, request.id);
    if (result?.status === 'accepted') return result.session_id;
    if (result) throw new Error(`Antigravity Sidecar 未能发送：${result.error || '状态不明'}`);
  }
  throw new Error(`Antigravity Sidecar ${Math.round(CHAT_TIMING.receipt_ms / 1000)} 秒内没有回执，发送状态不明；它稍后仍可能发到 App`);
}

/** Call one method of the App's language server; every failure names the method and why. */
async function app_rpc(server, method, body) {
  const base = /^https?:\/\//.test(server.address) ? server.address : `http://${server.address}`;
  let response;
  try {
    response = await fetch(`${base}/${SERVICE}/${method}`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(CHAT_TIMING.rpc_ms),
      headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', 'x-codeium-csrf-token': server.csrf_token },
      body: JSON.stringify(body) });
  } catch (error) { throw new Error(`连不上 Antigravity App 的本机服务（${method}：${error.cause?.code || error.message}）；App 可能已退出或重启`); }
  const text = await response.text();
  if (!response.ok) throw new Error(`Antigravity App 的 ${method} 返回 HTTP ${response.status}${text ? `：${text.slice(0, 200)}` : ''}（${UNPUBLISHED}）`);
  try { return JSON.parse(text || '{}'); }
  catch { throw new Error(`Antigravity App 的 ${method} 返回的不是 JSON（${UNPUBLISHED}）`); }
}

/** A conversation's run status and steps, read from the App; a missing field means the App changed. */
async function read_conversation(server, id) {
  const { status } = await app_rpc(server, 'GetCascadeTrajectory', { cascadeId: id });
  const { steps } = await app_rpc(server, 'GetCascadeTrajectorySteps', { cascadeId: id });
  if (typeof status !== 'string' || !Array.isArray(steps)) throw new Error(`Antigravity App 返回的对话状态缺少 status 或 steps（${UNPUBLISHED}）`);
  return { running: status === 'CASCADE_RUN_STATUS_RUNNING', idle: status === 'CASCADE_RUN_STATUS_IDLE', steps };
}

function step_state(step, failed = false) {
  if (/CANCELED|ERROR/.test(step.status || '') || failed) return 'failed';
  return step.status === 'CORTEX_STEP_STATUS_DONE' ? 'done' : 'running';
}

/** One App step as process log entries: a response's remark and tool calls (commands show as their own step), commands run. */
function step_entries(step, index) {
  // A command moved to the background shows as a generic running step until it finishes, then as the command itself.
  if (step.type === 'CORTEX_STEP_TYPE_GENERIC' && step.taskDetails) {
    return [{ id: `step-${index}`, kind: 'command', title: String(step.taskDetails.description || step.taskDetails.title || ''), state: step_state(step) }];
  }
  if (step.type === 'CORTEX_STEP_TYPE_RUN_COMMAND') {
    const command = step.runCommand || {};
    return [{ id: `step-${index}`, kind: 'command', title: String(command.commandLine || ''), body: String(command.combinedOutput?.full || ''),
      state: step_state(step, step.status === 'CORTEX_STEP_STATUS_DONE' && (command.exitCode ?? 0) !== 0) }];
  }
  if (step.type !== 'CORTEX_STEP_TYPE_PLANNER_RESPONSE') return [];
  const response = step.plannerResponse || {};
  const calls = (response.toolCalls || []).filter(call => call.name !== 'run_command');
  return [...((response.toolCalls || []).length && response.response ? [{ id: `step-${index}`, kind: 'message', body: response.response, state: 'done' }] : []),
    ...calls.map(call => ({ id: `step-${index}-${call.id}`, kind: EDIT_TOOLS.test(call.name || '') ? 'edit' : 'tool',
      title: `${call.name} ${call.argumentsJson || ''}`.trim(), state: step_state(step) }))];
}

/**
 * Whether an idle App is still inside this turn. A command moved to the background leaves the App idle with an interim
 * remark; when it finishes, the App reports it as a message from `<conversation>/task-N` and runs again for the reply.
 * So the turn goes on while a command or task step runs, while a finished task has not reported back (up to
 * `report_ms` after it was first seen finished, as a report may never come), or while the last step is an unanswered
 * message. `finished` remembers when each task was first seen finished.
 */
function turn_pending(steps, finished, now = Date.now()) {
  if (steps.at(-1)?.type === 'CORTEX_STEP_TYPE_SYSTEM_MESSAGE') return true;
  const messages = steps.filter(step => step.type === 'CORTEX_STEP_TYPE_SYSTEM_MESSAGE').map(step => String(step.systemMessage?.message || ''));
  return steps.some(step => {
    if (!['CORTEX_STEP_TYPE_GENERIC', 'CORTEX_STEP_TYPE_RUN_COMMAND'].includes(step.type)) return false;
    if (/RUNNING|GENERATING|PENDING/.test(step.status || '')) return true;
    const task = step.taskDetails?.id;
    if (!task || /CANCELED|ERROR/.test(step.status || '') || messages.some(message => message.includes(`sender=${task} `))) return false;
    if (!finished.has(task)) finished.set(task, now);
    return now - finished.get(task) < CHAT_TIMING.report_ms;
  });
}

/** Follow the turn from its first step until the App goes idle with nothing pending, it is stopped, or the wait runs out. */
async function follow_chat(context) {
  const { server, task, state, start } = context;
  const log_path = resolve(task.directory, `antigravity-${task.id}.log`);
  const logged = new Map(), noted = new Set(), finished = new Map();
  const log = entry => {
    const line = JSON.stringify({ type: 'codiscuss.entry', entry });
    if (logged.get(entry.id) !== line) { logged.set(entry.id, line); task.on_output?.(log_path, `${line}\n`); }
  };
  const began = Date.now();
  let failures = 0, started = false;
  try {
    for (;;) {
      if (state.stop) return task.on_failure?.(await state.stop);
      if (Date.now() - began > CHAT_TIMING.wait_ms) return task.on_failure?.('私聊超过等待上限（2 小时）仍未结束，已不再等待；这一轮可能仍在 Antigravity App 中运行');
      let conversation = null;
      try { conversation = await read_conversation(server, state.session_id); failures = 0; }
      catch (error) { if (++failures >= CHAT_TIMING.read_failures) return task.on_failure?.(`读取 Antigravity App 对话失败：${error.message}`); }
      if (conversation) {
        conversation.steps.slice(start).forEach((step, offset) => {
          const index = start + offset;
          for (const entry of step_entries(step, index)) log(entry);
          const text = step.type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE' && step.status === 'CORTEX_STEP_STATUS_DONE' && step.plannerResponse?.response?.trim();
          if (text && !noted.has(index)) { noted.add(index); task.on_note?.(text); }
        });
        started ||= conversation.running || noted.size > 0;
        if (started && conversation.idle && !turn_pending(conversation.steps.slice(start), finished)) return state.stop ? task.on_failure?.(await state.stop) : task.on_exit?.();
        if (!started && Date.now() - began > CHAT_TIMING.start_ms) {
          return task.on_failure?.(`Antigravity App 受理了消息，但 ${Math.round(CHAT_TIMING.start_ms / 1000)} 秒内没有开始这一轮；请在 App 里查看`);
        }
      }
      await sleep(CHAT_TIMING.poll_ms);
    }
  } catch (error) { return task.on_failure?.(error.message); }
}

/**
 * Stop the turn and its background commands: Cancel ends a running turn (it refuses an idle one), ForceStopCascadeTree
 * also ends commands moved to the background, which Cancel leaves running. Resolves to the reason the turn reports.
 */
async function stop_turn(server, session_id) {
  const cancel = await app_rpc(server, 'CancelCascadeInvocation', { cascadeId: session_id }).then(() => null, error => error);
  try { await app_rpc(server, 'ForceStopCascadeTree', { conversationId: session_id }); return '已停止'; }
  catch (error) {
    return cancel ? `未能停止：${error.message}；这一轮可能仍在 Antigravity App 中运行`
      : `已停止这一轮，但未能停止后台命令（${error.message}），后台命令可能仍在运行`;
  }
}

/**
 * A private chat turn in the member's App conversation: the line goes in through the Sidecar's agentapi, and the turn is
 * followed, stopped and steered through the App's language server. A line sent while the turn runs joins it at the next
 * step boundary. Without the server's address and token (an older Sidecar, or an App that no longer passes them) the line
 * is still sent, but the turn reports that no reply can be read.
 */
async function chat(config, binding, task) {
  const ready = ready_sidecar(config, binding, task);
  const server = ready.language_server?.address && ready.language_server?.csrf_token ? ready.language_server : null;
  let start = 0;
  if (server && binding.session_id) {
    let conversation;
    try { conversation = await read_conversation(server, binding.session_id); }
    catch (error) { throw not_sent(error); }
    if (conversation.running) throw not_sent(new Error('这个 Antigravity App 对话正在运行，等它结束再私聊，或直接在 App 里对话'));
    start = conversation.steps.length;
  }
  const session_id = await send_chat(config, { id: task.id, prompt: task.prompt, session_id: binding.session_id || '', access_path: task.access_path });
  if (!server) {
    setImmediate(() => task.on_failure?.('消息已发到 Antigravity App 对话，但拿不到回复：Sidecar 没有提供 App 本机服务的地址与令牌'
      + '（旧版 Sidecar 需重启 App 后更新，或 App 版本已变）；请在 App 里查看这一轮'));
    return { session_id, status: 'accepted', capabilities: IN_APP };
  }
  const state = { session_id, running: true, stop: null, steers: 0 };
  const child = new EventEmitter();
  child.kill = () => {
    state.stop ||= stop_turn(server, session_id);
    return true;
  };
  task.on_process?.(child);
  follow_chat({ server, task, state, start }).finally(() => { state.running = false; child.emit('close', 0); });
  // An interjection the App cannot take now (the turn ended, or reading or sending failed) waits as the next chat line.
  const steer = async text => {
    try {
      if (!state.running || state.stop || !(await read_conversation(server, session_id)).running) return false;
      await send_chat(config, { id: `${task.id}-steer-${++state.steers}`, prompt: text, session_id, access_path: task.access_path });
    } catch { return false; }
    task.on_output?.(resolve(task.directory, `antigravity-${task.id}.log`), `${JSON.stringify({ type: 'codiscuss.interjection', text })}\n`);
    return true;
  };
  return { session_id, status: 'accepted', capabilities: FOLLOWED, steer };
}

/** The App keeps its own conversation store, apart from agy's. */
function session_path(session_id, env = process.env, home = homedir()) {
  const file = join(home, '.gemini', 'antigravity', 'conversations', `${session_id}.db`);
  return existsSync(file) ? file : '';
}

/** Whether the App stored a conversation by that ID on this machine. */
function session_exists(session_id, { env = process.env, home = homedir() } = {}) {
  return Boolean(session_id && session_path(session_id, env, home));
}

/** Read a Sidecar's durable receipt for one task without resubmitting an uncertain request; null until it answers. */
function receipt(config, id) {
  const path = join(resolve(config.ipc_directory), `${id}.result.json`);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

/** Explicitly install an App-managed Sidecar; preserve unrelated application settings. */
export function setup_sidecar(config, root = join(homedir(), '.gemini', 'config')) {
  const project = antigravity_project(config, root);
  const directory = resolve(config.ipc_directory);
  mkdirSync(directory, { recursive: true });
  const id = `codiscuss-${createHash('sha256').update(directory).digest('hex').slice(0, 12)}`;
  const sidecar = join(root, 'sidecars', id);
  mkdirSync(sidecar, { recursive: true });
  // Installed Sidecars keep this entry path, so it stays at runner/discussion_sidecar.mjs.
  atomic_json(join(sidecar, 'sidecar.json'), { command: process.execPath,
    args: [fileURLToPath(new URL('../discussion_sidecar.mjs', import.meta.url))], restart_policy: 'on-failure',
    display_name: 'CoDiscuss', env: { CODISCUSS_IPC_DIRECTORY: directory } });
  const path = join(root, 'config.json');
  const current = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  // App 2.23 upgrades legacy entries by cloning their project. Use its observed current
  // schema so the explicitly selected existing project remains the actual destination.
  atomic_json(path, { ...current, sidecars: { ...current.sidecars,
    [id]: { ...current.sidecars?.[id], enabled: true, projectId: project.id, schemaVersion: 1 } } });
  return { sidecar_id: id, project_id: project.id, cwd: config.cwd || null };
}

/** Antigravity App's behaviour; its static facts are in profiles.mjs. */
export const antigravity = {
  id: 'antigravity',
  validate(participant) {
    if (!participant.ipc_directory) throw new Error('缺少 Antigravity Sidecar IPC 目录');
  },
  // Explicit install of the Sidecar the App runs for this member (the setup-sidecar command).
  setup: setup_sidecar,
  deliver, receipt, chat,
  // The App's conversations are read like agy's for the model they ran with; they cannot be branched from here.
  session: { path: session_path, exists: session_exists, owns: session_exists, branch: null,
    settings: (id, { env = process.env, home = homedir() } = {}) => database_settings(session_path(id, env, home)) },
  models: null,
};

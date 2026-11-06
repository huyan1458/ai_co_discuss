/**
 * Codex App adapter: tasks go into a chat of the running Codex desktop, through its app-tools pipe or `codex queue`.
 * The turn runs inside the App, so the runner can neither stop it nor see its progress. Threads are stored like the
 * CLI's, so sessions and models come from the Codex CLI adapter. A private chat turn is the exception: the runner
 * follows it by reading the chat, and can force it to stop.
 */
import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { CodexAppClient } from './codex_app_client.mjs';
import { branch, desktop_thread, session_exists, session_path, session_settings } from './codex_cli.mjs';
import { bind_access, CALL_TIMEOUT_MS, not_sent, read_json, run_program, same_path } from './common.mjs';

// The desktop has no stop or interrupt tool (its tool list, checked 2026-10-30), and the turn's output stays in the App.
const IN_APP = { stoppable: false, progress: false };

/** Match the real saved project and its directory; a prompt cannot grant file access. */
export async function codex_target(app, config) {
  if (!config.project_id && !config.project_name && !config.cwd) return { type: 'projectless' };
  const projects = (await app.list_projects(config.source_thread_id)).filter(item => item.hostId === 'local');
  const matching = projects.filter(item => (!config.project_id || item.projectId === config.project_id)
    && (!config.project_name || item.label === config.project_name)
    && (!config.cwd || same_path(item.path, config.cwd)));
  if (matching.length !== 1) throw new Error('Codex 项目与 cwd 无法唯一匹配；请先在 App 添加该目录，核对 project_id/project_name/cwd');
  return { type: 'project', projectId: matching[0].projectId, environment: { type: 'local' } };
}

// `create_thread` copies the source chat's three latest user messages (with the replies before them) into the new chat's
// record, as `sender_user_messages`; only typed user messages count, not messages sent through the App's tools (tested
// 2026-11-06). New member chats therefore come from a chat the runner made itself and archived at once: its only input
// came through the tools, so it has nothing to copy. Making it copies the configured source's messages once, into that
// archived chat only. The source must be a real chat (an unknown id is refused), archived ones included.
const SOURCE_FILE = 'codex-app-source.json';
const SOURCE_TITLE = 'CoDiscuss · 新建会话来源（已归档，请勿在此输入）';
const SOURCE_PROMPT = 'CoDiscuss 用这个已归档的会话作为新建成员会话的来源，不需要处理或回复。';
const SOURCE_READ = { turnLimit: 10 };

/** The runner's own record of the source chat, in the local service directory (never sent to the site). */
export function source_file(env = process.env, home = homedir()) {
  return join(env.DISCUSS_SERVICE_HOME ? resolve(env.DISCUSS_SERVICE_HOME) : join(home, '.codiscuss'), SOURCE_FILE);
}

/** The chat new member chats are created from: the saved one while it exists and nobody typed in it, else a fresh one. */
export async function creation_source(app, config, file) {
  const saved = read_json(file).thread_id;
  if (saved) {
    try {
      const data = await app.read_thread(saved, SOURCE_READ);
      if (!data.turns.some(turn => (turn.items || []).some(item => item.type === 'userMessage'))) return saved;
    } catch { /* Deleted or unreadable: make a new one. */ }
  }
  const made = await app.create_thread(config.source_thread_id, SOURCE_PROMPT, SOURCE_TITLE, { type: 'projectless' });
  // Archiving also stops the turn the prompt started, so it never reaches the model's answer.
  await app.set_archived(made.thread_id, true);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ thread_id: made.thread_id }));
  return made.thread_id;
}

/** Whether the running App has not loaded a chat; when the App cannot tell, the queue is used as before. */
async function unloaded(config, thread_id) {
  const app = new CodexAppClient(config.pipe_path);
  try { await app.open(); return await app.thread_status(thread_id) === 'notLoaded'; }
  catch { return false; }
  finally { app.close(); }
}

/**
 * Pass an interjection into the chat's running turn through the App itself, which takes it at the turn's next step.
 * Sent only while the chat is active: in an idle chat the same message would start a turn the room never asked for.
 */
function app_steer(config, thread_id) {
  return async text => {
    const app = new CodexAppClient(config.pipe_path);
    try {
      await app.open();
      if (await app.thread_status(thread_id) !== 'active') return false;
      await app.send_message(thread_id, text);
      return true;
    } finally { app.close(); }
  };
}

/** Deliver one task to Codex's real App, with the original chat reused afterward. */
async function deliver(config, binding, task, _spawn, user_home = homedir()) {
  if (binding.session_id) {
    try { bind_access(task.access_path, binding.session_id); }
    catch (error) { throw not_sent(error); }
    // `codex queue` reaches only a chat the App has loaded; a fork made after a rewind, or a chat after the App restarted,
    // is not loaded until a message is sent through the App itself (tested on App tools, 2026-10).
    if (await unloaded(config, binding.session_id)) {
      const app = new CodexAppClient(config.pipe_path);
      try { await app.open(); await app.send_message(binding.session_id, task.prompt); }
      finally { app.close(); }
      return { session_id: binding.session_id, status: 'accepted', capabilities: IN_APP, steer: app_steer(config, binding.session_id) };
    }
    const receipt = await run_program(config.executable, ['queue', '--thread', binding.session_id, '--message', task.prompt], { timeout: CALL_TIMEOUT_MS });
    return { session_id: binding.session_id, status: 'accepted', receipt, capabilities: IN_APP, steer: app_steer(config, binding.session_id) };
  }
  const app = new CodexAppClient(config.pipe_path);
  try {
    let target, source;
    try {
      await app.open();
      target = await codex_target(app, config);
      source = await creation_source(app, config, source_file(process.env, user_home));
    } catch (error) { throw not_sent(error); }
    const result = await app.create_thread(source, task.prompt, `CoDiscuss · ${task.participant}`, target);
    task.on_binding(result.thread_id);
    bind_access(task.access_path, result.thread_id);
    return { session_id: result.thread_id, status: 'accepted', capabilities: IN_APP, steer: app_steer(config, result.thread_id) };
  } finally { app.close(); }
}

// A private chat turn is read back from the chat itself (remarks and finished steps), and archiving the chat stops it.
const CHAT_CAPABILITIES = { stoppable: true, progress: true };
const CHAT_POLL_MS = 500;
// The same ceiling as a CLI turn; the App keeps running the turn after the runner stops waiting.
const CHAT_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const CHAT_READ = { turnLimit: 2, includeOutputs: true, maxOutputCharsPerItem: 4000 };
// Consecutive failed reads (about 10 seconds) before the turn is reported lost, e.g. the App was closed.
const CHAT_READ_FAILURES = 20;
const STOP_SETTLE_MS = 5000;
const STOP_CHECK_MS = 250;
const UNARCHIVE_ATTEMPTS = 3;
const XML_ENTITIES = { '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&amp;': '&' };

/** The text one App-delivered message carried in `<codex_delegation><input>`, or null for other items. */
function delegated_input(item) {
  if (item?.type !== 'functionCallOutput' || item.name !== 'send_message_to_thread') return null;
  const match = /<input>([\s\S]*?)(?:<\/input>|$)/.exec(item.output?.text || '');
  return match ? match[1].replace(/&(lt|gt|quot|apos|amp);/g, entity => XML_ENTITIES[entity]).trim() : null;
}

/** The turn that took this chat line, and the line's place in it; items read before sending are earlier lines. */
function find_turn(snapshot, prompt, seen) {
  const text = prompt.trim();
  for (const turn of snapshot.turns) {
    const index = (turn.items || []).findIndex(item => {
      const input = !seen.has(item.id) && delegated_input(item);
      return input && (input === text || (item.output.truncated && text.startsWith(input)));
    });
    if (index >= 0) return { turn, index };
  }
  return null;
}

/** The command a step ran, without the shell wrapper the App adds around it. */
function command_title(command = '') {
  const inner = /\s-Command\s+(['"])([\s\S]*)\1\s*$/.exec(command);
  return inner ? inner[2] : command;
}

function step_state(item) {
  if (item.status === 'inProgress') return 'running';
  return ['failed', 'declined'].includes(item.status) || (item.exitCode ?? 0) !== 0 ? 'failed' : 'done';
}

/** One finished item of the turn as a process log entry, or null for items the chat page does not show. */
function chat_entry(item) {
  const id = item.id;
  if (item.type === 'agentMessage') return item.phase === 'commentary' && item.text ? { id, kind: 'message', body: item.text, state: 'done' } : null;
  if (item.type === 'commandExecution') return { id, kind: 'command', title: command_title(item.command), body: item.output?.text || '', state: step_state(item) };
  if (item.type === 'webSearch') return { id, kind: 'search', title: item.query || item.action?.query || '', state: 'done' };
  if (item.type === 'fileChange') {
    const changes = item.changes || [];
    return { id, kind: 'edit', title: changes.map(change => change.path).join('\n'), body: changes.map(change => change.diff?.text || '').filter(Boolean).join('\n'), state: step_state(item) };
  }
  if (item.type === 'mcpToolCall') return { id, kind: 'tool', title: [item.server, item.tool].filter(Boolean).join('.') || 'MCP 工具', state: step_state(item) };
  return null;
}

/** The turn's reply: its final answer, else its last remark that is not commentary. */
function chat_reply(items) {
  const messages = items.filter(item => item.type === 'agentMessage' && item.text);
  return (messages.findLast(item => item.phase === 'final_answer') || messages.findLast(item => item.phase !== 'commentary'))?.text || '';
}

/** Report how the turn that took this line ended. */
function finish_turn(turn, items, task, log) {
  if (turn.status === 'completed') {
    const reply = chat_reply(items);
    if (!reply) return task.on_failure?.('它没有给出文字回复');
    task.on_note?.(reply);
    return task.on_exit?.();
  }
  const reason = turn.status === 'interrupted' ? '这一轮在 Codex App 中被中断' : turn.error?.message || 'Codex App 中这一轮未正常结束';
  log({ id: `turn-${turn.id}`, kind: 'error', title: reason, state: 'failed' });
  return task.on_failure?.(reason);
}

/** Log the turn's finished items; the turn once it is over, else null. */
function read_progress(snapshot, context, log) {
  const found = find_turn(snapshot, context.task.prompt, context.seen);
  if (!found) return null;
  const items = found.turn.items.slice(found.index + 1);
  for (const item of items) { const entry = chat_entry(item); if (entry) log(entry); }
  const newest = snapshot.turns[0] === found.turn;
  if (found.turn.status === 'inProgress' || (newest && snapshot.thread.status.type === 'active')) return null;
  return { turn: found.turn, items };
}

/** Poll the chat until the turn that took this line ends, it is stopped, or the wait runs out. */
async function follow_chat(context) {
  const { task, state, thread_id } = context;
  const log_path = resolve(task.directory, `codex-${task.id}.log`);
  const logged = new Map();
  const log = entry => {
    const line = JSON.stringify({ type: 'codiscuss.entry', entry });
    if (logged.get(entry.id) !== line) { logged.set(entry.id, line); task.on_output?.(log_path, `${line}\n`); }
  };
  const deadline = Date.now() + context.timeout_ms;
  let app = context.app;
  let failures = 0;
  try {
    for (;;) {
      if (state.stop) return task.on_failure?.(await state.stop);
      if (Date.now() > deadline) return task.on_failure?.('私聊超过等待上限（2 小时）仍未结束，已不再等待；这一轮可能仍在 Codex App 中运行');
      let snapshot = null;
      try { app ||= await context.connect(); snapshot = await app.read_thread(thread_id, CHAT_READ); failures = 0; }
      catch (error) {
        app?.close(); app = null;
        if (++failures >= CHAT_READ_FAILURES) return task.on_failure?.(`读取 Codex App 会话失败：${error.message}`);
      }
      const ended = snapshot && read_progress(snapshot, context, log);
      if (ended) return state.stop ? task.on_failure?.(await state.stop) : finish_turn(ended.turn, ended.items, task, log);
      await sleep(context.poll_ms);
    }
  } finally { app?.close(); }
}

/**
 * The App has no stop: archiving the chat interrupts its turn, and restoring it right after keeps the chat usable.
 * The chat leaves the App's sidebar for a moment; a command the turn started may keep running in the background.
 */
async function force_stop(connect, thread_id) {
  let app;
  try { app = await connect(); await app.set_archived(thread_id, true); }
  catch (error) { app?.close(); return `未能停止：${error.message}；这一轮可能仍在 Codex App 中运行`; }
  try {
    for (const until = Date.now() + STOP_SETTLE_MS; Date.now() < until; await sleep(STOP_CHECK_MS)) {
      const snapshot = await app.read_thread(thread_id, { turnLimit: 1 }).catch(() => null);
      if (snapshot && snapshot.thread.status.type !== 'active') break;
    }
    for (let attempt = 1; ; attempt++) {
      try { await app.set_archived(thread_id, false); return '已停止'; }
      catch (error) {
        if (attempt >= UNARCHIVE_ATTEMPTS) return `已停止，但会话仍在 Codex App 的归档里，请在 App 中取消归档：${error.message}`;
        await sleep(STOP_CHECK_MS);
      }
    }
  } finally { app.close(); }
}

/** Pass an interjection into the chat while its turn is still running; false once it is over. */
function chat_steer(connect, thread_id, state) {
  return async text => {
    if (!state.running || state.stop) return false;
    const app = await connect();
    try {
      if ((await app.read_thread(thread_id, { turnLimit: 1 })).thread.status.type !== 'active') return false;
      await app.send_message(thread_id, text);
      return true;
    } finally { app.close(); }
  };
}

async function open_app(config) {
  const app = new CodexAppClient(config.pipe_path);
  try { await app.open(); return app; }
  catch (error) { app.close(); throw error; }
}

/**
 * A private chat turn in the member's own App chat: the line goes in through the App with the chat itself as its source,
 * so no other chat's messages travel with it, and the chat is read back every half second for its steps and reply.
 * `options` (`connect`, `poll_ms`, `timeout_ms`) replace the App and the timings in tests.
 */
export async function codex_chat(config, binding, task, options = {}) {
  const thread_id = binding.session_id;
  if (!thread_id) throw not_sent(new Error('这位成员还没有 Codex App 会话，先在房间里给它派一次任务'));
  const connect = options.connect || (() => open_app(config));
  let app;
  let seen;
  try {
    app = await connect();
    const before = await app.read_thread(thread_id, CHAT_READ);
    seen = new Set(before.turns.flatMap(turn => (turn.items || []).map(item => item.id)));
  } catch (error) { app?.close(); throw not_sent(error); }
  try { await app.send_message(thread_id, task.prompt); }
  catch (error) { app.close(); throw new Error(`Codex App 没有接收这条私聊（会话可能已归档或已删除）：${error.message}`); }
  const state = { running: true, stop: null };
  const handle = new EventEmitter();
  handle.kill = () => { if (state.running && !state.stop) state.stop = force_stop(connect, thread_id); return true; };
  // The force stop archives the user's chat for a moment; the runner's own shutdown must not leave it archived.
  handle.stop_on_shutdown = false;
  task.on_process?.(handle);
  follow_chat({ app, connect, task, state, thread_id, seen, poll_ms: options.poll_ms ?? CHAT_POLL_MS, timeout_ms: options.timeout_ms ?? CHAT_TIMEOUT_MS })
    .catch(error => task.on_failure?.(error.message))
    .finally(() => { state.running = false; handle.emit('close', 0); });
  return { session_id: thread_id, status: 'accepted', capabilities: CHAT_CAPABILITIES, steer: chat_steer(connect, thread_id, state) };
}

/** Codex App's behaviour; its static facts are in profiles.mjs. */
export const codex = {
  id: 'codex',
  /** A new chat is created from an actual source chat in the App. */
  validate(participant) {
    if (!participant.source_thread_id && !participant.session_id) throw new Error('Codex 新建入口需要实际来源聊天 ID');
  },
  deliver,
  chat: (config, binding, task) => codex_chat(config, binding, task),
  session: { path: session_path, exists: session_exists, owns: desktop_thread, branch, settings: session_settings },
  models: null,
};

/**
 * Codex App adapter: tasks go into a chat of the running Codex desktop, through its app-tools pipe or `codex queue`.
 * Room turns run inside the App, so the runner cannot stop them; when the chat can be read beforehand, the runner polls
 * `read_thread` for the matched turn's progress, steps, edits and end, degrading to no progress when the App cannot be
 * read. Threads are stored like the CLI's, so sessions and models come from the Codex CLI adapter. A private chat turn
 * also reads the reply back and can force the turn to stop.
 */
import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { CodexAppClient } from './codex_app_client.mjs';
import { branch, codex_skills, desktop_thread, list_sessions, preview_session, remove_session, session_exists, session_path, session_settings } from './codex_cli.mjs';
import { bind_access, CALL_TIMEOUT_MS, not_sent, read_json, run_program, same_path, shell_written_paths } from './common.mjs';

// The desktop has no stop or interrupt tool (its tool list, checked 2026-10-30).
const IN_APP = { stoppable: false, progress: false };
const IN_APP_PROGRESS = { stoppable: false, progress: true };

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

/**
 * Pass an interjection into the chat's running turn through the App itself, which takes it at the turn's next step.
 * Sent only while the chat is active: in an idle chat the same message would start a turn the room never asked for.
 */
function app_steer(config, thread_id, task = null, connect = null) {
  const log_path = task?.directory && task?.id ? resolve(task.directory, `codex-${task.id}.log`) : '';
  return async text => {
    const app = connect ? await connect() : await open_app(config);
    try {
      const status = typeof app.thread_status === 'function'
        ? await app.thread_status(thread_id)
        : (await app.read_thread(thread_id, { turnLimit: 1 })).thread.status.type;
      if (status !== 'active') return false;
      await app.send_message(thread_id, text);
      if (log_path) task.on_output?.(log_path, `${JSON.stringify({ type: 'codiscuss.interjection', text })}\n`);
      return true;
    } finally { app.close(); }
  };
}

// A room turn runs in the App, which the runner cannot stop; when the chat can be read beforehand, it follows only the
// turn matching this task's prompt for progress, steps, edits and end, without pulling in private turns in the same chat.
const ROOM_POLL_MS = 2000;
const ROOM_READ = { turnLimit: 3, includeOutputs: true, maxOutputCharsPerItem: 4000 };
const ROOM_DELEGATION_NAMES = ['send_message_to_thread', 'create_thread'];
const TOOL_ITEM_TYPES = new Set(['commandExecution', 'fileChange', 'webSearch', 'mcpToolCall']);

/** The chat's status, latest turns and item ids before a room task goes in, or null when the App cannot be read. */
async function room_before(config, thread_id, connect) {
  let app;
  try {
    app = await connect();
    const data = await app.read_thread(thread_id, ROOM_READ);
    return {
      status: data.thread.status.type,
      turns: new Set(data.turns.map(turn => turn.id)),
      items: new Set(data.turns.flatMap(turn => (turn.items || []).map(item => item.id)).filter(Boolean)),
    };
  } catch { return null; }
  finally { app?.close(); }
}

/** Literal file paths written by one finished Codex App turn item; running, failed or declined items claim nothing. */
function app_item_edits(item) {
  if (!item || ['inProgress', 'failed', 'declined'].includes(item.status)) return [];
  if (item.type === 'fileChange') return (item.changes || []).map(change => String(change?.path || '')).filter(Boolean);
  if (item.type === 'commandExecution' && (item.exitCode ?? 0) === 0) return shell_written_paths(item.command);
  return [];
}

/** Map one Codex App turn item to `{phase, tool}` for the execution timeline, or null when it is not an activity step. */
function app_item_activity(item) {
  if (!item) return null;
  if (item.type === 'commandExecution') return { phase: 'command', tool: '' };
  if (item.type === 'fileChange') return { phase: 'editing', tool: '' };
  if (item.type === 'webSearch') return { phase: 'tool', tool: 'web_search' };
  if (item.type === 'mcpToolCall') return { phase: 'tool', tool: String(item.tool || '') };
  if (item.type === 'reasoning') return { phase: 'thinking', tool: '' };
  if (item.type === 'agentMessage' && item.text) return { phase: 'writing', tool: '' };
  return null;
}

/** Deduplicated `codiscuss.entry` writer shared by room turns and private chat turns. */
function entry_logger(task) {
  const log_path = task?.directory && task?.id ? resolve(task.directory, `codex-${task.id}.log`) : '';
  const logged = new Map();
  return entry => {
    if (!log_path || !entry) return;
    const line = JSON.stringify({ type: 'codiscuss.entry', entry });
    if (logged.get(entry.id) !== line) { logged.set(entry.id, line); task.on_output?.(log_path, `${line}\n`); }
  };
}

/** Find or follow the one turn matching this room task; ignores unrelated or private turns in the same chat. */
function resolve_room_turn(snapshot, prompt, seen, matched) {
  const turns = snapshot.turns || [];
  if (!matched) {
    const found = find_turn(snapshot, prompt, seen.items, { allow_user: true, names: ROOM_DELEGATION_NAMES, seen_turns: seen.turns });
    if (!found) return null;
    matched = { turn_id: found.turn.id, item_id: found.item_id, start_index: found.index };
  }
  const turn = turns.find(item => item.id === matched.turn_id);
  if (!turn) return { matched, turn: null, items: [], ended: true };
  const all = turn.items || [];
  // `read_thread` keeps only the latest page of items (default 32), so once our prompt item scrolls off the front of
  // this already-matched turn, every remaining item in `all` occurred after it.
  const anchor = matched.item_id ? all.findIndex(item => item.id === matched.item_id) : matched.start_index;
  const items = anchor >= 0 ? all.slice(anchor + 1) : all;
  const ended = turn.status !== 'inProgress' && (turns[0] !== turn || snapshot.thread?.status?.type !== 'active');
  return { matched, turn, items, ended };
}

/** Report deduplicated steps, timeline activities, progress notes and file edits for the matched room turn. */
function report_room_items(turn, items, state, task, log) {
  let just_finished_tool = false;
  let last_new_kind = '';
  for (const [index, item] of items.entries()) {
    if (!item) continue;
    const key = item.id || `${turn.id}:${index}`;
    const entry = chat_entry(item, key);
    if (entry) log(entry);
    if (!state.activities.has(key)) {
      const activity = app_item_activity(item);
      if (activity) {
        state.activities.add(key);
        task.on_activity?.(activity.phase, activity.tool, key);
        last_new_kind = item.status === 'inProgress' ? 'inProgress' : activity.phase;
      }
    }
    if (TOOL_ITEM_TYPES.has(item.type) && item.status !== 'inProgress' && !state.finished_tools.has(key)) {
      state.finished_tools.add(key);
      just_finished_tool = true;
    }
    if (item.type === 'agentMessage' && item.phase === 'commentary' && !state.notes.has(key)) {
      const text = String(item.text || '').trim();
      if (text) { state.notes.add(key); task.on_note?.(text); }
    }
    if (item.status !== 'inProgress' && !state.edits.has(key)) {
      state.edits.add(key);
      const paths = app_item_edits(item);
      if (paths.length) task.on_edits?.(paths);
    }
  }
  if (!state.started && !state.activities.size && turn.status === 'inProgress') {
    state.started = true;
    task.on_activity?.('thinking');
  } else if (turn.status === 'inProgress' && just_finished_tool && !['inProgress', 'writing', 'thinking'].includes(last_new_kind)) {
    task.on_activity?.('thinking');
  }
}

/**
 * Poll the chat until the turn matching `task.prompt` ends, logging its steps into `codex-${task.id}.log`, reporting
 * deduplicated timeline activities, notes and file edits along the way, and calling `on_turn_end` when finished.
 * Gives up quietly after the ceiling or when the App stays unreadable; the room then falls back to the site's hold.
 * `options` (`connect`, `poll_ms`, `timeout_ms`) replace the App and the timings in tests.
 */
export async function watch_room_turn(config, thread_id, before, task, options = {}) {
  const connect = options.connect || (() => open_app(config));
  const seen = before instanceof Set ? { turns: before, items: new Set() }
    : { turns: before?.turns || new Set(), items: before?.items || new Set() };
  const deadline = Date.now() + (options.timeout_ms ?? CHAT_TIMEOUT_MS);
  const state = { activities: new Set(), finished_tools: new Set(), notes: new Set(), edits: new Set(), started: false };
  const log = entry_logger(task);
  task.on_edits?.([]);
  let app = null, failures = 0, matched = null;
  try {
    while (Date.now() < deadline) {
      await sleep(options.poll_ms ?? ROOM_POLL_MS);
      let snapshot;
      try { app ||= await connect(); snapshot = await app.read_thread(thread_id, ROOM_READ); failures = 0; }
      catch { app?.close(); app = null; if (++failures >= CHAT_READ_FAILURES) return; continue; }
      const found = resolve_room_turn(snapshot, task.prompt, seen, matched);
      if (!found) continue;
      matched = found.matched;
      if (found.turn) report_room_items(found.turn, found.items, state, task, log);
      if (found.ended) {
        if (found.turn && found.turn.status !== 'completed') {
          const reason = found.turn.status === 'interrupted' ? '这一轮在 Codex App 中被中断' : found.turn.error?.message || 'Codex App 中这一轮未正常结束';
          log({ id: `turn-${found.turn.id}`, kind: 'error', title: reason, state: 'failed' });
        }
        return task.on_turn_end?.();
      }
    }
  } finally { app?.close(); }
}

/** What a room delivery into this chat can do: never stopped; progress and end reported when the chat was readable beforehand. */
function room_delivery(config, thread_id, before, task, options = {}) {
  if (!before) return IN_APP;
  watch_room_turn(config, thread_id, before, task, options).catch(() => {});
  return { ...IN_APP_PROGRESS, ends: true };
}

/** Deliver one task to Codex's real App, with the original chat reused afterward. */
async function deliver(config, binding, task, _spawn, user_home = homedir(), options = {}) {
  const connect = options.connect || (() => open_app(config));
  const run = options.run || run_program;
  if (binding.session_id) {
    try { bind_access(task.access_path, binding.session_id); }
    catch (error) { throw not_sent(error); }
    const before = await room_before(config, binding.session_id, connect);
    // `codex queue` reaches only a chat the App has loaded; a fork made after a rewind, or a chat after the App restarted,
    // is not loaded until a message is sent through the App itself (tested on App tools, 2026-10).
    if (before?.status === 'notLoaded') {
      const app = await connect();
      try { await app.send_message(binding.session_id, task.prompt); }
      finally { app.close(); }
      return { session_id: binding.session_id, status: 'accepted', capabilities: room_delivery(config, binding.session_id, before, task, options), steer: app_steer(config, binding.session_id, task, options.connect) };
    }
    const receipt = await run(config.executable, ['queue', '--thread', binding.session_id, '--message', task.prompt], { timeout: CALL_TIMEOUT_MS });
    return { session_id: binding.session_id, status: 'accepted', receipt, capabilities: room_delivery(config, binding.session_id, before, task, options), steer: app_steer(config, binding.session_id, task, options.connect) };
  }
  let app;
  try {
    let target, source;
    try {
      app = await connect();
      target = await codex_target(app, config);
      source = await creation_source(app, config, source_file(process.env, user_home));
    } catch (error) { throw not_sent(error); }
    const result = await app.create_thread(source, task.prompt, `CoDiscuss · ${task.participant}`, target);
    task.on_binding(result.thread_id);
    bind_access(task.access_path, result.thread_id);
    return { session_id: result.thread_id, status: 'accepted', capabilities: room_delivery(config, result.thread_id, { turns: new Set(), items: new Set() }, task, options), steer: app_steer(config, result.thread_id, task, options.connect) };
  } finally { app?.close(); }
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
function delegated_input(item, names = ['send_message_to_thread']) {
  if (item?.type !== 'functionCallOutput' || !names.includes(item.name)) return null;
  const match = /<input>([\s\S]*?)(?:<\/input>|$)/.exec(item.output?.text || '');
  return match ? { text: match[1].replace(/&(lt|gt|quot|apos|amp);/g, entity => XML_ENTITIES[entity]).trim(), truncated: Boolean(item.output?.truncated) } : null;
}

/** The text a userMessage item carried (as `codex queue` delivers a room prompt), or null for other items. */
function user_input(item) {
  if (item?.type !== 'userMessage') return null;
  const parts = Array.isArray(item.content) ? item.content : [];
  const text = parts.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n').trim();
  return text ? { text, truncated: Boolean(item.truncated) } : null;
}

/** Whether an extracted prompt matches the exact text this delivery sent. */
function matches_prompt(input, prompt) {
  return Boolean(input?.text && prompt && (input.text === prompt || (input.truncated && prompt.startsWith(input.text))));
}

/** The turn that took this prompt, and the prompt's place in it; items read before sending are earlier turns. */
function find_turn(snapshot, prompt, seen, { allow_user = false, names = ['send_message_to_thread'], seen_turns = null } = {}) {
  const text = String(prompt || '').trim();
  if (!text) return null;
  for (const turn of snapshot.turns || []) {
    const index = (turn.items || []).findIndex(item => {
      if (item?.id ? seen.has(item.id) : seen_turns?.has(turn.id)) return false;
      const input = delegated_input(item, names) || (allow_user ? user_input(item) : null);
      return matches_prompt(input, text);
    });
    if (index >= 0) return { turn, index, item_id: (turn.items || [])[index]?.id || '' };
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

/** One item of the turn as a process log entry, or null for items the chat page does not show. */
function chat_entry(item, fallback_id = item?.id) {
  const id = item.id || fallback_id;
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
  for (const [index, item] of items.entries()) { const entry = chat_entry(item, `${found.turn.id}:${index}`); if (entry) log(entry); }
  const newest = snapshot.turns[0] === found.turn;
  if (found.turn.status === 'inProgress' || (newest && snapshot.thread.status.type === 'active')) return null;
  return { turn: found.turn, items };
}

/** Poll the chat until the turn that took this line ends, it is stopped, or the wait runs out. */
async function follow_chat(context) {
  const { task, state, thread_id } = context;
  const log = entry_logger(task);
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
  session: { path: session_path, exists: session_exists, owns: desktop_thread, branch, settings: session_settings,
    list: list_sessions, preview: preview_session, remove: remove_session },
  models: null,
  skills: codex_skills,
};

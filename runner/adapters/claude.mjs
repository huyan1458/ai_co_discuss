/**
 * Claude Code adapter: one headless `claude -p` process per turn resuming the bound session, or, for a taken-over manual
 * member whose window is open, a task or private chat line posted into that window. Sessions are branched by Claude's own
 * --fork-session.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { runs_commands } from '../expert_prompts.mjs';
import { bind_access, DENIAL_FIELD, EDIT_TOOLS, launch_directory, log_entries, marked, MAX_DENIALS, model_entry, json_line,
  newest_record, not_sent, project_directory, prompt_text, query_catalog, TASK_SUBCOMMANDS, tree_killable, watch_events } from './common.mjs';

// A message posted to an open Claude window that has not started by then is reported, not failed.
const INBOX_CHECK_MS = 90_000;
// How often an open window's session log is read for the end of the turn that took a task.
const WINDOW_POLL_MS = 3_000;
// A private chat line posted to an open window fails when the window has not taken it by then, when the window waits on
// a prompt (an approval, a dialog) that long, or when its turn runs past the limit.
const CHAT_START_MS = 90_000;
const CHAT_WAITING_MS = 120_000;
const CHAT_TURN_MS = 30 * 60_000;
// Error kinds Claude Code records that a retry a minute later meets again: a used-up plan limit, a lost login.
const LASTING_ERRORS = ['rate_limit', 'authentication_failed'];
const EDIT_TOOL_NAMES = /^(Edit|MultiEdit|Write|NotebookEdit)$/;
// Claude Code logs side queries (titles, compaction, subagents) too; only these sources are the member's own turns.
const CLAUDE_MAIN_SOURCES = ['sdk', 'repl_main_thread'];
// A background process can be stopped and streams its progress; a turn in the member's own window does neither.
const PROCESS = { stoppable: true, progress: true };
const WINDOW = { stoppable: false, progress: false };
// A stopped window turn is read this often. Its Esc key waits for a running tool to return first, at most the wait; a
// turn the key reached that records no end by the end wait was not stopped.
const STOP_POLL_MS = 200;
const STOP_TOOL_WAIT_MS = 120_000;
const STOP_END_WAIT_MS = 15_000;
// What Claude Code records when Esc ends a turn: while it writes, or while a tool runs (`… for tool use`).
const INTERRUPTED = /^\[Request interrupted by user/;
// Attach to one process's console, name its window class and root owner's, and with CODISCUSS_WINDOW_KEY=escape write
// one Esc press into that console's input buffer only (never the foreground window). Prints one JSON line.
const CONSOLE_SCRIPT = String.raw`$code = @"
using System; using System.Text; using System.Runtime.InteropServices;
public class CodiscussConsole {
  [StructLayout(LayoutKind.Explicit, CharSet=CharSet.Unicode)] public struct KEY { [FieldOffset(0)] public int down; [FieldOffset(4)] public short repeat;
    [FieldOffset(6)] public short vk; [FieldOffset(8)] public short scan; [FieldOffset(10)] public char ch; [FieldOffset(12)] public int state; }
  [StructLayout(LayoutKind.Explicit)] public struct RECORD { [FieldOffset(0)] public short type; [FieldOffset(4)] public KEY key; }
  [DllImport("kernel32.dll")] static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AttachConsole(int pid);
  [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CreateFileW(string n, uint a, uint s, IntPtr sa, uint c, uint f, IntPtr t);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool WriteConsoleInputW(IntPtr h, RECORD[] r, int n, out int w);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint f);
  static string Name(IntPtr w) { var s = new StringBuilder(256); if (w != IntPtr.Zero) GetClassNameW(w, s, 256); return s.ToString(); }
  public static string Run(int pid, bool escape) {
    FreeConsole();
    if (!AttachConsole(pid)) return "{\"attached\":false,\"error\":" + Marshal.GetLastWin32Error() + "}";
    IntPtr w = GetConsoleWindow(); string window = Name(w), owner = Name(GetAncestor(w, 3)); bool written = false;
    if (escape) {
      IntPtr h = CreateFileW("CONIN$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
      if (h != new IntPtr(-1)) {
        var r = new RECORD[2];
        for (int i = 0; i < 2; i++) { r[i].type = 1; r[i].key.down = i == 0 ? 1 : 0; r[i].key.repeat = 1; r[i].key.vk = 0x1B; r[i].key.scan = 1; r[i].key.ch = (char)0x1B; }
        int n; written = WriteConsoleInputW(h, r, 2, out n) && n == 2; CloseHandle(h);
      }
    }
    FreeConsole();
    return "{\"attached\":true,\"window\":\"" + window + "\",\"owner\":\"" + owner + "\",\"written\":" + (written ? "true" : "false") + "}";
  }
}
"@
Add-Type -TypeDefinition $code
[Console]::Out.WriteLine([CodiscussConsole]::Run([int]$env:CODISCUSS_WINDOW_PID, $env:CODISCUSS_WINDOW_KEY -eq 'escape'))`;

/** Explain why a finished Claude print run failed, including errors reported with exit code 0. */
export function claude_exit_error(code, output) {
  let result = null;
  try { result = JSON.parse(output.trim().split(/\r?\n/).at(-1)); } catch { /* Non-JSON output keeps the exit code check. */ }
  if (result?.is_error) return `Claude 执行出错：${result.result || result.api_error || result.subtype || '未知错误'}`;
  return code === 0 ? '' : `Claude 退出码 ${code}`;
}

/**
 * The API error Claude Code wrote in place of an answer, from a session log entry or a stream-json event, or null.
 * Its `kind` is Claude's own category (`rate_limit`, `authentication_failed`, `server_error`, ...).
 */
export function claude_api_error(entry) {
  if (entry?.type !== 'assistant' || !(entry.isApiErrorMessage || entry.is_api_error_message)) return null;
  const text = prompt_text(entry.message?.content).trim();
  const kind = String(entry.error || '');
  return { kind, text: text || String(entry.api_error || kind || '未知错误'), lasting: LASTING_ERRORS.includes(kind) };
}

/** How a Claude API error reads on the failed execution; a lasting one says it is not retried. */
export function claude_error_reason(error) {
  const label = { rate_limit: 'Claude 用量已达上限', authentication_failed: 'Claude 未登录或登录已失效' }[error.kind] || 'Claude 接口出错';
  return `${label}：${error.text}${error.lasting ? '（不自动重试；恢复后请重新发送）' : ''}`;
}

/** The first program a shell command runs, skipping `cd` and `Set-Location` steps, for a prefix rule that also allows a retry. */
function command_program(command) {
  const steps = String(command).split(/&&|\|\||;|\|/).map(step => step.trim().split(/\s+/)[0]).filter(Boolean);
  return steps.find(step => !/^(cd|Set-Location|sl|pushd)$/i.test(step)) || steps[0] || '';
}

/**
 * The operations a headless Claude run refused, from the `permission_denials` of its final result line, each with the
 * `--allowedTools` rule that would let the next run do it: a command prefix, an edit of that folder, or the tool itself.
 */
export function claude_denials(output) {
  let result = null;
  try { result = JSON.parse(output.trim().split(/\r?\n/).at(-1)); } catch { return []; }
  const seen = new Set();
  return (Array.isArray(result?.permission_denials) ? result.permission_denials : []).map(denial => {
    const tool = String(denial.tool_name || '').slice(0, 40), input = denial.tool_input || {};
    if (['Bash', 'PowerShell'].includes(tool) && input.command) {
      const program = command_program(input.command);
      return { tool, detail: String(input.command), rule: program ? `${tool}(${program} *)` : '' };
    }
    const path = input.file_path || input.notebook_path;
    if (EDIT_TOOL_NAMES.test(tool) && path) return { tool, detail: String(path), rule: `Edit(${claude_rule_path(dirname(path))}/**)` };
    return { tool, detail: JSON.stringify(input), rule: tool };
  }).filter(item => item.tool && !seen.has(item.detail) && seen.add(item.detail))
    .slice(0, MAX_DENIALS).map(item => ({ ...item, detail: item.detail.slice(0, DENIAL_FIELD), rule: item.rule.length <= DENIAL_FIELD ? item.rule : '' }));
}

/**
 * The environment for one spawned Claude CLI: variables a hosting Claude session injects are dropped, and the user's
 * persisted login variables, read afresh on Windows, override the ones this long-running process inherited at start,
 * so a token switched with setx or the system settings takes effect on the next turn without restarting the runner.
 */
export function standalone_claude_env(env = process.env, persisted = persisted_claude_env) {
  const own = env.CLAUDECODE !== '1' ? env : Object.fromEntries(Object.entries(env).filter(([key]) =>
    !/^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT)$|^(CLAUDE_CODE_|CLAUDE_AGENT_SDK_|CLAUDE_PREVIEW_)/.test(key)));
  return { ...own, ...persisted() };
}

/** Read Machine then User persisted ANTHROPIC_/CLAUDE variables on every call; values stay in memory only. */
function persisted_claude_env() {
  if (process.platform !== 'win32') return {};
  const script = "$r=@{}; foreach($s in 'Machine','User'){ $v=[Environment]::GetEnvironmentVariables($s);"
    + " foreach($k in $v.Keys){ if($k -match '^(ANTHROPIC_|CLAUDE)'){ $r[$k]=$v[$k] } } }; $r | ConvertTo-Json -Compress";
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });
  try { return result.status === 0 && result.stdout.trim() ? JSON.parse(result.stdout) : {}; }
  catch { return {}; }
}

/** Claude permission rules match Windows paths in POSIX form, e.g. C:\a becomes //c/a. */
export function claude_rule_path(directory) {
  const path = resolve(directory).replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
  return `/${path}`;
}

/**
 * Allow the listed codiscuss website subcommands and draft writes for this run; a writable member also edits its project
 * and runs any command. The room's other project directories (`task.extra_directories`) are added as working
 * directories, edited only where their access is write. User rules are added after. Claude Code on Windows may run
 * commands through its PowerShell tool instead of Bash, so both are listed.
 */
export function claude_permissions(config, task) {
  const extras = task.extra_directories || [];
  const added = [task.directory, task.draft_directory, ...task.skill_directories, ...extras.map(item => item.path)];
  // A headless run cannot ask for approval: 自动 and a taken-over manual member use auto mode, as the original window
  // does, and 全放开 skips every check; the website commands and drafts stay pre-approved either way.
  if (['own', 'auto', 'full'].includes(config.project_access)) {
    const commands = TASK_SUBCOMMANDS.flatMap(command => [`Bash(codiscuss ${command} *)`, `PowerShell(codiscuss ${command} *)`]);
    return ['--permission-mode', config.project_access === 'full' ? 'bypassPermissions' : 'auto', '--add-dir', ...added, '--allowedTools',
      ...commands, `Edit(${claude_rule_path(task.draft_directory)}/**)`, ...(config.allowed_tools || []), ...edit_denial(task)];
  }
  const commands = runs_commands(config, extras) ? ['Bash', 'PowerShell']
    : TASK_SUBCOMMANDS.flatMap(command => [`Bash(codiscuss ${command} *)`, `PowerShell(codiscuss ${command} *)`]);
  const writable = [task.draft_directory, ...(runs_commands(config, extras)
    ? [project_directory(config), ...extras.filter(item => item.access === 'write').map(item => item.path)].filter(Boolean) : [])];
  return ['--add-dir', ...added, '--allowedTools',
    ...commands, ...writable.map(directory => `Edit(${claude_rule_path(directory)}/**)`), ...(config.allowed_tools || []), ...edit_denial(task)];
}

/**
 * Skill folders (the shared skills and an enabled workflow) are read, never edited, and so are the room's project
 * directories this member may only read. This stops Claude's own edit tools only; a command the member may run can
 * still write there, and Windows has no native sandbox to prevent it.
 */
function edit_denial(task) {
  const read_only = (task.extra_directories || []).filter(item => item.access === 'read').map(item => item.path);
  return ['--disallowedTools', ...[...task.skill_directories, ...read_only].map(directory => `Edit(${claude_rule_path(directory)}/**)`)];
}

/** What Claude's stream-json events say the agent is doing, which tool it starts, and text it wrote to the user. */
const events = {
  phase(event) {
    if (event.type === 'system' || event.type === 'user') return 'thinking';
    const block = event.type === 'assistant' ? event.message?.content?.at(-1) : null;
    if (block?.type === 'tool_use') return /^(Bash|PowerShell)$/.test(block.name) ? 'command' : EDIT_TOOLS.test(block.name) ? 'editing' : 'tool';
    return block?.type === 'text' ? 'writing' : block?.type === 'thinking' ? 'thinking' : '';
  },
  tool(event) {
    const block = event.type === 'assistant' ? event.message?.content?.at(-1) : null;
    return block?.type === 'tool_use' ? String(block.name || '') : '';
  },
  note(event) {
    if (event.type !== 'assistant') return '';
    return (event.message?.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n').trim();
  },
  edits(event) {
    if (event.type !== 'assistant') return [];
    return (event.message?.content || []).filter(block => block.type === 'tool_use' && EDIT_TOOL_NAMES.test(block.name))
      .map(block => String(block.input?.file_path || block.input?.notebook_path || '')).filter(Boolean);
  },
  detail: claude_detail,
};

/** The one argument that names what a tool call does: its command, file, pattern, query or address. */
function tool_subject(block) {
  const input = block.input || {};
  const subject = input.command ?? input.file_path ?? input.notebook_path ?? input.pattern ?? input.query ?? input.url ?? input.description;
  return typeof subject === 'string' ? subject : JSON.stringify(input);
}

/** Text of a tool result, which Claude gives as a string or a list of blocks. */
function result_text(content) {
  if (typeof content === 'string') return content;
  return (Array.isArray(content) ? content : []).map(part => part?.text ?? '').join('\n');
}

/**
 * One stream-json event as execution-detail entries: a tool call and its result share the call's id. Claude Code
 * streams thinking as signed blocks with empty text, so thinking shows only when it carries text. Its assistant and
 * user events carry an ISO `timestamp` (seen on 2.1.312), which becomes a step's `at` and its result's `ended_at`.
 */
function claude_detail(event) {
  const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
  const at = event.timestamp || undefined;
  if (event.type === 'assistant') return blocks.flatMap(block => {
    if (block.type === 'text' && block.text?.trim()) return [{ kind: 'message', body: block.text, at }];
    if (block.type === 'thinking' && block.thinking?.trim()) return [{ kind: 'thinking', body: block.thinking, at }];
    if (block.type !== 'tool_use') return [];
    const kind = /^(Bash|PowerShell)$/.test(block.name) ? 'command' : EDIT_TOOL_NAMES.test(block.name) ? 'edit'
      : /^Web(Search|Fetch)$/.test(block.name) ? 'search' : 'tool';
    return [{ id: `tool-${block.id}`, kind, title: kind === 'command' ? tool_subject(block) : `${block.name} ${tool_subject(block)}`, state: 'running', at }];
  });
  if (event.type === 'user') return blocks.filter(block => block.type === 'tool_result')
    .map(block => ({ id: `tool-${block.tool_use_id}`, body: result_text(block.content), state: block.is_error ? 'failed' : 'done', ended_at: at }));
  if (event.type === 'result' && event.is_error) return [{ kind: 'error', body: String(event.result || event.subtype || '本轮失败') }];
  return [];
}

/**
 * The open Claude Code window holding one session, with its cross-session inbox, or null when no live session holds it.
 * Read from the registry each running session writes; `inbox` is null on a version without one. Not a public interface:
 * the peer token and message line are what Claude's own sessions use (tested on 2.1.312).
 */
export function claude_window(session_id, env = process.env) {
  const directory = join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'sessions');
  if (!session_id || !existsSync(directory)) return null;
  for (const name of readdirSync(directory).filter(item => /^\d+\.json$/.test(item))) {
    let record;
    try { record = JSON.parse(readFileSync(join(directory, name), 'utf8')); } catch { continue; }
    if (record.sessionId !== session_id) continue;
    try { process.kill(Number(record.pid), 0); } catch { continue; }
    const key = readdirSync(directory).find(item => item.startsWith(`${record.pid}.`) && item.endsWith('.key'));
    let token = '';
    try { token = key ? JSON.parse(readFileSync(join(directory, key), 'utf8')).peerToken || '' : ''; } catch { /* no inbox credential */ }
    return { pid: Number(record.pid), inbox: record.messagingSocketPath && token ? { socket: record.messagingSocketPath, token } : null };
  }
  return null;
}

/**
 * The console an open Claude window runs in, and with `escape` one Esc key press written into its input, which Claude
 * Code takes as the stop of the turn it runs. Windows only. Returns `{ok, terminal, reason}`: `terminal` is `conhost`
 * or `Windows Terminal` when the console window says which, `reason` why it could not attach or write.
 */
export function window_console(pid, { escape = false, run = spawnSync, platform = process.platform } = {}) {
  if (platform !== 'win32') return { ok: false, terminal: '', reason: '只有 Windows 上能向 Claude 窗口发送停止键' };
  const result = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(CONSOLE_SCRIPT, 'utf16le').toString('base64')], {
    encoding: 'utf8', windowsHide: true, timeout: 20_000,
    env: { ...process.env, CODISCUSS_WINDOW_PID: String(pid), CODISCUSS_WINDOW_KEY: escape ? 'escape' : '' } });
  const reply = json_line(String(result.stdout || '').trim().split(/\r?\n/).at(-1) || '');
  if (!reply) return { ok: false, terminal: '', reason: `无法连接到这个 Claude 窗口的控制台（PowerShell 没有返回结果：${String(result.stderr || result.error?.message || result.status).trim().slice(0, 200)}）` };
  const terminal = reply.window === 'ConsoleWindowClass' ? 'conhost' : reply.owner === 'CASCADIA_HOSTING_WINDOW_CLASS' ? 'Windows Terminal' : String(reply.window || '');
  if (!reply.attached) return { ok: false, terminal, reason: `无法连接到这个 Claude 窗口的控制台（AttachConsole 错误 ${reply.error}）` };
  if (escape && !reply.written) return { ok: false, terminal, reason: `未能向这个 Claude 窗口（${terminal || '未知终端'}）写入停止键` };
  return { ok: true, terminal, reason: '' };
}

/** Whether this execution goes into a manual member's own open window (taken over with `own` permissions) rather than a background process. */
export function claude_inbox_ready(profile, binding) {
  return profile.adapter === 'claude' && profile.project_access === 'own' && Boolean(profile.session_id)
    && binding.session_id === profile.session_id && Boolean(claude_window(profile.session_id)?.inbox);
}

/**
 * A taken-over manual Claude member whose session a window without an inbox still holds: resuming that session from
 * here would split its file into two branches neither side sees in full, so its first hosted turn forks it and later
 * turns resume the fork; a fork whose session was never written is retried under the same ID. Once no window holds
 * the session, it is resumed as it is.
 */
export function adopted_fork(config, binding, held, exists = id => session_exists(id)) {
  if (config.project_access !== 'own' || !config.session_id || binding.fork || !binding.session_id) return binding;
  if (binding.session_id !== config.session_id) return exists(binding.session_id) ? binding : { ...binding, fork: { from: config.session_id, at: '' } };
  return held ? { ...binding, session_id: randomUUID(), fork: { from: config.session_id, at: '' } } : binding;
}

/**
 * Write lines into an open window's inbox: an `auth` line with its peer token, then one `user` message. The inbox is not
 * a public interface of Claude Code, so a failure says so; the window wraps every message as one from another session.
 */
async function post_inbox(inbox, text) {
  const lines = [{ type: 'auth', token: inbox.token }, { type: 'user', message: { role: 'user', content: text } }];
  await new Promise((resolve_sent, reject) => {
    let written = false;
    const socket = connect(inbox.socket, () => {
      socket.end(lines.map(line => `${JSON.stringify(line)}\n`).join(''), () => { written = true; resolve_sent(); });
    });
    socket.on('error', error => written ? undefined : reject(not_sent(new Error(
      `无法投递到 Claude 原窗口：它的跨会话收件箱不是 Claude Code 的公开接口，可能已随版本变化或被关闭（${error.message}）`))));
  });
}

/** Post one task into an open Claude window; it starts a turn there, or between tool calls of the turn it is in. */
async function inbox_delivery(config, window, task) {
  try { bind_access(task.access_path, config.session_id); }
  catch (error) { throw not_sent(error); }
  // Only what the window writes after this point can be the turn that takes this task.
  const file = session_path(config.session_id);
  const offset = file ? statSync(file).size : 0;
  await post_inbox(window.inbox, `CoDiscuss 本机服务代房间转达（你已注册为该房间成员，这是房间分派给你的任务）：\n${task.prompt}`);
  // The discussion runner enters the execution once the session is known, as it does when a process reports it.
  task.on_binding?.(config.session_id);
  watch_window_turn({ file, offset, pid: window.pid, marker: `${task.id}.task.json` }, task);
  return { session_id: config.session_id, status: 'accepted', capabilities: WINDOW };
}

/**
 * The window a manual member's bound session is open in, or null: only a taken-over manual member (`own`) still bound
 * to its original session can be in one.
 */
function held_window(config, binding) {
  return config.project_access === 'own' && binding.session_id && binding.session_id === config.session_id ? claude_window(config.session_id) : null;
}

// The window shows every inbox message as one from another Claude session, not typed by its user; these leads say whose
// words they are and that the answer is the turn's own text.
const CHAT_WINDOW_LEAD = '以下是房主（也就是你的用户）在 CoDiscuss 私聊窗里对你说的原话，由本机服务转达到这个窗口。请像用户在这里直接输入一样处理，在本轮的文字回复里直接回答，不要用 SendMessage 回复。';
const CHAT_STEER_LEAD = '房主（也就是你的用户）刚在 CoDiscuss 私聊窗里插话，原话如下。这是对你当前这轮工作的追加要求，不是其他会话的来信：请在本轮最后的文字回复里直接回应它，不要用 SendMessage 回复。';

/**
 * One private chat turn of a Claude member. With the member's window open, the owner's words go through its inbox and
 * the turn is read from the session log; with no window, the session is resumed in the background, which a closed
 * window sees in full when it is opened again. A window without an inbox fails instead: resuming beside it would split
 * the session into two branches. A window turn stops by an Esc key written into the window's console, when that console
 * can be reached; `options.console` replaces that console in tests.
 */
async function chat(config, binding, task, spawn_process = spawn, user_home, options = {}) {
  const window = held_window(config, binding);
  if (!window) return deliver(config, binding, task, spawn_process);
  if (!window.inbox) throw not_sent(new Error('这位成员的 Claude 窗口开着，但没有可用的跨会话收件箱（版本不支持或已关闭），私聊无法送进去；请在它的窗口里直接对话，或关闭窗口后再发'));
  const session_id = config.session_id;
  const file = session_path(session_id);
  const offset = file ? statSync(file).size : 0;
  const log_path = resolve(task.directory, `claude-${task.id}.log`);
  const marker = `[codiscuss:${task.id}]`;
  const console_of = options.console || window_console;
  const reached = console_of(window.pid);
  task.on_output?.(log_path, `${JSON.stringify({ type: 'codiscuss.window', terminal: reached.terminal, stoppable: reached.ok, reason: reached.reason })}\n`);
  const handle = new EventEmitter();
  const watcher = watch_window_turn({ file, offset, pid: window.pid, marker, session_id, log_path }, task, {
    chat: true, on_end: () => handle.emit('close', 0),
    stop_key: () => {
      const sent = console_of(window.pid, { escape: true });
      task.on_output?.(log_path, `${JSON.stringify({ type: 'codiscuss.stop', terminal: sent.terminal, sent: sent.ok, reason: sent.reason })}\n`);
      return sent;
    } });
  try { await post_inbox(window.inbox, `${marker} ${CHAT_WINDOW_LEAD}\n\n${task.prompt}`); }
  catch (error) { watcher.cancel(); throw error; }
  if (reached.ok) {
    handle.kill = () => watcher.stop();
    // The Esc key goes into the owner's own window; only the owner's stop sends it, never the runner's shutdown.
    handle.stop_on_shutdown = false;
    task.on_process?.(handle);
  }
  let count = 0;
  // Each interjection carries its own marker; the watch then also waits for the turn that takes it.
  const steer = async text => {
    const tag = `[codiscuss:${task.id}+${++count}]`;
    if (!watcher.expect(tag)) return false;
    try { await post_inbox(window.inbox, `${tag} ${CHAT_STEER_LEAD}\n\n${text}`); }
    catch { watcher.forget(tag); return false; }
    task.on_output?.(log_path, `${JSON.stringify({ type: 'codiscuss.interjection', text })}\n`);
    return true;
  };
  return { session_id, status: 'accepted', capabilities: { stoppable: reached.ok, progress: true }, steer };
}

/**
 * Whether a session-log entry is the window taking a message carrying `marker`: the prompt of a turn it started, or a
 * message it took between the tool calls of a turn already running (`queued_command`).
 */
function takes(entry, marker) {
  if (entry.type === 'user') return prompt_text(entry.message?.content).includes(marker);
  return entry.type === 'attachment' && entry.attachment?.type === 'queued_command' && prompt_text(entry.attachment.prompt).includes(marker);
}

/** The state an open window last recorded in the session registry (`busy`, `idle`, or `waiting` with `waitingFor`), or null. */
function window_state(pid, env = process.env) {
  try { return JSON.parse(readFileSync(join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'sessions', `${pid}.json`), 'utf8')); }
  catch { return null; }
}

/**
 * Follow a message posted into an open window through the session log, from `offset` on, until the turn that took it
 * ends (`system/turn_duration`) or the window closes: report the API error that turn ended on as a failure, otherwise its
 * end. For a room task it notes once when the window has not taken it by `unstarted_after`; an answer it never submitted
 * then fails the execution. For a `chat` turn it reports the turn's steps to `log_path` and its texts as notes, waits
 * also for every interjection `expect`ed, and fails with the reason when the window does not take the message in time,
 * waits on a prompt for `waiting_after`, closes, or runs past `turn_limit`. A turn Esc ended (`[Request interrupted by
 * user…]`, which records no `turn_duration`) ends the watch too. `stop()` asks the turn to stop: `stop_key()` sends one
 * Esc key, only while the registry says the window is busy, the turn has not ended, and no tool call waits for its result
 * (Esc during a tool reads as the user refusing that call); it waits at most `stop_tool_wait` for that. `on_end` runs when
 * the watch ends. Returns `{expect, forget, stop, cancel, done}`.
 */
export function watch_window_turn({ file, offset, pid, marker, session_id = '', log_path = '' }, task, options = {}) {
  const { interval = WINDOW_POLL_MS, unstarted_after = INBOX_CHECK_MS, chat = false, start_after = CHAT_START_MS,
    waiting_after = CHAT_WAITING_MS, turn_limit = CHAT_TURN_MS, env = process.env, on_end, stop_key,
    stop_poll = STOP_POLL_MS, stop_tool_wait = STOP_TOOL_WAIT_MS, stop_end_wait = STOP_END_WAIT_MS } = options;
  const since = Date.now(), awaited = new Set([marker]), open_tools = new Set();
  let pending = Buffer.alloc(0), taken = false, noted = false, error = null, done = false, waiting_since = 0;
  let stop_asked = 0, stop_sent = 0, stop_timer = null;
  const finish = (reason = '') => {
    if (done) return;
    done = true;
    clearInterval(timer); clearInterval(stop_timer);
    if (error) task.on_failure?.(claude_error_reason(error), { retryable: !error.lasting });
    else if (reason) task.on_failure?.(reason);
    else task.on_exit?.();
    on_end?.();
  };
  const tick = () => {
    if (done) return;
    for (const entry of read_appended()) {
      for (const item of awaited) if (takes(entry, item)) { awaited.delete(item); taken = true; }
      if (!taken) continue;
      if (entry.type === 'user' && INTERRUPTED.test(prompt_text(entry.message?.content).trim())) {
        return finish(!chat ? '' : stop_asked ? '已停止' : '这一轮在 Claude 窗口里被中断了');
      }
      const api_error = claude_api_error(entry);
      error = api_error || error;
      if (chat && !api_error) report(entry);
      if (!entry.isSidechain) track_tools(entry);
      if (entry.type === 'system' && entry.subtype === 'turn_duration' && !awaited.size) return finish();
    }
    if (!process_alive(pid)) return finish(chat ? '这位成员的 Claude 窗口在这轮私聊结束前关闭了' : '');
    if (stop_asked) return try_stop();
    const elapsed = Date.now() - since;
    if (!chat) {
      if (!taken && !noted && elapsed >= unstarted_after) {
        noted = true;
        task.on_note?.('已投递到原窗口，但它还没开始处理：原窗口可能处于跳过审批模式（需在窗口中批准这条消息）或仍在忙。');
      }
      return;
    }
    const state = window_state(pid, env);
    waiting_since = state?.status === 'waiting' ? waiting_since || Date.now() : 0;
    if (waiting_since && Date.now() - waiting_since >= waiting_after) {
      return finish(`这位成员的 Claude 窗口停在“${state.waitingFor || '等待确认'}”超过 ${Math.round(waiting_after / 1000)} 秒（可能在等你批准一项操作），请到窗口里处理后重新发送`);
    }
    if (!taken && elapsed >= start_after) {
      return finish(`已投递到这位成员的 Claude 窗口，但 ${Math.round(start_after / 1000)} 秒内它没有开始处理：窗口可能在等你确认这条消息、仍在忙，或跨会话收件箱（非公开接口）已变化`);
    }
    if (elapsed >= turn_limit) finish(`这轮私聊在 Claude 窗口里超过 ${Math.round(turn_limit / 60_000)} 分钟仍未结束，已停止等待`);
  };
  const timer = setInterval(tick, interval);
  timer.unref();
  /** Pass one entry of the turn on: its steps to the process log in the stream-json shape, its text as a remark. */
  function report(entry) {
    if (entry.isSidechain || !['assistant', 'user'].includes(entry.type)) return;
    if (log_path) task.on_output?.(log_path, `${JSON.stringify({ type: entry.type, message: entry.message })}\n`);
    const note = events.note(entry);
    if (note) task.on_note?.(note);
  }
  /** Whole lines the log gained since the last read; a line still being written waits for the next. */
  function read_appended() {
    // A window that has not written its session yet creates the log with the first message it takes.
    if (!file && session_id) file = session_path(session_id, env);
    let size;
    try { size = file ? statSync(file).size : 0; } catch { return []; }
    if (size <= offset) return [];
    const chunk = Buffer.alloc(size - offset), handle = openSync(file, 'r');
    try { readSync(handle, chunk, 0, chunk.length, offset); } finally { closeSync(handle); }
    offset = size;
    pending = Buffer.concat([pending, chunk]);
    const end = pending.lastIndexOf(0x0a);
    if (end < 0) return [];
    const lines = pending.subarray(0, end).toString('utf8').split('\n');
    pending = pending.subarray(end + 1);
    return lines.map(json_line).filter(Boolean);
  }
  /** Note the tool calls of the turn that have not returned yet. */
  function track_tools(entry) {
    for (const block of Array.isArray(entry.message?.content) ? entry.message.content : []) {
      if (entry.type === 'assistant' && block?.type === 'tool_use') open_tools.add(block.id);
      if (entry.type === 'user' && block?.type === 'tool_result') open_tools.delete(block.tool_use_id);
    }
  }
  /** Send the one Esc key of a stop once the turn can take it, or say why the turn was not stopped. */
  function try_stop() {
    const now = Date.now();
    if (stop_sent) {
      if (now - stop_sent >= stop_end_wait) finish('已向 Claude 窗口发送停止键，但这一轮仍未结束');
      return;
    }
    const ready = taken && !open_tools.size && window_state(pid, env)?.status === 'busy';
    if (!ready) {
      if (now - stop_asked >= stop_tool_wait) finish(open_tools.size ? '工具仍在执行，未能停止' : !taken ? '消息还在 Claude 窗口的队列里，未能停止' : 'Claude 窗口一直没有处于执行中，未能停止');
      return;
    }
    stop_sent = now;
    const sent = stop_key?.() || { ok: false, reason: '无法向 Claude 窗口发送停止键' };
    if (!sent.ok) finish(sent.reason);
  }
  return {
    get done() { return done; },
    expect(item) { if (done) return false; awaited.add(item); return true; },
    forget(item) { awaited.delete(item); },
    stop() {
      if (done) return false;
      if (!stop_asked) { stop_asked = Date.now(); stop_timer = setInterval(tick, stop_poll); stop_timer.unref(); setImmediate(tick); }
      return true;
    },
    cancel() { done = true; clearInterval(timer); clearInterval(stop_timer); },
  };
}

/** One user message as a stream-json input line. */
function claude_input(text) {
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })}\n`;
}

function process_alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Use one official Claude process per turn and resume the persisted session, or post into the member's open window. */
async function deliver(config, binding, task, spawn_process = spawn) {
  const window = held_window(config, binding);
  // Only a task written for the window names its credential file; a background process gets it through its environment.
  if (window?.inbox && task.inbox) return inbox_delivery(config, window, task);
  binding = adopted_fork(config, binding, Boolean(window));
  const session_id = binding.session_id || randomUUID();
  try { bind_access(task.access_path, session_id); }
  catch (error) { throw not_sent(error); }
  // Streamed events show the turn's progress; the final line is still the result that decides success.
  // A rewound or forked member first forks its earlier session into the ID it is now bound to, cut at `at` when given.
  const fork = binding.fork ? ['--resume', binding.fork.from, '--fork-session', ...(binding.fork.at ? ['--resume-session-at', binding.fork.at] : []), '--session-id', session_id]
    : [binding.session_id ? '--resume' : '--session-id', session_id];
  // The prompt goes in as the first stdin message and stdin stays open, so an interjection can follow while the turn runs.
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', ...fork,
    ...(config.model ? ['--model', config.model] : []), ...(config.effort ? ['--effort', config.effort] : []), ...claude_permissions(config, task)];
  let child;
  try {
    child = spawn_process(config.executable, args, {
      cwd: launch_directory(config, task), windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...standalone_claude_env(), DISCUSS_ACCESS_FILE: task.access_path },
    });
  } catch (error) { throw not_sent(error); }
  tree_killable(child);
  let spawned = false;
  const log_path = resolve(task.directory, `claude-${task.id}.log`);
  let output = '';
  let partial_line = '';
  child.stdout.on('data', chunk => {
    output += chunk;
    task.on_output(log_path, chunk);
    // With streamed input Claude waits for more after its result; closing stdin lets it exit.
    const lines = (partial_line + chunk).split('\n');
    partial_line = lines.pop();
    if (!child.stdin.writableEnded && lines.some(line => json_line(line)?.type === 'result')) child.stdin.end();
  });
  child.stdin.on('error', () => { /* A process that already exited takes no more input. */ });
  child.stderr.on('data', chunk => task.on_output(log_path, chunk));
  watch_events(claude, child.stdout, task);
  child.once('close', code => {
    if (!spawned) return;
    const denials = claude_denials(output);
    if (denials.length) task.on_denials?.(denials);
    const error = claude_exit_error(code, output);
    const api_error = error ? output.split(/\r?\n/).map(json_line).map(claude_api_error).filter(Boolean).at(-1) : null;
    if (api_error) task.on_failure(claude_error_reason(api_error), { retryable: !api_error.lasting });
    else if (error) task.on_failure(error);
    else task.on_exit?.();
  });
  task.on_process(child);
  await new Promise((resolve_spawn, reject) => {
    child.once('spawn', () => { spawned = true; resolve_spawn(); });
    child.once('error', error => spawned ? task.on_failure(error.message) : reject(not_sent(error)));
  });
  child.stdin.write(claude_input(task.prompt));
  // A failed spawn creates no session; only a successfully started process can be resumed.
  task.on_binding(session_id);
  // An interjection reaches the turn at its next tool call; text written in one go without tools waits for the next turn.
  const steer = text => {
    if (child.stdin.writableEnded || child.exitCode !== null) return false;
    child.stdin.write(claude_input(text));
    task.on_output(log_path, `${JSON.stringify({ type: 'codiscuss.interjection', text })}\n`);
    return true;
  };
  return { session_id, status: 'accepted', capabilities: PROCESS, steer };
}

/** Where Claude keeps one session's log, or '' when this machine has none by that ID. */
function session_path(session_id, env = process.env, home = homedir()) {
  const projects = join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'projects');
  if (!existsSync(projects)) return '';
  return readdirSync(projects).map(dir => join(projects, dir, `${session_id}.jsonl`)).find(existsSync) || '';
}

/** Whether Claude stored a session by that ID on this machine, e.g. whether a pending fork already happened. */
function session_exists(session_id, { env = process.env, home = homedir() } = {}) {
  return Boolean(session_id && session_path(session_id, env, home));
}

/** The directory a session was made in, from its log; Claude resumes a session only there. '' when it recorded none. */
function session_cwd(session_id, { env = process.env, home = homedir() } = {}) {
  const file = session_path(session_id, env, home);
  if (!file) return '';
  return readFileSync(file, 'utf8').split('\n').map(line => { try { return JSON.parse(line).cwd; } catch { return undefined; } }).find(Boolean) || '';
}

/** Fork on the next turn at the last answer before the first marked prompt; a cut before any answer starts anew. */
function branch(profile, session_id, markers, { always, env, home }) {
  const file = session_path(session_id, env, home);
  if (!file) throw new Error(`本机找不到 Claude 会话 ${session_id}`);
  const entries = log_entries(file);
  const index = entries.findIndex(entry => entry.type === 'user' && marked(prompt_text(entry.message?.content), markers));
  if (index < 0) return always ? { session_id: randomUUID(), fork: { from: session_id, at: '' } } : null;
  const at = entries.slice(0, index).findLast(entry => entry.type === 'assistant' && entry.uuid)?.uuid;
  return at ? { session_id: randomUUID(), fork: { from: session_id, at } } : { session_id: '' };
}

/** Claude's user settings: what it runs with when the card leaves model or effort empty. */
function defaults(profile, { env = process.env, home = homedir() } = {}) {
  try {
    const settings = JSON.parse(readFileSync(join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'settings.json'), 'utf8'));
    return { model: typeof settings.model === 'string' ? settings.model : '', effort: typeof settings.effortLevel === 'string' ? settings.effortLevel : '' };
  } catch { return { model: '', effort: '' }; }
}

/** The model and effort a session last ran with, from its own log; no turn is started. */
function session_settings(session_id, { env = process.env, home = homedir() } = {}) {
  const file = session_path(session_id, env, home);
  if (!file) return null;
  return newest_record(file, '"type":"api-request"', record => record.type === 'api-request' && CLAUDE_MAIN_SOURCES.includes(record.querySource)
    && typeof record.params?.model === 'string' ? { model: record.params.model, effort: String(record.params.output_config?.effort || '') } : null);
}

/** Claude's initialization exposes its model picker; the query process never persists a session or loads MCP servers. */
function models(profile, options) {
  const args = ['--safe-mode', '-p', '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--verbose', '--no-session-persistence', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'];
  return query_catalog(profile, args, (send, finish) => ({
    start: () => send({ type: 'control_request', request_id: 'catalog', request: { subtype: 'initialize' } }),
    line: line => {
      const reply = json_line(line);
      if (reply?.type !== 'control_response' || reply.response?.request_id !== 'catalog') return;
      if (reply.response.subtype !== 'success') return finish(new Error('Claude 模型目录查询失败，请检查 CLI 版本与登录'));
      finish(null, (reply.response.response?.models || []).map(model => model_entry(model.value, model.displayName,
        model.supportedEffortLevels || (model.supportsEffort ? undefined : []))));
    },
  }), options);
}

/** Claude Code's behaviour; its static facts are in profiles.mjs. */
export const claude = {
  id: 'claude', catalog_source: 'claude-cli',
  into_window: claude_inbox_ready,
  deliver, chat, events,
  session: { path: session_path, exists: session_exists, owns: session_exists, cwd: session_cwd, branch, settings: session_settings },
  models: { list: models, defaults },
};

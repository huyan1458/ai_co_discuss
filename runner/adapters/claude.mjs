/**
 * Claude Code adapter: one headless `claude -p` process per turn resuming the bound session, or, for a taken-over manual
 * member whose window is open, a task posted into that window. Sessions are branched by Claude's own --fork-session.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { runs_commands } from '../expert_prompts.mjs';
import { bind_access, DENIAL_FIELD, EDIT_TOOLS, launch_directory, log_entries, marked, MAX_DENIALS, model_entry, json_line,
  newest_record, not_sent, project_directory, prompt_text, query_catalog, TASK_SUBCOMMANDS, tree_killable, watch_events } from './common.mjs';

// A message posted to an open Claude window that has not started by then is reported, not failed.
const INBOX_CHECK_MS = 90_000;
const EDIT_TOOL_NAMES = /^(Edit|MultiEdit|Write|NotebookEdit)$/;
// Claude Code logs side queries (titles, compaction, subagents) too; only these sources are the member's own turns.
const CLAUDE_MAIN_SOURCES = ['sdk', 'repl_main_thread'];
// A background process can be stopped and streams its progress; a turn in the member's own window does neither.
const PROCESS = { stoppable: true, progress: true };
const WINDOW = { stoppable: false, progress: false };

/** Explain why a finished Claude print run failed, including errors reported with exit code 0. */
export function claude_exit_error(code, output) {
  let result = null;
  try { result = JSON.parse(output.trim().split(/\r?\n/).at(-1)); } catch { /* Non-JSON output keeps the exit code check. */ }
  if (result?.is_error) return `Claude 执行出错：${result.result || result.api_error || result.subtype || '未知错误'}`;
  return code === 0 ? '' : `Claude 退出码 ${code}`;
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
 * Drop variables a hosting Claude session injects, so the spawned CLI uses its own login.
 * The host also hides the user's persisted login variables, which are read back on Windows.
 */
export function standalone_claude_env(env = process.env, persisted = persisted_claude_env) {
  if (env.CLAUDECODE !== '1') return env;
  const own = Object.entries(env).filter(([key]) =>
    !/^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT)$|^(CLAUDE_CODE_|CLAUDE_AGENT_SDK_|CLAUDE_PREVIEW_)/.test(key));
  return { ...Object.fromEntries(own), ...persisted() };
}

let persisted_cache;
/** Read Machine then User persisted ANTHROPIC_/CLAUDE variables once; values stay in memory only. */
function persisted_claude_env() {
  if (process.platform !== 'win32') return {};
  if (!persisted_cache) {
    const script = "$r=@{}; foreach($s in 'Machine','User'){ $v=[Environment]::GetEnvironmentVariables($s);"
      + " foreach($k in $v.Keys){ if($k -match '^(ANTHROPIC_|CLAUDE)'){ $r[$k]=$v[$k] } } }; $r | ConvertTo-Json -Compress";
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });
    try { persisted_cache = result.status === 0 && result.stdout.trim() ? JSON.parse(result.stdout) : {}; }
    catch { persisted_cache = {}; }
  }
  return persisted_cache;
}

/** Claude permission rules match Windows paths in POSIX form, e.g. C:\a becomes //c/a. */
export function claude_rule_path(directory) {
  const path = resolve(directory).replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
  return `/${path}`;
}

/**
 * Allow the listed codiscuss website subcommands and draft writes for this run; a writable member also edits its project
 * and runs any command. User rules are added after. Claude Code on Windows may run commands through its PowerShell tool
 * instead of Bash, so both are listed.
 */
export function claude_permissions(config, task) {
  // A headless run cannot ask for approval: 自动 and a taken-over manual member use auto mode, as the original window
  // does, and 全放开 skips every check; the website commands and drafts stay pre-approved either way.
  if (['own', 'auto', 'full'].includes(config.project_access)) {
    const commands = TASK_SUBCOMMANDS.flatMap(command => [`Bash(codiscuss ${command} *)`, `PowerShell(codiscuss ${command} *)`]);
    return ['--permission-mode', config.project_access === 'full' ? 'bypassPermissions' : 'auto', '--add-dir', task.directory, task.draft_directory, task.skills_directory, '--allowedTools',
      ...commands, `Edit(${claude_rule_path(task.draft_directory)}/**)`, ...(config.allowed_tools || [])];
  }
  const commands = runs_commands(config) ? ['Bash', 'PowerShell']
    : TASK_SUBCOMMANDS.flatMap(command => [`Bash(codiscuss ${command} *)`, `PowerShell(codiscuss ${command} *)`]);
  const writable = [task.draft_directory, ...(runs_commands(config) ? [project_directory(config)] : [])];
  return ['--add-dir', task.directory, task.draft_directory, task.skills_directory, '--allowedTools',
    ...commands, ...writable.map(directory => `Edit(${claude_rule_path(directory)}/**)`), ...(config.allowed_tools || [])];
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
};

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

/** Post one task into an open Claude window; it starts a turn there, or between tool calls of the turn it is in. */
async function inbox_delivery(config, inbox, task) {
  try { bind_access(task.access_path, config.session_id); }
  catch (error) { throw not_sent(error); }
  const text = `CoDiscuss 本机服务代房间转达（你已注册为该房间成员，这是房间分派给你的任务）：\n${task.prompt}`;
  const lines = [{ type: 'auth', token: inbox.token }, { type: 'user', message: { role: 'user', content: text } }];
  await new Promise((resolve_sent, reject) => {
    let written = false;
    const socket = connect(inbox.socket, () => {
      socket.end(lines.map(line => `${JSON.stringify(line)}\n`).join(''), () => { written = true; resolve_sent(); });
    });
    socket.on('error', error => written ? undefined : reject(not_sent(error)));
  });
  // The discussion runner enters the execution once the session is known, as it does when a process reports it.
  task.on_binding?.(config.session_id);
  const marker = `${task.id}.task.json`;
  setTimeout(() => {
    if (!session_mentions(config.session_id, marker)) {
      task.on_note?.('已投递到原窗口，但它还没开始处理：原窗口可能处于跳过审批模式（需在窗口中批准这条消息）或仍在忙。');
    }
  }, INBOX_CHECK_MS).unref();
  return { session_id: config.session_id, status: 'accepted', capabilities: WINDOW };
}

/** Whether a Claude session's log contains some text, e.g. the task file a delivered prompt names. */
function session_mentions(session_id, text, env = process.env) {
  const file = session_path(session_id, env, homedir());
  try { return Boolean(file) && readFileSync(file, 'utf8').includes(text); } catch { return false; }
}

/** Use one official Claude process per turn and resume the persisted session, or post into the member's open window. */
async function deliver(config, binding, task, spawn_process = spawn) {
  const window = config.project_access === 'own' && binding.session_id && binding.session_id === config.session_id ? claude_window(config.session_id) : null;
  // Only a task written for the window names its credential file; a background process gets it through its environment.
  if (window?.inbox && task.inbox) return inbox_delivery(config, window.inbox, task);
  binding = adopted_fork(config, binding, Boolean(window));
  const session_id = binding.session_id || randomUUID();
  try { bind_access(task.access_path, session_id); }
  catch (error) { throw not_sent(error); }
  // Streamed events show the turn's progress; the final line is still the result that decides success.
  // A rewound or forked member first forks its earlier session into the ID it is now bound to, cut at `at` when given.
  const fork = binding.fork ? ['--resume', binding.fork.from, '--fork-session', ...(binding.fork.at ? ['--resume-session-at', binding.fork.at] : []), '--session-id', session_id]
    : [binding.session_id ? '--resume' : '--session-id', session_id];
  const args = ['-p', '--output-format', 'stream-json', '--verbose', ...fork,
    ...(config.model ? ['--model', config.model] : []), ...(config.effort ? ['--effort', config.effort] : []), ...claude_permissions(config, task)];
  let child;
  try {
    child = spawn_process(config.executable, [...args, '--', task.prompt], {
      cwd: launch_directory(config, task), windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...standalone_claude_env(), DISCUSS_ACCESS_FILE: task.access_path },
    });
  } catch (error) { throw not_sent(error); }
  tree_killable(child);
  let spawned = false;
  const log_path = resolve(task.directory, `claude-${task.id}.log`);
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; task.on_output(log_path, chunk); });
  child.stderr.on('data', chunk => task.on_output(log_path, chunk));
  watch_events(claude, child.stdout, task);
  child.once('close', code => {
    if (!spawned) return;
    const denials = claude_denials(output);
    if (denials.length) task.on_denials?.(denials);
    const error = claude_exit_error(code, output);
    if (error) task.on_failure(error);
    else task.on_exit?.();
  });
  task.on_process(child);
  await new Promise((resolve_spawn, reject) => {
    child.once('spawn', () => { spawned = true; resolve_spawn(); });
    child.once('error', error => spawned ? task.on_failure(error.message) : reject(not_sent(error)));
  });
  // A failed spawn creates no session; only a successfully started process can be resumed.
  task.on_binding(session_id);
  return { session_id, status: 'accepted', capabilities: PROCESS };
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
  deliver, events,
  session: { path: session_path, exists: session_exists, owns: session_exists, cwd: session_cwd, branch, settings: session_settings },
  models: { list: models, defaults },
};

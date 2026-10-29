/** Actual software entrypoints; never call model service APIs. */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CodexAppClient } from './codex_app_client.mjs';

const CALL_TIMEOUT_MS = 30_000;
const CLI_DIAGNOSTIC_CHARS = 1000;
/** Codex exec may linger after its final event; the finished turn is already saved, so stop it to free the session. */
const CLI_EXIT_GRACE_MS = 1500;
// A hung CLI keeps its lease renewed forever when the room sets no execution limit, so cap every process.
const CLI_MAX_RUN_MS = 2 * 60 * 60_000;
const CODEX_PERMISSIONS_MIN_MINOR = 163;
/** Website subcommands an automatic task may run; service, launch, run, api and setup stay unapproved. */
export const TASK_SUBCOMMANDS = ['room', 'message', 'turn', 'state', 'execution', 'health', 'schema'];

/** The agy project allows only codiscuss commands and headless agy ends the turn on a denied one, so every agy task states it; no member prompt can drop it. */
export function agy_command_rule(adapter, cli) {
  return adapter === 'antigravity_cli' ? `无人值守下 run_command 只能运行 ${cli} 的 subcommands 子命令，其他命令会被自动拒绝并使会话直接结束；列目录、搜索或读取文件用 list_dir、find_by_name、grep_search、view_file。` : '';
}

/** Only failures before a software invocation are safe for automatic redelivery. */
function not_sent(error) { return Object.assign(error, { delivery_status: 'not_sent' }); }

/** Persist small private state atomically without logging its contents. */
export function atomic_json(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(temporary, path);
}

/** Run an executable directly; user text is always an argv value, never shell code. */
export function run_program(executable, args, options = {}) {
  return new Promise((resolve_result, reject) => {
    let child;
    try { child = spawn(executable, args, { windowsHide: true, shell: false, ...options }); }
    catch (error) { reject(not_sent(error)); return; }
    let spawned = false;
    child.once('spawn', () => { spawned = true; });
    let output = '';
    let error_text = '';
    child.stdout?.on('data', chunk => { output += chunk; });
    child.stderr?.on('data', chunk => { error_text += chunk; });
    child.once('error', error => reject(spawned ? error : not_sent(error)));
    child.once('close', code => code === 0 ? resolve_result(output) : reject(new Error(`软件退出码 ${code}: ${error_text.slice(-500)}`)));
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin?.end();
  });
}

/** Bind returned software identities back to the private credential file. */
function bind_access(path, session_id) {
  const access = JSON.parse(readFileSync(path, 'utf8'));
  atomic_json(path, { ...access, session_id });
}

/** Deliver one task to Codex's real App, with the original chat reused afterward. */
async function codex_delivery(config, binding, task) {
  if (binding.session_id) {
    try { bind_access(task.access_path, binding.session_id); }
    catch (error) { throw not_sent(error); }
    const receipt = await run_program(config.executable, ['queue', '--thread', binding.session_id, '--message', task.prompt], { timeout: CALL_TIMEOUT_MS });
    return { session_id: binding.session_id, status: 'accepted', receipt };
  }
  const app = new CodexAppClient(config.pipe_path);
  try {
    let target;
    try { await app.open(); target = await codex_target(app, config); }
    catch (error) { throw not_sent(error); }
    const result = await app.create_thread(config.source_thread_id, task.prompt, `CoDiscuss · ${task.participant}`, target);
    task.on_binding(result.thread_id);
    bind_access(task.access_path, result.thread_id);
    return { session_id: result.thread_id, status: 'accepted' };
  } finally { app.close(); }
}

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

/** Compare local directory identities without assuming case sensitivity on Windows. */
export function same_path(left, right) {
  if (!left || !right) return false;
  const normalize = value => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
  return normalize(left) === normalize(right);
}

/** Use one official Claude process per turn and resume the persisted session. */
/** Explain why a finished Claude print run failed, including errors reported with exit code 0. */
export function claude_exit_error(code, output) {
  let result = null;
  try { result = JSON.parse(output.trim().split(/\r?\n/).at(-1)); } catch { /* Non-JSON output keeps the exit code check. */ }
  if (result?.is_error) return `Claude 执行出错：${result.result || result.api_error || result.subtype || '未知错误'}`;
  return code === 0 ? '' : `Claude 退出码 ${code}`;
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

/** The participant's discussion project directory; workdir is the legacy field name. */
function project_directory(config) { return config.cwd || config.workdir || ''; }

/** Keep the requested project as cwd; without a project, use the separate answer directory. */
export function launch_directory(config, task) {
  return project_directory(config) || task.draft_directory;
}

/** Allow only the discussion website commands, without shell separators or expressions. */
export function agy_rule() {
  const safe = '[^;&|<>$`()\\r\\n]';
  return `command(regex:^codiscuss(\\.cmd)?( --site ${safe.replace('[^', '[^ ')}+)? (${TASK_SUBCOMMANDS.join('|')})( ${safe}*)?$)`;
}

/** Read optional native settings; malformed settings must not silently disable a permission check. */
function read_json(path) { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}; }

/** Native headless review blocks unapproved shell commands; only a global grant of every command could bypass the project rules. */
function check_agy_shell(user_home) {
  const cli = read_json(join(user_home, '.gemini', 'antigravity-cli', 'settings.json'));
  const shared = read_json(join(user_home, '.gemini', 'config', 'config.json'));
  const grants = [...(cli.permissions?.allow || []), ...(shared.userSettings?.globalPermissionGrants?.allow || [])];
  if (grants.some(rule => rule === '*' || /^(?:command|unsandboxed|unsandboxed_command)\((?:\*|regex:\.\*)\)$/.test(rule))) {
    throw new Error('agy 全局设置放行了所有命令，会绕过讨论项目的权限；请移除全局 command(*) / unsandboxed(*) 放行，具体命令的放行不受影响（本工具旧版写入的规则可运行 codiscuss setup 清理），未交付讨论任务');
  }
}

/** Test directory containment on the current platform, including Windows drive boundaries. */
function within_directory(parent, child) {
  const path = relative(resolve(parent), resolve(child));
  return !path || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`));
}

/** Resolve only the user's selected folders; do not inherit another project's grants or settings. */
function agy_resources(config, task, root) {
  if (config.project_id || config.project_name) return antigravity_project(config, root).projectResources?.resources || [];
  return [{ folder: { folderUri: pathToFileURL(launch_directory(config, task)).href } }];
}

/** Build native deny rules for protected directories, with separate writable answer storage. */
function agy_project_grants(config, task, resources, user_home) {
  const folders = resources.map(resource => resource.gitFolder?.folderUri || resource.folder?.folderUri)
    .filter(uri => uri?.startsWith('file:')).map(uri => fileURLToPath(uri));
  const projects = [...new Set([project_directory(config), ...folders].filter(directory => directory && !same_path(directory, task.draft_directory)))];
  const protected_paths = [task.directory, task.skills_directory, join(user_home, '.gemini'),
    ...(config.project_access === 'write' ? [] : projects)];
  if (protected_paths.some(directory => within_directory(directory, task.draft_directory))) {
    throw new Error('agy 草稿目录不能位于只读项目、运行目录、技能或 .gemini 配置目录中，未交付讨论任务');
  }
  const write_rule = directory => `write_file(${resolve(directory).replaceAll('\\', '/')})`;
  return { allow: [agy_rule(), write_rule(task.draft_directory),
    ...(config.project_access === 'write' ? projects.map(write_rule) : [])],
  deny: [...new Set(protected_paths.map(write_rule)), 'mcp(*)'] };
}

/** Run agy only inside a private native project this tool created; external conversations keep their own project, so they are refused. */
export function prepare_agy_project(config, binding, task, user_home = homedir()) {
  const key = createHash('sha256').update(task.participant).digest('hex');
  const record_path = join(task.directory, `agy-project-${key}.json`);
  const record = read_json(record_path);
  if (binding.session_id && !record.project_id) {
    throw new Error('agy 只在本工具新建的讨论会话中自动执行；该会话不是本工具创建的，无法套用讨论项目权限，未交付讨论任务');
  }
  if (record.session_id && record.session_id !== binding.session_id) throw new Error('agy 项目记录与会话绑定不符，未交付讨论任务');
  check_agy_shell(user_home);
  const root = join(user_home, '.gemini', 'config');
  const resources = agy_resources(config, task, root);
  const grants = agy_project_grants(config, task, resources, user_home);
  const project_id = record.project_id || randomUUID();
  if (!/^[a-f0-9-]{36}$/.test(project_id)) throw new Error('agy 项目记录无效，未交付讨论任务');
  const path = join(root, 'projects', `${project_id}.json`);
  const current = read_json(path);
  if (record.project_id && current.id !== project_id) throw new Error('agy 讨论项目已丢失或不匹配，未交付讨论任务');
  mkdirSync(join(root, 'projects'), { recursive: true });
  const name = ['CoDiscuss', task.room_title, task.participant].filter(Boolean).join(' · ');
  atomic_json(path, { ...current, id: project_id, name,
    projectResources: { resources }, settings: {}, permissionGrants: { permissionGrants: grants, v2Migrated: true } });
  const saved = { project_id, session_id: record.session_id || '' };
  atomic_json(record_path, saved);
  return { project_id, bind: session_id => atomic_json(record_path, { ...saved, session_id }) };
}

/**
 * Delete the agy projects this room created after the room itself is deleted; the user's own projects are never touched.
 * @returns {number} How many project records were cleared.
 */
export function remove_agy_projects(directory, user_home = homedir()) {
  if (!existsSync(directory)) return 0;
  const records = readdirSync(directory).filter(name => /^agy-project-[a-f0-9]{64}\.json$/.test(name));
  for (const file of records) {
    const { project_id } = read_json(join(directory, file));
    const path = join(user_home, '.gemini', 'config', 'projects', `${project_id}.json`);
    if (/^[a-f0-9-]{36}$/.test(project_id || '') && read_json(path).id === project_id) rmSync(path);
    rmSync(join(directory, file));
  }
  return records.length;
}

/**
 * Allow only listed codiscuss website subcommands and draft writes for this run; user rules are added after.
 * Claude Code on Windows may run commands through its PowerShell tool instead of Bash, so both are listed.
 */
export function claude_permissions(config, task) {
  const commands = TASK_SUBCOMMANDS.flatMap(command => [`Bash(codiscuss ${command} *)`, `PowerShell(codiscuss ${command} *)`]);
  const writable = [task.draft_directory, ...(config.project_access === 'write' && project_directory(config) ? [project_directory(config)] : [])];
  return ['--add-dir', task.directory, task.draft_directory, task.skills_directory, '--allowedTools',
    ...commands, ...writable.map(directory => `Edit(${claude_rule_path(directory)}/**)`), ...(config.allowed_tools || [])];
}

/**
 * Windows leaves a killed process's descendants running, so a stopped Claude turn kept its tool commands working.
 * End the whole tree there; elsewhere, or when taskkill cannot run, use the plain kill.
 */
export function kill_process_tree(child, plain_kill, platform = process.platform, run = spawnSync) {
  if (platform === 'win32' && child.pid && child.exitCode === null && child.signalCode === null) {
    try {
      if (run('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: CALL_TIMEOUT_MS }).status === 0) return true;
    } catch { /* Fall through to the plain kill. */ }
  }
  return plain_kill();
}

/** Make a delivered process's kill end its whole tree on Windows, so a stopped turn leaves no tool commands running. */
function tree_killable(child) {
  if (typeof child.kill === 'function') {
    const plain_kill = child.kill.bind(child);
    child.kill = () => kill_process_tree(child, plain_kill);
  }
  return child;
}

const EDIT_TOOLS = /^(Edit|MultiEdit|Write|NotebookEdit|write_file|write_to_file|replace_file_content|multi_replace_file_content)$/;

/**
 * What a streamed CLI event says the agent is doing: thinking, command, tool, editing or writing.
 * Returns '' when the event says nothing about it; the page only shows the latest phase.
 */
export function activity_phase(adapter, event) {
  if (adapter === 'claude') {
    if (event.type === 'system' || event.type === 'user') return 'thinking';
    const block = event.type === 'assistant' ? event.message?.content?.at(-1) : null;
    if (block?.type === 'tool_use') return /^(Bash|PowerShell)$/.test(block.name) ? 'command' : EDIT_TOOLS.test(block.name) ? 'editing' : 'tool';
    return block?.type === 'text' ? 'writing' : block?.type === 'thinking' ? 'thinking' : '';
  }
  if (adapter === 'codex_cli') {
    if (event.type === 'turn.started') return 'thinking';
    const kind = event.item?.type;
    if (event.type === 'item.started') {
      return { command_execution: 'command', file_change: 'editing', mcp_tool_call: 'tool', web_search: 'tool', reasoning: 'thinking' }[kind] || '';
    }
    if (event.type === 'item.completed') return kind === 'agent_message' ? 'writing' : 'thinking';
    return '';
  }
  if (event.event === 'init') return 'thinking';
  const step = event.step_update;
  if (!step) return '';
  if (step.step_type === 'agent_response' && step.state === 'ACTIVE') return 'writing';
  if (step.step_type !== 'tool' || ['DONE', 'ERROR'].includes(step.state)) return 'thinking';
  return step.tool_name === 'run_command' ? 'command' : EDIT_TOOLS.test(step.tool_name || '') ? 'editing' : 'tool';
}

/** The tool an event starts, by name only: never its arguments or command text. Returns '' for any other event. */
export function activity_tool(adapter, event) {
  if (adapter === 'claude') {
    const block = event.type === 'assistant' ? event.message?.content?.at(-1) : null;
    return block?.type === 'tool_use' ? String(block.name || '') : '';
  }
  if (adapter === 'codex_cli') {
    if (event.type !== 'item.started') return '';
    return event.item?.type === 'mcp_tool_call' ? String(event.item.tool || '') : event.item?.type === 'web_search' ? 'web_search' : '';
  }
  const step = event.step_update;
  return step?.step_type === 'tool' && !['DONE', 'ERROR'].includes(step.state) ? String(step.tool_name || '') : '';
}

/** Segments one execution may record, how many one report carries, and a tool name's length; the website enforces the same. */
export const MAX_EXECUTION_SEGMENTS = 400;
export const MAX_SEGMENTS_PER_REPORT = 40;
export const MAX_SEGMENT_TOOL = 60;
/** Progress notes kept per execution, each cut to this length, and how many one report carries; the website enforces the same. */
export const MAX_EXECUTION_NOTES = 50;
export const MAX_NOTE_LENGTH = 500;
export const MAX_NOTES_PER_REPORT = 10;

/**
 * What each execution's software showed while it worked, waiting to be reported: the phases it went through, as
 * millisecond offsets from its delivery on this machine's clock, and its progress notes. Consecutive events of the same
 * phase and tool extend one segment. The open segment is reported as far as it has run and again once it runs further;
 * numbering makes a resent report harmless.
 */
export class SegmentLog {
  constructor(now = Date.now) {
    this.now = now;
    this.executions = new Map();
  }
  /** Begin timing one execution at its delivery; a repeated start keeps the first origin. */
  start(id) {
    if (!this.executions.has(id)) this.executions.set(id, { origin: this.now(), last: 0, open: null, closed: [], next_seq: 0,
      notes: [], next_note: 0, open_sent: null, reported: 0 });
  }
  /** Queue one progress note; notes past the cap are dropped. Cut by UTF-16 units like the website's check, never mid-pair. */
  note(id, text) {
    const log = this.executions.get(id);
    if (!log || log.next_note >= MAX_EXECUTION_NOTES) return;
    log.next_note += 1;
    log.notes.push({ seq: log.next_note, text: text.slice(0, MAX_NOTE_LENGTH).replace(/[\uD800-\uDBFF]$/, '') });
  }
  /** The software produced output now; a phase, when the output names one, starts a new segment unless it continues the open one. */
  mark(id, phase = '', tool = '') {
    const log = this.executions.get(id);
    if (!log) return;
    log.last = this.now() - log.origin;
    if (log.open) log.open.end_ms = log.last;
    if (!phase) return;
    tool = tool.slice(0, MAX_SEGMENT_TOOL).replace(/[\uD800-\uDBFF]$/, '');
    if (log.open?.phase === phase && log.open.tool === tool) return;
    if (log.open) log.closed.push(log.open);
    log.open = null;
    if (log.next_seq >= MAX_EXECUTION_SEGMENTS) return;
    log.next_seq += 1;
    log.open = { seq: log.next_seq, phase, tool, start_ms: log.last, end_ms: log.last };
  }
  /** Whether something new waits to be reported (an open segment only once it ran further) and the last report is `interval_ms` old. */
  due(id, interval_ms) {
    const log = this.executions.get(id);
    const open_moved = log?.open && !(log.open_sent?.seq === log.open.seq && log.open_sent.end_ms === log.open.end_ms);
    return Boolean(log && (log.closed.length || log.notes.length || open_moved) && this.now() - log.reported >= interval_ms);
  }
  /** The next report: closed segments first, then the open one as it stands, and the queued notes. `final` closes the open segment. */
  batch(id, final = false) {
    const log = this.executions.get(id);
    if (!log) return { segments: [], notes: [] };
    if (final && log.open) { log.closed.push(log.open); log.open = null; }
    const segments = log.closed.slice(0, MAX_SEGMENTS_PER_REPORT);
    if (log.open && segments.length < MAX_SEGMENTS_PER_REPORT) segments.push({ ...log.open });
    return { segments, notes: log.notes.slice(0, MAX_NOTES_PER_REPORT) };
  }
  /** Forget what a successful report carried in full; a segment that ran on since it was sent stays. */
  sent(id, batch) {
    const log = this.executions.get(id);
    if (!log) return;
    const ends = new Map(batch.segments.map(segment => [segment.seq, segment.end_ms]));
    log.closed = log.closed.filter(segment => !(ends.has(segment.seq) && segment.end_ms <= ends.get(segment.seq)));
    const notes = new Set(batch.notes.map(note => note.seq));
    log.notes = log.notes.filter(note => !notes.has(note.seq));
    const open = log.open && batch.segments.find(segment => segment.seq === log.open.seq);
    if (open) log.open_sent = { seq: open.seq, end_ms: open.end_ms };
    log.reported = this.now();
  }
  /**
   * Send the execution's segments and notes with `send({segments, notes})`. `final` closes the open segment, sends
   * everything left and forgets the execution. A refused report drops them and any other failure keeps them for the
   * next try; it never throws, so a progress report cannot fail the execution it describes.
   */
  async report(id, final, send) {
    do {
      const batch = this.batch(id, final);
      if (!batch.segments.length && !batch.notes.length) break;
      try { await send(batch); }
      catch (error) {
        if (/HTTP 4\d\d/.test(error.message)) this.drop(id);
        return;
      }
      this.sent(id, batch);
    } while (final && (this.executions.get(id)?.closed.length || this.executions.get(id)?.notes.length));
    if (final) this.drop(id);
  }
  drop(id) { this.executions.delete(id); }
}

/**
 * Text the agent wrote to the user in one streamed event, such as a progress remark between tool calls.
 * agy streams a response in deltas, so its text is collected per step in `responses` and returned when the step ends.
 */
export function progress_note(adapter, event, responses = new Map()) {
  if (adapter === 'claude') {
    if (event.type !== 'assistant') return '';
    return (event.message?.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n').trim();
  }
  if (adapter === 'codex_cli') return event.type === 'item.completed' && event.item?.type === 'agent_message' ? String(event.item.text || '').trim() : '';
  const step = event.step_update;
  if (step?.step_type !== 'agent_response') return '';
  responses.set(step.step_index, (responses.get(step.step_index) || '') + (step.text_delta || ''));
  if (step.state === 'ACTIVE') return '';
  const text = responses.get(step.step_index).trim();
  responses.delete(step.step_index);
  return text;
}

/** Report the phase and any progress note of each complete JSON line; malformed lines are left to the caller's own parsing. */
function watch_activity(adapter, stream, task) {
  if (!task.on_activity && !task.on_note) return;
  createInterface({ input: stream, crlfDelay: Infinity }).on('line', line => {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    const phase = activity_phase(adapter, event);
    if (phase) task.on_activity?.(phase, activity_tool(adapter, event));
    const note = progress_note(adapter, event);
    if (note) task.on_note?.(note);
  });
}

async function claude_delivery(config, binding, task, spawn_process = spawn) {
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
  watch_activity('claude', child.stdout, task);
  child.once('close', code => {
    if (!spawned) return;
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
  return { session_id, status: 'accepted' };
}

/** Build a per-invocation profile without inheriting a user's custom profile of the same name. */
export function codex_permissions(config, task, platform = process.platform) {
  const name = `codiscuss-${randomUUID()}`;
  const base = project_directory(config) && config.project_access === 'write' ? ':workspace' : ':read-only';
  const drafts = resolve(task.draft_directory).replaceAll('\\', '/');
  const filesystem = { ':root': 'read', [resolve(task.directory).replaceAll('\\', '/')]: 'read', [drafts]: 'write' };
  const rules = Object.entries(filesystem).map(([path, access]) => `${JSON.stringify(path)}=${JSON.stringify(access)}`).join(',');
  const profile = `{extends=${JSON.stringify(base)},filesystem={${rules}},network={enabled=true}}`;
  // The Windows sandbox account cannot write the user's TEMP, so PowerShell starts in ConstrainedLanguage and Codex's
  // UTF-8 output setup fails silently, garbling Chinese; a TEMP inside the writable drafts keeps FullLanguage.
  const temp = platform === 'win32' ? ['-c', `shell_environment_policy.set.TEMP=${JSON.stringify(drafts)}`,
    '-c', `shell_environment_policy.set.TMP=${JSON.stringify(drafts)}`] : [];
  return { name, args: ['-c', `default_permissions=${JSON.stringify(name)}`, '-c', `permissions.${name}=${profile}`,
    '-c', 'approval_policy="never"', ...temp] };
}

/** Read effective Codex config through its local CLI; no thread or model is started. */
function read_codex_config(config, task, permissions, spawn_process) {
  return new Promise((resolve_config, reject) => {
    const child = spawn_process(config.executable, ['app-server', ...permissions.args], {
      cwd: launch_directory(config, task), windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
    });
    task.on_process(child);
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); lines.close();
      const complete = () => error ? reject(not_sent(error)) : resolve_config(value);
      if (child.exitCode !== null || child.signalCode !== null) complete();
      else { child.once('close', complete); child.kill(); }
    };
    const timer = setTimeout(() => finish(new Error('Codex 权限配置检查超时，未交付讨论任务')), CALL_TIMEOUT_MS);
    const send = (id, method, params) => child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    child.once('error', error => finish(error));
    child.once('close', () => finish(new Error('Codex 无法读取权限配置，请使用支持 permission profiles 的 CLI')));
    child.stdin.on('error', error => finish(error));
    child.stderr.resume();
    lines.on('line', line => {
      let response;
      try { response = JSON.parse(line); } catch { return; }
      if (![1, 2].includes(response.id)) return;
      if (response.error) return finish(new Error(`Codex 权限配置检查失败：${response.error.message}`));
      if (response.id === 1) {
        const version = response.result?.userAgent?.match(/\/(\d+)\.(\d+)\.\d+\b/);
        if (!version || (Number(version[1]) === 0 && Number(version[2]) < CODEX_PERMISSIONS_MIN_MINOR)) {
          return finish(new Error('本次权限配置需要 Codex CLI 0.163.0 或更新版本，未交付讨论任务'));
        }
        send(2, 'config/read', { cwd: launch_directory(config, task), includeLayers: false });
      }
      else finish(null, response.result?.config);
    });
    send(1, 'initialize', { clientInfo: { name: 'codiscuss', version: '0.1.0' } });
  });
}

/** Reject legacy overrides that would silently replace the requested filesystem policy. */
async function check_codex_permissions(config, task, permissions, spawn_process) {
  const effective = await read_codex_config(config, task, permissions, spawn_process).catch(error => { throw not_sent(error); });
  if (effective?.sandbox_mode != null || effective?.sandbox_workspace_write != null) {
    throw not_sent(new Error('Codex 配置含旧 sandbox_mode / sandbox_workspace_write，会覆盖本次权限；请移除旧配置后重试，未交付讨论任务'));
  }
  if (effective?.default_permissions !== permissions.name || !effective?.permissions?.[permissions.name]) {
    throw not_sent(new Error('Codex 未采用本次 permission profile，未交付讨论任务；请更新 CLI'));
  }
}

/** Build native CLI arguments; every continuation names the exact bound conversation. */
function cli_invocation(config, binding, task, user_home) {
  if (config.adapter === 'codex_cli') {
    const permissions = codex_permissions(config, task);
    const args = ['exec', '--cd', launch_directory(config, task)];
    if (binding.session_id) args.push('resume', binding.session_id);
    args.push(...permissions.args, '--json', '--skip-git-repo-check', ...(config.model ? ['-m', config.model] : []),
      ...(config.effort ? ['-c', `model_reasoning_effort="${config.effort}"`] : []), '-');
    return { args, input: task.prompt, permissions };
  }
  // An agy expert the owner chose to host keeps the project and permissions of its own conversation; only new conversations get the discussion project.
  const project = config.session_id ? null : prepare_agy_project(config, binding, task, user_home);
  const args = ['--output-format', 'stream-json', '--print-timeout', '0', '--add-dir', task.directory,
    '--add-dir', task.draft_directory, '--add-dir', task.skills_directory];
  args.push('--mode', 'accept-edits', ...(project ? ['--project', project.project_id] : []));
  if (binding.session_id) args.push('--conversation', binding.session_id);
  if (config.model) args.push('--model', config.model);
  if (config.effort) args.push('--effort', config.effort);
  args.push('-p', task.prompt);
  return { args, project };
}

/** Persist an emitted identity before the agent reads its execution credential file. */
function bind_cli_session(state, session_id, task) {
  if (typeof session_id !== 'string' || !session_id) throw new Error('CLI 未返回实际会话 ID');
  if (state.session_id && state.session_id !== session_id) throw new Error('CLI 返回的会话 ID 与绑定不符，已停止本次执行');
  task.on_binding(session_id);
  bind_access(task.access_path, session_id);
  state.session_id = session_id;
  state.initialized = true;
}

/** Consume only documented lifecycle events, not text produced by agent tools. */
function cli_event(adapter, state, event, task) {
  if (adapter === 'codex_cli') {
    if (event.type === 'thread.started') bind_cli_session(state, event.thread_id, task);
    if (event.type === 'turn.completed') { state.completed = true; state.finish_timer = setTimeout(() => { state.finished = true; task.on_trace?.('kill_after_completed'); state.child.kill(); }, CLI_EXIT_GRACE_MS); }
    if (event.type === 'turn.failed') state.error = event.error?.message || 'Codex CLI 执行失败';
    if (event.type === 'error') state.diagnostic = event.message || 'Codex CLI 返回错误';
    remember_writer_conflict(state, state.error || state.diagnostic);
    return;
  }
  if (event.event === 'init') bind_cli_session(state, event.conversation_id, task);
  const step = event.step_update;
  // Headless agy ends its turn when a command needs approval; remember which one so the pause can name it.
  if (step?.state === 'ERROR' && /permission/.test(step.tool_info?.error?.message || '')) {
    const command = step.tool_info.parameters?.CommandLine || step.tool_name || '';
    state.denial = `运行了未授权的命令「${String(command).slice(0, 120)}」，无人值守模式下无法确认权限而被自动拒绝，随后会话结束`;
  }
  if (event.event === 'result') {
    const result = event.result || {};
    if (result.conversation_id) bind_cli_session(state, result.conversation_id, task);
    state.completed = result.status === 'SUCCESS';
    if (!state.completed) state.error = `Antigravity CLI ${result.status || '缺少结果状态'}：${result.error?.message || result.response || '执行未成功'}`;
  }
}

/** Record lifecycle events and tool commands with timestamps so slow stages can be located from the trace file. */
function trace_cli_event(event, task) {
  if (!task.on_trace) return;
  const item = event.item;
  const command = item?.command ? String(item.command).replace(/^.*?-Command\s+/, '').slice(0, 100) : '';
  const type = event.type ?? event.event ?? 'unknown';
  task.on_trace(item ? `${type}:${item.type}` : type, command ? { command } : {});
}

/** Keep the actual resume failure even when later model-refresh logs replace the diagnostic tail. */
function remember_writer_conflict(state, diagnostic) {
  if (/thread-store conflict:[\s\S]*already has an active writer/.test(diagnostic)) state.writer_conflict = true;
}

/** Distinguish process completion from successful CLI output and saved website work. */
function cli_exit_error(state, code, signal) {
  if (state.writer_conflict) return `Codex 会话 ${state.session_id} 已被另一进程持有（active writer），CLI 无法接管。若为 App 中的聊天，请使用 Codex App 接入；独立 CLI 须使用未被占用的会话。重复点击重试不会解除占用`;
  if (state.error) return state.error;
  if (state.finished && state.completed) return '';
  if (code !== 0) return `CLI ${signal ? `被信号 ${signal} 终止` : `退出码 ${code}`}：${state.diagnostic}`;
  if (!state.initialized) return `CLI 未确认实际会话 ID：${state.diagnostic}`;
  if (!state.completed) return `CLI 未返回成功结束事件：${state.diagnostic}`;
  return '';
}

/** Parse complete UTF-8 JSON lines while keeping raw output in the private task log. */
function monitor_cli(child, config, binding, task) {
  const state = { child, session_id: binding.session_id || '', initialized: false, completed: false, error: '', diagnostic: '', responses: new Map() };
  const log_path = resolve(task.directory, `${config.adapter}-${task.id}.log`);
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const max_run_ms = Number(process.env.CODISCUSS_CLI_MAX_MS) || CLI_MAX_RUN_MS;
  state.limit_timer = setTimeout(() => { state.error = `CLI 运行超过 ${Math.round(max_run_ms / 1000)} 秒仍未结束，已终止`; child.kill(); }, max_run_ms);
  child.stdout.on('data', chunk => task.on_output(log_path, chunk));
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => {
    if (config.adapter === 'codex_cli') remember_writer_conflict(state, state.diagnostic + chunk);
    state.diagnostic = (state.diagnostic + chunk).slice(-CLI_DIAGNOSTIC_CHARS).trim();
    task.on_output(log_path, chunk);
  });
  lines.on('line', line => {
    if (!line.trim()) return;
    let event;
    try { event = JSON.parse(line); }
    catch { state.diagnostic = 'CLI 输出中存在无效 JSON，详情见本机日志'; return; }
    trace_cli_event(event, task);
    const phase = activity_phase(config.adapter, event);
    if (phase) task.on_activity?.(phase, activity_tool(config.adapter, event));
    const note = progress_note(config.adapter, event, state.responses);
    if (note) task.on_note?.(note);
    try { cli_event(config.adapter, state, event, task); }
    catch (error) { state.error = error.message; child.kill(); }
  });
  child.once('close', (code, signal) => {
    clearTimeout(state.finish_timer);
    clearTimeout(state.limit_timer);
    task.on_trace?.('cli_closed', { code, signal, killed_after_completed: Boolean(state.finished) });
    if (!state.spawned) return;
    const error = cli_exit_error(state, code, signal);
    if (error) task.on_failure(error);
    else task.on_exit?.(state.denial);
  });
  return state;
}

/** Start one headless CLI turn; native agy permissions belong to a separate discussion project. */
async function cli_delivery(config, binding, task, spawn_process, user_home) {
  if (binding.session_id) {
    try { bind_access(task.access_path, binding.session_id); }
    catch (error) { throw not_sent(error); }
  }
  let invocation;
  try { invocation = cli_invocation(config, binding, task, user_home); }
  catch (error) { throw not_sent(error); }
  if (invocation.permissions) {
    task.on_trace?.('permission_check_start');
    await check_codex_permissions(config, task, invocation.permissions, spawn_process);
    task.on_trace?.('permission_check_done');
  }
  if (invocation.project) {
    const on_binding = task.on_binding;
    task = { ...task, on_binding: session_id => { invocation.project.bind(session_id); on_binding(session_id); } };
  }
  let child;
  try {
    child = spawn_process(config.executable, invocation.args, {
      cwd: launch_directory(config, task), windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, DISCUSS_ACCESS_FILE: task.access_path },
    });
  } catch (error) { throw not_sent(error); }
  tree_killable(child);
  const state = monitor_cli(child, config, binding, task);
  task.on_process(child);
  await new Promise((resolve_spawn, reject) => {
    child.once('spawn', () => { state.spawned = true; task.on_trace?.('cli_spawned'); resolve_spawn(); });
    child.once('error', error => state.spawned ? task.on_failure(error.message) : reject(not_sent(error)));
  });
  child.stdin.on('error', error => { if (error.code !== 'EPIPE') task.on_failure(error.message); });
  child.stdin.end(invocation.input);
  task.on_trace?.('prompt_sent');
  return { session_id: state.session_id, status: 'accepted' };
}

/** Queue one immutable request for the official App-managed Sidecar. */
async function antigravity_delivery(config, binding, task) {
  const directory = resolve(config.ipc_directory);
  try {
    mkdirSync(directory, { recursive: true });
    const ready = JSON.parse(readFileSync(join(directory, 'ready.json'), 'utf8'));
    if (config.project_id || config.project_name || config.cwd) {
      const project = antigravity_project(config);
      if (ready.project_id !== project.id) throw new Error('Sidecar 所属项目与配置不符，请先运行 setup-sidecar');
    }
    try { process.kill(ready.pid, 0); } catch { throw new Error('Antigravity Sidecar 尚未运行'); }
    if (binding.session_id) bind_access(task.access_path, binding.session_id);
  } catch (error) { throw not_sent(error); }
  const path = join(directory, `${task.id}.request.json`);
  if (existsSync(path)) throw new Error('Sidecar 请求已存在；必须核对回执，不自动重复发送');
  atomic_json(path, { id: task.id, mode: task.id.startsWith('free-') ? 'free' : 'brainstorm',
    event_id: Number(task.id.replace(/^(event|free)-/, '')), prompt: task.prompt,
    session_id: binding.session_id || '', access_path: task.access_path });
  return { session_id: binding.session_id || '', status: 'sidecar_pending' };
}

/** Resolve Antigravity's real project resources without reading any conversation. */
export function antigravity_project(config, root = join(homedir(), '.gemini', 'config')) {
  if (!config.project_id && !config.project_name && !config.cwd) return { id: 'outside-of-project' };
  const directory = join(root, 'projects');
  const projects = readdirSync(directory).filter(name => name.endsWith('.json')).map(name => JSON.parse(readFileSync(join(directory, name), 'utf8')));
  const matching = projects.filter(project => (!config.project_id || project.id === config.project_id)
    && (!config.project_name || project.name === config.project_name)
    && (!config.cwd || (project.projectResources?.resources || []).some(resource => {
      const uri = resource.gitFolder?.folderUri || resource.folder?.folderUri;
      return uri?.startsWith('file:') && same_path(fileURLToPath(uri), config.cwd);
    })));
  if (matching.length !== 1) throw new Error('Antigravity 项目与 cwd 无法唯一匹配；请先在 App 添加目录并核对配置');
  return matching[0];
}

/** Explicitly install an App-managed Sidecar; preserve unrelated application settings. */
export function setup_sidecar(config, root = join(homedir(), '.gemini', 'config')) {
  const project = antigravity_project(config, root);
  const directory = resolve(config.ipc_directory);
  mkdirSync(directory, { recursive: true });
  const id = `codiscuss-${createHash('sha256').update(directory).digest('hex').slice(0, 12)}`;
  const sidecar = join(root, 'sidecars', id);
  mkdirSync(sidecar, { recursive: true });
  atomic_json(join(sidecar, 'sidecar.json'), { command: process.execPath,
    args: [fileURLToPath(new URL('./discussion_sidecar.mjs', import.meta.url))], restart_policy: 'on-failure',
    display_name: 'CoDiscuss', env: { CODISCUSS_IPC_DIRECTORY: directory } });
  const path = join(root, 'config.json');
  const current = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  // App 2.23 upgrades legacy entries by cloning their project. Use its observed current
  // schema so the explicitly selected existing project remains the actual destination.
  atomic_json(path, { ...current, sidecars: { ...current.sidecars,
    [id]: { ...current.sidecars?.[id], enabled: true, projectId: project.id, schemaVersion: 1 } } });
  return { sidecar_id: id, project_id: project.id, cwd: config.cwd || null };
}

/** Select only allowlisted adapter types from local configuration. */
export async function deliver_task(config, binding, task, spawn_process = spawn, user_home = homedir()) {
  if (config.adapter === 'api') return (await import('./api_participant.mjs')).api_delivery(config, binding, task);
  const adapters = { codex: codex_delivery, claude: claude_delivery, antigravity: antigravity_delivery,
    codex_cli: cli_delivery, antigravity_cli: cli_delivery };
  if (!adapters[config.adapter]) throw new Error('不支持的软件适配器');
  return adapters[config.adapter](config, binding, task, spawn_process, user_home);
}

/** Read a Sidecar's durable receipt without resubmitting an uncertain request. */
export function sidecar_receipt(config, id) {
  const path = join(resolve(config.ipc_directory), `${id}.result.json`);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

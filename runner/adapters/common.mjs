/** Parts every software adapter shares: running programs, ending process trees, reading session logs and model catalogs. */
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { TASK_SUBCOMMANDS } from '../expert_prompts.mjs';
import { atomic_json } from '../files.mjs';

// The room defines which website subcommands a task may run; adapters turn them into each software's permission rules.
export { TASK_SUBCOMMANDS };
export const CALL_TIMEOUT_MS = 30_000;
/** Tool names that edit files, across the softwares' event streams. */
export const EDIT_TOOLS = /^(Edit|MultiEdit|Write|NotebookEdit|write_file|write_to_file|replace_file_content|multi_replace_file_content)$/;
/** A refused operation's detail and rule are cut to this length; a run reports at most this many. */
export const DENIAL_FIELD = 300;
export const MAX_DENIALS = 20;

/** Only failures before a software invocation are safe for automatic redelivery. */
export function not_sent(error) { return Object.assign(error, { delivery_status: 'not_sent' }); }

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
export function bind_access(path, session_id) {
  const access = JSON.parse(readFileSync(path, 'utf8'));
  atomic_json(path, { ...access, session_id });
}

/** Compare local directory identities without assuming case sensitivity on Windows. */
export function same_path(left, right) {
  if (!left || !right) return false;
  const normalize = value => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
  return normalize(left) === normalize(right);
}

/** The participant's discussion project directory; workdir is the legacy field name. */
export function project_directory(config) { return config.cwd || config.workdir || ''; }

/** Keep the requested project as cwd; without a project, use the separate answer directory. */
export function launch_directory(config, task) {
  return project_directory(config) || task.draft_directory;
}

/** Read optional native settings; malformed settings must not silently disable a permission check. */
export function read_json(path) { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}; }

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
export function tree_killable(child) {
  if (typeof child.kill === 'function') {
    const plain_kill = child.kill.bind(child);
    child.kill = () => kill_process_tree(child, plain_kill);
  }
  return child;
}

/**
 * Report the phase and any progress note of each complete JSON line, as the adapter's `events` read them; malformed
 * lines are left to the caller's own parsing.
 */
export function watch_events(adapter, stream, task) {
  if (!task.on_activity && !task.on_note) return;
  createInterface({ input: stream, crlfDelay: Infinity }).on('line', line => {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    const phase = adapter.events.phase(event);
    if (phase) task.on_activity?.(phase, adapter.events.tool(event));
    const note = adapter.events.note(event);
    if (note) task.on_note?.(note);
  });
}

/** The task file name an execution's prompt carries; it marks where that execution entered a session. */
export const execution_marker = id => `free-${id}.task.json`;

/** JSON lines of a session log; lines the software wrote in another shape are skipped. */
export function log_entries(file) {
  return readFileSync(file, 'utf8').split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
}

/** The text of a prompt as the software stored it: a string, or text parts (tool results carry no prompt). */
export function prompt_text(content) {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.filter(part => ['text', 'input_text'].includes(part?.type)).map(part => part.text || '').join('\n') : '';
}

/** Whether a prompt names any of the execution markers. */
export const marked = (text, markers) => markers.some(marker => text.includes(marker));

// Only the end of a session log is read; the latest request is there and long sessions stay cheap.
const SESSION_TAIL_BYTES = 4 * 1024 * 1024;

/** The lines at the end of a file, newest first; a line cut at the start of the tail fails to parse and is skipped. */
function tail_lines(file) {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size, length = Math.min(size, SESSION_TAIL_BYTES), buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString('utf8').split('\n').reverse();
  } finally { closeSync(fd); }
}

/** Parse the newest log record that `pick` turns into settings. */
export function newest_record(file, marker, pick) {
  for (const line of tail_lines(file)) {
    if (!line.includes(marker)) continue;
    try { const found = pick(JSON.parse(line)); if (found) return found; } catch { /* A cut or foreign line says nothing. */ }
  }
  return null;
}

const QUERY_TIMEOUT_MS = 30000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
export const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]*$/;

/** Return only model identifiers, display names and supported effort values. */
export function model_entry(id, label, efforts) {
  if (typeof id !== 'string' || !MODEL_PATTERN.test(id)) return null;
  return { id, label: typeof label === 'string' && label.trim() ? label : id,
    ...(Array.isArray(efforts) ? { efforts: [...new Set(efforts.filter(item => typeof item === 'string'))] } : {}) };
}

/** Ignore non-protocol diagnostics while leaving malformed or missing catalogs visibly unavailable. */
export function json_line(line) {
  try { return JSON.parse(line); } catch { return null; }
}

/**
 * Read one catalog through the software's own CLI without an agent turn: `args` start it noninteractively and
 * `reader(send, finish)` speaks its protocol. Its temporary process is killed on every outcome; size and time are bounded.
 */
export function query_catalog(profile, args, reader, options = {}) {
  return new Promise((resolve_result, reject) => {
    const env = { ...process.env };
    delete env.CLAUDECODE;
    const child = (options.spawn || spawn)(profile.executable, args, {
      cwd: tmpdir(), env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let finished = false, bytes = 0;
    const finish = (error, models) => {
      if (finished) return;
      finished = true; clearTimeout(timer); lines.close(); child.stdin.destroy(); child.kill();
      if (error) reject(error); else resolve_result(models);
    };
    const timer = setTimeout(() => finish(new Error('读取模型列表超时，请检查软件登录和网络后重试')), options.timeout_ms ?? QUERY_TIMEOUT_MS);
    const lines = createInterface({ input: child.stdout });
    const send = value => child.stdin.write(`${JSON.stringify(value)}\n`);
    const receive = reader(send, finish);
    child.once('error', () => finish(new Error('无法启动模型查询，请检查 CLI 路径')));
    child.stdin.on('error', () => finish(new Error('模型查询连接已关闭')));
    child.stderr.on('data', () => {}); // CLI diagnostics can contain private account or configuration data.
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) finish(new Error('模型目录响应超出大小限制'));
    });
    lines.on('line', line => {
      if (finished) return;
      try { receive.line(line); } catch { finish(new Error('软件模型目录格式无法识别，请检查 CLI 版本')); }
    });
    child.once('close', code => {
      if (!finished && code === 0 && receive.complete) finish(null, receive.complete());
      else if (!finished) finish(new Error(`软件未返回模型目录（退出码 ${code ?? '未知'}），请检查版本、登录与网络`));
    });
    receive.start();
  });
}

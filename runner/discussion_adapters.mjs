/** Actual software entrypoints; never call model service APIs. */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { CodexAppClient } from './codex_app_client.mjs';

const CALL_TIMEOUT_MS = 30_000;
const CLI_DIAGNOSTIC_CHARS = 1000;
const CODEX_PERMISSIONS_MIN_MINOR = 163;
/** Website subcommands an automatic task may run; service, launch, run, api and setup stay unapproved. */
export const TASK_SUBCOMMANDS = ['room', 'message', 'turn', 'state', 'floor', 'execution', 'health', 'schema'];

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

async function claude_delivery(config, binding, task, spawn_process = spawn) {
  const session_id = binding.session_id || randomUUID();
  try { bind_access(task.access_path, session_id); }
  catch (error) { throw not_sent(error); }
  const args = ['-p', '--output-format', 'json', binding.session_id ? '--resume' : '--session-id', session_id,
    ...claude_permissions(config, task)];
  let child;
  try {
    child = spawn_process(config.executable, [...args, '--', task.prompt], {
      cwd: launch_directory(config, task), windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
      env: standalone_claude_env(),
    });
  } catch (error) { throw not_sent(error); }
  let spawned = false;
  const log_path = resolve(task.directory, `claude-${task.id}.log`);
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; task.on_output(log_path, chunk); });
  child.stderr.on('data', chunk => task.on_output(log_path, chunk));
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
export function codex_permissions(config, task) {
  const name = `codiscuss-${randomUUID()}`;
  const base = project_directory(config) && config.project_access === 'write' ? ':workspace' : ':read-only';
  const filesystem = { ':root': 'read', [resolve(task.directory).replaceAll('\\', '/')]: 'read',
    [resolve(task.draft_directory).replaceAll('\\', '/')]: 'write' };
  const rules = Object.entries(filesystem).map(([path, access]) => `${JSON.stringify(path)}=${JSON.stringify(access)}`).join(',');
  const profile = `{extends=${JSON.stringify(base)},filesystem={${rules}},network={enabled=true}}`;
  return { name, args: ['-c', `default_permissions=${JSON.stringify(name)}`, '-c', `permissions.${name}=${profile}`,
    '-c', 'approval_policy="never"'] };
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
function cli_invocation(config, binding, task) {
  if (config.adapter === 'codex_cli') {
    const permissions = codex_permissions(config, task);
    const args = ['exec', '--cd', launch_directory(config, task)];
    if (binding.session_id) args.push('resume', binding.session_id);
    args.push(...permissions.args, '--json', '--skip-git-repo-check', '-');
    return { args, input: task.prompt, permissions };
  }
  // agy's read-only project instruction is advisory; inherited user settings can still permit edits.
  const args = ['--output-format', 'stream-json', '--print-timeout', '0', '--add-dir', task.directory,
    '--add-dir', task.draft_directory, '--add-dir', task.skills_directory];
  if (project_directory(config) && config.project_access === 'write') args.push('--mode', 'accept-edits');
  if (binding.session_id) args.push('--conversation', binding.session_id);
  else if (config.project_id || config.project_name) args.push('--project', config.project_id || config.project_name);
  args.push('-p', task.prompt);
  return { args };
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
    if (event.type === 'turn.completed') state.completed = true;
    if (event.type === 'turn.failed') state.error = event.error?.message || 'Codex CLI 执行失败';
    if (event.type === 'error') state.diagnostic = event.message || 'Codex CLI 返回错误';
    return;
  }
  if (event.event === 'init') bind_cli_session(state, event.conversation_id, task);
  if (event.event === 'result') {
    const result = event.result || {};
    if (result.conversation_id) bind_cli_session(state, result.conversation_id, task);
    state.completed = result.status === 'SUCCESS';
    if (!state.completed) state.error = `Antigravity CLI ${result.status || '缺少结果状态'}：${result.error?.message || result.response || '执行未成功'}`;
  }
}

/** Distinguish process completion from successful CLI output and saved website work. */
function cli_exit_error(state, code, signal) {
  if (state.error) return state.error;
  if (code !== 0) return `CLI ${signal ? `被信号 ${signal} 终止` : `退出码 ${code}`}：${state.diagnostic}`;
  if (!state.initialized) return `CLI 未确认实际会话 ID：${state.diagnostic}`;
  if (!state.completed) return `CLI 未返回成功结束事件：${state.diagnostic}`;
  return '';
}

/** Parse complete UTF-8 JSON lines while keeping raw output in the private task log. */
function monitor_cli(child, config, binding, task) {
  const state = { session_id: binding.session_id || '', initialized: false, completed: false, error: '', diagnostic: '' };
  const log_path = resolve(task.directory, `${config.adapter}-${task.id}.log`);
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  child.stdout.on('data', chunk => task.on_output(log_path, chunk));
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => {
    state.diagnostic = (state.diagnostic + chunk).slice(-CLI_DIAGNOSTIC_CHARS).trim();
    task.on_output(log_path, chunk);
  });
  lines.on('line', line => {
    if (!line.trim()) return;
    let event;
    try { event = JSON.parse(line); }
    catch { state.diagnostic = 'CLI 输出中存在无效 JSON，详情见本机日志'; return; }
    try { cli_event(config.adapter, state, event, task); }
    catch (error) { state.error = error.message; child.kill(); }
  });
  child.once('close', (code, signal) => {
    if (!state.spawned) return;
    const error = cli_exit_error(state, code, signal);
    if (error) task.on_failure(error);
    else task.on_exit?.();
  });
  return state;
}

/** Start one headless CLI turn without opening an App or changing native permission settings. */
async function cli_delivery(config, binding, task, spawn_process) {
  if (binding.session_id) {
    try { bind_access(task.access_path, binding.session_id); }
    catch (error) { throw not_sent(error); }
  }
  const invocation = cli_invocation(config, binding, task);
  if (invocation.permissions) await check_codex_permissions(config, task, invocation.permissions, spawn_process);
  let child;
  try {
    child = spawn_process(config.executable, invocation.args, {
      cwd: launch_directory(config, task), windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) { throw not_sent(error); }
  const state = monitor_cli(child, config, binding, task);
  task.on_process(child);
  await new Promise((resolve_spawn, reject) => {
    child.once('spawn', () => { state.spawned = true; resolve_spawn(); });
    child.once('error', error => state.spawned ? task.on_failure(error.message) : reject(not_sent(error)));
  });
  child.stdin.on('error', error => { if (error.code !== 'EPIPE') task.on_failure(error.message); });
  child.stdin.end(invocation.input);
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
  atomic_json(path, { id: task.id, event_id: Number(task.id.replace('event-', '')), prompt: task.prompt, session_id: binding.session_id || '', access_path: task.access_path });
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
export async function deliver_task(config, binding, task, spawn_process = spawn) {
  const adapters = { codex: codex_delivery, claude: claude_delivery, antigravity: antigravity_delivery,
    codex_cli: cli_delivery, antigravity_cli: cli_delivery };
  if (!adapters[config.adapter]) throw new Error('不支持的软件适配器');
  return adapters[config.adapter](config, binding, task, spawn_process);
}

/** Read a Sidecar's durable receipt without resubmitting an uncertain request. */
export function sidecar_receipt(config, id) {
  const path = join(resolve(config.ipc_directory), `${id}.result.json`);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

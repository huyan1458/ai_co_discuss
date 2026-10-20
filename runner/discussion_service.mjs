/** Resident local service that keeps every registered automatic room consumed; no model API orchestration. */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { atomic_json } from './discussion_adapters.mjs';
import { DiscussionRunner, DiscussionStore, acquire_lock, api, load_config, pause_if_running, service_drafts, validate_config } from './discussion_runner.mjs';

const POLL_MS = 2000;
const START_WAIT_MS = 5000;
const STOP_WAIT_MS = 20_000;
const REGISTRY_WAIT_MS = 5000;
const SCRIPT = fileURLToPath(import.meta.url);
const REPO_ROOT = dirname(dirname(SCRIPT));
const SHORTCUT_NAME = 'AI CoDiscuss 讨论服务.lnk';
const TICK_STATES = { undefined: 'running', waiting: 'paused', false: 'idle' };
const STATUS_LABELS = { running: '运行中', paused: '已暂停', idle: '等待启动', error: '异常' };
const USAGE = '用法: discussion_service.mjs start|stop|status|open|run|list|add|remove|shortcut|autostart [--config 私有配置.json] [on|off]';
export const CONNECTION_FIELDS = ['executable', 'ipc_directory'];

/** Read one atomic configuration version for editing and worker acknowledgement. */
export function configuration_snapshot(path) {
  const content = readFileSync(path, 'utf8');
  return { config: JSON.parse(content), version: createHash('sha256').update(content).digest('hex') };
}

/** Private per-user directory holding the registry, lock, status and log. */
export function service_home() {
  if (process.env.DISCUSS_SERVICE_HOME) return resolve(process.env.DISCUSS_SERVICE_HOME);
  return join(process.env.LOCALAPPDATA || join(homedir(), '.local', 'state'), 'ai-codiscuss', 'service');
}

/** Reject an MSIX-private write view before reading shared service state or changing it. */
export function assert_shared_home(home) {
  if (process.platform !== 'win32') return;
  let directory = resolve(home);
  while (!existsSync(directory)) {
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`服务目录没有可访问的父目录：${home}`);
    directory = parent;
  }
  const probe = join(directory, `.codiscuss-path-${randomUUID()}`);
  closeSync(openSync(probe, 'wx', 0o600));
  try {
    const actual = realpathSync.native(probe);
    // Compare the container suffix so a short user-profile name (ADMINI~1) is not a redirect.
    const container = actual.match(/\\AppData\\Local\\Packages\\[^\\]+\\LocalCache\\(?:Local|Roaming)\\/i)?.[0];
    if (container && !probe.toLowerCase().includes(container.toLowerCase())) {
      throw new Error(`Windows MSIX 正在重定向服务目录 ${home}，实际写入 ${dirname(actual)}。`
        + '请从应用外的普通终端执行 codiscuss local start/stop；'
        + '或让所有入口使用同一个 AppData 之外的 DISCUSS_SERVICE_HOME。原数据不会自动迁移。');
    }
  } finally { unlinkSync(probe); }
}

/** Read the registered private room configuration paths. */
export function read_registry(home) {
  const path = join(home, 'rooms.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).configs || [] : [];
}

/** Read room identity independently of software validity, isolating unreadable configuration files. */
export function registered_identity(path) {
  try {
    const config = JSON.parse(readFileSync(path, 'utf8'));
    return { site: new URL(config.site).origin, room: config.room };
  } catch { return null; }
}

/** Serialize the entire registry read-modify-write across short-lived CLI processes. */
function update_registry(home, update) {
  mkdirSync(home, { recursive: true });
  const lock = new DatabaseSync(join(home, 'registry-lock.sqlite3'));
  try {
    lock.exec(`PRAGMA busy_timeout=${REGISTRY_WAIT_MS}; BEGIN IMMEDIATE`);
    atomic_json(join(home, 'rooms.json'), { configs: update(read_registry(home)) });
    lock.exec('COMMIT');
  } finally {
    lock.close();
  }
}

/** Register a validated room once; the same site and room may not be served twice. */
export function register_room(home, config_path) {
  const path = resolve(config_path);
  const config = load_config(path);
  update_registry(home, registered => {
    const configs = registered.filter(item => item !== path);
    for (const item of configs) {
      const other = registered_identity(item);
      if (other?.site === config.site && other.room === config.room) throw new Error(`房间 ${config.room} 已由 ${item} 登记`);
    }
    return [...configs, path];
  });
  return config;
}

/** Remove one configuration path from the registry. */
export function unregister_room(home, config_path) {
  const path = resolve(config_path);
  update_registry(home, configs => {
    if (!configs.includes(path)) throw new Error('该配置未登记');
    return configs.filter(item => item !== path);
  });
}

/** One registered room: its own data-directory lock, store and dispatcher. */
class RoomWorker {
  constructor(path, create_runner, log, home) {
    this.path = path;
    this.home = home;
    this.create_runner = create_runner;
    this.log = log;
    this.state = { config: path, status: 'starting', error: '' };
  }
  /** Open lazily so a busy lock or broken file is retried instead of stopping the service. */
  open() {
    const snapshot = configuration_snapshot(this.path);
    const config = validate_config(snapshot.config, dirname(this.path));
    config.draft_directory = service_drafts(this.home, config.directory);
    const release = acquire_lock(config.directory);
    try { this.store = new DiscussionStore(config.directory); }
    catch (error) { release(); throw error; }
    this.config = config;
    this.release = release;
    this.runner = this.create_runner(config, this.store);
    Object.assign(this.state, { site: config.site, room: config.room, config_version: snapshot.version });
  }
  /** Reload connection paths and credentials while retaining the exact conversation context. */
  async refresh_control() {
    const snapshot = configuration_snapshot(this.path);
    const updated = validate_config(snapshot.config, dirname(this.path));
    if (updated.site !== this.config.site || updated.room !== this.config.room || updated.directory !== this.config.directory) {
      throw new Error('已登记配置的房间或数据目录发生变化，请移除原登记后重新接入');
    }
    try { this.store.context(updated); }
    catch (error) {
      const room = await api(this.config, '');
      if (room.runtime.status !== 'paused' || room.runtime.mode !== 'automatic' || room.archived || room.phase === 'concluded') throw error;
      this.runner.stop_children();
      if (this.runner.children?.size) throw new Error('正在等待原 CLI 进程退出；退出后采用新的接入方式');
      this.store.context(updated, true);
    }
    this.config.token = updated.token;
    for (const [name, profile] of Object.entries(this.config.participants)) {
      for (const field of [...CONNECTION_FIELDS, 'adapter', 'session_id']) {
        if (updated.participants[name][field] === undefined) delete profile[field];
        else profile[field] = updated.participants[name][field];
      }
    }
    this.state.config_version = snapshot.version;
  }
  /** Run one bounded dispatcher iteration and keep the last result for status. */
  async tick() {
    const previous_status = this.state.status;
    try {
      if (!this.runner) this.open();
      await this.refresh_control();
      const result = await this.runner.tick();
      Object.assign(this.state, { status: TICK_STATES[result], error: '' });
    } catch (error) {
      if (error.message !== this.state.error) this.log(`${this.state.room || this.path}: ${error.message}`);
      Object.assign(this.state, { status: 'error', error: error.message });
    }
    if (this.state.status !== previous_status) {
      this.log(`${this.state.site || ''}/${this.state.room || this.path}: ${STATUS_LABELS[this.state.status]}`);
    }
    this.state.checked_at = Math.floor(Date.now() / 1000);
  }
  /** Stopping the service pauses its runs, so the website does not wait for absent consumers. */
  async close(pause) {
    if (!this.runner) return;
    if (pause) {
      try { await pause_if_running(this.config); }
      catch (error) { this.log(`${this.config.room}: 停止回执未确认；租约到期后拒绝写入：${error.message}`); }
    }
    this.runner.stop_children();
    this.store.close();
    this.release();
    this.runner = null;
  }
}

/** Keep workers aligned with the registry and tick each one per poll. */
export class DiscussionService {
  constructor(home, create_runner = (config, store) => new DiscussionRunner(config, store), log = () => {}) {
    this.home = home;
    this.create_runner = create_runner;
    this.log = log;
    this.workers = new Map();
  }
  /** Reload the registry, close removed rooms, then tick every registered room. */
  async tick() {
    const configs = read_registry(this.home);
    for (const [path, worker] of this.workers) {
      if (!configs.includes(path)) { await worker.close(true); this.workers.delete(path); }
    }
    for (const path of configs) {
      if (!this.workers.has(path)) this.workers.set(path, new RoomWorker(path, this.create_runner, this.log, this.home));
      await this.workers.get(path).tick();
    }
    atomic_json(join(this.home, 'status.json'), { pid: process.pid, updated_at: Math.floor(Date.now() / 1000),
      rooms: [...this.workers.values()].map(worker => worker.state) });
  }
  /** Pause running rooms and release every lock and child process. */
  async close() {
    for (const worker of this.workers.values()) await worker.close(true);
    this.workers.clear();
  }
}

/** Return the live service PID, or 0 when no service owns the home lock. */
export function service_pid(home) {
  const path = join(home, 'runner.lock');
  if (!existsSync(path)) return 0;
  const pid = Number(readFileSync(path, 'utf8'));
  try { process.kill(pid, 0); return pid; } catch (error) { return error.code === 'EPERM' ? pid : 0; }
}

/** Require a startup receipt from the current lock owner, not a previous process's status. */
export function service_ready(home, pid = service_pid(home)) {
  if (!pid) return false;
  try {
    const status = JSON.parse(readFileSync(join(home, 'status.json'), 'utf8'));
    return status.pid === pid && Boolean(status.updated_at) && status.ready !== false;
  } catch { return false; }
}

/** Foreground service loop; `start` runs this detached in the background. */
export async function run_service(home, output = () => {}) {
  assert_shared_home(home);
  const release = acquire_lock(home);
  const log_line = message => {
    const line = `${new Date().toISOString()} ${message}`;
    appendFileSync(join(home, 'service.log'), `${line}\n`);
    output(line);
  };
  const service = new DiscussionService(home, undefined, log_line);
  const stop_path = join(home, 'stop.request');
  if (existsSync(stop_path)) unlinkSync(stop_path);
  let stopped = false;
  const stop = () => { stopped = true; };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    log_line(`讨论服务已启动 pid=${process.pid}`);
    atomic_json(join(home, 'status.json'), { pid: process.pid, ready: true,
      updated_at: Math.floor(Date.now() / 1000), rooms: [] });
    while (!stopped && !existsSync(stop_path)) {
      try { await service.tick(); } catch (error) { log_line(`服务检查失败：${error.message}`); }
      await sleep(POLL_MS);
    }
  } finally {
    await service.close();
    if (existsSync(stop_path)) unlinkSync(stop_path);
    log_line('讨论服务已停止');
    release();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

/** Start the detached service once; an already running service is reused. */
export async function start_service(home) {
  assert_shared_home(home);
  const running = service_pid(home);
  if (service_ready(home, running)) return { running: true, ready: true, pid: running, started: false };
  mkdirSync(home, { recursive: true });
  let child, spawn_error;
  if (!running) {
    const stop_path = join(home, 'stop.request');
    if (existsSync(stop_path)) unlinkSync(stop_path);
    const log = openSync(join(home, 'service.log'), 'a');
    child = spawn(process.execPath, [SCRIPT, 'run'], { detached: true, windowsHide: true,
      stdio: ['ignore', log, log], env: { ...process.env, DISCUSS_SERVICE_HOME: home } });
    closeSync(log);
    child.once('error', error => { spawn_error = error; });
    child.unref();
  }
  for (let waited = 0; waited < START_WAIT_MS; waited += 200) {
    const pid = service_pid(home);
    if (service_ready(home, pid)) {
      if (child && pid !== child.pid && child.exitCode === null) child.kill();
      return { running: true, ready: true, pid, started: pid === child?.pid };
    }
    if (spawn_error) throw spawn_error;
    await sleep(200);
  }
  throw new Error(`讨论服务尚未确认就绪，请查看 ${join(home, 'service.log')}`);
}

/** Ask the service to pause its runs and exit, then wait for its lock to be released. */
async function stop_service(home) {
  if (!service_pid(home)) return { running: false };
  atomic_json(join(home, 'stop.request'), { requested_at: Math.floor(Date.now() / 1000) });
  for (let waited = 0; waited < STOP_WAIT_MS; waited += 500) {
    if (!service_pid(home)) return { running: false };
    await sleep(500);
  }
  throw new Error('讨论服务未在 20 秒内退出；请查看 service.log');
}

/** Report liveness with the last per-room result written by the service. */
function service_status(home) {
  const pid = service_pid(home);
  const path = join(home, 'status.json');
  const saved = pid && existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  const last = saved.pid === pid ? saved : {};
  return { running: Boolean(pid), ready: service_ready(home, pid), pid, home, configs: read_registry(home), updated_at: last.updated_at || 0, rooms: last.rooms || [] };
}

/** Open each registered site once in the default browser. */
function open_sites(home) {
  const sites = new Set();
  for (const path of read_registry(home)) {
    try { sites.add(load_config(path).site); } catch { /* status reports broken configs. */ }
  }
  for (const site of sites) {
    const [command, args] = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', site]]
      : [process.platform === 'darwin' ? 'open' : 'xdg-open', [site]];
    spawn(command, args, { detached: true, stdio: 'ignore' }).unref();
  }
  return [...sites];
}

/** Create a Windows shortcut through WScript.Shell; values pass via env to avoid quoting. */
function write_shortcut(folder, action) {
  if (process.platform !== 'win32') throw new Error('快捷方式仅支持 Windows；其他系统请直接运行 start');
  const script = "$d=[Environment]::GetFolderPath($env:SC_FOLDER); $p=Join-Path $d $env:SC_NAME;"
    + " $s=(New-Object -ComObject WScript.Shell).CreateShortcut($p); $s.TargetPath=$env:SC_TARGET;"
    + " $s.Arguments=$env:SC_ARGS; $s.WorkingDirectory=$env:SC_CWD; $s.WindowStyle=7;"
    + " $s.Description='AI CoDiscuss 讨论服务'; $s.Save(); Write-Output $p";
  return powershell(script, { SC_FOLDER: folder, SC_NAME: SHORTCUT_NAME, SC_TARGET: process.execPath,
    SC_ARGS: `"${SCRIPT}" ${action}`, SC_CWD: REPO_ROOT });
}

/** Remove the login autostart shortcut when present. */
function remove_shortcut(folder) {
  if (process.platform !== 'win32') throw new Error('开机自启仅支持 Windows');
  const script = "$p=Join-Path ([Environment]::GetFolderPath($env:SC_FOLDER)) $env:SC_NAME;"
    + " if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p }; Write-Output $p";
  return powershell(script, { SC_FOLDER: folder, SC_NAME: SHORTCUT_NAME });
}

/** Run one PowerShell snippet and return its single output line. */
function powershell(script, env) {
  const utf8 = '[Console]::OutputEncoding=[Text.Encoding]::UTF8; ';
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', utf8 + script],
    { env: { ...process.env, ...env }, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`PowerShell 执行失败：${result.stderr || result.error?.message}`);
  return result.stdout.trim();
}

/** Dispatch one service command; installing shortcuts or registering never starts a discussion. */
export async function main(args = process.argv.slice(2), print = value => process.stdout.write(JSON.stringify(value) + '\n')) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { config: { type: 'string' } } });
  const [command, option] = positionals;
  const home = service_home();
  assert_shared_home(home);
  const require_config = () => { if (!values.config) throw new Error('请用 --config 指定私有房间配置'); return values.config; };
  switch (command) {
    case 'run': return run_service(home);
    case 'start': return print(await start_service(home));
    case 'stop': return print(await stop_service(home));
    case 'status': return print(service_status(home));
    case 'open': return print({ ...(await start_service(home)), opened: open_sites(home) });
    case 'list': return print({ home, configs: read_registry(home) });
    case 'add': { const config = register_room(home, require_config()); return print({ added: config.room, site: config.site }); }
    case 'remove': unregister_room(home, require_config()); return print({ removed: resolve(values.config) });
    case 'shortcut': return print({ shortcut: write_shortcut('Desktop', 'open') });
    case 'autostart':
      if (option === 'on') return print({ autostart: write_shortcut('Startup', 'start') });
      if (option === 'off') return print({ removed: remove_shortcut('Startup') });
      throw new Error('用法: autostart on|off');
    default: throw new Error(USAGE);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}

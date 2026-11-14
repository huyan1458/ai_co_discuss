/**
 * The outside address of the hosted accounts' entry: a Cloudflare named tunnel from a host name on the owner's own
 * Cloudflare domain to the entry port on this computer.
 *
 * `codiscuss setup --hosting --public-host NAME` prepares it once (installs cloudflared, signs in to Cloudflare in the
 * browser, creates the tunnel, points the host name at it). From then on cloudflared runs as a background process of its
 * own, like the entry: it outlives the panel (an update, a forced stop), and the panel only keeps it as set
 * (`ensure_tunnel`, at start and every minute): running while the entry is meant to run, its config rewritten from the
 * current settings and the process restarted when they changed. Whether it is connected is read from cloudflared's own
 * readiness endpoint. A tunnel needs a domain on Cloudflare, so it is optional: without one the entry serves this
 * computer only.
 */
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { save_entry_settings } from '../gateway/gateway.mjs';

const TUNNEL_HOME = join(homedir(), '.cloudflared');
// Where winget puts it; a process started before the install does not see the new PATH yet.
const INSTALLED_PATHS = [join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'cloudflared', 'cloudflared.exe'),
  join(process.env.ProgramFiles || 'C:\\Program Files', 'cloudflared', 'cloudflared.exe')];
const HOST_PATTERN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const DEFAULT_TUNNEL_NAME = 'codiscuss';
const STATE_FILE = 'tunnel.json';
// The panel's setup job writes its progress here (start_tunnel_setup).
const SETUP_FILE = 'tunnel-setup.json';
const LOG_FILE = 'tunnel.log';
const READY_TIMEOUT_MS = 1500;
// The scheduled task and Run entry hosting-setup.ps1 used before the panel kept the tunnel.
const LEGACY_TASK = 'CoDiscuss Tunnel';
const LEGACY_RUN = 'CoDiscussTunnel';
// Command output goes to stderr, so `setup --json` keeps stdout for its result.
const TO_STDERR = ['inherit', 2, 2];

/** The host name as typed, checked: a plain name such as ai.example.com (no scheme or path). */
export function tunnel_host(text) {
  const host = String(text || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (!HOST_PATTERN.test(host)) throw new Error(`外网域名无效：${text}（应为 ai.example.com 这样的域名，且已托管在 Cloudflare）`);
  return host;
}

export function tunnel_name(text = DEFAULT_TUNNEL_NAME) {
  const name = String(text || DEFAULT_TUNNEL_NAME).trim();
  if (!NAME_PATTERN.test(name)) throw new Error(`隧道名无效：${text}（小写字母、数字、下划线或短横线）`);
  return name;
}

/** cloudflared's path, or '' when it is not installed. CODISCUSS_CLOUDFLARED names another program (tests). */
export function cloudflared_path() {
  if (process.env.CODISCUSS_CLOUDFLARED) return process.env.CODISCUSS_CLOUDFLARED;
  const found = spawnSync('where.exe', ['cloudflared'], { encoding: 'utf8', windowsHide: true }).stdout?.split(/\r?\n/).find(Boolean);
  return found?.trim() || INSTALLED_PATHS.find(path => existsSync(path)) || '';
}

/** Install cloudflared with winget when it is missing, and return its path. `shown` prints winget's output (a terminal). */
export function install_cloudflared(shown = true) {
  const present = cloudflared_path();
  if (present) return present;
  const winget = spawnSync('winget', ['install', '--id', 'Cloudflare.cloudflared', '-e', '--accept-source-agreements', '--accept-package-agreements'],
    { stdio: shown ? TO_STDERR : 'ignore', windowsHide: true });
  if (winget.error) throw new Error('没有 winget：请先从 Microsoft Store 安装“应用安装程序”，或自行安装 cloudflared 后再试');
  const path = cloudflared_path();
  if (!path) throw new Error(`cloudflared 没有装上（winget 退出码 ${winget.status}）`);
  return path;
}

/**
 * Sign in to Cloudflare: cloudflared opens the browser and waits until the owner authorizes. Its output is read as it
 * comes, so the link reaches `on_url` (shown in the panel, for a browser that did not open) while it waits.
 */
function login_in_browser(cloudflared, { shown, on_url }) {
  return new Promise((done, fail) => {
    const child = spawn(cloudflared, ['tunnel', 'login'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const read = chunk => {
      const text = String(chunk);
      if (shown) process.stderr.write(text);
      const url = text.match(/https:\/\/dash\.cloudflare\.com\/\S+/)?.[0];
      if (url) on_url(url);
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.on('error', fail);
    child.on('exit', code => (code === 0 ? done() : fail(new Error(`Cloudflare 授权没有完成（退出码 ${code}），重新开始即可再试`))));
  });
}

function run(cloudflared, args, shown = false) {
  const result = spawnSync(cloudflared, args, { encoding: 'utf8', windowsHide: !shown, stdio: shown ? TO_STDERR : 'pipe' });
  if (result.status !== 0) throw new Error(`cloudflared ${args.join(' ')} 失败：${String(result.stderr || '').trim().split(/\r?\n/).pop() || `退出码 ${result.status}`}`);
  return String(result.stdout || '');
}

function find_tunnel(cloudflared, name) {
  const text = run(cloudflared, ['tunnel', 'list', '--output', 'json']).trim();
  // An account without any tunnel lists `null`, not an empty list.
  return (text ? JSON.parse(text) || [] : []).find(item => item.name === name) || null;
}

/**
 * Prepare the tunnel for `host`, safe to repeat: sign in to Cloudflare in the browser the first time (`interactive`
 * false refuses instead), create the tunnel unless it exists, point the host name at it. Returns the settings it runs
 * with, kept in the entry's settings: { name, host, id, credentials }.
 *
 * Args:
 *   shown: print the programs' output (a terminal); the panel's job runs without one.
 *   progress: (step) => void, told each step as it starts; on_url: (url) => void, the Cloudflare sign-in link.
 */
export async function prepare_tunnel({ host, name = DEFAULT_TUNNEL_NAME, interactive = true, shown = true, say = () => {}, progress = () => {}, on_url = () => {} }) {
  host = tunnel_host(host); name = tunnel_name(name);
  progress('安装 cloudflared');
  const cloudflared = install_cloudflared(shown);
  if (!existsSync(join(TUNNEL_HOME, 'cert.pem'))) {
    if (!interactive) throw new Error('还没有授权 Cloudflare：在管理面板“概览”页设置外网地址，或在终端运行 codiscuss setup --hosting，在浏览器里完成授权');
    progress('等待 Cloudflare 授权');
    say(`即将打开浏览器：登录 Cloudflare，选择 ${host.split('.').slice(-2).join('.')} 并点 Authorize，完成后回到这里`);
    await login_in_browser(cloudflared, { shown, on_url });
    if (!existsSync(join(TUNNEL_HOME, 'cert.pem'))) throw new Error('Cloudflare 授权没有完成，重新开始即可再试');
  }
  progress('建立隧道');
  let tunnel = find_tunnel(cloudflared, name);
  if (!tunnel) { run(cloudflared, ['tunnel', 'create', name]); tunnel = find_tunnel(cloudflared, name); }
  if (!tunnel) throw new Error(`隧道 ${name} 建了却读不到，重新运行即可`);
  const credentials = join(TUNNEL_HOME, `${tunnel.id}.json`);
  if (!existsSync(credentials)) throw new Error(`找不到隧道凭据 ${credentials}：这条隧道可能建在别的电脑上，换一个 --tunnel-name 重新运行`);
  progress('添加域名记录');
  try { run(cloudflared, ['tunnel', 'route', 'dns', name, host]); }
  catch (error) {
    // An existing record that already points at this tunnel is fine; any other is reported by the final check.
    say(`没有新建 ${host} 的域名记录（${error.message}）；若它已指向这条隧道可忽略`);
  }
  return { name, host, id: tunnel.id, credentials };
}

/** The config file of a tunnel as the settings say it now; http2 runs over TCP 443, which proxies block less than QUIC. */
function tunnel_config(tunnel, port) {
  return [`tunnel: ${tunnel.id}`, `credentials-file: ${tunnel.credentials}`, 'protocol: http2', 'ingress:',
    `  - hostname: ${tunnel.host}`, `    service: http://127.0.0.1:${port}`, '  - service: http_status:404', ''].join('\n');
}

function config_path(data) { return join(data, 'tunnel.yml'); }

function read_state(data) {
  try { return JSON.parse(readFileSync(join(data, STATE_FILE), 'utf8')); } catch { return null; }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** A free loopback port for cloudflared's readiness endpoint. */
function free_port() {
  return new Promise((done, fail) => {
    const server = net.createServer().once('error', fail);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => done(port)); });
  });
}

/** End the tunnel process this directory runs, if any. */
export function stop_tunnel(data) {
  const state = read_state(data);
  if (state?.pid && alive(state.pid)) { try { process.kill(state.pid); } catch { /* already gone */ } }
  rmSync(join(data, STATE_FILE), { force: true });
}

/**
 * Keep the tunnel as set: with `tunnel` settings and `want` (the entry is meant to run), cloudflared runs on a config
 * written from them for the entry `port`, started (again) when it is not running or its config changed; otherwise it is
 * stopped. Returns what was done: 'started', 'restarted', 'running', 'stopped' or 'none'.
 */
export async function ensure_tunnel(data, tunnel, port, want = true) {
  if (!tunnel || !want) { const had = read_state(data); stop_tunnel(data); return had ? 'stopped' : 'none'; }
  const cloudflared = cloudflared_path();
  if (!cloudflared) throw new Error('没有找到 cloudflared，重新运行 codiscuss setup --hosting --public-host 域名');
  const config = tunnel_config(tunnel, port), path = config_path(data);
  const changed = !existsSync(path) || readFileSync(path, 'utf8') !== config;
  const state = read_state(data), running = Boolean(state?.pid && alive(state.pid));
  if (running && !changed) return 'running';
  if (running) stop_tunnel(data);
  mkdirSync(data, { recursive: true });
  writeFileSync(path, config);
  const metrics = await free_port();
  const log = openSync(join(data, LOG_FILE), 'a');
  // Detached and outside the package folder: it runs on after the panel, and never holds a folder npm replaces.
  const child = spawn(cloudflared, ['tunnel', '--config', path, '--metrics', `127.0.0.1:${metrics}`, 'run', tunnel.name],
    { cwd: data, detached: true, stdio: ['ignore', log, log], windowsHide: true });
  closeSync(log);
  child.unref();
  writeFileSync(join(data, STATE_FILE), JSON.stringify({ pid: child.pid, metrics, started_at: Date.now() }));
  return running ? 'restarted' : 'started';
}

/**
 * The tunnel as it is: { running, connected, since } — running is the process, connected is cloudflared's own answer
 * that it holds a connection to Cloudflare (its /ready endpoint).
 */
export async function tunnel_status(data) {
  const state = read_state(data);
  if (!state?.pid || !alive(state.pid)) return { running: false, connected: false, since: 0 };
  let connected = false;
  try { connected = (await fetch(`http://127.0.0.1:${state.metrics}/ready`, { signal: AbortSignal.timeout(READY_TIMEOUT_MS) })).ok; } catch { connected = false; }
  return { running: true, connected, since: state.started_at || 0 };
}

/**
 * Remove the sign-in start hosting-setup.ps1 used to register for the tunnel, and end the cloudflared it started, so
 * the panel's is the only one. Returns whether anything was removed.
 */
export function remove_legacy_tunnel_start() {
  if (process.platform !== 'win32') return false;
  const task = spawnSync('schtasks', ['/Query', '/TN', LEGACY_TASK], { windowsHide: true }).status === 0;
  if (task) {
    spawnSync('schtasks', ['/End', '/TN', LEGACY_TASK], { windowsHide: true });
    spawnSync('schtasks', ['/Delete', '/TN', LEGACY_TASK, '/F'], { windowsHide: true });
  }
  const run_key = spawnSync('reg', ['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', LEGACY_RUN, '/f'], { windowsHide: true }).status === 0;
  if (task || run_key) {
    spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='cloudflared.exe'\" | Where-Object { $_.CommandLine -like '*\\.cloudflared\\config.yml*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"],
      { windowsHide: true });
  }
  return task || run_key;
}

/** The last lines of the tunnel's log, for a failed check. */
export function tunnel_log_tail(data, lines = 3) {
  try { return readFileSync(join(data, LOG_FILE), 'utf8').trim().split(/\r?\n/).slice(-lines).join(' '); } catch { return ''; }
}

// ---- Setting the outside address from the management panel ----

/** The panel's setup job, as it last wrote: { status: 'running'|'done'|'failed', step, url, note, error, host, pid, started_at }. */
export function tunnel_setup_state(data) {
  try { return JSON.parse(readFileSync(join(data, SETUP_FILE), 'utf8')); } catch { return { status: 'none' }; }
}

/**
 * Start setting the outside address from the panel: installing cloudflared and waiting for the owner to authorize in the
 * browser can take minutes, so a job of its own does it (this file, run as `prepare`) and records each step for the page.
 */
export function start_tunnel_setup(data, host, name) {
  host = tunnel_host(host); name = tunnel_name(name);
  const current = tunnel_setup_state(data);
  if (current.status === 'running' && current.pid && alive(current.pid)) throw new Error('外网地址正在设置中，请等它完成');
  mkdirSync(data, { recursive: true });
  const log = openSync(join(data, LOG_FILE), 'a');
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'prepare', data, host, name], { cwd: data, stdio: ['ignore', log, log], windowsHide: true });
  closeSync(log);
  const state = { status: 'running', step: '准备', url: '', note: '', error: '', host, pid: child.pid, started_at: Date.now() };
  writeFileSync(join(data, SETUP_FILE), JSON.stringify(state));
  return state;
}

/** The job itself: prepare the tunnel, keep it in the entry's settings, take over from the old start, start it. */
async function prepare_job(data, host, name) {
  const path = join(data, SETUP_FILE);
  const state = { ...tunnel_setup_state(data), status: 'running', pid: process.pid };
  const save = change => writeFileSync(path, JSON.stringify(Object.assign(state, change)));
  try {
    const tunnel = await prepare_tunnel({ host, name, shown: false, progress: step => save({ step }), on_url: url => save({ url }), say: note => save({ note }) });
    save({ step: '启动隧道', url: '' });
    const settings = save_entry_settings(data, { public_url: `https://${tunnel.host}`, tunnel, mode: 'tunnel' });
    remove_legacy_tunnel_start();
    await ensure_tunnel(data, tunnel, settings.port, settings.running);
    save({ status: 'done', step: '', host: tunnel.host });
  } catch (error) { save({ status: 'failed', error: error.message }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href && process.argv[2] === 'prepare') {
  const [, , , data, host, name] = process.argv;
  prepare_job(data, host, name);
}

#!/usr/bin/env node
/**
 * The computer owner's management panel: hosted accounts, their Windows users, AI command-line sign-ins and API keys.
 *
 * A small HTTP server on 127.0.0.1 serves web/admin.html and a JSON API, and a taskbar icon opens it. Loopback is shared
 * by every user and program on this computer, including the AI programs of hosted accounts, so the API also requires a
 * session that only the owner can start: the icon (or `codiscuss panel open`) opens the page with a key kept in the
 * owner's private service directory.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { account_home, add_account, data_home, instance_home, read_accounts, remove_account, reset_password } from '../gateway/gateway.mjs';
import { API_PROVIDERS, save_api_key } from './discussion_api.mjs';
import { clear_claude_token, cli_status, codex_login_progress, create_os_user, install_shared_clis, open_agy_login, read_os_users,
  remove_os_user, set_claude_token, shared_cli_state, shared_executables, start_codex_login, start_instance_as_user } from './os_users.mjs';
import { show_tray } from './tray.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WEB = join(ROOT, 'web');
const LOCAL_SCRIPT = join(ROOT, 'runner', 'discussion_local.mjs');
const DEFAULT_PORT = 8790;
const STATE_FILE = 'admin-panel.json';
const SESSION_COOKIE = 'codiscuss_panel';
const BODY_LIMIT = 64 * 1024;
const PROBE_TIMEOUT_MS = 1500;
const STATIC_FILES = { '/': 'admin.html', '/admin.html': 'admin.html', '/admin.js': 'admin.js', '/admin.css': 'admin.css', '/mark.svg': 'mark.svg' };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png' };
const HELP = `用法：codiscuss panel [run|start|open|stop] [--port ${DEFAULT_PORT}]

  run    在前台运行管理面板与任务栏图标
  start  在后台启动（已在运行则不重复启动）
  open   打开管理面板（未运行时先启动）
  stop   停止管理面板与任务栏图标
`;

// ---- Accounts ----

/** Whether an instance answers on its port. */
function instance_running(port) {
  return new Promise(done => {
    const request = http.get({ host: '127.0.0.1', port, path: '/api/rooms', timeout: PROBE_TIMEOUT_MS }, response => { response.resume(); done(true); });
    request.on('timeout', () => { request.destroy(); done(false); });
    request.on('error', () => done(false));
  });
}

async function list_accounts(data) {
  const users = read_os_users(data);
  return Promise.all(Object.entries(read_accounts(data)).map(async ([name, account]) => ({ name, port: account.port, home: account_home(data, name),
    os_user: users[name]?.user || '', running: await instance_running(account.port), keys: list_keys(instance_home(data, name)).length })));
}

/** Point the account's command-line members at the shared copies every Windows user can run. */
function use_shared_programs(data, name) {
  const path = join(instance_home(data, name), 'launch-settings.json');
  const settings = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  const shared = shared_executables(), participants = { ...(settings.participants || {}) };
  for (const [member, profile] of Object.entries(participants)) if (shared[profile?.adapter]) participants[member] = { ...profile, executable: shared[profile.adapter] };
  const draft = `${path}.${process.pid}.tmp`;
  writeFileSync(draft, `${JSON.stringify({ ...settings, participants }, null, 2)}\n`, { mode: 0o600 });
  renameSync(draft, path);
}

/** Start or stop an account's instance: as its Windows user when it has one, otherwise as the owner. */
function run_instance(data, name, command) {
  if (!read_accounts(data)[name]) throw new Error(`账号不存在：${name}`);
  const service = instance_home(data, name);
  if (command === 'start' && read_os_users(data)[name]) return start_instance_as_user(data, name, service, LOCAL_SCRIPT);
  const child = spawn(process.execPath, [LOCAL_SCRIPT, command, '--json'], { stdio: 'ignore', windowsHide: true, env: { ...process.env, DISCUSS_SERVICE_HOME: service } });
  return new Promise((done, fail) => {
    child.on('error', fail);
    child.on('exit', code => code === 0 ? done() : fail(new Error(`实例${command === 'start' ? '启动' : '停止'}失败（退出码 ${code}）`)));
  });
}

// ---- API keys an account's instance holds ----

const KEY_FILE = /^[a-f0-9-]{36}\.json$/i;

/** The keys saved in an instance, newest first, with only the last characters of each key. */
export function list_keys(service) {
  const directory = join(service, 'api-keys');
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter(name => KEY_FILE.test(name)).map(name => {
    const path = join(directory, name);
    try {
      const saved = JSON.parse(readFileSync(path, 'utf8'));
      return { ref: name.slice(0, -5), base_url: saved.base_url, managed: saved.managed === true, tail: String(saved.api_key || '').slice(-4), time: statSync(path).mtimeMs };
    } catch { return null; }
  }).filter(Boolean).sort((left, right) => right.time - left.time);
}

function remove_key(service, ref) {
  if (!/^[a-f0-9-]{36}$/i.test(ref)) throw new Error('密钥编号无效');
  rmSync(join(service, 'api-keys', `${ref}.json`), { force: true });
}

// ---- HTTP ----

function send_json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

function read_body(request) {
  return new Promise((done, fail) => {
    let size = 0; const chunks = [];
    request.on('data', chunk => { size += chunk.length; if (size > BODY_LIMIT) { fail(new Error('请求过大')); request.destroy(); } else chunks.push(chunk); });
    request.on('end', () => { try { done(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { fail(new Error('请求不是 JSON')); } });
    request.on('error', fail);
  });
}

function cookie(request, name) {
  return String(request.headers.cookie || '').split(';').map(part => part.trim().split('=')).find(([key]) => key === name)?.[1] || '';
}

/**
 * The panel's request handler.
 *
 * Args:
 *   data: The owner's service directory.
 *   key: The secret that starts a session; only the owner can read it.
 *   port: The port this server listens on, so only requests addressed to it as a local page are accepted.
 *   ops: Injected for tests; defaults to the real account and Windows operations.
 */
export function create_panel({ data, key, port, ops = {} }) {
  const sessions = new Set(), logins = new Map();
  const op = { list_accounts, add_account, reset_password, remove_account, run_instance, create_os_user, remove_os_user, cli_status,
    set_claude_token, clear_claude_token, start_codex_login, codex_login_progress, open_agy_login, install_shared_clis, shared_cli_state,
    save_api_key, list_keys, remove_key, use_shared_programs, ...ops };
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

  async function api(method, path, body) {
    const parts = path.split('/').filter(Boolean).slice(1);
    const [section, name, action, extra] = parts;
    const account = () => { if (!read_accounts(data)[name]) throw new Error(`账号不存在：${name}`); return name; };
    if (method === 'GET' && section === 'state') {
      return { accounts: await op.list_accounts(data), clis: op.shared_cli_state(), providers: API_PROVIDERS, platform: process.platform };
    }
    if (method === 'POST' && section === 'clis' && name === 'install') return op.install_shared_clis();
    if (section !== 'accounts') throw new Error('接口不存在');
    if (method === 'POST' && !name) return op.add_account(data, String(body.name || '').trim());
    account();
    if (method === 'POST' && action === 'password') return { password: op.reset_password(data, name) };
    if (method === 'POST' && action === 'remove') { op.remove_account(data, name); return { removed: name, kept: account_home(data, name) }; }
    if (method === 'POST' && (action === 'start' || action === 'stop')) { await op.run_instance(data, name, action); return { ok: true }; }
    if (method === 'POST' && action === 'os-user' && extra === 'remove') { op.remove_os_user(data, name); return { ok: true }; }
    if (method === 'POST' && action === 'os-user') {
      const result = op.create_os_user(data, name, account_home(data, name));
      op.use_shared_programs(data, name);
      return result;
    }
    if (method === 'GET' && action === 'cli') return op.cli_status(data, name);
    if (method === 'POST' && action === 'claude' && extra === 'clear') { op.clear_claude_token(data, name); return { ok: true }; }
    if (method === 'POST' && action === 'claude') { op.set_claude_token(data, name, body.token); return { ok: true }; }
    if (method === 'POST' && action === 'codex') { const id = randomUUID(); logins.set(id, op.start_codex_login(data, name)); return { id }; }
    if (method === 'GET' && action === 'codex' && extra) {
      const job = logins.get(extra);
      if (!job) throw new Error('登录已结束，请重新开始');
      const progress = op.codex_login_progress(job);
      if (progress.done) logins.delete(extra);
      return progress;
    }
    if (method === 'POST' && action === 'agy') { op.open_agy_login(data, name); return { ok: true }; }
    const service = instance_home(data, name);
    if (method === 'GET' && action === 'keys') return op.list_keys(service);
    if (method === 'POST' && action === 'keys' && extra === 'remove') { op.remove_key(service, String(body.ref || '')); return { ok: true }; }
    if (method === 'POST' && action === 'keys') return op.save_api_key(service, { base_url: body.base_url, api_key: body.api_key, managed: true });
    throw new Error('接口不存在');
  }

  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      // Only a page this browser opened from this address; anything else (another site, a renamed host) is refused.
      if (!hosts.has(String(request.headers.host || ''))) return send_json(response, 403, { error: '只接受本机访问' });
      if (url.pathname === '/enter') {
        if (url.searchParams.get('key') !== key) return send_json(response, 403, { error: '钥匙无效，请从任务栏图标打开管理面板' });
        const session = randomBytes(24).toString('hex');
        sessions.add(session);
        const page = /^[a-z]+$/.test(url.searchParams.get('page') || '') ? `#${url.searchParams.get('page')}` : '';
        response.writeHead(302, { Location: `/${page}`, 'Set-Cookie': `${SESSION_COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/` });
        return response.end();
      }
      const signed_in = sessions.has(cookie(request, SESSION_COOKIE));
      if (url.pathname.startsWith('/api/')) {
        if (!signed_in) return send_json(response, 401, { error: '请从任务栏图标重新打开管理面板' });
        const origin = request.headers.origin;
        if (request.method !== 'GET' && (!origin || !hosts.has(origin.replace(/^http:\/\//, '')) || request.headers['x-codiscuss-panel'] !== '1')) {
          return send_json(response, 403, { error: '拒绝跨站请求' });
        }
        const body = request.method === 'POST' ? await read_body(request) : {};
        return send_json(response, 200, await api(request.method, url.pathname, body));
      }
      const name = STATIC_FILES[url.pathname] || (url.pathname.startsWith('/icons/') && /^\/icons\/[\w.-]+$/.test(url.pathname) ? url.pathname.slice(1) : '');
      if (!name) return send_json(response, 404, { error: '页面不存在' });
      if (name === 'admin.html' && !signed_in) {
        response.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
        return response.end('<!doctype html><meta charset="utf-8"><title>共议管理面板</title><p style="font:15px system-ui;padding:40px">请从任务栏的共议图标打开管理面板。</p>');
      }
      const file = join(WEB, name);
      if (!existsSync(file)) return send_json(response, 404, { error: '页面尚未构建，请运行 npm run build' });
      response.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      response.end(readFileSync(file));
    } catch (error) {
      if (response.headersSent) response.destroy();
      else send_json(response, 400, { error: error.message });
    }
  });
}

// ---- Process ----

function state_path(data) {
  return join(data, STATE_FILE);
}

function read_state(data) {
  try { return JSON.parse(readFileSync(state_path(data), 'utf8')); } catch { return null; }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Open a page in this computer's default browser. */
function open_browser(url) {
  spawn('rundll32', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

// The panel page's <title>; its own window carries it, which is how an open window is found again.
const WINDOW_TITLE = '共议 · 管理面板';
const WINDOW_SIZE = '1180,860';
const EDGE_PATHS = [join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe')];

/**
 * Show the panel in a window of its own: Edge, which every Windows 10/11 has, in app mode (no address bar or tabs, its
 * own taskbar entry), with a profile kept in the owner's service directory. A window already open is brought forward
 * instead of opening another; without Edge the default browser opens the page. `look_first` is false when the taskbar
 * icon asks: it has just looked for the window itself, and looking again here delays the new window by a second.
 */
function open_panel_window(data, url, look_first = true) {
  if (!look_first) return launch_panel_window(data, url);
  // The title goes in a script file with a byte-order mark: on a command line Windows would pass it in the ANSI code page,
  // the Chinese title would no longer match, and every call would open another window.
  const script = join(tmpdir(), `codiscuss-focus-${process.pid}.ps1`);
  writeFileSync(script, `﻿if ((New-Object -ComObject WScript.Shell).AppActivate('${WINDOW_TITLE}')) { 'focused' }`, 'utf8');
  const focused = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  rmSync(script, { force: true });
  if (focused.stdout?.trim() === 'focused') return;
  launch_panel_window(data, url);
}

function launch_panel_window(data, url) {
  const edge = EDGE_PATHS.find(path => existsSync(path));
  if (!edge) return open_browser(url);
  spawn(edge, [`--app=${url}`, `--user-data-dir=${join(data, 'panel-window')}`, `--window-size=${WINDOW_SIZE}`, '--no-first-run', '--no-default-browser-check', '--lang=zh-CN', '--disable-features=Translate,msTranslate'],
    { detached: true, stdio: 'ignore', windowsHide: false }).unref();
}

function panel_url(state) {
  return `http://127.0.0.1:${state.port}/enter?key=${state.key}`;
}

/** The owner's own site, for the icon's second entry. */
function site_url(data) {
  try { return `http://127.0.0.1:${JSON.parse(readFileSync(join(data, 'local-settings.json'), 'utf8')).port || 8765}/`; }
  catch { return 'http://127.0.0.1:8765/'; }
}

/**
 * Start or stop the owner's own local service (website and discussion service), the way `codiscuss local` does.
 *
 * The installed `codiscuss` command is preferred, so a restart keeps the version the owner installed; this source tree's
 * copy is the fallback. Hosted accounts' instances are separate processes and are left alone.
 */
function run_owner_service(data, command) {
  // npm puts the codiscuss command beside node_modules; its package's own local script is run with node, skipping cmd.exe.
  const command_file = spawnSync('where.exe', ['codiscuss.cmd'], { encoding: 'utf8', windowsHide: true }).stdout?.split(/\r?\n/).find(Boolean);
  const installed = command_file && join(dirname(command_file), 'node_modules', 'ai_co_discuss', 'runner', 'discussion_local.mjs');
  const script = installed && existsSync(installed) ? installed : LOCAL_SCRIPT;
  const child = spawn(process.execPath, [script, command], { stdio: 'ignore', windowsHide: true, env: { ...process.env, DISCUSS_SERVICE_HOME: data } });
  return new Promise((done, fail) => {
    child.on('error', fail);
    child.on('exit', code => code === 0 ? done() : fail(new Error(`codiscuss local ${command} 失败（退出码 ${code}）`)));
  });
}

/** Run the server and the icon until the icon's "close service" entry or `panel stop`. */
function run_panel(data, port) {
  const running = read_state(data);
  if (running && running.pid !== process.pid && alive(running.pid)) throw new Error(`管理面板已在运行：http://127.0.0.1:${running.port}`);
  const state = { pid: process.pid, port, key: randomBytes(24).toString('hex') };
  const server = create_panel({ data, key: state.key, port });
  server.listen(port, '127.0.0.1', () => {
    writeFileSync(state_path(data), JSON.stringify(state), { mode: 0o600 });
    process.stdout.write(`管理面板已启动：http://127.0.0.1:${port}\n`);
  });
  const rendered = join(data, 'launcher', 'codiscuss.ico');
  const tray = show_tray({ title: '共议 · 管理面板', icon_path: existsSync(rendered) ? rendered : '', window_title: WINDOW_TITLE, host: join(data, 'launcher', '共议.exe'), on_action: action => {
    if (action === 'open') open_panel_window(data, panel_url(state), false);
    if (action === 'site') open_browser(site_url(data));
    if (action === 'restart') run_owner_service(data, 'stop').then(() => run_owner_service(data, 'start')).catch(() => {});
    if (action === 'stop') run_owner_service(data, 'stop').catch(() => {}).finally(shutdown);
  } });
  function shutdown() {
    tray?.close();
    server.close();
    if (read_state(data)?.pid === process.pid) rmSync(state_path(data), { force: true });
    setTimeout(() => process.exit(0), 300);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return server;
}

/** Start the panel in the background unless it already runs; returns its state. */
async function start_panel(data, port) {
  const running = read_state(data);
  if (running && alive(running.pid)) return running;
  const log = join(data, 'admin-panel.log');
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'run', '--port', String(port)],
    { detached: true, stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true, env: { ...process.env, CODISCUSS_GATEWAY_HOME: data } });
  child.unref();
  for (let waited = 0; waited < 10_000; waited += 200) {
    await new Promise(done => setTimeout(done, 200));
    const state = read_state(data);
    if (state?.pid === child.pid) return state;
  }
  throw new Error(`管理面板没有启动，可运行 codiscuss panel run 查看原因（日志 ${log}）`);
}

export async function panel_main(args) {
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: { port: { type: 'string' }, data: { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
  const command = positionals[0] || 'open';
  if (values.help) return process.stdout.write(HELP);
  const data = data_home(values.data), port = Number(values.port || DEFAULT_PORT);
  if (command === 'run') return run_panel(data, port);
  if (command === 'start') { const state = await start_panel(data, port); return process.stdout.write(`管理面板：http://127.0.0.1:${state.port}\n`); }
  if (command === 'open') { open_panel_window(data, panel_url(await start_panel(data, port))); return; }
  if (command === 'stop') {
    const state = read_state(data);
    if (state && alive(state.pid)) process.kill(state.pid);
    rmSync(state_path(data), { force: true });
    return process.stdout.write('管理面板已停止\n');
  }
  throw new Error(HELP);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  panel_main(process.argv.slice(2)).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}

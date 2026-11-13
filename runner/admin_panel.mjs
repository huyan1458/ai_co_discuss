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
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { account_home, add_account, data_home, instance_home, read_accounts, remove_account, reset_password } from '../gateway/gateway.mjs';
import { API_PROVIDERS, save_api_key } from './discussion_api.mjs';
import { apply_login, cancel_login, LOGIN_METHODS, login_progress, login_status, logout, start_login, submit_login } from './cli_login.mjs';
import { create_os_user, install_shared_runtime, read_os_users, remove_os_user, run_as_user, shared_cli_state, shared_executables, shared_paths, start_instance_as_user } from './os_users.mjs';
import { install_workflows, shipped_workflows } from './discussion_skills.mjs';
import { hosted_prompt, import_skill, library_root, list_library, remove_library_skill, save_hosted_prompt } from './skill_library.mjs';
import { local_status } from './discussion_local.mjs';
import { autostart_enabled, launcher_path, set_autostart } from './launcher.mjs';
import { show_tray } from './tray.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WEB = join(ROOT, 'web');
const LOCAL_SCRIPT = join(ROOT, 'runner', 'discussion_local.mjs');
const DEFAULT_PORT = 8790;
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const NPM_PACKAGE = 'ai_co_discuss';
const LATEST_URL = `https://registry.npmjs.org/${NPM_PACKAGE}/latest`;
const LATEST_TTL_MS = 60 * 60 * 1000;
const LATEST_TIMEOUT_MS = 8000;
const STATE_FILE = 'admin-panel.json';
// Where account_env.mjs (and setup) record the skills they installed, in the service home.
const SKILL_RECORD = 'skills-manifest.json';
// How a panel started by an update receives its predecessor's key and sessions (only that child process sees it).
const HANDOVER_VARIABLE = 'CODISCUSS_PANEL_HANDOVER';
const SESSION_COOKIE = 'codiscuss_panel';
const BODY_LIMIT = 64 * 1024;
const UPLOAD_LIMIT = 40 * 1024 * 1024;
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

// ---- This computer's service ----

/** The owner's own service as the overview shows it: whether it runs, where, and which version. */
function service_overview(data) {
  const status = local_status(data);
  return { running: Boolean(status.running), website: Boolean(status.website_running), url: status.url || '', version: status.version || '',
    home: data, error: status.service_error || '' };
}

let latest = { at: 0, version: '' };

/** The newest published version, asked of the npm registry at most once an hour (nothing about this computer is sent). */
async function latest_version(force = false) {
  if (!force && latest.version && Date.now() - latest.at < LATEST_TTL_MS) return latest.version;
  const response = await fetch(LATEST_URL, { signal: AbortSignal.timeout(LATEST_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`查询新版本失败（HTTP ${response.status}）`);
  latest = { at: Date.now(), version: String((await response.json()).version || '') };
  return latest.version;
}

/** Whether version a is newer than b (plain x.y.z). */
export function newer_version(a, b) {
  const left = String(a).split('.').map(Number), right = String(b).split('.').map(Number);
  for (let index = 0; index < 3; index += 1) if ((left[index] || 0) !== (right[index] || 0)) return (left[index] || 0) > (right[index] || 0);
  return false;
}

/** Run a command to its end, failing with the last of its output. */
function run_command(command, args) {
  return new Promise((done, fail) => {
    // npm is a .cmd on Windows, which only a shell runs.
    const child = spawn(command, args, { shell: process.platform === 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output = (output + chunk).slice(-4000); });
    child.stderr.on('data', chunk => { output = (output + chunk).slice(-4000); });
    child.on('error', fail);
    child.on('exit', code => code === 0 ? done() : fail(Object.assign(new Error(`${command} ${args.join(' ')} 失败（退出码 ${code}）：${output.trim().split(/\r?\n/).slice(-3).join(' ')}`), { code })));
  });
}

/**
 * Install a published version and bring everything on this computer onto it, reporting each step: the owner's skills
 * (setup without questions), the owner's service, and with hosting on, the shared copy and every account with its own
 * Windows user (skills, missing workflows, a running instance restarted). A step that fails is reported and the rest go
 * on. The panel itself still runs the old code afterwards; `on_updated` restarts it.
 */
async function update_package(data, version, on_updated) {
  await run_command('npm', ['install', '--global', `${NPM_PACKAGE}@${version}`]);
  const steps = [`已安装 v${version}`];
  const step = async (done, work) => { try { await work(); steps.push(done); } catch (error) { steps.push(`${done.replace(/^已/, '')}失败：${error.message}`); } };
  await step('已更新本机技能', () => run_command(process.execPath, [installed_script('codiscuss.mjs'), 'setup', '--yes', '--no-start', '--json']).catch(error => {
    // Setup exits 2 when it finished with items to look at (an edited skill is kept, for one); that still counts.
    if (error.code !== 2) throw error;
  }));
  await step('已重启本机服务', async () => { await run_owner_service(data, 'stop'); await run_owner_service(data, 'start'); });
  if (hosting_enabled(data)) {
    await step('已更新共享运行环境', () => { const result = install_runtime(data); if (result.warnings.length) throw new Error(result.warnings.join('；')); });
    for (const account of await list_accounts(data)) {
      if (!account.os_user) continue;
      await step(`已更新 ${account.name} 的技能`, () => prepare_account(data, account.name));
      if (account.running) await step(`已重启 ${account.name} 的实例`, async () => { await run_instance(data, account.name, 'stop'); await run_instance(data, account.name, 'start'); });
    }
  }
  setTimeout(on_updated, 500);
  return { version, steps };
}

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
    os_user: users[name]?.user || '', running: await instance_running(account.port), keys: list_keys(instance_home(data, name)).length,
    // The AI environment is set up once account_env.mjs has run for its Windows user (it records skills in the service home).
    skills: Boolean(users[name]) && existsSync(join(instance_home(data, name), SKILL_RECORD)) })));
}

function write_settings(path, value) {
  const draft = `${path}.${process.pid}.tmp`;
  writeFileSync(draft, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(draft, path);
}

/** Point the account's command-line members and its website's Python at the shared copies every Windows user can run. */
function use_shared_programs(data, name) {
  const service = instance_home(data, name), path = join(service, 'launch-settings.json');
  const settings = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  const shared = shared_executables(), participants = { ...(settings.participants || {}) };
  for (const [member, profile] of Object.entries(participants)) if (shared[profile?.adapter]) participants[member] = { ...profile, executable: shared[profile.adapter] };
  write_settings(path, { ...settings, participants });
  const local = join(service, 'local-settings.json'), python = shared_paths().python;
  if (existsSync(local) && existsSync(python)) write_settings(local, { ...JSON.parse(readFileSync(local, 'utf8')), python });
}

/** The Python the owner's own website runs, which the shared copy is made from. */
function owner_python(data) {
  try { return JSON.parse(readFileSync(join(data, 'local-settings.json'), 'utf8')).python || ''; } catch { return ''; }
}

/** Copy the shared programs, then point every account with its own Windows user at them. */
function install_runtime(data) {
  const result = install_shared_runtime(owner_python(data));
  for (const name of Object.keys(read_os_users(data))) if (read_accounts(data)[name]) use_shared_programs(data, name);
  return result;
}

/**
 * Run account_env.mjs as the account's own Windows user, from the shared copy, and return its JSON answer.
 * `folders` are folders of the owner's copied into the job folder for it (library skills).
 */
function account_env(data, name, action, request = {}, folders = {}) {
  const { env_script } = shared_paths();
  if (!existsSync(env_script)) throw new Error('还没有安装共享运行环境，请先在“托管账号”页安装');
  const text = run_as_user(data, name, `& ${ps_quote(process.execPath)} ${ps_quote(env_script)} ${action} $Job`,
    { files: { 'request.json': JSON.stringify(request) }, folders, timeout: 120_000 });
  const line = text.split(/\r?\n/).reverse().find(item => item.trim().startsWith('{'));
  const result = line ? JSON.parse(line) : { error: text.trim().slice(0, 300) || '没有读到结果' };
  if (result.error) throw new Error(result.error);
  return result;
}

/**
 * Set up an account's AI environment, safe to repeat: for an account with its own Windows user, the shared skills folder
 * and system prompt laid out like the owner's, the discussion skills, and the shipped workflows its instance lacks (an
 * existing prompt and workflows are kept). One without its own user uses the owner's, so only its workflows are filled in.
 */
function prepare_account(data, name) {
  const service = instance_home(data, name);
  if (!read_os_users(data)[name]) {
    const missing = shipped_workflows().map(item => item.name).filter(item => !existsSync(join(service, 'workflows', item)));
    return { skills: [], workflows: (missing.length ? install_workflows(service, missing) : []).map(({ name: item, status }) => ({ name: item, status })) };
  }
  return account_env(data, name, 'init', { home: service, prompt: hosted_prompt(data) });
}

/** Install library skills for an account's own Windows user and remove others: { install: [name], remove: [name] }. */
function account_skills(data, name, { install = [], remove = [] } = {}) {
  const library = library_root(data), folders = {};
  for (const skill of install) {
    if (!existsSync(join(library, String(skill), 'SKILL.md'))) throw new Error(`技能库里没有 ${skill}`);
    folders[join('skills', String(skill))] = join(library, String(skill));
  }
  return account_env(data, name, 'skills', { remove }, folders);
}

const ps_quote = text => `'${String(text).replaceAll("'", "''")}'`;

/** Start or stop an account's instance: as its Windows user from the shared copy when it has one, otherwise as the owner. */
function run_instance(data, name, command) {
  if (!read_accounts(data)[name]) throw new Error(`账号不存在：${name}`);
  const service = instance_home(data, name);
  if (command === 'start' && read_os_users(data)[name]) {
    const { local_script } = shared_paths();
    if (!existsSync(local_script)) throw new Error('还没有安装共享运行环境，请先在“托管账号”页安装');
    // Whatever was set up first, the instance starts on the shared copies its Windows user can run.
    use_shared_programs(data, name);
    return start_instance_as_user(data, name, service, local_script);
  }
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

function read_body(request, limit = BODY_LIMIT) {
  return new Promise((done, fail) => {
    let size = 0; const chunks = [];
    request.on('data', chunk => { size += chunk.length; if (size > limit) { fail(new Error(limit > BODY_LIMIT ? '技能太大（上限 40 MB）' : '请求过大')); request.destroy(); } else chunks.push(chunk); });
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
export function create_panel({ data, key, port, ops = {}, sessions = new Set() }) {
  const op = { list_accounts, add_account, reset_password, remove_account, run_instance, create_os_user, remove_os_user,
    login_status, apply_login, logout, start_login, login_progress, submit_login, cancel_login, install_runtime, prepare_account, account_env, account_skills, shared_cli_state,
    save_api_key, list_keys, remove_key, use_shared_programs, service_overview, run_owner_service, latest_version, update_package,
    autostart_enabled, set_autostart, on_updated: () => {}, ...ops };
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

  async function api(method, path, body) {
    const parts = path.split('/').filter(Boolean).slice(1);
    const [section, name, action, extra] = parts;
    const account = () => { if (!read_accounts(data)[name]) throw new Error(`账号不存在：${name}`); return name; };
    const hosting = hosting_enabled(data);
    if (method === 'GET' && section === 'state') {
      const windows = process.platform === 'win32';
      return { hosting, version: VERSION, service: op.service_overview(data), platform: process.platform,
        launcher: windows && existsSync(launcher_path(data)), autostart: windows && op.autostart_enabled(), login_methods: LOGIN_METHODS,
        ...(hosting ? { accounts: await op.list_accounts(data), clis: op.shared_cli_state(), providers: API_PROVIDERS } : { accounts: [], clis: {}, providers: {} }) };
    }
    // This computer: the owner's own service, its updates and login autostart.
    if (method === 'POST' && section === 'service' && ['start', 'stop', 'restart'].includes(name)) {
      if (name !== 'start') await op.run_owner_service(data, 'stop');
      if (name !== 'stop') await op.run_owner_service(data, 'start');
      return op.service_overview(data);
    }
    if (method === 'GET' && section === 'update') {
      const current = op.service_overview(data).version || VERSION, version = await op.latest_version(name === 'check');
      return { current, latest: version, available: newer_version(version, current) };
    }
    if (method === 'POST' && section === 'update') return op.update_package(data, await op.latest_version(true), op.on_updated);
    if (method === 'POST' && section === 'autostart') return { autostart: op.set_autostart(Boolean(body.on), data) };
    // Command-line sign-in: '_' is the owner; an account name is a hosted account with its own Windows user.
    if (section === 'login-jobs') {
      if (method === 'GET') return op.login_progress(name);
      if (method === 'POST' && action === 'submit') return op.submit_login(name, body.text);
      if (method === 'POST' && action === 'cancel') return op.cancel_login(name);
    }
    if (section === 'logins') {
      const target = name === '_' ? '' : name;
      if (target && (!hosting || !read_accounts(data)[target])) throw new Error(target && !hosting ? '托管管理未打开' : `账号不存在：${target}`);
      if (method === 'GET' && !action) return op.login_status(data, target);
      if (method === 'POST' && extra === 'apply') return op.apply_login(data, target, action, body);
      if (method === 'POST' && extra === 'logout') return op.logout(data, target, action);
      if (method === 'POST' && extra === 'start') return op.start_login(data, target, action, body.method);
      throw new Error('接口不存在');
    }
    // Hosting: only once the owner turned it on in setup.
    if (!hosting) throw new Error('托管管理未打开：运行 codiscuss setup 勾选“托管管理（管理面板）”');
    if (method === 'POST' && section === 'clis' && name === 'install') return op.install_runtime(data);
    // The skill library and the default system prompt, both the owner's, for hosted accounts.
    if (section === 'skill-library') {
      if (method === 'GET') return list_library(data);
      if (method === 'POST' && !name) return import_skill(data, body);
      if (method === 'POST' && action === 'remove') { remove_library_skill(data, name); return { ok: true }; }
    }
    if (section === 'hosted-prompt') {
      if (method === 'GET') return { text: hosted_prompt(data) };
      if (method === 'POST') { save_hosted_prompt(data, body.text); return { ok: true }; }
    }
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
    // Its AI environment: set up (safe to repeat), what is installed, chosen library skills, its system prompt.
    if (method === 'POST' && action === 'env' && extra === 'init') return op.prepare_account(data, name);
    if (method === 'GET' && action === 'env') return op.account_env(data, name, 'status');
    if (method === 'POST' && action === 'env' && extra === 'skills') return op.account_skills(data, name, { install: body.install || [], remove: body.remove || [] });
    if (method === 'POST' && action === 'env' && extra === 'prompt') return op.account_env(data, name, 'prompt', { prompt: String(body.text ?? '') });
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
        // A dropped skill arrives whole (its files in base64), so that one request may be large.
        const body = request.method === 'POST' ? await read_body(request, url.pathname === '/api/skill-library' ? UPLOAD_LIMIT : BODY_LIMIT) : {};
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

/** A runner script of the installed codiscuss package (npm puts its command beside node_modules), or this tree's copy. */
function installed_script(name) {
  const command_file = spawnSync('where.exe', ['codiscuss.cmd'], { encoding: 'utf8', windowsHide: true }).stdout?.split(/\r?\n/).find(Boolean);
  const installed = command_file && join(dirname(command_file), 'node_modules', NPM_PACKAGE, 'runner', name);
  return installed && existsSync(installed) ? installed : join(ROOT, 'runner', name);
}

/**
 * Start or stop the owner's own local service (website and discussion service), the way `codiscuss local` does.
 *
 * The installed package's script is preferred, so a restart keeps the version the owner installed. Hosted accounts'
 * instances are separate processes and are left alone.
 */
function run_owner_service(data, command) {
  const child = spawn(process.execPath, [installed_script('discussion_local.mjs'), command], { stdio: 'ignore', windowsHide: true, env: { ...process.env, DISCUSS_SERVICE_HOME: data } });
  return new Promise((done, fail) => {
    child.on('error', fail);
    child.on('exit', code => code === 0 ? done() : fail(new Error(`codiscuss local ${command} 失败（退出码 ${code}）`)));
  });
}

/** Whether the owner turned on hosting (setup's "托管管理"); only then does the panel show the hosting pages. */
export function hosting_enabled(data) {
  try { return JSON.parse(readFileSync(join(data, 'local-settings.json'), 'utf8')).hosting === true; } catch { return false; }
}

/** Run the server and the icon until the icon's "close service" entry or `panel stop`. */
function run_panel(data, port) {
  const running = read_state(data);
  if (running && running.pid !== process.pid && alive(running.pid)) throw new Error(`管理面板已在运行：http://127.0.0.1:${running.port}`);
  // A panel started by an update takes over its predecessor's key and sessions, so the open window keeps working.
  let handover = {};
  try { handover = JSON.parse(process.env[HANDOVER_VARIABLE] || '{}'); } catch { handover = {}; }
  delete process.env[HANDOVER_VARIABLE];
  const state = { pid: process.pid, port, key: handover.key || randomBytes(24).toString('hex'), version: VERSION };
  const sessions = new Set(Array.isArray(handover.sessions) ? handover.sessions : []);
  // After an update this process still runs the old code: it steps aside and starts the newly installed panel.
  const on_updated = () => {
    shutdown(false);
    spawn(process.execPath, [installed_script('admin_panel.mjs'), 'start', '--data', data, '--port', String(port)], { detached: true, stdio: 'ignore', windowsHide: true,
      env: { ...process.env, [HANDOVER_VARIABLE]: JSON.stringify({ key: state.key, sessions: [...sessions] }) } }).unref();
    setTimeout(() => process.exit(0), 300);
  };
  const server = create_panel({ data, key: state.key, port, ops: { on_updated }, sessions });
  server.listen(port, '127.0.0.1', () => {
    writeFileSync(state_path(data), JSON.stringify(state), { mode: 0o600 });
    process.stdout.write(`管理面板已启动：http://127.0.0.1:${port}\n`);
  });
  const rendered = join(data, 'launcher', 'codiscuss.ico');
  const tray = show_tray({ title: '共议', icon_path: existsSync(rendered) ? rendered : '', window_title: WINDOW_TITLE,
    host: join(data, 'launcher', '共议.exe'), on_action: action => {
    if (action === 'open') open_panel_window(data, panel_url(state), false);
    if (action === 'site') open_browser(site_url(data));
    // Restarting and closing take seconds and show nothing of their own, so the icon says what is happening.
    if (action === 'restart') {
      tray.notify('busy', '正在重启共议服务…');
      run_owner_service(data, 'stop').then(() => run_owner_service(data, 'start'))
        .then(() => tray.notify('done', '共议服务已重启'), error => tray.notify('error', `重启失败：${error.message}。可在命令行运行 codiscuss local open`));
    }
    if (action === 'stop') {
      tray.notify('busy', '正在关闭共议服务…');
      run_owner_service(data, 'stop')
        .then(() => tray.notify('done', '共议服务已关闭'), error => tray.notify('error', `关闭失败：${error.message}`))
        // The note goes with the icon, so it stays a moment before the icon closes.
        .finally(() => setTimeout(shutdown, 2500));
    }
  } });
  function shutdown(exit = true) {
    tray?.close();
    server.close();
    if (read_state(data)?.pid === process.pid) rmSync(state_path(data), { force: true });
    if (exit) setTimeout(() => process.exit(0), 300);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return server;
}

/** Start the panel in the background unless it already runs; returns its state. */
async function start_panel(data, port) {
  const running = read_state(data);
  if (running && alive(running.pid) && running.version === VERSION) return running;
  // A panel of another version (left running across an update) is replaced, so the icon and panel match what is installed.
  if (running && alive(running.pid)) {
    process.kill(running.pid);
    rmSync(state_path(data), { force: true });
    await new Promise(done => setTimeout(done, 800));
  }
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
  if (command === 'open') {
    const state = await start_panel(data, port);
    // An icon from 0.4.28 or 0.4.29 may run without a panel; it is replaced by one that has it.
    if (!state.port) throw new Error('正在运行的任务栏图标来自旧版本：运行 codiscuss panel stop 后再运行 codiscuss panel open');
    open_panel_window(data, panel_url(state));
    return;
  }
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

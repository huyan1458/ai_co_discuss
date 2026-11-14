#!/usr/bin/env node
/**
 * Account entry for hosted instances.
 *
 * Each account owns one instance: a loopback-only local website with its own service directory and port. The entry signs
 * a person in and forwards every request to that account's instance as a same-origin loopback request, which the instance
 * treats as its own local page. The instance therefore trusts whatever reaches it from this computer; the entry is the only
 * thing between the network and it.
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { ENTRY_KEY_PATTERN, verified_connection } from '../runner/entry_client.mjs';

const SESSION_COOKIE = 'codiscuss_entry';
const SESSION_SECONDS = 30 * 24 * 3600;
const LOGIN_PATH = '/_entry/login';
const LOGOUT_PATH = '/_entry/logout';
const SESSION_PATH = '/_entry/session';
const LOGIN_BODY_LIMIT = 4096;
const FIRST_INSTANCE_PORT = 18801;
const DEFAULT_ENTRY_PORT = 8780;
const MAX_FAILURES = 5;
const LOCK_MS = 10 * 60 * 1000;
const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{1,31}$/;
const ACCOUNTS_FILE = 'gateway-accounts.json';
// Signed-in sessions, kept so restarting the entry signs no one out; only token hashes are stored.
const SESSIONS_FILE = 'gateway-sessions.json';
// Each protected account's instance key; the administrator's copy, the only one the entry reads.
const INSTANCE_KEYS_FILE = 'gateway-instance-keys.json';
// The entry's port and public address, set in the panel; the running entry's control key; its output.
const ENTRY_SETTINGS_FILE = 'gateway-settings.json';
const ENTRY_KEY_FILE = 'gateway-control.json';
const ENTRY_LOG_FILE = 'gateway.log';
const ENTRY_START_MS = 8000;
const CONTROL_TIMEOUT_MS = 2000;
const CONTROL_LIMIT = 512;
const CONTROL_KEY_PATTERN = /^[a-f0-9]{64}$/;
const CONTROL_COMMANDS = new Set(['status', 'stop']);
// Not account names: the administrator is never an entry account, and its draft space is the folder ~/.codiscuss-workspace.
const RESERVED_NAMES = new Set(['admin', 'workspace']);
// What a new instance takes from the administrator's saved software settings: where each program is, nothing else.
const SOFTWARE_FIELDS = ['adapter', 'executable', 'ipc_directory'];
const LOCAL_SCRIPT = join(dirname(dirname(fileURLToPath(import.meta.url))), 'runner', 'discussion_local.mjs');
const HELP = `用法：
  node gateway/gateway.mjs serve [--host 127.0.0.1] [--port ${DEFAULT_ENTRY_PORT}] [--data 管理员目录]
  node gateway/gateway.mjs add 账号 [--port 实例端口] [--data 管理员目录]    新建账号与实例目录，输出一次性显示的密码
  node gateway/gateway.mjs passwd 账号 [--data 管理员目录]                  重设密码
  node gateway/gateway.mjs remove 账号 [--data 管理员目录]                  删除账号（保留实例目录）
  node gateway/gateway.mjs disable|enable 账号 [--data 管理员目录]          停用或启用账号：停用立即让它的登录失效，数据保留
  node gateway/gateway.mjs list [--data 管理员目录]
  node gateway/gateway.mjs start|stop 账号 [--data 管理员目录]              启动或停止这个账号的实例
`;

/**
 * The administrator's service directory, which also holds the account list.
 *
 * The administrator is the computer's owner and keeps the default instance here. That instance is never reachable through
 * the entry: it is used at the computer itself or from a paired device.
 */
export function data_home(option) {
  return resolve(option || process.env.CODISCUSS_GATEWAY_HOME || join(homedir(), '.codiscuss'));
}

/** One account's folder: a sibling of the administrator's service directory, named after the account. */
export function account_home(data, name) {
  return `${data}-${name}`;
}

/** The service directory of one account's instance; its projects and draft space sit beside it, never inside. */
export function instance_home(data, name) {
  return join(account_home(data, name), 'service');
}

function read_json(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
}

/** Give a new instance its port, its folders, and the administrator's Python and program locations. */
function prepare_instance(data, name, port) {
  const home = account_home(data, name), service = instance_home(data, name);
  const folders = { workspace: join(home, 'workspace'), projects_root: join(home, 'projects') };
  for (const folder of Object.values(folders)) mkdirSync(folder, { recursive: true });
  const python = read_json(join(data, 'local-settings.json')).python;
  write_json(join(service, 'local-settings.json'), { port, ...(python ? { python } : {}), ...folders });
  const participants = Object.entries(read_json(join(data, 'launch-settings.json')).participants || {}).map(([member, profile]) =>
    [member, Object.fromEntries(SOFTWARE_FIELDS.filter(field => profile?.[field]).map(field => [field, profile[field]]))]);
  if (participants.length) write_json(join(service, 'launch-settings.json'), { participants: Object.fromEntries(participants) });
}

function accounts_path(data) {
  return join(data, ACCOUNTS_FILE);
}

export function read_accounts(data) {
  const path = accounts_path(data);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
}

function write_json(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const draft = `${path}.${process.pid}.tmp`;
  writeFileSync(draft, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(draft, path);
}

function password_hash(password, salt) {
  return scryptSync(password, Buffer.from(salt, 'hex'), 32);
}

function new_credentials() {
  const password = randomBytes(9).toString('base64url');
  const salt = randomBytes(16).toString('hex');
  return { password, salt, hash: password_hash(password, salt).toString('hex') };
}

/**
 * Create an account with its folder: the instance's service directory, a projects folder and a draft space.
 *
 * Returns:
 *   { name, port, password }; the password is shown once and only its hash is stored.
 */
export function add_account(data, name, port) {
  if (!NAME_PATTERN.test(name || '')) throw new Error('账号须为 2–32 位小写字母、数字、下划线或短横线，且以字母或数字开头');
  if (RESERVED_NAMES.has(name)) throw new Error(`“${name}”不能作为入口账号：管理员使用这台电脑的默认实例，只能在本机或已配对的设备上访问`);
  const accounts = read_accounts(data);
  if (accounts[name]) throw new Error(`账号已存在：${name}`);
  if (existsSync(account_home(data, name))) throw new Error(`目录已存在，请换一个账号名：${account_home(data, name)}`);
  const used = Object.values(accounts).map(account => account.port);
  const chosen = port === undefined ? Math.max(FIRST_INSTANCE_PORT - 1, ...used) + 1 : Number(port);
  if (!Number.isInteger(chosen) || chosen < 1024 || chosen > 65535) throw new Error('实例端口须为 1024–65535 的整数');
  if (used.includes(chosen)) throw new Error(`端口 ${chosen} 已分配给其他账号`);
  const { password, salt, hash } = new_credentials();
  prepare_instance(data, name, chosen);
  write_json(accounts_path(data), { ...accounts, [name]: { salt, hash, port: chosen } });
  return { name, port: chosen, password };
}

/** Replace an account's password and return the new one. */
export function reset_password(data, name) {
  const accounts = read_accounts(data);
  if (!accounts[name]) throw new Error(`账号不存在：${name}`);
  const { password, salt, hash } = new_credentials();
  write_json(accounts_path(data), { ...accounts, [name]: { ...accounts[name], salt, hash, session_version: session_version(accounts[name]) + 1 } });
  return password;
}

/**
 * Stop or allow an account's sign-in. A disabled account's sessions end at once and it cannot sign in; its instance and data
 * stay as they are, so enabling it again restores access.
 */
export function set_account_disabled(data, name, disabled) {
  const accounts = read_accounts(data);
  if (!accounts[name]) throw new Error(`账号不存在：${name}`);
  const { disabled: _previous, ...account } = accounts[name];
  // Disabling moves the session version on, so enabling again never brings back a session signed in before.
  write_json(accounts_path(data), { ...accounts, [name]: disabled ? { ...account, disabled: true, session_version: session_version(account) + 1 } : account });
}

/**
 * Turn an account's entry protection on with `key` (kept here, in the administrator's directory, as the only copy the
 * entry reads) or off. Placing the instance's own copy where the instance can read it is the caller's part.
 */
export function set_account_protected(data, name, key = '') {
  const accounts = read_accounts(data);
  if (!accounts[name]) throw new Error(`账号不存在：${name}`);
  if (key && !ENTRY_KEY_PATTERN.test(key)) throw new Error('实例密钥格式不对');
  const keys = read_json(join(data, INSTANCE_KEYS_FILE));
  const { protected: _previous, ...account } = accounts[name];
  if (key) write_json(join(data, INSTANCE_KEYS_FILE), { ...keys, [name]: key });
  write_json(accounts_path(data), { ...accounts, [name]: key ? { ...account, protected: true } : account });
}

/** The account's session version: a session made under an older one no longer grants access. */
function session_version(account) {
  return Number.isInteger(account?.session_version) ? account.session_version : 0;
}

/**
 * Take this computer's entry for one administrator directory. Two entries on the same account list would each keep their
 * own copy of the sessions and overwrite the other's sign-outs, so a second one refuses to start.
 *
 * The claim is a listening local socket named after the directory: the operating system lets only one process listen on
 * a name and frees it when that process exits, so neither a crash nor a reused process id can leave a stale claim. Windows
 * uses a named pipe and Linux an abstract socket; elsewhere the socket is a file, and a leftover one is reported rather than
 * removed, since removing it safely would need the same exclusion it provides.
 *
 * Returns:
 *   The listening claim; it lasts while the process runs, and `close()` gives it up.
 */
export function claim_entry(data, on_command = null) {
  const path = claim_path(data);
  const claim = net.createServer(socket => on_command ? answer_control(socket, on_command) : socket.destroy());
  return new Promise((done, fail) => {
    claim.once('error', error => fail(error.code === 'EADDRINUSE'
      ? new Error(process.platform === 'win32' || process.platform === 'linux' ? '这个管理员目录的入口已在运行'
        : `这个管理员目录的入口已在运行；若确认没有在运行，删除 ${path} 后再启动`) : error));
    claim.listen(path, () => done(claim));
  });
}

/** The claim's socket name for one directory, named after the directory itself so a junction or link is the same claim. */
export function claim_path(data) {
  mkdirSync(data, { recursive: true });
  const real = realpathSync.native(data);
  const name = createHash('sha256').update(process.platform === 'win32' ? real.toLowerCase() : real).digest('hex').slice(0, 24);
  return process.platform === 'win32' ? `\\\\.\\pipe\\codiscuss-gateway-${name}`
    : process.platform === 'linux' ? `\0codiscuss-gateway-${name}` : join(data, 'gateway.sock');
}

/**
 * Answer one control request on the claim: a JSON line `{ key, command }`. `on_command` returns `{ reply, then }` for a
 * request it accepts, or null, which closes the connection unanswered; `then` runs once the reply is sent.
 */
function answer_control(socket, on_command) {
  let text = '', handled = false;
  socket.setEncoding('utf8');
  socket.setTimeout(CONTROL_TIMEOUT_MS, () => socket.destroy());
  socket.on('error', () => {});
  socket.on('data', chunk => {
    if (handled) return;
    text += chunk;
    const end = text.indexOf('\n');
    if (end < 0) { if (text.length > CONTROL_LIMIT) socket.destroy(); return; }
    handled = true;
    // Whatever arrives here is untrusted: only a well-formed request reaches on_command, and nothing it sends can throw
    // out of this callback, which would end the whole entry.
    let answer = null;
    try {
      const request = control_request(text.slice(0, end));
      answer = request && on_command(request);
    } catch { answer = null; }
    if (!answer) return socket.destroy();
    socket.end(`${JSON.stringify(answer.reply)}\n`, () => answer.then?.());
  });
}

/** A control line as `{ key, command }` when it is exactly that shape, else null. */
function control_request(line) {
  let value = null;
  try { value = JSON.parse(line); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { key, command } = value;
  if (typeof key !== 'string' || !CONTROL_KEY_PATTERN.test(key) || !CONTROL_COMMANDS.has(command)) return null;
  return { key, command };
}

/** Delete the account; its instance directory stays on disk. */
export function remove_account(data, name) {
  const { [name]: removed, ...rest } = read_accounts(data);
  if (!removed) throw new Error(`账号不存在：${name}`);
  write_json(accounts_path(data), rest);
}

/** Whether the password is this account's; an unknown account costs the same time as a wrong password. */
function password_matches(account, password) {
  const salt = account?.salt || '00'.repeat(16);
  const expected = Buffer.from(account?.hash || '00'.repeat(32), 'hex');
  const actual = password_hash(String(password || ''), salt);
  return timingSafeEqual(actual, expected) && Boolean(account);
}

function token_key(token) {
  return createHash('sha256').update(token).digest('hex');
}

function request_cookies(request) {
  return String(request.headers.cookie || '').split(';').map(part => part.trim()).filter(Boolean);
}

function session_token(request) {
  const cookie = request_cookies(request).find(part => part.startsWith(`${SESSION_COOKIE}=`));
  return cookie ? cookie.slice(SESSION_COOKIE.length + 1) : '';
}

function cookie_header(request, token, seconds) {
  const secure = request.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${secure}`;
}

function send(response, status, headers, body = '') {
  response.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  response.end(body);
}

function send_json(response, status, value) {
  send(response, status, { 'Content-Type': 'application/json; charset=utf-8' }, JSON.stringify(value));
}

/**
 * Whether a session still grants access: unexpired, its account present and not disabled, and signed in with the account's
 * current password, so a reset password ends every session made with the old one.
 */
function session_live(session, account, at) {
  return Boolean(session && account && session.expires > at && !account.disabled && session.hash === account.hash
    && session.version === session_version(account));
}

/** Whether a stored session has the shape this entry writes; anything else is dropped rather than trusted. */
function session_shape(session) {
  return Boolean(session) && typeof session === 'object' && typeof session.name === 'string' && Number.isFinite(session.expires)
    && typeof session.hash === 'string' && Number.isInteger(session.version);
}

/** The persisted sessions that are well formed and unexpired; an unreadable or malformed file signs everyone out. */
function load_sessions(data, at) {
  const path = join(data, SESSIONS_FILE);
  let stored = {};
  try { stored = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}; } catch { stored = {}; }
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) stored = {};
  return new Map(Object.entries(stored).filter(([key, session]) => /^[a-f0-9]{64}$/.test(key) && session_shape(session) && session.expires > at));
}

const PAGE_HEAD = title => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · AI CoDiscuss</title>`;

function login_page(message = '') {
  const notice = message ? `<p class="error">${message}</p>` : '';
  return `${PAGE_HEAD('登录')}<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px system-ui,sans-serif;background:#f5f5f4;color:#1c1917}
form{width:min(320px,calc(100vw - 48px));display:grid;gap:12px}h1{font-size:20px;margin:0 0 8px}
input,button{font:inherit;padding:10px 12px;border-radius:8px;border:1px solid #d6d3d1}button{background:#1c1917;color:#fff;border:0}
.error{color:#b91c1c;margin:0;font-size:14px}
@media (prefers-color-scheme:dark){body{background:#1c1917;color:#f5f5f4}input{background:#292524;color:inherit;border-color:#44403c}button{background:#f5f5f4;color:#1c1917}}
</style></head><body><form method="post" action="${LOGIN_PATH}"><h1>AI CoDiscuss</h1>${notice}
<input name="name" placeholder="账号" autocomplete="username" autocapitalize="none" required>
<input name="password" type="password" placeholder="密码" autocomplete="current-password" required>
<button>登录</button></form></body></html>`;
}

/** What a person sees when their instance does not answer: no technical detail, a retry, and whom to ask. */
function unavailable_page() {
  return `${PAGE_HEAD('暂时打不开')}<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.7 system-ui,sans-serif;background:#f5f5f4;color:#1c1917}
main{width:min(360px,calc(100vw - 48px));display:grid;gap:12px}h1{font-size:20px;margin:0}p{margin:0;color:#57534e}
a{justify-self:start;padding:10px 16px;border-radius:8px;background:#1c1917;color:#fff;text-decoration:none}
@media (prefers-color-scheme:dark){body{background:#1c1917;color:#f5f5f4}p{color:#a8a29e}a{background:#f5f5f4;color:#1c1917}}
</style></head><body><main><h1>你的工作台暂时打不开</h1><p>可能正在重启或维护，你的对话和文件都还在。请过一两分钟再试；一直打不开的话，请联系为你开通服务的人。</p>
<a href="/">重新打开</a></main></body></html>`;
}

async function read_form(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > LOGIN_BODY_LIMIT) throw new Error('请求过大');
  }
  return new URLSearchParams(body);
}

/** A browser request from another site's page; requests without an Origin are not from a page script. */
function cross_origin(request) {
  const origin = request.headers.origin;
  if (!origin) return false;
  try { return new URL(origin).host !== request.headers.host; } catch { return true; }
}

/**
 * Present the request to the instance as its own loopback page, without any cookie: a hosted instance is a local site,
 * which signs no one in with cookies, and browsers send this computer's other cookies (the panel's, the entry's) to every
 * port of the same host, so passing them on would hand them to the account's own process. Nor may the instance set any:
 * whatever answers on its port could otherwise plant a cookie beside the entry's own.
 *
 * An account marked `protected` in the account list is reached only on a connection where its instance first proved the
 * key kept for it in the administrator's directory (`gateway-instance-keys.json`; runner/entry_client.mjs), so a process
 * that took the port of a stopped instance gets nothing of the request. Protection is that mark, never inferred from the
 * key: a protected account whose key is missing, malformed or unreadable is not forwarded at all.
 */
async function forward(request, response, port, { protected: guarded = false, key = '' } = {}) {
  const target = `127.0.0.1:${port}`;
  const headers = { ...request.headers, host: target };
  if (headers.origin) headers.origin = `http://${target}`;
  delete headers.referer;
  delete headers.cookie;
  // Only the entry speaks the handshake; a browser's own attempt is dropped.
  for (const name of ['x-codiscuss-entry', 'x-codiscuss-nonce', 'x-codiscuss-proof']) delete headers[name];
  const unavailable = () => {
    if (response.headersSent) return response.destroy();
    // A page gets a page; the site's own requests get an error they already show as a notice.
    if (request.method === 'GET' && String(request.headers.accept || '').includes('text/html')) {
      return send(response, 502, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }, unavailable_page());
    }
    send_json(response, 502, { error: '工作台暂时连不上，请稍后再试' });
  };
  const options = { host: '127.0.0.1', port, path: request.url, method: request.method, headers };
  // A protected account whose key is missing or unreadable is not forwarded at all: never as if it were unprotected.
  if (guarded && !key) { request.resume(); return unavailable(); }
  if (guarded) {
    let verified;
    try { verified = await verified_connection(port, key); } catch { request.resume(); return unavailable(); }
    headers['x-codiscuss-entry'] = verified.header;
    Object.assign(options, { createConnection: () => verified.socket });
  }
  const upstream = http.request(options, reply => {
    const { 'set-cookie': _dropped, ...reply_headers } = reply.headers;
    response.writeHead(reply.statusCode, reply_headers);
    reply.pipe(response);
  });
  upstream.on('error', unavailable);
  response.on('close', () => upstream.destroy());
  request.pipe(upstream);
}

/** The key protecting one account's instance, from the administrator's own copy; '' when it has none. */
export function instance_key(data, name) {
  try {
    const key = JSON.parse(readFileSync(join(data, INSTANCE_KEYS_FILE), 'utf8'))[name];
    return typeof key === 'string' && ENTRY_KEY_PATTERN.test(key) ? key : '';
  } catch { return ''; }
}

/**
 * Build the entry server.
 *
 * Args:
 *   data: The administrator's service directory, which holds the account list; instances are its siblings.
 *   now: Clock in milliseconds, replaceable in tests.
 *
 * Returns:
 *   An http.Server that is not yet listening. Sessions are saved beside the account list, so a restart keeps them; a
 *   password reset, disabling or removing the account ends them.
 */
export function create_gateway({ data, now = Date.now }) {
  const sessions = load_sessions(data, now());
  const failures = new Map();
  const save_sessions = () => write_json(join(data, SESSIONS_FILE), Object.fromEntries(sessions));

  /** The account a request's session still grants, or null; a session that no longer grants access is dropped. */
  function account_of(request) {
    const key = token_key(session_token(request));
    const session = sessions.get(key);
    if (!session) return null;
    const account = read_accounts(data)[session.name];
    if (session_live(session, account, now())) return { ...account, name: session.name };
    sessions.delete(key);
    save_sessions();
    return null;
  }

  async function login(request, response) {
    const form = await read_form(request);
    const name = String(form.get('name') || '').trim().toLowerCase();
    const failed = failures.get(name);
    if (failed && failed.until > now()) return send(response, 429, { 'Content-Type': 'text/html; charset=utf-8' }, login_page('尝试次数过多，请 10 分钟后再试'));
    // One snapshot both checks the password and fixes the session to it: a reset made meanwhile by the panel leaves this
    // session on the old version, so it never grants access.
    const account = NAME_PATTERN.test(name) ? read_accounts(data)[name] : null;
    if (!password_matches(account, form.get('password'))) {
      const count = (failed?.count || 0) + 1;
      if (NAME_PATTERN.test(name)) failures.set(name, { count, until: count >= MAX_FAILURES ? now() + LOCK_MS : 0 });
      return send(response, 401, { 'Content-Type': 'text/html; charset=utf-8' }, login_page('账号或密码不正确'));
    }
    failures.delete(name);
    if (account.disabled) return send(response, 403, { 'Content-Type': 'text/html; charset=utf-8' }, login_page('这个账号已停用，请联系为你开通的服务商'));
    const token = randomBytes(32).toString('hex');
    sessions.set(token_key(token), { name, expires: now() + SESSION_SECONDS * 1000, hash: account.hash, version: session_version(account) });
    save_sessions();
    send(response, 303, { Location: '/', 'Set-Cookie': cookie_header(request, token, SESSION_SECONDS) });
  }

  async function handle(request, response) {
    const path = new URL(request.url, 'http://entry').pathname;
    if (cross_origin(request)) return send_json(response, 403, { error: '不接受来自其他网站的请求' });
    if (path === LOGIN_PATH && request.method === 'GET') return send(response, 200, { 'Content-Type': 'text/html; charset=utf-8' }, login_page());
    if (path === LOGIN_PATH && request.method === 'POST') return login(request, response);
    if (path === LOGOUT_PATH && request.method === 'POST') {
      if (sessions.delete(token_key(session_token(request)))) save_sessions();
      return send(response, 303, { Location: LOGIN_PATH, 'Set-Cookie': cookie_header(request, '', 0) });
    }
    const account = account_of(request);
    // The site asks this to tell a page opened through the entry from one opened at the instance itself.
    if (path === SESSION_PATH && request.method === 'GET') return account ? send_json(response, 200, { signed_in: true }) : send_json(response, 401, { error: '请先登录' });
    if (account) return forward(request, response, account.port, { protected: account.protected === true, key: account.protected === true ? instance_key(data, account.name) : '' });
    const page = request.method === 'GET' && String(request.headers.accept || '').includes('text/html');
    return page ? send(response, 302, { Location: LOGIN_PATH }) : send_json(response, 401, { error: '请先登录' });
  }

  return http.createServer((request, response) => {
    handle(request, response).catch(error => {
      if (response.headersSent) response.destroy();
      else send_json(response, 400, { error: error.message });
    });
  });
}

/** Run `codiscuss local start|stop` against one account's service directory and wait for it. */
function run_instance(data, name, command) {
  if (!read_accounts(data)[name]) throw new Error(`账号不存在：${name}`);
  const child = spawn(process.execPath, [LOCAL_SCRIPT, command, '--json'], { stdio: 'inherit', windowsHide: true,
    env: { ...process.env, DISCUSS_SERVICE_HOME: instance_home(data, name) } });
  return new Promise((done, fail) => {
    child.on('error', fail);
    child.on('exit', code => code === 0 ? done() : fail(new Error(`实例${command === 'start' ? '启动' : '停止'}失败（退出码 ${code}）`)));
  });
}

// ---- The entry as a background process the panel starts and stops ----

// How people outside reach the entry: this computer only, the online relay (no domain needed), or a Cloudflare tunnel
// from the owner's own domain.
export const ENTRY_MODES = ['local', 'relay', 'tunnel'];

/**
 * The entry's saved settings: the loopback port it listens on, the public address customers open, and how they reach it
 * (`mode`). Settings from before the mode was chosen read as the way they set up: the tunnel when one is, else local.
 */
export function entry_settings(data) {
  const saved = read_json(join(data, ENTRY_SETTINGS_FILE));
  const tunnel = saved.tunnel && typeof saved.tunnel === 'object' && ['name', 'host', 'id', 'credentials'].every(key => saved.tunnel[key]) ? saved.tunnel : null;
  const mode = ENTRY_MODES.includes(saved.mode) ? saved.mode : tunnel ? 'tunnel' : 'local';
  return { port: Number.isInteger(saved.port) ? saved.port : DEFAULT_ENTRY_PORT, public_url: typeof saved.public_url === 'string' ? saved.public_url : '',
    running: saved.running === true, tunnel, mode, relay_url: typeof saved.relay_url === 'string' ? saved.relay_url : '' };
}

/**
 * Save part of the entry's settings.
 *
 * Args:
 *   changes: `port` (1–65535), `public_url` (an https address, kept as its origin; empty clears it), `running`, the
 *     state the panel restores when it starts again, and `tunnel`, the Cloudflare tunnel the panel runs for the outside
 *     address ({ name, host, id, credentials } from hosting_tunnel.mjs, or null for none), `mode` (one of ENTRY_MODES)
 *     and `relay_url`, the address of the relay's entry Worker (an https origin; empty clears it).
 *
 * Returns:
 *   The settings as saved.
 */
export function save_entry_settings(data, changes) {
  const next = { ...entry_settings(data) };
  if (changes.mode !== undefined) {
    if (!ENTRY_MODES.includes(changes.mode)) throw new Error(`未知的外网访问方式：${changes.mode}`);
    next.mode = changes.mode;
  }
  if (changes.relay_url !== undefined) next.relay_url = public_origin(changes.relay_url);
  if (changes.port !== undefined) {
    const port = Number(changes.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('入口端口须为 1–65535 的整数');
    next.port = port;
  }
  if (changes.public_url !== undefined) next.public_url = public_origin(changes.public_url);
  if (changes.running !== undefined) next.running = Boolean(changes.running);
  if (changes.tunnel !== undefined) next.tunnel = changes.tunnel || null;
  write_json(join(data, ENTRY_SETTINGS_FILE), next);
  return next;
}

/** An https address as its origin, or '' for none; anything else is refused, since sign-in cookies need HTTPS. */
function public_origin(text) {
  const value = String(text || '').trim();
  if (!value) return '';
  let url;
  try { url = new URL(value); } catch { throw new Error('公网地址格式不对，例如 https://entry.example.com'); }
  if (url.protocol !== 'https:') throw new Error('公网地址须以 https:// 开头');
  return url.origin;
}

/**
 * Ask the entry holding this directory's claim one control command, proving the request with the key it wrote.
 *
 * Only the claim holder listens on the claim's name, so an answer comes from the one entry of this directory and never
 * from an unrelated process that reused a process id or a port.
 *
 * Returns:
 *   The reply, null when no entry holds the claim, or `{ refused: true }` when one does but did not accept the key
 *   (it was just replaced, or the key file is unreadable).
 */
function control(data, command) {
  let key = '';
  try { key = String(read_json(join(data, ENTRY_KEY_FILE)).key || ''); } catch { key = ''; }
  return new Promise(done => {
    const socket = net.connect(claim_path(data));
    let text = '', settled = false;
    const finish = value => { if (!settled) { settled = true; socket.destroy(); done(value); } };
    socket.setEncoding('utf8');
    socket.setTimeout(CONTROL_TIMEOUT_MS, () => finish({ refused: true }));
    socket.on('connect', () => socket.write(`${JSON.stringify({ key, command })}\n`));
    socket.on('data', chunk => {
      text += chunk;
      const end = text.indexOf('\n');
      if (end >= 0) { try { finish(JSON.parse(text.slice(0, end))); } catch { finish({ refused: true }); } }
    });
    socket.on('error', error => finish(['ENOENT', 'ECONNREFUSED'].includes(error.code) ? null : { refused: true }));
    socket.on('close', () => finish({ refused: true }));
  });
}

/**
 * The entry of this directory: { running, pid, port }. `running` is true once it serves; `claimed` is true whenever some
 * entry holds the claim, including one still starting or one that did not accept the key.
 */
export async function entry_status(data) {
  let reply = await control(data, 'status');
  if (reply?.refused) { await new Promise(done => setTimeout(done, 200)); reply = await control(data, 'status'); }
  if (!reply) return { running: false, claimed: false, pid: 0, port: 0 };
  if (reply.refused) return { running: false, claimed: true, pid: 0, port: 0 };
  return { running: reply.port > 0, claimed: true, pid: reply.pid, port: reply.port };
}

/** Start the entry in the background on its saved port unless it already runs, and wait until it serves. */
export async function start_entry(data) {
  const current = await entry_status(data);
  if (current.running) return current;
  if (current.claimed) throw new Error('入口正在启动，或有一个无法确认的入口占着这个目录；请稍后再试');
  const { port } = entry_settings(data);
  const log = join(data, ENTRY_LOG_FILE);
  mkdirSync(data, { recursive: true });
  const output = openSync(log, 'a');
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'serve', '--port', String(port), '--data', data],
    { detached: true, stdio: ['ignore', output, output], windowsHide: true });
  closeSync(output);
  let exited = false;
  child.on('exit', () => { exited = true; });
  child.unref();
  for (let waited = 0; waited < ENTRY_START_MS && !exited; waited += 200) {
    await new Promise(done => setTimeout(done, 200));
    const status = await entry_status(data);
    if (status.running && status.pid === child.pid) return status;
  }
  // Still starting after the wait: the child is this call's own, so ending it ends nothing else.
  if (!exited) child.kill();
  const reason = readFileSync(log, 'utf8').trim().split(/\r?\n/).pop() || '';
  throw new Error(`入口没有启动${reason ? `：${reason}` : ''}`);
}

/** Ask the entry of this directory to exit, and wait until its claim is free; an entry that will not stop is reported. */
export async function stop_entry(data) {
  const reply = await control(data, 'stop');
  if (!reply) return;
  if (reply.refused) throw new Error('有一个入口占着这个目录，但无法确认它，没有停止它');
  for (let waited = 0; waited < ENTRY_START_MS; waited += 100) {
    if (!(await entry_status(data)).claimed) return;
    await new Promise(done => setTimeout(done, 100));
  }
  throw new Error('入口没有停下');
}

/**
 * Serve the entry: claim the directory, record the control key, then listen. Every step that can fail comes before the
 * listening socket, so a failure leaves nothing serving when the claim is given up.
 */
async function serve(data, host, port) {
  const key = randomBytes(32).toString('hex');
  let listening = 0;
  const claim = await claim_entry(data, request => {
    // control_request has already checked the shape: both keys are 64 hexadecimal characters.
    if (!timingSafeEqual(Buffer.from(request.key), Buffer.from(key))) return null;
    if (request.command === 'status') return { reply: { pid: process.pid, port: listening } };
    // Sessions are saved as they change, so exiting at once loses nothing; the operating system frees the port and claim.
    if (request.command === 'stop') return { reply: { stopping: true }, then: () => process.exit(0) };
    return null;
  });
  try {
    write_json(join(data, ENTRY_KEY_FILE), { key });
    const server = create_gateway({ data });
    await new Promise((done, fail) => { server.once('error', fail); server.listen(port, host, done); });
    listening = port;
  } catch (error) { claim.close(); throw error; }
}

async function main(args) {
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: {
    host: { type: 'string' }, port: { type: 'string' }, data: { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
  const [command, name] = positionals;
  const data = data_home(values.data);
  const print = value => process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);
  if (values.help || !command) return print(HELP);
  if (command === 'serve') {
    const host = values.host || '127.0.0.1', port = Number(values.port || DEFAULT_ENTRY_PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('入口端口须为 1–65535 的整数');
    await serve(data, host, port);
    return print(`入口已启动：http://${host}:${port}（管理员目录 ${data}）`);
  }
  if (command === 'list') return print(Object.entries(read_accounts(data)).map(([account, { port, disabled }]) =>
    ({ account, port, home: account_home(data, account), ...(disabled ? { disabled: true } : {}) })));
  if (command === 'add') return print(add_account(data, name, values.port));
  if (command === 'passwd') return print({ name, password: reset_password(data, name) });
  if (command === 'remove') return print((remove_account(data, name), { removed: name, kept: account_home(data, name) }));
  if (command === 'disable' || command === 'enable') return print((set_account_disabled(data, name, command === 'disable'), { name, disabled: command === 'disable' }));
  // A protected account starts only from the panel, which gives the instance its key file; started here it would run
  // without its protection.
  if (command === 'start' && read_accounts(data)[name]?.protected === true) throw new Error(`账号 ${name} 开启了入口保护，请从管理面板启动它的实例`);
  if (command === 'start' || command === 'stop') return run_instance(data, name, command);
  throw new Error(HELP);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}

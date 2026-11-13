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
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const SESSION_COOKIE = 'codiscuss_entry';
const SESSION_SECONDS = 30 * 24 * 3600;
const LOGIN_PATH = '/_entry/login';
const LOGOUT_PATH = '/_entry/logout';
const LOGIN_BODY_LIMIT = 4096;
const FIRST_INSTANCE_PORT = 18801;
const DEFAULT_ENTRY_PORT = 8780;
const MAX_FAILURES = 5;
const LOCK_MS = 10 * 60 * 1000;
const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{1,31}$/;
const ACCOUNTS_FILE = 'gateway-accounts.json';
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
  write_json(accounts_path(data), { ...accounts, [name]: { ...accounts[name], salt, hash } });
  return password;
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

function login_page(message = '') {
  const notice = message ? `<p class="error">${message}</p>` : '';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>登录 · AI CoDiscuss</title><style>
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

/** Present the request to the instance as its own loopback page, without the entry's session cookie. */
function forward(request, response, port) {
  const target = `127.0.0.1:${port}`;
  const headers = { ...request.headers, host: target };
  if (headers.origin) headers.origin = `http://${target}`;
  delete headers.referer;
  const cookies = request_cookies(request).filter(part => !part.startsWith(`${SESSION_COOKIE}=`));
  if (cookies.length) headers.cookie = cookies.join('; ');
  else delete headers.cookie;
  const upstream = http.request({ host: '127.0.0.1', port, path: request.url, method: request.method, headers }, reply => {
    response.writeHead(reply.statusCode, reply.headers);
    reply.pipe(response);
  });
  upstream.on('error', () => {
    if (response.headersSent) response.destroy();
    else send_json(response, 502, { error: '这个账号的实例没有在运行' });
  });
  response.on('close', () => upstream.destroy());
  request.pipe(upstream);
}

/**
 * Build the entry server.
 *
 * Args:
 *   data: The administrator's service directory, which holds the account list; instances are its siblings.
 *   now: Clock in milliseconds, replaceable in tests.
 *
 * Returns:
 *   An http.Server that is not yet listening. Sessions live in memory, so restarting it signs everyone out.
 */
export function create_gateway({ data, now = Date.now }) {
  const sessions = new Map();
  const failures = new Map();

  function session_of(request) {
    const key = token_key(session_token(request));
    const session = sessions.get(key);
    if (session && session.expires > now()) return session;
    sessions.delete(key);
    return null;
  }

  async function login(request, response) {
    const form = await read_form(request);
    const name = String(form.get('name') || '').trim().toLowerCase();
    const failed = failures.get(name);
    if (failed && failed.until > now()) return send(response, 429, { 'Content-Type': 'text/html; charset=utf-8' }, login_page('尝试次数过多，请 10 分钟后再试'));
    if (!password_matches(NAME_PATTERN.test(name) ? read_accounts(data)[name] : null, form.get('password'))) {
      const count = (failed?.count || 0) + 1;
      if (NAME_PATTERN.test(name)) failures.set(name, { count, until: count >= MAX_FAILURES ? now() + LOCK_MS : 0 });
      return send(response, 401, { 'Content-Type': 'text/html; charset=utf-8' }, login_page('账号或密码不正确'));
    }
    failures.delete(name);
    const token = randomBytes(32).toString('hex');
    sessions.set(token_key(token), { name, expires: now() + SESSION_SECONDS * 1000 });
    send(response, 303, { Location: '/', 'Set-Cookie': cookie_header(request, token, SESSION_SECONDS) });
  }

  async function handle(request, response) {
    const path = new URL(request.url, 'http://entry').pathname;
    if (cross_origin(request)) return send_json(response, 403, { error: '不接受来自其他网站的请求' });
    if (path === LOGIN_PATH && request.method === 'GET') return send(response, 200, { 'Content-Type': 'text/html; charset=utf-8' }, login_page());
    if (path === LOGIN_PATH && request.method === 'POST') return login(request, response);
    if (path === LOGOUT_PATH && request.method === 'POST') {
      sessions.delete(token_key(session_token(request)));
      return send(response, 303, { Location: LOGIN_PATH, 'Set-Cookie': cookie_header(request, '', 0) });
    }
    const account = read_accounts(data)[session_of(request)?.name];
    if (account) return forward(request, response, account.port);
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

async function main(args) {
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: {
    host: { type: 'string' }, port: { type: 'string' }, data: { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
  const [command, name] = positionals;
  const data = data_home(values.data);
  const print = value => process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);
  if (values.help || !command) return print(HELP);
  if (command === 'serve') {
    const host = values.host || '127.0.0.1', port = Number(values.port || DEFAULT_ENTRY_PORT);
    return create_gateway({ data }).listen(port, host, () => print(`入口已启动：http://${host}:${port}（管理员目录 ${data}）`));
  }
  if (command === 'list') return print(Object.entries(read_accounts(data)).map(([account, { port }]) => ({ account, port, home: account_home(data, account) })));
  if (command === 'add') return print(add_account(data, name, values.port));
  if (command === 'passwd') return print({ name, password: reset_password(data, name) });
  if (command === 'remove') return print((remove_account(data, name), { removed: name, kept: account_home(data, name) }));
  if (command === 'start' || command === 'stop') return run_instance(data, name, command);
  throw new Error(HELP);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}

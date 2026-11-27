/**
 * The three addresses an external member's computer uses, answered by the sign-in entry on the owner's own domain for
 * hosted accounts that invite external experts without the online relay (user 2026-11-19, #5588; security #5599):
 *
 *   GET  /api/guest/<id>/key           public keys of one known account
 *   POST /api/machines/<id>/pair       a sealed invite redemption, handed to that account's receiver
 *   POST /api/machines/<id>/relay      a member's sealed request, handed to that account's receiver
 *
 * They are answered only when the request comes in on the owner's domain (its Host), the tunnel is on, and the request
 * carries no live session; everything else goes through the entry as before. What this never does:
 * - pass anything from the account's receiver to the caller but a status and a sealed reply it re-serialises itself, with
 *   fixed headers, so an account cannot put a page of its own on the entry's address (#8);
 * - add the entry's handshake, a cookie or the caller's path when calling the receiver: the path is fixed and the
 *   member's path travels in the body, so an account that points its `local/direct.json` elsewhere gains nothing (#9);
 * - serve more at once than a few requests per account and in all, nor more redemptions than the limits below (#11, #12).
 * Which computer id belongs to which account is the panel's (`direct-accounts.json` in the administrator's directory).
 */
import http from 'node:http';
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { join } from 'node:path';

export const DIRECT_ACCOUNTS_FILE = 'direct-accounts.json';
const RECEIVER_FILE = join('local', 'direct.json');
const RECEIVER_PATH = '/direct';
const RECEIVER_TOKEN_HEADER = 'x-codiscuss-direct';
const BODY_MAX = 512 * 1024;
// A member's computer sends its request at once; a slow sender is cut off and only ever holds a cheap reading slot (#5617).
const READ_TIMEOUT_MS = 5_000;
const READING_MAX = 64;
// The receiver file is the account's to write: read only a small one (#5617).
const RECEIVER_FILE_MAX = 16 * 1024;
const KEY_PART = /^[A-Za-z0-9_-]{1,64}$/;
// The online relay holds a request at most this long (backend/updates.mjs RELAY_MAX_WAIT_MS).
const WAIT_MAX_MS = 80_000;
const REPLY_MAX = 4 * 1024 * 1024;
const GLOBAL_CONCURRENT = 16;
const ACCOUNT_CONCURRENT = 4;
// Redemptions: per sending address as the online site allows (worker.mjs limit_pairing), and per account in all.
const PAIR_WINDOW_MS = 10 * 60 * 1000;
const PAIR_PER_SOURCE = 10;
const PAIR_PER_ACCOUNT = 40;
const ID_PATTERN = /^[A-Za-z0-9_-]{16,80}$/;
const MACHINE_PATTERN = /^[0-9a-f]{32}$/;
const ROUTE = /^\/api\/machines\/([0-9a-f]{32})\/(pair|relay)$/;
const HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' };

const GUEST_ROUTE = /^\/api\/guest\/([0-9a-f]{32})\/(key|pair|relay)$/;
const GUEST_FILES = new Map([
  ['/guest/', ['guest/index.html', 'text/html']],
  ['/guest/guest.js', ['guest.js', 'text/javascript']],
  ['/guest/guest.css', ['guest.css', 'text/css']],
  ['/guest/i18n.js', ['i18n.js', 'text/javascript']],
]);

function guest_asset(response, path, method) {
  const asset = GUEST_FILES.get(path);
  if (method !== 'GET' || !asset) { answer(response, 404, {}); return; }
  const [file, mime] = asset;
  let contents;
  try { contents = readFileSync(new URL('../web/' + file, import.meta.url)); }
  catch { answer(response, 503, {}); return; }
  if (mime === 'text/html') contents = contents.toString('utf8').replace(/(src|href)="\/(guest\.js|guest\.css|i18n\.js)"/g, '$1="/guest/$2"');
  response.writeHead(200, { ...HEADERS, 'Content-Type': mime + '; charset=utf-8', 'Referrer-Policy': 'no-referrer' });
  response.end(contents);
}

function answer(response, status, value) {
  response.writeHead(status, HEADERS);
  response.end(JSON.stringify(value));
}

function read_json(path) {
  try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}; } catch { return {}; }
}

/** The owner's domain the tunnel serves, or '' while the tunnel is off. */
function direct_host(settings) {
  return settings.tunnel_enabled && settings.tunnel?.host ? String(settings.tunnel.host).toLowerCase() : '';
}

/** One account's receiver as its discussion service published it, refusing a folder that is a link (#9). */
function read_receiver(home) {
  for (const path of [home, join(home, 'local')]) {
    try { if (lstatSync(path).isSymbolicLink()) return null; } catch { return null; }
  }
  const file = join(home, RECEIVER_FILE);
  let receiver;
  try {
    if (lstatSync(file).isSymbolicLink()) return null;
    // The limit is kept by the read itself, not by a size checked before it that could change in between (#5625).
    const fd = openSync(file, 'r'), buffer = Buffer.alloc(RECEIVER_FILE_MAX + 1);
    let size;
    try { size = readSync(fd, buffer, 0, buffer.length, 0); } finally { closeSync(fd); }
    if (size > RECEIVER_FILE_MAX) return null;
    receiver = JSON.parse(buffer.subarray(0, size).toString('utf8'));
  } catch { return null; }
  const valid = Number.isInteger(receiver.port) && receiver.port > 0 && receiver.port < 65536 && typeof receiver.token === 'string'
    && /^[0-9a-f]{64}$/.test(receiver.token) && typeof receiver.machine === 'string' && MACHINE_PATTERN.test(receiver.machine);
  return valid ? { port: receiver.port, token: receiver.token, machine: receiver.machine, public_key: public_key(receiver.public_key), sign_key: public_key(receiver.sign_key) } : null;
}

/** A P-256 public key rebuilt from its four fields, or null: nothing else the account wrote is passed on (#5617). */
function public_key(value) {
  if (!value || typeof value !== 'object' || value.kty !== 'EC' || value.crv !== 'P-256' || !KEY_PART.test(String(value.x)) || !KEY_PART.test(String(value.y))) return null;
  return { kty: 'EC', crv: 'P-256', x: value.x, y: value.y };
}

/** Read a JSON body up to BODY_MAX within READ_TIMEOUT_MS. */
function read_body(request) {
  return new Promise((done, fail) => {
    const parts = [];
    let size = 0;
    const timer = setTimeout(() => { request.destroy(); fail(Object.assign(new Error('读取超时'), { status: 408 })); }, READ_TIMEOUT_MS);
    request.on('data', part => {
      size += part.length;
      if (size > BODY_MAX) { clearTimeout(timer); request.destroy(); fail(Object.assign(new Error('请求过大'), { status: 413 })); return; }
      parts.push(part);
    });
    request.on('end', () => { clearTimeout(timer); try { done(JSON.parse(Buffer.concat(parts).toString('utf8'))); } catch { fail(Object.assign(new Error('请求格式无效'), { status: 400 })); } });
    request.on('error', error => { clearTimeout(timer); fail(error); });
  });
}

/** Call one receiver; resolves `{ status, body }`, or null when it could not be reached or did not answer in time. */
function call_receiver(receiver, payload, timeout_ms) {
  return new Promise(done => {
    const text = JSON.stringify(payload);
    const upstream = http.request({ host: '127.0.0.1', port: receiver.port, path: RECEIVER_PATH, method: 'POST', timeout: timeout_ms,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), [RECEIVER_TOKEN_HEADER]: receiver.token } }, reply => {
      const parts = [];
      let size = 0;
      reply.on('data', part => { size += part.length; if (size > REPLY_MAX) { reply.destroy(); done(null); } else parts.push(part); });
      reply.on('end', () => { try { done({ status: reply.statusCode, body: JSON.parse(Buffer.concat(parts).toString('utf8')) }); } catch { done(null); } });
      reply.on('error', () => done(null));
    });
    upstream.on('timeout', () => { upstream.destroy(); done(null); });
    upstream.on('error', () => done(null));
    upstream.end(text);
  });
}

/** Only a sealed reply in the relay's shape, rebuilt field by field (#8). */
function sealed_reply(id, body) {
  const response = body?.response;
  if (body?.id !== id || body?.status !== 'done' || !response || typeof response.iv !== 'string' || typeof response.data !== 'string'
    || response.iv.length > 64 || response.data.length > REPLY_MAX) return null;
  return { id, status: 'done', response: { iv: response.iv, data: response.data, ...(response.encoding === 'gzip' ? { encoding: 'gzip' } : {}) } };
}

/**
 * Build the direct handler for one entry. Returns `handle(request, response, signed_in)`, true when it answered the
 * request; `data` is the administrator's directory, `instance_home(data, name)` an account's service directory.
 */
export function create_direct({ data, read_accounts, entry_settings, instance_home, now = Date.now }) {
  let active = 0, reading = 0;
  const per_account = new Map(), pairs = new Map();

  /** Count one redemption against its source and account; false once either is over its limit. */
  function allow_pair(source, name) {
    const at = now();
    const fresh = list => (list || []).filter(time => at - time < PAIR_WINDOW_MS);
    const by_source = fresh(pairs.get(`s:${source}`)), by_account = fresh(pairs.get(`a:${name}`));
    if (by_source.length >= PAIR_PER_SOURCE || by_account.length >= PAIR_PER_ACCOUNT) {
      pairs.set(`s:${source}`, by_source); pairs.set(`a:${name}`, by_account);
      return false;
    }
    pairs.set(`s:${source}`, [...by_source, at]); pairs.set(`a:${name}`, [...by_account, at]);
    if (pairs.size > 10_000) for (const [key, list] of pairs) if (!fresh(list).length) pairs.delete(key);
    return true;
  }

  /** The accounts reached directly: id → name, for accounts that exist and are not disabled. */
  function direct_accounts() {
    const accounts = read_accounts(data), mapped = read_json(join(data, DIRECT_ACCOUNTS_FILE));
    return Object.entries(mapped).filter(([id, name]) => MACHINE_PATTERN.test(id) && accounts[name] && !accounts[name].disabled);
  }

  return async function handle(request, response, signed_in) {
    if (signed_in) return false;
    const path = new URL(request.url, 'http://entry').pathname;
    const guest = path === '/guest' || path.startsWith('/guest/') || path === '/api/guest' || path.startsWith('/api/guest/');
    const route = guest ? GUEST_ROUTE.exec(path) : ROUTE.exec(path);
    if (!guest && !route && path !== '/api/machines') return false;
    // Only these addresses read the entry's settings, so signed-in pages pay nothing for this (#5617).
    const host = direct_host(entry_settings(data));
    if (!host || String(request.headers.host || '').toLowerCase() !== host) {
      if (guest) answer(response, 404, {});
      return guest;
    }
    if (guest && !route) {
      guest_asset(response, path, request.method);
      return true;
    }
    if (guest && route[2] === 'key') {
      const account = direct_accounts().find(([id]) => id === route[1])?.[1];
      const receiver = account && read_receiver(instance_home(data, account));
      if (request.method !== 'GET' || receiver?.machine !== route[1] || !receiver.public_key || !receiver.sign_key) answer(response, 404, {});
      else answer(response, 200, { id: route[1], public_key: receiver.public_key, sign_key: receiver.sign_key, transport: 'direct' });
      return true;
    }
    if (path === '/api/machines') {
      if (request.method !== 'GET') return false;
      answer(response, 426, { error: '请更新 AI CoDiscuss 后使用完整邀请链接。 Please update AI CoDiscuss and use the full invitation link.', code: 'client_update_required' });
      return true;
    }
    if (request.method !== 'POST') { request.resume(); answer(response, 404, { error: '地址不存在' }); return true; }
    const [, machine, kind] = route;
    const name = direct_accounts().find(([id]) => id === machine)?.[1];
    if (!name) { request.resume(); answer(response, 404, { error: '这台电脑尚未连接网站' }); return true; }
    // Cloudflare writes the sending address on the way in through the tunnel.
    const source = String(request.headers['cf-connecting-ip'] || request.socket.remoteAddress || 'unknown');
    if (kind === 'pair' && !allow_pair(source, name)) { request.resume(); answer(response, 429, { error: '配对尝试过于频繁，请稍后再试' }); return true; }
    // The body is announced and small; it is read in a slot of its own, apart from the slots the receiver is called in.
    const length = Number(request.headers['content-length']);
    if (!Number.isInteger(length) || length <= 0 || length > BODY_MAX) { request.resume(); answer(response, length > BODY_MAX ? 413 : 411, { error: '请求须注明长度且不超过上限' }); return true; }
    if (reading >= READING_MAX) { request.resume(); answer(response, 503, { error: '请求过多，请稍后再试' }); return true; }
    reading += 1;
    let body;
    try { body = await read_body(request); } catch (error) { answer(response, error.status || 400, { error: error.message }); return true; }
    finally { reading -= 1; }
    const { id, envelope, wait } = body || {};
    if (typeof id !== 'string' || !ID_PATTERN.test(id) || !envelope || typeof envelope !== 'object') { answer(response, 400, { error: '命令编号无效' }); return true; }
    if (active >= GLOBAL_CONCURRENT || (per_account.get(name) || 0) >= ACCOUNT_CONCURRENT) { answer(response, 503, { error: '请求过多，请稍后再试' }); return true; }
    active += 1;
    per_account.set(name, (per_account.get(name) || 0) + 1);
    try {
      const receiver = read_receiver(instance_home(data, name));
      if (!receiver || receiver.machine !== machine) { answer(response, 200, { id, status: 'offline' }); return true; }
      const timeout = Math.min(Math.max(Number.isInteger(wait) ? wait : 8000, 1000), WAIT_MAX_MS);
      const result = await call_receiver(receiver, { kind, path, credential: String(request.headers['x-codiscuss-device'] || ''), id, envelope }, timeout);
      if (guest && !direct_accounts().some(([id, account]) => id === machine && account === name)) {
        answer(response, 404, { error: '这台电脑尚未连接网站' });
        return true;
      }
      if (!result) { answer(response, 200, { id, status: 'unknown' }); return true; }
      if (result.status === 200) {
        const reply = sealed_reply(id, result.body);
        reply ? answer(response, 200, reply) : answer(response, 200, { id, status: 'unknown' });
        return true;
      }
      // A refusal keeps only its kind; the receiver's own words are not passed on.
      const refusal = { 400: '请求格式无效', 401: '这台设备没有与电脑配对，或配对已失效', 403: '这个入口只接受外部成员的请求', 404: '地址不存在', 413: '请求过大', 503: '请求过多，请稍后再试' };
      const status = refusal[result.status] ? result.status : 502;
      answer(response, status, { error: refusal[status] || '暂时无法处理' });
      return true;
    } finally {
      active -= 1;
      per_account.set(name, per_account.get(name) - 1);
    }
  };
}

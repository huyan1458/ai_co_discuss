/**
 * The caller's side of an instance's entry protection (backend/entry_guard.py).
 *
 * Before any request is sent, the caller connects to the instance's loopback port and asks it to prove that it holds the
 * instance's key; only on that same connection, once the proof checks out, does the request go, carrying the caller's
 * own proof. Whatever else answers on the port (another account's process that took it while the instance was down)
 * receives a hello and nothing more. The key itself never travels.
 *
 * The verified socket is handed to `http.request` through `createConnection` with no agent, so the request cannot move
 * to another, unverified connection; nothing here retries on a new one.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { Readable } from 'node:stream';

export const ENTRY_KEY_PATTERN = /^[0-9a-f]{64}$/;
const NONCE_PATTERN = /^[0-9a-f]{32}$/;
const HELLO_PATH = '/_instance/hello';
const HELLO_TIMEOUT_MS = 5000;
const HEADER_LIMIT = 8192;

/** HMAC-SHA256 of `purpose|nonce` under the hexadecimal key, as hexadecimal. */
export function entry_proof(key, purpose, nonce) {
  return createHmac('sha256', Buffer.from(key, 'hex')).update(`${purpose}|${nonce}`).digest('hex');
}

function same(a, b) {
  const left = Buffer.from(String(a)), right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Status and lower-case headers of a response head, or null when it is not one. */
function parse_head(text) {
  const [status_line, ...lines] = text.split('\r\n');
  const status = /^HTTP\/1\.1 (\d{3}) /.exec(status_line);
  if (!status) return null;
  const headers = {};
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return { status: Number(status[1]), headers };
}

/**
 * Open a connection to an instance and verify it.
 *
 * Args:
 *   port: The instance's loopback port.
 *   key: The instance's key, 64 hexadecimal characters.
 *
 * Returns:
 *   { socket, header }: the verified socket, with nothing unread, and the value of `X-CoDiscuss-Entry` for
 *   the one request to send on it. Rejects (and destroys the socket) when the instance does not prove the key, closes,
 *   says it will close, sends anything beyond the empty answer, or takes too long.
 */
export function verified_connection(port, key, { host = '127.0.0.1', timeout = HELLO_TIMEOUT_MS, signal } = {}) {
  if (!ENTRY_KEY_PATTERN.test(String(key || ''))) return Promise.reject(new Error('没有可用的实例密钥'));
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('已取消'));
  const nonce = randomBytes(16).toString('hex');
  return new Promise((done, fail) => {
    const socket = net.connect({ host, port });
    let buffer = Buffer.alloc(0), settled = false;
    // The caller's timeout or stop applies to the handshake too: the socket is destroyed at once.
    const on_abort = () => finish(signal.reason ?? new Error('已取消'));
    signal?.addEventListener('abort', on_abort, { once: true });
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', on_abort);
      socket.removeListener('data', on_data);
      socket.removeListener('error', on_error);
      socket.removeListener('close', on_close);
      // Not paused: the HTTP client attaches its own reader and would not resume a socket paused here. Nothing is lost,
      // since the instance sends nothing more until the request arrives.
      if (error) { socket.destroy(); fail(error); } else done(value);
    };
    const timer = setTimeout(() => finish(new Error('实例没有及时证明身份')), timeout);
    const on_error = error => finish(new Error(`连不上实例：${error.message}`));
    const on_close = () => finish(new Error('实例在证明身份前断开了'));
    const on_data = chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) { if (buffer.length > HEADER_LIMIT) finish(new Error('实例的应答不对')); return; }
      const head = parse_head(buffer.subarray(0, end).toString('latin1'));
      const extra = buffer.length - end - 4;
      const challenge = head?.headers['x-codiscuss-nonce'] || '';
      if (!head || head.status !== 204 || extra !== 0 || /close/i.test(head.headers.connection || '')
          || !NONCE_PATTERN.test(challenge) || !same(head.headers['x-codiscuss-proof'] || '', entry_proof(key, 'instance', nonce))) {
        return finish(new Error('无法确认这是目标实例'));
      }
      finish(null, { socket, header: entry_proof(key, 'entry', challenge) });
    };
    socket.on('data', on_data);
    socket.on('error', on_error);
    socket.on('close', on_close);
    socket.once('connect', () => socket.write(`GET ${HELLO_PATH} HTTP/1.1\r\nHost: ${host}:${port}\r\nX-CoDiscuss-Nonce: ${nonce}\r\nContent-Length: 0\r\n\r\n`));
  });
}

const KEY_FILE_VARIABLE = 'DISCUSS_ENTRY_KEY_FILE';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const BODYLESS = new Set([101, 204, 205, 304]);

/**
 * The key file of a protected instance, as a task's access file carries it: members started outside this service's
 * environment (an original window, the Antigravity sidecar) learn it there. Empty when protection is not configured.
 */
export function entry_access() {
  return process.env[KEY_FILE_VARIABLE] ? { entry_key_file: process.env[KEY_FILE_VARIABLE] } : {};
}

/** The instance key when protection is configured: '' when it is not, an error when it is but unusable. */
function configured_key(key_file = process.env[KEY_FILE_VARIABLE]) {
  const path = key_file;
  if (!path) return '';
  let key = '';
  try { key = String(JSON.parse(readFileSync(path, 'utf8')).key || ''); } catch { key = ''; }
  // Protection is configured, so a missing or broken key stops the request rather than sending it unproven.
  if (!ENTRY_KEY_PATTERN.test(key)) throw new Error('这个工作台开启了入口保护，但读不到它的密钥，请求没有发出');
  return key;
}

/**
 * `fetch` for this service's own website.
 *
 * When this service runs a protected instance (its environment names the key file), every request to a loopback address
 * goes through the handshake on a verified connection; other addresses, and every request of an unprotected service,
 * use the ordinary `fetch`. The answer is a standard Response, so callers read it the same way either way.
 */
export async function site_fetch(url, init = {}, { key_file } = {}) {
  const target = new URL(url);
  const key = LOOPBACK_HOSTS.has(target.hostname) ? configured_key(key_file || process.env[KEY_FILE_VARIABLE]) : '';
  if (!key) return fetch(url, init);
  const port = Number(target.port || 80);
  const { socket, header } = await verified_connection(port, key, { signal: init.signal });
  const headers = { ...Object.fromEntries(new Headers(init.headers || {})), host: target.host, 'x-codiscuss-entry': header };
  const body = init.body === undefined || init.body === null ? null : Buffer.from(typeof init.body === 'string' ? init.body : init.body);
  if (body) headers['content-length'] = String(body.length);
  return new Promise((done, fail) => {
    const request = http.request({ host: target.hostname, port, path: `${target.pathname}${target.search}`, method: init.method || 'GET', headers,
      createConnection: () => socket }, reply => {
      const response_headers = new Headers();
      for (const [name, value] of Object.entries(reply.headers)) for (const item of [value].flat()) response_headers.append(name, String(item));
      const stream = BODYLESS.has(reply.statusCode) ? null : Readable.toWeb(reply);
      if (!stream) reply.resume();
      done(new Response(stream, { status: reply.statusCode, statusText: reply.statusMessage, headers: response_headers }));
    });
    request.on('error', fail);
    if (init.signal) {
      if (init.signal.aborted) request.destroy(init.signal.reason);
      init.signal.addEventListener('abort', () => request.destroy(init.signal.reason), { once: true });
    }
    request.end(body || undefined);
  });
}

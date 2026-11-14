/**
 * Keep one hibernating WebSocket per paired website so the administrator's devices reach this computer at once:
 * each encrypted request is answered here, room reads and writes go to the local website with this computer's bridge
 * credential, and the local website's change notices are passed on. The website only ever forwards ciphertext.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { gzipSync } from 'node:zlib';

import { atomic_json } from './files.mjs';
import { remote_execution_details, remote_room_files, remote_room_media, remote_room_page } from './discussion_launch.mjs';
import { acquire_lock } from './discussion_runner.mjs';
import { local_settings } from './discussion_setup.mjs';
import { machine_links, relay_cipher, save_machine_links, relayed_command, ROOM_ACTIONS, run_launch_command, sync_remote_launches, unseal } from './remote_launch.mjs';
import { claim_relayed_command } from './remote_policy.mjs';
import { audit, DEVICE_ACTIONS, device_command, open_signed_request } from './device_auth.mjs';
import { site_fetch } from './entry_client.mjs';
import { entry_settings } from '../gateway/gateway.mjs';

const RELAY_PROTOCOL = 'codiscuss-relay';
const BRIDGE_TOKEN_BYTES = 32;
const RETRY_MIN_MS = 2000;
const RETRY_MAX_MS = 60000;
// A ping still unanswered at the next one means the connection is stalled, so it is replaced within two of these.
const PING_MS = 15000;
// The site gives up on a request after 9 seconds, so the local website must answer before then.
const LOCAL_TIMEOUT_MS = 8000;
const EVENT_RETRY_MS = 3000;
// Diagnostics: a request answered slower than this, or not delivered, is written to the service log (action and route only).
const SLOW_REQUEST_MS = 3000;
// A WebSocket frame on the website is at most 1 MiB; leave room for the envelope around the ciphertext.
const RESPONSE_MAX_BYTES = 700 * 1024;
const ROOM_API_PATH = /^\/api\/(rooms|folders|revisions)(\/[A-Za-z0-9_.~-]+)*(\?[A-Za-z0-9_.~%=&,:+-]*)?$/;
// Attachment uploads arrive in parts and are sent to the local website whole, as one browser upload would be.
const UPLOAD_PATH = /^\/api\/rooms\/[A-Za-z0-9_-]+\/attachments(\/[A-Za-z0-9_-]+\/import)?(\?[A-Za-z0-9_.~%=&,:+-]*)?$/;
const UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
const UPLOAD_TTL_MS = 10 * 60 * 1000;
const uploads = new Map();
// The hosted accounts' entry over the relay (backend/entry_worker.mjs): answer parts per frame (sent as base64 within the
// 1 MiB frame), the largest request taken, and when to pause reading an answer the connection has not sent on yet.
const ENTRY_PART_BYTES = 512 * 1024;
const ENTRY_BODY_MAX_BYTES = 45 * 1024 * 1024;
const ENTRY_BUFFER_HIGH = 4 * 1024 * 1024;
const ENTRY_BUFFER_CHECK_MS = 50;
const ENTRY_HOP_HEADERS = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection', 'te', 'trailer', 'content-length',
  'x-forwarded-proto', 'x-forwarded-for', 'x-forwarded-host', 'x-real-ip']);

/** The bridge token for one website, created on first use; the local website keeps only its hash, next to the connection. */
export function bridge_token(home, site) {
  const links = machine_links(home);
  const link = links.sites[site];
  if (!link) return '';
  if (!link.bridge_token) {
    link.bridge_token = randomBytes(BRIDGE_TOKEN_BYTES).toString('hex');
    save_machine_links(home, links);
  }
  const path = join(home, 'site-connections.json');
  const hashed = createHash('sha256').update(link.bridge_token).digest('hex');
  const settings = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { sites: {} };
  // The entry also tells the local website that this site reaches it only through the relay, so a browser connection
  // credential kept from before no longer works. A website disconnected meanwhile has lost its pairing: no bridge then.
  if (settings.sites[site]?.bridge_hash !== hashed) {
    const release = acquire_lock(join(home, 'connection-lock'));
    try {
      const latest = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { sites: {} };
      if (machine_links(home).sites[site]) atomic_json(path, { ...latest, sites: { ...latest.sites, [site]: { ...latest.sites[site], bridge_hash: hashed } } });
    } finally { release(); }
  }
  return link.bridge_token;
}

/** Encrypt a compressed answer bound to its request, so the website cannot swap one answer into another request. */
async function seal_compressed(key, value, label) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(label) }, key,
    gzipSync(Buffer.from(JSON.stringify(value))));
  return { iv: Buffer.from(iv).toString('base64'), data: Buffer.from(data).toString('base64'), encoding: 'gzip' };
}

/**
 * Read or write one room route on the local website as this computer's bridge. Only room, folder and revision routes
 * of the local website itself are reachable; the device cannot name another address. Binary content comes back as base64.
 */
export async function room_api(home, site, payload, { fetcher = site_fetch, device } = {}) {
  const { method = 'GET', path, body, token, offset = 0, etag } = payload || {};
  if (!['GET', 'POST'].includes(method) || typeof path !== 'string' || !ROOM_API_PATH.test(path) || path.includes('..')
      || !Number.isSafeInteger(offset) || offset < 0) {
    return { status: 400, body: { error: '中转请求地址无效' } };
  }
  const headers = bridge_headers(home, site);
  if (typeof token === 'string' && token) headers['X-Discussion-Token'] = token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  // A read the device already holds is asked conditionally; unchanged, the answer is a bare 304 with no body.
  if (method === 'GET' && typeof etag === 'string' && /^"[0-9a-f]{1,64}"$/.test(etag)) headers['If-None-Match'] = etag;
  const response = await fetcher(`${local_origin(home)}${path}`, { method, headers, redirect: 'error',
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(LOCAL_TIMEOUT_MS) });
  const tag = response.headers.get('ETag');
  if (response.status === 304) return { status: 304, etag: tag || etag };
  const type = response.headers.get('Content-Type') || '';
  if (type.startsWith('application/json')) return { status: response.status, body: await response.json(), ...(tag ? { etag: tag } : {}) };
  // A file larger than one frame comes back in parts; the device asks again from where the previous part ended.
  const bytes = Buffer.from(await response.arrayBuffer());
  return { status: response.status, content_type: type, offset, total: bytes.length,
    body_base64: bytes.subarray(offset, offset + RESPONSE_MAX_BYTES).toString('base64') };
}

/** The local website this computer runs. */
function local_origin(home) {
  return `http://127.0.0.1:${local_settings(home).port || 8765}`;
}

/** The headers that make a request to the local website act as this computer's bridge for one paired website. */
function bridge_headers(home, site) {
  return { 'X-CoDiscuss-Bridge': bridge_token(home, site), 'X-CoDiscuss-Bridge-Site': site };
}

/**
 * Collect one part of an attachment upload; once every part has arrived, send the whole file to the local website as
 * the bridge. Parts may be resent; an unfinished upload is dropped after ten minutes.
 */
export async function room_upload(home, site, payload, { fetcher = site_fetch, now = Date.now() } = {}) {
  const { id, path, index, total, size, content_type = 'application/octet-stream', data } = payload || {};
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{16,80}$/.test(id) || typeof path !== 'string' || !UPLOAD_PATH.test(path)
      || !Number.isSafeInteger(total) || total < 1 || !Number.isSafeInteger(index) || index < 0 || index >= total
      || !Number.isSafeInteger(size) || size < 0 || size > UPLOAD_MAX_BYTES || typeof data !== 'string' || typeof content_type !== 'string') {
    return { status: 400, body: { error: '附件上传请求无效' } };
  }
  for (const [key, item] of uploads) if (now - item.at > UPLOAD_TTL_MS) uploads.delete(key);
  const upload = uploads.get(id) ?? { path, total, size, parts: [], at: now };
  if (upload.path !== path || upload.total !== total || upload.size !== size) return { status: 400, body: { error: '附件上传请求无效' } };
  upload.parts[index] = Buffer.from(data, 'base64');
  upload.at = now;
  uploads.set(id, upload);
  const received = upload.parts.filter(Boolean).length;
  if (received < total) return { status: 200, body: { received } };
  uploads.delete(id);
  const bytes = Buffer.concat(upload.parts);
  if (bytes.length !== size) return { status: 400, body: { error: '附件不完整，请重新上传' } };
  const response = await fetcher(`${local_origin(home)}${path}`, { method: 'POST', redirect: 'error', body: bytes,
    headers: { ...bridge_headers(home, site), 'Content-Type': content_type }, signal: AbortSignal.timeout(LOCAL_TIMEOUT_MS) });
  return { status: response.status, body: await response.json() };
}

/** Room credentials and website of the rooms this computer serves on its own local website, by room. */
function local_rooms(home) {
  const path = join(home, 'rooms.json'), port = local_settings(home).port || 8765, rooms = new Map();
  const configs = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).configs ?? [] : [];
  for (const config_path of configs) {
    try {
      const config = JSON.parse(readFileSync(config_path, 'utf8'));
      const url = new URL(config.site);
      if (['127.0.0.1', 'localhost'].includes(url.hostname) && Number(url.port) === port && typeof config.token === 'string') {
        rooms.set(config.room, { site: url.origin, token: config.token });
      }
    } catch { /* A broken configuration grants nothing. */ }
  }
  return rooms;
}

/**
 * A local operation for the rooms on this computer's own website, asked for by an administrator's device: room
 * operations run against the local website with the room credentials this computer already keeps; others as before.
 */
export function computer_command(home, site, action, payload) {
  if (!ROOM_ACTIONS.has(action)) return relayed_command(site, action, payload);
  const rooms = local_rooms(home), input = { ...payload };
  const room = rooms.get(input.room_id);
  if (input.room_id && !input.token) input.token = room?.token ?? '';
  if (input.source_room_id && !input.source_token) input.source_token = rooms.get(input.source_room_id)?.token ?? '';
  return relayed_command(room?.site ?? local_origin(home), action, input);
}

/**
 * Run one local operation; browsing project files, reading an HTML page and a turn's steps are answered in this
 * process, since they are asked for on every folder opened, page part or private-chat poll.
 */
async function run_command(home, command, run) {
  if (run !== run_launch_command) return run(command);
  if (command.command === 'room-files') return { status: 200, body: await remote_room_files(home, command.input) };
  if (command.command === 'room-page') return { status: 200, body: await remote_room_page(home, command.input) };
  if (command.command === 'room-media') return { status: 200, body: await remote_room_media(home, command.input) };
  if (command.command === 'execution-details') return { status: 200, body: await remote_execution_details(home, command.input) };
  return run(command);
}

/** Answer one relayed request: room routes and uploads go to the local website, everything else to the local entrypoint as before. */
export async function answer_request(home, site, link, frame, { run = run_launch_command, fetcher, report } = {}) {
  const { id, envelope } = frame;
  const key = await relay_cipher(link.private_key, envelope.key);
  const sealed = await unseal(key, envelope, id);
  let response, request = {};
  try {
    // Only a paired device's signed request runs; an unpaired browser may only prove a pairing code.
    const opened = await open_signed_request(home, id, sealed, link.id);
    request = opened.request;
    const { action, payload, target } = request;
    claim_relayed_command(home, id, request.sent_at);
    const device = opened.device_id;
    response = DEVICE_ACTIONS.has(action) ? await device_command(home, { site, machine_id: link.id, device_id: device, on_change: () => sync_remote_launches(home) }, action, payload)
      : action === 'computer-site' ? { status: 200, body: { site: local_origin(home) } }
      : action === 'room-api' ? await room_api(home, site, payload, { fetcher, device })
      : action === 'room-upload' ? await room_upload(home, site, payload, { fetcher })
        : await run_command(home, { ...(target === 'computer' ? computer_command(home, site, action, payload) : relayed_command(site, action, payload)), device }, run);
  } catch (error) { response = { status: 400, body: { error: error.message, ...(error.need ? { need: error.need } : {}) } }; }
  // Remote writes go to this computer's audit log: kind, route, device and outcome, never content. Reads are not logged.
  if (request.action && !(request.action === 'room-api' && (request.payload?.method || 'GET') === 'GET') && !DEVICE_ACTIONS.has(request.action) && request.action !== 'computer-site') {
    audit(home, { event: 'command', action: request.action, route: typeof request.payload?.path === 'string' ? request.payload.path.split('?')[0] : '',
      device: sealed.device_id || null, status: response.status });
  }
  // Only what kind of request it was and how it ended: never its content or query.
  report?.({ action: request.action, route: typeof request.payload?.path === 'string' ? request.payload.path.split('?')[0] : '', status: response.status });
  return { type: 'response', id, envelope: await seal_compressed(key, response, `${id}:response`) };
}

/** Pass the local website's change notices to the devices while the relay is connected. */
async function forward_changes(home, socket, signal) {
  while (!signal.aborted && socket.readyState === WebSocket.OPEN) {
    try {
      const response = await site_fetch(`http://127.0.0.1:${local_settings(home).port || 8765}/api/updates`, { signal, headers: { accept: 'text/event-stream' } });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      const decoder = new TextDecoder();
      let buffer = '';
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true }).replaceAll('\r\n', '\n');
        for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (!/^event: change$/m.test(frame) || socket.readyState !== WebSocket.OPEN) continue;
          let rooms = null;
          try { rooms = JSON.parse(frame.match(/^data: (.*)$/m)?.[1] ?? '{}').rooms ?? null; } catch { /* Every room may have changed. */ }
          socket.send(JSON.stringify({ type: 'event', rooms }));
        }
      }
    } catch { /* Reconnect below; devices fall back to their own polling meanwhile. */ }
    await sleep(EVENT_RETRY_MS, undefined, { signal }).catch(() => {});
  }
}

/**
 * Answer the hosted accounts' entry traffic the relay hands over (`entry` frames, apart from the administrator's signed
 * requests). Each request goes only to this computer's sign-in entry on loopback, never anywhere the frame names, and
 * only while its owner chose this way in the panel (entry settings `mode: 'relay'`), so a tampered website cannot open
 * the channel on its own. The entry treats it like traffic from a tunnel: HTTPS outside, the browser's own Host.
 * Returns the frame handler; `send` puts a frame on the connection, `buffered` says how much it holds unsent.
 */
export function entry_proxy(home, { send, buffered = () => 0 }) {
  const open = new Map();
  const head = (id, status, headers = []) => send({ type: 'entry-head', id, status, headers });
  const refuse = (id, status, text) => {
    head(id, status, [['content-type', 'text/plain; charset=utf-8'], ['cache-control', 'no-store']]);
    send({ type: 'entry-data', id, data: Buffer.from(text).toString('base64') });
    send({ type: 'entry-end', id });
  };
  const forward = id => {
    const entry = open.get(id);
    const settings = entry_settings(home);
    if (settings.mode !== 'relay') { open.delete(id); return refuse(id, 503, '这台电脑没有开启线上中转'); }
    const body = Buffer.concat(entry.parts);
    const headers = {};
    for (const [name, value] of Array.isArray(entry.headers) ? entry.headers : []) {
      const key = String(name).toLowerCase();
      if (ENTRY_HOP_HEADERS.has(key)) continue;
      headers[key] = headers[key] === undefined ? String(value) : `${headers[key]}, ${value}`;
    }
    Object.assign(headers, { 'x-forwarded-proto': 'https', 'content-length': String(body.length) });
    const path = typeof entry.path === 'string' && entry.path.startsWith('/') && !entry.path.startsWith('//') ? entry.path : '/';
    const request = http.request({ host: '127.0.0.1', port: settings.port, method: String(entry.method || 'GET'), path, headers }, reply => {
      const kept = [];
      for (let index = 0; index < reply.rawHeaders.length; index += 2) {
        if (!ENTRY_HOP_HEADERS.has(reply.rawHeaders[index].toLowerCase())) kept.push([reply.rawHeaders[index], reply.rawHeaders[index + 1]]);
      }
      head(id, reply.statusCode, kept);
      // Hold the answer while the connection is behind, so a large file is not read into memory ahead of it.
      const drain = () => { if (buffered() > ENTRY_BUFFER_HIGH) { reply.pause(); setTimeout(() => { reply.resume(); drain(); }, ENTRY_BUFFER_CHECK_MS); } };
      reply.on('data', chunk => {
        for (let offset = 0; offset < chunk.length; offset += ENTRY_PART_BYTES) send({ type: 'entry-data', id, data: chunk.subarray(offset, offset + ENTRY_PART_BYTES).toString('base64') });
        drain();
      });
      reply.on('end', () => { open.delete(id); send({ type: 'entry-end', id }); });
      reply.on('error', () => { open.delete(id); send({ type: 'entry-end', id }); });
    });
    entry.request = request;
    request.on('error', () => { if (open.delete(id)) refuse(id, 502, '登录入口没有在运行'); });
    request.end(body);
  };
  return frame => {
    const id = frame.id;
    if (typeof id !== 'string') return;
    if (frame.type === 'entry-cancel') { open.get(id)?.request?.destroy(); open.delete(id); return; }
    const part = Buffer.from(String(frame.body || ''), 'base64');
    if (frame.type === 'entry') open.set(id, { method: frame.method, path: frame.path, headers: frame.headers, parts: [part], size: part.length });
    else if (frame.type === 'entry-body' && open.has(id)) { const entry = open.get(id); entry.parts.push(part); entry.size += part.length; }
    else return;
    const entry = open.get(id);
    if (entry.size > ENTRY_BODY_MAX_BYTES) { open.delete(id); return refuse(id, 413, '请求太大'); }
    if (!frame.more) forward(id);
  };
}

/** Hold one website's relay connection, reconnecting with backoff; `connected` tracks which websites are live. */
async function hold_channel(home, site, { connected, log, signal }) {
  let delay = RETRY_MIN_MS;
  while (!signal.aborted) {
    // Read the pairing each time: reconnecting the website replaces the token, and disconnecting removes it.
    const link = machine_links(home).sites[site];
    if (!link?.private_key) return;
    const url = `${site.replace(/^http/, 'ws')}/api/machines/${encodeURIComponent(link.id)}/relay`;
    const closed = new Promise(resolve => {
      let socket;
      try { socket = new WebSocket(url, [RELAY_PROTOCOL, `m.${link.token}`]); } catch { return resolve(false); }
      const events = new AbortController();
      let ping, finished = false;
      // The hosted accounts' entry traffic on this connection (entry_proxy).
      const entry = entry_proxy(home, { send: frame => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame)); },
        buffered: () => socket.bufferedAmount || 0 });
      // Only the first finish counts: a stalled socket may report its close long after its replacement connected.
      const finish = opened => {
        if (finished) return;
        finished = true;
        clearInterval(ping);
        events.abort();
        connected.delete(site);
        resolve(opened);
      };
      // Only a pong proves both directions work: requests can keep arriving while this computer's answers are stuck.
      // A website that never answers pings is not judged by them.
      let opened = false, awaiting_pong = false, pong_seen = false;
      socket.addEventListener('open', () => {
        opened = true;
        connected.add(site);
        log(`${site}: 中转已连接`);
        ping = setInterval(() => {
          if (socket.readyState !== WebSocket.OPEN) return;
          if (awaiting_pong && pong_seen) {
            log(`${site}: 中转心跳 ${PING_MS / 1000} 秒未回应，重新连接`);
            try { socket.close(4000, 'stalled'); } catch { /* Already closing. */ }
            return finish(opened);
          }
          awaiting_pong = true;
          socket.send('ping');
        }, PING_MS);
        forward_changes(home, socket, events.signal);
      });
      socket.addEventListener('message', async event => {
        if (event.data === 'pong') { awaiting_pong = false; pong_seen = true; return; }
        if (typeof event.data !== 'string') return;
        let frame;
        try { frame = JSON.parse(event.data); } catch { return; }
        if (typeof frame.type === 'string' && frame.type.startsWith('entry')) return entry(frame);
        if (frame.type !== 'request' || typeof frame.id !== 'string' || !frame.envelope) return;
        // Disconnecting or re-pairing the website ends this connection at once, not at its next reconnect.
        const current = machine_links(home).sites[site];
        if (current?.token !== link.token || current?.private_key?.d !== link.private_key?.d) {
          log(`${site}: 配对已撤销或更换，关闭中转连接`);
          return socket.close(1000, 'unpaired');
        }
        const received = Date.now();
        let kind = { action: '?', route: '', status: 0 };
        try {
          const answer = await answer_request(home, site, link, frame, { report: value => { kind = value; } });
          const answered = Date.now();
          const open = socket.readyState === WebSocket.OPEN;
          if (open) socket.send(JSON.stringify(answer));
          const label = `${kind.action}${kind.route ? ` ${kind.route}` : ''} → ${kind.status}`;
          if (!open) log(`${site}: 中转回应未送出（连接已断开）：${label}，处理 ${answered - received} ms`);
          else if (answered - received > SLOW_REQUEST_MS) log(`${site}: 中转请求较慢：${label}，处理 ${answered - received} ms`);
        } catch (error) { log(`${site}: 中转请求 ${frame.id} 无法处理（${Date.now() - received} ms）：${error.message}`); }
      });
      socket.addEventListener('close', event => {
        if (opened && !finished && !signal.aborted) log(`${site}: 中转连接断开（${event.code || '无代码'}${event.reason ? ` ${event.reason}` : ''}），稍后重连`);
        finish(opened);
      });
      socket.addEventListener('error', () => { try { socket.close(); } catch { /* Already closing. */ } });
      signal.addEventListener('abort', () => { try { socket.close(1000, 'stopping'); } catch { /* Already closed. */ } }, { once: true });
    });
    const opened = await closed;
    if (signal.aborted) return;
    // A website without the relay refuses the upgrade every time; back off fully so it is only asked now and then.
    delay = opened ? RETRY_MIN_MS : Math.min(delay * 2, RETRY_MAX_MS);
    await sleep(delay, undefined, { signal }).catch(() => {});
  }
}

/**
 * Keep a relay channel open to every paired website that has a command key; returns the set of websites currently
 * connected, so the D1 command queue can skip them. New pairings are picked up when `refresh` is called.
 */
export function start_relay_channels(home, { log = () => {}, signal }) {
  const connected = new Set(), held = new Map();
  const refresh = () => {
    for (const [site, link] of Object.entries(machine_links(home).sites)) {
      if (!link.private_key || held.has(site)) continue;
      held.set(site, hold_channel(home, site, { connected, log, signal }).finally(() => held.delete(site)));
    }
  };
  refresh();
  return { connected, refresh, done: () => Promise.all(held.values()) };
}

export { RELAY_PROTOCOL };

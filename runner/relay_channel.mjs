/**
 * Keep one hibernating WebSocket per paired website so the administrator's devices reach this computer at once:
 * each encrypted request is answered here, room reads and writes go to the local website with this computer's bridge
 * credential, and the local website's change notices are passed on. The website only ever forwards ciphertext.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { gzipSync } from 'node:zlib';

import { atomic_json } from './files.mjs';
import { acquire_lock } from './discussion_runner.mjs';
import { local_settings } from './discussion_setup.mjs';
import { machine_links, relay_cipher, save_machine_links, relayed_command, ROOM_ACTIONS, run_launch_command, sync_remote_launches, unseal } from './remote_launch.mjs';
import { claim_relayed_command } from './remote_policy.mjs';
import { audit, DEVICE_ACTIONS, device_command, open_signed_request, write_allowed, write_needed } from './device_auth.mjs';

const RELAY_PROTOCOL = 'codiscuss-relay';
const BRIDGE_TOKEN_BYTES = 32;
const RETRY_MIN_MS = 2000;
const RETRY_MAX_MS = 60000;
const PING_MS = 25000;
// The site gives up on a request after 9 seconds, so the local website must answer before then.
const LOCAL_TIMEOUT_MS = 8000;
const EVENT_RETRY_MS = 3000;
// Diagnostics: a request answered slower than this, or not delivered, is written to the service log (action and route only).
const SLOW_REQUEST_MS = 3000;
// A connection whose keep-alive has gone unanswered this long is reported once; the website would have dropped it.
const HEARTBEAT_LATE_MS = 2 * PING_MS + 5000;
// A WebSocket frame on the website is at most 1 MiB; leave room for the envelope around the ciphertext.
const RESPONSE_MAX_BYTES = 700 * 1024;
const ROOM_API_PATH = /^\/api\/(rooms|folders|revisions)(\/[A-Za-z0-9_.~-]+)*(\?[A-Za-z0-9_.~%=&,:+-]*)?$/;
const WRITE_ROOM_PATH = /^\/api\/rooms\/([A-Za-z0-9_.~-]+)\//;
// Members with these levels can change files or run commands on this computer.
const WRITING_ACCESS = new Set(['write', 'auto', 'full', 'own']);
// Attachment uploads arrive in parts and are sent to the local website whole, as one browser upload would be.
const UPLOAD_PATH = /^\/api\/rooms\/[A-Za-z0-9_-]+\/attachments(\/[A-Za-z0-9_-]+\/import)?(\?[A-Za-z0-9_.~%=&,:+-]*)?$/;
const UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
const UPLOAD_TTL_MS = 10 * 60 * 1000;
const uploads = new Map();

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
  // A website that was disconnected has no entry, and reconnecting replaces it; either way no bridge is granted here.
  if (settings.sites[site] && settings.sites[site].bridge_hash !== hashed) {
    const release = acquire_lock(join(home, 'connection-lock'));
    try {
      const latest = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { sites: {} };
      if (latest.sites[site]) atomic_json(path, { ...latest, sites: { ...latest.sites, [site]: { ...latest.sites[site], bridge_hash: hashed } } });
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
export async function room_api(home, site, payload, { fetcher = fetch, device } = {}) {
  const { method = 'GET', path, body, token, offset = 0 } = payload || {};
  if (!['GET', 'POST'].includes(method) || typeof path !== 'string' || !ROOM_API_PATH.test(path) || path.includes('..')
      || !Number.isSafeInteger(offset) || offset < 0) {
    return { status: 400, body: { error: '中转请求地址无效' } };
  }
  // Writing to a room whose members may change files here needs this device's passkey-confirmed grant; stopping does not.
  const room = method === 'POST' ? path.match(WRITE_ROOM_PATH)?.[1] : null;
  if (device !== undefined && room && !/\/(interrupt|stop)(\?|$)/.test(path) && room_writes(home, room) && !write_allowed(home, device, room)) {
    const needed = write_needed(room);
    return { status: 403, body: { error: needed.message, need: needed.need, room_id: room } };
  }
  const headers = bridge_headers(home, site);
  if (typeof token === 'string' && token) headers['X-Discussion-Token'] = token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetcher(`${local_origin(home)}${path}`, { method, headers, redirect: 'error',
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(LOCAL_TIMEOUT_MS) });
  const type = response.headers.get('Content-Type') || '';
  if (type.startsWith('application/json')) return { status: response.status, body: await response.json() };
  // A file larger than one frame comes back in parts; the device asks again from where the previous part ended.
  const bytes = Buffer.from(await response.arrayBuffer());
  return { status: response.status, content_type: type, offset, total: bytes.length,
    body_base64: bytes.subarray(offset, offset + RESPONSE_MAX_BYTES).toString('base64') };
}

/** Whether a room this computer runs has a member allowed to change files or run commands. */
function room_writes(home, room_id) {
  const path = join(home, 'rooms.json');
  const configs = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).configs ?? [] : [];
  for (const config_path of configs) {
    try {
      const config = JSON.parse(readFileSync(config_path, 'utf8'));
      // A member without its own level takes the room's, as the runner does when it starts the member.
      // Approved tools count too: a shell approved for a read-only member still changes files.
      if (config.room === room_id) return Object.values(config.participants || {}).some(profile =>
        WRITING_ACCESS.has(profile?.project_access || config.project_access) || profile?.allowed_tools?.length > 0);
    } catch { /* A broken configuration starts nothing. */ }
  }
  return false;
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
export async function room_upload(home, site, payload, { fetcher = fetch, now = Date.now() } = {}) {
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
        : await run({ ...(target === 'computer' ? computer_command(home, site, action, payload) : relayed_command(site, action, payload)), device });
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
      const response = await fetch(`http://127.0.0.1:${local_settings(home).port || 8765}/api/updates`, { signal, headers: { accept: 'text/event-stream' } });
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
      let ping;
      const finish = opened => { clearInterval(ping); events.abort(); connected.delete(site); resolve(opened); };
      let opened = false, heard = Date.now(), late = false;
      socket.addEventListener('open', () => {
        opened = true;
        heard = Date.now();
        connected.add(site);
        log(`${site}: 中转已连接`);
        ping = setInterval(() => {
          if (socket.readyState !== WebSocket.OPEN) return;
          const silent = Date.now() - heard;
          if (silent > HEARTBEAT_LATE_MS && !late) { late = true; log(`${site}: 中转心跳超时，${Math.round(silent / 1000)} 秒未收到网站回应`); }
          socket.send('ping');
        }, PING_MS);
        forward_changes(home, socket, events.signal);
      });
      socket.addEventListener('message', async event => {
        if (late) log(`${site}: 中转心跳恢复`);
        heard = Date.now();
        late = false;
        if (typeof event.data !== 'string' || event.data === 'pong') return;
        let frame;
        try { frame = JSON.parse(event.data); } catch { return; }
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
        if (opened && !signal.aborted) log(`${site}: 中转连接断开（${event.code || '无代码'}${event.reason ? ` ${event.reason}` : ''}），稍后重连`);
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

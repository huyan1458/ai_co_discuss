/**
 * Keep one hibernating WebSocket per paired website so the administrator's devices reach this computer at once:
 * each encrypted request is answered here, room reads and writes go to the local website with this computer's bridge
 * credential, and the local website's change notices are passed on. The website only ever forwards ciphertext.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import timers from 'node:timers/promises';
import { gzipSync } from 'node:zlib';

import { network_event, network_code, relay_outcome, device_feedback, http_result } from './network_log.mjs';
import { accept_timing, remember_timing } from './relay_timing.mjs';
import { atomic_json } from './files.mjs';
import { network_failure, reconnect_reader } from './relay_health.mjs';
import { t } from './i18n.mjs';
import { granted_projects, room_share_job, remote_execution_details, remote_room_files, remote_room_media, remote_room_page } from './discussion_launch.mjs';
import { acquire_lock } from './discussion_runner.mjs';
import { local_settings } from './discussion_setup.mjs';
import { machine_links, relay_cipher, save_machine_links, relayed_command, ROOM_ACTIONS, run_launch_command, synced_relay_region, sync_remote_launches, unseal } from './remote_launch.mjs';
import { claim_relayed_command, guard_remote_directories } from './remote_policy.mjs';
import { audit, DEVICE_ACTIONS, device_command, open_signed_request } from './device_auth.mjs';
import { answer_external, INVITE_COMMANDS, is_external_request, refresh_guest_entries } from './external_gateway.mjs';
import { site_fetch } from './entry_client.mjs';
import { entry_settings } from '../gateway/gateway.mjs';
import { LOCAL_CLOUD_SHARE } from '../backend/cloud_share_routes.mjs';

const RELAY_PROTOCOL = 'codiscuss-relay';
const BRIDGE_TOKEN_BYTES = 32;
const RETRY_MIN_MS = 2000;
const RETRY_MAX_MS = 30_000;
const CONNECT_TIMEOUT_MS = 10_000;
const WATCHDOG_MS = 180_000;
// Five unanswered probes over 75 seconds tolerate transient latency without leaving a half-open uplink forever.
// Business frames prove only the downlink; only pong proves a round trip.
const PING_MS = 15000;
const SILENCE_MS = 75000;
const MISSED_PINGS = 5;
const TIMER_DELAY_MS = PING_MS * 2;
// The site gives up on a request after 9 seconds, so the local website must answer before then.
const LOCAL_TIMEOUT_MS = 8000;
const EVENT_RETRY_MS = 3000;
const FULL_RELAY_READ_TIMING = process.env.CODISCUSS_RELAY_READ_TIMING === '1';
// A WebSocket frame on the website is at most 1 MiB; leave room for the envelope around the ciphertext.
const RESPONSE_MAX_BYTES = 700 * 1024;
// The website closes the whole connection on a frame over 1 MiB, failing every request on it; a larger answer is
// replaced by an error so only that request fails.
const FRAME_MAX_BYTES = 1024 * 1024 - 1024;
const ROOM_API_PATH = /^\/api\/(rooms|folders|revisions|sites|analytics)(\/[A-Za-z0-9_.~-]+)*(\?[A-Za-z0-9_.~%=&,:+-]*)?$/;
const PROJECT_CLOUD = 'project-files/cloud';
const PROJECT_CLOUD_STATUS = /^project-files\/cloud\/[a-f0-9]{32}$/;
const PROJECT_CLOUD_WRITES = new Map([['project-cloud', PROJECT_CLOUD],
  ['project-cloud-upload', `${PROJECT_CLOUD}-upload`], ['project-cloud-land', `${PROJECT_CLOUD}-land`]]);
const PROJECT_CLOUD_POST_PATHS = new Set(PROJECT_CLOUD_WRITES.values());

function project_cloud_method(action) {
  return PROJECT_CLOUD_POST_PATHS.has(action) ? 'POST' : PROJECT_CLOUD_STATUS.test(action) ? 'GET' : '';
}
const RELAY_READ_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// Attachment uploads arrive in parts and are sent to the local website whole, as one browser upload would be.
const UPLOAD_PATH = /^\/api\/rooms\/[A-Za-z0-9_-]+\/attachments(\/[A-Za-z0-9_-]+\/(import|thumbnail))?(\?[A-Za-z0-9_.~%=&,:+-]*)?$/;
import { attachment_limit, policy } from './attachment_policy.mjs';
const UPLOAD_TTL_MS = 10 * 60 * 1000;
const uploads = new Map();
// Answers of uploads already handed to the local website, by upload id, kept as long as unfinished uploads are.
const finished_uploads = new Map();
// The hosted accounts' entry over the relay (backend/entry_worker.mjs): answer parts per frame (sent as base64 within the
// 1 MiB frame), the largest request taken, and when to pause reading an answer the connection has not sent on yet.
const ENTRY_PART_BYTES = 512 * 1024;

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
  const relay_site = Object.keys(links.sites).find(key => links.sites[key]?.id && links.sites[key]?.private_key);
  const settings = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { sites: {} };
  // The entry also tells the local website that this site reaches it only through the relay, so a browser connection
  // credential kept from before no longer works. A website disconnected meanwhile has lost its pairing: no bridge then.
  if (settings.sites[site]?.bridge_hash !== hashed || settings.sites[site]?.machine_id !== link.id || settings.relay_site !== relay_site) {
    const release = acquire_lock(join(home, 'connection-lock'));
    try {
      const latest = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { sites: {} };
      if (machine_links(home).sites[site]) atomic_json(path, { ...latest, relay_site, sites: { ...latest.sites,
        [site]: { ...latest.sites[site], bridge_hash: hashed, machine_id: link.id } } });
    } finally { release(); }
  }
  return link.bridge_token;
}

/** Encrypt a compressed answer bound to its request, so the website cannot swap one answer into another request. */
export async function seal_compressed(key, value, label) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(label) }, key,
    gzipSync(Buffer.from(JSON.stringify(value))));
  return { iv: Buffer.from(iv).toString('base64'), data: Buffer.from(data).toString('base64'), encoding: 'gzip' };
}

/** Return a room read category without retaining its path or query. */
function relay_read_route(payload) {
  if ((payload?.method ?? 'GET') !== 'GET' || typeof payload?.path !== 'string') return '';
  const path = payload.path.split('?', 1)[0];
  if (/\/attachments\/[^/]+\/(content|thumbnail)$/.test(path)) return path.endsWith('/thumbnail') ? 'thumbnail' : 'attachment';
  if (path.endsWith('/room-media')) return 'room-media';
  if (path === '/api/rooms') return 'directory';
  if (/^\/api\/rooms\/[A-Za-z0-9_-]+$/.test(path)) return 'room';
  if (/^\/api\/rooms\/[A-Za-z0-9_-]+\/messages$/.test(path)) return 'messages';
  return '';
}

/** Write phase offsets from frame receipt without recording the frame or request data. */
function log_relay_read(home, site, timing, status, buffered_bytes) {
  if (!FULL_RELAY_READ_TIMING) return;
  const offset = (at) => at === undefined ? null : Math.round(at - timing.received_at);
  try {
    network_event(home, site, 'relay_read', { request_id: timing.id, route: timing.route, status, received_ms: 0,
      local_request_ms: offset(timing.local_request_at), local_response_ms: offset(timing.local_response_at),
      sent_ms: offset(timing.sent_at), frame_bytes: timing.frame_bytes ?? null, buffered_bytes });
  } catch { /* A failed diagnostic write must not interrupt the relay. */ }
}

/**
 * Read or write one room route on the local website as this computer's bridge. Only room, folder and revision routes
 * of the local website itself are reachable; the device cannot name another address. Binary content comes back as base64.
 */
export async function room_api(home, site, payload, { fetcher = site_fetch, device, timing } = {}) {
  const { method = 'GET', path, body, token, offset = 0, etag } = payload || {};
  const cloud = typeof path === 'string' && path.startsWith('/api/local/') ? project_cloud_method(path.slice('/api/local/'.length)) : '';
  if (!['GET', 'POST'].includes(method) || typeof path !== 'string' || !(ROOM_API_PATH.test(path) || cloud === method) || path.includes('..')
      || !Number.isSafeInteger(offset) || offset < 0) {
    return { status: 400, body: { error: '中转请求地址无效' } };
  }
  const headers = bridge_headers(home, site);
  if (cloud) headers['X-CoDiscuss-Local'] = '1';
  await guard_folder_directories(home, path, method, body, { fetcher, headers });
  if (typeof token === 'string' && token) headers['X-Discussion-Token'] = token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  // A read the device already holds is asked conditionally; unchanged, the answer is a bare 304 with no body.
  if (method === 'GET' && typeof etag === 'string' && /^"[0-9a-f]{1,64}"$/.test(etag)) headers['If-None-Match'] = etag;
  // An attachment's bytes and a zip entry are asked from the local website for the part needed alone, not whole for
  // every part (a 20 MB PDF read in pieces would read 20 MB per piece).
  const ranged = method === 'GET' && /^\/api\/rooms\/[\w-]+\/attachments\/[\w-]+\/(zip\?entry=|(content|thumbnail)$)/.test(path);
  if (ranged) headers.Range = 'bytes=' + offset + '-' + (offset + RESPONSE_MAX_BYTES - 1);
  const on_request = timing?.route ? () => { timing.local_request_at = performance.now(); } : undefined;
  if (on_request) headers['X-CoDiscuss-Relay-Request-Id'] = timing.id;
  const response = await fetcher(`${local_origin(home)}${path}`, { method, headers, redirect: 'error',
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(LOCAL_TIMEOUT_MS) }, { on_request });
  const tag = response.headers.get('ETag');
  if (response.status === 304) return { status: 304, etag: tag || etag };
  const type = response.headers.get('Content-Type') || '';
  if (type.startsWith('application/json')) {
    const result = await response.json();
    const mutation = method === 'POST' && /^\/api\/rooms\/([\w-]+)\/guest\/(?:extend|disconnect|admit)$/.exec(path);
    if (mutation && response.ok && result?.ok && await refresh_guest_entries(home, { rooms: [mutation[1]], fetcher })) await sync_remote_launches(home);
    return { status: response.status, body: result, ...(tag ? { etag: tag } : {}) };
  }
  // A file larger than one frame comes back in parts; the device asks again from where the previous part ended.
  const bytes = Buffer.from(await response.arrayBuffer());
  // Asked from past the end (an empty file): no bytes, and the size the website gives.
  if (ranged && response.status === 416) {
    return { status: 200, content_type: type, offset, total: Number(/\/(\d+)$/.exec(response.headers.get('Content-Range') || '')?.[1] || 0), body_base64: '' };
  }
  if (ranged && response.status === 206) {
    const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('Content-Range') || '');
    if (!range || Number(range[1]) !== offset || Number(range[2]) - offset + 1 !== bytes.length
        || Number(range[3]) <= Number(range[2])) throw new Error(t('无法读取这个压缩包条目'));
    return { status: 206, content_type: type, offset, total: Number(range[3]), body_base64: bytes.toString('base64') };
  }
  return { status: response.status, content_type: type, offset, total: bytes.length,
    body_base64: bytes.subarray(offset, offset + RESPONSE_MAX_BYTES).toString('base64') };
}

/**
 * A group's project paths set from another device: a new one must lie inside the saved projects, while the paths the
 * group already has may stay or be removed. Room creation from the group relies on this (`kept_directories`).
 */
async function guard_folder_directories(home, path, method, body, { fetcher, headers }) {
  const target = /^\/api\/folders(?:\/([A-Za-z0-9_-]+)\/rename)?$/.exec(path.split('?', 1)[0]);
  if (method !== 'POST' || !target || !Array.isArray(body?.directories)) return;
  let kept = [];
  if (target[1]) {
    const response = await fetcher(`${local_origin(home)}/api/rooms`, { headers, redirect: 'error', signal: AbortSignal.timeout(LOCAL_TIMEOUT_MS) });
    if (!response.ok) throw new Error(t('无法读取分组的项目路径'));
    kept = ((await response.json()).folders || []).find(folder => folder.id === target[1])?.directories || [];
  }
  guard_remote_directories(body.directories, { projects: granted_projects(home), home, kept });
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
 * the bridge. Parts may arrive in any order and be resent; an unfinished upload answers which parts it still lacks and
 * is dropped after ten minutes. A part resent after the file was handed on (its answer lost on the way) gets that same
 * answer, so the device does not start the file over.
 */
export async function room_upload(home, site, payload, { fetcher = site_fetch, now = Date.now() } = {}) {
  const { id, path, index, total, size, content_type = 'application/octet-stream', data } = payload || {};
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{16,80}$/.test(id) || typeof path !== 'string' || !UPLOAD_PATH.test(path)
      || !Number.isSafeInteger(total) || total < 1 || !Number.isSafeInteger(index) || index < 0 || index >= total
      || !Number.isSafeInteger(size) || size < 0 || size > attachment_limit(home) * 1024 * 1024 || typeof data !== 'string' || typeof content_type !== 'string') {
    return { status: 400, body: { error: '附件上传请求无效' } };
  }
  for (const store of [uploads, finished_uploads]) for (const [key, item] of store) if (now - item.at > UPLOAD_TTL_MS) store.delete(key);
  const finished = finished_uploads.get(id);
  if (finished) return finished.path === path ? finished.answer : { status: 400, body: { error: '附件上传请求无效' } };
  const upload = uploads.get(id) ?? { path, total, size, parts: [], at: now };
  if (upload.path !== path || upload.total !== total || upload.size !== size) return { status: 400, body: { error: '附件上传请求无效' } };
  const part = Buffer.from(data, 'base64');
  const received = (upload.received || 0) - (upload.parts[index]?.length || 0) + part.length;
  if (received > size || total > Math.ceil(size / (64 * 1024)) + 1) return { status: 400, body: { error: '附件上传请求无效' } };
  upload.received = received;
  upload.parts[index] = part;
  upload.at = now;
  uploads.set(id, upload);
  const missing = [];
  for (let part = 0; part < total; part++) if (!upload.parts[part]) missing.push(part);
  if (missing.length) return { status: 200, body: { received: total - missing.length, missing } };
  uploads.delete(id);
  const bytes = Buffer.concat(upload.parts);
  if (bytes.length !== size) return { status: 400, body: { error: '附件不完整，请重新上传' } };
  // Kept while the hand-over runs, so a part resent meanwhile waits for the same answer.
  const started = Date.now();
  const answer = fetcher(`${local_origin(home)}${path}`, { method: 'POST', redirect: 'error', body: bytes,
    headers: { ...bridge_headers(home, site), 'Content-Type': content_type }, signal: AbortSignal.timeout(LOCAL_TIMEOUT_MS) })
    .then(async (response) => ({ status: response.status, body: await response.json() }));
  finished_uploads.set(id, { path, at: now, answer });
  try {
    const result = await answer;
    http_result(home, site, 'upload', Date.now() - started, result.status >= 400 ? { status: result.status } : null);
    // A refused file is not kept: sending it again is a new attempt.
    if (result.status >= 400) finished_uploads.delete(id);
    return result;
  } catch (error) {
    finished_uploads.delete(id);
    http_result(home, site, 'upload', Date.now() - started, error);
    throw error;
  }
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
  // An invite made from a paired device sends the invitee to the website that device uses.
  if (INVITE_COMMANDS.has(action) && !input.site_url) input.site_url = site;
  return relayed_command(room?.site ?? local_origin(home), action, input);
}

/**
 * Run one local operation; browsing project files, reading an HTML page and a turn's steps are answered in this
 * process, since they are asked for on every folder opened, page part or private-chat poll.
 */
async function run_command(home, command, run) {
  if (run !== run_launch_command) return run(command);
  if (command.command === 'share-job') return { status: 200, body: await room_share_job(home, command.input, { trust: true }) };
  if (command.command === 'room-files') return { status: 200, body: await remote_room_files(home, command.input) };
  if (command.command === 'room-page') return { status: 200, body: await remote_room_page(home, command.input) };
  if (command.command === 'room-media') return { status: 200, body: await remote_room_media(home, command.input) };
  if (command.command === 'execution-details') return { status: 200, body: await remote_execution_details(home, command.input) };
  return run(command);
}

/** Answer one relayed request: room routes and uploads go to the local website, everything else to the local entrypoint as before. */
export async function answer_request(home, site, link, frame, { run = run_launch_command, fetcher, report, timing } = {}) {
  const started = timing?.received_at ?? performance.now();
  const { id, envelope } = frame;
  const key = await relay_cipher(link.private_key, envelope.key);
  const sealed = await unseal(key, envelope, id);
  let response, request = {}, device = null;
  async function finish_response(value) {
    const label = `${id}:response`;
    let envelope = await seal_compressed(key, value, label);
    let answer = { type: 'response', id, envelope };
    let frame_bytes = Buffer.byteLength(JSON.stringify(answer));
    if (frame_bytes > FRAME_MAX_BYTES) {
      value = { status: 413, body: { error: '回应超过中转单帧上限，未能送出' } };
      report?.({ action: request.action, route: '', status: 413 });
      envelope = await seal_compressed(key, value, label);
      answer = { type: 'response', id, envelope, oversized: true };
      frame_bytes = Buffer.byteLength(JSON.stringify({ type: 'response', id, envelope }));
    }
    const elapsed = Math.round(performance.now() - started);
    const action = request.action;
    const category = action === 'room-api' ? relay_read_route(request.payload) || 'room-api'
      : ROOM_ACTIONS.has(action) || DEVICE_ACTIONS.has(action) || ['computer-site', 'room-upload', 'room-media'].includes(action) ? action : 'other';
    if (request.timing_version === 1 && action !== 'timing-report') {
      // Seal the small measurement separately, after the business response has been compressed and encrypted.
      try {
        const diagnostic = await seal_compressed(key, { computer_ms: elapsed, category }, `${id}:timing`);
        const extra_bytes = Buffer.byteLength(JSON.stringify(diagnostic)) + ',"timing":'.length;
        if (frame_bytes + extra_bytes <= FRAME_MAX_BYTES) {
          envelope.timing = diagnostic;
          frame_bytes += extra_bytes;
        }
      } catch { /* A failed timing attachment must not hide a completed operation. */ }
    }
    if (action !== 'timing-report') {
      const measurement = timing ?? {};
      Object.assign(measurement, { category, device, local_ms: elapsed });
      measurement.frame_bytes = frame_bytes;
      remember_timing(home, site, device, id, category, elapsed, value.status, measurement);
    }
    return answer;
  }
  // An external member's request (or an invite being redeemed) goes to the external gateway alone: it never reaches the
  // device actions, the local entrypoint or the bridge, and never gains this computer's owner credential.
  if (is_external_request(sealed)) {
    ({ request, response } = await answer_external(home, { machine_id: link.id, link, fetcher, on_change: () => sync_remote_launches(home) }, id, sealed));
    report?.({ action: request.action, route: '', status: response.status });
    return finish_response(response);
  }
  try {
    // Only a paired device's signed request runs; an unpaired browser may only prove a pairing code.
    const opened = await open_signed_request(home, id, sealed, link.id);
    request = opened.request;
    const { action, payload, target } = request;
    const cloud_action = PROJECT_CLOUD_WRITES.get(action)
      ?? (action === 'project-cloud-status' ? `${PROJECT_CLOUD}/${payload?.task_id}` : action);
    const cloud_method = project_cloud_method(cloud_action);
    if (timing && action === 'room-api' && RELAY_READ_ID.test(id)) timing.route = relay_read_route(payload);
    claim_relayed_command(home, id, request.sent_at);
    device = opened.device_id;
    device_feedback(home, site, device, request.timing_reports);
    accept_timing(home, site, device, request.timing_reports);
    response = action === 'timing-report' && device ? { status: 200, body: {} } : DEVICE_ACTIONS.has(action) ? await device_command(home, { site, machine_id: link.id, device_id: device, on_change: () => sync_remote_launches(home) }, action, payload)
      : action === 'computer-site' ? { status: 200, body: { site: local_origin(home) } }
      : cloud_method ? await room_api(home, site, { method: cloud_method, path: `/api/local/${cloud_action}`, ...(cloud_method === 'POST' ? { body: payload } : {}) }, { fetcher, device })
      : action === 'room-api' ? await room_api(home, site, payload, { fetcher, device, timing })
      : action === 'room-upload' ? await room_upload(home, site, payload, { fetcher })
        : await run_command(home, { ...(target === 'computer' ? computer_command(home, site, action, payload) : relayed_command(site, action, payload)), device }, run);
    if (timing?.local_request_at !== undefined) timing.local_response_at = performance.now();
  } catch (error) {
    if (timing && (error.cause || error.name === 'TimeoutError')) timing.transport = network_code(error);
    response = { status: 400, body: { error: error.message, ...(error.need ? { need: error.need } : {}), ...(error.error_text ? { error_text: error.error_text } : {}) } }; }
  // Remote writes go to this computer's audit log: kind, route, device and outcome, never content. Reads are not logged.
  if (request.action && request.action !== 'timing-report' && request.action !== 'project-cloud-status' && project_cloud_method(request.action) !== 'GET' && !(request.action === 'room-api' && (request.payload?.method || 'GET') === 'GET') && !DEVICE_ACTIONS.has(request.action) && request.action !== 'computer-site') {
    audit(home, { event: 'command', action: request.action, route: typeof request.payload?.path === 'string' ? request.payload.path.split('?')[0] : '',
      device: sealed.device_id || null, status: response.status });
  }
  // Only what kind of request it was and how it ended: never its content or query.
  report?.({ action: request.action, route: typeof request.payload?.path === 'string' ? request.payload.path.split('?')[0] : '', status: response.status });
  return finish_response(response);
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
          if (await refresh_guest_entries(home, { rooms: Array.isArray(rooms) ? rooms : null })) await sync_remote_launches(home);
        }
      }
    } catch { /* Reconnect below; devices fall back to their own polling meanwhile. */ }
    await timers.setTimeout(EVENT_RETRY_MS, undefined, { signal }).catch(() => {});
  }
}

/**
 * Answer the hosted accounts' entry traffic the relay hands over (`entry` frames, apart from the administrator's signed
 * requests). Each request goes only to this computer's sign-in entry on loopback, never anywhere the frame names, and
 * only while its owner chose this way in the panel (entry settings `relay_enabled`), so a tampered website cannot open
 * the channel on its own. The entry treats it like traffic from a tunnel: HTTPS outside, the browser's own Host.
 * Returns the frame handler; `send` puts a frame on the connection, `buffered` says how much it holds unsent.
 */
export function entry_proxy(home, { send, buffered = () => 0, signal }) {
  const open = new Map();
  signal?.addEventListener('abort', () => {
    for (const entry of open.values()) entry.request?.destroy();
    open.clear();
  }, { once: true });
  const head = (id, status, headers = []) => send({ type: 'entry-head', id, status, headers });
  const refuse = (id, status, text) => {
    head(id, status, [['content-type', 'text/plain; charset=utf-8'], ['cache-control', 'no-store']]);
    send({ type: 'entry-data', id, data: Buffer.from(text).toString('base64') });
    send({ type: 'entry-end', id });
  };
  const forward = id => {
    const entry = open.get(id);
    const settings = entry.cloud_share ? null : entry_settings(home);
    if (settings && !settings.relay_enabled) { open.delete(id); return refuse(id, 503, '这台电脑没有开启线上中转'); }
    const body = Buffer.concat(entry.parts);
    const headers = {};
    for (const [name, value] of Array.isArray(entry.headers) ? entry.headers : []) {
      const key = String(name).toLowerCase();
      if (ENTRY_HOP_HEADERS.has(key) || entry.cloud_share && key !== 'accept-language') continue;
      headers[key] = headers[key] === undefined ? String(value) : `${headers[key]}, ${value}`;
    }
    Object.assign(headers, { 'x-forwarded-proto': 'https', 'content-length': String(body.length) });
    const path = typeof entry.path === 'string' && entry.path.startsWith('/') && !entry.path.startsWith('//') ? entry.path : '/';
    if (entry.cloud_share && (entry.method !== 'GET' || body.length !== 0 || !LOCAL_CLOUD_SHARE.test(path))) {
      open.delete(id);
      return refuse(id, 404, '');
    }
    const port = entry.cloud_share ? local_settings(home).port || 8765 : settings.port;
    const request = http.request({ host: '127.0.0.1', port, method: String(entry.method || 'GET'), path, headers }, reply => {
      const kept = [];
      for (let index = 0; index < reply.rawHeaders.length; index += 2) {
        if (!ENTRY_HOP_HEADERS.has(reply.rawHeaders[index].toLowerCase())) kept.push([reply.rawHeaders[index], reply.rawHeaders[index + 1]]);
      }
      head(id, reply.statusCode, kept);
      // Hold the answer while the connection is behind, so a large file is not read into memory ahead of it.
      const drain = () => { if (!reply.destroyed && !signal?.aborted && buffered() > ENTRY_BUFFER_HIGH) { reply.pause(); setTimeout(() => { reply.resume(); drain(); }, ENTRY_BUFFER_CHECK_MS); } };
      reply.on('data', chunk => {
        for (let offset = 0; offset < chunk.length; offset += ENTRY_PART_BYTES) send({ type: 'entry-data', id, data: chunk.subarray(offset, offset + ENTRY_PART_BYTES).toString('base64') });
        drain();
      });
      reply.on('end', () => { open.delete(id); send({ type: 'entry-end', id }); });
      reply.on('error', () => { open.delete(id); send({ type: 'entry-end', id }); });
    });
    entry.request = request;
    request.on('error', () => {
      if (open.delete(id)) refuse(id, entry.cloud_share ? 503 : 502, entry.cloud_share ? '' : '登录入口没有在运行');
    });
    request.end(body);
  };
  return frame => {
    const id = frame.id;
    if (typeof id !== 'string') return;
    if (frame.type === 'entry-cancel') { open.get(id)?.request?.destroy(); open.delete(id); return; }
    const part = Buffer.from(String(frame.body || ''), 'base64');
    if (frame.type === 'entry') open.set(id, { method: frame.method, path: frame.path, headers: frame.headers,
      cloud_share: frame.cloud_share === true, parts: [part], size: part.length });
    else if (frame.type === 'entry-body' && open.has(id)) { const entry = open.get(id); entry.parts.push(part); entry.size += part.length; }
    else return;
    const entry = open.get(id);
    if (entry.size > (attachment_limit(home) + policy.entry_overhead_mib) * 1024 * 1024) { open.delete(id); return refuse(id, 413, '请求太大'); }
    if (!frame.more) forward(id);
  };
}

/** Hold one website's relay connection, reconnecting with backoff; `connected` tracks which websites are live. */
async function hold_channel(home, site, { connected, log, signal, health, watch }) {
  let delay = RETRY_MIN_MS, retries = 0, retry_since;
  while (!signal.aborted) {
    // Read the pairing each time: reconnecting the website replaces the token, and disconnecting removes it.
    const link = machine_links(home).sites[site];
    if (!link?.private_key) return;
    if (retry_since !== undefined) network_event(home, site, 'reconnect', { attempt: ++retries, interval_ms: Date.now() - retry_since });
    health?.attempt(site, link.id);
    const url = `${site.replace(/^http/, 'ws')}/api/machines/${encodeURIComponent(link.id)}/relay`;
    const attempt_at = Date.now();
    const closed = new Promise(resolve => {
      let socket;
      try { socket = new WebSocket(url, [RELAY_PROTOCOL, `m.${link.token}`]); }
      catch (error) {
        const code = network_code(error);
        network_event(home, site, 'connect_failed', { initiator: 'local', reason: 'open_failed', code, close_code: null, duration_ms: Date.now() - attempt_at });
        if (!retries) log(t('{site} 中转连接已中断（{reason}）', { site: new URL(site).origin, reason: code }));
        health?.channel(site, link.id, 'failed', { kind: network_failure(error) });
        return resolve(false);
      }
      const events = new AbortController();
      let ping, finished = false;
      const stop_socket = () => {
        finish(opened, { kind: ['watchdog', 'manual'].includes(signal.reason) ? signal.reason : 'stopping', initiator: 'local', code: 1000 });
        try { socket.close(1000, 'stopping'); } catch { /* Already closed. */ }
      };
      const handshake = setTimeout(() => {
        finish(false, { kind: 'timeout', initiator: 'local' });
        try { socket.close(); } catch { /* Already closed. */ }
      }, CONNECT_TIMEOUT_MS);
      // The hosted accounts' entry traffic on this connection (entry_proxy).
      const entry = entry_proxy(home, { signal: events.signal, send: frame => { if (!events.signal.aborted && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame)); },
        buffered: () => socket.bufferedAmount || 0 });
      // Only the first finish counts: a stalled socket may report its close long after its replacement connected.
      const finish = (opened, failure) => {
        if (finished) return;
        finished = true;
        const reason = failure?.kind || 'unknown';
        network_event(home, site, opened ? 'disconnected' : 'connect_failed', {
          initiator: failure?.initiator || 'unknown', reason: failure?.close_reason || reason, close_code: failure?.code || null,
          code: failure?.transport || null, duration_ms: Date.now() - (opened_at ?? attempt_at)
        });
        if (!signal.aborted && (pong_seen || !retries) && reason !== 'heartbeat') log(t('{site} 中转连接已中断（{reason}）', { site: new URL(site).origin, reason: failure?.transport || reason }));
        clearTimeout(handshake);
        clearInterval(ping);
        signal.removeEventListener('abort', stop_socket);
        events.abort();
        connected.delete(site);
        if (!signal.aborted) {
          watch(false);
          health?.channel(site, link.id, opened ? 'reconnecting' : 'failed', failure);
        }
        resolve(pong_seen);
      };
      let opened_at, opened = false, awaiting_pong = false, pong_seen = false, backlogged = false;
      let last_pong = 0, probe_started = 0, last_ping = null, missed_pings = 0, previous_buffer = 0, buffer_progress = 0;
      socket.addEventListener('open', () => {
        if (finished || signal.aborted) return;
        clearTimeout(handshake);
        opened = true;
        try { bridge_token(home, site); } catch { /* An ordinary relayed request can retry writing the connection metadata. */ }
        opened_at = Date.now();
        last_pong = probe_started = buffer_progress = Date.now();
        health?.channel(site, link.id, 'confirming');
        connected.add(site);

        let advertised_limit = policy.default_mib;
        const heartbeat = () => {
          if (socket.readyState !== WebSocket.OPEN) return finish(opened, { kind: 'closed' });
          const limit = attachment_limit(home);
          if (limit !== advertised_limit) {
            socket.send(JSON.stringify({ type: 'attachment-policy', limit_mib: limit }));
            advertised_limit = limit;
          }
          const now = Date.now(), buffered = socket.bufferedAmount || 0;
          if ((buffered > ENTRY_BUFFER_HIGH) !== backlogged) {
            backlogged = buffered > ENTRY_BUFFER_HIGH;
            network_event(home, site, backlogged ? 'send_backlog' : 'send_drained', { segment: 'link', buffered_bytes: buffered });
          }
          // A delayed timer after sleep is not a missed network response. Resume probing before judging the link.
          const delayed = last_ping !== null && (now - last_ping > TIMER_DELAY_MS || now < last_ping);
          if (delayed) { missed_pings = 0; probe_started = buffer_progress = now; }
          else if (last_ping !== null) missed_pings++;
          if (buffered < previous_buffer || previous_buffer <= ENTRY_BUFFER_HIGH) buffer_progress = now;
          if (buffered < previous_buffer) watch(pong_seen, true);
          previous_buffer = buffered;
          // A queued ping cannot be answered yet. Allow draining traffic, but never exempt a stuck queue forever.
          const draining = buffered > ENTRY_BUFFER_HIGH && now - buffer_progress < SILENCE_MS;
          if (draining) missed_pings = 0;
          // Applies before the first pong too (the 2026-11-21 stall); no prior successful connection is required.
          if (!delayed && !draining && missed_pings >= MISSED_PINGS && now - Math.max(last_pong, probe_started) >= SILENCE_MS) {
            log(`${site}: ${t('中转连续 {seconds} 秒未收到心跳回应，重新连接', { seconds: SILENCE_MS / 1000 })}`);
            finish(opened, { kind: 'heartbeat', initiator: 'local', code: 4000, seconds: SILENCE_MS / 1000 });
            try { socket.close(4000, 'stalled'); } catch { /* Already closing. */ }
            return;
          }
          last_ping = now;
          // Do not add more pings behind the same large response; waking from sleep gets one fresh probe.
          if (buffered > ENTRY_BUFFER_HIGH && awaiting_pong && !delayed) return;
          awaiting_pong = true;
          try { socket.send('ping'); }
          catch (error) {
            finish(opened, { kind: network_failure(error), transport: network_code(error), initiator: 'local' });
            try { socket.close(); } catch { /* Already closing. */ }
          }
        };
        heartbeat();
        if (finished) return;
        ping = setInterval(heartbeat, PING_MS);
        forward_changes(home, socket, events.signal);
      });
      socket.addEventListener('message', async event => {
        if (finished || signal.aborted) return;
        const received_at = performance.now();
        if (event.data === 'pong') {
          if (!awaiting_pong) return;
          last_pong = Date.now();
          missed_pings = 0;
          watch(true);
          if (!pong_seen) network_event(home, site, 'connected', { handshake_ms: Date.now() - attempt_at });
          if (!pong_seen) log(`${site}: ${t('中转已连接')}`);
          awaiting_pong = false; pong_seen = true;
          health?.channel(site, link.id, 'connected');
          return;
        }
        if (typeof event.data !== 'string') return;
        let frame;
        try { frame = JSON.parse(event.data); } catch { return; }
        if (typeof frame.type === 'string' && frame.type.startsWith('entry')) return entry(frame);
        if (frame.type !== 'request' || typeof frame.id !== 'string' || !frame.envelope) return;
        // Disconnecting or re-pairing the website ends this connection at once, not at its next reconnect.
        const current = machine_links(home).sites[site];
        if (current?.token !== link.token || current?.private_key?.d !== link.private_key?.d) {
          log(`${site}: 配对已撤销或更换，关闭中转连接`);
          finish(opened, { kind: 'unpaired', code: 1000, initiator: 'local' });
          return socket.close(1000, 'unpaired');
        }
        const received = Date.now();
        const timing = { id: frame.id, received_at };
        health?.request(site, link.id);
        let kind = { action: '?', route: '', status: 0 };
        try {
          const answer = await answer_request(home, site, link, frame, { timing, report: value => { kind = value; } });
          const answered = Date.now();
          const open = !finished && socket.readyState === WebSocket.OPEN;
          const { oversized, ...frame_out } = answer;
          if (open) {
            const outgoing = JSON.stringify(frame_out);
            timing.queued_before_send = socket.bufferedAmount;
            socket.send(outgoing);
            if (timing.route) {
              timing.sent_at = performance.now();
              timing.buffered_bytes = socket.bufferedAmount || 0;
            }
          }
          if (kind.action !== 'timing-report') relay_outcome(home, site, timing, !open || oversized || kind.status >= 400);
          if (!open || oversized || kind.status >= 400) network_event(home, site, 'relay_failed', {
            operation: timing.category || 'other', segment: open ? 'computer' : 'link', elapsed_ms: answered - received,
            code: !open ? 'SOCKET_CLOSED' : oversized ? 'FRAME_LIMIT' : timing.transport || 'HTTP_' + kind.status
          });
        } catch (error) {
          if (kind.action !== 'timing-report') relay_outcome(home, site, timing, true);
          network_event(home, site, 'relay_failed', { operation: timing.category || 'other', segment: 'unknown',
            code: network_code(error), elapsed_ms: Date.now() - received });
        }
        finally { if (timing.route) log_relay_read(home, site, timing, kind.status, timing.buffered_bytes ?? (socket.bufferedAmount || 0)); }
      });
      let socket_failure;
      socket.addEventListener('close', event => {
        const clean = event.wasClean && event.code !== 1006;
        const reason = ['replaced', 'relay region changed', 'stalled', 'stopping', 'unpaired'].includes(event.reason) ? event.reason : 'closed';
        finish(opened, { kind: socket_failure ? socket_failure.kind : 'closed', close_reason: reason, transport: socket_failure?.code,
          code: event.code, initiator: !socket_failure && clean ? 'peer' : 'unknown' });
      });
      socket.addEventListener('error', event => {
        // Prefer the close frame's code when available, but a missing close must not stall the retry.
        socket_failure = { kind: network_failure(event.error), code: network_code(event.error) };
        setImmediate(() => {
          if (finished) return;
          finish(opened, { kind: socket_failure.kind, transport: socket_failure.code });
          try { socket.close(); } catch { /* Already closed. */ }
        });
      });
      signal.addEventListener('abort', stop_socket, { once: true });
    });
    const confirmed = await closed;
    if (signal.aborted) return;
    // A website without the relay refuses the upgrade every time; back off fully so it is only asked now and then.
    retry_since = Date.now();
    if (confirmed) retries = 0;
    delay = confirmed ? RETRY_MIN_MS : Math.min(delay * 2, RETRY_MAX_MS);
    await timers.setTimeout(delay, undefined, { signal }).catch(() => {});
  }
}

/**
 * Keep a relay channel open to every paired website that has a command key; returns the set of websites currently
 * connected, so the D1 command queue can skip them. New pairings are picked up when `refresh` is called.
 */
export function start_relay_channels(home, { log = () => {}, signal, health }) {
  const connected = new Set(), held = new Map();
  const requested_site = reconnect_reader(home, site => synced_relay_region(home, site));
  function start(site, link) {
    const controller = new AbortController(), channel_signal = AbortSignal.any([signal, controller.signal]);
    const record = { controller, machine: link.id, token: link.token, timer: null, confirmed: false };
    held.set(site, record);
    const watch = (confirmed, progress = false) => {
      if (progress || confirmed || record.confirmed || !record.timer) {
        clearTimeout(record.timer);
        const due = Date.now() + WATCHDOG_MS;
        record.timer = setTimeout(() => {
          // The watchdog must not bypass the heartbeat's sleep grace when both timers resume late.
          if (Date.now() - due > TIMER_DELAY_MS) return watch(record.confirmed, true);
          if (held.get(site) === record && !channel_signal.aborted) rebuild(site, 'watchdog');
        }, WATCHDOG_MS);
      }
      record.confirmed = confirmed;
    };
    watch(false);
    record.done = hold_channel(home, site, { connected, log, signal: channel_signal, health, watch }).finally(() => {
      clearTimeout(record.timer);
      if (held.get(site) === record) held.delete(site);
    });
  }
  function rebuild(site, reason) {
    const link = machine_links(home).sites[site];
    held.get(site)?.controller.abort(reason);
    if (signal.aborted || !link?.private_key) return;
    log(reason === 'watchdog' ? t('{site} 的中转连续 3 分钟未确认，正在重建连接。', { site })
      : t('正在按管理员要求重建 {site} 的中转连接。', { site }));
    health?.rebuild(site, link.id, reason);
    start(site, link);
  }
  let checking_guests;
  const refresh = () => {
    if (signal.aborted) return;
    checking_guests ??= refresh_guest_entries(home).then(changed => changed && sync_remote_launches(home))
      .catch(error => log(error.message)).finally(() => { checking_guests = null; });
    const sites = machine_links(home).sites;
    const requested = requested_site(sites);
    if (requested) rebuild(requested, 'manual');
    for (const [site, record] of held) {
      if (record.token !== sites[site]?.token || record.machine !== sites[site]?.id || !sites[site]?.private_key) {
        record.controller.abort();
        held.delete(site);
      }
    }
    for (const [site, link] of Object.entries(sites)) {
      if (!link.private_key || held.has(site)) continue;
      start(site, link);
    }
  };
  refresh();
  return { connected, refresh,
    done: () => Promise.all(Array.from(held.values(), record => record.done)) };
}

export { RELAY_PROTOCOL };

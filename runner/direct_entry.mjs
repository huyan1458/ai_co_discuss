/**
 * The direct receiver of a hosted account reached on its owner's domain (user 2026-11-19, #5588, #5599): instead of the
 * online relay, the sign-in entry (gateway/gateway.mjs) hands it the three requests an external member's computer sends
 * (`/api/machines/<id>/pair` and `/relay`; the key list is the entry's own). It runs inside the account's own discussion
 * service, the only process that can open the account's sealed direct identity (runner/remote_launch.mjs `direct_link`).
 *
 * What it takes and what it never does:
 * - only external members' requests, the branch of runner/relay_channel.mjs `answer_request` that goes to
 *   `answer_external`: a paired device's signed command is refused here whatever its signature, so nothing that reaches
 *   this from outside can run a local operation;
 * - a relayed request's `X-CoDiscuss-Device` credential is checked against the members this account registered before
 *   anything is decrypted, as the online site does for the relay, so unregistered senders cost no decryption;
 * - it listens on loopback only, under a random token kept with its port in `local/direct.json` for the entry; the
 *   token is compared in constant time, a request with an Origin is refused, and a few requests at a time are served.
 */
import http from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { atomic_json } from './files.mjs';
import { ENDED_GUEST_MS, answer_external, guest_reply_check, is_external_request, read_registry } from './external_gateway.mjs';
import { direct_link, relay_cipher, unseal } from './remote_launch.mjs';
import { seal_compressed } from './relay_channel.mjs';

export const DIRECT_FILE = join('local', 'direct.json');
export const DIRECT_PATH = '/direct';
export const DIRECT_TOKEN_HEADER = 'x-codiscuss-direct';
const BODY_MAX = 600 * 1024;
const READ_TIMEOUT_MS = 15_000;
const READING_MAX = 64;
const CONCURRENT_MAX = 6;
// The same window the online site allows a member's request credential (worker.mjs DEVICE_CLOCK_SECONDS).
const CLOCK_SECONDS = 300;
const ID_PATTERN = /^[A-Za-z0-9_-]{16,80}$/;
const KINDS = new Set(['pair', 'relay']);
const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' }, SIGNED = { name: 'ECDSA', hash: 'SHA-256' };

/**
 * The registered member a relayed request's credential names, or null: `<machine>.<member>.<seconds>.<signature>` over
 * `POST\n<path>\n<seconds>`, by a member whose key this account registered for its direct address and has not expired.
 */
export async function direct_member(home, link, credential, path, now = Date.now()) {
  const [machine, member, time, signature] = String(credential || '').split('.');
  if (machine !== link.id || !/^[0-9a-f]{32}$/.test(member || '') || !/^\d{10}$/.test(time || '') || !signature) return null;
  if (Math.abs(Math.floor(now / 1000) - Number(time)) > CLOCK_SECONDS) return null;
  const entry = read_registry(home).externals[member];
  if (!entry || !(entry.key_expires_at > now) || (entry.site && entry.site !== link.site)) return null;
  return await verifies_text(entry.public_key, `POST\n${path}\n${time}`, signature) ? member : null;
}

async function verifies_text(point, text, signature) {
  try {
    const key = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: point.x, y: point.y }, ECDSA, false, ['verify']);
    return await crypto.subtle.verify(SIGNED, key, Buffer.from(signature, 'base64url'), new TextEncoder().encode(text));
  } catch { return false; }
}

/** A removed guest can authenticate its public key solely to receive its encrypted end reason. */
async function ended_signer(home, link, request, now) {
  const [machine, member, time, signature] = String(request.credential || '').split('.');
  if (machine !== link.id || !/^[0-9a-f]{32}$/.test(member) || !/^\d{10}$/.test(time)
      || Math.abs(Math.floor(now / 1000) - Number(time)) > CLOCK_SECONDS) return null;
  const registry = read_registry(home);
  const expired = registry.externals[member];
  const record = expired?.kind === 'guest' && expired.key_expires_at <= now
    ? { ...expired, until: expired.key_expires_at + ENDED_GUEST_MS }
    : registry.ended_guests?.[member];
  if (!record || record.until <= now || record.site !== link.site) return null;
  return await verifies_text(record.public_key, `POST\n${request.path}\n${time}`, signature) ? record : null;
}

/** An envelope as the relay accepts one: an ephemeral public key and the sealed bytes. */
function valid_envelope(envelope) {
  return envelope && typeof envelope === 'object' && envelope.key && typeof envelope.key === 'object'
    && typeof envelope.iv === 'string' && typeof envelope.data === 'string';
}

/**
 * Answer one request the entry handed over: `{ kind, path, credential, id, envelope }`. Returns `{ status, body }`,
 * the body for 200 being the relay's answer `{ id, status: 'done', response }` with the reply sealed for the sender.
 */
export async function answer_direct(home, request, { now = Date.now(), fetcher, admit } = {}) {
  const link = direct_link(home);
  if (!link) return { status: 404, body: { error: '这个账号没有开启邀请外部专家' } };
  const { kind, path, credential, id, envelope } = request || {};
  if (!KINDS.has(kind) || typeof id !== 'string' || !ID_PATTERN.test(id) || !valid_envelope(envelope)) return { status: 400, body: { error: '请求格式无效' } };
  const guest = path === `/api/guest/${link.id}/${kind}`;
  if (!guest && path !== `/api/machines/${link.id}/${kind}`) return { status: 404, body: { error: '地址不存在' } };
  let member = null, ended = false;
  if (kind === 'relay') {
    member = await direct_member(home, link, credential, path, now);
    if (!member && guest) {
      ended = await ended_signer(home, link, request, now);
      if (ended) member = credential.split('.')[1];
    }
    if (!member) return { status: 401, body: { error: '外部成员未登记或凭据已失效' } };
  }
  if (admit && !admit()) return { status: 503, body: { error: '请求过多，请稍后再试' } };
  let key, sealed;
  try {
    key = await relay_cipher(link.private_key, envelope.key);
    sealed = await unseal(key, envelope, id);
  } catch { return { status: 400, body: { error: '无法解开请求' } }; }
  // Only an external member's request: a redemption on `pair`, the member the credential named on `relay`.
  if (!is_external_request(sealed) || (kind === 'pair' ? sealed.external_id !== undefined : sealed.external_id !== member)) {
    return { status: 403, body: { error: '这个入口只接受外部成员的请求' } };
  }
  let inner;
  try { inner = JSON.parse(sealed.body); } catch { return { status: 400, body: {} }; }
  const guest_action = inner?.action === (kind === 'pair' ? 'guest-redeem' : 'guest-api');
  if (guest !== guest_action || (guest && inner.machine !== link.id)) return { status: 403, body: {} };
  if (!guest) {
    const { response } = await answer_external(home, { machine_id: link.id, link, fetcher }, id, sealed);
    return { status: 200, body: { id, status: 'done', response: await seal_compressed(key, response, `${id}:response`) } };
  }
  if (ended) {
    if (inner.room !== ended.room_id || typeof inner.payload?.token !== 'string'
        || createHash('sha256').update(inner.payload.token).digest('hex') !== ended.token_hash
        || !await verifies_text(ended.public_key, id + '\n' + sealed.body, sealed.signature)) return { status: 403, body: {} };
  }
  const room = kind === 'pair' ? inner.payload?.room : inner.room;
  const token = kind === 'pair' ? inner.payload?.guest_token : inner.payload?.token;
  const denied = { status: 403, body: { ok: false, code: 'guest_forbidden' } };
  const result = ended ? denied : (await answer_external(home, { machine_id: link.id, link, fetcher }, id, sealed)).response;
  let response = await seal_compressed(key, result, id + ':response');
  if (ended || result.status < 400) {
    const refusal = await guest_reply_check(home, room, token, fetcher);
    const id_on_list = member || result.body?.data?.key_id;
    const entry = read_registry(home).externals[id_on_list];
    const listed = entry?.kind === 'guest' && entry.room_id === room && entry.site === link.site && entry.key_expires_at > Date.now();
    if (ended) {
      const reason = refusal?.body?.code === 'guest_ended' ? refusal.body.reason : null;
      response = await seal_compressed(key, reason ? { status: 403, body: { ok: false, code: 'guest_ended', reason } } : denied, id + ':response');
    } else if (refusal || !listed) response = await seal_compressed(key, refusal || denied, id + ':response');
  }
  return { status: 200, body: { id, status: 'done', response } };
}

function reply(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store' });
  response.end(text);
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

/**
 * Keep the receiver in step with the direct identity: listening while the account has one, gone when it has none.
 * `refresh()` is called from the service loop; `close()` stops it and removes `local/direct.json`.
 */
export function direct_receiver(home, { log = () => {}, fetcher } = {}) {
  const file = join(home, DIRECT_FILE);
  let server = null, token = '', machine = '', active = 0, starting = false;
  const same = (given) => {
    const expected = Buffer.from(token), supplied = Buffer.from(String(given || ''));
    return expected.length === supplied.length && timingSafeEqual(expected, supplied);
  };
  let reading = 0;
  const handle = async (request, response) => {
    if (request.method !== 'POST' || request.url !== DIRECT_PATH || request.headers.origin || !same(request.headers[DIRECT_TOKEN_HEADER])) {
      request.resume();
      return reply(response, 404, { error: '地址不存在' });
    }
    if (reading >= READING_MAX) { request.resume(); return reply(response, 503, { error: '请求过多，请稍后再试' }); }
    let admitted = false;
    try {
      reading += 1;
      let body;
      try { body = await read_body(request); } finally { reading -= 1; }
      const answer = await answer_direct(home, body, { fetcher, admit() {
        if (active >= CONCURRENT_MAX) return false;
        active += 1;
        admitted = true;
        return true;
      } });
      reply(response, answer.status, answer.body);
    } catch (error) { if (!response.headersSent) reply(response, error.status || 400, { error: error.message }); }
    finally { if (admitted) active -= 1; }
  };
  const stop = () => {
    if (server) { server.close(); server = null; }
    rmSync(file, { force: true });
  };
  return {
    refresh() {
      let link;
      try { link = direct_link(home); } catch (error) { log(`读取直连身份失败：${error.message}`); return; }
      if (!link) { if (server) { stop(); log('已关闭外部专家直连入口'); } return; }
      if (server && machine === link.id) return;
      if (starting) return;
      if (server) stop();
      starting = true;
      token = randomBytes(32).toString('hex');
      machine = link.id;
      const created = http.createServer((request, response) => { handle(request, response).catch(() => { if (!response.headersSent) reply(response, 500, { error: '处理失败' }); }); });
      created.listen(0, '127.0.0.1', () => {
        server = created;
        starting = false;
        mkdirSync(dirname(file), { recursive: true });
        atomic_json(file, { port: created.address().port, token, machine: link.id, site: link.site,
          public_key: link.public_key, sign_key: link.sign_public_key, name: link.name });
        log(`外部专家直连入口已开启：${link.site}`);
      });
      created.on('error', error => { starting = false; log(`外部专家直连入口启动失败：${error.message}`); });
    },
    close: stop,
  };
}

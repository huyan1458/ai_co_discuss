/**
 * Members whose AI runs on another computer (see .dev/plans/远程协作与多人房间/子Task2_B侧网关/CONTRACT.md): this computer
 * issues one-time invites, turns a redeemed invite into a room member with its own credential, keeps the members' public
 * keys beside the paired devices, and answers their relayed requests. An external member reaches only four actions, and
 * what it asks the local website always goes with its own member credential, never this computer's owner credential.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import { audit, device_id_of, machine_fingerprint, raw_point } from './device_auth.mjs';
import { site_fetch } from './entry_client.mjs';
import { atomic_json } from './files.mjs';
import { t } from './i18n.mjs';
import { claim_relayed_command } from './remote_policy.mjs';
import { repo_grep, repo_list, repo_read } from './repo_read.mjs';
import { b64url, from_b64url } from './webauthn.mjs';

const REGISTRY_FILE = 'external.json';
const LOCK_FILE = 'external.lock';
const LOCK_WAIT_MS = 3000;
const LOCK_STALE_MS = 10000;
const DAY_MS = 86400000;
const HOUR_MS = 3600000;
export const INVITE_MS = 10 * 60000;
const INVITE_ATTEMPTS = 5;
// The website lets an external key through this long after it joined; a key in use is extended when this close to the end.
const KEY_DAYS = 30;
const KEY_REFRESH_DAYS = 7;
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 12;
const INVITE_CONTEXT = 'codiscuss-invite-v1';
const LABEL_LIMIT = 80;
const LOCAL_TIMEOUT_MS = 8000;
const DURATIONS = new Set(['1h', 'today', '3d']);
const LEVELS = new Set(['discuss', 'read']);
// The only actions an external signer has; redeeming an invite is the one that goes without a registered key.
export const EXTERNAL_SIGNED_ACTIONS = new Set(['external-api', 'external-repo', 'external-leave']);
export const EXTERNAL_ACTIONS = new Set(['external-redeem', ...EXTERNAL_SIGNED_ACTIONS]);
export const INVITE_COMMANDS = new Set(['room-invite', 'room-invites', 'room-invite-revoke']);
const QUERY = /^(\?[A-Za-z0-9_.~%=&,:+-]*)?$/;
const SUB_PATH = /^[A-Za-z0-9_.~-]+(\/[A-Za-z0-9_.~-]+)*$/;

/** A refusal in the relay's HTTP shape. */
class GatewayError extends Error {
  constructor(status, message, reason) { super(message); this.status = status; this.reason = reason; }
}

/** Wait briefly for the registry lock, then run `task` on the registry with expired invites dropped, and save it. */
function with_registry(home, task) {
  const path = join(home, LOCK_FILE), deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try { writeFileSync(path, String(process.pid), { flag: 'wx' }); break; } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try { if (Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS) { rmSync(path, { force: true }); continue; } } catch { continue; }
      if (Date.now() > deadline) throw new Error(t('外部成员登记表正被占用，请稍后重试'));
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    const file = join(home, REGISTRY_FILE);
    const registry = read_registry(home);
    const now = Date.now();
    for (const [key, invite] of Object.entries(registry.invites)) if (invite.expires_at <= now) delete registry.invites[key];
    for (const [key, entry] of Object.entries(registry.externals)) if (entry.key_expires_at <= now) delete registry.externals[key];
    // Saved even when the task refuses: a used invite or a counted failure must not come back.
    try { return task(registry, now); } finally { atomic_json(file, registry); }
  } finally { rmSync(path, { force: true }); }
}

/** Read the registry without changing it. */
function read_registry(home) {
  const file = join(home, REGISTRY_FILE);
  const registry = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  registry.invites ||= {}; registry.externals ||= {};
  return registry;
}

const sha256 = value => createHash('sha256').update(String(value)).digest('hex');
const normal_code = value => String(value || '').toUpperCase().replace(/[^0-9A-Z]/g, '');

/** Compare two strings without an early exit; different lengths never match. */
function same(left, right) {
  const a = Buffer.from(String(left)), b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The hash this computer keeps of an invite code; it also keys the proof, so the code itself is never kept here. */
export const invite_code_hash = code => sha256(normal_code(code));

/** The proof A sends for an invite: the code (through its hash) authenticates A's new public key for this one computer. */
export function invite_proof(code, machine_id, jwk) {
  return proof_from_hash(invite_code_hash(code), machine_id, jwk);
}

function proof_from_hash(code_hash, machine_id, jwk) {
  return createHmac('sha256', code_hash).update(`${INVITE_CONTEXT}\n${machine_id}\n${b64url(raw_point(jwk))}`).digest('base64url');
}

/** Verify an ECDSA P-256 signature (IEEE P1363, base64url) over `text`. */
async function verify_signature(jwk, signature, text) {
  try {
    const key = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, from_b64url(signature), new TextEncoder().encode(text));
  } catch { return false; }
}

/**
 * A room this computer serves on its own local website: its site, owner credential, title and project directories
 * (`cwd` first, then the other directories), from the room configurations the runner keeps.
 */
export function local_room(home, room_id) {
  const path = join(home, 'rooms.json');
  const configs = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).configs ?? [] : [];
  for (const config_path of configs) {
    try {
      const config = JSON.parse(readFileSync(config_path, 'utf8'));
      const url = new URL(config.site);
      if (config.room !== room_id || !['127.0.0.1', 'localhost'].includes(url.hostname) || typeof config.token !== 'string') continue;
      return { id: room_id, site: url.origin, token: config.token,
        directories: [config.cwd, ...(Array.isArray(config.extra_directories) ? config.extra_directories : [])].filter(item => typeof item === 'string' && item) };
    } catch { /* A broken configuration grants nothing. */ }
  }
  return null;
}

/** The room, if `token` is its owner credential kept here. */
function owned_room(home, room_id, token) {
  const room = typeof room_id === 'string' && room_id ? local_room(home, room_id) : null;
  if (!room || typeof token !== 'string' || !same(room.token, token)) throw new Error(t('需要本房间的控制凭据，且房间须在这台电脑上'));
  return room;
}

/** One request to the local website; `external` marks it as an external member's own, so loopback earns it nothing. */
async function local_call(room, method, path, { token, body, external = false, etag, fetcher = site_fetch } = {}) {
  const headers = { 'X-Discussion-Token': token };
  if (external) Object.assign(headers, { 'X-CoDiscuss-External': '1', Origin: 'null', 'Sec-Fetch-Site': 'cross-site' });
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (etag) headers['If-None-Match'] = etag;
  const response = await fetcher(`${room.site}${path}`, { method, headers, redirect: 'error',
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(LOCAL_TIMEOUT_MS) });
  const tag = response.headers.get('ETag');
  if (response.status === 304) return { status: 304, etag: tag || etag };
  const json = (response.headers.get('Content-Type') || '').startsWith('application/json');
  return { status: response.status, json, body: json ? await response.json() : null, ...(tag ? { etag: tag } : {}) };
}

/** When a membership chosen at the invite ends, in seconds as the local website keeps it. */
function membership_end(duration, now) {
  if (duration === '3d') return Math.floor((now + 3 * DAY_MS) / 1000);
  if (duration === 'today') {
    const end = new Date(now);
    end.setHours(23, 59, 59, 0);
    // Late in the day "today" still gives an hour, so an invite accepted near midnight is usable.
    return Math.floor(Math.max(end.getTime(), now + HOUR_MS) / 1000);
  }
  return Math.floor((now + HOUR_MS) / 1000);
}

/** Pick the online site an invite names: the one asked for, or the only one this computer is bound to. */
async function invite_site(home, site_url) {
  const { keyed_links } = await import('./remote_launch.mjs');
  const sites = Object.entries(keyed_links(home).sites);
  const found = site_url ? sites.find(([origin]) => origin === site_url) : sites.length === 1 ? sites[0] : null;
  if (!found) throw new Error(sites.length ? t('这台电脑绑定了多个线上网站，请指定邀请使用的网站') : t('这台电脑还没有绑定线上网站，请先运行 codiscuss local connect 网站地址'));
  return { site: found[0], link: found[1] };
}

/**
 * Issue an invite for one room: a 12-character code valid ten minutes, kept here only as its hash, and the link that
 * carries it with this computer's key fingerprint. The code and link are returned this once.
 */
export async function create_invite(home, { room_id, token, level = 'read', folders, duration = '1h', site_url, by = 'computer' }) {
  const room = owned_room(home, room_id, token);
  if (!LEVELS.has(level)) throw new Error(t('开放等级须为 discuss 或 read'));
  if (!DURATIONS.has(duration)) throw new Error(t('有效期须为 1h、today 或 3d'));
  const chosen = level === 'discuss' ? [] : folders === undefined ? [0] : folders;
  if (!Array.isArray(chosen) || (level === 'read' && !chosen.length) || chosen.some(index => !Number.isSafeInteger(index) || index < 0 || index >= room.directories.length)
      || new Set(chosen).size !== chosen.length) {
    throw new Error(t('开放目录须为本房间项目目录的序号'));
  }
  const { site, link } = await invite_site(home, site_url);
  let room_name = '';
  try { const view = await local_call(room, 'GET', `/api/rooms/${encodeURIComponent(room_id)}`, { token }); room_name = String(view.body?.title ?? view.body?.room?.title ?? '').slice(0, 80); } catch { /* The name is only shown. */ }
  const code = Array.from(randomBytes(CODE_LENGTH), byte => CODE_ALPHABET[byte & 31]).join('');
  const fingerprint = machine_fingerprint(link);
  const invite = with_registry(home, (registry, now) => {
    const invite_id = randomBytes(8).toString('hex');
    registry.invites[invite_id] = { code_hash: invite_code_hash(code), room_id, level, folders: chosen, duration, site, by, created_at: now, expires_at: now + INVITE_MS, failures: 0 };
    return { invite_id, expires_at: now + INVITE_MS };
  });
  audit(home, { event: 'invite.created', room: room_id, invite: invite.invite_id, level, by });
  const payload = { v: 1, site, machine: link.id, machine_name: link.name, fp: fingerprint, code, room_name, level, expires_at: invite.expires_at };
  return { ...invite, code: `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`, url: `${site}/join#${b64url(Buffer.from(JSON.stringify(payload)))}`,
    room_id, level, folders: chosen, duration, machine: { id: link.id, name: link.name, fingerprint }, site };
}

/** The room's invites still waiting, without their codes. */
export function list_invites(home, { room_id, token }) {
  owned_room(home, room_id, token);
  return with_registry(home, registry => ({ invites: Object.entries(registry.invites).filter(([, invite]) => invite.room_id === room_id)
    .map(([invite_id, { level, folders, duration, created_at, expires_at, by }]) => ({ invite_id, room_id, level, folders, duration, created_at, expires_at, by }))
    .sort((left, right) => right.created_at - left.created_at) }));
}

/** Withdraw one waiting invite of the room. */
export function revoke_invite(home, { room_id, token, invite_id }) {
  owned_room(home, room_id, token);
  const revoked = with_registry(home, registry => {
    if (registry.invites[invite_id]?.room_id !== room_id) return false;
    delete registry.invites[invite_id];
    return true;
  });
  if (revoked) audit(home, { event: 'invite.revoked', room: room_id, invite: invite_id });
  return { ok: true, revoked };
}

/** `room-invite`, `room-invites` and `room-invite-revoke`, from this computer or relayed from a paired device. */
export async function invite_command(home, command, input, { device } = {}) {
  if (command === 'room-invite') return create_invite(home, { ...input, by: device || 'computer' });
  if (command === 'room-invites') return list_invites(home, input);
  if (command === 'room-invite-revoke') return revoke_invite(home, input);
  throw new Error(t('未知的邀请操作'));
}

/** External members' keys for the signed list of one website (the one their invite named), or of every website. */
export function external_entries(home, site) {
  return Object.entries(read_registry(home).externals).filter(([, entry]) => entry.key_expires_at > Date.now() && (!site || !entry.site || entry.site === site))
    .map(([id, entry]) => ({ id, x: entry.public_key.x, y: entry.public_key.y, kind: 'external', room: entry.room_id, expires_at: entry.key_expires_at }));
}

/** Forget an external member's key, so the website stops letting it through. */
async function drop_external(home, ctx, external_id, reason) {
  const dropped = with_registry(home, registry => {
    if (!registry.externals[external_id]) return false;
    delete registry.externals[external_id];
    return true;
  });
  if (dropped) {
    audit(home, { event: reason === 'left' ? 'external.left' : 'external.dropped', external: external_id, reason });
    await ctx.on_change?.();
  }
}

/** Take the invite whose code proves this key, counting a wrong proof against every waiting invite. */
function take_invite(home, machine_id, public_key, proof) {
  const taken = with_registry(home, registry => {
    const supplied = Buffer.from(String(proof || ''));
    for (const [id, invite] of Object.entries(registry.invites)) {
      const expected = Buffer.from(proof_from_hash(invite.code_hash, machine_id, public_key));
      if (expected.length === supplied.length && timingSafeEqual(expected, supplied)) {
        delete registry.invites[id];
        return { invite_id: id, ...invite };
      }
    }
    for (const [id, invite] of Object.entries(registry.invites)) if (++invite.failures >= INVITE_ATTEMPTS) delete registry.invites[id];
    return null;
  });
  if (!taken) throw new GatewayError(400, t('邀请码不对或已过期，请让对方重新生成邀请'));
  return taken;
}

/** The first unused member name `<platform>-ext`, `<platform>-ext2`, … among the room's members. */
function external_name(platform, taken) {
  if (!taken.has(`${platform}-ext`)) return `${platform}-ext`;
  for (let number = 2; ; number++) if (!taken.has(`${platform}-ext${number}`)) return `${platform}-ext${number}`;
}

/**
 * Redeem an invite: A proves the code and that it holds the new key; the room's owner credential kept here then asks the
 * local website to add the external member, and the key is registered and published at once.
 */
async function redeem(home, ctx, id, sealed, request) {
  const { public_key, proof, label, platform, adapter } = request.payload || {};
  let external_id;
  try { external_id = device_id_of(public_key); } catch { throw new GatewayError(400, t('外部成员公钥须为 P-256')); }
  if (!await verify_signature(public_key, sealed.signature, `${id}\n${sealed.body}`)) throw new GatewayError(400, t('外部成员签名无效'));
  if (typeof platform !== 'string' || !/^[A-Za-z]{2,20}$/.test(platform)) throw new GatewayError(400, t('请说明派来的是哪个 AI'));
  if (read_registry(home).externals[external_id]) throw new GatewayError(409, t('这把密钥已经加入过房间，请为新的邀请生成新密钥'));
  const invite = take_invite(home, ctx.machine_id, public_key, proof);
  const room = local_room(home, invite.room_id);
  if (!room) throw new GatewayError(404, t('邀请对应的房间已不在这台电脑上'));
  const directories = invite.folders.map(index => room.directories[index]);
  if (directories.some(directory => !directory)) throw new GatewayError(409, t('邀请开放的项目目录已不在房间里，请重新邀请'));
  const base = `/api/rooms/${encodeURIComponent(room.id)}`;
  const listed = await local_call(room, 'GET', `${base}/external-members`, { token: room.token, fetcher: ctx.fetcher });
  if (listed.status !== 200) return { status: listed.status, body: listed.body ?? { error: t('读取房间成员失败') } };
  const view = await local_call(room, 'GET', base, { token: room.token, fetcher: ctx.fetcher });
  const taken = new Set([...(view.body?.free?.members ?? []), ...(listed.body.members ?? [])].map(member => member?.name).filter(Boolean));
  const token = randomBytes(32).toString('hex'), clean_label = String(label || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, LABEL_LIMIT);
  const created = await local_call(room, 'POST', `${base}/external-members`, { token: room.token, fetcher: ctx.fetcher, body: {
    revision: listed.body.revision, name: external_name(platform, taken), adapter: String(adapter || '').slice(0, 40), token,
    machine: `ext:${external_id}`, machine_label: clean_label, scope: invite.level, directories, expires_at: membership_end(invite.duration, Date.now()) } });
  if (![200, 201].includes(created.status)) return { status: created.status, body: created.body ?? { error: t('建立外部成员失败') } };
  const member = created.body.member;
  with_registry(home, (registry, now) => {
    registry.externals[external_id] = { public_key: { kty: 'EC', crv: 'P-256', x: public_key.x, y: public_key.y }, room_id: room.id, member_id: member.member_id,
      member_name: member.name, token_hash: sha256(token), label: clean_label, site: invite.site, created_at: now, key_expires_at: now + KEY_DAYS * DAY_MS };
  });
  audit(home, { event: 'external.joined', room: room.id, external: external_id, member: member.name, invite: invite.invite_id });
  await ctx.on_change?.();
  return { status: 200, body: { external_id, site: invite.site, machine: { id: ctx.machine_id, name: ctx.link?.name ?? '', fingerprint: ctx.link ? machine_fingerprint(ctx.link) : '' },
    room: { id: room.id, name: String(view.body?.title ?? view.body?.room?.title ?? '') }, member: { id: member.member_id, name: member.name }, token,
    level: invite.level, directories: directories.map((directory, root) => ({ root, name: basename(directory) })), expires_at: member.expires_at } };
}

/**
 * Open one request from a registered external member: its key signs `id + "\n" + body`, the body names this computer and
 * the member's own room, and only the external actions pass.
 */
async function open_external(home, id, sealed, machine_id) {
  const request = JSON.parse(sealed.body);
  const entry = read_registry(home).externals[sealed.external_id];
  if (!entry || !(entry.key_expires_at > Date.now())) throw new GatewayError(403, t('这位外部成员未登记或已移除'));
  if (!await verify_signature(entry.public_key, sealed.signature, `${id}\n${sealed.body}`)) throw new GatewayError(403, t('外部成员签名无效'));
  if (request.machine !== machine_id) throw new GatewayError(403, t('这条请求是发给另一台电脑的'));
  if (request.room !== entry.room_id) throw new GatewayError(403, t('外部成员只能访问自己加入的房间'));
  if (!EXTERNAL_SIGNED_ACTIONS.has(request.action)) throw new GatewayError(403, t('该操作不对外部成员开放'));
  return { request, entry };
}

/** The member credential must be the one this key was given, so a leaked credential is useless without the key. */
function check_token(entry, token) {
  if (typeof token !== 'string' || !same(sha256(token), entry.token_hash)) throw new GatewayError(403, t('成员凭据与外部成员不符'));
}

/** Keep a key in use on the website's list: extend it when it nears its end. */
async function keep_key(home, ctx, external_id) {
  const extended = with_registry(home, (registry, now) => {
    const entry = registry.externals[external_id];
    if (!entry || entry.key_expires_at - now > KEY_REFRESH_DAYS * DAY_MS) return false;
    entry.key_expires_at = now + KEY_DAYS * DAY_MS;
    return true;
  });
  if (extended) await ctx.on_change?.();
}

/** `external-api`: one member-scope request to the local website with the member's own credential. */
async function external_api(home, ctx, external_id, entry, room, payload) {
  const { method = 'GET', path, body, token, etag } = payload || {};
  const prefix = `/api/external/rooms/${encodeURIComponent(entry.room_id)}/`;
  const rest = typeof path === 'string' && path.startsWith(prefix) ? path.slice(prefix.length) : null;
  const [sub, query = ''] = rest === null ? [] : rest.split(/(?=\?)/);
  if (!['GET', 'POST'].includes(method) || rest === null || path.includes('..') || !SUB_PATH.test(sub || '') || !QUERY.test(query)) {
    throw new GatewayError(400, t('外部成员请求地址无效'));
  }
  check_token(entry, token);
  const answer = await local_call(room, method, path, { token, external: true, fetcher: ctx.fetcher, body: method === 'POST' ? (body ?? {}) : undefined,
    etag: method === 'GET' && typeof etag === 'string' && /^"[0-9a-f]{1,64}"$/.test(etag) ? etag : undefined });
  if (answer.status === 304) return { status: 304, etag: answer.etag };
  if (!answer.json) return { status: 415, body: { error: t('外部成员只能读取 JSON 回答') } };
  if (answer.status === 403 && answer.body?.code === 'external_ended') await drop_external(home, ctx, external_id, answer.body?.reason || 'ended');
  else if (answer.status < 400) await keep_key(home, ctx, external_id);
  return { status: answer.status, body: answer.body, ...(answer.etag ? { etag: answer.etag } : {}) };
}

/** Whether `directory` is still one of the room's configured project directories. */
function in_room(room, directory) {
  const key = value => { const path = resolve(value); return process.platform === 'win32' ? path.toLowerCase() : path; };
  return room.directories.some(item => key(item) === key(directory));
}

/** Run one read-only engine operation in an open directory. */
function engine_call(directory, { op, path, query, offset, limit, max_bytes, max_results, case_sensitive }) {
  if (op === 'ls') return repo_list(directory, path ?? '', { offset, limit });
  if (op === 'read') return repo_read(directory, path, { offset, max_bytes });
  return repo_grep(directory, query, { path: path ?? '', case_sensitive: case_sensitive === true, max_results });
}

/**
 * `external-repo`: read the member's grant, run the read-only engine in one open directory, record the read and charge
 * the quota on the local website, and only then return the content; a read that cannot be recorded is not returned.
 */
async function external_repo(home, ctx, external_id, entry, room, payload) {
  const { op, token, root } = payload || {};
  if (!['ls', 'read', 'grep'].includes(op)) throw new GatewayError(400, t('读取操作须为 ls、read 或 grep'));
  check_token(entry, token);
  const member_path = `/api/rooms/${encodeURIComponent(room.id)}/external-members/${encodeURIComponent(entry.member_id)}`;
  const grant = await local_call(room, 'GET', member_path, { token: room.token, fetcher: ctx.fetcher });
  if (grant.status !== 200) return { status: grant.status >= 500 ? 503 : grant.status, body: { error: t('无法确认读取授权'), reason: 'grant_unavailable' } };
  const member = grant.body?.member ?? grant.body;
  if (member?.status !== 'active') {
    await drop_external(home, ctx, external_id, member?.end_reason || 'ended');
    return { status: 403, body: { error: t('外部成员资格已结束'), reason: 'external_ended' } };
  }
  if (member.scope !== 'read' || !Array.isArray(member.directories)) return { status: 403, body: { error: t('这位外部成员只能讨论，不能读取项目'), reason: 'not_readable' } };
  if (op === 'ls' && root === undefined) return { status: 200, body: { directories: member.directories.map((directory, index) => ({ root: index, name: basename(directory) })) } };
  const directory = Number.isSafeInteger(root) ? member.directories[root] : undefined;
  if (!directory || !in_room(room, directory)) return { status: 403, body: { error: t('这个目录没有对你开放'), reason: 'bad_root' } };
  const result = await engine_call(directory, payload);
  const record = await local_call(room, 'POST', `${member_path}/reads`, { token: room.token, fetcher: ctx.fetcher, body: { op, root,
    path: String(result.path ?? payload.path ?? ''), bytes: result.ok ? result.bytes || 0 : 0, outcome: result.ok ? 'ok' : 'denied', reason: result.ok ? '' : result.reason } })
    .catch(() => ({ status: 503, body: null }));
  if (!result.ok) return { status: 403, body: { error: t('读取被拒绝（{reason}）', { reason: result.reason }), reason: result.reason } };
  if (record.status !== 200 || record.body?.allowed !== true || record.body?.recorded !== true) {
    return { status: record.status === 200 ? 403 : record.status >= 500 ? 503 : record.status,
      body: { error: record.body?.allowed === false ? t('读取超出配额或不被允许（{reason}）', { reason: record.body.code || '' }) : t('读取记录写入失败，未返回内容'),
        reason: record.body?.code || 'audit_failed' } };
  }
  await keep_key(home, ctx, external_id);
  return { status: 200, body: { ...result, root } };
}

/** `external-leave`: leave with the member's own credential, then forget the key. */
async function external_leave(home, ctx, external_id, entry, room, payload) {
  check_token(entry, payload?.token);
  const answer = await local_call(room, 'POST', `/api/external/rooms/${encodeURIComponent(entry.room_id)}/leave`, { token: payload.token, external: true, body: {}, fetcher: ctx.fetcher });
  if (answer.status < 400 || answer.body?.code === 'external_ended') {
    await drop_external(home, ctx, external_id, 'left');
    return { status: 200, body: { ok: true } };
  }
  return { status: answer.status, body: answer.body };
}

/** Whether a sealed relay request belongs to the external path: signed by an external key, or redeeming an invite. */
export function is_external_request(sealed) {
  if (typeof sealed?.body !== 'string') return false;
  if (sealed.external_id !== undefined) return true;
  if (sealed.device_id) return false;
  try { return JSON.parse(sealed.body).action === 'external-redeem'; } catch { return false; }
}

/**
 * Answer one external request in the relay's HTTP shape. `ctx`: { machine_id, link, fetcher, on_change }. Returns the
 * opened request (as far as it could be read) and the response; nothing here runs a local operation or adds the owner
 * credential to what the member asked for.
 */
export async function answer_external(home, ctx, id, sealed) {
  let request = {}, response;
  try {
    if (sealed.device_id) throw new GatewayError(400, t('请求同时带有设备与外部成员签名'));
    if (sealed.external_id === undefined) {
      request = JSON.parse(sealed.body);
      if (request.action !== 'external-redeem') throw new GatewayError(403, t('该操作不对外部成员开放'));
      if (request.machine !== ctx.machine_id) throw new GatewayError(403, t('这条请求是发给另一台电脑的'));
      claim_relayed_command(home, id, request.sent_at);
      response = await redeem(home, ctx, id, sealed, request);
    } else {
      const opened = await open_external(home, id, sealed, ctx.machine_id);
      request = opened.request;
      claim_relayed_command(home, id, request.sent_at);
      const room = local_room(home, opened.entry.room_id);
      if (!room) throw new GatewayError(404, t('房间已不在这台电脑上'));
      const handler = { 'external-api': external_api, 'external-repo': external_repo, 'external-leave': external_leave }[request.action];
      response = await handler(home, ctx, sealed.external_id, opened.entry, room, request.payload);
    }
  } catch (error) {
    response = { status: error instanceof GatewayError ? error.status : 400, body: { error: error.message, ...(error.reason ? { reason: error.reason } : {}) } };
  }
  audit(home, { event: 'external', action: typeof request.action === 'string' ? request.action.slice(0, 40) : '',
    route: typeof request.payload?.path === 'string' ? request.payload.path.split('?')[0].slice(0, 200) : '',
    external: typeof sealed.external_id === 'string' ? sealed.external_id.slice(0, 32) : null, status: response.status });
  return { request, response };
}

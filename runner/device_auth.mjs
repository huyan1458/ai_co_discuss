/**
 * Which browsers this computer trusts, decided here alone (see .dev/plans/远程访问安全加固/PROTOCOL.md): pairing by a
 * code shown on a trusted screen, a signature on every relayed command, passkeys kept per device, and per-room write
 * grants. The website only forwards; nothing it stores can add a device or a grant.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { atomic_json } from './files.mjs';
import { b64url, from_b64url, joint_challenge, verify_assertion, verify_registration } from './webauthn.mjs';

const DEVICES_FILE = 'devices.json';
// What other devices did here: trust changes and every remote write, never content. Shown in the device list, so an
// unexpected entry (a device you did not add, a write you did not make) can be noticed and revoked.
const AUDIT_FILE = 'device-audit.log';
const AUDIT_MAX_BYTES = 1024 * 1024;
const AUDIT_SHOWN = 50;
const LOCK_FILE = 'devices.lock';
const LOCK_WAIT_MS = 3000;
const LOCK_STALE_MS = 10000;
const DAY_MS = 86400000;
export const DEVICE_DAYS = 30;
const TEMPORARY_DAYS = 1;
// An expired device may still renew itself with its passkey for this long; after that it pairs again.
const RENEW_GRACE_DAYS = 30;
export const WRITE_GRANT_MS = 12 * 3600000;
const PAIRING_MS = 120000;
const PAIRING_ATTEMPTS = 5;
const CHALLENGE_MS = 120000;
// A passkey is added only in the minutes after pairing, while the user is at it; later, a script running in the page
// could otherwise add its own and use it to grant itself writing.
const PASSKEY_SETUP_MS = 10 * 60000;
const LABEL_LIMIT = 60;
// Crockford base32 without I, L, O, U: 12 characters carry 60 random bits.
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 12;
const PAIR_CONTEXT = 'codiscuss-pair-v1';
// What an expired (not yet removed) device may still ask for: only to renew itself.
const EXPIRED_ACTIONS = new Set(['passkey-challenge', 'device-renew']);
// The one action an unpaired browser may send, unsigned: proving it holds a pairing code.
export const UNSIGNED_ACTIONS = new Set(['device-pair']);
// Device actions answered by this module rather than the launch entrypoint.
export const DEVICE_ACTIONS = new Set(['device-pair', 'device-pairing', 'device-list', 'device-revoke', 'passkey-options', 'passkey-register',
  'passkey-challenge', 'device-renew', 'write-grant', 'write-revoke']);

/** Wait briefly for the registry lock: the service and short-lived launch processes both update it. */
function with_lock(home, task) {
  const path = join(home, LOCK_FILE), deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try { writeFileSync(path, String(process.pid), { flag: 'wx' }); break; } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try { if (Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS) { rmSync(path, { force: true }); continue; } } catch { continue; }
      if (Date.now() > deadline) throw new Error('设备登记表正被占用，请稍后重试');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    const file = join(home, DEVICES_FILE);
    const registry = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
    registry.devices ||= {}; registry.pairings ||= {}; registry.challenges ||= {}; registry.write_grants ||= {};
    const now = Date.now();
    // Drop what has expired so the file stays small and nothing stale can be used.
    for (const [key, item] of Object.entries(registry.pairings)) if (item.expires_at <= now) delete registry.pairings[key];
    for (const [key, item] of Object.entries(registry.challenges)) if (item.expires_at <= now) delete registry.challenges[key];
    for (const [key, device] of Object.entries(registry.devices)) if (device.expires_at + RENEW_GRACE_DAYS * DAY_MS <= now) delete registry.devices[key];
    for (const [device, rooms] of Object.entries(registry.write_grants)) {
      for (const [room, until] of Object.entries(rooms)) if (until <= now || !registry.devices[device]) delete rooms[room];
      if (!Object.keys(rooms).length) delete registry.write_grants[device];
    }
    // Saved even when the task refuses: a used challenge or a counted failure must not come back.
    try { return task(registry, now); } finally { atomic_json(file, registry); }
  } finally { rmSync(path, { force: true }); }
}

/** Append one audit entry; the log keeps one older generation when it grows past its limit. */
export function audit(home, entry) {
  const path = join(home, AUDIT_FILE);
  try {
    if (existsSync(path) && statSync(path).size > AUDIT_MAX_BYTES) renameSync(path, `${path}.1`);
    appendFileSync(path, `${JSON.stringify({ at: Date.now(), ...entry })}\n`, { mode: 0o600 });
  } catch { /* An unwritable log never blocks the operation it records. */ }
}

/** The most recent audit entries, newest first. */
export function recent_audit(home, limit = AUDIT_SHOWN) {
  const path = join(home, AUDIT_FILE);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).slice(-limit).reverse()
    .map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
}

/** Read the registry without changing it. */
function read_registry(home) {
  const file = join(home, DEVICES_FILE);
  const registry = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  return { devices: registry.devices || {}, write_grants: registry.write_grants || {} };
}

/** The uncompressed P-256 point of a JWK, which names the device. */
function raw_point(jwk) {
  if (jwk?.kty !== 'EC' || jwk.crv !== 'P-256') throw new Error('设备公钥须为 P-256');
  const x = from_b64url(jwk.x), y = from_b64url(jwk.y);
  if (x.length !== 32 || y.length !== 32) throw new Error('设备公钥格式无效');
  return Uint8Array.from([4, ...x, ...y]);
}

/** A device's id: the first 32 hex characters of SHA-256 of its raw public key. */
export function device_id_of(jwk) {
  return createHash('sha256').update(raw_point(jwk)).digest('hex').slice(0, 32);
}

/** Keep a short label for the list; it is shown, never trusted. */
const clean_label = value => String(value || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, LABEL_LIMIT) || '未命名设备';

/** Upper-case a typed code and drop separators. */
const normal_code = value => String(value || '').toUpperCase().replace(/[^0-9A-Z]/g, '');

/** The proof a new browser sends: the code authenticates its public key for one computer. */
export function pairing_proof(code, machine_id, jwk) {
  return createHmac('sha256', normal_code(code)).update(`${PAIR_CONTEXT}\n${machine_id}\n${b64url(raw_point(jwk))}`).digest('base64url');
}

/** Start a pairing from a trusted screen: a 12-character code, valid two minutes, and the link a camera can open. */
export function start_pairing(home, { site, temporary = false, by = 'computer' }) {
  const bytes = randomBytes(CODE_LENGTH);
  const code = Array.from(bytes, byte => CODE_ALPHABET[byte & 31]).join('');
  audit(home, { event: 'pairing.started', by, temporary: Boolean(temporary) });
  return with_lock(home, (registry, now) => {
    const id = randomBytes(8).toString('hex');
    registry.pairings[id] = { code, temporary: Boolean(temporary), by, expires_at: now + PAIRING_MS, failures: 0 };
    return { code: `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`, expires_at: now + PAIRING_MS, temporary: Boolean(temporary),
      ...(site ? { url: `${site}/#pair=${code}` } : {}) };
  });
}

/** Record a paired device: thirty days, or one day for a temporary one. */
function add_device(registry, now, { public_key, label, temporary, by }) {
  const id = device_id_of(public_key);
  registry.devices[id] = { public_key: { kty: 'EC', crv: 'P-256', x: public_key.x, y: public_key.y }, label: clean_label(label), by,
    temporary: Boolean(temporary), created_at: now, expires_at: now + (temporary ? TEMPORARY_DAYS : DEVICE_DAYS) * DAY_MS, passkeys: [] };
  return { device_id: id, expires_at: registry.devices[id].expires_at, temporary: Boolean(temporary) };
}

/** A new browser proves it holds a live code; a wrong proof counts against every waiting code. */
export function pair_device(home, machine_id, { public_key, label, proof }) {
  if (typeof proof !== 'string' || !proof) throw new Error('缺少配对证明');
  device_id_of(public_key);
  const paired = with_lock(home, (registry, now) => {
    const supplied = Buffer.from(proof);
    for (const [id, pairing] of Object.entries(registry.pairings)) {
      const expected = Buffer.from(pairing_proof(pairing.code, machine_id, public_key));
      if (expected.length === supplied.length && timingSafeEqual(expected, supplied)) {
        delete registry.pairings[id];
        const added = add_device(registry, now, { public_key, label, temporary: pairing.temporary, by: pairing.by });
        audit(home, { event: 'device.paired', device: added.device_id, label: clean_label(label), by: pairing.by, temporary: pairing.temporary });
        return added;
      }
    }
    // The failure is saved before refusing, so guesses stay limited.
    for (const [id, pairing] of Object.entries(registry.pairings)) if (++pairing.failures >= PAIRING_ATTEMPTS) delete registry.pairings[id];
    return null;
  });
  if (!paired) throw new Error('配对码不对或已过期，请在已配对的设备上重新生成');
  return paired;
}

/**
 * Open one relayed request: a paired device's signature over `id + "\n" + body` is checked against its registered key.
 * Returns { request, device_id }; an unsigned request is accepted only for pairing.
 */
export async function open_signed_request(home, id, sealed, machine_id) {
  if (typeof sealed?.body !== 'string') throw new Error('请更新网页后重试：这台电脑只接受已配对设备签名的请求');
  const request = JSON.parse(sealed.body);
  if (!sealed.device_id) {
    if (!UNSIGNED_ACTIONS.has(request.action)) throw Object.assign(new Error('这台设备还没有与电脑配对'), { need: 'pairing' });
    return { request, device_id: null };
  }
  const device = read_registry(home).devices[sealed.device_id];
  if (!device) throw Object.assign(new Error('这台设备未配对或已被撤销，请重新配对'), { need: 'pairing' });
  const key = await crypto.subtle.importKey('jwk', device.public_key, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, from_b64url(sealed.signature), new TextEncoder().encode(`${id}\n${sealed.body}`));
  if (!valid) throw new Error('设备签名无效');
  // The signature names the computer it was meant for, so a request cannot be passed on to another paired computer.
  if (request.machine !== machine_id) throw new Error('这条请求是发给另一台电脑的');
  if (device.expires_at <= Date.now() && !EXPIRED_ACTIONS.has(request.action)) {
    throw Object.assign(new Error(device.temporary ? '临时设备授权已到期，请重新配对' : '设备授权已到期，请用通行密钥续期'), { need: device.temporary ? 'pairing' : 'renew' });
  }
  return { request, device_id: sealed.device_id };
}

/** Whether a device holds a live write grant for a room. */
export function write_allowed(home, device_id, room_id, now = Date.now()) {
  const until = read_registry(home).write_grants[device_id]?.[room_id];
  return Boolean(until && until > now);
}

/** The error that asks the page to confirm remote writing with a passkey, then retry. */
export function write_needed(room_id) {
  return Object.assign(new Error('这个房间的成员可以改动电脑上的文件；远程操作前需要用通行密钥确认（12 小时有效）'), { need: 'write-grant', room_id });
}

/** List paired devices with their passkeys and write grants, newest first, and the recent audit entries. */
export function list_devices(home, current = null) {
  const { devices, write_grants } = read_registry(home);
  return { audit: recent_audit(home), devices: Object.entries(devices).map(([id, device]) => ({ id, label: device.label, temporary: device.temporary, created_at: device.created_at,
    expires_at: device.expires_at, passkeys: device.passkeys.length, current: id === current,
    write_rooms: Object.entries(write_grants[id] || {}).map(([room, until]) => ({ room_id: room, until })) }))
    .sort((left, right) => right.created_at - left.created_at) };
}

/**
 * Remove a device with its passkeys and grants; a device may also remove itself. Returns the removed passkey ids so the
 * page can remove the same passkeys from the website's login list.
 */
export function revoke_device(home, device_id) {
  audit(home, { event: 'device.revoked', device: device_id });
  return with_lock(home, registry => {
    const passkeys = (registry.devices[device_id]?.passkeys || []).map(passkey => passkey.id);
    delete registry.devices[device_id];
    delete registry.write_grants[device_id];
    return { ok: true, passkeys };
  });
}

/** End one device's write grant for one room before it runs out. */
export function revoke_write(home, device_id, room_id) {
  audit(home, { event: 'write.revoked', device: device_id, room: room_id });
  return with_lock(home, registry => {
    if (registry.write_grants[device_id]) delete registry.write_grants[device_id][room_id];
    return { ok: true };
  });
}

/** The relying party of a site: its exact origin and host name. */
function relying_party(site) {
  const url = new URL(site);
  return { origin: url.origin, rp_id: url.hostname };
}

/**
 * Hand out a one-time challenge bound to the device, purpose and room. Registration returns creation options; the
 * other purposes return request options listing only this device's passkeys.
 */
export function passkey_options(home, device_id, site, { purpose, room_id }) {
  if (!['register', 'write', 'renew', 'pair'].includes(purpose)) throw new Error('通行密钥用途无效');
  if (purpose === 'write' && (typeof room_id !== 'string' || !room_id)) throw new Error('须指定要开启可写的房间');
  const { rp_id } = relying_party(site);
  return with_lock(home, (registry, now) => {
    const device = registry.devices[device_id];
    if (!device) throw new Error('这台设备未配对');
    if (purpose !== 'register' && !device.passkeys.length) throw new Error('这台设备还没有通行密钥，请撤销这台设备后重新配对，并在配对后创建');
    if (purpose === 'register' && (device.passkeys.length || now - device.created_at > PASSKEY_SETUP_MS)) {
      throw new Error('通行密钥只能在配对后 10 分钟内创建一次；如需重建，请撤销这台设备后重新配对');
    }
    if (purpose === 'renew' && device.temporary) throw new Error('临时设备不能续期，请重新配对');
    const id = randomBytes(8).toString('hex'), challenge = b64url(randomBytes(32));
    registry.challenges[id] = { device_id, purpose, room_id: room_id || null, challenge, site, expires_at: now + CHALLENGE_MS };
    if (purpose === 'register') {
      // One account entry per device: a synced password manager then keeps each device's passkey instead of replacing it.
      return { challenge_id: id, challenge, rp: { id: rp_id, name: 'AI CoDiscuss' }, user_id: b64url(createHash('sha256').update(`codiscuss:${rp_id}:${device_id}`).digest().subarray(0, 16)),
        user_name: `codiscuss · ${device.label}`, exclude: device.passkeys.map(passkey => passkey.id) };
    }
    return { challenge_id: id, challenge, rp_id, allow: device.passkeys.map(passkey => passkey.id) };
  });
}

/** Take a challenge once, checking it was issued to this device, for this purpose and room. */
function take_challenge(registry, { challenge_id, device_id, purpose, room_id = null, site }) {
  const item = registry.challenges[challenge_id];
  delete registry.challenges[challenge_id];
  if (!item || item.device_id !== device_id || item.purpose !== purpose || item.room_id !== room_id || item.site !== site) {
    throw new Error('通行密钥确认已过期，请重试');
  }
  return item;
}

/**
 * Keep a passkey created for this device. The browser signed SHA-256 of this computer's challenge and the website's,
 * so one creation registers with both; this computer checks its own part.
 */
export function register_passkey(home, device_id, site, { challenge_id, website_challenge, credential }) {
  const { origin, rp_id } = relying_party(site);
  return with_lock(home, registry => {
    const item = take_challenge(registry, { challenge_id, device_id, purpose: 'register', site });
    const challenge = website_challenge ? joint_challenge(item.challenge, website_challenge) : item.challenge;
    const passkey = verify_registration(credential, { challenge, origin, rp_id });
    const device = registry.devices[device_id];
    if (!device) throw new Error('这台设备未配对');
    if (device.passkeys.length || Date.now() - device.created_at > PASSKEY_SETUP_MS) throw new Error('通行密钥只能在配对后 10 分钟内创建一次');
    device.passkeys = [...device.passkeys.filter(kept => kept.id !== passkey.id), passkey];
    audit(home, { event: 'passkey.registered', device: device_id });
    return { ok: true, passkeys: device.passkeys.length };
  });
}

/**
 * Check a passkey assertion against this device's own passkeys and the challenge, then, in one locked step, confirm the
 * device and passkey are still there, move the counter only forward, and apply `commit`.
 */
async function check_assertion(home, device_id, site, { challenge_id, assertion }, purpose, room_id, commit) {
  const { origin, rp_id } = relying_party(site);
  const item = with_lock(home, registry => take_challenge(registry, { challenge_id, device_id, purpose, room_id, site }));
  const passkey = read_registry(home).devices[device_id]?.passkeys.find(kept => kept.id === assertion?.id);
  if (!passkey) throw new Error('这个通行密钥不属于这台设备');
  const count = await verify_assertion(assertion, passkey, { challenge: item.challenge, origin, rp_id });
  return with_lock(home, (registry, now) => {
    const device = registry.devices[device_id];
    const kept = device?.passkeys.find(entry => entry.id === passkey.id);
    if (!kept) throw new Error('这台设备或通行密钥已被撤销');
    // Assertions finishing out of order never move the counter back; a counter that did not grow is refused.
    if ((count || kept.sign_count) && count <= kept.sign_count) throw new Error('通行密钥计数异常，可能被复制，请撤销后重新配对');
    kept.sign_count = count;
    return commit(device, registry, now);
  });
}

/** Grant this device remote writing in one room for twelve hours, never past the device's own expiry. */
export async function grant_write(home, device_id, site, { challenge_id, assertion, room_id }) {
  return check_assertion(home, device_id, site, { challenge_id, assertion }, 'write', room_id, (device, registry, now) => {
    const until = Math.min(now + WRITE_GRANT_MS, device.expires_at);
    (registry.write_grants[device_id] ||= {})[room_id] = until;
    audit(home, { event: 'write.granted', device: device_id, room: room_id, until });
    return { room_id, until };
  });
}

/** Extend a (possibly just expired) device by another thirty days after a passkey check. */
export async function renew_device(home, device_id, site, { challenge_id, assertion }) {
  return check_assertion(home, device_id, site, { challenge_id, assertion }, 'renew', null, device => {
    if (device.temporary) throw new Error('这台设备不能续期，请重新配对');
    device.expires_at = Date.now() + DEVICE_DAYS * DAY_MS;
    audit(home, { event: 'device.renewed', device: device_id });
    return { expires_at: device.expires_at };
  });
}

/**
 * Let a paired device show a pairing code only after its passkey confirms it: a new device gains the same trust, so a
 * script using this browser's signing key alone must not be able to add one.
 */
async function invite_device(home, device_id, site, { challenge_id, assertion, temporary }) {
  await check_assertion(home, device_id, site, { challenge_id, assertion }, 'pair', null, () => true);
  return start_pairing(home, { site, temporary: temporary === true, by: device_id });
}

/**
 * Answer one device action relayed from `site` for `machine_id`, in the website's HTTP shape. `device_id` is the
 * verified sender, or null for an unsigned pairing request.
 */
export async function device_command(home, { site, machine_id, device_id }, action, payload = {}) {
  try {
    const body = action === 'device-pair' ? pair_device(home, machine_id, payload)
      : action === 'device-pairing' ? await invite_device(home, device_id, site, payload)
      : action === 'device-list' ? list_devices(home, device_id)
      : action === 'device-revoke' ? revoke_device(home, String(payload.device_id || ''))
      : action === 'write-revoke' ? revoke_write(home, String(payload.device_id || device_id), String(payload.room_id || ''))
      : action === 'passkey-options' ? passkey_options(home, device_id, site, { purpose: 'register' })
      : action === 'passkey-register' ? register_passkey(home, device_id, site, payload)
      : action === 'passkey-challenge' ? passkey_options(home, device_id, site, payload)
      : action === 'device-renew' ? await renew_device(home, device_id, site, payload)
      : action === 'write-grant' ? await grant_write(home, device_id, site, payload)
      : null;
    if (!body) return { status: 404, body: { error: '未知的设备操作' } };
    return { status: 200, body };
  } catch (error) {
    return { status: 400, body: { error: error.message, ...(error.need ? { need: error.need } : {}) } };
  }
}

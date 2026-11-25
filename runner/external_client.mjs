/**
 * This computer as an external member of rooms on other computers (.dev/plans/远程协作与多人房间/子Task4_A侧接入/CONTRACT.md):
 * the invitations it accepted, kept with one key pair each; the trust given to each inviting computer; pulling the
 * requests addressed to its AI through that computer's relay, asking the owner first when the trust level says so; and
 * waking the AI through the adapter layer, which reaches the other room only through this computer's own entry
 * (`external-proxy`), so it never holds the private key or the member credential.
 */
import { execFileSync } from 'node:child_process';
import { createHash, createHmac, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { gunzipSync } from 'node:zlib';

import { adapter_profile, API_PROVIDERS, lockdown_support } from './adapters/profiles.mjs';
import { correctable_refusals, external_task_text, MAX_REFUSAL_RETRIES, refusal_retry_prompt, TASK_SUBCOMMANDS } from './expert_prompts.mjs';
import { atomic_json } from './files.mjs';
import { t } from './i18n.mjs';

export const WAKES = ['auto', 'ask'];
// The single level records had before `wake` and `confined`, still accepted by `invited-trust` as a shorthand.
const LEGACY_TRUST = { default: { wake: 'ask', confined: true }, borrow: { wake: 'auto', confined: true }, trusted: { wake: 'auto', confined: false } };
// How long this computer lends its AI to a room: chosen here when joining and changed here later, at most three days.
export const LEND_DURATIONS = ['1h', 'today', '3d'];
const HOUR_MS = 3600000;
const LEND_MAX_MS = 3 * 24 * HOUR_MS;
export const APPROVAL_TIMEOUT_MS = 15 * 60000;
export const POLL_MS = 5000;
// The inviting room fails an execution whose lease lapses; renew it as the room runner does.
export const RENEW_MS = 30000;
// What “完全借用” allows when the owner sets no limit of their own.
const HISTORY_LIMIT = 50;
// The end of a run's output kept with a run that ended unanswered, so its owner can see why; it never leaves this computer.
const OUTPUT_TAIL = 2000;
const MODEL_LIMIT = 120;
// What this computer keeps of each request its AI received and each answer it gave, so the history still reads after the
// inviting room can no longer be reached.
const TEXT_LIMIT = 4000;
// How many of the inviting room's latest messages the invited room's page shows.
const ROOM_MESSAGE_WINDOW = 100;
// How often a pass also reads the member's current grant (`/view`) when nothing is woken; a wake and the room view always read it.
const VIEW_REFRESH_MS = 60000;
// The website gives up on a relayed request after 9 seconds; ask for an answer within that.
const RELAY_WAIT_MS = 8000;
const REQUEST_TIMEOUT_MS = 15000;
// The pauses before sending a request again after a network failure.
const RETRY_DELAYS_MS = [500, 1500];
// Network failures that happen before a request leaves this computer, so sending a write again cannot repeat it.
const NOT_SENT_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);
const RELAY_CIPHER_INFO = 'codiscuss-relay-v1';
const INVITE_CONTEXT = 'codiscuss-invite-v1';
const STORE_FILE = 'invited.json';
const SECRETS_FILE = 'secrets.json';
const LOCK_FILE = 'invited.lock';
const LOCK_WAIT_MS = 3000;
const LOCK_STALE_MS = 10000;
// Under the external home, one folder per record in each.
const RUN_FOLDERS = ['runtime', 'work', 'drafts'];
const CODE_PATTERN = /^[0-9A-Z]{12}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const RECORD_ID = /^[0-9a-f]{16}$/;
const ROOM_ID = /^[A-Za-z0-9_-]{1,64}$/;
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The member-scope routes of the inviting room (子Task1 CONTRACT §3), reached through `external-api`. */
const EXTERNAL_PREFIX = room => `/api/external/rooms/${room}`;
export const MEMBER_API = {
  view: room => `${EXTERNAL_PREFIX(room)}/view`,
  inbox: room => `${EXTERNAL_PREFIX(room)}/inbox`,
  claim: room => `${EXTERNAL_PREFIX(room)}/claim`,
  decline: room => `${EXTERNAL_PREFIX(room)}/decline`,
  execution: (room, execution) => `${EXTERNAL_PREFIX(room)}/executions/${execution}`,
  answer: room => `${EXTERNAL_PREFIX(room)}/answer`,
  messages: room => `${EXTERNAL_PREFIX(room)}/messages`,
  ai: room => `${EXTERNAL_PREFIX(room)}/ai`,
  expiry: room => `${EXTERNAL_PREFIX(room)}/expiry`,
};

// ---- Secrets: sealed with DPAPI for the signed-in Windows user, 0600 elsewhere (as machine-links.json). ----

const DPAPI_SCRIPT = mode => 'Add-Type -AssemblyName System.Security;'
  + '$bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());'
  + `[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::${mode}($bytes,$null,'CurrentUser'))`;
const dpapi = (mode, base64) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', DPAPI_SCRIPT(mode)],
  { input: base64, encoding: 'utf8', windowsHide: true }).trim();
const DPAPI_CODEC = {
  seal: text => ({ dpapi: dpapi('Protect', Buffer.from(text).toString('base64')) }),
  open: stored => Buffer.from(dpapi('Unprotect', stored.dpapi), 'base64').toString('utf8'),
};
const PLAIN_CODEC = { seal: text => ({ plain: JSON.parse(text) }), open: stored => JSON.stringify(stored.plain ?? {}) };
let secret_codec = process.platform === 'win32' ? DPAPI_CODEC : PLAIN_CODEC;

/** Tests replace the Windows sealing, which starts PowerShell, with the plain file form. */
export function use_plain_secrets() { secret_codec = PLAIN_CODEC; }

/**
 * An error the page can show in its own language: the Chinese template and its parameters (`error_text`, as the
 * website's errors carry) and a stable `code`, beside the message in this command line's language.
 */
function failure(code, template, params, extra = {}) {
  return Object.assign(new Error(t(template, params)), { code, error_text: { template, params: params || {} }, ...extra });
}

/** An error refused by the other side, keeping its own text, template and code when it gave them. */
function remote_failure(body, code, template, params, extra = {}) {
  if (!body?.error) return failure(code, template, params, extra);
  return Object.assign(new Error(body.error), { code: body.code || code, ...(body.error_text ? { error_text: body.error_text } : {}), ...extra });
}

/** What a failure leaves for the page beside its message. */
const failure_fields = error => ({ ...(error?.code && typeof error.code === 'string' ? { code: error.code } : {}), ...(error?.error_text ? { error_text: error.error_text } : {}) });

// ---- Store ----

function external_home(home) {
  const directory = join(home, 'external');
  mkdirSync(directory, { recursive: true });
  return directory;
}

function read_json(path, fallback) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback;
}

// The secrets last opened, by file: opening them starts PowerShell on Windows (about half a second, blocking), and the
// service sends several relay requests every few seconds. A file changed by another process is opened again.
const opened_secrets = new Map();
const file_stamp = path => { try { const { mtimeMs, size } = statSync(path); return `${mtimeMs}:${size}`; } catch { return ''; } };

function read_secrets(home) {
  const path = join(external_home(home), SECRETS_FILE), stamp = file_stamp(path), kept = opened_secrets.get(path);
  if (!stamp) return {};
  if (kept?.stamp === stamp) return structuredClone(kept.secrets);
  const stored = read_json(path, null);
  const secrets = JSON.parse(stored.dpapi ? DPAPI_CODEC.open(stored) : PLAIN_CODEC.open(stored));
  opened_secrets.set(path, { stamp, secrets: structuredClone(secrets) });
  return secrets;
}

function write_secrets(home, secrets) {
  const path = join(external_home(home), SECRETS_FILE);
  atomic_json(path, secret_codec.seal(JSON.stringify(secrets)));
  opened_secrets.set(path, { stamp: file_stamp(path), secrets: structuredClone(secrets) });
}

/** Read the store without changing it. */
export function read_store(home) {
  const store = read_json(join(external_home(home), STORE_FILE), {});
  store.records ||= {}; store.machines ||= {};
  return store;
}

/**
 * Change the store under its lock: the service and short-lived commands both write it. `task(store, secrets, now)` may
 * change either; secrets are written only when `task` marks `secrets.changed`.
 */
function with_store(home, task) {
  const directory = external_home(home), lock = join(directory, LOCK_FILE), deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try { writeFileSync(lock, String(process.pid), { flag: 'wx' }); break; } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try { if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) { rmSync(lock, { force: true }); continue; } } catch { continue; }
      if (Date.now() > deadline) throw failure('store_busy', '被邀请记录正被占用，请稍后重试');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    const store = read_store(home);
    let secrets = null;
    const access = { get: () => (secrets ||= read_secrets(home)), changed: false };
    const result = task(store, access, Date.now());
    atomic_json(join(directory, STORE_FILE), store);
    if (access.changed) write_secrets(home, secrets);
    return result;
  } finally { rmSync(lock, { force: true }); }
}

/**
 * How a record treats being named, `{wake, confined}`: `wake` is `auto` (start at once) or
 * `ask` (wait for the owner), `confined` whether the AI may run only the codiscuss commands. Each record keeps its own;
 * one joined before these two settings follows the level its inviting computer had (default / borrow / trusted).
 */
function record_settings(record, store) {
  if (WAKES.includes(record.wake)) return { wake: record.wake, confined: record.confined !== false };
  return LEGACY_TRUST[store.machines[record.machine_fingerprint]?.trust] || LEGACY_TRUST.default;
}

/** A record as every command shows it: no key, no credential. */
export function record_view(record, store) {
  const settings = record_settings(record, store);
  const { session_id, machine_key, ai_reported, ...shown } = record;
  return { ...shown, ...settings, lockdown: settings.confined, approvals: (record.approvals || []).filter(item => item.status === 'waiting') };
}

function find_record(store, id) {
  const record = store.records[String(id || '')];
  if (!record) throw failure('record_not_found', '没有这条被邀请记录：{id}', { id });
  return record;
}

function remember(record, entry, now) {
  record.history = [...(record.history || []), { at: now, ...entry }].slice(-HISTORY_LIMIT);
}

function change_record(home, id, change) {
  return with_store(home, (store, secrets, now) => change(find_record(store, id), now, store));
}

// ---- Invitations ----

function clean_site(value) {
  const url = new URL(String(value || ''));
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw failure('invalid_site', '站点地址无效');
  return url.origin;
}

function invite_fields(fragment) {
  try {
    const value = JSON.parse(Buffer.from(fragment.replace(/^#/, ''), 'base64url').toString('utf8'));
    if (value && typeof value === 'object') return value;
  } catch { /* Not an invitation payload. */ }
  throw failure('invalid_link', '邀请链接无效，请向对方重新索取');
}

/**
 * Read an invitation (子Task2 CONTRACT §2.1): a link `<site>/join#<base64url JSON>` with site, machine, machine_name,
 * fp, code, room_name, level and expires_at, or a bare code, which carries no fingerprint and needs `site` beside it
 * (`machine` too when that site lists more than one computer).
 */
export function parse_invite(invite, { site = '', machine = '' } = {}) {
  const text = String(invite || '').trim();
  let fields;
  if (/^https?:\/\//i.test(text)) {
    const url = new URL(text);
    fields = invite_fields(url.hash);
    fields.site ||= url.origin;
  } else fields = { code: text, site, machine };
  const code = String(fields.code || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (!CODE_PATTERN.test(code)) throw failure('invalid_code', '配对码格式不对：应为 12 位字母数字');
  if (!fields.site) throw failure('site_required', '配对码须同时给出对方的线上站点（--site）');
  const machine_id = String(fields.machine || machine || '');
  if (machine_id && !HEX32.test(machine_id)) throw failure('invalid_machine', '电脑编号格式不对');
  const fingerprint = String(fields.fp || '');
  if (fingerprint && !HEX32.test(fingerprint)) throw failure('invalid_fingerprint', '邀请链接里的电脑指纹无效');
  return { site: clean_site(fields.site), machine: machine_id, fingerprint, code, room_name: String(fields.room_name || ''),
    machine_name: String(fields.machine_name || ''), level: ['read', 'discuss'].includes(fields.level) ? fields.level : '', expires_at: Number(fields.expires_at) || null };
}

/** The fingerprint of a computer's two public keys, as `device_auth.machine_fingerprint` computes it for pairing links. */
export function fingerprint_of(public_key, sign_key) {
  return createHash('sha256').update(`${public_key.x}.${public_key.y}.${sign_key.x}.${sign_key.y}`).digest('hex').slice(0, 32);
}

const raw_point = jwk => Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);

/** A key's id: the first 32 hex characters of SHA-256 of its raw point, as a paired device's id is computed. */
export function key_id_of(jwk) {
  return createHash('sha256').update(raw_point(jwk)).digest('hex').slice(0, 32);
}

/** Proof of holding the invitation code for this key, without sending the code (子Task2 CONTRACT §4.1). */
export function invite_proof(code, machine, jwk) {
  const key = createHash('sha256').update(code).digest('hex');
  return createHmac('sha256', key).update(`${INVITE_CONTEXT}\n${machine}\n${raw_point(jwk).toString('base64url')}`).digest('base64url');
}

const site_unreachable = (site, error) => failure('site_unreachable', '连不上对方的线上站点 {site}：{reason}', { site, reason: error.message },
  { offline: true, network_code: error.cause?.code, timed_out: error.name === 'TimeoutError' || error.name === 'AbortError' });

/**
 * Run a request, sending it again after a brief network failure. A request that may have reached the other side is sent
 * again only when `repeatable`; a timeout is not retried, since the wait has already been spent.
 */
async function retry_unreachable(send, { repeatable = false, delays = RETRY_DELAYS_MS } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try { return await send(); }
    catch (error) {
      const retry = error.code === 'site_unreachable' && !error.timed_out && attempt < delays.length && (repeatable || NOT_SENT_CODES.has(error.network_code));
      if (!retry) throw error;
      await new Promise(done => setTimeout(done, delays[attempt]));
    }
  }
}

/**
 * The inviting computer's public keys, from the website's public machine list. Without a computer id the site must list
 * exactly one computer.
 */
export async function machine_keys(site, machine, { fetcher = fetch, retry_delays } = {}) {
  const response = await retry_unreachable(async () => {
    try { return await fetcher(`${site}/api/machines`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }); }
    catch (error) { throw site_unreachable(site, error); }
  }, { repeatable: true, delays: retry_delays });
  const body = await response.json().catch(() => ({}));
  const list = (Array.isArray(body) ? body : body.machines || []).filter(item => item?.public_key && item?.sign_key);
  // Hosted accounts' computers (`parent`) are reached by id only; without one the site's own computers are meant (#5494).
  const owners = list.filter(item => !item.parent);
  if (!machine && owners.length > 1) throw failure('machine_required', '对方站点连着多台电脑，请用 --machine 指定电脑编号：{ids}', { ids: owners.map(item => `${item.id}（${item.name || ''}）`).join('、') });
  const found = machine ? list.find(item => item.id === machine) : owners[0];
  if (!found) throw failure('machine_not_found', '对方站点上找不到这台电脑，或它还没有连接中转');
  return { id: found.id, public_key: found.public_key, sign_key: found.sign_key, name: String(found.name || ''), fingerprint: fingerprint_of(found.public_key, found.sign_key) };
}

// ---- Signed, end-to-end encrypted requests to the inviting computer (子Task2 CONTRACT §3) ----

const subtle = globalThis.crypto.subtle;
const encoder = new TextEncoder();

async function relay_cipher(private_key, public_jwk) {
  const peer = await subtle.importKey('jwk', public_jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const bits = await subtle.deriveBits({ name: 'ECDH', public: peer }, private_key, 256);
  const material = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(), info: encoder.encode(RELAY_CIPHER_INFO) },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function sign_text(private_jwk, text) {
  const key = await subtle.importKey('jwk', private_jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  return Buffer.from(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, encoder.encode(text))).toString('base64url');
}

function key_pair() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const { kty, crv, x, y } = publicKey.export({ format: 'jwk' });
  return { public_key: { kty, crv, x, y }, private_key: privateKey.export({ format: 'jwk' }) };
}

/**
 * Send one action to the inviting computer and open its answer `{status, body}`. `identity` is `{key_id, private_key,
 * room}`; the redeem (`room` absent) goes unregistered to the pairing entry, signed only to prove the key is held, the
 * rest to the relay with the registered key. Throws with `offline` when the computer is not connected, `unconfirmed` when
 * it did not answer in time. A brief network failure is retried as a new relay request: always for a read or a leave
 * (leaving twice changes nothing), and for any other write only when it never left this computer.
 */
export function relay_send(target, identity, action, payload, deps = {}) {
  const repeatable = action === 'external-leave' || (action === 'external-api' && payload.method === 'GET');
  return retry_unreachable(() => relay_send_once(target, identity, action, payload, deps), { repeatable, delays: deps.retry_delays });
}

async function relay_send_once(target, identity, action, payload, { fetcher = fetch, wait = RELAY_WAIT_MS }) {
  const id = randomUUID();
  const redeem = action === 'external-redeem';
  const body = JSON.stringify({ action, payload, machine: target.machine, ...(redeem ? {} : { room: identity.room }), sent_at: Date.now() });
  const signature = await sign_text(identity.private_key, `${id}\n${body}`);
  const plain = redeem ? { body, signature } : { body, external_id: identity.key_id, signature };
  const ephemeral = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const key = await relay_cipher(ephemeral.privateKey, target.machine_key);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const data = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(id) }, key, encoder.encode(JSON.stringify(plain)));
  const { kty, crv, x, y } = await subtle.exportKey('jwk', ephemeral.publicKey);
  const envelope = { key: { kty, crv, x, y }, iv: Buffer.from(iv).toString('base64'), data: Buffer.from(data).toString('base64') };
  const route = `/api/machines/${encodeURIComponent(target.machine)}/${redeem ? 'pair' : 'relay'}`;
  const headers = { 'Content-Type': 'application/json' };
  if (!redeem) {
    const seconds = String(Math.floor(Date.now() / 1000));
    headers['X-CoDiscuss-Device'] = `${target.machine}.${identity.key_id}.${seconds}.${await sign_text(identity.private_key, `POST\n${route}\n${seconds}`)}`;
  }
  let response;
  try {
    response = await fetcher(`${target.site}${route}`, { method: 'POST', headers, body: JSON.stringify({ id, envelope, wait }),
      signal: AbortSignal.timeout(wait + REQUEST_TIMEOUT_MS) });
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') throw Object.assign(failure('unconfirmed', '对方电脑未在限时内答复，结果待确认'), { unconfirmed: true });
    throw site_unreachable(target.site, error);
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw remote_failure(result, 'site_refused', '对方站点拒绝了请求（HTTP {status}）', { status: response.status }, { status: response.status });
  if (result.status === 'offline') throw Object.assign(failure('offline', '对方电脑不在线：它可能关机或没有运行 codiscuss'), { offline: true });
  if (result.status !== 'done') throw Object.assign(failure('unconfirmed', '对方电脑未在限时内答复，结果待确认'), { unconfirmed: true });
  const sealed = result.response;
  const opened = Buffer.from(await subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(sealed.iv, 'base64'), additionalData: encoder.encode(`${id}:response`) },
    key, Buffer.from(sealed.data, 'base64')));
  return JSON.parse((sealed.encoding === 'gzip' ? gunzipSync(opened) : opened).toString('utf8'));
}

/** Record how the last exchange went, so a computer that is off reads as offline and an ended membership as ended. */
function note_contact(home, id, state, error = null, ended = '') {
  try {
    with_store(home, (store, secrets, now) => {
      const record = store.records[id];
      if (!record) return;
      record.contact = { at: now, state, error: String(error?.message || '').slice(0, 300), ...failure_fields(error) };
      if (ended && record.status === 'active') { record.status = 'ended'; record.end_reason = ended; remember(record, { outcome: 'ended', reason: ended }, now); }
    });
  } catch { /* A busy store only delays the status line. */ }
}

/** Send one signed action for a record, with its own key and credential added here; the caller never sees either. */
async function record_send(home, id, action, payload, deps = {}) {
  const record = find_record(read_store(home), id);
  const secret = read_secrets(home)[id];
  if (!secret) throw failure('key_missing', '这条被邀请记录已没有密钥，请重新加入');
  let answer;
  try {
    answer = await relay_send({ site: record.site, machine: record.machine, machine_key: record.machine_key },
      { key_id: record.key_id, private_key: secret.private_key, room: record.room }, action, { ...payload, token: secret.token }, deps);
  } catch (error) {
    note_contact(home, id, error.offline ? 'offline' : 'error', error);
    throw error;
  }
  // Revoked, expired or left there: the inviting room is the judge (子Task1 CONTRACT §0).
  note_contact(home, id, 'online', null, answer.status === 403 && answer.body?.code === 'external_ended' ? answer.body.reason || 'revoked' : '');
  return answer;
}

/** One member-scope request to the inviting room (`external-api`); a refusal throws with its status and reason. */
export async function member_api(home, id, method, path, body, deps = {}) {
  const answer = await record_send(home, id, 'external-api', { method, path, ...(body === undefined ? {} : { body }) }, deps);
  if (answer.status >= 400) throw remote_failure(answer.body, 'remote_refused', '对方拒绝了请求（HTTP {status}）', { status: answer.status }, { status: answer.status, body: answer.body });
  return answer.body;
}

// ---- Local commands ----

function check_ai(input) {
  const adapter = String(input.adapter || '');
  const profile = adapter_profile(adapter);
  // The AI reaches the other room only through this computer's codiscuss (a CLI) or this module (the model API's room
  // and repo tools); App windows do neither.
  if (!['cli', 'api'].includes(profile?.kind)) throw failure('ai_unsupported', '外部成员只能派命令行软件（如 Claude Code）或模型 API');
  // An external member takes no prompt of its own (user 2026-11-25): it answers in another person's room by that room's rules.
  return { adapter, model: String(input.model || ''), effort: String(input.effort || '') };
}

/** The saved model API this AI runs on, as `[participant name, settings]`; empty when this computer has none. */
function saved_api(home, ai) {
  const settings = read_json(join(home, 'launch-settings.json'), { participants: {} });
  const saved = Object.entries(settings.participants || {}).filter(([, profile]) => profile?.adapter === ai.adapter && profile.base_url);
  return saved.find(([, profile]) => !ai.model || profile.model === ai.model) || saved[0] || [];
}

/**
 * What the inviting room shows about this AI: its adapter, platform and model. A model API takes its platform from the
 * provider slot it is saved under; a custom endpoint has none of its own.
 */
function ai_identity(home, ai) {
  const profile = adapter_profile(ai.adapter);
  if (profile?.kind !== 'api') return { adapter: ai.adapter, platform: profile?.platform || 'Custom', model: String(ai.model || '').slice(0, MODEL_LIMIT) };
  const [name, api] = saved_api(home, ai);
  const platform = String(name || '').split('-')[0];
  return { adapter: ai.adapter, platform: Object.hasOwn(API_PROVIDERS, platform) ? platform : 'Custom', model: String(ai.model || api?.model || '').slice(0, MODEL_LIMIT) };
}

/**
 * When a loan chosen now ends, in epoch seconds: an hour, the end of today here (at least an hour away) or three days.
 * The inviting room keeps the end it is given; the three-day ceiling is this computer's own rule.
 */
export function lend_until(duration, now = Date.now()) {
  if (!LEND_DURATIONS.includes(duration)) throw failure('invalid_duration', '借出时间只能是 1h、today 或 3d');
  if (duration === '3d') return Math.floor((now + LEND_MAX_MS) / 1000);
  if (duration === 'today') {
    const end = new Date(now);
    end.setHours(23, 59, 59, 0);
    return Math.floor(Math.min(Math.max(end.getTime(), now + HOUR_MS), now + LEND_MAX_MS) / 1000);
  }
  return Math.floor((now + HOUR_MS) / 1000);
}

/**
 * Change how long this record's AI stays lent; the inviting room confirms the new end, which the record then keeps. A
 * record whose time ran out renews the same way and is active again at once; one revoked there, or left here, cannot.
 */
export async function lend(home, { id, duration }, deps = {}) {
  const expires_at = lend_until(duration, deps.now?.() ?? Date.now());
  const record = find_record(read_store(home), id);
  const lapsed = record.status === 'ended' && record.end_reason === 'expired';
  if (record.status !== 'active' && !lapsed) throw failure('record_ended', '这条被邀请记录已结束，不能再改借出时间');
  let answer;
  try { answer = await member_api(home, id, 'POST', MEMBER_API.expiry(record.room), { expires_at }, deps); }
  catch (error) {
    // The other site no longer lets this record's key through: before 0.4.97 the inviting computer forgot the key of a
    // member whose time ran out, so such a record can only come back through a new invitation.
    if (lapsed && error.status === 401) throw failure('renew_key_gone', '对方电脑已不再认可这条记录，无法续期；请让对方点“重新邀请”发新链接');
    throw error;
  }
  return change_record(home, id, (current, now, store) => {
    current.expires_at = Number(answer?.expires_at || expires_at) * 1000;
    if (lapsed) {
      current.status = 'active';
      delete current.end_reason;
    }
    return { record: record_view(current, store) };
  });
}

/** Accept an invitation: check the computer's fingerprint when the link carries one, redeem with a new key, keep the record. */
export async function join_invite(home, input, deps = {}) {
  const invite = parse_invite(input.invite, input);
  const ai = check_ai(input);
  const expires_at = lend_until(input.duration || '1h', deps.now?.() ?? Date.now());
  // A conversation this computer's software already holds, picked to carry its context into the room.
  const session_id = String(input.session_id || '');
  const keys = await machine_keys(invite.site, invite.machine, deps);
  if (invite.fingerprint && invite.fingerprint !== keys.fingerprint) {
    throw failure('fingerprint_mismatch', '这不是邀请你的那台电脑：指纹不符，已停止加入。请向对方确认链接');
  }
  const attempt_key = `join:${createHash('sha256').update(`${invite.site}:${keys.id}:${invite.code}`).digest('hex')}`;
  const attempt = with_store(home, (store, secrets) => {
    const values = secrets.get();
    if (!values[attempt_key]) {
      values[attempt_key] = { pair: key_pair(), id: randomBytes(8).toString('hex') };
      secrets.changed = true;
    }
    return values[attempt_key];
  });
  const existing = read_store(home);
  if (existing.records[attempt.id] && read_secrets(home)[attempt.id]?.token) return { record: record_view(existing.records[attempt.id], existing) };
  const pair = attempt.pair, key_id = key_id_of(pair.public_key), identity = ai_identity(home, ai);
  const answer = await relay_send({ site: invite.site, machine: keys.id, machine_key: keys.public_key }, { key_id, private_key: pair.private_key }, 'external-redeem',
    { public_key: pair.public_key, proof: invite_proof(invite.code, keys.id, pair.public_key), label: String(input.label || hostname()).slice(0, 80), expires_at, ...identity }, deps);
  if (answer.status >= 400) throw remote_failure(answer.body, 'invite_invalid', '邀请无效或已过期');
  const joined = answer.body || {};
  if (!ROOM_ID.test(joined.room?.id || '') || typeof joined.member?.name !== 'string' || typeof joined.token !== 'string') {
    throw failure('join_incomplete', '对方返回的加入结果不完整');
  }
  return with_store(home, (store, secrets, now) => {
    const name = joined.machine?.name || keys.name || invite.machine_name;
    const machine = store.machines[keys.fingerprint] ||= {};
    Object.assign(machine, { machine: keys.id, site: invite.site, machine_name: name, updated_at: now });
    // Every join starts a record of its own with the AI and settings picked for it, even when invited back as a member
    // this computer already has a record of (user 2026-11-19): the earlier record stays as it ended.
    const id = attempt.id;
    const fresh = { id, site: invite.site, machine: keys.id, machine_name: name, machine_fingerprint: keys.fingerprint,
      machine_key: keys.public_key, fingerprint_checked: Boolean(invite.fingerprint), room: joined.room.id, room_title: String(joined.room.name || invite.room_name),
      member: joined.member.name, member_id: joined.member.id ?? null, key_id, open_level: joined.level || invite.level || 'read',
      directories: Array.isArray(joined.directories) ? joined.directories : [],
      expires_at: Number(joined.expires_at) ? Number(joined.expires_at) * 1000 : null, ai, ai_reported: JSON.stringify(identity),
      limits: null, paused: false, status: 'active', contact: { at: now, state: 'online', error: '' }, approvals: [], running: null,
      ...(session_id ? { session_id } : {}) };
    // Accepting the invitation is the consent: a new record answers at once, confined.
    store.records[id] = { ...fresh, wake: 'auto', confined: true, wakes: 0, last_wake_at: null, history: [], joined_at: now };
    const values = secrets.get();
    values[id] = { private_key: pair.private_key, token: joined.token };
    // A retry of this join finds the record it ended up in.
    values[attempt_key] = { ...values[attempt_key], id };
    secrets.changed = true;
    return { record: record_view(store.records[id], store) };
  });
}


/**
 * Set how this record treats being named: `wake` (auto / ask) and `confined`, either of which may be left out, or the old
 * single `trust` level. Answering at once has no wake count or time limit (2026-11-19, user); any a record had is dropped.
 */
export function set_trust(home, { id, trust, wake, confined }) {
  if (trust !== undefined && !LEGACY_TRUST[trust]) throw failure('invalid_trust', '信任等级只能是 default、borrow 或 trusted');
  if (wake !== undefined && !WAKES.includes(wake)) throw failure('invalid_wake', '被点名时只能是 auto 或 ask');
  const chosen = trust !== undefined ? LEGACY_TRUST[trust] : { wake, confined: confined === undefined ? undefined : confined !== false && confined !== 'false' };
  return change_record(home, id, (record, now, store) => {
    const current = record_settings(record, store);
    Object.assign(record, { wake: chosen.wake ?? current.wake, confined: chosen.confined ?? current.confined, limits: null });
    return { record: record_view(record, store) };
  });
}

/** Whether a request may wake the AI without asking: the record answers at once. */
export function wakes_directly(record, store) {
  return record_settings(record, store).wake === 'auto';
}

/**
 * Tell the inviting room these requests will not be answered here. The room knows two outcomes (子Task1 CONTRACT §3):
 * `timeout`, and `declined` for everything else; why it was declined stays in this computer's history.
 */
async function decline(home, id, request_ids, reason, deps) {
  const record = find_record(read_store(home), id);
  const outcome = reason === 'timeout' ? 'timeout' : 'declined';
  try { await member_api(home, id, 'POST', MEMBER_API.decline(record.room), { request_ids, outcome }, deps); return true; }
  catch (error) { deps.log?.(t('未能告诉对方“未同意”：{reason}', { reason: error.message })); return false; }
}

function settle_approval(home, id, approval, outcome) {
  return change_record(home, id, (record, now) => {
    const item = (record.approvals || []).find(entry => entry.id === approval && entry.status === 'waiting');
    if (!item) throw failure('approval_not_found', '这条待确认请求不存在或已处理');
    item.status = outcome;
    if (outcome === 'refused') remember(record, { request_ids: item.request_ids, message_ids: item.message_ids, outcome }, now);
    return item;
  });
}

/** Refuse a waiting request: the inviting room shows that the other side did not agree. */
export async function refuse_approval(home, { id, approval }, deps = {}) {
  const item = settle_approval(home, id, approval, 'refused');
  change_record(home, id, record => { record.approvals = record.approvals.filter(entry => entry.status === 'waiting' || entry.status === 'approved'); });
  await decline(home, id, item.request_ids, 'refused', deps);
  const store = read_store(home);
  return { record: record_view(store.records[id], store) };
}

/** Agree to a waiting request; the service wakes the AI for it on its next pass, so this returns at once. */
export function approve(home, { id, approval }) {
  settle_approval(home, id, approval, 'approved');
  const store = read_store(home);
  return { record: record_view(store.records[id], store) };
}

/** Leave the room: tell the inviting computer, then drop the key and credential here even when it cannot be reached. */
export async function leave(home, { id }, deps = {}) {
  let remote = 'done';
  try {
    const answer = await record_send(home, id, 'external-leave', {}, deps);
    if (answer.status >= 400 && answer.body?.code !== 'external_ended') remote = 'refused';
  } catch (error) { remote = error.offline ? 'unreachable' : error.unconfirmed ? 'unconfirmed' : 'refused'; deps.log?.(error.message); }
  // Not heard over there yet: the key stays until the pull loop has told the other computer (`deliver_leave`).
  const undelivered = remote === 'unreachable' || remote === 'unconfirmed';
  return with_store(home, (store, secrets, now) => {
    const record = find_record(store, id);
    Object.assign(record, { status: 'left', approvals: [], paused: true, leave_pending: undelivered });
    remember(record, { outcome: 'left', remote }, now);
    if (!undelivered) forget_keys(secrets, id);
    return { record: record_view(record, store), remote };
  });
}

/** Delete what this computer holds for a record it has left: its key, credential and join attempt. */
function forget_keys(secrets, id) {
  delete secrets.get()[id];
  for (const [key, value] of Object.entries(secrets.get())) {
    if (key.startsWith('join:') && value.id === id) delete secrets.get()[key];
  }
  secrets.changed = true;
}

/**
 * Tell the inviting computer about a leave it has not heard yet. Any answer from it settles the matter; while it cannot
 * be reached the next pass tries again, until the membership has run out over there by itself.
 */
async function deliver_leave(home, id, deps = {}) {
  const record = read_store(home).records[id];
  if (!(record.expires_at && record.expires_at <= (deps.now?.() ?? Date.now()))) {
    try { await record_send(home, id, 'external-leave', {}, deps); }
    catch (error) {
      if (error.offline || error.unconfirmed) return { leave_pending: true };
      deps.log?.(error.message);
    }
  }
  with_store(home, (store, secrets) => {
    store.records[id].leave_pending = false;
    forget_keys(secrets, id);
  });
  return { leave_pending: false };
}

/**
 * Delete an ended or left record from this computer: its history, key, credential and run files. Nothing is sent to the
 * inviting room, and the trust given to that computer stays, since it covers all of that computer's rooms.
 */
export function remove_record(home, { id }, deps = {}) {
  const record = with_store(home, (store, secrets) => {
    const found = find_record(store, id);
    if (found.status === 'active') throw failure('record_active', '这个房间还在进行中，请先退出再删除记录');
    if (found.leave_pending) throw failure('leave_pending', '退出通知还没送达对方电脑，送达后才能删除记录');
    delete store.records[found.id];
    forget_keys(secrets, found.id);
    return found;
  });
  // A run still going keeps its folders; they are only leftovers, so one that cannot be removed does not fail the delete.
  if (!record.running) {
    for (const folder of RUN_FOLDERS) {
      try { rmSync(join(external_home(home), folder, record.id), { recursive: true, force: true }); }
      catch (error) { deps.log?.(error.message); }
    }
  }
  return { removed: record.id };
}

/** Keep the record in line with what the inviting room grants now (`/view` `me`): level, deadline and opened directories. */
function apply_grant(home, id, me, now = Date.now()) {
  if (!me || typeof me !== 'object') return;
  change_record(home, id, record => {
    if (['read', 'discuss'].includes(me.scope)) record.open_level = me.scope;
    if (Number(me.expires_at)) record.expires_at = Number(me.expires_at) * 1000;
    if (Array.isArray(me.directories)) record.directories = me.directories.map(({ root, name }) => ({ root, name }));
    record.grant_checked_at = now;
  });
}

async function refresh_grant(home, id, deps) {
  const record = find_record(read_store(home), id);
  const view = await member_api(home, id, 'GET', MEMBER_API.view(record.room), undefined, deps);
  apply_grant(home, id, view?.me, deps.now?.() ?? Date.now());
  return view;
}

const clip = text => String(text ?? '').slice(0, TEXT_LIMIT);

/** The requests and answers this computer kept, as messages, for when the inviting room cannot be read. */
function kept_messages(record) {
  const messages = new Map();
  for (const entry of record.history || []) {
    for (const item of entry.request_texts || []) messages.set(item.id, { ...item, kept: true });
    if (entry.answer) messages.set(entry.answer.id, { ...entry.answer, execution_id: entry.execution_id, kept: true });
  }
  return [...messages.values()].sort((a, b) => a.id - b.id);
}

/** One page of the inviting room's messages, oldest first: those numbered above `after`, at most `limit`. */
async function message_page(home, id, record, after, limit, deps) {
  const path = `${MEMBER_API.messages(record.room)}?${new URLSearchParams({ after, limit })}`;
  return (await member_api(home, id, 'GET', path, undefined, deps)).messages || [];
}

/**
 * The record with what the inviting room shows this member (what it may read there anyway), when it can be reached:
 * the room's latest messages, oldest first, or with `before`, the page just before that message. `earlier` says whether
 * older messages remain.
 */
export async function room_view(home, { id, cached = false, before }, deps = {}) {
  const record = find_record(read_store(home), id);
  // What this computer already knows, without the network: the page shows it at once while the real read is under way.
  if (cached) return { record: record_view(record, read_store(home)), room: null, messages: kept_messages(record), earlier: false };
  if (before !== undefined) {
    const end = Math.max(0, Number(before) - 1), after = Math.max(0, end - ROOM_MESSAGE_WINDOW);
    try {
      const messages = end > after ? await message_page(home, id, record, after, end - after, deps) : [];
      return { messages, earlier: after > 0 };
    } catch (error) { return { messages: [], earlier: true, error: error.message, ...failure_fields(error) }; }
  }
  let room = null, problem = null, earlier = false;
  let messages = [];
  try {
    // The view comes first for the room's latest message number.
    const view = await refresh_grant(home, id, deps);
    const after = Math.max(0, (Number(view?.latest_message_id) || 0) - ROOM_MESSAGE_WINDOW);
    messages = await message_page(home, id, record, after, ROOM_MESSAGE_WINDOW, deps);
    room = view;
    earlier = after > 0;
  } catch (error) { problem = error; messages = kept_messages(record); }
  const store = read_store(home);
  // Also under `room`, where the page (子Task6) looks for them.
  return { record: record_view(store.records[id], store), room: room ? { ...room, messages } : null, messages, earlier,
    ...(problem ? { error: problem.message, ...failure_fields(problem) } : {}) };
}

/**
 * The local commands behind the A page and the CLI (CONTRACT §2), each answering JSON. `deps` carries the fetcher in
 * tests.
 */
export async function invited_command(home, action, input = {}, deps = {}) {
  const id = input?.id;
  if (action === 'invited-list') {
    const store = read_store(home);
    return { records: Object.values(store.records).map(record => record_view(record, store)).sort((a, b) => b.joined_at - a.joined_at),
      machines: Object.entries(store.machines).map(([fingerprint, item]) => ({ fingerprint, machine_name: item.machine_name || '', site: item.site || '' })) };
  }
  if (action === 'invited-join') return join_invite(home, input, deps);
  if (action === 'invited-trust') return set_trust(home, input);
  if (action === 'invited-ai') return change_record(home, id, (record, now, store) => { record.ai = check_ai({ ...record.ai, ...input }); return { record: record_view(record, store) }; });
  if (action === 'invited-pause') return change_record(home, id, (record, now, store) => { record.paused = input.paused !== false; return { record: record_view(record, store) }; });
  if (action === 'invited-approve') return approve(home, input);
  if (action === 'invited-refuse') return refuse_approval(home, input, deps);
  if (action === 'invited-lend') return lend(home, input, deps);
  if (action === 'invited-leave') return leave(home, input, deps);
  if (action === 'invited-remove') return remove_record(home, input, deps);
  if (action === 'invited-room') return room_view(home, input, deps);
  throw failure('unknown_action', '未知的被邀请记录操作：{action}', { action });
}

export const INVITED_ACTIONS = new Set(['invited-list', 'invited-join', 'invited-trust', 'invited-ai', 'invited-pause', 'invited-approve',
  'invited-refuse', 'invited-lend', 'invited-leave', 'invited-remove', 'invited-room']);

// ---- Pulling and waking (in the service) ----

/**
 * What the chosen software runs with on this computer, from launch settings: a CLI's program location, or a saved model
 * API's endpoint fields (its key stays a reference into this computer's key store). Null when this computer has none.
 */
function software_profile(home, ai) {
  if (adapter_profile(ai.adapter)?.kind === 'api') {
    const [, api] = saved_api(home, ai);
    if (!api) return null;
    const { base_url, api_protocol, api_key_ref, image_input, model } = api;
    return { base_url, api_protocol, api_key_ref, image_input, model };
  }
  const settings = read_json(join(home, 'launch-settings.json'), { participants: {} });
  const saved = Object.values(settings.participants || {}).filter(profile => profile?.adapter === ai.adapter);
  const executable = saved.find(profile => profile.executable)?.executable;
  return executable ? { executable } : null;
}

/**
 * Claim this member's pending requests and wake the AI once for them, through the adapter layer. `request_ids` are what
 * this wake was decided for: with `only` (the owner approved exactly these) only they are claimed, otherwise every
 * pending request is; when the run cannot start the inviting room is told why. Returns the execution id or null.
 */
export async function wake(home, id, request_ids, deps = {}, { only = false } = {}) {
  const store = read_store(home), record = find_record(store, id);
  const lockdown = record_view(record, store).lockdown;
  const refuse = async (reason, template, params) => {
    change_record(home, id, (current, now) => remember(current, { request_ids, outcome: reason, reason: t(template, params), reason_text: { template, params } }, now));
    await decline(home, id, request_ids, reason, deps);
    return null;
  };
  const support = lockdown_support(record.ai.adapter);
  if (lockdown && !support.supported) {
    return refuse('lockdown_unsupported', '该软件不能收窄到只用 codiscuss 命令，只能在“信任设备”等级下服务：{reason}', { reason: support.reason });
  }
  const software = deps.software ?? software_profile(home, record.ai);
  if (!software) return refuse('ai_unavailable', '这台电脑还没有配置 {adapter}', { adapter: adapter_profile(record.ai.adapter)?.label || record.ai.adapter });
  // The AI is told what the other side opens now, not what it opened at joining.
  await refresh_grant(home, id, deps).catch(error => deps.log?.(error.message));
  let execution;
  try {
    const claimed = await member_api(home, id, 'POST', MEMBER_API.claim(record.room), { client_id: `ext-${record.id}-${randomBytes(6).toString('hex')}`, ...(only ? { request_ids } : {}) }, deps);
    execution = claimed.execution || claimed;
  } catch (error) {
    change_record(home, id, (current, now) => remember(current, { request_ids, outcome: 'failed', reason: error.message, ...failure_fields(error) }, now));
    return null;
  }
  const claimed_ids = (execution.requests || []).map(item => item.id);
  // The request texts are kept here (CONTRACT §1.1 history), so the history still reads once that room cannot be.
  const request_texts = [];
  for (const message_id of new Set((execution.requests || []).map(item => item.message_id).filter(Number.isInteger))) {
    const read = await member_api(home, id, 'GET', `${MEMBER_API.messages(record.room)}/${message_id}`, undefined, deps).catch(() => null);
    const message = read?.message || read;
    if (message?.id === message_id) request_texts.push({ id: message_id, author: String(message.author || ''), text: clip(message.text) });
  }
  change_record(home, id, (current, now) => {
    current.wakes = (current.wakes || 0) + 1;
    current.last_wake_at = now;
    if (current.limits) current.limits.used = (current.limits.used || 0) + 1;
    current.running = { execution_id: execution.id, started_at: now, last_renew: deps.now?.() ?? now };
    // Approvals whose requests this execution took are settled by it.
    current.approvals = (current.approvals || []).filter(item => item.status === 'waiting' && !item.request_ids.every(request => claimed_ids.includes(request)));
    remember(current, { request_ids: claimed_ids, message_ids: (execution.requests || []).map(item => item.message_id), outcome: 'woken', execution_id: execution.id, request_texts }, now);
  });
  await deliver_external(home, find_record(read_store(home), id), execution, { lockdown, software }, deps);
  return execution.id;
}

/** Write this run's files and hand it to the adapter layer; the run ends through its callbacks or a failure here. */
async function deliver_external(home, record, execution, { lockdown, software, tried = { attempts: 0, refusals: [] } }, deps) {
  let settled = false, refusals = [];
  const end = reason => {
    if (settled) return;
    settled = true;
    // A command refused for something the AI can correct (shell symbols in an inline answer): the same session is
    // resumed with every such refusal so far, up to MAX_REFUSAL_RETRIES times.
    const next = { attempts: tried.attempts + 1, refusals: [...tried.refusals, ...refusals] };
    const retry = refusals.length && tried.attempts < MAX_REFUSAL_RETRIES ? () => deliver_external(home, find_record(read_store(home), record.id), execution,
      { lockdown, software, tried: next }, deps) : null;
    finish(home, record.id, execution.id, reason, deps, retry).catch(error => deps.log?.(error.message));
  };
  const take_denials = denials => { refusals = correctable_refusals(denials); };
  const resume = tried.attempts ? refusal_retry_prompt(execution.id, tried.refusals, tried.attempts) : '';
  try { await start_run(home, record, execution, { lockdown, software, end, resume, take_denials }, deps); }
  catch (error) { end(error.message || t('执行失败')); }
}

async function start_run(home, record, execution, { lockdown, software, end, resume, take_denials }, deps) {
  const base = join(external_home(home), 'runtime', record.id);
  // A fresh empty folder each run: nothing of this computer is in reach of the AI's own file tools. A locked-down run
  // works in its draft folder instead (子Task5 CONTRACT §1), which holds only its own drafts.
  const workdir = join(external_home(home), 'work', record.id, String(execution.id));
  const drafts = join(external_home(home), 'drafts', record.id);
  for (const directory of [base, workdir, drafts]) mkdirSync(directory, { recursive: true });
  const access_path = join(base, `external-${execution.id}.access.json`);
  const task_path = join(base, `external-${execution.id}.task.json`);
  // Read by discuss.py: which record to go through, and, when locked down, the only folder its file arguments may name.
  const access = { transport: 'external', record: record.id, site: record.site, room: record.room, member: record.member,
    execution_id: execution.id, session_id: record.session_id || '', ...(lockdown ? { tool_lockdown: true, draft_directory: drafts } : {}) };
  atomic_json(access_path, access);
  const adapter = adapter_profile(record.ai.adapter);
  const cli = process.platform === 'win32' ? adapter?.windows_command || 'codiscuss.cmd' : 'codiscuss';
  const requests = execution.requests || [];
  const messages = requests.map(item => `#${item.message_id}`).join('、');
  const directories = record.open_level === 'read' ? record.directories || [] : [];
  const { instructions, prompt } = external_task_text({ name: record.member, messages, requests, cli, access_file: access_path, task_path, lockdown, draft_directory: drafts, directories });
  const skills_directory = join(PACKAGE_ROOT, '.agents', 'skills');
  atomic_json(task_path, { site: record.site, room: record.room, mode: 'free', member: record.member, external: true,
    execution_id: execution.id, requests, request_messages: requests.map(item => item.message_id), read_after: execution.read_until ?? null,
    role: 'member', cwd: null, project_access: 'read', draft_directory: drafts, open_level: record.open_level, directories,
    skills: ['discuss-participant/SKILL.md', 'discuss-participant/references/room.md'].map(file => join(skills_directory, file)),
    cli, subcommands: TASK_SUBCOMMANDS, access_file: access_path, tool_lockdown: lockdown, instructions });
  // 不受限 means the AI works on this computer as usual (全放开): a sandbox would run its commands as another Windows
  // account, which cannot open the record's credential (DPAPI, current user), so its `codiscuss` calls would all fail.
  // A locked-down run is confined by the tool rules instead and keeps read-only.
  const profile = { adapter: record.ai.adapter, ...software, model: record.ai.model || software.model || '', effort: record.ai.effort, cwd: workdir, project_access: lockdown ? 'read' : 'full',
    // No own prompt, not even one left in an older record or in this software's local settings.
    system_prompt: '' };
  const log_path = join(base, `external-${execution.id}.log`);
  const deliver = deps.deliver || (await import('./adapters/index.mjs')).deliver_task;
  const result = await deliver(profile, { session_id: record.session_id || '' }, {
    id: `external-${execution.id}`, participant: record.member, directory: base, member_directory: base, task_path, access_path,
    draft_directory: drafts, extra_directories: [], skill_directories: [skills_directory], prompt: resume || prompt, profile, images: [],
    tool_lockdown: lockdown, room_title: record.room_title,
    // For the model API: its room and repo tools go through `proxy_request` / `repo_command` with `external_access`;
    // no member credential or key is passed (CONTRACT §5.1).
    api_context: { home, site: record.site, room: record.room, mode: 'free', role: 'member', execution_id: execution.id, requests,
      read_after: execution.read_until ?? null, cwd: null, project_access: 'read', extra_directories: [], external_access: access },
    on_binding: session => bind_session(home, record.id, session),
    on_process: handle => run_processes.set(execution.id, { handle, end }), on_activity: () => {}, on_note: () => {}, on_edits: () => {}, on_denials: take_denials,
    on_output: (path, chunk) => appendFileSync(log_path, chunk, { mode: 0o600 }),
    on_failure: error => end(String(error?.message || error || t('执行失败'))),
    // The adapter names an operation its rules refused (a run that cannot ask ends right after). The full text names
    // this computer's paths and the refused command, so it stays here; the inviting room hears only that it was refused.
    on_exit: denial => end(denial ? { local: t('{member} {denial}，未提交本次回答', { member: record.member, denial }),
      shared: t('{member} 的操作被本机权限规则拒绝，未提交本次回答', { member: record.member }) } : ''),
  });
  if (result?.session_id) bind_session(home, record.id, result.session_id);
  // This computer cannot pass on a stop from the inviting room, nor live progress.
  await member_api(home, record.id, 'POST', MEMBER_API.execution(record.room, execution.id), { action: 'delivery', stoppable: false, progress: false }, deps)
    .catch(error => deps.log?.(error.message));
}

// The software process of each run in this service, by execution: stopped when the inviting room has closed the execution
// while the process stays (it answered, or the run was cancelled there, yet the software never exits).
const run_processes = new Map();

/** The inviting room no longer has this execution open: stop what still runs here and settle it as it ended there. */
async function settle_closed_run(home, id, execution_id, deps) {
  const run = run_processes.get(execution_id);
  try { run?.handle?.kill?.(); } catch (error) { deps.log?.(error.message); }
  // The run's own ending settles it once, whichever comes first; a run this service did not start is settled here.
  if (run) run.end('');
  else await finish(home, id, execution_id, '', deps);
}

function bind_session(home, id, session_id) {
  if (!session_id) return;
  with_store(home, store => { if (store.records[id]) store.records[id].session_id = String(session_id); });
}

/**
 * A run ended: free the record, then ask the inviting room how it went there, since only it knows whether an answer bound
 * to this execution arrived (red line 4). Answered → recorded as answered, even when the process ended with an error (kept
 * as a note); still open there → failed, and the room is told why, as the room runner does; closed there without an
 * answer (cancelled, retracted) → ended.
 */
/** The last part of a run's output on this computer, without terminal colour codes; empty when it wrote nothing. */
function run_output(home, id, execution_id) {
  const path = join(external_home(home), 'runtime', id, `external-${execution_id}.log`);
  if (!existsSync(path)) return '';
  const text = readFileSync(path, 'utf8').replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').trim();
  return text.length > OUTPUT_TAIL ? `…${text.slice(-OUTPUT_TAIL)}` : text;
}

async function finish(home, id, execution_id, reason, deps, retry = null) {
  run_processes.delete(execution_id);
  change_record(home, id, record => { if (record.running?.execution_id === execution_id) record.running = null; });
  const record = read_store(home).records[id];
  const answers = await member_api(home, id, 'GET', `${MEMBER_API.messages(record.room)}?${new URLSearchParams({ author: record.member })}`, undefined, deps)
    .catch(() => null);
  const answer = (answers?.messages || []).find(message => message.execution_id === execution_id);
  const answered = Boolean(answer);
  const inbox = answered ? null : await member_api(home, id, 'GET', MEMBER_API.inbox(record.room), undefined, deps).catch(() => null);
  // Unknown (the other computer not reachable) counts as open, so the failure is reported once it can be.
  const open = !answered && (!inbox || (inbox.executions || []).some(item => item.id === execution_id));
  // Still open without an answer, and the AI can correct what was refused: it runs again in the same session first.
  if (open && !answered && retry) {
    change_record(home, id, (current, now) => {
      current.running = { execution_id, started_at: now, last_renew: deps.now?.() ?? now };
      remember(current, { execution_id, outcome: 'woken', message_ids: [], note: 'refusal_retry' }, now);
    });
    return retry();
  }
  const outcome = answered ? 'answered' : open ? 'failed' : 'ended';
  // `reason` is one text for both sides, or `{ local, shared }` when what this computer keeps must not leave it.
  const { local = reason, shared = reason } = reason && typeof reason === 'object' ? reason : {};
  const text = local || t('{member} 会话已结束，但未提交本次回答', { member: record.member });
  const output = answered ? '' : run_output(home, id, execution_id);
  change_record(home, id, (current, now) => remember(current, { execution_id, outcome, ...(output ? { output } : {}),
    ...(answer ? { answer: { id: answer.id, author: String(answer.author || record.member), text: clip(answer.text) } } : {}),
    ...(local ? { reason: local } : open ? { reason: text, reason_text: { template: '{member} 会话已结束，但未提交本次回答', params: { member: record.member } } } : {}) }, now));
  if (!open) return;
  try { await member_api(home, id, 'POST', MEMBER_API.execution(record.room, execution_id), { action: 'fail', reason: (shared || text).slice(0, 400) }, deps); }
  catch (error) { if (error.status !== 409) deps.log?.(t('未能向对方上报执行 #{execution} 的结束：{reason}', { execution: execution_id, reason: error.message })); }
}

/** Waiting requests not answered in time are reported as not agreed to. */
async function expire_approvals(home, id, deps, now) {
  const expired = with_store(home, (store, secrets) => {
    const record = store.records[id];
    if (!record) return [];
    const due = (record.approvals || []).filter(item => item.status === 'waiting' && item.expires_at <= now);
    for (const item of due) { item.status = 'timeout'; remember(record, { request_ids: item.request_ids, message_ids: item.message_ids, outcome: 'timeout' }, now); }
    record.approvals = (record.approvals || []).filter(item => ['waiting', 'approved'].includes(item.status));
    return due;
  });
  for (const item of expired) await decline(home, id, item.request_ids, 'timeout', deps);
}

/**
 * Tell the inviting room when this AI differs from what it last heard. Retried on later passes until that computer
 * answers; one that refuses (an older version has no such route) is not asked again for this AI.
 */
async function report_ai(home, record, deps) {
  const identity = ai_identity(home, record.ai), reported = JSON.stringify(identity);
  if (record.ai_reported === reported) return;
  try { await member_api(home, record.id, 'POST', MEMBER_API.ai(record.room), identity, deps); }
  catch (error) { if (!(error.status >= 400 && error.status < 500)) return; }
  change_record(home, record.id, current => { current.ai_reported = reported; });
}

/**
 * One pass for one record: expire waiting approvals; renew a running execution; otherwise read the requests named for
 * this member and wake the AI when the owner approved them or the trust level allows it, or queue them for consent.
 */
export async function poll_record(home, id, deps = {}) {
  if (read_store(home).records[id]?.leave_pending) return deliver_leave(home, id, deps);
  const now = deps.now?.() ?? Date.now();
  await expire_approvals(home, id, deps, now);
  const store = read_store(home), record = store.records[id];
  if (!record || record.status !== 'active') return { skipped: true };
  await report_ai(home, record, deps);
  if (record.running) {
    if (now - record.running.last_renew < RENEW_MS) return { running: record.running.execution_id };
    try { await member_api(home, id, 'POST', MEMBER_API.execution(record.room, record.running.execution_id), { action: 'renew' }, deps); }
    catch (error) {
      // 409: the execution is closed there (answered, cancelled, retracted) while the process here never ended.
      if (error.status !== 409) throw error;
      await settle_closed_run(home, id, record.running.execution_id, deps);
      return { running: null, settled: record.running.execution_id };
    }
    change_record(home, id, current => { if (current.running) current.running.last_renew = now; });
    return { running: record.running.execution_id, renewed: true };
  }
  if (record.paused) return { skipped: true };
  const inbox = await member_api(home, id, 'GET', MEMBER_API.inbox(record.room), undefined, deps);
  if (Number(inbox.member?.expires_at)) change_record(home, id, current => { current.expires_at = Number(inbox.member.expires_at) * 1000; });
  if (!(now - (record.grant_checked_at || 0) < VIEW_REFRESH_MS)) await refresh_grant(home, id, deps);
  const pending = (inbox.pending || []).filter(item => Number.isInteger(item.id));
  const pending_ids = new Set(pending.map(item => item.id));
  // An approved request that is gone there (cancelled meanwhile) needs nothing more.
  const approved = (record.approvals || []).filter(item => item.status === 'approved' && item.request_ids.some(request => pending_ids.has(request)));
  if (approved.length || (pending.length && wakes_directly(record, store, now))) {
    if (approved.length) return { execution_id: await wake(home, id, approved.flatMap(item => item.request_ids).filter(request => pending_ids.has(request)), deps, { only: true }) };
    return { execution_id: await wake(home, id, [...pending_ids], deps) };
  }
  const known = new Set((record.approvals || []).flatMap(item => item.request_ids));
  const fresh = pending.filter(item => !known.has(item.id));
  if (!fresh.length) return { pending: pending.length };
  const approval = change_record(home, id, current => {
    const item = { id: randomBytes(6).toString('hex'), status: 'waiting', request_ids: fresh.map(entry => entry.id),
      message_ids: fresh.map(entry => entry.message_id), purpose: fresh[0].purpose || 'ask', created_by: fresh[0].created_by || 'user',
      received_at: now, expires_at: now + APPROVAL_TIMEOUT_MS };
    current.approvals = [...(current.approvals || []).filter(entry => entry.status !== 'approved'), item];
    return item;
  });
  deps.notify?.({ record: id, approval: approval.id });
  return { approval: approval.id };
}

/**
 * Pull for every active record in the service until stopped. Records are pulled side by side, since each pull crosses
 * the relay several times; one record's failure never holds up the others.
 */
export function start_external_client(home, { log = () => {}, signal, deps = {} } = {}) {
  const loop = async () => {
    while (!signal?.aborted) {
      const ids = Object.values(read_store(home).records).filter(record => record.status === 'active' || record.leave_pending).map(record => record.id);
      await Promise.all(ids.map(id => poll_record(home, id, { log, ...deps })
        .catch(error => { if (!error.offline) log(t('被邀请房间 {id} 拉取失败：{reason}', { id, reason: error.message })); })));
      await new Promise(done => { const timer = setTimeout(done, POLL_MS); signal?.addEventListener('abort', () => { clearTimeout(timer); done(); }, { once: true }); });
    }
  };
  return loop().catch(error => log(t('被邀请房间拉取停止：{reason}', { reason: error.message })));
}

// ---- The AI's entry: requests from discuss.py and `codiscuss repo` ----

function external_access(access) {
  if (access?.transport !== 'external' || !RECORD_ID.test(String(access.record || ''))) {
    throw failure('not_external', '只有经另一台电脑加入的成员才能这样访问；请用任务给出的 --access-file');
  }
  return access;
}

/**
 * Where a room command of discuss.py goes for an external member (子Task1 CONTRACT §3): reading messages and the room,
 * and posting the answer bound to its execution. Anything else has no external route and is refused.
 */
export function external_route(room, method, path, body) {
  const [route, query = ''] = path.split('?');
  const suffix = query ? `?${query}` : '';
  const own = `/api/rooms/${room}`;
  if (route.startsWith(`${EXTERNAL_PREFIX(room)}/`)) return { method, path, body };
  if (method === 'GET' && route === own) return { method, path: MEMBER_API.view(room) };
  if (method === 'GET' && /^\/messages(\/\d+)?$/.test(route.slice(own.length)) && route.startsWith(`${own}/`)) {
    return { method, path: `${EXTERNAL_PREFIX(room)}${route.slice(own.length)}${suffix}` };
  }
  if (method === 'POST' && route === `${own}/messages`) {
    const { text, execution_id, submission_id, summary } = body || {};
    return { method, path: MEMBER_API.answer(room), body: { text, execution_id, submission_id, ...(summary ? { summary } : {}) } };
  }
  return null;
}

/**
 * One room request from discuss.py on behalf of an external task: only this record's room passes, mapped to its
 * member-scope route; the record's credential and key are added here. Answers `{status, body}`.
 */
export async function proxy_request(home, request, deps = {}) {
  const access = external_access(request.access);
  const record = find_record(read_store(home), access.record);
  if (record.status !== 'active') return { status: 403, body: { error: t('已退出这个外部房间') } };
  const path = String(request.path || '');
  const target = access.room === record.room && !path.includes('..') && ['GET', 'POST'].includes(request.method)
    ? external_route(record.room, request.method, path, request.body) : null;
  if (!target) return { status: 403, body: { error: t('外部成员只能读本房间消息与概况、提交自己的回答') } };
  return record_send(home, record.id, 'external-api', { method: target.method, path: target.path, ...(target.body == null ? {} : { body: target.body }) }, deps);
}

const REPO_REASONS = {
  excluded: '该文件属于固定排除的敏感文件，不能读取', not_in_scope: '不在对方开放的范围内（或不存在）', path_traversal: '路径不能含 ..',
  absolute_path: '请用相对开放目录的路径', outside_root: '链接指向开放目录之外', not_a_file: '这是目录，请用 repo ls', not_a_directory: '这是文件，请用 repo read',
  binary: '二进制或不支持的编码，不能读取', invalid_query: '搜索词须为 1–256 个字符且不含换行', invalid_path: '路径格式不对', scope_unavailable: '对方电脑暂时无法确定开放范围',
};

/** `codiscuss repo ls|read|grep`: read the other computer's opened project through its relay (子Task2 CONTRACT §4.3). */
export async function repo_command(home, op, options, access, deps = {}) {
  external_access(access);
  if (!['ls', 'read', 'grep'].includes(op)) throw failure('repo_usage', '用法：codiscuss repo ls [目录] | read 文件 | grep 关键词');
  const answer = await record_send(home, access.record, 'external-repo', { op, ...options }, deps);
  const body = answer.body || {};
  if (answer.status >= 400 || body.ok === false) {
    const reason = body.reason || '';
    throw REPO_REASONS[reason] ? failure(`repo_${reason}`, REPO_REASONS[reason], undefined, { reason }) : remote_failure(body, 'repo_refused', '读取被拒绝', undefined, { reason });
  }
  return body;
}

// ---- Restricted runs (子Task5 CONTRACT §5) ----

const LAUNCH_FILE_FLAGS = new Set(['--file', '--draft', '--dir']);

/**
 * `codiscuss launch …` in a restricted run (`CODISCUSS_TOOL_LOCKDOWN=1`): `launch image` reads local files and is refused;
 * other file flags must name a path inside `CODISCUSS_LOCKDOWN_DIRECTORY`, and standard input is refused. Throws.
 */
export function lockdown_launch_guard(args, env = process.env) {
  if (env.CODISCUSS_TOOL_LOCKDOWN !== '1') return;
  if (args[0] === 'image') throw failure('lockdown_image', '本次运行已收窄，不能使用 launch image（它会读取本机文件）');
  if (args.includes('--stdin')) throw failure('lockdown_stdin', '本次运行已收窄，不能从标准输入读取；请先把内容写进草稿目录，再用文件参数传入');
  const real = path => { try { return realpathSync(path); } catch { return resolve(path); } };
  const folder = env.CODISCUSS_LOCKDOWN_DIRECTORY ? real(env.CODISCUSS_LOCKDOWN_DIRECTORY) : '';
  args.forEach((arg, index) => {
    const [flag, inline] = arg.split(/=(.*)/s);
    if (!LAUNCH_FILE_FLAGS.has(flag)) return;
    const value = inline ?? args[index + 1] ?? '';
    const target = value === '-' ? '' : real(value);
    const inside = folder && target && (target === folder || target.startsWith(`${folder}${sep}`));
    if (!inside) throw failure('lockdown_path', '本次运行已收窄，只能读取草稿目录 {folder} 里的文件', { folder: folder || '-' });
  });
}

// ---- Command line ----

function load_access(path) {
  const file = path || process.env.DISCUSS_ACCESS_FILE;
  if (file) return JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
  return process.env.DISCUSS_ACCESS ? JSON.parse(process.env.DISCUSS_ACCESS) : {};
}

const integer = value => value === undefined ? undefined : Number(value);

function print_record(record) {
  const wake = record.wake === 'ask' ? t('先问我') : t('直接回答');
  const scope = record.confined ? t('只在房间里发言') : t('不受限');
  const contact = { online: t('在线'), offline: t('不在线'), error: t('出错'), unknown: t('未知') }[record.contact?.state || 'unknown'];
  const lines = [t('{id}  {room}（{site}）成员 {member}', { id: record.id, room: record.room_title || record.room, site: record.site, member: record.member }),
    t('  被点名时：{wake}；在这台电脑上：{scope}；已唤醒 {wakes} 次；对方电脑：{contact}{paused}', { wake, scope, wakes: record.wakes, contact, paused: record.paused ? t('；已暂停') : '' })];
  if (record.status === 'active' && record.expires_at) lines.push(t('  借出到 {time}', { time: new Date(record.expires_at).toLocaleString() }));
  for (const item of record.approvals) lines.push(t('  待确认 {approval}：消息 {messages}', { approval: item.id, messages: item.message_ids.map(n => `#${n}`).join(', ') }));
  if (record.status === 'left') lines.push(t('  已退出'));
  if (record.status === 'ended') lines.push(t('  对方已结束你的成员资格（{reason}）', { reason: record.end_reason }));
  return lines.join('\n');
}

const HELP = () => t(`外部房间（本机 AI 作为外部成员参加另一台电脑上的房间）

用法：
  codiscuss join <链接|配对码> [--site 站点] [--machine 电脑编号] --adapter 软件 [--model M] [--effort E] [--session 会话] [--duration 1h|today|3d]
  codiscuss invited list
  codiscuss invited trust ID auto|ask [--unconfined|--confined]
  codiscuss invited ai ID [--adapter 软件] [--model M] [--effort E]
  codiscuss invited pause ID | resume ID
  codiscuss invited lend ID 1h|today|3d
  codiscuss invited approve ID 待确认编号 | refuse ID 待确认编号
  codiscuss invited leave ID
  codiscuss invited remove ID
  codiscuss invited room ID

被点名时：auto 直接回答；ask 每次先问你。
本机权限：默认只在房间里发言（只能运行共议命令）；--unconfined 不受限，可读本机文件、联网。
借出时间：加入时用 --duration 选择（默认 1h），之后用 lend 从现在起重新计算，最长 3 天。
--session 续接这个软件已有的会话（带着原上下文加入）。
同意后由本机服务唤醒 AI，请保持 codiscuss 服务运行。加 --json 输出 JSON。
`);

const REPO_HELP = () => t(`只读查看对方电脑开放的项目（仅外部成员的任务中可用）

用法：
  codiscuss repo ls                        列出开放目录（序号即 --root）
  codiscuss repo ls [目录] --root N [--offset N] [--limit N]
  codiscuss repo read 文件 --root N [--offset N] [--max-bytes N]
  codiscuss repo grep 关键词 --root N [--path 路径] [--case-sensitive] [--max-results N]
凭据取自 --access-file 或 DISCUSS_ACCESS_FILE。
`);

/** `codiscuss join`, `codiscuss invited …`, `codiscuss repo …` and the internal `codiscuss external-proxy`. */
export async function external_main(command, args, { home, deps = {}, write = text => process.stdout.write(text), read_stdin = () => readFileSync(0, 'utf8') } = {}) {
  const service = home || (await import('./discussion_service.mjs')).service_home();
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    site: { type: 'string' }, machine: { type: 'string' }, adapter: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' },
    session: { type: 'string' }, duration: { type: 'string' },
    label: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    unconfined: { type: 'boolean' }, confined: { type: 'boolean' },
    'access-file': { type: 'string' }, root: { type: 'string' }, offset: { type: 'string' }, limit: { type: 'string' }, 'max-bytes': { type: 'string' },
    path: { type: 'string' }, 'case-sensitive': { type: 'boolean' }, 'max-results': { type: 'string' },
  } });
  const out = value => write(`${JSON.stringify(value)}\n`);
  if (command === 'external-proxy') return out(await proxy_request(service, JSON.parse(read_stdin()), deps).catch(error => ({ status: error.offline ? 503 : 502, body: { error: error.message } })));
  if (command === 'repo') {
    if (values.help || !positionals.length) return write(REPO_HELP());
    const [op, target] = positionals;
    const options = { ...(values.root !== undefined ? { root: integer(values.root) } : {}), ...(values.offset !== undefined ? { offset: integer(values.offset) } : {}),
      ...(op === 'grep' ? { query: target, ...(values.path ? { path: values.path } : {}), case_sensitive: Boolean(values['case-sensitive']),
        ...(values['max-results'] ? { max_results: integer(values['max-results']) } : {}) } : target !== undefined ? { path: target } : {}),
      ...(values.limit ? { limit: integer(values.limit) } : {}), ...(values['max-bytes'] ? { max_bytes: integer(values['max-bytes']) } : {}) };
    return out(await repo_command(service, op, options, load_access(values['access-file']), deps));
  }
  if (values.help || (command === 'invited' && !positionals.length) || (command === 'join' && !positionals.length)) return write(HELP());
  const ai = { ...(values.adapter ? { adapter: values.adapter } : {}), ...(values.model !== undefined ? { model: values.model } : {}), ...(values.effort !== undefined ? { effort: values.effort } : {}) };
  let result;
  if (command === 'join') result = await join_invite(service, { invite: positionals[0], site: values.site, machine: values.machine, label: values.label, ...(values.session ? { session_id: values.session } : {}), ...(values.duration ? { duration: values.duration } : {}), ...ai }, deps);
  else {
    const [verb, id, extra] = positionals;
    const action = { list: 'invited-list', trust: 'invited-trust', ai: 'invited-ai', pause: 'invited-pause', resume: 'invited-pause', approve: 'invited-approve',
      refuse: 'invited-refuse', lend: 'invited-lend', leave: 'invited-leave', remove: 'invited-remove', room: 'invited-room' }[verb];
    if (!action) return write(HELP());
    // `trust ID auto|ask` sets how it answers; the old single levels (default / borrow / trusted) are still understood.
    const setting = !extra ? {} : LEGACY_TRUST[extra] ? { trust: extra } : { wake: extra };
    const scope = values.unconfined ? { confined: false } : values.confined ? { confined: true } : {};
    const input = { id, ...(verb === 'trust' ? { ...setting, ...scope } : {}),
      ...(verb === 'ai' ? ai : {}), ...(['pause', 'resume'].includes(verb) ? { paused: verb === 'pause' } : {}), ...(['approve', 'refuse'].includes(verb) ? { approval: extra } : {}), ...(verb === 'lend' ? { duration: extra } : {}) };
    result = await invited_command(service, action, input, deps);
  }
  if (values.json) return out(result);
  if (result.records) return write(`${result.records.length ? result.records.map(print_record).join('\n') : t('还没有外部房间')}\n`);
  if (result.removed) return write(`${t('已删除这条被邀请记录')}\n`);
  return write(`${print_record(result.record)}${result.record?.leave_pending ? `\n${t('暂时连不上对方电脑，常驻服务会继续通知它；通知送达或成员资格到期后删除本机密钥')}` : ''}${result.error ? `\n${t('读不到对方房间：{reason}', { reason: result.error })}` : ''}\n`);
}

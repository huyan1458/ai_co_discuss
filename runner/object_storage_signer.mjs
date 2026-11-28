import { timingSafeEqual } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { CLOUD_STORAGE_RESERVED_NAME, object_key, object_quota_path, object_storage_quota } from './attachment_policy.mjs';
import { atomic_json } from './files.mjs';
import { t } from './i18n.mjs';

const MIB = 1024 ** 2;
const MAX_BYTES = 2 * 1024 * MIB;
const PENDING_MS = 24 * 60 * 60 * 1000;
const UPSTREAM_TIMEOUT_MS = 5_000;
const DOWNLOAD_SECONDS = 600;
const STORAGE_ACTIONS = new Set(['upload-credential', 'presigned-download-url', 'file-info', 'file']);

function cloud_error(status, template, params = {}) {
  return Object.assign(new Error(t(template, params)), { status, error_text: { template, params } });
}

const unavailable = () => cloud_error(503, '对象存储暂不可用');
const ledger_directory = data => join(data, 'local', 'object-storage-admin');
const grant_path = (data, account) => join(ledger_directory(data), account + '.grant');
const ledger_path = (data, account) => join(ledger_directory(data), account + '.json');

/** Keep authorization and quota accounting outside all hosted users' writable directories. */
export function grant_admin_storage(data, account, enabled) {
  const path = grant_path(data, account);
  if (enabled) {
    mkdirSync(ledger_directory(data), { recursive: true, mode: 0o700 });
    atomic_json(path, true);
  } else {
    rmSync(path, { force: true });
  }
}

export function admin_storage_granted(data, account) {
  if (account === CLOUD_STORAGE_RESERVED_NAME) return false;
  try { return JSON.parse(readFileSync(grant_path(data, account), 'utf8')) === true; }
  catch { return false; }
}

function authenticate(token_for, data, account, authorization) {
  if (typeof account === 'string' && /^[a-z0-9][a-z0-9_-]{1,31}$/.test(account) &&
      typeof authorization === 'string' && /^Bearer [0-9a-f]{64}$/.test(authorization) && admin_storage_granted(data, account)) {
    const token = token_for(account);
    if (typeof token === 'string' && /^[0-9a-f]{64}$/.test(token) &&
        timingSafeEqual(Buffer.from(token), Buffer.from(authorization.slice(7)))) return;
  }
  throw cloud_error(403, '管理员云空间代签未授权');
}

function checked_name(account, name) {
  if (typeof name !== 'string' || !name.startsWith('codiscuss/' + account + '/') ||
      Buffer.byteLength(name, 'utf8') > 1024 || /[\\\p{Cc}\p{Cs}]|%[0-9a-f]{2}/iu.test(name) ||
      name.includes('$' + '{filename}') ||
      name.split('/').some(part => !part || part === '.' || part === '..'))
    throw cloud_error(403, '对象路径不在本账号的云空间内');
  return name;
}

async function center_request(credentials, action, name, upload) {
  const method = action === 'file' ? 'DELETE' : upload ? 'POST' : 'GET';
  const params = new URLSearchParams({ fileName: name });
  if (action === 'presigned-download-url') params.set('expiresIn', String(DOWNLOAD_SECONDS));
  const body = upload && JSON.stringify({ fileName: name, maxSizeBytes: upload.size, contentType: upload.content_type });
  let response, result;
  try {
    response = await fetch(credentials.base_url + '/' + action + (body ? '' : '?' + params), {
      method, body: body || undefined, redirect: 'error', signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      headers: { 'X-Api-Key': credentials.api_key.trim(), Accept: 'application/json', 'Content-Type': 'application/json' },
    });
    result = response.status === 404 ? null : await response.json();
  } catch { throw unavailable(); }
  if (action !== 'upload-credential' && (response.status === 404 || result?.code === 404 || result?.code === '404'))
    throw cloud_error(404, '文件已不在对象存储中');
  if (!response.ok || result?.succeed !== true) throw unavailable();
  return result.data;
}

function checked_ticket(ticket, name, size, now) {
  // The client may change form values. Require the signed policy to constrain the exact key and size.
  const { key, url, policy, qAk, qKeyTime, qSignature, qSignAlgorithm } = ticket ?? {};
  if (![key, url, policy, qAk, qKeyTime, qSignature, qSignAlgorithm].every(value => typeof value === 'string' && value) ||
      (key !== name && !key.endsWith('/' + name))) throw unavailable();
  let parsed;
  try { parsed = JSON.parse(Buffer.from(policy, 'base64').toString('utf8')); }
  catch { throw unavailable(); }
  const { expiration, conditions } = parsed ?? {};
  const expires = Date.parse(expiration);
  if (!Number.isFinite(expires) || expires <= now || !Array.isArray(conditions) ||
      !conditions.some(rule => rule?.key === key || rule?.[0] === 'eq' && rule[1] === '$key' && rule[2] === key) ||
      !conditions.some(rule => rule?.[0] === 'content-length-range' && Number.isSafeInteger(rule[2]) && rule[2] <= size))
    throw unavailable();
  return { expires, ticket: { key, url, policy, qAk, qKeyTime, qSignature, qSignAlgorithm } };
}

function read_ledger(path, base_url) {
  try {
    const record = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(record.entries)) throw unavailable();
    const ledger = new Map(record.entries);
    if (ledger.size && record.base_url !== base_url) throw unavailable();
    return ledger;
  } catch (error) {
    if (error.code === 'ENOENT') return new Map();
    throw unavailable();
  }
}

async function remove_object(credentials, name) {
  try { await center_request(credentials, 'file', name); }
  catch (error) { if (error.status !== 404) throw error; }
}

async function sweep_account(credentials, ledger, save, now) {
  let failure;
  for (const [name, row] of ledger) {
    if (row.expires > now || (!row.deleting && (row.stored || row.started + PENDING_MS > now))) continue;
    try {
      await remove_object(credentials, name);
      ledger.delete(name);
      save();
    } catch (error) { failure = error; }
  }
  if (failure) throw failure;
}

async function issue_ticket(context, name, upload) {
  const { account, credentials, data, ledger, save, now } = context;
  const { size, content_type } = upload;
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_BYTES ||
      typeof content_type !== 'string' || content_type.length > 127 ||
      !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(content_type))
    throw cloud_error(400, '云空间上传参数无效');
  const existing = ledger.get(name);
  if (existing && (existing.deleting || existing.size !== size)) throw cloud_error(409, '云空间上传预留不匹配');
  const quota_mib = object_storage_quota(object_quota_path(data, account));
  const used = [...ledger.values()].reduce((total, row) => total + row.size, 0);
  if (!existing && used + size > quota_mib * MIB)
    throw cloud_error(409, '云空间已用 {used} 字节，上限 {quota} MiB，请先清理云空间', { used, quota: quota_mib });
  const result = checked_ticket(await center_request(credentials, 'upload-credential', name, upload), name, size, now);
  // Persist before the ticket crosses the trust boundary. A timeout, restart or lost reply cannot skip accounting.
  ledger.set(name, { ...(existing || { size, started: now }), expires: Math.max(existing?.expires || 0, result.expires) });
  save();
  return result.ticket;
}

async function access_object(context, action, name) {
  const { credentials, ledger, save, now } = context;
  const row = ledger.get(name);
  if (action === 'file') {
    if (row && !row.deleting) { row.deleting = true; save(); }
    await remove_object(credentials, name);
    if (row && row.expires <= now) { ledger.delete(name); save(); }
    return null;
  }
  const result = await center_request(credentials, action, name);
  if (action === 'presigned-download-url') return { url: result?.url, expiresAt: result?.expiresAt };
  const { size, isDirectory } = result ?? {};
  if (!Number.isSafeInteger(size) || size < 0 || isDirectory) throw unavailable();
  if (row && !row.deleting && !row.stored) {
    if (size === row.size) row.stored = true;
    else row.deleting = true;
    save();
  }
  return { size };
}

/** Authorize the account, scope every operation and serialize all changes to an account's quota. */
export function create_object_storage_signer(data, token_for, clock = Date.now) {
  const queues = new Map();
  function serialized(account, run) {
    const pending = (queues.get(account) || Promise.resolve()).catch(() => {}).then(run);
    queues.set(account, pending);
    return pending.finally(() => { if (queues.get(account) === pending) queues.delete(account); });
  }
  function open_account(account) {
    const credentials = object_key(data);
    if (!credentials) throw unavailable();
    const { base_url } = credentials;
    const path = ledger_path(data, account), ledger = read_ledger(path, base_url);
    return { account, data, credentials, ledger, now: clock(), save: () => atomic_json(path, { base_url, entries: [...ledger] }) };
  }
  return {
    request(action, body, authorization) {
      const { account, name } = body ?? {};
      authenticate(token_for, data, account, authorization);
      checked_name(account, name);
      if (!STORAGE_ACTIONS.has(action)) throw cloud_error(404, '接口不存在');
      return serialized(account, async () => {
        authenticate(token_for, data, account, authorization);
        const context = open_account(account);
        return action === 'upload-credential' ? issue_ticket(context, name, body) : access_object(context, action, name);
      });
    },
    async sweep() {
      let paths;
      try { paths = readdirSync(ledger_directory(data)); }
      catch (error) { if (error.code === 'ENOENT') return; throw error; }
      const accounts = paths.filter(path => /^[a-z0-9][a-z0-9_-]{1,31}\.json$/.test(path) && path !== CLOUD_STORAGE_RESERVED_NAME + '.json')
        .map(path => path.slice(0, -5));
      const results = await Promise.allSettled(accounts.map(account => serialized(account, async () => {
        const { credentials, ledger, save, now } = open_account(account);
        await sweep_account(credentials, ledger, save, now);
      })));
      const failure = results.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
    },
  };
}

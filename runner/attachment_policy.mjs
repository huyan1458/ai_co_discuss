import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { t } from './i18n.mjs';
import { api_base_url, read_saved_api_key_record } from './discussion_api.mjs';
import { atomic_json } from './files.mjs';

export const policy = JSON.parse(readFileSync(new URL('../backend/attachment_policy.json', import.meta.url), 'utf8'));
export const CLOUD_STORAGE_RESERVED_NAME = 'cloud';
export const policy_path = home => process.env.DISCUSS_ATTACHMENT_POLICY_FILE || join(home, 'local', 'attachment-limit.json');
export const object_quota_path = (home, account = '') => join(home, 'local', `object-storage-quota${account ? '-' + account : ''}.json`);
const object_storage_path = home => join(home, 'object-storage-settings.json');
const MIN_RETENTION_DAYS = 0;
const MAX_RETENTION_DAYS = 30;
const DEFAULT_RETENTION_DAYS = 0;
const DEFAULT_QUOTA_MIB = 10240;
const MAX_QUOTA_MIB = 1048576;
const DEFAULT_THRESHOLD_MIB = 20;
const warned_limits = new Set();

export function checked_limit(value) {
  if (!Number.isInteger(value) || value < policy.min_mib || value > policy.max_mib)
    throw new Error(t('附件上限须为 {min} 到 {max} MiB 的整数', { min: policy.min_mib, max: policy.max_mib }));
  return value;
}

export function attachment_limit(home) {
  const path = policy_path(home);
  try {
    const limit = checked_limit(JSON.parse(readFileSync(path, 'utf8')));
    warned_limits.delete(path);
    return limit;
  } catch (error) {
    if (error.code !== 'ENOENT' && !warned_limits.has(path)) {
      warned_limits.add(path);
      console.warn(t('无法读取附件上限，使用默认值 {limit} MiB', { limit: policy.default_mib }));
    }
    return policy.default_mib;
  }
}

export function save_attachment_limit(home, value) {
  checked_limit(value);
  save_readonly_number(policy_path(home), value);
  return { limit_mib: value };
}

function save_readonly_number(path, value) {
  const temporary = path + '.' + randomUUID();
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(temporary, String(value), { flag: 'wx', mode: 0o644 });
    // Isolated Windows accounts need read access to this single numeric setting.
    if (process.platform === 'win32') execFileSync('icacls.exe', [temporary, '/grant', '*S-1-5-32-545:R'], { windowsHide: true });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}

/** Read this account's settings separately from any key inherited by other services. */
function object_storage_settings(home, limit = attachment_limit(home)) {
  const path = object_storage_path(home);
  let saved = null, base_url = '';
  try {
    if (lstatSync(path).isFile()) saved = JSON.parse(readFileSync(path, 'utf8'));
    if (saved?.mode !== 'admin' && saved?.base_url) base_url = checked_storage_url(saved.base_url);
  } catch { /* Missing or invalid binding. */ }
  return {
    mode: saved?.mode === 'admin' ? 'admin' : 'own',
    base_url, api_key_ref: saved?.mode !== 'admin' && typeof saved?.api_key_ref === 'string' ? saved.api_key_ref : '',
    retention_days: integer_in(saved?.retention_days, MIN_RETENTION_DAYS, MAX_RETENTION_DAYS) ? saved.retention_days : DEFAULT_RETENTION_DAYS,
    object_threshold_mib: integer_in(saved?.object_threshold_mib, 1, limit) ? saved.object_threshold_mib : Math.min(DEFAULT_THRESHOLD_MIB, limit),
  };
}

function storage_error(template, params = {}) {
  return Object.assign(new Error(t(template, params)), { error_text: { template, params } });
}

function integer_in(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

/** Check the requested retention period before saving it. */
export function checked_retention(value) {
  if (!integer_in(value, MIN_RETENTION_DAYS, MAX_RETENTION_DAYS))
    throw storage_error('保留天数须为 0 到 30 的整数');
  return value;
}

/** Check the account cloud quota, in MiB. */
export function checked_quota(value) {
  if (!integer_in(value, 1, MAX_QUOTA_MIB))
    throw storage_error('云空间上限须为 1 到 {max} MiB 的整数', { max: MAX_QUOTA_MIB });
  return value;
}

/** Read the administrator-owned quota. Absence or invalid data means the account default. */
export function object_storage_quota(file) {
  try { return checked_quota(JSON.parse(readFileSync(file, 'utf8'))); }
  catch { return DEFAULT_QUOTA_MIB; }
}

/** Set a quota in the administrator's directory, granting isolated accounts read-only access. */
export function save_object_quota(file, value) {
  save_readonly_number(file, checked_quota(value));
}

/** Check the cloud threshold against this instance's ordinary attachment cap. */
export function checked_threshold(value, limit = policy.max_mib) {
  if (!integer_in(value, 1, limit))
    throw storage_error('云空间门槛须为 1 到 {max} MiB 的整数', { max: limit });
  return value;
}

function checked_storage_url(value) {
  try { return api_base_url(typeof value === 'string' ? value.trim() : ''); }
  catch { throw storage_error('资源中心地址须为不含凭据、参数或片段的 HTTP(S) 网址'); }
}

export function object_key(home, { base_url, api_key_ref } = object_storage_settings(home)) {
  if (!/^[a-f0-9-]{36}$/i.test(api_key_ref)) return null;
  try {
    // A panel operator can test a hosted setup. Refuse a key-file link to a different account.
    const directory = join(home, 'api-keys');
    if (!lstatSync(directory).isDirectory() || !lstatSync(join(directory, api_key_ref + '.json')).isFile()) return null;
    const record = read_saved_api_key_record(home, base_url, api_key_ref);
    if (typeof record.api_key === 'string' && /^[\x20-\x7e]+$/.test(record.api_key) && record.api_key.trim()) return record;
  } catch { /* Missing key or address mismatch. */ }
  return null;
}

/** Return public settings without returning the resource-center credential. */
export function object_storage_status(home, { limit, quota_file, admin_allowed = false } = {}) {
  const { mode, ...settings } = object_storage_settings(home, limit);
  const key = object_key(home, settings);
  const quota_mib = object_storage_quota(quota_file || process.env.DISCUSS_OBJECT_STORAGE_QUOTA_FILE || object_quota_path(home));
  const delegated = mode === 'admin';
  return { ...settings, ...(delegated ? { mode } : {}), configured: delegated ? admin_allowed || Boolean(process.env.DISCUSS_OBJECT_STORAGE_ADMIN_FILE) : Boolean(key),
    managed: delegated || key?.managed === true, quota_mib };
}

/** Change this account's cloud policy and/or its reference to an already saved key. */
export function save_object_storage(home, input, { limit = attachment_limit(home), quota_file, admin_allowed = false } = {}) {
  const settings = object_storage_settings(home, limit), changes = input ?? {};
  if (Object.hasOwn(changes, 'quota_mib')) throw storage_error('由管理员在管理面板设置。');
  const validators = { retention_days: checked_retention, object_threshold_mib: value => checked_threshold(value, limit) };
  const fields = Object.keys(validators).filter(field => Object.hasOwn(changes, field));
  for (const field of fields) settings[field] = validators[field](changes[field]);
  const binding = Object.hasOwn(changes, 'base_url') || Object.hasOwn(changes, 'api_key_ref');
  if (changes.mode === 'admin') {
    if (!(admin_allowed || settings.mode === 'admin') || binding) throw storage_error('由管理员在管理面板设置。');
    Object.assign(settings, { mode: 'admin', base_url: '', api_key_ref: '' });
  } else if (changes.mode === 'own' && !binding) {
    settings.mode = 'own';
  } else if (binding || !fields.length) {
    settings.base_url = checked_storage_url(changes.base_url);
    settings.api_key_ref = String(changes.api_key_ref || '');
    if (!object_key(home, settings)) throw storage_error('请先保存此资源中心地址对应的 Key');
    settings.mode = 'own';
  }
  mkdirSync(home, { recursive: true });
  const { base_url, api_key_ref, ...policy } = settings;
  atomic_json(object_storage_path(home), settings.mode === 'admin' ? policy : { ...policy, base_url, api_key_ref });
  return object_storage_status(home, { limit, quota_file, admin_allowed });
}

/** Remove the settings without returning old credential data. */
export function clear_object_storage(home, options) {
  rmSync(object_storage_path(home), { force: true });
  return object_storage_status(home, options);
}

/** Apply account-site actions without granting writes to its administrator-owned quota. */
export async function account_object_storage(home, input) {
  if (Object.hasOwn(input ?? {}, 'quota_mib')) throw storage_error('由管理员在管理面板设置。');
  if (input?.action === 'test') return test_object_storage(home);
  if (input?.action === 'clear') return clear_object_storage(home);
  return input && Object.keys(input).length ? save_object_storage(home, input) : object_storage_status(home);
}

/** Probe the stored credential without following redirects or exposing resource-center response contents. */
export async function test_object_storage(home) {
  const settings = object_storage_settings(home);
  if (settings.mode === 'admin') return test_admin_object_storage();
  const key = object_key(home, settings);
  if (!key) throw storage_error('对象存储未配置');
  try {
    const url = `${settings.base_url}/files?maxKeys=1`;
    const response = await fetch(url, { headers: { 'X-Api-Key': key.api_key.trim() },
      redirect: 'error', signal: AbortSignal.timeout(6_000) });
    if (response.ok && (await response.json())?.succeed === true) return { ok: true };
  } catch { /* Errors may contain request or credential details. */ }
  throw storage_error('对象存储连接测试失败');
}

async function test_admin_object_storage() {
  try {
    const { account, port, token } = JSON.parse(readFileSync(process.env.DISCUSS_OBJECT_STORAGE_ADMIN_FILE, 'utf8'));
    if (!integer_in(port, 1, 65535)) throw new Error();
    const response = await fetch(`http://127.0.0.1:${port}/internal/object-storage/file-info`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(7_000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ account, name: `codiscuss/${account}/connection-test` }),
    });
    if (response.ok || response.status === 404 && (await response.json())?.code === 404) return { ok: true };
    throw storage_error('对象存储连接测试失败');
  } catch (error) {
    if (error.error_text) throw error;
    throw storage_error('云空间暂不可用（管理员服务未运行）');
  }
}

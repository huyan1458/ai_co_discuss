/** Owner notifications through a Feishu custom app bot. Credentials stay on this machine. */
import { randomInt, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { atomic_json } from './files.mjs';
import { t } from './i18n.mjs';
import { system_text } from './notice_text.mjs';
import { connect_events, discover_endpoint } from './vendor/larksuite-ws/client.mjs';

const API_ORIGIN = 'https://open.feishu.cn';
const BIND_TTL_MS = 600_000;
const CHECK_ACCOUNT_MS = 1_000;
const REQUEST_TIMEOUT_MS = 15_000;
const TOKEN_MARGIN_MS = 60_000;
const RETRY_MS = 5_000;
const SEEN_EVENTS = 256;
const accounts = new Map();
const account_path = home => join(home, 'feishu', 'account.json');

function read_account(home) {
  try { return JSON.parse(readFileSync(account_path(home), 'utf8')); }
  catch { return null; }
}

function write_account(home, account) {
  mkdirSync(join(home, 'feishu'), { recursive: true, mode: 0o700 });
  atomic_json(account_path(home), account);
}

function active_code(account) {
  return account?.bind_until > Date.now() ? account.bind_code : '';
}

function status(home) {
  const account = read_account(home);
  const bind_code = active_code(account);
  return { bound: Boolean(account), owner_bound: Boolean(account?.owner_id), ready: Boolean(account?.owner_id),
    bind_code, bind_hint: bind_code ? t('在飞书中打开与应用机器人的私聊，发送这组绑定码。') : '',
    last_failure: account?.last_failure ?? null };
}

function redact(text, secret) {
  return secret ? String(text ?? '').replaceAll(secret, '[redacted]') : String(text ?? '');
}

function api_client(fetch_impl, app_secret) {
  return async function post(path, payload, { token, signal } = {}) {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const response = await fetch_impl(API_ORIGIN + path, { method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(payload), signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    const result = await response.json().catch(() => null);
    if (!response.ok || result?.code !== 0) throw Object.assign(new Error(t('飞书接口拒绝请求（{code}）',
      { code: result?.code ?? response.status })), { code: result?.code ?? response.status,
      detail: redact(redact(result?.msg, app_secret), token) });
    return result;
  };
}

function tenant_token(home, account, post) {
  const cached = accounts.get(home);
  if (cached?.generation === account.generation && cached.until > Date.now()) return cached.promise;
  const entry = { generation: account.generation, until: Infinity };
  entry.promise = post('/open-apis/auth/v3/tenant_access_token/internal', { app_id: account.app_id,
    app_secret: account.app_secret }).then(result => {
    if (!result.tenant_access_token) throw new Error(t('飞书未返回应用访问令牌'));
    entry.until = Date.now() + Math.max(0, Number(result.expire) * 1_000 - TOKEN_MARGIN_MS);
    return result.tenant_access_token;
  }).catch(error => {
    if (accounts.get(home) === entry) accounts.delete(home);
    throw error;
  });
  accounts.set(home, entry);
  return entry.promise;
}

async function send_text(home, account, text, post) {
  const token = await tenant_token(home, account, post);
  if (read_account(home)?.generation !== account.generation) throw new Error(t('飞书绑定已更改'));
  const { data } = await post('/open-apis/im/v1/messages?receive_id_type=open_id', { receive_id: account.owner_id,
    msg_type: 'text', content: JSON.stringify({ text }) }, { token });
  if (!data?.message_id) throw new Error(t('飞书未返回消息编号'));
  return [data.message_id];
}

function save_failure(home, account, error) {
  const current = read_account(home);
  if (!current || current.generation !== account?.generation) return;
  const failure = error ? { at: Date.now(), message: redact(error.message, account.app_secret),
    code: error.code ?? null, detail: error.detail || '' } : null;
  if (failure || current.last_failure) write_account(home, { ...current, last_failure: failure });
}

async function deliver(home, text, { fetch_impl = globalThis.fetch } = {}) {
  const account = read_account(home);
  try {
    if (!account?.owner_id) throw new Error(t('请先在飞书绑定房主'));
    const ids = await send_text(home, account, text, api_client(fetch_impl, account.app_secret));
    save_failure(home, account, null);
    return ids;
  } catch (error) {
    save_failure(home, account, error);
    throw error;
  }
}

async function configure(home, { values, fetch_impl = globalThis.fetch }) {
  const app_id = String(values?.app_id ?? '').trim();
  const app_secret = String(values?.app_secret ?? '').trim();
  if (!app_id || !app_secret) throw new Error(t('请输入飞书应用的 App ID 和 App Secret'));
  const account = { generation: randomUUID(), app_id, app_secret };
  await tenant_token(home, account, api_client(fetch_impl, account.app_secret));
  write_account(home, { ...account, bind_code: String(randomInt(1_000_000)).padStart(6, '0'), bind_until: Date.now() + BIND_TTL_MS });
  return status(home);
}

function parse_message(event) {
  if (event?.header?.event_type !== 'im.message.receive_v1') return null;
  const { message, sender } = event.event || {};
  const owner = sender?.sender_id?.open_id;
  if (!owner || sender.sender_type !== 'user' || message?.chat_type !== 'p2p' || !message.message_id) return null;
  const media = message.message_type !== 'text';
  const text = media ? '' : JSON.parse(message.content)?.text;
  const reference = message.parent_id || message.root_id;
  return { owner, id: message.message_id, text: typeof text === 'string' ? text : '', media,
    quoted: reference ? [{ id: reference }] : [] };
}

function accept_owner(home, generation, item) {
  const account = read_account(home);
  if (!account || account.generation !== generation) return null;
  if (account.owner_id) return account.owner_id === item.owner && account.binding_message_id !== item.id ? account : null;
  if (!active_code(account) || account.bind_code !== item.text) return null;
  const updated = { ...account, owner_id: item.owner, binding_message_id: item.id, bind_code: '', bind_until: 0 };
  write_account(home, updated);
  return null; // The binding message itself is never forwarded to a room.
}

function event_handler(home, account, post, { on_message, log }, seen) {
  return async event => {
    const item = parse_message(event);
    if (!item) return;
    if (seen.has(item.id)) return seen.get(item.id);
    const owner = accept_owner(home, account.generation, item);
    if (!owner) return;
    const processing = Promise.resolve().then(() => on_message({ text: item.text, quoted: item.quoted, media: item.media }));
    seen.set(item.id, processing);
    try {
      const receipt = await processing;
      if (seen.size > SEEN_EVENTS) seen.delete(seen.values().next().value);
      if (receipt) void send_text(home, owner, system_text(receipt), post)
        .catch(() => log(t('飞书未能发送回复回执')));
    } catch (error) {
      seen.delete(item.id);
      throw error;
    }
  };
}

async function receive(home, options = {}) {
  const { signal = new AbortController().signal, log = () => {}, fetch_impl = globalThis.fetch,
    websocket_impl = globalThis.WebSocket } = options;
  let generation;
  const seen = new Map();
  while (!signal.aborted) {
    const account = read_account(home);
    let retry = CHECK_ACCOUNT_MS;
    if (account) {
      if (account.generation !== generation) { generation = account.generation; seen.clear(); }
      const changed = new AbortController();
      const timer = setInterval(() => {
        if (read_account(home)?.generation !== account.generation) changed.abort();
      }, CHECK_ACCOUNT_MS);
      const connection_signal = AbortSignal.any([signal, changed.signal]);
      const post = api_client(fetch_impl, account.app_secret);
      retry = RETRY_MS;
      try {
        const endpoint = await discover_endpoint(post, account, connection_signal);
        retry = endpoint.retry_ms;
        await connect_events(endpoint, { websocket_impl, signal: connection_signal,
          on_event: event_handler(home, account, post, { ...options, log }, seen),
          on_error: () => log(t('飞书收到无法处理的长连接事件')) });
      } catch {
        if (!connection_signal.aborted) log(t('飞书长连接失败，将重试'));
      } finally {
        clearInterval(timer);
      }
      if (changed.signal.aborted) retry = 0;
    }
    if (retry) await sleep(retry, null, { signal }).catch(() => {});
  }
}

/** Feishu's notification channel definition and owner binding commands. */
export const feishu_channel = {
  id: 'feishu', label: t('飞书'), fields: [{ key: 'app_id', label: 'App ID' }, { key: 'app_secret', label: 'App Secret', secret: true }],
  not_ready: t('请先在飞书绑定房主'), bound: home => Boolean(read_account(home)), ready: home => Boolean(read_account(home)?.owner_id),
  status, deliver, receive,
  async command(home, action, input = {}) {
    if (action === 'configure') return configure(home, input);
    if (action === 'unbind') {
      rmSync(account_path(home), { force: true });
      accounts.delete(home);
      return status(home);
    }
    return null;
  },
};

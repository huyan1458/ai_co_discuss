import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { atomic_json } from './files.mjs';
import { t } from './i18n.mjs';
import { C2C_INTENT } from './vendor/qqbot-nodejs/constants.mjs';
import { GatewayConnection } from './vendor/qqbot-nodejs/gateway-connection.mjs';
import { MessageApi, TokenManager } from './vendor/qqbot-nodejs/rest.mjs';

const BIND_LIFETIME_MS = 10 * 60 * 1000;
const ACCOUNT_POLL_MS = 1000;
const account_path = home => join(home, 'qq', 'account.json');
const clients = new Map();

function read_account(home) {
  try {
    const account = JSON.parse(readFileSync(account_path(home), 'utf8'));
    return account?.generation && account.app_id && account.app_secret ? account : null;
  } catch { return null; }
}

function write_account(home, account) {
  mkdirSync(join(home, 'qq'), { recursive: true, mode: 0o700 });
  atomic_json(account_path(home), account);
}

function api_for(home, account, fetch_impl = globalThis.fetch) {
  const previous = clients.get(home);
  if (previous?.generation === account.generation && previous.fetch_impl === fetch_impl) return previous;
  const tokens = new TokenManager(account, fetch_impl);
  const client = { generation: account.generation, fetch_impl, tokens, api: new MessageApi(tokens, fetch_impl) };
  clients.set(home, client);
  return client;
}

function status(home) {
  const account = read_account(home);
  const owner_bound = Boolean(account?.owner_id);
  const pending = !owner_bound && account?.bind_until > Date.now();
  return {
    bound: Boolean(account), owner_bound, ready: owner_bound,
    bind_code: pending ? account.bind_code : '',
    bind_hint: pending ? t('请在 QQ 客户端私聊机器人，发送上面的绑定码。') : '',
    last_failure: account?.last_failure ?? null,
  };
}

function save_failure(home, account, error) {
  const current = read_account(home);
  if (current?.generation !== account.generation) return;
  const last_failure = error ? {
    at: Date.now(), message: safe_text(account, error.message),
    code: typeof error.code === 'string' ? safe_text(account, error.code) :
      typeof error.code === 'number' ? error.code : null,
    detail: safe_text(account, error.detail),
  } : null;
  write_account(home, { ...current, last_failure });
}

function safe_text(account, value) {
  const token = account.token_manager?.cached?.token;
  return [account.app_secret, token].filter(Boolean)
    .reduce((result, secret) => result.replaceAll(secret, '[redacted]'), typeof value === 'string' ? value : '');
}

/** Validate first, then make the new credentials and one-time challenge visible to the receiver. */
async function command(home, action, input = {}) {
  if (action === 'unbind') {
    rmSync(account_path(home), { force: true });
    clients.delete(home);
    return status(home);
  }
  if (action !== 'configure') return null;
  const app_id = String(input.values?.app_id ?? '').trim();
  const app_secret = typeof input.values?.app_secret === 'string' ? input.values.app_secret.trim() : '';
  if (!app_id || !app_secret) throw new Error(t('请填写 QQ 机器人的 AppID 和 AppSecret。'));
  const account = { app_id, app_secret, generation: randomUUID() };
  const client = new TokenManager(account, input.fetch_impl ?? globalThis.fetch);
  try { await client.getAccessToken(); }
  catch (error) { throw new Error(safe_text(account, error.detail) || safe_text(account, error.message)); }
  write_account(home, { ...account, bind_code: randomBytes(6).toString('hex'), bind_until: Date.now() + BIND_LIFETIME_MS });
  clients.delete(home);
  return status(home);
}

/** Send independently of any inbound QQ message. Record both provider ID and quote index. */
async function deliver(home, text, { fetch_impl } = {}) {
  const account = read_account(home);
  if (!account?.owner_id) throw new Error(t('请先在 QQ 私聊中绑定房主。'));
  const { api, tokens } = api_for(home, account, fetch_impl);
  try {
    const sent = await api.sendText(account.owner_id, text);
    if (typeof sent.id !== 'string' || !sent.id) throw new Error(t('QQ 没有返回消息编号。'));
    save_failure(home, account, null);
    return [sent.id, sent.ext_info?.ref_idx].filter(id => typeof id === 'string' && id);
  } catch (error) {
    const safe_account = { ...account, token_manager: tokens };
    save_failure(home, safe_account, error);
    throw Object.assign(new Error(safe_text(safe_account, error.detail) || safe_text(safe_account, error.message)),
      { code: error.code, detail: safe_text(safe_account, error.detail) });
  }
}

function bind_owner(home, account, message) {
  if (account.bind_until <= Date.now() || !account.bind_code || message.content !== account.bind_code) return '';
  const { bind_until, bind_code, ...credentials } = account;
  write_account(home, { ...credentials, owner_id: message.senderId, binding_message_id: message.messageId });
  return t('QQ 通知已绑定。');
}

async function owner_message(home, generation, message, on_message) {
  const account = read_account(home);
  if (account?.generation !== generation || !message.senderId || !message.messageId) return '';
  if (!account.owner_id) return bind_owner(home, account, message);
  if (account.owner_id !== message.senderId || account.binding_message_id === message.messageId) return '';
  const quoted = [message.refMsgIdx, message.messageReference]
    .filter(id => typeof id === 'string' && id).map(id => ({ id }));
  if (typeof message.quoteText === 'string' && message.quoteText.trim()) quoted.push({ text: message.quoteText.trim() });
  const text = typeof message.content === 'string' ? message.content.trim() : '';
  return on_message({ text, quoted, media: Boolean(message.attachments?.length) });
}

function gateway_options(home, account, options) {
  const { controller, fetch_impl, websocket, on_message, log } = options;
  const { api, tokens } = api_for(home, account, fetch_impl);
  const report = error => log(`QQ: ${safe_text({ ...account, token_manager: tokens }, error.message)}`);
  let pending = Promise.resolve();
  return {
    account: { accountId: 'qq' }, abortSignal: controller.signal, intents: C2C_INTENT, websocket,
    getAccessToken: () => tokens.getAccessToken(),
    clearTokenCache: () => tokens.clearCache(),
    getGatewayUrl: token => api.getGatewayUrl(token),
    onError: report,
    onMessage(message) {
      pending = pending.then(async () => {
        if (controller.signal.aborted) return;
        const receipt = await owner_message(home, account.generation, message, on_message);
        if (receipt && !controller.signal.aborted && read_account(home)?.generation === account.generation) {
          await api.sendText(message.senderId, receipt, message.messageId);
        }
      }).catch(report);
    },
  };
}

async function run_gateway(home, account, options) {
  const { signal, log } = options;
  const controller = new AbortController();
  const abort_signal = AbortSignal.any([signal, controller.signal]);
  const poll = setInterval(() => {
    const current = read_account(home);
    if (current?.generation !== account.generation || (!current.owner_id && current.bind_until <= Date.now())) {
      controller.abort();
    }
  }, ACCOUNT_POLL_MS);
  try {
    const gateway = gateway_options(home, account, { ...options, controller });
    await new GatewayConnection({ ...gateway, abortSignal: abort_signal }).start();
  } catch (error) {
    log(`QQ Gateway: ${safe_text(account, error.message)}`);
  } finally {
    controller.abort();
    clearInterval(poll);
  }
}

/** Listen only while a configured account is bound or has a live binding challenge. */
async function receive(home, options) {
  const { signal = new AbortController().signal, log = () => {} } = options;
  while (!signal.aborted) {
    const account = read_account(home);
    if (account?.owner_id || account?.bind_until > Date.now()) await run_gateway(home, account, { ...options, signal, log });
    await sleep(ACCOUNT_POLL_MS, undefined, { signal }).catch(() => {});
  }
}

export const qq_channel = {
  id: 'qq', label: 'QQ',
  fields: [{ key: 'app_id', label: 'AppID', secret: false }, { key: 'app_secret', label: 'AppSecret', secret: true }],
  bound: home => Boolean(read_account(home)), ready: home => Boolean(read_account(home)?.owner_id),
  status, deliver, receive, command,
  get not_ready() { return t('请先在 QQ 私聊中绑定房主。'); },
};

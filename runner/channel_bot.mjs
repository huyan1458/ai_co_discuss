import { randomInt, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { atomic_json } from './files.mjs';
import { t } from './i18n.mjs';

const BIND_MS = 10 * 60_000;
const RETRY_MS = 1_500;
const IDLE_MS = 750;
const BIND_CODE_LIMIT = 1_000_000_000;

/** Build a bot channel around provider-specific transport and a local one-owner binding. */
export function bot_channel(spec) {
  const account_path = home => join(home, spec.id, 'account.json');
  const account = home => {
    try { return JSON.parse(readFileSync(account_path(home), 'utf8')); }
    catch { return null; }
  };
  const save = (home, value) => {
    mkdirSync(join(home, spec.id), { recursive: true, mode: 0o700 });
    atomic_json(account_path(home), value);
  };
  const current = (home, snapshot) => {
    const live = account(home);
    return live?.generation === snapshot.generation ? live : null;
  };
  const status = home => {
    const value = account(home);
    return { bound: Boolean(value), owner_bound: Boolean(value?.owner_id), ready: Boolean(value?.owner_id),
      bind_code: value?.bind_until > Date.now() ? value.bind_code : '', bind_hint: spec.hint(value),
      last_failure: value?.last_failure ?? null };
  };
  async function command(home, action, input = {}) {
    if (action === 'unbind') {
      rmSync(account_path(home), { force: true });
      return status(home);
    }
    if (action !== 'configure') return null;
    const token = String(input.values?.token ?? '').trim();
    if (!spec.valid_token(token)) throw new Error(t('请输入有效的机器人令牌。'));
    const profile = await spec.verify(token, input).catch(error => { throw safe_error(error, token); });
    save(home, { token, ...profile, generation: randomUUID(), configured_at: Date.now(),
      bind_code: String(randomInt(BIND_CODE_LIMIT)).padStart(9, '0'), bind_until: Date.now() + BIND_MS });
    return status(home);
  }
  async function deliver(home, text, options = {}) {
    const value = account(home);
    if (!value?.owner_id) throw new Error(spec.not_ready);
    try {
      const ids = await spec.send(value, text, options);
      const live = current(home, value);
      if (live?.last_failure) save(home, { ...live, last_failure: null });
      return ids;
    } catch (error) {
      const failure = safe_error(error, value.token);
      const live = current(home, value);
      if (live) save(home, { ...live, last_failure: { at: Date.now(), message: failure.message,
        code: failure.code ?? null, detail: failure.detail } });
      throw failure;
    }
  }
  async function handle(home, snapshot, item, options) {
    const live = current(home, snapshot);
    if (!live || options.signal.aborted || !item?.sender_id) return;
    if (!live.owner_id) {
      if (Date.now() >= live.bind_until || !Number.isFinite(item.sent_at) || item.sent_at + 999 < live.configured_at || item.text !== live.bind_code) return;
      save(home, { ...live, owner_id: item.sender_id, chat_id: item.chat_id, bind_code: '', bind_until: 0 });
      return;
    }
    if (item.sender_id !== live.owner_id || item.chat_id !== live.chat_id || !item.text && !item.media) return;
    const receipt = await options.on_message({ ...item, strict_quote: true });
    if (receipt && current(home, snapshot) && !options.signal.aborted) {
      try { await spec.send(live, receipt, options); }
      catch (error) { options.log(t('{channel}回复确认发送失败：{error}', { channel: spec.label, error: safe_text(error.message, live.token) })); }
    }
  }
  async function receive(home, options) {
    const signal = options.signal ?? new AbortController().signal;
    while (!signal.aborted) {
      const snapshot = account(home);
      if (snapshot) await receive_account(home, snapshot, { ...options, signal });
      await delay(IDLE_MS, undefined, { signal }).catch(() => {});
    }
  }
  async function receive_account(home, snapshot, options) {
    const session = new AbortController();
    const signal = AbortSignal.any([options.signal, session.signal]);
    const check = setInterval(() => { if (!current(home, snapshot)) session.abort(); }, IDLE_MS);
    const accept = item => handle(home, snapshot, item, { ...options, signal });
    const advance = offset => {
      const live = current(home, snapshot);
      if (live && !signal.aborted) save(home, { ...live, offset });
    };
    try {
      await spec.listen(snapshot, { ...options, signal, accept, advance });
    } catch (error) {
      if (!signal.aborted) options.log(t('{channel}收消息失败：{error}', { channel: spec.label, error: safe_text(error.message, snapshot.token) }));
      if (!signal.aborted) await delay(RETRY_MS, undefined, { signal }).catch(() => {});
    } finally {
      clearInterval(check);
      session.abort();
    }
  }
  return { id: spec.id, label: spec.label, not_ready: spec.not_ready,
    fields: [{ key: 'token', label: 'Bot Token', secret: true }],
    bound: home => Boolean(account(home)), ready: home => Boolean(account(home)?.owner_id),
    status, command, deliver, receive };
}

function safe_text(value, token) {
  // An empty token (OneBot without an access token) would otherwise be "replaced" between every character.
  return token ? String(value ?? '').replaceAll(token, '[redacted]') : String(value ?? '');
}

function safe_error(error, token) {
  return Object.assign(new Error(safe_text(error.message, token)), {
    code: typeof error.code === 'string' ? safe_text(error.code, token) : error.code,
    detail: safe_text(error.detail, token),
  });
}
/**
 * Weixin notifications through Tencent iLink: bind the owner's Weixin by QR code, tell them when a goal waits for their
 * input, and post their replies back to that room as the owner. Only Node built-ins; the iLink client and login follow
 * the protocol used by coder_notifier (Tencent/openclaw-weixin 2.4.10), copied here so this repository stands alone.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { atomic_json } from './files.mjs';
import { split_text, system_text } from './notice_text.mjs';

export const ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com';
const PROTOCOL_VERSION = '2.4.10';
const CLIENT_VERSION = (2 << 16) | (4 << 8) | 10;
const BOT_AGENT = 'CoDiscuss/1.0';
const REQUEST_TIMEOUT_MS = 40_000;
const LOGIN_LIFETIME_MS = 5 * 60_000;
const LOGIN_INTERVAL_MS = 1_000;
const LOGIN_POLL_MS = 20_000;
// A long poll that fails waits this long before the next one, so a dropped network does not spin.
const RECEIVE_RETRY_MS = 10_000;
// With no bound account the receiver checks again this often, so binding from the page starts it without a restart.
const UNBOUND_CHECK_MS = 5_000;

/** An explicit API rejection, distinguishable from an uncertain transport outcome. */
export class IlinkError extends Error {
  constructor(message, code = null, detail = '') {
    super(message);
    this.code = code;
    this.detail = detail;
    this.session_expired = code === -14;
  }
}

/** Restrict credential-bearing requests and QR redirects to Tencent's Weixin hosts. */
export function validate_base_url(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port
      || !url.hostname.endsWith('.weixin.qq.com') || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('iLink 地址必须为受信任的微信 HTTPS 主机');
  }
  return url.origin;
}

/** Keep uint64 message identifiers as text instead of rounding them through a JS number. */
function parse_ilink_json(text) {
  return JSON.parse(text, (_key, value, context) => (
    typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value) ? context.source : value));
}

/** Minimal iLink HTTPS client; writes are attempted once and never silently retried. */
export class IlinkClient {
  constructor(account = {}, options = {}) {
    this.base_url = validate_base_url(account.base_url || ILINK_BASE_URL);
    this.token = account.token;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.signal = options.signal;
  }

  /** Protocol headers; the token goes only on authenticated POSTs. */
  headers(authenticated, method) {
    const headers = { 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': String(CLIENT_VERSION) };
    if (method === 'POST') {
      headers['Content-Type'] = 'application/json';
      headers.AuthorizationType = 'ilink_bot_token';
      headers['X-WECHAT-UIN'] = Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64');
    }
    if (authenticated) {
      if (!this.token) throw new Error('缺少微信登录凭据');
      headers.Authorization = `Bearer ${this.token}`;
    }
    return headers;
  }

  /** Send one request without following redirects or echoing response bodies in errors. */
  async request(endpoint, body, options = {}) {
    const method = body === undefined ? 'GET' : 'POST';
    const base_url = validate_base_url(options.base_url ?? this.base_url);
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = this.signal ? AbortSignal.any([this.signal, timeout]) : timeout;
    const response = await this.fetch(`${base_url}/ilink/bot/${endpoint}`, {
      method, redirect: 'error', signal, headers: this.headers(options.authenticated ?? false, method),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new IlinkError(`iLink HTTP ${response.status}，结果需核查`);
    let result;
    try { result = parse_ilink_json(await response.text()); }
    catch { throw new IlinkError('iLink 返回无效 JSON，结果需核查'); }
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new IlinkError('iLink 返回格式无效');
    const codes = [result.ret, result.errcode].filter(value => value != null).map(Number);
    const code = codes.includes(-14) ? -14 : codes.find(value => value !== 0);
    const detail = typeof result.errmsg === 'string' ? result.errmsg.trim() : '';
    if (code !== undefined) throw new IlinkError(code === -14 ? '微信登录已过期，请重新扫码绑定'
      : `iLink 拒绝请求（${code}${detail ? `：${detail}` : ''}）`, code, detail);
    return result;
  }

  /** Ask for a QR code at the fixed bootstrap host. */
  create_qr(previous_token) {
    return this.request('get_bot_qrcode?bot_type=3', { local_token_list: previous_token ? [previous_token] : [] }, { base_url: ILINK_BASE_URL });
  }

  /** Poll the current QR challenge. */
  qr_status(login) {
    return this.request(`get_qrcode_status?${new URLSearchParams({ qrcode: login.qrcode })}`, undefined, { base_url: login.base_url });
  }

  /** Long-poll inbound messages from the saved cursor; a plain timeout is an empty batch. */
  async updates(cursor) {
    try {
      return await this.request('getupdates', { get_updates_buf: cursor || '',
        base_info: { channel_version: PROTOCOL_VERSION, bot_agent: BOT_AGENT } }, { authenticated: true });
    } catch (error) {
      if (!this.signal?.aborted && error.name === 'TimeoutError') return { msgs: [] };
      throw error;
    }
  }

  /** Send one text chunk with the owner's latest reply context. */
  async send(message) {
    const result = await this.request('sendmessage', {
      msg: { from_user_id: '', to_user_id: message.peer_id, client_id: message.client_id, message_type: 2, message_state: 2,
        context_token: message.context_token, item_list: [{ type: 1, text_item: { text: message.text } }] },
      base_info: { channel_version: PROTOCOL_VERSION, bot_agent: BOT_AGENT },
    }, { authenticated: true });
    if (Number(result.ret ?? 0) !== 0 && !String(result.message_id ?? '').trim()) throw new IlinkError('微信发送缺少明确成功回执，结果需核查');
    return result;
  }
}

const directory = home => join(home, 'weixin');
const account_path = home => join(directory(home), 'account.json');
const state_path = home => join(directory(home), 'state.json');
// One line per notice sent or refused, with how old the reply context was, to learn how long iLink accepts one.
const sends_path = home => join(directory(home), 'sends.jsonl');

/** The state fields for the latest failure, or for none: the page shows `last_failure`, older readers `last_error`. */
function failure_fields(error, context_at = 0) {
  if (!error) return { last_error: '', last_failure: null };
  return { last_error: error.message, last_failure: { at: Date.now(), message: error.message, code: error.code ?? null,
    detail: error.detail || '', context_at } };
}

/** Record one send attempt for measuring how long a reply context stays usable. */
function record_send(home, context_at, error = null) {
  const now = Date.now();
  const entry = { at: now, ok: !error, context_at, context_age_ms: context_at ? now - context_at : null,
    ...(error ? { code: error.code ?? null, detail: error.detail || '', message: error.message } : {}) };
  try { appendFileSync(sends_path(home), `${JSON.stringify(entry)}\n`, { mode: 0o600 }); } catch { /* the log is only for measuring */ }
}
const login_path = home => join(directory(home), 'login.json');

function read_json(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function write_json(path, value) {
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  atomic_json(path, value);
}

/** The bound account, or null; a broken file counts as unbound. */
export function weixin_account(home) {
  const account = read_json(account_path(home));
  if (!account || ![account.account_id, account.owner_id, account.token].every(value => typeof value === 'string' && value.trim())) return null;
  return { ...account, base_url: validate_base_url(account.base_url || ILINK_BASE_URL) };
}

/** Cursor and reply context; `notices` is only the record from before notices moved to `channels.mjs`. */
function read_state(home) {
  return { cursor: '', context_token: '', context_at: 0, next_notice: 1, notices: [], ...read_json(state_path(home)) };
}

/** What the settings page shows; never the token. */
export function weixin_status(home) {
  const account = weixin_account(home);
  if (!account) return { bound: false, login_pending: Boolean(read_json(login_path(home))) };
  const state = read_state(home);
  return { bound: true, owner_id: account.owner_id, context_ready: Boolean(state.context_token), context_at: state.context_at,
    last_notice_at: state.last_sent_at || state.notices.at(-1)?.sent_at || 0, last_error: state.last_error || '',
    last_failure: state.last_error ? state.last_failure || { message: state.last_error, code: null, detail: '' } : null };
}

/** Start binding: a fresh QR challenge whose content the page draws as a QR code. */
export async function begin_login(home, client = new IlinkClient()) {
  const result = await client.create_qr(weixin_account(home)?.token);
  if (!result.qrcode || !result.qrcode_img_content) throw new Error('微信未返回有效二维码');
  write_json(login_path(home), { qrcode: result.qrcode, base_url: ILINK_BASE_URL, created_at: Date.now() });
  return { status: 'scan_required', qr_content: result.qrcode_img_content, expires_in_seconds: LOGIN_LIFETIME_MS / 1000 };
}

/** Poll the QR challenge for a bounded time; save only a fully confirmed account. */
export async function complete_login(home, { client = new IlinkClient(), timeout_ms = LOGIN_POLL_MS } = {}) {
  const login = read_json(login_path(home));
  if (!login) return { status: 'expired' };
  const deadline = Date.now() + timeout_ms;
  do {
    if (Date.now() - login.created_at >= LOGIN_LIFETIME_MS) { rmSync(login_path(home), { force: true }); return { status: 'expired' }; }
    const response = await client.qr_status(login);
    if (response.status === 'confirmed') {
      const account = { account_id: response.ilink_bot_id, owner_id: response.ilink_user_id, token: response.bot_token,
        base_url: validate_base_url(response.baseurl || ILINK_BASE_URL) };
      if (![account.account_id, account.owner_id, account.token].every(value => typeof value === 'string' && value.trim())) {
        throw new Error('微信确认响应缺少账号或凭据，未绑定');
      }
      write_json(account_path(home), account);
      write_json(state_path(home), { ...read_state(home), cursor: '', context_token: '', context_at: 0, ...failure_fields(null) });
      rmSync(login_path(home), { force: true });
      return { status: 'connected' };
    }
    if (['expired', 'need_verifycode', 'verify_code_blocked', 'binded_redirect'].includes(response.status)) return { status: response.status };
    if (response.status === 'scaned_but_redirect') {
      login.base_url = validate_base_url(`https://${response.redirect_host}`);
      write_json(login_path(home), login);
    } else if (!['wait', 'scaned'].includes(response.status)) throw new Error('微信返回未知扫码状态');
    if (Date.now() >= deadline) break;
    await sleep(Math.min(LOGIN_INTERVAL_MS, deadline - Date.now()));
  } while (Date.now() < deadline);
  return { status: 'waiting' };
}

/** Forget the binding on this computer. */
export function unbind(home) {
  rmSync(directory(home), { recursive: true, force: true });
  return { bound: false };
}

/** The owner's private text messages in one update batch, with the notices each one quotes, if any. */
export function owner_texts(account, response) {
  const texts = [];
  for (const message of response.msgs ?? []) {
    if (message.message_type !== 1 || message.message_state !== 2 || message.group_id || message.from_user_id !== account.owner_id
        || (message.to_user_id && message.to_user_id !== account.account_id)) continue;
    const items = message.item_list ?? [];
    const text = items.filter(item => item.type === 1 && typeof item.text_item?.text === 'string').map(item => item.text_item.text).join('\n').trim();
    const quoted = items.map(item => item.ref_msg).filter(Boolean).map(reference => ({
      id: reference.svr_id == null ? '' : String(reference.svr_id),
      text: (reference.message_item?.text_item?.text ?? reference.title ?? '').trim() }));
    texts.push({ text, quoted, media: items.some(item => item.type !== 1), context_token: message.context_token });
  }
  return texts;
}

/** Notices sent before `channels.mjs` kept them, in its shape, so replies to them still find their room. */
export function legacy_notices(home) {
  return read_state(home).notices.map(({ server_ids, ...notice }) => ({ ...notice, deliveries: { weixin: server_ids || [] } }));
}

/**
 * The Weixin channel for `channels.mjs`. iLink only sends with the reply context of the owner's latest message, so the
 * channel is ready once the owner has messaged the bot since binding.
 */
export const weixin_channel = {
  id: 'weixin',
  label: '微信',
  bound: home => Boolean(weixin_account(home)),
  ready: home => Boolean(weixin_account(home)) && Boolean(read_state(home).context_token),
  status: weixin_status,
  /** Send one formatted notice; returns Weixin's message ids, which a quoted reply names. Records a refusal and throws. */
  async deliver(home, text, options = {}) {
    const account = weixin_account(home);
    const state = read_state(home);
    const client = new IlinkClient(account, options);
    const ids = [];
    try {
      for (const chunk of split_text(text)) {
        const result = await client.send({ peer_id: account.owner_id, client_id: randomUUID(), context_token: state.context_token, text: chunk });
        if (String(result.message_id ?? '').trim()) ids.push(String(result.message_id));
      }
    } catch (error) {
      write_json(state_path(home), { ...read_state(home), ...failure_fields(error, state.context_at) });
      record_send(home, state.context_at, error);
      throw error;
    }
    write_json(state_path(home), { ...read_state(home), last_sent_at: Date.now(), ...failure_fields(null) });
    record_send(home, state.context_at);
    return ids;
  },
  /**
   * Receive the owner's messages until `signal` aborts: refresh the reply context, hand each one to `on_message`
   * (`{text, quoted: [{id, text}], media}`), and send back the receipt it returns.
   */
  async receive(home, { on_message, log = () => {}, signal, fetch_impl } = {}) {
    while (!signal?.aborted) {
      const account = weixin_account(home);
      if (!account) { await sleep(UNBOUND_CHECK_MS, null, { signal }).catch(() => {}); continue; }
      const client = new IlinkClient(account, { signal, fetch: fetch_impl });
      try {
        const response = await client.updates(read_state(home).cursor);
        const texts = owner_texts(account, response);
        const latest = read_state(home);
        const context = texts.map(item => item.context_token).filter(Boolean).at(-1);
        write_json(state_path(home), { ...latest, cursor: typeof response.get_updates_buf === 'string' && response.get_updates_buf ? response.get_updates_buf : latest.cursor,
          ...(context ? { context_token: context, context_at: Date.now(), ...failure_fields(null) } : {}) });
        for (const item of texts) {
          const reply = await on_message(item);
          const context_token = read_state(home).context_token;
          if (!reply || !context_token) continue;
          try { await client.send({ peer_id: account.owner_id, client_id: randomUUID(), context_token, text: system_text(reply) }); }
          catch (error) { log(`微信回执发送失败：${error.message}`); }
        }
      } catch (error) {
        if (signal?.aborted) break;
        log(`微信收件失败：${error.message}`);
        if (error.session_expired) write_json(state_path(home), { ...read_state(home), ...failure_fields(error, read_state(home).context_at) });
        await sleep(RECEIVE_RETRY_MS, null, { signal }).catch(() => {});
      }
    }
  },
  /** Binding actions of `launch weixin`: login (a QR code to draw), complete (wait for the scan) and unbind. */
  async command(home, action) {
    if (action === 'login') return begin_login(home);
    if (action === 'complete') return { ...await complete_login(home), ...weixin_status(home) };
    if (action === 'unbind') return unbind(home);
    return null;
  },
  /** Why a test could not be sent, for a channel that is bound but not ready. */
  not_ready: '还收不到你的消息：请先在微信里给机器人发一条消息，再点发送测试',
};

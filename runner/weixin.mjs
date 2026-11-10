/**
 * Weixin notifications through Tencent iLink: bind the owner's Weixin by QR code, tell them when a goal waits for their
 * input, and post their replies back to that room as the owner. Only Node built-ins; the iLink client and login follow
 * the protocol used by coder_notifier (Tencent/openclaw-weixin 2.4.10), copied here so this repository stands alone.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { atomic_json } from './files.mjs';

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
const CHUNK_BYTES = 3_500;
const RECENT_NOTICES = 50;
// Every notice starts with this tag; quoting a notice in Weixin sends the reply to that notice's room.
const NOTICE_TAG = /\[CoDiscuss #(\d+)\]/;

/** An explicit API rejection, distinguishable from an uncertain transport outcome. */
export class IlinkError extends Error {
  constructor(message, code = null) {
    super(message);
    this.code = code;
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
    if (code !== undefined) throw new IlinkError(code === -14 ? '微信登录已过期，请重新扫码绑定' : `iLink 拒绝请求（${code}）`, code);
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

/** Split text on code points so each chunk stays under iLink's payload size. */
export function split_text(text, limit = CHUNK_BYTES) {
  const chunks = [];
  let chunk = '', bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (bytes + size > limit) { chunks.push(chunk); chunk = ''; bytes = 0; }
    chunk += character;
    bytes += size;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

const directory = home => join(home, 'weixin');
const account_path = home => join(directory(home), 'account.json');
const state_path = home => join(directory(home), 'state.json');
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

/** Cursor, reply context and the recent notices replies are routed by. */
function read_state(home) {
  return { cursor: '', context_token: '', context_at: 0, next_notice: 1, notices: [], ...read_json(state_path(home)) };
}

/** What the settings page shows; never the token. */
export function weixin_status(home) {
  const account = weixin_account(home);
  if (!account) return { bound: false, login_pending: Boolean(read_json(login_path(home))) };
  const state = read_state(home);
  return { bound: true, owner_id: account.owner_id, context_ready: Boolean(state.context_token), context_at: state.context_at,
    last_notice_at: state.notices.at(-1)?.sent_at || 0, last_error: state.last_error || '' };
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
      write_json(state_path(home), { ...read_state(home), cursor: '', context_token: '', context_at: 0, last_error: '' });
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

/**
 * Send one notice to the owner. `key` makes it idempotent; `room` ({site, room, title}) is where replies to it go.
 * Returns `sent`, `duplicate`, `unbound` or `no_context` (the owner has not messaged the bot since binding).
 */
export async function send_notice(home, { key, room = null, text }, client_options = {}) {
  const account = weixin_account(home);
  if (!account) return { status: 'unbound' };
  const state = read_state(home);
  if (key && state.notices.some(notice => notice.key === key)) return { status: 'duplicate' };
  if (!state.context_token) return { status: 'no_context' };
  const number = state.next_notice;
  const client = new IlinkClient(account, client_options);
  const body = `[CoDiscuss #${number}]${room?.title ? ` ${room.title}` : ''}\n${text}`;
  try {
    for (const chunk of split_text(body)) {
      await client.send({ peer_id: account.owner_id, client_id: randomUUID(), context_token: state.context_token, text: chunk });
    }
  } catch (error) {
    write_json(state_path(home), { ...read_state(home), last_error: error.message });
    throw error;
  }
  const latest = read_state(home);
  latest.notices = [...latest.notices, { number, key: key || '', site: room?.site || '', room: room?.room || '', sent_at: Date.now() }].slice(-RECENT_NOTICES);
  write_json(state_path(home), { ...latest, next_notice: number + 1, last_error: '' });
  return { status: 'sent', number };
}

/** The owner's private text messages in one update batch, with the notice each one quotes, if any. */
export function owner_texts(account, response) {
  const texts = [];
  for (const message of response.msgs ?? []) {
    if (message.message_type !== 1 || message.message_state !== 2 || message.group_id || message.from_user_id !== account.owner_id
        || (message.to_user_id && message.to_user_id !== account.account_id)) continue;
    const items = message.item_list ?? [];
    const text = items.filter(item => item.type === 1 && typeof item.text_item?.text === 'string').map(item => item.text_item.text).join('\n').trim();
    const quoted = items.map(item => item.ref_msg).filter(Boolean)
      .map(reference => `${reference.message_item?.text_item?.text ?? ''}\n${reference.title ?? ''}`.match(NOTICE_TAG)?.[1]).find(Boolean);
    texts.push({ text, quoted: quoted ? Number(quoted) : 0, media: items.some(item => item.type !== 1), context_token: message.context_token });
  }
  return texts;
}

/** The room a reply answers: the quoted notice's, else the latest notice that came from a room. */
function reply_target(state, quoted) {
  const rooms = state.notices.filter(notice => notice.room);
  return (quoted && rooms.find(notice => notice.number === quoted)) || rooms.at(-1) || null;
}

/**
 * Receive the owner's messages until `signal` aborts: refresh the reply context, and hand each text to `on_reply`
 * with the room it answers. `on_reply` returns a short confirmation or error sent back to Weixin.
 */
export async function receive_replies(home, { on_reply, log = () => {}, signal, fetch_impl } = {}) {
  while (!signal?.aborted) {
    const account = weixin_account(home);
    if (!account) { await sleep(UNBOUND_CHECK_MS, null, { signal }).catch(() => {}); continue; }
    const client = new IlinkClient(account, { signal, fetch: fetch_impl });
    try {
      const state = read_state(home);
      const response = await client.updates(state.cursor);
      const texts = owner_texts(account, response);
      const latest = read_state(home);
      const context = texts.map(item => item.context_token).filter(Boolean).at(-1);
      write_json(state_path(home), { ...latest, cursor: typeof response.get_updates_buf === 'string' && response.get_updates_buf ? response.get_updates_buf : latest.cursor,
        ...(context ? { context_token: context, context_at: Date.now(), last_error: '' } : {}) });
      for (const item of texts) await answer(home, account, client, item, on_reply, log);
    } catch (error) {
      if (signal?.aborted) break;
      log(`微信收件失败：${error.message}`);
      if (error.session_expired) write_json(state_path(home), { ...read_state(home), last_error: error.message });
      await sleep(RECEIVE_RETRY_MS, null, { signal }).catch(() => {});
    }
  }
}

/** Route one owner text to its room and tell the owner what happened. */
async function answer(home, account, client, item, on_reply, log) {
  const state = read_state(home);
  const target = reply_target(state, item.quoted);
  let reply;
  if (!item.text) reply = item.media ? '目前只能转发文字回复。' : '';
  else if (!target?.room) reply = '已收到。目前还没有房间通知，回复无处可发。';
  else {
    try { reply = await on_reply({ site: target.site, room: target.room, text: item.text }); }
    catch (error) { reply = `未能发到房间：${error.message}`; log(`微信回复未能发到房间 ${target.room}：${error.message}`); }
  }
  if (!reply || !state.context_token) return;
  try { await client.send({ peer_id: account.owner_id, client_id: randomUUID(), context_token: state.context_token, text: reply }); }
  catch (error) { log(`微信回执发送失败：${error.message}`); }
}

/** Whether a notice key was already sent; the runner keeps checking a pending goal until it is. */
export function notice_sent(home, key) {
  return read_state(home).notices.some(notice => notice.key === key);
}

/** Bound and able to send: the runner only waits on a pending goal's notice when this holds. */
export function can_notify(home) {
  return Boolean(weixin_account(home)) && Boolean(read_state(home).context_token);
}

/** `codiscuss launch weixin`: status, login, complete, test or unbind, from the settings page. */
export async function weixin_command(home, input = {}) {
  const action = input.action || 'status';
  if (action === 'status') return weixin_status(home);
  if (action === 'login') return begin_login(home);
  if (action === 'complete') return { ...await complete_login(home), ...weixin_status(home) };
  if (action === 'unbind') return unbind(home);
  if (action === 'test') {
    const result = await send_notice(home, { text: '这是一条测试通知。房间里的 Goal 等你确认时，会像这样发到微信；直接回复即可发回该房间。' });
    if (result.status === 'no_context') throw new Error('还收不到你的消息：请先在微信里给机器人发一条消息，再点发送测试');
    if (result.status === 'unbound') throw new Error('尚未绑定微信');
    return { ...result, ...weixin_status(home) };
  }
  throw new Error('action 须为 status、login、complete、test 或 unbind');
}


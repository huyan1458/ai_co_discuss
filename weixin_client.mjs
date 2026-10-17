/** 腾讯 iLink 文本传输。独立实现公开协议，不加载 Hermes / OpenClaw 或模型客户端。 */
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';

import QRCode from 'qrcode';

export const ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com';
const PROTOCOL_VERSION = '2.4.10';
const CLIENT_VERSION = (2 << 16) | (4 << 8) | 10;
const BOT_AGENT = 'CodexMessageBridge/0.2.0';
const REQUEST_TIMEOUT_MS = 40_000;
const LOGIN_LIFETIME_MS = 5 * 60_000;
const LOGIN_INTERVAL_MS = 1_000;

/** Restrict credential-bearing requests and QR redirects to Tencent's Weixin hosts. */
export function validate_base_url(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port
      || !url.hostname.endsWith('.weixin.qq.com') || url.pathname !== '/'
      || url.search || url.hash) throw new Error('iLink 地址必须为受信任的微信 HTTPS 主机');
  return url.origin;
}

/** Preserve uint64 message identifiers instead of rounding them through a JS number. */
export function parse_ilink_json(text) {
  return JSON.parse(text, (_key, value, context) => (
    typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)
      ? context.source : value
  ));
}

/** An explicit API rejection is distinguishable from an uncertain transport outcome. */
export class IlinkError extends Error {
  constructor(message, code = null) {
    super(message);
    this.code = code;
    this.session_expired = code === -14;
  }
}

/** Minimal HTTPS client; writes are attempted once and never silently retried. */
export class IlinkClient {
  constructor(account = {}, options = {}) {
    this.base_url = validate_base_url(account.base_url || ILINK_BASE_URL);
    this.token = account.token;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.signal = options.signal;
  }

  /** Build protocol headers, using a token only on authenticated POSTs. */
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

  /** Send one request without following HTTP redirects or exposing response bodies in errors. */
  async request(endpoint, body, options = {}) {
    const method = body === undefined ? 'GET' : 'POST';
    const base_url = validate_base_url(options.base_url ?? this.base_url);
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = this.signal ? AbortSignal.any([this.signal, timeout]) : timeout;
    const response = await this.fetch(`${base_url}/ilink/bot/${endpoint}`, {
      method, redirect: 'error', signal,
      headers: this.headers(options.authenticated ?? false, method),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new IlinkError(`iLink HTTP ${response.status}，结果需核查`);
    let result;
    try { result = parse_ilink_json(await response.text()); }
    catch { throw new IlinkError('iLink 返回无效 JSON，结果需核查'); }
    if (!result || typeof result !== 'object') throw new IlinkError('iLink 返回格式无效');
    const code = [result.ret, result.errcode].find(value => value != null && Number(value) !== 0);
    if (code !== undefined) throw new IlinkError(`iLink 拒绝请求（${Number(code)}）`, Number(code));
    return result;
  }

  /** Request a QR code at the fixed bootstrap host; existing credentials stay local. */
  create_qr(previous_token) {
    return this.request('get_bot_qrcode?bot_type=3', {
      local_token_list: previous_token ? [previous_token] : [],
    }, { base_url: ILINK_BASE_URL });
  }

  /** Poll the current QR challenge, optionally answering the phone's verification code. */
  qr_status(login, verify_code) {
    const query = new URLSearchParams({ qrcode: login.qrcode });
    if (verify_code) query.set('verify_code', verify_code);
    return this.request(`get_qrcode_status?${query}`, undefined, { base_url: login.base_url });
  }

  /** Long-poll inbound messages from the last durably saved cursor. */
  async updates(cursor) {
    try {
      return await this.request('getupdates', {
        get_updates_buf: cursor,
        base_info: { channel_version: PROTOCOL_VERSION, bot_agent: BOT_AGENT },
      }, { authenticated: true });
    } catch (error) {
      if (!this.signal?.aborted && error.name === 'TimeoutError') return { msgs: [] };
      throw error;
    }
  }

  /** Send a single text chunk with the latest peer context and a durable client ID. */
  async send(message) {
    const result = await this.request('sendmessage', {
      msg: {
        from_user_id: '', to_user_id: message.peer_id, client_id: message.client_id,
        message_type: 2, message_state: 2, context_token: message.context_token,
        item_list: [{ type: 1, text_item: { text: message.text } }],
      }, base_info: { channel_version: PROTOCOL_VERSION, bot_agent: BOT_AGENT },
    }, { authenticated: true });
    const has_message_id = ['string', 'number'].includes(typeof result.message_id)
      && String(result.message_id).trim() !== '';
    if (result.ret !== 0 && !has_message_id) {
      throw new IlinkError('微信发送缺少明确成功回执，结果需核查');
    }
    return result;
  }
}

/** Write a local secret atomically; POSIX mode is private, Windows follows directory ACLs. */
export function save_json(path, data) {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(temporary, path);
}

/** Read a saved credential or login challenge without logging its contents. */
export function read_json(path, optional = false) {
  if (optional && !existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Validate the confirmed account and scanner identity before enabling any remote command. */
export function load_account(path) {
  const account = read_json(path);
  if (![account.account_id, account.owner_id, account.token].every(value => (
    typeof value === 'string' && value.trim()
  ))) throw new Error('微信凭据不完整，请重新扫码登录');
  return { ...account, base_url: validate_base_url(account.base_url) };
}

/** Serialize receiving/login only; sending does not need this OS-backed lock. */
export function acquire_account_lock(account_path) {
  mkdirSync(dirname(resolve(account_path)), { recursive: true });
  const lock = new DatabaseSync(`${account_path}.lock.sqlite3`);
  try { lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE'); }
  catch { lock.close(); throw new Error('此微信通道已有收件或登录进程；本次操作不可并行，notify 发送不受此锁限制'); }
  return () => lock.close();
}

/** Create a local PNG QR code and persist a resumable login challenge. */
export async function begin_login(account_path, options = {}) {
  const client = options.client ?? new IlinkClient();
  const previous = read_json(account_path, true);
  const result = await client.create_qr(previous?.token);
  if (!result.qrcode || !result.qrcode_img_content) throw new Error('微信未返回有效二维码');
  const login = { qrcode: result.qrcode, base_url: ILINK_BASE_URL, created_at: Date.now() };
  const png = await QRCode.toBuffer(result.qrcode_img_content, { type: 'png', margin: 4, scale: 8 });
  save_json(`${account_path}.login.json`, login);
  const qr_path = `${account_path}.qr.png`;
  writeFileSync(qr_path, png, { mode: 0o600 });
  return { status: 'scan_required', qr_path: resolve(qr_path), expires_in_seconds: LOGIN_LIFETIME_MS / 1_000 };
}

/** Validate and persist only a fully confirmed response; no token appears in the result. */
function confirm_login(account_path, response) {
  const account = {
    account_id: response.ilink_bot_id, owner_id: response.ilink_user_id,
    token: response.bot_token, base_url: validate_base_url(response.baseurl || ILINK_BASE_URL),
  };
  if (![account.account_id, account.owner_id, account.token].every(value => (
    typeof value === 'string' && value.trim()
  ))) throw new Error('微信确认响应缺少账号、扫码用户或凭据，未启用通道');
  save_json(account_path, account);
  return { status: 'connected', account_id: account.account_id, owner_id: account.owner_id };
}

/** Resume QR verification in bounded polls; keep the challenge when user action is needed. */
export async function complete_login(account_path, options = {}) {
  const login_path = `${account_path}.login.json`;
  const login = read_json(login_path);
  const client = options.client ?? new IlinkClient();
  const deadline = Date.now() + (options.timeout_ms ?? 60_000);
  do {
    if (Date.now() - login.created_at >= LOGIN_LIFETIME_MS) return { status: 'expired' };
    const response = await client.qr_status(login, options.verify_code);
    if (response.status === 'confirmed') return confirm_login(account_path, response);
    if (['expired', 'need_verifycode', 'verify_code_blocked', 'binded_redirect'].includes(response.status)) {
      return { status: response.status };
    }
    if (response.status === 'scaned_but_redirect') {
      login.base_url = validate_base_url(`https://${response.redirect_host}`);
      save_json(login_path, login);
    } else if (!['wait', 'scaned'].includes(response.status)) {
      throw new Error('微信返回未知扫码状态');
    }
    if (Date.now() >= deadline) break;
    await sleep(Math.min(LOGIN_INTERVAL_MS, deadline - Date.now()));
  } while (Date.now() < deadline);
  return { status: 'waiting' };
}

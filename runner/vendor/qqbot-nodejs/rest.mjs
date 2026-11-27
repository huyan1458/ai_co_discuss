// Text-only extraction from the upstream TokenManager, ApiClient, MessageApi and routes.
const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';
const API_URL = 'https://api.sgroup.qq.com';
const TOKEN_TIMEOUT_MS = 10_000;
const API_TIMEOUT_MS = 30_000;
const REFRESH_AHEAD_MS = 5 * 60 * 1000;
const DEFAULT_TOKEN_TTL_SECONDS = 7200;
const MESSAGE_SEQUENCE_SPACE = 65536;

async function request(fetch_impl, url, options) {
  const { body, timeout, method, token } = options;
  const response = await fetch_impl(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `QQBot ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    redirect: 'error',
    signal: AbortSignal.timeout(timeout),
  });
  const raw = await response.text();
  let data;
  try { data = JSON.parse(raw); } catch { /* non-JSON provider errors are handled below */ }
  const code = data?.code ?? data?.err_code;
  if (!response.ok || (code != null && Number(code) !== 0)) {
    const detail = data?.message ?? data?.err_msg ?? raw.slice(0, 200);
    throw Object.assign(new Error(`QQ API HTTP ${response.status}`), {
      code: code ?? response.status, detail, http_status: response.status,
    });
  }
  if (!data || typeof data !== 'object') throw new Error('QQ API did not return a JSON object');
  return data;
}

/** Exchange credentials once per token lifetime; concurrent requests share the exchange. */
export class TokenManager {
  cached = null;
  pending = null;

  constructor(account, fetch_impl) {
    this.account = account;
    this.fetch_impl = fetch_impl;
  }

  clearCache() { this.cached = null; }

  async getAccessToken() {
    if (this.cached && Date.now() < this.cached.refresh_at) return this.cached.token;
    this.pending ??= this.fetchToken().finally(() => { this.pending = null; });
    return this.pending;
  }

  async fetchToken() {
    const data = await request(this.fetch_impl, TOKEN_URL, { method: 'POST', timeout: TOKEN_TIMEOUT_MS,
      body: { appId: this.account.app_id, clientSecret: this.account.app_secret } });
    if (typeof data.access_token !== 'string' || !data.access_token) {
      throw Object.assign(new Error('QQ did not issue an access token'), {
        code: data.code ?? data.err_code, detail: data.message ?? data.err_msg,
      });
    }
    const lifetime = (Number(data.expires_in) || DEFAULT_TOKEN_TTL_SECONDS) * 1000;
    this.cached = { token: data.access_token, refresh_at: Date.now() + lifetime - Math.min(REFRESH_AHEAD_MS, lifetime / 3) };
    return data.access_token;
  }
}

/** Gateway discovery and QQ C2C plain-text messages, without media or the high-level bot. */
export class MessageApi {
  constructor(tokens, fetch_impl) {
    this.tokens = tokens;
    this.fetch_impl = fetch_impl;
  }

  async call(token, method, path, body) {
    try { return await request(this.fetch_impl, API_URL + path, { token, method, body, timeout: API_TIMEOUT_MS }); }
    catch (error) {
      if (error.http_status !== 401) throw error;
      this.tokens.clearCache();
      return request(this.fetch_impl, API_URL + path, {
        token: await this.tokens.getAccessToken(), method, body, timeout: API_TIMEOUT_MS,
      });
    }
  }

  async getGatewayUrl(token) {
    const { url } = await request(this.fetch_impl, API_URL + '/gateway', {
      token, method: 'GET', timeout: API_TIMEOUT_MS,
    }).catch(error => {
      if (error.http_status === 401) this.tokens.clearCache();
      throw error;
    });
    if (typeof url !== 'string' || !url.startsWith('wss://')) throw new Error('QQ API returned an invalid Gateway URL');
    return url;
  }

  async sendText(openid, content, reply_id) {
    const body = { content, msg_type: 0 };
    if (reply_id) {
      body.msg_id = reply_id;
      body.msg_seq = Math.floor(Math.random() * MESSAGE_SEQUENCE_SPACE);
    }
    return this.call(await this.tokens.getAccessToken(), 'POST', `/v2/users/${encodeURIComponent(openid)}/messages`, body);
  }
}

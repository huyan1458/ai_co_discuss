/**
 * QQ through a personal QQ account: the owner runs a OneBot 11 implementation (NapCat, SnowLuma, LLOneBot…) that logs
 * in a QQ account and serves a forward WebSocket; this channel connects to it with Node's built-in WebSocket. Unlike the
 * official QQ bot, the account is an ordinary QQ user, so it may message the owner at any time; the cost is an
 * unofficial protocol (the login can be invalidated or the account restricted), which the settings page states.
 *
 * OneBot 11: events arrive as JSON (`post_type: "message"`); actions are `{action, params, echo}` answered by
 * `{status, retcode, data, echo}`. The access token goes in the `access_token` query parameter, which the standard
 * accepts and which Node's WebSocket can send without custom headers.
 */
import { randomUUID } from 'node:crypto';
import { bot_channel } from './channel_bot.mjs';
import { t } from './i18n.mjs';

const ACTION_TIMEOUT_MS = 15_000;
const TEXT_LIMIT = 4_000;

/** The WebSocket address with the access token, from a saved `ws://` or `wss://` URL. */
function socket_url(account) {
  const url = new URL(account.url);
  if (account.token) url.searchParams.set('access_token', account.token);
  return url.href;
}

function valid_url(value) {
  try { return ['ws:', 'wss:'].includes(new URL(value).protocol); } catch { return false; }
}

/** Open a socket and resolve once it is open; rejects with the close reason otherwise. */
function open_socket(account, signal) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(socket_url(account));
    const fail = reason => { socket.close(); reject(new Error(reason)); };
    socket.addEventListener('open', () => resolve(socket), { once: true });
    socket.addEventListener('error', () => fail(t('连不上 OneBot 地址，请确认 NapCat 等程序在运行、地址与令牌正确。')), { once: true });
    signal?.addEventListener('abort', () => fail('aborted'), { once: true });
  });
}

/** Call one OneBot action on its own short-lived connection; returns its `data`. */
async function call(account, action, params, options = {}) {
  const socket = await open_socket(account, options.signal);
  const echo = randomUUID();
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(t('OneBot 未在 15 秒内响应 {action}。', { action }))), ACTION_TIMEOUT_MS);
      socket.addEventListener('message', event => {
        let reply;
        try { reply = JSON.parse(String(event.data)); } catch { return; }
        if (reply.echo !== echo) return;
        clearTimeout(timer);
        if (reply.status === 'ok' || reply.retcode === 0) resolve(reply.data ?? {});
        else reject(Object.assign(new Error(t('OneBot 拒绝了 {action}（{code}）：{message}', { action, code: reply.retcode,
          message: reply.wording || reply.message || reply.msg || '' })), { code: reply.retcode, detail: reply.wording || reply.message || '' }));
      });
      socket.addEventListener('close', () => { clearTimeout(timer); reject(new Error(t('OneBot 连接已断开。'))); }, { once: true });
      socket.send(JSON.stringify({ action, params, echo }));
    });
  } finally { socket.close(); }
}

/** The text and quoted message id of a OneBot message, whether it came as segments or as a CQ-code string. */
export function message_parts(message) {
  if (Array.isArray(message)) {
    const text = message.filter(part => part.type === 'text').map(part => part.data?.text ?? '').join('').trim();
    const quoted = message.filter(part => part.type === 'reply' && part.data?.id != null).map(part => ({ id: String(part.data.id), text: '' }));
    return { text, quoted, media: !text && message.some(part => part.type !== 'reply') };
  }
  const raw = String(message ?? '');
  const quoted = [...raw.matchAll(/\[CQ:reply,(?:[^\]]*,)?id=(-?\d+)[^\]]*\]/g)].map(match => ({ id: match[1], text: '' }));
  const text = raw.replace(/\[CQ:[^\]]*\]/g, '').replace(/&#91;/g, '[').replace(/&#93;/g, ']').replace(/&amp;/g, '&').trim();
  return { text, quoted, media: !text && /\[CQ:/.test(raw) };
}

/** A private message from a person, in the shape `channel_bot.mjs` routes; group messages wait for the gateway. */
function owner_message(event) {
  if (event?.post_type !== 'message' || event.message_type !== 'private' || event.user_id == null) return null;
  return { sender_id: String(event.user_id), chat_id: String(event.user_id), sent_at: Number(event.time) * 1000,
    ...message_parts(event.message ?? event.raw_message) };
}

/** Hold one event connection until it closes or `signal` aborts. */
async function listen(account, options) {
  const socket = await open_socket(account, options.signal);
  await new Promise(resolve => {
    let queue = Promise.resolve();
    socket.addEventListener('message', event => {
      let data;
      try { data = JSON.parse(String(event.data)); } catch { return; }
      const item = owner_message(data);
      if (item) queue = queue.then(() => options.accept(item));
    });
    socket.addEventListener('close', resolve, { once: true });
    options.signal.addEventListener('abort', () => socket.close(), { once: true });
  });
  if (!options.signal.aborted) throw new Error(t('OneBot 连接已断开，稍后重连。'));
}

async function send(account, text, options) {
  const ids = [];
  const chars = Array.from(text);
  for (let start = 0; start < chars.length; start += TEXT_LIMIT) {
    const data = await call(account, 'send_private_msg', { user_id: Number(account.chat_id),
      message: [{ type: 'text', data: { text: chars.slice(start, start + TEXT_LIMIT).join('') } }] }, options);
    if (data.message_id == null) throw new Error(t('OneBot 未返回消息编号。'));
    ids.push(String(data.message_id));
  }
  return ids;
}

const channel = bot_channel({
  id: 'onebot', label: t('QQ（个人号）'),
  valid_token: () => true,
  hint: account => account?.self_id
    ? t('用你自己的 QQ 私聊机器人账号 {id}，发送绑定码。', { id: account.self_id })
    : t('用你自己的 QQ 私聊机器人账号，发送绑定码。'),
  not_ready: t('请先用你的 QQ 私聊机器人账号，发送绑定码。'),
  async verify(token, input) {
    const url = String(input.values?.url ?? '').trim();
    if (!valid_url(url)) throw new Error(t('OneBot 地址须以 ws:// 或 wss:// 开头，例如 ws://127.0.0.1:3001。'));
    const login = await call({ url, token }, 'get_login_info', {}, input);
    return { url, self_id: login.user_id == null ? '' : String(login.user_id), nickname: login.nickname || '' };
  },
  send, listen,
});

export const onebot_channel = { ...channel,
  fields: [{ key: 'url', label: t('OneBot 地址（如 ws://127.0.0.1:3001）') }, { key: 'token', label: t('访问令牌（没有可留空）'), secret: true, optional: true }] };

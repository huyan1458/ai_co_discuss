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
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { bot_channel } from './channel_bot.mjs';
import { t } from './i18n.mjs';

const ACTION_TIMEOUT_MS = 15_000;
const GROUP_MEMBER_CHECK_MS = 4_000;
const GROUP_MEMBER_CHECK_CONCURRENCY = 6;
const TEXT_LIMIT = 4_000;
const MEDIA_LIMIT = 4 * 1024 * 1024;
const MEDIA = { images: true, files: true, max_bytes: MEDIA_LIMIT };

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

/** A private message from a person, in the shape `channel_bot.mjs` routes. */
function owner_message(event) {
  if (event?.post_type !== 'message' || event.message_type !== 'private' || event.user_id == null) return null;
  const id = String(event.user_id);
  return { sender_id: id, chat_id: id, sent_at: Number(event.time) * 1000,
    chat: { kind: 'private', id, title: '' }, sender: { id, name: String(event.sender?.nickname || id) },
    ...(event.message_id != null ? { message_id: String(event.message_id) } : {}),
    ...message_parts(event.message ?? event.raw_message) };
}

/** Normalize group events without treating mentions or quoted text as plain messages. */
export function onebot_group_message(event, self_id) {
  if (event?.post_type !== 'message' || event.message_type !== 'group'
      || event.group_id == null || event.user_id == null || event.message_id == null
      || !self_id || String(event.user_id) === String(self_id)) return null;
  const raw = event.message ?? event.raw_message;
  const { text, quoted } = message_parts(raw);
  if (!text) return null;
  const sender_id = String(event.user_id);
  const mentions = Array.isArray(raw) ? raw.filter(part => part.type === 'at').map(part => String(part.data?.qq))
    : [...String(raw ?? '').matchAll(/\[CQ:at,qq=(\d+)(?:,[^\]]*)?\]/g)].map(match => match[1]);
  return { chat: { kind: 'group', id: String(event.group_id), title: String(event.group_name || '') },
    sender: { id: sender_id, name: String(event.sender?.card || event.sender?.nickname || sender_id) },
    sender_id, text, quoted, mentioned: mentions.includes(String(self_id)), message_id: String(event.message_id) };
}

/** Read memberships live from the logged-in OneBot instance. */
async function groups(account, options) {
  const result = await call(account, 'get_group_list', {}, options);
  if (!Array.isArray(result)) throw new Error(t('OneBot 未返回群列表。'));
  const entries = result.filter(item => item?.group_id != null);
  const listed = entries.map(item => ({ id: String(item.group_id), title: String(item.group_name || item.group_id) }));
  if (options?.check_owner !== false) await check_group_owners(account, entries, listed, options?.signal);
  return listed;
}

/** Check membership as best effort without delaying the group list for every provider timeout. */
async function check_group_owners(account, entries, listed, parent_signal) {
  const deadline = AbortSignal.timeout(GROUP_MEMBER_CHECK_MS);
  const signal = parent_signal ? AbortSignal.any([parent_signal, deadline]) : deadline;
  let next = 0;
  const check = async () => {
    while (!signal.aborted && next < entries.length) {
      const index = next++;
      const entry = entries[index];
      const members = await call(account, 'get_group_member_list', { group_id: Number(entry.group_id) },
        { signal: AbortSignal.any([signal]) }).catch(() => null);
      if (!Array.isArray(members)) continue;
      const ids = members.map(member => String(member?.user_id ?? ''));
      if (ids.includes(String(account.owner_id))) listed[index].owner_in_group = true;
      else if (ids.includes(String(account.self_id)) && ids.every(id => /^\d+$/.test(id)) &&
          !(Number(entry.member_count) > new Set(ids).size)) listed[index].owner_in_group = false;
    }
  };
  await Promise.all(Array.from({ length: Math.min(entries.length, GROUP_MEMBER_CHECK_CONCURRENCY) }, check));
}

function media_segment({ path, name, type }) {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > MEDIA_LIMIT) throw new Error(t('附件超过渠道大小上限，未发送。'));
  const data = readFileSync(path);
  if (data.length > MEDIA_LIMIT) throw new Error(t('附件超过渠道大小上限，未发送。'));
  const file = `base64://${data.toString('base64')}`;
  if (type === 'image') return { type, data: { file } };
  if (type === 'file') return { type, data: { file, name } };
  throw new Error(t('此渠道不支持发送该类型的附件。'));
}

/** Send one group message; an unknown or empty receipt is a failure, never a retry. */
async function send_group(account, text, options) {
  const { chat, reply_to, mention, media = [] } = options;
  const message = [
    ...(reply_to ? [{ type: 'reply', data: { id: String(reply_to) } }] : []),
    ...(mention ? [{ type: 'at', data: { qq: String(mention) } }] : []),
    ...(text ? [{ type: 'text', data: { text } }] : []),
    ...media.map(media_segment),
  ];
  const data = await call(account, 'send_group_msg', { group_id: Number(chat.id), message }, options)
    .catch(error => { throw media.length ? new Error(t('OneBot 群附件发送未获确认。')) : error; });
  if (data.message_id == null || String(data.message_id).trim() === '') throw new Error(t('OneBot 未返回消息编号。'));
  return [String(data.message_id)];
}

/** Hold one event connection until it closes or `signal` aborts. */
async function listen(account, options) {
  const socket = await open_socket(account, options.signal);
  await new Promise(resolve => {
    let queue = Promise.resolve();
    socket.addEventListener('message', event => {
      let data;
      try { data = JSON.parse(String(event.data)); } catch { return; }
      const item = owner_message(data) || (options.accept_group ? onebot_group_message(data, account.self_id) : null);
      if (item) queue = queue.then(() => {
        if (item.chat?.kind !== 'group') return options.accept(item);
        const current = group_account(options.home);
        if (options.signal.aborted || !current?.owner_id || current.generation !== account.generation) return;
        return options.accept_group({ ...item, owner: item.sender.id === current.owner_id, owner_id: current.owner_id });
      }).catch(error => options.log(error.message));
    });
    socket.addEventListener('close', resolve, { once: true });
    options.signal.addEventListener('abort', () => socket.close(), { once: true });
  });
  if (!options.signal.aborted) throw new Error(t('OneBot 连接已断开，稍后重连。'));
}

async function send(account, text, options) {
  if (options?.chat?.kind === 'group') return send_group(account, text, options);
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

function group_account(home) {
  try { return JSON.parse(readFileSync(join(home, 'onebot', 'account.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export const onebot_channel = { ...channel,
  capabilities: { groups: true, text_limit: TEXT_LIMIT, media: MEDIA },
  status(home) {
    const status = channel.status(home);
    const account_id = status.bound && group_account(home)?.self_id;
    return account_id ? { ...status, account_id: String(account_id) } : status;
  },
  owner_id: home => group_account(home)?.owner_id || '',
  groups(home, options) {
    const account = group_account(home);
    if (!account?.owner_id) throw new Error(channel.not_ready);
    return groups(account, options);
  },
  receive(home, options) {
    return channel.receive(home, { ...options, home, accept_group: options.on_group });
  },
  fields: [{ key: 'url', label: t('OneBot 地址（如 ws://127.0.0.1:3001）') }, { key: 'token', label: t('访问令牌（没有可留空）'), secret: true, optional: true }] };

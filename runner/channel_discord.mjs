import { setTimeout as delay } from 'node:timers/promises';
import { bot_channel } from './channel_bot.mjs';
import { t } from './i18n.mjs';
import { discord_gateway } from './vendor/oceanic/gateway.mjs';

const REST = 'https://discord.com/api/v10';
const REQUEST_MS = 15_000;
const MAX_RETRY_MS = 60_000;
const RECONNECT_MS = 1_500;
const IDENTIFY_WAIT_MS = 5_000;
const TEXT_LIMIT = 2000;

async function request(token, path, body, { fetch_impl = fetch, signal } = {}) {
  for (let attempt = 0; ; attempt++) {
    const deadline = AbortSignal.timeout(REQUEST_MS);
    const response = await fetch_impl(REST + path, {
      method: body ? 'POST' : 'GET', headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
      body: body && JSON.stringify(body), signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      redirect: 'error',
    });
    const data = await response.json();
    if (response.ok) return data;
    const wait_ms = Number(data.retry_after) * 1000;
    if (response.status === 429 && attempt === 0 && wait_ms >= 0 && wait_ms <= MAX_RETRY_MS) {
      await delay(wait_ms, undefined, { signal });
      continue;
    }
    throw Object.assign(new Error(data.message || `HTTP ${response.status}`), {
      code: data.code ?? response.status, detail: data.message || '',
    });
  }
}

async function send(account, text, options) {
  const channel = await request(account.token, '/users/@me/channels', { recipient_id: account.owner_id }, options);
  const ids = [];
  const chars = Array.from(text);
  for (let start = 0; start < chars.length; start += TEXT_LIMIT) {
    const result = await request(account.token, `/channels/${channel.id}/messages`, {
      content: chars.slice(start, start + TEXT_LIMIT).join(''), allowed_mentions: { parse: [] },
    }, options);
    if (!result?.id) throw new Error(t('Discord 未返回消息编号。'));
    ids.push(String(result.id));
  }
  return ids;
}

function owner_message(message) {
  if (message.guild_id || !message.author || message.author.bot || message.webhook_id) return null;
  const reference = message.message_reference?.message_id;
  return { sender_id: message.author.id, chat_id: message.channel_id, sent_at: Date.parse(message.timestamp),
    text: message.content || '', media: Boolean(message.attachments?.length || message.sticker_items?.length),
    quoted: reference ? [{ id: reference, text: message.referenced_message?.content || '' }] : [] };
}

async function listen(account, options) {
  const session = {};
  let pending = Promise.resolve();
  const on_message = message => {
    pending = pending.then(() => options.accept(owner_message(message))).catch(error => {
      options.log(t('Discord 回复处理失败：{error}', { error: error.message }));
    });
  };
  while (!options.signal.aborted) {
    try {
      await discord_gateway(account.token, session, { ...options, on_message });
    } catch (error) {
      if (error.fatal) throw error;
      if (!options.signal.aborted) options.log(t('Discord 连接中断：{error}', { error: error.message }));
    }
    await pending;
    await delay(session.id ? RECONNECT_MS : IDENTIFY_WAIT_MS, undefined, { signal: options.signal }).catch(() => {});
  }
}

export const discord_channel = bot_channel({
  id: 'discord', label: 'Discord',
  valid_token: token => /^[\w.-]+$/.test(token),
  hint: () => t('打开 Discord 与已安装机器人的私聊并发送绑定码。'),
  not_ready: t('请先在 Discord 私聊中发送绑定码。'),
  verify: (token, options) => request(token, '/users/@me', undefined, options)
    .then(profile => ({ username: profile.username })),
  send, listen,
});

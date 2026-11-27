import { bot_channel } from './channel_bot.mjs';
import { t } from './i18n.mjs';
import { telegram_request, telegram_updates } from './vendor/node-telegram-bot-api/text.mjs';

const TEXT_LIMIT = 4096;

/** Telegram long polling with a persisted next-update offset. */
async function listen(account, options) {
  let offset = account.offset;
  while (!options.signal.aborted) {
    const updates = await telegram_updates(account.token, offset, options);
    for (const update of updates) {
      if (options.signal.aborted) return;
      await options.accept(owner_message(update.message));
      offset = update.update_id + 1;
      options.advance(offset);
    }
  }
}

function owner_message(message) {
  if (message?.chat?.type !== 'private' || !message.from || message.from.is_bot) return null;
  const reply = message.reply_to_message;
  return { sender_id: String(message.from.id), chat_id: String(message.chat.id), sent_at: message.date * 1000,
    text: message.text || '', media: !message.text,
    quoted: reply ? [{ id: String(reply.message_id), text: reply.text || '' }] : [] };
}

async function send(account, text, options) {
  const ids = [];
  const chars = Array.from(text);
  for (let start = 0; start < chars.length; start += TEXT_LIMIT) {
    const result = await telegram_request(account.token, 'sendMessage', {
      chat_id: account.chat_id, text: chars.slice(start, start + TEXT_LIMIT).join(''),
    }, options);
    if (result?.message_id == null) throw new Error(t('Telegram 未返回消息编号。'));
    ids.push(String(result.message_id));
  }
  return ids;
}

export const telegram_channel = bot_channel({
  id: 'telegram', label: 'Telegram',
  valid_token: token => /^\d+:[\w-]+$/.test(token),
  hint: account => account?.username
    ? t('打开 Telegram 与 @{bot} 的私聊，点击 Start 后发送绑定码。', { bot: account.username })
    : t('打开 Telegram 机器人的私聊，点击 Start 后发送绑定码。'),
  not_ready: t('请先在 Telegram 私聊中发送绑定码。'),
  async verify(token, options) {
    const profile = await telegram_request(token, 'getMe', {}, options);
    return { username: profile.username };
  },
  send, listen,
});

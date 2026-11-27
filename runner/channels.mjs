/**
 * Owner notifications over chat channels (`CHANNELS`). The owner orders and enables them; a notice goes once, keyed by
 * its `key`, to the primary (first enabled) channel, falling back to the next in order when it fails or cannot send.
 * Every bound channel keeps listening, and a reply on any of them is routed back to the notice it answers.
 *
 * A channel module exports an object with:
 * - `id`, `label`: a stable id (also its settings and CLI name) and the name shown to the owner.
 * - `bound(home)`, `ready(home)`: credentials saved; able to send now (some channels need the owner to message first).
 * - `status(home)`: what the settings page shows, never a secret; `last_failure` when the latest send failed.
 * - `deliver(home, text, options)`: send one plain-text notice to the owner; returns the message ids a quoted reply
 *   may name. Throws on failure after recording it for `status`.
 * - `receive(home, {on_message, log, signal, fetch_impl})`: until `signal` aborts, hand each owner message
 *   (`{text, quoted: [{id, text}], media}`) to `on_message` and send back the receipt text it returns, if any. Waits
 *   quietly while unbound, so binding from the page starts it without a restart.
 * - `command(home, action, input)`: its own binding actions (login, unbind…), or null for an unknown action.
 * - `not_ready`: what a test says when the channel is bound but cannot send yet.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomic_json } from './files.mjs';
import { t } from './i18n.mjs';
import { format_notice } from './notice_text.mjs';
import { discord_channel } from './channel_discord.mjs';
import { feishu_channel } from './channel_feishu.mjs';
import { onebot_channel } from './channel_onebot.mjs';
import { qq_channel } from './channel_qq.mjs';
import { telegram_channel } from './channel_telegram.mjs';
import { legacy_notices, weixin_channel } from './weixin.mjs';

export const CHANNELS = [weixin_channel, telegram_channel, discord_channel, qq_channel, onebot_channel, feishu_channel];
const RECENT_NOTICES = 50;
const store_path = home => join(home, 'notify', 'notices.json');
// The owner's choice of channels: `{order: [id], enabled: [id]}`; the first enabled one is the primary.
const settings_path = home => join(home, 'notify', 'settings.json');

function channel_of(id) {
  const channel = CHANNELS.find(item => item.id === id);
  if (!channel) throw new Error(`未知的通知渠道：${id}`);
  return channel;
}

/** Recent notices with where each went: `{number, key, site, room, title, text, sent_at, deliveries: {channel: ids}}`. */
function read_store(home) {
  try { return JSON.parse(readFileSync(store_path(home), 'utf8')); }
  catch {
    const notices = legacy_notices(home);
    return { next_notice: (notices.at(-1)?.number || 0) + 1, notices };
  }
}

function write_store(home, store) {
  mkdirSync(join(home, 'notify'), { recursive: true, mode: 0o700 });
  atomic_json(store_path(home), { ...store, notices: store.notices.slice(-RECENT_NOTICES) });
}

function read_settings(home) {
  try {
    const value = JSON.parse(readFileSync(settings_path(home), 'utf8'));
    return { order: Array.isArray(value.order) ? value.order : [], enabled: Array.isArray(value.enabled) ? value.enabled : null };
  } catch { return { order: [], enabled: null }; }
}

/** Channels in the owner's order (new ones last); every channel is enabled until the owner chooses. */
function arranged(home) {
  const { order, enabled } = read_settings(home);
  const position = id => (order.includes(id) ? order.indexOf(id) : order.length + CHANNELS.findIndex(item => item.id === id));
  return [...CHANNELS].sort((left, right) => position(left.id) - position(right.id))
    .map(channel => ({ channel, enabled: !enabled || enabled.includes(channel.id) }));
}

/** The enabled channels in order: the first is the primary, the rest are tried when it fails. */
function enabled_channels(home) {
  return arranged(home).filter(item => item.enabled).map(item => item.channel);
}

/** Save the owner's order and enabled channels, keeping only known ids. */
function arrange(home, { order = [], enabled = [] }) {
  const known = id => CHANNELS.some(channel => channel.id === id);
  if (!Array.isArray(order) || !Array.isArray(enabled)) throw new Error(t('order 与 enabled 须为渠道编号列表'));
  mkdirSync(join(home, 'notify'), { recursive: true, mode: 0o700 });
  atomic_json(settings_path(home), { order: order.filter(known), enabled: enabled.filter(known) });
  return { channels: channels_status(home) };
}

/** Some enabled channel can send now. */
export function can_notify(home) {
  return enabled_channels(home).some(channel => channel.ready(home));
}

/** The notice already went out on some channel; the runner keeps trying until it does. */
export function notice_sent(home, key) {
  return Boolean(read_store(home).notices.find(item => item.key === key && Object.keys(item.deliveries || {}).length));
}

/**
 * Send one notice to the owner once: on the primary channel, or, when it fails or cannot send yet, on the next enabled
 * channel in the owner's order. `key` makes it idempotent; `room` ({site, room, title}) is where replies to it go;
 * `question` ({id, version}) lets a reply answer that question; `only` sends on that one channel (a test). Returns
 * `sent` (with the `channel` used), `duplicate`, `unbound` or `no_context` (bound, but no enabled channel can send
 * yet). When every ready channel fails, the first failure is thrown.
 */
export async function send_notice(home, { key = '', room = null, paragraphs, question = null, only = '' }, options = {}) {
  const channels = only ? [channel_of(only)] : enabled_channels(home);
  const ready = channels.filter(channel => channel.ready(home));
  if (!ready.length) return { status: channels.some(channel => channel.bound(home)) ? 'no_context' : 'unbound' };
  if (!only && key && notice_sent(home, key)) return { status: 'duplicate' };
  const text = format_notice(room?.title, paragraphs);
  const deliveries = {};
  let failure = null;
  for (const channel of ready) {
    try { deliveries[channel.id] = await channel.deliver(home, text, options); break; }
    catch (error) { failure ||= error; }
  }
  if (!Object.keys(deliveries).length) throw failure;
  const store = read_store(home);
  let notice = key ? store.notices.find(item => item.key === key) : null;
  if (notice) Object.assign(notice.deliveries, deliveries);
  else {
    notice = { number: store.next_notice, key, site: room?.site || '', room: room?.room || '', sent_at: Date.now(), text, deliveries,
      ...(question ? { question_id: question.id, version: question.version } : {}) };
    store.notices.push(notice);
    store.next_notice += 1;
  }
  write_store(home, store);
  return { status: 'sent', number: notice.number, channel: Object.keys(deliveries)[0] };
}

/**
 * The notice a reply on `channel` answers: the quoted one (by the channel's message id, else by its text), else the
 * latest one sent there. A notice without a room (a hosted account's failures, a test) answers to no room, and is never
 * passed over for an older room's: a reply meant for it must not become the owner's message in some other room.
 */
function reply_target(store, channel, quoted = [], strict_quote = false) {
  const sent_here = store.notices.filter(notice => notice.deliveries?.[channel]);
  for (const reference of quoted) {
    const found = sent_here.findLast(notice => (reference.id && notice.deliveries[channel].includes(reference.id))
      || (!strict_quote && reference.text && notice.text?.includes(reference.text)));
    if (found) return found;
  }
  return strict_quote && quoted.length ? null : sent_here.at(-1) || null;
}

/** Route one owner message to its room; returns the receipt to send back. */
async function route(home, channel, item, on_reply, log) {
  const target = reply_target(read_store(home), channel.id, item.quoted, item.strict_quote);
  if (!item.text) return item.media ? '目前只能转发文字回复。' : '';
  if (!target && item.strict_quote && item.quoted?.length) return t('找不到所引用的通知，这条回复没有发回房间。');
  if (!target) return '已收到。还没有房间给你发过通知，这条回复没有可发往的房间。';
  if (!target.room) return '已收到。这条通知不对应任何房间，回复不会转发；要回复某个房间，请引用那个房间的通知。';
  try {
    return await on_reply({ site: target.site, room: target.room, text: item.text,
      ...(target.question_id ? { question_id: target.question_id, version: target.version } : {}) });
  } catch (error) {
    log(`${channel.label}回复未能发到房间 ${target.room}：${error.message}`);
    return `未能发到房间：${error.message}`;
  }
}

/** Receive the owner's replies on every channel until `signal` aborts; `on_reply` posts one and returns a receipt. */
export async function receive_replies(home, { on_reply, log = () => {}, signal, fetch_impl, websocket_impl } = {}) {
  await Promise.all(CHANNELS.map(channel => channel.receive(home, {
    on_message: item => route(home, channel, item, on_reply, log), log, signal, fetch_impl, websocket_impl })));
}

/** Every channel's settings state, for the notifications section. */
export function channels_status(home) {
  const enabled = enabled_channels(home);
  return arranged(home).map(({ channel, enabled: on }) => ({ id: channel.id, label: channel.label, fields: channel.fields || [],
    enabled: on, primary: enabled[0] === channel, ...channel.status(home) }));
}

/**
 * `codiscuss launch notify`: without `channel`, the channels in order (or `action: "arrange"` with `order` and `enabled`
 * id lists to save the order and which are used); with `channel`, `action` is status (default), test, or the channel's
 * own binding actions.
 */
export async function channel_command(home, input = {}) {
  if (!input.channel) return input.action === 'arrange' ? arrange(home, input) : { channels: channels_status(home) };
  const channel = channel_of(input.channel);
  const action = input.action || 'status';
  if (action === 'status') return channel.status(home);
  if (action === 'test') {
    const result = await send_notice(home, { only: channel.id, room: { title: '测试' }, paragraphs: ['这是一条测试通知。',
      '房间里的 Goal 等你确认、或成员的问题等你回答时，会像这样发来。直接回复通知，就会作为你的发言发回那个房间；回复问题通知时写选项编号即可作答。'] });
    if (result.status === 'no_context') throw new Error(channel.not_ready);
    if (result.status === 'unbound') throw new Error(`尚未绑定${channel.label}`);
    return { ...result, ...channel.status(home) };
  }
  let result;
  try { result = await channel.command(home, action, input); }
  catch (error) {
    if (action !== 'configure') throw error;
    // A bare provider reply ("Unauthorized", "invalid app_secret") does not say what to do; keep it, but say which
    // channel refused the credentials and how to fix them. The original code stays on the error for diagnosis.
    throw Object.assign(new Error(t('{channel}没有通过凭据验证（{error}）。请核对填写的内容后重试；不清楚去哪里拿，展开“开始设置”看对应平台的步骤。',
      { channel: channel.label, error: error.message })), { code: error.code, detail: error.detail });
  }
  if (!result) throw new Error(`${channel.label}不支持操作 ${action}`);
  return result;
}

/** `codiscuss launch weixin`, kept for the settings page and scripts written before other channels. */
export function weixin_command(home, input = {}) {
  return channel_command(home, { ...input, channel: 'weixin' });
}

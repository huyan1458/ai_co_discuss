/**
 * Owner notifications over chat channels (`CHANNELS`). The owner orders and enables them; a notice goes once, keyed by
 * its `key`, to the primary (first enabled) channel, falling back to the next in order when it fails or cannot send.
 * Every bound channel keeps listening, and a reply on any of them is routed back to the notice it answers.
 *
 * A channel module exports an object with:
 * - `id`, `label`: a stable id (also its settings and CLI name) and the name shown to the owner.
 * - `bound(home)`, `ready(home)`: credentials saved; able to send now (some channels need the owner to message first).
 * - `status(home)`: what the settings page shows, never a secret; `last_failure` when the latest send failed.
 * - `capabilities.groups`, `capabilities.text_limit`, `capabilities.media`: group support, text limit and optional
 *   outbound media support `{images, files, max_bytes}`. Missing media support means text only.
 * - `groups(home)`: list the bound account's group memberships as `{id, title}` when supported.
 * - `deliver(home, text, options)`: send one plain-text notice to the owner, or to `options.chat` for a group;
 *   group media is an optional `options.media: [{path, name, type}]` list using local paths and `image|file` types.
 *   `options.reply_to` names an optional quoted message. Returns the message ids a quoted reply
 *   may name. Throws on failure after recording it for `status`.
 * - `receive(home, {on_message, log, signal, fetch_impl})`: until `signal` aborts, hand each owner message
 *   (`{text, quoted: [{id, text}], media}`) to `on_message` and send back the receipt text it returns, if any.
 *   Group events instead go to `on_group` with `chat`, `sender`, `mentioned` and `message_id`, without a receipt. Waits
 *   quietly while unbound, so binding from the page starts it without a restart.
 * - `command(home, action, input)`: its own binding actions (login, unbind…), or null for an unknown action.
 * - `not_ready`: what a test says when the channel is bound but cannot send yet.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomic_json } from './files.mjs';
import { site_fetch } from './entry_client.mjs';
import { t } from './i18n.mjs';
import { format_notice, plain_text, split_text } from './notice_text.mjs';
import { discord_channel } from './channel_discord.mjs';
import { feishu_channel } from './channel_feishu.mjs';
import { onebot_channel } from './channel_onebot.mjs';
import { qq_channel } from './channel_qq.mjs';
import { telegram_channel } from './channel_telegram.mjs';
import { legacy_notices, weixin_channel } from './weixin.mjs';

export const CHANNELS = [weixin_channel, telegram_channel, discord_channel, qq_channel, onebot_channel, feishu_channel];
const GROUP_FILE_TIMEOUT_MS = 15_000;

function private_group_url(raw, hosts) {
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    return hosts.has(host) || host === 'localhost' || host === '[::1]' || /^127\./.test(host)
      || new URLSearchParams(url.hash.slice(1)).has('codiscuss-connect') || url.searchParams.has('codiscuss-connect');
  } catch { return false; }
}

/** Strip configured owner sites and pairing links from group text, not public destinations. */
export function group_public_text(text, private_sites = []) {
  const hosts = new Set(private_sites.flatMap(site => {
    try { return [new URL(site).hostname.toLowerCase().replace(/\.$/, '')]; } catch { return []; }
  }));
  const hidden = url => private_group_url(url, hosts);
  return String(text || '').replace(/\[([^\]\n]*)\]\((https?:\/\/[^\s()<>]+)\)/gi, (whole, label, url) =>
    hidden(url) ? label : whole).replace(/https?:\/\/(?:\[[0-9a-f:.]+\])?[^\s<>()`"'\[\]，。；！？、]*/gi, url => {
    const core = url.replace(/[.,;!?]+$/, '');
    return hidden(core) ? url.slice(core.length) : url;
  }).trim();
}

/** Resolve the owner's configured local, online, relay and direct site addresses. */
export async function group_private_sites(home, site) {
  const { machine_links } = await import('./remote_launch.mjs');
  const links = machine_links(home);
  return [site, ...Object.keys(links.sites || {}), links.direct?.site].filter(Boolean);
}

async function group_attachment_response(config, attachment, fetch_site) {
  const url = `${config.site}/api/rooms/${config.room}/attachments/${encodeURIComponent(attachment.id)}/content`;
  const init = { redirect: 'error', signal: AbortSignal.timeout(GROUP_FILE_TIMEOUT_MS) };
  const response = await fetch_site(attachment.storage === 'object' ? `${url}?link=1` : url,
    { ...init, headers: { 'X-Discussion-Token': config.token } });
  if (!response.ok || attachment.storage !== 'object') return response;
  const payload = await response.json();
  const signed = new URL((payload.data ?? payload).url);
  if (signed.protocol !== 'https:') throw new Error(t('群附件下载失败。'));
  return fetch_site(signed.href, init);
}

async function bounded_group_data(response, limit) {
  if (!response.ok || !response.body) throw new Error(t('群附件下载失败。'));
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > limit) throw group_media_too_large();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

function group_media_too_large() {
  return Object.assign(new Error(t('附件超过渠道大小上限，未发送。')), { code: 'group_media_too_large' });
}

/** Download one published room attachment into a temporary file and send it once. */
export async function send_group_attachment(home, target, attachment, fetch_site = site_fetch) {
  const { channel, config, options, enabled } = target;
  const supports = channel.capabilities?.media;
  const type = attachment.content_type?.startsWith('image/') ? 'image' : 'file';
  if (!supports?.[type === 'image' ? 'images' : 'files'] || !Number.isSafeInteger(supports.max_bytes) || supports.max_bytes <= 0) {
    throw new Error(t('此渠道不支持发送该类型的附件。'));
  }
  if (attachment.size > supports.max_bytes) throw group_media_too_large();
  const data = await group_attachment_response(config, attachment, fetch_site)
    .then(response => bounded_group_data(response, supports.max_bytes))
    .catch(error => { throw error.code === 'group_media_too_large' ? error : new Error(t('群附件下载失败。')); });
  if (attachment.sha256 && createHash('sha256').update(data).digest('hex') !== attachment.sha256) {
    throw new Error(t('群附件下载失败。'));
  }
  if (enabled && !enabled()) return false;
  const directory = mkdtempSync(join(tmpdir(), 'codiscuss-group-media-'));
  try {
    const path = join(directory, 'attachment');
    writeFileSync(path, data, { mode: 0o600 });
    const ids = await channel.deliver(home, '', { ...options, media: [{ path, name: attachment.file_name || 'attachment', type }] });
    if (!ids?.length) throw new Error(t('群消息未取得送达回执。'));
    return true;
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
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
export async function send_notice(home, { key = '', room = null, paragraphs, question = null, only = '', web_only = false, verbatim = false }, options = {}) {
  const channels = only ? [channel_of(only)] : enabled_channels(home);
  const ready = channels.filter(channel => channel.ready(home));
  if (!ready.length) return { status: channels.some(channel => channel.bound(home)) ? 'no_context' : 'unbound' };
  if (key && read_store(home).notices.some(item => item.key === key && (only ? item.deliveries?.[only] : Object.keys(item.deliveries || {}).length))) return { status: 'duplicate' };
  const text = verbatim ? paragraphs.filter(Boolean).join('\n\n') : format_notice(room?.title, paragraphs);
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
      ...(question ? { question_id: question.id, version: question.version } : {}), ...(web_only ? { web_only: true } : {}) };
    store.notices.push(notice);
    store.next_notice += 1;
  }
  write_store(home, store);
  return { status: 'sent', number: notice.number, channel: Object.keys(deliveries)[0] };
}

/**
 * The notice a reply on `channel` answers: the quoted one (by the channel's message id, else by its text), else the
 * latest one sent there in legacy mode. Unquoted messages with MOSS enabled are new requests.
 */
function reply_target(store, channel, quoted = [], strict_quote = false, moss = false) {
  const sent_here = store.notices.filter(notice => notice.deliveries?.[channel]);
  for (const reference of quoted) {
    const found = sent_here.findLast(notice => (reference.id && notice.deliveries[channel].includes(reference.id))
      || (!strict_quote && reference.text && notice.text?.includes(reference.text)));
    if (found) return found;
  }
  return moss || strict_quote && quoted.length ? null : sent_here.at(-1) || null;
}

/** Route one owner message to its room; returns the receipt to send back. */
async function route(home, channel, item, on_reply, on_moss, log) {
  const target = reply_target(read_store(home), channel.id, item.quoted, item.strict_quote, Boolean(on_moss));
  if (!item.text) return item.media ? '目前只能转发文字回复。' : '';
  if (target?.web_only) return target.text;
  if (!target && !on_moss && item.strict_quote && item.quoted?.length) return t('找不到所引用的通知，这条回复没有发回房间。');
  if (!target && !on_moss) return '已收到。还没有房间给你发过通知，这条回复没有可发往的房间。';
  if (target && !target.room) return '已收到。这条通知不对应任何房间，回复不会转发；要回复某个房间，请引用那个房间的通知。';
  try {
    if (!target) return await on_moss({ channel: channel.id, label: channel.label, text: item.text });
    return await on_reply({ site: target.site, room: target.room, text: item.text,
      ...(on_moss ? { channel: channel.id, label: channel.label } : {}),
      ...(target.key?.startsWith('moss-group-owner:') ? { owner_notice: target.key, platform_id: item.message_id } : {}),
      ...(target.question_id ? { question_id: target.question_id, version: target.version } : {}) });
  } catch (error) {
    log(`${channel.label}回复未能发到房间 ${target?.room || 'MOSS'}：${error.message}`);
    if (!target || target.key?.startsWith('moss:')) return t('这条消息没能发给 MOSS，请稍后重试。');
    return t('未能发到房间：{error}', { error: error.message });
  }
}

/** Receive the owner's replies on every channel until `signal` aborts; `on_reply` posts one and returns a receipt. */
export async function receive_replies(home, { on_reply, on_moss, on_group, log = () => {}, signal, fetch_impl, websocket_impl } = {}) {
  await Promise.all(CHANNELS.map(channel => channel.receive(home, {
    on_message: item => route(home, channel, item, on_reply, on_moss, log),
    ...(on_group && channel.capabilities?.groups ? { on_group: item => on_group(channel, item) } : {}),
    log, signal, fetch_impl, websocket_impl })));
}

const MOSS_MAX_PARTS = 3;
const MOSS_OVERVIEW_CHARACTERS = 500;
// Weixin already splits by UTF-8 bytes. Use the other transports' text limits, with a conservative QQ bot limit.
const MOSS_CHARACTER_LIMITS = { telegram: 4096, discord: 2000, onebot: 4000, qq: 2000 };
// Feishu limits the serialized request to 150 KB, including its envelope and the double-encoded content field.
const FEISHU_TEXT_BUDGET = 149_000;
const MOSS_QUEUE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const moss_routes_path = home => join(home, 'notify', 'moss-replies.json');
const moss_queue_path = home => join(home, 'notify', 'moss-queue-receipts.json');

function saved_moss_queue_receipts(home) {
  try { return JSON.parse(readFileSync(moss_queue_path(home), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { total: 0, recent: [] }; throw error; }
}

/** Count receipts independently of reply-routing records, which are removed after delivery. */
export function moss_queue_receipts(home, now = Date.now()) {
  const { total, recent } = saved_moss_queue_receipts(home);
  return { total, last_7_days: recent.filter(at => at > now - MOSS_QUEUE_WINDOW_MS && at <= now).length };
}

function record_moss_queue_receipt(home, now = Date.now()) {
  const { total, recent } = saved_moss_queue_receipts(home);
  atomic_json(moss_queue_path(home), { total: total + 1, recent: [...recent.filter(at => at > now - MOSS_QUEUE_WINDOW_MS), now] });
}

function moss_routes(home) {
  try { return JSON.parse(readFileSync(moss_routes_path(home), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}

/** A private-channel task is identified by local routing receipts, not by strings in a user message. */
export function moss_private_channel_task(home, room, requests) {
  const routes = Object.values(moss_routes(home)).filter(item => item.room === room);
  return requests.length > 0 && requests.every(request => routes.some(item => item.message_id === request.message_id));
}

function change_moss_routes(home, change) {
  const routes = moss_routes(home);
  change(routes);
  mkdirSync(join(home, 'notify'), { recursive: true, mode: 0o700 });
  atomic_json(moss_routes_path(home), routes);
}

export function moss_approval_text(link = '') {
  const reminder = t('MOSS 需要你在网页确认或回答。');
  return link ? `${reminder} ${link}` : reminder;
}

export function moss_setup_text(link) {
  return t('MOSS 尚未配置，请在网页的 MOSS 页面完成设置。{link}', { link });
}

function pending_moss_question(room) {
  return room?.free?.questions?.some(question => question.blocking);
}

function moss_execution(room, routes, channel) {
  const execution = room.free?.members?.find(member => member.execution?.capabilities?.steer === true
    && ['started', 'dispatched'].includes(member.execution.status))?.execution;
  const inputs = room.free?.requests?.filter(item => item.execution_id === execution?.id) || [];
  // An answer can contain every input to its turn. Do not steer across channels or into a web-originated turn.
  if (execution && inputs.length && inputs.every(input =>
    routes.some(route => route.message_id === input.message_id && route.channel === channel))) return execution;
  return null;
}

export async function route_moss_message(home, { config, channel, label, text, request, post }) {
  const room = await request(config, '');
  const waiting_question = pending_moss_question(room);
  const submission_id = randomUUID();
  const content = `${t('来源渠道：{channel}', { channel: label })}\n\n${text}`;
  const routes = Object.values(moss_routes(home)).filter(route => route.room === config.room);
  const execution = waiting_question ? null : moss_execution(room, routes, channel);
  if (execution) {
    try {
      await request(config, `/executions/${execution.id}`, { action: 'interject', text: content, submission_id, live_only: true });
      return '';
    } catch (error) {
      if (![400, 409].includes(error.status) && !/^HTTP 40[09]\b/.test(error.message)) throw error;
    }
  }
  const route = { room: config.room, channel };
  change_moss_routes(home, all => { all[submission_id] = route; });
  const result = await post(config, { text: content, submission_id }, request);
  change_moss_routes(home, all => { if (all[submission_id]) Object.assign(all[submission_id], result); });
  if (!result.queued) return '';
  record_moss_queue_receipt(home);
  return waiting_question ? t('MOSS 正在等你在网页回答一个问题，这条消息已排队')
    : t('MOSS 正在处理上一件事，你的消息已排队');
}

async function resolve_moss_routes(home, config, room, request) {
  const routes = Object.entries(moss_routes(home)).filter(([, route]) => route.room === config.room);
  for (const [id, route] of routes) {
    if (route.message_id || room.free?.queued_messages?.items?.some(item => item.id === route.queued)) continue;
    const result = await request(config, `/messages?submission_id=${encodeURIComponent(id)}`);
    route.message_id = result.messages?.[0]?.id;
    if (route.message_id) change_moss_routes(home, all => { if (all[id]) all[id].message_id = route.message_id; });
  }
  return routes;
}

/** Resolve promoted channel messages before their next task, even if that room has no previous answer. */
export function refresh_moss_private_routes(home, config, room, request) {
  return resolve_moss_routes(home, config, room, request);
}

export function moss_question_channels(home, config, room, question_id) {
  const question = room?.free?.questions?.find(item => item.id === question_id);
  if (!question) return [];
  const anchors = new Set([question.message_id, ...(question.refs || [])]);
  return [...new Set(Object.values(moss_routes(home)).filter(route => route.room === config.room &&
    anchors.has(route.message_id)).map(route => route.channel))];
}

function split_moss_answer(text, channel) {
  if (channel === 'feishu') {
    return split_text(text, FEISHU_TEXT_BUDGET, char => Buffer.byteLength(JSON.stringify(JSON.stringify(char).slice(1, -1))) - 2);
  }
  const limit = MOSS_CHARACTER_LIMITS[channel];
  return limit ? split_text(text, limit, char => channel === 'discord' || channel === 'qq' ? char.length : 1) : split_text(text);
}

function moss_answer_parts(message, link, isolated, channel) {
  if (!isolated) return [t('MOSS 已处理，完整回答请在网页查看。{link}', { link })];
  const body = String(message.text || '');
  const parts = split_moss_answer(body, channel);
  if (parts.length <= MOSS_MAX_PARTS) return parts;
  const overview = [...plain_text(message.summary || body)];
  const excerpt = overview.slice(0, MOSS_OVERVIEW_CHARACTERS).join('');
  const tail = t('在网页查看完整回答：{link}', { link });
  return split_moss_answer(`${excerpt}${overview.length > MOSS_OVERVIEW_CHARACTERS ? '…' : ''}\n\n${tail}`, channel);
}

async function send_moss_parts(home, target, parts, send) {
  const key = `moss:${target.room.room}:${target.answer_id}`;
  for (let index = 0; index < parts.length; index += 1) {
    const result = await send(home, { key: index ? `${key}:${index + 1}` : key, only: target.channel,
      room: target.room, paragraphs: [parts[index]], verbatim: true });
    if (!['sent', 'duplicate'].includes(result.status)) return false;
  }
  return parts.length > 0;
}

export async function flush_moss_channel_replies(home, { config, room, request, link, send = send_notice }) {
  if (!room?.free?.requests?.some(item => item.answer_id)) return;
  const routes = await resolve_moss_routes(home, config, room, request);
  const requests = room.free.requests;
  for (const [id, route] of routes) {
    if (!route.message_id) continue;
    const answer_id = requests.find(item => item.message_id === route.message_id && item.answer_id)?.answer_id;
    if (!answer_id) continue;
    const sources = requests.filter(item => item.answer_id === answer_id);
    const isolated = sources.every(item => routes.some(([, source]) =>
      source.message_id === item.message_id && source.channel === route.channel));
    const message = isolated ? await request(config, `/messages/${answer_id}`) : {};
    const parts = moss_answer_parts(message, link, isolated, route.channel);
    const target = { answer_id, channel: route.channel, room: { site: config.site, room: config.room, title: room.title } };
    if (await send_moss_parts(home, target, parts, send)) change_moss_routes(home, all => { delete all[id]; });
  }
}

/** Every channel's settings state, for the notifications section. */
export function channels_status(home) {
  const enabled = enabled_channels(home);
  return arranged(home).map(({ channel, enabled: on }) => ({ id: channel.id, label: channel.label, fields: channel.fields || [],
    capabilities: channel.capabilities || { groups: false }, enabled: on, primary: enabled[0] === channel, ...channel.status(home) }));
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

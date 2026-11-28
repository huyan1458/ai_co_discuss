import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { api } from './discussion_runner.mjs';
import { site_fetch } from './entry_client.mjs';
import { atomic_json } from './files.mjs';
import { t } from './i18n.mjs';

const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const POLL_MS = 5_000;
const MAX_BATCH = 100;
const MAX_MUTES = 50;
const MUTE_TEXT_LENGTH = 200;

export function proactive_settings(saved = {}) {
  return { enabled: false, active_hours: { start: '09:00', end: '22:00' }, digest_at: '21:00', duties: [], mutes: [], ...saved };
}

/** General settings cannot create or overwrite duties and mutes. */
export function proactive_patch(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['enabled', 'active_hours', 'digest_at'].includes(key)) ||
    (Object.hasOwn(value, 'enabled') && typeof value.enabled !== 'boolean') ||
    (Object.hasOwn(value, 'digest_at') && (typeof value.digest_at !== 'string' || !TIME.test(value.digest_at))) ||
    (Object.hasOwn(value, 'active_hours') && !valid_hours(value.active_hours))) throw new Error(t('MOSS 主动汇报设置无效，时间须为 HH:MM'));
  return value;
}

/** Change a single entry while the caller holds the local MOSS settings lock. */
export function revise_proactive_list(settings, field, action, input) {
  if (action === 'remove' && typeof input.id === 'string' && input.id) return settings[field].filter(item => item.id !== input.id);
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (action !== 'add' || !text || (field === 'mutes' && !reason)) throw new Error(t('MOSS 职责或屏蔽记录参数无效'));
  const entry = { id: randomUUID(), text, created_at: new Date().toISOString() };
  return field === 'mutes' ? [...settings[field], { ...entry, text: [...text].slice(0, MUTE_TEXT_LENGTH).join(''), reason }].slice(-MAX_MUTES)
    : [...settings[field], entry];
}

function valid_hours(hours) {
  return hours && Object.keys(hours).length === 2 && [hours.start, hours.end].every(time => typeof time === 'string' && TIME.test(time));
}

function time_of(date) {
  return [date.getHours(), date.getMinutes()].map(value => String(value).padStart(2, '0')).join(':');
}

export function within_active_hours(hours, date) {
  const time = time_of(date);
  const { start, end } = hours;
  return start === end || (start < end ? start <= time && time < end : time >= start || time < end);
}

/** Find the next eligible digest time, including yesterday's digest if it was delayed overnight. */
function digest_time(settings, now) {
  const clock = (time, days = 0) => {
    const [hour, minute] = time.split(':').map(Number);
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, hour, minute);
  };
  const eligible = offset => {
    const digest = clock(settings.digest_at, offset);
    if (within_active_hours(settings.active_hours, digest)) return digest;
    const start = clock(settings.active_hours.start, offset);
    return start > digest ? start : clock(settings.active_hours.start, offset + 1);
  };
  const minute = new Date(now);
  minute.setSeconds(0, 0);
  const previous = eligible(-1);
  if (previous >= minute) return +previous;
  const today = eligible(0);
  return +(today >= minute ? today : eligible(1));
}

/** Establish a baseline for newly seen rooms, then keep only changes to relevant states. */
export function observe_attention(state, rooms, due) {
  const attention = {};
  for (const room of rooms) {
    if (room.system_kind || room.archived || !/^[A-Za-z0-9_-]+$/.test(room.id)) continue;
    const current = room.attention || '', previous = state.attention?.[room.id];
    attention[room.id] = current;
    if (previous === undefined || previous === current) continue;
    const type = ['waiting_user', 'failed'].includes(current) ? current : previous === 'running' && !current ? 'completed' : null;
    if (!type) continue;
    const key = `${room.id}:${type}`;
    state.events[key] = { id: randomUUID(), room: room.id, type, message: Number.isInteger(room.latest_id) ? room.latest_id : 0,
      ...(type !== 'waiting_user' ? { due: state.events[key]?.due ?? due } : {}) };
  }
  state.attention = attention;
  for (const [key, event] of Object.entries(state.events)) {
    if (event.type === 'waiting_user' && attention[event.room] !== 'waiting_user') delete state.events[key];
  }
}

function next_trigger(state, now) {
  const events = Object.values(state.events);
  const urgent = events.find(event => event.type === 'waiting_user');
  if (urgent) return { id: randomUUID(), events: [urgent] };
  const due = events.filter(event => (event.due ?? 0) <= +now);
  return due.length ? { id: randomUUID(), events: due.slice(0, MAX_BATCH) } : null;
}

async function read_rooms(site) {
  const response = await site_fetch(`${site}/api/rooms`, { signal: AbortSignal.timeout(10_000), redirect: 'error' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()).rooms;
}

function send_trigger(config, batch) {
  const text = batch.events.map(event => `${event.type} ${config.site}/?room=${event.room}${event.message ? ` #${event.message}` : ''}`).join('\n');
  return api(config, '/messages', { author: '用户', text, steward_proactive: true, submission_id: `steward-proactive-${batch.id}` });
}

/** Sample the local site once for all rooms. Persist before sending so a lost receipt never wakes MOSS twice. */
export async function steward_proactive_tick(home, config, settings, { now = new Date(), rooms = read_rooms, send = send_trigger, current = () => settings } = {}) {
  const path = join(home, 'steward-proactive.json');
  const saved = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
  const state = saved?.room === config?.room && saved ? saved : { room: config?.room, events: {} };
  const snapshot = JSON.stringify(saved);
  const eligible = value => value.enabled && value.duties.length;
  if (!config || !eligible(settings)) {
    if (!saved) return;
    state.events = {};
    delete state.batch;
    delete state.attention;
    if (JSON.stringify(state) !== snapshot) atomic_json(path, state);
    return;
  }
  observe_attention(state, await rooms(config.site), digest_time(settings, now));
  if (state.batch?.events.some(event => event.type === 'waiting_user' && state.attention[event.room] !== 'waiting_user')) delete state.batch;
  const latest = current();
  const can_send = eligible(latest) && within_active_hours(latest.active_hours, now);
  if (can_send) state.batch ??= next_trigger(state, now) || undefined;
  if (JSON.stringify(state) !== snapshot) atomic_json(path, state);
  if (!state.batch || !can_send) return;
  const receipt = await send(config, state.batch);
  // The site confirmed it did not write. Keep the events and let a new waiting-user event take priority next poll.
  if (receipt.busy) {
    delete state.batch;
    atomic_json(path, state);
    return;
  }
  if (!receipt.message?.id) return;
  for (const event of state.batch.events) {
    const key = `${event.room}:${event.type}`;
    if (state.events[key]?.id === event.id) delete state.events[key];
  }
  delete state.batch;
  atomic_json(path, state);
}

export { POLL_MS as STEWARD_PROACTIVE_POLL_MS };

import { t } from './i18n.js';
import { quota_account } from '../runner/adapters/profiles.mjs';
/**
 * How full a member's session context is, how much of its account's usage limits is gone and the tokens its runs took,
 * for the context meter, the token usage pill and the member cards. The runner reports both after each turn (account quotas also on their own for
 * software that can be asked); these helpers only read the room view and the site's quota list.
 */

// From this share of any window on, the reading is shown as a warning.
export const QUOTA_WARN = 0.8;
const WINDOW_LABELS = { five_hour: '5h', seven_day: '7d' };

export const tokens = (count) => count >= 999_500 ? `${(count / 1e6).toFixed(1).replace(/\.0$/, '')}M` : count >= 1000 ? `${Math.round(count / 1000)}K` : String(count);
const percent = (fraction) => `${Math.round(fraction * 100)}%`;
const clock = (seconds) => new Date(seconds * 1000).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
// A reset within a day reads as a time of day, a later one with its weekday (#15754).
const DAY_SECONDS = 86400;
export const reset_time = (seconds) => new Date(seconds * 1000).toLocaleString([], seconds - Date.now() / 1000 < DAY_SECONDS
  ? { hour: '2-digit', minute: '2-digit' } : { weekday: 'short', hour: '2-digit', minute: '2-digit' });
// A reading older than this says how old it is; a fresher one says nothing about it.
const STALE_SECONDS = 30 * 60;
function read_age(updated_at) {
  const age = Date.now() / 1000 - (updated_at || 0);
  if (!updated_at || age < STALE_SECONDS) return '';
  return age < 7200 ? t('{value1} 分钟前读取', { value1: Math.floor(age / 60) }) : t('{value1} 小时前读取', { value1: Math.floor(age / 3600) });
}

/** One room member's latest usage report `{account, context_used, context_window, updated_at}`, or null. */
export function member_usage(view, name) {
  return view?.room?.free?.members?.find((member) => member.name === name)?.usage || null;
}

/** The share of the context window in use (0..1), or null when the window is unknown. */
export function context_fraction(usage) {
  return usage?.context_used && usage.context_window ? Math.min(usage.context_used / usage.context_window, 1) : null;
}

/** The account quota by account name: the site's list, with the open room's newer reading over it; null when none. */
export function account_quota(view, account) {
  if (!account) return null;
  const listed = view?.quotas?.[account], room = view?.room?.free?.quotas?.[account];
  return (room?.updated_at || 0) >= (listed?.updated_at || 0) ? room || listed || null : listed;
}

/**
 * Only the windows that bind a model, where the software keeps a quota per group of models (agy's Gemini group and its
 * Claude and GPT group): the groups listing the model, with any window that names no models. Unchanged when the model
 * is unknown or no group lists it.
 */
export function for_model(quota, model) {
  const id = String(model || '').toLowerCase();
  const windows = quota?.windows || [];
  const listed = (item) => item.models?.some((prefix) => id.startsWith(prefix));
  // agy does not always list every model of a group (gemini-4-argon was missing, #15675); then the group named after
  // the model's family (`gemini` in "Gemini Models") is taken.
  const family = (item) => Boolean(item.group) && item.group.toLowerCase().includes(id.split(/[-_.]/)[0]);
  const fits = windows.some(listed) ? listed : windows.some(family) ? family : null;
  if (!id || !fits) return quota;
  return { ...quota, windows: windows.filter((item) => (!item.models?.length && !item.group) || fits(item)) };
}

/** The quota of the account a room member draws on, for the model it last ran with, or null. */
export function member_quota(view, name) {
  const member = view?.room?.free?.members?.find((item) => item.name === name);
  return for_model(account_quota(view, member?.usage?.account), member?.execution?.model);
}

/** The quota of the account a configured software card draws on, for its chosen model, or null. */
export function profile_quota(view, profile) {
  return for_model(account_quota(view, quota_account(profile)), profile?.model);
}

/** How alarming a used share is: '' below QUOTA_WARN, `warn` from there, `error` once used up (the next run will fail). */
export function used_level(fraction) {
  return fraction >= 1 ? 'error' : fraction >= QUOTA_WARN ? 'warn' : '';
}

/** The most used window as `{text: '7d 99%', level}`, or null when the quota has none. */
export function quota_peak(quota) {
  const top = [...quota?.windows || []].sort((left, right) => right.used - left.used)[0];
  return top ? { text: `${window_label(top)} ${percent(top.used)}`, level: used_level(top.used) } : null;
}

function window_label(item) {
  if (WINDOW_LABELS[item.kind]) return WINDOW_LABELS[item.kind];
  return item.minutes >= 1440 ? `${Math.round(item.minutes / 1440)}d` : item.minutes ? `${Math.round(item.minutes / 60)}h` : t('额度');
}

function groups(quota) {
  const grouped = new Map();
  for (const item of quota?.windows || []) grouped.set(item.group, [...grouped.get(item.group) || [], item]);
  return [...grouped];
}

/**
 * The windows to show, with the 5-hour limit an account does not have written out as such (#15627): a group that
 * reports a weekly window but no 5-hour one sets no 5-hour limit (Codex answers `secondary: null` for such a plan; agy
 * lists no `5h` bucket in such a group),
 * so `5h 不限` is shown rather than leaving the reader to wonder whether it was missed. Open windows have `open: true`.
 */
export function shown_windows(quota) {
  // agy too: its Gemini group lists only a weekly bucket while its other group keeps a 5-hour one (2026-11-28, #15731).
  return groups(quota).flatMap(([group, items]) => items.some((item) => item.kind === 'seven_day') && !items.some((item) => item.kind === 'five_hour')
    ? [{ kind: 'five_hour', minutes: 300, group, open: true }, ...items] : items);
}

const window_reading = (item) => item.open ? t('{name} 不限', { name: window_label(item) }) : `${window_label(item)} ${percent(item.used)}`;

/** One group's windows in a line, `5h 不限 · 7d 44%`; the group of the model a member uses when given `for_model`. */
export function quota_line(quota) {
  return shown_windows(quota).map(window_reading).join(' · ');
}

/** Short text: `5h 30% · 7d 99%`, groups named where the software keeps several, or the balance; '' when none. */
export function quota_text(quota) {
  if (!quota) return '';
  const parts = groups({ windows: shown_windows(quota) }).map(([group, items]) => {
    const text = items.map(window_reading).join(' · ');
    return group ? `${group} ${text}` : text;
  });
  if (quota.balance) parts.push(t('余额 {amount} {currency}', { amount: quota.balance.amount, currency: quota.balance.currency }));
  return parts.join('；');
}

/** The full reading for a tooltip: each window with when it resets, and when it was read. */
export function quota_title(quota) {
  if (!quota) return '';
  const lines = (quota.windows || []).map((item) => {
    const name = `${item.group ? `${item.group} ` : ''}${window_label(item)}`;
    return item.resets_at
      ? t('{name} 已用 {value1}，{time} 重置', { name, value1: percent(item.used), time: reset_time(item.resets_at) })
      : t('{name} 已用 {value1}', { name, value1: percent(item.used) });
  });
  if (quota.balance) lines.push(t('余额 {amount} {currency}', { amount: quota.balance.amount, currency: quota.balance.currency }));
  if (quota.updated_at) lines.push(t('读取于 {time}', { time: clock(quota.updated_at) }));
  return lines.join('\n');
}

/** Whether any window of the quota is at least QUOTA_WARN used. */
export function quota_high(quota) {
  return (quota?.windows || []).some((item) => item.used >= QUOTA_WARN);
}

/** One row per usage-limit window (and the balance) for the meter's panel: `{key, name, value, note, level}`. */
export function quota_rows(quota) {
  if (!quota) return [];
  const rows = shown_windows(quota).map((item, index) => ({
    key: `window-${index}`, name: `${item.group ? `${item.group} ` : ''}${window_label(item)}`,
    value: item.open ? t('不限') : t('已用 {value1}', { value1: percent(item.used) }), level: item.open ? '' : used_level(item.used),
    note: item.resets_at ? t('{time} 重置', { time: reset_time(item.resets_at) }) : '',
  }));
  if (quota.balance) rows.push({ key: 'balance', name: t('余额'), value: `${quota.balance.amount} ${quota.balance.currency}`.trim(), note: '', level: '' });
  const age = read_age(quota.updated_at);
  if (rows.length && age) rows[rows.length - 1].note = [rows[rows.length - 1].note, age].filter(Boolean).join(' · ');
  return rows;
}

/** All tokens of a turn's use `{input, cache_read, cache_write, output}`, 0 when none. */
export function turn_total(usage) {
  return usage ? (usage.input || 0) + (usage.cache_read || 0) + (usage.cache_write || 0) + (usage.output || 0) : 0;
}

/** The share of input read from cache as a whole percent, or null when no input was counted. */
export function cache_hit(usage) {
  const input = usage ? (usage.input || 0) + (usage.cache_read || 0) + (usage.cache_write || 0) : 0;
  // Rounded down, so 99.6% does not read as a full 100%.
  return input ? Math.floor((usage.cache_read || 0) / input * 100) : null;
}

/** The accounts the room's present members draw on, once each and with a reading: `[{account, name, quota}]`. */
export function room_accounts(view) {
  return [...new Set((view?.room?.free?.members || []).filter((member) => member.status === 'active')
    .map((member) => member.usage?.account).filter(Boolean))]
    .map((account) => ({ account, name: account.replace(/^api:/, ''), quota: account_quota(view, account) }))
    .filter((item) => item.quota && (item.quota.windows?.length || item.quota.balance));
}

/**
 * What a member's line says of its account's limits: a state, never figures, which stay with the account (rule four of
 * #15754). '' while every window is below QUOTA_WARN, `额度紧张` from there, `额度已用尽 · 14:00 恢复` once one is used up.
 */
export function quota_state(quota) {
  const windows = (quota?.windows || []).filter((item) => !item.open);
  const spent = windows.filter((item) => item.used >= 1).sort((left, right) => right.resets_at - left.resets_at)[0];
  if (spent) return spent.resets_at ? t('额度已用尽 · {time} 恢复', { time: reset_time(spent.resets_at) }) : t('额度已用尽');
  return windows.some((item) => item.used >= QUOTA_WARN) ? t('额度紧张') : '';
}

/** Each account's tightest window, `Claude 5h 44%`, with its level; a balance-only account shows its balance. */
export function account_peaks(view) {
  return room_accounts(view).map((item) => {
    const peak = quota_peak(item.quota);
    return { account: item.account, level: peak?.level || '', text: `${item.name} ${peak ? peak.text : quota_text(item.quota)}` };
  });
}

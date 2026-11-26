/**
 * Reading the generic background work list an execution carries (`[{id, kind, title, state, started_at, ended_at,
 * next_at, schedule}]`, times in ms, 0 when unknown) for the private chat: how an item is named and timed, and the
 * event lines its start and end leave in the session (as Claude Code prints them). Which software reported the work is
 * never known here.
 */
import { t } from "./i18n.js";

export const KIND_LABELS = { agent: t('子代理'), command: t('后台命令'), monitor: t('监视'), schedule: t('定时') };
export const KIND_ORDER = ["command", "agent", "monitor", "schedule"];
// Shell set-up a command line opens with (PowerShell encoding and environment settings) says nothing about what it does.
const SHELL_PREAMBLE = /^(?:\s*(?:\$env:[\w.]+|\$OutputEncoding|\[Console\]::\w+)\s*=\s*(?:'[^']*'|"[^"]*"|[^;]+);)+\s*/i;
// What an item's end says, one whole sentence per kind and way it ended.
const ENDED = {
  done: { command: (title) => t('后台命令“{value1}”已完成', { value1: title }), agent: (title) => t('子代理“{value1}”已结束', { value1: title }),
    monitor: (title) => t('监视“{value1}”已结束', { value1: title }), schedule: (title) => t('定时“{value1}”已结束', { value1: title }) },
  failed: { command: (title) => t('后台命令“{value1}”失败', { value1: title }), agent: (title) => t('子代理“{value1}”失败', { value1: title }),
    monitor: (title) => t('监视“{value1}”失败', { value1: title }), schedule: (title) => t('定时“{value1}”失败', { value1: title }) },
  stopped: { command: (title) => t('后台命令“{value1}”已停止', { value1: title }), agent: (title) => t('子代理“{value1}”已停止', { value1: title }),
    monitor: (title) => t('监视“{value1}”已停止', { value1: title }), schedule: (title) => t('定时“{value1}”已停止', { value1: title }) },
};
const STARTED = { command: (title) => t('后台命令“{value1}”已启动', { value1: title }), agent: (title) => t('子代理“{value1}”已启动', { value1: title }),
  monitor: (title) => t('监视“{value1}”已启动', { value1: title }), schedule: (title) => t('定时“{value1}”已设定', { value1: title }) };

// Characters of a title an event line quotes before cutting it short.
const EVENT_TITLE_CHARS = 60;
const clip = (text) => [...text].length > EVENT_TITLE_CHARS ? `${[...text].slice(0, EVENT_TITLE_CHARS - 1).join("")}…` : text;
const full_title = (task) => shown_title(task);

/** What a line shows: a command without its shell set-up, anything else as the software described it. */
export function shown_title(task) {
  // A PowerShell here-string (@' … '@) opens with its quote; the script itself starts after it.
  const title = task.kind === "command" ? String(task.title || "").replace(SHELL_PREAMBLE, "").replace(/^@'\s*/, "") : String(task.title || "");
  return title || KIND_LABELS[task.kind] || "";
}

/** A span of milliseconds in a few words: "10 秒", "3 分钟", "1 小时 5 分". */
export function span_text(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return t('{value1} 秒', { value1: seconds });
  if (seconds < 3600) return t('{value1} 分钟', { value1: Math.floor(seconds / 60) });
  return t('{value1} 小时 {value2} 分', { value1: Math.floor(seconds / 3600), value2: Math.floor(seconds / 60) % 60 });
}

/** A running item's state in a few words: how long it has run, or a schedule's rule and next time. */
export function running_text(task, now) {
  if (task.kind === "schedule") {
    const next = task.next_at > now ? t('下次 {value1}', { value1: new Date(task.next_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) }) : "";
    return [task.schedule, next].filter(Boolean).join(" · ");
  }
  return task.started_at ? t('运行中 · {value1}', { value1: span_text(now - task.started_at) }) : t('运行中');
}

/**
 * The event lines a turn's background work leaves in the session, oldest first: one line for what it started (a list
 * under it when it started several), then one per item that ended, with how long it ran. `tone` is the bullet's colour:
 * `done` (green), `failed` (red), `stopped` (grey). `at` (ms) places a line before or after the turn's reply.
 */
export function background_events(tasks) {
  const list = (tasks || []).filter((task) => task && KIND_LABELS[task.kind]);
  // An event line quotes the work by a short title, as Claude Code quotes a task's description; the panel shows it whole.
  const shown_title = (task) => clip(full_title(task));
  if (!list.length) return [];
  const started = [...list].sort((a, b) => (a.started_at || 0) - (b.started_at || 0));
  const first = started.find((task) => task.started_at)?.started_at || 0;
  const events = [started.length === 1
    ? { key: "started", at: first, tone: "done", text: STARTED[started[0].kind](shown_title(started[0])), children: [] }
    : { key: "started", at: first, tone: "done", text: t('已在后台启动 {value1} 项工作', { value1: started.length }), children: started.map(shown_title) }];
  for (const task of list) {
    if (task.state === "running" || !ENDED[task.state]) continue;
    const ran = task.started_at && task.ended_at ? span_text(task.ended_at - task.started_at) : "";
    events.push({ key: `ended:${task.id}`, at: task.ended_at || Number.MAX_SAFE_INTEGER, tone: task.state, text: ENDED[task.state][task.kind](shown_title(task)), after: ran, children: [] });
  }
  return events.sort((a, b) => a.at - b.at);
}

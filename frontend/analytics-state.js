import { ref } from "vue";
import { adapter_profile } from "../runner/adapters/profiles.mjs";
import { locale, t } from "./i18n.js";

const page_open = ref(false);

/** Shared state for the full-page Analytics workspace view, matching workflows and invited rooms. */
export function use_analytics_page() {
  return {
    page_open,
    open() { page_open.value = true; },
    close() { page_open.value = false; },
  };
}

/** Browser's IANA time zone name, falling back to UTC when unavailable. */
export function browser_timezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Add whole calendar days to a YYYY-MM-DD date string without local-DST drift. */
function shift_iso_date(iso, days) {
  const [year, month, day] = String(iso || "").split("-").map(Number);
  if (!year || !month || !day) return "";
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

/** Build the `/api/analytics` query string for today, 7d, 30d or all in the browser timezone and room scope. */
export function analytics_query(preset, tz = browser_timezone(), scope = "all") {
  const params = new URLSearchParams();
  params.set("range", ["today", "7d", "30d", "all"].includes(preset) ? preset : "7d");
  params.set("tz", tz);
  if (scope === "current") params.set("scope", "current");
  return `/api/analytics?${params.toString()}`;
}

/** Format an exclusive [from, to) calendar range as inclusive display text. */
export function inclusive_date_range(from, to) {
  if (!from || !to) return "";
  const last_day = shift_iso_date(to, -1);
  if (!last_day || last_day < from) return from;
  if (last_day === from) return from;
  return t("{from} 至 {to}", { from, to: last_day });
}

/**
 * Format a duration in seconds for compact display; null becomes an em dash. The smaller unit is always shown once the
 * larger one appears ("11 小时 0 分", not "11 小时"), so a value that lands on a whole hour does not look truncated and the
 * text keeps its shape while a number counts up.
 */
export function format_duration(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(Number(seconds))) return "—";
  const total = Math.max(0, Math.round(Number(seconds)));
  if (total < 60) return t("{count} 秒", { count: total });
  if (total < 3600) {
    const minutes = Math.floor(total / 60);
    const rem = total % 60;
    return t("{minutes} 分 {seconds} 秒", { minutes, seconds: rem });
  }
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return t("{hours} 小时 {minutes} 分", { hours, minutes });
}

/** Format a Unix timestamp in seconds using the browser locale and report timezone. */
export function format_timestamp(epoch_seconds, tz) {
  if (!epoch_seconds) return "";
  try {
    return new Date(epoch_seconds * 1000).toLocaleString(locale, {
      timeZone: tz || undefined,
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    return new Date(epoch_seconds * 1000).toLocaleString(locale, { hour12: false });
  }
}

/**
 * Sample-size rule: when denominator < 10, show only counts and never a percentage.
 * Returns `{ primary, detail, has_percent, percent }`.
 */
export function format_ratio(numerator, denominator) {
  const num = Number(numerator || 0);
  const den = Number(denominator || 0);
  if (den <= 0) return { primary: "—", detail: t("暂无样本"), has_percent: false, percent: null };
  if (den < 10) {
    return {
      primary: `${num} / ${den}`,
      detail: t("样本不足 10 条，仅显示次数"),
      has_percent: false,
      percent: null,
    };
  }
  const percent = Math.round((num / den) * 100);
  return {
    primary: `${percent}%`,
    detail: `${num} / ${den}`,
    has_percent: true,
    percent,
  };
}

/** Compact inline ratio text honoring the denominator < 10 rule. */
export function inline_ratio(numerator, denominator) {
  const den = Number(denominator || 0);
  const num = Number(numerator || 0);
  if (den <= 0) return "—";
  if (den < 10) return `${num} / ${den}`;
  return `${Math.round((num / den) * 100)}% (${num}/${den})`;
}

/** Localized display label for an execution failure_class identifier. */
export function failure_class_label(kind) {
  const labels = {
    quota: t("额度用尽"),
    auth: t("登录失效"),
    output_truncated: t("输出截断"),
    compaction_failed: t("压缩失败"),
    policy_blocked: t("策略拦截"),
  };
  return labels[kind] || kind;
}

/** Adapter display name from the static adapter profile table (never branching on software names). */
export function adapter_display_label(adapter) {
  if (!adapter) return t("未知");
  const profile = adapter_profile(adapter);
  if (!profile) return adapter;
  return profile.kind === "api" ? t("模型 API") : profile.label;
}

const COUNT_FIELDS = ["accepted", "executions", "completed", "failed", "cancelled", "interrupted", "retries", "denied", "revived"];

/**
 * Report rows per software × model × effort, largest workload first (no rank numbers are shown).
 * Uses the backend's cross-room `models` when present: its quantiles come from every execution sample. Older
 * snapshots only have per-room `members`; those are summed here and the quantiles kept only when one room supplied them.
 */
export function group_model_rows(report) {
  const source = report?.models || report?.members || [];
  const map = new Map();
  for (const row of source) {
    const key = [row.adapter || "", row.model || "", row.effort || ""].join("\0");
    let item = map.get(key);
    if (!item) {
      item = { key, adapter: row.adapter || "", model: row.model || "", effort: row.effort || "", failures: {}, parts: 0, duration: row.duration || null };
      for (const field of COUNT_FIELDS) item[field] = 0;
      map.set(key, item);
    }
    item.parts += 1;
    for (const field of COUNT_FIELDS) item[field] += Number(row[field] || 0);
    for (const [kind, count] of Object.entries(row.failures || {})) item.failures[kind] = (item.failures[kind] || 0) + Number(count || 0);
  }
  return [...map.values()]
    .map((item) => ({
      ...item,
      duration: item.parts === 1 ? item.duration : null,
      failure_entries: Object.entries(item.failures).sort((a, b) => b[1] - a[1]),
    }))
    .sort((a, b) => b.executions - a.executions || b.accepted - a.accepted || a.key.localeCompare(b.key));
}

<script setup>
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  adapter_display_label,
  analytics_query,
  browser_timezone,
  failure_class_label,
  format_duration,
  format_ratio,
  format_timestamp,
  group_model_rows,
  inclusive_date_range,
} from "./analytics-state.js";
import { analytics_card_blob, draw_analytics_card } from "./analytics-card.js";
import { live_series, use_live_analytics, waited_text, waiting_title, WAITING_ICONS } from "./analytics-live.js";
import { entrance, use_spring, wave } from "./analytics-motion.js";
import { use_workflow_library } from "./workflow-library.js";
import { t } from "./i18n.js";

const emit = defineEmits(["open-room", "open-message"]);
const { view, bridge } = inject("discussion");

const PRESETS = [
  { value: "live", label: t("实时") },
  { value: "today", label: t("今日") },
  { value: "7d", label: t("近 7 天") },
  { value: "30d", label: t("近 30 天") },
  { value: "all", label: t("全部时间") },
];
const ISSUE_PREVIEW = 3;
const AXIS_LABELS = 8;
const FOLDER_SLOTS = 6;
const MEMBER_PREVIEW = 8;

const preset = ref("7d");
const scope = ref("all");
const can_analyze_dispatch = ref(false);
let steward_read = 0;
// Read capability separately so visiting the analytics page never waits for the paired computer.
async function refresh_steward_skills() {
  const reading = ++steward_read;
  try {
    const status = await bridge.local_request("steward", {});
    if (reading === steward_read) can_analyze_dispatch.value = status.skills?.some(skill => skill.id === "dispatch-analysis" && skill.available && skill.allowed !== false) ?? false;
  } catch { if (reading === steward_read) can_analyze_dispatch.value = false; }
}
watch(() => view.value.launch.available, refresh_steward_skills, { immediate: true });
onMounted(() => document.addEventListener("discuss:steward-skills-changed", refresh_steward_skills));
onBeforeUnmount(() => {
  steward_read++;
  document.removeEventListener("discuss:steward-skills-changed", refresh_steward_skills);
});
const report = ref(null);
const loading = ref(false);
const error = ref("");
const members_expanded = ref(false);
const issues_expanded = ref(false);
const open_issues = ref(new Set());
const model_sort = ref("executions");
const hovered_slot = ref(-1);
const share_open = ref(false);
const share_canvas = ref(null);
const copied_image = ref(false);
let request_serial = 0;
let regrow = true;

const can_copy_image = typeof ClipboardItem !== "undefined" && Boolean(navigator.clipboard?.write);
const tz = browser_timezone();

// Motion (see analytics-motion.js): `enter` falls 1→0 once when the page opens and staggers the blocks by distance;
// `grow` rises 0→1 whenever the period or scope changes and drives every bar; the numbers are springs to their value.
const enter = use_spring(1);
const grow = use_spring(0);
const task_count = use_spring(0);
const unassisted_percent = use_spring(0);
const peak_members = use_spring(0);
const execution_total = use_spring(0);
const block_style = (index) => entrance(enter.value.value, index);

const report_heading = computed(() => PRESETS.find((item) => item.value === preset.value)?.label || "");
const date_range_label = computed(() => inclusive_date_range(report.value?.range?.from, report.value?.range?.to));
const prev_range_label = computed(() => {
  const range = report.value?.range;
  return range && range.previous_from < range.previous_to ? inclusive_date_range(range.previous_from, range.previous_to) : "";
});

// The live view has its own data and polling (analytics-live.js); the periods keep the last report underneath.
const { live, loading: live_loading, error: live_error, load: load_live, set_active: set_live_active } = use_live_analytics(bridge);
const is_live = computed(() => preset.value === "live");
watch(is_live, (value) => set_live_active(value), { immediate: true });
const live_rooms = computed(() => {
  const rooms = new Map();
  for (const run of live.value?.running || []) {
    if (!rooms.has(run.room_id)) rooms.set(run.room_id, { room_id: run.room_id, runs: [] });
    rooms.get(run.room_id).runs.push(run);
  }
  return [...rooms.values()];
});
const live_caption = computed(() => {
  const members = live.value?.running.length || 0;
  const waiting = live.value?.waiting.length || 0;
  const rooms = live_rooms.value.length;
  if (members && waiting) return t("现在 {members} 位专家在 {rooms} 个房间里工作，有 {count} 件事等你处理。", { members, rooms, count: waiting });
  if (members) return t("现在 {members} 位专家在 {rooms} 个房间里工作，没有等你处理的事。", { members, rooms });
  if (waiting) return t("现在没有专家在工作，有 {count} 件事等你处理。", { count: waiting });
  return t("现在没有专家在工作，也没有等你处理的事。");
});
const live_figures = computed(() => {
  const data = live.value;
  if (!data) return [];
  const queued = data.queue.requests + data.queue.messages;
  return [
    { key: "running", label: t("正在运行"), value: data.running.length, note: t("{count} 个房间", { count: live_rooms.value.length }) },
    { key: "queue", label: t("排队中"), value: queued, note: queued ? t("{requests} 个待接手 · {messages} 条待发送", { requests: data.queue.requests, messages: data.queue.messages }) : "" },
    { key: "waiting", label: t("等你处理"), value: data.waiting.length, note: "" },
    { key: "errors", label: t("最近 1 小时出错"), value: data.errors, note: "" },
  ];
});
const live_updated = computed(() => (live.value ? new Date(live.value.at * 1000).toLocaleTimeString() : ""));
function refresh(manual) {
  if (is_live.value) load_live(manual);
  else load(manual);
}

/** Load the analytics snapshot for the active period and room scope; stale responses are dropped. */
async function load(manual = false) {
  if (preset.value === "live") return;
  const serial = ++request_serial;
  loading.value = true;
  error.value = "";
  try {
    const data = await bridge.request(analytics_query(preset.value, tz, scope.value));
    if (serial !== request_serial) return;
    report.value = data;
  } catch (problem) {
    if (serial !== request_serial) return;
    const message = problem?.message || t("读取统计失败");
    error.value = message;
    if (manual || report.value) bridge.notify("error", message);
  } finally {
    if (serial === request_serial) loading.value = false;
  }
}

onMounted(() => load(false));
watch([preset, scope], () => { members_expanded.value = false; issues_expanded.value = false; open_issues.value = new Set(); regrow = true; load(false); });

const overview = computed(() => report.value?.overview || null);
const unassisted = computed(() => format_ratio(overview.value?.unassisted, overview.value?.ended));
const peak = computed(() => report.value?.time?.peak || { rooms: 0, at: null, members: 0, members_at: null });


const approx = (dist) => (dist?.approximate ? "≈ " : "");
const execution_seconds = computed(() => report.value?.time?.execution_seconds || 0);
const issue_list = computed(() => report.value?.issues || []);
const visible_issues = computed(() => (issues_expanded.value ? issue_list.value : issue_list.value.slice(0, ISSUE_PREVIEW)));

watch(report, (data, before) => {
  if (!data) return;
  if (!before) enter.to(0);
  if (regrow) { grow.jump(0); grow.to(1); regrow = false; }
  task_count.to(Number(data.overview?.initiated || 0));
  unassisted_percent.to(unassisted.value.percent ?? 0);
  peak_members.to(Number(peak.value.members || 0));
  execution_total.to(execution_seconds.value);
});

/**
 * One line under the title, built by a fixed template (no model). The page leads with figures and a chart; the
 * sentence is a caption, and the share card carries the story to others (Fable #14109).
 */
const conclusion = computed(() => {
  const params = { tasks: overview.value?.initiated || 0, hours: format_duration(execution_seconds.value), experts: peak.value.members || 0 };
  return {
    today: t("今天，AI 替你推进了 {tasks} 个任务，累计工作 {hours}，最多 {experts} 位专家同时在跑。", params),
    "7d": t("这 7 天，AI 替你推进了 {tasks} 个任务，累计工作 {hours}，最多 {experts} 位专家同时在跑。", params),
    "30d": t("这 30 天，AI 替你推进了 {tasks} 个任务，累计工作 {hours}，最多 {experts} 位专家同时在跑。", params),
    all: t("至今，AI 替你推进了 {tasks} 个任务，累计工作 {hours}，最多 {experts} 位专家同时在跑。", params),
  }[preset.value];
});
const previous = computed(() => report.value?.previous || null);
const comparable = computed(() => Boolean(prev_range_label.value) && preset.value !== "today");

/**
 * The change against the previous period as `{ diff, text }`; null without a previous period or for today (still
 * running). `phrase(diff)` returns the whole translated sentence for this figure's unit.
 */
function change(now, before, phrase = (diff) => t("较上期 {diff}", { diff })) {
  if (!comparable.value || before === null || before === undefined) return null;
  const diff = Math.round(Number(now || 0) - Number(before || 0));
  return { diff, text: diff ? phrase(`${diff > 0 ? "+" : "−"}${Math.abs(diff)}`) : t("与上期持平") };
}

/** The four figures that open the page, each with its change against the previous period. */
const figures = computed(() => {
  const before = previous.value || {};
  const before_rate = format_ratio(before.unassisted, before.ended);
  const hours = execution_seconds.value / 3600;
  return [
    { key: "hours", label: t("AI 累计工作"), value: format_duration(execution_total.value.value),
      change: change(hours, before.execution_seconds === undefined ? null : before.execution_seconds / 3600, (diff) => t("较上期 {diff} 小时", { diff })) },
    { key: "tasks", label: t("推进的任务"), value: Math.round(task_count.value.value), change: change(overview.value?.initiated, before.initiated) },
    { key: "experts", label: t("最多同时在跑"), value: t("{count} 位", { count: Math.round(peak_members.value.value) }),
      note: t("{count} 个房间", { count: peak.value.rooms || 0 }), change: change(peak.value.members, before.peak_members) },
    { key: "rate", label: t("不用再管"), value: unassisted.value.has_percent ? `${Math.round(unassisted_percent.value.value)}%` : unassisted.value.primary,
      note: t("你插手了 {count} 次", { count: stepped_in.value }),
      change: unassisted.value.has_percent && before_rate.has_percent && comparable.value
        ? change(unassisted.value.percent, before_rate.percent, (diff) => t("较上期 {diff} 个百分点", { diff })) : null },
  ];
});

/**
 * The timeline: experts running at once per time step, with the runs that did not finish as red marks on the same
 * axis, so a burst of failures reads as one incident at a glance (Fable #14109). Coordinates are in a 1000-wide box.
 */
const CHART_W = 1000;
const CHART_H = 150;
const MARK_H = 22;
const timeline = computed(() => {
  const live_info = is_live.value ? live_series(live.value) : null;
  const series = is_live.value ? live_info : report.value?.time?.concurrency;
  const points = series?.points || [];
  const unfinished = series?.unfinished || [];
  if (points.length < 2) return null;
  const peak_value = Math.max(1, ...points);
  const worst = Math.max(1, ...unfinished);
  const slot = CHART_W / points.length;
  const shared = { peak_value, slot, step: series.step, points, unfinished,
    area: (scale) => {
      const y = (value) => CHART_H - (value / peak_value) * (CHART_H - 8) * scale;
      const line = points.map((value, index) => `${(index + 0.5) * slot},${y(value).toFixed(1)}`).join(" L");
      return { fill: `M0,${CHART_H} L${line} L${CHART_W},${CHART_H} Z`, stroke: `M${line}` };
    },
    marks: unfinished.map((count, index) => (count ? { x: index * slot, h: Math.max(3, (count / worst) * MARK_H), count, index } : null)).filter(Boolean) };
  if (live_info) {
    return { ...shared, when: live_info.clock,
      labels: points.map((_, index) => index).filter((index) => index % live_info.label_every === 0)
        .map((index) => ({ x: (index / points.length) * 100, text: live_info.clock(index) })) };
  }
  const [year, month, day] = String(report.value.range.from).split("-").map(Number);
  const origin = Date.UTC(year, month - 1, day);
  const stamp = (index) => new Date(origin + index * series.step * 1000);
  const label_every = Math.max(1, Math.ceil((points.length * series.step) / 86400 / AXIS_LABELS)) * Math.max(1, Math.round(86400 / series.step));
  return {
    peak_value, slot, step: series.step, points, unfinished,
    area: (scale) => {
      const y = (value) => CHART_H - (value / peak_value) * (CHART_H - 8) * scale;
      const line = points.map((value, index) => `${(index + 0.5) * slot},${y(value).toFixed(1)}`).join(" L");
      return { fill: `M0,${CHART_H} L${line} L${CHART_W},${CHART_H} Z`, stroke: `M${line}` };
    },
    marks: unfinished.map((count, index) => (count ? { x: index * slot, h: Math.max(3, (count / worst) * MARK_H), count, index } : null)).filter(Boolean),
    labels: points.map((_, index) => index).filter((index) => index % label_every === 0)
      .map((index) => ({ x: (index / points.length) * 100, text: stamp(index).toLocaleDateString(undefined, { month: "numeric", day: "numeric", timeZone: "UTC" }) })),
    when: (index) => {
      const date = stamp(index);
      const text = date.toLocaleDateString(undefined, { month: "numeric", day: "numeric", timeZone: "UTC" });
      return series.step < 86400 ? `${text} ${String(date.getUTCHours()).padStart(2, "0")}:00` : text;
    },
  };
});
/** Which time step the pointer is over, from its position across the chart. */
function hover_timeline(event) {
  const box = event.currentTarget.getBoundingClientRect();
  const count = timeline.value?.points.length || 0;
  hovered_slot.value = count ? Math.min(count - 1, Math.max(0, Math.floor(((event.clientX - box.left) / box.width) * count))) : -1;
}
const stepped_in = computed(() => Math.max(0, Number(overview.value?.ended || 0) - Number(overview.value?.unassisted || 0)));

/** Who an issue is about: software, model and effort, or the software alone. */
function issue_who(params) {
  const software = adapter_display_label(params.adapter);
  if (!("model" in params)) return software;
  return [software, params.model || t("未知模型"), params.effort].filter(Boolean).join(" · ");
}

/** What went wrong in a run-did-not-finish issue: the failure class when the adapter classified it, else its note. */
function issue_reason(params) {
  if (params.failure_class) return failure_class_label(params.failure_class);
  return params.reason || t("没有留下说明");
}

/** One sentence per issue rule, stating what happened and how often; never a recommendation to switch models. */
function issue_title(item) {
  const who = issue_who(item.params);
  const count = item.count;
  switch (item.rule) {
    case "not_finished": return t("「{reason}」：{count} 次运行出错", { reason: issue_reason(item.params), count });
    case "interrupted": return t("你打断了 {who} {count} 次", { who, count });
    case "permission": return t("{who} 有 {count} 次运行被权限拦下", { who, count });
    case "late_recovery": return t("{who} 有 {count} 次先被判失败、后来又交回了回答", { who, count });
    case "unknown_model": return t("{software} 有 {count} 次运行没有记录模型", { software: who, count });
    case "scheduler": return t("「{room}」的智能调度收到 {count} 个差评", { room: item.params.title || item.params.room_id, count });
    default: return t("{rule}：{count} 次", { rule: item.rule, count });
  }
}

/** The facts under a title: who it touched, when it happened, its share of the related runs and last period's count. */
function issue_meta(item) {
  const parts = [];
  if (item.rule === "not_finished" && item.members?.length) {
    const named = item.members.slice(0, 2).map((member) => `${issue_who(member)} ${member.count}`).join("、");
    parts.push(item.members.length > 2
      ? t("涉及 {members} 等 {count} 组", { members: named, count: item.members.length })
      : t("涉及 {members}", { members: named }));
  }
  if (item.first_at && report.value) {
    const from = format_timestamp(item.first_at, report.value.range?.tz);
    const to = format_timestamp(item.last_at, report.value.range?.tz);
    parts.push(from === to ? from : t("{from} 至 {to}", { from, to }));
  }
  if (item.total) parts.push(t("占相关 {total} 次运行的 {share}", { total: item.total, share: share_text((item.count / item.total) * 100) }));
  if (comparable.value && item.previous) parts.push(t("上期 {count} 次", { count: item.previous }));
  return parts.join(" · ");
}

const ISSUE_ICONS = {
  not_finished: "i-lucide-circle-x", interrupted: "i-lucide-hand", permission: "i-lucide-shield-alert",
  late_recovery: "i-lucide-clock-alert", unknown_model: "i-lucide-circle-help", scheduler: "i-lucide-thumbs-down",
};
const issue_level = (item) => ({ high: "is-critical", normal: "is-normal", info: "is-info" })[item.level] || "is-normal";
const toggle_issue = (key) => toggle_set(open_issues, key);
const issue_key = (item) => `${item.rule}:${JSON.stringify(item.params)}`;
const RUN_STATUS = { completed: t("完成"), failed: t("失败"), cancelled: t("取消"), started: t("进行中"), dispatched: t("进行中") };

/** Open the room of one run at the message that asked for it (or just the room when that message is unknown). */
function open_run(run) {
  if (run.message_id) emit("open-message", { room_id: run.room_id, message_id: run.message_id });
  else open_room(run.room_id);
}

/** Resolve a room's title from the loaded directory; falls back to its id. */
function room_label(room_id) {
  if (!room_id) return "";
  const found = (view.value.rooms || []).find((item) => item.id === room_id);
  return found?.title || bridge.room_title?.(room_id) || room_id;
}

/** Folder share of execution time: the largest six keep their own colour slot, the rest fold into “其他”. */
const folders = computed(() => {
  const rows = (report.value?.time?.folders || [])
    .filter((row) => (row.initiated || 0) > 0 || (row.execution_seconds || 0) > 0)
    .map((row) => ({ ...row, display_name: row.folder_id === null ? t("未分组") : (row.name || t("未分组")) }))
    .sort((a, b) => (b.execution_seconds - a.execution_seconds) || (b.initiated - a.initiated));
  const head = rows.slice(0, FOLDER_SLOTS).map((row, index) => ({ ...row, slot: index + 1 }));
  const rest = rows.slice(FOLDER_SLOTS);
  if (rest.length) {
    head.push({
      folder_id: "__other__",
      display_name: t("其他 {count} 个文件夹", { count: rest.length }),
      initiated: rest.reduce((sum, row) => sum + (row.initiated || 0), 0),
      execution_seconds: rest.reduce((sum, row) => sum + (row.execution_seconds || 0), 0),
      slot: 0,
    });
  }
  // Each folder carries its rooms, largest first; a room's share is of its folder's time (rooms of folded folders join “其他”).
  const rooms = report.value?.time?.rooms || [];
  const kept = new Set(head.filter((row) => row.slot).map((row) => row.folder_id));
  for (const row of head) {
    row.key = row.folder_id ?? "__unfiled__";
    const members = rooms.filter((room) => (row.slot ? room.folder_id === row.folder_id : !kept.has(room.folder_id)));
    const folder_seconds = members.reduce((sum, room) => sum + (room.execution_seconds || 0), 0);
    row.rooms = members
      .map((room) => ({ ...room, share: folder_seconds ? (room.execution_seconds / folder_seconds) * 100 : 0 }))
      .sort((a, b) => (b.execution_seconds - a.execution_seconds) || (b.initiated - a.initiated));
  }
  const total = head.reduce((sum, row) => sum + (row.execution_seconds || 0), 0);
  const shares = head.map((row) => (total ? (row.execution_seconds / total) * 100 : 0));
  // Bar weights sum to exactly 1, so while the grow spring rises the filled length is the spring's own fraction.
  const visible = shares.map((share) => Math.max(share, 0.6));
  const weight_total = visible.reduce((sum, value) => sum + value, 0) || 1;
  return head.map((row, index) => ({ ...row, share: shares[index], weight: visible[index] / weight_total }));
});

const ROOM_PREVIEW = 8;
const open_folders = ref(new Set());
const all_rooms = ref(new Set());
/** Add or remove a folder key in a reactive set; the choice survives period switches since folders keep their keys. */
function toggle_set(store, key) {
  const next = new Set(store.value);
  if (next.has(key)) next.delete(key); else next.add(key);
  store.value = next;
}
const toggle_folder = (key) => toggle_set(open_folders, key);
const toggle_all_rooms = (key) => toggle_set(all_rooms, key);

/** Folder share as a whole percent; a non-zero share under 1% reads “<1%” rather than “0%”. */
function share_text(share) {
  return share > 0 && share < 1 ? "<1%" : `${Math.round(share)}%`;
}

/** Report rows by software × model × effort, largest workload first; no rank numbers are shown. */
const model_rows = computed(() => {
  const rows = group_model_rows(report.value);
  const total = rows.reduce((sum, row) => sum + row.executions, 0);
  return rows.map((row) => ({ ...row, run_share: total ? (row.executions / total) * 100 : 0 }));
});

const MODEL_SORTS = {
  executions: (row) => row.executions,
  failed: (row) => row.failed,
  interrupted: (row) => row.interrupted + row.retries,
  duration: (row) => row.duration?.p50 ?? -1,
};
/** Rows ordered by the chosen column, largest first; runs break ties so the order stays stable. */
const sorted_models = computed(() => [...model_rows.value].sort((a, b) => (MODEL_SORTS[model_sort.value](b) - MODEL_SORTS[model_sort.value](a)) || (b.executions - a.executions)));

/**
 * How the runs of one row ended: completed, failed, stopped by you, cancelled otherwise and still running. The
 * completion rate alone hid why a row was low (a 75% row showed no failure type at all).
 */
function outcomes(row) {
  const stopped = Math.min(row.interrupted || 0, row.cancelled || 0);
  const parts = [
    { key: "done", count: row.completed || 0, label: t("完成") },
    { key: "failed", count: row.failed || 0, label: t("失败") },
    { key: "stopped", count: stopped, label: t("你停止") },
    { key: "cancelled", count: (row.cancelled || 0) - stopped, label: t("其他取消") },
  ];
  const running = Math.max(0, (row.executions || 0) - parts.reduce((sum, part) => sum + part.count, 0));
  parts.push({ key: "running", count: running, label: t("进行中") });
  const total = Math.max(1, row.executions || 0);
  return parts.filter((part) => part.count).map((part) => ({ ...part, share: (part.count / total) * 100 }));
}
const outcome_title = (row) => outcomes(row).map((part) => `${part.label} ${part.count}`).join(" · ");

// Host dispatch quality (#14596): computed only when its section is opened, since chain records are costly.
const DISPATCH_SAMPLE = 20;
const dispatch_open = ref(false);
const dispatch_report = ref(null);
const dispatch_loading = ref(false);
const dispatch_error = ref("");
let dispatch_serial = 0;
/** Load the host dispatch section for the current period and scope; stale responses are dropped. */
async function load_dispatch() {
  const serial = ++dispatch_serial;
  dispatch_loading.value = true;
  dispatch_error.value = "";
  try {
    const data = await bridge.request(`${analytics_query(preset.value, tz, scope.value)}&dispatch=1`);
    if (serial === dispatch_serial) dispatch_report.value = data.dispatch_quality || null;
  } catch (problem) {
    if (serial === dispatch_serial) dispatch_error.value = problem?.message || t("读取统计失败");
  } finally {
    if (serial === dispatch_serial) dispatch_loading.value = false;
  }
}
function toggle_dispatch(event) {
  dispatch_open.value = event.target.open;
  if (!dispatch_open.value) return;
  refresh_steward_skills();
  if (!dispatch_report.value && !dispatch_loading.value) load_dispatch();
}
watch([preset, scope], () => { dispatch_report.value = null; if (dispatch_open.value) load_dispatch(); });

/** A rate from the dispatch section: under 20 chains only the counts are shown, never a percentage. */
function dispatch_rate(count, total, chains) {
  if (!total) return "—";
  if (chains < DISPATCH_SAMPLE) return `${count} / ${total}`;
  return `${share_text((count / total) * 100)} (${count}/${total})`;
}
/** Which host a group is: model and version, or why the version is not known. */
function dispatch_who(group) {
  const model = group.model === "mixed" ? t("多个模型") : (group.model || t("未知模型"));
  if (group.kind === "unknown") return { model, version: t("版本未记录（升级前的运行）") };
  if (group.kind === "mixed") return { model, version: t("链内换过版本") };
  return { model, version: t("程序 v{version} · 主持人提示词 {hash} · 主持技能 {skill}", { version: group.package_version || "?", hash: group.prompt_hash || t("无"), skill: group.skill_hash || t("无") }) };
}
const open_dispatch_rows = ref(new Set());
const dispatch_row_key = (group) => [group.kind, group.model, group.package_version, group.prompt_hash, group.skill_hash].join("|");
const toggle_dispatch_row = (key) => toggle_set(open_dispatch_rows, key);

// Workflows: the backend reports IDs// Workflows: the backend reports IDs; names come from this computer's workflow library when it has the workflow.
const workflow_library = use_workflow_library();
const all_runs = computed(() => model_rows.value.reduce((sum, row) => sum + row.executions, 0));
const workflow_rows = computed(() => (report.value?.workflows || []).map((row) => ({
  ...row,
  label: workflow_library.workflows.value.find((item) => item.id === row.id)?.label || row.id,
  card_entries: Object.entries(row.cards || {}).sort((a, b) => b[1] - a[1]),
  sub_entries: Object.entries(row.sub_workflows || {}).sort((a, b) => b[1] - a[1]),
})));
const workflow_share = computed(() => {
  const inside = workflow_rows.value.reduce((sum, row) => sum + row.executions, 0);
  return { inside, runs: all_runs.value, share: all_runs.value ? (inside / all_runs.value) * 100 : 0 };
});
const visible_models = computed(() => (members_expanded.value ? sorted_models.value : sorted_models.value.slice(0, MEMBER_PREVIEW)));

/** Width of the completion bar, or null when the sample is too small to show a percentage. */
function completion(row) {
  const ratio = format_ratio(row.completed, row.executions);
  return { ...ratio, width: ratio.has_percent ? ratio.percent : null };
}

/** “Usually X, slower ones Y”: the median and the 90th percentile in words a user reads at a glance. */
function typical(dist) {
  if (!dist?.samples) return "—";
  return t("通常 {usual} · 较慢 {slow}", { usual: `${approx(dist)}${format_duration(dist.p50)}`, slow: `${approx(dist)}${format_duration(dist.p90)}` });
}

const waiting_segments = computed(() => {
  const time = report.value?.time;
  if (!time) return [];
  const rows = [
    { key: "delivery", label: t("交付耗时"), note: t("从发出到收齐回答"), dist: overview.value?.delivery, subset: false },
    { key: "waiting", label: t("等待接手"), note: t("从发出到成员开始处理"), dist: time.waiting, subset: false },
    { key: "execution", label: t("成员处理"), note: t("每次运行从开始到结束"), dist: time.execution, subset: false },
    { key: "rework", label: t("其中：返工"), note: t("失败后重新安排的运行"), dist: time.rework, subset: true },
  ];
  const max = Math.max(1, ...rows.map((row) => Number(row.dist?.p90 || 0)));
  return rows.map((row) => ({
    ...row,
    p50_left: row.dist?.p50 ? Math.min(100, (row.dist.p50 / max) * 100) : 0,
    p90_left: row.dist?.p90 ? Math.min(100, (row.dist.p90 / max) * 100) : 0,
  }));
});
const delivery_note = computed(() => {
  const coverage = overview.value?.coverage;
  return coverage?.denominator ? t("{count} 个已结束任务里，{measured} 个能算出交付耗时", { count: coverage.denominator, measured: coverage.numerator }) : "";
});

const corrections = computed(() => report.value?.time?.corrections || { stops: 0, withdrawals: 0, rewinds: 0, affected_requests: 0 });
const additions = computed(() => report.value?.time?.additions || { interjections: 0 });
const queue_info = computed(() => report.value?.time?.queue || { count: 0, oldest_seconds: null });
const top_folder = computed(() => folders.value[0] || null);
const top_model = computed(() => model_rows.value[0] || null);
const correction_total = computed(() => (corrections.value.stops || 0) + (corrections.value.withdrawals || 0) + (corrections.value.rewinds || 0));

const scope_text = computed(() => {
  const info = report.value?.scope || {};
  if (info.mode === "all" && info.sealed_rooms) {
    return t("现存 {count} 个房间（含归档）与 {sealed} 个已删除房间的匿名统计", { count: info.rooms ?? 0, sealed: info.sealed_rooms });
  }
  if (info.mode === "all") return t("现存 {count} 个房间（含归档），暂无已删除房间的统计", { count: info.rooms ?? 0 });
  return t("现存 {count} 个房间，含归档，不含已删除", { count: info.rooms ?? 0 });
});

function open_room(room_id) {
  if (room_id) emit("open-room", room_id);
}

/** Draw the share card locally once the dialog's canvas exists. */
async function draw_share() {
  await nextTick();
  if (share_open.value && share_canvas.value && report.value) draw_analytics_card(share_canvas.value, report.value, report_heading.value, scope_text.value);
}
watch([share_open, report], draw_share);

async function download_share_card() {
  if (!share_canvas.value || !report.value) return;
  try {
    const blob = await analytics_card_blob(share_canvas.value);
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `codiscuss-analytics-${report.value.range?.from || "report"}.png`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 60000);
  } catch (problem) {
    bridge.notify("error", problem?.message || t("生成分享图失败"));
  }
}

async function copy_share_card() {
  if (!share_canvas.value) return;
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": analytics_card_blob(share_canvas.value) })]);
    copied_image.value = true;
    setTimeout(() => { copied_image.value = false; }, 2000);
  } catch {
    bridge.notify("warning", t("这个浏览器不能复制图片，请用“保存图片”。"));
  }
}
</script>

<template>
  <div v-keep-reading class="content-page analytics-page" role="region" :aria-label="t('统计')">
    <div class="analytics-wrap">
      <header class="analytics-head">
        <div class="analytics-title">
          <h1>{{ report_heading }}</h1>
          <p>
            <span v-if="is_live">{{ t("此刻 AI 在做什么、有什么在等你") }}</span>
            <span v-if="date_range_label && !is_live">{{ date_range_label }}</span>
            <span v-if="prev_range_label && !is_live" class="analytics-dim">{{ t("对比上期：{range}", { range: prev_range_label }) }}</span>
          </p>
        </div>
        <div class="analytics-controls">
          <div class="analytics-segmented" role="group" :aria-label="t('统计周期')">
            <button v-for="item in PRESETS" :key="item.value" type="button" :aria-pressed="preset === item.value" @click="preset = item.value">{{ item.label }}</button>
          </div>
          <UTooltip :text="t('刷新统计')">
            <UButton icon="i-lucide-refresh-cw" size="sm" color="neutral" variant="ghost" :aria-label="t('刷新统计')" :loading="is_live ? live_loading && Boolean(live) : loading && Boolean(report)" @click="refresh(true)" />
          </UTooltip>
          <button v-if="!is_live" type="button" class="analytics-share-button" :title="t('生成分享图')" :aria-label="t('生成分享图')" :disabled="!report" @click="share_open = true">
            <UIcon name="i-lucide-image" /><span>{{ t("生成分享图") }}</span>
          </button>
        </div>
      </header>

      <template v-if="is_live">
        <div v-if="!live && !live_error" class="analytics-skeleton" role="status" :aria-label="t('正在加载统计…')">
          <USkeleton class="h-64 w-full rounded-xl" />
        </div>
        <section v-else-if="!live" class="analytics-error" role="alert">
          <UIcon name="i-lucide-circle-alert" />
          <p>{{ live_error }}</p>
          <UButton :label="t('重试')" size="xs" color="neutral" variant="soft" @click="load_live(true)" />
        </section>
        <template v-else>
          <section class="analytics-overview">
            <p class="analytics-caption">{{ live_caption }}</p>
            <div class="analytics-figures">
              <article v-for="figure in live_figures" :key="figure.key" class="analytics-figure" :class="{ 'is-alert': figure.key === 'waiting' && figure.value }">
                <span class="analytics-figure-label">{{ figure.label }}</span>
                <strong class="analytics-figure-value">{{ figure.value }}</strong>
                <span class="analytics-figure-foot"><span v-if="figure.note" class="analytics-dim">{{ figure.note }}</span></span>
              </article>
            </div>
            <div v-if="timeline" class="analytics-timeline">
              <div class="analytics-timeline-head">
                <span class="analytics-legend-inline">
                  <span><i class="analytics-key is-run" />{{ t("同时在跑的专家") }}</span>
                  <span><i class="analytics-key is-fail" />{{ t("出错的运行") }}</span>
                </span>
                <span v-if="hovered_slot >= 0" class="analytics-timeline-readout">
                  {{ t("{when}：{experts} 位专家在跑，{count} 次出错", { when: timeline.when(hovered_slot), experts: timeline.points[hovered_slot], count: timeline.unfinished[hovered_slot] || 0 }) }}
                </span>
                <span v-else class="analytics-dim">{{ t("最近 60 分钟，每分钟一格") }}</span>
              </div>
              <div class="analytics-timeline-plot" @mousemove="hover_timeline" @mouseleave="hovered_slot = -1">
                <svg :viewBox="`0 0 ${CHART_W} ${CHART_H + MARK_H + 6}`" preserveAspectRatio="none" role="img" :aria-label="t('同时在跑的专家')">
                  <path class="analytics-area" :d="timeline.area(1).fill" />
                  <path class="analytics-line" :d="timeline.area(1).stroke" vector-effect="non-scaling-stroke" />
                  <line :x1="0" :x2="CHART_W" :y1="CHART_H" :y2="CHART_H" class="analytics-axis" vector-effect="non-scaling-stroke" />
                  <rect v-for="mark in timeline.marks" :key="mark.index" class="analytics-fail-mark" :x="mark.x" :y="CHART_H + 4" :width="Math.max(2, timeline.slot - 1)" :height="mark.h" />
                  <line v-if="hovered_slot >= 0" class="analytics-guide" vector-effect="non-scaling-stroke"
                    :x1="(hovered_slot + 0.5) * timeline.slot" :x2="(hovered_slot + 0.5) * timeline.slot" y1="0" :y2="CHART_H + MARK_H + 6" />
                </svg>
                <span v-for="label in timeline.labels" :key="label.x" class="analytics-axis-label" :style="{ left: `${label.x}%` }">{{ label.text }}</span>
              </div>
            </div>
          </section>

          <section v-if="live.waiting.length" class="analytics-block">
            <div class="analytics-block-head"><h2>{{ t("等你处理") }}<span class="analytics-count">{{ live.waiting.length }}</span></h2></div>
            <div class="analytics-panel analytics-live-list">
              <button v-for="(item, index) in live.waiting" :key="`${item.kind}:${item.room_id}:${item.message_id}:${index}`" type="button" class="analytics-live-row" @click="open_run(item)">
                <UIcon :name="WAITING_ICONS[item.kind] || 'i-lucide-circle-alert'" class="analytics-live-icon is-waiting" />
                <span class="analytics-live-main"><strong>{{ waiting_title(item) }}</strong><span class="analytics-dim">{{ room_label(item.room_id) }}</span></span>
                <span class="analytics-dim analytics-live-side">{{ waited_text(item.since, live.at) }}</span>
              </button>
            </div>
          </section>

          <section v-if="live_rooms.length" class="analytics-block">
            <div class="analytics-block-head"><h2>{{ t("正在进行") }}<span class="analytics-count">{{ live.running.length }}</span></h2></div>
            <div class="analytics-panel analytics-live-list">
              <template v-for="room in live_rooms" :key="room.room_id">
                <button type="button" class="analytics-live-room" @click="open_room(room.room_id)">{{ room_label(room.room_id) }}</button>
                <button v-for="run in room.runs" :key="run.execution_id" type="button" class="analytics-live-row" @click="open_run(run)">
                  <UIcon :name="run.paused ? 'i-lucide-pause' : 'i-lucide-loader-circle'" class="analytics-live-icon" />
                  <span class="analytics-live-main"><strong>{{ run.label }}</strong><span class="analytics-dim">{{ [run.model, run.effort].filter(Boolean).join(" · ") }}</span></span>
                  <span class="analytics-dim analytics-live-side">{{ run.paused ? t("已暂停") : t("已运行 {duration}", { duration: format_duration(run.seconds) }) }}</span>
                </button>
              </template>
            </div>
          </section>

          <p v-if="!live.running.length && !live.waiting.length" class="analytics-calm"><UIcon name="i-lucide-circle-check" />{{ t("现在很安静：没有在跑的专家，也没有等你处理的事。") }}</p>
          <footer class="analytics-foot"><span>{{ t("每 10 秒自动刷新 · 更新于 {time}", { time: live_updated }) }}</span></footer>
        </template>
      </template>

      <div v-else-if="loading && !report" class="analytics-skeleton" role="status" :aria-label="t('正在加载统计…')">
        <USkeleton class="h-64 w-full rounded-xl" />
        <USkeleton class="h-40 w-full rounded-xl" />
        <USkeleton class="h-72 w-full rounded-xl" />
      </div>

      <section v-else-if="error && !report" class="analytics-error" role="alert">
        <UIcon name="i-lucide-circle-alert" />
        <p>{{ error }}</p>
        <UButton :label="t('重试')" size="xs" color="neutral" variant="soft" @click="load(true)" />
      </section>

      <template v-else-if="report">
        <!-- The opening: four figures and the timeline, analysis first; the sentence is a caption (Fable #14109). -->
        <section class="analytics-overview" :style="block_style(0)">
          <p class="analytics-caption">{{ conclusion }}</p>
          <div class="analytics-figures">
            <article v-for="figure in figures" :key="figure.key" class="analytics-figure">
              <span class="analytics-figure-label">{{ figure.label }}</span>
              <strong class="analytics-figure-value">{{ figure.value }}</strong>
              <span class="analytics-figure-foot">
                <span v-if="figure.change" class="analytics-change" :class="figure.change.diff > 0 ? 'is-up' : figure.change.diff < 0 ? 'is-down' : ''">{{ figure.change.text }}</span>
                <span v-if="figure.note" class="analytics-dim">{{ figure.note }}</span>
              </span>
            </article>
          </div>
          <div v-if="timeline" class="analytics-timeline">
            <div class="analytics-timeline-head">
              <span class="analytics-legend-inline">
                <span><i class="analytics-key is-run" />{{ t("同时在跑的专家") }}</span>
                <span><i class="analytics-key is-fail" />{{ t("出错的运行") }}</span>
              </span>
              <span v-if="hovered_slot >= 0" class="analytics-timeline-readout">
                {{ t("{when}：{experts} 位专家在跑，{count} 次出错", { when: timeline.when(hovered_slot), experts: timeline.points[hovered_slot], count: timeline.unfinished[hovered_slot] || 0 }) }}
              </span>
              <span v-else class="analytics-dim">{{ t("峰值 {count} 位", { count: timeline.peak_value }) }}</span>
            </div>
            <div class="analytics-timeline-plot" @mousemove="hover_timeline" @mouseleave="hovered_slot = -1">
              <svg :viewBox="`0 0 ${CHART_W} ${CHART_H + MARK_H + 6}`" preserveAspectRatio="none" role="img" :aria-label="t('同时在跑的专家')">
                <path class="analytics-area" :d="timeline.area(grow.value.value).fill" />
                <path class="analytics-line" :d="timeline.area(grow.value.value).stroke" vector-effect="non-scaling-stroke" />
                <line :x1="0" :x2="CHART_W" :y1="CHART_H" :y2="CHART_H" class="analytics-axis" vector-effect="non-scaling-stroke" />
                <rect v-for="mark in timeline.marks" :key="mark.index" class="analytics-fail-mark" :x="mark.x" :y="CHART_H + 4" :width="Math.max(2, timeline.slot - 1)" :height="mark.h * grow.value.value" />
                <line v-if="hovered_slot >= 0" class="analytics-guide" vector-effect="non-scaling-stroke"
                  :x1="(hovered_slot + 0.5) * timeline.slot" :x2="(hovered_slot + 0.5) * timeline.slot" y1="0" :y2="CHART_H + MARK_H + 6" />
              </svg>
              <span v-for="label in timeline.labels" :key="label.x" class="analytics-axis-label" :style="{ left: `${label.x}%` }">{{ label.text }}</span>
            </div>
          </div>
        </section>

        <p v-if="!issue_list.length" class="analytics-calm" :style="block_style(1)"><UIcon name="i-lucide-circle-check" />{{ t("这段时间一切正常，没有需要你处理的事") }}</p>
        <section v-else class="analytics-block" :style="block_style(1)">
          <div class="analytics-block-head">
            <h2>{{ t("需要你看一下") }}<span class="analytics-count">{{ issue_list.length }}</span>
              <UPopover :content="{ side: 'top' }"><button type="button" class="analytics-info" :aria-label="t('统计口径')"><UIcon name="i-lucide-info" /></button><template #content><p class="analytics-popover">{{ t("按固定规则从这段时间的运行里挑出：出错的运行（失败，或被系统中途取消；你或主持人主动停止的不算）按原因合并，同一原因影响几个模型也只算一条。占相关运行 5% 以上或比上期翻倍才列出，占 10% 以上或翻倍的标红。只写发生了什么，不判断哪个模型更好。点开可以看到具体是哪几次，并跳到房间里对应的消息。") }}</p></template></UPopover>
            </h2>
          </div>
          <ul class="analytics-issues">
            <li v-for="item in visible_issues" :key="issue_key(item)" class="analytics-issue" :class="[issue_level(item), { 'is-open': open_issues.has(issue_key(item)) }]">
              <button type="button" class="analytics-issue-head" :aria-expanded="open_issues.has(issue_key(item))" @click="toggle_issue(issue_key(item))">
                <UIcon :name="ISSUE_ICONS[item.rule] || 'i-lucide-circle-alert'" class="analytics-issue-icon" />
                <span class="analytics-issue-main">
                  <strong>{{ issue_title(item) }}</strong>
                </span>
                <span v-if="comparable && item.previous && item.count !== item.previous" class="analytics-issue-trend" :class="item.count > item.previous ? 'is-more' : 'is-less'">
                  <UIcon :name="item.count > item.previous ? 'i-lucide-arrow-up-right' : 'i-lucide-arrow-down-right'" />{{ Math.abs(item.count - item.previous) }}
                </span>
                <UIcon :name="open_issues.has(issue_key(item)) ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" class="analytics-issue-chevron" />
              </button>
              <div v-if="open_issues.has(issue_key(item))" class="analytics-issue-body">
                <p v-if="issue_meta(item)" class="analytics-issue-meta">{{ issue_meta(item) }}</p>
                <ul v-if="item.runs?.length" class="analytics-runs">
                  <li v-for="run in item.runs" :key="run.execution_id">
                    <button type="button" class="analytics-run" :title="t('打开房间')" @click="open_run(run)">
                      <span class="analytics-run-time">{{ format_timestamp(run.created_at, report.range?.tz) }}</span>
                      <span class="analytics-run-room">{{ run.title || run.room_id }}</span>
                      <span class="analytics-run-member">{{ run.label || run.member }}</span>
                      <span class="analytics-run-status" :class="`is-${run.status}`">{{ RUN_STATUS[run.status] || run.status }}</span>
                      <span class="analytics-run-result">{{ run.failure_class ? failure_class_label(run.failure_class) : (run.result.startsWith('message:') ? '' : run.result) }}</span>
                      <UIcon name="i-lucide-arrow-up-right" class="analytics-run-jump" />
                    </button>
                  </li>
                </ul>
                <p v-if="item.runs?.length && item.runs.length < item.count" class="analytics-dim analytics-small">{{ t("只列出最近 {shown} 次，共 {count} 次", { shown: item.runs.length, count: item.count }) }}</p>
                <p v-if="item.rule === 'scheduler'" class="analytics-small"><button type="button" class="analytics-scope-toggle" @click="open_room(item.params.room_id)">{{ t("打开房间") }}</button></p>
              </div>
            </li>
          </ul>
          <button v-if="issue_list.length > ISSUE_PREVIEW" type="button" class="analytics-more analytics-more-plain" @click="issues_expanded = !issues_expanded">
            {{ issues_expanded ? t("收起") : t("其余 {count} 条", { count: issue_list.length - ISSUE_PREVIEW }) }}
            <UIcon :name="issues_expanded ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" />
          </button>
        </section>

        <div class="analytics-details-head" :style="block_style(2)">{{ t("明细") }}</div>

        <details class="analytics-detail" open :style="block_style(3)">
          <summary>
            <h2><UIcon name="i-lucide-chevron-right" class="analytics-detail-chevron" />{{ t("哪些项目在吃时间") }}</h2>
            <span v-if="top_folder" class="analytics-dim">{{ t("{name} 占 {share}", { name: top_folder.display_name, share: share_text(top_folder.share) }) }}</span>
          </summary>
          <p class="analytics-detail-note">{{ t('按房间当前所在的文件夹统计；几位成员同时运行的时间分别计入。') }}</p>
          <div class="analytics-panel">
            <template v-if="folders.length">
              <div class="analytics-stack" role="img" :aria-label="t('文件夹精力分布')">
                <i
                  v-for="(folder, index) in folders"
                  :key="folder.folder_id ?? '__unfiled__'"
                  :class="`slot-${folder.slot}`"
                  :style="{ flexGrow: folder.weight * wave(grow.value.value, index, folders.length, 0.4) }"
                  :title="`${folder.display_name} · ${share_text(folder.share)}`"
                />
              </div>
              <table class="analytics-legend">
                <tbody v-for="folder in folders" :key="folder.folder_id ?? '__unfiled__'" :class="{ 'is-open': open_folders.has(folder.key) }">
                  <tr class="analytics-folder-row">
                    <td>
                      <button type="button" class="analytics-folder-toggle" :aria-expanded="open_folders.has(folder.key)" :disabled="!folder.rooms.length" @click="toggle_folder(folder.key)">
                        <UIcon :name="open_folders.has(folder.key) ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" class="analytics-folder-chevron" />
                        <span class="analytics-swatch" :class="`slot-${folder.slot}`" />
                        <span class="analytics-folder-name">{{ folder.display_name }}</span>
                        <small class="analytics-dim">{{ t("{count} 个房间", { count: folder.rooms.length }) }}</small>
                      </button>
                    </td>
                    <td class="num">{{ share_text(folder.share) }}</td>
                    <td class="num">{{ format_duration(folder.execution_seconds) }}</td>
                    <td class="num analytics-dim">{{ t("发起 {count} 次", { count: folder.initiated }) }}</td>
                  </tr>
                  <template v-if="open_folders.has(folder.key)">
                    <tr v-for="room in (all_rooms.has(folder.key) ? folder.rooms : folder.rooms.slice(0, ROOM_PREVIEW))" :key="room.room_id" class="analytics-room-row">
                      <td>
                        <button type="button" class="analytics-room-link" :title="t('打开房间')" @click="open_room(room.room_id)">
                          <span class="analytics-room-bar" aria-hidden="true"><i :class="`slot-${folder.slot}`" :style="{ width: `${room.share}%` }" /></span>
                          <span class="analytics-folder-name">{{ room.title || room.room_id }}</span>
                          <UIcon name="i-lucide-arrow-up-right" class="analytics-room-jump" />
                        </button>
                      </td>
                      <td class="num analytics-dim">{{ t("占 {share}", { share: share_text(room.share) }) }}</td>
                      <td class="num">{{ format_duration(room.execution_seconds) }}</td>
                      <td class="num analytics-dim">{{ t("发起 {count} 次", { count: room.initiated }) }}</td>
                    </tr>
                    <tr v-if="folder.rooms.length > ROOM_PREVIEW" class="analytics-room-row">
                      <td colspan="4">
                        <button type="button" class="analytics-room-more" @click="toggle_all_rooms(folder.key)">
                          {{ all_rooms.has(folder.key) ? t("收起") : t("其余 {count} 个房间", { count: folder.rooms.length - ROOM_PREVIEW }) }}
                        </button>
                      </td>
                    </tr>
                  </template>
                </tbody>
              </table>
            </template>
            <p v-else class="analytics-dim analytics-small">{{ t("本期暂无文件夹活动记录。") }}</p>
          </div>
        </details>

        <details class="analytics-detail" open :style="block_style(4)">
          <summary>
            <h2><UIcon name="i-lucide-chevron-right" class="analytics-detail-chevron" />{{ t("哪个模型值得多用") }}</h2>
            <span v-if="top_model" class="analytics-dim">{{ t("{who} 承担了 {share} 的运行", { who: issue_who(top_model), share: share_text(top_model.run_share) }) }}</span>
          </summary>
          <p class="analytics-detail-note">{{ t('按软件、模型与强度汇总所有房间。点表头可排序；完成率旁的小条拆开了完成、失败、你停止、其他取消和进行中。不同模型接的活不一样，完成率不能直接比较好坏。') }}</p>
          <div v-if="model_rows.length" class="analytics-panel analytics-table-wrap">
            <table class="analytics-table">
              <thead>
                <tr>
                  <th>{{ t("成员") }}</th>
                  <th class="num"><button type="button" class="analytics-sort" :aria-pressed="model_sort === 'executions'" @click="model_sort = 'executions'">{{ t("运行") }}<UIcon v-if="model_sort === 'executions'" name="i-lucide-arrow-down" /></button></th>
                  <th class="num">{{ t("占比") }}</th>
                  <th><button type="button" class="analytics-sort" :aria-pressed="model_sort === 'failed'" @click="model_sort = 'failed'">{{ t("结果") }}<UIcon v-if="model_sort === 'failed'" name="i-lucide-arrow-down" /></button></th>
                  <th><button type="button" class="analytics-sort" :aria-pressed="model_sort === 'duration'" @click="model_sort = 'duration'">{{ t("耗时（通常 · 较慢）") }}<UIcon v-if="model_sort === 'duration'" name="i-lucide-arrow-down" /></button></th>
                  <th class="num"><button type="button" class="analytics-sort" :aria-pressed="model_sort === 'interrupted'" @click="model_sort = 'interrupted'">{{ t("打断 / 重试") }}<UIcon v-if="model_sort === 'interrupted'" name="i-lucide-arrow-down" /></button></th>
                  <th>{{ t("失败类型") }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in visible_models" :key="row.key">
                  <td>
                    <div class="analytics-who">
                      <strong>{{ adapter_display_label(row.adapter) }}</strong>
                      <span>{{ row.model || t("未知模型") }}<template v-if="row.effort"> · {{ row.effort }}</template></span>
                    </div>
                  </td>
                  <td class="num">{{ row.executions }}</td>
                  <td class="num">{{ share_text(row.run_share) }}</td>
                  <td>
                    <div class="analytics-rate" :title="outcome_title(row)">
                      <div class="analytics-outcome" aria-hidden="true">
                        <i v-for="part in outcomes(row)" :key="part.key" :class="`is-${part.key}`" :style="{ flexGrow: (part.share / 100) * grow.value.value }" />
                      </div>
                      <span class="num">{{ completion(row).primary }}</span>
                    </div>
                  </td>
                  <td class="analytics-typical"><span>{{ approx(row.duration) }}{{ format_duration(row.duration?.p50) }}</span><span>{{ approx(row.duration) }}{{ format_duration(row.duration?.p90) }}</span></td>
                  <td class="num"><span :class="{ 'analytics-dim': !row.interrupted }">{{ row.interrupted }}</span> / <span :class="{ 'analytics-dim': !row.retries }">{{ row.retries }}</span></td>
                  <td>
                    <span v-for="[kind, count] in row.failure_entries" :key="kind" class="analytics-pill">{{ failure_class_label(kind) }} {{ count }}</span>
                    <span v-if="!row.failure_entries.length" class="analytics-dim">—</span>
                  </td>
                </tr>
              </tbody>
            </table>
            <button v-if="model_rows.length > MEMBER_PREVIEW" type="button" class="analytics-more" @click="members_expanded = !members_expanded">
              {{ members_expanded ? t("收起") : t("显示全部 {count} 组", { count: model_rows.length }) }}
              <UIcon :name="members_expanded ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" />
            </button>
          </div>
          <p v-else class="analytics-dim analytics-small">{{ t("本期暂无成员执行记录。") }}</p>
        </details>

        <details class="analytics-detail" :style="block_style(5)" @toggle="toggle_dispatch">
          <summary>
            <h2><UIcon name="i-lucide-chevron-right" class="analytics-detail-chevron" />{{ t("主持人调度得怎样") }}</h2>
            <span class="analytics-dim">{{ dispatch_report ? t("{count} 条主持人派过活的已结束任务链", { count: dispatch_report.ended }) : t("展开后计算") }}</span>
          </summary>
          <UButton v-if="can_analyze_dispatch" icon="i-lucide-sparkles" color="neutral" variant="soft" size="xs" :label="t('AI 分析')"
            @click="bridge.request_steward('dispatch-analysis', { preset, scope, timezone: tz, range: report?.range })" />
          <p class="analytics-detail-note">{{ t("只看主持人派过活、已经结束的任务链，按主持人模型、程序版本、主持人提示词和主持技能分组，改了提示词、技能或升级后可以前后对比。作废派活：派出后被主持人撤回、被你停止、撤回或回退；浪费 token：作废、失败和其他取消的运行所花的 token；你出手的链：你对主持人派出的运行做过停止、撤回、回退、改派了主持人的活，或链结束时还有失败没处理；改派只记到能认出的部分，实际可能更多。不足 20 条链只显示次数。看不到漏派，例如该并行没并行、该派没派。") }}</p>
          <div v-if="dispatch_loading && !dispatch_report" class="analytics-skeleton"><USkeleton class="h-24 w-full rounded-xl" /></div>
          <p v-else-if="dispatch_error" class="analytics-dim analytics-small">{{ dispatch_error }}</p>
          <div v-else-if="dispatch_report?.groups?.length" class="analytics-panel analytics-table-wrap">
            <table class="analytics-table is-dispatch">
              <thead>
                <tr>
                  <th>{{ t("主持人") }}</th>
                  <th class="num">{{ t("任务链") }}</th>
                  <th class="num">{{ t("作废派活") }}</th>
                  <th class="num">{{ t("浪费 token") }}</th>
                  <th class="num">{{ t("你出手的链") }}</th>
                  <th />
                </tr>
              </thead>
              <tbody v-for="group in dispatch_report.groups" :key="dispatch_row_key(group)">
                <tr class="analytics-dispatch-row" @click="toggle_dispatch_row(dispatch_row_key(group))">
                  <td><div class="analytics-who"><strong>{{ dispatch_who(group).model }}</strong><span>{{ dispatch_who(group).version }}</span></div></td>
                  <td class="num">{{ group.chains }}</td>
                  <td class="num">{{ dispatch_rate(group.voided, group.dispatch_messages, group.chains) }}</td>
                  <td class="num">
                    <template v-if="group.with_usage">{{ dispatch_rate(Math.round(group.tokens_wasted / 1000), Math.round(group.tokens_total / 1000), group.chains) }}<small class="analytics-dim analytics-token-note">{{ t("千 token · 有用量 {count}/{total} 次", { count: group.with_usage, total: group.executions }) }}</small></template>
                    <span v-else class="analytics-dim">{{ t("没有用量记录") }}</span>
                  </td>
                  <td class="num">{{ dispatch_rate(group.intervened, group.chains, group.chains) }}</td>
                  <td class="analytics-dispatch-chevron"><UIcon :name="open_dispatch_rows.has(dispatch_row_key(group)) ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" /></td>
                </tr>
                <tr v-if="open_dispatch_rows.has(dispatch_row_key(group))" class="analytics-dispatch-detail">
                  <td colspan="6">
                    <div v-if="group.voided_examples.length" class="analytics-dispatch-examples">
                      <span class="analytics-dim">{{ t("作废的派活") }}</span>
                      <button v-for="item in group.voided_examples" :key="item.message_id" type="button" class="analytics-chip" @click="open_run({ room_id: item.room_id, message_id: item.message_id })">#{{ item.message_id }} · {{ room_label(item.room_id) }}</button>
                    </div>
                    <div v-if="group.intervened_examples.length" class="analytics-dispatch-examples">
                      <span class="analytics-dim">{{ t("你出手的链") }}</span>
                      <button v-for="item in group.intervened_examples" :key="item.message_id" type="button" class="analytics-chip" @click="open_run({ room_id: item.room_id, message_id: item.message_id })">#{{ item.message_id }} · {{ room_label(item.room_id) }}</button>
                    </div>
                    <p v-if="!group.voided_examples.length && !group.intervened_examples.length" class="analytics-dim analytics-small">{{ t("这一组没有作废的派活，也没有需要你出手的链。") }}</p>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-else-if="dispatch_report" class="analytics-calm analytics-calm-plain"><UIcon name="i-lucide-network" />{{ t("这段时间主持人没有派过活。") }}</p>
        </details>

        <details class="analytics-detail" :style="block_style(6)">
          <summary>
            <h2><UIcon name="i-lucide-chevron-right" class="analytics-detail-chevron" />{{ t("工作流用得怎样") }}</h2>
            <span class="analytics-dim">{{ workflow_rows.length ? t("工作流中的运行占 {share}", { share: share_text(workflow_share.share) }) : t("没有工作流运行") }}</span>
          </summary>
          <p class="analytics-detail-note">{{ t("按房间启用的工作流统计成员的运行；卡片是这次运行所扮演的角色，子工作流是被调用的分支流程。只含现存房间。") }}</p>
          <div v-if="workflow_rows.length" class="analytics-panel analytics-table-wrap">
            <div class="analytics-mix">
              <div class="analytics-mix-head">
                <span>{{ t("工作流中的运行占全部运行的 {share}", { share: share_text(workflow_share.share) }) }}</span>
                <span class="analytics-dim">{{ t("{inside} / {runs} 次", { inside: workflow_share.inside, runs: workflow_share.runs }) }}</span>
              </div>
              <div class="analytics-meter analytics-meter-wide" aria-hidden="true"><i :style="{ width: `${workflow_share.share * grow.value.value}%` }" /></div>
            </div>
            <table class="analytics-table is-workflow">
              <thead>
                <tr>
                  <th>{{ t("工作流") }}</th>
                  <th class="num">{{ t("运行") }}</th>
                  <th class="num">{{ t("房间") }}</th>
                  <th>{{ t("完成率") }}</th>
                  <th>{{ t("耗时（通常 · 较慢）") }}</th>
                  <th class="num">{{ t("打断") }}</th>
                  <th>{{ t("卡片与子工作流") }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in workflow_rows" :key="row.id">
                  <td><div class="analytics-who"><strong>{{ row.label }}</strong><span v-if="row.label !== row.id">{{ row.id }}</span></div></td>
                  <td class="num">{{ row.executions }}</td>
                  <td class="num">{{ row.rooms }}</td>
                  <td>
                    <div class="analytics-rate">
                      <div v-if="completion(row).width !== null" class="analytics-meter" aria-hidden="true"><i :style="{ width: `${completion(row).width * grow.value.value}%` }" /></div>
                      <span class="num">{{ completion(row).primary }}</span>
                    </div>
                  </td>
                  <td class="analytics-typical"><span>{{ format_duration(row.duration?.p50) }}</span><span>{{ format_duration(row.duration?.p90) }}</span></td>
                  <td class="num" :class="{ 'analytics-dim': !row.interrupted }">{{ row.interrupted }}</td>
                  <td>
                    <span v-for="[card, count] in row.card_entries" :key="`c-${card}`" class="analytics-chip">{{ card }} {{ count }}</span>
                    <span v-for="[branch, count] in row.sub_entries" :key="`s-${branch}`" class="analytics-chip is-sub"><UIcon name="i-lucide-git-branch" />{{ branch }} {{ count }}</span>
                    <span v-if="!row.card_entries.length && !row.sub_entries.length" class="analytics-dim">—</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-else class="analytics-calm analytics-calm-plain"><UIcon name="i-lucide-network" />{{ t("这段时间没有按工作流进行的运行。") }}</p>
        </details>

        <details class="analytics-detail" :style="block_style(7)">
          <summary>
            <h2><UIcon name="i-lucide-chevron-right" class="analytics-detail-chevron" />{{ t("哪里卡住了") }}</h2>
            <span class="analytics-dim">
              {{ t("交付通常 {duration}", { duration: format_duration(overview.delivery?.p50) }) }} ·
              {{ t("纠正 {count} 次", { count: correction_total }) }} ·
              {{ t("当前排队 {count} 条", { count: queue_info.count || 0 }) }}
            </span>
          </summary>
          <div class="analytics-panel analytics-friction">
            <div class="analytics-friction-body">
              <div class="analytics-segments">
                <div v-for="seg in waiting_segments" :key="seg.key" class="analytics-segment" :class="{ 'is-subset': seg.subset }">
                  <div class="analytics-segment-name">
                    <strong>{{ seg.label }}</strong>
                    <small>{{ seg.note }}<template v-if="seg.key === 'delivery' && delivery_note"> · {{ delivery_note }}</template></small>
                  </div>
                  <div class="analytics-range" aria-hidden="true">
                    <i class="analytics-range-span" :style="{ left: `${seg.p50_left}%`, width: `${Math.max(0, seg.p90_left - seg.p50_left)}%` }" />
                    <i class="analytics-range-dot" :style="{ left: `${seg.p50_left}%` }" />
                  </div>
                  <div class="analytics-segment-values">
                    <span>{{ typical(seg.dist) }}</span>
                    <span class="analytics-dim">{{ t("{count} 次", { count: seg.dist?.samples ?? 0 }) }}</span>
                  </div>
                </div>
              </div>
              <div class="analytics-tiles">
                <div class="is-neutral"><span>{{ t("免介入率") }}</span><strong>{{ unassisted.primary }}</strong><small>{{ t("{count} / {total} 个已结束任务", { count: overview.unassisted, total: overview.ended }) }}</small></div>
                <div><span>{{ t("停止与打断") }}</span><strong>{{ corrections.stops || 0 }}</strong></div>
                <div><span>{{ t("撤回消息") }}</span><strong>{{ corrections.withdrawals || 0 }}</strong></div>
                <div><span>{{ t("回退对话") }}</span><strong>{{ corrections.rewinds || 0 }}</strong><small>{{ t("影响 {count} 条请求", { count: corrections.affected_requests || 0 }) }}</small></div>
                <div class="is-neutral"><span>{{ t("追加插话") }}</span><strong>{{ additions.interjections || 0 }}</strong><small>{{ t("不计入介入") }}</small></div>
                <div class="is-neutral"><span>{{ t("当前排队") }}</span><strong>{{ queue_info.count || 0 }}</strong><small v-if="queue_info.count">{{ t("最久已等 {duration}", { duration: format_duration(queue_info.oldest_seconds) }) }}</small></div>
              </div>
            </div>
          </div>
        </details>

        <footer class="analytics-foot" :style="block_style(8)">
          <span>{{ scope_text }}</span>
          <button v-if="report.scope?.sealed_rooms || scope === 'current'" type="button" class="analytics-scope-toggle" @click="scope = scope === 'all' ? 'current' : 'all'">
            {{ scope === "all" ? t("只看现存房间") : t("包含已删除房间") }}
          </button>
          <span>{{ t("时区：{tz}", { tz: report.range?.tz || tz }) }}</span>
          <span v-if="report.scope?.mode === 'all' && report.scope?.sealed_rooms">{{ t("问题清单、并行峰值、文件夹、成员、工作流只含现存房间") }}</span>
        </footer>
      </template>
    </div>

    <UModal
      v-model:open="share_open"
      :title="t('生成分享图')"
      :description="t('在浏览器本地生成，不会上传到任何服务器；仅包含汇总数字、日期区间和统计范围，不含成员名、房间标题与文件夹名。')"
      :ui="{ content: 'glass-panel studio-modal analytics-share-modal', body: 'dialog-body' }"
    >
      <template #body>
        <div class="analytics-share-preview">
          <canvas ref="share_canvas" class="analytics-share-canvas" :aria-label="t('统计分享图预览')" />
        </div>
        <div class="analytics-share-actions">
          <UButton icon="i-lucide-download" :label="t('保存图片')" color="neutral" class="channel-primary-button" @click="download_share_card" />
          <UButton v-if="can_copy_image" :icon="copied_image ? 'i-lucide-check' : 'i-lucide-copy'" :label="copied_image ? t('已复制图片') : t('复制图片')" color="neutral" variant="soft" @click="copy_share_card" />
          <UButton :label="t('关闭')" color="neutral" variant="ghost" @click="share_open = false" />
        </div>
      </template>
    </UModal>
  </div>
</template>

<style scoped>
/* Categorical slots from the validated dataviz palette; dark steps are selected, not flipped.
   Motion lives in analytics-motion.js (springs, no durations); this sheet has no transitions or keyframes. */
.analytics-page {
  --viz-1: #338ced; --viz-2: #e76624; --viz-3: #00a888; --viz-4: #d28e05; --viz-5: #e24d8b; --viz-6: #0aac23; --viz-other: #6b6f78;
  --viz-up: #3fb27f; --viz-down: #e5797a;
  flex: 1; min-height: 0; overflow-y: auto;
}
:global(:root[data-theme="channel-light"]) .analytics-page {
  --viz-1: #257de0; --viz-2: #f47230; --viz-3: #00b894; --viz-4: #f2a600; --viz-5: #ee7fac; --viz-6: #008a17; --viz-other: #a3a7ae;
  --viz-up: #1a7f4b; --viz-down: #c2413f;
}
.analytics-wrap { display: grid; gap: 28px; max-width: 1080px !important; margin: 0 auto; padding-bottom: 24px; }
.num { font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
.analytics-dim { color: var(--ui-text-dimmed); }
.analytics-small { font-size: 12px; margin: 0; }
.analytics-eyebrow { display: flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 500; letter-spacing: .02em; color: var(--ui-text-muted); }
.analytics-info { display: inline-grid; place-items: center; padding: 2px; margin: -2px; border: 0; border-radius: 4px; background: none; color: var(--ui-text-dimmed); cursor: help; }
.analytics-info :deep([class*="icon"]) { width: 13px; height: 13px; }
.analytics-info:hover, .analytics-info:focus-visible, .analytics-info[data-state="open"] { color: var(--ui-text-highlighted); outline: none; }
.analytics-hint { padding: 0; border: 0; background: none; color: inherit; font: inherit; text-decoration: underline dotted color-mix(in srgb, var(--ui-text) 35%, transparent); text-underline-offset: 3px; cursor: help; }
.analytics-popover { max-width: 280px; margin: 0; padding: 8px 11px; font-size: 12px; line-height: 1.55; color: var(--ui-text); }

/* Header */
.analytics-head { display: flex; align-items: flex-end; justify-content: space-between; flex-wrap: wrap; gap: 14px 20px; }
.analytics-title h1 { margin: 0; font-size: 24px; line-height: 1.25; font-weight: 650; letter-spacing: -.01em; color: var(--ui-text-highlighted); }
.analytics-title p { display: flex; flex-wrap: wrap; gap: 4px 14px; margin: 6px 0 0; font-size: 13px; color: var(--ui-text-toned); font-variant-numeric: tabular-nums; }
.analytics-controls { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.analytics-segmented { display: inline-flex; padding: 2px; border: 1px solid var(--ui-border-muted); border-radius: 8px; background: var(--ui-bg-muted); }
.analytics-segmented button { padding: 4px 11px; border: 0; border-radius: 6px; background: transparent; color: var(--ui-text-muted); font-size: 12.5px; line-height: 20px; }
.analytics-segmented button:hover { color: var(--ui-text-highlighted); }
.analytics-segmented button[aria-pressed="true"] { background: var(--ui-bg-elevated); color: var(--ui-text-highlighted); box-shadow: 0 1px 2px #0000001f, 0 0 0 1px var(--ui-border-muted); }

.analytics-share-button { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 10px; border: 1px solid var(--ui-border); border-radius: 7px; background: transparent; color: var(--ui-text-highlighted); font-size: 12.5px; }
.analytics-share-button:hover:not(:disabled) { background: color-mix(in srgb, var(--ui-text) 6%, transparent); }
.analytics-share-button:disabled { opacity: .5; }
.analytics-share-button :deep([class*="icon"]) { width: 15px; height: 15px; }
.analytics-skeleton { display: grid; gap: 20px; }
.analytics-error { display: flex; align-items: center; gap: 10px; padding: 14px 16px; border: 1px solid color-mix(in srgb, var(--ui-error) 35%, var(--ui-border)); border-radius: 12px; background: color-mix(in srgb, var(--ui-error) 8%, transparent); font-size: 13px; }
.analytics-error p { margin: 0; flex: 1; }

.analytics-meter { height: 4px; border-radius: 999px; background: color-mix(in srgb, var(--ui-text) 9%, transparent); overflow: hidden; }
.analytics-meter i { display: block; height: 100%; border-radius: 999px; background: var(--channel-accent); }

/* Overview: figures and the timeline lead the page (Fable #14109); the sentence above them is a caption. */
.analytics-overview { display: grid; gap: 16px; }
.analytics-caption { margin: -6px 0 0; font-size: 13.5px; line-height: 1.6; color: var(--ui-text-toned); }
.analytics-figures { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); border: 1px solid var(--ui-border-muted); border-radius: 14px; background: var(--ui-bg-elevated); overflow: hidden; }
.analytics-figure { display: grid; align-content: start; gap: 6px; padding: 18px 20px 16px; min-width: 0; }
.analytics-figure + .analytics-figure { border-left: 1px solid var(--ui-border-muted); }
.analytics-figure-label { font-size: 12px; font-weight: 500; color: var(--ui-text-muted); }
.analytics-figure-value { font-size: 30px; line-height: 1.1; font-weight: 700; letter-spacing: -.02em; color: var(--ui-text-highlighted); font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.analytics-figure:first-child .analytics-figure-value { color: var(--channel-accent); }
.analytics-figure-foot { display: flex; flex-wrap: wrap; gap: 2px 10px; min-height: 18px; font-size: 12px; font-variant-numeric: tabular-nums; }
.analytics-change { color: var(--ui-text-toned); }
.analytics-change.is-up { color: var(--viz-up); }
.analytics-change.is-down { color: var(--viz-down); }
.analytics-figure:last-child .analytics-change.is-up { color: var(--viz-up); }

.analytics-timeline { display: grid; gap: 8px; padding: 16px 20px 26px; border: 1px solid var(--ui-border-muted); border-radius: 14px; background: var(--ui-bg-elevated); }
.analytics-timeline-head { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 6px 12px; min-height: 18px; font-size: 12px; color: var(--ui-text-muted); }
.analytics-timeline-readout { color: var(--ui-text-highlighted); font-variant-numeric: tabular-nums; }
.analytics-legend-inline { display: inline-flex; gap: 14px; }
.analytics-legend-inline > span { display: inline-flex; align-items: center; gap: 6px; }
.analytics-key { display: inline-block; width: 9px; height: 9px; border-radius: 3px; }
.analytics-key.is-run { background: var(--channel-accent); }
.analytics-key.is-fail { background: var(--ui-error); }
.analytics-timeline-plot { position: relative; height: 180px; cursor: crosshair; }
.analytics-timeline-plot svg { display: block; width: 100%; height: 100%; overflow: visible; }
.analytics-area { fill: color-mix(in srgb, var(--channel-accent) 22%, transparent); }
.analytics-line { fill: none; stroke: var(--channel-accent); stroke-width: 2px; stroke-linejoin: round; }
.analytics-axis { stroke: var(--ui-border); stroke-width: 1px; }
.analytics-fail-mark { fill: var(--ui-error); opacity: .85; }
.analytics-guide { stroke: var(--ui-text-dimmed); stroke-width: 1px; stroke-dasharray: 3 3; }
.analytics-axis-label { position: absolute; top: calc(100% + 4px); transform: translateX(-2px); font-size: 11px; color: var(--ui-text-dimmed); white-space: nowrap; }
.analytics-calm { display: flex; align-items: center; gap: 8px; margin: 0; padding: 10px 14px; border: 1px dashed var(--ui-border); border-radius: 10px; font-size: 13px; color: var(--ui-text-muted); }
.analytics-calm :deep([class*="icon"]) { width: 15px; height: 15px; color: var(--viz-up); }
.analytics-count { margin-left: 2px; padding: 0 7px; border-radius: 999px; background: color-mix(in srgb, var(--ui-text) 8%, transparent); font-size: 12px; font-weight: 600; color: var(--ui-text-toned); }

/* Issues: the part of the page to act on. */
/* One quiet list, one line per issue (#14383: the bordered red cards took too much of the page); details open on click. */
.analytics-issues { list-style: none; margin: 0; padding: 0; border: 1px solid var(--ui-border-muted); border-radius: 12px; background: var(--ui-bg-elevated); overflow: hidden; }
.analytics-issue + .analytics-issue { border-top: 1px solid var(--ui-border-muted); }
.analytics-issue-head { width: 100%; display: flex; align-items: center; gap: 10px; padding: 9px 14px; border: 0; background: transparent; color: var(--ui-text); text-align: left; }
.analytics-issue-head:hover { background: color-mix(in srgb, var(--ui-text) 3%, transparent); }
.analytics-issue-icon { width: 15px; height: 15px; flex-shrink: 0; }
.is-critical .analytics-issue-icon { color: var(--ui-error); }
.is-normal .analytics-issue-icon { color: var(--ui-text-dimmed); }
.is-info .analytics-issue-icon { color: var(--ui-text-dimmed); }
.analytics-issue-main { flex: 1; min-width: 0; }
.analytics-issue-main strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 500; color: var(--ui-text-highlighted); }
.analytics-issue-trend { display: inline-flex; align-items: center; gap: 2px; flex-shrink: 0; font-size: 12px; font-variant-numeric: tabular-nums; }
.analytics-issue-trend :deep([class*="icon"]) { width: 12px; height: 12px; }
.analytics-issue-trend.is-more { color: var(--viz-down); }
.analytics-issue-trend.is-less { color: var(--viz-up); }
.analytics-issue-chevron { width: 14px; height: 14px; flex-shrink: 0; color: var(--ui-text-dimmed); }
.analytics-issue-body { display: grid; gap: 8px; padding: 0 14px 12px 39px; }
.analytics-issue-meta { margin: 0; font-size: 12px; line-height: 1.55; color: var(--ui-text-muted); font-variant-numeric: tabular-nums; }
.analytics-reasons { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; font-size: 12px; }
.analytics-reason { display: inline-flex; align-items: baseline; min-width: 0; gap: 6px; max-width: 100%; padding: 2px 9px; border-radius: 6px; background: color-mix(in srgb, var(--ui-text) 6%, transparent); color: var(--ui-text-toned); }
.analytics-reason span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.analytics-reason b { flex-shrink: 0; white-space: nowrap; }
.analytics-reason b { font-weight: 600; color: var(--ui-text-highlighted); font-variant-numeric: tabular-nums; }
.analytics-runs { list-style: none; margin: 0; padding: 0; display: grid; max-height: 240px; overflow-y: auto; border-top: 1px solid var(--ui-border-muted); }
.analytics-run { width: 100%; display: grid; grid-template-columns: 92px minmax(0, 1.2fr) minmax(0, .8fr) 52px minmax(0, 2fr) 14px; align-items: center; gap: 10px; padding: 7px 0; border: 0; border-bottom: 1px solid var(--ui-border-muted); background: transparent; color: var(--ui-text); font-size: 12.5px; text-align: left; }
.analytics-run:hover .analytics-run-room { color: var(--ui-text-highlighted); text-decoration: underline; text-underline-offset: 3px; }
.analytics-run > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.analytics-run-time { color: var(--ui-text-muted); font-variant-numeric: tabular-nums; }
.analytics-run-member, .analytics-run-result { color: var(--ui-text-muted); }
.analytics-run-status { font-size: 11.5px; }
.analytics-run-status.is-failed { color: var(--ui-error); }
.analytics-run-status.is-cancelled { color: var(--ui-warning); }
.analytics-run-status.is-completed { color: var(--viz-up); }
.analytics-run-jump { width: 12px; height: 12px; color: var(--ui-text-dimmed); }
.analytics-more-plain { border-top: 0; justify-content: flex-start; padding: 8px 2px 0; width: auto; }

/* Details: everything else, folded under a title phrased as the owner's question. */
.analytics-details-head { margin-top: 8px; font-size: 12px; font-weight: 600; letter-spacing: .04em; color: var(--ui-text-dimmed); }
.analytics-detail { border-top: 1px solid var(--ui-border-muted); }
.analytics-detail summary { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 4px 14px; padding: 14px 2px; cursor: pointer; list-style: none; }
.analytics-detail summary::-webkit-details-marker { display: none; }
.analytics-detail summary h2 { display: flex; align-items: center; gap: 6px; margin: 0; font-size: 15px; font-weight: 600; color: var(--ui-text-highlighted); }
.analytics-detail summary > span { font-size: 12.5px; font-variant-numeric: tabular-nums; }
.analytics-detail summary:hover h2 { color: var(--channel-accent); }
.analytics-detail-chevron { width: 15px; height: 15px; color: var(--ui-text-dimmed); }
.analytics-detail[open] .analytics-detail-chevron { transform: rotate(90deg); }
.analytics-detail[open] { padding-bottom: 18px; }
.analytics-detail-note { margin: -4px 0 12px 21px; font-size: 12px; line-height: 1.55; color: var(--ui-text-dimmed); }
.analytics-detail + .analytics-foot { border-top: 1px solid var(--ui-border-muted); padding-top: 14px; }
.analytics-friction { padding: 18px 20px; }

/* Outcome bar: completed / failed / stopped by you / cancelled otherwise / running. */
.analytics-outcome { display: flex; gap: 1px; height: 6px; border-radius: 999px; background: color-mix(in srgb, var(--ui-text) 9%, transparent); overflow: hidden; }
.analytics-outcome i { display: block; flex-basis: 0; min-width: 0; }
.analytics-outcome .is-done { background: var(--channel-accent); }
.analytics-outcome .is-failed { background: var(--ui-error); }
.analytics-outcome .is-stopped { background: var(--ui-warning); }
.analytics-outcome .is-cancelled { background: var(--viz-other); }
.analytics-outcome .is-running { background: color-mix(in srgb, var(--channel-accent) 35%, transparent); }
.analytics-dispatch-row { cursor: pointer; }
.analytics-dispatch-chevron { width: 28px; color: var(--ui-text-dimmed); }
.analytics-dispatch-chevron :deep([class*="icon"]) { width: 14px; height: 14px; }
.analytics-token-note { display: block; font-size: 11px; font-weight: 400; }
.analytics-dispatch-detail td { background: color-mix(in srgb, var(--ui-text) 2%, transparent); }
.analytics-dispatch-examples { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; padding: 2px 0; font-size: 12px; }
.analytics-dispatch-examples .analytics-chip { border: 0; cursor: pointer; }
.analytics-dispatch-examples .analytics-chip:hover { color: var(--ui-text-highlighted); }
.analytics-live-list { display: grid; padding: 4px 0; }
.analytics-live-room { padding: 10px 18px 4px; border: 0; background: none; text-align: left; font-size: 12px; font-weight: 600; color: var(--ui-text-muted); cursor: pointer; }
.analytics-live-room:hover { color: var(--ui-text-highlighted); }
.analytics-live-row { display: grid; grid-template-columns: 18px minmax(0, 1fr) auto; align-items: center; gap: 10px; padding: 8px 18px; border: 0; background: none; text-align: left; cursor: pointer; }
.analytics-live-row:hover { background: color-mix(in srgb, var(--ui-text) 4%, transparent); }
.analytics-live-icon { width: 16px; height: 16px; color: var(--ui-text-muted); }
.analytics-live-icon.is-waiting { color: var(--ui-warning); }
.analytics-live-main { display: grid; gap: 1px; min-width: 0; }
.analytics-live-main strong { font-size: 13px; font-weight: 600; }
.analytics-live-main span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.analytics-live-side { font-size: 12px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.analytics-figure.is-alert .analytics-figure-value { color: var(--ui-warning); }
.analytics-sort { display: inline-flex; align-items: center; gap: 3px; padding: 0; border: 0; background: none; color: inherit; font: inherit; }
.analytics-sort:hover, .analytics-sort[aria-pressed="true"] { color: var(--ui-text-highlighted); }
.analytics-sort :deep([class*="icon"]) { width: 11px; height: 11px; }

/* Section blocks */
.analytics-block { display: grid; gap: 12px; }
.analytics-block-head h2 { display: flex; align-items: center; gap: 6px; margin: 0; font-size: 15px; font-weight: 600; color: var(--ui-text-highlighted); }
.analytics-panel { border: 1px solid var(--ui-border-muted); border-radius: 12px; background: var(--ui-bg-elevated); padding: 18px 20px; }


/* Time */
.analytics-stack { display: flex; gap: 2px; height: 12px; margin-bottom: 16px; }
.analytics-stack i { display: block; flex-basis: 0; min-width: 0; border-radius: 2px; }
.analytics-stack i:first-child { border-radius: 4px 2px 2px 4px; }
.analytics-stack i:last-child { border-radius: 2px 4px 4px 2px; }
.slot-1 { background: var(--viz-1); } .slot-2 { background: var(--viz-2); } .slot-3 { background: var(--viz-3); }
.slot-4 { background: var(--viz-4); } .slot-5 { background: var(--viz-5); } .slot-6 { background: var(--viz-6); } .slot-0 { background: var(--viz-other); }
.analytics-legend { width: 100%; border-collapse: collapse; font-size: 13px; }
.analytics-legend td { padding: 6px 0; border-top: 1px solid var(--ui-border-muted); color: var(--ui-text); }
.analytics-legend tr:first-child td { border-top: 0; }
.analytics-legend td:first-child { max-width: 0; width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.analytics-legend td + td { padding-left: 24px; }
.analytics-legend tbody + tbody .analytics-folder-row td { border-top: 1px solid var(--ui-border-muted); }
.analytics-folder-toggle, .analytics-room-link { display: flex; align-items: center; gap: 0; width: 100%; min-width: 0; padding: 0; border: 0; background: none; color: inherit; font: inherit; text-align: left; }
.analytics-folder-toggle:disabled { cursor: default; }
.analytics-folder-toggle:disabled .analytics-folder-chevron { visibility: hidden; }
.analytics-folder-toggle:not(:disabled):hover .analytics-folder-name, .analytics-room-link:hover .analytics-folder-name { color: var(--ui-text-highlighted); text-decoration: underline; text-underline-offset: 3px; }
.analytics-folder-chevron { width: 13px; height: 13px; flex-shrink: 0; margin-right: 6px; color: var(--ui-text-dimmed); }
.analytics-folder-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.analytics-folder-toggle small { flex-shrink: 0; margin-left: 8px; font-size: 11.5px; }
.analytics-room-row td { padding: 4px 0; border-top: 0; font-size: 12.5px; }
.analytics-room-row td:first-child { padding-left: 19px; }
.analytics-room-link { color: var(--ui-text-toned); }
.analytics-room-bar { flex-shrink: 0; width: 48px; height: 4px; margin-right: 10px; border-radius: 999px; background: color-mix(in srgb, var(--ui-text) 8%, transparent); overflow: hidden; }
.analytics-room-bar i { display: block; height: 100%; border-radius: 999px; }
.analytics-room-jump { width: 12px; height: 12px; flex-shrink: 0; margin-left: 6px; color: var(--ui-text-dimmed); opacity: 0; }
.analytics-room-link:hover .analytics-room-jump, .analytics-room-link:focus-visible .analytics-room-jump { opacity: 1; }
.analytics-legend tbody.is-open .analytics-room-row:last-child td { padding-bottom: 10px; }
.analytics-room-more { padding: 2px 0; border: 0; background: none; color: var(--channel-accent); font-size: 12px; }
.analytics-room-more:hover { text-decoration: underline; text-underline-offset: 3px; }
.analytics-swatch { display: inline-block; width: 9px; height: 9px; margin-right: 9px; border-radius: 3px; vertical-align: 0; }

/* Team table */
.analytics-table-wrap { padding: 4px 0 0; overflow-x: auto; }
.analytics-mix { display: grid; gap: 10px; padding: 14px 20px 16px; border-bottom: 1px solid var(--ui-border-muted); }
.analytics-mix-head { display: flex; justify-content: space-between; gap: 12px; font-size: 12px; color: var(--ui-text-muted); }
.analytics-mix .analytics-stack { margin-bottom: 0; }
.analytics-meter-wide { height: 6px; }
.analytics-chip { display: inline-flex; align-items: center; gap: 3px; margin: 1px 4px 1px 0; padding: 1px 7px; border-radius: 999px; background: color-mix(in srgb, var(--ui-text) 7%, transparent); color: var(--ui-text-toned); font-size: 11px; white-space: nowrap; }
.analytics-chip.is-sub { background: color-mix(in srgb, var(--channel-accent) 14%, transparent); color: var(--ui-text-highlighted); }
.analytics-chip :deep([class*="icon"]) { width: 11px; height: 11px; }
.analytics-calm-plain :deep([class*="icon"]) { color: var(--ui-text-dimmed); }
.analytics-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.analytics-table th { padding: 10px 14px; font-size: 11.5px; font-weight: 500; color: var(--ui-text-muted); text-align: left; white-space: nowrap; border-bottom: 1px solid var(--ui-border-muted); }
.analytics-table th.num { text-align: right; }
.analytics-table td { padding: 10px 14px; border-bottom: 1px solid var(--ui-border-muted); color: var(--ui-text-highlighted); vertical-align: middle; }
.analytics-table tbody tr:last-child td { border-bottom: 0; }
.analytics-table tbody tr:hover td { background: color-mix(in srgb, var(--ui-text) 2.5%, transparent); }
.analytics-table th:first-child, .analytics-table td:first-child { padding-left: 20px; }
.analytics-table th:last-child, .analytics-table td:last-child { padding-right: 20px; }
.analytics-who { display: grid; gap: 1px; min-width: 150px; }
.analytics-who strong { font-weight: 600; }
.analytics-who span { font-size: 11.5px; color: var(--ui-text-muted); }
.analytics-rate { display: grid; grid-template-columns: 64px auto; align-items: center; gap: 8px; min-width: 120px; }
.analytics-rate .num { text-align: left; grid-column: 2; }
.analytics-typical { white-space: nowrap; font-variant-numeric: tabular-nums; color: var(--ui-text-toned); }
.analytics-typical span { display: inline-block; min-width: 92px; text-align: right; }
.analytics-typical span + span { color: var(--ui-text-muted); }
.analytics-pill { display: inline-block; margin: 1px 4px 1px 0; padding: 1px 7px; border-radius: 999px; background: color-mix(in srgb, var(--ui-error) 11%, transparent); color: var(--ui-error); font-size: 11px; white-space: nowrap; }
.analytics-more { display: flex; align-items: center; justify-content: center; gap: 4px; width: 100%; padding: 9px; border: 0; border-top: 1px solid var(--ui-border-muted); background: transparent; color: var(--ui-text-muted); font-size: 12.5px; }
.analytics-more:hover { color: var(--ui-text-highlighted); }

/* Durations and friction */
.analytics-friction { padding: 0; }
.analytics-friction-body { display: grid; gap: 20px; }
.analytics-segments { display: grid; gap: 4px; padding-top: 12px; }
.analytics-segment { display: grid; grid-template-columns: 240px minmax(0, 1fr) 260px; align-items: center; gap: 18px; padding: 8px 0; }
.analytics-segment.is-subset .analytics-segment-name { padding-left: 14px; border-left: 2px solid var(--ui-border-accented); }
.analytics-segment-name { display: grid; gap: 1px; }
.analytics-segment-name strong { font-size: 13px; font-weight: 500; color: var(--ui-text-highlighted); }
.analytics-segment-name small { font-size: 11px; color: var(--ui-text-dimmed); }
.analytics-range { position: relative; height: 8px; border-radius: 999px; background: color-mix(in srgb, var(--ui-text) 6%, transparent); }
.analytics-range-span { position: absolute; top: 0; bottom: 0; border-radius: 999px; background: color-mix(in srgb, var(--channel-accent) 35%, transparent); }
.analytics-range-dot { position: absolute; top: 50%; width: 10px; height: 10px; border-radius: 50%; background: var(--channel-accent); box-shadow: 0 0 0 2px var(--ui-bg-elevated); transform: translate(-50%, -50%); }
.analytics-segment-values { display: flex; justify-content: flex-end; gap: 14px; font-size: 12px; color: var(--ui-text-toned); font-variant-numeric: tabular-nums; white-space: nowrap; }
.analytics-tiles { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px; }
.analytics-tiles > div { display: grid; gap: 2px; padding: 12px 14px; border-radius: 10px; background: color-mix(in srgb, var(--ui-text) 3.5%, transparent); }
.analytics-tiles span { font-size: 12px; color: var(--ui-text-muted); }
.analytics-tiles strong { font-size: 22px; line-height: 1.25; font-weight: 650; color: var(--ui-text-highlighted); font-variant-numeric: tabular-nums; }
.analytics-tiles small { font-size: 11px; color: var(--ui-text-dimmed); }
.analytics-tiles .is-neutral strong { color: var(--ui-text-toned); }

.analytics-foot { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 18px; font-size: 12px; color: var(--ui-text-dimmed); }
.analytics-scope-toggle { padding: 0; border: 0; background: none; color: var(--channel-accent); font-size: 12px; }
.analytics-scope-toggle:hover { text-decoration: underline; text-underline-offset: 3px; }

.analytics-share-preview { display: grid; place-items: center; padding: 8px 0 14px; }
.analytics-share-canvas { width: 100%; max-width: 440px; height: auto; border-radius: 12px; border: 1px solid var(--ui-border-muted); box-shadow: 0 8px 24px #00000026; }
.analytics-share-actions { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 8px; }

@media (max-width: 900px) {
  .analytics-figures { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .analytics-figure:nth-child(3) { border-left: 0; }
  .analytics-figure:nth-child(n+3) { border-top: 1px solid var(--ui-border-muted); }
  .analytics-segment { grid-template-columns: minmax(0, 1fr); gap: 6px; }
  .analytics-segment-values { justify-content: flex-start; }
  .analytics-tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 600px) {
  .analytics-panel { padding: 16px; }
  .analytics-figures { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .analytics-figure:nth-child(3) { border-left: 0; }
  .analytics-figure:nth-child(n+3) { border-top: 1px solid var(--ui-border-muted); }
  .analytics-figure { padding: 14px 14px 12px; }
  .analytics-figure-value { font-size: 22px; white-space: normal; }
  .analytics-timeline { padding: 12px 12px 24px; }
  .analytics-timeline-plot { height: 140px; }
  .analytics-issue-head { padding: 10px 12px; gap: 10px; }
  .analytics-issue-main strong { white-space: normal; }
  .analytics-issue-body { padding: 2px 12px 12px; }
  .analytics-run { grid-template-columns: minmax(0, 1fr) 44px 12px; row-gap: 2px; }
  .analytics-run-time, .analytics-run-member { display: none; }
  .analytics-run-result { grid-column: 1 / -1; grid-row: 2; }
  .analytics-detail-note { margin-left: 0; }
  .analytics-friction { padding: 14px; }
  /* Phones: period switch, refresh and share sit on one row; the share button keeps only its icon (#13468). */
  .analytics-controls { flex-wrap: nowrap; gap: 4px; width: 100%; }
  .analytics-segmented button { padding: 4px 8px; }
  .analytics-share-button { width: 32px; padding: 0; justify-content: center; margin-left: auto; }
  .analytics-share-button span { display: none; }
  /* Phones: tables keep the columns needed to compare at a glance instead of scrolling sideways (2026-11-26 #13416).
     Member scorecard keeps member, runs, share and completion; workflows keep name, runs, completion and cards;
     the folder legend drops the started count so folder and room names stay readable. */
  .analytics-legend td + td { padding-left: 12px; }
  .analytics-legend td:nth-child(4) { display: none; }
  .analytics-folder-toggle small { display: none; }
  .analytics-room-bar { width: 28px; margin-right: 8px; }
  .analytics-table-wrap { overflow-x: visible; }
  .analytics-table th, .analytics-table td { padding: 9px 8px; }
  .analytics-table th:first-child, .analytics-table td:first-child { padding-left: 14px; }
  .analytics-table th:last-child, .analytics-table td:last-child { padding-right: 14px; }
  .analytics-who { min-width: 0; }
  .analytics-who strong, .analytics-who span { overflow-wrap: break-word; }
  .analytics-table.is-workflow td:first-child { min-width: 120px; }
  .analytics-rate { grid-template-columns: auto; min-width: 0; }
  .analytics-rate .analytics-meter { display: none; }
  .analytics-rate .num { grid-column: 1; text-align: right; }
  .analytics-table:not(.is-workflow, .is-dispatch) :is(th, td):nth-child(n+5) { display: none; }
  .analytics-table.is-workflow :is(th, td):is(:nth-child(3), :nth-child(5), :nth-child(6)) { display: none; }
  .analytics-table.is-workflow td:last-child { white-space: normal; }
  .analytics-table.is-dispatch :is(th, td):nth-child(4) { display: none; }
  .analytics-table.is-dispatch td:first-child:not([colspan]) { min-width: 96px; }
  .analytics-table.is-dispatch td.num { white-space: normal; }
  .analytics-mix { padding: 12px 14px 14px; }
  /* The folded friction block is a one-line summary, not a card: title and figures stack tightly. */
  .analytics-segment { padding: 6px 0; }
  .analytics-segment-values { flex-wrap: wrap; gap: 4px 12px; }
  .analytics-tiles { gap: 8px; }
  .analytics-tiles > div { padding: 10px 12px; }
  .analytics-tiles strong { font-size: 19px; }
  .analytics-calm { padding: 9px 12px; font-size: 12.5px; }
  .analytics-foot { gap: 2px 12px; }
}
</style>

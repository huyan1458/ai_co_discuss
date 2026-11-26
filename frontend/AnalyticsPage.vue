<script setup>
import { computed, inject, nextTick, onMounted, ref, watch } from "vue";
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
  inline_ratio,
} from "./analytics-state.js";
import { analytics_card_blob, draw_analytics_card } from "./analytics-card.js";
import { entrance, use_spring, wave } from "./analytics-motion.js";
import { use_workflow_library } from "./workflow-library.js";
import { locale, t } from "./i18n.js";

const emit = defineEmits(["open-room"]);
const { view, bridge } = inject("discussion");

const PRESETS = [
  { value: "today", label: t("今日") },
  { value: "7d", label: t("近 7 天") },
  { value: "30d", label: t("近 30 天") },
  { value: "all", label: t("全部时间") },
];
const DAILY_LABELS = 8;
const FOLDER_SLOTS = 6;
const MEMBER_PREVIEW = 8;

const preset = ref("7d");
const scope = ref("all");
const report = ref(null);
const loading = ref(false);
const error = ref("");
const blockers_open = ref(false);
const members_expanded = ref(false);
const hovered_day = ref(-1);
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
const hero_percent = use_spring(0);
const started_count = use_spring(0);
const peak_rooms = use_spring(0);
const peak_members = use_spring(0);
const execution_total = use_spring(0);
const block_style = (index) => entrance(enter.value.value, index);

const report_heading = computed(() => PRESETS.find((item) => item.value === preset.value)?.label || "");
const date_range_label = computed(() => inclusive_date_range(report.value?.range?.from, report.value?.range?.to));
const prev_range_label = computed(() => {
  const range = report.value?.range;
  return range && range.previous_from < range.previous_to ? inclusive_date_range(range.previous_from, range.previous_to) : "";
});

/** Load the analytics snapshot for the active period and room scope; stale responses are dropped. */
async function load(manual = false) {
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
watch([preset, scope], () => { members_expanded.value = false; regrow = true; load(false); });

const overview = computed(() => report.value?.overview || null);
const previous = computed(() => report.value?.previous || null);
const unassisted = computed(() => format_ratio(overview.value?.unassisted, overview.value?.ended));
const unassisted_prev = computed(() => format_ratio(previous.value?.unassisted, previous.value?.ended));
const peak = computed(() => report.value?.time?.peak || { rooms: 0, at: null, members: 0, members_at: null });

/** Signed change against the previous period, or null when either side lacks a comparable value. */
function delta(now, before) {
  if (now === null || now === undefined || before === null || before === undefined) return null;
  return Number(now) - Number(before);
}

const unassisted_delta = computed(() => (
  unassisted.value.has_percent && unassisted_prev.value.has_percent ? delta(unassisted.value.percent, unassisted_prev.value.percent) : null
));
// Today is still running, so its count is not compared with yesterday's full day.
const initiated_delta = computed(() => (preset.value !== "today" && previous.value?.initiated ? delta(overview.value?.initiated, previous.value.initiated) : null));
const answered_percent = computed(() => {
  const total = Number(overview.value?.initiated || 0);
  return total ? Math.round((Number(overview.value?.answered || 0) / total) * 100) : 0;
});
const approx = (dist) => (dist?.approximate ? "≈ " : "");
const execution_seconds = computed(() => report.value?.time?.execution_seconds || 0);

watch(report, (data, before) => {
  if (!data) return;
  if (!before) enter.to(0);
  if (regrow) { grow.jump(0); grow.to(1); regrow = false; }
  hero_percent.to(unassisted.value.percent ?? 0);
  started_count.to(Number(data.overview?.initiated || 0));
  peak_rooms.to(Number(peak.value.rooms || 0));
  peak_members.to(Number(peak.value.members || 0));
  execution_total.to(execution_seconds.value);
});

const hero_text = computed(() => (unassisted.value.has_percent ? `${Math.round(hero_percent.value.value)}%` : unassisted.value.primary));

/** Daily finished tasks, split into those you left alone and those you stepped into; hidden for a single day. */
const daily = computed(() => {
  const rows = overview.value?.daily || [];
  if (rows.length < 2) return [];
  const max = Math.max(1, ...rows.map((row) => Number(row.ended || 0)));
  const week = rows.length <= 7;
  const step = Math.ceil(rows.length / DAILY_LABELS);
  return rows.map((row, index) => {
    const [year, mon, day] = String(row.date).split("-").map(Number);
    const date = new Date(Date.UTC(year, mon - 1, day));
    const ended = Number(row.ended || 0);
    const alone = Math.min(ended, Number(row.unassisted || 0));
    return {
      ...row,
      ended,
      stepped_in: ended - alone,
      height: ended ? Math.max(6, (ended / max) * 100) : 0,
      alone_share: ended ? (alone / ended) * 100 : 0,
      label: week
        ? date.toLocaleDateString(locale, { weekday: "short", timeZone: "UTC" })
        : date.toLocaleDateString(locale, { month: "numeric", day: "numeric", timeZone: "UTC" }),
      full: date.toLocaleDateString(locale, { month: "numeric", day: "numeric", weekday: "short", timeZone: "UTC" }),
      show_label: week || (rows.length - 1 - index) % step === 0,
    };
  });
});
const bar_height = (day, index) => `${day.height * wave(grow.value.value, index, daily.value.length)}%`;

/** Resolve a room's title from the loaded directory; falls back to its id. */
function room_label(room_id) {
  if (!room_id) return "";
  const found = (view.value.rooms || []).find((item) => item.id === room_id);
  return found?.title || bridge.room_title?.(room_id) || room_id;
}

/** One-sentence description for each backend insight rule. */
function insight_text(item) {
  const room = room_label(item.target?.room_id);
  const member = item.target?.member ? bridge.display_name(item.target.member) : "";
  const ratio = inline_ratio(item.numerator, item.denominator);
  switch (item.rule) {
    case "failure_cluster":
      return t("「{room}」中 {member} 的「{kind}」失败集中出现：{ratio}", { room, member, kind: failure_class_label(item.params?.failure_class || ""), ratio });
    case "permission_denial":
      return t("「{room}」中 {member} 多次触发权限拦截：{ratio}，可按需调整项目权限", { room, member, ratio });
    case "late_recovery":
      return t("「{room}」中 {member} 出现失败后迟到补交：{ratio}，可能存在超时误判", { room, member, ratio });
    case "scheduler_feedback":
      return t("「{room}」的智能调度收到较多负评：{ratio}", { room, ratio });
    default:
      return t("「{room}」触发异常规则 {rule}：{ratio}", { room, rule: item.rule, ratio });
  }
}

const INSIGHT_ICONS = {
  failure_cluster: "i-lucide-circle-alert",
  permission_denial: "i-lucide-shield-alert",
  late_recovery: "i-lucide-clock-alert",
  scheduler_feedback: "i-lucide-thumbs-down",
};

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

/**
 * Share of runs per model across software and effort (claude-opus-5-5 at medium and at high are one model): the six
 * largest keep a colour slot and the rest fold into “其他”. Weights sum to 1 so the bar grows with the grow spring.
 */
const model_mix = computed(() => {
  const by_model = new Map();
  for (const row of model_rows.value) {
    const key = row.model || `?${row.adapter}`;
    const item = by_model.get(key) || { key, label: row.model || t("{software} · 未知模型", { software: adapter_display_label(row.adapter) }), runs: 0 };
    item.runs += row.executions;
    by_model.set(key, item);
  }
  const sorted = [...by_model.values()].filter((item) => item.runs).sort((a, b) => b.runs - a.runs);
  const total = sorted.reduce((sum, item) => sum + item.runs, 0) || 1;
  const head = sorted.slice(0, FOLDER_SLOTS).map((item, index) => ({ ...item, slot: index + 1 }));
  const rest = sorted.slice(FOLDER_SLOTS);
  if (rest.length) head.push({ key: "__other__", label: t("其他 {count} 个模型", { count: rest.length }), runs: rest.reduce((sum, item) => sum + item.runs, 0), slot: 0 });
  return head.map((item) => ({ ...item, share: (item.runs / total) * 100, weight: item.runs / total }));
});
const model_slot = computed(() => new Map(model_mix.value.filter((item) => item.slot).map((item) => [item.key, item.slot])));
const row_slot = (row) => model_slot.value.get(row.model || `?${row.adapter}`) ?? 0;

// Workflows: the backend reports IDs; names come from this computer's workflow library when it has the workflow.
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
const visible_models = computed(() => (members_expanded.value ? model_rows.value : model_rows.value.slice(0, MEMBER_PREVIEW)));

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
            <span v-if="date_range_label">{{ date_range_label }}</span>
            <span v-if="prev_range_label" class="analytics-dim">{{ t("对比上期：{range}", { range: prev_range_label }) }}</span>
          </p>
        </div>
        <div class="analytics-controls">
          <div class="analytics-segmented" role="group" :aria-label="t('统计周期')">
            <button v-for="item in PRESETS" :key="item.value" type="button" :aria-pressed="preset === item.value" @click="preset = item.value">{{ item.label }}</button>
          </div>
          <UTooltip :text="t('刷新统计')">
            <UButton icon="i-lucide-refresh-cw" size="sm" color="neutral" variant="ghost" :aria-label="t('刷新统计')" :loading="loading && Boolean(report)" @click="load(true)" />
          </UTooltip>
          <button type="button" class="analytics-share-button" :title="t('生成分享图')" :aria-label="t('生成分享图')" :disabled="!report" @click="share_open = true">
            <UIcon name="i-lucide-image" /><span>{{ t("生成分享图") }}</span>
          </button>
        </div>
      </header>

      <div v-if="loading && !report" class="analytics-skeleton" role="status" :aria-label="t('正在加载统计…')">
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
        <!-- Hero: the one number the page is about, the chart that explains it, and the three facts that show the team's size. -->
        <section class="analytics-hero" :class="{ 'is-compact': !daily.length }" :style="block_style(0)">
          <div class="analytics-hero-main">
            <div class="analytics-eyebrow">{{ t("免介入率") }}</div>
            <div class="analytics-hero-number">
              <strong>{{ hero_text }}</strong>
              <span v-if="unassisted_delta !== null" class="analytics-delta" :class="unassisted_delta > 0 ? 'is-up' : unassisted_delta < 0 ? 'is-down' : ''">
                <UIcon :name="unassisted_delta > 0 ? 'i-lucide-arrow-up-right' : unassisted_delta < 0 ? 'i-lucide-arrow-down-right' : 'i-lucide-minus'" />
                {{ unassisted_delta ? t("较上期 {diff} 个百分点", { diff: Math.abs(unassisted_delta) }) : t("与上期持平") }}
              </span>
            </div>
            <p class="analytics-hero-sentence">
              <template v-if="overview.ended > 0">{{ t("已结束的 {total} 个任务中，{count} 个你没有再停止、撤回或回退", { count: overview.unassisted, total: overview.ended }) }}</template>
              <template v-else>{{ t("这段时间还没有已结束的任务") }}</template>
            </p>
            <p v-if="overview.ended > 0 && !unassisted.has_percent" class="analytics-dim analytics-small">{{ t("任务不足 10 个，只显示个数") }}</p>

            <div v-if="daily.length" class="analytics-daily" :aria-label="t('每日发起的已结束任务')">
              <div class="analytics-daily-head">
                <span class="analytics-legend-inline">
                  <span><i class="analytics-key is-alone" />{{ t("没再插手") }}</span>
                  <span><i class="analytics-key is-stepped" />{{ t("插手过") }}</span>
                </span>
                <span v-if="hovered_day >= 0" class="analytics-daily-readout">
                  {{ t("{date}：当天发起的任务中已结束 {ended} 个，插手 {count} 个", { date: daily[hovered_day].full, ended: daily[hovered_day].ended, count: daily[hovered_day].stepped_in }) }}
                </span>
                <span v-else class="analytics-dim">{{ t("每日发起的已结束任务") }}</span>
              </div>
              <div class="analytics-daily-plot" @mouseleave="hovered_day = -1">
                <div
                  v-for="(day, index) in daily"
                  :key="day.date"
                  class="analytics-daily-col"
                  :class="{ 'is-hover': hovered_day === index }"
                  @mouseenter="hovered_day = index"
                >
                  <div class="analytics-daily-bar" :style="{ height: bar_height(day, index) }">
                    <i class="is-stepped" :style="{ flexGrow: 100 - day.alone_share, minHeight: day.stepped_in ? '3px' : 0 }" />
                    <i class="is-alone" :style="{ flexGrow: day.alone_share }" />
                  </div>
                  <span class="analytics-daily-label">{{ day.show_label ? day.label : "" }}</span>
                </div>
              </div>
            </div>
          </div>

          <div class="analytics-hero-side">
            <article class="analytics-stat">
              <div class="analytics-eyebrow">{{ t("发起") }}</div>
              <div class="analytics-stat-number">
                <strong>{{ Math.round(started_count.value.value) }}</strong>
                <span v-if="initiated_delta !== null" class="analytics-dim">{{ t("较上期 {diff}", { diff: initiated_delta >= 0 ? `+${initiated_delta}` : initiated_delta }) }}</span>
              </div>
              <div class="analytics-meter" aria-hidden="true"><i :style="{ width: `${answered_percent * grow.value.value}%` }" /></div>
              <p>{{ t("其中 {count} 次已获回复", { count: overview.answered }) }}</p>
            </article>
            <article class="analytics-stat">
              <div class="analytics-eyebrow">
                {{ t("同时并行峰值") }}
                <UPopover :content="{ side: 'top' }"><button type="button" class="analytics-info" :aria-label="t('统计口径')"><UIcon name="i-lucide-info" /></button><template #content><p class="analytics-popover">{{ t('同一时刻最多有几个房间、几位专家在运行。同一房间几位成员同时运行只算一个房间，专家则每位各算一位。') }}</p></template></UPopover>
              </div>
              <div class="analytics-peak-pair">
                <div class="analytics-stat-number"><strong>{{ Math.round(peak_rooms.value.value) }}</strong><span class="analytics-dim">{{ t("个房间") }}</span></div>
                <div class="analytics-stat-number"><strong>{{ Math.round(peak_members.value.value) }}</strong><span class="analytics-dim">{{ t("位专家") }}</span></div>
              </div>
              <p v-if="peak.members_at" class="analytics-dim">{{ t("专家峰值出现于 {time}", { time: format_timestamp(peak.members_at, report.range?.tz) }) }}</p>
            </article>
            <article class="analytics-stat">
              <div class="analytics-eyebrow">
                {{ t("AI 执行总时长") }}
                <UPopover :content="{ side: 'top' }"><button type="button" class="analytics-info" :aria-label="t('统计口径')"><UIcon name="i-lucide-info" /></button><template #content><p class="analytics-popover">{{ t('各成员执行时长相加，几位同时运行时会超过实际经过的时间。') }}</p></template></UPopover>
              </div>
              <div class="analytics-stat-number"><strong>{{ format_duration(execution_total.value.value) }}</strong></div>
            </article>
          </div>
        </section>

        <section class="analytics-block" :style="block_style(1)">
          <div class="analytics-block-head">
            <h2>{{ t("值得留意") }}
              <UPopover :content="{ side: 'top' }"><button type="button" class="analytics-info" :aria-label="t('统计口径')"><UIcon name="i-lucide-info" /></button><template #content><p class="analytics-popover">{{ t('按固定规则挑出的异常：至少 10 次运行里出现 3 次以上才会列出。') }}</p></template></UPopover>
            </h2>
          </div>
          <ul v-if="report.insights?.length" class="analytics-insights">
            <li v-for="(item, idx) in report.insights" :key="`${item.rule}-${idx}`">
              <button type="button" @click="open_room(item.target?.room_id)">
                <UIcon :name="INSIGHT_ICONS[item.rule] || 'i-lucide-sparkles'" class="analytics-insight-icon" />
                <span>{{ insight_text(item) }}</span>
                <UIcon name="i-lucide-arrow-up-right" class="analytics-insight-jump" aria-hidden="true" />
              </button>
            </li>
          </ul>
          <p v-else class="analytics-calm"><UIcon name="i-lucide-circle-check" />{{ t("这段时间没有需要留意的异常。") }}</p>
        </section>

        <section class="analytics-block" :style="block_style(2)">
          <div class="analytics-block-head">
            <h2>{{ t("时间去哪了") }}
              <UPopover :content="{ side: 'top' }"><button type="button" class="analytics-info" :aria-label="t('统计口径')"><UIcon name="i-lucide-info" /></button><template #content><p class="analytics-popover">{{ t('按房间当前所在的文件夹统计；几位成员同时运行的时间分别计入。') }}</p></template></UPopover>
            </h2>
          </div>
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
        </section>

        <section class="analytics-block" :style="block_style(3)">
          <div class="analytics-block-head">
            <h2>{{ t("成员成绩单") }}
              <UPopover :content="{ side: 'top' }"><button type="button" class="analytics-info" :aria-label="t('统计口径')"><UIcon name="i-lucide-info" /></button><template #content><p class="analytics-popover">{{ t('按软件、模型与强度汇总所有房间，按运行次数排列，不评名次。') }}</p></template></UPopover>
            </h2>
          </div>
          <div v-if="model_rows.length" class="analytics-panel analytics-table-wrap">
            <div class="analytics-mix">
              <div class="analytics-mix-head"><span>{{ t("各模型调用占比") }}</span><span class="analytics-dim">{{ t("按运行次数") }}</span></div>
              <div class="analytics-stack" role="img" :aria-label="t('各模型调用占比')">
                <i v-for="(item, index) in model_mix" :key="item.key" :class="`slot-${item.slot}`" :style="{ flexGrow: item.weight * wave(grow.value.value, index, model_mix.length, 0.4) }" :title="`${item.label} · ${share_text(item.share)}`" />
              </div>
              <ul class="analytics-mix-legend">
                <li v-for="item in model_mix" :key="item.key">
                  <span class="analytics-swatch" :class="`slot-${item.slot}`" /><span class="analytics-mix-name">{{ item.label }}</span>
                  <strong class="num">{{ share_text(item.share) }}</strong>
                </li>
              </ul>
            </div>
            <table class="analytics-table">
              <thead>
                <tr>
                  <th>{{ t("成员") }}</th>
                  <th class="num"><UPopover :content="{ side: 'top' }"><button type="button" class="analytics-hint">{{ t("运行") }}</button><template #content><p class="analytics-popover">{{ t('成员每运行一次算一次，一次运行可能同时处理几条消息。') }}</p></template></UPopover></th>
                  <th class="num">{{ t("占比") }}</th>
                  <th>{{ t("完成率") }}</th>
                  <th><UPopover :content="{ side: 'top' }"><button type="button" class="analytics-hint">{{ t("耗时（通常 · 较慢）") }}</button><template #content><p class="analytics-popover">{{ t('一半的运行在“通常”以内结束，九成在“较慢”以内结束。') }}</p></template></UPopover></th>
                  <th class="num">{{ t("打断 / 重试") }}</th>
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
                  <td class="num"><span class="analytics-swatch" :class="`slot-${row_slot(row)}`" />{{ share_text(row.run_share) }}</td>
                  <td>
                    <div class="analytics-rate">
                      <div v-if="completion(row).width !== null" class="analytics-meter" aria-hidden="true"><i :style="{ width: `${completion(row).width * grow.value.value}%` }" /></div>
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
        </section>

        <section class="analytics-block" :style="block_style(4)">
          <div class="analytics-block-head">
            <h2>{{ t("工作流") }}
              <UPopover :content="{ side: 'top' }"><button type="button" class="analytics-info" :aria-label="t('统计口径')"><UIcon name="i-lucide-info" /></button><template #content><p class="analytics-popover">{{ t("按房间启用的工作流统计成员的运行；卡片是这次运行所扮演的角色，子工作流是被调用的分支流程。只含现存房间。") }}</p></template></UPopover>
            </h2>
          </div>
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
        </section>

        <section class="analytics-block" :style="block_style(5)">
          <details class="analytics-panel analytics-friction" :open="blockers_open" @toggle="blockers_open = $event.target.open">
            <summary>
              <h2><UIcon :name="blockers_open ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" />{{ t("耗时与卡点") }}</h2>
              <span class="analytics-dim">
                {{ t("交付通常 {duration}", { duration: format_duration(overview.delivery?.p50) }) }} ·
                {{ t("纠正 {count} 次", { count: correction_total }) }} ·
                {{ t("当前排队 {count} 条", { count: queue_info.count || 0 }) }}
              </span>
            </summary>
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
                <div><span>{{ t("停止与打断") }}</span><strong>{{ corrections.stops || 0 }}</strong></div>
                <div><span>{{ t("撤回消息") }}</span><strong>{{ corrections.withdrawals || 0 }}</strong></div>
                <div><span>{{ t("回退对话") }}</span><strong>{{ corrections.rewinds || 0 }}</strong><small>{{ t("影响 {count} 条请求", { count: corrections.affected_requests || 0 }) }}</small></div>
                <div class="is-neutral"><span>{{ t("追加插话") }}</span><strong>{{ additions.interjections || 0 }}</strong><small>{{ t("不计入介入") }}</small></div>
                <div class="is-neutral"><span>{{ t("当前排队") }}</span><strong>{{ queue_info.count || 0 }}</strong><small v-if="queue_info.count">{{ t("最久已等 {duration}", { duration: format_duration(queue_info.oldest_seconds) }) }}</small></div>
              </div>
            </div>
          </details>
        </section>

        <footer class="analytics-foot" :style="block_style(6)">
          <span>{{ scope_text }}</span>
          <button v-if="report.scope?.sealed_rooms || scope === 'current'" type="button" class="analytics-scope-toggle" @click="scope = scope === 'all' ? 'current' : 'all'">
            {{ scope === "all" ? t("只看现存房间") : t("包含已删除房间") }}
          </button>
          <span>{{ t("时区：{tz}", { tz: report.range?.tz || tz }) }}</span>
          <span v-if="report.scope?.mode === 'all' && report.scope?.sealed_rooms">{{ t("并行峰值、文件夹、成员、工作流、洞察只含现存房间") }}</span>
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

/* Hero */
.analytics-hero { display: grid; grid-template-columns: minmax(0, 1.55fr) minmax(0, 1fr); border: 1px solid var(--ui-border-muted); border-radius: 14px; background: var(--ui-bg-elevated); overflow: hidden; }
.analytics-hero-main { display: grid; align-content: start; gap: 8px; padding: 24px 26px 20px; }
.analytics-hero-number { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 14px; }
.analytics-hero-number strong { font-size: 60px; line-height: 1; font-weight: 700; letter-spacing: -.03em; color: var(--ui-text-highlighted); font-variant-numeric: tabular-nums; }
.analytics-delta { display: inline-flex; align-items: center; gap: 3px; padding: 2px 8px 2px 6px; border-radius: 999px; background: color-mix(in srgb, var(--ui-text) 6%, transparent); color: var(--ui-text-toned); font-size: 12px; font-variant-numeric: tabular-nums; }
.analytics-delta.is-up { color: var(--viz-up); background: color-mix(in srgb, var(--viz-up) 12%, transparent); }
.analytics-delta.is-down { color: var(--viz-down); background: color-mix(in srgb, var(--viz-down) 12%, transparent); }
.analytics-delta :deep([class*="icon"]) { width: 13px; height: 13px; }
.analytics-hero-sentence { margin: 2px 0 0; max-width: 46ch; font-size: 14px; line-height: 1.55; color: var(--ui-text-toned); }

.analytics-daily { display: grid; gap: 8px; margin-top: 14px; padding-bottom: 18px; }
.analytics-daily-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; min-height: 18px; font-size: 12px; color: var(--ui-text-muted); }
.analytics-daily-readout { color: var(--ui-text-highlighted); font-variant-numeric: tabular-nums; }
.analytics-legend-inline { display: inline-flex; gap: 14px; }
.analytics-legend-inline > span { display: inline-flex; align-items: center; gap: 6px; }
.analytics-key { display: inline-block; width: 9px; height: 9px; border-radius: 3px; }
.analytics-key.is-alone, .analytics-daily-bar .is-alone { background: color-mix(in srgb, var(--channel-accent) 80%, transparent); }
.analytics-key.is-stepped, .analytics-daily-bar .is-stepped { background: var(--viz-2); }
.analytics-daily-plot { display: flex; align-items: stretch; gap: 3px; height: 96px; border-bottom: 1px solid var(--ui-border); }
.analytics-daily-col { position: relative; flex: 1; display: flex; flex-direction: column; justify-content: flex-end; align-items: center; min-width: 0; cursor: default; }
.analytics-daily-col::before { content: ""; position: absolute; inset: 0 -1.5px; border-radius: 4px; }
.analytics-daily-col.is-hover::before { background: color-mix(in srgb, var(--ui-text) 5%, transparent); }
.analytics-daily-bar { position: relative; display: flex; flex-direction: column; gap: 0; width: 100%; max-width: 40px; border-radius: 4px 4px 0 0; overflow: hidden; }
.analytics-daily-bar i { display: block; min-height: 0; flex-basis: 0; }
.analytics-daily-bar .is-stepped + .is-alone { box-shadow: 0 -2px 0 var(--ui-bg-elevated); }
.analytics-daily-col.is-hover .analytics-daily-bar { filter: brightness(1.12); }
.analytics-daily-label { position: absolute; top: calc(100% + 5px); left: 50%; transform: translateX(-50%); font-size: 11px; color: var(--ui-text-dimmed); white-space: nowrap; }

.analytics-hero-side { display: grid; grid-template-rows: repeat(3, auto); align-content: stretch; border-left: 1px solid var(--ui-border-muted); background: color-mix(in srgb, var(--ui-text) 2%, transparent); }
.analytics-stat { display: grid; align-content: center; gap: 7px; padding: 18px 24px; }
.analytics-stat + .analytics-stat { border-top: 1px solid var(--ui-border-muted); }
.analytics-stat p { margin: 0; font-size: 12.5px; color: var(--ui-text-toned); font-variant-numeric: tabular-nums; }
.analytics-stat-number { display: flex; align-items: baseline; gap: 8px; }
.analytics-stat-number strong { font-size: 28px; line-height: 1.1; font-weight: 650; letter-spacing: -.02em; color: var(--ui-text-highlighted); font-variant-numeric: tabular-nums; }
.analytics-stat-number span { font-size: 13px; font-variant-numeric: tabular-nums; }
.analytics-peak-pair { display: flex; flex-wrap: wrap; gap: 4px 22px; }
.analytics-meter { height: 4px; border-radius: 999px; background: color-mix(in srgb, var(--ui-text) 9%, transparent); overflow: hidden; }
.analytics-meter i { display: block; height: 100%; border-radius: 999px; background: var(--channel-accent); }

/* Today has no daily chart: the number takes one row and the three facts sit beside each other under it. */
.analytics-hero.is-compact { grid-template-columns: minmax(0, 1fr); }
.analytics-hero.is-compact .analytics-hero-side { grid-template-rows: none; grid-template-columns: repeat(3, minmax(0, 1fr)); border-left: 0; border-top: 1px solid var(--ui-border-muted); }
.analytics-hero.is-compact .analytics-stat + .analytics-stat { border-top: 0; border-left: 1px solid var(--ui-border-muted); }

/* Section blocks */
.analytics-block { display: grid; gap: 12px; }
.analytics-block-head h2 { display: flex; align-items: center; gap: 6px; margin: 0; font-size: 15px; font-weight: 600; color: var(--ui-text-highlighted); }
.analytics-panel { border: 1px solid var(--ui-border-muted); border-radius: 12px; background: var(--ui-bg-elevated); padding: 18px 20px; }

.analytics-insights { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.analytics-insights button { width: 100%; display: flex; align-items: center; gap: 10px; padding: 10px 14px; border: 1px solid var(--ui-border-muted); border-radius: 10px; background: var(--ui-bg-elevated); color: var(--ui-text); font-size: 13px; text-align: left; }
.analytics-insights button:hover { border-color: var(--ui-border-accented); }
.analytics-insights button > span { flex: 1; min-width: 0; }
.analytics-insight-icon { width: 16px; height: 16px; flex-shrink: 0; color: var(--ui-warning); }
.analytics-insight-jump { width: 14px; height: 14px; flex-shrink: 0; color: var(--ui-text-dimmed); }
.analytics-calm { display: flex; align-items: center; gap: 8px; margin: 0; padding: 10px 14px; border: 1px dashed var(--ui-border); border-radius: 10px; font-size: 13px; color: var(--ui-text-muted); }
.analytics-calm :deep([class*="icon"]) { width: 15px; height: 15px; color: var(--viz-up); }

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
.analytics-mix-legend { display: flex; flex-wrap: wrap; gap: 6px 20px; margin: 0; padding: 0; list-style: none; font-size: 12.5px; color: var(--ui-text); }
.analytics-mix-legend li { display: inline-flex; align-items: center; min-width: 0; }
.analytics-mix-name { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.analytics-meter-wide { height: 6px; }
.analytics-chip { display: inline-flex; align-items: center; gap: 3px; margin: 1px 4px 1px 0; padding: 1px 7px; border-radius: 999px; background: color-mix(in srgb, var(--ui-text) 7%, transparent); color: var(--ui-text-toned); font-size: 11px; white-space: nowrap; }
.analytics-chip.is-sub { background: color-mix(in srgb, var(--channel-accent) 14%, transparent); color: var(--ui-text-highlighted); }
.analytics-chip :deep([class*="icon"]) { width: 11px; height: 11px; }
.analytics-calm-plain :deep([class*="icon"]) { color: var(--ui-text-dimmed); }
.analytics-mix-legend strong { margin-left: 8px; font-weight: 600; color: var(--ui-text-highlighted); }
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
.analytics-friction summary { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 6px 14px; padding: 14px 20px; cursor: pointer; list-style: none; }
.analytics-friction summary::-webkit-details-marker { display: none; }
.analytics-friction h2 { display: flex; align-items: center; gap: 6px; margin: 0; font-size: 15px; font-weight: 600; color: var(--ui-text-highlighted); }
.analytics-friction summary > span { font-size: 12px; font-variant-numeric: tabular-nums; }
.analytics-friction-body { display: grid; gap: 20px; padding: 6px 20px 20px; border-top: 1px solid var(--ui-border-muted); }
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
  .analytics-hero { grid-template-columns: minmax(0, 1fr); }
  .analytics-hero-side { grid-template-rows: none; grid-template-columns: repeat(3, minmax(0, 1fr)); border-left: 0; border-top: 1px solid var(--ui-border-muted); }
  .analytics-stat + .analytics-stat { border-top: 0; border-left: 1px solid var(--ui-border-muted); }
  .analytics-segment { grid-template-columns: minmax(0, 1fr); gap: 6px; }
  .analytics-segment-values { justify-content: flex-start; }
  .analytics-tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 600px) {
  .analytics-hero-main { padding: 20px 18px 16px; }
  .analytics-hero-number strong { font-size: 48px; }
  .analytics-hero-side, .analytics-hero.is-compact .analytics-hero-side { grid-template-columns: minmax(0, 1fr); }
  .analytics-stat + .analytics-stat, .analytics-hero.is-compact .analytics-stat + .analytics-stat { border-left: 0; border-top: 1px solid var(--ui-border-muted); }
  .analytics-panel { padding: 16px; }
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
  .analytics-table:not(.is-workflow) :is(th, td):nth-child(n+5) { display: none; }
  .analytics-table.is-workflow :is(th, td):is(:nth-child(3), :nth-child(5), :nth-child(6)) { display: none; }
  .analytics-table.is-workflow td:last-child { white-space: normal; }
  .analytics-mix { padding: 12px 14px 14px; }
  .analytics-mix-legend { gap: 4px 14px; font-size: 12px; }
  .analytics-mix-name { max-width: 150px; }
  /* The folded friction block is a one-line summary, not a card: title and figures stack tightly. */
  .analytics-panel.analytics-friction { padding: 0; }
  .analytics-friction summary { display: grid; gap: 2px; padding: 11px 14px; }
  .analytics-friction h2 { font-size: 14px; }
  .analytics-friction summary > span { padding-left: 20px; font-size: 11.5px; }
  .analytics-friction-body { gap: 14px; padding: 4px 14px 14px; }
  .analytics-segment { padding: 6px 0; }
  .analytics-segment-values { flex-wrap: wrap; gap: 4px 12px; }
  .analytics-tiles { gap: 8px; }
  .analytics-tiles > div { padding: 10px 12px; }
  .analytics-tiles strong { font-size: 19px; }
  .analytics-calm { padding: 9px 12px; font-size: 12.5px; }
  .analytics-foot { gap: 2px 12px; }
}
</style>

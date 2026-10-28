<script setup>
/**
 * The execution timeline: every execution the local service woke, on one time axis, nested under the execution that
 * dispatched it, with the phases the runner saw its software go through. Read on its own schedule while the page is
 * open, since phase reports wake no other page.
 */
import { computed, inject, onBeforeUnmount, ref, watch } from "vue";
import { FOLD_GAP_MS, PHASE_LABELS, STATE_LABELS, format_duration, timeline_axis, timeline_rows, timeline_summary } from "./timeline-model.js";

const { view, bridge } = inject("discussion");
const REFRESH_MS = 5000;
const room_id = computed(() => view.value.room?.id);
const timeline = ref(null);
const error = ref("");
const now = ref(Date.now());
const collapsed = ref(new Set());
let refresh_timer = 0;
let clock_timer = 0;

/** Read the room's timeline; a failed read keeps what was shown and says so. */
async function load() {
  const id = room_id.value;
  if (!id) return;
  try {
    const result = await bridge.request(`/api/rooms/${id}/timeline`);
    if (id !== room_id.value) return;
    timeline.value = result;
    error.value = "";
  } catch (failure) {
    error.value = `读取执行记录失败：${failure.message}`;
  }
}

const running = computed(() => timeline.value?.executions.some((item) => item.state === "running"));
// Only a running execution changes; a settled timeline is read once.
watch(running, (live) => {
  clearInterval(refresh_timer);
  clearInterval(clock_timer);
  if (!live) return;
  refresh_timer = setInterval(load, REFRESH_MS);
  clock_timer = setInterval(() => { now.value = Date.now(); }, 1000);
}, { immediate: true });
watch(room_id, () => { timeline.value = null; collapsed.value = new Set(); load(); }, { immediate: true });
onBeforeUnmount(() => { clearInterval(refresh_timer); clearInterval(clock_timer); });

const all_rows = computed(() => timeline.value ? timeline_rows(timeline.value, now.value) : []);
const rows = computed(() => all_rows.value.filter((row) => !row.ancestors.some((key) => collapsed.value.has(key))));
const axis = computed(() => timeline_axis(all_rows.value));
const summary = computed(() => timeline_summary(all_rows.value));
const LEGEND = [["queue", "排队"], ["wake", "唤醒"], ["work", "执行（无阶段明细）"], ...Object.entries(PHASE_LABELS)];

function toggle(key) {
  const next = new Set(collapsed.value);
  next.has(key) ? next.delete(key) : next.add(key);
  collapsed.value = next;
}

/** A bar piece's position on the axis, as percentages. */
function place(start, end) {
  const from = axis.value.x(start);
  return { left: `${from * 100}%`, width: `${Math.max(0, axis.value.x(end) - from) * 100}%` };
}

function role_label(row) {
  const host = row.item.role === "host";
  return row.item.source === "discussion" ? (host ? "讨论 · 主持" : "讨论 · 专家") : (host ? "协作 · 主持" : "协作");
}

function segment_title(segment) {
  return `${PHASE_LABELS[segment.phase]}${segment.tool ? ` · ${segment.tool}` : ""} · ${format_duration(segment.end - segment.start)}`;
}

function row_label(row) {
  const parts = [bridge.display_name(row.item.member), role_label(row), STATE_LABELS[row.item.state], `用时 ${format_duration(row.end - row.start)}`];
  if (row.wake) parts.push(`唤醒 ${format_duration(row.wake[1] - row.wake[0])}${row.wake_approx ? "（约）" : ""}`);
  if (!row.segments.length && row.work) parts.push("无阶段明细");
  return parts.join("，");
}

const when = (ms) => new Date(ms).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
</script>

<template>
  <section class="merged-section execution-timeline" aria-label="执行时间线">
    <div class="page-heading"><div><h2>执行时间线</h2><p>本机接入程序唤醒的每次执行，按时间排在同一条轴上；由主持人派出的执行缩进在主持人之下。阶段由接入程序从软件输出中识别，手动接入、在线 AI 与 Codex App 没有阶段明细。</p></div></div>
    <p v-if="error" role="alert" class="fine-print timeline-error">{{ error }}</p>
    <p v-if="timeline && !all_rows.length" class="fine-print">还没有执行记录。</p>
    <template v-if="all_rows.length">
      <dl class="timeline-summary">
        <div><dt>执行</dt><dd>{{ summary.executions }}<small v-if="summary.running"> · {{ summary.running }} 进行中</small></dd></div>
        <div><dt>失败</dt><dd :class="{ 'is-failed': summary.failed }">{{ summary.failed }}</dd></div>
        <div><dt>有效时长</dt><dd :title="axis.folds.length ? `已折叠 ${axis.folds.length} 段超过 ${FOLD_GAP_MS / 60000} 分钟的空闲` : undefined">{{ format_duration(axis.busy_ms) }}</dd></div>
        <div><dt>工具与命令</dt><dd title="连续调用同一工具合并为一段">{{ summary.tool_segments }} 段</dd></div>
        <div v-if="summary.slowest" class="timeline-slowest"><dt>最慢一步</dt><dd>{{ bridge.display_name(summary.slowest.member) }} · {{ PHASE_LABELS[summary.slowest.phase] }}<template v-if="summary.slowest.tool"> {{ summary.slowest.tool }}</template> · {{ format_duration(summary.slowest.end - summary.slowest.start) }}</dd></div>
      </dl>
      <ul class="timeline-legend" aria-label="图例">
        <li v-for="[key, label] in LEGEND" :key="key"><i :class="`is-${key}`"></i>{{ label }}</li>
        <li><i class="is-failed"></i>失败</li>
      </ul>
      <div class="timeline-grid" role="list">
        <span aria-hidden="true"></span>
        <div class="timeline-scale" aria-hidden="true">
          <span>{{ when(axis.start) }}</span><span>{{ running ? '现在' : when(axis.end) }}</span>
        </div>
        <span aria-hidden="true"></span>
        <div v-for="row in rows" :key="row.key" role="listitem" class="timeline-row" :class="[`is-${row.item.state}`, { 'is-slowest': summary.slowest?.row === row.key }]">
          <div class="timeline-who" :style="{ paddingLeft: `${row.depth * 16}px` }">
            <button v-if="row.has_children" type="button" class="timeline-toggle" :aria-expanded="!collapsed.has(row.key)"
              :aria-label="`${collapsed.has(row.key) ? '展开' : '收起'} ${bridge.display_name(row.item.member)} 派出的执行`" @click="toggle(row.key)">
              <UIcon :name="collapsed.has(row.key) ? 'i-lucide-chevron-right' : 'i-lucide-chevron-down'" />
            </button>
            <span v-else class="timeline-toggle-space"></span>
            <UAvatar :src="bridge.identities[row.item.member]?.icon" :text="bridge.identities[row.item.member]?.initials" :alt="row.item.member" size="2xs" class="channel-avatar" :class="bridge.identities[row.item.member]?.style" />
            <span class="timeline-name"><strong>{{ bridge.display_name(row.item.member) }}</strong><small>{{ role_label(row) }}</small></span>
          </div>
          <div class="timeline-track" role="img" :aria-label="row_label(row)" :title="row.item.reason || undefined">
            <i v-for="fold in axis.folds" :key="fold.start" class="timeline-fold" :style="{ left: `${fold.from * 100}%`, width: `${fold.width * 100}%` }"></i>
            <i class="timeline-piece is-queue" :style="place(...row.queue)" :title="`排队 · ${format_duration(row.queue[1] - row.queue[0])}`"></i>
            <i v-if="row.wake" class="timeline-piece is-wake" :style="place(...row.wake)" :title="`唤醒 · ${format_duration(row.wake[1] - row.wake[0])}${row.wake_approx ? '（约）' : ''}`"></i>
            <i v-if="row.work" class="timeline-piece is-work" :class="{ 'has-detail': row.segments.length }" :style="place(...row.work)"
              :title="row.segments.length ? undefined : `执行 · ${format_duration(row.work[1] - row.work[0])} · 无阶段明细`"></i>
            <i v-for="segment in row.segments" :key="segment.start + segment.phase" class="timeline-piece timeline-segment" :class="`is-${segment.phase}`"
              :style="place(segment.start, segment.end)" :title="segment_title(segment)"></i>
          </div>
          <span class="timeline-duration">{{ format_duration(row.end - row.start) }}<small v-if="row.item.state !== 'done'" :class="`is-${row.item.state}`">{{ STATE_LABELS[row.item.state] }}</small><small v-if="row.truncated">明细已截断</small></span>
        </div>
      </div>
      <p v-if="timeline.executions.length >= timeline.execution_limit" class="fine-print">只列出最近 {{ timeline.execution_limit }} 次讨论执行与 {{ timeline.execution_limit }} 次协作执行。</p>
    </template>
  </section>
</template>

<style scoped>
.timeline-error { color: var(--ui-error); }
.timeline-summary { display: flex; flex-wrap: wrap; gap: 10px 28px; margin: 0 0 14px; }
.timeline-summary dt { color: var(--ui-text-muted); font-size: 12px; }
.timeline-summary dd { margin: 2px 0 0; color: var(--ui-text-highlighted); font-size: 15px; font-weight: 600; font-variant-numeric: tabular-nums; }
.timeline-summary dd small { color: var(--ui-text-muted); font-size: 12px; font-weight: 400; }
.timeline-summary dd.is-failed { color: var(--ui-error); }
.timeline-slowest dd { font-size: 13px; }
.timeline-legend { display: flex; flex-wrap: wrap; gap: 6px 14px; margin: 0 0 12px; padding: 0; color: var(--ui-text-muted); font-size: 12px; list-style: none; }
.timeline-legend li { display: inline-flex; align-items: center; gap: 5px; }
.timeline-legend i { width: 10px; height: 8px; border-radius: 2px; }
.timeline-legend i.is-failed { background: transparent; box-shadow: inset 0 0 0 1.5px var(--ui-error); }
.timeline-grid { display: grid; grid-template-columns: minmax(150px, 220px) minmax(0, 1fr) 76px; column-gap: 12px; }
.timeline-scale { display: flex; grid-column: 2; justify-content: space-between; margin-bottom: 4px; color: var(--ui-text-dimmed); font-size: 11px; font-variant-numeric: tabular-nums; }
.timeline-row { display: contents; }
.timeline-row > * { min-height: 34px; border-top: 1px solid var(--ui-border); }
.timeline-who { display: flex; align-items: center; gap: 6px; min-width: 0; }
.timeline-toggle, .timeline-toggle-space { display: inline-flex; flex: none; align-items: center; justify-content: center; width: 16px; height: 16px; padding: 0; border: 0; background: none; color: var(--ui-text-muted); cursor: pointer; }
.timeline-name { display: flex; flex-direction: column; min-width: 0; line-height: 1.25; }
.timeline-name strong, .timeline-name small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.timeline-name strong { color: var(--ui-text-highlighted); font-size: 13px; font-weight: 600; }
.timeline-name small { color: var(--ui-text-muted); font-size: 11px; }
.timeline-track { position: relative; align-self: stretch; }
.timeline-track > i { position: absolute; top: 50%; display: block; }
.timeline-fold { top: 0 !important; bottom: 0; background: repeating-linear-gradient(135deg, transparent 0 4px, var(--ui-border) 4px 5px); opacity: .7; }
.timeline-piece { min-width: 2px; height: 10px; border-radius: 2px; transform: translateY(-50%); }
.timeline-segment { height: 14px; }
.timeline-duration { display: flex; flex-direction: column; justify-content: center; align-items: flex-end; color: var(--ui-text); font-size: 12px; font-variant-numeric: tabular-nums; line-height: 1.25; }
.timeline-duration small { color: var(--ui-text-muted); font-size: 11px; }
.timeline-duration small.is-failed { color: var(--ui-error); }
.timeline-duration small.is-running { color: var(--channel-accent); }
.is-failed .timeline-piece.is-work { box-shadow: inset 0 0 0 1.5px var(--ui-error); }
.is-running .timeline-piece.is-work { animation: timeline-live 1.6s ease-in-out infinite; }
.is-slowest .timeline-name strong::after { margin-left: 6px; color: #e5a50a; font-size: 11px; font-weight: 400; content: "最慢"; }
/* Queue and wake reuse the progress panel's stage colors, so the two views read the same. */
.is-queue { background: #8b93a7; }
.is-wake { background: #e5a50a; }
.is-work { background: color-mix(in srgb, var(--channel-accent) 70%, transparent); }
.is-work.has-detail { background: color-mix(in srgb, var(--channel-accent) 18%, transparent); }
.is-thinking { background: #8b8ff0; }
.is-command { background: #2f9e6e; }
.is-tool { background: #3b82f6; }
.is-editing { background: #c06ad6; }
.is-writing { background: #14a8a0; }
@keyframes timeline-live { 50% { opacity: .55; } }
@media (prefers-reduced-motion: reduce) { .is-running .timeline-piece.is-work { animation: none; } }
@media (max-width: 640px) {
  .timeline-grid { grid-template-columns: 112px minmax(0, 1fr) 58px; column-gap: 8px; }
}
</style>

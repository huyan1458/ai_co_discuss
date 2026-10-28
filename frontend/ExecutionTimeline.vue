<script setup>
/**
 * The execution timeline: every execution the local service woke, on one time axis, nested under the execution that
 * dispatched it, with the phases the runner saw its software go through and the progress notes it wrote. Phase reports
 * wake no other page, so this page reads on its own: in full when opened, then only what is running or just ended,
 * every two seconds while anything runs and whenever the room changes. Running bars grow ten times a second.
 * The look follows FlowWaterfall (tangle-network/charts): one card, a KPI row, a ticked axis with gridlines, bars on wells.
 */
import { computed, inject, onBeforeUnmount, ref, watch } from "vue";
import { FOLD_GAP_MS, PHASE_LABELS, STALL_MS, STATE_LABELS, axis_ticks, execution_log, format_duration, notes_between, row_status, timeline_axis, timeline_rows, timeline_summary } from "./timeline-model.js";

const emit = defineEmits(["detail"]);
const { view, bridge } = inject("discussion");
const STALL_MINUTES = STALL_MS / 60_000;
const LIVE_REFRESH_MS = 2000;
const FULL_REFRESH_MS = 60_000;
const CLOCK_MS = 100;
// An incremental read also takes executions that ended this long before the previous read, so none slips between reads.
const OVERLAP_SECONDS = 5;
// Each depth level indents a row's label by this much; the guides are drawn at the same pitch.
const DEPTH_PX = 16;
const room_id = computed(() => view.value.room?.id);
const executions = ref(new Map());
const limits = ref(null);
const error = ref("");
const now = ref(Date.now());
const collapsed = ref(new Set());
const note_texts = ref(new Map());
const hover = ref(null);
const opened = ref("");
let last_read = 0;
let last_full = 0;
let reading = false;
let refresh_timer = 0;
let clock_timer = 0;

/** Read the timeline: in full when asked or due, else only executions still running or ended since the last read. */
async function load(full = false) {
  const id = room_id.value;
  if (!id || reading) return;
  reading = true;
  const after = full || !last_read || Date.now() - last_full >= FULL_REFRESH_MS ? 0 : last_read - OVERLAP_SECONDS;
  try {
    const result = await bridge.request(`/api/rooms/${id}/timeline${after ? `?after=${after}` : ""}`);
    if (id !== room_id.value) return;
    const next = after ? new Map(executions.value) : new Map();
    for (const item of result.executions) next.set(`${item.source}:${item.id}`, item);
    executions.value = next;
    limits.value = { execution_limit: result.execution_limit, segment_limit: result.segment_limit };
    last_read = result.now;
    if (!after) last_full = Date.now();
    error.value = "";
  } catch (failure) {
    error.value = `读取执行记录失败：${failure.message}`;
  } finally {
    reading = false;
  }
}

const timeline = computed(() => limits.value && { ...limits.value, executions: [...executions.value.values()] });
const running = computed(() => timeline.value?.executions.some((item) => item.state === "running"));
// Only running work changes the timeline between room changes, and a hidden page need not follow it.
watch(running, (live) => {
  clearInterval(refresh_timer);
  clearInterval(clock_timer);
  if (!live) return;
  refresh_timer = setInterval(() => { if (!document.hidden) load(); }, LIVE_REFRESH_MS);
  clock_timer = setInterval(() => { now.value = Date.now(); }, CLOCK_MS);
}, { immediate: true });
watch(room_id, () => {
  executions.value = new Map(); limits.value = null; collapsed.value = new Set(); note_texts.value = new Map(); hover.value = null; opened.value = "";
  last_read = 0;
  load(true);
}, { immediate: true });
// A new execution, an answer or a failure changes the room; read at once instead of waiting for the next tick.
watch(() => view.value.room, (room, previous) => { if (room?.id && room.id === previous?.id) load(); });
onBeforeUnmount(() => { clearInterval(refresh_timer); clearInterval(clock_timer); });

const all_rows = computed(() => timeline.value ? timeline_rows(timeline.value, now.value) : []);
const rows = computed(() => all_rows.value.filter((row) => !row.ancestors.some((key) => collapsed.value.has(key))));
const axis = computed(() => timeline_axis(all_rows.value));
const ticks = computed(() => axis_ticks(axis.value));
const summary = computed(() => timeline_summary(all_rows.value, now.value));
const parents = computed(() => all_rows.value.filter((row) => row.has_children).map((row) => row.key));
const opened_row = computed(() => all_rows.value.find((row) => row.key === opened.value));
const opened_log = computed(() => opened_row.value ? execution_log(opened_row.value, note_texts.value.get(opened_row.value.item.id)) : []);
const LEGEND = [["queue", "排队"], ["wake", "唤醒"], ["work", "执行（无阶段明细）"], ...Object.entries(PHASE_LABELS)];

/** Open one execution's detail under its row, or close it; its notes are read as it opens and again as more arrive. */
function open_row(row) {
  opened.value = opened.value === row.key ? "" : row.key;
  if (opened.value) note_texts_for(row);
}
watch(() => opened_row.value?.notes.length, () => { if (opened_row.value) note_texts_for(opened_row.value); });

function toggle(key) {
  const next = new Set(collapsed.value);
  next.has(key) ? next.delete(key) : next.add(key);
  collapsed.value = next;
}

/** A bar piece's position on the axis. Segments leave a 1 px gap after them, so neighbouring phases read apart. */
function place(start, end, gap = false) {
  const from = axis.value.x(start);
  const width = Math.max(0, axis.value.x(end) - from) * 100;
  return { left: `${from * 100}%`, width: gap ? `max(2px, calc(${width}% - 1px))` : `${width}%` };
}

function role_label(row) {
  const host = row.item.role === "host";
  return row.item.source === "discussion" ? (host ? "讨论 · 主持" : "讨论 · 专家") : (host ? "协作 · 主持" : "协作");
}
const status = (row) => row_status(row, now.value);

function row_label(row) {
  const parts = [bridge.display_name(row.item.member), role_label(row), STATE_LABELS[row.item.state], `用时 ${format_duration(row.end - row.start)}`];
  if (row.wake) parts.push(`唤醒 ${format_duration(row.wake[1] - row.wake[0])}${row.wake_approx ? "（约）" : ""}`);
  if (!row.segments.length && row.work) parts.push("无阶段明细");
  if (row.notes.length) parts.push(`${row.notes.length} 段过程说明`);
  return parts.join("，");
}

/** Read an execution's note texts once a hover needs them; read again when more notes arrived since. */
async function note_texts_for(row) {
  const id = row.item.id;
  if (row.item.source !== "free" || !row.notes.length || (note_texts.value.get(id)?.length || 0) >= row.notes.length) return;
  try {
    const { notes } = await bridge.request(`/api/rooms/${room_id.value}/executions/${id}/notes`);
    note_texts.value = new Map(note_texts.value).set(id, notes.map((note) => note.text));
  } catch { /* The card says the notes could not be read. */ }
}

const clock = (ms) => new Date(ms).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const tick_label = (tick) => new Date(tick.at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", ...(tick.seconds ? { second: "2-digit" } : {}), hour12: false });

/** Show the card for one piece of a bar: what it was, when, and the progress notes written around then. */
function show(event, row, piece) {
  const target = event.currentTarget.getBoundingClientRect();
  const related = piece.note ? { notes: [piece.note], earlier: false } : notes_between(row.notes, piece.start, piece.end);
  hover.value = { key: row.key, row, piece, related, left: Math.max(8, Math.min(target.left, window.innerWidth - 380)), top: target.bottom + 6 };
  note_texts_for(row);
}

function hide(row) { if (hover.value?.key === row.key) hover.value = null; }

const hover_title = computed(() => {
  const piece = hover.value?.piece;
  if (!piece) return "";
  if (piece.note) return `过程说明 · ${clock(piece.note.at)}`;
  const name = piece.kind === "segment" ? `${PHASE_LABELS[piece.phase]}${piece.tool ? ` · ${piece.tool}` : ""}` : piece.label;
  return `${name} · ${format_duration(piece.end - piece.start)}${piece.live ? " · 进行中" : ""}`;
});
const hover_notes = computed(() => {
  if (!hover.value) return [];
  const texts = note_texts.value.get(hover.value.row.item.id);
  return hover.value.related.notes.map((note) => ({ at: note.at, text: texts?.[note.index] ?? (texts ? "（未能读取）" : "读取中…") }));
});
</script>

<template>
  <section class="merged-section execution-timeline" aria-label="执行时间线">
    <div class="page-heading"><div><h2>执行时间线</h2><p>本机接入程序唤醒的每次执行，按时间排在同一条轴上；由主持人派出的执行缩进在主持人之下。阶段由接入程序从软件输出中识别，手动接入、在线 AI 与 Codex App 没有阶段明细；点名字展开详情，悬停条形或刻度看当时的过程说明（目前只有协作执行记录过程说明）。</p></div></div>
    <p v-if="error" role="alert" class="fine-print wf-error">{{ error }}</p>
    <p v-if="timeline && !all_rows.length" class="fine-print">还没有执行记录。</p>
    <div v-if="all_rows.length" class="wf">
      <header class="wf-head">
        <span class="wf-title">执行瀑布</span>
        <span class="wf-state" :class="{ 'is-live': summary.running }">{{ summary.running ? `${summary.running} 个进行中` : '均已结束' }}</span>
        <span v-if="summary.slowest" class="wf-headline">最慢一步 <b>{{ bridge.display_name(summary.slowest.member) }} · {{ PHASE_LABELS[summary.slowest.phase] }}<template v-if="summary.slowest.tool"> {{ summary.slowest.tool }}</template></b> · {{ format_duration(summary.slowest.end - summary.slowest.start) }}</span>
      </header>
      <dl class="wf-summary">
        <div><dt>执行</dt><dd>{{ summary.executions }}</dd></div>
        <div><dt>进行中</dt><dd :class="{ 'is-live': summary.running }">{{ summary.running }}</dd></div>
        <div><dt>失败</dt><dd :class="{ 'is-failed': summary.failed }">{{ summary.failed }}</dd></div>
        <div :title="`超过 ${STALL_MINUTES} 分钟没有输出`"><dt>可能卡住</dt><dd :class="{ 'is-warn': summary.stalled }">{{ summary.stalled }}</dd></div>
        <div :title="axis.folds.length ? `已折叠 ${axis.folds.length} 段超过 ${FOLD_GAP_MS / 60000} 分钟的空闲` : undefined"><dt>有效时长</dt><dd>{{ format_duration(axis.busy_ms) }}</dd></div>
        <div title="连续调用同一工具合并为一段"><dt>工具与命令</dt><dd>{{ summary.tool_segments }} 段</dd></div>
      </dl>
      <ul class="wf-legend" aria-label="图例">
        <li v-for="[key, label] in LEGEND" :key="key"><i class="wf-swatch" :class="`is-${key}`"></i>{{ label }}</li>
        <li><i class="wf-swatch is-note-mark"></i>过程说明</li>
        <li><i class="wf-swatch is-failed-mark"></i>失败</li>
      </ul>
      <div class="wf-grid" role="list" :style="{ '--wf-depth-px': `${DEPTH_PX}px` }">
        <div class="wf-axis-label">
          <span>执行 · {{ rows.length }}/{{ all_rows.length }}</span>
          <span v-if="parents.length" class="wf-branch">
            <button type="button" class="wf-text-button" @click="collapsed = new Set()">展开全部</button>
            <button type="button" class="wf-text-button" @click="collapsed = new Set(parents)">收起全部</button>
          </span>
        </div>
        <div class="wf-axis" aria-hidden="true">
          <span v-for="tick in ticks" :key="tick.at" class="wf-tick" :style="{ left: `${tick.x * 100}%` }">{{ tick_label(tick) }}</span>
          <span v-if="running" class="wf-now">现在</span>
        </div>
        <span class="wf-axis-end">用时</span>
        <div v-for="row in rows" :key="row.key" role="listitem" class="wf-row" :class="[`is-${row.item.state}`, { 'is-open': opened === row.key }]">
          <div class="wf-label" :style="{ '--depth': row.depth }">
            <span v-if="row.depth" class="wf-guides" aria-hidden="true"></span>
            <button v-if="row.has_children" type="button" class="wf-toggle" :class="{ 'is-open': !collapsed.has(row.key) }" :aria-expanded="!collapsed.has(row.key)"
              :aria-label="`${collapsed.has(row.key) ? '展开' : '收起'} ${bridge.display_name(row.item.member)} 派出的执行`" @click="toggle(row.key)">
              <UIcon name="i-lucide-chevron-right" />
            </button>
            <span v-else class="wf-toggle-space"></span>
            <UAvatar :src="bridge.identities[row.item.member]?.icon" :text="bridge.identities[row.item.member]?.initials" :alt="row.item.member" size="2xs" class="channel-avatar wf-avatar" :class="bridge.identities[row.item.member]?.style" />
            <button type="button" class="wf-names" :aria-expanded="opened === row.key" :title="status(row).text" @click="open_row(row)">
              <span class="wf-name-line"><strong>{{ bridge.display_name(row.item.member) }}</strong><small>{{ role_label(row) }}</small><em v-if="summary.slowest?.row === row.key" class="wf-pill is-slowest">最慢</em></span>
              <span class="wf-status" :class="`is-${status(row).tone}`"><i v-if="status(row).tone === 'live'" class="wf-live-dot" aria-hidden="true"></i>{{ status(row).text }}</span>
            </button>
          </div>
          <div class="wf-lane" role="img" :aria-label="row_label(row)" @mouseleave="hide(row)"><div class="wf-track">
            <i v-for="tick in ticks" :key="tick.at" class="wf-gridline" :style="{ left: `${tick.x * 100}%` }"></i>
            <i v-for="fold in axis.folds" :key="fold.start" class="wf-fold" :style="{ left: `${fold.from * 100}%`, width: `${fold.width * 100}%` }"></i>
            <i class="wf-well"></i>
            <i class="wf-bar is-queue" :style="place(...row.queue)" @mouseenter="show($event, row, { label: '排队', start: row.queue[0], end: row.queue[1] })"></i>
            <i v-if="row.wake" class="wf-bar is-wake" :style="place(...row.wake)"
              @mouseenter="show($event, row, { label: row.wake_approx ? '唤醒（约）' : '唤醒', start: row.wake[0], end: row.wake[1] })"></i>
            <i v-if="row.work" class="wf-bar is-work" :class="{ 'has-detail': row.segments.length }" :style="place(...row.work)"
              @mouseenter="show($event, row, { label: row.segments.length ? '执行' : '执行 · 无阶段明细', start: row.work[0], end: row.work[1], live: row.item.state === 'running' })"></i>
            <template v-for="segment in row.segments" :key="segment.start + segment.phase">
              <i class="wf-bar wf-seg" :class="[`is-${segment.phase}`, { 'is-live': segment.live }]"
                :style="place(segment.start, segment.seen, true)" @mouseenter="show($event, row, { kind: 'segment', ...segment })"></i>
              <i v-if="segment.end > segment.seen" class="wf-bar wf-seg is-tail" :class="`is-${segment.phase}`"
                :style="place(segment.seen, segment.end)" @mouseenter="show($event, row, { kind: 'segment', ...segment })"></i>
            </template>
            <button v-for="note in row.notes" :key="`note-${note.index}`" type="button" class="wf-note" :style="{ left: `${axis.x(note.at) * 100}%` }"
              :aria-label="`${bridge.display_name(row.item.member)} 的第 ${note.index + 1} 段过程说明，${clock(note.at)}`"
              @mouseenter="show($event, row, { note, start: note.at, end: note.at })" @focus="show($event, row, { note, start: note.at, end: note.at })" @blur="hide(row)"></button>
          </div></div>
          <span class="wf-end">{{ format_duration(row.end - row.start) }}{{ row.wake_approx && row.wake ? '~' : '' }}<small v-if="row.item.state !== 'done'" :class="`is-${row.item.state}`">{{ STATE_LABELS[row.item.state] }}</small><small v-if="row.truncated">明细已截断</small></span>
          <div v-if="opened === row.key" class="wf-detail" :style="{ marginLeft: `${row.depth * DEPTH_PX + 44}px` }">
            <dl>
              <div v-if="row.item.task"><dt>任务</dt><dd>{{ row.item.task }}<button v-if="row.item.task_id" type="button" class="subtle-link" @click="emit('detail', row.item.task_id)">#{{ row.item.task_id }}</button></dd></div>
              <div v-if="row.item.state === 'failed'"><dt>失败原因</dt><dd class="is-failed">{{ row.item.reason || '执行失败' }}</dd></div>
              <div v-else-if="row.item.result || row.item.answer_id"><dt>结果</dt><dd>{{ row.item.result }}<button v-if="row.item.answer_id" type="button" class="subtle-link" @click="emit('detail', row.item.answer_id)">在消息中查看 #{{ row.item.answer_id }}</button></dd></div>
              <div v-if="row.item.changes"><dt>改动</dt><dd>{{ row.item.changes }} 个文件</dd></div>
            </dl>
            <ol v-if="opened_log.length" class="wf-log" aria-label="过程">
              <li v-for="entry in opened_log" :key="`${entry.kind}-${entry.at}-${entry.phase || ''}`" :class="`log-${entry.kind}`">
                <time>{{ clock(entry.at) }}</time>
                <template v-if="entry.kind === 'phase'"><i class="wf-swatch" :class="`is-${entry.phase}`" aria-hidden="true"></i><span>{{ PHASE_LABELS[entry.phase] }}<template v-if="entry.tool"> · {{ entry.tool }}</template> · {{ entry.live ? '进行中' : format_duration(entry.duration) }}</span></template>
                <span v-else class="wf-log-note">{{ entry.text }}</span>
              </li>
            </ol>
            <p v-else class="fine-print">这次执行没有阶段明细或过程说明。</p>
          </div>
        </div>
      </div>
      <footer v-if="axis.folds.length || timeline.executions.length >= timeline.execution_limit" class="wf-foot">
        <span v-if="axis.folds.length"><i class="wf-swatch is-fold" aria-hidden="true"></i>已折叠 {{ axis.folds.length }} 段超过 {{ FOLD_GAP_MS / 60000 }} 分钟的空闲</span>
        <span v-if="timeline.executions.length >= timeline.execution_limit">只列出最近 {{ timeline.execution_limit }} 次讨论执行与 {{ timeline.execution_limit }} 次协作执行</span>
      </footer>
    </div>
    <div v-if="hover" class="wf-card" role="tooltip" :style="{ left: `${hover.left}px`, top: `${hover.top}px` }">
      <strong>{{ bridge.display_name(hover.row.item.member) }} · {{ hover_title }}</strong>
      <small>{{ clock(hover.piece.start) }}<template v-if="hover.piece.end > hover.piece.start"> – {{ hover.piece.live ? '现在' : clock(hover.piece.end) }}</template></small>
      <p v-if="hover.row.item.reason" class="wf-card-reason">{{ hover.row.item.reason }}</p>
      <template v-if="hover_notes.length">
        <small class="wf-card-label">{{ hover.related.earlier ? '此前的过程说明' : '过程说明' }}</small>
        <ol><li v-for="note in hover_notes" :key="note.at + note.text"><time>{{ clock(note.at) }}</time>{{ note.text }}</li></ol>
      </template>
    </div>
  </section>
</template>

<style scoped>
/* A live board needs room for the status line and the bars, so this page is wider than reading pages. */
:global(html[data-theme^="channel"] .content-page > .execution-timeline) { max-width: 1280px; }

/* Tokens. Structure and proportions follow FlowWaterfall (a card, 4 px grid, 20 px bars on wells, hairline rules); surfaces,
   edges and the accent are this site's own channel tokens, and phase hues sit at one lightness per theme so no phase
   outshouts another and none reads as a status (green, amber and red are kept for done, warning and failure). */
.wf {
  --wf-surface: var(--ui-bg-muted);
  --wf-text: var(--ui-text-highlighted);
  --wf-muted: var(--ui-text-muted);
  --wf-border: var(--ui-border-muted);
  --wf-grid: color-mix(in oklab, var(--ui-text) 7%, transparent);
  --wf-guide: color-mix(in oklab, var(--ui-text) 14%, transparent);
  --wf-well: color-mix(in oklab, var(--ui-text) 6%, transparent);
  --wf-hover: var(--channel-ghost-hover, color-mix(in oklab, var(--ui-text) 4%, transparent));
  --wf-hatch: color-mix(in oklab, var(--ui-text) 24%, transparent);
  --wf-accent: var(--channel-accent);
  --wf-failed: var(--ui-error);
  --wf-warn: light-dark(#b7791f, #e5a50a);
  --wf-mono: ui-monospace, SFMono-Regular, Consolas, monospace;
  --wf-thinking: light-dark(oklch(0.55 0.11 300), oklch(0.74 0.10 300));
  --wf-tool: light-dark(oklch(0.55 0.11 255), oklch(0.74 0.10 255));
  --wf-command: light-dark(oklch(0.55 0.09 215), oklch(0.76 0.09 215));
  --wf-editing: light-dark(oklch(0.55 0.11 335), oklch(0.74 0.10 335));
  --wf-writing: light-dark(oklch(0.55 0.08 185), oklch(0.76 0.08 185));
  --wf-wake: light-dark(oklch(0.70 0.12 75), oklch(0.78 0.11 75));
  --wf-work: color-mix(in oklab, var(--ui-text) 26%, var(--wf-surface));
  --wf-bar-h: 20px;
  --wf-row-h: 44px;
  --wf-label-col: minmax(200px, 340px);
  margin-top: 4px;
  border: 1px solid var(--wf-border);
  border-radius: 10px;
  background: var(--wf-surface);
  box-shadow: var(--channel-shadow-panel, none);
  color: var(--wf-text);
  font-size: 13px;
  line-height: 20px;
}
.wf-error { color: var(--ui-error); }

/* Header: title, the run's state as a pill, and the step to look at first. */
.wf-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 12px 16px; border-bottom: 1px solid var(--wf-border); }
.wf-title { font-size: 14px; font-weight: 600; }
.wf-state { display: inline-flex; align-items: center; gap: 6px; height: 20px; padding: 0 8px; border-radius: 999px; background: var(--wf-well); color: var(--wf-muted); font-size: 12px; font-weight: 600; }
.wf-state::before { width: 6px; height: 6px; border-radius: 50%; background: currentColor; content: ""; }
.wf-state.is-live { background: color-mix(in oklab, var(--wf-accent) 14%, transparent); color: var(--wf-accent); }
.wf-state.is-live::before { animation: wf-pulse 1.6s ease-in-out infinite; }
.wf-headline { min-width: 0; overflow: hidden; color: var(--wf-muted); text-overflow: ellipsis; white-space: nowrap; }
.wf-headline b { color: var(--wf-text); font-weight: 600; }

/* KPI row: equal cells split by hairlines, values in tabular figures. */
.wf-summary { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); margin: 0; border-bottom: 1px solid var(--wf-border); }
.wf-summary > div { min-width: 0; padding: 10px 16px; }
.wf-summary > div + div { border-left: 1px solid var(--wf-border); }
.wf-summary dt { color: var(--wf-muted); font-size: 12px; line-height: 16px; }
.wf-summary dd { margin: 4px 0 0; overflow: hidden; font-family: var(--wf-mono); font-size: 17px; font-weight: 600; line-height: 24px; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }
.wf-summary dd.is-live { color: var(--wf-accent); }
.wf-summary dd.is-failed { color: var(--wf-failed); }
.wf-summary dd.is-warn { color: var(--wf-warn); }

/* Legend: one row of swatches, as the bars draw them. */
.wf-legend { display: flex; flex-wrap: wrap; gap: 4px 14px; margin: 0; padding: 8px 16px; border-bottom: 1px solid var(--wf-border); color: var(--wf-muted); font-size: 12px; list-style: none; }
.wf-legend li { display: inline-flex; align-items: center; gap: 6px; }
.wf-swatch { display: inline-block; flex: none; width: 12px; height: 8px; border-radius: 2px; }
.wf-swatch.is-note-mark { width: 2px; height: 12px; border-radius: 1px; background: var(--wf-text); }
.wf-swatch.is-failed-mark { box-shadow: inset 0 0 0 1.5px var(--wf-failed); background: color-mix(in oklab, var(--wf-failed) 20%, transparent); }
.wf-swatch.is-fold { background: repeating-linear-gradient(-45deg, var(--wf-hatch) 0 1px, transparent 1px 4px); box-shadow: inset 0 0 0 1px var(--wf-guide); }

/* Grid: the label column, the lanes and the duration column share one template, the axis included. */
.wf-grid { display: grid; grid-template-columns: var(--wf-label-col) minmax(0, 1fr) 84px; }
.wf-axis-label { display: flex; align-items: center; gap: 8px; min-width: 0; height: 32px; padding: 0 12px 0 16px; border-right: 1px solid var(--wf-border); border-bottom: 1px solid var(--wf-border); color: var(--wf-muted); font-size: 12px; }
.wf-branch { display: flex; gap: 2px; margin-left: auto; }
.wf-text-button { height: 22px; padding: 0 6px; border: 0; border-radius: 4px; background: transparent; color: var(--wf-muted); font: inherit; cursor: pointer; white-space: nowrap; }
.wf-text-button:hover { background: var(--wf-hover); color: var(--wf-text); }
.wf-axis { position: relative; height: 32px; margin: 0 12px; border-bottom: 1px solid var(--wf-border); color: var(--wf-muted); font-family: var(--wf-mono); font-size: 11px; }
.wf-tick { position: absolute; top: 50%; padding-left: 4px; border-left: 1px solid var(--wf-guide); line-height: 14px; white-space: nowrap; transform: translateY(-50%); font-variant-numeric: tabular-nums; }
.wf-now { position: absolute; top: 50%; right: 0; color: var(--wf-accent); font-family: inherit; transform: translateY(-50%); }
.wf-axis-end { display: flex; align-items: center; justify-content: flex-end; height: 32px; padding-right: 16px; border-bottom: 1px solid var(--wf-border); color: var(--wf-muted); font-size: 12px; }

/* Rows: a tint on hover and while opened; the label column carries depth guides at the indent pitch. */
.wf-row { display: contents; }
.wf-row > :not(.wf-detail) { min-height: var(--wf-row-h); background: var(--wf-tint, transparent); transition: background-color 120ms ease; }
.wf-row:hover > :not(.wf-detail), .wf-row.is-open > :not(.wf-detail) { --wf-tint: var(--wf-hover); }
.wf-label { position: relative; display: flex; align-items: center; gap: 8px; min-width: 0; padding: 0 12px 0 calc(12px + var(--depth) * var(--wf-depth-px)); border-right: 1px solid var(--wf-border); }
.wf-guides { position: absolute; top: 0; bottom: 0; left: 20px; width: calc(var(--depth) * var(--wf-depth-px)); background: repeating-linear-gradient(90deg, var(--wf-guide) 0 1px, transparent 1px var(--wf-depth-px)); pointer-events: none; }
.wf-toggle, .wf-toggle-space { display: grid; flex: 0 0 16px; place-items: center; width: 16px; height: 16px; padding: 0; border: 0; border-radius: 4px; background: transparent; color: var(--wf-muted); cursor: pointer; }
.wf-toggle :deep(svg) { width: 12px; height: 12px; transition: transform 160ms ease; }
.wf-toggle.is-open :deep(svg) { transform: rotate(90deg); }
.wf-toggle:hover { background: var(--wf-hover); color: var(--wf-text); }
.wf-avatar { flex: none; }
.wf-names { display: flex; flex: 1; flex-direction: column; min-width: 0; padding: 4px 0; border: 0; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.wf-names:focus-visible, .wf-toggle:focus-visible, .wf-text-button:focus-visible, .wf-note:focus-visible { outline: 2px solid var(--wf-accent); outline-offset: 1px; border-radius: 4px; }
.wf-name-line { display: flex; align-items: baseline; gap: 8px; min-width: 0; line-height: 18px; }
.wf-name-line strong { overflow: hidden; color: var(--wf-text); font-size: 13px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.wf-name-line small { flex: none; color: var(--wf-muted); font-size: 11px; }
.wf-pill { flex: none; height: 16px; padding: 0 6px; border-radius: 999px; font-size: 11px; font-style: normal; font-weight: 600; line-height: 16px; }
.wf-pill.is-slowest { background: color-mix(in oklab, var(--wf-warn) 16%, transparent); color: var(--wf-warn); }
.wf-status { overflow: hidden; color: var(--wf-muted); font-size: 12px; line-height: 18px; text-overflow: ellipsis; white-space: nowrap; }
.wf-status.is-live { color: var(--ui-text); }
.wf-status.is-warn { color: var(--wf-warn); }
.wf-status.is-failed { color: var(--wf-failed); }
.wf-live-dot { display: inline-block; width: 6px; height: 6px; margin-right: 6px; border-radius: 50%; background: var(--wf-accent); vertical-align: 1px; animation: wf-pulse 1.6s ease-in-out infinite; }

/* Lanes: gridlines and folded idle bands behind a well that runs the lane's width; bars sit on the well. */
/* The lane cell takes the row tint edge to edge; the track inside it keeps the axis's side margins. */
.wf-lane { display: flex; min-width: 0; }
.wf-track { position: relative; flex: 1; min-width: 0; margin: 0 12px; }
.wf-track > i, .wf-track > .wf-note { position: absolute; display: block; }
.wf-gridline { top: 0; bottom: 0; width: 1px; background: var(--wf-grid); }
.wf-fold { top: 0; bottom: 0; border-inline: 1px dashed var(--wf-guide); background: color-mix(in oklab, var(--ui-text) 4%, transparent); }
.wf-well { top: calc(50% - var(--wf-bar-h) / 2); right: 0; left: 0; height: var(--wf-bar-h); border-radius: 4px; background: var(--wf-well); }
.wf-bar { top: calc(50% - var(--wf-bar-h) / 2); height: var(--wf-bar-h); min-width: 2px; border-radius: 4px; transition: width 120ms linear, filter 120ms ease; }
.wf-bar:hover { z-index: 1; filter: brightness(1.15); box-shadow: 0 0 0 2px color-mix(in oklab, var(--wf-text) 30%, transparent); }
.wf-bar.is-queue { background: repeating-linear-gradient(-45deg, var(--wf-hatch) 0 1px, transparent 1px 5px); box-shadow: inset 0 0 0 1px var(--wf-hatch); }
.wf-bar.is-wake { background: color-mix(in oklab, var(--wf-wake) 55%, var(--wf-surface)); box-shadow: inset 0 0 0 1px var(--wf-wake); }
.wf-bar.is-work { background: var(--wf-work); box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--ui-text) 16%, transparent); }
/* With phases recorded, the execution's own extent is only a faint frame under them. */
.wf-bar.is-work.has-detail { background: color-mix(in oklab, var(--ui-text) 5%, transparent); }
.is-failed .wf-bar.is-work { background: color-mix(in oklab, var(--wf-failed) 22%, var(--wf-surface)); box-shadow: inset 0 0 0 1px var(--wf-failed); }
.is-running .wf-bar.is-work:not(.has-detail) { animation: wf-pulse 1.6s ease-in-out infinite; }
.wf-seg.is-live { animation: wf-pulse 1.6s ease-in-out infinite; }
/* Past the last output the phase is only assumed to go on; a long faint tail is what a stalled execution looks like. */
.wf-seg.is-tail { min-width: 0; border-radius: 0 4px 4px 0; opacity: .28; }
.is-thinking { background: var(--wf-thinking); }
.is-command { background: var(--wf-command); }
.is-tool { background: var(--wf-tool); }
.is-editing { background: var(--wf-editing); }
.is-writing { background: var(--wf-writing); }
.wf-swatch.is-queue { background: repeating-linear-gradient(-45deg, var(--wf-hatch) 0 1px, transparent 1px 4px); box-shadow: inset 0 0 0 1px var(--wf-hatch); }
.wf-swatch.is-wake { background: color-mix(in oklab, var(--wf-wake) 55%, var(--wf-surface)); box-shadow: inset 0 0 0 1px var(--wf-wake); }
.wf-swatch.is-work { background: var(--wf-work); }
/* A note is a tick through the bar; its hit area is wider than it looks. */
.wf-note { top: calc(50% - var(--wf-bar-h) / 2 - 5px); width: 9px; height: calc(var(--wf-bar-h) + 10px); margin-left: -4px; padding: 0; border: 0; background: linear-gradient(var(--wf-text), var(--wf-text)) center / 2px 100% no-repeat; opacity: .6; cursor: help; z-index: 2; }
.wf-note:hover, .wf-note:focus-visible { opacity: 1; }

/* Duration column: tabular figures, the state under it when it is not a plain finish. */
.wf-end { display: flex; flex-direction: column; align-items: flex-end; justify-content: center; padding-right: 16px; font-family: var(--wf-mono); font-size: 12px; line-height: 16px; font-variant-numeric: tabular-nums; }
.wf-end small { color: var(--wf-muted); font-family: var(--ui-font-sans, inherit); font-size: 11px; }
.wf-end small.is-failed { color: var(--wf-failed); }
.wf-end small.is-running { color: var(--wf-accent); }

/* Detail: an inset well under the opened row, aligned with its name. */
.wf-detail { grid-column: 1 / -1; margin: 0 16px 12px; padding: 12px 14px; border: 1px solid var(--wf-border); border-radius: 8px; background: var(--wf-well); }
.wf-detail dl { display: grid; gap: 6px; margin: 0 0 10px; }
.wf-detail dl > div { display: grid; grid-template-columns: 64px minmax(0, 1fr); gap: 8px; }
.wf-detail dt { color: var(--wf-muted); font-size: 12px; }
.wf-detail dd { margin: 0; overflow-wrap: anywhere; }
.wf-detail dd.is-failed { color: var(--wf-failed); }
.wf-detail .subtle-link { margin-left: 8px; }
.wf-log { display: grid; gap: 4px; max-height: 320px; margin: 0; padding: 10px 0 0; overflow: auto; border-top: 1px solid var(--wf-border); list-style: none; }
.wf-log li { display: grid; grid-template-columns: 64px 12px minmax(0, 1fr); align-items: baseline; gap: 8px; font-size: 12px; }
.wf-log li.log-note { grid-template-columns: 64px minmax(0, 1fr); }
.wf-log time { color: var(--wf-muted); font-family: var(--wf-mono); font-size: 11px; font-variant-numeric: tabular-nums; }
.wf-log li.log-phase span { color: var(--wf-muted); }
.wf-log-note { color: var(--wf-text); line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; }

.wf-foot { display: flex; flex-wrap: wrap; gap: 4px 20px; padding: 8px 16px; border-top: 1px solid var(--wf-border); color: var(--wf-muted); font-size: 12px; }
.wf-foot span { display: inline-flex; align-items: center; gap: 6px; }

/* Hover card: what the piece was, when, and the notes written around then. */
.wf-card { position: fixed; z-index: 50; display: grid; gap: 4px; width: min(360px, calc(100vw - 16px)); max-height: 50vh; padding: 10px 12px; overflow: auto; border: 1px solid var(--channel-edge-float, var(--ui-border)); border-radius: 8px; background: var(--ui-bg-elevated); box-shadow: var(--channel-shadow-float, 0 8px 24px rgb(0 0 0 / .25)); color: var(--ui-text); font-size: 12px; pointer-events: none; }
.wf-card strong { color: var(--ui-text-highlighted); font-size: 13px; }
.wf-card small { color: var(--ui-text-muted); font-variant-numeric: tabular-nums; }
.wf-card-reason { margin: 2px 0 0; color: var(--ui-error); }
.wf-card-label { margin-top: 4px; }
.wf-card ol { display: grid; gap: 6px; margin: 0; padding: 0; line-height: 1.6; list-style: none; white-space: pre-wrap; overflow-wrap: anywhere; }
.wf-card time { margin-right: 6px; color: var(--ui-text-dimmed); font-variant-numeric: tabular-nums; }

@keyframes wf-pulse { 50% { opacity: .55; } }
@media (prefers-reduced-motion: reduce) { .wf * { animation: none !important; transition: none !important; } }
/* Narrow screens: a shorter label column, the KPI row in three columns, and no axis labels that would collide. */
@media (max-width: 720px) {
  .wf { --wf-label-col: 132px; }
  .wf-grid { grid-template-columns: var(--wf-label-col) minmax(0, 1fr) 60px; }
  .wf-summary { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .wf-summary > div:nth-child(4) { border-left: 0; }
  .wf-summary > div:nth-child(n + 4) { border-top: 1px solid var(--wf-border); }
  .wf-tick:nth-child(even) { display: none; }
  .wf-branch, .wf-name-line small { display: none; }
  .wf-label { padding-right: 8px; }
  .wf-track, .wf-axis { margin: 0 6px; }
  .wf-end { padding-right: 10px; }
}
</style>

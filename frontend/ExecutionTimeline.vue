<script setup>
/**
 * The execution timeline: every execution the local service woke, on one time axis, nested under the execution that
 * dispatched it, with the phases the runner saw its software go through and the progress notes it wrote. Phase reports
 * wake no other page, so this page reads on its own: in full when opened, then only what is running or just ended,
 * every two seconds while anything runs and whenever the room changes. Running bars grow every frame.
 * A finished run can be replayed: the same drawing, with the playback position as now.
 * The look follows FlowWaterfall (tangle-network/charts) and the interaction Kobra's Trace Waterfall: one run at a time,
 * a KPI row, a ticked axis with room ahead of live work, a now cursor, hand-off lines and bars on wells.
 */
import { computed, inject, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { FOLD_GAP_MS, PHASE_KINDS, PHASE_LABELS, STALL_MS, STATE_LABELS, axis_ticks, execution_log, format_duration, handoff_lines, notes_between, row_status,
  snapshot_at, timeline_axis, timeline_rows, timeline_runs, timeline_summary } from "./timeline-model.js";

const emit = defineEmits(["detail"]);
const { view, bridge } = inject("discussion");
const STALL_MINUTES = STALL_MS / 60_000;
const LIVE_REFRESH_MS = 2000;
const FULL_REFRESH_MS = 60_000;
// With few rows the page redraws every frame; with many it redraws this often, so a long list stays responsive.
const CLOCK_MS = 100;
const SMOOTH_ROWS = 60;
// A replay at "auto" speed lasts about this long, whatever the run's length; manual speeds are these multiples.
const REPLAY_TARGET_MS = 20_000;
const REPLAY_SPEEDS = [1, 2, 4, 8, 16, 32];
// A row that appears while watching fades in for this long.
const ENTER_MS = 600;
// An incremental read also takes executions that ended this long before the previous read, so none slips between reads.
const OVERLAP_SECONDS = 5;
// Each depth level indents a row's label by this much; the guides are drawn at the same pitch.
const DEPTH_PX = 16;
// About one axis tick per this many pixels of axis, and never fewer or more than these.
const TICK_SPACING_PX = 90;
const MIN_TICKS = 2;
const MAX_TICKS = 8;
// Touch screens have no hover: a tap opens the card and a tap elsewhere closes it.
const can_hover = typeof window !== "undefined" && window.matchMedia?.("(hover: hover)").matches !== false;
const axis_element = ref(null);
const axis_width = ref(0);
let axis_observer = null;
const room_id = computed(() => view.value.room?.id);
const executions = ref(new Map());
const limits = ref(null);
const error = ref("");
const now = ref(Date.now());
const collapsed = ref(new Set());
const note_texts = ref(new Map());
const hover = ref(null);
const opened = ref("");
const detail_anchor = ref(null);
const wf_element = ref(null);
// The opened execution's detail floats at most this wide.
const DETAIL_WIDTH_PX = 560;
let last_read = 0;
let last_full = 0;
let reading = false;
let refresh_timer = 0;
let frame = 0;
let last_frame = 0;
let last_paint = 0;
// Replay: `position` is milliseconds into the run (null: not replaying), `speed` 0 means auto.
const replay = reactive({ position: null, playing: false, speed: 0 });
let play_position = 0;

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
  if (live) refresh_timer = setInterval(() => { if (!document.hidden) load(); }, LIVE_REFRESH_MS);
}, { immediate: true });
watch(room_id, () => {
  executions.value = new Map(); limits.value = null; collapsed.value = new Set(); note_texts.value = new Map(); hover.value = null; opened.value = "";
  last_read = 0;
  load(true);
}, { immediate: true });
// A new execution, an answer or a failure changes the room; read at once instead of waiting for the next tick.
watch(() => view.value.room, (room, previous) => { if (room?.id && room.id === previous?.id) load(); });
/** A pinned card (opened by a tap) closes on a tap anywhere else. */
function close_on_outside(event) {
  if (hover.value && !event.target.closest?.(".wf-card, .wf-bar, .wf-note")) hover.value = null;
  if (opened.value && !event.target.closest?.(".wf-detail, .wf-names")) opened.value = "";
}
function close_on_escape(event) { if (event.key === "Escape") { opened.value = ""; hover.value = null; } }
onMounted(() => {
  document.addEventListener("pointerdown", close_on_outside);
  document.addEventListener("keydown", close_on_escape);
  axis_observer = new ResizeObserver(([entry]) => { axis_width.value = entry.contentRect.width; });
});
// The axis appears only once there are rows, so it is observed whenever it is (re)rendered.
watch(axis_element, (element, previous) => {
  if (previous) axis_observer?.unobserve(previous);
  if (element) axis_observer?.observe(element);
});
onBeforeUnmount(() => {
  clearInterval(refresh_timer); cancelAnimationFrame(frame);
  document.removeEventListener("pointerdown", close_on_outside);
  document.removeEventListener("keydown", close_on_escape);
  axis_observer?.disconnect();
});

/** One run at a time, as a trace shows one agent run: the latest by default (it follows a new run as it starts),
 *  any earlier run, or every execution at once. */
const LATEST = "latest";
const ALL = "all";
const chosen_run = ref(LATEST);
const runs = computed(() => timeline.value ? timeline_runs(timeline.value, now.value) : { list: [], of: new Map() });
const run_shown = computed(() => chosen_run.value === LATEST ? runs.value.list[0]?.key
  : chosen_run.value === ALL || runs.value.list.some((run) => run.key === chosen_run.value) ? chosen_run.value : runs.value.list[0]?.key);
const shown = computed(() => !timeline.value || run_shown.value === ALL ? timeline.value
  : { ...timeline.value, executions: timeline.value.executions.filter((item) => runs.value.of.get(`${item.source}:${item.id}`) === run_shown.value) });
watch(room_id, () => { chosen_run.value = LATEST; });
const when = (ms) => new Date(ms).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
const RUN_TASK_CHARS = 22;
function run_label(run) {
  const task = run.task ? `${run.task.replace(/\s+/g, " ").slice(0, RUN_TASK_CHARS)}${run.task.length > RUN_TASK_CHARS ? "…" : ""}` : run.source === "discussion" ? "讨论" : "执行";
  return `${when(run.start)} · ${task} · ${run.count} 次${run.running ? " · 进行中" : run.failed ? " · 有失败" : ""}`;
}

// The run as it really is; its bounds are what a replay plays through.
const base_rows = computed(() => shown.value ? timeline_rows(shown.value, now.value) : []);
const base_live = computed(() => base_rows.value.some((row) => row.item.state === "running"));
const bounds = computed(() => {
  const start = Math.min(...base_rows.value.map((row) => row.start));
  const end = Math.max(...base_rows.value.map((row) => row.end));
  return Number.isFinite(start) ? { start, end, duration: Math.max(0, end - start) } : { start: 0, end: 0, duration: 0 };
});
// A replay draws the run as it stood at the playback position, which stands in for now; live work is never replayed.
const replaying = computed(() => replay.position !== null && !base_live.value);
const view_time = computed(() => replaying.value ? bounds.value.start + replay.position : now.value);
const all_rows = computed(() => replaying.value
  ? timeline_rows(snapshot_at(shown.value, view_time.value, note_texts.value), view_time.value) : base_rows.value);
const rows = computed(() => all_rows.value.filter((row) => !row.ancestors.some((key) => collapsed.value.has(key))));
const live_in_view = computed(() => all_rows.value.some((row) => row.item.state === "running"));
const axis = computed(() => timeline_axis(all_rows.value, live_in_view.value));
const now_x = computed(() => live_in_view.value ? axis.value.x(view_time.value) : null);
const auto_speed = computed(() => Math.max(1, bounds.value.duration / REPLAY_TARGET_MS));
const replay_speed = computed(() => replay.speed || auto_speed.value);

/** One clock for live growth and replay: every frame while either is on, at most ten times a second with many rows. */
function step(timestamp) {
  const elapsed = last_frame ? Math.min(timestamp - last_frame, 250) : 0;
  last_frame = timestamp;
  const due = all_rows.value.length <= SMOOTH_ROWS || timestamp - last_paint >= CLOCK_MS;
  if (replay.playing) {
    play_position += elapsed * replay_speed.value;
    if (play_position >= bounds.value.duration) Object.assign(replay, { position: null, playing: false });
    else if (due) replay.position = play_position;
  }
  if (base_live.value && due) now.value = Date.now();
  if (due) last_paint = timestamp;
  frame = base_live.value || replay.playing ? requestAnimationFrame(step) : 0;
  if (!frame) last_frame = 0;
}
watch([base_live, () => replay.playing], () => { if (!frame && (base_live.value || replay.playing)) frame = requestAnimationFrame(step); }, { immediate: true });

/** Replay from the start, or go on from where it was paused; the run's note texts are read first, to surface as they were written. */
async function play() {
  if (replay.position === null) { play_position = 0; reset_entering(); }
  else play_position = replay.position;
  Object.assign(replay, { position: play_position, playing: true });
  load_run_notes();
}
/** A replay shows what each execution was saying at the time, so it needs the run's note texts, read once each. */
function load_run_notes() { for (const item of shown.value?.executions || []) note_texts_for({ item, notes: item.notes || [] }); }
function pause() { replay.playing = false; }
function restart() { play_position = 0; reset_entering(); Object.assign(replay, { position: 0, playing: true }); }
function scrub(event) { play_position = Number(event.target.value); Object.assign(replay, { position: play_position, playing: false }); load_run_notes(); }
// Another run or another room starts from its real, final state.
watch([run_shown, room_id], () => Object.assign(replay, { position: null, playing: false }));

// Rows that appear while watching (a new execution starting, or one a replay reaches) fade in; the first drawing does not.
const entering = ref(new Set());
let known_rows = null;
function reset_entering() { known_rows = new Set(); entering.value = new Set(); }
watch(() => rows.value.map((row) => row.key).join(), () => {
  const keys = rows.value.map((row) => row.key);
  if (!known_rows) { known_rows = new Set(keys); return; }
  const added = keys.filter((key) => !known_rows.has(key));
  added.forEach((key) => known_rows.add(key));
  if (!added.length) return;
  entering.value = new Set([...entering.value, ...added]);
  setTimeout(() => { entering.value = new Set([...entering.value].filter((key) => !added.includes(key))); }, ENTER_MS);
});
watch([run_shown, room_id], () => { known_rows = null; });
const lines = computed(() => handoff_lines(rows.value, axis.value));
const ticks = computed(() => axis_ticks(axis.value,
  Math.min(MAX_TICKS, Math.max(MIN_TICKS, Math.round((axis_width.value || TICK_SPACING_PX * 6) / TICK_SPACING_PX)))));
const summary = computed(() => timeline_summary(all_rows.value, view_time.value));
const parents = computed(() => all_rows.value.filter((row) => row.has_children).map((row) => row.key));
const opened_row = computed(() => all_rows.value.find((row) => row.key === opened.value));
const opened_log = computed(() => opened_row.value ? execution_log(opened_row.value, note_texts.value.get(opened_row.value.item.id)) : []);
/** The legend lists only what the bars actually show, so it never explains marks that are not there. */
const legend = computed(() => {
  const rows = all_rows.value;
  const kinds = new Set(rows.flatMap((row) => row.segments.map((segment) => PHASE_KINDS[segment.phase])));
  return [
    ...(rows.some((row) => row.queue[1] > row.queue[0]) ? [["queue", "排队"]] : []),
    ...(rows.some((row) => row.wake) ? [["wake", "唤醒"]] : []),
    ...(kinds.has("model") ? [["model", "模型（思考、撰写）"]] : []),
    ...(kinds.has("tool") ? [["tool", "工具（命令、工具、编辑）"]] : []),
    ...(rows.some((row) => row.work && !row.segments.length) ? [["work", "执行（无阶段明细）"]] : []),
    ...(rows.some((row) => row.placed_parent) ? [["handoff", "派活"]] : []),
    ...(rows.some((row) => row.notes.length) ? [["note-mark", "过程说明"]] : []),
    ...(rows.some((row) => row.item.state === "failed") ? [["failed-mark", "失败"]] : []),
  ];
});
const no_phases = computed(() => all_rows.value.length > 0 && all_rows.value.every((row) => !row.segments.length));
/** Each member keeps one hue, so bars without phases still say who worked when. Hues go by first appearance. */
const MEMBER_TONES = 5;
const member_tone = computed(() => {
  const tones = new Map();
  for (const row of [...all_rows.value].sort((a, b) => a.start - b.start)) {
    if (!tones.has(row.item.member)) tones.set(row.item.member, tones.size % MEMBER_TONES + 1);
  }
  return tones;
});
// A tick this many pixels from a folded band's middle would collide with the band's label.
const FOLD_LABEL_CLEARANCE_PX = 52;
const shown_ticks = computed(() => {
  const clearance = FOLD_LABEL_CLEARANCE_PX / (axis_width.value || 800);
  return ticks.value.filter((tick) => !axis.value.folds.some((fold) => Math.abs(tick.x - (fold.from + fold.width / 2)) < clearance));
});

/** Open one execution's detail under its row, or close it; its notes are read as it opens and again as more arrive. */
function open_row(row, event) {
  opened.value = opened.value === row.key ? "" : row.key;
  if (!opened.value) return;
  // Anchored under the name, within the card; the card scrolls with the page, so the anchor stays put.
  const name = event.currentTarget.getBoundingClientRect();
  const card = wf_element.value.getBoundingClientRect();
  const width = Math.min(DETAIL_WIDTH_PX, card.width - 16);
  detail_anchor.value = { top: name.bottom - card.top + 4, left: Math.max(8, Math.min(name.left - card.left, card.width - width - 8)) };
  hover.value = null;
  note_texts_for(row);
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
/** The marks after a name: only what tells rows apart. Every free row would say "协作", so it says nothing. */
function role_marks(row) {
  return [...(row.item.source === "discussion" ? ["讨论"] : []), ...(row.item.role === "host" ? ["主持"] : [])];
}
const status = (row) => row_status(row, view_time.value);

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
function show(event, row, piece, pinned = false) {
  const target = event.currentTarget.getBoundingClientRect();
  const related = piece.note ? { notes: [piece.note], earlier: false } : notes_between(row.notes, piece.start, piece.end);
  const width = Math.min(360, window.innerWidth - 16);
  // Below the piece, unless that runs off the screen; then above it.
  const below = target.bottom + 6;
  const top = below + 160 > window.innerHeight && target.top > 200 ? Math.max(8, target.top - 6 - 200) : below;
  hover.value = { key: row.key, id: piece_id(row, piece), row, piece, related, pinned,
    left: Math.max(8, Math.min(target.left, window.innerWidth - width - 8)), top };
  note_texts_for(row);
}
const piece_id = (row, piece) => `${row.key}:${piece.kind || piece.label || "note"}:${piece.start}`;

/** With a mouse, a piece shows its card while pointed at. */
function enter(event, row, piece) { if (can_hover) show(event, row, piece); }
/** On a touch screen a tap opens the card and pins it; tapping the same piece again closes it. */
function tap(event, row, piece) {
  if (can_hover) return;
  if (hover.value?.id === piece_id(row, piece)) hover.value = null;
  else show(event, row, piece, true);
}
function hide(row) { if (hover.value?.key === row.key && !hover.value.pinned) hover.value = null; }

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
    <div class="page-heading"><div><h2>执行时间线</h2><p>本机接入程序唤醒的每次执行；点名字看详情，悬停条形看当时的过程说明。</p></div></div>
    <p v-if="error" role="alert" class="fine-print wf-error">{{ error }}</p>
    <p v-if="timeline && !all_rows.length" class="fine-print">还没有执行记录。</p>
    <div v-if="all_rows.length" ref="wf_element" class="wf">
      <header class="wf-head">
        <span class="wf-title">执行瀑布</span>
        <label class="wf-run">
          <span class="sr-only">查看哪一轮</span>
          <select v-model="chosen_run" class="wf-run-select">
            <option :value="LATEST">最近一轮（自动跟随）</option>
            <option v-for="run in runs.list" :key="run.key" :value="run.key">{{ run_label(run) }}</option>
            <option :value="ALL">全部执行</option>
          </select>
          <UIcon name="i-lucide-chevrons-up-down" class="wf-run-icon" aria-hidden="true" />
        </label>
        <span v-if="replaying" class="wf-state is-replay">回放中 · {{ clock(view_time) }}</span>
        <span v-else class="wf-state" :class="{ 'is-live': summary.running }">{{ summary.running ? `${summary.running} 个进行中` : '均已结束' }}</span>
        <span v-if="summary.slowest" class="wf-headline">最慢一步 <b>{{ bridge.display_name(summary.slowest.member) }} · {{ PHASE_LABELS[summary.slowest.phase] }}<template v-if="summary.slowest.tool"> {{ summary.slowest.tool }}</template></b> · {{ format_duration(summary.slowest.end - summary.slowest.start) }}</span>
      </header>
      <dl class="wf-summary">
        <div><dt>执行</dt><dd><span :key="summary.executions" class="wf-roll">{{ summary.executions }}</span></dd></div>
        <div><dt>进行中</dt><dd :class="summary.running ? 'is-live' : 'is-zero'"><span :key="summary.running" class="wf-roll">{{ summary.running }}</span></dd></div>
        <div><dt>失败</dt><dd :class="summary.failed ? 'is-failed' : 'is-zero'"><span :key="summary.failed" class="wf-roll">{{ summary.failed }}</span></dd></div>
        <div :title="`超过 ${STALL_MINUTES} 分钟没有输出`"><dt>可能卡住</dt><dd :class="summary.stalled ? 'is-warn' : 'is-zero'"><span :key="summary.stalled" class="wf-roll">{{ summary.stalled }}</span></dd></div>
        <div :title="axis.folds.length ? `已折叠 ${axis.folds.length} 段超过 ${FOLD_GAP_MS / 60000} 分钟的空闲` : undefined"><dt>有效时长</dt><dd>{{ format_duration(axis.busy_ms) }}</dd></div>
        <div title="连续调用同一工具合并为一段"><dt>工具与命令</dt><dd :class="{ 'is-zero': !summary.tool_segments }"><span :key="summary.tool_segments" class="wf-roll">{{ summary.tool_segments }}</span> 段</dd></div>
      </dl>
      <ul class="wf-legend" aria-label="图例">
        <li v-for="[key, label] in legend" :key="key"><i class="wf-swatch" :class="`is-${key}`"></i>{{ label }}</li>
        <li v-if="member_tone.size > 1" class="wf-legend-note">颜色区分成员，深浅区分模型与工具</li>
        <li v-if="no_phases" class="wf-legend-note">这些执行都没有阶段明细：发生在接入程序上报阶段之前，或来自手动接入、在线 AI、Codex App</li>
      </ul>
      <div class="wf-grid" role="list" :style="{ '--wf-depth-px': `${DEPTH_PX}px` }">
        <div class="wf-axis-label">
          <span>执行 · {{ rows.length }}/{{ all_rows.length }}</span>
          <span v-if="parents.length" class="wf-branch">
            <button type="button" class="wf-text-button" @click="collapsed = new Set()">展开全部</button>
            <button type="button" class="wf-text-button" @click="collapsed = new Set(parents)">收起全部</button>
          </span>
        </div>
        <div ref="axis_element" class="wf-axis" aria-hidden="true">
          <span v-for="tick in shown_ticks" :key="tick.at" class="wf-tick" :style="{ left: `${tick.x * 100}%` }">{{ tick_label(tick) }}</span>
          <span v-for="fold in axis.folds" :key="`fold-${fold.start}`" class="wf-fold-label" :style="{ left: `${(fold.from + fold.width / 2) * 100}%` }"
            :title="`${clock(fold.start)} – ${clock(fold.end)} 没有执行，已折叠`">⋯ {{ format_duration(fold.end - fold.start) }}</span>
          <span v-if="now_x !== null" class="wf-cursor-head" :style="{ left: `${now_x * 100}%` }"></span>
        </div>
        <span class="wf-axis-end">用时</span>
        <div v-for="row in rows" :key="row.key" role="listitem" class="wf-row" :class="[`is-${row.item.state}`, { 'is-open': opened === row.key, 'is-entering': entering.has(row.key) }]">
          <div class="wf-label" :style="{ '--depth': row.depth }">
            <span v-if="row.depth" class="wf-guides" aria-hidden="true"></span>
            <button v-if="row.has_children" type="button" class="wf-toggle" :class="{ 'is-open': !collapsed.has(row.key) }" :aria-expanded="!collapsed.has(row.key)"
              :aria-label="`${collapsed.has(row.key) ? '展开' : '收起'} ${bridge.display_name(row.item.member)} 派出的执行`" @click="toggle(row.key)">
              <UIcon name="i-lucide-chevron-right" />
            </button>
            <span v-else class="wf-toggle-space"></span>
            <UAvatar :src="bridge.identities[row.item.member]?.icon" :text="bridge.identities[row.item.member]?.initials" :alt="row.item.member" size="2xs" class="channel-avatar wf-avatar" :class="bridge.identities[row.item.member]?.style" />
            <button type="button" class="wf-names" :aria-expanded="opened === row.key" @click="open_row(row, $event)"
              @mouseenter="enter($event, row, { label: STATE_LABELS[row.item.state], start: row.start, end: row.end, text: status(row).text, live: row.item.state === 'running' })"
              @mouseleave="hide(row)">
              <span class="wf-name-line"><i v-if="row.item.state === 'running'" class="wf-spinner" aria-hidden="true"></i><strong>{{ bridge.display_name(row.item.member) }}</strong><em v-for="mark in role_marks(row)" :key="mark" class="wf-pill is-role">{{ mark }}</em><em v-if="summary.slowest?.row === row.key" class="wf-pill is-slowest">最慢</em></span>
              <span class="wf-status" :class="`is-${status(row).tone}`"><i v-if="status(row).tone === 'live'" class="wf-live-dot" aria-hidden="true"></i>{{ status(row).text }}</span>
            </button>
          </div>
          <div class="wf-lane" role="img" :aria-label="row_label(row)" @mouseleave="hide(row)"><div class="wf-track">
            <i v-for="tick in shown_ticks" :key="tick.at" class="wf-gridline" :style="{ left: `${tick.x * 100}%` }"></i>
            <i v-for="fold in axis.folds" :key="fold.start" class="wf-fold" :style="{ left: `${fold.from * 100}%`, width: `${fold.width * 100}%` }"></i>
            <i class="wf-well"></i>
            <i v-for="(line, index) in lines.get(row.key) || []" :key="`link-${index}`" class="wf-link" :class="`is-${line.part}`"
              :data-tone="member_tone.get(line.member)" :style="{ left: `${line.x * 100}%` }"></i>
            <i v-if="now_x !== null" class="wf-cursor" :style="{ left: `${now_x * 100}%` }"></i>
            <i class="wf-bar is-queue" :style="place(...row.queue)" @mouseenter="enter($event, row, { label: '排队', start: row.queue[0], end: row.queue[1] })" @click="tap($event, row, { label: '排队', start: row.queue[0], end: row.queue[1] })"></i>
            <i v-if="row.wake" class="wf-bar is-wake" :style="place(...row.wake)"
              @mouseenter="enter($event, row, { label: row.wake_approx ? '唤醒（约）' : '唤醒', start: row.wake[0], end: row.wake[1] })" @click="tap($event, row, { label: row.wake_approx ? '唤醒（约）' : '唤醒', start: row.wake[0], end: row.wake[1] })"></i>
            <i v-if="row.work" class="wf-bar is-work" :class="{ 'has-detail': row.segments.length }" :data-tone="row.segments.length ? undefined : member_tone.get(row.item.member)" :style="place(...row.work)"
              @mouseenter="enter($event, row, { label: row.segments.length ? '执行' : '执行 · 无阶段明细', start: row.work[0], end: row.work[1], live: row.item.state === 'running' })" @click="tap($event, row, { label: row.segments.length ? '执行' : '执行 · 无阶段明细', start: row.work[0], end: row.work[1], live: row.item.state === 'running' })"></i>
            <template v-for="segment in row.segments" :key="segment.start + segment.phase">
              <i class="wf-bar wf-seg" :class="[`is-${PHASE_KINDS[segment.phase]}`, { 'is-live': segment.live }]" :data-tone="member_tone.get(row.item.member)"
                :style="place(segment.start, segment.seen, true)" @mouseenter="enter($event, row, { kind: 'segment', ...segment })" @click="tap($event, row, { kind: 'segment', ...segment })"></i>
              <i v-if="segment.end > segment.seen" class="wf-bar wf-seg is-tail" :class="`is-${PHASE_KINDS[segment.phase]}`" :data-tone="member_tone.get(row.item.member)"
                :style="place(segment.seen, segment.end)" @mouseenter="enter($event, row, { kind: 'segment', ...segment })" @click="tap($event, row, { kind: 'segment', ...segment })"></i>
            </template>
            <button v-for="note in row.notes" :key="`note-${note.index}`" type="button" class="wf-note" :style="{ left: `${axis.x(note.at) * 100}%` }"
              :aria-label="`${bridge.display_name(row.item.member)} 的第 ${note.index + 1} 段过程说明，${clock(note.at)}`"
              @mouseenter="enter($event, row, { note, start: note.at, end: note.at })" @click="tap($event, row, { note, start: note.at, end: note.at })" @focus="enter($event, row, { note, start: note.at, end: note.at })" @blur="hide(row)"></button>
          </div></div>
          <span class="wf-end">{{ format_duration(row.end - row.start) }}{{ row.wake_approx && row.wake ? '~' : '' }}<small v-if="row.item.state !== 'done'" :class="`is-${row.item.state}`">{{ STATE_LABELS[row.item.state] }}</small><small v-if="row.truncated">明细已截断</small></span>
        </div>
      </div>
      <div v-if="opened_row && detail_anchor" class="wf-detail" role="dialog" :aria-label="`${bridge.display_name(opened_row.item.member)} 的这次执行`"
        :style="{ top: `${detail_anchor.top}px`, left: `${detail_anchor.left}px` }">
        <header class="wf-detail-head"><strong>{{ bridge.display_name(opened_row.item.member) }}</strong><small>{{ role_label(opened_row) }} · {{ STATE_LABELS[opened_row.item.state] }} · {{ format_duration(opened_row.end - opened_row.start) }}</small>
          <button type="button" class="wf-card-close" aria-label="关闭" @click="opened = ''"><UIcon name="i-lucide-x" /></button></header>
        <dl>
          <div v-if="opened_row.item.task"><dt>任务</dt><dd>{{ opened_row.item.task }}<button v-if="opened_row.item.task_id" type="button" class="subtle-link" @click="emit('detail', opened_row.item.task_id)">#{{ opened_row.item.task_id }}</button></dd></div>
          <div v-if="opened_row.item.state === 'failed'"><dt>失败原因</dt><dd class="is-failed">{{ opened_row.item.reason || '执行失败' }}</dd></div>
          <div v-else-if="opened_row.item.result || opened_row.item.answer_id"><dt>结果</dt><dd>{{ opened_row.item.result }}<button v-if="opened_row.item.answer_id" type="button" class="subtle-link" @click="emit('detail', opened_row.item.answer_id)">在消息中查看 #{{ opened_row.item.answer_id }}</button></dd></div>
          <div v-if="opened_row.item.changes"><dt>改动</dt><dd>{{ opened_row.item.changes }} 个文件</dd></div>
        </dl>
        <ol v-if="opened_log.length" class="wf-log" aria-label="过程">
          <li v-for="entry in opened_log" :key="`${entry.kind}-${entry.at}-${entry.phase || ''}`" :class="`log-${entry.kind}`">
            <time>{{ clock(entry.at) }}</time>
            <template v-if="entry.kind === 'phase'"><i class="wf-swatch" :class="`is-${PHASE_KINDS[entry.phase]}`" :data-tone="member_tone.get(opened_row.item.member)" aria-hidden="true"></i><span>{{ PHASE_LABELS[entry.phase] }}<template v-if="entry.tool"> · {{ entry.tool }}</template> · {{ entry.live ? '进行中' : format_duration(entry.duration) }}</span></template>
            <span v-else class="wf-log-note">{{ entry.text }}</span>
          </li>
        </ol>
        <p v-else class="fine-print">这次执行没有阶段明细或过程说明。</p>
      </div>
      <div v-if="run_shown !== ALL" class="wf-player">
        <template v-if="base_live">
          <span class="wf-state is-live">实时</span><span class="wf-player-note">这一轮结束后可以回放</span>
        </template>
        <template v-else>
          <button type="button" class="wf-player-button" :aria-label="replay.playing ? '暂停回放' : '回放这一轮'" @click="replay.playing ? pause() : play()">
            <UIcon :name="replay.playing ? 'i-lucide-pause' : 'i-lucide-play'" />
          </button>
          <button type="button" class="wf-player-button" aria-label="从头回放" :disabled="!replaying" @click="restart"><UIcon name="i-lucide-rotate-ccw" /></button>
          <select v-model.number="replay.speed" class="wf-speed" aria-label="回放速度">
            <option :value="0">自动 · {{ Math.round(auto_speed) }}×</option>
            <option v-for="speed in REPLAY_SPEEDS" :key="speed" :value="speed">{{ speed }}×</option>
          </select>
          <input type="range" class="wf-scrub" min="0" :max="bounds.duration" step="100" :value="replaying ? replay.position : bounds.duration"
            aria-label="回放位置" @input="scrub" />
          <span class="wf-player-time">{{ format_duration(replaying ? replay.position : bounds.duration) }} / {{ format_duration(bounds.duration) }}</span>
        </template>
      </div>
      <footer v-if="axis.folds.length || timeline.executions.length >= timeline.execution_limit" class="wf-foot">
        <span v-if="axis.folds.length"><i class="wf-swatch is-fold" aria-hidden="true"></i>已折叠 {{ axis.folds.length }} 段超过 {{ FOLD_GAP_MS / 60000 }} 分钟的空闲</span>
        <span v-if="timeline.executions.length >= timeline.execution_limit">只列出最近 {{ timeline.execution_limit }} 次讨论执行与 {{ timeline.execution_limit }} 次协作执行</span>
      </footer>
    </div>
    <div v-if="hover" class="wf-card" :class="{ 'is-pinned': hover.pinned }" :role="hover.pinned ? 'dialog' : 'tooltip'" :style="{ left: `${hover.left}px`, top: `${hover.top}px` }">
      <strong>{{ bridge.display_name(hover.row.item.member) }} · {{ hover_title }}</strong>
      <button v-if="hover.pinned" type="button" class="wf-card-close" aria-label="关闭" @click="hover = null"><UIcon name="i-lucide-x" /></button>
      <small>{{ clock(hover.piece.start) }}<template v-if="hover.piece.end > hover.piece.start"> – {{ hover.piece.live ? '现在' : clock(hover.piece.end) }}</template></small>
      <p v-if="hover.piece.text" class="wf-card-text">{{ hover.piece.text }}</p>
      <p v-else-if="hover.row.item.reason" class="wf-card-reason">{{ hover.row.item.reason }}</p>
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
   edges and the accent are this site's own channel tokens. Bars take their member's hue (one lightness per theme, so no
   member outshouts another and none reads as a status: green, amber and red are kept for done, warning and failure),
   shaded by kind as a trace does. */
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
  --wf-wake: light-dark(oklch(0.70 0.12 75), oklch(0.78 0.11 75));
  --wf-work: color-mix(in oklab, var(--ui-text) 26%, var(--wf-surface));
  /* Member identity, as FlowWaterfall's lane hues: one lightness and a moderate chroma, no green, amber or red. An execution
     without phases is drawn as a tint of its member's hue with an outline in it, so it never reads as a solid phase bar. */
  --wf-h1: light-dark(oklch(0.55 0.11 255), oklch(0.70 0.11 255));
  --wf-h2: light-dark(oklch(0.55 0.11 300), oklch(0.70 0.11 300));
  --wf-h3: light-dark(oklch(0.55 0.11 335), oklch(0.70 0.11 335));
  --wf-h4: light-dark(oklch(0.55 0.11 215), oklch(0.70 0.11 215));
  --wf-h5: light-dark(oklch(0.55 0.03 255), oklch(0.70 0.03 255));
  --wf-bar-h: 20px;
  --wf-row-h: 44px;
  --wf-label-col: minmax(200px, 340px);
  position: relative;
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
/* A replay is not live work: it says so, and at what time of the run it stands, so its "running" rows are not mistaken. */
.wf-state.is-replay { background: color-mix(in oklab, var(--wf-warn) 14%, transparent); color: var(--wf-warn); font-family: var(--wf-mono); font-variant-numeric: tabular-nums; }
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
/* A zero is an answer, not news: it stays legible but steps back so the counts that matter stand out. */
.wf-summary dd.is-zero { color: var(--wf-muted); font-weight: 400; }

/* Legend: one row of swatches, as the bars draw them. */
.wf-legend { display: flex; flex-wrap: wrap; gap: 4px 14px; margin: 0; padding: 8px 16px; border-bottom: 1px solid var(--wf-border); color: var(--wf-muted); font-size: 12px; list-style: none; }
.wf-legend li { display: inline-flex; align-items: center; gap: 6px; }
.wf-legend li.wf-legend-note { color: var(--wf-muted); opacity: .8; }
.wf-swatch { display: inline-block; flex: none; width: 12px; height: 8px; border-radius: 2px; }
.wf-swatch.is-note-mark { width: 2px; height: 12px; border-radius: 1px; background: var(--wf-text); }
.wf-swatch.is-failed-mark { box-shadow: inset 0 0 0 1.5px var(--wf-failed); background: color-mix(in oklab, var(--wf-failed) 20%, transparent); }
.wf-swatch.is-fold { background: repeating-linear-gradient(-45deg, var(--wf-hatch) 0 1px, transparent 1px 4px); box-shadow: inset 0 0 0 1px var(--wf-guide); }

/* Grid: the label column, the lanes and the duration column share one template, the axis included. */
.wf-grid { display: grid; grid-template-columns: var(--wf-label-col) minmax(0, 1fr) 84px; }
/* The axis row stays in view while the rows scroll under it. */
.wf-axis-label, .wf-axis, .wf-axis-end { position: sticky; top: 0; z-index: 3; background: var(--wf-surface); }
/* The axis keeps side margins to line up with the tracks; its shadow fills them, so rows never show through. */
.wf-axis { box-shadow: -12px 0 0 var(--wf-surface), 12px 0 0 var(--wf-surface); }
.wf-axis-label { display: flex; align-items: center; gap: 8px; min-width: 0; height: 32px; padding: 0 12px 0 16px; border-right: 1px solid var(--wf-border); border-bottom: 1px solid var(--wf-border); color: var(--wf-muted); font-size: 12px; }
.wf-branch { display: flex; gap: 2px; margin-left: auto; }
.wf-text-button { height: 22px; padding: 0 6px; border: 0; border-radius: 4px; background: transparent; color: var(--wf-muted); font: inherit; cursor: pointer; white-space: nowrap; }
.wf-text-button:hover { background: var(--wf-hover); color: var(--wf-text); }
.wf-axis { position: relative; height: 32px; margin: 0 12px; border-bottom: 1px solid var(--wf-border); color: var(--wf-muted); font-family: var(--wf-mono); font-size: 11px; }
.wf-tick { position: absolute; top: 50%; padding-left: 4px; border-left: 1px solid var(--wf-guide); line-height: 14px; white-space: nowrap; transform: translateY(-50%); font-variant-numeric: tabular-nums; }
/* A folded idle stretch says how long it was right on the axis, so evenly spaced ticks are never read as even time. */
.wf-fold-label { position: absolute; top: 50%; padding: 0 4px; border-radius: 4px; background: var(--wf-surface); color: var(--wf-muted); font-size: 10px; line-height: 14px; white-space: nowrap; transform: translate(-50%, -50%); cursor: help; z-index: 1; }
.wf-run { position: relative; display: inline-flex; align-items: center; min-width: 0; max-width: min(420px, 100%); }
.wf-run-select { min-width: 0; max-width: 100%; height: 26px; padding: 0 26px 0 10px; overflow: hidden; border: 1px solid var(--wf-border); border-radius: 6px;
  background: var(--wf-well); color: var(--wf-text); font: inherit; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; appearance: none; cursor: pointer; }
.wf-run-select:focus-visible { outline: 2px solid var(--wf-accent); outline-offset: 1px; }
/* A styled select loses the native dark list on Windows, which falls back to white behind light text: the options are
   given the theme's own colors. */
.wf-run-select option, .wf-speed option { background: var(--ui-bg-elevated); color: var(--ui-text); }
.wf-run-icon { position: absolute; right: 8px; width: 12px; height: 12px; color: var(--wf-muted); pointer-events: none; }
/* Now, while work runs: a dot on the axis and a line down through every lane; bars grow up to it, free room lies past it. */
.wf-cursor-head { position: absolute; bottom: -5px; width: 9px; height: 9px; border-radius: 50%; background: var(--wf-text); box-shadow: 0 0 0 2px var(--wf-surface); transform: translateX(-50%); z-index: 2; }
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
/* A running row says so before its name; the ring gives way to nothing once it ends, the avatar already says who. */
.wf-spinner { flex: none; align-self: center; width: 10px; height: 10px; border: 1.5px solid color-mix(in oklab, var(--wf-accent) 30%, transparent); border-top-color: var(--wf-accent); border-radius: 50%; animation: wf-spin .8s linear infinite; }
.wf-name-line strong { overflow: hidden; color: var(--wf-text); font-size: 13px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.wf-pill { flex: none; height: 16px; padding: 0 6px; border-radius: 999px; font-size: 11px; font-style: normal; font-weight: 600; line-height: 16px; }
.wf-pill.is-role { background: var(--wf-well); color: var(--wf-muted); font-weight: 500; }
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
.wf-cursor { top: 0; bottom: 0; width: 1px; background: color-mix(in oklab, var(--wf-text) 70%, transparent); z-index: 2; pointer-events: none; }
/* Hand-off: from a dot on the dispatcher's bar at the moment of dispatch, a line in the dispatched member's hue runs down
   through the rows between and turns into the dispatched bar. Drawn over bars, as the delegation is what it shows. */
.wf-link { width: 0; border-left: 1.5px solid var(--tone, var(--wf-muted)); opacity: .8; z-index: 1; pointer-events: none; }
.wf-link.is-through { top: 0; bottom: 0; }
.wf-link.is-start { top: 50%; bottom: 0; }
.wf-link.is-start::before { position: absolute; top: -4px; left: -4.75px; width: 8px; height: 8px; border-radius: 50%; background: var(--tone, var(--wf-muted)); box-shadow: 0 0 0 2px var(--wf-surface); content: ""; }
.wf-link.is-end { top: 0; width: 8px; height: 50%; border-bottom: 1.5px solid var(--tone, var(--wf-muted)); border-bottom-left-radius: 6px; }
/* Folded idle time is a faint band only: its edges would read as more gridlines. */
.wf-fold { top: 0; bottom: 0; background: color-mix(in oklab, var(--ui-text) 4%, transparent); }
.wf-well { top: calc(50% - var(--wf-bar-h) / 2); right: 0; left: 0; height: var(--wf-bar-h); border-radius: 4px; background: var(--wf-well); }
.wf-bar { top: calc(50% - var(--wf-bar-h) / 2); height: var(--wf-bar-h); min-width: 2px; border-radius: 4px; transition: filter 120ms ease; }
.wf-bar:hover { z-index: 1; filter: brightness(1.15); box-shadow: 0 0 0 2px color-mix(in oklab, var(--wf-text) 30%, transparent); }
.wf-bar.is-queue { background: repeating-linear-gradient(-45deg, var(--wf-hatch) 0 1px, transparent 1px 5px); box-shadow: inset 0 0 0 1px var(--wf-hatch); }
.wf-bar.is-wake { background: color-mix(in oklab, var(--wf-wake) 55%, var(--wf-surface)); box-shadow: inset 0 0 0 1px var(--wf-wake); }
.wf-bar.is-work { background: var(--wf-work); box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--ui-text) 16%, transparent); }
/* A member's hue, on every mark that belongs to it: its bars, its phases, its hand-off line. */
.wf [data-tone="1"] { --tone: var(--wf-h1); }
.wf [data-tone="2"] { --tone: var(--wf-h2); }
.wf [data-tone="3"] { --tone: var(--wf-h3); }
.wf [data-tone="4"] { --tone: var(--wf-h4); }
.wf [data-tone="5"] { --tone: var(--wf-h5); }
.wf-bar.is-work[data-tone] { background: color-mix(in oklab, var(--tone) 32%, var(--wf-surface)); box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--tone) 70%, transparent); }
/* With phases recorded, the execution's own extent is only a faint frame under them. */
.wf-bar.is-work.has-detail { background: color-mix(in oklab, var(--ui-text) 5%, transparent); }
.is-failed .wf-bar.is-work { background: color-mix(in oklab, var(--wf-failed) 22%, var(--wf-surface)); box-shadow: inset 0 0 0 1px var(--wf-failed); }
/* What is still growing fades out at its leading edge, as a trace draws running spans, instead of blinking. */
.is-running .wf-bar.is-work:not(.has-detail), .wf-seg.is-live:not(.is-tail) { -webkit-mask-image: linear-gradient(90deg, #000 calc(100% - 24px), rgb(0 0 0 / .35));
  mask-image: linear-gradient(90deg, #000 calc(100% - 24px), rgb(0 0 0 / .35)); }
/* Past the last output the phase is only assumed to go on; a long faint tail is what a stalled execution looks like. */
.wf-seg.is-tail { min-width: 0; border-radius: 0 4px 4px 0; opacity: .28; }
/* Kind is a shade of the member's hue: the model's own turns in the full hue, tool work a lighter step with an edge. */
.is-model { background: var(--tone, var(--wf-work)); }
.is-tool { background: color-mix(in oklab, var(--tone, var(--wf-work)) 45%, var(--wf-surface)); box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--tone, var(--wf-work)) 65%, transparent); }
.wf-swatch.is-model { --tone: var(--wf-muted); }
.wf-swatch.is-tool { --tone: var(--wf-muted); }
.wf-swatch.is-handoff { width: 10px; height: 8px; border-bottom: 1.5px solid var(--wf-muted); border-left: 1.5px solid var(--wf-muted); border-radius: 0 0 0 3px; }
.wf-swatch.is-queue { background: repeating-linear-gradient(-45deg, var(--wf-hatch) 0 1px, transparent 1px 4px); box-shadow: inset 0 0 0 1px var(--wf-hatch); }
.wf-swatch.is-wake { background: color-mix(in oklab, var(--wf-wake) 55%, var(--wf-surface)); box-shadow: inset 0 0 0 1px var(--wf-wake); }
.wf-swatch.is-work { background: color-mix(in oklab, var(--wf-muted) 32%, var(--wf-surface)); box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--wf-muted) 70%, transparent); }
/* A note is a hairline inside the bar's height: it marks a moment, and must never outshout the work it annotates.
   Its hit area is wider than it looks. */
.wf-note { top: calc(50% - var(--wf-bar-h) / 2); width: 9px; height: var(--wf-bar-h); margin-left: -4px; padding: 0; border: 0; background: linear-gradient(var(--wf-text), var(--wf-text)) center / 1.5px 100% no-repeat; opacity: .35; cursor: help; z-index: 2; }
.wf-note:hover, .wf-note:focus-visible { opacity: 1; }
.wf-row:hover .wf-note { opacity: .6; }

/* Duration column: tabular figures, the state under it when it is not a plain finish. */
.wf-end { display: flex; flex-direction: column; align-items: flex-end; justify-content: center; padding-right: 16px; font-family: var(--wf-mono); font-size: 12px; line-height: 16px; font-variant-numeric: tabular-nums; }
.wf-end small { color: var(--wf-muted); font-family: var(--ui-font-sans, inherit); font-size: 11px; }
.wf-end small.is-failed { color: var(--wf-failed); }
.wf-end small.is-running { color: var(--wf-accent); }

/* Detail: an inset well under the opened row, aligned with its name. */
/* Detail: a panel floating under the opened name, as a trace's popover; the waterfall below stays whole. */
.wf-detail { position: absolute; z-index: 20; width: min(560px, calc(100% - 16px)); max-height: min(60vh, 520px); padding: 12px 14px; overflow: auto;
  border: 1px solid var(--channel-edge-float, var(--wf-border)); border-radius: 10px; background: var(--ui-bg-elevated); box-shadow: var(--channel-shadow-float, 0 12px 32px rgb(0 0 0 / .3)); font-size: 13px; }
.wf-detail-head { position: relative; display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; margin: 0 0 10px; padding-right: 32px; }
.wf-detail-head strong { color: var(--wf-text); font-size: 14px; }
.wf-detail-head small { color: var(--wf-muted); font-size: 12px; }
.wf-detail .wf-card-close { top: -6px; right: -6px; }
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

/* Playback: replay a finished run on the same drawing; while a run is live, only a "实时" pill. */
.wf-player { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; padding: 8px 16px; border-top: 1px solid var(--wf-border); color: var(--wf-muted); font-size: 12px; }
.wf-player-note { color: var(--wf-muted); }
.wf-player-button { display: grid; place-items: center; width: 28px; height: 28px; padding: 0; border: 1px solid var(--wf-border); border-radius: 50%; background: var(--wf-surface); color: var(--wf-text); cursor: pointer; }
.wf-player-button:disabled { opacity: .4; cursor: default; }
.wf-player-button:not(:disabled):hover { background: var(--wf-hover); }
.wf-player-button :deep(svg) { width: 13px; height: 13px; }
.wf-speed { height: 28px; padding: 0 8px; border: 1px solid var(--wf-border); border-radius: 6px; background: var(--wf-well); color: var(--wf-text); font: inherit; font-size: 12px; cursor: pointer; }
.wf-scrub { flex: 1; min-width: 120px; accent-color: var(--wf-accent); cursor: pointer; }
.wf-player-time { font-family: var(--wf-mono); font-variant-numeric: tabular-nums; white-space: nowrap; }
.wf-player :is(button, select, input):focus-visible { outline: 2px solid var(--wf-accent); outline-offset: 1px; }
.wf-foot { display: flex; flex-wrap: wrap; gap: 4px 20px; padding: 8px 16px; border-top: 1px solid var(--wf-border); color: var(--wf-muted); font-size: 12px; }
.wf-foot span { display: inline-flex; align-items: center; gap: 6px; }

/* Hover card: what the piece was, when, and the notes written around then. */
.wf-card { position: fixed; z-index: 50; display: grid; gap: 4px; width: min(360px, calc(100vw - 16px)); max-height: 50vh; padding: 10px 12px; overflow: auto; border: 1px solid var(--channel-edge-float, var(--ui-border)); border-radius: 8px; background: var(--ui-bg-elevated); box-shadow: var(--channel-shadow-float, 0 8px 24px rgb(0 0 0 / .25)); color: var(--ui-text); font-size: 12px; pointer-events: none; }
/* A card pinned by a tap takes touches, so its notes scroll and it can be closed. */
.wf-card.is-pinned { padding-right: 36px; pointer-events: auto; }
.wf-card-close { position: absolute; top: 4px; right: 4px; display: grid; place-items: center; width: 32px; height: 32px; padding: 0; border: 0; border-radius: 6px; background: transparent; color: var(--ui-text-muted); cursor: pointer; }
.wf-card strong { color: var(--ui-text-highlighted); font-size: 13px; }
.wf-card small { color: var(--ui-text-muted); font-variant-numeric: tabular-nums; }
.wf-card-reason { margin: 2px 0 0; color: var(--ui-error); }
/* Over a name the card carries the whole status line the row could only truncate. */
.wf-card-text { margin: 2px 0 0; color: var(--ui-text-highlighted); line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; }
.wf-card-label { margin-top: 4px; }
.wf-card ol { display: grid; gap: 6px; margin: 0; padding: 0; line-height: 1.6; list-style: none; white-space: pre-wrap; overflow-wrap: anywhere; }
.wf-card time { margin-right: 6px; color: var(--ui-text-dimmed); font-variant-numeric: tabular-nums; }

@keyframes wf-pulse { 50% { opacity: .55; } }
/* A row that appears while watching unfolds into place; a changed count rolls in from below. */
.wf-row.is-entering > :not(.wf-detail) { animation: wf-enter 420ms cubic-bezier(.2, .8, .2, 1) both; }
.wf-roll { display: inline-block; animation: wf-roll 320ms cubic-bezier(.2, .8, .2, 1); }
@keyframes wf-enter { from { opacity: 0; transform: translateY(6px); } }
@keyframes wf-roll { from { opacity: 0; transform: translateY(45%); } }
@keyframes wf-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .wf * { animation: none !important; transition: none !important; } }
/* Sizes follow the page's own width, not the screen's: on a tablet the channel rails take part of it.
   Tablets: a shorter label column and the KPI row in two lines of three. */
.execution-timeline { container: wf / inline-size; }
@container wf (max-width: 900px) {
  .wf { --wf-label-col: minmax(160px, 220px); }
  .wf-summary { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .wf-summary > div:nth-child(4) { border-left: 0; }
  .wf-summary > div:nth-child(n + 4) { border-top: 1px solid var(--wf-border); }
  .wf-grid { grid-template-columns: var(--wf-label-col) minmax(0, 1fr) 72px; }
  .wf-end { padding-right: 12px; }
}
/* Phones: three columns leave a bar no room, so each execution takes two lines: who and how it is going across the
   full width, then its bar across the full width with the duration beside it. */
@container wf (max-width: 640px) {
  .wf-head, .wf-legend, .wf-foot { padding-inline: 12px; }
  .wf-summary > div { padding: 8px 12px; }
  .wf-summary dd { font-size: 15px; }
  .wf-grid { grid-template-columns: minmax(0, 1fr) 64px; }
  /* Stacked rows put a label line between lanes, which would break a hand-off line; the rows' indents show it instead. */
  .wf-axis-label, .wf-fold-label, .wf-link { display: none; }
  .wf-run { max-width: 100%; flex-basis: 100%; }
  .wf-row > .wf-label { grid-column: 1 / -1; min-height: 0; padding: 6px 12px 0 calc(12px + var(--depth) * var(--wf-depth-px)); border-top: 1px solid var(--wf-border); border-right: 0; }
  .wf-row > .wf-lane, .wf-row > .wf-end { min-height: 32px; }
  .wf-end { padding-right: 12px; }
}
/* Touch: controls keep their look but take a fingertip; a note's tick is easier to hit. */
@media (pointer: coarse) {
  .wf-toggle { flex: 0 0 32px; width: 32px; height: 32px; margin: -8px; }
  .wf-text-button { height: 32px; }
  .wf-note { width: 24px; margin-left: -12px; }
}
</style>

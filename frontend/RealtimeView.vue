<script setup>
import { t, locale } from './i18n.js';
/**
 * The room in real time (2026-11-23 user's request, #8032): one left-to-right axis, nothing folded, so idle and waiting
 * keep their true length. Above the axis, how many members worked at once, stacked by member in their timeline hues;
 * idle stretches are shaded and labelled. Below it, the tasks as bands; a band opens its task on the timeline.
 * Zoom, pan and replay as the timeline has them (#8041): Ctrl + wheel, two fingers or the buttons zoom, a drag or Shift + wheel pans,
 * a double click shows it all; the replay draws the room up to a moving position, about 20 seconds end to end at "auto".
 * Input: `segments` (the timeline's tasks with the owner's rows), `tones` (member → hue number), `name` (member → label).
 * Emits `open` with a task's key; pointing at or tapping a block emits `hover`, `leave` or `pick` with the row key of the
 * execution it stands for and the event, so the timeline's own detail card opens on it.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { FOLLOW_AT, axis_ticks, format_duration, pan_window, realtime_model, replay_follow_window, step_follow_window, zoom_window } from "./timeline-model.js";
import { touch_zoom } from "./touch-zoom.js";

const props = defineProps({ segments: { type: Array, required: true }, tones: { type: Map, required: true }, name: { type: Function, required: true } });
const emit = defineEmits(["open", "hover", "leave", "pick"]);
// About this many candidate clock ticks across the axis; pixel-clearance filtering drops any that would crowd a narrow chart.
const TICK_COUNT = 8;
// An idle stretch narrower than this share of the width carries no label.
const LABEL_MIN_SHARE = 0.06;
// A task band shows its text from this many pixels wide, about two characters (#8077: too little text showed).
const TASK_LABEL_MIN_PX = 26;
// Markdown marks at the start of a task's message say nothing on a band.
const MARKDOWN_MARKS = /[*_`#>~]+/g;
// An axis over this long crosses days, so its ticks carry the date.
const DATED_SPAN_MS = 20 * 3600_000;
// One wheel notch (about 100 px of delta) zooms by roughly 16%; a button press by this factor.
const WHEEL_ZOOM_RATE = 0.0015;
const BUTTON_ZOOM = 0.5;
// A replay at "auto" lasts about this long; the other speeds are multiples of real time.
const REPLAY_TARGET_MS = 20_000;
const REPLAY_SPEEDS = [0, 60, 600, 3600];
const WHOLE = { from: 0, span: 1 };

const model = computed(() => realtime_model(props.segments));
const span = computed(() => Math.max(1, model.value.end - model.value.start));
const zoom = ref(WHOLE);
const zoomed = computed(() => zoom.value.span < 1);
// Where a time sits in the view: 0 the left edge, 1 the right; outside the view falls beyond and is clipped.
const x = (time) => ((time - model.value.start) / span.value - zoom.value.from) / zoom.value.span;
const shown_span = computed(() => span.value * zoom.value.span);
// Rough width of a tick label plus breathing room, in pixels (covers dated labels like "11/22 02:00").
const TICK_CHAR_PX = 6.5;
const TICK_PAD_PX = 14;
const ticks = computed(() => {
  const width = chart_width.value || 600;
  const raw = axis_ticks({ total_ms: span.value, busy_ms: span.value, x: (time) => (time - model.value.start) / span.value,
    spans: [{ start: model.value.start, end: model.value.end, from: 0, width: 1 }] }, TICK_COUNT, zoom.value)
    .map((tick) => ({ ...tick, x: (tick.x - zoom.value.from) / zoom.value.span }));
  // Check every adjacent tick against real pixel clearance so dated labels never collide or clip on phones (#8454, #8966).
  const kept = [];
  let prev_right = -Infinity;
  for (const tick of raw) {
    const label_share = (tick_label(tick).length * TICK_CHAR_PX + TICK_PAD_PX) / width;
    const end = tick.x + label_share > 1;
    const left = end ? tick.x - label_share : tick.x;
    const right = end ? tick.x : tick.x + label_share;
    if (left < 0 || right > 1 || left < prev_right) continue;
    kept.push({ ...tick, end });
    prev_right = right;
  }
  return kept;
});
const tick_label = (tick) => new Date(tick.at).toLocaleString(locale, { hour: "2-digit", minute: "2-digit", ...(tick.seconds ? { second: "2-digit" } : {}),
  ...(shown_span.value >= DATED_SPAN_MS ? { month: "numeric", day: "numeric" } : {}), hour12: false });
const when = (ms) => new Date(ms).toLocaleString(locale, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });

// Replay: `position` is a time on the axis (null: not replaying); what began after it is not drawn yet.
const position = ref(null);
const playing = ref(false);
const speed = ref(0);
let frame = 0;
let last_frame = 0;
const cut = computed(() => position.value ?? Infinity);
const until = (end) => Math.min(end, cut.value);
const place = (start, end) => ({ left: `${x(start) * 100}%`, width: `${(x(until(end)) - x(start)) * 100}%` });
const wide = (start, end) => x(until(end)) - x(start) >= LABEL_MIN_SHARE;
/** A task band drawn only where it is in view, so its text always begins on screen and zooming in reveals more of it. */
const band = (task) => {
  const left = Math.max(0, x(task.start)), right = Math.min(1, x(until(task.end)));
  return { left, width: Math.max(0, right - left) };
};
const band_text = (task) => (task.task || t('（没有记录起因）')).replace(MARKDOWN_MARKS, "").replace(/\s+/g, " ").trim();
const chart_width = ref(0);
let resize_observer = null;
onMounted(() => {
  resize_observer = new ResizeObserver(([entry]) => { chart_width.value = entry.contentRect.width; });
  resize_observer.observe(chart.value);
});
onBeforeUnmount(() => resize_observer?.disconnect());
const seen = (items) => items.filter((item) => item.start < cut.value);
/** Each working step as stacked blocks, one per member, bottom up; heights are shares of the peak. */
const blocks = computed(() => seen(model.value.steps.filter((step) => step.total)).flatMap((step) => {
  let below = 0;
  return step.members.map((entry) => {
    // A member running twice at once stands for the one that began last.
    const block = { key: `${step.start}:${entry.member}`, tone: props.tones.get(entry.member), row: entry.keys.at(-1),
      style: { ...place(step.start, step.end), bottom: `${below / model.value.peak * 100}%`, height: `${entry.count / model.value.peak * 100}%` } };
    below += entry.count;
    return block;
  });
}));
// The two figures this view is opened for (#8279) lead: how much of the span the room worked by itself, and how many of
// its executions started without the owner; idle shows in the chart as hatching.
const percent = (part, whole) => (whole ? Math.round(part / whole * 100) : 0);
const summary = computed(() => [
  { text: t('自动执行 {value1}（占 {value2}%）', { value1: format_duration(model.value.busy_ms), value2: percent(model.value.busy_ms, span.value) }), lead: true,
    title: t('有成员在执行的时长占整个跨度的比例；其余是房间空闲、等你回应的时间') },
  { text: t('无需介入 {value1}/{value2} 次（{value3}%）', { value1: model.value.self_started, value2: model.value.runs, value3: percent(model.value.self_started, model.value.runs) }), lead: true,
    title: t('不是由你的消息触发、而是由主持人派活、接力、交回或程序唤醒自动接上的执行') },
  ...(model.value.unattended ? [{ text: t('最长无人值守 {value1}', { value1: format_duration(model.value.unattended.end - model.value.unattended.start) }), lead: true,
    title: t('从你的一条消息起，到房间停下或你再次发消息为止，AI 连续自动推进最久的一段：{value1} – {value2}', { value1: when(model.value.unattended.start), value2: when(model.value.unattended.end) }) }] : []),
  { text: t('跨度 {value1}', { value1: format_duration(span.value) }) },
  { text: t('最多同时 {value1} 位', { value1: model.value.peak }) },
]);

const chart = ref(null);
const drag = ref(false);
let press = null;
// A press must move this far before it pans.
const DRAG_START_PX = 5;
const touch = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches === true;
/** Where the pointer is across the chart, as a share of the view, and the chart's width. */
function pointer_share(event) {
  const rect = chart.value.getBoundingClientRect();
  return { share: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)), width: rect.width };
}
function manual_zoom(next) {
  auto_zoom.value = false;
  zoom.value = next;
  if (!zoomed.value) follow.value = false;
  else sync_follow(0);
}
function reset_zoom() {
  auto_zoom.value = false;
  follow.value = false;
  zoom.value = WHOLE;
}
function on_wheel(event) {
  if (event.ctrlKey || event.metaKey) {
    event.preventDefault();
    manual_zoom(zoom_window(zoom.value, pointer_share(event).share, Math.exp(event.deltaY * WHEEL_ZOOM_RATE), span.value));
  } else if (zoomed.value && (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY))) {
    event.preventDefault();
    follow.value = false;
    auto_zoom.value = false;
    zoom.value = pan_window(zoom.value, (event.shiftKey ? event.deltaY : event.deltaX) / pointer_share(event).width);
  }
}
function zoom_by(factor) { manual_zoom(zoom_window(zoom.value, 0.5, factor, span.value)); }
// Fingers: pinch zooms, a sideways drag pans (touch-zoom.js); an upward or downward one scrolls the page.
const gesture = touch_zoom({ share_at: (client_x) => pointer_share({ clientX: client_x }).share, width: () => pointer_share({ clientX: 0 }).width,
  on_zoom: (anchor, factor) => { manual_zoom(zoom_window(zoom.value, anchor, factor, span.value)); },
  on_pan: (share) => { follow.value = false; auto_zoom.value = false; zoom.value = pan_window(zoom.value, share); }, can_pan: () => zoomed.value });
/**
 * A mouse press on a zoomed chart (left or middle button) pans once it has moved a few pixels, so a click on a block
 * still opens its detail.
 */
function on_drag_start(event) {
  if (event.pointerType === "touch") { if (!event.target.closest?.(".rt-task")) gesture.down(event); return; }
  if (!zoomed.value || event.button > 1 || event.target.closest?.(".rt-task")) return;
  press = { x: event.clientX, from: zoom.value.from, width: pointer_share(event).width, id: event.pointerId };
}
function on_drag_move(event) {
  if (event.pointerType === "touch") { gesture.move(event); return; }
  if (!press || event.pointerId !== press.id) return;
  if (!drag.value) {
    if (Math.abs(event.clientX - press.x) < DRAG_START_PX) return;
    drag.value = true;
    follow.value = false;
    auto_zoom.value = false;
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  zoom.value = pan_window({ from: press.from, span: zoom.value.span }, -(event.clientX - press.x) / press.width);
}
function on_drag_end(event) {
  if (event.pointerType === "touch") { gesture.up(event); return; }
  // The click that ends a drag must not open a block's detail.
  if (drag.value) setTimeout(() => { drag.value = false; });
  press = null;
}
// A middle press would start the browser's autoscroll; on a zoomed chart it pans instead.
function stop_autoscroll(event) { if (event.button === 1 && zoomed.value) event.preventDefault(); }
function pick(block, event) { if (!drag.value && !gesture.moved()) emit('pick', block.row, event); }

/**
 * Following the replay (#8323, #8678, #8701): keeps the playback line at FOLLOW_AT and dynamically adjusts zoom to
 * frame the active execution(s). Clicking 跟随 enters auto-zoom; manual zoom locks the user's scale while keeping
 * follow; manual pan or 还原 turns both off.
 */
const follow = ref(true);
const auto_zoom = ref(false);
// Highlighted only when auto-zoom follow is active, so after a manual zoom one click on 跟随 re-enters auto-zoom (#8717).
const follow_active = computed(() => follow.value && auto_zoom.value);
const raw_x = (time) => (time - model.value.start) / span.value;
const replay_spans = computed(() => props.segments.flatMap((segment) =>
  segment.items.filter(({ item }) => item.source !== "user").map(({ stages }) => ({ start: stages.start, end: stages.end }))));
function sync_follow(elapsed_ms = 0) {
  if (!follow.value || position.value == null) return;
  const share = raw_x(position.value);
  if (auto_zoom.value) {
    const target = replay_follow_window(replay_spans.value, raw_x, position.value, span.value, FOLLOW_AT);
    zoom.value = elapsed_ms > 0 ? step_follow_window(zoom.value, target, share, elapsed_ms, FOLLOW_AT) : target;
  } else if (zoomed.value) {
    zoom.value = { from: Math.min(1 - zoom.value.span, Math.max(0, share - FOLLOW_AT * zoom.value.span)), span: zoom.value.span };
  }
}
function toggle_follow() {
  if (follow_active.value) {
    follow.value = false;
    auto_zoom.value = false;
  } else {
    follow.value = true;
    auto_zoom.value = true;
    sync_follow(0);
  }
}
/** Real milliseconds of the room per millisecond of playback. */
const rate = computed(() => speed.value || span.value / REPLAY_TARGET_MS);
function tick(timestamp) {
  const elapsed = last_frame ? Math.min(timestamp - last_frame, 250) : 0;
  last_frame = timestamp;
  position.value = Math.min(model.value.end, position.value + elapsed * rate.value);
  sync_follow(elapsed);
  if (position.value >= model.value.end) { pause(); return; }
  frame = requestAnimationFrame(tick);
}
function play() {
  if (position.value == null || position.value >= model.value.end) {
    position.value = model.value.start;
    follow.value = true;
    auto_zoom.value = !zoomed.value;
  }
  sync_follow(0);
  playing.value = true;
  last_frame = 0;
  frame = requestAnimationFrame(tick);
}
function pause() { playing.value = false; cancelAnimationFrame(frame); }
function stop_replay() {
  pause();
  if (auto_zoom.value) zoom.value = WHOLE;
  auto_zoom.value = false;
  position.value = null;
}
function scrub(event) {
  position.value = model.value.start + Number(event.target.value);
  sync_follow(0);
}
const zoom_level = computed(() => (1 / zoom.value.span).toFixed(1));
const play_label = computed(() => playing.value ? t('暂停回放') : position.value == null ? t('回放') : t('继续回放'));
const speed_label = (value) => value ? t('{value1}×', { value1: value }) : t('自动');
// Another room starts over: whole view, no replay.
watch(() => props.segments[0]?.key, () => { zoom.value = WHOLE; stop_replay(); });
onBeforeUnmount(pause);
</script>

<template>
  <section class="rt" :aria-label="t('并发全景')">
    <div class="rt-bar">
      <p class="rt-summary"><span v-for="part in summary" :key="part.text" :class="{ 'is-lead': part.lead }" :title="part.title">{{ part.text }}</span></p>
      <span class="rt-tools">
        <!-- Icon and words on a wide page, the icon alone on a phone (#8456); the words stay as the title and label. -->
        <button type="button" class="rt-tool" :title="t('缩小')" :aria-label="t('缩小')" :disabled="!zoomed" @click="zoom_by(1 / BUTTON_ZOOM)"><UIcon name="i-lucide-zoom-out" /></button>
        <button type="button" class="rt-tool" :title="t('放大')" :aria-label="t('放大')" @click="zoom_by(BUTTON_ZOOM)"><UIcon name="i-lucide-zoom-in" /></button>
        <button v-if="zoomed" type="button" class="rt-tool is-text" :title="t('还原 {value1}×', { value1: zoom_level })" :aria-label="t('还原 {value1}×', { value1: zoom_level })" @click="reset_zoom">
          <UIcon name="i-lucide-locate-fixed" /><span class="rt-label">{{ t('还原 {value1}×', { value1: zoom_level }) }}</span><span class="rt-short">{{ zoom_level }}×</span></button>
        <button type="button" class="rt-tool is-text" :title="play_label" :aria-label="play_label" @click="playing ? pause() : play()">
          <UIcon :name="playing ? 'i-lucide-pause' : 'i-lucide-play'" /><span class="rt-label">{{ play_label }}</span></button>
        <button v-if="position != null" type="button" class="rt-tool is-text" :class="{ 'is-active': follow_active }" :aria-pressed="follow_active" :title="t('回放时自动缩放并跟着回放线走')" :aria-label="t('跟随')" @click="toggle_follow">
          <UIcon name="i-lucide-crosshair" /><span class="rt-label">{{ t('跟随') }}</span></button>
        <button v-if="position != null" type="button" class="rt-tool is-text" :title="t('结束回放')" :aria-label="t('结束回放')" @click="stop_replay">
          <UIcon name="i-lucide-square" /><span class="rt-label">{{ t('结束回放') }}</span></button>
      </span>
    </div>
    <div class="rt-plot" :class="{ 'is-zoomed': zoomed, 'is-dragging': drag }" @wheel="on_wheel" @dblclick="reset_zoom"
      @mousedown="stop_autoscroll" @pointerdown="on_drag_start" @pointermove="on_drag_move" @pointerup="on_drag_end" @pointercancel="on_drag_end">
      <span class="rt-scale">{{ model.peak }}</span>
      <div ref="chart" class="rt-chart">
        <i v-for="task in seen(model.tasks)" :key="`line:${task.key}`" class="rt-divider" :style="{ left: `${x(task.start) * 100}%` }"></i>
        <span v-for="gap in seen(model.idle)" :key="`idle:${gap.start}`" class="rt-idle" :style="place(gap.start, gap.end)" :title="t('空闲 {value1}', { value1: format_duration(gap.end - gap.start) })">
          <small v-if="wide(gap.start, gap.end)">{{ t('空闲 {value1}', { value1: format_duration(until(gap.end) - gap.start) }) }}</small></span>
        <i v-for="block in blocks" :key="block.key" class="rt-block" :data-tone="block.tone" :style="block.style"
          @mouseenter="emit('hover', block.row, $event)" @mouseleave="emit('leave', $event)" @click="pick(block, $event)"></i>
        <i v-if="position != null" class="rt-cursor" :style="{ left: `${x(position) * 100}%` }"></i>
      </div>
      <div class="rt-axis" aria-hidden="true">
        <span v-for="tick in ticks" :key="tick.at" class="rt-tick" :class="{ 'is-end': tick.end }" :style="{ left: `${tick.x * 100}%` }">{{ tick_label(tick) }}</span>
      </div>
      <div class="rt-tasks">
        <template v-for="task in seen(model.tasks)" :key="task.key">
          <button v-if="band(task).width > 0" type="button" class="rt-task" :style="{ left: `${band(task).left * 100}%`, width: `${band(task).width * 100}%` }"
            :title="t('{value1} · 用时 {value2}', { value1: band_text(task), value2: format_duration(task.end - task.start) })" @click="emit('open', task.key)">
            <span v-if="band(task).width * chart_width >= TASK_LABEL_MIN_PX">{{ band_text(task) }}</span></button>
        </template>
      </div>
    </div>
    <div v-if="position != null" class="rt-player">
      <span class="rt-player-time">{{ when(position) }}</span>
      <input type="range" class="rt-scrub" min="0" :max="span" step="1000" :value="position - model.start" :aria-label="t('回放位置')" @input="scrub" />
      <span class="rt-speeds" role="group" :aria-label="t('回放速度')">
        <button v-for="value in REPLAY_SPEEDS" :key="value" type="button" class="rt-tool is-text" :class="{ 'is-active': speed === value }" @click="speed = value">{{ speed_label(value) }}</button>
      </span>
    </div>
    <p class="rt-key">
      <span v-for="member in model.members" :key="member"><i class="rt-swatch" :data-tone="tones.get(member)"></i>{{ name(member) }}</span>
      <span><i class="rt-swatch is-idle"></i>{{ t('空闲') }}</span>
      <span>{{ touch ? t('上方高度为同时在执行的成员数，点色块看那次执行的详情；下方为任务分段，点任务在执行轨迹中查看') : t('上方高度为同时在执行的成员数，指向色块看那次执行的详情；下方为任务分段，点任务在执行轨迹中查看') }}</span>
      <span>{{ touch ? t('双指缩放，放大后左右拖动平移，双击还原') : t('Ctrl + 滚轮缩放，放大后左键或中键拖动、Shift + 滚轮平移，双击还原') }}</span>
    </p>
  </section>
</template>

<style scoped>
.rt { padding: 12px 16px 14px; container-type: inline-size; }
.rt-short { display: none; }
/* A phone-wide view keeps the icons; the zoom keeps its number so the level still shows. */
@container (max-width: 640px) { .rt-label { display: none; } .rt-short { display: inline; } }
.rt-bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px 12px; margin-bottom: 10px; }
.rt-summary, .rt-key { display: flex; flex-wrap: wrap; gap: 4px 14px; margin: 0; color: var(--wf-muted); font-size: 12px; }
.rt-summary { color: var(--wf-muted); font-variant-numeric: tabular-nums; }
.rt-summary .is-lead { color: var(--wf-text); font-weight: 600; }
/* On a narrow screen whole buttons wrap to the next line; their words never break (#8454). */
.rt-tools, .rt-speeds { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 4px; }
.rt-tool { display: inline-flex; align-items: center; justify-content: center; gap: 4px; flex: none; white-space: nowrap; min-width: 24px; height: 22px; padding: 0 6px; border: 1px solid var(--wf-border); border-radius: 5px; background: transparent; color: var(--wf-text);
  font: inherit; font-size: 12px; cursor: pointer; font-variant-numeric: tabular-nums; }
.rt-tool:hover:not(:disabled) { border-color: var(--wf-accent); }
.rt-tool:disabled { opacity: 0.4; cursor: default; }
.rt-tool.is-active { border-color: var(--wf-accent); color: var(--wf-accent); }
.rt-key { margin-top: 10px; align-items: center; }
.rt-key span { display: inline-flex; align-items: center; gap: 5px; }
.rt-plot { position: relative; padding-left: 22px; }
/* touch-action is not inherited, and what counts is the element the finger lands on. */
.rt-plot, .rt-plot * { touch-action: pan-y; }
.rt-plot.is-zoomed .rt-chart { cursor: grab; }
.rt-plot.is-dragging .rt-chart { cursor: grabbing; }
.rt-scale { position: absolute; top: 0; left: 0; color: var(--wf-muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.rt-chart { position: relative; height: 140px; border-bottom: 1px solid var(--wf-guide); background: var(--wf-well); overflow: hidden; user-select: none; }
.rt-block { position: absolute; min-width: 1px; background: var(--tone, var(--wf-plain)); }
.rt-block:hover { filter: brightness(1.25); }
.rt-idle { position: absolute; top: 0; bottom: 0; display: flex; align-items: center; justify-content: center; overflow: hidden;
  background: repeating-linear-gradient(135deg, transparent 0 5px, color-mix(in oklab, var(--ui-text) 8%, transparent) 5px 6px); }
.rt-idle small { color: var(--wf-muted); font-size: 11px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.rt-divider { position: absolute; top: 0; bottom: 0; width: 0; border-left: 1px dashed var(--wf-guide); }
.rt-cursor { position: absolute; top: 0; bottom: 0; width: 0; border-left: 2px solid var(--wf-accent); }
.rt-axis { position: relative; height: 20px; overflow: hidden; color: var(--wf-muted); font-size: 11px; }
.rt-tick { position: absolute; top: 3px; padding-left: 4px; border-left: 1px solid var(--wf-guide); white-space: nowrap; font-variant-numeric: tabular-nums; }
.rt-tick.is-end { padding: 0 4px 0 0; border-left: 0; border-right: 1px solid var(--wf-guide); transform: translateX(-100%); }
/* Fingers need bigger targets than the pointer. */
@media (pointer: coarse) { .rt-tool { min-width: 36px; height: 32px; padding: 0 10px; font-size: 13px; } }
.rt-tasks { position: relative; height: 20px; overflow: hidden; }
.rt-task { position: absolute; top: 0; height: 18px; min-width: 3px; padding: 0 3px; overflow: hidden; border: 1px solid var(--wf-border); border-radius: 3px;
  background: var(--wf-surface); color: var(--wf-text); font: inherit; font-size: 11px; line-height: 16px; text-align: left; white-space: nowrap; text-overflow: ellipsis; cursor: pointer; }
.rt-task:hover { border-color: var(--wf-accent); }
.rt-task span { display: block; overflow: hidden; text-overflow: ellipsis; }
.rt-player { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; margin-top: 8px; font-size: 12px; }
.rt-player-time { min-width: 90px; color: var(--wf-text); font-variant-numeric: tabular-nums; }
.rt-scrub { flex: 1; min-width: 120px; accent-color: var(--wf-accent); cursor: pointer; }
.rt-swatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px; background: var(--tone, var(--wf-plain)); }
.rt-swatch.is-idle { background: repeating-linear-gradient(135deg, transparent 0 2px, color-mix(in oklab, var(--ui-text) 30%, transparent) 2px 3px); }
[data-tone="1"] { --tone: var(--wf-h1); }
[data-tone="2"] { --tone: var(--wf-h2); }
[data-tone="3"] { --tone: var(--wf-h3); }
[data-tone="4"] { --tone: var(--wf-h4); }
[data-tone="5"] { --tone: var(--wf-h5); }
[data-tone="6"] { --tone: var(--wf-h6); }
[data-tone="7"] { --tone: var(--wf-h7); }
[data-tone="8"] { --tone: var(--wf-h8); }
</style>

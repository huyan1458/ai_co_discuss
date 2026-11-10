<script setup>
/**
 * The execution timeline: the room's run monitor. It answers what the message page cannot, since that page is linear
 * and says what was said: where each run's time went, who waited on whom, what held a round up, and whether running
 * work is still making progress. Every execution the local service woke is one row, nested under the execution that
 * dispatched it, its bar split into waiting, model and tool time and labelled where wide enough. A sentence at the top
 * says what the round came down to; the critical path stays bright and the rest steps back.
 * Phase reports wake no other page, so this page reads on its own: in full when opened, then only what is running or
 * just ended, every two seconds while anything runs and whenever the room changes. Running bars grow once a second.
 * A finished run can be replayed: the same drawing, with the playback position as now.
 * On a phone a shared time axis has no resolution left, so each row shows its own duration split by kind instead.
 */
import { computed, inject, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { FOLD_GAP_MS, PHASE_KINDS, PHASE_LABELS, STATE_LABELS, WAIT_WARN_MS, axis_ticks, execution_log, format_duration, handoff_lines, notes_between,
  pan_window, round_digest, row_breakdown, row_mix, row_status, snapshot_at, timeline_axis, timeline_rows, timeline_runs, timeline_summary, view_axis, zoom_window } from "./timeline-model.js";

const emit = defineEmits(["detail"]);
const { view, bridge } = inject("discussion");
const LIVE_REFRESH_MS = 2000;
const FULL_REFRESH_MS = 60_000;
// Running bars and silence counters move this often; a monitor needs no smoother motion.
const LIVE_TICK_MS = 1000;
// A replay redraws every frame with few rows; with many, this often.
const CLOCK_MS = 100;
const SMOOTH_ROWS = 60;
// A replay at "auto" speed lasts about this long, whatever the run's length; manual speeds are these multiples.
const REPLAY_TARGET_MS = 20_000;
const REPLAY_SPEEDS = [1, 2, 4, 8, 16, 32];
// An incremental read also takes executions that ended this long before the previous read, so none slips between reads.
const OVERLAP_SECONDS = 5;
// Each depth level indents a row's label by this much.
const DEPTH_PX = 14;
const COMPACT_DEPTH_PX = 12;
// At or below this page width, rows switch from the shared axis to their own durations.
const COMPACT_MAX_PX = 640;
// A bar piece this wide carries its full label ("思考 15m"), this wide only the duration, narrower none.
const LABEL_FULL_PX = 76;
const LABEL_SHORT_PX = 48;
// About one axis tick per this many pixels of axis, and never fewer or more than these.
const TICK_SPACING_PX = 90;
const MIN_TICKS = 2;
const MAX_TICKS = 8;
// A track keeps this margin on each side, the axis included.
const TRACK_MARGIN_PX = 12;
const section_element = ref(null);
const section_width = ref(0);
const axis_element = ref(null);
const axis_width = ref(0);
let size_observer = null;
const room_id = computed(() => view.value.room?.id);
const executions = ref(new Map());
const limits = ref(null);
const error = ref("");
const now = ref(Date.now());
// When the timeline was last read; while hidden or offline it stops, and silence is judged only up to here.
const read_at = ref(Date.now());
const collapsed = ref(new Set());
const note_texts = ref(new Map());
// The piece of a bar (or a note tick) the opened detail was opened from, if any.
const selected = ref(null);
const opened = ref("");
const detail_anchor = ref(null);
const wf_element = ref(null);
// The opened execution's detail floats at most this wide.
const DETAIL_WIDTH_PX = 560;
const compact = computed(() => section_width.value > 0 && section_width.value <= COMPACT_MAX_PX);
let last_read = 0;
let last_full = 0;
let reading = false;
// A read asked for during another: "" none, "next" incremental, "full" whole.
let reload = "";
let refresh_timer = 0;
let live_timer = 0;
let frame = 0;
let last_frame = 0;
let last_paint = 0;
// Replay: `position` is milliseconds into the run (null: not replaying), `speed` 0 means auto.
const replay = reactive({ position: null, playing: false, speed: 0 });
const show_player = ref(false);
let play_position = 0;

/** Read the timeline: in full when asked or due, else only executions still running or ended since the last read. */
async function load(full = false) {
  const id = room_id.value;
  if (!id) return;
  // A read asked for while another is in flight runs once that one ends, so a room switch is never dropped.
  if (reading) { reload = reload === "full" || full ? "full" : "next"; return; }
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
    read_at.value = Date.now();
    now.value = Date.now();
    if (!after) last_full = Date.now();
    error.value = "";
  } catch (failure) {
    error.value = `读取执行记录失败：${failure.message}`;
  } finally {
    reading = false;
    const pending = reload;
    reload = "";
    if (pending) load(pending === "full");
  }
}

const timeline = computed(() => limits.value && { ...limits.value, executions: [...executions.value.values()] });
const running = computed(() => timeline.value?.executions.some((item) => item.state === "running"));
// Only running work changes the timeline between room changes, and a hidden page need not follow it.
watch(running, (live) => {
  clearInterval(refresh_timer);
  clearInterval(live_timer);
  if (!live) return;
  refresh_timer = setInterval(() => { if (!document.hidden) load(); }, LIVE_REFRESH_MS);
  live_timer = setInterval(() => { if (!document.hidden) now.value = Date.now(); }, LIVE_TICK_MS);
}, { immediate: true });
watch(room_id, () => {
  executions.value = new Map(); limits.value = null; collapsed.value = new Set(); note_texts.value = new Map(); opened.value = "";
  last_read = 0;
  load(true);
}, { immediate: true });
// A new execution, an answer or a failure changes the room; read at once instead of waiting for the next tick.
watch(() => view.value.room, (room, previous) => { if (room?.id && room.id === previous?.id) load(); });
// One wheel notch (about 100 px of delta) zooms by roughly 16%.
const WHEEL_ZOOM_RATE = 0.0015;
let pan = null;
/** Where on the axis the pointer is, as a share of the view (0 left, 1 right). */
function pointer_share(event) {
  const rect = axis_element.value.getBoundingClientRect();
  return { share: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)), width: rect.width };
}
function on_wheel(event) {
  if (compact.value || !axis_element.value || !event.target.closest?.(".wf-track, .wf-axis")) return;
  if (event.ctrlKey || event.metaKey) {
    event.preventDefault();
    zoom.value = zoom_window(zoom.value, pointer_share(event).share, Math.exp(event.deltaY * WHEEL_ZOOM_RATE), axis.value.total_ms);
  } else if (zoomed.value && (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY))) {
    event.preventDefault();
    zoom.value = pan_window(zoom.value, (event.shiftKey ? event.deltaY : event.deltaX) / pointer_share(event).width);
  }
}
/** Middle-button drag anywhere on the lanes, or a left-button drag on the axis, pans a zoomed view. */
function on_pan_start(event) {
  const on_axis = event.target.closest?.(".wf-axis");
  if (!zoomed.value || !(event.button === 1 || (event.button === 0 && on_axis)) || !event.target.closest?.(".wf-track, .wf-axis")) return;
  event.preventDefault();
  pan = { x: event.clientX, from: zoom.value.from, width: pointer_share(event).width };
  event.currentTarget.setPointerCapture(event.pointerId);
}
function on_pan_move(event) {
  if (pan) zoom.value = pan_window({ from: pan.from, span: zoom.value.span }, -(event.clientX - pan.x) / pan.width);
}
function on_pan_end() { pan = null; }
/** A double click on the axis or the lanes shows the whole run again, following live work. */
function reset_on_dblclick(event) { if (event.target.closest?.(".wf-track, .wf-axis")) zoom.value = WHOLE; }
// A middle press would start the browser's autoscroll over the lanes; the drag pans instead.
function stop_autoscroll(event) { if (event.button === 1 && event.target.closest?.(".wf-track, .wf-axis")) event.preventDefault(); }

/** The open detail closes on a click anywhere else, or on Esc. */
function close_on_outside(event) {
  if (opened.value && !event.target.closest?.(".wf-detail, .wf-names, .wf-bar, .wf-note, .wf-mix-lane, .wf-now-card")) opened.value = "";
}
function close_on_escape(event) { if (event.key === "Escape") opened.value = ""; }
onMounted(() => {
  document.addEventListener("pointerdown", close_on_outside);
  document.addEventListener("keydown", close_on_escape);
  size_observer = new ResizeObserver((entries) => {
    for (const entry of entries) {
      if (entry.target === section_element.value) section_width.value = entry.contentRect.width;
      else if (entry.target === axis_element.value) axis_width.value = entry.contentRect.width;
    }
  });
  if (section_element.value) size_observer.observe(section_element.value);
  if (axis_element.value) size_observer.observe(axis_element.value);
});
// The axis appears only once there are rows, so it is observed whenever it is (re)rendered.
watch(axis_element, (element, previous) => {
  if (previous) size_observer?.unobserve(previous);
  if (element) size_observer?.observe(element);
});
onBeforeUnmount(() => {
  clearInterval(refresh_timer); clearInterval(live_timer); cancelAnimationFrame(frame);
  document.removeEventListener("pointerdown", close_on_outside);
  document.removeEventListener("keydown", close_on_escape);
  size_observer?.disconnect();
});

/** One stretch of work at a time (a discussion is its own): the latest by default, following a new one as it starts,
 *  any earlier one, or an overview of them all. */
const LATEST = "latest";
const ALL = "all";
const chosen_run = ref(LATEST);
const runs = computed(() => timeline.value ? timeline_runs(timeline.value, now.value) : { list: [], of: new Map() });
const run_shown = computed(() => chosen_run.value === LATEST ? runs.value.list[0]?.key
  : chosen_run.value === ALL || runs.value.list.some((run) => run.key === chosen_run.value) ? chosen_run.value : runs.value.list[0]?.key);
const overview = computed(() => run_shown.value === ALL);
// A stretch of more than this many executions shows its latest ones first; the earlier ones are a click away.
const MAX_ROWS = 30;
const show_earlier = ref(false);
const in_run = computed(() => !timeline.value || overview.value ? []
  : timeline.value.executions.filter((item) => runs.value.of.get(`${item.source}:${item.id}`) === run_shown.value));
const hidden_count = computed(() => show_earlier.value ? 0 : Math.max(0, in_run.value.length - MAX_ROWS));
const requested_at = (item) => item.queued_at || item.dispatched_at || 0;
const shown = computed(() => !timeline.value || overview.value ? timeline.value
  : { ...timeline.value, executions: hidden_count.value ? [...in_run.value].sort((a, b) => requested_at(b) - requested_at(a)).slice(0, MAX_ROWS) : in_run.value });
watch(room_id, () => { chosen_run.value = LATEST; });
watch([run_shown, room_id], () => { show_earlier.value = false; });
const when = (ms) => new Date(ms).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
const RUN_TASK_CHARS = 22;
/** What a stretch is: who worked in it, or for a discussion, its question. */
function run_title(run) {
  if (run.source === "discussion") return `讨论 · ${run.task ? run.task.replace(/\s+/g, " ") : "讨论"}`;
  return run.members.map(name).join("、");
}
function run_label(run) {
  const when_text = run.source === "discussion" ? when(run.start) : `${when(run.start)}–${short_clock(run.end)}`;
  const title = run.source === "discussion" ? ` · ${run_title(run).slice(0, RUN_TASK_CHARS)}${run_title(run).length > RUN_TASK_CHARS ? "…" : ""}` : "";
  return `${when_text}${title} · ${run.count} 次 · ${format_duration(run.end - run.start)}${run.running ? " · 进行中" : run.failed ? " · 有失败" : ""}`;
}
// As a string first: runs are rebuilt on every read and every clock tick of live work, and the picker renders each
// option even while closed, so its items change only when a label does.
const run_labels = computed(() => JSON.stringify(runs.value.list.map((run) => [run.key, run_label(run)])));
const run_items = computed(() => [{ label: "最近一段（自动跟随）", value: LATEST },
  ...JSON.parse(run_labels.value).map(([value, label]) => ({ label, value })), { label: "全部工作段（概览）", value: ALL }]);
const longest_run = computed(() => Math.max(1, ...runs.value.list.map((run) => run.end - run.start)));

// The run as it really is; its bounds are what a replay plays through.
const base_rows = computed(() => shown.value && !overview.value ? timeline_rows(shown.value, now.value) : []);
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
/** Zoom: the share of the axis in view, from Ctrl/⌘ + wheel around the pointer; middle-button drag, Shift + wheel, a
 *  sideways swipe or dragging the axis pans it; a double click on the axis or lanes, or 重置, shows it whole again. */
const WHOLE = { from: 0, span: 1 };
const zoom = ref(WHOLE);
const zoomed = computed(() => zoom.value.span < 1);
watch([run_shown, room_id], () => { zoom.value = WHOLE; });
const shown_axis = computed(() => view_axis(axis.value, zoom.value));
const now_x = computed(() => {
  const x = live_in_view.value ? shown_axis.value.x(view_time.value) : null;
  return x === null || x < 0 || x > 1 ? null : x;
});
const auto_speed = computed(() => Math.max(1, bounds.value.duration / REPLAY_TARGET_MS));
const speed_items = computed(() => [{ label: `自动 · ${Math.round(auto_speed.value)}×`, value: 0 }, ...REPLAY_SPEEDS.map((speed) => ({ label: `${speed}×`, value: speed }))]);
const replay_speed = computed(() => replay.speed || auto_speed.value);
const can_replay = computed(() => !overview.value && !base_live.value && bounds.value.duration > 0);

/** The replay clock: every frame, at most ten times a second with many rows. */
function step(timestamp) {
  const elapsed = last_frame ? Math.min(timestamp - last_frame, 250) : 0;
  last_frame = timestamp;
  play_position += elapsed * replay_speed.value;
  if (play_position >= bounds.value.duration) Object.assign(replay, { position: null, playing: false });
  else if (all_rows.value.length <= SMOOTH_ROWS || timestamp - last_paint >= CLOCK_MS) { replay.position = play_position; last_paint = timestamp; }
  frame = replay.playing ? requestAnimationFrame(step) : 0;
  if (!frame) last_frame = 0;
}
watch(() => replay.playing, (playing) => { if (playing && !frame) frame = requestAnimationFrame(step); });

/** Replay from the start, or go on from where it was paused; the run's note texts are read first, to surface as they were written. */
function play() {
  play_position = replay.position === null ? 0 : replay.position;
  Object.assign(replay, { position: play_position, playing: true });
  load_run_notes();
}
/** A replay shows what each execution was saying at the time, so it needs the run's note texts, read once each. */
function load_run_notes() { for (const item of shown.value?.executions || []) note_texts_for({ item, notes: item.notes || [] }); }
function pause() { replay.playing = false; }
function restart() { play_position = 0; Object.assign(replay, { position: 0, playing: true }); }
function scrub(event) { play_position = Number(event.target.value); Object.assign(replay, { position: play_position, playing: false }); load_run_notes(); }
function close_player() { show_player.value = false; Object.assign(replay, { position: null, playing: false }); }
// Another run or another room starts from its real, final state.
watch([run_shown, room_id], close_player);

const lines = computed(() => compact.value ? new Map() : handoff_lines(rows.value, shown_axis.value));
const ticks = computed(() => axis_ticks(axis.value,
  Math.min(MAX_TICKS, Math.max(MIN_TICKS, Math.round((axis_width.value || TICK_SPACING_PX * 6) / TICK_SPACING_PX))), zoom.value)
  .map((tick) => ({ ...tick, x: (tick.x - zoom.value.from) / zoom.value.span })));
// Data read before the page was hidden or went offline may be old, so possible stalls are judged only up to that read.
const status_time = computed(() => replaying.value ? view_time.value : Math.min(view_time.value, read_at.value));
const summary = computed(() => timeline_summary(all_rows.value));
const digest = computed(() => round_digest(all_rows.value, status_time.value));
// Only a round with more than one execution has a path worth singling out.
const marks_path = computed(() => all_rows.value.length > 1 && digest.value.path.size < all_rows.value.length);
const parents = computed(() => all_rows.value.filter((row) => row.has_children).map((row) => row.key));
const opened_row = computed(() => all_rows.value.find((row) => row.key === opened.value));
const opened_log = computed(() => opened_row.value ? execution_log(opened_row.value, note_texts.value.get(opened_row.value.item.id)) : []);
const name = (member) => bridge.display_name(member);

/** The sentence at the top: for live work, how the running execution is doing; for a finished round, what its time
 *  came down to. Each part carries a tone, so a stall or a failure stands out within the line. */
const headline = computed(() => {
  if (overview.value) {
    const list = runs.value.list;
    return [{ text: `${list.length} 段 · ${timeline.value?.executions.length || 0} 次执行` }, { text: "点一段查看它的时间分布" }];
  }
  const { running: live, members, wait, failed, stalled, total, path } = digest.value;
  const parts = [];
  // On a phone the running work has its own cards above the rows, so the sentence speaks for the round.
  if (live.length && !compact.value) {
    const row = live.find((item) => path.has(item.key)) || live[0];
    const state = status(row);
    parts.push({ text: `${name(row.item.member)} 已运行 ${format_duration(status_time.value - row.start)}` }, { text: state.text, tone: state.tone });
    if (live.length > 1) parts.push({ text: `另 ${live.length - 1} 个进行中` });
  } else {
    parts.push({ text: `这段${live.length ? "已进行" : "用时"} ${format_duration(total)}` });
    if (members.length && all_rows.value.length > 1) parts.push({ text: `关键路径上 ${members.slice(0, 2).map((part) => `${name(part.member)} ${format_duration(part.ms)}`).join("、")}` });
  }
  if (wait >= WAIT_WARN_MS || (!live.length && wait >= 60_000)) parts.push({ text: `等待 ${format_duration(wait)}`, tone: wait >= WAIT_WARN_MS ? "warn" : "" });
  if (stalled && !compact.value && !(live.length === 1 && stalled === 1)) parts.push({ text: `可能卡住 ${stalled}`, tone: "warn" });
  if (failed) parts.push({ text: `失败 ${failed} 次`, tone: "failed" });
  return parts;
});

/**
 * One way in, whatever the device: a click on a name, a bar piece or a note tick opens that execution's detail under
 * what was clicked, with the clicked piece (when there is one) at its top; the same click again closes it. Hovering only
 * highlights. Its notes are read as it opens and again as more arrive.
 */
function open_row(row, event, piece = null) {
  const id = piece ? piece_id(row, piece) : "";
  if (opened.value === row.key && (selected.value?.id || "") === id) { opened.value = ""; return; }
  opened.value = row.key;
  selected.value = piece ? { id, piece, related: piece.note ? { notes: [piece.note], earlier: false } : notes_between(row.notes, piece.start, piece.end) } : null;
  note_texts_for(row);
  if (compact.value) return;
  // Anchored under what was clicked, within the card; the card scrolls with the page, so the anchor stays put.
  const name_box = event.currentTarget.getBoundingClientRect();
  const card = wf_element.value.getBoundingClientRect();
  const width = Math.min(DETAIL_WIDTH_PX, card.width - 16);
  detail_anchor.value = { top: name_box.bottom - card.top + 4, left: Math.max(8, Math.min(name_box.left - card.left, card.width - width - 8)) };
}
watch(() => opened_row.value?.notes.length, () => { if (opened_row.value) note_texts_for(opened_row.value); });

/** On a phone, what needs a look sits above the rows: running work first (oldest first), then failures (latest first). */
// Running work anywhere in the room, whichever stretch is shown (a discussion is a stretch of its own, an earlier
// stretch may be open, or the overview): a watcher must never miss it. Read at real time, even during a replay.
const live_time = computed(() => Math.min(now.value, read_at.value));
const live_rows = computed(() => {
  const running_items = compact.value ? timeline.value?.executions.filter((item) => item.state === "running") || [] : [];
  return running_items.length ? timeline_rows({ ...timeline.value, executions: running_items }, now.value).sort((a, b) => a.start - b.start) : [];
});
const live_status = (row) => row_status(row, live_time.value);
/** On a phone, what needs a look sits above the rows: running work in the whole room (oldest first), then this
 *  stretch's failures (latest first); an old failure elsewhere is history, not something to act on now. */
const attention = computed(() => compact.value ? [
  ...live_rows.value,
  ...all_rows.value.filter((row) => row.item.state === "failed").sort((a, b) => b.end - a.end),
] : []);
const card_status = (row) => row.item.state === "running" ? live_status(row) : status(row);
/** A card opens its execution's row, unfolded and scrolled into view, switching to its stretch first when another is shown. */
function focus_row(card) {
  const run = runs.value.of.get(card.key);
  if (run && run !== run_shown.value) chosen_run.value = run === runs.value.list[0]?.key ? LATEST : run;
  nextTick(() => {
    const row = all_rows.value.find((item) => item.key === card.key);
    if (!row) return;
    if (row.ancestors.some((key) => collapsed.value.has(key))) collapsed.value = new Set([...collapsed.value].filter((key) => !row.ancestors.includes(key)));
    opened.value = row.key;
    selected.value = null;
    note_texts_for(row);
    nextTick(() => wf_element.value?.querySelector(`[data-row="${CSS.escape(row.key)}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" }));
  });
}
/** On a phone a finished row off the critical path is one line: it is rarely what a watcher needs. */
const brief = (row) => compact.value && marks_path.value && !digest.value.path.has(row.key) && row.item.state === "done" && opened.value !== row.key;
const MIX_KINDS = [["wait", "等待"], ["model", "模型"], ["tool", "工具"], ["work", "执行"]];
/** A phone row's bar: its time by kind, in proportion, against the longest execution in the round. */
function mix_parts(row) {
  const mix = row_mix(row);
  const values = { wait: mix.wait, model: mix.model, tool: mix.tool, work: mix.other };
  return MIX_KINDS.filter(([kind]) => values[kind] > 0).map(([kind, label]) => {
    const px = values[kind] / longest_row.value * track_px.value;
    const text = kind === "work" && row.segments.length ? "未上报" : label;
    return { kind, ms: values[kind], text: px >= LABEL_FULL_PX ? `${text} ${format_duration(values[kind])}` : px >= LABEL_SHORT_PX ? format_duration(values[kind]) : "" };
  });
}

function toggle(key) {
  const next = new Set(collapsed.value);
  next.has(key) ? next.delete(key) : next.add(key);
  collapsed.value = next;
}

// On a phone every bar starts at the left and the longest execution fills the width.
const longest_row = computed(() => Math.max(1, ...rows.value.map((row) => row.end - row.start)));
const track_px = computed(() => compact.value ? Math.max(0, section_width.value - 2 * TRACK_MARGIN_PX - 2) : axis_width.value);
/** A piece's left and right edge as shares of the track: on the shared axis, or within its own row on a phone. */
function span_of(row, start, end) {
  if (compact.value) return [(start - row.start) / longest_row.value, (end - row.start) / longest_row.value];
  return [shown_axis.value.x(start), shown_axis.value.x(end)];
}
/** A bar piece's position. Segments leave a 1 px gap after them, so neighbouring phases read apart. */
function place(row, start, end, gap = false) {
  const [from, to] = span_of(row, start, end);
  const width = Math.max(0, to - from) * 100;
  return { left: `${from * 100}%`, width: gap ? `max(2px, calc(${width}% - 1px))` : `${width}%` };
}
const queue_piece = (row) => ({ label: "排队", start: row.queue[0], end: row.queue[1], text: "从请求发出到投递给成员" });
const wake_piece = (row) => ({ label: row.wake_approx ? "唤醒（约）" : "唤醒", start: row.wake[0], end: row.wake[1], text: "从投递到成员开始工作" });
const segment_piece = (segment) => ({ label: `${PHASE_LABELS[segment.phase]}${segment.tool ? ` · ${segment.tool}` : ""}`, start: segment.start, end: segment.end, live: segment.live });
const note_piece = (note) => ({ note, start: note.at, end: note.at });
/** Each member keeps one hue on every mark that is theirs, in every stretch and the overview alike, so a glance says who
 *  worked when. Hues go by first appearance in the room. */
const MEMBER_TONES = 5;
const member_tone = computed(() => {
  const tones = new Map();
  for (const item of [...(timeline.value?.executions || [])].sort((a, b) => requested_at(a) - requested_at(b))) {
    if (!tones.has(item.member)) tones.set(item.member, tones.size % MEMBER_TONES + 1);
  }
  return tones;
});
// The overview names the members who took the most time; the rest are counted.
const OVERVIEW_MEMBERS = 4;
/** An overview line's bar: each member's work time and the waiting, in proportion, in the member's hue. */
function run_parts(run) {
  return [...run.work.filter((part) => part.ms > 0).map((part) => ({ key: part.member, ms: part.ms, tone: member_tone.value.get(part.member) })),
    ...(run.wait > 0 ? [{ key: "wait", ms: run.wait, wait: true }] : [])];
}
/** On a phone a stretch names only who took the most time; the bar shows the rest. */
function run_lead(run) {
  const lead = run.work[0];
  if (!lead) return "";
  return run.work.length > 1 ? `${name(lead.member)}等 ${run.work.length} 人` : name(lead.member);
}
function run_people(run) {
  const shown_members = run.work.slice(0, OVERVIEW_MEMBERS).map((part) => `${name(part.member)} ${format_duration(part.ms)}`).join(" · ");
  return run.work.length > OVERVIEW_MEMBERS ? `${shown_members} · 另 ${run.work.length - OVERVIEW_MEMBERS} 位` : shown_members;
}

/** The marks after a name: only what tells rows apart. */
function role_marks(row) {
  return row.item.role === "host" ? ["主持"] : [];
}
const role_label = (row) => row.item.role === "host" ? "协作 · 主持" : "协作";
const status = (row) => row_status(row, status_time.value);

function row_label(row) {
  const { wait } = row_breakdown(row);
  const parts = [name(row.item.member), role_label(row), STATE_LABELS[row.item.state], `用时 ${format_duration(row.end - row.start)}`, `等待 ${format_duration(wait)}`];
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
const short_clock = (ms) => new Date(ms).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
const tick_label = (tick) => new Date(tick.at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", ...(tick.seconds ? { second: "2-digit" } : {}), hour12: false });

const piece_id = (row, piece) => `${row.key}:${piece.note ? "note" : piece.label}:${piece.start}`;
const work_piece = (row) => ({ label: row.segments.length ? "执行" : "执行 · 无阶段明细", start: row.work[0], end: row.work[1], live: row.item.state === "running" });

const selected_title = computed(() => {
  const piece = selected.value?.piece;
  if (!piece) return "";
  if (piece.note) return `过程说明 · ${clock(piece.note.at)}`;
  return `${piece.label} · ${format_duration(piece.end - piece.start)}${piece.live ? " · 进行中" : ""}`;
});
const selected_notes = computed(() => {
  if (!selected.value || !opened_row.value) return [];
  const texts = note_texts.value.get(opened_row.value.item.id);
  return selected.value.related.notes.map((note) => ({ at: note.at, text: texts?.[note.index] ?? (texts ? "（未能读取）" : "读取中…") }));
});
</script>

<template>
  <section ref="section_element" class="merged-section execution-timeline" aria-label="执行时间线">
    <div v-if="!compact" class="page-heading"><div><h2>执行时间线</h2><p>每次执行的时间花在哪、谁在等谁；点名字看详情。</p></div></div>
    <p v-if="error" role="alert" class="fine-print wf-error">{{ error }}</p>
    <p v-if="timeline && !timeline.executions.length" class="fine-print">还没有执行记录。</p>
    <div v-if="timeline?.executions.length" ref="wf_element" class="wf" :class="{ 'is-compact': compact }"
      :style="{ '--wf-depth-px': `${compact ? COMPACT_DEPTH_PX : DEPTH_PX}px` }">
      <header class="wf-head">
        <div class="wf-head-line">
          <USelect v-model="chosen_run" :items="run_items" trailing-icon="i-lucide-chevrons-up-down" variant="none" aria-label="查看哪一段" class="wf-run-select"
            :content="{ align: 'start', sideOffset: 4 }" :ui="{ content: 'channel-select-menu wf-run-menu', trailing: 'static shrink-0 p-0 ms-1.5', trailingIcon: 'wf-select-icon' }" />
          <span v-if="replaying" class="wf-state is-replay">回放中 · {{ clock(view_time) }}</span>
          <span v-else-if="!overview" class="wf-state" :class="{ 'is-live': digest.running.length }">{{ digest.running.length ? `${digest.running.length} 个进行中` : '均已结束' }}</span>
        </div>
        <p class="wf-headline"><span v-for="(part, index) in headline" :key="index" :class="part.tone && `is-${part.tone}`">{{ part.text }}</span></p>
      </header>

      <section v-if="attention.length" class="wf-now" aria-label="需要关注">
        <button v-for="row in attention" :key="row.key" type="button" class="wf-now-card"
          :class="[`is-${row.item.state}`, { 'is-stalled': row.item.state === 'running' && card_status(row).tone === 'warn' }]" @click="focus_row(row)">
          <span class="wf-now-line"><i v-if="row.item.state === 'running'" class="wf-spinner" aria-hidden="true"></i>
            <UAvatar :src="bridge.identities[row.item.member]?.icon" :text="bridge.identities[row.item.member]?.initials" :alt="row.item.member" size="2xs" class="channel-avatar wf-avatar" :class="bridge.identities[row.item.member]?.style" />
            <strong>{{ name(row.item.member) }}</strong><em v-for="mark in role_marks(row)" :key="mark" class="wf-pill is-role">{{ mark }}</em>
            <span class="wf-now-time">{{ row.item.state === 'running' ? `已运行 ${format_duration(live_time - row.start)}` : `${format_duration(Math.max(0, status_time - row.end))} 前失败` }}</span></span>
          <span class="wf-now-status wf-status" :class="`is-${card_status(row).tone}`">{{ card_status(row).text }}</span>
          <span v-if="row.item.state === 'running' && row.item.last_note" class="wf-now-note">{{ row.item.last_note }}</span>
        </button>
      </section>

      <p v-if="hidden_count" class="wf-earlier">这段共 {{ in_run.length }} 次执行，先显示最近 {{ MAX_ROWS }} 次<button type="button" class="wf-text-button" @click="show_earlier = true">显示更早的 {{ hidden_count }} 次</button></p>
      <ol v-if="overview" class="wf-runs" aria-label="全部工作段">
        <li v-for="run in runs.list" :key="run.key">
          <button type="button" class="wf-run" @click="chosen_run = run.key">
            <span class="wf-run-line"><time>{{ when(run.start) }}</time><strong>{{ run.source === 'discussion' ? run_title(run) : compact ? run_lead(run) : run_people(run) }}</strong>
              <span v-if="run.wait >= WAIT_WARN_MS && !compact" class="wf-run-wait">等待 {{ format_duration(run.wait) }}</span>
              <span class="wf-run-meta">{{ run.count }} 次 · {{ format_duration(run.end - run.start) }}</span>
              <em v-if="run.running" class="wf-pill is-live">进行中</em><em v-else-if="run.failed" class="wf-pill is-failed">有失败</em></span>
            <span class="wf-run-bar"><span class="wf-run-fill" :style="{ width: `${(run.end - run.start) / longest_run * 100}%` }">
              <i v-for="part in run_parts(run)" :key="part.key" :class="{ 'is-wait': part.wait, 'is-long': part.wait && part.ms >= WAIT_WARN_MS }" :data-tone="part.tone" :style="{ flexGrow: part.ms }"></i>
            </span></span>
          </button>
        </li>
      </ol>

      <div v-else class="wf-grid" :class="{ 'is-zoomed': zoomed, 'is-panning': pan, 'marks-path': marks_path }" role="list"
        @wheel="on_wheel" @mousedown="stop_autoscroll" @pointerdown="on_pan_start" @pointermove="on_pan_move" @pointerup="on_pan_end" @pointercancel="on_pan_end" @dblclick="reset_on_dblclick">
        <template v-if="!compact">
          <div class="wf-axis-label" title="Ctrl + 滚轮缩放；放大后按住中键或拖动时间轴平移，双击时间线还原">
            <span>执行 · {{ rows.length }}/{{ all_rows.length }}</span>
            <span v-if="zoomed" class="wf-zoom">放大 {{ (1 / zoom.span).toFixed(1) }}×<button type="button" class="wf-zoom-reset" title="双击时间线也可还原" @click="zoom = WHOLE">
              <UIcon name="i-lucide-locate-fixed" />{{ base_live ? '重置跟随' : '重置' }}</button></span>
            <span v-if="parents.length" class="wf-branch">
              <button type="button" class="wf-text-button" @click="collapsed = new Set()">展开</button>
              <button type="button" class="wf-text-button" @click="collapsed = new Set(parents)">收起</button>
            </span>
          </div>
          <div ref="axis_element" class="wf-axis" aria-hidden="true">
            <span v-for="tick in ticks" :key="tick.at" class="wf-tick" :style="{ left: `${tick.x * 100}%` }">{{ tick_label(tick) }}</span>
            <span v-for="fold in shown_axis.folds.filter((item) => item.from + item.width / 2 >= 0 && item.from + item.width / 2 <= 1)" :key="`fold-${fold.start}`" class="wf-fold-label"
              :style="{ left: `${(fold.from + fold.width / 2) * 100}%` }" :title="`${clock(fold.start)} – ${clock(fold.end)} 没有执行，已折叠`">⋯ {{ format_duration(fold.end - fold.start) }}</span>
            <span v-if="now_x !== null" class="wf-cursor-head" :style="{ left: `${now_x * 100}%` }"></span>
          </div>
          <span class="wf-axis-end">用时</span>
        </template>
        <div v-for="row in rows" :key="row.key" role="listitem" class="wf-row"
          :class="[`is-${row.item.state}`, { 'is-open': opened === row.key, 'is-stalled': row.item.state === 'running' && status(row).tone === 'warn', 'is-off-path': marks_path && !digest.path.has(row.key), 'is-brief': brief(row) }]">
          <div class="wf-label" :data-row="row.key" :style="{ '--depth': row.depth }">
            <span v-if="row.depth" class="wf-guides" aria-hidden="true"></span>
            <button v-if="row.has_children" type="button" class="wf-toggle" :class="{ 'is-open': !collapsed.has(row.key) }" :aria-expanded="!collapsed.has(row.key)"
              :aria-label="`${collapsed.has(row.key) ? '展开' : '收起'} ${name(row.item.member)} 派出的执行`" @click="toggle(row.key)">
              <UIcon name="i-lucide-chevron-right" />
            </button>
            <span v-else class="wf-toggle-space"></span>
            <UAvatar :src="bridge.identities[row.item.member]?.icon" :text="bridge.identities[row.item.member]?.initials" :alt="row.item.member" size="2xs" class="channel-avatar wf-avatar" :class="bridge.identities[row.item.member]?.style" />
            <button type="button" class="wf-names" :aria-expanded="opened === row.key" @click="open_row(row, $event)">
              <span class="wf-name-line"><i v-if="row.item.state === 'running'" class="wf-spinner" aria-hidden="true"></i><time v-if="compact" class="wf-clock">{{ short_clock(row.start) }}</time><strong>{{ name(row.item.member) }}</strong><em v-for="mark in role_marks(row)" :key="mark" class="wf-pill is-role">{{ mark }}</em><em v-if="summary.slowest?.row === row.key" class="wf-pill is-slowest">最慢</em>
                <span v-if="compact" class="wf-name-end">{{ format_duration(row.end - row.start) }}<small v-if="row.item.state !== 'done'" :class="`is-${row.item.state}`">{{ STATE_LABELS[row.item.state] }}</small></span></span>
              <span v-if="!compact" class="wf-status" :class="`is-${status(row).tone}`">{{ status(row).text }}</span>
            </button>
          </div>
          <button v-if="compact && !brief(row)" type="button" class="wf-mix-lane" :aria-label="row_label(row)" @click="open_row(row, $event)">
            <span class="wf-mix" :data-tone="member_tone.get(row.item.member)" :style="{ width: `${(row.end - row.start) / longest_row * 100}%` }">
              <span v-for="part in mix_parts(row)" :key="part.kind" class="wf-mix-part" :class="[`is-${part.kind}`, { 'is-long': part.kind === 'wait' && part.ms >= WAIT_WARN_MS }]" :style="{ flexGrow: part.ms }">{{ part.text }}</span>
            </span>
          </button>
          <div v-if="!compact" class="wf-lane" role="img" :aria-label="row_label(row)"><div class="wf-track">
            <template v-if="!compact">
              <i v-for="tick in ticks" :key="tick.at" class="wf-gridline" :style="{ left: `${tick.x * 100}%` }"></i>
              <i v-for="fold in shown_axis.folds" :key="fold.start" class="wf-fold" :style="{ left: `${fold.from * 100}%`, width: `${fold.width * 100}%` }"></i>
            </template>
            <i class="wf-well"></i>
            <i v-for="(line, index) in lines.get(row.key) || []" :key="`link-${index}`" class="wf-link" :class="`is-${line.part}`"
              :data-tone="member_tone.get(line.member)" :style="{ left: `${line.x * 100}%` }"></i>
            <i v-if="now_x !== null && !compact" class="wf-cursor" :style="{ left: `${now_x * 100}%` }"></i>
            <i class="wf-bar is-queue" :style="place(row, ...row.queue)" @click="open_row(row, $event, queue_piece(row))"></i>
            <i v-if="row.wake" class="wf-bar is-wake" :style="place(row, ...row.wake)" @click="open_row(row, $event, wake_piece(row))"></i>
            <i v-if="row.work" class="wf-bar is-work" :class="{ 'has-detail': row.segments.length }" :data-tone="row.segments.length ? undefined : member_tone.get(row.item.member)"
              :style="place(row, ...row.work)" @click="open_row(row, $event, work_piece(row))"></i>
            <template v-for="segment in row.segments" :key="segment.start + segment.phase">
              <i class="wf-bar wf-seg" :class="[`is-${PHASE_KINDS[segment.phase]}`, { 'is-live': segment.live }]" :data-tone="member_tone.get(row.item.member)"
                :style="place(row, segment.start, segment.seen, true)" @click="open_row(row, $event, segment_piece(segment))"></i>
              <i v-if="segment.end > segment.seen" class="wf-bar wf-seg is-tail" :class="`is-${PHASE_KINDS[segment.phase]}`" :data-tone="member_tone.get(row.item.member)"
                :style="place(row, segment.seen, segment.end)" @click="open_row(row, $event, segment_piece(segment))"></i>
            </template>
            <button v-for="note in row.notes" :key="`note-${note.index}`" type="button" class="wf-note" :style="{ left: `${span_of(row, note.at, note.at)[0] * 100}%` }"
              :aria-label="`${name(row.item.member)} 的第 ${note.index + 1} 段过程说明，${clock(note.at)}`"
              @click="open_row(row, $event, note_piece(note))"></button>
          </div></div>
          <span v-if="!compact" class="wf-end">{{ format_duration(row.end - row.start) }}<small v-if="row.item.state !== 'done'" :class="`is-${row.item.state}`">{{ STATE_LABELS[row.item.state] }}</small><small v-if="row.truncated">明细已截断</small></span>
          <span v-else-if="!brief(row)" class="wf-row-status wf-status" :class="`is-${status(row).tone}`">{{ status(row).text }}</span>
          <div v-if="opened === row.key && (compact || detail_anchor)" class="wf-detail" role="dialog" :aria-label="`${name(row.item.member)} 的这次执行`"
            :style="compact ? undefined : { top: `${detail_anchor.top}px`, left: `${detail_anchor.left}px` }">
            <header class="wf-detail-head"><strong>{{ name(row.item.member) }}</strong><small>{{ role_label(row) }} · {{ STATE_LABELS[row.item.state] }} · {{ clock(row.start) }} 起 · {{ format_duration(row.end - row.start) }}</small>
              <button type="button" class="wf-card-close" aria-label="关闭" @click="opened = ''"><UIcon name="i-lucide-x" /></button></header>
            <section v-if="selected" class="wf-detail-piece">
              <strong>{{ selected_title }}</strong>
              <small>{{ clock(selected.piece.start) }}<template v-if="selected.piece.end > selected.piece.start"> – {{ selected.piece.live ? '现在' : clock(selected.piece.end) }}</template><template v-if="selected.piece.text"> · {{ selected.piece.text }}</template></small>
              <template v-if="selected_notes.length">
                <small class="wf-detail-piece-label">{{ selected.related.earlier ? '此前的过程说明' : '这段时间的过程说明' }}</small>
                <ol><li v-for="note in selected_notes" :key="note.at + note.text"><time>{{ clock(note.at) }}</time>{{ note.text }}</li></ol>
              </template>
            </section>
            <dl>
              <div><dt>时间</dt><dd>{{ status(row).text }}</dd></div>
              <div v-if="row.item.task"><dt>任务</dt><dd>{{ row.item.task }}<button v-if="row.item.task_id" type="button" class="subtle-link" @click="emit('detail', row.item.task_id)">#{{ row.item.task_id }}</button></dd></div>
              <div v-if="row.item.answer_id"><dt>回答</dt><dd><button type="button" class="subtle-link" @click="emit('detail', row.item.answer_id)">在消息中查看 #{{ row.item.answer_id }}</button></dd></div>
              <div v-if="row.item.changes"><dt>改动</dt><dd>{{ row.item.changes }} 个文件</dd></div>
            </dl>
            <ol v-if="opened_log.length" class="wf-log" aria-label="过程">
              <li v-for="entry in opened_log" :key="`${entry.kind}-${entry.at}-${entry.phase || ''}`" :class="`log-${entry.kind}`">
                <time>{{ clock(entry.at) }}</time>
                <template v-if="entry.kind === 'phase'"><i class="wf-swatch" :class="`is-${PHASE_KINDS[entry.phase]}`" :data-tone="member_tone.get(row.item.member)" aria-hidden="true"></i><span>{{ PHASE_LABELS[entry.phase] }}<template v-if="entry.tool"> · {{ entry.tool }}</template> · {{ entry.live ? '进行中' : format_duration(entry.duration) }}</span></template>
                <span v-else class="wf-log-note">{{ entry.text }}</span>
              </li>
            </ol>
            <p v-else class="fine-print">这次执行没有阶段明细或过程说明。</p>
          </div>
        </div>
      </div>

      <footer v-if="!overview" class="wf-foot">
        <span class="wf-key"><i class="wf-swatch is-queue"></i>排队<i class="wf-swatch is-wake"></i>唤醒<i class="wf-swatch is-model"></i>模型<i class="wf-swatch is-tool"></i>工具</span>
        <span v-if="member_tone.size > 1">颜色区分成员，深浅区分模型与工具</span>
        <span v-if="axis.folds.length && !compact"><i class="wf-swatch is-fold" aria-hidden="true"></i>已折叠 {{ axis.folds.length }} 段超过 {{ FOLD_GAP_MS / 60000 }} 分钟的空闲</span>
        <span v-if="timeline.executions.length >= timeline.execution_limit">只列出最近 {{ timeline.execution_limit }} 次讨论执行与 {{ timeline.execution_limit }} 次协作执行</span>
        <button v-if="can_replay && !show_player" type="button" class="wf-text-button wf-replay-open" @click="show_player = true"><UIcon name="i-lucide-play" />回放这一段</button>
      </footer>
      <div v-if="can_replay && show_player" class="wf-player">
        <button type="button" class="wf-player-button" :aria-label="replay.playing ? '暂停回放' : '回放这一段'" @click="replay.playing ? pause() : play()">
          <UIcon :name="replay.playing ? 'i-lucide-pause' : 'i-lucide-play'" />
        </button>
        <button type="button" class="wf-player-button" aria-label="从头回放" :disabled="!replaying" @click="restart"><UIcon name="i-lucide-rotate-ccw" /></button>
        <USelect v-model="replay.speed" :items="speed_items" variant="none" aria-label="回放速度" class="wf-speed"
          :content="{ side: 'top', align: 'start', sideOffset: 4 }" :ui="{ content: 'channel-select-menu wf-speed-menu', trailing: 'static shrink-0 p-0', trailingIcon: 'wf-select-icon' }" />
        <input type="range" class="wf-scrub" min="0" :max="bounds.duration" step="100" :value="replaying ? replay.position : bounds.duration"
          aria-label="回放位置" @input="scrub" />
        <span class="wf-player-time">{{ format_duration(replaying ? replay.position : bounds.duration) }} / {{ format_duration(bounds.duration) }}</span>
        <button type="button" class="wf-player-button" aria-label="关闭回放" @click="close_player"><UIcon name="i-lucide-x" /></button>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* A live board needs room for the status line and the bars, so this page is wider than reading pages. */
:global(html[data-theme^="channel"] .content-page > .execution-timeline) { max-width: 1280px; }

/* Tokens. One card, hairline rules, bars on wells; surfaces, edges and the accent are the channel's own tokens.
   Each member keeps one hue on all its marks, shaded by kind as a trace does: the model's own turns solid, tool work a
   lighter step with an edge. Queue is a hatch and wake an amber edge; green, amber fills and red stay for status. */
.wf {
  --wf-surface: var(--ui-bg-muted);
  --wf-text: var(--ui-text-highlighted);
  --wf-muted: var(--ui-text-muted);
  --wf-border: var(--ui-border-muted);
  --wf-grid: color-mix(in oklab, var(--ui-text) 7%, transparent);
  --wf-guide: color-mix(in oklab, var(--ui-text) 14%, transparent);
  --wf-well: color-mix(in oklab, var(--ui-text) 6%, transparent);
  --wf-hover: var(--channel-ghost-hover, color-mix(in oklab, var(--ui-text) 4%, transparent));
  --wf-hatch: color-mix(in oklab, var(--ui-text) 30%, transparent);
  --wf-accent: var(--channel-accent);
  --wf-failed: var(--ui-error);
  --wf-warn: light-dark(#b7791f, #e5a50a);
  --wf-mono: ui-monospace, SFMono-Regular, Consolas, monospace;
  --wf-wake: light-dark(oklch(0.70 0.12 75), oklch(0.78 0.11 75));
  --wf-plain: color-mix(in oklab, var(--ui-text) 22%, var(--wf-surface));
  /* Member hues: one lightness and a moderate chroma, no green, amber or red, so none reads as a status. */
  --wf-h1: light-dark(oklch(0.55 0.11 255), oklch(0.70 0.11 255));
  --wf-h2: light-dark(oklch(0.55 0.11 300), oklch(0.70 0.11 300));
  --wf-h3: light-dark(oklch(0.55 0.11 335), oklch(0.70 0.11 335));
  --wf-h4: light-dark(oklch(0.55 0.11 215), oklch(0.70 0.11 215));
  --wf-h5: light-dark(oklch(0.55 0.03 255), oklch(0.70 0.03 255));
  --wf-bar-h: 16px;
  --wf-row-h: 38px;
  --wf-label-col: 270px;
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

/* Header: the run picker and its state, then one sentence saying what the round came down to. */
.wf-head { display: grid; gap: 6px; padding: 10px 16px; border-bottom: 1px solid var(--wf-border); }
.wf-head-line { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; min-width: 0; }
.wf-headline { margin: 0; color: var(--wf-text); font-size: 13px; line-height: 20px; }
.wf-headline span + span::before { margin: 0 6px; color: var(--wf-muted); content: "·"; }
.wf-headline .is-live { color: var(--wf-text); }
.wf-headline .is-warn { color: var(--wf-warn); font-weight: 600; }
.wf-headline .is-failed { color: var(--wf-failed); font-weight: 600; }
.wf-headline .is-done, .wf-headline .is-muted { color: var(--wf-muted); }
.wf-state { display: inline-flex; align-items: center; gap: 6px; height: 20px; padding: 0 8px; border-radius: 999px; background: var(--wf-well); color: var(--wf-muted); font-size: 12px; font-weight: 600; }
.wf-state::before { width: 6px; height: 6px; border-radius: 50%; background: currentColor; content: ""; }
.wf-state.is-live { position: relative; background: color-mix(in oklab, var(--wf-accent) 14%, transparent); color: var(--wf-accent); }
/* Live: a steady dot sends out a fading ring; only transform and opacity move. */
.wf-state.is-live::after { position: absolute; top: 50%; left: 8px; width: 6px; height: 6px; margin-top: -3px; border-radius: 50%; background: currentColor; content: "";
  animation: wf-ping 2s cubic-bezier(0, 0, .2, 1) infinite; pointer-events: none; }
/* A replay is not live work: it says so, and at what time of the run it stands. */
.wf-state.is-replay { background: color-mix(in oklab, var(--wf-warn) 14%, transparent); color: var(--wf-warn); font-family: var(--wf-mono); font-variant-numeric: tabular-nums; }
.wf-head :deep(.wf-run-select) { min-width: 0; max-width: min(420px, 100%); height: 26px; padding: 0 8px 0 10px; border: 1px solid var(--wf-border); border-radius: 6px;
  background: var(--wf-well); color: var(--wf-text); font-size: 12px; cursor: pointer; }
.wf-head :deep(.wf-run-select:hover), .wf-player :deep(.wf-speed:hover) { border-color: var(--wf-guide); }
.wf-head :deep(.wf-run-select:focus-visible), .wf-player :deep(.wf-speed:focus-visible) { outline: 2px solid var(--wf-accent); outline-offset: 1px; }
:deep(.wf-select-icon) { width: 12px; height: 12px; color: var(--wf-muted); }
:global(.wf-run-menu) { max-width: min(520px, calc(100vw - 32px)); max-height: min(420px, 60vh); }
:global(.wf-speed-menu) { min-width: 120px !important; }

/* A long stretch shows its latest executions first; one line says so and opens the rest. */
.wf-earlier { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; margin: 0; padding: 6px 16px; border-bottom: 1px solid var(--wf-border); color: var(--wf-muted); font-size: 12px; }
.wf-earlier .wf-text-button { color: var(--wf-accent); }
/* Overview: one line per run, its length as a bar against the longest; a click opens that run. */
.wf-runs { margin: 0; padding: 4px 0; list-style: none; }
.wf-run { display: grid; gap: 4px; width: 100%; padding: 8px 16px; border: 0; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.wf-run:hover { background: var(--wf-hover); }
.wf-run:focus-visible { outline: 2px solid var(--wf-accent); outline-offset: -2px; }
.wf-run-line { display: flex; align-items: baseline; gap: 10px; min-width: 0; }
.wf-run-line time { flex: none; color: var(--wf-muted); font-family: var(--wf-mono); font-size: 12px; font-variant-numeric: tabular-nums; }
.wf-run-line strong { flex: 1; min-width: 0; overflow: hidden; font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }
.wf-run-meta { flex: none; color: var(--wf-muted); font-family: var(--wf-mono); font-size: 12px; font-variant-numeric: tabular-nums; }
/* The bar is as long as the stretch against the longest one; inside, who took the time, in each member's hue, and the
   waiting as a hatch. */
.wf-run-bar { display: block; height: 8px; border-radius: 3px; background: var(--wf-well); }
.wf-run-fill { display: flex; gap: 1px; min-width: 3px; height: 100%; overflow: hidden; border-radius: 3px; }
.wf-run-fill i { flex-basis: 0; min-width: 2px; background: var(--tone, var(--wf-plain)); }
.wf-run-fill i.is-wait { background: repeating-linear-gradient(-45deg, var(--wf-hatch) 0 1px, transparent 1px 4px); box-shadow: inset 0 0 0 1px var(--wf-hatch); }
/* A long wait is marked in the bar too, so a phone, which leaves the words out, still shows it. */
.wf-run-fill i.is-wait.is-long { --wf-hatch: color-mix(in oklab, var(--wf-warn) 70%, transparent); }
.wf-run-wait { flex: none; color: var(--wf-warn); font-family: var(--wf-mono); font-size: 12px; font-variant-numeric: tabular-nums; }

/* Grid: the label column, the lanes and the duration column share one template, the axis included. */
.wf-grid { display: grid; grid-template-columns: var(--wf-label-col) minmax(0, 1fr) 76px; }
/* The axis row stays in view while the rows scroll under it. */
.wf-axis-label, .wf-axis, .wf-axis-end { position: sticky; top: var(--wf-sticky-top, 0px); z-index: 3; background: var(--wf-surface); }
/* The page scrolls inside .content-page, whose top padding (channel.css: 34px, 24px at 700px and below) a sticky box
   would otherwise stop under, letting rows show above it. */
.execution-timeline { --wf-sticky-top: -34px; }
@media (max-width: 700px) { .execution-timeline { --wf-sticky-top: -14px; } }
/* The axis keeps side margins to line up with the tracks; its shadow fills them, so rows never show through. */
.wf-axis { box-shadow: -12px 0 0 var(--wf-surface), 12px 0 0 var(--wf-surface); }
.wf-axis-label { display: flex; align-items: center; gap: 8px; min-width: 0; height: 30px; padding: 0 8px 0 16px; border-right: 1px solid var(--wf-border); border-bottom: 1px solid var(--wf-border); color: var(--wf-muted); font-size: 12px; cursor: help; }
.wf-branch { display: flex; gap: 2px; margin-left: auto; }
.wf-text-button { display: inline-flex; align-items: center; gap: 4px; height: 22px; padding: 0 6px; border: 0; border-radius: 4px; background: transparent; color: var(--wf-muted); font: inherit; cursor: pointer; white-space: nowrap; }
.wf-text-button:hover { background: var(--wf-hover); color: var(--wf-text); }
.wf-text-button :deep(svg) { width: 12px; height: 12px; }
.wf-axis { height: 30px; margin: 0 12px; border-bottom: 1px solid var(--wf-border); color: var(--wf-muted); font-family: var(--wf-mono); font-size: 11px; }
.wf-tick { position: absolute; top: 50%; padding-left: 4px; border-left: 1px solid var(--wf-guide); line-height: 14px; white-space: nowrap; transform: translateY(-50%); font-variant-numeric: tabular-nums; }
/* A folded idle stretch says how long it was right on the axis, so evenly spaced ticks are never read as even time. */
.wf-fold-label { position: absolute; top: 50%; padding: 0 4px; border-radius: 4px; background: var(--wf-surface); color: var(--wf-muted); font-size: 10px; line-height: 14px; white-space: nowrap; transform: translate(-50%, -50%); cursor: help; z-index: 1; }
/* Now, while work runs: a dot on the axis and a line down through every lane. */
.wf-cursor-head { position: absolute; bottom: -5px; width: 9px; height: 9px; border-radius: 50%; background: var(--wf-text); box-shadow: 0 0 0 2px var(--wf-surface); transform: translateX(-50%); z-index: 2; }
.wf-axis-end { display: flex; align-items: center; justify-content: flex-end; height: 30px; padding-right: 16px; border-bottom: 1px solid var(--wf-border); color: var(--wf-muted); font-size: 12px; }

/* Rows: a tint on hover and while opened; off the critical path a row steps back, and comes forward when pointed at. */
.wf-row { display: contents; }
.wf-row > :not(.wf-detail) { min-height: var(--wf-row-h); background: var(--wf-tint, transparent); transition: background-color 120ms ease, opacity 120ms ease; }
.wf-row:hover > :not(.wf-detail), .wf-row.is-open > :not(.wf-detail) { --wf-tint: var(--wf-hover); }
/* Only the words step back: the bars keep their colors, so the waterfall stays whole. */
.marks-path .wf-row.is-off-path:not(:hover, .is-open) > :is(.wf-label, .wf-end, .wf-row-status) { opacity: .5; }
.wf-label { position: relative; display: flex; align-items: center; gap: 6px; min-width: 0; padding: 0 10px 0 calc(10px + var(--depth) * var(--wf-depth-px)); border-right: 1px solid var(--wf-border); }
.wf-guides { position: absolute; top: 0; bottom: 0; left: 18px; width: 2px; border-radius: 1px; background: var(--wf-guide); pointer-events: none; }
.wf-toggle, .wf-toggle-space { display: grid; flex: 0 0 16px; place-items: center; width: 16px; height: 16px; padding: 0; border: 0; border-radius: 4px; background: transparent; color: var(--wf-muted); cursor: pointer; }
.wf-toggle :deep(svg) { width: 12px; height: 12px; transition: transform 160ms ease; }
.wf-toggle.is-open :deep(svg) { transform: rotate(90deg); }
.wf-toggle:hover { background: var(--wf-hover); color: var(--wf-text); }
.wf-avatar { flex: none; }
.wf-names { display: flex; flex: 1; flex-direction: column; min-width: 0; padding: 3px 0; border: 0; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.wf-names:focus-visible, .wf-toggle:focus-visible, .wf-text-button:focus-visible, .wf-note:focus-visible { outline: 2px solid var(--wf-accent); outline-offset: 1px; border-radius: 4px; }
.wf-name-line { display: flex; align-items: center; gap: 6px; min-width: 0; line-height: 16px; }
/* A running row says so before its name. */
.wf-spinner { flex: none; width: 10px; height: 10px; border: 1.5px solid color-mix(in oklab, var(--wf-accent) 30%, transparent); border-top-color: var(--wf-accent); border-radius: 50%; animation: wf-spin .8s linear infinite; }
.wf-name-line strong { overflow: hidden; color: var(--wf-text); font-size: 13px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.wf-pill { flex: none; height: 16px; padding: 0 6px; border-radius: 999px; font-size: 11px; font-style: normal; font-weight: 600; line-height: 16px; }
.wf-pill.is-role { background: var(--wf-well); color: var(--wf-muted); font-weight: 500; }
.wf-pill.is-slowest { background: color-mix(in oklab, var(--wf-warn) 16%, transparent); color: var(--wf-warn); }
.wf-pill.is-live { background: color-mix(in oklab, var(--wf-accent) 14%, transparent); color: var(--wf-accent); }
.wf-pill.is-failed { background: color-mix(in oklab, var(--wf-failed) 14%, transparent); color: var(--wf-failed); }
.wf-status { overflow: hidden; color: var(--wf-muted); font-size: 12px; line-height: 16px; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }
.wf-status.is-live { color: var(--ui-text); }
.wf-status.is-warn { color: var(--wf-warn); }
.wf-status.is-failed { color: var(--wf-failed); }

/* Lanes: gridlines and folded idle bands behind a well that runs the lane's width; bars sit on the well. */
.wf-lane { display: flex; min-width: 0; }
.wf-track { position: relative; flex: 1; min-width: 0; margin: 0 12px; }
/* Zoomed in, bars and lines past the edges of the view are cut off at the track. */
.wf-grid.is-zoomed .wf-track { overflow: hidden; }
.wf-grid.is-zoomed .wf-axis { cursor: grab; }
.wf-grid.is-panning, .wf-grid.is-panning * { cursor: grabbing !important; user-select: none; }
.wf-zoom { display: inline-flex; align-items: center; gap: 2px; color: var(--wf-accent); font-family: var(--wf-mono); font-size: 11px; white-space: nowrap; }
.wf-zoom-reset { display: inline-flex; align-items: center; gap: 4px; height: 22px; margin-left: 6px; padding: 0 8px; border: 1px solid color-mix(in oklab, var(--wf-accent) 45%, transparent); border-radius: 999px;
  background: color-mix(in oklab, var(--wf-accent) 12%, transparent); color: var(--wf-accent); font: inherit; font-family: var(--ui-font-sans, inherit); font-size: 11px; font-weight: 600; cursor: pointer; }
.wf-zoom-reset:hover { background: color-mix(in oklab, var(--wf-accent) 22%, transparent); }
.wf-zoom-reset :deep(svg) { width: 12px; height: 12px; }
.wf-track > i, .wf-track > .wf-note { position: absolute; display: block; font-style: normal; }
.wf-gridline { top: 0; bottom: 0; width: 1px; background: var(--wf-grid); }
.wf-cursor { top: 0; bottom: 0; width: 1px; background: color-mix(in oklab, var(--wf-text) 70%, transparent); z-index: 2; pointer-events: none; }
/* Hand-off: from a dot on the dispatcher's bar at the moment of dispatch, a hairline down to the dispatched bar. */
.wf-link { width: 0; border-left: 1.5px solid var(--tone, var(--wf-muted)); opacity: .8; z-index: 1; pointer-events: none; }
.wf-link.is-through { top: 0; bottom: 0; }
.wf-link.is-start { top: 50%; bottom: 0; }
.wf-link.is-start::before { position: absolute; top: -4px; left: -4.75px; width: 8px; height: 8px; border-radius: 50%; background: var(--tone, var(--wf-muted)); box-shadow: 0 0 0 2px var(--wf-surface); content: ""; }
.wf-link.is-end { top: 0; width: 8px; height: 50%; border-bottom: 1.5px solid var(--tone, var(--wf-muted)); border-bottom-left-radius: 6px; }
/* Folded idle time is a faint band only: its edges would read as more gridlines. */
.wf-fold { top: 0; bottom: 0; background: color-mix(in oklab, var(--ui-text) 4%, transparent); }
.wf-well { top: calc(50% - var(--wf-bar-h) / 2); right: 0; left: 0; height: var(--wf-bar-h); border-radius: 3px; background: var(--wf-well); }
.wf-bar { top: calc(50% - var(--wf-bar-h) / 2); height: var(--wf-bar-h); min-width: 2px; border-radius: 3px; cursor: pointer; transition: filter 120ms ease; }
.wf-bar:hover { z-index: 1; filter: brightness(1.15); box-shadow: 0 0 0 2px color-mix(in oklab, var(--wf-text) 30%, transparent); }
.wf-bar.is-queue { background: repeating-linear-gradient(-45deg, var(--wf-hatch) 0 1px, transparent 1px 5px); box-shadow: inset 0 0 0 1px var(--wf-hatch); }
.wf-bar.is-wake { background: color-mix(in oklab, var(--wf-wake) 55%, var(--wf-surface)); box-shadow: inset 0 0 0 1px var(--wf-wake); }
.wf-bar.is-work { background: var(--wf-plain); }
/* A member's hue, on every mark that belongs to it: its bars, its phases, its hand-off line. */
.wf [data-tone="1"] { --tone: var(--wf-h1); }
.wf [data-tone="2"] { --tone: var(--wf-h2); }
.wf [data-tone="3"] { --tone: var(--wf-h3); }
.wf [data-tone="4"] { --tone: var(--wf-h4); }
.wf [data-tone="5"] { --tone: var(--wf-h5); }
/* Without phases, an execution is a tint of its member's hue with an outline in it, so it never reads as a solid phase. */
.wf-bar.is-work[data-tone] { background: color-mix(in oklab, var(--tone) 32%, var(--wf-surface)); box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--tone) 70%, transparent); }
/* With phases recorded, the execution's own extent is only a faint frame under them. */
.wf-bar.is-work.has-detail { background: color-mix(in oklab, var(--ui-text) 5%, transparent); }
.is-failed .wf-bar.is-work { background: color-mix(in oklab, var(--wf-failed) 22%, var(--wf-surface)); box-shadow: inset 0 0 0 1px var(--wf-failed); }
.is-stalled .wf-bar.is-work, .is-stalled .wf-seg.is-live { box-shadow: inset 0 0 0 1.5px var(--wf-warn); }
/* Kind is a shade of the member's hue: the model's own turns in the full hue, tool work a lighter step with an edge. */
.is-model { background: var(--tone, var(--wf-plain)); }
.is-tool { background: color-mix(in oklab, var(--tone, var(--wf-plain)) 45%, var(--wf-surface)); box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--tone, var(--wf-plain)) 65%, transparent); }
/* Past the last output the phase is only assumed to go on; a long faint tail is what a stalled execution looks like. */
.wf-seg.is-tail { min-width: 0; border-radius: 0 3px 3px 0; opacity: .28; }
.wf-swatch { display: inline-block; flex: none; width: 12px; height: 8px; border-radius: 2px; }
.wf-swatch.is-queue { background: repeating-linear-gradient(-45deg, var(--wf-hatch) 0 1px, transparent 1px 4px); box-shadow: inset 0 0 0 1px var(--wf-hatch); }
.wf-swatch.is-wake { background: color-mix(in oklab, var(--wf-wake) 55%, var(--wf-surface)); box-shadow: inset 0 0 0 1px var(--wf-wake); }
.wf-swatch.is-fold { background: color-mix(in oklab, var(--ui-text) 10%, transparent); }
/* A note is a hairline inside the bar's height: it marks a moment, and must never outshout the work it annotates. */
.wf-note { top: calc(50% - var(--wf-bar-h) / 2); width: 9px; height: var(--wf-bar-h); margin-left: -4px; padding: 0; border: 0; background: linear-gradient(var(--wf-text), var(--wf-text)) center / 1.5px 100% no-repeat; opacity: .35; cursor: pointer; z-index: 2; }
.wf-note:hover, .wf-note:focus-visible { opacity: 1; }

/* Duration column: tabular figures, the state under it when it is not a plain finish. */
.wf-end { display: flex; flex-direction: column; align-items: flex-end; justify-content: center; padding-right: 14px; white-space: nowrap; font-family: var(--wf-mono); font-size: 12px; line-height: 15px; font-variant-numeric: tabular-nums; }
.wf-end small, .wf-name-end small { color: var(--wf-muted); font-family: var(--ui-font-sans, inherit); font-size: 11px; }
:is(.wf-end, .wf-name-end) small.is-failed { color: var(--wf-failed); }
:is(.wf-end, .wf-name-end) small.is-running { color: var(--wf-accent); }

/* Detail: a panel floating under the opened name; on a phone it opens in place under the row. */
.wf-detail { position: absolute; z-index: 20; width: min(560px, calc(100% - 16px)); max-height: min(60vh, 520px); padding: 12px 14px; overflow: auto;
  border: 1px solid var(--channel-edge-float, var(--wf-border)); border-radius: 10px; background: var(--ui-bg-elevated); box-shadow: var(--channel-shadow-float, 0 12px 32px rgb(0 0 0 / .3)); font-size: 13px; }
.wf-detail-head { position: relative; display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; margin: 0 0 10px; padding-right: 32px; }
.wf-detail-head strong { color: var(--wf-text); font-size: 14px; }
.wf-detail-head small { color: var(--wf-muted); font-size: 12px; }
.wf-detail .wf-card-close { top: -6px; right: -6px; }
.wf-detail dl { display: grid; gap: 6px; margin: 0 0 10px; }
.wf-detail dl > div { display: grid; grid-template-columns: 48px minmax(0, 1fr); gap: 8px; }
.wf-detail dt { color: var(--wf-muted); font-size: 12px; }
.wf-detail dd { margin: 0; overflow-wrap: anywhere; }
.wf-detail .subtle-link { margin-left: 8px; }
.wf-detail dd > .subtle-link:first-child { margin-left: 0; }
.wf-log { display: grid; gap: 4px; max-height: 320px; margin: 0; padding: 10px 0 0; overflow: auto; border-top: 1px solid var(--wf-border); list-style: none; }
.wf-log li { display: grid; grid-template-columns: 64px 12px minmax(0, 1fr); align-items: baseline; gap: 8px; font-size: 12px; }
.wf-log li.log-note { grid-template-columns: 64px minmax(0, 1fr); }
.wf-log time { color: var(--wf-muted); font-family: var(--wf-mono); font-size: 11px; font-variant-numeric: tabular-nums; }
.wf-log li.log-phase span { color: var(--wf-muted); }
.wf-log-note { color: var(--wf-text); line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; }

/* Footer: the three kinds of time, folded idle and truncation notes, and the way into a replay. */
.wf-foot { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 18px; padding: 8px 16px; border-top: 1px solid var(--wf-border); color: var(--wf-muted); font-size: 12px; }
.wf-foot span { display: inline-flex; align-items: center; gap: 6px; }
.wf-key .wf-swatch:not(:first-child) { margin-left: 8px; }
.wf-key .wf-swatch.is-model, .wf-key .wf-swatch.is-tool { --tone: var(--wf-muted); }
.wf-replay-open { margin-left: auto; }
/* Playback: replay a finished run on the same drawing. */
.wf-player { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; padding: 8px 16px; border-top: 1px solid var(--wf-border); color: var(--wf-muted); font-size: 12px; }
.wf-player-button { display: grid; place-items: center; width: 28px; height: 28px; padding: 0; border: 1px solid var(--wf-border); border-radius: 50%; background: var(--wf-surface); color: var(--wf-text); cursor: pointer; }
.wf-player-button:disabled { opacity: .4; cursor: default; }
.wf-player-button:not(:disabled):hover { background: var(--wf-hover); }
.wf-player-button :deep(svg) { width: 13px; height: 13px; }
.wf-player :deep(.wf-speed) { height: 28px; padding: 0 6px 0 8px; gap: 4px; border: 1px solid var(--wf-border); border-radius: 6px; background: var(--wf-well); color: var(--wf-text); font: inherit; font-size: 12px; cursor: pointer; }
.wf-scrub { flex: 1; min-width: 120px; accent-color: var(--wf-accent); cursor: pointer; }
.wf-player-time { font-family: var(--wf-mono); font-variant-numeric: tabular-nums; white-space: nowrap; }
.wf-player :is(button, input):focus-visible { outline: 2px solid var(--wf-accent); outline-offset: 1px; }

.wf-card-close { position: absolute; top: 4px; right: 4px; display: grid; place-items: center; width: 32px; height: 32px; padding: 0; border: 0; border-radius: 6px; background: transparent; color: var(--ui-text-muted); cursor: pointer; }
/* The clicked piece, at the top of the detail: what it was, when, and the notes written around then. */
.wf-detail-piece { display: grid; gap: 4px; margin: 0 0 10px; padding: 8px 10px; border-radius: 8px; background: var(--wf-well); font-size: 12px; }
.wf-detail-piece strong { color: var(--wf-text); font-size: 13px; }
.wf-detail-piece small { color: var(--wf-muted); font-variant-numeric: tabular-nums; }
.wf-detail-piece-label { margin-top: 4px; }
.wf-detail-piece ol { display: grid; gap: 6px; margin: 0; padding: 0; line-height: 1.6; list-style: none; white-space: pre-wrap; overflow-wrap: anywhere; }
.wf-detail-piece time { margin-right: 6px; color: var(--ui-text-dimmed); font-variant-numeric: tabular-nums; }

@keyframes wf-ping { from { opacity: .7; transform: scale(1); } 70%, to { opacity: 0; transform: scale(2.8); } }
@keyframes wf-spin { to { transform: rotate(360deg); } }

/* Narrow pages (a small window, or both rails open): a shorter label column, so the lanes keep room. */
.execution-timeline { container: wf / inline-size; }
@container wf (max-width: 900px) {
  .wf { --wf-label-col: 200px; }
  .wf-grid { grid-template-columns: var(--wf-label-col) minmax(0, 1fr) 68px; }
  .wf-end { padding-right: 10px; }
}
/* Phones (decided by the page's own width, in script): no shared axis. Each execution is three lines: when, who and how
   long; its own duration split by kind, against the longest in the round; what its time went to. */
.wf.is-compact .wf-head, .wf.is-compact .wf-foot, .wf.is-compact .wf-player { padding-inline: 12px; }
.wf.is-compact .wf-run { padding-inline: 12px; }
/* On a phone a stretch is two lines: when, who led, how many and how long; then the bar. */
.wf.is-compact .wf-run-line { gap: 8px; }
.wf.is-compact .wf-grid { grid-template-columns: minmax(0, 1fr); }
.wf.is-compact .wf-row > :not(.wf-detail) { min-height: 0; }
.wf.is-compact .wf-label { padding: 6px 12px 0 calc(12px + var(--depth) * var(--wf-depth-px)); border-top: 1px solid var(--wf-border); border-right: 0; }
.wf.is-compact .wf-row:first-of-type .wf-label { border-top: 0; }
.wf.is-compact .wf-guides { left: 14px; }
.wf.is-compact .wf-names { padding: 0; }
.wf.is-compact .wf-clock { flex: none; color: var(--wf-muted); font-family: var(--wf-mono); font-size: 11px; font-variant-numeric: tabular-nums; }
.wf.is-compact .wf-name-end { display: inline-flex; flex: none; align-items: baseline; gap: 6px; margin-left: auto; font-family: var(--wf-mono); font-size: 12px; font-variant-numeric: tabular-nums; }
.wf.is-compact .wf-lane { height: 22px; }
.wf.is-compact .wf-row-status { padding: 0 12px 6px; }
.wf.is-compact .wf-row.is-brief .wf-label { padding-bottom: 6px; }
/* A phone row's bar: proportions by kind, against the longest execution; a tap opens the row like its name does. */
.wf-mix-lane { display: block; width: 100%; padding: 4px 12px; border: 0; background: var(--wf-tint, transparent); text-align: left; cursor: pointer; }
.wf-mix { display: flex; gap: 1px; min-width: 4px; height: var(--wf-bar-h); overflow: hidden; border-radius: 3px; }
.wf-mix-part { flex-basis: 0; min-width: 2px; padding: 0 4px; overflow: hidden; color: var(--wf-text); font-size: 11px; font-weight: 500; line-height: var(--wf-bar-h); white-space: nowrap; }
.wf-mix-part.is-wait { color: var(--wf-muted); background: repeating-linear-gradient(-45deg, var(--wf-hatch) 0 1px, transparent 1px 5px); box-shadow: inset 0 0 0 1px var(--wf-hatch); }
.wf-mix-part.is-wait.is-long { color: var(--wf-warn); --wf-hatch: color-mix(in oklab, var(--wf-warn) 55%, transparent); }
.wf-mix-part.is-work { background: color-mix(in oklab, var(--tone, var(--wf-plain)) 32%, var(--wf-surface)); }
.wf-mix-part.is-model { color: var(--ui-bg); }
.is-failed .wf-mix { box-shadow: inset 0 0 0 1px var(--wf-failed); }
.is-stalled .wf-mix { box-shadow: inset 0 0 0 1.5px var(--wf-warn); }
/* What needs a look, above the rows: running work and failures as cards; a tap opens the row below. */
.wf-now { display: grid; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--wf-border); }
.wf-now-card { display: grid; gap: 3px; width: 100%; padding: 8px 10px; border: 1px solid var(--wf-border); border-radius: 8px; background: var(--wf-well); color: inherit; font: inherit; text-align: left; cursor: pointer; }
.wf-now-card.is-stalled { border-color: color-mix(in oklab, var(--wf-warn) 60%, transparent); }
.wf-now-card.is-failed { border-color: color-mix(in oklab, var(--wf-failed) 55%, transparent); }
.wf-now-line { display: flex; align-items: center; gap: 6px; min-width: 0; }
.wf-now-line strong { overflow: hidden; font-size: 14px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.wf-now-time { flex: none; margin-left: auto; color: var(--wf-muted); font-family: var(--wf-mono); font-size: 12px; font-variant-numeric: tabular-nums; }
.wf-now-status { display: -webkit-box; font-size: 13px; line-height: 18px; white-space: normal; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.wf-now-note { overflow: hidden; color: var(--wf-muted); font-size: 12px; line-height: 17px; text-overflow: ellipsis; white-space: nowrap; }
.wf.is-compact .wf-detail { position: static; width: auto; max-height: none; margin: 0 8px 8px; box-shadow: none; }
/* Touch: controls keep their look but take a fingertip; a note's tick is easier to hit. */
@media (pointer: coarse) {
  .wf-toggle { flex: 0 0 32px; width: 32px; height: 32px; margin: -8px; }
  .wf-text-button { height: 32px; }
  .wf-note { width: 24px; margin-left: -12px; }
}
</style>

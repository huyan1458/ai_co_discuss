<script setup>
import { t, locale } from './i18n.js';
/**
 * The execution timeline: the room's run monitor. It answers what the message page cannot, since that page is linear
 * and says what was said: where each run's time went, who waited on whom, what held a round up, and whether running
 * work is still making progress. Every execution the local service woke is one row, nested under the execution that
 * dispatched it, its bar split into waiting, model and tool time and labelled where wide enough. A sentence at the top
 * says what the round came down to; the critical path stays bright and the rest steps back.
 * Phase reports wake no other page, so this page reads on its own: in full when opened, then only what is running or
 * just ended, every two seconds while anything runs and whenever the room changes. Running bars grow four times a second.
 * A finished run can be replayed: the same drawing, with the playback position as now.
 * On a phone a clock axis over hours has no resolution left, so each top-level row and the executions under it share
 * an axis of their own and still step down as a waterfall.
 */
import { computed, inject, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { FOLD_GAP_MS, PHASE_KINDS, add_user_turns, has_phase_detail, is_user_row, PHASE_LABELS, STATE_LABELS, WAIT_WARN_MS, axis_ticks, execution_log, format_duration, handoff_lines, notes_between,
  pan_window, row_breakdown, row_status, snapshot_at, task_digest, timeline_axis, timeline_rows, timeline_segments, recent_window, task_overview, requested_at, view_axis, zoom_window } from "./timeline-model.js";
import RealtimeView from "./RealtimeView.vue";
import { touch_zoom } from "./touch-zoom.js";

const emit = defineEmits(["detail"]);
const { view, bridge } = inject("discussion");
const LIVE_REFRESH_MS = 2000;
const FULL_REFRESH_MS = 60_000;
// A replay plays every frame with few rows; with many, this often.
const CLOCK_MS = 100;
// Running bars grow this often: each tick recomputes and redraws every row, and at a frame each the page lagged
// (2026-11-21); a bar on an axis of minutes moves well under a pixel in this time.
const LIVE_CLOCK_MS = 250;
const SMOOTH_ROWS = 60;
// A row that appears while watching slides in for this long.
const ENTER_MS = 520;
// A replay at "auto" speed lasts about this long, whatever the run's length; manual speeds are these multiples.
const REPLAY_TARGET_MS = 20_000;
const REPLAY_SPEEDS = [1, 2, 4, 8, 16, 32];
// An incremental read also takes executions that ended this long before the previous read, so none slips between reads.
const OVERLAP_SECONDS = 5;
// Each depth level indents a row's label by this much.
const DEPTH_PX = 14;
const COMPACT_DEPTH_PX = 12;
// At or below this page width, the timeline takes its phone layout (one column, rows stacked, details in place).
const COMPACT_MAX_PX = 640;
// About one axis tick per this many pixels of axis, and never fewer or more than these.
const TICK_SPACING_PX = 90;
// Phones space them closer: four ticks over a few hours land on two-hour steps, and folds and the edge leave none.
const COMPACT_TICK_SPACING_PX = 64;
const MIN_TICKS = 2;
const MAX_TICKS = 8;
const section_element = ref(null);
const section_width = ref(0);
const axis_element = ref(null);
const axis_width = ref(0);
let size_observer = null;
const room_id = computed(() => view.value.room?.id);
const executions = ref(new Map());
const limits = ref(null);
// Whether the site has executions older than the oldest one read (`before` pages reach back to the first).
const earlier = ref(false);
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
const reading = ref(false);
let reading_room = "", read_version = 0;
onBeforeUnmount(() => { read_version++; reload = ""; });
// A read asked for during another: "" none, "next" incremental, "full" whole.
let reload = "";
let refresh_timer = 0;
let frame = 0;
let last_frame = 0;
let last_paint = 0;
// Replay: `position` is milliseconds into the run (null: not replaying), `speed` 0 means auto.
const replay = reactive({ position: null, playing: false, speed: 0 });
const show_player = ref(false);
let play_position = 0;

/**
 * Phases are read for the rows on show only (#8131): a whole read leaves them out (`segments=0`), 86% of its size, and
 * rows near the screen ask for theirs in batches. A share page has every read recorded, so it reads them in full.
 * Finished executions' phases never change and are kept by id.
 */
const phase_cache = new Map();
const lite = () => (view.value.share ? "" : "segments=0");
const timeline_path = (id, query = "") => `/api/rooms/${id}/timeline${[query, lite()].filter(Boolean).length ? `?${[query, lite()].filter(Boolean).join("&")}` : ""}`;
/** An execution as read, its phases taken from the cache or marked as still to read. */
function adopt(item) {
  if (Array.isArray(item.segments)) {
    if (item.state !== "running") phase_cache.set(item.id, item.segments);
    return item;
  }
  const known = phase_cache.get(item.id);
  return known ? { ...item, segments: known } : { ...item, segments: [], segments_pending: true };
}
let phase_wanted = new Set();
let phase_timer = 0;
// Phases are asked for in batches of at most this many executions, a moment after the rows that want them show.
const PHASE_BATCH = 200;
const PHASE_WAIT_MS = 40;
/** Ask for the phases of these executions, once each, batched with others asked for meanwhile. */
function want_phases(ids) {
  for (const id of ids) {
    const item = executions.value.get(`free:${id}`);
    if (item?.segments_pending && !phase_cache.has(id)) phase_wanted.add(id);
  }
  if (!phase_wanted.size || phase_timer) return;
  phase_timer = setTimeout(read_phases, PHASE_WAIT_MS);
}
async function read_phases() {
  phase_timer = 0;
  const room = room_id.value;
  const ids = [...phase_wanted].slice(0, PHASE_BATCH);
  for (const id of ids) phase_wanted.delete(id);
  if (!room || !ids.length) return;
  try {
    const { segments } = await bridge.request(`/api/rooms/${room}/timeline/segments?ids=${ids.join(",")}`);
    if (room !== room_id.value) return;
    const next = new Map(executions.value);
    for (const [id, list] of Object.entries(segments)) {
      const phases = list.map(([phase, tool, start_ms, end_ms]) => ({ phase, tool, start_ms, end_ms }));
      phase_cache.set(Number(id), phases);
      const item = next.get(`free:${id}`);
      if (item?.segments_pending) next.set(`free:${id}`, { ...item, segments: phases, segments_pending: false });
    }
    executions.value = next;
  } catch {
    // Rows without their phases keep their plain bars; showing them again asks once more.
  }
  if (phase_wanted.size && !phase_timer) phase_timer = setTimeout(read_phases, PHASE_WAIT_MS);
}
// Rows within this distance of the screen ask for their phases.
const PHASE_MARGIN = "600px 0px";
let phase_observer = null;
/** Watch the shown rows; those coming near the screen ask for their phases. */
function observe_rows() {
  phase_observer?.disconnect();
  if (!wf_element.value || typeof IntersectionObserver === "undefined") return;
  phase_observer = new IntersectionObserver((entries) => {
    want_phases(entries.filter((entry) => entry.isIntersecting).map((entry) => Number(entry.target.dataset.row.split(":")[1])).filter(Boolean));
  }, { rootMargin: PHASE_MARGIN });
  for (const node of wf_element.value.querySelectorAll(".wf-label[data-row^='free:']")) phase_observer.observe(node);
}
onBeforeUnmount(() => { phase_observer?.disconnect(); clearTimeout(phase_timer); });

/** Read the timeline: in full when asked or due, else only executions still running or ended since the last read. */
async function load(full = false) {
  const id = room_id.value;
  if (!id) return;
  // A read asked for while another is in flight runs once that one ends, so a room switch is never dropped.
  if (reading.value && reading_room === id) { reload = reload === "full" || full ? "full" : "next"; return; }
  const version = ++read_version;
  reading.value = true;
  reading_room = id;
  const after = full || !last_read || Date.now() - last_full >= FULL_REFRESH_MS ? 0 : last_read - OVERLAP_SECONDS;
  try {
    const result = await bridge.request(timeline_path(id, after ? `after=${after}` : ""));
    if (version !== read_version || id !== room_id.value) return;
    const next = after ? new Map(executions.value) : new Map();
    for (const item of result.executions) next.set(`${item.source}:${item.id}`, adopt(item));
    // A full read rereads only the latest page; older pages already read stay, and so does what is known beyond them.
    const oldest = Math.min(...result.executions.map((item) => item.id));
    const kept = after ? [] : [...executions.value.values()].filter((item) => item.id < oldest);
    for (const item of kept) next.set(`${item.source}:${item.id}`, item);
    if (!after && !kept.length) earlier.value = Boolean(result.earlier);
    executions.value = next;
    limits.value = { execution_limit: result.execution_limit, segment_limit: result.segment_limit };
    last_read = result.now;
    read_at.value = Date.now();
    now.value = Date.now();
    if (!after) last_full = Date.now();
    error.value = "";
  } catch (failure) {
    if (version === read_version) error.value = t('读取执行记录失败：{value1}', { value1: failure.message });
  } finally {
    if (version === read_version) {
      reading.value = false;
      const pending = reload;
      reload = "";
      if (pending) load(pending === "full");
    }
  }
}

/** Read the page of executions older than the oldest one read, then show that many more rows. */
async function load_earlier() {
  const id = room_id.value;
  const oldest = Math.min(...[...executions.value.values()].map((item) => item.id));
  if (!id || !Number.isFinite(oldest) || loading_earlier.value) return;
  loading_earlier.value = true;
  try {
    const result = await bridge.request(timeline_path(id, `before=${oldest}`));
    if (id !== room_id.value) return;
    const next = new Map(executions.value);
    for (const item of result.executions) next.set(`${item.source}:${item.id}`, adopt(item));
    executions.value = next;
    earlier.value = Boolean(result.earlier);
  } catch (failure) {
    bridge.notify("error", t('读取执行记录失败：{value1}', { value1: failure.message }));
  } finally {
    loading_earlier.value = false;
  }
}
const loading_earlier = ref(false);

const timeline = computed(() => limits.value && { ...limits.value, executions: [...executions.value.values()] });
const running = computed(() => timeline.value?.executions.some((item) => item.state === "running"));
// Only running work changes the timeline between room changes, and a hidden page need not follow it.
watch(running, (live) => {
  clearInterval(refresh_timer);
  if (!live) return;
  refresh_timer = setInterval(() => { if (!document.hidden) load(); }, LIVE_REFRESH_MS);
}, { immediate: true });
watch(room_id, () => {
  executions.value = new Map(); limits.value = null; earlier.value = false; collapsed.value = new Set(); note_texts.value = new Map(); opened.value = "";
  phase_cache.clear(); phase_wanted = new Set();
  last_read = 0;
  error.value = "";
  reload = "";
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
// Fingers on the lanes or the axis: pinch zooms, a sideways drag pans (touch-zoom.js), on phones as on tablets.
const gesture = touch_zoom({ share_at: (client_x) => pointer_share({ clientX: client_x }).share, width: () => pointer_share({ clientX: 0 }).width,
  on_zoom: (anchor, factor) => { zoom.value = zoom_window(zoom.value, anchor, factor, axis.value.total_ms); },
  on_pan: (share) => { zoom.value = pan_window(zoom.value, share); }, can_pan: () => zoomed.value });
const on_lanes = (event) => Boolean(axis_element.value && event.target.closest?.(".wf-track, .wf-axis, .wf.is-compact .wf-row"));
/** Middle-button drag anywhere on the lanes, or a left-button drag on the axis, pans a zoomed view. */
function on_pan_start(event) {
  if (event.pointerType === "touch") { if (on_lanes(event)) gesture.down(event); return; }
  const on_axis = event.target.closest?.(".wf-axis");
  if (!zoomed.value || !(event.button === 1 || (event.button === 0 && on_axis)) || !event.target.closest?.(".wf-track, .wf-axis")) return;
  event.preventDefault();
  pan = { x: event.clientX, from: zoom.value.from, width: pointer_share(event).width };
  event.currentTarget.setPointerCapture(event.pointerId);
}
function on_pan_move(event) {
  if (event.pointerType === "touch") { gesture.move(event); return; }
  if (pan) zoom.value = pan_window({ from: pan.from, span: zoom.value.span }, -(event.clientX - pan.x) / pan.width);
}
function on_pan_end(event) {
  if (event.pointerType === "touch") gesture.up(event);
  pan = null;
}
/** A double click on the axis or the lanes shows the whole run again, following live work. */
function reset_on_dblclick(event) { if (event.target.closest?.(".wf-track, .wf-axis")) zoom.value = WHOLE; }
// A middle press would start the browser's autoscroll over the lanes; the drag pans instead.
function stop_autoscroll(event) { if (event.button === 1 && event.target.closest?.(".wf-track, .wf-axis")) event.preventDefault(); }

/** The open detail closes on a click anywhere else, or on Esc. */
function close_on_outside(event) {
  if (opened.value && !event.target.closest?.(".wf-detail, .wf-names, .wf-bar, .wf-note, .rt-block, .wf.is-compact .wf-lane, .wf-now-card")) opened.value = "";
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
  clearInterval(refresh_timer); cancelAnimationFrame(frame);
  document.removeEventListener("pointerdown", close_on_outside);
  document.removeEventListener("keydown", close_on_escape);
  size_observer?.disconnect();
});

/** One continuous timeline: the latest executions (WINDOW_STEP at first, more a click away), reaching back to the start
 *  of the task the earliest of them belongs to, so no task is cut in half, with a line where each task begins; or the
 *  room task by task. A task begins where the owner asked for something new while the room was idle (timeline_segments). */
const WINDOW_STEP = 20;
const window_count = ref(WINDOW_STEP);
const view_mode = ref("timeline");
// Names say what each view answers (#8118): every run in detail, how busy the room was over the whole span, the tasks as a list.
// Busy & idle shows the whole room, so it reads every execution as it opens (#8162); the lists stay as they were.
watch(view_mode, (mode) => { if (mode === "realtime") read_all(); });
const VIEW_MODES = [{ value: "timeline", label: t('执行明细') }, { value: "realtime", label: t('全程忙闲') }, { value: "tasks", label: t('任务清单') }];
// Both the task overview and the real-time view take every execution read, rather than the timeline's window.
const overview = computed(() => view_mode.value !== "timeline");
watch(room_id, () => { window_count.value = WINDOW_STEP; view_mode.value = "timeline"; });
// Each task with the owner's own rows added (add_user_turns); `with_users` is every execution and owner row.
const segments = computed(() => timeline.value ? add_user_turns(timeline_segments(timeline.value.executions, now.value), now.value) : []);
const with_users = computed(() => timeline.value ? [...timeline.value.executions, ...segments.value.flatMap((segment) => segment.users)] : []);
const segment_of = computed(() => {
  const map = new Map();
  for (const segment of segments.value) for (const key of segment.keys) map.set(key, segment);
  return map;
});
const shown = computed(() => {
  if (!timeline.value || overview.value) return timeline.value;
  const keys = new Set();
  for (const item of recent_window(timeline.value.executions, window_count.value)) {
    for (const key of segment_of.value.get(`${item.source}:${item.id}`)?.keys || [`${item.source}:${item.id}`]) keys.add(key);
  }
  return { ...timeline.value, executions: with_users.value.filter((item) => keys.has(`${item.source}:${item.id}`)) };
});
// Executions on show, without the owner's own rows the timeline adds between them (they are messages, not runs).
const shown_runs = computed(() => shown.value?.executions.filter((item) => item.source !== "user").length || 0);
const earlier_count = computed(() => timeline.value && !overview.value
  ? timeline.value.executions.length - shown_runs.value : 0);
const when = (ms) => new Date(ms).toLocaleString(locale, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
const tasks = computed(() => view_mode.value === "tasks" ? task_overview(segments.value) : []);
// Older executions are read a page at a time, so until the last page the first task may have begun before them.
const truncated = computed(() => earlier.value);
/** Show more of the timeline: rows already read first, then the next page from the site. */
async function show_earlier() {
  if (earlier_count.value < WINDOW_STEP && earlier.value) await load_earlier();
  window_count.value += WINDOW_STEP;
}
/**
 * Read every remaining page back to the room's first execution (#8102). The pages are gathered first
 * and put in at once: put in one by one, each redrew every row, and 600 executions took 18 seconds.
 */
async function read_all() {
  const id = room_id.value;
  if (!id || loading_earlier.value || !earlier.value) return;
  loading_earlier.value = true;
  const gathered = new Map(executions.value);
  let more = earlier.value;
  try {
    while (more) {
      const oldest = Math.min(...[...gathered.values()].map((item) => item.id));
      const result = await bridge.request(timeline_path(id, `before=${oldest}`));
      if (id !== room_id.value) return;
      for (const item of result.executions) gathered.set(`${item.source}:${item.id}`, adopt(item));
      more = Boolean(result.earlier) && result.executions.length > 0;
    }
    executions.value = gathered;
    earlier.value = false;
  } catch (failure) {
    bridge.notify("error", t('读取执行记录失败：{value1}', { value1: failure.message }));
  } finally {
    loading_earlier.value = false;
  }
}
/** Show every execution on the timeline, reading the rest first. */
async function show_all() {
  await read_all();
  window_count.value = Infinity;
}
const partial = (task) => !task.opened && truncated.value;
/** A task is named by the message that opened it; a short one ("全部同意", "继续") also shows the answer it got. */
const SHORT_TASK_CHARS = 10;
const task_title = (text) => text || t('（没有记录起因）');
const task_note = (text, result) => [...(text || "")].length < SHORT_TASK_CHARS ? result || "" : "";
/** Where each task begins on the timeline: before its first top-level row in view. */
const segment_heads = computed(() => {
  const heads = new Map();
  let last = null;
  for (const row of rows.value) {
    const segment = segment_of.value.get(row.key);
    if (row.depth || !segment || segment === last) continue;
    heads.set(row.key, segment);
    last = segment;
  }
  return heads;
});
const segment_start = (segment) => Math.min(...segment.items.map(({ stages }) => stages.start));
const interjected = computed(() => new Set(segments.value.flatMap((segment) => segment.interjections.map((item) => item.key))));
const shown_interjections = ref(new Set());
function toggle_interjections(key) {
  const next = new Set(shown_interjections.value);
  next.has(key) ? next.delete(key) : next.add(key);
  shown_interjections.value = next;
}
/** The overview unfolds a task in place: what was asked, who did what, and what came of it. */
const opened_tasks = ref(new Set());
function toggle_task(key) {
  const next = new Set(opened_tasks.value);
  next.has(key) ? next.delete(key) : next.add(key);
  opened_tasks.value = next;
}
// An unfolded task lists this many steps; the rest are on the timeline.
const TASK_STEPS_SHOWN = 12;
/** A step's second line: why it failed, else what it was asked when that differs from the task itself. */
const step_note = (task, step) => step.state === "failed" ? step.reason : step.ask && step.ask !== task.task ? step.ask : "";
/** A task opens on the timeline at the execution that started it. */
const open_task = (task) => focus_row({ key: task.key });

// The run as it really is; its bounds are what a replay plays through.
const base_rows = computed(() => shown.value && !overview.value ? timeline_rows(shown.value, now.value) : []);
const base_live = computed(() => base_rows.value.some((row) => row.item.state === "running"));
// The latest task is the last one; a replay plays it, not the whole window.
const latest_keys = computed(() => segments.value.at(-1)?.keys || new Set());
const base_digest = computed(() => task_digest(base_rows.value, latest_keys.value, now.value));
const bounds = computed(() => {
  const { start, end } = base_digest.value;
  return start ? { start, end, duration: Math.max(0, end - start) } : { start: 0, end: 0, duration: 0 };
});
// A replay draws the run as it stood at the playback position, which stands in for now; live work is never replayed.
const replaying = computed(() => replay.position !== null && !base_live.value);
const view_time = computed(() => replaying.value ? bounds.value.start + replay.position : now.value);
const all_rows = computed(() => replaying.value
  ? timeline_rows(snapshot_at(shown.value, view_time.value, note_texts.value), view_time.value) : base_rows.value);
const rows = computed(() => all_rows.value.filter((row) => !row.ancestors.some((key) => collapsed.value.has(key))));
// A different set of rows on show is watched afresh for the phases it needs.
watch(() => rows.value.map((row) => row.key).join(), () => nextTick(observe_rows), { flush: "post" });
const live_in_view = computed(() => all_rows.value.some((row) => row.item.state === "running"));
const axis = computed(() => timeline_axis(all_rows.value, live_in_view.value));
/** Zoom: the share of the axis in view, from Ctrl/⌘ + wheel around the pointer; middle-button drag, Shift + wheel, a
 *  sideways swipe or dragging the axis pans it; a double click on the axis or lanes, or 重置, shows it whole again. */
const WHOLE = { from: 0, span: 1 };
const zoom = ref(WHOLE);
const zoomed = computed(() => zoom.value.span < 1);
watch(room_id, () => { zoom.value = WHOLE; });
const shown_axis = computed(() => view_axis(axis.value, zoom.value));
const now_x = computed(() => {
  const x = live_in_view.value ? shown_axis.value.x(view_time.value) : null;
  return x === null || x < 0 || x > 1 ? null : x;
});
const auto_speed = computed(() => Math.max(1, bounds.value.duration / REPLAY_TARGET_MS));
const speed_items = computed(() => [{ label: t('自动 · {value1}×', { value1: Math.round(auto_speed.value) }), value: 0 }, ...REPLAY_SPEEDS.map((speed) => ({ label: `${speed}×`, value: speed }))]);
const replay_speed = computed(() => replay.speed || auto_speed.value);
const can_replay = computed(() => !overview.value && !base_live.value && bounds.value.duration > 0);

/** One clock for live growth and replay: a replay every frame (at most ten times a second with many rows), live work
 *  every LIVE_CLOCK_MS; a hidden page skips the frames (the browser pauses them). */
function step(timestamp) {
  const elapsed = last_frame ? Math.min(timestamp - last_frame, 250) : 0;
  last_frame = timestamp;
  const due = timestamp - last_paint >= (running.value ? LIVE_CLOCK_MS : all_rows.value.length <= SMOOTH_ROWS ? 0 : CLOCK_MS);
  if (replay.playing) {
    play_position += elapsed * replay_speed.value;
    if (play_position >= bounds.value.duration) Object.assign(replay, { position: null, playing: false });
    else if (due) replay.position = play_position;
  }
  if (running.value && due) now.value = Date.now();
  if (due) last_paint = timestamp;
  frame = running.value || replay.playing ? requestAnimationFrame(step) : 0;
  if (!frame) last_frame = 0;
}
watch([running, () => replay.playing], () => { if (!frame && (running.value || replay.playing)) frame = requestAnimationFrame(step); }, { immediate: true });

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
/** The share page's replay button: start the replay, or end it and show the room as it finished (user 2026-11-22). */
function toggle_replay() {
  if (replaying.value) close_player();
  else { show_player.value = true; play(); }
}
// A share page's 执行 tab replays from the start each time it is opened (the tab mounts this anew).
watch(can_replay, (ready) => {
  // Not held back for "reduce motion": Windows reports it whenever its animations are off, and the replay is the content
  // a reader opened the tab for (it was left still on such computers before, user 2026-11-22).
  if (!ready || !view.value.share) return;
  show_player.value = true;
  play();
}, { immediate: true });
// Another room starts from its real, final state.
watch(room_id, close_player);

/** Rows that appear while watching (a new execution starting, or one a replay reaches) slide in; the first drawing does not. */
const entering = ref(new Set());
let known_rows = null;
watch(() => rows.value.map((row) => row.key).join(), () => {
  const keys = rows.value.map((row) => row.key);
  if (!known_rows) { known_rows = new Set(keys); return; }
  const added = keys.filter((key) => !known_rows.has(key));
  added.forEach((key) => known_rows.add(key));
  if (!added.length) return;
  entering.value = new Set([...entering.value, ...added]);
  setTimeout(() => { entering.value = new Set([...entering.value].filter((key) => !added.includes(key))); }, ENTER_MS);
});
// A replay from its start draws its rows in again; another room or view is a first drawing.
watch([room_id, view_mode], () => { known_rows = null; opened.value = ""; });
watch(() => replay.position === 0, (at_start) => { if (at_start) known_rows = new Set(); });

const lines = computed(() => compact.value ? new Map() : handoff_lines(rows.value, shown_axis.value));
const ticks = computed(() => axis_ticks(axis.value,
  Math.min(MAX_TICKS, Math.max(MIN_TICKS, Math.round((axis_width.value || TICK_SPACING_PX * 6) / (compact.value ? COMPACT_TICK_SPACING_PX : TICK_SPACING_PX)))), zoom.value)
  .map((tick) => ({ ...tick, x: (tick.x - zoom.value.from) / zoom.value.span })));
// Folded idle bands say how long they were on the axis; a label needs this many pixels clear of the next one and of a
// tick, and a tick this many before the axis ends, or the texts run into each other.
const AXIS_LABEL_CLEARANCE_PX = 56;
const AXIS_END_CLEARANCE_PX = 44;
/** Fold labels kept where they fit, left to right; a band without a label still shows. */
const shown_folds = computed(() => {
  const clearance = AXIS_LABEL_CLEARANCE_PX / (axis_width.value || 800);
  const kept = [];
  for (const fold of shown_axis.value.folds) {
    const middle = fold.from + fold.width / 2;
    if (middle < 0 || middle > 1) continue;
    if (!kept.length || middle - kept.at(-1).middle >= clearance) kept.push({ ...fold, middle });
  }
  return kept;
});
/** Ticks that clear the fold labels and the axis's right end. */
const shown_ticks = computed(() => {
  const clearance = AXIS_LABEL_CLEARANCE_PX / (axis_width.value || 800);
  const end = 1 - AXIS_END_CLEARANCE_PX / (axis_width.value || 800);
  return ticks.value.filter((tick) => tick.x <= end && !shown_folds.value.some((fold) => Math.abs(tick.x - fold.middle) < clearance));
});
// Data read before the page was hidden or went offline may be old, so possible stalls are judged only up to that read.
const status_time = computed(() => replaying.value ? view_time.value : Math.min(view_time.value, read_at.value));
const digest = computed(() => task_digest(all_rows.value, latest_keys.value, status_time.value));
const parents = computed(() => all_rows.value.filter((row) => row.has_children).map((row) => row.key));
// The real-time view opens the same detail card on any execution read, so it has rows for all of them.
const realtime_rows = computed(() => view_mode.value === "realtime" && timeline.value ? timeline_rows(timeline.value, now.value) : []);
const opened_row = computed(() => (view_mode.value === "realtime" ? realtime_rows.value : all_rows.value).find((row) => row.key === opened.value));
// One detail card for every row, so moving from row to row moves and refills it instead of drawing a new one; it shows
// only while its row is on the timeline (not folded away, not the overview).
const detail_row = computed(() => {
  const row = opened_row.value;
  if (row && view_mode.value === "realtime") return row;
  return row && !overview.value && !row.ancestors.some((key) => collapsed.value.has(key)) ? row : null;
});
const detail_element = ref(null);
const opened_log = computed(() => opened_row.value ? execution_log(opened_row.value, note_texts.value.get(opened_row.value.item.id)) : []);
const name = (member) => bridge.display_name(member);

/** The sentence at the top: for live work, how the running execution is doing; for a finished round, what its time
 *  came down to. Each part carries a tone, so a stall or a failure stands out within the line. */
const headline = computed(() => {
  // The real-time view says its span, peak and idle itself.
  if (view_mode.value === "realtime") return [];
  if (overview.value) {
    return [{ text: t('{value1} 个任务 · {value2} 次执行', { value1: tasks.value.length, value2: timeline.value?.executions.length || 0 }) }, { text: t('点开任务看要求、过程与结果') }];
  }
  const { running: live, members, wait, failed, stalled, total, keys } = digest.value;
  const parts = [];
  // On a phone the running and failed work has its own cards above the rows, so the sentence keeps only the alerts:
  // the latest task's time totals said nothing a phone needs (2026-11-11).
  if (!compact.value && live.length) {
    const row = live.find((item) => keys.has(item.key)) || live[0];
    const state = status(row);
    parts.push({ text: t('{value1} 已运行 {value2}', { value1: name(row.item.member), value2: format_duration(status_time.value - row.start) }) }, { text: state.text, tone: state.tone });
    if (live.length > 1) parts.push({ text: t('另 {value1} 个进行中', { value1: live.length - 1 }) });
  } else if (!compact.value) {
    parts.push({ text: t('最近一次任务{value1} {value2}', { value1: live.length ? t('已进行') : t('用时'), value2: format_duration(total) }) });
    if (members.length > 1) parts.push({ text: members.slice(0, 2).map((part) => `${name(part.member)} ${format_duration(part.ms)}`).join("、") });
  }
  if (wait >= WAIT_WARN_MS || (!live.length && wait >= 60_000)) parts.push({ text: t('等待 {value1}', { value1: format_duration(wait) }), tone: wait >= WAIT_WARN_MS ? "warn" : "" });
  if (stalled && !compact.value && !(live.length === 1 && stalled === 1)) parts.push({ text: t('可能卡住 {value1}', { value1: stalled }), tone: "warn" });
  if (failed) parts.push({ text: t('这 {value1} 次里失败 {value2} 次', { value1: all_rows.value.length, value2: failed }), tone: "failed" });
  return parts;
});

/**
 * One card, one way in per device: with a mouse, pointing at a name, a bar piece or a note tick shows that execution's
 * detail under it (the user's wish: hover instead of click on a PC), and it stays while the pointer moves into it, so its
 * links and log can be used; on a touch screen or a phone a tap opens it and the same tap closes it. The piece pointed
 * at (when there is one) is at its top. Its notes are read as it opens and again as more arrive.
 */
const can_hover = typeof window !== "undefined" && window.matchMedia?.("(hover: hover) and (pointer: fine)").matches === true;
const hovering = () => can_hover && !compact.value;
// Leaving a piece closes the card after this long, time enough to move the pointer into the card.
const HOVER_CLOSE_MS = 200;
// Pointing opens the card after this long, so a pointer passing over the rows does not flash it; once a card is open,
// pointing elsewhere switches it at once, as tooltips do, so the rows can be scanned (2026-11-21).
const HOVER_OPEN_MS = 120;
/**
 * The card follows the pointer from row to row, yet one on its way into the card must not lose it to the rows it
 * crosses (2026-11-21: tell scanning on from going in to read or copy). Resting on one thing for DWELL_MS means the
 * card is wanted: from then on, pointing at another row switches only after AIM_WAIT_MS, time enough to reach the card,
 * and reaching it keeps it. Until then, as while running down the names, pointing elsewhere switches at once. While text
 * is being selected or stays selected in the card, it is held: it neither switches nor closes, until a click elsewhere.
 */
const DWELL_MS = 300;
const AIM_WAIT_MS = 180;
let hover_timer = 0;
let shown_at = 0;
/** Text being selected (a button held) or selected inside the card: the user is reading or copying it. */
function card_held(event) {
  if (event?.buttons) return true;
  const selection = window.getSelection?.();
  return Boolean(selection && !selection.isCollapsed && detail_element.value?.contains(selection.anchorNode));
}
function hover_open(row, event, piece = null) {
  if (!hovering()) return;
  if (opened.value && card_held(event)) return;
  clearTimeout(hover_timer);
  if (opened.value === row.key && (selected.value?.id || "") === (piece ? piece_id(row, piece) : "")) return;
  const target = event.currentTarget;
  const show = () => show_detail(row, target, piece);
  if (!opened.value) hover_timer = setTimeout(show, HOVER_OPEN_MS);
  else if (performance.now() - shown_at >= DWELL_MS) hover_timer = setTimeout(show, AIM_WAIT_MS);
  else show();
}
function hover_leave(event) {
  if (!hovering() || card_held(event)) return;
  clearTimeout(hover_timer);
  hover_timer = setTimeout(() => { opened.value = ""; }, HOVER_CLOSE_MS);
}
function hover_keep() { clearTimeout(hover_timer); }
/** The real-time view names an execution by its row key; the card needs its row. */
function realtime_row(key, then) { const row = realtime_rows.value.find((item) => item.key === key); if (row) then(row); }
onBeforeUnmount(() => clearTimeout(hover_timer));
function open_row(row, event, piece = null) {
  // The tap that ends a pinch or a pan opens nothing.
  if (gesture.moved()) return;
  const id = piece ? piece_id(row, piece) : "";
  if (hovering()) { clearTimeout(hover_timer); if (opened.value !== row.key || (selected.value?.id || "") !== id) show_detail(row, event.currentTarget, piece); return; }
  if (opened.value === row.key && (selected.value?.id || "") === id) { opened.value = ""; return; }
  show_detail(row, event.currentTarget, piece);
}
// The card keeps this far inside the window, and is never cut shorter than this to stay level with what was pointed at.
const DETAIL_MARGIN_PX = 8;
const DETAIL_MIN_HEIGHT_PX = 320;
function show_detail(row, target, piece) {
  if (row.item.segments_pending) want_phases([row.item.id]);
  const id = piece ? piece_id(row, piece) : "";
  opened.value = row.key;
  shown_at = performance.now();
  selected.value = piece ? { id, piece, related: piece.note ? { notes: [piece.note], earlier: false } : notes_between(row.notes, piece.start, piece.end) } : null;
  note_texts_for(row);
  if (compact.value) return;
  // Anchored within the card (it scrolls with the page, so the anchor stays put) and never over the name column, so the
  // pointer can run down the names from one execution to the next (2026-11-21): beside a name, level with it, or under
  // a bar piece.
  const box = target.getBoundingClientRect();
  const card = wf_element.value.getBoundingClientRect();
  const names_end = (wf_element.value.querySelector(".wf-label")?.getBoundingClientRect().right ?? card.left) - card.left + 4;
  const width = Math.min(DETAIL_WIDTH_PX, card.width - names_end - 8);
  const beside = target.classList.contains("wf-names");
  // It follows the pointer: its top level with the name (or just under the piece), as tall as the window leaves below,
  // scrolling within; only where too little is left does it move up.
  const top = beside ? box.top : box.bottom + 4;
  detail_anchor.value = { width, top: top - card.top, left: Math.max(names_end, Math.min(box.left - card.left, card.width - width - 8)),
    max_height: Math.max(DETAIL_MIN_HEIGHT_PX, window.innerHeight - DETAIL_MARGIN_PX - top) };
  nextTick(() => keep_in_window(box, beside));
}
/** Once drawn, a card that runs past the window's bottom moves up, never above the window's top, and beside a name never
 *  so far that the name is no longer level with it. */
function keep_in_window(box, beside) {
  const element = detail_element.value;
  if (!element || !detail_anchor.value) return;
  const rect = element.getBoundingClientRect();
  const overflow = rect.bottom - (window.innerHeight - DETAIL_MARGIN_PX);
  const room = Math.max(0, rect.top - DETAIL_MARGIN_PX);
  const lift = Math.min(overflow, room, beside ? rect.bottom - box.bottom : room);
  if (lift > 0) detail_anchor.value = { ...detail_anchor.value, top: detail_anchor.value.top - lift };
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
/** On a phone, what needs a look sits above the rows: running work in the whole room (oldest first), then the latest
 *  task's failures (latest first); an earlier failure is history, not something to act on now. */
const attention = computed(() => compact.value ? [
  ...live_rows.value,
  ...all_rows.value.filter((row) => row.item.state === "failed" && digest.value.keys.has(row.key)).sort((a, b) => b.end - a.end),
] : []);
const card_status = (row) => row.item.state === "running" ? live_status(row) : status(row);
/** A card opens its execution's row on the timeline, unfolded and scrolled into view, reaching back for it if need be. */
function focus_row(card) {
  view_mode.value = "timeline";
  if (!shown.value.executions.some((item) => `${item.source}:${item.id}` === card.key)) window_count.value = timeline.value.executions.length;
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

function toggle(key) {
  const next = new Set(collapsed.value);
  next.has(key) ? next.delete(key) : next.add(key);
  collapsed.value = next;
}

/** A piece's left and right edge as shares of the track, on the one axis every row shares (phones included). */
function span_of(row, start, end) {
  return [shown_axis.value.x(start), shown_axis.value.x(end)];
}
/** A bar piece's position. Segments leave a 1 px gap after them, so neighbouring phases read apart. */
function place(row, start, end, gap = false) {
  const [from, to] = span_of(row, start, end);
  const width = Math.max(0, to - from) * 100;
  return { left: `${from * 100}%`, width: gap ? `max(2px, calc(${width}% - 1px))` : `${width}%` };
}
const queue_piece = (row) => ({ label: t('排队'), start: row.queue[0], end: row.queue[1], text: t('从请求发出到投递给成员') });
const wake_piece = (row) => ({ label: row.wake_approx ? t('唤醒（约）') : t('唤醒'), start: row.wake[0], end: row.wake[1], text: t('从投递到成员开始工作') });
const segment_piece = (segment) => ({ label: `${PHASE_LABELS[segment.phase]}${segment.tool ? ` · ${segment.tool}` : ""}`, start: segment.start, end: segment.end, live: segment.live });
const note_piece = (note) => ({ note, start: note.at, end: note.at });
/** Each member keeps one hue on every mark that is theirs, on the timeline and the task overview alike, so a glance says who
 *  worked when. Hues go by first appearance in the room. */
const MEMBER_TONES = 8;
const member_tone = computed(() => {
  const tones = new Map();
  for (const item of [...(timeline.value?.executions || [])].sort((a, b) => requested_at(a) - requested_at(b))) {
    if (!tones.has(item.member)) tones.set(item.member, tones.size % MEMBER_TONES + 1);
  }
  return tones;
});

/** The marks after a name: only what tells rows apart. */
function role_marks(row) {
  if (is_user_row(row)) return row.item.aside ? [t('插话')] : [];
  return row.item.role === "host" ? [t('主持')] : [];
}
const role_label = (row) => is_user_row(row) ? (row.item.aside ? t('用户 · 插话') : t('用户')) : row.item.role === "host" ? t('协作 · 主持') : t('协作');
const status = (row) => row_status(row, status_time.value);

function row_label(row) {
  const { wait } = row_breakdown(row);
  const parts = [name(row.item.member), role_label(row), STATE_LABELS[row.item.state], t('用时 {value1}', { value1: format_duration(row.end - row.start) }), t('等待 {value1}', { value1: format_duration(wait) })];
  if (!has_phase_detail(row) && row.work) parts.push(t('无阶段明细'));
  if (row.notes.length) parts.push(t('{value1} 段过程说明', { value1: row.notes.length }));
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

const clock = (ms) => new Date(ms).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const short_clock = (ms) => new Date(ms).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hour12: false });
const tick_label = (tick) => new Date(tick.at).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", ...(tick.seconds ? { second: "2-digit" } : {}), hour12: false });

const piece_id = (row, piece) => `${row.key}:${piece.note ? "note" : piece.label}:${piece.start}`;
const work_piece = (row) => ({ label: is_user_row(row) ? (row.work[1] > row.work[0] ? t('阅读与思考') : t('发出消息')) : has_phase_detail(row) ? t('执行') : t('执行 · 无阶段明细'), start: row.work[0], end: row.work[1], live: row.item.state === "running" });

const selected_title = computed(() => {
  const piece = selected.value?.piece;
  if (!piece) return "";
  if (piece.note) return t('过程说明 · {value1}', { value1: clock(piece.note.at) });
  return `${piece.label} · ${format_duration(piece.end - piece.start)}${piece.live ? t(' · 进行中') : ""}`;
});
/** The opened execution's time, part by part, for the detail's distribution bar and its legend: waiting, each phase, and
 *  the work no phase report covers. Shares are of the whole execution. */
const opened_parts = computed(() => {
  const row = opened_row.value;
  if (!row || is_user_row(row)) return [];
  const { wait, work, phases } = row_breakdown(row);
  const total = Math.max(1, row.end - row.start);
  const reported = phases.reduce((sum, part) => sum + part.ms, 0);
  const parts = [
    ...(wait > 0 ? [{ key: "wait", kind: "wait", label: t('等待'), ms: wait }] : []),
    ...phases.map((part) => ({ key: part.phase, kind: PHASE_KINDS[part.phase], label: PHASE_LABELS[part.phase], ms: part.ms })),
    ...(work - reported > 0 ? [{ key: "other", kind: "other", label: has_phase_detail(row) ? t('未上报') : t('执行'), ms: work - reported }] : []),
  ];
  return parts.map((part) => ({ ...part, share: part.ms / total }));
});
const percent = (share) => share >= 0.995 ? "100%" : share < 0.01 ? "<1%" : `${Math.round(share * 100)}%`;
const opened_task_open = ref(false);
watch(opened, () => { opened_task_open.value = false; if (detail_element.value) detail_element.value.scrollTop = 0; });
const selected_notes = computed(() => {
  if (!selected.value || !opened_row.value) return [];
  const texts = note_texts.value.get(opened_row.value.item.id);
  return selected.value.related.notes.map((note) => ({ at: note.at, text: texts?.[note.index] ?? (texts ? t('（未能读取）') : t('读取中…')) }));
});
</script>

<template>
  <section ref="section_element" class="merged-section execution-timeline" :aria-label="t('执行时间线')">
    <div v-if="!compact" class="page-heading"><div><h2>{{ t('执行时间线') }}</h2><p>{{ t('每次执行的时间花在哪、谁在等谁；点名字看详情。') }}</p></div></div>
    <div v-if="reading && !timeline" class="grid gap-4 py-4" role="status" :aria-label="t('正在读取执行时间线')"><div v-for="row in 6" :key="row" class="flex items-center gap-6"><USkeleton class="h-5 w-24 shrink-0" /><USkeleton class="h-6" :class="row % 2 ? 'w-2/3' : 'w-1/3'" /></div></div>
    <p v-else-if="error" role="alert" class="fine-print wf-error">{{ error }}<UButton :label="t('重试')" color="neutral" variant="link" size="xs" :loading="reading" @click="load(true)" /></p>
    <p v-if="timeline && !timeline.executions.length" class="fine-print">{{ t('还没有执行记录。') }}</p>
    <div v-if="timeline?.executions.length" ref="wf_element" class="wf" :class="{ 'is-compact': compact }"
      :style="{ '--wf-depth-px': `${compact ? COMPACT_DEPTH_PX : DEPTH_PX}px` }">
      <header class="wf-head">
        <div class="wf-head-line">
          <span class="wf-modes" role="tablist" :aria-label="t('查看方式')">
            <button v-for="mode in VIEW_MODES" :key="mode.value" type="button" role="tab" :aria-selected="view_mode === mode.value"
              :class="{ 'is-active': view_mode === mode.value }" @click="view_mode = mode.value">{{ mode.label }}</button>
          </span>
          <button v-if="compact && zoomed" type="button" class="wf-text-button" @click="zoom = WHOLE">{{ t('还原 {value1}×', { value1: (1 / zoom.span).toFixed(1) }) }}</button>
          <span v-if="replaying" class="wf-state is-replay">{{ t('回放中 · {value1}', { value1: clock(view_time) }) }}</span>
          <span v-else-if="!overview" class="wf-state" :class="{ 'is-live': digest.running.length }">{{ digest.running.length ? t('{value1} 个进行中', { value1: digest.running.length }) : t('均已结束') }}</span>
          <!-- On a share page the replay is the quickest way to see several AIs at work, so it starts from the top. -->
          <button v-if="view.share && (can_replay || replaying)" type="button" class="wf-share-replay" :class="{ 'is-playing': replaying }" @click="toggle_replay">
            <UIcon :name="replaying ? 'i-lucide-square' : 'i-lucide-play'" />{{ replaying ? t('结束回放') : t('回放协作过程') }}</button>
        </div>
        <p v-if="headline.length" class="wf-headline"><span v-for="(part, index) in headline" :key="index" :class="part.tone && `is-${part.tone}`">{{ part.text }}</span></p>
      </header>

      <section v-if="attention.length" class="wf-now" :aria-label="t('需要关注')">
        <button v-for="row in attention" :key="row.key" type="button" class="wf-now-card"
          :class="[`is-${row.item.state}`, { 'is-stalled': row.item.state === 'running' && card_status(row).tone === 'warn' }]" @click="focus_row(row)">
          <span class="wf-now-line"><i v-if="row.item.state === 'running'" class="wf-spinner" aria-hidden="true"></i>
            <UAvatar :src="bridge.identities[row.item.member]?.icon" :text="bridge.identities[row.item.member]?.initials" :alt="row.item.member" size="2xs" class="channel-avatar wf-avatar" :class="bridge.identities[row.item.member]?.style" />
            <strong>{{ name(row.item.member) }}</strong><em v-for="mark in role_marks(row)" :key="mark" class="wf-pill is-role">{{ mark }}</em>
            <span class="wf-now-time">{{ row.item.state === 'running' ? t('已运行 {value1}', { value1: format_duration(live_time - row.start) }) : t('{value1} 前失败', { value1: format_duration(Math.max(0, status_time - row.end)) }) }}</span></span>
          <span class="wf-now-status wf-status" :class="`is-${card_status(row).tone}`">{{ card_status(row).text }}</span>
          <span v-if="row.item.state === 'running' && row.item.last_note" class="wf-now-note">{{ row.item.last_note }}</span>
        </button>
      </section>

      <p v-if="earlier_count || earlier" class="wf-earlier">{{ t('显示最近 {value1} 次执行', { value1: shown_runs }) }}<button type="button" class="wf-text-button" :disabled="loading_earlier" @click="show_earlier">{{ earlier ? t('显示更早的执行') : t('显示更早的 {value1} 次', { value1: Math.min(WINDOW_STEP, earlier_count) }) }}</button><button v-if="!overview" type="button" class="wf-text-button" :disabled="loading_earlier" @click="show_all">{{ t('显示全部') }}</button></p>
      <RealtimeView v-if="view_mode === 'realtime'" :segments="segments" :tones="member_tone" :name="name" @open="(key) => focus_row({ key })"
        @hover="(key, event) => realtime_row(key, (row) => hover_open(row, event))" @leave="hover_leave" @pick="(key, event) => realtime_row(key, (row) => open_row(row, event))" />
      <ol v-if="view_mode === 'tasks'" class="wf-runs" :aria-label="t('任务清单')">
        <li v-for="task in tasks" :key="task.key" :class="{ 'is-open': opened_tasks.has(task.key) }">
          <button type="button" class="wf-run" :aria-expanded="opened_tasks.has(task.key)" @click="toggle_task(task.key)">
            <span class="wf-run-line"><UIcon name="i-lucide-chevron-right" class="wf-run-caret" /><time>{{ when(task.start) }}</time><strong>{{ task_title(task.task) }}</strong>
              <span class="wf-run-meta">{{ t('{value1} 次 · 用时 {value2}', { value1: task.count, value2: format_duration(task.end - task.start) }) }}</span>
              <em v-if="task.running" class="wf-pill is-live">{{ t('进行中') }}</em><em v-else-if="task.failed" class="wf-pill is-failed">{{ t('有失败') }}</em></span>
            <span v-if="task.interjections.length || partial(task)" class="wf-run-note">
              <template v-if="task.interjections.length">{{ t('插话 {value1} 条', { value1: task.interjections.length }) }}</template><template v-if="task.interjections.length && partial(task)"> · </template><template v-if="partial(task)">{{ t('更早部分未加载') }}</template></span>
          </button>
          <div v-if="opened_tasks.has(task.key)" class="wf-run-body">
            <section>
              <h4>{{ t('要求') }}</h4>
              <p class="wf-run-text">{{ task_title(task.task) }}</p>
              <ol v-if="task.interjections.length" class="wf-segment-asides">
                <li v-for="aside in task.interjections" :key="aside.key"><time>{{ short_clock(aside.at) }}</time><span class="wf-run-aside">{{ aside.task }}</span></li>
              </ol>
            </section>
            <section>
              <h4>{{ t('过程') }}<small>{{ t('{value1} 次执行', { value1: task.steps.length }) }}</small></h4>
              <ol class="wf-run-steps">
                <li v-for="step in task.steps.slice(0, TASK_STEPS_SHOWN)" :key="step.key">
                  <span class="wf-run-step-line"><i class="wf-run-dot" :data-tone="member_tone.get(step.member)"></i><strong>{{ name(step.member) }}</strong>
                    <em v-if="step.role === 'host'" class="wf-pill is-role">{{ t('主持') }}</em>
                    <span class="wf-run-step-state" :class="`is-${step.state}`">{{ STATE_LABELS[step.state] }}</span>
                    <span class="wf-run-meta">{{ format_duration(step.ms) }}</span></span>
                  <span v-if="step_note(task, step)" class="wf-run-step-note" :class="{ 'is-failed': step.state === 'failed' }">{{ step_note(task, step) }}</span>
                </li>
              </ol>
              <p v-if="task.steps.length > TASK_STEPS_SHOWN" class="wf-run-more">{{ t('另 {value1} 次执行，在执行明细中查看', { value1: task.steps.length - TASK_STEPS_SHOWN }) }}</p>
            </section>
            <section>
              <h4>{{ t('结果') }}<small v-if="task.changes">{{ t('改动 {value1} 个文件', { value1: task.changes }) }}</small></h4>
              <p v-if="task.outcome" class="wf-run-text"><strong>{{ name(task.outcome.member) }}：</strong>{{ task.outcome.text }}</p>
              <p v-else class="wf-run-text is-muted">{{ task.running ? t('仍在进行，还没有结果') : t('没有记录到回答') }}</p>
            </section>
            <button type="button" class="wf-text-button wf-run-jump" @click="open_task(task)"><UIcon name="i-lucide-arrow-right" />{{ t('在执行明细中查看') }}</button>
          </div>
        </li>
      </ol>

      <div v-else-if="!overview" class="wf-grid" :class="{ 'is-zoomed': zoomed, 'is-panning': pan }" role="list"
        @wheel="on_wheel" @mousedown="stop_autoscroll" @pointerdown="on_pan_start" @pointermove="on_pan_move" @pointerup="on_pan_end" @pointercancel="on_pan_end" @dblclick="reset_on_dblclick">
        <div v-if="!compact" class="wf-axis-label" :title="t('Ctrl + 滚轮缩放；放大后按住中键或拖动时间轴平移，双击时间线还原')">
            <span class="wf-axis-count">{{ t('执行 · {value1}/{value2}', { value1: rows.length, value2: all_rows.length }) }}</span>
            <span v-if="zoomed" class="wf-zoom" :title="t('当前放大倍数')">{{ (1 / zoom.span).toFixed(1) }}×<button type="button" class="wf-zoom-reset"
              :title="t('{value1}（双击时间线也可还原）', { value1: base_live ? t('重置跟随') : t('重置') })" :aria-label="base_live ? t('重置跟随') : t('重置')" @click="zoom = WHOLE">
              <UIcon name="i-lucide-locate-fixed" /></button></span>
            <span v-if="parents.length" class="wf-branch">
              <button type="button" class="wf-text-button" @click="collapsed = new Set()">{{ t('展开') }}</button>
              <button type="button" class="wf-text-button" @click="collapsed = new Set(parents)">{{ t('收起') }}</button>
            </span>
          </div>
          <div ref="axis_element" class="wf-axis" aria-hidden="true">
            <span v-for="tick in shown_ticks" :key="tick.at" class="wf-tick" :style="{ left: `${tick.x * 100}%` }">{{ tick_label(tick) }}</span>
            <span v-for="fold in shown_folds" :key="`fold-${fold.start}`" class="wf-fold-label"
              :style="{ left: `${(fold.from + fold.width / 2) * 100}%` }" :title="t('{value1} – {value2} 没有执行，已折叠', { value1: clock(fold.start), value2: clock(fold.end) })">⋯ {{ format_duration(fold.end - fold.start) }}</span>
            <span v-if="now_x !== null" class="wf-cursor-head" :style="{ left: `${now_x * 100}%` }"></span>
          </div>
          <span v-if="!compact" class="wf-axis-end">{{ t('用时') }}</span>
        <template v-for="row in rows" :key="row.key">
        <div v-for="segment in (segment_heads.has(row.key) ? [segment_heads.get(row.key)] : [])" :key="segment.key" class="wf-segment">
          <span class="wf-segment-line"><time>{{ when(segment_start(segment)) }}</time><strong>{{ task_title(segment.opener.task) }}</strong>
            <button v-if="segment.interjections.length" type="button" class="wf-text-button" :aria-expanded="shown_interjections.has(segment.key)"
              @click="toggle_interjections(segment.key)">{{ t('插话 {value1} 条', { value1: segment.interjections.length }) }}</button>
            <small v-if="partial(segment)">{{ t('更早部分未加载') }}</small></span>
          <span v-if="task_note(segment.opener.task, segment.opener.result)" class="wf-segment-note">{{ task_note(segment.opener.task, segment.opener.result) }}</span>
          <ol v-if="shown_interjections.has(segment.key)" class="wf-segment-asides">
            <li v-for="aside in segment.interjections" :key="aside.key"><time>{{ short_clock(aside.at) }}</time>{{ aside.task }}</li>
          </ol>
        </div>
        <div role="listitem" class="wf-row"
          :class="[`is-${row.item.state}`, { 'is-open': opened === row.key, 'is-stalled': row.item.state === 'running' && status(row).tone === 'warn', 'is-entering': entering.has(row.key), 'is-instant': is_user_row(row) && row.end <= row.start }]">
          <div class="wf-label" :data-row="row.key" :style="{ '--depth': row.depth }">
            <span v-if="row.depth" class="wf-guides" aria-hidden="true"></span>
            <button v-if="row.has_children" type="button" class="wf-toggle" :class="{ 'is-open': !collapsed.has(row.key) }" :aria-expanded="!collapsed.has(row.key)"
              :aria-label="t('{value1} {value2} 派出的执行', { value1: collapsed.has(row.key) ? t('展开') : t('收起'), value2: name(row.item.member) })" @click="toggle(row.key)">
              <UIcon name="i-lucide-chevron-right" />
            </button>
            <span v-else class="wf-toggle-space"></span>
            <UAvatar :src="bridge.identities[row.item.member]?.icon" :text="bridge.identities[row.item.member]?.initials" :alt="row.item.member" size="2xs" class="channel-avatar wf-avatar" :class="bridge.identities[row.item.member]?.style" />
            <button type="button" class="wf-names" :aria-expanded="opened === row.key" @click="open_row(row, $event)" @mouseenter="hover_open(row, $event)" @mouseleave="hover_leave">
              <span class="wf-name-line"><i v-if="row.item.state === 'running'" class="wf-spinner" aria-hidden="true"></i><time v-if="compact" class="wf-clock">{{ short_clock(row.start) }}</time><strong>{{ name(row.item.member) }}</strong><em v-for="mark in role_marks(row)" :key="mark" class="wf-pill is-role">{{ mark }}</em><em v-if="interjected.has(row.key)" class="wf-pill is-aside">{{ t('插话') }}</em><em v-if="digest.slowest?.row === row.key" class="wf-pill is-slowest">{{ t('最慢') }}</em>
                <span v-if="compact" class="wf-name-end">{{ format_duration(row.end - row.start) }}<small v-if="row.item.state !== 'done'" :class="`is-${row.item.state}`">{{ STATE_LABELS[row.item.state] }}</small></span></span>
              <span v-if="!compact" class="wf-status" :class="`is-${status(row).tone}`">{{ status(row).text }}</span>
            </button>
          </div>
          <div class="wf-lane" :role="compact ? 'button' : 'img'" :tabindex="compact ? 0 : undefined" :aria-label="row_label(row)"
            @click="compact && open_row(row, $event)" @keydown.enter="compact && open_row(row, $event)"><div class="wf-track">
            <i v-for="tick in shown_ticks" :key="tick.at" class="wf-gridline" :style="{ left: `${tick.x * 100}%` }"></i>
            <i v-for="fold in shown_axis.folds" :key="fold.start" class="wf-fold" :style="{ left: `${fold.from * 100}%`, width: `${fold.width * 100}%` }"></i>
            <i class="wf-well"></i>
            <i v-for="(line, index) in lines.get(row.key) || []" :key="`link-${index}`" class="wf-link" :class="`is-${line.part}`"
              :data-tone="member_tone.get(line.member)" :style="{ left: `${line.x * 100}%` }"></i>
            <i v-if="now_x !== null" class="wf-cursor" :style="{ left: `${now_x * 100}%` }"></i>
            <i class="wf-bar is-queue" :style="place(row, ...row.queue)" @click="open_row(row, $event, queue_piece(row))" @mouseenter="hover_open(row, $event, queue_piece(row))" @mouseleave="hover_leave"></i>
            <i v-if="row.wake" class="wf-bar is-wake" :style="place(row, ...row.wake)" @click="open_row(row, $event, wake_piece(row))" @mouseenter="hover_open(row, $event, wake_piece(row))" @mouseleave="hover_leave"></i>
            <i v-if="row.work" class="wf-bar is-work" :class="{ 'has-detail': row.segments.length, 'is-user': is_user_row(row) }" :data-tone="row.segments.length ? undefined : member_tone.get(row.item.member)"
              :style="place(row, ...row.work)" @click="open_row(row, $event, work_piece(row))" @mouseenter="hover_open(row, $event, work_piece(row))" @mouseleave="hover_leave"></i>
            <template v-for="segment in row.segments" :key="segment.start + segment.phase">
              <i class="wf-bar wf-seg" :class="[`is-${PHASE_KINDS[segment.phase]}`, { 'is-live': segment.live }]" :data-tone="member_tone.get(row.item.member)"
                :style="place(row, segment.start, segment.seen, true)" @click="open_row(row, $event, segment_piece(segment))" @mouseenter="hover_open(row, $event, segment_piece(segment))" @mouseleave="hover_leave"></i>
              <i v-if="segment.end > segment.seen" class="wf-bar wf-seg is-tail" :class="`is-${PHASE_KINDS[segment.phase]}`" :data-tone="member_tone.get(row.item.member)"
                :style="place(row, segment.seen, segment.end)" @click="open_row(row, $event, segment_piece(segment))" @mouseenter="hover_open(row, $event, segment_piece(segment))" @mouseleave="hover_leave"></i>
            </template>
            <button v-for="note in row.notes" :key="`note-${note.index}`" type="button" class="wf-note" :style="{ left: `${span_of(row, note.at, note.at)[0] * 100}%` }"
              :aria-label="t('{value1} 的第 {value2} 段过程说明，{value3}', { value1: name(row.item.member), value2: note.index + 1, value3: clock(note.at) })"
              @click="open_row(row, $event, note_piece(note))" @mouseenter="hover_open(row, $event, note_piece(note))" @mouseleave="hover_leave"></button>
          </div></div>
          <span v-if="!compact" class="wf-end">{{ format_duration(row.end - row.start) }}<small v-if="row.item.state !== 'done'" :class="`is-${row.item.state}`">{{ STATE_LABELS[row.item.state] }}</small><small v-if="row.truncated">{{ t('明细已截断') }}</small></span>
          <span v-else-if="row.item.state === 'running' || row.item.state === 'failed'" class="wf-row-status wf-status" :class="`is-${status(row).tone}`">{{ status(row).text }}</span>
        </div>
        </template>
      </div>

      <Transition name="wf-pop">
        <div v-if="detail_row && (compact || detail_anchor)" ref="detail_element" class="wf-detail" role="dialog" @mouseenter="hover_keep" @mouseleave="hover_leave" :aria-label="is_user_row(detail_row) ? t('{value1} 的这条消息', { value1: name(detail_row.item.member) }) : t('{value1} 的这次执行', { value1: name(detail_row.item.member) })"
          :style="compact ? undefined : { top: `${detail_anchor.top}px`, left: `${detail_anchor.left}px`, width: `${detail_anchor.width}px`, maxHeight: `min(70vh, 600px, ${detail_anchor.max_height}px)` }">
          <header class="wf-detail-head">
            <UAvatar :src="bridge.identities[detail_row.item.member]?.icon" :text="bridge.identities[detail_row.item.member]?.initials" :alt="detail_row.item.member" size="sm" class="channel-avatar wf-avatar" :class="bridge.identities[detail_row.item.member]?.style" />
            <div class="wf-detail-title">
              <span class="wf-detail-name"><strong>{{ name(detail_row.item.member) }}</strong><em class="wf-pill wf-state-pill" :class="`is-${detail_row.item.state}`">{{ STATE_LABELS[detail_row.item.state] }}</em></span>
              <small>{{ t('{value1} · {value2} 起', { value1: role_label(detail_row), value2: clock(detail_row.start) }) }}<template v-if="detail_row.item.model || detail_row.item.effort"> · <span class="wf-detail-model" :title="[detail_row.item.model, detail_row.item.effort].filter(Boolean).join(' · ')">{{ [detail_row.item.model, detail_row.item.effort].filter(Boolean).join(' · ') }}</span></template></small>
            </div>
            <span class="wf-detail-total">{{ format_duration(detail_row.end - detail_row.start) }}</span>
            <button type="button" class="wf-card-close" :aria-label="t('关闭')" @click="opened = ''"><UIcon name="i-lucide-x" /></button></header>
          <section v-if="selected" class="wf-detail-piece">
            <strong>{{ selected_title }}</strong>
            <small>{{ clock(selected.piece.start) }}<template v-if="selected.piece.end > selected.piece.start"> – {{ selected.piece.live ? t('现在') : clock(selected.piece.end) }}</template><template v-if="selected.piece.text"> · {{ selected.piece.text }}</template></small>
            <template v-if="selected_notes.length">
              <small class="wf-detail-piece-label">{{ selected.related.earlier ? t('此前的过程说明') : t('这段时间的过程说明') }}</small>
              <ol><li v-for="note in selected_notes" :key="note.at + note.text"><time>{{ clock(note.at) }}</time>{{ note.text }}</li></ol>
            </template>
          </section>
          <p v-if="detail_row.item.state !== 'done'" class="wf-detail-status wf-status" :class="`is-${status(detail_row).tone}`">{{ status(detail_row).text }}</p>
          <section v-if="opened_parts.length" class="wf-detail-block" :aria-label="t('时间分布')">
            <span class="wf-dist" :data-tone="member_tone.get(detail_row.item.member)">
              <i v-for="part in opened_parts" :key="part.key" :class="`is-${part.kind}`" :style="{ flexGrow: part.ms }"></i></span>
            <ul class="wf-dist-key" :data-tone="member_tone.get(detail_row.item.member)">
              <li v-for="part in opened_parts" :key="part.key"><i class="wf-swatch" :class="`is-${part.kind}`" aria-hidden="true"></i>{{ part.label }}
                <b>{{ format_duration(part.ms) }}</b><small>{{ percent(part.share) }}</small></li>
            </ul>
          </section>
          <section v-if="detail_row.item.task" class="wf-detail-block">
            <h4>{{ t('任务') }}<button v-if="detail_row.item.task_id" type="button" class="wf-detail-link" @click="emit('detail', detail_row.item.task_id)">#{{ detail_row.item.task_id }}<UIcon name="i-lucide-arrow-up-right" /></button></h4>
            <p class="wf-detail-task" :class="{ 'is-open': opened_task_open }">{{ detail_row.item.task }}</p>
            <button v-if="detail_row.item.task.length > 80" type="button" class="wf-text-button wf-detail-more" @click="opened_task_open = !opened_task_open">{{ opened_task_open ? t('收起') : t('展开全文') }}</button>
          </section>
          <div v-if="detail_row.item.answer_id || detail_row.item.changes" class="wf-detail-actions">
            <button v-if="detail_row.item.answer_id" type="button" class="wf-detail-chip is-link" @click="emit('detail', detail_row.item.answer_id)"><UIcon name="i-lucide-message-square-text" />{{ t('查看回答 #{value1}', { value1: detail_row.item.answer_id }) }}</button>
            <span v-if="detail_row.item.changes" class="wf-detail-chip"><UIcon name="i-lucide-file-diff" />{{ t('改动 {value1} 个文件', { value1: detail_row.item.changes }) }}</span>
          </div>
          <section v-if="!is_user_row(detail_row)" class="wf-detail-block">
            <h4>{{ t('过程') }}<small v-if="opened_log.length">{{ t('{value1} 条', { value1: opened_log.length }) }}</small></h4>
            <ol v-if="opened_log.length" class="wf-log" :aria-label="t('过程')" :data-tone="member_tone.get(detail_row.item.member)">
              <li v-for="entry in opened_log" :key="`${entry.kind}-${entry.at}-${entry.phase || ''}`" :class="[`log-${entry.kind}`, entry.kind === 'phase' && `kind-${PHASE_KINDS[entry.phase]}`, { 'is-live': entry.live }]">
                <i class="wf-log-dot" aria-hidden="true"></i>
                <template v-if="entry.kind === 'phase'">
                  <span class="wf-log-phase"><b>{{ PHASE_LABELS[entry.phase] }}</b><span v-if="entry.tool" class="wf-log-tool">{{ entry.tool }}</span></span>
                  <span class="wf-log-dur">{{ entry.live ? t('进行中') : format_duration(entry.duration) }}</span>
                  <time>{{ clock(entry.at) }}</time>
                </template>
                <template v-else><p class="wf-log-note">{{ entry.text }}</p><time>{{ clock(entry.at) }}</time></template>
              </li>
            </ol>
            <p v-else class="fine-print">{{ t('这次执行没有阶段明细或过程说明。') }}</p>
          </section>
        </div>
      </Transition>
      <footer v-if="!overview" class="wf-foot">
        <span class="wf-key"><i class="wf-swatch is-queue"></i>{{ t('排队') }}<i class="wf-swatch is-wake"></i>{{ t('唤醒') }}<i class="wf-swatch is-model"></i>{{ t('模型') }}<i class="wf-swatch is-tool"></i>{{ t('工具') }}</span>
        <span v-if="member_tone.size > 1">{{ t('颜色区分成员，深浅区分模型与工具') }}</span>
        <span v-if="axis.folds.length && !compact"><i class="wf-swatch is-fold" aria-hidden="true"></i>{{ t('已折叠 {value1} 段超过 {value2} 分钟的空闲', { value1: axis.folds.length, value2: FOLD_GAP_MS / 60000 }) }}</span>
        <button v-if="can_replay && !show_player && !view.share" type="button" class="wf-text-button wf-replay-open" @click="show_player = true"><UIcon name="i-lucide-play" />{{ t('回放最近这次任务') }}</button>
      </footer>
      <div v-if="can_replay && show_player" class="wf-player">
        <button type="button" class="wf-player-button" :aria-label="replay.playing ? t('暂停回放') : t('回放最近这次任务')" @click="replay.playing ? pause() : play()">
          <UIcon :name="replay.playing ? 'i-lucide-pause' : 'i-lucide-play'" />
        </button>
        <button type="button" class="wf-player-button" :aria-label="t('从头回放')" :disabled="!replaying" @click="restart"><UIcon name="i-lucide-rotate-ccw" /></button>
        <USelect v-model="replay.speed" :items="speed_items" variant="none" :aria-label="t('回放速度')" class="wf-speed"
          :content="{ side: 'top', align: 'start', sideOffset: 4 }" :ui="{ content: 'channel-select-menu wf-speed-menu', trailing: 'static shrink-0 p-0', trailingIcon: 'wf-select-icon' }" />
        <input type="range" class="wf-scrub" min="0" :max="bounds.duration" step="100" :value="replaying ? replay.position : bounds.duration"
          :aria-label="t('回放位置')" @input="scrub" />
        <span class="wf-player-time">{{ format_duration(replaying ? replay.position : bounds.duration) }} / {{ format_duration(bounds.duration) }}</span>
        <button type="button" class="wf-player-button" :aria-label="t('关闭回放')" @click="close_player"><UIcon name="i-lucide-x" /></button>
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
  /* Member hues (#8162): no green, amber or red, so none reads as a status. Within cyan to rose the hues alone cannot
     be told apart under colour blindness, so neighbours alternate a darker and a lighter step; run through the dataviz
     palette validator in both themes (adjacent normal-vision ΔE ≥ 16, CVD ≥ 7.7 with names and hover as second cue). */
  --wf-h1: light-dark(oklch(0.52 0.12 300), oklch(0.54 0.125 300));
  --wf-h2: light-dark(oklch(0.68 0.12 245), oklch(0.655 0.125 245));
  --wf-h3: light-dark(oklch(0.52 0.12 330), oklch(0.54 0.125 330));
  --wf-h4: light-dark(oklch(0.68 0.12 215), oklch(0.655 0.125 215));
  --wf-h5: light-dark(oklch(0.52 0.12 270), oklch(0.54 0.125 270));
  --wf-h6: light-dark(oklch(0.68 0.12 355), oklch(0.655 0.125 355));
  --wf-h7: light-dark(oklch(0.52 0.12 245), oklch(0.54 0.125 245));
  --wf-h8: light-dark(oklch(0.68 0.12 300), oklch(0.655 0.125 300));
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
/* Timeline or tasks: a two-way switch. */
.wf-modes { display: inline-flex; gap: 2px; padding: 2px; border: 1px solid var(--wf-border); border-radius: 7px; background: var(--wf-well); }
.wf-modes button { height: 22px; padding: 0 10px; border: 0; border-radius: 5px; background: transparent; color: var(--wf-muted); font: inherit; font-size: 12px; cursor: pointer; }
.wf-modes button:hover { color: var(--wf-text); }
.wf-modes button.is-active { background: var(--wf-surface); color: var(--wf-text); font-weight: 600; box-shadow: 0 1px 2px rgb(0 0 0 / .2); }
.wf-modes button:focus-visible { outline: 2px solid var(--wf-accent); outline-offset: 1px; }
.wf-player :deep(.wf-speed:hover) { border-color: var(--wf-guide); }
.wf-player :deep(.wf-speed:focus-visible) { outline: 2px solid var(--wf-accent); outline-offset: 1px; }
:deep(.wf-select-icon) { width: 12px; height: 12px; color: var(--wf-muted); }
:global(.wf-speed-menu) { min-width: 120px !important; }

/* The timeline shows the latest executions; one line says how many and reaches further back. */
.wf-earlier { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; margin: 0; padding: 6px 16px; border-bottom: 1px solid var(--wf-border); color: var(--wf-muted); font-size: 12px; }
.wf-earlier .wf-text-button { color: var(--wf-accent); }
/* Tasks: one line each, the message that started it; a click unfolds what was asked, who did what, and what came of it. */
.wf-runs { margin: 0; padding: 4px 0; list-style: none; }
.wf-runs > li + li { border-top: 1px solid var(--wf-border); }
.wf-run { display: grid; gap: 4px; width: 100%; padding: 8px 16px; border: 0; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.wf-run:hover, .is-open > .wf-run { background: var(--wf-hover); }
.wf-run:focus-visible { outline: 2px solid var(--wf-accent); outline-offset: -2px; }
.wf-run-line { display: flex; align-items: baseline; gap: 10px; min-width: 0; }
.wf-run-caret { flex: none; align-self: center; width: 14px; height: 14px; color: var(--wf-muted); transition: transform .15s; }
.is-open .wf-run-caret { transform: rotate(90deg); }
.wf-run-line time { flex: none; color: var(--wf-muted); font-family: var(--wf-mono); font-size: 12px; font-variant-numeric: tabular-nums; }
.wf-run-line strong { flex: 1; min-width: 0; overflow: hidden; font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }
.wf-run-meta { flex: none; color: var(--wf-muted); font-family: var(--wf-mono); font-size: 12px; font-variant-numeric: tabular-nums; }
.wf-run > .wf-run-note { padding-left: 24px; }
.wf-run-body { display: grid; gap: 14px; padding: 4px 16px 12px 40px; background: var(--wf-hover); font-size: 13px; }
.wf-run-body section { display: grid; gap: 6px; min-width: 0; }
.wf-run-body h4 { display: flex; align-items: center; gap: 8px; margin: 0; color: var(--wf-muted); font-size: 12px; font-weight: 600; letter-spacing: .02em; }
.wf-run-body h4 small { font-weight: 400; }
.wf-run-text { margin: 0; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; }
.wf-run-text.is-muted { color: var(--wf-muted); }
.wf-run-steps { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
.wf-run-steps li { display: grid; gap: 2px; min-width: 0; }
.wf-run-step-line { display: flex; align-items: center; gap: 8px; min-width: 0; }
.wf-run-step-line strong { font-weight: 500; }
.wf-run-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--tone, var(--wf-plain)); }
.wf-run-step-state { color: var(--wf-muted); font-size: 12px; }
.wf-run-step-state.is-running { color: var(--wf-accent); }
.wf-run-step-state.is-failed { color: var(--wf-failed); }
.wf-run-step-line .wf-run-meta { margin-left: auto; }
.wf-run-step-note { padding-left: 16px; overflow: hidden; color: var(--wf-muted); font-size: 12px; line-height: 18px; text-overflow: ellipsis; white-space: nowrap; }
.wf-run-step-note.is-failed { color: var(--wf-failed); }
/* In the overview an interjection is two lines at most; the timeline's segment line lists them in full. */
.wf-run-aside { display: -webkit-box; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.wf-run-more { margin: 0; color: var(--wf-muted); font-size: 12px; }
.wf-run-jump { justify-self: start; margin-left: -6px; color: var(--wf-accent); }

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
.wf-axis-count { flex-shrink: 0; white-space: nowrap; }
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
/* Rows off screen skip layout and paint: with every execution shown (600+ rows, each with its phase bars) the page took
   seconds to lay out and to scroll (#8102). Each cell keeps its own size, and hand-off lines are drawn row by row, so
   nothing reaches across a cell. */
.wf-row > :not(.wf-detail) { content-visibility: auto; contain-intrinsic-size: auto var(--wf-row-h); }
.wf-row:hover > :not(.wf-detail), .wf-row.is-open > :not(.wf-detail) { --wf-tint: var(--wf-hover); }
/* Where a task begins: a full-width line with when and the message that opened it. */
.wf-segment { grid-column: 1 / -1; display: grid; gap: 2px; padding: 10px 16px 6px; border-top: 1px solid var(--wf-guide); background: color-mix(in oklab, var(--ui-text) 3%, var(--wf-surface)); }
.wf-segment-line { display: flex; align-items: baseline; gap: 10px; min-width: 0; }
.wf-segment-line time { flex: none; color: var(--wf-muted); font-family: var(--wf-mono); font-size: 12px; font-variant-numeric: tabular-nums; }
.wf-segment-line strong { min-width: 0; overflow: hidden; color: var(--wf-text); font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.wf-segment-line .wf-text-button { flex: none; color: var(--wf-accent); }
.wf-segment-line small { flex: none; color: var(--wf-muted); font-size: 12px; }
.wf-segment-note, .wf-run-note { overflow: hidden; color: var(--wf-muted); font-size: 12px; line-height: 18px; text-overflow: ellipsis; white-space: nowrap; }
.wf-segment-asides { display: grid; gap: 4px; margin: 4px 0 0; padding: 0; list-style: none; font-size: 12px; line-height: 1.6; }
.wf-segment-asides li { display: grid; grid-template-columns: 44px minmax(0, 1fr); gap: 8px; color: var(--ui-text); overflow-wrap: anywhere; }
.wf-segment-asides time { color: var(--wf-muted); font-family: var(--wf-mono); font-variant-numeric: tabular-nums; }
.wf-pill.is-aside { background: color-mix(in oklab, var(--wf-accent) 14%, transparent); color: var(--wf-accent); font-weight: 500; }
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
/* One finger up or down still scrolls the page; two fingers and sideways drags zoom and pan the axis (touch-zoom.js). */
/* touch-action is not inherited, and what counts is the element the finger lands on, so every part of the strip says it. */
.wf-track, .wf-track *, .wf-axis, .wf-axis *, .wf.is-compact .wf-row, .wf.is-compact .wf-row * { touch-action: pan-y; }
/* Zoomed in, bars and lines past the edges of the view are cut off at the track. */
.wf-grid.is-zoomed .wf-track { overflow: hidden; }
.wf-grid.is-zoomed .wf-axis { cursor: grab; }
.wf-grid.is-panning, .wf-grid.is-panning * { cursor: grabbing !important; user-select: none; }
.wf-zoom { display: inline-flex; align-items: center; gap: 2px; color: var(--wf-accent); font-family: var(--wf-mono); font-size: 11px; white-space: nowrap; }
.wf-zoom-reset { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; margin-left: 4px; padding: 0; border: 1px solid color-mix(in oklab, var(--wf-accent) 45%, transparent); border-radius: 999px;
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
/* The owner's time: the channel accent, hatched, apart from every member's hue; a message alone is a short mark. */
.wf-bar.is-work.is-user { min-width: 4px; background: repeating-linear-gradient(135deg, color-mix(in oklab, var(--channel-accent, var(--ui-primary)) 30%, transparent) 0 4px,
  color-mix(in oklab, var(--channel-accent, var(--ui-primary)) 14%, transparent) 4px 8px); box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--channel-accent, var(--ui-primary)) 65%, transparent); }
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
.wf [data-tone="6"] { --tone: var(--wf-h6); }
.wf [data-tone="7"] { --tone: var(--wf-h7); }
.wf [data-tone="8"] { --tone: var(--wf-h8); }
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

/* Detail: a panel floating under the opened name; on a phone a sheet floating over the bottom. Sections read top-down:
   who and how long, where the time went, what was asked, what came of it, then the story in time order. */
.wf-detail { position: absolute; z-index: 20; display: grid; gap: 14px; width: min(560px, calc(100% - 16px)); max-height: min(70vh, 600px); padding: 14px 16px 16px; overflow: auto;
  border: 1px solid var(--channel-edge-float, var(--wf-border)); border-radius: 12px; background: var(--ui-bg-elevated); box-shadow: var(--channel-shadow-float, 0 12px 32px rgb(0 0 0 / .3));
  font-size: 13px; line-height: 1.6; overscroll-behavior: contain; }
/* The card fades in on opening and out on closing; moving between rows it changes at once, never glides behind the pointer. */
.wf-pop-enter-active { transition: opacity .12s ease-out, transform .12s ease-out; }
.wf-pop-leave-active { transition: opacity .1s ease-in; }
.wf-pop-enter-from { opacity: 0; transform: translateY(4px); }
.wf-pop-leave-to { opacity: 0; }
@media (prefers-reduced-motion: reduce) { .wf-pop-enter-active, .wf-pop-leave-active { transition: none; } }
.wf-detail-head { position: relative; display: flex; align-items: center; gap: 10px; min-width: 0; padding-right: 30px; }
.wf-detail-title { display: grid; flex: 1; gap: 1px; min-width: 0; }
.wf-detail-name { display: flex; align-items: center; gap: 8px; min-width: 0; }
.wf-detail-name strong { overflow: hidden; color: var(--wf-text); font-size: 15px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
.wf-detail-title small { color: var(--wf-muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.wf-detail-total { flex: none; color: var(--wf-text); font-family: var(--wf-mono); font-size: 15px; font-weight: 600; font-variant-numeric: tabular-nums; }
.wf-state-pill { background: var(--wf-well); color: var(--wf-muted); }
.wf-state-pill.is-done { background: color-mix(in oklab, var(--ui-success, #22c55e) 14%, transparent); color: var(--ui-success, #22c55e); }
.wf-state-pill.is-running { background: color-mix(in oklab, var(--wf-accent) 14%, transparent); color: var(--wf-accent); }
.wf-state-pill.is-failed { background: color-mix(in oklab, var(--wf-failed) 14%, transparent); color: var(--wf-failed); }
.wf-detail .wf-card-close { top: 50%; right: -8px; transform: translateY(-50%); }
.wf-detail-status { margin: -4px 0 0; white-space: normal; line-height: 1.5; }
.wf-detail-block { display: grid; gap: 8px; min-width: 0; }
.wf-detail-block h4 { display: flex; align-items: center; gap: 8px; margin: 0; color: var(--wf-muted); font-size: 12px; font-weight: 600; letter-spacing: .02em; }
.wf-detail-block h4 small { font-weight: 400; }
/* Where the time went: one bar in the member's hue, then each part with its length and share. */
.wf-dist { display: flex; gap: 2px; height: 10px; overflow: hidden; border-radius: 5px; background: var(--wf-well); }
.wf-dist i { flex-basis: 0; min-width: 3px; }
.wf-dist-key { display: grid; grid-template-columns: repeat(auto-fill, minmax(132px, 1fr)); gap: 4px 14px; margin: 0; padding: 0; list-style: none; }
.wf-dist-key li { display: flex; align-items: center; gap: 6px; min-width: 0; color: var(--wf-muted); font-size: 12px; }
.wf-dist-key b { margin-left: auto; color: var(--wf-text); font-family: var(--wf-mono); font-weight: 500; font-variant-numeric: tabular-nums; }
.wf-dist-key small { width: 32px; color: var(--ui-text-dimmed); font-family: var(--wf-mono); font-size: 11px; text-align: right; font-variant-numeric: tabular-nums; }
:is(.wf-dist, .wf-dist-key) .is-wait { background: repeating-linear-gradient(-45deg, var(--wf-hatch) 0 1px, transparent 1px 4px); box-shadow: inset 0 0 0 1px var(--wf-hatch); }
:is(.wf-dist, .wf-dist-key) .is-other { background: color-mix(in oklab, var(--tone, var(--wf-plain)) 28%, var(--wf-surface)); box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--tone, var(--wf-plain)) 55%, transparent); }
/* What was asked, as a quote in body type; a long task shows four lines until opened. */
.wf-detail-task { display: -webkit-box; margin: 0; padding: 8px 12px; overflow: hidden; border-left: 2px solid color-mix(in oklab, var(--wf-text) 18%, transparent); border-radius: 0 6px 6px 0;
  background: var(--wf-well); color: var(--ui-text); font-size: 14px; line-height: 1.75; white-space: pre-wrap; overflow-wrap: anywhere; -webkit-box-orient: vertical; -webkit-line-clamp: 4; }
.wf-detail-task.is-open { display: block; }
.wf-detail-more { justify-self: start; margin: -4px 0 0 4px; color: var(--wf-accent); }
.wf-detail-link { display: inline-flex; align-items: center; gap: 2px; margin-left: auto; padding: 0 4px; border: 0; border-radius: 4px; background: none; color: var(--wf-accent); font: inherit; font-family: var(--wf-mono); font-weight: 500; cursor: pointer; }
.wf-detail-link:hover { background: var(--wf-hover); }
.wf-detail-link :deep(svg) { width: 12px; height: 12px; }
.wf-detail-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.wf-detail-chip { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 12px; border: 1px solid var(--wf-border); border-radius: 8px; background: var(--wf-well); color: var(--wf-muted); font: inherit; font-size: 12px; }
.wf-detail-chip.is-link { color: var(--wf-text); cursor: pointer; }
.wf-detail-chip.is-link:hover { border-color: var(--wf-guide); background: var(--wf-hover); }
.wf-detail-chip :deep(svg) { width: 14px; height: 14px; }
/* The story: a rail of dots in the member's hue, the model's turns solid and tool work hollow; notes read as text on it. */
.wf-log { position: relative; display: grid; margin: 0; padding: 0; list-style: none; }
.wf-log::before { position: absolute; top: 10px; bottom: 10px; left: 4px; width: 1px; background: var(--wf-guide); content: ""; }
.wf-log li { position: relative; display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: baseline; gap: 0 10px; padding: 5px 0 5px 20px; }
.wf-log-dot { position: absolute; top: 11px; left: 0; width: 9px; height: 9px; border-radius: 50%; background: var(--wf-plain); box-shadow: 0 0 0 3px var(--ui-bg-elevated); }
.wf-log li.kind-model .wf-log-dot { background: var(--tone, var(--wf-plain)); }
.wf-log li.kind-tool .wf-log-dot { background: var(--ui-bg-elevated); box-shadow: inset 0 0 0 1.5px var(--tone, var(--wf-plain)), 0 0 0 3px var(--ui-bg-elevated); }
.wf-log li.log-note .wf-log-dot { top: 14px; left: 2px; width: 5px; height: 5px; background: var(--wf-muted); }
.wf-log li.is-live .wf-log-dot { animation: wf-pulse 1.4s ease-in-out infinite; }
.wf-log-phase { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
.wf-log-phase b { flex: none; color: var(--wf-text); font-weight: 550; }
.wf-log-tool { overflow: hidden; color: var(--wf-muted); font-family: var(--wf-mono); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.wf-log-dur { color: var(--wf-text); font-family: var(--wf-mono); font-size: 12px; text-align: right; font-variant-numeric: tabular-nums; }
.wf-log li.is-live .wf-log-dur { color: var(--wf-accent); font-family: inherit; }
.wf-log time { grid-column: 1 / -1; color: var(--ui-text-dimmed); font-family: var(--wf-mono); font-size: 11px; line-height: 15px; font-variant-numeric: tabular-nums; }
.wf-log-note { grid-column: 1 / -1; margin: 0; padding: 8px 10px; border-radius: 8px; background: var(--wf-well); color: var(--ui-text); line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; }
.wf-log li.log-note time { margin-top: 3px; }
/* A phase is one line: what, how long, when. */
.wf-log li.log-phase { grid-template-columns: minmax(0, 1fr) auto 62px; }
.wf-log li.log-phase time { grid-column: auto; text-align: right; }
.wf-log li.log-phase .wf-log-dot { top: 50%; margin-top: -4.5px; }

/* Footer: the three kinds of time, folded idle and truncation notes, and the way into a replay. */
.wf-foot { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 18px; padding: 8px 16px; border-top: 1px solid var(--wf-border); color: var(--wf-muted); font-size: 12px; }
.wf-foot span { display: inline-flex; align-items: center; gap: 6px; }
.wf-key .wf-swatch:not(:first-child) { margin-left: 8px; }
.wf-key .wf-swatch.is-model, .wf-key .wf-swatch.is-tool { --tone: var(--wf-muted); }
.wf-replay-open { margin-left: auto; }
/* The share page's replay: the one thing a first-time reader should press, so it looks like a button. */
.wf-share-replay { display: inline-flex; align-items: center; gap: 6px; margin-left: auto; height: 30px; padding: 0 14px; border: 0; border-radius: 15px; background: var(--ui-primary); color: #fff; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; white-space: nowrap; box-shadow: 0 2px 10px color-mix(in srgb, var(--ui-primary) 40%, transparent); transition: filter .15s; }
.wf-share-replay:hover { filter: brightness(1.1); }
.wf-share-replay.is-playing { background: var(--wf-hover, #ffffff14); color: var(--wf-text); box-shadow: none; }
.wf-share-replay :deep(svg) { width: 14px; height: 14px; }
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
@keyframes wf-sheet-in { from { opacity: 0; transform: translateY(24px); } }
@keyframes wf-pulse { 50% { opacity: .45; } }
/* Motion: the waterfall draws itself. Running bars grow every frame (in script), their leading edge fades out as a trace
   draws running spans, and a light sweeps along them; a row that appears slides in and its bars unroll from the left. */
.is-running .wf-bar.is-work:not(.has-detail), .wf-seg.is-live:not(.is-tail) { overflow: hidden;
  -webkit-mask-image: linear-gradient(90deg, #000 calc(100% - 24px), rgb(0 0 0 / .35)); mask-image: linear-gradient(90deg, #000 calc(100% - 24px), rgb(0 0 0 / .35)); }
.is-running .wf-bar.is-work:not(.has-detail)::after, .wf-seg.is-live:not(.is-tail)::after { position: absolute; inset: 0; content: "";
  background: linear-gradient(90deg, transparent, rgb(255 255 255 / .38), transparent) no-repeat; background-size: 64px 100%; animation: wf-sweep 1.8s linear infinite; }
@keyframes wf-sweep { from { background-position: -64px 0; } to { background-position: calc(100% + 64px) 0; } }
.wf-row.is-entering > :not(.wf-detail) { animation: wf-enter 520ms cubic-bezier(.2, .8, .2, 1) both; }
.wf-row.is-entering .wf-track > .wf-bar { transform-origin: left center; animation: wf-unroll 640ms cubic-bezier(.2, .8, .2, 1) both; }
@keyframes wf-enter { from { opacity: 0; transform: translateY(8px); } }
@keyframes wf-unroll { from { transform: scaleX(0); } }

/* Narrow pages (a small window, or both rails open): a shorter label column, so the lanes keep room. */
.execution-timeline { container: wf / inline-size; }
@container wf (max-width: 900px) {
  .wf { --wf-label-col: 200px; }
  .wf-grid { grid-template-columns: var(--wf-label-col) minmax(0, 1fr) 68px; }
  .wf-end { padding-right: 10px; }
}
/* Phones (decided by the page's own width, in script): the same one axis as on a PC, idle folded, a few clock ticks on
   top, so every bar reads left to right in time and a dispatch steps down. Each execution is two lines: when, who and how
   long, then its bar; running and failed rows add where their time went. A tap opens the row's own detail, at its own
   scale, in place of zooming. */
.wf.is-compact .wf-head, .wf.is-compact .wf-foot, .wf.is-compact .wf-player { padding-inline: 12px; }
.wf.is-compact .wf-run { padding-inline: 12px; }
.wf.is-compact .wf-run-body { padding-inline: 12px; }
.wf.is-compact .wf-run > .wf-run-note { padding-left: 0; }
.wf.is-compact .wf-segment { padding-inline: 12px; }
.wf.is-compact .wf-segment-line { flex-wrap: wrap; gap: 2px 8px; }
.wf.is-compact .wf-segment-line strong { display: -webkit-box; flex-basis: 100%; order: 3; line-height: 20px; white-space: normal; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
/* A user message sent without reading time has no bar worth drawing: just when and who, the message is in the line above. */
.wf.is-compact .wf-row.is-instant .wf-lane, .wf.is-compact .wf-row.is-instant .wf-name-end { display: none; }
.wf.is-compact .wf-row.is-instant .wf-label { padding-bottom: 6px; }
/* On a phone the message that started a task gets its own line (two at most) under when, how many and how long. */
.wf.is-compact .wf-run-line { flex-wrap: wrap; gap: 2px 8px; }
.wf.is-compact .wf-run-meta { margin-left: auto; }
.wf.is-compact .wf-run-line strong { display: -webkit-box; flex-basis: 100%; order: 3; line-height: 20px; white-space: normal; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.wf.is-compact .wf-grid { grid-template-columns: minmax(0, 1fr); }
.wf.is-compact .wf-axis { height: 26px; font-size: 10px; }
.wf.is-compact .wf-fold-label { font-size: 9px; }
.wf.is-compact .wf-gridline { opacity: .6; }
.wf.is-compact .wf-row > :not(.wf-detail) { min-height: 0; }
.wf.is-compact .wf-label { padding: 6px 12px 0 calc(12px + var(--depth) * var(--wf-depth-px)); border-top: 1px solid var(--wf-border); border-right: 0; }
.wf.is-compact .wf-row:first-of-type .wf-label { border-top: 0; }
.wf.is-compact .wf-guides { left: 14px; }
.wf.is-compact .wf-names { padding: 0; }
.wf.is-compact .wf-clock { flex: none; color: var(--wf-muted); font-family: var(--wf-mono); font-size: 11px; font-variant-numeric: tabular-nums; }
.wf.is-compact .wf-name-end { display: inline-flex; flex: none; align-items: baseline; gap: 6px; margin-left: auto; font-family: var(--wf-mono); font-size: 12px; font-variant-numeric: tabular-nums; }
/* The whole lane is the tap target; the pieces inside are too thin to aim at with a finger. */
.wf.is-compact .wf-lane { --wf-bar-h: 10px; display: block; padding: 6px 0 4px; cursor: pointer; }
.wf.is-compact .wf-lane:focus-visible { outline: 2px solid var(--wf-accent); outline-offset: -2px; }
.wf.is-compact .wf-track { height: 12px; }
.wf.is-compact .wf-track > * { pointer-events: none; }
.wf.is-compact .wf-well, .wf.is-compact .wf-bar { border-radius: 5px; }
.wf.is-compact .wf-row-status { padding: 0 12px 6px; }
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
/* On a phone the detail floats as a sheet over the bottom of the screen instead of opening inside the list, so the
   rows keep their place (user 2026-11-17: the in-place panel broke the page apart). A tap outside closes it. */
.wf.is-compact .wf-detail { position: fixed; inset: auto 8px calc(8px + env(safe-area-inset-bottom)) 8px; z-index: 60; width: auto; max-height: min(68dvh, 600px); margin: 0; padding: 14px;
  border-radius: 16px; animation: wf-sheet-in 180ms cubic-bezier(.2, .8, .2, 1); }
.wf.is-compact .wf-dist-key { grid-template-columns: repeat(2, minmax(0, 1fr)); }
/* Touch: controls keep their look but take a fingertip; a note's tick is easier to hit. */
@media (pointer: coarse) {
  .wf-toggle { flex: 0 0 32px; width: 32px; height: 32px; margin: -8px; }
  .wf-text-button { height: 32px; }
  .wf-note { width: 24px; margin-left: -12px; }
}
</style>

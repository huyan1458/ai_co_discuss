<script setup>
import { computed, inject, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import ScheduleCard from "./ScheduleCard.vue";
import SchedulerDecision from "./SchedulerDecision.vue";
import TopicCard from "./TopicCard.vue";
import DiscussionEndCard from "./DiscussionEndCard.vue";
import GoalNoticeCard from "./GoalNoticeCard.vue";
import ExecutionDenials from "./ExecutionDenials.vue";
import ExecutionNotes from "./ExecutionNotes.vue";
import WorkingText from "./WorkingText.vue";
import QueuedMessages from "./QueuedMessages.vue";
import QuestionCard from "./QuestionCard.vue";
import { active_workflow } from "./workflow-state.js";
import { workflow_problem } from "./workflow-library.js";
import { open_private_chat } from "./private-chat.js";
import { ENTER_SENDS } from "./enter-sends.js";
import { use_read_aloud } from "./read-aloud.js";
import { use_broadcast } from "./broadcast.js";
import { format_voice_time, use_voice_input, use_voice_press } from "./voice-input.js";
import ExcerptEditCard from "./ExcerptEditCard.vue";
import ExecutionChanges from "./ExecutionChanges.vue";
import { add_excerpt, excerpt_mark_place, excerpt_range, excerpt_source, excerpts_markdown, file_preview, hold_selection, text_offset } from "./file-preview.js";
import { keep_reading_position } from "./scroll-anchor.js";
import { guard_token_edit, snap_caret, step_over_token, token_mirror } from "./attachment-tokens.js";
import MemoBlock from "./memo-block.js";
import UTooltip from "@nuxt/ui/components/Tooltip.vue";
import { motion, useSpring, useTransform } from "motion-v";
import { locale, t } from './i18n.js';
import ExternalMemberDialog from "./ExternalMemberDialog.vue";
import { declined, awaiting_member } from "./external-members.js";

const pending_seat = ref(null), pending_seat_open = ref(false);
const emit = defineEmits(["detail", "edit"]);
let topic_card = null;
const { view, bridge, field, act, pending } = inject("discussion");
// Typing publishes no snapshot: a publish re-renders the whole transcript, hundreds of milliseconds per key in a long room.
const text = field("message-input", { quiet: true });
const text_length = computed(() => [...text.value].length);
const EDITOR_MAX_ROWS = 6;
const LENGTH_WARNING_RATIO = 0.9;
const RETRACT_ESCAPE_WINDOW_MS = 500;
const near_length_limit = computed(() => text_length.value >= bridge.max_message_length * LENGTH_WARNING_RATIO);
const search = field("search-input");
const transcript = ref(null);
const expanded_answers = ref(new Set());
// Speech settings kept by the local service, read at most once a minute: whether a key is set, each platform's voice, following.
const SPEECH_CHECK_MS = 60000;
// Voices are re-read when a reading starts, so a change in settings is heard right away.
const SPEECH_VOICE_MS = 10000;
let speech_checked = 0, speech = {};
/** Read the local speech settings, reusing an answer younger than `fresh_ms`. */
async function speech_settings(fresh_ms = SPEECH_CHECK_MS) {
  if (Date.now() - speech_checked < fresh_ms) return speech;
  speech_checked = Date.now();
  try { speech = await bridge.local_request("tts-settings", {}); } catch { speech = {}; }
  return speech;
}
// Read-aloud runs on the local service; a long answer is shown in full before it is read so its sentences can be highlighted.
const reader = use_read_aloud({ bridge, container: () => transcript.value,
  message_of: (id) => view.value.messages.find((message) => message.id === id),
  // An AI member speaks in its platform's voice; the user, program messages and unset platforms use the default voice.
  voice_for: async (name) => (await speech_settings(SPEECH_VOICE_MS)).member_voices?.[bridge.platform_of(name)] || "",
  title: () => room.value?.title || "",
  prepare: async (id) => {
    if (!answer_previews.value.get(id)?.truncated || expanded_answers.value.has(id)) return;
    expanded_answers.value.add(id);
    await nextTick();
  } });
// Voice broadcast announces new replies and room events while on; the switch sits beside the microphone.
const broadcast = use_broadcast({ view, bridge, reader });
// Whether speech was set up when last read in this browser, so the broadcast switch is in place before the read returns.
const SPEECH_READY_KEY = "ai-codiscuss-speech-ready";
const speech_ready = ref((() => { try { return localStorage.getItem(SPEECH_READY_KEY) === "1"; } catch { return false; } })());
/** Show the broadcast switch as the latest read says and remember it for the next visit. */
function set_speech_ready(ready) {
  speech_ready.value = ready;
  try { localStorage.setItem(SPEECH_READY_KEY, ready ? "1" : "0"); } catch { /* Shown only after the read next time. */ }
}
// Voice input inserts recognized text where the caret was in the composer.
const voice = use_voice_input({ bridge, on_text: (spoken) => {
  const area = prompt.value?.textareaRef, value = text.value || "";
  const start = area ? area.selectionStart : value.length, end = area ? area.selectionEnd : value.length;
  text.value = `${value.slice(0, start)}${spoken}${value.slice(end)}`;
  // On touch screens focusing would raise the keyboard over the send key, so the text is only inserted.
  nextTick(() => { if (ENTER_SENDS) area?.focus(); area?.setSelectionRange(start + spoken.length, start + spoken.length); });
} });
// Tap, hold or Space to talk, the same as on the welcome page's composer.
const voice_press = use_voice_press({ voice, textarea: () => prompt.value?.textareaRef, text, busy: () => view.value.sending_message });
const voice_hold = voice_press.hold;
// Where "listen from here" shows for text selected in a message, with the selection kept for the click.
const listen_here = ref(null);
// The phone toolbar has room for three buttons, so read-aloud joins the "more" menu there.
const narrow_query = window.matchMedia("(max-width: 700px)");
const narrow = ref(narrow_query.matches);
const track_narrow = (event) => { narrow.value = event.matches; };
// "Listen from here" waits until a selection has settled (pointer released, no change for a moment), and shows only when
// speech is configured on this computer; most selections are for copying.
const LISTEN_SETTLE_MS = 350;
// The offer pills and the comment box sit just above the selection (below it when there is no room), kept on screen.
const QUOTE_OFFER_WIDTH = 190;
const QUOTE_OFFER_HEIGHT = 28;
const QUOTE_COMMENT_WIDTH = 340;
const QUOTE_COMMENT_HEIGHT = 40;
const QUOTE_GAP = 6;
let listen_timer = 0, pointer_down = false;
const speech_configured = async () => Boolean((await speech_settings()).api_key_ref);
// A selection being added to the chat: `{ id, range, text, to, touch, left, top }`, waiting for an optional comment.
const quoting = ref(null);
const quote_comment = ref("");
const quote_input = ref(null);
// A quoted passage reopened from its number mark: `{ excerpt, range, left, top }`.
const mark_editing = ref(null);
const MARK_CARD_WIDTH = 300;
const MARK_CARD_HEIGHT = 110;
// Number marks at the end of each quoted passage still in the composer: message id → [{ number, left, top }].
const excerpt_marks = ref(new Map());
/** Hide the offer while a selection is changing and check again once it settles. */
function schedule_listen() {
  listen_here.value = null;
  window.clearTimeout(listen_timer);
  if (!pointer_down) listen_timer = window.setTimeout(track_selection, LISTEN_SETTLE_MS);
}
// Pressing the offer or the comment box must not hide it before its click lands; pressing elsewhere drops the comment box.
const on_offer = (event) => Boolean(event.target.closest?.(".channel-listen-mark, .channel-listen-pill, .selection-comment, .excerpt-mark, .excerpt-edit"));
// Only a mouse or pen holds the offer until release: iOS sends no pointerup or pointercancel after a long-press selection
// or a handle drag, so a touch press would hold it until the next touch; touch selections rely on the settle delay alone.
const press = (event) => { if (on_offer(event)) return; pointer_down = event.pointerType !== "touch"; if (quoting.value) cancel_quote(); if (mark_editing.value) close_mark(); };
const release = (event) => { if (on_offer(event)) return; pointer_down = false; schedule_listen(); };
/** Fixed place `{ left, top }` for a box of this size above the range's start, or below its end when there is no room. */
function place_by(range, width, height) {
  const rects = range.getClientRects(), first = rects[0] || range.getBoundingClientRect(), last = rects[rects.length - 1] || first;
  const floor = transcript.value?.getBoundingClientRect().top ?? 0;
  const above = first.top - height - QUOTE_GAP;
  const left = Math.max(8, Math.min(above >= floor ? first.left : last.right - width / 2, window.innerWidth - width - 8));
  return { left, top: above >= floor ? above : last.bottom + QUOTE_GAP };
}
/** Offer quoting (and, with speech configured, reading from) a selection made inside a message's text. */
async function track_selection() {
  if (quoting.value) return;
  const selection = document.getSelection();
  const range = selection?.rangeCount && !selection.isCollapsed ? selection.getRangeAt(0) : null;
  const start = range && (range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer : range.startContainer.parentElement);
  const body = start?.closest(".channel-answer > .channel-message-text");
  const card = body && transcript.value?.contains(body) ? body.closest(".channel-message[data-message-id]") : null;
  const text = card ? range.toString().replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim() : "";
  if (!text) { listen_here.value = null; return; }
  const kept = range.cloneRange();
  if (pointer_down || quoting.value) return;
  // On touch screens the system's own selection menu sits next to the selection, so the buttons wait above the composer instead.
  const touch = window.matchMedia("(pointer: coarse)").matches;
  const to = body.contains(kept.endContainer) ? text_offset(body, kept.endContainer, kept.endOffset) : body.textContent.length;
  const from = text_offset(body, kept.startContainer, kept.startOffset);
  listen_here.value = { id: Number(card.dataset.messageId), range: kept, text, from, to, speech: false, touch, ...place_by(kept, QUOTE_OFFER_WIDTH, QUOTE_OFFER_HEIGHT) };
  const shown = listen_here.value;
  const speech = await speech_configured().catch(() => false);
  if (listen_here.value === shown) shown.speech = speech;
}
/** Open the comment box for the offered selection, keeping the selected text highlighted meanwhile. */
async function start_quote() {
  const offer = listen_here.value;
  listen_here.value = null;
  quoting.value = { ...offer, ...place_by(offer.range, QUOTE_COMMENT_WIDTH, QUOTE_COMMENT_HEIGHT) };
  quote_comment.value = "";
  hold_selection(offer.range);
  document.getSelection()?.removeAllRanges();
  await nextTick();
  quote_input.value?.focus();
}
/** Keep the comment box (or a mark's edit card) beside its passage while the transcript scrolls. */
function place_quote() {
  if (quoting.value && !quoting.value.touch) Object.assign(quoting.value, place_by(quoting.value.range, QUOTE_COMMENT_WIDTH, QUOTE_COMMENT_HEIGHT));
  if (mark_editing.value?.range) Object.assign(mark_editing.value, place_by(mark_editing.value.range, MARK_CARD_WIDTH, MARK_CARD_HEIGHT));
}
/** Open a quoted passage's edit card from its number mark, highlighting the passage again. */
function open_mark(excerpt_id) {
  cancel_quote();
  const excerpt = file_preview.excerpts.find((item) => item.id === excerpt_id);
  const range = excerpt && excerpt_range(document.getElementById(`channel-answer-${excerpt.message_id}`), excerpt.from, excerpt.to);
  if (!range) return;
  hold_selection(range);
  // Docked above the composer on touch screens, as adding a note is: one control for writing a note either way.
  mark_editing.value = { excerpt, range, touch: window.matchMedia("(pointer: coarse)").matches, ...place_by(range, MARK_CARD_WIDTH, MARK_CARD_HEIGHT) };
}
// The notes list in the composer: open or closed, so editing one note on a phone can close it.
const excerpt_list_open = ref(false);
/**
 * Edit a listed note. On a phone it is edited in the same bar at the bottom as a note being added (user 2026-11-17:
 * a different box inside the list made the same action look like two), so the list closes first; elsewhere in the row.
 */
function edit_listed_excerpt(excerpt) {
  if (!window.matchMedia("(pointer: coarse)").matches) { editing_excerpt.value = editing_excerpt.value === excerpt.id ? 0 : excerpt.id; return; }
  excerpt_list_open.value = false;
  cancel_quote();
  mark_editing.value = { excerpt, range: null, touch: true };
}
/** The docked edit box's line naming its note: its number and the start of the quoted text. */
function mark_context(excerpt) {
  return t('修改注释 {value1} · {value2}', { value1: file_preview.excerpts.indexOf(excerpt) + 1, value2: excerpt.text.replace(/\s+/g, " ").trim() });
}
function close_mark() {
  mark_editing.value = null;
  hold_selection(null);
}
function save_mark(comment) {
  mark_editing.value.excerpt.comment = comment;
  close_mark();
}
function remove_mark() {
  remove_excerpt(mark_editing.value.excerpt);
  close_mark();
}
function cancel_quote() {
  quoting.value = null;
  hold_selection(null);
}
/** Put the selection and its comment in the composer as an excerpt of its message, numbered in place. */
function submit_quote() {
  const { id, text, from, to } = quoting.value;
  const author = view.value.messages.find((message) => message.id === id)?.author || "";
  add_excerpt({ path: `#${id}`, name: bridge.display_name(author), message_id: id, start: 0, end: 0, text, from, to, comment: quote_comment.value.trim() });
  cancel_quote();
}
function quote_keydown(event) {
  if (event.isComposing) return;
  if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancel_quote(); }
  else if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submit_quote(); }
}
/** Re-measure where each quoted passage ends, for its number mark. */
function place_marks() {
  const marks = new Map();
  file_preview.excerpts.forEach((excerpt, index) => {
    const body = excerpt.message_id && document.getElementById(`channel-answer-${excerpt.message_id}`);
    const place = body && excerpt_mark_place(body, body.parentElement, excerpt.to);
    if (!place) return;
    marks.set(excerpt.message_id, [...(marks.get(excerpt.message_id) || []), { id: excerpt.id, number: index + 1, ...place }]);
  });
  excerpt_marks.value = marks;
}
watch([() => file_preview.excerpts.map((excerpt) => excerpt.id).join(), () => view.value.messages, () => [...expanded_answers.value].join(), narrow], () => nextTick(place_marks), { flush: "post" });
/** Start reading where the selection begins and continue to the latest message. */
function listen_from_selection() {
  const { id, range } = listen_here.value;
  listen_here.value = null;
  document.getSelection()?.removeAllRanges();
  reader.start(id, range);
}
onMounted(() => {
  document.addEventListener("selectionchange", schedule_listen);
  document.addEventListener("pointerdown", press);
  document.addEventListener("pointerup", release);
  // A touch long-press that starts a selection ends in pointercancel, not pointerup.
  document.addEventListener("pointercancel", release);
  narrow_query.addEventListener("change", track_narrow);
  transcript.value?.addEventListener("scroll", schedule_listen, { passive: true });
  transcript.value?.addEventListener("scroll", place_quote, { passive: true });
  window.addEventListener("resize", place_marks);
  watch(() => room.value?.id, () => { reader.stop(); voice.cancel(); cancel_quote(); });
  speech_configured().then(set_speech_ready);
});
onBeforeUnmount(() => { document.removeEventListener("selectionchange", schedule_listen); document.removeEventListener("pointerdown", press); document.removeEventListener("pointerup", release); document.removeEventListener("pointercancel", release); window.removeEventListener("resize", place_marks); window.clearTimeout(listen_timer); narrow_query.removeEventListener("change", track_narrow); reader.stop(); voice.cancel(); hold_selection(null); });
const MESSAGE_PREVIEW_LENGTH = 160;
const MESSAGE_PREVIEW_MIN_LENGTH = 100;
const MESSAGE_PREVIEW_CODE_LINES = 4;
const MESSAGE_PREVIEW_TABLE_ROWS = 3;
const answer_preview_cache = new WeakMap();
/** Reuse immutable message excerpts while the room refreshes. */
const answer_previews = computed(() => new Map(view.value.messages.map((message) => {
  if (!answer_preview_cache.has(message)) answer_preview_cache.set(message, build_answer_preview(message));
  return [message.id, answer_preview_cache.get(message)];
})));
const message_map = ref(null);
const navigation_keyboard = ref(false);
const active_message = ref(null);
const jump_target = ref(null);
const preview_message = ref(null);
const preview_entry = ref(null);
const preview_is_round = ref(false);
const preview_open = ref(false);
const preview_content = ref(null);
const preview_left = ref(0);
const preview_top = ref(0);
const preview_size = ref(0);
// Feel.words("snappy, precise"): m 1, 3.91 Hz, ζ 0.91; keep velocity when retargeting.
const NAV_SPRING = { type: "spring", mass: 1, stiffness: 604.0197893466687, damping: 44.729801589453814 };
const PREVIEW_WIDTH = 320;
const PREVIEW_PADDING = 34; // Two 16px paddings and two 1px borders.
const PREVIEW_INSET = 12;
const PREVIEW_GAP = 16;
const NAV_ENTRY_HEIGHT = 14;
const NAV_TICK_WIDTH = 8;
const NAV_ACTIVE_WIDTH = 28;
const NAV_READING_WIDTH = 18;
const NAV_TICK_HEIGHT = 1;
const NAV_ACTIVE_HEIGHT = 1.5;
const NAV_HOVER_REACH = 3;
const NAV_HOVER_EXTENSION = 6;
const NAV_TICK_OPACITY = 0.62;
const NAV_READING_OPACITY = 0.72;
const NAV_ACTIVE_OPACITY = 0.88;
const NAV_HOVER_OPACITY = 0.16;
const NAV_EDGE_INSET = 12;
const NAV_TOUCH_SLOP = 8;
const NAV_SCRUB_EDGE = 40; // Scrubbing within this distance of either end auto-scrolls the map.
const NAV_SCRUB_SPEED = 12; // Auto-scroll pixels per frame at the very end.
const NAV_SCRUB_CANCEL = 24; // Releasing this far sideways outside the map cancels the jump.
const NAV_HAPTIC_MS = 8;
let navigation_scrub = null;
let suppress_navigation_click = false;
// Feel.words("smooth, crisp"): m 1, 2.62 Hz, ζ 0.96, no overshoot, settles in 327 ms. A sent message and the transcript
// under it move on this one spring: unhurried enough to read as gliding, damped so it lands without a bounce.
const SEND_SPRING = { type: "spring", mass: 1, stiffness: 270.0323764138049, damping: 31.550710806760762 };
// The sending card rises this far from the composer as it fades in.
const SEND_RISE = 12;
const preview_y = useSpring(0, NAV_SPRING);
const preview_height = useSpring(0, NAV_SPRING);
const preview_visibility = useSpring(0, NAV_SPRING);
const preview_scale = useTransform(preview_visibility, [0, 1], [0.96, 1]);
const preview_x = useTransform(preview_visibility, [0, 1], [-8, 0]);
const preview_opacity = useTransform(preview_visibility, [0, 1], [0, 1]);
const preview = computed(() => view.value.messages.find((message) => message.id === preview_message.value));
const preview_group = computed(() => navigation_groups.value.find((group) => group.messages.some((message) => message.id === preview_message.value)));
const preview_round = computed(() => preview_group.value?.label);
const preview_index = computed(() => preview_open.value ? navigation_entries.value.findIndex((entry) => entry.key === preview_entry.value) : -1);
const prompt = ref(null);
const follow_tail = ref(true);
const FOLLOW_TAIL_THRESHOLD = 70;
// A room just opened keeps following its end this long while cards settle, unless the reader scrolls by hand: estimated
// heights turning into measured ones make the browser shift the page by itself, and that scroll used to count as the
// reader leaving the end (2026-11-16: first opening a room stopped 70–358px short, with "回到最新" shown).
const ROOM_SETTLE_MS = 8000;
let settle_until = performance.now() + ROOM_SETTLE_MS, moved_by_hand = false;
// Cards mounted when a room opens, a few screens' worth; earlier ones follow in slices (see render_floor).
const RENDER_BATCH = 15;
// Within this distance (px) of the top, earlier cards are rendered on every frame instead of when idle.
const LOAD_EARLIER_MARGIN = 2000;
// Render time (ms) one slice may take: idle slices stay inside a frame, slices a scrolling reader waits on nearly fill
// one, and a clicked jump, where nothing moves until it lands, takes larger ones to land sooner.
const PRELOAD_BUDGET_MS = 8;
const PRELOAD_URGENT_BUDGET_MS = 14;
const PRELOAD_JUMP_BUDGET_MS = 40;
const PRELOAD_FIRST_SLICE = 2;
const PRELOAD_MAX_SLICE = 20;
// Idle slices wait this long at most (ms) for an idle moment.
const PRELOAD_IDLE_TIMEOUT_MS = 300;
// The reader is still scrolling until this long (ms) after their last scroll event. iOS sends scroll events only for
// whole-pixel moves, so the slow end of a swipe's momentum can go quiet for longer than a frame or two.
const SCROLL_SETTLE_MS = 300;
// Scroll events this soon (ms) after a wheel turn, a drag or a scroll key are the reader's; any other scroll the page did
// not write (the browser's own anchoring, a clamp after content shrank) does not hold the page back.
const READER_INPUT_MS = 1000;
// Only Blink and Gecko keep the reading position themselves. Apple's WebKit (Safari and every iOS browser; the font keyword
// -apple-system-body exists only there) reports overflow-anchor since its scroll anchoring shipped in 2026, but that does
// not hold while a touch scroll runs: taking the report at its word, the page left the position to the browser and every
// slice of earlier cards slid what the reader saw down, screen after screen, for seconds after a short swipe (2026-11-17
// recordings). There channel.css turns the browser's anchoring off and the page keeps the position by hand (keep_reading),
// in whole pixels, as WebKit scrolls: a top pad under 1px takes each shift's fraction, which made the text wobble.
const SCROLL_ANCHORING = CSS.supports("overflow-anchor", "auto") && !CSS.supports("font", "-apple-system-body");
const READING_OFFSET = 20;
const room = computed(() => view.value.room);
/** Whether two derived values hold the same data: identical leaves, or Maps, arrays and plain objects with equal entries. */
function same_value(left, right) {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object" || Object.getPrototypeOf(left) !== Object.getPrototypeOf(right)) return false;
  if (left instanceof Map) return left.size === right.size && [...left].every(([key, value]) => right.has(key) && same_value(value, right.get(key)));
  if (left instanceof Set) return left.size === right.size && [...left].every((value) => right.has(value));
  if (Array.isArray(left)) return left.length === right.length && left.every((value, index) => same_value(value, right[index]));
  if (Object.getPrototypeOf(left) !== Object.prototype) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key) && same_value(left[key], right[key]));
}
/**
 * A computed that keeps its previous value while a recompute yields the same data. Every publish hands over a new view
 * snapshot, so derived Maps and arrays are rebuilt even when the room has not changed; keeping the old reference lets the
 * transcript's v-memo hit instead of re-rendering every card.
 */
const stable_computed = (getter) => computed((previous) => {
  const next = getter();
  return previous !== undefined && same_value(previous, next) ? previous : next;
});
const can_manage = computed(() => Boolean(view.value.access?.can_manage));
const speaking_turn = computed(() => ["pending", "notified"].includes(room.value?.current_turn?.status)
  && !["paused", "concluded"].includes(room.value.phase) ? room.value.current_turn : null);
const is_manual_member = (member) => member?.access === "manual" && member.status === "active";
const speaking_member = computed(() => (room.value.members || []).find((member) => member.name === speaking_turn.value?.expert));
// Invited manual experts that have not registered yet; each keeps its own notice until it does.
const unregistered_members = computed(() => room.value?.archived ? []
  : (room.value?.members || []).filter(awaiting_member));
const queue_hint = computed(() => {
  const member = speaking_member.value;
  if (!speaking_turn.value || !member) return "";
  const name = bridge.display_name(member.name);
  if (is_manual_member(member)) return member.registered_at ? t('{value1} 是手动启动，轮到它时需到其 AI 会话触发；不接入可在进度看板点「跳过」本次发言', { value1: name }) : "";
  return text.value.trim() ? t('新消息会在 {value1} 回复后交给主持人；可在进度看板点「跳过」本次发言', { value1: name }) : "";
});
const free = computed(() => !["active", "paused"].includes(room.value?.session?.status));
/**
 * The room view lists only recent executions, plans, missed turns and decisions; older ones come with the transcript
 * (`view.history_cards`). Cards read from both: the room view's copy wins, being the newer one.
 */
function with_history(kind, recent) {
  const items = new Map((view.value.history_cards?.[kind] || []).map((item) => [item.key || item.id, item]));
  for (const item of recent || []) items.set(item.key || item.id, item);
  return [...items.values()];
}
const all_executions = computed(() => with_history("executions", room.value.free?.executions));
const all_decisions = computed(() => with_history("scheduler_decisions", room.value.scheduler_decisions));
const all_arrangements = computed(() => with_history("host_arrangements", room.value.host_arrangements));
const all_cancelled_turns = computed(() => with_history("cancelled_turns", room.value.cancelled_turns));
/** What the runner last saw a member's software doing; unknown phases keep the generic text. Declared before `free_busy`, which an immediate watch reads during setup. */
const ACTIVITY_LABELS = { thinking: t('思考中'), command: t('正在运行命令'), tool: t('正在调用工具'), editing: t('正在修改文件'), writing: t('正在撰写回答') };
/** All room work uses member executions; queued requests stay in the side panel. */
const free_busy = computed(() => {
  if (room.value.archived) return [];
  const reports = new Map((room.value.free?.executions || []).map((execution) => [execution.id, execution]));
  return (room.value.free?.members || []).flatMap((member) => {
    const execution = member.execution;
    if (execution && ["dispatched", "started"].includes(execution.status)) {
      // The delivery did not take (a manual session refused it, or the software failed before starting) and the runner
      // waits to deliver again; once it does, `attempt` keeps which retry is running.
      const retry = execution.retry?.retry_at && !execution.retry.stopped ? execution.retry : null;
      const attempt = !retry && !execution.retry?.stopped ? execution.retry?.attempt || 0 : 0;
      return [{ id: `free-${execution.id}`, author: member.name, member_id: member.id, retry, attempt,
        text: execution.stale ? t('执行失联：网站已不再接受本次回答，软件停止未确认') : retry ? t('投递未成功，等待自动重试')
          : execution.paused_at ? t('已在私聊中暂停，等你补充后接着做') : ACTIVITY_LABELS[execution.activity] || t('正在处理'),
        paused: Boolean(execution.paused_at), working: !execution.stale && !retry, created_at: execution.created_at, adapter: member.adapter, capabilities: execution.capabilities,
        activity: execution.activity, activity_at: execution.activity_at, notes: execution.notes || 0, steps: execution.steps || 0,
        execution_id: execution.id, request_message_id: reports.get(execution.id)?.request_message_id, layout_after: reports.get(execution.id)?.layout_after,
        layout_at: reports.get(execution.id)?.layout_at ?? execution.created_at, background: Boolean(reports.get(execution.id)?.background),
        discussion_request: reports.get(execution.id)?.requests?.find((request) => request.discussion_session_id) }];
    }
    return [];
  }).sort((left, right) => (left.created_at ?? Infinity) - (right.created_at ?? Infinity));
});
const free_now = ref(Math.floor(Date.now() / 1000));
/** Each busy member keeps its own working card, so the elapsed time ticks while any is shown. */
watch(() => free_busy.value.length > 0, (busy, _previous, cleanup) => {
  if (!busy) return;
  free_now.value = Math.floor(Date.now() / 1000);
  const timer = setInterval(() => { free_now.value = Math.floor(Date.now() / 1000); }, 1000);
  cleanup(() => clearInterval(timer));
}, { immediate: true });
const free_working = computed(() => view.value.query ? [] : free_busy.value);
/** Progress notes per execution id; only counts come with the room, so texts are read when a card shows more or a fold opens. */
const execution_notes = ref(new Map());
/** Late text is owner-only and fetched only when its fold opens; never cache it across rooms or loss of access. */
const late_answers = ref(new Map());
watch(() => [room.value.id, view.value.access?.can_manage], () => { late_answers.value = new Map(); });
async function load_late_answer(execution_id, event) {
  if (!event.target.open || !view.value.access?.can_manage || late_answers.value.has(execution_id)) return;
  const room_id = room.value.id;
  late_answers.value = new Map(late_answers.value).set(execution_id, null);
  try {
    const answer = await bridge.request(`/api/rooms/${room_id}/executions/${execution_id}/late-answer`);
    if (room.value.id === room_id && view.value.access?.can_manage) late_answers.value = new Map(late_answers.value).set(execution_id, answer);
  } catch (error) {
    if (room.value.id !== room_id) return;
    late_answers.value.delete(execution_id);
    event.target.open = false;
    bridge.notify("error", t('未采纳的回答读取失败：{value1}', { value1: error.message }));
  }
}
/** Notes read so far for a working item's execution. */
function working_notes(message) {
  return execution_notes.value.get(message.execution_id) || [];
}
async function load_notes(execution_id) {
  const room_id = room.value.id;
  try {
    const { notes } = await bridge.request(`/api/rooms/${room_id}/executions/${execution_id}/notes`);
    if (room.value.id === room_id) execution_notes.value = new Map(execution_notes.value).set(execution_id, notes);
  } catch (error) { return error.message || t('过程说明读取失败'); }
}
/** Execution ids whose working notes are unfolded; folded by default to the latest note. */
const open_working_notes = ref(new Set());
function toggle_working_notes(execution_id) {
  const open = new Set(open_working_notes.value);
  if (!open.delete(execution_id)) open.add(execution_id);
  open_working_notes.value = open;
}
watch(() => free_busy.value.map((item) => `${item.execution_id}:${item.notes}`).join(), () => {
  for (const item of free_busy.value) {
    if (item.working && item.notes > (execution_notes.value.get(item.execution_id)?.length || 0)) load_notes(item.execution_id);
  }
}, { immediate: true });
/** The execution that delivered an answer, when the room still lists it. */
function answer_execution(message) {
  return all_executions.value.find((item) => item.answer_id === message.id);
}
/**
 * The working card's one status line: the phase while output keeps coming, a warning only after a long silence.
 * Silence while a command runs is expected, so it is named as such instead of a possible hang.
 */
function working_status(message) {
  // Data shown after the page was hidden or offline may be old; silence counts only up to when it was last current.
  const observed = view.value.observed_until ? Math.min(free_now.value, Math.floor(view.value.observed_until / 1000)) : free_now.value;
  const silent = Math.max(0, observed - (message.activity_at || message.created_at));
  // Paused from the private chat: its software is stopped on purpose, so the silence is no hang.
  if (message.paused) return { text: message.text, live: false };
  if (!message.working || !shows_progress(message) || silent < STALL_SECONDS) return { text: message.text, live: message.working };
  if (message.activity === "command") return { text: t('命令已运行 {value1}', { value1: format_elapsed(silent) }), live: true };
  // Deep reasoning reports nothing until it ends; only a much longer silence there suggests a hang.
  if (message.activity === "thinking" && silent < THINKING_STALL_SECONDS) return { text: t('思考中，已 {value1}无中间输出', { value1: format_elapsed(silent) }), live: true };
  return { text: t('已 {value1}无输出，可能卡住', { value1: format_elapsed(silent) }), live: false, warning: true };
}
// A relay stopped at a user gate takes the owner's next unaddressed message as the owner's step.
const relay_waits_owner = computed(() => free.value && Boolean(room.value?.speaking_order?.sequence?.waiting_user));
/** Says in the note line who the draft will reach: the @mentioned members, else the host. */
const recipient_hint = computed(() => {
  const named_group = (aliases) => aliases.some((alias) => MENTION_PATTERN(alias).test(draft_prose.value));
  if (free.value && named_group(SEQUENTIAL_ALIASES)) return t('依次发给 {value1}，前一位结束后下一位开始', { value1: in_turn(free_members.value).map((member) => bridge.display_name(member.name)).join(" → ") });
  if (free.value && named_group(ALL_ALIASES)) return t('发给 {value1}', { value1: free_members.value.map((member) => bridge.display_name(member.name)).join("、") });
  const named = free_members.value.filter((member) => MENTION_PATTERN(member.name).test(draft_prose.value));
  if (named.length) return free.value ? t('{value1}发给 {value2}', { value1: named.length > 1 ? t('同时') : "", value2: named.map((member) => bridge.display_name(member.name)).join("、") })
    : t('直接提问 {value1}，不计讨论轮次；同一成员完成当前执行后回答', { value1: named.map((member) => bridge.display_name(member.name)).join("、") });
  if (free_members.value.length === 1) return t('发给 {value1}', { value1: bridge.display_name(free_members.value[0].name) });
  if (relay_waits_owner.value && free_host.value) return t('接力在等你回答上方的问题卡；这条消息只发给主持人 {value1}', { value1: bridge.display_name(free_host.value.name) });
  return free_host.value ? t('发给主持人 {value1}；@ 其他成员让它们发言', { value1: bridge.display_name(free_host.value.name) }) : t('未 @ 任何成员：只作留言，不会唤醒 AI');
});
/** Project files picked after @: their @path stays in the draft, and they also show as cards and go out as a trailing line of paths (code-quoted, so they never wake a member). */
const file_refs = ref([]);
// Each room keeps its unsent file cards and quoted passages while another room is open, as its text is kept (app.js
// `room_composer_drafts`), until this page closes.
const room_quotes = new Map();
watch(() => room.value?.id, (next, previous) => {
  if (previous && (file_refs.value.length || file_preview.excerpts.length)) room_quotes.set(previous, { refs: file_refs.value, excerpts: file_preview.excerpts });
  else if (previous) room_quotes.delete(previous);
  const kept = next && room_quotes.get(next);
  if (kept) room_quotes.delete(next);
  file_refs.value = kept?.refs || [];
  file_preview.excerpts = kept?.excerpts || [];
});
const file_refs_line = () => file_refs.value.length
  ? t('引用文件：{value1}', { value1: file_refs.value.map((ref) => `\`${ref.path}${ref.kind === "directory" ? "/" : ""}\``).join("、") }) : "";
// Passages quoted from the file preview ("添加到对话") wait as cards and go out after the text, each as a quote with its comment.
const excerpts = computed(() => file_preview.excerpts);
const has_draft = computed(() => Boolean(text.value.trim() || view.value.attachment_drafts.length || file_refs.value.length || excerpts.value.length));
watch(() => file_preview.focus_composer, () => nextTick(() => prompt.value?.textareaRef?.focus()));
// Editing a queued message takes it off the queue into the composer; the caret goes to its end so typing continues it.
watch(() => view.value.queued_taken, (count) => count && nextTick(() => {
  const area = prompt.value?.textareaRef;
  area?.focus();
  area?.setSelectionRange(area.value.length, area.value.length);
}));
/** Drop one excerpt from the draft. */
function remove_excerpt(excerpt) { file_preview.excerpts = file_preview.excerpts.filter((item) => item.id !== excerpt.id); }
// The excerpt whose comment is being edited in the composer's excerpt list.
const editing_excerpt = ref(0);
/** Active members a free-room message can name; chips appear only when there is a choice. */
const free_members = computed(() => (room.value.free?.members || []).filter((member) => member.status === "active" && !awaiting_member(member)));
const free_host = computed(() => free_members.value.find((member) => member.role === "host"));
/** In a discussion, an @mention of an active member is a direct question: it wakes that member outside turns, rounds and limits. */
const mention_pool = computed(() => [...(mention_all.value ? [...ALL_ALIASES, ...SEQUENTIAL_ALIASES].map((name) => ({ name })) : []), ...free_members.value]);
/** A draft @mentions a member only outside code and quotes. */
const MENTION_PATTERN = (name) => new RegExp(`(^|[\\s(（，,。；;：:])@${name}(?![\\w-])`, "u");
const draft_prose = computed(() => text.value.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "").replace(/^>.*$/gm, ""));
const SCHEDULER_LABELS = { jev: "TypeSafe Jev", decisions: "OpenAI Decisions" };
/** What the runner can do with how an execution reached its member's software: stop it, see its progress. */
const capabilities = (item) => item.capabilities || null;
/** Whether the runner can show this work's progress; until it reports, the page assumes it can. */
const shows_progress = (item) => capabilities(item)?.progress !== false;
/**
 * A voided execution as it really went: stopped once the runner ended its process; still stopping until it reports;
 * voided only, when it works in a window or App the runner cannot stop (`.dev/docs/Design_适配能力.md`).
 */
/** A stop's recorded reason as the card says it; records made before the wording changed keep their old text. */
const stop_reason_text = (result) => result === "用户立即发送" ? t("已打断：你立即发送了新消息，它会连同这条一起处理") : result;
/** The voided execution whose stop has more to say (still generating, a late answer), or null. */
function voided_detail(message) {
  const execution = message.cancelled_execution || all_executions.value.find((item) => item.id === message.execution_id);
  return execution && stop_state(execution).note ? execution : null;
}
function stop_state(execution) {
  const label = bridge.stop_label(execution);
  const name = bridge.display_name(execution.member);
  // A late answer shows the member did finish the turn; it stays out of the transcript and AI reads.
  if (execution.late_answer) return { label, note: t('{value1} 之后仍交来了回答，未采纳：不进入记录，其他 AI 读不到。', { value1: name }) };
  if (execution.stop_result === "unconfirmed") return { label, note: t('本机尚未确认进程结束，可能仍在生成；网站不再接受本次回答。') };
  if (execution.stop_result === "unstoppable" || capabilities(execution)?.stoppable === false) return { label, note: t('{value1} 在自己的窗口或 App 里，本机无法停止，可能仍在生成；网站不再接受本次回答。', { value1: name }) };
  return { label, note: label === t('正在停止') ? t('等待本机服务结束进程。') : "" };
}
// The runner retries a delivery that did not take this many times (runner/free_runner.mjs MAX_DELIVERY_RETRIES).
const MAX_DELIVERY_RETRIES = 3;
/** Long reasoning or a long reply can be silent for minutes; beyond this the card only warns, never stops. */
const STALL_SECONDS = 180;
/** Thinking emits no events until it ends (gpt xhigh was seen silent for 4 min), so it warns only after this long. */
const THINKING_STALL_SECONDS = 600;
const FREE_REQUEST_LABELS = { pending: [t('等待中'), "neutral"], delivering: [t('投递中'), "info"], completed: [t('已回答'), "success"],
  cancelled: [t('已取消'), "neutral"], failed: [t('失败'), "error"] };
const REQUEST_CANCEL_REASONS = { user_stop: t('用户停止'), member_away: t('成员暂离'), member_removed: t('成员移除'), rerouted: t('改派'), no_reply: t('未回复'), archived: t('房间归档') };
/** Each user message in a free room shows what happened to its request for every named member. */
const request_badges = stable_computed(() => {
  const badges = new Map();
  const source = room.value.free;
  if (!source) return badges;
  const executions = new Map((source.executions || []).map((execution) => [execution.id, execution]));
  const failures = new Map((source.executions || []).map((execution) => [execution.id, execution.result]));
  for (const request of source.requests || []) {
    // A request voided after reaching the software reads as its stop really went; one never delivered was only cancelled.
    const voided = request.status === "cancelled" && executions.get(request.execution_id)?.capabilities ? executions.get(request.execution_id) : null;
    // An external member's computer turned the request down or let it wait out: the other side did not agree.
    let [label, color] = declined(request) ? [t('对方未同意'), "warning"] : voided ? [stop_state(voided).label, "neutral"] : FREE_REQUEST_LABELS[request.status];
    const execution = executions.get(request.execution_id);
    if (request.status === "delivering" && execution?.status === "started") label = t('处理中');
    if (request.status === "pending" && (source.executions || []).some((item) => item.member === request.member && ["dispatched", "started"].includes(item.status))) label = t('等待中：等当前执行结束');
    const title = declined(request) ? (request.external_outcome === "timeout" ? t('对方电脑在时限内没有确认唤醒') : t('对方电脑拒绝了这次唤醒'))
      : request.status === "failed" ? failures.get(request.execution_id) || t('执行失败') : REQUEST_CANCEL_REASONS[request.cancel_reason] || request.cancel_reason || "";
    const answer_execution = (source.executions || []).find((item) => item.answer_id === request.answer_id);
    const answer_label = request.answer_id ? (answer_execution && answer_execution.request_message_id !== request.message_id
      ? t('在 #{id} 一并回答', { id: request.answer_id }) : t('查看回答 #{id}', { id: request.answer_id })) : "";
    badges.set(request.message_id, [...(badges.get(request.message_id) || []),
      { key: request.id, label: `${bridge.display_name(request.member)} · ${label}`, color, title, answer_id: request.answer_id, answer_label }]);
  }
  return badges;
});
/** Attach each terminal execution to its answer, or to the original request when it has no answer. */
const execution_reports = stable_computed(() => {
  const reports = new Map();
  if (!room.value.free) return reports;
  for (const execution of all_executions.value) {
    if (!["completed", "failed", "cancelled"].includes(execution.status)) continue;
    // A clean completion adds nothing to the message header; only failures, observed file changes and refused operations earn a card.
    if (execution.status === "completed" && !execution.changes?.length && !execution.denials?.length) continue;
    // A failed free-room execution keeps its own card in the slot it worked in, and so does a delivered one that was voided.
    if (execution.status === "failed" || (execution.status === "cancelled" && execution.capabilities)) continue;
    const message_id = execution.answer_id || execution.request_message_id;
    const report = { ...execution, label: execution.status === "cancelled" ? bridge.stop_label(execution) : { completed: t('已完成'), failed: t('失败') }[execution.status] };
    reports.set(message_id, [...(reports.get(message_id) || []), report]);
  }
  return reports;
});
/** A user's message is waiting for the host while it is at or after the relay hold. */
const waits_for_host = (message) => message.author === "用户" && room.value?.held_since > 0 && message.id >= room.value.held_since;
/** Smart scheduling's recommendations count down from when the room view arrived; an expired open one disappears. */
const recommendation_clock = ref(Date.now());
const recommendation_received = ref(Date.now());
watch(() => room.value.free?.recommendations, () => { recommendation_received.value = recommendation_clock.value = Date.now(); });
const adopting = ref(0);
const recommendations = stable_computed(() => {
  const rows = new Map();
  if (!free.value) return rows;
  const elapsed = Math.floor((recommendation_clock.value - recommendation_received.value) / 1000);
  const routes = new Map((room.value.free?.requests || []).filter((request) => request.purpose === "route").map((request) => [request.message_id, request]));
  for (const item of room.value.free?.recommendations || []) {
    const remaining = item.expires_in - elapsed;
    // Only an open fallback shows here; an applied decision is shown by its decision card.
    if (item.status !== "open" || remaining <= 0) continue;
    const host_busy = ["pending", "delivering"].includes(routes.get(item.message_id)?.status);
    rows.set(item.message_id, { ...item, remaining, host_busy, label: SCHEDULER_LABELS[item.provider] || item.provider,
      can_adopt: item.status === "open" && view.value.access?.can_manage && !room.value.archived && !pending.value });
  }
  return rows;
});
// Tick only while an open recommendation is counting down.
const recommendation_timer = window.setInterval(() => {
  if ((room.value.free?.recommendations || []).some((item) => item.status === "open")) recommendation_clock.value = Date.now();
}, 1000);
onBeforeUnmount(() => window.clearInterval(recommendation_timer));
/** Adopt with the chosen timing; a finished host leaves only "ask now", sent as mode after. */
/** A scheduler call's milliseconds: sub-second calls stay in milliseconds, longer ones use the shared format; missing timing stays empty. */
function format_ms(ms) {
  if (ms == null) return "";
  return ms < 1000 ? t('{value1}毫秒', { value1: ms }) : ms < 10_000 ? t('{value1}秒', { value1: (ms / 1000).toFixed(1) }) : format_elapsed(Math.round(ms / 1000));
}
/** In a discussion, each smart-scheduling decision shows under the message it followed. */
const scheduler_decisions = stable_computed(() => {
  const rows = new Map();
  for (const item of all_decisions.value) {
    // A skip asked the model nothing (no confidence, nothing applied, no question), so there is no decision to show.
    if (item.confidence === null && !item.applied && !item.detail?.length) continue;
    rows.set(item.after_message_id, [...(rows.get(item.after_message_id) || []),
      { ...item, provider_label: SCHEDULER_LABELS[item.provider] || item.provider, duration: format_ms(item.detail?.[0]?.duration_ms),
        title: `${SCHEDULER_LABELS[item.provider] || item.provider}${item.confidence === null ? "" : t('，置信度 {value1}', { value1: Number(item.confidence).toFixed(2) })}` }]);
  }
  return rows;
});
/** Messages the local service is still analysing; the card gives way once the decision is recorded. */
const routing_messages = stable_computed(() => new Set([...(room.value.scheduler_routing || []), ...pending_routing.value]));
// A message the room's scheduler will judge shows its "analysing" card the moment it is sent, under the sending card and
// then under the saved one, instead of once the local service has picked it up; the decision then takes its place, and a
// card nothing answers within ROUTING_PREVIEW_MS folds away. A queued message shows it once it is really sent.
const ROUTING_PREVIEW_MS = 30000;
const pending_routing = ref(new Set());
/** Whether the scheduler judges this text: on for the room, several members, nobody @named and not a command. */
function routes_by_scheduler(text) {
  if (!free.value || !view.value.launch?.room_models?.scheduler || free_members.value.length < 2 || /^\s*\//.test(text || "")) return false;
  const prose = String(text || "").replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "").replace(/^>.*$/gm, "");
  return ![...ALL_ALIASES, ...SEQUENTIAL_ALIASES, ...free_members.value.map((member) => member.name)].some((name) => MENTION_PATTERN(name).test(prose));
}
// Only once the files are in and the message itself is on its way: a card for a message still uploading, or retrying
// after a dropped send, would claim analysis the site has not started.
const sending_routes = computed(() => Boolean(view.value.sending_preview) && !sending_uploads.value && !view.value.sending_preview.retrying
  && routes_by_scheduler(view.value.sending_preview.text));
watch(() => view.value.sending_preview?.saved_id, (id) => {
  if (!id || !sending_routes.value) return;
  pending_routing.value = new Set([...pending_routing.value, id]);
  setTimeout(() => { const next = new Set(pending_routing.value); next.delete(id); pending_routing.value = next; }, ROUTING_PREVIEW_MS);
});
/** The host's own plans stand beside the decisions, under the message they followed. */
const host_arrangements = stable_computed(() => {
  const rows = new Map();
  if (view.value.query) return rows;
  for (const item of all_arrangements.value) {
    rows.set(item.after_message_id, [...(rows.get(item.after_message_id) || []),
      { ...item, label: item.turns.map((turn) => bridge.display_name(turn.expert)).join(" → ") }]);
  }
  return rows;
});
function adopt(message_id, mode) {
  adopting.value = 0;
  act("adopt_recommendation", { message_id, mode });
}
/** Format recorded seconds consistently; missing timing is never estimated. */
function format_elapsed(seconds) {
  if (seconds == null) return "—";
  if (seconds < 60) return t('{value1}秒', { value1: seconds });
  if (seconds < 3600) return t('{value1}分{value2}秒', { value1: Math.floor(seconds / 60), value2: String(seconds % 60).padStart(2, "0") });
  return t('{value1}小时{value2}分{value3}秒', { value1: Math.floor(seconds / 3600), value2: Math.floor((seconds % 3600) / 60), value3: String(seconds % 60).padStart(2, "0") });
}
/** The host's arrangement time: from the answer it followed to the moment the plan was saved. */
function arrangement_seconds(plan, anchor) {
  const seconds = Math.round((new Date(plan.created_at) - new Date(anchor.created_at)) / 1000);
  return Number.isFinite(seconds) ? Math.max(0, seconds) : null;
}
/** A reply's recorded time: the discussion turn's timing, or in a free room the execution that delivered it. */
function message_elapsed(message) {
  if (message.elapsed_seconds != null) return message.elapsed_seconds;
  // Read every execution, not the reports: a clean completion earns no report card but still has its time.
  const execution = all_executions.value.find((item) => item.answer_id === message.id);
  return execution?.created_at && execution.finished_at ? Math.max(0, execution.finished_at - execution.created_at) : null;
}
const date_formatter = new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "long" });

const blank = (match) => " ".repeat(match.length);
/**
 * Paint the @mentions that will wake a member, and the files' [图片 #n] tags, behind the transparent editor text; code
 * and quotes do not count as mentions.
 */
const mention_mirror = computed(() => token_mirror(text.value, view.value.attachment_drafts, mention_spans(text.value)));
function mention_spans(value) {
  if (!mention_pool.value.length || !value.includes("@")) return [];
  // Masking keeps every offset, so matches in the masked copy point at the same characters of the draft.
  const masked = value.replace(/```[\s\S]*?```/g, blank).replace(/`[^`\n]*`/g, blank).replace(/^>.*$/gm, blank);
  const names = free_members.value.map((member) => member.name);
  // Longest handle first, and a span already highlighted is not highlighted again by a shorter handle inside it.
  const handles = mention_pool.value.flatMap(({ name }) => names.includes(name) ? bridge.mention_handles(name, names) : [name])
    .sort((left, right) => right.length - left.length);
  const taken = [];
  for (const name of handles) for (const match of masked.matchAll(new RegExp(MENTION_PATTERN(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).source, "gu"))) {
    const span = [match.index + match[1].length, match.index + match[0].length];
    if (!taken.some(([start, end]) => span[0] < end && start < span[1])) taken.push(span);
  }
  return taken.map(([start, end]) => [start, end, "channel-mention"]);
}
const mirror = ref(null);
/** Keep the painted copy at the editor's scroll position. */
function sync_mirror() {
  if (mirror.value && prompt.value?.textareaRef) mirror.value.scrollTop = prompt.value.textareaRef.scrollTop;
}
// Text measured to find how far the browser insets a textarea's text on each side (iOS WebKit has used 3px).
const INSET_SAMPLE = "MMMMMMMMMMMMMMMMMMMM";
const MAX_TEXT_INSET = 8;
/**
 * The textarea's own inset of its text on each side, measured: an unwrapped probe scrolls exactly as wide as the text
 * plus both insets. A mirror narrower or wider than the transparent text wraps a character apart and the caret lands
 * beside the painted word (user 2026-11-17, iPhone); the fixed 3px guess in channel.css stays when this cannot tell.
 */
function measure_text_inset(editor) {
  const style = getComputedStyle(editor);
  const shared = { position: "absolute", visibility: "hidden", left: "-9999px", top: "0", font: style.font, letterSpacing: style.letterSpacing, whiteSpace: "pre" };
  const probe = document.createElement("textarea"), text = document.createElement("span");
  probe.setAttribute("wrap", "off");
  Object.assign(probe.style, shared, { width: "20px", height: "40px", padding: "0", border: "0", overflow: "scroll" });
  probe.value = text.textContent = INSET_SAMPLE;
  Object.assign(text.style, shared);
  document.body.append(probe, text);
  const inset = (probe.scrollWidth - text.getBoundingClientRect().width) / 2;
  probe.remove(); text.remove();
  // scrollWidth is whole pixels, so a browser without an inset can measure a fraction below zero.
  return inset > -1 && inset <= MAX_TEXT_INSET ? Math.max(0, Math.round(inset)) : null;
}
watch(mirror, (element) => {
  const editor = prompt.value?.textareaRef;
  const inset = element && editor ? measure_text_inset(editor) : null;
  if (inset !== null) element.style.insetInline = `${inset}px`;
});
// Creating the watch evaluates the mirror, which reads mention declarations further down; wait until setup has run them.
onMounted(() => watch(mention_mirror, () => nextTick(sync_mirror), { flush: "post" }));

const mention_context = ref(null);
/** @全体成员 (or @all) names every member a free-room message can reach, offered once there is more than one; smart scheduling decides whether they answer at once or in turn. */
const ALL_MENTION = "全体成员";
const ALL_ALIASES = [ALL_MENTION, "all"];
/** @全体依次 (or @all-seq) answers one after another in the room's speaking order without smart scheduling. */
const SEQUENTIAL_MENTION = "全体依次";
const SEQUENTIAL_ALIASES = [SEQUENTIAL_MENTION, "all-seq"];
const GROUP_MENTIONS = {
  [ALL_MENTION]: { search: "all 同时", icon: "i-lucide-users" },
  [SEQUENTIAL_MENTION]: { search: "all-seq 顺序 依次", icon: "i-lucide-list-ordered" },
};
/** The order the server asks members in: the room's default speaking order. */
const in_turn = (members) => {
  const rank = room.value.speaking_order?.default || [];
  const place = (name) => rank.includes(name) ? rank.indexOf(name) : rank.length;
  return [...members].sort((left, right) => place(left.name) - place(right.name));
};
const mention_all = computed(() => free.value && free_members.value.length > 1);
const mention_index = ref(null);
const mention_list = ref(null);
let mention_composing = false;
const mention_members = computed(() => {
  if (mention_context.value?.command) return [];
  const names = [...(mention_all.value ? Object.keys(GROUP_MENTIONS) : []), ...free_members.value.map(member => member.name)];
  const query = mention_context.value?.query.toLocaleLowerCase() || "";
  return names.filter(name => (GROUP_MENTIONS[name] ? `${name} ${GROUP_MENTIONS[name].search}` : `${name} ${bridge.display_name(name)}`).toLocaleLowerCase().includes(query));
});
/**
 * Files under the room's project directory follow the members. A bare @ lists the project root, a keyword searches
 * names across the whole project on the paired computer, and a "/" browses that folder one level at a time.
 */
const MENTION_FILE_LIMIT = 50;
const MENTION_SEARCH_DELAY_MS = 150;
const project_directory = computed(() => view.value.launch?.room_models?.room_id === room.value?.id ? view.value.launch.room_models?.project_directory || "" : "");
const mention_results = ref({});
const mention_folder = computed(() => {
  const query = mention_context.value?.query;
  if (query == null || mention_context.value.command || !project_directory.value) return null;
  const slash = query.lastIndexOf("/");
  if (slash < 0 && query) return { key: `find:${query.toLocaleLowerCase()}`, search: query, filter: "" };
  const path = slash < 0 ? "" : query.slice(0, slash).split("/").filter((part) => part && part !== ".").join("/");
  return { key: `dir:${path}`, path, filter: query.slice(slash + 1).toLocaleLowerCase() };
});
/**
 * A search also finds names in the room's other project directories (`root` > 0). Such an entry is referenced by its
 * full path, which cannot be typed after @, so it is picked whole as a card and never browsed.
 */
function in_extra_directory(entry) {
  const directory = entry.root ? view.value.launch.room_models?.extra_directories?.[entry.root - 1] : "";
  if (!directory) return entry;
  const separator = directory.includes("\\") ? "\\" : "/";
  return { ...entry, path: `${directory.replace(/[\\/]+$/, "")}${separator}${entry.path.split("/").join(separator)}`, absolute: true };
}
let mention_search_timer = 0;
let mention_pending = "";
// Keys read since the popup opened. Older results stay on screen while they are read again, so the popup keeps its
// height instead of growing once the files arrive.
const mention_fresh = new Set();
/** Read one folder or search into the results; `delay` waits for a pause in typing. */
function load_mention_folder(folder, delay = 0) {
  const { key } = folder;
  const room_id = room.value.id;
  mention_fresh.add(key);
  mention_pending = key;
  if (!(key in mention_results.value)) mention_results.value = { ...mention_results.value, [key]: null };
  mention_search_timer = setTimeout(async () => {
    mention_pending = "";
    let entries = [];
    try {
      const result = await bridge.read_room_files(room_id, folder.path || "", 0, folder.search || "");
      if (["directory", "search"].includes(result.kind)) entries = result.entries.filter((entry) => entry.kind !== "unavailable").map(in_extra_directory);
    } catch { /* An unreadable folder or failed search simply offers no files. */ }
    if (room.value?.id === room_id && key in mention_results.value) mention_results.value = { ...mention_results.value, [key]: entries };
  }, delay);
}
watch(() => mention_folder.value?.key, (key) => {
  clearTimeout(mention_search_timer);
  // A lookup cancelled before it started is forgotten, so returning to it reads again instead of loading forever.
  if (mention_pending) {
    mention_fresh.delete(mention_pending);
    if (mention_results.value[mention_pending] === null) {
      const { [mention_pending]: _cancelled, ...kept } = mention_results.value;
      mention_results.value = kept;
    }
    mention_pending = "";
  }
  const folder = mention_folder.value;
  // Searching walks the whole project, so it waits for a pause in typing; a folder is read at once.
  if (key && !mention_fresh.has(key)) load_mention_folder(folder, folder.search ? MENTION_SEARCH_DELAY_MS : 0);
});
// Read again each time the popup opens so new files appear.
watch(() => !!mention_context.value, (open) => { if (!open) mention_fresh.clear(); });
// Another room's files never show; its project root is read ahead so the first @ opens at full height.
watch([() => room.value?.id, project_directory], () => {
  mention_results.value = {};
  mention_fresh.clear();
  if (project_directory.value && !mention_context.value) {
    load_mention_folder({ key: "dir:", path: "", filter: "" });
    mention_fresh.clear();
  }
}, { immediate: true });
const mention_files = computed(() => {
  const folder = mention_folder.value;
  return (folder && mention_results.value[folder.key] || [])
    .filter((entry) => entry.name !== ".git" && entry.name.toLocaleLowerCase().includes(folder.filter)).slice(0, MENTION_FILE_LIMIT);
});
/** The file group's heading names where its entries come from: the project root, a search, or the folder being browsed. */
const mention_files_group = computed(() => {
  const folder = mention_folder.value;
  return !folder ? "" : folder.search ? t('项目文件 · 搜索结果') : folder.path ? t('项目文件 · {value1}/', { value1: folder.path }) : t('项目文件');
});
const mention_files_loading = computed(() => !!mention_folder.value && mention_results.value[mention_folder.value.key] === null);
/** Inside a folder, its first option references the folder itself; the others browse or pick its entries. */
const mention_folder_self = computed(() => {
  const folder = mention_folder.value;
  if (!folder?.path || folder.filter || !mention_results.value[folder.key]) return [];
  return [{ key: `self:${folder.path}`, self: true, entry: { kind: "directory", name: folder.path.split("/").at(-1), path: folder.path } }];
});
/**
 * A "/" opening the draft offers the platform's saved workflows. Picking one only prefills a request to the host, who
 * enables it and brings its members; that needs the owner's per-room "主持人完整权限".
 */
const room_models = computed(() => view.value.launch?.room_models?.room_id === room.value?.id ? view.value.launch.room_models : null);
const room_workflow = computed(() => room_models.value ? active_workflow(room_models.value.workflow, room.value?.free?.members) : null);
const can_pick_workflow = computed(() => free.value && !room.value?.archived && view.value.access?.can_manage && (view.value.launch.available || view.value.launch.remote));
const workflow_blocked = computed(() => !free_members.value.some((member) => member.role === "host" && member.access === "runner")
  ? t('需要一位由本机唤醒的 AI 主持人')
  : !room_models.value?.host_workflows ? t('需先在电脑上的“成员与设置 → 协作设置”打开“主持人完整权限”') : "");
const workflow_options = computed(() => {
  const query = mention_context.value?.query.toLocaleLowerCase() || "";
  // A workflow that cannot run here stays listed with its reason, but cannot be picked.
  return (view.value.launch.workflows || []).filter((item) => !item.disabled && `${item.id} ${item.label} ${item.description || ""}`.toLocaleLowerCase().includes(query))
    .map((item) => {
      const problem = workflow_problem(item);
      return { key: `workflow:${item.id}`, workflow: item, group: t('工作流'), enabled: room_workflow.value?.id === item.id, broken: Boolean(problem), disabled: problem || workflow_blocked.value };
    });
});
/**
 * Platform skills a user may call with an unaddressed "/". Picking one only inserts `$id` (rendered as a skill tag, see markdown.mjs) and adds no
 * wording of its own: what to do is the user's to write. It brings no member.
 */
const PLATFORM_SKILL_COMMANDS = [
  { id: "workflow-creator", label: t('新建 / 修改工作流'), search: "workflow creator 新建 创建 修改 工作流",
    description: t('请主持人按 workflow-creator 技能写工作流'), prompt: "$workflow-creator " },
];
const can_call_skill = computed(() => free.value && !room.value?.archived && free_members.value.some((member) => member.role === "host"));
/**
 * Built-in modes come first in "/": they change how the room moves forward, unlike workflows and skills. Picking one
 * only writes its command into the draft; sending it is the owner's decision, and the website checks it again.
 */
const can_use_modes = computed(() => free.value && !room.value?.archived && view.value.access?.can_manage);
const mode_options = computed(() => {
  // Modes are only recognised as the start of a message.
  if (!can_use_modes.value || mention_context.value?.start) return [];
  const goal = ["active", "paused"].includes(room.value?.goal_state?.goal?.status) ? room.value.goal_state.goal : null;
  const session = ["active", "paused"].includes(room.value?.session?.status) ? room.value.session : null;
  const host_ready = free_members.value.some((member) => member.role === "host" && member.access === "runner");
  const blocked = !host_ready ? t('需要一位由本机唤醒的 AI 主持人') : "";
  const items = goal ? [
    goal.status === "active" ? { command: "/goal pause", label: t('暂停 Goal'), description: t('房间空闲时不再唤醒主持人') }
      : { command: "/goal resume", label: t('继续 Goal'), description: t('继续推进，房间空闲时唤醒主持人') },
    { command: "/goal edit ", label: t('修改 Goal 目标'), description: t('在后面写新的目标') },
    { command: "/goal clear", label: t('结束 Goal'), description: t('主持人不再自动推进，记录保留') },
  ] : session ? [
    session.status === "active" ? { command: "/discuss pause", label: t('暂停讨论'), description: t('停止讨论中的执行，继续后由主持人重新安排') }
      : { command: "/discuss resume", label: t('继续讨论'), description: t('由主持人检查队列并继续') },
    { command: "/discuss stop", label: t('结束讨论'), description: t('记录与结论保留') },
  ] : [
    { command: "/goal ", label: "Goal", description: blocked || t('设定目标，主持人持续推进；房间空闲时自动接着做'), disabled: blocked },
    { command: "/discuss ", label: t('讨论'), description: blocked || t('主持人安排成员轮流发言，到上限或结束时停止'), disabled: blocked },
  ];
  const query = mention_context.value?.query.toLocaleLowerCase() || "";
  return items.filter((item) => `${item.command} ${item.label} goal discuss 目标 讨论`.toLocaleLowerCase().includes(query))
    .map((item) => ({ key: `mode:${item.command}`, mode: item, group: t('模式') }));
});
const skill_options = computed(() => {
  if (!can_call_skill.value) return [];
  const query = mention_context.value?.query.toLocaleLowerCase() || "";
  return PLATFORM_SKILL_COMMANDS.filter((item) => `${item.id} ${item.label} ${item.search}`.toLocaleLowerCase().includes(query))
    .map((item) => ({ key: `skill:${item.id}`, skill: item, group: t('平台技能') }));
});
/** The sub-workflows of the workflow in use; like a platform skill, picking one only prefills a request to the host. */
const sub_workflow_options = computed(() => {
  const workflow = room_workflow.value;
  if (!can_call_skill.value || !workflow?.sub_workflows?.length) return [];
  const query = mention_context.value?.query.toLocaleLowerCase() || "";
  return workflow.sub_workflows.filter((item) => `${item.id} ${item.label} ${item.description || ""}`.toLocaleLowerCase().includes(query))
    .map((item) => ({ key: `sub-workflow:${item.id}`, group: t('工作流「{value1}」的子工作流', { value1: workflow.label }),
      skill: { ...item, prompt: `用工作流「${workflow.label}」的子工作流「${item.label}」（${item.id}）：` } }));
});
const member_skill_catalog = ref({});
const skill_member = computed(() => mention_context.value?.member || "");
let skill_read_version = 0;
watch([() => room.value?.id, skill_member], async ([room_id, name], [previous_room]) => {
  const version = ++skill_read_version;
  if (room_id !== previous_room) member_skill_catalog.value = {};
  if (!name || member_skill_catalog.value[name]?.available) return;
  if (!view.value.access?.can_manage || !(view.value.launch.available || view.value.launch.remote)) {
    member_skill_catalog.value = { ...member_skill_catalog.value, [name]: { available: false, reason: t('连接成员所在电脑后可读取技能') } };
    return;
  }
  member_skill_catalog.value = { ...member_skill_catalog.value, [name]: null };
  try {
    const catalog = await bridge.read_member_skills(room_id, name);
    if (version === skill_read_version) member_skill_catalog.value = { ...member_skill_catalog.value, [name]: catalog };
  } catch (error) {
    if (version !== skill_read_version) return;
    member_skill_catalog.value = { ...member_skill_catalog.value, [name]: { available: false, reason: t('技能列表未载入，重新输入 / 可重试') } };
    bridge.notify("error", error.message);
  }
});
const member_skills_loading = computed(() => !!skill_member.value && !member_skill_catalog.value[skill_member.value]);
const member_skill_options = computed(() => {
  const query = mention_context.value?.query.toLocaleLowerCase() || "";
  return (member_skill_catalog.value[skill_member.value]?.skills || [])
    .filter(skill => `${skill.id} ${skill.label} ${skill.description}`.toLocaleLowerCase().includes(query))
    .map(skill => ({ key: `member-skill:${skill.id}`, skill, group: t('{value1} 的技能', { value1: bridge.display_name(skill_member.value) }) }));
});
const member_skills_empty = computed(() => member_skill_catalog.value[skill_member.value]?.reason || t('没有匹配的本机技能'));
const mention_options = computed(() => skill_member.value ? member_skill_options.value : mention_context.value?.command ? [...mode_options.value, ...(can_pick_workflow.value ? workflow_options.value : []), ...sub_workflow_options.value, ...skill_options.value] : [
  ...mention_members.value.map((name) => ({ key: `member:${name}`, name, group: t('成员') })),
  ...mention_folder_self.value.map((option) => ({ ...option, group: mention_files_group.value })),
  ...mention_files.value.map((entry) => ({ key: `file:${entry.path}`, entry, group: mention_files_group.value })),
]);
/** A "/" whose typed text matches nothing is ordinary prose (e.g. "/task-ledger，后续…"), so the menu steps aside. */
const mention_open = computed(() => !!mention_context.value && !(mention_context.value.command && mention_context.value.query
  && !mention_options.value.length && !member_skills_loading.value));
const mention_heading = computed(() => skill_member.value ? t('{value1} 的本机技能', { value1: bridge.display_name(skill_member.value) }) : mention_context.value?.command ? t('选择模式、工作流或技能') : project_directory.value ? t('选择成员或文件') : t('选择成员'));
/** Until the user moves the selection, a bare @ selects the host, who takes unaddressed messages; otherwise the first. */
const mention_default = computed(() => {
  const host = !mention_context.value?.query && !mention_context.value?.command && free_members.value.find((member) => member.role === "host");
  return Math.max(0, host ? mention_options.value.findIndex((option) => option.name === host.name) : 0);
});
const mention_active = computed(() => mention_options.value[Math.min(mention_index.value ?? mention_default.value, mention_options.value.length - 1)]);
watch([() => room.value?.id, () => view.value.tab], () => { mention_context.value = null; });

/** A path starting with a member's handle would wake that member, so it is written as ./path instead. */
function file_handle(path) {
  const names = free_members.value.map((member) => member.name);
  const handles = mention_pool.value.flatMap(({ name }) => names.includes(name) ? bridge.mention_handles(name, names) : [name]);
  return handles.some((handle) => MENTION_PATTERN(handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).test(`@${path}`)) ? `./${path}` : path;
}

/** Locate an @ token at a collapsed caret, excluding email addresses, code and quotes. */
function find_mention(value, start, end = start) {
  if (start !== end) return null;
  const prefix = value.slice(0, start);
  const match = prefix.match(/(?:^|[\s(（，,。；;：:])@([^\s@`，,。；;：:()（）]*)$/u);
  if (!match) return null;
  const prose = prefix.replace(/```[\s\S]*?```/g, "");
  const line = prose.split("\n").at(-1);
  if (prose.includes("```") || /^\s*>/.test(line) || line.replace(/`[^`]*`/g, "").includes("`")) return null;
  // Only the text before the caret is the query: text already written after it is never replaced.
  return { start: start - match[1].length - 1, end: start, query: match[1] };
}

/** Locate a "/" command at the start of the draft or after whitespace, so paths such as a/b never trigger it. */
function find_command(value, start, end = start) {
  if (start !== end || !(can_use_modes.value || can_pick_workflow.value || can_call_skill.value)) return null;
  const match = value.slice(0, start).match(/(?:^|\s)\/([^\s/]*)$/u);
  if (!match) return null;
  const command_start = start - match[1].length - 1;
  const before = value.slice(0, command_start).trimEnd();
  const names = free_members.value.map(member => member.name);
  const mentioned = bridge.mentioned_members(before, names);
  const member = names.find(name => mentioned.has(name) && bridge.mention_handles(name, names).some(handle => before.endsWith(`@${handle}`)));
  return { start: command_start, end: start, query: match[1], command: true, member };
}

/**
 * Replace part of the draft through the browser's own editing, so Ctrl+Z / Ctrl+Y can undo and redo it;
 * falls back to a plain assignment where insertText is unavailable. Leaves the caret after the inserted text.
 */
async function replace_draft(start, end, insertion) {
  const editor = prompt.value?.textareaRef;
  editor?.focus();
  editor?.setSelectionRange(start, end);
  const native = !!editor && (insertion ? document.execCommand("insertText", false, insertion) : document.execCommand("delete"));
  if (!native) text.value = text.value.slice(0, start) + insertion + text.value.slice(end);
  await nextTick();
  editor?.focus();
  editor?.setSelectionRange(start + insertion.length, start + insertion.length);
}

/** Where the replacement ends: also swallow one space after the token when the insertion already ends with one. */
const replace_end = (end, insertion) => insertion.endsWith(" ") && text.value[end] === " " ? end + 1 : end;

/** Read the native caret after typing or moving through the existing draft. */
function update_mention(event) {
  const editor = prompt.value?.textareaRef;
  if (event.target !== editor || mention_composing) return;
  if (event.type === "keyup" && !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const context = find_command(editor.value, editor.selectionStart, editor.selectionEnd)
    || find_mention(editor.value, editor.selectionStart, editor.selectionEnd);
  if (context?.query !== mention_context.value?.query || context?.start !== mention_context.value?.start) mention_index.value = null;
  mention_context.value = context;
}

/** What @ inserts for a member: its on-screen nickname when that names it alone, otherwise its member name. */
const mention_handle = (name) => GROUP_MENTIONS[name] ? name : bridge.mention_handles(name, free_members.value.map((member) => member.name))[0];
/** Replace just the active token and leave the caret ready for the next word. */
async function select_mention(option) {
  if (!mention_context.value || mention_context.value.composing || !mention_options.value.some((item) => item.key === option.key)) return;
  const { start, end } = mention_context.value;
  if (option.mode) return pick_mode(option, start, end);
  if (option.workflow) return pick_workflow(option, start, end);
  if (option.skill) return pick_skill(option, start, end);
  const { entry } = option;
  // A folder opens its contents in the popup (paths with spaces cannot be typed after @, so those are picked whole);
  // a picked file or folder keeps its @path in the text and also becomes a card above the editor.
  const browse = entry?.kind === "directory" && !option.self && !entry.absolute && !/\s/.test(entry.path);
  // A file in another project directory leaves no @ text: its card carries the full path.
  const insertion = !entry ? `@${mention_handle(option.name)} ` : entry.absolute ? ""
    : `@${file_handle(entry.path)}${entry.kind === "directory" ? "/" : ""}${browse ? "" : " "}`;
  if (entry && !browse && !file_refs.value.some((ref) => ref.path === entry.path)) file_refs.value = [...file_refs.value, { path: entry.path, name: entry.name, kind: entry.kind }];
  mention_context.value = null;
  await replace_draft(start, replace_end(end, insertion), insertion);
  mention_context.value = null;
  const editor = prompt.value?.textareaRef;
  if (browse && editor) {
    mention_index.value = null;
    mention_context.value = find_mention(editor.value, editor.selectionStart);
  }
}

/**
 * Replace the "/command" with a request asking the host to enable the workflow, leaving the caret after it for the
 * task. Enabling another workflow replaces the current one; the members the old one brought stay as ordinary members.
 */
async function pick_workflow(option, start, end) {
  mention_context.value = null;
  if (option.enabled) return bridge.notify("info", t('本房间已启用工作流「{value1}」', { value1: option.workflow.label }));
  if (option.disabled) return bridge.notify("warning", option.disabled);
  await replace_draft(start, replace_end(end, " "), `启用工作流「${option.workflow.label}」（${option.workflow.id}），`);
  mention_context.value = null;
}

/** Write the mode's command in place of the typed "/…"; one that needs text after it keeps the caret there. */
async function pick_mode(option, start, end) {
  mention_context.value = null;
  if (option.mode.disabled) return bridge.notify("warning", option.mode.disabled);
  const { command } = option.mode;
  await replace_draft(start, replace_end(end, " "), command);
  mention_context.value = null;
}

/** Replace the "/command" with the skill's request to the host, leaving the caret after it for the user's details. */
async function pick_skill(option, start, end) {
  mention_context.value = null;
  const { prompt: request } = option.skill;
  await replace_draft(start, replace_end(end, " "), request);
  mention_context.value = null;
}

/** Keep suggestion keys local to the editor; modified Enter is left to the editor. */
function mention_keydown(event) {
  if (event.target !== prompt.value?.textareaRef || !mention_open.value || event.isComposing || event.keyCode === 229) return;
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
  if (event.key === "Escape") mention_context.value = null;
  else if (["ArrowDown", "ArrowUp"].includes(event.key) && mention_options.value.length) {
    const direction = event.key === "ArrowDown" ? 1 : -1;
    mention_index.value = (mention_options.value.indexOf(mention_active.value) + direction + mention_options.value.length) % mention_options.value.length;
    nextTick(() => mention_list.value?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" }));
  } else if (["Enter", "Tab"].includes(event.key) && mention_active.value) select_mention(mention_active.value);
  else if (["Enter", "Tab"].includes(event.key) && member_skills_loading.value) { /* Wait for the catalog, never send its unfinished slash. */ }
  else return;
  event.preventDefault();
  event.stopPropagation();
}

let composition_start = 0;
/**
 * Search while an input method is still composing: the pinyin typed so far ("han'c") is the query, so 寒潮 is found
 * before it is committed. Keys still belong to the input method, and picking waits for the committed text.
 */
function mention_composition(event) {
  const editor = prompt.value?.textareaRef;
  if (event.target !== editor) return;
  if (event.type === "compositionstart") {
    mention_composing = true;
    composition_start = editor.selectionStart;
    return;
  }
  if (event.type === "compositionupdate") {
    const draft = editor.value.slice(0, composition_start) + (event.data || "").replace(/['\s]/g, "");
    const context = find_command(draft, draft.length) || find_mention(draft, draft.length);
    if (context?.query !== mention_context.value?.query) mention_index.value = null;
    mention_context.value = context && { ...context, composing: true };
    return;
  }
  mention_composing = false;
  update_mention(event);
}

/** The autocomplete never moves focus away from the draft. */
function keep_mention_focus(event) { event.preventDefault(); }

const MIRROR_STYLES = ["boxSizing", "width", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
  "fontFamily", "fontSize", "fontWeight", "fontStyle", "letterSpacing", "lineHeight", "textIndent", "textTransform", "wordSpacing", "tabSize"];
/** Top of the line holding `index`, measured from the textarea's border edge, by laying the text out in a hidden copy. */
function caret_line_top(editor, index) {
  const mirror = document.createElement("div");
  const style = getComputedStyle(editor);
  for (const key of MIRROR_STYLES) mirror.style[key] = style[key];
  Object.assign(mirror.style, { position: "absolute", visibility: "hidden", top: "0", left: "-9999px", whiteSpace: "pre-wrap", overflowWrap: "break-word", wordBreak: style.wordBreak });
  mirror.textContent = editor.value.slice(0, index);
  const marker = mirror.appendChild(document.createElement("span"));
  marker.textContent = "​";
  document.body.appendChild(mirror);
  const top = marker.offsetTop;
  mirror.remove();
  return top - editor.scrollTop;
}

/**
 * The popup sits above the line being typed, not above the whole composer: with a long draft and the phone keyboard
 * up, the space above the composer is only a row or two. On the first line it stays above the composer as before.
 */
const mention_anchor = computed(() => {
  const start = mention_context.value?.start;
  const box = prompt.value?.$el;
  const editor = prompt.value?.textareaRef;
  if (start == null || !box || !editor) return box;
  return {
    contextElement: box,
    getBoundingClientRect() {
      const outer = box.getBoundingClientRect();
      const field = editor.getBoundingClientRect();
      const first_line = parseFloat(getComputedStyle(editor).paddingTop) || 0;
      const line = caret_line_top(editor, start);
      const top = line <= first_line ? outer.top : Math.min(Math.max(field.top + line, field.top), field.bottom);
      return new DOMRect(outer.left, top, outer.width, outer.bottom - top);
    },
  };
});

/** End a structured excerpt after complete code lines or table rows. */
function trim_preview_blocks(fragment) {
  for (const block of fragment.querySelectorAll('pre code, tbody')) {
    const range = fragment.ownerDocument.createRange();
    if (block.tagName === 'TBODY') {
      if (block.children.length <= MESSAGE_PREVIEW_TABLE_ROWS) continue;
      range.setStartAfter(block.children[MESSAGE_PREVIEW_TABLE_ROWS - 1]);
    } else {
      const lines = block.textContent.trimEnd().split('\n');
      if (lines.length <= MESSAGE_PREVIEW_CODE_LINES) continue;
      range.setStart(block.firstChild, lines.slice(0, MESSAGE_PREVIEW_CODE_LINES).join('\n').length);
    }
    range.setEnd(fragment, fragment.childNodes.length);
    range.deleteContents();
    return true;
  }
  return false;
}

/** Clip rendered text at a nearby sentence boundary while keeping valid markup. */
function build_answer_preview(message) {
  const full = { truncated: false, html: message.rendered_text };
  if (message.kind === "receipt") return full;
  const template = document.createElement("template");
  template.innerHTML = message.rendered_text;
  const clipped_blocks = trim_preview_blocks(template.content);
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => node.parentElement?.closest('.katex-mathml') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  const characters = [...nodes.map((node) => node.textContent).join("").trimEnd()];
  if (characters.length <= MESSAGE_PREVIEW_LENGTH) return { truncated: clipped_blocks, html: template.innerHTML };
  const prefix = characters.slice(0, MESSAGE_PREVIEW_LENGTH).join("");
  const boundary = [...prefix.matchAll(/[。！？；]\s*|[.!?;](?:\s|$)|\n/gu)].at(-1);
  const boundary_end = boundary ? boundary.index + boundary[0].length : 0;
  const natural_end = [...prefix.slice(0, boundary_end)].length >= MESSAGE_PREVIEW_MIN_LENGTH;
  let remaining = natural_end ? boundary_end : prefix.length;
  for (const node of nodes) {
    if (remaining > node.textContent.length) { remaining -= node.textContent.length; continue; }
    const range = template.content.ownerDocument.createRange();
    const formula = node.parentElement?.closest('.katex');
    const row = node.parentElement?.closest('tr');
    if (row?.previousElementSibling) range.setStartBefore(row);
    else if (row) range.setStartAfter(row);
    else if (formula) range.setStartAfter(formula.closest('.katex-display') || formula);
    else range.setStart(node, remaining);
    range.setEnd(template.content, template.content.childNodes.length);
    range.deleteContents();
    if (!natural_end && !formula && !row) node.textContent += "…";
    break;
  }
  return { truncated: true, html: template.innerHTML };
}

/** Merge execution cards without adding them to message counts, references or round navigation. */
const transcript_messages = computed(() => view.value.source_filter ? free_layout.value.filter(matches_filter) : free_layout.value);
/** Card kinds the header filter offers, each recognised from how the transcript shows it. */
const CARD_KINDS = {
  working: (item) => Boolean(item.slot_card && item.working),
  // Failed cards, a message whose request failed, and refused operations reported under a message.
  failed: (item) => Boolean(item.failure) || (!item.slot_card && ((request_badges.value.get(item.id) || []).some((badge) => badge.color === "error")
    || (execution_reports.value.get(item.id) || []).some((report) => report.denials?.length))),
  stopped: (item) => Boolean(item.cancelled_turn || item.cancelled_execution) || Boolean(!item.slot_card && item.withdrawn),
  arrangement: (item) => Boolean(item.arrangement),
  scheduler: (item) => !item.slot_card && (scheduler_decisions.value.has(item.id) || routing_messages.value.has(item.id) || recommendations.value.has(item.id)),
  changes: (item) => !item.slot_card && (execution_reports.value.get(item.id) || []).some((report) => report.changes?.length),
};
/** Leave the filter and scroll the full transcript to this card, or to the message it shows under. */
async function locate(item) {
  const target = item.slot_card ? layout_anchors.get(item.id) : item.id;
  await act("filter", { query: "", mention: false, host: false, authors: [], kinds: [] });
  await nextTick();
  if (target != null) jump_to(target);
}
/** The header filter: a card shows when any checked speaker or card kind matches it. */
function matches_filter(item) {
  if (view.value.card_kinds.some((kind) => CARD_KINDS[kind]?.(item))) return true;
  // A speaker filter also keeps that member's own working, failed and stopped cards.
  if (view.value.authors.includes(item.author)) return true;
  const host = room.value.members?.find((member) => member.role === "host")?.name;
  if (view.value.host_only && host && item.author === host) return true;
  if (item.slot_card) return false;
  // The host view also carries the program's notices to the host and Goal progress.
  if (view.value.host_only && (item.kind === "moderation" || ["notice", "goal"].includes(item.source))) return true;
  return view.value.mention_only && [...new Set(["用户", bridge.display_name("用户")])].some((handle) => (item.text || "").includes(`@${handle}`));
}
/** A discussion opened mid-room shows the topic where it began (or at the end before anyone answers); otherwise it stays on top. */
const topic_anchor = stable_computed(() => {
  const started = Date.parse(room.value?.session?.created_at || "");
  if (!started) return null;
  const messages = transcript_messages.value;
  if (!messages.some((message) => !message.slot_card && Number(message.id) <= room.value.session.started_message_id)) return null;
  let index = messages.findIndex((message) => !message.slot_card && Date.parse(message.created_at) >= started);
  // Working cards trailing the history already belong to this discussion.
  if (index < 0) index = messages.findLastIndex((message) => !message.slot_card) + 1;
  if (index === 0) return null;
  return index < messages.length ? messages[index].id : "end";
});
/** A concluded latest discussion leaves its end card right after its last message, once the room is back to free collaboration. */
const end_anchor = stable_computed(() => {
  const session = room.value?.session;
  if (session?.status !== "concluded") return null;
  const messages = transcript_messages.value;
  const index = messages.findIndex((message) => !message.slot_card && Number(message.id) > session.ended_message_id);
  return index < 0 ? "end" : messages[index].id;
});
/** Notices waking the host after its own failure, by message id: the wake-up takes the failed card's place, not a new card. */
const failure_wakes = computed(() => new Map((room.value.free?.failure_wakes || []).map((wake) => [wake.message_id, wake.execution_id])));
/** Timed checks the host answered without dispatching, by notice id → answer: the answer folds into the check's line. */
const quiet_checkins = computed(() => {
  if (view.value.query || view.value.source_filter) return new Map();
  const answers = new Map(view.value.messages.map((message) => [message.id, message]));
  return new Map((room.value.free?.quiet_checkins || []).map((check) => [check.message_id, answers.get(check.answer_id)]).filter(([, answer]) => answer));
});
const folded_checkin_answers = computed(() => new Set([...quiet_checkins.value.values()].map((answer) => answer.id)));
/** Failed free-room executions, shaped like working cards so a failure stays where its work was shown. */
const free_failures = computed(() => {
  if (view.value.query) return [];
  const names = new Map((room.value.free?.members || []).map((member) => [member.id, member.name]));
  // A host failure whose wake-up has started is shown by that wake-up's card in the same place.
  const followed = new Set(all_executions.value.map((execution) => failure_wakes.value.get(execution.request_message_id)).filter(Boolean));
  return all_executions.value.filter((execution) => execution.status === "failed" && !followed.has(execution.id))
    .map((execution) => ({ id: `failed-${execution.id}`, author: execution.member || names.get(execution.member_id) || t('成员'), slot_card: true, created_at: execution.created_at,
      execution_id: execution.id, request_message_id: execution.request_message_id, layout_after: execution.layout_after,
      layout_at: execution.layout_at, discussion_request: execution.requests?.find((request) => request.discussion_session_id),
      failure: { ...execution, elapsed_seconds: execution.finished_at ? Math.max(0, execution.finished_at - execution.created_at) : null } }))
    .concat(undeliverable_requests());
});
/** Pending requests the local service cannot deliver, because it could not take over the member's session; the reason sits under the message. */
function undeliverable_requests() {
  const blocked = new Map((room.value.free?.members || []).filter((member) => member.adopt_error).map((member) => [member.id, member]));
  return (room.value.free?.requests || []).filter((request) => request.status === "pending" && blocked.has(request.member_id))
    .map((request) => ({ id: `undeliverable-${request.id}`, author: blocked.get(request.member_id).name, slot_card: true, undeliverable: true,
      created_at: request.created_at, request_message_id: request.message_id, layout_after: request.layout_after, layout_at: request.created_at,
      failure: { role: blocked.get(request.member_id).role, result: blocked.get(request.member_id).adopt_error } }));
}
const expanded_rewinds = ref(new Set());
/** Consecutive rewound messages fold into one line at the first of them until expanded; a retracted one is a line of its own. */
const rewound_runs = stable_computed(() => {
  const runs = new Map(), hidden = new Set();
  let start = null;
  for (const message of view.value.messages) {
    if (message.withdrawn !== "rewound") { start = null; continue; }
    if (start === null) { start = message.id; runs.set(start, 0); }
    runs.set(start, runs.get(start) + 1);
    if (start !== message.id && !expanded_rewinds.value.has(start)) hidden.add(message.id);
  }
  return { runs, hidden };
});
function toggle_rewound(id) {
  const next = new Set(expanded_rewinds.value);
  if (!next.delete(id)) next.add(id);
  expanded_rewinds.value = next;
}

/**
 * One rule places every card, whatever its kind (working, failed, stopped, answer, arrangement, missed turn): it shows
 * under the top-level message at or before `layout_after`, the room's latest message when its request was made, and
 * cards under the same message follow the order their work started (`layout_at`). Both are fixed when the request is
 * made, so a card keeps its place once shown, and nothing nests under another card: an older nesting would pull later
 * work up above what the user posted meanwhile. Kinds differ only in how a card looks.
 */
/** Slot card id → id of the message it shows under; filled with the layout, read when locating a filtered card. */
const layout_anchors = new Map();
const free_layout = computed(() => {
  const messages = view.value.messages.filter((message) => !rewound_runs.value.hidden.has(message.id)
    && !(message.source === "notice" && failure_wakes.value.has(message.id)) && !folded_checkin_answers.value.has(message.id));
  // Work on a taken-back message is no longer shown; a failure there is dropped too.
  const taken_back = new Set(view.value.messages.filter((message) => message.withdrawn).map((message) => message.id));
  const slots = new Map();
  const executions = new Map(all_executions.value.map((execution) => [execution.id, execution]));
  // Top-level messages in id order, filled while the messages are placed.
  const root_ids = [];
  const place = (item) => {
    if ((!item.execution_id && !item.cancelled_turn && !item.arrangement && !item.undeliverable) || item.withdrawn) return false;
    if (taken_back.has(item.request_message_id)) return false;
    const after = item.arrangement?.after_message_id ?? item.cancelled_turn?.after_message_id ?? item.layout_after;
    if (after == null) return false;
    // Before the first loaded message, the card shows once that part of the history is loaded.
    const anchor = after === 0 ? 0 : root_ids.findLast((root) => root <= after);
    if (anchor === undefined) return false;
    slots.set(anchor, [...(slots.get(anchor) || []), item]);
    return true;
  };
  const roots = messages.filter((message) => {
    if (place(message)) return false;
    root_ids.push(message.id);
    return true;
  });
  free_failures.value.forEach(place);
  if (!view.value.query) {
    for (const plan of all_arrangements.value) place({ id: plan.key || `plan-${plan.id}`, slot_card: true,
      arrangement: plan, layout_at: new Date(plan.created_at).getTime() / 1000 });
    for (const turn of all_cancelled_turns.value) place({ id: `cancelled-${turn.key || turn.id}`, author: turn.expert,
      slot_card: true, cancelled_turn: turn, execution_id: turn.execution_id,
      layout_at: turn.layout_at ?? new Date(turn.created_at).getTime() / 1000 });
    const missed = new Set(all_cancelled_turns.value.map((turn) => turn.execution_id));
    for (const execution of executions.values()) {
      if (execution.status !== "cancelled" || execution.answer_id || missed.has(execution.id)) continue;
      // Work that reached the member's software keeps a card where it worked once voided; work never delivered leaves none.
      const request = execution.requests?.find((item) => item.discussion_session_id);
      if (request || execution.capabilities) place({ id: `stopped-${execution.id}`, author: execution.member,
        slot_card: true, cancelled_execution: execution, execution_id: execution.id, request_message_id: execution.request_message_id,
        layout_after: execution.layout_after, layout_at: execution.layout_at, discussion_request: request });
    }
  }
  const tail = free_working.value.map((item) => ({ ...item, slot_card: true })).filter((item) => !place(item));
  const by_start = (left, right) => ((left.layout_at ?? 0) - (right.layout_at ?? 0)) || ((left.execution_id || 0) - (right.execution_id || 0));
  const ordered = [];
  layout_anchors.clear();
  // Each card remembers the message it shows under, so a filtered card can lead back to its place in the full transcript.
  const visit = (cards, anchor) => cards.sort(by_start).forEach((item) => { ordered.push(item); layout_anchors.set(item.id, anchor); });
  visit(slots.get(0) || [], 0);
  roots.forEach((item) => { ordered.push(item); visit(slots.get(item.id) || [], item.id); });
  return [...ordered, ...tail];
});
/** Id of the top-level message at or before `index`, where a shown range can start without splitting a slot; 0 shows all. */
function floor_before(messages, index) {
  for (let position = Math.min(index, messages.length - 1); position >= 0; position--) {
    if (!messages[position].slot_card) return Number(messages[position].id);
  }
  return 0;
}
// A long room first mounts only its newest cards (mounting hundreds at once held the page for seconds), then renders the
// earlier ones a few at a time, each slice sized to fit within a frame: while the page is idle, so they are ready before
// the reader scrolls up to them, or on every frame while the reader nears the top or waits on a jump.
// Null follows the newest batch; otherwise it is the id of the first shown message, so new arrivals never push cards out
// above the reader.
const render_floor = ref(null);
const render_start = computed(() => {
  const messages = transcript_messages.value;
  const floor = render_floor.value ?? floor_before(messages, messages.length - RENDER_BATCH);
  const index = messages.findIndex((message) => !message.slot_card && Number(message.id) >= floor);
  return index > messages.findIndex((message) => !message.slot_card) ? index : 0;
});
watch(follow_tail, (following) => {
  if (!following && render_floor.value === null) render_floor.value = floor_before(transcript_messages.value, transcript_messages.value.length - RENDER_BATCH);
});
/** Whether message `id` is in the history but not rendered yet. */
function not_rendered(id) {
  const index = id == null ? -1 : transcript_messages.value.findIndex((message) => message.id === id);
  return index >= 0 && index < render_start.value;
}
let preload_timer = null;
let preload_size = PRELOAD_FIRST_SLICE;
let preload_busy = false;
// The map entry under the pointer is rendered ahead of a click; a click on one still being reached jumps once it is.
let preload_wanted = null;
let pending_jump = null;
// The reader's own scrolling owns the position: a finger on the transcript, and the scroll events of their drag, wheel or
// momentum until SCROLL_SETTLE_MS after the last. Meanwhile the page writes no scrollTop (on iOS one written into a touch
// scroll also lands on the main thread's older offset, and the page jumps back), renders no earlier cards and keeps the
// transcript as drawn (transcript_memo); what came in meanwhile is drawn once the reader stops, with the position kept in
// the same frame. A tap scrolls nothing and holds nothing back.
let last_scroll_at = 0;
let reader_input_at = 0;
let written_top = null;
let touch_active = false;
let touch_scroll = false;
// When the finger last went down or moved, and whether this touch has scrolled (a tap has not).
let touch_at = 0;
let touch_scrolled = false;
// A finger resting this long (ms) without moving no longer holds the page: iOS may send no touchend after a long-press
// selection, and the hold would never end.
const TOUCH_HOLD_MS = 5000;
const reader_scrolling = ref(false);
let settle_timer = 0;
// Follows to the end and position keeps that waited for the reader to stop.
let follow_pending = false;
let keep_pending = false;
// The sub-pixel pad (px, 0 to 1) above the cards that keeps each slice's shift whole.
let preload_pad = 0;
/** Whether the reader is scrolling the transcript (or has a finger on it): the page must not move it now. */
function reader_busy() {
  const now = performance.now();
  return (touch_active && now - touch_at < TOUCH_HOLD_MS) || now - last_scroll_at < SCROLL_SETTLE_MS;
}
/**
 * Write the transcript's scroll position, marked as the page's own so its scroll event is not taken for the reader's,
 * and take the reading position there at once (a jump, a follow to the end, a kept position all start from it).
 */
function write_scroll(element, top) {
  element.scrollTop = top;
  written_top = own_top = element.scrollTop;
  reading_position?.mark();
}
// The last position the page wrote, kept until a scroll of someone else's: its scroll event records no reading position.
let own_top = null;
/** One of the reader's scroll events: hold the page back until they stop. */
function mark_reader_scroll() {
  last_scroll_at = performance.now();
  if (touch_active) { touch_scrolled = true; touch_at = last_scroll_at; }
  if (!reader_scrolling.value) {
    reader_scrolling.value = true;
    transcript.value?.setAttribute("data-reader-scrolling", "");
  }
  arm_settle();
}
/** Check back once the reader may have stopped; whatever waited runs then. */
function arm_settle() {
  if (!settle_timer) settle_timer = setTimeout(settle_reader, SCROLL_SETTLE_MS);
}
/** Once the reader has stopped, draw what came in meanwhile and run the follows and keeps that waited. */
function settle_reader() {
  settle_timer = 0;
  const left = SCROLL_SETTLE_MS - (performance.now() - last_scroll_at);
  if (reader_busy()) { settle_timer = setTimeout(settle_reader, Math.max(left, 50)); return; }
  release_reader();
}
/** End the hold now: the reader stopped, tapped something, or the page has to move (sending, another room). */
function release_reader() {
  clearTimeout(settle_timer);
  settle_timer = 0;
  last_scroll_at = 0;
  const element = transcript.value;
  if (reader_scrolling.value) {
    reader_scrolling.value = false;
    element?.removeAttribute("data-reader-scrolling");
    // Relayed images wait for this before taking their size (web/app.js load_relay_media).
    element?.dispatchEvent(new Event("reader-settled"));
  }
  reading_position?.settle();
  if (follow_pending) { follow_pending = false; follow_messages(); }
  if (keep_pending) keep_reading();
  if (element?.clientHeight) schedule_preload(preload_urgent(element));
}
/**
 * The transcript's v-memo: while the reader scrolls it stays as drawn, so nothing arriving (messages, progress, reports,
 * a timer tick) re-renders it or changes a height under their finger.
 */
let held_memo = null;
function transcript_memo(memo) {
  if (reader_scrolling.value && held_memo) return held_memo;
  return held_memo = memo;
}
/**
 * Where the browser does not keep the reading position (WebKit), scroll by however far the content under the reading
 * line was pushed, so what the reader sees stays put. While the reader scrolls it waits; following the end is left to
 * the end's own follow.
 */
function keep_reading() {
  const element = transcript.value;
  if (SCROLL_ANCHORING || !element || !reading_position || follow_tail.value) return;
  if (reader_busy() || glide.isAnimating()) { keep_pending = true; if (reader_busy()) arm_settle(); return; }
  keep_pending = false;
  scroll_by_drift(element, reading_position.drift());
}
/** Scroll by `drift` (px, content pushed down positive) so the content stays put on screen, in whole pixels plus the pad. */
function scroll_by_drift(element, drift) {
  if (drift == null || Math.abs(drift) < 0.25) return;
  const pad = (((preload_pad - drift) % 1) + 1) % 1;
  element.style.setProperty("--preload-pad", `${pad}px`);
  const top = element.scrollTop + Math.round(drift + pad - preload_pad);
  preload_pad = pad;
  write_scroll(element, top);
}
/** Whether the reader is waiting on earlier cards: near the top, or heading for one not rendered. */
function preload_urgent(element) {
  return element.scrollTop < LOAD_EARLIER_MARGIN || not_rendered(pending_jump) || not_rendered(preload_wanted);
}
/** Queue the next slice: on the next frame when urgent, otherwise when the page is idle. */
function schedule_preload(urgent = false) {
  // Without scroll anchoring (WebKit, so every iPhone) each slice above has to be offset by hand in whole pixels plus a
  // sub-pixel pad, and slices every few hundred milliseconds made the cards on screen creep for seconds after a long
  // room opened. There earlier cards render only when the reader nears them or jumps to one, not while idle.
  if (!SCROLL_ANCHORING && !urgent) return;
  if (!render_start.value || (preload_timer && (preload_timer.urgent || !urgent))) return;
  preload_timer?.cancel();
  const run = () => { preload_timer = null; preload_slice(); };
  if (urgent) {
    const frame = requestAnimationFrame(run);
    preload_timer = { urgent, cancel: () => cancelAnimationFrame(frame) };
  } else if (window.requestIdleCallback) {
    const idle = requestIdleCallback(run, { timeout: PRELOAD_IDLE_TIMEOUT_MS });
    preload_timer = { urgent, cancel: () => cancelIdleCallback(idle) };
  } else {
    const timer = setTimeout(run, PRELOAD_IDLE_TIMEOUT_MS);
    preload_timer = { urgent, cancel: () => clearTimeout(timer) };
  }
}
onBeforeUnmount(() => preload_timer?.cancel());
/** Render one slice of earlier cards above the shown ones, keeping what the reader sees in place. */
async function preload_slice() {
  const element = transcript.value;
  // A hidden transcript has no layout to keep; showing it again tracks the scroll, which resumes the preload.
  if (preload_busy || !element?.clientHeight || !render_start.value) return;
  const urgent = preload_urgent(element);
  // Where the slice is offset by hand, the reader's scrolling holds every slice, even one they wait on near the top. Where
  // the browser keeps the position, only touch scrolling holds those.
  if (glide.isAnimating() || (reader_busy() && (!SCROLL_ANCHORING || !urgent || touch_scroll))) return schedule_preload();
  preload_busy = true;
  const started = performance.now();
  const top_before = element.scrollTop;
  const from_bottom = element.scrollHeight - top_before;
  const anchor = message_nodes(element)[0];
  // Measured from the top of the content, so it holds a fraction of a pixel exactly and no scroll made meanwhile (the
  // composer growing keeps the end in view) counts as a shift.
  const content_top = (node) => node.getBoundingClientRect().top - element.firstElementChild.getBoundingClientRect().top;
  const anchor_top = anchor && content_top(anchor);
  const anchor_screen = anchor?.getBoundingClientRect().top;
  render_floor.value = floor_before(transcript_messages.value, render_start.value - preload_size);
  await nextTick();
  if (!SCROLL_ANCHORING && anchor?.isConnected) {
    // By hand, the first card shown before (right below the new ones; at the very top the topic card stays above them)
    // goes back where it was on screen. Measured on screen, so a shift the browser made by itself (WebKit's own
    // anchoring, should it run despite overflow-anchor: none) is not counted twice. The reading position is then taken
    // afresh, so the growth this slice causes is not offset a second time (keep_reading).
    scroll_by_drift(element, anchor.getBoundingClientRect().top - anchor_screen);
    reading_position?.mark();
  } else if (anchor?.isConnected) {
    // The browser follows by itself. The cards moved down by `shift`, a fraction of a pixel included; the pad takes the
    // fraction so the browser follows by whole screen pixels (a fraction of a CSS pixel when zoomed): a fractional follow
    // rounds each card on screen differently and the text wobbled by 1px.
    const unit = 1 / window.devicePixelRatio;
    const shift = content_top(anchor) - anchor_top;
    const pad = (((preload_pad - shift) % unit) + unit) % unit;
    element.style.setProperty("--preload-pad", `${pad}px`);
    written_top = Math.round(top_before + shift + pad - preload_pad);
    preload_pad = pad;
  } else {
    written_top = element.scrollHeight - from_bottom;
    if (element.scrollTop !== written_top) element.scrollTop = written_top;
  }
  const spent = performance.now() - started;
  const budget = not_rendered(pending_jump) ? PRELOAD_JUMP_BUDGET_MS : urgent ? PRELOAD_URGENT_BUDGET_MS : PRELOAD_BUDGET_MS;
  preload_size = Math.max(1, Math.min(PRELOAD_MAX_SLICE, Math.round(preload_size * budget / Math.max(spent, 1))));
  preload_busy = false;
  if (pending_jump !== null && !not_rendered(pending_jump)) {
    const id = pending_jump;
    pending_jump = null;
    jump_to(id);
  }
  schedule_preload(preload_urgent(element));
}
/**
 * Scroll events from the reader, told apart from the offsets the page writes and from scrolls nobody asked for (the
 * browser's own anchoring, a clamp): the reader's come with a finger down, soon after a drag, wheel or scroll key, or
 * continue a scroll of theirs (momentum).
 */
function note_scroll() {
  const ours = transcript.value?.scrollTop === written_top;
  written_top = null;
  if (ours) return;
  own_top = null;
  const now = performance.now();
  if (touch_active || now - reader_input_at < READER_INPUT_MS || (reader_scrolling.value && now - last_scroll_at < SCROLL_SETTLE_MS)) mark_reader_scroll();
}
/** Split continuous history at local calendar boundaries; a working card stays in the day of the card above it. */
const message_groups = stable_computed(() => {
  const groups = [];
  for (const message of transcript_messages.value.slice(render_start.value)) {
    // Filtered cards stand apart from their messages, so each one takes its own day.
    if (message.slot_card && groups.length && !view.value.source_filter) { groups.at(-1).messages.push(message); continue; }
    const date = new Date(message.slot_card ? (message.created_at ?? 0) * 1000 : message.created_at);
    const key = date.toLocaleDateString();
    if (groups.at(-1)?.key !== key) groups.push({ key, label: date_formatter.format(date), messages: [] });
    groups.at(-1).messages.push(message);
  }
  return groups;
});
/** The sending card sits outside the day groups, so it carries its own divider when it opens a new day. */
const sending_day_label = computed(() => {
  const preview = view.value.sending_preview;
  if (!preview) return "";
  const date = new Date(preview.created_at);
  return message_groups.value.at(-1)?.key === date.toLocaleDateString() ? "" : date_formatter.format(date);
});

/** Preserve room-wide round boundaries while navigating filtered history. */
const navigation_groups = computed(() => {
  const groups = [];
  for (const message of transcript_messages.value.filter((item) => !item.slot_card)) {
    const candidate = bridge.round_groups(room.value)?.findLast((item) => item.start_id <= message.id);
    const round = candidate && (candidate.end_id == null || message.id <= candidate.end_id) ? candidate : null;
    const number = round?.number || 0;
    const key = round?.key || "ungrouped";
    if (groups.at(-1)?.key !== key) {
      const label = number ? t('第 {value1} 轮', { value1: number }) : t('未分组');
      const progress = round ? t('{value1}/{value2} 人已发言', { value1: round.opinions ?? round.speakers.length, value2: round.participants ?? Object.keys(room.value.experts).length }) : t('尚无参与专家的观点');
      groups.push({ key, number, label, description: `${label} · ${round?.completed ? t('已完成') : progress}`, messages: [] });
    }
    groups.at(-1).messages.push(message);
  }
  return groups;
});

const active_round = computed(() => navigation_groups.value.find((group) => group.messages.some((message) => message.id === active_message.value))?.number);
// Concluded sessions keep their historical labels; later collaboration is outside their end boundary.
const message_round_labels = stable_computed(() => new Map(navigation_groups.value.filter((group) => group.number).flatMap((group) => group.messages.map((message) => [message.id, group.label]))));

/** Keep each round number beside its messages and preserve keyboard order. */
const navigation_sections = computed(() => {
  let index = 0;
  return navigation_groups.value.map((group) => ({
    number: group.number, count: group.messages.length,
    entries: [
      { key: `round-${group.messages[0].id}`, round: true, number: group.number, message: group.messages[0], label: group.description, index: index++ },
      ...group.messages.map((message) => ({ key: `message-${message.id}`, round: false, message,
        label: t('{value1} · {value2} 的发言 #{value3}', { value1: group.label, value2: bridge.display_name(message.author), value3: message.id }), index: index++ })),
    ],
  }));
});
const navigation_entries = computed(() => navigation_sections.value.flatMap((section) => section.entries));

/** The glass top bar overlays the transcript, so readable content starts below it. */
function reading_top(element) {
  return element.getBoundingClientRect().top + (parseFloat(getComputedStyle(element).getPropertyValue("--channel-topbar-height")) || 0);
}

// Collecting the cards walks the whole transcript (tens of thousands of nodes); keep the list until a node is added or removed.
let card_list = null;
let card_observer = null;
/** The transcript's message cards in document order. */
function message_nodes(element) {
  if (card_observer?.element !== element) {
    card_observer?.disconnect();
    card_list = null;
    card_observer = Object.assign(new MutationObserver(() => { card_list = null; }), { element });
    card_observer.observe(element, { childList: true, subtree: true });
  }
  // Pending records are changes the observer callback has not seen yet in this task.
  if (card_observer.takeRecords().length || !card_list) card_list = [...element.querySelectorAll('[data-message-id]')];
  return card_list;
}
onBeforeUnmount(() => card_observer?.disconnect());

/** Polling follows new messages only while the reader is near the end. */
function track_scroll() {
  const element = transcript.value;
  // Mid-glide the distance to the end is the glide's, not the reader's; following stays on.
  if (!element || !element.clientHeight || glide.isAnimating()) return;
  // After a resize the cards have rewrapped; until the reading position is restored this scrollTop is not the reader's.
  if (reading_position?.stale()) return;
  schedule_preload(preload_urgent(element));
  const near_end = element.scrollHeight - element.scrollTop - element.clientHeight < FOLLOW_TAIL_THRESHOLD;
  if (!near_end && follow_tail.value && !moved_by_hand && !reader_busy() && performance.now() < settle_until && jump_target.value == null && !pending_jump) {
    write_scroll(element, element.scrollHeight - element.clientHeight);
    return;
  }
  follow_tail.value = near_end;
  const bounds = element.getBoundingClientRect();
  const top = reading_top(element);
  const messages = message_nodes(element);
  const target = jump_target.value != null && messages.find((item) => Number(item.dataset.messageId) === jump_target.value);
  if (target && target.getBoundingClientRect().bottom > top && target.getBoundingClientRect().top < bounds.bottom) {
    active_message.value = jump_target.value;
    return;
  }
  jump_target.value = null;
  // Cards run top to bottom, so a binary search finds the first one reaching the reading line in a few measurements.
  let low = 0, high = messages.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (messages[middle].getBoundingClientRect().bottom > top + READING_OFFSET) high = middle;
    else low = middle + 1;
  }
  active_message.value = messages[low] ? Number(messages[low].dataset.messageId) : null;
}

// Scroll events can outnumber frames; measuring once per frame keeps the reading position current without stalling the scroll.
let scroll_frame = 0;
function schedule_track_scroll() {
  note_scroll();
  if (!scroll_frame) scroll_frame = requestAnimationFrame(() => { scroll_frame = 0; track_scroll(); });
}
onBeforeUnmount(() => cancelAnimationFrame(scroll_frame));

// Rotation and window resizes rewrap every card; reopen the message being read, or the end while following it.
let reading_position = null;
onMounted(() => {
  const element = transcript.value;
  if (!element) return;
  reading_position = keep_reading_position(element, {
    // A send glide in flight keeps running toward the end; restoring only lands it where it is heading.
    reading_top: () => reading_top(element), stick_bottom: () => follow_tail.value, after_restore: track_scroll,
    can_write: () => !reader_busy(), ignore_scroll: () => own_top !== null && element.scrollTop === own_top,
  });
});
onBeforeUnmount(() => reading_position?.disconnect());
onBeforeUnmount(() => clearTimeout(settle_timer));

// The transcript's scroll position while it glides to a newly sent message; a later retarget keeps its velocity.
const glide = useSpring(0, SEND_SPRING);
glide.on("change", (value) => { if (transcript.value) write_scroll(transcript.value, value); });
glide.on("animationComplete", () => track_scroll());

/** Reveal saved messages without interrupting a reader of earlier records; `smooth` glides there on the send spring. */
async function follow_messages(smooth = false) {
  await nextTick();
  const element = transcript.value;
  // A reader scrolling near the end is still scrolling: the follow waits until they stop (release_reader). Only the glide
  // of their own send goes at once.
  if (follow_tail.value && element && smooth !== true && reader_busy()) { follow_pending = true; arm_settle(); }
  else if (follow_tail.value && element) {
    const bottom = element.scrollHeight - element.clientHeight;
    // While a send is in flight every follow glides, whichever watcher sees the new card first.
    if ((smooth === true || glide.isAnimating() || view.value.sending_message) && document.documentElement.dataset.motion !== "off") {
      if (!glide.isAnimating()) glide.jump(element.scrollTop);
      glide.set(bottom);
    } else write_scroll(element, bottom);
  }
  track_scroll();
}
watch([() => view.value.messages, free_working, free_failures], () => follow_messages(), { immediate: true });
// The sending card's entrance, 0 → 1. The saved card that replaces it mid-entrance takes over the same value, so a fast
// answer never cuts the rise short; `rising_id` is that saved card while it finishes.
const send_entry = useSpring(1, SEND_SPRING);
const send_y = useTransform(send_entry, [0, 1], [SEND_RISE, 0]);
let rising_id = null;
// Rendered like a saved message, so the card keeps its height when the saved copy replaces it.
// Each file's `[图片 #n]` / `[文件 #n]` is tinted whole, as the saved card will link it once the files are uploaded.
/** While the sending card's files upload: how many are in of how many; null once they all are (or there are none). */
const sending_uploads = computed(() => {
  const files = view.value.sending_preview?.files || [];
  const done = files.filter((file) => file.uploaded).length;
  return files.length && done < files.length ? { done, total: files.length } : null;
});
const sending_html = computed(() => {
  const preview = view.value.sending_preview;
  if (!preview) return "";
  return bridge.render_room_markdown(preview.text).replace(/\[(图片|文件) #(\d{1,2})\]/g, (match, kind, number) => !preview.files[number - preview.attachment_start] ? match
    : `<span class="attachment-placeholder">${kind === "图片" ? t("[图片 #{number}]", { number }) : t("[文件 #{number}]", { number })}</span>`);
});
/** Write the entrance onto the saved card that took over from the sending card. */
function paint_rising(value) {
  const card = rising_id && transcript.value?.querySelector(`[data-message-id="${rising_id}"]`);
  if (card) Object.assign(card.style, { opacity: value, transform: `translateY(${SEND_RISE * (1 - value)}px)` });
}
send_entry.on("change", paint_rising);
send_entry.on("animationComplete", () => {
  const card = rising_id && transcript.value?.querySelector(`[data-message-id="${rising_id}"]`);
  if (card) Object.assign(card.style, { opacity: "", transform: "" });
  rising_id = null;
});
// The sending card shows before the site answers; it rises in while the transcript glides to it.
watch(() => Boolean(view.value.sending_preview), (shown) => {
  if (!shown) return;
  // Sending is the reader's own move to the end; a scroll of theirs still settling no longer holds the transcript.
  release_reader();
  send_entry.jump(0); send_entry.set(1);
  follow_messages(true);
});
// Applied after the DOM update and before paint, so the saved card never shows a frame at full opacity.
watch(() => view.value.messages, (messages) => {
  const sent = send_entry.isAnimating() && messages.findLast((message) => message.just_sent);
  if (!sent) return;
  rising_id = sent.id;
  paint_rising(send_entry.get());
}, { flush: "post" });
// Filters compare by content: sending resets them to fresh empty lists, which is no change, and treating it as one put the
// transcript back to its newest cards and refilled it, so the page collapsed and jumped after every send.
watch([() => view.value.room?.id, () => view.value.query, () => view.value.source_filter, () => (view.value.authors || []).join(","), () => (view.value.card_kinds || []).join(",")], () => {
  jump_target.value = null;
  active_message.value = null;
  reset_preview();
  follow_tail.value = true;
  render_floor.value = null;
  pending_jump = preload_wanted = null;
  settle_until = performance.now() + ROOM_SETTLE_MS;
  moved_by_hand = false;
  // Another room or filter starts from its end with its first slice small; nothing of the last one's scrolling holds it.
  preload_size = PRELOAD_FIRST_SLICE;
  release_reader();
});
watch(() => view.value.tab, (tab) => {
  reset_preview();
  if (tab === "discussion") follow_messages();
});
watch(() => view.value.room?.id, () => expanded_answers.value.clear());

/** Expand in place; collapsing a long answer restores its visible beginning. */
async function toggle_answer(message, event) {
  const card = event.currentTarget.closest('[data-message-id]');
  const collapsing = expanded_answers.value.has(message.id);
  const scroll_position = transcript.value.scrollTop;
  follow_tail.value = false;
  if (collapsing) expanded_answers.value.delete(message.id);
  else expanded_answers.value.add(message.id);
  reset_preview();
  await nextTick();
  if (!collapsing) write_scroll(transcript.value, scroll_position);
  if (collapsing && card.getBoundingClientRect().top < reading_top(transcript.value)) {
    write_scroll(transcript.value, transcript.value.scrollTop + card.getBoundingClientRect().top - reading_top(transcript.value) - READING_OFFSET);
  }
  track_scroll();
}

/** Jump anywhere in the history while preserving the shared composer draft; a message still being rendered is jumped to once it is. */
function jump_to(id) {
  if (not_rendered(id)) {
    close_preview();
    pending_jump = id;
    schedule_preload(true);
    return;
  }
  pending_jump = null;
  const element = transcript.value;
  const message = element?.querySelector(`[data-message-id="${id}"]`);
  if (!message) return;
  close_preview();
  reader.state.following = false;
  jump_target.value = id;
  active_message.value = id;
  write_scroll(element, element.scrollTop + message.getBoundingClientRect().top - reading_top(element) - READING_OFFSET);
  message.focus({ preventScroll: true });
  track_scroll();
}

/** Any manual scroll (wheel, touch drag, scroll keys, scrollbar) turns read-aloud following off; only its button turns it back on. */
function stop_following(event) {
  if (event.type !== "keydown" || ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) moved_by_hand = true;
  // A drag, a wheel turn, a scroll key or a press on the scrollbar: the scroll events right after it are the reader's. A
  // finger that moved is scrolling even with no scroll event: at the very top it only stretches the page (iOS bounce).
  if (event.type === "touchmove") { touch_at = performance.now(); touch_scrolled = true; }
  if (event.type === "touchmove" || event.type === "wheel" || (event.type === "pointerdown" && event.target === event.currentTarget)
      || (event.type === "keydown" && ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key))) reader_input_at = performance.now();
  if (!reader.state.following) return;
  if (event.type === "keydown" && !["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) return;
  if (event.type === "pointerdown" && event.target !== event.currentTarget) return;
  reader.state.following = false;
}

/** Manual scrolling resumes tracking the message at the viewport's upper edge; it also takes over from a glide. */
function resume_tracking(event) {
  if (event.type !== "keydown" || ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) moved_by_hand = true;
  glide.stop();
  touch_scroll = touch_active = event.type === "touchstart";
  if (touch_active) { touch_at = performance.now(); touch_scrolled = false; }
  // Scrolling by hand drops a jump still waiting for its card.
  pending_jump = null;
  if (event.type !== "keydown" || ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) jump_target.value = null;
}

/**
 * Lifting a finger that scrolled starts the momentum, whose scroll events carry the hold on until they stop. A tap scrolled
 * nothing: on iOS it also stops a running momentum, so the reader has stopped and what waited goes now.
 */
function end_touch() {
  touch_active = false;
  if (!touch_scrolled) { release_reader(); return; }
  last_scroll_at = performance.now();
  arm_settle();
}

/** One Tab stop enters the map; arrow keys can inspect every compact tick. */
function navigate_by_key(event, index) {
  const positions = { ArrowUp: index - 1, ArrowDown: index + 1, Home: 0, End: navigation_entries.value.length - 1 };
  if (!Object.hasOwn(positions, event.key)) return;
  event.preventDefault();
  const target = Math.max(0, Math.min(positions[event.key], navigation_entries.value.length - 1));
  message_map.value.querySelectorAll('button')[target].focus({ preventScroll: true });
}

/** Reveal an entry by scrolling only the fixed navigation window. */
function reveal_navigation_entry(entry) {
  const nav = message_map.value;
  if (!nav?.clientHeight || !entry) return;
  const bounds = nav.getBoundingClientRect();
  const position = entry.getBoundingClientRect();
  if (position.top < bounds.top + NAV_EDGE_INSET) nav.scrollTop += position.top - bounds.top - NAV_EDGE_INSET;
  else if (position.bottom > bounds.bottom - NAV_EDGE_INSET) nav.scrollTop += position.bottom - bounds.bottom + NAV_EDGE_INSET;
}

/** Follow actual reading changes without undoing independent wheel browsing. */
async function reveal_reading_position() {
  await nextTick();
  reveal_navigation_entry(message_map.value?.querySelector(`[data-jump-id="${active_message.value}"]`));
}
watch(active_message, reveal_reading_position);

/** Keyboard previews use the entry's visible position after revealing it. */
function focus_preview(item, event) {
  if (navigation_scrub || !event.currentTarget.matches(":focus-visible")) return;
  navigation_keyboard.value = true;
  const anchor = item.round ? event.currentTarget.parentElement.querySelector('[data-jump-id]') : event.currentTarget;
  reveal_navigation_entry(anchor);
  show_preview(item, event);
}

/** Touch scrubbing: the finger previews the tick beneath it at once; the scrub, not the button click, decides the jump. */
function start_scrub(event) {
  suppress_navigation_click = false;
  if (!["touch", "pen"].includes(event.pointerType) || navigation_scrub) return;
  event.preventDefault();
  suppress_navigation_click = true;
  navigation_keyboard.value = false;
  navigation_scrub = { pointer: event.pointerId, start_x: event.clientX, start_y: event.clientY, x: event.clientX, y: event.clientY, moved: false, key: null };
  navigation_scrub.frame = requestAnimationFrame(scrub_frame);
  scrub_to();
}

/** Follow the finger; edge auto-scroll waits for real movement so a tap near an end stays a tap. */
function move_scrub(event) {
  const scrub = navigation_scrub;
  if (scrub?.pointer !== event.pointerId) return;
  scrub.x = event.clientX;
  scrub.y = event.clientY;
  scrub.moved ||= Math.hypot(scrub.x - scrub.start_x, scrub.y - scrub.start_y) > NAV_TOUCH_SLOP;
  scrub_to();
}

/** Sliding sideways out of the map hides the preview, and releasing there cancels the jump. */
function scrub_outside() {
  const bounds = message_map.value.getBoundingClientRect();
  return navigation_scrub.x < bounds.left - NAV_SCRUB_CANCEL || navigation_scrub.x > bounds.right + NAV_SCRUB_CANCEL;
}

/** Preview the message tick nearest the finger's height within the visible map. */
function scrub_to() {
  const nav = message_map.value;
  const scrub = navigation_scrub;
  if (!nav || !scrub) return;
  if (scrub_outside()) {
    scrub.key = null;
    preview_open.value = false;
    return;
  }
  const bounds = nav.getBoundingClientRect();
  const y = Math.max(bounds.top + NAV_EDGE_INSET, Math.min(scrub.y, bounds.bottom - NAV_EDGE_INSET));
  let nearest = null;
  let distance = Infinity;
  for (const entry of nav.querySelectorAll('[data-jump-id]')) {
    const position = entry.getBoundingClientRect();
    const gap = Math.abs((position.top + position.bottom) / 2 - y);
    if (gap < distance) [nearest, distance] = [entry, gap];
  }
  const key = nearest && `message-${nearest.dataset.jumpId}`;
  if (!key || (key === scrub.key && preview_open.value)) return;
  const item = navigation_entries.value.find((entry) => entry.key === key);
  if (!item) return;
  if (scrub.key && scrub.key !== key) {
    try { navigator.vibrate?.(NAV_HAPTIC_MS); } catch { /* Haptics are optional; iOS Safari has none. */ }
  }
  scrub.key = key;
  show_preview(item, { currentTarget: nearest });
}

/** Holding near either end scrolls the map, faster the closer the finger gets. */
function scrub_frame() {
  const scrub = navigation_scrub;
  if (!scrub) return;
  const nav = message_map.value;
  if (nav && scrub.moved && !scrub_outside()) {
    const bounds = nav.getBoundingClientRect();
    const up = Math.min(1, Math.max(0, 1 - (scrub.y - bounds.top) / NAV_SCRUB_EDGE));
    const down = Math.min(1, Math.max(0, 1 - (bounds.bottom - scrub.y) / NAV_SCRUB_EDGE));
    const before = nav.scrollTop;
    nav.scrollTop += (down - up) * NAV_SCRUB_SPEED;
    if (nav.scrollTop !== before) scrub_to();
  }
  scrub.frame = requestAnimationFrame(scrub_frame);
}

/** Release jumps to the previewed message; a cancelled pointer or a sideways exit only closes the preview. */
function end_scrub(event) {
  const scrub = navigation_scrub;
  if (scrub?.pointer !== event.pointerId) return;
  const target = event.type === "pointerup" && scrub.key && preview_open.value ? navigation_entries.value.find((entry) => entry.key === scrub.key) : null;
  stop_scrub();
  close_preview();
  if (target) jump_to(target.message.id);
}

/** Stop scrubbing when it ends, the layout changes, or the view unmounts. */
function stop_scrub() {
  if (navigation_scrub) cancelAnimationFrame(navigation_scrub.frame);
  navigation_scrub = null;
}

/** A stationary pointer must not replace a keyboard preview; touch previews come from scrubbing. */
function hover_preview(item, event) {
  if (["touch", "pen"].includes(event.pointerType)) return;
  if (event.type === "pointerenter" && navigation_keyboard.value) return;
  navigation_keyboard.value = false;
  if (preview_entry.value !== item.key || !preview_open.value) show_preview(item, event);
}

/** Keep short taps and keyboard activation as jumps; consume the click after a hold. */
function activate_navigation(item, event) {
  if (suppress_navigation_click && event.detail !== 0) {
    suppress_navigation_click = false;
    event.preventDefault();
    return;
  }
  jump_to(item.message.id);
}

/** Keep the native touch menu from interrupting an active navigation preview. */
function navigation_context_menu(event) {
  if (navigation_scrub) event.preventDefault();
}

/** Native wheel scrolling changes only the navigation, with no queued animation. */
function browse_navigation(event) {
  if (!event.deltaX && !event.deltaY) return;
  navigation_keyboard.value = false;
  close_preview();
}

/** Return to the newest record and resume following newly arriving messages. */
function return_to_latest() {
  close_preview();
  reader.state.following = false;
  jump_target.value = null;
  follow_tail.value = true;
  pending_jump = null;
  follow_messages();
}

/** Move the shared preview toward the entry without resetting a moving spring. */
async function show_preview(item, event) {
  const message = item.message;
  const entry = event.currentTarget.getBoundingClientRect();
  const nav = message_map.value.getBoundingClientRect();
  const width = Math.min(PREVIEW_WIDTH, innerWidth - PREVIEW_INSET * 2);
  const left = nav.right + PREVIEW_GAP;
  preview_left.value = Math.max(PREVIEW_INSET, Math.min(left, innerWidth - width - PREVIEW_INSET));
  preview_message.value = message.id;
  // The card under the pointer is rendered now, so clicking it jumps at once.
  preload_wanted = message.id;
  if (not_rendered(message.id)) schedule_preload(true);
  preview_entry.value = item.key;
  preview_is_round.value = item.round;
  preview_open.value = true;
  await nextTick();
  if (!preview_open.value || preview_entry.value !== item.key) return;
  preview_size.value = preview_content.value.scrollHeight + PREVIEW_PADDING;
  const midpoint = (Math.max(entry.top, nav.top + NAV_EDGE_INSET) + Math.min(entry.bottom, nav.bottom - NAV_EDGE_INSET)) / 2;
  const top = midpoint - preview_size.value / 2;
  preview_top.value = Math.max(PREVIEW_INSET, Math.min(top, innerHeight - preview_size.value - PREVIEW_INSET));
  const snap = preview_visibility.get() === 0;
  preview_y[snap ? "jump" : "set"](preview_top.value);
  preview_height[snap ? "jump" : "set"](preview_size.value);
}

/** Leaving the navigation and its adjoining preview releases the same spring. */
function close_preview(event) {
  if (event?.relatedTarget?.closest?.('.channel-message-map, .channel-nav-preview')) return;
  preview_open.value = false;
}

/** A new layout or message set invalidates the previous floating coordinates. */
function reset_preview() {
  stop_scrub();
  preview_open.value = false;
  preview_visibility.jump(0);
  preview_message.value = null;
}

/** Reflow changes message heights; keep tail following and the current tick in sync. */
async function refresh_layout() {
  reset_preview();
  topic_card?.measure();
  await follow_messages();
  await reveal_reading_position();
}

/** Reuse round groups while the preview stays beyond their hover reach. */
function section_preview_position(section) {
  const last = section.entries.length - 1;
  return Math.max(-NAV_HOVER_REACH, Math.min(last + NAV_HOVER_REACH, preview_index.value - section.entries[0].index));
}

/**
 * Nearby ticks respond by distance; the actual reading position stays distinct. A plain inline style animated by the CSS
 * transition (channel.css, NAV_SPRING as a linear() curve): a motion component per message cost a layout read on mount
 * and a JS-driven paint every frame while the reading tick moved during scrolling.
 */
function tick_state(item, index) {
  const distance = preview_index.value < 0 ? Infinity : Math.abs(index - preview_index.value);
  const influence = Math.max(0, 1 - distance / NAV_HOVER_REACH);
  const current = active_message.value === item.message.id;
  const selected = distance === 0 || (current && preview_index.value < 0);
  const base = NAV_TICK_WIDTH;
  return {
    transform: `scaleX(${selected ? NAV_ACTIVE_WIDTH / base : current ? NAV_READING_WIDTH / base : 1 + influence * NAV_HOVER_EXTENSION / base})`,
    height: `${selected ? NAV_ACTIVE_HEIGHT : NAV_TICK_HEIGHT}px`,
    opacity: selected ? NAV_ACTIVE_OPACITY : current ? NAV_READING_OPACITY : NAV_TICK_OPACITY + influence * NAV_HOVER_OPACITY,
  };
}

watch(preview_open, (open) => preview_visibility.set(open ? 1 : 0));
onMounted(() => window.addEventListener("resize", refresh_layout));
onBeforeUnmount(() => window.removeEventListener("resize", refresh_layout));

// Nuxt UI measures the editor on every keystroke by shrinking it to one row first; the transcript grows for that moment
// and its scrollTop is clamped, so with a multi-line draft the cards dropped a line on each keystroke. Keep the offset.
let held_scroll = null;
function hold_transcript() { held_scroll = transcript.value?.scrollTop ?? null; }
function release_transcript() {
  if (held_scroll !== null && transcript.value && transcript.value.scrollTop !== held_scroll) transcript.value.scrollTop = written_top = held_scroll;
  held_scroll = null;
}

/** A deleted tag removes its file; renumbering the rest rewrites the text, so the caret is put back where it was. */
function drop_unreferenced(event) {
  const area = event.target instanceof HTMLTextAreaElement ? event.target : null, caret = area?.selectionStart;
  if (bridge.drop_unreferenced_attachments(text.value) && area) nextTick(() => area.setSelectionRange(Math.min(caret, area.value.length), Math.min(caret, area.value.length)));
}


/** Re-fits the editor rows when its width changes; Nuxt UI only measures on mount and on input, so a draft measured while the column was narrow stays too tall. */
function fit_editor() {
  const editor = prompt.value?.textareaRef;
  if (!editor) return;
  editor.rows = 1;
  const style = getComputedStyle(editor);
  const lines = (editor.scrollHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)) / parseFloat(style.lineHeight);
  editor.rows = Math.min(Math.max(Math.floor(lines), 1), EDITOR_MAX_ROWS);
}
let editor_width = 0;
const editor_observer = new ResizeObserver(([entry]) => {
  if (Math.round(entry.contentRect.width) === editor_width) return;
  editor_width = Math.round(entry.contentRect.width);
  fit_editor();
});
onMounted(() => prompt.value?.textareaRef && editor_observer.observe(prompt.value.textareaRef));
onBeforeUnmount(() => editor_observer.disconnect());
// The composer floats over the transcript's lower edge; the transcript keeps its height clear below the last card, and
// a taller or shorter composer (lines, files, notes cleared on send) keeps the latest card in view while the page follows
// the end. Written straight to the element inside the observer, which runs after layout and before paint: no Vue
// re-render of the room, and padding and scroll change in the same frame, so sending does not flash.
const composer_dock = ref(null);
// The room kept below the last card goes by whole steps: a composer a pixel or two taller or shorter (font rounding, a
// hint line, the browser's toolbars on a phone) changes nothing, where an exact copy moved the cards with every pixel.
const COMPOSER_ROOM_STEP = 24;
let composer_height = -1;
const dock_observer = new ResizeObserver(([entry]) => {
  const height = Math.ceil(entry.target.offsetHeight / COMPOSER_ROOM_STEP) * COMPOSER_ROOM_STEP;
  if (height === composer_height) return;
  composer_height = height;
  entry.target.parentElement?.style.setProperty("--channel-composer-height", `${height}px`);
  if (!follow_tail.value || !transcript.value) return;
  if (reader_busy()) { follow_pending = true; arm_settle(); }
  else write_scroll(transcript.value, transcript.value.scrollHeight);
});
onMounted(() => composer_dock.value && dock_observer.observe(composer_dock.value));
// Cards that fill in after the messages (run reports, scheduler cards, process notes, a card measured once it nears the
// screen) make the transcript taller without changing the messages, so a room just opened ended short of its end
// (2026-11-16: 70–357px measured on first opening a room). While following the end, any growth of a message group
// lands there again. Reading earlier cards where the browser does not keep the position (WebKit), growth above the
// reading line (an image taking its size, a report filling in) is offset by hand (keep_reading). Neither moves the page
// while the reader scrolls: a snap to the end during a swipe's momentum fought the reader and jumped the page
// (2026-11-17 recording); both run once they stop (release_reader). A send glide keeps its own course.
const growth_observer = new ResizeObserver(() => {
  const element = transcript.value;
  if (!element || glide.isAnimating() || toggle_hold) return;
  if (!follow_tail.value) { keep_reading(); return; }
  if (reader_busy()) { follow_pending = true; arm_settle(); return; }
  const bottom = element.scrollHeight - element.clientHeight;
  if (Math.abs(element.scrollTop - bottom) > 1) write_scroll(element, bottom);
});
const group_observer = new MutationObserver(() => {
  growth_observer.disconnect();
  for (const group of transcript.value?.children || []) growth_observer.observe(group);
});
onMounted(() => {
  if (!transcript.value) return;
  for (const group of transcript.value.children) growth_observer.observe(group);
  group_observer.observe(transcript.value, { childList: true });
});
onBeforeUnmount(() => { group_observer.disconnect(); growth_observer.disconnect(); });
// `?scrolldebug` on the address: an on-screen log of every change to the transcript's scroll position, telling the page's
// own writes (with where they came from) from the browser's, with the heights involved. For movement that only a real
// phone shows; nothing is installed without the parameter.
onMounted(() => {
  let enabled = false;
  try { enabled = sessionStorage.getItem("scrolldebug") === "1"; } catch { /* Storage may be unavailable. */ }
  if (!enabled || !transcript.value) return;
  const element = transcript.value, lines = [];
  const panel = Object.assign(document.createElement("pre"), { title: "scrolldebug" });
  Object.assign(panel.style, { position: "fixed", left: "0", right: "0", top: "0", maxHeight: "38vh", overflow: "auto", zIndex: "9999", margin: "0",
    padding: "4px 6px", font: "10px/1.35 ui-monospace,monospace", color: "#7f7", background: "rgba(0,0,0,.82)", whiteSpace: "pre-wrap", userSelect: "text" });
  const state = () => `h=${element.scrollHeight} c=${element.clientHeight} vv=${window.visualViewport?.height.toFixed(1)} ih=${window.innerHeight} pad=${getComputedStyle(element.parentElement).getPropertyValue("--channel-composer-height")} pre=${getComputedStyle(element).getPropertyValue("--preload-pad") || 0}`;
  const log = (text) => {
    lines.push(`${(performance.now() / 1000).toFixed(2)} ${text}`);
    if (lines.length > 120) lines.shift();
    panel.textContent = lines.join("\n");
  };
  const native = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
  const origin = () => (new Error().stack || "").split("\n").slice(3, 6).map((line) => line.trim().replace(/^at\s+/, "").slice(0, 48)).join(" < ");
  Object.defineProperty(element, "scrollTop", { configurable: true, get() { return native.get.call(this); }, set(value) {
    const before = native.get.call(this);
    native.set.call(this, value);
    const after = native.get.call(this);
    if (Math.abs(after - before) >= 0.5) { written = after; log(`SET ${before.toFixed(1)}→${after.toFixed(1)} ${state()} by ${origin()}`); }
  } });
  for (const name of ["scrollBy", "scrollTo"]) {
    const call = element[name].bind(element);
    element[name] = (...args) => { log(`${name.toUpperCase()} ${JSON.stringify(args).slice(0, 60)} by ${origin()}`); return call(...args); };
  }
  let last = element.scrollTop, written = null;
  element.addEventListener("scroll", () => {
    const now = element.scrollTop;
    if (Math.abs(now - last) >= 0.5 && now !== written) log(`scroll ${last.toFixed(1)}→${now.toFixed(1)} ${state()}`);
    last = now; written = null;
  }, { passive: true });
  new ResizeObserver(() => log(`resize ${state()}`)).observe(element);
  log(`start ${state()} ua=${navigator.userAgent.slice(0, 60)}`);
  document.body.append(panel);
});
onBeforeUnmount(() => dock_observer.disconnect());
onBeforeUnmount(stop_scrub);

const COPY_FEEDBACK_MS = 2000;
const launch_copied = ref("");
let launch_copy_timer;
/** Clear the composer copy feedback when it expires or the arrangement changes. */
function reset_launch_copy() {
  clearTimeout(launch_copy_timer);
  launch_copied.value = "";
}
/** Confirm the copy only after the clipboard write succeeds for this member in this room. */
async function copy_launch(name) {
  const room_id = room.value.id;
  reset_launch_copy();
  if (!await act("copy_member_launch", name)) return;
  if (room.value?.id !== room_id) return;
  launch_copied.value = name;
  launch_copy_timer = setTimeout(reset_launch_copy, COPY_FEEDBACK_MS);
}
watch([() => room.value?.id, () => speaking_turn.value?.id], reset_launch_copy);
onBeforeUnmount(reset_launch_copy);

/** The user message a free-room execution was working on, when the owner can see it in the loaded history. */
function request_message(report) {
  if (!view.value.access?.can_manage) return null;
  const request = report.requests?.find((item) => item.discussion_session_id);
  const id = request ? request.source_message_id : report.request_message_id;
  return view.value.messages.find((message) => message.id === id && !message.withdrawn && (!request || message.author === "用户"));
}
function failed_request_message(report) {
  return report.status === "failed" ? request_message(report) : null;
}
/** A failed execution still holding its requests can be sent again as is; discussion turns are rearranged by the host instead. */
function can_retry(report) {
  return Boolean(view.value.access?.can_manage && report.requests?.length && !report.requests.some((request) => request.discussion_session_id));
}
/** Explain the next action for classified failures; the original reason remains visible. */
function failure_advice(report) {
  return ({
    quota: t('额度已用尽，请等待重置或改派其他成员。'),
    auth: t('登录已失效，请在本机重新登录后再试。'),
    output_truncated: t('输出达到上限，请缩短要求的输出或拆分任务。'),
    compaction_failed: t('上下文压缩失败，请缩短输入或拆分任务后再试。'),
    policy_blocked: t('安全策略拒绝，请核对请求内容与服务许可要求，不要原样重试。'),
  })[report.failure_class] || '';
}
/** Put the original text back in the input for the user to send again; a named request keeps its @member. */
function resend_failed(report) {
  const original = request_message(report);
  if (!original) return;
  const request = (room.value.free?.requests || []).find((item) => report.request_ids?.includes(item.id));
  text.value = request?.purpose === "ask" && request.member ? `@${request.member} ${original.text}` : original.text;
  prompt.value?.textareaRef?.focus();
}

/**
 * The member and the rules to allow its refused operations. Only Claude Code and agy report rules, and allowing goes
 * through the local service; the original message must be loaded so it can be sent again.
 */
function denial_allowance(report) {
  const name = (room.value.free?.members || []).find((member) => member.id === report.member_id)?.name;
  const rules = [...new Set((report.denials || []).map((item) => item.rule).filter(Boolean))];
  return name && rules.length && view.value.launch?.available && request_message(report) ? { name, rules } : null;
}
const allowing = ref(0);
const allow_errors = ref({});
/** Add the rules to the member, then put the original message back for the user to send, as 重发 does. */
async function allow_and_resend(report) {
  const allowance = denial_allowance(report);
  if (!allowance || allowing.value) return;
  allowing.value = report.id;
  allow_errors.value = { ...allow_errors.value, [report.id]: "" };
  try {
    await bridge.allow_denials(allowance);
    resend_failed(report);
  } catch (error) { allow_errors.value = { ...allow_errors.value, [report.id]: error.message }; }
  finally { allowing.value = 0; }
}

/** Reuse the existing original-record actions in the message overflow menu; where retract and edit take the toolbar, reply moves here. */
function message_actions(message) {
  return [[
    ...(can_take_back(message) || has_private_chat(message) ? [{ label: t('回复'), icon: "i-lucide-corner-up-left", onSelect: () => reply_to(message) }] : []),
    ...(narrow.value && message.kind !== "receipt" && editing.value.id !== message.id ? [reader.state.message_id === message.id
      ? { label: t('停止朗读'), icon: "i-lucide-square", onSelect: () => reader.stop() }
      : { label: t('朗读'), icon: "i-lucide-volume-2", onSelect: () => reader.start(message.id) }] : []),
    { label: t('复制原文链接'), icon: "i-lucide-link", onSelect: () => copy_message(message) },
    { label: t('查看原文'), icon: "i-lucide-expand", onSelect: () => emit("detail", message.id) },
    ...(can_branch(message) && message.author !== "用户" ? [{ label: t('从这里分支'), icon: "i-lucide-git-branch", onSelect: () => act("fork_room", message.id) }] : []),
  ]];
}

/** An answer from an execution opens that execution in the private chat; the key takes the reply slot, and reply moves into the menu. */
const has_private_chat = (message) => Boolean(view.value.access?.can_manage && answer_execution(message) && editing.value.id !== message.id);

/** Retract, edit and branch work only on visible free-room history no discussion reaches: a discussion's host reads messages itself. */
const can_branch = (message) => free.value && view.value.access?.can_manage && !message.withdrawn
  && !(room.value.session?.started_message_id >= message.id)
  && !(room.value.discussions || []).some((item) => ["active", "paused"].includes(item.status) || item.started_message_id >= message.id);
/** The owner may take back their own message unless the room is archived. */
const can_take_back = (message) => can_branch(message) && message.author === "用户" && !room.value.archived;
/**
 * Retracting needs every request on the message still waiting, or the message to be the latest: retracting it then stops
 * the work on it and rewinds to just before it. Otherwise only editing takes it back.
 */
const can_retract = (message) => can_take_back(message) && (view.value.messages.at(-1)?.id === message.id
  || !(room.value.free?.requests || []).some((request) => request.message_id === message.id && ["delivering", "completed", "failed"].includes(request.status)));

const NO_EDIT = { id: 0, text: "", plan: null, error: "" };
const editing = ref(NO_EDIT);

// The member whose stop key was pressed, so only that working card shows the stop in progress.
const stopping_member = ref(null);
async function stop_member(message) {
  stopping_member.value = message.member_id;
  try { await act("change_member", { member_id: message.member_id, name: message.author, action: "interrupt" }); }
  finally { stopping_member.value = null; }
}

const NO_ITEMS = Object.freeze([]);
// The message whose retract is on its way, so its button shows progress at once instead of after the site answers.
const retracting_id = ref(0);
async function retract(id) {
  retracting_id.value = id;
  try { await act("retract_message", id); } finally { retracting_id.value = 0; }
}
/**
 * Everything a saved message card shows, read here in the transcript's render. The card's slots are run by the chat,
 * tooltip and menu components, which would otherwise track every reactive value the slots read and re-render all cards
 * on each room refresh; reading only this plain object, a card re-renders only when one of its `deps` changes.
 */
// Tooltips and the "more" menu cost most of a card's mount, and a long room mounts hundreds of cards. A card gets them
// once a mouse enters it (only a mouse shows tooltips) or its menu is first opened; until then its keys are bare buttons.
// The tooltips close as the pointer leaves their key and let the pointer through: one over the next key in the column
// took the hover off the card, which hid the keys, so clicking that key did nothing.
const KEY_TIP_UI = { content: "channel-key-tip" };
const armed_cards = reactive(new Set());
const menu_open_id = ref(0);
/** Renders its slot as is: the stand-in for a tooltip on a card no mouse has entered. */
const BareSlot = (_props, { slots }) => slots.default?.();
function arm_card(id, event) {
  if (event.pointerType === "mouse") armed_cards.add(id);
}
/** Mount the card's menu and open it: the first tap on its key, by touch or keyboard. */
function open_card_menu(id) {
  armed_cards.add(id);
  menu_open_id.value = id;
}
function message_card(message) {
  const execution = answer_execution(message);
  const reports = execution_reports.value.get(message.id);
  const edited = editing.value.id === message.id;
  const waits = waits_for_host(message);
  const card = {
    message, identity_version: view.value.admin?.identity_version, narrow: narrow.value, reading: reader.state.message_id === message.id,
    can_branch: can_branch(message), can_take_back: can_take_back(message), can_retract: can_retract(message), retracting: retracting_id.value === message.id, private_chat: has_private_chat(message),
    editing: edited, editing_plan: edited && editing.value.plan, editing_error: edited && editing.value.error, editing_pending: edited && pending.value,
    round_label: message_round_labels.value.get(message.id), expanded: expanded_answers.value.has(message.id), preview: answer_previews.value.get(message.id),
    marks: excerpt_marks.value.get(message.id) || NO_ITEMS, waits, speaking_expert: waits ? speaking_turn.value?.expert : null,
    badges: request_badges.value.get(message.id) || NO_ITEMS, elapsed: message_elapsed(message),
    recommendation: recommendations.value.get(message.id), adopting: adopting.value === message.id,
    execution_id: execution?.id, notes_count: execution?.notes, notes: execution ? execution_notes.value.get(execution.id) : undefined,
    reports: reports || NO_ITEMS, allowing: reports ? allowing.value : 0, allow_errors: reports ? allow_errors.value : null,
    launch_available: reports ? view.value.launch?.available : null, report_messages: reports ? view.value.messages : null,
    armed: armed_cards.has(message.id), menu_open: menu_open_id.value === message.id,
  };
  card.deps = Object.values(card);
  card.actions = message_actions(message);
  card.report_rows = card.reports.map((report) => ({ report, allowable: Boolean(denial_allowance(report)), failed: Boolean(failed_request_message(report)) }));
  return card;
}
/** Open the message for editing and read what sending the edit would take back. */
async function start_edit(message) {
  editing.value = { ...NO_EDIT, id: message.id, text: message.text };
  try {
    const plan = await bridge.rewind_plan(message.id);
    if (editing.value.id === message.id) editing.value = { ...editing.value, plan };
  } catch (error) { if (editing.value.id === message.id) editing.value = { ...editing.value, error: error.message }; }
}
function cancel_edit() { editing.value = NO_EDIT; }
/** Rewind to just before the message with the plan read on opening, then send the edited text in its place. */
async function submit_edit() {
  const { id, text: edited, plan } = editing.value;
  if (!plan || !edited.trim() || pending.value) return;
  follow_tail.value = true;
  if (await act("rewind_and_send", { message_id: id, revision: plan.revision, text: edited.trim() })) cancel_edit();
}
/** What the rewind does, in one line: how much it takes back and whose session goes back; members left as they were need no mention. */
function rewind_summary(plan) {
  const names = (session) => plan.members.filter((member) => member.session === session).map((member) => bridge.display_name(member.name)).join("、");
  return [t('将回退 {value1} 条记录（含这条），进行中的工作会停止', { value1: plan.messages }),
    names("cut") && t('{value1} 的会话退回到这条消息之前', { value1: names("cut") }),
    names("kept") && t('{value1} 的会话在其自己的窗口中，无法由本机回退', { value1: names("kept") }),
    t('成员已改动的文件不会撤销')].filter(Boolean).join("；") + "。";
}

/** Select the shared reply target and focus the library's chat editor. */
async function reply_to(message) { await act("reply", message); prompt.value?.textareaRef?.focus(); }
/** A `#123` written in a card's text opens message 123's original text, as the card's own `#id` does. */
// How long after a fold control is pressed its card is held in place: long enough for the content to render and any
// open/close transition to finish.
const TOGGLE_HOLD_MS = 700;
let toggle_hold = null;
/**
 * Pressing a fold control (anything with aria-expanded) changes only what lies below it: the card holding the control
 * keeps its place on screen, so the room grows or shrinks downward. Without this, following the end of the room
 * scrolled to the new bottom and the card above the control moved up instead (user 2026-11-17). The answer's own
 * "展开全文" keeps its own handling (toggle_answer).
 */
function keep_toggle_place(event) {
  const control = event.target.closest?.("[aria-expanded]");
  const element = transcript.value;
  if (!control || !element?.contains(control) || control.classList.contains("channel-answer-toggle")) return;
  const card = control.closest("[data-message-id], .channel-message, .channel-schedule-card") || control;
  const top = card.getBoundingClientRect().top;
  follow_tail.value = false;
  const until = performance.now() + TOGGLE_HOLD_MS;
  const hold = toggle_hold = { card };
  const step = () => {
    if (toggle_hold !== hold) return;
    if (!card.isConnected) { toggle_hold = null; return; }
    const drift = card.getBoundingClientRect().top - top;
    if (Math.abs(drift) >= 0.5) write_scroll(element, element.scrollTop + drift);
    if (performance.now() < until) requestAnimationFrame(step);
    else { toggle_hold = null; track_scroll(); }
  };
  requestAnimationFrame(step);
}

function open_message_ref(event) {
  const reference = event.target.closest("[data-message-ref]");
  if (reference) emit("detail", Number(reference.dataset.messageRef));
}

/** Send the shared draft through the established idempotent controller. */
async function send() {
  if (!has_draft.value || pending.value || view.value.sending_message) return;
  mention_context.value = null;
  follow_tail.value = true;
  const draft = text.value;
  const extra = [file_refs_line(), excerpts_markdown(excerpts.value)].filter(Boolean).join("\n\n");
  if (extra) text.value = draft.trim() ? `${draft.trimEnd()}\n\n${extra}` : extra;
  const sent_text = text.value;
  // The cards leave the composer with the text at once, as the message goes out; a failed send brings them back.
  const sent_refs = file_refs.value, sent_excerpts = file_preview.excerpts;
  if (extra) { file_refs.value = []; file_preview.excerpts = []; }
  const sent = await act("send");
  // Nothing was sent (another action was still running): the cards return and the text loses what they added. A send
  // that failed keeps everything in its failed card instead.
  if (extra && !sent && text.value === sent_text) {
    text.value = draft;
    file_refs.value = [...sent_refs, ...file_refs.value];
    file_preview.excerpts = [...sent_excerpts, ...file_preview.excerpts];
  }
  await follow_messages();
}

let last_escape = 0;
/**
 * Two Esc presses within a moment take back the latest own message, like its card's 撤回, and fill the text back in.
 * Only from an empty composer (or the page while the composer is locked for sending), so a draft is never at stake;
 * the site refuses once a member started on the message, and says so.
 */
function retract_shortcut(event) {
  if (event.key !== "Escape" || event.isComposing || event.defaultPrevented) return;
  const from_composer = event.target === prompt.value?.textareaRef || event.target === document.body;
  if (!from_composer || (has_draft.value && !view.value.sending_message)) { last_escape = 0; return; }
  if (event.timeStamp - last_escape > RETRACT_ESCAPE_WINDOW_MS) { last_escape = event.timeStamp; return; }
  last_escape = 0;
  event.preventDefault();
  // Called directly: the send in flight holds the shared action lock, and the controller waits for it to be saved.
  bridge.execute("retract_latest");
}
onMounted(() => window.addEventListener("keydown", retract_shortcut));
onBeforeUnmount(() => window.removeEventListener("keydown", retract_shortcut));

/** The chat prompt ignores empty text, so attachment-only drafts send on Enter here. */
function attachment_shortcut(event) {
  // An Enter already used to pick a suggestion (which may have just added a file card) must not also send.
  if (event.defaultPrevented || !ENTER_SENDS || event.key !== "Enter" || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.isComposing || text.value.trim()) return;
  if (!view.value.attachment_drafts.length && !file_refs.value.length && !excerpts.value.length) return;
  event.preventDefault();
  event.stopPropagation();
  send();
}

/** Copy a durable reference to the original record. */
function copy_message(message) { act("copy", `${view.value.room_site}/r/${room.value.id}/messages/${message.id}`); }

</script>

<template>
  <!-- One root element: the workspace hides this tab with v-show, which a fragment root would ignore. -->
  <section class="channel-conversation" role="tabpanel" :aria-label="t('消息')">
  <ExternalMemberDialog v-model:open="pending_seat_open" :member="pending_seat" />
    <div v-if="view.query || view.source_filter" class="channel-filter-summary"><span>{{ [view.query && `“${view.query}”`, [view.host_only && t('主持人'), ...view.authors.map((name) => bridge.display_name(name)), view.mention_only && `@${bridge.display_name('用户')}`, view.card_kinds.length && t('{value1} 类卡片', { value1: view.card_kinds.length })].filter(Boolean).join('、')].filter(Boolean).join(' · ') }} · {{ view.messages_loading ? t('正在筛选…') : t('{value1} 条结果', { value1: view.source_filter ? transcript_messages.length : view.total }) }}</span><UButton :label="t('清除筛选')" size="xs" variant="link" color="neutral" @click="search = ''; act('filter', { query: '', mention: false, host: false, authors: [], kinds: [] })" /></div>
    <nav v-if="view.messages.length" ref="message_map" class="channel-message-map" :style="{ '--nav-entry-height': `${NAV_ENTRY_HEIGHT}px` }" :aria-label="t('发言快速导航')" @wheel.stop.passive="browse_navigation" @pointerleave="close_preview" @focusout="close_preview" @keydown.esc.stop="close_preview" @contextmenu="navigation_context_menu" @pointerdown="start_scrub" @pointermove="move_scrub" @pointerup="end_scrub" @pointercancel="end_scrub">
      <div class="channel-map-track">
        <div v-for="section in navigation_sections" :key="section.entries[0].key"v-memo="[section, preview_open, active_round === section.number ? active_message : null, section_preview_position(section)]" class="channel-map-round" :style="{ '--round-message-count': section.count }">
          <!-- A free room is one long section, so each tick keeps its own memo: moving the reading position or the hover redraws only the ticks it reaches. -->
          <button v-for="item in section.entries" :key="item.key" v-memo="[item.message, item.label, item.index, active_message === item.message.id, item.message.id === (active_message || view.messages[0]?.id), preview_index < 0 ? -1 : Math.min(Math.abs(item.index - preview_index), NAV_HOVER_REACH), preview_open && preview_entry === item.key]" type="button" class="channel-navigation-entry" :class="item.round ? 'channel-round-range' : 'channel-message-jump'" :data-author="item.round ? undefined : bridge.identities[item.message.author]?.style" :data-jump-id="item.round ? undefined : item.message.id" :data-round-jump="item.round ? item.label : undefined" :aria-label="item.label" :tabindex="!item.round && item.message.id === (active_message || view.messages[0]?.id) ? 0 : -1" :aria-current="!item.round && active_message === item.message.id ? 'location' : undefined" :aria-describedby="preview_open && preview_entry === item.key ? 'channel-navigation-preview' : undefined" @pointerenter="hover_preview(item, $event)" @pointermove="hover_preview(item, $event)" @focus="focus_preview(item, $event)" @keydown="navigate_by_key($event, item.index)" @click="activate_navigation(item, $event)">
            <span v-if="item.round" class="channel-round-number" aria-hidden="true">{{ item.number || '' }}</span>
            <span v-else class="channel-jump-tick" aria-hidden="true" :style="tick_state(item, item.index)"></span>
          </button>
        </div>
      </div>
    </nav>
    <Teleport to="body">
      <motion.div v-if="preview" id="channel-navigation-preview" class="channel-nav-preview" role="tooltip" :aria-hidden="!preview_open" :inert="!preview_open" :data-open="preview_open" :style="{ left: preview_left, y: preview_y, x: preview_x, opacity: preview_opacity, scale: preview_scale, height: preview_height, '--preview-gap': `${PREVIEW_GAP}px` }" @pointerleave="close_preview" @focusout="close_preview" @keydown.esc.stop="close_preview">
        <div ref="preview_content" class="channel-nav-preview-content">
          <h3 v-if="preview_is_round" class="channel-nav-preview-round">{{ preview_round }}</h3>
          <div class="channel-nav-preview-header">
            <UAvatar :src="bridge.identities[preview.author]?.icon" :text="bridge.identities[preview.author]?.initials || '?'" :alt="bridge.display_name(preview.author)" size="sm" class="channel-avatar" :class="bridge.identities[preview.author]?.style" />
            <strong>{{ bridge.display_name(preview.author) }}</strong><span>#{{ preview.id }}</span>
          </div>
          <div class="channel-nav-preview-meta">{{ preview_round }} · {{ bridge.sources[preview.source] }} · {{ bridge.format_time(preview.created_at) }}<span v-if="preview.kind === 'moderation'"> {{ t('· 主持人') }}</span><span v-else-if="preview.kind === 'receipt'"> {{ t('· 运行回执') }}</span></div>
          <div class="channel-nav-preview-text markdown-body" v-html="preview.summary ? preview.rendered_summary : preview.rendered_text"></div>
        </div>
      </motion.div>
    </Teleport>
    <div v-if="listen_here && !listen_here.touch" class="channel-offer-marks" :style="{ left: `${listen_here.left}px`, top: `${listen_here.top}px` }">
      <button type="button" class="channel-listen-mark" :title="t('把选中的文字作为注释添加到对话')" @mousedown.prevent @click="start_quote"><UIcon name="i-lucide-message-square-quote" />{{ t('添加到对话') }}</button>
      <button v-if="listen_here.speech" type="button" class="channel-listen-mark" :title="t('从选中处开始朗读')" :aria-label="t('从选中处开始朗读')" @mousedown.prevent @click="listen_from_selection"><UIcon name="i-lucide-headphones" />{{ t('听当前') }}</button>
    </div>
    <form v-if="quoting" class="selection-comment" :class="{ 'is-docked': quoting.touch }" :style="quoting.touch ? {} : { left: `${quoting.left}px`, top: `${quoting.top}px` }" @submit.prevent="submit_quote">
      <textarea ref="quote_input" v-model="quote_comment" rows="1" :placeholder="t('添加批注（可选）')" :aria-label="t('注释的批注（可选）')" enterkeyhint="send" @keydown="quote_keydown"></textarea>
      <button type="button" class="selection-comment-cancel" :aria-label="t('取消添加')" :title="t('取消')" @click="cancel_quote"><UIcon name="i-lucide-x" /></button>
      <button type="submit" class="selection-comment-send" :aria-label="t('添加到对话')" :title="t('添加到对话（Enter）')"><UIcon name="i-lucide-arrow-up" /></button>
    </form>
    <ExcerptEditCard v-if="mark_editing" :key="mark_editing.excerpt.id" :class="{ 'is-docked': mark_editing.touch }" :comment="mark_editing.excerpt.comment" :context="mark_editing.touch ? mark_context(mark_editing.excerpt) : ''" :style="mark_editing.touch ? {} : { left: `${mark_editing.left}px`, top: `${mark_editing.top}px` }" @save="save_mark" @cancel="close_mark" @remove="remove_mark" />
    <div ref="transcript" v-memo="transcript_memo([message_groups,view.messages_loading, view.messages_failure, view.sending_preview, view.failed_sends, message_round_labels, free, room.session, can_manage, expanded_answers.size, reader.state.message_id, room.title, view.query, view.source_filter, view.authors, view.card_kinds, topic_anchor, end_anchor, request_badges, execution_reports, recommendations, adopting, scheduler_decisions, host_arrangements, pending, execution_notes, open_working_notes, editing, rewound_runs, retracting_id, armed_cards.size, menu_open_id, stopping_member, free_now, allowing, allow_errors, late_answers, has_draft, view.sending_message, routing_messages, speaking_turn, room.free])" class="channel-transcript" :aria-label="t('聊天记录')" @click.capture="keep_toggle_place" @click="open_message_ref" @scroll="schedule_track_scroll" @wheel.passive="resume_tracking($event); stop_following($event)" @touchstart.passive="resume_tracking" @touchmove.passive="stop_following" @touchend.passive="end_touch" @touchcancel.passive="end_touch" @pointerdown="stop_following" @keydown="resume_tracking($event); stop_following($event)">
      <div v-if="!view.query && !view.source_filter && !topic_anchor && render_start === 0" class="channel-message-group channel-topic-group"><TopicCard :ref="(card) => topic_card = card" @edit="emit('edit')" /></div>
      <div v-for="group in message_groups" :key="group.key" class="channel-message-group">
        <USeparator :label="group.label" class="channel-date-divider" />
        <template v-for="message in group.messages" :key="message.id">
        <DiscussionEndCard v-if="message.id === end_anchor && !view.query && !view.source_filter" />
        <TopicCard v-if="message.id === topic_anchor && !view.query && !view.source_filter" :ref="(card) => topic_card = card" @edit="emit('edit')" />
        <!-- A free-room working card holds the slot its answer will take. -->
        <ScheduleCard v-if="message.arrangement" icon="i-lucide-list-ordered" plain :title="t('主持人创建的发言安排')" :label="t('主持人安排')" :toggle-label="t('展开或收起各专家的任务')">
          <template #text>{{ t('主持人安排：{value1}', { value1: host_arrangements.get(message.arrangement.after_message_id)?.find((plan) => plan.id === message.arrangement.id)?.label }) }}<small v-if="message.arrangement.after_message_id">{{ t('耗时 {value1}', { value1: format_elapsed(arrangement_seconds(message.arrangement, view.messages.find((item) => item.id === message.arrangement.after_message_id))) }) }}</small></template>
          <p v-for="turn in message.arrangement.turns" :key="`${message.id}-${turn.expert}-${turn.question}`"><span>{{ bridge.display_name(turn.expert) }}：{{ turn.question }}</span></p>
        </ScheduleCard>
        <GoalNoticeCard v-else-if="message.source === 'goal'" :message="message" />
        <ScheduleCard v-else-if="message.source === 'notice' && quiet_checkins.has(message.id)" icon="i-lucide-bell" plain :label="t('定时检查')" :toggle-label="t('展开或收起主持人的检查回复')">
          <template #text><span class="channel-checkin-line">{{ t('定时检查 · {value1}：{value2}', { value1: bridge.display_name(quiet_checkins.get(message.id).author), value2: quiet_checkins.get(message.id).text.replace(/^定时检查[：:]\s*/, '') }) }}</span></template>
          <p>{{ message.text }}</p>
          <p class="channel-checkin-answer">{{ quiet_checkins.get(message.id).text }}</p>
        </ScheduleCard>
        <ScheduleCard v-else-if="message.source === 'notice'" icon="i-lucide-bell" plain fold :label="t('程序通知主持人')">
          <template #text>{{ message.text }}</template>
          <p class="channel-checkin-answer">{{ message.text }}</p>
        </ScheduleCard>
        <!-- Stopped, voided or skipped work keeps the member's ordinary message card (avatar, name, time), with a stop badge
             in the name row and the reason as its text, so it reads as that member's turn that was cut short (user
             2026-11-18, replacing the 11-17 one-line event card). -->
        <UChatMessage v-else-if="message.cancelled_turn || message.cancelled_execution" :id="message.id" :data-author="bridge.identities[message.author]?.style" role="assistant" :parts="[]" side="left" variant="naked" color="neutral" class="channel-message is-voided" :ui="{ header: 'channel-message-header', container: 'channel-message-container', body: 'channel-message-body' }">
          <template #body>
            <div class="channel-message-byline">
              <UAvatar :src="bridge.identities[message.author]?.icon" :text="bridge.identities[message.author]?.initials || '?'" :alt="bridge.display_name(message.author)" size="md" class="channel-avatar" :class="bridge.identities[message.author]?.style" />
              <div class="channel-message-meta"><div class="channel-message-author"><strong>{{ bridge.display_name(message.author) }}</strong><UBadge size="xs" color="warning" variant="soft" class="channel-source" :icon="message.cancelled_turn ? 'i-lucide-skip-forward' : 'i-lucide-circle-stop'">{{ message.cancelled_turn ? t('已跳过') : stop_state(message.cancelled_execution).label }}</UBadge></div></div>
              <span class="channel-message-provenance channel-message-elapsed">{{ message.cancelled_turn ? t('安排 #{value1}', { value1: message.cancelled_turn.display_id || message.cancelled_turn.id }) : t('执行 #{value1}', { value1: message.execution_id }) }}</span>
            </div>
            <div class="channel-message-text channel-stop-reason" role="status"><span>{{ message.cancelled_turn ? t('本次发言已被跳过或取消，未回答。') : stop_reason_text(message.cancelled_execution.result) || t('本次执行已作废，未回答。') }}</span></div>
            <template v-for="execution in [voided_detail(message)].filter(Boolean)" :key="execution.id">
              <p class="channel-message-text channel-stop-note">{{ stop_state(execution).note }}</p>
              <details v-if="execution.late_answer && view.access?.can_manage" class="channel-receipt" @toggle="load_late_answer(execution.id, $event)">
                <summary :aria-label="t('查看 {value1} 未采纳的回答', { value1: bridge.display_name(execution.member) })">{{ t('未采纳的回答') }}</summary>
                <div class="channel-message-text channel-late-answer">{{ late_answers.get(execution.id)?.text ?? t('正在读取…') }}</div>
              </details>
            </template>
          </template>
        </UChatMessage>
        <!-- Work in progress is a compact card: who and how long, the stage as the main line with the stop key at its end, -->
        <!-- and the notes below as a subordinate thread, folded to the latest note with the count after it. -->
        <div v-else-if="message.slot_card && !message.failure && !message.retry" :id="`execution-${message.id}`" class="channel-working-strip" :data-author="bridge.identities[message.author]?.style">
          <div class="channel-working-head">
            <UAvatar :src="bridge.identities[message.author]?.icon" :text="bridge.identities[message.author]?.initials || '?'" :alt="bridge.display_name(message.author)" size="2xs" class="channel-avatar" :class="bridge.identities[message.author]?.style" />
            <strong class="channel-working-name">{{ bridge.display_name(message.author) }}</strong>
            <UTooltip v-if="message.background" :text="t('后台进行：主持人没有等它，接着在做别的')"><UIcon name="i-lucide-split" class="channel-working-background" role="img" :aria-label="t('后台进行：主持人没有等它')" /></UTooltip>
            <small class="channel-working-elapsed">{{ message.waiting ? t('手动启动{value1}', { value1: message.created_at ? t(' · 已等 {value1}', { value1: format_elapsed(Math.max(0, free_now - message.created_at)) }) : '' }) : t('已用 {value1}', { value1: format_elapsed(Math.max(0, free_now - message.created_at)) }) }}{{ message.steps ? t(' · 已执行 {value1} 步', { value1: message.steps }) : '' }}{{ message.attempt ? t(' · 第 {value1}/{value2} 次重试', { value1: message.attempt, value2: MAX_DELIVERY_RETRIES }) : '' }}</small>
            <UTooltip v-if="view.access?.can_manage && shows_progress(message) && message.execution_id" :text="t('私聊：查看它正在做什么')"><UButton icon="i-lucide-message-square" class="channel-private-chat-key channel-corner-key" size="xs" variant="ghost" color="neutral" :aria-label="t('私聊 {value1}：查看本次执行过程', { value1: bridge.display_name(message.author) })" @click="open_private_chat(act, message.author, message.execution_id)" /></UTooltip>
          <span v-if="view.access?.can_manage" class="channel-working-actions">
              <!-- In a discussion, stopping the current speaker skips the turn so the next one speaks. -->
              <template v-if="speaking_turn?.expert === message.author && message.discussion_request">
                <UTooltip :text="t('暂停讨论')"><UButton icon="i-lucide-pause" size="xs" variant="ghost" color="neutral" :aria-label="t('暂停讨论，停止 {value1} 本次发言', { value1: bridge.display_name(message.author) })" :disabled="!!pending" :loading="pending === 'pause_discussion'" @click="act('pause_discussion')" /></UTooltip>
                <UTooltip :text="t('停止本次发言，轮到下一位')"><UButton variant="solid" color="neutral" class="channel-stop-button" :aria-label="t('停止 {value1} 本次发言，轮到下一位', { value1: bridge.display_name(message.author) })" :disabled="!!pending" :loading="pending === 'skip_turn'"
                  @click="act('skip_turn')"><span class="channel-stop-square" /></UButton></UTooltip>
              </template>
              <UTooltip v-else :text="t('停止')"><UButton variant="solid" color="neutral" class="channel-stop-button" :aria-label="t('停止 {value1} 本次执行', { value1: bridge.display_name(message.author) })" :disabled="!!pending"
                :loading="pending === 'change_member' && stopping_member === message.member_id" @click="stop_member(message)"><span class="channel-stop-square" /></UButton></UTooltip>
          </span>
          </div>
          <!-- Private chat, as on the answered card: in the hover column outside the strip with a mouse; on touch screens the
               head-row key above takes the right end and the stop key moves to the bottom-right corner. -->
          <template v-if="view.access?.can_manage && shows_progress(message) && message.execution_id">
            <div class="channel-message-actions"><div class="channel-message-stack"><div class="channel-message-toolbar channel-message-corner">
              <UTooltip :text="t('私聊：查看它正在做什么')"><UButton icon="i-lucide-message-square" class="channel-private-chat-key" size="xs" variant="ghost" color="neutral" :aria-label="t('私聊 {value1}：查看本次执行过程', { value1: bridge.display_name(message.author) })" @click="open_private_chat(act, message.author, message.execution_id)" /></UTooltip>
            </div></div></div>
          </template>
          <div class="channel-working-main">
            <span v-for="status in [working_status(message)]" :key="message.id" class="channel-working-status" :class="{ 'channel-working-warning': status.warning }" role="status" :title="shows_progress(message) ? (message.waiting ? message.text : status.text) : t('此接入方式看不到进度，可在原窗口查看')">
              <span v-if="message.waiting">{{ message.text }}</span>
              <WorkingText v-else-if="status.live" :text="status.text" :seed="message.author" :beat="message.activity_at" :silent="free_now - (message.activity_at || message.created_at)" dots :muted="!shows_progress(message)" />
              <span v-else>{{ status.text }}</span>
            </span>
          </div>
          <div v-for="notes in [working_notes(message)].filter((list) => list.length)" :key="message.execution_id" class="channel-working-notes" :class="{ 'is-open': open_working_notes.has(message.execution_id), 'is-single': notes.length === 1 }">
            <template v-if="open_working_notes.has(message.execution_id)"><p v-for="note in notes.slice(0, -1)" :key="note.seq">{{ note.text }}</p></template>
            <p class="channel-working-latest" @click="notes.length === 1 || open_working_notes.has(message.execution_id) || toggle_working_notes(message.execution_id)">
              <span class="channel-working-latest-text">{{ notes.at(-1).text }}</span>
              <button v-if="notes.length > 1" type="button" class="channel-working-count" :aria-expanded="open_working_notes.has(message.execution_id)" :aria-label="open_working_notes.has(message.execution_id) ? t('收起过程说明') : t('展开全部 {value1} 段过程说明', { value1: notes.length })" @click.stop="toggle_working_notes(message.execution_id)">{{ t('{value1} 段', { value1: notes.length }) }}<UIcon name="i-lucide-chevron-down" /></button>
            </p>
          </div>
        </div>
        <!-- Waiting to redeliver keeps the full card: the reason and its buttons do not fit one line. -->
        <UChatMessage v-else-if="message.slot_card && !message.failure" :id="`execution-${message.id}`" :data-author="bridge.identities[message.author]?.style" role="assistant" :parts="[]" side="left" variant="naked" color="neutral" class="channel-message" :ui="{ header: 'channel-message-header', container: 'channel-message-container', body: 'channel-message-body' }">
          <template #body>
            <div class="channel-message-byline">
              <UAvatar :src="bridge.identities[message.author]?.icon" :text="bridge.identities[message.author]?.initials || '?'" :alt="bridge.display_name(message.author)" size="md" class="channel-avatar" :class="bridge.identities[message.author]?.style" />
              <div class="channel-message-meta">
                <div class="channel-message-author"><strong>{{ bridge.display_name(message.author) }}</strong></div>
                <div class="channel-message-provenance"><template v-if="message.created_at"><time :title="new Date(message.created_at * 1000).toLocaleString(locale)">{{ bridge.format_time(message.created_at * 1000) }}</time> · </template>{{ message.waiting ? t('手动启动{value1}', { value1: message.created_at ? t(' · 已等 {value1}', { value1: format_elapsed(Math.max(0, free_now - message.created_at)) }) : '' }) : t('已用 {value1}', { value1: format_elapsed(Math.max(0, free_now - message.created_at)) }) }}</div>
              </div>
            </div>
            <div class="channel-working-row">
              <div v-for="status in [working_status(message)]" :key="message.id" class="channel-message-text" :class="{ 'channel-working-warning': status.warning }" role="status" :aria-label="`${bridge.display_name(message.author)} ${status.text}`" :title="shows_progress(message) ? undefined : t('此接入方式看不到进度，可在原窗口查看')">
                <span v-if="message.waiting">{{ message.text }}</span>
                <WorkingText v-else-if="status.live" :text="status.text" :seed="message.author" :beat="message.activity_at" :silent="free_now - (message.activity_at || message.created_at)" dots :muted="!shows_progress(message)" />
                <span v-else>{{ status.text }}</span>
              </div>
            </div>
            <template v-if="message.retry">
              <p class="channel-message-text channel-failure-reason is-warning">{{ message.retry.reason }}</p>
              <div class="channel-failure-actions">
                <span class="channel-message-provenance">{{ t('{value1}（第 {value2}/{value3} 次）', { value1: message.retry.retry_at > free_now ? t('{value1} 秒后自动重试', { value1: message.retry.retry_at - free_now }) : t('正在重试'), value2: message.retry.attempt, value3: MAX_DELIVERY_RETRIES }) }}</span>
                <template v-if="view.access?.can_manage">
                  <UButton :label="t('立即重试')" icon="i-lucide-rotate-ccw" size="sm" variant="soft" color="primary" :aria-label="t('立即重新投递给 {value1}', { value1: bridge.display_name(message.author) })" :disabled="!!pending"
                    @click="act('retry_delivery', { execution_id: message.execution_id, action: 'retry_now' })" />
                  <UButton :label="t('停止')" icon="i-lucide-circle-stop" size="sm" variant="soft" color="error" :aria-label="t('停止自动重试 {value1} 的投递', { value1: bridge.display_name(message.author) })" :disabled="!!pending"
                    @click="act('retry_delivery', { execution_id: message.execution_id, action: 'retry_stop' })" />
                </template>
              </div>
            </template>
            <!-- The same row the answer keeps folded after its result: open while working. -->
            <ExecutionNotes v-if="execution_notes.get(message.execution_id)?.length" live :notes="execution_notes.get(message.execution_id)" />
          </template>
        </UChatMessage>
        <section v-else-if="message.failure" :id="message.id" class="channel-message channel-failed-execution" :data-author="bridge.identities[message.author]?.style" :aria-label="`${bridge.display_name(message.author)} ${message.undeliverable ? t('无法投递') : t('执行失败')}`">
          <div class="channel-message-byline">
            <UAvatar :src="bridge.identities[message.author]?.icon" :text="bridge.identities[message.author]?.initials || '?'" :alt="bridge.display_name(message.author)" size="md" class="channel-avatar" :class="bridge.identities[message.author]?.style" />
            <div class="channel-message-meta">
              <div class="channel-message-author"><strong>{{ bridge.display_name(message.author) }}</strong><span v-if="message.failure.role === 'host'" class="channel-message-round">{{ t('主持工作') }}</span><UBadge :label="message.undeliverable ? t('无法投递') : t('执行失败')" color="error" variant="soft" size="xs" /></div>
              <div v-for="at in [message.slot_card ? message.created_at * 1000 : message.created_at]" :key="message.id" class="channel-message-provenance"><time :title="new Date(at).toLocaleString(locale)">{{ bridge.format_time(at) }}</time><span v-if="message.failure.id">{{ t('执行 #{value1}', { value1: message.failure.id }) }}</span></div>
            </div>
            <span v-if="message.failure.elapsed_seconds != null" class="channel-message-provenance channel-message-elapsed">{{ t('耗时 {value1}', { value1: format_elapsed(message.failure.elapsed_seconds) }) }}</span>
          </div>
          <!-- Same row as the working card it replaced: retry takes the stop button's place. -->
          <div class="channel-working-row">
            <p class="channel-message-text channel-failure-reason">{{ message.failure.result || t('执行失败，未提供原因') }}</p>
            <div v-if="can_retry(message.failure)" class="channel-working-actions">
              <UTooltip :text="t('重试')"><UButton icon="i-lucide-rotate-cw" variant="solid" color="neutral" class="channel-stop-button channel-retry-button" :aria-label="t('把执行 #{value1} 的请求重新派给 {value2}', { value1: message.failure.id, value2: bridge.display_name(message.author) })"
                :disabled="!!pending" :loading="pending === 'retry_delivery'" @click="act('retry_delivery', { execution_id: message.failure.id, action: 'retry' })" /></UTooltip>
            </div>
          </div>
          <!-- A retried failure stays in place; the retry's own card follows it under the same message. The note sits under
               the reason, full width, so a long reason is not squeezed into half the card beside it. -->
          <p v-if="message.failure.retried" class="channel-message-provenance channel-retried-note"><UIcon name="i-lucide-corner-down-right" />{{ t('已重试，新的执行接在下方') }}</p>
          <p v-if="failure_advice(message.failure)" class="channel-message-text">{{ failure_advice(message.failure) }}</p>
          <ExecutionNotes v-if="message.failure.notes" :count="message.failure.notes" :notes="execution_notes.get(message.failure.id)" :load="() => load_notes(message.failure.id)" />
          <ExecutionDenials v-if="message.failure.denials?.length" :denials="message.failure.denials" :allowable="Boolean(denial_allowance(message.failure))"
            :busy="allowing === message.failure.id" :error="allow_errors[message.failure.id]" @allow="allow_and_resend(message.failure)" />
        </section>
        <div v-else-if="message.withdrawn" :id="String(message.id)" :data-message-id="message.id" class="channel-withdrawn" :data-author="bridge.identities[message.author]?.style">
          <UIcon :name="message.withdrawn === 'retracted' ? 'i-lucide-undo-2' : 'i-lucide-history'" class="channel-withdrawn-icon" />
          <span v-if="message.withdrawn === 'retracted'">{{ t('{value1} 撤回了一条消息', { value1: bridge.display_name(message.author) }) }}</span>
          <template v-else-if="rewound_runs.runs.has(message.id) && !expanded_rewinds.has(message.id)">
            <span>{{ t('已回退 {value1} 条记录', { value1: rewound_runs.runs.get(message.id) }) }}</span>
            <UButton :label="t('展开')" size="xs" variant="link" color="neutral" :aria-label="t('展开从 #{value1} 起已回退的记录', { value1: message.id })" @click="toggle_rewound(message.id)" />
          </template>
          <template v-else>
            <strong>{{ bridge.display_name(message.author) }}</strong><span class="channel-withdrawn-text">{{ message.text }}</span>
            <UButton :label="`#${message.id}`" size="xs" variant="link" color="neutral" :aria-label="t('查看已回退的原文 #{value1}', { value1: message.id })" @click="emit('detail', message.id)" />
            <UButton v-if="rewound_runs.runs.has(message.id)" :label="t('收起')" size="xs" variant="link" color="neutral" :aria-label="t('收起从 #{value1} 起已回退的记录', { value1: message.id })" @click="toggle_rewound(message.id)" />
          </template>
        </div>
        <template v-else>
        <!-- Each card keeps its own render cache and reads only its card object; a room refresh re-renders only the cards whose inputs changed. -->
        <template v-for="card in [message_card(message)]" :key="message.id">
        <MemoBlock :deps="card.deps">
        <UChatMessage :id="String(message.id)" :data-message-id="message.id" :data-author="bridge.identities[message.author]?.style" tabindex="-1" @pointerenter="card.armed || arm_card(message.id, $event)" :role="message.author === '用户' ? 'user' : 'assistant'" :parts="[]" side="left" variant="naked" color="neutral" class="channel-message" :ui="{ header: 'channel-message-header', container: 'channel-message-container', body: 'channel-message-body' }">
          <template #body>
            <div class="channel-message-byline">
              <UAvatar :src="bridge.identities[message.author]?.icon" :text="bridge.identities[message.author]?.initials || '?'" :alt="bridge.display_name(message.author)" size="md" class="channel-avatar" :class="bridge.identities[message.author]?.style" />
              <div class="channel-message-meta">
                <div class="channel-message-author"><strong>{{ bridge.display_name(message.author) }}</strong><span class="channel-message-round">{{ card.round_label }}</span><UBadge size="xs" color="neutral" variant="soft" class="channel-source">{{ bridge.sources[message.source] }}</UBadge><UBadge v-if="message.kind === 'moderation'" size="xs" color="neutral" variant="soft" class="channel-source">{{ t('主持人') }}</UBadge><UBadge v-if="message.kind === 'receipt'" size="xs" color="neutral" variant="soft" class="channel-source">{{ t('运行回执') }}</UBadge><UBadge v-if="message.proactive" size="xs" color="neutral" variant="soft" class="channel-source" :title="t('成员在自己的窗口里应用户要求主动发言，不是在回答房间的请求')">{{ t('主动发言') }}</UBadge><UBadge v-if="card.waits" size="xs" color="warning" variant="soft" class="channel-source" :title="card.speaking_expert ? t('{value1} 说完后交给主持人处理', { value1: bridge.display_name(card.speaking_expert) }) : t('等待主持人处理')">{{ t('待主持人处理') }}</UBadge><template v-for="badge in card.badges" :key="badge.key"><span class="channel-source" :title="badge.title">{{ badge.label }}<span v-if="badge.title"> &middot; {{ badge.title }}</span></span><UButton v-if="badge.answer_id" :label="badge.answer_label" size="xs" color="neutral" variant="link" class="channel-message-reference" @click="locate({ id: badge.answer_id })" /></template></div>
                <div class="channel-message-provenance"><time :title="new Date(message.created_at).toLocaleString(locale)">{{ bridge.format_time(message.created_at) }}</time><UButton :label="`#${message.id}`" color="neutral" variant="link" size="xs" :aria-label="t('查看原文 #{value1}', { value1: message.id })" class="channel-message-id" @click="emit('detail', message.id)" /><span v-if="message.submitted_by && message.submitted_by !== message.author && !(message.source === 'proxy' && message.submitted_by === '用户')">{{ t('{value1} 代发', { value1: bridge.display_name(message.submitted_by) }) }}</span><span v-if="message.source === 'auto'" :title="t('成员结束时没有提交回答，本机服务把它最后一段回复收录为本次回答')">{{ t('自动收录') }}</span></div>
              </div>
              <span v-if="card.elapsed !== null" class="channel-message-provenance channel-message-elapsed">{{ t('耗时 {value1}', { value1: format_elapsed(card.elapsed) }) }}</span>
            </div>
            <UButton v-if="message.reply_to" :label="t('回复 #{value1}', { value1: message.reply_to })" icon="i-lucide-corner-up-left" variant="link" color="neutral" size="xs" class="channel-message-reference" :aria-label="t('回复 #{value1} 查看原文', { value1: message.reply_to })" @click="emit('detail', message.reply_to)" />
            <details v-if="message.kind === 'receipt'" class="channel-receipt">
              <summary :aria-label="t('查看运行回执 #{value1}', { value1: message.id })">{{ t('运行回执详情') }}</summary>
              <div class="channel-message-text markdown-body" v-html="message.rendered_text"></div>
            </details>
            <form v-else-if="card.editing" class="channel-edit" :aria-label="t('编辑消息 #{value1}', { value1: message.id })" @submit.prevent="submit_edit">
              <textarea v-model="editing.text" rows="3" :maxlength="bridge.max_message_length" :aria-label="t('编辑后的消息')" @keydown.esc.prevent="cancel_edit" @keydown.enter.ctrl.prevent="submit_edit" @keydown.enter.meta.prevent="submit_edit"></textarea>
              <p class="channel-edit-note" :class="{ 'is-error': card.editing_error }" role="status">{{ card.editing_error || (card.editing_plan ? rewind_summary(card.editing_plan) : t('正在读取回退范围…')) }}</p>
              <div class="channel-edit-actions">
                <UButton :label="t('取消')" size="xs" variant="ghost" color="neutral" @click="cancel_edit" />
                <UButton type="submit" :label="t('回退并发送')" size="xs" color="primary" :disabled="!card.editing_plan || (!!card.editing_pending && card.editing_pending !== 'rewind_and_send')" :loading="card.editing_pending === 'rewind_and_send'" />
              </div>
            </form>
            <div v-else class="channel-answer">
              <div :id="`channel-answer-${message.id}`" class="channel-message-text markdown-body" v-html="card.expanded ? message.rendered_text : card.preview.html"></div>
              <button v-for="mark in card.marks" :key="mark.id" type="button" class="excerpt-mark" :style="{ left: `${mark.left}px`, top: `${mark.top}px` }" :title="t('注释 {value1}：点击修改批注', { value1: mark.number })" :aria-label="t('修改注释 {value1} 的批注', { value1: mark.number })" @click="open_mark(mark.id)">{{ mark.number }}</button>
              <UButton v-if="card.preview.truncated" :label="card.expanded ? t('收起') : t('展开全文')" :trailing-icon="card.expanded ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" variant="link" color="neutral" size="xs" class="channel-answer-toggle" :aria-label="`${card.expanded ? t('收起回答') : t('展开完整回答')} #${message.id}`" :aria-expanded="card.expanded" :aria-controls="`channel-answer-${message.id}`" @click="toggle_answer(message, $event)" />
            </div>
            <div v-if="message.summary" class="channel-answer-summary"><small>{{ t('回答摘要') }}<span v-if="message.summary_by && message.summary_by !== message.author"> {{ t('· {value1} 整理', { value1: bridge.display_name(message.summary_by) }) }}</span></small><div class="channel-message-text markdown-body" v-html="message.rendered_summary"></div></div>
            <ExecutionNotes v-if="card.notes_count" :count="card.notes_count" :notes="card.notes" :load="() => load_notes(card.execution_id)" />
            <div v-if="message.attachments?.length" v-html="bridge.attachment_markup(message.attachments)"></div>
            <div v-if="card.recommendation" class="channel-recommendation" :class="`is-${card.recommendation.status}`" :aria-label="t('智能调度推荐')" aria-live="polite">
              <template v-for="item in [card.recommendation]" :key="item.message_id">
                <UIcon name="i-lucide-zap" class="channel-recommendation-icon" />
                <span v-if="item.status === 'open'">{{ t('智能调度建议让') }} <strong>{{ bridge.display_name(item.member) }}</strong> {{ t('回答') }}<small :title="t('{value1}，置信度 {value2}', { value1: item.label, value2: Number(item.confidence).toFixed(2) })">{{ t('置信度 {value1} · {value2} 秒', { value1: Number(item.confidence).toFixed(2), value2: item.remaining }) }}</small></span>
                <span v-else-if="item.status === 'waiting'">{{ t('智能调度：主持人答完后请 {value1} 回答', { value1: bridge.display_name(item.member) }) }}</span>
                <span v-else>{{ t('智能调度：{value1}', { value1: item.mode === 'interrupt' ? t('已打断主持人，改由 {value1} 回答', { value1: bridge.display_name(item.member) }) : t('已请 {value1} 回答', { value1: bridge.display_name(item.member) }) }) }}</span>
                <template v-if="item.can_adopt">
                  <UButton v-if="!card.adopting" :label="t('采纳')" icon="i-lucide-check" size="xs" variant="soft" color="primary" :aria-label="t('采纳建议，请 {value1} 回答 #{value2}', { value1: item.member, value2: item.message_id })" @click="item.host_busy ? adopting = item.message_id : adopt(item.message_id, 'after')" />
                  <template v-else>
                    <UButton :label="t('打断主持人，改由 {value1} 回答', { value1: bridge.display_name(item.member) })" size="xs" variant="soft" color="warning" @click="adopt(item.message_id, 'interrupt')" />
                    <UButton :label="t('主持人答完后再请 {value1}', { value1: bridge.display_name(item.member) })" size="xs" variant="soft" color="neutral" @click="adopt(item.message_id, 'after')" />
                    <UButton icon="i-lucide-x" :aria-label="t('取消采纳')" size="xs" variant="ghost" color="neutral" @click="adopting = 0" />
                  </template>
                </template>
              </template>
            </div>
            <section v-for="{ report, allowable, failed } in card.report_rows" :key="report.id" class="channel-execution-report" :aria-label="t('执行报告 #{value1}', { value1: report.id })">
              <div><strong>{{ t('执行 #{value1} · {value2}', { value1: report.id, value2: report.label }) }}</strong></div>
              <ExecutionChanges v-if="report.changes?.length" :report="report" :room-id="room.id" />
              <p v-if="report.status !== 'completed' && report.result">{{ report.result }}</p>
              <ExecutionDenials v-if="report.denials?.length" :denials="report.denials" :allowable="allowable"
                :busy="card.allowing === report.id" :error="card.allow_errors?.[report.id]" @allow="allow_and_resend(report)" />
              <UButton v-if="failed" :label="t('重发')" icon="i-lucide-rotate-ccw" size="xs" variant="soft" color="neutral" :aria-label="t('把执行 #{value1} 的原消息填回输入框重发', { value1: report.id })" @click="resend_failed(report)" />
            </section>
          </template>
          <template #header><div class="channel-message-actions"><div class="channel-message-stack"><div class="channel-message-toolbar">
            <!-- Private chat joins the toolbar group at the end opposite "…": the bottom of the column with a mouse, the left end on touch screens. -->
            <component v-if="card.private_chat" :is="card.armed ? UTooltip : BareSlot" disable-hoverable-content :ui="KEY_TIP_UI" :text="t('私聊：查看这次执行的过程')"><UButton icon="i-lucide-message-square" class="channel-private-chat-key" size="xs" color="neutral" variant="ghost" :aria-label="t('查看 #{value1} 的执行过程', { value1: message.id })" @click="open_private_chat(act, message.author, card.execution_id)" /></component>
            <component :is="card.armed ? UTooltip : BareSlot" disable-hoverable-content :ui="KEY_TIP_UI" v-if="!card.private_chat && !card.can_take_back" :text="t('回复')"><UButton icon="i-lucide-corner-up-left" size="xs" color="neutral" variant="ghost" :aria-label="t('回复 #{value1}', { value1: message.id })" @click="reply_to(message)" /></component>
            <component :is="card.armed ? UTooltip : BareSlot" disable-hoverable-content :ui="KEY_TIP_UI" v-if="card.can_retract && !card.editing" :text="t('撤回')"><UButton icon="i-lucide-undo-2" size="xs" color="neutral" variant="ghost" :aria-label="t('撤回 #{value1}', { value1: message.id })" @click="retract(message.id)" :loading="card.retracting" /></component>
            <component :is="card.armed ? UTooltip : BareSlot" disable-hoverable-content :ui="KEY_TIP_UI" v-if="card.can_take_back && !card.editing" :text="t('编辑')"><UButton icon="i-lucide-pencil" size="xs" color="neutral" variant="ghost" :aria-label="t('编辑 #{value1}，回退到它之前重新发送', { value1: message.id })" @click="start_edit(message)" /></component>
            <component :is="card.armed ? UTooltip : BareSlot" disable-hoverable-content :ui="KEY_TIP_UI" v-if="!card.narrow && message.kind !== 'receipt' && !card.editing" :text="card.reading ? t('停止朗读') : t('朗读')"><UButton :icon="card.reading ? 'i-lucide-square' : 'i-lucide-volume-2'" size="xs" color="neutral" variant="ghost" :aria-label="card.reading ? t('停止朗读') : t('从 #{value1} 开始朗读', { value1: message.id })" @click="card.reading ? reader.stop() : reader.start(message.id)" /></component>
            <UDropdownMenu v-if="card.armed" :open="card.menu_open" :items="card.actions" :content="{ align: 'end', sideOffset: 5 }" :ui="{ content: 'channel-menu' }" @update:open="(open) => menu_open_id = open ? message.id : 0"><UButton icon="i-lucide-ellipsis" size="xs" color="neutral" variant="ghost" :aria-label="t('消息 #{value1} 的更多操作', { value1: message.id })" /></UDropdownMenu>
            <UButton v-else icon="i-lucide-ellipsis" size="xs" color="neutral" variant="ghost" :aria-label="t('消息 #{value1} 的更多操作', { value1: message.id })" aria-haspopup="menu" @click="open_card_menu(message.id)" />
          </div></div></div></template>
        </UChatMessage>
        </MemoBlock>
        </template>
        <!-- A decision stands between the card that ended the round and the next speaker. -->
        <ScheduleCard v-if="routing_messages.has(message.id) && !scheduler_decisions.get(message.id)?.length" icon="i-lucide-zap" skipped :label="t('智能调度分析中')" :expandable="false">
          <template #text><WorkingText :text="t('智能调度：正在分析')" :seed="t('智能调度')" dots /></template>
        </ScheduleCard>
        <SchedulerDecision v-for="decision in scheduler_decisions.get(message.id) || []" :key="`decision-${decision.id}`" :decision="decision" :free="free" />
        <div v-if="view.source_filter" class="channel-locate"><UButton :label="t('在原文中定位')" icon="i-lucide-locate" size="xs" color="neutral" variant="link" @click="locate(message)" /></div>
        </template>
        </template>
      </div>
      <!-- Sends that failed stay as cards in their place, any number of them: each sends its message again or drops it.
           They are this page's own (no one else sees them), so a failed card works as a ready-to-send draft. -->
      <div v-for="card in view.failed_sends" :key="card.id" class="channel-message-group">
        <UChatMessage :data-author="bridge.identities[card.author]?.style" role="user" :parts="[]" side="left" variant="naked" color="neutral" class="channel-message channel-sending-message is-failed" :ui="{ header: 'channel-message-header', container: 'channel-message-container', body: 'channel-message-body' }">
          <template #body>
            <div class="channel-message-byline">
              <UAvatar :src="bridge.identities[card.author]?.icon" :text="bridge.identities[card.author]?.initials || '?'" :alt="bridge.display_name(card.author)" size="md" class="channel-avatar" :class="bridge.identities[card.author]?.style" />
              <div class="channel-message-meta">
                <div class="channel-message-author"><strong>{{ bridge.display_name(card.author) }}</strong><UBadge :label="t('发送失败')" color="error" variant="soft" size="xs" /></div>
                <div class="channel-message-provenance"><time>{{ bridge.format_time(card.created_at) }}</time></div>
              </div>
            </div>
            <div class="channel-answer"><div class="channel-message-text markdown-body" v-html="bridge.render_room_markdown(card.text)"></div></div>
            <div v-if="card.files.some((file) => file.preview_url)" class="message-attachments">
              <span v-for="file in card.files.filter((item) => item.preview_url)" :key="file.preview_url" class="attachment-image"><img :src="file.preview_url" :alt="file.name"></span>
            </div>
            <div v-if="card.files.some((file) => !file.preview_url)" class="channel-message-provenance">{{ t('附件：{value1}', { value1: card.files.filter((file) => !file.preview_url).map((file) => file.name).join('、') }) }}</div>
            <p class="channel-message-text channel-failure-reason" role="alert">{{ card.failed }}</p>
            <div class="channel-failure-actions">
              <UButton :label="t('重新发送')" icon="i-lucide-rotate-ccw" size="sm" variant="soft" color="primary" :aria-label="t('重新发送这条消息')" :disabled="view.sending_message" @click="act('retry_sending', card.id)" />
              <UButton :label="t('放弃')" icon="i-lucide-x" size="sm" variant="soft" color="neutral" :aria-label="t('放弃发送，移除这张卡片')" @click="act('discard_sending', card.id)" />
            </div>
          </template>
        </UChatMessage>
      </div>
      <!-- The message being sent shows at once; the saved copy replaces it when the site answers, and a failed send becomes a failed card above. -->
      <!-- It mirrors a saved card line for line, so the swap changes only "发送中…" into the message number. -->
      <motion.div v-if="view.sending_preview" class="channel-message-group" :style="{ opacity: send_entry, y: send_y }">
        <USeparator v-if="sending_day_label" :label="sending_day_label" class="channel-date-divider" />
        <UChatMessage id="channel-sending-message" :data-author="bridge.identities[view.sending_preview.author]?.style" role="user" :parts="[]" side="left" variant="naked" color="neutral" class="channel-message channel-sending-message" :ui="{ header: 'channel-message-header', container: 'channel-message-container', body: 'channel-message-body' }">
          <template #body>
            <div class="channel-message-byline">
              <UAvatar :src="bridge.identities[view.sending_preview.author]?.icon" :text="bridge.identities[view.sending_preview.author]?.initials || '?'" :alt="bridge.display_name(view.sending_preview.author)" size="md" class="channel-avatar" :class="bridge.identities[view.sending_preview.author]?.style" />
              <div class="channel-message-meta">
                <div class="channel-message-author"><strong>{{ bridge.display_name(view.sending_preview.author) }}</strong></div>
                <div class="channel-message-provenance"><time>{{ bridge.format_time(view.sending_preview.created_at) }}</time><span class="channel-sending-status" role="status">{{ view.sending_preview.saved_id ? `#${view.sending_preview.saved_id}` : view.sending_preview.retrying ? t('网络不稳，第 {value1} 次重试…', { value1: view.sending_preview.retrying }) : sending_uploads ? t('正在上传附件 {value1}/{value2}…', { value1: sending_uploads.done, value2: sending_uploads.total }) : t('发送中…') }}</span></div>
              </div>
            </div>
            <div class="channel-answer"><div class="channel-message-text markdown-body" v-html="sending_html"></div></div>
            <!-- The files show at once from this browser's own copy while they upload. -->
            <div v-if="view.sending_preview.files.some((file) => file.preview_url)" class="message-attachments">
              <span v-for="file in view.sending_preview.files.filter((item) => item.preview_url)" :key="file.preview_url" class="attachment-image" :class="{ 'is-uploading': !file.uploaded && !view.sending_preview.saved_id }"><img :src="file.preview_url" :alt="file.name"><i v-if="!file.uploaded && !view.sending_preview.saved_id" class="attachment-uploading" role="progressbar" :aria-label="t('正在上传')" /></span>
            </div>
            <div v-if="view.sending_preview.files.some((file) => !file.preview_url)" class="channel-message-provenance">{{ t('附件：{value1}', { value1: view.sending_preview.files.filter((file) => !file.preview_url).map((file) => file.name).join('、') }) }}</div>
          </template>
        </UChatMessage>
        <ScheduleCard v-if="sending_routes" icon="i-lucide-zap" skipped :label="t('智能调度分析中')" :expandable="false">
          <template #text><WorkingText :text="t('智能调度：正在分析')" :seed="t('智能调度')" dots /></template>
        </ScheduleCard>
      </motion.div>
      <div v-if="(topic_anchor === 'end' || end_anchor === 'end') && !view.query && !view.source_filter" class="channel-message-group">
        <TopicCard v-if="topic_anchor === 'end'" :ref="(card) => topic_card = card" @edit="emit('edit')" />
        <DiscussionEndCard v-if="end_anchor === 'end'" />
      </div>
      <div v-if="view.messages_loading && !transcript_messages.length" class="channel-message-group channel-loading-skeleton grid gap-6 py-6" role="status" :aria-label="t('正在读取消息')"><div v-for="row in 3" :key="row" class="grid gap-3"><USkeleton class="h-5 w-28" /><USkeleton class="h-4 w-full" /><USkeleton class="h-4 w-2/3" /></div></div>
      <div v-else-if="view.messages_failure && !transcript_messages.length" class="channel-empty" role="status"><p>{{ view.messages_failure }}</p><UButton :label="t('重新读取消息')" icon="i-lucide-refresh-cw" color="neutral" variant="soft" @click="act('refresh')" /></div>
      <div v-else-if="!transcript_messages.length && !free_working.length && !view.sending_preview && !view.failed_sends.length" class="channel-empty"><UIcon :name="view.query || view.source_filter ? 'i-lucide-search' : 'i-lucide-hash'" /><h2>{{ view.query || view.source_filter ? t('没有找到消息') : room.title }}</h2><p>{{ view.query || view.source_filter ? t('试试其他关键词，或清除筛选。') : bridge.empty_discussion_message(room) }}</p></div>
    </div>
    <!-- Back from the background: the opening load covers the old cards until the room is read again (state.resuming). -->
    <div v-if="view.resuming" class="channel-resume-loading" role="status" :aria-label="t('正在读取消息')"><div class="channel-message-group channel-loading-skeleton grid gap-6 py-6"><div v-for="row in 3" :key="row" class="grid gap-3"><USkeleton class="h-5 w-28" /><USkeleton class="h-4 w-full" /><USkeleton class="h-4 w-2/3" /></div></div></div>
    <!-- The opening load (state.resuming) covers the cards, so nothing to jump to or quote shows over it. -->
    <div v-if="!view.resuming && ((transcript_messages.length && !follow_tail) || listen_here?.touch || reader.state.message_id)" class="channel-latest-dock">
      <button v-if="listen_here?.touch" type="button" class="channel-listen-pill" @mousedown.prevent @click="start_quote"><UIcon name="i-lucide-message-square-quote" />{{ t('添加到对话') }}</button>
      <button v-if="listen_here?.touch && listen_here.speech" type="button" class="channel-listen-pill" :aria-label="t('从选中处开始朗读')" @mousedown.prevent @click="listen_from_selection"><UIcon name="i-lucide-headphones" />{{ t('听当前') }}</button>
      <span v-if="reader.state.message_id && reader.state.loading" class="channel-listen-pill" role="status"><UIcon name="i-lucide-loader-circle" class="animate-spin" />{{ t('加载中') }}</span>
      <button v-else-if="reader.state.message_id" type="button" class="channel-listen-pill" :class="{ 'is-on': reader.state.following }" :aria-pressed="reader.state.following" :title="reader.state.following ? t('手动滚动即取消跟随') : t('页面跟随朗读位置滚动')" @click="reader.state.following ? (reader.state.following = false) : reader.follow()"><UIcon name="i-lucide-locate-fixed" />{{ reader.state.following ? t('跟随中') : t('跟随') }}</button>
      <button v-if="reader.state.reading" type="button" class="channel-listen-pill" :aria-label="t('停止朗读')" @click="reader.stop()"><UIcon name="i-lucide-square" />{{ t('停止') }}</button>
      <UButton v-if="transcript_messages.length && !follow_tail" icon="i-lucide-arrow-down" color="neutral" variant="outline" :aria-label="t('回到最新消息')" class="channel-latest-button" @click="return_to_latest" />
    </div>
    <div ref="composer_dock" class="channel-composer-dock"><div class="channel-composer-column" @dragover="bridge.drop_attachments" @drop="bridge.drop_attachments" @paste="bridge.paste_attachments" @keydown.capture="mention_keydown($event); attachment_shortcut($event); step_over_token($event, view.attachment_drafts)" @beforeinput="guard_token_edit($event, view.attachment_drafts)" @input.capture="hold_transcript" @input="release_transcript(); update_mention($event); drop_unreferenced($event)" @click="update_mention($event); snap_caret($event, view.attachment_drafts)" @keyup="update_mention($event); snap_caret($event, view.attachment_drafts)" @select="update_mention" @compositionstart="mention_composition" @compositionupdate="mention_composition" @compositionend="mention_composition" @scroll.capture="sync_mirror">
      <UPopover :open="mention_open" :reference="mention_anchor" :content="{ side: 'top', align: 'start', sideOffset: 8, onOpenAutoFocus: keep_mention_focus, onCloseAutoFocus: keep_mention_focus }" :ui="{ content: 'channel-select-menu channel-mention-menu' }" @update:open="!$event && (mention_context = null)">
        <template #content>
          <div class="channel-mention-heading"><span>{{ mention_heading }}</span><small>{{ t('↑↓ 选择 · Enter 确认') }}</small></div>
          <div id="channel-mention-list" ref="mention_list" role="listbox" :aria-label="mention_heading" class="channel-mention-list">
            <template v-for="(option, index) in mention_options" :key="option.key">
            <p v-if="index === 0 || option.group !== mention_options[index - 1].group" role="presentation" class="channel-mention-group">{{ option.group }}</p>
            <button :id="`channel-mention-${index}`" type="button" role="option" :aria-selected="option === mention_active" tabindex="-1" class="channel-mention-option" @pointerdown.prevent @click="select_mention(option)" @pointermove="mention_index = index">
              <template v-if="option.mode">
                <UIcon :name="option.mode.command.startsWith('/goal') ? 'i-lucide-target' : 'i-lucide-messages-square'" class="channel-mention-file-icon" />
                <span :class="{ 'channel-mention-disabled': option.mode.disabled }">{{ option.mode.label }}</span>
                <small :title="option.mode.description">{{ option.mode.description }}</small>
              </template>
              <template v-else-if="option.workflow">
                <UIcon :name="option.broken ? 'i-lucide-triangle-alert' : 'i-lucide-network'" class="channel-mention-file-icon" :class="{ 'channel-mention-broken': option.broken }" />
                <span :class="{ 'channel-mention-disabled': option.disabled && !option.enabled }">{{ option.workflow.label }}</span>
                <small class="channel-mention-brief" :class="{ 'channel-mention-broken': option.broken }" :title="!option.enabled && option.disabled || option.workflow.description">{{ !option.enabled && option.disabled || option.workflow.description }}</small>
                <b v-if="option.enabled" class="channel-mention-tag">{{ t('已启用') }}</b>
              </template>
              <template v-else-if="option.skill">
                <UIcon name="i-lucide-sparkles" class="channel-mention-file-icon" />
                <span>{{ option.skill.label }}</span>
                <small :title="option.skill.description">{{ option.skill.description }}</small>
              </template>
              <template v-else-if="option.entry">
                <UIcon :name="option.self ? 'i-lucide-folder-check' : option.entry.kind === 'directory' ? 'i-lucide-folder' : 'i-lucide-file-text'" class="channel-mention-file-icon" />
                <span :title="option.entry.path">{{ option.self ? t('引用此文件夹') : `${option.entry.name}${option.entry.kind === 'directory' ? '/' : ''}` }}</span>
                <small v-if="mention_folder?.search" :title="option.entry.path">{{ option.entry.path.split('/').slice(0, -1).join('/') }}</small>
                <UIcon v-if="option.entry.kind === 'directory' && !option.self" name="i-lucide-chevron-right" class="channel-mention-file-icon channel-mention-drill" />
              </template>
              <template v-else>
                <UAvatar v-if="GROUP_MENTIONS[option.name]" :icon="GROUP_MENTIONS[option.name].icon" :alt="option.name" size="xs" class="channel-avatar" />
                <UAvatar v-else :src="bridge.identities[option.name]?.icon" :text="bridge.identities[option.name]?.initials" :alt="bridge.display_name(option.name)" size="xs" :class="['channel-avatar', bridge.identities[option.name]?.style]" />
                <span>{{ GROUP_MENTIONS[option.name] ? option.name : bridge.display_name(option.name) }}</span><small>@{{ mention_handle(option.name) }}</small>
              </template>
            </button>
            </template>
            <p v-if="member_skills_loading" class="channel-mention-empty">{{ t('正在读取本机技能…') }}</p>
            <p v-else-if="skill_member && !mention_options.length" class="channel-mention-empty">{{ member_skills_empty }}</p>
            <p v-else-if="mention_files_loading" class="channel-mention-empty">{{ t('正在读取项目目录…') }}</p>
            <p v-else-if="!mention_options.length" class="channel-mention-empty">{{ mention_context?.command ? t('没有匹配的工作流或技能') : project_directory ? t('没有匹配的成员或文件') : t('没有匹配的成员') }}</p>
          </div>
        </template>
      </UPopover>
      <QuestionCard v-if="room.free?.questions?.length" :questions="room.free.questions" />
      <QueuedMessages v-if="room.free?.queued_messages" :queue="room.free.queued_messages" :room-id="room.id" />
      <UChatPrompt ref="prompt" v-model="text" :submit-on-enter="ENTER_SENDS" :enterkeyhint="ENTER_SENDS ? 'send' : 'enter'" :autofocus="false" :rows="1" :maxrows="EDITOR_MAX_ROWS" :placeholder="relay_waits_owner ? t('接力在等你回答问题卡…') : t('发消息到 # {value1}', { value1: room.title })" :aria-label="t('留言正文')" role="combobox" aria-autocomplete="list" aria-haspopup="listbox" :aria-expanded="!!mention_context" :aria-controls="mention_context ? 'channel-mention-list' : undefined" :aria-activedescendant="mention_context && mention_active ? `channel-mention-${mention_options.indexOf(mention_active)}` : undefined" variant="outline" color="neutral" class="channel-composer" :class="{ 'has-mentions': mention_mirror }" :ui="{ header: 'channel-composer-header', base: 'channel-editor', footer: 'channel-composer-footer' }" @submit="send">
        <template #header>
          <div v-if="view.attachment_drafts.length || file_refs.length || excerpts.length" class="attachment-drafts">
            <UPopover v-if="excerpts.length" v-model:open="excerpt_list_open" :content="{ side: 'top', align: 'start' }" @update:open="editing_excerpt = 0">
              <div class="excerpt-chip" role="button" tabindex="0" :data-stack="excerpts.length > 1 ? Math.min(excerpts.length, 3) : undefined" :title="t('查看注释、修改批注')">
                <UIcon name="i-lucide-message-square-quote" /><span>{{ t('{value1} 条注释', { value1: excerpts.length }) }}</span>
                <button type="button" class="excerpt-chip-clear" :aria-label="t('移除全部注释')" :title="t('移除全部注释')" :disabled="view.sending_message" @click.stop="file_preview.excerpts = []"><UIcon name="i-lucide-x" /></button>
              </div>
              <template #content>
                <ol class="excerpt-list" :aria-label="t('注释')">
                  <li v-for="(excerpt, index) in excerpts" :key="excerpt.id">
                    <span class="excerpt-number">{{ index + 1 }}.</span>
                    <div class="excerpt-item">
                      <small>{{ t('选中文字 · {value1}', { value1: excerpt_source(excerpt) }) }}</small>
                      <p class="excerpt-text">{{ excerpt.text }}</p>
                      <ExcerptEditCard v-if="editing_excerpt === excerpt.id" inline :removable="false" :comment="excerpt.comment"
                        @save="(comment) => { excerpt.comment = comment; editing_excerpt = 0; }" @cancel="editing_excerpt = 0" />
                      <template v-else-if="excerpt.comment"><small>{{ t('批注') }}</small><p class="excerpt-comment">{{ excerpt.comment }}</p></template>
                    </div>
                    <div class="excerpt-actions">
                      <button type="button" :aria-label="t('修改注释 {value1} 的批注', { value1: index + 1 })" :title="t('修改批注')" @click="edit_listed_excerpt(excerpt)"><UIcon name="i-lucide-pencil" /></button>
                      <button type="button" :aria-label="t('移除注释 {value1}', { value1: index + 1 })" :title="t('移除')" :disabled="view.sending_message" @click="remove_excerpt(excerpt)"><UIcon name="i-lucide-trash-2" /></button>
                    </div>
                  </li>
                </ol>
              </template>
            </UPopover>
            <div v-for="ref_item in file_refs" :key="`ref:${ref_item.path}`" class="attachment-draft-file attachment-draft-ref" :title="ref_item.path">
              <span v-if="ref_item.kind === 'file'" v-html="bridge.attachment_file_icon(ref_item.name)"></span>
              <UIcon v-else name="i-lucide-folder" class="attachment-ref-folder" />
              <span class="attachment-name"><span>{{ ref_item.name }}</span><small>{{ ref_item.kind === 'directory' ? t('项目文件夹') : t('项目文件') }} · {{ ref_item.path }}</small></span>
              <button type="button" class="attachment-remove" :aria-label="t('移除 {value1}', { value1: ref_item.path })" :disabled="view.sending_message" @click="file_refs = file_refs.filter((item) => item !== ref_item)"><UIcon name="i-lucide-x" /></button>
            </div>
            <div v-for="file in view.attachment_drafts" :key="file.id" :class="file.preview_url ? 'attachment-draft-image' : 'attachment-draft-file'">
              <img v-if="file.preview_url" :src="file.preview_url" :alt="file.file_name" :title="file.file_name">
              <template v-else>
                <span v-html="bridge.attachment_file_icon(file.file_name)"></span>
                <span class="attachment-name"><span :title="file.file_name">{{ file.file_name }}</span><small>{{ bridge.attachment_size(file.size) }}</small></span>
              </template>
              <button type="button" class="attachment-remove" :aria-label="t('移除 {value1}', { value1: file.file_name })" @click="act('remove_attachment', file.id)"><UIcon name="i-lucide-x" /></button>
            </div>
          </div>
          <div v-for="unregistered_member in unregistered_members" :key="unregistered_member.name" class="channel-reply-draft channel-queue-hint"><UIcon name="i-lucide-user-round-x" /><span>{{ unregistered_member.access === 'external' ? t('外部专家 · 待签到') : t('{value1} 待注册：在其会话中粘贴启动指令', { value1: bridge.display_name(unregistered_member.name) }) }}</span><UButton v-if="view.access?.can_manage && unregistered_member.access === 'external'" :label="t('邀请链接')" size="xs" color="neutral" variant="ghost" @click="pending_seat = unregistered_member; pending_seat_open = true" /><UButton v-if="view.access?.can_manage && unregistered_member.access !== 'external'" :icon="launch_copied === unregistered_member.name ? 'i-lucide-check' : 'i-lucide-copy'" :label="launch_copied === unregistered_member.name ? t('已复制') : t('复制启动指令')" aria-live="polite" size="xs" color="neutral" variant="ghost" class="channel-launch-copy" @click="copy_launch(unregistered_member.name)" /></div>
          <div v-if="queue_hint" class="channel-reply-draft channel-queue-hint"><UIcon name="i-lucide-clock" /><span>{{ queue_hint }}</span><UButton v-if="is_manual_member(speaking_member) && view.access?.can_manage" :icon="launch_copied === speaking_member.name ? 'i-lucide-check' : 'i-lucide-copy'" :label="launch_copied === speaking_member.name ? t('已复制') : t('复制启动指令')" aria-live="polite" size="xs" color="neutral" variant="ghost" class="channel-launch-copy" @click="copy_launch(speaking_member.name)" /></div>
          <div v-if="view.reply_to" class="channel-reply-draft"><UIcon name="i-lucide-corner-up-left" /><span>{{ t('回复 #{value1}', { value1: view.reply_to }) }}</span><UButton icon="i-lucide-x" color="neutral" variant="ghost" size="xs" :aria-label="t('取消回复')" @click="act('cancel_reply')" /></div>
        </template>
        <div v-if="mention_mirror" ref="mirror" class="channel-editor channel-editor-mirror" aria-hidden="true" v-html="mention_mirror"></div>
        <template #footer>
          <!-- Voice input takes over the whole footer: discard on the left, live levels in the middle, finish where send was. -->
          <template v-if="voice.state.status">
            <UTooltip :text="ENTER_SENDS ? t('取消 · Esc') : t('取消')"><UButton type="button" icon="i-lucide-x" color="neutral" variant="ghost" size="sm" class="channel-voice-button" :aria-label="t('取消语音输入')" @click="voice.cancel()" /></UTooltip>
            <span class="channel-voice-levels" :class="{ 'is-discarding': voice_hold.discard }" role="status" :aria-label="voice.state.status === 'recording' ? t('正在录音 {value1}', { value1: format_voice_time(voice.state.seconds) }) : t('正在识别')">
              <template v-if="voice.state.status === 'recording'"><span class="channel-voice-bars"><i v-for="(level, index) in voice.state.levels" :key="index" :style="{ transform: `scaleY(${0.15 + level * 0.85})` }" /></span><small>{{ format_voice_time(voice.state.seconds) }}</small><small v-if="voice_hold.by" class="channel-voice-hint">{{ voice_hold.discard ? t('松开取消') : voice_hold.by === 'touch' ? t('松开转文字 · 上滑取消') : t('松开空格转文字') }}</small></template>
              <small v-else>{{ voice.state.status === 'starting' ? t('正在打开麦克风…') : t('正在识别…') }}</small>
            </span>
            <UTooltip :text="ENTER_SENDS ? t('完成，转成文字 · Enter') : t('完成，转成文字')"><UButton type="button" icon="i-lucide-check" color="neutral" size="sm" class="channel-primary-button channel-round-button" :aria-label="t('结束录音并转成文字')" :loading="voice.state.status !== 'recording'" @click="voice.toggle()" /></UTooltip>
          </template>
          <template v-else>
            <UButton type="button" icon="i-lucide-paperclip" :aria-label="t('添加附件')" :title="t('图片、PDF 或其他文件 · 每个最多 20 MiB')" color="neutral" variant="ghost" size="sm" @click="act('choose_attachments', prompt?.textareaRef)" />
            <UTooltip v-if="speech_ready" :text="broadcast.on.value ? t('关闭语音播报') : t('语音播报：新回复自动朗读摘要')"><UButton type="button" icon="i-lucide-radio" color="neutral" variant="ghost" size="sm" class="channel-voice-button channel-broadcast-button" :class="{ 'is-on': broadcast.on.value }" :aria-pressed="broadcast.on.value" :aria-label="broadcast.on.value ? t('关闭语音播报') : t('开启语音播报')" @click="broadcast.toggle()" /></UTooltip>
            <UTooltip :text="ENTER_SENDS ? t('语音输入 · 也可按住空格说话') : t('按住说话，或轻点开始')"><UButton type="button" icon="i-lucide-mic" color="neutral" variant="ghost" size="sm" class="channel-voice-button channel-voice-mic" :aria-label="t('语音输入')" :disabled="view.sending_message" @pointerdown="voice_press.pointerdown" @click="voice_press.click" @contextmenu.prevent /></UTooltip>
            <UButton type="button" icon="i-lucide-arrow-up" color="neutral" size="sm" class="channel-primary-button channel-round-button channel-send" :aria-label="t('发送')" :title="t('发送 · Enter')" :disabled="!has_draft" @click="send" />
          </template>
        </template>
      </UChatPrompt>
      <div class="channel-composer-note"><span>{{ recipient_hint }}</span><span class="channel-draft-length"><span v-if="text_length" :class="{ 'is-near-limit': near_length_limit }">{{ text_length }} / {{ bridge.max_message_length }}<span class="channel-note-divider">·</span></span><span class="channel-key-hint"><kbd>Enter</kbd> {{ t('发送') }}<span class="channel-note-divider">·</span><kbd>Shift</kbd>+<kbd>Enter</kbd> {{ t('换行') }}</span></span></div>
    </div></div>
  </section>
</template>

<style scoped>
.channel-free-recipients { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; min-width: 0; font-size: 12px; color: var(--ui-text-muted); }
.channel-free-recipients button { min-height: 24px; padding: 0 8px; border: 1px solid transparent; border-radius: 4px; color: var(--ui-text-muted); transition: background .12s, color .12s; }
.channel-free-recipients button:hover { background: #ffffff0d; color: var(--ui-text-highlighted); }
.channel-free-recipients button.is-on { border-color: color-mix(in srgb, var(--channel-accent) 40%, transparent); background: color-mix(in srgb, var(--channel-accent) 14%, transparent); color: var(--ui-text-highlighted); }
.channel-message-elapsed { align-self: center; margin-left: auto; white-space: nowrap; }
.channel-working-warning { color: var(--ui-warning); }
.channel-working-background { flex-shrink: 0; width: 14px; height: 14px; color: var(--ui-text-dimmed); }
.channel-working-row { display: flex; align-items: center; gap: 12px; }
.channel-working-row > .channel-message-text { flex: 1; min-width: 0; }
.channel-working-actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.channel-stop-button { width: 28px; height: 28px; padding: 0; justify-content: center; border-radius: 999px; background: color-mix(in srgb, var(--ui-error) 55%, #000); color: #f4e7e6; }
.channel-stop-button:hover:not(:disabled) { background: color-mix(in srgb, var(--ui-error) 68%, #000); }
/* A dark red disc reads as a heavy blot on a white card: light uses the pale tint of 全部停止. */
:root[data-theme="channel-light"] .channel-stop-button { background: color-mix(in srgb, var(--ui-error) 12%, transparent); color: var(--ui-error); }
:root[data-theme="channel-light"] .channel-stop-button:hover:not(:disabled) { background: color-mix(in srgb, var(--ui-error) 20%, transparent); }
.channel-retry-button { background: #ffffff14; color: var(--ui-text-highlighted); }
.channel-retry-button:hover:not(:disabled) { background: #ffffff24; }
.channel-stop-square { width: 9px; height: 9px; border-radius: 2px; background: currentColor; }
/* In the one-line strip the stop key shrinks to the row. */
.channel-working-strip .channel-stop-button { width: 24px; height: 24px; }
.channel-working-strip .channel-stop-square { width: 8px; height: 8px; }
@media (pointer: coarse) { .channel-working-strip .channel-stop-button { width: 28px; height: 28px; } }
</style>

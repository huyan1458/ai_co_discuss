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
import { active_workflow } from "./workflow-state.js";
import { open_private_chat } from "./private-chat.js";
import { ENTER_SENDS } from "./enter-sends.js";
import { use_read_aloud } from "./read-aloud.js";
import { use_broadcast } from "./broadcast.js";
import { use_voice_input } from "./voice-input.js";
import ExcerptEditCard from "./ExcerptEditCard.vue";
import { add_excerpt, excerpt_mark_place, excerpt_range, excerpt_source, excerpts_markdown, file_preview, hold_selection, text_offset } from "./file-preview.js";
import { keep_reading_position } from "./scroll-anchor.js";
import MemoBlock from "./memo-block.js";
import UTooltip from "@nuxt/ui/components/Tooltip.vue";
import { motion, useSpring, useTransform } from "motion-v";

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
const speech_ready = ref(false);
// Voice input inserts recognized text where the caret was in the composer.
const voice = use_voice_input({ bridge, on_text: (spoken) => {
  const area = prompt.value?.textareaRef, value = text.value || "";
  const start = area ? area.selectionStart : value.length, end = area ? area.selectionEnd : value.length;
  text.value = `${value.slice(0, start)}${spoken}${value.slice(end)}`;
  // On touch screens focusing would raise the keyboard over the send key, so the text is only inserted.
  nextTick(() => { if (ENTER_SENDS) area?.focus(); area?.setSelectionRange(start + spoken.length, start + spoken.length); });
} });
const format_voice_time = (seconds) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
// Touch: hold the microphone to talk and let go to finish, slide up to discard; a short tap keeps recording until ✓.
const VOICE_HOLD_MS = 300;
const VOICE_CANCEL_SLIDE_PX = 60;
// How the current recording is being held: "" (tap mode), "touch" or "space"; `discard` while slid up to cancel.
const voice_hold = reactive({ by: "", discard: false });
let voice_press = null, voice_touch_click = false;
function voice_pointerdown(event) {
  voice_touch_click = event.pointerType !== "mouse";
  if (!voice_touch_click || voice.state.status || view.value.sending_message) return;
  voice_press = { id: event.pointerId, y: event.clientY, at: event.timeStamp };
  Object.assign(voice_hold, { by: "touch", discard: false });
  // The button is replaced by the recording bar under the finger, so the rest of the press is followed on the window.
  window.addEventListener("pointermove", voice_pointermove);
  window.addEventListener("pointerup", voice_pointerup);
  window.addEventListener("pointercancel", voice_pointerup);
  voice.toggle();
}
function voice_pointermove(event) {
  if (event.pointerId === voice_press?.id) voice_hold.discard = voice_press.y - event.clientY > VOICE_CANCEL_SLIDE_PX;
}
function voice_pointerup(event) {
  if (event.pointerId !== voice_press?.id) return;
  window.removeEventListener("pointermove", voice_pointermove);
  window.removeEventListener("pointerup", voice_pointerup);
  window.removeEventListener("pointercancel", voice_pointerup);
  const held = event.type === "pointerup" && event.timeStamp - voice_press.at >= VOICE_HOLD_MS, { discard } = voice_hold;
  voice_press = null;
  Object.assign(voice_hold, { by: "", discard: false });
  voice.resume();
  if (discard) voice.cancel();
  // A tap, or a hold the browser would not record yet (first permission prompt), stays on as tap mode.
  else if (held && voice.state.status === "recording" && voice.state.capturing) voice.toggle();
}
/** Mouse clicks toggle recording; the click that ends a touch press is already handled by the press. */
function voice_click() {
  if (voice_touch_click) { voice_touch_click = false; return; }
  voice.toggle();
}
// Desktop: holding Space in the composer (or with nothing focused) talks until it is let go. A hold is known once
// the key starts repeating; the one space the first press typed is taken back.
function voice_space_down(event) {
  if (voice_hold.by === "space") { event.preventDefault(); return; }
  const area = prompt.value?.textareaRef;
  if (!event.repeat || voice.state.status || view.value.sending_message || ![area, document.body].includes(event.target)) return;
  event.preventDefault();
  const caret = area?.selectionStart ?? 0;
  if (event.target === area && text.value?.[caret - 1] === " ") {
    text.value = `${text.value.slice(0, caret - 1)}${text.value.slice(caret)}`;
    nextTick(() => area.setSelectionRange(caret - 1, caret - 1));
  }
  voice_hold.by = "space";
  voice.toggle();
}
function voice_keyup(event) {
  if (event.code !== "Space" || voice_hold.by !== "space") return;
  event.preventDefault();
  voice_hold.by = "";
  if (voice.state.status === "recording") voice.toggle();
}
/** While voice input is on, Esc discards it and Enter finishes it instead of sending; runs before the composer's keys. */
function voice_keydown(event) {
  if (event.isComposing) return;
  if (event.code === "Space" && !(event.ctrlKey || event.metaKey || event.altKey || event.shiftKey)) return voice_space_down(event);
  if (!voice.state.status) return;
  const finish = event.key === "Enter" && ENTER_SENDS && !event.shiftKey;
  if (event.key !== "Escape" && !finish) return;
  event.preventDefault();
  event.stopPropagation();
  if (event.key === "Escape") voice.cancel();
  else if (voice.state.status === "recording") voice.toggle();
}
onMounted(() => { window.addEventListener("keydown", voice_keydown, true); window.addEventListener("keyup", voice_keyup, true); });
onBeforeUnmount(() => { window.removeEventListener("keydown", voice_keydown, true); window.removeEventListener("keyup", voice_keyup, true); });
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
const on_offer = (event) => Boolean(event.target.closest?.(".channel-listen-mark, .channel-listen-pill, .selection-comment, .excerpt-mark, .excerpt-edit-card"));
const press = (event) => { if (on_offer(event)) return; pointer_down = true; if (quoting.value) cancel_quote(); if (mark_editing.value) close_mark(); };
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
  const speech = await speech_configured().catch(() => false);
  if (pointer_down || quoting.value) return;
  // On touch screens the system's own selection menu sits next to the selection, so the buttons wait above the composer instead.
  const touch = window.matchMedia("(pointer: coarse)").matches;
  const to = body.contains(kept.endContainer) ? text_offset(body, kept.endContainer, kept.endOffset) : body.textContent.length;
  const from = text_offset(body, kept.startContainer, kept.startOffset);
  listen_here.value = { id: Number(card.dataset.messageId), range: kept, text, from, to, speech, touch, ...place_by(kept, QUOTE_OFFER_WIDTH, QUOTE_OFFER_HEIGHT) };
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
  if (mark_editing.value) Object.assign(mark_editing.value, place_by(mark_editing.value.range, MARK_CARD_WIDTH, MARK_CARD_HEIGHT));
}
/** Open a quoted passage's edit card from its number mark, highlighting the passage again. */
function open_mark(excerpt_id) {
  cancel_quote();
  const excerpt = file_preview.excerpts.find((item) => item.id === excerpt_id);
  const range = excerpt && excerpt_range(document.getElementById(`channel-answer-${excerpt.message_id}`), excerpt.from, excerpt.to);
  if (!range) return;
  hold_selection(range);
  mark_editing.value = { excerpt, range, ...place_by(range, MARK_CARD_WIDTH, MARK_CARD_HEIGHT) };
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
  speech_configured().then((ready) => { speech_ready.value = ready; });
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
// Idle slices wait this long at most (ms) for an idle moment, and hold off this long after the reader last scrolled.
const PRELOAD_IDLE_TIMEOUT_MS = 300;
const SCROLL_SETTLE_MS = 150;
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
  : (room.value?.members || []).filter((member) => is_manual_member(member) && !member.registered_at));
const queue_hint = computed(() => {
  const member = speaking_member.value;
  if (!speaking_turn.value || !member) return "";
  const name = bridge.display_name(member.name);
  if (is_manual_member(member)) return member.registered_at ? `${name} 是手动启动，轮到它时需到其 AI 会话触发；不接入可在进度看板点「跳过」本次发言` : "";
  return text.value.trim() ? `新消息会在 ${name} 回复后交给主持人；可在进度看板点「跳过」本次发言` : "";
});
const free = computed(() => !["active", "paused"].includes(room.value?.session?.status));
/** What the runner last saw a member's software doing; unknown phases keep the generic text. Declared before `free_busy`, which an immediate watch reads during setup. */
const ACTIVITY_LABELS = { thinking: "思考中", command: "正在运行命令", tool: "正在调用工具", editing: "正在修改文件", writing: "正在撰写回答" };
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
        text: execution.stale ? "执行失联：网站已不再接受本次回答，软件停止未确认" : retry ? "投递未成功，等待自动重试" : ACTIVITY_LABELS[execution.activity] || "正在处理",
        working: !execution.stale && !retry, created_at: execution.created_at, adapter: member.adapter, capabilities: execution.capabilities,
        activity: execution.activity, activity_at: execution.activity_at, notes: execution.notes || 0,
        execution_id: execution.id, request_message_id: reports.get(execution.id)?.request_message_id, anchor_message_id: reports.get(execution.id)?.anchor_message_id,
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
const free_working = computed(() => view.value.query || view.value.mention_only || view.value.host_only ? [] : free_busy.value);
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
    bridge.notify("error", `未采纳的回答读取失败：${error.message}`);
  }
}
/** Notes read so far for a working item's execution. */
function working_notes(message) {
  return execution_notes.value.get(message.execution_id) || [];
}
async function load_notes(execution_id) {
  try {
    const { notes } = await bridge.request(`/api/rooms/${room.value.id}/executions/${execution_id}/notes`);
    execution_notes.value = new Map(execution_notes.value).set(execution_id, notes);
  } catch { /* Notes only accompany the work; a failed read leaves the card as it was. */ }
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
  return (room.value.free?.executions || []).find((item) => item.answer_id === message.id);
}
/**
 * The working card's one status line: the phase while output keeps coming, a warning only after a long silence.
 * Silence while a command runs is expected, so it is named as such instead of a possible hang.
 */
function working_status(message) {
  // Data shown after the page was hidden or offline may be old; silence counts only up to when it was last current.
  const observed = view.value.observed_until ? Math.min(free_now.value, Math.floor(view.value.observed_until / 1000)) : free_now.value;
  const silent = Math.max(0, observed - (message.activity_at || message.created_at));
  if (!message.working || !shows_progress(message) || silent < STALL_SECONDS) return { text: message.text, live: message.working };
  if (message.activity === "command") return { text: `命令已运行 ${format_elapsed(silent)}`, live: true };
  // Deep reasoning reports nothing until it ends; only a much longer silence there suggests a hang.
  if (message.activity === "thinking" && silent < THINKING_STALL_SECONDS) return { text: `思考中，已 ${format_elapsed(silent)}无中间输出`, live: true };
  return { text: `已 ${format_elapsed(silent)}无输出，可能卡住`, live: false, warning: true };
}
/** Says in the note line who the draft will reach: the @mentioned members, else the host. */
const recipient_hint = computed(() => {
  const named_group = (aliases) => aliases.some((alias) => MENTION_PATTERN(alias).test(draft_prose.value));
  if (free.value && named_group(SEQUENTIAL_ALIASES)) return `依次发给 ${in_turn(free_members.value).map((member) => bridge.display_name(member.name)).join(" → ")}，前一位结束后下一位开始`;
  if (free.value && named_group(ALL_ALIASES)) return `发给 ${free_members.value.map((member) => bridge.display_name(member.name)).join("、")}`;
  const named = free_members.value.filter((member) => MENTION_PATTERN(member.name).test(draft_prose.value));
  if (named.length) return free.value ? `${named.length > 1 ? "同时" : ""}发给 ${named.map((member) => bridge.display_name(member.name)).join("、")}`
    : `直接提问 ${named.map((member) => bridge.display_name(member.name)).join("、")}，不计讨论轮次；同一成员完成当前执行后回答`;
  if (free_members.value.length === 1) return `发给 ${bridge.display_name(free_members.value[0].name)}`;
  return free_host.value ? `发给主持人 ${bridge.display_name(free_host.value.name)}；@ 其他成员让它们发言` : "未 @ 任何成员：只作留言，不会唤醒 AI";
});
/** Project files picked after @: their @path stays in the draft, and they also show as cards and go out as a trailing line of paths (code-quoted, so they never wake a member). */
const file_refs = ref([]);
watch(() => room.value?.id, () => { file_refs.value = []; file_preview.excerpts = []; });
const file_refs_line = () => file_refs.value.length
  ? `引用文件：${file_refs.value.map((ref) => `\`${ref.path}${ref.kind === "directory" ? "/" : ""}\``).join("、")}` : "";
// Passages quoted from the file preview ("添加到对话") wait as cards and go out after the text, each as a quote with its comment.
const excerpts = computed(() => file_preview.excerpts);
const has_draft = computed(() => Boolean(text.value.trim() || view.value.attachment_drafts.length || file_refs.value.length || excerpts.value.length));
watch(() => file_preview.focus_composer, () => nextTick(() => prompt.value?.textareaRef?.focus()));
// Editing a queued message puts its text in the composer; the caret goes to its end so typing continues it.
watch(() => view.value.editing_queued, (id) => id && nextTick(() => {
  const area = prompt.value?.textareaRef;
  area?.focus();
  area?.setSelectionRange(area.value.length, area.value.length);
}));
/** Drop one excerpt from the draft. */
function remove_excerpt(excerpt) { file_preview.excerpts = file_preview.excerpts.filter((item) => item.id !== excerpt.id); }
// The excerpt whose comment is being edited in the composer's excerpt list.
const editing_excerpt = ref(0);
/** Active members a free-room message can name; chips appear only when there is a choice. */
const free_members = computed(() => (room.value.free?.members || []).filter((member) => member.status === "active" && (member.access !== "manual" || member.registered_at)));
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
function stop_state(execution) {
  const label = bridge.stop_label(execution);
  const name = bridge.display_name(execution.member);
  // A late answer shows the member did finish the turn; it stays out of the transcript and AI reads.
  if (execution.late_answer) return { label, note: `${name} 之后仍交来了回答，未采纳：不进入记录，其他 AI 读不到。` };
  if (execution.stop_result === "unconfirmed") return { label, note: "本机尚未确认进程结束，可能仍在生成；网站不再接受本次回答。" };
  if (execution.stop_result === "unstoppable" || capabilities(execution)?.stoppable === false) return { label, note: `${name} 在自己的窗口或 App 里，本机无法停止，可能仍在生成；网站不再接受本次回答。` };
  return { label, note: label === "正在停止" ? "等待本机服务结束进程。" : "" };
}
// The runner retries a delivery that did not take this many times (runner/free_runner.mjs MAX_DELIVERY_RETRIES).
const MAX_DELIVERY_RETRIES = 3;
/** Long reasoning or a long reply can be silent for minutes; beyond this the card only warns, never stops. */
const STALL_SECONDS = 180;
/** Thinking emits no events until it ends (gpt xhigh was seen silent for 4 min), so it warns only after this long. */
const THINKING_STALL_SECONDS = 600;
const FREE_REQUEST_LABELS = { pending: ["待投递", "neutral"], delivering: ["处理中", "info"], completed: ["已回复", "success"],
  cancelled: ["已取消", "neutral"], failed: ["失败", "error"] };
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
    const [label, color] = voided ? [stop_state(voided).label, "neutral"] : FREE_REQUEST_LABELS[request.status];
    const title = request.status === "failed" ? failures.get(request.execution_id) || "执行失败" : "";
    badges.set(request.message_id, [...(badges.get(request.message_id) || []),
      { key: request.id, label: `${bridge.display_name(request.member)} · ${label}`, color, title }]);
  }
  return badges;
});
/** Attach each terminal execution to its answer, or to the original request when it has no answer. */
const execution_reports = stable_computed(() => {
  const reports = new Map();
  const source = room.value.free;
  if (!source) return reports;
  for (const execution of source.executions || []) {
    if (!["completed", "failed", "cancelled"].includes(execution.status)) continue;
    // A clean completion adds nothing to the message header; only failures, observed file changes and refused operations earn a card.
    if (execution.status === "completed" && !execution.changes?.length && !execution.denials?.length) continue;
    // A failed free-room execution keeps its own card in the slot it worked in, and so does a delivered one that was voided.
    if (execution.status === "failed" || (execution.status === "cancelled" && execution.capabilities)) continue;
    const message_id = execution.answer_id || execution.request_message_id;
    const report = { ...execution, label: execution.status === "cancelled" ? bridge.stop_label(execution) : { completed: "已完成", failed: "失败" }[execution.status] };
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
  return ms < 1000 ? `${ms}毫秒` : ms < 10_000 ? `${(ms / 1000).toFixed(1)}秒` : format_elapsed(Math.round(ms / 1000));
}
/** In a discussion, each smart-scheduling decision shows under the message it followed. */
const scheduler_decisions = stable_computed(() => {
  const rows = new Map();
  for (const item of room.value.scheduler_decisions || []) {
    // A skip asked the model nothing (no confidence, nothing applied, no question), so there is no decision to show.
    if (item.confidence === null && !item.applied && !item.detail?.length) continue;
    rows.set(item.after_message_id, [...(rows.get(item.after_message_id) || []),
      { ...item, provider_label: SCHEDULER_LABELS[item.provider] || item.provider, duration: format_ms(item.detail?.[0]?.duration_ms),
        title: `${SCHEDULER_LABELS[item.provider] || item.provider}${item.confidence === null ? "" : `，置信度 ${Number(item.confidence).toFixed(2)}`}` }]);
  }
  return rows;
});
/** Messages the local service is still analysing; the card gives way once the decision is recorded. */
const routing_messages = stable_computed(() => new Set(room.value.scheduler_routing || []));
/** The host's own plans stand beside the decisions, under the message they followed. */
const host_arrangements = stable_computed(() => {
  const rows = new Map();
  if (view.value.query || view.value.mention_only || view.value.host_only) return rows;
  for (const item of room.value.host_arrangements || []) {
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
  if (seconds < 60) return `${seconds}秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分${String(seconds % 60).padStart(2, "0")}秒`;
  return `${Math.floor(seconds / 3600)}小时${Math.floor((seconds % 3600) / 60)}分${String(seconds % 60).padStart(2, "0")}秒`;
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
  const execution = (room.value.free?.executions || []).find((item) => item.answer_id === message.id);
  return execution?.created_at && execution.finished_at ? Math.max(0, execution.finished_at - execution.created_at) : null;
}
const date_formatter = new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "long" });

const blank = (match) => " ".repeat(match.length);
const escape_html = (value) => value.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);
/** Paint the @mentions that will wake a member behind the transparent editor text; code and quotes do not count. */
const mention_mirror = computed(() => {
  const value = text.value;
  if (!mention_pool.value.length || !value.includes("@")) return "";
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
  const ranges = taken.sort((a, b) => a[0] - b[0]);
  if (!ranges.length) return "";
  let html = "", cursor = 0;
  for (const [start, end] of ranges) {
    html += `${escape_html(value.slice(cursor, start))}<span class="channel-mention">${escape_html(value.slice(start, end))}</span>`;
    cursor = end;
  }
  // The trailing space keeps a final empty line, which the textarea also shows.
  return `${html}${escape_html(value.slice(cursor))} `;
});
const mirror = ref(null);
/** Keep the painted copy at the editor's scroll position. */
function sync_mirror() {
  if (mirror.value && prompt.value?.textareaRef) mirror.value.scrollTop = prompt.value.textareaRef.scrollTop;
}
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
const mention_index = ref(0);
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
watch(() => mention_folder.value?.key, (key, previous) => {
  clearTimeout(mention_search_timer);
  // A lookup cancelled before it started is forgotten, so returning to it reads again instead of loading forever.
  if (previous && mention_results.value[previous] === null) {
    const { [previous]: _cancelled, ...kept } = mention_results.value;
    mention_results.value = kept;
  }
  const folder = mention_folder.value;
  if (!key || key in mention_results.value) return;
  const room_id = room.value.id;
  mention_results.value = { ...mention_results.value, [key]: null };
  // Searching walks the whole project, so it waits for a pause in typing; a folder is read at once.
  mention_search_timer = setTimeout(async () => {
    let entries = [];
    try {
      const result = await bridge.read_room_files(room_id, folder.path || "", 0, folder.search || "");
      if (["directory", "search"].includes(result.kind)) entries = result.entries.filter((entry) => entry.kind !== "unavailable").map(in_extra_directory);
    } catch { /* An unreadable folder or failed search simply offers no files. */ }
    if (room.value?.id === room_id && key in mention_results.value) mention_results.value = { ...mention_results.value, [key]: entries };
  }, folder.search ? MENTION_SEARCH_DELAY_MS : 0);
});
// Read again each time the popup opens so new files appear.
watch(() => !!mention_context.value, (open) => { if (!open) mention_results.value = {}; });
const mention_files = computed(() => {
  const folder = mention_folder.value;
  return (folder && mention_results.value[folder.key] || [])
    .filter((entry) => entry.name !== ".git" && entry.name.toLocaleLowerCase().includes(folder.filter)).slice(0, MENTION_FILE_LIMIT);
});
/** The file group's heading names where its entries come from: the project root, a search, or the folder being browsed. */
const mention_files_group = computed(() => {
  const folder = mention_folder.value;
  return !folder ? "" : folder.search ? "项目文件 · 搜索结果" : folder.path ? `项目文件 · ${folder.path}/` : "项目文件";
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
  ? "需要一位由本机唤醒的 AI 主持人"
  : !room_models.value?.host_workflows ? "需先在电脑上的“成员与设置 → 协作设置”打开“主持人完整权限”" : "");
const workflow_options = computed(() => {
  const query = mention_context.value?.query.toLocaleLowerCase() || "";
  return (view.value.launch.workflows || []).filter((item) => !item.error && `${item.id} ${item.label} ${item.description || ""}`.toLocaleLowerCase().includes(query))
    .map((item) => ({ key: `workflow:${item.id}`, workflow: item, group: "工作流", enabled: room_workflow.value?.id === item.id, disabled: workflow_blocked.value }));
});
/**
 * Platform skills a user may call with "/". A fixed list, never every installed skill: most are the AIs' own operating
 * notes that load by themselves. Picking one only prefills a request to the host; it brings no member.
 */
const PLATFORM_SKILL_COMMANDS = [
  { id: "workflow-creator", label: "新建 / 修改工作流", search: "workflow creator 新建 创建 修改 工作流",
    description: "请主持人按 workflow-creator 技能写工作流", prompt: "用 workflow-creator 技能新建一个工作流：" },
];
const can_call_skill = computed(() => free.value && !room.value?.archived && free_members.value.some((member) => member.role === "host"));
/**
 * Built-in modes come first in "/": they change how the room moves forward, unlike workflows and skills. Picking one
 * only writes its command into the draft; sending it is the owner's decision, and the website checks it again.
 */
const can_use_modes = computed(() => free.value && !room.value?.archived && view.value.access?.can_manage);
const mode_options = computed(() => {
  if (!can_use_modes.value) return [];
  const goal = ["active", "paused"].includes(room.value?.goal_state?.goal?.status) ? room.value.goal_state.goal : null;
  const session = ["active", "paused"].includes(room.value?.session?.status) ? room.value.session : null;
  const host_ready = free_members.value.some((member) => member.role === "host" && member.access === "runner");
  const blocked = !host_ready ? "需要一位由本机唤醒的 AI 主持人" : "";
  const items = goal ? [
    goal.status === "active" ? { command: "/goal pause", label: "暂停 Goal", description: "房间空闲时不再唤醒主持人" }
      : { command: "/goal resume", label: "继续 Goal", description: "继续推进，房间空闲时唤醒主持人" },
    { command: "/goal edit ", label: "修改 Goal 目标", description: "在后面写新的目标" },
    { command: "/goal clear", label: "结束 Goal", description: "房间回到自由协作" },
  ] : session ? [
    session.status === "active" ? { command: "/discuss pause", label: "暂停讨论", description: "停止讨论中的执行，继续后由主持人重新安排" }
      : { command: "/discuss resume", label: "继续讨论", description: "由主持人检查队列并继续" },
    { command: "/discuss stop", label: "结束讨论", description: "房间回到自由协作，记录与结论保留" },
  ] : [
    { command: "/goal ", label: "Goal", description: blocked || "设定目标，主持人持续推进；房间空闲时自动接着做", disabled: blocked },
    { command: "/discuss ", label: "讨论", description: blocked || "主持人安排成员轮流发言，到上限或结束后回到自由协作", disabled: blocked },
  ];
  const query = mention_context.value?.query.toLocaleLowerCase() || "";
  return items.filter((item) => `${item.command} ${item.label} goal discuss 目标 讨论`.toLocaleLowerCase().includes(query))
    .map((item) => ({ key: `mode:${item.command}`, mode: item, group: "模式" }));
});
const skill_options = computed(() => {
  if (!can_call_skill.value) return [];
  const query = mention_context.value?.query.toLocaleLowerCase() || "";
  return PLATFORM_SKILL_COMMANDS.filter((item) => `${item.id} ${item.label} ${item.search}`.toLocaleLowerCase().includes(query))
    .map((item) => ({ key: `skill:${item.id}`, skill: item, group: "平台技能" }));
});
const mention_options = computed(() => mention_context.value?.command ? [...mode_options.value, ...(can_pick_workflow.value ? workflow_options.value : []), ...skill_options.value] : [
  ...mention_members.value.map((name) => ({ key: `member:${name}`, name, group: "成员" })),
  ...mention_folder_self.value.map((option) => ({ ...option, group: mention_files_group.value })),
  ...mention_files.value.map((entry) => ({ key: `file:${entry.path}`, entry, group: mention_files_group.value })),
]);
const mention_heading = computed(() => mention_context.value?.command ? "选择模式、工作流或技能" : project_directory.value ? "选择成员或文件" : "选择成员");
const mention_active = computed(() => mention_options.value[Math.min(mention_index.value, mention_options.value.length - 1)]);
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

/** Locate a "/" command at the very start of the draft, so paths later in the text never trigger it. */
function find_command(value, start, end = start) {
  if (start !== end || !(can_use_modes.value || can_pick_workflow.value || can_call_skill.value)) return null;
  const match = value.slice(0, start).match(/^\/([^\s/]*)$/u);
  if (!match) return null;
  return { start: 0, end: start, query: match[1], command: true };
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
  if (context?.query !== mention_context.value?.query || context?.start !== mention_context.value?.start) mention_index.value = 0;
  mention_context.value = context;
}

/** What @ inserts for a member: its on-screen nickname when that names it alone, otherwise its member name. */
const mention_handle = (name) => GROUP_MENTIONS[name] ? name : bridge.mention_handles(name, free_members.value.map((member) => member.name))[0];
/** Replace just the active token and leave the caret ready for the next word. */
async function select_mention(option) {
  if (!mention_context.value || mention_context.value.composing || !mention_options.value.some((item) => item.key === option.key)) return;
  const { start, end } = mention_context.value;
  if (option.mode) return pick_mode(option, end);
  if (option.workflow) return pick_workflow(option, end);
  if (option.skill) return pick_skill(option, end);
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
    mention_index.value = 0;
    mention_context.value = find_mention(editor.value, editor.selectionStart);
  }
}

/**
 * Replace the "/command" with a request asking the host to enable the workflow, leaving the caret after it for the
 * task. Enabling another workflow replaces the current one; the members the old one brought stay as ordinary members.
 */
async function pick_workflow(option, end) {
  mention_context.value = null;
  if (option.enabled) return bridge.notify("info", `本房间已启用工作流「${option.workflow.label}」`);
  if (option.disabled) return bridge.notify("warning", option.disabled);
  await replace_draft(0, replace_end(end, " "), `启用工作流「${option.workflow.label}」（${option.workflow.id}），`);
  mention_context.value = null;
}

/** Write the mode's command in place of the typed "/…"; one that needs text after it keeps the caret there. */
async function pick_mode(option, end) {
  mention_context.value = null;
  if (option.mode.disabled) return bridge.notify("warning", option.mode.disabled);
  const { command } = option.mode;
  await replace_draft(0, replace_end(end, " "), command);
  mention_context.value = null;
}

/** Replace the "/command" with the skill's request to the host, leaving the caret after it for the user's details. */
async function pick_skill(option, end) {
  mention_context.value = null;
  const { prompt: request } = option.skill;
  await replace_draft(0, replace_end(end, " "), request);
  mention_context.value = null;
}

/** Keep suggestion keys local to the editor; modified Enter is left to the editor. */
function mention_keydown(event) {
  if (event.target !== prompt.value?.textareaRef || !mention_context.value || event.isComposing || event.keyCode === 229) return;
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
  if (event.key === "Escape") mention_context.value = null;
  else if (["ArrowDown", "ArrowUp"].includes(event.key) && mention_options.value.length) {
    const direction = event.key === "ArrowDown" ? 1 : -1;
    mention_index.value = (mention_options.value.indexOf(mention_active.value) + direction + mention_options.value.length) % mention_options.value.length;
    nextTick(() => mention_list.value?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" }));
  } else if (["Enter", "Tab"].includes(event.key) && mention_active.value) select_mention(mention_active.value);
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
    if (context?.query !== mention_context.value?.query) mention_index.value = 0;
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
const transcript_messages = computed(() => free_layout.value);
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
/** Failed free-room executions, shaped like working cards so a failure stays where its work was shown. */
const free_failures = computed(() => {
  if (view.value.query || view.value.mention_only || view.value.host_only) return [];
  const names = new Map((room.value.free?.members || []).map((member) => [member.id, member.name]));
  return (room.value.free?.executions || []).filter((execution) => execution.status === "failed")
    .map((execution) => ({ id: `failed-${execution.id}`, author: execution.member || names.get(execution.member_id) || "成员", slot_card: true, created_at: execution.created_at,
      execution_id: execution.id, request_message_id: execution.request_message_id, anchor_message_id: execution.anchor_message_id,
      discussion_request: execution.requests?.find((request) => request.discussion_session_id),
      failure: { ...execution, elapsed_seconds: execution.finished_at ? Math.max(0, execution.finished_at - execution.created_at) : null } }))
    .concat(undeliverable_requests());
});
/** Pending requests the local service cannot deliver, because it could not take over the member's session; the reason sits under the message. */
function undeliverable_requests() {
  const blocked = new Map((room.value.free?.members || []).filter((member) => member.adopt_error).map((member) => [member.id, member]));
  return (room.value.free?.requests || []).filter((request) => request.status === "pending" && blocked.has(request.member_id))
    .map((request) => ({ id: `undeliverable-${request.id}`, author: blocked.get(request.member_id).name, slot_card: true, undeliverable: true,
      created_at: request.created_at, request_message_id: request.message_id,
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
 * A free-room card keeps the place it first appeared in: each execution takes a slot under the message that asked for it,
 * in execution order, and its answer replaces the working card in that slot. Work whose request is not shown stays at the end.
 * A handoff to the host is the exception: the site names the answer that completed its batch as `anchor_message_id`
 * (it differs from `request_message_id`, the dispatch message), and the handoff follows the whole batch, so it goes under
 * the last top-level message up to that answer, never into the batch's nested slots: what the user asked meanwhile, and
 * its answer, then stay above it instead of below a card that looks stuck in the middle.
 */
const free_layout = computed(() => {
  const messages = view.value.messages.filter((message) => !rewound_runs.value.hidden.has(message.id));
  // Work on a taken-back message is no longer shown under it; a failure there is dropped like any other unshown one.
  const shown = new Set(messages.filter((message) => !message.withdrawn).map((message) => message.id));
  const slots = new Map();
  const executions = new Map((room.value.free?.executions || []).map((execution) => [execution.id, execution]));
  // Shown top-level messages in id order, filled while the messages are placed; a handoff resolves to the last one up to its answer.
  const root_ids = [];
  const root_at = (id) => root_ids.findLast((root) => root <= id) ?? id;
  const place = (item) => {
    if ((!item.execution_id && !item.cancelled_turn && !item.arrangement && !item.undeliverable) || item.withdrawn) return false;
    const request = item.discussion_request || executions.get(item.execution_id)?.requests?.find((value) => value.discussion_session_id);
    const own = item.anchor_message_id ?? item.request_message_id;
    const free_anchor = own !== item.request_message_id ? root_at(own) : own;
    const anchor = item.arrangement?.after_message_id ?? item.cancelled_turn?.after_message_id ?? (request ? request.after_message_id : free_anchor);
    if (!((request || item.cancelled_turn || item.arrangement) && anchor === 0) && !shown.has(anchor)) return false;
    slots.set(anchor, [...(slots.get(anchor) || []), item]);
    return true;
  };
  const roots = messages.filter((message) => {
    if (place(message)) return false;
    if (shown.has(message.id)) root_ids.push(message.id);
    return true;
  });
  // A failure whose request is no longer shown is dropped rather than piled at the end.
  free_failures.value.forEach(place);
  if (!view.value.query && !view.value.mention_only && !view.value.host_only) {
    for (const plan of room.value.host_arrangements || []) place({ id: plan.key || `plan-${plan.id}`, slot_card: true,
      arrangement: plan, created_at: new Date(plan.created_at).getTime() / 1000 });
    for (const turn of room.value.cancelled_turns || []) place({ id: `cancelled-${turn.key || turn.id}`, author: turn.expert,
      slot_card: true, cancelled_turn: turn, execution_id: turn.execution_id, created_at: new Date(turn.created_at).getTime() / 1000 });
    const missed = new Set((room.value.cancelled_turns || []).map((turn) => turn.execution_id));
    for (const execution of executions.values()) {
      if (execution.status !== "cancelled" || execution.answer_id || missed.has(execution.id)) continue;
      // Work that reached the member's software keeps a card where it worked once voided; work never delivered leaves none.
      const request = execution.requests?.find((item) => item.discussion_session_id);
      if (request || execution.capabilities) place({ id: `stopped-${execution.id}`, author: execution.member,
        slot_card: true, cancelled_execution: execution, execution_id: execution.id, created_at: execution.created_at,
        request_message_id: execution.request_message_id, anchor_message_id: execution.anchor_message_id, discussion_request: request });
    }
  }
  const tail = free_working.value.map((item) => ({ ...item, slot_card: true })).filter((item) => !place(item));
  const slot_time = (item) => executions.get(item.execution_id)?.created_at
    ?? (typeof item.created_at === "number" ? item.created_at : new Date(item.created_at).getTime() / 1000);
  const by_start = (left, right) => (slot_time(left) - slot_time(right)) || ((left.execution_id || 0) - (right.execution_id || 0));
  const ordered = [];
  const visit = (item) => {
    ordered.push(item);
    for (const child of (slots.get(item.id) || []).sort(by_start)) visit(child);
  };
  (slots.get(0) || []).sort(by_start).forEach(visit);
  roots.forEach(visit);
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
// earlier ones a few at a time, each slice sized to fit within a frame: while the page is idle, or on every frame while
// the reader nears the top or waits on a jump. Null follows the newest batch; otherwise it is the id of the first shown
// message, so new arrivals never push cards out above the reader.
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
// Real scrolling (not the offsets written here) holds idle slices back: writing scrollTop ends an iOS momentum scroll.
let last_scroll_at = 0;
let written_top = null;
/** Whether the reader is waiting on earlier cards: near the top, or heading for one not rendered. */
function preload_urgent(element) {
  return element.scrollTop < LOAD_EARLIER_MARGIN || not_rendered(pending_jump) || not_rendered(preload_wanted);
}
/** Queue the next slice: on the next frame when urgent, otherwise when the page is idle. */
function schedule_preload(urgent = false) {
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
  if (!urgent && (glide.isAnimating() || performance.now() - last_scroll_at < SCROLL_SETTLE_MS)) return schedule_preload();
  preload_busy = true;
  const started = performance.now();
  const from_bottom = element.scrollHeight - element.scrollTop;
  render_floor.value = floor_before(transcript_messages.value, render_start.value - preload_size);
  await nextTick();
  // Browsers with scroll anchoring have already kept the place; the others are corrected before the frame paints.
  written_top = element.scrollHeight - from_bottom;
  if (element.scrollTop !== written_top) element.scrollTop = written_top;
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
/** Scroll events from the reader, told apart from the offsets the preload writes. */
function note_scroll() {
  if (transcript.value?.scrollTop !== written_top) last_scroll_at = performance.now();
  written_top = null;
}
/** Split continuous history at local calendar boundaries; a working card stays in the day of the card above it. */
const message_groups = stable_computed(() => {
  const groups = [];
  for (const message of transcript_messages.value.slice(render_start.value)) {
    if (message.slot_card && groups.length) { groups.at(-1).messages.push(message); continue; }
    const date = new Date(message.slot_card ? (message.created_at ?? 0) * 1000 : message.created_at);
    const key = date.toLocaleDateString();
    if (groups.at(-1)?.key !== key) groups.push({ key, label: date_formatter.format(date), messages: [] });
    groups.at(-1).messages.push(message);
  }
  return groups;
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
      const label = number ? `第 ${number} 轮` : "未分组";
      const progress = round ? `${round.opinions ?? round.speakers.length}/${round.participants ?? Object.keys(room.value.experts).length} 人已发言` : "尚无参与专家的观点";
      groups.push({ key, number, label, description: `${label} · ${round?.completed ? '已完成' : progress}`, messages: [] });
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
        label: `${group.label} · ${bridge.display_name(message.author)} 的发言 #${message.id}`, index: index++ })),
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
  follow_tail.value = element.scrollHeight - element.scrollTop - element.clientHeight < FOLLOW_TAIL_THRESHOLD;
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
  });
});
onBeforeUnmount(() => reading_position?.disconnect());

// The transcript's scroll position while it glides to a newly sent message; a later retarget keeps its velocity.
const glide = useSpring(0, SEND_SPRING);
glide.on("change", (value) => { if (transcript.value) transcript.value.scrollTop = value; });
glide.on("animationComplete", () => track_scroll());

/** Reveal saved messages without interrupting a reader of earlier records; `smooth` glides there on the send spring. */
async function follow_messages(smooth = false) {
  await nextTick();
  const element = transcript.value;
  if (follow_tail.value && element) {
    const bottom = element.scrollHeight - element.clientHeight;
    // While a send is in flight every follow glides, whichever watcher sees the new card first.
    if ((smooth === true || glide.isAnimating() || view.value.sending_message) && document.documentElement.dataset.motion !== "off") {
      if (!glide.isAnimating()) glide.jump(element.scrollTop);
      glide.set(bottom);
    } else element.scrollTop = bottom;
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
const sending_html = computed(() => view.value.sending_preview ? bridge.render_room_markdown(view.value.sending_preview.text) : "");
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
  if (!view.value.sending_preview.failed) { send_entry.jump(0); send_entry.set(1); }
  follow_messages(true);
});
// Applied after the DOM update and before paint, so the saved card never shows a frame at full opacity.
watch(() => view.value.messages, (messages) => {
  const sent = send_entry.isAnimating() && messages.findLast((message) => message.just_sent);
  if (!sent) return;
  rising_id = sent.id;
  paint_rising(send_entry.get());
}, { flush: "post" });
watch([() => view.value.room?.id, () => view.value.query, () => view.value.mention_only, () => view.value.host_only], () => {
  jump_target.value = null;
  active_message.value = null;
  reset_preview();
  follow_tail.value = true;
  render_floor.value = null;
  pending_jump = preload_wanted = null;
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
  if (!collapsing) transcript.value.scrollTop = scroll_position;
  if (collapsing && card.getBoundingClientRect().top < reading_top(transcript.value)) {
    transcript.value.scrollTop += card.getBoundingClientRect().top - reading_top(transcript.value) - READING_OFFSET;
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
  element.scrollTop += message.getBoundingClientRect().top - reading_top(element) - READING_OFFSET;
  message.focus({ preventScroll: true });
  track_scroll();
}

/** Any manual scroll (wheel, touch drag, scroll keys, scrollbar) turns read-aloud following off; only its button turns it back on. */
function stop_following(event) {
  if (!reader.state.following) return;
  if (event.type === "keydown" && !["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) return;
  if (event.type === "pointerdown" && event.target !== event.currentTarget) return;
  reader.state.following = false;
}

/** Manual scrolling resumes tracking the message at the viewport's upper edge; it also takes over from a glide. */
function resume_tracking(event) {
  glide.stop();
  // Scrolling by hand drops a jump still waiting for its card.
  pending_jump = null;
  if (event.type !== "keydown" || ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) jump_target.value = null;
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
    ...(can_take_back(message) || has_private_chat(message) ? [{ label: "回复", icon: "i-lucide-corner-up-left", onSelect: () => reply_to(message) }] : []),
    ...(narrow.value && message.kind !== "receipt" && editing.value.id !== message.id ? [reader.state.message_id === message.id
      ? { label: "停止朗读", icon: "i-lucide-square", onSelect: () => reader.stop() }
      : { label: "朗读", icon: "i-lucide-volume-2", onSelect: () => reader.start(message.id) }] : []),
    { label: "复制原文链接", icon: "i-lucide-link", onSelect: () => copy_message(message) },
    { label: "查看原文", icon: "i-lucide-expand", onSelect: () => emit("detail", message.id) },
    ...(can_branch(message) && message.author !== "用户" ? [{ label: "从这里分支", icon: "i-lucide-git-branch", onSelect: () => act("fork_room", message.id) }] : []),
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
  return [`将回退 ${plan.messages} 条记录（含这条），进行中的工作会停止`,
    names("cut") && `${names("cut")} 的会话退回到这条消息之前`,
    names("kept") && `${names("kept")} 的会话在其自己的窗口中，无法由本机回退`,
    "成员已改动的文件不会撤销"].filter(Boolean).join("；") + "。";
}

/** Select the shared reply target and focus the library's chat editor. */
async function reply_to(message) { await act("reply", message); prompt.value?.textareaRef?.focus(); }

/** Send the shared draft through the established idempotent controller. */
async function send() {
  if (!has_draft.value || pending.value || view.value.sending_message) return;
  mention_context.value = null;
  follow_tail.value = true;
  const draft = text.value;
  const extra = [file_refs_line(), excerpts_markdown(excerpts.value)].filter(Boolean).join("\n\n");
  if (extra) text.value = draft.trim() ? `${draft.trimEnd()}\n\n${extra}` : extra;
  const sent_text = text.value;
  await act("send");
  // The controller clears the editor once the message is saved; otherwise the cards stay and the typed text comes back.
  if (extra && text.value === sent_text) text.value = draft;
  else if (extra) { file_refs.value = []; file_preview.excerpts = []; }
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
  if (!from_composer || (has_draft.value && !view.value.sending_message) || view.value.sending_preview?.failed) { last_escape = 0; return; }
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
  <section class="channel-conversation" role="tabpanel" aria-label="消息">
    <div v-if="view.query || view.mention_only || view.host_only" class="channel-filter-summary"><span>{{ [view.query && `“${view.query}”`, view.host_only && '只看主持', view.mention_only && `@${bridge.display_name(author)}`].filter(Boolean).join(' · ') }} · {{ view.total }} 条结果</span><UButton label="清除筛选" size="xs" variant="link" color="neutral" @click="search = ''; act('filter', { query: '', mention: false, host: false })" /></div>
    <nav v-if="view.messages.length" ref="message_map" class="channel-message-map" :style="{ '--nav-entry-height': `${NAV_ENTRY_HEIGHT}px` }" aria-label="发言快速导航" @wheel.stop.passive="browse_navigation" @pointerleave="close_preview" @focusout="close_preview" @keydown.esc.stop="close_preview" @contextmenu="navigation_context_menu" @pointerdown="start_scrub" @pointermove="move_scrub" @pointerup="end_scrub" @pointercancel="end_scrub">
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
          <div class="channel-nav-preview-meta">{{ preview_round }} · {{ bridge.sources[preview.source] }} · {{ bridge.format_time(preview.created_at) }}<span v-if="preview.kind === 'moderation'"> · 主持人</span><span v-else-if="preview.kind === 'receipt'"> · 运行回执</span></div>
          <div class="channel-nav-preview-text markdown-body" v-html="preview.summary ? preview.rendered_summary : preview.rendered_text"></div>
        </div>
      </motion.div>
    </Teleport>
    <div v-if="listen_here && !listen_here.touch" class="channel-offer-marks" :style="{ left: `${listen_here.left}px`, top: `${listen_here.top}px` }">
      <button type="button" class="channel-listen-mark" title="把选中的文字作为摘录添加到对话" @mousedown.prevent @click="start_quote"><UIcon name="i-lucide-message-square-quote" />添加到对话</button>
      <button v-if="listen_here.speech" type="button" class="channel-listen-mark" title="从选中处开始朗读" aria-label="从选中处开始朗读" @mousedown.prevent @click="listen_from_selection"><UIcon name="i-lucide-headphones" />朗读</button>
    </div>
    <form v-if="quoting" class="selection-comment" :class="{ 'is-docked': quoting.touch }" :style="quoting.touch ? {} : { left: `${quoting.left}px`, top: `${quoting.top}px` }" @submit.prevent="submit_quote">
      <input ref="quote_input" v-model="quote_comment" type="text" placeholder="添加批注（可选）" aria-label="摘录的批注（可选）" enterkeyhint="send" @keydown="quote_keydown">
      <button type="button" class="selection-comment-cancel" aria-label="取消添加" title="取消" @click="cancel_quote"><UIcon name="i-lucide-x" /></button>
      <button type="submit" class="selection-comment-send" aria-label="添加到对话" title="添加到对话（Enter）"><UIcon name="i-lucide-arrow-up" /></button>
    </form>
    <ExcerptEditCard v-if="mark_editing" :key="mark_editing.excerpt.id" :comment="mark_editing.excerpt.comment" :style="{ left: `${mark_editing.left}px`, top: `${mark_editing.top}px` }" @save="save_mark" @cancel="close_mark" @remove="remove_mark" />
    <div ref="transcript" v-memo="[message_groups, view.sending_preview, message_round_labels, free, room.session, can_manage, expanded_answers.size, reader.state.message_id, room.title, view.query, view.mention_only, view.host_only, topic_anchor, end_anchor, request_badges, execution_reports, recommendations, adopting, scheduler_decisions, host_arrangements, pending, execution_notes, open_working_notes, editing, rewound_runs, retracting_id, armed_cards.size, menu_open_id, stopping_member, free_now, allowing, allow_errors, late_answers, has_draft, view.sending_message, routing_messages, speaking_turn, room.free]" class="channel-transcript" aria-label="聊天记录" @scroll="schedule_track_scroll" @wheel.passive="resume_tracking($event); stop_following($event)" @touchstart.passive="resume_tracking" @touchmove.passive="stop_following" @pointerdown="stop_following" @keydown="resume_tracking($event); stop_following($event)">
      <div v-if="!view.query && !view.mention_only && !view.host_only && !topic_anchor && render_start === 0" class="channel-message-group channel-topic-group"><TopicCard :ref="(card) => topic_card = card" @edit="emit('edit')" /></div>
      <div v-for="group in message_groups" :key="group.key" class="channel-message-group">
        <USeparator :label="group.label" class="channel-date-divider" />
        <template v-for="message in group.messages" :key="message.id">
        <DiscussionEndCard v-if="message.id === end_anchor && !view.query && !view.mention_only && !view.host_only" />
        <TopicCard v-if="message.id === topic_anchor && !view.query && !view.mention_only && !view.host_only" :ref="(card) => topic_card = card" @edit="emit('edit')" />
        <!-- A free-room working card holds the slot its answer will take. -->
        <ScheduleCard v-if="message.arrangement" icon="i-lucide-list-ordered" plain title="主持人创建的发言安排" label="主持人安排" toggle-label="展开或收起各专家的任务">
          <template #text>主持人安排：{{ host_arrangements.get(message.arrangement.after_message_id)?.find((plan) => plan.id === message.arrangement.id)?.label }}<small v-if="message.arrangement.after_message_id">耗时 {{ format_elapsed(arrangement_seconds(message.arrangement, view.messages.find((item) => item.id === message.arrangement.after_message_id))) }}</small></template>
          <p v-for="turn in message.arrangement.turns" :key="`${message.id}-${turn.expert}-${turn.question}`"><span>{{ bridge.display_name(turn.expert) }}：{{ turn.question }}</span></p>
        </ScheduleCard>
        <GoalNoticeCard v-else-if="message.source === 'goal'" :message="message" />
        <ScheduleCard v-else-if="message.source === 'notice'" icon="i-lucide-bell" plain :expandable="false" label="程序通知主持人">
          <template #text>{{ message.text }}</template>
        </ScheduleCard>
        <UChatMessage v-else-if="message.cancelled_turn || message.cancelled_execution" :id="message.id" :data-author="bridge.identities[message.author]?.style" role="assistant" :parts="[]" side="left" variant="naked" color="neutral" class="channel-message" :ui="{ header: 'channel-message-header', container: 'channel-message-container', body: 'channel-message-body' }">
          <template #body>
            <div class="channel-message-byline">
              <UAvatar :src="bridge.identities[message.author]?.icon" :text="bridge.identities[message.author]?.initials || '?'" :alt="bridge.display_name(message.author)" size="md" class="channel-avatar" :class="bridge.identities[message.author]?.style" />
              <div class="channel-message-meta"><div class="channel-message-author"><strong>{{ bridge.display_name(message.author) }}</strong></div></div>
              <span v-if="message.cancelled_turn" class="channel-message-provenance channel-message-elapsed">已错过 · 安排 #{{ message.cancelled_turn.display_id || message.cancelled_turn.id }}</span>
              <span v-else class="channel-message-provenance channel-message-elapsed">{{ stop_state(message.cancelled_execution).label }} · 执行 #{{ message.execution_id }}</span>
            </div>
            <div class="channel-message-text" role="status">{{ message.cancelled_turn ? '本次发言已被跳过或取消，未回答。' : message.cancelled_execution.result || '本次执行已作废，未回答。' }}</div>
            <template v-for="execution in [message.cancelled_execution || (room.free?.executions || []).find((item) => item.id === message.execution_id)].filter((item) => item && stop_state(item).note)" :key="execution.id">
              <p class="channel-message-text channel-stop-note">{{ stop_state(execution).note }}</p>
              <details v-if="execution.late_answer && view.access?.can_manage" class="channel-receipt" @toggle="load_late_answer(execution.id, $event)">
                <summary :aria-label="`查看 ${bridge.display_name(execution.member)} 未采纳的回答`">未采纳的回答</summary>
                <div class="channel-message-text channel-late-answer">{{ late_answers.get(execution.id)?.text ?? '正在读取…' }}</div>
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
            <small class="channel-working-elapsed">{{ message.waiting ? `手动启动${message.created_at ? ` · 已等 ${format_elapsed(Math.max(0, free_now - message.created_at))}` : ''}` : `已用 ${format_elapsed(Math.max(0, free_now - message.created_at))}` }}{{ message.attempt ? ` · 第 ${message.attempt}/${MAX_DELIVERY_RETRIES} 次重试` : '' }}</small>
          </div>
          <!-- Private chat sits in the bottom-right corner, as on the answered card, so the key stays put when the work turns into an answer. -->
          <UTooltip v-if="view.access?.can_manage && shows_progress(message) && message.execution_id" text="私聊：查看它正在做什么"><UButton icon="i-lucide-message-square" class="channel-private-chat-key channel-corner-key" size="xs" variant="ghost" color="neutral" :aria-label="`私聊 ${bridge.display_name(message.author)}：查看本次执行过程`" @click="open_private_chat(act, message.author, message.execution_id)" /></UTooltip>
          <div class="channel-working-main">
            <span v-for="status in [working_status(message)]" :key="message.id" class="channel-working-status" :class="{ 'channel-working-warning': status.warning }" role="status" :title="shows_progress(message) ? (message.waiting ? message.text : status.text) : '此接入方式看不到进度，可在原窗口查看'">
              <span v-if="message.waiting">{{ message.text }}</span>
              <WorkingText v-else-if="status.live" :text="status.text" :seed="message.author" :beat="message.activity_at" :silent="free_now - (message.activity_at || message.created_at)" dots :muted="!shows_progress(message)" />
              <span v-else>{{ status.text }}</span>
            </span>
          <span v-if="view.access?.can_manage" class="channel-working-actions">
              <!-- In a discussion, stopping the current speaker skips the turn so the next one speaks. -->
              <template v-if="speaking_turn?.expert === message.author && message.discussion_request">
                <UTooltip text="暂停讨论"><UButton icon="i-lucide-pause" size="xs" variant="ghost" color="neutral" :aria-label="`暂停讨论，停止 ${bridge.display_name(message.author)} 本次发言`" :disabled="!!pending" :loading="pending === 'pause_discussion'" @click="act('pause_discussion')" /></UTooltip>
                <UTooltip text="停止本次发言，轮到下一位"><UButton variant="solid" color="neutral" class="channel-stop-button" :aria-label="`停止 ${bridge.display_name(message.author)} 本次发言，轮到下一位`" :disabled="!!pending" :loading="pending === 'skip_turn'"
                  @click="act('skip_turn')"><span class="channel-stop-square" /></UButton></UTooltip>
              </template>
              <UTooltip v-else text="停止"><UButton variant="solid" color="neutral" class="channel-stop-button" :aria-label="`停止 ${bridge.display_name(message.author)} 本次执行`" :disabled="!!pending"
                :loading="pending === 'change_member' && stopping_member === message.member_id" @click="stop_member(message)"><span class="channel-stop-square" /></UButton></UTooltip>
          </span>
          </div>
          <div v-for="notes in [working_notes(message)].filter((list) => list.length)" :key="message.execution_id" class="channel-working-notes" :class="{ 'is-open': open_working_notes.has(message.execution_id), 'is-single': notes.length === 1 }">
            <template v-if="open_working_notes.has(message.execution_id)"><p v-for="note in notes.slice(0, -1)" :key="note.seq">{{ note.text }}</p></template>
            <p class="channel-working-latest" @click="notes.length === 1 || open_working_notes.has(message.execution_id) || toggle_working_notes(message.execution_id)">
              <span class="channel-working-latest-text">{{ notes.at(-1).text }}</span>
              <button v-if="notes.length > 1" type="button" class="channel-working-count" :aria-expanded="open_working_notes.has(message.execution_id)" :aria-label="open_working_notes.has(message.execution_id) ? '收起过程说明' : `展开全部 ${notes.length} 段过程说明`" @click.stop="toggle_working_notes(message.execution_id)">{{ notes.length }} 段<UIcon name="i-lucide-chevron-down" /></button>
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
                <div class="channel-message-provenance"><template v-if="message.created_at"><time :title="new Date(message.created_at * 1000).toLocaleString('zh-CN')">{{ bridge.format_time(message.created_at * 1000) }}</time> · </template>{{ message.waiting ? `手动启动${message.created_at ? ` · 已等 ${format_elapsed(Math.max(0, free_now - message.created_at))}` : ''}` : `已用 ${format_elapsed(Math.max(0, free_now - message.created_at))}` }}</div>
              </div>
            </div>
            <div class="channel-working-row">
              <div v-for="status in [working_status(message)]" :key="message.id" class="channel-message-text" :class="{ 'channel-working-warning': status.warning }" role="status" :aria-label="`${bridge.display_name(message.author)} ${status.text}`" :title="shows_progress(message) ? undefined : '此接入方式看不到进度，可在原窗口查看'">
                <span v-if="message.waiting">{{ message.text }}</span>
                <WorkingText v-else-if="status.live" :text="status.text" :seed="message.author" :beat="message.activity_at" :silent="free_now - (message.activity_at || message.created_at)" dots :muted="!shows_progress(message)" />
                <span v-else>{{ status.text }}</span>
              </div>
            </div>
            <template v-if="message.retry">
              <p class="channel-message-text channel-failure-reason is-warning">{{ message.retry.reason }}</p>
              <div class="channel-failure-actions">
                <span class="channel-message-provenance">{{ message.retry.retry_at > free_now ? `${message.retry.retry_at - free_now} 秒后自动重试` : '正在重试' }}（第 {{ message.retry.attempt }}/{{ MAX_DELIVERY_RETRIES }} 次）</span>
                <template v-if="view.access?.can_manage">
                  <UButton label="立即重试" icon="i-lucide-rotate-ccw" size="sm" variant="soft" color="primary" :aria-label="`立即重新投递给 ${bridge.display_name(message.author)}`" :disabled="!!pending"
                    @click="act('retry_delivery', { execution_id: message.execution_id, action: 'retry_now' })" />
                  <UButton label="停止" icon="i-lucide-circle-stop" size="sm" variant="soft" color="error" :aria-label="`停止自动重试 ${bridge.display_name(message.author)} 的投递`" :disabled="!!pending"
                    @click="act('retry_delivery', { execution_id: message.execution_id, action: 'retry_stop' })" />
                </template>
              </div>
            </template>
            <!-- The same row the answer keeps folded after its result: open while working. -->
            <ExecutionNotes v-if="execution_notes.get(message.execution_id)?.length" live :notes="execution_notes.get(message.execution_id)" />
          </template>
        </UChatMessage>
        <section v-else-if="message.failure" :id="message.id" class="channel-message channel-failed-execution" :data-author="bridge.identities[message.author]?.style" :aria-label="`${bridge.display_name(message.author)} ${message.undeliverable ? '无法投递' : '执行失败'}`">
          <div class="channel-message-byline">
            <UAvatar :src="bridge.identities[message.author]?.icon" :text="bridge.identities[message.author]?.initials || '?'" :alt="bridge.display_name(message.author)" size="md" class="channel-avatar" :class="bridge.identities[message.author]?.style" />
            <div class="channel-message-meta">
              <div class="channel-message-author"><strong>{{ bridge.display_name(message.author) }}</strong><span v-if="message.failure.role === 'host'" class="channel-message-round">主持工作</span><UBadge :label="message.undeliverable ? '无法投递' : '执行失败'" color="error" variant="soft" size="xs" /></div>
              <div v-for="at in [message.slot_card ? message.created_at * 1000 : message.created_at]" :key="message.id" class="channel-message-provenance"><time :title="new Date(at).toLocaleString('zh-CN')">{{ bridge.format_time(at) }}</time><span v-if="message.failure.id">执行 #{{ message.failure.id }}</span></div>
            </div>
            <span v-if="message.failure.elapsed_seconds != null" class="channel-message-provenance channel-message-elapsed">耗时 {{ format_elapsed(message.failure.elapsed_seconds) }}</span>
          </div>
          <!-- Same row as the working card it replaced: retry takes the stop button's place. -->
          <div class="channel-working-row">
            <p class="channel-message-text channel-failure-reason">{{ message.failure.result || '执行失败，未提供原因' }}</p>
            <div v-if="can_retry(message.failure)" class="channel-working-actions">
              <UTooltip text="重试"><UButton icon="i-lucide-rotate-cw" variant="solid" color="neutral" class="channel-stop-button channel-retry-button" :aria-label="`把执行 #${message.failure.id} 的请求重新派给 ${bridge.display_name(message.author)}`"
                :disabled="!!pending" :loading="pending === 'retry_delivery'" @click="act('retry_delivery', { execution_id: message.failure.id, action: 'retry' })" /></UTooltip>
            </div>
          </div>
          <ExecutionNotes v-if="message.failure.notes" :count="message.failure.notes" :notes="execution_notes.get(message.failure.id)" @load="load_notes(message.failure.id)" />
          <ExecutionDenials v-if="message.failure.denials?.length" :denials="message.failure.denials" :allowable="Boolean(denial_allowance(message.failure))"
            :busy="allowing === message.failure.id" :error="allow_errors[message.failure.id]" @allow="allow_and_resend(message.failure)" />
        </section>
        <div v-else-if="message.withdrawn" :id="String(message.id)" :data-message-id="message.id" class="channel-withdrawn" :data-author="bridge.identities[message.author]?.style">
          <UIcon :name="message.withdrawn === 'retracted' ? 'i-lucide-undo-2' : 'i-lucide-history'" class="channel-withdrawn-icon" />
          <span v-if="message.withdrawn === 'retracted'">{{ bridge.display_name(message.author) }} 撤回了一条消息</span>
          <template v-else-if="rewound_runs.runs.has(message.id) && !expanded_rewinds.has(message.id)">
            <span>已回退 {{ rewound_runs.runs.get(message.id) }} 条记录</span>
            <UButton label="展开" size="xs" variant="link" color="neutral" :aria-label="`展开从 #${message.id} 起已回退的记录`" @click="toggle_rewound(message.id)" />
          </template>
          <template v-else>
            <strong>{{ bridge.display_name(message.author) }}</strong><span class="channel-withdrawn-text">{{ message.text }}</span>
            <UButton :label="`#${message.id}`" size="xs" variant="link" color="neutral" :aria-label="`查看已回退的原文 #${message.id}`" @click="emit('detail', message.id)" />
            <UButton v-if="rewound_runs.runs.has(message.id)" label="收起" size="xs" variant="link" color="neutral" :aria-label="`收起从 #${message.id} 起已回退的记录`" @click="toggle_rewound(message.id)" />
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
                <div class="channel-message-author"><strong>{{ bridge.display_name(message.author) }}</strong><span class="channel-message-round">{{ card.round_label }}</span><UBadge size="xs" color="neutral" variant="soft" class="channel-source">{{ bridge.sources[message.source] }}</UBadge><UBadge v-if="message.kind === 'moderation'" size="xs" color="neutral" variant="soft" class="channel-source">主持人</UBadge><UBadge v-if="message.kind === 'receipt'" size="xs" color="neutral" variant="soft" class="channel-source">运行回执</UBadge><UBadge v-if="message.proactive" size="xs" color="neutral" variant="soft" class="channel-source" title="成员在自己的窗口里应用户要求主动发言，不是在回答房间的请求">主动发言</UBadge><UBadge v-if="card.waits" size="xs" color="warning" variant="soft" class="channel-source" :title="card.speaking_expert ? `${bridge.display_name(card.speaking_expert)} 说完后交给主持人处理` : '等待主持人处理'">待主持人处理</UBadge><UBadge v-for="badge in card.badges" :key="badge.key" size="xs" :color="badge.color" variant="soft" class="channel-source" :title="badge.title">{{ badge.label }}</UBadge></div>
                <div class="channel-message-provenance"><time :title="new Date(message.created_at).toLocaleString('zh-CN')">{{ bridge.format_time(message.created_at) }}</time><UButton :label="`#${message.id}`" color="neutral" variant="link" size="xs" :aria-label="`查看原文 #${message.id}`" class="channel-message-id" @click="emit('detail', message.id)" /><span v-if="message.submitted_by && message.submitted_by !== message.author && !(message.source === 'proxy' && message.submitted_by === '用户')">{{ bridge.display_name(message.submitted_by) }} 代发</span></div>
              </div>
              <span v-if="card.elapsed !== null" class="channel-message-provenance channel-message-elapsed">耗时 {{ format_elapsed(card.elapsed) }}</span>
            </div>
            <UButton v-if="message.reply_to" :label="`回复 #${message.reply_to}`" icon="i-lucide-corner-up-left" variant="link" color="neutral" size="xs" class="channel-message-reference" :aria-label="`回复 #${message.reply_to} 查看原文`" @click="emit('detail', message.reply_to)" />
            <details v-if="message.kind === 'receipt'" class="channel-receipt">
              <summary :aria-label="`查看运行回执 #${message.id}`">运行回执详情</summary>
              <div class="channel-message-text markdown-body" v-html="message.rendered_text"></div>
            </details>
            <form v-else-if="card.editing" class="channel-edit" :aria-label="`编辑消息 #${message.id}`" @submit.prevent="submit_edit">
              <textarea v-model="editing.text" rows="3" :maxlength="bridge.max_message_length" aria-label="编辑后的消息" @keydown.esc.prevent="cancel_edit" @keydown.enter.ctrl.prevent="submit_edit" @keydown.enter.meta.prevent="submit_edit"></textarea>
              <p class="channel-edit-note" :class="{ 'is-error': card.editing_error }" role="status">{{ card.editing_error || (card.editing_plan ? rewind_summary(card.editing_plan) : '正在读取回退范围…') }}</p>
              <div class="channel-edit-actions">
                <UButton label="取消" size="xs" variant="ghost" color="neutral" @click="cancel_edit" />
                <UButton type="submit" label="回退并发送" size="xs" color="primary" :disabled="!card.editing_plan || (!!card.editing_pending && card.editing_pending !== 'rewind_and_send')" :loading="card.editing_pending === 'rewind_and_send'" />
              </div>
            </form>
            <div v-else class="channel-answer">
              <div :id="`channel-answer-${message.id}`" class="channel-message-text markdown-body" v-html="card.expanded ? message.rendered_text : card.preview.html"></div>
              <button v-for="mark in card.marks" :key="mark.id" type="button" class="excerpt-mark" :style="{ left: `${mark.left}px`, top: `${mark.top}px` }" :title="`摘录 ${mark.number}：点击修改批注`" :aria-label="`修改摘录 ${mark.number} 的批注`" @click="open_mark(mark.id)">{{ mark.number }}</button>
              <UButton v-if="card.preview.truncated" :label="card.expanded ? '收起' : '展开全文'" :trailing-icon="card.expanded ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" variant="link" color="neutral" size="xs" class="channel-answer-toggle" :aria-label="`${card.expanded ? '收起回答' : '展开完整回答'} #${message.id}`" :aria-expanded="card.expanded" :aria-controls="`channel-answer-${message.id}`" @click="toggle_answer(message, $event)" />
            </div>
            <div v-if="message.summary" class="channel-answer-summary"><small>回答摘要<span v-if="message.summary_by && message.summary_by !== message.author"> · {{ bridge.display_name(message.summary_by) }} 整理</span></small><div class="channel-message-text markdown-body" v-html="message.rendered_summary"></div></div>
            <ExecutionNotes v-if="card.notes_count" :count="card.notes_count" :notes="card.notes" @load="load_notes(card.execution_id)" />
            <div v-if="message.attachments?.length" v-html="bridge.attachment_markup(message.attachments)"></div>
            <div v-if="card.recommendation" class="channel-recommendation" :class="`is-${card.recommendation.status}`" aria-label="智能调度推荐" aria-live="polite">
              <template v-for="item in [card.recommendation]" :key="item.message_id">
                <UIcon name="i-lucide-zap" class="channel-recommendation-icon" />
                <span v-if="item.status === 'open'">智能调度建议让 <strong>{{ bridge.display_name(item.member) }}</strong> 回答<small :title="`${item.label}，置信度 ${Number(item.confidence).toFixed(2)}`">置信度 {{ Number(item.confidence).toFixed(2) }} · {{ item.remaining }} 秒</small></span>
                <span v-else-if="item.status === 'waiting'">智能调度：主持人答完后请 {{ bridge.display_name(item.member) }} 回答</span>
                <span v-else>智能调度：{{ item.mode === 'interrupt' ? `已打断主持人，改由 ${bridge.display_name(item.member)} 回答` : `已请 ${bridge.display_name(item.member)} 回答` }}</span>
                <template v-if="item.can_adopt">
                  <UButton v-if="!card.adopting" label="采纳" icon="i-lucide-check" size="xs" variant="soft" color="primary" :aria-label="`采纳建议，请 ${item.member} 回答 #${item.message_id}`" @click="item.host_busy ? adopting = item.message_id : adopt(item.message_id, 'after')" />
                  <template v-else>
                    <UButton :label="`打断主持人，改由 ${bridge.display_name(item.member)} 回答`" size="xs" variant="soft" color="warning" @click="adopt(item.message_id, 'interrupt')" />
                    <UButton :label="`主持人答完后再请 ${bridge.display_name(item.member)}`" size="xs" variant="soft" color="neutral" @click="adopt(item.message_id, 'after')" />
                    <UButton icon="i-lucide-x" aria-label="取消采纳" size="xs" variant="ghost" color="neutral" @click="adopting = 0" />
                  </template>
                </template>
              </template>
            </div>
            <section v-for="{ report, allowable, failed } in card.report_rows" :key="report.id" class="channel-execution-report" :aria-label="`执行报告 #${report.id}`">
              <div><strong>执行 #{{ report.id }} · {{ report.label }}</strong></div>
              <p v-if="report.changes?.length">文件变化：{{ report.changes.join('、') }}</p>
              <p v-if="report.status !== 'completed' && report.result">{{ report.result }}</p>
              <ExecutionDenials v-if="report.denials?.length" :denials="report.denials" :allowable="allowable"
                :busy="card.allowing === report.id" :error="card.allow_errors?.[report.id]" @allow="allow_and_resend(report)" />
              <UButton v-if="failed" label="重发" icon="i-lucide-rotate-ccw" size="xs" variant="soft" color="neutral" :aria-label="`把执行 #${report.id} 的原消息填回输入框重发`" @click="resend_failed(report)" />
            </section>
            <!-- Private chat is what one does after reading, so it waits at the card's bottom-right corner: inside the card and always shown on touch screens,
                 in the hover column's bottom slot outside the card with a mouse (the header copy below). -->
            <div v-if="card.private_chat" class="channel-corner-row"><component :is="card.armed ? UTooltip : BareSlot" disable-hoverable-content :ui="KEY_TIP_UI" text="私聊：查看这次执行的过程"><UButton icon="i-lucide-message-square" class="channel-private-chat-key channel-corner-key" size="xs" color="neutral" variant="ghost" :aria-label="`查看 #${message.id} 的执行过程`" @click="open_private_chat(act, message.author, card.execution_id)" /></component></div>
          </template>
          <template #header><div class="channel-message-actions"><div class="channel-message-toolbar">
            <component :is="card.armed ? UTooltip : BareSlot" disable-hoverable-content :ui="KEY_TIP_UI" v-if="!card.private_chat && !card.can_take_back" text="回复"><UButton icon="i-lucide-corner-up-left" size="xs" color="neutral" variant="ghost" :aria-label="`回复 #${message.id}`" @click="reply_to(message)" /></component>
            <component :is="card.armed ? UTooltip : BareSlot" disable-hoverable-content :ui="KEY_TIP_UI" v-if="card.can_retract && !card.editing" text="撤回"><UButton icon="i-lucide-undo-2" size="xs" color="neutral" variant="ghost" :aria-label="`撤回 #${message.id}`" @click="retract(message.id)" :loading="card.retracting" /></component>
            <component :is="card.armed ? UTooltip : BareSlot" disable-hoverable-content :ui="KEY_TIP_UI" v-if="card.can_take_back && !card.editing" text="编辑"><UButton icon="i-lucide-pencil" size="xs" color="neutral" variant="ghost" :aria-label="`编辑 #${message.id}，回退到它之前重新发送`" @click="start_edit(message)" /></component>
            <component :is="card.armed ? UTooltip : BareSlot" disable-hoverable-content :ui="KEY_TIP_UI" v-if="!card.narrow && message.kind !== 'receipt' && !card.editing" :text="card.reading ? '停止朗读' : '朗读'"><UButton :icon="card.reading ? 'i-lucide-square' : 'i-lucide-volume-2'" size="xs" color="neutral" variant="ghost" :aria-label="card.reading ? '停止朗读' : `从 #${message.id} 开始朗读`" @click="card.reading ? reader.stop() : reader.start(message.id)" /></component>
            <UDropdownMenu v-if="card.armed" :open="card.menu_open" :items="card.actions" :content="{ align: 'end', sideOffset: 5 }" :ui="{ content: 'channel-menu' }" @update:open="(open) => menu_open_id = open ? message.id : 0"><UButton icon="i-lucide-ellipsis" size="xs" color="neutral" variant="ghost" :aria-label="`消息 #${message.id} 的更多操作`" /></UDropdownMenu>
            <UButton v-else icon="i-lucide-ellipsis" size="xs" color="neutral" variant="ghost" :aria-label="`消息 #${message.id} 的更多操作`" aria-haspopup="menu" @click="open_card_menu(message.id)" />
          </div><div v-if="card.private_chat" class="channel-message-toolbar channel-message-corner">
            <component :is="card.armed ? UTooltip : BareSlot" disable-hoverable-content :ui="KEY_TIP_UI" text="私聊：查看这次执行的过程"><UButton icon="i-lucide-message-square" class="channel-private-chat-key" size="xs" color="neutral" variant="ghost" :aria-label="`查看 #${message.id} 的执行过程`" @click="open_private_chat(act, message.author, card.execution_id)" /></component>
          </div></div></template>
        </UChatMessage>
        </MemoBlock>
        </template>
        <!-- A decision stands between the card that ended the round and the next speaker. -->
        <ScheduleCard v-if="routing_messages.has(message.id) && !scheduler_decisions.get(message.id)?.length" icon="i-lucide-zap" skipped label="智能调度分析中" :expandable="false">
          <template #text><WorkingText text="智能调度：正在分析" seed="智能调度" dots /></template>
        </ScheduleCard>
        <SchedulerDecision v-for="decision in scheduler_decisions.get(message.id) || []" :key="`decision-${decision.id}`" :decision="decision" :free="free" />
        </template>
        </template>
      </div>
      <!-- The message being sent shows at once; the saved copy replaces it when the site answers, and a failed send stays here as a failed card. -->
      <!-- It mirrors a saved card line for line, so the swap changes only "发送中…" into the message number. -->
      <motion.div v-if="view.sending_preview" class="channel-message-group" :style="{ opacity: send_entry, y: send_y }">
        <UChatMessage id="channel-sending-message" :data-author="bridge.identities[view.sending_preview.author]?.style" role="user" :parts="[]" side="left" variant="naked" color="neutral" class="channel-message channel-sending-message" :class="{ 'is-failed': view.sending_preview.failed }" :ui="{ header: 'channel-message-header', container: 'channel-message-container', body: 'channel-message-body' }">
          <template #body>
            <div class="channel-message-byline">
              <UAvatar :src="bridge.identities[view.sending_preview.author]?.icon" :text="bridge.identities[view.sending_preview.author]?.initials || '?'" :alt="bridge.display_name(view.sending_preview.author)" size="md" class="channel-avatar" :class="bridge.identities[view.sending_preview.author]?.style" />
              <div class="channel-message-meta">
                <div class="channel-message-author"><strong>{{ bridge.display_name(view.sending_preview.author) }}</strong><UBadge v-if="view.sending_preview.failed" label="发送失败" color="error" variant="soft" size="xs" /></div>
                <div class="channel-message-provenance"><time>{{ bridge.format_time(view.sending_preview.created_at) }}</time><span v-if="!view.sending_preview.failed" class="channel-sending-status" role="status">发送中…</span></div>
              </div>
            </div>
            <div class="channel-answer"><div class="channel-message-text markdown-body" v-html="sending_html"></div></div>
            <div v-if="view.sending_preview.files.length" class="channel-message-provenance">附件：{{ view.sending_preview.files.join('、') }}</div>
            <template v-if="view.sending_preview.failed">
              <p class="channel-message-text channel-failure-reason" role="alert">{{ view.sending_preview.failed }}；草稿已保留在输入框</p>
              <div class="channel-failure-actions">
                <UButton label="重试" icon="i-lucide-rotate-ccw" size="sm" variant="soft" color="primary" aria-label="重新发送这条消息" :disabled="!has_draft || view.sending_message" @click="send" />
                <UButton label="放弃" icon="i-lucide-x" size="sm" variant="soft" color="neutral" aria-label="放弃发送，移除这张卡片" :disabled="view.sending_message" @click="act('discard_sending')" />
              </div>
            </template>
          </template>
        </UChatMessage>
      </motion.div>
      <div v-if="(topic_anchor === 'end' || end_anchor === 'end') && !view.query && !view.mention_only && !view.host_only" class="channel-message-group">
        <TopicCard v-if="topic_anchor === 'end'" :ref="(card) => topic_card = card" @edit="emit('edit')" />
        <DiscussionEndCard v-if="end_anchor === 'end'" />
      </div>
      <div v-if="!transcript_messages.length && !free_working.length" class="channel-empty"><UIcon :name="view.query || view.mention_only || view.host_only ? 'i-lucide-search' : 'i-lucide-hash'" /><h2>{{ view.query || view.mention_only || view.host_only ? '没有找到消息' : room.title }}</h2><p>{{ view.query || view.mention_only || view.host_only ? '试试其他关键词，或清除筛选。' : bridge.empty_discussion_message(room) }}</p></div>
    </div>
    <div v-if="(transcript_messages.length && !follow_tail) || listen_here?.touch || reader.state.message_id" class="channel-latest-dock">
      <button v-if="listen_here?.touch" type="button" class="channel-listen-pill" @mousedown.prevent @click="start_quote"><UIcon name="i-lucide-message-square-quote" />添加到对话</button>
      <button v-if="listen_here?.touch && listen_here.speech" type="button" class="channel-listen-pill" aria-label="从选中处开始朗读" @mousedown.prevent @click="listen_from_selection"><UIcon name="i-lucide-headphones" />听当前</button>
      <button v-if="reader.state.message_id" type="button" class="channel-listen-pill" :class="{ 'is-on': reader.state.following }" :aria-pressed="reader.state.following" :title="reader.state.following ? '手动滚动即取消跟随' : '页面跟随朗读位置滚动'" @click="reader.state.following ? (reader.state.following = false) : reader.follow()"><UIcon name="i-lucide-locate-fixed" />{{ reader.state.following ? '跟随中' : '跟随' }}</button>
      <button v-if="reader.state.reading" type="button" class="channel-listen-pill" aria-label="退出朗读" @click="reader.stop()"><UIcon name="i-lucide-square" />退出</button>
      <UButton v-if="transcript_messages.length && !follow_tail" icon="i-lucide-arrow-down" color="neutral" variant="outline" aria-label="回到最新消息" class="channel-latest-button" @click="return_to_latest" />
    </div>
    <div class="channel-composer-dock"><div class="channel-composer-column" @dragover="bridge.drop_attachments" @drop="bridge.drop_attachments" @paste="bridge.paste_attachments" @keydown.capture="mention_keydown($event); attachment_shortcut($event)" @input="update_mention" @click="update_mention" @keyup="update_mention" @select="update_mention" @compositionstart="mention_composition" @compositionupdate="mention_composition" @compositionend="mention_composition" @scroll.capture="sync_mirror">
      <UPopover :open="!!mention_context" :reference="mention_anchor" :content="{ side: 'top', align: 'start', sideOffset: 8, onOpenAutoFocus: keep_mention_focus, onCloseAutoFocus: keep_mention_focus }" :ui="{ content: 'channel-select-menu channel-mention-menu' }" @update:open="!$event && (mention_context = null)">
        <template #content>
          <div class="channel-mention-heading"><span>{{ mention_heading }}</span><small>↑↓ 选择 · Enter 确认</small></div>
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
                <UIcon name="i-lucide-workflow" class="channel-mention-file-icon" />
                <span :class="{ 'channel-mention-disabled': option.disabled && !option.enabled }">{{ option.workflow.label }}</span>
                <small :title="option.workflow.description">{{ option.enabled ? '已启用' : option.disabled || option.workflow.description }}</small>
              </template>
              <template v-else-if="option.skill">
                <UIcon name="i-lucide-sparkles" class="channel-mention-file-icon" />
                <span>{{ option.skill.label }}</span>
                <small :title="option.skill.description">{{ option.skill.description }}</small>
              </template>
              <template v-else-if="option.entry">
                <UIcon :name="option.self ? 'i-lucide-folder-check' : option.entry.kind === 'directory' ? 'i-lucide-folder' : 'i-lucide-file-text'" class="channel-mention-file-icon" />
                <span :title="option.entry.path">{{ option.self ? '引用此文件夹' : `${option.entry.name}${option.entry.kind === 'directory' ? '/' : ''}` }}</span>
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
            <p v-if="mention_files_loading" class="channel-mention-empty">正在读取项目目录…</p>
            <p v-else-if="!mention_options.length" class="channel-mention-empty">{{ mention_context?.command ? '没有匹配的工作流或技能' : project_directory ? '没有匹配的成员或文件' : '没有匹配的成员' }}</p>
          </div>
        </template>
      </UPopover>
      <QueuedMessages v-if="room.free?.queued_messages" :queue="room.free.queued_messages" :room-id="room.id" />
      <UChatPrompt ref="prompt" v-model="text" :submit-on-enter="ENTER_SENDS" :enterkeyhint="ENTER_SENDS ? 'send' : 'enter'" :autofocus="false" :rows="1" :maxrows="EDITOR_MAX_ROWS" :placeholder="`发消息到 # ${room.title}`" aria-label="留言正文" role="combobox" aria-autocomplete="list" aria-haspopup="listbox" :aria-expanded="!!mention_context" :aria-controls="mention_context ? 'channel-mention-list' : undefined" :aria-activedescendant="mention_context && mention_active ? `channel-mention-${mention_options.indexOf(mention_active)}` : undefined" variant="outline" color="neutral" class="channel-composer" :class="{ 'has-mentions': mention_mirror }" :ui="{ header: 'channel-composer-header', base: 'channel-editor', footer: 'channel-composer-footer' }" @submit="send">
        <template #header>
          <div v-if="view.attachment_drafts.length || file_refs.length || excerpts.length" class="attachment-drafts">
            <UPopover v-if="excerpts.length" :content="{ side: 'top', align: 'start' }" @update:open="editing_excerpt = 0">
              <div class="excerpt-chip" role="button" tabindex="0" title="查看摘录、修改批注">
                <UIcon name="i-lucide-message-square-quote" /><span>{{ excerpts.length }} 条摘录</span>
                <button type="button" class="excerpt-chip-clear" aria-label="移除全部摘录" title="移除全部摘录" :disabled="view.sending_message" @click.stop="file_preview.excerpts = []"><UIcon name="i-lucide-x" /></button>
              </div>
              <template #content>
                <ol class="excerpt-list" aria-label="摘录">
                  <li v-for="(excerpt, index) in excerpts" :key="excerpt.id">
                    <span class="excerpt-number">{{ index + 1 }}.</span>
                    <div class="excerpt-item">
                      <small>选中文字 · {{ excerpt_source(excerpt) }}</small>
                      <p class="excerpt-text">{{ excerpt.text }}</p>
                      <template v-if="editing_excerpt === excerpt.id">
                        <small>批注</small>
                        <UTextarea v-model="excerpt.comment" :rows="2" autoresize autofocus placeholder="添加批注（可选）" aria-label="摘录的批注" class="w-full" />
                      </template>
                      <template v-else-if="excerpt.comment"><small>批注</small><p class="excerpt-comment">{{ excerpt.comment }}</p></template>
                    </div>
                    <div class="excerpt-actions">
                      <button type="button" :aria-label="`修改摘录 ${index + 1} 的批注`" title="修改批注" @click="editing_excerpt = editing_excerpt === excerpt.id ? 0 : excerpt.id"><UIcon name="i-lucide-pencil" /></button>
                      <button type="button" :aria-label="`移除摘录 ${index + 1}`" title="移除" :disabled="view.sending_message" @click="remove_excerpt(excerpt)"><UIcon name="i-lucide-trash-2" /></button>
                    </div>
                  </li>
                </ol>
              </template>
            </UPopover>
            <div v-for="ref_item in file_refs" :key="`ref:${ref_item.path}`" class="attachment-draft-file attachment-draft-ref" :title="ref_item.path">
              <span v-if="ref_item.kind === 'file'" v-html="bridge.attachment_file_icon(ref_item.name)"></span>
              <UIcon v-else name="i-lucide-folder" class="attachment-ref-folder" />
              <span class="attachment-name"><span>{{ ref_item.name }}</span><small>{{ ref_item.kind === 'directory' ? '项目文件夹' : '项目文件' }} · {{ ref_item.path }}</small></span>
              <button type="button" class="attachment-remove" :aria-label="`移除 ${ref_item.path}`" :disabled="view.sending_message" @click="file_refs = file_refs.filter((item) => item !== ref_item)"><UIcon name="i-lucide-x" /></button>
            </div>
            <div v-for="file in view.attachment_drafts" :key="file.id" :class="file.preview_url ? 'attachment-draft-image' : 'attachment-draft-file'">
              <img v-if="file.preview_url" :src="file.preview_url" :alt="file.file_name" :title="file.file_name">
              <template v-else>
                <span v-html="bridge.attachment_file_icon(file.file_name)"></span>
                <span class="attachment-name"><span :title="file.file_name">{{ file.file_name }}</span><small>{{ bridge.attachment_size(file.size) }}</small></span>
              </template>
              <button type="button" class="attachment-remove" :aria-label="`移除 ${file.file_name}`" :disabled="view.sending_message" @click="act('remove_attachment', file.id)"><UIcon name="i-lucide-x" /></button>
              <span v-if="file.uploading" class="attachment-uploading" role="status" :aria-label="`正在上传 ${file.file_name}`"><UIcon name="i-lucide-loader-circle" /></span>
            </div>
          </div>
          <div v-for="unregistered_member in unregistered_members" :key="unregistered_member.name" class="channel-reply-draft channel-queue-hint"><UIcon name="i-lucide-user-round-x" /><span>{{ bridge.display_name(unregistered_member.name) }} 待注册：在其会话中粘贴启动指令</span><UButton v-if="view.access?.can_manage" :icon="launch_copied === unregistered_member.name ? 'i-lucide-check' : 'i-lucide-copy'" :label="launch_copied === unregistered_member.name ? '已复制' : '复制启动指令'" aria-live="polite" size="xs" color="neutral" variant="ghost" class="channel-launch-copy" @click="copy_launch(unregistered_member.name)" /></div>
          <div v-if="queue_hint" class="channel-reply-draft channel-queue-hint"><UIcon name="i-lucide-clock" /><span>{{ queue_hint }}</span><UButton v-if="is_manual_member(speaking_member) && view.access?.can_manage" :icon="launch_copied === speaking_member.name ? 'i-lucide-check' : 'i-lucide-copy'" :label="launch_copied === speaking_member.name ? '已复制' : '复制启动指令'" aria-live="polite" size="xs" color="neutral" variant="ghost" class="channel-launch-copy" @click="copy_launch(speaking_member.name)" /></div>
          <div v-if="view.editing_queued" class="channel-reply-draft"><UIcon name="i-lucide-pencil" /><span>编辑排队消息：发送即保存修改，仍按原位置排队</span><UButton icon="i-lucide-x" color="neutral" variant="ghost" size="xs" aria-label="取消编辑排队消息" @click="act('queue_cancel_edit')" /></div>
          <div v-if="view.reply_to" class="channel-reply-draft"><UIcon name="i-lucide-corner-up-left" /><span>{{ `回复 #${view.reply_to}` }}</span><UButton icon="i-lucide-x" color="neutral" variant="ghost" size="xs" aria-label="取消回复" @click="act('cancel_reply')" /></div>
        </template>
        <div v-if="mention_mirror" ref="mirror" class="channel-editor channel-editor-mirror" aria-hidden="true" v-html="mention_mirror"></div>
        <template #footer>
          <!-- Voice input takes over the whole footer: discard on the left, live levels in the middle, finish where send was. -->
          <template v-if="voice.state.status">
            <UTooltip :text="ENTER_SENDS ? '取消 · Esc' : '取消'"><UButton type="button" icon="i-lucide-x" color="neutral" variant="ghost" size="sm" class="channel-voice-button" aria-label="取消语音输入" @click="voice.cancel()" /></UTooltip>
            <span class="channel-voice-levels" :class="{ 'is-discarding': voice_hold.discard }" role="status" :aria-label="voice.state.status === 'recording' ? `正在录音 ${format_voice_time(voice.state.seconds)}` : '正在识别'">
              <template v-if="voice.state.status === 'recording'"><span class="channel-voice-bars"><i v-for="(level, index) in voice.state.levels" :key="index" :style="{ transform: `scaleY(${0.15 + level * 0.85})` }" /></span><small>{{ format_voice_time(voice.state.seconds) }}</small><small v-if="voice_hold.by" class="channel-voice-hint">{{ voice_hold.discard ? '松开取消' : voice_hold.by === 'touch' ? '松开转文字 · 上滑取消' : '松开空格转文字' }}</small></template>
              <small v-else>正在识别…</small>
            </span>
            <UTooltip :text="ENTER_SENDS ? '完成，转成文字 · Enter' : '完成，转成文字'"><UButton type="button" icon="i-lucide-check" color="neutral" size="sm" class="channel-primary-button channel-round-button" aria-label="结束录音并转成文字" :loading="voice.state.status === 'transcribing'" @click="voice.toggle()" /></UTooltip>
          </template>
          <template v-else>
            <UButton type="button" icon="i-lucide-paperclip" aria-label="添加附件" title="图片、PDF 或其他文件 · 每个最多 20 MiB" color="neutral" variant="ghost" size="sm" :disabled="view.sending_message" @click="act('choose_attachments')" />
            <UTooltip v-if="speech_ready" :text="broadcast.on.value ? '关闭语音播报' : '语音播报：新回复自动朗读摘要'"><UButton type="button" icon="i-lucide-radio" color="neutral" variant="ghost" size="sm" class="channel-voice-button channel-broadcast-button" :class="{ 'is-on': broadcast.on.value }" :aria-pressed="broadcast.on.value" :aria-label="broadcast.on.value ? '关闭语音播报' : '开启语音播报'" @click="broadcast.toggle()" /></UTooltip>
            <UTooltip :text="ENTER_SENDS ? '语音输入 · 也可按住空格说话' : '按住说话，或轻点开始'"><UButton type="button" icon="i-lucide-mic" color="neutral" variant="ghost" size="sm" class="channel-voice-button channel-voice-mic" aria-label="语音输入" :disabled="view.sending_message" @pointerdown="voice_pointerdown" @click="voice_click" @contextmenu.prevent /></UTooltip>
            <UButton type="button" icon="i-lucide-arrow-up" color="neutral" size="sm" class="channel-primary-button channel-round-button channel-send" aria-label="发送" title="发送 · Enter" :disabled="!has_draft" @click="send" />
          </template>
        </template>
      </UChatPrompt>
      <div class="channel-composer-note"><span>{{ recipient_hint }}</span><span class="channel-draft-length"><span v-if="text_length" :class="{ 'is-near-limit': near_length_limit }">{{ text_length }} / {{ bridge.max_message_length }}<span class="channel-note-divider">·</span></span><span class="channel-key-hint"><kbd>Enter</kbd> 发送<span class="channel-note-divider">·</span><kbd>Shift</kbd>+<kbd>Enter</kbd> 换行</span></span></div>
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
</style>

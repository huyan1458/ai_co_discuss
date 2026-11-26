<script>
import { host_allowed } from '../runner/host_permissions.mjs';
import { ref as module_ref } from "vue";
// Kept outside the component so creating a room or visiting the welcome page (which unmounts this view while no room
// is open) does not refold expanded messages, rewinds or execution notes when returning to the previous room.
const expanded_answers = module_ref(new Set());
const expanded_rewinds = module_ref(new Set());
const open_working_notes = module_ref(new Set());
const execution_notes = module_ref(new Map());
</script>

<script setup>
import { computed, inject, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import ScheduleCard from "./ScheduleCard.vue";
import SchedulerDecision from "./SchedulerDecision.vue";
import TopicCard from "./TopicCard.vue";
import DiscussionEndCard from "./DiscussionEndCard.vue";
import GoalNoticeCard from "./GoalNoticeCard.vue";
import ExecutionDenials from "./ExecutionDenials.vue";
import ExecutionNotes from "./ExecutionNotes.vue";
import BackgroundTaskList from "./BackgroundTaskList.vue";
import WorkingText from "./WorkingText.vue";
import UploadPercent from "./UploadPercent.vue";
import AttachmentUploadRing from "./AttachmentUploadRing.vue";
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
import AnswerFiles from "./AnswerFiles.vue";
import AnswerSites from "./AnswerSites.vue";
import ExecutionChanges from "./ExecutionChanges.vue";
import MessageVisualBody from "./MessageVisualBody.vue";
import { add_excerpt, excerpt_mark_place, excerpt_range, inner_scroll_follower, excerpt_source, excerpts_markdown, file_preview, hold_selection, room_quotes, take_excerpts, text_offset } from "./file-preview.js";
import { keep_reading_position } from "./scroll-anchor.js";
import { open_attachment_picker, guard_token_edit, snap_caret, step_over_token, token_mirror } from "./attachment-tokens.js";
import { FILE_MENTION_PATTERN } from "./file-mention.mjs";
import { slash_insertion } from "../runner/slash_names.mjs";
import MemoBlock from "./memo-block.js";
import UTooltip from "@nuxt/ui/components/Tooltip.vue";
import { motion, useSpring, useTransform } from "motion-v";
import FlipDigit from "./FlipDigit.vue";
import { locale, t } from './i18n.js';
import ExternalMemberDialog from "./ExternalMemberDialog.vue";
import { declined, awaiting_member, copy_seat_link as copy_seat } from "./external-members.js";
import RequestStatus from "./RequestStatus.vue";

const pending_seat = ref(null), pending_seat_open = ref(false);
const emit = defineEmits(["detail", "edit"]);
let topic_card = null;
const { view, bridge, field, act, is_running } = inject("discussion");
// The 设置 → 外观 folding level (ChannelWorkspace.vue FOLD_LEVELS); read where messages fold.
const fold_level = inject("fold_level", ref(null));
const fold_keep = inject("fold_keep", ref(null));
const card_text = inject("card_text", ref(null));
// Typing publishes no snapshot: a publish re-renders the whole transcript, hundreds of milliseconds per key in a long room.
const text = field("message-input", { quiet: true });
const text_length = computed(() => [...text.value].length);
const EDITOR_MAX_ROWS = 6;
const LENGTH_WARNING_RATIO = 0.9;
const RETRACT_ESCAPE_WINDOW_MS = 500;
const near_length_limit = computed(() => text_length.value >= bridge.max_message_length * LENGTH_WARNING_RATIO);
const search = field("search-input");
const transcript = ref(null);
let visual_tail_space = 0;

/** Retain only the scroll range needed to keep a collapsed preview's control on screen. */
function set_visual_tail_space(height) {
  if (height === visual_tail_space) return;
  visual_tail_space = height;
  transcript.value?.style.setProperty("--visual-tail-space", `${height}px`);
}

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
    if (!answer_preview(view.value.messages.find((message) => message.id === id))?.truncated || expanded_answers.value.has(id)) return;
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
const voice_press = use_voice_press({ voice, textarea: () => prompt.value?.textareaRef, text, busy: () => is_running("send") });
const voice_hold = voice_press.hold;
// Where "listen from here" shows for text selected in a message, with the selection kept for the click.
const listen_here = ref(null);
// The phone toolbar has room for three buttons, so read-aloud joins the "more" menu there.
const narrow_query = window.matchMedia("(max-width: 700px)");
const narrow = ref(narrow_query.matches);
const track_narrow = (event) => { narrow.value = event.matches; };
watch(() => view.value.room?.id, () => set_visual_tail_space(0), { flush: "sync" });
// "Listen from here" waits until a selection has settled (pointer released, no change for a moment), and shows only when
// speech is configured on this computer; most selections are for copying.
const LISTEN_SETTLE_MS = 350;
// The offer pills and the comment box sit just above the selection (below it when there is no room), kept on screen.
const QUOTE_OFFER_WIDTH = 190;
const QUOTE_OFFER_HEIGHT = 28;
const QUOTE_COMMENT_WIDTH = 440;
const QUOTE_COMMENT_HEIGHT = 92;
const QUOTE_GAP = 6;
let listen_timer = 0, pointer_down = false, selection_check = 0;
const speech_configured = async () => Boolean((await speech_settings()).api_key_ref);
// A selection being added to the chat: `{ id, range, text, to, touch, left, top }`, waiting for an optional comment.
const quoting = ref(null);
const quote_comment = ref("");
const quote_input = ref(null);
// A quoted passage reopened from its number mark: `{ excerpt, range, left, top }`.
const mark_editing = ref(null);
const MARK_CARD_WIDTH = QUOTE_COMMENT_WIDTH;
const MARK_CARD_HEIGHT = QUOTE_COMMENT_HEIGHT;
// Number marks at the end of each quoted passage still in the composer: message id → [{ number, left, top }].
const excerpt_marks = ref(new Map());
/** Hide the offer while a selection is changing and check again once it settles. */
function schedule_listen() {
  listen_here.value = null;
  selection_check += 1;
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
  // A share page has no conversation to add a quote to.
  if (quoting.value || view.value.share) return;
  const selection = document.getSelection();
  const range = selection?.rangeCount && !selection.isCollapsed ? selection.getRangeAt(0) : null;
  const start = range && (range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer : range.startContainer.parentElement);
  const body = start?.closest(".channel-answer > .channel-message-text");
  const card = body && transcript.value?.contains(body) ? body.closest(".channel-message[data-message-id]") : null;
  const text = card ? range.toString().replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim() : "";
  if (!text) { listen_here.value = null; return; }
  const kept = range.cloneRange();
  // Both buttons show together: wait for whether speech is set up before offering, and drop the offer if the selection
  // changed meanwhile.
  const check = ++selection_check;
  const speech = await speech_configured().catch(() => false);
  if (check !== selection_check || pointer_down || quoting.value) return;
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
// Name of the CSS highlight underlining quoted passages in messages; the file preview keeps its own.
const QUOTED_HIGHLIGHT = "excerpt-quoted";
/** Re-measure where each quoted passage ends, for its number mark, and underline the passages. */
function place_marks() {
  const marks = new Map(), ranges = [];
  file_preview.excerpts.forEach((excerpt, index) => {
    // A visual's result is not text of its message, so it has no place to mark there.
    const body = !excerpt.visual_key && excerpt.message_id && document.getElementById(`channel-answer-${excerpt.message_id}`);
    const place = body && excerpt_mark_place(body, body.parentElement, excerpt.to);
    if (!place) return;
    const range = excerpt_range(body, excerpt.from, excerpt.to);
    if (range) ranges.push(range);
    marks.set(excerpt.message_id, [...(marks.get(excerpt.message_id) || []), { id: excerpt.id, number: index + 1, ...place }]);
  });
  // Runs after every transcript update; a new Map with the same marks would redraw the whole transcript once more.
  if (!same_value(excerpt_marks.value, marks)) excerpt_marks.value = marks;
  if (!globalThis.CSS?.highlights || typeof Highlight !== "function") return;
  if (ranges.length) CSS.highlights.set(QUOTED_HIGHLIGHT, new Highlight(...ranges));
  else CSS.highlights.delete(QUOTED_HIGHLIGHT);
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
  // A wide table or code block scrolls sideways inside its message: its marks follow it.
  transcript.value?.addEventListener("scroll", inner_scroll_follower(() => { if (file_preview.excerpts.length) place_marks(); }), { capture: true, passive: true });
  watch(() => room.value?.id, () => { reader.stop(); voice.cancel(); cancel_quote(); });
  speech_configured().then(set_speech_ready);
});
onBeforeUnmount(() => { document.removeEventListener("selectionchange", schedule_listen); document.removeEventListener("pointerdown", press); document.removeEventListener("pointerup", release); document.removeEventListener("pointercancel", release); window.removeEventListener("resize", place_marks); window.clearTimeout(listen_timer); narrow_query.removeEventListener("change", track_narrow); reader.stop(); voice.cancel(); hold_selection(null); globalThis.CSS?.highlights?.delete(QUOTED_HIGHLIGHT); });
// A folded excerpt ends at a sentence boundary when one falls past this share of its length.
const MESSAGE_PREVIEW_BOUNDARY_SHARE = 0.6;
// The least of a block cut by the fold that is still worth showing; less, and the excerpt ends before the block.
const MESSAGE_PREVIEW_PART_MIN_ROWS = 2;
const MESSAGE_PREVIEW_PART_MIN_LINES = 2;
// When that would leave the excerpt under half its height, it may run this far past it to show the block's least part
// (a phone's table rows are several lines tall each, and dropping the table would leave only the opening line).
const MESSAGE_PREVIEW_STRETCH = 1.5;
// Both what counts as long and how much a folded message keeps follow the screen it is read on (user 2026-11-18, #4871:
// an answer of a few lines was folded for passing a character count; user 2026-11-20, #6099: a fixed 160-character
// excerpt kept too little, and how readily messages fold is a reader's choice). Without a level the first one applies.
// `fold`: a message folds when shown whole it is taller than this share of the window; `keep`: the excerpt's share.
// How much the excerpt keeps is a separate choice (设置 → 阅读 → 折叠后显示, user 2026-11-21), also a share of the window's
// height so phones, tablets and computers each keep lines in proportion to what they show.
const MESSAGE_FOLD_LEVELS = { loose: { fold: 1.2 }, standard: { fold: 0.7 }, compact: { fold: 0.5 } };
// User 2026-11-22, #6937: 0.15 / 0.3 / 0.5 kept only a heading or two on a phone, where the headings alone fill a few
// tenths of the window; even the shortest level should show some of the answer itself.
const MESSAGE_FOLD_KEEP_SHARES = { short: 0.35, medium: 0.6, long: 0.9 };
const MESSAGE_FOLD_KEEP_MIN_LINES = 3;
// The message text's size in px (frontend/channel.css `.channel-message-text`), for estimating its height without laying it out.
const MESSAGE_FONT_PX = 16;
const MESSAGE_LINE_PX = 26;
// Space a card takes from the transcript's column on each kind of screen: its margins, padding and borders.
const MESSAGE_CARD_INSET_PX = 78;
const MESSAGE_CARD_INSET_NARROW_PX = 48;
const MESSAGE_READING_WIDTH_PX = 960;
// The share of a line a Latin character takes against a Chinese one.
const MESSAGE_LATIN_WIDTH = 0.47;
// A table cell's padding across and down (frontend/channel.css), and the narrowest a column wraps to before the table scrolls.
const MESSAGE_TABLE_CELL_PADDING_PX = 26;
const MESSAGE_TABLE_ROW_PADDING_PX = 15;
const MESSAGE_TABLE_COLUMN_MIN_PX = 96;
// Widths closer than this fold the same, so a scrollbar appearing does not refold the room.
const MESSAGE_FOLD_WIDTH_STEP_PX = 40;
const MESSAGE_BLOCK_TAGS = /^(P|H[1-6]|UL|OL|PRE|TABLE|BLOCKQUOTE|HR|DIV|SECTION|DETAILS|FIGURE)$/;

/** The text width of a message card and the height above which it folds, for this window. */
function read_fold_area(box) {
  const level = Object.hasOwn(MESSAGE_FOLD_LEVELS, fold_level.value) ? MESSAGE_FOLD_LEVELS[fold_level.value] : MESSAGE_FOLD_LEVELS.loose;
  const reading = box ? parseFloat(getComputedStyle(box).getPropertyValue("--channel-reading-width")) || MESSAGE_READING_WIDTH_PX : MESSAGE_READING_WIDTH_PX;
  const column = Math.min(box?.clientWidth || window.innerWidth, reading);
  const width = Math.max(MESSAGE_FOLD_WIDTH_STEP_PX, column - (narrow_query.matches ? MESSAGE_CARD_INSET_NARROW_PX : MESSAGE_CARD_INSET_PX));
  const stepped = Math.round(width / MESSAGE_FOLD_WIDTH_STEP_PX) * MESSAGE_FOLD_WIDTH_STEP_PX;
  // Estimates run at the medium text size; the card text size (channel.css --card-text-scale) scales every line, so
  // measure the column and the screen in medium-size units: larger text wraps sooner, and fewer lines fill the same share.
  const scale = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--card-text-scale")) || 1;
  const keep_share = MESSAGE_FOLD_KEEP_SHARES[fold_keep.value] || MESSAGE_FOLD_KEEP_SHARES.medium;
  const keep_lines = Math.max(MESSAGE_FOLD_KEEP_MIN_LINES, Math.floor(window.innerHeight * keep_share / (MESSAGE_LINE_PX * scale)));
  return {
    width: Math.round(stepped / scale),
    limit: Math.round(window.innerHeight * level.fold / scale),
    keep_height: keep_lines * MESSAGE_LINE_PX,
  };
}

/** How wide a run of text stands on one line, in px. */
function estimated_text_width(text) {
  let units = 0;
  for (const character of text.trim()) units += character.codePointAt(0) > 0x2E7F ? 1 : MESSAGE_LATIN_WIDTH;
  return units * MESSAGE_FONT_PX;
}

/** The height of a run of text wrapped to `width`. */
function estimated_text_height(text, width, line = MESSAGE_LINE_PX) {
  return Math.max(1, Math.ceil(estimated_text_width(text) / Math.max(MESSAGE_FONT_PX, width))) * line;
}

/** How many characters from the start of `text` fill `width` px of lines, Latin letters counting narrower than Chinese. */
function characters_within(text, width) {
  let used = 0, count = 0;
  for (const character of text) {
    used += character.codePointAt(0) > 0x2E7F ? MESSAGE_FONT_PX : MESSAGE_FONT_PX * MESSAGE_LATIN_WIDTH;
    if (used > width) break;
    count += 1;
  }
  return count;
}

/** The height of one table: columns share the width by how much they hold, and a table too wide for the card scrolls sideways. */
function estimated_table_height(table, width) {
  return estimated_table_rows(table, width).reduce((total, row) => total + row, 0);
}

/** The height of each row of a table, header rows included, in document order. */
function estimated_table_rows(table, width) {
  const rows = [...table.querySelectorAll("tr")].map((row) => [...row.children].map((cell) => estimated_text_width(cell.textContent)));
  const columns = [];
  for (const row of rows) row.forEach((cell, index) => { columns[index] = Math.max(columns[index] || 0, cell); });
  const content = columns.reduce((total, column) => total + column, 0) || 1;
  const share = (index) => Math.max(MESSAGE_TABLE_COLUMN_MIN_PX, width * columns[index] / content - MESSAGE_TABLE_CELL_PADDING_PX);
  return rows.map((row) => MESSAGE_TABLE_ROW_PADDING_PX
    + Math.max(MESSAGE_LINE_PX, ...row.map((cell, index) => Math.ceil(cell / share(index)) * MESSAGE_LINE_PX)));
}

/** Estimate one inline image grid's height (2 columns on desktop and multi-image phones, 1 column for a single phone image). */
function estimated_inline_grid_height(grid, width) {
  const items = [...grid.children];
  if (!items.length) return 0;
  const phone = narrow_query.matches;
  const cols = phone && items.length === 1 ? 1 : 2;
  const gap = phone ? 8 : 10;
  const max_height = phone ? (items.length === 1 ? 260 : 220) : 280;
  const column = Math.max(120, (width - gap * (cols - 1)) / cols);
  let total = 22;
  for (let index = 0; index < items.length; index += cols) {
    let row = 0;
    for (const item of items.slice(index, index + cols)) {
      const style = item.getAttribute("style") || "";
      const ratio = Number(/--image-ratio-num:\s*([0-9.]+)/.exec(style)?.[1]);
      const natural = Number(/--image-natural-width:\s*([0-9.]+)px/.exec(style)?.[1]);
      const height = ratio > 0 ? Math.min(max_height, Math.min(column, natural || column) / ratio) : Math.min(max_height, column * 0.65);
      row = Math.max(row, height);
    }
    total += row + (index > 0 ? gap : 0);
  }
  return total;
}

/** The height of one block element, margins included. */
function estimated_block_height(block, width) {
  const tag = block.tagName;
  if (block.classList?.contains("attachment-inline-grid")) return estimated_inline_grid_height(block, width);
  if (tag === "PRE") return block.textContent.trimEnd().split("\n").length * MESSAGE_LINE_PX + 54;
  if (tag === "TABLE") return estimated_table_height(block, width) + MESSAGE_FONT_PX;
  if (tag === "HR") return 42;
  if (/^H[1-6]$/.test(tag)) return estimated_text_height(block.textContent, width / 1.2, 32) + 30;
  if (tag === "UL" || tag === "OL") return [...block.children].reduce((height, item) => height + estimated_blocks_height(item, width - 30) + 4, 22);
  if (tag === "BLOCKQUOTE") return estimated_blocks_height(block, width - 35) + 38;
  if (tag === "P") return estimated_text_height(block.textContent, width) + 13;
  return estimated_blocks_height(block, width);
}

/** Estimate how tall rendered message content stands at `width`, without laying it out: this runs for every message. */
function estimated_blocks_height(parent, width) {
  let height = 0, inline = "";
  const end_inline = () => { if (inline.trim()) height += estimated_text_height(inline, width); inline = ""; };
  for (const node of parent.childNodes) {
    if (node.nodeType === Node.ELEMENT_NODE && MESSAGE_BLOCK_TAGS.test(node.tagName)) { end_inline(); height += estimated_block_height(node, width); }
    else inline += node.textContent;
  }
  end_inline();
  return height;
}

const fold_area = ref(read_fold_area(null));
const fold_area_observer = new ResizeObserver(() => {
  const area = read_fold_area(transcript.value);
  // Only a new width refolds: a phone's keyboard or address bar changes the height alone, and must not refold what is being read.
  if (area.width !== fold_area.value.width) fold_area.value = area;
});
watch([fold_level, fold_keep, card_text], () => { fold_area.value = read_fold_area(transcript.value); });
onMounted(() => { if (transcript.value) { fold_area.value = read_fold_area(transcript.value); fold_area_observer.observe(transcript.value); } });
onBeforeUnmount(() => fold_area_observer.disconnect());
const answer_preview_cache = new WeakMap();
/** Reuse immutable message excerpts while the room refreshes; they are made again for a screen of another size. */
/**
 * A message's folded preview, built when its card is drawn (#8162): building one for every message parsed the whole
 * history's HTML and rendered all its Markdown as the room opened, though only the newest cards are mounted.
 */
function answer_preview(message) {
  if (!message) return null;
  let cached = answer_preview_cache.get(message);
  if (cached?.area !== fold_area.value) answer_preview_cache.set(message, cached = { area: fold_area.value, preview: build_answer_preview(message, fold_area.value) });
  return cached.preview;
}
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
function message_identity(message) {
  if (!message.relay_room) return bridge.identities[message.author];
  const identity = bridge.identities[message.relay_member] || bridge.identities[message.relay_host]
    || Object.values(bridge.identities).find(item => item.label === message.relay_host);
  return identity?.style === "user" ? undefined : identity;
}
function message_name(message) {
  return message.relay_room ? message.relay_host : bridge.display_name(message.author);
}
function relay_label(message) {
  const room = message.relay_title ?? t('已删除的房间');
  return message.relay_relation === 'parent' ? t('父房间主持 · {room}', { room })
    : message.relay_relation === 'child' ? t('子房间主持 · {room}', { room }) : t('来自房间「{room}」的主持人', { room });
}
const preview = computed(() => view.value.messages.find((message) => message.id === preview_message.value));
const preview_group = computed(() => navigation_groups.value.find((group) => group.messages.some((message) => message.id === preview_message.value)));
const preview_round = computed(() => preview_group.value?.label);
const preview_index = computed(() => preview_open.value ? navigation_entries.value.findIndex((entry) => entry.key === preview_entry.value) : -1);
const prompt = ref(null);
const follow_tail = ref(true);
const send_clipped = ref(false);
let sent_position = null;
let debug_log = null;

/** Follow growing status cards until scrolling farther would hide the sent message's heading. */
function follow_destination(element) {
  const bottom = element.scrollHeight - element.clientHeight;
  if (!sent_position) return bottom;
  const latest = view.value.messages.at(-1);
  if (view.value.sending_preview?.id !== sent_position.id && latest?.submission_id !== sent_position.id) {
    if (typeof debug_log === "function") debug_log("follow", { send: sent_position.id, reason: "send-no-longer-latest", target: bottom });
    sent_position = null;
    return bottom;
  }
  const preview = element.querySelector(`[data-sending-id="${CSS.escape(sent_position.id)}"]`);
  const card = preview || (latest?.submission_id === sent_position.id && element.querySelector(`[data-message-id="${latest.id}"]`));
  if (!card) {
    if (typeof debug_log === "function") debug_log("follow", { send: sent_position.id, reason: "card-not-mounted", target: bottom });
    return bottom;
  }
  const rise = preview || latest.id === rising_id ? send_y.get() : 0;
  const heading = element.scrollTop + card.getBoundingClientRect().top - rise - reading_top(element) - READING_OFFSET;
  const target = Math.max(0, Math.min(bottom, heading));
  if (typeof debug_log === "function") debug_log("follow", { send: sent_position.id, message: preview ? null : latest.id,
    reason: target < bottom ? "keep-heading" : "bottom", heading, bottom, target, actual: element.scrollTop });
  return target;
}
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
// Share of the cards already shown that one slice adds at least (see preload_slice).
const PRELOAD_RENDERED_SHARE = 0.25;
const PRELOAD_SHARE_CEILING = 40;
// Cards rendered right after a room opens; earlier ones follow in background slices of PRELOAD_BACKGROUND_SLICE once the
// room has settled (ROOM_SETTLE_MS), or at once when the reader nears them or jumps to one.
const PRELOAD_IDLE_CARDS = 100;
const PRELOAD_BACKGROUND_SLICE = 10;
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
// Read inside the cards' slots instead of `view.*` and `room.*`: a slot's reads belong to the child component that renders
// it (UChatMessage, a tooltip), so reading the snapshot there redrew every card on each publish, data changed or not. A
// computed re-reads each snapshot but tells its readers only when its value changes.
const is_share = computed(() => Boolean(view.value.share));
const view_query = computed(() => view.value.query);
const view_source_filter = computed(() => view.value.source_filter);
const current_room_id = computed(() => room.value?.id);
// Every view snapshot rebuilds these lists, empty ones included; the transcript's v-memo keys on them, so keep the old
// reference while their content is the same.
const sending_previews = stable_computed(() => view.value.sending_previews);
const failed_sends = stable_computed(() => view.value.failed_sends);
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
  const key_of = (item) => item.key || item.id || item.message_id;
  const items = new Map((view.value.history_cards?.[kind] || []).map((item) => [key_of(item), item]));
  for (const item of recent || []) items.set(key_of(item), item);
  return [...items.values()];
}
const all_executions = computed(() => with_history("executions", room.value.free?.executions));
const all_decisions = computed(() => with_history("scheduler_decisions", room.value.scheduler_decisions));
const all_arrangements = computed(() => with_history("host_arrangements", room.value.host_arrangements));
const all_cancelled_turns = computed(() => with_history("cancelled_turns", room.value.cancelled_turns));
const all_failure_wakes = computed(() => with_history("failure_wakes", room.value.free?.failure_wakes));
const all_quiet_checkins = computed(() => with_history("quiet_checkins", room.value.free?.quiet_checkins));
/** What the runner last saw a member's software doing; unknown phases keep the generic text. Declared before `free_busy`, which an immediate watch reads during setup. */
const ACTIVITY_LABELS = { thinking: t('正在执行'), command: t('正在运行命令'), tool: t('正在调用工具'), editing: t('正在修改文件'), writing: t('正在撰写回答'), waiting: t('正在等待后台任务') };
/** Active members a free-room message can name; chips appear only when there is a choice. */
const free_members = computed(() => (room.value.free?.members || []).filter((member) => member.status === "active" && !awaiting_member(member)));
/** Declared before `free_busy` too: its cards' line marks (line_marks) read the host. */
const free_host = computed(() => free_members.value.find((member) => member.role === "host"));
/**
 * Who hosted when message `at` was posted (user 2026-11-25, #10406: the host changes over a long task). The site lists
 * each host's term from the event log; live cards (no message ID) and rooms without recorded terms use today's host.
 */
function host_at(at) {
  const terms = room.value.free?.host_terms || [];
  if (typeof at !== "number" || !terms.length) return free_host.value?.name;
  let name = null;
  for (const term of terms) {
    if (term.from != null && term.from > at) break;
    name = term.name;
  }
  return name ?? free_host.value?.name;
}
/** All room work uses member executions; queued requests stay in the side panel. */
const free_busy = computed(() => {
  if (room.value.archived) return [];
  const reports = new Map(all_executions.value.map((execution) => [execution.id, execution]));
  const wake_replaces = new Map(all_failure_wakes.value.map((wake) => [wake.message_id, wake.execution_id]));
  return (room.value.free?.members || []).flatMap((member) => {
    const execution = member.execution;
    if (execution && ["dispatched", "started"].includes(execution.status)) {
      // The delivery did not take (a manual session refused it, or the software failed before starting) and the runner
      // waits to deliver again; once it does, `attempt` keeps which retry is running.
      const retry = execution.retry?.retry_at && !execution.retry.stopped ? execution.retry : null;
      const attempt = !retry && !execution.retry?.stopped ? execution.retry?.attempt || 0 : 0;
      const report = reports.get(execution.id);
      const replaced_id = report?.replaces_execution_id || wake_replaces.get(report?.request_message_id) || 0;
      const replaced = replaced_id ? (reports.get(replaced_id) || { id: replaced_id }) : null;
      const work_message_id = report?.requests?.length
        ? Math.max(...report.requests.map((request) => request.message_id || 0)) || report.request_message_id
        : report?.request_message_id;
      return [{ id: `free-${execution.id}`, author: member.name, member_id: member.id, retry, attempt, replaced,
        text: execution.stale ? t('执行失联：网站已不再接受本次回答，软件停止未确认') : retry ? t('等待自动重试')
          : execution.paused_at ? t('已在私聊中暂停，等你补充后接着做') : ACTIVITY_LABELS[execution.activity] || t('正在处理'),
        paused: Boolean(execution.paused_at), working: !execution.stale && !retry, created_at: execution.created_at, adapter: member.adapter, capabilities: execution.capabilities,
        activity: execution.activity, activity_at: execution.activity_at, model: execution.model || "", effort: execution.effort || "", notes: execution.notes || 0, steps: execution.steps || 0, tools: execution.tools || [],
        background_tasks: execution.background_tasks || [],
        execution_id: execution.id, request_message_id: report?.request_message_id, work_message_id, layout_after: report?.layout_after,
        layout_at: report?.layout_at ?? execution.created_at, background: Boolean(report?.background),
        discussion_request: report?.requests?.find((request) => request.discussion_session_id),
        marks: line_marks(member.name, report) }];
    }
    return [];
  }).sort((left, right) => (left.created_at ?? Infinity) - (right.created_at ?? Infinity));
});
/**
 * What a working card reports while it runs. These change with every progress report (the heartbeat alone moves
 * activity_at), so the transcript's cards leave them out and each card reads them through LiveClock: a report redraws that
 * card's status and tool counts instead of the whole transcript.
 */
const PROGRESS_FIELDS = ["text", "activity", "activity_at", "notes", "steps", "tools"];
const working_progress = computed(() => new Map(free_busy.value.map((item) =>
  [item.execution_id, Object.fromEntries(PROGRESS_FIELDS.map((field) => [field, item[field]]))])));
function without_progress(item) {
  const rest = { ...item };
  for (const field of PROGRESS_FIELDS) delete rest[field];
  return rest;
}
function with_progress(message) {
  const progress = message?.execution_id && working_progress.value.get(message.execution_id);
  return progress ? { ...message, ...progress } : message;
}
/**
 * The same reports in the room's member and execution lists, plus the runner's lease renewals, which nothing on the page
 * shows: the transcript's v-memo keys on the rest of the room.
 */
const EXECUTION_PROGRESS_FIELDS = new Set(["activity", "activity_at", "notes", "steps", "tools", "lease_until"]);
const execution_shape = (execution) => execution && Object.fromEntries(Object.entries(execution).filter(([key]) => !EXECUTION_PROGRESS_FIELDS.has(key)));
const free_shape = stable_computed(() => {
  const free = room.value.free;
  if (!free) return free;
  return { ...free, members: (free.members || []).map((member) => member.execution ? { ...member, execution: execution_shape(member.execution) } : member),
    executions: (free.executions || []).map(execution_shape) };
});
/** Requests that name who answers next: a user's @, a host dispatch, a message to the host. Internal wake-ups are not. */
const QUEUED_PURPOSES = new Set(["ask", "route", "group", "all"]);
/**
 * Requests not yet delivered, shown at once as the member's card (user 2026-11-21, an exception to "only work that has
 * happened"): who answers is known when the message is sent, so the card need not wait for the runner to deliver.
 * Discussion turns have their own arrangement cards; a member that cannot be taken over shows an undeliverable card.
 */
/**
 * Pending requests eligible for a slot card: hide a retried/interrupted request only when a newer *visible* request
 * of the same member is in the same next delivery batch (`next_batch`), so an earlier card never vanishes behind a
 * hidden analysing route card or a request from a separate delivery lane.
 */
function visible_pending_requests(requests, predicate) {
  const eligible = (requests || []).filter(predicate).sort((left, right) => left.id - right.id);
  const latest_batch = new Map();
  for (const request of eligible) {
    if (request.next_batch) latest_batch.set(request.member_id, request.id);
  }
  return eligible.filter((request) => {
    const newer = latest_batch.get(request.member_id);
    const hidden = request.retried && request.next_batch && newer !== request.id;
    if (hidden && typeof debug_log === "function") debug_log("card-hidden", { request: request.id, message: request.message_id,
      reason: "newer-visible-in-next-batch", newer });
    return !hidden;
  });
}
const free_queued = computed(() => {
  // A share page is frozen in time: a request pending when it was made would say "waking" forever.
  if (room.value.archived || view.value.query || view.value.share) return [];
  const members = new Map((room.value.free?.members || []).map((member) => [member.id, member]));
  // Requests bundled into the same next execution share one wake-up; separate lanes wait for the next turn.
  const waking = new Set();
  const requests = room.value.free?.requests || [];
  const visible = visible_pending_requests(requests, (request) => request.status === "pending" && !request.execution_id
    && QUEUED_PURPOSES.has(request.purpose) && !request.discussion_session_id
    && members.get(request.member_id)?.status === "active" && !members.get(request.member_id).adopt_error
    // While smart scheduling is still judging an unnamed message the host is not woken yet (user 2026-11-23, #7974):
    // only the "analysing" card shows, and the host's card appears once the judgment says it takes the message.
    && !(request.purpose === "route" && routing_messages.value.has(request.message_id) && !scheduler_decisions.value.get(request.message_id)?.length));
  const has_batch = new Set(visible.filter((request) => request.next_batch).map((request) => request.member_id));
  const cards = visible.map((request) => {
      const member = members.get(request.member_id);
      const busy = ["dispatched", "started"].includes(member.execution?.status);
      const in_batch = Boolean(request.next_batch);
      const waits_batch = !in_batch && has_batch.has(member.id);
      const later = !waits_batch && waking.has(member.id);
      if (!waits_batch) waking.add(member.id);
      // The same states as the member's line in the side panel: a manual member is not woken by the runner, and one
      // out of quota is not delivered to until it recovers.
      const text = member.access === "manual" ? t('等它在自己的会话里接入')
        : member.quota_until ? t('额度已用尽，预计 {time} 恢复', { time: new Date(member.quota_until * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) })
        : busy ? t('排队中：等当前执行结束')
        : waits_batch ? t('排队中：等上一轮结束')
        : later ? (in_batch ? t('将和上一条一起处理') : t('排队中：等上一轮结束'))
        : member.held_until ? t('排队中：等上一轮结束') : t('正在唤醒');
      const queued_at = request.layout_at ?? request.created_at;
      return { id: `queued-${request.id}`, author: member.name, member_id: member.id, queued: true, slot_card: true, text,
        compact_queue: busy && member.access !== "manual" && !member.quota_until, created_at: queued_at, request_message_id: request.message_id,
        layout_after: request.layout_after ?? request.message_id, layout_at: queued_at, marks: line_marks(member.name, null) };
    });
  for (const { message, members: recipients } of view.value.recipient_previews || []) {
    for (const member of recipients) {
      if (requests.some(request => request.message_id === message.id && request.member_id === member.id)) continue;
      const busy = ["dispatched", "started"].includes(member.execution?.status);
      const created_at = Date.parse(message.created_at) / 1000;
      cards.push({ id: `receipt-${message.id}-${member.id}`, author: member.name, member_id: member.id,
        queued: true, slot_card: true, provisional: true, created_at, request_message_id: message.id,
        layout_after: message.id, layout_at: created_at, marks: line_marks(member.name, null),
        compact_queue: busy && member.access !== "manual" && !member.quota_until,
        text: busy ? t('排队中，等它做完当前工作') : t('等待开始…') });
    }
  }
  return cards;
});
const free_now = ref(Math.floor(Date.now() / 1000));
/** Each busy or queued member keeps its own card, so the elapsed time ticks while any is shown. */
watch(() => free_busy.value.length > 0 || free_queued.value.length > 0, (busy, _previous, cleanup) => {
  if (!busy) return;
  free_now.value = Math.floor(Date.now() / 1000);
  const timer = setInterval(() => { free_now.value = Math.floor(Date.now() / 1000); }, 1000);
  cleanup(() => clearInterval(timer));
}, { immediate: true });
/**
 * Reads the ticking clock for its slot only: the slot renders inside this component, so each second redraws just the
 * elapsed texts instead of the whole transcript (a 580-message room spent most of every second redrawing it).
 */
// With a working card as `message`, the slot's `work` is that card with its latest progress (see working_progress). Both
// are getters, so a slot that reads only `work` does not redraw every second.
const LiveClock = { props: { message: { type: Object, default: null } },
  setup: (props, { slots }) => () => slots.default?.({ get now() { return free_now.value; }, get work() { return with_progress(props.message); },
    // Process notes, by execution: each arriving note or opened fold redraws only the cards that read them.
    get note_map() { return execution_notes.value; } }) };
const free_working = computed(() => view.value.query ? [] : free_busy.value);
/** Late text is owner-only and fetched only when its fold opens; never cache it across rooms or loss of access. */
const late_answers = ref(new Map());
// Separate sources, compared one by one: a getter returning a new array fired on every view update, and the new Map
// redrew the whole transcript each time.
watch([() => room.value.id, () => view.value.access?.can_manage], () => { late_answers.value = new Map(); });
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
/** What a working card calls a tool: its own name, or the kind of action for software that does not report names. */
const TOOL_KIND_LABELS = { command: t('命令'), editing: t('编辑'), tool: t('工具') };
const tool_label = (item) => item.tool || TOOL_KIND_LABELS[item.phase];
async function read_note_texts(room_id, execution_id) {
  const { notes } = await bridge.request(`/api/rooms/${room_id}/executions/${execution_id}/notes`);
  return notes;
}
async function load_notes(execution_id) {
  const room_id = room.value.id;
  const early = note_preloads.get(execution_id);
  note_preloads.delete(execution_id);
  try {
    const notes = await (early ? early.catch(() => read_note_texts(room_id, execution_id)) : read_note_texts(room_id, execution_id));
    if (room.value.id === room_id) execution_notes.value = new Map(execution_notes.value).set(execution_id, notes);
  } catch (error) { return error.message || t('过程说明读取失败'); }
}
// Reads of folded notes, by execution. Kept out of execution_notes until opened: that map redraws every card that reads
// it (each through LiveClock), which must not happen for every card scrolled past.
const NOTE_PRELOAD_CONCURRENCY = 2;
const note_preloads = new Map();
const note_preload_queue = new Set();
let note_preloads_running = 0;
watch(() => room.value.id, () => { note_preloads.clear(); note_preload_queue.clear(); });
/** Queue a folded row's notes while it is near the screen; the row reached last is read first. */
function preload_notes(execution_id, near) {
  if (!near) { note_preload_queue.delete(execution_id); return; }
  if (note_preloads.has(execution_id)) return;
  note_preload_queue.add(execution_id);
  run_note_preloads();
}
function run_note_preloads() {
  while (note_preloads_running < NOTE_PRELOAD_CONCURRENCY && note_preload_queue.size) {
    const execution_id = [...note_preload_queue].at(-1);
    note_preload_queue.delete(execution_id);
    note_preloads_running += 1;
    const reading = read_note_texts(room.value.id, execution_id);
    note_preloads.set(execution_id, reading);
    // A failed read is forgotten: opening the row reads again and reports any failure there.
    reading.catch(() => { if (note_preloads.get(execution_id) === reading) note_preloads.delete(execution_id); })
      .finally(() => { note_preloads_running -= 1; run_note_preloads(); });
  }
}
/** Execution ids whose working notes are unfolded; folded by default to the latest note. */
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
/** Sources nearly every card has; the header names only the rare ones (user 2026-11-21, #6448). */
const QUIET_SOURCES = new Set(["user", "cli", "api", "auto"]);
/** The execution that delivered an answer, when the room still lists it. */
function answer_execution(message) {
  return all_executions.value.find((item) => item.answer_id === message.id);
}
/**
 * Which line a card's work belongs to (user 2026-11-20, "多线开发"): the main line is the speaking order the host or the
 * owner set (relay steps, members in turn); a branch is work the owner or host named a member for directly, alongside it.
 * The host's own cards are marked as the host's. Returns the badges for the card header and the class for its edge.
 */
function line_marks(author, execution, kind = "", at = null) {
  // One way to say "the host" on every card (user 2026-11-21): a host note is marked 主持 as well.
  const host = host_at(at) === author || kind === "moderation";
  const line = execution?.line;
  const badges = [];
  if (host) badges.push({ key: "host", label: t('主持'), title: t('主持人：接收未点名的消息并分派工作') });
  if (execution?.followup_of) {
    badges.push({ key: "followup", label: t('续报'), title: t('执行 #{value1} 留下的后台任务在它结束后才回报，这是成员接着交来的结果', { value1: execution.followup_of }) });
  }
  if (execution?.scheduled) {
    badges.push({ key: "scheduled", label: t('定时回报'), title: t('主持人在自己的软件里设的定时到点后，自己起了一轮交来的结果') });
  }
  if (line?.kind === "main") {
    badges.push({ key: "main", label: line.by === "user" ? t('主线 · 第 {value1} 位', { value1: line.step }) : t('主线 · 第 {value1} 棒', { value1: line.step }),
      title: t('按发言顺序推进的主线') });
  } else if (line?.kind === "branch") {
    badges.push({ key: "branch", label: t('支线'), title: line.by === "user" ? t('用户直接点名，不占发言顺序，与主线并行') : t('主持人直接点名，不占发言顺序，与主线并行') });
  }
  return { badges, edge: line?.kind === "branch" ? "is-branch-line" : host ? "is-host-line" : "" };
}
const dispatches = computed(() => new Map((room.value.free?.dispatches || []).map((item) => [item.message_id, item])));
/** What becomes of a host dispatch once its members end (user 2026-11-20), shown on the dispatch message itself. */
function dispatch_badges(message_id) {
  const dispatch = dispatches.value.get(message_id);
  if (!dispatch) return [];
  const marks = {
    relay: { label: t('接力，最后交回主持'), title: t('按顺序一棒接一棒，最后一棒做完交回主持人') },
    handoff: { label: t('做完交回主持'), title: t('派出的成员都结束后（含失败）唤醒主持人，由它决定下一步') },
    direct: { label: t('做完直接给你'), title: t('成员的回答直接给你，不再交回；失败时仍交回主持人') },
    detach: { label: t('后台，不交回'), title: t('后台进行，谁也不等它；做完不交回，失败时通知主持人') },
  };
  // `goes`: where the work goes next, shown after where the card came from (user 2026-11-21).
  const badges = [{ key: "dispatch", goes: true, ...marks[dispatch.mode] }];
  if (dispatch.detached.length) {
    badges.push({ key: "detached", goes: true, label: t('另有后台：{value1}', { value1: dispatch.detached.map((name) => bridge.display_name(name)).join('、') }),
      title: t('这些成员在后台进行，做完不交回') });
  }
  return badges;
}
/** How long the working card has run or waited, with the retry attempt when it is being redelivered. */
function working_elapsed(message, now, { show_replaced = false } = {}) {
  if (message.provisional) return "";
  const spent = format_elapsed(Math.max(0, now - message.created_at));
  const text = message.waiting ? t('手动启动{value1}', { value1: message.created_at ? t(' · 已等 {value1}', { value1: spent }) : '' })
    : message.queued ? t('已等 {value1}', { value1: spent }) : t('已用 {value1}', { value1: spent });
  if (show_replaced && message.replaced && !message.attempt) return t('重试 · {value1}', { value1: text });
  return text + (message.attempt ? t(' · 第 {value1}/{value2} 次重试', { value1: message.attempt, value2: MAX_DELIVERY_RETRIES }) : '');
}
/** Hover text for a host failure wake-up card, naming the failed run it replaced. */
function replaced_title(replaced) {
  const elapsed = replaced.created_at && replaced.finished_at ? format_elapsed(Math.max(0, replaced.finished_at - replaced.created_at)) : "";
  if (elapsed && replaced.result) return t('上次执行 #{id} 耗时 {elapsed} 后失败，已自动重试：{reason}', { id: replaced.id, elapsed, reason: replaced.result });
  if (elapsed) return t('上次执行 #{id} 耗时 {elapsed} 后失败，已自动重试', { id: replaced.id, elapsed });
  if (replaced.result) return t('上次执行 #{id} 失败，已自动重试：{reason}', { id: replaced.id, reason: replaced.result });
  return t('上次执行 #{id} 失败，已自动重试', { id: replaced.id });
}
/**
 * The working card's one status line: the phase while output keeps coming, a warning only after a long silence.
 * Silence while a command runs is expected, so it is named as such instead of a possible hang.
 */
function working_status(message, now) {
  // Data shown after the page was hidden or offline may be old; silence counts only up to when it was last current.
  const observed = view.value.observed_until ? Math.min(now, Math.floor(view.value.observed_until / 1000)) : now;
  const silent = Math.max(0, observed - (message.activity_at || message.created_at));
  // Paused from the private chat: its software is stopped on purpose, so the silence is no hang.
  if (message.paused) return { text: message.text, live: false };
  if (message.queued) return { text: message.text, live: true };
  if (!message.working || !shows_progress(message) || silent < STALL_SECONDS) return { text: message.text, live: message.working };
  if (message.activity === "command") return { text: t('命令已运行 {value1}', { value1: format_elapsed(silent) }), live: true };
  if (message.activity === "waiting") return { text: t('正在等待后台任务，已 {value1}', { value1: format_elapsed(silent) }), live: true };
  // Deep reasoning reports nothing until it ends; only a much longer silence there suggests a hang.
  if (message.activity === "thinking" && silent < THINKING_STALL_SECONDS) return { text: t('正在执行，已 {value1}无中间输出', { value1: format_elapsed(silent) }), live: true };
  return { text: t('已 {value1}无输出，可能卡住', { value1: format_elapsed(silent) }), live: false, warning: true };
}
// A relay stopped at a user gate takes the owner's next unaddressed message as the owner's step.
const relay_waits_owner = computed(() => free.value && Boolean(room.value?.speaking_order?.sequence?.waiting_user));
/** Says in the note line who the draft will reach: the @mentioned members, else the host. */
const recipient_hint = computed(() => {
  const named_group = (aliases) => aliases.some((alias) => MENTION_PATTERN(alias).test(draft_prose.value));
  if (free.value && named_group(SEQUENTIAL_ALIASES)) return t('依次发给 {value1}，前一位结束后下一位开始', { value1: in_turn(free_members.value).map((member) => bridge.display_name(member.name)).join(" → ") });
  if (free.value && named_group(ALL_ALIASES)) return t('发给 {value1}', { value1: free_members.value.map((member) => bridge.display_name(member.name)).join("、") });
  const found = bridge.mentioned_members(text.value, free_members.value.map((member) => member.name));
  const named = free_members.value.filter((member) => found.has(member.name));
  // Who is at work right now decides what sending does (user 2026-11-23, #8182): say it before the owner sends.
  const queue = room.value?.free?.queued_messages;
  const busy = new Set(queue?.busy_members || []);
  const names = (members) => members.map((member) => bridge.display_name(member.name)).join("、");
  if (named.length && free.value) {
    const waiting = named.filter((member) => busy.has(member.name));
    const ready = named.filter((member) => !busy.has(member.name));
    if (!ready.length) return t('{value1} 正忙，这条先排队；可在排队项上插话或打断', { value1: names(waiting) });
    if (waiting.length) return t('立即发给 {value1}；{value2} 正在工作，那份先排队', { value1: names(ready), value2: names(waiting) });
    if (busy.size) return t('立即发给 {value1}，与正在进行的工作并行（支线）', { value1: names(ready) });
    return named.length > 1 ? t('同时发给 {value1}，各自回答，不经主持人', { value1: names(named) })
      : t('直接发给 {value1}，不经主持人', { value1: names(named) });
  }
  if (named.length) return t('直接提问 {value1}，不计讨论轮次；同一成员完成当前执行后回答', { value1: names(named) });
  if (free_members.value.length === 1) return t('发给 {value1}', { value1: bridge.display_name(free_members.value[0].name) });
  if (relay_waits_owner.value && free_host.value) return t('接力在等你回答上方的问题卡；这条消息只发给主持人 {value1}', { value1: bridge.display_name(free_host.value.name) });
  if (free_host.value && free.value && queue?.busy) return t('房间正忙，这条排队后交给主持人 {value1}；@ 空闲成员可立即并行开工', { value1: bridge.display_name(free_host.value.name) });
  // An idle room: say what the plain message does and the other ways to send it (user 2026-11-23, #8189).
  if (free_host.value && free.value) return t('发给主持人 {value1} 分派；@ 成员直接交给它，或用 @全体成员、@全体依次', { value1: bridge.display_name(free_host.value.name) });
  return free_host.value ? t('发给主持人 {value1}；@ 其他成员让它们发言', { value1: bridge.display_name(free_host.value.name) }) : t('未 @ 任何成员：只作留言，不会唤醒 AI');
});
/** Project files picked after @: their @path stays in the draft, and they also show as cards and go out as a trailing line of paths (code-quoted, so they never wake a member). */
const file_refs = ref([]);
// Each room keeps its unsent file cards and quoted passages while another room is open, as its text is kept (app.js
// `room_composer_drafts`), until this page closes. The store outlives this view, which unmounts while no room is open
// (the new-room panel), so the open room's cards are set aside on unmount and taken back on mount.
function stash_room_quotes(room_id) {
  if (room_id && (file_refs.value.length || file_preview.excerpts.length)) room_quotes.set(room_id, { refs: file_refs.value, excerpts: file_preview.excerpts });
  else if (room_id) room_quotes.delete(room_id);
}
let quotes_room_id = "";
watch(() => room.value?.id, (next, previous) => {
  stash_room_quotes(previous || quotes_room_id);
  quotes_room_id = next || "";
  const kept = next && room_quotes.get(next);
  if (kept) room_quotes.delete(next);
  file_refs.value = kept?.refs || [];
  file_preview.excerpts = kept?.excerpts || [];
}, { immediate: true });
onBeforeUnmount(() => { stash_room_quotes(quotes_room_id || room.value?.id); quotes_room_id = ""; file_preview.excerpts = []; });
const file_refs_line = () => file_refs.value.length
  ? t('引用文件：{value1}', { value1: file_refs.value.map((ref) => `\`${ref.path}${ref.kind === "directory" ? "/" : ""}\``).join("、") }) : "";
// Passages quoted from the file preview ("添加到对话") wait as cards and go out after the text, each as a quote with its comment.
const excerpts = computed(() => file_preview.excerpts);
// Visual panels may hand their result to this composer only where the reader can send.
watch(() => !view.value.share && !view.value.destroying.includes(view.value.room?.id), (writable) => { file_preview.visual_results = writable; }, { immediate: true });
onBeforeUnmount(() => { file_preview.visual_results = false; });
const has_draft = computed(() => Boolean(text.value.trim() || view.value.attachment_drafts.length || file_refs.value.length || excerpts.value.length));
watch(() => file_preview.focus_composer, () => nextTick(() => prompt.value?.textareaRef?.focus()));
// Editing a queued message takes it off the queue into the composer; the caret goes to its end so typing continues it.
watch(() => view.value.queued_taken, (count) => count && nextTick(() => {
  const area = prompt.value?.textareaRef;
  area?.focus();
  area?.setSelectionRange(area.value.length, area.value.length);
}));
// A message taken back, or a queued message being edited, comes back with its excerpts written out after the text; they
// become cards again, so the text stays the owner's own and the notes go out as notes once more.
watch(() => view.value.composer_restored, (count) => {
  if (!count) return;
  const restored = take_excerpts(text.value);
  if (!restored.excerpts.length) return;
  text.value = restored.text;
  file_preview.excerpts = [...file_preview.excerpts, ...restored.excerpts];
});
/** Drop one excerpt from the draft. */
function remove_excerpt(excerpt) { file_preview.excerpts = file_preview.excerpts.filter((item) => item.id !== excerpt.id); }
// The excerpt whose comment is being edited in the composer's excerpt list.
const editing_excerpt = ref(0);
/** In a discussion, an @mention of an active member is a direct question: it wakes that member outside turns, rounds and limits. */
const mention_pool = computed(() => [...(mention_all.value ? [...ALL_ALIASES, ...SEQUENTIAL_ALIASES].map((name) => ({ name })) : []), ...free_members.value]);
/** A draft @mentions a member only outside code and quotes. */
const MENTION_PATTERN = (name) => new RegExp(`(^|[\\s(（，,。；;：:、])@${name}(?![\\w-])`, "u");
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
/** The execution behind a stopped or skipped card, when the room still lists it. */
function voided_execution(message) {
  return message.cancelled_execution || all_executions.value.find((item) => item.id === message.execution_id) || null;
}
/** Seconds an ended execution ran, or null while it has not ended. */
const execution_seconds = (execution) => execution.finished_at ? Math.max(0, execution.finished_at - execution.created_at) : null;
function stop_state(execution) {
  const label = bridge.stop_label(execution);
  const name = bridge.display_name(execution.member);
  // A late answer shows the member did finish the turn; it stays out of the transcript and AI reads.
  if (execution.late_answer) return { label, note: t('{value1} 之后仍交来了回答，未采纳：不进入记录，其他 AI 读不到。', { value1: name }) };
  if (execution.stop_result === "unconfirmed") return { label, note: t('本机尚未确认进程结束，可能仍在生成；网站不再接受本次回答。') };
  // A turn the runner could not stop but saw end (in its window or on its own) reads as stopped.
  if (execution.stop_result !== "stopped" && (execution.stop_result === "unstoppable" || capabilities(execution)?.stoppable === false)) return { label, note: t('{value1} 在自己的窗口或 App 里，本机停不了，可能仍在生成；要立即中断，请到它的窗口或 App 里手动停止。', { value1: name }) };
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
    // The request stays delivering until answered; the runner's delivery report (capabilities) says it reached the software.
    const delivered = request.status === "delivering" && (execution?.status === "started" || Boolean(execution?.capabilities));
    if (delivered) label = t('处理中');
    if (request.status === "pending" && (source.executions || []).some((item) => item.member === request.member && ["dispatched", "started"].includes(item.status))) label = t('等待中：等当前执行结束');
    const title = declined(request) ? (request.external_outcome === "timeout" ? t('对方电脑在时限内没有确认唤醒') : t('对方电脑拒绝了这次唤醒'))
      : request.status === "failed" ? failures.get(request.execution_id) || t('执行失败') : REQUEST_CANCEL_REASONS[request.cancel_reason] || request.cancel_reason || "";
    const answer_execution = (source.executions || []).find((item) => item.answer_id === request.answer_id);
    const answer_label = request.answer_id ? (answer_execution && answer_execution.request_message_id !== request.message_id
      ? t('在 #{id} 一并回答', { id: request.answer_id }) : t('查看回答 #{id}', { id: request.answer_id })) : "";
    badges.set(request.message_id, [...(badges.get(request.message_id) || []),
      { key: request.id, label: `${bridge.display_name(request.member)} · ${label}`, status: label.split("：")[0], color, title, delivering: request.status === "delivering" && !delivered, answer_id: request.answer_id, answer_label }]);
  }
  return badges;
});
// How long a finished execution's card waits for its file changes; a runner that never reports them (no git there, or
// it stopped) leaves no placeholder behind.
const TALLY_WAIT_SECONDS = 60;
const tally_now = ref(Math.floor(Date.now() / 1000));
let tally_timer = 0;
/** Attach each terminal execution to its answer, or to the original request when it has no answer. */
const execution_reports = stable_computed(() => {
  const reports = new Map();
  if (!room.value.free) return reports;
  for (const execution of all_executions.value) {
    if (!["completed", "failed", "cancelled"].includes(execution.status)) continue;
    const changes = (execution.changes || []).filter((path) => execution.edited?.includes(path));
    // The runner counts the changed files once the member's software has exited, seconds after the answer: a member
    // that edited files holds the card's place meanwhile, so the list does not appear from nothing (user 2026-11-19, #5665).
    const tallying = execution.status === "completed" && execution.edits > 0 && execution.changes_recorded === false
      && Math.max(tally_now.value, Math.floor(Date.now() / 1000)) - execution.finished_at < TALLY_WAIT_SECONDS;
    if (execution.status === "completed" && !changes.length && !execution.denials?.length && !tallying) continue;
    // A failed free-room execution keeps its own card in the slot it worked in, and so does a delivered one that was voided.
    if (execution.status === "failed" || (execution.status === "cancelled" && execution.capabilities)) continue;
    const message_id = execution.answer_id || execution.request_message_id;
    const report = { ...execution, changes, tallying, label: execution.status === "cancelled" ? bridge.stop_label(execution) : { completed: t('已完成'), failed: t('失败') }[execution.status] };
    reports.set(message_id, [...(reports.get(message_id) || []), report]);
  }
  return reports;
});
// A placeholder still shown is looked at again when its wait is over.
watch(execution_reports, (reports) => {
  window.clearTimeout(tally_timer);
  if (![...reports.values()].some((list) => list.some((report) => report.tallying))) return;
  tally_timer = window.setTimeout(() => { tally_now.value = Math.floor(Date.now() / 1000); }, TALLY_WAIT_SECONDS * 1000);
}, { immediate: true });
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
      can_adopt: item.status === "open" && view.value.access?.can_manage && !room.value.archived });
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
    if (item.confidence === null && !item.applied && !item.detail?.length && item.texts?.label?.template !== "没有模型判断：{value1}") continue;
    rows.set(item.after_message_id, [...(rows.get(item.after_message_id) || []),
      { ...item, provider_label: SCHEDULER_LABELS[item.provider] || item.provider, duration: format_ms(item.detail?.[0]?.duration_ms),
        title: `${SCHEDULER_LABELS[item.provider] || item.provider}${item.confidence === null ? "" : t('，置信度 {value1}', { value1: Number(item.confidence).toFixed(2) })}` }]);
  }
  return rows;
});
/** Messages the local service is still analysing; the card gives way once the decision is recorded. */
const routing_messages = stable_computed(() => {
  const messages = new Set([...(room.value.scheduler_routing || []), ...pending_routing.value]);
  for (const request of room.value.free?.requests || []) {
    if (request.purpose === "route" && request.status !== "pending") messages.delete(request.message_id);
  }
  return messages;
});
// A message the room's scheduler will judge shows its "analysing" card the moment it is sent, under the sending card and
// then under the saved one, instead of once the local service has picked it up; the decision then takes its place, and a
// card nothing answers within ROUTING_PREVIEW_MS folds away. A queued message shows it once it is really sent.
const ROUTING_PREVIEW_MS = 30000;
const pending_routing = ref(new Set());
/** Whether the scheduler judges this text: on for the room, several members, nobody @named and not a command. */
function routes_by_scheduler(text) {
  if (!free.value || !view.value.launch?.room_models?.scheduler || free_members.value.length < 2 || /^\s*\//.test(text || "")) return false;
  const prose = String(text || "").replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "").replace(/^>.*$/gm, "");
  return ![...ALL_ALIASES, ...SEQUENTIAL_ALIASES].some((name) => MENTION_PATTERN(name).test(prose))
    && !bridge.mentioned_members(text || "", free_members.value.map((member) => member.name)).size;
}
// Only once the files are in and the message itself is on its way: a card for a message still uploading, or retrying
// after a dropped send, would claim analysis the site has not started.
const sending_routes = computed(() => Boolean(view.value.sending_preview) && !view.value.sending_preview.waiting && !sending_uploads.value && !view.value.sending_preview.retrying
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
  if (!value.includes("@")) return [];
  // Masking keeps every offset, so matches in the masked copy point at the same characters of the draft.
  const masked = value.replace(/```[\s\S]*?```/g, blank).replace(/`[^`\n]*`/g, blank).replace(/^>.*$/gm, blank);
  const names = free_members.value.map((member) => member.name);
  // Longest handle first, and a span already highlighted is not highlighted again by a shorter handle inside it.
  const handles = mention_pool.value.flatMap(({ name }) => names.includes(name) ? bridge.mention_handles(name, names) : [name])
    .sort((left, right) => right.length - left.length);
  const taken = [...masked.matchAll(FILE_MENTION_PATTERN)].map((match) => [match.index + match[1].length, match.index + match[0].length]);
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
  : !host_allowed(room_models.value, 'workflows') ? t('需先在电脑上的“成员与设置 → 协作设置”勾选主持人权限“工作流”') : "");
const project_workflows = computed(() => room_models.value?.project_workflows || view.value.launch.project_workflows || []);
const global_workflows = computed(() => view.value.launch.workflows || []);
function workflow_insertion(workflow) {
  const matching = [...project_workflows.value, ...global_workflows.value].filter((item) => item.id === workflow.id);
  return slash_insertion(workflow.id, matching.length > 1 ? workflow : undefined);
}
const workflow_options = computed(() => {
  const query = mention_context.value?.query.toLocaleLowerCase() || "";
  const project_list = project_workflows.value.map((item) => ({ scope: "project", ...item }));
  const global_list = global_workflows.value.map((item) => ({ scope: "global", ...item }));
  const multi_roots = (room_models.value?.project_roots?.length || view.value.launch.project_roots?.length || 0) > 1;
  const is_enabled = (item) => {
    const active = room_workflow.value;
    if (!active || active.id !== item.id) return false;
    const active_scope = active.scope || "global";
    const item_scope = item.scope || "global";
    if (active_scope !== item_scope) return false;
    return item_scope !== "project" || active.project_id === item.project_id;
  };
  const matches = (item) => !item.disabled && `${item.id} ${item.label} ${item.description || ""} ${item.project_name || ""}`.toLocaleLowerCase().includes(query);
  // A workflow that cannot run here stays listed with its reason, but cannot be picked.
  const to_option = (item, group) => {
    const problem = workflow_problem(item);
    const key = item.scope === "project" ? `workflow:project:${item.project_id || ""}:${item.id}` : `workflow:global:${item.id}`;
    return {
      key,
      workflow: item,
      group,
      project_badge: item.scope === "project" && multi_roots && item.project_name ? item.project_name : "",
      needs_trust: Boolean(item.needs_trust),
      enabled: is_enabled(item),
      broken: Boolean(problem),
      disabled: problem || workflow_blocked.value,
    };
  };
  return [
    ...project_list.filter(matches).map((item) => to_option(item, t("本项目工作流"))),
    ...global_list.filter(matches).map((item) => to_option(item, t("全局工作流"))),
  ];
});
// Pending trust confirmation when selecting an untrusted project workflow from "/" or when enable returns workflow_untrusted.
const slash_trust = ref(null);
const trust_submitting = ref(false);
const active_trust_prompt = computed(() => {
  if (slash_trust.value) return { kind: "slash", ...slash_trust.value.workflow };
  const prompt = view.value.launch.workflow_trust_prompt;
  return prompt?.room_id === room.value?.id ? { kind: "enable", ...prompt } : null;
});
const TRUST_ACCESS_LABELS = { read: t("只读"), write: t("可写"), auto: t("自动"), full: t("全放开") };
function close_trust_prompt() {
  if (trust_submitting.value) return;
  if (slash_trust.value) slash_trust.value = null;
  else bridge.dismiss_workflow_trust();
}
async function confirm_trust_prompt() {
  const prompt = active_trust_prompt.value;
  if (!prompt || trust_submitting.value) return;
  trust_submitting.value = true;
  try {
    if (prompt.kind === "slash") {
      const { workflow, start, end } = slash_trust.value;
      await bridge.trust_project_workflow({ id: workflow.id, project_id: workflow.project_id, room_id: room.value?.id || "" });
      slash_trust.value = null;
      const insertion = workflow_insertion(workflow);
      const current_text = text.value || "";
      if (start <= current_text.length && end <= current_text.length && current_text[start] === "/") {
        await replace_draft(start, replace_end(end, " "), insertion);
      } else {
        await replace_draft(current_text.length, current_text.length, current_text && !current_text.endsWith(" ") ? ` ${insertion}` : insertion);
      }
      bridge.notify("info", t("已信任项目工作流「{name}」", { name: workflow.label || workflow.id }));
    } else {
      await bridge.confirm_workflow_trust();
    }
  } catch (error) {
    bridge.notify("error", error.message);
  } finally {
    trust_submitting.value = false;
  }
}
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
/** The sub-workflows of the workflow in use; like a platform skill, picking one only inserts its `/id` for the host. */
const sub_workflow_options = computed(() => {
  const workflow = room_workflow.value;
  if (!can_call_skill.value || !workflow?.sub_workflows?.length) return [];
  const query = mention_context.value?.query.toLocaleLowerCase() || "";
  return workflow.sub_workflows.filter((item) => `${item.id} ${item.label} ${item.description || ""}`.toLocaleLowerCase().includes(query))
    .map((item) => ({ key: `sub-workflow:${item.id}`, group: t('工作流「{value1}」的子工作流', { value1: workflow.label }),
      skill: { ...item, prompt: slash_insertion(item.id) } }));
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
  const match = prefix.match(/(?:^|[\s(（，,。；;：:、])@([^\s@`，,。；;：:、()（）]*)$/u);
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

// A room dragged from the sidebar onto the messages or the composer puts a reference to it at the composer's caret, with
// its id so the host can send to it directly. The sidebar's pointer drag announces itself (web/app.js announce_room_drag).
const conversation = ref(null);
const room_drop = ref(null);
function room_drag({ detail }) {
  const editor = prompt.value?.textareaRef;
  const over = detail.phase !== "cancel" && !detail.touch && detail.id !== room.value?.id && editor && !editor.disabled
    && Boolean(conversation.value?.contains(document.elementFromPoint(detail.x, detail.y)));
  room_drop.value = over && detail.phase === "move" ? { id: detail.id, title: detail.title } : null;
  if (!over || detail.phase !== "drop") return;
  const insertion = `${t("「{title}」（房间 {id}）", { title: detail.title, id: detail.id })} `;
  replace_draft(editor.selectionStart, editor.selectionEnd, insertion);
}
onMounted(() => window.addEventListener("codiscuss:room-drag", room_drag));
onBeforeUnmount(() => window.removeEventListener("codiscuss:room-drag", room_drag));

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
 * Replace the typed "/…" with the workflow's `/id`, which asks the host to enable it, leaving the caret after it for
 * the task. Enabling another workflow replaces the current one; the members the old one brought stay as ordinary members.
 */
async function pick_workflow(option, start, end) {
  mention_context.value = null;
  if (option.enabled) return bridge.notify("info", t('本房间已启用工作流「{value1}」', { value1: option.workflow.label }));
  if (option.disabled) return bridge.notify("warning", option.disabled);
  if (option.workflow.needs_trust) {
    slash_trust.value = { workflow: option.workflow, start, end };
    return;
  }
  await replace_draft(start, replace_end(end, " "), workflow_insertion(option.workflow));
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

/**
 * Clip the text under `root` to about `limit` characters while keeping valid markup. Unless `exact`, end at a sentence
 * boundary when one falls late enough, and mark a cut mid-sentence with an ellipsis.
 */
function clip_text(root, limit, exact = false) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => node.parentElement?.closest('.katex-mathml') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  const characters = [...nodes.map((node) => node.textContent).join("").trimEnd()];
  if (characters.length <= limit) return;
  const prefix = characters.slice(0, limit).join("");
  const boundary = exact ? null : [...prefix.matchAll(/[。！？；]\s*|[.!?;](?:\s|$)|\n/gu)].at(-1);
  const boundary_end = boundary ? boundary.index + boundary[0].length : 0;
  const natural_end = exact || [...prefix.slice(0, boundary_end)].length >= limit * MESSAGE_PREVIEW_BOUNDARY_SHARE;
  let remaining = exact ? prefix.length : natural_end ? boundary_end : prefix.length;
  for (const node of nodes) {
    if (remaining > node.textContent.length) { remaining -= node.textContent.length; continue; }
    const range = document.createRange();
    const formula = node.parentElement?.closest('.katex');
    const row = node.parentElement?.closest('tr');
    if (row?.previousElementSibling) range.setStartBefore(row);
    else if (row) range.setStartAfter(row);
    else if (formula) range.setStartAfter(formula.closest('.katex-display') || formula);
    else range.setStart(node, remaining);
    range.setEnd(root, root.childNodes.length);
    range.deleteContents();
    if (!natural_end && !formula && !row) node.textContent += "…";
    return;
  }
}

/**
 * Keep the part of one block that fits in `room` px, in whole rows, lines or list items. False when too little of it
 * would show to tell the reader anything; the excerpt then ends before the block (user 2026-11-20, #6101: one table row
 * with a scrollbar under a cut heading did not help decide whether to expand).
 */
function clip_block(block, area, room) {
  const lines = Math.floor(room / MESSAGE_LINE_PX);
  const tag = block.tagName;
  if (tag === "TABLE") {
    // Rows are as tall as their longest cell wraps, so they are added up one by one rather than counted.
    const rows = [...block.querySelectorAll("tr")], heights = estimated_table_rows(block, area.width);
    const body = rows.filter((row) => row.parentElement.tagName !== "THEAD");
    let used = MESSAGE_FONT_PX, fit = 0;
    rows.forEach((row, index) => { if (row.parentElement.tagName === "THEAD") used += heights[index]; });
    for (const row of body) {
      used += heights[rows.indexOf(row)];
      if (used > room) break;
      fit += 1;
    }
    if (fit < MESSAGE_PREVIEW_PART_MIN_ROWS) return false;
    for (const row of body.slice(fit)) row.remove();
    return true;
  }
  if (tag === "PRE") {
    const code = block.querySelector("code") || block;
    const fit = lines - 2; // A code block's padding and margins take about two lines.
    if (fit < MESSAGE_PREVIEW_PART_MIN_LINES) return false;
    clip_text(code, code.textContent.split("\n").slice(0, fit).join("\n").length, true);
    return true;
  }
  if (tag === "UL" || tag === "OL") {
    let used = 22, kept = 0;
    for (const item of block.children) {
      used += estimated_blocks_height(item, area.width - 30) + 4;
      if (used > room) break;
      kept += 1;
    }
    if (!kept) return false;
    for (const item of [...block.children].slice(kept)) item.remove();
    return true;
  }
  if (tag === "P" || tag === "BLOCKQUOTE") {
    if (lines < MESSAGE_PREVIEW_PART_MIN_LINES) return false;
    clip_text(block, characters_within(block.textContent, lines * (tag === "P" ? area.width : area.width - 35)));
    return true;
  }
  return false;
}

/**
 * Put back the rows an excerpt cut from its last table, hidden: a table's columns are as wide as all its rows need, so
 * without them the table changed width on expanding (user 2026-11-18, #4885).
 */
function keep_table_columns(fragment, html) {
  const tables = fragment.querySelectorAll("table");
  if (!tables.length) return;
  const source = document.createElement("template");
  source.innerHTML = html;
  const whole = source.content.querySelectorAll("table")[tables.length - 1];
  const clipped = tables[tables.length - 1], shown = clipped.querySelectorAll("tr").length;
  const rows = [...whole.querySelectorAll("tr")];
  if (rows.length <= shown) return;
  for (const row of rows.slice(shown)) row.classList.add("markdown-folded-row");
  clipped.replaceWith(whole);
}

/**
 * Fold a message too tall for this screen: keep whole blocks from its start while they fit the excerpt's height, then
 * whatever part of the next block can still be read on its own, so the excerpt never ends inside a structure.
 */
function build_answer_preview(message, area) {
  const full = { truncated: false, html: message.rendered_text };
  if (message.kind === "receipt") return full;
  const template = document.createElement("template");
  template.innerHTML = message.rendered_text;
  const height = estimated_blocks_height(template.content, area.width);
  if (height <= area.limit) return full;
  const parts = [...template.content.childNodes].filter((node) => node.nodeType === Node.ELEMENT_NODE || node.textContent.trim());
  const part_height = (node) => node.nodeType === Node.ELEMENT_NODE ? estimated_block_height(node, area.width) : estimated_text_height(node.textContent, area.width);
  let used = 0, index = 0;
  for (; index < parts.length; index += 1) {
    const next = part_height(parts[index]);
    if (used + next > area.keep_height) break;
    used += next;
  }
  if (index >= parts.length) return full;
  const cut = parts[index];
  const partial = cut.nodeType === Node.ELEMENT_NODE && (clip_block(cut, area, area.keep_height - used)
    || (used < area.keep_height / 2 && clip_block(cut, area, area.keep_height * MESSAGE_PREVIEW_STRETCH - used)));
  const range = document.createRange();
  if (partial) range.setStartAfter(cut); else range.setStartBefore(cut);
  range.setEnd(template.content, template.content.childNodes.length);
  range.deleteContents();
  // A heading left last would introduce nothing.
  let kept = [...template.content.children];
  while (kept.length > 1 && /^H[1-6]$/.test(kept.at(-1).tagName)) { kept.at(-1).remove(); kept = [...template.content.children]; }
  if (!template.content.textContent.trim()) {
    // The first block alone is taller than the excerpt and cannot be clipped whole: fall back to characters.
    template.innerHTML = message.rendered_text;
    clip_text(template.content, characters_within(template.content.textContent, area.keep_height / MESSAGE_LINE_PX * area.width));
  }
  keep_table_columns(template.content, message.rendered_text);
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
  // Marked where the jump lands, which may be after earlier cards render: near the end the transcript cannot scroll the
  // card to the top, and without a mark the jump looked like it had only gone to the bottom.
  located_id = target;
  if (target == null) return;
  locating_label.value = "";
  locating.value = target;
  clearTimeout(locating_timer);
  locating_timer = setTimeout(() => { locating.value = null; locating_label.value = ""; }, LOCATE_GIVE_UP_MS);
  jump_to(target);
}
const QUIET_MEMBER_SOURCES = new Set(["goal", "room_link", "room_relay_sent", "host_action", "notice"]);
/** Latest card representing one member's speech in the full layout: ongoing execution first, then latest speech or wake-up, else fallback card. */
function latest_member_card(name) {
  const items = free_layout.value;
  const live = items.findLast((item) => item.slot_card && item.author === name && !item.queued && !item.failure && !item.cancelled_turn && !item.cancelled_execution && !item.arrangement);
  if (live) return live;
  const speech = items.findLast((item) => (!item.slot_card && item.author === name && !item.withdrawn && !item.relay_room && !QUIET_MEMBER_SOURCES.has(item.source))
    || (item.slot_card && item.author === name && item.queued && !item.compact_queue));
  if (speech) return speech;
  return items.findLast((item) => item.slot_card && item.author === name && !item.arrangement) || null;
}
/** Jump to one member's latest speech (including an ongoing work card), clearing any active filter first. */
async function locate_member(name) {
  if (!name) return;
  if (view.value.query || view.value.source_filter) {
    await act("filter", { query: "", mention: false, host: false, authors: [], kinds: [] });
    await nextTick();
  }
  awaiting_member_locate = null;
  const target = latest_member_card(name);
  if (!target) {
    if (!view.value.query && (room.value?.message_count || 0) > view.value.messages.length) {
      awaiting_member_locate = name;
      locating_label.value = t('正在查找 {value1} 的最新发言…', { value1: bridge.display_name(name) });
      locating.value = name;
      clearTimeout(locating_timer);
      locating_timer = setTimeout(() => { awaiting_member_locate = null; locating.value = null; locating_label.value = ""; }, LOCATE_GIVE_UP_MS);
      return;
    }
    bridge.notify("info", t('{value1} 在本房间还没有发言', { value1: bridge.display_name(name) }));
    return;
  }
  if (reader_scrolling.value) release_reader();
  glide.stop();
  moved_by_hand = true;
  follow_tail.value = false;
  located_id = target.id;
  locating_label.value = typeof target.id === "number" ? "" : t('正在定位到 {value1}…', { value1: bridge.display_name(name) });
  locating.value = target.id;
  clearTimeout(locating_timer);
  locating_timer = setTimeout(() => { locating.value = null; locating_label.value = ""; }, LOCATE_GIVE_UP_MS);
  jump_to(target.id);
}
/** Where reading was (and which tab, when not here) before a `#123` reference showed its message in place; the return pill goes back. */
const peek_origin = ref(null);
watch(() => room.value?.id, () => { peek_origin.value = null; });
/** Show one message in place in the full transcript, keeping the first origin while the reader follows further references. */
async function peek_message(id, back_to_tab = null) {
  // Message numbers are shared by all rooms: a `#123` quoted from another room is not here, and waiting for it would never land.
  if (!view.value.messages.some((message) => message.id === id)) {
    const room_id = room.value?.id;
    try { await bridge.request(`/api/rooms/${room_id}/messages/${id}`); }
    catch (error) {
      if (room.value?.id === room_id) bridge.notify("warning", t('无法定位 #{value1}：{value2}',{ value1: id, value2: error.message }));
      if (!peek_origin.value) back_to_tab?.();
      return;
    }
    if (room.value?.id !== room_id) return;
  }
  if (!peek_origin.value) peek_origin.value = { tail: follow_tail.value, anchor: active_message.value, back_to_tab };
  if (view.value.query || view.value.source_filter) {
    await act("filter", { query: "", mention: false, host: false, authors: [], kinds: [] });
    await nextTick();
  }
  located_id = id;
  locating_label.value = "";
  locating.value = id;
  clearTimeout(locating_timer);
  locating_timer = setTimeout(() => { locating.value = null; locating_label.value = ""; }, LOCATE_GIVE_UP_MS);
  jump_to(id);
}
/** Folded notices and rolled-back records show one line each; their `#123` opens the full text in place. */
const opened_folded = ref(new Set());
function toggle_folded(id) {
  const next = new Set(opened_folded.value);
  if (!next.delete(id)) next.add(id);
  opened_folded.value = next;
}
/** Go back to where reading was before the peek, then to the tab it came from. */
function return_from_peek() {
  const origin = peek_origin.value;
  peek_origin.value = null;
  if (!origin) return;
  if (origin.tail || origin.anchor == null) return_to_latest();
  else jump_to(origin.anchor);
  origin.back_to_tab?.();
}
defineExpose({ locate_member, peek_message });
let located_id = null;
let awaiting_member_locate = null;
// The message a locate is still heading for, shown over the transcript until it lands; a jump that never lands stops covering it after a while.
const locating = ref(null);
const locating_label = ref("");
const LOCATE_GIVE_UP_MS = 30000;
let locating_timer = 0;
onBeforeUnmount(() => clearTimeout(locating_timer));
const LOCATE_FLASH_MS = 1600;
let located_flash_timer = 0;
/** Briefly outline the card a locate landed on; an attribute, so the card's memoized render does not reset it. */
function flash_located(card) {
  clearTimeout(located_flash_timer);
  for (const previous of transcript.value?.querySelectorAll("[data-located]") || []) previous.removeAttribute("data-located");
  void card.offsetWidth;
  card.setAttribute("data-located", "");
  located_flash_timer = setTimeout(() => card.removeAttribute("data-located"), LOCATE_FLASH_MS);
}
/** Whether the message renders as an ordinary message card, which carries its own locate button. */
function sent_summary(message) {
  const relation = message.relay_sent_relation === 'child' ? t('子房间') : message.relay_sent_relation === 'parent' ? t('父房间') : null;
  const args = { host: message.relay_sent_host, relation, title: message.relay_sent_title ?? t('已删除的房间'), id: message.relay_sent_message_id };
  // relay_sent_state follows a queued message to its delivery and to the other host's reply.
  const state = message.relay_sent_state;
  if (!relation) return unrelated_sent_summary(message, state, args);
  if (state === 'replied') return args.id ? t('主持人 {host} 向{relation}「{title}」发送了消息 #{id}（已回复）', args) : t('主持人 {host} 向{relation}「{title}」发送了消息（已回复）', args);
  if (state === 'queued') return t('主持人 {host} 向{relation}「{title}」发送了消息（排队中）', args);
  if (state === 'delivered' && !message.relay_sent_interrupted) return args.id ? t('主持人 {host} 向{relation}「{title}」发送了消息 #{id}（已送达）', args) : t('主持人 {host} 向{relation}「{title}」发送了消息（已送达）', args);
  if (message.relay_sent_queued_id && !state) return t('主持人 {host} 向{relation}「{title}」发送了消息（已排队）', args);
  if (message.relay_sent_interrupted) return args.id ? t('主持人 {host} 向{relation}「{title}」立即发送了消息 #{id}', args) : t('主持人 {host} 向{relation}「{title}」立即发送了消息', args);
  return args.id ? t('主持人 {host} 向{relation}「{title}」发送了消息 #{id}', args) : t('主持人 {host} 向{relation}「{title}」发送了消息', args);
}
/** The same line for a room that is neither parent nor child: any room of the site may be sent to, so no relation is named. */
function unrelated_sent_summary(message, state, args) {
  if (state === 'replied') return args.id ? t('主持人 {host} 向房间「{title}」发送了消息 #{id}（已回复）', args) : t('主持人 {host} 向房间「{title}」发送了消息（已回复）', args);
  if (state === 'queued' || (message.relay_sent_queued_id && !state)) return t('主持人 {host} 向房间「{title}」发送了消息（排队中）', args);
  if (state === 'delivered') return args.id ? t('主持人 {host} 向房间「{title}」发送了消息 #{id}（已送达）', args) : t('主持人 {host} 向房间「{title}」发送了消息（已送达）', args);
  return args.id ? t('主持人 {host} 向房间「{title}」发送了消息 #{id}', args) : t('主持人 {host} 向房间「{title}」发送了消息', args);
}
async function open_sent_room(message) {
  await act('room', message.relay_sent_room);
  if (view.value.room?.id === message.relay_sent_room && message.relay_sent_message_id) await locate({ id: message.relay_sent_message_id });
}
function plain_card(message) {
  return !message.arrangement && !["room_link", "room_relay_sent", "host_action", "notice"].includes(message.source) && !message.cancelled_turn && !message.cancelled_execution
    && !(message.slot_card && !message.failure) && !message.withdrawn;
}
/** The header filter: a card shows when any checked speaker or card kind matches it. */
function matches_filter(item) {
  if (view.value.card_kinds.some((kind) => CARD_KINDS[kind]?.(item))) return true;
  // A speaker filter also keeps that member's own working, failed and stopped cards.
  if (view.value.authors.includes(item.author)) return true;
  // The host view follows whoever hosted at that point; a failed card sits under the message its work began at.
  const host = host_at(item.slot_card ? item.layout_after : item.id);
  if (view.value.host_only && host && item.author === host) return true;
  if (item.slot_card) return false;
  // The host view also carries the program's notices to the host and Goal progress.
  if (view.value.host_only && (item.kind === "moderation" || ["notice", "goal", "host_action"].includes(item.source))) return true;
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
/** Notices waking the host after its own failure, by message id: the notice itself stays hidden while the failed card remains and the wake-up follows below it. */
const failure_wakes = computed(() => new Map(all_failure_wakes.value.map((wake) => [wake.message_id, wake.execution_id])));
/** Timed checks the host answered without dispatching, by notice id → answer: the answer folds into the check's line. */
const quiet_checkins = computed(() => {
  if (view.value.query || view.value.source_filter) return new Map();
  const by_id = new Map(view.value.messages.map((message) => [message.id, message]));
  return new Map(all_quiet_checkins.value
    .filter((check) => by_id.has(check.message_id) && by_id.has(check.answer_id))
    .map((check) => [check.message_id, by_id.get(check.answer_id)]));
});
const folded_checkin_answers = computed(() => new Set([...quiet_checkins.value.values()].map((answer) => answer.id)));
/** Failed free-room executions, shaped like working cards so a failure stays where its work was shown. */
const free_failures = computed(() => {
  if (view.value.query) return [];
  const names = new Map((room.value.free?.members || []).map((member) => [member.id, member.name]));
  // A host failure whose wake-up has started keeps its own card (duration, reason, process notes); the wake-up follows below.
  const followed = new Set(all_executions.value.map((execution) =>
    execution.replaces_execution_id || failure_wakes.value.get(execution.request_message_id)).filter(Boolean));
  return all_executions.value.filter((execution) => execution.status === "failed")
    .map((execution) => ({ id: `failed-${execution.id}`, author: execution.member || names.get(execution.member_id) || t('成员'), slot_card: true, created_at: execution.created_at,
      execution_id: execution.id, request_message_id: execution.request_message_id, layout_after: execution.layout_after,
      layout_at: execution.layout_at, discussion_request: execution.requests?.find((request) => request.discussion_session_id),
      marks: line_marks(execution.member || names.get(execution.member_id), execution, "", execution.layout_after),
      failure: { ...execution, followed: followed.has(execution.id), elapsed_seconds: execution.finished_at ? Math.max(0, execution.finished_at - execution.created_at) : null } }))
    .concat(undeliverable_requests());
});
/** Pending requests the local service cannot deliver, because it could not take over the member's session; the reason sits under the message. */
function undeliverable_requests() {
  const blocked = new Map((room.value.free?.members || []).filter((member) => member.adopt_error).map((member) => [member.id, member]));
  return visible_pending_requests(room.value.free?.requests, (request) => request.status === "pending" && blocked.has(request.member_id))
    .map((request) => {
      const queued_at = request.layout_at ?? request.created_at;
      return { id: `undeliverable-${request.id}`, author: blocked.get(request.member_id).name, slot_card: true, undeliverable: true,
        created_at: queued_at, request_message_id: request.message_id, layout_after: request.layout_after ?? request.message_id, layout_at: queued_at,
        failure: { role: blocked.get(request.member_id).role, result: blocked.get(request.member_id).adopt_error } };
    });
}
/** Consecutive rewound messages share one box at the first of them, which lists them when expanded; a retracted one is a line of its own. */
const rewound_runs = stable_computed(() => {
  const runs = new Map(), hidden = new Set();
  let start = null;
  for (const message of view.value.messages) {
    if (message.withdrawn !== "rewound") { start = null; continue; }
    if (start === null) { start = message.id; runs.set(start, []); }
    runs.get(start).push(message);
    if (start !== message.id) hidden.add(message.id);
  }
  return { runs, hidden };
});
/**
 * Consecutive program notices to the host share one card at the first of them (user 2026-11-25, #10413): they each only
 * say a batch came back, and the host is woken once for them anyway. Timed checks folded with their answer, notices
 * hidden behind a host failure and any other message break a run; a lone notice keeps its own card.
 */
const notice_runs = stable_computed(() => {
  const runs = new Map(), hidden = new Set();
  let start = null;
  for (const message of view.value.messages) {
    if (message.source !== "notice" || quiet_checkins.value.has(message.id) || failure_wakes.value.has(message.id)) { start = null; continue; }
    if (start === null) { start = message.id; runs.set(start, []); }
    runs.get(start).push(message);
    if (start !== message.id) hidden.add(message.id);
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
  const messages = view.value.messages.filter((message) => !rewound_runs.value.hidden.has(message.id) && !notice_runs.value.hidden.has(message.id)
    && !(message.source === "notice" && failure_wakes.value.has(message.id)) && !folded_checkin_answers.value.has(message.id));
  // Work on a taken-back message is no longer shown; a failure there is dropped too.
  const taken_back = new Set(view.value.messages.filter((message) => message.withdrawn).map((message) => message.id));
  const slots = new Map();
  const executions = new Map(all_executions.value.map((execution) => [execution.id, execution]));
  // Top-level messages in id order, filled while the messages are placed.
  const root_ids = [];
  const record = typeof debug_log === "function" ? (item, after, reason, anchor) =>
    debug_log("card-layout", { card: item.id, execution: item.execution_id, requestMessage: item.request_message_id,
      after, at: item.layout_at, anchor, reason }) : null;
  const place = (item) => {
    if (!item.execution_id && !item.cancelled_turn && !item.arrangement && !item.undeliverable && !item.queued) return false;
    const after = item.arrangement?.after_message_id ?? item.cancelled_turn?.after_message_id ?? item.layout_after;
    if (item.withdrawn || taken_back.has(item.request_message_id)) { record?.(item, after, "withdrawn"); return false; }
    if (after == null) { record?.(item, after, "no-anchor"); return false; }
    // Before the first loaded message, the card shows once that part of the history is loaded.
    const anchor = after === 0 ? 0 : root_ids.findLast((root) => root <= after);
    if (anchor === undefined) { record?.(item, after, "anchor-not-loaded"); return false; }
    slots.set(anchor, [...(slots.get(anchor) || []), item]);
    record?.(item, after, "attached", anchor);
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
      slot_card: true, cancelled_turn: turn, execution_id: turn.execution_id, marks: line_marks(turn.expert, executions.get(turn.execution_id)),
      layout_at: turn.layout_at ?? new Date(turn.created_at).getTime() / 1000 });
    const missed = new Set(all_cancelled_turns.value.map((turn) => turn.execution_id));
    for (const execution of executions.values()) {
      if (execution.status !== "cancelled" || execution.answer_id || missed.has(execution.id)) continue;
      // Work that reached the member's software keeps a card where it worked once voided; work never delivered leaves none.
      const request = execution.requests?.find((item) => item.discussion_session_id);
      if (request || execution.capabilities) place({ id: `stopped-${execution.id}`, author: execution.member,
        slot_card: true, cancelled_execution: execution, execution_id: execution.id, request_message_id: execution.request_message_id,
        layout_after: execution.layout_after, layout_at: execution.layout_at, discussion_request: request, marks: line_marks(execution.member, execution) });
    }
  }
  free_queued.value.forEach(place);
  const tail = free_working.value.map((item) => ({ ...without_progress(item), slot_card: true })).filter((item) => !place(item));
  const is_pending = (item) => Boolean(item.queued || item.undeliverable);
  const by_start = (left, right) => ((left.layout_at ?? 0) - (right.layout_at ?? 0))
    || (Number(is_pending(left)) - Number(is_pending(right)))
    || ((left.execution_id || 0) - (right.execution_id || 0));
  const ordered = [];
  layout_anchors.clear();
  // Each card remembers the message it shows under, so a filtered card can lead back to its place in the full transcript.
  const visit = (cards, anchor) => cards.sort(by_start).forEach((item) => { ordered.push(item); layout_anchors.set(item.id, anchor); });
  visit(slots.get(0) || [], 0);
  const root_set = new Set(root_ids);
  const supplements = new Map();
  for (const item of roots) {
    if (!root_set.has(item.interjection_parent_id)) continue;
    const siblings = supplements.get(item.interjection_parent_id) || [];
    siblings.push(item);
    supplements.set(item.interjection_parent_id, siblings);
  }
  for (const item of roots) {
    if (!root_set.has(item.interjection_parent_id)) ordered.push(item);
    ordered.push(...(supplements.get(item.id) || []));
    visit(slots.get(item.id) || [], item.id);
  }
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
// Earlier messages arriving above the first one (a room opened first shows its latest 40, then reads the rest, #8131)
// mount in slices like any others. A short list rendered to its top has floor 0, "from the very first"; left so, the
// whole history mounted at once when it arrived (627 cards: 2.2s and 1.4s long tasks), so the floor moves to the old top.
watch(() => transcript_messages.value.find((message) => !message.slot_card)?.id, (first, previous) => {
  if (first == null || previous == null || Number(first) >= Number(previous) || render_floor.value === null) return;
  if (Number(render_floor.value) <= Number(previous)) render_floor.value = Number(previous);
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
// A jump to a message older than any read yet waits here for the earlier messages (jump_to).
let awaiting_jump = null;
watch(() => transcript_messages.value.length, () => {
  if (awaiting_member_locate != null) {
    const name = awaiting_member_locate;
    const target = latest_member_card(name);
    if (target) {
      awaiting_member_locate = null;
      nextTick(() => locate_member(name));
    } else if (view.value.messages.length >= (room.value?.message_count || 0)) {
      awaiting_member_locate = null;
      locating.value = null;
      locating_label.value = "";
      clearTimeout(locating_timer);
      bridge.notify("info", t('{value1} 在本房间还没有发言', { value1: bridge.display_name(name) }));
    }
  }
  if (awaiting_jump == null || !transcript_messages.value.some((message) => message.id === awaiting_jump)) return;
  const id = awaiting_jump;
  nextTick(() => jump_to(id));
});
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
  debug_log?.("scroll-write", { target: top, actual: element.scrollTop, anchor: active_message.value,
    send: sent_position?.id, jump: jump_target.value, manual: moved_by_hand });
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
  // Rendering a whole long history right after the room opened held the page for seconds each time (653 cards: ~3.7s of
  // long tasks after switching back to it, user 2026-11-23). A few screens render at once; the rest follows in small
  // background slices once the room has settled, only while the page is idle, so a jump far back still lands at once.
  const background = !urgent && transcript_messages.value.length - render_start.value >= PRELOAD_IDLE_CARDS;
  const wait = background ? settle_until - performance.now() : 0;
  if (wait > 0) {
    const timer = setTimeout(() => { preload_timer = null; schedule_preload(); }, wait);
    preload_timer = { urgent, cancel: () => clearTimeout(timer) };
  } else if (background && window.requestIdleCallback) {
    const idle = requestIdleCallback(run);
    preload_timer = { urgent, cancel: () => cancelIdleCallback(idle) };
  } else if (urgent) {
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
  // the browser keeps the position, only touch scrolling holds those. A transcript held as drawn while the reader scrolls
  // (transcript_memo) holds them too: slices taken then rendered nothing and so sized themselves ever larger, and the whole
  // backlog mounted at once when the scroll settled (~1.3–2s at the top of a 650-card room). A held slice keeps its urgency,
  // so it resumes once the reader stops.
  if (glide.isAnimating() || (reader_busy() && (!SCROLL_ANCHORING || !urgent || touch_scroll)) || (reader_scrolling.value && held_memo)) return schedule_preload(urgent);
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
  // Background slices (schedule_preload) stay small, so a reader who starts scrolling waits at most one of them.
  const background = !urgent && transcript_messages.value.length - render_start.value >= PRELOAD_IDLE_CARDS;
  render_floor.value = floor_before(transcript_messages.value, render_start.value - (background ? PRELOAD_BACKGROUND_SLICE : preload_size));
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
    // The browser anchors on the first node in view; with the space above the first card in view (a locate landing on the
    // first card shown) that node sits above the new cards and stays put, so the cards slid down while the page stayed.
    if (Math.abs(element.scrollTop - written_top) >= 1) element.scrollTop = written_top;
  } else {
    written_top = element.scrollHeight - from_bottom;
    if (element.scrollTop !== written_top) element.scrollTop = written_top;
  }
  const spent = performance.now() - started;
  const budget = not_rendered(pending_jump) ? PRELOAD_JUMP_BUDGET_MS : urgent ? PRELOAD_URGENT_BUDGET_MS : PRELOAD_BUDGET_MS;
  // A slice re-renders and measures every card already shown, so its time grows with those cards, not with the slice;
  // shrinking it then only adds slices. It takes at least a share of them, so a long history fills in a few dozen slices,
  // but never more than PRELOAD_SHARE_CEILING cards: mounting is ~5ms a card, and a share of hundreds held the page ~0.6s.
  const fitted = Math.max(1, Math.min(PRELOAD_MAX_SLICE, Math.round(preload_size * budget / Math.max(spent, 1))));
  const share = Math.min(PRELOAD_SHARE_CEILING, Math.ceil((transcript_messages.value.length - render_start.value) * PRELOAD_RENDERED_SHARE));
  if (!background) preload_size = Math.max(fitted, share);
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
  for (const message of transcript_messages.value) {
    if (message.slot_card || message.arrangement || message.author === "系统" || ["goal", "room_link", "room_relay_sent", "host_action", "notice"].includes(message.source)) continue;
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
        label: t('{value1} · {value2} 的发言 #{value3}', { value1: group.label, value2: message_name(message), value3: message.id }), index: index++ })),
    ],
  }));
});
const navigation_entries = computed(() => navigation_sections.value.flatMap((section) => section.entries));
/** Work in progress is not a message yet; it gets a pulsing tick after the messages until its answer lands. */
const navigation_working = computed(() => transcript_messages.value.filter((item) => item.slot_card && item.working && !item.failure && !item.retry));

/** Scroll a work-in-progress card to the reading line. */
function jump_to_working(item) {
  const element = transcript.value;
  const card = element?.querySelector(`[id="execution-${item.id}"]`);
  debug_log?.("navigation", { input: "working-card", card: item.id, execution: item.execution_id, found: Boolean(card) });
  if (!card) return;
  close_preview();
  reader.state.following = false;
  jump_target.value = null;
  write_scroll(element, element.scrollTop + card.getBoundingClientRect().top - reading_top(element) - READING_OFFSET);
  track_scroll();
}

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
  if (!element || !element.clientHeight || glide.isAnimating() || toggle_hold?.inline) return;
  // After a resize the cards have rewrapped; until the reading position is restored this scrollTop is not the reader's.
  if (reading_position?.stale()) return;
  schedule_preload(preload_urgent(element));
  const destination = follow_destination(element);
  send_clipped.value = element.scrollHeight - element.clientHeight - destination > 1;
  const distance = destination - element.scrollTop - visual_tail_space;
  if (distance >= 0) set_visual_tail_space(0);
  const near_end = !visual_tail_space && distance < FOLLOW_TAIL_THRESHOLD;
  if (!near_end && follow_tail.value && !moved_by_hand && !reader_busy() && performance.now() < settle_until && jump_target.value == null && !pending_jump) {
    write_scroll(element, destination);
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
  // At the end the last cards never reach the reading line, so the newest message is where the reader is.
  if (near_end) {
    active_message.value = navigation_groups.value.at(-1)?.messages.at(-1)?.id ?? null;
    return;
  }
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
// The end can move while the glide runs (the scheduler's "analysing" card giving way to its decision, an image taking its
// size); a glide that stopped short of it left the page above the end and turned following off (2026-11-20 recording).
glide.on("animationComplete", () => {
  const element = transcript.value;
  const bottom = element && follow_destination(element);
  if (element && follow_tail.value && Math.abs(element.scrollTop - bottom) > 1) write_scroll(element, bottom);
  track_scroll();
});

/** Reveal saved messages without interrupting a reader of earlier records; `smooth` glides there on the send spring. */
async function follow_messages(smooth = false) {
  await nextTick();
  const element = transcript.value;
  // A reader scrolling near the end is still scrolling: the follow waits until they stop (release_reader). Only the glide
  // of their own send goes at once.
  if (follow_tail.value && element && smooth !== true && reader_busy()) { follow_pending = true; arm_settle(); }
  else if (follow_tail.value && element) {
    set_visual_tail_space(0);
    const bottom = follow_destination(element);
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
  const current = files.find((file) => !file.uploaded);
  return current ? { done, total: files.length, id: current.id, image: Boolean(current.preview_url) } : null;
});
/** The sending card's status while its files upload; an image shows its own percent on its thumbnail, other files here. */
function sending_upload_text(percent, phase) {
  const { done, total, image } = sending_uploads.value;
  if (image && total === 1) return t('发送中…');
  if (image || percent === null) return t('正在上传附件 {value1}/{value2}…', { value1: done, value2: total });
  if (phase === "compress") return t('正在压缩视频 {percent}%…', { percent });
  return total === 1 ? t('正在上传附件 {percent}%…', { percent }) : t('正在上传附件 {current}/{total} · {percent}%…', { current: done + 1, total, percent });
}
/**
 * The sending card's text, laid out as the saved card will be: images its placeholders name sit in the same grid, from
 * this browser's own copies (2026-11-26: two images showed on two lines, then side by side once saved).
 */
function sending_html(preview) {
  const files = preview.files.map((file, index) => ({ id: file.id, room_id: "", file_name: file.name, content_type: file.preview_url ? file.content_type || "image/png" : file.content_type || "application/octet-stream",
    size: file.size, number: preview.attachment_start + index, local_url: file.preview_url, ...(file.width ? { width: file.width, height: file.height } : {}) }));
  const inlined = new Set();
  const html = bridge.link_attachment_placeholders(bridge.render_room_markdown(preview.text), files, inlined);
  sending_inlined.set(preview, inlined);
  return html;
}
// The images each sending card shows in its text grid, so the list below leaves them out.
const sending_inlined = new WeakMap();
const sending_listed = (card) => card.files.filter((file) => file.preview_url && !sending_inlined.get(card)?.has(file.id));
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
watch(() => view.value.sending_preview?.id, (id) => {
  if (!id) return;
  sent_position = { id };
  // Sending is the reader's own move to the end; a scroll of theirs still settling no longer holds the transcript.
  release_reader();
  if (document.documentElement.dataset.motion === "off") send_entry.jump(1);
  else { send_entry.jump(0); send_entry.set(1); }
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
  locating.value = null;
  locating_label.value = "";
  reset_preview();
  follow_tail.value = true;
  sent_position = null;
  render_floor.value = null;
  pending_jump = preload_wanted = awaiting_jump = awaiting_member_locate = null;
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

/** Locate either a normal message card or a slot card (working, queued, failed, stopped) in the rendered transcript. */
function card_element(element, id) {
  if (!element || id == null) return null;
  if (typeof id === "string") {
    const escaped = CSS.escape(id);
    return element.querySelector(`[id="execution-${escaped}"], [id="${escaped}"]`);
  }
  return element.querySelector(`[data-message-id="${id}"]`);
}

/**
 * Jump anywhere in the history while preserving the shared composer draft; a message still being rendered is jumped to
 * once it is, and one older than any read yet (a room opened first shows its latest messages, then reads the earlier ones,
 * #8131) once the earlier messages arrive.
 */
function jump_to(id) {
  awaiting_jump = null;
  const messages = transcript_messages.value;
  const first = messages.find((message) => !message.slot_card);
  if (typeof id === "number" && first && id < Number(first.id) && !messages.some((message) => message.id === id)) {
    debug_log?.("jump", { message: id, phase: "waiting-history" });
    close_preview();
    awaiting_jump = id;
    return;
  }
  if (not_rendered(id)) {
    debug_log?.("jump", { message: id, phase: "waiting-render" });
    close_preview();
    pending_jump = id;
    schedule_preload(true);
    return;
  }
  pending_jump = null;
  const element = transcript.value;
  const message = card_element(element, id);
  if (locating.value === id) { locating.value = null; locating_label.value = ""; clearTimeout(locating_timer); }
  if (!message) { debug_log?.("jump", { message: id, phase: "missing" }); return; }
  close_preview();
  reader.state.following = false;
  // Clearing a filter turns on following the end; left on, the next re-render pulled the transcript back to the bottom.
  follow_tail.value = false;
  jump_target.value = typeof id === "number" ? id : null;
  if (typeof id === "number") active_message.value = id;
  const align = () => {
    const target_top = reading_top(element) + READING_OFFSET;
    const max_scroll = Math.max(0, element.scrollHeight - element.clientHeight);
    const next = Math.max(0, Math.min(max_scroll, element.scrollTop + message.getBoundingClientRect().top - target_top));
    if (Math.abs(next - element.scrollTop) > 1) write_scroll(element, next);
  };
  align();
  // Cards above the viewport use content-visibility: auto with estimated heights; their real heights can settle a few
  // frames after scrolling into view, so re-align briefly if the reader has not scrolled meanwhile.
  const token = ++jump_align_token;
  const realign = (remaining) => requestAnimationFrame(() => {
    if (token !== jump_align_token || !message.isConnected || reader_busy()) return;
    align();
    track_scroll();
    if (remaining > 1) realign(remaining - 1);
  });
  realign(4);
  debug_log?.("jump", { message: id, phase: "landed", actual: element.scrollTop });
  if (typeof id === "number") message.focus({ preventScroll: true });
  if (located_id === id) { located_id = null; flash_located(message); }
  track_scroll();
}
let jump_align_token = 0;

// A share page's reader starts from how the room began, not from its latest message.
let share_opened = false;
watch(() => Boolean(view.value.share && view.value.messages.length && !view.value.messages_loading), (ready) => {
  if (!ready || share_opened) return;
  share_opened = true;
  follow_tail.value = false;
  // The whole record is mounted at once: it no longer grows, so no later slice can move what the reader is looking at.
  render_floor.value = 0;
  nextTick(() => { if (transcript.value) write_scroll(transcript.value, 0); track_scroll(); });
}, { flush: "post" });

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
  const is_scroll_input = event.type !== "keydown" || ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key);
  if (is_scroll_input) {
    debug_log?.("manual", { input: event.type, send: sent_position?.id, anchor: active_message.value, actual: transcript.value?.scrollTop });
    sent_position = null;
    moved_by_hand = true;
    // The reader's own scroll ends a fold control's hold: it pulled the card back to its place on every frame, against the
    // swipe (user 2026-11-22, a scheduler card opened on the phone and scrolled down).
    if (toggle_hold && !toggle_hold.inline) toggle_hold = null;
    if (event.type !== "keydown" || !event.target.closest?.(".channel-inline-html-toggle")) {
      if (toggle_hold?.inline) toggle_hold = null;
      set_visual_tail_space(0);
    }
  }
  glide.stop();
  touch_scroll = touch_active = event.type === "touchstart";
  if (touch_active) { touch_at = performance.now(); touch_scrolled = false; }
  // Scrolling by hand drops a jump still waiting for its card.
  pending_jump = awaiting_jump = awaiting_member_locate = null;
  jump_align_token += 1;
  if (is_scroll_input) jump_target.value = null;
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
  debug_log?.("navigation", { input: "scrub", message: target?.message.id, cancelled: !target });
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
  debug_log?.("navigation", { input: event.detail === 0 ? "keyboard" : "click", message: item.message.id });
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
  peek_origin.value = null;
  sent_position = null;
  send_clipped.value = false;
  close_preview();
  if (toggle_hold?.inline) toggle_hold = null;
  reader.state.following = false;
  jump_target.value = null;
  follow_tail.value = true;
  pending_jump = awaiting_jump = null;
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

watch(preview_open, (open) => {
  if (document.documentElement.dataset.motion === "off") preview_visibility.jump(open ? 1 : 0);
  else preview_visibility.set(open ? 1 : 0);
});
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
  // The question card floats: the dock stays see-through down to the card's lower edge and turns solid only below it.
  const card = entry.target.querySelector(".question-card");
  const float = card ? Math.ceil(card.getBoundingClientRect().bottom - entry.target.getBoundingClientRect().top) : 0;
  entry.target.style.setProperty("--channel-float-height", `${float}px`);
  const height = Math.ceil(entry.target.offsetHeight / COMPOSER_ROOM_STEP) * COMPOSER_ROOM_STEP;
  if (height === composer_height) return;
  composer_height = height;
  entry.target.parentElement?.style.setProperty("--channel-composer-height", `${height}px`);
  if (!follow_tail.value || !transcript.value) return;
  if (reader_busy()) { follow_pending = true; arm_settle(); }
  else write_scroll(transcript.value, follow_destination(transcript.value));
});
onMounted(() => composer_dock.value && dock_observer.observe(composer_dock.value));
/** On a phone the comment sheet is at least as tall as the composer, so it covers it whole (two input boxes never show at once). */
function docked_sheet_style() {
  const dock = composer_dock.value;
  if (!dock) return {};
  const float = parseFloat(dock.style.getPropertyValue("--channel-float-height")) || 0;
  return { minHeight: `${dock.offsetHeight - float}px` };
}
// Cards that fill in after the messages (run reports, scheduler cards, process notes, a card measured once it nears the
// screen) make the transcript taller without changing the messages, so a room just opened ended short of its end
// (2026-11-16: 70–357px measured on first opening a room). While following the end, any growth of a message group
// lands there again. Reading earlier cards where the browser does not keep the position (WebKit), growth above the
// reading line (an image taking its size, a report filling in) is offset by hand (keep_reading). Neither moves the page
// while the reader scrolls: a snap to the end during a swipe's momentum fought the reader and jumped the page
// (2026-11-17 recording); both run once they stop (release_reader). A send glide keeps its course, retargeted to the
// end as it moves, so it lands at the end rather than where the end was when it set out.
const growth_observer = new ResizeObserver(() => {
  const element = transcript.value;
  if (!element || toggle_hold) return;
  if (glide.isAnimating()) { if (follow_tail.value) glide.set(follow_destination(element)); return; }
  if (!follow_tail.value) { keep_reading(); return; }
  if (reader_busy()) { follow_pending = true; arm_settle(); return; }
  const bottom = follow_destination(element);
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
// `?scrolldebug` captures the browser decisions that do not appear in the room's server events.
onMounted(() => {
  let enabled = false;
  try { enabled = sessionStorage.getItem("scrolldebug") === "1"; } catch { /* Storage may be unavailable. */ }
  if (!enabled || !transcript.value) return;
  const element = transcript.value, lines = [], previous = new Map();
  const panel = Object.assign(document.createElement("aside"), { id: "scrolldebug" });
  const output = document.createElement("pre");
  const copy = Object.assign(document.createElement("button"), { type: "button", textContent: t('复制浏览器调试记录') });
  panel.className = "channel-debug";
  panel.append(copy, output);
  copy.addEventListener("click", () => act("copy", lines.join("\n")));
  let frame = 0;
  debug_log = (event, data) => {
    const detail = JSON.stringify(data);
    const key = debug_repeat_key(event, data);
    const signature = event === "follow" ? `${data.message}:${data.reason}` : detail;
    if (key && previous.get(key) === signature) return;
    if (key) {
      previous.delete(key);
      previous.set(key, signature);
      if (previous.size > DEBUG_LINE_LIMIT) previous.delete(previous.keys().next().value);
    }
    lines.push(`${performance.now().toFixed(0)}ms ${data.room ?? room.value.id} ${event} ${detail}`);
    if (lines.length > DEBUG_LINE_LIMIT) lines.shift();
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; output.textContent = lines.join("\n"); });
  };
  document.body.append(panel);
  const stop = observe_debug(element);
  const stop_room = watch(() => room.value.id, () => { previous.clear(); debug_log("viewport", debug_viewport(element)); });
  const stop_annotations = watch(() => file_preview.excerpts.map(excerpt => excerpt.id), (next, prior) => {
    const added = next.filter(id => !prior.includes(id)), removed = prior.filter(id => !next.includes(id));
    if (added.length || removed.length) debug_log("annotation-draft", { added, removed });
  });
  cleanup_debug = () => { stop_room(); stop_annotations(); stop(); cancelAnimationFrame(frame); panel.remove(); debug_log = null; };
});
const DEBUG_LINE_LIMIT = 240;
let cleanup_debug = null;
onBeforeUnmount(() => cleanup_debug?.());

/** Suppress repeated layout decisions while the reader follows a changing transcript. */
function debug_repeat_key(event, data) {
  if (event === "follow") return `follow:${data.send}`;
  if (event === "card-layout") return `layout:${data.card}`;
  if (event === "card-hidden") return `hidden:${data.request ?? data.card}`;
  return null;
}

/** Report browser viewport geometry in CSS pixels, including visual viewport scaling on touch devices. */
function debug_viewport(element) {
  const viewport = window.visualViewport;
  return { width: window.innerWidth, height: window.innerHeight, visualWidth: viewport?.width, visualHeight: viewport?.height,
    visualScale: viewport?.scale, devicePixelRatio: window.devicePixelRatio, transcriptHeight: element.clientHeight,
    contentHeight: element.scrollHeight };
}

/** Observe writes, native scroll, annotation input and diagnostic events while the panel is open. */
function observe_debug(element) {
  const listeners = new AbortController();
  const { signal } = listeners;
  const viewport = () => debug_log("viewport", debug_viewport(element));
  const native = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
  let last = element.scrollTop, written = null;
  Object.defineProperty(element, "scrollTop", { configurable: true, get() { return native.get.call(this); }, set(target) {
    const before = native.get.call(this);
    native.set.call(this, target);
    const actual = native.get.call(this);
    if (Math.abs(actual - before) >= 0.5) {
      written = actual;
      debug_log("scroll-set", { before, target, actual, anchor: active_message.value, manual: moved_by_hand });
    }
  } });
  element.addEventListener("scroll", () => {
    const actual = element.scrollTop;
    if (Math.abs(actual - last) >= 0.5 && actual !== written) debug_log("browser-scroll", { before: last, actual, manual: moved_by_hand });
    last = actual;
    written = null;
  }, { passive: true, signal });
  for (const type of ["focusin", "keydown", "compositionstart", "compositionend", "submit", "input"]) {
    document.addEventListener(type, record_annotation, { capture: true, signal });
  }
  document.addEventListener("discuss:browser-debug", ({ detail }) => debug_log(detail.event, detail.data), { signal });
  window.addEventListener("resize", viewport, { signal });
  window.visualViewport?.addEventListener("resize", viewport, { signal });
  const resize = new ResizeObserver(viewport);
  resize.observe(element);
  viewport();
  return () => { listeners.abort(); resize.disconnect(); delete element.scrollTop; };
}

/** Record annotation actions and IME state without capturing a key, selection, or comment. */
function record_annotation(event) {
  const form = event.target.closest?.("form.selection-comment");
  if (!form || (event.type === "keydown" && !["Enter", "Escape"].includes(event.key))) return;
  const { width, height } = form.getBoundingClientRect();
  debug_log("annotation", { phase: event.type, action: event.type === "keydown" ? event.key : undefined,
    composing: event.isComposing, source: form.classList.contains("file-comment") ? "file" : "message",
    entry: form.classList.contains("is-inline") ? "list" : form.classList.contains("excerpt-edit") ? "mark" : "selection",
    docked: form.classList.contains("is-docked"), width, height });
}
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
/** Copy a seat's invitation link; the copied feedback shares the launch instruction's slot, keyed by the member's name. */
async function copy_seat_link(member) {
  const room_id = room.value.id;
  reset_launch_copy();
  if (!await copy_seat(bridge, room_id, member.id) || room.value?.id !== room_id) return;
  launch_copied.value = member.name;
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
  return Boolean(view.value.access?.can_manage && !report.followed && report.requests?.length && !report.requests.some((request) => request.discussion_session_id));
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
    ...(narrow.value && !view.value.share && message.kind !== "receipt" && editing.value.id !== message.id ? [reader.state.message_id === message.id
      ? { label: t('停止朗读'), icon: "i-lucide-square", onSelect: () => reader.stop() }
      : { label: t('朗读'), icon: "i-lucide-volume-2", onSelect: () => reader.start(message.id) }] : []),
    // A share page has no address for one message.
    ...(view.value.share ? [] : [{ label: t('复制原文链接'), icon: "i-lucide-link", onSelect: () => copy_message(message) }]),
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
const can_take_back = (message) => can_branch(message) && !message.relay_room && message.author === "用户" && !room.value.archived;
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
  const expanded = expanded_answers.value.has(message.id);
  const preview = answer_preview(message);
  const body_html = expanded ? message.rendered_text : preview?.html ?? message.rendered_text;
  const visuals = expanded || !preview?.truncated ? message.visual_blocks : null;
  // Images drawn in the text belong to it: left out of the list below, even when a folded preview has cut them off.
  const inline_ids = message.inline_images || [];
  const card = {
    message, identity_version: view.value.admin?.identity_version, narrow: narrow.value, reading: reader.state.message_id === message.id,
    attachments: inline_ids.length ? message.attachments.filter((file) => !inline_ids.includes(file.id)) : message.attachments, body_html, visuals,
    can_branch: can_branch(message), can_take_back: can_take_back(message), can_retract: can_retract(message), retracting: retracting_id.value === message.id, private_chat: has_private_chat(message),
    editing: edited, editing_plan: edited && editing.value.plan, editing_error: edited && editing.value.error, editing_pending: edited && is_running("rewind_and_send"),
    round_label: message_round_labels.value.get(message.id), expanded, preview,
    marks: excerpt_marks.value.get(message.id) || NO_ITEMS, waits, speaking_expert: waits ? speaking_turn.value?.expert : null,
    badges: request_badges.value.get(message.id) || NO_ITEMS, elapsed: message_elapsed(message), model: execution?.model || "", effort: execution?.effort || "",
    recommendation: recommendations.value.get(message.id), adopting: adopting.value === message.id,
    execution_id: execution?.id, execution_started_at: execution?.created_at, notes_count: execution?.notes, steps: execution?.steps,
    reports: reports || NO_ITEMS, allowing: reports ? allowing.value : 0, allow_errors: reports ? allow_errors.value : null,
    launch_available: reports ? view.value.launch?.available : null, report_messages: reports ? view.value.messages : null,
    armed: armed_cards.has(message.id), menu_open: menu_open_id.value === message.id, locate: view_source_filter.value,
  };
  // Set after the dependencies are read: a fresh object each time would re-render every card; its text and edge stand in for it.
  // A follow-up's answer says so even once its execution has left the recent list.
  const line = line_marks(message.author, execution || (message.followup_of || message.scheduled ? { followup_of: message.followup_of, scheduled: message.scheduled } : null), message.kind, message.id);
  line.badges.push(...dispatch_badges(message.id));
  card.deps = [...Object.values(card), ...line.badges.map((badge) => badge.label), line.edge];
  card.line = line;
  card.actions = message_actions(message);
  card.report_rows = card.reports.map((report) => ({
    report,
    completed: report.status === "completed",
    allowable: report.status !== "completed" && Boolean(denial_allowance(report)),
    failed: Boolean(failed_request_message(report)),
  }));
  return card;
}
/**
 * Each message's card, kept until something it read changes: a computed tracks exactly what message_card reads. The
 * transcript re-renders every shown card whenever earlier cards are mounted above (preload_slice); rebuilding all ~600
 * cards there cost ~300ms a slice, while a kept card keeps its `deps`, so its MemoBlock is skipped outright.
 */
const card_cache = new Map();
watch(() => room.value?.id, () => card_cache.clear());
function cached_card(message) {
  let entry = card_cache.get(message.id);
  if (entry?.message !== message) {
    entry = { message, card: computed(() => message_card(message)) };
    card_cache.set(message.id, entry);
  }
  return entry.card.value;
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
  if (!plan || !edited.trim() || is_running("rewind_and_send")) return;
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
  const inline_toggle = control.classList.contains("channel-inline-html-toggle");
  const anchor = inline_toggle ? control.closest(".channel-message-visual") || control : card;
  const top = anchor.getBoundingClientRect().top;
  follow_tail.value = false;
  if (inline_toggle) {
    glide.stop();
    release_reader();
    // Reserve the missing range before removing the frame. Otherwise the browser can clamp scrollTop in that layout.
    const panel_id = control.getAttribute("aria-controls");
    const panel = panel_id && document.getElementById(panel_id);
    if (panel) {
      const removed_height = panel.offsetHeight + parseFloat(getComputedStyle(panel).marginTop);
      const remaining = element.scrollHeight - element.clientHeight - element.scrollTop;
      const missing_space = Math.ceil(removed_height - remaining);
      if (missing_space > 0) set_visual_tail_space(visual_tail_space + missing_space);
    }
  }
  const until = performance.now() + TOGGLE_HOLD_MS;
  const hold = toggle_hold = { card, inline: inline_toggle };
  const step = () => {
    if (toggle_hold !== hold) return;
    if (!anchor.isConnected) { toggle_hold = null; return; }
    const drift = anchor.getBoundingClientRect().top - top;
    if (Math.abs(drift) >= 0.5) {
      const desired = element.scrollTop + drift;
      if (inline_toggle) {
        const missing_space = Math.ceil(desired - (element.scrollHeight - element.clientHeight));
        if (missing_space > 0) set_visual_tail_space(visual_tail_space + missing_space);
      }
      write_scroll(element, desired);
    }
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
  if (!has_draft.value) return;
  mention_context.value = null;
  const draft = text.value;
  const extra = [file_refs_line(), excerpts_markdown(excerpts.value)].filter(Boolean).join("\n\n");
  if (extra) text.value = draft.trim() ? `${draft.trimEnd()}\n\n${extra}` : extra;
  const sent_text = text.value;
  // The cards leave the composer with the text at once, as the message goes out; a failed send brings them back.
  const sent_refs = file_refs.value, sent_excerpts = file_preview.excerpts;
  if (extra) { file_refs.value = []; file_preview.excerpts = []; }
  const queued_before = view.value.queueing_previews.length;
  const sending = act("send");
  const accepted = text.value !== sent_text;
  if (accepted && view.value.queueing_previews.length === queued_before) {
    follow_tail.value = true;
    follow_messages(true);
  }
  const sent = await sending;
  // Nothing was sent (another action was still running): the cards return and the text loses what they added. A send
  // that failed keeps everything in its failed card instead.
  if (extra && !accepted && !sent && text.value === sent_text) {
    text.value = draft;
    file_refs.value = [...sent_refs, ...file_refs.value];
    file_preview.excerpts = [...sent_excerpts, ...file_preview.excerpts];
  }
}

let last_escape = 0;
/**
 * Two Esc presses within a moment take back the latest own message, like its card's 撤回, and fill the text back in.
 * Only from an empty composer (or the page while the composer is locked for sending), so a draft is never at stake;
 * the site refuses once a member started on the message, and says so.
 */
function retract_shortcut(event) {
  if (view.value.share) return;
  if (event.key !== "Escape" || event.isComposing || event.defaultPrevented) return;
  const from_composer = event.target === prompt.value?.textareaRef || event.target === document.body;
  if (!from_composer || has_draft.value) { last_escape = 0; return; }
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

/** Handle files chosen from the composer's own file input, anchored on the button so iOS Safari places its menu there. */
function pick_attachments(event) {
  const input = event.target;
  if (input?.files?.length) bridge.add_attachments(input.files, prompt.value?.textareaRef);
  if (input) input.value = "";
}

/** Copy a durable reference to the original record. */
function copy_message(message) { act("copy", `${view.value.room_site}/r/${room.value.id}/messages/${message.id}`); }

</script>

<template>
  <!-- One root element: the workspace hides this tab with v-show, which a fragment root would ignore. -->
  <section ref="conversation" class="channel-conversation" :class="{ 'is-filtered': view.query || view.source_filter }" role="tabpanel" :aria-label="t('消息')">
    <div v-if="room_drop" class="channel-room-drop" aria-hidden="true"><span><UIcon name="i-lucide-hash" />{{ t('松开以引用房间「{title}」', { title: room_drop.title }) }}</span></div>
  <ExternalMemberDialog v-model:open="pending_seat_open" :member="pending_seat" />
    <div v-if="view.query || view.source_filter" class="channel-filter-summary"><span>{{ [view.query && `“${view.query}”`, [view.host_only && t('主持人'), ...view.authors.map((name) => bridge.display_name(name)), view.mention_only && `@${bridge.display_name('用户')}`, view.card_kinds.length && t('{value1} 类卡片', { value1: view.card_kinds.length })].filter(Boolean).join('、')].filter(Boolean).join(' · ') }} · {{ view.messages_loading ? t('正在筛选…') : t('{value1} 条结果', { value1: view.source_filter ? transcript_messages.length : view.total }) }}</span><UButton :label="t('清除筛选')" size="xs" variant="link" color="neutral" @click="search = ''; act('filter', { query: '', mention: false, host: false, authors: [], kinds: [] })" /></div>
    <nav v-if="navigation_sections.length || navigation_working.length" ref="message_map" class="channel-message-map" :style="{ '--nav-entry-height': `${NAV_ENTRY_HEIGHT}px` }" :aria-label="t('发言快速导航')" @wheel.stop.passive="browse_navigation" @pointerleave="close_preview" @focusout="close_preview" @keydown.esc.stop="close_preview" @contextmenu="navigation_context_menu" @pointerdown="start_scrub" @pointermove="move_scrub" @pointerup="end_scrub" @pointercancel="end_scrub">
      <div class="channel-map-track">
        <div v-for="section in navigation_sections" :key="section.entries[0].key"v-memo="[section, preview_open, active_round === section.number ? active_message : null, section_preview_position(section), section === navigation_sections.at(-1) ? navigation_working : null]" class="channel-map-round" :style="{ '--round-message-count': section.count + (section === navigation_sections.at(-1) ? navigation_working.length : 0) }">
          <!-- A free room is one long section, so each tick keeps its own memo: moving the reading position or the hover redraws only the ticks it reaches. -->
          <button v-for="item in section.entries" :key="item.key" v-memo="[item.message, item.label, item.index, active_message === item.message.id, item.message.id === (active_message || view.messages[0]?.id), preview_index < 0 ? -1 : Math.min(Math.abs(item.index - preview_index), NAV_HOVER_REACH), preview_open && preview_entry === item.key]" type="button" class="channel-navigation-entry" :class="item.round ? 'channel-round-range' : 'channel-message-jump'" :data-author="item.round ? undefined : item.message.relay_room ? 'relay' : bridge.identities[item.message.author]?.style" :data-jump-id="item.round ? undefined : item.message.id" :data-round-jump="item.round ? item.label : undefined" :aria-label="item.label" :tabindex="!item.round && item.message.id === (active_message || view.messages[0]?.id) ? 0 : -1" :aria-current="!item.round && active_message === item.message.id ? 'location' : undefined" :aria-describedby="preview_open && preview_entry === item.key ? 'channel-navigation-preview' : undefined" @pointerenter="hover_preview(item, $event)" @pointermove="hover_preview(item, $event)" @focus="focus_preview(item, $event)" @keydown="navigate_by_key($event, item.index)" @click="activate_navigation(item, $event)">
            <span v-if="item.round" class="channel-round-number" aria-hidden="true">{{ item.number || '' }}</span>
            <span v-else class="channel-jump-tick" aria-hidden="true" :style="tick_state(item, item.index)"></span>
          </button>
          <button v-for="item in section === navigation_sections.at(-1) ? navigation_working : []" :key="`working-${item.id}`" type="button" tabindex="-1" class="channel-navigation-entry channel-message-jump channel-working-jump" :data-author="bridge.identities[item.author]?.style" :aria-label="t('{value1} 正在处理', { value1: bridge.display_name(item.author) })" :title="t('{value1} 正在处理', { value1: bridge.display_name(item.author) })" @click="jump_to_working(item)">
            <span class="channel-jump-tick" aria-hidden="true"></span>
          </button>
        </div>
      </div>
    </nav>
    <Teleport to="body">
      <motion.div v-if="preview" id="channel-navigation-preview" class="channel-nav-preview" role="tooltip" :aria-hidden="!preview_open" :inert="!preview_open" :data-open="preview_open" :style="{ left: preview_left, y: preview_y, x: preview_x, opacity: preview_opacity, scale: preview_scale, height: preview_height, '--preview-gap': `${PREVIEW_GAP}px` }" @pointerleave="close_preview" @focusout="close_preview" @keydown.esc.stop="close_preview">
        <div ref="preview_content" class="channel-nav-preview-content">
          <h3 v-if="preview_is_round" class="channel-nav-preview-round">{{ preview_round }}</h3>
          <div class="channel-nav-preview-header">
            <UAvatar :src="message_identity(preview)?.icon" :icon="preview.relay_room && !message_identity(preview)?.icon ? 'i-lucide-link' : undefined" :text="message_identity(preview)?.initials || '?'" :alt="message_name(preview)" size="sm" class="channel-avatar" :class="message_identity(preview)?.style" />
            <strong>{{ message_name(preview) }}<template v-if="preview.relay_room"> · {{ relay_label(preview) }}</template></strong><span>#{{ preview.id }}</span>
          </div>
          <div class="channel-nav-preview-meta">{{ preview_round }} · <template v-if="!preview.relay_room">{{ bridge.sources[preview.source] }} · </template> {{ bridge.format_time(preview.created_at) }}<span v-if="preview.kind === 'moderation'"> {{ t('· 主持人') }}</span><span v-else-if="preview.kind === 'receipt'"> {{ t('· 运行回执') }}</span></div>
          <div class="channel-nav-preview-text markdown-body" v-html="preview.summary ? preview.rendered_summary : preview.rendered_text"></div>
        </div>
      </motion.div>
    </Teleport>
    <div v-if="listen_here && !listen_here.touch" class="channel-offer-marks" :style="{ left: `${listen_here.left}px`, top: `${listen_here.top}px` }">
      <button type="button" class="channel-listen-mark" :title="t('把选中的文字作为注释添加到对话')" @mousedown.prevent @click="start_quote"><UIcon name="i-lucide-message-square-quote" />{{ t('添加到对话') }}</button>
      <button v-if="listen_here.speech" type="button" class="channel-listen-mark" :title="t('从选中处开始朗读')" :aria-label="t('从选中处开始朗读')" @mousedown.prevent @click="listen_from_selection"><UIcon name="i-lucide-headphones" />{{ t('听当前') }}</button>
    </div>
    <form v-if="quoting" v-float-box class="selection-comment" :class="{ 'is-docked': quoting.touch }" :style="quoting.touch ? docked_sheet_style() : { left: `${quoting.left}px`, top: `${quoting.top}px` }" @submit.prevent="submit_quote">
      <textarea ref="quote_input" v-model="quote_comment" rows="1" :placeholder="t('添加批注（可选）')" :aria-label="t('注释的批注（可选）')" enterkeyhint="send" @keydown="quote_keydown"></textarea>
      <div class="selection-comment-actions">
        <button type="button" class="selection-comment-cancel" :aria-label="t('取消添加')" :title="t('取消')" @click="cancel_quote"><UIcon name="i-lucide-x" /></button>
        <button type="submit" class="selection-comment-send channel-primary-button channel-round-button channel-send" :aria-label="t('添加到对话')" :title="t('添加到对话（Enter）')"><UIcon name="i-lucide-arrow-up" /></button>
      </div>
    </form>
    <ExcerptEditCard v-if="mark_editing" :key="mark_editing.excerpt.id" :class="{ 'is-docked': mark_editing.touch }" :comment="mark_editing.excerpt.comment" :removable="!mark_editing.touch" :context="mark_editing.touch ? mark_context(mark_editing.excerpt) : ''" :style="mark_editing.touch ? docked_sheet_style() : { left: `${mark_editing.left}px`, top: `${mark_editing.top}px` }" @save="save_mark" @cancel="close_mark" @remove="remove_mark" />
    <!-- A locate far back waits for the earlier cards to render; the end of the room stays covered meanwhile so it is not taken for the result. -->
    <div v-if="locating !== null" class="channel-locating" role="status"><UIcon name="i-lucide-loader" class="animate-spin" />{{ locating_label || t('正在定位到 #{value1}…', { value1: locating }) }}</div>
    <div ref="transcript" v-memo="transcript_memo([fold_area, expanded_rewinds.size, opened_folded, notice_runs, message_groups,view.messages_loading, view.messages_failure, sending_previews, failed_sends, message_round_labels, free, room.session, can_manage, expanded_answers.size, reader.state.message_id, room.title, view.query, view.source_filter, view.authors, view.card_kinds, topic_anchor, end_anchor, request_badges, execution_reports, recommendations, adopting, scheduler_decisions, host_arrangements, is_running('rewind_and_send'), is_running('skip_turn'), is_running('pause_discussion'), is_running('retry_delivery'), open_working_notes, editing, rewound_runs, retracting_id, armed_cards.size, menu_open_id, stopping_member, allowing, allow_errors, late_answers, has_draft, view.sending_message, routing_messages, speaking_turn, free_shape, excerpt_marks])" class="channel-transcript" :aria-label="t('聊天记录')" @click.capture="keep_toggle_place" @click="open_message_ref" @scroll="schedule_track_scroll" @wheel.passive="resume_tracking($event); stop_following($event)" @touchstart.passive="resume_tracking" @touchmove.passive="stop_following" @touchend.passive="end_touch" @touchcancel.passive="end_touch" @pointerdown="stop_following" @keydown="resume_tracking($event); stop_following($event)">
      <div v-if="!view_query && !view_source_filter && !topic_anchor && render_start === 0" class="channel-message-group channel-topic-group"><TopicCard :ref="(card) => topic_card = card" @edit="emit('edit')" /></div>
      <div v-for="group in message_groups" :key="group.key" class="channel-message-group">
        <USeparator :label="group.label" class="channel-date-divider" />
        <template v-for="message in group.messages" :key="(message.queued || message.working) && (message.work_message_id || message.request_message_id) ? `work-${message.work_message_id || message.request_message_id}-${message.member_id}` : message.id">
        <DiscussionEndCard v-if="message.id === end_anchor && !view_query && !view_source_filter" />
        <TopicCard v-if="message.id === topic_anchor && !view_query && !view_source_filter" :ref="(card) => topic_card = card" @edit="emit('edit')" />
        <!-- A free-room working card holds the slot its answer will take. -->
        <ScheduleCard v-if="message.arrangement" icon="i-lucide-list-ordered" plain :title="t('主持人创建的发言安排')" :label="t('主持人安排')" :toggle-label="t('展开或收起各专家的任务')">
          <template #text>{{ t('主持人安排：{value1}', { value1: host_arrangements.get(message.arrangement.after_message_id)?.find((plan) => plan.id === message.arrangement.id)?.label }) }}<small v-if="message.arrangement.after_message_id">{{ t('耗时 {value1}', { value1: format_elapsed(arrangement_seconds(message.arrangement, view.messages.find((item) => item.id === message.arrangement.after_message_id))) }) }}</small></template>
          <p v-for="turn in message.arrangement.turns" :key="`${message.id}-${turn.expert}-${turn.question}`"><span>{{ bridge.display_name(turn.expert) }}：{{ turn.question }}</span></p>
        </ScheduleCard>
        <GoalNoticeCard v-else-if="message.source === 'goal'" :message="message" />
        <ScheduleCard v-else-if="message.source === 'room_relay_sent'" class="channel-relay-sent" icon="i-lucide-send" plain toggle-line :label="t('跨房发送')" :toggle-label="t('展开或收起发出的消息正文')">
          <template #text><bdi dir="auto" :title="sent_summary(message)">{{ sent_summary(message) }}</bdi></template>
          <template #actions><small v-if="!message.relay_sent_title">{{ t('该房间已删除') }}</small><UButton v-else-if="!view.share" size="xs" variant="link" :label="t('打开房间')" @click.stop="open_sent_room(message)" /></template>
          <div class="markdown-body" v-html="message.rendered_text"></div>
        </ScheduleCard>
        <!-- Unlinking removes the link, so its cards (and the 已解除 card itself) have no room to open. -->
        <ScheduleCard v-else-if="message.source === 'room_link'" class="channel-room-link" icon="i-lucide-link" plain :expandable="false" :label="t('关联房间')">
          <template #text>{{ message.text }}</template>
          <template #actions><template v-if="message.link_room"><UButton v-if="message.link_title !== null" size="xs" variant="link" :label="t('打开房间')" @click="act('room', message.link_room)" /><small v-else>{{ t('该房间已删除') }}</small></template></template>
        </ScheduleCard>
        <ScheduleCard v-else-if="message.source === 'host_action'" class="channel-host-action" icon="i-lucide-crown" plain fold :label="t('主持人操作')">
          <template #text>{{ message.text }}</template>
          <p>{{ message.text }}</p>
        </ScheduleCard>
        <ScheduleCard v-else-if="message.source === 'notice' && quiet_checkins.has(message.id)" icon="i-lucide-bell" plain :label="t('定时检查')" :toggle-label="t('展开或收起主持人的检查回复')">
          <template #text><span class="channel-checkin-line">{{ t('定时检查 · {value1}：{value2}', { value1: bridge.display_name(quiet_checkins.get(message.id).author), value2: quiet_checkins.get(message.id).text.replace(/^定时检查[：:]\s*/, '') }) }}</span></template>
          <p>{{ message.text }}</p>
          <p class="channel-checkin-answer">{{ quiet_checkins.get(message.id).text }}</p>
        </ScheduleCard>
        <ScheduleCard v-else-if="message.source === 'notice' && notice_runs.runs.get(message.id)?.length > 1" icon="i-lucide-bell" plain :label="t('程序通知主持人')" :toggle-label="t('展开或收起各条程序通知')">
          <template #text><span class="channel-checkin-line">{{ t('{value1} 条程序通知：{value2}', { value1: notice_runs.runs.get(message.id).length, value2: notice_runs.runs.get(message.id).map((item) => item.text).join('；') }) }}</span></template>
          <ul class="channel-withdrawn-list">
            <li v-for="item in notice_runs.runs.get(message.id)" :key="item.id" :data-message-id="item.id">
              <span class="channel-withdrawn-text" :title="item.text">{{ item.text }}</span>
              <UButton :label="`#${item.id}`" size="xs" variant="link" color="neutral" :aria-label="t('查看程序通知原文 #{value1}', { value1: item.id })" :aria-expanded="opened_folded.has(item.id)" @click="toggle_folded(item.id)" />
              <div v-if="opened_folded.has(item.id)" class="markdown-body channel-withdrawn-full" v-html="bridge.render_room_markdown(item.text)"></div>
            </li>
          </ul>
        </ScheduleCard>
        <ScheduleCard v-else-if="message.source === 'notice'" icon="i-lucide-bell" plain fold :label="t('程序通知主持人')">
          <template #text>{{ message.text }}</template>
          <p class="channel-checkin-answer">{{ message.text }}</p>
        </ScheduleCard>
        <!-- Stopped, voided or skipped work keeps the member's ordinary message card (avatar, name, time), with a stop badge
             in the name row and the reason as its text, so it reads as that member's turn that was cut short (user
             2026-11-18, replacing the 11-17 one-line event card). -->
        <UChatMessage v-else-if="message.cancelled_turn || message.cancelled_execution" :id="message.id" :data-author="bridge.identities[message.author]?.style" role="assistant" :parts="[]" side="left" variant="naked" color="neutral" class="channel-message is-voided" :class="message.marks?.edge" :ui="{ header: 'channel-message-header', container: 'channel-message-container', body: 'channel-message-body' }">
          <template #body><template v-for="run in [voided_execution(message)]" :key="message.id">
            <div class="channel-message-byline">
              <UAvatar :src="bridge.identities[message.author]?.icon" :text="bridge.identities[message.author]?.initials || '?'" :alt="bridge.display_name(message.author)" size="md" class="channel-avatar" :class="bridge.identities[message.author]?.style" />
              <div class="channel-message-meta">
                <div class="channel-message-author"><strong>{{ bridge.display_name(message.author) }}</strong><UBadge v-for="badge in message.marks?.badges || []" :key="badge.key" size="xs" color="neutral" variant="soft" class="channel-source channel-line-badge" :title="badge.title">{{ badge.label }}</UBadge></div>
                <span v-if="run?.model || run?.effort" class="channel-message-provenance channel-message-model" :title="[run.model, run.effort].filter(Boolean).join(' · ')"><bdi v-if="run.model" class="channel-model-id">{{ run.model }}</bdi><span v-if="run.effort" class="channel-model-effort">{{ run.model ? ` · ${run.effort}` : run.effort }}</span></span>
              </div>
              <!-- How this one went, at the right (user 2026-11-21, #6823): state, time, one number (the execution when it
                   started, else the arrangement it was never delivered for), duration. -->
              <div class="channel-message-provenance channel-message-facts"><UBadge size="xs" color="warning" variant="soft" class="channel-source" :icon="message.cancelled_turn ? 'i-lucide-skip-forward' : 'i-lucide-circle-stop'">{{ message.cancelled_turn ? t('已跳过') : stop_state(message.cancelled_execution).label }}</UBadge><time v-if="run" :title="new Date(run.created_at * 1000).toLocaleString(locale)">{{ bridge.format_time(run.created_at * 1000) }}</time><span v-if="run">{{ t('执行 #{value1}', { value1: run.id }) }}</span><span v-else-if="message.cancelled_turn">{{ t('安排 #{value1}', { value1: message.cancelled_turn.display_id || message.cancelled_turn.id }) }}</span><span v-if="run && execution_seconds(run) !== null" class="channel-message-elapsed">{{ t('耗时 {value1}', { value1: format_elapsed(execution_seconds(run)) }) }}</span></div>
            </div>
            <div class="channel-message-text channel-stop-reason" role="status"><span>{{ message.cancelled_turn ? t('本次发言已被跳过或取消，未回答。') : stop_reason_text(message.cancelled_execution.result) || t('本次执行已作废，未回答。') }}</span></div>
            <template v-if="run && stop_state(run).note">
              <p class="channel-message-text channel-stop-note">{{ stop_state(run).note }}</p>
              <details v-if="run.late_answer && can_manage" class="channel-receipt" @toggle="load_late_answer(run.id, $event)">
                <summary :aria-label="t('查看 {value1} 未采纳的回答', { value1: bridge.display_name(run.member) })">{{ t('未采纳的回答') }}</summary>
                <div class="channel-message-text channel-late-answer">{{ late_answers.get(run.id)?.text ?? t('正在读取…') }}</div>
              </details>
            </template>
            <LiveClock v-if="run?.notes || run?.steps" v-slot="{ note_map }"><ExecutionNotes :count="run.notes || 0" :steps="run.steps || 0" :notes="note_map.get(run.id)" :load="() => load_notes(run.id)" :preload="(near) => preload_notes(run.id, near)" /></LiveClock>
          </template></template>
        </UChatMessage>
        <LiveClock v-else-if="message.slot_card && message.queued && message.compact_queue" v-slot="{ now }">
          <ScheduleCard :id="`execution-${message.id}`" icon="i-lucide-clock" plain :expandable="false" :label="t('排队中')"
            :title="t('已等 {value1}', { value1: format_elapsed(Math.max(0, now - Math.floor(message.created_at))) })">
            <template #text><span class="channel-checkin-line">{{ t('{member} 排队中：做完当前这件后接 #{message}', { member: bridge.display_name(message.author), message: message.request_message_id }) }}</span></template>
          </ScheduleCard>
        </LiveClock>
        <!-- Work in progress is a compact card: who and how long, the stage as the main line with the stop key at its end, -->
        <!-- and the notes below as a subordinate thread, folded to the latest note with the count after it. -->
        <div v-else-if="message.slot_card && !message.failure && !message.retry" :id="`execution-${message.id}`" class="channel-working-strip" :class="message.marks?.edge" :data-author="bridge.identities[message.author]?.style">
          <div class="channel-working-head">
            <!-- The same byline as the answered card: name, tags and model at the left; start time and time used at the right. -->
            <div class="channel-message-byline">
              <UAvatar :src="bridge.identities[message.author]?.icon" :text="bridge.identities[message.author]?.initials || '?'" :alt="bridge.display_name(message.author)" size="md" class="channel-avatar" :class="bridge.identities[message.author]?.style" />
              <div class="channel-message-meta">
                <div class="channel-message-author"><strong>{{ bridge.display_name(message.author) }}</strong><UBadge v-for="badge in message.marks?.badges || []" :key="badge.key" size="xs" color="neutral" variant="soft" class="channel-source channel-line-badge" :title="badge.title">{{ badge.label }}</UBadge><UTooltip v-if="message.background" :text="t('后台进行：主持人没有等它，接着在做别的')"><UIcon name="i-lucide-split" class="channel-working-background" role="img" :aria-label="t('后台进行：主持人没有等它')" /></UTooltip></div>
                <span v-if="message.model || message.effort" class="channel-message-provenance channel-message-model" :title="[message.model, message.effort].filter(Boolean).join(' · ')"><bdi v-if="message.model" class="channel-model-id">{{ message.model }}</bdi><span v-if="message.effort" class="channel-model-effort">{{ message.model ? ` · ${message.effort}` : message.effort }}</span></span>
              </div>
              <div class="channel-message-provenance channel-message-facts"><span v-if="message.replaced && !message.attempt" :title="replaced_title(message.replaced)">{{ t('重试') }}</span><time v-if="message.created_at" :title="new Date(message.created_at * 1000).toLocaleString(locale)">{{ bridge.format_time(message.created_at * 1000) }}</time><LiveClock v-slot="{ now }"><span class="channel-message-elapsed">{{ working_elapsed(message, now) }}</span></LiveClock></div>
            </div>
            <UTooltip v-if="can_manage && shows_progress(message) && message.execution_id" :text="t('私聊：查看它正在做什么')"><UButton icon="i-lucide-message-square" class="channel-private-chat-key channel-corner-key" size="xs" variant="ghost" color="neutral" :aria-label="t('私聊 {value1}：查看本次执行过程', { value1: bridge.display_name(message.author) })" @click="open_private_chat(act, message.author, message.execution_id)" /></UTooltip>
          </div>
          <!-- Private chat, as on the answered card: in the hover column outside the strip with a mouse; on touch screens the
               head-row key above takes the right end. The stop key sits at the status line's right end on every screen. -->
          <template v-if="can_manage && shows_progress(message) && message.execution_id">
            <div class="channel-message-actions"><div class="channel-message-stack"><div class="channel-message-toolbar channel-message-corner">
              <UTooltip :text="t('私聊：查看它正在做什么')"><UButton icon="i-lucide-message-square" class="channel-private-chat-key" size="xs" variant="ghost" color="neutral" :aria-label="t('私聊 {value1}：查看本次执行过程', { value1: bridge.display_name(message.author) })" @click="open_private_chat(act, message.author, message.execution_id)" /></UTooltip>
            </div></div></div>
          </template>
          <div class="channel-working-main">
            <LiveClock :message="message" v-slot="{ now, work }"><span v-for="status in [working_status(work, now)]" :key="message.id" class="channel-working-status" :class="{ 'channel-working-warning': status.warning }" role="status" :title="shows_progress(message) ? (message.waiting ? message.text : status.text) : t('此接入方式看不到进度，可在原窗口查看')">
              <span v-if="message.waiting">{{ message.text }}</span>
              <WorkingText v-else-if="status.live" :text="status.text" :seed="message.author" :beat="work.activity_at" :silent="now - (work.activity_at || message.created_at)" dots :muted="!shows_progress(message)" />
              <span v-else>{{ status.text }}</span>
            </span>
            <!-- Phone only: the time used moves here from the head, so both sides of the strip are two lines (user 2026-11-22, #6945). -->
            <span class="channel-message-provenance channel-working-elapsed" :title="message.replaced && !message.attempt ? replaced_title(message.replaced) : undefined">{{ working_elapsed(message, now, { show_replaced: true }) }}</span></LiveClock>
            <span v-if="can_manage && !message.queued" class="channel-working-actions">
                <!-- In a discussion, stopping the current speaker skips the turn so the next one speaks. -->
                <template v-if="speaking_turn?.expert === message.author && message.discussion_request">
                  <UTooltip :text="t('暂停讨论')"><UButton icon="i-lucide-pause" size="xs" variant="ghost" color="neutral" :aria-label="t('暂停讨论，停止 {value1} 本次发言', { value1: bridge.display_name(message.author) })" :loading="is_running('pause_discussion')" @click="act('pause_discussion')" /></UTooltip>
                  <UTooltip :text="t('停止本次发言，轮到下一位')"><UButton variant="solid" color="neutral" class="channel-stop-button" :aria-label="t('停止 {value1} 本次发言，轮到下一位', { value1: bridge.display_name(message.author) })" :loading="is_running('skip_turn')"
                    @click="act('skip_turn')"><span v-if="!is_running('skip_turn')" class="channel-stop-square" /></UButton></UTooltip>
                </template>
                <UTooltip v-else :text="t('停止')"><UButton variant="solid" color="neutral" class="channel-stop-button" :aria-label="t('停止 {value1} 本次执行', { value1: bridge.display_name(message.author) })"
                  :loading="is_running('change_member') && stopping_member === message.member_id" @click="stop_member(message)"><span v-if="!(is_running('change_member') && stopping_member === message.member_id)" class="channel-stop-square" /></UButton></UTooltip>
            </span>
          </div>
          <LiveClock :message="message" v-slot="{ work }"><ul v-if="work.tools?.length" class="channel-working-tools" :aria-label="t('工具调用次数')">
            <li v-for="item in work.tools" :key="`${item.phase}:${item.tool}`"><span>{{ tool_label(item) }} ×</span><span class="channel-working-tool-count" role="img" :aria-label="String(item.count)"><FlipDigit v-for="(digit, index) in String(item.count)" :key="String(item.count).length - index" :digit="digit" /></span></li>
          </ul></LiveClock>
          <LiveClock v-slot="{ note_map }"><div v-for="notes in [note_map.get(message.execution_id) || []].filter((list) => list.length)" :key="message.execution_id" class="channel-working-notes" :class="{ 'is-open': open_working_notes.has(message.execution_id), 'is-single': notes.length === 1 }">
            <template v-if="open_working_notes.has(message.execution_id)"><p v-for="note in notes.slice(0, -1)" :key="note.seq">{{ note.text }}</p></template>
            <p class="channel-working-latest" @click="notes.length === 1 || open_working_notes.has(message.execution_id) || toggle_working_notes(message.execution_id)">
              <span class="channel-working-latest-text">{{ notes.at(-1).text }}</span>
              <button v-if="notes.length > 1" type="button" class="channel-working-count" :aria-expanded="open_working_notes.has(message.execution_id)" :aria-label="open_working_notes.has(message.execution_id) ? t('收起过程说明') : t('展开全部 {value1} 段过程说明', { value1: notes.length })" @click.stop="toggle_working_notes(message.execution_id)">{{ t('{value1} 段', { value1: notes.length }) }}<UIcon name="i-lucide-chevron-down" /></button>
            </p>
          </div></LiveClock>
          <BackgroundTaskList v-if="message.background_tasks?.length" :tasks="message.background_tasks" />
        </div>
        <!-- Waiting to redeliver keeps the full card: the reason and its buttons do not fit one line. -->
        <UChatMessage v-else-if="message.slot_card && !message.failure" :id="`execution-${message.id}`" :data-author="bridge.identities[message.author]?.style" role="assistant" :parts="[]" side="left" variant="naked" color="neutral" class="channel-message" :ui="{ header: 'channel-message-header', container: 'channel-message-container', body: 'channel-message-body' }">
          <template #body>
            <div class="channel-message-byline">
              <UAvatar :src="bridge.identities[message.author]?.icon" :text="bridge.identities[message.author]?.initials || '?'" :alt="bridge.display_name(message.author)" size="md" class="channel-avatar" :class="bridge.identities[message.author]?.style" />
              <div class="channel-message-meta">
                <div class="channel-message-author"><strong>{{ bridge.display_name(message.author) }}</strong></div>
              </div>
              <div class="channel-message-provenance channel-message-facts"><time v-if="message.created_at" :title="new Date(message.created_at * 1000).toLocaleString(locale)">{{ bridge.format_time(message.created_at * 1000) }}</time><LiveClock v-slot="{ now }"><span class="channel-message-elapsed">{{ message.waiting ? t('手动启动{value1}', { value1: message.created_at ? t(' · 已等 {value1}', { value1: format_elapsed(Math.max(0, now - message.created_at)) }) : '' }) : t('已用 {value1}', { value1: format_elapsed(Math.max(0, now - message.created_at)) }) }}</span></LiveClock></div>
            </div>
            <div class="channel-working-row">
              <LiveClock :message="message" v-slot="{ now, work }"><div v-for="status in [working_status(work, now)]" :key="message.id" class="channel-message-text" :class="{ 'channel-working-warning': status.warning }" role="status" :aria-label="`${bridge.display_name(message.author)} ${status.text}`" :title="shows_progress(message) ? undefined : t('此接入方式看不到进度，可在原窗口查看')">
                <span v-if="message.waiting">{{ message.text }}</span>
                <WorkingText v-else-if="status.live" :text="status.text" :seed="message.author" :beat="work.activity_at" :silent="now - (work.activity_at || message.created_at)" dots :muted="!shows_progress(message)" />
                <span v-else>{{ status.text }}</span>
              </div></LiveClock>
            </div>
            <template v-if="message.retry">
              <p class="channel-message-text channel-failure-reason is-warning">{{ message.retry.reason }}</p>
              <div class="channel-failure-actions">
                <LiveClock v-slot="{ now }"><span class="channel-message-provenance">{{ t('{value1}（第 {value2}/{value3} 次）', { value1: message.retry.retry_at > now ? t('{value1} 秒后自动重试', { value1: message.retry.retry_at - now }) : t('正在重试'), value2: message.retry.attempt, value3: MAX_DELIVERY_RETRIES }) }}</span></LiveClock>
                <template v-if="can_manage">
                  <UButton :label="t('立即重试')" icon="i-lucide-rotate-ccw" size="sm" variant="soft" color="primary" :aria-label="t('立即重试 {value1} 的任务', { value1: bridge.display_name(message.author) })"
                    @click="act('retry_delivery', { execution_id: message.execution_id, action: 'retry_now' })" />
                  <UButton :label="t('停止')" icon="i-lucide-circle-stop" size="sm" variant="soft" color="error" :aria-label="t('停止自动重试 {value1} 的任务', { value1: bridge.display_name(message.author) })"
                    @click="act('retry_delivery', { execution_id: message.execution_id, action: 'retry_stop' })" />
                </template>
              </div>
            </template>
            <!-- The same row the answer keeps folded after its result: open while working. -->
            <LiveClock v-slot="{ note_map }"><ExecutionNotes v-if="note_map.get(message.execution_id)?.length" live :notes="note_map.get(message.execution_id)" /></LiveClock>
            <BackgroundTaskList v-if="message.background_tasks?.length" :tasks="message.background_tasks" />
          </template>
        </UChatMessage>
        <section v-else-if="message.failure" :id="message.id" class="channel-message channel-failed-execution" :class="message.marks?.edge" :data-author="bridge.identities[message.author]?.style" :aria-label="`${bridge.display_name(message.author)} ${message.undeliverable ? t('无法投递') : t('执行失败')}`">
          <div class="channel-message-byline">
            <UAvatar :src="bridge.identities[message.author]?.icon" :text="bridge.identities[message.author]?.initials || '?'" :alt="bridge.display_name(message.author)" size="md" class="channel-avatar" :class="bridge.identities[message.author]?.style" />
            <div class="channel-message-meta">
              <div class="channel-message-author"><strong>{{ bridge.display_name(message.author) }}</strong><UBadge v-for="badge in message.marks?.badges || []" :key="badge.key" size="xs" color="neutral" variant="soft" class="channel-source channel-line-badge" :title="badge.title">{{ badge.label }}</UBadge></div>
              <span v-if="message.failure.model || message.failure.effort" class="channel-message-provenance channel-message-model" :title="[message.failure.model, message.failure.effort].filter(Boolean).join(' · ')"><bdi v-if="message.failure.model" class="channel-model-id">{{ message.failure.model }}</bdi><span v-if="message.failure.effort" class="channel-model-effort">{{ message.failure.model ? ` · ${message.failure.effort}` : message.failure.effort }}</span></span>
            </div>
            <div v-for="at in [message.slot_card ? message.created_at * 1000 : message.created_at]" :key="message.id" class="channel-message-provenance channel-message-facts"><UBadge :label="message.undeliverable ? t('无法投递') : t('执行失败')" color="error" variant="soft" size="xs" /><time :title="new Date(at).toLocaleString(locale)">{{ bridge.format_time(at) }}</time><span v-if="message.failure.id">{{ t('执行 #{value1}', { value1: message.failure.id }) }}</span><span v-if="message.failure.elapsed_seconds != null" class="channel-message-elapsed">{{ t('耗时 {value1}', { value1: format_elapsed(message.failure.elapsed_seconds) }) }}</span></div>
          </div>
          <!-- Same row as the working card it replaced: retry takes the stop button's place. -->
          <div class="channel-working-row">
            <p class="channel-message-text channel-failure-reason">{{ message.failure.result || t('执行失败，未提供原因') }}</p>
            <div v-if="can_retry(message.failure)" class="channel-working-actions">
              <UTooltip :text="t('重试')"><UButton icon="i-lucide-rotate-cw" variant="solid" color="neutral" class="channel-stop-button channel-retry-button" :aria-label="t('把执行 #{value1} 的请求重新派给 {value2}', { value1: message.failure.id, value2: bridge.display_name(message.author) })"
                :loading="is_running('retry_delivery')" @click="act('retry_delivery', { execution_id: message.failure.id, action: 'retry' })" /></UTooltip>
            </div>
          </div>
          <!-- A retried or auto-woken failure stays in place; the new run's own card follows it under the same message. The note sits under
               the reason, full width, so a long reason is not squeezed into half the card beside it. -->
          <p v-if="message.failure.retried || message.failure.followed" class="channel-message-provenance channel-retried-note"><UIcon name="i-lucide-corner-down-right" />{{ message.failure.retried ? t('已重试，新的执行接在下方') : t('已自动唤醒处理，新的执行接在下方') }}</p>
          <p v-if="failure_advice(message.failure)" class="channel-message-text">{{ failure_advice(message.failure) }}</p>
          <LiveClock v-if="message.failure.notes || message.failure.steps" v-slot="{ note_map }"><ExecutionNotes :count="message.failure.notes || 0" :steps="message.failure.steps || 0" :notes="note_map.get(message.failure.id)" :load="() => load_notes(message.failure.id)" :preload="(near) => preload_notes(message.failure.id, near)" /></LiveClock>
          <ExecutionDenials v-if="message.failure.denials?.length" :denials="message.failure.denials" :allowable="Boolean(denial_allowance(message.failure))"
            :busy="allowing === message.failure.id" :error="allow_errors[message.failure.id]" @allow="allow_and_resend(message.failure)" />
        </section>
        <div v-else-if="message.withdrawn" :id="String(message.id)" :data-message-id="message.id" class="channel-withdrawn" :data-author="bridge.identities[message.author]?.style">
          <div class="channel-withdrawn-head">
            <UIcon :name="message.withdrawn === 'retracted' ? 'i-lucide-undo-2' : 'i-lucide-history'" class="channel-withdrawn-icon" />
            <span v-if="message.withdrawn === 'retracted'">{{ t('{value1} 撤回了一条消息', { value1: bridge.display_name(message.author) }) }}</span>
            <template v-else>
              <span>{{ t('已回退 {value1} 条记录', { value1: rewound_runs.runs.get(message.id)?.length }) }}</span>
              <UButton :label="expanded_rewinds.has(message.id) ? t('收起') : t('展开')" :trailing-icon="expanded_rewinds.has(message.id) ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" size="xs" variant="link" color="neutral" class="channel-withdrawn-toggle" :aria-expanded="expanded_rewinds.has(message.id)" :aria-label="expanded_rewinds.has(message.id) ? t('收起从 #{value1} 起已回退的记录', { value1: message.id }) : t('展开从 #{value1} 起已回退的记录', { value1: message.id })" @click="toggle_rewound(message.id)" />
            </template>
          </div>
          <ul v-if="message.withdrawn === 'rewound' && expanded_rewinds.has(message.id)" class="channel-withdrawn-list">
            <li v-for="item in rewound_runs.runs.get(message.id)" :key="item.id" :data-message-id="item.id">
              <strong>{{ bridge.display_name(item.author) }}</strong><span class="channel-withdrawn-text" :title="item.text">{{ item.text }}</span>
              <UButton :label="`#${item.id}`" size="xs" variant="link" color="neutral" :aria-label="t('查看已回退的原文 #{value1}', { value1: item.id })" :aria-expanded="opened_folded.has(item.id)" @click="toggle_folded(item.id)" />
              <div v-if="opened_folded.has(item.id)" class="markdown-body channel-withdrawn-full" v-html="bridge.render_room_markdown(item.text)"></div>
            </li>
          </ul>
        </div>
        <template v-else>
        <!-- Each card keeps its own render cache and reads only its card object; a room refresh re-renders only the cards whose inputs changed. -->
        <template v-for="card in [cached_card(message)]" :key="message.id">
        <MemoBlock :deps="card.deps">
        <UChatMessage :id="String(message.id)" :data-message-id="message.id" :data-author="message.relay_room ? 'relay' : bridge.identities[message.author]?.style" tabindex="-1" @pointerenter="card.armed || arm_card(message.id, $event)" :role="!message.relay_room && message.author === '用户' ? 'user' : 'assistant'" :parts="[]" side="left" variant="naked" color="neutral" class="channel-message" :class="[card.line.edge, { 'channel-interjection': message.interjection_parent_id, 'channel-relay-message': message.relay_room }]" :ui="{ header: 'channel-message-header', container: 'channel-message-container', body: 'channel-message-body' }">
          <template #body>
            <div class="channel-message-byline">
              <UAvatar :src="message_identity(message)?.icon" :icon="message.relay_room && !message_identity(message)?.icon ? 'i-lucide-link' : undefined" :text="message_identity(message)?.initials || '?'" :alt="message_name(message)" size="md" class="channel-avatar" :class="message_identity(message)?.style" />
              <div class="channel-message-meta">
                <div class="channel-message-author"><strong>{{ message_name(message) }}</strong><UBadge v-if="message.interjection_parent_id" size="xs" color="neutral" variant="soft" class="channel-source">{{ t('插话') }}</UBadge><span class="channel-message-round">{{ card.round_label }}</span><UBadge v-for="badge in card.line.badges.filter((item) => !item.goes)" :key="badge.key" size="xs" color="neutral" variant="soft" class="channel-source channel-line-badge" :title="badge.title">{{ badge.label }}</UBadge><UBadge v-if="!QUIET_SOURCES.has(message.source)" size="xs" color="neutral" variant="soft" class="channel-source">{{ bridge.sources[message.source] }}</UBadge><UBadge v-if="message.kind === 'receipt'" size="xs" color="neutral" variant="soft" class="channel-source">{{ t('运行回执') }}</UBadge><UBadge v-if="message.proactive" size="xs" color="neutral" variant="soft" class="channel-source" :title="t('成员在自己的窗口里应用户要求主动发言，不是在回答房间的请求')">{{ t('主动发言') }}</UBadge><UBadge v-if="message.relay_room" :disabled="message.relay_title == null" as="button" type="button" size="xs" color="neutral" variant="soft" class="channel-source channel-relay-source" :title="t('另一房间的主持人经房主凭据在本房间发言；点击打开该房间')" @click="message.relay_title !== null && act('room', message.relay_room)">{{ relay_label(message) }}</UBadge><UBadge v-if="message.submitted_by && message.submitted_by !== message.author && !(message.source === 'proxy' && message.submitted_by === '用户')" size="xs" color="neutral" variant="soft" class="channel-source">{{ t('{value1} 代发', { value1: bridge.display_name(message.submitted_by) }) }}</UBadge><UBadge v-if="message.source === 'auto'" size="xs" color="neutral" variant="soft" class="channel-source" :title="t('成员结束时没有提交回答，本机服务把它最后一段回复收录为本次回答')">{{ t('自动收录') }}</UBadge><UBadge v-for="badge in card.line.badges.filter((item) => item.goes)" :key="badge.key" size="xs" color="neutral" variant="soft" class="channel-source channel-line-badge" :title="badge.title">{{ badge.label }}</UBadge><UBadge v-if="card.waits" size="xs" color="neutral" variant="soft" class="channel-source" :title="card.speaking_expert ? t('{value1} 说完后交给主持人处理', { value1: bridge.display_name(card.speaking_expert) }) : t('等待主持人处理')">{{ t('待主持人处理') }}</UBadge></div>
                <span v-if="card.model || card.effort" class="channel-message-provenance channel-message-model" :title="[card.model, card.effort].filter(Boolean).join(' · ')"><bdi v-if="card.model" class="channel-model-id">{{ card.model }}</bdi><span v-if="card.effort" class="channel-model-effort">{{ card.model ? ` · ${card.effort}` : card.effort }}</span></span>
              </div>
              <div class="channel-message-provenance channel-message-facts"><RequestStatus v-if="card.badges?.length" :badges="card.badges" @locate="(id) => locate({ id })" /><time :title="new Date(message.created_at).toLocaleString(locale)">{{ bridge.format_time(message.created_at) }}</time><UButton :label="`#${message.id}`" color="neutral" variant="link" size="xs" :aria-label="t('查看原文 #{value1}', { value1: message.id })" class="channel-message-id" @click="emit('detail', message.id)" /><span v-if="card.elapsed !== null" class="channel-message-elapsed">{{ t('耗时 {value1}', { value1: format_elapsed(card.elapsed) }) }}</span></div>
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
                <UButton type="submit" :label="t('回退并发送')" size="xs" color="primary" :disabled="!card.editing_plan" :loading="card.editing_pending" />
              </div>
            </form>
            <div v-else class="channel-answer">
              <MessageVisualBody v-if="card.visuals?.length" :markup="card.body_html" :blocks="card.visuals" :message="message" />
              <div v-else :id="`channel-answer-${message.id}`" class="channel-message-text markdown-body" v-html="card.body_html"></div>
              <button v-for="mark in card.marks" :key="mark.id" type="button" class="excerpt-mark" :style="{ left: `${mark.left}px`, top: `${mark.top}px` }" :title="t('注释 {value1}：点击修改批注', { value1: mark.number })" :aria-label="t('修改注释 {value1} 的批注', { value1: mark.number })" @click="open_mark(mark.id)">{{ mark.number }}</button>
              <UButton v-if="card.preview.truncated" :label="card.expanded ? t('收起') : t('展开全文')" :trailing-icon="card.expanded ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" variant="link" color="neutral" size="xs" class="channel-answer-toggle" :aria-label="`${card.expanded ? t('收起回答') : t('展开完整回答')} #${message.id}`" :aria-expanded="card.expanded" :aria-controls="`channel-answer-${message.id}`" @click="toggle_answer(message, $event)" />
            </div>
            <div v-if="message.summary" class="channel-answer-summary"><small>{{ t('回答摘要') }}<span v-if="message.summary_by && message.summary_by !== message.author"> {{ t('· {value1} 整理', { value1: bridge.display_name(message.summary_by) }) }}</span></small><div class="channel-message-text markdown-body" v-html="message.rendered_summary"></div></div>
            <!-- What the reader takes away (summary, attachments, delivered files), then the run's record as labelled rows:
                 notes and steps, changed files, what ended it, refused operations (user 2026-11-21, #6448). -->
            <div v-if="card.attachments?.length" v-html="bridge.attachment_markup(card.attachments)"></div>
            <AnswerFiles v-if="card.execution_started_at" :message="message" :room-id="current_room_id" :started-at="card.execution_started_at" :attachments="card.attachments || []" />
            <AnswerSites :message="message" :room-id="current_room_id" :execution-id="message.execution_id || 0" />
            <LiveClock v-if="card.notes_count || card.steps" v-slot="{ note_map }"><ExecutionNotes :count="card.notes_count || 0" :steps="card.steps || 0" :notes="note_map.get(card.execution_id)" :load="() => load_notes(card.execution_id)" :preload="(near) => preload_notes(card.execution_id, near)" /></LiveClock>
            <div v-for="{ report, completed, allowable, failed } in card.report_rows" :key="report.id" class="channel-execution-report" role="group" :aria-label="t('执行报告 #{value1}', { value1: report.id })">
              <div v-if="report.changes?.length || report.tallying" class="channel-answer-summary channel-execution-files">
                <small>{{ t('文件改动') }}</small>
                <div class="channel-message-text">
                  <ExecutionChanges v-if="report.changes?.length" :report="report" :room-id="current_room_id" />
                  <p v-else class="channel-execution-tallying" role="status"><UIcon name="i-lucide-loader" class="animate-spin" />{{ t('正在统计文件改动…') }}</p>
                </div>
              </div>
              <div v-if="report.status !== 'completed' && (report.result || failed)" class="channel-answer-summary">
                <small>{{ report.label }}</small>
                <div class="channel-message-text">
                  <p v-if="report.result">{{ report.result }}</p>
                  <UButton v-if="failed" :label="t('重发')" icon="i-lucide-rotate-ccw" size="xs" variant="soft" color="neutral" :aria-label="t('把执行 #{value1} 的原消息填回输入框重发', { value1: report.id })" @click="resend_failed(report)" />
                </div>
              </div>
              <ExecutionDenials v-if="report.denials?.length" :denials="report.denials" :allowable="allowable" :folded="completed"
                :busy="card.allowing === report.id" :error="card.allow_errors?.[report.id]" @allow="allow_and_resend(report)" />
            </div>
            <div v-if="card.recommendation" class="channel-recommendation" :class="`is-${card.recommendation.status}`" :aria-label="t('智能调度推荐')" aria-live="polite">
              <template v-for="item in [card.recommendation]" :key="item.message_id">
                <UIcon name="i-lucide-zap" class="channel-recommendation-icon" />
                <span v-if="item.status === 'open'">{{ t('智能调度建议让') }} <strong>{{ bridge.display_name(item.member) }}</strong> {{ t('回答') }}<small :title="t('{value1}，置信度 {value2}', { value1: item.label, value2: Number(item.confidence).toFixed(2) })">{{ t('置信度 {value1} · {value2} 秒', { value1: Number(item.confidence).toFixed(2), value2: item.remaining }) }}</small></span>
                <span v-else-if="item.status === 'waiting'">{{ t('智能调度：主持人答完后请 {value1} 回答', { value1: bridge.display_name(item.member) }) }}</span>
                <span v-else>{{ t('智能调度：{value1}', { value1: item.mode === 'interrupt' ? t('已打断主持人，改由 {value1} 回答', { value1: bridge.display_name(item.member) }) : t('已请 {value1} 回答', { value1: bridge.display_name(item.member) }) }) }}</span>
                <template v-if="item.can_adopt">
                  <UButton v-if="!card.adopting" :label="t('采纳')" icon="i-lucide-check" size="xs" variant="soft" color="primary" :aria-label="t('采纳建议，请 {value1} 回答 #{value2}', { value1: bridge.display_name(item.member), value2: item.message_id })" @click="item.host_busy ? adopting = item.message_id : adopt(item.message_id, 'after')" />
                  <template v-else>
                    <UButton :label="t('打断主持人，改由 {value1} 回答', { value1: bridge.display_name(item.member) })" size="xs" variant="soft" color="warning" @click="adopt(item.message_id, 'interrupt')" />
                    <UButton :label="t('主持人答完后再请 {value1}', { value1: bridge.display_name(item.member) })" size="xs" variant="soft" color="neutral" @click="adopt(item.message_id, 'after')" />
                    <UButton icon="i-lucide-x" :aria-label="t('取消采纳')" size="xs" variant="ghost" color="neutral" @click="adopting = 0" />
                  </template>
                </template>
              </template>
            </div>
            <!-- Inside its own card: between two cards it read as belonging to the next one. -->
            <div v-if="card.locate" class="channel-locate"><UButton :label="t('在原文中定位')" icon="i-lucide-locate" size="xs" color="neutral" variant="link" @click="locate(message)" /></div>
          </template>
          <template #header><div class="channel-message-actions"><div class="channel-message-stack"><div class="channel-message-toolbar">
            <!-- Private chat joins the toolbar group at the end opposite "…": the bottom of the column with a mouse, the left end on touch screens. -->
            <component v-if="card.private_chat" :is="card.armed ? UTooltip : BareSlot" disable-hoverable-content :ui="KEY_TIP_UI" :text="t('私聊：查看这次执行的过程')"><UButton icon="i-lucide-message-square" class="channel-private-chat-key" size="xs" color="neutral" variant="ghost" :aria-label="t('查看 #{value1} 的执行过程', { value1: message.id })" @click="open_private_chat(act, message.author, card.execution_id)" /></component>
            <component :is="card.armed ? UTooltip : BareSlot" disable-hoverable-content :ui="KEY_TIP_UI" v-if="!card.private_chat && !card.can_take_back && !is_share" :text="t('回复')"><UButton icon="i-lucide-corner-up-left" size="xs" color="neutral" variant="ghost" :aria-label="t('回复 #{value1}', { value1: message.id })" @click="reply_to(message)" /></component>
            <component :is="card.armed ? UTooltip : BareSlot" disable-hoverable-content :ui="KEY_TIP_UI" v-if="card.can_retract && !card.editing" :text="t('撤回')"><UButton icon="i-lucide-undo-2" size="xs" color="neutral" variant="ghost" :aria-label="t('撤回 #{value1}', { value1: message.id })" @click="retract(message.id)" :loading="card.retracting" /></component>
            <component :is="card.armed ? UTooltip : BareSlot" disable-hoverable-content :ui="KEY_TIP_UI" v-if="card.can_take_back && !card.editing" :text="t('编辑')"><UButton icon="i-lucide-pencil" size="xs" color="neutral" variant="ghost" :aria-label="t('编辑 #{value1}，回退到它之前重新发送', { value1: message.id })" @click="start_edit(message)" /></component>
            <component :is="card.armed ? UTooltip : BareSlot" disable-hoverable-content :ui="KEY_TIP_UI" v-if="!card.narrow && !is_share && message.kind !== 'receipt' && !card.editing" :text="card.reading ? t('停止朗读') : t('朗读')"><UButton :icon="card.reading ? 'i-lucide-square' : 'i-lucide-volume-2'" size="xs" color="neutral" variant="ghost" :aria-label="card.reading ? t('停止朗读') : t('从 #{value1} 开始朗读', { value1: message.id })" @click="card.reading ? reader.stop() : reader.start(message.id)" /></component>
            <UDropdownMenu v-if="card.armed" :open="card.menu_open" :items="card.actions" :content="{ align: 'end', sideOffset: 5 }" :ui="{ content: 'channel-menu' }" @update:open="(open) => menu_open_id = open ? message.id : 0"><UButton icon="i-lucide-ellipsis" size="xs" color="neutral" variant="ghost" :aria-label="t('消息 #{value1} 的更多操作', { value1: message.id })" /></UDropdownMenu>
            <UButton v-else icon="i-lucide-ellipsis" size="xs" color="neutral" variant="ghost" :aria-label="t('消息 #{value1} 的更多操作', { value1: message.id })" aria-haspopup="menu" @click="open_card_menu(message.id)" />
          </div></div></div></template>
        </UChatMessage>
        </MemoBlock>
        </template>
        <!-- Cards without a body of their own carry it right below, ahead of the scheduler's cards. -->
        <div v-if="view_source_filter && !plain_card(message)" class="channel-locate is-outside"><UButton :label="t('在原文中定位')" icon="i-lucide-locate" size="xs" color="neutral" variant="link" @click="locate(message)" /></div>
        <!-- A decision stands between the card that ended the round and the next speaker. -->
        <ScheduleCard v-if="routing_messages.has(message.id) && !scheduler_decisions.get(message.id)?.length" icon="i-lucide-zap" skipped :label="t('智能调度分析中')" :expandable="false">
          <template #text><WorkingText :text="t('智能调度：正在分析')" :seed="t('智能调度')" dots /></template>
        </ScheduleCard>
        <SchedulerDecision v-for="decision in scheduler_decisions.get(message.id) || []" :key="`decision-${decision.id}`" :decision="decision" :free="free" />
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
                <div class="channel-message-author"><strong>{{ bridge.display_name(card.author) }}</strong></div>
              </div>
              <div class="channel-message-provenance channel-message-facts"><UBadge :label="t('发送失败')" color="error" variant="soft" size="xs" /><time>{{ bridge.format_time(card.created_at) }}</time></div>
            </div>
            <div class="channel-answer"><div class="channel-message-text markdown-body" v-html="bridge.render_room_markdown(card.text)"></div></div>
            <div v-if="card.files.some((file) => file.preview_url)" class="message-attachments">
              <span v-for="file in card.files.filter((item) => item.preview_url)" :key="file.preview_url" class="attachment-image"><img :src="file.preview_url" :alt="file.name"></span>
            </div>
            <div v-if="card.files.some((file) => !file.preview_url)" class="channel-message-provenance">{{ t('附件：{value1}', { value1: card.files.filter((file) => !file.preview_url).map((file) => file.name).join('、') }) }}</div>
            <p class="channel-message-text channel-failure-reason" role="alert">{{ card.failed }}</p>
            <div class="channel-failure-actions">
              <UButton :label="t('重新发送')" icon="i-lucide-rotate-ccw" size="sm" variant="soft" color="primary" :aria-label="t('重新发送这条消息')" @click="act('retry_sending', card.id)" />
              <UButton :label="t('放弃')" icon="i-lucide-x" size="sm" variant="soft" color="neutral" :aria-label="t('放弃发送，移除这张卡片')" @click="act('discard_sending', card.id)" />
            </div>
          </template>
        </UChatMessage>
      </div>
      <!-- The message being sent shows at once; the saved copy replaces it when the site answers, and a failed send becomes a failed card above. -->
      <!-- It mirrors a saved card line for line, so the swap changes only "发送中…" into the message number. -->
      <motion.div v-for="(card, index) in view.sending_previews" :key="card.id || card.created_at" :data-sending-id="card.id" class="channel-message-group" :style="index === 0 ? { opacity: send_entry, y: send_y } : undefined">
        <USeparator v-if="index === 0 && sending_day_label" :label="sending_day_label" class="channel-date-divider" />
        <UChatMessage :id="index === 0 ? 'channel-sending-message' : undefined" :data-author="bridge.identities[card.author]?.style" role="user" :parts="[]" side="left" variant="naked" color="neutral" class="channel-message channel-sending-message" :ui="{ header: 'channel-message-header', container: 'channel-message-container', body: 'channel-message-body' }">
          <template #body>
            <div class="channel-message-byline">
              <UAvatar :src="bridge.identities[card.author]?.icon" :text="bridge.identities[card.author]?.initials || '?'" :alt="bridge.display_name(card.author)" size="md" class="channel-avatar" :class="bridge.identities[card.author]?.style" />
              <div class="channel-message-meta">
                <div class="channel-message-author"><strong>{{ bridge.display_name(card.author) }}</strong></div>
              </div>
              <div class="channel-message-provenance channel-message-facts"><time>{{ bridge.format_time(card.created_at) }}</time><span class="channel-sending-status" role="status"><UploadPercent v-if="index === 0 && !card.waiting && !card.saved_id && !card.retrying && sending_uploads" :id="sending_uploads.id" v-slot="{ percent, phase }">{{ sending_upload_text(percent, phase) }}</UploadPercent><template v-else>{{ card.saved_id ? `#${card.saved_id}` : card.retrying ? t('网络不稳，第 {value1} 次重试…', { value1: card.retrying }) : t('发送中…') }}</template></span></div>
            </div>
            <div class="channel-answer"><div class="channel-message-text markdown-body" v-html="sending_html(card)"></div></div>
            <!-- The files show at once from this browser's own copy while they upload. -->
            <div v-if="sending_listed(card).length" class="message-attachments">
              <span v-for="file in sending_listed(card)" :key="file.preview_url" class="attachment-image is-uploading"><img :src="file.preview_url" :alt="file.name"><AttachmentUploadRing :id="file.id" pending :done="file.uploaded || Boolean(card.saved_id)" /></span>
            </div>
            <div v-if="card.files.some((file) => !file.preview_url)" class="channel-message-provenance">{{ t('附件：{value1}', { value1: card.files.filter((file) => !file.preview_url).map((file) => file.name).join('、') }) }}</div>
          </template>
        </UChatMessage>
        <ScheduleCard v-if="index === 0 && sending_routes" icon="i-lucide-zap" skipped :label="t('智能调度分析中')" :expandable="false">
          <template #text><WorkingText :text="t('智能调度：正在分析')" :seed="t('智能调度')" dots /></template>
        </ScheduleCard>
      </motion.div>
      <div v-if="(topic_anchor === 'end' || end_anchor === 'end') && !view_query && !view_source_filter" class="channel-message-group">
        <TopicCard v-if="topic_anchor === 'end'" :ref="(card) => topic_card = card" @edit="emit('edit')" />
        <DiscussionEndCard v-if="end_anchor === 'end'" />
      </div>
      <div v-if="view.messages_loading && !transcript_messages.length" class="channel-message-group channel-loading-skeleton grid gap-6 py-6" role="status" :aria-label="t('正在读取消息')"><div v-for="row in 3" :key="row" class="grid gap-3"><USkeleton class="h-5 w-28" /><USkeleton class="h-4 w-full" /><USkeleton class="h-4 w-2/3" /></div></div>
      <div v-else-if="view.messages_failure && !transcript_messages.length" class="channel-empty" role="status"><p>{{ view.messages_failure }}</p><UButton :label="t('重新读取消息')" icon="i-lucide-refresh-cw" color="neutral" variant="soft" @click="act('refresh')" /></div>
      <div v-else-if="!transcript_messages.length && !free_working.length && !view.sending_preview && !view.failed_sends.length" class="channel-empty"><UIcon :name="view_query || view_source_filter ? 'i-lucide-search' : 'i-lucide-hash'" /><h2>{{ view_query || view_source_filter ? t('没有找到消息') : room.title }}</h2><p>{{ view_query || view_source_filter ? t('试试其他关键词，或清除筛选。') : bridge.empty_discussion_message(room) }}</p></div>
    </div>
    <!-- Back from the background: the opening load covers the old cards until the room is read again (state.resuming). -->
    <div v-if="view.resuming" class="channel-resume-loading" role="status" :aria-label="t('正在读取消息')"><div class="channel-message-group channel-loading-skeleton grid gap-6 py-6"><div v-for="row in 3" :key="row" class="grid gap-3"><USkeleton class="h-5 w-28" /><USkeleton class="h-4 w-full" /><USkeleton class="h-4 w-2/3" /></div></div></div>
    <!-- The opening load (state.resuming) covers the cards, so nothing to jump to or quote shows over it. -->
    <div v-if="!view.resuming && ((transcript_messages.length && (!follow_tail || send_clipped)) || listen_here?.touch || reader.state.message_id || peek_origin)" class="channel-latest-dock">
      <button v-if="listen_here?.touch" type="button" class="channel-listen-pill" @mousedown.prevent @click="start_quote"><UIcon name="i-lucide-message-square-quote" />{{ t('添加到对话') }}</button>
      <button v-if="listen_here?.touch && listen_here.speech" type="button" class="channel-listen-pill" :aria-label="t('从选中处开始朗读')" @mousedown.prevent @click="listen_from_selection"><UIcon name="i-lucide-headphones" />{{ t('听当前') }}</button>
      <span v-if="reader.state.message_id && reader.state.loading" class="channel-listen-pill" role="status"><UIcon name="i-lucide-loader-circle" class="animate-spin" />{{ t('加载中') }}</span>
      <button v-else-if="reader.state.message_id" type="button" class="channel-listen-pill" :class="{ 'is-on': reader.state.following }" :aria-pressed="reader.state.following" :title="reader.state.following ? t('手动滚动即取消跟随') : t('页面跟随朗读位置滚动')" @click="reader.state.following ? (reader.state.following = false) : reader.follow()"><UIcon name="i-lucide-locate-fixed" />{{ reader.state.following ? t('跟随中') : t('跟随') }}</button>
      <button v-if="reader.state.reading" type="button" class="channel-listen-pill" :aria-label="t('停止朗读')" @click="reader.stop()"><UIcon name="i-lucide-square" />{{ t('停止') }}</button>
      <button v-if="peek_origin" type="button" class="channel-listen-pill" @click="return_from_peek"><UIcon name="i-lucide-undo-2" />{{ t('返回原位置') }}</button>
      <UButton v-if="transcript_messages.length && (!follow_tail || send_clipped)" icon="i-lucide-arrow-down" color="neutral" variant="outline" :aria-label="t('回到最新消息')" class="channel-latest-button" @click="return_to_latest" />
    </div>
    <div ref="composer_dock" class="channel-composer-dock"><div v-if="view.share || view.destroying.includes(view.room?.id)" class="channel-composer-column channel-share-composer">
      <UChatPrompt model-value="" disabled :autofocus="false" :rows="1" :placeholder="view.share ? t('这是只读分享，不能在这里发消息') : t('房间正在销毁，不能再发消息')" :aria-label="t('留言正文')" variant="outline" color="neutral" class="channel-composer" :ui="{ base: 'channel-editor', footer: 'channel-composer-footer' }">
        <template #footer>
          <template v-if="view.share">
            <span class="channel-share-stamp"><UIcon name="i-lucide-eye" />{{ t("只读分享 · 生成于 {time}", { time: new Date(view.share.exported_at).toLocaleString(locale, { hour12: false }) }) }}</span>
            <a class="channel-share-start" :href="view.share.home" target="_blank" rel="noopener noreferrer"><UIcon name="i-lucide-sparkles" />{{ t("用自己的 AI 开一个房间") }}<UIcon name="i-lucide-arrow-up-right" /></a>
          </template>
          <UButton v-else type="button" icon="i-lucide-arrow-up" color="neutral" size="sm" class="channel-primary-button channel-round-button channel-send" :aria-label="t('发送')" disabled />
        </template>
      </UChatPrompt>
    </div><div v-else class="channel-composer-column" @dragover="bridge.drop_attachments" @dragleave="bridge.drop_attachments" @drop="bridge.drop_attachments" @paste="bridge.paste_attachments" @keydown.capture="mention_keydown($event); attachment_shortcut($event); step_over_token($event, view.attachment_drafts)" @beforeinput="guard_token_edit($event, view.attachment_drafts)" @input.capture="hold_transcript" @input="release_transcript(); update_mention($event); drop_unreferenced($event)" @click="update_mention($event); snap_caret($event, view.attachment_drafts)" @keyup="update_mention($event); snap_caret($event, view.attachment_drafts)" @select="update_mention" @compositionstart="mention_composition" @compositionupdate="mention_composition" @compositionend="mention_composition" @scroll.capture="sync_mirror">
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
                <UIcon :name="option.broken ? 'i-lucide-triangle-alert' : option.needs_trust ? 'i-lucide-shield-alert' : 'i-lucide-network'" class="channel-mention-file-icon" :class="{ 'channel-mention-broken': option.broken || option.needs_trust }" />
                <span :class="{ 'channel-mention-disabled': option.disabled && !option.enabled }">{{ option.workflow.label }}</span>
                <b v-if="option.project_badge" class="channel-mention-tag is-project">{{ option.project_badge }}</b>
                <small class="channel-mention-brief" :class="{ 'channel-mention-broken': option.broken }" :title="!option.enabled && option.disabled || option.workflow.description">{{ !option.enabled && option.disabled || option.workflow.description }}</small>
                <b v-if="option.enabled" class="channel-mention-tag">{{ t('已启用') }}</b>
                <b v-else-if="option.needs_trust" class="channel-mention-tag is-warn">{{ t('待信任') }}</b>
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
                <button type="button" class="excerpt-chip-clear" :aria-label="t('移除全部注释')" :title="t('移除全部注释')" @click.stop="file_preview.excerpts = []"><UIcon name="i-lucide-x" /></button>
              </div>
              <template #content>
                <ol class="excerpt-list" :aria-label="t('注释')">
                  <li v-for="(excerpt, index) in excerpts" :key="excerpt.id">
                    <span class="excerpt-number">{{ index + 1 }}.</span>
                    <div class="excerpt-item">
                      <small>{{ excerpt.visual_key ? t('交互式可视化 · {value1}', { value1: excerpt_source(excerpt) }) : t('选中文字 · {value1}', { value1: excerpt_source(excerpt) }) }}</small>
                      <p class="excerpt-text">{{ excerpt.text }}</p>
                      <ExcerptEditCard v-if="editing_excerpt === excerpt.id" inline :removable="false" :comment="excerpt.comment"
                        @save="(comment) => { excerpt.comment = comment; editing_excerpt = 0; }" @cancel="editing_excerpt = 0" />
                      <template v-else-if="excerpt.comment"><small>{{ t('批注') }}</small><p class="excerpt-comment">{{ excerpt.comment }}</p></template>
                    </div>
                    <div class="excerpt-actions">
                      <button type="button" :aria-label="t('修改注释 {value1} 的批注', { value1: index + 1 })" :title="t('修改批注')" @click="edit_listed_excerpt(excerpt)"><UIcon name="i-lucide-pencil" /></button>
                      <button type="button" :aria-label="t('移除注释 {value1}', { value1: index + 1 })" :title="t('移除')" @click="remove_excerpt(excerpt)"><UIcon name="i-lucide-trash-2" /></button>
                    </div>
                  </li>
                </ol>
              </template>
            </UPopover>
            <div v-for="ref_item in file_refs" :key="`ref:${ref_item.path}`" class="attachment-draft-file attachment-draft-ref" :title="ref_item.path">
              <span v-if="ref_item.kind === 'file'" v-html="bridge.attachment_file_icon(ref_item.name)"></span>
              <UIcon v-else name="i-lucide-folder" class="attachment-ref-folder" />
              <span class="attachment-name"><span>{{ ref_item.name }}</span><small>{{ ref_item.kind === 'directory' ? t('项目文件夹') : t('项目文件') }} · {{ ref_item.path }}</small></span>
              <button type="button" class="attachment-remove" :aria-label="t('移除 {value1}', { value1: ref_item.path })" @click="file_refs = file_refs.filter((item) => item !== ref_item)"><UIcon name="i-lucide-x" /></button>
            </div>
            <div v-for="file in view.attachment_drafts" :key="file.id" :class="file.preview_url ? 'attachment-draft-image' : 'attachment-draft-file'">
              <img v-if="file.preview_url" :src="file.preview_url" :alt="file.file_name" :title="file.file_name">
              <template v-else>
                <span v-html="bridge.attachment_file_icon(file.file_name)"></span>
                <span class="attachment-name"><span :title="file.file_name">{{ file.file_name }}</span><small>{{ bridge.attachment_size(file.size) }}<UploadPercent :id="file.id" v-slot="{ percent, phase }"><template v-if="percent !== null"> · {{ phase === 'compress' ? t('压缩中 {percent}%', { percent }) : percent < 100 ? t('上传中 {percent}%', { percent }) : t('已上传') }}</template></UploadPercent></small></span>
              </template>
              <AttachmentUploadRing v-if="file.preview_url" :id="file.id" />
              <UploadPercent v-else :id="file.id" v-slot="{ percent, phase }">
                <span v-if="percent !== null && percent < 100" class="attachment-draft-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="percent" :aria-label="phase === 'compress' ? t('压缩中 {percent}%', { percent }) : t('上传中 {percent}%', { percent })"><i :style="{ width: `${percent}%` }" /></span>
              </UploadPercent>
              <button type="button" class="attachment-remove" :aria-label="t('移除 {value1}', { value1: file.file_name })" @click="act('remove_attachment', file.id)"><UIcon name="i-lucide-x" /></button>
            </div>
          </div>
          <div v-for="unregistered_member in unregistered_members" :key="unregistered_member.name" class="channel-reply-draft channel-queue-hint"><UIcon name="i-lucide-user-round-x" /><span>{{ unregistered_member.access === 'external' ? t('{value1} 待签到：把邀请链接发给对方', { value1: bridge.display_name(unregistered_member.name) }) : t('{value1} 待注册：在其会话中粘贴启动指令', { value1: bridge.display_name(unregistered_member.name) }) }}</span><UButton v-if="view.access?.can_manage && unregistered_member.access === 'external'" :label="t('邀请详情')" size="xs" color="neutral" variant="ghost" @click="pending_seat = unregistered_member; pending_seat_open = true" /><UButton v-if="view.access?.can_manage && unregistered_member.access === 'external'" :icon="launch_copied === unregistered_member.name ? 'i-lucide-check' : 'i-lucide-copy'"  aria-live="polite" size="xs" color="neutral" variant="ghost" class="channel-launch-copy" @click="copy_seat_link(unregistered_member)"><span class="channel-launch-copy-label"><span :class="{ 'is-hidden': launch_copied === unregistered_member.name }">{{ t('复制邀请链接') }}</span><span :class="{ 'is-hidden': launch_copied !== unregistered_member.name }">{{ t('已复制') }}</span></span></UButton><UButton v-if="view.access?.can_manage && unregistered_member.access !== 'external'" :icon="launch_copied === unregistered_member.name ? 'i-lucide-check' : 'i-lucide-copy'"  aria-live="polite" size="xs" color="neutral" variant="ghost" class="channel-launch-copy" @click="copy_launch(unregistered_member.name)"><span class="channel-launch-copy-label"><span :class="{ 'is-hidden': launch_copied === unregistered_member.name }">{{ t('复制启动指令') }}</span><span :class="{ 'is-hidden': launch_copied !== unregistered_member.name }">{{ t('已复制') }}</span></span></UButton></div>
          <div v-if="queue_hint" class="channel-reply-draft channel-queue-hint"><UIcon name="i-lucide-clock" /><span>{{ queue_hint }}</span><UButton v-if="is_manual_member(speaking_member) && view.access?.can_manage" :icon="launch_copied === speaking_member.name ? 'i-lucide-check' : 'i-lucide-copy'"  aria-live="polite" size="xs" color="neutral" variant="ghost" class="channel-launch-copy" @click="copy_launch(speaking_member.name)"><span class="channel-launch-copy-label"><span :class="{ 'is-hidden': launch_copied === speaking_member.name }">{{ t('复制启动指令') }}</span><span :class="{ 'is-hidden': launch_copied !== speaking_member.name }">{{ t('已复制') }}</span></span></UButton></div>
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
            <label class="channel-attach-button"><UIcon name="i-lucide-paperclip" class="size-4" aria-hidden="true" /><input type="file" multiple class="channel-attach-input" :aria-label="t('添加附件')" :title="t('图片、PDF 或其他文件 · 每个最多 20 MiB')" @click="open_attachment_picker" @change="pick_attachments"></label>
            <UTooltip v-if="speech_ready" :text="broadcast.on.value ? t('关闭语音播报') : t('语音播报：新回复自动朗读摘要')"><UButton type="button" icon="i-lucide-radio" color="neutral" variant="ghost" size="sm" class="channel-voice-button channel-broadcast-button" :class="{ 'is-on': broadcast.on.value }" :aria-pressed="broadcast.on.value" :aria-label="broadcast.on.value ? t('关闭语音播报') : t('开启语音播报')" @click="broadcast.toggle()" /></UTooltip>
            <UTooltip :text="ENTER_SENDS ? t('语音输入 · 也可按住空格说话') : t('按住说话，或轻点开始')"><UButton type="button" icon="i-lucide-mic" color="neutral" variant="ghost" size="sm" class="channel-voice-button channel-voice-mic" :aria-label="t('语音输入')" @pointerdown="voice_press.pointerdown" @click="voice_press.click" @contextmenu.prevent /></UTooltip>
            <UButton type="button" icon="i-lucide-arrow-up" color="neutral" size="sm" class="channel-primary-button channel-round-button channel-send" :aria-label="t('发送')" :title="t('发送 · Enter')" :disabled="!has_draft" @click="send" />
          </template>
        </template>
      </UChatPrompt>
      <div class="channel-composer-note"><span>{{ recipient_hint }}</span><span class="channel-draft-length"><span v-if="text_length" :class="{ 'is-near-limit': near_length_limit }">{{ text_length }} / {{ bridge.max_message_length }}<span class="channel-note-divider">·</span></span><span class="channel-key-hint"><kbd>Enter</kbd> {{ t('发送') }}<span class="channel-note-divider">·</span><kbd>Shift</kbd>+<kbd>Enter</kbd> {{ t('换行') }}</span></span></div>
    </div></div>
    <UModal :open="Boolean(active_trust_prompt)" :title="active_trust_prompt ? t('信任项目工作流「{name}」', { name: active_trust_prompt.label || active_trust_prompt.id }) : ''"
      :description="t('这个项目工作流来自项目目录，尚未在这台电脑上确认信任。启用前请核对以下权限与命令：')"
      :content="{ onInteractOutside: (event) => event.preventDefault() }"
      :ui="{ content: 'glass-panel studio-modal', body: 'dialog-body' }" @update:open="(open) => { if (!open) close_trust_prompt(); }">
      <template #body>
        <div v-if="active_trust_prompt" class="workflow-trust-dialog">
          <p v-if="active_trust_prompt.project_name" class="workflow-trust-meta">{{ t('所属项目：{name}', { name: active_trust_prompt.project_name }) }}</p>
          <div v-if="active_trust_prompt.untrusted_reasons?.elevated_cards?.length" class="workflow-trust-section">
            <h4>{{ t('高权限成员卡片') }}</h4>
            <ul>
              <li v-for="card in active_trust_prompt.untrusted_reasons.elevated_cards" :key="card.card">
                <strong>{{ card.label || card.card }}</strong>
                <span class="workflow-trust-access">{{ TRUST_ACCESS_LABELS[card.project_access] || card.project_access }}</span>
              </li>
            </ul>
          </div>
          <div v-if="active_trust_prompt.untrusted_reasons?.commands?.length" class="workflow-trust-section">
            <h4>{{ t('登记的命令（commands.json）') }}</h4>
            <ul>
              <li v-for="(cmd, idx) in active_trust_prompt.untrusted_reasons.commands" :key="idx"><code>{{ cmd }}</code></li>
            </ul>
          </div>
          <p class="workflow-trust-note">{{ t('确认后将记录在这台电脑的信任清单中；若工作流内容发生变更，会再次要求确认。') }}</p>
          <div class="workflow-trust-actions">
            <UButton :label="t('取消')" color="neutral" variant="ghost" :disabled="trust_submitting" @click="close_trust_prompt" />
            <UButton :label="active_trust_prompt.kind === 'slash' ? t('信任并继续') : t('信任并启用')" icon="i-lucide-shield-check" class="channel-primary-button" :loading="trust_submitting" @click="confirm_trust_prompt" />
          </div>
        </div>
      </template>
    </UModal>
  </section>
</template>

<style scoped>
.channel-free-recipients { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; min-width: 0; font-size: 12px; color: var(--ui-text-muted); }
.channel-free-recipients button { min-height: 24px; padding: 0 8px; border: 1px solid transparent; border-radius: 4px; color: var(--ui-text-muted); transition: background .12s, color .12s; }
.channel-free-recipients button:hover { background: #ffffff0d; color: var(--ui-text-highlighted); }
.channel-free-recipients button.is-on { border-color: color-mix(in srgb, var(--channel-accent) 40%, transparent); background: color-mix(in srgb, var(--channel-accent) 14%, transparent); color: var(--ui-text-highlighted); }
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
/* Pressed, the spinner takes the square's place at the centre of the key. */
.channel-stop-button :deep([data-slot="leadingIcon"]) { flex-shrink: 0; width: 14px; height: 14px; }
/* In the one-line strip the stop key shrinks to the row. */
.channel-working-strip .channel-stop-button { width: 24px; height: 24px; }
.channel-working-strip .channel-stop-square { width: 8px; height: 8px; }
@media (pointer: coarse) { .channel-working-strip .channel-stop-button { width: 28px; height: 28px; } }
</style>

<script setup>
/**
 * Private chat, shown as a terminal session with one room member, laid out as the CLIs print it: `>` for what the owner
 * said (in the room or here), `●` for the member's remarks and each tool step, `⎿` under a step for its first output
 * lines (a long one folds to `… +N 行`, opened by a click), all in one flowing stream with no per-answer folding. The
 * owner's lines and replies are kept by the website (owner only); the room tasks the same session ran come from the
 * room; each turn's steps are read from this computer's own log. Keys follow a local CLI: Enter sends, Shift+Enter breaks
 * the line, ↑/↓ recall earlier lines, Esc interrupts. On phones and tablets, as in the message composer, the return key
 * breaks the line and the send and stop buttons do the rest. A line sent while the member works goes into that turn as an
 * interjection; otherwise it runs as the next turn of the member's session.
 */
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { adapter_capabilities } from "../runner/adapters/profiles.mjs";
import { ENTER_SENDS } from "./enter-sends.js";
import { private_chat } from "./private-chat.js";
import { PHASE_LABELS } from "./timeline-model.js";

const { view, bridge, act } = inject("discussion");
const POLL_MS = 2000;
// Turns whose steps are read at once, and how long (s) a failed read waits before it is tried again.
const READ_CONCURRENCY = 4;
const ERROR_RETRY_S = 30;
const SHOWN_EXECUTIONS = 30;
// Output lines a step shows before folding to `… +N 行`, as the CLIs do.
const OUTPUT_LINES = 3;
// A step that took this long (s) shows its duration without hovering.
const SLOW_STEP_S = 10;
const ACTIVE = ["dispatched", "started"];
// How each kind of step is named on its `●` line.
const STEP_NAMES = { command: "Bash", search: "Search", edit: "Update" };
// The spinner the CLI cycles while it works.
const SPINNER = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"];
const SPIN_MS = 120;
// How close to the bottom (px) still counts as following new output.
const STICK_PX = 40;
// How long (ms) after the last scroll event and the finger lifting the screen counts as still.
const SCROLL_IDLE_MS = 200;
// Space left above a turn opened from a message card, and how long it stays marked.
const JUMP_GAP_PX = 12;
const TARGET_MS = 2000;
// Each member's lines, steps and scroll place, kept while the page is open so switching back does not start over.
const SESSIONS = new Map();

const room = computed(() => view.value.room);
// Same order as the room page's member cards: the room's default speaking order, others after it.
const members = computed(() => {
  const rank = room.value?.speaking_order?.default || [];
  const place = (name) => rank.includes(name) ? rank.indexOf(name) : rank.length;
  return [...(room.value?.free?.members || [])].sort((left, right) => place(left.name) - place(right.name));
});
const member = computed(() => members.value.find((item) => item.name === private_chat.member) || members.value[0] || null);
const name = computed(() => member.value?.name || "");
/** Why this member cannot take a private line here, or "" when it can. */
const unsupported = computed(() => !member.value ? "房间里还没有 AI 成员"
  : member.value.access !== "runner" ? "这位成员是手动接入的，请在它自己的窗口里对话"
    : !adapter_capabilities(member.value.adapter).chat ? "这位成员的接入方式看不到它的输出，暂不支持私聊窗" : "");

const chats = ref([]);
const details = ref(new Map());
// Why a turn's steps could not be read and when ({message, at}), by turn, shown in its place until a retry succeeds.
const errors = ref(new Map());
const open_output = ref(new Set());
const error = ref("");
const now = ref(Date.now() / 1000);
let timer = null;
// Whether the screen follows new output (false once the owner scrolls up to read).
let stick = true;
let serial = 0;
// The scrolling screen and its content (see "Scrolling" below).
const screen = ref(null);
const content = ref(null);
// Set when output arrives while the owner reads further up, so a button can bring the screen back to it.
const unread = ref(false);
let touching = false;
// The line at the top of the screen and its distance from the screen's top, as of the last scroll.
let anchor = null;
// The screen's scrollHeight and clientHeight as on_resize last saw them.
let last_height = 0;
let last_client = 0;
// The screen's scrollTop at the last scroll event, to tell the reader moving up from output arriving below.
let last_top = 0;
let anchor_frame = 0;
let observer = null;
// The screen's lines in order, read again only after the content changes size, not on every scroll.
let anchor_lines = null;
// More than a screen above the newest output, when a button offers the way back.
const away = ref(false);
// When (performance.now()) the screen last scrolled; iOS keeps firing scroll events through momentum.
let scrolled_at = 0;
// Step reads that arrived while the reader scrolled, applied once the screen is still (see when_still).
let deferred = [];
let still_timer = 0;
// Turns whose read waits in deferred, so a poll meanwhile does not read them again.
const waiting = new Set();
// Whether this member's turns have all been read once, so further growth is new output.
let settled = false;
// The room and member shown, the key of what SESSIONS keeps for them.
let session_key = "";
// The turn a message card asked for: kept on the screen even when older than the last SHOWN_EXECUTIONS, and marked.
const kept_execution = ref(null);
const target = ref("");
let target_timer = null;

/** The room tasks this member ran and its chat lines, oldest first, as one session. */
const items = computed(() => {
  const executions = (room.value?.free?.executions || []).filter((item) => item.member === name.value)
    .sort((a, b) => a.id - b.id).filter((item, index, all) => index >= all.length - SHOWN_EXECUTIONS || item.id === kept_execution.value);
  return [...executions.map((execution) => ({ key: `exec-${execution.id}`, at: execution.created_at, execution })),
    ...chats.value.map((chat) => ({ key: `chat-${chat.id}`, at: chat.created_at, chat }))].sort((a, b) => a.at - b.at);
});
// The turns on screen, with what the owner said and the final reply: as of the last moment the screen was still (see
// when_still), so a turn added or dropped, or a room message leaving the page's window, does not move the screen
// mid-swipe. Polls and the status line use items itself.
const shown_items = ref([]);
const snapshot = () => items.value.map((item) => ({ ...item, prompt: prompt_of(item), reply: reply_of(item) }));
watch(() => [items.value, view.value.messages], () => when_still(() => { shown_items.value = snapshot(); }), { immediate: true });
const running = (item) => item.chat ? item.chat.status === "running" : ACTIVE.includes(item.execution.status);
const running_item = computed(() => [...items.value].reverse().find((item) => running(item) || item.chat?.status === "pending") || null);
const status_line = computed(() => {
  const item = running_item.value;
  if (!item) return `${bridge.display_name(name.value)} · 空闲`;
  if (item.chat?.status === "pending") return `等 ${bridge.display_name(name.value)} 空闲后处理${ENTER_SENDS ? "（esc 撤回）" : ""}`;
  const started = item.chat ? item.chat.updated_at : item.execution.created_at;
  const phase = item.execution && member.value?.execution?.id === item.execution.id && member.value.execution.activity
    ? `${PHASE_LABELS[member.value.execution.activity] || "处理"}中` : "处理中";
  return `${phase}…（${elapsed(now.value - started)}${ENTER_SENDS ? " · esc 打断" : ""}）`;
});

/** `m:ss` or `h:mm:ss`. */
function elapsed(seconds) {
  const value = Math.max(0, Math.floor(seconds));
  const pad = (part) => String(part).padStart(2, "0");
  return value >= 3600 ? `${Math.floor(value / 3600)}:${pad(Math.floor(value / 60) % 60)}:${pad(value % 60)}` : `${Math.floor(value / 60)}:${pad(value % 60)}`;
}

/**
 * Read the chat from the website, then the steps of every turn not read yet: the turn a message card opened first, then
 * newest first so the latest show soonest, a few at a time (each read starts a process on the computer, or crosses the
 * relay). A running turn is read again each round, a failed one again after a while. A hidden page reads nothing and
 * catches up when shown.
 */
async function refresh() {
  clearTimeout(timer);
  const target = member.value, room_id = room.value?.id, current = ++serial;
  if (!target || !room_id || document.hidden) return;
  try {
    // Replaced only when something changed, so an unchanged poll renders nothing (see the v-memo on each turn).
    if (!unsupported.value || chats.value.length) {
      const next = (await bridge.read_member_chat(room_id, target.id)).chats;
      if (JSON.stringify(next) !== JSON.stringify(chats.value)) chats.value = next;
    }
    error.value = "";
  } catch (failure) {
    if (current === serial) error.value = failure.message || "未能读取私聊";
  }
  const retry_after = Date.now() / 1000 - ERROR_RETRY_S;
  const due = (item) => running(item) || (!details.value.has(item.key) && !waiting.has(item.key) && !(errors.value.get(item.key)?.at > retry_after));
  const queue = [...items.value].reverse().filter(due);
  const first = (item) => Number(item.execution?.id === kept_execution.value);
  queue.sort((a, b) => first(b) - first(a));
  await Promise.all(Array.from({ length: READ_CONCURRENCY }, async () => {
    while (queue.length && current === serial) await read_steps(queue.shift(), room_id, current);
  }));
  if (current !== serial) return;
  settled = true;
  timer = setTimeout(refresh, POLL_MS);
}
/** Read one turn's steps; kept only when they changed, and a failure is shown in its place until a retry succeeds. */
async function read_steps(item, room_id, current) {
  try {
    const result = await bridge.read_execution_details(room_id, item.execution?.id, item.chat ? { chat_id: item.chat.id } : {});
    if (current !== serial) return;
    waiting.add(item.key);
    when_still(() => {
      waiting.delete(item.key);
      if (JSON.stringify(result) !== JSON.stringify(details.value.get(item.key))) details.value = new Map(details.value).set(item.key, result);
      if (errors.value.has(item.key)) {
        const next = new Map(errors.value);
        next.delete(item.key);
        errors.value = next;
      }
    });
  } catch (failure) {
    if (current !== serial) return;
    when_still(() => { errors.value = new Map(errors.value).set(item.key, { message: failure.message || "未能读取过程", at: Date.now() / 1000 }); });
  }
}
/**
 * Apply a change to what the screen shows (a step read, the list of turns) once the screen is still. Content changing
 * above the reader makes on_resize write scrollTop to keep the top line in place, and iOS Safari drops a swipe or its
 * momentum on such a write, so the screen jerks and flickers. A change meant for another member (switched away
 * meanwhile) is dropped; that member's page is set up afresh.
 */
function when_still(change) {
  const key = session_key;
  deferred.push(() => { if (key === session_key) change(); });
  apply_when_still();
}
function apply_when_still() {
  clearTimeout(still_timer);
  const wait = touching ? SCROLL_IDLE_MS : scrolled_at + SCROLL_IDLE_MS - performance.now();
  if (wait > 0) {
    still_timer = setTimeout(apply_when_still, wait);
    return;
  }
  const changes = deferred;
  deferred = [];
  changes.forEach((change) => change());
}
function on_visibility() {
  if (!document.hidden) refresh();
}
document.addEventListener("visibilitychange", on_visibility);
// A string key: the room object is replaced on every refresh, and only another room or member starts the page over.
watch(() => `${room.value?.id}\n${name.value}`, (key) => {
  save_session();
  session_key = key;
  const saved = SESSIONS.get(key);
  chats.value = saved?.chats || []; details.value = saved?.details || new Map(); errors.value = new Map();
  open_output.value = saved?.open_output || new Set(); anchor = null; anchor_lines = null; unread.value = false; settled = Boolean(saved); waiting.clear(); shown_items.value = snapshot();
  restore_scroll(saved?.scroll);
  refresh();
}, { immediate: true });
const clock = setInterval(() => { now.value = Date.now() / 1000; }, 1000);
const frame = ref(0);
const spinner = setInterval(() => { if (running_item.value) frame.value = (frame.value + 1) % SPINNER.length; }, SPIN_MS);
onBeforeUnmount(() => { serial++; clearTimeout(timer); clearInterval(clock); clearInterval(spinner); document.removeEventListener("visibilitychange", on_visibility); });

/** A room message's text as the page already holds it (the message stream keeps the room's recent messages). */
function room_text(id) {
  return id ? view.value.messages?.find((message) => message.id === id)?.text || "" : "";
}
/** What the owner said to start a turn: a chat line, or the room message the task answered. */
function prompt_of(item) {
  return item.chat ? item.chat.text : room_text(item.execution.request_message_id) || (item.execution.request_message_id ? `（房间消息 #${item.execution.request_message_id}）` : "");
}
/** The member's final words for a turn: the chat reply, or its answer in the room. */
function reply_of(item) {
  return item.chat ? item.chat.reply : room_text(item.execution.answer_id);
}
/** A timestamp as a Date: the chat and executions give seconds, room messages an ISO string. */
function to_date(value) {
  if (!value) return null;
  return new Date(typeof value === "number" ? value * 1000 : value);
}
/** `14:32` today, `11-05 14:32` on another day. */
function short_time(date) {
  const pad = (part) => String(part).padStart(2, "0");
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return date.toDateString() === new Date().toDateString() ? clock : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock}`;
}
/** The turn's header: when it was sent, where it came from, and when the reply came. */
function turn_meta(item) {
  const sent = to_date(item.at);
  const replied = item.chat ? (item.chat.reply ? to_date(item.chat.updated_at) : null)
    : to_date(view.value.messages?.find((message) => message.id === item.execution.answer_id)?.created_at);
  return { source: item.chat ? "私聊" : `房间任务 #${item.execution.id}`,
    sent: sent ? short_time(sent) : "", sent_title: sent ? sent.toLocaleString("zh-CN") : "",
    replied: replied ? short_time(replied) : "", replied_title: replied ? replied.toLocaleString("zh-CN") : "" };
}
/** A turn's steps, without a remark that repeats its final reply. */
function steps_of(item) {
  const reply = item.reply?.trim();
  return (details.value.get(item.key)?.entries || []).filter((entry) => !(reply && entry.kind === "message" && entry.body?.trim() === reply));
}
/** The `●` line of a tool step as the CLIs print it, a bold name then its subject in brackets: Bash(…), Update(…). */
function step_line(entry) {
  if (STEP_NAMES[entry.kind]) return { tool: STEP_NAMES[entry.kind], subject: entry.title || "" };
  const [tool, ...rest] = String(entry.title || "tool").split(" ");
  return { tool, subject: rest.join(" ") };
}
/**
 * A step's time, when its software logs one: the clock time it started, shown only on hover, and how long it took,
 * shown all the time once it took SLOW_STEP_S or more (the step worth noticing) and otherwise only on hover.
 */
function step_time(entry) {
  const started = entry.at ? new Date(entry.at) : null;
  if (!started || Number.isNaN(started.getTime())) return null;
  const pad = (part) => String(part).padStart(2, "0");
  const seconds = entry.ended_at ? Math.max(0, (new Date(entry.ended_at) - started) / 1000) : null;
  const took = seconds == null ? "" : seconds < 60 ? `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s` : elapsed(seconds);
  return { clock: `${pad(started.getHours())}:${pad(started.getMinutes())}:${pad(started.getSeconds())}`, title: started.toLocaleString("zh-CN"),
    took, slow: seconds != null && seconds >= SLOW_STEP_S };
}
/** A diff line's tint: added or removed, as the CLI colours an edit. */
function diff_tone(entry, line) {
  if (entry.kind !== "edit") return "";
  if (/^\+(?!\+\+)/.test(line)) return "is-added";
  return /^-(?!--)/.test(line) ? "is-removed" : "";
}
/** A step's output lines with their tint: the first few, or all of them once opened. */
function output_of(item, entry) {
  const lines = String(entry.body || "").replace(/\s+$/, "").split(/\r?\n/);
  const all = open_output.value.has(`${item.key}/${entry.id ?? entry.title}`);
  const shown = all ? lines : lines.slice(0, OUTPUT_LINES);
  return { lines: shown.map((text) => ({ text, tone: diff_tone(entry, text) })), hidden: all ? 0 : Math.max(0, lines.length - OUTPUT_LINES) };
}
/** Unfold a step's output in place: the screen stays where it is, even at the bottom. */
function open_step(item, entry) {
  stick = false;
  open_output.value = new Set(open_output.value).add(`${item.key}/${entry.id ?? entry.title}`);
}
/** What happened to a chat line, when it is not simply answered. */
function chat_note(chat) {
  if (chat.status === "interjected") {
    const state = { pending: "待送达", delivered: "已送达", failed: "未送达" }[chat.interjection] || "已发出";
    return `作为插话进入房间任务 #${chat.execution_id}：${state}${chat.reason ? `，${chat.reason}` : ""}`;
  }
  if (chat.status === "pending") return "排队中，等它空闲后处理";
  if (chat.status === "stopped") return "已撤回";
  if (chat.status === "failed") return chat.reason || "未完成";
  return "";
}

/*
 * Scrolling. The stream changes on its own all the time: each poll re-reads the running turn, older turns' steps arrive
 * one by one, the oldest turn drops off the top, a room message leaves the page's window. So the screen reacts only to
 * a real change of the rendered height (a ResizeObserver), not to every poll: following, it goes to the bottom; reading
 * further up, it keeps the line at the top of the screen where it was (done here, as Safari has no scroll anchoring).
 * It does not follow while a finger is on the screen, and a wheel turned up stops following at once.
 */
function distance_to_bottom(element) {
  return element.scrollHeight - element.scrollTop - element.clientHeight;
}
/** Show the way back once the reader is more than a screen above the newest output. */
function update_away() {
  const element = screen.value;
  if (element) away.value = distance_to_bottom(element) > element.clientHeight;
}
/**
 * Remember the first line still showing at the top of the screen (lines sit in order, so a binary search finds it), with
 * the scrollTop it was seen at. Not while a size change waits for on_resize: the line would be read where the new
 * content already pushed it, and the push would never be undone; on_resize remembers it once it has corrected.
 */
function remember_anchor() {
  anchor_frame = 0;
  const element = screen.value;
  if (!element || !content.value || element.scrollHeight !== last_height || element.clientHeight !== last_client) return;
  const top = element.getBoundingClientRect().top;
  const lines = anchor_lines ||= content.value.querySelectorAll(".term-welcome, .term-turn > *");
  let low = 0, high = lines.length - 1, found = null;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (lines[middle].getBoundingClientRect().bottom > top) { found = lines[middle]; high = middle - 1; } else low = middle + 1;
  }
  anchor = found ? { line: found, top: found.getBoundingClientRect().top - top, scroll_top: element.scrollTop } : null;
}
function on_scroll() {
  const element = screen.value;
  scrolled_at = performance.now();
  // Only a move up is the reader's: output that lands between following to the bottom and this event leaves the
  // screen short of the bottom without the reader doing anything.
  if (distance_to_bottom(element) < STICK_PX) stick = true;
  else if (element.scrollTop < last_top - 1) stick = false;
  last_top = element.scrollTop;
  if (stick) unread.value = false;
  update_away();
  anchor_frame ||= requestAnimationFrame(remember_anchor);
}
/** A finger on the screen holds the following still until it lifts. */
function set_touching(value) {
  touching = value;
}
function on_wheel(event) {
  if (event.deltaY < 0) stick = false;
}
/** The rendered height changed: follow to the bottom, or keep the reader's line in place. */
function on_resize() {
  const element = screen.value;
  if (!element) return;
  anchor_lines = null;
  const grew = element.scrollHeight > last_height;
  last_height = element.scrollHeight;
  last_client = element.clientHeight;
  if (stick) {
    if (!touching) element.scrollTop = element.scrollHeight;
  } else {
    if (anchor?.line.isConnected) {
      // Where the line would be had only the reader's own scrolling since it was remembered moved it.
      const expected = anchor.top - (element.scrollTop - anchor.scroll_top);
      const shift = anchor.line.getBoundingClientRect().top - element.getBoundingClientRect().top - expected;
      if (Math.abs(shift) >= 1) element.scrollTop += shift;
    }
    // Steps still arriving for the turns already there are not new output.
    if (grew && settled) unread.value = true;
  }
  update_away();
  remember_anchor();
}
/** Jump to the newest output and follow it again. */
function to_bottom() {
  stick = true;
  unread.value = false;
  away.value = false;
  nextTick(() => { if (screen.value) screen.value.scrollTop = screen.value.scrollHeight; });
}
/** Put the screen back where the reader left this member: at the bottom, or at the same place further up. */
function restore_scroll(top) {
  if (top == null) return to_bottom();
  stick = false;
  nextTick(() => {
    if (!screen.value) return;
    screen.value.scrollTop = top;
    update_away();
    remember_anchor();
  });
}
/** Keep this member's lines, steps and place, so coming back to it (or to this page) shows them at once. */
function save_session() {
  if (!session_key) return;
  SESSIONS.set(session_key, { chats: chats.value, details: details.value, open_output: open_output.value,
    scroll: stick || !screen.value ? null : screen.value.scrollTop });
}
/** Open the turn a message card asked for ("查看这次执行的过程") at the top of the screen, marked for a moment. */
function jump_to_execution() {
  const id = private_chat.execution_id;
  const section = id && screen.value && content.value?.querySelector(`[data-key="exec-${id}"]`);
  if (!section) return;
  private_chat.execution_id = null;
  stick = false;
  screen.value.scrollTop += section.getBoundingClientRect().top - screen.value.getBoundingClientRect().top - JUMP_GAP_PX;
  update_away();
  remember_anchor();
  target.value = section.dataset.key;
  clearTimeout(target_timer);
  target_timer = setTimeout(() => { target.value = ""; }, TARGET_MS);
}
watch(() => [private_chat.execution_id, shown_items.value.length], () => {
  if (private_chat.execution_id) kept_execution.value = private_chat.execution_id;
  nextTick(jump_to_execution);
}, { immediate: true });
onMounted(() => {
  observer = new ResizeObserver(on_resize);
  observer.observe(screen.value);
  observer.observe(content.value);
});
onBeforeUnmount(() => { save_session(); observer?.disconnect(); cancelAnimationFrame(anchor_frame); clearTimeout(target_timer); clearTimeout(still_timer); });

const draft = ref("");
const sending = ref(false);
const history = [];
let history_index = -1;
let submission_id = "";

/** Send the line; a failed send keeps the text and its submission id for the retry. */
async function send() {
  const text = draft.value.trim();
  if (!text || sending.value || unsupported.value) return;
  submission_id ||= crypto.randomUUID();
  sending.value = true;
  try {
    await bridge.send_member_chat(room.value.id, member.value.id, text, submission_id);
    history.push(text);
    history_index = -1;
    draft.value = "";
    submission_id = "";
    to_bottom();
    await refresh();
  } catch (failure) {
    error.value = failure.message || "未能发出";
  } finally { sending.value = false; }
}
/** Enter sends with a keyboard, except while an input method is still composing (choosing Chinese characters). */
function on_enter(event) {
  if (!ENTER_SENDS || event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  send();
}
/** Esc stops what is running: a chat line, or the room task the member works on. */
async function interrupt() {
  const item = running_item.value;
  if (!item) return;
  try {
    if (item.chat) await bridge.stop_member_chat(room.value.id, item.chat.id);
    else await act("change_member", { member_id: member.value.id, name: name.value, action: "interrupt" });
    await refresh();
  } catch (failure) { error.value = failure.message || "未能打断"; }
}
/** ↑/↓ walk earlier lines when the caret is on the first or last line, as a shell does. */
function recall(event, step) {
  if (!ENTER_SENDS) return;
  const field = event.target;
  const at_edge = step < 0 ? !field.value.slice(0, field.selectionStart).includes("\n") : !field.value.slice(field.selectionEnd).includes("\n");
  if (!history.length || !at_edge) return;
  event.preventDefault();
  history_index = history_index < 0 ? (step < 0 ? history.length - 1 : -1) : history_index + step;
  if (history_index >= history.length) history_index = -1;
  history_index = Math.max(-1, history_index);
  draft.value = history_index < 0 ? "" : history[history_index];
}
</script>

<template>
  <div class="term" role="tabpanel" aria-label="私聊">
    <div class="term-tabs-bar">
    <nav class="term-tabs" aria-label="成员">
      <button v-for="item in members" :key="item.id" type="button" class="term-tab" :class="{ 'is-current': item.name === name }"
        :aria-current="item.name === name" @click="private_chat.member = item.name; private_chat.execution_id = null">
        <span class="term-dot" :class="{ 'is-busy': ACTIVE.includes(item.execution?.status) }" />{{ bridge.display_name(item.name) }}
      </button>
    </nav>
    </div>
    <div class="term-stage">
    <div ref="screen" v-keep-reading class="term-screen" @scroll.passive="on_scroll" @wheel.passive="on_wheel"
      @touchstart.passive="set_touching(true)" @touchend="set_touching(false)" @touchcancel="set_touching(false)">
      <div ref="content" class="term-content">
      <div v-if="member" class="term-welcome">
        <div><span class="term-accent">✻</span> 和 <b>{{ bridge.display_name(name) }}</b> 私聊</div>
        <div class="term-dim">用它在房间里的同一个会话回答，记录只有你看得到</div>
      </div>
      <p v-else class="term-dim">房间里还没有 AI 成员</p>
      <section v-for="item in shown_items" :key="item.key" class="term-turn" :class="{ 'is-target': target === item.key }" :data-key="item.key"
        v-memo="[item.at, item.prompt, item.reply, running(item), item.chat && chat_note(item.chat), details.get(item.key), errors.get(item.key), open_output, target === item.key]">
        <div v-for="meta in [turn_meta(item)]" :key="'meta'" class="term-meta">
          <time :title="meta.sent_title">{{ meta.sent }}</time><span>{{ meta.source }}</span>
          <span v-if="meta.replied" class="term-meta-end">回复于 <time :title="meta.replied_title">{{ meta.replied }}</time></span>
        </div>
        <div v-if="item.prompt" class="term-prompt"><span class="term-body">{{ item.prompt }}</span></div>
        <div v-if="errors.get(item.key) && !details.has(item.key)" class="term-sub term-warn"><span class="term-corner">⎿</span><span class="term-body">未能读取过程：{{ errors.get(item.key).message }}</span></div>
        <div v-else-if="!details.has(item.key) && running(item)" class="term-sub"><span class="term-corner">⎿</span><span class="term-body">正在读取…</span></div>
        <template v-for="(entry, index) in steps_of(item)" :key="entry.id ?? index">
          <div v-if="entry.kind === 'message'" class="term-line term-msg"><span class="term-bullet">●</span><span class="term-body">{{ entry.body }}</span></div>
          <div v-else-if="entry.kind === 'interjection'" class="term-prompt term-msg"><span class="term-body">{{ entry.body }}</span></div>
          <div v-else-if="entry.kind === 'thinking'" class="term-line term-thinking"><span class="term-bullet">✻</span><span class="term-body">{{ entry.body }}</span></div>
          <div v-else-if="entry.kind === 'plan'" class="term-block">
            <div class="term-line"><span class="term-bullet">●</span><span class="term-body"><b class="term-tool">Update Todos</b></span></div>
            <div class="term-sub"><span class="term-corner">⎿</span><span class="term-body">{{ entry.body }}</span></div>
          </div>
          <div v-else-if="entry.kind === 'error'" class="term-line term-error"><span class="term-bullet">●</span><span class="term-body">{{ entry.body || entry.title }}</span></div>
          <div v-else class="term-block">
            <div class="term-line term-step"><span class="term-bullet" :class="`is-${entry.state || 'done'}`">●</span><span v-for="step in [step_line(entry)]" :key="'step'" class="term-body"><b class="term-tool">{{ step.tool }}</b><span v-if="step.subject" class="term-subject">({{ step.subject }})</span></span><span v-for="time in [step_time(entry)]" :key="'time'" class="term-when"><template v-if="time"><time class="term-clock" :title="time.title">{{ time.clock }}</time><span v-if="time.took" class="term-took" :class="{ 'is-slow': time.slow }">{{ time.took }}</span></template></span></div>
            <div v-if="entry.body" v-for="output in [output_of(item, entry)]" :key="'out'" class="term-sub" :class="{ 'term-error': entry.state === 'failed' }">
              <span class="term-corner">⎿</span><span class="term-body"><span v-for="(line, at) in output.lines" :key="at" class="term-out" :class="line.tone">{{ line.text || " " }}</span><button v-if="output.hidden" type="button" class="term-more" @click="open_step(item, entry)">… +{{ output.hidden }} 行（点击展开）</button></span>
            </div>
          </div>
        </template>
        <div v-if="item.reply" class="term-line term-msg"><span class="term-bullet">●</span><span class="term-body">{{ item.reply }}</span></div>
        <div v-if="item.chat && chat_note(item.chat)" class="term-sub" :class="{ 'term-error': item.chat.status === 'failed' }"><span class="term-corner">⎿</span><span class="term-body">{{ chat_note(item.chat) }}</span></div>
      </section>
      </div>
    </div>
    <button v-if="unread || away" type="button" class="term-unread" @click="to_bottom">{{ unread ? "↓ 新输出" : "↓ 回到底部" }}</button>
    </div>
    <div class="term-status" :class="{ 'is-running': running_item }" role="status">
      <span v-if="running_item" class="term-spin">{{ SPINNER[frame] }}</span><span>{{ status_line }}</span>
    </div>
    <div class="term-input">
      <span class="term-caret" aria-hidden="true">&gt;</span>
      <textarea v-model="draft" rows="1" :enterkeyhint="ENTER_SENDS ? 'send' : 'enter'" :disabled="Boolean(unsupported) || sending" :placeholder="unsupported ? '暂不可用' : running_item ? '插话引导它…' : '输入消息…'"
        aria-label="私聊输入" maxlength="4000" @keydown.enter.exact="on_enter" @keydown.esc.prevent="interrupt"
        @keydown.up="recall($event, -1)" @keydown.down="recall($event, 1)" />
      <!-- Touch keyboards have no Esc and often no Enter that sends, so both keys also have buttons. -->
      <button v-if="running_item" type="button" class="term-button is-stop" aria-label="打断" title="打断（Esc）" @click="interrupt"><span class="term-stop-square" /></button>
      <button type="button" class="term-button" aria-label="发送" :title="ENTER_SENDS ? '发送（Enter）' : '发送'" :disabled="!draft.trim() || sending || Boolean(unsupported)" @click="send">↑</button>
    </div>
    <div class="term-hint">
      <span v-if="error" class="term-warn">{{ error }}</span>
      <span v-else-if="unsupported" class="term-warn">{{ unsupported }}</span>
      <span v-else-if="ENTER_SENDS">enter 发送 · shift+enter 换行 · ↑↓ 历史{{ running_item ? " · esc 打断" : "" }}</span>
    </div>
  </div>
</template>

<style scoped>
/* Laid out and coloured as Claude Code prints it (its light and dark themes): one monospace stream, `>` prompts on a
   grey band, `●` lines with a blank line between blocks, `⎿` output in grey under a step, diff lines tinted, the orange
   spinner line above a rounded input box, and a grey key hint under it. */
/* Base colours come from the site's own tokens so the page sits in the workspace like the other channels; only the
   terminal accents (orange, green, red, diff tints) are the CLI's. The line height is whole pixels: a fractional one
   (13.5px × 1.7) makes each new block round the bottom differently, and the text following the bottom shakes by 1px. */
.term { position: relative; --term-font: ui-monospace, "Cascadia Mono", "SF Mono", Menlo, Consolas, "Microsoft YaHei UI", "PingFang SC", monospace;
  --term-size: 13.5px; --term-line: 23px; --term-width: var(--channel-reading-width, 960px); --term-gutter: 24px;
  --term-bg: var(--ui-bg); --term-text: var(--ui-text); --term-strong: var(--ui-text-highlighted); --term-dim: var(--ui-text-muted);
  --term-faint: var(--ui-text-dimmed); --term-band: color-mix(in srgb, var(--ui-text) 6%, var(--ui-bg)); --term-border: var(--ui-border);
  --term-field: color-mix(in srgb, var(--ui-text) 4%, var(--ui-bg));
  --term-accent: #d77757; --term-green: #2c7a39; --term-red: #ab2b3f; --term-blue: #5769f7; --term-added: #dcf5e0; --term-removed: #fbe3e6;
  display: flex; flex-direction: column; flex: 1 0 0; width: 100%; min-height: 360px; color: var(--term-text);
  font-family: var(--term-font); font-size: var(--term-size); line-height: var(--term-line); background: var(--term-bg); overflow: hidden; }
.dark .term { --term-green: #4eba65; --term-red: #ff6b80; --term-blue: #b1b9f9; --term-added: #1f3d25; --term-removed: #45222a; }
/* Tabs, stream, status and input share one centred column as wide as the message page's; the stream scrolls across
   the whole page so its scrollbar sits at the page edge, not beside the column. */
.term-tabs, .term-content, .term-status, .term-input, .term-hint { width: 100%; max-width: var(--term-width); margin-inline: auto; }
.term-tabs-bar { border-bottom: 1px solid var(--term-border); }
.term-tabs { display: flex; gap: 4px; padding: 10px var(--term-gutter) 0; overflow-x: auto; scrollbar-width: none; scroll-snap-type: x proximity; }
.term-tab { display: flex; align-items: center; gap: 7px; padding: 5px 12px 7px; border: 0; border-bottom: 2px solid transparent; scroll-snap-align: start;
  background: none; color: var(--term-dim); font: inherit; font-size: 12.5px; line-height: 1.4; cursor: pointer; white-space: nowrap; }
.term-tab:hover { color: var(--term-text); }
.term-tab.is-current { color: var(--term-strong); font-weight: 600; border-bottom-color: var(--term-accent); }
.term-dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: var(--term-faint); flex: none; }
.term-dot.is-busy { background: var(--term-accent); animation: term-pulse 1.2s ease-in-out infinite; }
@keyframes term-pulse { 50% { opacity: .3; } }
/* The browser's own scroll anchoring is off: the script keeps the reading position, in every browser alike. */
/* The screen and the button back to the bottom, which sits on the screen's lower edge whatever the input's height. */
.term-stage { position: relative; display: flex; flex: 1; min-height: 0; }
.term-screen { flex: 1; min-width: 0; overflow-y: auto; padding: 20px 0 12px; overscroll-behavior: contain; overflow-anchor: none; }
.term-content { padding-inline: var(--term-gutter); }
/* A turn opened from a message card is marked for a moment. */
.term-turn.is-target { animation: term-flash 2s ease-out; border-radius: 4px; }
@keyframes term-flash { from { background: color-mix(in srgb, var(--term-accent) 16%, transparent); } }
.term-welcome { display: inline-block; max-width: 100%; margin-bottom: 20px; padding: 10px 16px; border: 1px solid var(--term-accent); border-radius: 8px; }
.term-welcome .term-dim { margin-top: 2px; font-size: 12.5px; }
.term-welcome b, .term-tool { font-weight: 700; color: var(--term-strong); }
.term-accent { color: var(--term-accent); }
/* A blank line between blocks and between turns, as the CLI leaves one. */
.term-turn { display: flex; flex-direction: column; gap: 10px; margin-bottom: 24px; }
/* Separators come in three strengths: between tasks a solid rule and a header line (when sent, where from, when the
   reply came); inside a task a dashed rule before each of the member's remarks and its reply; between tool steps only
   space. An interjection already stands out on its grey band, so it gets space rather than a rule. */
.term-turn + .term-turn { padding-top: 20px; border-top: 1px solid var(--term-border); }
.term-turn > .term-line.term-msg { margin-top: 4px; padding-top: 14px; border-top: 1px dashed color-mix(in srgb, var(--term-border) 70%, transparent); }
.term-turn > .term-prompt.term-msg { margin-top: 8px; }
.term-turn > :is(.term-meta, .term-prompt) + .term-msg { margin-top: 0; padding-top: 0; border-top: 0; }
.term-meta { display: flex; align-items: baseline; gap: 1.5ch; margin-bottom: -6px; color: var(--term-faint); font-size: 11.5px; line-height: 18px; font-variant-numeric: tabular-nums; }
.term-meta time { color: var(--term-dim); }
.term-meta-end { margin-left: auto; }
/* As on the message page, turns off the screen skip layout and paint: a long session is tens of thousands of pixels of
   text, and laying all of it out again made scrolling and every arriving step slow. WebKit is left out (font:
   -apple-system-body matches only it), as on the message page: a turn that turns real above the screen while the
   reader swipes up makes on_resize write scrollTop, and iOS Safari then drops the swipe and its momentum. */
@supports not (font: -apple-system-body) {
  .term-turn { content-visibility: auto; contain-intrinsic-block-size: auto 240px; }
}
.term-prompt { display: grid; grid-template-columns: 1ch minmax(0, 1fr); column-gap: 1ch; padding: 3px 10px; border-radius: 4px;
  background: var(--term-band); color: var(--term-text); }
.term-prompt::before { content: ">"; color: var(--term-dim); }
.term-block { display: flex; flex-direction: column; gap: 2px; }
.term-line, .term-sub { display: grid; grid-template-columns: 1ch minmax(0, 1fr); column-gap: 1ch; }
.term-sub { padding-left: 2ch; }
/* A step's time sits at the right of its `●` line, out of the way: a slow step's duration always shows faintly; its
   clock time and a quick step's duration show while the pointer is over the step (a tap on touch screens). */
.term-step { grid-template-columns: 1ch minmax(0, 1fr) auto; }
.term-when { padding-left: 2ch; color: var(--term-faint); font-size: 11.5px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.term-when > * { display: none; }
.term-when > .term-took.is-slow { display: inline; }
.term-block:hover .term-when > * { display: inline; }
.term-block:hover .term-clock + .term-took::before { content: " · "; }
.term-body { min-width: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.term-prompt .term-body { color: var(--term-text); }
.term-sub .term-body, .term-dim { color: var(--term-dim); }
.term-thinking .term-body { color: var(--term-dim); font-style: italic; }
.term-thinking .term-bullet { color: var(--term-accent); }
.term-subject { color: var(--term-text); }
.term-bullet { color: var(--term-strong); }
.term-bullet.is-done { color: var(--term-green); }
.term-bullet.is-failed, .term-error .term-bullet, .term-error .term-body { color: var(--term-red); }
.term-bullet.is-running { color: var(--term-dim); animation: term-pulse 1s ease-in-out infinite; }
.term-corner { color: var(--term-faint); }
.term-warn { color: var(--term-red); }
.term-out { display: block; }
.term-out.is-added { background: var(--term-added); }
.term-out.is-removed { background: var(--term-removed); }
.term-more { all: unset; display: block; cursor: pointer; color: var(--term-faint); }
.term-more:hover { color: var(--term-dim); text-decoration: underline; }
.term-status { display: flex; align-items: center; gap: 1ch; min-height: 30px; padding: 4px calc(var(--term-gutter) + 2px) 4px; color: var(--term-dim); font-size: 12.5px; }
.term-status.is-running { color: var(--term-accent); }
.term-spin { display: inline-block; width: 1ch; text-align: center; }
/* The input box looks like the message composer: a filled, rounded field on the page colour. */
.term-input { display: flex; align-items: flex-start; gap: 1ch; width: calc(100% - 2 * var(--term-gutter)); max-width: calc(var(--term-width) - 2 * var(--term-gutter));
  padding: 9px 10px 9px 14px; border: 1px solid var(--term-border); border-radius: 12px; background: var(--term-field); transition: border-color .15s; }
.term-input:focus-within { border-color: var(--ui-border-accented, var(--term-dim)); }
.term-caret { line-height: 23px; color: var(--term-dim); }
.term-input textarea { flex: 1; min-width: 0; height: 23px; min-height: 23px; max-height: 220px; padding: 0; field-sizing: content; resize: none;
  border: 0; outline: 0; background: none; color: var(--term-text); font: inherit; line-height: 23px; }
.term-input textarea::placeholder { color: var(--term-faint); font-size: var(--term-size); opacity: 1; }
.term-input textarea:disabled { color: var(--term-dim); }
/* A keyboard has Enter and Esc, as in the CLI, so the buttons show only on touch screens. */
.term-button { display: none; flex: none; place-items: center; width: 23px; height: 23px; border: 0; border-radius: 50%;
  background: var(--term-strong); color: var(--term-bg); font: inherit; font-size: 13px; font-weight: 700; cursor: pointer; }
.term-button:disabled { opacity: .2; cursor: default; }
.term-button.is-stop { background: var(--term-band); color: var(--term-red); }
.term-stop-square { width: 9px; height: 9px; border-radius: 2px; background: currentColor; }
.term-hint { min-height: 26px; padding: 4px calc(var(--term-gutter) + 2px) calc(10px + env(safe-area-inset-bottom)); color: var(--term-faint); font-size: 11.5px; line-height: 18px; }
.term-unread { position: absolute; right: max(20px, calc((100% - var(--term-width)) / 2 + 20px)); bottom: 10px; padding: 3px 12px; border: 1px solid var(--term-border); border-radius: 999px;
  background: var(--term-bg); color: var(--term-text); font: inherit; font-size: 12px; cursor: pointer; }
.term button { touch-action: manipulation; }
/* Touch: send and stop buttons with room to tap, and a 16px input so iOS does not zoom (its placeholder stays small). */
@media (pointer: coarse) {
  .term-button { display: grid; width: 32px; height: 32px; font-size: 15px; }
  .term-input { align-items: center; padding: 4px 4px 4px 12px; }
  .term-input textarea { font-size: 16px; }
  .term-tab { padding: 9px 14px; }
  .term-more { padding: 4px 0; }
}
@media (max-width: 640px) {
  .term { --term-size: 13px; --term-line: 22px; --term-gutter: 12px; }
  .term-screen { padding: 12px 0 8px; }
}
</style>

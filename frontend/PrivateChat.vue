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
import { computed, inject, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { adapter_capabilities } from "../runner/adapters/profiles.mjs";
import { ENTER_SENDS } from "./enter-sends.js";
import { private_chat } from "./private-chat.js";
import { PHASE_LABELS } from "./timeline-model.js";

const { view, bridge, act } = inject("discussion");
const POLL_MS = 2000;
const SHOWN_EXECUTIONS = 30;
// Output lines a step shows before folding to `… +N 行`, as the CLIs do.
const OUTPUT_LINES = 3;
const ACTIVE = ["dispatched", "started"];
// How each kind of step is named on its `●` line.
const STEP_NAMES = { command: "Bash", search: "Search", edit: "Update" };

const room = computed(() => view.value.room);
const members = computed(() => room.value?.free?.members || []);
const member = computed(() => members.value.find((item) => item.name === private_chat.member) || members.value[0] || null);
const name = computed(() => member.value?.name || "");
/** Why this member cannot take a private line here, or "" when it can. */
const unsupported = computed(() => !member.value ? "房间里还没有 AI 成员"
  : member.value.access !== "runner" ? "这位成员是手动接入的，请在它自己的窗口里对话"
    : !adapter_capabilities(member.value.adapter).chat ? "这位成员的接入方式看不到它的输出，暂不支持私聊窗" : "");

const chats = ref([]);
const details = ref(new Map());
// Why a turn's steps could not be read, by turn, shown in its place.
const errors = ref(new Map());
const open_output = ref(new Set());
const error = ref("");
const now = ref(Date.now() / 1000);
let timer = null;
// Whether the screen follows new output (false once the owner scrolls up to read).
let stick = true;
let serial = 0;

/** The room tasks this member ran and its chat lines, oldest first, as one session. */
const items = computed(() => {
  const executions = (room.value?.free?.executions || []).filter((item) => item.member === name.value)
    .sort((a, b) => a.id - b.id).slice(-SHOWN_EXECUTIONS);
  return [...executions.map((execution) => ({ key: `exec-${execution.id}`, at: execution.created_at, execution })),
    ...chats.value.map((chat) => ({ key: `chat-${chat.id}`, at: chat.created_at, chat }))].sort((a, b) => a.at - b.at);
});
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
 * Read the chat from the website, then the steps of every turn not read yet, newest first so the latest show soonest;
 * a running turn is read again each round.
 */
async function refresh() {
  clearTimeout(timer);
  const target = member.value, room_id = room.value?.id, current = ++serial;
  if (!target || !room_id) return;
  try {
    if (!unsupported.value || chats.value.length) chats.value = (await bridge.read_member_chat(room_id, target.id)).chats;
    error.value = "";
  } catch (failure) {
    if (current === serial) error.value = failure.message || "未能读取私聊";
  }
  const wanted = [...items.value].reverse().filter((item) => running(item) || (!details.value.has(item.key) && !errors.value.has(item.key)));
  for (const item of wanted) {
    try {
      const result = await bridge.read_execution_details(room_id, item.execution?.id, item.chat ? { chat_id: item.chat.id } : {});
      if (current !== serial) return;
      details.value = new Map(details.value).set(item.key, result);
    } catch (failure) {
      if (current !== serial) return;
      errors.value = new Map(errors.value).set(item.key, failure.message || "未能读取过程");
    }
  }
  if (current === serial) timer = setTimeout(refresh, POLL_MS);
}
// A string key: the room object is replaced on every refresh, and only another room or member starts the page over.
watch(() => `${room.value?.id}\n${name.value}`, () => {
  chats.value = []; details.value = new Map(); errors.value = new Map(); open_output.value = new Set(); stick = true; refresh();
}, { immediate: true });
const clock = setInterval(() => { now.value = Date.now() / 1000; }, 1000);
onBeforeUnmount(() => { serial++; clearTimeout(timer); clearInterval(clock); });

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
/** A turn's steps, without a remark that repeats its final reply. */
function steps_of(item) {
  const reply = reply_of(item)?.trim();
  return (details.value.get(item.key)?.entries || []).filter((entry) => !(reply && entry.kind === "message" && entry.body?.trim() === reply));
}
/** The `●` line of a tool step, named as the CLIs name it: Bash(…), Update(…), or the tool's own name. */
function step_line(entry) {
  if (STEP_NAMES[entry.kind]) return `${STEP_NAMES[entry.kind]}(${entry.title || ""})`;
  const [tool, ...rest] = String(entry.title || "tool").split(" ");
  return rest.length ? `${tool}(${rest.join(" ")})` : tool;
}
/** A step's output lines: the first few, or all of them once opened. */
function output_of(item, entry) {
  const lines = String(entry.body || "").replace(/\s+$/, "").split(/\r?\n/);
  const all = open_output.value.has(`${item.key}/${entry.id ?? entry.title}`);
  return { lines: all ? lines : lines.slice(0, OUTPUT_LINES), hidden: all ? 0 : Math.max(0, lines.length - OUTPUT_LINES) };
}
function open_step(item, entry) {
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

// The screen follows new output unless the owner scrolled up to read.
const screen = ref(null);
// Set when output arrives while the owner reads further up, so a button can bring the screen back to it.
const unread = ref(false);
function on_scroll() {
  const element = screen.value;
  stick = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
  if (stick) unread.value = false;
}
/** Jump to the newest output and follow it again. */
function to_bottom() {
  stick = true;
  unread.value = false;
  nextTick(() => { if (screen.value) screen.value.scrollTop = screen.value.scrollHeight; });
}
watch([items, details], () => { if (stick) to_bottom(); else unread.value = true; }, { deep: true });

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
    stick = true;
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
    <nav class="term-tabs" aria-label="成员">
      <button v-for="item in members" :key="item.id" type="button" class="term-tab" :class="{ 'is-current': item.name === name }"
        :aria-current="item.name === name" @click="private_chat.member = item.name">
        <span class="term-dot" :class="{ 'is-busy': ACTIVE.includes(item.execution?.status) }" />{{ bridge.display_name(item.name) }}
      </button>
    </nav>
    <div ref="screen" class="term-screen" @scroll="on_scroll">
      <p v-if="!items.length" class="term-dim">{{ unsupported || `和 ${bridge.display_name(name)} 私聊：它用房间里的同一个会话回答，其他成员看不到。` }}</p>
      <section v-for="item in items" :key="item.key" class="term-turn">
        <div v-if="prompt_of(item)" class="term-prompt">&gt; {{ prompt_of(item) }}</div>
        <div v-if="errors.get(item.key)" class="term-sub term-warn">⎿ 未能读取过程：{{ errors.get(item.key) }}</div>
        <div v-else-if="!details.has(item.key) && running(item)" class="term-sub">⎿ 正在读取…</div>
        <template v-for="(entry, index) in steps_of(item)" :key="entry.id ?? index">
          <div v-if="entry.kind === 'message'" class="term-line"><span class="term-bullet">●</span><span class="term-body">{{ entry.body }}</span></div>
          <div v-else-if="entry.kind === 'interjection'" class="term-prompt">&gt; {{ entry.body }}</div>
          <div v-else-if="entry.kind === 'thinking'" class="term-line term-dim"><span class="term-bullet">✻</span><span class="term-body">{{ entry.body }}</span></div>
          <div v-else-if="entry.kind === 'plan'" class="term-line"><span class="term-bullet">●</span><span class="term-body">Plan<span class="term-dim">{{ "\n" + entry.body }}</span></span></div>
          <div v-else-if="entry.kind === 'error'" class="term-line term-error"><span class="term-bullet">●</span><span class="term-body">{{ entry.body || entry.title }}</span></div>
          <template v-else>
            <div class="term-line"><span class="term-bullet" :class="`is-${entry.state || 'done'}`">●</span><span class="term-body term-tool">{{ step_line(entry) }}</span></div>
            <div v-if="entry.body" v-for="output in [output_of(item, entry)]" :key="'out'" class="term-sub" :class="{ 'term-error': entry.state === 'failed' }">
              <span class="term-corner">⎿</span><span class="term-body">{{ output.lines.join("\n") }}<button v-if="output.hidden" type="button" class="term-more" @click="open_step(item, entry)">{{ "\n" }}… +{{ output.hidden }} 行</button></span>
            </div>
          </template>
        </template>
        <div v-if="reply_of(item)" class="term-line"><span class="term-bullet">●</span><span class="term-body">{{ reply_of(item) }}</span></div>
        <div v-if="item.chat && chat_note(item.chat)" class="term-sub" :class="{ 'term-error': item.chat.status === 'failed' }"><span class="term-corner">⎿</span><span class="term-body">{{ chat_note(item.chat) }}</span></div>
      </section>
    </div>
    <button v-if="unread" type="button" class="term-unread" @click="to_bottom">↓ 新输出</button>
    <div class="term-status" role="status">
      <span v-if="running_item" class="term-spin">✻</span><span>{{ status_line }}</span><span v-if="error" class="term-warn"> · {{ error }}</span>
    </div>
    <div class="term-input">
      <span class="term-caret" aria-hidden="true">&gt;</span>
      <textarea v-model="draft" rows="1" :enterkeyhint="ENTER_SENDS ? 'send' : 'enter'" :disabled="Boolean(unsupported) || sending" :placeholder="unsupported || (running_item ? '插话引导它' : `对 ${bridge.display_name(name)} 说…`)"
        aria-label="私聊输入" maxlength="4000" @keydown.enter.exact="on_enter" @keydown.esc.prevent="interrupt"
        @keydown.up="recall($event, -1)" @keydown.down="recall($event, 1)" />
      <!-- Touch keyboards have no Esc and often no Enter that sends, so both keys also have buttons. -->
      <button v-if="running_item" type="button" class="term-button is-stop" aria-label="打断" title="打断（Esc）" @click="interrupt"><span class="term-stop-square" /></button>
      <button type="button" class="term-button" aria-label="发送" :title="ENTER_SENDS ? '发送（Enter）' : '发送'" :disabled="!draft.trim() || sending || Boolean(unsupported)" @click="send">↵</button>
    </div>
  </div>
</template>

<style scoped>
/* Laid out as a CLI prints it: one monospace stream, `>` prompts on a faint band, `●` lines, `⎿` output under a step. */
.term { position: relative; --term-font: ui-monospace, "Cascadia Mono", Consolas, "Microsoft YaHei Mono", monospace;
  --term-green: #4ade80; --term-red: #f87171; display: flex; flex-direction: column; height: calc(100dvh - 120px); min-height: 360px;
  font-family: var(--term-font); font-size: 13px; line-height: 1.55; background: var(--ui-bg); overflow: hidden; }
.term-tabs { display: flex; gap: 2px; padding: 4px 8px 0; border-bottom: 1px solid var(--ui-border); overflow-x: auto; scrollbar-width: none; scroll-snap-type: x proximity; }
.term-tab { display: flex; align-items: center; gap: 6px; padding: 4px 12px; border: 0; border-bottom: 2px solid transparent; scroll-snap-align: start;
  background: none; color: var(--ui-text-muted); font: inherit; cursor: pointer; white-space: nowrap; }
.term-tab.is-current { color: var(--ui-text-highlighted); border-bottom-color: var(--ui-text-highlighted); }
.term-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--ui-text-dimmed); flex: none; }
.term-dot.is-busy { background: var(--term-green); animation: term-pulse 1.2s ease-in-out infinite; }
@keyframes term-pulse { 50% { opacity: .35; } }
.term-screen { flex: 1; overflow-y: auto; padding: 10px 14px; display: flex; flex-direction: column; gap: 14px; overscroll-behavior: contain; }
.term-turn { display: flex; flex-direction: column; gap: 6px; }
.term-prompt { padding: 2px 6px; color: var(--ui-text-muted); background: var(--ui-bg-elevated); white-space: pre-wrap; overflow-wrap: anywhere; }
.term-line, .term-sub { display: grid; grid-template-columns: 2ch minmax(0, 1fr); column-gap: 1ch; }
.term-sub { padding-left: 2ch; color: var(--ui-text-muted); }
.term-body { white-space: pre-wrap; overflow-wrap: anywhere; color: var(--ui-text); }
.term-sub .term-body, .term-dim .term-body, .term-dim { color: var(--ui-text-muted); }
.term-tool { font-weight: 600; }
.term-bullet { color: var(--ui-text); }
.term-bullet.is-done { color: var(--term-green); }
.term-bullet.is-failed, .term-error .term-bullet, .term-error .term-body { color: var(--term-red); }
.term-bullet.is-running { color: var(--ui-text-muted); animation: term-pulse 1s ease-in-out infinite; }
.term-corner { color: var(--ui-text-dimmed); }
.term-warn { color: var(--ui-warning); }
.term-more { all: unset; cursor: pointer; color: var(--ui-text-dimmed); white-space: pre; }
.term-more:hover { color: var(--ui-text-muted); }
.term-status { display: flex; align-items: center; gap: 6px; padding: 2px 14px; color: var(--ui-text-muted); font-size: 12px; }
.term-spin { color: #f59e0b; animation: term-pulse 1.2s ease-in-out infinite; }
.term-input { display: flex; align-items: flex-end; gap: 8px; margin: 0 10px calc(8px + env(safe-area-inset-bottom)); padding: 6px 8px 6px 10px;
  border: 1px solid var(--ui-border-accented, var(--ui-border)); border-radius: 6px; }
.term-caret { padding-bottom: 4px; color: var(--ui-text-muted); }
.term-input textarea { flex: 1; min-width: 0; min-height: 22px; padding: 3px 0; max-height: 200px; field-sizing: content; resize: none; border: 0; outline: 0;
  background: none; color: var(--ui-text); font: inherit; }
.term-input textarea:disabled { color: var(--ui-text-muted); }
.term-button { flex: none; display: grid; place-items: center; width: 30px; height: 30px; border: 0; border-radius: 5px;
  background: var(--ui-bg-elevated); color: var(--ui-text); font: inherit; font-size: 15px; cursor: pointer; }
.term-button:disabled { opacity: .35; cursor: default; }
.term-button.is-stop { color: var(--term-red); }
.term-stop-square { width: 10px; height: 10px; border-radius: 2px; background: currentColor; }
.term-unread { position: absolute; right: 16px; bottom: 90px; padding: 3px 12px; border: 1px solid var(--ui-border); border-radius: 999px;
  background: var(--ui-bg-elevated); color: var(--ui-text); font: inherit; font-size: 12px; cursor: pointer; }
.term button { touch-action: manipulation; }
/* Touch: bigger targets for the send and stop keys, and a 16px input so iOS does not zoom. */
@media (pointer: coarse) {
  .term-button { width: 40px; height: 40px; }
  .term-input textarea { font-size: 16px; }
  .term-tab { padding: 8px 14px; }
  .term-more { padding: 4px 0; }
}
@media (max-width: 640px) { .term { height: calc(100dvh - 96px); } .term-screen { padding: 8px 10px; } }
</style>

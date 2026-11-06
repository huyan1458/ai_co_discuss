<script setup>
/**
 * Private chat, shown like a terminal session with one room member: the owner's lines and the member's replies (kept
 * by the website, owner only), the room tasks the same session ran, and each turn's process — remarks, commands with
 * their output, searches, edits — read from this computer's own log. Keys follow a local CLI: Enter sends, Shift+Enter
 * breaks the line, ↑/↓ recall earlier lines, Esc interrupts what is running. On phones and tablets, as in the message
 * composer, the return key breaks the line and the send and stop buttons do the rest. A line sent while the member works goes
 * into that turn as an interjection; otherwise it runs as the next turn of the member's session.
 */
import { computed, inject, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { adapter_capabilities } from "../runner/adapters/profiles.mjs";
import { ENTER_SENDS } from "./enter-sends.js";
import { private_chat } from "./private-chat.js";
import { PHASE_LABELS } from "./timeline-model.js";

const { view, bridge, act } = inject("discussion");
const POLL_MS = 2000;
const SHOWN_EXECUTIONS = 30;
const ACTIVE = ["dispatched", "started"];
const EXECUTION_LABELS = { dispatched: "进行中", started: "进行中", completed: "已完成", failed: "失败", cancelled: "已停止" };
const KIND_MARKS = { command: "$", search: "⌕", edit: "✎", tool: "⚙", plan: "☰", thinking: "…", error: "✗", interjection: "›" };

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
const open = ref(new Set());
const error = ref("");
const now = ref(Date.now() / 1000);
let timer = null;
let clock = null;
// Whether the screen follows new output (false once the owner scrolls up to read).
let stick = true;
let serial = 0;

/** The room tasks this member ran, oldest first, and its chat lines, in one time order. */
const items = computed(() => {
  const executions = (room.value?.free?.executions || []).filter((item) => item.member === name.value)
    .sort((a, b) => a.id - b.id).slice(-SHOWN_EXECUTIONS);
  return [...executions.map((execution) => ({ key: `exec-${execution.id}`, at: execution.created_at, execution })),
    ...chats.value.map((chat) => ({ key: `chat-${chat.id}`, at: chat.created_at, chat }))].sort((a, b) => a.at - b.at);
});
const running_item = computed(() => [...items.value].reverse().find((item) => item.chat ? ["pending", "running"].includes(item.chat.status)
  : ACTIVE.includes(item.execution.status)) || null);
const running = (item) => item.chat ? item.chat.status === "running" : ACTIVE.includes(item.execution.status);
const status_line = computed(() => {
  const item = running_item.value;
  if (!item) return `${bridge.display_name(name.value)} · 空闲`;
  if (item.chat?.status === "pending") return `${bridge.display_name(name.value)} · 等它空闲后处理${ENTER_SENDS ? " · Esc 撤回" : ""}`;
  const started = item.chat ? item.chat.updated_at : item.execution.created_at;
  const phase = item.execution && member.value?.execution?.id === item.execution.id && member.value.execution.activity
    ? `${PHASE_LABELS[member.value.execution.activity] || "处理"}中` : "处理中";
  return `${bridge.display_name(name.value)} · ${item.execution ? `房间任务 #${item.execution.id} · ` : ""}${phase} · ${elapsed(now.value - started)}${ENTER_SENDS ? " · Esc 打断" : ""}`;
});

/** `m:ss` or `h:mm:ss`. */
function elapsed(seconds) {
  const value = Math.max(0, Math.floor(seconds));
  const pad = (part) => String(part).padStart(2, "0");
  return value >= 3600 ? `${Math.floor(value / 3600)}:${pad(Math.floor(value / 60) % 60)}:${pad(value % 60)}` : `${Math.floor(value / 60)}:${pad(value % 60)}`;
}

/** Read the chat from the website and the process of each running or opened turn from this computer. */
async function refresh() {
  clearTimeout(timer);
  const target = member.value, room_id = room.value?.id, current = ++serial;
  if (!target || !room_id) return;
  try {
    if (!unsupported.value || chats.value.length) chats.value = (await bridge.read_member_chat(room_id, target.id)).chats;
    const wanted = items.value.filter((item) => running(item) || (open.value.has(item.key) && !details.value.has(item.key)));
    for (const item of wanted) {
      const result = await bridge.read_execution_details(room_id, item.execution?.id, item.chat ? { chat_id: item.chat.id } : {});
      if (current !== serial) return;
      details.value = new Map(details.value).set(item.key, result);
    }
    error.value = "";
  } catch (failure) {
    if (current === serial) error.value = failure.message || "未能读取私聊";
  }
  if (current === serial) timer = setTimeout(refresh, POLL_MS);
}
watch(() => [room.value?.id, name.value], () => { chats.value = []; details.value = new Map(); open.value = new Set(); stick = true; refresh(); }, { immediate: true });
clock = setInterval(() => { now.value = Date.now() / 1000; }, 1000);
onBeforeUnmount(() => { serial++; clearTimeout(timer); clearInterval(clock); });

/** Show or hide one turn's process; a finished turn's log is read when first opened. */
function toggle(item) {
  const next = new Set(open.value);
  next.has(item.key) ? next.delete(item.key) : next.add(item.key);
  open.value = next;
  refresh();
}
/** A turn's process lines, without the remark that is already shown as its reply. */
function process_of(item) {
  const entries = details.value.get(item.key)?.entries || [];
  return item.chat?.reply ? entries.filter((entry) => !(entry.kind === "message" && entry.body?.trim() === item.chat.reply.trim())) : entries;
}
const shown = (item) => running(item) || open.value.has(item.key);
const open_output = ref(new Set());
function toggle_output(key) {
  const next = new Set(open_output.value);
  next.has(key) ? next.delete(key) : next.add(key);
  open_output.value = next;
}
/** What happened to a line, when it is not simply answered. */
function chat_note(chat) {
  if (chat.status === "interjected") {
    const state = { pending: "待送达", delivered: "已送达", failed: "未送达" }[chat.interjection] || "已发出";
    return `↳ 作为插话进入房间任务 #${chat.execution_id}：${state}${chat.reason ? `，${chat.reason}` : ""}`;
  }
  if (chat.status === "pending") return "… 排队中，等它空闲后处理";
  if (chat.status === "stopped") return "✗ 已撤回";
  if (chat.status === "failed") return `✗ ${chat.reason || "未完成"}`;
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
        <template v-if="item.chat">
          <div class="term-user">› {{ item.chat.text }}</div>
          <button v-if="!running(item) && item.chat.status === 'answered'" type="button" class="term-dim term-link" @click="toggle(item)">{{ open.has(item.key) ? "  ▾ 收起过程" : "  ▸ 过程" }}</button>
        </template>
        <button v-else type="button" class="term-rule" @click="toggle(item)">── 房间任务 #{{ item.execution.id }} · {{ EXECUTION_LABELS[item.execution.status] || item.execution.status }} {{ shown(item) ? "▾" : "▸" }}</button>
        <template v-if="shown(item)">
          <p v-if="details.get(item.key) && !details.get(item.key).available" class="term-dim">  这一轮没有本机过程记录</p>
          <template v-for="entry in process_of(item)" :key="entry.id">
            <div v-if="entry.kind === 'message'" class="term-text">{{ entry.body }}</div>
            <div v-else-if="entry.kind === 'interjection'" class="term-user">› {{ entry.body }}</div>
            <div v-else-if="['thinking', 'plan', 'error'].includes(entry.kind)" :class="entry.kind === 'error' ? 'term-warn' : 'term-dim'">{{ KIND_MARKS[entry.kind] }} {{ entry.body }}</div>
            <template v-else>
              <button type="button" class="term-step" :class="`is-${entry.state}`" :disabled="!entry.body" @click="toggle_output(`${item.key}/${entry.id}`)">
                {{ KIND_MARKS[entry.kind] }} {{ entry.title }}<span v-if="entry.state === 'running'"> …</span><span v-else-if="entry.state === 'failed'"> ✗</span>
              </button>
              <pre v-if="open_output.has(`${item.key}/${entry.id}`)" class="term-output">{{ entry.body }}</pre>
            </template>
          </template>
        </template>
        <div v-if="item.chat?.reply" class="term-text">{{ item.chat.reply }}</div>
        <div v-if="item.chat && chat_note(item.chat)" class="term-dim" :class="{ 'term-warn': ['failed'].includes(item.chat.status) }">{{ chat_note(item.chat) }}</div>
      </section>
    </div>
    <button v-if="unread" type="button" class="term-unread" @click="to_bottom">↓ 新输出</button>
    <div class="term-status" role="status"><span class="term-dot" :class="{ 'is-busy': running_item }" />{{ status_line }}<span v-if="error" class="term-warn"> · {{ error }}</span></div>
    <div class="term-input">
      <span aria-hidden="true">›</span>
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
.term { position: relative; --term-font: ui-monospace, "Cascadia Mono", Consolas, "Microsoft YaHei Mono", monospace; display: flex; flex-direction: column;
  height: calc(100dvh - 120px); min-height: 360px; font-family: var(--term-font); font-size: 13px; line-height: 1.6;
  border: 1px solid var(--ui-border); border-radius: 8px; background: var(--ui-bg); overflow: hidden; }
.term-tabs { display: flex; gap: 2px; padding: 6px 8px 0; border-bottom: 1px solid var(--ui-border); overflow-x: auto; }
.term-tab { display: flex; align-items: center; gap: 6px; padding: 4px 12px; border: 0; border-bottom: 2px solid transparent;
  background: none; color: var(--ui-text-muted); font: inherit; cursor: pointer; white-space: nowrap; }
.term-tab.is-current { color: var(--ui-text-highlighted); border-bottom-color: var(--ui-primary); }
.term-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--ui-text-dimmed); flex: none; }
.term-dot.is-busy { background: var(--ui-primary); animation: term-pulse 1.2s ease-in-out infinite; }
@keyframes term-pulse { 50% { opacity: .35; } }
.term-screen { flex: 1; overflow-y: auto; padding: 12px 16px; display: flex; flex-direction: column; gap: 10px; }
.term-turn { display: flex; flex-direction: column; gap: 2px; }
.term-user { color: var(--ui-primary); white-space: pre-wrap; overflow-wrap: anywhere; }
.term-text { color: var(--ui-text); white-space: pre-wrap; overflow-wrap: anywhere; }
.term-dim { margin: 0; color: var(--ui-text-muted); white-space: pre-wrap; overflow-wrap: anywhere; }
.term-warn { color: var(--ui-warning); }
.term-link, .term-rule, .term-step { all: unset; cursor: pointer; white-space: pre-wrap; overflow-wrap: anywhere; }
.term-rule { color: var(--ui-text-muted); }
.term-step { color: var(--ui-text-toned); }
.term-step:disabled { cursor: default; }
.term-step.is-failed { color: var(--ui-warning); }
.term-step.is-running { color: var(--ui-primary); }
.term-output { margin: 2px 0 4px 16px; padding: 6px 10px; max-height: 280px; overflow: auto; font: inherit; font-size: 12px;
  white-space: pre-wrap; overflow-wrap: anywhere; color: var(--ui-text-muted); background: var(--ui-bg-elevated); border-radius: 4px; }
.term-status { display: flex; align-items: center; gap: 8px; padding: 4px 16px; color: var(--ui-text-muted); font-size: 12px;
  border-top: 1px solid var(--ui-border); }
.term-input { display: flex; align-items: flex-end; gap: 8px; padding: 8px 12px calc(10px + env(safe-area-inset-bottom)) 16px; color: var(--ui-primary); }
.term-input > span { padding-bottom: 5px; }
.term-button { flex: none; display: grid; place-items: center; width: 32px; height: 32px; border: 1px solid var(--ui-border); border-radius: 6px;
  background: var(--ui-bg-elevated); color: var(--ui-text); font: inherit; font-size: 15px; cursor: pointer; }
.term-button:disabled { opacity: .4; cursor: default; }
.term-button.is-stop { color: var(--ui-error); }
.term-stop-square { width: 10px; height: 10px; border-radius: 2px; background: currentColor; }
.term-unread { position: absolute; right: 16px; bottom: 96px; padding: 4px 12px; border: 1px solid var(--ui-border); border-radius: 999px;
  background: var(--ui-bg-elevated); color: var(--ui-text); font: inherit; font-size: 12px; cursor: pointer; box-shadow: 0 2px 8px rgb(0 0 0 / .25); }
.term-tabs { scrollbar-width: none; scroll-snap-type: x proximity; }
.term-tab { scroll-snap-align: start; }
.term button { touch-action: manipulation; }
/* Touch: bigger targets for the send and stop keys and for every line that opens, and a 16px input so iOS does not zoom. */
@media (pointer: coarse) {
  .term-button { width: 40px; height: 40px; }
  .term-input textarea { font-size: 16px; }
  .term-tab { padding: 8px 14px; }
  .term-step, .term-rule, .term-link { padding: 4px 0; }
  .term-screen { gap: 14px; -webkit-overflow-scrolling: touch; overscroll-behavior: contain; }
}
.term-input textarea { flex: 1; min-width: 0; min-height: 22px; padding: 5px 0; max-height: 200px; field-sizing: content; resize: none; border: 0; outline: 0;
  background: none; color: var(--ui-text); font: inherit; }
.term-input textarea:disabled { color: var(--ui-text-muted); }
@media (max-width: 640px) { .term { height: calc(100dvh - 96px); border-radius: 0; border-left: 0; border-right: 0; } }
</style>

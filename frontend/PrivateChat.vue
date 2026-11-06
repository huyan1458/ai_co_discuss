<script setup>
/**
 * Private chat: one page per room member, showing what it did in one execution as it happens — its remarks, commands
 * with their output, searches, edits and tool calls — read from this computer's own log (never the website); while it
 * runs, the owner can interject into that turn when its delivery says it can take one.
 */
import { computed, inject, onBeforeUnmount, ref, watch } from "vue";
import WorkingText from "./WorkingText.vue";
import { private_chat } from "./private-chat.js";
import { PHASE_LABELS } from "./timeline-model.js";

const { view, bridge } = inject("discussion");
// A running execution's log is read again this often; a finished one is read once.
const POLL_MS = 2000;
const ACTIVE = ["dispatched", "started"];
const STATUS_LABELS = { dispatched: "进行中", started: "进行中", completed: "已完成", failed: "失败", cancelled: "已停止" };
const KIND_ICONS = { message: "i-lucide-message-square-text", command: "i-lucide-square-terminal", search: "i-lucide-search",
  edit: "i-lucide-file-pen-line", tool: "i-lucide-wrench", plan: "i-lucide-list-checks", thinking: "i-lucide-brain", error: "i-lucide-circle-alert",
  interjection: "i-lucide-user-round" };
const INTERJECTION_LABELS = { pending: "待送达", delivered: "已送达", failed: "未送达" };
// The common ask while an agent is slow, one click away; the text lands in the box to edit before sending.
const QUICK_REPLIES = ["直接给结论，别再展开", "精简到 300 字以内", "别再查资料，用已有信息收尾"];
const STATE_LABELS = { running: "进行中", failed: "失败" };

const room = computed(() => view.value.room);
const members = computed(() => room.value?.free?.members || []);
const tabs = computed(() => members.value.map((member) => ({ value: member.name, label: bridge.display_name(member.name),
  icon: ACTIVE.includes(member.execution?.status) ? "i-lucide-loader-circle" : undefined })));
const selected_member = computed({
  get: () => members.value.some((member) => member.name === private_chat.member) ? private_chat.member : members.value[0]?.name || "",
  set: (name) => { private_chat.member = name; private_chat.execution_id = null; },
});
/** The member's recent executions, newest first, including its latest one when the room's recent list has moved past it. */
const executions = computed(() => {
  const member = members.value.find((item) => item.name === selected_member.value);
  const list = (room.value?.free?.executions || []).filter((item) => item.member === selected_member.value);
  if (member?.execution && !list.some((item) => item.id === member.execution.id)) list.push(member.execution);
  return list.sort((a, b) => b.id - a.id);
});
const execution = computed(() => executions.value.find((item) => item.id === private_chat.execution_id) || executions.value[0] || null);
const running = computed(() => ACTIVE.includes(execution.value?.status));
const execution_options = computed(() => executions.value.map((item) => ({ value: item.id, label: execution_label(item) })));
const selected_execution = computed({ get: () => execution.value?.id ?? null, set: (id) => { private_chat.execution_id = id; } });
const phase = computed(() => {
  const latest = members.value.find((item) => item.name === selected_member.value)?.execution;
  return latest?.id === execution.value?.id && latest.activity ? `${PHASE_LABELS[latest.activity] || "处理"}中` : "处理中";
});

const details = ref(null);
const error = ref("");
const open_entries = ref(new Set());
let timer = null;
let request_serial = 0;

/** One line naming an execution in the picker: its number, state and start time. */
function execution_label(item) {
  const started = item.created_at ? new Date(item.created_at * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  return `#${item.id} · ${STATUS_LABELS[item.status] || item.status}${started ? ` · ${started}` : ""}`;
}

/** Read the shown execution's details; a running one is read again until it ends. */
async function load() {
  clearTimeout(timer);
  const target = execution.value;
  if (!target || !room.value) return;
  const serial = ++request_serial;
  try {
    const result = await bridge.read_execution_details(room.value.id, target.id);
    if (serial !== request_serial) return;
    details.value = result;
    error.value = "";
  } catch (failure) {
    if (serial === request_serial) error.value = failure.message || "未能读取执行过程";
  }
  if (serial === request_serial && ACTIVE.includes(execution.value?.status)) timer = setTimeout(load, POLL_MS);
}
watch(() => [room.value?.id, execution.value?.id], () => { details.value = null; error.value = ""; open_entries.value = new Set(); load(); }, { immediate: true });
// The final read after it ends catches the last command and the answer written just before.
watch(running, (now, before) => { if (before && !now) load(); });
onBeforeUnmount(() => { request_serial++; clearTimeout(timer); });

/** Fold or unfold one entry's body (a command's output, a tool's result). */
function toggle(id) {
  const next = new Set(open_entries.value);
  next.has(id) ? next.delete(id) : next.add(id);
  open_entries.value = next;
}
/** Remarks, plans and the owner's interjections read as text; commands, edits and tool calls show their body only when opened. */
const inline = (entry) => ["message", "thinking", "plan", "error", "interjection"].includes(entry.kind);

const draft = ref("");
const sending = ref(false);
const send_error = ref("");
let submission_id = "";
const can_steer = computed(() => running.value && Boolean(execution.value?.capabilities?.steer));
const steer_hint = computed(() => !running.value ? "这次执行已结束；插话只能发给进行中的执行"
  : "这次投递不支持执行中插话，可停止后带上这句话重问");
const interjections = computed(() => execution.value?.interjections || []);
// Where the log shows them in place, only the ones not yet in the turn are listed here.
const listed = computed(() => details.value?.available ? interjections.value.filter((item) => item.status !== "delivered") : interjections.value);
watch(() => execution.value?.id, () => { draft.value = ""; send_error.value = ""; submission_id = ""; });

/** Send the draft as an interjection; a failed send keeps the text and its submission id for the retry. */
async function send() {
  const text = draft.value.trim();
  if (!text || sending.value || !execution.value) return;
  submission_id ||= crypto.randomUUID();
  sending.value = true;
  try {
    await bridge.interject_execution(execution.value.id, text, submission_id);
    draft.value = "";
    submission_id = "";
    send_error.value = "";
  } catch (failure) {
    send_error.value = failure.message || "插话未能发出";
  } finally { sending.value = false; }
}
</script>

<template>
  <div class="private-chat" role="tabpanel" aria-label="私聊">
    <p v-if="!members.length" class="private-chat-empty" role="status">房间里还没有 AI 成员</p>
    <template v-else>
      <div class="private-chat-head">
        <UTabs v-model="selected_member" :items="tabs" :content="false" variant="link" color="neutral" size="sm" class="private-chat-tabs" aria-label="成员" />
        <USelect v-if="execution_options.length" v-model="selected_execution" :items="execution_options" size="sm" class="private-chat-picker" aria-label="选择执行" />
      </div>
      <p v-if="!execution" class="private-chat-empty" role="status">{{ bridge.display_name(selected_member) }} 还没有执行记录</p>
      <p v-else-if="error" class="private-chat-empty" role="status">{{ error }}</p>
      <p v-else-if="!details" class="private-chat-empty" role="status">正在读取…</p>
      <p v-else-if="!details.available" class="private-chat-empty" role="status">这次执行没有本机过程记录：App、手动启动和 API 成员的过程不经这台电脑的日志，可在原窗口查看。</p>
      <ol v-else class="private-chat-log" :aria-label="`${bridge.display_name(selected_member)} 执行 #${execution.id} 的过程`">
        <li v-if="details.total > details.entries.length" class="private-chat-more">更早的 {{ details.total - details.entries.length }} 项未显示</li>
        <li v-for="entry in details.entries" :key="entry.id" class="private-chat-entry" :class="[`is-${entry.kind}`, entry.state && `is-${entry.state}`]">
          <UIcon :name="KIND_ICONS[entry.kind] || 'i-lucide-dot'" class="private-chat-icon" />
          <div class="private-chat-main">
            <p v-if="inline(entry)" class="private-chat-text">{{ entry.body }}</p>
            <template v-else>
              <button type="button" class="private-chat-title" :aria-expanded="open_entries.has(entry.id)" :disabled="!entry.body" :title="entry.title" @click="toggle(entry.id)">
                <span>{{ entry.title || entry.kind }}</span>
                <small v-if="STATE_LABELS[entry.state]">{{ STATE_LABELS[entry.state] }}</small>
                <UIcon v-if="entry.body" :name="open_entries.has(entry.id) ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" />
              </button>
              <pre v-if="open_entries.has(entry.id)" class="private-chat-output">{{ entry.body }}</pre>
            </template>
            <small v-if="entry.truncated" class="private-chat-cut">只显示前 4000 字</small>
          </div>
        </li>
        <li v-if="running" class="private-chat-entry is-live"><UIcon name="i-lucide-loader-circle" class="private-chat-icon" /><WorkingText :text="phase" :seed="selected_member" dots /></li>
        <li v-else-if="!details.entries.length" class="private-chat-more">这次执行没有记录到过程</li>
      </ol>
      <form v-if="execution && view.access?.can_manage" class="private-chat-composer" @submit.prevent="send">
        <ul v-if="listed.length" class="private-chat-interjections" aria-label="插话">
          <li v-for="item in listed" :key="item.id" :class="`is-${item.status}`"><span>你：{{ item.text }}</span><small>{{ INTERJECTION_LABELS[item.status] }}{{ item.reason ? `：${item.reason}` : "" }}</small></li>
        </ul>
        <template v-if="can_steer">
          <div class="private-chat-quick"><UButton v-for="text in QUICK_REPLIES" :key="text" :label="text" size="xs" color="neutral" variant="outline" @click="draft = text" /></div>
          <UTextarea v-model="draft" :rows="2" autoresize :maxlength="2000" class="w-full" :placeholder="`插话引导 ${bridge.display_name(selected_member)}…（Enter 发送，Shift+Enter 换行）`" aria-label="插话" @keydown.enter.exact.prevent="send" />
          <div class="private-chat-send"><small>会进入它正在进行的这一轮，在它的下一步生效；一段不调用工具的长思考或长输出要等它写完</small><UButton type="submit" label="发送" size="sm" :loading="sending" :disabled="!draft.trim()" /></div>
          <p v-if="send_error" class="private-chat-error" role="status">{{ send_error }}</p>
        </template>
        <p v-else class="private-chat-empty" role="status">{{ steer_hint }}</p>
      </form>
    </template>
  </div>
</template>

<style scoped>
.private-chat { display: flex; flex-direction: column; gap: 12px; max-width: 920px; margin: 0 auto; width: 100%; }
.private-chat-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.private-chat-tabs { flex: 1 1 auto; min-width: 0; }
.private-chat-picker { width: 220px; }
.private-chat-empty, .private-chat-more { color: var(--ui-text-muted); font-size: 13px; }
.private-chat-log { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.private-chat-entry { display: grid; grid-template-columns: 18px minmax(0, 1fr); gap: 8px; align-items: start; }
.private-chat-icon { margin-top: 3px; color: var(--ui-text-muted); }
.private-chat-main { min-width: 0; }
.private-chat-text { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.6; }
.is-thinking .private-chat-text { color: var(--ui-text-muted); font-style: italic; }
.is-error .private-chat-text, .is-error .private-chat-icon { color: var(--ui-error); }
.private-chat-title { display: flex; align-items: center; gap: 8px; width: 100%; padding: 2px 0; text-align: left; color: var(--ui-text); background: none; border: 0; cursor: pointer; }
.private-chat-title:disabled { cursor: default; }
.private-chat-title > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-mono, ui-monospace, monospace); font-size: 12.5px; }
.private-chat-title small { flex: none; font-size: 11px; color: var(--ui-text-muted); }
.is-failed .private-chat-title small, .is-failed .private-chat-icon { color: var(--ui-error); }
.is-running .private-chat-icon { color: var(--ui-primary); }
.private-chat-output { margin: 4px 0 2px; padding: 8px 10px; max-height: 320px; overflow: auto; font-size: 12px; line-height: 1.5;
  white-space: pre-wrap; overflow-wrap: anywhere; border-radius: 6px; background: var(--ui-bg-elevated); }
.private-chat-cut { color: var(--ui-text-muted); font-size: 11px; }
.is-live { color: var(--ui-text-muted); }
.is-interjection .private-chat-text { padding: 4px 10px; border-left: 2px solid var(--ui-primary); background: var(--ui-bg-elevated); border-radius: 0 6px 6px 0; }
.is-interjection .private-chat-text::before { content: "你："; color: var(--ui-text-muted); }
.private-chat-composer { position: sticky; bottom: 0; display: flex; flex-direction: column; gap: 8px; padding: 10px 0 4px; background: var(--ui-bg); border-top: 1px solid var(--ui-border); }
.private-chat-interjections { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; font-size: 13px; }
.private-chat-interjections li { display: flex; justify-content: space-between; gap: 12px; }
.private-chat-interjections span { min-width: 0; overflow-wrap: anywhere; }
.private-chat-interjections small { flex: none; color: var(--ui-text-muted); }
.private-chat-interjections .is-failed small { color: var(--ui-warning); }
.private-chat-quick { display: flex; flex-wrap: wrap; gap: 6px; }
.private-chat-send { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.private-chat-send small { color: var(--ui-text-muted); font-size: 12px; }
.private-chat-error { margin: 0; color: var(--ui-error); font-size: 13px; }
@media (max-width: 640px) { .private-chat-picker { width: 100%; } }
</style>

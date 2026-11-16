<script setup>
/**
 * The middle of an invited room: only what this computer's AI was asked there and what it answered, never the rest of
 * the other room. Built from `invited-room`: the record's own history (woken, refused, timed out, failed…), the requests
 * waiting for you, and, when the other computer is reachable, the texts of those requests and of this AI's answers.
 */
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { use_invited_rooms, time_ms } from "./external-members.js";
import { t } from "./i18n.js";

const invited = use_invited_rooms();
const record = invited.selected;
const room = ref(null), error = ref(""), loading = ref(false), failure = ref("");
const REFRESH_MS = 5000;
const OUTCOMES = {
  waiting: [t("等你同意"), "warning"], woken: [t("已唤醒"), "info"], completed: [t("已回答"), "success"],
  refused: [t("你未同意"), "neutral"], timeout: [t("超时未确认"), "neutral"], limit: [t("已达借用上限，改为等你同意"), "warning"],
  lockdown_unsupported: [t("这个软件不能限制为只用共议命令，未启动"), "error"], failed: [t("失败"), "error"], running: [t("处理中"), "info"],
};
let version = 0;
async function load(quiet = false) {
  const id = invited.selected_id.value;
  if (!id) return;
  const request = ++version;
  if (!quiet) loading.value = true;
  try {
    const result = await invited.read_room(id);
    if (request !== version) return;
    room.value = result.room || null;
    error.value = result.error || "";
    failure.value = "";
  } catch (problem) { if (request === version) failure.value = problem.message; }
  finally { if (request === version) loading.value = false; }
}
watch(() => invited.selected_id.value, () => { room.value = null; load(); }, { immediate: true });
const timer = setInterval(() => load(true), REFRESH_MS);
onBeforeUnmount(() => clearInterval(timer));

// Message texts the other room let this AI read, by number; only its requests and its own answers are shown.
const messages = computed(() => new Map((room.value?.messages || []).map((message) => [message.id, message])));
/** Requests (waiting, then the history newest first), each with the texts it names and this AI's answer. */
const items = computed(() => {
  const value = record.value;
  if (!value) return [];
  const answers = (room.value?.messages || []).filter((message) => message.author === value.member);
  const entry = (key, at, outcome, message_ids, extra = {}) => {
    const requests = (message_ids || []).map((id) => messages.value.get(id)).filter(Boolean);
    const after = Math.max(0, ...(message_ids || []));
    const answer = outcome === "completed" ? answers.find((message) => message.id > after) : null;
    return { key, at, outcome, message_ids: message_ids || [], requests, answer, ...extra };
  };
  const waiting = (value.approvals || []).map((approval) => entry(`a${approval.id}`, approval.received_at, "waiting", approval.message_ids, { by: approval.created_by }));
  const running = value.running ? [entry(`r${value.running.execution_id}`, value.running.started_at, "running", [])] : [];
  const history = [...(value.history || [])].reverse().map((item, index) => entry(`h${index}`, item.at, item.outcome, item.message_ids, { reason: item.reason }));
  return [...waiting, ...running, ...history];
});
const date = (value) => value ? new Date(time_ms(value)).toLocaleString([], { hour12: false }) : "";
const outcome_of = (item) => OUTCOMES[item.outcome] || [item.outcome || "", "neutral"];
const BY = { user: t("对方房主"), host: t("对方主持人") };
</script>

<template>
  <div v-keep-reading class="content-page invited-page" :aria-label="t('被邀请的房间')">
    <p class="invited-scope">{{ t("这里只显示房间「{room}」里点名给你的 AI 的请求和它的回答。", { room: record?.room_title || "" }) }}</p>
    <p v-if="error" class="invited-offline" role="status">{{ t("暂时读不到对方房间：{reason}。下面是这台电脑记下的处理结果。", { reason: error }) }}</p>
    <div v-if="loading && !items.length" role="status"><USkeleton v-for="row in 3" :key="row" class="invited-skeleton" /></div>
    <p v-else-if="failure" class="invited-empty" role="alert">{{ failure }} <UButton :label="t('重试')" size="xs" color="neutral" variant="link" @click="load()" /></p>
    <p v-else-if="!items.length" class="invited-empty">{{ t("还没有人点名你的 AI。") }}</p>
    <ol v-else class="invited-items">
      <li v-for="item in items" :key="item.key" class="invited-item">
        <article class="invited-request">
          <header>
            <strong>{{ BY[item.by] || (item.message_ids.length ? item.message_ids.map((id) => `#${id}`).join(" ") : t("对方")) }}</strong>
            <small>{{ date(item.at) }}</small>
            <UBadge :color="outcome_of(item)[1]" variant="subtle" size="sm">{{ outcome_of(item)[0] }}</UBadge>
          </header>
          <p v-for="message in item.requests" :key="message.id" class="invited-text">{{ message.text }}</p>
          <p v-if="item.reason" class="invited-reason">{{ item.reason }}</p>
        </article>
        <article v-if="item.answer" class="invited-answer">
          <header><strong>{{ record?.member_label || record?.member || t("你的 AI") }}</strong><small>#{{ item.answer.id }}</small></header>
          <p class="invited-text">{{ item.answer.text }}</p>
        </article>
      </li>
    </ol>
  </div>
</template>

<style scoped>
.invited-page { display: flex; flex-direction: column; gap: 12px; }
.invited-scope { margin: 0; color: var(--ui-text-muted); font-size: 12px; }
.invited-offline { margin: 0; color: var(--ui-warning, #e0a33a); font-size: 12px; }
.invited-skeleton { height: 64px; margin-bottom: 8px; }
.invited-empty { margin: 0; padding: 18px 12px; border: 1px dashed var(--ui-border); border-radius: 8px; text-align: center; color: var(--ui-text-muted); font-size: 12px; }
.invited-items { display: flex; flex-direction: column; gap: 16px; margin: 0; padding: 0; list-style: none; }
.invited-item { display: flex; flex-direction: column; gap: 6px; }
.invited-request, .invited-answer { padding: 10px 12px; border: 1px solid var(--ui-border-muted); border-radius: 10px; }
.invited-answer { margin-left: 24px; background: color-mix(in srgb, var(--ui-bg-elevated) 45%, var(--ui-bg)); }
.invited-item header { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 4px; font-size: 12px; }
.invited-item header strong { color: var(--ui-text-highlighted); }
.invited-item header small { color: var(--ui-text-muted); }
.invited-text { margin: 0; font-size: 13px; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; }
.invited-reason { margin: 4px 0 0; color: var(--ui-text-muted); font-size: 12px; }
@media (max-width: 480px) { .invited-answer { margin-left: 12px; } }
</style>

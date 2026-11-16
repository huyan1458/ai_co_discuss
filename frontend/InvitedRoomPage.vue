<script setup>
/**
 * The middle of an invited room: only what this computer's AI was asked there and what it answered, never the rest of
 * the other room. Built from `invited-room`: the record's own history (woken, refused, timed out, failed…), the requests
 * waiting for you, and, when the other computer is reachable, the texts of those requests and of this AI's answers,
 * each answer under the request it answers (`invited_items`). An ended record keeps all of this readable.
 */
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { invited_items, runner_message, use_invited_rooms, time_ms } from "./external-members.js";
import { t } from "./i18n.js";

const invited = use_invited_rooms();
const record = invited.selected;
const messages = ref([]), error = ref(""), loading = ref(false), failure = ref("");
const REFRESH_MS = 5000;
const OUTCOMES = {
  waiting: [t("等你同意"), "warning"], running: [t("处理中"), "info"], answered: [t("已回答"), "success"],
  finished: [t("已结束，未回答"), "neutral"], failed: [t("失败"), "error"], refused: [t("你未同意"), "neutral"],
  timeout: [t("超时未确认"), "neutral"], limit: [t("已达借用上限，改为等你同意"), "warning"],
  lockdown_unsupported: [t("这个软件不能限制为只用共议命令，未启动"), "error"], ai_unavailable: [t("这台电脑没有可用的 AI 程序，未启动"), "error"],
  ended: [t("成员资格已结束"), "neutral"],
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
    // Kept from the last read while the other computer cannot be reached, so the answers do not vanish.
    // The top-level `messages`: the other room's, or the texts this computer kept when it cannot be reached. An empty
    // answer during an outage keeps what was last shown rather than blanking the page.
    if (!result.error || result.messages?.length) messages.value = result.messages || [];
    if (result.room?.me) invited.room_me.value = { ...invited.room_me.value, [id]: result.room.me };
    error.value = runner_message(result.error_text, result.error || "");
    failure.value = "";
  } catch (problem) { if (request === version) failure.value = runner_message(null, problem.message); }
  finally { if (request === version) loading.value = false; }
}
watch(() => invited.selected_id.value, () => { messages.value = []; load(); }, { immediate: true });
const timer = setInterval(() => { if (!record.value?.status || record.value.status === "active") load(true); }, REFRESH_MS);
onBeforeUnmount(() => clearInterval(timer));

const items = computed(() => invited_items(record.value, messages.value));
const ai_name = computed(() => record.value?.member_label || record.value?.member || t("你的 AI"));
const date = (value) => value ? new Date(time_ms(value)).toLocaleString([], { hour12: false }) : "";
const outcome_of = (item) => OUTCOMES[item.outcome] || [item.outcome || "", "neutral"];
const BY = { user: t("对方房主"), host: t("对方主持人") };
// The other room's owner writes as "用户" there; here that reads as its owner, in the page language.
const OWNER_AUTHOR = "用户";
const author = (message) => message.author === OWNER_AUTHOR ? BY.user : message.author_label || message.author;
/**
 * Who a card speaks for: the people who asked when their messages are known, who named the AI while it waits, else
 * the AI itself, since what is left (a run that failed, a refusal by the software) is this computer's own result.
 */
function heading(item) {
  if (item.requests.length) return [...new Set(item.requests.map(author))].join(t("、"));
  if (item.by) return BY[item.by] || t("对方");
  return item.message_ids.length ? item.message_ids.map((id) => `#${id}`).join(" ") : ai_name.value;
}
</script>

<template>
  <div v-keep-reading class="content-page invited-page" role="region" :aria-label="t('被邀请的房间')">
    <p class="invited-scope">{{ t("这里只显示房间「{room}」里点名给你的 AI 的请求和它的回答。", { room: record?.room_title || "" }) }}</p>
    <p v-if="error && (!record?.status || record.status === 'active')" class="invited-offline" role="status">{{ t("暂时读不到对方房间：{reason}。下面是这台电脑记下的处理结果。", { reason: error }) }}</p>
    <div v-if="loading && !items.length" role="status"><USkeleton v-for="row in 3" :key="row" class="invited-skeleton" /></div>
    <p v-else-if="failure" class="invited-empty" role="alert">{{ failure }} <UButton :label="t('重试')" size="xs" color="neutral" variant="link" @click="load()" /></p>
    <p v-else-if="!items.length" class="invited-empty">{{ t("还没有人点名你的 AI。") }}</p>
    <ol v-else class="invited-items">
      <li v-for="item in items" :key="item.key" class="invited-item" :class="{ 'is-ended': item.outcome === 'ended' }">
        <p v-if="item.outcome === 'ended'" class="invited-ended" role="status"><UIcon name="i-lucide-circle-slash" />{{ item.reason }}<small v-if="item.at">{{ date(item.at) }}</small></p>
        <template v-else>
          <article class="invited-request">
            <header>
              <strong>{{ heading(item) }}</strong>
              <small v-if="item.requests.length">{{ item.message_ids.map((id) => `#${id}`).join(" ") }}</small>
              <small>{{ date(item.at) }}</small>
              <UBadge :color="outcome_of(item)[1]" variant="subtle" size="sm">{{ outcome_of(item)[0] }}</UBadge>
            </header>
            <p v-for="message in item.requests" :key="message.id" class="invited-text">{{ message.text }}</p>
            <p v-if="item.missing_text" class="invited-reason">{{ t("正文在对方房间，已无法读取") }}</p>
            <p v-else-if="item.reason" class="invited-reason">{{ runner_message(item.reason_text, item.reason) }}</p>
          </article>
          <article v-for="answer in item.answers" :key="answer.id" class="invited-answer">
            <header><strong>{{ ai_name }}</strong><small>#{{ answer.id }}</small><small v-if="answer.created_at">{{ date(answer.created_at) }}</small></header>
            <p class="invited-text">{{ answer.text }}</p>
          </article>
        </template>
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
.invited-reason { margin: 4px 0 0; color: var(--ui-text-muted); font-size: 12px; overflow-wrap: anywhere; }
.invited-ended { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 0; padding: 8px 12px; border: 1px dashed var(--ui-border); border-radius: 10px; color: var(--ui-text-toned); font-size: 12px; }
.invited-ended small { margin-left: auto; color: var(--ui-text-muted); }
@media (max-width: 480px) { .invited-answer { margin-left: 12px; } }
</style>

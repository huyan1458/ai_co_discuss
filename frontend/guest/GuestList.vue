<script setup>
/**
 * The guest's read-only tabs that are plain lists (API.md §3): private chat (only when opened), executions (summary
 * fields only) and the room (title and members). Re-read while shown; nothing here writes.
 */
import { onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import { t } from "../i18n.js";

const props = defineProps({ visit: { type: Object, required: true }, kind: { type: String, required: true } });
const POLL_MS = { private: 5000, executions: 5000, room: 15000 };
const PATHS = { private: "/private", executions: "/executions", room: "/room" };
const data = shallowRef(null);
const failed = ref(false);
let timer = 0, alive = true;
const STATUS_LABELS = { dispatched: t("投递中"), started: t("运行中"), completed: t("已完成"), failed: t("失败"), cancelled: t("已取消"), stopped: t("已停止") };
const ROLE_LABELS = { host: t("主持人"), member: t("普通成员"), owner: t("房主") };
const MEMBER_STATUS = { active: t("在场"), away: t("暂离"), removed: t("已移除") };

async function read() {
  clearTimeout(timer);
  if (!alive || props.visit.ended()) return;
  try {
    const result = await props.visit.request("GET", PATHS[props.kind], props.kind === "room" ? undefined : { query: { limit: 100 } });
    if (!alive || props.visit.ended()) return;
    data.value = result;
    failed.value = false;
  } catch (error) { failed.value = error.code === "guest_forbidden"; }
  if (alive) timer = setTimeout(read, POLL_MS[props.kind]);
}
onMounted(read);
onBeforeUnmount(() => { alive = false; clearTimeout(timer); });
const time = (value) => value ? new Date(value).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
</script>

<template>
  <div class="guest-list">
    <p v-if="failed" class="guest-empty">{{ t("房主没有开放这一页。") }}</p>
    <p v-else-if="!data" class="guest-empty">{{ t("正在读取…") }}</p>
    <template v-else-if="kind === 'room'">
      <h2>{{ data.title }}</h2>
      <ul>
        <li v-for="member in data.members" :key="member.id"><strong>{{ member.label }}</strong><small>{{ [ROLE_LABELS[member.role] || member.role, MEMBER_STATUS[member.status] || member.status].filter(Boolean).join(" · ") }}</small></li>
      </ul>
    </template>
    <template v-else-if="kind === 'executions'">
      <p v-if="!data.items?.length" class="guest-empty">{{ t("还没有执行记录。") }}</p>
      <ul v-else>
        <li v-for="item in [...data.items].reverse()" :key="item.id">
          <strong>{{ item.member_label }}</strong>
          <small>{{ STATUS_LABELS[item.status] || item.status }} · {{ time(item.started_at) }}{{ item.ended_at ? ` – ${time(item.ended_at)}` : "" }}{{ item.request_message_id ? ` · #${item.request_message_id}` : "" }}</small>
        </li>
      </ul>
    </template>
    <template v-else>
      <p v-if="!data.items?.length" class="guest-empty">{{ t("还没有私聊。") }}</p>
      <article v-for="item in data.items" :key="item.id" class="guest-private">
        <header><strong>{{ item.author_label }}</strong><small>{{ t("与 {name} 的私聊", { name: item.member_label }) }} · {{ time(item.created_at) }}</small></header>
        <p>{{ item.text }}</p>
      </article>
    </template>
  </div>
</template>

<style scoped>
.guest-list { box-sizing: border-box; height: 100%; padding: 12px max(16px, calc((100% - 960px) / 2)); overflow-y: auto; scrollbar-gutter: stable both-edges; }
.guest-list h2 { margin: 0 0 10px; color: var(--ui-text-highlighted); font-size: 15px; }
.guest-list ul { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; list-style: none; }
.guest-list li { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; padding: 8px 10px; border: 1px solid var(--ui-border-muted); border-radius: 6px; }
.guest-list li strong { color: var(--ui-text-highlighted); font-size: 13px; }
.guest-list li small, .guest-private small { color: var(--ui-text-muted); font-size: 12px; }
.guest-empty { color: var(--ui-text-muted); text-align: center; }
.guest-private { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }
.guest-private header { display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: baseline; }
.guest-private p { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
</style>

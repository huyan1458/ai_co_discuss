<script setup>
/**
 * The background work an execution's software left running or finished (sub-agents, background commands, monitors,
 * schedules), as its adapter reported it: one line each under the working card. The list is generic; which software
 * reported it is never shown or interpreted here. It keeps its own minute clock so the rest of the card never re-renders.
 */
import { onBeforeUnmount, onMounted, ref } from "vue";
import { t } from "./i18n.js";

const props = defineProps({
  /** `[{id, kind, title, state, started_at, ended_at, next_at, schedule}]`, times in milliseconds (0 when unknown). */
  tasks: { type: Array, default: () => [] },
});
const KIND_LABELS = { agent: t('子代理'), command: t('后台命令'), monitor: t('监视'), schedule: t('定时') };
const KIND_ICONS = { agent: "i-lucide-bot", command: "i-lucide-terminal", monitor: "i-lucide-radar", schedule: "i-lucide-alarm-clock" };
const STATE_LABELS = { done: t('已完成'), failed: t('失败'), stopped: t('已停止') };
const now = ref(Date.now());
let timer = 0;
onMounted(() => { timer = setInterval(() => { now.value = Date.now(); }, 30_000); });
onBeforeUnmount(() => clearInterval(timer));

/** Whole minutes as "3 分钟", under a minute as "不到 1 分钟". */
function minutes(ms) {
  const value = Math.floor(Math.max(0, ms) / 60_000);
  return value ? t('{value1} 分钟', { value1: value }) : t('不到 1 分钟');
}
/** The task's state in a few words: how long it has run, when a schedule fires next, or how it ended. */
function state_text(task) {
  if (task.state !== "running") return STATE_LABELS[task.state] || "";
  if (task.kind === "schedule") {
    const next = task.next_at > now.value ? t('下次 {value1}', { value1: new Date(task.next_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) }) : "";
    return [task.schedule, next].filter(Boolean).join(" · ");
  }
  return task.started_at ? t('进行中 · 已 {value1}', { value1: minutes(now.value - task.started_at) }) : t('进行中');
}
</script>

<template>
  <ul class="background-tasks" :aria-label="t('后台工作')">
    <li v-for="task in tasks" :key="task.id" :class="`is-${task.state}`"
      :title="task.kind === 'schedule' ? t('成员在自己的软件里设的定时；到点后的结果暂不进入房间') : undefined">
      <UIcon :name="KIND_ICONS[task.kind] || KIND_ICONS.command" class="background-task-icon" />
      <span class="background-task-kind">{{ KIND_LABELS[task.kind] || KIND_LABELS.command }}</span>
      <span class="background-task-title">{{ task.title }}</span>
      <span class="background-task-state">{{ state_text(task) }}</span>
    </li>
  </ul>
</template>

<style scoped>
.background-tasks { list-style: none; margin: 4px 0 0; padding: 0 0 0 calc(var(--working-avatar, 0px) + 8px); display: grid; gap: 2px; font-size: 12px; color: var(--ui-text-muted); }
.background-tasks li { display: flex; align-items: center; gap: 6px; min-width: 0; }
.background-task-icon { flex: none; width: 14px; height: 14px; }
.background-task-kind { flex: none; }
.background-task-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ui-text); }
.background-task-state { flex: none; margin-left: auto; }
.background-tasks li.is-failed .background-task-state { color: var(--ui-error); }
.background-tasks li:not(.is-running) .background-task-title { color: var(--ui-text-muted); }
</style>

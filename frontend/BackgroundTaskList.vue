<script setup>
/**
 * The background work an execution's software left running or finished (sub-agents, background commands, monitors,
 * schedules), as its adapter reported it, under the working card. Work still running gets a line each; work that has
 * ended folds into one quiet summary line that opens to the list. The list is generic; which software reported it is
 * never shown or interpreted here. It keeps its own minute clock so the rest of the card never re-renders.
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { t } from "./i18n.js";

const props = defineProps({
  /** `[{id, kind, title, state, started_at, ended_at, next_at, schedule}]`, times in milliseconds (0 when unknown). */
  tasks: { type: Array, default: () => [] },
});
const KIND_LABELS = { agent: t('子代理'), command: t('后台命令'), monitor: t('监视'), schedule: t('定时') };
const KIND_ICONS = { agent: "i-lucide-bot", command: "i-lucide-terminal", monitor: "i-lucide-radar", schedule: "i-lucide-alarm-clock" };
const STATE_LABELS = { done: t('已完成'), failed: t('失败'), stopped: t('已停止') };
// Shell set-up a command line opens with (PowerShell encoding and environment settings) says nothing about what it does.
const SHELL_PREAMBLE = /^(?:\s*(?:\$env:[\w.]+|\$OutputEncoding|\[Console\]::\w+)\s*=\s*(?:'[^']*'|"[^"]*"|[^;]+);)+\s*/i;
const now = ref(Date.now());
const open = ref(false);
let timer = 0;
onMounted(() => { timer = setInterval(() => { now.value = Date.now(); }, 30_000); });
onBeforeUnmount(() => clearInterval(timer));

const running = computed(() => props.tasks.filter((task) => task.state === "running"));
const ended = computed(() => props.tasks.filter((task) => task.state !== "running"));
const ended_text = computed(() => {
  const failed = ended.value.filter((task) => task.state === "failed").length;
  return failed ? t('{value1} 项后台工作已结束，{value2} 项失败', { value1: ended.value.length, value2: failed })
    : t('{value1} 项后台工作已结束', { value1: ended.value.length });
});

/** Whole minutes as "3 分钟", under a minute as "不到 1 分钟". */
function minutes(ms) {
  const value = Math.floor(Math.max(0, ms) / 60_000);
  return value ? t('{value1} 分钟', { value1: value }) : t('不到 1 分钟');
}
/** What the line shows: a command without its shell set-up, anything else as the software described it. */
function shown_title(task) {
  return (task.kind === "command" ? task.title.replace(SHELL_PREAMBLE, "") : task.title) || KIND_LABELS[task.kind] || "";
}
/** The task's state in a few words: how long it has run, when a schedule fires next, or how it ended. */
function state_text(task) {
  if (task.state !== "running") return STATE_LABELS[task.state] || "";
  if (task.kind === "schedule") {
    const next = task.next_at > now.value ? t('下次 {value1}', { value1: new Date(task.next_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) }) : "";
    return [task.schedule, next].filter(Boolean).join(" · ");
  }
  return task.started_at ? minutes(now.value - task.started_at) : "";
}
</script>

<template>
  <div class="background-tasks" role="group" :aria-label="t('后台工作')">
    <ul v-if="running.length" class="background-task-list">
      <li v-for="task in running" :key="task.id" :class="`is-${task.kind}`" :title="`${KIND_LABELS[task.kind] || KIND_LABELS.command}：${task.title}`">
        <UIcon :name="KIND_ICONS[task.kind] || KIND_ICONS.command" class="background-task-icon" :aria-label="KIND_LABELS[task.kind] || KIND_LABELS.command" />
        <span class="background-task-title">{{ shown_title(task) }}</span>
        <span class="background-task-state">{{ state_text(task) }}</span>
      </li>
    </ul>
    <template v-if="ended.length">
      <button type="button" class="background-task-summary" :class="{ 'is-failed': ended.some((task) => task.state === 'failed') }" :aria-expanded="open" @click="open = !open">
        <span>{{ ended_text }}</span><UIcon name="i-lucide-chevron-down" class="background-task-chevron" :class="{ 'is-open': open }" />
      </button>
      <ul v-if="open" class="background-task-list is-ended">
        <li v-for="task in ended" :key="task.id" :class="[`is-${task.kind}`, `is-${task.state}`]" :title="`${KIND_LABELS[task.kind] || KIND_LABELS.command}：${task.title}`">
          <UIcon :name="KIND_ICONS[task.kind] || KIND_ICONS.command" class="background-task-icon" :aria-label="KIND_LABELS[task.kind] || KIND_LABELS.command" />
          <span class="background-task-title">{{ shown_title(task) }}</span>
          <span class="background-task-state">{{ state_text(task) }}</span>
        </li>
      </ul>
    </template>
  </div>
</template>

<style scoped>
.background-tasks { margin-top: 4px; display: grid; gap: 2px; font-size: 12px; line-height: 20px; color: var(--ui-text-muted); }
.background-task-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
.background-task-list li { display: flex; align-items: center; gap: 6px; min-width: 0; }
.background-task-icon { flex: none; width: 13px; height: 13px; }
.background-task-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ui-text); }
.background-task-list li.is-command .background-task-title, .background-task-list li.is-monitor .background-task-title { font-family: var(--font-mono, ui-monospace, monospace); font-size: 11.5px; }
.background-task-state { flex: none; font-variant-numeric: tabular-nums; }
.background-task-list.is-ended .background-task-title { color: var(--ui-text-muted); }
.background-task-list li.is-failed .background-task-state { color: var(--ui-error); }
.background-task-summary { display: inline-flex; align-items: center; gap: 2px; justify-self: start; padding: 0; border: 0; background: none; color: inherit; font: inherit; cursor: pointer; }
.background-task-summary:hover { color: var(--ui-text); }
.background-task-summary.is-failed { color: var(--ui-error); }
.background-task-chevron { width: 12px; height: 12px; transition: transform 0.15s; }
.background-task-chevron.is-open { transform: rotate(180deg); }
</style>

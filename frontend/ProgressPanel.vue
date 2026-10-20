<script setup>
import { computed, inject, ref } from "vue";
import ProgressBoard from "./ProgressBoard.vue";

/**
 * Header progress chip, always visible with the room's status and round progress.
 * Where the rail can dock it toggles that rail; otherwise it opens the same board in a side drawer.
 */
const props = defineProps({ dockable: { type: Boolean, default: false }, docked: { type: Boolean, default: false } });
const emit = defineEmits(["toggle"]);
const { view, bridge } = inject("discussion");
const open = ref(false);
const room = computed(() => view.value.room);
const limits = computed(() => room.value.limits || {});
// Titles follow the progress board so the chip and the panel never disagree.
const state = computed(() => {
  const value = room.value;
  if (value.archived) return { tone: "neutral", title: "已存档" };
  if (value.phase === "concluded") return { tone: "neutral", title: "已收束" };
  if (limits.value.closing) return { tone: "warning", title: "正在收尾" };
  if (value.phase === "preparing") return { tone: "neutral", title: "准备中" };
  if (value.phase === "paused") return { tone: "warning", title: "已暂停" };
  if (limits.value.reached) return { tone: "warning", title: "已达上限" };
  return { tone: "primary", title: "进行中" };
});
const rounds = computed(() => limits.value.max_rounds
  ? `${limits.value.completed_rounds || 0}/${limits.value.max_rounds} 轮` : bridge.progress_round(room.value));
const label = computed(() => `${state.value.title} · ${rounds.value}`);
const action = computed(() => !props.dockable ? "查看讨论进度" : props.docked ? "收起讨论进度" : "展开讨论进度");

/** Toggle the docked rail when it fits, so the progress view stays in one place. */
function show() {
  if (props.dockable) emit("toggle");
  else open.value = true;
}
</script>

<template>
  <div class="progress-panel-anchor">
    <UTooltip :text="action">
      <button type="button" class="progress-chip" :class="[`is-${state.tone}`, { 'is-docked': props.dockable && props.docked }]" :aria-haspopup="props.dockable ? undefined : 'dialog'" :aria-expanded="props.dockable ? props.docked : open" :aria-label="`${action}：${label}`" @click="show">
        <span class="progress-dot"></span><span class="progress-chip-text">{{ label }}</span><UIcon :name="props.dockable && props.docked ? 'i-lucide-panel-right-close' : 'i-lucide-panel-right-open'" />
      </button>
    </UTooltip>
    <USlideover v-if="!props.dockable" v-model:open="open" side="right" title="讨论进度" :description="room.title" :ui="{ content: 'progress-drawer', body: 'progress-drawer-body' }">
      <template #body><ProgressBoard /></template>
    </USlideover>
  </div>
</template>

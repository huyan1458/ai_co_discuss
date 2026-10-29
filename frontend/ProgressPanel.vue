<script setup>
import { computed, inject, ref } from "vue";
import FreeBoard from "./FreeBoard.vue";

/** Open the shared progress board in a drawer without changing the sidebar layout. */
const { view, bridge } = inject("discussion");
const open = ref(false);
const room = computed(() => view.value.room);
const limits = computed(() => room.value.limits || {});
// Titles follow the progress board so the chip and the panel never disagree.
const state = computed(() => {
  const value = room.value;
  if (value.archived) return { tone: "neutral", title: "已存档" };
  if (value.phase === "concluded") return { tone: "neutral", title: "已收束" };
  if (value.phase === "preparing") return { tone: "neutral", title: "准备中" };
  if (value.phase === "paused") return { tone: "warning", title: "已暂停" };
  if (limits.value.reached) return { tone: "warning", title: "已达上限" };
  return { tone: "primary", title: "进行中" };
});
const rounds = computed(() => limits.value.round_cap || limits.value.max_rounds
  ? bridge.limit_rounds(limits.value).text.replace(" / ", "/") : bridge.progress_round(room.value));
const label = computed(() => `${state.value.title} · ${rounds.value}`);
</script>

<template>
  <div class="progress-panel-anchor">
    <UTooltip text="查看讨论进度">
      <button type="button" class="progress-chip" :class="`is-${state.tone}`" aria-haspopup="dialog" :aria-expanded="open" :aria-label="`查看讨论进度：${label}`" @click="open = true">
        <span class="progress-dot"></span><span class="progress-chip-text">{{ state.title }}<span class="progress-chip-rounds"> · {{ rounds }}</span></span>
      </button>
    </UTooltip>
    <USlideover v-model:open="open" side="right" title="讨论进度" :description="room.title" :ui="{ content: 'progress-drawer', body: 'progress-drawer-body' }">
      <template #body><FreeBoard /></template>
    </USlideover>
  </div>
</template>

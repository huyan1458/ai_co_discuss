<script setup>
import { computed, inject, ref } from "vue";
import ProgressBoard from "./ProgressBoard.vue";

/** Header progress chip, shown only without the docked right rail; it opens the same board in a side drawer. */
const props = defineProps({ floating: { type: Boolean, default: true } });
const { view, bridge } = inject("discussion");
const open = ref(false);
const room = computed(() => view.value.room);
const limits = computed(() => room.value.limits || {});
const tone = computed(() => room.value.phase === "concluded" ? "neutral" : limits.value.closing ? "warning"
  : room.value.phase === "paused" ? "neutral" : limits.value.reached ? "warning" : "primary");
</script>

<template>
  <div v-if="props.floating" class="progress-panel-anchor">
    <button type="button" class="progress-chip" :class="`is-${tone}`" aria-haspopup="dialog" :aria-expanded="open" :title="`查看讨论进度：${bridge.progress_round(room)}`" @click="open = true">
      <span class="progress-dot"></span><span class="progress-chip-text">{{ bridge.progress_round(room) }}</span><UIcon name="i-lucide-panel-right-open" />
    </button>
    <USlideover v-model:open="open" side="right" title="讨论进度" :description="room.title" :ui="{ content: 'progress-drawer', body: 'progress-drawer-body' }">
      <template #body><ProgressBoard /></template>
    </USlideover>
  </div>
</template>

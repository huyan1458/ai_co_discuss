<script setup>
/** One folded card between messages; it owns its open state so toggling never re-renders the message list. */
import { ref } from "vue";

defineProps({
  icon: { type: String, required: true },
  title: { type: String, default: "" },
  label: { type: String, required: true },
  toggleLabel: { type: String, default: "展开或收起详情" },
  skipped: Boolean,
  /** Neutral look without implying a skipped decision, for the host's own plans. */
  plain: Boolean,
  expandable: { type: Boolean, default: true },
});
const open = ref(false);
</script>

<template>
  <div class="channel-schedule-card" :class="{ 'is-skipped': skipped || plain, 'is-open': open }" :title="title" :aria-label="label">
    <UIcon :name="icon" class="channel-schedule-icon" />
    <span class="channel-schedule-text"><slot name="text" /></span>
    <span class="channel-schedule-actions"><slot name="actions" /></span>
    <button v-if="expandable" type="button" class="channel-schedule-toggle" :aria-expanded="open" :aria-label="toggleLabel" @click="open = !open"><UIcon name="i-lucide-chevron-down" /></button>
    <div v-if="open" class="channel-schedule-detail"><slot /></div>
  </div>
</template>

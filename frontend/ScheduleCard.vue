<script setup>
import { t } from "./i18n.js";
/** One folded card between messages; it owns its open state so toggling never re-renders the message list. */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

const props = defineProps({
  icon: { type: String, required: true },
  title: { type: String, default: "" },
  label: { type: String, required: true },
  toggleLabel: { type: String, default: t("展开或收起详情") },
  skipped: Boolean,
  /** Neutral look without implying a skipped decision, for the host's own plans. */
  plain: Boolean,
  expandable: { type: Boolean, default: true },
  /** Keep the text to one line; the toggle only appears when that line is cut off. */
  fold: Boolean,
});
const open = ref(false);
const line = ref(null);
const overflowing = ref(false);
const can_open = computed(() => props.expandable && (!props.fold || overflowing.value || open.value));
let observer = null;

/** Whether the one-line text is cut off at the card's current width. */
function measure() {
  if (line.value) overflowing.value = line.value.scrollWidth > line.value.clientWidth + 1;
}

onMounted(() => {
  if (!props.fold || !line.value) return;
  measure();
  observer = new ResizeObserver(measure);
  observer.observe(line.value);
});
onBeforeUnmount(() => observer?.disconnect());
</script>

<template>
  <div class="channel-schedule-card" :class="{ 'is-skipped': skipped || plain, 'is-open': open }" :title="title" :aria-label="label">
    <UIcon :name="icon" class="channel-schedule-icon" />
    <span class="channel-schedule-text"><span v-if="fold" ref="line" class="channel-checkin-line"><slot name="text" /></span><slot v-else name="text" /></span>
    <span class="channel-schedule-actions"><slot name="actions" /></span>
    <button v-if="can_open" type="button" class="channel-schedule-toggle" :aria-expanded="open" :aria-label="toggleLabel" @click="open = !open"><UIcon name="i-lucide-chevron-down" /></button>
    <div v-if="open" class="channel-schedule-detail"><slot /></div>
  </div>
</template>

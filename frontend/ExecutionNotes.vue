<script setup>
/**
 * An execution's progress notes as a secondary row, laid out like the answer summary.
 * While the member works the row is open and is the card's content; afterwards it folds after the result,
 * and the texts are read only when the user opens it. It owns its open state so toggling never re-renders the list.
 */
import { ref } from "vue";

const props = defineProps({
  /** Number of notes the execution has; the texts may not be loaded yet. */
  count: { type: Number, default: 0 },
  /** Loaded notes, or null before the first read. */
  notes: { type: Array, default: null },
  /** Open and without a toggle while the member is still working. */
  live: Boolean,
});
const emit = defineEmits(["load"]);
const open = ref(false);

function toggle() {
  open.value = !open.value;
  // Notes read while the member worked may miss the last few, so a shorter list is read again.
  if (open.value && (props.notes?.length ?? -1) < props.count) emit("load");
}
</script>

<template>
  <div class="channel-answer-summary channel-execution-notes">
    <small>过程说明</small>
    <div class="channel-message-text">
      <ol v-if="live || open" :class="{ 'is-live': live }">
        <li v-for="note in notes || []" :key="note.seq">{{ note.text }}</li>
      </ol>
      <UButton v-if="!live" :label="open ? '收起' : `${count} 段`" :trailing-icon="open ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
        variant="link" color="neutral" size="xs" class="channel-answer-toggle" :class="{ 'is-folded': !open }" :aria-expanded="open"
        :aria-label="open ? '收起过程说明' : `展开 ${count} 段过程说明`" @click="toggle" />
    </div>
  </div>
</template>

<style scoped>
ol { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; white-space: pre-wrap; overflow-wrap: anywhere; }
/* While working, the latest remark is where the member is now; earlier ones step back. */
ol.is-live li { opacity: .65; }
ol.is-live li:last-child { opacity: 1; }
/* Folded, the toggle stands on the label's baseline like the summary text does. */
.channel-answer-toggle.is-folded { min-height: 0; margin-top: 0; }
</style>

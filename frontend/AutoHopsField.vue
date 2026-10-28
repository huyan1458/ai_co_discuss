<script setup>
/**
 * How many requests AI may create from one owner message (host dispatches and hand-backs). Shared by the new-room form
 * and the room page's collaboration settings; a value outside the range goes back to the current one.
 */
import { ref, watch } from "vue";

// Matches the server's range for the chain budget.
const MAX_AUTO_HOPS = 50;
const props = defineProps({ modelValue: { type: Number, required: true }, disabled: Boolean });
const emit = defineEmits(["update:modelValue"]);
const draft = ref("");
watch(() => props.modelValue, (value) => { draft.value = String(value); }, { immediate: true });

/** Pass on a changed value in range; anything else shows the current value again. */
function commit() {
  const value = Number(draft.value);
  if (value === props.modelValue) return;
  if (!Number.isInteger(value) || value < 1 || value > MAX_AUTO_HOPS) { draft.value = String(props.modelValue); return; }
  emit("update:modelValue", value);
}
</script>

<template>
  <span class="auto-hops">
    <UInput v-model="draft" type="number" :min="1" :max="MAX_AUTO_HOPS" size="xs" class="auto-hops-input" aria-label="AI 之间派活上限" :disabled="disabled" @change="commit" />
    次，你的一条消息引出的派活与回交达到此数即停下等你
  </span>
</template>

<style scoped>
.auto-hops { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.auto-hops-input { width: 64px; }
</style>

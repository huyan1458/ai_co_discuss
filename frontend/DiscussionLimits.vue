<script setup>
/** The discussion limits shared by every form that sets them: rounds and total time, optional per-execution time, and what happens at the limit. */
import { computed, ref } from "vue";
import LimitPicker, { format_duration } from "./LimitPicker.vue";

const MAX_EXECUTION_MINUTES = 60;
const props = defineProps({
  rounds: { type: Number, default: 3 },
  minutes: { type: Number, default: 0 },
  execution_minutes: { type: [Number, String], default: "" },
  // The per-execution limit only applies to automatic discussions.
  execution: { type: Boolean, default: true },
  disabled: Boolean,
});
const emit = defineEmits(["update:rounds", "update:minutes", "update:execution_minutes"]);
const picker = ref(null);

const rule = computed(() => {
  const limits = [props.rounds && `${props.rounds} 轮`, props.minutes && format_duration(props.minutes)].filter(Boolean);
  if (!limits.length) return "不设轮次和时长上限。";
  return `最多 ${limits.join(" 或 ")}，${limits.length === 2 ? "先到则" : "到限后"}结束讨论，房间回到自由协作。`;
});

/** Commit the wheels' visible values before the owning form submits. */
function settle() { picker.value?.settle(); }
defineExpose({ settle });
</script>

<template>
  <fieldset class="discussion-limits" :disabled="disabled">
    <LimitPicker ref="picker" :rounds="rounds" :minutes="minutes" @update:rounds="emit('update:rounds', $event)" @update:minutes="emit('update:minutes', $event)" />
    <p class="fine-print">一轮指每位专家各完成一次观点；开启后计时，暂停期间不计时。</p>
    <details v-if="execution" class="discussion-limits-execution" :open="Boolean(Number(execution_minutes))">
      <summary>单次 AI 执行上限<small>{{ Number(execution_minutes) ? `${execution_minutes} 分钟` : "不限时长" }}</small></summary>
      <UFormField label="单次 AI 执行（分钟）" description="留空或 0 表示不限"><UInput :model-value="Number(execution_minutes) ? execution_minutes : ''" type="number" :min="0" :max="MAX_EXECUTION_MINUTES" :step="1" placeholder="不限时长" class="w-40" @update:model-value="emit('update:execution_minutes', $event)" /></UFormField>
    </details>
    <slot />
    <p class="discussion-limits-rule" aria-live="polite"><UIcon name="i-lucide-flag" />{{ rule }}</p>
  </fieldset>
</template>

<style scoped>
.discussion-limits { display: flex; flex-direction: column; gap: 14px; min-width: 0; margin: 0; padding: 0; border: 0; }
.discussion-limits .fine-print { margin: -6px 0 0; }
.discussion-limits-execution > summary { display: flex; align-items: center; gap: 8px; min-height: 28px; color: var(--ui-text-muted); font-size: 12px; cursor: pointer; }
.discussion-limits-execution > summary:hover { color: var(--ui-text-highlighted); }
.discussion-limits-execution > summary small { color: var(--ui-text-dimmed); font-size: 11px; }
.discussion-limits-execution[open] > summary { margin-bottom: 8px; }
.discussion-limits-rule { display: flex; align-items: flex-start; gap: 8px; margin: 0; padding-top: 14px; border-top: 1px solid var(--ui-border-muted); color: var(--ui-text-muted); font-size: 12px; }
.discussion-limits-rule > [class*="icon"] { flex-shrink: 0; width: 13px; height: 13px; margin-top: 2px; color: var(--channel-accent); }
</style>

<script setup>
/** The discussion limits shared by every form that sets them: rounds and total time, and what happens at the limit. */
import { computed, ref } from "vue";
import LimitPicker, { format_duration } from "./LimitPicker.vue";

const props = defineProps({
  rounds: { type: Number, default: 3 },
  minutes: { type: Number, default: 0 },
  // Creation forms share the follow-up switch; limit-only forms leave it absent.
  named_followup: { type: Boolean, default: undefined },
  disabled: Boolean,
});
const emit = defineEmits(["update:rounds", "update:minutes", "update:named_followup"]);
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
    <UCheckbox v-if="named_followup !== undefined" :model-value="named_followup" label="点名追问" description="开启后，主持人每轮逐位点名追问；关闭时专家按统一问题互相回应。轮间由主持人衔接，开启智能调度后可由程序代办。" @update:model-value="emit('update:named_followup', $event)" />
    <slot />
    <p class="discussion-limits-rule" aria-live="polite"><UIcon name="i-lucide-flag" />{{ rule }}</p>
  </fieldset>
</template>

<style scoped>
.discussion-limits { display: flex; flex-direction: column; gap: 14px; min-width: 0; margin: 0; padding: 0; border: 0; }
.discussion-limits .fine-print { margin: -6px 0 0; }
.discussion-limits-rule { display: flex; align-items: flex-start; gap: 8px; margin: 0; padding-top: 14px; border-top: 1px solid var(--ui-border-muted); color: var(--ui-text-muted); font-size: 12px; }
.discussion-limits-rule > [class*="icon"] { flex-shrink: 0; width: 13px; height: 13px; margin-top: 2px; color: var(--channel-accent); }
</style>

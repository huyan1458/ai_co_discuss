<script setup>
/**
 * How many model requests one execution of a model-API member may make before the runner stops it; 0 means no limit.
 * A few requests before the limit the model is told to submit what it has. Shared by the new-room form and the room
 * page's collaboration settings, in the same sentence-with-control form as ChainRoundsField; the default slot appends a
 * note to the help line.
 */
import { ref, watch } from "vue";
import { DEFAULT_API_MAX_REQUESTS, MAX_API_MAX_REQUESTS } from "../runner/adapters/profiles.mjs";

const UNLIMITED = 0;
const props = defineProps({ modelValue: { type: Number, required: true }, disabled: Boolean });
const emit = defineEmits(["update:modelValue"]);
// The finite limit to return to when "unlimited" is switched off.
const finite = ref(DEFAULT_API_MAX_REQUESTS);
watch(() => props.modelValue, (value) => { if (value !== UNLIMITED) finite.value = value; }, { immediate: true });

/** Commit a typed value once it is a whole number in range; anything else snaps back to the saved value. */
function commit(event) {
  const value = Number(event.target.value);
  if (!Number.isInteger(value) || value < 1 || value > MAX_API_MAX_REQUESTS) { event.target.value = String(props.modelValue); return; }
  if (value !== props.modelValue) emit("update:modelValue", value);
}
</script>

<template>
  <span class="api-requests">
    <span class="api-requests-sentence">
      <template v-if="modelValue === UNLIMITED"><span>API 成员每次执行可一直调用模型，不限次数</span></template>
      <template v-else>
        <span>API 成员每次执行最多调用模型</span>
        <input class="api-requests-value" type="number" inputmode="numeric" min="1" :max="MAX_API_MAX_REQUESTS" step="1" :value="modelValue"
          :disabled="disabled" aria-label="API 成员每次执行的模型请求上限" @change="commit" @keydown.enter.prevent="commit" />
        <span>次，然后停止</span>
      </template>
      <UCheckbox :model-value="modelValue === UNLIMITED" :disabled="disabled" label="不限" @update:model-value="emit('update:modelValue', $event ? UNLIMITED : finite)" />
    </span>
    <small class="api-requests-help">每读、改一次文件或读一次房间都算一次。快到上限时会提醒它先提交已完成的部分；不限时只能靠“停止”打断，期间持续产生 API 费用。<slot /></small>
  </span>
</template>

<style scoped>
.api-requests { display: flex; flex-direction: column; gap: 6px; }
.api-requests-sentence { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; color: var(--ui-text); font-size: 13px; line-height: 28px; }
/* Sized and drawn like the round stepper's value (.chain-rounds-value) so both limits look alike. */
.api-requests-value { width: 64px; height: 26px; padding: 0 6px; border-radius: 5px; background: var(--ui-bg-muted); color: var(--ui-text-highlighted);
  font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; text-align: center; outline: none; }
.api-requests-value:focus-visible { box-shadow: 0 0 0 1px var(--ui-primary); }
.api-requests-value:disabled { opacity: 0.4; }
.api-requests-help { color: var(--ui-text-muted); font-size: 12px; line-height: 1.6; }
</style>

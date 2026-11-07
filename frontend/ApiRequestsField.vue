<script setup>
/**
 * How many model requests one execution of a model-API member may make before the runner stops it; 0 means no limit.
 * A few requests before the limit the model is told to submit what it has. Shared by the new-room form and the room
 * page's collaboration settings, in the same sentence-with-stepper form as ChainRoundsField; the default slot appends a
 * note to the help line.
 */
import { ref, watch } from "vue";
import { DEFAULT_API_MAX_REQUESTS, MAX_API_MAX_REQUESTS } from "../runner/adapters/profiles.mjs";
import NumberStepper from "./NumberStepper.vue";

const UNLIMITED = 0;
// The limit is in the hundreds, so the buttons move by tens; any exact value can still be typed.
const REQUESTS_STEP = 10;
const props = defineProps({ modelValue: { type: Number, required: true }, disabled: Boolean });
const emit = defineEmits(["update:modelValue"]);
// The finite limit to return to when "unlimited" is switched off.
const finite = ref(DEFAULT_API_MAX_REQUESTS);
watch(() => props.modelValue, (value) => { if (value !== UNLIMITED) finite.value = value; }, { immediate: true });
</script>

<template>
  <span class="api-requests">
    <span class="api-requests-sentence">
      <template v-if="modelValue === UNLIMITED"><span>API 成员每次执行可一直调用模型，不限次数</span></template>
      <template v-else>
        <span>API 成员每次执行最多调用模型</span>
        <NumberStepper :model-value="modelValue" :max="MAX_API_MAX_REQUESTS" :step="REQUESTS_STEP" label="API 成员每次执行的模型请求上限" :disabled="disabled"
          @update:model-value="emit('update:modelValue', $event)" />
        <span>次，然后停止</span>
      </template>
      <UCheckbox :model-value="modelValue === UNLIMITED" :disabled="disabled" label="不限" aria-label="API 请求次数不限" :ui="{ root: 'items-center' }" @update:model-value="emit('update:modelValue', $event ? UNLIMITED : finite)" />
    </span>
    <small class="api-requests-help">每读、改一次文件或读一次房间都算一次。快到上限时会提醒它先提交已完成的部分；不限时只能靠“停止”打断，期间持续产生 API 费用。<slot /></small>
  </span>
</template>

<style scoped>
.api-requests { display: flex; flex-direction: column; gap: 6px; }
.api-requests-sentence { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; color: var(--ui-text); font-size: 13px; line-height: 28px; }
.api-requests-help { color: var(--ui-text-muted); font-size: 12px; line-height: 1.6; }
</style>

<script setup>
/**
 * How many model requests one execution of a model-API member may make before the runner stops it; 0 means no limit.
 * A few requests before the limit the model is told to submit what it has. Shared by the new-room form (which passes a
 * title) and the room page's collaboration settings (whose row label is the title), in the same layout as ChainRoundsField.
 */
import { ref, watch } from "vue";
import { DEFAULT_API_MAX_REQUESTS, MAX_API_MAX_REQUESTS } from "../runner/adapters/profiles.mjs";
import NumberStepper from "./NumberStepper.vue";

const UNLIMITED = 0;
// The limit is in the hundreds, so the buttons move by tens; any exact value can still be typed.
const REQUESTS_STEP = 10;
const props = defineProps({ modelValue: { type: Number, required: true }, disabled: Boolean, title: { type: String, default: "" } });
const emit = defineEmits(["update:modelValue"]);
// The finite limit to return to when "unlimited" is switched off.
const finite = ref(DEFAULT_API_MAX_REQUESTS);
watch(() => props.modelValue, (value) => { if (value !== UNLIMITED) finite.value = value; }, { immediate: true });
</script>

<template>
  <span class="limit-field">
    <span class="limit-field-row">
      <span v-if="title" class="limit-field-title">{{ title }}</span>
      <span class="limit-field-controls">
        <template v-if="modelValue !== UNLIMITED">
          <NumberStepper :model-value="modelValue" :max="MAX_API_MAX_REQUESTS" :step="REQUESTS_STEP" label="API 成员每次执行的模型请求上限" :disabled="disabled"
            @update:model-value="emit('update:modelValue', $event)" />
          <span>次</span>
        </template>
        <UCheckbox :model-value="modelValue === UNLIMITED" :disabled="disabled" label="不限" aria-label="API 请求次数不限" :ui="{ root: 'items-center' }" @update:model-value="emit('update:modelValue', $event ? UNLIMITED : finite)" />
      </span>
    </span>
    <small class="limit-field-help">API 成员每次执行最多调用模型几次，读写文件、读房间各算一次；快到上限会先提交已完成的部分。<template v-if="modelValue === UNLIMITED">不限时会持续产生费用，只能手动停止。</template></small>
  </span>
</template>

<style scoped>
.limit-field { display: flex; flex-direction: column; gap: 4px; }
.limit-field-row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 4px 12px; min-height: 28px; }
.limit-field-title { color: var(--ui-text); font-size: 13px; }
.limit-field-controls { display: inline-flex; align-items: center; gap: 8px; color: var(--ui-text); font-size: 13px; white-space: nowrap; }
.limit-field-help { color: var(--ui-text-muted); font-size: 12px; line-height: 1.6; }
</style>

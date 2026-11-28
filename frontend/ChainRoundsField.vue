<script setup>
/**
 * How many rounds the host may run from one owner message before it waits: a round is one host dispatch, its members'
 * answers and the hand-back (a whole relay pass counts as one); 0 means unlimited.
 * Shared by the new-room form (which passes a title) and the room page's collaboration settings (whose row label is the title).
 */
import { ref, watch } from "vue";
import NumberStepper from "./NumberStepper.vue";

// Matches the server's range for the round limit; 0 is unlimited.
const MAX_CHAIN_ROUNDS = 100;
const UNLIMITED = 0;
const DEFAULT_FINITE = 10;
const props = defineProps({ modelValue: { type: Number, required: true }, disabled: Boolean, title: { type: String, default: "" },
  /** For another count limit with the same controls: its explanation, the stepper's name and its unit. */
  help: { type: String, default: "" }, noHelp: Boolean, name: { type: String, default: "" }, unit: { type: String, default: "" } });
const emit = defineEmits(["update:modelValue"]);
// The finite limit to return to when "unlimited" is switched off.
const finite = ref(DEFAULT_FINITE);
watch(() => props.modelValue, (value) => { if (value !== UNLIMITED) finite.value = value; }, { immediate: true });
</script>

<template>
  <span class="limit-field">
    <span class="limit-field-row">
      <span v-if="title" class="limit-field-title">{{ title }}</span>
      <span class="limit-field-controls">
        <NumberStepper :model-value="modelValue === UNLIMITED ? finite : modelValue" :max="MAX_CHAIN_ROUNDS" :label="name || t('主持人连续派活轮数')" :disabled="disabled || modelValue === UNLIMITED" :title="modelValue === UNLIMITED ? t('已设为不限') : undefined" @update:model-value="emit('update:modelValue', $event)" />
        <span>{{ unit || t("轮") }}</span>
        <UCheckbox :model-value="modelValue === UNLIMITED" :disabled="disabled" :label="t('不限')" :aria-label="t('主持人连续派活轮数不限')" :ui="{ root: 'items-center' }" @update:model-value="emit('update:modelValue', $event ? UNLIMITED : finite)" />
      </span>
    </span>
    <small v-if="!noHelp" class="limit-field-help">{{ help || t("收到你一条消息后，主持人最多派几轮活就停下等你；派活 → 成员回答 → 交回汇总算一轮。") }}<span :class="{ invisible: modelValue !== UNLIMITED }">{{ t("不限时只能用“全部停止”打断。") }}</span></small>
  </span>
</template>

<style scoped>
.limit-field { display: flex; flex-direction: column; gap: 4px; }
.limit-field-row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 4px 12px; min-height: 28px; }
.limit-field-title { color: var(--ui-text); font-size: 13px; }
.limit-field-controls { display: inline-flex; align-items: center; gap: 8px; color: var(--ui-text); font-size: 13px; white-space: nowrap; }
.limit-field-help { color: var(--ui-text-muted); font-size: 12px; line-height: 1.6; }
</style>

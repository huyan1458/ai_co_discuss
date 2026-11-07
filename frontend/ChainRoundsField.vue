<script setup>
/**
 * How many rounds the host may run from one owner message before it waits: a round is one host dispatch, its members'
 * answers and the hand-back (a whole relay pass counts as one). Written as one sentence with the stepper inline, so the
 * number reads as rounds, never as a count of requests; 0 means unlimited.
 * Shared by the new-room form and the room page's collaboration settings; the default slot appends a note to the help line.
 */
import { ref, watch } from "vue";
import NumberStepper from "./NumberStepper.vue";

// Matches the server's range for the round limit; 0 is unlimited.
const MAX_CHAIN_ROUNDS = 100;
const UNLIMITED = 0;
const DEFAULT_FINITE = 10;
const props = defineProps({ modelValue: { type: Number, required: true }, disabled: Boolean });
const emit = defineEmits(["update:modelValue"]);
// The finite limit to return to when "unlimited" is switched off.
const finite = ref(DEFAULT_FINITE);
watch(() => props.modelValue, (value) => { if (value !== UNLIMITED) finite.value = value; }, { immediate: true });
</script>

<template>
  <span class="chain-rounds">
    <span class="chain-rounds-sentence">
      <template v-if="modelValue === UNLIMITED"><span>主持人收到你的一条消息后，可一直连续派活，不限轮数</span></template>
      <template v-else>
        <span>主持人收到你的一条消息后，最多连续派活</span>
        <NumberStepper :model-value="modelValue" :max="MAX_CHAIN_ROUNDS" label="主持人连续派活轮数" :disabled="disabled" @update:model-value="emit('update:modelValue', $event)" />
        <span>轮，然后停下等你</span>
      </template>
      <UCheckbox :model-value="modelValue === UNLIMITED" :disabled="disabled" label="不限" aria-label="主持人连续派活轮数不限" :ui="{ root: 'items-center' }" @update:model-value="emit('update:modelValue', $event ? UNLIMITED : finite)" />
    </span>
    <small class="chain-rounds-help">一轮 = 派活 → 成员回答 → 交回主持人汇总；依次接力走完一圈算一轮。到上限后可一键继续，主持人也可提前申请轮数等你批准；不限时只能靠“全部停止”打断。<slot /></small>
  </span>
</template>

<style scoped>
.chain-rounds { display: flex; flex-direction: column; gap: 6px; }
.chain-rounds-sentence { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; color: var(--ui-text); font-size: 13px; line-height: 28px; }
.chain-rounds-help { color: var(--ui-text-muted); font-size: 12px; line-height: 1.6; }
</style>

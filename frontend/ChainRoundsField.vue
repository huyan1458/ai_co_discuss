<script setup>
/**
 * How many rounds the host may run from one owner message before it waits: a round is one host dispatch, its members'
 * answers and the hand-back (a whole relay pass counts as one). Written as one sentence with the stepper inline, so the
 * number reads as rounds, never as a count of requests; 0 means unlimited.
 * Shared by the new-room form and the room page's collaboration settings; the default slot appends a note to the help line.
 */
import { ref, watch } from "vue";

// Matches the server's range for the round limit; 0 is unlimited.
const MAX_CHAIN_ROUNDS = 100;
const UNLIMITED = 0;
const DEFAULT_FINITE = 10;
const props = defineProps({ modelValue: { type: Number, required: true }, disabled: Boolean });
const emit = defineEmits(["update:modelValue"]);
// The finite limit to return to when "unlimited" is switched off.
const finite = ref(DEFAULT_FINITE);
watch(() => props.modelValue, (value) => { if (value !== UNLIMITED) finite.value = value; }, { immediate: true });

function set(value) {
  const clamped = Math.min(MAX_CHAIN_ROUNDS, Math.max(1, value));
  if (clamped !== props.modelValue) emit("update:modelValue", clamped);
}

function step(delta) { set(props.modelValue + delta); }

// Typed values apply on blur or Enter; anything that is not a number falls back to the current value.
function commit(event) {
  const typed = Number.parseInt(event.target.value, 10);
  if (Number.isFinite(typed)) set(typed);
  event.target.value = String(props.modelValue);
}
</script>

<template>
  <span class="chain-rounds">
    <span class="chain-rounds-sentence">
      <template v-if="modelValue === UNLIMITED"><span>主持人收到你的一条消息后，可一直连续派活，不限轮数</span></template>
      <template v-else>
        <span>主持人收到你的一条消息后，最多连续派活</span>
        <span class="chain-rounds-stepper" role="group" aria-label="主持人连续派活轮数">
          <button type="button" class="chain-rounds-step" aria-label="少一轮" :disabled="disabled || modelValue <= 1" @click="step(-1)"><UIcon name="i-lucide-minus" /></button>
          <input class="chain-rounds-value" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="3" aria-label="轮数" :value="modelValue" :disabled="disabled"
            @focus="$event.target.select()" @change="commit" @keydown.enter.prevent="$event.target.blur()" />
          <button type="button" class="chain-rounds-step" aria-label="多一轮" :disabled="disabled || modelValue >= MAX_CHAIN_ROUNDS" @click="step(1)"><UIcon name="i-lucide-plus" /></button>
        </span>
        <span>轮，然后停下等你</span>
      </template>
      <UCheckbox :model-value="modelValue === UNLIMITED" :disabled="disabled" label="不限" @update:model-value="emit('update:modelValue', $event ? UNLIMITED : finite)" />
    </span>
    <small class="chain-rounds-help">一轮 = 派活 → 成员回答 → 交回主持人汇总；依次接力走完一圈算一轮。到上限后可一键继续，主持人也可提前申请轮数等你批准；不限时只能靠“全部停止”打断。<slot /></small>
  </span>
</template>

<style scoped>
.chain-rounds { display: flex; flex-direction: column; gap: 6px; }
.chain-rounds-sentence { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; color: var(--ui-text); font-size: 13px; line-height: 28px; }
/* Drawn like the segmented switches (.expert-card-modes) so every control on the page shares one look. */
.chain-rounds-stepper { display: inline-flex; align-items: center; gap: 3px; padding: 3px; border-radius: 5px; background: var(--ui-bg-muted); }
.chain-rounds-step { display: grid; place-items: center; width: 22px; height: 22px; border-radius: 4px; color: var(--ui-text-muted); cursor: pointer; }
.chain-rounds-step:hover:not(:disabled) { background: var(--ui-bg-elevated); color: var(--ui-text-highlighted); }
.chain-rounds-step:disabled { opacity: 0.4; cursor: default; }
.chain-rounds-step .iconify { width: 12px; height: 12px; }
.chain-rounds-value { width: 34px; height: 22px; padding: 0; border: 0; outline: none; border-radius: 4px; background: var(--ui-bg-elevated); box-shadow: var(--channel-shadow-control); color: var(--ui-text-highlighted); font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; line-height: 22px; text-align: center; }
.chain-rounds-value:focus { box-shadow: 0 0 0 1px var(--channel-accent); }
.chain-rounds-value:disabled { opacity: 0.6; }
.chain-rounds-help { color: var(--ui-text-muted); font-size: 12px; line-height: 1.6; }
</style>

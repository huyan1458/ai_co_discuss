<script setup>
/**
 * How many rounds the host may run from one owner message before it waits: a round is one host dispatch, its members'
 * answers and the hand-back. Written as one sentence with the stepper inline, so the number reads as rounds, never as a count of requests.
 * Shared by the new-room form and the room page's collaboration settings; the default slot appends a note to the help line.
 */

// Matches the server's range for the round limit.
const MAX_CHAIN_ROUNDS = 20;
const props = defineProps({ modelValue: { type: Number, required: true }, disabled: Boolean });
const emit = defineEmits(["update:modelValue"]);

function step(delta) {
  const value = Math.min(MAX_CHAIN_ROUNDS, Math.max(1, props.modelValue + delta));
  if (value !== props.modelValue) emit("update:modelValue", value);
}
</script>

<template>
  <span class="chain-rounds">
    <span class="chain-rounds-sentence">
      <span>主持人收到你的一条消息后，最多连续派活</span>
      <span class="chain-rounds-stepper" role="group" aria-label="主持人连续派活轮数">
        <button type="button" class="chain-rounds-step" aria-label="少一轮" :disabled="disabled || modelValue <= 1" @click="step(-1)"><UIcon name="i-lucide-minus" /></button>
        <output class="chain-rounds-value" aria-live="polite">{{ modelValue }}</output>
        <button type="button" class="chain-rounds-step" aria-label="多一轮" :disabled="disabled || modelValue >= MAX_CHAIN_ROUNDS" @click="step(1)"><UIcon name="i-lucide-plus" /></button>
      </span>
      <span>轮，然后停下等你</span>
    </span>
    <small class="chain-rounds-help">一轮 = 派活 → 成员回答 → 交回主持人汇总。到上限后可一键继续；多步分工、评审返工时可调大。<slot /></small>
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
.chain-rounds-value { min-width: 28px; height: 22px; border-radius: 4px; background: var(--ui-bg-elevated); box-shadow: var(--channel-shadow-control); color: var(--ui-text-highlighted); font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; line-height: 22px; text-align: center; }
.chain-rounds-help { color: var(--ui-text-muted); font-size: 12px; line-height: 1.6; }
</style>

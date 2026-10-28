<script setup>
/**
 * How many rounds the host may run from one owner message before it waits: a round is one host dispatch, its members'
 * answers and the hand-back. A stepper with the unit in view, so the number reads as rounds, never as a count of requests.
 * Shared by the new-room form and the room page's collaboration settings.
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
    <span class="chain-rounds-stepper" role="group" aria-label="主持人自动推进轮数">
      <UButton icon="i-lucide-minus" color="neutral" variant="ghost" size="xs" aria-label="少一轮" :disabled="disabled || modelValue <= 1" @click="step(-1)" />
      <output class="chain-rounds-value" aria-live="polite">{{ modelValue }} 轮</output>
      <UButton icon="i-lucide-plus" color="neutral" variant="ghost" size="xs" aria-label="多一轮" :disabled="disabled || modelValue >= MAX_CHAIN_ROUNDS" @click="step(1)" />
    </span>
    <small class="chain-rounds-help">每轮：主持人派一次活，成员都回答后交回主持人汇总。到上限即停下等你，可一键继续。</small>
  </span>
</template>

<style scoped>
.chain-rounds { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; }
.chain-rounds-stepper { display: inline-flex; align-items: center; gap: 2px; padding: 1px; border: 1px solid var(--ui-border); border-radius: 6px; }
.chain-rounds-value { min-width: 44px; color: var(--ui-text-highlighted); font-weight: 600; font-variant-numeric: tabular-nums; text-align: center; }
.chain-rounds-help { color: var(--ui-text-muted); font-size: 12px; }
</style>

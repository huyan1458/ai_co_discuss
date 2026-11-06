<script setup>
/**
 * Inline whole-number stepper: minus button, typed value, plus button. Used by the limit fields (ChainRoundsField,
 * ApiRequestsField) so every limit sentence shares one control. Values are clamped to [min, max]; typed values apply on
 * blur or Enter, and anything that is not a number falls back to the current value.
 */
const props = defineProps({
  modelValue: { type: Number, required: true },
  min: { type: Number, default: 1 },
  max: { type: Number, required: true },
  step: { type: Number, default: 1 },
  label: { type: String, required: true },
  disabled: Boolean,
});
const emit = defineEmits(["update:modelValue"]);

function set(value) {
  const clamped = Math.min(props.max, Math.max(props.min, value));
  if (clamped !== props.modelValue) emit("update:modelValue", clamped);
}

function commit(event) {
  const typed = Number.parseInt(event.target.value, 10);
  if (Number.isFinite(typed)) set(typed);
  event.target.value = String(props.modelValue);
}
</script>

<template>
  <span class="number-stepper" role="group" :aria-label="label">
    <button type="button" class="number-stepper-step" :aria-label="`减少 ${step}`" :disabled="disabled || modelValue <= min" @click="set(modelValue - step)"><UIcon name="i-lucide-minus" /></button>
    <input class="number-stepper-value" type="text" inputmode="numeric" pattern="[0-9]*" :maxlength="String(max).length" :aria-label="label" :value="modelValue" :disabled="disabled"
      :style="{ width: `${String(max).length + 1.5}ch` }" @focus="$event.target.select()" @change="commit" @keydown.enter.prevent="$event.target.blur()" />
    <button type="button" class="number-stepper-step" :aria-label="`增加 ${step}`" :disabled="disabled || modelValue >= max" @click="set(modelValue + step)"><UIcon name="i-lucide-plus" /></button>
  </span>
</template>

<style scoped>
/* Drawn like the segmented switches (.expert-card-modes) so every control on the page shares one look. */
.number-stepper { display: inline-flex; align-items: center; gap: 3px; padding: 3px; border-radius: 5px; background: var(--ui-bg-muted); line-height: 22px; }
.number-stepper-step { display: grid; place-items: center; width: 22px; height: 22px; border-radius: 4px; color: var(--ui-text-muted); cursor: pointer; }
.number-stepper-step:hover:not(:disabled) { background: var(--ui-bg-elevated); color: var(--ui-text-highlighted); }
.number-stepper-step:disabled { opacity: 0.4; cursor: default; }
.number-stepper-step .iconify { width: 12px; height: 12px; }
.number-stepper-value { min-width: 34px; height: 22px; padding: 0; border: 0; outline: none; border-radius: 4px; background: var(--ui-bg-elevated); box-shadow: var(--channel-shadow-control); color: var(--ui-text-highlighted); font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; line-height: 22px; text-align: center; }
.number-stepper-value:focus { box-shadow: 0 0 0 1px var(--channel-accent); }
.number-stepper-value:disabled { opacity: 0.6; }
</style>

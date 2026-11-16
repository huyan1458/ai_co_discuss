<script setup>
/**
 * The trust level for one inviting computer and, for 完全借用, its limits. The join dialog and the invited room's
 * rail share this one control.
 */
import { useId } from "vue";
import NumberStepper from "./NumberStepper.vue";
import { BORROW_HOURS, TRUST_LEVELS } from "./external-members.js";
import { t } from "./i18n.js";

// { trust, max_wakes, hours }
const value = defineModel({ type: Object, required: true });
const set = (changes) => { value.value = { ...value.value, ...changes }; };
const MAX_WAKES = 1000;
// Each instance its own radio group: the join dialog and the rail may both be open.
const group = useId();
</script>

<template>
  <fieldset class="trust-level">
    <legend>{{ t("信任等级") }}</legend>
    <label v-for="option in TRUST_LEVELS" :key="option.value" class="trust-option" :class="{ 'is-selected': value.trust === option.value }">
      <input type="radio" :name="group" :value="option.value" :checked="value.trust === option.value" @change="set({ trust: option.value })" />
      <span><b>{{ option.label }}</b><small>{{ option.description }}</small></span>
    </label>
    <div v-if="value.trust === 'borrow'" class="trust-limits">
      <span>{{ t("最多唤醒") }}</span>
      <NumberStepper :model-value="value.max_wakes" :min="1" :max="MAX_WAKES" :label="t('最多唤醒次数')" @update:model-value="set({ max_wakes: $event })" />
      <span>{{ t("次，期限") }}</span>
      <div class="trust-durations" role="radiogroup" :aria-label="t('期限')">
        <button v-for="option in BORROW_HOURS" :key="option.value" type="button" role="radio" :aria-checked="value.hours === option.value" :class="{ 'is-selected': value.hours === option.value }" @click="set({ hours: option.value })">{{ option.label }}</button>
      </div>
    </div>
    <p v-if="value.trust === 'trusted'" class="trust-warning">{{ t("信任设备下 AI 不再受限，可用本机文件与联网工具；对方房间的内容可能诱导它读这台电脑上的文件。") }}</p>
  </fieldset>
</template>

<style scoped>
.trust-level { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; border: 0; min-width: 0; }
.trust-level legend { margin-bottom: 4px; color: var(--ui-text-toned); font-size: 12px; }
.trust-option { display: flex; gap: 8px; padding: 8px; border: 1px solid var(--ui-border-muted); border-radius: 8px; cursor: pointer; font-size: 12px; }
.trust-option.is-selected { border-color: var(--channel-accent); }
.trust-option span { display: flex; flex-direction: column; gap: 2px; }
.trust-option small { color: var(--ui-text-muted); }
.trust-limits { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 12px; color: var(--ui-text-toned); }
.trust-durations { display: flex; gap: 3px; padding: 3px; border-radius: 6px; background: var(--ui-bg-muted); }
.trust-durations button { min-width: 48px; min-height: 26px; border-radius: 4px; font-size: 12px; color: var(--ui-text-muted); }
.trust-durations button.is-selected { color: var(--ui-text-highlighted); background: var(--ui-bg-elevated); box-shadow: var(--channel-shadow-control); }
.trust-warning { margin: 0; color: var(--ui-warning, #e0a33a); font-size: 12px; }
@media (pointer: coarse) { .trust-durations button { min-height: 36px; } }
</style>

<script setup>
/**
 * How this computer's AI treats being named in a room on another computer: answer at once or ask first, and whether it
 * only speaks in the room or runs unrestricted. The join dialog and the invited room's rail share this one control.
 */
import { LEND_DURATIONS, SCOPES, WAKES } from "./external-members.js";
import { t } from "./i18n.js";

// { wake, confined }, and in the invited room's rail `duration`: a new loan counted from now, "" keeping the current end.
const KEEP_LOAN = { value: "", label: t("不变") };
const value = defineModel({ type: Object, required: true });
// `confine_reason`: why the chosen software cannot be confined, so it can only run unrestricted.
const props = defineProps({ confine_reason: { type: String, default: "" } });
const set = (changes) => { value.value = { ...value.value, ...changes }; };
const disabled = (option) => option.value && Boolean(props.confine_reason);
</script>

<template>
  <div class="trust-level">
    <div class="trust-row">
      <span class="trust-label">{{ t("被点名时") }}</span>
      <div class="trust-segments" role="radiogroup" :aria-label="t('被点名时')">
        <button v-for="option in WAKES" :key="option.value" type="button" role="radio" :aria-checked="value.wake === option.value" :class="{ 'is-selected': value.wake === option.value }" @click="set({ wake: option.value })">{{ option.label }}</button>
      </div>
    </div>
    <div class="trust-row">
      <span class="trust-label" :title="t('你的 AI 在这台电脑上能做什么：只用共议命令在对方房间里发言，或像平时一样读写本机文件、联网。')">{{ t("本机权限") }}</span>
      <div class="trust-segments" role="radiogroup" :aria-label="t('本机权限')">
        <button v-for="option in SCOPES" :key="String(option.value)" type="button" role="radio" :aria-checked="value.confined === option.value" :class="{ 'is-selected': value.confined === option.value }"
          :disabled="disabled(option)" :title="disabled(option) ? confine_reason : undefined" @click="set({ confined: option.value })">{{ option.label }}</button>
      </div>
    </div>
    <div v-if="'duration' in value" class="trust-row">
      <span class="trust-label" :title="t('从现在起重新计算，最长 3 天')">{{ t("借出时间") }}</span>
      <div class="trust-segments" role="radiogroup" :aria-label="t('借出时间')">
        <button v-for="option in [KEEP_LOAN, ...LEND_DURATIONS]" :key="option.value" type="button" role="radio" :aria-checked="value.duration === option.value" :class="{ 'is-selected': value.duration === option.value }" @click="set({ duration: option.value })">{{ option.label }}</button>
      </div>
    </div>
    <p v-if="!value.confined" class="trust-warning">{{ t("可读本机文件、联网；对方房间的内容可能诱导它这样做。") }}</p>
  </div>
</template>

<style scoped>
.trust-level { display: flex; flex-direction: column; gap: 10px; min-width: 0; font-size: 12px; container-type: inline-size; }
.trust-row { display: flex; align-items: center; gap: 8px; color: var(--ui-text-toned); }
.trust-label { flex: 0 0 72px; color: var(--ui-text-toned); }
/* Options share the row equally, so both rows line up whatever the labels. */
.trust-segments { display: flex; flex: 1; min-width: 0; gap: 3px; padding: 3px; border-radius: 6px; background: var(--ui-bg-muted); }
.trust-segments button { flex: 1 1 0; min-width: 0; min-height: 26px; padding: 0 8px; border-radius: 4px; font-size: 12px; color: var(--ui-text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* A narrow rail puts each label above its options instead of squeezing them beside it (user 2026-11-19, #5446). */
@container (max-width: 320px) {
  .trust-row { flex-direction: column; align-items: stretch; gap: 6px; }
  .trust-label { flex: none; color: var(--ui-text-muted); }
}
.trust-segments button.is-selected { color: var(--ui-text-highlighted); background: var(--ui-bg-elevated); box-shadow: var(--channel-shadow-control); }
.trust-segments button:disabled { opacity: .45; cursor: not-allowed; }
.trust-warning { margin: 0; color: var(--ui-warning, #e0a33a); font-size: 12px; }
@media (pointer: coarse) { .trust-segments button { min-height: 36px; } }
</style>

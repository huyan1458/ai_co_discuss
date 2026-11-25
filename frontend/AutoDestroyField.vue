<script setup>
// The auto-destroy choice, shared by the new-room panel and the room page so both offer the same options.
// With a title it lays out like the other limit fields in the new-room panel: title and control on one row, the help below.
import { t } from "./i18n.js";

defineProps({ disabled: { type: Boolean, default: false }, title: { type: String, default: "" } });
const days = defineModel({ type: Number, default: 0 });
const options = [0, 1, 7, 30].map((value) => ({ value, label: value === 1 ? t("1 天") : value ? t("{days} 天", { days: value }) : t("长期保留") }));
</script>

<template>
  <span v-if="title" class="destroy-field">
    <span class="destroy-field-row">
      <span class="destroy-field-title">{{ title }}</span>
      <USelect v-model="days" :items="options" size="sm" class="destroy-field-select" :aria-label="title" :disabled="disabled" />
    </span>
    <small class="destroy-field-help">{{ t("房间无活动达到所选天数后自动销毁；有新消息或私聊会重新计时。") }}</small>
  </span>
  <USelect v-else v-model="days" :items="options" size="sm" class="destroy-field-select" :aria-label="t('无活动多久后自动销毁')" :disabled="disabled" />
</template>

<style scoped>
.destroy-field { display: flex; flex-direction: column; gap: 4px; }
.destroy-field-row { display: flex; align-items: center; justify-content: space-between; gap: 4px 12px; min-height: 28px; }
.destroy-field-title { color: var(--ui-text); font-size: 13px; }
.destroy-field-select { min-width: 96px; }
.destroy-field-help { color: var(--ui-text-muted); font-size: 12px; line-height: 1.6; }
</style>

<script setup>
// The auto-destroy choice, shared by the new-room panel and the room page so both offer the same options.
import { t } from "./i18n.js";

defineProps({ disabled: { type: Boolean, default: false } });
const days = defineModel({ type: Number, default: 0 });
const options = [0, 1, 7, 30].map((value) => ({ value, label: value ? t("无活动 {days} 天后销毁", { days: value }) : t("长期保留") }));
</script>

<template>
  <USelect v-model="days" :items="options" size="sm" :aria-label="t('自动销毁')" :disabled="disabled" />
</template>

<script setup>
/**
 * Sets up the API of a platform that is not configured yet, opened from its grey chip in the add row. The key is saved
 * as it is entered; leaving without one puts the platform's draft back as it was.
 */
import { computed, inject, watch } from "vue";
import ApiSettings from "./ApiSettings.vue";
import { t } from "./i18n.js";

/** The platform being set up; empty while closed. */
const platform = defineModel({ type: String, default: "" });
const { view, bridge } = inject("discussion");
let draft = {};
watch(platform, (name) => {
  if (!name) return;
  // A copy: choosing the API below changes the profile in place.
  draft = JSON.parse(JSON.stringify(view.value.launch.profiles[name] || {}));
  bridge.write_launch(name, "adapter", "api");
}, { immediate: true });
const has_local = computed(() => bridge.launch_clients[platform.value]?.some((item) => item.value !== "api"));

function finish() {
  if (!platform.value) return;
  if (!bridge.platform_configured(platform.value)) bridge.restore_launch_profile(platform.value, draft);
  platform.value = "";
}
</script>

<template>
  <UModal :open="Boolean(platform)" :title="t('配置 {value1}', { value1: platform ? bridge.default_name(platform) : '' })" :description="t('填写 API Key 后即可添加。')"
    :content="{ onInteractOutside: (event) => event.preventDefault() }" :ui="{ content: 'glass-panel studio-modal', body: 'dialog-body' }" @update:open="$event || finish()">
    <template #body>
      <ApiSettings v-if="platform" :name="platform" />
      <p v-if="has_local" class="fine-print">{{ t('也可以在这台电脑安装 {value1} 后运行 codiscuss setup。', { value1: bridge.default_name(platform) }) }}</p>
    </template>
    <template #footer><UButton :label="t('完成')" class="ml-auto" @click="finish" /></template>
  </UModal>
</template>

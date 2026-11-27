<script setup>
/**
 * A key field shared by the API member card and the management panel. The entered key stays only in this component's
 * memory and is saved once input is committed (blur or Enter); a key saved earlier is never sent back, so a masked mark
 * stands in for it. Remount it (`:key`) when the key it stands for changes, e.g. another address or account.
 *
 * Props:
 *   save: async (key) => void, persists the key; a rejection is passed on as the `error` event.
 *   saved: whether a key is already stored. disabled: whether committing saves nothing.
 */
import { ref } from "vue";
import { t } from "./i18n.js";

const props = defineProps({ save: { type: Function, required: true }, saved: Boolean, disabled: Boolean,
  label: { type: String, default: "API Key" }, placeholder: { type: String, default: "" }, size: { type: String, default: "xs" } });
const emit = defineEmits(["error"]);
const SAVED_MARK = "••••••••••••";
const value = ref(""), visible = ref(false), saving = ref(false), saved_value = ref("");

async function commit() {
  if (!value.value.trim() || value.value === saved_value.value || props.disabled || saving.value) return;
  saving.value = true;
  try { await props.save(value.value); saved_value.value = value.value; }
  catch (failure) { emit("error", failure); }
  finally { saving.value = false; }
}
</script>

<template>
  <!-- A text field masked by CSS keeps browsers from offering to generate or save a password. -->
  <UInput v-model="value" type="text" autocomplete="off" spellcheck="false" data-1p-ignore data-lpignore="true" :placeholder="saved ? SAVED_MARK : (placeholder || t('填写 API Key'))" :title="saved && !value ? t('已保存；本机不回传密钥，输入新 Key 可更换') : undefined" :aria-label="label" :size="size" class="w-full" :loading="saving" :ui="{ base: visible ? '' : 'secret-key-masked', trailing: 'pe-0.5' }" @change="commit">
    <template #trailing><UButton :icon="visible ? 'i-lucide-eye' : 'i-lucide-eye-off'" :disabled="!value" :aria-label="visible ? t('隐藏密钥') : t('显示密钥')" :aria-pressed="visible" :size="size" color="neutral" variant="link" @click="visible = !visible" /></template>
  </UInput>
</template>

<style scoped>
:deep(.secret-key-masked) { -webkit-text-security: disc; }
</style>

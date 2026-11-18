<script setup>
/** The button beside a model picker: asks the software again for its models and thinking levels; the list stays until they arrive. */
import { t } from "./i18n.js";

defineProps({ loading: Boolean, disabled: Boolean });
defineEmits(["refresh"]);
</script>

<template>
  <UButton icon="i-lucide-refresh-cw" loading-icon="i-lucide-refresh-cw" size="xs" color="neutral" variant="ghost" class="model-refresh" :loading="loading" :disabled="disabled"
    :aria-label="t('刷新模型列表与思考强度')" :title="t('刷新模型列表与思考强度')" @click.prevent="$emit('refresh')" />
</template>

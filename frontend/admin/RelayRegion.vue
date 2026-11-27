<script setup>
/**
 * Compact region picker in the self-hosted relay row under This computer. Saving
 * moves the computer and paired devices to the new relay object; they reconnect by themselves. The region codes are
 * Cloudflare location hints and the site checks them again.
 */
import { computed, inject, ref } from "vue";
import { call } from "./api.js";
import { t } from '../i18n.js';

const { state, reload, notify } = inject("panel");
const busy = ref(false);
const items = computed(() => [
  { value: 'auto', label: t('自动') },
  { value: 'apac', label: t('亚太') },
  { value: 'apac-ne', label: t('亚太东北部') },
  { value: 'apac-se', label: t('亚太东南部') },
  { value: 'wnam', label: t('北美西部') },
  { value: 'enam', label: t('北美东部') },
  { value: 'weur', label: t('欧洲西部') },
  { value: 'eeur', label: t('欧洲东部') },
  { value: 'oc', label: t('大洋洲') },
  { value: 'sam', label: t('南美洲') },
  { value: 'afr', label: t('非洲') },
  { value: 'me', label: t('中东') },
]);
const current = computed(() => state.value.relay_region || 'apac');

async function choose(region) {
  if (region === current.value) return;
  busy.value = true;
  try {
    await call('site/region', { region });
    notify('info', t('电脑和已配对设备会自动重连到新的中转位置'));
    await reload();
  } catch (failure) { notify('error', failure.message); }
  finally { busy.value = false; }
}
</script>

<template>
  <USelect :model-value="current" :items="items" icon="i-lucide-map-pin" size="sm" :disabled="busy" class="relay-region"
    :aria-label="t('中转地区')" :title="t('中转地区：请在没有操作进行时切换。')" @update:model-value="choose" />
</template>

<style>
.relay-region { min-width: 128px; }
</style>

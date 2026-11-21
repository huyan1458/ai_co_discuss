<script setup>
import { inject, ref } from 'vue';
import { t } from '../i18n.js';
import { call } from './api.js';

defineProps({ disabled: Boolean });
const { state, reload, notify } = inject('panel');
const busy = ref(false);

async function reconnect() {
  busy.value = true;
  try {
    await call('site/reconnect', {});
    notify('info', t('已请求重连中转'));
    await reload();
  } catch (failure) { notify('error', failure.message); }
  finally { busy.value = false; }
}
</script>

<template>
  <button v-if="state.online_site && state.service?.pid && (state.relay_health?.state !== 'connected' || state.relay_health.http_failures)"
    type="button" class="panel-button is-outline is-small" :disabled="disabled || busy" @click="reconnect">{{ t('立即重连') }}</button>
</template>

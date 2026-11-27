<script setup>
import { computed, inject, ref } from 'vue';
import { t } from '../i18n.js';
import { call } from './api.js';

const props = defineProps({ disabled: Boolean, tunnel: Boolean });
const { state, reload, notify } = inject('panel');
const busy = ref(false);

const reason = computed(() => {
  if (!props.tunnel) return '';
  const entry = state.value.entry;
  if (!entry?.tunnel) return t('请先配置 Cloudflare 隧道');
  if (!entry.tunnel_enabled) return t('请先开启 Cloudflare 隧道');
  return entry.running ? '' : t('请先启动登录入口');
});
async function reconnect() {
  busy.value = true;
  try {
    if (props.tunnel) {
      const status = await call('tunnel/reconnect', {});
      if (status.connected) notify('info', t('隧道已重新连接'));
      else notify('error', t('隧道未在 30 秒内连通，请检查网络和 tunnel.log'));
    } else {
      await call('site/reconnect', {});
      notify('info', t('已请求重连中转'));
    }
    await reload();
  } catch (failure) { notify('error', failure.message); }
  finally { busy.value = false; }
}
</script>

<template>
  <button v-if="tunnel || (state.online_site && state.service?.pid && (state.relay_health?.state !== 'connected' || state.relay_health.http_failures))"
    type="button" class="panel-button is-outline is-small" :disabled="disabled || busy || Boolean(reason)" @click="reconnect">{{ busy ? t('正在重新连接…') : tunnel ? t('重新连接') : t('立即重连') }}</button>
  <small v-if="reason" class="panel-sub">{{ reason }}</small>
</template>

<script setup>
import { computed, inject, ref } from 'vue';
import { t } from '../i18n.js';
import { call } from './api.js';

const props = defineProps({ disabled: Boolean, tunnel: Boolean });
const { state, reload, notify } = inject('panel');
const busy = ref(false);
const idle_label = computed(() => props.tunnel ? t('重新连接') : t('立即重连'));

const reason = computed(() => {
  if (!props.tunnel) {
    if (!state.value.online_site) return t('请先绑定线上网站');
    if (!state.value.service?.pid) return t('请先启动本机服务');
    const health = state.value.relay_health;
    return health?.state === 'connected' && !health.http_failures ? t('中转已连接') : '';
  }
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
  <span class="relay-reconnect" :title="reason || undefined">
    <button type="button" class="panel-button is-outline is-small" :disabled="disabled || busy || Boolean(reason)"
      :aria-description="reason || undefined" @click="reconnect">
      <span aria-hidden="true">{{ t('正在重新连接…') }}</span>
      <span aria-hidden="true">{{ idle_label }}</span>
      <span>{{ busy ? t('正在重新连接…') : idle_label }}</span>
    </button>
  </span>
</template>

<style scoped>
.relay-reconnect { display: inline-flex; flex: none; }
.relay-reconnect > button { display: inline-grid; text-align: center; white-space: nowrap; }
.relay-reconnect > button > span { grid-area: 1 / 1; }
.relay-reconnect > button > span[aria-hidden] { visibility: hidden; }
</style>

<script setup>
/**
 * The administrator's three ways in: the local page, the online site reached from paired devices, and the owner's domain,
 * which is not offered because the local page has no sign-in of its own to put on the internet. Binding to the online
 * site lives in "本机 → 线上网站" (#5494), since more than this entry needs it.
 */
import { computed, inject } from "vue";
import { call } from "./api.js";
import EntryWayCard from "./EntryWayCard.vue";
import { t } from '../i18n.js';

const { state, notify } = inject("panel");
const service = computed(() => state.value.service || {});
const online_site = computed(() => state.value.online_site || "");

/** Open the local page in the default browser; the panel makes the link, which a protected site requires. */
async function open_local() {
  try { await call("service/open", {}); } catch (failure) { notify("error", failure.message); }
}
</script>

<template>
  <div class="entry-grid">
    <EntryWayCard icon="i-lucide-monitor" :title="t('本地网页')" :active="Boolean(service.url)" :tag="service.url ? t('可用') : t('未运行')" :tone="service.url ? 'is-green' : 'is-gray'"
      :note="t('在这台电脑上打开，不需要账号。')" :value="service.url">
      <template #actions>
        <button v-if="service.url" type="button" class="panel-button is-outline is-small" @click="open_local"><UIcon name="i-lucide-external-link" />{{ t('打开') }}</button>
      </template>
    </EntryWayCard>
    <EntryWayCard icon="i-lucide-cloud" :title="t('线上网站')" :active="Boolean(online_site)" :tag="!online_site ? t('未绑定') : service.running ? t('可用') : t('未运行')" :tone="online_site && service.running ? 'is-green' : 'is-gray'"
      :note="online_site ? t('扫码配对过的设备可以在外面使用这台电脑') : t('需先在“本机 → 线上网站”绑定')" :value="online_site"
      :hint="online_site && !service.running ? t('共议服务未运行，线上网站暂时连不上这台电脑') : ''">
      <template #actions>
        <a v-if="online_site" class="panel-button is-outline is-small" :href="online_site" target="_blank" rel="noopener"><UIcon name="i-lucide-external-link" />{{ t('打开') }}</a>
      </template>
    </EntryWayCard>
    <EntryWayCard icon="i-lucide-globe" :title="t('自有域名')" :tag="t('不支持')" unsupported :note="t('管理员权限最高，不开放到自有域名；在外面请用线上网站。')" />
  </div>
</template>

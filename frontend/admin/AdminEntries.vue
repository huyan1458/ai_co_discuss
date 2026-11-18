<script setup>
/**
 * The administrator's three ways in: the local page, the online site reached from paired devices, and the owner's domain,
 * which is not offered because the local page has no sign-in of its own to put on the internet.
 */
import { computed, inject, ref } from "vue";
import { call } from "./api.js";
import EntryWayCard from "./EntryWayCard.vue";
import { t } from '../i18n.js';

const { state, reload, notify } = inject("panel");
const service = computed(() => state.value.service || {});
const online_site = computed(() => state.value.online_site || "");
const binding = ref(false), unbinding = ref(false), busy = ref("");
const form = ref({ site: "", setup_key: "" });

/** Open the local page in the default browser; the panel makes the link, which a protected site requires. */
async function open_local() {
  try { await call("service/open", {}); } catch (failure) { notify("error", failure.message); }
}

function start_binding() {
  form.value = { site: "", setup_key: "" };
  binding.value = true;
}

/** Run one change to the online site, then show where it left things. */
async function change(action, body, message) {
  busy.value = action;
  try {
    await call(`site/${action}`, body);
    notify("info", message);
    binding.value = unbinding.value = false;
    await reload();
  } catch (failure) { notify("error", failure.message); }
  finally { busy.value = ""; }
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
    <EntryWayCard icon="i-lucide-cloud" :title="t('线上网站')" :active="Boolean(online_site)" :tag="online_site ? t('已绑定') : t('未绑定')" :tone="online_site ? 'is-green' : 'is-gray'"
      :note="t('绑定后，扫码配对过的设备可以在外面使用这台电脑')" :value="online_site" :hint="online_site && !service.running ? t('共议服务未运行，线上网站暂时连不上这台电脑') : ''">
      <template #actions>
        <template v-if="online_site">
          <button type="button" class="panel-button is-plain is-small is-danger" :disabled="Boolean(busy)" @click="unbinding = true">{{ t('解绑') }}</button>
          <a class="panel-button is-outline is-small" :href="online_site" target="_blank" rel="noopener"><UIcon name="i-lucide-external-link" />{{ t('打开') }}</a>
        </template>
        <button v-else type="button" class="panel-button is-primary is-small" @click="start_binding"><UIcon name="i-lucide-link" />{{ t('绑定') }}</button>
      </template>
    </EntryWayCard>
    <EntryWayCard icon="i-lucide-globe" :title="t('自有域名')" :tag="t('不支持')" unsupported :note="t('管理员权限最高，不开放到自有域名；在外面请用线上网站。')" />
  </div>

  <UModal :open="binding" :title="t('绑定线上网站')" :description="t('你部署的共议线上网站，绑定后在本地网页的“设置”里给手机等设备配对')" @update:open="(open) => !open && (binding = false)">
    <template #body>
      <form class="admin-entry-form" @submit.prevent="change('connect', { site: form.site.trim(), setup_key: form.setup_key.trim() }, t('已绑定线上网站'))">
        <label class="panel-field">{{ t('站点地址') }}<input v-model="form.site" class="panel-input" placeholder="https://xxx.pages.dev" spellcheck="false" /></label>
        <label class="panel-field">{{ t('绑定令牌') }}<input v-model="form.setup_key" class="panel-input" autocomplete="off" spellcheck="false" />
          <small>{{ t('在部署这个网站的电脑上运行 codiscuss token 获得，只能用一次；就在那台电脑上绑定时可以不填') }}</small></label>
        <div class="panel-form-foot">
          <button type="button" class="panel-button is-plain" @click="binding = false">{{ t('取消') }}</button>
          <button type="submit" class="panel-button is-primary" :disabled="!form.site.trim() || Boolean(busy)"><UIcon v-if="busy === 'connect'" name="i-lucide-loader" class="animate-spin" />{{ t('绑定') }}</button>
        </div>
      </form>
    </template>
  </UModal>

  <UModal :open="unbinding" :title="t('解绑线上网站')" @update:open="(open) => !open && (unbinding = false)">
    <template #body>
      <p class="panel-note"><UIcon name="i-lucide-triangle-alert" />{{ t('解绑后，已配对的设备不能再从 {value1} 连到这台电脑；之后重新绑定需要新的绑定令牌。', { value1: online_site }) }}</p>
      <div class="panel-form-foot">
        <button type="button" class="panel-button is-plain" @click="unbinding = false">{{ t('取消') }}</button>
        <button type="button" class="panel-button is-primary" :disabled="Boolean(busy)" @click="change('disconnect', {}, t('已解绑线上网站'))"><UIcon v-if="busy === 'disconnect'" name="i-lucide-loader" class="animate-spin" />{{ t('解绑') }}</button>
      </div>
    </template>
  </UModal>
</template>

<style scoped>
.admin-entry-form { display: flex; flex-direction: column; gap: 12px; }
</style>

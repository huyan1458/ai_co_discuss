<script setup>
/**
 * This computer's binding to the online site, in one place (user 2026-11-19, #5494). Its explanation says only what is
 * true here, by the routes this computer actually takes (#5786): hosted accounts go through the owner's own domain while
 * it is on and through this binding only without one. Bind with an access code (on the computer that deployed the site,
 * its address alone), unbind, and on that computer make access codes for others.
 */
import { computed, inject, ref, watch } from "vue";
import { call } from "./api.js";
import RelayRegion from "./RelayRegion.vue";
import RelayReconnect from "./RelayReconnect.vue";
import { t } from '../i18n.js';
import { relay_health_text } from '../../runner/relay_health_text.mjs';

const { state, reload, notify, binding } = inject("panel");
const site = computed(() => state.value.online_site || "");
const relay = computed(() => relay_health_text(site.value, state.value.relay_health, t));
// The own domain counts as on as the hosted accounts' entry cards judge it (HostingCards.vue): set up and switched on.
const own_domain = computed(() => Boolean(state.value.entry?.tunnel_enabled && state.value.entry?.tunnel));
const usage = computed(() => !state.value.hosting ? t('在外面用其他设备使用这台电脑、邀请外部专家时需要')
  // With the relay on beside the domain, accounts get the domain's address yet the relay's still signs them in (#5789).
  : own_domain.value ? (state.value.entry?.relay_enabled ? t('你在外面使用这台电脑、邀请外部专家时经过它；托管账号默认走 Cloudflare 隧道，也可以经它登录')
    : t('只供你自己在外面使用这台电脑、邀请外部专家；托管账号走 Cloudflare 隧道，不经过它'))
    : t('你在外面使用这台电脑，以及托管账号的登录和邀请外部专家，都经过它'));
// The dialog open: "bind", "unbind" or "make".
const dialog = ref(""), busy = ref(""), code = ref("");
const rules = ref([]), new_origin = ref(""), subdomains = ref(false);
async function show_origins() {
  try {
    rules.value = (await call('site/origins')).rules;
    subdomains.value = false;
    new_origin.value = '';
    dialog.value = 'origins';
  } catch (error) { notify('error', error.message); }
}
async function change_origin(action, origin) {
  if (action === 'remove' && !window.confirm(t('移除 {origin}？失去所有规则覆盖的设备和配对码将被撤销。', { origin }))) return;
  if (action === 'add' && !subdomains.value && rules.value.some(rule => rule.subdomains)) {
    let canonical;
    try { canonical = new URL(origin).origin; } catch { /* The API reports invalid addresses. */ }
    if (rules.value.some(rule => rule.subdomains && rule.origin === canonical)
        && !window.confirm(t('改为精确匹配后，失去规则覆盖的设备和配对码将被撤销。继续吗？'))) return;
  }
  busy.value = 'origins';
  try {
    rules.value = (await call('site/origins', { action, origin, subdomains: action === 'add' && subdomains.value })).rules;
    subdomains.value = false;
    new_origin.value = '';
  } catch (error) { notify('error', error.message); }
  finally { busy.value = ''; }
}
const maker = ref({ config: "", site: "", made: "" });

/** Run one change to the binding, then show where it left things. */
async function change(action, body, message) {
  busy.value = action;
  try {
    await call(`site/${action}`, body);
    notify("info", message);
    dialog.value = "";
    await reload();
  } catch (failure) { notify("error", failure.message); }
  finally { busy.value = ""; }
}

function start_binding() {
  code.value = "";
  dialog.value = "bind";
}
// The hosted relay card binds through this same dialog.
watch(binding, () => { if (!site.value) start_binding(); });

/** The access code maker starts from the deployment config and site last used here. */
async function start_making() {
  const saved = await call("site/code").catch(() => ({}));
  maker.value = { config: saved.config || "", site: saved.site || site.value, made: "" };
  dialog.value = "make";
}

async function make() {
  busy.value = "make";
  try { maker.value.made = (await call("site/code", { config: maker.value.config.trim(), site: maker.value.site.trim() })).code; }
  catch (failure) { notify("error", failure.message); }
  finally { busy.value = ""; }
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); notify("info", t('已复制')); } catch { notify("error", t('复制失败，请手动选中复制')); }
}
const close = (open) => { if (!open) dialog.value = ""; };
</script>

<template>
  <div class="panel-row">
    <div class="panel-tile"><UIcon name="i-lucide-cloud" /></div>
    <div class="panel-main">
      <div class="panel-title">{{ t('自建中转') }} <span class="panel-tag" :class="relay.tone">{{ relay.label }}</span></div>
      <span class="panel-sub"><template v-if="site">{{ site }} · </template>{{ usage }}</span>
      <span class="panel-sub site-relay-detail" :title="relay.detail || undefined">{{ relay.detail }}</span>
    </div>
    <div class="panel-side">
      <template v-if="site">
        <RelayRegion />
        <button type="button" class="panel-button is-plain is-small" @click="show_origins">{{ t('其他访问地址') }}</button>
        <RelayReconnect :disabled="Boolean(busy)" />
        <button type="button" class="panel-button is-plain is-small" :disabled="Boolean(busy)" :title="t('在部署线上网站的电脑上，为其他电脑生成绑定用的接入码')" @click="start_making"><UIcon name="i-lucide-ticket" />{{ t('生成接入码') }}</button>
        <button type="button" class="panel-button is-plain is-small is-danger" :disabled="Boolean(busy)" @click="dialog = 'unbind'">{{ t('解绑') }}</button>
      </template>
      <button v-else type="button" class="panel-button is-primary is-small" @click="start_binding"><UIcon name="i-lucide-link" />{{ t('绑定') }}</button>
    </div>
  </div>

  <UModal :open="dialog === 'origins'" :title="t('其他访问地址')" :description="t('这个地址的服务器负责提供网页，能使用在此配对的设备权限。只添加你信任的地址。')" @update:open="close">
    <template #body>
      <form class="site-form" @submit.prevent="change_origin('add', new_origin)">
        <div v-for="rule in rules" :key="rule.origin" class="panel-row"><span class="panel-main">{{ rule.origin }} <small v-if="rule.subdomains">{{ t('包含子域名') }}</small></span>
          <button type="button" class="panel-button is-plain is-small" :disabled="Boolean(busy)" @click="change_origin('remove', rule.origin)">{{ t('移除') }}</button>
        </div>
        <label class="panel-field">{{ t('配对地址') }}<input v-model="new_origin" required type="url" class="panel-input" placeholder="https://relay.example.com"></label>
        <label><input v-model="subdomains" type="checkbox"> {{ t('包含子域名') }}</label>
        <small v-if="subdomains">{{ t('该域名下任何子站被他人控制，都可能导致在那里配对的设备权限被使用。每个子域名仍需单独配对。') }}</small>
        <div class="panel-form-foot"><button type="submit" class="panel-button is-primary" :disabled="!new_origin.trim() || Boolean(busy)">{{ t('添加') }}</button></div>
      </form>
    </template>
  </UModal>
  <UModal :open="dialog === 'bind'" :title="t('绑定自建中转')" :description="t('填写接入码，或在部署电脑上填写线上网站地址（如 https://xxx.pages.dev）')" @update:open="close">
    <template #body>
      <form class="site-form" @submit.prevent="change('connect', { site: code.trim() }, t('已绑定自建中转'))">
        <label class="panel-field">{{ t('接入码') }}<textarea v-model="code" class="panel-input site-code" rows="3" placeholder="https://xxx.pages.dev/#codiscuss-bind=…" autocomplete="off" spellcheck="false"></textarea>
          <small>{{ t('在部署线上网站的电脑上生成（它的管理面板“本机 → 自建中转 → 生成接入码”，或运行 codiscuss admin entry code），只能用一次。就在那台电脑上绑定时，只填线上网站地址即可。') }}</small></label>
        <div class="panel-form-foot">
          <button type="button" class="panel-button is-plain" @click="dialog = ''">{{ t('取消') }}</button>
          <button type="submit" class="panel-button is-primary" :disabled="!code.trim() || Boolean(busy)"><UIcon v-if="busy === 'connect'" name="i-lucide-loader" class="animate-spin" />{{ t('绑定') }}</button>
        </div>
      </form>
    </template>
  </UModal>

  <UModal :open="dialog === 'unbind'" :title="t('解绑自建中转')" @update:open="close">
    <template #body>
      <p class="panel-note"><UIcon name="i-lucide-triangle-alert" />{{ t('解绑后，已配对的设备不能再从 {value1} 连到这台电脑；之后重新绑定需要新的绑定令牌。', { value1: site }) }}</p>
      <div class="panel-form-foot">
        <button type="button" class="panel-button is-plain" @click="dialog = ''">{{ t('取消') }}</button>
        <button type="button" class="panel-button is-primary" :disabled="Boolean(busy)" @click="change('disconnect', {}, t('已解绑自建中转'))"><UIcon v-if="busy === 'disconnect'" name="i-lucide-loader" class="animate-spin" />{{ t('解绑') }}</button>
      </div>
    </template>
  </UModal>

  <UModal :open="dialog === 'make'" :title="t('生成接入码')" :description="t('在部署线上站点的电脑上用')" @update:open="close">
    <template #body>
      <div class="site-form">
        <label class="panel-field">{{ t('部署配置') }}<input v-model="maker.config" class="panel-input" placeholder="D:\…\ai_co_discuss\.wrangler\deploy\wrangler.jsonc" spellcheck="false" />
          <small>{{ t('源码仓库里线上站点的私有部署配置；这台电脑须已登录 wrangler。') }}</small></label>
        <label class="panel-field">{{ t('线上网站地址') }}<input v-model="maker.site" class="panel-input" placeholder="https://xxx.pages.dev" spellcheck="false" /></label>
        <div v-if="maker.made" class="panel-secret site-made"><span>{{ maker.made }}</span>
          <button type="button" class="panel-icon-button" :aria-label="t('复制接入码')" @click="copy(maker.made)"><UIcon name="i-lucide-copy" /></button></div>
        <small v-if="maker.made" class="site-hint">{{ t('发给要绑定的电脑，在它的管理面板“本机 → 自建中转 → 绑定”里粘贴。只能用一次；再生成一个会让之前没用过的作废。') }}</small>
        <div class="panel-form-foot">
          <button type="button" class="panel-button is-plain" @click="dialog = ''">{{ t('关闭') }}</button>
          <button type="button" class="panel-button is-primary" :disabled="!maker.config.trim() || !maker.site.trim() || Boolean(busy)" @click="make">
            <UIcon v-if="busy === 'make'" name="i-lucide-loader" class="animate-spin" />{{ t('生成') }}</button>
        </div>
      </div>
    </template>
  </UModal>
</template>

<style scoped>
.site-relay-detail { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; block-size: 2lh; }
.site-form { display: flex; flex-direction: column; gap: 12px; }
.site-code { height: 72px; padding: 10px 14px; resize: none; font-family: ui-monospace, Consolas, monospace; font-size: 12px; word-break: break-all; }
.site-made { font-size: 12px; letter-spacing: 0; }
.site-made span { overflow-wrap: anywhere; }
.site-hint { color: var(--panel-faint); font-size: 12px; }
</style>

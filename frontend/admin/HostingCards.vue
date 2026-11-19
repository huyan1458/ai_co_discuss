<script setup>
/**
 * This computer's parts of hosting, shown on the overview with hosting on: the entry hosted accounts sign in at, with the
 * ways people reach it from other devices (the online relay without a domain, or a Cloudflare tunnel from the owner's own
 * domain, each prepared in its own dialog), and the copy of the programs accounts with their own Windows user run. The
 * entry's own port listens on this computer alone and is never an address to give anyone (user 2026-11-18, #4720).
 */
import { computed, inject, ref } from "vue";
import { call } from "./api.js";
import EntryWayCard from "./EntryWayCard.vue";
import TunnelDialog from "./TunnelDialog.vue";
import { t } from '../i18n.js';

const { state, reload, notify } = inject("panel");
const installing = ref(false);
const runtime = computed(() => state.value.clis || {});
const PARTS = [["claude", "Claude Code"], ["codex", "Codex"], ["agy", "Antigravity"], ["app", t('共议')], ["python", "Python"]];
const runtime_ready = computed(() => PARTS.every(([key]) => runtime.value[key]));
const runtime_stale = computed(() => runtime.value.app && runtime.value.app_version && runtime.value.app_version !== state.value.version);
const runtime_outdated = computed(() => runtime.value.outdated || []);
// An update of this program syncs the copy by itself: the row appears only when something is left for the owner to do.
const runtime_needs_owner = computed(() => !runtime_ready.value || runtime_stale.value || runtime_outdated.value.length > 0);
const entry = computed(() => state.value.entry || { running: false, port: 0, public_url: "", relay_enabled: false, tunnel_enabled: false, relay: {} });
const entry_busy = ref(""), tunnel_open = ref(false);
const WAYS = [
  { key: "relay", icon: "i-lucide-cloud", label: t('经线上网站中转'), note: t('不需要域名：经共议线上网站中转到这台电脑，手机和外地的电脑都能打开。需要这台电脑已在“本机 → 线上网站”绑定。'), turned_on: t('已开启经线上网站中转'), turned_off: t('已关闭经线上网站中转') },
  { key: "tunnel", icon: "i-lucide-globe", label: t('自有域名'), note: t('用你托管在 Cloudflare 的域名，经 Cloudflare 隧道连到这台电脑。需要有自己的域名。'), turned_on: t('已开启自有域名'), turned_off: t('已关闭自有域名') },
];
const enabled = (way) => Boolean(entry.value[`${way}_enabled`]);
const ways_on = computed(() => WAYS.filter((item) => enabled(item.key)));
// With both on, new accounts are given the owner's domain: direct, and outside the Workers quota.
const default_way = computed(() => (ways_on.value.length > 1 ? "tunnel" : ""));
// The relay needs this computer bound to an online site (its entry address is fetched on turning it on); the tunnel, its setup.
// The relay needs only the computer's binding ("本机 → 线上网站", #5494); turning it on fetches the entry address itself.
const prepared = (way) => (way === "relay" ? Boolean(state.value.online_site) : Boolean(entry.value.tunnel));
// The tunnel as cloudflared reports it: connected to Cloudflare, running but not (yet) connected, or not running.
// Shown on a way that is on until the panel's check over the network answers.
const CHECKING = { label: t('检查中…'), tag: "is-gray", hint: "" };
const tunnel_state = computed(() => {
  if (!entry.value.checked) return CHECKING;
  const tunnel = entry.value.tunnel;
  if (tunnel?.connected) return { label: t('已连接'), tag: "is-green", hint: "" };
  if (tunnel?.running) return { label: t('连接中'), tag: "is-amber", hint: t('cloudflared 已运行但还没连上 Cloudflare：刚启动时稍等片刻；持续如此请检查网络与代理是否放行 *.cloudflare.com、*.argotunnel.com，日志在数据目录 tunnel.log') };
  return { label: t('未运行'), tag: "is-amber", hint: entry.value.running ? t('管理面板每分钟会自动拉起一次；持续如此请查看数据目录 tunnel.log') : t('登录入口启动后隧道随之启动') };
});
// The relay as this computer sees it: usable from outside, or the first thing in the way and what to do (from the panel).
const relay_state = computed(() => {
  if (!entry.value.checked) return CHECKING;
  const problem = entry.value.relay?.problem || "";
  return problem ? { label: t('暂时打不开'), tag: "is-amber", hint: problem } : { label: t('可以访问'), tag: "is-green", hint: "" };
});
// What the row of a way shows under its explanation: its address and state once prepared.
function detail(way) {
  if (way === "relay" && prepared("relay")) {
    // Until turned on there is no entry address yet; the site itself is shown in "本机 → 线上网站".
    return entry.value.relay?.link ? { text: entry.value.relay.link, address: entry.value.relay.link, state: enabled("relay") ? relay_state.value : null } : null;
  }
  if (way === "tunnel" && prepared("tunnel")) return { text: entry.value.public_url, address: entry.value.public_url, state: enabled("tunnel") ? tunnel_state.value : null };
  return null;
}

/** The word on a way's card: whether it is set up and on, and once on whether it can be reached. */
function way_state(way) {
  if (!prepared(way)) return way === "relay" ? { label: t('未绑定'), tag: "is-gray" } : { label: t('未配置'), tag: "is-gray" };
  if (!enabled(way)) return { label: t('未开启'), tag: "is-gray" };
  return detail(way)?.state || { label: t('已开启'), tag: "is-green" };
}

/** Start or stop the entry, or turn one way from outside on or off. */
async function entry_act(action, body = {}, message = "", busy = action) {
  entry_busy.value = busy;
  try {
    await call(`entry/${action}`, body);
    if (message) notify("info", message);
    await reload();
  } catch (failure) { notify("error", failure.message); }
  finally { entry_busy.value = ""; }
}

function toggle_way(item, on) {
  entry_act("way", { way: item.key, enabled: on }, on ? item.turned_on : item.turned_off, item.key);
}

function configure() {
  tunnel_open.value = true;
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); notify("info", t('已复制')); } catch { notify("error", t('复制失败，请手动选中复制')); }
}

async function install() {
  installing.value = true;
  try {
    const result = await call("clis/install", {});
    const problems = [...(result.missing || []).map((item) => t('没有找到 {value1}', { value1: item })), ...(result.warnings || [])];
    notify(problems.length ? "warning" : "info", problems.length ? problems.join("；") : t('程序副本已同步'));
    await reload();
  } catch (failure) { notify("error", failure.message); }
  finally { installing.value = false; }
}
</script>

<template>
  <p v-if="!ways_on.length" class="panel-note entry-state"><UIcon name="i-lucide-info" />{{ t('登录入口没有开启线上网站或自有域名，其他设备打不开') }}</p>
  <p v-else-if="!entry.running" class="panel-note is-amber entry-state"><UIcon name="i-lucide-triangle-alert" /><span>{{ t('登录入口未运行，使用者暂时无法登录') }}</span>
    <button type="button" class="panel-button is-primary is-small" :disabled="Boolean(entry_busy)" @click="entry_act('start', {}, t('登录入口已启动'))">{{ t('启动') }}</button></p>
  <div class="entry-grid">
    <EntryWayCard icon="i-lucide-monitor" :title="t('本地网页')" :tag="t('不支持')" unsupported :note="t('托管账号只能从线上网站或自有域名登录。')" />
    <EntryWayCard v-for="item in WAYS" :key="item.key" :icon="item.icon" :title="item.label" :active="enabled(item.key)" :tag="way_state(item.key).label" :tone="way_state(item.key).tag"
      :mark="item.key === default_way ? t('默认') : ''" :note="item.key === 'relay' && prepared('relay') ? t('不需要域名：经共议线上网站中转到这台电脑，手机和外地的电脑都能打开。') : item.note" :value="detail(item.key)?.text || ''" :hint="detail(item.key)?.state?.hint || ''">
      <template v-if="prepared(item.key)" #corner>
        <USwitch :model-value="enabled(item.key)" :loading="entry_busy === item.key" :disabled="Boolean(entry_busy)" :aria-label="t('开启或关闭{value1}', { value1: item.label })" @update:model-value="(on) => toggle_way(item, on)" />
      </template>
      <template #actions>
        <button v-if="enabled(item.key) && detail(item.key)?.address" type="button" class="panel-button is-outline is-small" @click="copy(detail(item.key).address)"><UIcon name="i-lucide-copy" />{{ t('复制地址') }}</button>
        <button v-if="item.key === 'tunnel'" type="button" class="panel-button is-small" :class="prepared(item.key) ? 'is-plain' : 'is-outline'" @click="configure"><UIcon :name="prepared(item.key) ? 'i-lucide-pencil' : 'i-lucide-settings-2'" />{{ prepared(item.key) ? t('修改') : t('配置') }}</button>
      </template>
    </EntryWayCard>
  </div>
  <TunnelDialog v-model:open="tunnel_open" />

  <div v-if="runtime_needs_owner" class="panel-rows entry-services">
    <div class="panel-row">
      <div class="panel-tile"><UIcon name="i-lucide-hard-drive-download" /></div>
      <div class="panel-main">
        <div class="panel-title">{{ t('程序副本') }} <span v-if="!runtime.app" class="panel-tag is-gray">{{ t('未安装') }}</span>
          <span v-else-if="runtime_stale" class="panel-tag is-amber">{{ t('v{value1}，落后于本机 v{value2}', { value1: runtime.app_version, value2: state.version }) }}</span>
          <span v-else-if="!runtime_ready" class="panel-tag is-amber">{{ t('缺少 {value1}', { value1: PARTS.filter(([key]) => !runtime[key]).map(([, label]) => label).join("、") }) }}</span>
          <span v-else class="panel-tag is-amber">{{ t('{value1} 有新版本', { value1: runtime_outdated.join("、") }) }}</span></div>
        <span class="panel-sub">{{ t('托管账号从这份副本运行。更新共议时会自动同步；Claude Code 等程序单独升级后，在这里同步一次。') }}</span>
      </div>
      <div class="panel-side">
        <button type="button" class="panel-button is-small is-primary" :disabled="installing" @click="install">
          <UIcon :name="installing ? 'i-lucide-loader' : 'i-lucide-refresh-cw'" :class="{ 'animate-spin': installing }" />{{ runtime.app ? t('同步') : t('安装') }}</button>
      </div>
    </div>
  </div>
</template>


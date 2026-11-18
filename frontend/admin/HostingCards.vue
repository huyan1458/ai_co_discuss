<script setup>
/**
 * This computer's parts of hosting, shown on the overview with hosting on: the entry hosted accounts sign in at, with the
 * three ways people reach it (this computer only, the online relay without a domain, or a Cloudflare tunnel from the
 * owner's own domain; one in use at a time, each prepared in its own dialog), and the copy of the programs accounts with
 * their own Windows user run.
 */
import { computed, inject, ref } from "vue";
import { call, entry_address } from "./api.js";
import RelayDialog from "./RelayDialog.vue";
import TunnelDialog from "./TunnelDialog.vue";
import { t } from '../i18n.js';

const { state, reload, notify } = inject("panel");
const installing = ref(false);
const runtime = computed(() => state.value.clis || {});
const PARTS = [["claude", "Claude Code"], ["codex", "Codex"], ["agy", "Antigravity"], ["app", t('共议')], ["python", "Python"]];
const runtime_ready = computed(() => PARTS.every(([key]) => runtime.value[key]));
const runtime_stale = computed(() => runtime.value.app && runtime.value.app_version && runtime.value.app_version !== state.value.version);
const entry = computed(() => state.value.entry || { running: false, port: 0, public_url: "", relay_enabled: false, tunnel_enabled: false, relay: {} });
const entry_busy = ref(""), tunnel_open = ref(false), relay_open = ref(false);
const WAYS = [
  { key: "relay", icon: "i-lucide-cloud", label: t('线上中转'), note: t('不需要域名：经共议线上站点中转到这台电脑，手机和外地的电脑都能打开。需要先用接入码接入线上站点。'), turned_on: t('已开启线上中转'), turned_off: t('已关闭线上中转') },
  { key: "tunnel", icon: "i-lucide-globe", label: t('自有域名'), note: t('用你托管在 Cloudflare 的域名，经 Cloudflare 隧道连到这台电脑。需要有自己的域名。'), turned_on: t('已开启自有域名'), turned_off: t('已关闭自有域名') },
];
const enabled = (way) => Boolean(entry.value[`${way}_enabled`]);
const ways_on = computed(() => WAYS.filter((item) => enabled(item.key)));
// The relay needs this computer bound to an online site (its entry address is fetched on turning it on); the tunnel, its setup.
const prepared = (way) => (way === "relay" ? Boolean(entry.value.relay?.site) : Boolean(entry.value.tunnel));
// The tunnel as cloudflared reports it: connected to Cloudflare, running but not (yet) connected, or not running.
const tunnel_state = computed(() => {
  const tunnel = entry.value.tunnel;
  if (tunnel?.connected) return { label: t('已连接'), tag: "is-green", hint: "" };
  if (tunnel?.running) return { label: t('连接中'), tag: "is-amber", hint: t('cloudflared 已运行但还没连上 Cloudflare：刚启动时稍等片刻；持续如此请检查网络与代理是否放行 *.cloudflare.com、*.argotunnel.com，日志在数据目录 tunnel.log') };
  return { label: t('未运行'), tag: "is-amber", hint: entry.value.running ? t('管理面板每分钟会自动拉起一次；持续如此请查看数据目录 tunnel.log') : t('登录入口启动后隧道随之启动') };
});
// The relay as this computer sees it: usable from outside, or the first thing in the way and what to do (from the panel).
const relay_state = computed(() => {
  const problem = entry.value.relay?.problem || "";
  return problem ? { label: t('暂时打不开'), tag: "is-amber", hint: problem } : { label: t('可以访问'), tag: "is-green", hint: "" };
});
// What the row of a way shows under its explanation: its address and state once prepared.
function detail(way) {
  if (way === "relay" && prepared("relay")) {
    return entry.value.relay?.link ? { text: entry.value.relay.link, address: entry.value.relay.link, state: enabled("relay") ? relay_state.value : null } : { text: t('已接入 {value1}，开启时取得入口地址', { value1: entry.value.relay.site }) };
  }
  if (way === "tunnel" && prepared("tunnel")) return { text: entry.value.public_url, address: entry.value.public_url, state: enabled("tunnel") ? tunnel_state.value : null };
  return null;
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

function configure(way) {
  if (way === "relay") relay_open.value = true; else tunnel_open.value = true;
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
  <h3 class="panel-section-title"><UIcon name="i-lucide-users" />{{ t('托管') }}</h3>
  <p class="panel-guide">{{ t('托管账号的使用者打开登录入口，用账号名和密码进入各自的工作台。账号在“账号”页创建和管理。') }}</p>
  <div class="panel-rows">
    <div class="panel-row">
      <div class="panel-tile"><UIcon name="i-lucide-door-open" /></div>
      <div class="panel-main">
        <div class="panel-title">{{ t('登录入口') }} <span class="panel-tag" :class="entry.running ? 'is-green' : 'is-gray'">{{ entry.running ? t('运行中') : t('已停止') }}</span>
          <span v-for="item in ways_on" :key="item.key" class="panel-tag is-blue">{{ item.label }}</span>
          <span v-if="!ways_on.length" class="panel-tag is-blue">{{ t('仅这台电脑') }}</span></div>
        <span class="panel-sub">{{ t('把这个地址发给使用者：') }}<a class="panel-link" :href="entry_address(entry)" target="_blank" rel="noopener">{{ entry_address(entry) }}</a></span>
      </div>
      <div class="panel-side">
        <button type="button" class="panel-button is-plain is-small" @click="copy(entry_address(entry))"><UIcon name="i-lucide-copy" />{{ t('复制地址') }}</button>
        <button v-if="!entry.running" type="button" class="panel-button is-primary is-small" :disabled="Boolean(entry_busy)" @click="entry_act('start', {}, t('登录入口已启动'))">
          <UIcon :name="entry_busy === 'start' ? 'i-lucide-loader' : 'i-lucide-play'" :class="{ 'animate-spin': entry_busy === 'start' }" />{{ t('启动') }}</button>
        <button v-else type="button" class="panel-button is-plain is-small is-danger" :disabled="Boolean(entry_busy)" @click="entry_act('stop', {}, t('登录入口已停止'))">
          <UIcon :name="entry_busy === 'stop' ? 'i-lucide-loader' : 'i-lucide-square'" :class="{ 'animate-spin': entry_busy === 'stop' }" />{{ t('停止') }}</button>
      </div>
    </div>
    <div class="entry-ways">
      <p class="entry-ways-title">{{ t('访问方式') }}<small>{{ t('使用者从哪里打开登录入口。线上中转和自有域名可以同时开启；都开启时，默认发给使用者自有域名的地址。') }}</small></p>
      <div class="entry-way">
        <UIcon name="i-lucide-monitor" class="entry-way-icon" />
        <div class="entry-way-main">
          <div class="entry-way-title">{{ t('这台电脑') }}</div>
          <span class="entry-way-note">{{ t('登录入口运行时，在这台电脑上总能打开，不需要开启。') }}</span>
          <span class="entry-way-value">http://127.0.0.1:{{ entry.port }}</span>
        </div>
      </div>
      <div v-for="item in WAYS" :key="item.key" class="entry-way" :class="{ 'is-active': enabled(item.key) }">
        <UIcon :name="item.icon" class="entry-way-icon" />
        <div class="entry-way-main">
          <div class="entry-way-title">{{ item.label }}
            <span v-if="!prepared(item.key)" class="panel-tag is-gray">{{ t('未配置') }}</span></div>
          <span class="entry-way-note">{{ item.note }}</span>
          <span v-if="detail(item.key)" class="entry-way-value">{{ detail(item.key).text }}
            <span v-if="detail(item.key).state" class="panel-tag" :class="detail(item.key).state.tag" :title="detail(item.key).state.hint">{{ detail(item.key).state.label }}</span></span>
          <small v-if="detail(item.key)?.state?.hint" class="entry-way-hint">{{ detail(item.key).state.hint }}</small>
        </div>
        <div class="panel-side">
          <button v-if="enabled(item.key) && detail(item.key)?.address" type="button" class="panel-button is-plain is-small" @click="copy(detail(item.key).address)"><UIcon name="i-lucide-copy" />{{ t('复制地址') }}</button>
          <button v-if="prepared(item.key)" type="button" class="panel-button is-plain is-small" @click="configure(item.key)"><UIcon name="i-lucide-pencil" />{{ t('修改') }}</button>
          <button v-else type="button" class="panel-button is-plain is-small" @click="configure(item.key)"><UIcon name="i-lucide-settings-2" />{{ t('配置') }}</button>
          <USwitch v-if="prepared(item.key)" :model-value="enabled(item.key)" :loading="entry_busy === item.key" :disabled="Boolean(entry_busy)" :aria-label="t('开启或关闭{value1}', { value1: item.label })" @update:model-value="(on) => toggle_way(item, on)" />
        </div>
      </div>
    </div>
    <TunnelDialog v-model:open="tunnel_open" />
    <RelayDialog v-model:open="relay_open" />

    <div class="panel-row">
      <div class="panel-tile"><UIcon name="i-lucide-hard-drive-download" /></div>
      <div class="panel-main">
        <div class="panel-title">{{ t('程序副本') }} <span v-if="!runtime.app" class="panel-tag is-gray">{{ t('未安装') }}</span>
          <span v-else-if="runtime_stale" class="panel-tag is-amber">{{ t('v{value1}，落后于本机 v{value2}', { value1: runtime.app_version, value2: state.version }) }}</span>
          <span v-else-if="!runtime_ready" class="panel-tag is-amber">{{ t('缺少 {value1}', { value1: PARTS.filter(([key]) => !runtime[key]).map(([, label]) => label).join("、") }) }}</span>
          <span v-else class="panel-tag is-green"><UIcon name="i-lucide-check" />{{ t('已同步') }}</span></div>
        <span class="panel-sub">{{ t('隔离账号读不到你的个人目录，从 C:\\ProgramData\\CoDiscuss 里的这份副本运行。升级 Claude Code 等程序后点同步；更新共议时会自动同步。') }}</span>
      </div>
      <div class="panel-side">
        <button type="button" class="panel-button is-small" :class="runtime_ready && !runtime_stale ? 'is-plain' : 'is-primary'" :disabled="installing" @click="install">
          <UIcon :name="installing ? 'i-lucide-loader' : 'i-lucide-refresh-cw'" :class="{ 'animate-spin': installing }" />{{ runtime.app ? t('同步') : t('安装') }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.entry-ways { display: flex; flex-direction: column; gap: 8px; padding: 0 0 16px 54px; margin-top: -4px; }
.entry-ways-title { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; margin: 0 0 2px; color: var(--panel-text); font-size: 13px; font-weight: 500; }
.entry-ways-title small { color: var(--panel-faint); font-size: 12px; font-weight: 400; }
.entry-way { display: flex; align-items: flex-start; gap: 12px; padding: 12px 14px; border: 1px solid var(--panel-line); border-radius: 12px; transition: border-color .15s, background-color .15s; }
.entry-way.is-active { border-color: #bfdbfe; background: var(--panel-blue-soft); }
.entry-way-icon { flex-shrink: 0; width: 18px; height: 18px; margin-top: 2px; color: var(--panel-muted); }
.entry-way.is-active .entry-way-icon { color: var(--panel-blue); }
.entry-way-main { display: flex; flex: 1; flex-direction: column; gap: 4px; min-width: 0; }
.entry-way-title { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 14px; font-weight: 600; }
.entry-way-title .panel-tag { height: 20px; padding: 0 7px; }
.entry-way-note { color: var(--panel-muted); font-size: 12px; line-height: 1.6; }
.entry-way-value { overflow: hidden; color: var(--panel-text); font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; font-size: 12px; white-space: nowrap; text-overflow: ellipsis; }
.entry-way-value .panel-tag { height: 20px; margin-left: 8px; padding: 0 7px; font-family: inherit; vertical-align: middle; }
.entry-way-hint { color: var(--panel-amber); font-size: 12px; line-height: 1.5; }
.entry-way .panel-side { align-self: center; }
</style>

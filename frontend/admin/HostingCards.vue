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

const { state, reload, notify } = inject("panel");
const installing = ref(false);
const runtime = computed(() => state.value.clis || {});
const PARTS = [["claude", "Claude Code"], ["codex", "Codex"], ["agy", "Antigravity"], ["app", "共议"], ["python", "Python"]];
const runtime_ready = computed(() => PARTS.every(([key]) => runtime.value[key]));
const runtime_stale = computed(() => runtime.value.app && runtime.value.app_version && runtime.value.app_version !== state.value.version);
const entry = computed(() => state.value.entry || { running: false, port: 0, public_url: "", mode: "local", relay: {} });
const entry_busy = ref(""), tunnel_open = ref(false), relay_open = ref(false);
const MODES = [
  { key: "local", icon: "i-lucide-monitor", label: "仅这台电脑", note: "登录入口只在这台电脑上能打开，适合先自己试用。同一局域网的其他设备也打不开。" },
  { key: "relay", icon: "i-lucide-cloud", label: "线上中转", note: "不需要域名：经共议线上站点中转到这台电脑，手机和外地的电脑都能打开。需要先用接入码接入线上站点。" },
  { key: "tunnel", icon: "i-lucide-globe", label: "自有域名", note: "用你托管在 Cloudflare 的域名，经 Cloudflare 隧道连到这台电脑。需要有自己的域名。" },
];
const current = computed(() => MODES.find((item) => item.key === entry.value.mode) || MODES[0]);
// The relay needs this computer bound to an online site (its entry address is fetched on switching); the tunnel, its setup.
const prepared = (mode) => mode === "local" || (mode === "relay" ? Boolean(entry.value.relay?.site) : Boolean(entry.value.tunnel));
// The tunnel as cloudflared reports it: connected to Cloudflare, running but not (yet) connected, or not running.
const tunnel_state = computed(() => {
  const tunnel = entry.value.tunnel;
  if (tunnel?.connected) return { label: "已连接", tag: "is-green", hint: "" };
  if (tunnel?.running) return { label: "连接中", tag: "is-amber", hint: "cloudflared 已运行但还没连上 Cloudflare：刚启动时稍等片刻；持续如此请检查网络与代理是否放行 *.cloudflare.com、*.argotunnel.com，日志在数据目录 tunnel.log" };
  return { label: "未运行", tag: "is-amber", hint: entry.value.running ? "管理面板每分钟会自动拉起一次；持续如此请查看数据目录 tunnel.log" : "登录入口启动后隧道随之启动" };
});
// The relay as this computer sees it: usable from outside, or the first thing in the way and what to do (from the panel).
const relay_state = computed(() => {
  const problem = entry.value.relay?.problem || "";
  return problem ? { label: "暂时打不开", tag: "is-amber", hint: problem } : { label: "可以访问", tag: "is-green", hint: "" };
});
// What the row of a way shows under its explanation: its address and state once prepared.
function detail(mode) {
  if (mode === "local") return { text: `http://127.0.0.1:${entry.value.port}` };
  if (mode === "relay" && prepared("relay")) {
    return entry.value.relay?.link ? { text: entry.value.relay.link, state: entry.value.mode === "relay" ? relay_state.value : null } : { text: `已接入 ${entry.value.relay.site}，改用时取得入口地址` };
  }
  if (mode === "tunnel" && prepared("tunnel")) return { text: entry.value.public_url, state: entry.value.mode === "tunnel" ? tunnel_state.value : null };
  return null;
}

/** Start or stop the entry, or switch the way in use. */
async function entry_act(action, body = {}, message = "") {
  entry_busy.value = action;
  try {
    await call(`entry/${action}`, body);
    if (message) notify("info", message);
    await reload();
  } catch (failure) { notify("error", failure.message); }
  finally { entry_busy.value = ""; }
}

/** Use a way: switch to it when prepared, otherwise open its setup, which switches to it once done. */
function use(mode) {
  if (entry_busy.value || mode === entry.value.mode) return;
  if (!prepared(mode)) return configure(mode);
  entry_act("mode", { mode }, `登录入口已改为${MODES.find((item) => item.key === mode).label}`);
}

function configure(mode) {
  if (mode === "relay") relay_open.value = true; else tunnel_open.value = true;
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); notify("info", "已复制"); } catch { notify("error", "复制失败，请手动选中复制"); }
}

async function install() {
  installing.value = true;
  try {
    const result = await call("clis/install", {});
    const problems = [...(result.missing || []).map((item) => `没有找到 ${item}`), ...(result.warnings || [])];
    notify(problems.length ? "warning" : "info", problems.length ? problems.join("；") : "程序副本已同步");
    await reload();
  } catch (failure) { notify("error", failure.message); }
  finally { installing.value = false; }
}
</script>

<template>
  <h3 class="panel-section-title"><UIcon name="i-lucide-users" />托管</h3>
  <p class="panel-guide">托管账号的使用者打开登录入口，用账号名和密码进入各自的工作台。账号在“账号”页创建和管理。</p>
  <div class="panel-rows">
    <div class="panel-row">
      <div class="panel-tile"><UIcon name="i-lucide-door-open" /></div>
      <div class="panel-main">
        <div class="panel-title">登录入口
          <span class="panel-tag" :class="entry.running ? 'is-green' : 'is-gray'">{{ entry.running ? "运行中" : "已停止" }}</span>
          <span class="panel-tag is-blue">{{ current.label }}</span></div>
        <span class="panel-sub">把这个地址发给使用者：<a class="panel-link" :href="entry_address(entry)" target="_blank" rel="noopener">{{ entry_address(entry) }}</a></span>
      </div>
      <div class="panel-side">
        <button type="button" class="panel-button is-plain is-small" @click="copy(entry_address(entry))"><UIcon name="i-lucide-copy" />复制地址</button>
        <button v-if="!entry.running" type="button" class="panel-button is-primary is-small" :disabled="Boolean(entry_busy)" @click="entry_act('start', {}, '登录入口已启动')">
          <UIcon :name="entry_busy === 'start' ? 'i-lucide-loader' : 'i-lucide-play'" :class="{ 'animate-spin': entry_busy === 'start' }" />启动</button>
        <button v-else type="button" class="panel-button is-plain is-small is-danger" :disabled="Boolean(entry_busy)" @click="entry_act('stop', {}, '登录入口已停止')">
          <UIcon :name="entry_busy === 'stop' ? 'i-lucide-loader' : 'i-lucide-square'" :class="{ 'animate-spin': entry_busy === 'stop' }" />停止</button>
      </div>
    </div>
    <div class="entry-ways">
      <p class="entry-ways-title">访问方式<small>使用者从哪里打开登录入口。三种都可以先配置好，同一时间使用其中一种。</small></p>
      <div v-for="item in MODES" :key="item.key" class="entry-way" :class="{ 'is-active': entry.mode === item.key }">
        <UIcon :name="item.icon" class="entry-way-icon" />
        <div class="entry-way-main">
          <div class="entry-way-title">{{ item.label }}
            <span v-if="entry.mode === item.key" class="panel-tag is-blue"><UIcon name="i-lucide-check" />使用中</span>
            <span v-else-if="!prepared(item.key)" class="panel-tag is-gray">未配置</span></div>
          <span class="entry-way-note">{{ item.note }}</span>
          <span v-if="detail(item.key)" class="entry-way-value">{{ detail(item.key).text }}
            <span v-if="detail(item.key).state" class="panel-tag" :class="detail(item.key).state.tag" :title="detail(item.key).state.hint">{{ detail(item.key).state.label }}</span></span>
          <small v-if="detail(item.key)?.state?.hint" class="entry-way-hint">{{ detail(item.key).state.hint }}</small>
        </div>
        <div class="panel-side">
          <button v-if="item.key !== 'local' && prepared(item.key)" type="button" class="panel-button is-plain is-small" @click="configure(item.key)"><UIcon name="i-lucide-pencil" />修改</button>
          <button v-if="!prepared(item.key)" type="button" class="panel-button is-plain is-small" @click="configure(item.key)"><UIcon name="i-lucide-settings-2" />配置</button>
          <button v-else-if="entry.mode !== item.key" type="button" class="panel-button is-primary is-small" :disabled="Boolean(entry_busy)" @click="use(item.key)">
            <UIcon :name="entry_busy === 'mode' ? 'i-lucide-loader' : 'i-lucide-arrow-right-left'" :class="{ 'animate-spin': entry_busy === 'mode' }" />改用</button>
        </div>
      </div>
    </div>
    <TunnelDialog v-model:open="tunnel_open" />
    <RelayDialog v-model:open="relay_open" />

    <div class="panel-row">
      <div class="panel-tile"><UIcon name="i-lucide-hard-drive-download" /></div>
      <div class="panel-main">
        <div class="panel-title">程序副本
          <span v-if="!runtime.app" class="panel-tag is-gray">未安装</span>
          <span v-else-if="runtime_stale" class="panel-tag is-amber">v{{ runtime.app_version }}，落后于本机 v{{ state.version }}</span>
          <span v-else-if="!runtime_ready" class="panel-tag is-amber">缺少 {{ PARTS.filter(([key]) => !runtime[key]).map(([, label]) => label).join("、") }}</span>
          <span v-else class="panel-tag is-green"><UIcon name="i-lucide-check" />已同步</span></div>
        <span class="panel-sub">隔离账号读不到你的个人目录，从 C:\ProgramData\CoDiscuss 里的这份副本运行。升级 Claude Code 等程序后点同步；更新共议时会自动同步。</span>
      </div>
      <div class="panel-side">
        <button type="button" class="panel-button is-small" :class="runtime_ready && !runtime_stale ? 'is-plain' : 'is-primary'" :disabled="installing" @click="install">
          <UIcon :name="installing ? 'i-lucide-loader' : 'i-lucide-refresh-cw'" :class="{ 'animate-spin': installing }" />{{ runtime.app ? "同步" : "安装" }}</button>
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

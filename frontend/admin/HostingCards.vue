<script setup>
/**
 * This computer's parts of hosting, shown on the overview with hosting on: the entry hosted accounts sign in at, with how
 * people outside reach it (this computer only, the online relay without a domain, or a Cloudflare tunnel from the owner's
 * own domain; each prepared in its own dialog), and the copy of the programs accounts with their own Windows user run.
 */
import { computed, inject, ref, watch } from "vue";
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
// Short names on the switch; what each means is the small line under it, for the one chosen.
const MODES = [
  { key: "local", label: "仅本机", note: "只有这台电脑能打开" },
  { key: "relay", label: "线上中转", note: "不需要域名，经共议线上站点中转到这台电脑" },
  { key: "tunnel", label: "自有域名", note: "经 Cloudflare 隧道，把你托管在 Cloudflare 的域名转到这台电脑" },
];
// The way shown on the switch: the one in use, or one picked that still needs preparing (its row then offers "配置").
const picked = ref("");
const shown = computed(() => picked.value || entry.value.mode);
watch(() => entry.value.mode, () => { picked.value = ""; });
const prepared = (mode) => mode === "local" || (mode === "relay" ? Boolean(entry.value.relay?.site && entry.value.relay?.url) : Boolean(entry.value.tunnel));
const mode_note = computed(() => MODES.find((item) => item.key === shown.value)?.note || "");
// The tunnel as cloudflared reports it: connected to Cloudflare, running but not (yet) connected, or not running.
const tunnel_state = computed(() => {
  const tunnel = entry.value.tunnel;
  if (tunnel?.connected) return { label: "Cloudflare 隧道已连接", tag: "is-green", hint: "" };
  if (tunnel?.running) return { label: "隧道连接中", tag: "is-amber", hint: "cloudflared 已运行但还没连上 Cloudflare：刚启动时稍等片刻；持续如此请检查网络与代理是否放行 *.cloudflare.com、*.argotunnel.com，日志在数据目录 tunnel.log" };
  return { label: "隧道未运行", tag: "is-amber", hint: entry.value.running ? "管理面板每分钟会自动拉起一次；持续如此请查看数据目录 tunnel.log" : "登录入口停止时隧道也会停止" };
});
// The relay as this computer sees it: usable from outside, or the first thing in the way and what to do (from the panel).
const relay_state = computed(() => {
  const problem = entry.value.relay?.problem || "";
  return problem ? { label: "暂时无法从外网访问", tag: "is-amber", hint: problem } : { label: "可从外网访问", tag: "is-green", hint: "" };
});

/** Start or stop the entry. */
async function entry_act(action, body = {}, message = "") {
  entry_busy.value = action;
  try {
    await call(`entry/${action}`, body);
    if (message) notify("info", message);
    await reload();
  } catch (failure) { notify("error", failure.message); }
  finally { entry_busy.value = ""; }
}

/** Switch how people outside reach the entry; a way not prepared yet is only shown, with "配置" to prepare it. */
async function choose(mode) {
  if (entry_busy.value) return;
  if (mode === entry.value.mode) { picked.value = ""; return; }
  if (!prepared(mode)) { picked.value = mode; return; }
  picked.value = "";
  await entry_act("mode", { mode }, mode === "local" ? "已改为仅本机可访问" : `外网访问已改为${MODES.find((item) => item.key === mode).label}`);
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
  <p class="panel-guide">托管账号的使用者从登录入口登录，进入各自的网站；隔离账号运行在程序副本上。账号本身在“账号”页创建和管理。</p>
  <div class="panel-rows">
    <div class="panel-row">
      <div class="panel-tile"><UIcon name="i-lucide-door-open" /></div>
      <div class="panel-main">
        <div class="panel-title">登录入口
          <span class="panel-tag" :class="entry.running ? 'is-green' : 'is-gray'">{{ entry.running ? "运行中" : "已停止" }}</span></div>
        <span class="panel-sub">使用者打开 <a class="panel-link" :href="entry_address(entry)" target="_blank" rel="noopener">{{ entry_address(entry) }}</a>，以账号名和密码登录</span>
      </div>
      <div class="panel-side">
        <button v-if="!entry.running" type="button" class="panel-button is-primary is-small" :disabled="Boolean(entry_busy)" @click="entry_act('start', {}, '登录入口已启动')">
          <UIcon :name="entry_busy === 'start' ? 'i-lucide-loader' : 'i-lucide-play'" :class="{ 'animate-spin': entry_busy === 'start' }" />启动</button>
        <button v-else type="button" class="panel-button is-plain is-small is-danger" :disabled="Boolean(entry_busy)" @click="entry_act('stop', {}, '登录入口已停止')">
          <UIcon :name="entry_busy === 'stop' ? 'i-lucide-loader' : 'i-lucide-square'" :class="{ 'animate-spin': entry_busy === 'stop' }" />停止</button>
      </div>
    </div>
    <div class="panel-row-extra entry-access">
      <span class="entry-label">外网访问</span>
      <div class="entry-modes" role="radiogroup" aria-label="外网访问方式">
        <button v-for="item in MODES" :key="item.key" type="button" role="radio" :aria-checked="shown === item.key" class="entry-mode"
          :class="{ 'is-active': shown === item.key }" :disabled="Boolean(entry_busy)" @click="choose(item.key)">{{ item.label }}</button>
      </div>
    </div>
    <small class="entry-note">{{ mode_note }}</small>
    <div v-if="picked" class="panel-row-extra entry-detail">
      <span class="entry-value is-empty">{{ picked === "relay" ? "尚未接入线上站点，配置后生效；当前仍为" : "尚未设置 Cloudflare 隧道，配置后生效；当前仍为" }}{{ MODES.find((item) => item.key === entry.mode)?.label }}</span>
      <button type="button" class="panel-button is-primary is-small" @click="configure(picked)"><UIcon name="i-lucide-settings-2" />配置</button>
    </div>
    <div v-else-if="entry.mode !== 'local'" class="panel-row-extra entry-detail">
      <template v-if="entry.mode === 'relay'">
        <span class="entry-value">{{ entry.relay?.link }}
          <span class="panel-tag" :class="relay_state.tag" :title="relay_state.hint">{{ relay_state.label }}</span>
          <small v-if="relay_state.hint" class="entry-tunnel-error">{{ relay_state.hint }}</small></span>
        <button type="button" class="panel-button is-plain is-small" @click="copy(entry.relay?.link)"><UIcon name="i-lucide-copy" />复制链接</button>
        <button type="button" class="panel-button is-plain is-small" @click="relay_open = true"><UIcon name="i-lucide-pencil" />修改</button>
      </template>
      <template v-else-if="entry.mode === 'tunnel'">
        <span class="entry-value">{{ entry.public_url }}
          <span class="panel-tag" :class="tunnel_state.tag" :title="tunnel_state.hint">{{ tunnel_state.label }}</span>
          <small v-if="!entry.tunnel?.connected" class="entry-tunnel-error">{{ tunnel_state.hint }}</small></span>
        <button type="button" class="panel-button is-plain is-small" @click="tunnel_open = true"><UIcon name="i-lucide-pencil" />修改</button>
      </template>
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
        <span class="panel-sub">隔离账号无法读取你的个人目录，使用 C:\ProgramData\CoDiscuss 中的副本。升级 Claude Code 等程序后需同步。</span>
      </div>
      <div class="panel-side">
        <button type="button" class="panel-button is-small" :class="runtime_ready && !runtime_stale ? 'is-plain' : 'is-primary'" :disabled="installing" @click="install">
          <UIcon :name="installing ? 'i-lucide-loader' : 'i-lucide-refresh-cw'" :class="{ 'animate-spin': installing }" />{{ runtime.app ? "同步" : "安装" }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.entry-label { flex-shrink: 0; color: var(--panel-muted); font-size: 13px; }
.entry-modes { display: flex; gap: 2px; padding: 3px; border-radius: 10px; background: var(--panel-tint); }
.entry-mode { height: 28px; padding: 0 12px; border-radius: 8px; color: var(--panel-muted); font-size: 13px; transition: background-color .15s, color .15s; }
.entry-mode:hover:not(:disabled) { color: var(--panel-text); }
.entry-mode.is-active { background: #fff; color: var(--panel-text); box-shadow: 0 1px 3px #0000001a; }
.entry-detail { min-height: 34px; padding-left: 116px; }
.entry-note { display: block; margin: -10px 0 12px 116px; color: var(--panel-faint); font-size: 12px; }
.entry-value { flex: 1; min-width: 0; overflow: hidden; font-size: 13px; white-space: nowrap; text-overflow: ellipsis; }
.entry-value.is-empty { color: var(--panel-faint); white-space: normal; }
.entry-value .panel-tag { margin-left: 8px; vertical-align: middle; }
.entry-tunnel-error { display: block; overflow: hidden; color: var(--panel-amber); font-size: 12px; white-space: nowrap; text-overflow: ellipsis; }
</style>

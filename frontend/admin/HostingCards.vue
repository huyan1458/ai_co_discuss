<script setup>
/**
 * This computer's parts of hosting, shown on the overview with hosting on: the entry hosted accounts sign in at (its
 * outside address, a Cloudflare tunnel set in its own dialog), and the copy of the programs accounts with their own Windows
 * user run.
 */
import { computed, inject, ref } from "vue";
import { call, entry_address } from "./api.js";
import TunnelDialog from "./TunnelDialog.vue";

const { state, reload, notify } = inject("panel");
const installing = ref(false);
const runtime = computed(() => state.value.clis || {});
const PARTS = [["claude", "Claude Code"], ["codex", "Codex"], ["agy", "Antigravity"], ["app", "共议"], ["python", "Python"]];
const runtime_ready = computed(() => PARTS.every(([key]) => runtime.value[key]));
const runtime_stale = computed(() => runtime.value.app && runtime.value.app_version && runtime.value.app_version !== state.value.version);
const entry = computed(() => state.value.entry || { running: false, port: 0, public_url: "" });
const entry_busy = ref(""), tunnel_open = ref(false);
// The tunnel as cloudflared reports it: connected to Cloudflare, running but not (yet) connected, or not running.
const tunnel_state = computed(() => {
  const tunnel = entry.value.tunnel;
  if (tunnel?.connected) return { label: "Cloudflare 隧道已连接", tag: "is-green", hint: "" };
  if (tunnel?.running) return { label: "隧道连接中", tag: "is-amber", hint: "cloudflared 已运行但还没连上 Cloudflare：刚启动时稍等片刻；持续如此请检查网络与代理是否放行 *.cloudflare.com、*.argotunnel.com，日志在数据目录 tunnel.log" };
  return { label: "隧道未运行", tag: "is-amber", hint: entry.value.running ? "管理面板每分钟会自动拉起一次；持续如此请查看数据目录 tunnel.log" : "登录入口停止时隧道也会停止" };
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
    <div class="panel-row-extra">
      <span class="entry-label">外网地址</span>
      <span class="entry-value" :class="{ 'is-empty': !entry.public_url }">{{ entry.public_url || "未设置，仅本机可访问" }}
        <span v-if="entry.tunnel" class="panel-tag" :class="tunnel_state.tag" :title="tunnel_state.hint">{{ tunnel_state.label }}</span>
        <small v-if="entry.tunnel && !entry.tunnel.connected" class="entry-tunnel-error">{{ tunnel_state.hint }}</small></span>
      <button type="button" class="panel-button is-plain is-small" @click="tunnel_open = true"><UIcon name="i-lucide-pencil" />{{ entry.tunnel ? "修改" : "设置" }}</button>
    </div>
    <TunnelDialog v-model:open="tunnel_open" />

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
.entry-value { flex: 1; min-width: 0; overflow: hidden; font-size: 13px; white-space: nowrap; text-overflow: ellipsis; }
.entry-value.is-empty { color: var(--panel-faint); }
.entry-value .panel-tag { margin-left: 8px; vertical-align: middle; }
.entry-tunnel-error { display: block; overflow: hidden; color: var(--panel-amber); font-size: 12px; white-space: nowrap; text-overflow: ellipsis; }
</style>

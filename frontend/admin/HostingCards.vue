<script setup>
/**
 * This computer's parts of hosting, shown on the overview with hosting on: the entry hosted accounts sign in at (its
 * outside address set on one line), and the copy of the programs accounts with their own Windows user run.
 */
import { computed, inject, ref } from "vue";
import { call, entry_address } from "./api.js";

const { state, reload, notify } = inject("panel");
const installing = ref(false);
const runtime = computed(() => state.value.clis || {});
const PARTS = [["claude", "Claude Code"], ["codex", "Codex"], ["agy", "Antigravity"], ["app", "共议"], ["python", "Python"]];
const runtime_ready = computed(() => PARTS.every(([key]) => runtime.value[key]));
const runtime_stale = computed(() => runtime.value.app && runtime.value.app_version && runtime.value.app_version !== state.value.version);
const entry = computed(() => state.value.entry || { running: false, port: 0, public_url: "" });
const entry_busy = ref(""), public_url = ref(entry.value.public_url), editing = ref(false);

/** Start or stop the entry, or save its outside address. */
async function entry_act(action, body = {}, message = "") {
  entry_busy.value = action;
  try {
    await call(`entry/${action}`, body);
    if (message) notify("info", message);
    editing.value = false;
    await reload();
    public_url.value = entry.value.public_url;
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
      <template v-if="!editing">
        <span class="entry-value" :class="{ 'is-empty': !entry.public_url }">{{ entry.public_url || "未设置，仅本机可访问" }}</span>
        <button type="button" class="panel-button is-plain is-small" @click="editing = true"><UIcon name="i-lucide-pencil" />{{ entry.public_url ? "修改" : "设置" }}</button>
      </template>
      <form v-else class="entry-url" @submit.prevent="entry_act('settings', { public_url: public_url.trim() }, '外网地址已保存')">
        <input v-model="public_url" class="panel-input" placeholder="https://entry.example.com" autocomplete="off" spellcheck="false" autofocus />
        <button type="button" class="panel-button is-plain is-small" @click="editing = false; public_url = entry.public_url">取消</button>
        <button type="submit" class="panel-button is-primary is-small" :disabled="Boolean(entry_busy)">保存</button>
      </form>
    </div>
    <small v-if="editing" class="entry-help">先用 Cloudflare Tunnel 等工具把一个 https 地址转发到本机 {{ entry.port }} 端口，再填入此处；留空则仅本机可访问。</small>

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
.entry-url { display: flex; flex: 1; align-items: center; gap: 8px; }
.entry-url .panel-input { flex: 1; min-width: 0; height: 34px; border-radius: 10px; font-size: 13px; }
.entry-help { margin: -8px 0 12px 54px; color: var(--panel-faint); font-size: 12px; line-height: 1.6; }
</style>

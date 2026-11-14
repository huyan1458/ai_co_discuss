<script setup>
/**
 * This computer: the owner's own service (status, start, restart, stop), updates with a report of every step, starting
 * with Windows, and with hosting on, the accounts' entry and program copy. Each account's own setup is on "账号".
 */
import { computed, inject, onMounted, ref, watch } from "vue";
import { call } from "./api.js";
import HostingCards from "./HostingCards.vue";

const { state, reload, notify, refreshed } = inject("panel");
const service = computed(() => state.value.service || {});
const busy = ref("");
const update = ref(null), checking = ref(false), confirming = ref(false);

/** Run one service action and show where it left the service. */
async function run(action, message) {
  busy.value = action;
  try { await call(`service/${action}`, {}); notify("info", message); await reload(); }
  catch (failure) { notify("error", failure.message); await reload(); }
  finally { busy.value = ""; }
}

async function check(force = false) {
  checking.value = true;
  try { update.value = await call(force ? "update/check" : "update"); if (force && !update.value.available) notify("info", "已是最新版本"); }
  catch (failure) { update.value = { error: failure.message }; }
  finally { checking.value = false; }
}

const UPDATE_POLL_MS = 1500, UPDATE_WAIT_MS = 10 * 60 * 1000;
const report = ref(null);
async function install() {
  confirming.value = false;
  busy.value = "update";
  try {
    // The panel goes away while npm installs and comes back on the new version; every step is listed once it is done,
    // and closing the report reloads onto the new page.
    await call("update", {});
    report.value = await update_done();
  } catch (failure) { notify("error", failure.message); }
  finally { busy.value = ""; }
}

/** Ask for the update's progress until it is done; the panel does not answer while it restarts. */
async function update_done() {
  for (let waited = 0; waited < UPDATE_WAIT_MS; waited += UPDATE_POLL_MS) {
    await new Promise((done) => setTimeout(done, UPDATE_POLL_MS));
    try { const job = await call("update/progress"); if (job.status === "done") return job; } catch { /* restarting */ }
  }
  throw new Error("更新超过 10 分钟没有完成：可运行 codiscuss panel open 重新打开面板查看");
}
const failed = (line) => /失败/.test(line);
function reload_page() { window.location.reload(); }

async function toggle_autostart() {
  busy.value = "autostart";
  try { const { autostart } = await call("autostart", { on: !state.value.autostart }); notify("info", autostart ? "登录 Windows 时会自动启动共议" : "已关闭开机自启"); await reload(); }
  catch (failure) { notify("error", failure.message); }
  finally { busy.value = ""; }
}

onMounted(() => check());
// The header's refresh asks npm again rather than reusing the hourly answer.
watch(refreshed, () => check(true));
</script>

<template>
  <section>
    <h3 class="panel-section-title"><UIcon name="i-lucide-monitor" />本机</h3>
    <div class="panel-rows">
      <div class="panel-row">
        <div class="panel-tile"><UIcon name="i-lucide-server" /></div>
        <div class="panel-main">
          <div class="panel-title">共议服务
            <span class="panel-tag" :class="service.running ? 'is-green' : service.website ? 'is-amber' : 'is-gray'">
              <UIcon :name="service.running ? 'i-lucide-check' : 'i-lucide-minus'" />{{ service.running ? "运行中" : service.website ? "讨论服务未就绪" : "已停止" }}</span></div>
          <span class="panel-sub">{{ service.error || (service.running ? `本机网站与讨论服务 · 数据目录 ${service.home}` : "启动后才能在房间里唤醒本机的 AI 成员") }}</span>
        </div>
        <div class="panel-side">
          <template v-if="service.website || service.running">
            <a v-if="service.url" class="panel-button is-outline is-small" :href="service.url" target="_blank" rel="noopener"><UIcon name="i-lucide-external-link" />打开网站</a>
            <button type="button" class="panel-button is-plain is-small" :disabled="Boolean(busy)" title="进行中的执行会中断，随后在原会话里续跑" @click="run('restart', '共议服务已重启')">
              <UIcon :name="busy === 'restart' ? 'i-lucide-loader' : 'i-lucide-rotate-cw'" :class="{ 'animate-spin': busy === 'restart' }" />重启</button>
            <button type="button" class="panel-button is-plain is-small is-danger" :disabled="Boolean(busy)" title="本机网站与讨论服务都会停止" @click="run('stop', '共议服务已停止')">
              <UIcon :name="busy === 'stop' ? 'i-lucide-loader' : 'i-lucide-square'" :class="{ 'animate-spin': busy === 'stop' }" />停止</button>
          </template>
          <button v-else type="button" class="panel-button is-primary is-small" :disabled="Boolean(busy)" @click="run('start', '共议服务已启动')">
            <UIcon :name="busy === 'start' ? 'i-lucide-loader' : 'i-lucide-play'" :class="{ 'animate-spin': busy === 'start' }" />启动</button>
        </div>
      </div>

      <div class="panel-row">
        <div class="panel-tile"><UIcon name="i-lucide-package" /></div>
        <div class="panel-main">
          <div class="panel-title">版本 v{{ update?.current || service.version || state.version }}
            <span v-if="update?.available" class="panel-tag is-blue"><UIcon name="i-lucide-sparkles" />可更新到 v{{ update.latest }}</span>
            <span v-else-if="update?.latest" class="panel-tag is-green"><UIcon name="i-lucide-check" />已是最新</span></div>
          <span class="panel-sub">{{ update?.error ? `检查失败：${update.error}` : update?.available ? "更新会重启本机服务，进行中的执行会中断，随后在原会话里续跑" : checking ? "正在检查…" : "自动检查 npm 上发布的版本，每小时最多一次" }}</span>
        </div>
        <div class="panel-side">
          <button v-if="!update?.available" type="button" class="panel-button is-plain is-small" :disabled="checking || Boolean(busy)" @click="check(true)">
            <UIcon name="i-lucide-refresh-cw" :class="{ 'animate-spin': checking }" />检查更新</button>
          <button v-else type="button" class="panel-button is-primary is-small" :disabled="Boolean(busy)" @click="confirming = true">
            <UIcon :name="busy === 'update' ? 'i-lucide-loader' : 'i-lucide-download'" :class="{ 'animate-spin': busy === 'update' }" />{{ busy === "update" ? "正在更新…" : "更新" }}</button>
        </div>
      </div>

      <div v-if="state.platform === 'win32'" class="panel-row">
        <div class="panel-tile"><UIcon name="i-lucide-power" /></div>
        <div class="panel-main">
          <div class="panel-title">登录 Windows 时自动启动</div>
          <span class="panel-sub">{{ state.launcher ? "在后台启动网站、讨论服务与任务栏图标，不打开浏览器" : "需要先生成“共议”程序：运行 codiscuss setup 并勾选创建桌面快捷方式" }}</span>
        </div>
        <div class="panel-side">
          <USwitch :model-value="Boolean(state.autostart)" :loading="busy === 'autostart'" :disabled="Boolean(busy) || (!state.launcher && !state.autostart)" aria-label="登录 Windows 时自动启动" @update:model-value="toggle_autostart" />
        </div>
      </div>
    </div>

    <HostingCards v-if="state.hosting" />
  </section>

  <UModal :open="confirming" title="更新共议" :description="`从 v${update?.current} 更新到 v${update?.latest}`" @update:open="(open) => !open && (confirming = false)">
    <template #body>
      <p class="panel-note"><UIcon name="i-lucide-info" />本机服务{{ state.hosting ? "和运行中的托管实例" : "" }}会重启，进行中的执行会中断，重启后自动续跑。</p>
      <div class="panel-form-foot">
        <button type="button" class="panel-button is-plain" @click="confirming = false">取消</button>
        <button type="button" class="panel-button is-primary" @click="install">更新并重启</button>
      </div>
    </template>
  </UModal>

  <UModal :open="Boolean(report)" :title="report?.ok ? `已更新到 v${report?.version}` : '更新失败'" :dismissible="false" @update:open="(open) => !open && reload_page()">
    <template #body>
      <ul class="update-steps">
        <li v-for="line in report?.steps || []" :key="line" :class="{ 'is-failed': failed(line) }"><UIcon :name="failed(line) ? 'i-lucide-circle-x' : 'i-lucide-circle-check'" />{{ line }}</li>
      </ul>
      <div class="panel-form-foot"><button type="button" class="panel-button is-primary" @click="reload_page()">完成</button></div>
    </template>
  </UModal>
</template>

<style scoped>
.update-steps { display: flex; flex-direction: column; gap: 10px; margin: 0; padding: 0; list-style: none; font-size: 14px; }
.update-steps li { display: flex; align-items: flex-start; gap: 8px; overflow-wrap: anywhere; }
.update-steps li > [class*="icon"] { width: 16px; height: 16px; flex-shrink: 0; margin-top: 2px; color: var(--panel-green); }
.update-steps li.is-failed { color: #dc2626; }
.update-steps li.is-failed > [class*="icon"] { color: #dc2626; }
</style>

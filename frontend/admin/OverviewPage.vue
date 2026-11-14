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
    <h3 class="panel-section-title"><UIcon name="i-lucide-server" />本机服务</h3>
    <article class="panel-card">
      <div class="panel-tile"><UIcon name="i-lucide-monitor" /></div>
      <div class="panel-main">
        <div class="panel-title">共议
          <span class="panel-tag" :class="service.running ? 'is-green' : service.website ? 'is-amber' : 'is-gray'">
            <UIcon :name="service.running ? 'i-lucide-check' : 'i-lucide-minus'" />{{ service.running ? "运行中" : service.website ? "讨论服务未就绪" : "已停止" }}</span>
          <span v-if="service.version" class="panel-tag is-gray">v{{ service.version }}</span>
        </div>
        <a v-if="service.running && service.url" class="panel-link" :href="service.url" target="_blank" rel="noopener">{{ service.url }}</a>
        <span class="panel-sub">{{ service.error || `数据目录 ${service.home}` }}</span>
      </div>
      <div class="panel-side">
        <button v-if="!service.website" type="button" class="panel-icon-button is-go" :class="{ 'is-spinning': busy === 'start' }" :disabled="Boolean(busy)" title="启动" aria-label="启动" @click="run('start', '共议服务已启动')"><UIcon :name="busy === 'start' ? 'i-lucide-loader' : 'i-lucide-play'" /></button>
        <template v-else>
          <button type="button" class="panel-icon-button" :class="{ 'is-spinning': busy === 'restart' }" :disabled="Boolean(busy)" title="重启（进行中的执行会中断，随后在原会话里续跑）" aria-label="重启" @click="run('restart', '共议服务已重启')"><UIcon name="i-lucide-rotate-cw" /></button>
          <button type="button" class="panel-icon-button is-stop" :disabled="Boolean(busy)" title="停止（本机网站与讨论服务都会停止）" aria-label="停止" @click="run('stop', '共议服务已停止')"><UIcon :name="busy === 'stop' ? 'i-lucide-loader' : 'i-lucide-square'" :class="{ 'animate-spin': busy === 'stop' }" /></button>
        </template>
      </div>
    </article>

    <h3 class="panel-section-title"><UIcon name="i-lucide-download" />更新</h3>
    <article class="panel-card">
      <div class="panel-tile"><UIcon name="i-lucide-package" /></div>
      <div class="panel-main">
        <div class="panel-title">
          <template v-if="update?.available">有新版本 v{{ update.latest }}<span class="panel-tag is-blue"><UIcon name="i-lucide-sparkles" />可更新</span></template>
          <template v-else-if="update?.latest">已是最新版本<span class="panel-tag is-green"><UIcon name="i-lucide-check" />v{{ update.current }}</span></template>
          <template v-else>版本检查</template>
        </div>
        <span class="panel-sub">{{ update?.error ? `检查失败：${update.error}` : update?.available ? `当前 v${update.current}。更新会重启本机服务，进行中的执行会中断，随后在原会话里续跑` : checking ? "正在检查…" : "每小时最多查询一次 npm 上发布的版本" }}</span>
      </div>
      <div class="panel-side">
        <button type="button" class="panel-icon-button" :class="{ 'is-spinning': checking }" :disabled="checking || Boolean(busy)" title="立即检查" aria-label="立即检查" @click="check(true)"><UIcon name="i-lucide-refresh-cw" /></button>
        <button v-if="update?.available" type="button" class="panel-button is-primary is-small" :disabled="Boolean(busy)" @click="confirming = true">
          <UIcon :name="busy === 'update' ? 'i-lucide-loader' : 'i-lucide-download'" :class="{ 'animate-spin': busy === 'update' }" />{{ busy === "update" ? "正在更新…" : "更新" }}</button>
      </div>
    </article>

    <template v-if="state.platform === 'win32'">
      <h3 class="panel-section-title"><UIcon name="i-lucide-power" />启动</h3>
      <article class="panel-card">
        <div class="panel-tile"><UIcon name="i-lucide-log-in" /></div>
        <div class="panel-main">
          <div class="panel-title">登录 Windows 时自动启动
            <span class="panel-tag" :class="state.autostart ? 'is-green' : 'is-gray'">{{ state.autostart ? "已开启" : "未开启" }}</span></div>
          <span class="panel-sub">{{ state.launcher ? "在后台启动网站、讨论服务与任务栏图标，不打开浏览器" : "需要先生成“共议”程序：在 codiscuss setup 里勾选创建桌面快捷方式" }}</span>
        </div>
        <div class="panel-side">
          <button type="button" class="panel-button is-outline is-small" :disabled="Boolean(busy) || (!state.launcher && !state.autostart)" @click="toggle_autostart">
            <UIcon v-if="busy === 'autostart'" name="i-lucide-loader" class="animate-spin" />{{ state.autostart ? "关闭" : "开启" }}</button>
        </div>
      </article>
    </template>

    <HostingCards v-if="state.hosting" />
  </section>

  <UModal :open="confirming" title="更新共议" :description="`从 v${update?.current} 更新到 v${update?.latest}`" @update:open="(open) => !open && (confirming = false)">
    <template #body>
      <p class="panel-note"><UIcon name="i-lucide-info" />会用 npm 安装新版本，更新你的房间技能，再重启本机网站与讨论服务。{{ state.hosting ? "隔离账号的程序副本和技能也会一起更新，运行中的实例会重启。" : "" }}进行中的讨论会暂停、执行会中断，随后在原会话里自动续跑。工作流不会被覆盖。</p>
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
.update-steps li { display: flex; align-items: center; gap: 8px; }
.update-steps li > [class*="icon"] { width: 16px; height: 16px; flex-shrink: 0; color: var(--panel-green); }
.update-steps li.is-failed { color: #dc2626; }
.update-steps li.is-failed > [class*="icon"] { color: #dc2626; }
</style>

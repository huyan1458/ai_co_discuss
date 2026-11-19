<script setup>
/**
 * This computer: the owner's own service (status, start, restart, stop), with hosting on the accounts' entry and program
 * copy, and at the bottom updates with a report of every step, starting with Windows and the panel's language. Each account's own setup is on "账号".
 */
import { computed, inject, onMounted, ref, watch } from "vue";
import { call } from "./api.js";
import EntryTabs from "./EntryTabs.vue";
import OnlineSiteRow from "./OnlineSiteRow.vue";
import LanguagePicker from "../LanguagePicker.vue";
import { t } from '../i18n.js';

const { state, reload, notify, refreshed } = inject("panel");
const service = computed(() => state.value.service || {});
const busy = ref("");
const update = ref(null), checking = ref(false), confirming = ref(false);

/** Open the owner's site in the default browser; the panel makes the link, which a protected site requires. */
async function open_site() {
  try { await call("service/open", {}); } catch (failure) { notify("error", failure.message); }
}

/** Run one service action and show where it left the service. */
async function run(action, message) {
  busy.value = action;
  try { await call(`service/${action}`, {}); notify("info", message); await reload(); }
  catch (failure) { notify("error", failure.message); await reload(); }
  finally { busy.value = ""; }
}

async function check(force = false) {
  checking.value = true;
  try { update.value = await call(force ? "update/check" : "update"); if (force && !update.value.available) notify("info", t('已是最新版本')); }
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
  throw new Error(t('更新超过 10 分钟没有完成：可运行 codiscuss panel open 重新打开面板查看'));
}
function reload_page() { window.location.reload(); }

async function toggle_autostart() {
  busy.value = "autostart";
  try { const { autostart } = await call("autostart", { on: !state.value.autostart }); notify("info", autostart ? t('登录 Windows 时会自动启动共议') : t('已关闭开机自启')); await reload(); }
  catch (failure) { notify("error", failure.message); }
  finally { busy.value = ""; }
}

onMounted(() => check());
// The header's refresh asks npm again rather than reusing the hourly answer.
watch(refreshed, () => check(true));
</script>

<template>
  <section>
    <h3 class="panel-section-title"><UIcon name="i-lucide-monitor" />{{ t('本机') }}</h3>
    <div class="panel-rows">
      <div class="panel-row">
        <div class="panel-tile"><UIcon name="i-lucide-server" /></div>
        <div class="panel-main">
          <div class="panel-title">{{ t('共议服务') }} <span class="panel-tag" :class="service.running ? 'is-green' : service.website ? 'is-amber' : 'is-gray'">
              <UIcon :name="service.running ? 'i-lucide-check' : 'i-lucide-minus'" />{{ service.running ? t('运行中') : service.website ? t('讨论服务未就绪') : t('已停止') }}</span></div>
          <span class="panel-sub">{{ service.error || (service.running ? t('本机网站与讨论服务 · 数据目录 {value1}', { value1: service.home }) : t('启动后才能在房间里唤醒本机的 AI 成员')) }}</span>
        </div>
        <div class="panel-side">
          <template v-if="service.website || service.running">
            <button v-if="service.url" type="button" class="panel-button is-outline is-small" @click="open_site"><UIcon name="i-lucide-external-link" />{{ t('打开网站') }}</button>
            <button type="button" class="panel-button is-plain is-small" :disabled="Boolean(busy)" :title="t('进行中的执行会中断，随后在原会话里续跑')" @click="run('restart', t('共议服务已重启'))">
              <UIcon :name="busy === 'restart' ? 'i-lucide-loader' : 'i-lucide-rotate-cw'" :class="{ 'animate-spin': busy === 'restart' }" />{{ t('重启') }}</button>
            <button type="button" class="panel-button is-plain is-small is-danger" :disabled="Boolean(busy)" :title="t('本机网站与讨论服务都会停止')" @click="run('stop', t('共议服务已停止'))">
              <UIcon :name="busy === 'stop' ? 'i-lucide-loader' : 'i-lucide-square'" :class="{ 'animate-spin': busy === 'stop' }" />{{ t('停止') }}</button>
          </template>
          <button v-else type="button" class="panel-button is-primary is-small" :disabled="Boolean(busy)" @click="run('start', t('共议服务已启动'))">
            <UIcon :name="busy === 'start' ? 'i-lucide-loader' : 'i-lucide-play'" :class="{ 'animate-spin': busy === 'start' }" />{{ t('启动') }}</button>
        </div>
      </div>
      <OnlineSiteRow />
    </div>

    <EntryTabs />

    <h3 class="panel-section-title"><UIcon name="i-lucide-settings" />{{ t('设置') }}</h3>
    <div class="panel-rows">
      <div class="panel-row">
        <div class="panel-tile"><UIcon name="i-lucide-package" /></div>
        <div class="panel-main">
          <div class="panel-title">{{ t('版本 v{value1}', { value1: update?.current || service.version || state.version }) }} <span v-if="update?.available" class="panel-tag is-blue"><UIcon name="i-lucide-sparkles" />{{ t('可更新到 v{value1}', { value1: update.latest }) }}</span>
            <span v-else-if="update?.latest" class="panel-tag is-green"><UIcon name="i-lucide-check" />{{ t('已是最新') }}</span></div>
          <span class="panel-sub">{{ update?.error ? t('检查失败：{value1}', { value1: update.error }) : update?.available ? t('更新会重启本机服务，进行中的执行会中断，随后在原会话里续跑') : checking ? t('正在检查…') : t('自动检查 npm 上发布的版本，每小时最多一次') }}</span>
        </div>
        <div class="panel-side">
          <button v-if="!update?.available" type="button" class="panel-button is-plain is-small" :disabled="checking || Boolean(busy)" @click="check(true)">
            <UIcon name="i-lucide-refresh-cw" :class="{ 'animate-spin': checking }" />{{ t('检查更新') }}</button>
          <button v-else type="button" class="panel-button is-primary is-small" :disabled="Boolean(busy)" @click="confirming = true">
            <UIcon :name="busy === 'update' ? 'i-lucide-loader' : 'i-lucide-download'" :class="{ 'animate-spin': busy === 'update' }" />{{ busy === "update" ? t('正在更新…') : t('更新') }}</button>
        </div>
      </div>

      <div v-if="state.platform === 'win32'" class="panel-row">
        <div class="panel-tile"><UIcon name="i-lucide-power" /></div>
        <div class="panel-main">
          <div class="panel-title">{{ t('登录 Windows 时自动启动') }}</div>
          <span class="panel-sub">{{ state.launcher ? t('在后台启动网站、讨论服务与任务栏图标，不打开浏览器') : t('需要先生成“共议”程序：运行 codiscuss setup 并勾选创建桌面快捷方式') }}</span>
        </div>
        <div class="panel-side">
          <USwitch :model-value="Boolean(state.autostart)" :loading="busy === 'autostart'" :disabled="Boolean(busy) || (!state.launcher && !state.autostart)" :aria-label="t('登录 Windows 时自动启动')" @update:model-value="toggle_autostart" />
        </div>
      </div>

      <div class="panel-row">
        <div class="panel-tile"><UIcon name="i-lucide-languages" /></div>
        <div class="panel-main">
          <!-- Bilingual so someone who cannot read the current language still finds it. -->
          <div class="panel-title">语言 · Language</div>
          <span class="panel-sub">{{ t('管理面板的显示语言') }}</span>
        </div>
        <div class="panel-side"><LanguagePicker /></div>
      </div>
    </div>
  </section>

  <UModal :open="confirming" :title="t('更新共议')" :description="t('从 v{value1} 更新到 v{value2}', { value1: update?.current, value2: update?.latest })" @update:open="(open) => !open && (confirming = false)">
    <template #body>
      <p class="panel-note"><UIcon name="i-lucide-info" />{{ t('本机服务{value1}会重启，进行中的执行会中断，重启后自动续跑。', { value1: state.hosting ? t('和运行中的托管实例') : "" }) }}</p>
      <div class="panel-form-foot">
        <button type="button" class="panel-button is-plain" @click="confirming = false">{{ t('取消') }}</button>
        <button type="button" class="panel-button is-primary" @click="install">{{ t('更新并重启') }}</button>
      </div>
    </template>
  </UModal>

  <UModal :open="Boolean(report)" :title="report?.ok ? t('已更新到 v{value1}', { value1: report?.version }) : t('更新失败')" :dismissible="false" @update:open="(open) => !open && reload_page()">
    <template #body>
      <ul class="update-steps">
        <li v-for="(step, index) in report?.steps || []" :key="index" :class="{ 'is-failed': step.failed }"><UIcon :name="step.failed ? 'i-lucide-circle-x' : 'i-lucide-circle-check'" />{{ step.text }}</li>
      </ul>
      <div class="panel-form-foot"><button type="button" class="panel-button is-primary" @click="reload_page()">{{ t('完成') }}</button></div>
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

<script setup>
/**
 * Set the entry's outside address from the panel: a domain on Cloudflare and a tunnel name, the checks to do on the
 * Cloudflare site first, then a job that installs cloudflared, waits for the owner to authorize in the browser (its link
 * is shown in case the browser did not open), creates the tunnel, points the domain at it and starts it. The same steps
 * as `codiscuss setup --hosting`; progress is read from the job every moment.
 */
import { computed, inject, onBeforeUnmount, ref, watch } from "vue";
import { call } from "./api.js";
import { t } from '../i18n.js';

const props = defineProps({ open: { type: Boolean, required: true } });
const emit = defineEmits(["update:open"]);
const { state, reload, notify } = inject("panel");
const POLL_MS = 1500;
const STEPS = [t('安装 cloudflared'), t('等待 Cloudflare 授权'), t('建立隧道'), t('添加域名记录'), t('启动隧道')];
const CHECKS = [
  t('缓存规则：不能有对所有主机或这个子域名生效的“缓存全部内容”（Cache Everything），否则一个账号的页面可能被缓存后给到另一个账号'),
  t('安全：关闭 Bot Fight Mode，或为这个子域名加跳过规则，否则网页的接口请求会被拦'),
  t('速度：关闭 Rocket Loader（会改写页面脚本）'),
  t('DNS：这个子域名还没有记录（有的话先删掉）'),
];
const host = ref(""), name = ref(""), checked = ref(false), job = ref(null), starting = ref(false);
let timer = null;

const tunnel = computed(() => state.value.entry?.tunnel || null);
// A job already under way (the dialog was closed and opened again) is shown rather than a new form.
watch(() => props.open, async (open) => {
  if (!open) return stop_polling();
  host.value = tunnel.value?.host || ""; name.value = tunnel.value?.name || "codiscuss"; checked.value = false;
  job.value = await call("tunnel/setup").catch(() => null);
  if (job.value?.status === "running") poll(); else job.value = null;
});

function stop_polling() { if (timer) { clearTimeout(timer); timer = null; } }
async function poll() {
  stop_polling();
  try { job.value = await call("tunnel/setup"); } catch { /* try again */ }
  if (job.value?.status === "running") timer = setTimeout(poll, POLL_MS);
  else if (job.value?.status === "done") { notify("info", t('外网地址已设为 https://{value1}', { value1: job.value.host })); reload(); }
}
onBeforeUnmount(stop_polling);

async function start() {
  starting.value = true;
  try { job.value = await call("tunnel/setup", { host: host.value.trim(), name: name.value.trim() }); poll(); }
  catch (failure) { notify("error", failure.message); }
  finally { starting.value = false; }
}

/** Each step as done, current or still to come; the job names the one it is on. */
const step_state = (step) => {
  const at = STEPS.indexOf(job.value?.step), index = STEPS.indexOf(step);
  if (job.value?.status === "done") return "done";
  if (at < 0) return "pending";
  if (index < at) return "done";
  if (index === at) return job.value.status === "failed" ? "failed" : "running";
  return "pending";
};
const ICONS = { pending: "i-lucide-circle", running: "i-lucide-loader", done: "i-lucide-circle-check", failed: "i-lucide-circle-x" };
function close() { emit("update:open", false); }
</script>

<template>
  <UModal :open="open" :title="t('设置外网地址')" :description="t('让使用者从外网打开登录入口：经 Cloudflare 隧道把你的域名转到这台电脑')" :dismissible="job?.status !== 'running'" @update:open="(value) => !value && close()">
    <template #body>
      <form v-if="!job" class="tunnel-form" @submit.prevent="checked && start()">
        <label class="panel-field">{{ t('域名') }} <input v-model="host" class="panel-input" placeholder="codiscuss.example.com" autocomplete="off" spellcheck="false" />
          <small>{{ t('须已托管在 Cloudflare 的域名下，建议用专门的子域名') }}</small></label>
        <label class="panel-field">{{ t('隧道名') }} <input v-model="name" class="panel-input" placeholder="codiscuss" autocomplete="off" spellcheck="false" />
          <small>{{ t('这台电脑在 Cloudflare 上的隧道名；同一域名在别的电脑上建过隧道时，换一个名字') }}</small></label>
        <div class="tunnel-checks">
          <strong>{{ t('开始前在 Cloudflare 后台检查这个域名所在站点') }}</strong>
          <ol><li v-for="item in CHECKS" :key="item">{{ item }}</li></ol>
          <label class="tunnel-confirm"><input v-model="checked" type="checkbox" />{{ t('已检查完') }}</label>
        </div>
        <div class="panel-form-foot">
          <button type="button" class="panel-button is-plain" @click="close">{{ t('取消') }}</button>
          <button type="submit" class="panel-button is-primary" :disabled="!checked || !host.trim() || starting">{{ t('开始设置') }}</button>
        </div>
      </form>

      <div v-else class="tunnel-progress">
        <ol class="tunnel-steps">
          <li v-for="step in STEPS" :key="step" :class="`is-${step_state(step)}`">
            <UIcon :name="ICONS[step_state(step)]" :class="{ 'animate-spin': step_state(step) === 'running' }" />{{ step }}</li>
        </ol>
        <p v-if="job.status === 'running' &amp;&amp; job.step === t('等待 Cloudflare 授权')" class="panel-note">
          <UIcon name="i-lucide-info" />{{ t('浏览器里登录 Cloudflare，选择域名所在站点后点 Authorize。浏览器没有自动打开时') }} <a v-if="job.url" class="panel-link" :href="job.url" target="_blank" rel="noopener">{{ t('点这里授权') }}</a><template v-else>{{ t('，请稍候') }}</template>。</p>
        <p v-if="job.note" class="panel-note is-amber"><UIcon name="i-lucide-triangle-alert" />{{ job.note }}</p>
        <p v-if="job.status === 'failed'" class="panel-note is-amber"><UIcon name="i-lucide-circle-x" />{{ job.error }}</p>
        <p v-if="job.status === 'done'" class="panel-note"><UIcon name="i-lucide-circle-check" style="color: var(--panel-green)" /> {{ t('外网地址 https://{value1} 已设好，隧道由这台电脑在后台运行。建议把 Cloudflare 授权文件 ~\\.cloudflared\\cert.pem 移出这台电脑保管：它能管理整个站点，隧道运行用不到它。', { value1: job.host }) }}</p>
        <div class="panel-form-foot">
          <button v-if="job.status === 'failed'" type="button" class="panel-button is-plain" @click="job = null">{{ t('返回修改') }}</button>
          <button type="button" class="panel-button is-primary" :disabled="job.status === 'running'" @click="close">{{ job.status === "running" ? t('进行中…') : t('完成') }}</button>
        </div>
      </div>
    </template>
  </UModal>
</template>

<style scoped>
.tunnel-form { display: flex; flex-direction: column; gap: 16px; }
.tunnel-checks { display: flex; flex-direction: column; gap: 8px; padding: 12px 14px; border-radius: 12px; background: var(--panel-amber-soft); color: var(--panel-amber); font-size: 13px; line-height: 1.6; }
.tunnel-checks ol { margin: 0; padding-left: 20px; list-style: decimal; }
.tunnel-confirm { display: flex; align-items: center; gap: 8px; color: var(--panel-text); font-weight: 500; cursor: pointer; }
.tunnel-confirm input { width: 16px; height: 16px; accent-color: var(--panel-blue); }
.tunnel-progress { display: flex; flex-direction: column; gap: 14px; }
.tunnel-steps { display: flex; flex-direction: column; gap: 10px; margin: 0; padding: 0; list-style: none; font-size: 14px; }
.tunnel-steps li { display: flex; align-items: center; gap: 8px; color: var(--panel-faint); }
.tunnel-steps li > [class*="icon"] { width: 16px; height: 16px; flex-shrink: 0; }
.tunnel-steps .is-running, .tunnel-steps .is-done { color: var(--panel-text); }
.tunnel-steps .is-done > [class*="icon"] { color: var(--panel-green); }
.tunnel-steps .is-running > [class*="icon"] { color: var(--panel-blue); }
.tunnel-steps .is-failed { color: var(--panel-red); }
</style>

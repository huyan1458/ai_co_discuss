<script setup>
/**
 * Create a hosted account in one go: the account, its own Windows user, the shared programs it runs, its skills and
 * workflows, and its instance, each step shown as it runs and retried from where one failed. Ends with the password to
 * give and the account's page, where its command-line sign-ins and API keys are set.
 */
import { computed, inject, ref } from "vue";
import { call, entry_address } from "./api.js";

const emit = defineEmits(["cancel", "done"]);
const { state, reload, notify } = inject("panel");
const name = ref(""), isolate = ref(state.value.platform === "win32"), start = ref(true);
const steps = ref([]), running = ref(false), password = ref("");
const valid = computed(() => /^[a-z0-9][a-z0-9_-]{1,16}$/.test(name.value.trim()));

function plan() {
  const list = [{ key: "account", label: "创建账号与文件夹" }];
  if (isolate.value) {
    list.push({ key: "os-user", label: "创建独立的 Windows 用户", note: "电脑会弹出一次管理员确认，请点“是”" });
    // The shared programs are copied once; later accounts reuse them.
    if (!state.value.clis?.app || !state.value.clis?.python) list.push({ key: "runtime", label: "安装隔离账号的程序副本（命令行程序、共议、Python）" });
  }
  list.push({ key: "env/init", label: isolate.value ? "初始化 AI 环境（共议内置技能、系统提示词、随包工作流）" : "安装随包工作流" });
  if (state.value.platform === "win32") list.push({ key: "protect", label: "开启入口保护（只接受经入口和它自己的 AI 的访问）" });
  if (start.value) list.push({ key: "start", label: "启动实例" });
  return list.map((item) => ({ ...item, status: "pending", error: "" }));
}

async function run_step(step, account) {
  if (step.key === "account") { const result = await call("accounts", { name: account }); password.value = result.password; return; }
  if (step.key === "runtime") { const result = await call("clis/install", {}); if (result.warnings?.length) throw new Error(result.warnings.join("；")); return; }
  await call(`accounts/${account}/${step.key}`, {});
}

/** Run the remaining steps in order; a failed one stops the run and can be retried. */
async function go() {
  if (!steps.value.length) steps.value = plan();
  running.value = true;
  const account = name.value.trim();
  for (const step of steps.value) {
    if (step.status === "done") continue;
    step.status = "running"; step.error = "";
    try { await run_step(step, account); step.status = "done"; }
    catch (failure) { step.status = "failed"; step.error = failure.message; running.value = false; await reload(); return; }
  }
  running.value = false;
  await reload();
  notify("info", `账号 ${account} 已建好`);
}

const finished = computed(() => steps.value.length && steps.value.every((step) => step.status === "done"));
async function copy(text) { try { await navigator.clipboard.writeText(text); notify("info", "已复制"); } catch { notify("error", "复制失败，请手动选中复制"); } }
const ICONS = { pending: "i-lucide-circle", running: "i-lucide-loader", done: "i-lucide-circle-check", failed: "i-lucide-circle-x" };
</script>

<template>
  <section>
    <div class="panel-form-head">
      <h2>新建托管账号</h2>
    </div>

    <form v-if="!steps.length" class="panel-form" @submit.prevent="valid && go()">
      <label class="panel-field">账号名
        <input v-model="name" class="panel-input" placeholder="例如 zhang" autocomplete="off" spellcheck="false" maxlength="17" autofocus />
        <small>2–17 位小写字母、数字、下划线或短横线，对方用它登录。会建立文件夹 ~\.codiscuss-账号名，里面是它的项目、草稿和数据。</small>
      </label>
      <label v-if="state.platform === 'win32'" class="new-check"><input v-model="isolate" type="checkbox" />
        <span><strong>隔离（推荐）</strong><small>给它建一个独立的 Windows 用户：它的 AI 读不到你的个人文件，命令行登录和技能也和你分开。</small></span></label>
      <label class="new-check"><input v-model="start" type="checkbox" />
        <span><strong>建好后启动它的网站</strong><small>之后也可以在账号页启动或停止。</small></span></label>
    </form>

    <div v-else class="panel-form">
      <ol class="new-steps">
        <li v-for="step in steps" :key="step.key" :class="`is-${step.status}`">
          <UIcon :name="ICONS[step.status]" :class="{ 'animate-spin': step.status === 'running' }" />
          <div><strong>{{ step.label }}</strong>
            <small v-if="step.status === 'running' && step.note">{{ step.note }}</small>
            <small v-if="step.error" class="is-error">{{ step.error }}</small></div>
        </li>
      </ol>
      <template v-if="finished">
        <p class="panel-note"><UIcon name="i-lucide-circle-check" style="color: #16a34a" />建好了。把入口地址、账号名和下面的密码交给对方（密码只显示这一次）；下一步在账号页给它登录命令行、配置 API 密钥。</p>
        <div class="panel-secret"><span>{{ entry_address(state.entry) }} · {{ name.trim() }} · {{ password }}</span>
          <button type="button" class="panel-icon-button" aria-label="复制地址、账号和密码" @click="copy(`地址 ${entry_address(state.entry)}，账号 ${name.trim()}，密码 ${password}`)"><UIcon name="i-lucide-copy" /></button></div>
        <p v-if="!state.entry?.public_url" class="panel-note is-amber"><UIcon name="i-lucide-triangle-alert" />还没有设外网地址，这个地址只有这台电脑能打开。在“概览”页的“登录入口”设置。</p>
      </template>
    </div>

    <div class="panel-form-foot">
      <template v-if="!steps.length">
        <button type="button" class="panel-button is-plain" @click="emit('cancel')">取消</button>
        <button type="button" class="panel-button is-primary" :disabled="!valid" @click="go"><UIcon name="i-lucide-plus" />创建</button>
      </template>
      <button v-else-if="finished" type="button" class="panel-button is-primary" @click="emit('done', name.trim())">下一步：登录命令行<UIcon name="i-lucide-arrow-right" /></button>
      <button v-else-if="!running" type="button" class="panel-button is-primary" @click="go"><UIcon name="i-lucide-rotate-cw" />从失败的一步重试</button>
    </div>
  </section>
</template>

<style scoped>
.new-check { display: flex; align-items: flex-start; gap: 10px; cursor: pointer; }
.new-check input { width: 16px; height: 16px; margin-top: 3px; accent-color: var(--panel-blue); }
.new-check span { display: flex; flex-direction: column; gap: 3px; font-size: 14px; }
.new-check small { color: var(--panel-faint); font-size: 12px; }
.new-steps { display: flex; flex-direction: column; gap: 14px; margin: 0; padding: 0; list-style: none; }
.new-steps li { display: flex; align-items: flex-start; gap: 10px; color: var(--panel-faint); }
.new-steps li > [class*="icon"] { width: 18px; height: 18px; flex-shrink: 0; margin-top: 2px; }
.new-steps li div { display: flex; flex-direction: column; gap: 3px; }
.new-steps strong { font-size: 14px; font-weight: 500; }
.new-steps small { font-size: 12px; }
.new-steps .is-running, .new-steps .is-done { color: var(--panel-text); }
.new-steps .is-done > [class*="icon"] { color: var(--panel-green); }
.new-steps .is-running > [class*="icon"] { color: var(--panel-blue); }
.new-steps .is-failed { color: #dc2626; }
.new-steps .is-error { color: #dc2626; }
</style>

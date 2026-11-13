<script setup>
/**
 * One hosted account, everything about it on one page: its instance, its own Windows user, its command-line sign-ins,
 * its skills and workflows, its API keys, and removing it.
 */
import { computed, inject, ref } from "vue";
import { call } from "./api.js";
import AccountEnv from "./AccountEnv.vue";
import AccountKeys from "./AccountKeys.vue";
import LoginCard from "./LoginCard.vue";

const props = defineProps({ name: { type: String, required: true } });
const emit = defineEmits(["back", "local"]);
const { state, reload, notify } = inject("panel");
const account = computed(() => state.value.accounts.find((item) => item.name === props.name) || null);
const busy = ref(""), secret = ref(null), confirming = ref(null);

/** Run one account action, keeping its button busy until it ends. */
async function act(action, message) {
  busy.value = action;
  try {
    const result = await call(`accounts/${props.name}/${action}`, {});
    if (result.password) secret.value = { title: `${props.name} 的新密码`, password: result.password };
    else if (message) notify("info", typeof message === "function" ? message(result) : message);
    await reload();
    if (action === "remove") emit("back");
  } catch (failure) { notify("error", failure.message); }
  finally { busy.value = ""; }
}

const skills_message = (result) => {
  const added = (result.skills || []).reduce((sum, item) => sum + item.installed.length + item.updated.length, 0);
  const kept = [...new Set((result.skills || []).flatMap((item) => item.conflict))];
  const flows = (result.workflows || []).map((item) => item.name);
  return [added ? `已安装或更新 ${added} 份技能` : "技能已是最新", flows.length ? `新装工作流 ${flows.join("、")}` : "", kept.length ? `${kept.join("、")} 被改过，未覆盖` : ""].filter(Boolean).join("；");
};

const CONFIRMS = {
  "os-user": { title: "创建 Windows 用户", label: "创建", message: "Windows 用户已创建",
    text: () => `为 ${props.name} 建一个普通 Windows 用户。之后它的 AI 以这个用户运行，读不到你的个人文件，登录也和你分开。电脑会弹出一次管理员确认，请在这台电脑上点“是”。` },
  "os-user/remove": { title: "删除 Windows 用户", label: "删除", message: "Windows 用户已删除",
    text: () => `删除 ${account.value?.os_user} 及其个人目录（其中的命令行登录和技能一并删除）。账号本身和它的项目文件保留。电脑会弹出一次管理员确认。` },
  remove: { title: "删除账号", label: "删除", message: "账号已删除",
    text: () => `删除后 ${props.name} 无法再登录。它的文件夹 ${account.value?.home} 会保留，需要时手动删除。` },
};
function ask(action) { confirming.value = { action, ...CONFIRMS[action] }; }
async function confirm() { const { action, message } = confirming.value; confirming.value = null; await act(action, message); }

async function copy(text) {
  try { await navigator.clipboard.writeText(text); notify("info", "已复制"); } catch { notify("error", "复制失败，请手动选中复制"); }
}
</script>

<template>
  <section v-if="account">
    <div class="panel-form-head">
      <button type="button" class="panel-back" aria-label="返回账号列表" @click="emit('back')"><UIcon name="i-lucide-arrow-left" /></button>
      <h2>{{ account.name }}</h2>
      <span class="panel-tag" :class="account.running ? 'is-green' : 'is-gray'">{{ account.running ? "运行中" : "已停止" }}</span>
      <span class="panel-tag" :class="account.os_user ? 'is-blue' : 'is-amber'">{{ account.os_user ? `已隔离 · ${account.os_user}` : "未隔离" }}</span>
    </div>

    <div class="panel-list">
      <article class="panel-card">
        <div class="panel-tile"><UIcon name="i-lucide-globe" /></div>
        <div class="panel-main">
          <div class="panel-title">网站</div>
          <a class="panel-link" :href="`http://127.0.0.1:${account.port}/`" target="_blank" rel="noopener">http://127.0.0.1:{{ account.port }}</a>
          <span class="panel-sub">对方用账号名和密码从入口登录；忘了密码可以重设。</span>
        </div>
        <div class="panel-side">
          <button type="button" class="panel-button is-plain is-small" :disabled="Boolean(busy)" @click="act('password')"><UIcon name="i-lucide-key-round" />重设密码</button>
          <button v-if="!account.running" type="button" class="panel-button is-primary is-small" :disabled="Boolean(busy)" @click="act('start', '实例已启动')">
            <UIcon :name="busy === 'start' ? 'i-lucide-loader' : 'i-lucide-play'" :class="{ 'animate-spin': busy === 'start' }" />启动</button>
          <button v-else type="button" class="panel-button is-outline is-small" :disabled="Boolean(busy)" @click="act('stop', '实例已停止')">
            <UIcon :name="busy === 'stop' ? 'i-lucide-loader' : 'i-lucide-square'" :class="{ 'animate-spin': busy === 'stop' }" />停止</button>
        </div>
      </article>

      <article class="panel-card">
        <div class="panel-tile"><UIcon :name="account.os_user ? 'i-lucide-shield-check' : 'i-lucide-shield-alert'" /></div>
        <div class="panel-main">
          <div class="panel-title">{{ account.os_user ? "已隔离" : "未隔离" }}</div>
          <span class="panel-sub" style="white-space: normal">{{ account.os_user ? `以 Windows 用户 ${account.os_user} 运行：读不到你的个人文件，命令行登录、技能都是它自己的。` : "它的 AI 以你的身份运行，能读到这台电脑上你的文件，命令行登录和技能也用你的。给别人用时建议隔离。" }}</span>
        </div>
        <div class="panel-side">
          <button v-if="account.os_user" type="button" class="panel-button is-plain is-small" :disabled="Boolean(busy)" @click="ask('os-user/remove')">取消隔离</button>
          <button v-else type="button" class="panel-button is-primary is-small" :disabled="Boolean(busy)" @click="ask('os-user')">
            <UIcon :name="busy === 'os-user' ? 'i-lucide-loader' : 'i-lucide-shield-plus'" :class="{ 'animate-spin': busy === 'os-user' }" />隔离</button>
        </div>
      </article>

      <article class="panel-card is-tall">
        <LoginCard v-if="account.os_user" :target="account.name" :who="`托管账号 ${account.name}`" />
        <p v-else class="panel-note" style="margin: 0"><UIcon name="i-lucide-info" />未隔离的账号用你自己的命令行登录。
          <button type="button" class="panel-button is-plain is-small" @click="emit('local')">去“本机”查看</button></p>
      </article>

      <article v-if="account.os_user" class="panel-card is-tall"><AccountEnv :account="account.name" /></article>
      <article v-else class="panel-card">
        <div class="panel-tile"><UIcon name="i-lucide-sparkles" /></div>
        <div class="panel-main">
          <div class="panel-title">技能与工作流</div>
          <span class="panel-sub" style="white-space: normal">未隔离的账号用你自己的技能和系统提示词。这里只补上它工作流库里还没有的随包工作流（已有的不覆盖）。</span>
        </div>
        <div class="panel-side">
          <button type="button" class="panel-button is-outline is-small" :disabled="Boolean(busy)" @click="act('env/init', skills_message)">
            <UIcon :name="busy === 'env/init' ? 'i-lucide-loader' : 'i-lucide-download'" :class="{ 'animate-spin': busy === 'env/init' }" />补齐工作流</button>
        </div>
      </article>

      <article class="panel-card is-tall"><AccountKeys :account="account.name" @changed="reload" /></article>

      <div class="detail-danger">
        <button type="button" class="panel-button is-plain is-small" style="color: #dc2626" :disabled="Boolean(busy)" @click="ask('remove')"><UIcon name="i-lucide-trash-2" />删除账号</button>
      </div>
    </div>
  </section>
  <section v-else class="panel-empty"><UIcon name="i-lucide-user-x" />账号已不存在。<button type="button" class="panel-button is-outline is-small" @click="emit('back')">返回列表</button></section>

  <UModal :open="Boolean(secret)" :title="secret?.title" description="密码只显示这一次，请现在交给对方。" @update:open="(open) => !open && (secret = null)">
    <template #body>
      <div class="panel-secret"><span>{{ secret?.password }}</span>
        <button type="button" class="panel-icon-button" aria-label="复制密码" @click="copy(secret.password)"><UIcon name="i-lucide-copy" /></button></div>
    </template>
  </UModal>
  <UModal :open="Boolean(confirming)" :title="confirming?.title" @update:open="(open) => !open && (confirming = null)">
    <template #body>
      <p style="margin: 0; color: #4b5563; font-size: 14px; line-height: 1.7">{{ confirming?.text() }}</p>
      <div class="panel-form-foot">
        <button type="button" class="panel-button is-plain" @click="confirming = null">取消</button>
        <button type="button" class="panel-button is-primary" @click="confirm">{{ confirming?.label }}</button>
      </div>
    </template>
  </UModal>
</template>

<style scoped>
.panel-form-head h2 { margin-right: 4px; }
.detail-danger { display: flex; justify-content: flex-end; padding-top: 4px; }
</style>

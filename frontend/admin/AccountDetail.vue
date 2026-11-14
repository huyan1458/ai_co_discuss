<script setup>
/**
 * One hosted account, in the order the owner needs it: starting and stopping it (title row; disable and remove are
 * also in the account list's "⋯"), the security settings
 * still to do before giving it to someone (isolation, entry protection; one line once both are done), the sign-in details
 * to hand over, its AI environment (command-line sign-ins, skills, workflows, API keys), and at the bottom the rare and
 * risky operations (disable, undo isolation or protection, remove).
 */
import { computed, inject, ref, watch } from "vue";
import { call, entry_address } from "./api.js";
import AccountEnv from "./AccountEnv.vue";
import AccountKeys from "./AccountKeys.vue";
import AccountWorkflows from "./AccountWorkflows.vue";
import LoginCard from "./LoginCard.vue";

// request: an operation picked from the account list's "⋯" ({ action, at }), carried out here with the usual confirmation.
const props = defineProps({ name: { type: String, required: true }, request: { type: Object, default: null } });
const emit = defineEmits(["owner", "handled"]);
const { state, reload, notify } = inject("panel");
const account = computed(() => state.value.accounts.find((item) => item.name === props.name) || null);
const busy = ref(""), secret = ref(null), confirming = ref(null);
const address = computed(() => entry_address(state.value.entry));
// Both are needed before the account is given to someone else; until then the page opens with what is left to do.
const secure = computed(() => Boolean(account.value?.os_user && account.value?.protected));

/** Run one account action, keeping its button busy until it ends. */
async function act(action, message) {
  busy.value = action;
  try {
    const result = await call(`accounts/${props.name}/${action}`, {});
    if (result.password) secret.value = { title: `${props.name} 的新密码`, password: result.password };
    else if (message) notify("info", typeof message === "function" ? message(result) : message);
    await reload();
    if (action === "remove") emit("owner");
  } catch (failure) { notify("error", failure.message); }
  finally { busy.value = ""; }
}

const CONFIRMS = {
  "os-user": { title: "创建 Windows 用户", label: "创建", message: "Windows 用户已创建",
    text: () => `为 ${props.name} 创建一个普通 Windows 用户。之后它的 AI 以该用户运行，无法读取你的个人文件，命令行登录也与你分开。电脑会弹出一次管理员确认，请在这台电脑上点“是”。` },
  "os-user/remove": { title: "取消隔离", label: "取消隔离", message: "已取消隔离",
    text: () => `删除 Windows 用户 ${account.value?.os_user} 及其个人目录（其中的命令行登录和技能一并删除），账号改为以你的身份运行。账号本身和它的项目文件保留。电脑会弹出一次管理员确认。` },
  "protect-off": { title: "关闭入口保护", label: "关闭", message: "入口保护已关闭",
    text: () => `关闭后，${props.name} 的网站不再要求先证明身份，这台电脑上的其他程序（包括其他账号的 AI）可直接访问。正在运行的实例会重启一次。` },
  disable: { title: "停用账号", label: "停用", message: "账号已停用",
    text: () => `${props.name} 的所有登录立即失效，也无法再登录；实例和文件保留，可随时重新启用。` },
  remove: { title: "删除账号", label: "删除", message: "账号已删除",
    text: () => `删除后 ${props.name} 无法再登录。它的文件夹 ${account.value?.home} 会保留，需要时手动删除。` },
};
function ask(action) { confirming.value = { action, ...CONFIRMS[action] }; }

watch(() => props.request, (request) => {
  if (!request || request.name !== props.name) return;
  emit("handled");
  if (request.action === "enable") act("enable", "账号已启用");
  else ask(request.action);
}, { immediate: true });
async function confirm() {
  const { action, message } = confirming.value;
  confirming.value = null;
  if (action === "protect-off") return protect(false, message);
  await act(action, message);
}

/** Turn entry protection on or off; a running instance restarts so the change applies at once. */
async function protect(on, message) {
  busy.value = "protect";
  try { await call(`accounts/${props.name}/protect`, { on }); notify("info", message); await reload(); }
  catch (failure) { notify("error", failure.message); }
  finally { busy.value = ""; }
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); notify("info", "已复制"); } catch { notify("error", "复制失败，请手动选中复制"); }
}
</script>

<template>
  <section v-if="account">
    <div class="panel-form-head">
      <h2>{{ account.name }}</h2>
      <span class="panel-tag" :class="account.running ? 'is-green' : 'is-gray'">{{ account.running ? "运行中" : "已停止" }}</span>
      <span v-if="account.disabled" class="panel-tag is-amber">已停用</span>
      <span class="detail-head-side">
        <button v-if="!account.running" type="button" class="panel-button is-primary is-small" :disabled="Boolean(busy)" @click="act('start', '实例已启动')">
          <UIcon :name="busy === 'start' ? 'i-lucide-loader' : 'i-lucide-play'" :class="{ 'animate-spin': busy === 'start' }" />启动</button>
        <button v-else type="button" class="panel-button is-plain is-small is-danger" :disabled="Boolean(busy)" @click="act('stop', '实例已停止')">
          <UIcon :name="busy === 'stop' ? 'i-lucide-loader' : 'i-lucide-square'" :class="{ 'animate-spin': busy === 'stop' }" />停止</button>
      </span>
    </div>

    <div class="panel-list">
      <div v-if="!secure" class="panel-rows detail-unsafe">
        <p class="detail-unsafe-head"><UIcon name="i-lucide-triangle-alert" />交给他人使用前，请完成以下安全设置</p>
        <div v-if="!account.os_user" class="panel-row">
          <div class="panel-tile"><UIcon name="i-lucide-shield-alert" /></div>
          <div class="panel-main">
            <div class="panel-title">隔离 <span class="panel-tag is-amber">未完成</span></div>
            <span class="panel-sub">为该账号创建独立的 Windows 用户。未隔离时，它的 AI 以你的身份运行，可读取你的个人文件。</span>
          </div>
          <div class="panel-side"><button type="button" class="panel-button is-primary is-small" :disabled="Boolean(busy)" @click="ask('os-user')">
            <UIcon :name="busy === 'os-user' ? 'i-lucide-loader' : 'i-lucide-shield-plus'" :class="{ 'animate-spin': busy === 'os-user' }" />隔离</button></div>
        </div>
        <div v-if="!account.protected" class="panel-row">
          <div class="panel-tile"><UIcon name="i-lucide-lock-open" /></div>
          <div class="panel-main">
            <div class="panel-title">入口保护 <span class="panel-tag is-amber">未开启</span></div>
            <span class="panel-sub">开启后，只有经登录入口登录的使用者和它自己的 AI 能访问其网站；未开启时，本机其他程序（包括其他账号的 AI）可直接访问。</span>
          </div>
          <div class="panel-side"><button type="button" class="panel-button is-primary is-small" :disabled="Boolean(busy)" @click="protect(true, '入口保护已开启')">
            <UIcon :name="busy === 'protect' ? 'i-lucide-loader' : 'i-lucide-lock'" :class="{ 'animate-spin': busy === 'protect' }" />开启</button></div>
        </div>
      </div>
      <p v-else class="detail-safe"><UIcon name="i-lucide-shield-check" />安全设置已完成：以独立 Windows 用户 {{ account.os_user }} 运行，入口保护已开启</p>

      <div class="panel-rows">
        <div class="panel-row">
          <div class="panel-tile"><UIcon name="i-lucide-id-card" /></div>
          <div class="panel-main">
            <div class="panel-title">登录信息</div>
            <span class="panel-sub">入口 <a class="panel-link" :href="address" target="_blank" rel="noopener">{{ address }}</a> · 账号 <b class="detail-name">{{ account.name }}</b> · 密码仅在重设时显示一次</span>
            <span v-if="!state.entry?.running" class="panel-sub detail-warn">登录入口未运行，使用者暂时无法登录，请到“概览”启动</span>
            <span v-else-if="!state.entry?.address" class="panel-sub detail-warn">尚未开启外网访问，目前仅本机可访问</span>
          </div>
          <div class="panel-side">
            <button type="button" class="panel-button is-outline is-small" @click="copy(`地址 ${address}，账号 ${account.name}`)"><UIcon name="i-lucide-copy" />复制</button>
            <button type="button" class="panel-button is-plain is-small" :disabled="Boolean(busy)" @click="act('password')"><UIcon name="i-lucide-key-round" />重设密码</button>
          </div>
        </div>
      </div>

      <template v-if="account.os_user">
        <article class="panel-card is-tall"><LoginCard :target="account.name" :who="`托管账号 ${account.name}`" /></article>
        <article class="panel-card is-tall"><AccountEnv :account="account.name" /></article>
      </template>
      <article v-else class="panel-card is-tall">
        <div class="detail-shared">
          <p class="panel-note" style="margin: 0; flex: 1"><UIcon name="i-lucide-info" />未隔离账号与管理员共用命令行登录、技能与系统提示词；隔离后将使用独立的一份。</p>
          <button type="button" class="panel-button is-outline is-small" @click="emit('owner')">查看管理员设置</button>
        </div>
      </article>

      <article class="panel-card is-tall"><AccountWorkflows :account="account.name" /></article>
      <article class="panel-card is-tall"><AccountKeys :account="account.name" @changed="reload" /></article>

      <h3 class="panel-section-title"><UIcon name="i-lucide-settings-2" />账号操作</h3>
      <div class="panel-rows">
        <div class="panel-row detail-op">
          <div class="panel-main"><div class="panel-title">{{ account.disabled ? "启用账号" : "停用账号" }}</div>
            <span class="panel-sub">{{ account.disabled ? "启用后使用者可重新登录" : "所有登录立即失效且无法再登录；实例与文件保留，可随时启用" }}</span></div>
          <button v-if="account.disabled" type="button" class="panel-button is-outline is-small" :disabled="Boolean(busy)" @click="act('enable', '账号已启用')">启用</button>
          <button v-else type="button" class="panel-button is-outline is-small" :disabled="Boolean(busy)" @click="ask('disable')">停用</button>
        </div>
        <div v-if="account.os_user" class="panel-row detail-op">
          <div class="panel-main"><div class="panel-title">取消隔离</div>
            <span class="panel-sub">删除 Windows 用户 {{ account.os_user }} 及其中的登录与技能，账号改为以你的身份运行</span></div>
          <button type="button" class="panel-button is-outline is-small" :disabled="Boolean(busy)" @click="ask('os-user/remove')">取消隔离</button>
        </div>
        <div v-if="account.protected" class="panel-row detail-op">
          <div class="panel-main"><div class="panel-title">关闭入口保护</div>
            <span class="panel-sub">本机其他程序将可直接访问该账号的网站</span></div>
          <button type="button" class="panel-button is-outline is-small" :disabled="Boolean(busy)" @click="ask('protect-off')">关闭</button>
        </div>
        <div class="panel-row detail-op">
          <div class="panel-main"><div class="panel-title">删除账号</div>
            <span class="panel-sub">使用者无法再登录；文件夹 {{ account.home }} 保留，需要时手动删除</span></div>
          <button type="button" class="panel-button is-plain is-small is-danger" :disabled="Boolean(busy)" @click="ask('remove')"><UIcon name="i-lucide-trash-2" />删除</button>
        </div>
      </div>
    </div>
  </section>
  <section v-else class="panel-empty"><UIcon name="i-lucide-user-x" />账号已不存在。</section>

  <UModal :open="Boolean(secret)" :title="secret?.title" description="密码只显示这一次，请现在交给使用者。" @update:open="(open) => !open && (secret = null)">
    <template #body>
      <div class="panel-secret"><span>{{ secret?.password }}</span>
        <button type="button" class="panel-icon-button" aria-label="复制密码" @click="copy(secret.password)"><UIcon name="i-lucide-copy" /></button></div>
      <div class="panel-form-foot">
        <button type="button" class="panel-button is-primary" @click="copy(`地址 ${address}，账号 ${props.name}，密码 ${secret.password}`)"><UIcon name="i-lucide-copy" />复制完整登录信息</button>
      </div>
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
.detail-head-side { display: flex; gap: 8px; margin-left: auto; }
.detail-shared { display: flex; align-items: center; gap: 12px; }
.detail-unsafe { border-color: #fcd34d; background: var(--panel-amber-soft); }
.detail-unsafe > * + .panel-row { border-top-color: #fde68a; }
.detail-unsafe .panel-tile { border-color: #fde68a; background: #fff; color: var(--panel-amber); }
.detail-unsafe-head { display: flex; align-items: center; gap: 8px; margin: 0; padding: 14px 0 12px; color: var(--panel-amber); font-size: 14px; font-weight: 600; }
.detail-unsafe-head > [class*="icon"] { width: 18px; height: 18px; }
.detail-safe { display: flex; align-items: center; gap: 8px; margin: 0; padding: 12px 18px; border-radius: 14px; background: var(--panel-green-soft); color: var(--panel-green); font-size: 13px; }
.detail-safe > [class*="icon"] { width: 18px; height: 18px; flex-shrink: 0; }
.detail-name { color: var(--panel-text); font-weight: 600; }
.detail-warn { color: var(--panel-amber); }
.detail-op { min-height: 64px; }
</style>

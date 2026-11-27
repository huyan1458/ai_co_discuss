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
import { t } from '../i18n.js';

// request: an operation picked from the account list's "⋯" ({ action, at }), carried out here with the usual confirmation.
const props = defineProps({ name: { type: String, required: true }, request: { type: Object, default: null } });
const emit = defineEmits(["owner", "handled"]);
const { state, reload, notify } = inject("panel");
const account = computed(() => state.value.accounts.find((item) => item.name === props.name) || null);
const busy = ref(""), secret = ref(null), confirming = ref(null);
const address = computed(() => entry_address(state.value.entry));
const migration_path = ref("");
const backups = ref(null);
watch(() => props.name, () => { migration_path.value = ""; backups.value = null; confirming.value = null; });
async function load_backups() {
  const name = props.name;
  try {
    const rows = await call(`accounts/${name}/migration-backups`);
    if (props.name === name) backups.value = rows;
  } catch (error) { notify("error", error.message); }
}
function ask_release(row) {
  confirming.value = { action: "release-backup", row, title: t('释放迁移备份'), label: t('确认释放'),
    text: () => t('将停止实例，校验后删除备份 {path}（{bytes} 字节）。', { path: row.path, bytes: row.bytes }) };
}
// Both are needed before the account is given to someone else; until then the page opens with what is left to do.
const secure = computed(() => Boolean(account.value?.os_user && account.value?.protected));

/** Run one account action, keeping its button busy until it ends. */
async function act(action, message, body = {}) {
  busy.value = action;
  try {
    const result = await call(`accounts/${props.name}/${action}`, body);
    if (result.password) secret.value = { title: t('{value1} 的新密码', { value1: props.name }), password: result.password };
    else if (message) notify("info", typeof message === "function" ? message(result) : message);
    await reload();
    if (action === "remove") emit("owner");
  } catch (failure) { notify("error", failure.message); }
  finally { busy.value = ""; }
}

const CONFIRMS = {
  "os-user": { title: t('创建 Windows 用户'), label: t('创建'), message: t('Windows 用户已创建'),
    text: () => t('为 {value1} 创建一个普通 Windows 用户。之后它的 AI 以该用户运行，无法读取你的个人文件，命令行登录也与你分开。电脑会弹出一次管理员确认，请在这台电脑上点“是”。', { value1: props.name }) },
  "os-user/remove": { title: t('取消隔离'), label: t('取消隔离'), message: t('已取消隔离'),
    text: () => t('删除 Windows 用户 {value1} 及其个人目录（其中的命令行登录和技能一并删除），账号改为以你的身份运行。账号本身和它的项目文件保留。电脑会弹出一次管理员确认。', { value1: account.value?.os_user }) },
  "protect-off": { title: t('关闭入口保护'), label: t('关闭'), message: t('入口保护已关闭'),
    text: () => t('关闭后，{value1} 的网站不再要求先证明身份，这台电脑上的其他程序（包括其他账号的 AI）可直接访问。正在运行的实例会重启一次。', { value1: props.name }) },
  disable: { title: t('停用账号'), label: t('停用'), message: t('账号已停用'),
    text: () => t('{value1} 的所有登录立即失效，也无法再登录；实例和文件保留，可随时重新启用。', { value1: props.name }) },
  remove: { title: t('删除账号'), label: t('删除'), message: t('账号已删除'),
    text: () => t('删除后 {value1} 无法再登录。它的文件夹 {value2} 会保留，需要时手动删除。', { value1: props.name, value2: account.value?.home }) },
};
function ask(action) { confirming.value = { action, ...CONFIRMS[action] }; }

watch(() => props.request, (request) => {
  if (!request || request.name !== props.name) return;
  emit("handled");
  if (request.action === "enable") act("enable", t('账号已启用'));
  else ask(request.action);
}, { immediate: true });
async function confirm() {
  const { action, message, row } = confirming.value;
  confirming.value = null;
  if (action === "protect-off") return protect(false, message);
  if (action === "release-backup") {
    await act(action, t('已释放迁移备份'), { id: row.id, kind: row.kind, confirm: true });
    return load_backups();
  }
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
  try { await navigator.clipboard.writeText(text); notify("info", t('已复制')); } catch { notify("error", t('复制失败，请手动选中复制')); }
}
</script>

<template>
  <section v-if="account">
    <div class="panel-form-head">
      <h2>{{ account.name }}</h2>
      <span class="panel-tag" :class="account.running ? 'is-green' : 'is-gray'">{{ account.running ? t('运行中') : t('已停止') }}</span>
      <span v-if="account.disabled" class="panel-tag is-amber">{{ t('已停用') }}</span>
      <span class="detail-head-side">
        <button v-if="!account.running" type="button" class="panel-button is-primary is-small" :disabled="Boolean(busy)" @click="act('start', t('实例已启动'))">
          <UIcon :name="busy === 'start' ? 'i-lucide-loader' : 'i-lucide-play'" :class="{ 'animate-spin': busy === 'start' }" />{{ t('启动') }}</button>
        <button v-else type="button" class="panel-button is-plain is-small is-danger" :disabled="Boolean(busy)" @click="act('stop', t('实例已停止'))">
          <UIcon :name="busy === 'stop' ? 'i-lucide-loader' : 'i-lucide-square'" :class="{ 'animate-spin': busy === 'stop' }" />{{ t('停止') }}</button>
      </span>
    </div>

    <div class="panel-list">
      <form class="panel-row" @submit.prevent="act('migrate-data', t('项目数据已迁移，实例已停止'), { project_data_root: migration_path.trim() })">
        <label class="panel-main">{{ t('项目数据目录') }}
          <small>{{ account.project_data_root || account.home }}</small>
          <input v-model="migration_path" class="panel-input" :placeholder="t('新的绝对路径')" required />
        </label>
        <button class="panel-button is-plain is-small" :disabled="!migration_path.trim() || Boolean(busy)">{{ t('停止实例并迁移') }}</button>
      </form>
      <div class="panel-rows">
        <button type="button" class="panel-button is-plain is-small" @click="load_backups">{{ t('查看迁移备份') }}</button>
        <p v-if="backups && !backups.length" class="panel-sub">{{ t('没有已登记的迁移备份') }}</p>
        <div v-for="row in backups" :key="row.id + row.kind" class="panel-row">
          <div class="panel-main"><span>{{ row.path }}</span><small>{{ row.error || t('文件 {bytes} 字节，磁盘占用 {allocated} 字节', { bytes: row.bytes, allocated: row.allocated_bytes }) }}</small></div>
          <button type="button" class="panel-button is-small" :disabled="Boolean(row.error || busy)" @click="ask_release(row)">{{ t('释放迁移备份') }}</button>
        </div>
      </div>
      <div v-if="!secure" class="panel-rows detail-unsafe">
        <p class="detail-unsafe-head"><UIcon name="i-lucide-triangle-alert" />{{ t('交给他人使用前，请完成以下安全设置') }}</p>
        <div v-if="!account.os_user" class="panel-row">
          <div class="panel-tile"><UIcon name="i-lucide-shield-alert" /></div>
          <div class="panel-main">
            <div class="panel-title">{{ t('隔离') }} <span class="panel-tag is-amber">{{ t('未完成') }}</span></div>
            <span class="panel-sub">{{ t('为该账号创建独立的 Windows 用户。未隔离时，它的 AI 以你的身份运行，可读取你的个人文件。') }}</span>
          </div>
          <div class="panel-side"><button type="button" class="panel-button is-primary is-small" :disabled="Boolean(busy)" @click="ask('os-user')">
            <UIcon :name="busy === 'os-user' ? 'i-lucide-loader' : 'i-lucide-shield-plus'" :class="{ 'animate-spin': busy === 'os-user' }" />{{ t('隔离') }}</button></div>
        </div>
        <div v-if="!account.protected" class="panel-row">
          <div class="panel-tile"><UIcon name="i-lucide-lock-open" /></div>
          <div class="panel-main">
            <div class="panel-title">{{ t('入口保护') }} <span class="panel-tag is-amber">{{ t('未开启') }}</span></div>
            <span class="panel-sub">{{ t('开启后，只有经登录入口登录的使用者和它自己的 AI 能访问其网站；未开启时，本机其他程序（包括其他账号的 AI）可直接访问。') }}</span>
          </div>
          <div class="panel-side"><button type="button" class="panel-button is-primary is-small" :disabled="Boolean(busy)" @click="protect(true, t('入口保护已开启'))">
            <UIcon :name="busy === 'protect' ? 'i-lucide-loader' : 'i-lucide-lock'" :class="{ 'animate-spin': busy === 'protect' }" />{{ t('开启') }}</button></div>
        </div>
      </div>
      <p v-else class="detail-safe"><UIcon name="i-lucide-shield-check" />{{ t('安全设置已完成：以独立 Windows 用户 {value1} 运行，入口保护已开启', { value1: account.os_user }) }}</p>

      <div class="panel-rows">
        <div class="panel-row">
          <div class="panel-tile"><UIcon name="i-lucide-id-card" /></div>
          <div class="panel-main">
            <div class="panel-title">{{ t('登录信息') }}</div>
            <span class="panel-sub detail-login"><b class="detail-name">{{ account.name }}</b><template v-if="address"> · <a class="panel-link" :href="address" target="_blank" rel="noopener">{{ address }}</a></template></span>
            <span v-if="!state.entry?.address" class="panel-sub detail-warn">{{ t('登录入口没有开启自建中转或 Cloudflare 隧道，其他设备打不开') }}</span>
            <span v-else-if="!state.entry?.running" class="panel-sub detail-warn">{{ t('登录入口未运行，使用者暂时无法登录，请到“概览”启动') }}</span>
          </div>
          <div class="panel-side">
            <button v-if="address" type="button" class="panel-button is-outline is-small" @click="copy(t('地址 {value1}，账号 {value2}', { value1: address, value2: account.name }))"><UIcon name="i-lucide-copy" />{{ t('复制') }}</button>
            <button type="button" class="panel-button is-plain is-small" :disabled="Boolean(busy)" :title="t('密码仅在重设时显示一次')" @click="act('password')"><UIcon name="i-lucide-key-round" />{{ t('重设密码') }}</button>
          </div>
        </div>
      </div>

      <template v-if="account.os_user">
        <article class="panel-card is-tall"><LoginCard :target="account.name" :who="t('托管账号 {value1}', { value1: account.name })" /></article>
        <article class="panel-card is-tall"><AccountEnv :account="account.name" /></article>
      </template>
      <article v-else class="panel-card is-tall">
        <div class="detail-shared">
          <p class="panel-note" style="margin: 0; flex: 1"><UIcon name="i-lucide-info" />{{ t('未隔离账号与管理员共用命令行登录、技能与系统提示词；隔离后将使用独立的一份。') }}</p>
          <button type="button" class="panel-button is-outline is-small" @click="emit('owner')">{{ t('查看管理员设置') }}</button>
        </div>
      </article>

      <article class="panel-card is-tall"><AccountWorkflows :account="account.name" /></article>
      <article class="panel-card is-tall"><AccountKeys :account="account.name" @changed="reload" /></article>

      <h3 class="panel-section-title"><UIcon name="i-lucide-settings-2" />{{ t('账号操作') }}</h3>
      <div class="panel-rows">
        <div class="panel-row detail-op">
          <div class="panel-main"><div class="panel-title">{{ account.disabled ? t('启用账号') : t('停用账号') }}</div>
            <span class="panel-sub">{{ account.disabled ? t('启用后使用者可重新登录') : t('所有登录立即失效且无法再登录；实例与文件保留，可随时启用') }}</span></div>
          <button v-if="account.disabled" type="button" class="panel-button is-outline is-small" :disabled="Boolean(busy)" @click="act('enable', t('账号已启用'))">{{ t('启用') }}</button>
          <button v-else type="button" class="panel-button is-outline is-small" :disabled="Boolean(busy)" @click="ask('disable')">{{ t('停用') }}</button>
        </div>
        <div v-if="account.os_user" class="panel-row detail-op">
          <div class="panel-main"><div class="panel-title">{{ t('取消隔离') }}</div>
            <span class="panel-sub">{{ t('删除 Windows 用户 {value1} 及其中的登录与技能，账号改为以你的身份运行', { value1: account.os_user }) }}</span></div>
          <button type="button" class="panel-button is-outline is-small" :disabled="Boolean(busy)" @click="ask('os-user/remove')">{{ t('取消隔离') }}</button>
        </div>
        <div v-if="account.protected" class="panel-row detail-op">
          <div class="panel-main"><div class="panel-title">{{ t('关闭入口保护') }}</div>
            <span class="panel-sub">{{ t('本机其他程序将可直接访问该账号的网站') }}</span></div>
          <button type="button" class="panel-button is-outline is-small" :disabled="Boolean(busy)" @click="ask('protect-off')">{{ t('关闭') }}</button>
        </div>
        <div class="panel-row detail-op">
          <div class="panel-main"><div class="panel-title">{{ t('删除账号') }}</div>
            <span class="panel-sub">{{ t('使用者无法再登录；文件夹 {value1} 保留，需要时手动删除', { value1: account.home }) }}</span></div>
          <button type="button" class="panel-button is-plain is-small is-danger" :disabled="Boolean(busy)" @click="ask('remove')"><UIcon name="i-lucide-trash-2" />{{ t('删除') }}</button>
        </div>
      </div>
    </div>
  </section>
  <section v-else class="panel-empty"><UIcon name="i-lucide-user-x" />{{ t('账号已不存在。') }}</section>

  <UModal :open="Boolean(secret)" :title="secret?.title" :description="t('密码只显示这一次，请现在交给使用者。')" @update:open="(open) => !open && (secret = null)">
    <template #body>
      <div class="panel-secret"><span>{{ secret?.password }}</span>
        <button type="button" class="panel-icon-button" :aria-label="t('复制密码')" @click="copy(secret.password)"><UIcon name="i-lucide-copy" /></button></div>
      <div class="panel-form-foot">
        <button type="button" class="panel-button is-primary" @click="copy(t('地址 {value1}，账号 {value2}，密码 {value3}', { value1: address, value2: props.name, value3: secret.password }))"><UIcon name="i-lucide-copy" />{{ t('复制完整登录信息') }}</button>
      </div>
    </template>
  </UModal>
  <UModal :open="Boolean(confirming)" :title="confirming?.title" @update:open="(open) => !open && (confirming = null)">
    <template #body>
      <p style="margin: 0; color: #4b5563; font-size: 14px; line-height: 1.7">{{ confirming?.text() }}</p>
      <div class="panel-form-foot">
        <button type="button" class="panel-button is-plain" @click="confirming = null">{{ t('取消') }}</button>
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
.detail-login { display: block; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
</style>

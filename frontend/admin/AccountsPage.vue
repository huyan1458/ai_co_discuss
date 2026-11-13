<script setup>
/**
 * Hosted accounts: the shared programs accounts with their own Windows user run, the accounts with what each still lacks,
 * the creation wizard, and one account's page.
 */
import { computed, inject, ref } from "vue";
import { call } from "./api.js";
import AccountDetail from "./AccountDetail.vue";
import NewAccount from "./NewAccount.vue";
import SkillLibrary from "./SkillLibrary.vue";

const emit = defineEmits(["local"]);
const { state, reload, notify } = inject("panel");
const view = ref({ page: "list", name: "" }), installing = ref(false);
const runtime = computed(() => state.value.clis || {});
const PARTS = [["claude", "Claude Code"], ["codex", "Codex"], ["agy", "Antigravity"], ["app", "共议"], ["python", "Python"]];
const runtime_ready = computed(() => PARTS.every(([key]) => runtime.value[key]));
const runtime_stale = computed(() => runtime.value.app && runtime.value.app_version && runtime.value.app_version !== state.value.version);

/** What an account still lacks, in the order to fix it. */
function todo(account) {
  if (!account.os_user) return "未隔离";
  if (!account.skills) return "AI 环境未初始化";
  return "";
}

async function install() {
  installing.value = true;
  try {
    const result = await call("clis/install", {});
    const problems = [...(result.missing || []).map((item) => `没有找到 ${item}`), ...(result.warnings || [])];
    notify(problems.length ? "warning" : "info", problems.length ? problems.join("；") : "共享运行环境已就绪");
    await reload();
  } catch (failure) { notify("error", failure.message); }
  finally { installing.value = false; }
}
</script>

<template>
  <NewAccount v-if="view.page === 'new'" @cancel="view = { page: 'list', name: '' }" @done="(name) => (view = { page: 'detail', name })" />
  <AccountDetail v-else-if="view.page === 'detail'" :name="view.name" @back="view = { page: 'list', name: '' }" @local="emit('local')" />

  <section v-else>
    <h3 class="panel-section-title"><UIcon name="i-lucide-hard-drive-download" />共享运行环境</h3>
    <article class="panel-card" :class="{ 'is-current': runtime_ready && !runtime_stale }">
      <div class="panel-tile"><UIcon name="i-lucide-hard-drive-download" /></div>
      <div class="panel-main">
        <div class="panel-title">隔离账号用的程序
          <span v-for="[key, label] in PARTS" :key="key" class="panel-tag" :class="runtime[key] ? 'is-green' : 'is-gray'"><UIcon :name="runtime[key] ? 'i-lucide-check' : 'i-lucide-minus'" />{{ label }}</span>
          <span v-if="runtime_stale" class="panel-tag is-amber">v{{ runtime.app_version }}，需更新</span>
        </div>
        <span class="panel-sub" style="white-space: normal">隔离账号读不到你的个人目录，所以把命令行程序、共议和 Python 复制到 C:\ProgramData\CoDiscuss 给它们用。新建隔离账号时会自动安装；更新共议时自动同步。你自己的命令行程序升级后，点一次“更新”。</span>
      </div>
      <div class="panel-side">
        <button type="button" class="panel-button is-small" :class="runtime_ready && !runtime_stale ? 'is-outline' : 'is-primary'" :disabled="installing" @click="install">
          <UIcon :name="installing ? 'i-lucide-loader' : 'i-lucide-download'" :class="{ 'animate-spin': installing }" />{{ runtime.app ? "更新" : "安装" }}</button>
      </div>
    </article>

    <h3 class="panel-section-title"><UIcon name="i-lucide-users" />托管账号
      <button type="button" class="panel-button is-primary is-small panel-section-action" @click="view = { page: 'new', name: '' }"><UIcon name="i-lucide-plus" />新建账号</button></h3>
    <div class="panel-list">
      <div v-if="!state.accounts.length" class="panel-empty"><UIcon name="i-lucide-users" />还没有托管账号。给别人开一个账号，他就能用这台电脑上的 AI。
        <button type="button" class="panel-button is-primary is-small" @click="view = { page: 'new', name: '' }"><UIcon name="i-lucide-plus" />新建账号</button></div>
      <button v-for="account in state.accounts" :key="account.name" type="button" class="panel-card account-row" @click="view = { page: 'detail', name: account.name }">
        <div class="panel-tile">{{ account.name.slice(0, 1).toUpperCase() }}</div>
        <div class="panel-main">
          <div class="panel-title">{{ account.name }}
            <span class="panel-tag" :class="account.running ? 'is-green' : 'is-gray'">{{ account.running ? "运行中" : "已停止" }}</span>
            <span class="panel-tag" :class="account.os_user ? 'is-blue' : 'is-amber'">{{ account.os_user ? "已隔离" : "未隔离" }}</span>
            <span v-if="account.keys" class="panel-tag is-gray">{{ account.keys }} 个密钥</span>
          </div>
          <span class="panel-sub">http://127.0.0.1:{{ account.port }}<template v-if="todo(account)"> · <span style="color: var(--panel-amber)">待处理：{{ todo(account) }}</span></template></span>
        </div>
        <UIcon name="i-lucide-chevron-right" class="account-go" />
      </button>
    </div>

    <h3 class="panel-section-title"><UIcon name="i-lucide-sparkles" />技能库</h3>
    <article class="panel-card is-tall"><SkillLibrary /></article>
  </section>
</template>

<style scoped>
.account-row { width: 100%; text-align: left; cursor: pointer; }
.account-go { width: 20px; height: 20px; color: var(--panel-faint); }
</style>

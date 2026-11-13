<script setup>
/**
 * AI command-line sign-ins of each hosted account, made under that account's Windows user.
 *
 * Claude takes a long-lived token from `claude setup-token`; Codex signs in through a browser on this computer; Antigravity
 * signs in inside its own window, which opens on this computer's desktop.
 */
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { call } from "./api.js";

const { state, reload, notify } = inject("panel");
const CLIS = [
  { key: "claude", label: "Claude Code", icon: "/icons/claude.svg" },
  { key: "codex", label: "Codex", icon: "/icons/openai.svg" },
  { key: "agy", label: "Antigravity", icon: "/icons/gemini.svg" },
];
const status = ref({});
const checking = ref({});
const installing = ref(false);
const isolated = computed(() => state.value.accounts.filter((account) => account.os_user));
const plain = computed(() => state.value.accounts.filter((account) => !account.os_user));
const installed = computed(() => CLIS.filter((cli) => state.value.clis?.[cli.key]));

/** Ask Windows, as the account's user, which programs are signed in; this takes a few seconds per account. */
async function check(account) {
  checking.value = { ...checking.value, [account.name]: true };
  try { status.value = { ...status.value, [account.name]: await call(`accounts/${account.name}/cli`) }; }
  catch (failure) { status.value = { ...status.value, [account.name]: { error: failure.message } }; }
  finally { checking.value = { ...checking.value, [account.name]: false }; }
}
async function check_all() { for (const account of isolated.value) await check(account); }
onMounted(check_all);
watch(() => isolated.value.map((account) => account.name).join(), (now, before) => { if (now !== before) check_all(); });

async function install() {
  installing.value = true;
  try {
    const result = await call("clis/install", {});
    notify(result.missing.length ? "warning" : "info", result.missing.length ? `已安装 ${result.installed.join("、") || "无"}；这台电脑上没有找到 ${result.missing.join("、")}` : "命令行程序已安装到共享位置");
    await reload();
  } catch (failure) { notify("error", failure.message); }
  finally { installing.value = false; }
}

// ---- Claude: paste a token ----
const claude = ref(null);
async function save_claude() {
  claude.value.saving = true;
  try {
    await call(`accounts/${claude.value.account}/claude`, { token: claude.value.token });
    notify("info", "Claude Code 令牌已保存");
    const account = state.value.accounts.find((item) => item.name === claude.value.account);
    claude.value = null;
    if (account) check(account);
  } catch (failure) { notify("error", failure.message); claude.value.saving = false; }
}
async function clear_claude(account) {
  try { await call(`accounts/${account.name}/claude/clear`, {}); notify("info", "已移除 Claude Code 令牌"); check(account); }
  catch (failure) { notify("error", failure.message); }
}

// ---- Codex: a browser sign-in on this computer ----
const codex = ref(null);
let poll = null;
async function start_codex(account) {
  try {
    const { id } = await call(`accounts/${account.name}/codex`, {});
    codex.value = { account, id, link: "", done: false };
    clearInterval(poll);
    poll = setInterval(async () => {
      try {
        const progress = await call(`accounts/${account.name}/codex/${id}`);
        if (!codex.value || codex.value.id !== id) return;
        Object.assign(codex.value, progress);
        if (progress.done) { clearInterval(poll); notify("info", `${account.name} 的 Codex 已登录`); check(account); }
      } catch (failure) { clearInterval(poll); if (codex.value?.id === id) codex.value.error = failure.message; }
    }, 1500);
  } catch (failure) { notify("error", failure.message); }
}
function close_codex() { clearInterval(poll); codex.value = null; }
onBeforeUnmount(() => clearInterval(poll));

// ---- Antigravity: its own window ----
async function open_agy(account) {
  try { await call(`accounts/${account.name}/agy`, {}); notify("info", "已在这台电脑上打开 Antigravity 登录窗口"); }
  catch (failure) { notify("error", failure.message); }
}

function action(account, cli) {
  if (cli.key === "claude") claude.value = { account: account.name, token: "", saving: false };
  if (cli.key === "codex") start_codex(account);
  if (cli.key === "agy") open_agy(account);
}
const signed_in = (account, cli) => status.value[account.name]?.[cli.key] === true;
</script>

<template>
  <section>
    <h3 class="panel-section-title"><UIcon name="i-lucide-package" />共享命令行程序</h3>
    <article class="panel-card">
      <div class="panel-tile"><UIcon name="i-lucide-hard-drive-download" /></div>
      <div class="panel-main">
        <div class="panel-title">安装到所有用户可用的位置
          <span v-for="cli in CLIS" :key="cli.key" class="panel-tag" :class="state.clis?.[cli.key] ? 'is-green' : 'is-gray'">
            <UIcon :name="state.clis?.[cli.key] ? 'i-lucide-check' : 'i-lucide-minus'" />{{ cli.label }}</span>
        </div>
        <span class="panel-sub">把这台电脑上你自己的 Claude Code、Codex、Antigravity 复制到 C:\ProgramData\CoDiscuss\cli，各用户的 AI 从这里运行。更新命令行后再点一次。</span>
      </div>
      <div class="panel-side">
        <button type="button" class="panel-button is-outline is-small" :disabled="installing" @click="install">
          <UIcon :name="installing ? 'i-lucide-loader' : 'i-lucide-download'" :class="{ 'animate-spin': installing }" />{{ installed.length ? "更新" : "安装" }}</button>
      </div>
    </article>

    <h3 class="panel-section-title"><UIcon name="i-lucide-users" />各用户的登录</h3>
    <div class="panel-list">
      <div v-if="!isolated.length" class="panel-empty"><UIcon name="i-lucide-shield" />还没有带 Windows 用户的账号。先在“用户”页的卡片菜单里创建 Windows 用户。</div>
      <article v-for="account in isolated" :key="account.name" class="panel-card is-tall">
        <div class="panel-card-row">
          <div class="panel-tile">{{ account.name.slice(0, 1).toUpperCase() }}</div>
          <div class="panel-main">
            <div class="panel-title">{{ account.name }}<span class="panel-tag is-blue"><UIcon name="i-lucide-shield" />{{ account.os_user }}</span></div>
            <span v-if="status[account.name]?.error" class="panel-sub" style="color: #dc2626">{{ status[account.name].error }}</span>
            <span v-else class="panel-sub">登录信息保存在这个 Windows 用户里，与你和其他用户的登录互不影响。</span>
          </div>
          <div class="panel-side">
            <button type="button" class="panel-icon-button" :class="{ 'is-spinning': checking[account.name] }" :disabled="checking[account.name]" title="重新检查登录状态" aria-label="重新检查登录状态" @click="check(account)"><UIcon name="i-lucide-refresh-cw" /></button>
          </div>
        </div>
        <div class="panel-logins">
          <div v-for="cli in CLIS" :key="cli.key" class="panel-login">
            <img :src="cli.icon" alt="" />
            <div class="panel-login-text">{{ cli.label }}
              <small v-if="checking[account.name] && !status[account.name]">检查中…</small>
              <small v-else-if="signed_in(account, cli)" class="is-ok">已登录</small>
              <small v-else-if="!state.clis?.[cli.key]">未安装共享程序</small>
              <small v-else>未登录</small>
            </div>
            <UDropdownMenu v-if="cli.key === 'claude' && signed_in(account, cli)" :items="[[{ label: '更换令牌', icon: 'i-lucide-replace', onSelect: () => action(account, cli) }, { label: '移除令牌', icon: 'i-lucide-trash-2', onSelect: () => clear_claude(account) }]]" :content="{ align: 'end' }">
              <button type="button" class="panel-button is-outline is-small">管理</button>
            </UDropdownMenu>
            <button v-else type="button" class="panel-button is-outline is-small" :disabled="!state.clis?.[cli.key]" @click="action(account, cli)">{{ signed_in(account, cli) ? "重新登录" : "登录" }}</button>
          </div>
        </div>
      </article>
      <p v-if="plain.length" class="panel-note"><UIcon name="i-lucide-info" />{{ plain.map((account) => account.name).join("、") }} 还没有 Windows 用户，它们的 AI 用的是你自己的登录。</p>
    </div>
  </section>

  <UModal :open="Boolean(claude)" title="Claude Code 令牌" :description="`为 ${claude?.account} 填写 claude setup-token 生成的长期令牌`" @update:open="(open) => !open && (claude = null)">
    <template #body>
      <form class="panel-field" @submit.prevent="save_claude">令牌
        <input v-model="claude.token" class="panel-input" type="password" placeholder="sk-ant-oat01-…" autocomplete="off" spellcheck="false" />
        <small>在任意一台已登录 Claude 的电脑上运行 claude setup-token 获得。令牌只保存在这个用户的环境变量里。</small>
      </form>
      <div class="panel-form-foot">
        <button type="button" class="panel-button is-plain" @click="claude = null">取消</button>
        <button type="button" class="panel-button is-primary" :disabled="!claude?.token.trim() || claude?.saving" @click="save_claude">保存</button>
      </div>
    </template>
  </UModal>

  <UModal :open="Boolean(codex)" title="登录 Codex" :description="`为 ${codex?.account.name} 登录`" @update:open="(open) => !open && close_codex()">
    <template #body>
      <p v-if="codex?.error" class="panel-note is-amber"><UIcon name="i-lucide-circle-alert" />{{ codex.error }}</p>
      <p v-else-if="codex?.done" class="panel-note"><UIcon name="i-lucide-circle-check" style="color: #16a34a" />登录完成，可以关闭此窗口。</p>
      <template v-else-if="codex?.link">
        <p class="panel-note"><UIcon name="i-lucide-info" />请在这台电脑的浏览器中打开，选择要给 {{ codex.account.name }} 使用的 ChatGPT 账号并同意。授权完成后会自动回到这里。</p>
        <div class="panel-form-foot"><a class="panel-button is-primary" :href="codex.link" target="_blank" rel="noopener"><UIcon name="i-lucide-external-link" />在浏览器中打开</a></div>
      </template>
      <p v-else class="panel-note"><UIcon name="i-lucide-loader" class="animate-spin" />正在以 {{ codex?.account.os_user }} 的身份启动 Codex 登录…</p>
    </template>
  </UModal>
</template>

<script setup>
/**
 * Command-line sign-in: which of Claude Code, Codex and Antigravity are signed in, and how, for the computer owner and
 * for each hosted account that has its own Windows user; a dialog signs one in any way it supports.
 */
import { computed, inject, onMounted, ref, watch } from "vue";
import { call } from "./api.js";
import LoginDialog from "./LoginDialog.vue";

const { state, reload, notify } = inject("panel");
const CLIS = [
  { key: "claude", label: "Claude Code", icon: "/icons/claude.svg" },
  { key: "codex", label: "Codex", icon: "/icons/openai.svg" },
  { key: "agy", label: "Antigravity", icon: "/icons/gemini.svg" },
];
// How each status reads on its row.
const METHOD_LABELS = { setup_token: "Setup Token", subscription: "Claude 账号", api_key: "API 密钥", api_key_helper: "密钥脚本", third_party: "第三方 API",
  chatgpt: "ChatGPT 账号", access_token: "访问令牌", google: "Google 账号", bedrock: "Bedrock", vertex: "Vertex", foundry: "Foundry" };
const OWNER = { name: "_", title: "本机", sub: "你自己的命令行程序；没有 Windows 用户的托管账号也用这里的登录" };

const status = ref({}), checking = ref({}), installing = ref(false);
const dialog = ref({ open: false, target: "_", who: "", cli: null });
const isolated = computed(() => state.value.accounts.filter((account) => account.os_user));
const plain = computed(() => state.value.accounts.filter((account) => !account.os_user));
const targets = computed(() => [OWNER, ...isolated.value.map((account) => ({ name: account.name, title: account.name, sub: `Windows 用户 ${account.os_user}，登录与你和其他用户互不影响`, os_user: account.os_user }))]);

/** Ask, as the target's user, which programs are signed in; a few seconds each. */
async function check(target) {
  checking.value = { ...checking.value, [target]: true };
  try { status.value = { ...status.value, [target]: await call(`logins/${target}`) }; }
  catch (failure) { status.value = { ...status.value, [target]: { error: failure.message } }; }
  finally { checking.value = { ...checking.value, [target]: false }; }
}
async function check_all() { for (const target of targets.value) await check(target.name); }
onMounted(check_all);
watch(() => targets.value.map((target) => target.name).join(), (now, before) => { if (now !== before) check_all(); });

function row(target, cli) { return status.value[target]?.[cli.key] || null; }
function describe(item) {
  if (!item) return "检查中…";
  if (!item.installed) return "未安装";
  if (!item.signed_in) return item.error ? `无法读取：${item.error}` : "未登录";
  return `已登录 · ${METHOD_LABELS[item.method] || item.method}${item.detail ? ` · ${item.detail}` : ""}`;
}

function open(target, cli) { dialog.value = { open: true, target: target.name, who: target.name === "_" ? "本机（你自己）" : `托管账号 ${target.name}`, cli }; }
function finished(message, level = "info") { notify(level, message); if (level !== "error") check(dialog.value.target); }

async function sign_out(target, cli) {
  try { await call(`logins/${target.name}/${cli.key}/logout`, {}); notify("info", `${cli.label} 已退出登录`); check(target.name); }
  catch (failure) { notify("error", failure.message); }
}

async function install() {
  installing.value = true;
  try {
    const result = await call("clis/install", {});
    notify(result.missing.length ? "warning" : "info", result.missing.length ? `已安装 ${result.installed.join("、") || "无"}；这台电脑上没有找到 ${result.missing.join("、")}` : "命令行程序已安装到共享位置");
    await reload();
  } catch (failure) { notify("error", failure.message); }
  finally { installing.value = false; }
}
</script>

<template>
  <section>
    <div class="panel-list">
      <article v-for="target in targets" :key="target.name" class="panel-card is-tall">
        <div class="panel-card-row">
          <div class="panel-tile"><UIcon v-if="target.name === '_'" name="i-lucide-monitor" /><template v-else>{{ target.name.slice(0, 1).toUpperCase() }}</template></div>
          <div class="panel-main">
            <div class="panel-title">{{ target.title }}<span v-if="target.os_user" class="panel-tag is-blue"><UIcon name="i-lucide-shield" />{{ target.os_user }}</span></div>
            <span v-if="status[target.name]?.error" class="panel-sub" style="color: #dc2626">{{ status[target.name].error }}</span>
            <span v-else class="panel-sub">{{ target.sub }}</span>
          </div>
          <div class="panel-side">
            <button type="button" class="panel-icon-button" :class="{ 'is-spinning': checking[target.name] }" :disabled="checking[target.name]" title="重新检查登录状态" aria-label="重新检查登录状态" @click="check(target.name)"><UIcon name="i-lucide-refresh-cw" /></button>
          </div>
        </div>
        <div class="panel-logins">
          <div v-for="cli in CLIS" :key="cli.key" class="panel-login">
            <img :src="cli.icon" alt="" />
            <div class="panel-login-text">{{ cli.label }}
              <small :class="{ 'is-ok': row(target.name, cli)?.signed_in }" :title="describe(row(target.name, cli))">{{ describe(row(target.name, cli)) }}</small>
            </div>
            <UDropdownMenu v-if="row(target.name, cli)?.signed_in" :items="[[{ label: '更换登录方式', icon: 'i-lucide-replace', onSelect: () => open(target, cli) }, { label: '退出登录', icon: 'i-lucide-log-out', color: 'error', onSelect: () => sign_out(target, cli) }]]" :content="{ align: 'end' }">
              <button type="button" class="panel-button is-outline is-small">管理</button>
            </UDropdownMenu>
            <button v-else type="button" class="panel-button is-outline is-small" :disabled="!row(target.name, cli)?.installed" @click="open(target, cli)">登录</button>
          </div>
        </div>
      </article>
    </div>

    <template v-if="state.hosting">
      <h3 class="panel-section-title"><UIcon name="i-lucide-package" />托管账号用的命令行程序</h3>
      <article class="panel-card">
        <div class="panel-tile"><UIcon name="i-lucide-hard-drive-download" /></div>
        <div class="panel-main">
          <div class="panel-title">安装到所有用户可用的位置
            <span v-for="cli in CLIS" :key="cli.key" class="panel-tag" :class="state.clis?.[cli.key] ? 'is-green' : 'is-gray'">
              <UIcon :name="state.clis?.[cli.key] ? 'i-lucide-check' : 'i-lucide-minus'" />{{ cli.label }}</span>
          </div>
          <span class="panel-sub">把你自己的 Claude Code、Codex、Antigravity 复制到 C:\ProgramData\CoDiscuss\cli，各用户的 AI 从这里运行。更新命令行后再点一次。</span>
        </div>
        <div class="panel-side">
          <button type="button" class="panel-button is-outline is-small" :disabled="installing" @click="install">
            <UIcon :name="installing ? 'i-lucide-loader' : 'i-lucide-download'" :class="{ 'animate-spin': installing }" />{{ CLIS.some((cli) => state.clis?.[cli.key]) ? "更新" : "安装" }}</button>
        </div>
      </article>
      <p v-if="plain.length" class="panel-note" style="margin-top: 14px"><UIcon name="i-lucide-info" />{{ plain.map((account) => account.name).join("、") }} 还没有 Windows 用户，它们的 AI 用的是“本机”的登录。可在“用户”页的卡片菜单里创建 Windows 用户。</p>
    </template>
  </section>

  <LoginDialog v-model:open="dialog.open" :target="dialog.target" :who="dialog.who" :cli="dialog.cli" :methods="dialog.cli ? state.login_methods?.[dialog.cli.key] || [] : []" @done="finished" />
</template>

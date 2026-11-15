<script setup>
/**
 * The three command-line programs of one target (the owner "_", or a hosted account with its own Windows user): whether
 * each is signed in and how, with the actions right on its row: sign in, switch the way, sign out.
 */
import { inject, onMounted, ref, watch } from "vue";
import { call } from "./api.js";
import LoginDialog from "./LoginDialog.vue";
import { t } from '../i18n.js';

const props = defineProps({ target: { type: String, required: true }, who: { type: String, required: true } });
const emit = defineEmits(["status"]);
const { state, notify, refreshed } = inject("panel");

const CLIS = [
  { key: "claude", label: "Claude Code", icon: "/icons/claude.svg" },
  { key: "codex", label: "Codex", icon: "/icons/openai.svg" },
  { key: "agy", label: "Antigravity", icon: "/icons/gemini.svg" },
];
const METHOD_LABELS = { setup_token: "Setup Token", subscription: t('Claude 账号'), api_key: t('API 密钥'), api_key_helper: t('密钥脚本'), third_party: t('第三方 API'),
  chatgpt: t('ChatGPT 账号'), access_token: t('访问令牌'), google: t('Google 账号') };

const status = ref(null), checking = ref(false), dialog = ref({ open: false, cli: null });

/** Ask, as the target's own user, which programs are signed in; it takes a few seconds. */
async function check() {
  checking.value = true;
  try { status.value = await call(`logins/${props.target}`); }
  catch (failure) { status.value = { error: failure.message }; }
  finally { checking.value = false; emit("status", status.value); }
}
onMounted(check);
watch(refreshed, check);
watch(() => props.target, check);
defineExpose({ check });

const row = (cli) => status.value?.[cli.key] || null;
function describe(item) {
  if (!item) return checking.value ? t('检查中…') : "—";
  if (!item.installed) return t('这台电脑上没有安装');
  if (!item.signed_in) return item.error ? t('无法读取：{value1}', { value1: item.error }) : t('未登录');
  return `${METHOD_LABELS[item.method] || item.method}${item.detail ? ` · ${item.detail}` : ""}`;
}

function open(cli) { dialog.value = { open: true, cli }; }
function finished(message, level = "info") { notify(level, message); if (level !== "error") check(); }
async function sign_out(cli) {
  try { await call(`logins/${props.target}/${cli.key}/logout`, {}); notify("info", t('{value1} 已退出登录', { value1: cli.label })); check(); }
  catch (failure) { notify("error", failure.message); }
}
</script>

<template>
  <div class="login-card">
    <div class="login-head">
      <span>{{ t('命令行登录') }}</span>
      <button type="button" class="panel-icon-button" :class="{ 'is-spinning': checking }" :disabled="checking" :title="t('重新检查')" :aria-label="t('重新检查登录状态')" @click="check"><UIcon name="i-lucide-refresh-cw" /></button>
    </div>
    <p v-if="status?.error" class="panel-note is-amber"><UIcon name="i-lucide-circle-alert" />{{ status.error }}</p>
    <div v-for="cli in CLIS" v-else :key="cli.key" class="login-row">
      <img :src="cli.icon" alt="" />
      <div class="login-text">
        <strong>{{ cli.label }}</strong>
        <small :class="{ 'is-ok': row(cli)?.signed_in, 'is-warn': row(cli) && row(cli).installed && !row(cli).signed_in }" :title="describe(row(cli))">
          <UIcon v-if="row(cli)?.signed_in" name="i-lucide-circle-check" /><UIcon v-else-if="row(cli)?.installed" name="i-lucide-circle-dashed" />{{ describe(row(cli)) }}</small>
      </div>
      <template v-if="row(cli)?.signed_in">
        <button type="button" class="panel-button is-outline is-small" @click="open(cli)"><UIcon name="i-lucide-arrow-left-right" />{{ t('切换方式') }}</button>
        <button type="button" class="panel-button is-plain is-small" @click="sign_out(cli)">{{ t('退出') }}</button>
      </template>
      <button v-else type="button" class="panel-button is-primary is-small" :disabled="!row(cli)?.installed" @click="open(cli)"><UIcon name="i-lucide-log-in" />{{ t('登录') }}</button>
    </div>
  </div>
  <LoginDialog v-model:open="dialog.open" :target="target" :who="who" :cli="dialog.cli" :methods="dialog.cli ? state.login_methods?.[dialog.cli.key] || [] : []" @done="finished" />
</template>

<style scoped>
.login-card { display: flex; flex-direction: column; gap: 4px; }
.login-head { display: flex; align-items: center; justify-content: space-between; color: var(--panel-muted); font-size: 13px; font-weight: 500; }
.login-row { display: flex; align-items: center; gap: 12px; padding: 12px 4px; border-top: 1px solid var(--panel-line); }
.login-row img { width: 22px; height: 22px; flex-shrink: 0; }
.login-text { display: flex; flex: 1; flex-direction: column; gap: 3px; min-width: 0; }
.login-text strong { font-size: 14px; font-weight: 600; }
.login-text small { display: flex; align-items: center; gap: 5px; overflow: hidden; color: var(--panel-faint); font-size: 12px; white-space: nowrap; text-overflow: ellipsis; }
.login-text small.is-ok { color: var(--panel-green); }
.login-text small.is-warn { color: var(--panel-amber); }
.login-text small > [class*="icon"] { width: 13px; height: 13px; flex-shrink: 0; }
</style>

<script setup>
/**
 * Sign one command-line program in for one target (the owner, or a hosted account's Windows user), in any of the ways it
 * supports: fill in a token, key or address, or run its own sign-in, open the link it gives on any device and paste back
 * the code (or, for Codex, the address the browser ended on).
 */
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { call } from "./api.js";

const props = defineProps({ open: Boolean, target: { type: String, default: "_" }, who: { type: String, default: "" }, cli: { type: Object, default: null }, methods: { type: Array, default: () => [] } });
const emit = defineEmits(["update:open", "done"]);

const FIELDS = {
  token: { label: "令牌", secret: true },
  key: { label: "API 密钥", secret: true },
  base_url: { label: "接口地址", placeholder: "https://…" },
  model: { label: "模型", placeholder: "可空：用该服务的默认模型" },
  small_model: { label: "后台任务用的小模型", placeholder: "可空：与上面相同" },
  env: { label: "环境变量", multiline: true, placeholder: "每行一个：名称=值\n例如 CLAUDE_CODE_USE_BEDROCK=1" },
};
// What each way needs explained, keyed "program:method".
const HINTS = {
  "claude:setup_token": "在任意一台已登录 Claude 的电脑上运行 claude setup-token，把生成的令牌（sk-ant-oat01-…）粘贴到这里。有效期一年，最稳定。",
  "claude:subscription": "用 Claude Pro / Max / Team 账号登录。在任意设备打开下面的链接并同意，再把页面显示的授权码粘贴回来。",
  "claude:console": "用 Anthropic Console 账号登录，按 API 用量计费。在任意设备打开链接并同意，再把授权码粘贴回来。",
  "claude:api_key": "Anthropic Console 创建的 API 密钥（sk-ant-api03-…），按用量计费。",
  "claude:third_party": "支持 Anthropic 接口的服务，例如 DeepSeek、智谱、Kimi、OpenRouter。后台任务也会用这里的模型。",
  "claude:env": "写进 Claude Code 的 settings.json，用于 Bedrock、Vertex、Foundry、企业网关等。已有的登录相关变量会先被清除。",
  "codex:chatgpt": "在任意设备打开链接并登录 ChatGPT。浏览器最后会跳到一个打不开的 localhost 地址，把地址栏里的整段地址粘贴回来。",
  "codex:device": "需要先在 ChatGPT 的安全设置里开启“设备代码登录”。在任意设备打开链接，输入下面的一次性码，完成后这里会自动结束。",
  "codex:api_key": "OpenAI 平台的 API 密钥，按用量计费。",
  "codex:third_party": "Codex 只支持 Responses 接口；只提供 chat/completions 的服务接不上。与官方账号共用供应商 custom，来回切换会话都能续接。若这台电脑之前没用过 custom，原来的会话不会出现在列表里。",
  "codex:access_token": "仅 ChatGPT Enterprise：管理员发放的访问令牌。",
  "agy:google": "在任意设备打开链接，用 Google 账号登录并同意，再把页面显示的授权码粘贴回来。",
};
// Anthropic-compatible addresses offered as one-click fills (taken from the services' own documentation and CC Switch).
const CLAUDE_PRESETS = [
  { label: "DeepSeek", base_url: "https://api.deepseek.com/anthropic" },
  { label: "智谱 GLM", base_url: "https://open.bigmodel.cn/api/anthropic" },
  { label: "Kimi", base_url: "https://api.moonshot.cn/anthropic" },
  { label: "OpenRouter", base_url: "https://openrouter.ai/api" },
];

const choice = ref(""), values = ref({}), saving = ref(false);
const job = ref(null), progress = ref({}), answer = ref(""), sending = ref(false);
let poll = null;

const method = computed(() => props.methods.find((item) => item.key === choice.value) || null);
const hint = computed(() => HINTS[`${props.cli?.key}:${choice.value}`] || "");
const field_label = (name) => (name === "key" && choice.value === "access_token" ? "访问令牌" : name === "token" && choice.value === "third_party" ? "密钥" : FIELDS[name].label);

function stop_job() {
  clearInterval(poll); poll = null;
  if (job.value && !progress.value.ended) call(`login-jobs/${job.value}/cancel`, {}).catch(() => {});
  job.value = null; progress.value = {}; answer.value = "";
}

function choose(key) { stop_job(); choice.value = key; values.value = {}; }
watch(() => props.open, (open) => { if (open) choose(props.methods[0]?.key || ""); else stop_job(); });
onBeforeUnmount(stop_job);

async function save() {
  saving.value = true;
  try {
    await call(`logins/${props.target}/${props.cli.key}/apply`, { method: choice.value, ...values.value });
    emit("done", `${props.cli.label} 已配置`);
    emit("update:open", false);
  } catch (failure) { emit("done", failure.message, "error"); }
  finally { saving.value = false; }
}

let starting = false;
async function start() {
  if (starting) return;
  starting = true;
  stop_job();
  try {
    const { id } = await call(`logins/${props.target}/${props.cli.key}/start`, { method: choice.value });
    job.value = id;
    const timer = setInterval(async () => {
      try {
        progress.value = await call(`login-jobs/${id}`);
        if (progress.value.ended) {
          clearInterval(timer);
          if (progress.value.done) { emit("done", `${props.cli.label} 已登录`); emit("update:open", false); }
        }
      } catch (failure) { clearInterval(timer); progress.value = { ended: true, error: failure.message }; }
    }, 1500);
    poll = timer;
  } catch (failure) { emit("done", failure.message, "error"); }
  finally { starting = false; }
}

async function send() {
  sending.value = true;
  try { await call(`login-jobs/${job.value}/submit`, { text: answer.value }); answer.value = ""; }
  catch (failure) { progress.value = { ...progress.value, error: failure.message }; }
  finally { sending.value = false; }
}

async function copy(text) { try { await navigator.clipboard.writeText(text); } catch { /* the link stays selectable */ } }
</script>

<template>
  <UModal :open="open" :title="`登录 ${cli?.label || ''}`" :description="who" @update:open="(value) => emit('update:open', value)">
    <template #body>
      <div class="panel-chips" style="margin-bottom: 16px">
        <button v-for="item in methods" :key="item.key" type="button" class="panel-chip" :class="{ 'is-active': choice === item.key }" @click="choose(item.key)">{{ item.label }}</button>
      </div>
      <p v-if="hint" class="panel-note" style="margin-bottom: 14px"><UIcon name="i-lucide-info" />{{ hint }}</p>

      <template v-if="method && !method.interactive">
        <div v-if="cli?.key === 'claude' && choice === 'third_party'" class="panel-chips" style="margin-bottom: 12px">
          <button v-for="preset in CLAUDE_PRESETS" :key="preset.label" type="button" class="panel-chip" :class="{ 'is-active': values.base_url === preset.base_url }" @click="values = { ...values, base_url: preset.base_url }">{{ preset.label }}</button>
        </div>
        <form class="login-fields" @submit.prevent="save">
          <label v-for="name in method.fields" :key="name" class="panel-field">{{ field_label(name) }}
            <textarea v-if="FIELDS[name].multiline" v-model="values[name]" class="panel-input login-area" :placeholder="FIELDS[name].placeholder" spellcheck="false" />
            <input v-else v-model="values[name]" class="panel-input" :type="FIELDS[name].secret ? 'password' : 'text'" :placeholder="FIELDS[name].placeholder" autocomplete="off" spellcheck="false" />
          </label>
        </form>
        <div class="panel-form-foot">
          <button type="button" class="panel-button is-plain" @click="emit('update:open', false)">取消</button>
          <button type="button" class="panel-button is-primary" :disabled="saving" @click="save"><UIcon v-if="saving" name="i-lucide-loader" class="animate-spin" />保存</button>
        </div>
      </template>

      <template v-else-if="method">
        <div v-if="!job" class="panel-form-foot" style="margin-top: 0"><button type="button" class="panel-button is-primary" @click="start"><UIcon name="i-lucide-log-in" />开始登录</button></div>
        <template v-else>
          <p v-if="!progress.link && !progress.ended" class="panel-note"><UIcon name="i-lucide-loader" class="animate-spin" />正在启动 {{ cli?.label }} 的登录…</p>
          <div v-if="progress.link" class="login-link">
            <a :href="progress.link" target="_blank" rel="noopener">{{ progress.link }}</a>
            <button type="button" class="panel-button is-outline is-small" @click="copy(progress.link)"><UIcon name="i-lucide-copy" />复制链接</button>
          </div>
          <p v-if="progress.user_code" class="panel-secret" style="margin-top: 12px"><span>{{ progress.user_code }}</span><small style="font: 12px system-ui; color: #6b7280">一次性码，15 分钟内有效</small></p>
          <form v-if="progress.link && progress.asks && !progress.ended" class="login-answer" @submit.prevent="send">
            <input v-model="answer" class="panel-input" :placeholder="progress.asks === 'callback' ? '粘贴浏览器最后跳到的地址（http://localhost:1455/auth/callback?…）' : '粘贴授权码'" autocomplete="off" spellcheck="false" />
            <button type="submit" class="panel-button is-primary" :disabled="!answer.trim() || sending">提交</button>
          </form>
          <p v-if="progress.error" class="panel-note is-amber" style="margin-top: 12px"><UIcon name="i-lucide-circle-alert" />{{ progress.error }}</p>
          <div v-if="progress.ended && !progress.done" class="panel-form-foot">
            <button type="button" class="panel-button is-primary" @click="start"><UIcon name="i-lucide-rotate-cw" />重新开始</button>
          </div>
        </template>
      </template>
    </template>
  </UModal>
</template>

<style scoped>
.login-fields { display: flex; flex-direction: column; gap: 14px; }
.login-area { height: 110px; padding: 10px 14px; resize: vertical; font-family: ui-monospace, Consolas, monospace; font-size: 13px; }
.login-link { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border: 1px solid var(--panel-line); border-radius: 12px; }
.login-link a { overflow: hidden; flex: 1; color: var(--panel-blue); font-size: 13px; white-space: nowrap; text-overflow: ellipsis; }
.login-answer { display: flex; gap: 10px; margin-top: 12px; }
.login-answer .panel-input { flex: 1; }
</style>

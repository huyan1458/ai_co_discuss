<script setup>
/**
 * One bot notification channel (Telegram, Discord, QQ, Feishu…) in the settings' Notifications section: enter the
 * credentials it declares, send the one-time bind code to the bot from the owner's own account, then test or unbind.
 * Credentials go to the local service only; the page never reads them back.
 */
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { t } from './i18n.js';
import { channel_guide } from './notify-guides.js';

const BIND_POLL_MS = 3_000;
const props = defineProps({ channel: { type: Object, required: true }, bridge: { type: Object, required: true } });
const emit = defineEmits(["update"]);
const values = ref({}), busy = ref("");
// An unconfigured channel stays one line until the owner opens its guide and form.
const expanded = ref(false);
const guide = computed(() => channel_guide(props.channel.id));
const show_form = computed(() => !props.channel.bound || (waiting_bind.value && !props.channel.bind_code));
let timer = null;

const waiting_bind = computed(() => props.channel.bound && !props.channel.owner_bound);
const state_text = computed(() => props.channel.ready ? t('已绑定') : waiting_bind.value ? t('等你发送绑定码') : t('未配置'));

async function run(action, extra = {}) {
  return props.bridge.local_request("notify", { channel: props.channel.id, action, ...extra });
}

async function copy_code() {
  try { await navigator.clipboard.writeText(props.channel.bind_code); props.bridge.notify("info", t('绑定码已复制')); }
  catch { props.bridge.notify("warning", t('无法访问剪贴板，请手动输入绑定码')); }
}

async function act(action, message, extra) {
  busy.value = action;
  try {
    const status = await run(action, extra);
    emit("update", { ...props.channel, ...status });
    if (action === "configure") values.value = {};
    if (message) props.bridge.notify("info", message);
  } catch (error) { props.bridge.notify("error", error.message); }
  finally { busy.value = ""; }
}

// While the bind code waits to be sent, read the state now and then so the binding shows without a manual refresh.
watch(waiting_bind, (waiting) => {
  clearInterval(timer);
  timer = waiting ? setInterval(async () => {
    try { emit("update", { ...props.channel, ...await run("status") }); } catch { /* the next tick retries */ }
  }, BIND_POLL_MS) : null;
}, { immediate: true });
onBeforeUnmount(() => clearInterval(timer));
</script>

<template>
  <div class="bot-channel">
    <h4 class="bot-channel-title">{{ channel.label }}<small :class="{ 'is-ready': channel.ready }">{{ state_text }}</small>
      <UButton v-if="!channel.bound" :label="expanded ? t('收起') : t('开始设置')" size="xs" color="neutral" variant="ghost" class="bot-channel-toggle" :aria-expanded="expanded" @click="expanded = !expanded" />
    </h4>
    <div v-if="show_form && guide && (expanded || channel.bound)" class="bot-channel-guide">
      <p class="fine-print">{{ guide.intro }}</p>
      <p v-if="guide.warning" class="bot-channel-warning"><UIcon name="i-lucide-triangle-alert" /><span>{{ guide.warning }}</span></p>
      <ol class="bot-channel-steps">
        <li v-for="(step, index) in guide.steps" :key="index" class="fine-print">{{ step }}</li>
        <li class="fine-print">{{ t('用你自己的账号私聊机器人，发送页面上显示的绑定码。') }}</li>
      </ol>
      <div class="weixin-actions">
        <UButton v-for="link in guide.links" :key="link.url" :to="link.url" target="_blank" rel="noopener noreferrer" :label="link.label" icon="i-lucide-external-link" size="xs" color="neutral" variant="outline" />
      </div>
      <p class="fine-print bot-channel-ai">{{ t('如需帮助，请在本页选择“让平台主理人配置”，然后告诉它你想接入 {value1}。', { value1: channel.label }) }}</p>
    </div>
    <form v-if="show_form && (expanded || channel.bound)" class="bot-channel-form" @submit.prevent="act('configure', '', { values })">
      <p v-if="waiting_bind" class="fine-print weixin-warning">{{ t('绑定码已过期，请重新填写凭据以生成新的绑定码。') }}</p>
      <UInput v-for="field in channel.fields" :key="field.key" v-model="values[field.key]" :type="field.secret ? 'password' : 'text'"
        :placeholder="field.label" :aria-label="field.label" size="sm" autocomplete="off" />
      <div class="weixin-actions">
        <UButton type="submit" :label="t('保存并验证')" size="sm" :loading="busy === 'configure'"
          :disabled="Boolean(busy) || channel.fields.some(field => !field.optional && !String(values[field.key] || '').trim())" />
      </div>
    </form>
    <template v-else-if="waiting_bind">
      <div class="bot-channel-bind">
        <p class="bot-channel-code">{{ channel.bind_code }}</p>
        <UButton icon="i-lucide-copy" size="xs" color="neutral" variant="ghost" :aria-label="t('复制绑定码')" @click="copy_code" />
      </div>
      <p class="fine-print">{{ channel.bind_hint || t('在私聊里给机器人发送这组绑定码，10 分钟内有效。') }}</p>
      <p class="fine-print">{{ t('绑定码 10 分钟内有效，只发这串数字，不要发到群里。发送后这里会自动变成“已绑定”。') }}</p>
    </template>
    <p v-if="channel.last_failure" class="fine-print weixin-warning">{{ t('{value1} 发送失败：{value2}', { value1: new Date(channel.last_failure.at).toLocaleString(), value2: channel.last_failure.message }) }}</p>
    <p v-if="channel.ready" class="fine-print">{{ t('有事等你时会在这里私聊你；直接回复即发回房间，引用某条提醒回复则发回那条提醒的房间。') }}</p>
    <div v-if="channel.bound" class="weixin-actions">
      <UButton v-if="channel.ready" :label="t('发送测试')" icon="i-lucide-send" size="sm" color="neutral" variant="outline" class="pb-action" :loading="busy === 'test'" :disabled="Boolean(busy)" @click="act('test', t('测试通知已发出'))" />
      <UButton :label="t('解除绑定')" size="sm" color="neutral" variant="ghost" :loading="busy === 'unbind'" :disabled="Boolean(busy)" @click="act('unbind', t('已解除绑定'))" />
    </div>
  </div>
</template>

<style scoped>
.bot-channel { display: grid; gap: 8px; }
.bot-channel-title { display: flex; align-items: center; gap: 8px; margin: 4px 0 0; font-size: 13px; font-weight: 600; }
.bot-channel-title small { color: var(--ui-text-dimmed); font-size: 12px; font-weight: 400; }
.bot-channel-title small.is-ready { color: var(--ui-success); }
.bot-channel-toggle { margin-left: auto; }
.bot-channel-form { display: grid; gap: 8px; }
.bot-channel-guide { display: grid; gap: 6px; padding: 8px 10px; border: 1px dashed var(--ui-border); border-radius: 8px; }
.bot-channel-steps { display: grid; gap: 4px; margin: 0; padding-left: 20px; list-style: decimal; }
.bot-channel-steps li::marker { color: var(--ui-text-dimmed); font-size: 12px; }
.bot-channel-warning { display: flex; align-items: flex-start; gap: 6px; margin: 0; padding: 6px 8px; border-radius: 6px;
  background: color-mix(in srgb, var(--ui-warning) 12%, transparent); color: var(--ui-warning); font-size: 12px; line-height: 1.5; }
.bot-channel-warning > :first-child { flex-shrink: 0; margin-top: 2px; }
.bot-channel-ai { color: var(--ui-text-dimmed); }
.bot-channel-bind { display: flex; align-items: center; gap: 6px; }
.bot-channel-code { margin: 0; font-family: var(--font-mono, monospace); font-size: 20px; letter-spacing: 2px; }
.weixin-warning { color: var(--ui-warning); }
.weixin-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.fine-print { margin: 0; }
</style>

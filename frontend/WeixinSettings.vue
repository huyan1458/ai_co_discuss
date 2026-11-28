<script setup>
/**
 * The settings' "Notifications" section, kept by the local service: Weixin (bound by QR code) and the bot channels
 * listed by `launch notify` (`BotChannelSettings`). A goal or question waiting for the owner's
 * input reaches it after three minutes, and a reply there is posted back to that room as the owner. The login token stays
 * on this computer; the page only sees the binding state and the QR content to draw.
 */
import { computed, inject, onBeforeUnmount, onMounted, ref } from "vue";
import { renderSVG } from "uqr";
import { t } from './i18n.js';
import { weixin_failure_text } from './weixin-failure.js';
import BotChannelSettings from './BotChannelSettings.vue';

import ConfirmDialog from "./ConfirmDialog.vue";

const { bridge } = inject("discussion");
const confirm_setup = ref(false);
// Changing this computer's notification setup needs MOSS above read-only (#15623).
const setup_read_only = ref(false);
async function ask_setup() {
  if (!await bridge.ensure_steward_configured()) return;
  setup_read_only.value = bridge.steward_read_only();
  confirm_setup.value = true;
}
const status = ref(null), unavailable = ref(""), busy = ref(""), open = ref(false);
// The QR code being scanned, drawn here from the content the service returned.
const qr = ref("");
let polling = false;

// Every channel in the owner's order, as `launch notify` lists them; an older local service lists none.
const channels = ref([]);
const bots = computed(() => channels.value.filter(item => item.id !== "weixin"));
const summary = computed(() => {
  if (unavailable.value) return t('需连接本机服务');
  if (!status.value) return t('读取中…');
  const primary = channels.value.find(item => item.primary);
  const ready = channels.value.filter(item => item.enabled && item.ready).length;
  if (!primary) return status.value.context_ready ? t('微信 · 已绑定') : t('未连接渠道');
  return ready ? t('主要：{value1} · {value2} 个可用', { value1: primary.label, value2: ready }) : t('未连接渠道');
});

async function run(action) {
  return bridge.local_request("weixin", { action });
}

onMounted(async () => {
  try { status.value = await run("status"); }
  catch (error) { unavailable.value = error.message; return; }
  try { channels.value = (await bridge.local_request("notify", {})).channels; }
  catch { channels.value = []; }
});

function update_bot(next) {
  channels.value = channels.value.map(item => item.id === next.id ? next : item);
}

/** Show the new order and choice at once, save it, and put the previous one back if saving fails. */
async function arrange(next) {
  const previous = channels.value;
  const enabled = next.filter(item => item.enabled);
  channels.value = next.map(item => ({ ...item, primary: item === enabled[0] }));
  try {
    const result = await bridge.local_request("notify", { action: "arrange", order: next.map(item => item.id), enabled: enabled.map(item => item.id) });
    channels.value = result.channels;
  } catch (error) {
    channels.value = previous;
    bridge.notify("error", error.message);
  }
}

function move(index, step) {
  const next = [...channels.value];
  [next[index], next[index + step]] = [next[index + step], next[index]];
  arrange(next);
}

function toggle(index, enabled) {
  arrange(channels.value.map((item, position) => position === index ? { ...item, enabled } : item));
}
onBeforeUnmount(() => { polling = false; });

/** Show a QR code and wait for the scan, a bounded poll at a time, until it is confirmed, expires or the panel closes. */
async function bind() {
  busy.value = "bind";
  try {
    const login = await run("login");
    qr.value = renderSVG(login.qr_content, { border: 1 });
    polling = true;
    while (polling) {
      const result = await run("complete");
      if (result.status === "connected") { status.value = result; bridge.notify("info", t('微信已绑定；请在微信里给机器人发一条消息，之后就能收到通知')); break; }
      if (result.status !== "waiting") { bridge.notify("warning", result.status === "expired" ? t('二维码已过期，请重新绑定') : t('微信未完成绑定（{value1}）', { value1: result.status })); break; }
    }
  } catch (error) { bridge.notify("error", error.message); }
  finally { polling = false; qr.value = ""; busy.value = ""; }
}

async function act(action, message) {
  busy.value = action;
  try { status.value = await run(action); if (message) bridge.notify("info", message); }
  catch (error) { bridge.notify("error", error.message); }
  finally { busy.value = ""; }
}
</script>

<template>
  <section class="channel-reading-setting">
    <UCollapsible v-model:open="open">
      <button type="button" class="weixin-header" :aria-expanded="open">
        <h3>{{ t('通知') }}</h3><small>{{ t('有事等你处理时提醒你') }}</small><span :class="{ 'is-ready': channels.some(item => item.enabled && item.ready) || (!channels.length && status?.context_ready) }">{{ summary }}</span><UIcon :name="open ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" />
      </button>
      <template #content>
        <div class="weixin-settings">
          <UButton class="justify-self-start" size="xs" color="neutral" variant="soft" :label="t('让 MOSS 配置')" @click="ask_setup" />
          <p class="fine-print">{{ t('Goal 待你确认、或成员向你提的问题等你 3 分钟未答时提醒你：先用主要渠道发送，发不出去再按顺序换下一个已启用的渠道。你在任一已绑定的渠道回复都能发回房间。') }}</p>
          <ol v-if="channels.length" class="notify-order" :aria-label="t('通知渠道顺序')">
            <li v-for="(item, index) in channels" :key="item.id">
              <UCheckbox :model-value="item.enabled" :aria-label="t('启用 {value1}', { value1: item.label })" @update:model-value="toggle(index, $event)" />
              <span class="notify-order-name">{{ item.label }}</span>
              <UBadge v-if="item.primary" :label="t('主要')" size="sm" variant="subtle" />
              <small :class="{ 'is-ready': item.ready }">{{ item.ready ? t('可发送') : item.bound ? t('未就绪') : t('未配置') }}</small>
              <UButton icon="i-lucide-arrow-up" size="xs" color="neutral" variant="ghost" :disabled="index === 0" :aria-label="t('上移')" @click="move(index, -1)" />
              <UButton icon="i-lucide-arrow-down" size="xs" color="neutral" variant="ghost" :disabled="index === channels.length - 1" :aria-label="t('下移')" @click="move(index, 1)" />
            </li>
          </ol>
          <h4 class="weixin-channel">{{ t('微信') }}</h4>
          <p v-if="unavailable" class="fine-print">{{ t('微信通知由这台电脑的本机服务收发，需要连接本机服务或已配对电脑：{value1}', { value1: unavailable }) }}</p>
          <template v-else-if="status">
            <p class="fine-print">{{ t('用个人微信扫码绑定。直接回复通知即作为你的发言发回该房间，引用某条通知回复则发回那条通知的房间；回复问题通知的选项编号即直接作答，其他文字交给主持人代为选择。只转发文字，登录凭据只存这台电脑。') }}</p>
            <template v-if="qr">
              <!-- eslint-disable-next-line vue/no-v-html -- an SVG this page rendered from the service's QR content -->
              <div class="weixin-qr" :aria-label="t('微信绑定二维码')" v-html="qr" />
              <p class="fine-print">{{ t('用微信扫码并在手机上确认。') }}</p>
            </template>
            <p v-else-if="status.bound && !status.context_ready" class="fine-print weixin-warning">{{ t('请先在微信里给机器人发一条任意消息：微信要求先收到你的消息，才能给你发通知。') }}</p>
            <p v-if="status.last_failure" class="fine-print weixin-warning">{{ status.last_failure.at ? t('{value1} 发送失败：{value2}', { value1: new Date(status.last_failure.at).toLocaleString(), value2: weixin_failure_text(status.last_failure) }) : t('上次失败：{value1}', { value1: weixin_failure_text(status.last_failure) }) }}</p>
            <div class="weixin-actions">
              <UButton v-if="!status.bound" :label="t('扫码绑定')" icon="i-lucide-qr-code" size="sm" :loading="busy === 'bind'" :disabled="Boolean(busy)" @click="bind" />
              <template v-else>
                <UButton :label="t('发送测试')" icon="i-lucide-send" size="sm" color="neutral" variant="outline" class="pb-action" :loading="busy === 'test'" :disabled="Boolean(busy)" @click="act('test', t('测试通知已发出'))" />
                <UButton :label="t('刷新状态')" icon="i-lucide-refresh-cw" size="sm" color="neutral" variant="ghost" :loading="busy === 'status'" :disabled="Boolean(busy)" @click="act('status')" />
                <UButton :label="t('解除绑定')" size="sm" color="neutral" variant="ghost" :loading="busy === 'unbind'" :disabled="Boolean(busy)" @click="act('unbind', t('已解除微信绑定'))" />
              </template>
            </div>
          </template>
          <BotChannelSettings v-for="bot in bots" :key="bot.id" :channel="bot" :bridge="bridge" @update="update_bot" />
        </div>
      </template>
    </UCollapsible>
    <ConfirmDialog v-model:open="confirm_setup" :title="t('配置通知渠道')"
      :description="setup_read_only ? t('MOSS 将引导你配置通知，并可能更改本机的通知设置。MOSS 现在是只读，确认后会先把它的项目权限调到“自动”，再发送。') : t('MOSS 将引导你配置通知，并可能更改本机的通知设置。')"
      :confirm-label="setup_read_only ? t('调到自动并发送') : undefined" @confirm="bridge.request_steward('notify-setup', {}, { confirmed: true, raise_access: setup_read_only })" />
  </section>
</template>

<style scoped>
.weixin-header { display: flex; width: 100%; align-items: baseline; gap: 8px; padding: 0; border: 0; background: none; color: inherit; cursor: pointer; text-align: left; }
.weixin-header h3 { flex-shrink: 0; margin: 0; white-space: nowrap; }
.weixin-header small { flex-shrink: 0; color: var(--ui-text-dimmed); font-size: 12px; white-space: nowrap; }
.weixin-header span { min-width: 0; margin-left: auto; overflow: hidden; color: var(--ui-text-dimmed); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.weixin-header span.is-ready { color: var(--ui-success); }
.weixin-header > :last-child { align-self: center; color: var(--ui-text-dimmed); }
@media (max-width: 480px) { .weixin-header small { display: none; } }
.weixin-settings { display: grid; gap: 10px; padding-top: 10px; }
.weixin-settings .fine-print { margin: 0; }
.weixin-warning { color: var(--ui-warning); }
.weixin-channel { margin: 4px 0 0; font-size: 13px; font-weight: 600; }
.weixin-qr { width: 180px; padding: 8px; border-radius: 8px; background: #fff; }
.weixin-qr :deep(svg) { display: block; width: 100%; height: auto; }
.weixin-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.notify-order { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; }
.notify-order li { display: flex; align-items: center; gap: 8px; min-height: 30px; }
.notify-order-name { font-size: 13px; }
.notify-order small { margin-left: auto; color: var(--ui-text-dimmed); font-size: 12px; }
.notify-order small.is-ready { color: var(--ui-success); }
</style>

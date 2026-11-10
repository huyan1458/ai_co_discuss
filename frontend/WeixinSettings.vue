<script setup>
/**
 * Weixin notifications kept by the local service: bind the owner's Weixin by QR code; a goal waiting for the owner's
 * input reaches it after five minutes, and a reply there is posted back to that room as the owner. The login token stays
 * on this computer; the page only sees the binding state and the QR content to draw.
 */
import { computed, inject, onBeforeUnmount, onMounted, ref } from "vue";
import { renderSVG } from "uqr";

const { bridge } = inject("discussion");
const status = ref(null), unavailable = ref(""), busy = ref(""), open = ref(false);
// The QR code being scanned, drawn here from the content the service returned.
const qr = ref("");
let polling = false;

const summary = computed(() => unavailable.value ? "需连接本机服务" : !status.value ? "读取中…"
  : !status.value.bound ? "未绑定" : status.value.context_ready ? "已绑定" : "已绑定 · 待你发一条消息");

async function run(action) {
  return bridge.local_request("weixin", { action });
}

onMounted(async () => {
  try { status.value = await run("status"); }
  catch (error) { unavailable.value = error.message; }
});
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
      if (result.status === "connected") { status.value = result; bridge.notify("info", "微信已绑定；请在微信里给机器人发一条消息，之后就能收到通知"); break; }
      if (result.status !== "waiting") { bridge.notify("warning", result.status === "expired" ? "二维码已过期，请重新绑定" : `微信未完成绑定（${result.status}）`); break; }
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
        <h3>微信通知</h3><small>Goal 等你确认时</small><span :class="{ 'is-ready': status?.context_ready }">{{ summary }}</span><UIcon :name="open ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" />
      </button>
      <template #content>
        <div class="weixin-settings">
          <p v-if="unavailable" class="fine-print">微信通知由这台电脑的本机服务收发，需要连接本机服务或已配对电脑：{{ unavailable }}</p>
          <template v-else-if="status">
            <p class="fine-print">主持人声明 Goal 待你确认后，5 分钟内你没在房间回复，就发到微信；直接回复微信消息即作为你的发言发回该房间，引用某条通知回复则发回那条通知的房间。只转发文字，登录凭据只存这台电脑。</p>
            <template v-if="qr">
              <!-- eslint-disable-next-line vue/no-v-html -- an SVG this page rendered from the service's QR content -->
              <div class="weixin-qr" aria-label="微信绑定二维码" v-html="qr" />
              <p class="fine-print">用微信扫码并在手机上确认。</p>
            </template>
            <p v-else-if="status.bound && !status.context_ready" class="fine-print weixin-warning">请先在微信里给机器人发一条任意消息：微信要求先收到你的消息，才能给你发通知。</p>
            <p v-if="status.last_error" class="fine-print weixin-warning">上次失败：{{ status.last_error }}</p>
            <div class="weixin-actions">
              <UButton v-if="!status.bound" label="扫码绑定" icon="i-lucide-qr-code" size="sm" :loading="busy === 'bind'" :disabled="Boolean(busy)" @click="bind" />
              <template v-else>
                <UButton label="发送测试" icon="i-lucide-send" size="sm" color="neutral" variant="outline" :loading="busy === 'test'" :disabled="Boolean(busy)" @click="act('test', '测试通知已发出')" />
                <UButton label="刷新状态" icon="i-lucide-refresh-cw" size="sm" color="neutral" variant="ghost" :loading="busy === 'status'" :disabled="Boolean(busy)" @click="act('status')" />
                <UButton label="解除绑定" size="sm" color="neutral" variant="ghost" :loading="busy === 'unbind'" :disabled="Boolean(busy)" @click="act('unbind', '已解除微信绑定')" />
              </template>
            </div>
          </template>
        </div>
      </template>
    </UCollapsible>
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
.weixin-qr { width: 180px; padding: 8px; border-radius: 8px; background: #fff; }
.weixin-qr :deep(svg) { display: block; width: 100%; height: auto; }
.weixin-actions { display: flex; flex-wrap: wrap; gap: 8px; }
</style>

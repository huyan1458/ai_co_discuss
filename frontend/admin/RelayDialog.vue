<script setup>
/**
 * Prepare the online relay for the hosted accounts' entry: bind this computer to an online site (as `codiscuss local
 * connect`, with a one-time token made where the site was deployed), and give the address of the relay's entry Worker.
 * With both, the entry can switch to the relay: people open the Worker's address and reach this computer without a
 * domain of the owner's.
 */
import { computed, inject, ref, watch } from "vue";
import { call } from "./api.js";

const props = defineProps({ open: { type: Boolean, required: true } });
const emit = defineEmits(["update:open", "ready"]);
const { state, reload, notify } = inject("panel");
const relay = computed(() => state.value.entry?.relay || {});
const site = ref(""), token = ref(""), url = ref(""), busy = ref("");

watch(() => props.open, (open) => { if (open) { site.value = ""; token.value = ""; url.value = relay.value.url || ""; } });

async function bind() {
  busy.value = "bind";
  try { await call("site/connect", { site: site.value.trim(), setup_key: token.value.trim() }); notify("info", "已绑定线上站点"); await reload(); }
  catch (failure) { notify("error", failure.message); }
  finally { busy.value = ""; }
}

async function save_url() {
  busy.value = "url";
  try { await call("entry/relay", { url: url.value.trim() }); notify("info", "入口地址已保存"); await reload(); }
  catch (failure) { notify("error", failure.message); }
  finally { busy.value = ""; }
}

const ready = computed(() => Boolean(relay.value.site && relay.value.url));
function close() { emit("update:open", false); }
</script>

<template>
  <UModal :open="open" title="线上中转" description="托管账号的使用者经共议线上站点访问这台电脑，不需要自有域名" @update:open="(value) => !value && close()">
    <template #body>
      <div class="relay-steps">
        <section class="relay-step">
          <strong><UIcon :name="relay.site ? 'i-lucide-circle-check' : 'i-lucide-circle'" :class="{ 'is-done': relay.site }" />1. 绑定线上站点</strong>
          <p v-if="relay.site" class="relay-done">已绑定 {{ relay.site }}</p>
          <template v-else>
            <label class="panel-field">站点地址<input v-model="site" class="panel-input" placeholder="https://xxx.pages.dev" autocomplete="off" spellcheck="false" /></label>
            <label class="panel-field">一次性绑定令牌<input v-model="token" class="panel-input" autocomplete="off" spellcheck="false" />
              <small>在部署线上站点的电脑上运行 codiscuss token 获得，只能用一次。绑定后你自己的设备也能经这个站点远程管理这台电脑（设备要先在本机网页配对）。</small></label>
            <div class="relay-actions"><button type="button" class="panel-button is-primary is-small" :disabled="!site.trim() || !token.trim() || Boolean(busy)" @click="bind">
              <UIcon v-if="busy === 'bind'" name="i-lucide-loader" class="animate-spin" />绑定</button></div>
          </template>
        </section>

        <section class="relay-step">
          <strong><UIcon :name="relay.url ? 'i-lucide-circle-check' : 'i-lucide-circle'" :class="{ 'is-done': relay.url }" />2. 入口地址</strong>
          <label class="panel-field"><input v-model="url" class="panel-input" placeholder="https://codiscuss-entry.xxx.workers.dev" autocomplete="off" spellcheck="false" />
            <small>部署线上站点时一起部署的入口 Worker 地址。它和线上站点是两个不同的地址，托管账号的网页不会碰到你的设备密钥。</small></label>
          <div class="relay-actions"><button type="button" class="panel-button is-outline is-small" :disabled="!url.trim() || url.trim() === relay.url || Boolean(busy)" @click="save_url">
            <UIcon v-if="busy === 'url'" name="i-lucide-loader" class="animate-spin" />保存</button></div>
        </section>

        <p class="panel-note"><UIcon name="i-lucide-info" />线上中转和自有域名隧道一样，Cloudflare 能看到托管账号的往来内容；登录、会话与入口保护仍由这台电脑负责。每个页面的请求都经过 Cloudflare Workers，免费额度适合少量使用者，人多时改用自有域名。</p>
      </div>
      <div class="panel-form-foot">
        <button type="button" class="panel-button is-plain" @click="close">关闭</button>
        <button type="button" class="panel-button is-primary" :disabled="!ready" @click="emit('ready'); close()">切换到线上中转</button>
      </div>
    </template>
  </UModal>
</template>

<style scoped>
.relay-steps { display: flex; flex-direction: column; gap: 18px; }
.relay-step { display: flex; flex-direction: column; gap: 10px; }
.relay-step > strong { display: flex; align-items: center; gap: 8px; font-size: 14px; }
.relay-step > strong > [class*="icon"] { width: 16px; height: 16px; color: var(--panel-faint); }
.relay-step > strong > .is-done { color: var(--panel-green); }
.relay-done { margin: 0 0 0 24px; color: var(--panel-muted); font-size: 13px; }
.relay-actions { display: flex; justify-content: flex-end; }
</style>

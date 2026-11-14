<script setup>
/**
 * The online relay for the hosted accounts' entry, in one step on each side. On a hosting computer: paste the access code
 * and join (binding to the online site, taking the entry address it gives, switching to the relay; each step shown). On
 * the computer that deployed the online site: make the access code (a one-time binding token with the site's address,
 * written through wrangler with the site's deployment config). Deploying the online site itself stays with whoever runs
 * it; nothing here deploys anything.
 */
import { computed, inject, ref, watch } from "vue";
import { call } from "./api.js";

const props = defineProps({ open: { type: Boolean, required: true } });
const emit = defineEmits(["update:open"]);
const { state, reload, notify } = inject("panel");
const relay = computed(() => state.value.entry?.relay || {});
const code = ref(""), joined = ref(null), busy = ref("");
const maker = ref({ open: false, config: "", site: "", made: "" });

watch(() => props.open, async (open) => {
  if (!open) return;
  code.value = ""; joined.value = null;
  const saved = await call("site/code").catch(() => ({}));
  maker.value = { open: false, config: saved.config || "", site: saved.site || "", made: "" };
});

async function join() {
  busy.value = "join";
  try { joined.value = await call("relay/join", { code: code.value.trim() }); notify("info", "已切换到线上中转"); await reload(); }
  catch (failure) { notify("error", failure.message); }
  finally { busy.value = ""; }
}

async function make() {
  busy.value = "make";
  try { maker.value.made = (await call("site/code", { config: maker.value.config.trim(), site: maker.value.site.trim() })).code; }
  catch (failure) { notify("error", failure.message); }
  finally { busy.value = ""; }
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); notify("info", "已复制"); } catch { notify("error", "复制失败，请手动选中复制"); }
}
function close() { emit("update:open", false); }
</script>

<template>
  <UModal :open="open" title="线上中转" description="托管账号的使用者经共议线上站点访问这台电脑，不需要自有域名" @update:open="(value) => !value && close()">
    <template #body>
      <div class="relay">
        <p v-if="relay.site" class="relay-current">已接入 {{ relay.site }}<template v-if="relay.url"> · 入口 {{ relay.url }}</template>。换站点时粘贴新的接入码。</p>

        <form v-if="!joined" class="relay-join" @submit.prevent="code.trim() && join()">
          <label class="panel-field">接入码
            <textarea v-model="code" class="panel-input relay-code" placeholder="https://xxx.pages.dev/#codiscuss-bind=…" spellcheck="false" />
            <small>向为你提供线上站点的人要（自己部署了线上站点的，在下面生成）。只能用一次。</small></label>
          <div class="relay-actions"><button type="submit" class="panel-button is-primary is-small" :disabled="!code.trim() || Boolean(busy)">
            <UIcon v-if="busy === 'join'" name="i-lucide-loader" class="animate-spin" />接入并切换</button></div>
        </form>
        <ul v-else class="relay-steps">
          <li v-for="line in joined.steps" :key="line"><UIcon name="i-lucide-circle-check" />{{ line }}</li>
        </ul>

        <section class="relay-maker">
          <button type="button" class="relay-toggle" @click="maker.open = !maker.open">
            <strong>生成接入码</strong><small>在部署线上站点的电脑上用</small>
            <UIcon :name="maker.open ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" /></button>
          <template v-if="maker.open">
            <label class="panel-field">部署配置<input v-model="maker.config" class="panel-input" placeholder="D:\…\ai_co_discuss\.wrangler\deploy\wrangler.jsonc" spellcheck="false" />
              <small>源码仓库里线上站点的私有部署配置；这台电脑须已登录 wrangler。</small></label>
            <label class="panel-field">站点地址<input v-model="maker.site" class="panel-input" placeholder="https://xxx.pages.dev" spellcheck="false" /></label>
            <div class="relay-actions"><button type="button" class="panel-button is-outline is-small" :disabled="!maker.config.trim() || !maker.site.trim() || Boolean(busy)" @click="make">
              <UIcon v-if="busy === 'make'" name="i-lucide-loader" class="animate-spin" />生成</button></div>
            <div v-if="maker.made" class="panel-secret relay-made"><span>{{ maker.made }}</span>
              <button type="button" class="panel-icon-button" aria-label="复制接入码" @click="copy(maker.made)"><UIcon name="i-lucide-copy" /></button></div>
            <small v-if="maker.made" class="relay-hint">发给托管电脑的操作者，粘贴到它的这个窗口里。只能用一次；再生成一个会让之前没用过的作废。</small>
          </template>
        </section>

        <p class="panel-note"><UIcon name="i-lucide-info" />线上中转和自有域名隧道一样，Cloudflare 能看到托管账号的往来内容；登录、会话与入口保护仍由这台电脑负责。每个页面的请求都经过 Cloudflare Workers，免费额度适合少量使用者，人多时改用自有域名。</p>
      </div>
      <div class="panel-form-foot"><button type="button" class="panel-button is-primary" @click="close">{{ joined ? "完成" : "关闭" }}</button></div>
    </template>
  </UModal>
</template>

<style scoped>
.relay { display: flex; flex-direction: column; gap: 16px; }
.relay-current { margin: 0; padding: 10px 12px; border-radius: 10px; background: var(--panel-green-soft); color: var(--panel-green); font-size: 13px; }
.relay-join { display: flex; flex-direction: column; gap: 10px; }
.relay-code { height: 64px; padding: 10px 14px; resize: none; font-family: ui-monospace, Consolas, monospace; font-size: 12px; word-break: break-all; }
.relay-actions { display: flex; justify-content: flex-end; }
.relay-steps { display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 0; list-style: none; font-size: 14px; }
.relay-steps li { display: flex; align-items: center; gap: 8px; overflow-wrap: anywhere; }
.relay-steps li > [class*="icon"] { width: 16px; height: 16px; flex-shrink: 0; color: var(--panel-green); }
.relay-maker { display: flex; flex-direction: column; gap: 10px; padding-top: 12px; border-top: 1px solid var(--panel-line); }
.relay-toggle { display: flex; align-items: baseline; gap: 8px; width: 100%; text-align: left; }
.relay-toggle strong { font-size: 14px; }
.relay-toggle small { flex: 1; color: var(--panel-faint); font-size: 12px; }
.relay-toggle > [class*="icon"] { width: 16px; height: 16px; align-self: center; color: var(--panel-faint); }
.relay-made { font-size: 12px; letter-spacing: 0; }
.relay-made span { overflow-wrap: anywhere; }
.relay-hint { color: var(--panel-faint); font-size: 12px; }
</style>

<script setup>
/**
 * API keys held by each hosted account's instance.
 *
 * Keys added here are marked as provided by the computer owner: the account's API cards use them without showing them,
 * and the account cannot replace them from a card. Keys the account entered itself are listed too.
 */
import { computed, inject, onMounted, ref, watch } from "vue";
import { call, provider_icon, provider_of } from "./api.js";

const adding = defineModel("adding", { type: Boolean, default: false });
const { state, reload, notify } = inject("panel");
const keys = ref({});
const presets = computed(() => Object.entries(state.value.providers || {}).filter(([key]) => key !== "OpenAI").map(([key, provider]) => ({ key, ...provider })));
const form = ref({ account: "", preset: "Codex", base_url: "", api_key: "", saving: false });
const removing = ref(null);

async function load(account) {
  try { keys.value = { ...keys.value, [account.name]: await call(`accounts/${account.name}/keys`) }; }
  catch (failure) { notify("error", failure.message); }
}
async function load_all() { await Promise.all(state.value.accounts.map(load)); }
onMounted(load_all);
watch(() => state.value.accounts.map((account) => account.name).join(), load_all);

function start_adding(account = "") {
  const first = presets.value[0];
  form.value = { account: account || state.value.accounts[0]?.name || "", preset: first?.key || "Custom", base_url: first?.base_url || "", api_key: "", saving: false };
  adding.value = true;
}
watch(adding, (open) => { if (open && !form.value.account) start_adding(); });
function choose_preset(preset) { form.value.preset = preset.key; form.value.base_url = preset.base_url || ""; }

async function save() {
  form.value.saving = true;
  try {
    await call(`accounts/${form.value.account}/keys`, { base_url: form.value.base_url.trim(), api_key: form.value.api_key });
    notify("info", "API 密钥已保存");
    const account = state.value.accounts.find((item) => item.name === form.value.account);
    adding.value = false;
    form.value.account = "";
    if (account) await load(account);
    reload();
  } catch (failure) { notify("error", failure.message); }
  finally { form.value.saving = false; }
}

async function remove() {
  const { account, key } = removing.value;
  removing.value = null;
  try { await call(`accounts/${account.name}/keys/remove`, { ref: key.ref }); notify("info", "已删除"); await load(account); reload(); }
  catch (failure) { notify("error", failure.message); }
}
const account_items = computed(() => state.value.accounts.map((account) => ({ label: account.name, value: account.name })));
</script>

<template>
  <section v-if="adding">
    <div class="panel-form-head">
      <button type="button" class="panel-back" aria-label="返回" @click="adding = false; form.account = ''"><UIcon name="i-lucide-arrow-left" /></button>
      <h2>添加 API 密钥</h2>
    </div>
    <form class="panel-form" @submit.prevent="save">
      <div class="panel-field">预设供应商
        <div class="panel-chips">
          <button v-for="preset in presets" :key="preset.key" type="button" class="panel-chip" :class="{ 'is-active': form.preset === preset.key }" @click="choose_preset(preset)">
            <img v-if="provider_icon(preset.key)" :src="provider_icon(preset.key)" alt="" />{{ preset.key === 'Custom' ? '自定义地址' : preset.label }}</button>
        </div>
        <small>选预设只需填写密钥，地址已填好。</small>
      </div>
      <div class="panel-form-row">
        <label class="panel-field">给哪个用户
          <USelect v-model="form.account" :items="account_items" size="xl" class="w-full" />
        </label>
        <label class="panel-field">Base URL
          <input v-model="form.base_url" class="panel-input" placeholder="https://…" spellcheck="false" />
        </label>
      </div>
      <label class="panel-field">API Key
        <input v-model="form.api_key" class="panel-input" type="password" placeholder="粘贴密钥" autocomplete="off" spellcheck="false" />
        <small>保存在该用户的实例目录里。它的 API 专家卡片会自动用上这个密钥，只显示“管理员已提供”，看不到也不能更换。</small>
      </label>
    </form>
    <div class="panel-form-foot">
      <button type="button" class="panel-button is-plain" @click="adding = false; form.account = ''">取消</button>
      <button type="button" class="panel-button is-primary" :disabled="!form.account || !form.base_url.trim() || !form.api_key.trim() || form.saving" @click="save"><UIcon name="i-lucide-plus" />添加</button>
    </div>
  </section>

  <section v-else>
    <div v-if="!state.accounts.length" class="panel-empty"><UIcon name="i-lucide-key-round" />先在“用户”页新建用户，再为它配置 API 密钥。</div>
    <template v-for="account in state.accounts" :key="account.name">
      <h3 class="panel-section-title"><UIcon name="i-lucide-user" />{{ account.name }}
        <button type="button" class="panel-icon-button" style="width: 28px; height: 28px" :aria-label="`为 ${account.name} 添加密钥`" title="添加密钥" @click="start_adding(account.name)"><UIcon name="i-lucide-plus" /></button></h3>
      <div class="panel-list">
        <p v-if="!keys[account.name]?.length" class="panel-note"><UIcon name="i-lucide-info" />还没有密钥。</p>
        <article v-for="key in keys[account.name] || []" :key="key.ref" class="panel-card">
          <div class="panel-tile"><img v-if="provider_icon(provider_of(state.providers, key.base_url).key)" :src="provider_icon(provider_of(state.providers, key.base_url).key)" alt="" /><UIcon v-else name="i-lucide-key-round" /></div>
          <div class="panel-main">
            <div class="panel-title">{{ provider_of(state.providers, key.base_url).label }}
              <span v-if="key.managed" class="panel-tag is-blue"><UIcon name="i-lucide-shield-check" />管理员提供</span>
              <span v-else class="panel-tag is-gray">用户自填</span>
            </div>
            <span class="panel-link">{{ key.base_url }}</span>
            <span class="panel-sub">密钥尾号 ••••{{ key.tail }}</span>
          </div>
          <div class="panel-side">
            <button type="button" class="panel-icon-button" title="删除" aria-label="删除密钥" @click="removing = { account, key }"><UIcon name="i-lucide-trash-2" /></button>
          </div>
        </article>
      </div>
    </template>
  </section>

  <UModal :open="Boolean(removing)" title="删除 API 密钥" @update:open="(open) => !open && (removing = null)">
    <template #body>
      <p style="margin: 0; color: #4b5563; font-size: 14px; line-height: 1.7">删除后，{{ removing?.account.name }} 用这个密钥的 API 专家会无法调用，需要重新配置。</p>
      <div class="panel-form-foot">
        <button type="button" class="panel-button is-plain" @click="removing = null">取消</button>
        <button type="button" class="panel-button is-primary" style="background: #dc2626" @click="remove">删除</button>
      </div>
    </template>
  </UModal>
</template>

<script setup>
/**
 * API keys of one account. For a hosted account's instance, keys added here are marked as provided by the computer owner:
 * the account's API cards use them without showing them and cannot replace them; keys the account entered itself are
 * listed too. `account` is "" for the owner, whose own keys these are.
 */
import { computed, inject, onMounted, ref, watch } from "vue";
import { call, provider_icon, provider_of } from "./api.js";

const props = defineProps({ account: { type: String, required: true } });
const emit = defineEmits(["changed"]);
const { state, notify, refreshed } = inject("panel");
const keys = ref([]), adding = ref(false), saving = ref(false), removing = ref(null);
const presets = computed(() => Object.entries(state.value.providers || {}).filter(([key]) => key !== "OpenAI").map(([key, provider]) => ({ key, ...provider })));
const form = ref({ preset: "", base_url: "", api_key: "" });
const base = computed(() => (props.account ? `accounts/${props.account}/keys` : "owner/keys"));

async function load() {
  try { keys.value = await call(base.value); }
  catch (failure) { notify("error", failure.message); }
}
onMounted(load);
watch(refreshed, load);
watch(() => props.account, load);

function start() {
  const first = presets.value[0];
  form.value = { preset: first?.key || "Custom", base_url: first?.base_url || "", api_key: "" };
  adding.value = true;
}
function choose(preset) { form.value.preset = preset.key; form.value.base_url = preset.base_url || ""; }

async function save() {
  saving.value = true;
  try {
    await call(base.value, { base_url: form.value.base_url.trim(), api_key: form.value.api_key });
    notify("info", "API 密钥已保存");
    adding.value = false;
    await load(); emit("changed");
  } catch (failure) { notify("error", failure.message); }
  finally { saving.value = false; }
}

async function remove() {
  const key = removing.value;
  removing.value = null;
  try { await call(`${base.value}/remove`, { ref: key.ref }); notify("info", "已删除"); await load(); emit("changed"); }
  catch (failure) { notify("error", failure.message); }
}
</script>

<template>
  <div class="keys">
    <div class="keys-head">
      <span>API 密钥 <small>给{{ account ? "它" : "你" }}的 API 专家（DeepSeek、Kimi 等）用</small></span>
      <button v-if="!adding" type="button" class="panel-button is-outline is-small" @click="start"><UIcon name="i-lucide-plus" />添加密钥</button>
    </div>
    <form v-if="adding" class="keys-form" @submit.prevent="save">
      <div class="panel-chips">
        <button v-for="preset in presets" :key="preset.key" type="button" class="panel-chip" :class="{ 'is-active': form.preset === preset.key }" @click="choose(preset)">
          <img v-if="provider_icon(preset.key)" :src="provider_icon(preset.key)" alt="" />{{ preset.key === 'Custom' ? '自定义地址' : preset.label }}</button>
      </div>
      <label class="panel-field">接口地址<input v-model="form.base_url" class="panel-input" placeholder="https://…" spellcheck="false" /></label>
      <label class="panel-field">密钥<input v-model="form.api_key" class="panel-input" type="password" placeholder="粘贴密钥" autocomplete="off" spellcheck="false" />
        <small v-if="account">对方的 API 专家会自动用上，只显示“管理员已提供”，看不到也不能更换。</small></label>
      <div class="panel-form-foot" style="margin-top: 4px">
        <button type="button" class="panel-button is-plain" @click="adding = false">取消</button>
        <button type="submit" class="panel-button is-primary" :disabled="!form.base_url.trim() || !form.api_key.trim() || saving">保存</button>
      </div>
    </form>
    <p v-else-if="!keys.length" class="keys-empty">还没有密钥。不用 API 专家可以不配。</p>
    <div v-for="key in keys" :key="key.ref" class="keys-row">
      <img v-if="provider_icon(provider_of(state.providers, key.base_url).key)" :src="provider_icon(provider_of(state.providers, key.base_url).key)" alt="" />
      <UIcon v-else name="i-lucide-key-round" class="keys-icon" />
      <div class="keys-text">
        <strong>{{ provider_of(state.providers, key.base_url).label }}<span v-if="account" class="panel-tag" :class="key.managed ? 'is-blue' : 'is-gray'">{{ key.managed ? "管理员提供" : "对方自填" }}</span></strong>
        <small>{{ key.base_url }} · 尾号 ••••{{ key.tail }}</small>
      </div>
      <button type="button" class="panel-icon-button" title="删除" aria-label="删除密钥" @click="removing = key"><UIcon name="i-lucide-trash-2" /></button>
    </div>
  </div>

  <UModal :open="Boolean(removing)" title="删除 API 密钥" @update:open="(open) => !open && (removing = null)">
    <template #body>
      <p style="margin: 0; color: #4b5563; font-size: 14px; line-height: 1.7">删除后，{{ account || "你" }}用这个密钥的 API 专家会无法调用。</p>
      <div class="panel-form-foot">
        <button type="button" class="panel-button is-plain" @click="removing = null">取消</button>
        <button type="button" class="panel-button is-primary" style="background: #dc2626" @click="remove">删除</button>
      </div>
    </template>
  </UModal>
</template>

<style scoped>
.keys { display: flex; flex-direction: column; gap: 4px; }
.keys-head { display: flex; align-items: center; justify-content: space-between; color: var(--panel-muted); font-size: 13px; font-weight: 500; }
.keys-head small { margin-left: 6px; color: var(--panel-faint); font-weight: 400; }
.keys-form { display: flex; flex-direction: column; gap: 14px; padding: 14px 0 4px; border-top: 1px solid var(--panel-line); }
.keys-empty { margin: 0; padding: 12px 4px; border-top: 1px solid var(--panel-line); color: var(--panel-faint); font-size: 13px; }
.keys-row { display: flex; align-items: center; gap: 12px; padding: 12px 4px; border-top: 1px solid var(--panel-line); }
.keys-row img, .keys-icon { width: 22px; height: 22px; flex-shrink: 0; }
.keys-text { display: flex; flex: 1; flex-direction: column; gap: 3px; min-width: 0; }
.keys-text strong { display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 600; }
.keys-text small { overflow: hidden; color: var(--panel-faint); font-size: 12px; white-space: nowrap; text-overflow: ellipsis; }
</style>

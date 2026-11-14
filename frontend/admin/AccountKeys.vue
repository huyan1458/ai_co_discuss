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
// A key of a known model API stays with the model APIs even when a speech service uses it too (OpenAI).
const model_api = (key) => !key.speech || provider_of(state.value.providers, key.base_url).key !== "Custom";
const groups = computed(() => [{ title: "模型 API（API 成员调用）", keys: keys.value.filter(model_api) }, { title: "语音服务（朗读与语音输入）", keys: keys.value.filter((key) => !model_api(key)) }]);
/** A key's name: the preset's or speech service's, else the address's host without "api." (e.g. typesafe.ai). */
function name(key) {
  if (key.speech && !model_api(key)) return key.speech.label;
  const preset = provider_of(state.value.providers, key.base_url);
  if (preset.key !== "Custom") return preset.label;
  try { return new URL(key.base_url).hostname.replace(/^api\./, ""); } catch { return key.base_url; }
}

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
      <span>API 密钥 <small>供 API 成员（DeepSeek、Kimi 等）与语音服务调用</small></span>
      <button v-if="!adding" type="button" class="panel-button is-outline is-small" @click="start"><UIcon name="i-lucide-plus" />添加密钥</button>
    </div>
    <form v-if="adding" class="keys-form" @submit.prevent="save">
      <div class="panel-chips">
        <button v-for="preset in presets" :key="preset.key" type="button" class="panel-chip" :class="{ 'is-active': form.preset === preset.key }" @click="choose(preset)">
          <img v-if="provider_icon(preset.key)" :src="provider_icon(preset.key)" alt="" />{{ preset.key === 'Custom' ? '自定义接口' : preset.label }}</button>
      </div>
      <label class="panel-field">接口地址<input v-model="form.base_url" class="panel-input" placeholder="https://…" spellcheck="false" /></label>
      <label class="panel-field">密钥<input v-model="form.api_key" class="panel-input" type="password" placeholder="粘贴密钥" autocomplete="off" spellcheck="false" />
        <small v-if="account">该账号的 API 成员直接使用，界面只显示“管理员提供”，对方无法查看或更换。</small></label>
      <div class="panel-form-foot" style="margin-top: 4px">
        <button type="button" class="panel-button is-plain" @click="adding = false">取消</button>
        <button type="submit" class="panel-button is-primary" :disabled="!form.base_url.trim() || !form.api_key.trim() || saving">保存</button>
      </div>
    </form>
    <p v-else-if="!keys.length" class="keys-empty">暂无密钥。不使用 API 成员或云端语音时无需配置。</p>
    <template v-for="group in groups" :key="group.title">
      <div v-if="group.keys.length" class="keys-group">{{ group.title }}</div>
      <div v-for="key in group.keys" :key="key.ref" class="keys-row">
        <img v-if="provider_icon(provider_of(state.providers, key.base_url).key)" :src="provider_icon(provider_of(state.providers, key.base_url).key)" alt="" />
        <UIcon v-else :name="key.speech ? 'i-lucide-audio-lines' : 'i-lucide-key-round'" class="keys-icon" />
        <div class="keys-text">
          <strong>{{ name(key) }}
            <span v-for="use in key.speech?.uses || []" :key="use" class="panel-tag is-gray">{{ use }}</span>
            <span v-if="key.speech?.local" class="panel-tag is-gray">访问令牌</span>
            <span v-if="account" class="panel-tag" :class="key.managed ? 'is-blue' : 'is-gray'">{{ key.managed ? "管理员提供" : "账号自行填写" }}</span></strong>
          <small>{{ key.base_url }} · 尾号 ••••{{ key.tail }}</small>
        </div>
        <button type="button" class="panel-icon-button" title="删除" aria-label="删除密钥" @click="removing = key"><UIcon name="i-lucide-trash-2" /></button>
      </div>
    </template>
  </div>

  <UModal :open="Boolean(removing)" title="删除 API 密钥" @update:open="(open) => !open && (removing = null)">
    <template #body>
      <p style="margin: 0; color: #4b5563; font-size: 14px; line-height: 1.7">删除后，使用该密钥的{{ removing?.speech ? "语音服务" : " API 成员" }}将无法调用。</p>
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
.keys-group { padding: 12px 4px 4px; border-top: 1px solid var(--panel-line); color: var(--panel-faint); font-size: 12px; }
.keys-group + .keys-row { border-top: 0; }
.keys-row { display: flex; align-items: center; gap: 12px; padding: 12px 4px; border-top: 1px solid var(--panel-line); }
.keys-row img, .keys-icon { width: 22px; height: 22px; flex-shrink: 0; }
.keys-text { display: flex; flex: 1; flex-direction: column; gap: 3px; min-width: 0; }
.keys-text strong { display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 600; }
.keys-text small { overflow: hidden; color: var(--panel-faint); font-size: 12px; white-space: nowrap; text-overflow: ellipsis; }
</style>

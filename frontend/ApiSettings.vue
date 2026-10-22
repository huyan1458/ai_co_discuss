<script setup>
/** API credentials stay in component memory until saved to the local private store. */
import { computed, inject, ref } from "vue";

const props = defineProps({ name: { type: String, required: true } });
const { view, bridge } = inject("discussion");
const profile = computed(() => view.value.launch.profiles[props.name] || {});
const models = computed(() => bridge.launch_model_state(props.name, view.value.launch));
const api_key = ref(""), saving = ref(false), error = ref("");
const protocols = [{ value: "responses", label: "OpenAI Responses" }, { value: "chat", label: "OpenAI Chat Completions" },
  { value: "anthropic", label: "Anthropic Messages" }, { value: "gemini", label: "Gemini generateContent" }];
const write = (field, value) => bridge.write_launch(props.name, field, value);

/** Persist only this explicitly entered key and clear the password input after acknowledgement. */
async function save_key() {
  saving.value = true;
  error.value = "";
  try { await bridge.save_launch_api_key(props.name, api_key.value); api_key.value = ""; }
  catch (failure) { error.value = failure.message; }
  finally { saving.value = false; }
}
</script>

<template>
  <!-- Label-beside-field rows keep the API back within the same card height as every other face. -->
  <div class="api-settings">
    <label class="api-field" title="Base URL"><span>地址</span><UInput :model-value="profile.base_url || ''" :aria-label="`${name} Base URL`" placeholder="Base URL" class="w-full" size="xs" @update:model-value="write('base_url', $event)" /></label>
    <div class="api-field" title="OpenRouter 等兼容服务可选 Chat Completions，并填写该服务的完整模型 ID。"><span>协议</span><USelect :model-value="profile.api_protocol || ''" :items="protocols" :aria-label="`${name} API 请求协议`" class="w-full" size="xs" @update:model-value="write('api_protocol', $event)" /></div>
    <div class="api-field"><span>密钥</span>
      <div class="api-inline"><UInput v-model="api_key" type="password" autocomplete="new-password" :placeholder="profile.api_key_ref ? '已保存，输入可更换' : '填写 API Key'" :aria-label="`${name} API Key`" size="xs" class="w-full" />
        <UButton label="保存" :aria-label="`保存 ${name} 的 API Key`" title="保存密钥" size="xs" color="neutral" variant="outline" :loading="saving" :disabled="!api_key.trim() || !view.launch.available" @click="save_key" /></div>
    </div>
    <div class="api-field"><span>模型</span>
      <div class="api-inline"><UInputMenu mode="autocomplete" ignore-filter :model-value="profile.model || ''" :items="models.items" value-key="value" :aria-label="`${name} API 模型 ID`" placeholder="推荐模型或完整 ID" class="w-full min-w-0" size="xs" :ui="{ content: 'min-w-72' }" @update:model-value="write('model', $event)" />
        <UButton icon="i-lucide-refresh-cw" :aria-label="`读取 ${name} 的模型列表`" title="读取模型列表" size="xs" color="neutral" variant="ghost" :loading="models.loading" :disabled="!profile.api_key_ref" @click="bridge.load_launch_models(name, true)" /></div>
    </div>
    <p v-if="error || models.error" role="alert">{{ error || models.error }}</p>
  </div>
</template>

<style scoped>
.api-settings { display: grid; gap: 7px; min-width: 0; }
.api-field { display: grid; grid-template-columns: 26px minmax(0, 1fr); align-items: center; gap: 8px; color: var(--ui-text-dimmed); font-size: 11px; }
.api-inline { display: flex; gap: 4px; min-width: 0; }
.api-inline > button { flex-shrink: 0; }
.api-settings p { margin: 0; color: var(--ui-text-muted); font-size: 10px; line-height: 1.5; overflow-wrap: anywhere; }
</style>

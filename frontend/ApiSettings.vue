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
  <div class="api-settings">
    <UFormField label="Base URL"><UInput :model-value="profile.base_url || ''" :aria-label="`${name} Base URL`" class="w-full" size="xs" @update:model-value="write('base_url', $event)" /></UFormField>
    <UFormField label="请求协议"><USelect :model-value="profile.api_protocol || ''" :items="protocols" :aria-label="`${name} API 请求协议`" class="w-full" size="xs" @update:model-value="write('api_protocol', $event)" /></UFormField>
    <UFormField label="API Key">
      <div class="api-key-row"><UInput v-model="api_key" type="password" autocomplete="new-password" :placeholder="profile.api_key_ref ? '已保存，输入可更换' : '填写此地址对应的密钥'" :aria-label="`${name} API Key`" size="xs" class="w-full" />
        <UButton label="保存密钥" size="xs" color="neutral" variant="outline" :loading="saving" :disabled="!api_key.trim() || !view.launch.available" @click="save_key" /></div>
    </UFormField>
    <UFormField label="模型 ID">
      <UInput :model-value="profile.model || ''" :list="`api-models-${name}`" :aria-label="`${name} API 模型 ID`" placeholder="选择推荐模型或输入完整 ID" class="w-full" size="xs" @update:model-value="write('model', $event)" />
      <datalist :id="`api-models-${name}`"><option v-for="item in models.items" :key="item.value" :value="item.value">{{ item.label }}</option></datalist>
    </UFormField>
    <div class="api-model-row"><span>仅使用房间上下文</span><button type="button" :disabled="!profile.api_key_ref || models.loading" @click="bridge.load_launch_models(name, true)">{{ models.loading ? '读取中…' : '读取模型列表' }}</button></div>
    <p v-if="error || models.error" role="alert">{{ error || models.error }}</p>
    <p v-else>OpenRouter 等兼容服务可选 Chat Completions，并填写该服务的完整模型 ID。</p>
  </div>
</template>

<style scoped>
.api-settings { display: grid; gap: 7px; min-width: 0; }
.api-key-row { display: flex; gap: 5px; }
.api-key-row > button { flex-shrink: 0; }
.api-settings p, .api-model-row { font-size: 10px; line-height: 1.5; color: var(--ui-text-muted); margin: 0; }
.api-model-row { display: flex; justify-content: space-between; gap: 8px; }
.api-model-row button { color: var(--channel-accent); }
.api-model-row button:disabled { opacity: .5; }
</style>

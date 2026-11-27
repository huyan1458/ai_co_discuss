<script setup>
/** An entered key stays only in this component's memory; the local private store returns just an opaque reference. */
import { computed, inject } from "vue";
import { t } from "./i18n.js";
import SecretKeyInput from "./SecretKeyInput.vue";

const props = defineProps({ name: { type: String, required: true } });
const { view, bridge } = inject("discussion");
const profile = computed(() => view.value.launch.profiles[props.name] || {});
const models = computed(() => bridge.launch_model_state(props.name, view.value.launch));
const protocols = [{ value: "responses", label: "OpenAI Responses" }, { value: "chat", label: "OpenAI Chat Completions" },
  { value: "anthropic", label: "Anthropic Messages" }, { value: "gemini", label: "Gemini generateContent" }];
const write = (field, value) => bridge.write_launch(props.name, field, value);
// A key the computer owner provided to this hosted account is used as is; the account neither sees nor replaces it here.
const provided = computed(() => view.value.launch.projects_restricted && (view.value.launch.managed_api_keys || []).includes(profile.value.api_key_ref));
</script>

<template>
  <!-- Label-beside-field rows keep the API back within the same card height as every other face. -->
  <div class="api-settings">
    <label class="api-field" title="Base URL"><span>{{ t("地址") }}</span><UInput :model-value="profile.base_url || ''" :aria-label="`${name} Base URL`" placeholder="Base URL" class="w-full" size="xs" @update:model-value="write('base_url', $event)" /></label>
    <div class="api-field" :title="t('OpenRouter 等兼容服务可选 Chat Completions，并填写该服务的完整模型 ID。')"><span>{{ t("协议") }}</span><USelect :model-value="profile.api_protocol || ''" :items="protocols" :aria-label="t('{name} API 请求协议', { name })" class="w-full" size="xs" @update:model-value="write('api_protocol', $event)" /></div>
    <div v-if="provided" class="api-field"><span>{{ t("密钥") }}</span><span class="api-provided"><UIcon name="i-lucide-shield-check" />{{ t("管理员已提供") }}</span></div>
    <div v-else class="api-field"><span>{{ t("密钥") }}</span>
      <!-- A key entered for one address does not belong to another. -->
      <SecretKeyInput :key="profile.base_url || ''" :save="(key) => bridge.save_launch_api_key(name, key)" :saved="Boolean(profile.api_key_ref)" :disabled="!view.launch.available" :label="`${name} API Key`" @error="(failure) => bridge.notify('error', failure.message)" />
    </div>
    <div class="api-field"><span>{{ t("模型") }}</span>
      <div class="api-inline"><UInputMenu mode="autocomplete" ignore-filter :model-value="profile.model || ''" :items="models.items" value-key="value" :aria-label="t('{name} API 模型 ID', { name })" :placeholder="t('推荐模型或完整 ID')" class="w-full min-w-0" size="xs" @update:model-value="write('model', $event)" />
        <UButton icon="i-lucide-refresh-cw" :aria-label="t('读取 {name} 的模型列表', { name })" :title="t('读取模型列表')" size="xs" color="neutral" variant="ghost" :loading="models.loading" :disabled="!profile.api_key_ref" @click="bridge.load_launch_models(name, true)" /></div>
    </div>
    <!-- Whether the model reads images is the owner's to say: the same protocol serves models with and without vision. -->
    <label class="api-field" :title="t('打开后，点名它的消息里的图片会随任务直接发给模型；模型不支持看图时请求会出错')"><span>{{ t("看图") }}</span>
      <span class="api-inline"><USwitch :model-value="profile.image_input === 'image'" :aria-label="t('{name} 的模型能看图', { name })" size="xs" @update:model-value="write('image_input', $event ? 'image' : '')" /><small class="api-hint">{{ t("模型能看图时打开") }}</small></span></label>
    <p v-if="models.error" role="alert">{{ models.error }}</p>
  </div>
</template>

<style scoped>
.api-settings { display: grid; gap: 7px; min-width: 0; }
.api-field { display: grid; grid-template-columns: 26px minmax(0, 1fr); align-items: center; gap: 8px; color: var(--ui-text-dimmed); font-size: 11px; }
.api-inline { display: flex; gap: 4px; min-width: 0; }
.api-inline > button { flex-shrink: 0; }
.api-hint { color: var(--ui-text-muted); font-size: 10px; align-self: center; }
.api-provided { display: inline-flex; align-items: center; gap: 5px; min-height: 24px; color: var(--ui-text-muted); }
.api-provided > [class*="icon"] { width: 13px; height: 13px; color: var(--ui-success, #3ec486); }
.api-settings p { margin: 0; color: var(--ui-text-muted); font-size: 10px; line-height: 1.5; overflow-wrap: anywhere; }
</style>

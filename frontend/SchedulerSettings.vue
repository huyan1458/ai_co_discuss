<script setup>
/** Optional smart scheduling chosen while creating a room; the key goes only to the local private store. */
import { computed, inject, ref, watch } from "vue";

const props = defineProps({ free: { type: Boolean, default: false } });
const { view, bridge } = inject("discussion");
const scheduler = computed(() => view.value.launch.scheduler || {});
const providers = computed(() => Object.entries(view.value.launch.scheduler_providers || {}).map(([value, item]) => ({ value, label: item.label })));
const models = computed(() => (view.value.launch.scheduler_providers?.[scheduler.value.provider]?.models || []).map((id) => ({ label: id, value: id })));
const api_key = ref(""), key_visible = ref(false), saving = ref(false), error = ref("");
// A key saved earlier is never sent back to the page, so only a masked mark stands in for it.
const SAVED_MARK = "••••••••••••";
// A key entered for one provider does not belong to another.
watch(() => scheduler.value.provider, () => { api_key.value = ""; error.value = ""; });
const description = computed(() => props.free
  ? "没点名的消息先由调度模型判断：能直接交给某位成员时立即派给它，拿不准时仍交给主持人。"
  : "讨论中你的插话会附上分流建议（请某位专家回应、主持人处理或仅补充信息），只供主持人参考，不自动执行。");

/** Persist the entered key once input is committed (blur or Enter). */
async function save_key() {
  if (!api_key.value.trim() || saving.value) return;
  saving.value = true;
  error.value = "";
  try { await bridge.save_scheduler_api_key(api_key.value); }
  catch (failure) { error.value = failure.message; }
  finally { saving.value = false; }
}
</script>

<template>
  <div class="scheduler-settings">
    <UCheckbox :model-value="Boolean(scheduler.enabled)" label="智能调度（可选）" :description="description" @update:model-value="bridge.write_scheduler('enabled', $event)" />
    <div v-if="scheduler.enabled" class="scheduler-fields">
      <div class="scheduler-field"><span>供应商</span><USelect :model-value="scheduler.provider || ''" :items="providers" aria-label="智能调度供应商" size="xs" class="w-full" @update:model-value="bridge.write_scheduler('provider', $event)" /></div>
      <div class="scheduler-field"><span>模型</span><UInputMenu mode="autocomplete" ignore-filter :model-value="scheduler.model || ''" :items="models" value-key="value" aria-label="智能调度模型" placeholder="模型 ID" size="xs" class="w-full" @update:model-value="bridge.write_scheduler('model', $event)" /></div>
      <div class="scheduler-field"><span>密钥</span>
        <!-- A text field masked by CSS keeps browsers from offering to generate or save a password. -->
        <UInput v-model="api_key" type="text" autocomplete="off" spellcheck="false" data-1p-ignore data-lpignore="true" :placeholder="scheduler.api_key_ref ? SAVED_MARK : '填写所选供应商的 API Key'" :title="scheduler.api_key_ref && !api_key ? '已保存；本机不回传密钥，输入新 Key 可更换' : undefined" aria-label="智能调度 API Key" size="xs" class="w-full" :loading="saving" :ui="{ base: key_visible ? '' : 'scheduler-key-masked', trailing: 'pe-0.5' }" @change="save_key">
          <template #trailing><UButton :icon="key_visible ? 'i-lucide-eye' : 'i-lucide-eye-off'" :disabled="!api_key" :aria-label="key_visible ? '隐藏密钥' : '显示密钥'" :aria-pressed="key_visible" size="xs" color="neutral" variant="link" @click="key_visible = !key_visible" /></template>
        </UInput>
      </div>
      <p v-if="error" role="alert" class="scheduler-error">{{ error }}</p>
      <p class="fine-print">每次判断会把房间标题、最近 10 条消息和待判断的消息发送给所选供应商，并按次计费；密钥只保存在本机。</p>
    </div>
  </div>
</template>

<style scoped>
.scheduler-settings { display: flex; flex-direction: column; gap: 10px; padding-top: 14px; border-top: 1px solid var(--ui-border-muted); }
.scheduler-fields { display: grid; gap: 7px; max-width: 420px; padding-left: 26px; }
.scheduler-field { display: grid; grid-template-columns: 40px minmax(0, 1fr); align-items: center; gap: 8px; color: var(--ui-text-dimmed); font-size: 11px; }
.scheduler-settings :deep(.scheduler-key-masked) { -webkit-text-security: disc; }
.scheduler-error { margin: 0; color: #f0716b; font-size: 11px; }
@media (max-width: 600px) { .scheduler-fields { padding-left: 0; } }
</style>

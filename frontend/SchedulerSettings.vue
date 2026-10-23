<script setup>
/** Optional smart scheduling chosen while creating a room; the key goes only to the local private store. */
import { computed, inject, ref, watch } from "vue";

const props = defineProps({ free: { type: Boolean, default: false }, blocker: { type: String, default: "" } });
const { view, bridge } = inject("discussion");
const scheduler = computed(() => view.value.launch.scheduler || {});
const providers = computed(() => Object.entries(view.value.launch.scheduler_providers || {}).map(([value, item]) => ({ value, label: item.label })));
const models = computed(() => (view.value.launch.scheduler_providers?.[scheduler.value.provider]?.models || []).map((id) => ({ label: id, value: id })));
const api_key = ref(""), key_visible = ref(false), saving = ref(false), error = ref("");
// A key saved earlier is never sent back to the page, so only a masked mark stands in for it.
const SAVED_MARK = "••••••••••••";
// A key entered for one provider does not belong to another.
watch(() => scheduler.value.provider, () => { api_key.value = ""; error.value = ""; });
const check = ref({ state: "", message: "" });
// A changed provider, model or key needs a fresh check.
watch(() => [scheduler.value.provider, scheduler.value.model, scheduler.value.api_key_ref], () => { check.value = { state: "", message: "" }; });

/** Send one tiny question through the local service so the configuration is proven before the room relies on it. */
async function check_config() {
  check.value = { state: "loading", message: "" };
  try { await bridge.check_scheduler(); check.value = { state: "ok", message: "检查通过：决策模型已响应" }; }
  catch (failure) { check.value = { state: "error", message: failure.message }; }
}
const description = computed(() => props.free
  ? "接入决策模型，推荐更适合回答的成员，由你一键采纳。"
  : "接入决策模型，自动安排插话回应与下一轮发言。");

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
    <UCheckbox :model-value="Boolean(scheduler.enabled) && !blocker" :disabled="Boolean(blocker)" :description="blocker ? `${description}（${blocker}）` : description" @update:model-value="bridge.write_scheduler('enabled', $event)">
      <template #label><span class="scheduler-title">智能调度<UBadge size="xs" variant="soft" class="scheduler-badge">决策模型</UBadge><small>可选</small></span></template>
    </UCheckbox>
    <div v-if="scheduler.enabled && !blocker" class="scheduler-fields">
      <div class="scheduler-field"><span>供应商</span><USelect :model-value="scheduler.provider || ''" :items="providers" aria-label="智能调度供应商" size="xs" class="w-full" @update:model-value="bridge.write_scheduler('provider', $event)" /></div>
      <div class="scheduler-field"><span>模型</span><UInputMenu mode="autocomplete" ignore-filter :model-value="scheduler.model || ''" :items="models" value-key="value" aria-label="智能调度模型" placeholder="模型 ID" size="xs" class="w-full" @update:model-value="bridge.write_scheduler('model', $event)" /></div>
      <div class="scheduler-field"><span>密钥</span>
        <div class="scheduler-inline">
        <!-- A text field masked by CSS keeps browsers from offering to generate or save a password. -->
        <UInput v-model="api_key" type="text" autocomplete="off" spellcheck="false" data-1p-ignore data-lpignore="true" :placeholder="scheduler.api_key_ref ? SAVED_MARK : '填写所选供应商的 API Key'" :title="scheduler.api_key_ref && !api_key ? '已保存；本机不回传密钥，输入新 Key 可更换' : undefined" aria-label="智能调度 API Key" size="xs" class="w-full" :loading="saving" :ui="{ base: key_visible ? '' : 'scheduler-key-masked', trailing: 'pe-0.5' }" @change="save_key">
          <template #trailing><UButton :icon="key_visible ? 'i-lucide-eye' : 'i-lucide-eye-off'" :disabled="!api_key" :aria-label="key_visible ? '隐藏密钥' : '显示密钥'" :aria-pressed="key_visible" size="xs" color="neutral" variant="link" @click="key_visible = !key_visible" /></template>
        </UInput>
        <UButton icon="i-lucide-zap" aria-label="检查智能调度配置" title="检查配置：向决策模型发送一道极短的是非题，核对供应商、模型与密钥" size="xs" variant="ghost"
          :color="check.state === 'ok' ? 'success' : check.state === 'error' ? 'error' : 'neutral'" :loading="check.state === 'loading'"
          :disabled="!scheduler.api_key_ref || !scheduler.model || !view.launch.available" @click="check_config" />
        </div>
      </div>
      <p v-if="error" role="alert" class="scheduler-error">{{ error }}</p>
      <p v-if="check.message" :role="check.state === 'error' ? 'alert' : 'status'" :class="check.state === 'error' ? 'scheduler-error' : 'scheduler-ok'">{{ check.message }}</p>
      <p class="fine-print">决策模型只做选择、不生成文本，只按输入计费。判断时会把房间标题和最近 10 条消息发给所选供应商；密钥只存本机。</p>
    </div>
  </div>
</template>

<style scoped>
.scheduler-settings { display: flex; flex-direction: column; gap: 10px; padding-top: 14px; border-top: 1px solid var(--ui-border-muted); }
.scheduler-fields { display: grid; gap: 7px; max-width: 330px; padding-left: 26px; }.scheduler-field { display: grid; grid-template-columns: 40px minmax(0, 1fr); align-items: center; gap: 8px; color: var(--ui-text-dimmed); font-size: 11px; }
.scheduler-settings :deep(.scheduler-key-masked) { -webkit-text-security: disc; }
.scheduler-title { display: inline-flex; align-items: center; gap: 6px; }
.scheduler-title small { color: var(--ui-text-dimmed); font-size: 11px; font-weight: 400; }
.scheduler-badge { color: var(--channel-accent); }
.scheduler-error { margin: 0; color: #f0716b; font-size: 11px; }
.scheduler-ok { margin: 0; color: var(--ui-success); font-size: 11px; }
.scheduler-inline { display: flex; gap: 4px; min-width: 0; }
.scheduler-inline > button { flex-shrink: 0; }
@media (max-width: 600px) { .scheduler-fields { padding-left: 0; } }
</style>

<script setup>
/** Optional smart scheduling chosen while creating a room; the key goes only to the local private store. */
import { computed, inject, nextTick, ref, watch } from "vue";
import RosterAdd from "./RosterAdd.vue";

const props = defineProps({ free: { type: Boolean, default: false }, blocker: { type: String, default: "" } });
const { view, bridge } = inject("discussion");
const scheduler = computed(() => view.value.launch.scheduler || {});
const providers = computed(() => Object.entries(view.value.launch.scheduler_providers || {}).map(([value, item]) => ({ value, label: item.label })));
const models = computed(() => (view.value.launch.scheduler_providers?.[scheduler.value.provider]?.models || []).map((id) => ({ label: id, value: id })));
// Brand marks for the add row and card; OpenAI's mark reuses the Codex avatar colors.
const PROVIDER_ICONS = { jev: { icon: "/icons/typesafe.png" }, decisions: { icon: "/icons/openai.svg", style: "codex" } };
// Only one decision model per room: once added, the add row waits until it is removed.
const active = computed(() => Boolean(scheduler.value.enabled) && !props.blocker);
const add_row = ref(null);
const add_items = computed(() => providers.value.map(({ value, label }) => ({ value, name: label, initials: label.slice(0, 2), ...PROVIDER_ICONS[value],
  disabled: Boolean(props.blocker) || active.value, title: active.value ? "只能添加一个决策模型，先移出当前的" : label, aria_label: `添加决策模型 ${label}` })));
const api_key = ref(""), key_visible = ref(false), saving = ref(false), error = ref("");
// The card shows a summary; its settings stay behind "设置" like the participant cards.
const editing = ref(false);
// Opening the back remembers the settings so Cancel can restore them.
let opened_with = null;
function open_settings() {
  const { model, api_key_ref } = scheduler.value;
  opened_with = { model, api_key_ref };
  editing.value = true;
}
/** Discard edits made since the back opened. */
function cancel_settings() {
  if (opened_with) for (const field of ["model", "api_key_ref"]) bridge.write_scheduler(field, opened_with[field]);
  opened_with = null;
  api_key.value = "";
  error.value = "";
  editing.value = false;
}
/** Add one provider as the room's decision model; the provider goes first so it brings its preset model and saved key. */
function add_provider(provider) {
  bridge.write_scheduler("provider", provider);
  bridge.write_scheduler("enabled", true);
}
/** Remove the decision model and return keyboard focus to the add row. */
function remove_provider() {
  bridge.write_scheduler("enabled", false);
  nextTick(() => add_row.value?.focus_first());
}
const provider_label = computed(() => providers.value.find((item) => item.value === scheduler.value.provider)?.label || "未选择");
const status = computed(() => !scheduler.value.model ? { tone: "warn", text: "未选模型" } : !scheduler.value.api_key_ref ? { tone: "warn", text: "缺少密钥" } : { tone: "ready", text: "已配置" });
// A key saved earlier is never sent back to the page, so only a masked mark stands in for it.
const SAVED_MARK = "••••••••••••";
// A key entered for one provider does not belong to another.
watch(() => scheduler.value.provider, () => { api_key.value = ""; error.value = ""; });
const check = ref({ state: "", message: "" });
// A changed provider, model or key needs a fresh check.
watch(() => [scheduler.value.provider, scheduler.value.model, scheduler.value.api_key_ref], () => { check.value = { state: "", message: "" }; });
// Turning scheduling off closes the card so it reopens as a summary.
watch(() => scheduler.value.enabled, (enabled) => { if (!enabled) editing.value = false; });

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
    <div>
      <p class="scheduler-title">智能调度<UBadge size="xs" variant="soft" class="scheduler-badge">决策模型</UBadge><small>可选</small></p>
      <p class="scheduler-description">{{ blocker ? `${description}（${blocker}）` : description }}</p>
    </div>
    <RosterAdd ref="add_row" label="添加决策模型" :items="add_items" @add="add_provider" />
    <div v-if="active" class="scheduler-cards">
    <div class="scheduler-card" :class="{ 'is-editing': editing }">
      <template v-if="!editing">
        <button type="button" class="scheduler-open" aria-label="设置智能调度的决策模型" title="点击设置" @click="open_settings">
          <span class="scheduler-identity">
            <UAvatar :src="PROVIDER_ICONS[scheduler.provider]?.icon" :text="provider_label.slice(0, 2)" :alt="provider_label" size="sm" class="channel-avatar scheduler-avatar" :class="PROVIDER_ICONS[scheduler.provider]?.style" />
            <strong>{{ provider_label }}</strong>
          </span>
          <dl class="scheduler-facts">
            <div><dt>状态</dt><dd :class="`is-${status.tone}`"><i aria-hidden="true" />{{ status.text }}</dd></div>
            <div><dt>模型</dt><dd :title="scheduler.model">{{ scheduler.model || "未选择" }}</dd></div>
          </dl>
          <span class="scheduler-flip"><UIcon name="i-lucide-settings-2" />设置</span>
        </button>
        <span class="scheduler-tools"><button type="button" :aria-label="`移出决策模型 ${provider_label}`" title="移出" @click="remove_provider"><UIcon name="i-lucide-x" /></button></span>
      </template>
      <template v-else>
        <div class="scheduler-back">
          <div class="scheduler-heading"><strong>{{ provider_label }}<span>设置</span></strong>
            <UButton icon="i-lucide-zap" aria-label="检查智能调度配置" title="检查配置：向决策模型发送一道极短的是非题，核对供应商、模型与密钥" size="xs" variant="ghost"
              :color="check.state === 'ok' ? 'success' : check.state === 'error' ? 'error' : 'neutral'" :loading="check.state === 'loading'"
              :disabled="!scheduler.api_key_ref || !scheduler.model || !view.launch.available" @click="check_config" />
          </div>
          <div class="scheduler-field"><span>模型</span><UInputMenu mode="autocomplete" ignore-filter :model-value="scheduler.model || ''" :items="models" value-key="value" aria-label="智能调度模型" placeholder="模型 ID" size="xs" class="w-full" @update:model-value="bridge.write_scheduler('model', $event)" /></div>
          <div class="scheduler-field"><span>密钥</span>
            <!-- A text field masked by CSS keeps browsers from offering to generate or save a password. -->
            <UInput v-model="api_key" type="text" autocomplete="off" spellcheck="false" data-1p-ignore data-lpignore="true" :placeholder="scheduler.api_key_ref ? SAVED_MARK : '填写所选供应商的 API Key'" :title="scheduler.api_key_ref && !api_key ? '已保存；本机不回传密钥，输入新 Key 可更换' : undefined" aria-label="智能调度 API Key" size="xs" class="w-full" :loading="saving" :ui="{ base: key_visible ? '' : 'scheduler-key-masked', trailing: 'pe-0.5' }" @change="save_key">
              <template #trailing><UButton :icon="key_visible ? 'i-lucide-eye' : 'i-lucide-eye-off'" :disabled="!api_key" :aria-label="key_visible ? '隐藏密钥' : '显示密钥'" :aria-pressed="key_visible" size="xs" color="neutral" variant="link" @click="key_visible = !key_visible" /></template>
            </UInput>
          </div>
          <p v-if="error" role="alert" class="scheduler-error">{{ error }}</p>
          <p v-if="check.message" :role="check.state === 'error' ? 'alert' : 'status'" :class="check.state === 'error' ? 'scheduler-error' : 'scheduler-ok'">{{ check.message }}</p>
          <p class="scheduler-note">决策模型只做选择、不生成文本，只按输入计费。判断时会把房间标题和最近 10～20 条消息发给所选供应商；密钥只存本机。</p>
        </div>
        <span class="scheduler-flip-actions">
          <button type="button" class="scheduler-flip is-cancel" aria-label="放弃决策模型的修改" @click="cancel_settings">取消</button>
          <button type="button" class="scheduler-flip is-done" aria-label="完成并返回决策模型卡片" @click="editing = false"><UIcon name="i-lucide-check" />完成</button>
        </span>
      </template>
    </div>
    </div>
  </div>
</template>

<style scoped>
.scheduler-settings { display: flex; flex-direction: column; gap: 10px; padding-top: 14px; border-top: 1px solid var(--ui-border-muted); }
/* Same size front and back, so flipping never moves the dialog; long back content scrolls inside. */
.scheduler-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(248px, 1fr)); gap: 8px; }
.scheduler-card { position: relative; display: flex; flex-direction: column; min-width: 0; height: 240px; border: 1px solid var(--channel-edge-control, var(--ui-border)); border-radius: 8px; background: color-mix(in srgb, var(--ui-bg-elevated) 45%, var(--ui-bg)); box-shadow: var(--channel-shadow-control); }
.scheduler-card:hover { border-color: var(--ui-border-accented); }
.scheduler-open { display: flex; flex: 1; flex-direction: column; gap: 10px; width: 100%; padding: 12px 12px 30px; text-align: left; border-radius: inherit; outline: none; }
.scheduler-identity { display: flex; align-items: center; gap: 8px; min-width: 0; min-height: 26px; padding-right: 30px; }
.scheduler-identity strong { overflow: hidden; color: var(--ui-text-highlighted); font-size: 13px; font-weight: 600; white-space: nowrap; text-overflow: ellipsis; }
.scheduler-avatar { flex-shrink: 0; width: 26px; height: 26px; font-size: 10px; }
.scheduler-tools { position: absolute; top: 9px; right: 8px; display: flex; }
.scheduler-tools > button { display: grid; place-items: center; width: 24px; height: 24px; border-radius: 5px; color: var(--ui-text-dimmed); }
.scheduler-tools > button > span { width: 13px; height: 13px; }
.scheduler-tools > button:hover { background: var(--ui-bg-accented); color: var(--ui-text-highlighted); }
.scheduler-facts { display: grid; gap: 4px; margin: 0; padding-top: 10px; border-top: 1px solid var(--ui-border-muted); font-size: 11px; }
.scheduler-facts > div { display: grid; grid-template-columns: 3em minmax(0, 1fr); gap: 8px; }
.scheduler-facts dt { color: var(--ui-text-dimmed); white-space: nowrap; }
.scheduler-facts dd { overflow: hidden; margin: 0; color: var(--ui-text-toned); white-space: nowrap; text-overflow: ellipsis; }
.scheduler-facts dd > i { display: inline-block; width: 5px; height: 5px; margin: 0 5px 1px 0; vertical-align: middle; border-radius: 50%; background: var(--ui-text-dimmed); }
.scheduler-facts dd.is-ready > i { background: var(--ui-success, #3fb27f); }
.scheduler-facts dd.is-warn > i { background: var(--ui-warning, #e0a33a); }
.scheduler-flip { position: absolute; right: 8px; bottom: 8px; display: inline-flex; align-items: center; gap: 4px; min-height: 22px; padding: 2px 6px; border-radius: 4px; color: var(--ui-text-dimmed); font-size: 11px; }
.scheduler-flip > span { width: 12px; height: 12px; }
.scheduler-open:hover .scheduler-flip, .scheduler-flip.is-done { color: var(--channel-accent); }
.scheduler-flip.is-done:hover, .scheduler-flip.is-cancel:hover { background: var(--ui-bg-accented); }
.scheduler-flip.is-cancel:hover { color: var(--ui-text-highlighted); }
.scheduler-flip-actions { position: absolute; right: 8px; bottom: 8px; display: flex; gap: 2px; }
.scheduler-flip-actions > .scheduler-flip { position: static; }
.scheduler-back { display: flex; flex: 1; flex-direction: column; gap: 8px; min-height: 0; padding: 10px 12px 34px; overflow-y: auto; scrollbar-width: thin; }
.scheduler-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.scheduler-heading strong { color: var(--ui-text-highlighted); font-size: 12px; font-weight: 600; }
.scheduler-heading strong > span { margin-left: 6px; color: var(--ui-text-muted); font-size: 10px; font-weight: 400; }
.scheduler-field { display: grid; grid-template-columns: 40px minmax(0, 1fr); align-items: center; gap: 8px; color: var(--ui-text-dimmed); font-size: 11px; }
.scheduler-note { margin: 0; color: var(--ui-text-muted); font-size: 10px; line-height: 1.5; }
.scheduler-settings :deep(.scheduler-key-masked) { -webkit-text-security: disc; }
.scheduler-title { display: flex; align-items: center; gap: 6px; margin: 0; color: var(--ui-text-highlighted); font-size: 13px; font-weight: 500; }
.scheduler-description { margin: 2px 0 0; color: var(--ui-text-muted); font-size: 13px; }
.scheduler-title small { color: var(--ui-text-dimmed); font-size: 11px; font-weight: 400; }
.scheduler-badge { color: var(--channel-accent); }
.scheduler-error { margin: 0; color: #f0716b; font-size: 11px; }
.scheduler-ok { margin: 0; color: var(--ui-success); font-size: 11px; }
@media (pointer: coarse) { .scheduler-tools > button { min-width: 44px; min-height: 44px; } }
@media (max-width: 600px) { .scheduler-cards { grid-template-columns: 1fr; } }
</style>

<script setup>
/**
 * Optional smart scheduling: the new-room form edits the draft for the room to create; the room's settings (`room`) edit
 * the open room's own scheduling, shown `compact` as a switch with a one-line summary whose settings open on demand.
 * The key goes only to the local private store.
 */
import { computed, inject, nextTick, ref, watch } from "vue";
import RosterAdd from "./RosterAdd.vue";

const props = defineProps({ free: { type: Boolean, default: false }, blocker: { type: String, default: "" },
  room: { type: Boolean, default: false }, compact: { type: Boolean, default: false }, disabled: { type: Boolean, default: false } });
const { view, bridge } = inject("discussion");
// The open room's saved scheduling, with the key saved on this computer for its provider's root.
const room_saved = computed(() => {
  const saved = view.value.launch.room_models?.scheduler;
  if (!saved) return { enabled: false };
  const base_url = view.value.launch.scheduler_providers?.[saved.provider]?.base_url;
  return { enabled: true, ...saved, api_key_ref: view.value.launch.api_keys?.[base_url] || "" };
});
// In a room, a choice that cannot be saved yet (no model or key) waits here until it is complete.
const room_draft = ref(null);
const scheduler = computed(() => props.room ? room_draft.value || room_saved.value : view.value.launch.scheduler || {});
/** Change some fields, in order: the draft writes the new-room form; a room saves once provider, model and key are all there. */
async function write(fields) {
  if (!props.room) { for (const [field, value] of Object.entries(fields)) bridge.write_scheduler(field, value); return; }
  const next = { ...scheduler.value, ...fields };
  if ("provider" in fields || (fields.enabled && !next.provider)) {
    const providers = view.value.launch.scheduler_providers || {};
    next.provider ||= Object.keys(providers).find((name) => view.value.launch.api_keys?.[providers[name].base_url]) || Object.keys(providers)[0] || "";
    const preset = providers[next.provider];
    next.model = preset?.models[0] || "";
    next.api_key_ref = preset ? view.value.launch.api_keys?.[preset.base_url] || "" : "";
    next.mode ||= view.value.launch.scheduler_default_mode || "";
  }
  if (next.enabled && !(next.provider && next.model && next.api_key_ref)) { room_draft.value = next; return; }
  room_draft.value = next;
  try { if (next.enabled || room_saved.value.enabled) await bridge.set_room_scheduler(next.enabled ? next : null); }
  catch (failure) { bridge.notify("error", failure.message); }
  finally { if (room_draft.value === next) room_draft.value = null; }
}
const providers = computed(() => Object.entries(view.value.launch.scheduler_providers || {}).map(([value, item]) => ({ value, label: item.label })));
const models = computed(() => (view.value.launch.scheduler_providers?.[scheduler.value.provider]?.models || []).map((id) => ({ label: id, value: id })));
// Brand marks for the add row and card; OpenAI's mark reuses the Codex avatar colors.
const PROVIDER_ICONS = { jev: { icon: "/icons/typesafe.png" }, decisions: { icon: "/icons/openai.svg", style: "codex" } };
// Only one decision model per room fills a single slot: choosing another provider replaces the current one.
const active = computed(() => Boolean(scheduler.value.enabled) && !props.blocker);
const add_row = ref(null);
const add_items = computed(() => providers.value.map(({ value, label }) => {
  const selected = active.value && scheduler.value.provider === value;
  return { value, name: label, initials: label.slice(0, 2), ...PROVIDER_ICONS[value], disabled: Boolean(props.blocker), selected,
    title: selected ? "当前决策模型" : active.value ? `替换为 ${label}` : label, aria_label: active.value && !selected ? `替换决策模型为 ${label}` : `添加决策模型 ${label}` };
}));
const api_key = ref(""), key_visible = ref(false), saving = ref(false);
// The card shows a summary; its settings stay behind "设置" like the participant cards. A compact row shows only the back.
const editing = ref(false);
// Opening the back remembers the settings so Cancel can restore them.
let opened_with = null;
function open_settings() {
  opened_with = { ...scheduler.value };
  editing.value = true;
}
/** Keep what was saved and close the back; in a room, a choice still missing its model or key is dropped. */
function close_settings() {
  opened_with = null;
  editing.value = false;
  if (props.room) room_draft.value = null;
}
/** Discard edits made since the back opened. */
function cancel_settings() {
  const before = opened_with;
  opened_with = null;
  api_key.value = "";
  editing.value = false;
  if (!before) return;
  if (!props.room) { write({ model: before.model, api_key_ref: before.api_key_ref }); return; }
  // A room puts back what it had saved, or drops a choice that was never saved.
  room_draft.value = null;
  const now = room_saved.value;
  if (["enabled", "provider", "model", "mode"].some((field) => (before[field] || "") !== (now[field] || ""))) {
    const complete = before.enabled && before.provider && before.model && before.api_key_ref;
    bridge.set_room_scheduler(complete ? before : null).catch((failure) => bridge.notify("error", failure.message));
  }
}
/** Add one provider as the room's decision model; the provider goes first so it brings its preset model and saved key. */
function add_provider(provider) {
  if (active.value && scheduler.value.provider === provider) return;
  // Replacing closes the back of the previous provider's card; a compact row keeps its settings open for the new one.
  editing.value = false;
  opened_with = null;
  write({ provider, enabled: true });
  if (props.compact) open_settings();
}
/** Remove the decision model and return keyboard focus to the add row. */
function remove_provider() {
  write({ enabled: false });
  nextTick(() => add_row.value?.focus_first());
}
/** The compact row's switch: on opens the settings when something is still missing, off closes them. */
async function toggle(enabled) {
  await write({ enabled });
  if (enabled && status.value.tone !== "ready") open_settings();
}
// The compact row's one line: provider, model and judging style, or what is still missing; off, the providers to pick from.
const summary = computed(() => !active.value ? ["未开启", providers.value.map((item) => item.label).join("、")].filter(Boolean).join(" · 可用 ")
  : status.value.tone !== "ready" ? `${provider_label.value} · ${status.value.text}`
  : [provider_label.value, scheduler.value.model, view.value.launch.scheduler_modes?.[mode.value]].filter(Boolean).join(" · "));
const provider_label = computed(() => providers.value.find((item) => item.value === scheduler.value.provider)?.label || "未选择");
const status = computed(() => !scheduler.value.model ? { tone: "warn", text: "未选模型" } : !scheduler.value.api_key_ref ? { tone: "warn", text: "缺少密钥" } : { tone: "ready", text: "已配置" });
// A key saved earlier is never sent back to the page, so only a masked mark stands in for it.
const SAVED_MARK = "••••••••••••";
// A key entered for one provider does not belong to another.
watch(() => scheduler.value.provider, () => { api_key.value = ""; });
const check = ref({ state: "" });
// A changed provider, model or key needs a fresh check.
watch(() => [scheduler.value.provider, scheduler.value.model, scheduler.value.api_key_ref], () => { check.value = { state: "" }; });
// Turning scheduling off closes the card so it reopens as a summary.
watch(() => scheduler.value.enabled, (enabled) => { if (!enabled) editing.value = false; });

/** Send one tiny question through the local service so the configuration is proven before the room relies on it. */
async function check_config() {
  check.value = { state: "loading" };
  try { await bridge.check_scheduler(scheduler.value); check.value = { state: "ok" }; bridge.notify("info", "检查通过：决策模型已响应"); }
  catch (failure) { check.value = { state: "error" }; bridge.notify("error", failure.message); }
}
// How the routing question is worded: the experimental guided wording is the default while it is being refined.
const modes = computed(() => Object.entries(view.value.launch.scheduler_modes || {}).map(([value, label]) => ({ value, label })));
const mode = computed(() => scheduler.value.mode || view.value.launch.scheduler_default_mode || "");
const MODE_HINTS = { guided: "试验：说明目的与依据，由模型权衡；正在打磨，可能判错", stable: "稳定：按固定顺序逐条核对，已通过回归评测" };
const description = computed(() => props.free
  ? "接入决策模型，推荐更适合回答的成员，由你一键采纳。"
  : "接入决策模型，自动安排插话回应与下一轮发言。");

/** Persist the entered key once input is committed (blur or Enter). */
async function save_key() {
  if (!api_key.value.trim() || saving.value) return;
  saving.value = true;
  try {
    const api_key_ref = await bridge.save_scheduler_api_key(api_key.value, scheduler.value.provider);
    if (props.room) await write({ api_key_ref });
  }
  catch (failure) { bridge.notify("error", failure.message); }
  finally { saving.value = false; }
}
</script>

<template>
  <div class="scheduler-settings" :class="{ 'is-compact': compact }">
    <div v-if="compact" class="scheduler-row">
      <UCheckbox :model-value="active" :disabled="disabled || Boolean(blocker)" label="开启" aria-label="本房间开启智能调度" @update:model-value="toggle" />
      <span class="scheduler-summary" :class="active && `is-${status.tone}`" :title="summary"><i v-if="active" aria-hidden="true" />{{ summary }}</span>
      <UButton v-if="active && !disabled" :icon="editing ? 'i-lucide-chevron-up' : 'i-lucide-settings-2'" :label="editing ? '收起' : '设置'" size="xs" color="neutral" variant="ghost"
        :aria-expanded="editing" aria-label="设置本房间的决策模型" @click="editing ? close_settings() : open_settings()" />
    </div>
    <div v-else>
      <p class="scheduler-title">智能调度<UBadge size="xs" variant="soft" class="scheduler-badge">决策模型</UBadge><small>可选</small></p>
      <p class="scheduler-description">{{ blocker ? `${description}（${blocker}）` : description }}</p>
    </div>
    <RosterAdd v-if="!compact || editing" ref="add_row" label="添加决策模型" :items="add_items" @add="add_provider" />
    <p v-if="!active && !compact" class="scheduler-empty">未添加决策模型。只能放一个，点其他供应商会替换。</p>
    <div v-else-if="active && (!compact || editing)" class="scheduler-cards">
    <div class="scheduler-slot">
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
          <div class="scheduler-field"><span>模型</span><UInputMenu mode="autocomplete" ignore-filter :model-value="scheduler.model || ''" :items="models" value-key="value" aria-label="智能调度模型" placeholder="模型 ID" size="xs" class="w-full" @update:model-value="write({ model: $event })" /></div>
          <div class="scheduler-field"><span>密钥</span>
            <!-- A text field masked by CSS keeps browsers from offering to generate or save a password. -->
            <UInput v-model="api_key" type="text" autocomplete="off" spellcheck="false" data-1p-ignore data-lpignore="true" :placeholder="scheduler.api_key_ref ? SAVED_MARK : '填写所选供应商的 API Key'" :title="scheduler.api_key_ref && !api_key ? '已保存；本机不回传密钥，输入新 Key 可更换' : undefined" aria-label="智能调度 API Key" size="xs" class="w-full" :loading="saving" :ui="{ base: key_visible ? '' : 'scheduler-key-masked', trailing: 'pe-0.5' }" @change="save_key">
              <template #trailing><UButton :icon="key_visible ? 'i-lucide-eye' : 'i-lucide-eye-off'" :disabled="!api_key" :aria-label="key_visible ? '隐藏密钥' : '显示密钥'" :aria-pressed="key_visible" size="xs" color="neutral" variant="link" @click="key_visible = !key_visible" /></template>
            </UInput>
          </div>
          <p class="scheduler-note">决策模型只做选择、不生成文本，只按输入计费。判断时会把房间标题和最近 10～20 条消息发给所选供应商；密钥只存本机。</p>
        </div>
        <span class="scheduler-flip-actions">
          <button type="button" class="scheduler-flip is-cancel" aria-label="放弃决策模型的修改" @click="cancel_settings">取消</button>
          <button type="button" class="scheduler-flip is-done" aria-label="完成并返回决策模型卡片" @click="close_settings"><UIcon name="i-lucide-check" />完成</button>
        </span>
      </template>
    </div>
    </div>
    </div>
    <div v-if="active && free && modes.length > 1 && (!compact || editing)" class="scheduler-mode">
      <span>判断方式</span>
      <div class="expert-card-modes" role="radiogroup" aria-label="智能调度判断方式">
        <button v-for="option in modes" :key="option.value" type="button" role="radio" :title="MODE_HINTS[option.value]"
          :aria-checked="mode === option.value" @click="write({ mode: option.value })">{{ option.label }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.scheduler-settings { display: flex; flex-direction: column; gap: 10px; padding-top: 14px; border-top: 1px solid var(--ui-border-muted); }
/* In the room's settings the row sits in its own cell, so it needs no top rule. */
.scheduler-settings.is-compact { padding-top: 0; border-top: 0; }
.scheduler-row { display: flex; align-items: center; gap: 10px; min-width: 0; }
/* Switch and 设置 on top, the summary below as the row's help line, like the other room settings. */
.scheduler-row { flex-wrap: wrap; justify-content: space-between; row-gap: 4px; min-height: 28px; }
.scheduler-summary { order: 1; flex: 1 0 100%; min-width: 0; color: var(--ui-text-muted); font-size: 12px; line-height: 1.6; }
.scheduler-summary > i { display: inline-block; width: 6px; height: 6px; margin: 0 6px 1px 0; vertical-align: middle; border-radius: 50%; background: var(--ui-text-dimmed); }
.scheduler-summary.is-ready { color: var(--ui-text-toned); }
.scheduler-summary.is-ready > i { background: var(--ui-success, #3fb27f); }
.scheduler-summary.is-warn > i { background: var(--ui-warning, #e0a33a); }
/* In the room's settings the expanded settings are a plain panel the width of the row, not a square card in a slot. */
.is-compact .scheduler-cards { grid-template-columns: minmax(0, 420px); }
.is-compact .scheduler-slot { padding: 0; border: 0; }
.is-compact .scheduler-card { height: auto; box-shadow: none; }
.is-compact .scheduler-back { gap: 10px; padding: 12px 12px 4px; overflow: visible; }
.is-compact .scheduler-flip-actions { position: static; justify-content: flex-end; padding: 0 8px 8px; }
.is-compact .scheduler-field { grid-template-columns: 36px minmax(0, 1fr); }
/* Same size front and back, so flipping never moves the dialog; long back content scrolls inside. */
/* Same track as the member cards (.create-experts); the slot frame (4px padding + 1px border per side) is added so the card itself matches their width. */
.scheduler-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(258px, 100%), 282px)); align-items: start; gap: 8px; }
.scheduler-card { position: relative; display: flex; flex-direction: column; min-width: 0; height: 100cqi; border: 1px solid var(--channel-edge-control, var(--ui-border)); border-radius: 8px; background: color-mix(in srgb, var(--ui-bg-elevated) 45%, var(--ui-bg)); box-shadow: var(--channel-shadow-control); }
.scheduler-card:hover { border-color: var(--ui-border-accented); }
/* The empty state matches the member list's placeholder (.create-experts-empty). */
.scheduler-empty { margin: 0; padding: 18px 12px; border: 1px dashed var(--ui-border); border-radius: 8px; text-align: center; color: var(--ui-text-muted); font-size: 12px; }
/* A filled slot keeps a dashed frame around the card, so the card reads as sitting in the one slot. */
.scheduler-slot { container-type: inline-size; padding: 4px; border: 1px dashed var(--ui-border); border-radius: 8px; }
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
.scheduler-mode { display: flex; align-items: center; gap: 10px; color: var(--ui-text-dimmed); font-size: 12px; }
.scheduler-mode > span { flex: none; white-space: nowrap; }
.scheduler-mode > .expert-card-modes { width: 220px; max-width: 100%; }
.scheduler-note { margin: 0; color: var(--ui-text-muted); font-size: 10px; line-height: 1.5; }
.scheduler-settings :deep(.scheduler-key-masked) { -webkit-text-security: disc; }
.scheduler-title { display: flex; align-items: center; gap: 6px; margin: 0; color: var(--ui-text-highlighted); font-size: 13px; font-weight: 500; }
.scheduler-description { margin: 2px 0 0; color: var(--ui-text-muted); font-size: 13px; }
.scheduler-title small { color: var(--ui-text-dimmed); font-size: 11px; font-weight: 400; }
.scheduler-badge { color: var(--channel-accent); }
</style>

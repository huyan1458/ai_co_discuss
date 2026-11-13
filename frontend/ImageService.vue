<script setup>
/**
 * Image generation for a room, shaped like smart scheduling: adding the card lets the room's members draw, removing it
 * stops them. The card's address, key and image model belong to this computer (saved once, brought back for every room);
 * whether this room may draw is `enabled`, which the parent keeps (the new-room form, or the room's own settings, shown
 * `compact` as a switch with a one-line summary whose settings open on demand).
 * The key goes only to the local private store and never comes back to the page.
 */
import { computed, inject, nextTick, onMounted, reactive, ref } from "vue";
import RosterAdd from "./RosterAdd.vue";

const props = defineProps({ enabled: { type: Boolean, default: false }, disabled: { type: Boolean, default: false }, compact: { type: Boolean, default: false } });
const emit = defineEmits(["update:enabled"]);
const { bridge } = inject("discussion");
const LABEL = "OpenAI Images";
const settings = reactive({ base_url: "", model: "", api_key_ref: "", configured: false, catalog: [] });
const unavailable = ref("");
const add_row = ref(null);
const add_items = computed(() => [{ value: "openai", name: LABEL, initials: "OI", icon: "/icons/openai.svg", style: "codex",
  disabled: props.disabled || Boolean(unavailable.value), selected: props.enabled,
  title: unavailable.value ? `需连接本机服务：${unavailable.value}` : props.enabled ? "已添加" : LABEL, aria_label: `添加生图服务 ${LABEL}` }]);
const models = computed(() => settings.catalog.map((value) => ({ value, label: value })));
const status = computed(() => !settings.model ? { tone: "warn", text: "未选模型" } : !settings.api_key_ref ? { tone: "warn", text: "缺少密钥" } : { tone: "ready", text: "已配置" });
const SAVED_MARK = "••••••••••••";
const editing = ref(false), api_key = ref(""), key_visible = ref(false), saving = ref(false), address = ref("");
let opened_with = null;

onMounted(async () => {
  try { Object.assign(settings, await bridge.local_request("image-settings", {})); address.value = settings.base_url; }
  catch (error) { unavailable.value = error.message; }
});

/** Save the address, model and key reference as they stand; they are this computer's, shared by every room. */
async function save() {
  const { base_url, model, api_key_ref } = settings;
  try { Object.assign(settings, await bridge.local_request("image-settings", { base_url, model, api_key_ref })); }
  catch (error) { bridge.notify("error", error.message); }
}
function open_settings() {
  opened_with = { base_url: settings.base_url, model: settings.model, api_key_ref: settings.api_key_ref };
  address.value = settings.base_url;
  editing.value = true;
}
/** Put back what the card held when its back opened. */
async function cancel_settings() {
  if (opened_with && ["base_url", "model", "api_key_ref"].some((field) => opened_with[field] !== settings[field])) {
    Object.assign(settings, opened_with);
    await save();
  }
  opened_with = null;
  api_key.value = "";
  editing.value = false;
}
/** A key belongs to one address, so a new address asks for its key again. */
function set_address() {
  const value = address.value.trim();
  if (!value || value === settings.base_url) return;
  settings.base_url = value;
  settings.api_key_ref = "";
  save();
}
function set_model(value) {
  settings.model = String(value || "").trim();
  if (settings.model) save();
}
/** Store a newly entered key privately, then keep only its reference. */
async function save_key() {
  const key = api_key.value.trim();
  if (!key || saving.value) return;
  saving.value = true;
  try {
    settings.api_key_ref = (await bridge.local_request("api-key", { base_url: settings.base_url, api_key: key })).api_key_ref;
    await save();
  } catch (error) { bridge.notify("error", error.message); }
  finally { saving.value = false; }
}
function add() { if (!props.enabled) emit("update:enabled", true); }
/** The compact row's switch: on opens the settings when this computer has no usable service yet, off closes them. */
function toggle(enabled) {
  emit("update:enabled", enabled);
  if (enabled && status.value.tone !== "ready") open_settings();
  if (!enabled) editing.value = false;
}
// The compact row's one line: the model, or what this computer's service still lacks.
const summary = computed(() => !props.enabled ? "未开启" : status.value.tone !== "ready" ? `${LABEL} · ${status.value.text}` : `${LABEL} · ${settings.model}`);
function remove() {
  editing.value = false;
  emit("update:enabled", false);
  nextTick(() => add_row.value?.focus_first());
}
</script>

<template>
  <div class="image-service" :class="{ 'is-compact': compact }">
    <div v-if="compact" class="image-row">
      <UCheckbox :model-value="enabled" :disabled="disabled || Boolean(unavailable)" label="开启" aria-label="本房间开启生图"
        :title="unavailable ? `需连接本机服务：${unavailable}` : undefined" @update:model-value="toggle" />
      <span class="image-summary" :title="summary">{{ summary }}</span>
      <UButton v-if="enabled && !disabled && !unavailable" :icon="editing ? 'i-lucide-chevron-up' : 'i-lucide-settings-2'" :label="editing ? '收起' : '设置'" size="xs" color="neutral" variant="ghost"
        :aria-expanded="editing" aria-label="设置生图服务" @click="editing ? editing = false : open_settings()" />
    </div>
    <div v-else>
      <p class="image-title">生图<UBadge size="xs" variant="soft" class="image-badge">图片模型</UBadge><small>可选</small></p>
      <p class="image-description">接入图片模型，房间里的成员都能按需出图、改图，图片随回答发出；按张计费。</p>
    </div>
    <RosterAdd v-if="!compact" ref="add_row" label="添加生图服务" :items="add_items" @add="add" />
    <p v-if="!enabled && !compact" class="image-empty">未添加。房间里的成员不能画图。</p>
    <div v-else-if="enabled && (!compact || editing)" class="image-cards">
      <div class="image-slot">
        <div class="image-card" :class="{ 'is-editing': editing }">
          <template v-if="!editing">
            <button type="button" class="image-open" aria-label="设置生图服务" title="点击设置" :disabled="disabled" @click="open_settings">
              <span class="image-identity">
                <UAvatar src="/icons/openai.svg" text="OI" :alt="LABEL" size="sm" class="channel-avatar image-avatar codex" />
                <strong>{{ LABEL }}</strong>
              </span>
              <dl class="image-facts">
                <div><dt>状态</dt><dd :class="`is-${status.tone}`"><i aria-hidden="true" />{{ status.text }}</dd></div>
                <div><dt>模型</dt><dd :title="settings.model">{{ settings.model || "未选择" }}</dd></div>
              </dl>
              <span class="image-flip"><UIcon name="i-lucide-settings-2" />设置</span>
            </button>
            <span v-if="!disabled" class="image-tools"><button type="button" :aria-label="`移出生图服务 ${LABEL}`" title="移出" @click="remove"><UIcon name="i-lucide-x" /></button></span>
          </template>
          <template v-else>
            <div class="image-back">
              <div class="image-heading"><strong>{{ LABEL }}<span>设置</span></strong></div>
              <div class="image-field"><span>地址</span><UInput v-model="address" aria-label="图片接口 Base URL" placeholder="https://api.openai.com/v1" size="xs" class="w-full" @change="set_address" /></div>
              <div class="image-field"><span>密钥</span>
                <!-- A text field masked by CSS keeps browsers from offering to generate or save a password. -->
                <UInput v-model="api_key" type="text" autocomplete="off" spellcheck="false" data-1p-ignore data-lpignore="true" :placeholder="settings.api_key_ref ? SAVED_MARK : '填写图片接口的 API Key'" :title="settings.api_key_ref && !api_key ? '已保存；本机不回传密钥，输入新 Key 可更换' : undefined" aria-label="生图 API Key" size="xs" class="w-full" :loading="saving" :ui="{ base: key_visible ? '' : 'image-key-masked', trailing: 'pe-0.5' }" @change="save_key">
                  <template #trailing><UButton :icon="key_visible ? 'i-lucide-eye' : 'i-lucide-eye-off'" :disabled="!api_key" :aria-label="key_visible ? '隐藏密钥' : '显示密钥'" :aria-pressed="key_visible" size="xs" color="neutral" variant="link" @click="key_visible = !key_visible" /></template>
                </UInput>
              </div>
              <div class="image-field"><span>模型</span><UInputMenu mode="autocomplete" ignore-filter :model-value="settings.model" :items="models" value-key="value" aria-label="图片模型 ID" placeholder="选择或填写图片模型" size="xs" class="w-full min-w-0" @update:model-value="set_model" /></div>
              <p class="image-note">地址、密钥和模型存在这台电脑，所有房间共用；每张图按所配账号计费。</p>
            </div>
            <span class="image-flip-actions">
              <button type="button" class="image-flip is-cancel" aria-label="放弃生图服务的修改" @click="cancel_settings">取消</button>
              <button type="button" class="image-flip is-done" aria-label="完成并返回生图服务卡片" @click="editing = false"><UIcon name="i-lucide-check" />完成</button>
            </span>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Same card, slot and sizes as smart scheduling (SchedulerSettings.vue), so the two sections read as one kind. */
.image-service { display: flex; flex-direction: column; gap: 10px; padding-top: 14px; border-top: 1px solid var(--ui-border-muted); }
/* In the room's settings the row sits in its own cell, so it needs no top rule. */
.image-service.is-compact { padding-top: 0; border-top: 0; }
.image-row { display: flex; align-items: center; gap: 10px; min-width: 0; }
.image-summary { flex: 1; min-width: 0; overflow: hidden; color: var(--ui-text-muted); font-size: 13px; white-space: nowrap; text-overflow: ellipsis; }
.image-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(258px, 100%), 282px)); align-items: start; gap: 8px; }
.image-card { position: relative; display: flex; flex-direction: column; min-width: 0; height: 100cqi; border: 1px solid var(--channel-edge-control, var(--ui-border)); border-radius: 8px; background: color-mix(in srgb, var(--ui-bg-elevated) 45%, var(--ui-bg)); box-shadow: var(--channel-shadow-control); }
.image-card:hover { border-color: var(--ui-border-accented); }
.image-empty { margin: 0; padding: 18px 12px; border: 1px dashed var(--ui-border); border-radius: 8px; text-align: center; color: var(--ui-text-muted); font-size: 12px; }
.image-slot { container-type: inline-size; padding: 4px; border: 1px dashed var(--ui-border); border-radius: 8px; }
.image-open { display: flex; flex: 1; flex-direction: column; gap: 10px; width: 100%; padding: 12px 12px 30px; text-align: left; border-radius: inherit; outline: none; }
.image-identity { display: flex; align-items: center; gap: 8px; min-width: 0; min-height: 26px; padding-right: 30px; }
.image-identity strong { overflow: hidden; color: var(--ui-text-highlighted); font-size: 13px; font-weight: 600; white-space: nowrap; text-overflow: ellipsis; }
.image-avatar { flex-shrink: 0; width: 26px; height: 26px; font-size: 10px; }
.image-tools { position: absolute; top: 9px; right: 8px; display: flex; }
.image-tools > button { display: grid; place-items: center; width: 24px; height: 24px; border-radius: 5px; color: var(--ui-text-dimmed); }
.image-tools > button > span { width: 13px; height: 13px; }
.image-tools > button:hover { background: var(--ui-bg-accented); color: var(--ui-text-highlighted); }
.image-facts { display: grid; gap: 4px; margin: 0; padding-top: 10px; border-top: 1px solid var(--ui-border-muted); font-size: 11px; }
.image-facts > div { display: grid; grid-template-columns: 3em minmax(0, 1fr); gap: 8px; }
.image-facts dt { color: var(--ui-text-dimmed); white-space: nowrap; }
.image-facts dd { overflow: hidden; margin: 0; color: var(--ui-text-toned); white-space: nowrap; text-overflow: ellipsis; }
.image-facts dd > i { display: inline-block; width: 5px; height: 5px; margin: 0 5px 1px 0; vertical-align: middle; border-radius: 50%; background: var(--ui-text-dimmed); }
.image-facts dd.is-ready > i { background: var(--ui-success, #3fb27f); }
.image-facts dd.is-warn > i { background: var(--ui-warning, #e0a33a); }
.image-flip { position: absolute; right: 8px; bottom: 8px; display: inline-flex; align-items: center; gap: 4px; min-height: 22px; padding: 2px 6px; border-radius: 4px; color: var(--ui-text-dimmed); font-size: 11px; }
.image-flip > span { width: 12px; height: 12px; }
.image-open:hover .image-flip, .image-flip.is-done { color: var(--channel-accent); }
.image-flip.is-done:hover, .image-flip.is-cancel:hover { background: var(--ui-bg-accented); }
.image-flip.is-cancel:hover { color: var(--ui-text-highlighted); }
.image-flip-actions { position: absolute; right: 8px; bottom: 8px; display: flex; gap: 2px; }
.image-flip-actions > .image-flip { position: static; }
.image-back { display: flex; flex: 1; flex-direction: column; gap: 8px; min-height: 0; padding: 10px 12px 34px; overflow-y: auto; scrollbar-width: thin; }
.image-heading strong { color: var(--ui-text-highlighted); font-size: 12px; font-weight: 600; }
.image-heading strong > span { margin-left: 6px; color: var(--ui-text-muted); font-size: 10px; font-weight: 400; }
.image-field { display: grid; grid-template-columns: 40px minmax(0, 1fr); align-items: center; gap: 8px; color: var(--ui-text-dimmed); font-size: 11px; }
.image-note { margin: 0; color: var(--ui-text-muted); font-size: 10px; line-height: 1.5; }
.image-service :deep(.image-key-masked) { -webkit-text-security: disc; }
.image-title { display: flex; align-items: center; gap: 6px; margin: 0; color: var(--ui-text-highlighted); font-size: 13px; font-weight: 500; }
.image-description { margin: 2px 0 0; color: var(--ui-text-muted); font-size: 13px; }
.image-title small { color: var(--ui-text-dimmed); font-size: 11px; font-weight: 400; }
.image-badge { color: var(--channel-accent); }
</style>

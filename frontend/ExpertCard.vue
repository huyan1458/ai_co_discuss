<script setup>
/** Show one participant instance as a roster row; its software settings expand inline. */
import { computed, inject, nextTick, ref, watch } from "vue";
import EffortSlider from "./EffortSlider.vue";

const props = defineProps({
  name: { type: String, required: true },
  mode: { type: String, default: "" },
  automatic: Boolean,
  status: { type: Object, required: true },
  host: Boolean,
  hostable: Boolean,
});
const emit = defineEmits(["remove", "mode", "host"]);
const { view, bridge } = inject("discussion");
const toggle_button = ref(null);
const expanded = ref(false);
const profile = computed(() => view.value.launch.profiles[props.name] || {});
const entry_items = computed(() => bridge.launch_clients[props.name] || []);
const entry_label = computed(() => props.mode === "online" ? "网页" : !props.automatic ? "本地 App / CLI"
  : entry_items.value.find((item) => item.value === profile.value.adapter)?.label || "待选择 App / CLI");
const can_expand = computed(() => entry_items.value.length > 0);
const models = computed(() => bridge.launch_model_state(props.name, view.value.launch));
const configurable = computed(() => Boolean(props.automatic && props.mode === "cli" && models.value.supported));
const configuration_note = computed(() => props.mode === "online" ? "模型与思考强度在原网页聊天中选择。回答由你或授权主持人代发。"
  : !props.automatic ? "在已有 App 或 CLI 会话中选择模型与强度，再交给它参与指令。本地 AI 可自行提交回答。"
  : profile.value.adapter ? "模型与思考强度在 App 原聊天中选择，本页不覆盖 App 设置。" : "先选择软件入口。支持启动参数的 CLI 可在这里设置模型与强度。");
const effort_items = computed(() => {
  const levels = models.value.efforts;
  const labels = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra High", max: "Max", ultra: "Ultra" };
  return levels?.length ? [{ label: "默认强度", value: "" }, ...levels.map((level) => ({ label: labels[level] || level, value: level }))] : null;
});
const effort_label = computed(() => effort_items.value?.find((item) => item.value === (profile.value.effort || ""))?.label
  || (profile.value.adapter === "antigravity_cli" ? "强度随模型" : profile.value.effort || "默认强度"));
// Capability is already in the status text; the summary adds only the entry and CLI overrides.
const summary = computed(() => configurable.value ? `${entry_label.value} · ${profile.value.model || "默认模型"} · ${effort_label.value}` : entry_label.value);

/** Open or close this instance's settings. */
function toggle(next = !expanded.value) {
  if (next && !can_expand.value) return;
  expanded.value = next;
}

/** Restore the CLI defaults for this participant only. */
function reset_model() {
  bridge.write_launch(props.name, "model", "");
  bridge.write_launch(props.name, "effort", "");
}

/** Keep the two capability choices usable as one keyboard radio group. */
function choose_capability(event) {
  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const next = event.key === "Home" ? "cli" : event.key === "End" ? "online" : props.mode === "cli" ? "online" : "cli";
  emit("mode", next);
  event.currentTarget.querySelector(`[data-mode="${next}"]`)?.focus();
}

/** Escape closes open settings before it can close the surrounding create dialog. */
function escape(event) {
  if (!expanded.value) return;
  event.stopPropagation();
  event.preventDefault();
  toggle(false);
  nextTick(() => toggle_button.value?.focus({ preventScroll: true }));
}

watch(() => [expanded.value, configurable.value, view.value.launch.available, profile.value.adapter],
  ([opened, enabled, available]) => { if (opened && enabled && available) bridge.load_launch_models(props.name); });
</script>

<template>
  <li class="roster-row" :class="{ 'is-open': expanded, 'is-host': host }" :data-identity="bridge.identities[name]?.style" @keydown.esc="escape">
    <div class="roster-row-main">
      <UAvatar :src="bridge.identities[name]?.icon" :text="bridge.identities[name]?.initials" :alt="name" size="xs" class="channel-avatar roster-row-avatar" :class="bridge.identities[name]?.style" />
      <span class="roster-row-copy">
        <strong>{{ name }}<span v-if="host" class="roster-row-badge">主持</span></strong>
        <span class="roster-row-meta"><i aria-hidden="true" :class="`is-${status.tone}`" /><span :title="`${status.text} · ${summary}`">{{ status.text }} · {{ summary }}</span></span>
      </span>
      <span class="roster-row-actions">
        <button v-if="hostable" type="button" class="roster-row-host" :aria-pressed="host" :aria-label="host ? `${name} 是主持人` : `设 ${name} 为主持人`" :title="host ? '主持人' : '设为主持人'" @click="emit('host')"><UIcon name="i-lucide-crown" /></button>
        <button v-if="can_expand" ref="toggle_button" type="button" :aria-expanded="expanded" :aria-label="`${name} 的参与设置`" title="参与设置" @click="toggle()"><UIcon name="i-lucide-settings-2" /></button>
        <button type="button" :aria-label="`移出 ${name}`" title="移出" @click="emit('remove')"><UIcon name="i-lucide-x" /></button>
      </span>
    </div>
    <div v-if="expanded" class="roster-row-settings">
      <div v-if="!automatic" class="roster-row-modes" role="radiogroup" :aria-label="`${name} 参与能力`" @keydown="choose_capability">
        <button v-for="option in [{ value: 'cli', label: '本地读写' }, { value: 'online', label: '在线只读' }]" :key="option.value" type="button"
          role="radio" :aria-checked="mode === option.value" :tabindex="mode === option.value ? 0 : -1" :data-mode="option.value" @click="emit('mode', option.value)">{{ option.label }}</button>
      </div>
      <div v-if="automatic && mode === 'cli' && entry_items.length" class="roster-row-field">
        <span>软件入口</span><USelect :model-value="profile.adapter || ''" :items="entry_items" placeholder="选择 App / CLI" :aria-label="`${name} 软件入口`" size="xs" @update:model-value="bridge.write_launch(name, 'adapter', $event)" />
      </div>
      <template v-if="configurable">
        <div class="roster-row-field">
          <span>模型</span><USelect :model-value="profile.model || '__default__'" :items="models.items" :loading="models.loading" :aria-label="`${name} 使用的模型`" size="xs" @update:model-value="bridge.write_launch_model(name, $event)" />
        </div>
        <div class="roster-row-catalog"><span>{{ models.loading ? '正在读取软件模型列表…' : models.error || models.source }}</span><button v-if="!models.loading && models.error && view.launch.available" type="button" @click="bridge.load_launch_models(name, true)">重试</button></div>
        <div v-if="effort_items" class="roster-row-effort">
          <div><span>思考强度</span><strong>{{ effort_label }}</strong></div>
          <EffortSlider :items="effort_items" :model-value="profile.effort || ''" :label="`${name} 的思考强度`" @update:model-value="bridge.write_launch(name, 'effort', $event)" />
        </div>
        <p v-else class="roster-row-note">{{ models.effort_note }}</p>
        <div class="roster-row-defaults"><span>默认值由 CLI 决定</span><button type="button" :aria-label="`恢复 ${name} 的默认模型与强度`" :disabled="!profile.model && !profile.effort" @click="reset_model">恢复默认</button></div>
      </template>
      <p v-else class="roster-row-note">{{ configuration_note }}</p>
    </div>
  </li>
</template>

<style scoped>
.roster-row { min-width: 0; }
.roster-row + .roster-row { border-top: 1px solid var(--ui-border-muted); }
.roster-row-main { display: flex; align-items: center; gap: 10px; min-height: 46px; padding: 6px 6px 6px 12px; }
.roster-row-avatar { flex-shrink: 0; width: 24px; height: 24px; font-size: 10px; }
.roster-row-copy { display: flex; flex: 1; flex-direction: column; gap: 2px; min-width: 0; }
.roster-row-copy strong { display: flex; align-items: center; gap: 6px; color: var(--ui-text-highlighted); font-size: 13px; font-weight: 600; }
.roster-row-badge { padding: 0 5px; border-radius: 4px; background: color-mix(in srgb, #e0b44a 16%, transparent); color: #e0b44a; font-size: 10px; font-weight: 500; line-height: 16px; }
.roster-row-meta { display: flex; align-items: center; gap: 6px; min-width: 0; color: var(--ui-text-muted); font-size: 11px; }
.roster-row-meta > span { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.roster-row-meta > i { flex-shrink: 0; width: 5px; height: 5px; border-radius: 50%; background: var(--ui-text-dimmed); }
.roster-row-meta > i.is-ready { background: var(--ui-success, #3fb27f); }
.roster-row-meta > i.is-warn { background: var(--ui-warning, #e0a33a); }
.roster-row-actions { display: flex; flex-shrink: 0; gap: 2px; }
.roster-row-actions > button { display: grid; place-items: center; width: 28px; height: 28px; border-radius: 5px; color: var(--ui-text-dimmed); }
.roster-row-actions > button > span { width: 14px; height: 14px; }
.roster-row-actions > button:hover { background: var(--ui-bg-accented); color: var(--ui-text-highlighted); }
.roster-row-actions > button[aria-expanded="true"] { background: var(--ui-bg-elevated); color: var(--ui-text-highlighted); }
.roster-row-actions > .roster-row-host[aria-pressed="true"] { color: #e0b44a; }
.roster-row-settings { display: flex; flex-direction: column; gap: 10px; margin: 0 10px 10px 46px; padding: 10px 12px; border-radius: 6px; background: var(--ui-bg-muted); }
.roster-row-field { display: grid; grid-template-columns: 64px minmax(0, 1fr); align-items: center; gap: 8px; color: var(--ui-text-muted); font-size: 11px; }
.roster-row-modes { display: flex; gap: 3px; padding: 3px; border-radius: 5px; background: var(--ui-bg); }
.roster-row-modes button { flex: 1; min-height: 26px; border-radius: 4px; color: var(--ui-text-muted); font-size: 11px; }
.roster-row-modes button[aria-checked="true"] { background: var(--ui-bg-elevated); color: var(--ui-text-highlighted); box-shadow: var(--channel-shadow-control); }
.roster-row-catalog { display: flex; align-items: baseline; gap: 8px; margin: -4px 0 0 72px; color: var(--ui-text-muted); font-size: 10px; overflow-wrap: anywhere; }
.roster-row-catalog > span { flex: 1; }
.roster-row-effort > div { display: flex; align-items: center; justify-content: space-between; color: var(--ui-text-muted); font-size: 11px; }
.roster-row-effort strong { color: var(--channel-accent); font-size: 12px; font-weight: 600; }
.roster-row-defaults { display: flex; align-items: center; justify-content: space-between; gap: 4px; color: var(--ui-text-dimmed); font-size: 10px; }
.roster-row-defaults > button { min-height: 22px; color: var(--ui-text-muted); font-size: 11px; }
.roster-row-defaults > button:hover:not(:disabled) { color: var(--channel-accent); }
.roster-row-defaults > button:disabled { opacity: .4; }
.roster-row-note { margin: 0; color: var(--ui-text-muted); font-size: 11px; line-height: 1.7; }
@media (pointer: coarse) {
  .roster-row-actions > button { width: 44px; height: 44px; }
  .roster-row-modes button, .roster-row-defaults > button { min-height: 44px; }
}
@media (max-width: 600px) { .roster-row-settings { margin-left: 10px; } }
</style>

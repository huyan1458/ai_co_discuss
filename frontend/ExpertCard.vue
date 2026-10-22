<script setup>
/** Show one participant instance and its actual software configuration boundary. */
import { computed, inject, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { motion, useReducedMotion, useSpring } from "motion-v";
import EffortSlider from "./EffortSlider.vue";
import ApiSettings from "./ApiSettings.vue";

const props = defineProps({
  name: { type: String, required: true },
  mode: { type: String, default: "" },
  // Delivery options this card offers: cli (woken by the local service), manual or online; empty when fixed.
  choices: { type: Array, default: () => [] },
  status: { type: Object, required: true },
  host: Boolean,
  hostable: Boolean,
});
const emit = defineEmits(["remove", "mode", "host"]);
const { view, bridge } = inject("discussion");
// Feel.words("smooth, crisp"): 2.615 Hz reads as a deliberate turn; ζ .96 avoids bounce.
// Unit mass: this is a button-controlled angular spring, with no drag-weight effect.
const FLIP_SPRING = { mass: 1, stiffness: 270.0323764138049, damping: 31.550710806760762 };
const BACK_ANGLE = 180;
const angle = useSpring(0, FLIP_SPRING);
const reduced_motion = useReducedMotion();
const card = ref(null), front_button = ref(null), back_button = ref(null);
const back = ref(false), visible_back = ref(false);
const profile = computed(() => view.value.launch.profiles[props.name] || {});
const entry_items = computed(() => bridge.launch_clients[props.name] || []);
const automatic = computed(() => props.mode === "cli");
const ACCESS_LABELS = { cli: "本机唤醒", manual: "手动接入", online: "网页代发" };
const entry_label = computed(() => props.mode === "online" ? "网页聊天" : props.mode === "manual" ? "你的 App / CLI 会话"
  : entry_items.value.find((item) => item.value === profile.value.adapter)?.label || "待选择 App / CLI");
const can_flip = computed(() => props.choices.length > 1 || automatic.value && entry_items.value.length > 0);
const card_label = computed(() => props.mode === "online" ? `设置 ${props.name} 的参与方式` : `配置 ${props.name} 的接入方式`);
const models = computed(() => bridge.launch_model_state(props.name, view.value.launch));
const configurable = computed(() => Boolean(automatic.value && models.value.supported));
const configuration_note = computed(() => configurable.value && connection.value.length ? "补齐上方连接后，可在这里选择模型与思考强度。" : props.mode === "online" ? "模型与思考强度在原网页聊天中选择。回答由你或授权主持人代发。"
  : props.mode === "manual" ? "在已有 App 或 CLI 会话中选择模型与强度，再交给它参与指令。本地 AI 可自行提交回答。"
  : profile.value.adapter ? "模型与思考强度在 App 原聊天中选择，本页不覆盖 App 设置。" : "先选择软件入口。支持启动参数的 CLI 可在这里设置模型与强度。");
const effort_items = computed(() => {
  const levels = models.value.efforts;
  const labels = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra High", max: "Max", ultra: "Ultra" };
  return levels?.length ? [{ label: "默认强度", value: "" }, ...levels.map((level) => ({ label: labels[level] || level, value: level }))] : null;
});
const effort_label = computed(() => effort_items.value?.find((item) => item.value === (profile.value.effort || ""))?.label
  || (profile.value.adapter === "antigravity_cli" ? "强度随模型" : profile.value.effort || "默认强度"));
// The front lists the read-only configuration; strength appears only where this page sets it.
// Only CLI experts choose project access; API and online experts remain read-only.
const sets_access = computed(() => automatic.value && bridge.launch_can_set_access(props.name, view.value.launch));
const fixed_read = computed(() => props.mode === "online" || automatic.value && profile.value.adapter === "api");
const local_connection = computed(() => automatic.value && profile.value.adapter !== "api");
const access = computed(() => profile.value.project_access || view.value.launch.workspace?.project_access || "read");
const facts = computed(() => [
  { label: "软件", value: entry_label.value },
  { label: "模型", value: configurable.value ? profile.value.model || "默认模型" : props.mode === "online" ? "在原网页设置" : "在原软件设置" },
  ...configurable.value && profile.value.adapter !== "api" ? [{ label: "强度", value: effort_label.value }] : [],
  ...automatic.value && profile.value.adapter === "api" ? [{ label: "上下文", value: "房间记录" }] : [],
  ...sets_access.value || fixed_read.value ? [{ label: "项目", value: sets_access.value && access.value === "write" ? "可写" : "只读" }] : [],
]);
// Ask only for connection values that are missing; a field stays while the back is open so typing does not hide it.
const CONNECTION_FIELDS = { executable: { label: "路径", placeholder: "可执行文件完整路径" },
  ipc_directory: { label: "IPC", placeholder: "Sidecar IPC 目录" }, source_thread_id: { label: "聊天", placeholder: "Codex App 来源聊天 ID" } };
const asked = ref([]);
const required_connection = () => {
  const adapter = profile.value.adapter;
  if (!local_connection.value || !adapter) return [];
  return (adapter === "antigravity" ? ["ipc_directory"] : adapter === "codex" ? ["executable", "source_thread_id"] : ["executable"])
    .filter(field => !profile.value[field]);
};
const connection = computed(() => !local_connection.value ? []
  : [...new Set([...asked.value, ...required_connection()])].map(field => ({ field, ...CONNECTION_FIELDS[field] })));

/** Restore focus only while the user is still waiting on this card. */
function focus_face() {
  nextTick(() => {
    if (document.activeElement === card.value) (visible_back.value ? back_button : front_button).value?.focus({ preventScroll: true });
  });
}

/** Expose the incoming face when the spring crosses the edge. */
function reveal(degrees) {
  const next = degrees >= BACK_ANGLE / 2;
  if (visible_back.value === next) return;
  visible_back.value = next;
  focus_face();
}
const stop_observing = angle.on("change", reveal);
// A rapid reversal can settle without ever crossing the edge.
const stop_settling = angle.on("animationComplete", focus_face);

/** Retarget the same spring so a reversal carries its current angle and velocity. */
// Opening the back remembers this instance's settings so Cancel can restore them exactly.
let opened_with = null;

function flip(next) {
  if (next && !can_flip.value) return;
  card.value?.focus({ preventScroll: true });
  asked.value = next ? required_connection() : [];
  if (next && !back.value) opened_with = { profile: JSON.parse(JSON.stringify(profile.value)), mode: props.mode };
  back.value = next;
}

/** Discard edits made since the back opened, then return to the front. */
function cancel() {
  if (opened_with) {
    bridge.restore_launch_profile(props.name, opened_with.profile);
    if (opened_with.mode !== props.mode) emit("mode", opened_with.mode);
    opened_with = null;
  }
  flip(false);
}

/** Restore the CLI defaults for this participant only. */
function reset_model() {
  bridge.write_launch(props.name, "model", "");
  bridge.write_launch(props.name, "effort", "");
}

/** Keep the delivery choices usable as one keyboard radio group. */
function choose_capability(event) {
  const keys = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 };
  if (!(event.key in keys) && !["Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const options = props.choices, index = options.indexOf(props.mode);
  const next = event.key === "Home" ? options[0] : event.key === "End" ? options.at(-1) : options[(index + keys[event.key] + options.length) % options.length];
  emit("mode", next);
  event.currentTarget.querySelector(`[data-mode="${next}"]`)?.focus();
}

/** Escape closes this face before it can close the surrounding create dialog. */
function escape(event) {
  if (!back.value) return;
  event.stopPropagation();
  event.preventDefault();
  cancel();
}

watch([back, reduced_motion], ([next, reduced]) => {
  const target = next ? BACK_ANGLE : 0;
  if (reduced) { angle.jump(target); focus_face(); }
  else angle.set(target);
});
// Prefetch as soon as the card can use a catalog, so flipping does not wait on a slow CLI query.
watch(() => [configurable.value, view.value.launch.available, profile.value.adapter],
  ([enabled, available]) => { if (enabled && available) bridge.load_launch_models(props.name); }, { immediate: true });
onBeforeUnmount(() => { stop_observing(); stop_settling(); angle.stop(); });
</script>

<template>
  <div ref="card" class="expert-card" :class="{ 'is-configurable': configurable, 'is-host': host }"
    :data-identity="bridge.identities[name]?.style" :data-face="visible_back ? 'back' : 'front'" tabindex="-1" @keydown.esc="escape">
    <motion.div class="expert-card-turn" :style="{ rotateY: angle }">
      <div class="expert-card-face expert-card-front" :inert="visible_back" :aria-hidden="visible_back">
        <component :is="can_flip ? 'button' : 'div'" ref="front_button" :type="can_flip ? 'button' : undefined" class="expert-card-open" :class="{ 'is-static': !can_flip }"
          :aria-label="can_flip ? card_label : undefined" :title="can_flip ? '点击翻面设置' : undefined" @click="flip(true)">
          <span class="expert-card-identity">
            <UAvatar :src="bridge.identities[name]?.icon" :text="bridge.identities[name]?.initials" :alt="name" size="sm" class="channel-avatar expert-card-avatar" :class="bridge.identities[name]?.style" />
            <strong>{{ name }}</strong><span v-if="host" class="expert-card-badge">主持</span>
          </span>
          <dl class="expert-card-facts">
            <div><dt>状态</dt><dd class="expert-card-status" :class="`is-${status.tone}`" :title="status.text"><i aria-hidden="true" />{{ status.text }}</dd></div>
            <div v-for="fact in facts" :key="fact.label"><dt>{{ fact.label }}</dt><dd :title="fact.value">{{ fact.value }}</dd></div>
          </dl>
          <span v-if="can_flip" class="expert-card-flip"><UIcon name="i-lucide-settings-2" />设置</span>
        </component>
        <span class="expert-card-tools">
          <button v-if="hostable" type="button" class="expert-card-host" :aria-pressed="host" :aria-label="host ? `${name} 是主持人` : `设 ${name} 为主持人`" :title="host ? '主持人' : '设为主持人'" @click="emit('host')"><UIcon name="i-lucide-crown" /></button>
          <button type="button" :aria-label="`移出 ${name}`" title="移出" @click="emit('remove')"><UIcon name="i-lucide-x" /></button>
        </span>
      </div>
      <div v-if="can_flip" class="expert-card-face expert-card-back" :inert="!visible_back" :aria-hidden="!visible_back">
        <div class="expert-card-back-body">
        <div class="expert-card-heading"><strong>{{ name }}<span>设置{{ fixed_read ? ' · 项目只读' : '' }}</span></strong></div>
        <div v-if="choices.length > 1" class="expert-card-modes" role="radiogroup" :aria-label="`${name} 接入方式`" @keydown="choose_capability">
          <button v-for="option in choices" :key="option" type="button"
            role="radio" :aria-checked="mode === option" :tabindex="mode === option ? 0 : -1" :data-mode="option" @click="emit('mode', option)">{{ ACCESS_LABELS[option] }}</button>
        </div>
        <div v-if="automatic && entry_items.length > 1" class="expert-card-field">
          <span>接入</span><USelect :model-value="profile.adapter || ''" :items="entry_items" placeholder="选择 API / App / CLI" :aria-label="`${name} 软件入口`" size="xs" class="w-full" @update:model-value="bridge.write_launch(name, 'adapter', $event)" />
        </div>
        <div v-for="item in connection" :key="item.field" class="expert-card-field">
          <span>{{ item.label }}</span><UInput :model-value="profile[item.field] || ''" :placeholder="item.placeholder" :aria-label="`${name} ${item.placeholder}`" size="xs" class="w-full" @update:model-value="bridge.write_launch(name, item.field, $event)" />
        </div>
        <div v-if="sets_access" class="expert-card-field">
          <span>项目</span>
          <div class="expert-card-modes" role="radiogroup" :aria-label="`${name} 的项目文件权限`">
            <button v-for="option in [{ value: 'read', label: '只读' }, { value: 'write', label: '可写' }]" :key="option.value" type="button" role="radio"
              :aria-checked="access === option.value" @click="bridge.write_launch(name, 'project_access', option.value)">{{ option.label }}</button>
          </div>
        </div>
        <ApiSettings v-if="automatic && profile.adapter === 'api'" :name="name" />
        <template v-else-if="configurable && !connection.length">
          <div class="expert-card-field">
            <span>模型</span><USelect :model-value="profile.model || '__default__'" :items="models.items" :loading="models.loading" :title="models.source" :aria-label="`${name} 使用的模型`" size="xs" class="w-full" @update:model-value="bridge.write_launch_model(name, $event)" />
          </div>
          <div v-if="models.loading || models.error" class="expert-card-catalog"><span>{{ models.loading ? '正在读取软件模型列表…' : models.error }}</span><button v-if="!models.loading && models.error && view.launch.available" type="button" @click="bridge.load_launch_models(name, true)">重试</button></div>
          <div v-if="effort_items" class="expert-card-effort">
            <EffortSlider caption="强度" :items="effort_items" :model-value="profile.effort || ''" :label="`${name} 的思考强度`" @update:model-value="bridge.write_launch(name, 'effort', $event)" />
          </div>
          <p v-else class="expert-card-note">{{ models.effort_note }}</p>
          <button type="button" class="expert-card-defaults" title="留空使用 CLI 默认值" :aria-label="`恢复 ${name} 的默认模型与强度`" :disabled="!profile.model && !profile.effort" @click="reset_model">恢复默认</button>
        </template>
        <p v-else class="expert-card-note"><UIcon :name="mode === 'online' ? 'i-lucide-globe' : 'i-lucide-monitor'" />{{ configuration_note }}</p>
        </div>
        <span class="expert-card-flip-actions">
          <button type="button" class="expert-card-flip is-cancel" :aria-label="`放弃 ${name} 的修改`" @click="cancel">取消</button>
          <button ref="back_button" type="button" class="expert-card-flip is-done" :aria-label="`保存并返回 ${name} 角色卡片`" @click="flip(false)"><UIcon name="i-lucide-check" />完成</button>
        </span>
      </div>
    </motion.div>
  </div>
</template>

<style scoped>
.expert-card { min-width: 0; perspective: 900px; outline: none; }
/* Both faces keep one size; long settings scroll inside the back while its actions stay in place. */
.expert-card-turn { display: grid; grid-template: minmax(0, 1fr) / minmax(0, 1fr); height: 224px; transform-style: preserve-3d; }
.expert-card-face { grid-area: 1 / 1; min-width: 0; min-height: 0; border: 1px solid var(--channel-edge-control, var(--ui-border)); border-radius: 8px; background: color-mix(in srgb, var(--ui-bg-elevated) 45%, var(--ui-bg)); box-shadow: var(--channel-shadow-control); backface-visibility: hidden; }
.expert-card.is-host .expert-card-front { border-color: color-mix(in srgb, #e0b44a 45%, var(--ui-border)); }
.expert-card-front { position: relative; display: flex; }
.expert-card-back { position: relative; display: flex; flex-direction: column; gap: 4px; padding: 10px 12px 8px; transform: rotateY(180deg); }
.expert-card-back-body { display: flex; flex: 1; flex-direction: column; gap: 8px; min-height: 0; overflow-y: auto; scrollbar-width: thin; }
.expert-card:hover .expert-card-face { border-color: var(--ui-border-accented); }
.expert-card-open { display: flex; flex: 1; flex-direction: column; gap: 10px; width: 100%; min-width: 0; padding: 12px 12px 30px; text-align: left; border-radius: inherit; outline: none; }
.expert-card-open.is-static { cursor: default; padding-bottom: 12px; }
.expert-card-identity { display: flex; align-items: center; gap: 8px; min-width: 0; min-height: 26px; padding-right: 50px; }
.expert-card-avatar { flex-shrink: 0; width: 26px; height: 26px; font-size: 10px; }
.expert-card-identity strong { overflow: hidden; color: var(--ui-text-highlighted); font-size: 13px; font-weight: 600; white-space: nowrap; text-overflow: ellipsis; }
.expert-card-badge { flex-shrink: 0; padding: 0 5px; border-radius: 4px; background: color-mix(in srgb, #e0b44a 16%, transparent); color: #e0b44a; font-size: 10px; font-weight: 500; line-height: 16px; }
.expert-card-facts .expert-card-status > i { display: inline-block; margin: 0 5px 1px 0; vertical-align: middle; width: 5px; height: 5px; border-radius: 50%; background: var(--ui-text-dimmed); }
.expert-card-facts .expert-card-status.is-ready > i { background: var(--ui-success, #3fb27f); }
.expert-card-facts .expert-card-status.is-warn > i { background: var(--ui-warning, #e0a33a); }
.expert-card-facts { display: grid; gap: 4px; width: 100%; margin: 0; padding-top: 10px; border-top: 1px solid var(--ui-border-muted); font-size: 11px; }
.expert-card-facts > div { display: grid; grid-template-columns: 26px minmax(0, 1fr); gap: 8px; }
.expert-card-facts dt { color: var(--ui-text-dimmed); }
.expert-card-facts dd { overflow: hidden; margin: 0; color: var(--ui-text-toned); white-space: nowrap; text-overflow: ellipsis; }
.expert-card-flip { position: absolute; right: 8px; bottom: 8px; display: inline-flex; align-items: center; gap: 4px; min-height: 22px; padding: 2px 6px; border-radius: 4px; color: var(--ui-text-dimmed); font-size: 11px; }
.expert-card-flip > span { width: 12px; height: 12px; }
.expert-card-open:hover .expert-card-flip, .expert-card-flip.is-done { color: var(--channel-accent); }
.expert-card-flip.is-done:hover, .expert-card-flip.is-cancel:hover { background: var(--ui-bg-accented); }
.expert-card-flip-actions { display: flex; flex-shrink: 0; justify-content: flex-end; gap: 2px; margin-right: -4px; }
.expert-card-flip-actions > .expert-card-flip { position: static; }
.expert-card-flip.is-cancel:hover { color: var(--ui-text-highlighted); }
.expert-card-tools { position: absolute; top: 9px; right: 8px; display: flex; gap: 2px; }
.expert-card-tools > button { display: grid; place-items: center; width: 24px; height: 24px; border-radius: 5px; color: var(--ui-text-dimmed); }
.expert-card-tools > button > span { width: 13px; height: 13px; }
.expert-card-tools > button:hover { background: var(--ui-bg-accented); color: var(--ui-text-highlighted); }
.expert-card-tools > .expert-card-host[aria-pressed="true"] { color: #e0b44a; }
.expert-card-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.expert-card-heading strong { display: flex; align-items: baseline; gap: 6px; min-width: 0; overflow: hidden; color: var(--ui-text-highlighted); font-size: 12px; font-weight: 600; white-space: nowrap; }
.expert-card-heading strong > span { font-size: 10px; font-weight: 400; color: var(--ui-text-muted); }
.expert-card-modes { display: flex; gap: 3px; padding: 3px; border-radius: 5px; background: var(--ui-bg-muted); }
.expert-card-modes button { flex: 1; min-height: 22px; border-radius: 4px; color: var(--ui-text-muted); font-size: 11px; }
.expert-card-modes button[aria-checked="true"] { background: var(--ui-bg-elevated); color: var(--ui-text-highlighted); box-shadow: var(--channel-shadow-control); }
.expert-card-field { display: grid; grid-template-columns: 26px minmax(0, 1fr); align-items: center; gap: 8px; color: var(--ui-text-dimmed); font-size: 11px; }
.expert-card-catalog { display: flex; align-items: baseline; gap: 8px; margin: -5px 0 0 34px; color: var(--ui-text-dimmed); font-size: 10px; overflow-wrap: anywhere; }
.expert-card-catalog > span { flex: 1; }
.expert-card-catalog > button { flex-shrink: 0; color: var(--channel-accent); }
.expert-card-defaults { position: absolute; left: 8px; bottom: 8px; min-height: 22px; padding: 2px 4px; border-radius: 4px; color: var(--ui-text-muted); font-size: 11px; }
.expert-card-defaults:hover:not(:disabled) { color: var(--channel-accent); }
.expert-card-defaults:disabled { opacity: .4; }
.expert-card-note { display: flex; gap: 6px; margin: 0; color: var(--ui-text-muted); font-size: 11px; line-height: 1.7; }
.expert-card-note > span { flex-shrink: 0; width: 13px; height: 13px; margin-top: 3px; }
@media (pointer: coarse) {
  .expert-card-flip, .expert-card-defaults, .expert-card-tools > button { min-width: 44px; min-height: 44px; }
  .expert-card-turn { height: 244px; }
  .expert-card-tools { top: 4px; right: 4px; }
  .expert-card-identity { padding-right: 92px; }
  .expert-card-modes button { min-height: 44px; }
}
</style>

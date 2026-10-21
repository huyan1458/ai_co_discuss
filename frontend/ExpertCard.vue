<script setup>
/** Show one participant instance and its actual software configuration boundary. */
import { computed, inject, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { motion, useReducedMotion, useSpring } from "motion-v";
import EffortSlider from "./EffortSlider.vue";

const props = defineProps({
  name: { type: String, required: true },
  mode: { type: String, default: "" },
  automatic: Boolean,
  status: { type: Object, required: true },
});
const emit = defineEmits(["remove", "mode"]);
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
const entry_label = computed(() => props.mode === "online" ? "网页" : !props.automatic ? "本地 App / CLI"
  : entry_items.value.find((item) => item.value === profile.value.adapter)?.label || "待选择 App / CLI");
const can_flip = computed(() => entry_items.value.length > 0);
const card_label = computed(() => props.mode === "online" ? `设置 ${props.name} 的参与方式` : `配置 ${props.name} 的本地软件`);
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
function flip(next) {
  if (next && !can_flip.value) return;
  card.value?.focus({ preventScroll: true });
  back.value = next;
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

/** Escape closes this face before it can close the surrounding create dialog. */
function escape(event) {
  if (!back.value) return;
  event.stopPropagation();
  event.preventDefault();
  flip(false);
}

watch([back, reduced_motion], ([next, reduced]) => {
  const target = next ? BACK_ANGLE : 0;
  if (reduced) { angle.jump(target); focus_face(); }
  else angle.set(target);
});
watch(() => [back.value, configurable.value, view.value.launch.available, profile.value.adapter],
  ([opened, enabled, available]) => { if (opened && enabled && available) bridge.load_launch_models(props.name); });
onBeforeUnmount(() => { stop_observing(); stop_settling(); angle.stop(); });
</script>

<template>
  <div ref="card" class="expert-card" :class="{ 'is-configurable': configurable }"
    :data-identity="bridge.identities[name]?.style" :data-face="visible_back ? 'back' : 'front'" tabindex="-1" @keydown.esc="escape">
    <motion.div class="expert-card-turn" :style="{ rotateY: angle }">
      <div class="expert-card-face expert-card-front" :inert="visible_back" :aria-hidden="visible_back">
        <component :is="can_flip ? 'button' : 'div'" ref="front_button" :type="can_flip ? 'button' : undefined" class="expert-card-open" :class="{ 'is-static': !can_flip }"
          :aria-label="can_flip ? card_label : undefined" :title="can_flip ? '点击翻面查看配置' : undefined" @click="flip(true)">
          <span class="expert-card-identity">
            <UAvatar :src="bridge.identities[name]?.icon" :text="bridge.identities[name]?.initials" :alt="name" size="sm" class="channel-avatar expert-card-avatar" :class="bridge.identities[name]?.style" />
            <strong>{{ name }}</strong>
          </span>
          <span class="expert-card-status" :class="`is-${status.tone}`" :title="status.text"><i aria-hidden="true" /><span>{{ status.text }}</span></span>
          <span class="expert-card-entry">{{ entry_label }}<span>{{ automatic ? '程序唤醒' : '手动接入' }}</span></span>
          <span class="expert-card-summary">
            <span class="expert-card-model">{{ configurable ? profile.model || '默认模型' : mode === 'online' ? '模型与强度在原网页设置' : '模型在原软件设置' }}</span>
            <span class="expert-card-strength">{{ configurable ? effort_label : mode === 'online' ? '在线只读 · 由人代发' : '本地读写 · 自行提交' }}</span>
            <UIcon v-if="can_flip" name="i-lucide-settings-2" class="expert-card-chevron" />
          </span>
        </component>
        <button type="button" class="expert-card-remove" :aria-label="`移出 ${name}`" @click="emit('remove')"><UIcon name="i-lucide-x" /></button>
      </div>
      <div v-if="can_flip" class="expert-card-face expert-card-back" :inert="!visible_back" :aria-hidden="!visible_back">
        <div class="expert-card-heading"><strong>{{ name }}<span>实例设置</span></strong>
          <span class="expert-card-actions">
            <button ref="back_button" type="button" class="expert-card-return" :aria-label="`返回 ${name} 角色卡片`" @click="flip(false)"><UIcon name="i-lucide-arrow-left" />返回</button>
          </span>
        </div>
        <div v-if="!automatic" class="expert-card-modes" role="radiogroup" :aria-label="`${name} 参与能力`" @keydown="choose_capability">
          <button v-for="option in [{ value: 'cli', label: '本地读写' }, { value: 'online', label: '在线只读' }]" :key="option.value" type="button"
            role="radio" :aria-checked="mode === option.value" :tabindex="mode === option.value ? 0 : -1" :data-mode="option.value" @click="emit('mode', option.value)">{{ option.label }}</button>
        </div>
        <div v-if="automatic && mode === 'cli' && entry_items.length" class="expert-card-software">
          <span>软件入口</span><USelect :model-value="profile.adapter || ''" :items="entry_items" placeholder="选择 App / CLI" :aria-label="`${name} 软件入口`" size="xs" @update:model-value="bridge.write_launch(name, 'adapter', $event)" />
        </div>
        <template v-if="configurable">
          <UFormField label="模型" class="expert-card-model-field"><USelect :model-value="profile.model || '__default__'" :items="models.items" :loading="models.loading" :aria-label="`${name} 使用的模型`" size="sm" class="w-full" @update:model-value="bridge.write_launch_model(name, $event)" /></UFormField>
          <div class="expert-card-catalog"><span>{{ models.loading ? '正在读取软件模型列表…' : models.error || models.source }}</span><button v-if="!models.loading && models.error && view.launch.available" type="button" @click="bridge.load_launch_models(name, true)">重试</button></div>
          <div v-if="effort_items" class="expert-card-effort">
            <div><span>思考强度</span><strong>{{ effort_label }}</strong></div>
            <EffortSlider :items="effort_items" :model-value="profile.effort || ''" :label="`${name} 的思考强度`" @update:model-value="bridge.write_launch(name, 'effort', $event)" />
            <div class="expert-card-scale" aria-hidden="true"><span>默认</span><span>{{ effort_items.at(-1).label }}</span></div>
          </div>
          <p v-else class="expert-card-note">{{ models.effort_note }}</p>
          <div class="expert-card-defaults"><span>默认值由 CLI 决定</span><button type="button" :aria-label="`恢复 ${name} 的默认模型与强度`" :disabled="!profile.model && !profile.effort" @click="reset_model">恢复默认</button></div>
        </template>
        <div v-else class="expert-card-boundary"><UIcon :name="mode === 'online' ? 'i-lucide-globe' : 'i-lucide-monitor'" /><strong>在原软件选择模型</strong><p>{{ configuration_note }}</p></div>
      </div>
    </motion.div>
  </div>
</template>

<style scoped>
.expert-card { min-width: 0; perspective: 900px; outline: none; }
.expert-card-turn { display: grid; transform-style: preserve-3d; }
.expert-card-face { grid-area: 1 / 1; min-width: 0; min-height: 258px; border: 1px solid var(--channel-edge-control, var(--ui-border)); border-radius: 8px; background: color-mix(in srgb, var(--ui-bg-elevated) 45%, var(--ui-bg)); box-shadow: var(--channel-shadow-control); backface-visibility: hidden; }
.expert-card-front { position: relative; display: flex; }
.expert-card-back { display: flex; flex-direction: column; gap: 12px; padding: 14px 16px; transform: rotateY(180deg); }
.expert-card:hover .expert-card-face { border-color: var(--ui-border-accented); }
.expert-card-open { display: flex; flex: 1; flex-direction: column; gap: 14px; width: 100%; min-width: 0; padding: 18px; text-align: left; border-radius: inherit; outline: none; }
.expert-card-open.is-static { cursor: default; }
.expert-card-identity { display: flex; align-items: center; gap: 10px; min-width: 0; min-height: 36px; padding-right: 22px; }
.expert-card-avatar { width: 36px; height: 36px; font-size: 12px; }
.expert-card-identity strong, .expert-card-heading strong { overflow: hidden; color: var(--ui-text-highlighted); font-size: 14px; font-weight: 600; white-space: nowrap; text-overflow: ellipsis; }
.expert-card-status { display: flex; align-items: center; gap: 6px; min-width: 0; color: var(--ui-text-muted); font-size: 12px; }
.expert-card-status > span { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.expert-card-status > i { flex-shrink: 0; width: 5px; height: 5px; border-radius: 50%; background: var(--ui-text-dimmed); }
.expert-card-status.is-ready > i { background: var(--ui-success, #3fb27f); }
.expert-card-status.is-warn > i { background: var(--ui-warning, #e0a33a); }
.expert-card-entry { display: flex; flex-wrap: wrap; gap: 5px 8px; color: var(--ui-text-toned); font-size: 12px; }
.expert-card-entry > span { color: var(--ui-text-muted); }
.expert-card-remove { position: absolute; top: 16px; right: 10px; display: grid; place-items: center; width: 28px; height: 28px; border-radius: 5px; color: var(--ui-text-dimmed); }
.expert-card-remove > span { width: 14px; height: 14px; }
.expert-card-remove:hover { background: var(--ui-bg-accented); color: var(--ui-text-highlighted); }
.expert-card-summary { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 4px 8px; width: 100%; margin-top: auto; padding-top: 14px; border-top: 1px solid var(--ui-border-muted); }
.expert-card-model { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--ui-text-toned); font-size: 13px; }
.expert-card-strength { grid-row: 2; color: var(--ui-text-muted); font-size: 11px; }
.expert-card-chevron { grid-column: 2; grid-row: 1 / 3; width: 15px; height: 15px; color: var(--ui-text-muted); }
.expert-card-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.expert-card-heading strong { display: flex; align-items: baseline; gap: 7px; font-size: 12px; }
.expert-card-heading strong > span { font-size: 10px; font-weight: 400; color: var(--ui-text-muted); }
.expert-card-return { display: inline-flex; align-items: center; gap: 4px; min-height: 26px; padding: 3px 4px; border-radius: 4px; color: var(--ui-text-muted); font-size: 11px; }
.expert-card-return > span { width: 12px; height: 12px; }
.expert-card-return:hover { color: var(--ui-text-highlighted); background: var(--ui-bg-accented); }
.expert-card-modes { display: flex; gap: 3px; padding: 3px; border-radius: 5px; background: var(--ui-bg-muted); }
.expert-card-modes button { flex: 1; min-height: 28px; border-radius: 4px; color: var(--ui-text-muted); font-size: 11px; }
.expert-card-modes button[aria-checked="true"] { background: var(--ui-bg-elevated); color: var(--ui-text-highlighted); box-shadow: var(--channel-shadow-control); }
.expert-card-software { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--ui-text-muted); font-size: 11px; }
.expert-card-software > button { max-width: 72%; }
.expert-card-model-field :deep(label) { color: var(--ui-text-muted); font-size: 11px; }
.expert-card-catalog { display: flex; align-items: baseline; gap: 8px; margin-top: -6px; color: var(--ui-text-muted); font-size: 10px; overflow-wrap: anywhere; }
.expert-card-catalog > span { flex: 1; }
.expert-card-catalog > button { flex-shrink: 0; }
.expert-card-effort > div { display: flex; align-items: center; justify-content: space-between; color: var(--ui-text-muted); font-size: 11px; }
.expert-card-effort strong { color: var(--channel-accent); font-size: 12px; font-weight: 600; }
.expert-card-effort > .expert-card-scale { color: var(--ui-text-dimmed); font-size: 10px; }
.expert-card-defaults { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 4px; margin-top: auto; color: var(--ui-text-dimmed); font-size: 10px; }
.expert-card-defaults > button { min-height: 24px; color: var(--ui-text-muted); font-size: 11px; }
.expert-card-defaults > button:hover:not(:disabled) { color: var(--channel-accent); }
.expert-card-defaults > button:disabled { opacity: .4; }
.expert-card-note { margin: 0; color: var(--ui-text-muted); font-size: 11px; }
.expert-card-boundary { display: flex; flex: 1; flex-direction: column; align-items: flex-start; justify-content: center; gap: 10px; padding: 8px 0; }
.expert-card-boundary > span { width: 22px; height: 22px; color: var(--ui-text-muted); }
.expert-card-boundary > strong { color: var(--ui-text-highlighted); font-size: 13px; font-weight: 500; }
.expert-card-boundary > p { margin: 0; color: var(--ui-text-muted); font-size: 12px; line-height: 1.8; }
@media (pointer: coarse) {
  .expert-card-return, .expert-card-remove { min-width: 44px; min-height: 44px; }
  .expert-card-remove { top: 10px; right: 4px; }
  .expert-card-identity { padding-right: 32px; }
  .expert-card-modes button, .expert-card-defaults > button { min-height: 44px; }
}
</style>

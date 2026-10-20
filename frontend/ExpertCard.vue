<script setup>
/** Show an admitted expert; the front opens its CLI configuration on the reverse. */
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
const model_open = ref(false);
const model_button = ref(null), model_editor = ref(null);
const profile = computed(() => view.value.launch.profiles[props.name] || {});
const model_hint = computed(() => bridge.launch_model_hints[profile.value.adapter]);
const configurable = computed(() => Boolean(props.automatic && props.mode && model_hint.value));
const effort_items = computed(() => {
  const levels = bridge.launch_effort_levels[profile.value.adapter];
  const labels = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra High", max: "Max", ultra: "Ultra" };
  return levels ? [{ label: "默认强度", value: "" }, ...levels.map((level) => ({ label: labels[level] || level, value: level }))] : null;
});
const effort_label = computed(() => effort_items.value?.find((item) => item.value === (profile.value.effort || ""))?.label || (effort_items.value ? profile.value.effort : "强度随模型"));

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
  card.value?.focus({ preventScroll: true });
  model_open.value = false;
  back.value = next;
}

/** Return from model editing before closing the configuration face. */
function return_back() {
  if (model_open.value) model_open.value = false;
  else flip(false);
}

/** Restore the CLI defaults for this participant only. */
function reset_model() {
  bridge.write_launch(props.name, "model", "");
  if (effort_items.value) bridge.write_launch(props.name, "effort", "");
}

/** Escape closes this face before it can close the surrounding create dialog. */
function escape(event) {
  if (!back.value) return;
  event.stopPropagation();
  event.preventDefault();
  return_back();
}

watch([back, configurable, reduced_motion], ([next, available, reduced]) => {
  if (!available) back.value = false;
  const target = next && available ? BACK_ANGLE : 0;
  if (reduced || !available) { angle.jump(target); focus_face(); }
  else angle.set(target);
});
watch(model_open, () => nextTick(() => {
  if (!back.value || !visible_back.value) return;
  const target = model_open.value ? model_editor.value?.querySelector("input") : model_button.value;
  target?.focus({ preventScroll: true });
}));
onBeforeUnmount(() => { stop_observing(); stop_settling(); angle.stop(); });
</script>

<template>
  <div ref="card" class="expert-card" :class="{ 'is-configurable': configurable }"
    :data-identity="bridge.identities[name]?.style" :data-face="visible_back ? 'back' : 'front'" tabindex="-1" @keydown.esc="escape">
    <motion.div class="expert-card-turn" :style="{ rotateY: angle }">
      <div class="expert-card-face expert-card-front" :inert="visible_back" :aria-hidden="visible_back">
        <component :is="configurable ? 'button' : 'div'" key="front-open" ref="front_button" :type="configurable ? 'button' : undefined" class="expert-card-open"
          :tabindex="configurable ? undefined : -1" :aria-label="configurable ? `配置 ${name} 的模型与思考强度` : undefined"
          :title="configurable ? '点击卡片配置模型与思考强度' : undefined" @click="configurable && flip(true)">
          <span class="expert-card-identity">
            <UAvatar :src="bridge.identities[name]?.icon" :text="bridge.identities[name]?.initials" :alt="name" size="sm" class="channel-avatar expert-card-avatar" :class="bridge.identities[name]?.style" />
            <strong>{{ name }}</strong>
          </span>
          <span class="expert-card-status" :class="`is-${status.tone}`" :title="status.text"><i aria-hidden="true" /><span>{{ status.text }}</span></span>
          <span v-if="configurable" class="expert-card-summary">
            <span :title="`模型：${profile.model || 'CLI 默认模型'} · 思考强度：${effort_label}`">
              <span class="expert-card-model">{{ profile.model || "默认模型" }}</span>
              <span class="expert-card-strength">{{ effort_label }}</span>
              <UIcon name="i-lucide-chevron-down" class="expert-card-chevron" />
            </span>
          </span>
        </component>
        <button key="remove" type="button" class="expert-card-remove" :aria-label="`将 ${name} 移出讨论`" @click="emit('remove')">移出</button>
        <div v-if="mode && !automatic" class="expert-card-modes" role="radiogroup" :aria-label="`${name} 参与方式`">
          <button v-for="option in [{ value: 'cli', label: '本地读写' }, { value: 'online', label: '在线只读' }]" :key="option.value" type="button"
            role="radio" :aria-checked="mode === option.value" @click="emit('mode', option.value)">{{ option.label }}</button>
        </div>
      </div>
      <div v-if="configurable" class="expert-card-face expert-card-back" :inert="!visible_back" :aria-hidden="!visible_back">
        <div class="expert-card-heading"><strong><UIcon name="i-lucide-zap" />{{ name }}</strong>
          <span class="expert-card-actions">
            <button v-if="!model_open" type="button" class="expert-card-reset" :aria-label="`恢复 ${name} 的默认模型与强度`" title="恢复默认" :disabled="!profile.model && !profile.effort" @click="reset_model"><UIcon name="i-lucide-rotate-ccw" /></button>
            <button ref="back_button" type="button" class="expert-card-return" :aria-label="model_open ? `返回 ${name} 强度设置` : `返回 ${name} 角色卡片`" @click="return_back">返回</button>
          </span>
        </div>
        <template v-if="model_open">
          <div ref="model_editor"><UFormField label="模型 ID"><UInput :model-value="profile.model || ''" :placeholder="model_hint.example" :title="model_hint.help" :aria-label="`${name} 使用的模型`" size="sm" class="w-full" @update:model-value="bridge.write_launch(name, 'model', $event)" /></UFormField></div>
          <button type="button" class="expert-card-default" @click="bridge.write_launch(name, 'model', '')">使用 CLI 默认模型<UIcon v-if="!profile.model" name="i-lucide-check" /></button>
          <p class="expert-card-note">{{ effort_items ? "填写当前客户端支持的模型 ID" : "思考强度包含在模型 ID 中" }}</p>
        </template>
        <template v-else>
          <button ref="model_button" type="button" class="expert-card-selector" :aria-label="`选择 ${name} 的模型，当前${profile.model || '默认模型'}`" @click="model_open = true">
            <strong>{{ effort_label }}</strong>
            <span><span :title="profile.model || 'CLI 默认模型'">{{ profile.model || "默认模型" }}</span><UIcon name="i-lucide-chevron-right" /></span>
          </button>
          <EffortSlider v-if="effort_items" :items="effort_items" :model-value="profile.effort || ''" :label="`${name} 的思考强度`" @update:model-value="bridge.write_launch(name, 'effort', $event)" />
          <p v-else class="expert-card-note expert-card-note-center">思考强度包含在模型 ID 中</p>
        </template>
      </div>
    </motion.div>
  </div>
</template>

<style scoped>
.expert-card { min-width: 0; perspective: 900px; outline: none; }
.expert-card-turn { display: grid; transform-style: preserve-3d; }
.expert-card-face { grid-area: 1 / 1; min-width: 0; min-height: 140px; border: 1px solid var(--channel-edge-control, var(--ui-border)); border-radius: 8px; background: color-mix(in srgb, var(--ui-bg-elevated) 55%, var(--ui-bg)); box-shadow: var(--channel-shadow-control); backface-visibility: hidden; }
.expert-card.is-configurable .expert-card-face { min-height: 176px; }
.expert-card-front { position: relative; display: flex; flex-direction: column; }
.expert-card-back { display: flex; flex-direction: column; gap: 9px; padding: 10px 12px; transform: rotateY(180deg); }
.expert-card:hover .expert-card-face { border-color: var(--ui-border-accented); }
.expert-card[data-face="back"] .expert-card-back { border-color: color-mix(in srgb, var(--channel-accent) 55%, var(--ui-border)); }
.expert-card-open { display: flex; flex: 1; flex-direction: column; gap: 10px; width: 100%; padding: 14px; text-align: left; border-radius: inherit; outline: none; }
.expert-card-identity { display: flex; align-items: center; gap: 9px; min-width: 0; min-height: 32px; padding-right: 30px; }
.expert-card-avatar { width: 32px; height: 32px; font-size: 12px; }
.expert-card-identity strong, .expert-card-heading strong { overflow: hidden; color: var(--ui-text-highlighted); font-size: 13px; font-weight: 600; white-space: nowrap; text-overflow: ellipsis; }
.expert-card-status { display: flex; align-items: center; gap: 6px; min-width: 0; color: var(--ui-text-muted); font-size: 11px; }
.expert-card-status > span { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.expert-card-status > i { flex-shrink: 0; width: 5px; height: 5px; border-radius: 50%; background: var(--ui-text-dimmed); }
.expert-card-status.is-ready > i { background: var(--ui-success, #3fb27f); }
.expert-card-status.is-warn > i { background: var(--ui-warning, #e0a33a); }
.expert-card-remove { position: absolute; top: 15px; right: 8px; min-width: 34px; min-height: 28px; padding: 4px; border-radius: 5px; color: var(--ui-text-dimmed); font-size: 11px; }
.expert-card-remove:hover { background: var(--ui-bg-accented); color: var(--ui-text-highlighted); }
.expert-card-modes { display: grid; grid-template-columns: 1fr 1fr; gap: 2px; margin: 0 12px 12px; padding: 3px; border: 1px solid var(--ui-border-muted); border-radius: 6px; background: var(--ui-bg-muted); }
.expert-card-modes button { padding: 4px 0; border-radius: 4px; color: var(--ui-text-muted); font-size: 11px; }
.expert-card-modes button[aria-checked="true"] { background: var(--ui-bg-elevated); color: var(--ui-text-highlighted); box-shadow: var(--channel-shadow-control); }
.expert-card-summary { width: 100%; min-width: 0; margin-top: auto; padding-top: 11px; border-top: 1px solid var(--ui-border-muted); }
.expert-card-summary > span { display: flex; align-items: center; gap: 6px; min-width: 0; color: var(--ui-text-toned); font-size: 12px; line-height: 20px; }
.expert-card-model { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.expert-card-strength { flex-shrink: 0; color: var(--ui-text-muted); font-size: 11px; }
.expert-card-chevron { flex-shrink: 0; width: 12px; height: 12px; margin-left: auto; color: var(--ui-text-dimmed); }
.expert-card-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.expert-card-heading strong { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--ui-text-muted); }
.expert-card-heading strong > span { width: 15px; height: 15px; }
.expert-card-actions { display: flex; align-items: center; gap: 4px; }
.expert-card-reset { display: grid; place-items: center; width: 26px; height: 26px; border-radius: 5px; color: var(--ui-text-muted); }
.expert-card-reset:hover:not(:disabled) { background: var(--ui-bg-accented); color: var(--ui-text-highlighted); }
.expert-card-reset:disabled { opacity: .3; cursor: default; }
.expert-card-return { flex-shrink: 0; min-width: 32px; min-height: 26px; padding: 3px 4px; border-radius: 5px; color: var(--ui-text-muted); font-size: 11px; }
.expert-card-return:hover { color: var(--ui-text-highlighted); background: var(--ui-bg-accented); }
.expert-card-selector { display: flex; flex: 1; flex-direction: column; align-items: center; justify-content: center; align-self: center; gap: 3px; width: max-content; max-width: 100%; min-height: 62px; padding: 8px 13px; border-radius: 8px; background: var(--ui-bg-muted); }
.expert-card-selector:hover { background: var(--ui-bg-accented); }
.expert-card-selector > strong { font-size: 18px; line-height: 24px; font-weight: 650; color: var(--channel-accent); }
.expert-card-selector > span { display: flex; align-items: center; gap: 4px; max-width: 100%; color: var(--ui-text-muted); font-size: 11px; }
.expert-card-selector > span > span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.expert-card-selector > span > span:last-child { flex-shrink: 0; width: 12px; height: 12px; }
.expert-card-default { display: flex; align-items: center; justify-content: space-between; min-height: 28px; color: var(--ui-text-toned); font-size: 12px; }
.expert-card-note { margin: 0; color: var(--ui-text-dimmed); font-size: 11px; }
.expert-card-note-center { margin: 5px 0; text-align: center; }
.expert-card button:focus-visible { outline: 2px solid var(--channel-accent); outline-offset: 2px; }
@media (pointer: coarse) {
  .expert-card-return, .expert-card-remove { width: 44px; height: 44px; }
  .expert-card-remove { top: 8px; right: 5px; }
  .expert-card-identity { padding-right: 36px; }
  .expert-card-modes button { min-height: 38px; }
}
</style>

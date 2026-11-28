<script setup>
/**
 * Model and strength for one member, the controls on the back of an expert card (#15717): the software's model list
 * with its refresh, the list's loading or error line with 重试, the strength slider (or the note on why there is
 * none) and 恢复默认. Shared by `ExpertCard.vue` and MOSS's software choice, so both read and refresh models the same way.
 *
 * Props: `name` is the member or platform name the catalog is kept under; `profile` the effective launch profile
 * (adapter, executable, model, effort); `portable` marks a card written into a preset rather than this computer's
 * launch settings (a workflow card, MOSS), which offers its profile's strength levels without a catalog.
 * Emits `model` with the chosen value (`__default__` for the software's own), `effort` with a level or "", and `reset`.
 * Its root takes no box (`display: contents`), so it sits in the card's own layout.
 */
import { computed, inject, watch } from "vue";
import { adapter_profile } from "../runner/adapters/profiles.mjs";
import EffortSlider from "./EffortSlider.vue";
import ModelRefresh from "./ModelRefresh.vue";
import { t } from "./i18n.js";

const props = defineProps({ name: { type: String, required: true }, profile: { type: Object, required: true }, portable: Boolean });
const emit = defineEmits(["model", "effort", "reset"]);
const { view, bridge } = inject("discussion");

const models = computed(() => bridge.launch_model_state(props.name, view.value.launch, props.profile));
// A portable card for software that lists no models (a model API) takes the model typed in.
const model_input = computed(() => props.portable && !adapter_profile(props.profile.adapter)?.models);
const EFFORT_LABELS = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra High", max: "Max", ultra: "Ultra" };
const effort_items = computed(() => {
  // A portable card or a software that lists no models (a model API) offers the levels its profile declares.
  const facts = adapter_profile(props.profile.adapter);
  const levels = models.value.efforts || (props.portable || !facts?.models ? facts?.efforts : null);
  return levels?.length ? [{ label: t('默认强度'), value: "" }, ...levels.map((level) => ({ label: EFFORT_LABELS[level] || level, value: level }))] : null;
});

/** Read a catalog with this member's effective profile without saving it to room settings. */
function load_models(force = false) {
  return bridge.load_launch_models(props.name, force, props.profile);
}
// The list is read as soon as the software is known (the card also reads it ahead of being turned over; reads share one request).
watch(() => [view.value.launch.available, props.profile.adapter], ([available, adapter]) => { if (available && adapter) load_models(); }, { immediate: true });
defineExpose({ load_models, models });
</script>

<template>
  <div class="model-effort-picker">
    <div class="expert-card-field">
      <span>{{ t('模型') }}</span>
      <UInput v-if="model_input" :model-value="profile.model || ''" :placeholder="t('留空使用默认模型')" :aria-label="t('{value1} 使用的模型', { value1: name })" size="xs" class="w-full" @update:model-value="emit('model', $event)" />
      <div v-else class="model-picker"><USelect :model-value="profile.model || '__default__'" :items="models.items" :title="models.source" :ui="{ base: 'model-select', content: 'model-select-menu' }" :aria-label="t('{value1} 使用的模型', { value1: name })" size="xs" class="w-full" @update:model-value="emit('model', $event)" /><ModelRefresh :loading="models.refreshing" :disabled="!view.launch.available" @refresh="load_models(true)" /></div>
    </div>
    <div class="expert-card-catalog model-catalog-slot">
      <span :title="models.error">{{ models.loading ? t('正在读取软件模型列表…') : models.error }}</span>
      <button type="button" :class="{ invisible: models.loading || !models.error || !view.launch.available }"
        :disabled="models.loading || !models.error || !view.launch.available" @click="load_models(true)">{{ t('重试') }}</button>
    </div>
    <div class="expert-card-effort model-effort-slot">
      <EffortSlider v-if="effort_items" :caption="t('强度')" :items="effort_items" :model-value="profile.effort || ''" :label="t('{value1} 的思考强度', { value1: name })" @update:model-value="emit('effort', $event)" />
      <p v-else class="model-effort-note" :title="models.effort_note">{{ models.effort_note }}</p>
    </div>
    <button type="button" class="expert-card-defaults" :title="t('留空使用 CLI 默认值')" :aria-label="t('恢复 {value1} 的默认模型与强度', { value1: name })" :disabled="!profile.model && !profile.effort" @click="emit('reset')">{{ t('恢复默认') }}</button>
  </div>
</template>

<style scoped>
.model-effort-picker { display: contents; }
.model-catalog-slot { display: flex; align-items: center; gap: 8px; block-size: 1.5em; }
.model-catalog-slot > span { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.model-effort-slot { display: grid; align-items: center; min-width: 0; block-size: 48px; }
.model-effort-note { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; margin: 0; color: var(--ui-text-muted); font-size: 11px; line-height: 1.6; }
</style>

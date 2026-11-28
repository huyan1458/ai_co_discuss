<script setup>
/**
 * The turning frame of an invite card that is not a room AI (external expert, external user), laid out as a member
 * card (ExpertCard.vue) and turned by CSS: the front shows who is invited and a few facts, "设置" turns to the back for
 * the choices, "完成" keeps them and "取消" (or Esc) asks the parent to restore what it saved on `open`.
 *
 * Props: `label` (the front button's accessible name), `title`, `subtitle`, `icon` (avatar image), `facts`
 * (`[{ label, value, tone?, dot?, title? }]`). Emits `remove`, `open` (before turning to the back), `cancel`.
 * Slot `back`: the back's fields, under a heading of `title` + "设置".
 */
import { ref } from "vue";
import { t } from "./i18n.js";

const props = defineProps({
  label: { type: String, required: true }, title: { type: String, required: true }, subtitle: { type: String, default: "" },
  icon: { type: String, required: true }, facts: { type: Array, default: () => [] },
});
const emit = defineEmits(["remove", "open", "cancel"]);
const back = ref(false);
function open_back() { emit("open"); back.value = true; }
function cancel() { emit("cancel"); back.value = false; }
function escape(event) {
  if (!back.value) return;
  event.stopPropagation();
  event.preventDefault();
  cancel();
}
</script>

<template>
  <div class="expert-card" :data-face="back ? 'back' : 'front'" @keydown.esc="escape">
    <div class="expert-card-turn">
      <div class="expert-card-face expert-card-front" :inert="back" :aria-hidden="back">
        <button type="button" class="expert-card-open" :aria-label="props.label" :title="t('点击翻面设置')" @click="open_back">
          <span class="expert-card-identity">
            <span class="expert-card-avatar channel-avatar external" aria-hidden="true"><img :src="props.icon" alt="" /></span>
            <span class="expert-card-names"><span><strong>{{ props.title }}</strong></span><small :title="props.subtitle">{{ props.subtitle }}</small></span>
          </span>
          <dl class="expert-card-facts">
            <div v-for="fact in props.facts" :key="fact.label"><dt>{{ fact.label }}</dt><dd :class="fact.tone ? ['expert-card-status', `is-${fact.tone}`] : ''" :title="fact.title || fact.value"><i v-if="fact.dot" aria-hidden="true" />{{ fact.value }}</dd></div>
          </dl>
          <span class="expert-card-flip is-open"><UIcon name="i-lucide-settings-2" /><span>{{ t("设置") }}</span></span>
        </button>
        <span class="expert-card-tools">
          <button type="button" :aria-label="t('移除这张卡片')" :title="t('移出')" @click="emit('remove')"><UIcon name="i-lucide-x" /></button>
        </span>
      </div>
      <div class="expert-card-face expert-card-back" :inert="!back" :aria-hidden="!back">
        <div class="expert-card-back-body">
          <div class="expert-card-heading"><strong>{{ props.title }}<span>{{ t("设置") }}</span></strong></div>
          <slot name="back" />
        </div>
        <span class="expert-card-flip-actions">
          <button type="button" class="expert-card-flip is-cancel" @click="cancel">{{ t("取消") }}</button>
          <button type="button" class="expert-card-flip is-done" @click="back = false"><UIcon name="i-lucide-check" />{{ t("完成") }}</button>
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* The member card's frame and faces (ExpertCard.vue), turned by CSS instead of a spring. */
.expert-card { min-width: 0; perspective: 900px; outline: none; container-type: inline-size; }
.expert-card-turn { display: grid; grid-template: minmax(0, 1fr) / minmax(0, 1fr); height: 100cqi; transform-style: preserve-3d; transition: transform .45s ease; }
.expert-card[data-face="back"] .expert-card-turn { transform: rotateY(180deg); }
.expert-card-face { grid-area: 1 / 1; min-width: 0; min-height: 0; border: 1px solid var(--channel-edge-control, var(--ui-border)); border-radius: 8px; background: color-mix(in srgb, var(--ui-bg-elevated) 45%, var(--ui-bg)); box-shadow: var(--channel-shadow-control); backface-visibility: hidden; }
.expert-card:hover .expert-card-face { border-color: var(--ui-border-accented); }
.expert-card-front { position: relative; display: flex; flex-direction: column; }
.expert-card-back { position: relative; display: flex; flex-direction: column; gap: 4px; padding: 10px 12px 8px; transform: rotateY(180deg); }
.expert-card-back-body { display: flex; flex: 1; flex-direction: column; gap: 10px; min-height: 0; padding: 2px; overflow-y: auto; scrollbar-width: thin; }
.expert-card-open { display: flex; flex: 1; flex-direction: column; gap: 10px; width: 100%; min-width: 0; padding: 12px 12px 48px; text-align: left; border-radius: inherit; outline: none; }
.expert-card-identity { display: flex; align-items: center; gap: 8px; min-width: 0; min-height: 26px; padding-right: 32px; }
.expert-card-avatar { display: grid; flex-shrink: 0; place-items: center; width: 26px; height: 26px; }
.expert-card-avatar > span { width: 14px; height: 14px; }
.expert-card-names { display: grid; min-width: 0; }
.expert-card-names > span { display: flex; align-items: center; gap: 8px; min-width: 0; }
.expert-card-names > small { overflow: hidden; color: var(--ui-text-muted); font-size: 11px; line-height: 16px; white-space: nowrap; text-overflow: ellipsis; }
.expert-card-identity strong { overflow: hidden; color: var(--ui-text-highlighted); font-size: 13px; font-weight: 600; white-space: nowrap; text-overflow: ellipsis; }
.expert-card-facts { display: grid; gap: 3px; width: 100%; margin: 0; padding-top: 8px; border-top: 1px solid var(--ui-border-muted); font-size: 11px; line-height: 16px; }
.expert-card-facts > div { display: grid; grid-template-columns: var(--flip-label, 3.5em) minmax(0, 1fr); gap: 8px; }
.expert-card-facts .is-warn { color: var(--ui-warning, #e0a33a); }
.expert-card-facts .is-danger { color: var(--ui-error); }
.expert-card-facts dt { color: var(--ui-text-dimmed); white-space: nowrap; }
.expert-card-facts dd { overflow: hidden; margin: 0; color: var(--ui-text-toned); white-space: nowrap; text-overflow: ellipsis; }
.expert-card-facts .expert-card-status > i { display: inline-block; margin: 0 5px 1px 0; vertical-align: middle; width: 5px; height: 5px; border-radius: 50%; background: var(--ui-warning, #e0a33a); }
.expert-card-flip { position: absolute; right: 8px; bottom: 8px; display: inline-flex; align-items: center; gap: 4px; min-height: 22px; padding: 2px 6px; border-radius: 4px; color: var(--ui-text-dimmed); font-size: 11px; }
.expert-card-flip > span { width: 12px; height: 12px; }
.expert-card-flip.is-open > span:last-child { width: auto; height: auto; }
.expert-card-flip.is-done { color: var(--channel-accent); }
.expert-card-flip.is-done:hover, .expert-card-flip.is-cancel:hover { background: var(--ui-bg-accented); }
.expert-card-flip.is-cancel:hover { color: var(--ui-text-highlighted); }
.expert-card-flip-actions { display: flex; flex-shrink: 0; justify-content: flex-end; gap: 2px; margin-right: -4px; }
.expert-card-flip-actions > .expert-card-flip { position: static; }
.expert-card-flip.is-open { right: 12px; bottom: 10px; min-height: 28px; padding: 0 10px; border-radius: 5px; background: var(--ui-bg-muted); color: var(--ui-text-toned); font-weight: 500; }
.expert-card-flip.is-open > span:first-child { color: var(--channel-accent); }
.expert-card-open:hover .expert-card-flip.is-open { background: var(--ui-bg-accented); color: var(--ui-text-highlighted); }
.expert-card-tools { position: absolute; top: 9px; right: 8px; display: flex; gap: 2px; }
.expert-card-tools > button { display: grid; place-items: center; width: 24px; height: 24px; border-radius: 5px; color: var(--ui-text-dimmed); }
.expert-card-tools > button > span { width: 13px; height: 13px; }
.expert-card-tools > button:hover { background: var(--ui-bg-accented); color: var(--ui-text-highlighted); }
.expert-card-heading strong { display: flex; align-items: baseline; gap: 6px; min-width: 0; overflow: hidden; color: var(--ui-text-highlighted); font-size: 12px; font-weight: 600; white-space: nowrap; }
.expert-card-heading strong > span { font-size: 10px; font-weight: 400; color: var(--ui-text-muted); }
/* The back's fields come from the slot: they share these classes without each card copying them. */
/* Two-character labels in Chinese; 3.5em leaves room for the English ones (Folders, Status); a card with longer
   English labels widens the column with --flip-label. */
.expert-card-back-body :slotted(.expert-card-field) { display: grid; grid-template-columns: var(--flip-label, 3.5em) minmax(0, 1fr); align-items: center; gap: 8px; color: var(--ui-text-dimmed); font-size: 11px; }
.expert-card-back-body :slotted(.expert-card-field.is-top) { align-items: start; }
.expert-card-back-body :slotted(.expert-card-hint) { margin: -4px 0 0 calc(var(--flip-label, 3.5em) + 8px); color: var(--ui-text-muted); font-size: 11px; line-height: 16px; }
.expert-card-back-body :slotted(.expert-card-hint.is-warn) { color: var(--ui-warning, #e0a33a); }
.expert-card-back-body :slotted(.expert-card-dirs) { display: flex; flex-direction: column; gap: 2px; min-width: 0; margin: 0; padding: 0; list-style: none; color: var(--ui-text-toned); }
.expert-card-back-body :slotted(.expert-card-dirs li) { display: flex; align-items: center; gap: 4px; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; line-height: 18px; }
.expert-card-back-body :slotted(.expert-card-field .expert-card-modes button) { padding: 0 6px; white-space: nowrap; }
.expert-card-back-body :slotted(.expert-card-empty) { margin: 0; color: var(--ui-text-muted); font-size: 11px; line-height: 20px; }
.expert-card-back-body :slotted(.expert-card-warning) { display: flex; gap: 6px; margin: auto 0 0; color: var(--ui-warning, #e0a33a); font-size: 11px; line-height: 16px; }
.expert-card-back-body :slotted(.expert-card-warning > :first-child) { flex: none; width: 12px; height: 12px; margin-top: 2px; }
@media (pointer: coarse) {
  .expert-card-tools > button { width: 32px; height: 32px; }
  .expert-card-flip-actions > .expert-card-flip { min-height: 32px; padding: 0 10px; }
}
/* Narrow card: the same extra line as a member card (ExpertCard.vue). */
@container (max-width: 220px) {
  .expert-card-turn { height: 272px; }
}
</style>

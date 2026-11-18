<script setup>
/**
 * An external expert to be invited (new-room panel, invite dialog), laid out as a member card (ExpertCard.vue): the
 * front sums up the choices, 设置 turns to the back to edit them, 完成 keeps them and 取消 restores them.
 * `draft` holds `{ level, duration, directories }`; reading opens all of `paths` (the room's project directories).
 */
import { computed, ref, useId, watch } from "vue";
import { DURATIONS, LEVELS } from "./external-members.js";
import { t } from "./i18n.js";

const emit = defineEmits(["remove"]);
const draft = defineModel("draft", { type: Object, required: true });
const props = defineProps({ paths: { type: Array, default: () => [] } });
const level = ref(draft.value.level || "read"), duration = ref(draft.value.duration || "1h");
const paths = computed(() => props.paths.filter(Boolean));
watch([level, duration, paths], () => { draft.value = { level: level.value, duration: duration.value, directories: [...paths.value] }; }, { immediate: true });
// Reading needs a directory: without one it is invited for discussing, so the front says so.
const shown_level = computed(() => level.value === "read" && !paths.value.length ? "discuss" : level.value);
const leaf = (path) => path.split(/[\\/]/).filter(Boolean).pop() || path;
const facts = computed(() => [
  { label: t("状态"), value: t("待签到"), tone: "warn" },
  { label: t("项目"), value: shown_level.value === "read" ? t("可读：{dirs}", { dirs: paths.value.map(leaf).join("、") }) : t("只讨论") },
  { label: t("有效期"), value: DURATIONS.find((option) => option.value === duration.value)?.label },
]);

const back = ref(false);
let saved = null;
function open_back() { saved = { level: level.value, duration: duration.value }; back.value = true; }
function cancel() { if (saved) { level.value = saved.level; duration.value = saved.duration; } back.value = false; }
const uid = useId();
</script>

<template>
  <div class="expert-card" :data-face="back ? 'back' : 'front'" @keydown.esc="back && cancel()">
    <div class="expert-card-turn">
      <div class="expert-card-face expert-card-front" :inert="back" :aria-hidden="back">
        <button type="button" class="expert-card-open" :aria-label="t('邀请外部专家')" :title="t('点击翻面设置')" @click="open_back">
          <span class="expert-card-identity">
            <span class="expert-card-avatar channel-avatar external" aria-hidden="true"><img :src="'/icons/external-expert.svg'" alt="" /></span>
            <span class="expert-card-names"><span><strong>{{ t("外部专家") }}</strong></span><small :title="t('对方电脑上的 AI，只读本房间开放的内容')">{{ t("对方电脑上的 AI，只读本房间开放的内容") }}</small></span>
          </span>
          <dl class="expert-card-facts">
            <div v-for="fact in facts" :key="fact.label"><dt>{{ fact.label }}</dt><dd :class="fact.tone ? ['expert-card-status', `is-${fact.tone}`] : ''" :title="fact.value"><i v-if="fact.tone" aria-hidden="true" />{{ fact.value }}</dd></div>
          </dl>
          <span class="expert-card-flip is-open"><UIcon name="i-lucide-settings-2" /><span>{{ t("设置") }}</span></span>
        </button>
        <span class="expert-card-tools">
          <button type="button" :aria-label="t('移除这张卡片')" :title="t('移出')" @click="emit('remove')"><UIcon name="i-lucide-x" /></button>
        </span>
      </div>
      <div class="expert-card-face expert-card-back" :inert="!back" :aria-hidden="!back">
        <div class="expert-card-back-body">
          <div class="expert-card-heading"><strong>{{ t("外部专家") }}<span>{{ t("设置") }}</span></strong></div>
          <div class="expert-card-field">
            <span :id="`${uid}-level`">{{ t("项目") }}</span>
            <div class="expert-card-modes" role="radiogroup" :aria-labelledby="`${uid}-level`">
              <button v-for="option in LEVELS" :key="option.value" type="button" role="radio" :title="option.description" :aria-checked="level === option.value" @click="level = option.value">{{ option.label }}</button>
            </div>
          </div>
          <p v-if="level === 'read' && !paths.length" class="expert-card-empty">{{ t("还没有选项目目录，只能选“只讨论”。") }}</p>
          <div class="expert-card-field">
            <span :id="`${uid}-duration`">{{ t("有效期") }}</span>
            <div class="expert-card-modes" role="radiogroup" :aria-labelledby="`${uid}-duration`">
              <button v-for="option in DURATIONS" :key="option.value" type="button" role="radio" :aria-checked="duration === option.value" @click="duration = option.value">{{ option.label }}</button>
            </div>
          </div>
          <p class="expert-card-warning" role="note" :title="level === 'read' ? t('只读：已跟踪与未忽略的文件，固定排除 .env、密钥、凭据、data/ 与 .git。') : undefined"><UIcon name="i-lucide-triangle-alert" />{{ level === 'read' ? t("项目内容会发给对方模型服务商") : t("消息会发给对方模型服务商") }}</p>
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
.expert-card-facts { display: grid; gap: 4px; width: 100%; margin: 0; padding-top: 10px; border-top: 1px solid var(--ui-border-muted); font-size: 11px; }
.expert-card-facts > div { display: grid; grid-template-columns: 3em minmax(0, 1fr); gap: 8px; }
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
/* Labels are three characters here (有效期), so the column is wider than the member card's 26px. */
.expert-card-field { display: grid; grid-template-columns: 3em minmax(0, 1fr); align-items: center; gap: 8px; color: var(--ui-text-dimmed); font-size: 11px; }
.expert-card-field .expert-card-modes button { padding: 0 6px; white-space: nowrap; }
.expert-card-empty { margin: 0; color: var(--ui-text-muted); font-size: 11px; line-height: 20px; }
.expert-card-warning { display: flex; gap: 6px; margin: auto 0 0; color: var(--ui-warning, #e0a33a); font-size: 11px; line-height: 16px; }
.expert-card-warning > :first-child { flex: none; width: 12px; height: 12px; margin-top: 2px; }
@media (pointer: coarse) {
  .expert-card-tools > button { width: 32px; height: 32px; }
  .expert-card-flip-actions > .expert-card-flip { min-height: 32px; padding: 0 10px; }
}
/* Narrow card: the same extra line as a member card (ExpertCard.vue). */
@container (max-width: 220px) {
  .expert-card-turn { height: 272px; }
}
</style>

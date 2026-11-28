<script setup>
/**
 * An external expert to be invited (new-room panel, invite dialog), on the shared turning frame (FlipCard.vue): the
 * front sums up what the inviter grants and what protects it (what it opens, the online site the link goes through),
 * 设置 turns to the back to change what it opens, 完成 keeps it and 取消 restores it.
 * `draft` holds `{ level, directories }`; reading opens all of `paths` (the room's project directories). How long the
 * expert stays is the invited computer's choice, made when it joins.
 */
import { computed, inject, ref, useId, watch } from "vue";
import FlipCard from "./FlipCard.vue";
import { LEVELS, READ_EXCLUDED, invite_relay } from "./external-members.js";
import { t } from "./i18n.js";

const emit = defineEmits(["remove"]);
const draft = defineModel("draft", { type: Object, required: true });
const props = defineProps({ paths: { type: Array, default: () => [] } });
const { view } = inject("discussion");
const level = ref(draft.value.level || "read");
const paths = computed(() => props.paths.filter(Boolean));
watch([level, paths], () => { draft.value = { level: level.value, directories: [...paths.value] }; }, { immediate: true });
// Reading needs a directory: without one it is invited for discussing, so the front says so.
const shown_level = computed(() => level.value === "read" && !paths.value.length ? "discuss" : level.value);
const leaf = (path) => path.split(/[\\/]/).filter(Boolean).pop() || path;
const relay = computed(() => invite_relay(view.value.launch.invite_site));
// Two-character labels, as on a member card's front, so the two kinds of cards line up.
const facts = computed(() => [
  { label: t("状态"), value: t("待签到"), tone: "warn", dot: true },
  { label: t("开放"), value: LEVELS.find((option) => option.value === shown_level.value)?.label },
  ...shown_level.value === "read" ? [
    { label: t("目录"), value: paths.value.map(leaf).join("、") },
  ] : [],
  ...relay.value ? [{ label: t("中转"), ...relay.value }] : [],
]);

let saved = null;
const uid = useId();
</script>

<template>
  <FlipCard :label="t('邀请外部专家')" :title="t('外部专家')" :subtitle="t('对方电脑上的 AI，只读本房间开放的内容')" icon="/icons/external-expert.svg"
    :facts="facts" @remove="emit('remove')" @open="saved = { level }" @cancel="saved && (level = saved.level)">
    <template #back>
      <div class="expert-card-field">
        <span :id="`${uid}-level`" :title="t('对方能看到')">{{ t("开放") }}</span>
        <div class="expert-card-modes" role="radiogroup" :aria-labelledby="`${uid}-level`">
          <button v-for="option in LEVELS" :key="option.value" type="button" role="radio" :title="option.description" :aria-checked="level === option.value" @click="level = option.value">{{ option.label }}</button>
        </div>
      </div>
      <p class="expert-card-hint">{{ LEVELS.find((option) => option.value === level)?.description }}</p>
      <template v-if="level === 'read'">
        <div v-if="paths.length" class="expert-card-field is-top">
          <span>{{ t("目录") }}</span>
          <ul class="expert-card-dirs"><li v-for="path in paths" :key="path" :title="path">{{ leaf(path) }}</li></ul>
        </div>
        <p v-if="paths.length" class="expert-card-hint">{{ READ_EXCLUDED }}</p>
        <p v-else class="expert-card-empty">{{ t("还没有选项目目录，只能选“房间消息”。") }}</p>
      </template>
      <p class="expert-card-warning" role="note"><UIcon name="i-lucide-triangle-alert" />{{ level === 'read' ? t("项目内容会发给对方模型服务商") : t("消息会发给对方模型服务商") }}</p>
    </template>
  </FlipCard>
</template>

<script setup>
/**
 * An external user to be invited (invite dialog), on the shared turning frame (FlipCard.vue), as the external expert
 * card: the front sums up who is invited, for how long, what they may see and how the room's AIs are held back; 设置
 * turns to the back to change it, 完成 keeps it and 取消 restores it. The dialog's 邀请 makes the link
 * (API.md §2 `guest-invite`) and shows it with its QR code, as it does an external expert's.
 * `draft` holds `{ label, duration_seconds, scope, private_chat, mode }`; `occupied` says one is already waiting or in.
 */
import { computed, inject, ref, useId, watch } from "vue";
import FlipCard from "./FlipCard.vue";
import { DEFAULT_DURATION_S, DEFAULT_LABEL, DURATIONS, MODES, MODE_SHORT, SCOPES, duration_label } from "./external-guests.js";
import { invite_relay } from "./external-members.js";
import { locale, t } from "./i18n.js";

const emit = defineEmits(["remove"]);
const draft = defineModel("draft", { type: Object, required: true });
const props = defineProps({ occupied: { type: Boolean, default: false } });
const { view } = inject("discussion");
const room = computed(() => view.value.room);
const label = ref(draft.value.label ?? DEFAULT_LABEL);
const duration = ref(draft.value.duration_seconds || DEFAULT_DURATION_S);
const scope = ref(draft.value.scope || "chat");
const private_chat = ref(Boolean(draft.value.private_chat));
const mode = ref(draft.value.mode || "conservative");
// Reading the project needs one: a room without a project directory offers chat only.
const has_project = computed(() => {
  const models = view.value.launch.room_models;
  return models?.room_id !== room.value?.id || Boolean(models.project_directory);
});
watch([label, duration, scope, private_chat, mode, has_project], () => {
  draft.value = { label: label.value.trim() || DEFAULT_LABEL, duration_seconds: duration.value,
    scope: has_project.value ? scope.value : "chat", private_chat: private_chat.value, mode: mode.value };
}, { immediate: true });
const relay = computed(() => invite_relay(view.value.launch.invite_site));
const facts = computed(() => [
  props.occupied ? { label: t("状态"), value: t("已有外部用户在场"), tone: "danger", title: t("本房间已有外部用户在等待或在场；一个房间同时只接一位，先在右栏断开再邀请。") }
    : { label: t("状态"), value: t("待生成链接"), tone: "warn", dot: true },
  { label: t("称呼"), value: draft.value.label },
  { label: t("限时"), value: duration_label(duration.value) },
  { label: t("查看"), value: [SCOPES.find((option) => option.value === draft.value.scope)?.label, private_chat.value ? t("私聊只读开放") : t("私聊未开放")].join(" · ") },
  { label: t("保护"), value: MODE_SHORT[mode.value], ...mode.value === "trust" ? { tone: "warn" } : {} },
  ...relay.value ? [{ label: t("中转"), ...relay.value }] : [],
]);

let saved = null;
function remember() { saved = { label: label.value, duration: duration.value, scope: scope.value, private_chat: private_chat.value, mode: mode.value }; }
function restore() {
  if (!saved) return;
  ({ label: label.value, duration: duration.value, scope: scope.value, private_chat: private_chat.value, mode: mode.value } = saved);
}
const uid = useId();
</script>

<template>
  <FlipCard :label="t('邀请外部用户')" :title="t('外部用户')" :subtitle="t('对方用浏览器打开链接，限时进入本房间直接和 AI 对话')" icon="/icons/external-user.svg"
    :facts="facts" :style="locale === 'en' ? { '--flip-label': '6em' } : undefined" @remove="emit('remove')" @open="remember" @cancel="restore">
    <template #back>
      <label class="expert-card-field">
        <span :title="t('房间里这样称呼对方；对方进入前可以改。')">{{ t("称呼") }}</span>
        <UInput v-model="label" size="xs" :maxlength="40" :placeholder="DEFAULT_LABEL" />
      </label>
      <div class="expert-card-field">
        <span :id="`${uid}-duration`" :title="t('从对方进入房间起算，在场期间可以延长，最长 24 小时。')">{{ t("限时") }}</span>
        <div class="expert-card-modes" role="radiogroup" :aria-labelledby="`${uid}-duration`">
          <button v-for="option in DURATIONS" :key="option.value" type="button" role="radio" :aria-checked="duration === option.value" @click="duration = option.value">{{ option.label }}</button>
        </div>
      </div>
      <div class="expert-card-field">
        <span :id="`${uid}-scope`" :title="t('对方能看到')">{{ t("查看") }}</span>
        <div class="expert-card-modes" role="radiogroup" :aria-labelledby="`${uid}-scope`">
          <button v-for="option in SCOPES" :key="option.value" type="button" role="radio" :aria-checked="scope === option.value" :disabled="option.value === 'project' && !has_project" :title="option.value === 'project' && !has_project ? t('本房间还没有项目目录，只能选“仅聊天”。') : option.description" @click="scope = option.value">{{ option.label }}</button>
        </div>
      </div>
      <div class="expert-card-field">
        <span>{{ t("私聊") }}</span>
        <UCheckbox v-model="private_chat" size="xs" :label="t('开放（只读）')" />
      </div>
      <div class="expert-card-field">
        <span :id="`${uid}-mode`">{{ t("保护") }}</span>
        <div class="expert-card-modes" role="radiogroup" :aria-labelledby="`${uid}-mode`">
          <button v-for="option in MODES" :key="option.value" type="button" role="radio" :aria-checked="mode === option.value" :title="option.description" @click="mode = option.value">{{ option.label }}</button>
        </div>
      </div>
      <!-- One line only, so the back fits without scrolling; the trust mode keeps its plain warning here, the rest is on hover. -->
      <p class="expert-card-warning" role="note" :title="mode === 'trust' ? MODES.find((option) => option.value === 'trust').description : undefined"><UIcon name="i-lucide-triangle-alert" />{{ mode === 'trust' ? t("信任档不限制 AI，对方可能诱导越权") : t("对方可点名任何成员、看全部历史") }}</p>
    </template>
  </FlipCard>
</template>

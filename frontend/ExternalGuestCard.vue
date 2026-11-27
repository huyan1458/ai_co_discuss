<script setup>
/**
 * The invite dialog's card for an external user: a person without CoDiscuss who opens a link in a browser and talks
 * with this room's AIs for a limited time. The owner names them and chooses how long, what they may see and how the
 * room's AIs are held back while they are in; the card then shows the link and its QR code (API.md §2 `guest-invite`).
 */
import { computed, inject, onUnmounted, ref, useId } from "vue";
import { renderSVG } from "uqr";
import { DEFAULT_DURATION_S, DEFAULT_LABEL, DURATIONS, MODES, SCOPES, guest_error, use_guest_state } from "./external-guests.js";
import { time_ms } from "./external-members.js";
import { t } from "./i18n.js";

const emit = defineEmits(["remove", "generated"]);
const { view, bridge } = inject("discussion");
const room = computed(() => view.value.room);
const guest = use_guest_state(bridge, () => room.value?.id);
const label = ref(DEFAULT_LABEL);
const duration = ref(DEFAULT_DURATION_S);
const scope = ref("chat");
const private_chat = ref(false);
const mode = ref("conservative");
const busy = ref(false), invite = ref(null), failure = ref("");
const COPY_FEEDBACK_MS = 2000;
const copied = ref(false);
let copy_timer = 0;
// One external user per room: while one waits or is in, a new link waits for the end.
const occupied = computed(() => ["waiting", "active"].includes(guest.state.value?.phase));
const unavailable = computed(() => !view.value.launch.available && !view.value.launch.remote);
// Reading the project needs one: a room without a project directory offers chat only.
const has_project = computed(() => {
  const models = view.value.launch.room_models;
  return models?.room_id !== room.value?.id || Boolean(models.project_directory);
});

/** Ask this computer to register the invitation and sign its link; a new link voids the one not yet opened. */
async function generate() {
  if (busy.value || occupied.value) return;
  busy.value = true;
  failure.value = "";
  try {
    const result = await guest.operations.value.invite({ label: label.value.trim() || DEFAULT_LABEL, scope: scope.value,
      private_chat: private_chat.value, mode: mode.value, duration_seconds: duration.value });
    invite.value = { ...result, svg: result?.url ? renderSVG(result.url, { border: 1 }) : "" };
    if (result?.url) emit("generated");
    // Without a bound online site the link cannot exist; the reason stays on the card, where the link would be.
    if (!result?.url) failure.value = result?.reason_text || result?.reason || t("未生成链接：电脑需先绑定线上站点（设置 → 远程访问）");
  } catch (error) {
    failure.value = guest_error(error);
  } finally { busy.value = false; }
}

async function copy() {
  if (!await bridge.execute("copy", invite.value.url)) return;
  copied.value = true;
  clearTimeout(copy_timer);
  copy_timer = setTimeout(() => { copied.value = false; }, COPY_FEEDBACK_MS);
}
onUnmounted(() => clearTimeout(copy_timer));
const date = (value) => bridge.format_time(time_ms(value));
const uid = useId();
</script>

<template>
  <section class="external-invite external-guest" :aria-label="t('邀请外部用户')">
    <header class="external-invite-identity">
      <span class="external-invite-avatar channel-avatar external" aria-hidden="true"><img :src="'/icons/external-user.svg'" alt="" /></span>
      <span class="external-invite-names"><strong>{{ t("外部用户") }}</strong><small>{{ t("对方用浏览器打开链接，限时进入本房间直接和 AI 对话") }}</small></span>
      <span class="external-invite-tools">
        <button type="button" :aria-label="t('移除这张卡片')" :title="t('移除这张卡片')" @click="emit('remove')"><UIcon name="i-lucide-x" /></button>
      </span>
    </header>
    <p v-if="occupied" class="external-invite-empty">{{ t("本房间已有外部用户在等待或在场；一个房间同时只接一位，先在右栏断开再邀请。") }}</p>
    <template v-else-if="!invite?.url">
      <label class="external-invite-field">
        <span class="external-invite-label">{{ t("称呼") }}</span>
        <UInput v-model="label" size="sm" :maxlength="40" :placeholder="DEFAULT_LABEL" />
        <span class="external-invite-hint">{{ t("房间里这样称呼对方；对方进入前可以改。") }}</span>
      </label>
      <div class="external-invite-field">
        <span :id="`${uid}-duration`" class="external-invite-label">{{ t("时长") }}</span>
        <div class="expert-card-modes" role="radiogroup" :aria-labelledby="`${uid}-duration`">
          <button v-for="option in DURATIONS" :key="option.value" type="button" role="radio" :aria-checked="duration === option.value" @click="duration = option.value">{{ option.label }}</button>
        </div>
        <p class="external-invite-hint">{{ t("从对方进入房间起算，在场期间可以延长，最长 24 小时。") }}</p>
      </div>
      <div class="external-invite-field">
        <span :id="`${uid}-scope`" class="external-invite-label">{{ t("对方能看到") }}</span>
        <div class="expert-card-modes" role="radiogroup" :aria-labelledby="`${uid}-scope`">
          <button v-for="option in SCOPES" :key="option.value" type="button" role="radio" :aria-checked="scope === option.value" :disabled="option.value === 'project' && !has_project" @click="scope = option.value">{{ option.label }}</button>
        </div>
        <p class="external-invite-hint">{{ has_project ? SCOPES.find((option) => option.value === scope)?.description : t("本房间还没有项目目录，只能选“仅聊天”。") }}</p>
        <UCheckbox v-model="private_chat" size="xs" :label="t('开放私聊（只读）')" />
      </div>
      <div class="external-invite-field">
        <span :id="`${uid}-mode`" class="external-invite-label">{{ t("保护") }}</span>
        <div class="expert-card-modes" role="radiogroup" :aria-labelledby="`${uid}-mode`">
          <button v-for="option in MODES" :key="option.value" type="button" role="radio" :aria-checked="mode === option.value" @click="mode = option.value">{{ option.label }}</button>
        </div>
        <p class="external-invite-hint" :class="{ 'is-warning': mode === 'trust' }">{{ MODES.find((option) => option.value === mode)?.description }}</p>
      </div>
      <footer class="external-invite-footer">
        <p class="external-invite-warning" role="note"><UIcon name="i-lucide-triangle-alert" />{{ t("对方能发消息并点名任何成员；房间历史全部可见。") }}</p>
        <p v-if="unavailable" class="external-invite-warning is-error" role="alert"><UIcon name="i-lucide-plug-zap" />{{ t("生成邀请需要本机服务，请在这台电脑打开本机网站。") }}</p>
        <p v-else-if="failure" class="external-invite-warning is-error" role="alert"><UIcon name="i-lucide-link-2-off" />{{ failure }}</p>
        <UButton icon="i-lucide-link" :label="t('生成链接')" size="sm" class="channel-primary-button external-invite-generate" :loading="busy" :disabled="busy || unavailable" @click="generate" />
      </footer>
    </template>
    <div v-else class="external-invite-result" role="status" aria-live="polite">
      <!-- eslint-disable-next-line vue/no-v-html -- an SVG this page rendered from the computer's own link -->
      <div v-if="invite.svg" class="external-invite-qr" role="img" :aria-label="t('邀请二维码')" v-html="invite.svg" />
      <div class="external-invite-result-body">
        <p>{{ t("把链接或二维码发给对方。") }}</p>
        <div class="external-invite-copy">
          <UButton :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'" :label="copied ? t('已复制') : t('复制链接')" size="xs" :color="copied ? 'success' : 'neutral'" variant="outline" @click="copy" />
          <UButton :label="t('重新生成链接')" icon="i-lucide-refresh-cw" size="xs" color="neutral" variant="ghost" :loading="busy" :disabled="busy || unavailable" @click="invite = null" />
        </div>
        <p class="external-invite-hint">{{ t("{time} 前打开有效，只能用一次，绑定第一个打开的浏览器。对方进入后右栏显示在场卡，可随时断开。", { time: date(invite.invite_expires_at) }) }}</p>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* Shares the external expert invite card's frame (ExternalInviteCard.vue); its classes are global there via the same names. */
.external-guest { display: flex; flex-direction: column; gap: 12px; min-width: 0; padding: 12px; border: 1px solid var(--channel-edge-control, var(--ui-border)); border-radius: 8px;
  background: color-mix(in srgb, var(--ui-bg-elevated) 45%, var(--ui-bg)); box-shadow: var(--channel-shadow-control); }
.external-invite-identity { display: flex; align-items: center; gap: 8px; min-width: 0; min-height: 26px; }
.external-invite-avatar { display: grid; flex-shrink: 0; place-items: center; width: 26px; height: 26px; border-radius: 999px; background: var(--ui-bg-accented); color: var(--ui-text-highlighted); }
.external-invite-avatar > span { width: 14px; height: 14px; }
.external-invite-names { display: grid; flex: 1; min-width: 0; }
.external-invite-names strong { overflow: hidden; color: var(--ui-text-highlighted); font-size: 13px; font-weight: 600; white-space: nowrap; text-overflow: ellipsis; }
.external-invite-names small { overflow: hidden; color: var(--ui-text-muted); font-size: 11px; line-height: 16px; white-space: nowrap; text-overflow: ellipsis; }
.external-invite-tools { display: flex; flex-shrink: 0; gap: 2px; margin: -2px -4px 0 0; }
.external-invite-tools > button { display: grid; place-items: center; width: 24px; height: 24px; border-radius: 5px; color: var(--ui-text-dimmed); }
.external-invite-tools > button > span { width: 13px; height: 13px; }
.external-invite-tools > button:hover { background: var(--ui-bg-accented); color: var(--ui-text-highlighted); }
.external-invite-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.external-invite-label { color: var(--ui-text-dimmed); font-size: 11px; }
.external-invite-hint { margin: 0; color: var(--ui-text-muted); font-size: 11px; line-height: 1.5; overflow-wrap: anywhere; }
.external-invite-hint.is-warning { color: var(--ui-warning, #e0a33a); }
.external-invite-empty { margin: 0; padding: 10px; border: 1px dashed var(--ui-border); border-radius: 6px; color: var(--ui-text-muted); font-size: 11px; text-align: center; }
.external-invite-field .expert-card-modes { max-width: 360px; }
.external-invite-field .expert-card-modes button { padding: 0 8px; white-space: nowrap; }
.external-invite-footer { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: flex-end; gap: 8px 12px; padding-top: 10px; border-top: 1px solid var(--ui-border-muted); }
.external-invite-warning { display: flex; flex: 1 1 260px; gap: 6px; margin: 0; color: var(--ui-warning, #e0a33a); font-size: 11px; line-height: 1.5; }
.external-invite-warning.is-error { color: var(--ui-error); }
.external-invite-warning > :first-child { flex: none; width: 13px; height: 13px; margin-top: 2px; }
.external-invite-generate { flex-shrink: 0; }
.external-invite-result { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 12px; padding-top: 10px; border-top: 1px solid var(--ui-border-muted); }
.external-invite-result-body { display: flex; flex: 1; flex-direction: column; gap: 6px; min-width: 200px; }
.external-invite-result-body > p:first-child { margin: 0; color: var(--ui-text-toned); font-size: 12px; }
.external-invite-qr { flex-shrink: 0; width: 148px; height: 148px; padding: 6px; border-radius: 8px; background: #fff; }
.external-invite-qr :deep(svg) { display: block; width: 100%; height: 100%; }
.external-invite-copy { display: flex; flex-wrap: wrap; gap: 6px; }
@media (pointer: coarse) {
  .external-invite-field .expert-card-modes button { min-height: 32px; }
  .external-invite-tools { margin: -7px -11px -7px 0; }
  .external-invite-tools > button { width: 36px; height: 36px; }
}
@media (max-width: 480px) {
  .external-invite-result { flex-direction: column; align-items: stretch; }
  .external-invite-qr { align-self: center; width: 180px; height: 180px; }
  .external-invite-field .expert-card-modes { max-width: none; }
  .external-invite-names small { white-space: normal; }
  .external-invite-generate { width: 100%; justify-content: center; }
}
</style>

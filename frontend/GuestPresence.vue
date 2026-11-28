<script setup>
/**
 * The owner's controls while an external user is invited, waits or is in the room. `rail` is the card at the top of
 * the right rail (link, countdown, disconnect, protection, extend); `bar` is the one line above the composer, so a
 * phone with the rail folded away still reaches the link and "立即断开". Both read one shared guest state
 * (external-guests.js), so they never disagree.
 */
import { computed, inject, onUnmounted, ref } from "vue";
import { renderSVG } from "uqr";
import { EXTENSIONS, MAX_DURATION_S, MODES, SCOPES, clock_label, guest_error, guest_invites, use_guest_state } from "./external-guests.js";
import { time_ms } from "./external-members.js";
import { t } from "./i18n.js";

const props = defineProps({ variant: { type: String, default: "rail" } });
const { view, bridge } = inject("discussion");
const room_id = computed(() => view.value.room?.id);
const { state, left_ms, operations } = use_guest_state(bridge, () => (view.value.access?.can_manage && !view.value.share ? room_id.value : ""));
const phase = computed(() => state.value?.phase || "none");
const guest = computed(() => state.value?.guest || null);
const name = computed(() => guest.value?.label || t("外部用户"));
// The last two minutes turn the countdown to a warning, as on the guest's own page.
const ENDING_MS = 2 * 60_000;
const ending = computed(() => phase.value === "active" && left_ms.value <= ENDING_MS);
const shown = computed(() => ["invited", "waiting", "active"].includes(phase.value));
const scope_text = computed(() => [SCOPES.find((item) => item.value === guest.value?.scope)?.label,
  guest.value?.private_chat ? t("私聊只读开放") : t("私聊未开放")].filter(Boolean).join(" · "));
const extensions = computed(() => EXTENSIONS.filter((item) => (guest.value?.duration_seconds || 0) + item.value <= MAX_DURATION_S));

// Each action reports its own failure (external-guests.js); a click only needs to swallow the rejection.
const run = (operation) => Promise.resolve(operation()).catch(() => {});
const disconnect = () => run(() => operations.value.disconnect(guest.value.id));
const admit = () => run(() => operations.value.admit(guest.value.id));
const revoke = () => run(() => operations.value.revoke(state.value.invite_id));
const switch_mode = (mode) => mode !== state.value.mode && run(() => operations.value.protection(mode));
const extend = (seconds) => run(() => operations.value.extend(Math.min(MAX_DURATION_S, guest.value.duration_seconds + seconds)));
const invite_until = computed(() => bridge.format_time(time_ms(state.value?.invite_expires_at)));

// The link of the invitation now waiting to be opened, when this page generated it (guest_invites).
const invite_version = ref(0);
const invite = computed(() => {
  invite_version.value;
  const kept = guest_invites.get(room_id.value);
  return kept?.url && kept.invite_id === state.value?.invite_id ? kept : null;
});
const qr_open = ref(false);
const qr_svg = computed(() => qr_open.value && invite.value ? renderSVG(invite.value.url, { border: 1 }) : "");
const COPY_FEEDBACK_MS = 2000;
const copied = ref(false), regenerating = ref(false);
let copy_timer = 0;
async function copy() {
  if (!invite.value || !await bridge.execute("copy", invite.value.url)) return;
  copied.value = true;
  clearTimeout(copy_timer);
  copy_timer = setTimeout(() => { copied.value = false; }, COPY_FEEDBACK_MS);
}
/** A new link with the same choices; it voids the one not opened yet (API.md §2 O/invite). */
async function regenerate() {
  const kept = guest_invites.get(room_id.value);
  if (!kept?.options || regenerating.value) return;
  regenerating.value = true;
  try { await operations.value.invite(kept.options); invite_version.value++; }
  catch (error) { bridge.notify("error", guest_error(error)); }
  finally { regenerating.value = false; }
}
onUnmounted(() => clearTimeout(copy_timer));
// The bar's wording per mode says plainly what holds: trust holds nothing back.
const bar_text = computed(() => state.value?.mode === "trust"
  ? t("{name} 在场 · 剩 {time} · 信任档：AI 权限未限制", { name: name.value, time: clock_label(left_ms.value) })
  : t("{name} 在场 · 剩 {time} · 保守档：AI 临时只读", { name: name.value, time: clock_label(left_ms.value) }));
</script>

<template>
  <section v-if="shown && variant === 'rail'" class="guest-presence" :class="{ 'is-active': phase === 'active', 'is-ending': ending }" :aria-label="t('外部用户')">
    <template v-if="phase === 'invited'">
      <p class="guest-presence-line"><UIcon name="i-lucide-link" />{{ t("外部用户邀请待打开 · {time} 前有效", { time: invite_until }) }}</p>
      <div class="guest-presence-extend">
        <UButton v-if="invite" :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'" :label="copied ? t('已复制') : t('复制链接')" size="xs" :color="copied ? 'success' : 'neutral'" variant="outline" @click="copy" />
        <UButton v-if="invite" icon="i-lucide-qr-code" :label="qr_open ? t('收起二维码') : t('二维码')" size="xs" color="neutral" variant="ghost" @click="qr_open = !qr_open" />
        <UButton v-if="guest_invites.get(room_id)?.options" icon="i-lucide-refresh-cw" :label="t('重新生成链接')" size="xs" color="neutral" variant="ghost" :loading="regenerating" @click="regenerate" />
        <UButton icon="i-lucide-link-2-off" :label="t('作废')" :title="t('作废这个邀请链接，对方打开后无法进入')" size="xs" color="error" variant="ghost" @click="revoke" />
      </div>
      <!-- eslint-disable-next-line vue/no-v-html -- an SVG this page rendered from the computer's own link -->
      <div v-if="qr_svg" class="guest-presence-qr" role="img" :aria-label="t('邀请二维码')" v-html="qr_svg" />
      <p v-if="!invite" class="guest-presence-hint">{{ t("链接只在生成它的页面保留；需要时在“邀请成员 → 外部用户”重新生成，旧链接随即作废。") }}</p>
    </template>
    <template v-else-if="phase === 'waiting'">
      <header class="guest-presence-head">
        <strong>{{ t("{name} 等待入场", { name }) }}</strong>
        <UButton :label="t('断开')" size="xs" color="neutral" variant="outline" @click="disconnect" />
      </header>
      <p class="guest-presence-hint">{{ state.stop_for_admission ? t("正在停止运行中的任务，停止后对方进入，倒计时从进入起算。") : t("本房间有任务在运行，结束后对方自动进入；倒计时从进入起算。") }}</p>
      <UButton v-if="!state.stop_for_admission" icon="i-lucide-square" :label="t('立即停止并接入')" size="xs" color="warning" variant="soft" @click="admit" />
      <p v-if="!state.stop_for_admission" class="guest-presence-hint">{{ t("被停止的任务不会作废：它退回排队，对方进入后按保守档（只读）重新处理。") }}</p>
    </template>
    <template v-else>
      <header class="guest-presence-head">
        <strong>{{ t("{name} 在场", { name }) }}<span class="guest-presence-clock" role="timer">{{ t("剩 {time}", { time: clock_label(left_ms) }) }}</span></strong>
        <UButton icon="i-lucide-unplug" :label="t('立即断开')" size="xs" color="error" @click="disconnect" />
      </header>
      <p class="guest-presence-hint">{{ scope_text }}</p>
      <div class="guest-presence-field">
        <span class="guest-presence-label">{{ t("保护") }}</span>
        <div class="expert-card-modes" role="radiogroup" :aria-label="t('保护')">
          <button v-for="option in MODES" :key="option.value" type="button" role="radio" :aria-checked="state.mode === option.value" @click="switch_mode(option.value)">{{ option.label }}</button>
        </div>
        <p class="guest-presence-hint" :class="{ 'is-warning': state.mode === 'trust' }">{{ MODES.find((option) => option.value === state.mode)?.description }}</p>
        <p class="guest-presence-hint">{{ t("切换在下一次投递时生效，运行中的任务按启动时的档位跑完。") }}</p>
      </div>
      <div v-if="extensions.length" class="guest-presence-extend">
        <span class="guest-presence-label">{{ t("延长") }}</span>
        <UButton v-for="option in extensions" :key="option.value" :label="option.label" size="xs" color="neutral" variant="ghost" @click="extend(option.value)" />
      </div>
    </template>
  </section>
  <div v-else-if="variant === 'bar'" class="guest-bar-slot">
  <div v-if="shown" class="channel-reply-draft channel-queue-hint guest-bar" :class="{ 'is-ending': ending, 'is-trust': phase === 'active' && state.mode === 'trust' }" role="status">
    <UIcon name="i-lucide-user-round" />
    <span v-if="phase === 'invited'">{{ t("外部用户邀请待打开 · {time} 前有效", { time: invite_until }) }}</span>
    <span v-else-if="phase === 'waiting'">{{ t("{name} 等待入场：本房间有任务在运行", { name }) }}</span>
    <span v-else>{{ bar_text }}</span>
    <UButton v-if="phase === 'invited' && invite" :label="copied ? t('已复制') : t('复制链接')" size="xs" color="neutral" variant="ghost" @click="copy" />
    <UButton v-if="phase === 'invited'" :label="t('作废')" size="xs" color="error" variant="ghost" @click="revoke" />
    <UButton v-if="phase === 'waiting' && !state.stop_for_admission" :label="t('立即停止并接入')" size="xs" color="neutral" variant="ghost" @click="admit" />
    <UButton v-if="phase !== 'invited'" :label="phase === 'active' ? t('立即断开') : t('断开')" size="xs" color="error" variant="ghost" @click="disconnect" />
  </div>
  </div>
</template>

<style scoped>
.guest-presence { display: flex; flex-direction: column; gap: 8px; margin: 0 0 10px; padding: 10px; border: 1px solid var(--ui-border); border-radius: 8px; background: var(--ui-bg-elevated); }
.guest-presence.is-active { border-color: var(--ui-warning, #e0a33a); }
.guest-presence-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; }
.guest-presence-head strong { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 8px; min-width: 0; color: var(--ui-text-highlighted); font-size: 13px; font-weight: 600; overflow-wrap: anywhere; }
.guest-presence-clock { color: var(--ui-text-toned); font-size: 12px; font-weight: 500; font-variant-numeric: tabular-nums; }
.is-ending .guest-presence-clock, .guest-bar.is-ending > span { color: var(--ui-error); }
.guest-bar.is-trust > span:not([class*="icon"]) { color: var(--ui-warning, #e0a33a); }
.guest-presence-line { display: flex; align-items: center; gap: 6px; margin: 0; color: var(--ui-text-muted); font-size: 12px; }
.guest-presence-line > span:first-child { flex: none; width: 13px; height: 13px; }
.guest-presence-field { display: flex; flex-direction: column; gap: 6px; }
.guest-presence-label { color: var(--ui-text-dimmed); font-size: 11px; }
.guest-presence-hint { margin: 0; color: var(--ui-text-muted); font-size: 11px; line-height: 1.5; overflow-wrap: anywhere; }
.guest-presence-hint.is-warning { color: var(--ui-warning, #e0a33a); }
.guest-presence-extend { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
/* The QR code keeps a white plate in both themes so phone cameras read it (as on the invite card). */
.guest-presence-qr { align-self: center; width: 148px; height: 148px; padding: 6px; border-radius: 8px; background: #fff; }
.guest-presence-qr :deep(svg) { display: block; width: 100%; height: 100%; }
.guest-bar > span:not([class*="icon"]) { font-variant-numeric: tabular-nums; }
.guest-bar-slot { height: 32px; }
.guest-bar { height: 100%; padding-block: 0; white-space: nowrap; }
.guest-bar > span:not([class*="icon"]) { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.guest-bar > button { flex-shrink: 0; }
@media (pointer: coarse) { .guest-presence .expert-card-modes button { min-height: 32px; } }
</style>

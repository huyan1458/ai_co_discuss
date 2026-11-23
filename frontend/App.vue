<script setup>
import { computed, onBeforeUnmount, provide, ref } from "vue";
import { MotionConfig } from "motion-v";
import { useToast } from "@nuxt/ui/composables";
import { en, zh_cn } from "@nuxt/ui/locale";
import { locale, t } from "./i18n.js";
import { use_discussion } from "./use-discussion.js";
import ChannelWorkspace from "./ChannelWorkspace.vue";
import ConfirmDialog from "./ConfirmDialog.vue";

// Longer notices are cut here; the toaster is for a glance, not for whole server replies.
const NOTICE_MAX_LENGTH = 120;
const NOTICE_LEVELS = {
  error: { color: "error", icon: "i-lucide-circle-x", duration: 8000 },
  warning: { color: "warning", icon: "i-lucide-triangle-alert", duration: 6000 },
  info: { color: "info", icon: "i-lucide-info", duration: 4000 },
};

// The one switch for motion, whatever the system's reduced-motion preference says: it drives motion-v here and, through
// html[data-motion], every CSS animation and transition (channel.css). Hand-rolled springs (effort slider, limit wheel)
// are outside it.
const MOTION_ENABLED = true;
document.documentElement.dataset.motion = MOTION_ENABLED ? "on" : "off";

const discussion = use_discussion();
provide("discussion", discussion);

// Only a mouse resting on a notice pauses its countdown. A click or tap would otherwise focus the notice, and the toaster
// keeps it paused while focus stays inside; a touch would pause it with nothing to resume it.
const NOTICE_EVENTS = {
  onMousedown: (event) => event.preventDefault(),
  onPointermove: (event) => { if (event.pointerType !== "mouse") event.stopPropagation(); },
  "onUpdate:open": (open) => { if (!open) resume_notices(); },
};
/** The toaster resumes on pointer leave, which never fires when the notice under the mouse closes; later notices then sat frozen. */
function resume_notices() {
  setTimeout(() => document.querySelector('ol[data-slot="viewport"]')?.dispatchEvent(new PointerEvent("pointerleave")));
}
// The close button is a bare icon; on touch screens its tap area is widened without moving it.
const NOTICE_UI = { close: "pointer-coarse:p-2.5 pointer-coarse:-m-2.5" };

// The toaster also pauses every notice while the browser window is unfocused (another app in front, or focus inside a
// frame) and resumes only on window focus, so notices sat frozen until hovered. Only the window's own blur is stopped,
// before the toaster's listener; element blurs passing through capture are untouched.
const keep_notices_running = (event) => { if (event.target === window) event.stopImmediatePropagation(); };
window.addEventListener("blur", keep_notices_running, true);
onBeforeUnmount(() => window.removeEventListener("blur", keep_notices_running, true));

// Phones show notices at the top, just below the room tabs (消息、私聊、执行…) so they cover neither those tabs nor the
// composer at the bottom (2026-11-21 user request). channel.css places the viewport at --notice-top.
const PHONE_QUERY = window.matchMedia("(max-width: 700px)");
const NOTICE_GAP_PX = 8;
const phone = ref(PHONE_QUERY.matches);
const track_phone = (event) => { phone.value = event.matches; };
PHONE_QUERY.addEventListener("change", track_phone);
onBeforeUnmount(() => PHONE_QUERY.removeEventListener("change", track_phone));
const toaster = computed(() => ({ position: phone.value ? "top-center" : "bottom-right", max: 5 }));
/** Measure where the room tabs end now; without visible tabs the room header, else the top edge. */
function place_notices() {
  if (!phone.value) return;
  const anchor = [".channel-tabbar", ".channel-header"].map((selector) => document.querySelector(selector)?.getBoundingClientRect())
    .find((rect) => rect && rect.height > 0 && rect.bottom > 0);
  document.documentElement.style.setProperty("--notice-top", `${Math.round(anchor ? anchor.bottom : 0) + NOTICE_GAP_PX}px`);
}

const toast = useToast();
/** Show the controller's notices; a repeat of one still open restarts it instead of stacking a copy. */
function show_notice({ detail: { level, message, duration, actions, id } }) {
  place_notices();
  const text = String(message);
  toast.add({ ...(NOTICE_LEVELS[level] || NOTICE_LEVELS.info), ...NOTICE_EVENTS, ui: NOTICE_UI, id: id ?? `${level}:${text}`,
    ...(duration == null ? {} : { duration }),
    ...(actions ? { actions: actions.map(action => ({ ...action, color: "neutral", variant: "soft", size: "xs" })) } : {}),
    title: text.length > NOTICE_MAX_LENGTH ? `${text.slice(0, NOTICE_MAX_LENGTH - 1)}…` : text });
}
document.addEventListener("discuss:notice", show_notice);
onBeforeUnmount(() => document.removeEventListener("discuss:notice", show_notice));

// Undo notices use the same toaster as every other notice (2026-11-16 user request: one notice bar to learn).
// Closing one by its countdown, its ×, or "查看" lets the action go ahead; "撤销" takes it back. A newer notice for the
// same target lets the older one go ahead first.
const undo_settles = new Map();
function settle_undo(id, keep) {
  const settle = undo_settles.get(id);
  if (!settle) return;
  undo_settles.delete(id);
  settle(keep);
}
// The toast shown for each target. Each showing gets its own toast id: the toaster's remove() drops every toast with the
// id 200 ms later, so reusing one took the new notice away a moment after it appeared (2026-11-16: gone in under 1 s).
const undo_toasts = new Map();
let undo_count = 0;
function show_undo({ detail }) {
  place_notices();
  settle_undo(detail.id, true);
  if (undo_toasts.has(detail.id)) toast.remove(undo_toasts.get(detail.id));
  const toast_id = `${detail.id}#${++undo_count}`;
  undo_toasts.set(detail.id, toast_id);
  undo_settles.set(detail.id, detail.settle);
  // One line like the other notices: the actions sit beside the text instead of on a row of their own.
  toast.add({ ...NOTICE_LEVELS.info, icon: "i-lucide-archive", ...NOTICE_EVENTS, ui: NOTICE_UI, id: toast_id, title: detail.message,
    orientation: "horizontal", duration: detail.duration, actions: [
      { label: t("查看"), color: "neutral", variant: "soft", size: "xs", onClick: () => detail.view?.() },
      { label: t("撤销"), color: "neutral", variant: "solid", size: "xs", onClick: () => settle_undo(detail.id, false) },
    ], "onUpdate:open": (open) => {
      if (open) return;
      resume_notices();
      if (undo_toasts.get(detail.id) === toast_id) undo_toasts.delete(detail.id);
      // An action button closes the toast before its own click handler runs, so "撤销" must get its say first.
      setTimeout(() => { if (undo_settles.get(detail.id) === detail.settle) settle_undo(detail.id, true); });
    } });
}
document.addEventListener("discuss:undo", show_undo);
onBeforeUnmount(() => document.removeEventListener("discuss:undo", show_undo));

// A passkey step waits for the user's tap: browsers only allow WebAuthn from a user action, so it runs on "confirm".
const passkey_prompt = computed(() => discussion.view.value.device?.prompt);
const passkey_open = computed({ get: () => Boolean(passkey_prompt.value), set: (open) => { if (!open) discussion.bridge.device.prompt_cancel(); } });
function confirm_passkey() {
  discussion.bridge.device.prompt_confirm()?.catch((error) => { if (!error?.cancelled) show_notice({ detail: { level: "error", message: error.message } }); });
}
</script>

<template>
  <UApp :locale="locale === 'en' ? en : zh_cn" :tooltip="{ delayDuration: 300 }" :toaster="toaster">
    <MotionConfig :reduced-motion="MOTION_ENABLED ? 'never' : 'always'">
      <ChannelWorkspace />
      <ConfirmDialog v-if="passkey_prompt" v-model:open="passkey_open" :title="passkey_prompt.title" :description="passkey_prompt.description"
        :confirm-label="passkey_prompt.confirm_label" @confirm="confirm_passkey" />
    </MotionConfig>
  </UApp>
</template>


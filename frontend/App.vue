<script setup>
import { computed, onBeforeUnmount, provide, ref } from "vue";
import { MotionConfig } from "motion-v";
import { useToast } from "@nuxt/ui/composables";
import { zh_cn } from "@nuxt/ui/locale";
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
};
// The close button is a bare icon; on touch screens its tap area is widened without moving it.
const NOTICE_UI = { close: "pointer-coarse:p-2.5 pointer-coarse:-m-2.5" };

// The toaster also pauses every notice while the browser window is unfocused (another app in front, or focus inside a
// frame) and resumes only on window focus, so notices sat frozen until hovered. Only the window's own blur is stopped,
// before the toaster's listener; element blurs passing through capture are untouched.
const keep_notices_running = (event) => { if (event.target === window) event.stopImmediatePropagation(); };
window.addEventListener("blur", keep_notices_running, true);
onBeforeUnmount(() => window.removeEventListener("blur", keep_notices_running, true));

const toast = useToast();
/** Show the controller's notices; a repeat of one still open restarts it instead of stacking a copy. */
function show_notice({ detail: { level, message } }) {
  const text = String(message);
  toast.add({ ...(NOTICE_LEVELS[level] || NOTICE_LEVELS.info), ...NOTICE_EVENTS, ui: NOTICE_UI, id: `${level}:${text}`,
    title: text.length > NOTICE_MAX_LENGTH ? `${text.slice(0, NOTICE_MAX_LENGTH - 1)}…` : text });
}
document.addEventListener("discuss:notice", show_notice);
onBeforeUnmount(() => document.removeEventListener("discuss:notice", show_notice));

// Undo notices sit at the top center, apart from the toaster: each counts down, then lets its action go ahead.
const undo_notices = ref([]);
/** Show an undo notice; a newer notice for the same target lets the older one go ahead. */
function show_undo({ detail }) {
  close_undo(detail.id, true);
  const timer = window.setTimeout(() => close_undo(detail.id, true), detail.duration);
  undo_notices.value = [...undo_notices.value, { ...detail, timer }];
}
/** Remove a notice and report whether its action goes ahead (true) or was taken back (false). */
function close_undo(id, keep) {
  const notice = undo_notices.value.find((item) => item.id === id);
  if (!notice) return;
  window.clearTimeout(notice.timer);
  undo_notices.value = undo_notices.value.filter((item) => item.id !== id);
  notice.settle(keep);
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
  <UApp :locale="zh_cn" :tooltip="{ delayDuration: 300 }" :toaster="{ position: 'bottom-right', max: 5 }">
    <MotionConfig :reduced-motion="MOTION_ENABLED ? 'never' : 'always'">
      <ChannelWorkspace />
      <ConfirmDialog v-if="passkey_prompt" v-model:open="passkey_open" :title="passkey_prompt.title" :description="passkey_prompt.description"
        :confirm-label="passkey_prompt.confirm_label" @confirm="confirm_passkey" />
      <TransitionGroup tag="div" name="undo-notice" class="undo-notices" aria-live="polite">
        <div v-for="notice in undo_notices" :key="notice.id" class="undo-notice" role="status">
          <UIcon name="i-lucide-archive" class="undo-notice-icon" /><span class="undo-notice-text" :title="notice.message">{{ notice.message }}</span>
          <UButton label="查看" size="xs" color="neutral" variant="soft" @click="notice.view()" />
          <UButton label="撤销" size="xs" color="neutral" variant="solid" @click="close_undo(notice.id, false)" />
          <UButton icon="i-lucide-x" size="xs" color="neutral" variant="ghost" aria-label="关闭提示" @click="close_undo(notice.id, true)" />
          <i class="undo-notice-countdown" :style="{ animationDuration: `${notice.duration}ms` }" aria-hidden="true"></i>
        </div>
      </TransitionGroup>
    </MotionConfig>
  </UApp>
</template>

<style scoped>
.undo-notices { position: fixed; top: 12px; left: 50%; z-index: 100; display: flex; flex-direction: column; align-items: center; gap: 8px; transform: translateX(-50%); pointer-events: none; }
.undo-notice { position: relative; display: flex; align-items: center; gap: 8px; max-width: min(520px, calc(100vw - 32px)); padding: 7px 8px 7px 12px; overflow: hidden;
  border: 1px solid var(--ui-border); border-radius: 10px; background: var(--ui-bg-elevated); box-shadow: 0 6px 20px rgb(0 0 0 / 18%); color: var(--ui-text-highlighted); font-size: 13px; pointer-events: auto; }
.undo-notice-icon { flex-shrink: 0; width: 15px; height: 15px; color: var(--ui-text-muted); }
.undo-notice-text { min-width: 0; overflow: hidden; font-weight: 500; white-space: nowrap; text-overflow: ellipsis; }
/* The bar empties over the notice's duration: the time left to take the action back. */
.undo-notice-countdown { position: absolute; left: 0; bottom: 0; width: 100%; height: 2px; background: var(--ui-text-dimmed); transform-origin: left; animation: undo-countdown linear forwards; }
@keyframes undo-countdown { from { transform: scaleX(1); } to { transform: scaleX(0); } }
.undo-notice-enter-active, .undo-notice-leave-active { transition: opacity .18s, transform .18s; }
.undo-notice-enter-from, .undo-notice-leave-to { opacity: 0; transform: translateY(-8px); }
</style>

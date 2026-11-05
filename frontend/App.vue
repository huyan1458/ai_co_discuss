<script setup>
import { computed, onBeforeUnmount, provide } from "vue";
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
    </MotionConfig>
  </UApp>
</template>

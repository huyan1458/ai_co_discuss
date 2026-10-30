<script setup>
import { onBeforeUnmount, provide } from "vue";
import { MotionConfig } from "motion-v";
import { useToast } from "@nuxt/ui/composables";
import { zh_cn } from "@nuxt/ui/locale";
import { use_discussion } from "./use-discussion.js";
import ChannelWorkspace from "./ChannelWorkspace.vue";

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

const toast = useToast();
/** Show the controller's notices; a repeat of one still open restarts it instead of stacking a copy. */
function show_notice({ detail: { level, message } }) {
  const text = String(message);
  toast.add({ ...(NOTICE_LEVELS[level] || NOTICE_LEVELS.info), id: `${level}:${text}`,
    title: text.length > NOTICE_MAX_LENGTH ? `${text.slice(0, NOTICE_MAX_LENGTH - 1)}…` : text });
}
document.addEventListener("discuss:notice", show_notice);
onBeforeUnmount(() => document.removeEventListener("discuss:notice", show_notice));
</script>

<template>
  <UApp :locale="zh_cn" :tooltip="{ delayDuration: 300 }" :toaster="{ position: 'bottom-right', max: 5 }">
    <MotionConfig :reduced-motion="MOTION_ENABLED ? 'never' : 'always'">
      <ChannelWorkspace />
    </MotionConfig>
  </UApp>
</template>

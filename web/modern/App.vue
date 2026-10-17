<script setup>
import { onBeforeUnmount, provide } from "vue";
import { MotionConfig } from "motion-v";
import { useToast } from "@nuxt/ui/composables";
import { zh_cn } from "@nuxt/ui/locale";
import { use_discussion } from "./use-discussion.js";
import ChannelWorkspace from "./ChannelWorkspace.vue";

const discussion = use_discussion();
provide("discussion", discussion);
const { view } = discussion;
const toast = useToast();

/** Route operation feedback into the active channel's accessible toaster. */
function on_toast(event) {
  if (view.value.theme !== "channel") return;
  toast.add({ title: event.detail.message, color: event.detail.is_error ? "error" : "success", duration: 3500 });
}
document.addEventListener("discuss:toast", on_toast);
onBeforeUnmount(() => document.removeEventListener("discuss:toast", on_toast));
</script>

<template>
  <UApp :locale="zh_cn" :tooltip="{ delayDuration: 300 }" :toaster="{ position: 'bottom-right' }">
    <MotionConfig reduced-motion="user">
      <ChannelWorkspace v-if="view.theme === 'channel'" />
    </MotionConfig>
  </UApp>
</template>

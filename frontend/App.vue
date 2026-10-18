<script setup>
import { provide } from "vue";
import { MotionConfig } from "motion-v";
import { zh_cn } from "@nuxt/ui/locale";
import { use_discussion } from "./use-discussion.js";
import ChannelWorkspace from "./ChannelWorkspace.vue";

const discussion = use_discussion();
provide("discussion", discussion);
const { view } = discussion;
</script>

<template>
  <UApp :locale="zh_cn" :tooltip="{ delayDuration: 300 }" :toaster="null">
    <MotionConfig reduced-motion="user">
      <ChannelWorkspace v-if="view.theme.startsWith('channel')" />
    </MotionConfig>
  </UApp>
</template>

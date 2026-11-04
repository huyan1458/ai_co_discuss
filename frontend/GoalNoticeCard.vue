<script setup>
/** A goal notice in the transcript: started, woke the host, or ended; the latest end offers to continue on the same goal. */
import { computed, inject, ref } from "vue";
import ScheduleCard from "./ScheduleCard.vue";
import StartGoalDialog from "./StartGoalDialog.vue";

const props = defineProps({ message: { type: Object, required: true } });
const { view, pending } = inject("discussion");
const room = computed(() => view.value.room);
const goal = computed(() => room.value.goal_state?.goal || null);
// Only the newest goal's end notice continues it, and not while another goal or a discussion is open.
const continuable = computed(() => goal.value && goal.value.ended_message_id === props.message.id
  && !["active", "paused"].includes(room.value.session?.status));
const icon = computed(() => continuable.value || goal.value?.ended_message_id === props.message.id ? "i-lucide-flag" : "i-lucide-target");
const continuing = ref(false);
</script>

<template>
  <ScheduleCard :icon="icon" plain :expandable="false" label="Goal">
    <template #text>{{ message.text }}</template>
    <template v-if="continuable" #actions><UButton icon="i-lucide-rotate-ccw" label="继续 Goal" size="xs" color="neutral" variant="ghost" title="沿用这个目标重新开启 Goal，需本机接入程序在运行"
      :disabled="!view.access?.can_manage || room.archived || Boolean(pending)" @click="continuing = true" /></template>
  </ScheduleCard>
  <StartGoalDialog v-if="continuable" v-model:open="continuing" continuing :initial="goal" />
</template>

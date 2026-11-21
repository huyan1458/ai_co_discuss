<script setup>
/** Why the latest discussion ended and whether its goal was met; continuing opens a new discussion on the same goal. */
import { computed, inject, ref } from "vue";
import DiscussionLimits from "./DiscussionLimits.vue";
import ScheduleCard from "./ScheduleCard.vue";
import { t } from "./i18n.js";

const { view, bridge, act, pending } = inject("discussion");
const room = computed(() => view.value.room);
// room.limits switches to the next discussion's defaults once one ends; the ended one's snapshot keeps its stop reason.
const limits = computed(() => room.value.discussions?.at(-1) || {});
const reason = computed(() => bridge.stop_reason_label(limits.value));
const done = computed(() => limits.value.stop_reason === "goal_done");
const continuing = ref(false);
const limit_picker = ref(null);
const rounds = ref(0);
const minutes = ref(0);

/** Open the dialog prefilled with the previous limits. */
function open_continue() {
  rounds.value = limits.value.max_rounds || 0;
  minutes.value = limits.value.max_minutes || 0;
  continuing.value = true;
}

/** Start again with the room goal and the chosen limits; blank or invalid numbers fall back to unlimited. */
async function submit() {
  limit_picker.value?.settle();
  const whole = (value) => Number.isInteger(value) && value >= 0 ? value : 0;
  if (await act("start_room_discussion", { max_rounds: whole(rounds.value), max_minutes: whole(minutes.value),
    named_followup: room.value.named_followup === true })) continuing.value = false;
}
</script>

<template>
  <ScheduleCard icon="i-lucide-flag" plain :expandable="false" :label="t('讨论结束')">
    <template #text>{{ t("讨论已结束：{reason}", { reason }) }} · {{ done ? t("目标已完成") : t("目标未确认完成") }}</template>
    <template v-if="!view.share" #actions><UButton icon="i-lucide-rotate-ccw" :label="t('继续讨论')" size="xs" color="neutral" variant="ghost" :title="t('沿用讨论目标，设定新的轮次与时长上限后继续，需本机接入程序在运行')" :disabled="!view.access?.can_manage || room.archived || Boolean(pending)" @click="open_continue" /></template>
  </ScheduleCard>
  <UModal :content="{ onInteractOutside: (event) => event.preventDefault() }" v-model:open="continuing" :title="t('继续讨论')" :description="t('沿用讨论目标和全部记录，按新的上限继续。')" :ui="{ content: 'glass-panel studio-modal', body: 'dialog-body' }">
    <template #body>
      <form class="end-continue" @submit.prevent="submit">
        <DiscussionLimits ref="limit_picker" v-model:rounds="rounds" v-model:minutes="minutes" :execution="false" />
        <div class="end-continue-footer">
          <UButton :label="t('取消')" color="neutral" variant="ghost" @click="continuing = false" />
          <UButton type="submit" icon="i-lucide-rotate-ccw" :label="t('继续讨论')" class="channel-primary-button" :loading="pending === 'start_room_discussion'" :disabled="Boolean(pending)" />
        </div>
      </form>
    </template>
  </UModal>
</template>

<style scoped>
.end-continue { display: grid; gap: 14px; }
.end-continue-footer { display: flex; justify-content: flex-end; gap: 8px; }
</style>

<script setup>
/** Dialog that opens a discussion in a free room: goal, round and time limits, and how the host follows up. */
import { inject, ref, watch } from "vue";
import DiscussionLimits from "./DiscussionLimits.vue";

const DEFAULT_ROUNDS = 3;
const open = defineModel("open", { type: Boolean, default: false });
const { view, act, pending } = inject("discussion");
const goal = ref("");
const rounds = ref(DEFAULT_ROUNDS);
const minutes = ref(0);
const execution_minutes = ref("");
const named_followup = ref(false);
const limits = ref(null);
// Every opening starts from the defaults rather than the previous discussion.
watch(open, (opened) => {
  if (!opened) return;
  goal.value = "";
  rounds.value = DEFAULT_ROUNDS;
  minutes.value = 0;
  execution_minutes.value = "";
  named_followup.value = false;
});

/** Open the discussion; the dialog stays open with its choices when the request fails. */
async function submit() {
  limits.value?.settle();
  const whole = (value) => Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : 0;
  const started = await act("start_room_discussion", { goal: goal.value.trim(), max_rounds: whole(rounds.value), max_minutes: whole(minutes.value),
    execution_minutes: whole(execution_minutes.value), named_followup: named_followup.value });
  if (started) open.value = false;
}
</script>

<template>
  <UModal v-model:open="open" title="开启讨论" description="主持人安排成员轮流发言；到上限或结束后，房间回到自由协作，记录全部保留。" :ui="{ content: 'glass-panel studio-modal', body: 'dialog-body' }">
    <template #body>
      <form class="start-discussion" aria-label="开启讨论" @submit.prevent="submit">
        <UFormField label="讨论目标" description="写下问题、背景和顾虑，主持人据此推进；可留空，沿用房间目标。"><UTextarea v-model="goal" :maxlength="1000" :rows="4" autoresize :maxrows="10" placeholder="例如：我们在 A、B 两个方案之间犹豫，主要顾虑是成本和上线时间……" class="w-full" /></UFormField>
        <DiscussionLimits ref="limits" v-model:rounds="rounds" v-model:minutes="minutes" v-model:execution_minutes="execution_minutes">
            <UCheckbox v-model="named_followup" label="点名追问" description="开启后，主持人每轮读完回答再逐位点名追问；关闭时专家之间互相回应、互相提问，主持人只开场和收尾。" />
          </DiscussionLimits>
        <div class="start-discussion-footer">
          <UButton label="取消" color="neutral" variant="ghost" @click="open = false" />
          <UButton type="submit" icon="i-lucide-play" label="开始讨论" class="channel-primary-button" :loading="pending === 'start_room_discussion'" :disabled="Boolean(pending) || !view.access?.can_manage" />
        </div>
      </form>
    </template>
  </UModal>
</template>

<style scoped>
.start-discussion { display: flex; flex-direction: column; gap: 14px; }
.start-discussion-footer { display: flex; justify-content: flex-end; gap: 8px; }
</style>

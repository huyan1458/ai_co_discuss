<script setup>
/** Dialog that opens a discussion in a free room: goal, round and time limits, and how the host follows up. */
import { computed, inject, ref, watch } from "vue";
import LimitPicker, { format_duration } from "./LimitPicker.vue";

const DEFAULT_ROUNDS = 3;
const MAX_EXECUTION_MINUTES = 60;
const open = defineModel("open", { type: Boolean, default: false });
const { view, act, pending } = inject("discussion");
const goal = ref("");
const rounds = ref(DEFAULT_ROUNDS);
const minutes = ref(0);
const execution_minutes = ref("");
const named_followup = ref(false);
// Every opening starts from the defaults rather than the previous discussion.
watch(open, (opened) => {
  if (!opened) return;
  goal.value = "";
  rounds.value = DEFAULT_ROUNDS;
  minutes.value = 0;
  execution_minutes.value = "";
  named_followup.value = false;
});

const limit_rule = computed(() => {
  const limits = [rounds.value && `${rounds.value} 轮`, minutes.value && format_duration(minutes.value)].filter(Boolean);
  if (!limits.length) return "不设轮次和时长上限。";
  return `最多 ${limits.join(" 或 ")}，${limits.length === 2 ? "先到则" : "到限后"}暂停，由你决定追加轮次或结束。`;
});

/** Open the discussion; the dialog stays open with its choices when the request fails. */
async function submit() {
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
        <LimitPicker :rounds="rounds" :minutes="minutes" @update:rounds="rounds = $event" @update:minutes="minutes = $event" />
        <p class="fine-print">一轮指每位专家各完成一次观点；开启后计时，暂停期间不计时。</p>
        <UCheckbox v-model="named_followup" label="点名追问" description="开启后，主持人每轮读完回答再逐位点名追问；关闭时专家之间互相回应、互相提问，主持人只开场和收尾。" />
        <UFormField label="单次 AI 执行（分钟）" description="留空或 0 表示不限"><UInput v-model="execution_minutes" type="number" :min="0" :max="MAX_EXECUTION_MINUTES" :step="1" placeholder="不限时长" class="w-full" /></UFormField>
        <p class="start-discussion-rule" aria-live="polite"><UIcon name="i-lucide-flag" />{{ limit_rule }}</p>
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
.start-discussion .fine-print { margin: -6px 0 0; }
.start-discussion-rule { display: flex; align-items: flex-start; gap: 8px; padding-top: 14px; border-top: 1px solid var(--ui-border-muted); color: var(--ui-text-muted); font-size: 12px; }
.start-discussion-rule > [class*="icon"] { flex-shrink: 0; width: 13px; height: 13px; margin-top: 2px; color: var(--channel-accent); }
.start-discussion-footer { display: flex; justify-content: flex-end; gap: 8px; }
</style>

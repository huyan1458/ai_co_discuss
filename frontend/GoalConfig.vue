<script setup>
/** The goal settings shared by every form that sets them: the objective and optional wake-up and time budgets. */
import { computed, ref } from "vue";
import LimitPicker, { format_duration } from "./LimitPicker.vue";

const MAX_OBJECTIVE_LENGTH = 2000;
const COUNT = { label: "续跑上限", unit: "次", noun: "续跑次数", group: "Goal 续跑次数和时长" };
const objective = defineModel("objective", { type: String, default: "" });
const continues = defineModel("continues", { type: Number, default: 0 });
const minutes = defineModel("minutes", { type: Number, default: 0 });
defineProps({ disabled: Boolean });
const picker = ref(null);

const rule = computed(() => {
  const limits = [continues.value && `续跑 ${continues.value} 次`, minutes.value && `用时 ${format_duration(minutes.value)}`].filter(Boolean);
  if (!limits.length) return "不设上限：直到主持人确认完成或卡住，或你结束 Goal。";
  return `最多${limits.join("或")}，${limits.length === 2 ? "先到则" : "到限后"}由主持人收尾并结束 Goal。`;
});

/** Commit the wheels' visible values before the owning form submits. */
function settle() { picker.value?.settle(); }
defineExpose({ settle });
</script>

<template>
  <fieldset class="goal-config" :disabled="disabled">
    <UFormField label="目标" description="写清要达成的结果和完成标准；主持人会持续推进，房间空闲时自动接着做。">
      <UTextarea v-model="objective" :maxlength="MAX_OBJECTIVE_LENGTH" :rows="4" autoresize :maxrows="10" placeholder="例如：修完登录页的 8 项问题，全部测试通过，并经评审确认" class="w-full" />
    </UFormField>
    <LimitPicker ref="picker" :count="COUNT" :rounds="continues" :minutes="minutes" @update:rounds="continues = $event" @update:minutes="minutes = $event" />
    <p class="fine-print">续跑指房间空闲时程序再唤醒一次主持人；开启后计时，暂停期间不计时。默认都不限。</p>
    <p class="goal-config-rule" aria-live="polite"><UIcon name="i-lucide-target" />{{ rule }}</p>
  </fieldset>
</template>

<style scoped>
.goal-config { display: flex; flex-direction: column; gap: 14px; min-width: 0; margin: 0; padding: 0; border: 0; }
.goal-config .fine-print { margin: -6px 0 0; }
.goal-config-rule { display: flex; align-items: flex-start; gap: 8px; margin: 0; padding-top: 14px; border-top: 1px solid var(--ui-border-muted); color: var(--ui-text-muted); font-size: 12px; }
.goal-config-rule > [class*="icon"] { flex-shrink: 0; width: 13px; height: 13px; margin-top: 2px; color: var(--channel-accent); }
</style>

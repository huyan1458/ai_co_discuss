<script setup>
import { t } from "./i18n.js";
/** The goal settings shared by every form that sets them: the objective and optional wake-up and time budgets. */
import { computed, ref } from "vue";
import LimitPicker, { format_duration } from "./LimitPicker.vue";

const MAX_OBJECTIVE_LENGTH = 2000;
const COUNT = { label: t("续跑上限"), unit: t("次"), noun: t("续跑次数"), group: t("Goal 续跑次数和时长") };
const objective = defineModel("objective", { type: String, default: "" });
const continues = defineModel("continues", { type: Number, default: 0 });
const minutes = defineModel("minutes", { type: Number, default: 0 });
const idle = defineModel("idle", { type: Number, default: 120 });
// Choices for how long the room stays idle before the host is woken (30–1800 seconds on the website).
const IDLE_CHOICES = [30, 60, 120, 300, 600, 900, 1800].map((value) => ({ value, label: value < 60 ? t('{count} 秒', { count: value }) : t('{count} 分钟', { count: value / 60 }) }));
defineProps({ disabled: Boolean });
const picker = ref(null);

const rule = computed(() => {
  const limits = [continues.value && t('续跑 {count} 次', { count: continues.value }), minutes.value && t('用时 {duration}', { duration: format_duration(minutes.value) })].filter(Boolean);
  if (!limits.length) return t("不设上限：直到主持人确认完成或卡住，或你结束 Goal。");
  return limits.length === 2
    ? t('最多{first}或{second}，先到则由主持人收尾并结束 Goal。', { first: limits[0], second: limits[1] })
    : t('最多{limit}，到限后由主持人收尾并结束 Goal。', { limit: limits[0] });
});

/** Commit the wheels' visible values before the owning form submits. */
function settle() { picker.value?.settle(); }
defineExpose({ settle });
</script>

<template>
  <fieldset class="goal-config" :disabled="disabled">
    <UFormField :label="t('目标')" :description="t('写清要达成的结果和完成标准；主持人会持续推进，房间空闲时自动接着做。')">
      <UTextarea v-model="objective" :maxlength="MAX_OBJECTIVE_LENGTH" :rows="4" autoresize :maxrows="10" :placeholder="t('例如：修完登录页的 8 项问题，全部测试通过，并经评审确认')" class="w-full" />
    </UFormField>
    <details class="goal-config-advanced">
      <summary><UIcon name="i-lucide-chevron-right" class="goal-config-arrow" />{{ t("高级设置") }}</summary>
      <div class="goal-config-budgets">
        <LimitPicker ref="picker" :count="COUNT" :rounds="continues" :minutes="minutes" @update:rounds="continues = $event" @update:minutes="minutes = $event" />
        <p class="fine-print">{{ t("续跑指房间空闲时程序再唤醒一次主持人；开启后计时，暂停期间不计时。默认都不限。") }}</p>
        <UFormField :label="t('空闲多久后唤醒')" :description="t('成员都做完后等这么久才唤醒主持人，留出你阅读和回复的时间。主持人声明在等后台或等你确认时不按此唤醒。')">
          <USelect v-model="idle" :items="IDLE_CHOICES" class="w-40" />
        </UFormField>
        <p class="goal-config-rule" aria-live="polite"><UIcon name="i-lucide-target" />{{ rule }}</p>
      </div>
    </details>
  </fieldset>
</template>

<style scoped>
.goal-config { display: flex; flex-direction: column; gap: 14px; min-width: 0; margin: 0; padding: 0; border: 0; }
.goal-config .fine-print { margin: -6px 0 0; }
.goal-config-advanced > summary { display: flex; align-items: center; gap: 6px; min-height: 28px; list-style: none; color: var(--ui-text-muted); font-size: 12px; cursor: pointer; }
.goal-config-advanced > summary::-webkit-details-marker { display: none; }
.goal-config-advanced > summary:hover { color: var(--ui-text-highlighted); }
.goal-config-arrow { width: 14px; height: 14px; }
.goal-config-advanced[open] .goal-config-arrow { transform: rotate(90deg); }
.goal-config-budgets { display: flex; flex-direction: column; gap: 14px; padding-top: 10px; }
.goal-config-rule { display: flex; align-items: flex-start; gap: 8px; margin: 0; padding-top: 14px; border-top: 1px solid var(--ui-border-muted); color: var(--ui-text-muted); font-size: 12px; }
.goal-config-rule > [class*="icon"] { flex-shrink: 0; width: 13px; height: 13px; margin-top: 2px; color: var(--channel-accent); }
</style>

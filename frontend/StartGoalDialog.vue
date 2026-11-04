<script setup>
/** Dialog that opens, continues or edits a room goal; one control set, shared with the create-room form. */
import { computed, inject, ref, watch } from "vue";
import GoalConfig from "./GoalConfig.vue";

const open = defineModel("open", { type: Boolean, default: false });
// edit: change the open goal; otherwise start a new one, prefilled from `initial` when continuing an ended goal.
// continuing: reopen an ended goal from its end notice, prefilled with its objective and budgets.
const props = defineProps({ edit: Boolean, continuing: Boolean, initial: { type: Object, default: null } });
const { view, act, pending } = inject("discussion");
const objective = ref("");
const continues = ref(0);
const minutes = ref(0);
const config = ref(null);
const action = computed(() => props.edit ? "update_room_goal" : "start_room_goal");
watch(open, (opened) => {
  if (!opened) return;
  objective.value = props.initial?.objective || "";
  continues.value = props.initial?.max_continues || 0;
  minutes.value = props.initial?.max_minutes || 0;
});

/** Save the goal; the dialog keeps its input when the request fails. */
async function submit() {
  config.value?.settle();
  const whole = (value) => Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : 0;
  const saved = await act(action.value, { objective: objective.value.trim(), max_continues: whole(continues.value), max_minutes: whole(minutes.value) });
  if (saved) open.value = false;
}
</script>

<template>
  <UModal :content="{ onInteractOutside: (event) => event.preventDefault() }" v-model:open="open" :title="edit ? '编辑 Goal' : continuing ? '继续 Goal' : '开启 Goal'"
    :description="edit ? '修改目标或上限，下一次唤醒主持人时生效。' : continuing ? '沿用上次的目标和上限重新开启，可先修改；记录全部保留。' : '主持人持续推进这个目标：房间空闲时自动接着做，直到完成、卡住或你结束。'" :ui="{ content: 'glass-panel studio-modal', body: 'dialog-body' }">
    <template #body>
      <form class="start-goal" aria-label="Goal 设置" @submit.prevent="submit">
        <GoalConfig ref="config" v-model:objective="objective" v-model:continues="continues" v-model:minutes="minutes" />
        <div class="start-goal-footer">
          <UButton label="取消" color="neutral" variant="ghost" @click="open = false" />
          <UButton type="submit" :icon="edit ? 'i-lucide-check' : 'i-lucide-target'" :label="edit ? '保存' : '开始 Goal'" class="channel-primary-button"
            :loading="pending === action" :disabled="Boolean(pending) || !objective.trim() || !view.access?.can_manage" />
        </div>
      </form>
    </template>
  </UModal>
</template>

<style scoped>
.start-goal { display: flex; flex-direction: column; gap: 14px; }
.start-goal-footer { display: flex; justify-content: flex-end; gap: 8px; }
</style>

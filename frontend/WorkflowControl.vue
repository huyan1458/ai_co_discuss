<script setup>
/**
 * The workflow in use, as one row shared by the right column and the room settings page: its name, its members, an
 * action that reloads it after a library edit (new cards join), and one that sends its members away and so ends it.
 * Picking it again with "/" brings them back to their sessions.
 */
import { computed, inject, ref } from "vue";
import ConfirmDialog from "./ConfirmDialog.vue";

// `dismissible` (the right column) adds a close button that only hides the row where it is shown, and leaves out the
// action that sends the members away: ending a workflow is rare, so it stays on the room settings page.
const props = defineProps({ workflow: { type: Object, required: true }, dismissible: { type: Boolean, default: false } });
defineEmits(["dismiss"]);
const { view, bridge, act, pending } = inject("discussion");
const room = computed(() => view.value.room || {});
// The members it brought who are here, without the host (who stays).
const present = computed(() => {
  const names = new Set(Object.values(props.workflow.members || {}));
  return (room.value.free?.members || []).filter((member) => names.has(member.name) && member.role !== "host" && member.status === "active");
});
const can_manage = computed(() => view.value.access?.can_manage && !room.value.archived);
// A refresh would change something: a card in the library has no active member, or the room still binds a dropped card.
const out_of_sync = computed(() => {
  const cards = props.workflow.cards;
  if (!props.workflow.available || !Array.isArray(cards)) return false;
  const members = props.workflow.members || {};
  const active = new Set((room.value.free?.members || []).filter((member) => member.status === "active").map((member) => member.name));
  return cards.some((card) => !active.has(members[card])) || Object.keys(members).some((card) => !cards.includes(card));
});
const names = computed(() => present.value.map((member) => bridge.display_name(member.name)).join("、"));
const confirming = ref(false);
const items = computed(() => [
  ...(present.value.length ? [`${names.value} 设为离开：未处理的请求取消，正在进行的工作停止；各自的会话保留。`] : []),
  "工作流随之结束：主持人留在房间，下一次任务起按普通协作工作。",
  "之后在输入框打 / 选它，可请回原成员，接着原来的会话。消息记录和项目文件不受影响。",
]);
</script>

<template>
  <div class="workflow-control" :class="workflow.available ? 'is-success' : 'is-warning'">
    <div class="workflow-control-row">
      <UIcon name="i-lucide-network" class="workflow-control-icon" />
      <span class="workflow-control-name" :title="workflow.label">{{ workflow.label }}</span>
      <span class="workflow-control-state"><span class="workflow-control-dot"></span>{{ workflow.available ? '进行中' : '不可用' }}</span>
      <button v-if="can_manage && out_of_sync" type="button" class="workflow-control-action" :disabled="Boolean(pending)" title="刷新：按工作流库里的最新版本补齐成员：新增的卡片加入、离开的请回，已删卡片的成员转为普通成员" aria-label="刷新工作流" @click="act('sync_room_workflow')"><UIcon name="i-lucide-refresh-cw" class="workflow-control-action-icon" /></button>
      <button v-if="can_manage && !dismissible" type="button" class="workflow-control-action" :disabled="Boolean(pending)" :title="present.length ? '请离成员：请离工作流带来的成员并结束工作流，会话保留' : '结束工作流'" :aria-label="present.length ? '请离成员' : '结束工作流'" @click="confirming = true"><UIcon :name="present.length ? 'i-lucide-user-minus' : 'i-lucide-square'" class="workflow-control-action-icon" /></button>
      <button v-if="dismissible" type="button" class="workflow-control-close" title="收起此区，工作流照常进行；“成员与设置”里仍可请离成员" aria-label="收起工作流区" @click="$emit('dismiss')"><UIcon name="i-lucide-x" class="workflow-control-close-icon" /></button>
    </div>
    <p v-if="!workflow.available" class="workflow-control-note is-warning">无法读取工作流，成员沿用房间里的提示词。</p>
    <p v-else-if="names" class="workflow-control-note">{{ present.map((member) => bridge.display_name(member.name)).join(' · ') }}</p>
    <ConfirmDialog v-model:open="confirming" :title="`结束工作流「${workflow.label}」`" :description="present.length ? '请离它带来的成员，暂停这套做法。' : '本房间暂停这套做法。'" :items="items"
      :confirm-label="present.length ? '请离并结束' : '结束'" @confirm="act('move_workflow_members', 'away')" />
  </div>
</template>

<style scoped>
.workflow-control-row { display: flex; align-items: center; gap: 6px; min-height: 24px; font-size: 12px; }
.workflow-control-icon { width: 14px; height: 14px; flex-shrink: 0; color: var(--ui-text-muted); }
.workflow-control-name { min-width: 0; flex: 1; overflow: hidden; color: var(--ui-text); font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }
.workflow-control-state { display: inline-flex; flex-shrink: 0; align-items: center; gap: 5px; color: var(--ui-text-muted); }
.workflow-control-dot { width: 6px; height: 6px; border-radius: 50%; background: #3fb950; }
.is-warning .workflow-control-dot { background: #e5a50a; }
.workflow-control-action { display: inline-flex; flex-shrink: 0; align-items: center; padding: 3px; border-radius: 6px; color: var(--ui-text-muted); }
.workflow-control-action-icon { width: 13px; height: 13px; }
.workflow-control-action:hover:not(:disabled) { background: var(--ui-bg-elevated); color: var(--channel-accent); }
.workflow-control-action:disabled { opacity: .5; }
.workflow-control-close { display: inline-flex; flex-shrink: 0; align-items: center; padding: 3px; border-radius: 6px; color: var(--ui-text-dimmed); }
.workflow-control-close:hover { background: var(--ui-bg-elevated); color: var(--ui-text); }
.workflow-control-close-icon { width: 12px; height: 12px; }
.workflow-control-note { margin: 2px 0 0 20px; color: var(--ui-text-dimmed); font-size: 11px; line-height: 1.5; overflow-wrap: anywhere; }
.workflow-control-note.is-warning { color: #e5a50a; }
</style>

<script setup>
/**
 * The right column's way to a workflow while the room uses none (#15749): 选择 opens the room's choices in place, this
 * project's first and then the global ones, each with its canvas as a small picture. Picking one does what "/" in the
 * message box does: it writes the workflow's `/id` there for the user to add the task and send, so the two never differ.
 */
import { computed, inject, ref, watch } from "vue";
import WorkflowThumb from "./WorkflowThumb.vue";
import { use_workflow_library, workflow_key, workflow_problem } from "./workflow-library.js";
import { t } from "./i18n.js";

const { view } = inject("discussion");
const library = use_workflow_library();
const open = ref(false);
const room_models = computed(() => view.value.launch?.room_models?.room_id === view.value.room?.id ? view.value.launch.room_models : null);
// The same lists the "/" menu reads: the room's project workflows, then the global ones; a stopped one is left out.
const groups = computed(() => [
  { key: "project", label: t("本项目工作流"), items: (room_models.value?.project_workflows || view.value.launch.project_workflows || []).map((item) => ({ scope: "project", ...item })) },
  { key: "global", label: t("全局工作流"), items: (view.value.launch.workflows || []).map((item) => ({ scope: "global", ...item })) },
].map((group) => ({ ...group, items: group.items.filter((item) => !item.disabled) })).filter((group) => group.items.length));
const all = computed(() => groups.value.flatMap((group) => group.items));
watch(open, (shown) => { if (shown) { library.refresh_list(); library.prefetch(all.value); } });
watch(() => view.value.room?.id, () => { open.value = false; });

function pick(item) {
  open.value = false;
  document.dispatchEvent(new CustomEvent("discuss:pick-workflow", { detail: item }));
}
</script>

<template>
  <div class="room-workflow-picker">
    <div class="room-workflow-picker-row">
      <span>{{ t("本房间没有启用工作流") }}</span>
      <button type="button" class="pb-link" :aria-expanded="open" @click="open = !open">{{ open ? t("收起") : t("选择") }}</button>
    </div>
    <div v-if="open" class="room-workflow-picker-list">
      <p v-if="!groups.length" class="room-workflow-picker-empty">{{ t("还没有可用的工作流，点“管理”去新建或导入。") }}</p>
      <template v-for="group in groups" :key="group.key">
        <h5>{{ group.label }}</h5>
        <button v-for="item in group.items" :key="workflow_key(item)" type="button" class="room-workflow-picker-item" :class="{ 'is-broken': workflow_problem(item) }"
          :title="workflow_problem(item) || item.description || item.label" @click="pick(item)">
          <span class="room-workflow-picker-thumb"><WorkflowThumb :flow="library.flow_of(item)" /></span>
          <span class="room-workflow-picker-text"><strong>{{ item.label }}</strong><small>{{ workflow_problem(item) || item.description || t("还没有说明") }}</small></span>
        </button>
      </template>
      <p v-if="groups.length" class="room-workflow-picker-note">{{ t("点一个会写进输入框，补上任务后发送，主持人就按它组织工作。") }}</p>
    </div>
  </div>
</template>

<style scoped>
.room-workflow-picker-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 24px; color: var(--ui-text-muted); font-size: 12px; }
.room-workflow-picker-row > .pb-link { flex-shrink: 0; margin-top: 0; }
.room-workflow-picker-list { display: grid; gap: 2px; margin-top: 6px; padding: 6px; border: 1px solid var(--ui-border-muted); border-radius: 10px; }
.room-workflow-picker-list > h5 { margin: 4px 6px 2px; color: var(--ui-text-dimmed); font-size: 11px; font-weight: 600; }
.room-workflow-picker-item { display: flex; align-items: center; gap: 10px; min-width: 0; padding: 6px; border-radius: 8px; text-align: left; }
@media (hover: hover) { .room-workflow-picker-item:hover { background: var(--channel-ghost-hover, color-mix(in srgb, var(--ui-text) 7%, transparent)); } }
.room-workflow-picker-item.is-broken { opacity: .55; }
.room-workflow-picker-thumb { flex-shrink: 0; width: 52px; height: 30px; padding: 3px; border: 1px solid var(--ui-border-muted); border-radius: 5px; background: color-mix(in srgb, var(--ui-text) 4%, transparent); }
.room-workflow-picker-text { display: grid; min-width: 0; }
.room-workflow-picker-text > strong { overflow: hidden; color: var(--ui-text); font-size: 13px; font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }
.room-workflow-picker-text > small { overflow: hidden; color: var(--ui-text-dimmed); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.room-workflow-picker-empty, .room-workflow-picker-note { margin: 4px 6px; color: var(--ui-text-dimmed); font-size: 11px; line-height: 1.5; }
</style>

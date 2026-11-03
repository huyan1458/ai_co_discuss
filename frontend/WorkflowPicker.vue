<script setup>
/** The "工作流" row shared by the new-room form and the invite dialog: choosing one adds its cards as presets. */
import { computed, inject, ref } from "vue";
import WorkflowLibrary from "./WorkflowLibrary.vue";

defineProps({ selected: { type: String, default: "" }, disabled: Boolean });
const emit = defineEmits(["choose"]);
const { view } = inject("discussion");
const workflows = computed(() => (view.value.launch.workflows || []).filter((item) => !item.error));
const managing = ref(false);
</script>

<template>
  <div v-if="view.launch.available || view.launch.remote" class="workflow-picker" role="group" aria-label="工作流">
    <span class="workflow-picker-label">工作流</span>
    <button v-for="item in workflows" :key="item.id" type="button" :disabled="disabled" :class="{ 'is-selected': selected === item.id }" :aria-pressed="selected === item.id"
      :title="`${item.description || item.label}（${item.cards} 张卡片）`" @click="emit('choose', selected === item.id ? '' : item.id)">
      <UIcon :name="selected === item.id ? 'i-lucide-check' : 'i-lucide-workflow'" />{{ item.label }}
    </button>
    <span v-if="!workflows.length" class="workflow-picker-empty">还没有工作流</span>
    <button type="button" class="workflow-picker-manage" :disabled="disabled" title="新建、导入、编辑工作流" @click="managing = true"><UIcon name="i-lucide-library" />工作流库</button>
    <WorkflowLibrary v-model:open="managing" />
  </div>
</template>

<style scoped>
.workflow-picker { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.workflow-picker-label, .workflow-picker-empty { margin-right: 2px; color: var(--ui-text-toned); font-size: 12px; }
.workflow-picker-empty { color: var(--ui-text-dimmed); }
.workflow-picker > button { display: inline-flex; align-items: center; gap: 6px; min-height: 28px; padding: 2px 10px; border: 1px solid var(--ui-border-muted); border-radius: 999px; color: var(--ui-text-toned); font-size: 12px; }
.workflow-picker > button:hover { border-color: var(--ui-border-accented); background: var(--ui-bg-elevated); color: var(--ui-text-highlighted); }
.workflow-picker > button.is-selected { border-color: var(--channel-accent); color: var(--ui-text-highlighted); }
.workflow-picker > button.workflow-picker-manage { border-style: dashed; }
.workflow-picker > button > span { width: 12px; height: 12px; }
</style>

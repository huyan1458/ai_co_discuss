<script setup>
/**
 * Browse and edit the workflow library from the new-room form or invite dialog.
 * Selection only opens its description and 查看说明 / 编辑; it never adds members or enables a workflow.
 */
import { computed, inject, ref } from "vue";
import WorkflowEditor from "./WorkflowEditor.vue";
import { workflow_files_from_folder, workflow_files_from_zip } from "./workflow-files.js";
import { access_label } from "../runner/expert_prompts.mjs";

const props = defineProps({ disabled: Boolean, remember: Boolean });
const { view, bridge } = inject("discussion");
const local_selection = ref("");
const selected = computed({
  get: () => props.remember ? view.value.launch.create_preferences?.workflow_id || "" : local_selection.value,
  set: value => { if (props.remember) bridge.write_create_preferences({ workflow_id: value }); else local_selection.value = value; },
});
const workflows = computed(() => view.value.launch.workflows || []);
const current = computed(() => workflows.value.find((item) => item.id === selected.value));
const editing = ref(false);
const editor_id = ref("");
const editor_draft = ref(null);
const viewing = ref(null);
const zip_input = ref(null), folder_input = ref(null);
const add_items = [[
  { label: "新建", icon: "i-lucide-plus", onSelect: () => open_editor("", { agents: [] }) },
  { label: "导入 zip", icon: "i-lucide-file-archive", onSelect: () => zip_input.value?.click() },
  { label: "导入文件夹", icon: "i-lucide-folder-input", onSelect: () => folder_input.value?.click() },
]];
const viewed_skill = computed(() => viewing.value ? window.discuss_markdown.render_markdown(viewing.value.skill || "") : "");

/** Open the editor on a saved workflow, or on a new or imported draft. */
function open_editor(id, draft = null) {
  editor_id.value = id;
  editor_draft.value = draft;
  editing.value = true;
}

/** Read the opened files, let the local service check them, and show the result in the editor; nothing is saved yet. */
async function import_files(read) {
  try {
    const draft = await bridge.local_request("workflows", { action: "preview", files: await read() });
    if (draft.ignored?.length) bridge.notify("warning", `已忽略不支持的文件：${draft.ignored.join("、")}`);
    open_editor("", draft);
  } catch (error) { bridge.notify("error", error.message); }
}

/** A zip chosen in the file dialog. */
function on_zip(event) {
  const [file] = event.target.files || [];
  event.target.value = "";
  if (file) import_files(() => workflow_files_from_zip(file));
}

/** A folder chosen in the directory dialog. */
function on_folder(event) {
  const files = [...event.target.files || []];
  event.target.value = "";
  if (files.length) import_files(() => workflow_files_from_folder(files));
}

/** Show the chosen workflow's SKILL.md and cards, read-only. */
async function show() {
  try { viewing.value = await bridge.local_request("workflows", { action: "get", id: selected.value }); }
  catch (error) { bridge.notify("error", error.message); }
}

/** Keep the saved workflow open for browsing without changing the room's member draft. */
async function on_saved(workflow) {
  await bridge.reload_workflows();
  selected.value = workflow.id;
}

/** Clear the library selection when the selected workflow was deleted. */
async function on_deleted(id) {
  await bridge.reload_workflows();
  if (selected.value === id) selected.value = "";
}
</script>

<template>
  <div v-if="view.launch.available || view.launch.remote" class="workflow-picker">
    <span class="workflow-picker-label">工作流</span>
    <div class="workflow-picker-chips" role="group" aria-label="工作流">
      <button v-for="item in workflows" :key="item.id" type="button" :disabled="disabled || Boolean(item.error)" :class="{ 'is-selected': selected === item.id, 'is-broken': item.error }"
        :aria-pressed="selected === item.id" :title="item.error || `${item.label}（${item.cards} 张卡片）`" @click="selected = selected === item.id ? '' : item.id">
        <UIcon :name="item.error ? 'i-lucide-triangle-alert' : selected === item.id ? 'i-lucide-check' : 'i-lucide-workflow'" />{{ item.label }}
      </button>
      <UDropdownMenu :items="add_items" :disabled="disabled" :ui="{ content: 'channel-menu' }">
        <button type="button" class="workflow-picker-add" :disabled="disabled"><UIcon name="i-lucide-plus" />添加</button>
      </UDropdownMenu>
    </div>
    <div v-if="current" class="workflow-picker-detail">
      <p>{{ current.description || '没有描述。' }}</p>
      <span class="workflow-picker-actions">
        <button type="button" @click="show"><UIcon name="i-lucide-book-open" />查看说明</button>
        <button type="button" :disabled="disabled" @click="open_editor(current.id)"><UIcon name="i-lucide-pencil" />编辑</button>
      </span>
    </div>
    <input ref="zip_input" type="file" accept=".zip,application/zip" hidden @change="on_zip" />
    <input ref="folder_input" type="file" webkitdirectory hidden @change="on_folder" />
    <WorkflowEditor v-model:open="editing" :workflow-id="editor_id" :draft="editor_draft" @saved="on_saved" @deleted="on_deleted" />
    <UModal :open="Boolean(viewing)" :title="viewing?.label || viewing?.id || ''" :description="viewing?.description || '做法说明（SKILL.md）与成员卡片'"
      :ui="{ content: 'glass-panel studio-modal workflow-viewer-modal', body: 'dialog-body' }" @update:open="(value) => { if (!value) viewing = null; }">
      <template #body>
        <div v-if="viewing" class="workflow-viewer">
          <div class="workflow-viewer-skill markdown-body" v-html="viewed_skill"></div>
          <h4>成员卡片<small>{{ viewing.agents.length }}</small></h4>
          <ul v-if="viewing.agents.length">
            <li v-for="agent in viewing.agents" :key="agent.card">
              <strong>{{ agent.label || agent.name }}</strong><small>{{ agent.name }} · {{ agent.model || '软件默认模型' }} · 项目{{ access_label(agent.project_access) }}</small>
              <p v-if="agent.description">{{ agent.description }}</p>
            </li>
          </ul>
          <p v-else class="fine-print">没有成员卡片。</p>
        </div>
      </template>
    </UModal>
  </div>
</template>

<style scoped>
/* Label and chips share the member roster's two-column layout; the detail lines up under the chips. */
.workflow-picker { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: start; gap: 6px 10px; }
.workflow-picker-label { color: var(--ui-text-toned); font-size: 12px; line-height: 30px; white-space: nowrap; }
.workflow-picker-chips { display: flex; flex-wrap: wrap; gap: 6px; min-width: 0; }
.workflow-picker-chips > button, .workflow-picker-add { display: inline-flex; align-items: center; gap: 6px; height: 30px; max-width: 100%; padding: 0 10px; border: 1px solid var(--ui-border-muted); border-radius: 999px; color: var(--ui-text-toned); font-size: 12px; }
.workflow-picker-chips > button:hover:not(:disabled), .workflow-picker-add:hover:not(:disabled) { border-color: var(--ui-border-accented); background: var(--ui-bg-elevated); color: var(--ui-text-highlighted); }
.workflow-picker-chips > button.is-selected { border-color: var(--channel-accent); color: var(--ui-text-highlighted); }
.workflow-picker-chips > button.is-broken { color: var(--ui-warning, #e0a33a); opacity: .7; }
.workflow-picker-add { border-style: dashed; }
.workflow-picker-chips span[class*="i-lucide"], .workflow-picker-add span { width: 12px; height: 12px; flex-shrink: 0; }
.workflow-picker-detail { grid-column: 2; display: grid; gap: 2px; padding: 8px 10px; border-left: 2px solid var(--channel-accent); border-radius: 0 8px 8px 0; background: var(--ui-bg-elevated); font-size: 12px; }
.workflow-picker-detail p { margin: 0; color: var(--ui-text-toned); overflow-wrap: anywhere; }
.workflow-picker-actions { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 4px; }
.workflow-picker-actions button { display: inline-flex; align-items: center; gap: 4px; color: var(--ui-text-muted); font-size: 12px; }
.workflow-picker-actions button:hover:not(:disabled) { color: var(--channel-accent); }
.workflow-picker-actions button span { width: 12px; height: 12px; }
.workflow-viewer { display: grid; gap: 12px; }
.workflow-viewer-skill { max-height: 52vh; overflow: auto; padding: 10px 12px; border: 1px solid var(--ui-border-muted); border-radius: 8px; }
.workflow-viewer h4 { display: flex; align-items: baseline; gap: 6px; margin: 0; color: var(--ui-text-highlighted); font-size: 13px; }
.workflow-viewer h4 small { color: var(--ui-text-dimmed); font-size: 11px; font-weight: 400; }
.workflow-viewer ul { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
.workflow-viewer li { padding: 8px 10px; border: 1px solid var(--ui-border-muted); border-radius: 8px; font-size: 12px; }
.workflow-viewer li strong { margin-right: 8px; color: var(--ui-text-highlighted); }
.workflow-viewer li small { color: var(--ui-text-dimmed); }
.workflow-viewer li p { margin: 2px 0 0; color: var(--ui-text-toned); }
@media (pointer: coarse) {
  .workflow-picker-label { line-height: 36px; }
  .workflow-picker-chips > button, .workflow-picker-add { height: 36px; }
}
</style>

<script setup>
/**
 * The 工作流 page: one column listing this computer's workflows, and the selected one as an infinite canvas filling the
 * rest, edited in place (cards, arrows, checkpoints). Text settings open in a drawer; 保存 writes it all at once.
 * Works with or without a room open; enabling a workflow in a room stays with the message box's "/" and the side panel.
 */
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from "vue";
import ConfirmDialog from "./ConfirmDialog.vue";
import WorkflowCanvas from "./WorkflowCanvas.vue";
import WorkflowEditor from "./WorkflowEditor.vue";
import { workflow_files_from_folder, workflow_files_from_zip } from "./workflow-files.js";
import { flow_in_use } from "../runner/workflow_flow.mjs";

const { view, bridge } = inject("discussion");
const COMMANDS_FILE = "commands.json";
const NEW_SKILL = "按流程画布的接力派活；每一棒做什么、交回什么，写在派活正文里。";
const available = computed(() => view.value.launch.available || view.value.launch.remote);
const workflows = computed(() => view.value.launch.workflows || []);
// The workflow on the canvas: a saved one (`saved_id`) or a new or imported draft; `snapshot` is how it was when loaded.
const draft = ref(null), saved_id = ref(""), snapshot = ref(""), canvas_key = ref(0);
const commands_allowed = ref(false);
const details = ref(false), busy = ref(false);
const deleting = ref(false), leaving = ref(null);
const zip_input = ref(null), folder_input = ref(null);
const add_items = [[
  { label: "新建", icon: "i-lucide-plus", onSelect: () => guard(() => edit_draft({ label: "未命名工作流", description: "", skill: NEW_SKILL, agents: [] })) },
  { label: "导入 zip", icon: "i-lucide-file-archive", onSelect: () => guard(() => zip_input.value?.click()) },
  { label: "导入文件夹", icon: "i-lucide-folder-input", onSelect: () => guard(() => folder_input.value?.click()) },
]];

/** What saving would write, the comparison for unsaved changes too: a canvas with only its start counts as none. */
function payload(value) {
  const { resources, commands: ignored, flow, directory, ...fields } = value;
  const cards = new Set(fields.agents.map((agent) => agent.card));
  const nodes = flow_in_use(flow) ? flow.nodes.filter((node) => node.type !== "card" || cards.has(node.card)) : null;
  const ids = new Set((nodes || []).map((node) => node.id));
  const saved_flow = nodes ? { nodes, edges: flow.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)) } : null;
  return { ...fields, flow: saved_flow, resources };
}
const dirty = computed(() => Boolean(draft.value) && (!saved_id.value || JSON.stringify(payload(draft.value)) !== snapshot.value));

/** Put a workflow on the canvas. */
function show(value, id) {
  draft.value = value;
  saved_id.value = id;
  commands_allowed.value = false;
  canvas_key.value++;
  // The canvas fills in a start node on mount, so the comparison is taken once it did.
  setTimeout(() => { snapshot.value = JSON.stringify(payload(draft.value)); }, 0);
}

/** A new or imported workflow, not yet saved. */
function edit_draft(value) {
  show({ agents: [], ...JSON.parse(JSON.stringify(value)), id: value.id || `workflow-${Date.now().toString(36)}` }, "");
  details.value = Boolean(value.commands?.length);
}

/** Open a saved workflow; a broken one shows its error instead. */
async function open_saved(id) {
  if (!id || workflows.value.find((item) => item.id === id)?.error) { draft.value = null; saved_id.value = id || ""; return; }
  busy.value = true;
  try { show(await bridge.local_request("workflows", { action: "get", id }), id); }
  catch (error) { bridge.notify("error", error.message); }
  finally { busy.value = false; }
}

/** Run an action that replaces the canvas, asking first when it holds unsaved changes. */
function guard(action) {
  if (dirty.value) leaving.value = action;
  else action();
}

function discard() {
  const action = leaving.value;
  leaving.value = null;
  action?.();
}

// Open the first workflow when the page opens, and keep a valid selection when the library changes.
watch(workflows, (list) => {
  if (!draft.value && !saved_id.value && list.length) open_saved(list[0].id);
  else if (saved_id.value && !list.some((item) => item.id === saved_id.value)) open_saved(list[0]?.id || "");
}, { immediate: true });
watch(available, (value) => { if (value) bridge.reload_workflows(); }, { immediate: true });

/** Read the opened files, let the local service check them, and put the result on the canvas; nothing is saved yet. */
async function import_files(read) {
  try {
    const value = await bridge.local_request("workflows", { action: "preview", files: await read() });
    if (value.ignored?.length) bridge.notify("warning", `已忽略不支持的文件：${value.ignored.join("、")}`);
    edit_draft(value);
  } catch (error) { bridge.notify("error", error.message); }
}

function on_zip(event) {
  const [file] = event.target.files || [];
  event.target.value = "";
  if (file) import_files(() => workflow_files_from_zip(file));
}

function on_folder(event) {
  const files = [...event.target.files || []];
  event.target.value = "";
  if (files.length) import_files(() => workflow_files_from_folder(files));
}

/** Save the workflow as files; the local service checks every field. A saved one keeps its folder's other files. */
async function save() {
  if (!draft.value.label.trim() || !draft.value.skill.trim()) { details.value = true; bridge.notify("warning", "请填写名称和做法说明"); return; }
  const { resources, ...edited } = payload(draft.value);
  // An import keeps its commands file only when the user allowed it; the rest of its files come along either way.
  const kept = resources && !commands_allowed.value ? Object.fromEntries(Object.entries(resources).filter(([path]) => path !== COMMANDS_FILE)) : resources;
  busy.value = true;
  try {
    const result = await bridge.local_request("workflows", { action: "save", workflow: saved_id.value ? edited : { ...edited, resources: kept } });
    bridge.notify("info", `已保存「${result.label || result.id}」`);
    await bridge.reload_workflows();
    show(result, result.id);
  } catch (error) { bridge.notify("error", error.message); }
  finally { busy.value = false; }
}

/** Ctrl+S (⌘S) saves the open workflow while this page is shown. */
function save_key(event) {
  if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "s" || !draft.value) return;
  event.preventDefault();
  if (dirty.value && !busy.value) save();
}
onMounted(() => window.addEventListener("keydown", save_key));
onBeforeUnmount(() => window.removeEventListener("keydown", save_key));

/** Delete the open workflow the user confirmed. */
async function remove() {
  deleting.value = false;
  details.value = false;
  try { await bridge.local_request("workflows", { action: "delete", id: saved_id.value }); }
  catch (error) { bridge.notify("error", error.message); return; }
  bridge.notify("info", `已删除「${draft.value?.label || saved_id.value}」`);
  draft.value = null;
  saved_id.value = "";
  await bridge.reload_workflows();
}
</script>

<template>
  <section class="workflow-library" aria-label="工作流">
    <aside class="workflow-library-list">
      <div class="workflow-library-head">
        <h2>工作流</h2>
        <UDropdownMenu v-if="available" :items="add_items" :ui="{ content: 'channel-menu' }">
          <UButton icon="i-lucide-plus" size="xs" color="neutral" variant="ghost" aria-label="新建或导入工作流" title="新建或导入" />
        </UDropdownMenu>
      </div>
      <ul role="listbox" aria-label="工作流列表">
        <li v-if="draft && !saved_id">
          <button type="button" role="option" aria-selected="true"><UIcon name="i-lucide-file-plus-2" class="workflow-library-icon" />
            <span><strong>{{ draft.label || '未命名工作流' }}</strong><small>未保存</small></span></button>
        </li>
        <li v-for="item in workflows" :key="item.id">
          <button type="button" role="option" :aria-selected="saved_id === item.id" :class="{ 'is-broken': item.error }" :title="item.error || item.description"
            @click="saved_id !== item.id && guard(() => open_saved(item.id))">
            <UIcon :name="item.error ? 'i-lucide-triangle-alert' : 'i-lucide-workflow'" class="workflow-library-icon" />
            <span><strong>{{ item.label }}</strong><small>{{ item.error ? '无法读取' : `${item.cards} 位成员` }}</small></span>
          </button>
        </li>
      </ul>
    </aside>
    <div class="workflow-library-stage">
      <WorkflowCanvas v-if="draft" :key="canvas_key" v-model:flow="draft.flow" v-model:agents="draft.agents">
        <template #actions>
          <input v-model="draft.label" class="workflow-library-name" :maxlength="32" placeholder="未命名工作流" aria-label="工作流名称" title="点击改名"
            :style="{ width: `calc(${Math.max(5, Math.min(16, (draft.label || '').length + 1))}em + 18px)` }" @keydown.enter="$event.target.blur()" />
          <i v-if="dirty" class="workflow-library-dirty" title="有未保存的修改（Ctrl+S 保存）" />
          <UTooltip text="名称、描述与做法说明（SKILL.md）"><UButton icon="i-lucide-file-text" size="sm" color="neutral" variant="ghost" aria-label="工作流说明" @click="details = true" /></UTooltip>
          <UTooltip text="保存（Ctrl+S）"><UButton icon="i-lucide-save" label="保存" size="sm" class="channel-primary-button" :disabled="!dirty" :loading="busy" @click="save" /></UTooltip>
        </template>
      </WorkflowCanvas>
      <div v-else class="workflow-library-empty">
        <template v-if="!available"><UIcon name="i-lucide-monitor-off" /><p>连接本机服务后管理工作流</p></template>
        <template v-else-if="workflows.find((item) => item.id === saved_id)?.error"><UIcon name="i-lucide-triangle-alert" /><p>{{ workflows.find((item) => item.id === saved_id).error }}</p></template>
        <template v-else-if="busy"><UIcon name="i-lucide-loader-circle" class="animate-spin" /></template>
        <template v-else>
          <UIcon name="i-lucide-workflow" />
          <UDropdownMenu :items="add_items" :ui="{ content: 'channel-menu' }"><UButton icon="i-lucide-plus" label="新建工作流" color="neutral" variant="soft" /></UDropdownMenu>
        </template>
      </div>
    </div>
    <input ref="zip_input" type="file" accept=".zip,application/zip" hidden @change="on_zip" />
    <input ref="folder_input" type="file" webkitdirectory hidden @change="on_folder" />
    <WorkflowEditor v-if="draft" v-model:open="details" v-model:workflow="draft" v-model:commands-allowed="commands_allowed" :saved="Boolean(saved_id)" @delete="deleting = true" />
    <ConfirmDialog :open="deleting" :title="`删除工作流「${draft?.label || saved_id}」`" description="工作流文件夹会从本机删除，无法撤销。"
      :items="['已启用它的房间会显示“工作流不可用”，成员改用房间里的设置。', '房间成员、消息记录和项目文件不受影响。']" confirm-label="删除" danger
      @update:open="(value) => { if (!value) deleting = false; }" @confirm="remove" />
    <ConfirmDialog :open="Boolean(leaving)" title="放弃未保存的修改？" description="当前工作流的修改还没有保存。" :items="[]" confirm-label="放弃修改" danger
      @update:open="(value) => { if (!value) leaving = null; }" @confirm="discard" />
  </section>
</template>

<style scoped>
.workflow-library { display: grid; grid-template-columns: 220px minmax(0, 1fr); height: 100%; min-height: 0; }
.workflow-library-list { display: flex; flex-direction: column; gap: 6px; min-height: 0; padding: 14px 10px; overflow-y: auto; border-right: 1px solid var(--ui-border-muted); }
.workflow-library-head { display: flex; align-items: center; justify-content: space-between; padding: 0 4px 4px; }
.workflow-library-head h2 { margin: 0; color: var(--ui-text-highlighted); font-size: 13px; font-weight: 600; }
.workflow-library-list ul { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; }
.workflow-library-list li > button { display: flex; align-items: center; gap: 8px; width: 100%; padding: 7px 8px; border-radius: 8px; text-align: left; color: var(--ui-text-toned); }
.workflow-library-list li > button:hover { background: var(--ui-bg-elevated); }
.workflow-library-list li > button[aria-selected="true"] { background: var(--ui-bg-accented); color: var(--ui-text-highlighted); }
.workflow-library-list li > button.is-broken { color: var(--ui-warning, #e0a33a); }
.workflow-library-list li > button > span:last-child { display: grid; min-width: 0; }
.workflow-library-list strong { overflow: hidden; font-size: 13px; font-weight: 500; white-space: nowrap; text-overflow: ellipsis; }
.workflow-library-list small { color: var(--ui-text-dimmed); font-size: 11px; }
.workflow-library-icon { flex-shrink: 0; width: 15px; height: 15px; }
.workflow-library-stage { position: relative; min-width: 0; min-height: 0; }
.workflow-library-empty { display: grid; place-content: center; justify-items: center; gap: 12px; height: 100%; color: var(--ui-text-muted); font-size: 13px; }
.workflow-library-empty > span:first-child { width: 36px; height: 36px; color: var(--ui-text-dimmed); }
.workflow-library-empty p { margin: 0; }
.workflow-library-name { min-width: 0; height: 30px; padding: 0 8px; border: 1px solid transparent; border-radius: 7px; background: transparent; color: var(--ui-text-highlighted);
  font-size: 13px; font-weight: 600; outline: none; }
.workflow-library-name:hover { border-color: var(--ui-border-muted); }
.workflow-library-name:focus { border-color: var(--channel-accent, var(--ui-primary)); background: var(--ui-bg); }
.workflow-library-dirty { flex-shrink: 0; width: 7px; height: 7px; margin-right: 4px; border-radius: 50%; background: var(--ui-warning, #e0a33a); }
@media (max-width: 760px) {
  .workflow-library { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); }
  .workflow-library-list { max-height: 160px; border-right: 0; border-bottom: 1px solid var(--ui-border-muted); }
}
</style>

<script setup>
/**
 * The 工作流 page: one column listing this computer's workflows, and the selected one as an infinite canvas filling the
 * middle, edited in place (cards, arrows), and its SKILL.md docked on the right, the text the host dispatches by. 保存
 * writes it all at once.
 * Works with or without a room open; enabling a workflow in a room stays with the message box's "/" and the side panel.
 * Each entry's "…" renames, disables or enables, and deletes it; the list's width is dragged at its right edge.
 */
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import ConfirmDialog from "./ConfirmDialog.vue";
import WorkflowCanvas from "./WorkflowCanvas.vue";
import WorkflowEditor from "./WorkflowEditor.vue";
import { workflow_files_from_folder, workflow_files_from_zip } from "./workflow-files.js";
import { flow_in_use } from "../runner/workflow_flow.mjs";

const { view, bridge, act } = inject("discussion");
const COMMANDS_FILE = "commands.json";
const NEW_SKILL = "按流程画布的接力派活；每一棒做什么、交回什么，写在派活正文里。";
const available = computed(() => view.value.launch.available || view.value.launch.remote);
const workflows = computed(() => view.value.launch.workflows || []);
// The workflow on the canvas: a saved one (`saved_id`) or a new or imported draft; `snapshot` is how it was when loaded.
const draft = ref(null), saved_id = ref(""), snapshot = ref(""), canvas_key = ref(0);
const commands_allowed = ref(false);
const busy = ref(false);
// The workflow whose deletion awaits confirmation (its ID), and the action waiting on "放弃未保存的修改？".
const deleting = ref(""), leaving = ref(null);
const deleting_label = computed(() => workflows.value.find((item) => item.id === deleting.value)?.label || deleting.value);
// The list column's and the SKILL.md panel's widths, dragged at their edges and remembered in this browser, and whether
// the panel is open (it is unless the user folded it away).
const LIST_WIDTH = { min: 160, max: 420, initial: 220, step: 16, key: "codiscuss.workflow_list_width" };
const SKILL_WIDTH = { min: 280, max: 760, initial: 340, step: 16, key: "codiscuss.workflow_skill_width" };
const SKILL_OPEN_KEY = "codiscuss.workflow_skill_open";
const list_width = ref(stored_width(LIST_WIDTH)), skill_width = ref(stored_width(SKILL_WIDTH));
const skill_open = ref(remembered(SKILL_OPEN_KEY) !== "0");
// A phone, and a tablet held upright, stack the page: workflows as tabs on top, then one of SKILL.md and the canvas at a
// time, starting on SKILL.md, the text the host works from. (A tablet lays the site out 1440px wide, so width alone
// cannot tell an upright tablet.)
const STACKED_QUERY = "(max-width: 760px), (pointer: coarse) and (orientation: portrait)";
const stacked_media = window.matchMedia(STACKED_QUERY);
const stacked = ref(stacked_media.matches), pane = ref("skill");
const follow_stacked = (event) => { stacked.value = event.matches; };
stacked_media.addEventListener("change", follow_stacked);
onBeforeUnmount(() => stacked_media.removeEventListener("change", follow_stacked));
const canvas = ref(null);
// The canvas was laid out hidden; place its view once it shows.
watch(pane, (value) => { if (value === "canvas") nextTick(() => requestAnimationFrame(() => canvas.value?.fit())); });
const show_skill = computed(() => Boolean(draft.value) && (stacked.value ? pane.value === "skill" : skill_open.value));
const renaming = ref(""), rename_text = ref("");
let rename_input = null;
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
  if (value.commands?.length) set_skill_open(true);
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
  if (!draft.value.label.trim() || !draft.value.skill.trim()) { set_skill_open(true); bridge.notify("warning", "请填写名称和做法说明"); return; }
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

/** Delete the workflow the user confirmed; when it was the open one, the canvas moves to the first left. */
async function remove() {
  const id = deleting.value, label = deleting_label.value;
  deleting.value = "";
  try { await bridge.local_request("workflows", { action: "delete", id }); }
  catch (error) { bridge.notify("error", error.message); return; }
  bridge.notify("info", `已删除「${label}」`);
  if (id === saved_id.value) { draft.value = null; saved_id.value = ""; }
  await bridge.reload_workflows();
}

/** An entry's "…" menu. */
function item_menu(item) {
  return [[
    { label: "重命名", icon: "i-lucide-pencil", disabled: Boolean(item.error), onSelect: () => start_rename(item) },
    { label: item.disabled ? "启用" : "停用", icon: item.disabled ? "i-lucide-circle-play" : "i-lucide-circle-pause", onSelect: () => set_disabled(item, !item.disabled) },
    { label: "复制文件夹路径", icon: "i-lucide-folder", disabled: !item.directory, onSelect: () => act("copy", item.directory) },
  ], [
    { label: "删除", icon: "i-lucide-trash-2", color: "error", onSelect: () => { deleting.value = item.id; } },
  ]];
}

/** Rename in place in the list. */
function start_rename(item) {
  rename_text.value = item.label;
  renaming.value = item.id;
  nextTick(() => { rename_input?.focus(); rename_input?.select(); });
}

/** Save the new name; the open workflow's canvas takes it without counting as an unsaved change. */
async function commit_rename() {
  const id = renaming.value, label = rename_text.value.trim();
  renaming.value = "";
  if (!id || !label || label === workflows.value.find((item) => item.id === id)?.label) return;
  try { await bridge.local_request("workflows", { action: "rename", id, label }); }
  catch (error) { bridge.notify("error", error.message); return; }
  if (id === saved_id.value && draft.value) {
    draft.value.label = label;
    snapshot.value = JSON.stringify({ ...JSON.parse(snapshot.value), label });
  }
  await bridge.reload_workflows();
}

/** Switch a workflow off (no room may enable or keep using it) or back on. */
async function set_disabled(item, disabled) {
  try { await bridge.local_request("workflows", { action: disabled ? "disable" : "enable", id: item.id }); }
  catch (error) { bridge.notify("error", error.message); return; }
  bridge.notify("info", disabled ? `已停用「${item.label}」：房间里不能再启用它，已启用的房间改用房间里的设置` : `已启用「${item.label}」`);
  await bridge.reload_workflows();
}

/** A value this browser remembers, or null (storage may be blocked). */
function remembered(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function remember(key, value) {
  try { localStorage.setItem(key, value); } catch { /* storage blocked: it lasts this visit */ }
}

/** A remembered width within its bounds. */
function stored_width(bounds) {
  return Math.min(bounds.max, Math.max(bounds.min, Number(remembered(bounds.key)) || bounds.initial));
}

/** Set the list's or the panel's width (`bounds` says which). */
function set_width(bounds, value) {
  const width = Math.round(Math.min(bounds.max, Math.max(bounds.min, value)));
  (bounds === LIST_WIDTH ? list_width : skill_width).value = width;
  remember(bounds.key, String(width));
}

/** Open or fold away the SKILL.md panel, remembered in this browser. */
function set_skill_open(open) {
  skill_open.value = open;
  remember(SKILL_OPEN_KEY, open ? "1" : "0");
}

/** Drag an edge to resize: the list's right edge grows it rightwards, the panel's left edge grows it leftwards. */
function start_resize(event, bounds) {
  const start = event.clientX, width = (bounds === LIST_WIDTH ? list_width : skill_width).value, handle = event.currentTarget;
  const direction = bounds === LIST_WIDTH ? 1 : -1;
  handle.setPointerCapture(event.pointerId);
  const move = (moved) => set_width(bounds, width + direction * (moved.clientX - start));
  const end = () => { handle.removeEventListener("pointermove", move); handle.removeEventListener("pointerup", end); handle.removeEventListener("pointercancel", end); };
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
}
</script>

<template>
  <section class="workflow-library" :class="{ 'has-skill': show_skill, 'is-stacked': stacked }" aria-label="工作流"
    :style="{ '--workflow-list-width': `${list_width}px`, '--workflow-skill-width': `${skill_width}px` }">
    <nav v-if="stacked" class="workflow-tabs" aria-label="工作流">
      <div class="workflow-tabs-scroll" role="tablist">
        <span v-if="draft && !saved_id" class="workflow-tab is-active">
          <button type="button" role="tab" aria-selected="true"><UIcon name="i-lucide-file-plus-2" class="workflow-library-icon" />{{ draft.label || '未命名工作流' }}<small>未保存</small></button>
        </span>
        <span v-for="item in workflows" :key="item.id" class="workflow-tab" :class="{ 'is-active': saved_id === item.id, 'is-disabled': item.disabled, 'is-broken': item.error }">
          <input v-if="renaming === item.id" :ref="(element) => { if (element) rename_input = element; }" v-model="rename_text" :maxlength="32" aria-label="新名称"
            @keydown.enter.prevent="commit_rename" @keydown.esc.prevent="renaming = ''" @blur="commit_rename" />
          <button v-else type="button" role="tab" :aria-selected="saved_id === item.id" :title="item.error || item.description" @click="saved_id !== item.id && guard(() => open_saved(item.id))">
            <UIcon :name="item.error ? 'i-lucide-triangle-alert' : item.disabled ? 'i-lucide-circle-pause' : 'i-lucide-workflow'" class="workflow-library-icon" />{{ item.label }}</button>
          <UDropdownMenu v-if="available && saved_id === item.id && renaming !== item.id" :items="item_menu(item)" :ui="{ content: 'channel-menu' }">
            <UButton icon="i-lucide-ellipsis" size="xs" color="neutral" variant="ghost" :aria-label="`「${item.label}」的更多操作`" />
          </UDropdownMenu>
        </span>
        <UDropdownMenu v-if="available" :items="add_items" :ui="{ content: 'channel-menu' }">
          <UButton icon="i-lucide-plus" size="xs" color="neutral" variant="ghost" aria-label="新建或导入工作流" class="workflow-tabs-add" />
        </UDropdownMenu>
      </div>
      <div v-if="draft" class="workflow-tabs-view" role="tablist" aria-label="做法说明或示意图">
        <button type="button" role="tab" :aria-selected="pane === 'skill'" aria-label="做法说明" title="做法说明" @click="pane = 'skill'"><UIcon name="i-lucide-file-text" class="workflow-library-icon" /></button>
        <button type="button" role="tab" :aria-selected="pane === 'canvas'" aria-label="示意图" title="示意图" @click="pane = 'canvas'"><UIcon name="i-lucide-network" class="workflow-library-icon" /></button>
      </div>
    </nav>
    <aside v-else class="workflow-library-list">
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
        <li v-for="item in workflows" :key="item.id" :class="{ 'is-disabled': item.disabled }">
          <span v-if="renaming === item.id" class="workflow-library-rename">
            <UIcon name="i-lucide-workflow" class="workflow-library-icon" />
            <input :ref="(element) => { if (element) rename_input = element; }" v-model="rename_text" :maxlength="32" aria-label="新名称"
              @keydown.enter.prevent="commit_rename" @keydown.esc.prevent="renaming = ''" @blur="commit_rename" />
          </span>
          <button v-else type="button" role="option" :aria-selected="saved_id === item.id" :class="{ 'is-broken': item.error }" :title="item.error || item.description"
            @click="saved_id !== item.id && guard(() => open_saved(item.id))" @dblclick="!item.error && start_rename(item)">
            <UIcon :name="item.error ? 'i-lucide-triangle-alert' : item.disabled ? 'i-lucide-circle-pause' : 'i-lucide-workflow'" class="workflow-library-icon" />
            <span><strong>{{ item.label }}</strong><small>{{ item.error ? '无法读取' : item.disabled ? `已停用 · ${item.cards} 位成员` : `${item.cards} 位成员` }}</small></span>
          </button>
          <UDropdownMenu v-if="available && renaming !== item.id" :items="item_menu(item)" :content="{ align: 'start' }" :ui="{ content: 'channel-menu' }">
            <UButton icon="i-lucide-ellipsis" size="xs" color="neutral" variant="ghost" class="workflow-library-more" :aria-label="`「${item.label}」的更多操作`" />
          </UDropdownMenu>
        </li>
      </ul>
    </aside>
    <div v-if="!stacked" class="workflow-library-resize" role="separator" aria-orientation="vertical" aria-label="调整列表宽度" tabindex="0" title="拖动调整宽度，双击还原"
      :aria-valuenow="list_width" :aria-valuemin="LIST_WIDTH.min" :aria-valuemax="LIST_WIDTH.max" @pointerdown.prevent="start_resize($event, LIST_WIDTH)" @dblclick="set_width(LIST_WIDTH, LIST_WIDTH.initial)"
      @keydown.left.prevent="set_width(LIST_WIDTH, list_width - LIST_WIDTH.step)" @keydown.right.prevent="set_width(LIST_WIDTH, list_width + LIST_WIDTH.step)" />
    <div v-show="!stacked || pane === 'canvas' || !draft" class="workflow-library-stage">
      <WorkflowCanvas v-if="draft" ref="canvas" :key="canvas_key" v-model:flow="draft.flow" v-model:agents="draft.agents" :compact="stacked" @open-skill="stacked ? (pane = 'skill') : set_skill_open(true)">
        <template #actions>
          <input v-if="!stacked" v-model="draft.label" class="workflow-library-name" :maxlength="32" placeholder="未命名工作流" aria-label="工作流名称" title="点击改名"
            :style="{ width: `calc(${Math.max(5, Math.min(16, (draft.label || '').length + 1))}em + 18px)` }" @keydown.enter="$event.target.blur()" />
          <i v-if="dirty" class="workflow-library-dirty" title="有未保存的修改（Ctrl+S 保存）" />
          <UTooltip v-if="!skill_open && !stacked" text="展开做法说明（SKILL.md）：主持人派活照着它"><UButton icon="i-lucide-panel-right-open" label="做法说明" size="sm" color="neutral" variant="ghost" @click="set_skill_open(true)" /></UTooltip>
          <UTooltip text="保存（Ctrl+S）"><UButton icon="i-lucide-save" :label="stacked ? undefined : '保存'" aria-label="保存" size="sm" class="channel-primary-button" :disabled="!dirty" :loading="busy" @click="save" /></UTooltip>
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
    <template v-if="show_skill">
      <div v-if="!stacked" class="workflow-library-resize is-skill" role="separator" aria-orientation="vertical" aria-label="调整做法说明宽度" tabindex="0" title="拖动调整宽度，双击还原"
        :aria-valuenow="skill_width" :aria-valuemin="SKILL_WIDTH.min" :aria-valuemax="SKILL_WIDTH.max" @pointerdown.prevent="start_resize($event, SKILL_WIDTH)"
        @dblclick="set_width(SKILL_WIDTH, SKILL_WIDTH.initial)" @keydown.left.prevent="set_width(SKILL_WIDTH, skill_width + SKILL_WIDTH.step)"
        @keydown.right.prevent="set_width(SKILL_WIDTH, skill_width - SKILL_WIDTH.step)" />
      <WorkflowEditor :key="canvas_key" v-model:workflow="draft" v-model:commands-allowed="commands_allowed" :saved="Boolean(saved_id)"
        :compact="stacked" @collapse="set_skill_open(false)" />
    </template>
    <ConfirmDialog :open="Boolean(deleting)" :title="`删除工作流「${deleting_label}」`" description="工作流文件夹会从本机删除，无法撤销。"
      :items="['已启用它的房间会显示“工作流不可用”，成员改用房间里的设置。', '房间成员、消息记录和项目文件不受影响。']" confirm-label="删除" danger
      @update:open="(value) => { if (!value) deleting = ''; }" @confirm="remove" />
    <ConfirmDialog :open="Boolean(leaving)" title="放弃未保存的修改？" description="当前工作流的修改还没有保存。" :items="[]" confirm-label="放弃修改" danger
      @update:open="(value) => { if (!value) leaving = null; }" @confirm="discard" />
  </section>
</template>

<style scoped>
.workflow-library { position: relative; display: grid; grid-template-columns: var(--workflow-list-width, 220px) minmax(0, 1fr); height: 100%; min-height: 0; }
.workflow-library.has-skill { grid-template-columns: var(--workflow-list-width, 220px) minmax(0, 1fr) var(--workflow-skill-width, 400px); }
.workflow-library-list { display: flex; flex-direction: column; gap: 6px; min-height: 0; padding: 14px 10px; overflow-y: auto; border-right: 1px solid var(--ui-border-muted); }
.workflow-library-head { display: flex; align-items: center; justify-content: space-between; padding: 0 4px 4px; }
.workflow-library-head h2 { margin: 0; color: var(--ui-text-highlighted); font-size: 13px; font-weight: 600; }
.workflow-library-list ul { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; }
.workflow-library-list li > button[role="option"] { display: flex; align-items: center; gap: 8px; width: 100%; padding: 7px 30px 7px 8px; border-radius: 8px; text-align: left; color: var(--ui-text-toned); }
.workflow-library-list li { position: relative; }
.workflow-library-list li.is-disabled strong, .workflow-library-list li.is-disabled .workflow-library-icon { opacity: .55; }
.workflow-library-more { position: absolute; top: 50%; right: 4px; transform: translateY(-50%); opacity: 0; transition: opacity .12s; }
.workflow-library-list li:hover .workflow-library-more, .workflow-library-list li:focus-within .workflow-library-more,
.workflow-library-list li > button[aria-selected="true"] ~ .workflow-library-more, .workflow-library-more[data-state="open"] { opacity: 1; }
@media (hover: none) { .workflow-library-more { opacity: 1; } }
.workflow-library-rename { display: flex; align-items: center; gap: 8px; padding: 4px 8px; }
.workflow-library-rename input { flex: 1; min-width: 0; height: 28px; padding: 0 6px; border: 1px solid var(--channel-accent, var(--ui-primary)); border-radius: 6px;
  background: var(--ui-bg); color: var(--ui-text-highlighted); font-size: 13px; outline: none; }
.workflow-library-resize { position: absolute; top: 0; bottom: 0; left: calc(var(--workflow-list-width, 220px) - 3px); z-index: 7; width: 6px; cursor: col-resize; touch-action: none; }
/* Touch: a wider grip for the edges (a tablet shows the desktop layout scaled down). */
@media (pointer: coarse) { .workflow-library-resize { width: 20px; margin-left: -7px; } .workflow-library-resize.is-skill { margin-left: 0; margin-right: -7px; } }
.workflow-library-resize.is-skill { left: auto; right: calc(var(--workflow-skill-width, 400px) - 3px); }
.workflow-library-resize:hover, .workflow-library-resize:focus-visible { background: color-mix(in srgb, var(--channel-accent, var(--ui-primary)) 45%, transparent); outline: none; }
.workflow-library-list li > button[role="option"]:hover { background: var(--ui-bg-elevated); }
.workflow-library-list li > button[aria-selected="true"] { background: var(--ui-bg-accented); color: var(--ui-text-highlighted); }
.workflow-library-list li > button[role="option"].is-broken { color: var(--ui-warning, #e0a33a); }
.workflow-library-list li > button[role="option"] > span:last-child { display: grid; min-width: 0; }
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
/* Stacked (phone, upright tablet): workflows as tabs like open files, one row; the rest is SKILL.md or the canvas. */
.workflow-library.is-stacked, .workflow-library.is-stacked.has-skill { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); }
.workflow-library.is-stacked :deep(.workflow-skill) { min-height: 0; border-left: 0; }
.workflow-tabs { display: flex; align-items: stretch; min-width: 0; height: 38px; border-bottom: 1px solid var(--ui-border-muted); background: var(--ui-bg-elevated); }
.workflow-tabs-scroll { display: flex; flex: 1; align-items: stretch; min-width: 0; overflow-x: auto; scrollbar-width: none; }
.workflow-tabs-scroll::-webkit-scrollbar { display: none; }
.workflow-tab { position: relative; display: flex; flex-shrink: 0; align-items: center; max-width: 220px; border-right: 1px solid var(--ui-border-muted); color: var(--ui-text-muted); }
.workflow-tab > button { display: flex; align-items: center; gap: 6px; min-width: 0; height: 100%; padding: 0 12px; overflow: hidden; font-size: 13px; white-space: nowrap; text-overflow: ellipsis; }
.workflow-tab > button small { color: var(--ui-text-dimmed); font-size: 11px; }
.workflow-tab.is-active { background: var(--ui-bg); color: var(--ui-text-highlighted); box-shadow: inset 0 2px 0 var(--channel-accent, var(--ui-primary)); }
.workflow-tab.is-active > button { padding-right: 2px; }
.workflow-tab.is-disabled > button { opacity: .6; }
.workflow-tab.is-broken { color: var(--ui-warning, #e0a33a); }
.workflow-tab > input { width: 9em; height: 26px; margin: 0 6px; padding: 0 6px; border: 1px solid var(--channel-accent, var(--ui-primary)); border-radius: 6px; background: var(--ui-bg);
  color: var(--ui-text-highlighted); font-size: 13px; outline: none; }
.workflow-tabs-add { flex-shrink: 0; align-self: center; margin: 0 4px; }
.workflow-tabs-view { display: flex; flex-shrink: 0; align-items: center; gap: 2px; padding: 0 6px; border-left: 1px solid var(--ui-border-muted); }
.workflow-tabs-view button { display: grid; place-items: center; width: 34px; height: 28px; border-radius: 7px; color: var(--ui-text-muted); }
.workflow-tabs-view button[aria-selected="true"] { background: var(--ui-bg-accented); color: var(--ui-text-highlighted); }
</style>

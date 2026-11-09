<script setup>
/**
 * The 工作流 page: the workflow library of this computer, with or without a room open. Lists every workflow; the
 * selected one shows its relay (from the flow canvas), SKILL.md and cards; 新建 / 导入 / 编辑 / 删除 all happen here.
 * Enabling a workflow in a room stays with the message box's "/" and the side panel.
 */
import { computed, inject, ref, watch } from "vue";
import ConfirmDialog from "./ConfirmDialog.vue";
import WorkflowEditor from "./WorkflowEditor.vue";
import { workflow_files_from_folder, workflow_files_from_zip } from "./workflow-files.js";
import { access_label } from "../runner/expert_prompts.mjs";
import { compile_flow } from "../runner/workflow_flow.mjs";

const { view, bridge, act } = inject("discussion");
const available = computed(() => view.value.launch.available || view.value.launch.remote);
const workflows = computed(() => view.value.launch.workflows || []);
const selected = ref("");
const detail = ref(null);
const loading = ref(false);
const editing = ref(false), editor_id = ref(""), editor_draft = ref(null);
const deleting = ref(false);
const zip_input = ref(null), folder_input = ref(null);
const add_items = [[
  { label: "新建", icon: "i-lucide-plus", onSelect: () => open_editor("", { agents: [] }) },
  { label: "导入 zip", icon: "i-lucide-file-archive", onSelect: () => zip_input.value?.click() },
  { label: "导入文件夹", icon: "i-lucide-folder-input", onSelect: () => folder_input.value?.click() },
]];
const rendered_skill = computed(() => detail.value ? window.discuss_markdown.render_markdown(detail.value.skill || "") : "");
const card_label = (agent) => agent.label || bridge.default_name(agent.name);
// The relay the canvas lays out, in words; null without a canvas.
const relay = computed(() => {
  if (!detail.value?.flow) return null;
  const labels = Object.fromEntries(detail.value.agents.map((agent) => [agent.card, card_label(agent)]));
  const compiled = compile_flow(detail.value.flow, detail.value.agents.map((agent) => agent.card), labels);
  if (compiled.errors.length) return { errors: compiled.errors };
  return { steps: compiled.steps.map((step, index) => {
    const gate = compiled.gates.find((item) => item.after === index);
    const mark = !gate ? "" : gate.repeat_from === null ? " ⏸ 主持人把关" : ` ⟲ 可从 ${labels[compiled.steps[gate.repeat_from][0]]} 再来一圈`;
    return `${step.map((card) => labels[card]).join(" + ")}${mark}`;
  }) };
});

/** Read the selected workflow in full; a broken one shows its error from the list instead. */
async function load(id) {
  detail.value = null;
  if (!id || workflows.value.find((item) => item.id === id)?.error) return;
  loading.value = true;
  try { detail.value = await bridge.local_request("workflows", { action: "get", id }); }
  catch (error) { bridge.notify("error", error.message); }
  finally { loading.value = false; }
}
watch(selected, load);
// Keep a selection while the library has one: the first workflow at first, the next one after a deletion.
watch(workflows, (list) => {
  if (!list.some((item) => item.id === selected.value)) selected.value = list[0]?.id || "";
}, { immediate: true });
watch(available, (value) => { if (value) bridge.reload_workflows(); }, { immediate: true });

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

/** Show the saved workflow, reloading it when it is the one already selected. */
async function on_saved(workflow) {
  await bridge.reload_workflows();
  if (selected.value === workflow.id) await load(workflow.id);
  else selected.value = workflow.id;
}

async function on_deleted() {
  await bridge.reload_workflows();
}

/** Delete the selected workflow the user confirmed. */
async function remove() {
  const id = selected.value;
  try { await bridge.local_request("workflows", { action: "delete", id }); }
  catch (error) { bridge.notify("error", error.message); return; }
  bridge.notify("info", `已删除工作流「${detail.value?.label || id}」`);
  deleting.value = false;
  await bridge.reload_workflows();
}
</script>

<template>
  <section class="workflow-library" aria-label="工作流">
    <p v-if="!available" class="workflow-library-empty" role="status">工作流存在运行本机服务的电脑上；连接本机服务（或已配对的电脑）后在这里管理。</p>
    <template v-else>
      <aside class="workflow-library-list">
        <div class="workflow-library-head">
          <h2>工作流<small>{{ workflows.length }}</small></h2>
          <UDropdownMenu :items="add_items" :ui="{ content: 'channel-menu' }">
            <UButton icon="i-lucide-plus" label="添加" size="xs" color="neutral" variant="soft" />
          </UDropdownMenu>
        </div>
        <ul v-if="workflows.length" role="listbox" aria-label="工作流列表">
          <li v-for="item in workflows" :key="item.id">
            <button type="button" role="option" :aria-selected="selected === item.id" :class="{ 'is-broken': item.error }" :title="item.error || item.description" @click="selected = item.id">
              <UIcon :name="item.error ? 'i-lucide-triangle-alert' : 'i-lucide-network'" class="workflow-library-icon" />
              <span><strong>{{ item.label }}</strong><small>{{ item.error ? '无法读取' : `${item.cards} 张卡片` }}</small></span>
            </button>
          </li>
        </ul>
        <p v-else class="workflow-library-hint">还没有工作流。点“添加”新建，或导入别人分享的 zip、文件夹。</p>
        <p class="workflow-library-hint">在房间里用输入框的 <code>/</code> 选工作流交给主持人启用。</p>
      </aside>
      <article class="workflow-library-detail">
        <p v-if="loading" class="workflow-library-hint">正在读取…</p>
        <p v-else-if="workflows.find((item) => item.id === selected)?.error" class="workflow-library-hint is-warn">{{ workflows.find((item) => item.id === selected).error }}</p>
        <template v-else-if="detail">
          <header class="workflow-library-title">
            <div><h3>{{ detail.label || detail.id }}</h3><p>{{ detail.description || '没有描述。' }}</p></div>
            <span class="workflow-library-actions">
              <UButton icon="i-lucide-pencil" label="编辑" size="sm" color="neutral" variant="soft" @click="open_editor(detail.id)" />
              <UButton icon="i-lucide-copy" label="复制路径" size="sm" color="neutral" variant="ghost" @click="act('copy', detail.directory)" />
              <UButton icon="i-lucide-trash-2" label="删除" size="sm" color="error" variant="ghost" @click="deleting = true" />
            </span>
          </header>
          <section class="workflow-library-block" aria-label="接力顺序">
            <h4>接力顺序</h4>
            <ol v-if="relay?.steps" class="workflow-library-relay"><li v-for="(text, index) in relay.steps" :key="index">{{ text }}</li></ol>
            <p v-else-if="relay?.errors" class="workflow-library-hint is-warn">流程画布排不成接力：{{ relay.errors.join('；') }}</p>
            <p v-else class="workflow-library-hint">没有画流程画布，由主持人按做法说明组织。点“编辑”可在画布上连好接力。</p>
          </section>
          <section class="workflow-library-block" aria-label="成员卡片">
            <h4>成员卡片<small>{{ detail.agents.length }}</small></h4>
            <ul v-if="detail.agents.length" class="workflow-library-cards">
              <li v-for="agent in detail.agents" :key="agent.card" :data-identity="bridge.identities[agent.name]?.style">
                <UAvatar :src="bridge.identities[agent.name]?.icon" :text="bridge.identities[agent.name]?.initials" :alt="agent.name" size="xs" />
                <span><strong>{{ card_label(agent) }}</strong><small>{{ agent.name }} · {{ agent.model || '软件默认模型' }} · 项目{{ access_label(agent.project_access) }}</small>
                  <em v-if="agent.description">{{ agent.description }}</em></span>
              </li>
            </ul>
            <p v-else class="workflow-library-hint">没有成员卡片。</p>
          </section>
          <section class="workflow-library-block" aria-label="做法说明">
            <h4>做法说明（SKILL.md）</h4>
            <div class="workflow-library-skill markdown-body" v-html="rendered_skill"></div>
          </section>
        </template>
        <p v-else class="workflow-library-hint">选择左侧的工作流查看。</p>
      </article>
    </template>
    <input ref="zip_input" type="file" accept=".zip,application/zip" hidden @change="on_zip" />
    <input ref="folder_input" type="file" webkitdirectory hidden @change="on_folder" />
    <WorkflowEditor v-model:open="editing" :workflow-id="editor_id" :draft="editor_draft" @saved="on_saved" @deleted="on_deleted" />
    <ConfirmDialog :open="deleting" :title="`删除工作流「${detail?.label || selected}」`" description="工作流文件夹会从本机删除，无法撤销。"
      :items="['已启用它的房间会显示“工作流不可用”，成员改用房间里的设置。', '房间成员、消息记录和项目文件不受影响。']" confirm-label="删除" danger
      @update:open="(value) => { if (!value) deleting = false; }" @confirm="remove" />
  </section>
</template>

<style scoped>
.workflow-library { display: grid; grid-template-columns: minmax(200px, 260px) minmax(0, 1fr); gap: 20px; align-items: start; }
.workflow-library-empty { grid-column: 1 / -1; margin: 24px 0; color: var(--ui-text-muted); font-size: 13px; text-align: center; }
.workflow-library-list { position: sticky; top: 0; display: grid; gap: 10px; }
.workflow-library-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.workflow-library-head h2, .workflow-library-block h4 { display: flex; align-items: baseline; gap: 6px; margin: 0; color: var(--ui-text-highlighted); font-size: 14px; font-weight: 600; }
.workflow-library-head small, .workflow-library-block h4 small { color: var(--ui-text-dimmed); font-size: 11px; font-weight: 400; }
.workflow-library-list ul { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; }
.workflow-library-list li > button { display: flex; align-items: center; gap: 8px; width: 100%; padding: 7px 8px; border-radius: 8px; text-align: left; color: var(--ui-text-toned); }
.workflow-library-list li > button:hover { background: var(--ui-bg-elevated); }
.workflow-library-list li > button[aria-selected="true"] { background: var(--ui-bg-accented); color: var(--ui-text-highlighted); }
.workflow-library-list li > button.is-broken { color: var(--ui-warning, #e0a33a); }
.workflow-library-list li > button > span:last-child { display: grid; min-width: 0; }
.workflow-library-list strong { overflow: hidden; font-size: 13px; font-weight: 500; white-space: nowrap; text-overflow: ellipsis; }
.workflow-library-list small { color: var(--ui-text-dimmed); font-size: 11px; }
.workflow-library-icon { flex-shrink: 0; width: 15px; height: 15px; }
.workflow-library-hint { margin: 0; color: var(--ui-text-muted); font-size: 12px; line-height: 1.6; }
.workflow-library-hint.is-warn { color: var(--ui-warning, #e0a33a); }
.workflow-library-hint code { padding: 0 4px; border-radius: 4px; background: var(--ui-bg-accented); }
.workflow-library-detail { display: grid; gap: 18px; min-width: 0; }
.workflow-library-title { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 10px; }
.workflow-library-title h3 { margin: 0; color: var(--ui-text-highlighted); font-size: 18px; font-weight: 600; }
.workflow-library-title p { margin: 4px 0 0; color: var(--ui-text-toned); font-size: 13px; overflow-wrap: anywhere; }
.workflow-library-actions { display: flex; flex-wrap: wrap; gap: 4px; }
.workflow-library-block { display: grid; gap: 8px; }
.workflow-library-relay { display: flex; flex-wrap: wrap; gap: 4px 0; margin: 0; padding: 0; list-style: none; counter-reset: step; font-size: 13px; color: var(--ui-text-toned); }
.workflow-library-relay li { counter-increment: step; }
.workflow-library-relay li::before { content: counter(step); display: inline-grid; place-items: center; width: 18px; height: 18px; margin-right: 5px; border-radius: 50%;
  background: color-mix(in srgb, var(--channel-accent, var(--ui-primary)) 18%, transparent); color: var(--channel-accent, var(--ui-primary)); font-size: 11px; }
.workflow-library-relay li:not(:last-child)::after { content: "→"; margin: 0 10px; color: var(--ui-text-dimmed); }
.workflow-library-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 8px; margin: 0; padding: 0; list-style: none; }
.workflow-library-cards li { display: flex; gap: 8px; padding: 9px 10px; border: 1px solid var(--ui-border-muted); border-radius: 8px; font-size: 12px; }
.workflow-library-cards li > span { display: grid; gap: 2px; min-width: 0; }
.workflow-library-cards strong { color: var(--ui-text-highlighted); font-weight: 600; }
.workflow-library-cards small { overflow: hidden; color: var(--ui-text-dimmed); white-space: nowrap; text-overflow: ellipsis; }
.workflow-library-cards em { color: var(--ui-text-toned); font-style: normal; overflow-wrap: anywhere; }
.workflow-library-skill { padding: 12px 14px; border: 1px solid var(--ui-border-muted); border-radius: 8px; }
@media (max-width: 760px) {
  .workflow-library { grid-template-columns: minmax(0, 1fr); }
  .workflow-library-list { position: static; }
}
</style>

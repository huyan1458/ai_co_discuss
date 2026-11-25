<script setup>
/**
 * The workflow's SKILL.md beside its canvas, as a docked panel: the host dispatches by this text alone, so it stays in
 * view. It reads as rendered Markdown and switches to editing the source; the one-line description heads the text and
 * scrolls away with it, and (folded) the commands an import registers sit below. The name, the folder and deletion are in the workflow list's "…" menu.
 * Like a skill, a workflow folder may carry references and other files beside SKILL.md (user 2026-11-24): the shared
 * file view (SkillFiles, as for an expert's skills) shows SKILL.md first and leads to the folder's list, where a saved
 * workflow's files are viewed, edited, created and deleted one at a time, outside the workflow's save.
 */
import { computed, inject, nextTick, ref, watch } from "vue";
import SkillFiles from "./SkillFiles.vue";
import { use_workflow_library } from "./workflow-library.js";
import { t } from "./i18n.js";

const workflow = defineModel("workflow", { type: Object, required: true });
// An import's commands run on this computer when an API member calls them, so they are kept only once the user allows them.
const commands_allowed = defineModel("commandsAllowed", { type: Boolean, default: false });
// `compact`: the stacked page (phone, upright tablet), where the panel is one of two views and cannot fold away.
// `sub`: a sub-workflow of the open workflow, named here (the page title names the workflow) and carrying no commands.
// `files`: this part's other files as `{ path relative to its folder: text }` (cards, canvas and sub-workflows excluded),
// shown while the part is not saved.
const props = defineProps({ saved: Boolean, compact: Boolean, sub: Boolean, readonly: Boolean, files: { type: Object, default: () => ({}) } });
const { view, bridge } = inject("discussion");
const MAX_SKILL = 20000;
// A workflow with no SKILL.md text yet opens in editing; otherwise the rendered text comes first.
const editing = ref(!props.readonly && !workflow.value.skill?.trim());
watch(() => props.readonly, (readonly) => { if (readonly) editing.value = false; });
const source = ref(null);
const commands = computed(() => props.sub ? [] : workflow.value.commands || []);
// An import carrying an ID already in the library replaces that workflow when saved.
const replaced = computed(() => !props.saved && !props.sub && (view.value.launch.workflows || []).find((item) => item.id === workflow.value.id));
const rendered = computed(() => editing.value ? "" : window.discuss_markdown.render_markdown(workflow.value.skill || ""));

const SKILL_FILE = "SKILL.md";
// The panel's place in the shared file view (SkillFiles): SKILL.md first.
const location = ref(SKILL_FILE);
const library = use_workflow_library();
// A saved part's files are read and written one at a time through the local service, like an expert's skills; an
// unsaved workflow or sub-workflow shows the files it was opened with, read-only until it is saved.
const disk_files = ref(null);
const live = computed(() => props.saved && !props.readonly && disk_files.value !== null);
const files = computed(() => [
  { path: SKILL_FILE, text: workflow.value.skill || "" },
  ...(disk_files.value || Object.entries(props.files).map(([path, text]) => ({ path, text }))),
]);
const digests = computed(() => new Map((disk_files.value || []).map((item) => [item.path, item.digest])));

function file_request(action, input = {}) {
  const scope = library.saved_scope.value || "global";
  return bridge.local_request("workflows", { action, id: library.saved_id.value, sub: props.sub ? workflow.value.id : "", scope,
    ...(scope === "project" && library.saved_project_id.value ? { project_id: library.saved_project_id.value } : {}), ...input });
}

async function load_files() {
  if (!props.saved) { disk_files.value = null; return; }
  try { disk_files.value = (await file_request("files")).files; }
  catch { disk_files.value = null; }
}

/** A write moves the workflow's revision; one made on the revision this page holds keeps the page's save going. */
function follow_revision(result) {
  const draft = library.draft.value;
  if (draft && draft.revision === result.revision_before) draft.revision = result.revision;
}

async function file_change(action, input) {
  try { follow_revision(await file_request(action, input)); }
  catch (error) {
    bridge.notify(error.code === "file_changed" ? "warning" : "error", error.message);
    if (error.code === "file_changed") load_files();
    throw error;
  }
  await load_files();
}

const save_file = (path, text) => file_change("file-write", { path, text, digest: digests.value.get(path) || "" })
  .then(() => bridge.notify("info", t("已保存 {value1}", { value1: path })));
const remove_file = (entry) => file_change("file-delete", { path: entry.path, digest: entry.digest });
const create_file = async (folder, name) => {
  const path = folder ? `${folder}/${name}` : name;
  await file_change("file-write", { path, text: "", digest: "" });
  return path;
};
load_files();

/** Switch to editing the source, with the cursor in it. */
function edit() {
  if (props.readonly) return;
  editing.value = true;
  nextTick(() => source.value?.focus());
}

/** The source box grows with its text, so the panel scrolls as one (description included) rather than the box alone. */
function fit_source() {
  const box = source.value;
  if (!box) return;
  box.style.height = "auto";
  box.style.height = `${box.scrollHeight + 2}px`;
}
watch([source, () => workflow.value.skill], () => nextTick(fit_source));

</script>

<template>
  <aside class="workflow-skill" :class="{ 'is-compact': compact }" :aria-label="t('工作流（SKILL.md）')">
    <header class="workflow-skill-head">
      <h3><UIcon :name="sub ? 'i-lucide-git-branch' : 'i-lucide-file-text'" class="workflow-skill-icon" />{{ sub ? t('子工作流') : t('工作流') }}<small>SKILL.md · {{ sub ? t('主持人按需照它做') : t('主持人照它派活') }}</small></h3>
      <UButton v-if="!readonly && location === SKILL_FILE" :icon="editing ? 'i-lucide-eye' : 'i-lucide-pencil'" :label="editing ? t('预览') : t('编辑')" size="xs" color="neutral" variant="soft"
        @click="editing ? (editing = false) : edit()" />
    </header>
    <SkillFiles v-model:location="location" class="workflow-skill-files" :files="files" :special="[SKILL_FILE]" :readonly="readonly || !live"
      :readonly-note="readonly ? t('只读项目目录中的工作流不可修改') : t('保存工作流后可在这里修改')" :save="save_file" :remove="remove_file"
      :removable="(entry) => !entry.directory && entry.path !== SKILL_FILE && !entry.locked" :create="create_file">
      <template #special>
      <div class="workflow-skill-body">
      <label v-if="sub" class="workflow-skill-description">
        <span>{{ t('名称') }}</span>
        <input v-model="workflow.label" :readonly="readonly" :maxlength="32" :placeholder="t('子工作流的名称')" />
      </label>
      <label class="workflow-skill-description">
        <span>{{ t('一句话描述') }} <small>{{ t('主持人凭它判断何时使用') }}</small></span>
        <textarea v-model="workflow.description" :readonly="readonly" class="workflow-description-text" rows="1" :maxlength="500" :placeholder="sub ? t('做什么、什么时候用（必填）') : t('做什么、什么时候用')" />
      </label>
      <div v-if="!sub" class="workflow-skill-meta">
        <div class="workflow-skill-meta-row">
          <label class="workflow-skill-description">
            <span>{{ t('作者') }}</span>
            <input v-model="workflow.author" :readonly="readonly" :maxlength="64" :placeholder="t('原作者或整理者（可选）')" />
          </label>
          <label class="workflow-skill-description">
            <span>{{ t('出处') }}</span>
            <input v-model="workflow.source" :readonly="readonly" :maxlength="200" :placeholder="t('来源文章、链接或实践（可选）')" />
          </label>
        </div>
        <small class="workflow-skill-meta-hint">{{ t('作者与出处仅用于展示，不发给主持人') }}</small>
      </div>
      <textarea v-if="editing" ref="source" v-model="workflow.skill" :maxlength="MAX_SKILL" class="workflow-skill-source" spellcheck="false" :aria-label="t('SKILL.md 正文')" />
      <div v-else-if="workflow.skill?.trim()" class="workflow-skill-preview markdown-body" v-html="rendered" @dblclick="edit"></div>
      <button v-else-if="!readonly" type="button" class="workflow-skill-empty" @click="edit"><UIcon name="i-lucide-pencil" class="workflow-skill-icon" />{{ t('写下主持人怎么组织这个{value1}', { value1: sub ? t('子工作流') : t('工作流') }) }}</button>
      </div>
      </template>
    </SkillFiles>
    <p v-if="editing && location === SKILL_FILE" class="workflow-skill-count">{{ (workflow.skill || '').length }} / {{ MAX_SKILL }}</p>
    <details v-if="commands.length" class="workflow-skill-commands" :open="!saved">
      <summary><UIcon name="i-lucide-terminal" class="workflow-skill-icon" />{{ t('API 成员可运行的命令（{value1}）', { value1: commands.length }) }}</summary>
      <ul>
        <li v-for="command in commands" :key="command.id" :title="command.description"><strong>{{ command.id }}</strong>
          <UBadge :label="command.access === 'read' ? t('只读') : t('会改文件')" size="sm" variant="soft" :color="command.access === 'read' ? 'neutral' : 'warning'" />
          <code>{{ command.run.join(' ') }}</code></li>
      </ul>
      <label v-if="!saved && !readonly" class="workflow-skill-grant"><input v-model="commands_allowed" type="checkbox" />{{ t('允许这些命令在本机运行') }}</label>
    </details>
    <p v-if="replaced" class="workflow-skill-warn"><UIcon name="i-lucide-triangle-alert" class="workflow-skill-icon" />{{ t('保存会覆盖库里的「{value1}」', { value1: replaced.label }) }}</p>
  </aside>
</template>

<style scoped>
.workflow-skill { display: flex; flex-direction: column; gap: 10px; height: 100%; min-height: 0; padding: 12px 14px; border-left: 1px solid var(--ui-border-muted); background: var(--ui-bg); }
.workflow-skill-icon { flex-shrink: 0; width: 14px; height: 14px; }
.workflow-skill-head { display: flex; align-items: center; gap: 6px; }
.workflow-skill-head h3 { display: flex; flex: 1; align-items: center; gap: 6px; min-width: 0; margin: 0; color: var(--ui-text-highlighted); font-size: 14px; font-weight: 600; white-space: nowrap; }
.workflow-skill-head small { overflow: hidden; color: var(--ui-text-dimmed); font-size: 11px; font-weight: 400; text-overflow: ellipsis; }
.workflow-skill-description { display: grid; gap: 4px; font-size: 12px; color: var(--ui-text-muted); }
.workflow-skill-description small { color: var(--ui-text-dimmed); }
.workflow-description-text { field-sizing: content; box-sizing: border-box; width: 100%; min-width: 0; padding: 3px 10px; border: 0; border-inline-start: 3px solid var(--ui-border-accented); border-radius: 0; background: transparent; color: var(--ui-text-muted); font: inherit; line-height: 1.6; resize: none; }
.workflow-description-text:focus-visible { outline: none; border-inline-start-color: var(--channel-accent, var(--ui-primary)); }
.workflow-skill-description input { height: 30px; padding: 0 8px; border: 1px solid var(--ui-border-muted); border-radius: 7px; background: var(--ui-bg-elevated); color: var(--ui-text);
  font-size: 13px; outline: none; }
.workflow-skill-description input:focus { border-color: var(--channel-accent, var(--ui-primary)); }
.workflow-skill-meta { display: grid; gap: 4px; }
.workflow-skill-meta-row { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.workflow-skill-meta-hint { color: var(--ui-text-dimmed); font-size: 11px; }
/* One scrolling column: the description, then the text (the source box grows to its text and fills at least the rest). */
.workflow-skill-body { display: flex; flex: 1; flex-direction: column; gap: 10px; min-height: 0; overflow-y: auto; }
.workflow-skill-source { flex: 1 0 auto; min-height: 240px; padding: 10px 12px; overflow: hidden; border: 1px solid var(--channel-accent, var(--ui-primary)); border-radius: 8px; background: var(--ui-bg-elevated);
  color: var(--ui-text); font: 13px/1.65 ui-monospace, SFMono-Regular, Consolas, monospace; resize: none; outline: none; }
.workflow-skill-preview { flex: 1 0 auto; padding: 4px 4px 12px; font-size: 13px; line-height: 1.7; }
.workflow-skill-empty { display: flex; flex: 1 0 auto; min-height: 160px; align-items: center; justify-content: center; gap: 6px; border: 1px dashed var(--ui-border-accented); border-radius: 8px;
  color: var(--ui-text-muted); font-size: 13px; }
.workflow-skill-empty:hover { color: var(--ui-text-highlighted); border-color: var(--channel-accent, var(--ui-primary)); }
.workflow-skill-count { margin: -4px 0 0; color: var(--ui-text-dimmed); font-size: 11px; text-align: right; }
.workflow-skill-commands { display: grid; gap: 6px; padding-top: 8px; border-top: 1px solid var(--ui-border-muted); }
.workflow-skill-commands summary { display: flex; align-items: center; gap: 6px; color: var(--ui-text-muted); font-size: 12px; cursor: pointer; list-style: none; }
.workflow-skill-commands summary::-webkit-details-marker { display: none; }
.workflow-skill-commands summary::after { content: "›"; margin-left: auto; transition: transform .15s; }
.workflow-skill-commands[open] summary::after { transform: rotate(90deg); }
.workflow-skill-commands[open] summary { color: var(--ui-text-highlighted); }
.workflow-skill-commands ul { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; font-size: 12px; }
.workflow-skill-commands li { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.workflow-skill-commands code { flex-basis: 100%; overflow-wrap: anywhere; color: var(--ui-text-muted); }
.workflow-skill-grant, .workflow-skill-warn { display: flex; gap: 6px; align-items: center; margin: 0; color: var(--ui-warning, #e0a33a); font-size: 12px; }
.workflow-skill-files { flex: 1; }
/* Stacked page: tighter, the subtitle gives way to the text. */
.workflow-skill.is-compact { gap: 8px; padding: 8px 12px; }
.workflow-skill.is-compact .workflow-skill-head small, .workflow-skill.is-compact .workflow-skill-description small, .workflow-skill.is-compact .workflow-skill-meta-hint { display: none; }
.workflow-skill.is-compact .workflow-skill-meta-row { grid-template-columns: minmax(0, 1fr); }
</style>

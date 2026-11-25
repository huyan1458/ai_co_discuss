<script setup>
/**
 * One skill-shaped folder (SKILL.md plus references and other files) in the 文件 page's style (user 2026-11-24): a path
 * bar, a folder's list, and a file read as rendered Markdown or edited as text. The workflow's SKILL.md panel and an
 * expert's skills both show their files with it.
 *
 * Input: `files` `[{ path, text, locked? }]` (`text` null: not text or too large, so not shown; `locked`: read-only),
 * `folders` (paths listed even when empty), `notes` `{ path: line }` shown under a row's name. The async `save(path,
 * text)`, `remove(entry)` and `create(folder, name)` (resolving to the new file's path) are optional; they reject after
 * telling the user why. Without `save`, or with `readonly`, every file is read-only (`readonly_note` says why). Paths in
 * `special` are shown by the `special` slot instead (the workflow's SKILL.md, with its description fields).
 * `location` (v-model): a file path, or a folder path ending in "/" ("" is the top).
 */
import { computed, nextTick, reactive, ref, watch } from "vue";
import { file_size, file_type } from "./file-preview.js";
import { t } from "./i18n.js";

const props = defineProps({
  files: { type: Array, default: () => [] },
  folders: { type: Array, default: () => [] },
  notes: { type: Object, default: () => ({}) },
  rootLabel: { type: String, default: "" },
  special: { type: Array, default: () => [] },
  readonly: Boolean,
  readonlyNote: { type: String, default: "" },
  save: { type: Function, default: null },
  remove: { type: Function, default: null },
  removable: { type: Function, default: () => true },
  create: { type: Function, default: null },
  canCreate: { type: Function, default: () => true },
});
const location = defineModel("location", { type: String, default: "" });
const MARKDOWN = /\.(md|markdown)$/i;
const FILE_NAME = /^[^./\\:*?"<>|\x00-\x1f][^/\\:*?"<>|\x00-\x1f]{0,99}$/;
const encoder = new TextEncoder();

// Unsaved text by path: it survives moving around the folder, and a row with one is marked.
const drafts = reactive({});
const editing = ref(false), saving = ref(false), armed = ref(""), creating = ref(false), new_name = ref("");
// A long path scrolls in its own strip, its end (where the user is) in view; the file's buttons stay beside it.
const crumb_bar = ref(null);
watch(location, () => nextTick(() => { if (crumb_bar.value) crumb_bar.value.scrollLeft = crumb_bar.value.scrollWidth; }));

const is_folder = computed(() => location.value === "" || location.value.endsWith("/"));
const folder = computed(() => is_folder.value ? location.value.replace(/\/$/, "") : location.value.split("/").slice(0, -1).join("/"));
const crumbs = computed(() => {
  const parts = location.value.split("/").filter(Boolean);
  return parts.map((name, index) => ({ name, target: parts.slice(0, index + 1).join("/") + (index === parts.length - 1 && !is_folder.value ? "" : "/") }));
});
const by_path = computed(() => new Map(props.files.map((item) => [item.path, item])));
/** The shown folder's folders (with how many files lie below) and files: folders first, SKILL.md first among files. */
const entries = computed(() => {
  const prefix = folder.value ? `${folder.value}/` : "";
  const folders = new Map(), files = [];
  const add_folder = (rest, counted) => { const name = rest.split("/")[0]; folders.set(name, (folders.get(name) || 0) + (counted ? 1 : 0)); };
  for (const path of props.folders) if (path.startsWith(prefix) && path.length > prefix.length) add_folder(path.slice(prefix.length), false);
  for (const item of props.files) {
    if (!item.path.startsWith(prefix)) continue;
    const rest = item.path.slice(prefix.length);
    if (rest.includes("/")) add_folder(rest, true);
    else files.push({ ...item, name: rest });
  }
  return [
    ...[...folders].sort(([a], [b]) => a.localeCompare(b)).map(([name, count]) => ({ name, path: prefix + name, directory: true, count })),
    ...files.sort((a, b) => (b.name === "SKILL.md") - (a.name === "SKILL.md") || a.name.localeCompare(b.name)),
  ];
});
const current = computed(() => is_folder.value ? null : by_path.value.get(location.value) || null);
const writable = computed(() => Boolean(current.value && props.save && !props.readonly && current.value.text !== null && !current.value.locked));
const text = computed({
  get: () => drafts[location.value] ?? current.value?.text ?? "",
  set: (value) => { drafts[location.value] = value; },
});
const edited = computed(() => Boolean(current.value) && Object.hasOwn(drafts, location.value) && drafts[location.value] !== current.value.text);
const rendered = computed(() => current.value && !editing.value && MARKDOWN.test(location.value) ? window.discuss_markdown.render_markdown(text.value) : "");

/** Markdown opens as its rendered text (or as the edit left unsaved); other text opens in the editor when it can be changed. */
watch(location, () => {
  editing.value = writable.value && (!MARKDOWN.test(location.value) || Object.hasOwn(drafts, location.value));
  armed.value = ""; creating.value = false;
}, { immediate: true });
// A file read again with the draft's text, or gone, has no unsaved text left.
watch(() => props.files, () => {
  for (const path of Object.keys(drafts)) if (by_path.value.get(path)?.text === drafts[path] || !by_path.value.has(path)) delete drafts[path];
});

function size_of(entry) {
  if (entry.directory) return t("{value1} 项", { value1: entry.count });
  return entry.text === null ? "" : file_size(encoder.encode(drafts[entry.path] ?? entry.text).length);
}

/**
 * A relative link in a rendered file (README's `世界.md`) opens that file or folder here instead of leaving the page;
 * links with a scheme, fragments and paths leaving the folder behave as links.
 */
function follow_link(event) {
  const anchor = event.target.closest?.("a[href]");
  const href = anchor && decodeURIComponent(anchor.getAttribute("href").split("#")[0]);
  if (!href || /^([a-z][a-z0-9+.-]*:|\/)/i.test(href)) return;
  const parts = folder.value ? folder.value.split("/") : [];
  for (const part of href.split("/")) {
    if (part === "..") { if (!parts.length) return; parts.pop(); }
    else if (part && part !== ".") parts.push(part);
  }
  const path = parts.join("/");
  event.preventDefault();
  if (by_path.value.has(path)) location.value = path;
  else if (entries_below(path)) location.value = `${path}/`;
}
const entries_below = (path) => props.files.some((item) => item.path.startsWith(`${path}/`)) || props.folders.includes(path);

async function save_current() {
  if (!edited.value || saving.value) return;
  const path = location.value, value = drafts[path];
  saving.value = true;
  try { await props.save(path, value); }
  catch { /* the caller told the user why; the text stays unsaved */ }
  finally { saving.value = false; }
}

/** Deleting asks a second click on the same row. */
async function remove_entry(entry) {
  if (armed.value !== entry.path) { armed.value = entry.path; return; }
  armed.value = "";
  try { await props.remove(entry); } catch { /* told already */ }
}

async function create_file() {
  const name = new_name.value.trim();
  if (!FILE_NAME.test(name)) return;
  try {
    const path = await props.create(folder.value, name);
    creating.value = false; new_name.value = "";
    if (path) location.value = path;
  } catch { /* told already */ }
}
</script>

<template>
  <section class="skill-files">
    <nav class="skill-files-path" :aria-label="t('文件路径')">
      <div ref="crumb_bar" class="skill-files-crumbs">
        <button type="button" :disabled="location === ''" :aria-current="location === '' ? 'location' : undefined" @click="location = ''">{{ rootLabel || t('文件') }}</button>
        <template v-for="(part, index) in crumbs" :key="part.target">
          <UIcon name="i-lucide-chevron-right" class="skill-files-separator" />
          <button type="button" :disabled="index === crumbs.length - 1" :aria-current="index === crumbs.length - 1 ? 'location' : undefined" @click="location = part.target">{{ part.name }}</button>
        </template>
      </div>
      <span class="skill-files-tools">
        <template v-if="current && !special.includes(location) && writable">
          <UButton v-if="MARKDOWN.test(location)" :icon="editing ? 'i-lucide-eye' : 'i-lucide-pencil'" :label="editing ? t('预览') : t('编辑')" size="xs" color="neutral" variant="ghost" @click="editing = !editing" />
          <UButton :label="t('保存')" icon="i-lucide-save" size="xs" :disabled="!edited" :loading="saving" @click="save_current" />
        </template>
        <UButton v-else-if="is_folder && create && !readonly && canCreate(folder)" icon="i-lucide-file-plus" size="xs" color="neutral" variant="ghost" :aria-label="t('新建文件')" :title="t('新建文件')" @click="creating = !creating" />
      </span>
    </nav>

    <div v-if="is_folder" class="skill-files-rows">
      <form v-if="creating" class="skill-files-create" @submit.prevent="create_file">
        <UIcon name="i-lucide-file-plus" class="skill-files-icon" />
        <input v-model="new_name" :placeholder="t('文件名，如 notes.md')" :aria-label="t('文件名')" maxlength="100" @keydown.esc.prevent="creating = false" />
        <UButton type="submit" :label="t('创建')" size="xs" :disabled="!FILE_NAME.test(new_name.trim())" />
      </form>
      <div v-for="entry in entries" :key="entry.path" class="skill-files-row">
        <button type="button" class="skill-files-name" :title="notes[entry.path] || entry.name" @click="location = entry.directory ? `${entry.path}/` : entry.path">
          <UIcon :name="entry.directory ? 'i-lucide-folder' : entry.text === null ? 'i-lucide-file-x' : file_type(entry.name)[1]" class="skill-files-icon" :class="{ 'is-folder': entry.directory }" />
          <span><span>{{ entry.name }}</span><small v-if="notes[entry.path]">{{ notes[entry.path] }}</small></span>
        </button>
        <span class="skill-files-size"><i v-if="Object.hasOwn(drafts, entry.path)" class="skill-files-dirty" :title="t('有未保存的修改')" />{{ size_of(entry) }}</span>
        <UButton v-if="remove && !readonly && removable(entry)" icon="i-lucide-trash-2" size="xs" :color="armed === entry.path ? 'error' : 'neutral'" variant="ghost"
          :label="armed === entry.path ? t('确认删除') : undefined" :aria-label="t('删除 {value1}', { value1: entry.name })" class="skill-files-remove" :class="{ 'is-armed': armed === entry.path }" @click="remove_entry(entry)" />
      </div>
      <p v-if="!entries.length && !creating" class="skill-files-empty"><UIcon name="i-lucide-folder-open" />{{ t('此文件夹为空') }}</p>
    </div>
    <div v-else-if="special.includes(location)" class="skill-files-body"><slot name="special" :path="location" /></div>
    <p v-else-if="!current" class="skill-files-empty">{{ t('文件不存在或已删除') }}</p>
    <p v-else-if="current.text === null" class="skill-files-empty">{{ t('不是文本或超过大小上限，不能在这里查看和修改。') }}</p>
    <div v-else class="skill-files-body">
      <p v-if="!writable" class="skill-files-note">{{ current.locked ? t('只读：登记的命令须在导入时经你允许') : readonlyNote || t('只读') }}</p>
      <textarea v-if="editing" v-model="text" class="skill-files-source" spellcheck="false" :aria-label="location" @keydown.ctrl.s.prevent.stop="save_current" @keydown.meta.s.prevent.stop="save_current" />
      <div v-else-if="MARKDOWN.test(location)" class="skill-files-preview markdown-body" v-html="rendered" @click="follow_link" @dblclick="writable && (editing = true)"></div>
      <pre v-else class="skill-files-pre">{{ text }}</pre>
    </div>
  </section>
</template>

<style scoped>
/* Fills its parent: the path bar on top, then one scrolling column. The bar and rows follow the 文件 page (ProjectFiles.vue). */
.skill-files { display: flex; flex-direction: column; gap: 8px; height: 100%; min-height: 0; }
.skill-files-path { display: flex; align-items: center; min-height: 30px; font-size: 12px; }
.skill-files-crumbs { display: flex; flex: 1; flex-wrap: nowrap; align-items: center; gap: 1px; min-width: 0; overflow-x: auto; scrollbar-width: none; }
.skill-files-crumbs > * { flex-shrink: 0; }
.skill-files-crumbs > button { padding: 2px 5px; border-radius: 5px; color: var(--ui-text-muted); white-space: nowrap; }
@media (hover: hover) { .skill-files-crumbs > button:hover:not(:disabled) { background: var(--ui-bg-accented); color: var(--ui-text); } }
.skill-files-crumbs > button[aria-current] { color: var(--ui-text-highlighted); font-weight: 600; }
.skill-files-separator { width: 12px; height: 12px; color: var(--ui-text-dimmed); }
.skill-files-tools { display: flex; flex-shrink: 0; align-items: center; gap: 4px; padding-left: 8px; }
.skill-files-rows, .skill-files-body { display: flex; flex: 1; flex-direction: column; min-height: 0; overflow-y: auto; }
.skill-files-body { gap: 8px; }
.skill-files-icon { flex-shrink: 0; width: 14px; height: 14px; }
.skill-files-icon.is-folder { color: #dcb67a; }
.skill-files-row { display: flex; align-items: center; gap: 6px; min-height: 34px; padding: 0 4px 0 8px; border-radius: 6px; font-size: 13px; }
@media (hover: hover) { .skill-files-row:hover { background: var(--ui-bg-accented); } }
.skill-files-name { display: flex; flex: 1; align-items: center; gap: 9px; min-width: 0; padding: 4px 0; text-align: left; cursor: pointer; }
.skill-files-name > span { display: flex; flex-direction: column; min-width: 0; line-height: 1.3; }
.skill-files-name > span > * { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.skill-files-name small { color: var(--ui-text-dimmed); font-size: 11px; }
.skill-files-size { display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0; color: var(--ui-text-dimmed); font-size: 12px; font-variant-numeric: tabular-nums; }
.skill-files-dirty { width: 7px; height: 7px; border-radius: 50%; background: var(--ui-warning, #e0a33a); }
/* The delete key shows on hover or focus (always on touch), and stays while it waits for the second click. */
@media (hover: hover) { .skill-files-remove:not(.is-armed) { opacity: 0; } .skill-files-row:hover .skill-files-remove, .skill-files-remove:focus-visible { opacity: 1; } }
.skill-files-create { display: flex; align-items: center; gap: 8px; padding: 4px 8px; }
.skill-files-create input { flex: 1; min-width: 0; height: 28px; padding: 0 8px; border: 1px solid var(--ui-border-accented); border-radius: 6px; background: var(--ui-bg); font-size: 13px; }
.skill-files-empty { display: flex; align-items: center; justify-content: center; gap: 8px; margin: 0; padding: 32px 12px; color: var(--ui-text-muted); font-size: 13px; }
.skill-files-note { margin: 0; color: var(--ui-text-dimmed); font-size: 11px; }
.skill-files-source { flex: 1 0 auto; min-height: 240px; padding: 10px 12px; border: 1px solid var(--channel-accent, var(--ui-primary)); border-radius: 8px; background: var(--ui-bg-elevated);
  color: var(--ui-text); font: 12px/1.65 ui-monospace, SFMono-Regular, Consolas, monospace; resize: none; outline: none; }
.skill-files-preview { flex: 1 0 auto; padding: 4px 4px 12px; font-size: 13px; line-height: 1.7; }
.skill-files-pre { flex: 1 0 auto; margin: 0; padding: 10px 12px; border: 1px solid var(--ui-border-muted); border-radius: 8px; background: var(--ui-bg-elevated);
  color: var(--ui-text); font: 12px/1.6 ui-monospace, SFMono-Regular, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
/* Touch (phone, tablet): rows and path steps take a finger, like the 主线与子工作流 list (40px rows). */
@media (pointer: coarse) {
  .skill-files-path { min-height: 36px; }
  .skill-files-crumbs > button { min-height: 32px; padding: 4px 8px; }
  .skill-files-row { min-height: 40px; }
  .skill-files-create input { height: 34px; }
}
</style>

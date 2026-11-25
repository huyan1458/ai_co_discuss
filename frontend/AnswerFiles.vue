<script>
// Keep verified cards when switching away from a room unmounts its transcript.
const found_files = new Map();
</script>
<script setup>
/**
 * The files an answer delivers, as cards under its text that open in the file preview. A file counts when the answer
 * names it (inline code or a link) and it changed on the computer after the answer's execution began, so a file made by
 * a script or in a folder outside Git shows too, and a file the answer only mentions does not. A file also attached to
 * the answer under the same name shows only as the attachment (user 2026-11-22): the attachment is the delivered copy.
 */
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { t } from "./i18n.js";
import { file_preview } from "./file-preview.js";
import { open_deploy } from "./sites.js";

// What counts as a deliverable: documents, tables, slides, pages and media, not source code.
const DELIVERABLE = /\.(docx?|xlsx?|ods|csv|tsv|pptx?|pdf|md|txt|html?|png|jpe?g|gif|webp|svg|mp3|wav|m4a|mp4|webm|mov|srt|vtt)$/i;
const MAX_FILES = 6;
// Start reading well before the card scrolls into view, measured against the transcript that scrolls it: against the
// window the transcript clips the card, so reading began only once it showed and the cards popped in under the reader,
// moving the cards below (user 2026-11-21).
const READ_AHEAD = "800px 0px";

const props = defineProps({
  message: { type: Object, required: true },
  roomId: { type: String, required: true },
  /** When the answer's execution began, in seconds. */
  startedAt: { type: Number, required: true },
  /** The answer's attachments; a file of the same name is not shown again. */
  attachments: { type: Array, default: () => [] },
});
const { view, bridge } = inject("discussion");

const directories = computed(() => {
  const models = view.value.launch?.room_models;
  return models?.room_id === props.roomId ? [models.project_directory, ...(models.extra_directories || [])].filter(Boolean) : [];
});
const candidates = computed(() => named_paths(props.message.text));
const lookup_key = computed(() => {
  const models = view.value.launch?.room_models;
  if (!candidates.value.length || models?.room_id !== props.roomId) return "";
  if (!directories.value.length && (models.loading || models.error)) return "";
  return JSON.stringify([props.roomId, props.message.id, props.startedAt, candidates.value, directories.value]);
});
// The same answer without its directories: right after a room switch they are not read yet, so the cards found on the
// last visit show at once instead of popping in half a second later and moving the cards below (user 2026-11-24).
const message_key = computed(() => JSON.stringify([props.roomId, props.message.id, props.startedAt, candidates.value]));
const files = ref([]);
const nearby = ref(false);
const shown_files = computed(() => {
  const attached = new Set(props.attachments.map((file) => String(file.file_name).toLowerCase()));
  return files.value.filter((file) => !attached.has(file.name.toLowerCase()));
});
const anchor = ref(null);
let observer = null;

/** The paths an answer names in inline code or links, leaving out code blocks. */
function named_paths(text) {
  const prose = String(text || "").replace(/```[\s\S]*?```/g, "");
  const named = [...prose.matchAll(/`([^`\n]+)`|\]\(([^)\n]+)\)/g)].map((match) => (match[1] || match[2]).trim());
  return [...new Set(named)].filter((path) => DELIVERABLE.test(path) && !/^[a-z][a-z0-9+.-]+:\/\//i.test(path)).slice(0, MAX_FILES);
}

/** Where a named path may lie, as `{ path, root }` relative to the room's project directories. */
function locations(named) {
  const path = named.replaceAll("\\", "/").replace(/^\.\//, "");
  if (path.split("/").includes("..")) return [];
  if (!/^([a-z]:)?\//i.test(path)) return (directories.value.length ? directories.value : [""]).map((_, root) => ({ path, root }));
  return directories.value.flatMap((directory, root) => {
    const base = `${directory.replaceAll("\\", "/").replace(/\/$/, "")}/`;
    return path.toLowerCase().startsWith(base.toLowerCase()) ? [{ path: path.slice(base.length), root }] : [];
  });
}

/** The first location of a named path holding a file changed since the execution began, or null. */
async function delivered(named) {
  let failed = false;
  for (const { path, root } of locations(named)) {
    try {
      const result = await bridge.read_room_files(props.roomId, path, 0, "", root);
      if (result.kind === "file" && Date.parse(result.modified_at) >= props.startedAt * 1000) {
        return { path, root, name: path.split("/").at(-1), kind: "file", size: result.size, modified_at: result.modified_at };
      }
    } catch { failed = true; }
  }
  return failed ? undefined : null;
}

// A successful miss (null) can be reused. A failed read (undefined) must retry on the next visit.
watch([lookup_key, nearby], async ([key, visible], _, on_cleanup) => {
  const cached = found_files.get(key);
  files.value = cached ?? found_files.get(message_key.value) ?? [];
  if (!key || cached || !visible) return;
  let active = true;
  on_cleanup(() => { active = false; });
  const results = await Promise.all(candidates.value.map(delivered));
  if (!active) return;
  files.value = results.filter(Boolean);
  if (!results.includes(undefined)) { found_files.set(key, files.value); found_files.set(message_key.value, files.value); }
}, { immediate: true });

// A page the answer delivered can go public as a website, after the owner confirms what it holds.
const deployable = (file) => /\.html?$/i.test(file.name);
const deploy_file = (file) => open_deploy(bridge, { room_id: props.roomId, message_id: props.message.id, execution_id: props.message.execution_id || 0, member: props.message.author, file });
const open_file = (file) => file_preview.open?.(file.path, directories.value[file.root] || "", file.root, file);

onMounted(() => {
  observer = new IntersectionObserver((entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) return;
    observer.disconnect();
    nearby.value = true;
  }, { root: anchor.value.closest(".channel-transcript"), rootMargin: READ_AHEAD });
  observer.observe(anchor.value);
});
onBeforeUnmount(() => observer?.disconnect());
</script>

<template>
  <div ref="anchor" class="answer-files">
    <div v-for="file in shown_files" :key="`${file.root}/${file.path}`" class="attachment-file answer-file">
      <button type="button" class="attachment-file-main" :title="file.path" :aria-label="t('打开文件 {value1}', { value1: file.name })" @click="open_file(file)">
        <span class="answer-file-icon" v-html="bridge.attachment_file_icon(file.name)"></span>
        <span class="attachment-name">
          <span>{{ file.name }}</span>
          <small>{{ t('项目文件 · {path}', { path: file.path }) }}</small>
        </span>
      </button>
      <UTooltip v-if="deployable(file)" :text="t('部署为网站')"><UButton icon="i-lucide-rocket" size="xs" color="neutral" variant="ghost" class="answer-file-deploy" :aria-label="t('把 {value1} 部署为网站', { value1: file.name })" @click="deploy_file(file)" /></UTooltip>
      <button type="button" class="attachment-download" :title="t('在文件预览中打开 {value1}', { value1: file.path })" :aria-label="t('打开文件 {value1}', { value1: file.name })" @click="open_file(file)">
        <UIcon name="i-lucide-arrow-up-right" />
      </button>
    </div>
  </div>
</template>

<style scoped>
/* The attachment card's layout (markdown.css `.attachment-file`), drawn lighter: an attachment is a copy kept with the
   message, this is a link to a file in the project, so no fill, a fainter border and the project path (user 2026-11-22). */
.answer-files { display: flex; flex-direction: column; align-items: flex-start; gap: 10px; max-width: 100%; }
.answer-files:not(:empty) { margin-top: 10px; }
.answer-file-icon { display: contents; }
.answer-file { background: transparent; border-color: color-mix(in srgb, currentColor 14%, transparent); }
.answer-file:hover { background: color-mix(in srgb, currentColor 4%, transparent); }
.answer-file .attachment-name small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.answer-file .attachment-download { font-size: 18px; }
.answer-file-deploy { align-self: center; }
</style>

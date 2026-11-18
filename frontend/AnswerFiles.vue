<script setup>
/**
 * The files an answer delivers, as cards under its text that open in the file preview. A file counts when the answer
 * names it (inline code or a link) and it changed on the computer after the answer's execution began, so a file made by
 * a script or in a folder outside Git shows too, and a file the answer only mentions does not.
 */
import { computed, inject, onBeforeUnmount, onMounted, ref } from "vue";
import { t } from "./i18n.js";
import { file_preview, file_size, file_type } from "./file-preview.js";

// What counts as a deliverable: documents, tables, slides, pages and media, not source code.
const DELIVERABLE = /\.(docx?|xlsx?|ods|csv|tsv|pptx?|pdf|md|txt|html?|png|jpe?g|gif|webp|svg|mp3|wav|m4a|mp4|webm|mov|srt|vtt)$/i;
const MAX_FILES = 6;
// Start reading a little before the card scrolls into view.
const READ_AHEAD = "300px";
// What each answer found, so a card that is mounted again shows at once and does not ask the computer again.
const found_files = new Map();

const props = defineProps({
  message: { type: Object, required: true },
  roomId: { type: String, required: true },
  /** When the answer's execution began, in seconds. */
  startedAt: { type: Number, required: true },
});
const { view, bridge } = inject("discussion");

const directories = computed(() => {
  const models = view.value.launch?.room_models;
  return models?.room_id === props.roomId ? [models.project_directory, ...(models.extra_directories || [])].filter(Boolean) : [];
});
const cache_key = computed(() => `${props.roomId}\n${props.message.id}`);
const files = ref(found_files.get(cache_key.value) || []);
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
  for (const { path, root } of locations(named)) {
    try {
      const result = await bridge.read_room_files(props.roomId, path, 0, "", root);
      if (result.kind === "file" && Date.parse(result.modified_at) >= props.startedAt * 1000) {
        return { path, root, name: path.split("/").at(-1), kind: "file", size: result.size, modified_at: result.modified_at };
      }
    } catch { /* Not there, or this viewer cannot read the project: no card. */ }
  }
  return null;
}

async function read_files() {
  const results = await Promise.all(named_paths(props.message.text).map(delivered));
  files.value = results.filter(Boolean);
  // Finding nothing is not kept: the computer may only have been out of reach.
  if (files.value.length) found_files.set(cache_key.value, files.value);
}

const open_file = (file) => file_preview.open?.(file.path, directories.value[file.root] || "", file.root, file);

onMounted(() => {
  if (found_files.has(cache_key.value) || !named_paths(props.message.text).length) return;
  observer = new IntersectionObserver((entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) return;
    observer.disconnect();
    read_files();
  }, { rootMargin: READ_AHEAD });
  observer.observe(anchor.value);
});
onBeforeUnmount(() => observer?.disconnect());
</script>

<template>
  <div ref="anchor" class="answer-files">
    <button v-for="file in files" :key="`${file.root}/${file.path}`" type="button" class="answer-file" :title="file.path" :aria-label="t('打开文件 {value1}', { value1: file.name })" @click="open_file(file)">
      <span class="answer-file-icon" :class="file_type(file.name)[2]"><UIcon :name="file_type(file.name)[1]" /></span>
      <span class="answer-file-text">
        <span class="answer-file-name">{{ file.name }}</span>
        <span class="answer-file-meta">{{ file_type(file.name)[0] }} · {{ file_size(file.size) }}</span>
      </span>
      <span class="answer-file-open">{{ t('打开') }}</span>
    </button>
  </div>
</template>

<style scoped>
.answer-files { display: grid; gap: 8px; max-width: 520px; }
.answer-files:not(:empty) { margin-top: 12px; }
.answer-file { display: flex; align-items: center; gap: 12px; width: 100%; min-width: 0; padding: 10px 12px 10px 10px; border: 1px solid var(--ui-border); border-radius: 12px; background: var(--ui-bg-elevated); text-align: left; cursor: pointer; transition: border-color .15s, background .15s, box-shadow .15s; }
.answer-file:hover { border-color: var(--ui-border-accented); box-shadow: 0 2px 10px #0000002e; }
.answer-file:focus-visible { outline: 2px solid var(--ui-primary); outline-offset: 1px; }
.answer-file-icon { display: inline-flex; flex-shrink: 0; align-items: center; justify-content: center; width: 40px; height: 40px; border-radius: 9px; background: color-mix(in srgb, currentColor 14%, transparent); font-size: 21px; color: var(--ui-text-muted); }
.answer-file-icon.is-blue { color: #519aba; }
.answer-file-icon.is-orange { color: #e37933; }
.answer-file-icon.is-yellow { color: #cbcb41; }
.answer-file-icon.is-green { color: #8dc149; }
.answer-file-icon.is-purple { color: #a074c4; }
.answer-file-icon.is-red { color: #cc3e44; }
.answer-file-text { display: flex; flex: 1; flex-direction: column; gap: 2px; min-width: 0; }
.answer-file-name { overflow: hidden; color: var(--ui-text-highlighted); font-size: 13px; font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }
.answer-file-meta { color: var(--ui-text-dimmed); font-size: 12px; }
.answer-file-open { flex-shrink: 0; padding: 4px 11px; border: 1px solid var(--ui-border-accented); border-radius: 8px; color: var(--ui-text-toned); font-size: 12px; transition: background .15s, color .15s; }
.answer-file:hover .answer-file-open { background: var(--ui-bg-accented); color: var(--ui-text-highlighted); }
</style>

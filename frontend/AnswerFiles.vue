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
import { open_html_preview_tab } from "./inline-visual.js";

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

/**
 * For each named path, its first location holding a file changed since the execution began, or null. One batch request:
 * a path that does not exist comes back null rather than failing, so an answer that also names files elsewhere (like
 * `control.md` for a skill's file) is still remembered and its cards show at once on the next visit (user 2026-11-26).
 */
async function delivered(named_list) {
  const places = named_list.map(locations);
  const items = places.flat();
  const stats = items.length ? (await bridge.manage_room_files(props.roomId, { op: "stat-batch", items })).items : [];
  if (stats?.length !== items.length) throw new Error("stat-batch");
  let index = 0;
  return places.map((list) => {
    const found = list.map((place) => ({ place, stat: stats[index++] }))
      .find(({ stat }) => stat?.kind === "file" && Date.parse(stat.modified_at) >= props.startedAt * 1000);
    if (!found) return null;
    const { place: { path, root }, stat } = found;
    return { path, root, name: path.split("/").at(-1), kind: "file", size: stat.size, modified_at: stat.modified_at };
  });
}

// A completed lookup is reused; a failed request must retry on the next visit.
watch([lookup_key, nearby], async ([key, visible], _, on_cleanup) => {
  const cached = found_files.get(key);
  files.value = cached ?? found_files.get(message_key.value) ?? [];
  if (!key || cached || !visible) return;
  let active = true;
  on_cleanup(() => { active = false; });
  let results;
  try { results = await delivered(candidates.value); } catch { return; }
  if (!active) return;
  files.value = results.filter(Boolean);
  found_files.set(key, files.value);
  found_files.set(message_key.value, files.value);
}, { immediate: true });

// A page the answer delivered can go public as a website, after the owner confirms what it holds.
const deployable = (file) => /\.html?$/i.test(file.name);
const deploy_file = (file) => open_deploy(bridge, { room_id: props.roomId, message_id: props.message.id, execution_id: props.message.execution_id || 0, member: props.message.author, file });
const open_file = (file) => file_preview.open?.(file.path, directories.value[file.root] || "", file.root, file);
/** Save the file to this device as the file page does (away from the computer, a large one through the cloud space). */
async function download_file(file) {
  try { await bridge.download_project_entry(props.roomId, file); }
  catch (error) { bridge.notify("error", t('下载失败：{value1}', { value1: error.message })); }
}

/**
 * Show an HTML file in a new tab, sandboxed as the preview shows it: the tab opens at the click and receives the page
 * once the computer has put it together (user 2026-11-26, #12386).
 */
async function open_tab(file) {
  const target = window.open("", "_blank");
  if (target) {
    target.document.title = file.name;
    target.document.body.textContent = t('正在读取 {value1}…', { value1: file.name });
  }
  try {
    // On this computer the page opens from disk with the files beside it, without passing through the network.
    const local = await bridge.local_page_url(props.roomId, file.path, file.root);
    if (local) {
      if (target && !target.closed) target.location.replace(local);
      else window.open(local, "_blank");
      return;
    }
    const page = await bridge.read_room_page(props.roomId, file.path, file.root);
    open_html_preview_tab(file.name, page.text, null, false, target);
  } catch (error) {
    target?.close();
    bridge.notify("error", error.message);
  }
}

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
      <!-- One row of same-sized icon buttons: look (preview, new tab), then, set apart, publish (user 2026-11-26, #12393). -->
      <div class="answer-file-actions">
        <UTooltip :text="t('预览')"><button type="button" class="attachment-download" :aria-label="t('在文件预览中打开 {value1}', { value1: file.path })" @click="open_file(file)"><UIcon name="i-lucide-eye" /></button></UTooltip>
        <UTooltip :text="t('下载')"><button type="button" class="attachment-download" :aria-label="t('下载 {name}', { name: file.name })" @click="download_file(file)"><UIcon name="i-lucide-download" /></button></UTooltip>
        <UTooltip v-if="/\.html?$/i.test(file.name)" :text="t('在新标签页打开')"><button type="button" class="attachment-download" :aria-label="t('在新标签页打开 {value1}', { value1: file.name })" @click="open_tab(file)"><UIcon name="i-lucide-square-arrow-out-up-right" /></button></UTooltip>
        <template v-if="deployable(file)">
          <span class="answer-file-divider" aria-hidden="true"></span>
          <UTooltip :text="t('部署为网站')"><button type="button" class="attachment-download answer-file-deploy" :aria-label="t('把 {value1} 部署为网站', { value1: file.name })" @click="deploy_file(file)"><UIcon name="i-lucide-rocket" /></button></UTooltip>
        </template>
      </div>
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
.answer-file-actions { display: flex; flex: none; align-items: center; gap: 2px; }
.answer-file .attachment-download { width: 30px; height: 30px; border-radius: 7px; font-size: 17px; transition: color .12s, background-color .12s; }
.answer-file .attachment-download:focus-visible { outline: 2px solid #5865f2; outline-offset: 1px; }
.answer-file-divider { width: 1px; height: 16px; margin: 0 4px; background: color-mix(in srgb, currentColor 16%, transparent); }
/* Deploying publishes the page, so its button takes the deploy card's accent when pointed at. */
.answer-file .answer-file-deploy:hover { color: #6366f1; background: color-mix(in srgb, #6366f1 12%, transparent); }
</style>

<script setup>
/**
 * The file preview's view of one zip archive: its folders and files listed like the room's file page, read in this
 * page (nothing is unpacked on the computer). Clicking a file emits `open` with its entry (`{ path, size, read }`),
 * which the preview opens in its own tab; folders are browsed in place.
 * `url` is an attachment's address, a stream of the computer's website, or a Blob URL read through the relay.
 */
import { computed, ref, watch } from "vue";
import PreviewLoading from "./PreviewLoading.vue";
import { file_size, file_type, modified_time } from "./file-preview.js";
import { t } from "./i18n.js";
import { zip_entries } from "./workflow-files.js";

const props = defineProps({ url: { type: String, required: true }, name: { type: String, default: "" } });
const emit = defineEmits(["open"]);
// macOS adds resource forks under this folder; they are not the archive's content.
const JUNK = /(^|\/)(__MACOSX\/|\.DS_Store$)/;
const state = ref("loading"), error = ref(""), entries = ref([]), folder = ref("");
let version = 0;

watch(() => props.url, async (url) => {
  const current = ++version;
  state.value = "loading";
  folder.value = "";
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(t('文件读取失败（{value1}）', { value1: response.status }));
    const list = zip_entries(new Uint8Array(await response.arrayBuffer())).filter((entry) => !JUNK.test(entry.path));
    if (current !== version) return;
    entries.value = list;
    state.value = "ready";
  } catch (failure) {
    if (current !== version) return;
    error.value = failure.message;
    state.value = "error";
  }
}, { immediate: true });

/** Folders first, then files, of the folder shown now; a folder's size is the total of the files under it. */
const rows = computed(() => {
  const prefix = folder.value ? `${folder.value}/` : "";
  const folders = new Map(), files = [];
  for (const entry of entries.value) {
    if (!entry.path.startsWith(prefix)) continue;
    const rest = entry.path.slice(prefix.length), cut = rest.indexOf("/");
    if (cut < 0) { files.push({ kind: "file", name: rest, path: entry.path, size: entry.size, modified_at: entry.modified_at, entry }); continue; }
    const name = rest.slice(0, cut);
    const item = folders.get(name) || { kind: "directory", name, path: prefix + name, size: 0, count: 0, modified_at: "" };
    item.size += entry.size;
    item.count++;
    if (entry.modified_at > item.modified_at) item.modified_at = entry.modified_at;
    folders.set(name, item);
  }
  const by_name = (left, right) => left.name.localeCompare(right.name, undefined, { numeric: true });
  return [...[...folders.values()].sort(by_name), ...files.sort(by_name)];
});
const total = computed(() => entries.value.reduce((sum, entry) => sum + entry.size, 0));
const crumbs = computed(() => {
  const parts = folder.value ? folder.value.split("/") : [];
  return [{ name: props.name || t('压缩包'), path: "" }, ...parts.map((name, index) => ({ name, path: parts.slice(0, index + 1).join("/") }))];
});

function choose(row) {
  if (row.kind === "directory") folder.value = row.path;
  else if (!row.entry.encrypted) emit("open", row.entry);
}

function row_icon(row) {
  if (row.kind === "directory") return ["i-lucide-folder", "is-folder"];
  if (row.entry.encrypted) return ["i-lucide-file-lock-2", "is-muted"];
  return file_type(row.name).slice(1);
}
</script>

<template>
  <PreviewLoading v-if="state === 'loading'" :label="t('正在读取压缩包…')" />
  <div v-else-if="state === 'error'" class="project-editor-state"><UIcon name="i-lucide-circle-alert" /><p>{{ t('无法读取压缩包：{value1}', { value1: error }) }}</p></div>
  <div v-else class="zip-viewer">
    <div class="zip-explorer">
      <nav class="zip-path" :aria-label="t('压缩包内的位置')">
        <template v-for="(part, index) in crumbs" :key="part.path">
          <UIcon v-if="index" name="i-lucide-chevron-right" class="project-crumb-separator" />
          <button type="button" :disabled="index === crumbs.length - 1" :aria-current="index === crumbs.length - 1 ? 'location' : undefined" @click="folder = part.path">
            <UIcon v-if="!index" name="i-lucide-file-archive" class="project-file-icon is-muted" />{{ part.name }}
          </button>
        </template>
      </nav>
      <div class="zip-columns" aria-hidden="true"><span>{{ t('名称') }}</span><span>{{ t('大小') }}</span><span>{{ t('修改时间') }}</span></div>
      <div class="zip-rows">
        <div v-for="row in rows" :key="row.path" class="zip-row" :class="{ 'is-unavailable': row.entry?.encrypted }">
          <button type="button" class="zip-name" :disabled="row.entry?.encrypted"
            :title="row.entry?.encrypted ? t('{value1}（已加密，无法预览）', { value1: row.name }) : row.kind === 'directory' ? t('{value1}（{value2} 个文件）', { value1: row.name, value2: row.count }) : row.name" @click="choose(row)">
            <UIcon :name="row_icon(row)[0]" class="project-file-icon" :class="row_icon(row)[1]" /><span>{{ row.name }}</span>
          </button>
          <span class="zip-size">{{ file_size(row.size) }}</span>
          <time :datetime="row.modified_at">{{ modified_time(row.modified_at) }}</time>
        </div>
        <p v-if="!rows.length" class="zip-empty"><UIcon name="i-lucide-folder-open" />{{ t('压缩包是空的') }}</p>
      </div>
      <footer class="zip-footer">{{ t('{value1} 个文件，解压后共 {value2}', { value1: entries.length, value2: file_size(total) }) }}</footer>
    </div>
  </div>
</template>

<style scoped>
/* Mirrors the room's file page (ProjectFiles.vue), so an archive reads like a folder there. */
/* The preview body is a horizontal flex box: without its own width the list would shrink to its content. */
.zip-viewer { flex: 1; width: 100%; min-width: 0; height: 100%; overflow: auto; padding: 12px; }
.zip-explorer { overflow: hidden; border: 1px solid var(--ui-border); border-radius: 10px; background: color-mix(in srgb, var(--ui-bg-elevated) 45%, transparent); }
.zip-path { display: flex; flex-wrap: nowrap; align-items: center; gap: 1px; min-height: 38px; padding: 4px 10px; overflow-x: auto; scrollbar-width: none; border-bottom: 1px solid var(--ui-border); font-size: 13px; }
.zip-path > * { flex-shrink: 0; }
.zip-path button { display: inline-flex; align-items: center; gap: 6px; padding: 3px 5px; border-radius: 5px; color: var(--ui-text-muted); white-space: nowrap; cursor: pointer; }
@media (hover: hover) { .zip-path button:hover:not(:disabled) { background: var(--ui-bg-accented); color: var(--ui-text); } }
.zip-path button[aria-current] { color: var(--ui-text-highlighted); font-weight: 600; cursor: default; }
.zip-columns, .zip-row { display: grid; grid-template-columns: minmax(0, 1fr) 84px 168px; align-items: center; gap: 16px; padding: 0 14px; }
.zip-columns { height: 30px; color: var(--ui-text-dimmed); font-size: 11px; letter-spacing: .02em; border-bottom: 1px solid var(--ui-border); }
.zip-columns > :nth-child(2), .zip-size { text-align: right; }
.zip-rows { padding: 4px; }
.zip-row { width: 100%; height: 34px; font-size: 13px; border-radius: 6px; padding-inline: 10px; }
@media (hover: hover) { .zip-row:hover { background: var(--ui-bg-accented); } }
.zip-row.is-unavailable { opacity: .45; }
.zip-name { display: flex; align-items: center; gap: 9px; min-width: 0; height: 100%; text-align: left; cursor: pointer; }
.zip-name:disabled { cursor: default; }
.zip-name:focus-visible { outline: 1px solid var(--ui-primary); outline-offset: -1px; border-radius: 4px; }
.zip-name > span:last-child { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.zip-row time, .zip-size { color: var(--ui-text-dimmed); font-size: 12px; font-variant-numeric: tabular-nums; }
.zip-row time { text-align: right; }
.zip-footer { display: flex; align-items: center; height: 36px; padding: 0 14px; border-top: 1px solid var(--ui-border); color: var(--ui-text-dimmed); font-size: 12px; }
.zip-empty { display: flex; align-items: center; justify-content: center; gap: 8px; padding: 40px 12px; font-size: 13px; color: var(--ui-text-muted); }

@media (max-width: 640px) {
  .zip-viewer { padding: 8px; }
  .zip-path { min-height: 36px; padding: 4px 8px; font-size: 12px; }
  .zip-columns, .zip-row { grid-template-columns: minmax(0, 1fr) 64px; gap: 8px; }
  .zip-columns > :last-child, .zip-row time { display: none; }
  /* Rows a finger can hit. */
  .zip-row { height: 44px; }
}
</style>

<script setup>
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { crumbs_of, file_preview, file_size, file_type, folder_listings, modified_time, shown_folders } from "./file-preview.js";

// The room's project directories, the main one first; with more than one, a switch above the list picks which is shown.
const props = defineProps({ directories: { type: Array, required: true } });
const { view, bridge } = inject("discussion");
const room_id = view.value.room.id;
const shown = shown_folders.get(room_id);
const root = ref(Math.max(0, props.directories.indexOf(shown?.directory)));
const directory = computed(() => props.directories[root.value] || props.directories[0]);
// The folder being shown changes on the click itself; its listing comes from the cache when it was opened before (in
// this page, for this room and project), and is read again behind it, since another device waits on the relay.
const current_path = ref(shown?.directory === directory.value ? shown.path : "");
const listing = ref(null);
const loading = ref(false);
let directory_request = 0;
const cache_key = (path) => `${room_id}
${directory.value}
${path}`;

/** Pick the row icon and tint for one listing entry. */
function entry_icon(entry) {
  if (entry.kind === "directory") return ["i-lucide-folder", "is-folder"];
  if (entry.kind === "unavailable") return ["i-lucide-file-lock-2", "is-muted"];
  return file_type(entry.name).slice(1);
}

const breadcrumbs = computed(() => crumbs_of(directory.value, current_path.value));
/** The last folder name of a directory, as its switch shows it. */
const folder_name = (path) => String(path).split(/[\\/]+/).filter(Boolean).at(-1) || path;

/** Show another of the room's project directories from its top. */
function switch_root(index) {
  if (index === root.value) return;
  root.value = index;
  read_directory("");
}

/** Show a folder the preview's breadcrumb asked for, now or once this list is shown. */
function take_reveal() {
  const path = file_preview.reveal_path;
  if (path == null) return false;
  file_preview.reveal_path = null;
  if (props.directories[file_preview.reveal_root]) root.value = file_preview.reveal_root;
  read_directory(path);
  return true;
}
watch(() => file_preview.reveal_path, take_reveal);
onMounted(() => { if (!take_reveal()) read_directory(current_path.value); });
onBeforeUnmount(() => { directory_request++; });

/** Show one folder at once (from the cache when it has been opened before) and read it again; a failed refresh keeps what is shown. */
async function read_directory(path = "", append = false) {
  const request = ++directory_request;
  if (!append) {
    current_path.value = path;
    shown_folders.set(room_id, { directory: directory.value, path });
    listing.value = folder_listings.get(cache_key(path)) || null;
  }
  loading.value = true;
  try {
    const result = await bridge.read_room_files(room_id, path, append ? listing.value.next_offset : 0, "", root.value);
    if (request !== directory_request) return;
    listing.value = { ...result, entries: append ? [...listing.value.entries, ...result.entries] : result.entries };
    folder_listings.set(cache_key(path), listing.value);
  } catch (error) {
    if (request === directory_request) bridge.notify("error", `读取目录失败，${error.message}`);
  } finally { if (request === directory_request) loading.value = false; }
}
</script>

<template>
  <section class="project-files">
    <header class="project-files-heading">
      <div><h2>项目文件</h2><p :title="directory">{{ directory }}</p></div>
      <UButton icon="i-lucide-refresh-cw" color="neutral" variant="ghost" size="sm" aria-label="刷新" title="刷新" :loading="loading" @click="read_directory(current_path)" />
    </header>

    <div v-if="directories.length > 1" class="project-roots" role="tablist" aria-label="项目目录">
      <button v-for="(path, index) in directories" :key="path" type="button" role="tab" :aria-selected="index === root" :title="path" @click="switch_root(index)">
        <UIcon :name="index ? 'i-lucide-folder' : 'i-lucide-folder-root'" />{{ folder_name(path) }}
      </button>
    </div>
    <div class="project-explorer" :aria-busy="loading">
      <nav class="project-explorer-path" aria-label="文件路径">
        <template v-for="(part, index) in breadcrumbs" :key="part.path">
          <UIcon v-if="index" name="i-lucide-chevron-right" class="project-crumb-separator" />
          <button type="button" :disabled="index === breadcrumbs.length - 1" :aria-current="index === breadcrumbs.length - 1 ? 'location' : undefined" @click="read_directory(part.path)">
            <UIcon v-if="!index" name="i-lucide-folder-root" />{{ part.name }}
          </button>
        </template>
      </nav>
      <div class="project-files-columns" aria-hidden="true"><span>名称</span><span>大小</span><span>修改时间</span></div>
      <!-- Rows change only with the listing; the room's directories arrive as a new array on every view publish. -->
      <div v-memo="[listing, loading, directory, root]" class="project-files-rows">
        <button v-for="entry in listing?.entries || []" :key="entry.path" type="button" class="project-file-row" :class="{ 'is-hidden': entry.name.startsWith('.') }"
          :disabled="entry.kind === 'unavailable'" :title="entry.kind === 'unavailable' ? `${entry.name}（无法读取或指向项目外）` : entry.name"
          @click="entry.kind === 'directory' ? read_directory(entry.path) : file_preview.open?.(entry.path, directory, root)">
          <span class="project-file-name"><UIcon :name="entry_icon(entry)[0]" class="project-file-icon" :class="entry_icon(entry)[1]" /><span>{{ entry.name }}</span></span>
          <span class="project-file-size">{{ file_size(entry.size) }}</span><time :datetime="entry.modified_at">{{ modified_time(entry.modified_at) }}</time>
        </button>
        <p v-if="!listing" class="project-files-empty" role="status">{{ loading ? '正在读取项目目录…' : '点击刷新重新读取目录' }}</p>
        <p v-else-if="!listing.entries.length" class="project-files-empty"><UIcon name="i-lucide-folder-open" />此文件夹为空</p>
      </div>
      <footer v-if="listing" class="project-files-footer">
        <span>{{ listing.total }} 项<template v-if="listing.next_offset !== null">，已显示 {{ listing.entries.length }} 项</template></span>
        <UButton v-if="listing.next_offset !== null" label="加载更多" color="neutral" variant="ghost" size="xs" :loading="loading" :disabled="loading" @click="read_directory(listing.path, true)" />
      </footer>
    </div>
  </section>

</template>

<style scoped>
.project-files { --row-height: 34px; }
.project-files-heading { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; margin-bottom: 16px; }
.project-files-heading > div { min-width: 0; }
.project-files-heading h2 { margin: 0 0 4px; font-size: 18px; font-weight: 600; }
.project-files-heading p { margin: 0; color: var(--ui-text-muted); font: 12px ui-monospace, Consolas, monospace; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }

.project-roots { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 10px; }
.project-roots button { display: inline-flex; align-items: center; gap: 6px; max-width: 240px; padding: 4px 10px; border: 1px solid var(--ui-border); border-radius: 6px;
  color: var(--ui-text-muted); font-size: 12px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.project-roots button:hover { color: var(--ui-text-highlighted); }
.project-roots button[aria-selected="true"] { border-color: var(--ui-primary); color: var(--ui-text-highlighted); font-weight: 500; }
.project-roots button > span { flex-shrink: 0; width: 13px; height: 13px; }
.project-explorer { overflow: hidden; border: 1px solid var(--ui-border); border-radius: 10px; background: color-mix(in srgb, var(--ui-bg-elevated) 45%, transparent); }
.project-explorer-path { display: flex; flex-wrap: wrap; align-items: center; gap: 2px; min-height: 42px; padding: 6px 10px; border-bottom: 1px solid var(--ui-border); font-size: 13px; }
.project-explorer-path button { display: inline-flex; align-items: center; gap: 6px; padding: 3px 6px; border-radius: 5px; color: var(--ui-text-muted); cursor: pointer; overflow-wrap: anywhere; }
.project-explorer-path button:hover:not(:disabled) { background: var(--ui-bg-accented); color: var(--ui-text); }
.project-explorer-path button[aria-current] { color: var(--ui-text-highlighted); font-weight: 600; cursor: default; }
.project-explorer-path button:disabled:not([aria-current]) { cursor: default; }
.project-explorer-path button > span { width: 15px; height: 15px; color: var(--ui-primary); }

.project-files-columns, .project-file-row { display: grid; grid-template-columns: minmax(0, 1fr) 84px 136px; align-items: center; gap: 16px; padding: 0 14px; }
.project-files-columns { height: 30px; color: var(--ui-text-dimmed); font-size: 11px; letter-spacing: .02em; border-bottom: 1px solid var(--ui-border); }
.project-files-columns > :nth-child(2), .project-file-size { text-align: right; }
.project-files-rows { padding: 4px; }
.project-file-row { width: 100%; height: var(--row-height); text-align: left; font-size: 13px; cursor: pointer; border-radius: 6px; padding-inline: 10px; }
.project-file-row:hover:not(:disabled) { background: var(--ui-bg-accented); }
.project-file-row:focus-visible { outline: 1px solid var(--ui-primary); outline-offset: -1px; }
.project-file-row:disabled { opacity: .45; cursor: default; }
.project-file-row.is-hidden .project-file-name > span:last-child { color: var(--ui-text-muted); }
.project-file-name { display: flex; align-items: center; gap: 9px; min-width: 0; }
.project-file-name > span:last-child { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.project-file-row time, .project-file-size { color: var(--ui-text-dimmed); font-size: 12px; font-variant-numeric: tabular-nums; }
.project-files-footer { display: flex; align-items: center; justify-content: space-between; height: 36px; padding: 0 14px; border-top: 1px solid var(--ui-border); color: var(--ui-text-dimmed); font-size: 12px; }
.project-files-empty { display: flex; align-items: center; justify-content: center; gap: 8px; padding: 40px 12px; font-size: 13px; color: var(--ui-text-muted); }

@media (max-width: 640px) {
  .project-files-columns, .project-file-row { grid-template-columns: minmax(0, 1fr) 64px; gap: 8px; }
  .project-files-columns > :last-child, .project-file-row > time { display: none; }
}
</style>

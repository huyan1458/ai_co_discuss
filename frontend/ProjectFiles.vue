<script setup>
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { crumbs_of, file_preview, file_size, file_type, modified_time } from "./file-preview.js";

const props = defineProps({ directory: { type: String, required: true } });
const { view, bridge } = inject("discussion");
const room_id = view.value.room.id;
const listing = ref(null);
const loading = ref(false);
let directory_request = 0;

/** Pick the row icon and tint for one listing entry. */
function entry_icon(entry) {
  if (entry.kind === "directory") return ["i-lucide-folder", "is-folder"];
  if (entry.kind === "unavailable") return ["i-lucide-file-lock-2", "is-muted"];
  return file_type(entry.name).slice(1);
}

const breadcrumbs = computed(() => crumbs_of(props.directory, listing.value?.path || ""));

/** Show a folder the preview's breadcrumb asked for, now or once this list is shown. */
function take_reveal() {
  const path = file_preview.reveal_path;
  if (path == null) return false;
  file_preview.reveal_path = null;
  read_directory(path);
  return true;
}
watch(() => file_preview.reveal_path, take_reveal);
onMounted(() => { if (!take_reveal()) read_directory(); });
onBeforeUnmount(() => { directory_request++; });

/** Read one folder, retaining the previous listing when a refresh fails. */
async function read_directory(path = "", append = false) {
  const request = ++directory_request;
  loading.value = true;
  try {
    const result = await bridge.read_room_files(room_id, path, append ? listing.value.next_offset : 0);
    if (request !== directory_request) return;
    listing.value = { ...result, entries: append ? [...listing.value.entries, ...result.entries] : result.entries };
  } catch (error) {
    if (request === directory_request) bridge.notify("error", `读取目录失败，${error.message}`);
  } finally { if (request === directory_request) loading.value = false; }
}
</script>

<template>
  <section class="project-files">
    <header class="project-files-heading">
      <div><h2>项目文件</h2><p :title="directory">{{ directory }}</p></div>
      <UButton icon="i-lucide-refresh-cw" color="neutral" variant="ghost" size="sm" aria-label="刷新" title="刷新" :loading="loading" @click="read_directory(listing?.path || '')" />
    </header>

    <div class="project-explorer" :aria-busy="loading">
      <nav class="project-explorer-path" aria-label="文件路径">
        <template v-for="(part, index) in breadcrumbs" :key="part.path">
          <UIcon v-if="index" name="i-lucide-chevron-right" class="project-crumb-separator" />
          <button type="button" :disabled="loading || index === breadcrumbs.length - 1" :aria-current="index === breadcrumbs.length - 1 ? 'location' : undefined" @click="read_directory(part.path)">
            <UIcon v-if="!index" name="i-lucide-folder-root" />{{ part.name }}
          </button>
        </template>
      </nav>
      <div class="project-files-columns" aria-hidden="true"><span>名称</span><span>大小</span><span>修改时间</span></div>
      <div class="project-files-rows">
        <button v-for="entry in listing?.entries || []" :key="entry.path" type="button" class="project-file-row" :class="{ 'is-hidden': entry.name.startsWith('.') }"
          :disabled="loading || entry.kind === 'unavailable'" :title="entry.kind === 'unavailable' ? `${entry.name}（无法读取或指向项目外）` : entry.name"
          @click="entry.kind === 'directory' ? read_directory(entry.path) : file_preview.open?.(entry.path, props.directory)">
          <span class="project-file-name"><UIcon :name="entry_icon(entry)[0]" class="project-file-icon" :class="entry_icon(entry)[1]" /><span>{{ entry.name }}</span></span>
          <span class="project-file-size">{{ file_size(entry.size) }}</span><time :datetime="entry.modified_at">{{ modified_time(entry.modified_at) }}</time>
        </button>
        <p v-if="!listing" class="project-files-empty" role="status">{{ loading ? '正在读取项目目录…' : '点击刷新重新读取目录' }}</p>
        <p v-else-if="!listing.entries.length" class="project-files-empty"><UIcon name="i-lucide-folder-open" />此文件夹为空</p>
      </div>
      <footer v-if="listing" class="project-files-footer">
        <span>{{ listing.total }} 项<template v-if="listing.next_offset !== null">，已显示 {{ listing.entries.length }} 项</template></span>
        <UButton v-if="listing.next_offset !== null" label="加载更多" color="neutral" variant="ghost" size="xs" :loading="loading" @click="read_directory(listing.path, true)" />
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

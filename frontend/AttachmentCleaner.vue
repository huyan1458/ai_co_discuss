<script setup>
/**
 * Free a room's attachment space, as chat apps' storage managers do: the room's sent files, filtered by kind and age and
 * sorted by size, picked and cleared at once. A cleared file keeps its message card, number and thumbnail; only the
 * original bytes go. Shared by the room page and the management panel, each passing its own way to reach the site.
 *
 * With `cloud`, it manages the account's cloud space instead: every large file of the account across its rooms, each with
 * its room, and the space used against the account's quota; deleting removes the file from the cloud space.
 *
 * Props:
 *   load: async () => { attachments: [...], bytes } — the room's sent files (owner view); in cloud mode
 *     { attachments: [... with room_id, room_title], used_bytes, quota_mib }.
 *   clear: async (ids) => { cleared: [...], freed_bytes } — clears (deletes) the chosen files.
 *   cloud: whether this manages the account's cloud space rather than one room; its list also holds files copied there
 *     from attachments or projects (`kind: "cloud_file"`), each named by its source.
 *   download: async (file) => void, saves one cloud space file to this device; without it the list has no download.
 *   preview: async (file) => void, looks at an image, audio, video or PDF without downloading it.
 *   land: (file) => void, starts landing a sent attachment in a project folder.
 *   shares: the share link calls for CloudShares ({ list, create, revoke }); without it the list offers no sharing.
 * Emits `cleared(result)` after a successful clear, `failed(message)` when loading or clearing fails.
 */
import { computed, onMounted, ref } from "vue";
import { t } from "./i18n.js";
import { format_storage_bytes } from "./storage-format.js";
import CloudShares from "./CloudShares.vue";

const props = defineProps({ load: { type: Function, required: true }, clear: { type: Function, required: true }, cloud: Boolean,
  download: { type: Function, default: null }, preview: { type: Function, default: null }, land: { type: Function, default: null },
  shares: { type: Object, default: null }, search: Boolean });
// Part of a name to find, in the cloud space list (`search`).
const query = ref("");
/** Whether a file is a transfer copy the site clears within a day, not one kept. */
const transfer = (file) => Boolean(file.purpose && file.purpose !== "keep");
// The file whose share links are open under its row; one at a time.
const sharing = ref("");
/** Whether a file can be shared: a kept one, not a transfer copy that is gone within a day. */
const shareable = (file) => !file.purpose || file.purpose === "keep";
// What a cloud space file can be looked at as (web/app.js `CLOUD_PREVIEW_TYPES`); anything else is downloaded.
const PREVIEWABLE = /^(image|video|audio)\/|^application\/pdf$/;
async function preview_file(file) {
  try { await props.preview(file); }
  catch (failure) { emit("failed", failure.message); }
}

/**
 * Where a cloud space file came from: a message attachment names its room and message, a file copied from a project its
 * room and path (a folder arrives as one ZIP).
 */
function cloud_source(file) {
  const room = file.room_title || file.room_id || "";
  // A project source is `<directory number>:<path>`; the number means nothing to a reader.
  const path = String(file.source_ref || "").replace(/^\d+:/, "");
  if (file.source_kind === "upload") return t("直接上传到云空间");
  if (file.source_kind === "project_folder") return t("{room} · 文件夹 {path}", { room, path });
  if (file.source_kind === "project_file") return t("{room} · 项目文件 {path}", { room, path });
  if (file.message_id) return t("{room} · 消息 #{id}", { room, id: file.message_id });
  return file.kind === "cloud_file" ? t("{room} · 存自附件", { room }) : room;
}
const downloading = ref(new Set());
async function download_file(file) {
  if (downloading.value.has(file.id)) return;
  downloading.value = new Set([...downloading.value, file.id]);
  try { await props.download(file); }
  catch (failure) { emit("failed", failure.message); }
  finally { const next = new Set(downloading.value); next.delete(file.id); downloading.value = next; }
}
const MIB = 1024 * 1024;
// The cloud space's use and quota, from the last read and lowered at once by a delete.
const usage = ref({ used_bytes: 0, quota_mib: 0 });
const emit = defineEmits(["cleared", "failed"]);
const DAY_MS = 86400000;
const KINDS = [["all", t("全部")], ["image", t("图片")], ["video", t("音视频")], ["archive", t("压缩包")], ["document", t("文档")], ["other", t("其他")]];
const AGES = [[0, t("全部时间")], [7, t("7 天前")], [30, t("30 天前")]];
const ARCHIVE = /\.(zip|7z|rar|tar|gz|tgz|xz|bz2|\d{3})$/i;
const DOCUMENT = /\.(pdf|docx?|xlsx?|pptx?|md|txt|csv|json|html?)$/i;

const files = ref([]);
const loading = ref(true);
const clearing = ref(false);
const confirming = ref(false);
const kind = ref("all");
const age = ref(0);
const chosen = ref(new Set());

/** Which filter group a file falls in, from its type and then its name. */
function kind_of(file) {
  if (file.content_type.startsWith("image/")) return "image";
  if (/^(video|audio)\//.test(file.content_type)) return "video";
  if (ARCHIVE.test(file.file_name)) return "archive";
  if (file.content_type === "application/pdf" || DOCUMENT.test(file.file_name)) return "document";
  return "other";
}

const kept = computed(() => files.value.filter(file => !file.cleared_at));
const shown = computed(() => {
  const cutoff = age.value ? Date.now() - age.value * DAY_MS : Infinity;
  // A room's files are freed largest first; the cloud space reads as a list of what was saved, newest first.
  const needle = query.value.trim().toLocaleLowerCase();
  return kept.value.filter(file => (kind.value === "all" || kind_of(file) === kind.value) && Date.parse(file.created_at) < cutoff
    && (!needle || String(file.file_name).toLocaleLowerCase().includes(needle)))
    .sort(props.cloud ? (a, b) => String(b.created_at).localeCompare(String(a.created_at)) : (a, b) => b.size - a.size);
});
const kind_bytes = computed(() => Object.fromEntries(KINDS.map(([key]) => [key,
  kept.value.filter(file => key === "all" || kind_of(file) === key).reduce((sum, file) => sum + file.size, 0)])));
const chosen_bytes = computed(() => kept.value.filter(file => chosen.value.has(file.id)).reduce((sum, file) => sum + file.size, 0));
const all_shown_chosen = computed(() => shown.value.length > 0 && shown.value.every(file => chosen.value.has(file.id)));
const cleared_count = computed(() => files.value.length - kept.value.length);

function toggle(id) {
  const next = new Set(chosen.value);
  next.has(id) ? next.delete(id) : next.add(id);
  chosen.value = next;
  confirming.value = false;
}

function toggle_shown() {
  const next = new Set(chosen.value);
  for (const file of shown.value) all_shown_chosen.value ? next.delete(file.id) : next.add(file.id);
  chosen.value = next;
  confirming.value = false;
}

async function reload() {
  loading.value = true;
  try {
    const result = await props.load();
    files.value = result.attachments || [];
    usage.value = { used_bytes: Number(result.used_bytes) || 0, quota_mib: Number(result.quota_mib) || 0 };
  }
  catch (failure) { emit("failed", failure.message); }
  finally { loading.value = false; }
}

async function clear_chosen() {
  if (!confirming.value) { confirming.value = true; return; }
  const ids = [...chosen.value];
  clearing.value = true;
  try {
    const result = await props.clear(ids);
    const done = new Set(result.cleared || []);
    const now = new Date().toISOString();
    // Show the outcome at once; the next room read brings the same state from the site.
    files.value = files.value.map(file => done.has(file.id) ? { ...file, cleared_at: file.cleared_at || now } : file);
    usage.value = { ...usage.value, used_bytes: Math.max(0, usage.value.used_bytes - (Number(result.freed_bytes) || 0)) };
    chosen.value = new Set();
    emit("cleared", result);
    // A drive file went to the recycle bin: it leaves this list but still counts, as the site's next read shows.
    if (result.trashed?.length) await reload();
  } catch (failure) { emit("failed", failure.message); }
  finally { clearing.value = false; confirming.value = false; }
}

function date_label(value) {
  return new Date(value).toLocaleDateString(undefined, { month: "2-digit", day: "2-digit" });
}

onMounted(reload);
defineExpose({ reload });
</script>

<template>
  <div class="attachment-cleaner">
    <template v-if="cloud">
      <p class="cleaner-usage"><template v-if="usage.quota_mib">{{ t("云空间已用 {used} / 上限 {quota}", { used: format_storage_bytes(usage.used_bytes), quota: format_storage_bytes(usage.quota_mib * MIB) }) }}</template><USkeleton v-else-if="loading" class="h-4 w-40" /></p>
      <p class="cleaner-note">{{ t("删除的网盘文件先进回收站，30 天内可以在文件页的“云空间”里还原；房间附件和传输暂存会立即彻底删除，消息仍在，附件卡片标“已从云空间删除”。") }}</p>
    </template>
    <p v-else class="cleaner-note">{{ t("清理后消息仍在，附件卡片保留文件名、大小和图片缩略图并标“已清理”，原文件无法再打开或下载，成员也读不到；此操作无法撤销。") }}</p>
    <input v-if="search" v-model="query" type="search" class="cleaner-search" :placeholder="t('按名称搜索')" :aria-label="t('按名称搜索')">
    <div class="cleaner-filters" role="group" :aria-label="t('按类型筛选')">
      <button v-for="[key, label] in KINDS" :key="key" type="button" class="cleaner-chip" :aria-pressed="kind === key" @click="kind = key">
        {{ label }}<small>{{ format_storage_bytes(kind_bytes[key]) }}</small>
      </button>
    </div>
    <div class="cleaner-filters" role="group" :aria-label="t('按时间筛选')">
      <button v-for="[days, label] in AGES" :key="days" type="button" class="cleaner-chip" :aria-pressed="age === days" @click="age = days">{{ label }}</button>
    </div>
    <div class="cleaner-results" :aria-busy="loading">
      <label class="cleaner-row cleaner-all">
        <input type="checkbox" :checked="all_shown_chosen" :disabled="loading || !shown.length" @change="toggle_shown">
        <span>{{ t("全选当前 {count} 项", { count: shown.length }) }}</span>
      </label>
      <ul class="cleaner-list">
        <li v-if="loading" class="cleaner-empty" role="status">{{ t("正在读取附件…") }}</li>
        <li v-else-if="!shown.length" class="cleaner-empty">{{ kept.length ? t("没有符合条件的附件") : cloud ? t("云空间里没有文件") : t("本房间没有可清理的附件") }}</li>
        <template v-else><li v-for="file in shown" :key="file.id">
          <label class="cleaner-row">
            <input type="checkbox" :checked="chosen.has(file.id)" @change="toggle(file.id)">
            <span class="cleaner-name" :title="file.file_name">{{ file.file_name }}</span>
            <small v-if="cloud" class="cleaner-meta cleaner-room" :title="cloud_source(file)">{{ cloud_source(file) }} · {{ date_label(file.created_at) }}</small>
            <small v-if="cloud && transfer(file)" class="cleaner-transfer">{{ t("传输暂存，到期自动清理") }}</small>
            <small v-else class="cleaner-meta">#{{ file.number }} · {{ date_label(file.created_at) }}</small>
            <span class="cleaner-size">{{ format_storage_bytes(file.size) }}</span>
            <button v-if="cloud && preview && PREVIEWABLE.test(file.content_type || '')" type="button" class="cleaner-download" :title="t('预览 {name}', { name: file.file_name })" :aria-label="t('预览 {name}', { name: file.file_name })" @click.prevent.stop="preview_file(file)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>
            </button>
            <!-- Any file of the cloud space lands in a project: an attachment by its room, any other by its own ID. -->
            <button v-if="cloud && land && file.stored !== false" type="button" class="cleaner-download" :title="t('把 {name} 取回到项目', { name: file.file_name })" :aria-label="t('把 {name} 取回到项目', { name: file.file_name })" @click.prevent.stop="land(file)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h16a1 1 0 0 0 1-1V9a1 1 0 0 0-1-1h-7.9a1 1 0 0 1-.8-.4L9.9 5.4a1 1 0 0 0-.8-.4H4a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1Z"/><path d="M12 11v6m-3-3 3 3 3-3"/></svg>
            </button>
            <button v-if="cloud && shares && shareable(file)" type="button" class="cleaner-download" :aria-expanded="sharing === file.id" :title="t('分享 {name}', { name: file.file_name })" :aria-label="t('分享 {name}', { name: file.file_name })" @click.prevent.stop="sharing = sharing === file.id ? '' : file.id">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>
            </button>
            <button v-if="cloud && download" type="button" class="cleaner-download" :disabled="downloading.has(file.id)" :title="t('下载 {name}', { name: file.file_name })" :aria-label="t('下载 {name}', { name: file.file_name })" @click.prevent.stop="download_file(file)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12m-5-5 5 5 5-5M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/></svg>
            </button>
          </label>
          <CloudShares v-if="cloud && shares && sharing === file.id" :file="file" :api="shares" @failed="(message) => emit('failed', message)" />
        </li></template>
      </ul>
    </div>
    <p v-if="cleared_count" class="cleaner-empty" role="status">{{ cloud ? t("已删除 {count} 项", { count: cleared_count }) : t("已清理 {count} 项", { count: cleared_count }) }}</p>
    <footer class="cleaner-footer">
      <span :title="t('已选 {count} 项，将释放 {size}', { count: chosen.size, size: format_storage_bytes(chosen_bytes) })">{{ t("已选 {count} 项，将释放 {size}", { count: chosen.size, size: format_storage_bytes(chosen_bytes) }) }}</span>
      <button v-if="cloud" type="button" class="cleaner-clear" :class="{ 'is-confirming': confirming }" :disabled="!chosen.size || clearing" @click="clear_chosen">
        {{ clearing ? t("删除中…") : confirming ? t("确认删除") : t("删除所选") }}
      </button>
      <button v-else type="button" class="cleaner-clear" :class="{ 'is-confirming': confirming }" :disabled="!chosen.size || clearing" @click="clear_chosen">
        {{ clearing ? t("清理中…") : confirming ? t("确认清理（无法撤销）") : t("清理所选") }}
      </button>
    </footer>
  </div>
</template>

<style scoped>
.attachment-cleaner { display: flex; flex-direction: column; gap: 10px; font-size: 13px; }
.cleaner-note, .cleaner-empty { margin: 0; opacity: .7; font-size: 12px; line-height: 1.5; }
.cleaner-search { width: 100%; padding: 5px 9px; color: inherit; font: inherit; background: transparent; border: 1px solid color-mix(in srgb, currentColor 22%, transparent); border-radius: 6px; }
.cleaner-transfer { flex-shrink: 0; color: #d0892c; font-size: 11px; }
.cleaner-usage { display: flex; align-items: center; height: 20px; margin: 0; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
.cleaner-room { max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cleaner-download { display: grid; flex-shrink: 0; width: 26px; height: 26px; padding: 0; color: inherit; background: none; border: 0; border-radius: 5px; opacity: .65; cursor: pointer; place-items: center; }
.cleaner-download:hover { opacity: 1; background: color-mix(in srgb, currentColor 10%, transparent); }
.cleaner-download:disabled { opacity: .3; cursor: default; }
.cleaner-download svg { width: 16px; height: 16px; }
.cleaner-filters { display: flex; flex-wrap: wrap; gap: 6px; }
.cleaner-chip { display: inline-flex; align-items: baseline; gap: 5px; padding: 3px 10px; color: inherit; font: inherit; font-size: 12px; background: transparent; border: 1px solid color-mix(in srgb, currentColor 22%, transparent); border-radius: 999px; cursor: pointer; }
.cleaner-chip small { width: 8ch; text-align: right; white-space: nowrap; opacity: .6; font-variant-numeric: tabular-nums; }
.cleaner-chip[aria-pressed="true"] { color: #3973f9; border-color: #3973f9; background: color-mix(in srgb, #3973f9 10%, transparent); }
.cleaner-list { height: min(39vh, 320px); margin: 0; padding: 0; overflow-y: auto; scrollbar-gutter: stable; list-style: none; }
.cleaner-list > .cleaner-empty { padding: 8px 4px; }
.cleaner-row { display: flex; align-items: center; gap: 8px; min-height: 32px; padding: 2px 4px; border-radius: 6px; cursor: pointer; }
.cleaner-row:hover { background: color-mix(in srgb, currentColor 6%, transparent); }
.cleaner-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cleaner-meta { flex-shrink: 0; opacity: .55; font-variant-numeric: tabular-nums; }
.cleaner-size { flex-shrink: 0; width: 76px; text-align: right; font-variant-numeric: tabular-nums; }
.cleaner-all { opacity: .8; }
.cleaner-footer { display: grid; grid-template-columns: minmax(0, 1fr) min(42%, 13rem); align-items: center; gap: 8px; padding-top: 8px; border-top: 1px solid color-mix(in srgb, currentColor 12%, transparent); }
.cleaner-footer > span { display: -webkit-box; height: 2lh; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.cleaner-clear { min-height: 42px; padding: 4px 8px; color: #f05252; font: inherit; font-size: 12px; background: transparent; border: 1px solid #f05252; border-radius: 6px; cursor: pointer; }
.cleaner-clear.is-confirming { color: #fff; background: #f05252; }
.cleaner-clear:disabled { opacity: .45; cursor: default; }
</style>

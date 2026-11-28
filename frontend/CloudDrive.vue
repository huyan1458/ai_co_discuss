<script>
// Where the cloud space view was, kept while the file page is left and opened again.
let last_place = "root";
</script>

<script setup>
/**
 * The account's cloud space in the file page ("云盘"): one drive for the whole account, the same from every room. Folders
 * live only in the site's records (moving or renaming touches nothing in the storage); room attachments and transfer
 * copies sit in two read-only folders of their own; deleted drive files wait 30 days in the recycle bin, still counted
 * against the quota. Lists and grid, many selected at once, folders uploaded with their structure, thumbnails made by
 * this browser. Every transfer shows in TransferList.
 *
 * Emits `land(file)` to bring a file into a project (the file page then asks for the folder).
 */
import { computed, inject, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { t } from "./i18n.js";
import { format_storage_bytes } from "./storage-format.js";
import CloudShares from "./CloudShares.vue";
import { transfer } from "./transfers.js";
import { purge_in_batches } from "./object-storage-fields.js";

const emit = defineEmits(["land"]);
const { bridge } = inject("discussion");
const BASE = "/api/rooms/cloud-attachments";
const MIB = 1024 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024, MAX_UPLOAD_FILES = 2000, MAX_BATCH_DOWNLOAD = 20;
const SKIPPED_NAMES = new Set([".ds_store", "thumbs.db", "desktop.ini"]);
const PREVIEWABLE = /^(image|video|audio)\/|^application\/pdf$/;
const THUMB_EDGE = 480, THUMB_MAX_BYTES = 64 * 1024, THUMB_VIDEO_TIMEOUT_MS = 8000;
const SEARCH_DELAY_MS = 300, DOWNLOAD_GAP_MS = 400;
const LAYOUT_KEY = "codiscuss-cloud-layout";
// The read-only places beside the folders, by the `folder` value the site takes.
const SPECIAL = computed(() => [
  { id: "rooms", name: t("房间附件"), icon: "i-lucide-messages-square" },
  { id: "transfers", name: t("传输暂存"), icon: "i-lucide-arrow-left-right" },
  { id: "trash", name: t("回收站"), icon: "i-lucide-trash-2" },
]);

const place = ref(last_place);
const listing = ref(null);
const loading = ref(false);
const query = ref("");
const layout = ref(localStorage.getItem(LAYOUT_KEY) === "grid" ? "grid" : "list");
watch(layout, (value) => localStorage.setItem(LAYOUT_KEY, value));
watch(place, (value) => { last_place = value; });
// Chosen items, `file:<id>` or `folder:<id>`.
const selected = ref(new Set());
// A name being typed: { kind: "new-folder" | "rename", item, value }.
const naming = ref(null);
const sharing = ref(null);
const thumbnails = reactive({});
let read_serial = 0, search_timer = 0;

const in_trash = computed(() => place.value === "trash");
const special = computed(() => ["rooms", "transfers", "trash"].includes(place.value));
const searching = computed(() => Boolean(query.value.trim()));
const folders = computed(() => listing.value?.folders || []);
const files = computed(() => listing.value?.files || []);
// The folders below the top, as the site names them (its path starts at the top, shown as "云空间" here).
/** A folder's name in this page's language: the fixed places by their ID, the user's folders as named. */
const folder_name = (folder) => SPECIAL.value.find((item) => item.id === folder.id)?.name || folder.name;
const path = computed(() => {
  const named = SPECIAL.value.find((item) => item.id === place.value);
  const given = (listing.value?.folder?.path || []).filter((part) => part.id !== "root").map((part) => ({ ...part, name: folder_name(part) }));
  return given.length ? given : named ? [{ id: named.id, name: named.name }] : [];
});
// The site lists the read-only places among the top's folders; the recycle bin is added beside them here.
const top_places = computed(() => SPECIAL.value.filter((item) => item.id === "trash" || !folders.value.some((folder) => folder.id === item.id)));
const free_bytes = computed(() => listing.value?.quota_mib ? listing.value.quota_mib * MIB - (listing.value.used_bytes || 0) : Infinity);

/** What a file is: a drive file (everything allowed), a room attachment, or a transfer copy (both read-only). */
function category(file) {
  if (file.kind === "attachment") return "room";
  if (file.purpose && file.purpose !== "keep") return "transfer";
  return "drive";
}
const key_of = (type, item) => `${type}:${item.id}`;

async function reload() {
  const serial = ++read_serial;
  loading.value = true;
  try {
    const params = new URLSearchParams({ folder: place.value });
    if (searching.value) params.set("q", query.value.trim());
    const answer = await bridge.request(`${BASE}?${params}`);
    if (serial !== read_serial) return;
    listing.value = answer;
    selected.value = new Set();
    load_thumbnails(answer.files || []);
  } catch (error) {
    if (serial !== read_serial) return;
    // A folder gone meanwhile leaves for the top.
    if (error.status === 404 && place.value !== "root") { place.value = "root"; return reload(); }
    bridge.notify("error", error.message);
  } finally { if (serial === read_serial) loading.value = false; }
}
defineExpose({ reload });

function open_place(id) {
  place.value = id;
  query.value = "";
  naming.value = null;
  reload();
}
watch(query, () => { clearTimeout(search_timer); search_timer = setTimeout(reload, SEARCH_DELAY_MS); });
onMounted(reload);
onBeforeUnmount(() => clearTimeout(search_timer));

// ---- thumbnails ----

async function load_thumbnails(list) {
  for (const file of list) {
    if (!(file.thumbnail_type || file.has_thumbnail) || thumbnails[file.id]) continue;
    try { thumbnails[file.id] = await bridge.cloud_thumbnail_url(file.id); }
    catch { /* The type icon stays. */ }
  }
}

/** A canvas of the picture, its long side at most 480 px, as WebP (or JPEG) of at most 64 KiB, or null. */
async function encode_thumbnail(source, width, height) {
  const scale = Math.min(1, THUMB_EDGE / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
  for (const [type, quality] of [["image/webp", 0.8], ["image/webp", 0.6], ["image/jpeg", 0.6], ["image/jpeg", 0.4]]) {
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, type, quality));
    if (blob && blob.type === type && blob.size <= THUMB_MAX_BYTES) return blob;
  }
  return null;
}

/** The small picture of an image, or of a frame near a video's start; null when this browser cannot read it. */
async function make_thumbnail(file) {
  try {
    if (file.type.startsWith("image/")) {
      const bitmap = await createImageBitmap(file);
      try { return await encode_thumbnail(bitmap, bitmap.width, bitmap.height); } finally { bitmap.close?.(); }
    }
    if (!file.type.startsWith("video/")) return null;
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    try {
      video.muted = true;
      video.preload = "auto";
      video.src = url;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timeout")), THUMB_VIDEO_TIMEOUT_MS);
        video.addEventListener("loadeddata", () => { video.currentTime = Math.min(1, (video.duration || 0) / 10); }, { once: true });
        video.addEventListener("seeked", () => { clearTimeout(timer); resolve(); }, { once: true });
        video.addEventListener("error", () => { clearTimeout(timer); reject(new Error("decode")); }, { once: true });
      });
      return await encode_thumbnail(video, video.videoWidth, video.videoHeight);
    } finally { video.removeAttribute("src"); URL.revokeObjectURL(url); }
  } catch { return null; }
}

// ---- uploads ----

const file_input = ref(null), folder_input = ref(null);

/** A stable submission ID for one file of one upload batch, so a retry is the same file. */
async function submission_of(batch, relative_path) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${batch}\n${relative_path}`));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

/** Every file under dropped entries, with the folder it sits in relative to what was dropped. */
async function walk_entries(entries) {
  const found = [];
  const read_dir = (reader) => new Promise((resolve, reject) => reader.readEntries(resolve, reject));
  const visit = async (entry, dir) => {
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      found.push({ file, dir });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const inner = dir ? `${dir}/${entry.name}` : entry.name;
      for (let batch = await read_dir(reader); batch.length; batch = await read_dir(reader)) {
        for (const child of batch) await visit(child, inner);
      }
    }
  };
  for (const entry of entries) await visit(entry, "");
  return found;
}

/**
 * Upload files (each `{ file, dir }`, `dir` its folder relative to the current one) into the folder shown. Files that
 * cannot go up are skipped and said; a batch too large or too big for the space left does not start at all.
 */
async function upload(items) {
  if (special.value) return;
  const skipped = { empty: 0, large: 0, system: 0 };
  const accepted = items.filter(({ file }) => {
    if (SKIPPED_NAMES.has(file.name.toLowerCase())) { skipped.system += 1; return false; }
    if (!file.size) { skipped.empty += 1; return false; }
    if (file.size > MAX_FILE_BYTES) { skipped.large += 1; return false; }
    return true;
  });
  if (accepted.length > MAX_UPLOAD_FILES) { bridge.notify("warning", t("一次最多上传 {count} 个文件，请分批上传", { count: MAX_UPLOAD_FILES })); return; }
  const total = accepted.reduce((sum, { file }) => sum + file.size, 0);
  if (total > free_bytes.value) {
    bridge.notify("warning", t("云空间剩余 {free}，这批文件共 {total}，放不下；可以先清空回收站", { free: format_storage_bytes(Math.max(0, free_bytes.value)), total: format_storage_bytes(total) }));
    return;
  }
  const folder_id = place.value === "root" ? null : place.value;
  const batch = crypto.randomUUID();
  const results = await Promise.all(accepted.map(async ({ file, dir }) => {
    const submission_id = await submission_of(batch, dir ? `${dir}/${file.name}` : file.name);
    return transfer(dir ? `${dir}/${file.name}` : file.name, "drive", async ({ signal, progress }) => {
      const answer = await bridge.upload_to_cloud_space(file, { signal, on_progress: progress, folder_id, relative_dir: dir, submission_id });
      const id = answer?.cloud_file?.id || answer?.reserved?.id;
      // The small picture is a courtesy: a file without one shows its type icon.
      if (id) make_thumbnail(file).then((blob) => blob && bridge.save_cloud_thumbnail(id, blob)).catch(() => {});
      return answer;
    }, { parallel: true, browser: true });
  }));
  const done = results.filter((item) => item.ok).length;
  const failed = results.filter((item) => !item.ok && !item.cancelled).length;
  const skipped_count = skipped.empty + skipped.large + skipped.system;
  if (accepted.length > 1 || skipped_count || failed) {
    const reasons = [skipped.empty ? t("空文件 {count} 个", { count: skipped.empty }) : "", skipped.large ? t("超过 2 GiB 的 {count} 个", { count: skipped.large }) : "",
      skipped.system ? t("系统文件 {count} 个", { count: skipped.system }) : ""].filter(Boolean).join(" / ");
    bridge.notify(failed ? "warning" : "info", skipped_count
      ? t("上传完成：成功 {done} 个，跳过 {skipped} 个（{reasons}），失败 {failed} 个", { done, skipped: skipped_count, reasons, failed })
      : t("上传完成：成功 {done} 个，失败 {failed} 个", { done, failed }));
  }
  if (done) reload();
}

function pick_files(list) {
  const items = [...list].map((file) => ({ file, dir: "" }));
  if (file_input.value) file_input.value.value = "";
  upload(items);
}

function pick_folder(list) {
  // A picked folder's files carry their path from the picked folder down, the file's own name last.
  const items = [...list].map((file) => ({ file, dir: (file.webkitRelativePath || "").split("/").slice(0, -1).join("/") }));
  if (folder_input.value) folder_input.value.value = "";
  upload(items);
}

async function drop(event) {
  if (!event.dataTransfer?.types.includes("Files")) return;
  event.preventDefault();
  if (event.type !== "drop" || special.value) return;
  const entries = [...event.dataTransfer.items].map((item) => item.webkitGetAsEntry?.()).filter(Boolean);
  try { upload(entries.length ? await walk_entries(entries) : [...event.dataTransfer.files].map((file) => ({ file, dir: "" }))); }
  catch (error) { bridge.notify("error", error.message); }
}

// ---- selection and actions ----

function toggle(key) {
  const next = new Set(selected.value);
  next.has(key) ? next.delete(key) : next.add(key);
  selected.value = next;
}
const all_keys = computed(() => [...folders.value.filter((item) => !item.readonly).map((item) => key_of("folder", item)), ...files.value.map((item) => key_of("file", item))]);
const all_chosen = computed(() => all_keys.value.length > 0 && all_keys.value.every((key) => selected.value.has(key)));
function toggle_all() { selected.value = all_chosen.value ? new Set() : new Set(all_keys.value); }
const chosen = computed(() => ({
  files: files.value.filter((item) => selected.value.has(key_of("file", item))),
  folders: folders.value.filter((item) => selected.value.has(key_of("folder", item))),
}));
// Moving and renaming are for drive items only; room attachments and transfer copies stay where they are.
const can_move = computed(() => !in_trash.value && (chosen.value.files.length || chosen.value.folders.length)
  && chosen.value.files.every((file) => category(file) === "drive"));

async function run(task, success) {
  try {
    const answer = await task();
    if (success) bridge.notify("info", typeof success === "function" ? success(answer) : success);
    await reload();
    return answer;
  } catch (error) { bridge.notify("error", error.message); return null; }
}

/** The short link straight to the storage the site signs for one file. */
async function link_of(file) {
  const route = file.kind === "attachment" || !file.url
    ? `/api/rooms/${encodeURIComponent(file.room_id)}/attachments/${encodeURIComponent(file.id)}/content` : file.url;
  return (await bridge.request(`${route}?link=1`)).url;
}

async function download_files(list) {
  if (list.length > MAX_BATCH_DOWNLOAD) { bridge.notify("warning", t("一次最多下载 {count} 个文件，请分批下载", { count: MAX_BATCH_DOWNLOAD })); return; }
  for (const [index, file] of list.entries()) {
    try {
      const anchor = document.createElement("a");
      anchor.href = await link_of(file);
      anchor.download = file.file_name || "";
      anchor.rel = "noopener";
      anchor.click();
    } catch (error) { bridge.notify("error", t("“{name}”下载失败：{reason}", { name: file.file_name, reason: error.message })); }
    if (index < list.length - 1) await new Promise((resolve) => setTimeout(resolve, DOWNLOAD_GAP_MS));
  }
}

function preview(file) {
  Promise.resolve(bridge.preview_cloud_file({ ...file, kind: file.kind || "cloud_file" })).catch((error) => bridge.notify("error", error.message));
}

/**
 * Delete what is chosen: drive items go to the recycle bin; room attachments and transfer copies, and anything deleted
 * in the recycle bin, are gone at once after a confirmation.
 */
async function remove(list_files, list_folders, permanent = in_trash.value) {
  const body = { ids: list_files.map((item) => item.id), folder_ids: list_folders.map((item) => item.id) };
  const lasting = permanent || list_files.some((file) => category(file) !== "drive");
  if (!lasting) return run(() => bridge.request(`${BASE}/delete`, body), t("已移到回收站，30 天内可以还原"));
  if (!window.confirm(t("这些文件会立即彻底删除，无法恢复。确认删除？"))) return;
  const name = list_files.length + list_folders.length === 1 ? (list_files[0]?.file_name || list_folders[0]?.name) : t("{count} 项", { count: list_files.length + list_folders.length });
  await purge(name, () => bridge.request(`${BASE}/delete`, { ...body, permanent: true }));
}

/**
 * Delete for good in rounds of a small batch each until the site says none remain (purge_in_batches), its progress a row
 * of the transfer list; the list here is read again once it is over, done or not.
 */
async function purge(name, request) {
  const outcome = await transfer(name, "purge", ({ progress }) => purge_in_batches(request, progress));
  if (outcome.ok) bridge.notify("info", t("已释放 {size}", { size: format_storage_bytes(outcome.result.freed_bytes) }));
  await reload();
}

const restore = (list_files, list_folders) => run(() => bridge.request(`${BASE}/restore`, { ids: list_files.map((item) => item.id), folder_ids: list_folders.map((item) => item.id) }), t("已还原"));

async function empty_trash() {
  if (!window.confirm(t("回收站里的文件会全部彻底删除，无法恢复。确认清空？"))) return;
  await purge(t("清空回收站"), () => bridge.request(`${BASE}/trash/empty`, {}));
}

function start_naming(kind, item = null) {
  naming.value = { kind, item, value: kind === "rename" ? (item.file_name ?? item.name) : "" };
}
async function finish_naming() {
  const job = naming.value;
  const name = job?.value.trim();
  if (!name) return;
  naming.value = null;
  if (job.kind === "new-folder") await run(() => bridge.request(`${BASE}/folders`, { parent_id: place.value === "root" ? null : place.value, name }));
  else await run(() => bridge.request(`${BASE}/rename`, { kind: job.item.file_name !== undefined ? "file" : "folder", id: job.item.id, name }));
}

// ---- move ----

// The folder picker for a move: the items moving and the folder being looked into.
const moving = ref(null);
async function open_move(list_files, list_folders) {
  moving.value = { files: list_files, folders: list_folders, at: null, path: [], children: [], loading: true };
  await browse_move(null);
}
async function browse_move(id) {
  const job = moving.value;
  job.loading = true;
  try {
    const answer = await bridge.request(`${BASE}?${new URLSearchParams({ folder: id || "root" })}`);
    if (moving.value !== job) return;
    // A folder cannot go into itself or below it.
    const leaving = new Set(job.folders.map((item) => item.id));
    Object.assign(job, { at: id, children: (answer.folders || []).filter((item) => !item.readonly && !leaving.has(item.id)),
      path: (answer.folder?.path || []).filter((part) => part.id !== "root") });
  } catch (error) { bridge.notify("error", error.message); }
  finally { job.loading = false; }
}
async function finish_move() {
  const job = moving.value;
  moving.value = null;
  await run(() => bridge.request(`${BASE}/move`, { file_ids: job.files.map((item) => item.id), folder_ids: job.folders.map((item) => item.id), target_id: job.at }), t("已移动"));
}

// Share links of one file (drive file or room attachment), with an optional access code.
const share_route = (file) => `${BASE}/${encodeURIComponent(file.id)}/shares`;
const share_api = {
  list: (file) => bridge.request(share_route(file)),
  create: (file, days, code) => bridge.request(share_route(file), { days, ...(code ? { code: true } : {}) }),
  revoke: (file, share) => bridge.request(`${share_route(file)}/${encodeURIComponent(share.id)}/revoke`, {}),
};

const date_label = (value) => value ? new Date(value).toLocaleDateString(undefined, { month: "2-digit", day: "2-digit" }) : "";
const file_icon = (file) => bridge.attachment_file_icon(file.file_name || "");
</script>

<template>
  <div class="cloud-drive" @dragover="drop" @drop="drop">
    <div class="cloud-drive-bar">
      <nav class="cloud-drive-path" :aria-label="t('云空间路径')">
        <button type="button" :disabled="place === 'root' && !searching" @click="open_place('root')">{{ t("云空间") }}</button>
        <template v-for="(part, index) in path" :key="part.id">
          <UIcon name="i-lucide-chevron-right" />
          <button type="button" :disabled="index === path.length - 1" @click="open_place(part.id)">{{ part.name }}</button>
        </template>
      </nav>
      <input v-model="query" type="search" class="cloud-drive-search" :placeholder="t('在整个云空间里按名称搜索')" :aria-label="t('按名称搜索')">
      <div class="cloud-drive-tools">
        <template v-if="!special">
          <UButton icon="i-lucide-upload" color="neutral" variant="ghost" size="sm" :aria-label="t('上传文件')" :title="t('上传文件（单个不超过 2 GiB）')" @click="file_input?.click()" />
          <UButton icon="i-lucide-folder-up" color="neutral" variant="ghost" size="sm" :aria-label="t('上传文件夹')" :title="t('上传文件夹')" @click="folder_input?.click()" />
          <UButton icon="i-lucide-folder-plus" color="neutral" variant="ghost" size="sm" :aria-label="t('新建文件夹')" :title="t('新建文件夹')" @click="start_naming('new-folder')" />
          <input ref="file_input" type="file" multiple hidden @change="pick_files($event.target.files)">
          <input ref="folder_input" type="file" multiple webkitdirectory hidden @change="pick_folder($event.target.files)">
        </template>
        <UButton v-if="in_trash" :label="t('清空回收站')" color="neutral" variant="ghost" size="sm" @click="empty_trash" />
        <UButton :icon="layout === 'grid' ? 'i-lucide-list' : 'i-lucide-layout-grid'" color="neutral" variant="ghost" size="sm"
          :aria-label="layout === 'grid' ? t('列表视图') : t('宫格视图')" :title="layout === 'grid' ? t('列表视图') : t('宫格视图')" @click="layout = layout === 'grid' ? 'list' : 'grid'" />
      </div>
    </div>

    <p v-if="listing?.quota_mib" class="cloud-drive-usage">
      {{ t("已用 {used} / 上限 {quota}", { used: format_storage_bytes(listing.used_bytes || 0), quota: format_storage_bytes(listing.quota_mib * MIB) }) }}
      <template v-if="listing.trash_bytes"> · {{ t("回收站占用 {size}", { size: format_storage_bytes(listing.trash_bytes) }) }}</template>
      <template v-if="in_trash"> · {{ t("回收站里的文件保留 30 天，仍占用空间") }}</template>
      <template v-else-if="place === 'rooms'"> · {{ t("随消息发出的大附件，不能改名或移动，删除后立即生效") }}</template>
      <template v-else-if="place === 'transfers'"> · {{ t("远程上传下载的中转副本，到期自动清理") }}</template>
    </p>

    <form v-if="naming" class="cloud-drive-naming" @submit.prevent="finish_naming">
      <input v-model="naming.value" maxlength="255" :aria-label="naming.kind === 'rename' ? t('新名称') : t('文件夹名称')" :placeholder="naming.kind === 'rename' ? t('新名称') : t('文件夹名称')" @keydown.esc.prevent="naming = null">
      <UButton type="submit" :label="t('确定')" size="xs" />
      <UButton :label="t('取消')" color="neutral" variant="ghost" size="xs" @click="naming = null" />
    </form>

    <div v-if="selected.size" class="cloud-drive-selection" role="toolbar" :aria-label="t('所选项目的操作')">
      <span>{{ t("已选 {count} 项", { count: selected.size }) }}</span>
      <template v-if="in_trash">
        <UButton :label="t('还原')" size="xs" color="neutral" variant="soft" @click="restore(chosen.files, chosen.folders)" />
        <UButton :label="t('彻底删除')" size="xs" color="error" variant="soft" @click="remove(chosen.files, chosen.folders, true)" />
      </template>
      <template v-else>
        <UButton v-if="chosen.files.length && !chosen.folders.length" :label="t('下载')" size="xs" color="neutral" variant="soft" @click="download_files(chosen.files)" />
        <UButton v-if="can_move" :label="t('移动')" size="xs" color="neutral" variant="soft" @click="open_move(chosen.files, chosen.folders)" />
        <UButton :label="t('删除')" size="xs" color="error" variant="soft" @click="remove(chosen.files, chosen.folders)" />
      </template>
      <UButton :label="t('取消选择')" size="xs" color="neutral" variant="ghost" @click="selected = new Set()" />
    </div>

    <p v-if="loading && !listing" class="cloud-drive-empty">{{ t("正在读取云空间…") }}</p>
    <template v-else>
      <label v-if="all_keys.length" class="cloud-drive-all"><input type="checkbox" :checked="all_chosen" @change="toggle_all"> {{ t("全选") }}</label>
      <div :class="layout === 'grid' ? 'cloud-drive-grid' : 'cloud-drive-rows'">
        <!-- At the top: the read-only places beside the folders. -->
        <template v-if="place === 'root' && !searching">
          <button v-for="item in top_places" :key="item.id" type="button" class="cloud-drive-item is-place" @click="open_place(item.id)">
            <UIcon :name="item.icon" class="cloud-drive-icon" /><span class="cloud-drive-name">{{ item.name }}</span>
          </button>
        </template>
        <div v-for="folder in folders.filter((item) => !(place === 'root' && searching && item.readonly))" :key="key_of('folder', folder)" class="cloud-drive-item" :class="{ 'is-chosen': selected.has(key_of('folder', folder)) }">
          <input v-if="!folder.readonly" type="checkbox" :checked="selected.has(key_of('folder', folder))" :aria-label="t('选择 {name}', { name: folder.name })" @change="toggle(key_of('folder', folder))">
          <button type="button" class="cloud-drive-open" :disabled="in_trash" @click="open_place(folder.id)">
            <UIcon :name="SPECIAL.find((item) => item.id === folder.id)?.icon || 'i-lucide-folder'" class="cloud-drive-icon" :class="{ 'is-folder': !folder.readonly }" /><span class="cloud-drive-name" :title="folder_name(folder)">{{ folder_name(folder) }}</span>
          </button>
          <small class="cloud-drive-meta">{{ date_label(folder.trashed_at || folder.created_at) }}</small>
          <span v-if="!folder.readonly" class="cloud-drive-actions">
            <template v-if="in_trash">
              <UButton icon="i-lucide-undo-2" color="neutral" variant="ghost" size="xs" :aria-label="t('还原 {name}', { name: folder.name })" @click="restore([], [folder])" />
            </template>
            <template v-else>
              <UButton icon="i-lucide-pencil" color="neutral" variant="ghost" size="xs" :aria-label="t('重命名 {name}', { name: folder.name })" @click="start_naming('rename', folder)" />
              <UButton icon="i-lucide-folder-input" color="neutral" variant="ghost" size="xs" :aria-label="t('移动 {name}', { name: folder.name })" @click="open_move([], [folder])" />
              <UButton icon="i-lucide-trash-2" color="neutral" variant="ghost" size="xs" :aria-label="t('删除 {name}', { name: folder.name })" @click="remove([], [folder])" />
            </template>
          </span>
        </div>
        <div v-for="file in files" :key="key_of('file', file)" class="cloud-drive-item" :class="{ 'is-chosen': selected.has(key_of('file', file)) }">
          <input type="checkbox" :checked="selected.has(key_of('file', file))" :aria-label="t('选择 {name}', { name: file.file_name })" @change="toggle(key_of('file', file))">
          <button type="button" class="cloud-drive-open" :disabled="in_trash || !PREVIEWABLE.test(file.content_type || '')" @click="preview(file)">
            <img v-if="thumbnails[file.id]" :src="thumbnails[file.id]" alt="" class="cloud-drive-thumb" loading="lazy">
            <span v-else class="cloud-drive-type" v-html="file_icon(file)"></span>
            <span class="cloud-drive-name" :title="file.file_name">{{ file.file_name }}</span>
          </button>
          <small class="cloud-drive-meta">{{ format_storage_bytes(file.size) }} · {{ date_label(file.trashed_at || file.created_at) }}<template v-if="category(file) === 'transfer'"> · {{ t("传输暂存") }}</template></small>
          <span class="cloud-drive-actions">
            <template v-if="in_trash">
              <UButton icon="i-lucide-undo-2" color="neutral" variant="ghost" size="xs" :aria-label="t('还原 {name}', { name: file.file_name })" @click="restore([file], [])" />
            </template>
            <template v-else>
              <UButton icon="i-lucide-download" color="neutral" variant="ghost" size="xs" :aria-label="t('下载 {name}', { name: file.file_name })" @click="download_files([file])" />
              <UButton v-if="category(file) !== 'transfer'" icon="i-lucide-link" color="neutral" variant="ghost" size="xs" :aria-label="t('分享 {name}', { name: file.file_name })" @click="sharing = file" />
              <UButton v-if="category(file) !== 'transfer'" icon="i-lucide-folder-down" color="neutral" variant="ghost" size="xs" :aria-label="t('把 {name} 取回到项目', { name: file.file_name })" @click="emit('land', file)" />
              <UButton v-if="category(file) === 'drive'" icon="i-lucide-pencil" color="neutral" variant="ghost" size="xs" :aria-label="t('重命名 {name}', { name: file.file_name })" @click="start_naming('rename', file)" />
              <UButton v-if="category(file) === 'drive'" icon="i-lucide-folder-input" color="neutral" variant="ghost" size="xs" :aria-label="t('移动 {name}', { name: file.file_name })" @click="open_move([file], [])" />
              <UButton icon="i-lucide-trash-2" color="neutral" variant="ghost" size="xs" :aria-label="t('删除 {name}', { name: file.file_name })" @click="remove([file], [])" />
            </template>
          </span>
        </div>
      </div>
      <p v-if="listing && !folders.length && !files.length && (place !== 'root' || searching)" class="cloud-drive-empty">
        {{ searching ? t("没有找到名称里有这些字的文件") : in_trash ? t("回收站是空的") : special ? t("这里没有文件") : t("这个文件夹是空的。可以上传文件，或把文件、文件夹拖到这里。") }}
      </p>
      <p v-else-if="listing && place === 'root' && !searching && !folders.length && !files.length" class="cloud-drive-empty">{{ t("可以上传文件，或把文件、文件夹拖到这里。") }}</p>
    </template>

    <UModal :open="Boolean(sharing)" :title="sharing ? t('分享 {name}', { name: sharing.file_name }) : ''" @update:open="(open) => !open && (sharing = null)">
      <template #body><CloudShares v-if="sharing" :file="sharing" :api="share_api" with-code @failed="(message) => bridge.notify('error', message)" /></template>
    </UModal>

    <UModal :open="Boolean(moving)" :title="t('移动到')" @update:open="(open) => !open && (moving = null)">
      <template #body>
        <div v-if="moving" class="cloud-drive-move">
          <nav class="cloud-drive-path">
            <button type="button" :disabled="!moving.at" @click="browse_move(null)">{{ t("云空间") }}</button>
            <template v-for="part in moving.path" :key="part.id"><UIcon name="i-lucide-chevron-right" /><button type="button" @click="browse_move(part.id)">{{ part.name }}</button></template>
          </nav>
          <p v-if="moving.loading" class="cloud-drive-empty">{{ t("正在读取…") }}</p>
          <button v-for="folder in moving.children" v-else :key="folder.id" type="button" class="cloud-drive-item is-place" @click="browse_move(folder.id)">
            <UIcon name="i-lucide-folder" class="cloud-drive-icon is-folder" /><span class="cloud-drive-name">{{ folder.name }}</span>
          </button>
          <div class="cloud-drive-move-foot">
            <UButton :label="t('取消')" color="neutral" variant="ghost" size="sm" @click="moving = null" />
            <UButton :label="t('移到这里')" size="sm" :disabled="moving.loading" @click="finish_move" />
          </div>
        </div>
      </template>
    </UModal>
  </div>
</template>

<style scoped>
.cloud-drive { display: flex; flex-direction: column; gap: 8px; min-height: 260px; padding: 8px 10px 12px; font-size: 13px; }
.cloud-drive-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.cloud-drive-path { display: flex; flex: 1; flex-wrap: wrap; gap: 2px; align-items: center; min-width: 0; }
.cloud-drive-path button { padding: 2px 6px; color: inherit; font: inherit; background: none; border: 0; border-radius: 5px; cursor: pointer; }
.cloud-drive-path button:disabled { font-weight: 600; cursor: default; }
.cloud-drive-path button:not(:disabled):hover { background: color-mix(in srgb, currentColor 8%, transparent); }
.cloud-drive-search { width: min(260px, 100%); padding: 4px 9px; color: inherit; font: inherit; background: transparent; border: 1px solid var(--ui-border); border-radius: 6px; }
.cloud-drive-tools { display: flex; gap: 2px; align-items: center; }
.cloud-drive-usage, .cloud-drive-empty { margin: 0; color: var(--ui-text-muted); font-size: 12px; }
.cloud-drive-empty { padding: 18px 4px; text-align: center; }
.cloud-drive-naming, .cloud-drive-selection { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 6px 8px; border: 1px solid var(--ui-border-muted); border-radius: 8px; }
.cloud-drive-naming input { flex: 1; min-width: 160px; padding: 3px 8px; color: inherit; font: inherit; background: transparent; border: 1px solid var(--ui-border); border-radius: 5px; }
.cloud-drive-selection > span { margin-right: auto; font-weight: 600; }
.cloud-drive-all { display: inline-flex; gap: 6px; align-items: center; color: var(--ui-text-muted); font-size: 12px; }
.cloud-drive-rows { display: flex; flex-direction: column; }
.cloud-drive-rows .cloud-drive-item { display: flex; gap: 8px; align-items: center; min-height: 40px; padding: 2px 6px; border-top: 1px solid var(--ui-border-muted); border-radius: 0; }
.cloud-drive-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 10px; }
.cloud-drive-grid .cloud-drive-item { position: relative; display: flex; flex-direction: column; gap: 4px; padding: 8px; border: 1px solid var(--ui-border-muted); border-radius: 10px; }
.cloud-drive-grid .cloud-drive-item > input { position: absolute; top: 8px; left: 8px; z-index: 1; }
.cloud-drive-grid .cloud-drive-open { flex-direction: column; }
.cloud-drive-grid .cloud-drive-thumb, .cloud-drive-grid .cloud-drive-type, .cloud-drive-grid .cloud-drive-icon { width: 100%; height: 96px; }
.cloud-drive-grid .cloud-drive-thumb { object-fit: cover; border-radius: 6px; }
.cloud-drive-grid .cloud-drive-type { display: grid; place-items: center; }
.cloud-drive-grid .cloud-drive-actions { flex-wrap: wrap; justify-content: center; }
.cloud-drive-item.is-chosen { background: color-mix(in srgb, #3973f9 8%, transparent); }
.cloud-drive-item.is-place { gap: 8px; color: inherit; font: inherit; text-align: left; background: none; cursor: pointer; }
.cloud-drive-open { display: flex; flex: 1; gap: 8px; align-items: center; min-width: 0; padding: 0; color: inherit; font: inherit; text-align: left; background: none; border: 0; cursor: pointer; }
.cloud-drive-open:disabled { cursor: default; }
.cloud-drive-rows .cloud-drive-thumb { width: 32px; height: 32px; object-fit: cover; border-radius: 4px; }
.cloud-drive-icon { width: 22px; height: 22px; flex-shrink: 0; color: var(--ui-text-muted); }
.cloud-drive-icon.is-folder { color: #e8a93c; }
.cloud-drive-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cloud-drive-meta { flex-shrink: 0; color: var(--ui-text-muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.cloud-drive-actions { display: flex; flex-shrink: 0; gap: 0; }
.cloud-drive-move { display: flex; flex-direction: column; gap: 4px; }
.cloud-drive-move .cloud-drive-item { display: flex; align-items: center; padding: 6px; border: 0; border-radius: 6px; }
.cloud-drive-move .cloud-drive-item:hover { background: color-mix(in srgb, currentColor 6%, transparent); }
.cloud-drive-move-foot { display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px; }
@media (max-width: 600px) {
  .cloud-drive-rows .cloud-drive-meta { display: none; }
  .cloud-drive-search { width: 100%; }
}
</style>

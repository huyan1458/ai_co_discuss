/**
 * The account's cloud space ("云盘") as data and actions for the file page, which draws it with the same frame as a
 * project folder (heading tools, directory tabs, path bar, columns, each row's "…" menu). This module draws nothing: it
 * reads the listing, says which actions each item allows (`can`), and carries them out. One drive for the whole account,
 * the same from every room; folders live only in the site's records; room attachments and transfer copies sit in two
 * read-only folders; deleted drive files wait 30 days in the recycle bin, still counted against the quota.
 */
import { computed, reactive, ref } from "vue";
import { t } from "./i18n.js";
import { format_storage_bytes } from "./storage-format.js";
import { purge_in_batches } from "./object-storage-fields.js";
import { transfer } from "./transfers.js";

const BASE = "/api/rooms/cloud-attachments";
const MIB = 1024 * 1024;
export const CLOUD_MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_UPLOAD_FILES = 2000, MAX_BATCH_DOWNLOAD = 20;
const SKIPPED_NAMES = new Set([".ds_store", "thumbs.db", "desktop.ini"]);
const PREVIEWABLE = /^(image|video|audio)\/|^application\/pdf$/;
const THUMB_EDGE = 480, THUMB_MAX_BYTES = 64 * 1024, THUMB_VIDEO_TIMEOUT_MS = 8000;
const DOWNLOAD_GAP_MS = 400;
// The read-only places beside the folders, by the `folder` value the site takes.
export const CLOUD_READONLY = ["rooms", "transfers"];
const SPECIAL_PLACES = ["rooms", "transfers", "trash"];

/** What a file is: a drive file (everything allowed), a room attachment, or a transfer copy (both read-only). */
export function cloud_category(file) {
  if (file.kind === "attachment") return "room";
  if (file.purpose && file.purpose !== "keep") return "transfer";
  return "drive";
}

/**
 * Which actions an item of the cloud space allows where it is shown: the file page shows a menu item or button only for
 * those. `in_trash`: the item is in the recycle bin.
 */
export function cloud_can(item, { in_trash = false, folder = false } = {}) {
  if (in_trash) return { restore: true, purge: true };
  if (folder) return item.readonly ? { open: true } : { open: true, rename: true, move: true, delete: true };
  const category = cloud_category(item);
  return {
    preview: PREVIEWABLE.test(String(item.content_type || "")),
    download: true,
    rename: category === "drive",
    move: category === "drive",
    delete: true,
    share: category !== "transfer",
    land: category !== "transfer",
  };
}

/**
 * Why each action of the file page's selection bar does not apply to what is chosen, or "" when it does. The bar keeps
 * download, move, delete in fixed places (in the cloud recycle bin: restore, move, delete for good), greyed out with this
 * as the reason. `cloud`: the choice is in the cloud space (else a project folder); `in_trash`: in its recycle bin.
 */
export function selection_blocks({ files, folders, cloud = false, in_trash = false }) {
  if (cloud && in_trash) return { first: "", move: t("回收站里不能移动"), last: "" };
  const first = folders.length ? t("文件夹不能批量下载")
    : files.length > MAX_BATCH_DOWNLOAD ? t("一次最多下载 {count} 个文件", { count: MAX_BATCH_DOWNLOAD }) : "";
  const move = cloud && files.some((file) => !cloud_can(file).move) ? t("只读文件夹里的文件不能移动") : "";
  return { first, move, last: "" };
}

/** A fixed place's name in this page's language; a user's folder keeps its own name. */
export function cloud_place_name(id, fallback = "") {
  return { root: t("云空间"), rooms: t("房间附件"), transfers: t("传输暂存"), trash: t("回收站") }[id] || fallback;
}

/** A stable submission ID for one file of one upload batch, so a retry is the same file. */
export async function cloud_submission_id(batch, relative_path) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${batch}\n${relative_path}`));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

/**
 * Split files picked for upload into those that go up and those skipped, and say whether the batch may start at all.
 *
 * Args:
 *   items: [{ file, dir }]. free_bytes: the space left.
 * Returns:
 *   { accepted, skipped: { empty, large, system }, refusal } — `refusal` is the reason the batch cannot start, or "".
 */
export function plan_cloud_upload(items, free_bytes) {
  const skipped = { empty: 0, large: 0, system: 0 };
  const accepted = items.filter(({ file }) => {
    if (SKIPPED_NAMES.has(file.name.toLowerCase())) { skipped.system += 1; return false; }
    if (!file.size) { skipped.empty += 1; return false; }
    if (file.size > CLOUD_MAX_FILE_BYTES) { skipped.large += 1; return false; }
    return true;
  });
  const total = accepted.reduce((sum, { file }) => sum + file.size, 0);
  const refusal = accepted.length > MAX_UPLOAD_FILES ? t("一次最多上传 {count} 个文件，请分批上传", { count: MAX_UPLOAD_FILES })
    : total > free_bytes ? t("云空间剩余 {free}，这批文件共 {total}，放不下；可以先清空回收站", { free: format_storage_bytes(Math.max(0, free_bytes)), total: format_storage_bytes(total) }) : "";
  return { accepted, skipped, refusal };
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

/** Every file under dropped entries, with the folder it sits in relative to what was dropped. */
export async function walk_dropped(entries) {
  const found = [];
  const read_dir = (reader) => new Promise((resolve, reject) => reader.readEntries(resolve, reject));
  const visit = async (entry, dir) => {
    if (entry.isFile) found.push({ file: await new Promise((resolve, reject) => entry.file(resolve, reject)), dir });
    else if (entry.isDirectory) {
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
 * The cloud space's state and actions for one file page.
 *
 * Args:
 *   bridge: the page's bridge (request, preview, uploads, thumbnails, notify).
 * Returns:
 *   { place, listing, loading, query, thumbnails, transfers_empty, path, folders, files, in_trash, special, usage, can,
 *     reload, open, upload, mkdir, rename, move, remove, restore, empty_trash, download, save_one, preview, share_api }.
 */
export function use_cloud_drive(bridge) {
  const place = ref("root");
  const listing = ref(null);
  const loading = ref(false);
  const query = ref("");
  const thumbnails = reactive({});
  // Whether "传输暂存" holds nothing, so the top hides it.
  const transfers_empty = ref(false);
  let serial = 0;

  const in_trash = computed(() => place.value === "trash");
  const special = computed(() => SPECIAL_PLACES.includes(place.value));
  const searching = computed(() => Boolean(query.value.trim()));
  // Read-only places first, then the user's folders; an empty "传输暂存" is left out.
  const folders = computed(() => {
    const list = (listing.value?.folders || []).map((folder) => ({ ...folder, name: folder.readonly ? cloud_place_name(folder.id, folder.name) : folder.name }));
    return [...list.filter((item) => item.readonly && !(item.id === "transfers" && transfers_empty.value)), ...list.filter((item) => !item.readonly)];
  });
  const files = computed(() => listing.value?.files || []);
  // The folders below the top, as the site names them, the top being "云空间".
  const path = computed(() => {
    const given = (listing.value?.folder?.path || []).filter((part) => part.id !== "root")
      .map((part) => ({ ...part, name: SPECIAL_PLACES.includes(part.id) ? cloud_place_name(part.id, part.name) : part.name }));
    return given.length || place.value === "root" ? given : [{ id: place.value, name: cloud_place_name(place.value) }];
  });
  const usage = computed(() => listing.value?.quota_mib
    ? t("已用 {used} / 上限 {quota}", { used: format_storage_bytes(listing.value.used_bytes || 0), quota: format_storage_bytes(listing.value.quota_mib * MIB) }) : "");
  const free_bytes = computed(() => listing.value?.quota_mib ? listing.value.quota_mib * MIB - (listing.value.used_bytes || 0) : Infinity);
  const can = (item, folder = false) => cloud_can(item, { in_trash: in_trash.value, folder });

  async function load_thumbnails(list) {
    for (const file of list) {
      if (!(file.thumbnail_type || file.has_thumbnail) || thumbnails[file.id]) continue;
      try { thumbnails[file.id] = await bridge.cloud_thumbnail_url(file.id); } catch { /* The type icon stays. */ }
    }
  }

  async function reload() {
    const mine = ++serial;
    loading.value = true;
    try {
      const params = new URLSearchParams({ folder: place.value });
      if (searching.value) params.set("q", query.value.trim());
      const answer = await bridge.request(`${BASE}?${params}`);
      if (mine !== serial) return;
      listing.value = answer;
      load_thumbnails(answer.files || []);
      if (place.value === "root" && !searching.value) {
        bridge.request(`${BASE}?${new URLSearchParams({ folder: "transfers" })}`)
          .then((transfers) => { transfers_empty.value = !(transfers.files || []).length; }).catch(() => {});
      }
    } catch (error) {
      if (mine !== serial) return;
      // A folder gone meanwhile leaves for the top.
      if (error.status === 404 && place.value !== "root") { place.value = "root"; return reload(); }
      bridge.notify("error", error.message);
    } finally { if (mine === serial) loading.value = false; }
  }

  function open(id) {
    place.value = id;
    query.value = "";
    return reload();
  }

  async function act(task, success) {
    try {
      const answer = await task();
      if (success) bridge.notify("info", typeof success === "function" ? success(answer) : success);
      await reload();
      return answer;
    } catch (error) { bridge.notify("error", error.message); return null; }
  }

  /**
   * Upload files (each `{ file, dir }`, `dir` its folder relative to the one shown) into the folder shown, three at a
   * time with retries, each a row of the transfer list; folders are made as needed and same-named ones merged.
   */
  async function upload(items) {
    if (special.value) return;
    const { accepted, skipped, refusal } = plan_cloud_upload(items, free_bytes.value);
    if (refusal) { bridge.notify("warning", refusal); return; }
    const folder_id = place.value === "root" ? null : place.value;
    const batch = crypto.randomUUID();
    const results = await Promise.all(accepted.map(async ({ file, dir }) => {
      const relative = dir ? `${dir}/${file.name}` : file.name;
      const submission_id = await cloud_submission_id(batch, relative);
      return transfer(relative, "drive", async ({ signal, progress }) => {
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

  const mkdir = (name) => act(() => bridge.request(`${BASE}/folders`, { parent_id: place.value === "root" ? null : place.value, name }));
  const rename = (item, name, folder = false) => act(() => bridge.request(`${BASE}/rename`, { kind: folder ? "folder" : "file", id: item.id, name }));
  const move = (file_ids, folder_ids, target_id) => act(() => bridge.request(`${BASE}/move`, { file_ids, folder_ids, target_id }), t("已移动"));
  const restore = (file_ids, folder_ids) => act(() => bridge.request(`${BASE}/restore`, { ids: file_ids, folder_ids }), t("已还原"));

  /**
   * Delete for good in rounds of a small batch each until the site says none remain (purge_in_batches), its progress a
   * row of the transfer list; the listing is read again once it is over, done or not.
   */
  async function purge(name, request) {
    const outcome = await transfer(name, "purge", ({ progress }) => purge_in_batches(request, progress));
    if (outcome.ok) bridge.notify("info", t("已释放 {size}", { size: format_storage_bytes(outcome.result.freed_bytes) }));
    await reload();
  }

  /**
   * Delete items: drive items go to the recycle bin; room attachments and transfer copies, and anything deleted in the
   * recycle bin, are gone for good after a confirmation.
   */
  async function remove(list_files, list_folders, permanent = in_trash.value) {
    const body = { ids: list_files.map((item) => item.id), folder_ids: list_folders.map((item) => item.id) };
    const lasting = permanent || list_files.some((file) => cloud_category(file) !== "drive");
    if (!lasting) return act(() => bridge.request(`${BASE}/delete`, body), t("已移到回收站，30 天内可以还原"));
    if (!window.confirm(t("这些文件会立即彻底删除，无法恢复。确认删除？"))) return null;
    const count = list_files.length + list_folders.length;
    return purge(count === 1 ? (list_files[0]?.file_name || list_folders[0]?.name) : t("{count} 项", { count }), () => bridge.request(`${BASE}/delete`, { ...body, permanent: true }));
  }

  async function empty_trash() {
    if (!window.confirm(t("回收站里的文件会全部彻底删除，无法恢复。确认清空？"))) return;
    await purge(t("清空回收站"), () => bridge.request(`${BASE}/trash/empty`, {}));
  }

  /** The short link straight to the storage the site signs for one file. */
  async function link_of(file) {
    const route = file.kind === "attachment" || !file.url
      ? `/api/rooms/${encodeURIComponent(file.room_id)}/attachments/${encodeURIComponent(file.id)}/content` : file.url;
    return (await bridge.request(`${route}?link=1`)).url;
  }

  /** Save files one after another (at most 20 at a time); folders are not downloaded whole. */
  async function download(list) {
    if (list.length > MAX_BATCH_DOWNLOAD) { bridge.notify("warning", t("一次最多下载 {count} 个文件，请分批下载", { count: MAX_BATCH_DOWNLOAD })); return; }
    for (const [index, file] of list.entries()) {
      try { await save_one(file); } catch (error) { bridge.notify("error", t("“{name}”下载失败：{reason}", { name: file.file_name, reason: error.message })); }
      if (index < list.length - 1) await new Promise((resolve) => setTimeout(resolve, DOWNLOAD_GAP_MS));
    }
  }

  /** Save one file through the browser; throws when its link cannot be had. */
  async function save_one(file) {
    const anchor = document.createElement("a");
    anchor.href = await link_of(file);
    anchor.download = file.file_name || "";
    anchor.rel = "noopener";
    anchor.click();
  }

  function preview(file) {
    Promise.resolve(bridge.preview_cloud_file({ ...file, kind: file.kind || "cloud_file" })).catch((error) => bridge.notify("error", error.message));
  }

  /** The folders one level into `id` (the top when null), for choosing where to move to; read-only places left out. */
  async function child_folders(id) {
    const answer = await bridge.request(`${BASE}?${new URLSearchParams({ folder: id || "root" })}`);
    return { path: (answer.folder?.path || []).filter((part) => part.id !== "root"), folders: (answer.folders || []).filter((item) => !item.readonly) };
  }

  // Share links of one file (drive file or room attachment), with an optional access code.
  const share_route = (file) => `${BASE}/${encodeURIComponent(file.id)}/shares`;
  const share_api = {
    list: (file) => bridge.request(share_route(file)),
    create: (file, days, code) => bridge.request(share_route(file), { days, ...(code ? { code: true } : {}) }),
    revoke: (file, share) => bridge.request(`${share_route(file)}/${encodeURIComponent(share.id)}/revoke`, {}),
  };

  return { place, listing, loading, query, thumbnails, transfers_empty, path, folders, files, in_trash, special, searching, usage, can,
    reload, open, upload, mkdir, rename, move, remove, restore, empty_trash, download, save_one, preview, child_folders, share_api };
}

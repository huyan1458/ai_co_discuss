<script setup>
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { file_preview, file_size, file_type, folder_listings, modified_time, shown_folders, tile_icon } from "./file-preview.js";
import { t } from './i18n.js';
import ProjectFileThumbnail from "./ProjectFileThumbnail.vue";
import CloudShares from "./CloudShares.vue";
import { selection_blocks, use_cloud_drive, walk_dropped } from "./cloud-drive.js";
import TransferList from "./TransferList.vue";
import { clear_transfer, run_each, transfer } from "./transfers.js";
import { cloud_space_visible } from "./object-storage-fields.js";
import { moves_sideways, side_swipe } from "./side-swipe.js";

// The room's project directories, the main one first; with more than one, a switch above the list picks which is shown.
// Above them, "项目" lists the account's projects and drafts (runner `account_roots`), each opened by its id.
const props = defineProps({ directories: { type: Array, required: true } });
const { view, bridge } = inject("discussion");
const room_id = view.value.room.id;
const shown = shown_folders.get(room_id);
/** The folder shown: one of the room's directories by index, or an account folder by id (`{ id, name }`). */
const account_root = ref(shown?.account || null);
const root = ref(account_root.value ? account_root.value.id : Math.max(0, props.directories.indexOf(shown?.directory)));
const directory = computed(() => account_root.value ? `account:${account_root.value.id}` : props.directories[root.value] || props.directories[0]);
/** The last folder name of a directory, as its switch shows it; the page never shows where a folder is on the computer. */
const folder_name = (path) => String(path).split(/[\\/]+/).filter(Boolean).at(-1) || path;
const root_name = computed(() => account_root.value ? account_root.value.name : folder_name(directory.value));
// The folder being shown changes on the click itself; its listing comes from this browser's cache and is read again
// behind it. File contents are read only when a file is opened.
const current_path = ref(shown && (shown.account ? shown.account.id === account_root.value?.id : shown.directory === directory.value) ? shown.path : "");
const listing = ref(null);
const loading = ref(false);
// "roots": the account's projects and drafts; "trash": the recycle area; "folder": one folder.
const mode = ref(shown?.mode === "roots" ? "roots" : "folder");
const roots = ref(null);
const trash = ref(null);
const section_failure = ref("");
const busy = ref(false);
// A name being typed: `{ kind: "mkdir" | "rename" | "project", entry, value }`.
const naming = ref(null);
const name_input = ref(null);
// Copied or cut entry, pasted into the folder shown: `{ mode: "copy" | "move", root, path, name }`.
const clipboard = ref(null);
// Transfers (uploads, copies, landings, download preparation) show in TransferList, shared with the cloud space view.
const file_input = ref(null);
// A question about a name already taken: `{ name, many, resolve }`, answered "replace", "keep_both" or null (skip).
const asking = ref(null);
const ask_all = ref(false);
let listing_request = 0;
// The whole project's listings are kept current behind the page, top folders first: each pass asks only whether a folder
// changed, so an unchanged project costs a few small requests. Generated folders are read when they are opened.
const SWEEP_BATCH = 100, SWEEP_FOLDER_LIMIT = 10000, SWEEP_SETTLE_MS = 3000;
const SWEEP_SKIPPED = new Set(["node_modules", ".git", "__pycache__", ".venv", "venv"]);

let sweep_run = 0, sweep_timer = 0, left_page = false;
// "list" (name, size, time) or "icons" (tiles with image thumbnails), kept for this browser.
const LAYOUT_KEY = "codiscuss-project-files-layout";
const layout = ref(localStorage.getItem(LAYOUT_KEY) === "icons" ? "icons" : "list");
watch(layout, (value) => localStorage.setItem(LAYOUT_KEY, value));
const key_in = (top, path) => `${top}
${path}`;
const cache_key = (path) => key_in(directory.value, path);

/** Pick the row icon and tint for one listing entry. */
function entry_icon(entry) {
  if (entry.kind === "directory") return ["i-lucide-folder", "is-folder"];
  if (entry.kind === "unavailable") return ["i-lucide-file-lock-2", "is-muted"];
  return file_type(entry.name).slice(1);
}

const breadcrumbs = computed(() => {
  const parts = current_path.value.split("/").filter(Boolean);
  return [{ name: root_name.value, path: "" }, ...parts.map((name, index) => ({ name, path: parts.slice(0, index + 1).join("/") }))];
});
const path_nav = ref(null);
watch([breadcrumbs, mode], async () => {
  await nextTick();
  if (path_nav.value) path_nav.value.scrollLeft = path_nav.value.scrollWidth;
});

/** Remember where the list is, for coming back to this room's files. */
function remember() {
  shown_folders.set(room_id, { mode: mode.value, directory: directory.value, account: account_root.value, path: current_path.value });
}

/** Show a folder of the current project from its saved listings, then bring the project's listings up to date. */
async function open_project(path) {
  const request = ++listing_request;
  mode.value = "folder";
  loading.value = true;
  try { await folder_listings.load(directory.value); }
  catch { /* Read from the computer even when the local cache is unavailable. */ }
  if (request !== listing_request) return;
  read_directory(path);
  sweep_folders();
}

/** Show another of the room's project directories from its top. */
function switch_root(index) {
  if (index === root.value && !account_root.value && mode.value === "folder") return;
  account_root.value = null;
  root.value = index;
  open_project("");
}

/** Open one of the account's projects or drafts from the "项目" list. */
function open_account_root(item) {
  account_root.value = { id: item.id, name: item.name };
  root.value = item.id;
  open_project("");
}

/** Read the account's projects and drafts or recycle area, replacing only the active request. */
async function read_section(section) {
  if (left_page) return;
  const request = ++listing_request;
  sweep_run++;
  mode.value = section;
  naming.value = null;
  if (section === "roots") remember();
  section_failure.value = "";
  loading.value = true;
  try {
    const answer = await bridge.manage_room_files(room_id, { op: section });
    if (request !== listing_request) return;
    if (section === "roots") roots.value = answer;
    else trash.value = answer.entries;
  } catch (error) {
    if (request !== listing_request) return;
    section_failure.value = section === "roots" ? t('读取项目列表失败：{value1}', { value1: error.message }) : t('读取回收区失败：{value1}', { value1: error.message });
    bridge.notify("error", section_failure.value);
  } finally { if (request === listing_request) loading.value = false; }
}
const show_roots = () => read_section("roots");
const show_trash = () => read_section("trash");

// The account's cloud space, the last of the directory tabs: one drive for the whole account, the same from every room.
// It is drawn with this page's own frame (tools, tabs, path bar, columns, row menus); cloud-drive.js gives its data and
// which actions each item allows, and the controls it does not allow are left out.
const cloud_visible = computed(() => cloud_space_visible(view.value));
const cloud = use_cloud_drive(bridge);
/** Show a place of the cloud space: "root", a folder's ID, or one of "rooms", "transfers", "trash". */
function show_cloud(place = cloud.place.value) {
  if (left_page) return;
  listing_request++;
  sweep_run++;
  naming.value = null;
  section_failure.value = "";
  loading.value = false;
  mode.value = "cloud";
  cloud.open(place);
}
// The cloud space taken away (its settings cleared) leaves the tab for the projects.
watch(cloud_visible, (visible) => { if (!visible && mode.value === "cloud") show_roots(); });
const cloud_files_input = ref(null), cloud_folder_input = ref(null);
const cloud_upload_items = computed(() => [[
  { label: t("上传文件"), icon: "i-lucide-file-up", onSelect: () => cloud_files_input.value?.click() },
  { label: t("上传文件夹"), icon: "i-lucide-folder-up", onSelect: () => cloud_folder_input.value?.click() },
]]);
function cloud_pick_files(list) {
  cloud.upload([...list].map((file) => ({ file, dir: "" })));
  if (cloud_files_input.value) cloud_files_input.value.value = "";
}
function cloud_pick_folder(list) {
  // A picked folder's files carry their path from the picked folder down, the file's own name last.
  cloud.upload([...list].map((file) => ({ file, dir: (file.webkitRelativePath || "").split("/").slice(0, -1).join("/") })));
  if (cloud_folder_input.value) cloud_folder_input.value.value = "";
}
/** Files and folders dropped on the cloud space go into the folder shown, with their structure. */
async function cloud_drop(event) {
  if (mode.value !== "cloud" || !event.dataTransfer?.types.includes("Files")) return;
  event.preventDefault();
  if (event.type !== "drop" || cloud.special.value) return;
  const entries = [...event.dataTransfer.items].map((item) => item.webkitGetAsEntry?.()).filter(Boolean);
  try { cloud.upload(entries.length ? await walk_dropped(entries) : [...event.dataTransfer.files].map((file) => ({ file, dir: "" }))); }
  catch (error) { bridge.notify("error", error.message); }
}
/** The "…" menu of a cloud space file, with only the actions it allows where it is. */
function cloud_file_menu(file) {
  const can = cloud.can(file);
  if (cloud.in_trash.value) return [[{ label: t("还原"), icon: "i-lucide-undo-2", onSelect: () => cloud.restore([file.id], []) },
    { label: t("彻底删除"), icon: "i-lucide-trash-2", color: "error", onSelect: () => cloud.remove([file], [], true) }]];
  return [[
    ...(can.download ? [{ label: t("下载"), icon: "i-lucide-download", onSelect: () => cloud.download([file]) }] : []),
    ...(can.rename ? [{ label: t("重命名"), icon: "i-lucide-pencil", onSelect: () => start_naming("cloud-rename", file) }] : []),
    ...(can.move ? [{ label: t("移动"), icon: "i-lucide-folder-input", onSelect: () => open_cloud_move([file], []) }] : []),
    ...(can.delete ? [{ label: t("删除"), icon: "i-lucide-trash-2", color: "error", onSelect: () => cloud.remove([file], []) }] : []),
    ...(can.share ? [{ label: t("分享"), icon: "i-lucide-link", onSelect: () => { cloud_sharing.value = file; } }] : []),
    ...(can.land ? [{ label: t("取回到项目"), icon: "i-lucide-folder-down", onSelect: () => land_from_cloud(file) }] : []),
  ]];
}
/** The "…" menu of a cloud space folder; a read-only place has none. */
function cloud_folder_menu(folder) {
  if (cloud.in_trash.value) return [[{ label: t("还原"), icon: "i-lucide-undo-2", onSelect: () => cloud.restore([], [folder.id]) },
    { label: t("彻底删除"), icon: "i-lucide-trash-2", color: "error", onSelect: () => cloud.remove([], [folder], true) }]];
  const can = cloud.can(folder, true);
  return [[
    ...(can.rename ? [{ label: t("重命名"), icon: "i-lucide-pencil", onSelect: () => start_naming("cloud-rename-folder", folder) }] : []),
    ...(can.move ? [{ label: t("移动"), icon: "i-lucide-folder-input", onSelect: () => open_cloud_move([], [folder]) }] : []),
    ...(can.delete ? [{ label: t("删除"), icon: "i-lucide-trash-2", color: "error", onSelect: () => cloud.remove([], [folder]) }] : []),
  ]];
}
/** Open a cloud file: what a viewer shows is previewed, anything else is downloaded. */
function open_cloud_file(file) {
  if (cloud.in_trash.value) return;
  if (cloud.can(file).preview) cloud.preview(file);
  else cloud.download([file]);
}
const cloud_sharing = ref(null);
// The folder picker of a move: the items moving and the folder being looked into.
const cloud_moving = ref(null);
async function open_cloud_move(files, folders) {
  cloud_moving.value = { files, folders, at: null, path: [], children: [], loading: true };
  await browse_cloud_move(null);
}
async function browse_cloud_move(id) {
  const job = cloud_moving.value;
  job.loading = true;
  try {
    const { path, folders } = await cloud.child_folders(id);
    if (cloud_moving.value !== job) return;
    // A folder cannot go into itself or below it.
    const leaving = new Set(job.folders.map((item) => item.id));
    Object.assign(job, { at: id, path, children: folders.filter((item) => !leaving.has(item.id)) });
  } catch (error) { bridge.notify("error", error.message); }
  finally { job.loading = false; }
}
// The search box reads the whole cloud space again a moment after typing stops.
const CLOUD_SEARCH_DELAY_MS = 300;
let cloud_search_timer = 0;
function cloud_search() {
  clearTimeout(cloud_search_timer);
  cloud_search_timer = setTimeout(() => cloud.reload(), CLOUD_SEARCH_DELAY_MS);
}
function finish_cloud_move() {
  const job = cloud_moving.value;
  cloud_moving.value = null;
  cloud.move(job.files.map((item) => item.id), job.folders.map((item) => item.id), job.at);
}

/** Show a folder the preview's breadcrumb asked for, now or once this list is shown. */
function take_reveal() {
  const path = file_preview.reveal_path;
  if (path == null) return false;
  file_preview.reveal_path = null;
  const target = file_preview.reveal_root;
  // An account folder comes back by its id, with the name its preview tab showed.
  if (typeof target === "string") { account_root.value = { id: target, name: file_preview.reveal_name || target }; root.value = target; }
  else if (props.directories[target]) { account_root.value = null; root.value = target; }
  open_project(path);
  return true;
}

/** Check the project again shortly: several changes in a row need one pass. */
function schedule_sweep() {
  clearTimeout(sweep_timer);
  sweep_timer = setTimeout(sweep_folders, SWEEP_SETTLE_MS);
}
const sweep_when_visible = () => { if (document.visibilityState === "visible") schedule_sweep(); };

watch(() => file_preview.reveal_path, take_reveal);
// A new message usually means a member finished some work, which may have changed files.
watch(() => view.value.room?.latest_id, schedule_sweep);
onMounted(() => {
  document.addEventListener("visibilitychange", sweep_when_visible);
  if (take_reveal()) return;
  if (mode.value === "roots") show_roots();
  else open_project(current_path.value);
});
onBeforeUnmount(() => {
  left_page = true;
  listing_request++;
  sweep_run++;
  answer_conflict(null);
  clearTimeout(sweep_timer);
  document.removeEventListener("visibilitychange", sweep_when_visible);
});

/** Save one folder's answer from the computer; the folder on screen shows it unless the user is reading it again. */
function keep_answer(top, item) {
  const key = key_in(top, item.path);
  if (item.missing) folder_listings.delete(key);
  else if (!item.unchanged) {
    folder_listings.set(key, item);
    if (top === directory.value && item.path === current_path.value && !loading.value) listing.value = item;
  }
  return (folder_listings.get(key)?.entries || []).filter((entry) => entry.kind === "directory" && !SWEEP_SKIPPED.has(entry.name)).map((entry) => entry.path);
}

/** Walk the project from its top, asking the computer about many folders at a time; a newer pass or leaving the page stops it. */
async function sweep_folders() {
  if (left_page || mode.value !== "folder") return;
  const run = ++sweep_run, index = root.value, top = directory.value;
  const queue = [""], seen = new Set(queue);
  while (queue.length && run === sweep_run) {
    const folders = queue.slice(0, SWEEP_BATCH).map((path) => ({ path, modified_at: folder_listings.get(key_in(top, path))?.modified_at || "" }));
    let answer;
    try { answer = await bridge.read_room_files(room_id, "", 0, "", index, folders); } catch { return; }
    // A computer not yet updated answers without `folders`: the list then reads each folder as it is opened.
    if (run !== sweep_run || !answer.folders?.length) return;
    queue.splice(0, answer.folders.length);
    for (const item of answer.folders) {
      for (const path of keep_answer(top, item)) {
        if (!seen.has(path) && seen.size < SWEEP_FOLDER_LIMIT) { seen.add(path); queue.push(path); }
      }
    }
  }
}

/** Show one folder at once (from the cache when it is there) and read it again; a failed refresh keeps what is shown. */
async function read_directory(path = "", append = false) {
  const request = ++listing_request;
  if (!append) {
    mode.value = "folder";
    naming.value = null;
    current_path.value = path;
    remember();
    listing.value = folder_listings.get(cache_key(path)) || null;
  }
  loading.value = true;
  try {
    const result = await bridge.read_room_files(room_id, path, append ? listing.value.next_offset : 0, "", root.value);
    if (request !== listing_request) return;
    listing.value = { ...result, entries: append ? [...listing.value.entries, ...result.entries] : result.entries };
    folder_listings.set(cache_key(path), listing.value);
  } catch (error) {
    if (request === listing_request) bridge.notify("error", t('读取目录失败，{value1}', { value1: error.message }));
  } finally { if (request === listing_request) loading.value = false; }
}

/** Run one change and show the folder again; the computer's message is shown when it is refused. */
async function change(payload, done_message = "") {
  busy.value = true;
  try {
    const answer = await bridge.manage_room_files(room_id, { root: root.value, ...payload });
    if (done_message) bridge.notify("info", done_message);
    return answer;
  } catch (error) {
    bridge.notify("error", error.message);
    return null;
  } finally {
    busy.value = false;
    if (mode.value === "folder") read_directory(current_path.value);
  }
}

/** Start typing a name for a new folder, a new project or a renamed entry. */
async function start_naming(kind, entry = null) {
  naming.value = { kind, entry, value: entry?.file_name ?? entry?.name ?? "" };
  await nextTick();
  name_input.value?.focus();
  name_input.value?.select();
}

/** Apply the typed name. */
async function finish_naming() {
  const { kind, entry, value } = naming.value || {};
  const name = (value || "").trim();
  if (!name) { naming.value = null; return; }
  naming.value = null;
  if (kind === "cloud-mkdir") await cloud.mkdir(name);
  else if (kind === "cloud-rename" && name !== entry.file_name) await cloud.rename(entry, name);
  else if (kind === "cloud-rename-folder" && name !== entry.name) await cloud.rename(entry, name, true);
  else if (kind === "mkdir") await change({ op: "mkdir", path: current_path.value, name });
  else if (kind === "rename" && name !== entry.name) await change({ op: "rename", path: entry.path, name });
  else if (kind === "project") {
    busy.value = true;
    try {
      await bridge.manage_room_files(room_id, { op: "new-project", name });
      await show_roots();
    } catch (error) { bridge.notify("error", error.message); }
    finally { busy.value = false; }
  }
}

/** Move one entry into the recycle area. */
function remove(entry) {
  change({ op: "delete", path: entry.path }, t('已移到回收区：{value1}', { value1: entry.name }));
}

/** Copy or cut one entry, or several chosen ones, for pasting in another folder (of this or another project). */
function take(entry, kind) { take_many([entry], kind); }
function take_many(entries, kind) {
  const name = entries.length === 1 ? entries[0].name : t('{count} 项', { count: entries.length });
  clipboard.value = { mode: kind, root: root.value, root_name: root_name.value, name, items: entries.map((entry) => ({ path: entry.path, name: entry.name })) };
  bridge.notify("info", kind === "copy" ? t('已复制 {value1}，打开目标文件夹后点“粘贴”', { value1: name }) : t('已剪切 {value1}，打开目标文件夹后点“粘贴”', { value1: name }));
}

/** Ask what to do with a name already taken; resolves "replace", "keep_both" or null. */
function ask_conflict(name, many = false) {
  return new Promise((resolve) => { asking.value = { name, many, resolve }; });
}
function answer_conflict(choice) {
  const item = asking.value;
  asking.value = null;
  item?.resolve(choice);
}

/** Paste what was copied or cut into the folder shown. */
async function paste() {
  const item = clipboard.value;
  if (!item) return;
  // Pasted one after another (the computer takes one entry per request); a name already taken is asked about, and the
  // answer can stand for the rest.
  let for_all = null, done = 0;
  ask_all.value = false;
  for (const source of item.items) {
    const payload = { op: "paste", mode: item.mode, source: { root: item.root, path: source.path }, path: current_path.value };
    let answer = await change(payload);
    if (answer?.conflict) {
      const choice = for_all || await ask_conflict(answer.name, item.items.length > 1);
      if (ask_all.value && choice) for_all = choice;
      if (!choice) continue;
      answer = await change({ ...payload, conflict: choice });
    }
    if (answer && !answer.conflict) done += 1;
  }
  if (done === item.items.length && item.mode === "move") clipboard.value = null;
}

/** Upload the chosen files one by one; names already in the folder are asked about first. */
async function upload_files(files) {
  const list = [...files];
  if (file_input.value) file_input.value.value = "";
  if (!list.length) return;
  const taken = new Set((listing.value?.entries || []).map((entry) => entry.name));
  const target = { root: root.value, path: current_path.value };
  let for_all = null;
  ask_all.value = false;
  const plans = [];
  for (const file of list) {
    // Over the part upload's limit, a file goes through the cloud space when the account has one, up to its 2 GiB.
    const over = file.size > view.value.attachment_limit_mib * 1024 * 1024;
    if (over && (!view.value.object_storage || file.size > CLOUD_MAX_BYTES)) {
      bridge.notify("warning", view.value.object_storage ? t('{value1} 超过 2 GiB，未上传', { value1: file.name })
        : t('{value1} 超过 {limit} MiB，未上传；更大的文件请给 AI 下载链接或仓库地址', { limit: view.value.attachment_limit_mib, value1: file.name }));
      continue;
    }
    let conflict = null;
    if (taken.has(file.name)) {
      conflict = for_all || await ask_conflict(file.name, list.length > 1);
      if (left_page) {
        bridge.notify("warning", t('已取消上传：离开文件页前未处理同名文件。'));
        return;
      }
      if (ask_all.value && conflict) for_all = conflict;
      if (!conflict) continue;
    }
    plans.push({ file, conflict, cloud: over });
  }
  // Each file is a row of the transfer list, three at a time. A large one goes to the cloud space from this page (which
  // can be cancelled) and is then landed in the folder by the computer (followed, also after a reload).
  const results = await Promise.all(plans.map(({ file, conflict, cloud }) => transfer(file.name, "project", async ({ signal, progress, task }) => {
    if (!cloud) return bridge.upload_project_file(room_id, { ...target, file, conflict, on_progress: progress });
    const landing = await bridge.upload_project_via_cloud(room_id, target, file, { conflict, signal, on_progress: (share) => progress(share * CLOUD_SEND_SHARE) });
    task(landing.task_id);
    return follow_cloud_task(landing.task_id, (share) => progress(CLOUD_SEND_SHARE + share * (1 - CLOUD_SEND_SHARE)));
  }, { parallel: true, retries: 0, browser: true, cancellable: cloud })));
  const uploaded = results.filter((item) => item.ok).length;
  if (uploaded) {
    bridge.notify("info", t('已上传 {value1} 个文件', { value1: uploaded }));
    if (!left_page && mode.value === "folder" && root.value === target.root && current_path.value === target.path) read_directory(current_path.value);
  }
}

/**
 * Whether a download goes through the cloud space: on a page away from the computer, for a folder or a file larger than
 * the threshold, the bytes then skip the relay. On the computer itself, or for a small file, the plain download stays.
 */
function downloads_via_cloud(entry) {
  if (!view.value.object_storage || bridge.opened_on_this_computer()) return false;
  return entry.kind === "directory" || Number(entry.size) > (view.value.object_threshold_mib || view.value.attachment_limit_mib) * 1024 * 1024;
}

/**
 * Download through the cloud space, its preparation shown in the upload list until the browser starts saving. Returns
 * whether it did: when the cloud space cannot (full, unreachable, not set up) it says why and leaves the download to the
 * plain way, which has its own limits and errors.
 */
async function download_via_cloud(entry) {
  const outcome = await transfer(entry.name, "prepare", ({ progress, task }) => bridge.download_project_via_cloud(room_id,
    { path: entry.path, root: root.value, kind: entry.kind === "directory" ? "folder" : "file" },
    (task_id) => { task(task_id); return follow_cloud_task(task_id, progress); }));
  if (outcome.ok) return true;
  // The plain download takes over, so the failed row would only repeat the notice.
  clear_transfer(outcome.id);
  bridge.notify("warning", t("云空间暂时用不了（{reason}），改用普通下载", { reason: outcome.error.message }));
  return false;
}

/** Save one folder, with everything under it, to this device as a ZIP. */
async function download_folder(entry) {
  if (downloads_via_cloud(entry) && await download_via_cloud(entry)) return;
  bridge.notify("info", t('正在打包“{name}”，完成后浏览器会开始下载。', { name: entry.name }));
  try { await bridge.download_project_folder(room_id, entry.path, root.value); }
  catch (error) { bridge.notify("error", t('下载失败：{value1}', { value1: error.message })); }
}

// How often a cloud copy's progress is asked for, and how long the page keeps asking before giving up.
const CLOUD_POLL_MS = 1000, CLOUD_POLL_LIMIT_MS = 2 * 60 * 60 * 1000;
// The largest file the cloud space takes, and the share of a big upload's bar its transfer to the storage fills (landing
// it in the folder fills the rest).
const CLOUD_MAX_BYTES = 2 * 1024 * 1024 * 1024, CLOUD_SEND_SHARE = 0.9;

/**
 * Follow a task the computer runs for the cloud space (a copy, or a file landing in a project) until it is done, telling
 * `on_progress(share)` how far it has come. Resolves with the finished task; rejects with its failure.
 */
async function follow_cloud_task(task_id, on_progress = () => {}) {
  const started = Date.now();
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, CLOUD_POLL_MS));
    // Followed on after this view closes too: the transfer list belongs to the whole page.
    const state = await bridge.project_cloud_status(task_id);
    if (state.status === "failed") throw new Error(state.error_text?.template ? t(state.error_text.template, state.error_text.params) : state.error || t('存到云空间失败'));
    if (state.status === "completed") return state;
    on_progress(Math.min(0.99, Number(state.progress) || 0));
    if (Date.now() - started > CLOUD_POLL_LIMIT_MS) throw new Error(t('存到云空间超时，请稍后在云空间里查看是否已完成'));
  }
}

/**
 * Copy one file, or one folder packed as a ZIP, into the account's cloud space; the local file stays. The computer does
 * the work and answers a task, whose progress shows in the upload list until it is done.
 */
async function save_to_cloud(entry) {
  const outcome = await transfer(entry.name, "copy", async ({ progress, task }) => {
    const { task_id } = await bridge.save_project_to_cloud(room_id, { path: entry.path, root: root.value, kind: entry.kind === "directory" ? "folder" : "file" });
    task(task_id);
    return follow_cloud_task(task_id, progress);
  });
  if (outcome.ok) bridge.notify("info", t('“{name}”已存到云空间', { name: entry.name }));
}

// A cloud space attachment waiting to be landed in a project: it goes into the folder open when "放到这里" is pressed.
const pending_land = computed(() => view.value.pending_land);

/** Land the waiting attachment in the folder shown; the copy in the cloud space stays. */
async function land_here() {
  const waiting = pending_land.value;
  if (!waiting) return;
  const target = { root: root.value, path: current_path.value };
  bridge.clear_pending_land();
  const outcome = await transfer(waiting.file_name, "land", async ({ progress, task }) => {
    const { task_id } = await bridge.land_in_project(room_id, { source: waiting, ...target });
    task(task_id);
    return follow_cloud_task(task_id, progress);
  });
  if (!outcome.ok) return;
  bridge.notify("info", t('“{name}”已取回到项目', { name: outcome.result?.path || waiting.file_name }));
  if (!left_page && mode.value === "folder" && root.value === target.root && current_path.value === target.path) read_directory(current_path.value);
}

/** From the cloud space list: pick this attachment, then open the projects to choose its folder. */
function land_from_cloud(file) {
  bridge.choose_landing_folder(file);
  navigate(() => open_project(current_path.value));
}

/** Save one file to this device. */
async function download(entry) {
  if (downloads_via_cloud(entry) && await download_via_cloud(entry)) return;
  try { await bridge.download_project_file(room_id, entry.path, root.value); }
  catch (error) { bridge.notify("error", t('下载失败：{value1}', { value1: error.message })); }
}

/** Put one recycled item back where it was. */
async function restore(item) {
  busy.value = true;
  try {
    const answer = await bridge.manage_room_files(room_id, { op: "restore", id: item.id });
    bridge.notify("info", t('已还原到 {value1}/{value2}', { value1: answer.root_name, value2: answer.path }));
    trash.value = trash.value.filter((entry) => entry.id !== item.id);
  } catch (error) { bridge.notify("error", error.message); }
  finally { busy.value = false; }
}

/** Move a whole draft (or an account project) into the recycle area. */
async function remove_root(item) {
  busy.value = true;
  try {
    await bridge.manage_room_files(room_id, { op: "delete-root", root: item.id });
    bridge.notify("info", t('已移到回收区：{value1}', { value1: item.name }));
    await show_roots();
  } catch (error) { bridge.notify("error", error.message); }
  finally { busy.value = false; }
}

/** The menu of one row. */
function entry_menu(entry) {
  const items = [];
  if (entry.kind === "file") items.push({ label: t('下载'), icon: "i-lucide-download", onSelect: () => download(entry) });
  if (entry.kind === "directory") items.push({ label: t('下载文件夹'), icon: "i-lucide-download", onSelect: () => download_folder(entry) });
  if (view.value.object_storage && ["file", "directory"].includes(entry.kind)) {
    items.push({ label: t('存到云空间'), icon: "i-lucide-cloud-upload", onSelect: () => save_to_cloud(entry) });
  }
  items.push({ label: t('重命名'), icon: "i-lucide-pencil", onSelect: () => start_naming("rename", entry) });
  items.push({ label: t('复制'), icon: "i-lucide-copy", onSelect: () => take(entry, "copy") });
  items.push({ label: t('剪切'), icon: "i-lucide-scissors", onSelect: () => take(entry, "move") });
  items.push({ label: t('删除'), icon: "i-lucide-trash-2", color: "error", onSelect: () => remove(entry) });
  return [items];
}

/** Why a project or draft cannot be deleted here, or "" when it can. */
function root_lock(item) {
  if (!item.deletable) return t('常用项目只能在设置里移出列表，不能在这里删除');
  if (item.rooms.length) return t('正在使用它的房间：{value1}', { value1: item.rooms.map((id) => bridge.room_title(id)).join("、") });
  return "";
}

const deleted_time = (value) => modified_time(value);

// Where the list was before each move (opening a folder, the path bar, the project list, the recycle area, another
// directory) and, after going back, where it came from, so it steps back and forward as a file manager does, also with
// a mouse's side buttons (user 2026-11-27, #13904, #13906).
const VISITED_LIMIT = 50;
const visited = ref([]);
const ahead = ref([]);
// The side buttons of a mouse: `MouseEvent.button` 3 is back, 4 is forward.
const MOUSE_BACK = 3, MOUSE_FORWARD = 4;

/** Where the list is now. */
function here() {
  return { mode: mode.value, account: account_root.value, root: root.value, path: current_path.value, cloud: cloud.place.value };
}

/** Move the list somewhere the user chose, remembering where it was; a new move drops the way forward. */
function navigate(move) {
  const before = here();
  move();
  visited.value = [...visited.value, before].slice(-VISITED_LIMIT);
  ahead.value = [];
}

/** Show one remembered place. */
function show_place(place) {
  if (place.mode === "roots") return show_roots();
  if (place.mode === "trash") return show_trash();
  if (place.mode === "cloud") return cloud_visible.value ? show_cloud(place.cloud) : show_roots();
  account_root.value = place.account;
  root.value = place.account ? place.account.id : place.root;
  open_project(place.path);
}

/** Show the place the list was before its last move. */
function go_back() {
  const place = visited.value.at(-1);
  if (!place) return;
  visited.value = visited.value.slice(0, -1);
  ahead.value = [...ahead.value, here()];
  show_place(place);
}

/** Show again the place the list went back from. */
function go_forward() {
  const place = ahead.value.at(-1);
  if (!place) return;
  ahead.value = ahead.value.slice(0, -1);
  visited.value = [...visited.value, here()].slice(-VISITED_LIMIT);
  show_place(place);
}

// On a touch screen a sideways swipe anywhere on the page does what the side buttons do: the list follows the finger to
// the right to go back and to the left to go forward, and resists where there is nowhere to go. "Anywhere" is the whole
// 文件 tab (its scrolling page), not only the list: a short folder leaves most of the screen empty below it.
const SWIPE_SLIDE_MS = 180;
const SWIPE_RESIST = 0.25;
// The new place slides in from this share of the width on the other side.
const SWIPE_ENTER_SHARE = 0.3;
const explorer = ref(null);

/** Place the list `dx` pixels sideways, sliding there over `ms` (0: at once). */
function slide_list(dx, ms = 0, opacity = "") {
  if (!explorer.value) return;
  Object.assign(explorer.value.style, { transition: ms ? `transform ${ms}ms ease, opacity ${ms}ms ease` : "none",
    transform: dx ? `translateX(${dx}px)` : "", opacity, willChange: dx ? "transform" : "" });
}

const section = ref(null);
let swipe_area = null;
const list_swipe = side_swipe({
  start: (event) => !naming.value && !moves_sideways(event.target, swipe_area),
  move: (dx) => slide_list((dx > 0 ? visited.value.length : ahead.value.length) ? dx : dx * SWIPE_RESIST),
  end(dx, passed) {
    const back = dx > 0;
    if (!passed || !(back ? visited.value.length : ahead.value.length)) { slide_list(0, SWIPE_SLIDE_MS); return; }
    const width = explorer.value?.offsetWidth || window.innerWidth;
    slide_list(back ? width : -width, SWIPE_SLIDE_MS, "0");
    window.setTimeout(() => {
      if (back) go_back(); else go_forward();
      slide_list((back ? -width : width) * SWIPE_ENTER_SHARE, 0, "0");
      requestAnimationFrame(() => requestAnimationFrame(() => slide_list(0, SWIPE_SLIDE_MS)));
    }, SWIPE_SLIDE_MS);
  },
});

const SWIPE_EVENTS = [["touchstart", "touchstart", { passive: true }], ["touchmove", "touchmove", { passive: false }],
  ["touchend", "touchend", {}], ["touchcancel", "touchend", {}]];
onMounted(() => {
  swipe_area = section.value?.closest(".content-page") || section.value;
  for (const [type, handler, options] of SWIPE_EVENTS) swipe_area?.addEventListener(type, list_swipe[handler], options);
});
onBeforeUnmount(() => {
  for (const [type, handler, options] of SWIPE_EVENTS) swipe_area?.removeEventListener(type, list_swipe[handler], options);
});

/** A mouse's side buttons over the file page step back and forward here instead of leaving the page. */
function side_button(event) {
  if (event.button !== MOUSE_BACK && event.button !== MOUSE_FORWARD) return;
  event.preventDefault();
  if (event.type !== "mouseup") return;
  if (event.button === MOUSE_BACK) go_back();
  else go_forward();
}

/** The rarely used tools of the heading: refreshing what is shown, and going into or out of the recycle area. */
// In the cloud space the same place holds its recycle bin ("回收站"), and in the bin a way to empty it.
const more_items = computed(() => mode.value === "cloud" ? [
  { label: t('刷新'), icon: "i-lucide-refresh-cw", disabled: cloud.loading.value, onSelect: () => cloud.reload() },
  cloud.in_trash.value ? { label: t('返回云空间'), icon: "i-lucide-cloud", onSelect: () => navigate(() => show_cloud("root")) }
    : { label: t('回收站'), icon: "i-lucide-trash", onSelect: () => navigate(() => show_cloud("trash")) },
  ...(cloud.in_trash.value ? [{ label: t('清空回收站'), icon: "i-lucide-trash-2", color: "error", onSelect: () => cloud.empty_trash() }] : []),
] : [
  { label: t('刷新'), icon: "i-lucide-refresh-cw", disabled: loading.value || busy.value,
    onSelect: () => mode.value === "roots" ? show_roots() : mode.value === "trash" ? show_trash() : (read_directory(current_path.value), sweep_folders()) },
  mode.value === "trash" ? { label: t('返回文件夹'), icon: "i-lucide-folder-open", onSelect: () => navigate(() => open_project(current_path.value)) }
    : { label: t('回收区'), icon: "i-lucide-trash", onSelect: () => navigate(show_trash) },
]);
// The directory tabs: the room's project directories, then the cloud space; shown with one directory too when the
// cloud space is there, so it has somewhere to sit.
// It stays in every section of the page (projects list, recycle area, an account folder), with no tab chosen there, so
// what is below it never moves.
const show_tabs = computed(() => props.directories.length > 1 || cloud_visible.value);
/**
 * Why each of the heading's icons does not apply here, or "" when it does: the icons stay in place and are greyed out
 * with this as their tooltip.
 */
const tool_blocks = computed(() => {
  if (mode.value === "cloud") {
    const place = cloud.in_trash.value ? "trash" : cloud.special.value ? "readonly" : "";
    return {
      upload: place === "trash" ? t("回收站里不能上传") : place ? t("只读文件夹不能上传") : "",
      create: place === "trash" ? t("回收站里不能新建文件夹") : place ? t("只读文件夹里不能新建文件夹") : "",
      layout: "",
    };
  }
  if (mode.value === "roots") return { upload: t("先打开一个项目或草稿再上传"), create: roots.value?.can_create_project ? "" : t("这里不能新建项目"), layout: t("这里只有列表视图") };
  if (mode.value === "trash") return { upload: t("回收区里不能上传"), create: t("回收区里不能新建文件夹"), layout: t("这里只有列表视图") };
  return { upload: "", create: "", layout: "" };
});

// ---- choosing several entries (a project folder or the cloud space) ----
// Keys: `p:<path>` for a project entry, `f:<id>` / `d:<id>` for a cloud file or folder. Leaving the folder clears them.
const BATCH_DOWNLOAD_GAP_MS = 400;
const selected = ref(new Set());
watch([mode, current_path, root, () => cloud.place.value], () => { selected.value = new Set(); });
const project_key = (entry) => `p:${entry.path}`;
const cloud_key = (item, folder = false) => `${folder ? "d" : "f"}:${item.id}`;
/** The entries of the folder shown that can be chosen: read-only places and unreadable entries cannot. */
const choosable = computed(() => mode.value === "folder" ? (listing.value?.entries || []).filter((entry) => entry.kind !== "unavailable").map(project_key)
  : mode.value === "cloud" ? [...cloud.folders.value.filter((item) => !item.readonly).map((item) => cloud_key(item, true)), ...cloud.files.value.map((item) => cloud_key(item))] : []);
const all_chosen = computed(() => choosable.value.length > 0 && choosable.value.every((key) => selected.value.has(key)));
function toggle_chosen(key) {
  const next = new Set(selected.value);
  next.has(key) ? next.delete(key) : next.add(key);
  selected.value = next;
}
/** Choose every entry of the folder shown, or none. */
function toggle_all_chosen() { selected.value = all_chosen.value ? new Set() : new Set(choosable.value); }
/** What is chosen, as `{ files, folders }` of the folder shown. */
const chosen = computed(() => {
  if (mode.value === "folder") {
    const entries = (listing.value?.entries || []).filter((entry) => selected.value.has(project_key(entry)));
    return { files: entries.filter((entry) => entry.kind === "file"), folders: entries.filter((entry) => entry.kind === "directory") };
  }
  if (mode.value === "cloud") return { files: cloud.files.value.filter((item) => selected.value.has(cloud_key(item))), folders: cloud.folders.value.filter((item) => selected.value.has(cloud_key(item, true))) };
  return { files: [], folders: [] };
});
const blocks = computed(() => selection_blocks({ ...chosen.value, cloud: mode.value === "cloud", in_trash: cloud.in_trash.value }));

/**
 * Run one action over several entries as a row of the transfer list (the computer takes one entry per request), the
 * failures said together at the end; the ones done stay done.
 */
async function run_batch(name, kind, items, work) {
  let failed = [];
  await transfer(name, kind, async ({ progress }) => { failed = await run_each(items, work, progress); });
  if (failed.length) bridge.notify("warning", t("{done} 项完成，{failed} 项失败：{names}", { done: items.length - failed.length, failed: failed.length,
    names: failed.slice(0, 3).map(({ item, error }) => `${item.name ?? item.file_name}（${error.message}）`).join(", ") }));
  return failed;
}

/** Download the chosen files one by one, at most 20; away from the computer a large one goes through the cloud space. */
async function download_chosen() {
  const files = chosen.value.files, from = root.value;
  selected.value = new Set();
  return run_batch(t("下载 {count} 个文件", { count: files.length }), "download", files, async (item) => {
    if (mode.value === "cloud") await cloud.save_one(item);
    else if (!(downloads_via_cloud(item) && await download_via_cloud(item))) await bridge.download_project_file(room_id, item.path, from);
    await new Promise((resolve) => setTimeout(resolve, BATCH_DOWNLOAD_GAP_MS));
  });
}

/** Move the chosen entries: in a project by cutting them for "粘贴" in the folder to go to, in the cloud space by its dialog. */
function move_chosen() {
  const { files, folders } = chosen.value;
  selected.value = new Set();
  if (mode.value === "cloud") return open_cloud_move(files, folders);
  take_many([...folders, ...files], "move");
}

/** Delete the chosen entries: a project's go to its recycle area; the cloud space follows its own rules. */
async function delete_chosen(permanent = false) {
  const { files, folders } = chosen.value;
  selected.value = new Set();
  if (mode.value === "cloud") return cloud.remove(files, folders, permanent || cloud.in_trash.value);
  const entries = [...folders, ...files], from = root.value, folder = current_path.value;
  const failed = await run_batch(t("删除 {count} 项", { count: entries.length }), "delete", entries,
    async (entry) => { await bridge.manage_room_files(room_id, { root: from, op: "delete", path: entry.path }); });
  if (!failed.length) bridge.notify("info", t("已移到回收区：{value1}", { value1: t('{count} 项', { count: entries.length }) }));
  if (root.value === from && current_path.value === folder) read_directory(folder);
}

function restore_chosen() {
  const { files, folders } = chosen.value;
  selected.value = new Set();
  cloud.restore(files.map((item) => item.id), folders.map((item) => item.id));
}

// An entry's menu (long press, right click) closes on a press anywhere outside it, which does nothing else, and only one
// is open at a time. The menu's own open state is not reported by UContextMenu, and on a phone a press outside it was
// not seen (user 2026-11-27, #13795, #14141): this page closes its menus itself, by showing the entries again from
// scratch (`menu_epoch` is in their keys).
const menu_epoch = ref(0);
// On a touch screen lifting the finger after a long press also clicks the entry: that click opened the file over its
// own menu. A press held this long is a long press, and the click that ends it is dropped, as is the click of the press
// that closed a menu. Only that one click: the next press starts clean, so a quick tap right after still opens.
const LONG_PRESS_MS = 500;
let drop_click = false, press_started = 0;

/** A press on the page: it starts clean, and one outside an open entry menu closes the menu and does nothing else. */
function close_menus_outside(event) {
  drop_click = false;
  if (!document.querySelector(".project-file-menu[data-state='open']") || event.target.closest?.(".project-file-menu")) return;
  menu_epoch.value++;
  drop_click = true;
}

/** Drop the click marked by `drop_click` before anything on the page sees it. */
function drop_marked_click(event) {
  if (!drop_click) return;
  drop_click = false;
  event.stopPropagation();
  event.preventDefault();
}
onMounted(() => {
  document.addEventListener("pointerdown", close_menus_outside, true);
  document.addEventListener("click", drop_marked_click, true);
});
onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", close_menus_outside, true);
  document.removeEventListener("click", drop_marked_click, true);
});

/** Time each touch, so the click that ends a long press is dropped. */
function time_press(event) {
  if (event.type === "touchstart") { press_started = event.timeStamp; return; }
  if (press_started && event.timeStamp - press_started >= LONG_PRESS_MS) drop_click = true;
  press_started = 0;
}

/** Open a folder or preview a file. */
function open_entry(entry) {
  if (entry.kind === "directory") navigate(() => read_directory(entry.path));
  else file_preview.open?.(entry.path, account_root.value ? account_root.value.name : directory.value, root.value, entry);
}
</script>

<template>
  <section ref="section" class="project-files" @mousedown="side_button" @mouseup="side_button"
    @touchstart.passive="time_press" @touchend="time_press" @touchcancel="time_press">
    <header class="project-files-heading">
      <!-- A folder's name is in the path bar below; only the other sections say here what they are. -->
      <!-- The section's name is in the path bar below, so the heading is the same everywhere and nothing moves. -->
      <div><h2>{{ t('项目文件') }}</h2></div>
      <div class="project-files-tools">
        <!-- The same four icons in the same order on every tab and in every folder (user 2026-11-28, #15757): adding files,
             a new folder, how they are shown, then "更多操作" (refreshing, the recycle area). One that does not apply
             is greyed out in place, its wrapper saying why (a disabled button shows no tooltip of its own). -->
        <UButton v-if="clipboard && mode === 'folder'" icon="i-lucide-clipboard-paste" color="neutral" variant="soft" size="sm" :label="t('粘贴')" :title="t('粘贴 {value1}', { value1: clipboard.name })" :disabled="busy" @click="paste" />
        <span class="project-files-tool" :title="tool_blocks.upload || (mode === 'cloud' ? t('上传文件或文件夹（单个不超过 2 GiB）') : t('上传文件（单个不超过 {limit} MiB）', { limit: view.attachment_limit_mib }))">
          <UDropdownMenu v-if="mode === 'cloud' && !tool_blocks.upload" :items="cloud_upload_items" :content="{ align: 'end', sideOffset: 4 }" :ui="{ content: 'channel-menu' }">
            <UButton icon="i-lucide-upload" color="neutral" variant="ghost" size="sm" :aria-label="t('上传')" />
          </UDropdownMenu>
          <UButton v-else icon="i-lucide-upload" color="neutral" variant="ghost" size="sm" :aria-label="t('上传文件')" :disabled="Boolean(tool_blocks.upload) || busy" @click="file_input?.click()" />
        </span>
        <span class="project-files-tool" :title="tool_blocks.create || (mode === 'roots' ? t('新建项目') : t('新建文件夹'))">
          <UButton icon="i-lucide-folder-plus" color="neutral" variant="ghost" size="sm" :aria-label="mode === 'roots' ? t('新建项目') : t('新建文件夹')"
            :disabled="Boolean(tool_blocks.create) || busy" @click="start_naming(mode === 'cloud' ? 'cloud-mkdir' : mode === 'roots' ? 'project' : 'mkdir')" />
        </span>
        <span class="project-files-tool" :title="tool_blocks.layout || (layout === 'icons' ? t('列表视图') : t('图标视图'))">
          <UButton :icon="layout === 'icons' ? 'i-lucide-list' : 'i-lucide-layout-grid'" color="neutral" variant="ghost" size="sm"
            :aria-label="layout === 'icons' ? t('列表视图') : t('图标视图')" :disabled="Boolean(tool_blocks.layout)" @click="layout = layout === 'icons' ? 'list' : 'icons'" />
        </span>
        <input ref="file_input" type="file" multiple hidden @change="upload_files($event.target.files)" />
        <input ref="cloud_files_input" type="file" multiple hidden @change="cloud_pick_files($event.target.files)" />
        <input ref="cloud_folder_input" type="file" multiple webkitdirectory hidden @change="cloud_pick_folder($event.target.files)" />
        <UDropdownMenu :items="more_items" :content="{ align: 'end', sideOffset: 4 }" :ui="{ content: 'channel-menu' }">
          <UButton icon="i-lucide-ellipsis" color="neutral" variant="ghost" size="sm" :aria-label="t('更多操作')" :title="t('更多操作')" :loading="loading || busy" />
        </UDropdownMenu>
      </div>
    </header>

    <div v-if="show_tabs" class="project-roots" role="tablist" :aria-label="t('项目目录')">
      <button v-for="(path, index) in directories" :key="path" type="button" role="tab" :aria-selected="mode === 'folder' && !account_root && index === root" @click="navigate(() => switch_root(index))">
        <UIcon :name="index ? 'i-lucide-folder' : 'i-lucide-folder-root'" />{{ folder_name(path) }}
      </button>
      <button v-if="cloud_visible" type="button" role="tab" :aria-selected="mode === 'cloud'" :title="t('本账号的云空间，所有房间共用')" @click="mode !== 'cloud' && navigate(() => show_cloud())">
        <UIcon name="i-lucide-cloud" />{{ t('云空间') }}
      </button>
    </div>

    <UModal :open="Boolean(asking)" :title="t('文件已存在')" :close="false" :dismissible="false">
      <template #body>
        <div v-if="asking" class="project-files-ask">
          <p>{{ t('“{value1}”已存在。', { value1: asking.name }) }}</p>
          <div>
            <UButton :label="t('替换并保留旧版')" color="primary" size="xs" @click="answer_conflict('replace')" />
            <UButton :label="t('保留两份')" color="neutral" variant="outline" size="xs" @click="answer_conflict('keep_both')" />
            <UButton :label="t('跳过')" color="neutral" variant="ghost" size="xs" @click="answer_conflict(null)" />
            <label v-if="asking.many" class="project-files-ask-all"><input v-model="ask_all" type="checkbox" />{{ t('其余都按此处理') }}</label>
          </div>
        </div>
      </template>
    </UModal>

    <TransferList />

    <div ref="explorer" class="project-explorer" :aria-busy="loading || busy" @dragover="cloud_drop" @drop="cloud_drop">
      <!-- With entries chosen, their actions take the path bar's row at its height, so the list below does not move; the
           actions keep fixed places and the ones that do not apply are greyed out with the reason. -->
      <div v-if="selected.size" class="project-explorer-bar project-selection-bar" role="toolbar" :aria-label="t('所选项目的操作')">
        <span class="project-selection-count">{{ t('已选 {count} 项', { count: selected.size }) }}</span>
        <span class="project-files-tool" :title="blocks.first">
          <UButton v-if="mode === 'cloud' && cloud.in_trash.value" icon="i-lucide-undo-2" :label="t('还原')" color="neutral" variant="ghost" size="sm" @click="restore_chosen" />
          <UButton v-else icon="i-lucide-download" :label="t('下载')" color="neutral" variant="ghost" size="sm" :disabled="Boolean(blocks.first)" @click="download_chosen" />
        </span>
        <span class="project-files-tool" :title="blocks.move">
          <UButton icon="i-lucide-folder-input" :label="t('移动')" color="neutral" variant="ghost" size="sm" :disabled="Boolean(blocks.move)" @click="move_chosen" />
        </span>
        <span class="project-files-tool" :title="blocks.last">
          <UButton icon="i-lucide-trash-2" :label="mode === 'cloud' && cloud.in_trash.value ? t('彻底删除') : t('删除')" color="error" variant="ghost" size="sm" @click="delete_chosen()" />
        </span>
        <UButton icon="i-lucide-x" :label="t('退出选择')" color="neutral" variant="ghost" size="sm" @click="selected = new Set()" />
      </div>
      <!-- Back and forward stay in place beside the path, which scrolls to its end on a narrow screen (user #13910). -->
      <div v-else class="project-explorer-bar">
      <div class="project-explorer-steps">
        <UButton icon="i-lucide-arrow-left" color="neutral" variant="ghost" size="sm" :aria-label="t('返回上一个位置')" :title="t('返回上一个位置')"
          :disabled="!visited.length" @click="go_back" />
        <UButton icon="i-lucide-arrow-right" color="neutral" variant="ghost" size="sm" class="project-explorer-forward" :aria-label="t('前进')" :title="t('前进')"
          :disabled="!ahead.length" @click="go_forward" />
      </div>
      <nav v-if="mode === 'cloud'" class="project-explorer-path" :aria-label="t('文件路径')">
        <button type="button" :disabled="cloud.place.value === 'root' && !cloud.searching.value" :aria-current="cloud.place.value === 'root' ? 'location' : undefined" @click="navigate(() => show_cloud('root'))">{{ t('云空间') }}</button>
        <template v-for="(part, index) in cloud.path.value" :key="part.id">
          <UIcon name="i-lucide-chevron-right" class="project-crumb-separator" />
          <button type="button" :disabled="index === cloud.path.value.length - 1" :aria-current="index === cloud.path.value.length - 1 ? 'location' : undefined" @click="navigate(() => show_cloud(part.id))">{{ part.name }}</button>
        </template>
      </nav>
      <div v-if="mode === 'cloud'" class="project-cloud-side">
        <span class="project-cloud-usage" :title="cloud.usage.value">{{ cloud.usage.value }}</span>
        <input v-model="cloud.query.value" type="search" class="project-cloud-search" :placeholder="t('搜索云空间')" :aria-label="t('在整个云空间里按名称搜索')" @input="cloud_search">
      </div>
      <nav v-else ref="path_nav" class="project-explorer-path" :aria-label="t('文件路径')">
        <button type="button" :aria-current="mode === 'roots' ? 'location' : undefined" :disabled="mode === 'roots'" :title="t('所有项目与草稿')" @click="navigate(show_roots)">
          {{ t('项目') }}
        </button>
        <template v-if="mode === 'folder'">
          <template v-for="(part, index) in breadcrumbs" :key="part.path">
            <UIcon name="i-lucide-chevron-right" class="project-crumb-separator" />
            <button type="button" :disabled="index === breadcrumbs.length - 1" :aria-current="index === breadcrumbs.length - 1 ? 'location' : undefined" @click="navigate(() => read_directory(part.path))">
              {{ part.name }}
            </button>
          </template>
        </template>
        <template v-else-if="mode === 'trash'"><UIcon name="i-lucide-chevron-right" class="project-crumb-separator" /><button type="button" disabled aria-current="location" :title="t('回收区（保留 30 天）')">{{ t('回收区') }}</button></template>
      </nav>
      </div>

      <form v-if="naming" class="project-files-naming" @submit.prevent="finish_naming">
        <UIcon :name="naming.kind === 'rename' ? 'i-lucide-pencil' : 'i-lucide-folder-plus'" />
        <input ref="name_input" v-model="naming.value" :aria-label="naming.kind === 'rename' ? t('新名称') : naming.kind === 'project' ? t('项目名称') : t('文件夹名称')"
          :placeholder="naming.kind === 'rename' ? t('新名称') : naming.kind === 'project' ? t('项目名称') : t('文件夹名称')" maxlength="200" @keydown.esc.prevent="naming = null" />
        <UButton type="submit" :label="t('确定')" size="xs" :disabled="busy" />
        <UButton :label="t('取消')" color="neutral" variant="ghost" size="xs" @click="naming = null" />
      </form>

      <div v-if="mode !== 'folder' && loading && (mode === 'roots' ? !roots : !trash)" class="project-files-rows" role="status" :aria-label="t('正在读取…')">
        <div v-for="row in 6" :key="row" class="project-file-row" aria-hidden="true"><span class="project-file-check"></span><span class="project-file-name"><USkeleton class="h-4 w-4 shrink-0" /><USkeleton class="h-4 w-2/3" /></span><USkeleton class="h-3 w-12 justify-self-end" /><USkeleton class="h-3 w-24 project-file-date" /></div>
      </div>
      <p v-if="mode !== 'folder' && section_failure" class="project-files-empty">
        <span>{{ section_failure }}</span>
        <UButton :label="t('重试')" icon="i-lucide-refresh-cw" color="neutral" variant="ghost" @click="read_section(mode)" />
      </p>

      <template v-if="mode === 'roots' && roots">
        <div class="project-files-rows">
          <template v-for="group in [{ key: 'projects', label: t('项目') }, { key: 'drafts', label: t('草稿') }]" :key="group.key">
            <p class="project-files-group">{{ group.label }}</p>
            <div v-for="item in roots?.[group.key] || []" :key="item.id" class="project-file-row is-root"><span class="project-file-check"></span>
              <button type="button" class="project-file-name" @click="navigate(() => open_account_root(item))">
                <UIcon :name="group.key === 'projects' ? 'i-lucide-folder-kanban' : 'i-lucide-folder-pen'" class="project-file-icon is-folder" /><span>{{ item.name }}</span>
              </button>
              <span class="project-file-size">{{ item.rooms.length ? t('{value1} 个房间', { value1: item.rooms.length }) : '' }}</span>
              <span class="project-file-actions">
                <time :datetime="item.modified_at">{{ modified_time(item.modified_at) }}</time>
                <UButton icon="i-lucide-trash-2" color="neutral" variant="ghost" size="xs" :aria-label="t('删除 {value1}', { value1: item.name })"
                  :title="root_lock(item) || t('移到回收区')" :disabled="loading || busy || Boolean(root_lock(item))" @click="remove_root(item)" />
              </span>
            </div>
            <p v-if="roots && !roots[group.key].length" class="project-files-empty is-small">{{ group.key === 'projects' ? t('还没有项目') : t('没有草稿') }}</p>
          </template>
        </div>
      </template>

      <!-- The cloud space in the same columns, rows, tiles and "…" menus as a project folder; read-only places first. -->
      <template v-else-if="mode === 'cloud'">
        <div v-if="layout === 'list'" class="project-files-columns"><span class="project-file-check"><input type="checkbox" :checked="all_chosen" :disabled="!choosable.length" :aria-label="t('全选')" @change="toggle_all_chosen"></span><span aria-hidden="true">{{ t('名称') }}</span><span aria-hidden="true">{{ t('大小') }}</span><span aria-hidden="true">{{ t('修改时间') }}</span></div>
        <div v-if="layout === 'icons' && (cloud.folders.value.length || cloud.files.value.length)" class="project-files-tiles">
          <div v-for="folder in cloud.folders.value" :key="`d:${folder.id}`" class="project-file-tile" :class="{ 'is-chosen': selected.has(cloud_key(folder, true)) }">
            <input v-if="!folder.readonly" type="checkbox" class="project-tile-check" :checked="selected.has(cloud_key(folder, true))" :aria-label="t('选择 {name}', { name: folder.name })" @change="toggle_chosen(cloud_key(folder, true))">
            <button type="button" :disabled="cloud.in_trash.value" :title="folder.name" @click="navigate(() => show_cloud(folder.id))">
              <span class="project-cloud-tile-icon"><UIcon name="i-lucide-folder" class="project-file-icon is-folder" /></span>
              <span class="project-file-tile-name">{{ folder.name }}<small v-if="folder.readonly" class="project-cloud-readonly">{{ t('只读') }}</small></span>
            </button>
            <span v-if="cloud_folder_menu(folder)[0].length" class="project-file-more project-file-tile-menu">
              <UDropdownMenu :items="cloud_folder_menu(folder)" :content="{ align: 'end', sideOffset: 4 }" :ui="{ content: 'channel-menu' }">
                <UButton icon="i-lucide-ellipsis" color="neutral" variant="ghost" size="xs" :aria-label="t('{value1} 的操作', { value1: folder.name })" />
              </UDropdownMenu>
            </span>
          </div>
          <div v-for="file in cloud.files.value" :key="`f:${file.id}`" class="project-file-tile" :class="{ 'is-chosen': selected.has(cloud_key(file)) }">
            <input type="checkbox" class="project-tile-check" :checked="selected.has(cloud_key(file))" :aria-label="t('选择 {name}', { name: file.file_name })" @change="toggle_chosen(cloud_key(file))">
            <button type="button" :title="file.file_name" @click="open_cloud_file(file)">
              <span class="project-cloud-tile-icon">
                <img v-if="cloud.thumbnails[file.id]" :src="cloud.thumbnails[file.id]" alt="" loading="lazy">
                <UIcon v-else :name="file_type(file.file_name)[1]" class="project-file-icon" />
              </span>
              <span class="project-file-tile-name">{{ file.file_name }}</span>
            </button>
            <span class="project-file-more project-file-tile-menu">
              <UDropdownMenu :items="cloud_file_menu(file)" :content="{ align: 'end', sideOffset: 4 }" :ui="{ content: 'channel-menu' }">
                <UButton icon="i-lucide-ellipsis" color="neutral" variant="ghost" size="xs" :aria-label="t('{value1} 的操作', { value1: file.file_name })" />
              </UDropdownMenu>
            </span>
          </div>
        </div>
        <div class="project-files-rows">
          <template v-if="layout === 'list'">
            <div v-for="folder in cloud.folders.value" :key="`d:${folder.id}`" class="project-file-row" :class="{ 'is-chosen': selected.has(cloud_key(folder, true)) }">
              <span class="project-file-check"><input v-if="!folder.readonly" type="checkbox" :checked="selected.has(cloud_key(folder, true))" :aria-label="t('选择 {name}', { name: folder.name })" @change="toggle_chosen(cloud_key(folder, true))"></span>
              <button type="button" class="project-file-name" :disabled="cloud.in_trash.value" :title="folder.name" @click="navigate(() => show_cloud(folder.id))">
                <UIcon name="i-lucide-folder" class="project-file-icon is-folder" /><span>{{ folder.name }}</span><small v-if="folder.readonly" class="project-cloud-readonly">{{ t('只读') }}</small>
              </button>
              <span class="project-file-size"></span>
              <span class="project-file-actions">
                <time v-if="folder.trashed_at || folder.created_at" :datetime="folder.trashed_at || folder.created_at">{{ modified_time(folder.trashed_at || folder.created_at) }}</time>
                <span v-if="cloud_folder_menu(folder)[0].length" class="project-file-more">
                  <UDropdownMenu :items="cloud_folder_menu(folder)" :content="{ align: 'end', sideOffset: 4 }" :ui="{ content: 'channel-menu' }">
                    <UButton icon="i-lucide-ellipsis" color="neutral" variant="ghost" size="xs" :aria-label="t('{value1} 的操作', { value1: folder.name })" />
                  </UDropdownMenu>
                </span>
              </span>
            </div>
            <div v-for="file in cloud.files.value" :key="`f:${file.id}`" class="project-file-row" :class="{ 'is-chosen': selected.has(cloud_key(file)) }">
              <span class="project-file-check"><input type="checkbox" :checked="selected.has(cloud_key(file))" :aria-label="t('选择 {name}', { name: file.file_name })" @change="toggle_chosen(cloud_key(file))"></span>
              <button type="button" class="project-file-name" :title="file.file_name" @click="open_cloud_file(file)">
                <img v-if="cloud.thumbnails[file.id]" :src="cloud.thumbnails[file.id]" alt="" class="project-cloud-thumb" loading="lazy">
                <UIcon v-else :name="file_type(file.file_name)[1]" class="project-file-icon" /><span>{{ file.file_name }}</span>
              </button>
              <span class="project-file-size">{{ file_size(file.size) }}</span>
              <span class="project-file-actions">
                <time :datetime="file.trashed_at || file.updated_at || file.created_at">{{ modified_time(file.trashed_at || file.updated_at || file.created_at) }}</time>
                <span class="project-file-more">
                  <UDropdownMenu :items="cloud_file_menu(file)" :content="{ align: 'end', sideOffset: 4 }" :ui="{ content: 'channel-menu' }">
                    <UButton icon="i-lucide-ellipsis" color="neutral" variant="ghost" size="xs" :aria-label="t('{value1} 的操作', { value1: file.file_name })" />
                  </UDropdownMenu>
                </span>
              </span>
            </div>
          </template>
          <div v-if="!cloud.listing.value && cloud.loading.value" role="status" :aria-label="t('正在读取云空间…')">
            <div v-for="row in 6" :key="row" class="project-file-row" aria-hidden="true"><span class="project-file-check"></span><span class="project-file-name"><USkeleton class="h-4 w-4 shrink-0" /><USkeleton class="h-4 w-2/3" /></span><USkeleton class="h-3 w-12 justify-self-end" /><USkeleton class="h-3 w-24 project-file-date" /></div>
          </div>
          <p v-else-if="cloud.listing.value && !cloud.folders.value.length && !cloud.files.value.length" class="project-files-empty">
            <UIcon :name="cloud.in_trash.value ? 'i-lucide-trash' : 'i-lucide-folder-open'" />{{ cloud.searching.value ? t('没有找到名称里有这些字的文件') : cloud.in_trash.value ? t('回收站是空的') : cloud.special.value ? t('这里没有文件') : t('此文件夹为空，可以上传文件或把文件、文件夹拖到这里') }}
          </p>
        </div>
        <footer v-if="cloud.listing.value" class="project-files-footer">
          <span>{{ t('{value1} 项', { value1: cloud.folders.value.length + cloud.files.value.length }) }}<template v-if="cloud.in_trash.value"> · {{ t('回收站里的文件保留 30 天，仍占用空间') }}</template></span>
        </footer>
      </template>

      <template v-else-if="mode === 'trash'">
        <div class="project-files-rows">
          <div v-for="item in trash || []" :key="item.id" class="project-file-row is-root"><span class="project-file-check"></span>
            <span class="project-file-name" :title="`${item.root_name}/${item.path}`"><UIcon :name="item.kind === 'directory' ? 'i-lucide-folder' : file_type(item.name)[1]" class="project-file-icon" /><span>{{ item.root_name }}/{{ item.path }}</span></span>
            <span class="project-file-size">{{ file_size(item.size) }}</span>
            <span class="project-file-actions">
              <time :datetime="item.deleted_at">{{ deleted_time(item.deleted_at) }}</time>
              <UButton icon="i-lucide-undo-2" color="neutral" variant="ghost" size="xs" :label="t('还原')" :disabled="loading || busy" @click="restore(item)" />
            </span>
          </div>
          <p v-if="trash && !trash.length" class="project-files-empty"><UIcon name="i-lucide-trash" />{{ t('回收区是空的') }}</p>
        </div>
      </template>

      <template v-else-if="mode === 'folder'">
        <div v-if="layout === 'list'" class="project-files-columns"><span class="project-file-check"><input type="checkbox" :checked="all_chosen" :disabled="!choosable.length" :aria-label="t('全选')" @change="toggle_all_chosen"></span><span aria-hidden="true">{{ t('名称') }}</span><span aria-hidden="true">{{ t('大小') }}</span><span aria-hidden="true">{{ t('修改时间') }}</span></div>
        <!-- Tiles change only with the listing; each loads its own thumbnail once it scrolls into view. -->
        <div v-if="layout === 'icons' && listing?.entries.length" v-memo="[listing, directory, root, busy, menu_epoch, selected]" class="project-files-tiles">
          <UContextMenu v-for="entry in listing.entries" :key="`${entry.path}#${menu_epoch}`" :disabled="entry.kind === 'unavailable' || busy" :items="entry_menu(entry)" :ui="{ content: 'channel-menu project-file-menu' }">
          <div class="project-file-tile" :class="{ 'is-hidden': entry.name.startsWith('.'), 'is-unavailable': entry.kind === 'unavailable', 'is-chosen': selected.has(project_key(entry)) }">
            <input v-if="entry.kind !== 'unavailable'" type="checkbox" class="project-tile-check" :checked="selected.has(project_key(entry))" :aria-label="t('选择 {name}', { name: entry.name })" @change="toggle_chosen(project_key(entry))">
            <button type="button" :disabled="entry.kind === 'unavailable'" :title="entry.kind === 'unavailable' ? t('{value1}（无法读取或指向项目外）', { value1: entry.name }) : entry.name"
              @click="open_entry(entry)">
              <ProjectFileThumbnail :key="`${entry.size}:${entry.modified_at}`" :entry="entry" :root="root" :icon="tile_icon(entry)" />
              <span class="project-file-tile-name">{{ entry.name }}</span>
            </button>
            <span v-if="entry.kind !== 'unavailable'" class="project-file-more project-file-tile-menu">
              <UDropdownMenu :items="entry_menu(entry)" :content="{ align: 'end', sideOffset: 4 }" :ui="{ content: 'channel-menu' }">
                <UButton icon="i-lucide-ellipsis" color="neutral" variant="ghost" size="xs" :aria-label="t('{value1} 的操作', { value1: entry.name })" :disabled="busy" />
              </UDropdownMenu>
            </span>
          </div>
          </UContextMenu>
        </div>
        <!-- Rows change only with the listing; the room's directories arrive as a new array on every view publish. -->
        <div v-memo="[listing, loading, directory, root, busy, layout, menu_epoch, selected]" class="project-files-rows">
          <template v-if="layout === 'list'">
          <UContextMenu v-for="entry in listing?.entries || []" :key="`${entry.path}#${menu_epoch}`" :disabled="entry.kind === 'unavailable' || busy" :items="entry_menu(entry)" :ui="{ content: 'channel-menu project-file-menu' }">
          <div class="project-file-row" :class="{ 'is-hidden': entry.name.startsWith('.'), 'is-unavailable': entry.kind === 'unavailable', 'is-chosen': selected.has(project_key(entry)) }">
            <span class="project-file-check"><input v-if="entry.kind !== 'unavailable'" type="checkbox" :checked="selected.has(project_key(entry))" :aria-label="t('选择 {name}', { name: entry.name })" @change="toggle_chosen(project_key(entry))"></span>
            <button type="button" class="project-file-name" :disabled="entry.kind === 'unavailable'" :title="entry.kind === 'unavailable' ? t('{value1}（无法读取或指向项目外）', { value1: entry.name }) : entry.name"
              @click="open_entry(entry)">
              <UIcon :name="entry_icon(entry)[0]" class="project-file-icon" :class="entry_icon(entry)[1]" /><span>{{ entry.name }}</span>
            </button>
            <span class="project-file-size">{{ file_size(entry.size) }}</span>
            <span class="project-file-actions">
              <time :datetime="entry.modified_at">{{ modified_time(entry.modified_at) }}</time>
              <span v-if="entry.kind !== 'unavailable'" class="project-file-more">
                <UDropdownMenu :items="entry_menu(entry)" :content="{ align: 'end', sideOffset: 4 }" :ui="{ content: 'channel-menu' }">
                  <UButton icon="i-lucide-ellipsis" color="neutral" variant="ghost" size="xs" :aria-label="t('{value1} 的操作', { value1: entry.name })" :disabled="busy" />
                </UDropdownMenu>
              </span>
            </span>
          </div>
          </UContextMenu>
          </template>
          <div v-if="!listing && loading" role="status" :aria-label="t('正在读取项目目录')">
            <div v-for="row in 6" :key="row" class="project-file-row" aria-hidden="true"><span class="project-file-check"></span><span class="project-file-name"><USkeleton class="h-4 w-4 shrink-0" /><USkeleton class="h-4 w-2/3" /></span><USkeleton class="h-3 w-12 justify-self-end" /><USkeleton class="h-3 w-24 project-file-date" /></div>
          </div>
          <p v-else-if="!listing" class="project-files-empty"><UButton :label="t('重新读取目录')" icon="i-lucide-refresh-cw" color="neutral" variant="ghost" @click="read_directory(current_path)" /></p>
          <p v-else-if="!listing.entries.length" class="project-files-empty"><UIcon name="i-lucide-folder-open" />{{ t('此文件夹为空') }}</p>
        </div>
        <footer v-if="listing" class="project-files-footer">
          <span>{{ t('{value1} 项', { value1: listing.total }) }}<template v-if="listing.next_offset !== null">{{ t('，已显示 {value1} 项', { value1: listing.entries.length }) }}</template></span>
          <UButton v-if="listing.next_offset !== null" :label="t('加载更多')" color="neutral" variant="ghost" size="xs" :loading="loading" :disabled="loading" @click="read_directory(listing.path, true)" />
        </footer>
      </template>
    </div>

    <UModal :open="Boolean(cloud_sharing)" :title="cloud_sharing ? t('分享 {name}', { name: cloud_sharing.file_name }) : ''" @update:open="(open) => !open && (cloud_sharing = null)">
      <template #body><CloudShares v-if="cloud_sharing" :file="cloud_sharing" :api="cloud.share_api" with-code @failed="(message) => bridge.notify('error', message)" /></template>
    </UModal>
    <UModal :open="Boolean(cloud_moving)" :title="t('移动到')" @update:open="(open) => !open && (cloud_moving = null)">
      <template #body>
        <div v-if="cloud_moving" class="project-cloud-move">
          <nav class="project-explorer-path">
            <button type="button" :disabled="!cloud_moving.at" @click="browse_cloud_move(null)">{{ t('云空间') }}</button>
            <template v-for="part in cloud_moving.path" :key="part.id"><UIcon name="i-lucide-chevron-right" class="project-crumb-separator" /><button type="button" @click="browse_cloud_move(part.id)">{{ part.name }}</button></template>
          </nav>
          <p v-if="cloud_moving.loading" class="project-files-empty">{{ t('正在读取…') }}</p>
          <button v-for="folder in cloud_moving.children" v-else :key="folder.id" type="button" class="project-file-name project-cloud-move-row" @click="browse_cloud_move(folder.id)">
            <UIcon name="i-lucide-folder" class="project-file-icon is-folder" /><span>{{ folder.name }}</span>
          </button>
          <div class="project-cloud-move-foot">
            <UButton :label="t('取消')" color="neutral" variant="ghost" size="sm" @click="cloud_moving = null" />
            <UButton :label="t('移到这里')" size="sm" :disabled="cloud_moving.loading" @click="finish_cloud_move" />
          </div>
        </div>
      </template>
    </UModal>
    <div v-if="pending_land" class="project-files-land-layer">
      <div class="project-files-land" role="status">
        <UIcon name="i-lucide-folder-down" /><span>{{ mode === 'folder' ? t('把“{name}”放到当前文件夹？', { name: pending_land.file_name }) : t('打开要放入“{name}”的文件夹', { name: pending_land.file_name }) }}</span>
        <UButton v-if="mode === 'folder'" :label="t('放到这里')" size="xs" :disabled="busy" @click="land_here" />
        <UButton :label="t('取消')" color="neutral" variant="ghost" size="xs" @click="bridge.clear_pending_land()" />
      </div>
    </div>
  </section>

</template>

<style scoped>
.project-files { --row-height: 34px; }
.project-files-heading { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; margin-bottom: 16px; }
.project-files-heading > div:first-child { min-width: 0; }
.project-files-heading h2 { margin: 0 0 4px; font-size: 18px; font-weight: 600; }
.project-files-heading p { margin: 0; color: var(--ui-text-muted); font-size: 12px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.project-files-tools { display: flex; align-items: center; gap: 2px; flex-shrink: 0; }

.project-roots { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 10px; }
.project-roots button { display: inline-flex; align-items: center; gap: 6px; max-width: 240px; padding: 4px 10px; border: 1px solid var(--ui-border); border-radius: 6px;
  color: var(--ui-text-muted); font-size: 12px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
@media (hover: hover) { .project-roots button:hover { color: var(--ui-text-highlighted); } }
/* Selected by color and border only: a bolder name would widen the tab and push the ones after it (#15798). */
.project-roots button[aria-selected="true"] { border-color: var(--ui-primary); color: var(--ui-text-highlighted); }
.project-roots button > span { flex-shrink: 0; width: 13px; height: 13px; }
.project-files-ask { display: grid; gap: 12px; font-size: 13px; }
.project-files-ask p { margin: 0; overflow-wrap: anywhere; }
.project-files-ask > div { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.project-files-ask-all { display: inline-flex; align-items: center; gap: 4px; color: var(--ui-text-muted); font-size: 12px; }
/* Each heading icon sits in a wrapper that carries its tooltip, also while the icon is greyed out. */
.project-files-tool { display: inline-flex; }
/* The cloud space in the same frame: at the path bar's end its search and the space used; read-only folders say so. */
.project-cloud-side { display: flex; flex-shrink: 0; gap: 10px; align-items: center; padding-right: 10px; }
.project-cloud-search { width: 180px; padding: 3px 8px; color: inherit; font: inherit; font-size: 12px; background: transparent; border: 1px solid var(--ui-border); border-radius: 6px; }
.project-cloud-usage { width: 16ch; overflow: hidden; text-overflow: ellipsis; text-align: right; color: var(--ui-text-muted); font-size: 12px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.project-cloud-readonly { flex-shrink: 0; margin-left: 6px; padding: 0 6px; color: var(--ui-text-muted); font-size: 11px; border: 1px solid var(--ui-border); border-radius: 999px; }
.project-cloud-thumb { width: 18px; height: 18px; flex-shrink: 0; object-fit: cover; border-radius: 3px; }
.project-cloud-tile-icon { display: grid; place-items: center; width: 100%; aspect-ratio: 4 / 3; }
.project-cloud-tile-icon img { width: 100%; height: 100%; object-fit: cover; border-radius: 6px; }
.project-cloud-tile-icon .project-file-icon { width: 40px; height: 40px; }
.project-cloud-move { display: flex; flex-direction: column; gap: 4px; }
.project-cloud-move-row { padding: 6px; border-radius: 6px; }
.project-cloud-move-row:hover { background: color-mix(in srgb, currentColor 6%, transparent); }
.project-cloud-move-foot { display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px; }
@media (max-width: 700px) {
  .project-cloud-search { width: 110px; }
  .project-cloud-usage { display: none; }
}
.project-files-land-layer { position: sticky; z-index: 5; bottom: 12px; height: 0; }
.project-files-land { position: absolute; right: 0; bottom: 0; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; width: min(100%, 440px); padding: 8px 10px; border: 1px solid var(--ui-border-muted); border-radius: 8px; box-shadow: 0 4px 16px #0002; background: var(--ui-bg); font-size: 12px; }
.project-files-land > span { flex: 1; min-width: 0; }
.project-explorer { overflow: hidden; border: 1px solid var(--ui-border); border-radius: 10px; background: color-mix(in srgb, var(--ui-bg-elevated) 45%, transparent); }
.project-explorer-bar { display: flex; align-items: center; border-bottom: 1px solid var(--ui-border); }
.project-explorer-steps { display: flex; flex-shrink: 0; align-items: center; padding: 0 2px 0 6px; }
.project-explorer-path { display: flex; flex: 1; min-width: 0; flex-wrap: nowrap; align-items: center; gap: 1px; min-height: 38px; padding: 4px 10px 4px 4px; overflow-x: auto; scrollbar-width: none; font-size: 13px; }
.project-explorer-path > * { flex-shrink: 0; }
.project-explorer-path button { display: inline-flex; align-items: center; padding: 3px 5px; border-radius: 5px; color: var(--ui-text-muted); white-space: nowrap; cursor: pointer; }
@media (hover: hover) { .project-explorer-path button:hover:not(:disabled) { background: var(--ui-bg-accented); color: var(--ui-text); } }
.project-explorer-path button[aria-current] { color: var(--ui-text-highlighted); font-weight: 600; cursor: default; }
.project-explorer-path button:disabled:not([aria-current]) { cursor: default; }
.project-files-naming { display: flex; align-items: center; gap: 8px; padding: 6px 14px; border-bottom: 1px solid var(--ui-border); }
.project-files-naming input { flex: 1; min-width: 0; padding: 4px 8px; border: 1px solid var(--ui-border-accented); border-radius: 6px; background: var(--ui-bg); font-size: 13px; }
.project-files-group { margin: 8px 10px 2px; color: var(--ui-text-dimmed); font-size: 11px; letter-spacing: .02em; }

.project-files-columns, .project-file-row { display: grid; grid-template-columns: 16px minmax(0, 1fr) 84px 168px; align-items: center; gap: 16px; padding: 0 14px; }
.project-files-columns { height: 30px; color: var(--ui-text-dimmed); font-size: 11px; letter-spacing: .02em; border-bottom: 1px solid var(--ui-border); }
.project-files-columns > :nth-child(3), .project-file-size { text-align: right; }
/* The choice column leads every row of a project folder and the cloud space; rows that cannot be chosen keep it empty. */
.project-file-check { display: flex; align-items: center; justify-content: center; }
.project-file-check input, .project-tile-check { width: 14px; height: 14px; margin: 0; accent-color: var(--ui-primary); cursor: pointer; }
.project-file-row.is-chosen, .project-file-tile.is-chosen { background: color-mix(in srgb, var(--ui-primary) 10%, transparent); }
.project-tile-check { position: absolute; top: 8px; left: 8px; z-index: 1; }
/* Takes the place of the path bar, at its height, while anything is chosen. */
.project-selection-bar { gap: 2px; min-height: 39px; padding: 0 8px 0 12px; }
.project-selection-count { margin-right: auto; font-size: 13px; font-weight: 600; white-space: nowrap; }
.project-files-rows { padding: 4px; }
.project-file-row { width: 100%; height: var(--row-height); text-align: left; font-size: 13px; border-radius: 6px; padding-inline: 10px; }
@media (hover: hover) { .project-file-row:hover { background: var(--ui-bg-accented); } }
.project-file-row.is-unavailable { opacity: .45; }
.project-file-row.is-hidden .project-file-name > span:last-child { color: var(--ui-text-muted); }
.project-file-name { display: flex; align-items: center; gap: 9px; min-width: 0; height: 100%; text-align: left; cursor: pointer; }
.project-file-name:disabled { cursor: default; }
.project-file-name:focus-visible { outline: 1px solid var(--ui-primary); outline-offset: -1px; border-radius: 4px; }
.project-file-name > span:last-child { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.project-file-actions { display: flex; align-items: center; justify-content: flex-end; gap: 4px; }
.project-file-row time, .project-file-size { color: var(--ui-text-dimmed); font-size: 12px; font-variant-numeric: tabular-nums; }
.project-files-tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(132px, 1fr)); gap: 6px; padding: 8px; }
.project-file-tile { position: relative; min-width: 0; border-radius: 8px; }
@media (hover: hover) { .project-file-tile:hover { background: var(--ui-bg-accented); } }
.project-file-tile.is-unavailable { opacity: .45; }
.project-file-tile > button { display: flex; flex-direction: column; align-items: center; gap: 6px; width: 100%; padding: 8px; border-radius: 8px; cursor: pointer; }
.project-file-tile > button:disabled { cursor: default; }
.project-file-tile > button:focus-visible { outline: 1px solid var(--ui-primary); outline-offset: -1px; }
.project-file-tile-name { display: -webkit-box; width: 100%; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 2; font-size: 12px; line-height: 16px;
  text-align: center; overflow-wrap: anywhere; }
.project-file-tile.is-hidden .project-file-tile-name { color: var(--ui-text-muted); }
.project-file-tile-menu { position: absolute; top: 4px; right: 4px; }
/* As in the room list, pressing an entry opens it or (held) its menu and never selects its name or picture. */
.project-file-row .project-file-name, .project-file-tile > button { user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; touch-action: pan-y; }
/* Phones open an entry's menu by a long press alone (user 2026-11-27, #14141). */
@media (hover: none) { .project-file-more, .project-explorer-forward { display: none; } }
@media (hover: hover) {
  .project-file-tile-menu { opacity: 0; }
  .project-file-tile:hover .project-file-tile-menu, .project-file-tile:focus-within .project-file-tile-menu, .project-file-tile-menu:has([data-state="open"]) { opacity: 1; }
}
.project-files-footer { display: flex; align-items: center; justify-content: space-between; height: 36px; padding: 0 14px; border-top: 1px solid var(--ui-border); color: var(--ui-text-dimmed); font-size: 12px; }
.project-files-empty { display: flex; align-items: center; justify-content: center; gap: 8px; padding: 40px 12px; font-size: 13px; color: var(--ui-text-muted); }
.project-files-empty.is-small { padding: 8px 12px; justify-content: flex-start; font-size: 12px; }

@media (max-width: 640px) {
  .project-explorer-path { min-height: 36px; padding: 4px 8px 4px 2px; font-size: 12px; }
  .project-explorer-steps { padding-left: 2px; }
  .project-explorer-path button { padding: 3px 4px; }
  .project-files-columns, .project-file-row { grid-template-columns: 16px minmax(0, 1fr) 64px auto; gap: 8px; }
  .project-selection-bar { min-height: 37px; padding-left: 10px; }
  .project-files-columns > :last-child, .project-file-row time, .project-file-date { display: none; }
  /* Four to a row on a phone, the name right under its picture (user 2026-11-27, #15002: three loose tiles a screen). */
  .project-files-tiles { grid-template-columns: repeat(auto-fill, minmax(76px, 1fr)); gap: 2px; padding: 4px; }
  .project-file-tile > button { gap: 3px; padding: 4px 2px 6px; }
  .project-file-tile-name { font-size: 11px; line-height: 14px; }
}
</style>

<script setup>
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { file_preview, file_size, file_type, folder_listings, modified_time, shown_folders } from "./file-preview.js";
import { t } from './i18n.js';

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
// Files being uploaded: `{ id, name, progress, error }`.
const uploads = ref([]);
const file_input = ref(null);
// A question about a name already taken: `{ name, many, resolve }`, answered "replace", "keep_both" or null (skip).
const asking = ref(null);
const ask_all = ref(false);
let listing_request = 0;
// The whole project's listings are kept current behind the page, top folders first: each pass asks only whether a folder
// changed, so an unchanged project costs a few small requests. Generated folders are read when they are opened.
const SWEEP_BATCH = 100, SWEEP_FOLDER_LIMIT = 10000, SWEEP_SETTLE_MS = 3000;
const SWEEP_SKIPPED = new Set(["node_modules", ".git", "__pycache__", ".venv", "venv"]);
const UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
let sweep_run = 0, sweep_timer = 0, left_page = false;
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
  naming.value = { kind, entry, value: entry?.name || "" };
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
  if (kind === "mkdir") await change({ op: "mkdir", path: current_path.value, name });
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

/** Copy or cut one entry for pasting in another folder (of this or another project). */
function take(entry, kind) {
  clipboard.value = { mode: kind, root: root.value, root_name: root_name.value, path: entry.path, name: entry.name };
  bridge.notify("info", kind === "copy" ? t('已复制 {value1}，打开目标文件夹后点“粘贴”', { value1: entry.name }) : t('已剪切 {value1}，打开目标文件夹后点“粘贴”', { value1: entry.name }));
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
  const payload = { op: "paste", mode: item.mode, source: { root: item.root, path: item.path }, path: current_path.value };
  let answer = await change(payload);
  if (answer?.conflict) {
    const choice = await ask_conflict(answer.name);
    if (!choice) return;
    answer = await change({ ...payload, conflict: choice });
  }
  if (answer && !answer.conflict && item.mode === "move") clipboard.value = null;
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
    if (file.size > UPLOAD_MAX_BYTES) { bridge.notify("warning", t('{value1} 超过 20 MB，未上传；更大的文件请给 AI 下载链接或仓库地址', { value1: file.name })); continue; }
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
    plans.push({ file, conflict });
  }
  let uploaded = 0;
  for (const { file, conflict } of plans) {
    const item = { id: crypto.randomUUID(), name: file.name, progress: 0, error: "" };
    if (!left_page) uploads.value = [...uploads.value, item];
    const update = (patch) => {
      if (!left_page) uploads.value = uploads.value.map((entry) => entry.id === item.id ? { ...entry, ...patch } : entry);
    };
    try {
      await bridge.upload_project_file(room_id, { ...target, file, conflict, on_progress: (progress) => update({ progress }) });
      if (!left_page) uploads.value = uploads.value.filter((entry) => entry.id !== item.id);
      uploaded += 1;
    } catch (error) {
      if (left_page) bridge.notify("error", t('{name} 上传失败：{reason}', { name: file.name, reason: error.message }));
      else update({ error: error.message });
    }
  }
  if (uploaded) {
    bridge.notify("info", t('已上传 {value1} 个文件', { value1: uploaded }));
    if (!left_page && mode.value === "folder" && root.value === target.root && current_path.value === target.path) read_directory(current_path.value);
  }
}

/** Save one folder, with everything under it, to this device as a ZIP. */
async function download_folder(entry) {
  bridge.notify("info", t('正在打包“{name}”，完成后浏览器会开始下载。', { name: entry.name }));
  try { await bridge.download_project_folder(room_id, entry.path, root.value); }
  catch (error) { bridge.notify("error", t('下载失败：{value1}', { value1: error.message })); }
}

/** Save one file to this device. */
async function download(entry) {
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
</script>

<template>
  <section class="project-files">
    <header class="project-files-heading">
      <div><h2>{{ t('项目文件') }}</h2><p>{{ mode === 'roots' ? t('项目与草稿') : mode === 'trash' ? t('回收区（保留 30 天）') : root_name }}</p></div>
      <div class="project-files-tools">
        <template v-if="mode === 'folder'">
          <UButton icon="i-lucide-folder-plus" color="neutral" variant="ghost" size="sm" :aria-label="t('新建文件夹')" :title="t('新建文件夹')" :disabled="busy" @click="start_naming('mkdir')" />
          <UButton icon="i-lucide-upload" color="neutral" variant="ghost" size="sm" :aria-label="t('上传文件')" :title="t('上传文件（单个不超过 20 MB）')" :disabled="busy" @click="file_input?.click()" />
          <UButton v-if="clipboard" icon="i-lucide-clipboard-paste" color="neutral" variant="soft" size="sm" :label="t('粘贴')" :title="t('粘贴 {value1}', { value1: clipboard.name })" :disabled="busy" @click="paste" />
          <input ref="file_input" type="file" multiple hidden @change="upload_files($event.target.files)" />
        </template>
        <UButton v-if="mode === 'roots' && roots?.can_create_project" icon="i-lucide-folder-plus" color="neutral" variant="ghost" size="sm" :label="t('新建项目')" :disabled="loading || busy" @click="start_naming('project')" />
        <UButton icon="i-lucide-trash-2" color="neutral" :variant="mode === 'trash' ? 'soft' : 'ghost'" size="sm" :aria-label="t('回收区')" :title="t('回收区')" @click="mode === 'trash' ? open_project(current_path) : show_trash()" />
        <UButton icon="i-lucide-refresh-cw" color="neutral" variant="ghost" size="sm" :aria-label="t('刷新')" :title="t('刷新')" :loading="loading || busy"
          @click="mode === 'roots' ? show_roots() : mode === 'trash' ? show_trash() : (read_directory(current_path), sweep_folders())" />
      </div>
    </header>

    <div v-if="directories.length > 1 && mode === 'folder' && !account_root" class="project-roots" role="tablist" :aria-label="t('项目目录')">
      <button v-for="(path, index) in directories" :key="path" type="button" role="tab" :aria-selected="index === root" @click="switch_root(index)">
        <UIcon :name="index ? 'i-lucide-folder' : 'i-lucide-folder-root'" />{{ folder_name(path) }}
      </button>
    </div>

    <div v-if="asking" class="project-files-ask" role="alertdialog" :aria-label="t('文件已存在')">
      <p>{{ t('“{value1}”已存在。', { value1: asking.name }) }}</p>
      <div>
        <UButton :label="t('替换并保留旧版')" color="primary" size="xs" @click="answer_conflict('replace')" />
        <UButton :label="t('保留两份')" color="neutral" variant="outline" size="xs" @click="answer_conflict('keep_both')" />
        <UButton :label="t('跳过')" color="neutral" variant="ghost" size="xs" @click="answer_conflict(null)" />
        <label v-if="asking.many" class="project-files-ask-all"><input v-model="ask_all" type="checkbox" />{{ t('其余都按此处理') }}</label>
      </div>
    </div>

    <div v-if="uploads.length" class="project-files-uploads">
      <div v-for="item in uploads" :key="item.id" class="project-files-upload">
        <UIcon :name="item.error ? 'i-lucide-circle-alert' : 'i-lucide-upload'" /><span class="project-files-upload-name">{{ item.name }}</span>
        <span v-if="item.error" class="project-files-upload-error">{{ item.error }}</span><span v-else>{{ Math.round(item.progress * 100) }}%</span>
        <UButton v-if="item.error" icon="i-lucide-x" color="neutral" variant="ghost" size="xs" :aria-label="t('关闭')" @click="uploads = uploads.filter((entry) => entry.id !== item.id)" />
      </div>
    </div>

    <div class="project-explorer" :aria-busy="loading || busy">
      <nav ref="path_nav" class="project-explorer-path" :aria-label="t('文件路径')">
        <button type="button" :aria-current="mode === 'roots' ? 'location' : undefined" :disabled="mode === 'roots'" :title="t('所有项目与草稿')" @click="show_roots()">
          {{ t('项目') }}
        </button>
        <template v-if="mode === 'folder'">
          <template v-for="(part, index) in breadcrumbs" :key="part.path">
            <UIcon name="i-lucide-chevron-right" class="project-crumb-separator" />
            <button type="button" :disabled="index === breadcrumbs.length - 1" :aria-current="index === breadcrumbs.length - 1 ? 'location' : undefined" @click="read_directory(part.path)">
              {{ part.name }}
            </button>
          </template>
        </template>
        <template v-else-if="mode === 'trash'"><UIcon name="i-lucide-chevron-right" class="project-crumb-separator" /><button type="button" disabled aria-current="location">{{ t('回收区') }}</button></template>
      </nav>

      <form v-if="naming" class="project-files-naming" @submit.prevent="finish_naming">
        <UIcon :name="naming.kind === 'rename' ? 'i-lucide-pencil' : 'i-lucide-folder-plus'" />
        <input ref="name_input" v-model="naming.value" :aria-label="naming.kind === 'rename' ? t('新名称') : naming.kind === 'project' ? t('项目名称') : t('文件夹名称')"
          :placeholder="naming.kind === 'rename' ? t('新名称') : naming.kind === 'project' ? t('项目名称') : t('文件夹名称')" maxlength="200" @keydown.esc.prevent="naming = null" />
        <UButton type="submit" :label="t('确定')" size="xs" :disabled="busy" />
        <UButton :label="t('取消')" color="neutral" variant="ghost" size="xs" @click="naming = null" />
      </form>

      <div v-if="mode !== 'folder' && loading && (mode === 'roots' ? !roots : !trash)" class="project-files-rows" role="status" :aria-label="t('正在读取…')">
        <div v-for="row in 6" :key="row" class="project-file-row" aria-hidden="true"><span class="project-file-name"><USkeleton class="h-4 w-4 shrink-0" /><USkeleton class="h-4 w-2/3" /></span><USkeleton class="h-3 w-12 justify-self-end" /><USkeleton class="h-3 w-24 project-file-date" /></div>
      </div>
      <p v-if="mode !== 'folder' && section_failure" class="project-files-empty">
        <span>{{ section_failure }}</span>
        <UButton :label="t('重试')" icon="i-lucide-refresh-cw" color="neutral" variant="ghost" @click="read_section(mode)" />
      </p>

      <template v-if="mode === 'roots' && roots">
        <div class="project-files-rows">
          <template v-for="group in [{ key: 'projects', label: t('项目') }, { key: 'drafts', label: t('草稿') }]" :key="group.key">
            <p class="project-files-group">{{ group.label }}</p>
            <div v-for="item in roots?.[group.key] || []" :key="item.id" class="project-file-row is-root">
              <button type="button" class="project-file-name" @click="open_account_root(item)">
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

      <template v-else-if="mode === 'trash'">
        <div class="project-files-rows">
          <div v-for="item in trash || []" :key="item.id" class="project-file-row is-root">
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
        <div class="project-files-columns" aria-hidden="true"><span>{{ t('名称') }}</span><span>{{ t('大小') }}</span><span>{{ t('修改时间') }}</span></div>
        <!-- Rows change only with the listing; the room's directories arrive as a new array on every view publish. -->
        <div v-memo="[listing, loading, directory, root, busy]" class="project-files-rows">
          <UContextMenu v-for="entry in listing?.entries || []" :key="entry.path" :disabled="entry.kind === 'unavailable' || busy" :items="entry_menu(entry)" :ui="{ content: 'channel-menu' }">
          <div class="project-file-row" :class="{ 'is-hidden': entry.name.startsWith('.'), 'is-unavailable': entry.kind === 'unavailable' }">
            <button type="button" class="project-file-name" :disabled="entry.kind === 'unavailable'" :title="entry.kind === 'unavailable' ? t('{value1}（无法读取或指向项目外）', { value1: entry.name }) : entry.name"
              @click="entry.kind === 'directory' ? read_directory(entry.path) : file_preview.open?.(entry.path, account_root ? account_root.name : directory, root, entry)">
              <UIcon :name="entry_icon(entry)[0]" class="project-file-icon" :class="entry_icon(entry)[1]" /><span>{{ entry.name }}</span>
            </button>
            <span class="project-file-size">{{ file_size(entry.size) }}</span>
            <span class="project-file-actions">
              <time :datetime="entry.modified_at">{{ modified_time(entry.modified_at) }}</time>
              <UDropdownMenu v-if="entry.kind !== 'unavailable'" :items="entry_menu(entry)" :content="{ align: 'end', sideOffset: 4 }" :ui="{ content: 'channel-menu' }">
                <UButton icon="i-lucide-ellipsis" color="neutral" variant="ghost" size="xs" :aria-label="t('{value1} 的操作', { value1: entry.name })" :disabled="busy" />
              </UDropdownMenu>
            </span>
          </div>
          </UContextMenu>
          <div v-if="!listing && loading" role="status" :aria-label="t('正在读取项目目录')">
            <div v-for="row in 6" :key="row" class="project-file-row" aria-hidden="true"><span class="project-file-name"><USkeleton class="h-4 w-4 shrink-0" /><USkeleton class="h-4 w-2/3" /></span><USkeleton class="h-3 w-12 justify-self-end" /><USkeleton class="h-3 w-24 project-file-date" /></div>
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
.project-roots button[aria-selected="true"] { border-color: var(--ui-primary); color: var(--ui-text-highlighted); font-weight: 500; }
.project-roots button > span { flex-shrink: 0; width: 13px; height: 13px; }
.project-files-ask { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 10px; padding: 8px 12px;
  border: 1px solid var(--ui-warning); border-radius: 8px; font-size: 13px; }
.project-files-ask p { margin: 0; overflow-wrap: anywhere; }
.project-files-ask > div { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.project-files-ask-all { display: inline-flex; align-items: center; gap: 4px; color: var(--ui-text-muted); font-size: 12px; }
.project-files-uploads { display: grid; gap: 4px; margin-bottom: 10px; font-size: 12px; }
.project-files-upload { display: flex; align-items: center; gap: 8px; padding: 4px 10px; border: 1px solid var(--ui-border); border-radius: 6px; color: var(--ui-text-muted); }
.project-files-upload-name { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--ui-text); }
.project-files-upload-error { color: var(--ui-error); }
.project-explorer { overflow: hidden; border: 1px solid var(--ui-border); border-radius: 10px; background: color-mix(in srgb, var(--ui-bg-elevated) 45%, transparent); }
.project-explorer-path { display: flex; flex-wrap: nowrap; align-items: center; gap: 1px; min-height: 38px; padding: 4px 10px; overflow-x: auto; scrollbar-width: none; border-bottom: 1px solid var(--ui-border); font-size: 13px; }
.project-explorer-path > * { flex-shrink: 0; }
.project-explorer-path button { display: inline-flex; align-items: center; padding: 3px 5px; border-radius: 5px; color: var(--ui-text-muted); white-space: nowrap; cursor: pointer; }
@media (hover: hover) { .project-explorer-path button:hover:not(:disabled) { background: var(--ui-bg-accented); color: var(--ui-text); } }
.project-explorer-path button[aria-current] { color: var(--ui-text-highlighted); font-weight: 600; cursor: default; }
.project-explorer-path button:disabled:not([aria-current]) { cursor: default; }
.project-files-naming { display: flex; align-items: center; gap: 8px; padding: 6px 14px; border-bottom: 1px solid var(--ui-border); }
.project-files-naming input { flex: 1; min-width: 0; padding: 4px 8px; border: 1px solid var(--ui-border-accented); border-radius: 6px; background: var(--ui-bg); font-size: 13px; }
.project-files-group { margin: 8px 10px 2px; color: var(--ui-text-dimmed); font-size: 11px; letter-spacing: .02em; }

.project-files-columns, .project-file-row { display: grid; grid-template-columns: minmax(0, 1fr) 84px 168px; align-items: center; gap: 16px; padding: 0 14px; }
.project-files-columns { height: 30px; color: var(--ui-text-dimmed); font-size: 11px; letter-spacing: .02em; border-bottom: 1px solid var(--ui-border); }
.project-files-columns > :nth-child(2), .project-file-size { text-align: right; }
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
.project-files-footer { display: flex; align-items: center; justify-content: space-between; height: 36px; padding: 0 14px; border-top: 1px solid var(--ui-border); color: var(--ui-text-dimmed); font-size: 12px; }
.project-files-empty { display: flex; align-items: center; justify-content: center; gap: 8px; padding: 40px 12px; font-size: 13px; color: var(--ui-text-muted); }
.project-files-empty.is-small { padding: 8px 12px; justify-content: flex-start; font-size: 12px; }

@media (max-width: 640px) {
  .project-explorer-path { min-height: 36px; padding: 4px 8px; font-size: 12px; }
  .project-explorer-path button { padding: 3px 4px; }
  .project-files-columns, .project-file-row { grid-template-columns: minmax(0, 1fr) 64px auto; gap: 8px; }
  .project-files-columns > :last-child, .project-file-row time, .project-file-date { display: none; }
}
</style>

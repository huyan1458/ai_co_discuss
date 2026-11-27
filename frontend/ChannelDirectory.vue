<script>
import { ref as module_ref } from "vue";
// The folders open in this page load, kept outside the component: a phone's sidebar is a drawer mounted anew each time
// it opens, and keeping them inside it forgot them on every close (user 2026-11-16). A reload starts afresh with only
// the shown room's folder open (user 2026-11-15).
const open_folders = module_ref(new Set());
const open_parents = module_ref(new Set());
const folded_parents = new Set();
let known_children = null;
const rooms_open = module_ref(true);
// The room whose folder was last opened for it, so mounting the drawer again is not taken for opening that room.
let revealed_for = "";
// Sorted by recent activity, each folder first lists this many rooms, and each "show more" reveals this many again. How far
// the user has opened each folder survives the phone drawer being mounted anew, as open_folders does.
const ROOM_BATCH_COUNT = 5;
const listed_counts = module_ref(new Map());
</script>

<script setup>
import { computed, inject, nextTick, ref, watch } from "vue";
import ImportDialog from "./ImportDialog.vue";
import ConfirmDialog from "./ConfirmDialog.vue";
import SitesPanel from "./SitesPanel.vue";
import MemoBlock from "./memo-block.js";
import { use_workflow_library } from "./workflow-library.js";
import { use_invited_rooms } from "./external-members.js";
import { use_analytics_page } from "./analytics-state.js";
import { locale, t } from "./i18n.js";
import { expired_label } from "./sites.js";

const emit = defineEmits(["select", "manage", "create", "create-folder", "manage-folder", "delete-folder", "archive-folder", "archives", "destructions"]);
const { view, bridge, act, is_running } = inject("discussion");
// While the workflow page, analytics page or an invited room fills the middle, no room row is shown as the open one.
const { page_open: workflow_library_open } = use_workflow_library();
const { page_open: invited_open } = use_invited_rooms();
const { page_open: analytics_open } = use_analytics_page();
const middle_page = computed(() => workflow_library_open.value || invited_open.value || analytics_open.value);
const project_rooms = computed(() => view.value.rooms.filter((room) => !room.system_kind));
const rooms = computed(() => project_rooms.value.filter((room) => !room.archived));
const archived_count = computed(() => project_rooms.value.filter((room) => room.archived).length);
const children = computed(() => {
  const by_id = new Map(rooms.value.map(room => [room.id, room]));
  const groups = new Map();
  for (const room of rooms.value) {
    const parent = room.detached ? null : by_id.get(room.parent_room_id);
    if (!parent || parent.id === room.id || (parent.folder_id || "") !== (room.folder_id || "")) continue;
    if (!groups.has(parent.id)) groups.set(parent.id, []);
    groups.get(parent.id).push(room);
  }
  return groups;
});
const mounted = computed(() => new Set([...children.value.values()].flat().map(room => room.id)));
const open_room_running = computed(() => (view.value.room?.free?.members || [])
  .some((member) => ["dispatched", "started"].includes(member.execution?.status)));
const branches = computed(() => {
  const result = new Map();
  function visit(room) {
    const group = children.value.get(room.id) || [];
    const descendants = group.map(visit);
    const branch = { running: room_running(room) || descendants.some(item => item.running),
      selected: room.id === view.value.room?.id || descendants.some(item => item.selected),
      time: Math.max(Date.parse(room_speech_at(room) || room.created_at) || 0, ...descendants.map(item => item.time)) };
    result.set(room.id, branch);
    return branch;
  }
  rooms.value.filter(room => !mounted.value.has(room.id)).forEach(visit);
  return result;
});
watch([children, branches], () => {
  if (!rooms.value.length && view.value.rooms_loading) return;
  for (const [parent, group] of children.value) {
    if (folded_parents.has(parent)) continue;
    if (group.some(room => branches.value.get(room.id)?.running || branches.value.get(room.id)?.selected
      || (known_children && !known_children.has(room.id)))) open_parents.value.add(parent);
  }
  if (rooms.value.length || known_children) known_children = mounted.value;
}, { immediate: true });
function toggle_parent(id) {
  if (open_parents.value.delete(id)) folded_parents.add(id);
  else { folded_parents.delete(id); open_parents.value.add(id); }
}
const folders = computed(() => (view.value.folder_groups || []).map((folder) => ({ ...folder,
  rooms: rooms.value.filter((room) => (room.folder_id || "") === folder.id) })));
const manual_order = computed(() => view.value.directory_sort !== "recent");
const source = computed(() => view.value.room_source || {});
// A website that keeps no rooms of its own lists the paired computer's, and says why while it cannot.
const directory_title = computed(() => {
  if (!source.value.computer) return t("协作房间");
  if (!source.value.signed_in) return t("协作房间（未配对）");
  if (!source.value.remote) return source.value.online === false ? t("协作房间（电脑离线）") : t("协作房间（电脑未连接）");
  return source.value.online === false ? t("协作房间（电脑离线）") : t("协作房间");
});
const directory_actions = computed(() => [
  { label: t("对话排列方式"), type: "label" },
  ...[{ value: "manual", label: t("手动排序") }, { value: "recent", label: t("最近发言") }].map((item) => ({
    label: item.label, type: "checkbox", checked: (view.value.directory_sort || "manual") === item.value,
    onSelect: () => act("sort_directory", item.value),
  })),
  { type: "separator" },
  { label: t("导入房间"), icon: "i-lucide-download", disabled: view.value.backup_pending, onSelect: () => choose_import_target(null) },
  { label: t("导出全部房间"), icon: "i-lucide-upload", disabled: view.value.backup_pending || !project_rooms.value.length,
    onSelect: () => act("backup_rooms", { ids: project_rooms.value.map((room) => room.id), name: t("全部房间") }) },
  { label: t("销毁记录"), icon: "i-lucide-flame", onSelect: () => emit("destructions") },
]);
const import_input = ref(null);
const import_open = ref(false);
let import_folder = null;

/** Open the backup picker for rooms that should land in one folder, or unfiled when null. */
function choose_import_target(folder_id) {
  import_folder = folder_id;
  import_input.value?.click();
}

/** Hand the chosen backup files to the controller, then clear the input so the same file can be chosen again. */
function choose_imports(event) {
  const files = [...event.target.files];
  event.target.value = "";
  if (!files.length) return;
  import_open.value = true;
  act("import_rooms", { files, folder_id: import_folder });
}
/** The latest message from the owner or a member; a computer not yet updated only reports the latest of any kind. */
function room_speech_at(room) {
  return room.latest_speech_at === undefined ? room.latest_at : room.latest_speech_at;
}

/** Short relative last-activity label ("3小时前"); falls back to creation time. */
function room_time(room) {
  const time = new Date(room_speech_at(room) || room.created_at || "").getTime();
  if (Number.isNaN(time)) return "";
  const minutes = Math.max(0, Math.floor((Date.now() - time) / 60000));
  const days = Math.floor(minutes / 1440);
  if (minutes < 1) return t("刚刚");
  if (minutes < 60) return t("{count}分钟前", { count: minutes });
  if (minutes < 1440) return t("{count}小时前", { count: Math.floor(minutes / 60) });
  if (days < 7) return t("{count}天前", { count: days });
  if (days < 30) return t("{count}周前", { count: Math.floor(days / 7) });
  if (days < 365) return t("{count}个月前", { count: Math.floor(days / 30) });
  return t("{count}年前", { count: Math.floor(days / 365) });
}

/** Full timestamps for the row tooltip. */
function room_time_title(room) {
  const format = (value) => new Date(value).toLocaleString("zh-CN", { hour12: false });
  return [room.title, room_speech_at(room) && t("最近发言 {time}", { time: format(room_speech_at(room)) }), room.created_at && t("创建于 {time}", { time: format(room.created_at) })]
    .filter(Boolean).join("\n");
}
// Everything a room row and its menus read besides the room itself, so a row re-renders only when this, the room or its
// time label changes rather than on every view publish.
const row_state = computed(() => JSON.stringify([view.value.directory_pending, view.value.archive_pending, view.value.destroying, view.value.backup_pending,
  view.value.folders, view.value.room_site, manual_order.value, view.value.room?.id, middle_page.value, open_room_running.value]));
/**
 * Plain values for one room row. They are read here, in the row's own render, because the menu and tooltip slots are run
 * by those components, which would otherwise track the view and re-render every row on each publish.
 */
/**
 * A create or start request whose result never came back (say the computer was offline), kept in this browser: listed
 * as a room that did not get made, like a message that failed to send; its menu retries the same request (no second
 * room), opens the room when one is known, or drops the record (user 2026-11-18, replacing the banner over every room).
 */
function recovery_items(item) {
  const busy = is_running("resume_launch") || is_running("discard_launch");
  return [[
    { label: t("重试"), icon: "i-lucide-rotate-cw", disabled: busy, onSelect: () => act("resume_launch", item.id) },
    ...(item.room_id ? [{ label: t("查看房间"), icon: "i-lucide-arrow-right", onSelect: () => emit("select", item.room_id) }] : []),
    { label: t("删除记录"), icon: "i-lucide-trash-2", disabled: busy, onSelect: () => act("discard_launch", item.id) },
  ]];
}

// The request still in flight is saved as a record too, but it shows as the room being created until its result is known.
const unconfirmed_launches = computed(() => view.value.launch.recoveries.filter((item) => item.id !== view.value.creating_room?.submission_id));

function room_row(room, index, count) {
  return { items: actions(room), active: !middle_page.value && room.id === view.value.room?.id,
    archiving: view.value.archive_pending.includes(room.id), time: room_time(room), title: room_time_title(room),
    running: room_running(room), destroying: view.value.destroying.includes(room.id) };
}
/** Whether a room is at work; the open room's own live state is the fresher one. */
function room_running(room) {
  return room.id === view.value.room?.id ? open_room_running.value : Boolean(room.running);
}
/** How many of a folder's latest rooms are listed now. */
function listed_count(id) {
  return listed_counts.value.get(id) || ROOM_BATCH_COUNT;
}
/** The rooms a folder lists now: all of them in manual order, else the latest ones opened so far plus any at work or open. */
function visible_rooms(folder) {
  const roots = top_rooms(folder);
  if (manual_order.value) return roots;
  return roots.filter((room, index) => index < listed_count(folder.id) || branches.value.get(room.id).running || branches.value.get(room.id).selected);
}
function top_rooms(folder) {
  const roots = folder.rooms.filter(room => !mounted.value.has(room.id));
  return manual_order.value ? roots : roots.sort((a,b) => branches.value.get(b.id).time - branches.value.get(a.id).time);
}
function directory_rows(folder) {
  const rows = [];
  function append(group, depth) {
    group.forEach((room, index) => {
      const kids = children.value.get(room.id) || [];
      const expanded = open_parents.value.has(room.id);
      const label = kids.length && (expanded ? t("收起子房间") : t("展开 {count} 个子房间", { count: kids.length }));
      const folded = kids.length && !expanded;
      rows.push({ room, index, count: group.length, depth, expanded, label,
        highlight: folded && !middle_page.value && branches.value.get(room.id).selected,
        running: folded && branches.value.get(room.id).running });
      if (expanded) append(kids, depth + 1);
    });
  }
  append(visible_rooms(folder), 0);
  return rows;
}
/** The label of a folder's show-more control, empty when the folder has nothing to fold. */
function list_toggle_label(folder) {
  if (manual_order.value || top_rooms(folder).length <= ROOM_BATCH_COUNT) return "";
  if (top_rooms(folder).length > visible_rooms(folder).length) return t("显示更多");
  return listed_count(folder.id) > ROOM_BATCH_COUNT ? t("收起") : "";
}
/** Reveal the next batch of hidden rooms, or fold back to the first batch once none are hidden. */
function toggle_room_list(folder) {
  const next = new Map(listed_counts.value);
  const visible = new Set(visible_rooms(folder));
  const hidden = top_rooms(folder).flatMap((room, index) => (visible.has(room) ? [] : [index]));
  if (hidden.length) next.set(folder.id, hidden[Math.min(ROOM_BATCH_COUNT, hidden.length) - 1] + 1);
  else next.delete(folder.id);
  listed_counts.value = next;
}
/** Plain values for one folder's heading row, and the key it re-renders on; read here for the same reason as room_row. */
function folder_head(folder, index) {
  const items = folder.id ? folder_actions(folder, index) : [];
  const head = { items, collapsed: !folder_open(folder.id), active: view.value.room?.folder_id === folder.id,
    creating: view.value.directory_pending.includes("create-room"), running: !folder_open(folder.id) && folder.rooms.some((room) => room_running(room)) };
  head.key = JSON.stringify([folder, head.collapsed, head.active, head.creating, head.running, items.map((group) => group.map((item) => [item.label, item.disabled]))]);
  return head;
}
// Folders stay as the user left them. Opening a room whose folder is closed opens that folder once; nothing is ever
// closed for the user. The key is a string, so the many view updates that leave the room as it was change nothing:
// a list compared each time looked new on every poll and reopened a folder the user had just closed.
const expanded = open_folders;
watch(() => `${view.value.room?.id || ""}
${view.value.room?.folder_id || ""}`, (key) => {
  const folder = view.value.room?.folder_id;
  if (!folder || key === revealed_for) return;
  revealed_for = key;
  if (expanded.value.has(folder)) return;
  expanded.value = new Set([...expanded.value, folder]);
}, { immediate: true });
// A room being created in a closed folder is shown the same way.
watch(() => view.value.creating_room?.folder_id, (folder) => {
  if (folder && !expanded.value.has(folder)) expanded.value = new Set([...expanded.value, folder]);
});
/** Whether one folder's rooms are shown; the unfiled group is always shown. */
function folder_open(id) { return !id || expanded.value.has(id); }

/** Keep folder editing and keyboard-equivalent movement on the folder's own menu. */
function folder_actions(folder, index) {
  const ordering = view.value.directory_pending.includes("folder-order") || view.value.directory_pending.includes("create-folder");
  return [...(folder.id ? [[{ label: t("编辑"), icon: "i-lucide-pencil", disabled: folder.pending || view.value.directory_pending.includes(`folder-name:${folder.id}`), onSelect: () => emit("manage-folder", folder) }]] : []), [
    { label: t("上移"), icon: "i-lucide-arrow-up", disabled: ordering || index === 0, onSelect: () => act("move_folder", { id: folder.order_id, direction: -1 }) },
    { label: t("下移"), icon: "i-lucide-arrow-down", disabled: ordering || index === folders.value.length - 1, onSelect: () => act("move_folder", { id: folder.order_id, direction: 1 }) },
  ], [{ label: t("导入房间"), icon: "i-lucide-download", disabled: folder.pending || view.value.backup_pending, onSelect: () => choose_import_target(folder.id || null) },
    folder_export(folder)], ...(folder.id ? [[{ label: t("存档文件夹"), icon: "i-lucide-archive",
    disabled: folder.pending || !folder.rooms.length || folder.rooms.some(room => view.value.archive_pending.includes(room.id)),
    onSelect: () => emit("archive-folder", folder) }, { label: t("移除文件夹"), icon: "i-lucide-folder-minus",
    disabled: folder.pending || ordering || view.value.directory_pending.includes(`folder-name:${folder.id}`)
      || view.value.creating_room?.folder_id === folder.id
      || view.value.rooms.some(room => room.folder_id === folder.id && view.value.folder_pending.includes(room.id)),
    onSelect: () => emit("delete-folder", folder) }]] : [])];
}

/** Export every channel filed in a folder, archived ones included. */
function folder_export(folder) {
  const ids = project_rooms.value.filter((room) => (room.folder_id || "") === folder.id).map((room) => room.id);
  return { label: t("导出文件夹"), icon: "i-lucide-upload", disabled: view.value.backup_pending || !ids.length,
    onSelect: () => act("backup_rooms", { ids, name: folder.name || t("未分组") }) };
}

/** Open or close one folder for this page load; closing it also folds its list back to the first batch. */
function toggle_folder(id) {
  const next = new Set(expanded.value);
  if (folder_open(id)) {
    next.delete(id);
    const counts = new Map(listed_counts.value);
    counts.delete(id);
    listed_counts.value = counts;
  } else next.add(id);
  expanded.value = next;
}

// Every room with a live share link, for the "shared" list: newest expiry last.
const shares_open = ref(false);
const shared_rooms = computed(() => project_rooms.value.filter((room) => view.value.share_links?.[room.id])
  .map((room) => ({ ...room, share_link: view.value.share_links[room.id] }))
  .sort((a, b) => Date.parse(a.share_link.expires_at) - Date.parse(b.share_link.expires_at)));
const jobs = computed(() => (view.value.managed_share_jobs || []).filter(job => job.phase !== "published"));
const active_job = computed(() => jobs.value.find(job => ["preparing","publishing"].includes(job.phase)));
function phase_label(job) {
  switch (job.phase) {
    case "preparing": return t("整理中");
    case "publishing": return t("上传 {done}/{total}", job.progress);
    case "ready": return t("待确认");
    case "failed": return t("失败");
    case "cancelled": return t("已取消");
    case "published": return t("已发布");
  }
}
const share_badge = computed(() => {
  if (active_job.value) return phase_label(active_job.value);
  const pending = jobs.value.filter(job => job.phase === "ready").length;
  const failed = jobs.value.filter(job => job.phase === "failed").length;
  return [pending && t("{count} 待确认", { count: pending }), failed && t("{count} 失败", { count: failed })].filter(Boolean).join(" · ") || shared_rooms.value.length || jobs.value.length;
});
function job_action(op, job) {
  if (op === "open") { shares_open.value = false; emit("manage", { action: "share_job_action", job }); }
  else act("share_job_action", { op, job });
}
watch(shares_open, open => { if (open) act("share_job_refresh"); });
watch(() => shared_rooms.value.length + jobs.value.length, count => { if (!count) shares_open.value = false; });
// Under a day left is marked so the owner sees which links are about to go.
const SOON_MS = 24 * 3600 * 1000;
const expires_soon = (link) => Date.parse(link.expires_at) - Date.now() < SOON_MS;
/** "Expires in 2 days 3 hours", or "in 5 hours" under a day. */
function expiry_label(link) {
  if (link.expired) return expired_label();
  const hours = Math.max(0, Math.round((Date.parse(link.expires_at) - Date.now()) / 3600000));
  return hours >= 24 ? t("{days} 天 {hours} 小时后过期", { days: Math.floor(hours / 24), hours: hours % 24 }) : t("{hours} 小时后过期", { hours });
}
// The longest a link lives, for the bar that shows how much of it is left.
const SHARE_MAX_DAYS = 7;
/** How much of the longest lifetime a link has left, in percent. */
const life_left = (link) => Math.max(2, Math.min(100, (Date.parse(link.expires_at) - Date.now()) / (SHARE_MAX_DAYS * 24 * 3600 * 1000) * 100));
/** Renewal choices: the link lives this many days from now. */
const renew_items = (room) => [(view.value.share_days || [1, 3, 7]).map((days) => ({ label: t("从现在起 {count} 天（到 {time}）", { count: days, time: new Date(Date.now() + days * 24 * 3600 * 1000).toLocaleString(locale, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) }), onSelect: () => act("share_renew", { room_id: room.id, days }) }))];
// The room whose published link waits for the owner to confirm revoking it.
const revoking = ref(null);
/** A room's published link, if this browser published one: { url, expires_at }. */
const share_link = (room) => view.value.share_links?.[room.id] || null;

// The room whose name is being edited in place, and the typed name. The menu's 重命名 and a desktop double-click both start it.
const renaming_id = ref(""), rename_text = ref(""), rename_input = ref(null);
// Room names stay within 80 characters, the same limit as the topic form's name field.
const ROOM_TITLE_MAX = 80;
const set_rename_input = (element) => { rename_input.value = element; };
const can_rename = (room) => !view.value.directory_pending.includes(`rename:${room.id}`);

/** Turn the room's name into a field holding it, all selected. */
async function start_rename(room) {
  if (!can_rename(room)) return;
  rename_text.value = room.title;
  renaming_id.value = room.id;
  await nextTick();
  rename_input.value?.focus();
  rename_input.value?.select();
}

/** Save a changed, non-empty name (shown at once, put back with a notice if the site refuses); otherwise keep the old one. */
function commit_rename(room) {
  if (renaming_id.value !== room.id) return;
  renaming_id.value = "";
  const title = rename_text.value.trim();
  if (title && title !== room.title) act("manage_channel", { id: room.id, action: "rename", title });
}

/** Enter saves, except the Enter that confirms an input-method candidate. */
function rename_enter(event, room) {
  if (event.isComposing) return;
  event.preventDefault();
  commit_rename(room);
}

/** A menu that started the rename gives focus back to its trigger on closing; the name field keeps it instead. */
function keep_rename_focus(event) {
  if (renaming_id.value) event.preventDefault();
}

/** A second desktop mouse click renames the room in place; touch keeps a plain tap. */
function select_room(event, room) {
  if (event.detail === 2 && window.matchMedia("(hover: hover) and (pointer: fine)").matches &&
      (!event.pointerType || event.pointerType === "mouse") && !event.sourceCapabilities?.firesTouchEvents) {
    start_rename(room);
    return;
  }
  emit("select", room.id);
}

/** Keep actions targeted to the clicked channel without changing the open draft. */
function actions(room) {
  return [[
    { label: t("重命名"), icon: "i-lucide-pencil", disabled: !can_rename(room), onSelect: () => start_rename(room) },
    { label: t("分享"), icon: "i-lucide-share-2", children: [
      { label: t("分享房间"), icon: "i-lucide-share-2", onSelect: () => emit("manage", { room, action: "share_prepare" }) },
      { label: t("AI 制作分享卡"), icon: "i-lucide-sparkles", onSelect: () => bridge.request_steward("share-card", { room_id: room.id }) },
      ...(share_link(room) ? [...(share_link(room).expired ? [] : [{ label: t("复制分享链接"), icon: "i-lucide-link-2", onSelect: () => act("share_copy", room.id) }]),
        { label: t("撤销分享链接"), icon: "i-lucide-link-2-off", onSelect: () => { revoking.value = room; } }] : []),
      { label: t("导出对话"), icon: "i-lucide-upload", disabled: view.value.backup_pending, onSelect: () => act("backup", room.id) },
    ] },
  ], [
    { label: t("移至文件夹"), icon: "i-lucide-folder-input", disabled: (!room.folder_id && !view.value.folders?.length), children: [
      { label: t("移出文件夹"), icon: "i-lucide-folder-minus", disabled: !room.folder_id, onSelect: () => act("manage_channel", { id: room.id, action: "folder", folder_id: null }) },
      ...(view.value.folders || []).map((folder) => ({ label: folder.name, icon: "i-lucide-folder", disabled: folder.pending || room.folder_id === folder.id, onSelect: () => act("manage_channel", { id: room.id, action: "folder", folder_id: folder.id }) })),
    ] },
    ...(room.parent_room_id ? [room.detached
      ? { label: t("放回父房间"), icon: "i-lucide-corner-down-right", onSelect: () => act("manage_channel", { id: room.id, action: "detach", detached: false }) }
      : { label: t("设为独立房间"), icon: "i-lucide-corner-up-left", onSelect: () => act("manage_channel", { id: room.id, action: "detach", detached: true }) }] : []),
    { label: room.pinned ? t("取消固定") : t("固定房间"), icon: room.pinned ? "i-lucide-pin-off" : "i-lucide-pin", disabled: view.value.directory_pending.includes(`pin:${room.id}`), onSelect: () => act("manage_channel", { id: room.id, action: "pin", pinned: !room.pinned }) },
  ], [
    { label: room.archived ? t("恢复房间") : t("存档房间"), icon: room.archived ? "i-lucide-archive-restore" : "i-lucide-archive", disabled: view.value.archive_pending.includes(room.id) || (!room.archived && room.pinned), onSelect: () => emit("manage", { room, action: room.archived ? "restore" : "archive" }) },
    { label: t("销毁房间"), icon: "i-lucide-flame", color: "error", disabled: view.value.directory_pending.includes(`rename:${room.id}`) || room.pinned, onSelect: () => emit("manage", { room, action: "delete" }) },
  ]];
}

</script>

<template>
  <div class="channel-directory-manager">
    <UButton :label="t('新建房间')" icon="i-lucide-plus" color="neutral" class="channel-primary-button channel-new-conversation" :disabled="view.directory_pending.includes('create-room')" @click="emit('create', null)" />
    <div class="channel-directory-heading">
      <button type="button" class="channel-section-toggle" :aria-expanded="rooms_open" @click="rooms_open = !rooms_open"><UIcon :name="rooms_open ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" />{{ directory_title }}</button>
      <div class="channel-directory-actions">
        <UTooltip :text="t('新建文件夹')"><UButton icon="i-lucide-folder-plus" color="neutral" variant="ghost" size="xs" :aria-label="t('新建文件夹')" :disabled="view.directory_pending.includes('create-folder')" @click="emit('create-folder')" /></UTooltip>
        <UDropdownMenu :items="directory_actions" :content="{ align: 'end', sideOffset: 4 }" :ui="{ content: 'channel-menu channel-directory-menu' }"><UButton icon="i-lucide-ellipsis" :aria-label="t('房间目录选项')" :title="t('排列、导入与导出')" size="xs" color="neutral" variant="ghost" /></UDropdownMenu>
        <input ref="import_input" type="file" accept=".zip,.json" multiple hidden :aria-label="t('选择房间备份')" @change="choose_imports">
      </div>
    </div>
    <nav v-show="rooms_open" :aria-label="t('协作房间列表')" class="channel-room-list" :class="{ 'is-recent': !manual_order }" data-room-directory>
      <div v-for="item in unconfirmed_launches" :key="`launch-${item.id}`" class="channel-room-row channel-room-unconfirmed">
        <UIcon name="i-lucide-circle-alert" class="channel-room-alert" />
        <UDropdownMenu :items="recovery_items(item)" :content="{ align: 'start', side: 'bottom', sideOffset: 6 }" :ui="{ content: 'channel-menu channel-topic-menu' }">
          <button type="button" class="channel-room-select" :title="item.error || t('结果未确认，点击重试或删除记录')"><span>{{ item.title }}</span><small class="channel-room-time">{{ t("未确认") }}</small></button>
        </UDropdownMenu>
      </div>
      <section v-for="(folder, folder_index) in folders" :key="folder.order_id" class="channel-folder-section" :data-room-folder="folder.id" :data-drag-folder="folder.order_id">
       <template v-for="head in [folder_head(folder, folder_index)]" :key="folder.order_id">
       <MemoBlock v-if="folder.id" :deps="[head.key]">
       <UContextMenu :items="head.items" :ui="{ content: 'channel-menu channel-topic-menu' }">
       <div class="channel-folder-row" :class="{ active: head.collapsed && head.active }">
       <button class="channel-folder-heading" data-drop-folder data-drag-handle type="button" :disabled="folder.pending" :aria-label="folder.name" :aria-expanded="!head.collapsed" :title="t('拖动文件夹排序；上下方向键移动')" @pointerdown="bridge.start_drag($event)" @keydown.up.prevent="act('move_folder', { id: folder.order_id, direction: -1 })" @keydown.down.prevent="act('move_folder', { id: folder.order_id, direction: 1 })" @click="toggle_folder(folder.id)"><UIcon :name="head.collapsed ? 'i-lucide-chevron-right' : 'i-lucide-chevron-down'" /><UIcon name="i-lucide-folder" /><span class="channel-folder-name">{{ folder.name }}</span><i v-if="head.running && !folder.pending" class="channel-room-running" :title="t('正在执行')" /><small v-else-if="folder.pending" class="channel-directory-count" aria-hidden="true">{{ t('保存中') }}</small></button>
        <div class="channel-folder-actions">
          <UTooltip :text="t('在{name}中新建房间', { name: folder.name })"><UButton icon="i-lucide-plus" :aria-label="t('在{name}中新建房间', { name: folder.name })" :disabled="folder.pending || head.creating" size="xs" color="neutral" variant="ghost" @click="emit('create', folder.id ? folder : null)" /></UTooltip>
          <UDropdownMenu :items="head.items" :content="{ align: 'start', side: 'bottom', sideOffset: 6 }" :ui="{ content: 'channel-menu channel-topic-menu' }"><UButton icon="i-lucide-ellipsis" :aria-label="t('管理文件夹 {name}', { name: folder.name })" :title="t('文件夹选项')" size="xs" color="neutral" variant="ghost" /></UDropdownMenu>
        </div>
       </div>
       </UContextMenu>
       </MemoBlock>
       </template>
       <div v-if="folder_open(folder.id)" :class="folder.id ? 'channel-folder-rooms' : 'channel-root-rooms'" :data-drop-folder="folder.id ? undefined : ''">
      <MemoBlock v-for="{ room, index, count, depth, expanded, label, highlight, running } in directory_rows(folder)" :key="room.id" :deps="[JSON.stringify(room), index, count, depth, expanded, label, highlight, running, row_state, room_time(room), Boolean(share_link(room)), renaming_id === room.id]">
      <template v-for="row in [room_row(room, index, count)]" :key="room.id">
      <UContextMenu :items="row.items" :content="{ onCloseAutoFocus: keep_rename_focus }" :ui="{ content: 'channel-menu channel-topic-menu' }">
        <div class="channel-room-row" :class="{ active: row.active || highlight, 'is-destroying': row.destroying}" :style="{ marginInlineStart: depth ? `calc(${depth} * var(--channel-nav-text, 13px))` : undefined }" :data-drag-room="room.id" :inert="row.destroying || undefined">
          <button class="channel-room-grip" data-drag-handle :aria-label="t('拖动 {name}', { name: room.title })" :title="t('拖动排序；上下方向键移动')"  @pointerdown="bridge.start_drag($event)" @keydown.up.prevent="act('move_channel', { id: room.id, direction: -1, folder_id: room.folder_id || null })" @keydown.down.prevent="act('move_channel', { id: room.id, direction: 1, folder_id: room.folder_id || null })"><UIcon name="i-lucide-grip-vertical" /></button>
          <div class="channel-room-content"><UTooltip v-if="label" :text="label" :ui="{ content: 'channel-topic-tooltip' }"><button class="channel-child-toggle" type="button" :aria-expanded="expanded" :aria-label="label" @click.stop="toggle_parent(room.id)"><UIcon :name="expanded ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" /></button></UTooltip><span v-if="renaming_id === room.id" class="channel-room-rename"><input :ref="set_rename_input" v-model="rename_text" :maxlength="ROOM_TITLE_MAX" :aria-label="t('{name} 的新名称', { name: room.title })" autocomplete="off"
            @keydown.enter="rename_enter($event, room)" @keydown.esc.prevent.stop="renaming_id = ''" @blur="commit_rename(room)" @click.stop @dblclick.stop @contextmenu.stop /></span><button v-else class="channel-room-select" data-drag-title :title="row.title" :aria-label="room.title" :aria-current="row.active ? 'page' : undefined" @pointerdown="bridge.start_drag($event)" @click="select_room($event, room)"><span class="channel-room-name"><span>{{ room.title }}</span><small class="channel-room-count">{{ room.message_count ?? 0 }}</small><UIcon v-if="room.pinned" name="i-lucide-pin" class="channel-room-pin" :aria-label="t('已固定')" /></span><i v-if="row.running || running" class="channel-room-running" :title="t('正在执行')" /><small v-else class="channel-room-time" aria-hidden="true">{{ row.time }}</small></button></div>
          <div class="channel-room-actions">
            <UTooltip :text="room.archived ? t('恢复房间') : room.pinned ? t('已固定的房间不能存档') : t('存档房间')" :ui="{ content: 'channel-topic-tooltip' }">
              <UButton :icon="room.archived ? 'i-lucide-archive-restore' : 'i-lucide-archive'" :aria-label="room.archived ? t('恢复 {name}', { name: room.title }) : t('存档 {name}', { name: room.title })" class="channel-room-archive" size="xs" color="neutral" variant="ghost" :disabled="row.archiving || (!room.archived && room.pinned)" @click="emit('manage', { room, action: room.archived ? 'restore' : 'archive' })" />
            </UTooltip>
            <UDropdownMenu :items="row.items" :content="{ align: 'start', side: 'bottom', sideOffset: 6, onCloseAutoFocus: keep_rename_focus }" :ui="{ content: 'channel-menu channel-topic-menu' }"><UButton icon="i-lucide-ellipsis" :aria-label="t('管理 {name}', { name: room.title })" :title="t('更多操作')" size="xs" color="neutral" variant="ghost" /></UDropdownMenu>
          </div>
        </div>
      </UContextMenu>
      </template>
      </MemoBlock>
      <button v-if="list_toggle_label(folder)" type="button" class="channel-room-more" @click="toggle_room_list(folder)">{{ list_toggle_label(folder) }}</button>
      <div v-if="view.creating_room && (view.creating_room.folder_id || '') === folder.id" class="channel-room-row channel-room-creating" :class="{ active: view.creating_room.opened && !view.room?.id }" role="status" :aria-label="t('正在创建：{name}', { name: view.creating_room.title })">
        <span aria-hidden="true"></span>
        <span class="channel-room-select"><span>{{ view.creating_room.title }}</span><UIcon name="i-lucide-loader-circle" class="animate-spin" /></span>
      </div>
       </div>
      </section>
      <p v-if="!rooms.length" class="channel-directory-empty">{{ view.rooms_loading ? t("正在读取房间…") : t("暂无协作房间") }}</p>
    </nav>
    <UButton v-show="rooms_open" icon="i-lucide-archive" color="neutral" variant="ghost" class="channel-archive-toggle" aria-haspopup="dialog" @click="emit('archives')"><span class="channel-archive-label">{{ t("已存档") }}</span><small v-if="archived_count" class="channel-archive-count">{{ archived_count }}</small></UButton>
    <UButton v-show="rooms_open && (shared_rooms.length || jobs.length)" :icon="active_job ? 'i-lucide-loader-circle' : 'i-lucide-share-2'" :ui="{ leadingIcon: active_job ? 'animate-spin' : '' }" color="neutral" variant="ghost" class="channel-archive-toggle" aria-haspopup="dialog" @click="shares_open = true"><span class="channel-archive-label">{{ t("已分享") }}</span><small class="channel-archive-count">{{ share_badge }}</small></UButton>
    <SitesPanel :visible="rooms_open" />
    <UModal v-model:open="shares_open" :title="t('已分享的房间')" :description="t('过期后仍可续期恢复原链接。续期只延长时间，内容不变；要换成最新内容，在房间菜单里重新分享。')"
      :ui="{ content: 'glass-panel studio-modal channel-folder-modal channel-manage-modal share-dialog', body: 'dialog-body' }">
      <template #body>
        <section v-if="jobs.length" class="share-jobs">
          <h3>{{ t("分享任务") }}</h3>
          <article v-for="job in jobs" :key="job.id" class="share-job">
            <div class="share-job-title"><strong>{{ job.room_title }}</strong><span>{{ phase_label(job) }}</span></div>
            <template v-if="job.phase === 'publishing'">
              <progress :value="job.progress.bytes_done" :max="job.progress.bytes_total || 1" :aria-label="t('上传进度')" />
              <small>{{ bridge.attachment_size(job.progress.bytes_done) }} / {{ bridge.attachment_size(job.progress.bytes_total) }}</small>
            </template>
            <p v-if="job.error" class="text-error">{{ job.error }}</p>
            <div class="share-job-actions">
              <UButton v-if="job.phase === 'ready'" size="xs" :label="t('打开确认')" @click="job_action('open', job)" />
              <UButton v-if="['ready','preparing','publishing'].includes(job.phase)" size="xs" color="neutral" variant="soft" :label="t('取消')" @click="job_action('cancel', job)" />
              <UButton v-if="['failed','cancelled'].includes(job.phase)" size="xs" :label="t('重试')" @click="job_action('retry', job)" />
              <UButton v-if="job.phase === 'failed' && job.adjustable" size="xs" color="neutral" variant="soft" :label="t('调整附件')" @click="job_action('open', job)" />
              <UButton v-if="['failed','cancelled','published'].includes(job.phase)" size="xs" color="neutral" variant="ghost" :label="t('清除')" @click="job_action('dismiss', job)" />
            </div>
          </article>
        </section>
        <ul class="shared-rooms">
          <li v-for="room in shared_rooms" :key="room.id" class="shared-room" :class="{ 'is-soon': expires_soon(room.share_link) }">
            <div class="shared-room-main">
              <strong :title="room.title">{{ room.title }}</strong>
              <a class="shared-room-url" :href="room.share_link.url" target="_blank" rel="noopener noreferrer" :title="room.share_link.url">{{ room.share_link.url.replace(/^https?:\/\//, "") }}</a>
            </div>
            <div class="shared-room-side">
              <span class="shared-room-expiry"><UIcon name="i-lucide-clock" />{{ expiry_label(room.share_link) }}</span>
              <div class="shared-room-actions">
                <UButton v-if="!room.share_link.expired" size="xs" color="neutral" variant="soft" :label="t('查看分享卡')" @click="shares_open = false; act('open_share_card', room.id)" />
                <UButton v-if="!jobs.some(job => job.room_id === room.id) && view.share_tasks?.[room.id]?.phase === 'publishing'" color="primary" size="xs" variant="soft"
                  :label="view.share_tasks[room.id].upload ? t('正在上传附件 {done}/{total}', view.share_tasks[room.id].upload) : t('正在上传…')"
                  @click="shares_open = false; emit('manage', { room, action: 'share_open' })" />
                <template v-if="!room.share_link.expired"><UTooltip :text="t('复制链接')"><UButton icon="i-lucide-copy" size="xs" color="neutral" variant="ghost" :aria-label="t('复制「{name}」的分享链接', { name: room.title })" @click="act('share_copy', room.id)" /></UTooltip>
                <UTooltip :text="t('打开分享页')"><UButton icon="i-lucide-external-link" size="xs" color="neutral" variant="ghost" :aria-label="t('打开「{name}」的分享页', { name: room.title })" :to="room.share_link.url" target="_blank" rel="noopener noreferrer" /></UTooltip></template>
                <UDropdownMenu :items="renew_items(room)" :content="{ align: 'start', sideOffset: 4 }" :ui="{ content: 'channel-menu' }">
                  <UButton icon="i-lucide-timer-reset" :label="t('续期')" size="xs" color="neutral" variant="soft" :aria-label="t('续期「{name}」的分享链接', { name: room.title })" /></UDropdownMenu>
                <UTooltip :text="t('撤销链接')"><UButton icon="i-lucide-link-2-off" size="xs" color="neutral" variant="ghost" class="shared-room-revoke" :aria-label="t('撤销「{name}」的分享链接', { name: room.title })" @click="revoking = room" /></UTooltip>
              </div>
            </div>
            <span class="shared-room-life" aria-hidden="true"><i :style="{ width: `${life_left(room.share_link)}%` }"></i></span>
          </li>
        </ul>
      </template>
    </UModal>
    <ImportDialog v-model:open="import_open" />
    <ConfirmDialog :open="Boolean(revoking)" :title="t('撤销「{name}」的分享链接', { name: revoking?.title || '' })" :description="t('分享站上的这份记录会立即删除，打开链接的人会看到“分享不存在”。')"
      :items="[t('已经下载的离线网页文件不受影响。')]" :confirm-label="t('撤销链接')" danger @update:open="(value) => { if (!value) revoking = null; }" @confirm="act('share_revoke', revoking.id)" />
  </div>
</template>

<style scoped>
.share-jobs { display: grid; gap: .65rem; margin-bottom: 1rem; }
.share-jobs h3 { font-weight: 600; }
.share-job { display: grid; gap: .35rem; border-bottom: 1px solid var(--ui-border); padding: .45rem 0 .7rem; }
.share-job-title, .share-job-actions { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
.share-job-title { justify-content: space-between; }
.share-job-title strong, .share-job p { overflow-wrap: anywhere; }
.share-job-title span, .share-job small { color: var(--ui-text-muted); }
.share-job progress { appearance: none; width: 100%; height: 6px; border: 0; border-radius: 999px; overflow: hidden; background: var(--ui-bg-accented); accent-color: var(--channel-accent, var(--ui-primary)); }
.share-job progress::-webkit-progress-bar { border-radius: 999px; background: var(--ui-bg-accented); }
.share-job progress::-webkit-progress-value { border-radius: 999px; background: var(--channel-accent, var(--ui-primary)); }
.share-job progress::-moz-progress-bar { border-radius: 999px; background: var(--channel-accent, var(--ui-primary)); }
.channel-room-alert { justify-self: center; width: 14px; height: 14px; color: var(--ui-error); }
</style>

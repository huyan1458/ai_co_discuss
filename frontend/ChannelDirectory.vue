<script>
import { ref as module_ref } from "vue";
// The folders open in this page load, kept outside the component: a phone's sidebar is a drawer mounted anew each time
// it opens, and keeping them inside it forgot them on every close (user 2026-11-16). A reload starts afresh with only
// the shown room's folder open (user 2026-11-15).
const open_folders = module_ref(new Set());
const rooms_open = module_ref(true);
// The room whose folder was last opened for it, so mounting the drawer again is not taken for opening that room.
let revealed_for = "";
// Sorted by recent activity, each folder first lists this many rooms, and each "show more" reveals this many again. How far
// the user has opened each folder survives the phone drawer being mounted anew, as open_folders does.
const ROOM_BATCH_COUNT = 5;
const listed_counts = module_ref(new Map());
</script>

<script setup>
import { computed, inject, ref, watch } from "vue";
import ImportDialog from "./ImportDialog.vue";
import ConfirmDialog from "./ConfirmDialog.vue";
import SitesPanel from "./SitesPanel.vue";
import MemoBlock from "./memo-block.js";
import { use_workflow_library } from "./workflow-library.js";
import { use_invited_rooms } from "./external-members.js";
import { locale, t } from "./i18n.js";
import { draw_share_card, share_card_blob } from "./share-card.js";

const emit = defineEmits(["select", "manage", "create", "create-folder", "manage-folder", "delete-folder", "archive-folder", "archives", "destructions"]);
const { view, bridge, act, pending } = inject("discussion");
// While the workflow page or an invited room fills the middle, no room row is shown as the open one.
const { page_open: workflow_library_open } = use_workflow_library();
const { page_open: invited_open } = use_invited_rooms();
const middle_page = computed(() => workflow_library_open.value || invited_open.value);
const rooms = computed(() => view.value.rooms.filter((room) => !room.archived));
const archived_count = computed(() => view.value.rooms.filter((room) => room.archived).length);
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
  { label: t("导出全部房间"), icon: "i-lucide-upload", disabled: view.value.backup_pending || !view.value.rooms.length,
    onSelect: () => act("backup_rooms", { ids: view.value.rooms.map((room) => room.id), name: t("全部房间") }) },
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
  view.value.folders, view.value.room_site, manual_order.value, view.value.room?.id, pending.value, middle_page.value, open_room_running.value]));
/** The open room's own live state is fresher than the directory's, so its light follows that. */
const open_room_running = computed(() => (view.value.room?.free?.members || [])
  .some((member) => ["dispatched", "started"].includes(member.execution?.status)));
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
  const busy = Boolean(pending.value);
  return [[
    { label: t("重试"), icon: "i-lucide-rotate-cw", disabled: busy, onSelect: () => act("resume_launch", item.id) },
    ...(item.room_id ? [{ label: t("查看房间"), icon: "i-lucide-arrow-right", onSelect: () => emit("select", item.room_id) }] : []),
    { label: t("删除记录"), icon: "i-lucide-trash-2", disabled: busy, onSelect: () => act("discard_launch", item.id) },
  ]];
}

// The request still in flight is saved as a record too, but it shows as the room being created until its result is known.
const unconfirmed_launches = computed(() => view.value.launch.recoveries.filter((item) => item.id !== view.value.creating_room?.submission_id));

function room_row(room, index, count) {
  return { items: actions(room, index, room.folder_id || null, count), active: !middle_page.value && room.id === view.value.room?.id, busy: Boolean(pending.value),
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
  if (manual_order.value) return folder.rooms;
  return folder.rooms.filter((room, index) => index < listed_count(folder.id) || room_running(room) || room.id === view.value.room?.id);
}
/** The label of a folder's show-more control, empty when the folder has nothing to fold. */
function list_toggle_label(folder) {
  if (manual_order.value || folder.rooms.length <= ROOM_BATCH_COUNT) return "";
  if (folder.rooms.length > visible_rooms(folder).length) return t("显示更多");
  return listed_count(folder.id) > ROOM_BATCH_COUNT ? t("收起") : "";
}
/** Reveal the next batch of hidden rooms, or fold back to the first batch once none are hidden. */
function toggle_room_list(folder) {
  const next = new Map(listed_counts.value);
  const visible = new Set(visible_rooms(folder));
  const hidden = folder.rooms.flatMap((room, index) => (visible.has(room) ? [] : [index]));
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
    { label: t("上移"), icon: "i-lucide-arrow-up", disabled: ordering || index === 0 || Boolean(pending.value), onSelect: () => act("move_folder", { id: folder.order_id, direction: -1 }) },
    { label: t("下移"), icon: "i-lucide-arrow-down", disabled: ordering || index === folders.value.length - 1 || Boolean(pending.value), onSelect: () => act("move_folder", { id: folder.order_id, direction: 1 }) },
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
  const ids = view.value.rooms.filter((room) => (room.folder_id || "") === folder.id).map((room) => room.id);
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

// The share page read and cleaned, waiting for the owner to confirm; what looks sensitive in it is listed first.
const SHARE_SPOTS_SHOWN = 6;
const share_draft = computed(() => view.value.share_draft);
// The title stays while the dialog fades out after the draft is gone.
const share_title = ref("");
watch(() => share_draft.value?.title, (title) => { if (title) share_title.value = title; });
const share_spots = computed(() => share_draft.value?.spots || []);
const share_phase = computed(() => share_draft.value?.phase || "");
const share_expiry = computed(() => share_draft.value?.link ? new Date(share_draft.value.link.expires_at).toLocaleString(locale, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) : "");
// The share card of a published link, drawn once the dialog shows it.
const card_canvas = ref(null);
// The two texts on the card are the owner's to adjust before the picture is saved or copied.
const card_text = ref({ question: "", outcome: "" });
watch(() => share_draft.value?.link?.card, (card) => { if (card) card_text.value = { question: card.question, outcome: card.outcome }; });
watch([() => share_draft.value?.link?.card, card_canvas, card_text], ([card, canvas, text]) => { if (card && canvas) draw_share_card(canvas, { ...card, ...text }); }, { deep: true });
/** Save the card as a PNG named after the room. */
async function save_card() {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(await share_card_blob(card_canvas.value));
  link.download = `${share_title.value.replace(/[\\/:*?"<>|]+/g, "_").slice(0, 60) || "share"}.png`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 60000);
}
// A copy button says it worked for a moment.
const COPIED_MS = 2000;
// Pictures reach the clipboard only where the browser offers it (not Firefox, not a plain-http address); elsewhere the button is left out.
const can_copy_image = typeof ClipboardItem !== "undefined" && Boolean(navigator.clipboard?.write);
const card_copied = ref(false);
/** Put the card on the clipboard as an image, for pasting straight into a chat. */
async function copy_card() {
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": share_card_blob(card_canvas.value) })]);
    card_copied.value = true;
    setTimeout(() => { card_copied.value = false; }, COPIED_MS);
  } catch { bridge.notify("warning", t("这个浏览器不能复制图片，请用“保存图片”。")); }
}
const copied_link = ref(false);
// Publishing already put the link on the clipboard, so the button opens saying so.
const link_copied = computed(() => copied_link.value || Boolean(share_draft.value?.link?.copied && !link_seen.value));
const link_seen = ref(false);
watch(() => share_draft.value?.link?.url, (url) => { link_seen.value = false; if (url) setTimeout(() => { link_seen.value = true; }, COPIED_MS * 2); });
async function copy_share_link() {
  await act("copy", share_draft.value.link.url);
  copied_link.value = true;
  setTimeout(() => { copied_link.value = false; }, COPIED_MS);
}
const share_spot_total = computed(() => share_spots.value.reduce((total, spot) => total + spot.count, 0));
// How long a published link lives; the share site keeps it at most seven days.
const share_days = ref(7);
const share_day_items = computed(() => (view.value.share_days || [1, 3, 7]).map((days) => ({ label: t("{count} 天后过期", { count: days }), value: days })));
/** Closing the dialog without choosing drops the prepared page. */
function close_share(open) {
  if (!open && share_draft.value) bridge.execute("share_cancel");
}
// Every room with a live share link, for the "shared" list: newest expiry last.
const shares_open = ref(false);
const shared_rooms = computed(() => view.value.rooms.filter((room) => view.value.share_links?.[room.id])
  .map((room) => ({ ...room, share_link: view.value.share_links[room.id] }))
  .sort((a, b) => Date.parse(a.share_link.expires_at) - Date.parse(b.share_link.expires_at)));
watch(() => shared_rooms.value.length, (count) => { if (!count) shares_open.value = false; });
// Under a day left is marked so the owner sees which links are about to go.
const SOON_MS = 24 * 3600 * 1000;
const expires_soon = (link) => Date.parse(link.expires_at) - Date.now() < SOON_MS;
/** "Expires in 2 days 3 hours", or "in 5 hours" under a day. */
function expiry_label(link) {
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

/** Keep actions targeted to the clicked channel without changing the open draft. */
function actions(room, index, folder_id, folder_room_count) {
  const ordering = view.value.directory_pending.includes("room-order");
  const current = room.id === view.value.room?.id;
  return [[
    { label: t("重命名"), icon: "i-lucide-pencil", disabled: view.value.directory_pending.includes(`rename:${room.id}`), onSelect: () => emit("manage", { room, action: "rename" }) },
    ...(current ? [{ label: t("编辑议题"), icon: "i-lucide-pencil", onSelect: () => emit("manage", { room, action: "edit" }) }] : []),
    { label: t("复制阅读入口"), icon: "i-lucide-link", onSelect: () => act("copy", `${view.value.room_site}/r/${encodeURIComponent(room.id)}`) },
    { label: t("导出对话"), icon: "i-lucide-upload", disabled: view.value.backup_pending || Boolean(pending.value), onSelect: () => act("backup", room.id) },
    { label: t("分享"), icon: "i-lucide-share-2", disabled: view.value.backup_pending || Boolean(pending.value), onSelect: () => act("share_prepare", room.id) },
    ...(share_link(room) ? [{ label: t("复制分享链接"), icon: "i-lucide-link-2", onSelect: () => act("share_copy", room.id) },
      { label: t("撤销分享链接"), icon: "i-lucide-link-2-off", disabled: view.value.backup_pending, onSelect: () => { revoking.value = room; } }] : []),
  ], ...(current ? [[{ label: t("刷新消息"), icon: "i-lucide-refresh-cw", onSelect: () => act("refresh") }]] : []), [
    { label: t("移至文件夹"), icon: "i-lucide-folder-input", disabled: Boolean(pending.value) || (!room.folder_id && !view.value.folders?.length), children: [
      { label: t("移出文件夹"), icon: "i-lucide-folder-minus", disabled: !room.folder_id, onSelect: () => act("manage_channel", { id: room.id, action: "folder", folder_id: null }) },
      ...(view.value.folders || []).map((folder) => ({ label: folder.name, icon: "i-lucide-folder", disabled: folder.pending || room.folder_id === folder.id, onSelect: () => act("manage_channel", { id: room.id, action: "folder", folder_id: folder.id }) })),
    ] },
  ], [
    { label: t("上移"), icon: "i-lucide-arrow-up", disabled: ordering || !manual_order.value || index === 0 || Boolean(pending.value), onSelect: () => act("move_channel", { id: room.id, direction: -1, folder_id }) },
    { label: t("下移"), icon: "i-lucide-arrow-down", disabled: ordering || !manual_order.value || index === folder_room_count - 1 || Boolean(pending.value), onSelect: () => act("move_channel", { id: room.id, direction: 1, folder_id }) },
  ], [
    { label: room.archived ? t("恢复房间") : t("存档房间"), icon: room.archived ? "i-lucide-archive-restore" : "i-lucide-archive", disabled: view.value.archive_pending.includes(room.id), onSelect: () => emit("manage", { room, action: room.archived ? "restore" : "archive" }) },
    { label: t("销毁房间"), icon: "i-lucide-flame", color: "error", disabled: view.value.directory_pending.includes(`rename:${room.id}`), onSelect: () => emit("manage", { room, action: "delete" }) },
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
       <div class="channel-folder-row" :class="{ active: head.collapsed && head.active }">
       <button class="channel-folder-heading" data-drop-folder data-drag-handle type="button" :disabled="folder.pending" :aria-label="folder.name" :aria-expanded="!head.collapsed" :title="t('拖动文件夹排序；上下方向键移动')" @pointerdown="!pending && bridge.start_drag($event)" @keydown.up.prevent="act('move_folder', { id: folder.order_id, direction: -1 })" @keydown.down.prevent="act('move_folder', { id: folder.order_id, direction: 1 })" @click="toggle_folder(folder.id)"><UIcon :name="head.collapsed ? 'i-lucide-chevron-right' : 'i-lucide-chevron-down'" /><UIcon name="i-lucide-folder" /><span class="channel-folder-name">{{ folder.name }}</span><i v-if="head.running && !folder.pending" class="channel-room-running" :title="t('正在执行')" /><small v-else-if="folder.pending" class="channel-directory-count" aria-hidden="true">{{ t('保存中') }}</small></button>
        <div class="channel-folder-actions">
          <UTooltip :text="t('在{name}中新建房间', { name: folder.name })"><UButton icon="i-lucide-plus" :aria-label="t('在{name}中新建房间', { name: folder.name })" :disabled="folder.pending || head.creating" size="xs" color="neutral" variant="ghost" @click="emit('create', folder.id ? folder : null)" /></UTooltip>
          <UDropdownMenu :items="head.items" :content="{ align: 'start', side: 'bottom', sideOffset: 6 }" :ui="{ content: 'channel-menu channel-topic-menu' }"><UButton icon="i-lucide-ellipsis" :aria-label="t('管理文件夹 {name}', { name: folder.name })" :title="t('文件夹选项')" size="xs" color="neutral" variant="ghost" /></UDropdownMenu>
        </div>
       </div>
       </MemoBlock>
       </template>
       <div v-if="folder_open(folder.id)" :class="folder.id ? 'channel-folder-rooms' : 'channel-root-rooms'" :data-drop-folder="folder.id ? undefined : ''">
      <MemoBlock v-for="(room, index) in visible_rooms(folder)" :key="room.id" :deps="[JSON.stringify(room), index, folder.rooms.length, row_state, room_time(room)]">
      <template v-for="row in [room_row(room, index, folder.rooms.length)]" :key="room.id">
      <UContextMenu :items="row.items" :ui="{ content: 'channel-menu channel-topic-menu' }">
        <div class="channel-room-row" :class="{ active: row.active, 'is-destroying': row.destroying }" :data-drag-room="room.id" :inert="row.destroying || undefined">
          <button class="channel-room-grip" data-drag-handle :aria-label="t('拖动 {name}', { name: room.title })" :title="t('拖动排序；上下方向键移动')" :disabled="row.busy" @pointerdown="bridge.start_drag($event)" @keydown.up.prevent="act('move_channel', { id: room.id, direction: -1, folder_id: room.folder_id || null })" @keydown.down.prevent="act('move_channel', { id: room.id, direction: 1, folder_id: room.folder_id || null })"><UIcon name="i-lucide-grip-vertical" /></button>
          <button class="channel-room-select" data-drag-title :title="row.title" :aria-label="room.title" :aria-current="row.active ? 'page' : undefined" @pointerdown="!pending && bridge.start_drag($event)" @click="emit('select', room.id)"><span>{{ room.title }}</span><i v-if="row.running" class="channel-room-running" :title="t('正在执行')" /><small v-else class="channel-room-time" aria-hidden="true">{{ row.time }}</small></button>
          <div class="channel-room-actions">
            <UTooltip :text="room.archived ? t('恢复房间') : t('存档房间')" :ui="{ content: 'channel-topic-tooltip' }">
              <UButton :icon="room.archived ? 'i-lucide-archive-restore' : 'i-lucide-archive'" :aria-label="room.archived ? t('恢复 {name}', { name: room.title }) : t('存档 {name}', { name: room.title })" class="channel-room-archive" size="xs" color="neutral" variant="ghost" :disabled="row.busy || row.archiving" @click="emit('manage', { room, action: room.archived ? 'restore' : 'archive' })" />
            </UTooltip>
            <UDropdownMenu :items="row.items" :content="{ align: 'start', side: 'bottom', sideOffset: 6 }" :ui="{ content: 'channel-menu channel-topic-menu' }"><UButton icon="i-lucide-ellipsis" :aria-label="t('管理 {name}', { name: room.title })" :title="t('更多操作')" size="xs" color="neutral" variant="ghost" /></UDropdownMenu>
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
    <UButton v-show="rooms_open && shared_rooms.length" icon="i-lucide-share-2" color="neutral" variant="ghost" class="channel-archive-toggle" aria-haspopup="dialog" @click="shares_open = true"><span class="channel-archive-label">{{ t("已分享") }}</span><small class="channel-archive-count">{{ shared_rooms.length }}</small></UButton>
    <SitesPanel :visible="rooms_open" />
    <UModal v-model:open="shares_open" :title="t('已分享的房间')" :description="t('到期自动删除。续期只延长时间，内容不变；要换成最新内容，在房间菜单里重新分享。')"
      :ui="{ content: 'glass-panel studio-modal channel-folder-modal channel-manage-modal share-dialog', body: 'dialog-body' }">
      <template #body>
        <ul class="shared-rooms">
          <li v-for="room in shared_rooms" :key="room.id" class="shared-room" :class="{ 'is-soon': expires_soon(room.share_link) }">
            <div class="shared-room-main">
              <strong :title="room.title">{{ room.title }}</strong>
              <a class="shared-room-url" :href="room.share_link.url" target="_blank" rel="noopener noreferrer" :title="room.share_link.url">{{ room.share_link.url.replace(/^https?:\/\//, "") }}</a>
            </div>
            <div class="shared-room-side">
              <span class="shared-room-expiry"><UIcon name="i-lucide-clock" />{{ expiry_label(room.share_link) }}</span>
              <div class="shared-room-actions">
                <UTooltip :text="t('复制链接')"><UButton icon="i-lucide-copy" size="xs" color="neutral" variant="ghost" :aria-label="t('复制「{name}」的分享链接', { name: room.title })" @click="act('share_copy', room.id)" /></UTooltip>
                <UTooltip :text="t('打开分享页')"><UButton icon="i-lucide-external-link" size="xs" color="neutral" variant="ghost" :aria-label="t('打开「{name}」的分享页', { name: room.title })" :to="room.share_link.url" target="_blank" rel="noopener noreferrer" /></UTooltip>
                <UDropdownMenu :items="renew_items(room)" :content="{ align: 'end', sideOffset: 4 }" :ui="{ content: 'channel-menu' }">
                  <UButton icon="i-lucide-timer-reset" :label="t('续期')" size="xs" color="neutral" variant="soft" :disabled="view.backup_pending" :aria-label="t('续期「{name}」的分享链接', { name: room.title })" /></UDropdownMenu>
                <UTooltip :text="t('撤销链接')"><UButton icon="i-lucide-link-2-off" size="xs" color="neutral" variant="ghost" class="shared-room-revoke" :disabled="view.backup_pending" :aria-label="t('撤销「{name}」的分享链接', { name: room.title })" @click="revoking = room" /></UTooltip>
              </div>
            </div>
            <span class="shared-room-life" aria-hidden="true"><i :style="{ width: `${life_left(room.share_link)}%` }"></i></span>
          </li>
        </ul>
      </template>
    </UModal>
    <ImportDialog v-model:open="import_open" />
    <UModal :open="Boolean(share_draft)" :title="share_phase === 'published' ? t('分享链接已发布') : t('分享「{name}」', { name: share_title })"
      :description="share_phase === 'published' ? share_title : t('生成只读网页，没装共议的人也能打开看。')"
      :content="{ onInteractOutside: (event) => event.preventDefault() }" :ui="{ content: `glass-panel studio-modal channel-folder-modal channel-manage-modal share-dialog${share_phase === 'published' ? ' share-dialog-wide' : ''}`, body: 'dialog-body' }" @update:open="close_share">
      <template v-if="share_phase === 'published'" #title><span class="share-done-title"><UIcon name="i-lucide-circle-check" />{{ t('分享链接已发布') }}</span></template>
      <template #body>
        <div v-if="share_phase === 'preparing'" class="share-dialog-loading" role="status"><UIcon name="i-lucide-loader-circle" class="animate-spin" />{{ t("正在整理房间：读取消息与执行记录，去掉本机信息…") }}</div>
        <template v-else-if="share_phase === 'published'">
          <!-- The link first: it is what was asked for, and it is already on the clipboard. -->
          <div class="share-done-link">
            <UIcon name="i-lucide-link-2" class="share-done-link-icon" />
            <input :value="share_draft.link.url.replace(/^https?:\/\//, '')" readonly class="share-done-url" :aria-label="t('分享链接')" @focus="$event.target.select()">
            <UTooltip :text="t('打开分享页')"><UButton icon="i-lucide-external-link" color="neutral" variant="ghost" size="sm" :aria-label="t('打开分享页')" :to="share_draft.link.url" target="_blank" rel="noopener noreferrer" /></UTooltip>
            <UButton :label="link_copied ? t('已复制') : t('复制链接')" :icon="link_copied ? 'i-lucide-check' : 'i-lucide-copy'" color="primary" size="sm" class="share-done-copy" @click="copy_share_link" />
          </div>
          <p class="share-done-meta"><UIcon name="i-lucide-clock" />{{ share_draft.link.updated ? t("已更新原链接的内容，{time} 前有效。", { time: share_expiry }) : t("{time} 前有效，到期自动删除。", { time: share_expiry }) }}</p>
          <div class="share-done-card">
            <figure class="share-done-stage"><canvas ref="card_canvas" :aria-label="t('分享卡：{name}', { name: share_title })"></canvas></figure>
            <div class="share-done-side">
              <h3>{{ t('分享卡') }}</h3>
              <label class="share-dialog-field"><span>{{ t('卡片上的问题') }}</span>
                <UTextarea v-model="card_text.question" :rows="2" autoresize :maxrows="4" variant="soft" :placeholder="t('可留空')" :aria-label="t('分享卡上的问题')" /></label>
              <label class="share-dialog-field"><span>{{ t('卡片上的成果') }}</span>
                <UTextarea v-model="card_text.outcome" :rows="3" autoresize :maxrows="5" variant="soft" :placeholder="t('可留空')" :aria-label="t('分享卡上的成果')" /></label>
              <div class="share-done-card-actions">
                <UButton :label="t('保存图片')" icon="i-lucide-image-down" color="neutral" variant="subtle" @click="save_card" />
                <UButton v-if="can_copy_image" :label="card_copied ? t('已复制') : t('复制图片')" :icon="card_copied ? 'i-lucide-check' : 'i-lucide-clipboard-copy'" color="neutral" variant="subtle" @click="copy_card" />
              </div>
            </div>
          </div>
          <div class="share-done-foot">
            <p>{{ t("之后在左侧“已分享”里可以复制、续期或撤销，已配对的手机和平板也能操作。") }}</p>
            <UButton :label="t('完成')" color="neutral" variant="outline" @click="close_share(false)" />
          </div>
        </template>
        <template v-else>
        <section class="share-dialog-section">
          <h3>{{ t("分享的内容") }}</h3>
          <p>{{ t("消息、卡片、执行时间线与过程说明，停在此刻；读者只能看，不能操作。") }}</p>
          <p class="share-dialog-muted">{{ t("不含私聊、事件记录、调度决策、排队消息、会话与凭据；本机用户目录写作 ~，项目目录写成相对路径，失败原因只写“执行失败”。") }}</p>
        </section>
        <!-- Attachments go in only when the owner ticks this (user 2026-11-21): every kind of file, as it was sent. -->
        <section v-if="share_draft.files?.count" class="share-dialog-section">
          <UCheckbox :model-value="share_draft.files.included" :disabled="share_phase !== 'ready'"
            :label="t('包含附件（{count} 个，共 {size}）', { count: share_draft.files.count, size: bridge.attachment_size(share_draft.files.bytes) })" @update:model-value="act('share_include_files', $event)" />
          <p v-if="share_draft.files.included && share_draft.files.site_left_out.length" class="share-dialog-muted">{{ t("{names} 不能放到分享站：发布链接时不带，消息里显示“未包含在分享中”；下载网页文件仍会带上。", { names: share_draft.files.site_left_out.slice(0, 3).join("、") + (share_draft.files.site_left_out.length > 3 ? t(" 等 {count} 个", { count: share_draft.files.site_left_out.length }) : "") }) }}</p>
          <p v-if="share_phase === 'checking'" class="share-dialog-muted">{{ t("正在检查文本类附件…") }}</p>
          <p v-else class="share-dialog-muted">{{ share_draft.files.included ? t("附件原样公开。文本类附件已一并检查；图片、视频和其他文件的内容程序查不了，请自己核对。") : t("不包含时，消息里的附件标记显示为“未包含在分享中”。") }}</p>
        </section>
        <section class="share-dialog-section">
          <h3>{{ share_spots.length ? t("发出前请核对（{count} 处）", { count: share_spot_total }) : t("发出前请核对") }}</h3>
          <p v-if="!share_spots.length" class="share-dialog-clear"><UIcon name="i-lucide-circle-check" />{{ t("没有找到疑似密钥、令牌或联系方式。正文会原样公开，程序查不全，仍请自己看一遍。") }}</p>
          <template v-else>
            <p class="share-dialog-muted">{{ t("疑似密钥、令牌、邮箱或手机号，正文会原样公开：") }}</p>
            <ul class="share-dialog-spots">
              <li v-for="spot in share_spots.slice(0, SHARE_SPOTS_SHOWN)" :key="spot.where"><b>{{ spot.where }}</b><span v-if="spot.count > 1" class="share-dialog-count">{{ t("{count} 处", { count: spot.count }) }}</span><code>{{ spot.text }}</code></li>
            </ul>
            <p v-if="share_spots.length > SHARE_SPOTS_SHOWN" class="share-dialog-muted">{{ t("另有 {count} 个位置，请在生成的网页里查找。", { count: share_spots.length - SHARE_SPOTS_SHOWN }) }}</p>
          </template>
        </section>
        <div class="share-dialog-choices">
          <div class="share-dialog-choice">
            <UButton :label="t('下载网页文件')" icon="i-lucide-download" color="neutral" variant="outline" block :loading="share_phase === 'downloading'" :disabled="share_phase !== 'ready'" @click="act('share_room')" />
            <p>{{ t("得到一个 .html 文件，发出后无法过期或撤回。") }}</p>
          </div>
          <div class="share-dialog-choice">
            <div class="share-dialog-publish">
              <USelect v-model="share_days" :items="share_day_items" class="share-dialog-days" :disabled="share_phase !== 'ready'" :aria-label="t('分享链接的有效期')" />
              <UButton :label="share_phase === 'publishing' ? (share_draft?.upload ? t('正在上传附件 {done}/{total}', share_draft.upload) : t('正在上传…')) : share_draft?.linked ? t('更新链接') : t('发布链接')" icon="i-lucide-link-2" color="primary" class="share-dialog-publish-button"
                :loading="share_phase === 'publishing'" :disabled="share_phase !== 'ready'" @click="act('share_publish', share_days)" />
            </div>
            <p>{{ t("上传到 AI CoDiscuss 分享站，运营方与审核 AI 能读到全文；到期自动删除，可随时撤销，撤销后缓存副本留到原定到期时才清除。") }}</p>
          </div>
        </div>
        </template>
      </template>
    </UModal>
    <ConfirmDialog :open="Boolean(revoking)" :title="t('撤销「{name}」的分享链接', { name: revoking?.title || '' })" :description="t('分享站上的这份记录会立即删除，打开链接的人会看到“分享不存在”。')"
      :items="[t('已经下载的离线网页文件不受影响。')]" :confirm-label="t('撤销链接')" danger @update:open="(value) => { if (!value) revoking = null; }" @confirm="act('share_revoke', revoking.id)" />
  </div>
</template>

<style scoped>
.share-dialog-loading { display: flex; align-items: center; gap: 8px; padding: 20px 0 28px; color: var(--ui-text-toned); font-size: 13px; }
/* Published. The link is one field with its two actions inside it; below, the card on a stage with its texts beside it. */
.share-done-title { display: inline-flex; align-items: center; gap: 8px; }
.share-done-title .iconify { width: 18px; height: 18px; color: var(--ui-success); }
.share-done-link { display: flex; align-items: center; gap: 4px; padding: 5px 5px 5px 12px; border: 1px solid var(--ui-border-accented); border-radius: 11px; background: var(--ui-bg); transition: border-color .15s, box-shadow .15s; }
.share-done-link:focus-within { border-color: var(--channel-accent, var(--ui-primary)); box-shadow: 0 0 0 3px color-mix(in srgb, var(--channel-accent, var(--ui-primary)) 18%, transparent); }
.share-done-link-icon { flex-shrink: 0; width: 16px; height: 16px; color: var(--ui-text-muted); }
.share-done-url { flex: 1; min-width: 0; height: 30px; padding: 0 6px; border: 0; outline: 0; background: none; color: var(--ui-text-highlighted); font: 13px/30px ui-monospace, "SF Mono", "Cascadia Mono", Consolas, monospace; text-overflow: ellipsis; }
.share-done-copy { flex-shrink: 0; min-width: 92px; justify-content: center; }
.share-done-meta { display: flex; align-items: center; gap: 6px; margin: 8px 2px 0; color: var(--ui-text-muted); font-size: 12px; line-height: 1.5; }
.share-done-meta .iconify { flex-shrink: 0; width: 13px; height: 13px; }
.share-done-card { display: grid; grid-template-columns: 264px minmax(0, 1fr); gap: 20px; align-items: stretch; margin-top: 18px; }
.share-done-stage { display: flex; align-items: center; justify-content: center; margin: 0; padding: 18px; border: 1px solid var(--ui-border-muted); border-radius: 14px;
  background: radial-gradient(120% 90% at 50% 0%, color-mix(in srgb, var(--channel-accent, var(--ui-primary)) 14%, transparent), transparent 70%), color-mix(in srgb, var(--ui-text) 3%, transparent); }
.share-done-stage canvas { display: block; width: 100%; max-width: 228px; height: auto; border-radius: 10px; box-shadow: 0 1px 0 #ffffff14 inset, 0 14px 32px -10px #000000b3, 0 2px 6px #0000004d; }
.share-done-side { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.share-done-side h3 { margin: 0; color: var(--ui-text-highlighted); font-size: 13px; font-weight: 600; }
.share-dialog-field { display: grid; gap: 5px; }
.share-dialog-field > span { color: var(--ui-text-muted); font-size: 12px; }
.share-dialog-field :deep(textarea) { font-size: 13px; line-height: 1.6; }
.share-done-card-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: auto; }
.share-done-foot { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--ui-border-muted); }
.share-done-foot p { margin: 0; color: var(--ui-text-muted); font-size: 12px; line-height: 1.5; }
.share-done-foot button { flex-shrink: 0; }
@media (max-width: 640px) {
  .share-done-card { grid-template-columns: 1fr; }
  .share-done-stage canvas { max-width: 240px; }
  .share-done-copy { min-width: 0; }
}
.share-dialog-section { display: grid; gap: 4px; margin-bottom: 16px; font-size: 13px; line-height: 1.6; color: var(--ui-text-toned); }
.share-dialog-section h3 { margin: 0 0 2px; font-size: 13px; font-weight: 600; color: var(--ui-text-highlighted); }
.share-dialog-section p { margin: 0; }
.share-dialog-muted { color: var(--ui-text-muted); font-size: 12px; }
.share-dialog-clear { display: flex; align-items: flex-start; gap: 6px; }
.share-dialog-clear .iconify { flex-shrink: 0; margin-top: 3px; color: var(--ui-success); }
.share-dialog-spots { display: grid; gap: 4px; max-height: 180px; overflow-y: auto; margin: 2px 0 0; padding: 0; list-style: none; }
.share-dialog-spots li { display: grid; grid-template-columns: auto auto minmax(0, 1fr); align-items: baseline; gap: 6px; padding: 4px 8px; border-radius: 6px; background: var(--ui-bg-elevated); font-size: 12px; }
.share-dialog-spots b { font-weight: 600; color: var(--ui-text-highlighted); white-space: nowrap; }
.share-dialog-count { color: var(--ui-text-muted); white-space: nowrap; }
.share-dialog-spots code { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ui-text-toned); }
.share-dialog-choices { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; padding-top: 14px; border-top: 1px solid var(--ui-border-muted); }
.share-dialog-choice { display: grid; align-content: start; gap: 6px; }
.share-dialog-choice p { margin: 0; color: var(--ui-text-muted); font-size: 12px; line-height: 1.5; }
.share-dialog-publish { display: flex; gap: 6px; }
.share-dialog-days { width: 118px; flex-shrink: 0; }
.share-dialog-publish-button { flex: 1; justify-content: center; }
@media (max-width: 560px) { .share-dialog-choices { grid-template-columns: 1fr; } }
.channel-room-alert { justify-self: center; width: 14px; height: 14px; color: var(--ui-error); }
</style>

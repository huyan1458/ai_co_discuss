<script>
import { ref as module_ref } from "vue";
// The folders open in this page load, kept outside the component: a phone's sidebar is a drawer mounted anew each time
// it opens, and keeping them inside it forgot them on every close (user 2026-11-16). A reload starts afresh with only
// the shown room's folder open (user 2026-11-15).
const open_folders = module_ref(new Set());
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
import MemoBlock from "./memo-block.js";
import { use_workflow_library } from "./workflow-library.js";
import { t } from "./i18n.js";

const emit = defineEmits(["select", "manage", "create", "create-folder", "manage-folder", "delete-folder", "archive-folder", "archives"]);
const { view, bridge, act, pending } = inject("discussion");
// While the workflow page fills the middle, no room row is shown as the open one.
const { page_open: workflow_page } = use_workflow_library();
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
  { label: t("导入房间…"), icon: "i-lucide-download", disabled: view.value.backup_pending, onSelect: () => choose_import_target(null) },
  { label: t("导出全部房间"), icon: "i-lucide-upload", disabled: view.value.backup_pending || !view.value.rooms.length,
    onSelect: () => act("backup_rooms", { ids: view.value.rooms.map((room) => room.id), name: t("全部房间") }) },
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
const row_state = computed(() => JSON.stringify([view.value.directory_pending, view.value.archive_pending, view.value.backup_pending,
  view.value.folders, view.value.room_site, manual_order.value, view.value.room?.id, pending.value, workflow_page.value, open_room_running.value]));
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
  return { items: actions(room, index, room.folder_id || null, count), active: !workflow_page.value && room.id === view.value.room?.id, busy: Boolean(pending.value),
    archiving: view.value.archive_pending.includes(room.id), time: room_time(room), title: room_time_title(room),
    running: room_running(room) };
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
const rooms_open = ref(true);
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
  ], [{ label: t("导入房间…"), icon: "i-lucide-download", disabled: folder.pending || view.value.backup_pending, onSelect: () => choose_import_target(folder.id || null) },
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

/** Keep actions targeted to the clicked channel without changing the open draft. */
function actions(room, index, folder_id, folder_room_count) {
  const ordering = view.value.directory_pending.includes("room-order");
  const current = room.id === view.value.room?.id;
  return [[
    { label: t("重命名"), icon: "i-lucide-pencil", disabled: view.value.directory_pending.includes(`rename:${room.id}`), onSelect: () => emit("manage", { room, action: "rename" }) },
    ...(current ? [{ label: t("编辑议题"), icon: "i-lucide-pencil", onSelect: () => emit("manage", { room, action: "edit" }) }] : []),
    { label: t("复制阅读入口"), icon: "i-lucide-link", onSelect: () => act("copy", `${view.value.room_site}/r/${encodeURIComponent(room.id)}`) },
    { label: t("导出对话"), icon: "i-lucide-upload", disabled: view.value.backup_pending || Boolean(pending.value), onSelect: () => act("backup", room.id) },
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
    { label: t("永久删除"), icon: "i-lucide-trash-2", disabled: view.value.directory_pending.includes(`rename:${room.id}`), onSelect: () => emit("manage", { room, action: "delete" }) },
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
       <button class="channel-folder-heading" data-drop-folder data-drag-handle type="button" :disabled="folder.pending" :aria-label="`${folder.name} ${folder.rooms.length}`" :aria-expanded="!head.collapsed" :title="t('拖动文件夹排序；上下方向键移动')" @pointerdown="!pending && bridge.start_drag($event)" @keydown.up.prevent="act('move_folder', { id: folder.order_id, direction: -1 })" @keydown.down.prevent="act('move_folder', { id: folder.order_id, direction: 1 })" @click="toggle_folder(folder.id)"><UIcon :name="head.collapsed ? 'i-lucide-chevron-right' : 'i-lucide-chevron-down'" /><UIcon name="i-lucide-folder" /><span class="channel-folder-name">{{ folder.name }}</span><i v-if="head.running && !folder.pending" class="channel-room-running" :title="t('正在执行')" /><small v-else class="channel-directory-count" aria-hidden="true">{{ folder.pending ? t('保存中') : folder.rooms.length || '' }}</small></button>
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
        <div class="channel-room-row" :class="{ active: row.active }" :data-drag-room="room.id">
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
    <ImportDialog v-model:open="import_open" />
  </div>
</template>

<style scoped>
.channel-room-alert { justify-self: center; width: 14px; height: 14px; color: var(--ui-error); }
</style>

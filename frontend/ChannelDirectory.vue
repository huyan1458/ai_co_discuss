<script setup>
import { computed, inject, ref, watch } from "vue";
import ImportDialog from "./ImportDialog.vue";
import MemoBlock from "./memo-block.js";

const emit = defineEmits(["select", "manage", "create", "create-folder", "manage-folder", "delete-folder", "archive-folder", "archives"]);
const { view, bridge, act, pending } = inject("discussion");
const rooms = computed(() => view.value.rooms.filter((room) => !room.archived));
const archived_count = computed(() => view.value.rooms.filter((room) => room.archived).length);
const folders = computed(() => (view.value.folder_groups || []).map((folder) => ({ ...folder,
  rooms: rooms.value.filter((room) => (room.folder_id || "") === folder.id) })));
const manual_order = computed(() => view.value.directory_sort !== "recent");
const source = computed(() => view.value.room_source || {});
// A website that keeps no rooms of its own lists the paired computer's, and says why while it cannot.
const directory_title = computed(() => {
  if (!source.value.computer) return "协作房间";
  if (!source.value.signed_in) return "协作房间（未配对）";
  if (!source.value.remote) return source.value.online === false ? "协作房间（电脑离线）" : "协作房间（电脑未连接）";
  return source.value.online === false ? "协作房间（电脑离线）" : "协作房间";
});
const directory_actions = computed(() => [
  { label: "对话排列方式", type: "label" },
  ...[{ value: "manual", label: "手动排序" }, { value: "recent", label: "最近发言" }].map((item) => ({
    label: item.label, icon: (view.value.directory_sort || "manual") === item.value ? "i-lucide-check" : undefined,
    onSelect: () => act("sort_directory", item.value),
  })),
  { type: "separator" },
  { label: "导入房间…", icon: "i-lucide-download", disabled: view.value.backup_pending, onSelect: () => choose_import_target(null) },
  { label: "导出全部房间", icon: "i-lucide-upload", disabled: view.value.backup_pending || !view.value.rooms.length,
    onSelect: () => act("backup_rooms", { ids: view.value.rooms.map((room) => room.id), name: "全部房间" }) },
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
/** Short relative last-activity label ("3小时前"); falls back to creation time. */
function room_time(room) {
  const time = new Date(room.latest_at || room.created_at || "").getTime();
  if (Number.isNaN(time)) return "";
  const minutes = Math.max(0, Math.floor((Date.now() - time) / 60000));
  const days = Math.floor(minutes / 1440);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes}分钟前`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}小时前`;
  if (days < 7) return `${days}天前`;
  if (days < 30) return `${Math.floor(days / 7)}周前`;
  if (days < 365) return `${Math.floor(days / 30)}个月前`;
  return `${Math.floor(days / 365)}年前`;
}

/** Full timestamps for the row tooltip. */
function room_time_title(room) {
  const format = (value) => new Date(value).toLocaleString("zh-CN", { hour12: false });
  return [room.title, room.latest_at && `最近发言 ${format(room.latest_at)}`, room.created_at && `创建于 ${format(room.created_at)}`]
    .filter(Boolean).join("\n");
}
// Everything a room row and its menus read besides the room itself, so a row re-renders only when this, the room or its
// time label changes rather than on every view publish.
const row_state = computed(() => JSON.stringify([view.value.directory_pending, view.value.archive_pending, view.value.backup_pending,
  view.value.folders, view.value.room_site, manual_order.value, view.value.room?.id, pending.value]));
/**
 * Plain values for one room row. They are read here, in the row's own render, because the menu and tooltip slots are run
 * by those components, which would otherwise track the view and re-render every row on each publish.
 */
function room_row(room, index, count) {
  return { items: actions(room, index, room.folder_id || null, count), active: room.id === view.value.room?.id, busy: Boolean(pending.value),
    archiving: view.value.archive_pending.includes(room.id), time: room_time(room), title: room_time_title(room) };
}
/** Plain values for one folder's heading row, and the key it re-renders on; read here for the same reason as room_row. */
function folder_head(folder, index) {
  const items = folder.id ? folder_actions(folder, index) : [];
  const head = { items, collapsed: collapsed.value.has(folder.id), active: view.value.room?.folder_id === folder.id,
    creating: view.value.directory_pending.includes("create-room") };
  head.key = JSON.stringify([folder, head.collapsed, head.active, head.creating, items.map((group) => group.map((item) => [item.label, item.disabled]))]);
  return head;
}
const rooms_open = ref(true);
const collapsed = ref(read_collapsed());
watch(() => view.value.room?.id, () => {
  const folder_id = view.value.room?.folder_id || "";
  if (folder_id && collapsed.value.has(folder_id)) toggle_folder(folder_id);
});

/** Keep folder editing and keyboard-equivalent movement on the folder's own menu. */
function folder_actions(folder, index) {
  const ordering = view.value.directory_pending.includes("folder-order") || view.value.directory_pending.includes("create-folder");
  return [...(folder.id ? [[{ label: "编辑", icon: "i-lucide-pencil", disabled: folder.pending || view.value.directory_pending.includes(`folder-name:${folder.id}`), onSelect: () => emit("manage-folder", folder) }]] : []), [
    { label: "上移", icon: "i-lucide-arrow-up", disabled: ordering || index === 0 || Boolean(pending.value), onSelect: () => act("move_folder", { id: folder.order_id, direction: -1 }) },
    { label: "下移", icon: "i-lucide-arrow-down", disabled: ordering || index === folders.value.length - 1 || Boolean(pending.value), onSelect: () => act("move_folder", { id: folder.order_id, direction: 1 }) },
  ], [{ label: "导入房间…", icon: "i-lucide-download", disabled: folder.pending || view.value.backup_pending, onSelect: () => choose_import_target(folder.id || null) },
    folder_export(folder)], ...(folder.id ? [[{ label: "存档文件夹", icon: "i-lucide-archive",
    disabled: folder.pending || !folder.rooms.length || folder.rooms.some(room => view.value.archive_pending.includes(room.id)),
    onSelect: () => emit("archive-folder", folder) }, { label: "移除文件夹", icon: "i-lucide-folder-minus",
    disabled: folder.pending || ordering || view.value.directory_pending.includes(`folder-name:${folder.id}`)
      || view.value.creating_room?.folder_id === folder.id
      || view.value.rooms.some(room => room.folder_id === folder.id && view.value.folder_pending.includes(room.id)),
    onSelect: () => emit("delete-folder", folder) }]] : [])];
}

/** Export every channel filed in a folder, archived ones included. */
function folder_export(folder) {
  const ids = view.value.rooms.filter((room) => (room.folder_id || "") === folder.id).map((room) => room.id);
  return { label: "导出文件夹", icon: "i-lucide-upload", disabled: view.value.backup_pending || !ids.length,
    onSelect: () => act("backup_rooms", { ids, name: folder.name || "未分组" }) };
}

/** Restore the user's collapsed folder IDs when local storage is available. */
function read_collapsed() {
  try { return new Set(JSON.parse(localStorage.getItem("ai-codiscuss-folders-collapsed") || "[]")); }
  catch { return new Set(); }
}

/** Toggle one group and persist the presentation preference. */
function toggle_folder(id) {
  const next = new Set(collapsed.value);
  if (next.has(id)) next.delete(id); else next.add(id);
  collapsed.value = next;
  try { localStorage.setItem("ai-codiscuss-folders-collapsed", JSON.stringify([...next])); } catch { /* Keep the current view. */ }
}

/** Keep actions targeted to the clicked channel without changing the open draft. */
function actions(room, index, folder_id, folder_room_count) {
  const ordering = view.value.directory_pending.includes("room-order");
  const current = room.id === view.value.room?.id;
  return [[
    { label: "重命名", icon: "i-lucide-pencil", disabled: view.value.directory_pending.includes(`rename:${room.id}`), onSelect: () => emit("manage", { room, action: "rename" }) },
    ...(current ? [{ label: "编辑议题", icon: "i-lucide-pencil", onSelect: () => emit("manage", { room, action: "edit" }) }] : []),
    { label: "复制阅读入口", icon: "i-lucide-link", onSelect: () => act("copy", `${view.value.room_site}/r/${encodeURIComponent(room.id)}`) },
    { label: "导出对话", icon: "i-lucide-upload", disabled: view.value.backup_pending || Boolean(pending.value), onSelect: () => act("backup", room.id) },
  ], ...(current ? [[{ label: "刷新消息", icon: "i-lucide-refresh-cw", onSelect: () => act("refresh") }]] : []), [
    { label: "移至文件夹", icon: "i-lucide-folder-input", disabled: Boolean(pending.value) || (!room.folder_id && !view.value.folders?.length), children: [
      { label: "移出文件夹", icon: "i-lucide-folder-minus", disabled: !room.folder_id, onSelect: () => act("manage_channel", { id: room.id, action: "folder", folder_id: null }) },
      ...(view.value.folders || []).map((folder) => ({ label: folder.name, icon: "i-lucide-folder", disabled: folder.pending || room.folder_id === folder.id, onSelect: () => act("manage_channel", { id: room.id, action: "folder", folder_id: folder.id }) })),
    ] },
  ], [
    { label: "上移", icon: "i-lucide-arrow-up", disabled: ordering || !manual_order.value || index === 0 || Boolean(pending.value), onSelect: () => act("move_channel", { id: room.id, direction: -1, folder_id }) },
    { label: "下移", icon: "i-lucide-arrow-down", disabled: ordering || !manual_order.value || index === folder_room_count - 1 || Boolean(pending.value), onSelect: () => act("move_channel", { id: room.id, direction: 1, folder_id }) },
  ], [
    { label: room.archived ? "恢复房间" : "存档房间", icon: room.archived ? "i-lucide-archive-restore" : "i-lucide-archive", disabled: view.value.archive_pending.includes(room.id), onSelect: () => emit("manage", { room, action: room.archived ? "restore" : "archive" }) },
    { label: "永久删除", icon: "i-lucide-trash-2", disabled: view.value.directory_pending.includes(`rename:${room.id}`), onSelect: () => emit("manage", { room, action: "delete" }) },
  ]];
}

</script>

<template>
  <div class="channel-directory-manager">
    <UButton label="新建对话" icon="i-lucide-plus" color="neutral" class="channel-primary-button channel-new-conversation" :disabled="view.directory_pending.includes('create-room')" @click="emit('create', null)" />
    <div class="channel-directory-heading">
      <button type="button" class="channel-section-toggle" :aria-expanded="rooms_open" @click="rooms_open = !rooms_open"><UIcon :name="rooms_open ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" />{{ directory_title }}</button>
      <div class="channel-directory-actions">
        <UTooltip text="新建文件夹"><UButton icon="i-lucide-plus" color="neutral" variant="ghost" size="xs" aria-label="新建文件夹" :disabled="view.directory_pending.includes('create-folder')" @click="emit('create-folder')" /></UTooltip>
        <UDropdownMenu :items="directory_actions" :content="{ align: 'end', sideOffset: 4 }" :ui="{ content: 'channel-menu channel-directory-menu' }"><UButton icon="i-lucide-ellipsis" aria-label="房间目录选项" title="排列、导入与导出" size="xs" color="neutral" variant="ghost" /></UDropdownMenu>
        <input ref="import_input" type="file" accept=".zip,.json" multiple hidden aria-label="选择房间备份" @change="choose_imports">
      </div>
    </div>
    <nav v-show="rooms_open" aria-label="协作房间列表" class="channel-room-list" data-room-directory>
      <section v-for="(folder, folder_index) in folders" :key="folder.order_id" class="channel-folder-section" :data-room-folder="folder.id" :data-drag-folder="folder.order_id">
       <template v-for="head in [folder_head(folder, folder_index)]" :key="folder.order_id">
       <MemoBlock v-if="folder.id" :deps="[head.key]">
       <div class="channel-folder-row" :class="{ active: head.collapsed && head.active }">
       <button class="channel-folder-heading" data-drop-folder data-drag-handle type="button" :disabled="folder.pending" :aria-label="`${folder.name} ${folder.rooms.length}`" :aria-expanded="!head.collapsed" title="拖动文件夹排序；上下方向键移动" @pointerdown="!pending && bridge.start_drag($event)" @keydown.up.prevent="act('move_folder', { id: folder.order_id, direction: -1 })" @keydown.down.prevent="act('move_folder', { id: folder.order_id, direction: 1 })" @click="toggle_folder(folder.id)"><UIcon :name="head.collapsed ? 'i-lucide-chevron-right' : 'i-lucide-chevron-down'" /><UIcon name="i-lucide-folder" /><span class="channel-folder-name">{{ folder.name }}</span><small class="channel-directory-count" aria-hidden="true">{{ folder.pending ? '保存中' : folder.rooms.length || '' }}</small></button>
        <div class="channel-folder-actions">
          <UTooltip :text="`在${folder.name}中新建对话`"><UButton icon="i-lucide-square-pen" :aria-label="`在${folder.name}中新建对话`" :disabled="folder.pending || head.creating" size="xs" color="neutral" variant="ghost" @click="emit('create', folder.id ? folder : null)" /></UTooltip>
          <UDropdownMenu :items="head.items" :content="{ align: 'start', side: 'bottom', sideOffset: 6 }" :ui="{ content: 'channel-menu channel-topic-menu' }"><UButton icon="i-lucide-ellipsis" :aria-label="`管理文件夹 ${folder.name}`" title="文件夹选项" size="xs" color="neutral" variant="ghost" /></UDropdownMenu>
        </div>
       </div>
       </MemoBlock>
       </template>
       <div v-if="!folder.id || !collapsed.has(folder.id)" :class="folder.id ? 'channel-folder-rooms' : 'channel-root-rooms'" :data-drop-folder="folder.id ? undefined : ''">
      <p v-if="view.creating_room && (view.creating_room.folder_id || '') === folder.id" class="channel-directory-empty" role="status">正在创建：{{ view.creating_room.title }}</p>
      <MemoBlock v-for="(room, index) in folder.rooms" :key="room.id" :deps="[JSON.stringify(room), index, folder.rooms.length, row_state, room_time(room)]">
      <template v-for="row in [room_row(room, index, folder.rooms.length)]" :key="room.id">
      <UContextMenu :items="row.items" :ui="{ content: 'channel-menu channel-topic-menu' }">
        <div class="channel-room-row" :class="{ active: row.active }" :data-drag-room="room.id">
          <button class="channel-room-grip" data-drag-handle :aria-label="`拖动 ${room.title}`" title="拖动排序；上下方向键移动" :disabled="row.busy" @pointerdown="bridge.start_drag($event)" @keydown.up.prevent="act('move_channel', { id: room.id, direction: -1, folder_id: room.folder_id || null })" @keydown.down.prevent="act('move_channel', { id: room.id, direction: 1, folder_id: room.folder_id || null })"><UIcon name="i-lucide-grip-vertical" /></button>
          <button class="channel-room-select" data-drag-title :title="row.title" :aria-label="room.title" :aria-current="row.active ? 'page' : undefined" @pointerdown="!pending && bridge.start_drag($event)" @click="emit('select', room.id)"><span>{{ room.title }}</span><small class="channel-room-time" aria-hidden="true">{{ row.time }}</small></button>
          <div class="channel-room-actions">
            <UTooltip :text="room.archived ? '恢复房间' : '存档房间'" :ui="{ content: 'channel-topic-tooltip' }">
              <UButton :icon="room.archived ? 'i-lucide-archive-restore' : 'i-lucide-archive'" :aria-label="`${room.archived ? '恢复' : '存档'} ${room.title}`" size="xs" color="neutral" variant="ghost" :disabled="row.busy || row.archiving" @click="emit('manage', { room, action: room.archived ? 'restore' : 'archive' })" />
            </UTooltip>
            <UDropdownMenu :items="row.items" :content="{ align: 'start', side: 'bottom', sideOffset: 6 }" :ui="{ content: 'channel-menu channel-topic-menu' }"><UButton icon="i-lucide-ellipsis" :aria-label="`管理 ${room.title}`" title="更多操作" size="xs" color="neutral" variant="ghost" /></UDropdownMenu>
          </div>
        </div>
      </UContextMenu>
      </template>
      </MemoBlock>
       </div>
      </section>
      <p v-if="!rooms.length" class="channel-directory-empty">暂无协作房间</p>
    </nav>
    <UButton v-show="rooms_open" icon="i-lucide-archive" color="neutral" variant="ghost" class="channel-archive-toggle" aria-haspopup="dialog" @click="emit('archives')"><span class="channel-archive-label">已存档</span><small v-if="archived_count" class="channel-archive-count">{{ archived_count }}</small></UButton>
    <ImportDialog v-model:open="import_open" />
  </div>
</template>

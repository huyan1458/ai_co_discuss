<script setup>
import { computed, inject, ref, watch } from "vue";

const emit = defineEmits(["select", "manage", "create", "create-folder", "manage-folder"]);
const { view, bridge, act, pending } = inject("discussion");
const rooms = computed(() => view.value.rooms.filter((room) => Boolean(room.archived) === view.value.archive_view));
const archived_count = computed(() => view.value.rooms.filter((room) => room.archived).length);
const folders = computed(() => (view.value.folder_groups || []).map((folder) => ({ ...folder,
  rooms: rooms.value.filter((room) => (room.folder_id || "") === folder.id) })));
const manual_order = computed(() => view.value.directory_sort !== "recent");
const directory_actions = computed(() => [
  { label: "对话排列方式", type: "label" },
  ...[{ value: "manual", label: "手动排序" }, { value: "recent", label: "最近发言" }].map((item) => ({
    label: item.label, icon: (view.value.directory_sort || "manual") === item.value ? "i-lucide-check" : undefined,
    onSelect: () => act("sort_directory", item.value),
  })),
]);
const collapsed = ref(read_collapsed());
watch(() => view.value.room?.id, () => {
  const folder_id = view.value.room?.folder_id || "";
  if (collapsed.value.has(folder_id)) toggle_folder(folder_id);
});

/** Keep folder editing and keyboard-equivalent movement on the folder's own menu. */
function folder_actions(folder, index) {
  return [...(folder.id ? [[{ label: "重命名", icon: "i-lucide-pencil", onSelect: () => emit("manage-folder", folder) }]] : []), [
    { label: "上移", icon: "i-lucide-arrow-up", disabled: index === 0 || Boolean(pending.value), onSelect: () => act("move_folder", { id: folder.order_id, direction: -1 }) },
    { label: "下移", icon: "i-lucide-arrow-down", disabled: index === folders.value.length - 1 || Boolean(pending.value), onSelect: () => act("move_folder", { id: folder.order_id, direction: 1 }) },
  ]];
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
  return [[
    { label: "重命名", icon: "i-lucide-pencil", onSelect: () => emit("manage", { room, action: "rename" }) },
    { label: "导出对话", icon: "i-lucide-download", disabled: view.value.backup_pending || Boolean(pending.value), onSelect: () => act("backup", room.id) },
  ], [
    { label: "移出文件夹", icon: "i-lucide-folder-minus", disabled: !room.folder_id || Boolean(pending.value), onSelect: () => act("manage_channel", { id: room.id, action: "folder", folder_id: null }) },
    ...(view.value.folders || []).map((folder) => ({ label: `移至「${folder.name}」`, icon: "i-lucide-folder-input", disabled: room.folder_id === folder.id || Boolean(pending.value), onSelect: () => act("manage_channel", { id: room.id, action: "folder", folder_id: folder.id }) })),
  ], [
    { label: "上移", icon: "i-lucide-arrow-up", disabled: !manual_order.value || index === 0 || Boolean(pending.value), onSelect: () => act("move_channel", { id: room.id, direction: -1, folder_id }) },
    { label: "下移", icon: "i-lucide-arrow-down", disabled: !manual_order.value || index === folder_room_count - 1 || Boolean(pending.value), onSelect: () => act("move_channel", { id: room.id, direction: 1, folder_id }) },
  ], [
    { label: room.archived ? "恢复频道" : "存档频道", icon: room.archived ? "i-lucide-archive-restore" : "i-lucide-archive", onSelect: () => emit("manage", { room, action: room.archived ? "restore" : "archive" }) },
    { label: "永久删除", icon: "i-lucide-trash-2", onSelect: () => emit("manage", { room, action: "delete" }) },
  ]];
}

</script>

<template>
  <div class="channel-directory-manager">
    <UButton label="新建对话" icon="i-lucide-square-pen" color="neutral" variant="ghost" class="channel-new-conversation" @click="emit('create', null)" />
    <div class="channel-directory-heading">
      <span><UIcon name="i-lucide-chevron-down" />讨论频道</span>
      <div class="channel-directory-actions">
        <UDropdownMenu :items="directory_actions" :content="{ align: 'end', sideOffset: 4 }" :ui="{ content: 'channel-menu channel-directory-menu' }"><UButton icon="i-lucide-ellipsis" aria-label="频道目录选项" title="排列方式" size="xs" color="neutral" variant="ghost" /></UDropdownMenu>
        <UTooltip v-if="!view.archive_view" text="新建文件夹"><UButton icon="i-lucide-plus" color="neutral" variant="ghost" size="xs" aria-label="新建文件夹" @click="emit('create-folder')" /></UTooltip>
      </div>
    </div>
    <nav aria-label="讨论频道列表" class="channel-room-list" data-room-directory>
      <section v-for="(folder, folder_index) in folders" :key="folder.order_id" class="channel-folder-section" :data-room-folder="folder.id" :data-drag-folder="folder.order_id">
       <div class="channel-folder-row">
       <button class="channel-folder-heading" data-drop-folder data-drag-handle type="button" :aria-label="`${folder.name} ${folder.rooms.length}`" :aria-expanded="!collapsed.has(folder.id)" title="拖动文件夹排序；上下方向键移动" @pointerdown="!pending && bridge.start_drag($event)" @keydown.up.prevent="act('move_folder', { id: folder.order_id, direction: -1 })" @keydown.down.prevent="act('move_folder', { id: folder.order_id, direction: 1 })" @click="toggle_folder(folder.id)"><UIcon :name="collapsed.has(folder.id) ? 'i-lucide-chevron-right' : 'i-lucide-chevron-down'" /><UIcon name="i-lucide-folder" /><span class="channel-folder-name">{{ folder.name }}</span></button>
        <div class="channel-folder-actions">
          <UDropdownMenu :items="folder_actions(folder, folder_index)" :content="{ align: 'start', side: 'bottom', sideOffset: 6 }" :ui="{ content: 'channel-menu channel-topic-menu' }"><UButton icon="i-lucide-ellipsis" :aria-label="`管理文件夹 ${folder.name}`" title="文件夹选项" size="xs" color="neutral" variant="ghost" /></UDropdownMenu>
          <UTooltip v-if="!view.archive_view" :text="`在${folder.name}中新建对话`"><UButton icon="i-lucide-square-pen" :aria-label="`在${folder.name}中新建对话`" size="xs" color="neutral" variant="ghost" @click="emit('create', folder.id ? folder : null)" /></UTooltip>
        </div>
        <small class="channel-directory-count" aria-hidden="true">{{ folder.rooms.length }}</small>
       </div>
       <div v-if="!collapsed.has(folder.id)" class="channel-folder-rooms">
      <UContextMenu v-for="(room, index) in folder.rooms" :key="room.id" :items="actions(room, index, room.folder_id || null, folder.rooms.length)" :ui="{ content: 'channel-menu channel-topic-menu' }">
        <div class="channel-room-row" :class="{ active: room.id === view.room?.id }" :data-drag-room="room.id">
          <button class="channel-room-grip" data-drag-handle :aria-label="`拖动 ${room.title}`" title="拖动排序；上下方向键移动" :disabled="Boolean(pending)" @pointerdown="bridge.start_drag($event)" @keydown.up.prevent="act('move_channel', { id: room.id, direction: -1, folder_id: room.folder_id || null })" @keydown.down.prevent="act('move_channel', { id: room.id, direction: 1, folder_id: room.folder_id || null })"><UIcon name="i-lucide-grip-vertical" /></button>
          <button class="channel-room-select" data-drag-title :title="room.title" :aria-label="`${room.title} ${room.message_count}`" :aria-current="room.id === view.room?.id ? 'page' : undefined" @pointerdown="!pending && bridge.start_drag($event)" @click="emit('select', room.id)"><span>{{ room.title }}</span></button>
          <div class="channel-room-actions">
            <UTooltip :text="room.archived ? '恢复频道' : '存档频道'" :ui="{ content: 'channel-topic-tooltip' }">
              <UButton :icon="room.archived ? 'i-lucide-archive-restore' : 'i-lucide-archive'" :aria-label="`${room.archived ? '恢复' : '存档'} ${room.title}`" size="xs" color="neutral" variant="ghost" :disabled="Boolean(pending)" @click="emit('manage', { room, action: room.archived ? 'restore' : 'archive' })" />
            </UTooltip>
            <UDropdownMenu :items="actions(room, index, room.folder_id || null, folder.rooms.length)" :content="{ align: 'start', side: 'bottom', sideOffset: 6 }" :ui="{ content: 'channel-menu channel-topic-menu' }"><UButton icon="i-lucide-ellipsis" :aria-label="`管理 ${room.title}`" title="更多操作" size="xs" color="neutral" variant="ghost" /></UDropdownMenu>
          </div>
          <small class="channel-directory-count" aria-hidden="true">{{ room.message_count }}</small>
        </div>
      </UContextMenu>
       </div>
      </section>
      <p v-if="!rooms.length" class="channel-directory-empty">{{ view.archive_view ? '暂无已存档频道' : '暂无讨论频道' }}</p>
    </nav>
    <UButton :icon="view.archive_view ? 'i-lucide-arrow-left' : 'i-lucide-archive'" :label="view.archive_view ? '返回讨论频道' : `已存档 · ${archived_count}`" color="neutral" variant="ghost" size="xs" class="channel-archive-toggle" :aria-pressed="view.archive_view" @click="act('archives')" />
  </div>
</template>

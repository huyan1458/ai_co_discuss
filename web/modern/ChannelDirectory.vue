<script setup>
import { computed, inject, ref } from "vue";

const emit = defineEmits(["select", "manage", "create", "create-folder"]);
const { view, bridge, act, pending } = inject("discussion");
const rooms = computed(() => view.value.rooms.filter((room) => Boolean(room.archived) === view.value.archive_view));
const archived_count = computed(() => view.value.rooms.filter((room) => room.archived).length);
const folders = computed(() => [...(view.value.folders || []).map((folder) => ({ ...folder, rooms: rooms.value.filter((room) => room.folder_id === folder.id) })),
  { id: "", name: "未归类", rooms: rooms.value.filter((room) => !room.folder_id) }]);
const directory_actions = [{ label: "新建文件夹", icon: "i-lucide-folder-plus", onSelect: () => emit("create-folder") }];
const collapsed = ref(read_collapsed());

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
  ], [
    { label: "移出文件夹", icon: "i-lucide-folder-minus", disabled: !room.folder_id || Boolean(pending.value), onSelect: () => act("manage_channel", { id: room.id, action: "folder", folder_id: null }) },
    ...(view.value.folders || []).map((folder) => ({ label: `移至「${folder.name}」`, icon: "i-lucide-folder-input", disabled: room.folder_id === folder.id || Boolean(pending.value), onSelect: () => act("manage_channel", { id: room.id, action: "folder", folder_id: folder.id }) })),
  ], [
    { label: "上移", icon: "i-lucide-arrow-up", disabled: index === 0 || Boolean(pending.value), onSelect: () => act("move_channel", { id: room.id, direction: -1, folder_id }) },
    { label: "下移", icon: "i-lucide-arrow-down", disabled: index === folder_room_count - 1 || Boolean(pending.value), onSelect: () => act("move_channel", { id: room.id, direction: 1, folder_id }) },
  ], [
    { label: room.archived ? "恢复频道" : "存档频道", icon: room.archived ? "i-lucide-archive-restore" : "i-lucide-archive", onSelect: () => emit("manage", { room, action: room.archived ? "restore" : "archive" }) },
    { label: "永久删除", icon: "i-lucide-trash-2", onSelect: () => emit("manage", { room, action: "delete" }) },
  ]];
}

</script>

<template>
  <div class="channel-directory-manager">
    <div class="channel-directory-heading">
      <span><UIcon name="i-lucide-chevron-down" />讨论频道</span>
      <div class="channel-directory-actions">
        <UDropdownMenu v-if="!view.archive_view" :items="directory_actions" :content="{ align: 'end', sideOffset: 4 }" :ui="{ content: 'channel-menu channel-directory-menu' }"><UButton icon="i-lucide-ellipsis" aria-label="频道目录选项" title="频道目录选项" size="xs" color="neutral" variant="ghost" /></UDropdownMenu>
        <UTooltip text="新建讨论"><UButton icon="i-lucide-plus" color="neutral" variant="ghost" size="xs" aria-label="新建讨论" @click="emit('create')" /></UTooltip>
      </div>
    </div>
    <UButton :icon="view.archive_view ? 'i-lucide-arrow-left' : 'i-lucide-archive'" :label="view.archive_view ? '返回讨论频道' : `已存档 · ${archived_count}`" color="neutral" variant="ghost" size="xs" class="channel-archive-toggle" :aria-pressed="view.archive_view" @click="act('archives')" />
    <nav aria-label="讨论频道列表" class="channel-room-list" data-room-directory>
      <section v-for="folder in folders" :key="folder.id || 'uncategorized'" class="channel-folder-section" :data-room-folder="folder.id">
       <button class="channel-folder-heading" data-drop-folder type="button" :aria-expanded="!collapsed.has(folder.id)" @click="toggle_folder(folder.id)"><UIcon :name="collapsed.has(folder.id) ? 'i-lucide-chevron-right' : 'i-lucide-chevron-down'" /><UIcon name="i-lucide-folder" /><span>{{ folder.name }}</span><small>{{ folder.rooms.length }}</small></button>
       <div v-if="!collapsed.has(folder.id)" class="channel-folder-rooms">
      <UContextMenu v-for="(room, index) in folder.rooms" :key="room.id" :items="actions(room, index, room.folder_id || null, folder.rooms.length)" :ui="{ content: 'channel-menu channel-topic-menu' }">
        <div class="channel-room-row" :class="{ active: room.id === view.room?.id }" :data-drag-room="room.id">
          <button class="channel-room-grip" data-drag-handle :aria-label="`拖动 ${room.title}`" title="拖动排序；上下方向键移动" :disabled="Boolean(pending)" @pointerdown="bridge.start_drag($event)" @keydown.up.prevent="act('move_channel', { id: room.id, direction: -1, folder_id: room.folder_id || null })" @keydown.down.prevent="act('move_channel', { id: room.id, direction: 1, folder_id: room.folder_id || null })"><UIcon name="i-lucide-grip-vertical" /></button>
          <button class="channel-room-select" data-drag-title :title="room.title" :aria-current="room.id === view.room?.id ? 'page' : undefined" @pointerdown="!pending && bridge.start_drag($event)" @click="emit('select', room.id)"><span>{{ room.title }}</span><small>{{ room.message_count }}</small></button>
          <div class="channel-room-actions">
            <UTooltip :text="room.archived ? '恢复频道' : '存档频道'" :ui="{ content: 'channel-topic-tooltip' }">
              <UButton :icon="room.archived ? 'i-lucide-archive-restore' : 'i-lucide-archive'" :aria-label="`${room.archived ? '恢复' : '存档'} ${room.title}`" size="xs" color="neutral" variant="ghost" :disabled="Boolean(pending)" @click="emit('manage', { room, action: room.archived ? 'restore' : 'archive' })" />
            </UTooltip>
            <UDropdownMenu :items="actions(room, index, room.folder_id || null, folder.rooms.length)" :content="{ align: 'start', side: 'bottom', sideOffset: 6 }" :ui="{ content: 'channel-menu channel-topic-menu' }"><UButton icon="i-lucide-ellipsis" :aria-label="`管理 ${room.title}`" title="更多操作" size="xs" color="neutral" variant="ghost" /></UDropdownMenu>
          </div>
        </div>
      </UContextMenu>
       </div>
      </section>
      <p v-if="!rooms.length" class="channel-directory-empty">{{ view.archive_view ? '暂无已存档频道' : '暂无讨论频道' }}</p>
    </nav>
  </div>
</template>

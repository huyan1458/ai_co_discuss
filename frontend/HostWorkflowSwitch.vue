<script>
import { shallowReactive } from "vue";
const open_rooms = shallowReactive(new Set());
const edits = shallowReactive(new Map());
const SAVE_DELAY_MS = 250;

async function flush_edit(room_id, edit, save) {
  if (edit.saving) return;
  edit.saving = true;
  try {
    let sent;
    do {
      sent = edit.value;
      await save({ room_id, permissions: sent });
    } while (sent !== edit.value);
  } finally {
    clearTimeout(edit.timer);
    edits.delete(room_id);
  }
}
</script>
<script setup>
import { t } from './i18n.js';
/**
 * The per-room grant of what the AI host may do by itself, shared by the new-room form and the room settings page:
 * one box for everything, and the items behind it to tick one by one. Emits the whole `{ items, room_limit }`.
 */
import { computed } from "vue";
import { HOST_ITEMS, MAX_HOST_ROOM_LIMIT, normalize_host_permissions } from "../runner/host_permissions.mjs";

const props = defineProps({
  /** The older single switch, read when the room has no itemised permissions yet. */
  modelValue: Boolean,
  /** `{ items, room_limit }` as the computer saved it, if any. */
  permissions: { type: Object, default: null },
  disabled: Boolean,
  roomId: String,
  save: Function,
});
const emit = defineEmits(["update:modelValue"]);

const ITEM_TEXTS = {
  execution: [t('处理执行问题'), t('停止、插话、重试成员，撤回自己派出的活')],
  member_config: [t('调整成员配置'), t('改成员的模型、强度、接入方式、名称与描述')],
  project_access: [t('改项目权限'), t('按需调整成员的项目权限，包括全放开')],
  roster: [t('管理成员名单'), t('邀请本机已配置的软件，暂离、移除、请回成员')],
  pacing: [t('推进方式'), t('调整发言顺序，开启和控制讨论与 Goal，给自己设定时检查')],
  workflows: [t('工作流'), t('保存并启用工作流，邀请工作流所需的成员')],
  create_rooms: [t('新建子房间'), t('从本房间新建房间并在其中分派工作；新房间不能再新建房间')],
};
const current = computed(() => edits.get(props.roomId)?.value ?? normalize_host_permissions(props.permissions, props.modelValue));
const all = computed(() => current.value.items.length === HOST_ITEMS.length ? true : current.value.items.length ? "indeterminate" : false);

function send(items, room_limit = current.value.room_limit) {
  const value = normalize_host_permissions({ items, room_limit });
  if (!props.save) { emit("update:modelValue", value); return; }
  const room_id = props.roomId, save = props.save;
  const edit = edits.get(room_id) || shallowReactive({ saving: false, timer: null });
  edit.value = value;
  edits.set(room_id, edit);
  clearTimeout(edit.timer);
  if (!edit.saving) edit.timer = setTimeout(() => flush_edit(room_id, edit, save), SAVE_DELAY_MS);
}

function toggle(item, checked) {
  send(checked ? [...current.value.items, item] : current.value.items.filter((entry) => entry !== item));
}

/** The limit is saved once it is a whole number in range; anything else waits for the user to finish typing. */
function write_limit(value) {
  const limit = Number(value);
  if (Number.isInteger(limit) && limit >= 1 && limit <= MAX_HOST_ROOM_LIMIT) send(current.value.items, limit);
}
</script>

<template>
  <div class="host-permissions">
    <UCheckbox :model-value="all" :disabled="disabled" :label="t('主持人完整权限')" :aria-label="t('主持人完整权限')"
      :description="t('主持人自行处理问题、持续推进，按需调整成员的项目权限。')"
      @update:model-value="send($event === true ? HOST_ITEMS : [])" />
    <span v-if="edits.has(roomId)" class="host-saving" role="status">{{ t('保存中…') }}</span>
    <details class="host-permission-items" :open="roomId ? open_rooms.has(roomId) : undefined" @toggle="roomId && ($event.target.open ? open_rooms.add(roomId) : open_rooms.delete(roomId))">
      <summary>{{ t('具体权限（已选 {count} / {total}）', { count: current.items.length, total: HOST_ITEMS.length }) }}<UIcon name="i-lucide-chevron-down" /></summary>
      <div v-for="item in HOST_ITEMS" :key="item" class="host-permission-item">
        <UCheckbox :model-value="current.items.includes(item)" :disabled="disabled" :label="ITEM_TEXTS[item][0]" :description="ITEM_TEXTS[item][1]" @update:model-value="toggle(item, $event === true)" />
        <label v-if="item === 'create_rooms' && current.items.includes(item)" class="host-room-limit"><span>{{ t('最多新建') }}</span>
          <UInput type="number" size="xs" :min="1" :max="MAX_HOST_ROOM_LIMIT" :model-value="current.room_limit" :disabled="disabled" :aria-label="t('主持人最多新建的房间数')" @update:model-value="write_limit" /><span>{{ t('个房间') }}</span>
        </label>
      </div>
    </details>
  </div>
</template>

<style scoped>
.host-permissions { display: grid; gap: 6px; position: relative; }
.host-saving { position: absolute; right: 0; top: 0; font-size: 12px; color: var(--ui-text-muted); }
.host-permission-items { margin-left: 26px; }
.host-permission-items > summary { display: inline-flex; align-items: center; gap: 4px; color: var(--channel-accent); font-size: 12px; cursor: pointer; list-style: none; user-select: none; }
.host-permission-items > summary::-webkit-details-marker { display: none; }
.host-permission-items > summary > span { width: 13px; height: 13px; transition: transform .15s; }
.host-permission-items[open] > summary > span { transform: rotate(180deg); }
.host-permission-item { margin-top: 8px; }
.host-room-limit { display: flex; align-items: center; gap: 6px; margin: 6px 0 0 26px; color: var(--ui-text-muted); font-size: 12px; }
.host-room-limit :deep(input) { width: 64px; }
</style>

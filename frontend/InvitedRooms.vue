<script>
import { ref as module_ref } from "vue";
const section_open = module_ref(true);
</script>

<script setup>
/** The sidebar's 外部房间: rooms on other computers this computer's AIs joined; a row opens it in the middle. */
import { computed, ref } from "vue";
import ConfirmDialog from "./ConfirmDialog.vue";
import { END_REASONS, PENDING_JOIN_ID, remaining_label, use_invited_rooms } from "./external-members.js";
import { t } from "./i18n.js";

const emit = defineEmits(["open"]);
const invited = use_invited_rooms();
const { records, page_open, selected_id, available, loaded, failure } = invited;
function open(id) { emit("open", id); }
// Rooms joined from one inviter often share a title: name the row by the inviting computer and when it was joined.
const pad = (value) => String(value).padStart(2, "0");
function row_name(record) {
  const at = new Date(record.joined_at || 0);
  const stamp = record.joined_at ? `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}` : "";
  return [record.machine_name || record.room_title || t("未命名房间"), stamp].filter(Boolean).join(" · ");
}

// Manual order, dragged by the grip as room rows are; kept in this browser. Rows not yet placed come first.
const ORDER_KEY = "codiscuss.invited_order";
function read_order() { try { return JSON.parse(localStorage.getItem(ORDER_KEY) || "[]"); } catch { return []; } }
const order = ref(read_order());
const ordered = computed(() => {
  const rank = new Map(order.value.map((id, index) => [id, index]));
  return records.value.map((record, index) => ({ record, index }))
    .sort((a, b) => (rank.get(a.record.id) ?? -1) - (rank.get(b.record.id) ?? -1) || a.index - b.index)
    .map(({ record }) => record);
});
function save_order(ids) {
  order.value = ids;
  try { localStorage.setItem(ORDER_KEY, JSON.stringify(ids)); } catch { /* order lasts this page only */ }
}
function move(id, target_id, after) {
  const ids = ordered.value.map((record) => record.id).filter((item) => item !== id);
  const at = target_id ? ids.indexOf(target_id) : -1;
  if (at < 0) return;
  ids.splice(after ? at + 1 : at, 0, id);
  save_order(ids);
}
function step(id, direction) {
  const ids = ordered.value.map((record) => record.id), at = ids.indexOf(id);
  const target = ids[at + direction];
  if (target) move(id, target, direction > 0);
}
const drag = ref(null);
function drop_target(event) {
  const row = document.elementFromPoint(event.clientX, event.clientY)?.closest("[data-invited-row]");
  if (!row || row.dataset.invitedRow === drag.value?.id) return null;
  const box = row.getBoundingClientRect();
  return { id: row.dataset.invitedRow, after: event.clientY > box.top + box.height / 2 };
}
function drag_start(event, id) {
  if (event.button !== 0) return;
  event.currentTarget.setPointerCapture(event.pointerId);
  drag.value = { id, target: null };
}
function drag_move(event) { if (drag.value) drag.value.target = drop_target(event); }
function drag_end() {
  const { id, target } = drag.value || {};
  drag.value = null;
  if (target) move(id, target.id, target.after);
}
const drop_class = (id) => drag.value?.target?.id === id ? (drag.value.target.after ? "drop-after" : "drop-before") : "";
// With none yet the heading (and its "+" to join by link or code) stands alone, no empty-state line (user 2026-11-17).
/** Ended (revoked, expired) and left records stay listed, dimmed, so their history can still be read. */
const ended = (record) => Boolean(record.status) && record.status !== "active";
/** The row's right-hand note: what needs attention first, then time left, as room rows show a time. */
function row_note(record) {
  if (ended(record)) return END_REASONS[record.status === "left" ? "left" : record.end_reason] || t("已结束");
  if (record.approvals?.length) return t("{count} 待确认", { count: record.approvals.length });
  if (record.paused) return t("已暂停");
  return remaining_label(record.expires_at);
}
// The row's menu, as room rows have: leave a room still going, delete the record of one that has ended (as the rail does).
const confirming = ref(null), confirm_open = ref(false);
const leave_items = [t("对方房间里的成员身份立即结束，之后点名不再唤醒你的 AI。"), t("你的 AI 已经读到的内容仍留在它的会话里。")];
const remove_items = [t("这台电脑上这个房间的记录、历史和运行文件会被删除，无法恢复。"), t("对方房间不受影响，你的 AI 自己的会话也会保留。")];
function ask(kind, record) { confirming.value = { kind, record }; confirm_open.value = true; }
function row_items(record) {
  if (!ended(record)) return [[{ label: t("退出房间"), icon: "i-lucide-log-out", color: "error", onSelect: () => ask("leave", record) }]];
  return [[{ label: record.leave_pending ? t("等退出通知送达后可删除") : t("删除记录"), icon: "i-lucide-trash-2", color: "error",
    disabled: Boolean(record.leave_pending), onSelect: () => ask("remove", record) }]];
}
function confirmed() {
  const { kind, record } = confirming.value || {};
  if (kind === "leave") invited.leave(record.id);
  else if (kind === "remove") invited.remove(record.id);
}
</script>

<template>
  <div class="channel-directory-heading channel-tools-heading">
    <button type="button" class="channel-section-toggle" :aria-expanded="section_open" @click="section_open = !section_open"><UIcon :name="section_open ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" />{{ t("外部房间") }}</button>
    <div v-if="available" class="channel-directory-actions">
      <UButton icon="i-lucide-plus" :aria-label="t('用邀请链接加入')" :title="t('用邀请链接加入')" size="xs" color="neutral" variant="ghost" @click="invited.start_join()" />
    </div>
  </div>
  <nav v-show="section_open" :aria-label="t('外部房间列表')" class="channel-room-list invited-list">
    <div v-if="invited.pending_join.value" class="channel-room-row" :class="{ active: page_open && selected_id === PENDING_JOIN_ID }" role="status">
      <button type="button" class="channel-room-select" :aria-current="page_open && selected_id === PENDING_JOIN_ID ? 'page' : undefined" @click="open(PENDING_JOIN_ID)"><UIcon name="i-lucide-loader-circle" class="animate-spin" /><span>{{ invited.pending_join.value.room_title || t("未命名房间") }}</span><small class="channel-room-time">{{ t("加入中…") }}</small></button>
    </div>
    <UContextMenu v-for="record in ordered" :key="record.id" :items="row_items(record)" :ui="{ content: 'channel-menu channel-topic-menu' }">
      <div class="channel-room-row" :class="[{ active: page_open && selected_id === record.id, 'is-ended': ended(record) }, drop_class(record.id)]" :data-invited-row="record.id">
        <button type="button" class="channel-room-grip" :aria-label="t('拖动 {name}', { name: row_name(record) })" :title="t('拖动排序；上下方向键移动')"
          @pointerdown="drag_start($event, record.id)" @pointermove="drag_move" @pointerup="drag_end" @pointercancel="drag = null"
          @keydown.up.prevent="step(record.id, -1)" @keydown.down.prevent="step(record.id, 1)"><UIcon name="i-lucide-grip-vertical" /></button>
        <button type="button" class="channel-room-select" :aria-current="page_open && selected_id === record.id ? 'page' : undefined" :title="record.room_title || undefined" @click="open(record.id)">
          <span>{{ row_name(record) }}</span>
          <small class="channel-room-time">{{ row_note(record) }}</small>
        </button>
        <div class="channel-room-actions">
          <UDropdownMenu :items="row_items(record)" :content="{ align: 'start', side: 'bottom', sideOffset: 6 }" :ui="{ content: 'channel-menu channel-topic-menu' }"><UButton icon="i-lucide-ellipsis" :aria-label="t('管理 {name}', { name: record.room_title || t('未命名房间') })" :title="t('更多操作')" size="xs" color="neutral" variant="ghost" /></UDropdownMenu>
        </div>
      </div>
    </UContextMenu>
    <p v-if="!available" class="channel-directory-empty">{{ t("连接本机服务后查看") }}</p>
    <template v-else-if="!records.length">
      <p v-if="failure" class="channel-directory-empty" role="alert">{{ failure }}</p>
      <p v-else-if="!loaded" class="channel-directory-empty" role="status">{{ t("读取中…") }}</p>
    </template>
  </nav>
  <ConfirmDialog v-model:open="confirm_open" :title="confirming?.kind === 'leave' ? t('退出「{room}」', { room: confirming.record.room_title || '' }) : t('删除「{room}」的记录', { room: confirming?.record.room_title || '' })"
    :items="confirming?.kind === 'leave' ? leave_items : remove_items" :confirm-label="confirming?.kind === 'leave' ? t('退出房间') : t('删除记录')" danger @confirm="confirmed" />
</template>

<style scoped>
/* The grip takes the room rows' 22px first column; the joining row has none, like the workflow list. */
.invited-list .channel-room-row:not(:has(> .channel-room-grip)) { grid-template-columns: minmax(0, 1fr) auto; padding-left: 8px; }
.invited-list .channel-room-row.is-ended .channel-room-select > span { opacity: .6; }
.invited-list .channel-room-time { max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* Touch screens have no hover to reveal the heading's "+": keep it shown. */
@media (hover: none), (pointer: coarse) { .channel-directory-actions { opacity: 1; pointer-events: auto; } }
</style>

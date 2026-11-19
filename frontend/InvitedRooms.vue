<script setup>
/** The sidebar's 被邀请的房间: rooms on other computers this computer's AIs joined; a row opens it in the middle. */
import { computed, ref } from "vue";
import ConfirmDialog from "./ConfirmDialog.vue";
import { END_REASONS, remaining_label, use_invited_rooms } from "./external-members.js";
import { t } from "./i18n.js";

const emit = defineEmits(["open"]);
const invited = use_invited_rooms();
const { records, page_open, selected_id, available, loaded, failure } = invited;
const section_open = ref(true);
function open(id) { emit("open", id); }
// With none yet the heading (and its "+" to join by link or code) stands alone, no empty-state line (user 2026-11-17).
/** Ended (revoked, expired) and left records stay listed, dimmed, so their history can still be read. */
const ended = (record) => Boolean(record.status) && record.status !== "active";
// Two AIs can join the same room: rows sharing a title name their AI so they can be told apart.
const shared_titles = computed(() => {
  const seen = new Map();
  for (const record of records.value) seen.set(record.room_title, (seen.get(record.room_title) || 0) + 1);
  return new Set([...seen].filter(([, count]) => count > 1).map(([title]) => title));
});
/** The row's right-hand note: what needs attention first, then which AI when the title alone is ambiguous, then time left. */
function row_note(record) {
  if (ended(record)) return END_REASONS[record.status === "left" ? "left" : record.end_reason] || t("已结束");
  if (record.approvals?.length) return t("{count} 待确认", { count: record.approvals.length });
  if (record.paused) return t("已暂停");
  if (shared_titles.value.has(record.room_title)) return record.member_label || record.member || remaining_label(record.expires_at);
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
    <button type="button" class="channel-section-toggle" :aria-expanded="section_open" @click="section_open = !section_open"><UIcon :name="section_open ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" />{{ t("被邀请的房间") }}</button>
    <div v-if="available" class="channel-directory-actions">
      <UButton icon="i-lucide-plus" :aria-label="t('用邀请链接加入')" :title="t('用邀请链接加入')" size="xs" color="neutral" variant="ghost" @click="invited.start_join()" />
    </div>
  </div>
  <nav v-show="section_open" :aria-label="t('被邀请的房间列表')" class="channel-room-list invited-list">
    <div v-if="invited.pending_join.value" class="channel-room-row" role="status">
      <span class="channel-room-select"><UIcon name="i-lucide-loader-circle" class="animate-spin" /><span>{{ invited.pending_join.value.room_title || t("未命名房间") }}</span><small class="channel-room-time">{{ t("加入中…") }}</small></span>
    </div>
    <UContextMenu v-for="record in records" :key="record.id" :items="row_items(record)" :ui="{ content: 'channel-menu channel-topic-menu' }">
      <div class="channel-room-row" :class="{ active: page_open && selected_id === record.id, 'is-ended': ended(record) }">
        <button type="button" class="channel-room-select" :aria-current="page_open && selected_id === record.id ? 'page' : undefined" :title="record.machine_name || undefined" @click="open(record.id)">
          <UIcon :name="ended(record) ? 'i-lucide-circle-slash' : record.approvals?.length ? 'i-lucide-bell-ring' : record.paused ? 'i-lucide-circle-pause' : 'i-lucide-monitor-smartphone'" :class="{ 'invited-alert': record.approvals?.length }" /><span>{{ record.room_title || t("未命名房间") }}</span>
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
.invited-alert { color: var(--ui-warning, #e0a33a); }
/* The room rows' grid keeps a 22px first column for the folder tree; these rows have no tree, like the workflow list. */
.invited-list .channel-room-row { grid-template-columns: minmax(0, 1fr) auto; padding-left: 8px; }
.invited-list .channel-room-row.is-ended .channel-room-select > span { opacity: .6; }
.invited-list .channel-room-time { max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* Touch screens have no hover to reveal the heading's "+": keep it shown. */
@media (hover: none), (pointer: coarse) { .channel-directory-actions { opacity: 1; pointer-events: auto; } }
</style>

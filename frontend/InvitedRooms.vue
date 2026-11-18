<script setup>
/** The sidebar's 被邀请的房间: rooms on other computers this computer's AIs joined; a row opens it in the middle. */
import { computed, ref } from "vue";
import { END_REASONS, TRUST_LABELS, remaining_label, use_invited_rooms } from "./external-members.js";
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
</script>

<template>
  <div class="channel-directory-heading channel-tools-heading">
    <button type="button" class="channel-section-toggle" :aria-expanded="section_open" @click="section_open = !section_open"><UIcon :name="section_open ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" />{{ t("被邀请的房间") }}</button>
    <div v-if="available" class="channel-directory-actions">
      <UButton icon="i-lucide-plus" :aria-label="t('用链接或配对码加入')" :title="t('用链接或配对码加入')" size="xs" color="neutral" variant="ghost" @click="invited.start_join()" />
    </div>
  </div>
  <nav v-show="section_open" :aria-label="t('被邀请的房间列表')" class="channel-room-list invited-list">
    <div v-for="record in records" :key="record.id" class="channel-room-row" :class="{ active: page_open && selected_id === record.id, 'is-ended': ended(record) }">
      <button type="button" class="channel-room-select" :aria-current="page_open && selected_id === record.id ? 'page' : undefined" :title="t('{computer} · {trust}', { computer: record.machine_name || '', trust: TRUST_LABELS[record.trust] || '' })" @click="open(record.id)">
        <UIcon :name="ended(record) ? 'i-lucide-circle-slash' : record.approvals?.length ? 'i-lucide-bell-ring' : record.paused ? 'i-lucide-circle-pause' : 'i-lucide-monitor-smartphone'" :class="{ 'invited-alert': record.approvals?.length }" /><span>{{ record.room_title || t("未命名房间") }}</span>
        <small class="channel-room-time">{{ row_note(record) }}</small>
      </button>
    </div>
    <p v-if="!available" class="channel-directory-empty">{{ t("连接本机服务后查看") }}</p>
    <template v-else-if="!records.length">
      <p v-if="failure" class="channel-directory-empty" role="alert">{{ failure }}</p>
      <p v-else-if="!loaded" class="channel-directory-empty" role="status">{{ t("读取中…") }}</p>
    </template>
  </nav>
</template>

<style scoped>
.invited-alert { color: var(--ui-warning, #e0a33a); }
/* The room rows' grid keeps a 22px first column for the folder tree; these rows have no tree, like the workflow list. */
.invited-list .channel-room-row { grid-template-columns: minmax(0, 1fr); padding-left: 8px; }
.invited-list .channel-room-row.is-ended .channel-room-select > span { opacity: .6; }
.invited-list .channel-room-time { max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* Touch screens have no hover to reveal the heading's "+": keep it shown. */
@media (hover: none), (pointer: coarse) { .channel-directory-actions { opacity: 1; pointer-events: auto; } }
</style>

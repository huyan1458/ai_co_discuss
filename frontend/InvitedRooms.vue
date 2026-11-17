<script setup>
/** The sidebar's 被邀请的房间: rooms on other computers this computer's AIs joined; a row opens it in the middle. */
import { ref } from "vue";
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
        <small class="channel-room-time">{{ ended(record) ? END_REASONS[record.status === 'left' ? 'left' : record.end_reason] || t('已结束') : record.approvals?.length ? t("{count} 待确认", { count: record.approvals.length }) : record.paused ? t("已暂停") : remaining_label(record.expires_at) }}</small>
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
/* Touch screens have no hover to reveal the heading's "+": keep it shown. */
@media (hover: none), (pointer: coarse) { .channel-directory-actions { opacity: 1; pointer-events: auto; } }
</style>

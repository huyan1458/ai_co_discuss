<script setup>
/**
 * Progress and result of importing room backups: one row per room as it is imported, and under it one short line per
 * member whose session was restored on this machine. It cannot be closed until the import ends.
 */
import { computed, inject } from "vue";

const open = defineModel("open", { type: Boolean, default: false });
const { view } = inject("discussion");
const progress = computed(() => view.value.import_progress || { done: false, rooms: [], errors: [] });
const STATUS = {
  importing: { icon: "i-lucide-loader-circle", label: "导入中" },
  imported: { icon: "i-lucide-check", label: "已导入" },
  skipped: { icon: "i-lucide-minus", label: "已存在，跳过" },
  failed: { icon: "i-lucide-x", label: "导入失败" },
};
const description = computed(() => {
  if (!progress.value.done) return "正在导入，请保持页面打开";
  const count = (status) => progress.value.rooms.filter((room) => room.status === status).length;
  const failed = count("failed") + progress.value.errors.length;
  return [`已导入 ${count("imported")} 个房间`, count("skipped") && `跳过 ${count("skipped")} 个`, failed && `失败 ${failed} 项`].filter(Boolean).join("，");
});
</script>

<template>
  <UModal v-model:open="open" title="导入房间" :description="description" :dismissible="progress.done" :close="progress.done"
    :ui="{ content: 'glass-panel studio-modal channel-folder-modal channel-import-modal', body: 'dialog-body' }">
    <template #body>
      <p v-if="!progress.done && !progress.rooms.length" class="channel-import-reading">正在读取备份文件…</p>
      <ul class="channel-import-list" aria-live="polite">
        <li v-for="(room, index) in progress.rooms" :key="index" class="channel-import-room" :class="`is-${room.status}`">
          <div class="channel-import-head">
            <UIcon :name="STATUS[room.status].icon" :class="{ 'animate-spin': room.status === 'importing' }" />
            <strong :title="room.title">{{ room.title }}</strong>
            <span>{{ STATUS[room.status].label }}</span>
          </div>
          <p v-if="room.error" role="alert" class="channel-import-error">{{ room.error }}</p>
          <ul v-if="room.members.length" class="channel-import-members">
            <li v-for="member in room.members" :key="member.name" :class="{ 'is-failed': member.failed }">
              <span>{{ member.name }}</span>{{ member.text }}
              <code v-if="member.resume" :title="`没有开着的原窗口时，在 ${member.resume.cwd} 运行`">{{ member.resume.command }}</code>
            </li>
          </ul>
          <p v-for="problem in room.problems" :key="problem" class="channel-import-error">{{ problem }}</p>
        </li>
      </ul>
      <p v-for="error in progress.errors" :key="error" role="alert" class="channel-import-error is-file">{{ error }}</p>
      <div class="dialog-actions">
        <UButton label="完成" class="channel-primary-button" :disabled="!progress.done" @click="open = false" />
      </div>
    </template>
  </UModal>
</template>

<style scoped>
.channel-import-reading { margin: 0; color: var(--ui-text-muted); font-size: 13px; }
.channel-import-list { display: flex; flex-direction: column; gap: 10px; margin: 0; padding: 0; list-style: none; }
.channel-import-head { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: 13px; }
.channel-import-head > span:first-child { flex-shrink: 0; width: 14px; height: 14px; color: var(--ui-text-dimmed); }
.is-imported .channel-import-head > span:first-child { color: var(--ui-success); }
.is-failed .channel-import-head > span:first-child { color: var(--ui-error); }
.channel-import-head strong { overflow: hidden; color: var(--ui-text-highlighted); font-weight: 500; white-space: nowrap; text-overflow: ellipsis; }
.channel-import-head > span:last-child { flex-shrink: 0; margin-inline-start: auto; color: var(--ui-text-muted); font-size: 12px; }
.channel-import-members { display: flex; flex-direction: column; gap: 4px; margin: 6px 0 0 22px; padding: 0; list-style: none; color: var(--ui-text-toned); font-size: 12px; line-height: 1.5; }
.channel-import-members span { margin-inline-end: 6px; color: var(--ui-text-highlighted); }
.channel-import-members code { display: block; width: fit-content; max-width: 100%; margin-top: 2px; padding: 1px 6px; overflow-wrap: anywhere; border-radius: 4px; background: var(--ui-bg-accented); color: var(--ui-text-muted); font-size: 11px; }
.channel-import-error { margin: 4px 0 0 22px; color: var(--ui-error); font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
.channel-import-error.is-file { margin-inline-start: 0; }
.channel-import-members .is-failed { color: var(--ui-error); }
</style>

<script setup>
/** The middle area with no room selected: the first message creates a room with the new-room panel's defaults. */
import { inject, ref } from "vue";
import { ENTER_SENDS } from "./enter-sends.js";

const { act, pending } = inject("discussion");
const draft = ref("");

/** Create the room and post the message; a failed creation keeps the draft here for another try. */
async function start() {
  const text = draft.value.trim();
  if (!text || pending.value) return;
  if (await act("quick_create", text)) draft.value = "";
}

/** Enter sends unless composing text or on touch screens, as in the room composer. */
function on_keydown(event) {
  if (!ENTER_SENDS || event.key !== "Enter" || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  start();
}
</script>

<template>
  <div class="room-welcome">
    <div class="room-welcome-hero"><UIcon name="i-lucide-messages-square" /><h2>想和 AI 一起做什么？</h2>
      <p>发出第一条消息就会新建房间，沿用新建面板的默认设置，由列表中第一位可唤醒的 AI 主持。</p></div>
    <form class="room-welcome-composer" @submit.prevent="start">
      <UTextarea v-model="draft" :rows="2" autoresize :maxrows="10" autofocus variant="none" placeholder="描述要一起做的事…" aria-label="第一条消息" class="w-full" :disabled="pending === 'quick_create'" @keydown="on_keydown" />
      <div class="room-welcome-actions">
        <UButton type="submit" icon="i-lucide-arrow-up" color="neutral" size="sm" aria-label="新建房间并发送" :loading="pending === 'quick_create'" :disabled="!draft.trim() || Boolean(pending)" />
      </div>
    </form>
  </div>
</template>

<style scoped>
.room-welcome { flex: 1; display: flex; flex-direction: column; width: 100%; max-width: var(--channel-reading-width); min-height: 0; margin-inline: auto; padding: 24px 24px 20px; }
.room-welcome-hero { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; text-align: center; }
.room-welcome-hero > [class*="icon"] { width: 34px; height: 34px; color: var(--ui-text-dimmed); }
.room-welcome-hero h2 { color: var(--ui-text-highlighted); font-size: 24px; font-weight: 600; }
.room-welcome-hero p { max-width: 460px; margin: 0; color: var(--ui-text-muted); font-size: 13px; line-height: 1.6; }
.room-welcome-composer { display: flex; flex-direction: column; gap: 6px; padding: 10px 10px 8px; border: 1px solid var(--ui-border); border-radius: 14px; background: var(--ui-bg-elevated); }
@media (max-width: 700px) { .room-welcome { padding: 16px 16px 12px; } }
.room-welcome-actions { display: flex; align-items: center; justify-content: flex-end; }
</style>

<script setup>
/**
 * A dashed system line above the question card, one per channel, when this room is waiting on the owner (a blocking
 * question or a goal awaiting confirmation) and that channel's last notice failed, so a silent failure does not leave the room
 * looking stuck. It reads the local service's channel status while the room waits, and hides once a notice goes out.
 */
import { computed, inject, onBeforeUnmount, ref, watch } from "vue";
import { t } from './i18n.js';
import { weixin_failure_text } from './weixin-failure.js';

const STATUS_POLL_MS = 60_000;
const props = defineProps({ room: { type: Object, required: true } });
const { bridge } = inject("discussion");
// Each bound channel whose latest send failed: `{id, label, text}`.
const failures = ref([]);
let timer = null;

const waiting = computed(() => (props.room.free?.questions || []).some(question => question.blocking && question.status === "waiting_user")
  || (props.room.goal_state?.goal?.status === "active" && props.room.goal_state.goal.phase === "pending"));

async function read() {
  try {
    const { channels } = await bridge.local_request("notify", {});
    failures.value = channels.filter(item => item.bound && item.last_failure).map(item => ({ id: item.id, label: item.label,
      text: item.id === "weixin" ? weixin_failure_text(item.last_failure) : item.last_failure.message }));
  } catch {
    // Without the local service there is no channel to report on.
    failures.value = [];
  }
}

watch(waiting, (now) => {
  clearInterval(timer);
  timer = null;
  if (!now) { failures.value = []; return; }
  read();
  timer = setInterval(read, STATUS_POLL_MS);
}, { immediate: true });
onBeforeUnmount(() => clearInterval(timer));
</script>

<template>
  <div v-for="item in waiting ? failures : []" :key="item.id" class="weixin-failure-notice" role="status">
    <UIcon name="i-lucide-bell-off" />
    <span>{{ t('{value1} 通知没有发出：{value2}', { value1: item.label, value2: item.text }) }}</span>
  </div>
</template>

<style scoped>
.weixin-failure-notice { display: flex; align-items: flex-start; gap: 8px; margin: 0 0 8px; padding: 6px 14px; border: 1px dashed var(--ui-border-accented); border-radius: 8px; color: var(--ui-text-muted); font-size: 12px; line-height: 1.5; }
.weixin-failure-notice > :first-child { flex-shrink: 0; margin-top: 2px; color: var(--ui-warning); }
</style>

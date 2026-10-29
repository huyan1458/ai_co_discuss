<script setup>
/** The session layer of the shared room board: progress, focus and discussion controls. */
import { computed, inject, ref, watch } from "vue";

const { view, bridge, act, pending } = inject("discussion");
const room = computed(() => view.value.room);
const session = computed(() => room.value.session);
const limits = computed(() => room.value.limits || {});
const elapsed = ref(0);
/** Count only while this session runs; each server snapshot accounts for pauses. */
watch(() => [session.value?.id, session.value?.status, limits.value.elapsed_seconds], ([_id, status, seconds], _previous, cleanup) => {
  elapsed.value = seconds || 0;
  if (status !== "active" || room.value.archived) return;
  const started = Date.now();
  const timer = setInterval(() => { elapsed.value = (seconds || 0) + Math.floor((Date.now() - started) / 1000); }, 1000);
  cleanup(() => clearInterval(timer));
}, { immediate: true });
const paused = computed(() => session.value?.status === "paused");
const turn = computed(() => room.value.current_turn);
const can_control = computed(() => Boolean(view.value.access?.can_manage) && !room.value.archived);
const ending = ref(false);
const focus_expanded = ref(false);
const FOCUS_PREVIEW_LENGTH = 90;
const focus = computed(() => turn.value?.question || room.value.focus || session.value?.goal || room.value.goal || "");
const status = computed(() => {
  if (room.value.archived) return { tone: "neutral", title: "已存档", detail: "" };
  if (paused.value) return { tone: "warning", title: "讨论已暂停", detail: "继续后由主持人重新安排；暂停期间不计时" };
  const requests = room.value.free?.requests || [];
  const failure = requests.find((request) => request.discussion_session_id === session.value?.id
    && request.cause_kind === "request_failed" && ["pending", "delivering"].includes(request.status));
  if (failure) {
    const failed = requests.find((request) => request.id === failure.cause_request_id);
    return { tone: "warning", title: "等待主持人处理", detail: `${bridge.display_name(failed?.member || "成员")} 送达失败，已交回主持人` };
  }
  return { tone: "primary", title: room.value.phase === "initial" ? "独立观点" : "讨论中",
    detail: turn.value ? `第 ${turn.value.round || (limits.value.completed_rounds || 0) + 1} 轮 · ${bridge.display_name(turn.value.expert)} 本次发言`
      : "等待主持人安排下一步" };
});
/** Keep elapsed time compact without inventing unavailable values. */
function duration(seconds) {
  if (seconds < 60) return `${seconds}秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分${String(seconds % 60).padStart(2, "0")}秒`;
  return `${Math.floor(seconds / 3600)}小时${Math.floor((seconds % 3600) / 60)}分`;
}
const meters = computed(() => {
  const rounds = limits.value.completed_rounds || 0;
  const max_rounds = limits.value.max_rounds || 0;
  const seconds = elapsed.value;
  const max_seconds = (limits.value.max_minutes || 0) * 60;
  return [
    { label: "轮次", text: max_rounds ? `${rounds} / ${max_rounds} 轮` : `已完成 ${rounds} 轮`, ratio: max_rounds ? rounds / max_rounds : null },
    { label: "用时", text: `${duration(seconds)}${max_seconds ? ` / ${duration(max_seconds)}` : ""}`, ratio: max_seconds ? seconds / max_seconds : null },
  ];
});
/** The owner's ending preserves room history and lets ordinary collaboration continue. */
async function finish() {
  if (await act("end_room_discussion")) ending.value = false;
}
</script>

<template>
  <section class="pb-status" :class="`is-${status.tone}`" aria-label="讨论状态">
    <div class="pb-status-line"><span class="pb-dot"></span><strong role="status">{{ status.title }}</strong></div>
    <p v-if="status.detail" class="pb-status-detail">{{ status.detail }}</p>
    <div class="pb-meters">
      <div v-for="meter in meters" :key="meter.label" class="pb-meter">
        <div class="pb-meter-label"><span>{{ meter.label }}</span><b>{{ meter.text }}</b></div>
        <div v-if="meter.ratio !== null" class="pb-bar"><i :style="{ width: `${Math.min(100, Math.round(meter.ratio * 100))}%` }"></i></div>
      </div>
    </div>
  </section>
  <section v-if="focus" class="pb-section" aria-label="当前焦点">
    <h4>当前焦点</h4><p class="pb-focus" :class="{ 'is-expanded': focus_expanded }">{{ focus }}</p>
    <button v-if="focus.length > FOCUS_PREVIEW_LENGTH" type="button" class="pb-link" @click="focus_expanded = !focus_expanded">{{ focus_expanded ? '收起' : '展开' }}</button>
  </section>
  <section v-if="!room.archived" class="pb-actions" aria-label="讨论操作">
    <UButton v-if="paused" icon="i-lucide-play" label="继续" size="sm" color="neutral" variant="outline" class="pb-action" :disabled="!can_control || !!pending" :loading="pending === 'restart_discussion'" @click="act('restart_discussion')" />
    <UButton v-else icon="i-lucide-pause" label="暂停" size="sm" color="neutral" variant="outline" class="pb-action" title="停止本次讨论执行，继续时由主持人重新安排" :disabled="!can_control || !!pending" :loading="pending === 'pause_discussion'" @click="act('pause_discussion')" />
    <UButton v-if="turn && !paused" icon="i-lucide-skip-forward" label="跳过" size="sm" color="neutral" variant="outline" class="pb-action" :title="`跳过 ${bridge.display_name(turn.expert)} 本次发言`" :disabled="!can_control || !!pending" :loading="pending === 'skip_turn'" @click="act('skip_turn')" />
    <UButton icon="i-lucide-flag" label="结束" size="sm" color="neutral" variant="outline" class="pb-action pb-end" :disabled="!can_control || !!pending" @click="ending = true" />
  </section>
  <UModal v-model:open="ending" title="结束讨论" description="当前发言安排会被取消，已有消息全部保留。" :ui="{ content: 'glass-panel studio-modal', body: 'dialog-body' }">
    <template #body><div class="progress-ending"><button type="button" class="progress-ending-option" :disabled="!!pending" @click="finish"><strong>结束讨论</strong><span>保留全部记录，房间回到自由协作；需要总结时可直接请主持人写一份。</span></button></div></template>
  </UModal>
</template>

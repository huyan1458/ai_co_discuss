<script setup>
import { t, locale } from './i18n.js';
/** The room's timeline: each discussion with the conclusion it ended with, and the free collaboration between them. */
import { computed, inject, ref } from "vue";

defineEmits(["detail"]);
const { view, bridge } = inject("discussion");
const STATUS = { active: { label: t('进行中'), color: "primary" }, paused: { label: t('已暂停'), color: "neutral" }, concluded: { label: t('已结束'), color: "neutral" } };
const room = computed(() => view.value.room);
const opened = ref(new Set());
const render = (text) => bridge.render_room_markdown(text);
const when = (value) => value ? new Date(value).toLocaleString(locale, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) : "";

/** Discussions with the free stretches around them, newest first; counts come from the room's own messages. */
const segments = computed(() => {
  const items = [];
  let through = 0;
  (room.value.discussions || []).forEach((discussion, index) => {
    if (discussion.messages_before > through) items.push({ key: `free-${index}`, kind: "free", count: discussion.messages_before - through });
    items.push({ key: `discussion-${discussion.id}`, kind: "discussion", number: index + 1, ...discussion, count: discussion.messages_through - discussion.messages_before, result: conclusion(discussion) });
    through = discussion.messages_through;
  });
  if ((room.value.message_count || 0) > through) items.push({ key: "free-tail", kind: "free", count: room.value.message_count - through });
  return items.reverse();
});

/**
 * An ended discussion shows its snapshot, which discussions before snapshots lack. The room's current consensus sits
 * above the record, so a running discussion and one whose snapshot is still that consensus point to it instead.
 */
function conclusion(discussion) {
  if (discussion.status !== "concluded") return null;
  if (discussion.state === null) return { missing: true };
  if (discussion.state === room.value.state_text && discussion.brief === (room.value.host_brief?.text || "") && (discussion.state || discussion.brief)) return { current: true };
  return { label: t('结论'), brief: discussion.brief, state: discussion.state, until: discussion.state_until };
}

function toggle(id) {
  const next = new Set(opened.value);
  next.has(id) ? next.delete(id) : next.add(id);
  opened.value = next;
}
</script>

<template>
  <section class="merged-section discussion-history" :aria-label="t('讨论记录')">
    <div class="page-heading"><div><h2>{{ t('讨论记录') }}</h2><p>{{ t('每场讨论及其结束时的结论，最新的在上；讨论之外的消息按段汇总。') }}</p></div></div>
    <p v-if="!room.discussions?.length" class="fine-print">{{ t('还没有开启过讨论。') }}</p>
    <ol class="history-timeline">
      <li v-for="item in segments" :key="item.key" :class="`is-${item.kind}`">
        <span class="history-dot" aria-hidden="true"></span>
        <p v-if="item.kind === 'free'" class="history-free">{{ t('讨论之外 · {value1} 条消息', { value1: item.count }) }}</p>
        <article v-else class="history-discussion">
          <header>
            <h3><small>{{ t('讨论 {value1}', { value1: item.number }) }}</small>{{ item.goal || t('未填写目标') }}</h3>
            <UBadge :color="STATUS[item.status]?.color || 'neutral'" variant="subtle" size="sm">{{ STATUS[item.status]?.label || item.status }}</UBadge>
          </header>
          <p class="history-meta">{{ t('{value1} 开始 · {value2} 条消息', { value1: when(item.created_at), value2: item.count }) }}<template v-if="item.status === 'concluded' && item.state !== null"> · {{ bridge.stop_reason_label(item) }}</template><template v-if="item.concluded_at"> {{ t('· {value1} 结束', { value1: when(item.concluded_at) }) }}</template></p>
          <p v-if="item.result?.current" class="fine-print">{{ t('结论即上方的当前共识。') }}</p>
          <p v-else-if="item.result?.missing" class="fine-print">{{ t('这场讨论结束于结论快照功能之前，没有保存当时的结论。') }}</p>
          <div v-else-if="item.result" class="history-conclusion">
            <small>{{ item.result.label }}<button v-if="item.result.until" type="button" class="subtle-link" @click="$emit('detail', item.result.until)">{{ t('整理至 #{value1}', { value1: item.result.until }) }}</button></small>
            <div v-if="item.result.brief" class="markdown-body" v-html="render(item.result.brief)"></div>
            <p v-else-if="!item.result.state" class="fine-print">{{ t('主持人没有留下简报或共识。') }}</p>
            <template v-if="item.result.state">
              <button type="button" class="history-toggle" :aria-expanded="opened.has(item.id)" @click="toggle(item.id)">{{ t('详细共识与进度') }}<UIcon :name="opened.has(item.id) ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" /></button>
              <div v-if="opened.has(item.id)" class="markdown-body history-state" v-html="render(item.result.state)"></div>
            </template>
          </div>
        </article>
      </li>
    </ol>
  </section>
</template>

<style scoped>
.history-timeline { position: relative; margin: 0; padding: 0 0 0 22px; list-style: none; }
.history-timeline::before { position: absolute; top: 8px; bottom: 8px; left: 5px; width: 1px; background: var(--ui-border); content: ""; }
.history-timeline li { position: relative; margin-bottom: 14px; }
.history-dot { position: absolute; top: 7px; left: -21px; width: 9px; height: 9px; border-radius: 50%; background: var(--ui-border-accented); }
.is-discussion .history-dot { top: 18px; background: var(--ui-primary); }
.history-free { margin: 0; padding: 2px 0; color: var(--ui-text-muted); font-size: 12px; }
.history-discussion { padding: 12px 16px; border: 1px solid var(--ui-border); border-radius: 8px; }
.history-discussion header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.history-discussion header { align-items: flex-start; }
/* A goal is often the user's whole request, so it keeps to two lines under the number label (three lines with the label). */
.history-discussion h3 { display: -webkit-box; overflow: hidden; margin: 0; color: var(--ui-text-highlighted); font-size: 14px; font-weight: 600; line-height: 1.6; -webkit-box-orient: vertical; -webkit-line-clamp: 3; }
.history-discussion h3 small { display: block; color: var(--ui-text-muted); font-size: 12px; font-weight: 400; }
.history-meta { margin: 4px 0 0; color: var(--ui-text-muted); font-size: 12px; }
.history-conclusion { margin-top: 12px; font-size: 13px; }
.history-conclusion small { display: flex; gap: 10px; margin-bottom: 4px; color: var(--ui-text-muted); }
.history-toggle { display: inline-flex; align-items: center; gap: 4px; margin-top: 8px; padding: 0; border: 0; background: none; color: var(--ui-text-muted); font-size: 12px; cursor: pointer; }
.history-state { margin-top: 6px; }
</style>

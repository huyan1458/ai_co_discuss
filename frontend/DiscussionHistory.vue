<script setup>
import { t, locale } from './i18n.js';
/** The room's discussions, newest first, each with the conclusion it ended with. */
import { computed, inject, ref } from "vue";

defineEmits(["detail"]);
const { view, bridge } = inject("discussion");
// An ended discussion needs no badge: its time span already says so.
const STATUS = { active: { label: t('进行中'), color: "primary" }, paused: { label: t('已暂停'), color: "neutral" } };
const room = computed(() => view.value.room);
const opened = ref(new Set());
const render = (text) => bridge.render_room_markdown(text);
const when = (value) => new Date(value).toLocaleString(locale, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
const clock = (value) => new Date(value).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hour12: false });

/** Discussions newest first; counts come from the room's own messages. */
const discussions = computed(() => (room.value.discussions || []).map((discussion, index) => ({ ...discussion, number: index + 1,
  count: discussion.messages_through - discussion.messages_before, result: conclusion(discussion) })).reverse());

/**
 * An ended discussion shows its snapshot, which discussions before snapshots lack. The room's current consensus sits
 * above the record, so one whose snapshot is still that consensus points to it instead.
 */
function conclusion(discussion) {
  if (discussion.status !== "concluded") return null;
  if (discussion.state === null || !(discussion.state || discussion.brief)) return { none: true };
  if (discussion.state === room.value.state_text && discussion.brief === (room.value.host_brief?.text || "")) return { current: true };
  return { brief: discussion.brief, state: discussion.state, until: discussion.state_until };
}

/** Start to end; the end drops its date when it is the same day. */
function time_span({ created_at: start, concluded_at: end }) {
  if (!end) return when(start);
  return `${when(start)} – ${new Date(start).toDateString() === new Date(end).toDateString() ? clock(end) : when(end)}`;
}

/** The discussion's facts on one line. */
function facts(item) {
  return [t('讨论 {value1}', { value1: item.number }), time_span(item), t('{count} 条消息', { count: item.count }),
    item.status === "concluded" && item.state !== null ? bridge.stop_reason_label(item) : "", item.result?.none ? t('未留结论') : ""].filter(Boolean).join(" · ");
}

function toggle(id) {
  const next = new Set(opened.value);
  next.has(id) ? next.delete(id) : next.add(id);
  opened.value = next;
}
</script>

<template>
  <section class="merged-section discussion-history" :aria-label="t('讨论记录')">
    <div class="page-heading"><h2>{{ t('讨论记录') }}<small v-if="!discussions.length">{{ t('暂无') }}</small></h2></div>
    <ol class="history-list">
      <li v-for="item in discussions" :key="item.id" class="history-discussion">
        <header>
          <h3>{{ item.goal || t('未填写目标') }}</h3>
          <UBadge v-if="STATUS[item.status]" :color="STATUS[item.status].color" variant="subtle" size="sm" class="history-status">{{ STATUS[item.status].label }}</UBadge>
        </header>
        <p class="history-meta">{{ facts(item) }}</p>
        <p v-if="item.result?.current" class="history-meta">{{ t('结论即上方的当前共识。') }}</p>
        <div v-else-if="item.result && !item.result.none" class="history-conclusion">
          <small>{{ t('结论') }}<button v-if="item.result.until" type="button" class="subtle-link" @click="$emit('detail', item.result.until)">{{ t('整理至 #{value1}', { value1: item.result.until }) }}</button></small>
          <div v-if="item.result.brief" class="markdown-body" v-html="render(item.result.brief)"></div>
          <template v-if="item.result.state">
            <button type="button" class="history-toggle" :aria-expanded="opened.has(item.id)" @click="toggle(item.id)">{{ t('详细共识与进度') }}<UIcon :name="opened.has(item.id) ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" /></button>
            <div v-if="opened.has(item.id)" class="markdown-body history-state" v-html="render(item.result.state)"></div>
          </template>
        </div>
      </li>
    </ol>
  </section>
</template>

<style scoped>
.history-list { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.history-discussion { min-width: 0; padding: 8px 12px; border: 1px solid var(--ui-border); border-radius: 8px; }
.history-discussion header { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
/* A goal is often the user's whole request, so it keeps to two lines. */
.history-discussion h3 { display: -webkit-box; overflow: hidden; margin: 0; color: var(--ui-text-highlighted); font-size: 13px; font-weight: 600; line-height: 1.5; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.history-status { flex-shrink: 0; white-space: nowrap; }
.history-meta { margin: 2px 0 0; color: var(--ui-text-muted); font-size: 12px; line-height: 1.5; }
.history-conclusion { margin-top: 6px; font-size: 13px; }
.history-conclusion small { display: flex; gap: 10px; margin-bottom: 2px; color: var(--ui-text-muted); }
.history-toggle { display: inline-flex; align-items: center; gap: 4px; margin-top: 4px; padding: 0; border: 0; background: none; color: var(--ui-text-muted); font-size: 12px; cursor: pointer; }
.history-state { margin-top: 4px; }
</style>

<script setup>
/** The room's timeline: each discussion with the conclusion it ended with, and the free collaboration between them. */
import { computed, inject, ref } from "vue";

defineEmits(["detail"]);
const { view, bridge } = inject("discussion");
const STATUS = { active: { label: "进行中", color: "primary" }, paused: { label: "已暂停", color: "neutral" }, concluded: { label: "已结束", color: "neutral" } };
const room = computed(() => view.value.room);
const opened = ref(new Set());
const render = (text) => window.discuss_markdown.render_markdown(text);
const when = (value) => value ? new Date(value).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) : "";

/** Discussions in order with the free stretches around them; counts come from the room's own messages. */
const segments = computed(() => {
  const items = [];
  let through = 0;
  (room.value.discussions || []).forEach((discussion, index) => {
    if (discussion.messages_before > through) items.push({ key: `free-${index}`, kind: "free", count: discussion.messages_before - through });
    items.push({ key: `discussion-${discussion.id}`, kind: "discussion", number: index + 1, ...discussion, count: discussion.messages_through - discussion.messages_before, result: conclusion(discussion) });
    through = discussion.messages_through;
  });
  if ((room.value.message_count || 0) > through) items.push({ key: "free-tail", kind: "free", count: room.value.message_count - through });
  return items;
});

/**
 * A running discussion shows the live brief once its host has written one (an older brief belongs to the previous
 * discussion); an ended one its snapshot, which discussions before snapshots lack.
 */
function conclusion(discussion) {
  const brief = room.value.host_brief;
  if (discussion.status !== "concluded") return brief?.text && brief.until > discussion.started_message_id ? { label: "当前简报", brief: brief.text } : null;
  if (discussion.state === null) return { missing: true };
  return { label: "结论", brief: discussion.brief, state: discussion.state, until: discussion.state_until };
}

function toggle(id) {
  const next = new Set(opened.value);
  next.has(id) ? next.delete(id) : next.add(id);
  opened.value = next;
}
</script>

<template>
  <section class="content-page discussion-history" role="tabpanel" aria-label="讨论记录">
    <div class="page-heading"><div><h2>讨论记录</h2><p>房间里开启过的每场讨论及其结束时的结论，自由协作的消息按段汇总。</p></div></div>
    <p v-if="!room.discussions?.length" class="fine-print">还没有开启过讨论。需要时在右栏点“开启讨论”。</p>
    <ol class="history-timeline">
      <li v-for="item in segments" :key="item.key" :class="`is-${item.kind}`">
        <span class="history-dot" aria-hidden="true"></span>
        <p v-if="item.kind === 'free'" class="history-free">自由协作 · {{ item.count }} 条消息</p>
        <article v-else class="history-discussion">
          <header>
            <h3>讨论 {{ item.number }} · {{ item.goal || '未填写目标' }}</h3>
            <UBadge :color="STATUS[item.status]?.color || 'neutral'" variant="subtle" size="sm">{{ STATUS[item.status]?.label || item.status }}</UBadge>
          </header>
          <p class="history-meta">{{ when(item.created_at) }} 开始 · {{ item.count }} 条消息<template v-if="item.status === 'concluded' && item.state !== null"> · {{ bridge.stop_reason_label(item) }}</template><template v-if="item.concluded_at"> · {{ when(item.concluded_at) }} 结束</template></p>
          <p v-if="item.result?.missing" class="fine-print">这场讨论结束于结论快照功能之前，没有保存当时的结论。</p>
          <div v-else-if="item.result" class="history-conclusion">
            <small>{{ item.result.label }}<button v-if="item.result.until" type="button" class="subtle-link" @click="$emit('detail', item.result.until)">整理至 #{{ item.result.until }}</button></small>
            <div v-if="item.result.brief" class="markdown-body" v-html="render(item.result.brief)"></div>
            <p v-else-if="!item.result.state" class="fine-print">主持人没有留下简报或共识。</p>
            <template v-if="item.result.state">
              <button type="button" class="history-toggle" :aria-expanded="opened.has(item.id)" @click="toggle(item.id)">详细共识与进度<UIcon :name="opened.has(item.id) ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" /></button>
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
.history-discussion h3 { margin: 0; font-size: 14px; font-weight: 600; color: var(--ui-text-highlighted); }
.history-meta { margin: 4px 0 0; color: var(--ui-text-muted); font-size: 12px; }
.history-conclusion { margin-top: 12px; font-size: 13px; }
.history-conclusion small { display: flex; gap: 10px; margin-bottom: 4px; color: var(--ui-text-muted); }
.history-toggle { display: inline-flex; align-items: center; gap: 4px; margin-top: 8px; padding: 0; border: 0; background: none; color: var(--ui-text-muted); font-size: 12px; cursor: pointer; }
.history-state { margin-top: 6px; }
</style>

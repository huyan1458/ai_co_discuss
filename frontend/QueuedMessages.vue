<script setup>
import { computed, inject, ref } from "vue";

/**
 * Owner messages the site holds while members work, listed above the composer like Codex's queued follow-ups:
 * each can be sent at once, deleted, edited in the composer or dragged into another order; a stop pauses the queue.
 */
const props = defineProps({ queue: { type: Object, required: true }, roomId: { type: String, required: true } });
const { view, act, pending } = inject("discussion");
const PREVIEW_DELAY_MS = 700;
const items = computed(() => props.queue.items || []);
const reorderable = computed(() => items.value.length > 1);
const sending = ref(null);
const dragged = ref(null);
const drop_target = ref(null);

/** Short text for the row: the message, else what it carries. */
function summary(item) {
  const text = item.text.replace(/\s+/g, " ").trim();
  if (text) return text;
  const images = item.attachments.filter((file) => file.content_type?.startsWith("image/")).length;
  return images === item.attachments.length ? `${images} 张图片` : `${item.attachments.length} 个附件`;
}

function thumbnail(item) {
  const image = item.attachments.find((file) => file.content_type?.startsWith("image/"));
  return image ? `/api/rooms/${props.roomId}/attachments/${image.id}/content` : "";
}

async function send_now(item) {
  sending.value = item.id;
  try { await act("queue_send", item.id); } finally { sending.value = null; }
}

function menu(item) {
  return [[
    { label: "编辑消息", icon: "i-lucide-pencil", onSelect: () => act("queue_edit", item) },
    { label: props.queue.queueing ? "关闭排队" : "开启排队", icon: "i-lucide-list-end", onSelect: () => act("queue_toggle", !props.queue.queueing) },
  ]];
}

function drag_start(item, event) {
  dragged.value = item.id;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", String(item.id));
}

function drag_over(item, event) {
  if (dragged.value === null || dragged.value === item.id) return;
  event.preventDefault();
  drop_target.value = item.id;
}

/** Move the dragged message to where it was dropped and send the whole order; the site refuses a stale one. */
function drop(item) {
  const ids = items.value.map((entry) => entry.id);
  const from = ids.indexOf(dragged.value), to = ids.indexOf(item.id);
  drag_end();
  if (from < 0 || to < 0 || from === to) return;
  ids.splice(to, 0, ids.splice(from, 1)[0]);
  act("queue_reorder", ids);
}

function drag_end() {
  dragged.value = null;
  drop_target.value = null;
}
</script>

<template>
  <div v-if="items.length" class="queued-messages" role="list" aria-label="排队消息">
    <div v-if="queue.paused" class="queued-row queued-paused-row">
      <UIcon name="i-lucide-pause" class="queued-leading" />
      <span class="queued-text">已暂停排队：你停止了运行</span>
      <UButton label="继续" icon="i-lucide-play" size="xs" color="neutral" variant="ghost" :disabled="!!pending" @click="act('queue_resume')" />
    </div>
    <TransitionGroup name="queued">
      <div v-for="(item, index) in items" :key="item.id" role="listitem" class="queued-row group"
        :class="{ 'is-dimmed': view.editing_queued === item.id || sending === item.id || dragged === item.id, 'is-drop-target': drop_target === item.id }"
        :draggable="reorderable && !item.failure" @dragstart="drag_start(item, $event)" @dragover="drag_over(item, $event)" @dragleave="drop_target === item.id && (drop_target = null)" @drop.prevent="drop(item)" @dragend="drag_end">
        <span class="queued-leading" :class="{ 'is-reorderable': reorderable }">
          <UIcon v-if="sending === item.id" name="i-lucide-loader-circle" class="animate-spin" />
          <template v-else>
            <UIcon v-if="reorderable" name="i-lucide-grip-vertical" class="queued-grip" aria-hidden="true" />
            <UIcon name="i-lucide-corner-down-right" class="queued-icon" />
          </template>
        </span>
        <UTooltip v-if="item.failure" :ui="{ content: 'queued-tooltip' }">
          <UIcon name="i-lucide-triangle-alert" class="queued-warning" />
          <template #content><p>这条排队消息未能发出：{{ item.failure }}</p><p class="queued-tooltip-remedy">重试、编辑或删除后队列继续</p></template>
        </UTooltip>
        <img v-if="thumbnail(item)" :src="thumbnail(item)" alt="图片附件" class="queued-thumbnail" draggable="false">
        <UTooltip :delay-duration="PREVIEW_DELAY_MS" :ui="{ content: 'queued-tooltip queued-preview' }">
          <span class="queued-text" tabindex="0" :aria-label="`排队消息 ${index + 1}：${summary(item).slice(0, 80)}`">{{ summary(item) }}</span>
          <template #content><div class="queued-preview-body">{{ item.text || summary(item) }}</div></template>
        </UTooltip>
        <span class="queued-actions">
          <UTooltip :text="item.failure ? '再次尝试发送这条排队消息' : '立即发出；接收者正忙时先打断它这一轮，再处理这条（无法打断的成员继续排队）'">
            <UButton :label="item.failure ? '重试' : '立即发送'" :icon="item.failure ? 'i-lucide-rotate-ccw' : 'i-lucide-corner-down-right'" size="xs" color="neutral" variant="ghost"
              :disabled="!!pending || sending !== null" @click.stop="send_now(item)" />
          </UTooltip>
          <UButton icon="i-lucide-trash-2" size="xs" color="neutral" variant="ghost" aria-label="删除排队消息" :disabled="sending === item.id || !!pending" @click.stop="act('queue_delete', item.id)" />
          <UDropdownMenu :items="menu(item)" :content="{ align: 'end', sideOffset: 4 }" :ui="{ content: 'channel-menu' }">
            <UButton icon="i-lucide-ellipsis" size="xs" color="neutral" variant="ghost" aria-label="排队消息操作" :disabled="sending === item.id" />
          </UDropdownMenu>
        </span>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.queued-messages { display: flex; flex-direction: column; gap: 1px; max-height: 30dvh; overflow-x: hidden; overflow-y: auto; margin-bottom: 6px; }
.queued-row { display: flex; align-items: center; gap: 6px; min-height: 32px; padding: 2px 6px 2px 10px; border-radius: 6px; font-size: 13px; color: var(--ui-text-muted); transition: opacity .18s, background .12s; }
.queued-row:hover { background: #ffffff08; }
.queued-row.is-dimmed { opacity: .6; }
.queued-row.is-drop-target { box-shadow: inset 0 2px 0 var(--channel-accent, var(--ui-primary)); }
.queued-leading { position: relative; display: inline-flex; flex-shrink: 0; align-items: center; justify-content: center; width: 16px; height: 16px; color: color-mix(in srgb, var(--ui-text-dimmed) 70%, transparent); }
.queued-leading.is-reorderable { cursor: grab; }
.queued-grip { position: absolute; left: -10px; width: 12px; opacity: 0; transition: opacity .12s; }
.queued-row:hover .queued-grip { opacity: 1; }
.queued-warning { flex-shrink: 0; color: var(--ui-warning); }
.queued-thumbnail { flex-shrink: 0; width: 24px; height: 24px; border: 1px solid var(--ui-border-accented); border-radius: 4px; object-fit: cover; }
.queued-text { flex: 1; min-width: 0; overflow: hidden; color: var(--ui-text-toned); white-space: nowrap; text-overflow: ellipsis; user-select: text; }
.queued-actions { display: flex; flex-shrink: 0; align-items: center; gap: 2px; }
.queued-paused-row .queued-text { color: var(--ui-text-muted); }
.queued-enter-active, .queued-leave-active { overflow: hidden; transition: max-height .18s, opacity .18s; }
.queued-enter-from, .queued-leave-to { max-height: 0; opacity: 0; }
.queued-enter-to, .queued-leave-from { max-height: 40px; opacity: 1; }
:global(.queued-tooltip) { max-width: 360px; text-align: center; white-space: normal; line-height: 1.4; }
:global(.queued-tooltip-remedy) { opacity: .65; }
:global(.queued-preview) { text-align: left; }
:global(.queued-preview-body) { max-height: 40vh; overflow-y: auto; overscroll-behavior: contain; white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; }
</style>

<script setup>
import { computed, inject, onBeforeUnmount, ref } from "vue";

/**
 * Owner messages the site holds while members work, listed above the composer like Codex's queued follow-ups:
 * each can be sent at once, deleted, edited in the composer or dragged into another order; a stop pauses the queue.
 * A mouse drags a row at once; a finger holds it first, so a swipe still scrolls the list.
 */
const props = defineProps({ queue: { type: Object, required: true }, roomId: { type: String, required: true } });
const { view, act, pending } = inject("discussion");
const PREVIEW_DELAY_MS = 700;
const LONG_PRESS_MS = 350;
const MOUSE_DRAG_THRESHOLD_PX = 4;
const TOUCH_SLOP_PX = 8;
const HAPTIC_MS = 10;
const sending = ref(null);
// The order shown between a drop and the site's answer, so the row stays where it was dropped.
const local_order = ref(null);
const list = ref(null);
// The drag in progress: the row, its start, where it would land, and each row's slot measured at the start.
const drag = ref(null);
let press = null;

const items = computed(() => {
  const queued = props.queue.items || [];
  if (!local_order.value) return queued;
  const by_id = new Map(queued.map((item) => [item.id, item]));
  const ordered = local_order.value.map((id) => by_id.get(id)).filter(Boolean);
  return [...ordered, ...queued.filter((item) => !local_order.value.includes(item.id))];
});
const reorderable = computed(() => items.value.length > 1 && !pending.value);

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

/** Arm a drag from a row: a mouse starts once it moves, a finger once it has held still for a moment. */
function press_row(item, event) {
  if (!reorderable.value || event.button !== 0 || event.target.closest("button, a, [role=menuitem]")) return;
  press = { id: item.id, row: event.currentTarget, pointer: event.pointerId, x: event.clientX, y: event.clientY, touch: event.pointerType !== "mouse", timer: 0 };
  if (press.touch) press.timer = setTimeout(begin_drag, LONG_PRESS_MS);
  window.addEventListener("pointermove", move_pointer);
  window.addEventListener("pointerup", end_pointer);
  window.addEventListener("pointercancel", cancel_pointer);
  // Only a held finger blocks scrolling; the listener must not be passive to do so.
  window.addEventListener("touchmove", hold_scroll, { passive: false });
}

/** Measure every row and lift the pressed one. */
function begin_drag() {
  clearTimeout(press.timer);
  const rows = [...list.value.querySelectorAll("[data-queued-id]")];
  const slots = rows.map((element) => { const box = element.getBoundingClientRect(); return { id: Number(element.dataset.queuedId), top: box.top, height: box.height }; });
  const from = slots.findIndex((slot) => slot.id === press.id);
  if (from < 0) return release();
  press.row.setPointerCapture?.(press.pointer);
  if (press.touch) navigator.vibrate?.(HAPTIC_MS);
  window.getSelection()?.removeAllRanges();
  drag.value = { id: press.id, from, to: from, offset: 0, slots, start: press.y };
}

function move_pointer(event) {
  if (!press || event.pointerId !== press.pointer) return;
  const distance = Math.hypot(event.clientX - press.x, event.clientY - press.y);
  if (!drag.value) {
    if (press.touch) { if (distance > TOUCH_SLOP_PX) release(); return; }
    if (distance < MOUSE_DRAG_THRESHOLD_PX) return;
    begin_drag();
    if (!drag.value) return;
  }
  const { slots, from } = drag.value;
  const first = slots[0], last = slots[slots.length - 1];
  // The row stays within the list; it lands where its middle crosses another row's middle.
  const offset = Math.min(Math.max(event.clientY - drag.value.start, first.top - slots[from].top), last.top + last.height - slots[from].top - slots[from].height);
  const middle = slots[from].top + offset + slots[from].height / 2;
  let to = slots.findIndex((slot) => middle < slot.top + slot.height / 2);
  if (to < 0) to = slots.length - 1;
  drag.value = { ...drag.value, offset, to };
}

/** Shift for one row while dragging: the lifted row follows the pointer; rows it passed make room for it. */
function shift(item) {
  const state = drag.value;
  if (!state) return undefined;
  if (item.id === state.id) return { transform: `translateY(${state.offset}px)`, transition: "none" };
  const index = state.slots.findIndex((slot) => slot.id === item.id);
  const room = state.slots[state.from].height;
  if (state.from < state.to && index > state.from && index <= state.to) return { transform: `translateY(${-room}px)` };
  if (state.from > state.to && index < state.from && index >= state.to) return { transform: `translateY(${room}px)` };
  return undefined;
}

/** Drop the row where it is and send the whole order; the site refuses a stale one. */
async function end_pointer(event) {
  if (!press || event.pointerId !== press.pointer) return;
  const state = drag.value;
  release();
  if (!state || state.from === state.to) return;
  const ids = state.slots.map((slot) => slot.id);
  ids.splice(state.to, 0, ids.splice(state.from, 1)[0]);
  local_order.value = ids;
  try { await act("queue_reorder", ids); } finally { local_order.value = null; }
}

function cancel_pointer(event) {
  if (press && event.pointerId === press.pointer) release();
}

function hold_scroll(event) {
  if (drag.value && event.cancelable) event.preventDefault();
}

function release() {
  if (press) clearTimeout(press.timer);
  press = null;
  drag.value = null;
  window.removeEventListener("pointermove", move_pointer);
  window.removeEventListener("pointerup", end_pointer);
  window.removeEventListener("pointercancel", cancel_pointer);
  window.removeEventListener("touchmove", hold_scroll);
}

onBeforeUnmount(release);
</script>

<template>
  <div v-if="items.length" ref="list" class="queued-messages" :class="{ 'is-dragging': drag }" role="list" aria-label="排队消息">
    <div v-if="queue.paused" class="queued-row queued-paused-row">
      <UIcon name="i-lucide-pause" class="queued-leading" />
      <span class="queued-text">已暂停排队：你停止了运行</span>
      <UButton label="继续" icon="i-lucide-play" size="xs" color="neutral" variant="ghost" :disabled="!!pending" @click="act('queue_resume')" />
    </div>
    <TransitionGroup name="queued">
      <div v-for="(item, index) in items" :key="item.id" role="listitem" :data-queued-id="item.id" class="queued-row"
        :class="{ 'is-dimmed': view.editing_queued === item.id || sending === item.id, 'is-lifted': drag?.id === item.id, 'is-failed': item.failure, 'is-reorderable': reorderable }"
        :style="shift(item)" @pointerdown="press_row(item, $event)" @contextmenu="drag && $event.preventDefault()">
        <UTooltip :disabled="!reorderable || !!drag" :text="'拖动调整顺序（手机上长按）'" :delay-duration="PREVIEW_DELAY_MS">
          <span class="queued-leading" aria-hidden="true">
            <UIcon v-if="sending === item.id" name="i-lucide-loader-circle" class="animate-spin" />
            <UIcon v-else-if="item.failure" name="i-lucide-triangle-alert" class="queued-warning" />
            <UIcon v-else name="i-lucide-list-end" />
          </span>
        </UTooltip>
        <img v-if="thumbnail(item)" :src="thumbnail(item)" alt="图片附件" class="queued-thumbnail" draggable="false">
        <UTooltip :disabled="!!drag" :delay-duration="PREVIEW_DELAY_MS" :ui="{ content: 'queued-tooltip queued-preview' }">
          <span class="queued-text" tabindex="0" :aria-label="`排队消息 ${index + 1}：${summary(item).slice(0, 80)}`">{{ summary(item) }}</span>
          <template #content>
            <p v-if="item.failure" class="queued-failure">未能发出：{{ item.failure }}<br><span class="queued-tooltip-remedy">重试、编辑或删除后队列继续</span></p>
            <div class="queued-preview-body">{{ item.text || summary(item) }}</div>
          </template>
        </UTooltip>
        <span class="queued-actions">
          <UTooltip :text="item.failure ? '再次尝试发送这条排队消息' : '立即发出；接收者正忙时先打断它这一轮，再处理这条（无法打断的成员继续排队）'" :ui="{ content: 'queued-tooltip' }">
            <UButton :label="item.failure ? '重试' : '立即发送'" :icon="item.failure ? 'i-lucide-rotate-ccw' : 'i-lucide-corner-down-right'" size="xs" color="neutral" variant="ghost" class="queued-action"
              :disabled="!!pending || sending !== null" @click.stop="send_now(item)" />
          </UTooltip>
          <UButton icon="i-lucide-trash-2" size="xs" color="neutral" variant="ghost" class="queued-action" aria-label="删除排队消息" :disabled="sending === item.id || !!pending" @click.stop="act('queue_delete', item.id)" />
          <!-- Focus goes to the composer for 编辑消息, not back to this button. -->
          <UDropdownMenu :items="menu(item)" :content="{ align: 'end', sideOffset: 4, onCloseAutoFocus: (event) => event.preventDefault() }" :ui="{ content: 'channel-menu' }">
            <UButton icon="i-lucide-ellipsis" size="xs" color="neutral" variant="ghost" class="queued-action" aria-label="排队消息操作" :disabled="sending === item.id" />
          </UDropdownMenu>
        </span>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
/* A tray tucked behind the composer's top edge, a little narrower than it, as in Codex. */
.queued-messages { position: relative; display: flex; flex-direction: column; max-height: 30dvh; margin: 0 12px -12px; padding: 4px 4px 16px; overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain;
  border: 1px solid var(--ui-border); border-bottom: 0; border-radius: 12px 12px 0 0; background: var(--ui-bg-elevated); }
.queued-messages.is-dragging { overflow-y: hidden; }
.queued-row { position: relative; display: flex; align-items: center; gap: 8px; min-height: 32px; padding: 0 2px 0 8px; border-radius: 8px; font-size: 13px; color: var(--ui-text-muted);
  transition: transform .16s ease, opacity .18s, background .12s; -webkit-touch-callout: none; user-select: none; }
.queued-row:hover { background: var(--ui-bg-accented); }
.queued-row.is-reorderable { cursor: grab; }
.queued-row.is-dimmed { opacity: .55; }
.queued-row.is-lifted { z-index: 1; cursor: grabbing; background: var(--ui-bg-accented); box-shadow: 0 6px 18px #0004, 0 0 0 1px var(--ui-border-accented); }
.queued-messages.is-dragging .queued-row { cursor: grabbing; }
.queued-messages.is-dragging .queued-row:not(.is-lifted):hover { background: none; }
.queued-leading { display: inline-flex; flex-shrink: 0; align-items: center; justify-content: center; width: 16px; height: 16px; color: var(--ui-text-dimmed); }
.queued-row.is-reorderable:hover .queued-leading, .queued-row.is-lifted .queued-leading { color: var(--ui-text-muted); }
.queued-warning { color: var(--ui-warning); }
.queued-thumbnail { flex-shrink: 0; width: 22px; height: 22px; border: 1px solid var(--ui-border-accented); border-radius: 4px; object-fit: cover; }
.queued-text { flex: 1; min-width: 0; overflow: hidden; color: var(--ui-text-toned); white-space: nowrap; text-overflow: ellipsis; outline: none; }
.queued-row.is-failed .queued-text { color: var(--ui-text-muted); }
.queued-actions { display: flex; flex-shrink: 0; align-items: center; gap: 0; }
.queued-action { color: var(--ui-text-dimmed); }
.queued-action:hover:not(:disabled) { color: var(--ui-text-highlighted); }
.queued-paused-row { cursor: default; }
.queued-paused-row .queued-text { color: var(--ui-text-muted); }
.queued-move { transition: transform .16s ease; }
.queued-enter-active, .queued-leave-active { overflow: hidden; transition: max-height .18s, opacity .18s; }
.queued-enter-from, .queued-leave-to { max-height: 0; opacity: 0; }
.queued-enter-to, .queued-leave-from { max-height: 40px; opacity: 1; }
:global(.queued-tooltip) { max-width: 360px; text-align: center; white-space: normal; line-height: 1.4; }
:global(.queued-tooltip-remedy) { opacity: .65; }
:global(.queued-preview) { text-align: left; }
:global(.queued-failure) { margin-bottom: 4px; color: var(--ui-warning); }
:global(.queued-preview-body) { max-height: 40vh; overflow-y: auto; overscroll-behavior: contain; white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; }
</style>

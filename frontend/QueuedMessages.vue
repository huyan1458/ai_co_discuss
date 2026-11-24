<script setup>
import { t } from './i18n.js';
import { computed, inject, nextTick, onBeforeUnmount, reactive, ref, watch } from "vue";
import UploadPercent from "./UploadPercent.vue";

/**
 * Owner messages the site holds while members work, listed above the composer like Codex's queued follow-ups:
 * each can be sent at once, deleted, edited in the composer or dragged into another order; a stop pauses the queue.
 * A mouse drags a row at once; a finger holds it first, so a swipe still scrolls the list.
 */
const props = defineProps({ queue: { type: Object, required: true }, roomId: { type: String, required: true } });
const { bridge, view, act } = inject("discussion");
const PREVIEW_DELAY_MS = 700;
const LONG_PRESS_MS = 350;
const MOUSE_DRAG_THRESHOLD_PX = 4;
const TOUCH_SLOP_PX = 8;
const HAPTIC_MS = 10;
const TRAY_RISE_MS = 200;
const TRAY_RISE_EASING = "cubic-bezier(.2, .8, .2, 1)";
const sending = ref(null);
// The order shown between a drop and the site's answer, so the row stays where it was dropped.
const local_order = ref(null);
const list = ref(null);
// The drag in progress: the row, its start, where it would land, and each row's slot measured at the start.
const drag = ref(null);
// How far the lifted row follows the pointer: written straight to the row, so a move re-renders nothing.
let drag_offset = 0;
let press = null, tray_rise = null;

// The row being sent, or already moved to the composer for editing, leaves the tray at once, even if a refresh in flight
// still lists it; a refusal brings it back.
const items = computed(() => {
  const queued = (props.queue.items || []).filter((item) => item.id !== sending.value && !view.value.queue_taking?.includes(item.id));
  if (!local_order.value) return queued;
  const by_id = new Map(queued.map((item) => [item.id, item]));
  const ordered = local_order.value.map((id) => by_id.get(id)).filter(Boolean);
  return [...ordered, ...queued.filter((item) => !local_order.value.includes(item.id))];
});
const reorderable = computed(() => items.value.length > 1);

/** Short text for the row: the message, else what it carries. */
function summary(item) {
  const text = item.text.replace(/\s+/g, " ").trim();
  if (text) return text;
  const images = item.attachments.filter((file) => file.content_type?.startsWith("image/")).length;
  return images === item.attachments.length ? t('{value1} 张图片', { value1: images }) : t('{value1} 个附件', { value1: item.attachments.length });
}

/** The row's first image, if it carries one. */
const image_of = (item) => item.attachments.find((file) => file.content_type?.startsWith("image/")) || null;
// Thumbnail addresses by attachment id: the computer's rooms read the file through the relay, so it is fetched as the
// row appears; until it is there, or if it cannot be read, the row shows an image icon instead.
const thumbnails = reactive({});
watch(items, (rows) => {
  for (const image of rows.map(image_of)) {
    if (!image || image.id in thumbnails) continue;
    thumbnails[image.id] = "";
    bridge.attachment_url({ room_id: props.roomId, id: image.id }).then((url) => { thumbnails[image.id] = url; }).catch(() => {});
  }
}, { immediate: true });

/**
 * A new row joins at the bottom and the rows before it move up (user 2026-11-18, #4544). The tray takes its new height at
 * once and starts that much lower, behind the composer, then rises: only a transform moves, so nothing is laid out again.
 */
function rise_tray(height_before) {
  const tray = list.value;
  if (!tray) return;
  if (tray.scrollHeight > tray.clientHeight) tray.scrollTo({ top: tray.scrollHeight, behavior: "smooth" });
  const grown = tray.offsetHeight - height_before;
  if (grown <= 0 || document.documentElement.dataset.motion === "off") return;
  const under_way = tray_rise ? new DOMMatrix(getComputedStyle(tray).transform).m42 : 0;
  tray_rise?.cancel();
  tray_rise = tray.animate([{ transform: `translateY(${grown + under_way}px)` }, { transform: "translateY(0)" }], { duration: TRAY_RISE_MS, easing: TRAY_RISE_EASING });
  tray_rise.onfinish = () => { tray_rise = null; };
}

const pending_rows = computed(() => view.value.queueing_previews.map(card => ({
  card, upload: card.files.find(file => !file.uploaded),
})));
watch(() => items.value.length + pending_rows.value.length, (count, before) => {
  if (count <= before) return;
  const height_before = list.value?.offsetHeight || 0;
  nextTick(() => rise_tray(height_before));
});

async function send_now(item) {
  sending.value = item.id;
  try { await act("queue_send", item.id); } finally { sending.value = null; }
}

/** The send-now button says what it will do (send, interject into a busy recipient's turn, or interrupt it first); PC shows icon + label while phones hide the label and keep a wider tap target (user 2026-11-24, #10245). */
function send_action(item) {
  if (item.failure) return { label: t('重试'), tip: t('再次尝试发送这条排队消息'), icon: "i-lucide-rotate-ccw" };
  if (item.send_mode === "steer") return { label: t('插话'), tip: t('接收者正在执行：把这条插进它这一轮，不中断已做的工作'), icon: "i-lucide-corner-down-right" };
  if (item.send_mode === "interrupt") return { label: t('打断并发送'), tip: t('接收者正在执行且不支持插话：先打断它这一轮，再连同这条一起处理'), icon: "i-lucide-corner-down-right" };
  if (item.send_mode === "wait") return { label: t('立即发送'), tip: t('接收者正在执行，既不能插话也不能打断，这条会继续排队'), icon: "i-lucide-corner-down-right" };
  return { label: t('立即发送'), tip: t('立即发出'), icon: "i-lucide-corner-down-right" };
}

function menu(item) {
  return [[
    // A share of a message already posted is not a draft: editing it would post it again to those who already have it.
    ...item.message_id || item.relay_room ? [] : [{ label: t('编辑消息'), icon: "i-lucide-pencil", onSelect: () => act("queue_edit", item) }],
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
  drag_offset = 0;
  drag.value = { id: press.id, from, to: from, slots, start: press.y };
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
  // Both ways count only rows whose middle the dragged middle has reached; the clamp lets it reach the end rows exactly.
  const middle = slots[from].top + offset + slots[from].height / 2;
  const centre = (slot) => slot.top + slot.height / 2;
  let to = from;
  if (offset < 0) { const above = slots.findIndex((slot, index) => index < from && middle <= centre(slot)); if (above >= 0) to = above; }
  else slots.forEach((slot, index) => { if (index > from && middle >= centre(slot)) to = index; });
  drag_offset = offset;
  press.row.style.transform = `translateY(${offset}px)`;
  // The other rows only change when the landing place does.
  if (to !== drag.value.to) drag.value = { ...drag.value, to };
}

/** Shift for one row while dragging: the lifted row follows the pointer; rows it passed make room for it. */
function shift(item) {
  const state = drag.value;
  if (!state) return undefined;
  if (item.id === state.id) return { transform: `translateY(${drag_offset}px)`, transition: "none" };
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

/** A lifted row keeps the finger: bound on the tray from the start, since iOS ignores a listener added once the touch began. */
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
}

onBeforeUnmount(() => { release(); tray_rise?.cancel(); });
</script>

<template>
  <div v-if="items.length || pending_rows.length" ref="list" class="queued-messages" :class="{ 'is-dragging': drag }" role="list" :aria-label="t('排队消息')" @touchmove="hold_scroll">
    <div v-if="queue.paused" class="queued-row queued-paused-row">
      <UIcon name="i-lucide-pause" class="queued-leading" />
      <span class="queued-text">{{ t('已暂停排队：你停止了运行') }}</span>
      <UButton :label="t('继续')" icon="i-lucide-play" size="xs" color="neutral" variant="ghost" @click="act('queue_resume')" />
    </div>
    <!-- Rows glide only to a dropped order: when the row just sent turns into its queued row, nothing above it has moved. -->
    <TransitionGroup name="queued" :move-class="local_order ? 'queued-move' : 'queued-still'">
      <div v-for="(item, index) in items" :key="item.id" role="listitem" :data-queued-id="item.id" class="queued-row"
        :class="{ 'is-dimmed': sending === item.id || view.queue_reading === item.id, 'is-lifted': drag?.id === item.id, 'is-failed': item.failure, 'is-reorderable': reorderable }"
        :style="shift(item)" @pointerdown="press_row(item, $event)" @contextmenu="drag && $event.preventDefault()">
        <UTooltip :disabled="!reorderable || !!drag" :text="t('拖动调整顺序（手机上长按）')" :delay-duration="PREVIEW_DELAY_MS">
          <span class="queued-leading" aria-hidden="true">
            <UIcon v-if="sending === item.id || view.queue_reading === item.id" name="i-lucide-loader-circle" class="animate-spin" />
            <UIcon v-else-if="item.failure" name="i-lucide-triangle-alert" class="queued-warning" />
            <UIcon v-else name="i-lucide-list-end" />
          </span>
        </UTooltip>
        <template v-if="image_of(item)">
          <img v-if="thumbnails[image_of(item).id]" :src="thumbnails[image_of(item).id]" :alt="t('图片附件')" class="queued-thumbnail" draggable="false" @error="thumbnails[image_of(item).id] = ''">
          <span v-else class="queued-thumbnail queued-thumbnail-icon" :aria-label="t('图片附件')"><UIcon name="i-lucide-image" /></span>
        </template>
        <UTooltip :disabled="!!drag" :delay-duration="PREVIEW_DELAY_MS" :ui="{ content: 'queued-tooltip queued-preview' }">
          <span class="queued-text" tabindex="0" :aria-label="t('排队消息 {value1}：{value2}', { value1: index + 1, value2: summary(item).slice(0, 80) })"><strong v-if="item.relay_room" class="queued-relay-source">{{ item.relay_relation === 'parent' ? t('父房间「{room}」主持 {host}', { room: item.relay_title ?? t('已删除的房间'), host: item.relay_host }) : t('子房间「{room}」主持 {host}', { room: item.relay_title ?? t('已删除的房间'), host: item.relay_host }) }} · </strong>{{ summary(item) }}</span>
          <template #content>
            <p v-if="item.failure" class="queued-failure">{{ t('未能发出：{value1}', { value1: item.failure }) }}<br><span class="queued-tooltip-remedy">{{ t('重试、编辑或删除后队列继续') }}</span></p>
            <div class="queued-preview-body">{{ item.text || summary(item) }}</div>
          </template>
        </UTooltip>
        <span v-if="item.message_id && !item.failure && sending !== item.id" class="queued-sending-status">{{ t('#{value1} 已发出，等 {value2} 空闲后交给它', { value1: item.message_id, value2: item.waiting_for.map((name) => bridge.display_name(name)).join('、') }) }}</span>
        <span v-else-if="view.queue_reading === item.id" class="queued-sending-status" role="status">{{ t('正在取回附件…') }}</span>
        <span v-else-if="sending === item.id || item.failure" class="queued-sending-status">{{ sending === item.id ? t('投递中') : t('失败') }}</span>
        <span class="queued-actions">
          <UTooltip v-for="action in [send_action(item)]" :key="action.label" :text="action.tip" :ui="{ content: 'queued-tooltip' }">
            <UButton :label="action.label" :aria-label="action.label" :icon="action.icon" size="xs" color="neutral" variant="ghost" class="queued-action queued-send-now"
              :disabled="sending !== null" @click.stop="send_now(item)" />
          </UTooltip>
          <UButton icon="i-lucide-trash-2" size="xs" color="neutral" variant="ghost" class="queued-action" :aria-label="t('删除排队消息')" :disabled="sending === item.id" @click.stop="act('queue_delete', item.id)" />
          <!-- Focus goes to the composer for 编辑消息, not back to this button. -->
          <UDropdownMenu v-if="menu(item)[0].length" :items="menu(item)" :content="{ align: 'end', sideOffset: 4, onCloseAutoFocus: (event) => event.preventDefault() }" :ui="{ content: 'channel-menu' }">
            <UButton icon="i-lucide-ellipsis" size="xs" color="neutral" variant="ghost" class="queued-action" :aria-label="t('排队消息操作')" :disabled="sending === item.id" />
          </UDropdownMenu>
        </span>
      </div>
    </TransitionGroup>
    <div v-for="{ card, upload } in pending_rows" :key="card.id" role="listitem" class="queued-row">
      <span class="queued-leading" aria-hidden="true"><UIcon name="i-lucide-loader-circle" class="animate-spin" /></span>
      <span class="queued-text">{{ card.text.replace(/\s+/g, " ").trim() || t('{value1} 个附件', { value1: card.files.length }) }}</span>
      <span class="queued-actions queued-sending-status" role="status">
        <template v-if="card.retrying">{{ t('网络不稳，第 {value1} 次重试…', { value1: card.retrying }) }}</template>
        <UploadPercent v-else-if="upload && !card.waiting" :id="upload.id" v-slot="{ percent, phase }">{{ percent === null ? t('发送中…') : phase === 'compress' ? t('压缩中 {percent}%', { percent }) : t('上传中 {percent}%', { percent }) }}</UploadPercent>
        <template v-else>{{ t('发送中…') }}</template>
      </span>
    </div>
  </div>
</template>

<style scoped>
/* A tray tucked behind the composer's top edge, a little narrower than it, as in Codex. */
.queued-messages { position: relative; display: flex; flex-direction: column; max-height: 30dvh; margin: 0 12px -12px; padding: 2px 4px 14px; overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain;
  border: 1px solid var(--ui-border); border-bottom: 0; border-radius: 12px 12px 0 0; background: var(--ui-bg-elevated); }
/* Rows slide aside only while a row is lifted: left on at the drop, the slide would start from the old place in the new order. */
.queued-row { position: relative; display: flex; align-items: center; gap: 8px; min-height: 28px; padding: 0 2px 0 8px; border-radius: 8px; font-size: 13px; color: var(--ui-text-muted);
  transition: opacity .18s, background .12s; -webkit-touch-callout: none; user-select: none; }
.queued-messages.is-dragging .queued-row { transition: transform .16s ease, opacity .18s, background .12s; }
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
.queued-thumbnail-icon { display: grid; place-items: center; color: var(--ui-text-muted); background: var(--ui-bg-elevated); font-size: 14px; }
.queued-text { flex: 1; min-width: 0; overflow: hidden; color: var(--ui-text-toned); white-space: nowrap; text-overflow: ellipsis; outline: none; }
@media (max-width: 700px) {
  .queued-relay-source { display: block; overflow: hidden; text-overflow: ellipsis; font-size: 11px; }
}
.queued-row.is-failed .queued-text { color: var(--ui-text-muted); }
.queued-actions { display: flex; flex-shrink: 0; align-items: center; gap: 0; }
.queued-action { color: var(--ui-text-dimmed); }
.queued-action:hover:not(:disabled) { color: var(--ui-text-highlighted); }
/* Give the primary send/interject button a wider pill-like hit area; PC shows text while phones keep the icon alone (user 2026-11-24, #10245). */
.queued-send-now { justify-content: center; min-width: 64px; margin-right: 4px; padding-inline: 10px; border: 1px solid color-mix(in srgb, var(--ui-border) 75%, transparent); border-radius: 6px; background: color-mix(in srgb, var(--ui-text) 6%, transparent); color: var(--ui-text-toned); }
.queued-send-now:hover:not(:disabled) { border-color: var(--ui-border-accented); background: color-mix(in srgb, var(--ui-text) 11%, transparent); color: var(--ui-text-highlighted); }
@media (max-width: 700px) {
  .queued-send-now { min-width: 52px; padding-inline: 12px; }
  .queued-send-now :deep([data-slot="label"]) { display: none; }
}
.queued-sending-status { padding: 0 8px; font-size: 12px; color: var(--ui-text-dimmed); }
.queued-paused-row { cursor: default; }
.queued-paused-row .queued-text { color: var(--ui-text-muted); }
.queued-move { transition: transform .16s ease; }
/* Rows appear at once (a new one takes the sending row's place) and fold away when they leave. */
.queued-leave-active { min-height: 0; overflow: hidden; transition: max-height .18s, opacity .18s; }
.queued-leave-to { max-height: 0; opacity: 0; }
.queued-leave-from { max-height: 40px; opacity: 1; }
/* The tooltip's own fixed one-line height would let longer text spill out below its background. */
:global(.queued-tooltip) { display: block; max-width: 360px; height: auto; padding: 6px 10px; text-align: center; white-space: normal; line-height: 1.4; }
:global(.queued-tooltip-remedy) { opacity: .65; }
:global(.queued-preview) { max-width: min(560px, 90vw); padding: 8px 12px; border-radius: 8px; font-size: 13px; line-height: 1.5; text-align: left; box-shadow: 0 6px 18px #0004; }
:global(.queued-failure) { margin-bottom: 4px; color: var(--ui-warning); }
:global(.queued-preview-body) { max-height: 40vh; overflow-y: auto; overscroll-behavior: contain; white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; }
</style>

<script setup>
import { t } from './i18n.js';
/**
 * The room's speaking order, shared by the free-room and discussion boards: who spoke, who speaks now and who is next.
 * The owner drags (or moves with the arrow keys) the members who have not spoken; each row's content comes from the board.
 */
import { computed, inject, nextTick, ref, watch } from "vue";

// `round` numbers this round so later rounds of a plan can be labelled; the discussion board knows it.
const props = defineProps({ away: { type: Array, default: () => [] }, round: { type: Number, default: 0 } });
// The pointer entering, leaving, pressing or selecting a member's row, with the member ID.
const emit = defineEmits(["enter", "leave", "press", "select"]);
const { view, bridge, act } = inject("discussion");
// One order change at a time; other board actions do not block it.
const saving = ref(false);
const room = computed(() => view.value.room);
const order = computed(() => room.value.speaking_order || { kind: "default", items: [], movable: [] });
const movable_state = computed(() => order.value.kind === "default" ? "idle" : "queued");
const can_reorder = computed(() => Boolean(view.value.access?.can_manage) && !room.value.archived && order.value.movable.length > 1);
// Outside the default order, idle rows are members this queue or round does not include: they get no place.
const OUTSIDE_LABELS = { queue: t('不在本次依次回答中'), turns: t('本轮未安排') };
const grip_title = computed(() => order.value.kind === "default"
  ? t('拖动设置默认发言顺序，@全体依次 按此顺序；聚焦后可用上下方向键') : t('拖动调整还没发言的顺序，立即生效；聚焦后可用上下方向键'));
const STALE_ORDER = t('发言顺序刚有变化，已更新为最新顺序，请重新调整');
// A relay stopped at a user gate says so: the owner's next unaddressed message is their step.
const relay_label = computed(() => {
  const relay = order.value.sequence;
  if (!relay) return "";
  if (relay.loop) return relay.waiting_user ? t('循环接力 · 第 {value1} 圈 · 等你回复', { value1: relay.pass }) : t('循环接力 · 第 {value1} 圈', { value1: relay.pass });
  return relay.waiting_user ? t('主持人安排的依次接力 · 等你回复') : t('主持人安排的依次接力');
});

const list = ref(null);
const drag = ref(null);
// The order just sent, shown until the room reports its new revision.
const sent = ref(null);
const announcement = ref("");
watch(() => order.value.revision, () => { sent.value = null; });
const away_open = ref(false);
watch(() => room.value.id, () => { drag.value = null; sent.value = null; announcement.value = ""; away_open.value = false; document.removeEventListener("keydown", cancel, true); });

/** Move one entry of a name list to another index. */
function moved(names, from, to) {
  const result = [...names];
  result.splice(to, 0, ...result.splice(from, 1));
  return result;
}

/**
 * Rows to show: the movable part follows the order just sent until the room reports it.
 * Rows never move during a drag, even when the room refreshes (moving the captured grip in the page would end the drag):
 * the drag keeps the order it started from and only marks where the row will land.
 */
const rows = computed(() => {
  const shown_order = drag.value?.order || order.value;
  const items = shown_order.items;
  const first = items.findIndex((item) => item.state === movable_state.value);
  const names = sent.value || shown_order.movable;
  const shown = first < 0 ? items : [...items.slice(0, first), ...names.map((name) => ({ name, state: movable_state.value })), ...items.slice(first + names.length)];
  const in_order = (item) => shown_order.kind === "default" || item.state !== "idle";
  const ranked = shown.filter(in_order).length;
  // A member queued twice keeps a stable key per occurrence.
  const seen = {};
  let place = 0;
  return shown.map((item, index) => ({ ...item, key: `${item.name}#${seen[item.name] = (seen[item.name] || 0) + 1}`,
    // A lone member has no order to show; members of one relay step working at once share its number.
    place: in_order(item) && ranked > 1 ? (item.step && item.step === shown[index - 1]?.step ? place : ++place) : 0,
    outside: !in_order(item) && index > 0 && in_order(shown[index - 1]) }));
});
const movable_index = (index) => index - rows.value.findIndex((item) => item.state === movable_state.value);

/** Send the new order with the revision this board showed; the server refuses it if the order changed meanwhile. */
async function commit(names, name, focus) {
  if (names.join("\n") === order.value.movable.join("\n")) return;
  const key = rows.value.find((item) => item.state === movable_state.value && item.name === name)?.key;
  sent.value = names;
  await nextTick();
  // The moved row is re-inserted in the list; keep the keyboard on its grip.
  if (focus && key) list.value?.querySelector(`[data-key="${CSS.escape(key)}"] .speaking-order-grip`)?.focus();
  announcement.value = t('已将 {value1} 移到第 {value2} 位', { value1: name, value2: rows.value.find((item) => item.key === key)?.place || names.indexOf(name) + 1 });
  saving.value = true;
  try { await act("reorder_speakers", { revision: order.value.revision, order: names }); }
  finally { saving.value = false; sent.value = null; }
}

/** Capture the pointer on the grip so the drag continues anywhere in the list. */
function start(event, index) {
  if (!can_reorder.value || saving.value || event.button !== 0) return;
  event.preventDefault();
  event.currentTarget.setPointerCapture(event.pointerId);
  drag.value = { pointer: event.pointerId, from: index, gap: index, order: order.value, grip: event.currentTarget };
  // The grip takes no focus from a pointer press, so Escape is heard on the document while dragging.
  document.addEventListener("keydown", cancel, true);
}

/** The drop gap is before the first movable row whose middle lies below the pointer (after the last one if none). */
function move(event) {
  if (drag.value?.pointer !== event.pointerId) return;
  const cells = [...list.value.querySelectorAll("[data-movable]")];
  const below = cells.findIndex((cell) => { const box = cell.getBoundingClientRect(); return event.clientY < box.top + box.height / 2; });
  drag.value = { ...drag.value, gap: below < 0 ? cells.length : below };
}

/** Commit a finished drag; a cancelled one leaves the order as it was. */
function finish(event, cancelled = false) {
  if (drag.value?.pointer !== event.pointerId) return;
  const { from, gap, order: started } = drag.value;
  drag.value = null;
  document.removeEventListener("keydown", cancel, true);
  const to = gap > from ? gap - 1 : gap;
  if (cancelled || from === to) return;
  // The order refreshed during the drag: the dragged place no longer means the same member, so drop it and say so; a refused send is reported by the controller.
  if (started.revision !== order.value.revision) bridge.notify("warning", STALE_ORDER);
  else commit(moved(order.value.movable, from, to), order.value.movable[from], false);
}

/** Escape abandons a drag in progress without sending anything. */
function cancel(event) {
  if (!drag.value || event.key !== "Escape") return;
  event.preventDefault();
  const { grip, pointer } = drag.value;
  drag.value = null;
  document.removeEventListener("keydown", cancel, true);
  if (grip.hasPointerCapture(pointer)) grip.releasePointerCapture(pointer);
}

/** Where the dragged row would land: a line in the gap before a row, or after the last movable row. */
function drop_class(index) {
  if (!drag.value || rows.value[index].state !== movable_state.value) return "";
  const place = movable_index(index), { from, gap } = drag.value;
  const source = place === from ? "is-source" : "";
  if (gap === from || gap === from + 1) return source;
  return [source, place === gap ? "drop-before" : "", gap === drag.value.order.movable.length && place === gap - 1 ? "drop-after" : ""].join(" ");
}

/** Arrow keys move the focused member one place. */
function step(event, index, direction) {
  const to = index + direction;
  if (!can_reorder.value || to < 0 || to >= order.value.movable.length) return;
  event.preventDefault();
  if (saving.value) return;
  commit(moved(order.value.movable, index, to), order.value.movable[index], true);
}
/** Clicking a member row locates its latest speech; ignore clicks on controls or double-click rename. */
function select_row(name, event) {
  if (drag.value || event.defaultPrevented) return;
  if (event.target.closest?.("button, input, textarea, select, a, [role='menuitem']")) return;
  if (event.detail > 1 && event.target.closest?.(".member-name-text.is-editable")) return;
  emit("select", name);
}
</script>

<template>
  <div class="speaking-order">
    <ul ref="list" class="pb-members" :class="{ 'is-dragging': drag }">
      <!-- A host's one-after-another relay shows as a queue; a loop also says which pass it is on. -->
      <li v-if="order.sequence" class="speaking-order-divider speaking-order-relay"><span>{{ relay_label }}</span></li>
      <template v-for="(item, index) in rows" :key="item.key">
        <li v-if="item.outside" class="speaking-order-divider" aria-hidden="true"><span>{{ OUTSIDE_LABELS[order.kind] }}</span></li>
        <li class="pb-member speaking-order-row" :class="[`is-${item.state}`, drop_class(index), { 'is-movable': item.state === movable_state && can_reorder }]"
          :data-key="item.key" :data-movable="item.state === movable_state ? '' : undefined"
          @mouseenter="emit('enter', item.name, $event)" @mouseleave="emit('leave')" @pointerdown="emit('press')" @click="select_row(item.name, $event)">
          <button v-if="item.state === movable_state && can_reorder" type="button" class="speaking-order-grip" :aria-disabled="saving"
            :aria-label="t('{value1}，第 {value2} 位；拖动或用上下方向键调整发言顺序', { value1: item.name, value2: item.place })" :title="grip_title"
            @pointerdown="start($event, movable_index(index))" @pointermove="move" @pointerup="finish" @pointercancel="finish($event, true)" @lostpointercapture="finish($event, true)"
            @keydown.up="step($event, movable_index(index), -1)" @keydown.down="step($event, movable_index(index), 1)">
            <span class="speaking-order-number">{{ item.place }}</span><UIcon name="i-lucide-grip-vertical" class="speaking-order-handle" />
          </button>
          <span v-else-if="item.state === 'done'" class="speaking-order-place" :title="t('已发言')" :aria-label="t('已发言')"><UIcon name="i-lucide-check" /></span>
          <span v-else class="speaking-order-place" :title="item.step ? t('与同序号的成员同时做') : item.state === 'speaking' ? t('正在发言') : undefined">{{ item.place || '' }}</span>
          <slot :item="item" :place="item.place" />
        </li>
      </template>
      <!-- Later rounds of a plan are read-only: only this round can be reordered, and the host usually re-plans after each round. -->
      <li v-if="order.later?.length" class="speaking-order-later">
        <details>
          <summary>{{ t('后续已排 {value1} 轮', { value1: order.later.length }) }}</summary>
          <ol>
            <li v-for="(names, index) in order.later" :key="index">
              <span>{{ props.round ? t('第 {value1} 轮', { value1: props.round + index + 1 }) : t('后续第 {value1} 轮', { value1: index + 1 }) }}</span>{{ names.map((name) => bridge.display_name(name)).join(" → ") }}
            </li>
          </ol>
        </details>
      </li>
      <!-- Away members are rarely needed, so the group starts folded; opening it holds until the room changes. -->
      <li v-if="props.away.length" class="speaking-order-divider">
        <button type="button" class="speaking-order-away-toggle" :aria-expanded="away_open" @click="away_open = !away_open">
          <UIcon :name="away_open ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" />{{ t('已离开 {value1}', { value1: props.away.length }) }}
        </button>
      </li>
      <li v-for="name in away_open ? props.away : []" :key="`away-${name}`" class="pb-member speaking-order-row is-away"
        @mouseenter="emit('enter', name, $event)" @mouseleave="emit('leave')" @pointerdown="emit('press')" @click="select_row(name, $event)">
        <span class="speaking-order-place"></span>
        <slot :item="{ name, state: 'away' }" :place="0" />
      </li>
    </ul>
    <p class="speaking-order-live" aria-live="polite">{{ announcement }}</p>
  </div>
</template>

<style scoped>
.speaking-order-row { position: relative; grid-template-columns: 18px auto minmax(0, 1fr) auto; gap: 8px; min-height: 0; padding: 4px 8px; cursor: pointer; }
.speaking-order-row.is-done, .speaking-order-row.is-away { opacity: .6; }
.speaking-order-row.is-speaking { background: color-mix(in srgb, var(--channel-accent, var(--ui-primary)) 10%, transparent); }
.speaking-order-place, .speaking-order-grip { display: grid; place-items: center; align-self: center; width: 18px; height: 24px; color: var(--ui-text-dimmed); font-size: 11px; font-variant-numeric: tabular-nums; }
.speaking-order-place [class*="icon"] { width: 12px; height: 12px; }
.speaking-order-grip { padding: 0; border: 0; border-radius: 4px; background: none; cursor: grab; touch-action: none; }
.speaking-order-grip > * { grid-area: 1 / 1; }
.speaking-order-handle { width: 14px; height: 14px; opacity: 0; }
/* The number turns into the grip where the row can be moved, like the row menu that appears on hover. */
.speaking-order-row.is-movable:hover .speaking-order-number, .speaking-order-grip:focus-visible .speaking-order-number, .is-dragging .speaking-order-number { opacity: 0; }
.speaking-order-row.is-movable:hover .speaking-order-handle, .speaking-order-grip:focus-visible .speaking-order-handle, .is-dragging .speaking-order-handle { opacity: 1; }
.speaking-order-grip:hover, .speaking-order-grip:focus-visible { color: var(--ui-text-highlighted); background: color-mix(in srgb, currentColor 12%, transparent); }
/* Disabled only by aria while a change is sent, so keyboard focus stays on the grip. */
.speaking-order-grip[aria-disabled="true"] { cursor: default; opacity: .5; }
@media (hover: none) {
  .speaking-order-number { opacity: 0; }
  .speaking-order-handle { opacity: 1; }
}
.is-dragging, .is-dragging .speaking-order-grip { cursor: grabbing; user-select: none; }
.is-dragging .speaking-order-row:hover { background: none; }
.is-dragging .speaking-order-row.is-speaking:hover { background: color-mix(in srgb, var(--channel-accent, var(--ui-primary)) 10%, transparent); }
.speaking-order-row.is-source { opacity: .45; }
.speaking-order-row.drop-before::before, .speaking-order-row.drop-after::after { content: ""; position: absolute; left: 8px; right: 8px; height: 2px; border-radius: 1px; background: var(--channel-accent, var(--ui-primary)); pointer-events: none; }
.speaking-order-row.drop-before::before { top: -3px; }
.speaking-order-row.drop-after::after { bottom: -3px; }
.speaking-order-divider { display: flex; align-items: center; gap: 8px; margin: 6px 8px 0; color: var(--ui-text-dimmed); font-size: 11px; }
.speaking-order-divider::after { content: ""; flex: 1; height: 1px; background: var(--ui-border); }
.speaking-order-relay { margin-top: 0; }
.speaking-order-away-toggle { display: inline-flex; align-items: center; gap: 3px; padding: 0; border: 0; background: none; color: inherit; font: inherit; cursor: pointer; }
.speaking-order-away-toggle:hover { color: var(--ui-text-highlighted); }
.speaking-order-away-toggle > [class*="icon"] { width: 12px; height: 12px; }
.speaking-order-later { margin: 6px 8px 0; color: var(--ui-text-muted); font-size: 12px; }
.speaking-order-later summary { color: var(--ui-text-dimmed); font-size: 11px; cursor: pointer; }
.speaking-order-later ol { display: grid; gap: 4px; margin: 6px 0 0; padding: 0; list-style: none; }
.speaking-order-later li { overflow-wrap: anywhere; line-height: 1.5; }
.speaking-order-later li > span { margin-right: 6px; color: var(--ui-text-dimmed); }
/* Anchors the hidden live region inside the panel's scroller; anchored to the page it sits below a long member list and lets the whole page scroll. */
.speaking-order { position: relative; }
.speaking-order-live { position: absolute; width: 1px; height: 1px; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
</style>

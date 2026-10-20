<script>
/** Format a minute count as hours and remaining minutes for the form and its summary. */
export function format_duration(minutes) {
  const hours = Math.floor(minutes / 60), remainder = minutes % 60;
  return [hours && `${hours} 小时`, remainder && `${remainder} 分钟`].filter(Boolean).join(" ") || "0 分钟";
}
</script>

<script setup>
import { onBeforeUnmount, reactive, watch } from "vue";

const props = defineProps({ rounds: { type: Number, default: 3 }, minutes: { type: Number, default: 0 } });
const emit = defineEmits(["update:rounds", "update:minutes"]);
const ROW_HEIGHT = 32;
const ROW_ANGLE = Math.PI / 7;
const WHEEL_RADIUS = ROW_HEIGHT / ROW_ANGLE;
const VISIBLE_RADIUS = 3;
const PHYSICS_STEP = 1 / 240;
const REST_DISTANCE = 0.001;
const REST_SPEED = 0.01;
// Feel.words("loose"): unit mass, 1.6 Hz, zeta 0.3; coast retains velocity for about 166 ms.
const FREE_DAMPING = 4 * Math.PI * 1.6 * 0.3;
// Feel.words("precise"): 4.5 Hz, critical damping; capture without oscillating around a row.
const SNAP_FREQUENCY = 4.5;
const CAPTURE_DISTANCE = 0.5;
// A 6 Hz critically damped hand follows dragging; 8 Hz walls contain end travel.
const HAND_FREQUENCY = 6;
const WALL_FREQUENCY = 8;
const TAP_DISTANCE = 4;
const fields = reactive([
  { key: "rounds", label: "轮次上限", selected: 3, unlimited: false, open: false },
  { key: "minutes", label: "时长上限", selected: 60, unlimited: false, open: false },
]);
const wheels = reactive([
  { key: "rounds", field: "rounds", label: "轮次上限", unit: "轮", min: 1, max: 100, initial: 3 },
  { key: "hours", field: "minutes", label: "小时", unit: "小时", min: 0, max: 24, initial: 1 },
  { key: "minutes", field: "minutes", label: "分钟", unit: "分钟", min: 0, max: 59, initial: 0 },
].map((wheel) => ({ ...wheel, x: wheel.initial, v: 0, selected: wheel.initial,
  editing: false, draft: String(wheel.initial), target: null, hand: null, pointer: null })));
let frame_id = 0, previous_time = 0;
const clamp = (next, max, min = 0) => Math.min(max, Math.max(min, next));
const nearest = (wheel) => clamp(Math.round(wheel.x), wheel.max, wheel.min);
const field_wheels = (field) => wheels.filter((wheel) => wheel.field === field.key);
const wheel_field = (wheel) => fields.find((field) => field.key === wheel.field);
const field_text = (field) => field.key === "rounds" ? `${field.selected} 轮` : format_duration(field.selected);
const spring = (distance, velocity, frequency) => -((2 * Math.PI * frequency) ** 2) * distance - 4 * Math.PI * frequency * velocity;

/** Load a finite value into one column without leaving residual motion. */
function load_value(wheel, value) {
  rest(wheel, value);
  wheel.selected = wheel.x;
  wheel.draft = String(wheel.selected);
}

/** Keep finite duration within 1 minute–24 hours while retaining separate columns. */
function sync_minutes() {
  const hours = wheels[1], minutes = wheels[2];
  minutes.min = hours.selected === 0 ? 1 : 0;
  minutes.max = hours.selected === 24 ? 0 : 59;
  if (minutes.selected < minutes.min || minutes.selected > minutes.max) load_value(minutes, minutes.selected);
}

/** Keep the last finite value when an independent unlimited option is toggled. */
function set_unlimited(field, unlimited) {
  set_open(field, false);
  field.unlimited = unlimited;
  emit(`update:${field.key}`, unlimited ? 0 : field.selected);
}

/** Settle a dismissed popover and allow only one field to be edited at a time. */
function set_open(field, open) {
  if (open && field.unlimited) return;
  for (const current of fields) {
    if (current.open && (current !== field || !open)) {
      for (const wheel of field_wheels(current)) {
        finish_edit(wheel);
        rest(wheel, wheel.target ?? nearest(wheel));
        publish(wheel);
      }
      current.open = false;
    }
  }
  field.open = open;
}

/** Freeze at the visible value before exposing a native exact-value input. */
function begin_edit(wheel, event) {
  rest(wheel, nearest(wheel));
  publish(wheel);
  wheel.draft = String(wheel.selected);
  wheel.editing = true;
  event.target.select();
}

/** Commit valid integer input, keeping empty or invalid edits from changing the limit. */
function finish_edit(wheel) {
  if (!wheel.editing) return;
  const next = Number(wheel.draft);
  wheel.editing = false;
  if (wheel.draft.trim() && Number.isFinite(next)) {
    rest(wheel, next);
    publish(wheel);
  }
  wheel.draft = String(wheel.selected);
}

/** Apply hand/end springs, free viscous coasting, then a spring to the predicted stop. */
function acceleration(wheel, position, velocity) {
  if (wheel.hand !== null) return spring(position - wheel.hand, velocity, HAND_FREQUENCY);
  if (position < wheel.min || position > wheel.max) return spring(position - clamp(position, wheel.max, wheel.min), velocity, WALL_FREQUENCY);
  if (wheel.target !== null) return spring(position - wheel.target, velocity, SNAP_FREQUENCY);
  return -FREE_DAMPING * velocity;
}

/** Integrate the force field with RK4 so input velocity survives release and interruption. */
function advance(wheel, elapsed) {
  const steps = Math.ceil(elapsed / PHYSICS_STEP), step = elapsed / steps;
  for (let index = 0; index < steps; index++) {
    if (wheel.hand === null && wheel.target === null && Math.abs(wheel.v) / FREE_DAMPING <= CAPTURE_DISTANCE) {
      wheel.target = clamp(Math.round(wheel.x + wheel.v / FREE_DAMPING), wheel.max, wheel.min);
    }
    const position = wheel.x, velocity = wheel.v;
    const first = acceleration(wheel, position, velocity);
    const second_v = velocity + first * step / 2;
    const second = acceleration(wheel, position + velocity * step / 2, second_v);
    const third_v = velocity + second * step / 2;
    const third = acceleration(wheel, position + second_v * step / 2, third_v);
    const fourth_v = velocity + third * step;
    const fourth = acceleration(wheel, position + third_v * step, fourth_v);
    wheel.x += step * (velocity + 2 * second_v + 2 * third_v + fourth_v) / 6;
    wheel.v += step * (first + 2 * second + 2 * third + fourth) / 6;
  }
}

/** Publish the visible stop without changing the other field or its unlimited state. */
function publish(wheel) {
  const next = nearest(wheel), field = wheel_field(wheel);
  if (field.unlimited || next === wheel.selected) return;
  wheel.selected = next;
  wheel.draft = String(next);
  if (field.key === "minutes") sync_minutes();
  field.selected = field.key === "rounds" ? next : wheels[1].selected * 60 + wheels[2].selected;
  emit(`update:${field.key}`, field.selected);
}

/** Stop at an exact row for external updates or form submission. */
function rest(wheel, next) {
  wheel.x = clamp(Math.round(next), wheel.max, wheel.min);
  wheel.v = 0;
  wheel.target = null;
  wheel.hand = null;
  wheel.pointer = null;
}

/** Run only while a wheel is held or moving; long background gaps cannot launch a wheel. */
function animate(time) {
  const elapsed = Math.max(0, Math.min((time - previous_time) / 1000, 0.05));
  previous_time = time;
  frame_id = 0;
  let moving = false;
  for (const wheel of wheels) {
    if (wheel_field(wheel).unlimited || wheel.editing) continue;
    advance(wheel, elapsed);
    const settled = Math.abs(wheel.x - (wheel.target ?? nearest(wheel))) < REST_DISTANCE && Math.abs(wheel.v) < REST_SPEED;
    if (!wheel.pointer && settled) rest(wheel, nearest(wheel));
    publish(wheel);
    moving ||= Boolean(wheel.pointer) || !settled;
  }
  if (moving) frame_id = requestAnimationFrame(animate);
}

/** Wake the shared animation loop without restarting an existing trajectory. */
function wake() {
  if (frame_id) return;
  previous_time = performance.now();
  frame_id = requestAnimationFrame(animate);
}

/** Select a definite row with a spring; keyboard commands accumulate while in flight. */
function choose(wheel, next) {
  if (wheel_field(wheel).unlimited) return;
  finish_edit(wheel);
  wheel.hand = null;
  wheel.target = clamp(Math.round(next), wheel.max, wheel.min);
  wake();
}

/** Support every value with arrows, larger page steps and the two range boundaries. */
function keydown(wheel, event) {
  if (wheel.editing) return;
  if (event.key === "Enter") {
    event.preventDefault();
    event.currentTarget.querySelector("input").focus();
    return;
  }
  const current = wheel.target ?? nearest(wheel);
  const choices = { ArrowUp: current - 1, ArrowDown: current + 1, PageUp: current - 5, PageDown: current + 5, Home: wheel.min, End: wheel.max };
  if (!(event.key in choices)) return;
  event.preventDefault();
  choose(wheel, choices[event.key]);
}

/** Step immediately on mouse-wheel input, clearing any previous drag inertia. */
function scroll(wheel, event) {
  if (!event.deltaY || wheel.pointer || wheel_field(wheel).unlimited) return;
  finish_edit(wheel);
  event.currentTarget.querySelector(".limit-wheel").focus({ preventScroll: true });
  rest(wheel, nearest(wheel) + Math.sign(event.deltaY));
  publish(wheel);
}

/** Take over from the current position and velocity without jumping during an animation. */
function grab(wheel, event) {
  if (!event.isPrimary || event.button !== 0) return;
  if (wheel.editing && event.target.tagName === "INPUT") return;
  event.preventDefault();
  finish_edit(wheel);
  event.currentTarget.querySelector(".limit-wheel").focus({ preventScroll: true });
  event.currentTarget.setPointerCapture(event.pointerId);
  wheel.pointer = { id: event.pointerId, y: event.clientY, x: wheel.x, travel: 0 };
  wheel.hand = wheel.x;
  wheel.target = null;
  wake();
}

/** Move the hand spring in row units; the body itself remains driven by forces. */
function drag(wheel, event) {
  if (wheel.pointer?.id !== event.pointerId) return;
  const distance = wheel.pointer.y - event.clientY;
  wheel.pointer.travel = Math.max(wheel.pointer.travel, Math.abs(distance));
  wheel.hand = clamp(wheel.pointer.x + distance / ROW_HEIGHT, wheel.max, wheel.min);
}

/** Release the hand, keeping body velocity; taps select the row under the pointer. */
function release(wheel, event) {
  if (wheel.pointer?.id !== event.pointerId) return;
  const tap = wheel.pointer.travel < TAP_DISTANCE && event.type === "pointerup";
  wheel.pointer = null;
  wheel.hand = null;
  if (tap) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const distance = event.clientY - bounds.top - bounds.height / 2;
    if (Math.abs(distance) < ROW_HEIGHT / 2) {
      event.currentTarget.querySelector("input").focus();
      return;
    }
    const offset = distance / WHEEL_RADIUS;
    choose(wheel, wheel.x + Math.asin(Math.max(-1, Math.min(1, offset))) / ROW_ANGLE);
  } else wake();
}

/** Project visible rows onto a cylinder and fade them according to position. */
function rows(wheel) {
  const center = Math.round(wheel.x);
  return Array.from({ length: VISIBLE_RADIUS * 2 + 1 }, (_, index) => center + index - VISIBLE_RADIUS)
    .filter((index) => index >= wheel.min && index <= wheel.max)
    .map((index) => {
      const offset = index - wheel.x, angle = offset * ROW_ANGLE;
      return { index, text: index,
        style: { "--wheel-y": `${Math.sin(angle) * WHEEL_RADIUS}px`, "--wheel-angle": `${-angle * 180 / Math.PI}deg`,
          opacity: Math.max(0, Math.cos(angle)) ** 2 } };
    });
}

/** Commit an explicit selection or the visible inertial stop before form submission. */
function settle() {
  for (const wheel of wheels) {
    finish_edit(wheel);
    rest(wheel, wheel.target ?? nearest(wheel));
    publish(wheel);
  }
  cancelAnimationFrame(frame_id);
  frame_id = 0;
}

watch(() => [props.rounds, props.minutes], (values) => {
  values.forEach((next, index) => {
    const field = fields[index];
    if (next === (field.unlimited ? 0 : field.selected)) return;
    field.unlimited = next === 0;
    if (field.unlimited) field.open = false;
    field.selected = clamp(Math.round(next || field.selected), index ? 1440 : 100, 1);
    field_wheels(field).forEach((wheel) => { wheel.editing = false; });
    if (index === 0) load_value(wheels[0], field.selected);
    else {
      load_value(wheels[1], Math.floor(field.selected / 60));
      sync_minutes();
      load_value(wheels[2], field.selected % 60);
    }
  });
}, { immediate: true });
onBeforeUnmount(() => cancelAnimationFrame(frame_id));
defineExpose({ settle });
</script>

<template>
  <div class="limit-picker" role="group" aria-label="讨论轮次和时长">
    <div v-for="field in fields" :key="field.key" class="limit-field">
      <div class="limit-field-heading">
        <label :for="`limit-trigger-${field.key}`">{{ field.label }}</label>
        <button type="button" class="limit-unlimited" :aria-pressed="field.unlimited"
          :aria-label="`不限${field.key === 'rounds' ? '轮次' : '时长'}`" @click="set_unlimited(field, !field.unlimited)">
          <UIcon name="i-lucide-infinity" aria-hidden="true" /><span>不限</span>
        </button>
      </div>
      <UPopover :open="field.open" :content="{ align: field.key === 'rounds' ? 'start' : 'end', sideOffset: 6, collisionPadding: 12 }"
        :ui="{ content: `limit-popover-content ${field.key === 'minutes' ? 'limit-duration-content' : ''}` }" @update:open="set_open(field, $event)">
        <button :id="`limit-trigger-${field.key}`" type="button" class="limit-trigger" :disabled="field.unlimited"
          :aria-label="`${field.label}：${field.unlimited ? '不限' : field_text(field)}`">
          <span v-if="field.unlimited">不限{{ field.key === "rounds" ? "轮次" : "时长" }}</span>
          <span v-else class="limit-trigger-value"><span v-for="part in field_text(field).match(/\d+ \S+/g)" :key="part">{{ part }}</span></span>
          <UIcon name="i-lucide-chevrons-up-down" />
        </button>
        <template #content>
          <div class="limit-editor">
            <div class="limit-editor-heading"><span>{{ field.label }}</span><button type="button" class="limit-close" :aria-label="`关闭${field.label}选择`" @click="set_open(field, false)"><UIcon name="i-lucide-x" /></button></div>
            <div class="limit-columns">
            <div v-for="wheel in field_wheels(field)" :key="wheel.key" class="limit-track" :class="{ 'is-editing': wheel.editing }"
                @keydown="keydown(wheel, $event)" @wheel.prevent="scroll(wheel, $event)"
                @pointerdown="grab(wheel, $event)" @pointermove="drag(wheel, $event)"
                @pointerup="release(wheel, $event)" @pointercancel="release(wheel, $event)" @lostpointercapture="release(wheel, $event)">
              <div class="limit-wheel" role="spinbutton" tabindex="0" :aria-label="`滚轮选择${wheel.label}`"
                :aria-valuemin="wheel.min" :aria-valuemax="wheel.max" :aria-valuenow="wheel.selected" :aria-valuetext="`${wheel.selected} ${wheel.unit}`">
                <div class="limit-selection" aria-hidden="true"></div>
                <div class="limit-wheel-rows" aria-hidden="true">
                  <span v-for="row in rows(wheel)" :key="row.index" class="limit-wheel-row" :class="{ 'is-current': row.index === nearest(wheel) }" :style="row.style">{{ row.text }}</span>
                </div>
              </div>
              <div class="limit-exact-value">
                <input type="number" inputmode="numeric" :min="wheel.min" :max="wheel.max" step="1" :value="wheel.draft"
                  :aria-label="`输入${wheel.label}（${wheel.unit}）`" @focus="begin_edit(wheel, $event)" @input="wheel.draft = $event.target.value"
                  @blur="finish_edit(wheel)" @keydown.enter.stop.prevent="finish_edit(wheel); set_open(field, false)">
                <span aria-hidden="true">{{ wheel.unit }}</span>
              </div>
            </div>
            </div>
          </div>
        </template>
      </UPopover>
    </div>
  </div>
</template>

<style scoped>
.limit-picker { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; width: 100%; }
.limit-field { min-width: 0; }
.limit-field-heading { display: flex; align-items: center; justify-content: space-between; gap: 6px; margin-bottom: 8px; color: var(--ui-text-toned); font-size: 12px; }
.limit-unlimited { display: inline-flex; flex-shrink: 0; align-items: center; justify-content: center; gap: 4px; min-height: 26px; padding: 3px 6px; border: 1px solid var(--ui-border-muted); border-radius: 6px; background: var(--ui-bg-muted); color: var(--ui-text-muted); font-size: 11px; line-height: 16px; cursor: pointer; }
.limit-unlimited > [class*="icon"] { width: 13px; height: 13px; }
.limit-unlimited:hover { border-color: var(--ui-border-accented); color: var(--ui-text-highlighted); }
.limit-unlimited[aria-pressed="true"] { border-color: color-mix(in srgb, var(--channel-accent) 45%, var(--ui-border)); background: color-mix(in srgb, var(--channel-accent) 12%, var(--ui-bg)); color: var(--channel-accent); }
.limit-unlimited:focus-visible { outline: 2px solid var(--channel-accent); outline-offset: 2px; }
.limit-trigger { display: flex; align-items: center; justify-content: space-between; gap: 10px; width: 100%; min-height: 38px; padding: 7px 12px; border: 1px solid var(--ui-border); border-radius: 7px; background: var(--ui-bg-muted); color: var(--ui-text-highlighted); font-size: 13px; font-variant-numeric: tabular-nums; text-align: left; }
.limit-trigger-value { display: flex; flex-wrap: wrap; gap: 0 5px; min-width: 0; }
.limit-trigger-value > span { white-space: nowrap; }
.limit-trigger > [class*="icon"] { flex-shrink: 0; width: 13px; height: 13px; color: var(--ui-text-muted); }
.limit-trigger[data-state="open"] { border-color: var(--channel-accent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--channel-accent) 12%, transparent); }
.limit-trigger:disabled { color: var(--ui-text-muted); }
.limit-trigger:disabled > [class*="icon"] { opacity: .35; }
:global(.limit-popover-content) { width: max(170px, var(--reka-popover-trigger-width)); max-width: calc(100vw - 24px); z-index: 60; border: 1px solid var(--ui-border); border-radius: 9px; background: var(--ui-bg); box-shadow: var(--channel-shadow-float); animation: none !important; }
:global(.limit-duration-content) { width: max(240px, var(--reka-popover-trigger-width)); }
.limit-editor { padding: 10px; }
.limit-columns { display: grid; grid-auto-columns: minmax(0, 1fr); grid-auto-flow: column; gap: 8px; }
.limit-editor-heading { display: flex; align-items: center; justify-content: space-between; color: var(--ui-text-muted); font-size: 11px; }
.limit-close { display: grid; place-items: center; width: 24px; height: 24px; padding: 0; border-radius: 4px; }
.limit-close:hover { background: var(--ui-bg-elevated); }
.limit-close > [class*="icon"] { width: 14px; height: 14px; }
.limit-track { position: relative; margin-top: 3px; touch-action: none; user-select: none; cursor: grab; border-radius: 5px; outline: none; }
.limit-track:active { cursor: grabbing; }
.limit-track:has(:focus-visible) { box-shadow: inset 0 0 0 2px var(--channel-accent); }
.limit-wheel { position: relative; height: 144px; min-width: 0; overflow: hidden; outline: none; }
.limit-selection { position: absolute; top: 50%; left: 0; right: 0; height: 32px; transform: translateY(-50%); border-radius: 5px; background: color-mix(in srgb, var(--channel-accent) 10%, var(--ui-bg)); pointer-events: none; }
.limit-wheel-rows { position: absolute; inset: 0; perspective: 500px; mask-image: linear-gradient(transparent, #000 22%, #000 78%, transparent); }
.limit-wheel-row { position: absolute; top: calc(50% - 16px); left: calc(50% - 42px); width: 50px; height: 32px; line-height: 32px; text-align: center; color: var(--ui-text-toned); font-size: 18px; font-weight: 400; font-variant-numeric: tabular-nums; backface-visibility: hidden; transform: translateY(var(--wheel-y)) rotateX(var(--wheel-angle)); }
.limit-wheel-row.is-current { color: var(--ui-text-highlighted); }
.limit-exact-value { position: absolute; top: calc(50% - 16px); left: calc(50% - 42px); display: flex; align-items: center; gap: 4px; height: 32px; pointer-events: none; }
.limit-exact-value input { width: 50px; min-width: 0; padding: 0; border: 0; appearance: textfield; background: transparent; color: transparent; caret-color: transparent; text-align: center; font-size: 18px; font-variant-numeric: tabular-nums; }
.limit-exact-value input::-webkit-inner-spin-button, .limit-exact-value input::-webkit-outer-spin-button { margin: 0; appearance: none; }
.is-editing .limit-exact-value input { color: var(--ui-text-highlighted); caret-color: auto; pointer-events: auto; user-select: text; }
.is-editing .limit-wheel-row.is-current { opacity: 0 !important; }
.limit-exact-value > span { color: var(--ui-text-muted); font-size: 11px; pointer-events: none; }
/* Keep the requested direct-manipulation inertia; reduce only decorative 3D tilt. */
@media (prefers-reduced-motion: reduce) {
  .limit-wheel-rows { perspective: none; }
  .limit-wheel-row { transform: translateY(var(--wheel-y)); }
}
@media (max-width: 480px) {
  .limit-picker { gap: 12px; }
  .limit-trigger { padding-inline: 10px; }
}
@media (pointer: coarse) {
  .limit-field-heading, .limit-unlimited { min-height: 44px; }
  .limit-field-heading { margin-bottom: 0; }
  .limit-trigger, .limit-close { min-height: 44px; }
  .limit-close { width: 44px; }
}
</style>

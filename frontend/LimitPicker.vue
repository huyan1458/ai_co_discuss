<script setup>
import { onBeforeUnmount, onMounted, reactive, watch } from "vue";

const props = defineProps({ rounds: { type: Number, default: 3 }, minutes: { type: Number, default: 60 } });
const emit = defineEmits(["update:rounds", "update:minutes"]);
const ROW_HEIGHT = 32;
const ROW_ANGLE = Math.PI / 7;
const WHEEL_RADIUS = ROW_HEIGHT / ROW_ANGLE;
const VISIBLE_RADIUS = 3;
const PHYSICS_STEP = 1 / 240;
const REST_DISTANCE = 0.001;
const REST_SPEED = 0.01;
// "smooth, magnetic": unit mass, 1.8 Hz and critical damping (Feel.words).
const FREE_DAMPING = 2 * Math.PI * 1.8 * 2;
// A broad 1.1 Hz well catches a coast; a 7 Hz well seats the nearest integer.
const REACH_FREQUENCY = 1.1;
const CLICK_FREQUENCY = 7;
const CLICK_RADIUS = 1 / 3;
// A 6 Hz critically damped hand follows dragging; 8 Hz walls contain end travel.
const HAND_FREQUENCY = 6;
const WALL_FREQUENCY = 8;
const TAP_DISTANCE = 4;
const wheels = reactive([
  { key: "rounds", label: "轮次上限", unit: "轮", limit: 100, step: 1, initial: 3 },
  { key: "minutes", label: "时长上限", unit: "分钟", limit: 1440, step: 5, initial: 60 },
].map((wheel) => ({ ...wheel, values: [], max: 0, x: 0, v: 0, selected: wheel.initial,
  unlimited: false, open: false, editing: false, draft: String(wheel.initial), target: null, hand: null, pointer: null })));
let frame_id = 0, previous_time = 0, reduced_motion = false, motion_query;
const clamp = (next, max) => Math.min(max, Math.max(0, next));
const nearest = (wheel) => clamp(Math.round(wheel.x), wheel.max);
const spring = (distance, velocity, frequency) => -((2 * Math.PI * frequency) ** 2) * distance - 4 * Math.PI * frequency * velocity;

/** Retain exact input values alongside ordinary one-round or five-minute stops. */
function load_value(wheel, value) {
  const next = Math.max(1, clamp(Math.round(value), wheel.limit));
  wheel.values = [...new Set([1, next, ...Array.from({ length: wheel.limit / wheel.step }, (_, index) => (index + 1) * wheel.step)])].sort((left, right) => left - right);
  wheel.max = wheel.values.length - 1;
  rest(wheel, wheel.values.indexOf(next));
  wheel.selected = next;
  wheel.draft = String(next);
}

/** Keep the last finite value when an independent unlimited option is toggled. */
function set_unlimited(wheel, unlimited) {
  set_open(wheel, false);
  wheel.unlimited = unlimited;
  emit(`update:${wheel.key}`, unlimited ? 0 : wheel.selected);
}

/** Settle a dismissed popover and allow only one field to be edited at a time. */
function set_open(wheel, open) {
  if (open && wheel.unlimited) return;
  for (const current of wheels) {
    if (current.open && (current !== wheel || !open)) {
      finish_edit(current);
      rest(current, current.target ?? nearest(current));
      publish(current);
      current.open = false;
    }
  }
  wheel.open = open;
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
    load_value(wheel, next);
    emit(`update:${wheel.key}`, wheel.selected);
  }
  wheel.draft = String(wheel.selected);
}

/** Calculate the acceleration of a unit mass in the hand, end walls or integer wells. */
function acceleration(wheel, position, velocity) {
  if (wheel.hand !== null) return spring(position - wheel.hand, velocity, HAND_FREQUENCY);
  if (position < 0 || position > wheel.max) return spring(position - clamp(position, wheel.max), velocity, WALL_FREQUENCY);
  if (wheel.target !== null) return spring(position - wheel.target, velocity, CLICK_FREQUENCY);
  const distance = position - Math.round(position);
  const proximity = Math.max(0, 1 - Math.abs(distance) / CLICK_RADIUS);
  const attraction = (2 * Math.PI * REACH_FREQUENCY) ** 2
    + (2 * Math.PI * CLICK_FREQUENCY) ** 2 * proximity ** 2 * (3 - 2 * proximity);
  return -attraction * distance - FREE_DAMPING * velocity;
}

/** Integrate the force field with RK4 so input velocity survives release and interruption. */
function advance(wheel, elapsed) {
  const steps = Math.ceil(elapsed / PHYSICS_STEP), step = elapsed / steps;
  for (let index = 0; index < steps; index++) {
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
  const next = wheel.values[nearest(wheel)];
  if (wheel.unlimited || next === wheel.selected) return;
  wheel.selected = next;
  wheel.draft = String(next);
  emit(`update:${wheel.key}`, next);
}

/** Stop at an exact row for reduced motion, external updates or form submission. */
function rest(wheel, next) {
  wheel.x = clamp(Math.round(next), wheel.max);
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
    if (wheel.unlimited || wheel.editing) continue;
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
  if (frame_id || reduced_motion) return;
  previous_time = performance.now();
  frame_id = requestAnimationFrame(animate);
}

/** Select a definite row with a spring; keyboard commands accumulate while in flight. */
function choose(wheel, next) {
  if (wheel.unlimited) return;
  finish_edit(wheel);
  wheel.hand = null;
  wheel.target = clamp(Math.round(next), wheel.max);
  if (reduced_motion) {
    rest(wheel, wheel.target);
    publish(wheel);
  } else wake();
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
  const choices = { ArrowUp: current - 1, ArrowDown: current + 1, PageUp: current - 5, PageDown: current + 5, Home: 0, End: wheel.max };
  if (!(event.key in choices)) return;
  event.preventDefault();
  choose(wheel, choices[event.key]);
}

/** Convert mouse-wheel travel to an impulse; reduced motion uses discrete rows. */
function scroll(wheel, event) {
  const pixels = event.deltaY * (event.deltaMode === 1 ? ROW_HEIGHT : event.deltaMode === 2 ? ROW_HEIGHT * 5 : 1);
  if (!pixels || wheel.pointer || wheel.unlimited) return;
  finish_edit(wheel);
  event.currentTarget.querySelector(".limit-wheel").focus({ preventScroll: true });
  if (reduced_motion) return choose(wheel, nearest(wheel) + Math.sign(pixels));
  wheel.target = null;
  wheel.v += pixels / ROW_HEIGHT * FREE_DAMPING;
  wake();
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
  wheel.hand = clamp(wheel.pointer.x + distance / ROW_HEIGHT, wheel.max);
  if (reduced_motion) {
    wheel.x = wheel.hand;
    publish(wheel);
  }
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
  } else if (reduced_motion) {
    rest(wheel, nearest(wheel));
    publish(wheel);
  } else wake();
}

/** Project visible rows onto a cylinder and fade them according to position. */
function rows(wheel) {
  const center = Math.round(wheel.x);
  return Array.from({ length: VISIBLE_RADIUS * 2 + 1 }, (_, index) => center + index - VISIBLE_RADIUS)
    .filter((index) => index >= 0 && index <= wheel.max)
    .map((index) => {
      const offset = index - wheel.x, angle = offset * ROW_ANGLE;
      return { index, text: wheel.values[index],
        style: { transform: `translateY(${Math.sin(angle) * WHEEL_RADIUS}px) rotateX(${-angle * 180 / Math.PI}deg)`,
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

/** Follow system motion preferences, including changes while the form is open. */
function motion_changed(event) {
  reduced_motion = event.matches;
  if (reduced_motion) settle();
}

watch(() => [props.rounds, props.minutes], (values) => {
  values.forEach((next, index) => {
    const wheel = wheels[index];
    if (wheel.values.length && next === (wheel.unlimited ? 0 : wheel.selected)) return;
    wheel.unlimited = next === 0;
    wheel.editing = false;
    if (wheel.unlimited) wheel.open = false;
    load_value(wheel, next || wheel.selected);
  });
}, { immediate: true });
onMounted(() => {
  motion_query = window.matchMedia("(prefers-reduced-motion: reduce)");
  motion_changed(motion_query);
  motion_query.addEventListener("change", motion_changed);
});
onBeforeUnmount(() => {
  cancelAnimationFrame(frame_id);
  motion_query?.removeEventListener("change", motion_changed);
});
defineExpose({ settle });
</script>

<template>
  <div class="limit-picker" role="group" aria-label="讨论轮次和时长">
    <div v-for="wheel in wheels" :key="wheel.key" class="limit-field">
      <div class="limit-field-heading">
        <label :for="`limit-trigger-${wheel.key}`">{{ wheel.label }}</label>
        <label class="limit-unlimited"><input type="checkbox" :checked="wheel.unlimited" :aria-label="`不限${wheel.key === 'rounds' ? '轮次' : '时长'}`" @change="set_unlimited(wheel, $event.target.checked)">不限</label>
      </div>
      <UPopover :open="wheel.open" :content="{ align: wheel.key === 'rounds' ? 'start' : 'end', sideOffset: 6, collisionPadding: 12 }"
        :ui="{ content: 'limit-popover-content' }" @update:open="set_open(wheel, $event)">
        <button :id="`limit-trigger-${wheel.key}`" type="button" class="limit-trigger" :disabled="wheel.unlimited"
          :aria-label="`${wheel.label}：${wheel.unlimited ? '不限' : `${wheel.selected} ${wheel.unit}`}`">
          <span v-if="wheel.unlimited">不限{{ wheel.key === "rounds" ? "轮次" : "时长" }}</span>
          <span v-else>{{ wheel.selected }} <small>{{ wheel.unit }}</small></span>
          <UIcon name="i-lucide-chevrons-up-down" />
        </button>
        <template #content>
          <div class="limit-editor">
            <div class="limit-editor-heading"><span>{{ wheel.label }}</span><button type="button" class="limit-close" :aria-label="`关闭${wheel.label}选择`" @click="set_open(wheel, false)"><UIcon name="i-lucide-x" /></button></div>
            <div class="limit-track" :class="{ 'is-editing': wheel.editing }"
                @keydown="keydown(wheel, $event)" @wheel.prevent="scroll(wheel, $event)"
                @pointerdown="grab(wheel, $event)" @pointermove="drag(wheel, $event)"
                @pointerup="release(wheel, $event)" @pointercancel="release(wheel, $event)" @lostpointercapture="release(wheel, $event)">
              <div class="limit-wheel" role="spinbutton" tabindex="0" :aria-label="`滚轮选择${wheel.label}`"
                :aria-valuemin="1" :aria-valuemax="wheel.limit" :aria-valuenow="wheel.selected" :aria-valuetext="`${wheel.selected} ${wheel.unit}`">
                <div class="limit-selection" aria-hidden="true"></div>
                <div class="limit-wheel-rows" aria-hidden="true">
                  <span v-for="row in rows(wheel)" :key="row.index" class="limit-wheel-row" :class="{ 'is-current': row.index === nearest(wheel) }" :style="row.style">{{ row.text }}</span>
                </div>
              </div>
              <div class="limit-exact-value">
                <input type="number" inputmode="numeric" :min="1" :max="wheel.limit" step="1" :value="wheel.draft"
                  :aria-label="`输入${wheel.label}（${wheel.unit}）`" @focus="begin_edit(wheel, $event)" @input="wheel.draft = $event.target.value"
                  @blur="finish_edit(wheel)" @keydown.enter.stop.prevent="finish_edit(wheel); set_open(wheel, false)">
                <span aria-hidden="true">{{ wheel.unit }}</span>
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
.limit-field-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; color: var(--ui-text-toned); font-size: 12px; }
.limit-unlimited { display: inline-flex; align-items: center; gap: 5px; color: var(--ui-text-muted); cursor: pointer; }
.limit-unlimited input { width: 13px; height: 13px; margin: 0; accent-color: var(--channel-accent); }
.limit-trigger { display: flex; align-items: center; justify-content: space-between; gap: 10px; width: 100%; min-height: 38px; padding: 7px 12px; border: 1px solid var(--ui-border); border-radius: 7px; background: var(--ui-bg-muted); color: var(--ui-text-highlighted); font-size: 13px; font-variant-numeric: tabular-nums; text-align: left; }
.limit-trigger small { margin-left: 3px; color: var(--ui-text-muted); font-size: 12px; }
.limit-trigger > [class*="icon"] { width: 13px; height: 13px; color: var(--ui-text-muted); }
.limit-trigger[data-state="open"] { border-color: var(--channel-accent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--channel-accent) 12%, transparent); }
.limit-trigger:disabled { color: var(--ui-text-muted); }
.limit-trigger:disabled > [class*="icon"] { opacity: .35; }
:global(.limit-popover-content) { width: max(170px, var(--reka-popover-trigger-width)); max-width: calc(100vw - 24px); z-index: 60; border: 1px solid var(--ui-border); border-radius: 9px; background: var(--ui-bg); box-shadow: var(--channel-shadow-float); animation: none !important; }
.limit-editor { padding: 10px; }
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
.limit-wheel-row { position: absolute; top: calc(50% - 16px); left: calc(50% - 46px); width: 58px; height: 32px; line-height: 32px; text-align: center; color: var(--ui-text-toned); font-size: 18px; font-weight: 400; font-variant-numeric: tabular-nums; backface-visibility: hidden; }
.limit-wheel-row.is-current { color: var(--ui-text-highlighted); }
.limit-exact-value { position: absolute; top: calc(50% - 16px); left: calc(50% - 46px); display: flex; align-items: center; gap: 4px; height: 32px; pointer-events: none; }
.limit-exact-value input { width: 58px; min-width: 0; padding: 0; border: 0; appearance: textfield; background: transparent; color: transparent; caret-color: transparent; text-align: center; font-size: 18px; font-variant-numeric: tabular-nums; }
.limit-exact-value input::-webkit-inner-spin-button, .limit-exact-value input::-webkit-outer-spin-button { margin: 0; appearance: none; }
.is-editing .limit-exact-value input { color: var(--ui-text-highlighted); caret-color: auto; pointer-events: auto; user-select: text; }
.is-editing .limit-wheel-row.is-current { opacity: 0 !important; }
.limit-exact-value > span { color: var(--ui-text-muted); font-size: 11px; pointer-events: none; }
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

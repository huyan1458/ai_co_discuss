<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, watch } from "vue";

const props = defineProps({ rounds: { type: Number, default: 3 }, minutes: { type: Number, default: 60 } });
const emit = defineEmits(["update:rounds", "update:minutes"]);
const ROW_HEIGHT = 40;
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
  { key: "rounds", label: "讨论轮次上限", unit: "轮", max: 100, x: props.rounds, selected: props.rounds },
  { key: "hours", label: "讨论时长：小时", unit: "小时", max: 24, x: Math.floor(props.minutes / 60), selected: Math.floor(props.minutes / 60) },
  { key: "minutes", label: "讨论时长：分钟", unit: "分钟", max: 59, x: props.minutes % 60, selected: props.minutes % 60 },
].map((wheel) => ({ ...wheel, v: 0, target: null, hand: null, pointer: null })));
let frame_id = 0, previous_time = 0, reduced_motion = false, motion_query;
const unlimited_time = computed(() => wheels[1].selected === 0 && wheels[2].selected === 0);
const clamp = (next, max) => Math.min(max, Math.max(0, next));
const nearest = (wheel) => clamp(Math.round(wheel.x), wheel.max);
const spring = (distance, velocity, frequency) => -((2 * Math.PI * frequency) ** 2) * distance - 4 * Math.PI * frequency * velocity;

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

/** Publish the visible integer, preserving the server's 24-hour maximum. */
function publish(wheel) {
  const next = nearest(wheel);
  if (next === wheel.selected) return;
  wheel.selected = next;
  if (wheel.key === "rounds") emit("update:rounds", next);
  else {
    wheels[2].max = wheels[1].selected === 24 ? 0 : 59;
    if (wheels[2].max === 0) {
      rest(wheels[2], 0);
      wheels[2].selected = 0;
    }
    emit("update:minutes", wheels[1].selected * 60 + wheels[2].selected);
  }
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
  wheel.hand = null;
  wheel.target = clamp(Math.round(next), wheel.max);
  if (reduced_motion) {
    rest(wheel, wheel.target);
    publish(wheel);
  } else wake();
}

/** Support every value with arrows, larger page steps and the two range boundaries. */
function keydown(wheel, event) {
  const current = wheel.target ?? wheel.selected;
  const choices = { ArrowUp: current - 1, ArrowDown: current + 1, PageUp: current - 5, PageDown: current + 5, Home: 0, End: wheel.max };
  if (!(event.key in choices)) return;
  event.preventDefault();
  choose(wheel, choices[event.key]);
}

/** Convert mouse-wheel travel to an impulse; reduced motion uses discrete rows. */
function scroll(wheel, event) {
  const pixels = event.deltaY * (event.deltaMode === 1 ? ROW_HEIGHT : event.deltaMode === 2 ? ROW_HEIGHT * 5 : 1);
  if (!pixels || wheel.pointer) return;
  if (reduced_motion) return choose(wheel, wheel.selected + Math.sign(pixels));
  wheel.target = null;
  wheel.v += pixels / ROW_HEIGHT * FREE_DAMPING;
  wake();
}

/** Take over from the current position and velocity without jumping during an animation. */
function grab(wheel, event) {
  if (!event.isPrimary || event.button !== 0) return;
  event.currentTarget.focus({ preventScroll: true });
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
    const offset = (event.clientY - bounds.top - bounds.height / 2) / WHEEL_RADIUS;
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
      return { index, text: wheel.key === "rounds" && index === 0 ? "不限" : index,
        style: { transform: `translateY(${Math.sin(angle) * WHEEL_RADIUS}px) rotateX(${-angle * 180 / Math.PI}deg)`,
          opacity: Math.max(0, Math.cos(angle)) ** 2 } };
    });
}

/** Commit exactly the displayed integers before a parent submits the form. */
function settle() {
  for (const wheel of wheels) {
    rest(wheel, nearest(wheel));
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

watch(() => [props.rounds, props.minutes], ([rounds, minutes]) => {
  wheels[2].max = minutes >= 1440 ? 0 : 59;
  [rounds, Math.floor(minutes / 60), minutes % 60].forEach((next, index) => {
    if (next === wheels[index].selected) return;
    rest(wheels[index], next);
    wheels[index].selected = nearest(wheels[index]);
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
    <div class="limit-wheels">
      <div class="limit-selection" aria-hidden="true"></div>
      <div v-for="wheel in wheels" :key="wheel.key" class="limit-wheel" role="spinbutton" tabindex="0"
        :aria-label="wheel.label" :aria-valuemin="0" :aria-valuemax="wheel.max" :aria-valuenow="wheel.selected"
        :aria-valuetext="wheel.key === 'rounds' && wheel.selected === 0 ? '不限轮次' : `${wheel.selected} ${wheel.unit}`"
        aria-describedby="limit-picker-hint" @keydown="keydown(wheel, $event)" @wheel.prevent="scroll(wheel, $event)"
        @pointerdown.prevent="grab(wheel, $event)" @pointermove="drag(wheel, $event)"
        @pointerup="release(wheel, $event)" @pointercancel="release(wheel, $event)" @lostpointercapture="release(wheel, $event)">
        <div class="limit-wheel-rows" aria-hidden="true">
          <span v-for="row in rows(wheel)" :key="row.index" class="limit-wheel-row" :style="row.style">{{ row.text }}</span>
        </div>
        <span class="limit-wheel-unit" aria-hidden="true">{{ wheel.unit }}</span>
      </div>
    </div>
    <p id="limit-picker-hint" class="limit-picker-hint">{{ unlimited_time ? '当前不限时长' : '0 小时 0 分钟表示不限时长' }}</p>
  </div>
</template>

<style scoped>
.limit-picker { width: 100%; max-width: 460px; align-self: center; }
.limit-wheels { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); position: relative; height: 200px; }
.limit-selection { position: absolute; top: 50%; left: 0; right: 0; height: 40px; transform: translateY(-50%); border-radius: 10px; background: var(--ui-bg-accented); pointer-events: none; }
.limit-wheel { position: relative; min-width: 0; overflow: hidden; touch-action: none; user-select: none; cursor: grab; border-radius: 10px; outline: none; }
.limit-wheel:active { cursor: grabbing; }
.limit-wheel:focus-visible { box-shadow: inset 0 0 0 2px var(--channel-accent); }
.limit-wheel-rows { position: absolute; inset: 0; perspective: 500px; mask-image: linear-gradient(transparent, #000 22%, #000 78%, transparent); }
.limit-wheel-row { position: absolute; top: calc(50% - 20px); left: 0; width: 63%; height: 40px; line-height: 40px; text-align: right; padding-right: 8px; color: var(--ui-text-highlighted); font-size: 28px; font-weight: 400; font-variant-numeric: tabular-nums; backface-visibility: hidden; }
.limit-wheel-unit { position: absolute; top: calc(50% - 20px); right: 0; width: 37%; line-height: 40px; color: var(--ui-text-highlighted); font-size: 15px; pointer-events: none; }
.limit-picker-hint { margin: 2px 0 0; text-align: center; color: var(--ui-text-muted); font-size: 11px; }
@media (max-width: 600px) {
  .limit-wheel-row { font-size: 25px; }
  .limit-wheel-unit { font-size: 13px; }
}
</style>

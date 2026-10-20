<script setup>
/** Select a supported effort with a spring-driven, keyboard-accessible thumb. */
import { computed, onBeforeUnmount, reactive, ref, watch } from "vue";
import { useReducedMotion } from "motion-v";

const props = defineProps({
  items: { type: Array, required: true },
  modelValue: { type: String, default: "" },
  label: { type: String, required: true },
});
const emit = defineEmits(["update:modelValue"]);
// Feel.words("precise"): unit mass, 4.5 Hz, critical damping, no oscillation at a stop.
const SNAP_FREQUENCY = 4.5;
// The hand uses Feel.words("instant") at 6 Hz; 8 Hz walls catch end travel.
const HAND_FREQUENCY = 6, WALL_FREQUENCY = 8;
const STEP = 1 / 240, REST_DISTANCE = 0.001, REST_SPEED = 0.01;
const FRAME_LIMIT = 0.05, THUMB_RADIUS = 10, TAP_DISTANCE = 4;
const reduced_motion = useReducedMotion();
const track = ref(null);
const maximum = computed(() => props.items.length - 1);
const selected = computed(() => Math.max(0, props.items.findIndex((item) => item.value === props.modelValue)));
const body = reactive({ x: selected.value, v: 0, target: selected.value, hand: null, pointer: null });
const progress = computed(() => `${Math.min(maximum.value, Math.max(0, body.x)) / maximum.value * 100}%`);
let frame = 0, previous_time = 0, origin = 0, grab_offset = 0, moved = false;
const clamp = (value) => Math.min(maximum.value, Math.max(0, value));
const spring = (distance, speed, frequency) => -((2 * Math.PI * frequency) ** 2) * distance - 4 * Math.PI * frequency * speed;

/** Integrate hand/snap and end-wall forces without discarding momentum. */
function advance(step) {
  const target = body.hand ?? body.target, frequency = body.hand === null ? SNAP_FREQUENCY : HAND_FREQUENCY;
  const force = (position, speed) => spring(position - target, speed, frequency)
    + (position < 0 || position > maximum.value ? spring(position - clamp(position), speed, WALL_FREQUENCY) : 0);
  const position = body.x, speed = body.v;
  const first = force(position, speed), second_speed = speed + first * step / 2;
  const second = force(position + speed * step / 2, second_speed), third_speed = speed + second * step / 2;
  const third = force(position + second_speed * step / 2, third_speed), fourth_speed = speed + third * step;
  const fourth = force(position + third_speed * step, fourth_speed);
  body.x += step * (speed + 2 * second_speed + 2 * third_speed + fourth_speed) / 6;
  body.v += step * (first + 2 * second + 2 * third + fourth) / 6;
}

/** Request frames only while the body is moving toward its current hand or stop. */
function animate(now) {
  frame = 0;
  let elapsed = Math.min(FRAME_LIMIT, (now - previous_time) / 1000);
  previous_time = now;
  while (elapsed > 0) { const step = Math.min(STEP, elapsed); advance(step); elapsed -= step; }
  const target = body.hand ?? body.target;
  if (Math.abs(body.x - target) < REST_DISTANCE && Math.abs(body.v) < REST_SPEED) {
    body.x = target;
    body.v = 0;
  } else frame = requestAnimationFrame(animate);
}

/** Reduced motion reaches the same state immediately; other changes retarget in flight. */
function wake() {
  if (reduced_motion.value) {
    cancelAnimationFrame(frame);
    frame = 0;
    body.x = body.hand ?? body.target;
    body.v = 0;
  } else if (!frame) {
    previous_time = performance.now();
    frame = requestAnimationFrame(animate);
  }
}

/** Commit a supported stop and retain the body's current velocity. */
function choose(index) {
  body.target = clamp(Math.round(index));
  emit("update:modelValue", props.items[body.target].value);
  wake();
}

/** Convert a pointer coordinate to a stop position inside the thumb's travel. */
function coordinate(event) {
  const bounds = track.value.getBoundingClientRect();
  return clamp((event.clientX - bounds.left - THUMB_RADIUS) / Math.max(1, bounds.width - THUMB_RADIUS * 2) * maximum.value);
}

/** Grabbing the thumb mid-flight keeps its position and velocity continuous. */
function grab(event) {
  if (!event.isPrimary || event.button !== 0 || body.pointer !== null) return;
  event.preventDefault();
  track.value.focus();
  track.value.setPointerCapture(event.pointerId);
  body.pointer = event.pointerId;
  origin = event.clientX;
  moved = false;
  grab_offset = event.target.closest(".effort-slider-thumb") ? body.x - coordinate(event) : 0;
  body.hand = clamp(coordinate(event) + grab_offset);
  wake();
}

/** Dragging moves the hand spring, never the thumb directly. */
function move(event) {
  if (body.pointer !== event.pointerId) return;
  moved ||= Math.abs(event.clientX - origin) > TAP_DISTANCE;
  body.hand = clamp(coordinate(event) + grab_offset);
  wake();
}

/** A tap chooses its point; a drag chooses the projected stop from real velocity. */
function release(event) {
  if (body.pointer !== event.pointerId) return;
  const destination = moved ? body.x + body.v / (4 * Math.PI * SNAP_FREQUENCY) : body.hand;
  body.hand = null;
  body.pointer = null;
  choose(destination);
}

/** Interrupted gestures restore the saved value without publishing an accidental choice. */
function cancel(event) {
  if (body.pointer !== event.pointerId) return;
  body.hand = null;
  body.pointer = null;
  body.target = selected.value;
  wake();
}

/** Every stop, including the explicit CLI default, is reachable without a pointer. */
function keydown(event) {
  const destinations = { ArrowRight: selected.value + 1, ArrowUp: selected.value + 1,
    ArrowLeft: selected.value - 1, ArrowDown: selected.value - 1, Home: 0, End: maximum.value };
  if (!(event.key in destinations)) return;
  event.preventDefault();
  choose(destinations[event.key]);
}

watch([selected, maximum, reduced_motion], () => { body.target = selected.value; wake(); });
onBeforeUnmount(() => cancelAnimationFrame(frame));
</script>

<template>
  <div ref="track" class="effort-slider" role="slider" tabindex="0" :aria-label="label"
    aria-valuemin="0" :aria-valuemax="maximum" :aria-valuenow="selected" :aria-valuetext="items[selected].label"
    @keydown="keydown" @pointerdown="grab" @pointermove="move" @pointerup="release"
    @pointercancel="cancel" @lostpointercapture="cancel">
    <span class="effort-slider-track" aria-hidden="true">
      <span class="effort-slider-fill" :style="{ width: progress }" />
      <span v-for="(item, index) in items" :key="item.value" class="effort-slider-stop"
        :class="{ 'is-active': index <= body.x, 'is-default': index === 0 }"
        :style="{ left: `${index / maximum * 100}%` }" :title="item.label" />
      <span class="effort-slider-thumb" :style="{ left: progress }" />
    </span>
  </div>
</template>

<style scoped>
.effort-slider { position: relative; display: flex; align-items: center; height: 36px; padding: 0 10px; touch-action: pan-y; cursor: pointer; outline: none; }
.effort-slider-track { position: relative; width: 100%; height: 10px; border-radius: 999px; background: var(--ui-bg-accented); }
.effort-slider-fill { position: absolute; inset: 0 auto 0 0; border-radius: inherit; background: var(--channel-accent); }
.effort-slider-stop { position: absolute; top: 50%; width: 4px; height: 4px; border-radius: 50%; background: var(--ui-text-dimmed); transform: translate(-50%, -50%); }
.effort-slider-stop.is-active { background: color-mix(in srgb, var(--channel-accent) 40%, white); }
.effort-slider-stop.is-default { width: 6px; height: 6px; background: var(--ui-bg-elevated); border: 1px solid var(--ui-text-dimmed); }
.effort-slider-thumb { position: absolute; top: 50%; width: 20px; height: 20px; border: 1px solid #00000012; border-radius: 50%; background: #fff; box-shadow: 0 1px 4px #00000026; transform: translate(-50%, -50%); }
.effort-slider:focus-visible { border-radius: 6px; outline: 2px solid var(--channel-accent); outline-offset: 2px; }
@media (pointer: coarse) { .effort-slider { height: 44px; } }
</style>

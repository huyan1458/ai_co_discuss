<script setup>
/** Select a supported effort with a spring-driven, keyboard-accessible thumb. */
import { computed, onBeforeUnmount, reactive, ref, watch } from "vue";

const props = defineProps({
  items: { type: Array, required: true },
  modelValue: { type: String, default: "" },
  label: { type: String, required: true },
  caption: { type: String, default: "" },
});
const emit = defineEmits(["update:modelValue"]);
// Feel.words("precise"): unit mass, 4.5 Hz, critical damping, no oscillation at a stop.
const SNAP_FREQUENCY = 4.5;
// The hand uses Feel.words("instant") at 6 Hz; 8 Hz walls catch end travel.
const HAND_FREQUENCY = 6, WALL_FREQUENCY = 8;
const STEP = 1 / 240, REST_DISTANCE = 0.001, REST_SPEED = 0.01;
const FRAME_LIMIT = 0.05, THUMB_RADIUS = 10, TAP_DISTANCE = 4;
const track = ref(null);
const maximum = computed(() => props.items.length - 1);
const selected = computed(() => Math.max(0, props.items.findIndex((item) => item.value === props.modelValue)));
const body = reactive({ x: selected.value, v: 0, target: selected.value, hand: null, pointer: null });
const ratio = computed(() => Math.min(maximum.value, Math.max(0, body.x)) / maximum.value);
// The caption follows the stop nearest the moving thumb, so a drag previews its level before release.
const live = computed(() => Math.round(Math.min(maximum.value, Math.max(0, body.x))));
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

/** Start the spring if it is resting; a change while it moves retargets in flight. */
function wake() {
  if (!frame) {
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

watch([selected, maximum], () => { body.target = selected.value; wake(); });
onBeforeUnmount(() => cancelAnimationFrame(frame));
</script>

<template>
  <div class="effort-field">
    <div v-if="caption" class="effort-caption" aria-hidden="true">
      <span>{{ caption }}</span>
      <Transition name="effort-value" mode="out-in"><strong :key="live">{{ items[live].label }}</strong></Transition>
    </div>
    <div ref="track" class="effort-slider" :class="{ 'is-dragging': body.pointer !== null }" :style="{ '--progress': ratio }"
      role="slider" tabindex="0" :aria-label="label"
      aria-valuemin="0" :aria-valuemax="maximum" :aria-valuenow="selected" :aria-valuetext="items[selected].label"
      @keydown="keydown" @pointerdown="grab" @pointermove="move" @pointerup="release"
      @pointercancel="cancel" @lostpointercapture="cancel">
      <span class="effort-slider-track" aria-hidden="true"><span class="effort-slider-fill" /></span>
      <span v-for="(item, index) in items" :key="item.value" class="effort-slider-stop" aria-hidden="true"
        :class="{ 'is-active': index < live, 'is-current': index === live }"
        :style="{ '--at': index / maximum }" :title="item.label" />
      <span class="effort-slider-thumb" aria-hidden="true" />
    </div>
  </div>
</template>

<style scoped>
.effort-field { display: grid; gap: 2px; }
.effort-caption { display: flex; align-items: center; justify-content: space-between; min-height: 16px; color: var(--ui-text-dimmed); font-size: 11px; }
.effort-caption strong { color: var(--channel-accent); font-size: 11px; font-weight: 600; }
.effort-value-enter-active, .effort-value-leave-active { transition: opacity .1s ease, transform .1s ease; }
.effort-value-enter-from { opacity: 0; transform: translateY(3px); }
.effort-value-leave-to { opacity: 0; transform: translateY(-3px); }
/* Stops, fill and thumb share the pointer mapping: an inset of one thumb radius at both ends. */
.effort-slider { --inset: 10px; --travel: calc(100% - 2 * var(--inset)); position: relative; height: 28px; touch-action: pan-y; cursor: pointer; outline: none; }
/* The rail runs past the first and last stops, so the ends are clean caps rather than dots on an edge. */
.effort-slider-track { position: absolute; top: 50%; left: 2px; right: 2px; height: 4px; border-radius: 999px; background: var(--ui-bg-accented); transform: translateY(-50%); }
.effort-slider-fill { position: absolute; inset: 0 auto 0 0; width: calc(var(--inset) - 2px + (100% + 4px - 2 * var(--inset)) * var(--progress)); border-radius: inherit; background: var(--channel-accent); }
.effort-slider-stop { position: absolute; top: 50%; left: calc(var(--inset) + var(--travel) * var(--at)); width: 4px; height: 4px; border-radius: 50%; background: var(--ui-text-dimmed); transform: translate(-50%, -50%); transition: background-color .15s ease, transform .15s ease; }
.effort-slider-stop.is-active { background: color-mix(in srgb, var(--channel-accent) 35%, white); }
.effort-slider-stop.is-current { transform: translate(-50%, -50%) scale(0); }
.effort-slider-thumb { position: absolute; top: 50%; left: calc(var(--inset) + var(--travel) * var(--progress)); width: 16px; height: 16px; border-radius: 50%; background: #fff; box-shadow: 0 1px 3px #0000004d, 0 0 0 0 transparent; transform: translate(-50%, -50%); transition: transform .15s ease, box-shadow .15s ease; }
.effort-slider:hover .effort-slider-thumb { box-shadow: 0 1px 3px #0000004d, 0 0 0 4px color-mix(in srgb, var(--channel-accent) 20%, transparent); }
.effort-slider.is-dragging { cursor: grabbing; }
.effort-slider.is-dragging .effort-slider-thumb { transform: translate(-50%, -50%) scale(1.15); box-shadow: 0 2px 6px #0000004d, 0 0 0 6px color-mix(in srgb, var(--channel-accent) 22%, transparent); }
@media (pointer: coarse) { .effort-slider { height: 44px; } }
</style>

<script setup>
/**
 * A working card's status words: a light wave runs through the characters and the dots fade in turn.
 * Each card keeps its own phase so several members working at once never pulse in step,
 * and a change of `beat` (new output seen by the runner) lights the line once, a real sign of progress.
 * The wave flattens as `silent` grows, so side by side the members still producing output are the ones that move.
 */
import { computed, onBeforeUnmount, ref, watch } from "vue";

const props = defineProps({
  text: { type: String, required: true },
  /** Fixes this card's place in the cycle; the member's name keeps its rhythm stable across refreshes. */
  seed: { type: String, default: "" },
  /** Changes when new activity arrives; the first value never lights the line. */
  beat: { type: [Number, String], default: null },
  /** Seconds since the last output; unknown progress counts as fresh. */
  silent: { type: Number, default: 0 },
  dots: Boolean,
  /** Progress cannot be seen for this member, so the words stay still and only the dots move. */
  muted: Boolean,
});
const WAVE_SECONDS = 1.6;
const BEAT_MS = 900;
// Output reaches the page every 10 s at most, so the wave keeps full strength for that long,
// then flattens until it barely moves at two minutes; the three-minute warning takes over after that.
const CALM_AFTER_SECONDS = 10;
const STILL_AT_SECONDS = 120;
const LIVELY_LOW_OPACITY = 0.4;
const STILL_LOW_OPACITY = 0.85;
const chars = computed(() => [...props.text]);
/** The wave's dimmest point: deep while output is fresh, close to solid once it has been quiet for long. */
const wave_low = computed(() => {
  const calm = Math.min(1, Math.max(0, props.silent - CALM_AFTER_SECONDS) / (STILL_AT_SECONDS - CALM_AFTER_SECONDS));
  return (LIVELY_LOW_OPACITY + calm * (STILL_LOW_OPACITY - LIVELY_LOW_OPACITY)).toFixed(2);
});
/** A stable fraction of the cycle from the seed, as a negative delay so the motion starts mid-cycle. */
const phase = computed(() => {
  let hash = 0;
  for (const char of props.seed) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  return `${-((hash % 1000) / 1000) * WAVE_SECONDS}s`;
});
const beating = ref(false);
let beat_timer = 0;
watch(() => props.beat, (next, previous) => {
  if (previous == null || next === previous) return;
  clearTimeout(beat_timer);
  beating.value = false;
  // Leave one frame without the class so the animation restarts on back-to-back beats.
  requestAnimationFrame(() => {
    beating.value = true;
    beat_timer = setTimeout(() => { beating.value = false; }, BEAT_MS);
  });
});
onBeforeUnmount(() => clearTimeout(beat_timer));
</script>

<template>
  <span class="working-text" :class="{ 'is-muted': muted, 'is-beat': beating }" :style="{ '--working-phase': phase, '--wave-low': wave_low }">
    <span class="working-chars"><span v-for="(char, index) in chars" :key="index" :style="{ '--i': index }">{{ char }}</span></span>
    <span v-if="dots" class="working-dots" aria-hidden="true"><i v-for="index in 3" :key="index" :style="{ '--i': index - 1 }">.</i></span>
  </span>
</template>

<style scoped>
.working-text { display: inline; }
.working-chars span { white-space: pre; }
.working-dots { margin-left: 1px; }
.working-dots i { font-style: normal; opacity: 0; }
/* Working-state motion always plays, regardless of the system reduced-motion setting. */
/* Chinese labels are only a few characters long, so each one lags well behind the last for the wave to show. */
html[data-theme^="channel"] .working-text:not(.is-muted) .working-chars span {
  animation: working-wave 1.6s ease-in-out calc(var(--working-phase) + var(--i) * .18s) infinite !important;
}
html[data-theme^="channel"] .working-dots i {
  animation: working-dot 1.6s ease-in-out calc(var(--working-phase) + var(--i) * .3s) infinite !important;
}
html[data-theme^="channel"] .working-text.is-beat { animation: working-beat .9s ease-out !important; }
@keyframes working-wave { 0%, 100% { opacity: var(--wave-low, .4); } 50% { opacity: 1; } }
@keyframes working-dot { 0%, 100% { opacity: 0; } 50% { opacity: 1; } }
@keyframes working-beat { from { color: var(--channel-accent, var(--ui-text-highlighted)); } }
</style>

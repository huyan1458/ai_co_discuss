<script setup>
import { onBeforeUnmount, ref, watch } from "vue";
import { animate } from "motion-v";

const props = defineProps({ digit: { type: String, required: true } });

// The flap is a 1-unit mass on a spring ("snappy, clicky"). 3.4 Hz: done before the next count usually arrives.
// ζ 0.81: it reaches the base still moving, and the base (FLAP_LANDED) stops it there, so it lands with a click and never rebounds.
const FLAP_SPRING = { type: "spring", mass: 1, stiffness: 456.4, damping: 34.6 };
const FLAP_LANDED = 180;

const tile = ref(null);
// The digit the flap carries away; empty while no flap is falling.
const leaving = ref("");
let flight = null;

/** The flap reached the base: the tile shows the new digit alone. */
function land() {
  flight?.stop();
  flight = null;
  leaving.value = "";
}

// A count that changes while a flap falls only changes what is printed on its back: the flap keeps its course.
// The page's own motion switch decides (App.vue, html[data-motion]), whatever the system's reduced-motion preference says.
watch(() => props.digit, (_next, previous) => {
  if (flight || document.documentElement.dataset.motion === "off") return;
  leaving.value = previous;
  tile.value?.style.setProperty("--flap", "0");
  flight = animate(0, FLAP_LANDED, { ...FLAP_SPRING, onComplete: land,
    onUpdate: (angle) => { if (angle >= FLAP_LANDED) land(); else tile.value?.style.setProperty("--flap", String(angle)); } });
});
onBeforeUnmount(() => flight?.stop());
</script>

<template>
  <span ref="tile" class="flip-digit" aria-hidden="true">
    <span class="flip-half is-top">{{ digit }}</span>
    <span class="flip-half is-bottom">{{ leaving || digit }}</span>
    <span v-if="leaving" class="flip-flap">
      <span class="flip-half is-top">{{ leaving }}</span>
      <span class="flip-half is-bottom is-back">{{ digit }}</span>
    </span>
  </span>
</template>

<style scoped>
.flip-digit { --flap: 0; position: relative; display: inline-block; width: 10px; height: 16px; perspective: 48px; color: var(--ui-text-toned); font-size: 11px; font-weight: 600; line-height: 16px; text-align: center; font-variant-numeric: tabular-nums; }
/* The seam across the middle of the tile, above the flap's hinge. */
.flip-digit::after { content: ""; position: absolute; inset: 50% 0 auto; height: 1px; margin-top: -.5px; background: color-mix(in srgb, var(--ui-bg) 70%, transparent); }
.flip-half { position: absolute; inset: 0; border-radius: 2px; background: color-mix(in srgb, var(--ui-text-dimmed) 20%, var(--ui-bg-elevated)); backface-visibility: hidden; -webkit-backface-visibility: hidden; }
.flip-half.is-top { clip-path: inset(0 0 50% 0); }
.flip-half.is-bottom { clip-path: inset(50% 0 0 0); }
.flip-flap { position: absolute; inset: 0; transform: rotateX(calc(var(--flap) * -1deg)); transform-style: preserve-3d; }
/* Printed on the flap's back, upside down, so the new lower half reads upright once the flap has fallen. */
.flip-half.is-back { transform: rotateX(180deg); }
/* The flap dims as it turns away from the light; drawn from its angle, not from time. */
.flip-flap .flip-half { filter: brightness(calc(1 - var(--flap) / 500)); }
</style>

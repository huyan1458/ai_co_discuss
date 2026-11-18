<script setup>
/**
 * The upload state over an image thumbnail, in the composer and on the sending card alike: the image dims under a ring
 * that fills with the percent, and everything fades away once the file is in.
 */
import { t } from "./i18n.js";
import UploadPercent from "./UploadPercent.vue";

defineProps({
  /** The draft file's id. */
  id: { type: String, required: true },
  /** Still to go up though no percent is known yet (waiting its turn, or an upload that reports none). */
  pending: Boolean,
  /** The site has the file. */
  done: Boolean,
});
const RADIUS = 19;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
// The turning arc shown while no percent is known.
const WAITING_SHARE = 0.25;
</script>

<template>
  <UploadPercent :id="id" v-slot="{ percent }">
    <Transition name="upload-ring">
      <span v-if="!done && (percent === null ? pending : percent < 100)" class="upload-ring" :class="{ 'is-waiting': percent === null }" role="progressbar" aria-valuemin="0" aria-valuemax="100"
        :aria-valuenow="percent ?? undefined" :aria-label="percent === null ? t('正在上传') : t('上传中 {percent}%', { percent })">
        <span class="upload-ring-dial">
          <svg viewBox="0 0 44 44" aria-hidden="true">
            <circle class="upload-ring-track" cx="22" cy="22" :r="RADIUS" />
            <circle class="upload-ring-value" cx="22" cy="22" :r="RADIUS" :stroke-dasharray="CIRCUMFERENCE" :stroke-dashoffset="CIRCUMFERENCE * (1 - (percent === null ? WAITING_SHARE : percent / 100))" />
          </svg>
          <span v-if="percent !== null" class="upload-ring-number">{{ percent }}%</span>
        </span>
      </span>
    </Transition>
  </UploadPercent>
</template>

<style scoped>
.upload-ring { position: absolute; inset: 0; z-index: 1; display: grid; place-items: center; border-radius: inherit; color: #fff; background: rgb(0 0 0 / 48%); pointer-events: none; container-type: size; }
/* The disc keeps the number readable over a screenshot full of text. */
.upload-ring-dial { position: relative; display: grid; place-items: center; width: min(44px, 76cqmin); aspect-ratio: 1; border-radius: 50%; background: rgb(0 0 0 / 55%); }
.upload-ring-dial svg { position: absolute; inset: 0; width: 100%; height: 100%; transform: rotate(-90deg); }
.upload-ring-dial circle { fill: none; stroke-width: 3; }
.upload-ring-track { stroke: rgb(255 255 255 / 30%); }
.upload-ring-value { stroke: #fff; stroke-linecap: round; transition: stroke-dashoffset .2s linear; }
.upload-ring-number { position: relative; font-size: 12px; font-weight: 600; line-height: 1; font-variant-numeric: tabular-nums; }
.is-waiting svg { animation: upload-ring-turn 1s linear infinite; }
@keyframes upload-ring-turn { from { transform: rotate(-90deg); } to { transform: rotate(270deg); } }
/* A thumbnail too short for the number keeps the ring alone. */
@container (max-height: 39px) { .upload-ring-number { display: none; } }
.upload-ring-leave-active { transition: opacity .18s ease-out; }
.upload-ring-leave-to { opacity: 0; }
@media (prefers-reduced-motion: reduce) {
  .is-waiting svg { animation: none; }
  .upload-ring-value, .upload-ring-leave-active { transition: none; }
}
</style>

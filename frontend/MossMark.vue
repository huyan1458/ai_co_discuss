<script setup>
/**
 * MOSS drawn small (#15685): the original picture is a detailed machine that turns to a grey smudge at 20px, so the
 * sidebar and title bar draw its outline (the box with its lens and the arm over its shoulder) and let the lens carry the
 * state: blue-grey at rest, green breathing at work, amber pulsing while it waits on the user. With reduced motion only
 * the colour changes. The welcome and first-run pages keep the original picture.
 *
 * Props: `state` is "idle", "running" or "waiting" (from `moss_avatar` in moss.js); `title` is read on hover.
 */
defineProps({ state: { type: String, default: "idle" }, title: { type: String, default: "" } });
</script>

<template>
  <svg class="moss-mark" :class="`is-${state}`" viewBox="0 0 24 24" role="img" :aria-label="title || undefined" :aria-hidden="title ? undefined : 'true'">
    <title v-if="title">{{ title }}</title>
    <!-- The arm: a block over the top and a column down the right side. -->
    <rect class="moss-mark-frame" x="7.2" y="1.6" width="9.6" height="3.4" rx="1.1" />
    <rect class="moss-mark-frame" x="16" y="2.4" width="4" height="15.2" rx="1.6" />
    <!-- The body with its lens, the eye, and a small panel below it. -->
    <rect class="moss-mark-frame" x="3.6" y="6.2" width="11.6" height="15.6" rx="2.4" />
    <circle class="moss-mark-socket" cx="9.4" cy="11.4" r="3.5" />
    <circle class="moss-mark-eye" cx="9.4" cy="11.4" r="2.1" />
    <rect class="moss-mark-panel" x="6.6" y="16.6" width="5.6" height="2.2" rx=".6" />
  </svg>
</template>

<style scoped>
.moss-mark { display: block; flex-shrink: 0; overflow: visible; --moss-eye: #8aa4c8; }
.moss-mark-frame { fill: #d9d6ce; }
.moss-mark-socket { fill: #2a2c33; }
.moss-mark-panel { fill: #9a978f; }
.moss-mark-eye { fill: var(--moss-eye); transform-box: fill-box; transform-origin: center; }
.moss-mark.is-running { --moss-eye: #22c55e; }
.moss-mark.is-waiting { --moss-eye: #f59e0b; }
.moss-mark.is-running .moss-mark-eye { animation: moss-eye-breathe 2s ease-in-out infinite; }
.moss-mark.is-waiting .moss-mark-eye { animation: moss-eye-call 1.2s ease-in-out infinite; }
@keyframes moss-eye-breathe { 50% { opacity: .45; transform: scale(.8); } }
@keyframes moss-eye-call { 50% { opacity: .55; } }
@media (prefers-reduced-motion: reduce) { .moss-mark .moss-mark-eye { animation: none !important; } }
:global(:root[data-effects="reduced"]) .moss-mark .moss-mark-eye { animation: none !important; }
/* On the light theme the body darkens so its outline still reads against white. */
:global(:root[data-theme="channel-light"]) .moss-mark-frame { fill: #6f7178; }
:global(:root[data-theme="channel-light"]) .moss-mark-socket { fill: #f2f2f2; }
:global(:root[data-theme="channel-light"]) .moss-mark-panel { fill: #a7a8ad; }
</style>

<script setup>
/**
 * What the file preview shows while a file is read or rendered: a page-shaped placeholder with a soft shimmer, so the
 * window appears at once and the wait reads as progress. `progress` (0–1) adds a bar when the share read is known.
 * Motion follows the site's one switch (`MOTION_ENABLED` in App.vue), never the system's reduced-motion setting.
 */
defineProps({ label: { type: String, default: "正在打开…" }, progress: { type: Number, default: 0 } });
</script>

<template>
  <div class="preview-loading" role="status" :aria-label="label">
    <div class="preview-loading-page" aria-hidden="true">
      <span class="is-title"></span><span></span><span></span><span class="is-short"></span>
      <span class="is-block"></span><span></span><span class="is-short"></span>
    </div>
    <p>{{ label }}</p>
    <div v-if="progress > 0" class="preview-loading-bar" aria-hidden="true"><span :style="{ width: `${Math.round(progress * 100)}%` }"></span></div>
  </div>
</template>

<style scoped>
.preview-loading { display: flex; flex: 1; flex-direction: column; align-items: center; justify-content: center; gap: 14px; min-width: 0; padding: 24px;
  color: var(--ui-text-muted); font-size: 13px; animation: preview-loading-in .25s ease-out both; }
.preview-loading p { margin: 0; }
.preview-loading-page { display: flex; flex-direction: column; gap: 9px; width: min(220px, 60vw); padding: 22px 20px; border: 1px solid var(--ui-border);
  border-radius: 10px; background: var(--ui-bg-elevated); box-shadow: 0 8px 28px rgb(0 0 0 / .12); animation: preview-loading-float 2.4s ease-in-out infinite; }
.preview-loading-page span { height: 7px; border-radius: 4px; background: linear-gradient(90deg, var(--ui-bg-accented) 25%, color-mix(in srgb, var(--ui-primary) 22%, var(--ui-bg-accented)) 50%, var(--ui-bg-accented) 75%);
  background-size: 300% 100%; animation: preview-loading-shimmer 1.4s linear infinite; }
.preview-loading-page .is-title { width: 55%; height: 11px; margin-bottom: 4px; }
.preview-loading-page .is-short { width: 62%; }
.preview-loading-page .is-block { height: 46px; margin: 3px 0; }
.preview-loading-bar { width: min(220px, 60vw); height: 3px; overflow: hidden; border-radius: 2px; background: var(--ui-bg-accented); }
.preview-loading-bar span { display: block; height: 100%; border-radius: inherit; background: var(--ui-primary); transition: width .2s ease-out; }
@keyframes preview-loading-shimmer { from { background-position: 100% 0; } to { background-position: -200% 0; } }
@keyframes preview-loading-float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-4px); } }
@keyframes preview-loading-in { from { opacity: 0; transform: scale(.98); } to { opacity: 1; transform: none; } }
</style>

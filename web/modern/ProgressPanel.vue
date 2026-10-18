<script setup>
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from "vue";
import ProgressBoard from "./ProgressBoard.vue";

/** Header progress chip; it opens a floating board only when the right rail cannot show it. */
const props = defineProps({ floating: { type: Boolean, default: true } });
const { view, bridge } = inject("discussion");
const PANEL_KEY = "ai-codiscuss-progress-panel";
const expanded = ref(read_expanded());
const anchor = ref(null);
onMounted(() => document.addEventListener("pointerdown", collapse_on_outside));
onBeforeUnmount(() => document.removeEventListener("pointerdown", collapse_on_outside));
watch(expanded, (value) => {
  try { localStorage.setItem(PANEL_KEY, JSON.stringify({ expanded: value })); }
  catch { /* The panel still toggles for this page. */ }
});
const room = computed(() => view.value.room);
const limits = computed(() => room.value.limits || {});
const tone = computed(() => room.value.phase === "concluded" ? "neutral" : limits.value.closing ? "warning"
  : room.value.phase === "paused" ? "neutral" : limits.value.reached ? "warning" : "primary");

/** Collapse when the pointer lands outside the panel, keeping its own dialogs and menus usable. */
function collapse_on_outside(event) {
  if (!expanded.value || anchor.value?.contains(event.target)) return;
  if (event.target.closest?.("[role='dialog'], [data-reka-popper-content-wrapper]")) return;
  expanded.value = false;
}

/** Restore the last expanded state without failing when storage is unavailable. */
function read_expanded() {
  try { return JSON.parse(localStorage.getItem(PANEL_KEY))?.expanded === true; }
  catch { return false; }
}
</script>

<template>
  <div ref="anchor" class="progress-panel-anchor">
    <button v-if="props.floating" type="button" class="progress-chip" :class="`is-${tone}`" :aria-expanded="expanded" aria-controls="progress-panel" :title="expanded ? '收起进度看板' : '展开进度看板'" @click="expanded = !expanded">
      <span class="progress-dot"></span><span class="progress-chip-text">{{ bridge.progress_round(room) }}</span><UIcon :name="expanded ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" />
    </button>
    <span v-else class="progress-chip is-static" :class="`is-${tone}`" role="status" title="进度看板显示在右侧栏"><span class="progress-dot"></span><span class="progress-chip-text">{{ bridge.progress_round(room) }}</span></span>
    <section v-if="props.floating && expanded" id="progress-panel" class="progress-panel" aria-label="讨论进度看板"><ProgressBoard /></section>
  </div>
</template>

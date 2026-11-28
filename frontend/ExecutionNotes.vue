<script>
// How far outside the transcript's visible area a folded row starts reading its texts.
const PRELOAD_MARGIN = "800px 0px";
// One observer per transcript, however many rows it holds.
const near_observers = new WeakMap();

/** Report whether `element` is near the transcript's visible area; returns the function that stops reporting. */
function observe_near(element, report) {
  const root = element.closest(".channel-transcript");
  if (!root || typeof IntersectionObserver === "undefined") return () => {};
  let shared = near_observers.get(root);
  if (!shared) {
    const reports = new Map();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) reports.get(entry.target)?.(entry.isIntersecting);
    }, { root, rootMargin: PRELOAD_MARGIN });
    shared = { observer, reports };
    near_observers.set(root, shared);
  }
  shared.reports.set(element, report);
  shared.observer.observe(element);
  return () => { shared.reports.delete(element); shared.observer.unobserve(element); };
}
</script>

<script setup>
/**
 * An execution's progress notes as a secondary row, laid out like the answer summary.
 * While the member works the row is open and is the card's content; afterwards it folds after the result, and the
 * texts are read ahead as the row nears the screen. It owns its open state so toggling never re-renders the list.
 * An ended execution's step count joins the row ("3 段 · 12 步"); with steps but no notes it reads "过程 · 12 步" and
 * cannot open, so a run stopped before it wrote any note still shows how far it got (user 2026-11-21, #6448).
 */
import { onBeforeUnmount, onMounted, ref } from "vue";

const props = defineProps({
  /** Number of notes the execution has; the texts may not be loaded yet. */
  count: { type: Number, default: 0 },
  /** Steps the ended execution took (commands, tools, edits); 0 when unknown or still running. */
  steps: { type: Number, default: 0 },
  /** Loaded notes, or null before the first read. */
  notes: { type: Array, default: null },
  /** Open and without a toggle while the member is still working. */
  live: Boolean,
  /** Read missing notes; returns a failure message, or nothing after success. */
  load: { type: Function, default: null },
  /** Told whether the folded row is near the screen, so its texts can be read before it is opened. */
  preload: { type: Function, default: null },
});
const open = ref(false);
const loading = ref(false), failure = ref("");
const row = ref(null);
let stop_observing = null;

onMounted(() => {
  // A row with steps but no notes has nothing to read.
  if (props.live || !props.preload || !props.count) return;
  stop_observing = observe_near(row.value, (near) => {
    if (!near) props.preload(false);
    else if ((props.notes?.length ?? -1) < props.count) props.preload(true);
  });
});
onBeforeUnmount(() => {
  stop_observing?.();
  props.preload?.(false);
});

async function read() {
  if (loading.value || !props.load) return;
  loading.value = true;
  failure.value = "";
  try { failure.value = await props.load() || ""; }
  finally { loading.value = false; }
}

function toggle() {
  open.value = !open.value;
  // Notes read while the member worked may miss the last few, so a shorter list is read again.
  if (open.value && (props.notes?.length ?? -1) < props.count) read();
}
</script>

<template>
  <div ref="row" class="channel-answer-summary channel-execution-notes">
    <small>{{ count || live ? t("过程说明") : t("过程") }}</small>
    <div class="channel-message-text">
      <ol v-if="live || open" :class="{ 'is-live': live }">
        <li v-for="note in notes || []" :key="note.seq">{{ note.text }}</li>
      </ol>
      <div v-if="open && loading" class="grid gap-2 py-2" role="status" :aria-label="t('正在读取过程说明')"><USkeleton class="h-4 w-full" /><USkeleton class="h-4 w-2/3" /></div>
      <p v-else-if="open && failure" class="fine-print" role="status">{{ failure }}<UButton :label="t('重试')" color="neutral" variant="link" size="xs" @click="read" /></p>
      <UButton v-if="!live && count" :label="open ? t('收起') : t('{count} 段', { count })" :trailing-icon="open ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
        variant="link" color="neutral" size="xs" class="channel-answer-toggle" :class="{ 'is-folded': !open }" :aria-expanded="open"
        :aria-label="open ? t('收起过程说明') : t('展开 {count} 段过程说明', { count })" @click="toggle" />
      <span v-if="!live && steps" class="execution-steps">{{ count ? t(' · {count} 步', { count: steps }) : t('{count} 步', { count: steps }) }}</span>
      <!-- More about how the answer was made, on the same line (the answer card's tokens, #16077). -->
      <slot />
    </div>
  </div>
</template>

<style scoped>
ol { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; white-space: pre-wrap; overflow-wrap: anywhere; }
/* While working, the latest remark is where the member is now; earlier ones step back. */
ol.is-live li { opacity: .65; }
ol.is-live li:last-child { opacity: 1; }
/* Folded, the toggle stands on the label's baseline like the summary text does. */
.channel-answer-toggle.is-folded { min-height: 0; margin-top: 0; }
.execution-steps { color: var(--ui-text-dimmed); font-size: 12px; white-space: pre; }
</style>

<script setup>
/**
 * How far one draft file has come, handed to the slot as `percent` (0–100, or null when none is measured) and `phase`
 * ("compress" or "upload"). It listens by itself, so a percent changing redraws only what the slot shows, even inside
 * the memoized transcript.
 */
import { onBeforeUnmount, ref, watch } from "vue";

const props = defineProps({
  /** The draft file's id. */
  id: { type: String, required: true },
});
const bridge = window.discuss_view;
const progress = ref(bridge.upload_progress(props.id));
watch(() => props.id, (id) => { progress.value = bridge.upload_progress(id); });

/** Take the progress of this file from the page's reports. */
function update(event) {
  if (event.detail.id === props.id) progress.value = event.detail;
}
document.addEventListener("discuss:upload-percent", update);
onBeforeUnmount(() => document.removeEventListener("discuss:upload-percent", update));
</script>

<template>
  <slot :percent="progress.percent" :phase="progress.phase" />
</template>

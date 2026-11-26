<script setup>
/**
 * One entry's picture in the file page's icon view: a PNG, JPEG or WebP image shows the small copy the computer made
 * once the tile scrolls into view (`bridge.read_room_thumbnail`); everything else, and an image without one, its icon.
 */
import { inject, onBeforeUnmount, onMounted, ref } from "vue";

const props = defineProps({
  entry: { type: Object, required: true },
  root: { type: [Number, String], required: true },
  icon: { type: Array, required: true },
});
const { view, bridge } = inject("discussion");
const room_id = view.value.room.id;
const element = ref(null);
const url = ref("");
let observer = null, gone = false;

onMounted(() => {
  if (props.entry.kind !== "file" || !/\.(png|jpe?g|webp)$/i.test(props.entry.name)) return;
  observer = new IntersectionObserver((seen) => {
    if (!seen.some((item) => item.isIntersecting)) return;
    observer.disconnect();
    queue_thumbnail(async () => {
      if (gone) return;
      const version = `${props.entry.size}:${props.entry.modified_at}`;
      try { url.value = await bridge.read_room_thumbnail(room_id, props.entry.path, props.root, version); }
      catch { /* The icon stays. */ }
    });
  }, { rootMargin: "200px" });
  observer.observe(element.value);
});
onBeforeUnmount(() => { gone = true; observer?.disconnect(); });
</script>

<script>
// A folder of images asks the computer for a few thumbnails at a time, in the order the tiles came into view.
const THUMBNAIL_CONCURRENCY = 3;
const waiting = [];
let running = 0;
function queue_thumbnail(task) {
  waiting.push(task);
  run_thumbnails();
}
function run_thumbnails() {
  while (running < THUMBNAIL_CONCURRENCY && waiting.length) {
    running++;
    waiting.shift()().finally(() => { running--; run_thumbnails(); });
  }
}
</script>

<template>
  <span ref="element" class="project-thumbnail">
    <img v-if="url" :src="url" alt="" draggable="false" />
    <UIcon v-else :name="icon[0]" class="project-file-icon project-thumbnail-icon" :class="icon[1]" />
  </span>
</template>

<style scoped>
.project-thumbnail { display: flex; align-items: center; justify-content: center; width: 100%; aspect-ratio: 1; overflow: hidden; border-radius: 6px; }
.project-thumbnail img { width: 100%; height: 100%; object-fit: contain; }
.project-file-icon.project-thumbnail-icon { width: 44%; height: 44%; }
</style>

<script setup>
/**
 * The file preview's viewer for one image, video or audio file: Viewer.js (MIT) for images, zoomed, rotated, flipped
 * and dragged in place; the Video.js 10 (Apache-2.0) players with Chinese labels for video and audio. `url` is a
 * stream address of the computer's own website or a Blob URL read through the relay; a format the browser cannot
 * decode says so and keeps the download.
 */
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { IMAGE_TOOLBAR, IMAGE_ZOOM, Viewer } from "./image-viewer.js";
import "./media-players.js";


const props = defineProps({
  kind: { type: String, required: true },
  url: { type: String, required: true },
  name: { type: String, default: "" },
});
const image = ref(null), failed = ref(false);
let viewer = null;

/** Show the current image inline in the preview body, replacing the viewer of a previous one. */
function mount_viewer() {
  viewer?.destroy();
  viewer = null;
  if (props.kind !== "image" || !image.value) return;
  viewer = new Viewer(image.value, { inline: true, navbar: false, title: false, button: false, backdrop: false,
    transition: false, toolbar: IMAGE_TOOLBAR, toggleOnDblclick: true, ...IMAGE_ZOOM });
}

onMounted(mount_viewer);
watch(() => [props.kind, props.url], () => { failed.value = false; nextTick(mount_viewer); });
onBeforeUnmount(() => viewer?.destroy());
</script>

<template>
  <div class="media-viewer" :class="`is-${kind}`">
    <p v-if="failed" class="media-viewer-error">浏览器无法播放这个文件的格式（例如 AVI、WMV 或特殊编码的 MOV），请下载后用本机软件打开。</p>
    <div v-if="kind === 'image'" class="media-viewer-image"><img ref="image" :src="url" :alt="name" @error="failed = true"></div>
    <div v-else-if="failed" class="media-viewer-player"></div>
    <div v-else-if="kind === 'video'" class="media-viewer-player">
      <video-player><video-skin class="media-viewer-video"><video :src="url" preload="metadata" playsinline @error="failed = true"></video></video-skin></video-player>
    </div>
    <div v-else class="media-viewer-player">
      <audio-player><audio-skin class="media-viewer-audio"><audio :src="url" preload="metadata" @error="failed = true"></audio></audio-skin></audio-player>
    </div>
  </div>
</template>

<style scoped>
.media-viewer { display: flex; flex-direction: column; gap: 8px; height: 100%; min-height: 0; padding: 12px; }
.media-viewer-error { margin: 0; color: var(--ui-text-muted); font-size: 12px; }
.media-viewer-image { flex: 1; min-height: 240px; }
.media-viewer-image img { display: none; }
.media-viewer-player { display: grid; flex: 1; place-items: center; min-height: 0; }
.media-viewer-video { display: block; width: 100%; max-height: 100%; aspect-ratio: 16 / 9; }
.media-viewer-audio { display: block; width: min(640px, 100%); }
.media-viewer.is-audio .media-viewer-player { align-content: center; }
</style>

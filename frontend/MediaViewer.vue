<script setup>
/**
 * The file preview's viewer for one image, video or audio file: Viewer.js (MIT) for images, zoomed, rotated, flipped
 * and dragged in place; the Video.js 10 (Apache-2.0) players with Chinese labels for video and audio. `url` is a
 * stream address of the computer's own website or a Blob URL read through the relay; a format the browser cannot
 * decode says so and keeps the download.
 */
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { IMAGE_TOOLBAR, IMAGE_ZOOM, Viewer } from "./image-viewer.js";
import PreviewLoading from "./PreviewLoading.vue";
import "./media-players.js";


const props = defineProps({
  kind: { type: String, required: true },
  url: { type: String, required: true },
  name: { type: String, default: "" },
});
const image = ref(null), failed = ref(false);
const loading = ref(true);
const attempt = ref(0);
let viewer = null;

/** Show the current image inline in the preview body, replacing the viewer of a previous one. */
function mount_viewer() {
  viewer?.destroy();
  viewer = null;
  if (props.kind !== "image" || !image.value) return;
  viewer = new Viewer(image.value, { inline: true, navbar: false, title: false, button: false, backdrop: false,
    transition: false, toolbar: IMAGE_TOOLBAR, toggleOnDblclick: true, ...IMAGE_ZOOM, viewed: () => { loading.value = false; } });
}

/** Recreate the failed media element so the browser reads and decodes it again. */
function retry() {
  failed.value = false;
  loading.value = true;
  attempt.value++;
  nextTick(mount_viewer);
}

onMounted(mount_viewer);
watch(() => [props.kind, props.url], () => { failed.value = false; loading.value = true; nextTick(mount_viewer); });
onBeforeUnmount(() => viewer?.destroy());
</script>

<template>
  <div :key="attempt" class="media-viewer" :class="`is-${kind}`">
    <p v-if="failed" class="media-viewer-error">{{ kind === 'image' ? '图片读取失败，请重试或下载后打开。' : '浏览器无法播放这个文件的格式（例如 AVI、WMV 或特殊编码的 MOV），请下载后用本机软件打开。' }}<UButton label="重试" color="neutral" variant="link" size="xs" @click="retry" /></p>
    <Transition name="media-ready"><PreviewLoading v-if="loading && !failed" class="media-viewer-loading" :label="kind === 'image' ? '正在载入图片…' : '正在载入媒体…'" /></Transition>
    <div v-if="kind === 'image'" class="media-viewer-image"><img ref="image" :src="url" :alt="name" @error="failed = true"></div>
    <div v-else-if="failed" class="media-viewer-player"></div>
    <div v-else-if="kind === 'video'" class="media-viewer-player">
      <video-player><video-skin class="media-viewer-video"><video :src="url" preload="metadata" playsinline @loadedmetadata="loading = false" @error="failed = true"></video></video-skin></video-player>
    </div>
    <div v-else class="media-viewer-player">
      <audio-player><audio-skin class="media-viewer-audio"><audio :src="url" preload="metadata" @loadedmetadata="loading = false" @error="failed = true"></audio></audio-skin></audio-player>
    </div>
  </div>
</template>

<style scoped>
/* The preview body lays its child out in a row: without flex and width the players shrink to their content. */
.media-viewer { display: flex; flex: 1; flex-direction: column; gap: 8px; width: 100%; min-width: 0; height: 100%; min-height: 0; padding: 12px; }
.media-viewer-error { margin: 0; color: var(--ui-text-muted); font-size: 12px; }
.media-viewer { position: relative; }
.media-viewer-loading { position: absolute; inset: 0; z-index: 2; background: var(--ui-bg); pointer-events: none; }
.media-ready-leave-active { transition: opacity .2s ease; }
.media-ready-leave-to { opacity: 0; }
.media-viewer-image { flex: 1; min-height: 240px; }
.media-viewer-image img { display: none; }
.media-viewer-player { display: grid; flex: 1; place-items: center; min-height: 0; }
.media-viewer-video { display: block; width: 100%; max-height: 100%; aspect-ratio: 16 / 9; }
.media-viewer-audio { display: block; width: min(640px, 100%); }
.media-viewer.is-audio .media-viewer-player { align-content: center; }
</style>

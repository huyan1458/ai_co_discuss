<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { HTML_SANDBOX } from "./file-preview.js";
import { INLINE_VISUAL_SANDBOX, RELAY_FRAME, relay_frame_loaded, inline_visual_height, inline_visual_theme, observe_inline_visual, observe_visual_theme, remember_visual_height, remembered_visual_height, send_visual_theme } from "./inline-visual.js";
import PreviewLoading from "./PreviewLoading.vue";
import { t } from "./i18n.js";

const props = defineProps({ file: { type: Object, required: true }, preview: Object, automatic: Boolean });
const emit = defineEmits(["visible"]);
const panel = ref(null), frame = ref(null);
const visible = ref(!props.automatic);
const height = ref(remembered_visual_height(props.file));
let stop_observing, transcript, pending_height = null;

function send_theme() {
  if (!relay_frame_loaded(frame.value, props.preview?.srcdoc)) return;
  if (frame.value && panel.value) send_visual_theme(frame.value.contentWindow, inline_visual_theme(panel.value));
}

function apply_height() {
  if (pending_height === null) return;
  height.value = pending_height;
  remember_visual_height(props.file, pending_height);
  pending_height = null;
}

function receive_height(event) {
  const measured = inline_visual_height(event, frame.value?.contentWindow);
  if (measured === null) return;
  pending_height = measured;
  if (!transcript?.hasAttribute("data-reader-scrolling")) apply_height();
}

watch(frame, (element, previous, on_cleanup) => {
  if (element) on_cleanup(observe_visual_theme(send_theme));
});

onMounted(() => {
  transcript = panel.value.closest(".channel-transcript");
  transcript?.addEventListener("reader-settled", apply_height);
  window.addEventListener("message", receive_height);
  // Once shown the frame stays mounted: a remounted frame paints blank until its document renders, which flickers while scrolling.
  if (props.automatic) stop_observing = observe_inline_visual(panel.value, (shown) => {
    if (!shown) return;
    visible.value = true;
    emit("visible");
    stop_observing?.();
    stop_observing = null;
  });
});
onBeforeUnmount(() => {
  stop_observing?.();
  transcript?.removeEventListener("reader-settled", apply_height);
  window.removeEventListener("message", receive_height);
});
</script>

<template>
  <div ref="panel" class="channel-inline-html" :style="{ '--inline-html-height': height + 'px' }">
    <iframe v-if="visible && preview?.status === 'ready'" ref="frame" :sandbox="automatic ? INLINE_VISUAL_SANDBOX : HTML_SANDBOX" referrerpolicy="no-referrer"
      :key="RELAY_FRAME ? preview.srcdoc : 'frame'" :src="RELAY_FRAME || undefined" :srcdoc="RELAY_FRAME ? undefined : preview.srcdoc" :title="file.file_name" @load="send_theme"></iframe>
    <PreviewLoading v-else-if="visible" :label="t('正在读取附件…')" />
  </div>
</template>

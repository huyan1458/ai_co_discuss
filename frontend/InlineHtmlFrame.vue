<script setup>
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { file_preview, put_visual_result } from "./file-preview.js";
import { INLINE_VISUAL_SANDBOX, VISUAL_RESULT_LIMIT, inline_visual_document, inline_visual_height, inline_visual_theme, observe_inline_visual, observe_visual_theme, remember_visual_height, remembered_visual_height, send_visual_theme, visual_result } from "./inline-visual.js";
import PreviewLoading from "./PreviewLoading.vue";
import { t } from "./i18n.js";

const props = defineProps({ visual: { type: Object, required: true } });
const notify = inject("discussion", null)?.bridge?.notify;
// A panel that submits in a loop only keeps replacing its own quote; the notice is shown at most this often.
const RESULT_NOTICE_INTERVAL_MS = 1500;
let last_result_notice = 0;
const panel = ref(null), frame = ref(null);
const visible = ref(false);
const hovered = ref(false);
// Chromium can deliver the next pointer event in the parent without a leave in the opaque frame.
watch(hovered, (inside, previous, on_cleanup) => {
  if (!inside) return;
  const clear = () => { hovered.value = false; };
  document.addEventListener("pointerover", clear, true);
  on_cleanup(() => document.removeEventListener("pointerover", clear, true));
});
const srcdoc = computed(() => inline_visual_document(props.visual.source, true, { submit: file_preview.visual_results }));

/** Take a panel's result into the composer as a quote; the reader still reviews and sends it. */
function receive_result(event) {
  const result = file_preview.visual_results ? visual_result(event, frame.value?.contentWindow) : null;
  if (!result) return false;
  const now = Date.now(), quiet = now - last_result_notice < RESULT_NOTICE_INTERVAL_MS;
  if (!quiet) last_result_notice = now;
  if (result.error) {
    if (!quiet) notify?.("warning", t('可视化提交的内容超过 {value1} 字，没有放进输入框。', { value1: VISUAL_RESULT_LIMIT }));
    return true;
  }
  const outcome = put_visual_result(props.visual, result.text);
  if (!quiet) notify?.("info", outcome === "added" ? t('已放到输入框上方，确认后发送。') : t('已更新输入框上方的可视化结果。'));
  return true;
}
const height = ref(remembered_visual_height(props.visual));
// The frame stays hidden behind the loading placeholder until its document is in: an empty frame shows as a white box.
const shown = ref(false);
watch(srcdoc, () => { shown.value = false; });
let stop_observing, transcript, pending_height = null;

function frame_loaded() {
  shown.value = true;
  send_theme();
}

function send_theme() {
  if (frame.value && panel.value) send_visual_theme(frame.value.contentWindow, inline_visual_theme(panel.value));
}

function apply_height() {
  if (pending_height === null) return;
  height.value = pending_height;
  remember_visual_height(props.visual, pending_height);
  pending_height = null;
}

function receive_height(event) {
  if (receive_result(event)) return;
  if (frame.value && event.source === frame.value.contentWindow && typeof event.data?.codiscuss_visual_hover === "boolean") {
    hovered.value = event.data.codiscuss_visual_hover;
    return;
  }
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
  stop_observing = observe_inline_visual(panel.value, (in_view) => {
    if (!in_view) return;
    visible.value = true;
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
  <div ref="panel" class="channel-inline-html" :class="{ 'is-hovered': hovered }" :style="{ '--inline-html-height': height + 'px' }">
    <iframe v-if="visible" ref="frame" :class="{ 'is-waiting': !shown }" :sandbox="INLINE_VISUAL_SANDBOX" referrerpolicy="no-referrer"
      :srcdoc="srcdoc" :title="visual.name" @load="frame_loaded"></iframe>
    <PreviewLoading v-if="visible && !shown" class="channel-inline-html-loading" :label="t('正在加载交互式可视化…')" />
  </div>
</template>

<script setup>
/**
 * The file preview's read-only view of one Office document. The renderers are separate modules under /office/
 * (frontend/office/, built with `--mode office`), imported only when such a file is opened: docx-preview for Word,
 * SheetJS for Excel, @silurus/ooxml for PowerPoint. Word and Excel content is placed in frames without scripts, so
 * nothing in a file can run as this site; slides are drawn on canvases. `url` is a stream address of the computer's
 * own website, an attachment's address, or a Blob URL read through the relay.
 */
import { nextTick, onBeforeUnmount, ref, watch } from "vue";

const props = defineProps({ kind: { type: String, required: true }, url: { type: String, required: true } });
const MODULES = { docx: "/office/docx.js", sheet: "/office/xlsx.js", slides: "/office/pptx.js" };
// The Word frame may be reached from this page to lay the document out, but runs no scripts of its own.
const DOCX_FRAME = '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#e9ebef}'
  + '.docx-wrapper{background:#e9ebef!important;padding:16px!important}</style></head><body></body></html>';
const SHEET_STYLE = "<meta charset=\"utf-8\"><style>body{margin:0;font:13px/1.45 system-ui,sans-serif;color:#1f2328;background:#fff}"
  + "table{border-collapse:collapse}td,th{border:1px solid #d0d7de;padding:3px 8px;white-space:nowrap;vertical-align:top}"
  + "tr:first-child td{background:#f6f8fa;font-weight:600;position:sticky;top:0}</style>";
const state = ref("loading"), error = ref(""), sheets = ref([]), sheet = ref(0);
const docx_frame = ref(null), slides_host = ref(null), frame_loaded = ref(false);
let viewer = null, version = 0;

/** The file's bytes, for the renderers that take them rather than a URL. */
async function file_bytes() {
  const response = await fetch(props.url);
  if (!response.ok) throw new Error(`文件读取失败（${response.status}）`);
  return response.arrayBuffer();
}

/** Lay out a Word document inside its frame; links open in a new tab instead of inside the preview. */
async function show_docx(module, run) {
  const data = await file_bytes();
  // A new frame first reports its blank page as loaded; only its own load event means the srcdoc page is in.
  if (!frame_loaded.value) await new Promise(resolve => { const stop = watch(frame_loaded, () => { stop(); resolve(); }); });
  if (run !== version) return;
  const document = docx_frame.value.contentDocument;
  document.body.replaceChildren();
  await module.render_docx(data, document.body, document.head);
  document.addEventListener("click", (event) => {
    const link = event.target.closest?.("a[href]");
    if (!link) return;
    event.preventDefault();
    if (/^https?:/i.test(link.href)) window.open(link.href, "_blank", "noopener,noreferrer");
  });
}

/** Read every sheet of a workbook; the tabs above switch between them. */
async function show_sheets(module) {
  sheets.value = module.workbook_sheets(await file_bytes());
  sheet.value = 0;
}

/** Draw a deck's slides in one scrolling view. */
async function show_slides(module, run) {
  await nextTick();
  const mounted = await module.mount_pptx(slides_host.value, props.url);
  if (run !== version) { mounted.destroy(); return; }
  viewer = mounted;
}

async function render() {
  const run = ++version;
  viewer?.destroy();
  viewer = null;
  state.value = "loading";
  error.value = "";
  sheets.value = [];
  try {
    const module = await import(/* @vite-ignore */ MODULES[props.kind]);
    if (run !== version) return;
    if (props.kind === "docx") await show_docx(module, run);
    else if (props.kind === "sheet") await show_sheets(module);
    else await show_slides(module, run);
    if (run === version) state.value = "ready";
  } catch (failure) {
    if (run !== version) return;
    state.value = "failed";
    error.value = failure?.message || String(failure);
  }
}

watch(() => [props.kind, props.url], render, { immediate: true });
onBeforeUnmount(() => { version++; viewer?.destroy(); });
</script>

<template>
  <div class="office-viewer">
    <div v-if="state === 'failed'" class="office-viewer-state"><UIcon name="i-lucide-circle-alert" /><p>无法预览这个文件：{{ error }}。可能是加密、损坏，或旧版 .doc / .ppt 格式；请下载后用本机软件打开。</p></div>
    <div v-else-if="state === 'loading'" class="office-viewer-state" role="status"><UIcon name="i-lucide-loader-circle" class="animate-spin" />正在打开文档…</div>
    <iframe v-if="kind === 'docx'" v-show="state === 'ready'" ref="docx_frame" class="office-viewer-frame" sandbox="allow-same-origin" referrerpolicy="no-referrer" :srcdoc="DOCX_FRAME" title="Word 文档预览" @load="frame_loaded = true"></iframe>
    <template v-else-if="kind === 'sheet' && state === 'ready'">
      <nav v-if="sheets.length > 1" class="office-viewer-sheets" aria-label="工作表">
        <button v-for="(item, index) in sheets" :key="item.name" type="button" :aria-pressed="sheet === index" @click="sheet = index">{{ item.name }}</button>
      </nav>
      <p v-if="sheets[sheet]?.cut" class="office-viewer-note">只显示前 5000 行；完整内容请下载后查看。表格只显示数值与合并单元格，不含样式与图表。</p>
      <iframe class="office-viewer-frame" sandbox="" referrerpolicy="no-referrer" :srcdoc="SHEET_STYLE + (sheets[sheet]?.html || '')" title="表格预览"></iframe>
    </template>
    <div v-else-if="kind === 'slides'" v-show="state !== 'failed'" ref="slides_host" class="office-viewer-slides"></div>
  </div>
</template>

<style scoped>
.office-viewer { position: relative; display: flex; flex-direction: column; height: 100%; min-height: 0; }
.office-viewer-state { display: flex; gap: 8px; align-items: center; justify-content: center; padding: 24px; color: var(--ui-text-muted); font-size: 13px; }
.office-viewer-state p { margin: 0; max-width: 520px; }
.office-viewer-frame { flex: 1; width: 100%; min-height: 0; border: 0; background: #fff; }
.office-viewer-slides { flex: 1; min-height: 0; }
.office-viewer-sheets { display: flex; gap: 4px; padding: 6px 8px; overflow-x: auto; border-bottom: 1px solid var(--ui-border); }
.office-viewer-sheets button { flex-shrink: 0; padding: 2px 10px; border-radius: 4px; color: var(--ui-text-muted); font-size: 12px; }
.office-viewer-sheets button[aria-pressed="true"] { color: var(--ui-text-highlighted); background: var(--ui-bg-accented); }
.office-viewer-note { margin: 0; padding: 4px 10px; color: var(--ui-text-muted); font-size: 12px; }
</style>

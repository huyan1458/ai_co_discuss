<script setup>
/**
 * The file preview's read-only view of one Office document or PDF. The renderers load only when such a file opens:
 * docx-preview (Word), SheetJS (Excel) and @silurus/ooxml (PowerPoint) are separate modules under /office/ (built from
 * frontend/office/ with `--mode office`); PDF.js comes from /pdfjs/. Word and Excel content sits in frames without
 * scripts, so nothing in a file runs as this site; slides and PDF pages are drawn on canvases. The module and the
 * file's bytes load together, and the loading animation covers the content while it lays out at its real size.
 * `url` is a stream address of the computer's website, an attachment's address, or a Blob URL read through the relay.
 */
import { nextTick, onBeforeUnmount, ref, watch } from "vue";
import PreviewLoading from "./PreviewLoading.vue";

const props = defineProps({ kind: { type: String, required: true }, url: { type: String, required: true } });
const MODULES = { docx: "/office/docx.js", sheet: "/office/xlsx.js", slides: "/office/pptx.js", pdf: "/pdfjs/pdf.min.mjs" };
const LABELS = { docx: "正在排版 Word 文档…", sheet: "正在读取表格…", slides: "正在绘制幻灯片…", pdf: "正在打开 PDF…" };
// The Word frame may be reached from this page to lay the document out, but runs no scripts of its own.
const DOCX_FRAME = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head><body></body></html>';
// Added after docx-preview has laid the document out, since it empties the style container it is given.
const DOCX_STYLE = "html,body{margin:0;background:#e9ebef}.docx-wrapper{background:#e9ebef!important;padding:12px!important;align-items:center}"
  + ".docx-wrapper>section.docx{margin-bottom:12px!important;box-shadow:0 2px 10px rgb(0 0 0/.15)}";
const SHEET_STYLE = "<meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\"><style>body{margin:0;font:13px/1.45 system-ui,sans-serif;color:#1f2328;background:#fff}"
  + "table{border-collapse:collapse}td,th{border:1px solid #d0d7de;padding:3px 8px;white-space:nowrap;vertical-align:top}"
  + "tr:first-child td{background:#f6f8fa;font-weight:600;position:sticky;top:0}</style>";
// PDF pages are drawn at most this sharp, and a page wider than the window is drawn to fit it.
const PDF_MAX_PIXEL_RATIO = 2;
const PDF_MAX_SCALE = 2;
const PDF_GUTTER = 24;
const state = ref("loading"), error = ref(""), sheets = ref([]), sheet = ref(0);
const docx_frame = ref(null), slides_host = ref(null), pdf_host = ref(null), frame_loaded = ref(false);
let viewer = null, pdf_task = null, pdf_document = null, page_observer = null, resize_observer = null, version = 0;
let sheet_worker = null, cancel_sheet = null;

/** The file's bytes, for the renderers that take them rather than a URL. */
async function file_bytes() {
  const response = await fetch(props.url);
  if (!response.ok) throw new Error(`文件读取失败（${response.status}）`);
  return response.arrayBuffer();
}

/** Parse workbook bytes and build its tables in a worker, leaving the preview controls responsive. */
function read_sheets() {
  const worker = sheet_worker = new Worker(MODULES.sheet, { type: "module" });
  const result = new Promise((resolve, reject) => {
    cancel_sheet = () => reject(new Error("已关闭表格"));
    worker.onmessage = ({ data }) => data.error ? reject(new Error(data.error)) : resolve(data.sheets);
    worker.onerror = (event) => reject(new Error(event.message || "表格解析失败"));
    file_bytes().then((data) => worker.postMessage(data, [data])).catch(reject);
  });
  return result.finally(() => {
    worker.terminate();
    if (sheet_worker === worker) { sheet_worker = null; cancel_sheet = null; }
  });
}

/** Scale the Word pages down to the frame's width; a phone shows the whole page instead of its top-left corner. */
function fit_docx() {
  const frame = docx_frame.value, wrapper = frame?.contentDocument?.querySelector(".docx-wrapper");
  const page = wrapper?.querySelector("section.docx");
  if (!page) return;
  wrapper.style.zoom = "";
  wrapper.style.zoom = String(Math.min(1, frame.clientWidth / (page.offsetWidth + 24)));
}

/** Lay out a Word document inside its frame; links open in a new tab instead of inside the preview. */
async function show_docx(module, data, run) {
  // A new frame first reports its blank page as loaded; only its own load event means the srcdoc page is in.
  if (!frame_loaded.value) await new Promise(resolve => { const stop = watch(frame_loaded, () => { stop(); resolve(); }); });
  if (run !== version) return;
  const document = docx_frame.value.contentDocument;
  document.body.replaceChildren();
  await module.render_docx(data, document.body, document.head);
  if (run !== version) return;
  const style = document.createElement("style");
  style.textContent = DOCX_STYLE;
  document.head.append(style);
  document.addEventListener("click", (event) => {
    const link = event.target.closest?.("a[href]");
    if (!link) return;
    event.preventDefault();
    if (/^https?:/i.test(link.href)) window.open(link.href, "_blank", "noopener,noreferrer");
  });
  fit_docx();
  resize_observer = new ResizeObserver(fit_docx);
  resize_observer.observe(docx_frame.value);
}

/** Draw one PDF page into its canvas once it scrolls near the view. */
async function draw_pdf_page(canvas) {
  if (canvas.dataset.drawn) return;
  canvas.dataset.drawn = "1";
  const page = await pdf_document.getPage(Number(canvas.dataset.page));
  const viewport = page.getViewport({ scale: Number(canvas.dataset.scale) });
  const ratio = Math.min(window.devicePixelRatio || 1, PDF_MAX_PIXEL_RATIO);
  canvas.width = Math.floor(viewport.width * ratio);
  canvas.height = Math.floor(viewport.height * ratio);
  await page.render({ canvasContext: canvas.getContext("2d"), viewport, transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0] }).promise;
}

/** Lay out every PDF page at the window's width; each is drawn as it comes into view, the first shown at once. */
async function show_pdf(module, data, run) {
  module.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";
  pdf_task = module.getDocument({ data, cMapUrl: "/pdfjs/cmaps/", cMapPacked: true, standardFontDataUrl: "/pdfjs/standard_fonts/",
    wasmUrl: "/pdfjs/wasm/", iccUrl: "/pdfjs/iccs/", isEvalSupported: false, enableXfa: false });
  pdf_document = await pdf_task.promise;
  if (run !== version) return;
  await nextTick();
  const host = pdf_host.value, width = Math.max(200, host.clientWidth - PDF_GUTTER);
  page_observer = new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) draw_pdf_page(entry.target).catch(() => {});
  }, { root: host, rootMargin: "600px 0px" });
  for (let number = 1; number <= pdf_document.numPages && run === version; number++) {
    const base = (await pdf_document.getPage(number)).getViewport({ scale: 1 });
    const scale = Math.min(width / base.width, PDF_MAX_SCALE);
    const canvas = document.createElement("canvas");
    Object.assign(canvas.dataset, { page: String(number), scale: String(scale) });
    Object.assign(canvas.style, { width: `${Math.floor(base.width * scale)}px`, height: `${Math.floor(base.height * scale)}px` });
    host.append(canvas);
    page_observer.observe(canvas);
    if (number === 1) { await draw_pdf_page(canvas); state.value = "ready"; }
  }
}

/** Draw a deck's slides in one scrolling view; it fits the slides to the container's width itself. */
async function show_slides(module, run) {
  await nextTick();
  const mounted = await module.mount_pptx(slides_host.value, props.url);
  if (run !== version) { mounted.destroy(); return; }
  viewer = mounted;
}

function release() {
  cancel_sheet?.();
  sheet_worker?.terminate();
  sheet_worker = cancel_sheet = null;
  if (typeof viewer?.destroy === "function") viewer.destroy();
  // PDF.js tears a document down through the task that loaded it.
  pdf_task?.destroy().catch(() => {});
  page_observer?.disconnect();
  resize_observer?.disconnect();
  viewer = pdf_task = pdf_document = page_observer = resize_observer = null;
  pdf_host.value?.replaceChildren();
}

async function render() {
  const run = ++version;
  release();
  state.value = "loading";
  error.value = "";
  sheets.value = [];
  try {
    if (props.kind === "sheet") {
      const result = await read_sheets();
      if (run === version) { sheets.value = result; sheet.value = 0; if (!result.length) state.value = "ready"; }
      return;
    }
    // The renderer and the file come in parallel; the deck viewer reads its URL itself.
    const [module, data] = await Promise.all([import(/* @vite-ignore */ MODULES[props.kind]), props.kind === "slides" ? null : file_bytes()]);
    if (run !== version) return;
    if (props.kind === "docx") await show_docx(module, data, run);
    else if (props.kind === "pdf") await show_pdf(module, data, run);
    else await show_slides(module, run);
    if (run === version) state.value = "ready";
  } catch (failure) {
    if (run !== version) return;
    state.value = "failed";
    error.value = failure?.message || String(failure);
  }
}

watch(() => [props.kind, props.url], render, { immediate: true });
onBeforeUnmount(() => { version++; release(); });
</script>

<template>
  <div class="office-viewer">
    <iframe v-if="kind === 'docx'" ref="docx_frame" class="office-viewer-frame" sandbox="allow-same-origin" referrerpolicy="no-referrer" :srcdoc="DOCX_FRAME" title="Word 文档预览" @load="frame_loaded = true"></iframe>
    <template v-else-if="kind === 'sheet'">
      <nav v-if="sheets.length > 1" class="office-viewer-sheets" aria-label="工作表">
        <button v-for="(item, index) in sheets" :key="item.name" type="button" :aria-pressed="sheet === index" @click="sheet !== index && (state = 'loading', sheet = index)">{{ item.name }}</button>
      </nav>
      <p v-if="sheets[sheet]?.cut" class="office-viewer-note">只显示前 5000 行；完整内容请下载后查看。表格只显示数值与合并单元格，不含样式与图表。</p>
      <iframe v-if="sheets.length" :key="sheet" class="office-viewer-frame" sandbox="" referrerpolicy="no-referrer" :srcdoc="SHEET_STYLE + (sheets[sheet]?.html || '')" title="表格预览" @load="state = 'ready'"></iframe>
    </template>
    <div v-else-if="kind === 'pdf'" ref="pdf_host" class="office-viewer-pages" tabindex="0" aria-label="PDF 页面"></div>
    <div v-else ref="slides_host" class="office-viewer-slides"></div>
    <Transition name="office-viewer-fade">
      <PreviewLoading v-if="state === 'loading'" class="office-viewer-cover" :label="LABELS[kind]" />
    </Transition>
    <div v-if="state === 'failed'" class="office-viewer-cover office-viewer-failed"><UIcon name="i-lucide-circle-alert" /><p>无法预览这个文件：{{ error }}。可能是加密、损坏，或旧版 .doc / .ppt 格式；请下载后用本机软件打开。</p><UButton label="重试" icon="i-lucide-refresh-cw" color="neutral" variant="soft" @click="render" /></div>
  </div>
</template>

<style scoped>
/* The preview body lays its child out in a row: without flex and width the frames fall back to 300 pixels. */
.office-viewer { position: relative; display: flex; flex: 1; flex-direction: column; width: 100%; min-width: 0; height: 100%; min-height: 0; }
.office-viewer-frame { flex: 1; width: 100%; min-height: 0; border: 0; background: #fff; }
.office-viewer-slides { flex: 1; width: 100%; min-height: 0; }
.office-viewer-pages { display: flex; flex: 1; flex-direction: column; align-items: center; gap: 12px; width: 100%; min-height: 0; padding: 12px; overflow: auto; background: #e9ebef; }
.office-viewer-pages :deep(canvas) { flex-shrink: 0; background: #fff; box-shadow: 0 2px 10px rgb(0 0 0 / .15); }
.office-viewer-cover { position: absolute; inset: 0; z-index: 1; background: var(--ui-bg); }
.office-viewer-failed { display: flex; gap: 8px; align-items: center; justify-content: center; padding: 24px; color: var(--ui-text-muted); font-size: 13px; }
.office-viewer-failed p { margin: 0; max-width: 520px; }
.office-viewer-sheets { display: flex; gap: 4px; padding: 6px 8px; overflow-x: auto; border-bottom: 1px solid var(--ui-border); }
.office-viewer-sheets button { flex-shrink: 0; padding: 2px 10px; border-radius: 4px; color: var(--ui-text-muted); font-size: 12px; }
.office-viewer-sheets button[aria-pressed="true"] { color: var(--ui-text-highlighted); background: var(--ui-bg-accented); }
.office-viewer-note { margin: 0; padding: 4px 10px; color: var(--ui-text-muted); font-size: 12px; }
.office-viewer-fade-leave-active { transition: opacity .25s ease; }
.office-viewer-fade-leave-to { opacity: 0; }
</style>

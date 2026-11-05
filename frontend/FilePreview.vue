<script setup>
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { use_read_aloud } from "./read-aloud.js";
import { crumbs_of, excerpt_lines, file_preview, file_size, file_type, modified_time } from "./file-preview.js";

// The room's file preview window: several files open as tabs; it folds into a floating button that keeps every tab,
// its mode and scroll position, so the user can go to the messages and come back. Mounted for the whole room, keyed by it.
const props = defineProps({ directory: { type: String, required: true } });
const { view, bridge, act } = inject("discussion");
const room_id = view.value.room.id;
// Each tab: { path, data (the room-files answer), loading, error, source, scroll, request }.
const tabs = ref([]);
const active_path = ref("");
const open = ref(false);
// Like VS Code's word wrap toggle; narrow screens start wrapped so code is readable without sideways scrolling.
const wrap = ref(window.matchMedia("(max-width: 640px)").matches);

const name_of = (path) => path.split("/").pop() || "文件预览";
const tab = computed(() => tabs.value.find(item => item.path === active_path.value) || null);
const preview = computed(() => tab.value?.data || null);
const source = computed({ get: () => Boolean(tab.value?.source), set: (value) => { if (tab.value) tab.value.source = value; } });
const preview_crumbs = computed(() => crumbs_of(props.directory, active_path.value));
const preview_name = computed(() => name_of(active_path.value));
const preview_type = computed(() => file_type(preview_name.value));
const format = computed(() => /\.(md|markdown)$/i.test(active_path.value) ? "markdown" : /\.html?$/i.test(active_path.value) ? "html" : "text");
const rendered = computed(() => format.value === "markdown" && preview.value?.text ? window.discuss_markdown.render_markdown(preview.value.text, [], { source_lines: true }) : "");
// The iframe has an opaque origin, no scripts or forms, and loads only inline styles and embedded images/fonts.
const html_preview = computed(() => `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'"><meta charset="utf-8">${preview.value?.text || ""}`);
const can_render = computed(() => preview.value?.text != null && format.value !== "text" && !(format.value === "html" && preview.value.truncated));
const showing_source = computed(() => preview.value?.text != null && (!can_render.value || source.value));
// One gutter string keeps line numbers to a single DOM node even for the largest previews.
const lines = computed(() => preview.value?.text == null ? [] : preview.value.text.split("\n"));
const line_count = computed(() => lines.value.length);
const gutter = computed(() => Array.from({ length: line_count.value }, (_, index) => index + 1).join("\n"));
const encoding_label = computed(() => (preview.value?.encoding || "utf-8").toUpperCase());

// Read-aloud of a Markdown preview, as for a message card, in the file voice (the default voice when unset).
// Front matter (a leading `---` block) is shown but not read.
const FRONT_MATTER = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;
// The selection offer waits until a selection has settled; most selections are for copying.
const OFFER_SETTLE_MS = 350;
const OFFER_WIDTH = 190;
const COMMENT_WIDTH = 340;
const FOLLOW_KEYS = ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "];
const editor_body = ref(null), markdown_scroll = ref(null), markdown_body = ref(null), code_scroll = ref(null), comment_input = ref(null);
const speech_ready = ref(false);
// `offer`: a settled selection in the Markdown preview, with what quoting it would add; `commenting`: the offer being
// added to the chat, waiting for an optional comment.
const offer = ref(null);
const commenting = ref(null);
const comment = ref("");
let offer_timer = 0, pointer_down = false, excerpt_serial = 0;
const speech_settings = () => bridge.local_request("tts-settings", {});
const reader = use_read_aloud({ bridge, container: () => markdown_scroll.value, hosts: ".project-markdown-preview",
  voice_for: async () => { try { return (await speech_settings()).file_voice || ""; } catch { return ""; } },
  title: () => view.value.room?.title || "" });
const can_read = computed(() => speech_ready.value && format.value === "markdown" && !source.value && Boolean(preview.value?.text));

/** Check whether this computer has a speech key, so the read-aloud entries show only when they can work. */
function check_speech() {
  speech_settings().then((settings) => { speech_ready.value = Boolean(settings.api_key_ref); }, () => { speech_ready.value = false; });
}

/** Read one tab's file, discarding answers to its earlier requests; a tab already shown keeps its text meanwhile. */
async function load(item) {
  const request = (item.request || 0) + 1;
  Object.assign(item, { request, loading: true, error: "" });
  try {
    const result = await bridge.read_room_files(room_id, item.path);
    if (item.request === request) item.data = result;
  } catch (error) {
    if (item.request === request) item.error = error.message;
  } finally { if (item.request === request) item.loading = false; }
}

/** Open a file in its own tab (or re-read the tab it already has) and show the window. */
function open_file(path) {
  remember_scroll();
  let item = tabs.value.find(entry => entry.path === path);
  if (!item) {
    tabs.value.push({ path, data: null, loading: false, error: "", source: false, scroll: 0, request: 0 });
    item = tabs.value[tabs.value.length - 1];
  }
  active_path.value = path;
  open.value = true;
  check_speech();
  load(item);
}

/** The element that scrolls the active tab's content. */
const scroller = () => markdown_scroll.value || code_scroll.value;
function remember_scroll() { if (tab.value && open.value && scroller()) tab.value.scroll = scroller().scrollTop; }

function activate(path) {
  if (path === active_path.value) return;
  remember_scroll();
  active_path.value = path;
}

function close_tab(path) {
  const index = tabs.value.findIndex(item => item.path === path);
  if (index < 0) return;
  tabs.value.splice(index, 1);
  if (path !== active_path.value) return;
  active_path.value = tabs.value[Math.min(index, tabs.value.length - 1)]?.path || "";
  if (!tabs.value.length) open.value = false;
}

/** Fold the window into the floating button; every tab stays as it is. */
function minimize() {
  remember_scroll();
  open.value = false;
}

// Folding and unfolding move the window between its place and the floating button, which sits at the top-left of the
// room's content column (below the room header, clear of the navigation). Phones also fold it by pulling it down.
const FOLD_MS = 240;
const FLOAT_GAP = 12;
const FLOAT_FALLBACK_TOP = 80;
// A pull folds once it passes this share of the window height, or moves down this fast (px/ms) past a short distance.
const PULL_FOLD_SHARE = 0.25;
const PULL_FOLD_SPEED = 0.6;
const PULL_FOLD_MIN = 40;
// While pulled, the window shrinks by up to this much.
const PULL_SHRINK = 0.15;
const frame = ref(null);
const float_place = ref({ left: 0, top: FLOAT_FALLBACK_TOP });
const reduced_motion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
let pull = null, folding = false;

/** Put the floating button at the top-left of the content column. */
function place_float() {
  const content = document.querySelector(".channel-content")?.getBoundingClientRect();
  float_place.value = content ? { left: content.left, top: content.top + FLOAT_GAP } : { left: 0, top: FLOAT_FALLBACK_TOP };
}

/** Style the window frame; `transition` false applies it at once (following a finger). */
function set_frame(transform, { opacity = "", radius = "", transition = true } = {}) {
  const element = frame.value;
  if (!element) return;
  Object.assign(element.style, { transformOrigin: "0 0", transition: transition ? `transform ${FOLD_MS}ms ease, opacity ${FOLD_MS}ms ease, border-radius ${FOLD_MS}ms ease` : "none",
    transform, opacity, borderRadius: radius });
}

/** The transform that lays the window over the floating button. */
function float_transform(rect) {
  const scale = Math.max(0.05, 44 / rect.width);
  return `translate(${float_place.value.left - rect.left}px, ${float_place.value.top - rect.top}px) scale(${scale})`;
}

/** Shrink the window into the floating button, then fold it and run `after` (e.g. focusing the composer). */
function fold(after) {
  if (folding) return;
  remember_scroll();
  place_float();
  const element = frame.value;
  const finish = () => { folding = false; minimize(); if (typeof after === "function") after(); };
  if (!element || reduced_motion()) { finish(); return; }
  folding = true;
  set_frame("none", { transition: false });
  const rect = element.getBoundingClientRect();
  set_frame(element.dataset.pull || "none", { transition: false });
  element.getBoundingClientRect();
  set_frame(float_transform(rect), { opacity: "0", radius: "14px" });
  window.setTimeout(finish, FOLD_MS);
}

/** Open the window again, growing it out of the floating button. */
async function unfold() {
  place_float();
  open.value = true;
  if (reduced_motion()) return;
  await nextTick();
  requestAnimationFrame(() => {
    const element = frame.value;
    if (!element) return;
    set_frame(float_transform(element.getBoundingClientRect()), { opacity: "0", radius: "14px", transition: false });
    element.getBoundingClientRect();
    set_frame("", {});
  });
}

/**
 * A downward pull on a touch screen: from the tab strip or breadcrumbs, or from the text once it is scrolled to the top.
 * Not while text is selected, so moving selection handles never folds the window.
 */
function pull_start(event) {
  pull = null;
  if (folding || event.touches.length !== 1 || !window.matchMedia("(pointer: coarse)").matches || commenting.value) return;
  if (event.target.closest?.("input, textarea, .file-selection-offer, .file-listen-dock")) return;
  const selection = document.getSelection();
  if (selection && !selection.isCollapsed) return;
  const content = scroller();
  const from_bar = Boolean(event.target.closest?.(".project-editor-tabs, .project-editor-breadcrumbs"));
  if (!from_bar && !(content?.contains(event.target) && content.scrollTop <= 0)) return;
  const touch = event.touches[0];
  pull = { x: touch.clientX, y: touch.clientY, time: event.timeStamp, distance: 0, speed: 0, active: false, height: frame.value?.offsetHeight || window.innerHeight };
}

function pull_move(event) {
  if (!pull) return;
  const touch = event.touches[0], dx = touch.clientX - pull.x, dy = touch.clientY - pull.y;
  if (!pull.active) {
    // Upward or sideways first: scrolling or tab strip swiping, not a pull.
    if (dy <= 0 || Math.abs(dx) > dy) { if (Math.abs(dx) + Math.abs(dy) > 4) pull = null; return; }
    pull.active = true;
  }
  if (event.cancelable) event.preventDefault();
  const elapsed = Math.max(1, event.timeStamp - pull.time);
  pull.speed = (dy - pull.distance) / elapsed;
  pull.time = event.timeStamp;
  pull.distance = Math.max(0, dy);
  const scale = 1 - Math.min(1, pull.distance / pull.height) * PULL_SHRINK;
  const transform = `translate(${(frame.value?.offsetWidth || 0) * (1 - scale) / 2}px, ${pull.distance}px) scale(${scale})`;
  if (frame.value) frame.value.dataset.pull = transform;
  set_frame(transform, { radius: "14px", transition: false });
}

/** Fold when pulled far or fast enough; otherwise spring back. */
function pull_end() {
  const done = pull;
  pull = null;
  if (!done?.active) return;
  const element = frame.value;
  if (done.distance > done.height * PULL_FOLD_SHARE || (done.speed > PULL_FOLD_SPEED && done.distance > PULL_FOLD_MIN)) fold();
  else set_frame("", {});
  if (element) delete element.dataset.pull;
}

function close_all() {
  tabs.value = [];
  active_path.value = "";
  open.value = false;
}

/** Jump the file list to a folder named in the breadcrumb, folding the window away. */
function reveal_folder(path) {
  fold();
  file_preview.reveal_path = path;
  act("tab", "files");
}

// Back on a tab (or in the window again), it is where it was left; a new tab starts at the top.
watch([open, active_path, () => Boolean(preview.value)], async () => {
  if (!open.value || !tab.value) return;
  await nextTick();
  if (scroller()) scroller().scrollTop = tab.value.scroll;
});

/** Read the whole file from its first line after the front matter. */
function read_file() {
  const front = FRONT_MATTER.exec(preview.value?.text || "")?.[0] || "";
  reader.read_document(markdown_body.value, { skip: (front.match(/[\p{L}\p{N}]/gu) || []).length, heading: preview_name.value });
}

/** Hide the offer while a selection is changing and check again once it settles. */
function schedule_offer() {
  offer.value = null;
  window.clearTimeout(offer_timer);
  if (!pointer_down) offer_timer = window.setTimeout(track_selection, OFFER_SETTLE_MS);
}
// Pressing the offer or the comment box must not hide it before its click lands.
const on_offer = (event) => Boolean(event.target.closest?.(".file-selection-offer"));
const press = (event) => { if (!on_offer(event)) pointer_down = true; };
const release = (event) => { if (on_offer(event)) return; pointer_down = false; schedule_offer(); };

/** The source lines a selection covers, from the first and last text it really includes; zero when unknown. */
function selected_lines(range) {
  const root = range.commonAncestorContainer;
  const nodes = [];
  if (root.nodeType === Node.TEXT_NODE) nodes.push(root);
  else for (const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); walker.nextNode();) nodes.push(walker.currentNode);
  const chosen = nodes.filter((node) => {
    if (!range.intersectsNode(node)) return false;
    const from = node === range.startContainer ? range.startOffset : 0, to = node === range.endContainer ? range.endOffset : node.length;
    return Boolean(node.data.slice(from, to).trim());
  });
  const block = (node) => node?.parentElement?.closest("[data-source-lines]")?.dataset.sourceLines.split("-").map(Number);
  const first = block(chosen[0]), last = block(chosen[chosen.length - 1]);
  return first && last ? { start: first[0], end: Math.max(first[0], last[1]) } : { start: 0, end: 0 };
}

/** Offer quoting (and reading from) a selection made in the Markdown preview: under its end, or in the bottom dock on touch screens. */
function track_selection() {
  if (commenting.value) return;
  const selection = document.getSelection();
  const range = selection?.rangeCount && !selection.isCollapsed ? selection.getRangeAt(0) : null;
  const box = editor_body.value?.getBoundingClientRect();
  if (!range || !box || source.value || !markdown_body.value?.contains(range.startContainer)) return;
  const text = range.toString().replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
  if (!text) return;
  const rects = range.getClientRects(), end = rects[rects.length - 1] || range.getBoundingClientRect();
  offer.value = { range: range.cloneRange(), text, ...selected_lines(range), touch: window.matchMedia("(pointer: coarse)").matches,
    left: Math.max(8, Math.min(end.right - box.left - 8, box.width - OFFER_WIDTH)), top: end.bottom - box.top + 6, width: box.width };
}

/** Start reading where the selection begins and go on to the end of the file. */
function listen_from_selection() {
  const { range } = offer.value;
  offer.value = null;
  document.getSelection()?.removeAllRanges();
  reader.read_document(markdown_body.value, { selection: range, heading: preview_name.value });
}

/** Ask for an optional comment on the selection before it goes to the chat. */
async function start_comment() {
  commenting.value = { ...offer.value, left: Math.max(8, Math.min(offer.value.left, offer.value.width - COMMENT_WIDTH - 8)) };
  offer.value = null;
  comment.value = "";
  await nextTick();
  comment_input.value?.focus();
}

function cancel_comment() { commenting.value = null; }

/** Put the selection (and comment) in the composer as an excerpt, fold the window and go to the messages. */
function add_excerpt() {
  const { text, start, end } = commenting.value;
  file_preview.excerpts.push({ id: ++excerpt_serial, path: active_path.value, name: preview_name.value, start, end, text, comment: comment.value.trim() });
  commenting.value = null;
  document.getSelection()?.removeAllRanges();
  act("tab", "discussion");
  fold(() => { file_preview.focus_composer++; });
}

function comment_keydown(event) {
  if (event.isComposing) return;
  if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancel_comment(); }
  else if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); add_excerpt(); }
}

/** Any manual scroll (wheel, touch drag, scroll keys, scrollbar) turns following off; only its button turns it back on. */
function stop_following(event) {
  if (!reader.state.following) return;
  if (event.type === "keydown" && !FOLLOW_KEYS.includes(event.key)) return;
  if (event.type === "pointerdown" && event.target !== event.currentTarget) return;
  reader.state.following = false;
}

// Folding or closing the window, switching tabs or to source, or the text changing ends the reading and any quoting.
watch([open, active_path, source, rendered], () => { offer.value = null; commenting.value = null; if (reader.state.message_id) reader.stop(); });
onMounted(() => {
  file_preview.open = open_file;
  place_float();
  window.addEventListener("resize", place_float);
  document.addEventListener("selectionchange", schedule_offer);
  document.addEventListener("pointerdown", press);
  document.addEventListener("pointerup", release);
});
onBeforeUnmount(() => {
  if (file_preview.open === open_file) file_preview.open = null;
  window.removeEventListener("resize", place_float);
  for (const item of tabs.value) item.request++;
  document.removeEventListener("selectionchange", schedule_offer);
  document.removeEventListener("pointerdown", press);
  document.removeEventListener("pointerup", release);
  window.clearTimeout(offer_timer);
  reader.dispose();
});
</script>

<template>
  <UModal :open="open" :title="preview_name" :description="active_path" :content="{ onInteractOutside: event => event.preventDefault() }"
    :ui="{ content: 'project-editor' }" @update:open="value => value ? (open = true) : fold()">
    <template #content>
     <div ref="frame" class="project-editor-frame" @touchstart.passive="pull_start" @touchmove="pull_move" @touchend="pull_end" @touchcancel="pull_end">
      <div class="project-editor-tabs">
        <div class="project-editor-tablist" role="tablist" aria-label="已打开的文件">
          <div v-for="item in tabs" :key="item.path" class="project-editor-tab" :class="{ 'is-active': item.path === active_path }" :title="item.path">
            <button type="button" role="tab" class="project-editor-tab-name" :aria-selected="item.path === active_path" @click="activate(item.path)">
              <UIcon :name="file_type(name_of(item.path))[1]" class="project-file-icon" :class="file_type(name_of(item.path))[2]" /><span>{{ name_of(item.path) }}</span>
            </button>
            <button type="button" class="project-editor-tab-close" :aria-label="`关闭 ${name_of(item.path)}`" title="关闭" @click="close_tab(item.path)"><UIcon name="i-lucide-x" /></button>
          </div>
        </div>
        <div class="project-editor-actions">
          <UButton v-if="showing_source" icon="i-lucide-wrap-text" color="neutral" :variant="wrap ? 'soft' : 'ghost'" size="sm" :aria-pressed="wrap"
            :title="wrap ? '关闭自动换行' : '自动换行'" aria-label="自动换行" @click="wrap = !wrap" />
          <UButton v-if="can_read" :icon="reader.state.reading ? 'i-lucide-square' : 'i-lucide-volume-2'" color="neutral" variant="ghost" size="sm"
            :title="reader.state.reading ? '停止朗读' : '朗读'" :aria-label="reader.state.reading ? '停止朗读' : '从头朗读此文件'" @click="reader.state.reading ? reader.stop() : read_file()" />
          <div v-if="can_render" class="project-editor-modes" role="group" aria-label="显示方式">
            <button type="button" :aria-pressed="!source" title="预览" @click="source = false"><UIcon name="i-lucide-eye" class="project-mode-icon" /><span>预览</span></button>
            <button type="button" :aria-pressed="source" title="源码" @click="source = true"><UIcon name="i-lucide-code-xml" class="project-mode-icon" /><span>源码</span></button>
          </div>
          <UButton icon="i-lucide-minus" color="neutral" variant="ghost" size="sm" title="收起为悬浮窗（手机上也可下拉收起）" aria-label="收起预览" @click="fold" />
          <UButton icon="i-lucide-x" color="neutral" variant="ghost" size="sm" :title="tabs.length > 1 ? '关闭全部文件' : '关闭预览'" :aria-label="tabs.length > 1 ? '关闭全部文件' : '关闭预览'" @click="close_all" />
        </div>
      </div>
      <nav class="project-editor-breadcrumbs" aria-label="文件位置">
        <template v-for="(part, index) in preview_crumbs" :key="part.path">
          <UIcon v-if="index" name="i-lucide-chevron-right" class="project-crumb-separator" />
          <button v-if="index < preview_crumbs.length - 1" type="button" title="在列表中打开此文件夹" @click="reveal_folder(part.path)">{{ part.name }}</button>
          <span v-else><UIcon :name="preview_type[1]" class="project-file-icon" :class="preview_type[2]" />{{ part.name }}</span>
        </template>
      </nav>
      <p v-if="preview?.truncated" class="project-editor-banner"><UIcon name="i-lucide-info" />文件较大，仅显示前 {{ file_size(preview.limit) }}（共 {{ file_size(preview.size) }}）<template v-if="format === 'html'">，HTML 不渲染不完整的内容</template></p>
      <p v-else-if="can_render && !source && format === 'html'" class="project-editor-banner"><UIcon name="i-lucide-shield" />静态预览：脚本、外部样式与外部图片不加载</p>

      <div ref="editor_body" class="project-editor-body">
        <div v-if="tab?.loading && !preview" class="project-editor-state" role="status"><UIcon name="i-lucide-loader-circle" class="animate-spin" />正在读取文件…</div>
        <div v-else-if="tab?.error && !preview" class="project-editor-state"><UIcon name="i-lucide-circle-alert" /><p>{{ tab.error }}</p><UButton label="重试" color="neutral" variant="outline" size="sm" @click="load(tab)" /></div>
        <div v-else-if="preview?.text === null" class="project-editor-state"><UIcon :name="preview_type[1]" /><p>{{ preview.reason }}</p></div>
        <div v-else-if="showing_source && wrap" ref="code_scroll" class="project-code is-wrapped" tabindex="0" aria-label="文件内容" :style="{ '--digits': String(line_count).length }">
          <div v-for="(line, index) in lines" :key="index" class="project-code-row"><span class="project-code-number" aria-hidden="true">{{ index + 1 }}</span><span class="project-code-line">{{ line }}</span></div>
        </div>
        <div v-else-if="showing_source" ref="code_scroll" class="project-code" tabindex="0" aria-label="文件内容">
          <pre class="project-code-gutter" aria-hidden="true">{{ gutter }}</pre>
          <pre class="project-code-text"><code>{{ preview.text }}</code></pre>
        </div>
        <iframe v-else-if="preview && format === 'html'" class="project-html-preview" sandbox="" referrerpolicy="no-referrer" :srcdoc="html_preview" title="HTML 文件预览"></iframe>
        <div v-else-if="preview" ref="markdown_scroll" class="project-markdown-scroll" tabindex="0" @scroll.passive="schedule_offer"
          @wheel.passive="stop_following" @touchmove.passive="stop_following" @keydown="stop_following" @pointerdown="stop_following"><div ref="markdown_body" class="markdown-body project-markdown-preview" v-html="rendered"></div></div>

        <div v-if="offer && !offer.touch" class="file-selection-offer file-offer-marks" :style="{ left: `${offer.left}px`, top: `${offer.top}px` }">
          <button type="button" class="channel-listen-mark" title="把选中的文字作为摘录添加到对话" @mousedown.prevent @click="start_comment"><UIcon name="i-lucide-message-square-quote" />添加到对话</button>
          <button v-if="can_read" type="button" class="channel-listen-mark" title="从选中处开始朗读" aria-label="从选中处开始朗读" @mousedown.prevent @click="listen_from_selection"><UIcon name="i-lucide-headphones" />朗读</button>
        </div>
        <form v-if="commenting" class="file-selection-offer file-comment" :class="{ 'is-docked': commenting.touch }"
          :style="commenting.touch ? {} : { left: `${commenting.left}px`, top: `${commenting.top}px` }" @submit.prevent="add_excerpt">
          <input ref="comment_input" v-model="comment" type="text" placeholder="添加批注（可选）" aria-label="摘录的批注（可选）" enterkeyhint="send" @keydown="comment_keydown">
          <button type="button" class="file-comment-cancel" aria-label="取消添加" title="取消" @click="cancel_comment"><UIcon name="i-lucide-x" /></button>
          <button type="submit" class="file-comment-send" aria-label="添加到对话" title="添加到对话（Enter）"><UIcon name="i-lucide-arrow-up" /></button>
        </form>
        <div v-if="(offer?.touch && !commenting) || reader.state.message_id" class="file-listen-dock">
          <button v-if="offer?.touch" type="button" class="channel-listen-pill file-selection-offer" @mousedown.prevent @click="start_comment"><UIcon name="i-lucide-message-square-quote" />添加到对话</button>
          <button v-if="offer?.touch && can_read" type="button" class="channel-listen-pill file-selection-offer" aria-label="从选中处开始朗读" @mousedown.prevent @click="listen_from_selection"><UIcon name="i-lucide-headphones" />听当前</button>
          <button v-if="reader.state.message_id" type="button" class="channel-listen-pill" :class="{ 'is-on': reader.state.following }" :aria-pressed="reader.state.following"
            :title="reader.state.following ? '手动滚动即取消跟随' : '页面跟随朗读位置滚动'" @click="reader.state.following ? (reader.state.following = false) : reader.follow()"><UIcon name="i-lucide-locate-fixed" />{{ reader.state.following ? '跟随中' : '跟随' }}</button>
          <button v-if="reader.state.reading" type="button" class="channel-listen-pill" aria-label="退出朗读" @click="reader.stop()"><UIcon name="i-lucide-square" />退出</button>
        </div>
      </div>

      <footer class="project-editor-status">
        <span v-if="preview" class="project-editor-modified" :title="preview.modified_at">修改于 {{ modified_time(preview.modified_at) }}</span>
        <span class="project-editor-status-spacer"></span>
        <template v-if="preview?.text != null">
          <span>{{ line_count }} 行</span><span class="project-editor-encoding">{{ encoding_label }}</span>
        </template>
        <span v-if="preview">{{ file_size(preview.size) }}</span>
        <span>{{ preview_type[0] }}</span>
      </footer>
     </div>
    </template>
  </UModal>

  <!-- Folded: a floating button on the screen edge, over every channel of the room, until the files are closed. -->
  <Teleport to="body">
    <div v-if="tabs.length && !open" class="file-float" :style="{ left: `${float_place.left}px`, top: `${float_place.top}px` }">
      <button type="button" class="file-float-open" :title="tabs.length > 1 ? `回到文件预览（${tabs.length} 个文件）` : `回到文件预览：${preview_name}`" @click="unfold">
        <UIcon :name="preview_type[1]" class="project-file-icon" :class="preview_type[2]" /><span class="file-float-name">{{ preview_name }}</span>
        <span v-if="tabs.length > 1" class="file-float-count">{{ tabs.length }}</span>
      </button>
      <button type="button" class="file-float-close" aria-label="关闭全部文件预览" title="关闭" @click="close_all"><UIcon name="i-lucide-x" /></button>
    </div>
  </Teleport>
</template>

<style scoped>
/* Preview: a VS Code editor group — tab strip, breadcrumbs, gutter + text, status bar. */
:global(.project-editor) { display: flex; flex-direction: column; width: min(1120px, calc(100vw - 48px)); max-width: none; height: calc(100dvh - 64px); max-height: none; overflow: visible;
  padding: 0; border: 0; border-radius: 0; background: transparent; box-shadow: none; }
/* The window itself, moved and scaled as a whole when it folds into the floating button or is pulled down. */
.project-editor-frame { display: flex; flex: 1; flex-direction: column; min-height: 0; overflow: hidden; border: 1px solid var(--ui-border-accented); border-radius: 10px;
  background: var(--ui-bg); box-shadow: 0 24px 80px #0000008c; will-change: transform; }
.project-editor-tabs { display: flex; align-items: stretch; justify-content: space-between; flex-shrink: 0; height: 38px; background: var(--ui-bg-elevated); border-bottom: 1px solid var(--ui-border); }
.project-editor-tablist { display: flex; flex: 1; min-width: 0; overflow-x: auto; scrollbar-width: none; }
.project-editor-tab { position: relative; display: flex; align-items: center; flex-shrink: 0; max-width: 240px; font-size: 13px; color: var(--ui-text-muted); border-right: 1px solid var(--ui-border); }
.project-editor-tab.is-active { background: var(--ui-bg); color: var(--ui-text-highlighted); }
.project-editor-tab.is-active::before { content: ""; position: absolute; inset: 0 0 auto; height: 2px; background: var(--ui-primary); }
.project-editor-tab.is-active::after { content: ""; position: absolute; inset: auto 0 -1px; height: 1px; background: var(--ui-bg); }
.project-editor-tab-name { display: flex; align-items: center; gap: 8px; min-width: 0; height: 100%; padding: 0 4px 0 14px; cursor: pointer; }
.project-editor-tab-name > span:last-child { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.project-editor-tab-close { display: grid; place-items: center; width: 20px; height: 20px; margin-right: 8px; border-radius: 4px; color: var(--ui-text-dimmed); cursor: pointer; opacity: 0; }
.project-editor-tab-close > span { width: 14px; height: 14px; }
.project-editor-tab:is(.is-active, :hover, :focus-within) .project-editor-tab-close { opacity: 1; }
.project-editor-tab-close:hover { background: var(--ui-bg-accented); color: var(--ui-text); }
.project-editor-actions { display: flex; align-items: center; flex-shrink: 0; gap: 6px; padding: 0 6px; border-left: 1px solid var(--ui-border); }
.project-editor-modes { display: flex; padding: 2px; border-radius: 6px; background: var(--ui-bg-accented); }
.project-editor-modes button { display: inline-flex; align-items: center; gap: 5px; height: 24px; padding: 0 9px; border-radius: 4px; font-size: 12px; color: var(--ui-text-muted); cursor: pointer; }
.project-mode-icon { flex-shrink: 0; width: 14px; height: 14px; }
.project-editor-modes button:hover { color: var(--ui-text); }
.project-editor-modes button[aria-pressed="true"] { background: var(--ui-bg); color: var(--ui-text-highlighted); box-shadow: 0 1px 2px #0000003d; }
.project-editor-breadcrumbs { display: flex; flex-wrap: nowrap; align-items: center; gap: 2px; flex-shrink: 0; height: 26px; padding: 0 14px; overflow-x: auto; scrollbar-width: none; font-size: 12px; color: var(--ui-text-muted); }
.project-editor-breadcrumbs > * { flex-shrink: 0; }
.project-editor-breadcrumbs button { padding: 1px 4px; border-radius: 4px; white-space: nowrap; cursor: pointer; }
.project-editor-breadcrumbs button:hover { background: var(--ui-bg-accented); color: var(--ui-text); }
.project-editor-breadcrumbs > span:not(.project-crumb-separator) { display: inline-flex; align-items: center; gap: 5px; padding: 1px 4px; white-space: nowrap; color: var(--ui-text); }
.project-editor-breadcrumbs .project-file-icon { width: 14px; height: 14px; }
.project-editor-banner { display: flex; align-items: center; gap: 8px; flex-shrink: 0; margin: 0; padding: 6px 14px; font-size: 12px; color: var(--ui-text-muted);
  background: color-mix(in srgb, var(--ui-primary) 9%, transparent); border-block: 1px solid color-mix(in srgb, var(--ui-primary) 22%, transparent); }
.project-editor-banner > span { flex-shrink: 0; width: 14px; height: 14px; color: var(--ui-primary); }
.project-editor-body { position: relative; flex: 1; min-height: 0; display: flex; border-top: 1px solid var(--ui-border); }
.project-editor-state { display: flex; flex: 1; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 24px; text-align: center; font-size: 13px; color: var(--ui-text-muted); }
.project-editor-state > span:first-child { width: 28px; height: 28px; color: var(--ui-text-dimmed); }
.project-editor-state p { margin: 0; max-width: 480px; }
.project-code { display: flex; flex: 1; align-items: flex-start; min-width: 0; overflow: auto; font: 13px/20px ui-monospace, "Cascadia Code", Consolas, monospace; tab-size: 4; }
.project-code:focus-visible, .project-markdown-scroll:focus-visible { outline: none; }
.project-code pre { margin: 0; padding: 10px 0 24px; white-space: pre; font: inherit; }
.project-code-gutter { position: sticky; left: 0; z-index: 1; flex-shrink: 0; min-width: 52px; padding-inline: 16px 14px !important; text-align: right; color: var(--ui-text-dimmed); background: var(--ui-bg); user-select: none; }
.project-code-text { flex: 1; padding-right: 32px !important; color: var(--ui-text); }
/* Wrapped: one row per source line keeps each number level with the first visual row of its line. */
.project-code.is-wrapped { display: block; padding: 10px 0 24px; }
.project-code-row { display: flex; }
.project-code-number { flex-shrink: 0; box-sizing: content-box; width: calc(var(--digits) * 1ch); min-width: 2ch; padding: 0 14px 0 16px; text-align: right; color: var(--ui-text-dimmed); user-select: none; }
.project-code-line { flex: 1; min-width: 0; padding-right: 20px; color: var(--ui-text); white-space: pre-wrap; overflow-wrap: anywhere; }
.project-markdown-scroll { flex: 1; min-width: 0; overflow: auto; }
/* Positioned and isolated so the read-aloud highlight layer sits under the text, as in a message card. */
.project-markdown-preview { position: relative; isolation: isolate; max-width: 860px; margin: 0 auto; padding: 28px 40px 48px; overflow-wrap: anywhere; }
/* Selection offers and read-aloud controls stay inside the dialog: under the selection with a pointer, in a bottom dock otherwise. */
.file-offer-marks { position: absolute; z-index: 4; display: flex; gap: 6px; }
.file-offer-marks .channel-listen-mark { position: static; }
.file-comment { position: absolute; z-index: 4; display: flex; align-items: center; gap: 4px; width: 340px; height: 40px; padding: 0 5px 0 14px; border: 1px solid var(--ui-border-accented);
  border-radius: 999px; background: var(--ui-bg-elevated); box-shadow: 0 8px 24px #0006; }
.file-comment.is-docked { inset: auto 12px 12px; width: auto; }
.file-comment input { flex: 1; min-width: 0; border: 0; outline: none; background: transparent; color: var(--ui-text); font-size: 13px; }
.file-comment input::placeholder { color: var(--ui-text-dimmed); }
.file-comment button { display: grid; place-items: center; flex-shrink: 0; width: 28px; height: 28px; border-radius: 50%; cursor: pointer; }
.file-comment button > span { width: 16px; height: 16px; }
.file-comment-cancel { color: var(--ui-text-muted); }
.file-comment-cancel:hover { background: var(--ui-bg-accented); color: var(--ui-text); }
.file-comment-send { background: var(--ui-text-highlighted); color: var(--ui-bg); }
.file-listen-dock { position: absolute; inset: auto 0 12px; z-index: 3; display: flex; justify-content: center; gap: 8px; pointer-events: none; }
.project-html-preview { display: block; flex: 1; width: 100%; border: 0; background: white; }
.project-editor-status { display: flex; align-items: center; gap: 16px; flex-shrink: 0; height: 26px; padding: 0 14px; font-size: 11.5px; color: var(--ui-text-muted);
  background: var(--ui-bg-elevated); border-top: 1px solid var(--ui-border); font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; }
.project-editor-status-spacer { flex: 1; }

/* Folded window: stuck to the content column's left edge, below the room header, like a mini-program's floating window. */
.file-float { position: fixed; z-index: 45; display: flex; align-items: center; height: 40px; padding: 0 4px 0 12px; border: 1px solid var(--ui-border-accented);
  border-left: 0; border-radius: 0 999px 999px 0; background: var(--ui-bg-elevated); box-shadow: 0 6px 20px #0006; animation: file-float-in .2s ease-out; }
@keyframes file-float-in { from { opacity: 0; transform: translateX(-12px); } }
.file-float-open { display: flex; align-items: center; gap: 7px; height: 100%; max-width: 200px; font-size: 13px; color: var(--ui-text-highlighted); cursor: pointer; }
.file-float-name { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.file-float-count { flex-shrink: 0; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px; background: var(--ui-primary); color: var(--ui-bg); font-size: 11px; line-height: 18px; text-align: center; }
.file-float-close { display: grid; place-items: center; width: 26px; height: 26px; margin-left: 2px; border-radius: 50%; color: var(--ui-text-dimmed); cursor: pointer; }
.file-float-close > span { width: 14px; height: 14px; }
.file-float-close:hover { background: var(--ui-bg-accented); color: var(--ui-text); }

@media (max-width: 640px) {
  :global(.project-editor) { width: 100vw; height: 100dvh; }
  .project-editor-frame { border: 0; border-radius: 0; }
  .project-editor-tab { max-width: 160px; }
  .project-editor-tab-name { padding-left: 10px; }
  .project-editor-tab-close { opacity: 1; }
  .project-editor-actions { gap: 2px; padding: 0 4px; }
  .project-editor-modes button { padding: 0 8px; }
  .project-editor-modes button > span:not(.project-mode-icon) { display: none; }
  .project-markdown-preview { padding: 18px 16px 32px; }
  .project-code { font-size: 12px; line-height: 18px; }
  .project-code-gutter { min-width: 40px; padding-inline: 10px !important; }
  .project-code-number { padding: 0 10px; }
  .project-editor-modified, .project-editor-encoding { display: none; }
  .file-float-name { display: none; }
  .file-float-close { display: none; }
  .file-float { padding-right: 10px; }
}
</style>

<style>
/* Shared by the file list and the preview. */
.project-file-icon { flex-shrink: 0; width: 16px; height: 16px; }
.project-crumb-separator { flex-shrink: 0; width: 13px; height: 13px; color: var(--ui-text-dimmed); }
.project-file-icon.is-folder { color: #dcb67a; }
.project-file-icon.is-blue { color: #519aba; }
.project-file-icon.is-orange { color: #e37933; }
.project-file-icon.is-yellow { color: #cbcb41; }
.project-file-icon.is-green { color: #8dc149; }
.project-file-icon.is-purple { color: #a074c4; }
.project-file-icon.is-red { color: #cc3e44; }
.project-file-icon.is-muted { color: var(--ui-text-muted); }
</style>

<script setup>
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { use_read_aloud } from "./read-aloud.js";
import ExcerptEditCard from "./ExcerptEditCard.vue";
import MediaViewer from "./MediaViewer.vue";
import { open_image_viewer } from "./image-viewer.js";
import OfficeViewer from "./OfficeViewer.vue";
import PreviewLoading from "./PreviewLoading.vue";
import Papa from "papaparse";
import { gunzip } from "fflate";
import { ATTACHMENT_TEXT_LIMIT, HTML_SANDBOX, add_excerpt as put_excerpt, crumbs_of, document_kind_of, excerpt_range, file_preview, file_size, file_type, hold_selection, html_document, inline_markdown_images, inner_scroll_follower, media_of, modified_time, read_attachment, scrolled_out, subtitle_cues, text_kind_of, text_offset } from "./file-preview.js";
import { t } from './i18n.js';
import { inline_visual_document, inline_visual_theme, observe_visual_theme, send_visual_theme, visual_tab_document } from "./inline-visual.js";

// The file preview window: several files open as tabs; it folds into a floating button that keeps every tab, its mode
// and scroll position, so the user can go to the messages or another room and come back. Mounted once for the workspace,
// so only closing (or reloading the site) clears it; each tab reads from the room it was opened in.
const { view, bridge, act } = inject("discussion");
// Each tab: { id, room_id, directory, root (its index among the room's project directories), path, data (the room-files answer), loading, error, source, scroll, request }.
const tabs = ref([]);
const active_id = ref("");
const open = ref(false);
// Like VS Code's word wrap toggle; narrow screens start wrapped so code is readable without sideways scrolling.
const narrow_query = window.matchMedia("(max-width: 640px)");
const wrap = ref(narrow_query.matches);
// Narrow screens move the file's own actions down to the breadcrumb row, leaving the tab strip to the tabs.
// A touch screen with a shorter side than this is a phone (web/index.html tells tablets apart the same way).
const TABLET_MIN_SIDE = 600;
// A phone keeps the phone head on its side too: wider than 640px there, it took the tablet head, whose file actions left
// the tabs a third of the row (user 2026-11-20, #6128).
const IS_PHONE = matchMedia("(pointer: coarse)").matches && Math.min(screen.width, screen.height) < TABLET_MIN_SIDE;
const narrow = ref(IS_PHONE || narrow_query.matches);
const track_narrow = (event) => { narrow.value = IS_PHONE || event.matches; };
// Below this width the head's one row leaves the tabs no room (a tablet's split pane; user 2026-11-20, #6125): the file's
// actions move down beside the breadcrumbs, still in sight, and the tabs take the top row up to the window buttons.
const TIGHT_HEAD_PX = 760;
// Narrower still (a pane dragged to its narrowest), the second row has no room for them either: they fold into "...".
const FOLDED_HEAD_PX = 520;
const head_element = ref(null), head_width = ref(Infinity);
const head_watcher = new ResizeObserver(([entry]) => { head_width.value = entry.contentRect.width; });
const tight_head = computed(() => head_width.value < TIGHT_HEAD_PX);
const folded_actions = computed(() => narrow.value || head_width.value < FOLDED_HEAD_PX);
watch(head_element, (element, previous) => { if (previous) head_watcher.unobserve(previous); if (element) head_watcher.observe(element); });
// Text size of the preview and source, kept per device: phones and desktops want different sizes.
const FONT_SCALE_KEY = "ai-codiscuss-file-font-scale";
const FONT_SCALE_MIN = 0.5;
const FONT_SCALE_MAX = 2;
const FONT_SCALE_STEP = 0.1;
const font_scale = ref(read_font_scale());

function read_font_scale() {
  let saved = NaN;
  try { saved = Number(localStorage.getItem(FONT_SCALE_KEY)); } catch { /* Use the default size. */ }
  return saved >= FONT_SCALE_MIN && saved <= FONT_SCALE_MAX ? saved : 1;
}

/** Step the text size by `steps` (0 resets it) and remember it on this device. */
function change_font_scale(steps) {
  const next = steps ? Math.round((font_scale.value + steps * FONT_SCALE_STEP) * 10) / 10 : 1;
  font_scale.value = Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, next));
  try { localStorage.setItem(FONT_SCALE_KEY, String(font_scale.value)); } catch { /* Keep it for this visit only. */ }
}

const name_of = (path) => path.split("/").pop() || t('文件预览');
const tab = computed(() => tabs.value.find(item => item.id === active_id.value) || null);
const active_path = computed(() => tab.value?.path || "");
// How a message names the open file: relative in the main project directory, in full in another one.
const reference_path = computed(() => !tab.value?.root ? active_path.value
  : `${tab.value.directory.replace(/[\\/]+$/, "")}/${active_path.value}`);
const preview = computed(() => tab.value?.data || null);
const source = computed({ get: () => Boolean(tab.value?.source), set: (value) => { if (tab.value) tab.value.source = value; } });
const preview_crumbs = computed(() => tab.value?.attachment ? [{ name: t('消息附件'), path: "" }, { name: active_path.value, path: active_path.value }]
  : crumbs_of(tab.value?.directory || "", active_path.value));
const preview_name = computed(() => name_of(active_path.value));
const preview_type = computed(() => file_type(preview_name.value));
const format = computed(() => /\.(md|markdown)$/i.test(active_path.value) ? "markdown" : /\.html?$/i.test(active_path.value) ? "html"
  : text_kind_of(active_path.value) || "text");
// Word, Excel and PowerPoint files open in the Office previews (`office_kind`); a Premiere project is unpacked to its XML.
const document_kind = computed(() => document_kind_of(active_path.value));
const office_kind = computed(() => (document_kind.value === "prproj" ? "" : document_kind.value));
// Word and Excel previews follow the same size steps as text; slides and PDF fit the window themselves.
const can_scale = computed(() => office_kind.value ? ["docx", "sheet"].includes(office_kind.value)
  : preview.value?.text != null && !(format.value === "html" && !showing_source.value));
// Rows of a CSV / TSV preview and cues of a subtitle preview; the source view keeps the whole text.
const MAX_TABLE_ROWS = 5000;
const table = computed(() => {
  if (format.value !== "table" || preview.value?.text == null) return { rows: [], cut: false };
  const parsed = Papa.parse(preview.value.text, { delimiter: /\.tsv$/i.test(active_path.value) ? "\t" : "", skipEmptyLines: true, preview: MAX_TABLE_ROWS + 1 });
  return { rows: parsed.data.slice(0, MAX_TABLE_ROWS), cut: parsed.data.length > MAX_TABLE_ROWS || Boolean(preview.value.truncated) };
});
const cues = computed(() => (format.value === "subtitle" && preview.value?.text != null ? subtitle_cues(preview.value.text, active_path.value) : []));
// Images, video and audio of a project open in the viewer and players instead of as text (an SVG keeps its source view).
const media_kind = computed(() => (tab.value?.attachment ? "" : media_of(active_path.value)));
// Images a project Markdown file refers to by relative path are read by the computer (`tab.page.images`).
const rendered = computed(() => format.value === "markdown" && preview.value?.text
  ? inline_markdown_images(window.discuss_markdown.render_markdown(preview.value.text, [], { source_lines: true }), tab.value?.page?.images, active_path.value.split("/").slice(0, -1).join("/")) : "");
// Sent into the in-page preview so a selection can be quoted: once a selection settles it posts its text and boxes
// (in the frame's viewport) to this page, which offers "添加到对话"; it clears the selection when asked. The file's own
// scripts could post the same message; at worst that shows an offer the user still has to confirm.
const selection_bridge = () => `<script>(()=>{let timer=0,down=false;const post=(text,rects)=>parent.postMessage({codiscuss_selection:{text,rects}},"*");
const send=()=>{const s=getSelection(),r=s&&s.rangeCount&&!s.isCollapsed?s.getRangeAt(0):null;
post(r?s.toString():"",r?[...r.getClientRects()].filter(b=>b.width).slice(0,50).map(b=>[b.left,b.top,b.right,b.bottom]):[]);};
const later=()=>{clearTimeout(timer);post("",[]);if(!down)timer=setTimeout(send,${OFFER_SETTLE_MS});};
document.addEventListener("selectionchange",later);addEventListener("scroll",later,{passive:true});
addEventListener("pointerdown",e=>{down=e.pointerType!=="touch";},true);addEventListener("pointerup",()=>{down=false;later();},true);addEventListener("pointercancel",()=>{down=false;later();},true);
addEventListener("message",e=>{if(e.source===parent&&e.data&&e.data.codiscuss_clear){const s=getSelection();if(s)s.removeAllRanges();}});})();<\/script>`;
// A project's HTML file is shown as the computer bundles it (the files it refers to inlined); an attachment as it is.
const html_text = computed(() => tab.value?.page?.text ?? preview.value?.text ?? "");
const html_preview = computed(() => tab.value?.attachment
  ? inline_visual_document(html_text.value, false, { extra: selection_bridge(), measure: false })
  : html_document(html_text.value, selection_bridge()));
const can_open_html = computed(() => format.value === "html" && can_render.value && !tab.value?.loading);
// What the rendered HTML lacks: files it refers to that could not be included, or none at all for an attachment.
const html_notice = computed(() => {
  if (!["markdown", "html"].includes(format.value) || media_kind.value || !tab.value || tab.value.loading) return "";
  if (format.value === "markdown" && tab.value.attachment) return "";
  if (tab.value.attachment) return t('附件没有所在目录，相对路径引用的样式、脚本与图片不会载入');
  if (tab.value.page_error) return format.value === "markdown" ? t('引用的图片未能载入（{value1}）', { value1: tab.value.page_error }) : t('引用的文件未能载入（{value1}），只显示 HTML 本身', { value1: tab.value.page_error });
  const { missing = [], skipped = [] } = tab.value.page || {};
  const parts = [missing.length ? t('{value1} 个不存在或在项目目录外', { value1: missing.length }) : "", skipped.length ? t('{value1} 个超出 8 MiB 上限', { value1: skipped.length }) : ""].filter(Boolean);
  return parts.length ? t('引用的文件有 {value1}，未载入：{value2}', { value1: parts.join("、"), value2: [...missing, ...skipped].join("、") }) : "";
});

/** Show the HTML file in a new tab: a page of ours holding only the sandboxed file, so it never runs as this site. */
function open_html_tab() {
  const theme = tab.value?.attachment ? inline_visual_theme(document.documentElement) : null;
  const page = visual_tab_document(preview_name.value, html_text.value, theme);
  window.open(URL.createObjectURL(new Blob([page], { type: "text/html" })), "_blank");
}
const can_render = computed(() => preview.value?.text != null && (format.value !== "text" || Boolean(media_kind.value)) && !(format.value === "html" && preview.value.truncated && !tab.value?.page));
const showing_source = computed(() => preview.value?.text != null && (!can_render.value || source.value));
// A project's text file can be edited from its source view; the computer reads it again in full to edit.
// A file past the preview's first part is read whole when editing starts; the computer refuses one over its edit limit.
const can_edit = computed(() => showing_source.value && !tab.value?.attachment && !tab.value?.edit);

/** Read the open file whole and turn its source view into an editor. */
async function start_edit() {
  const item = tab.value;
  if (!can_edit.value || item.starting_edit) return;
  item.starting_edit = true;
  try {
    const answer = await bridge.manage_room_files(item.room_id, { op: "read", root: item.root || 0, path: item.path });
    item.edit = { text: answer.text, version: answer.version, saving: false };
  } catch (error) { bridge.notify("error", t('无法编辑：{value1}', { value1: error.message })); }
  finally { item.starting_edit = false; }
}

/** Save the edited text; when an AI member changed the file meanwhile, nothing is written and the text stays in the editor. */
async function save_edit() {
  const item = tab.value, edit = item?.edit;
  if (!edit || edit.saving) return;
  edit.saving = true;
  try {
    const answer = await bridge.manage_room_files(item.room_id, { op: "save", root: item.root || 0, path: item.path, text: edit.text, version: edit.version });
    if (answer.conflict) { bridge.notify("warning", t('文件在你编辑期间被修改过，未保存；你的内容仍在编辑框里，可复制后点“放弃修改”重新读取')); return; }
    item.edit = null;
    bridge.notify("info", t('已保存 {value1}', { value1: name_of(item.path) }));
    load(item);
  } catch (error) { bridge.notify("error", t('保存失败：{value1}', { value1: error.message })); }
  finally { if (item.edit) item.edit.saving = false; }
}

/** Leave the editor without saving and read the file again. */
function cancel_edit() {
  const item = tab.value;
  if (!item) return;
  item.edit = null;
  load(item);
}
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
// The offer pills and the comment box sit just above the selection (below it when there is no room).
const OFFER_WIDTH = 190;
const OFFER_HEIGHT = 28;
const COMMENT_WIDTH = 440;
const COMMENT_HEIGHT = 92;
const OFFER_GAP = 6;
const FOLLOW_KEYS = ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "];
const editor_body = ref(null), markdown_scroll = ref(null), markdown_body = ref(null), code_scroll = ref(null), comment_input = ref(null), crumbs_nav = ref(null), code_text = ref(null), html_frame = ref(null);

function apply_attachment_theme() {
  const frame = html_frame.value;
  if (frame && tab.value?.attachment) send_visual_theme(frame.contentWindow, inline_visual_theme(frame));
}

watch(() => tab.value?.attachment ? html_frame.value : null, (frame, previous, on_cleanup) => {
  if (frame) on_cleanup(observe_visual_theme(apply_attachment_theme));
});
// A deep path shows its end, where the file's own folder is, instead of the root levels.
watch([() => open.value, active_path], async () => { await nextTick(); if (crumbs_nav.value) crumbs_nav.value.scrollLeft = crumbs_nav.value.scrollWidth; });
const speech_ready = ref(false);
// `offer`: a settled selection in the Markdown preview, with what quoting it would add; `commenting`: the offer being
// added to the chat, waiting for an optional comment.
const offer = ref(null);
const commenting = ref(null);
const comment = ref("");
// Number marks at the end of the shown file's passages still in the composer: [{ id, number, left, top }]; one of them
// reopened for editing: `{ excerpt, left, top }`.
const file_marks = ref([]);
const mark_editing = ref(null);
// The CSS highlight underlining the shown file's quoted passages.
const MARKED_HIGHLIGHT = "excerpt-marked";
const MARK_CARD_WIDTH = COMMENT_WIDTH;
const MARK_CARD_HEIGHT = COMMENT_HEIGHT;
let offer_timer = 0, pointer_down = false;
const speech_settings = () => bridge.local_request("tts-settings", {});
const reader = use_read_aloud({ bridge, container: () => markdown_scroll.value, hosts: ".project-markdown-preview",
  voice_for: async () => { try { return (await speech_settings()).file_voice || ""; } catch { return ""; } },
  title: () => view.value.room?.title || "" });
const can_read = computed(() => speech_ready.value && format.value === "markdown" && !source.value && Boolean(preview.value?.text));
/** Phones fold the file's actions into the head's "..." menu; font steps keep it open so taps can repeat. */
const file_menu = computed(() => {
  const keep_open = (action) => (event) => { event.preventDefault(); action(); };
  const groups = [];
  if (can_scale.value) groups.push([
    { label: t('缩小字号'), icon: "i-lucide-a-arrow-down", disabled: font_scale.value <= FONT_SCALE_MIN, onSelect: keep_open(() => change_font_scale(-1)) },
    { label: t('放大字号'), icon: "i-lucide-a-arrow-up", disabled: font_scale.value >= FONT_SCALE_MAX, onSelect: keep_open(() => change_font_scale(1)) },
    { label: t('恢复默认字号（当前 {value1}%）', { value1: Math.round(font_scale.value * 100) }), icon: "i-lucide-rotate-ccw", disabled: font_scale.value === 1, onSelect: keep_open(() => change_font_scale(0)) },
  ]);
  const rest = [];
  if (showing_source.value) rest.push({ label: wrap.value ? t('关闭自动换行') : t('自动换行'), icon: "i-lucide-wrap-text", onSelect: () => { wrap.value = !wrap.value; } });
  if (can_edit.value) rest.push({ label: t('编辑'), icon: "i-lucide-pencil", disabled: tab.value.starting_edit, onSelect: () => start_edit() });
  if (can_read.value) rest.push(reader.state.reading ? { label: t('停止朗读'), icon: "i-lucide-square", onSelect: () => reader.stop() } : { label: t('朗读'), icon: "i-lucide-volume-2", onSelect: () => read_file() });
  if (can_open_html.value) rest.push({ label: t('在新标签页打开'), icon: "i-lucide-external-link", onSelect: () => open_html_tab() });
  if (can_render.value) rest.push(source.value ? { label: t('预览'), icon: "i-lucide-eye", onSelect: () => { source.value = false; } } : { label: t('源码'), icon: "i-lucide-code-xml", onSelect: () => { source.value = true; } });
  if (rest.length) groups.push(rest);
  // Kept out of the head so it is not mistaken for the active tab's own close button.
  if (narrow.value && tabs.value.length > 1) groups.push([{ label: t('关闭全部文件'), icon: "i-lucide-x", onSelect: () => close_all() }]);
  return groups;
});

/**
 * Check whether this computer has a speech key, so the read-aloud entries show only when they can work. A failed read
 * (the relay dropping a request on a poor network) keeps what was known: it used to hide 朗读 and 听当前 until the file
 * was opened again (2026-11-16, iPhone: gone after switching to the source and back).
 */
function check_speech() {
  speech_settings().then((settings) => { speech_ready.value = Boolean(settings.api_key_ref); }, () => {});
}

/** Read one tab's file, discarding answers to its earlier requests; a tab already shown keeps its text meanwhile. */
async function load(item) {
  const request = (item.request || 0) + 1;
  Object.assign(item, { request, loading: true, error: "" });
  const page_read = !item.attachment && /\.(md|markdown|html?)$/i.test(item.path) ? load_page(item, request) : null;
  try {
    // The tab is already open with its loading animation; an attachment's address (through the relay for the
    // computer's rooms) is fetched only now.
    if (item.attachment && !item.attachment.url) item.attachment.url = await bridge.attachment_url(item.attachment);
    // An Office attachment is read whole by its preview, never decoded as text.
    const binary = media_of(item.path) || document_kind_of(item.path);
    const result = binary ? { text: null, reason: "", size: item.attachment?.size ?? item.metadata?.size, modified_at: item.attachment?.created_at || item.metadata?.modified_at }
      : item.attachment ? await read_attachment(item.attachment) : await bridge.read_room_files(item.room_id, item.path, 0, "", item.root || 0);
    if (item.request === request) item.data = result;
    // The computer inlines what a project's HTML file refers to, so it renders as it would opened on that computer;
    // for Markdown it reads the images the file shows.
    await page_read;
    if (item.request === request && !item.attachment && (media_of(item.path) || document_kind_of(item.path))) await load_media(item, request);
    if (item.request === request && item.attachment && binary) item.media = { url: item.attachment.url, blob: false };
    if (item.request === request && document_kind_of(item.path) === "prproj" && item.media) await unpack_project(item, request);
  } catch (error) {
    if (item.request === request) item.error = error.message;
  } finally { if (item.request === request) item.loading = false; }
}

/** Read referenced images or bundled HTML beside the source file instead of adding another serial round trip. */
async function load_page(item, request) {
  try {
    const page = await bridge.read_room_page(item.room_id, item.path, item.root || 0);
    if (/\.(md|markdown)$/i.test(item.path)) page.images = JSON.parse(page.text || "{}");
    if (item.request === request) Object.assign(item, { page, page_error: "" });
  } catch (error) { if (item.request === request) item.page_error = error.message; }
}

/** Give a media tab its playable address: a stream of the computer's website, or the whole file through the relay. */
async function load_media(item, request) {
  release_media(item);
  Object.assign(item, { media_error: "", media_progress: 0 });
  try {
    const media = await bridge.read_room_media(item.room_id, item.path, item.root || 0, (loaded, total) => {
      if (item.request === request) item.media_progress = total ? loaded / total : 0;
    });
    if (item.request !== request) { if (media.blob) URL.revokeObjectURL(media.url); return; }
    item.media = media;
    if (item.data) item.data.size = media.size;
  } catch (error) { if (item.request === request) item.media_error = error.message; }
}

/** A Premiere project is gzip-compressed XML: show that XML as the tab's text. */
async function unpack_project(item, request) {
  try {
    const response = await fetch(item.media.url);
    if (!response.ok) throw new Error(t('文件读取失败（{value1}）', { value1: response.status }));
    const compressed = new Uint8Array(await response.arrayBuffer());
    const bytes = await new Promise((resolve, reject) => gunzip(compressed, (error, data) => error ? reject(error) : resolve(data)));
    const truncated = bytes.length > ATTACHMENT_TEXT_LIMIT;
    const text = new TextDecoder("utf-8").decode(truncated ? bytes.subarray(0, ATTACHMENT_TEXT_LIMIT) : bytes);
    if (item.request === request) item.data = { ...item.data, text, truncated, limit: ATTACHMENT_TEXT_LIMIT, encoding: "utf-8", reason: "" };
  } catch (error) {
    if (item.request === request) item.data = { ...item.data, text: null, reason: t('Premiere 工程无法解压：{value1}', { value1: error.message }) };
  }
}

/** Free the Blob a relayed media file was read into, when its tab reloads or closes. */
function release_media(item) {
  if (item.media?.blob) URL.revokeObjectURL(item.media.url);
  item.media = null;
}

/** Open a file of the current room in its own tab (or re-read the tab it already has) and show the window. */
function open_file(path, directory, root = 0, metadata = null) {
  remember_scroll();
  const room_id = view.value.room?.id;
  if (!room_id) return;
  const id = `${room_id}\n${root}\n${path}`;
  let item = tabs.value.find(entry => entry.id === id);
  if (!item) {
    tabs.value.push({ id, room_id, directory, root, path, data: null, loading: false, error: "", source: false, scroll: 0, request: 0 });
    item = tabs.value[tabs.value.length - 1];
  }
  active_id.value = id;
  item.metadata = metadata;
  open.value = true;
  check_speech();
  load(item);
}

/** Open a message attachment (`{ room_id, id, file_name, url, created_at }`) in its own tab, read as text. */
function open_attachment(attachment, show_source) {
  remember_scroll();
  const id = `${attachment.room_id}\nattachment\n${attachment.id}`;
  let item = tabs.value.find(entry => entry.id === id);
  if (!item) {
    tabs.value.push({ id, room_id: attachment.room_id, directory: "", root: 0, path: attachment.file_name, attachment, data: null, loading: false, error: "", source: false, scroll: 0, request: 0 });
    item = tabs.value[tabs.value.length - 1];
  }
  if (typeof show_source === "boolean") item.source = show_source;
  active_id.value = id;
  open.value = true;
  check_speech();
  load(item);
}

/** The element that scrolls the active tab's content. */
const scroller = () => markdown_scroll.value || code_scroll.value;
function remember_scroll() { if (tab.value && open.value && scroller()) tab.value.scroll = scroller().scrollTop; }

function activate(id) {
  if (id === active_id.value) return;
  remember_scroll();
  active_id.value = id;
}

function close_tab(id) {
  const index = tabs.value.findIndex(item => item.id === id);
  if (index < 0) return;
  tabs.value[index].request++;
  release_media(tabs.value[index]);
  tabs.value.splice(index, 1);
  if (id !== active_id.value) return;
  active_id.value = tabs.value[Math.min(index, tabs.value.length - 1)]?.id || "";
  if (!tabs.value.length) open.value = false;
}

/** Fold the window into the floating button; every tab stays as it is. */
function minimize() {
  remember_scroll();
  open.value = false;
}

// Folding and unfolding move the window between its place and the floating button, which sits at the top-right of the
// screen (below the room header, clear of the navigation) and can be dragged to either side.
// Phones also fold it by pulling it down.
const FOLD_MS = 240;
const FLOAT_GAP = 12;
const FLOAT_FALLBACK_TOP = 80;
// A pull folds once it passes this share of the window height, or moves down this fast (px/ms) past a short distance.
const PULL_FOLD_SHARE = 0.25;
const PULL_FOLD_SPEED = 0.6;
const PULL_FOLD_MIN = 40;
// A pull starts only past this downward distance, so a tap's small drift stays a tap (blocking its touchmove cancels the click).
const PULL_START = 10;
// While pulled, the window shrinks by up to this much.
const PULL_SHRINK = 0.15;
const frame = ref(null);

// On a wide window the preview is a split pane on the right, beside the messages; narrower ones keep the centered window.
const DOCK_WIDTH_KEY = "ai-codiscuss-file-dock-width";
// Whether the user last chose the floating window over the split pane, on this device.
const FLOATING_KEY = "ai-codiscuss-file-preview-floating";
const DOCK_MIN_WINDOW = 1024;
const DOCK_MIN = 400;
const DOCK_CHAT_MIN = 420;
const DOCK_STEP = 24;
// The width the user dragged the pane to on this device; 0 until then, which splits the room evenly.
const dock_preferred = ref(read_dock_width());
// The width right of the room list that the messages and the pane share; 0 when the window is too narrow to split.
const dock_room = ref(0);
const dock_max = computed(() => dock_room.value - DOCK_CHAT_MIN);
const can_dock = computed(() => dock_max.value >= DOCK_MIN);
const clamp_dock = (width) => Math.round(Math.min(dock_max.value, Math.max(DOCK_MIN, width)));
const dock_width = computed(() => can_dock.value ? clamp_dock(dock_preferred.value || dock_room.value / 2) : 0);
const dock_chosen = ref(read_dock_choice());
const docked = computed(() => open.value && can_dock.value && dock_chosen.value);
let dock_drag = null;

function read_dock_choice() {
  try { return localStorage.getItem(FLOATING_KEY) !== "1"; } catch { return true; }
}

function read_dock_width() {
  try { return Number(localStorage.getItem(DOCK_WIDTH_KEY)) || 0; } catch { return 0; }
}
function save_dock_width() {
  try { localStorage.setItem(DOCK_WIDTH_KEY, String(dock_width.value)); } catch { /* Kept for this visit only. */ }
}
/**
 * Split only on a computer or a tablet held sideways. A tablet is always laid out 1440px wide, so the window's width
 * alone would also split it upright.
 */
function splits_here() {
  if (window.innerWidth < DOCK_MIN_WINDOW) return false;
  if (!window.matchMedia("(pointer: coarse)").matches) return true;
  return Math.min(screen.width, screen.height) >= TABLET_MIN_SIDE && window.matchMedia("(orientation: landscape)").matches;
}
function measure_dock() {
  const left = document.querySelector(".channel-main")?.getBoundingClientRect().left || 0;
  dock_room.value = splits_here() ? window.innerWidth - left : 0;
}
/** Tell the workspace how much room the pane takes; what is laid out by the window's width follows the change. */
function publish_dock(width) {
  file_preview.dock_width = width;
  if (width) document.documentElement.style.setProperty("--file-dock-width", `${width}px`);
  else document.documentElement.style.removeProperty("--file-dock-width");
  window.dispatchEvent(new Event("resize"));
}
watch(open, (value) => { if (value) measure_dock(); }, { flush: "sync" });
watch(() => docked.value ? dock_width.value : 0, publish_dock, { flush: "post" });
function dock_press(event) {
  if (event.button !== 0) return;
  event.currentTarget.setPointerCapture?.(event.pointerId);
  dock_drag = { x: event.clientX, width: dock_width.value };
}
function dock_move(event) {
  if (dock_drag) dock_preferred.value = clamp_dock(dock_drag.width + dock_drag.x - event.clientX);
}
function dock_release() {
  if (dock_drag) save_dock_width();
  dock_drag = null;
}
function dock_key(event) {
  const widths = { ArrowLeft: dock_width.value + DOCK_STEP, ArrowRight: dock_width.value - DOCK_STEP, Home: dock_max.value, End: DOCK_MIN };
  if (!(event.key in widths)) return;
  event.preventDefault();
  dock_preferred.value = clamp_dock(widths[event.key]);
  save_dock_width();
}
// Beside the messages the pane stays open while the user works in them: only its own buttons fold or close it.
const modal_content = {
  onInteractOutside: (event) => event.preventDefault(),
  onEscapeKeyDown: (event) => { if (docked.value) event.preventDefault(); },
};

const float_place = ref({ left: 0, top: FLOAT_FALLBACK_TOP });
const motion_disabled = () => document.documentElement.dataset.motion === "off";
let pull = null, folding = false;

// The floating button can be dragged anywhere (mouse or finger) and sticks to the nearer side when let go: the content
// column's left edge or the screen's right edge. A press that moves less than this stays a tap.
const FLOAT_HEIGHT = 40;
const FLOAT_WIDTH = 44;
const FLOAT_DRAG_MIN = 6;
const float_side = ref("right");
// While dragged, the button follows the pointer at `{ left, top }`.
const float_drag_place = ref(null);
let float_top = null, float_drag = null, float_dragged = false;

/** Keep a dragged floating button fully on screen. */
function clamp_float_top(top) {
  return Math.min(Math.max(top, 0), Math.max(0, window.innerHeight - FLOAT_HEIGHT));
}

/** Put the floating button on its side (left: the content column's edge), at the top or where it was dragged to. */
function place_float() {
  const content = document.querySelector(".channel-content")?.getBoundingClientRect();
  // Measured with the page unscrolled: a phone's keyboard (open while commenting) scrolls the page up, and a top taken
  // then would leave the button above the screen once the keyboard closes.
  float_place.value = content ? { left: content.left, top: clamp_float_top(content.top + window.scrollY + FLOAT_GAP) } : { left: 0, top: FLOAT_FALLBACK_TOP };
  if (float_side.value === "right") float_place.value.left = window.innerWidth - FLOAT_WIDTH;
  if (float_top !== null) float_place.value.top = clamp_float_top(float_top);
}

const float_style = computed(() => {
  if (float_drag_place.value) return { left: `${float_drag_place.value.left}px`, top: `${float_drag_place.value.top}px` };
  const top = `${float_place.value.top}px`;
  return float_side.value === "right" ? { right: "0px", top } : { left: `${float_place.value.left}px`, top };
});

/** Start following a press on the floating button; the pointer is captured only once it becomes a drag, so a tap still clicks. */
function float_press(event) {
  if (event.button !== 0) return;
  const rect = event.currentTarget.getBoundingClientRect();
  float_drag = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, width: rect.width, moved: false };
}

/** Move the floating button with the pointer once the press has moved far enough to be a drag. */
function float_move(event) {
  if (!float_drag) return;
  const dx = event.clientX - float_drag.x, dy = event.clientY - float_drag.y;
  if (!float_drag.moved) {
    if (Math.hypot(dx, dy) < FLOAT_DRAG_MIN) return;
    float_drag.moved = true;
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }
  const left = Math.min(Math.max(float_drag.left + dx, 0), Math.max(0, window.innerWidth - float_drag.width));
  float_drag_place.value = { left, top: clamp_float_top(float_drag.top + dy) };
}

/** End a press; a drag sticks to the nearer side, and the click that follows must not open or close the files. */
function float_release() {
  float_dragged = Boolean(float_drag?.moved);
  if (float_dragged && float_drag_place.value) {
    const { left, top } = float_drag_place.value;
    float_side.value = left + float_drag.width / 2 < window.innerWidth / 2 ? "left" : "right";
    float_top = top;
    place_float();
  }
  float_drag = null;
  float_drag_place.value = null;
}

/** Swallow the click ending a drag. */
function float_click(event) {
  if (!float_dragged) return;
  float_dragged = false;
  event.stopPropagation();
  event.preventDefault();
}

/** Style the window frame; `transition` false applies it at once (following a finger). */
function set_frame(transform, { opacity = "", radius = "", transition = true } = {}) {
  const element = frame.value;
  if (!element) return;
  // A GPU layer only while moving: a lasting one renders the text without subpixel smoothing, which looks blurred.
  Object.assign(element.style, { transformOrigin: "0 0", transition: transition ? `transform ${FOLD_MS}ms ease, opacity ${FOLD_MS}ms ease, border-radius ${FOLD_MS}ms ease` : "none",
    transform, opacity, borderRadius: radius, willChange: transform ? "transform" : "" });
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
  if (!element || motion_disabled() || docked.value) { finish(); return; }
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
  await nextTick();
  // The reading's highlight is drawn and followed again once the window has its full size and its scroll back.
  if (motion_disabled() || docked.value) { requestAnimationFrame(() => reader.refresh()); return; }
  requestAnimationFrame(() => {
    const element = frame.value;
    if (!element) return;
    set_frame(float_transform(element.getBoundingClientRect()), { opacity: "0", radius: "14px", transition: false });
    element.getBoundingClientRect();
    set_frame("", {});
    const grown = (event) => {
      if (event.target !== element || event.propertyName !== "transform") return;
      element.removeEventListener("transitionend", grown);
      reader.refresh();
    };
    element.addEventListener("transitionend", grown);
  });
}

/**
 * Switch between the split pane and the floating window. The file stays mounted, so nothing is read or laid out again:
 * the window takes its new place at once and is drawn moving there from the old one.
 */
async function toggle_dock() {
  const element = frame.value, from = element?.getBoundingClientRect();
  dock_chosen.value = !dock_chosen.value;
  try { localStorage.setItem(FLOATING_KEY, dock_chosen.value ? "0" : "1"); } catch { /* Kept for this visit only. */ }
  if (!element || motion_disabled()) return;
  await nextTick();
  const to = element.getBoundingClientRect();
  set_frame(`translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width}, ${from.height / to.height})`, { transition: false });
  element.getBoundingClientRect();
  set_frame("", {});
}

/**
 * A downward pull on a touch screen: from the tab strip or breadcrumbs, or from the text once it is scrolled to the top.
 * Not while text is selected, so moving selection handles never folds the window.
 */
function pull_start(event) {
  pull = null;
  if (folding || docked.value || event.touches.length !== 1 || !window.matchMedia("(pointer: coarse)").matches || commenting.value) return;
  if (event.target.closest?.("input, textarea, .file-selection-offer, .file-listen-dock")) return;
  const selection = document.getSelection();
  if (selection && !selection.isCollapsed) return;
  const content = scroller();
  const from_bar = Boolean(event.target.closest?.(".project-editor-head"));
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
    if (dy < PULL_START) return;
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
  for (const item of tabs.value) { item.request++; release_media(item); }
  tabs.value = [];
  active_id.value = "";
  open.value = false;
}

/** Report whether the file's room is open, switching to it when needed. */
async function to_tab_room(room_id = tab.value?.room_id) {
  if (!room_id) return false;
  if (view.value.room?.id === room_id) return true;
  const switched = await act("room", room_id);
  await nextTick();
  return switched && view.value.room?.id === room_id;
}

/** Jump the file list (of the file's room) to a folder named in the breadcrumb, folding the window away. */
async function reveal_folder(path) {
  const { room_id, root, directory } = tab.value;
  if (!await to_tab_room(room_id)) return;
  if (!docked.value) fold();
  file_preview.reveal_root = root || 0;
  file_preview.reveal_name = directory || "";
  file_preview.reveal_path = path;
  act("tab", "files");
}

// Back on a tab (or in the window again), it is where it was left; a new tab starts at the top.
watch([open, active_id, () => Boolean(preview.value)], async () => {
  if (!open.value || !tab.value) return;
  await nextTick();
  if (scroller()) scroller().scrollTop = tab.value.scroll;
});

/** Read the whole file from its first line after the front matter. */
// The file a reading started from: it goes on while another file or the source is shown, and its highlight comes back
// when that file's preview is shown again (user 2026-11-17: switching files stopped the reading).
let reading_file = "";
function read_file() {
  reading_file = active_id.value;
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
// Only a mouse or pen holds the offer until release; iOS sends no release after a long-press selection (see ChannelDiscussion).
const press = (event) => { if (on_offer(event) || event.target.closest?.(".excerpt-mark")) return; pointer_down = event.pointerType !== "touch"; if (mark_editing.value) close_mark(); };
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

/** Place `{ left, top }` in the text area for a box of this size above the first box, or below the last when there is no room. */
function place_rects(rects, width, height) {
  const box = editor_body.value.getBoundingClientRect();
  const first = rects[0], last = rects[rects.length - 1] || first;
  const above = first.top - box.top - height - OFFER_GAP;
  const left = above >= 0 ? first.left - box.left : last.right - box.left - width / 2;
  return { left: Math.max(8, Math.min(left, box.width - width - 8)), top: above >= 0 ? above : last.bottom - box.top + OFFER_GAP };
}

/** Place a box above the range's start, or below its end when there is no room. */
function place_by(range, width, height) {
  const rects = [...range.getClientRects()];
  return place_rects(rects.length ? rects : [range.getBoundingClientRect()], width, height);
}

const offer_text = (text) => text.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
const touch_screen = () => window.matchMedia("(pointer: coarse)").matches;

/**
 * Where a point of a selection in the source view lies in the file's text, or -1 when it is not on a line: wrapped,
 * from its row's line and the offset within the line; unwrapped, from the offset in the single text block.
 */
function source_index(container, offset) {
  const element = container.nodeType === Node.TEXT_NODE ? container.parentElement : container;
  if (code_text.value?.contains(container)) return text_offset(code_text.value, container, offset);
  const row = element?.closest?.(".project-code-row");
  if (!row || !code_scroll.value?.contains(row)) return -1;
  const line = Number(row.dataset.line) - 1;
  const span = element.closest(".project-code-line");
  const at = span ? Math.min(text_offset(span, container, offset), lines.value[line].length) : 0;
  return lines.value.slice(0, line).reduce((sum, text) => sum + text.length + 1, 0) + at;
}

/**
 * A selection in the source view as `{ text, start, end }` taken from the file itself, so line numbers never get in;
 * `from`–`to` are its characters in the file, for its mark in the source view (`in_source`).
 */
function source_selection(range) {
  const from = source_index(range.startContainer, range.startOffset), to = source_index(range.endContainer, range.endOffset);
  if (from < 0 || to <= from) return null;
  const all = preview.value.text, line_of = (index) => all.slice(0, index).split("\n").length;
  const text = all.slice(from, to);
  const start = line_of(from + (text.length - text.trimStart().length));
  return { text: offer_text(text), start, end: Math.max(start, line_of(from + text.trimEnd().length)), from, to, in_source: true };
}

/** Offer quoting (and reading from) a selection made in the Markdown preview or the source view: above it, or in the bottom dock on touch screens. */
function track_selection() {
  if (commenting.value) return;
  const selection = document.getSelection();
  const range = selection?.rangeCount && !selection.isCollapsed ? selection.getRangeAt(0) : null;
  if (!range || !editor_body.value) return;
  if (showing_source.value) {
    const quoted = code_scroll.value?.contains(range.startContainer) ? source_selection(range) : null;
    if (quoted?.text) offer.value = { range: range.cloneRange(), ...quoted, touch: touch_screen(), ...place_by(range, OFFER_WIDTH, OFFER_HEIGHT) };
    return;
  }
  const body = markdown_body.value;
  if (source.value || !body?.contains(range.startContainer)) return;
  const text = offer_text(range.toString());
  if (!text) return;
  const to = body.contains(range.endContainer) ? text_offset(body, range.endContainer, range.endOffset) : body.textContent.length;
  const from = text_offset(body, range.startContainer, range.startOffset);
  offer.value = { range: range.cloneRange(), text, from, to, ...selected_lines(range), touch: touch_screen(),
    ...place_by(range, OFFER_WIDTH, OFFER_HEIGHT) };
}

// Longest selection, and most boxes, a message from the HTML preview may carry.
const FRAME_TEXT_MAX = 20000;
const FRAME_RECTS_MAX = 50;

/** A selection settled (or cleared) in the HTML preview: offer quoting it, placed by its boxes moved into this page. */
function frame_selection(event) {
  const frame = html_frame.value;
  const data = event.data?.codiscuss_selection;
  if (!frame || event.source !== frame.contentWindow || !data || commenting.value) return;
  offer.value = null;
  const text = typeof data.text === "string" ? offer_text(data.text.slice(0, FRAME_TEXT_MAX)) : "";
  const boxes = Array.isArray(data.rects) ? data.rects.slice(0, FRAME_RECTS_MAX).filter((box) => Array.isArray(box) && box.length === 4 && box.every(Number.isFinite)) : [];
  if (!text || !boxes.length || source.value || !editor_body.value) return;
  const origin = frame.getBoundingClientRect();
  const rects = boxes.map(([left, top, right, bottom]) => ({ left: origin.left + left, top: origin.top + top, right: origin.left + right, bottom: origin.top + bottom }));
  offer.value = { rects, text, start: 0, end: 0, touch: touch_screen(), ...place_rects(rects, OFFER_WIDTH, OFFER_HEIGHT) };
}

/** Clear the selection in this page and ask the HTML preview to clear its own. */
function clear_selection() {
  document.getSelection()?.removeAllRanges();
  html_frame.value?.contentWindow?.postMessage({ codiscuss_clear: true }, "*");
}

/** Where character `index` of the file sits in the wrapped source view (one row per line), as `[node, offset]`. */
function wrapped_point(index) {
  let line = 0, left = index;
  while (line < lines.value.length - 1 && left > lines.value[line].length) { left -= lines.value[line].length + 1; line++; }
  const span = code_scroll.value?.querySelector(`.project-code-row[data-line="${line + 1}"] .project-code-line`);
  if (!span) return null;
  return span.firstChild ? [span.firstChild, Math.min(left, span.firstChild.length)] : [span, 0];
}

/** The shown text of an excerpt of this file, in the view it was quoted from (preview or source); null when not shown. */
function passage_range(excerpt) {
  if (excerpt.message_id || excerpt.path !== reference_path.value || showing_source.value !== Boolean(excerpt.in_source)) return null;
  if (!excerpt.in_source) return excerpt_range(markdown_body.value, excerpt.from, excerpt.to);
  if (code_text.value) return excerpt_range(code_text.value, excerpt.from, excerpt.to);
  const start = wrapped_point(excerpt.from), end = wrapped_point(excerpt.to);
  if (!start || !end) return null;
  const range = document.createRange();
  range.setStart(...start);
  range.setEnd(...end);
  return range;
}

/**
 * Underline each excerpt of the shown file and re-measure where it ends, for its number mark. The underline is a CSS
 * highlight, so the file's own text and the selection stay untouched.
 */
function place_file_marks() {
  const host = showing_source.value ? code_scroll.value : markdown_scroll.value;
  const shown = !open.value || !host ? [] : file_preview.excerpts.flatMap((excerpt, index) => {
    const range = passage_range(excerpt);
    if (!range) return [];
    const tail = document.createRange();
    tail.setStart(range.endContainer, Math.max(0, range.endOffset - 1));
    tail.setEnd(range.endContainer, range.endOffset);
    const rects = tail.getClientRects(), rect = rects[rects.length - 1];
    if (!rect) return [];
    const origin = host.getBoundingClientRect();
    return [{ id: excerpt.id, number: index + 1, range, hidden: scrolled_out(range.endContainer, host, rect.right), left: rect.right - origin.left + host.scrollLeft, top: rect.top - origin.top + host.scrollTop }];
  });
  file_marks.value = shown.filter((item) => !item.hidden).map(({ range, hidden, ...mark }) => mark);
  if (!globalThis.CSS?.highlights || typeof Highlight !== "function") return;
  if (shown.length) CSS.highlights.set(MARKED_HIGHLIGHT, new Highlight(...shown.map((item) => item.range)));
  else CSS.highlights.delete(MARKED_HIGHLIGHT);
}
/** A wide table or code block scrolls sideways inside the preview: its marks follow it. */
const follow_inner_scroll = inner_scroll_follower(() => { if (file_preview.excerpts.length) place_file_marks(); });

/** A click inside an underlined passage opens its edit card, as its number mark does. */
function open_mark_at(event) {
  if (!document.getSelection()?.isCollapsed || event.target.closest?.(".excerpt-mark")) return;
  const caret = document.caretPositionFromPoint?.(event.clientX, event.clientY);
  const fallback = !caret && document.caretRangeFromPoint?.(event.clientX, event.clientY);
  const point = caret ? [caret.offsetNode, caret.offset] : fallback ? [fallback.startContainer, fallback.startOffset] : null;
  if (!point) return;
  const hit = file_preview.excerpts.find((excerpt) => passage_range(excerpt)?.isPointInRange(...point));
  if (hit) open_mark(hit.id);
}

/** Open a quoted passage's edit card from its number mark, highlighting the passage again. */
function open_mark(excerpt_id) {
  cancel_comment();
  const excerpt = file_preview.excerpts.find((item) => item.id === excerpt_id);
  const range = excerpt && passage_range(excerpt);
  if (!range) return;
  hold_selection(range);
  // Docked at the bottom on touch screens, as adding a note is.
  mark_editing.value = { excerpt, touch: window.matchMedia("(pointer: coarse)").matches, ...place_by(range, MARK_CARD_WIDTH, MARK_CARD_HEIGHT) };
}
function close_mark() {
  mark_editing.value = null;
  hold_selection(null);
}
function save_mark(comment) {
  mark_editing.value.excerpt.comment = comment;
  close_mark();
}
function remove_mark() {
  const { id } = mark_editing.value.excerpt;
  file_preview.excerpts = file_preview.excerpts.filter((item) => item.id !== id);
  close_mark();
}

/** Start reading where the selection begins and go on to the end of the file. */
function listen_from_selection() {
  const { range } = offer.value;
  offer.value = null;
  document.getSelection()?.removeAllRanges();
  reading_file = active_id.value;
  reader.read_document(markdown_body.value, { selection: range, heading: preview_name.value });
}

/** Ask for an optional comment on the selection before it goes to the chat. */
async function start_comment() {
  // A selection in the HTML preview stays shown there by the frame itself.
  const { range, rects } = offer.value;
  commenting.value = { ...offer.value, ...(range ? place_by(range, COMMENT_WIDTH, COMMENT_HEIGHT) : place_rects(rects, COMMENT_WIDTH, COMMENT_HEIGHT)) };
  if (range) hold_selection(range);
  offer.value = null;
  comment.value = "";
  document.getSelection()?.removeAllRanges();
  await nextTick();
  comment_input.value?.focus();
}

function cancel_comment() { commenting.value = null; hold_selection(null); }

/** Put the selection (and comment) in the composer of the room shown now as an excerpt, fold the window and go to the messages. */
async function add_excerpt() {
  const { text, start, end, from, to, in_source = false } = commenting.value;
  const attachment = tab.value?.attachment;
  const excerpt = { path: reference_path.value, name: preview_name.value, start, end, text, from, to, in_source, comment: comment.value.trim(),
    ...(attachment ? { attachment_id: attachment.id, attachment_message_id: Number(attachment.message_id) || 0 } : {}) };
  cancel_comment();
  clear_selection();
  if (!view.value.room) await to_tab_room();
  if (!view.value.room) return;
  act("tab", "discussion");
  if (docked.value) put_excerpt(excerpt);
  else fold(() => put_excerpt(excerpt));
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

// Folding or closing the window, switching tabs or to source, or the text changing ends any quoting; all but folding
// also end the reading (closing every file clears the active tab), which goes on while folded.
watch([open, active_id, source, rendered], () => { offer.value = null; cancel_comment(); close_mark(); });
watch([open, active_id, source, rendered, font_scale, wrap, showing_source, () => file_preview.excerpts.map((excerpt) => excerpt.id).join()], () => nextTick(place_file_marks), { flush: "post" });
// The reading stops only when every file is closed or its own file's text changes while shown; back on its file's
// preview, its highlight is bound to the text rendered again.
watch([active_id, source, rendered], async ([id, shown_source], [last_id, last_source]) => {
  if (!reader.state.message_id) return;
  if (!id) return reader.stop();
  if (id === reading_file && id === last_id && shown_source === last_source) return reader.stop();
  await nextTick();
  if (id === reading_file && !shown_source && markdown_body.value) reader.rebind_document(markdown_body.value);
});
// Back on a readable preview without a confirmed speech key (an earlier read failed): ask again.
watch([active_id, source], () => { if (!speech_ready.value && !source.value && format.value === "markdown") check_speech(); });
// Unfolded, the text is laid out anew; the reading's highlight moves onto it.
watch(markdown_body, (root) => { if (root) { reader.rebind_document(root); nextTick(place_file_marks); } });
watch(code_scroll, (root) => { if (root) nextTick(place_file_marks); });
onMounted(() => {
  file_preview.open = open_file;
  window.addEventListener("message", frame_selection);
  bridge.set_text_preview(open_attachment);
  bridge.set_image_viewer((file) => open_image_viewer(file, () => bridge.attachment_url(file)));
  place_float();
  measure_dock();
  window.addEventListener("resize", measure_dock);
  window.addEventListener("resize", place_float);
  narrow_query.addEventListener("change", track_narrow);
  window.addEventListener("resize", place_file_marks);
  document.addEventListener("selectionchange", schedule_offer);
  document.addEventListener("pointerdown", press);
  document.addEventListener("pointerup", release);
  // A touch long-press that starts a selection ends in pointercancel, not pointerup.
  document.addEventListener("pointercancel", release);
});
onBeforeUnmount(() => {
  if (file_preview.open === open_file) file_preview.open = null;
  window.removeEventListener("message", frame_selection);
  bridge.set_text_preview(null);
  bridge.set_image_viewer(null);
  window.removeEventListener("resize", measure_dock);
  publish_dock(0);
  window.removeEventListener("resize", place_float);
  narrow_query.removeEventListener("change", track_narrow);
  head_watcher.disconnect();
  window.removeEventListener("resize", place_file_marks);
  globalThis.CSS?.highlights?.delete(MARKED_HIGHLIGHT);
  hold_selection(null);
  for (const item of tabs.value) item.request++;
  document.removeEventListener("selectionchange", schedule_offer);
  document.removeEventListener("pointerdown", press);
  document.removeEventListener("pointerup", release);
  document.removeEventListener("pointercancel", release);
  window.clearTimeout(offer_timer);
  reader.dispose();
});
</script>

<template>
  <UModal :open="open" :title="preview_name" :description="active_path" :content="modal_content" :modal="!can_dock" :overlay="!can_dock" :transition="!can_dock"
    :ui="{ content: `project-editor${can_dock ? ' is-switchable' : ''}${docked ? ' is-docked' : ''}` }" @update:open="value => value ? (open = true) : fold()">
    <template #content>
     <div ref="frame" class="project-editor-frame" :class="{ 'is-docked': docked }" @touchstart.passive="pull_start" @touchmove="pull_move" @touchend="pull_end" @touchcancel="pull_end">
      <div v-if="docked" class="file-dock-resizer" role="separator" tabindex="0" aria-orientation="vertical" :aria-label="t('调整文件预览宽度')" :aria-valuemin="DOCK_MIN" :aria-valuemax="dock_max" :aria-valuenow="dock_width"
        :title="t('拖动调整文件预览宽度，也可使用左右方向键')" @pointerdown="dock_press" @pointermove="dock_move" @pointerup="dock_release" @pointercancel="dock_release" @keydown="dock_key"></div>
      <div ref="head_element" class="project-editor-head" :class="{ 'is-tight': tight_head && !folded_actions }">
        <div class="project-editor-tablist" role="tablist" :aria-label="t('已打开的文件')">
          <div v-for="item in tabs" :key="item.id" class="project-editor-tab" :class="{ 'is-active': item.id === active_id }" :title="item.path">
            <button type="button" role="tab" class="project-editor-tab-name" :aria-selected="item.id === active_id" @click="activate(item.id)">
              <UIcon :name="file_type(name_of(item.path))[1]" class="project-file-icon" :class="file_type(name_of(item.path))[2]" /><span>{{ name_of(item.path) }}</span>
            </button>
            <button type="button" class="project-editor-tab-close" :aria-label="t('关闭 {value1}', { value1: name_of(item.path) })" :title="t('关闭')" @click="close_tab(item.id)"><UIcon name="i-lucide-x" /></button>
          </div>
        </div>
        <div v-if="!folded_actions" class="project-editor-file-actions">
          <div v-if="can_scale" class="project-editor-font" role="group" :aria-label="t('字号')">
            <button type="button" :title="t('缩小字号')" :aria-label="t('缩小字号')" :disabled="font_scale <= FONT_SCALE_MIN" @click="change_font_scale(-1)"><UIcon name="i-lucide-a-arrow-down" /></button>
            <button type="button" class="project-editor-font-value" :title="t('恢复默认字号')" :aria-label="t('恢复默认字号')" @click="change_font_scale(0)">{{ Math.round(font_scale * 100) }}%</button>
            <button type="button" :title="t('放大字号')" :aria-label="t('放大字号')" :disabled="font_scale >= FONT_SCALE_MAX" @click="change_font_scale(1)"><UIcon name="i-lucide-a-arrow-up" /></button>
          </div>
          <UButton v-if="can_edit" icon="i-lucide-pencil" color="neutral" variant="ghost" size="sm" :title="t('编辑')" :aria-label="t('编辑此文件')" :loading="tab.starting_edit" :disabled="tab.starting_edit" @click="start_edit" />
          <UButton v-if="showing_source" icon="i-lucide-wrap-text" color="neutral" :variant="wrap ? 'soft' : 'ghost'" size="sm" :aria-pressed="wrap"
            :title="wrap ? t('关闭自动换行') : t('自动换行')" :aria-label="t('自动换行')" @click="wrap = !wrap" />
          <UButton v-if="can_read" :icon="reader.state.reading ? 'i-lucide-square' : 'i-lucide-volume-2'" color="neutral" variant="ghost" size="sm"
            :title="reader.state.reading ? t('停止朗读') : t('朗读')" :aria-label="reader.state.reading ? t('停止朗读') : t('从头朗读此文件')" @click="reader.state.reading ? reader.stop() : read_file()" />
          <UButton v-if="can_open_html" icon="i-lucide-external-link" color="neutral" variant="ghost" size="sm" :title="t('在新标签页打开')" :aria-label="t('在新标签页打开')" @click="open_html_tab" />
          <div v-if="can_render" class="project-editor-modes" role="group" :aria-label="t('显示方式')">
            <button type="button" :aria-pressed="!source" :title="t('预览')" @click="source = false"><UIcon name="i-lucide-eye" class="project-mode-icon" /><span>{{ t('预览') }}</span></button>
            <button type="button" :aria-pressed="source" :title="t('源码')" @click="source = true"><UIcon name="i-lucide-code-xml" class="project-mode-icon" /><span>{{ t('源码') }}</span></button>
          </div>
        </div>
        <div class="project-editor-window-actions">
          <UDropdownMenu v-if="folded_actions && file_menu.length" :items="file_menu" :content="{ align: 'end', sideOffset: 4 }" :ui="{ content: 'channel-menu' }"><UButton icon="i-lucide-ellipsis" color="neutral" variant="ghost" size="sm" :aria-label="t('文件操作')" :title="t('字号、朗读、显示方式')" :loading="tab?.starting_edit" /></UDropdownMenu>
          <UButton v-if="can_dock" :icon="docked ? 'i-lucide-picture-in-picture-2' : 'i-lucide-panel-right'" color="neutral" variant="ghost" size="sm" :title="docked ? t('切换为悬浮窗口') : t('切换为右侧分屏')" :aria-label="docked ? t('切换为悬浮窗口') : t('切换为右侧分屏')" @click="toggle_dock" />
          <UButton :icon="narrow ? 'i-lucide-chevron-down' : 'i-lucide-minus'" color="neutral" variant="ghost" size="sm" :title="t('收起到屏幕边缘（手机上也可下拉收起）')" :aria-label="t('收起预览')" @click="fold" />
          <UButton v-if="!narrow" icon="i-lucide-x" color="neutral" variant="ghost" size="sm" :title="tabs.length > 1 ? t('关闭全部文件') : t('关闭预览')" :aria-label="tabs.length > 1 ? t('关闭全部文件') : t('关闭预览')" @click="close_all" />
        </div>
        <nav ref="crumbs_nav" class="project-editor-breadcrumbs" :aria-label="t('文件位置')">
          <template v-for="(part, index) in preview_crumbs" :key="part.path">
            <UIcon v-if="index" name="i-lucide-chevron-right" class="project-crumb-separator" />
            <span v-if="index < preview_crumbs.length - 1 && tab?.attachment">{{ part.name }}</span>
            <button v-else-if="index < preview_crumbs.length - 1" type="button" :title="t('在列表中打开此文件夹')" @click="reveal_folder(part.path)">{{ part.name }}</button>
            <span v-else class="project-crumb-file"><UIcon :name="preview_type[1]" class="project-file-icon" :class="preview_type[2]" />{{ part.name }}</span>
          </template>
        </nav>
      </div>
      <div v-if="tab?.edit" class="project-editor-banner is-editing">
        <UIcon name="i-lucide-pencil" /><span class="project-editor-banner-text">{{ t('正在编辑') }}</span>
        <UButton :label="t('保存')" size="xs" :loading="tab.edit.saving" @click="save_edit" />
        <UButton :label="t('放弃修改')" color="neutral" variant="ghost" size="xs" :disabled="tab.edit.saving" @click="cancel_edit" />
      </div>
      <p v-else-if="preview?.truncated && !(format === 'html' && tab?.page && !source) && !(media_kind && !source) && !office_kind" class="project-editor-banner"><UIcon name="i-lucide-info" />{{ t('文件较大，仅显示前 {value1}（共 {value2}）', { value1: file_size(preview.limit), value2: file_size(preview.size) }) }}<template v-if="format === 'html'">{{ t('，HTML 不渲染不完整的内容') }}</template></p>
      <p v-else-if="html_notice && !source" class="project-editor-banner" :title="html_notice"><UIcon name="i-lucide-info" /><span class="project-editor-banner-text">{{ html_notice }}</span></p>

      <div ref="editor_body" class="project-editor-body" :style="{ '--file-font-scale': font_scale }">
        <PreviewLoading v-if="tab?.loading && !preview" :label="tab?.attachment &amp;&amp; !tab.attachment.url ? t('正在读取附件…') : t('正在读取文件…')" />
        <div v-else-if="tab?.error && !preview" class="project-editor-state"><UIcon name="i-lucide-circle-alert" /><p>{{ tab.error }}</p><UButton :label="t('重试')" color="neutral" variant="outline" class="pb-action" size="sm" @click="load(tab)" /></div>
        <template v-else-if="media_kind && !source">
          <div v-if="tab.media_error" class="project-editor-state"><UIcon name="i-lucide-circle-alert" /><p>{{ tab.media_error }}</p><UButton :label="t('重试')" color="neutral" variant="outline" class="pb-action" size="sm" @click="load(tab)" /></div>
          <MediaViewer v-else-if="tab.media" :kind="media_kind" :url="tab.media.url" :name="preview_name" />
          <PreviewLoading v-else :label="tab.media_progress ? t('正在经电脑读取… {value1}%', { value1: Math.round(tab.media_progress * 100) }) : t('正在打开…')" :progress="tab.media_progress || 0" />
        </template>
        <template v-else-if="office_kind">
          <div v-if="tab.media_error" class="project-editor-state"><UIcon name="i-lucide-circle-alert" /><p>{{ tab.media_error }}</p><UButton :label="t('重试')" color="neutral" variant="outline" class="pb-action" size="sm" @click="load(tab)" /></div>
          <OfficeViewer v-else-if="tab.media" :kind="office_kind" :url="tab.media.url" :scale="font_scale" />
          <PreviewLoading v-else :label="tab.media_progress ? t('正在经电脑读取… {value1}%', { value1: Math.round(tab.media_progress * 100) }) : t('正在打开…')" :progress="tab.media_progress || 0" />
        </template>
        <div v-else-if="preview?.text === null" class="project-editor-state"><UIcon :name="preview_type[1]" /><p>{{ preview.reason || t('这个格式只能下载后用本机软件打开') }}</p></div>
        <textarea v-else-if="tab?.edit" v-model="tab.edit.text" class="project-code-editor" spellcheck="false" :aria-label="t('文件内容')" @keydown.ctrl.s.prevent="save_edit" @keydown.meta.s.prevent="save_edit"></textarea>
        <div v-else-if="showing_source && wrap" ref="code_scroll" class="project-code is-wrapped" tabindex="0" @scroll.passive="schedule_offer" @click="open_mark_at" :aria-label="t('文件内容')" :style="{ '--digits': String(line_count).length }">
          <div v-for="(line, index) in lines" :key="index" class="project-code-row" :data-line="index + 1"><span class="project-code-number" aria-hidden="true">{{ index + 1 }}</span><span class="project-code-line">{{ line }}</span></div>
          <button v-for="mark in file_marks" :key="mark.id" type="button" class="excerpt-mark" :style="{ left: `${mark.left}px`, top: `${mark.top}px` }" :title="t('注释 {value1}：点击修改批注', { value1: mark.number })" :aria-label="t('修改注释 {value1} 的批注', { value1: mark.number })" @click="open_mark(mark.id)">{{ mark.number }}</button>
        </div>
        <div v-else-if="showing_source" ref="code_scroll" v-keep-reading class="project-code" tabindex="0" @scroll.passive="schedule_offer" @click="open_mark_at" :aria-label="t('文件内容')">
          <pre class="project-code-gutter" aria-hidden="true">{{ gutter }}</pre>
          <pre class="project-code-text"><code ref="code_text">{{ preview.text }}</code></pre>
          <button v-for="mark in file_marks" :key="mark.id" type="button" class="excerpt-mark" :style="{ left: `${mark.left}px`, top: `${mark.top}px` }" :title="t('注释 {value1}：点击修改批注', { value1: mark.number })" :aria-label="t('修改注释 {value1} 的批注', { value1: mark.number })" @click="open_mark(mark.id)">{{ mark.number }}</button>
        </div>
        <div v-else-if="preview && format === 'table'" class="project-table-scroll" tabindex="0" :aria-label="t('表格内容')">
          <p v-if="table.cut" class="project-table-note">{{ t('只显示前 {value1} 行，完整内容见源码。', { value1: table.rows.length }) }}</p>
          <table class="project-table"><tbody>
            <tr v-for="(row, index) in table.rows" :key="index" :class="{ 'is-head': index === 0 }"><td class="project-table-number">{{ index + 1 }}</td><td v-for="(cell, column) in row" :key="column">{{ cell }}</td></tr>
          </tbody></table>
        </div>
        <div v-else-if="preview && format === 'subtitle'" class="project-table-scroll" tabindex="0" :aria-label="t('字幕时间轴')">
          <p v-if="!cues.length" class="project-table-note">{{ t('没有识别出字幕条目，请切换到源码查看。') }}</p>
          <table v-else class="project-table is-subtitle"><thead><tr><th>#</th><th>{{ t('开始') }}</th><th>{{ t('结束') }}</th><th>{{ t('内容') }}</th></tr></thead><tbody>
            <tr v-for="(cue, index) in cues" :key="index"><td class="project-table-number">{{ index + 1 }}</td><td>{{ cue.start }}</td><td>{{ cue.end }}</td><td class="is-text">{{ cue.text }}</td></tr>
          </tbody></table>
        </div>
        <PreviewLoading v-else-if="preview && format === 'html' && tab?.loading && !tab.page" :label="t('正在载入页面引用的文件…')" />
        <iframe v-else-if="preview && format === 'html'" ref="html_frame" class="project-html-preview" :class="{ 'is-themed-attachment': tab?.attachment }"
          :sandbox="HTML_SANDBOX" referrerpolicy="no-referrer" :srcdoc="html_preview" :title="t('HTML 文件预览')" @load="apply_attachment_theme"></iframe>
        <div v-else-if="preview" ref="markdown_scroll" v-keep-reading class="project-markdown-scroll" tabindex="0" @scroll.passive="schedule_offer" @scroll.capture.passive="follow_inner_scroll" @click="open_mark_at"
          @wheel.passive="stop_following" @touchmove.passive="stop_following" @keydown="stop_following" @pointerdown="stop_following"><div ref="markdown_body" class="markdown-body project-markdown-preview" v-html="rendered"></div>
          <button v-for="mark in file_marks" :key="mark.id" type="button" class="excerpt-mark" :style="{ left: `${mark.left}px`, top: `${mark.top}px` }" :title="t('注释 {value1}：点击修改批注', { value1: mark.number })" :aria-label="t('修改注释 {value1} 的批注', { value1: mark.number })" @click="open_mark(mark.id)">{{ mark.number }}</button></div>
        <ExcerptEditCard v-if="mark_editing" :key="mark_editing.excerpt.id" class="file-selection-offer file-comment" :class="{ 'is-docked': mark_editing.touch }" :comment="mark_editing.excerpt.comment" :style="mark_editing.touch ? {} : { left: `${mark_editing.left}px`, top: `${mark_editing.top}px` }"
          @save="save_mark" @cancel="close_mark" @remove="remove_mark" />

        <div v-if="offer && !offer.touch" class="file-selection-offer file-offer-marks" :style="{ left: `${offer.left}px`, top: `${offer.top}px` }">
          <button type="button" class="channel-listen-mark" :title="t('把选中的文字作为注释添加到对话')" @mousedown.prevent @click="start_comment"><UIcon name="i-lucide-message-square-quote" />{{ t('添加到对话') }}</button>
          <button v-if="can_read" type="button" class="channel-listen-mark" :title="t('从选中处开始朗读')" :aria-label="t('从选中处开始朗读')" @mousedown.prevent @click="listen_from_selection"><UIcon name="i-lucide-headphones" />{{ t('听当前') }}</button>
        </div>
        <form v-if="commenting" v-float-box class="file-selection-offer selection-comment file-comment" :class="{ 'is-docked': commenting.touch }"
          :style="commenting.touch ? {} : { left: `${commenting.left}px`, top: `${commenting.top}px` }" @submit.prevent="add_excerpt">
          <textarea ref="comment_input" v-model="comment" rows="1" :placeholder="t('添加批注（可选）')" :aria-label="t('注释的批注（可选）')" enterkeyhint="send" @keydown="comment_keydown"></textarea>
          <div class="selection-comment-actions">
            <button type="button" class="selection-comment-cancel" :aria-label="t('取消添加')" :title="t('取消')" @click="cancel_comment"><UIcon name="i-lucide-x" /></button>
            <button type="submit" class="selection-comment-send" :aria-label="t('添加到对话')" :title="t('添加到对话（Enter）')"><UIcon name="i-lucide-arrow-up" /></button>
          </div>
        </form>
        <div v-if="(offer?.touch && !commenting) || reader.state.message_id" class="file-listen-dock">
          <button v-if="offer?.touch" type="button" class="channel-listen-pill file-selection-offer" @mousedown.prevent @click="start_comment"><UIcon name="i-lucide-message-square-quote" />{{ t('添加到对话') }}</button>
          <button v-if="offer?.touch && can_read" type="button" class="channel-listen-pill file-selection-offer" :aria-label="t('从选中处开始朗读')" @mousedown.prevent @click="listen_from_selection"><UIcon name="i-lucide-headphones" />{{ t('听当前') }}</button>
          <span v-if="reader.state.message_id && reader.state.loading" class="channel-listen-pill" role="status"><UIcon name="i-lucide-loader-circle" class="animate-spin" />{{ t('加载中') }}</span>
          <button v-else-if="reader.state.message_id" type="button" class="channel-listen-pill" :class="{ 'is-on': reader.state.following }" :aria-pressed="reader.state.following"
            :title="reader.state.following ? t('手动滚动即取消跟随') : t('页面跟随朗读位置滚动')" @click="reader.state.following ? (reader.state.following = false) : reader.follow()"><UIcon name="i-lucide-locate-fixed" />{{ reader.state.following ? t('跟随中') : t('跟随') }}</button>
          <button v-if="reader.state.reading" type="button" class="channel-listen-pill" :aria-label="t('停止朗读')" @click="reader.stop()"><UIcon name="i-lucide-square" />{{ t('停止') }}</button>
        </div>
      </div>

      <footer class="project-editor-status">
        <span v-if="preview" class="project-editor-modified" :title="preview.modified_at">{{ t('修改于 {value1}', { value1: modified_time(preview.modified_at) }) }}</span>
        <span class="project-editor-status-spacer"></span>
        <template v-if="preview?.text != null">
          <span>{{ t('{value1} 行', { value1: line_count }) }}</span><span class="project-editor-encoding">{{ encoding_label }}</span>
        </template>
        <span v-if="preview">{{ file_size(preview.size) }}</span>
        <span>{{ preview_type[0] }}</span>
      </footer>
     </div>
    </template>
  </UModal>

  <!-- Folded: a floating button on a screen edge, over every channel and room, until the files are closed. -->
  <Teleport to="body">
    <div v-if="tabs.length && !open" class="file-float" :class="{ 'is-right': float_side === 'right' && !float_drag_place, 'is-dragging': float_drag_place }" :style="float_style"
      @pointerdown="float_press" @pointermove="float_move" @pointerup="float_release" @pointercancel="float_release" @click.capture="float_click">
      <button type="button" class="file-float-open" :title="tabs.length > 1 ? t('回到文件预览（{value1} 个文件）', { value1: tabs.length }) : t('回到文件预览：{value1}', { value1: preview_name })" @click="unfold">
        <UIcon :name="preview_type[1]" class="project-file-icon" :class="preview_type[2]" /><span class="file-float-name">{{ preview_name }}</span>
        <span v-if="tabs.length > 1" class="file-float-count">{{ tabs.length }}</span>
      </button>
      <button type="button" class="file-float-close" :aria-label="t('关闭全部文件预览')" :title="t('关闭')" @click="close_all"><UIcon name="i-lucide-x" /></button>
    </div>
  </Teleport>
</template>

<style scoped>
/* Preview: a VS Code editor group — tab strip, breadcrumbs, gutter + text, status bar. */
/* Centered by margins, not the modal's -50% translate, which lands on half pixels and blurs the text. */
:global(.project-editor) { display: flex; flex-direction: column; width: min(1120px, calc(100vw - 48px)); max-width: none; height: calc(100dvh - 64px); max-height: none; overflow: visible;
  inset: 0; margin: auto; --tw-translate-x: 0 !important; --tw-translate-y: 0 !important;
  padding: 0; border: 0; border-radius: 0; background: transparent; box-shadow: none; }
/* The window itself, moved and scaled as a whole when it folds into the floating button or is pulled down. */
.project-editor-frame { display: flex; flex: 1; flex-direction: column; min-height: 0; overflow: hidden; border: 1px solid var(--ui-border-accented); border-radius: 10px;
  background: var(--ui-bg); box-shadow: 0 24px 80px #0000008c; }
/* Split pane: the full height of the window's right side, joined to the messages by a line that can be dragged. */
:global(.project-editor.is-docked) { inset: 0 0 0 auto; width: var(--file-dock-width); height: 100dvh; margin: 0; }
.project-editor-frame.is-docked { position: relative; border-width: 0 0 0 1px; border-color: var(--ui-border); border-radius: 0; box-shadow: none; }
.file-dock-resizer { position: absolute; inset: 0 auto 0 0; z-index: 6; width: 6px; cursor: col-resize; touch-action: none; transition: background .12s; }
.file-dock-resizer:hover, .file-dock-resizer:active, .file-dock-resizer:focus-visible { outline: none; background: var(--ui-primary); }
/* Head: tabs, the file's actions and the window's on one row, breadcrumbs under them; narrow screens fold the file's
   actions into a "..." menu beside the window buttons. */
.project-editor-head { display: grid; flex-shrink: 0; grid-template-columns: minmax(0, 1fr) auto auto; grid-template-rows: 38px 26px;
  grid-template-areas: "tabs file window" "crumbs crumbs crumbs"; }
.project-editor-head > :is(.project-editor-tablist, .project-editor-file-actions, .project-editor-window-actions) { background: var(--ui-bg-elevated); border-bottom: 1px solid var(--ui-border); }
.project-editor-head.is-tight { grid-template-rows: 38px minmax(30px, auto); grid-template-areas: "tabs tabs window" "crumbs file file"; }
.project-editor-head.is-tight > .project-editor-file-actions { justify-content: flex-end; padding-right: 6px; border-left: 0; background: transparent; border-bottom: 0; }
.project-editor-tablist { grid-area: tabs; display: flex; min-width: 0; overflow-x: auto; overflow-y: hidden; overscroll-behavior-x: contain; scrollbar-width: none; }
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
.project-editor-file-actions, .project-editor-window-actions { display: flex; align-items: center; gap: 6px; }
.project-editor-file-actions { grid-area: file; padding-left: 6px; border-left: 1px solid var(--ui-border); }
.project-editor-file-actions:empty { display: none; }
.project-editor-window-actions { grid-area: window; padding: 0 6px; }
.project-editor-file-actions:empty + .project-editor-window-actions { border-left: 1px solid var(--ui-border); }
.project-editor-modes { display: flex; padding: 2px; border-radius: 6px; background: var(--ui-bg-accented); }
.project-editor-modes button { display: inline-flex; align-items: center; gap: 5px; height: 24px; padding: 0 9px; border-radius: 4px; font-size: 12px; color: var(--ui-text-muted); cursor: pointer; }
.project-mode-icon { flex-shrink: 0; width: 14px; height: 14px; }
.project-editor-font { display: flex; align-items: center; }
.project-editor-font button { display: grid; place-items: center; height: 28px; min-width: 26px; padding: 0 4px; border-radius: 5px; font-size: 11.5px; color: var(--ui-text-muted); cursor: pointer; font-variant-numeric: tabular-nums; }
.project-editor-font button > span { width: 16px; height: 16px; }
.project-editor-font button:hover:not(:disabled) { background: var(--ui-bg-accented); color: var(--ui-text); }
.project-editor-font button:disabled { opacity: .4; cursor: default; }
.project-editor-font-value { min-width: 40px !important; }
.project-editor-modes button:hover { color: var(--ui-text); }
.project-editor-modes button[aria-pressed="true"] { background: var(--ui-bg); color: var(--ui-text-highlighted); box-shadow: 0 1px 2px #0000003d; }
.project-editor-breadcrumbs { grid-area: crumbs; display: flex; flex-wrap: nowrap; align-items: center; gap: 2px; min-width: 0; padding: 0 14px; overflow-x: auto; scrollbar-width: none; font-size: 12px; color: var(--ui-text-muted); }
.project-editor-breadcrumbs > * { flex-shrink: 0; }
.project-editor-breadcrumbs button { padding: 1px 4px; border-radius: 4px; white-space: nowrap; cursor: pointer; }
.project-editor-breadcrumbs button:hover { background: var(--ui-bg-accented); color: var(--ui-text); }
.project-editor-breadcrumbs > span:not(.project-crumb-separator) { display: inline-flex; align-items: center; gap: 5px; padding: 1px 4px; white-space: nowrap; color: var(--ui-text); }
.project-editor-breadcrumbs .project-file-icon { width: 14px; height: 14px; }
.project-editor-banner { display: flex; align-items: center; gap: 8px; flex-shrink: 0; margin: 0; padding: 6px 14px; font-size: 12px; color: var(--ui-text-muted);
  background: color-mix(in srgb, var(--ui-primary) 9%, transparent); border-block: 1px solid color-mix(in srgb, var(--ui-primary) 22%, transparent); }
.project-editor-banner > span { flex-shrink: 0; width: 14px; height: 14px; color: var(--ui-primary); }
.project-editor-banner > .project-editor-banner-text { flex: 1; width: auto; height: auto; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: inherit; }
.project-editor-body { position: relative; flex: 1; min-height: 0; display: flex; border-top: 1px solid var(--ui-border); }
.project-editor-state { display: flex; flex: 1; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 24px; text-align: center; font-size: 13px; color: var(--ui-text-muted); }
.project-editor-state > span:first-child { width: 28px; height: 28px; color: var(--ui-text-dimmed); }
.project-editor-state p { margin: 0; max-width: 480px; }
.project-code { position: relative; display: flex; flex: 1; align-items: flex-start; min-width: 0; overflow: auto; tab-size: 4;
  font: calc(13px * var(--file-font-scale, 1))/calc(20px * var(--file-font-scale, 1)) ui-monospace, "Cascadia Code", Consolas, monospace; }
.project-code:focus-visible, .project-markdown-scroll:focus-visible { outline: none; }
.project-code pre { margin: 0; padding: 10px 0 24px; white-space: pre; font: inherit; }
.project-code-gutter { position: sticky; left: 0; z-index: 1; flex-shrink: 0; min-width: 52px; padding-inline: 16px 14px !important; text-align: right; color: var(--ui-text-dimmed); background: var(--ui-bg); user-select: none; }
.project-code-text { flex: 1; padding-right: 32px !important; color: var(--ui-text); }
.project-code-editor { display: block; width: 100%; height: 100%; padding: 12px 16px; border: 0; outline: none; resize: none; background: transparent; color: var(--ui-text);
  font: calc(13px * var(--file-font-scale, 1)) / 1.6 ui-monospace, Consolas, monospace; tab-size: 4; white-space: pre; overflow: auto; }
.project-editor-banner.is-editing { gap: 8px; }
/* Wrapped: one row per source line keeps each number level with the first visual row of its line. */
.project-code.is-wrapped { display: block; padding: 10px 0 24px; }
.project-code-row { display: flex; }
.project-code-number { flex-shrink: 0; box-sizing: content-box; width: calc(var(--digits) * 1ch); min-width: 2ch; padding: 0 14px 0 16px; text-align: right; color: var(--ui-text-dimmed); user-select: none; }
.project-code-line { flex: 1; min-width: 0; padding-right: 20px; color: var(--ui-text); white-space: pre-wrap; overflow-wrap: anywhere; }
.project-markdown-scroll { position: relative; flex: 1; min-width: 0; overflow: auto; }
/* Positioned and isolated so the read-aloud highlight layer sits under the text, as in a message card. */
.project-markdown-preview { position: relative; isolation: isolate; max-width: 860px; margin: 0 auto; padding: 28px 40px 48px; overflow-wrap: anywhere; font-size: calc(15px * var(--file-font-scale, 1)); line-height: 1.8; }
/* Selection offers and read-aloud controls stay inside the dialog: under the selection with a pointer, in a bottom dock otherwise. */
.file-offer-marks { position: absolute; z-index: 4; display: flex; gap: 6px; }
.file-offer-marks .channel-listen-mark { position: static; }
/* The shared comment box (channel.css), placed inside the dialog instead of on the page. */
.file-comment { position: absolute; z-index: 4; max-width: calc(100% - 16px); }
.file-comment.is-docked { inset: auto 0 0; max-width: none; padding-bottom: calc(var(--keyboard-inset, 0px) + 12px); }
.file-listen-dock { position: absolute; inset: auto 0 12px; z-index: 3; display: flex; justify-content: center; gap: 8px; pointer-events: none; }
.project-html-preview { display: block; flex: 1; width: 100%; border: 0; background: white; }
.project-html-preview.is-themed-attachment { box-sizing: border-box; padding: 16px 20px; background: var(--ui-bg-elevated); }
.project-editor-status { display: flex; align-items: center; gap: 16px; flex-shrink: 0; height: 26px; padding: 0 14px; font-size: 11.5px; color: var(--ui-text-muted);
  background: var(--ui-bg-elevated); border-top: 1px solid var(--ui-border); font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; }
.project-editor-status-spacer { flex: 1; }

/* Folded window: stuck to the screen's right edge by default, below the room header, like a mini-program's floating window. */
.file-float { position: fixed; z-index: 45; display: flex; align-items: center; height: 40px; padding: 0 4px 0 12px; border: 1px solid var(--ui-border-accented);
  border-left: 0; border-radius: 0 999px 999px 0; background: var(--ui-bg-elevated); box-shadow: 0 6px 20px #0006; animation: file-float-in .2s ease-out;
  touch-action: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; }
@keyframes file-float-in { from { opacity: 0; transform: translateX(-12px); } }
.file-float.is-right { border-left: 1px solid var(--ui-border-accented); border-right: 0; border-radius: 999px 0 0 999px; animation-name: file-float-in-right; }
.file-float.is-dragging { border: 1px solid var(--ui-border-accented); border-radius: 999px; animation: none; cursor: grabbing; }
@keyframes file-float-in-right { from { opacity: 0; transform: translateX(12px); } }
.file-float-open { display: flex; align-items: center; gap: 7px; height: 100%; max-width: 200px; font-size: 13px; color: var(--ui-text-highlighted); cursor: pointer; }
.file-float-name { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.file-float-count { flex-shrink: 0; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px; background: var(--ui-primary); color: var(--ui-bg); font-size: 11px; line-height: 18px; text-align: center; }
.file-float-close { display: grid; place-items: center; width: 26px; height: 26px; margin-left: 2px; border-radius: 50%; color: var(--ui-text-dimmed); cursor: pointer; }
.file-float-close > span { width: 14px; height: 14px; }
.file-float-close:hover { background: var(--ui-bg-accented); color: var(--ui-text); }

@media (max-width: 640px) {
  :global(.project-editor) { width: 100vw; height: 100dvh; }
  .project-editor-frame { border: 0; border-radius: 0; }
  .project-editor-tab-name { padding-left: 10px; }
  /* The tabs get the whole first row (user 2026-11-20, #6131): the "..." menu and fold button sit at the right of the
     breadcrumbs, which seldom fill their row. The file's actions live in that menu. */
  .project-editor-head { grid-template-columns: minmax(0, 1fr) auto; grid-template-rows: 42px 40px; grid-template-areas: "tabs tabs" "crumbs window"; }
  .project-editor-head > .project-editor-window-actions { background: transparent; border-bottom: 0; }
  .project-editor-window-actions { gap: 4px; padding: 0 4px; border-left: 0 !important; }
  /* 40px touch targets; the file name is already on its tab, so the breadcrumbs end at its folder. */
  .project-editor-window-actions > button { justify-content: center; width: 40px; height: 40px; padding: 0; }
  /* Each folder fills the row's height, so it is a full touch target rather than its text line. */
  .project-editor-breadcrumbs { gap: 0; padding: 0 6px; font-size: 13px; }
  .project-editor-breadcrumbs button { height: 40px; padding: 0 8px; }
  .project-crumb-file, .project-editor-breadcrumbs > .project-crumb-separator:nth-last-child(2) { display: none !important; }
  .project-markdown-preview { padding: 18px 16px 32px; }
  .project-code { font-size: calc(12px * var(--file-font-scale, 1)); line-height: calc(18px * var(--file-font-scale, 1)); }
  .project-code-gutter { min-width: 40px; padding-inline: 10px !important; }
  .project-code-number { padding: 0 10px; }
  .project-editor-modified, .project-editor-encoding { display: none; }
  .file-float-name { display: none; }
  .file-float-close { display: none; }
  .file-float { padding-right: 10px; }
}
/* A phone on its side is wide but short: the window fills the screen as in portrait instead of floating with margins
   around it (user 2026-11-16: "横屏区域本来就很小"); the sides keep clear of the notch. */
/* Phone tabs, either way up: one open file shows its whole name; of several, the open one gets most of the row and the
   others a short name each. Only the open tab has a close button (a phone has no hover): tap a tab, then its ×. */
@media (max-width: 640px), (pointer: coarse) and (max-height: 500px) {
  .project-editor-tab { max-width: 60%; }
  .project-editor-tab:only-child { max-width: 100%; }
  .project-editor-tab:not(.is-active) { max-width: 100px; }
  .project-editor-tab:not(.is-active) .project-editor-tab-close { display: none; }
  .project-editor-tab:not(.is-active) .project-editor-tab-name { padding-right: 12px; }
  .project-editor-tab.is-active .project-editor-tab-close { width: 32px; height: 32px; margin-right: 4px; opacity: 1; }
}
@media (pointer: coarse) and (max-height: 500px) {
  :global(.project-editor) { width: 100vw; height: 100dvh; }
  .project-editor-frame { border: 0; border-radius: 0; box-shadow: none; padding-inline: env(safe-area-inset-left) env(safe-area-inset-right); }
  /* One 40px row of tabs and window buttons, then a slim breadcrumb row: the height is the text's. */
  .project-editor-head { grid-template-rows: 40px 28px; }
  .project-editor-head .project-editor-window-actions > button { justify-content: center; width: 40px; height: 40px; padding: 0; }
}
/* Tablets keep the one-row head, with touch-sized buttons (a phone on its side, as wide but short, has its own rules above). */
@media (min-width: 641px) and (min-height: 501px) and (pointer: coarse) {
  .project-editor-head { grid-template-rows: 44px 30px; }
  .project-editor-head.is-tight { grid-template-rows: 44px 44px; }
  .project-editor-head :is(.project-editor-file-actions, .project-editor-window-actions) > button { justify-content: center; width: 40px; height: 40px; padding: 0; }
  .project-editor-modes button { height: 36px; padding: 0 12px; }
  .project-editor-font button { height: 40px; min-width: 36px; }
  .project-editor-tab-close { width: 28px; height: 28px; opacity: 1; }
}
</style>

<style>
/* Where the preview can switch, one window serves both places, so the floating window dims the page itself and the dimming
   fades as it moves into the split pane. It also keeps clicks off the page behind the floating window. */
.project-editor.is-switchable::before { content: ""; position: absolute; inset: -200vmax; z-index: -1; background: #000000a6; transition: opacity .24s ease; }
.project-editor.is-switchable.is-docked::before { opacity: 0; pointer-events: none; }
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
.project-table-scroll { height: 100%; overflow: auto; }
.project-table-note { margin: 0; padding: 6px 12px; color: var(--ui-text-muted); font-size: 12px; }
.project-table { border-collapse: collapse; font-size: calc(13px * var(--file-font-scale, 1)); }
.project-table td, .project-table th { padding: 3px 10px; border: 1px solid var(--ui-border); white-space: nowrap; text-align: left; vertical-align: top; }
.project-table tr.is-head td, .project-table th { position: sticky; top: 0; z-index: 1; font-weight: 600; background: var(--ui-bg-elevated); }
.project-table .project-table-number { color: var(--ui-text-dimmed); text-align: right; user-select: none; }
.project-table.is-subtitle .is-text { white-space: pre-wrap; min-width: 240px; }
/* Reading a document, not a chat message: roomier lines and headings set apart from the text (2026-11-17, #4335). */
.project-markdown-preview :is(h1, h2, h3, h4, h5, h6) { margin: 1.8em 0 .7em; line-height: 1.35; color: var(--ui-text-highlighted); letter-spacing: .01em; }
.project-markdown-preview > :is(h1, h2, h3):first-child { margin-top: 0; }
.project-markdown-preview h1 { font-size: 1.75em; font-weight: 700; padding-bottom: .35em; border-bottom: 1px solid var(--markdown-line); }
.project-markdown-preview h2 { font-size: 1.4em; padding-bottom: .3em; border-bottom: 1px solid color-mix(in srgb, var(--markdown-line) 60%, transparent); }
.project-markdown-preview h3 { font-size: 1.18em; }
.project-markdown-preview p { margin: 0 0 1em; }
.project-markdown-preview li { margin: .4em 0; }
.project-markdown-preview code { font-family: "Cascadia Code", ui-monospace, Consolas, "Microsoft YaHei", monospace; font-size: .86em; }
.project-markdown-preview pre { line-height: 1.65; }
</style>

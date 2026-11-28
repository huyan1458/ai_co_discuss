/**
 * What the file list, the floating file preview and the composer share within one room: the preview's entry points and
 * the excerpts quoted from project files for the next message.
 */
import { reactive } from "vue";
import { locale, t } from './i18n.js';

export const ATTACHMENT_TEXT_LIMIT = 2 * 1024 * 1024;
// Scripts run in an opaque origin, including when the preview is opened in a new tab.
export const HTML_SANDBOX = "allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals";

// A sandboxed page runs as an opaque origin, where reading localStorage or sessionStorage throws and a page relying on
// them stops at its first line (2026-11-26 user #12484: a review page showed only its header). This puts a storage kept
// in memory in their place, so the page works; what it saves lasts until the preview closes.
const STORAGE_STANDIN = '<script>(()=>{for(const name of ["localStorage","sessionStorage"]){try{window[name].length;continue;}catch{}'
  + "const data=new Map();const store={get length(){return data.size},key:(i)=>[...data.keys()][i]??null,"
  + "getItem:(k)=>data.has(String(k))?data.get(String(k)):null,setItem:(k,v)=>{data.set(String(k),String(v));},"
  + "removeItem:(k)=>{data.delete(String(k));},clear:()=>{data.clear();}};"
  + "try{Object.defineProperty(window,name,{value:store,configurable:true});}catch{}}})();</script>";

/** Wrap preview source without putting the UTF-8 declaration before its doctype. */
export function html_document(text, extra = "") {
  const doctype = /^\uFEFF?\s*<!doctype[^>]*>/i.exec(text)?.[0] || "";
  return `${doctype}<meta charset="utf-8">${STORAGE_STANDIN}${extra}${text.slice(doctype.length)}`;
}

/**
 * Read an attachment as UTF-8 text, retaining enough metadata for a truncated source preview. The source view shows at
 * most ATTACHMENT_TEXT_LIMIT; a larger HTML file is already downloaded whole, so its full text is returned as `page`
 * for rendering and opening in a new tab.
 */
export async function read_attachment(attachment, html = false) {
  const response = await fetch(attachment.url);
  if (!response.ok) throw new Error(t('附件读取失败（{value1}）', { value1: response.status }));
  const blob = await response.blob();
  const truncated = blob.size > ATTACHMENT_TEXT_LIMIT;
  const text = new TextDecoder("utf-8").decode(await (truncated ? blob.slice(0, ATTACHMENT_TEXT_LIMIT) : blob).arrayBuffer());
  const page = truncated && html ? { text: new TextDecoder("utf-8").decode(await blob.arrayBuffer()) } : null;
  return { text, truncated, limit: ATTACHMENT_TEXT_LIMIT, size: blob.size, modified_at: attachment.created_at, encoding: "utf-8", page };
}

/**
 * `open(path, directory, root)` is set by the preview while it is mounted (`root` is the index of the room's project
 * directory the path is in, 0 for the main one); `reveal_path` is a folder of directory `reveal_root` the file list should show next (it
 * may not be shown yet); `excerpts` are `{ id, path, name, start, end, text, comment }` waiting in the composer;
 * `focus_composer` counts requests to focus it; `dock_width` is the width in pixels the preview takes beside the messages
 * as a split pane, 0 while it is not docked.
 */
// `reveal_root` is a room directory's index or an account folder's id (named by `reveal_name`).
// `visual_results`: whether the shown room takes a visual panel's result into its composer (not on a share page or a
// room being destroyed), set by the room view.
export const file_preview = reactive({ open: null, open_visual: null, visual_results: false, reveal_path: null, reveal_root: 0, reveal_name: "", excerpts: [], focus_composer: 0, dock_width: 0 });
/** Unsent file cards and excerpts of the rooms not open now, by room ID (ChannelDiscussion), kept until this page closes. */
export const room_quotes = new Map();
let excerpt_serial = 0;
// Name of the CSS highlight that keeps a selection visible while its comment is typed.
const PENDING_HIGHLIGHT = "excerpt-pending";

/**
 * Put one excerpt in the composer and focus it. A quote from a message carries `message_id` (its `path` is `#id`);
 * `from`/`to` are where it lies in its rendered text, for its number mark and highlighting it again.
 * @param {object} excerpt `{ path, name, start, end, text, comment, from, to, message_id? }` without an id.
 */
export function add_excerpt(excerpt) {
  file_preview.excerpts.push({ ...excerpt, id: ++excerpt_serial });
  file_preview.focus_composer++;
}

/**
 * Put a visual panel's result above the composer as a quote of its message, replacing that panel's earlier result.
 * Sent as a quote, its text can neither call members nor run a room command. The composer is not focused, so a phone
 * keyboard does not open on its own. Returns "added" or "replaced".
 */
export function put_visual_result(visual, text) {
  const excerpt = { name: visual.author, message_id: visual.message_id, path: `#${visual.message_id}`, text, comment: "", visual_key: visual.id };
  const index = file_preview.excerpts.findIndex((item) => item.visual_key === visual.id);
  if (index < 0) {
    file_preview.excerpts = [...file_preview.excerpts, { ...excerpt, id: ++excerpt_serial }];
    return "added";
  }
  file_preview.excerpts = file_preview.excerpts.map((item, position) => position === index ? { ...item, text } : item);
  return "replaced";
}

/** Where an excerpt came from, as the composer's list shows it. */
export function excerpt_source(excerpt) {
  if (excerpt.message_id) return `${excerpt.name} #${excerpt.message_id}`;
  const lines = !excerpt.start ? "" : excerpt.start === excerpt.end ? t('第 {value1} 行', { value1: excerpt.start }) : t('第 {value1}–{value2} 行', { value1: excerpt.start, value2: excerpt.end });
  return lines ? `${excerpt.path} · ${lines}` : excerpt.path;
}

/** Characters of `root`'s text before a point inside it. */
export function text_offset(root, node, offset) {
  const range = document.createRange();
  range.setStart(root, 0);
  range.setEnd(node, offset);
  return range.toString().length;
}

/**
 * Whether a box scrolled sideways inside `root` (a wide table, a code block) has moved the point at viewport `x`
 * of `node` out of what it shows, so a number mark there would float over other content.
 */
export function scrolled_out(node, root, x) {
  for (let box = node.parentElement; box && box !== root; box = box.parentElement) {
    if (box.scrollWidth <= box.clientWidth || getComputedStyle(box).overflowX === "visible") continue;
    const shown = box.getBoundingClientRect();
    if (x < shown.left || x > shown.right + 1) return true;
  }
  return false;
}

/**
 * Run `place` once per frame while a box inside `host` scrolls (scroll events do not bubble, so this listens in the
 * capture phase); `host`'s own scrolling is left to the caller.
 * @returns {(event: Event) => void} The scroll listener to add to `host` with `{ capture: true, passive: true }`.
 */
export function inner_scroll_follower(place) {
  let frame = 0;
  return (event) => {
    if (event.target === event.currentTarget || frame) return;
    frame = requestAnimationFrame(() => { frame = 0; place(); });
  };
}

/**
 * Where the character ending at `end` of `root`'s text sits, relative to `host`'s content (scrolled hosts included),
 * for an excerpt's number mark; null when that text is not shown.
 */
export function excerpt_mark_place(root, host, end) {
  if (!root || !host || !(end > 0)) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(), left = end; node; node = walker.nextNode()) {
    if (left > node.length) { left -= node.length; continue; }
    const range = document.createRange();
    range.setStart(node, left - 1);
    range.setEnd(node, left);
    const rects = range.getClientRects(), rect = rects[rects.length - 1];
    if (!rect || scrolled_out(node, root, rect.right)) return null;
    const origin = host.getBoundingClientRect();
    return { left: rect.right - origin.left + host.scrollLeft, top: rect.top - origin.top + host.scrollTop };
  }
  return null;
}

/** The range covering characters `from`–`to` of `root`'s text, to show a quoted passage again; null when not shown. */
export function excerpt_range(root, from, to) {
  if (!root || !(to > from)) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let seen = 0, started = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!started && from <= seen + node.length) { range.setStart(node, from - seen); started = true; }
    if (started && to <= seen + node.length) { range.setEnd(node, to - seen); return range; }
    seen += node.length;
  }
  return null;
}

/** Keep `range` visibly selected while focus is in the comment box; null clears it. */
export function hold_selection(range) {
  if (!globalThis.CSS?.highlights || typeof Highlight !== "function") return;
  if (range) CSS.highlights.set(PENDING_HIGHLIGHT, new Highlight(range));
  else CSS.highlights.delete(PENDING_HIGHLIGHT);
}

// Listings of a project's folders (by project directory and path), kept in this browser's database so the file list shows
// at once, even after a reload (user 2026-11-18, #4585). Only names, sizes and times are kept, never file contents.
const LISTINGS_DATABASE = "codiscuss-folder-listings";
const LISTINGS_STORE = "listings";
const LISTINGS_SAVE_MS = 400;
const listings = new Map(), loaded_directories = new Map(), unsaved_listings = new Map();
let listings_database = null, listings_save_timer = 0;
// Listings used to live in localStorage, which is too small for a whole project.
try { localStorage.removeItem(LISTINGS_DATABASE); } catch { /* Nothing to clear. */ }

/** The browser's database of listings; rejects where storage is blocked, and the list then lasts for this page only. */
function open_listings() {
  listings_database ||= new Promise((resolve, reject) => {
    const request = indexedDB.open(LISTINGS_DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(LISTINGS_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return listings_database;
}

/** Write the listings changed since the last save together. */
async function save_listings() {
  listings_save_timer = 0;
  const changes = [...unsaved_listings];
  unsaved_listings.clear();
  try {
    const store = (await open_listings()).transaction(LISTINGS_STORE, "readwrite").objectStore(LISTINGS_STORE);
    for (const [key, listing] of changes) { if (listing) store.put(listing, key); else store.delete(key); }
  } catch { /* Kept in memory only. */ }
}

/** Remember a change and save it shortly, with those that follow it. */
function queue_listing(key, listing) {
  unsaved_listings.set(key, listing);
  listings_save_timer ||= setTimeout(save_listings, LISTINGS_SAVE_MS);
}

/** Read one project's saved listings into memory; anything read during this page's life stays newer. */
async function read_saved_listings(directory) {
  try {
    const store = (await open_listings()).transaction(LISTINGS_STORE).objectStore(LISTINGS_STORE);
    const range = IDBKeyRange.bound(`${directory}\n`, `${directory}\n￿`);
    const answer = (request) => new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const [keys, values] = await Promise.all([answer(store.getAllKeys(range)), answer(store.getAll(range))]);
    keys.forEach((key, index) => { if (!listings.has(key)) listings.set(key, values[index]); });
  } catch { /* Starts empty. */ }
}

export const folder_listings = {
  get: (key) => listings.get(key),
  set(key, listing) { listings.set(key, listing); queue_listing(key, listing); },
  delete(key) { listings.delete(key); queue_listing(key, null); },
  /** Make one project's saved listings available; asked again it answers at once. */
  load(directory) {
    if (!loaded_directories.has(directory)) loaded_directories.set(directory, read_saved_listings(directory));
    return loaded_directories.get(directory);
  },
};
// For this page's lifetime: the folder each room's list last showed (`{ directory, path }`).
export const shown_folders = new Map();

// Extension → [language label shown in the status bar, icon, icon tint]; unknown files fall back to plain text.
const FILE_TYPES = {
  md: ["Markdown", "i-lucide-file-text", "is-blue"], markdown: ["Markdown", "i-lucide-file-text", "is-blue"],
  html: ["HTML", "i-lucide-file-code", "is-orange"], htm: ["HTML", "i-lucide-file-code", "is-orange"],
  css: ["CSS", "i-lucide-file-code", "is-blue"], vue: ["Vue", "i-lucide-file-code", "is-green"],
  js: ["JavaScript", "i-lucide-file-code", "is-yellow"], mjs: ["JavaScript", "i-lucide-file-code", "is-yellow"], cjs: ["JavaScript", "i-lucide-file-code", "is-yellow"],
  ts: ["TypeScript", "i-lucide-file-code", "is-blue"], tsx: ["TypeScript", "i-lucide-file-code", "is-blue"], jsx: ["JavaScript", "i-lucide-file-code", "is-yellow"],
  py: ["Python", "i-lucide-file-code", "is-blue"], sql: ["SQL", "i-lucide-database", "is-orange"],
  sh: ["Shell", "i-lucide-file-terminal", "is-green"], ps1: ["PowerShell", "i-lucide-file-terminal", "is-blue"], bat: ["Batch", "i-lucide-file-terminal", "is-green"],
  json: ["JSON", "i-lucide-file-json", "is-yellow"], jsonc: ["JSON", "i-lucide-file-json", "is-yellow"],
  yaml: ["YAML", "i-lucide-file-cog", "is-purple"], yml: ["YAML", "i-lucide-file-cog", "is-purple"], toml: ["TOML", "i-lucide-file-cog", "is-purple"],
  png: [t('图片'), "i-lucide-file-image", "is-purple"], jpg: [t('图片'), "i-lucide-file-image", "is-purple"], jpeg: [t('图片'), "i-lucide-file-image", "is-purple"],
  gif: [t('图片'), "i-lucide-file-image", "is-purple"], webp: [t('图片'), "i-lucide-file-image", "is-purple"], svg: ["SVG", "i-lucide-file-image", "is-orange"],
  zip: [t('压缩包'), "i-lucide-file-archive", "is-muted"], pdf: ["PDF", "i-lucide-file-text", "is-red"], txt: [t('纯文本'), "i-lucide-file-text", "is-muted"],
  csv: [t('CSV 表格'), "i-lucide-sheet", "is-green"], tsv: [t('TSV 表格'), "i-lucide-sheet", "is-green"], xml: ["XML", "i-lucide-file-code", "is-orange"],
  ini: ["INI", "i-lucide-file-cog", "is-purple"], log: [t('日志'), "i-lucide-file-text", "is-muted"],
  docx: [t('Word 文档'), "i-lucide-file-text", "is-blue"], doc: [t('Word 文档（旧版）'), "i-lucide-file-text", "is-blue"],
  xlsx: [t('Excel 表格'), "i-lucide-sheet", "is-green"], xls: [t('Excel 表格（旧版）'), "i-lucide-sheet", "is-green"], ods: [t('ODS 表格'), "i-lucide-sheet", "is-green"],
  pptx: [t('PowerPoint 演示'), "i-lucide-presentation", "is-orange"], ppt: [t('PowerPoint 演示（旧版）'), "i-lucide-presentation", "is-orange"],
  mp4: [t('视频'), "i-lucide-file-play", "is-purple"], m4v: [t('视频'), "i-lucide-file-play", "is-purple"], webm: [t('视频'), "i-lucide-file-play", "is-purple"],
  mov: [t('视频'), "i-lucide-file-play", "is-purple"], mkv: [t('视频'), "i-lucide-file-play", "is-purple"], avi: [t('视频'), "i-lucide-file-play", "is-purple"],
  ogv: [t('视频'), "i-lucide-file-play", "is-purple"], mp3: [t('音频'), "i-lucide-file-audio", "is-purple"], wav: [t('音频'), "i-lucide-file-audio", "is-purple"],
  ogg: [t('音频'), "i-lucide-file-audio", "is-purple"], oga: [t('音频'), "i-lucide-file-audio", "is-purple"], opus: [t('音频'), "i-lucide-file-audio", "is-purple"],
  m4a: [t('音频'), "i-lucide-file-audio", "is-purple"], aac: [t('音频'), "i-lucide-file-audio", "is-purple"], flac: [t('音频'), "i-lucide-file-audio", "is-purple"],
  avif: [t('图片'), "i-lucide-file-image", "is-purple"], bmp: [t('图片'), "i-lucide-file-image", "is-purple"], ico: [t('图标'), "i-lucide-file-image", "is-purple"],
  srt: [t('字幕'), "i-lucide-captions", "is-purple"], vtt: [t('字幕'), "i-lucide-captions", "is-purple"], ass: [t('字幕'), "i-lucide-captions", "is-purple"],
  ssa: [t('字幕'), "i-lucide-captions", "is-purple"], lrc: [t('歌词字幕'), "i-lucide-captions", "is-purple"],
  prproj: [t('Premiere 工程'), "i-lucide-clapperboard", "is-purple"], fcpxml: [t('Final Cut 工程'), "i-lucide-clapperboard", "is-purple"],
  kdenlive: [t('Kdenlive 工程'), "i-lucide-clapperboard", "is-purple"], mlt: [t('MLT 工程'), "i-lucide-clapperboard", "is-purple"],
  otio: [t('OpenTimelineIO 工程'), "i-lucide-clapperboard", "is-purple"], edl: [t('EDL 剪辑表'), "i-lucide-clapperboard", "is-purple"],
  aep: [t('After Effects 工程'), "i-lucide-clapperboard", "is-purple"], drp: [t('DaVinci 工程'), "i-lucide-clapperboard", "is-purple"],
  veg: [t('Vegas 工程'), "i-lucide-clapperboard", "is-purple"],
};

// What the preview shows in its viewer or players, by extension; mirrors MEDIA_TYPES in runner/project_files.mjs.
const MEDIA_KINDS = { image: ["png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "bmp", "ico"],
  video: ["mp4", "m4v", "webm", "mov", "mkv", "ogv"], audio: ["mp3", "wav", "ogg", "oga", "opus", "m4a", "aac", "flac"] };

/** `image`, `video` or `audio` for a file the preview plays, or "" for one it shows as text. */
export function media_of(name) {
  const extension = /\.([^.\/]+)$/.exec(name)?.[1]?.toLowerCase();
  return Object.keys(MEDIA_KINDS).find((kind) => MEDIA_KINDS[kind].includes(extension)) || "";
}

// How the preview opens text files that are not shown as plain source: tables and subtitle timelines.
const TEXT_KINDS = { table: ["csv", "tsv"], subtitle: ["srt", "vtt", "ass", "ssa", "lrc"] };
// Binary documents the preview reads whole: Office files rendered by the modules under /office/, the Premiere
// project, a gzip-compressed XML shown as its text, and zip archives listed like a folder.
const DOCUMENT_KINDS = { docx: ["docx"], sheet: ["xlsx", "xls", "ods"], slides: ["pptx"], pdf: ["pdf"], prproj: ["prproj"], zip: ["zip"] };

/** The lower-case extension of a file name, or "". */
function extension_of(name) {
  return /\.([^.\/]+)$/.exec(name)?.[1]?.toLowerCase() || "";
}

/** `table` or `subtitle` for a text file with its own view, or "". */
export function text_kind_of(name) {
  const extension = extension_of(name);
  return Object.keys(TEXT_KINDS).find((kind) => TEXT_KINDS[kind].includes(extension)) || "";
}

/** `docx`, `sheet`, `slides`, `pdf`, `prproj` or `zip` for a binary document the preview renders, or "". */
export function document_kind_of(name) {
  const extension = extension_of(name);
  return Object.keys(DOCUMENT_KINDS).find((kind) => DOCUMENT_KINDS[kind].includes(extension)) || "";
}

// The file page's icon view draws its pictures large, where the line icons above turn heavy: there each kind has the
// coloured icon of the VS Code Icons set (user 2026-11-28, #15174, #15182), by extension. The full names are written
// out so the build bundles exactly these.
const TILE_ICONS = {
  md: "i-vscode-icons-file-type-markdown", markdown: "i-vscode-icons-file-type-markdown",
  html: "i-vscode-icons-file-type-html", htm: "i-vscode-icons-file-type-html",
  css: "i-vscode-icons-file-type-css",
  vue: "i-vscode-icons-file-type-vue",
  js: "i-vscode-icons-file-type-js-official", mjs: "i-vscode-icons-file-type-js-official", cjs: "i-vscode-icons-file-type-js-official",
  ts: "i-vscode-icons-file-type-typescript-official",
  tsx: "i-vscode-icons-file-type-reactts",
  jsx: "i-vscode-icons-file-type-reactjs",
  py: "i-vscode-icons-file-type-python",
  sql: "i-vscode-icons-file-type-sql",
  sh: "i-vscode-icons-file-type-shell",
  bat: "i-vscode-icons-file-type-bat",
  ps1: "i-vscode-icons-file-type-powershell",
  json: "i-vscode-icons-file-type-json", jsonc: "i-vscode-icons-file-type-json",
  yaml: "i-vscode-icons-file-type-yaml", yml: "i-vscode-icons-file-type-yaml",
  toml: "i-vscode-icons-file-type-toml",
  ini: "i-vscode-icons-file-type-ini",
  xml: "i-vscode-icons-file-type-xml",
  log: "i-vscode-icons-file-type-log",
  txt: "i-vscode-icons-file-type-text", srt: "i-vscode-icons-file-type-text", vtt: "i-vscode-icons-file-type-text", ass: "i-vscode-icons-file-type-text", ssa: "i-vscode-icons-file-type-text", lrc: "i-vscode-icons-file-type-text",
  pdf: "i-vscode-icons-file-type-pdf2",
  zip: "i-vscode-icons-file-type-zip",
  docx: "i-vscode-icons-file-type-word", doc: "i-vscode-icons-file-type-word",
  xlsx: "i-vscode-icons-file-type-excel", xls: "i-vscode-icons-file-type-excel", ods: "i-vscode-icons-file-type-excel",
  csv: "i-vscode-icons-file-type-csv", tsv: "i-vscode-icons-file-type-csv",
  pptx: "i-vscode-icons-file-type-powerpoint", ppt: "i-vscode-icons-file-type-powerpoint",
  png: "i-vscode-icons-file-type-image", jpg: "i-vscode-icons-file-type-image", jpeg: "i-vscode-icons-file-type-image", gif: "i-vscode-icons-file-type-image", webp: "i-vscode-icons-file-type-image", avif: "i-vscode-icons-file-type-image", bmp: "i-vscode-icons-file-type-image", ico: "i-vscode-icons-file-type-image",
  svg: "i-vscode-icons-file-type-svg",
  mp4: "i-vscode-icons-file-type-video", m4v: "i-vscode-icons-file-type-video", webm: "i-vscode-icons-file-type-video", mov: "i-vscode-icons-file-type-video", mkv: "i-vscode-icons-file-type-video", avi: "i-vscode-icons-file-type-video", ogv: "i-vscode-icons-file-type-video", prproj: "i-vscode-icons-file-type-video", fcpxml: "i-vscode-icons-file-type-video", kdenlive: "i-vscode-icons-file-type-video", mlt: "i-vscode-icons-file-type-video", otio: "i-vscode-icons-file-type-video", edl: "i-vscode-icons-file-type-video", aep: "i-vscode-icons-file-type-video", drp: "i-vscode-icons-file-type-video", veg: "i-vscode-icons-file-type-video",
  mp3: "i-vscode-icons-file-type-audio", wav: "i-vscode-icons-file-type-audio", ogg: "i-vscode-icons-file-type-audio", oga: "i-vscode-icons-file-type-audio", opus: "i-vscode-icons-file-type-audio", m4a: "i-vscode-icons-file-type-audio", aac: "i-vscode-icons-file-type-audio", flac: "i-vscode-icons-file-type-audio",
};

// Icons of the set drawn too dark to see on the dark theme (brown Markdown, navy audio): lightened there (`is-dark-lift`).
const DARK_ON_DARK = new Set(["i-vscode-icons-file-type-markdown", "i-vscode-icons-file-type-audio"]);

/** The icon view's picture of a folder or file: `[icon, tint class]`, a coloured icon in place of the line one. */
export function tile_icon(entry) {
  if (entry.kind === "directory") return ["i-vscode-icons-default-folder", ""];
  if (entry.kind === "unavailable") return ["i-lucide-file-lock-2", "is-muted"];
  const icon = TILE_ICONS[extension_of(entry.name)] || "i-vscode-icons-default-file";
  return [icon, DARK_ON_DARK.has(icon) ? "is-dark-lift" : ""];
}

/** Look up the display type of a file by its extension. */
export function file_type(name) {
  const extension = /\.([^.\\/]+)$/.exec(name)?.[1]?.toLowerCase();
  return FILE_TYPES[extension] || [t('纯文本'), "i-lucide-file", "is-muted"];
}

/**
 * The project path an image of a Markdown file at folder `base` names, as rendered `src` (escaped, percent-encoded),
 * or null for a URL with a scheme, a fragment or a path leaving the project. Mirrors `page_reference` in
 * runner/project_files.mjs, which keys the images the computer sends by the same path.
 */
export function markdown_image_path(base, src) {
  const value = src.replace(/&amp;/g, "&").trim();
  if (!value || /^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(value)) return null;
  let path = value.replace(/[?#].*$/, "");
  try { path = decodeURIComponent(path); } catch { /* Kept as written. */ }
  const parts = [];
  for (const part of (path.startsWith("/") ? path.slice(1) : `${base}/${path}`).split("/")) {
    if (part === "..") { if (!parts.length) return null; parts.pop(); }
    else if (part && part !== ".") parts.push(part);
  }
  return parts.join("/");
}

/**
 * Show the images of a project Markdown file the way a message shows its images (`.attachment-image`, markdown.css):
 * a box with a spinner until the image comes near and is read through the computer (`route(source)`, the page's shared
 * relayed-image reader), then the image; one that cannot be read says so. Web addresses and data URLs load as written.
 */
export function project_markdown_images(html, base, root, route) {
  return html.replace(/<img src="([^"]*)"([^>]*)>/g, (whole, src, rest) => {
    let image = whole;
    if (!/^(https?:|data:|blob:|\/\/)/i.test(src)) {
      const source = markdown_image_source(base, src, root);
      image = source ? `<img data-relay-src="${route(source)}"${rest}>` : `<img data-relay-src="" data-relay-failed="1"${rest}>`;
    }
    return `<button type="button" class="attachment-image" data-markdown-image>${image}</button>`;
  });
}

/**
 * What the computer is asked for one Markdown image: `{ path, root }`, or null for a relative path leaving the project.
 * Paths are taken as the common Markdown editors take them: relative to the file, `/…` from the project folder (or an
 * absolute path where the computer has one inside a room directory), `D:\…`, `D:/…`, UNC and `file:` addresses as
 * absolute paths on the computer, which reads them only inside the room's directories.
 */
export function markdown_image_source(base, src, root) {
  let raw = src.replace(/&amp;/g, "&").trim().replace(/[?#].*$/, "");
  try { raw = decodeURIComponent(raw); } catch { /* Kept as written. */ }
  const file = /^file:(\/\/)?(.*)$/i.exec(raw);
  // file:///D:/a.png, file://server/share/a.png (UNC) and file:///home/a.png (an absolute POSIX path).
  if (file) raw = /^\/[a-z]:[\\/]/i.test(file[2]) ? file[2].slice(1) : file[1] && !file[2].startsWith("/") ? `\\\\${file[2].replace(/\//g, "\\")}` : file[2];
  if (/^([a-z]:[\\/]|\\\\)/i.test(raw) || raw.startsWith("/")) return { path: raw, root };
  const path = markdown_image_path(base, src);
  return path === null ? null : { path, root };
}

/** Split a project-relative path into clickable crumbs, rooted at the project folder's own name. */
export function crumbs_of(directory, path) {
  const root = directory.split(/[\\/]/).filter(Boolean).pop() || t('项目目录');
  const parts = path.split("/").filter(Boolean);
  return [{ name: root, path: "" }, ...parts.map((name, index) => ({ name, path: parts.slice(0, index + 1).join("/") }))];
}

/** Format file sizes without filling directory rows with a placeholder. */
export function file_size(size) {
  if (size == null) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/** Format a file's local modification time for the directory and the preview status bar. */
export function modified_time(value) {
  return value ? new Date(value).toLocaleString(locale, { hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
}

/** "第 41 行" or "第 41–42 行"; empty when the lines are unknown. */
export function excerpt_lines({ start, end }) {
  if (!start) return "";
  return start === end ? `第 ${start} 行` : `第 ${start}–${end} 行`;
}

/** Where an excerpt comes from: a message, a message attachment (its message and ID, to download it), or a project path. */
function excerpt_origin(excerpt) {
  if (excerpt.message_id) return `${excerpt.name} 的消息 #${excerpt.message_id}`;
  if (excerpt.attachment_id) {
    const owner = excerpt.attachment_message_id ? `消息 #${excerpt.attachment_message_id} 的附件` : "附件";
    return `${owner} \`${excerpt.name}\`（附件 ID ${excerpt.attachment_id}）`;
  }
  return `\`${excerpt.path}\``;
}

/**
 * The excerpts as Markdown appended to a message: source and lines, the text as a quote (quoted lines never @name
 * anyone), then the optional comment.
 */
export function excerpts_markdown(excerpts) {
  return excerpts.map((excerpt, index) => {
    const quote = excerpt.text.split("\n").map(line => line.trim() ? `> ${line}` : ">").join("\n");
    const lines = excerpt_lines(excerpt);
    const source = excerpt_origin(excerpt);
    return [`注释 ${index + 1}：${source}${lines ? ` ${lines}` : ""}`, quote, excerpt.comment ? `批注：${excerpt.comment}` : ""]
      .filter(Boolean).join("\n\n");
  }).join("\n\n");
}

const EXCERPT_HEAD = /^注释 (\d+)：(.*)$/;
const EXCERPT_LINES = / 第 (\d+)(?:–(\d+))? 行$/;
const COMMENT_PREFIX = "批注：";

/** An excerpt's source fields from its `excerpt_origin` (lines already cut off); null when it is not one. */
function origin_fields(origin) {
  let match = origin.match(/^(.*) 的消息 #(\d+)$/);
  if (match) return { path: `#${match[2]}`, name: match[1], message_id: Number(match[2]) };
  match = origin.match(/^(?:消息 #(\d+) 的附件|附件) `(.+)`（附件 ID ([^）]+)）$/);
  if (match) return { path: match[2], name: match[2], attachment_id: /^\d+$/.test(match[3]) ? Number(match[3]) : match[3], attachment_message_id: Number(match[1]) || 0 };
  match = origin.match(/^`(.+)`$/);
  return match ? { path: match[1], name: match[1].split("/").pop() } : null;
}

/** Where a message excerpt's text lies in its message as shown, for its number mark; unchanged when it is not shown. */
function locate_in_message(excerpt) {
  const body = excerpt.message_id && document.getElementById(`channel-answer-${excerpt.message_id}`);
  const from = body ? body.textContent.indexOf(excerpt.text) : -1;
  return from < 0 ? excerpt : { ...excerpt, from, to: from + excerpt.text.length };
}

/** The excerpts of `lines` written by `excerpts_markdown`, numbered from 1; null unless all of them are excerpts. */
function read_excerpt_blocks(lines) {
  const excerpts = [];
  let index = 0;
  while (index < lines.length) {
    const head = lines[index].match(EXCERPT_HEAD);
    if (!head || Number(head[1]) !== excerpts.length + 1) return null;
    const range = head[2].match(EXCERPT_LINES);
    const fields = origin_fields(range ? head[2].slice(0, range.index) : head[2]);
    if (!fields || lines[index + 1] !== "") return null;
    index += 2;
    const quote = [];
    while (index < lines.length && lines[index].startsWith(">")) quote.push(lines[index++].replace(/^> ?/, ""));
    if (!quote.length) return null;
    const comment = [];
    if (lines[index] === "" && lines[index + 1]?.startsWith(COMMENT_PREFIX)) {
      comment.push(lines[index + 1].slice(COMMENT_PREFIX.length));
      index += 2;
      while (index < lines.length && !(lines[index] === "" && EXCERPT_HEAD.test(lines[index + 1] ?? ""))) comment.push(lines[index++]);
    }
    if (index < lines.length && lines[index++] !== "") return null;
    const start = range ? Number(range[1]) : 0;
    excerpts.push({ ...fields, start, end: range ? Number(range[2] || range[1]) : 0, text: quote.join("\n"), comment: comment.join("\n").trim() });
  }
  return excerpts;
}

/**
 * Split the excerpts `excerpts_markdown` appended to a message off its text, as composer excerpts again: a message taken
 * back or a queued message being edited returns to the composer with its notes as cards, not as plain text.
 * @returns {{ text: string, excerpts: object[] }} the text without them, and the excerpts (none when it has none).
 */
export function take_excerpts(text) {
  const lines = text.replace(/\r/g, "").split("\n");
  for (let first = 0; first < lines.length; first++) {
    if (!lines[first].startsWith("注释 1：") || (first && lines[first - 1] !== "")) continue;
    const excerpts = read_excerpt_blocks(lines.slice(first));
    if (excerpts) return { text: lines.slice(0, first).join("\n").trimEnd(), excerpts: excerpts.map((excerpt) => ({ ...locate_in_message(excerpt), id: ++excerpt_serial })) };
  }
  return { text, excerpts: [] };
}

// Subtitle cues shown in the timeline view; a longer file keeps its full text in the source view.
const MAX_SUBTITLE_CUES = 5000;
const SRT_TIME = /(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}|\d{1,2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}|\d{1,2}:\d{2}[,.]\d{1,3})/;

/**
 * The cues of a subtitle file as `[{ start, end, text }]`, times as written: SRT and WebVTT blocks, ASS/SSA `Dialogue`
 * lines (style overrides such as `{\an8}` removed, `\N` as a line break) and LRC `[mm:ss.xx]` lyric lines.
 */
export function subtitle_cues(text, name) {
  const extension = extension_of(name);
  const cues = [];
  if (extension === "ass" || extension === "ssa") {
    let fields = null;
    for (const line of text.split(/\r?\n/)) {
      if (/^Format:/i.test(line) && !fields) fields = line.slice(7).split(",").map(field => field.trim().toLowerCase());
      if (!/^Dialogue:/i.test(line) || !fields) continue;
      const values = line.slice(9).split(",");
      const at = (name) => values[fields.indexOf(name)]?.trim() || "";
      // The text field is last and may itself contain commas.
      const body = values.slice(fields.indexOf("text")).join(",").replace(/\{[^}]*\}/g, "").replace(/\\[Nn]/g, "\n").trim();
      cues.push({ start: at("start"), end: at("end"), text: body });
      if (cues.length >= MAX_SUBTITLE_CUES) break;
    }
    return cues;
  }
  if (extension === "lrc") {
    for (const line of text.split(/\r?\n/)) {
      const times = [...line.matchAll(/\[(\d{1,3}:\d{2}(?:[.:]\d{1,3})?)\]/g)].map(match => match[1]);
      const body = line.replace(/\[[^\]]*\]/g, "").trim();
      for (const start of times) cues.push({ start, end: "", text: body });
      if (cues.length >= MAX_SUBTITLE_CUES) break;
    }
    return cues;
  }
  for (const block of text.replace(/^﻿/, "").split(/\r?\n\s*\r?\n/)) {
    const lines = block.split(/\r?\n/);
    const index = lines.findIndex(line => SRT_TIME.test(line));
    if (index < 0) continue;
    const [, start, end] = SRT_TIME.exec(lines[index]);
    cues.push({ start, end, text: lines.slice(index + 1).join("\n").replace(/<[^>]+>/g, "").trim() });
    if (cues.length >= MAX_SUBTITLE_CUES) break;
  }
  return cues;
}

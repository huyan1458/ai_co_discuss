/**
 * What the file list, the floating file preview and the composer share within one room: the preview's entry points and
 * the excerpts quoted from project files for the next message.
 */
import { reactive } from "vue";

/**
 * `open(path, directory, root)` is set by the preview while it is mounted (`root` is the index of the room's project
 * directory the path is in, 0 for the main one); `reveal_path` is a folder of directory `reveal_root` the file list should show next (it
 * may not be shown yet); `excerpts` are `{ id, path, name, start, end, text, comment }` waiting in the composer;
 * `focus_composer` counts requests to focus it.
 */
export const file_preview = reactive({ open: null, reveal_path: null, reveal_root: 0, excerpts: [], focus_composer: 0 });
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

/** Where an excerpt came from, as the composer's list shows it. */
export function excerpt_source(excerpt) {
  if (excerpt.message_id) return `${excerpt.name} #${excerpt.message_id}`;
  const lines = excerpt_lines(excerpt);
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
    if (!rect) return null;
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

// Listings already read (by room, project and path), kept in this browser so a folder opened before shows at once even
// after a reload; the list reads it again behind it. The oldest beyond the cap are dropped.
const FOLDER_LISTINGS_KEY = "codiscuss-folder-listings";
const FOLDER_LISTINGS_LIMIT = 300;

/** The saved listings, oldest first; empty when storage is unavailable or unreadable. */
function stored_listings() {
  try { return new Map(JSON.parse(localStorage.getItem(FOLDER_LISTINGS_KEY)) || []); } catch { return new Map(); }
}

const listings = stored_listings();
export const folder_listings = {
  get: (key) => listings.get(key),
  /** Remember one listing as the newest and save them all; a full or blocked storage keeps it for this page only. */
  set(key, listing) {
    listings.delete(key);
    listings.set(key, listing);
    while (listings.size > FOLDER_LISTINGS_LIMIT) listings.delete(listings.keys().next().value);
    try { localStorage.setItem(FOLDER_LISTINGS_KEY, JSON.stringify([...listings])); } catch { /* Kept in memory only. */ }
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
  png: ["图片", "i-lucide-file-image", "is-purple"], jpg: ["图片", "i-lucide-file-image", "is-purple"], jpeg: ["图片", "i-lucide-file-image", "is-purple"],
  gif: ["图片", "i-lucide-file-image", "is-purple"], webp: ["图片", "i-lucide-file-image", "is-purple"], svg: ["SVG", "i-lucide-file-image", "is-orange"],
  zip: ["压缩包", "i-lucide-file-archive", "is-muted"], pdf: ["PDF", "i-lucide-file-text", "is-red"], txt: ["纯文本", "i-lucide-file-text", "is-muted"],
  csv: ["CSV 表格", "i-lucide-sheet", "is-green"], tsv: ["TSV 表格", "i-lucide-sheet", "is-green"], xml: ["XML", "i-lucide-file-code", "is-orange"],
  ini: ["INI", "i-lucide-file-cog", "is-purple"], log: ["日志", "i-lucide-file-text", "is-muted"],
  docx: ["Word 文档", "i-lucide-file-text", "is-blue"], doc: ["Word 文档（旧版）", "i-lucide-file-text", "is-blue"],
  xlsx: ["Excel 表格", "i-lucide-sheet", "is-green"], xls: ["Excel 表格（旧版）", "i-lucide-sheet", "is-green"], ods: ["ODS 表格", "i-lucide-sheet", "is-green"],
  pptx: ["PowerPoint 演示", "i-lucide-presentation", "is-orange"], ppt: ["PowerPoint 演示（旧版）", "i-lucide-presentation", "is-orange"],
  mp4: ["视频", "i-lucide-file-play", "is-purple"], m4v: ["视频", "i-lucide-file-play", "is-purple"], webm: ["视频", "i-lucide-file-play", "is-purple"],
  mov: ["视频", "i-lucide-file-play", "is-purple"], mkv: ["视频", "i-lucide-file-play", "is-purple"], avi: ["视频", "i-lucide-file-play", "is-purple"],
  ogv: ["视频", "i-lucide-file-play", "is-purple"], mp3: ["音频", "i-lucide-file-audio", "is-purple"], wav: ["音频", "i-lucide-file-audio", "is-purple"],
  ogg: ["音频", "i-lucide-file-audio", "is-purple"], oga: ["音频", "i-lucide-file-audio", "is-purple"], opus: ["音频", "i-lucide-file-audio", "is-purple"],
  m4a: ["音频", "i-lucide-file-audio", "is-purple"], aac: ["音频", "i-lucide-file-audio", "is-purple"], flac: ["音频", "i-lucide-file-audio", "is-purple"],
  avif: ["图片", "i-lucide-file-image", "is-purple"], bmp: ["图片", "i-lucide-file-image", "is-purple"], ico: ["图标", "i-lucide-file-image", "is-purple"],
  srt: ["字幕", "i-lucide-captions", "is-purple"], vtt: ["字幕", "i-lucide-captions", "is-purple"], ass: ["字幕", "i-lucide-captions", "is-purple"],
  ssa: ["字幕", "i-lucide-captions", "is-purple"], lrc: ["歌词字幕", "i-lucide-captions", "is-purple"],
  prproj: ["Premiere 工程", "i-lucide-clapperboard", "is-purple"], fcpxml: ["Final Cut 工程", "i-lucide-clapperboard", "is-purple"],
  kdenlive: ["Kdenlive 工程", "i-lucide-clapperboard", "is-purple"], mlt: ["MLT 工程", "i-lucide-clapperboard", "is-purple"],
  otio: ["OpenTimelineIO 工程", "i-lucide-clapperboard", "is-purple"], edl: ["EDL 剪辑表", "i-lucide-clapperboard", "is-purple"],
  aep: ["After Effects 工程", "i-lucide-clapperboard", "is-purple"], drp: ["DaVinci 工程", "i-lucide-clapperboard", "is-purple"],
  veg: ["Vegas 工程", "i-lucide-clapperboard", "is-purple"],
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
// Binary documents the preview reads whole: Office files rendered by the modules under /office/, and the Premiere
// project, a gzip-compressed XML shown as its text.
const DOCUMENT_KINDS = { docx: ["docx"], sheet: ["xlsx", "xls", "ods"], slides: ["pptx"], pdf: ["pdf"], prproj: ["prproj"] };

/** The lower-case extension of a file name, or "". */
function extension_of(name) {
  return /\.([^.\/]+)$/.exec(name)?.[1]?.toLowerCase() || "";
}

/** `table` or `subtitle` for a text file with its own view, or "". */
export function text_kind_of(name) {
  const extension = extension_of(name);
  return Object.keys(TEXT_KINDS).find((kind) => TEXT_KINDS[kind].includes(extension)) || "";
}

/** `docx`, `sheet`, `slides`, `pdf` or `prproj` for a binary document the preview renders, or "". */
export function document_kind_of(name) {
  const extension = extension_of(name);
  return Object.keys(DOCUMENT_KINDS).find((kind) => DOCUMENT_KINDS[kind].includes(extension)) || "";
}

/** Look up the display type of a file by its extension. */
export function file_type(name) {
  const extension = /\.([^.\\/]+)$/.exec(name)?.[1]?.toLowerCase();
  return FILE_TYPES[extension] || ["纯文本", "i-lucide-file", "is-muted"];
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

/** Point the images of rendered Markdown at the data URLs the computer read for them; others stay as written. */
export function inline_markdown_images(html, images, base) {
  if (!images) return html;
  return html.replace(/<img src="([^"]*)"/g, (whole, src) => {
    const url = images[markdown_image_path(base, src)];
    return url ? `<img src="${url}"` : whole;
  });
}

/** Split a project-relative path into clickable crumbs, rooted at the project folder's own name. */
export function crumbs_of(directory, path) {
  const root = directory.split(/[\\/]/).filter(Boolean).pop() || "项目目录";
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
  return value ? new Date(value).toLocaleString("zh-CN", { hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
}

/** "第 41 行" or "第 41–42 行"; empty when the lines are unknown. */
export function excerpt_lines({ start, end }) {
  if (!start) return "";
  return start === end ? `第 ${start} 行` : `第 ${start}–${end} 行`;
}

/**
 * The excerpts as Markdown appended to a message: path and lines, the text as a quote (quoted lines never @name
 * anyone), then the optional comment.
 */
export function excerpts_markdown(excerpts) {
  return excerpts.map((excerpt, index) => {
    const quote = excerpt.text.split("\n").map(line => line.trim() ? `> ${line}` : ">").join("\n");
    const lines = excerpt_lines(excerpt);
    const source = excerpt.message_id ? `${excerpt.name} 的消息 #${excerpt.message_id}` : `\`${excerpt.path}\``;
    return [`摘录 ${index + 1}：${source}${lines ? ` ${lines}` : ""}`, quote, excerpt.comment ? `批注：${excerpt.comment}` : ""]
      .filter(Boolean).join("\n\n");
  }).join("\n\n");
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

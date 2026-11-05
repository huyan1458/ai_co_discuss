/**
 * What the file list, the floating file preview and the composer share within one room: the preview's entry points and
 * the excerpts quoted from project files for the next message.
 */
import { reactive } from "vue";

/**
 * `open(path)` is set by the preview while it is mounted; `reveal_path` is a folder the file list should show next (it
 * may not be shown yet); `excerpts` are `{ id, path, name, start, end, text, comment }` waiting in the composer;
 * `focus_composer` counts requests to focus it.
 */
export const file_preview = reactive({ open: null, reveal_path: null, excerpts: [], focus_composer: 0 });

// For this page's lifetime, so a folder opened before shows at once: listings already read (by room, project and
// path), and the folder each room's list last showed (`{ directory, path }`).
export const folder_listings = new Map();
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
};

/** Look up the display type of a file by its extension. */
export function file_type(name) {
  const extension = /\.([^.\\/]+)$/.exec(name)?.[1]?.toLowerCase();
  return FILE_TYPES[extension] || ["纯文本", "i-lucide-file", "is-muted"];
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
    return [`摘录 ${index + 1}：\`${excerpt.path}\`${lines ? ` ${lines}` : ""}`, quote, excerpt.comment ? `批注：${excerpt.comment}` : ""]
      .filter(Boolean).join("\n\n");
  }).join("\n\n");
}

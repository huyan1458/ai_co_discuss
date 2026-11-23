/**
 * Read a workflow the user opened in the browser, as a zip or a folder, into the `files` the local service previews:
 * `{ "SKILL.md": text, "agents/<card>.md": text, "<other path>": text }`, paths relative to the folder holding SKILL.md;
 * a file that is not UTF-8 text, or too large, is sent as null so the service names it back as ignored.
 * Reading happens in the page, so another device imports the same way as the computer itself.
 */
import { t } from "./i18n.js";

const MAX_FILE_BYTES = 1_000_000;
const ZIP_END = 0x06054b50, ZIP_ENTRY = 0x02014b50, ZIP_END_SIZE = 22, ZIP_COMMENT_MAX = 65535;
const SKILL = /(^|\/)SKILL\.md$/;
const decoder = new TextDecoder();
const strict = new TextDecoder("utf-8", { fatal: true });
// Zips made on Chinese Windows name files in GBK without marking them as UTF-8.
const legacy = new TextDecoder("gbk");

/** An entry's name: UTF-8 when flagged or valid as such, otherwise the legacy Chinese code page. */
function entry_name(raw, flags) {
  if (flags & 0x800) return decoder.decode(raw);
  try { return strict.decode(raw); } catch { return legacy.decode(raw); }
}

/** The local time a zip entry was last modified (MS-DOS date and time), or "" when not set. */
function entry_time(date, time) {
  if (!date) return "";
  return new Date(1980 + (date >> 9), ((date >> 5) & 15) - 1, date & 31, time >> 11, (time >> 5) & 63, (time & 31) * 2).toISOString();
}

/**
 * Entries of a zip as `{ path, size, modified_at, encrypted, read }`, each read only when asked; stored and deflated
 * files are supported, folders are left out (their files name them).
 */
export function zip_entries(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let at = bytes.length - ZIP_END_SIZE; at >= Math.max(0, bytes.length - ZIP_END_SIZE - ZIP_COMMENT_MAX); at--) {
    if (view.getUint32(at, true) === ZIP_END) { end = at; break; }
  }
  if (end < 0) throw new Error(t('不是有效的 zip 文件'));
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  const entries = [];
  for (let index = 0; index < count; index++) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== ZIP_ENTRY) throw new Error(t('zip 文件目录损坏或使用了不支持的 zip64 格式'));
    const flags = view.getUint16(offset + 8, true), method = view.getUint16(offset + 10, true);
    const time = view.getUint16(offset + 12, true), date = view.getUint16(offset + 14, true);
    const compressed = view.getUint32(offset + 20, true), size = view.getUint32(offset + 24, true);
    const name_length = view.getUint16(offset + 28, true), extra = view.getUint16(offset + 30, true), comment = view.getUint16(offset + 32, true);
    const local = view.getUint32(offset + 42, true);
    const path = entry_name(bytes.subarray(offset + 46, offset + 46 + name_length), flags).replace(/\\/g, "/");
    offset += 46 + name_length + extra + comment;
    if (path.endsWith("/")) continue;
    entries.push({ path, size, modified_at: entry_time(date, time), encrypted: Boolean(flags & 1), read: async (limit = Infinity) => {
      if (size > limit) throw new Error(t("压缩包内单个文件最多预览 64 MiB"));
      if (flags & 1) throw new Error(t('{value1} 已加密，无法读取', { value1: path }));
      const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      const data = bytes.subarray(start, start + compressed);
      if (method === 0 && data.length === size) return data;
      if (method === 0) throw new Error(t("无法读取这个压缩包条目"));
      if (method !== 8) throw new Error(t('{value1} 的压缩方式不支持', { value1: path }));
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      if (!Number.isFinite(limit)) return new Uint8Array(await new Response(stream).arrayBuffer());
      const result = new Uint8Array(size), reader = stream.getReader();
      let offset = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (offset + value.byteLength > size) throw new Error(t("无法读取这个压缩包条目"));
          result.set(value, offset);
          offset += value.byteLength;
        }
      } finally { await reader.cancel(); }
      if (offset !== size) throw new Error(t("无法读取这个压缩包条目"));
      return result;
    } });
  }
  return entries;
}

/** Keep the folder holding the shallowest SKILL.md and read every file in it as text. */
async function collect(entries) {
  const skills = entries.filter((entry) => SKILL.test(entry.path) && !entry.path.startsWith("__MACOSX/"))
    .sort((left, right) => left.path.split("/").length - right.path.split("/").length);
  if (!skills.length) throw new Error(t('没有找到 SKILL.md'));
  const prefix = skills[0].path.slice(0, -"SKILL.md".length);
  const files = {};
  for (const entry of entries) {
    if (!entry.path.startsWith(prefix)) continue;
    const path = entry.path.slice(prefix.length);
    if (entry.size > MAX_FILE_BYTES) {
      if (path === "SKILL.md") throw new Error(t('{value1} 超过 1 MB', { value1: path }));
      files[path] = null;
      continue;
    }
    try { files[path] = strict.decode(await entry.read()); }
    catch (error) { if (path === "SKILL.md") throw error; files[path] = null; }
  }
  return files;
}

/** A workflow from a .zip file. */
export async function workflow_files_from_zip(file) {
  return collect(zip_entries(new Uint8Array(await file.arrayBuffer())));
}

/** A workflow from the files of a folder chosen with a directory input. */
export async function workflow_files_from_folder(files) {
  return collect(files.map((file) => ({ path: file.webkitRelativePath || file.name, size: file.size, read: async () => new Uint8Array(await file.arrayBuffer()) })));
}

/** Let the browser save bytes or text as a file of this name. */
export function download_file(name, content, type = "application/octet-stream") {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Download what exporting an expert gave: its one .md, or with skills a zip of `<id>/…`. */
export function download_expert({ id, files, skills }) {
  if (skills.length) download_file(`${id}.zip`, zip_store(files, id), "application/zip");
  else download_file(`${id}.md`, files[`${id}.md`], "text/markdown;charset=utf-8");
}

// Experts (2026-11-22): a package is `<id>.md` plus `skills/<skill>/…`; the page reads one from a zip, a folder or a
// single .md, and writes one as a zip with stored (uncompressed) entries that zip_entries above reads back.
const DEFINITION = /(^|\/)[^/]+\.md$/;

/** Keep the folder holding the shallowest definition (.md outside skills/, not a SKILL.md) and read its files as text. */
async function collect_expert(entries) {
  const definitions = entries.filter((entry) => DEFINITION.test(entry.path) && !SKILL.test(entry.path) && !entry.path.startsWith("__MACOSX/")
    && !entry.path.split("/").slice(0, -1).includes("skills"))
    .sort((left, right) => left.path.split("/").length - right.path.split("/").length);
  if (!definitions.length) throw new Error(t('没有找到专家定义的 .md 文件'));
  const prefix = definitions[0].path.slice(0, definitions[0].path.lastIndexOf("/") + 1);
  const files = {};
  for (const entry of entries) {
    if (!entry.path.startsWith(prefix)) continue;
    const path = entry.path.slice(prefix.length);
    if (entry.size > MAX_FILE_BYTES) { files[path] = null; continue; }
    try { files[path] = strict.decode(await entry.read()); } catch { files[path] = null; }
  }
  return files;
}

/** An expert from a .zip file. */
export async function expert_files_from_zip(file) {
  return collect_expert(zip_entries(new Uint8Array(await file.arrayBuffer())));
}

/** An expert from the files of a folder chosen with a directory input. */
export async function expert_files_from_folder(files) {
  return collect_expert(files.map((file) => ({ path: file.webkitRelativePath || file.name, size: file.size, read: async () => new Uint8Array(await file.arrayBuffer()) })));
}

/** An expert without knowledge: its one .md file. */
export async function expert_files_from_md(file) {
  if (file.size > MAX_FILE_BYTES) throw new Error(t('{value1} 超过 1 MB', { value1: file.name }));
  return { [file.name]: strict.decode(new Uint8Array(await file.arrayBuffer())) };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

/** The CRC-32 a zip entry records. */
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** `{path: text}` as a zip with stored entries and UTF-8 names under `root/`, in path order. */
export function zip_store(files, root = "") {
  const encoder = new TextEncoder(), parts = [], central = [];
  let offset = 0;
  for (const path of Object.keys(files).sort()) {
    const name = encoder.encode(`${root ? `${root}/` : ""}${path}`), data = encoder.encode(files[path]);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x800, true); local.setUint16(8, 0, true);
    local.setUint32(14, crc, true); local.setUint32(18, data.length, true); local.setUint32(22, data.length, true); local.setUint16(26, name.length, true);
    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, ZIP_ENTRY, true); entry.setUint16(4, 20, true); entry.setUint16(6, 20, true); entry.setUint16(8, 0x800, true);
    entry.setUint32(16, crc, true); entry.setUint32(20, data.length, true); entry.setUint32(24, data.length, true); entry.setUint16(28, name.length, true);
    entry.setUint32(42, offset, true);
    parts.push(new Uint8Array(local.buffer), name, data);
    central.push(new Uint8Array(entry.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const size = central.reduce((sum, part) => sum + part.length, 0);
  const end = new DataView(new ArrayBuffer(ZIP_END_SIZE));
  end.setUint32(0, ZIP_END, true); end.setUint16(8, Object.keys(files).length, true); end.setUint16(10, Object.keys(files).length, true);
  end.setUint32(12, size, true); end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const result = new Uint8Array(all.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of all) { result.set(part, at); at += part.length; }
  return result;
}

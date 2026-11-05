/**
 * Read a workflow the user opened in the browser, as a zip or a folder, into the `files` the local service previews:
 * `{ "SKILL.md": text, "agents/<card>.md": text, "<other path>": text }`, paths relative to the folder holding SKILL.md;
 * a file that is not UTF-8 text, or too large, is sent as null so the service names it back as ignored.
 * Reading happens in the page, so another device imports the same way as the computer itself.
 */
const MAX_FILE_BYTES = 1_000_000;
const ZIP_END = 0x06054b50, ZIP_ENTRY = 0x02014b50, ZIP_END_SIZE = 22, ZIP_COMMENT_MAX = 65535;
const SKILL = /(^|\/)SKILL\.md$/;
const decoder = new TextDecoder();
const strict = new TextDecoder("utf-8", { fatal: true });

/** Entries of a zip, each read only when asked; stored and deflated files are supported. */
function zip_entries(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let at = bytes.length - ZIP_END_SIZE; at >= Math.max(0, bytes.length - ZIP_END_SIZE - ZIP_COMMENT_MAX); at--) {
    if (view.getUint32(at, true) === ZIP_END) { end = at; break; }
  }
  if (end < 0) throw new Error("不是有效的 zip 文件");
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  const entries = [];
  for (let index = 0; index < count; index++) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== ZIP_ENTRY) throw new Error("zip 文件目录损坏或使用了不支持的 zip64 格式");
    const flags = view.getUint16(offset + 8, true), method = view.getUint16(offset + 10, true);
    const compressed = view.getUint32(offset + 20, true), size = view.getUint32(offset + 24, true);
    const name_length = view.getUint16(offset + 28, true), extra = view.getUint16(offset + 30, true), comment = view.getUint16(offset + 32, true);
    const local = view.getUint32(offset + 42, true);
    const path = decoder.decode(bytes.subarray(offset + 46, offset + 46 + name_length)).replace(/\\/g, "/");
    offset += 46 + name_length + extra + comment;
    if (path.endsWith("/")) continue;
    entries.push({ path, size, read: async () => {
      if (flags & 1) throw new Error(`${path} 已加密，无法读取`);
      const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      const data = bytes.subarray(start, start + compressed);
      if (method === 0) return data;
      if (method !== 8) throw new Error(`${path} 的压缩方式不支持`);
      return new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
    } });
  }
  return entries;
}

/** Keep the folder holding the shallowest SKILL.md and read every file in it as text. */
async function collect(entries) {
  const skills = entries.filter((entry) => SKILL.test(entry.path) && !entry.path.startsWith("__MACOSX/"))
    .sort((left, right) => left.path.split("/").length - right.path.split("/").length);
  if (!skills.length) throw new Error("没有找到 SKILL.md");
  const prefix = skills[0].path.slice(0, -"SKILL.md".length);
  const files = {};
  for (const entry of entries) {
    if (!entry.path.startsWith(prefix)) continue;
    const path = entry.path.slice(prefix.length);
    if (entry.size > MAX_FILE_BYTES) {
      if (path === "SKILL.md") throw new Error(`${path} 超过 1 MB`);
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

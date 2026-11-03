/** Read-only directory and text previews, confined to a room's saved project directory. */
import { closeSync, fstatSync, openSync, readdirSync, readSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

const DIRECTORY_PAGE_SIZE = 200;
// Leave room for JSON escaping and base64 within the queued relay's 512 KiB encrypted envelope.
const PREVIEW_MAX_BYTES = 128 * 1024;
const DIRECTORY_MAX_BYTES = 128 * 1024;

/** Resolve a relative project path, including links, without allowing an escape from the project. */
function project_path(root, path) {
  if (typeof path !== 'string' || /[\0:]/.test(path) || isAbsolute(path) || path.replaceAll('\\', '/').split('/').includes('..')) {
    throw new Error('只能读取项目目录内的相对路径');
  }
  const target = realpathSync(resolve(root, path));
  const inside = relative(root, target);
  if (inside === '..' || inside.startsWith('../') || inside.startsWith('..\\') || isAbsolute(inside)) {
    throw new Error('此链接指向项目目录之外，无法读取');
  }
  return target;
}

/** Describe one entry; broken or external links remain visible but cannot be opened. */
function directory_entry(root, path, entry) {
  const child = path ? `${path}/${entry.name}` : entry.name;
  try {
    const info = statSync(project_path(root, child));
    const kind = info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'unavailable';
    return { name: entry.name, path: child, kind, size: info.isFile() ? info.size : null, modified_at: info.mtime.toISOString() };
  } catch {
    return { name: entry.name, path: child, kind: 'unavailable', size: null, modified_at: null };
  }
}

/** Read a bounded UTF-8 or BOM-marked UTF-16 preview, returning a reason for binary files. */
function text_preview(target) {
  const descriptor = openSync(target, 'r');
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile()) throw new Error('只能预览普通文件');
    const bytes = Buffer.alloc(Math.min(info.size, PREVIEW_MAX_BYTES));
    const length = readSync(descriptor, bytes, 0, bytes.length, 0);
    const truncated = info.size > length;
    const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le'
      : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
    const result = { size: info.size, modified_at: info.mtime.toISOString(), truncated, limit: PREVIEW_MAX_BYTES, encoding };
    try {
      const text = new TextDecoder(encoding, { fatal: true }).decode(bytes.subarray(0, length), { stream: truncated });
      if (/[\u0000-\u0008\u000b\u000e-\u001f]/.test(text)) throw new Error('binary');
      return { ...result, text };
    } catch { return { ...result, text: null, reason: '此文件为二进制或使用了暂不支持的文本编码' }; }
  } finally { closeSync(descriptor); }
}

/** List one directory page or preview one file under the configured project root. */
export function read_project_files(cwd, path = '', offset = 0) {
  if (!cwd?.trim()) throw new Error('本房间未设置项目目录');
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('目录分页位置无效');
  const root = realpathSync(cwd);
  if (!statSync(root).isDirectory()) throw new Error('项目目录不是文件夹');
  const target = project_path(root, path);
  const info = statSync(target);
  const normalized = path.replaceAll('\\', '/').split('/').filter(part => part && part !== '.').join('/');
  if (info.isFile()) return { path: normalized, kind: 'file', ...text_preview(target) };
  if (!info.isDirectory()) throw new Error('只能浏览文件夹或预览普通文件');
  const items = readdirSync(target, { withFileTypes: true }).sort((left, right) =>
    Number(right.isDirectory()) - Number(left.isDirectory()) || left.name.localeCompare(right.name, 'zh-CN', { numeric: true }));
  const entries = [];
  let bytes = 0;
  for (const entry of items.slice(offset, offset + DIRECTORY_PAGE_SIZE)) {
    const item = directory_entry(root, normalized, entry);
    bytes += Buffer.byteLength(JSON.stringify(item));
    if (entries.length && bytes > DIRECTORY_MAX_BYTES) break;
    entries.push(item);
  }
  return { path: normalized, kind: 'directory', entries, total: items.length,
    next_offset: offset + entries.length < items.length ? offset + entries.length : null };
}

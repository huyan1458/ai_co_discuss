/**
 * Changes the file page makes to project and draft folders: new folders, rename, move, copy, delete into a recycle
 * area, upload in parts, and saving an edited text file. Every function takes an already resolved root (one of the
 * folders the caller may use, see `room_files` in discussion_launch.mjs) and a path relative to it; nothing here reads
 * a path the request names in full. The root folders themselves are never renamed, moved or deleted here: rooms and
 * AI sessions know them by path.
 */
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, parse, relative, resolve } from 'node:path';

import { project_path, project_root } from './project_files.mjs';

import { attachment_limit } from './attachment_policy.mjs';
import { t } from './i18n.mjs';
export const EDIT_MAX_BYTES = 1024 * 1024;
export const TRASH_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
// The smallest part a page sends (through the relay), bounding how many parts an upload of a given size may have.
const UPLOAD_PART_MIN_BYTES = 64 * 1024;
const UPLOAD_PART_MAX_BYTES = 4 * 1024 * 1024;
const UPLOAD_STALE_MS = 60 * 60 * 1000;
const COPY_MAX_BYTES = 1024 * 1024 * 1024;
const COPY_MAX_ENTRIES = 20000;
const NAME_MAX_LENGTH = 200;
const UNSAFE_NAME = /[<>:"/\\|?*\u0000-\u001f]/;
const RESERVED_NAME = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;
const UPLOAD_ID = /^[A-Za-z0-9_-]{16,80}$/;

/** Split a relative path into its parts; `.` parts are dropped, and `..` or a part naming a drive is refused anywhere. */
function parts_of(path) {
  const parts = String(path ?? '').replaceAll('\\', '/').split('/').filter(part => part && part !== '.');
  if (parts.some(part => part === '..' || /[\0:]/.test(part))) throw new Error('只能改动项目目录内的相对路径');
  return parts;
}

/** A single file or folder name Windows and other systems accept; refused otherwise. */
export function check_name(name) {
  const value = typeof name === 'string' ? name.trim() : '';
  if (!value || value === '.' || value === '..' || value.length > NAME_MAX_LENGTH || UNSAFE_NAME.test(value)
    || /[. ]$/.test(value) || RESERVED_NAME.test(value)) {
    throw new Error(`名称须为 1–${NAME_MAX_LENGTH} 字，不能含 \\ / : * ? " < > | 等符号，不能以点或空格结尾`);
  }
  return value;
}

/** A folder inside the root, resolved through links and required to stay inside and be a folder. */
function folder_in(root, path) {
  const target = project_path(root, parts_of(path).join('/'));
  if (!statSync(target).isDirectory()) throw new Error('目标不是文件夹');
  return target;
}

/**
 * An existing entry inside the root, by its own name (a link is the link, not what it points to). The root itself and
 * links are refused: the root is a room's working folder, and a link may lead outside the project.
 */
function entry_in(root, path) {
  const parts = parts_of(path);
  if (!parts.length) throw new Error('项目或草稿文件夹本身不能在这里改名、移动或删除');
  const parent = folder_in(root, parts.slice(0, -1).join('/'));
  const target = join(parent, parts.at(-1));
  if (!inside(root, target) || same_key(root) === same_key(target)) throw new Error('只能改动项目目录内的相对路径');
  let info;
  try { info = lstatSync(target); } catch { throw new Error('文件或文件夹已不存在，请刷新后重试'); }
  if (info.isSymbolicLink()) throw new Error('链接（含 Windows junction）不能在网页上改动');
  if (!info.isFile() && !info.isDirectory()) throw new Error('只能改动普通文件或文件夹');
  return { parent, name: parts.at(-1), target, info, path: parts.join('/') };
}

const same_key = path => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);

/** Refuse to rename, move, replace or delete a folder some room works in, or one holding such a folder. */
function check_unused(target, info, rooms_in) {
  const rooms = info.isDirectory() && rooms_in ? rooms_in(target) : [];
  if (rooms.length) throw new Error(`有 ${rooms.length} 个房间在使用这个文件夹（或其中的文件夹）作为项目目录，不能改名、移动、替换或删除`);
}

/** The disk a path is on, for telling whether a move copies. */
const drive_key = path => parse(resolve(path)).root.toLowerCase();

/** Whether `inner` is `outer` or lies inside it. */
function inside(outer, inner) {
  const rest = relative(same_key(outer), same_key(inner));
  return !rest || (!rest.startsWith('..') && !isAbsolute(rest));
}

/** `name (1).ext`, `name (2).ext`, … : the first name not yet taken in the folder. */
function free_name(folder, name) {
  const extension = extname(name), stem = extension && extension !== name ? name.slice(0, -extension.length) : name;
  for (let number = 1; ; number += 1) {
    const candidate = `${stem} (${number})${extension && extension !== name ? extension : ''}`;
    if (!existsSync(join(folder, candidate))) return candidate;
  }
}

/**
 * Move a file or folder; across disks it is copied and then removed. When removing the original fails part way (a file
 * in use), the error carries `copied: true`: the copy is whole, and only it still has everything.
 */
export function move_path(from, to, { rename = renameSync } = {}) {
  try { rename(from, to); }
  catch (error) {
    if (error.code !== 'EXDEV') throw error;
    cpSync(from, to, { recursive: true, errorOnExist: true, force: false, filter: source => !lstatSync(source).isSymbolicLink() });
    try { rmSync(from, { recursive: true, force: true }); }
    catch (failure) { throw Object.assign(failure, { copied: true }); }
  }
}

/** The size and number of entries under a folder or file, refusing what is too large to copy at once (or holds a link, with `links`). */
function copy_budget(target, { links = false } = {}) {
  let bytes = 0, entries = 0;
  const walk = path => {
    const info = lstatSync(path);
    if (info.isSymbolicLink() && links) throw new Error('回收区在另一个磁盘上，含链接的文件夹无法移进回收区，请让 AI 处理');
    if (info.isSymbolicLink()) return;
    entries += 1;
    if (info.isFile()) bytes += info.size;
    if (entries > COPY_MAX_ENTRIES || bytes > COPY_MAX_BYTES) throw new Error(`一次最多复制 ${COPY_MAX_ENTRIES} 项、1 GB，请分批复制或让 AI 处理`);
    if (info.isDirectory()) for (const name of readdirSync(path)) walk(join(path, name));
  };
  walk(target);
}

/**
 * The recycle area: one folder per removed item, holding the item and a note of where it came from. It lies outside
 * every project, so AI members searching a project do not read what was deleted.
 */
export class RecycleArea {
  constructor(directory) { this.directory = directory; }

  /** Move one file or folder in; `root` and `path` say where it came from, for restoring. */
  keep(target, { root, path, kind }, { rename = renameSync } = {}) {
    this.purge();
    const id = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const folder = join(this.directory, id);
    // Across disks the item is copied: a large one would hold the request (and the disk), so it is refused first.
    if (drive_key(target) !== drive_key(this.directory)) copy_budget(target, { links: true });
    mkdirSync(join(folder, 'item'), { recursive: true });
    // The note comes first, so an item that reached the area can always be listed and restored.
    writeFileSync(join(folder, 'meta.json'), JSON.stringify({ root, path, name: basename(target), kind, deleted_at: new Date().toISOString() }));
    try { move_path(target, join(folder, 'item', basename(target)), { rename }); }
    catch (error) {
      // A copy made before the original could be fully removed is the only whole one left: it stays in the area.
      if (error.copied) throw new Error('部分文件正被占用，原处没有删干净；回收区里有完整副本，可在回收区还原或关闭占用的程序后再删一次');
      rmSync(folder, { recursive: true, force: true });
      throw error;
    }
    return id;
  }

  /** What is kept, newest first; the root folder is named only by its last part. */
  list() {
    this.purge();
    if (!existsSync(this.directory)) return [];
    return readdirSync(this.directory).flatMap(id => {
      try {
        const meta = JSON.parse(readFileSync(join(this.directory, id, 'meta.json'), 'utf8'));
        const info = statSync(join(this.directory, id, 'item', meta.name));
        return [{ id, name: meta.name, path: meta.path, kind: meta.kind, root_name: basename(meta.root), deleted_at: meta.deleted_at,
          size: info.isFile() ? info.size : null }];
      } catch { return []; }
    }).sort((left, right) => String(right.deleted_at).localeCompare(String(left.deleted_at)));
  }

  /**
   * Put one item back where it was. `allowed(root)` says whether its root folder is still one the caller may use; a
   * name taken meanwhile gets a free one, and a folder deleted meanwhile is made again.
   */
  restore(id, allowed) {
    if (typeof id !== 'string' || !/^[a-z0-9]+-[a-f0-9]{8}$/.test(id)) throw new Error('回收区条目无效');
    const folder = join(this.directory, id);
    let meta;
    try { meta = JSON.parse(readFileSync(join(folder, 'meta.json'), 'utf8')); } catch { throw new Error('回收区条目已不存在，请刷新后重试'); }
    if (!allowed(meta.root)) throw new Error('原来的项目或草稿文件夹已不在你可用的范围内，无法还原');
    const root = project_root(meta.root);
    const parts = parts_of(meta.path);
    const parent = join(root, ...parts.slice(0, -1));
    if (!inside(root, parent)) throw new Error('回收区条目无效');
    mkdirSync(parent, { recursive: true });
    folder_in(root, parts.slice(0, -1).join('/'));
    const name = existsSync(join(parent, meta.name)) ? free_name(parent, meta.name) : meta.name;
    move_path(join(folder, 'item', meta.name), join(parent, name));
    rmSync(folder, { recursive: true, force: true });
    return { path: [...parts.slice(0, -1), name].join('/'), root_name: basename(meta.root) };
  }

  /** Drop what has been kept longer than the keeping period. */
  purge(now = Date.now()) {
    if (!existsSync(this.directory)) return;
    for (const id of readdirSync(this.directory)) {
      const created = parseInt(id.split('-')[0], 36);
      if (Number.isFinite(created) && now - created > TRASH_KEEP_MS) rmSync(join(this.directory, id), { recursive: true, force: true });
    }
  }
}

/** Create one folder in `path`. */
export function make_folder(root, path, name) {
  const folder = folder_in(root, path);
  const wanted = check_name(name);
  const target = join(folder, wanted);
  if (existsSync(target)) throw new Error(`已存在同名的文件或文件夹：${wanted}`);
  mkdirSync(target);
  return { path: [...parts_of(path), wanted].join('/') };
}

/** Rename one entry in its own folder. */
export function rename_entry(root, path, name, rooms_in = null) {
  const entry = entry_in(root, path);
  check_unused(entry.target, entry.info, rooms_in);
  const wanted = check_name(name);
  if (wanted === entry.name) return { path: entry.path };
  const target = join(entry.parent, wanted);
  // A change of letter case only is the same entry on Windows; anything else must be free.
  if (existsSync(target) && same_key(target) !== same_key(entry.target)) throw new Error(`已存在同名的文件或文件夹：${wanted}`);
  renameSync(entry.target, target);
  return { path: [...parts_of(path).slice(0, -1), wanted].join('/') };
}

/** Move one entry into the recycle area. */
export function delete_entry(root, path, recycle, rooms_in = null) {
  const entry = entry_in(root, path);
  check_unused(entry.target, entry.info, rooms_in);
  const id = recycle.keep(entry.target, { root, path: entry.path, kind: entry.info.isDirectory() ? 'directory' : 'file' });
  return { trash_id: id };
}

/**
 * The name a new entry takes in `folder`: its own when free; when taken, `replace` moves the old one into the
 * recycle area, `keep_both` picks a free name, and no choice answers `{ conflict: true }` without changing anything.
 */
function place_name(folder, name, conflict, recycle, origin, { source = '', rooms_in = null } = {}) {
  const target = join(folder, name);
  if (!existsSync(target)) return { name };
  // Replacing the very entry being pasted, or a folder that holds it, would recycle the source: both are kept instead.
  if (conflict === 'keep_both' || (conflict === 'replace' && source && inside(target, source))) return { name: free_name(folder, name) };
  if (conflict !== 'replace') return { conflict: true, name };
  const info = lstatSync(target);
  if (info.isSymbolicLink()) throw new Error('链接（含 Windows junction）不能在网页上改动');
  check_unused(target, info, rooms_in);
  recycle.keep(target, { ...origin, kind: info.isDirectory() ? 'directory' : 'file' });
  return { name };
}

/** Place a verified file beside its temporary copy, reusing the local upload naming and recycle rules. */
export function place_project_download({ root, path, name, temporary, conflict, recycle, publish }) {
  const folder = folder_in(root, path), wanted = check_name(name);
  const origin = { root, path: [...parts_of(path), wanted].join('/') };
  if (conflict === 'replace' && lstatSync(join(folder, wanted), { throwIfNoEntry: false })?.isDirectory())
    throw new Error(t('不能用云空间文件替换文件夹'));
  const { name: placed } = place_name(folder, wanted, conflict ?? 'keep_both', recycle, origin);
  publish(temporary, join(folder, placed));
  return [...parts_of(path), placed].join('/');
}

/**
 * Copy or move one entry into a folder, possibly of another root. A folder cannot go into itself; links inside a
 * copied folder are left out.
 */
export function paste_entry({ source_root, source_path, root, path, mode, conflict, recycle, rooms_in = null }) {
  if (!['copy', 'move'].includes(mode)) throw new Error('粘贴方式只能为复制或移动');
  const entry = entry_in(source_root, source_path);
  if (mode === 'move') check_unused(entry.target, entry.info, rooms_in);
  const folder = folder_in(root, path);
  if (entry.info.isDirectory() && inside(entry.target, folder)) throw new Error('不能把文件夹放进它自己或它的子文件夹');
  if (mode === 'move' && same_key(entry.parent) === same_key(folder)) return { path: entry.path, unchanged: true };
  if (mode === 'copy') copy_budget(entry.target);
  const placed = place_name(folder, entry.name, conflict, recycle, { root, path: [...parts_of(path), entry.name].join('/') }, { source: entry.target, rooms_in });
  if (placed.conflict) return placed;
  const target = join(folder, placed.name);
  if (mode === 'move') move_path(entry.target, target);
  else cpSync(entry.target, target, { recursive: true, errorOnExist: true, force: false, filter: source => !lstatSync(source).isSymbolicLink() });
  return { path: [...parts_of(path), placed.name].join('/') };
}

/**
 * Take one part of an upload into `parts_directory`; once every part is there, write the file into `path` under the
 * root in one step. Parts may be resent; an upload left unfinished for an hour is dropped. A name already taken
 * follows `conflict` (see `place_name`), and without a choice the file keeps both.
 */
export function upload_part({ root, path, name, upload_id, index, total, size, data, conflict, parts_directory, recycle }) {
  const wanted = check_name(name);
  if (typeof upload_id !== 'string' || !UPLOAD_ID.test(upload_id) || !Number.isSafeInteger(total) || total < 1
    || !Number.isSafeInteger(index) || index < 0 || index >= total || !Number.isSafeInteger(size) || size < 0 || typeof data !== 'string') {
    throw new Error('上传请求无效');
  }
  const limit = attachment_limit(dirname(parts_directory));
  if (size > limit * 1024 * 1024) throw new Error(t('单个文件不能超过 {value1} MiB', { value1: limit }));
  if (total > Math.ceil(size / UPLOAD_PART_MIN_BYTES) + 1) throw new Error('上传请求无效');
  const folder = folder_in(root, path);
  if (existsSync(parts_directory)) {
    for (const item of readdirSync(parts_directory)) {
      try { if (Date.now() - statSync(join(parts_directory, item)).mtimeMs > UPLOAD_STALE_MS) rmSync(join(parts_directory, item), { recursive: true, force: true }); } catch { /* Gone already. */ }
    }
  }
  // A part resent after the file was written (its answer lost on the way) gets that same answer, not a second file.
  const finished = join(parts_directory, `${upload_id}.done.json`);
  if (existsSync(finished)) return JSON.parse(readFileSync(finished, 'utf8'));
  const store = join(parts_directory, upload_id);
  mkdirSync(store, { recursive: true });
  const bytes_in = Buffer.from(data, 'base64');
  if (bytes_in.length > UPLOAD_PART_MAX_BYTES) throw new Error('上传请求无效');
  writeFileSync(join(store, `${index}.part`), bytes_in);
  const missing = [];
  let received = 0;
  for (let part = 0; part < total; part += 1) {
    const file = join(store, `${part}.part`);
    if (existsSync(file)) received += statSync(file).size; else missing.push(part);
  }
  // More than the declared size never reaches the disk for long, nor memory.
  if (received > size) { rmSync(store, { recursive: true, force: true }); throw new Error('上传的内容超过声明的大小，已放弃，请重新上传'); }
  if (missing.length) return { received: total - missing.length, missing };
  const bytes = Buffer.concat([...Array(total).keys()].map(part => readFileSync(join(store, `${part}.part`))));
  rmSync(store, { recursive: true, force: true });
  if (bytes.length !== size) throw new Error('文件不完整，请重新上传');
  const placed = place_name(folder, wanted, conflict || 'keep_both', recycle, { root, path: [...parts_of(path), wanted].join('/') });
  write_whole(join(folder, placed.name), bytes);
  const answer = { path: [...parts_of(path), placed.name].join('/'), size: bytes.length };
  writeFileSync(finished, JSON.stringify(answer));
  return answer;
}

/** Write a file in one step: a temporary file beside it, then a rename over it. */
function write_whole(target, bytes) {
  const temporary = join(dirname(target), `.${basename(target)}.${randomUUID().slice(0, 8)}.codiscuss-tmp`);
  writeFileSync(temporary, bytes);
  try { renameSync(temporary, target); } catch (error) { rmSync(temporary, { force: true }); throw error; }
}

const version_of = bytes => createHash('sha256').update(bytes).digest('hex').slice(0, 16);

/** Decode a whole text file the way the preview does (UTF-8, or UTF-16 with its byte order mark). */
function decode_text(bytes) {
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
  const bom = encoding !== 'utf-8' || (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf);
  let text;
  try { text = new TextDecoder(encoding, { fatal: true, ignoreBOM: false }).decode(bytes); } catch { text = null; }
  if (text === null || /[\u0000-\u0008\u000b\u000e-\u001f]/.test(text)) throw new Error('此文件为二进制或使用了暂不支持的文本编码，不能在网页上编辑');
  return { text, encoding, bom, eol: text.includes('\r\n') ? 'crlf' : 'lf' };
}

/** A whole text file for editing, with the version a save must name. Files over the edit limit are refused. */
export function read_text(root, path) {
  const entry = entry_in(root, path);
  if (!entry.info.isFile()) throw new Error('只能编辑普通文件');
  if (entry.info.size > EDIT_MAX_BYTES) throw new Error(`文件超过 ${EDIT_MAX_BYTES / 1024 / 1024} MB，不能在网页上编辑，请下载后修改再上传`);
  const bytes = readFileSync(entry.target);
  const { text, encoding, eol } = decode_text(bytes);
  return { path: entry.path, text, version: version_of(bytes), encoding, eol, size: bytes.length };
}

/**
 * Save an edited text file, keeping its encoding, byte order mark and line endings. When the file changed after
 * `version` was read (an AI member wrote it), nothing is written and the answer is `{ conflict: true }`.
 */
export function save_text(root, path, text, version) {
  if (typeof text !== 'string' || typeof version !== 'string') throw new Error('保存请求无效');
  const entry = entry_in(root, path);
  if (!entry.info.isFile()) throw new Error('只能编辑普通文件');
  const current = readFileSync(entry.target);
  if (version_of(current) !== version) return { conflict: true };
  const { encoding, bom, eol } = decode_text(current);
  let body = text.replace(/\r\n?/g, '\n');
  if (eol === 'crlf') body = body.replace(/\n/g, '\r\n');
  if (body.startsWith('﻿')) body = body.slice(1);
  let bytes = encoding === 'utf-8' ? Buffer.from(body, 'utf8') : Buffer.from(body, 'utf16le');
  if (encoding === 'utf-16be') bytes = Buffer.from(bytes).swap16();
  const mark = encoding === 'utf-16le' ? [0xff, 0xfe] : encoding === 'utf-16be' ? [0xfe, 0xff] : bom ? [0xef, 0xbb, 0xbf] : [];
  bytes = Buffer.concat([Buffer.from(mark), bytes]);
  if (bytes.length > EDIT_MAX_BYTES * 4) throw new Error('内容过长，无法保存');
  write_whole(entry.target, bytes);
  const info = statSync(entry.target);
  return { path: entry.path, version: version_of(bytes), size: info.size, modified_at: info.mtime.toISOString() };
}

/** Read-only directory and text previews, confined to a room's saved project directories. */
import { closeSync, fstatSync, openSync, readdirSync, readSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { adapter_profile } from './adapters/profiles.mjs';
import { PINYIN_TABLE } from './pinyin_table.mjs';

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

/** Folders whose contents are generated or vendored and would drown real matches. */
const SEARCH_SKIPPED = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', '.next', '.cache', '.wrangler']);
const SEARCH_RESULT_LIMIT = 50;
const SEARCH_VISIT_LIMIT = 20000;
const SEARCH_TIME_LIMIT_MS = 1500;

// Pinyin letters typed in place of hanzi, as while an input method is still composing ("hanc" for 寒潮).
const PINYIN_QUERY = /^[a-z0-9]+$/;
let pinyin_readings = null;

/** The toneless readings of one hanzi, or null for any other character. */
function readings_of(char) {
  if (!pinyin_readings) {
    pinyin_readings = new Map();
    for (const line of PINYIN_TABLE.split('\n')) {
      const syllable = line.match(/^[a-z]+/)[0];
      for (const hanzi of line.slice(syllable.length)) {
        if (!pinyin_readings.has(hanzi)) pinyin_readings.set(hanzi, []);
        pinyin_readings.get(hanzi).push(syllable);
      }
    }
  }
  return pinyin_readings.get(char) || null;
}

/**
 * Whether a run of the name's characters spells the letters: each hanzi by a leading part of one of its readings
 * (so "hanc", "hc" and "hanchao" all find 寒潮), any other character by itself.
 */
function pinyin_match(name, letters) {
  const chars = [...name.toLocaleLowerCase()];
  if (!chars.some(char => readings_of(char))) return false;
  const known = new Map();
  const spell = (at, used) => {
    if (used === letters.length) return true;
    if (at === chars.length) return false;
    const key = at * (letters.length + 1) + used;
    if (known.has(key)) return known.get(key);
    let found = false;
    const readings = readings_of(chars[at]);
    if (!readings) found = chars[at] === letters[used] && spell(at + 1, used + 1);
    for (const reading of readings || []) {
      for (let length = 1; !found && length <= reading.length && reading[length - 1] === letters[used + length - 1]; length += 1) {
        found = spell(at + 1, used + length);
      }
      if (found) break;
    }
    known.set(key, found);
    return found;
  };
  return chars.some((_, start) => spell(start, 0));
}

/** Rank a name match: exact name, then prefix, then substring, then pinyin; shallower and shorter paths first. */
function search_rank(name, path, needle) {
  const lower = name.toLocaleLowerCase();
  const tier = lower === needle ? 0 : lower.startsWith(needle) ? 1 : lower.includes(needle) ? 2 : 3;
  return [tier, path.split('/').length, path.length];
}

/** Find files and folders whose name (or path, when the query has a "/") contains the query, case-insensitively, under one root. */
function search_project_files(root, query) {
  const needle = query.trim().toLocaleLowerCase().replaceAll('\\', '/');
  if (!needle) throw new Error('搜索关键词不能为空');
  const by_path = needle.includes('/');
  const by_pinyin = !by_path && PINYIN_QUERY.test(needle);
  const deadline = Date.now() + SEARCH_TIME_LIMIT_MS;
  const matches = [];
  const queue = [''];
  let visited = 0, complete = true;
  while (queue.length) {
    if (visited >= SEARCH_VISIT_LIMIT || Date.now() > deadline) { complete = false; break; }
    const folder = queue.shift();
    let items;
    try { items = readdirSync(folder ? resolve(root, folder) : root, { withFileTypes: true }); } catch { continue; }
    for (const entry of items) {
      visited += 1;
      // Links are skipped so a search never leaves the project.
      if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) continue;
      const path = folder ? `${folder}/${entry.name}` : entry.name;
      if (entry.isDirectory() && !SEARCH_SKIPPED.has(entry.name)) queue.push(path);
      if ((by_path ? path : entry.name).toLocaleLowerCase().includes(needle) || (by_pinyin && pinyin_match(entry.name, needle))) {
        matches.push({ name: entry.name, path, kind: entry.isDirectory() ? 'directory' : 'file' });
      }
    }
  }
  return { matches, complete };
}

/** Rank and cut the matches of every searched directory together; each entry keeps the `root` it was found in. */
function search_result(query, searches) {
  const needle = query.trim().toLocaleLowerCase().replaceAll('\\', '/');
  const matches = searches.flatMap(({ matches: found }, root) => found.map(item => ({ ...item, root })));
  const ranked = matches.map(item => ({ item, rank: search_rank(item.name, item.path, needle) }))
    .sort((left, right) => left.rank[0] - right.rank[0] || left.rank[1] - right.rank[1] || left.rank[2] - right.rank[2]);
  return { query, kind: 'search', entries: ranked.slice(0, SEARCH_RESULT_LIMIT).map(({ item }) => item),
    total: matches.length, complete: searches.every(search => search.complete) };
}

/** The room's project directories: the main one (`cwd`) first, then the extra ones in the order they were added. */
export function room_directories(config) {
  return [config.cwd, ...(config.extra_directories || [])].filter(Boolean);
}

/** Whether `directory` is one of the room's project directories or lies inside one; Windows paths compare without case. */
export function inside_room(config, directory) {
  const key = path => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
  return room_directories(config).some(root => {
    const rest = relative(key(root), key(directory));
    return !rest.startsWith('..') && !isAbsolute(rest);
  });
}

/**
 * The directory a member works in when it lies outside every project directory of the room, or '' when it works in
 * one of them (or the room has none). Such a member only reads the room's directories. A member whose `cwd` is ''
 * joined before the room had a project: it keeps its own session's folder and is not outside.
 */
export function outside_directory(config, profile) {
  const cwd = profile?.cwd ?? config.cwd;
  return cwd && room_directories(config).length && !inside_room(config, cwd) ? cwd : '';
}

/**
 * Whether the room's directories stay read-only for this member by the software's own limits, not only by its task
 * text: at 只读 for any software whose levels the runner sets, at 可写 only where a sandbox or the file tools hold
 * (`limits_directories`); never for an App, a manual member's own permissions, 自动 or 全放开.
 */
export function read_only_enforced(profile) {
  const facts = adapter_profile(profile?.adapter);
  if (!facts?.access_levels) return false;
  return profile.project_access === 'read' || (profile.project_access === 'write' && Boolean(facts.capabilities.limits_directories));
}

/** The room's project root, resolved through links and required to be a folder. */
function project_root(cwd) {
  if (!cwd?.trim()) throw new Error('本房间未设置项目目录');
  const root = realpathSync(cwd);
  if (!statSync(root).isDirectory()) throw new Error('项目目录不是文件夹');
  return root;
}

/**
 * List one directory page or preview one file under one project directory, or search names under it; a search over
 * several directories is `search_project_roots`.
 */
export function read_project_files(cwd, path = '', offset = 0, query = '') {
  if (query) return search_project_roots([cwd], query);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('目录分页位置无效');
  const root = project_root(cwd);
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

/** Search names under every directory of a room at once; each entry's `root` is the index of its directory. */
export function search_project_roots(directories, query) {
  if (!directories.length) project_root('');
  return search_result(String(query), directories.map(directory => search_project_files(project_root(directory), String(query))));
}

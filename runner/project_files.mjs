/** Read-only directory and text previews, confined to a room's saved project directories; changes are `project_manage.mjs`. */
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, posix, relative, resolve } from 'node:path';
import { crc32, inflateRawSync } from 'node:zlib';
import { t } from './i18n.mjs';
import { adapter_capabilities, adapter_profile } from './adapters/profiles.mjs';
import { PINYIN_TABLE } from './pinyin_table.mjs';

const DIRECTORY_PAGE_SIZE = 200;
// Leave room for JSON escaping and base64 within the queued relay's 512 KiB encrypted envelope.
const PREVIEW_MAX_BYTES = 128 * 1024;
const DIRECTORY_MAX_BYTES = 128 * 1024;
// One request checks this many folders, and its answer stays within what a relayed reply carries.
const FOLDER_BATCH_LIMIT = 100;
const FOLDER_BATCH_BYTES = 192 * 1024;

/** Resolve a relative project path, including links, without allowing an escape from the project. */
export function project_path(root, path) {
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
 * (`limits_directories`); never for an App, a manual member's own permissions, 自动, 全放开 or software running without
 * its sandbox here (`no_sandbox`).
 */
export function read_only_enforced(profile) {
  const facts = adapter_profile(profile?.adapter), capabilities = adapter_capabilities(profile?.adapter);
  if (!facts?.access_levels || capabilities.no_sandbox) return false;
  return profile.project_access === 'read' || (profile.project_access === 'write' && Boolean(capabilities.limits_directories));
}

/** The room's project root, resolved through links and required to be a folder. */
export function project_root(cwd) {
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
  return directory_page(root, target, normalized, offset, info);
}

/** One page of a folder's entries, stamped with the folder's own change time read before its entries. */
function directory_page(root, target, normalized, offset, info) {
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
  return { path: normalized, kind: 'directory', modified_at: info.mtime.toISOString(), entries, total: items.length,
    next_offset: offset + entries.length < items.length ? offset + entries.length : null };
}

/**
 * Check many folders in one request, for the browser's cached file list. Each of `folders` (`{ path, modified_at }`, the
 * change time the browser holds) is answered in order: `unchanged` when a folder still has that time, `missing` when it
 * cannot be read, else its first page. An answer stops at the size a relayed reply carries; the caller asks again for the rest.
 */
export function read_project_folders(cwd, folders) {
  if (!Array.isArray(folders) || !folders.length || folders.length > FOLDER_BATCH_LIMIT
    || folders.some(folder => typeof folder?.path !== 'string')) throw new Error('文件夹列表无效');
  const root = project_root(cwd);
  const answers = [];
  let bytes = 0;
  for (const { path, modified_at: known } of folders) {
    const normalized = path.replaceAll('\\', '/').split('/').filter(part => part && part !== '.').join('/');
    let answer;
    try {
      const target = project_path(root, path);
      const info = statSync(target);
      if (!info.isDirectory()) answer = { path: normalized, missing: true };
      else if (info.mtime.toISOString() === known) answer = { path: normalized, unchanged: true };
      else answer = directory_page(root, target, normalized, 0, info);
    } catch { answer = { path: normalized, missing: true }; }
    bytes += Buffer.byteLength(JSON.stringify(answer));
    if (answers.length && bytes > FOLDER_BATCH_BYTES) break;
    answers.push(answer);
  }
  return answers;
}

// An HTML page with the files it refers to inlined stays within this size; references past it are left as they are.
export const PAGE_MAX_BYTES = 8 * 1024 * 1024;
// Media types of the files a page may refer to; others are left as they are.
const PAGE_TYPES = {
  css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', json: 'application/json', txt: 'text/plain', csv: 'text/csv',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml',
  ico: 'image/x-icon', bmp: 'image/bmp', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', mp4: 'video/mp4', webm: 'video/webm',
};
// Script and style bodies are kept apart so only real tags are rewritten; comments are left alone.
const PAGE_PARTS = /(<script\b[^>]*>)([\s\S]*?)(<\/script\s*>)|(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)|(<!--[\s\S]*?-->)|(<[a-zA-Z][^>]*>)/gi;
const TAG_ATTRIBUTE = /(\s)(src|poster|href|style)(\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;
const CSS_URL = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
const CSS_IMPORT = /@import\s+(['"])([^'"]+)\1/gi;

/** The project path a reference in the file at `base` (a folder) names, or null for other URLs (schemes, fragments). */
function page_reference(base, reference) {
  const value = reference.trim().replace(/&amp;/g, '&');
  if (!value || /^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(value)) return null;
  let path = value.replace(/[?#].*$/, '');
  try { path = decodeURIComponent(path); } catch { /* Kept as written. */ }
  return posix.normalize(path.startsWith('/') ? path.slice(1) : posix.join(base, path));
}

/** A referenced project file as a data URL (a style sheet with its own references inlined), or null when it is left as written. */
function page_resource(path, state, depth) {
  if (path === null) return null;
  if (state.inlined.has(path)) return state.inlined.get(path);
  const type = PAGE_TYPES[posix.extname(path).slice(1).toLowerCase()];
  if (!type) return null;
  let bytes;
  try {
    if (path.startsWith('..')) throw new Error('outside');
    const target = project_path(state.root, path);
    if (!statSync(target).isFile()) throw new Error('not a file');
    bytes = readFileSync(target);
  } catch { state.missing.add(path); return null; }
  if (type === 'text/css' && depth < 4) bytes = Buffer.from(page_css(bytes.toString('utf8'), posix.dirname(path), state, depth + 1));
  const url = `data:${type};base64,${bytes.toString('base64')}`;
  if (url.length > state.budget) { state.skipped.add(path); return null; }
  state.budget -= url.length;
  state.inlined.set(path, url);
  return url;
}

/** Inline the files a style sheet refers to; `base` is the folder its relative URLs start from. */
function page_css(css, base, state, depth) {
  return css.replace(CSS_IMPORT, (whole, quote, reference) => {
    const url = page_resource(page_reference(base, reference), state, depth);
    return url ? `@import url(${url})` : whole;
  }).replace(CSS_URL, (whole, quote, reference) => {
    const url = page_resource(page_reference(base, reference), state, depth);
    return url ? `url(${url})` : whole;
  });
}

/** Inline the files one tag refers to: `src`/`poster` of any tag, `href` of style sheets and icons, URLs in `style`. */
function page_tag(tag, base, state) {
  const name = /^<([a-zA-Z][\w-]*)/.exec(tag)[1].toLowerCase();
  const linked = name === 'link' && /\brel\s*=\s*["']?[^"'>]*\b(stylesheet|icon)\b/i.test(tag);
  return tag.replace(TAG_ATTRIBUTE, (whole, space, attribute, equals, double, single, bare) => {
    const value = double ?? single ?? bare;
    const key = attribute.toLowerCase();
    if (key === 'style') {
      const css = page_css(value, base, state, 0);
      return css === value ? whole : `${space}${attribute}${equals}"${css.replace(/"/g, '&quot;')}"`;
    }
    if (key === 'href' && !linked) return whole;
    const url = page_resource(page_reference(base, value), state, 0);
    return url ? `${space}${attribute}${equals}"${url}"` : whole;
  });
}

/**
 * One HTML file of a project with the style sheets, scripts, images, fonts and media it refers to by relative path
 * inlined as data URLs, so it shows in full where only its text can be sent (another device, through the relay).
 * Only files inside the project directory are read; references that are missing, outside it or past the size limit
 * are left as written and listed. Resources a script asks for while running are not included.
 */
export function bundle_project_page(cwd, path) {
  const root = project_root(cwd);
  const target = project_path(root, path);
  if (!/\.html?$/i.test(target)) throw new Error('只能打开 HTML 文件');
  const info = statSync(target);
  if (!info.isFile()) throw new Error('只能预览普通文件');
  if (info.size > PAGE_MAX_BYTES) throw new Error('HTML 文件超过 8 MiB，无法完整显示');
  const normalized = path.replaceAll('\\', '/').split('/').filter(part => part && part !== '.').join('/');
  const base = posix.dirname(normalized);
  const state = { root, budget: PAGE_MAX_BYTES - info.size, inlined: new Map(), missing: new Set(), skipped: new Set() };
  const html = readFileSync(target, 'utf8').replace(PAGE_PARTS, (whole, script_open, script_body, script_close, style_open, style_body, style_close, comment, tag) => {
    if (script_open) return page_tag(script_open, base, state) + script_body + script_close;
    if (style_open) return style_open + page_css(style_body, base, state, 0) + style_close;
    return comment ?? page_tag(tag, base, state);
  });
  const bytes = Buffer.from(html, 'utf8');
  return { path: normalized, bytes, version: createHash('sha256').update(bytes).digest('hex').slice(0, 16), modified_at: info.mtime.toISOString(),
    missing: [...state.missing], skipped: [...state.skipped] };
}

// Images a Markdown file shows: inline `![alt](path "title")`, `![alt](<path with spaces>)` and reference definitions `[id]: path`.
const MARKDOWN_IMAGE = /!\[[^\]]*\]\(\s*(?:<([^>]+)>|([^)\s]+))/g;
const MARKDOWN_DEFINITION = /^ {0,3}\[[^\]]+\]:\s*(?:<([^>]+)>|(\S+))/gm;
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'bmp', 'ico'];

/**
 * The project images one Markdown file refers to by relative path, as `{project path: data URL}` (JSON bytes, sent
 * like a page), so the preview shows them where only text reaches the page (another device, through the relay). The
 * preview resolves each rendered image the same way (`frontend/file-preview.js` `markdown_image_path`). Only image
 * files inside the project are read; missing ones and those past the size limit are listed instead.
 */
export function bundle_project_markdown(cwd, path) {
  const root = project_root(cwd);
  const target = project_path(root, path);
  if (!/\.(md|markdown)$/i.test(target)) throw new Error('只能打开 Markdown 文件');
  const info = statSync(target);
  if (!info.isFile()) throw new Error('只能预览普通文件');
  if (info.size > PAGE_MAX_BYTES) throw new Error('Markdown 文件超过 8 MiB，图片不载入');
  const normalized = path.replaceAll('\\', '/').split('/').filter(part => part && part !== '.').join('/');
  const base = posix.dirname(normalized);
  const state = { root, budget: PAGE_MAX_BYTES, inlined: new Map(), missing: new Set(), skipped: new Set() };
  const text = readFileSync(target, 'utf8');
  for (const match of [...text.matchAll(MARKDOWN_IMAGE), ...text.matchAll(MARKDOWN_DEFINITION)]) {
    const reference = page_reference(base, match[1] ?? match[2]);
    // A definition may name a link rather than an image; only image files are read.
    if (reference !== null && IMAGE_EXTENSIONS.includes(posix.extname(reference).slice(1).toLowerCase())) page_resource(reference, state, 0);
  }
  const bytes = Buffer.from(JSON.stringify(Object.fromEntries(state.inlined)), 'utf8');
  return { path: normalized, bytes, version: createHash('sha256').update(bytes).digest('hex').slice(0, 16), modified_at: info.mtime.toISOString(),
    missing: [...state.missing], skipped: [...state.skipped] };
}

// Binary files the preview reads whole, by extension: images and media for its viewer and players (the browser decides
// what it can decode), Office documents and compressed edit projects for its document previews.
export const MEDIA_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml',
  bmp: 'image/bmp', ico: 'image/x-icon',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska', ogv: 'video/ogg',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac',
  // Office documents and the compressed Premiere project, read whole by the page's previews.
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls: 'application/vnd.ms-excel',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', prproj: 'application/gzip',
  pdf: 'application/pdf',
  // A zip archive, listed and unpacked by the page's preview.
  zip: 'application/zip',
};

/**
 * One image, video, audio, Office or compressed edit-project file of a project, checked like any preview: inside the project, a regular file of a
 * known media type (any regular file with `download`, as plain bytes). Returns its real path (for the local site to
 * stream), size, type and a version that changes with it.
 */
export function project_media(cwd, path, { download = false } = {}) {
  const root = project_root(cwd);
  const target = project_path(root, path);
  const content_type = MEDIA_TYPES[posix.extname(target.replaceAll('\\', '/')).slice(1).toLowerCase()] || (download ? 'application/octet-stream' : '');
  if (!content_type) throw new Error('只能打开图片、音视频、Office 文档、剪辑工程或压缩包');
  const info = statSync(target);
  if (!info.isFile()) throw new Error('只能预览普通文件');
  return { file: target, size: info.size, content_type, modified_at: info.mtime.toISOString(), version: `${info.mtimeMs}:${info.size}` };
}

const ZIP_END_BYTES = 22;
const ZIP_MAX_COMMENT = 65535;
const ZIP_ENTRY_LIMIT = 64 * 1024 * 1024;
const ZIP_DIRECTORY_LIMIT = 16 * 1024 * 1024;
const ZIP_PART_BYTES = 192 * 1024;
const zip_utf8 = new TextDecoder('utf-8', { fatal: true });
const zip_gbk = new TextDecoder('gbk');
let last_zip_entry;

function invalid_zip() { return new Error(t('无法读取 ZIP 压缩包')); }

/** Read exactly one validated region of the open archive. */
function zip_region(fd, offset, length, end) {
  if (offset < 0 || length < 0 || offset + length > end) throw invalid_zip();
  const buffer = Buffer.alloc(length);
  for (let read = 0; read < length;) {
    const count = readSync(fd, buffer, read, length - read, offset + read);
    if (!count) throw invalid_zip();
    read += count;
  }
  return buffer;
}

function zip_name(raw, flags) {
  let name;
  try { name = zip_utf8.decode(raw); }
  catch { if (flags & 0x800) throw invalid_zip(); name = zip_gbk.decode(raw); }
  name = name.replaceAll('\\', '/');
  return /[\x00-\x1f\x7f:]/.test(name) || name.split('/').some(part => ['', '.', '..', '__MACOSX', '.DS_Store'].includes(part)) ? '' : name;
}

/** Locate the end record. Archives without a comment need only the final 22 bytes. */
function zip_directory(fd, size) {
  let end = size - ZIP_END_BYTES;
  let record = zip_region(fd, end, ZIP_END_BYTES, size);
  if (record.readUInt32LE(0) !== 0x06054b50 || record.readUInt16LE(20)) {
    const start = Math.max(0, end - ZIP_MAX_COMMENT), tail = zip_region(fd, start, size - start, size);
    let cursor = tail.length - ZIP_END_BYTES;
    for (; cursor >= 0; cursor--) {
      if (tail.readUInt32LE(cursor) === 0x06054b50 && cursor + ZIP_END_BYTES + tail.readUInt16LE(cursor + 20) === tail.length) break;
    }
    if (cursor < 0) throw invalid_zip();
    end = start + cursor;
    record = tail.subarray(cursor);
  }
  const count = record.readUInt16LE(10), length = record.readUInt32LE(12), offset = record.readUInt32LE(16);
  if (record.readUInt32LE(4) || count !== record.readUInt16LE(8) || length > ZIP_DIRECTORY_LIMIT || offset + length !== end) throw invalid_zip();
  const directory = zip_region(fd, offset, length, end), entries = new Map();
  let cursor = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > length || directory.readUInt32LE(cursor) !== 0x02014b50) throw invalid_zip();
    const row = directory.subarray(cursor), name_length = row.readUInt16LE(28);
    cursor += 46 + name_length + row.readUInt16LE(30) + row.readUInt16LE(32);
    if (cursor > length) throw invalid_zip();
    const flags = row.readUInt16LE(8), raw = row.subarray(46, 46 + name_length), path = zip_name(raw, flags);
    if (!path || entries.has(path)) continue;
    const date = row.readUInt16LE(14), time = row.readUInt16LE(12);
    const modified_at = date ? new Date(1980 + (date >> 9), ((date >> 5) & 15) - 1, date & 31, time >> 11, (time >> 5) & 63, (time & 31) * 2).toISOString() : '';
    entries.set(path, { path, size: row.readUInt32LE(24), modified_at, encrypted: Boolean(flags & 1),
      raw, local: row.readUInt32LE(42), method: row.readUInt16LE(10), compressed: row.readUInt32LE(20), crc: row.readUInt32LE(16) });
  }
  return { entries, offset };
}

function unzip_file(fd, item, end) {
  if (!item || item.encrypted || ![0, 8].includes(item.method)) throw new Error(t('无法读取这个压缩包条目'));
  if (item.size > ZIP_ENTRY_LIMIT || item.compressed > ZIP_ENTRY_LIMIT + 1024 * 1024) throw new Error(t('压缩包内单个文件最多预览 64 MiB'));
  const header = zip_region(fd, item.local, 30, end);
  const name_length = header.readUInt16LE(26);
  if (header.readUInt32LE() !== 0x04034b50 || header.readUInt16LE(8) !== item.method || header.readUInt16LE(6) & 1
      || !zip_region(fd, item.local + 30, name_length, end).equals(item.raw)) throw invalid_zip();
  const start = item.local + 30 + name_length + header.readUInt16LE(28);
  const compressed = zip_region(fd, start, item.compressed, end);
  let bytes = compressed;
  if (item.method === 8) {
    try { bytes = inflateRawSync(compressed, { maxOutputLength: Math.max(1, item.size) }); }
    catch { throw invalid_zip(); }
  }
  if (bytes.length !== item.size || crc32(bytes) !== item.crc) throw invalid_zip();
  return bytes;
}

/** List a project's ZIP directory, or return one bounded part of a selected entry. */
export function project_zip(directory, input, relayed = false) {
  const { file } = project_media(directory, input.path);
  const fd = openSync(file, 'r');
  try {
    const stat = fstatSync(fd);
    const version = [stat.ino, stat.ctimeMs, stat.mtimeMs, stat.size].join(':');
    const key = JSON.stringify([file, version, input.entry_path]);
    const offset = input.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw invalid_zip();
    if (input.op === 'zip-list' || last_zip_entry?.key !== key) {
      const archive = zip_directory(fd, stat.size);
      if (input.op === 'zip-list') return { entries: Array.from(archive.entries.values(), ({ path, size, modified_at, encrypted }) => ({ path, size, modified_at, encrypted })) };
      last_zip_entry = { key, bytes: unzip_file(fd, archive.entries.get(input.entry_path), archive.offset) };
    }
    const bytes = last_zip_entry.bytes;
    if (offset > bytes.length) throw invalid_zip();
    // The local bridge runs one CLI process per call. Send the chosen entry once there.
    const part = relayed ? bytes.subarray(offset, offset + ZIP_PART_BYTES) : bytes.subarray(offset);
    return { total: bytes.length, offset, version, data: part.toString('base64') };
  } finally { closeSync(fd); }
}

/** Search names under every directory of a room at once; each entry's `root` is the index of its directory. */
export function search_project_roots(directories, query) {
  if (!directories.length) project_root('');
  return search_result(String(query), directories.map(directory => search_project_files(project_root(directory), String(query))));
}

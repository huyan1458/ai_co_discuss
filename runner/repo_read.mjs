/** Read-only listing, reading and literal search inside one open project directory, for external members. */
import { execFile } from 'node:child_process';
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

// Leave room for JSON escaping and base64 within the relay's 512 KiB encrypted envelope.
export const REPO_READ_MAX_BYTES = 128 * 1024;
export const REPO_RESULT_MAX_BYTES = 128 * 1024;
export const REPO_REJECTIONS = Object.freeze([
  'invalid_root', 'scope_unavailable', 'invalid_path', 'absolute_path', 'path_traversal', 'excluded',
  'not_in_scope', 'outside_root', 'not_a_file', 'not_a_directory', 'binary', 'invalid_query', 'invalid_argument',
]);

const PATH_MAX_LENGTH = 4096;
const LIST_DEFAULT_LIMIT = 200;
const LIST_MAX_LIMIT = 1000;
const GREP_DEFAULT_RESULTS = 100;
const GREP_MAX_RESULTS = 500;
const GREP_QUERY_MAX_LENGTH = 256;
const GREP_FILE_MAX_BYTES = 2 * 1024 * 1024;
const GREP_SCAN_MAX_BYTES = 32 * 1024 * 1024;
const GREP_TIME_LIMIT_MS = 3000;
const GREP_TIME_LIMIT_MAX_MS = 30000;
const GREP_LINE_MAX_CHARS = 400;
const WALK_MAX_FILES = 200000;
const GIT_TIMEOUT_MS = 15000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000e-\u001f]/;

/** Generated or vendored folders a plain walk skips; Git directories rely on .gitignore instead. */
const WALK_SKIPPED = new Set(['node_modules', '__pycache__', '.venv', 'venv', '.next', '.cache']);
const DIRECTORY_RULES = new Map([
  ['.git', 'dotgit'],
  ...['.ssh', '.aws', '.gnupg', '.docker', '.kube', '.azure', '.wrangler'].map((name) => [name, 'credential_dir']),
]);
const ENV_NAMES = new Set(['.env', '.envrc', '.dev.vars']);
const KEY_EXTENSIONS = ['.pem', '.key', '.p12', '.pfx', '.jks', '.keystore', '.ppk', '.kdbx'];
const KEY_PREFIXES = ['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519'];
const CREDENTIAL_NAMES = new Set(['.npmrc', '.pypirc', '.netrc', '_netrc', '.git-credentials', '.htpasswd',
  'credentials', 'credentials.json', 'wrangler.local.jsonc']);

const reject = (reason, detail) => (detail ? { ok: false, reason, detail } : { ok: false, reason });
const json_bytes = (value) => Buffer.byteLength(JSON.stringify(value));

/** The fixed exclusion rule a relative path hits (case-insensitive; `data` only at the open directory's root), or null. */
export function repo_excluded(path) {
  const segments = String(path).replaceAll('\\', '/').split('/').filter(Boolean).map((part) => part.toLowerCase());
  // The room data folder lives at a project's root; data/ folders deeper down are ordinary content.
  if (segments[0] === 'data') return 'data_dir';
  for (const segment of segments) if (DIRECTORY_RULES.has(segment)) return DIRECTORY_RULES.get(segment);
  const name = segments.at(-1);
  if (!name) return null;
  if (ENV_NAMES.has(name) || name.startsWith('.env.') || name.endsWith('.env')) return 'env_file';
  if (KEY_EXTENSIONS.some((ext) => name.endsWith(ext)) || KEY_PREFIXES.some((prefix) => name.startsWith(prefix))) return 'private_key';
  if (CREDENTIAL_NAMES.has(name) || name.startsWith('secrets.') || name.endsWith('.secret')) return 'credential_file';
  return null;
}

/** Normalize a caller's relative path to '/'-joined segments, or explain why it is refused. */
function normalize_path(path) {
  if (typeof path !== 'string' || path.length > PATH_MAX_LENGTH || path.includes('\0')) return reject('invalid_path');
  const slashed = path.replaceAll('\\', '/');
  if (slashed.startsWith('/') || /^[a-zA-Z]:/.test(slashed) || isAbsolute(path)) return reject('absolute_path');
  if (slashed.includes(':') || CONTROL_CHARS.test(slashed)) return reject('invalid_path');
  const segments = slashed.split('/').filter((part) => part && part !== '.');
  if (segments.includes('..')) return reject('path_traversal');
  // Windows drops trailing dots and spaces, so ".env." would open ".env".
  if (segments.some((part) => /[. ]$/.test(part))) return reject('invalid_path');
  return { ok: true, path: segments.join('/') };
}

function natural_int(value, fallback) {
  if (value === undefined || value === null) return fallback;
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function inside(root_real, target_real) {
  const rel = relative(root_real, target_real);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Whether `root` sits in a Git work tree, judged by a `.git` entry in it or any parent. */
async function in_git_work_tree(root_real) {
  for (let dir = root_real; ; dir = dirname(dir)) {
    try { await lstat(join(dir, '.git')); return true; } catch { /* keep climbing */ }
    if (dirname(dir) === dir) return false;
  }
}

function git_list(root_real) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  return new Promise((resolve) => {
    execFile('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
      cwd: root_real, env, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, windowsHide: true, encoding: 'buffer',
    }, (error, stdout, stderr) => {
      if (error) {
        const line = String(stderr || error.message).split(/\r?\n/).find(Boolean) || 'git failed';
        resolve(reject('scope_unavailable', line.slice(0, 200)));
      } else resolve({ ok: true, files: stdout.toString('utf8').split('\0').filter(Boolean) });
    });
  });
}

/** Breadth-first walk that never descends links or junctions and skips excluded or generated folders. */
async function walk_list(root_real) {
  const files = [];
  const queue = [''];
  while (queue.length) {
    const dir = queue.shift();
    let entries;
    try { entries = await readdir(join(root_real, dir), { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const child = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!WALK_SKIPPED.has(entry.name.toLowerCase()) && !repo_excluded(child)) queue.push(child);
      } else {
        if (files.length >= WALK_MAX_FILES) return { files, truncated: true };
        files.push(child);
      }
    }
  }
  return { files, truncated: false };
}

/** The candidate file list for `root`, already filtered by the fixed exclusions. */
async function load_scope(root) {
  if (typeof root !== 'string') throw new TypeError('root must be a string');
  if (!isAbsolute(root)) return reject('invalid_root');
  let root_real;
  try {
    root_real = await realpath(root);
    if (!(await stat(root_real)).isDirectory()) return reject('invalid_root');
  } catch { return reject('invalid_root'); }
  let mode, files, truncated = false;
  if (await in_git_work_tree(root_real)) {
    const listed = await git_list(root_real);
    if (!listed.ok) return listed;
    mode = 'git'; files = listed.files;
  } else {
    ({ files, truncated } = await walk_list(root_real));
    mode = 'walk';
  }
  files = [...new Set(files)].filter((file) => !repo_excluded(file)).sort();
  return { ok: true, root_real, mode, truncated, files, set: new Set(files) };
}

/** Real path of a listed entry if it stays inside the root; `outside_root` or `not_in_scope` otherwise. */
async function resolve_inside(scope, path) {
  let target;
  try { target = await realpath(join(scope.root_real, path)); } catch { return reject('not_in_scope'); }
  if (!inside(scope.root_real, target)) return reject('outside_root');
  return { ok: true, target };
}

/** Shared front half of every operation: root, path syntax, fixed exclusions. */
async function prepare(root, path) {
  const normalized = normalize_path(path);
  if (!normalized.ok) return normalized;
  const rule = repo_excluded(normalized.path);
  if (rule) return reject('excluded', rule);
  const scope = await load_scope(root);
  if (!scope.ok) return scope;
  return { ok: true, scope, path: normalized.path };
}

function has_children(scope, path) {
  const prefix = path ? `${path}/` : '';
  return scope.files.some((file) => file.startsWith(prefix));
}

/** List one directory of the open project, one page at a time. */
export async function repo_list(root, path = '', { offset = 0, limit = LIST_DEFAULT_LIMIT } = {}) {
  const start = natural_int(offset, 0), size = natural_int(limit, LIST_DEFAULT_LIMIT);
  if (start === null || size === null || size < 1) return reject('invalid_argument');
  const prepared = await prepare(root, path);
  if (!prepared.ok) return prepared;
  const { scope, path: dir } = prepared;
  if (dir) {
    const listed = scope.set.has(dir);
    if (!listed && !has_children(scope, dir)) return reject('not_in_scope');
    const resolved = await resolve_inside(scope, dir);
    if (!resolved.ok) return resolved;
    if (listed) return reject('not_a_directory');
  }
  const prefix = dir ? `${dir}/` : '';
  const children = new Map();
  for (const file of scope.files) {
    if (!file.startsWith(prefix)) continue;
    const rest = file.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash >= 0) children.set(rest.slice(0, slash), 'directory');
    else if (!children.has(rest)) children.set(rest, 'file');
  }
  const names = [...children.keys()].sort((a, b) => (children.get(a) === children.get(b)
    ? (a < b ? -1 : a > b ? 1 : 0) : children.get(a) === 'directory' ? -1 : 1));
  const entries = [];
  let index = start, used = 2;
  const limit_index = Math.min(names.length, start + Math.min(size, LIST_MAX_LIMIT));
  for (; index < limit_index; index += 1) {
    const name = names[index], child = prefix + name;
    let entry = { name, path: child, kind: 'directory', size: null };
    const resolved = await resolve_inside(scope, child);
    if (!resolved.ok) continue;
    if (children.get(name) === 'file') {
      let info;
      try { info = await stat(resolved.target); } catch { continue; }
      if (!info.isFile() && !info.isDirectory()) continue;
      entry = { name, path: child, kind: info.isFile() ? 'file' : 'directory', size: info.isFile() ? info.size : null };
    }
    const cost = json_bytes(entry) + 1;
    if (entries.length && used + cost > REPO_RESULT_MAX_BYTES) break;
    entries.push(entry); used += cost;
  }
  return { ok: true, kind: 'directory', scope_mode: scope.mode, scope_truncated: scope.truncated, path: dir,
    entries, total: names.length, next_offset: index < names.length ? index : null, bytes: json_bytes(entries) };
}

function detect_encoding(head) {
  if (head[0] === 0xff && head[1] === 0xfe) return 'utf-16le';
  if (head[0] === 0xfe && head[1] === 0xff) return 'utf-16be';
  return 'utf-8';
}

/** Decode bytes as text, or null when they look binary or are not valid in the encoding. */
function decode_text(bytes, encoding) {
  try {
    const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    return CONTROL_CHARS.test(text) ? null : text;
  } catch { return null; }
}

/** Trim a UTF-8 slice so it starts and ends on character boundaries; returns [skip_start, keep_length]. */
function utf8_bounds(bytes, at_start, at_end) {
  let skip = 0;
  if (!at_start) while (skip < bytes.length && skip < 3 && (bytes[skip] & 0xc0) === 0x80) skip += 1;
  let end = bytes.length;
  if (!at_end) {
    let back = end - 1;
    while (back > skip && end - back < 4 && (bytes[back] & 0xc0) === 0x80) back -= 1;
    const lead = bytes[back], need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
    if (back + need > end) end = back;
  }
  return [skip, end];
}

/** Read up to 128 KiB of one in-scope text file, starting at a byte offset. */
export async function repo_read(root, path, { offset = 0, max_bytes = REPO_READ_MAX_BYTES } = {}) {
  const start = natural_int(offset, 0), wanted = natural_int(max_bytes, REPO_READ_MAX_BYTES);
  if (start === null || wanted === null || wanted < 1) return reject('invalid_argument');
  const prepared = await prepare(root, path);
  if (!prepared.ok) return prepared;
  const { scope, path: file } = prepared;
  if (file === '') return reject('not_a_file');
  const listed = scope.set.has(file);
  if (!listed && !has_children(scope, file)) return reject('not_in_scope');
  const resolved = await resolve_inside(scope, file);
  if (!resolved.ok) return resolved;
  if (!listed) return reject('not_a_file');
  let handle;
  try { handle = await open(resolved.target, 'r'); } catch { return reject('not_in_scope'); }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return reject('not_a_file');
    const head = Buffer.alloc(2);
    await handle.read(head, 0, 2, 0);
    const encoding = detect_encoding(head);
    let from = Math.min(start, info.size);
    if (encoding !== 'utf-8') from -= from % 2;
    const length = Math.min(Math.min(wanted, REPO_READ_MAX_BYTES), info.size - from);
    const bytes = Buffer.alloc(length);
    const { bytesRead } = await handle.read(bytes, 0, length, from);
    let slice = bytes.subarray(0, bytesRead);
    if (encoding === 'utf-8') {
      const [skip, end] = utf8_bounds(slice, from === 0, from + bytesRead >= info.size);
      slice = slice.subarray(skip, end); from += skip;
    } else if (slice.length % 2) slice = slice.subarray(0, slice.length - 1);
    const text = decode_text(slice, encoding);
    if (text === null) return reject('binary');
    const next = from + slice.length;
    return { ok: true, kind: 'file', scope_mode: scope.mode, path: file, size: info.size, modified_at: info.mtime.toISOString(),
      encoding, offset: from, bytes: slice.length, next_offset: next < info.size ? next : null, truncated: next < info.size, text };
  } finally { await handle.close(); }
}

function clip_line(line, column, length) {
  if (line.length <= GREP_LINE_MAX_CHARS) return line;
  const begin = Math.max(0, Math.min(column - Math.floor((GREP_LINE_MAX_CHARS - length) / 2), line.length - GREP_LINE_MAX_CHARS));
  return line.slice(begin, begin + GREP_LINE_MAX_CHARS);
}

/** Read one search candidate whole, or null when it is skipped (too large, binary, unreadable, outside). */
async function grep_text(scope, file) {
  const resolved = await resolve_inside(scope, file);
  if (!resolved.ok) return { skipped: false, text: null };
  let handle;
  try { handle = await open(resolved.target, 'r'); } catch { return { skipped: false, text: null }; }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { skipped: false, text: null };
    if (info.size > GREP_FILE_MAX_BYTES) return { skipped: true, text: null };
    const bytes = Buffer.alloc(info.size);
    const { bytesRead } = await handle.read(bytes, 0, info.size, 0);
    const slice = bytes.subarray(0, bytesRead);
    const text = decode_text(slice, detect_encoding(slice));
    return { skipped: text === null, text, size: bytesRead };
  } finally { await handle.close(); }
}

/** Literal (non-regex) search over in-scope text files, bounded by results, bytes and time. */
export async function repo_grep(root, query, { path = '', case_sensitive = false, max_results = GREP_DEFAULT_RESULTS, max_bytes = REPO_RESULT_MAX_BYTES, time_limit_ms = GREP_TIME_LIMIT_MS } = {}) {
  if (typeof query !== 'string' || !query || query.length > GREP_QUERY_MAX_LENGTH || /[\r\n]/.test(query)) return reject('invalid_query');
  const result_limit = natural_int(max_results, GREP_DEFAULT_RESULTS), byte_limit = natural_int(max_bytes, REPO_RESULT_MAX_BYTES);
  const time_limit = natural_int(time_limit_ms, GREP_TIME_LIMIT_MS);
  if (result_limit === null || byte_limit === null || time_limit === null || result_limit < 1 || byte_limit < 1) return reject('invalid_argument');
  const prepared = await prepare(root, path);
  if (!prepared.ok) return prepared;
  const { scope, path: base } = prepared;
  const listed = scope.set.has(base);
  if (base) {
    if (!listed && !has_children(scope, base)) return reject('not_in_scope');
    const resolved = await resolve_inside(scope, base);
    if (!resolved.ok) return resolved;
  }
  const candidates = listed ? [base] : scope.files.filter((file) => !base || file.startsWith(`${base}/`));
  const needle = case_sensitive ? query : query.toLowerCase();
  const results = Math.min(result_limit, GREP_MAX_RESULTS), budget = Math.min(byte_limit, REPO_RESULT_MAX_BYTES);
  const deadline = Date.now() + Math.min(time_limit, GREP_TIME_LIMIT_MAX_MS);
  const matches = [];
  let used = 2, files_scanned = 0, files_skipped = 0, scanned_bytes = 0, truncated_by = null;
  scan: for (const file of candidates) {
    if (Date.now() >= deadline) { truncated_by = 'time'; break; }
    if (scanned_bytes >= GREP_SCAN_MAX_BYTES) { truncated_by = 'scan_bytes'; break; }
    const { skipped, text, size } = await grep_text(scope, file);
    if (skipped) files_skipped += 1;
    if (text === null) continue;
    files_scanned += 1; scanned_bytes += size;
    const lines = text.split(/\r?\n/);
    for (let number = 0; number < lines.length; number += 1) {
      const line = lines[number];
      const column = (case_sensitive ? line : line.toLowerCase()).indexOf(needle);
      if (column < 0) continue;
      if (matches.length >= results) { truncated_by = 'results'; break scan; }
      const match = { path: file, line: number + 1, text: clip_line(line, column, needle.length) };
      const cost = json_bytes(match) + 1;
      if (used + cost > budget) { truncated_by = 'bytes'; break scan; }
      matches.push(match); used += cost;
    }
  }
  return { ok: true, scope_mode: scope.mode, scope_truncated: scope.truncated, query, path: base, matches,
    files_scanned, files_skipped, scanned_bytes, truncated: truncated_by !== null, truncated_by, bytes: json_bytes(matches) };
}

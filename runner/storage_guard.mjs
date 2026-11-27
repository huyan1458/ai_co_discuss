/** Local storage and disk-reserve guard for the service home (`~/.codiscuss`). */
import { AsyncLocalStorage } from 'node:async_hooks';
import { statfsSync, statSync } from 'node:fs';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { t } from './i18n.mjs';
import { speech_model_directories } from './speech_directories.mjs';

const directory_breakdown = new AsyncLocalStorage();

/** Collect directory totals from the report's home scan, isolated from concurrent panel requests. */
export async function with_directory_breakdown(read_report) {
  const groups = { local: 0, drafts: 0, launches: 0, 'panel-window': 0, pi: 0, other: 0 };
  const report = await directory_breakdown.run(groups, read_report);
  return { ...report, groups };
}

export const KIB = 1024;
export const MIB = 1024 ** 2;
export const GIB = 1024 ** 3;

export const ROOM_DRAFT_LIMIT = 1 * GIB;
export const DRAFT_LIMIT = 3 * GIB;
export const HOME_WARN = 8 * GIB;
export const HOME_LIMIT = 10 * GIB;
export const LOG_TAIL = 16 * MIB;

export const DISK_RESERVE_MIN = 10 * GIB;
export const DISK_RESERVE_MAX = 30 * GIB;
export const DISK_RESERVE_RATIO = 0.05;
export const MAX_SCAN_FILES = 200_000;
export const SCRATCH_PRESSURE_RATIO = 0.8;
export const DISK_CHECK_MS = 2_000;

// Legacy local speech model directories inside `~/.codiscuss`; excluded from the 10 GiB data budget.
export const MODEL_DIRS = ['yovoice', 'crispasr'];

const DRAFTS_DIR = 'drafts';
const LOCAL_DIR = 'local';
const STAT_BATCH = 32;
const BYTE_UNITS = [[GIB, 'GiB'], [MIB, 'MiB'], [KIB, 'KiB']];

/** Normalize a directory name or path for case comparison on the current platform. */
function path_key(value) {
  return process.platform === 'win32' ? String(value).toLowerCase() : String(value);
}

/** Rewrite a path under `logical_root` onto `real_root` when the service root itself is a link or junction. */
function remap_root(target, logical_root, real_root) {
  const full = resolve(target);
  if (path_key(logical_root) === path_key(real_root)) return full;
  const rel = relative(logical_root, full);
  if (rel === '') return real_root;
  if (!rel.startsWith('..') && rel !== '..' && !/^([a-zA-Z]:|[\\/])/.test(rel)) return join(real_root, rel);
  return full;
}

/**
 * Format a byte count into a human-readable IEC unit string (e.g. `1.5 GiB`, `10 GiB`, `512 MiB`).
 * @param {number} bytes Non-negative byte count.
 * @returns {string} Formatted size string.
 */
export function format_bytes(bytes) {
  const safe = Math.max(0, Number(bytes) || 0);
  for (const [unit, label] of BYTE_UNITS) {
    if (safe >= unit) {
      const value = safe / unit;
      const text = Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, '');
      return `${text} ${label}`;
    }
  }
  return `${Math.round(safe)} B`;
}

/** Safely lstat one path, skipping missing entries and counting unreadable ones. */
async function safe_lstat(path, state, lstat_fn, room_key = '') {
  try {
    return await lstat_fn(path, { bigint: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') count_unreadable(state, room_key);
    return null;
  }
}

/** Count one unreadable entry, also attributing it to the room draft directory that holds it. */
function count_unreadable(state, room_key = '') {
  state.unreadable += 1;
  if (room_key && state.room_unreadable) state.room_unreadable[room_key] = (state.room_unreadable[room_key] || 0) + 1;
}

/** Resolve the service root itself through a symlink or Windows junction without following nested links later. */
async function resolve_root(path, state, realpath_fn) {
  try {
    return await realpath_fn(path);
  } catch (error) {
    if (error?.code !== 'ENOENT') state.unreadable += 1;
    return '';
  }
}

/** Build normalized excluded path keys, including active speech model paths configured via `*-root.txt`. */
async function build_excluded_paths(logical_root, real_root, options, state, realpath_fn) {
  const raw = [...(options.exclude_paths || []).filter(Boolean)];
  if (options.model_dirs === undefined) {
    try {
      for (const item of speech_model_directories(logical_root)) raw.push(item.path);
    } catch { state.unreadable += 1; }
  }
  const excluded = new Set();
  for (const item of raw) {
    excluded.add(path_key(remap_root(item, logical_root, real_root)));
    try { excluded.add(path_key(await realpath_fn(item))); } catch { /* Missing or unreadable optional model path. */ }
  }
  return excluded;
}

/** Build a case-normalized scratch lookup map that matches paths after resolving a junctioned service root. */
function build_scratch_lookup(scratch, logical_root, real_root) {
  if (!scratch) return null;
  const map = new Map();
  for (const [key, value] of scratch.entries()) {
    map.set(path_key(resolve(key)), value);
    map.set(path_key(remap_root(key, logical_root, real_root)), value);
  }
  return map;
}

/** Record one regular file into total, local, draft and room byte totals without double-counting hard links. */
function record_file(stat, room_key, in_drafts, in_local, state) {
  const size = Number(stat.size);
  const linked = stat.nlink > 1n && stat.ino !== 0n;
  const id = linked ? `${stat.dev}:${stat.ino}` : '';
  if (!linked || !state.seen_total.has(id)) {
    if (linked) state.seen_total.add(id);
    state.total_bytes += size;
  }
  if (in_local && (!linked || !state.seen_local.has(id))) {
    if (linked) state.seen_local.add(id);
    state.local_bytes += size;
  }
  if (!in_drafts) return;
  if (!linked || !state.seen_draft.has(id)) {
    if (linked) state.seen_draft.add(id);
    state.draft_bytes += size;
  }
  if (!room_key) return;
  let seen = state.seen_rooms.get(room_key);
  if (linked) {
    if (!seen) { seen = new Set(); state.seen_rooms.set(room_key, seen); }
    if (seen.has(id)) return;
    seen.add(id);
  }
  state.rooms[room_key] = (state.rooms[room_key] || 0) + size;
}

/** Scan one directory frame into `state`, enqueueing subdirectories and stopping at `max_files`. */
async function scan_directory(frame, queue, state, config) {
  let entries;
  try {
    entries = await config.readdir(frame.path, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') count_unreadable(state, frame.room_key);
    return;
  }
  // Scan `drafts/` first at the top level so room sizes are captured even if another folder later truncates.
  if (frame.depth === 0) {
    entries.sort((a, b) => Number(path_key(b.name) === DRAFTS_DIR) - Number(path_key(a.name) === DRAFTS_DIR));
  }
  for (let offset = 0; offset < entries.length && !state.truncated; offset += STAT_BATCH) {
    const slice = entries.slice(offset, offset + STAT_BATCH);
    const items = await Promise.all(slice.map(async entry => {
      if (entry.isSymbolicLink()) return null;
      const full_path = join(frame.path, entry.name);
      if (frame.depth === 0 && config.excluded_names.has(path_key(entry.name))) return null;
      if (config.excluded_paths.has(path_key(resolve(full_path)))) return null;
      const stat = await safe_lstat(full_path, state, config.lstat,
        frame.room_key || (frame.in_drafts && frame.depth === 1 ? entry.name : ''));
      return stat && !stat.isSymbolicLink() ? { entry, full_path, stat } : null;
    }));
    for (const item of items) {
      if (!item) continue;
      const { entry, full_path, stat } = item;
      const top_key = frame.depth === 0 ? path_key(entry.name) : '';
      const group = frame.group || (stat.isDirectory() && [DRAFTS_DIR, LOCAL_DIR, 'launches', 'panel-window', 'pi'].includes(top_key) ? top_key : 'other');
      const in_drafts = frame.in_drafts || top_key === DRAFTS_DIR;
      const in_local = frame.in_local || top_key === LOCAL_DIR;
      const room_key = frame.room_key || (frame.in_drafts && frame.depth === 1 && stat.isDirectory() ? entry.name : '');
      const member = frame.member || (room_key && frame.depth === 2 && stat.isDirectory() ? entry.name : '');
      if (stat.isDirectory()) {
        if (room_key && !Object.hasOwn(state.rooms, room_key)) state.rooms[room_key] = 0;
        const scratch = frame.scratch || config.scratch?.get(path_key(full_path));
        queue.push({ path: full_path, depth: frame.depth + 1, group, in_drafts, in_local, room_key, member, scratch });
      } else if (stat.isFile()) {
        state.files += 1;
        if (state.files > config.max_files) { state.truncated = true; return; }
        const before = state.total_bytes;
        record_file(stat, room_key, in_drafts, in_local, state);
        if (state.groups) state.groups[group] += state.total_bytes - before;
        if (frame.scratch && stat.nlink === 1n) frame.scratch.bytes += Number(stat.size);
        if (member && state.members) {
          const totals = state.members[room_key] ||= Object.create(null);
          const key = stat.nlink > 1n && stat.ino !== 0n && JSON.stringify([room_key, member, String(stat.dev), String(stat.ino)]);
          if (!key || !state.member_links.has(key)) totals[member] = (totals[member] || 0) + Number(stat.size);
          if (key) {
            state.member_links.add(key);
            (state.linked_members[room_key] ||= Object.create(null))[member] = true;
          }
        }
      }
    }
  }
}

/**
 * Asynchronously measure `.codiscuss` storage usage, excluding speech model directories and nested links/reparse points.
 * Resolves the service root itself through a symlink or Windows junction so redirected roots still enforce quotas.
 * @param {string} home Service home directory (e.g. `~/.codiscuss`).
 * @param {object} [options] Optional overrides (`max_files`, `model_dirs`, `exclude_paths`, `readdir`, `lstat`, `realpath`).
 * @returns {Promise<{total_bytes: number, draft_bytes: number, local_bytes: number, rooms: Record<string, number>, unreadable: number, room_unreadable: Record<string, number>, truncated: boolean}>}
 */
export async function measure(home, options = {}) {
  const max_files = options.max_files ?? MAX_SCAN_FILES;
  const model_dirs = options.model_dirs ?? MODEL_DIRS;
  const realpath_fn = options.realpath || realpath;
  const state = {
    total_bytes: 0,
    draft_bytes: 0,
    local_bytes: 0,
    rooms: Object.create(null),
    members: options.members ? Object.create(null) : null,
    member_links: new Set(),
    linked_members: Object.create(null),
    unreadable: 0,
    room_unreadable: Object.create(null),
    truncated: false,
    files: 0,
    groups: options.members && directory_breakdown.getStore(),
    seen_total: new Set(),
    seen_local: new Set(),
    seen_draft: new Set(),
    seen_rooms: new Map(),
  };
  if (!home) return { total_bytes: 0, draft_bytes: 0, local_bytes: 0, rooms: {}, unreadable: 0, truncated: false };
  const logical_root = resolve(home);
  const real_root = await resolve_root(logical_root, state, realpath_fn);
  if (!real_root) return { total_bytes: 0, draft_bytes: 0, local_bytes: 0, rooms: {}, unreadable: state.unreadable, truncated: false };
  const lstat_fn = options.lstat || lstat;
  const root_stat = await safe_lstat(real_root, state, lstat_fn);
  if (!root_stat || !root_stat.isDirectory()) {
    return { total_bytes: 0, draft_bytes: 0, local_bytes: 0, rooms: {}, unreadable: state.unreadable, truncated: false };
  }
  const config = {
    max_files,
    scratch: build_scratch_lookup(options.scratch, logical_root, real_root),
    readdir: options.readdir || readdir,
    lstat: lstat_fn,
    excluded_names: new Set(model_dirs.map(path_key)),
    excluded_paths: await build_excluded_paths(logical_root, real_root, options, state, realpath_fn),
  };
  const queue = [{ path: real_root, depth: options.room_key ? 2 : 0, in_drafts: Boolean(options.room_key),
    in_local: false, room_key: options.room_key || '' }];
  if (options.drafts_root && relative(join(logical_root, DRAFTS_DIR), options.drafts_root)) {
    const external = resolve(options.drafts_root);
    if (relative(external, await realpath_fn(external))) throw new Error('Redirected project drafts directory');
    queue.push({ path: external, group: DRAFTS_DIR, depth: 1, in_drafts: true, in_local: false, room_key: '' });
  }
  while (queue.length && !state.truncated) {
    await scan_directory(queue.shift(), queue, state, config);
  }
  return {
    total_bytes: state.total_bytes,
    draft_bytes: state.draft_bytes,
    local_bytes: state.local_bytes,
    rooms: { ...state.rooms },
    ...(options.members ? { members: state.members, linked_members: state.linked_members, shared_links: state.seen_total.size > 0 } : {}),
    unreadable: state.unreadable,
    room_unreadable: { ...state.room_unreadable },
    truncated: state.truncated,
  };
}

/**
 * Read available space and computed safety reserve `min(max(10 GiB, 5%), 30 GiB)` for the volume holding `target_path`.
 * @param {string} target_path Directory or file path on the target volume.
 * @param {object} [options] Optional overrides (`statfs`, `min_reserve`, `max_reserve`, `ratio`).
 * @returns {{available_bytes: number, reserve_bytes: number}}
 */
export function disk_free(target_path, options = {}) {
  const statfs = options.statfs || statfsSync;
  const min_reserve = options.min_reserve ?? DISK_RESERVE_MIN;
  const max_reserve = options.max_reserve ?? DISK_RESERVE_MAX;
  const ratio = options.ratio ?? DISK_RESERVE_RATIO;
  let current = resolve(String(target_path || '.'));
  let stats;
  for (;;) {
    try {
      stats = statfs(current);
      break;
    } catch (error) {
      const parent = dirname(current);
      if (error?.code !== 'ENOENT' || parent === current) throw error;
      current = parent;
    }
  }
  const block_size = Number(stats.bsize || stats.frsize || 0);
  const available_bytes = Math.max(0, block_size * Number(stats.bavail || 0));
  const total_bytes = Math.max(0, block_size * Number(stats.blocks || 0));
  const reserve_bytes = Math.min(Math.max(min_reserve, Math.floor(total_bytes * ratio)), max_reserve);
  return { available_bytes, reserve_bytes };
}

/** Check both managed volumes. Return the tighter reserve and each distinct volume's free bytes. */
export function storage_disk(home, drafts, check = disk_free, device = path => statSync(path).dev) {
  const service = check(home);
  if (!relative(join(home, DRAFTS_DIR), drafts) || device(home) === device(drafts)) return service;
  const project = check(drafts);
  const tightest = project.available_bytes - project.reserve_bytes < service.available_bytes - service.reserve_bytes ? project : service;
  return { ...tightest, volumes: [service.available_bytes, project.available_bytes], service, project };
}

/**
 * Return an empty string when storage and disk free space are within limits, or a localized blocking reason containing
 * measured usage, limit and out-of-room cleanup entry.
 * @param {{total_bytes?: number, draft_bytes?: number, local_bytes?: number, rooms?: Record<string, number>, truncated?: boolean}|null} snapshot
 * @param {string} [room_key] Room draft folder key under `drafts/`.
 * @param {{available_bytes: number, reserve_bytes: number}|null} [disk] Result of `disk_free()`.
 * @param {object} [options] Optional limit and locale overrides; `running: true` skips the unverified-growth pause,
 *   which only holds new dispatch and never stops an execution already running.
 * @returns {string}
 */
export function block_reason(snapshot, room_key = '', disk = null, options = {}) {
  const locale = options.locale;
  const room_limit = options.room_limit ?? ROOM_DRAFT_LIMIT;
  const draft_limit = options.draft_limit ?? DRAFT_LIMIT;
  const home_limit = options.home_limit ?? HOME_LIMIT;
  const max_files = options.max_files ?? MAX_SCAN_FILES;

  if (disk && Number.isFinite(disk.available_bytes) && Number.isFinite(disk.reserve_bytes) && disk.available_bytes < disk.reserve_bytes) {
    return t('磁盘剩余空间仅 {available}，低于安全线 {reserve}，已停止派活。请先清理磁盘空间；清理旧草稿请在房间外的 AI 对话中运行 $codiscuss-draft-cleanup，或在管理面板“存储”页清理临时文件。',
      { available: format_bytes(disk.available_bytes), reserve: format_bytes(disk.reserve_bytes) }, locale);
  }
  if (!snapshot) return '';
  if (snapshot.truncated) {
    return t('本机数据目录文件数超过 {limit} 上限（已扫到 {total}，草稿 {draft}），按超限停止派活。房间被拦截时请在房间外的 AI 对话中运行 $codiscuss-draft-cleanup，或在管理面板“存储”页清理临时文件。',
      { limit: max_files, total: format_bytes(snapshot.total_bytes), draft: format_bytes(snapshot.draft_bytes) }, locale);
  }
  const rooms = snapshot.rooms || {};
  const normalized_room = room_key && Object.hasOwn(rooms, room_key) ? room_key : (room_key ? basename(room_key) : '');
  const room_bytes = normalized_room ? Number(rooms[normalized_room] || 0) : 0;
  if (normalized_room && room_bytes > room_limit) {
    return t('本房间草稿占用 {used}，超过 {limit} 上限（目录 drafts/{room}），已停止派活。房间被拦截时请在房间外的 AI 对话中运行 $codiscuss-draft-cleanup 清理可重建副本，或在管理面板“存储”页清理临时文件。',
      { used: format_bytes(room_bytes), limit: format_bytes(room_limit), room: normalized_room }, locale);
  }
  if (Number(snapshot.draft_bytes || 0) > draft_limit) {
    return t('全机草稿占用 {used}，超过 {limit} 上限（目录 drafts/），已停止派活。请在房间外的 AI 对话中运行 $codiscuss-draft-cleanup 清理旧草稿，或在管理面板“存储”页清理临时文件。',
      { used: format_bytes(snapshot.draft_bytes), limit: format_bytes(draft_limit) }, locale);
  }
  if (Number(snapshot.total_bytes || 0) > home_limit) {
    const local_bytes = Number(snapshot.local_bytes || 0);
    if (local_bytes > 0) {
      return t('本机 .codiscuss 数据占用 {used}（草稿 {draft}，房间记录与附件 {local}），超过 {limit} 上限，已停止派活。房间记录与附件不会自动删除，请先销毁不需要的旧房间；清理旧草稿请在房间外的 AI 对话中运行 $codiscuss-draft-cleanup。',
        { used: format_bytes(snapshot.total_bytes), draft: format_bytes(snapshot.draft_bytes), local: format_bytes(local_bytes), limit: format_bytes(home_limit) }, locale);
    }
    return t('本机 .codiscuss 数据占用 {used}（草稿 {draft}），超过 {limit} 上限，已停止派活。清理旧草稿请在房间外的 AI 对话中运行 $codiscuss-draft-cleanup，或在管理面板“存储”页清理临时文件；若由房间记录与附件占满，请销毁旧房间。',
      { used: format_bytes(snapshot.total_bytes), draft: format_bytes(snapshot.draft_bytes), limit: format_bytes(home_limit) }, locale);
  }
  if (snapshot.uncertain_growth && !options.running) {
    return t('磁盘余量下降后复扫发现不可读项增至 {count} 处，已暂停派活，下次扫描将重新判断。', { count: snapshot.unreadable }, locale);
  }
  if (options.stoppable === false && room_bytes >= room_limit * SCRATCH_PRESSURE_RATIO) {
    return t('本房间草稿已用 {used}（上限 {limit}），达到 80%，已暂停向无法确认可停止的成员派活。请先清理本房间草稿。', { used: format_bytes(room_bytes), limit: format_bytes(room_limit) }, locale);
  }
  return '';
}

/**
 * Return a localized warning when `.codiscuss` usage reaches the 8 GiB warning threshold, or an empty string.
 * Includes the count of unreadable entries when any were skipped due to permissions.
 * @param {{total_bytes?: number, unreadable?: number}|null} snapshot
 * @param {object} [options] Optional threshold and locale overrides.
 * @returns {string}
 */
export function warn_reason(snapshot, options = {}) {
  const locale = options.locale;
  const home_warn = options.home_warn ?? HOME_WARN;
  const home_limit = options.home_limit ?? HOME_LIMIT;
  if (!snapshot || Number(snapshot.total_bytes || 0) < home_warn) return '';
  const unreadable = Number(snapshot.unreadable || 0);
  if (unreadable > 0) {
    return t('本机 .codiscuss 数据已占 {used}（另有 {unreadable} 处因权限无法读取未计入），接近 {limit} 上限（预警线 {warn}）。请在房间外的 AI 对话中运行 $codiscuss-draft-cleanup 或在管理面板“存储”页清理临时文件。',
      { used: format_bytes(snapshot.total_bytes), unreadable, limit: format_bytes(home_limit), warn: format_bytes(home_warn) }, locale);
  }
  return t('本机 .codiscuss 数据已占 {used}，接近 {limit} 上限（预警线 {warn}）。请在房间外的 AI 对话中运行 $codiscuss-draft-cleanup 或在管理面板“存储”页清理临时文件。',
    { used: format_bytes(snapshot.total_bytes), limit: format_bytes(home_limit), warn: format_bytes(home_warn) }, locale);
}

/**
 * Wrap an unexpected storage measurement or disk check error in a localized user-facing pause reason.
 * @param {unknown} error Caught exception.
 * @param {object} [options] Optional locale override.
 * @returns {string}
 */
export function storage_error_reason(error, options = {}) {
  const locale = options.locale;
  const detail = String(error?.message || error || '').trim() || t('未知错误', undefined, locale);
  return t('无法检查本机存储与磁盘空间，已暂停派活（{reason}）。请检查 .codiscuss 目录权限或稍后重试。', { reason: detail }, locale);
}

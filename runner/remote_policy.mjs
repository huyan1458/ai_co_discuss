/**
 * What another device may ask this computer to do. Folders stay inside the saved projects (which only this computer
 * can widen), software locations, tool approvals and full access are set only here, and each relayed command runs once
 * within a short time window. Enforced in this process, never by the website or the page.
 */
import { existsSync, opendirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';

import { atomic_json } from './files.mjs';

const DIRECTORY_PAGE_SIZE = 200;
// Stop reading a huge folder after this many entries; the listing says it was cut short.
const DIRECTORY_SCAN_LIMIT = 5000;
// A relayed command older or newer than this is refused; its id is remembered for twice as long.
export const COMMAND_MAX_AGE_MS = 10 * 60 * 1000;
const COMMANDS_FILE = 'relay-commands.json';
// Fields naming a program location: another device may only repeat what this computer already saved.
const SOFTWARE_FIELDS = ['executable', 'ipc_directory'];
// Actions that repair this computer's own software setup: never from another device.
const LOCAL_ONLY_ACTIONS = new Set(['room-config']);
// Commands that put a member to work in a room with the access they name.
const WRITE_COMMANDS = new Set(['start', 'room-member', 'room-member-access', 'room-restore', 'room-fork']);

/** True when `target` is `root` or lies inside it; Windows compares without case. */
function inside(root, target) {
  const path = relative(root, target);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

/** Reject network shares, device names, stream suffixes and relative paths before touching the disk. */
function plain_absolute(path) {
  if (typeof path !== 'string' || !path.trim() || path.includes('\0')) return false;
  // \\server\share and \\?\ or \\.\ device paths would make Windows contact other machines or raw devices.
  if (/^[\\/]{2}/.test(path)) return false;
  if (process.platform === 'win32' && (path.indexOf(':', 2) >= 0 || !/^[A-Za-z]:[\\/]/.test(path))) return false;
  return isAbsolute(path);
}

/** The real folders other devices may work in: the saved projects that still exist here. */
export function remote_roots(projects) {
  const roots = [];
  for (const project of projects || []) {
    try {
      const real = realpathSync(project.path);
      if (statSync(real).isDirectory()) roots.push({ name: project.name, path: real });
    } catch { /* A project moved away grants nothing. */ }
  }
  return roots;
}

/**
 * Resolve a folder another device named, through links, and require it to sit inside a saved project and outside this
 * service's own directory. Returns the real path.
 */
export function remote_directory(path, { roots, home }) {
  const refused = new Error(`电脑未允许其他设备使用这个目录：${typeof path === 'string' ? path : ''}。请在电脑上把它（或它的上级目录）加入常用项目`);
  if (!plain_absolute(path)) throw refused;
  let real;
  try { real = realpathSync(path); } catch { throw refused; }
  if (!plain_absolute(real) || !statSync(real).isDirectory()) throw refused;
  if (!roots.some(root => inside(root.path, real))) throw refused;
  let service;
  try { service = realpathSync(home); } catch { service = home; }
  if (inside(service, real)) throw refused;
  return real;
}

/** Visit every value under `value`, calling `visit(key, item)` for each object property. */
function walk(value, visit) {
  if (Array.isArray(value)) return value.forEach(item => walk(item, visit));
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    visit(key, item);
    walk(item, visit);
  }
}

/**
 * Refuse a relayed request that would reach past what this computer granted: a folder outside the saved projects,
 * a program location not already saved here, or 全放开 saved as a default. A device reaches this point only unlocked
 * by its passkey that day, so a room may be given any level.
 */
export function guard_remote_request(command, input, { projects, participants, home }) {
  if (LOCAL_ONLY_ACTIONS.has(command)) throw new Error('此操作只能在这台电脑上执行');
  if (!input || typeof input !== 'object') return;
  const roots = remote_roots(projects);
  const saved = Object.values(participants || {});
  const known = Object.fromEntries(SOFTWARE_FIELDS.map(field => [field, new Set(saved.map(profile => profile[field]).filter(Boolean))]));
  walk(input, (key, value) => {
    if (key === 'cwd' && value) remote_directory(value, { roots, home });
    else if (SOFTWARE_FIELDS.includes(key) && value && !known[key].has(value)) throw new Error(`其他设备不能更改软件位置（${key}），请在电脑上设置`);
    // 全放开 may be given to a room's member; it never becomes a saved default from afar.
    else if (key === 'project_access' && value === 'full' && !WRITE_COMMANDS.has(command)) throw new Error('“全放开”不能从其他设备存为默认设置');
    // `own` comes only from taking over a session on this computer; it may write, so another device cannot claim it.
    else if (key === 'project_access' && value === 'own') throw new Error('沿用原会话权限（own）只能在电脑上接管会话时产生');
  });
  // A saved project only widens what other devices reach, so a new or moved one must already lie inside the old ones.
  if (command === 'projects' && Array.isArray(input.projects)) {
    const existing = new Map((projects || []).map(project => [project.id, project.path]));
    for (const project of input.projects) {
      if (existing.get(project?.id) !== project?.path) remote_directory(project?.path, { roots, home });
    }
  }
}

/**
 * List the sub-folders another device may browse: the saved projects at the top, then folders inside them, one page
 * at a time. Only folder names are returned, never file names or contents.
 */
export function list_remote_directories({ path = '', offset = 0 } = {}, { projects, home }) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('目录分页位置无效');
  const roots = remote_roots(projects);
  if (!path) return { path: '', parent: null, entries: roots.map(root => ({ name: root.name, path: root.path })), next_offset: null, truncated: false };
  const folder = remote_directory(path, { roots, home });
  const names = [];
  let scanned = 0, truncated = false;
  const directory = opendirSync(folder);
  try {
    for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
      if (++scanned > DIRECTORY_SCAN_LIMIT) { truncated = true; break; }
      // Links are not followed, so browsing never leaves the granted folders.
      if (entry.isDirectory()) names.push(entry.name);
    }
  } finally { directory.closeSync(); }
  names.sort((left, right) => left.localeCompare(right, 'zh-CN', { numeric: true }));
  const page = names.slice(offset, offset + DIRECTORY_PAGE_SIZE);
  const parent = roots.some(root => relative(root.path, folder) === '') ? '' : dirname(folder);
  return { path: folder, parent, entries: page.map(name => ({ name, path: join(folder, name) })),
    next_offset: offset + page.length < names.length ? offset + page.length : null, truncated };
}

/**
 * Accept a relayed command id once: it must carry a send time within the window, and an id already run inside the
 * window is refused. Ids are kept on disk so a restart does not reopen the window.
 */
export function claim_relayed_command(home, id, sent_at, now = Date.now()) {
  if (typeof id !== 'string' || !id) throw new Error('远程命令缺少编号');
  if (!Number.isFinite(sent_at) || Math.abs(now - sent_at) > COMMAND_MAX_AGE_MS) {
    throw new Error('远程命令已过期或设备时间偏差过大，请核对手机时间后重试');
  }
  const path = join(home, COMMANDS_FILE);
  let seen = {};
  try { if (existsSync(path)) seen = JSON.parse(readFileSync(path, 'utf8')).ids || {}; } catch { seen = {}; }
  if (seen[id]) throw new Error('远程命令已执行过，不再重复执行');
  const kept = Object.fromEntries(Object.entries(seen).filter(([, time]) => now - time <= 2 * COMMAND_MAX_AGE_MS));
  kept[id] = now;
  atomic_json(path, { ids: kept });
}

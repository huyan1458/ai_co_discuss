/**
 * Where an instance keeps what its rooms produce.
 *
 * Every instance has a draft space: a room created without a project directory works in its own sub-folder there. An
 * instance whose settings name a projects root belongs to an ordinary account, which may only use folders created
 * directly under that root. Both sit beside the service directory, never inside it, because everything inside the
 * service directory is private to the runner.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { atomic_json } from './files.mjs';

const SETTINGS_FILE = 'local-settings.json';
const HIDDEN_PROJECTS_FILE = 'hidden-projects.json';
// A hosted account's instance writes the failures its runner judged here, one JSON line each; the owner's panel relays them.
export const OPERATOR_EVENTS_FILE = 'operator-events.jsonl';
const PROJECT_NAME_LIMIT = 80;
const DRAFT_TITLE_LIMIT = 40;
// Characters Windows refuses in a file name, plus control characters.
const UNSAFE_NAME = /[<>:"/\\|?*\u0000-\u001f]/g;
const RESERVED_NAME = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/**
 * Read this instance's draft space and, for an ordinary account, its projects root.
 *
 * Returns:
 *   { workspace, projects_root }; projects_root is null for the computer owner's instance, which may use any folder.
 */
export function account_space(home) {
  const path = join(home, SETTINGS_FILE);
  const settings = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  const absolute = value => typeof value === 'string' && isAbsolute(value) ? resolve(value) : null;
  return { workspace: absolute(settings.workspace) || `${resolve(home)}-workspace`, projects_root: absolute(settings.projects_root) };
}

/** Directory containing room-keyed member drafts for this instance. */
export function drafts_root(home) {
  const file = join(home, SETTINGS_FILE);
  const root = existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).project_data_root;
  if (root && (!isAbsolute(root) || relative(join(root, 'drafts'), realpathSync.native(join(root, 'drafts'))))) {
    throw new Error('项目草稿目录路径已重定向 / Project drafts path was redirected');
  }
  return join(root || home, 'drafts');
}

function safe_name(text, limit) {
  const name = String(text || '').replace(UNSAFE_NAME, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, limit).trim();
  return RESERVED_NAME.test(name) ? '' : name;
}

/**
 * Create the draft folder of one new room and return its path.
 *
 * Args:
 *   title: The room's name, used so a person can recognise the folder.
 *   key: A value fixed for this creation (its submission), so a retried creation reuses the same folder.
 */
export function draft_folder(home, title, key) {
  const suffix = createHash('sha256').update(String(key)).digest('hex').slice(0, 6);
  const folder = join(account_space(home).workspace, `${safe_name(title, DRAFT_TITLE_LIMIT) || '房间'}-${suffix}`);
  mkdirSync(folder, { recursive: true });
  return folder;
}

/** The projects of an ordinary account: the folders directly under its projects root. */
export function account_projects(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN', { numeric: true }))
    .map(entry => ({ id: createHash('sha256').update(entry.name).digest('hex').slice(0, 16), name: entry.name, path: join(root, entry.name) }));
}

/** Names the account removed from its list; their folders stay on disk, so rooms using them keep working. */
function hidden_project_names(home) {
  const path = join(home, HIDDEN_PROJECTS_FILE);
  const names = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : [];
  return Array.isArray(names) ? names.filter(name => typeof name === 'string') : [];
}

/** The projects an ordinary account sees in its list: its folders, without the ones it removed. */
export function listed_account_projects(home, root) {
  const hidden = new Set(hidden_project_names(home));
  return account_projects(root).filter(project => !hidden.has(project.name));
}

/**
 * Take projects off an ordinary account's list without touching their folders; repeating a removal changes nothing.
 *
 * Args:
 *   home: The instance's service directory, which keeps the hidden names.
 *   root: The account's projects root.
 *   ids: The ids of the projects to remove, as `account_projects` reports them.
 */
export function hide_account_projects(home, root, ids) {
  const projects = new Map(account_projects(root).map(project => [project.id, project.name]));
  const names = ids.map(id => projects.get(id));
  if (names.includes(undefined)) throw new Error('项目不存在，请刷新后重试');
  atomic_json(join(home, HIDDEN_PROJECTS_FILE), [...new Set([...hidden_project_names(home), ...names])]);
}

/** Create a project, or bring back the removed project of that name with its files. */
export function create_or_restore_account_project(home, root, name) {
  const wanted = typeof name === 'string' ? name.trim() : '';
  const hidden = hidden_project_names(home);
  if (!hidden.includes(wanted)) return create_account_project(root, name);
  atomic_json(join(home, HIDDEN_PROJECTS_FILE), hidden.filter(item => item !== wanted));
  const folder = join(root, wanted);
  return existsSync(folder) ? { name: wanted, path: folder } : create_account_project(root, name);
}

/** Create one project folder directly under the projects root; a name that would nest or escape is refused. */
export function create_account_project(root, name) {
  const wanted = typeof name === 'string' ? name.trim() : '';
  if (!wanted || wanted.length > PROJECT_NAME_LIMIT || wanted !== safe_name(wanted, PROJECT_NAME_LIMIT) || wanted.startsWith('.')) {
    throw new Error(`项目名称须为 1–${PROJECT_NAME_LIMIT} 字，不能含 \\ / : * ? " < > | 等符号，不能以点开头或结尾`);
  }
  const folder = join(root, wanted);
  if (existsSync(folder)) throw new Error(`项目已存在：${wanted}`);
  mkdirSync(root, { recursive: true });
  mkdirSync(folder);
  return { name: wanted, path: folder };
}

/** Whether a folder is one of this instance's draft folders, where the runner itself may keep what a room produced. */
export function in_draft_space(home, folder) {
  let workspace = account_space(home).workspace, target = resolve(folder);
  // Compare real paths, so a short or linked spelling of the same folder still matches.
  try { workspace = realpathSync(workspace); target = realpathSync(target); } catch { return false; }
  const path = relative(workspace, target);
  return Boolean(path) && !path.startsWith('..') && !isAbsolute(path);
}

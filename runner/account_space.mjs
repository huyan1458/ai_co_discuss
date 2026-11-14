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

const SETTINGS_FILE = 'local-settings.json';
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

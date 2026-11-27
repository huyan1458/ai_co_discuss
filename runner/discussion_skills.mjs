/**
 * Install complete skills without replacing an unmanaged or locally edited copy (hashes live in the service home), and,
 * when asked, the workflows this package ships.
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { atomic_json } from './files.mjs';
import { WORKFLOW_ID_PATTERN, install_workflow_folder, parse_markdown, workflow_directory } from './workflows.mjs';

const SOURCE = fileURLToPath(new URL('../.agents/skills/', import.meta.url));
export const SKILLS = ['discuss-host', 'discuss-participant', 'discuss-goal', 'discuss-session', 'workflow-creator'];
const FORMER_STEWARD_SKILLS = ['discuss-report', 'share-card', 'local-tts-setup', 'local-stt-setup', 'notify-setup', 'codiscuss-draft-cleanup'];
const LEGACY_MANIFEST = '.codiscuss-skills.json';
const SKILL_DIGEST_LENGTH = 16;

/** A short hash of a skill file's bytes, shared by the editor and delivery records. */
export function skill_digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex').slice(0, SKILL_DIGEST_LENGTH);
}

/** Fingerprint the complete fixed set of room skills that can steer the host. */
export function host_skill_digest(root) {
  try {
    const directories = ['discuss-goal', 'discuss-host', 'discuss-participant', 'discuss-session'];
    const paths = directories.flatMap(name => skill_file_paths(root, name)).sort();
    const files = paths.map(path => [path, skill_digest(readFileSync(join(root, path)))]);
    return skill_digest(JSON.stringify(files));
  } catch {
    return null;
  }
}

/** Enumerate files with portable relative paths and without following symlinks. */
function skill_file_paths(root, path) {
  const target = join(root, path);
  const status = lstatSync(target);
  if (status.isDirectory()) return readdirSync(target).flatMap(name => skill_file_paths(root, `${path}/${name}`));
  if (status.isFile()) return [path];
  throw new Error('技能目录包含无法读取的条目');
}

/** Hash names and contents, rejecting links instead of following them outside a skill. */
function tree_hash(directory) {
  if (lstatSync(directory).isSymbolicLink()) throw new Error('技能目录包含符号链接');
  const hash = createHash('sha256');
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error('技能目录包含符号链接');
    hash.update(`${name}\0${stat.isDirectory() ? 'directory' : 'file'}\0`);
    hash.update(stat.isDirectory() ? tree_hash(path) : readFileSync(path));
  }
  return hash.digest('hex');
}

/** Copy a missing skill or update a previous unmodified installation. */
function install_skill(root, name, previous) {
  const source = join(SOURCE, name);
  const destination = resolve(root, name);
  const hash = tree_hash(source);
  if (existsSync(destination)) {
    let current;
    try { current = tree_hash(destination); } catch { return { name, status: 'conflict', path: destination }; }
    if (current === hash) return { name, status: 'unchanged', path: destination, hash };
    if (current !== previous) return { name, status: 'conflict', path: destination };
    if (destination !== join(resolve(root), name)) throw new Error('技能目标路径无效');
    rmSync(destination, { recursive: true });
  }
  cpSync(source, destination, { recursive: true });
  return { name, status: previous ? 'updated' : 'installed', path: destination, hash };
}

/** Read hashes recorded for one directory, folding in the copy older versions kept inside it. */
function recorded_hashes(record, root) {
  const data = existsSync(record) ? JSON.parse(readFileSync(record, 'utf8')) : {};
  const legacy = join(root, LEGACY_MANIFEST);
  return { data, previous: { ...(existsSync(legacy) ? JSON.parse(readFileSync(legacy, 'utf8')) : {}), ...data[root] } };
}

/** Save the record outside skill directories and drop the in-directory file older versions wrote. */
function save_record(record, root, data) {
  mkdirSync(dirname(record), { recursive: true });
  atomic_json(record, data);
  rmSync(join(root, LEGACY_MANIFEST), { force: true });
}

/** Install all distributed skills together and remember only copies this installer manages. */
export function install_skills(directory, record) {
  const root = resolve(directory);
  mkdirSync(root, { recursive: true });
  const { data, previous } = recorded_hashes(record, root);
  const results = SKILLS.map(name => install_skill(root, name, previous[name]));
  const managed = { ...previous };
  for (const result of results) if (result.hash) managed[result.name] = result.hash;
  save_record(record, root, { ...data, [root]: managed });
  return results.map(({ hash, ...result }) => result);
}

/** Remove only the retired steward copies the installer recorded, preserving edited copies in service backups. */
export function retire_steward_skills(directory, record) {
  const root = resolve(directory);
  if (!existsSync(root)) return [];
  const { data, previous } = recorded_hashes(record, root);
  const retired = FORMER_STEWARD_SKILLS.filter(name => Object.hasOwn(previous, name) && /^[a-f0-9]{64}$/.test(previous[name]));
  if (!retired.length) return [];
  const results = [];
  for (const name of retired) {
    const path = join(root, name);
    let present;
    try { present = lstatSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (present) {
      let current;
      try { current = tree_hash(path); } catch { /* An unreadable or linked tree still needs a backup before removal. */ }
      const backup = current === previous[name] ? undefined : backup_retired_skill(record, name, path);
      rmSync(path, { recursive: true });
      results.push({ name, path, status: backup ? 'backed_up' : 'removed', ...(backup ? { backup } : {}) });
    }
    delete previous[name];
  }
  save_record(record, root, { ...data, [root]: previous });
  return results;
}

/** Copy without following links, and only return a backup once the entire copy succeeds. */
function backup_retired_skill(record, name, path) {
  const directory = join(dirname(record), 'backups', 'skills');
  mkdirSync(directory, { recursive: true });
  const backup = join(mkdtempSync(join(directory, `${name}-`)), name);
  cpSync(path, backup, { recursive: true, dereference: false, verbatimSymlinks: true });
  return backup;
}

/** Remove unmodified copies a previous install left in a retired directory; edited copies stay. */
export function remove_legacy_skills(directory, record) {
  const root = resolve(directory);
  if (!existsSync(root)) return [];
  const { data, previous } = recorded_hashes(record, root);
  if (!Object.keys(previous).length) return [];
  const results = SKILLS.filter(name => previous[name] && existsSync(join(root, name))).map(name => {
    const path = join(root, name);
    let current;
    try { current = tree_hash(path); } catch { return { name, status: 'kept', path }; }
    if (current !== previous[name]) return { name, status: 'kept', path };
    rmSync(path, { recursive: true });
    return { name, status: 'removed', path };
  });
  const kept = Object.fromEntries(results.filter(result => result.status === 'kept').map(result => [result.name, previous[result.name]]));
  const { [root]: _, ...rest } = data;
  save_record(record, root, Object.keys(kept).length ? { ...rest, [root]: kept } : rest);
  if (!readdirSync(root).length) rmSync(root, { recursive: true });
  return results;
}

const WORKFLOW_SOURCE = fileURLToPath(new URL('../workflows/', import.meta.url));

/** The workflows this package ships, with the name and description their SKILL.md gives, for setup to offer. */
export function shipped_workflows() {
  if (!existsSync(WORKFLOW_SOURCE)) return [];
  return readdirSync(WORKFLOW_SOURCE).filter(name => WORKFLOW_ID_PATTERN.test(name)).sort().map(name => {
    const { fields } = parse_markdown(readFileSync(join(WORKFLOW_SOURCE, name, 'SKILL.md'), 'utf8'), `${name}/SKILL.md`);
    return { name, label: fields.label || name, description: fields.description || '' };
  });
}

/** The shipped workflows a service home has whose copy differs from the shipped version (edited or older). */
export function outdated_workflows(home) {
  return shipped_workflows().map(item => item.name).filter(name => {
    const destination = workflow_directory(home, name);
    return existsSync(destination) && tree_hash(destination) !== tree_hash(join(WORKFLOW_SOURCE, name));
  });
}

/**
 * Install shipped workflows into the service home's library, replacing any of the same ID with the shipped version.
 * Setup calls this only for the ones the user picks on that run; a copy that differs is backed up first.
 * @param {string} home - the service home.
 * @param {string[]} [names] - which shipped workflows; all when left out.
 * @returns {{name: string, status: 'installed' | 'updated' | 'unchanged', path: string, backup?: string}[]}
 */
export function install_workflows(home, names = shipped_workflows().map(item => item.name)) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return shipped_workflows().map(item => item.name).filter(name => names.includes(name)).map(name => {
    const source = join(WORKFLOW_SOURCE, name), destination = workflow_directory(home, name);
    if (!existsSync(destination)) {
      install_workflow_folder(home, name, source);
      return { name, status: 'installed', path: destination };
    }
    if (tree_hash(destination) === tree_hash(source)) return { name, status: 'unchanged', path: destination };
    const backup = join(home, 'backups', 'workflows', `${name}-${stamp}`);
    mkdirSync(dirname(backup), { recursive: true });
    cpSync(destination, backup, { recursive: true });
    install_workflow_folder(home, name, source);
    return { name, status: 'updated', path: destination, backup };
  });
}

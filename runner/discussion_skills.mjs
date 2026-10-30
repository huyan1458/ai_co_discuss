/** Install complete skills without replacing an unmanaged or locally edited copy; hashes live in the service home. */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { atomic_json } from './discussion_adapters.mjs';

const SOURCE = fileURLToPath(new URL('../.agents/skills/', import.meta.url));
const SKILLS = ['discuss-host', 'discuss-participant', 'discuss-report'];
const LEGACY_MANIFEST = '.codiscuss-skills.json';

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

/** Install all three skills together and remember only copies this installer manages. */
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

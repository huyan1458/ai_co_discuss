import { BUILTIN_EXPERT_PRESETS } from './expert_prompts.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { atomic_json } from './files.mjs';
import { expert_disk_key, expert_skills, parse_markdown, serialize_markdown } from './workflows.mjs';

const ID = /^[a-zA-Z0-9_]{1,16}$/;
const FIELDS = ['label', 'description', 'project_access', 'model', 'effort'];

function checked(...paths) {
  for (const path of paths) {
    if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('专家路径不能包含符号链接');
  }
  return paths.at(-1);
}

function root_path(root, home) {
  if (!root) return checked(join(home, 'experts'));
  const base = join(root.path, '.codiscuss');
  return checked(base, join(base, 'experts'));
}

function location(directory, id) {
  if (!/^(?:[a-z]+-)?[A-Za-z0-9_]{1,16}$/.test(id)) throw new Error('无效的专家编号');
  const folder = checked(join(directory, id));
  const flat = checked(join(directory, id + '.md'));
  if (existsSync(flat) && existsSync(folder)) throw new Error('专家的单文件和文件夹不能同时存在');
  return existsSync(folder) ? checked(join(folder, id + '.md')) : flat;
}

function trust_key(root, id) { return 'expert:' + root.id + ':' + id; }

function read_trust(home) {
  const path = join(home, 'project-trust.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
}

function digest(path) {
  const hash = createHash('sha256').update(readFileSync(path));
  const skills = join(dirname(path), 'skills');
  function visit(directory, prefix) {
    for (const item of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = checked(join(directory, item.name)), key = prefix + item.name;
      if (item.isDirectory()) visit(file, key + '/');
      else if (item.isFile()) hash.update(key).update('\0').update(readFileSync(file)).update('\0');
    }
  }
  if (path === join(dirname(path), basename(dirname(path)) + '.md') && existsSync(checked(skills))) visit(skills, '');
  return hash.digest('hex');
}

function record_trust(home, root, id, path) {
  atomic_json(join(home, 'project-trust.json'), { ...read_trust(home), [trust_key(root, id)]: digest(path) });
}

/** Read standalone project experts, preserving requested access for owner approval. */
export function project_experts(home, root, validate) {
  const directory = root_path(root, home);
  if (!existsSync(directory)) return [];
  const records = root ? read_trust(home) : {};
  const result = [];
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    const disk = item.isDirectory() ? item.name : item.name.replace(/\.md$/, '');
    if (!/^(?:[a-z]+-)?[A-Za-z0-9_]{1,16}$/.test(disk) || (!item.isDirectory() && !item.name.endsWith('.md'))) continue;
    const path = location(directory, disk);
    if (!existsSync(path)) continue;
    const { fields, body } = parse_markdown(readFileSync(path, 'utf8'), path);
    const id = fields.name || fields.platform;
    if (!ID.test(id) || (disk !== id && disk !== fields.platform?.toLowerCase() + '-' + id)) throw new Error('专家文件名与编号不一致');
    const preset = { name: fields.name ? fields.platform + '-' + id : fields.platform, system_prompt: body };
    for (const key of FIELDS) if (fields[key]) preset[key] = fields[key];
    validate?.(preset);
    const trusted = !root || records[trust_key(root, disk)] === digest(path);
    const skills = checked(join(directory, disk), join(directory, disk, 'skills'));
    if (existsSync(skills)) for (const entry of readdirSync(skills)) checked(join(skills, entry), join(skills, entry, 'SKILL.md'));
    result.push({ ...preset, id, platform: fields.platform, scope: root ? 'project' : 'global',
      ...(root ? { project_id: root.id, project_name: root.name, readonly: root.readonly, trusted } : {}), skills: expert_skills(join(directory, disk)),
      ...(!trusted && preset.project_access && preset.project_access !== 'read' ? { project_access: 'read', requested_access: preset.project_access } : {}) });
  }
  return result;
}

/** Edit one project preset under the same local lock as project trust records. */
export function change_project_expert(home, root, input, validate) {
  return with_expert_lock(home, () => update_definition(home, root, input, validate));
}

function with_expert_lock(home, action) {
  mkdirSync(home, { recursive: true });
  const lock = new DatabaseSync(join(home, 'workflows-lock.sqlite3'));
  try {
    lock.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
    return action();
  } finally { lock.close(); }
}

function update_definition(home, root, input, validate) {
  const directory = root_path(root, home);
  const name = input.preset?.name || input.name || '';
  const id = input.id || name.split('-').at(-1);
  const entries = name ? [] : project_experts(home, root, validate).filter(item => item.id === id);
  if (!name && entries.length !== 1) throw new Error('请使用完整专家名称');
  const platform = name ? name.split('-')[0] : entries[0].platform;
  const disk = expert_disk_key(directory, platform, id);
  const path = location(directory, disk);
  if (input.action === 'trust') {
    if (!existsSync(path)) throw new Error('找不到项目专家');
    if (root) record_trust(home, root, disk, path);
    return;
  }
  if (root?.readonly) throw new Error('项目目录只读');
  if (input.action === 'delete') {
    const current = project_experts(home, root, validate).find(item => item.id === id && (!name || item.name === name));
    if (!current) throw new Error('找不到项目专家');
    const target = dirname(path) === directory ? path : dirname(path);
    const backup = join(home, 'backups', 'expert-' + id + '-' + randomUUID());
    mkdirSync(dirname(backup), { recursive: true });
    cpSync(target, backup, { recursive: true });
    rmSync(target, { recursive: true });
    return;
  }
  if (input.action !== 'save') throw new Error('未知的专家操作');
  const preset = Object.fromEntries(['name', 'system_prompt', ...FIELDS].filter(key => input.preset[key] !== undefined).map(key => [key, input.preset[key]]));
  validate?.(preset);
  if (name !== platform && name !== platform + '-' + id) throw new Error('专家名称与编号不一致');
  if (existsSync(path) && parse_markdown(readFileSync(path, 'utf8'), path).fields.platform !== platform) throw new Error('此专家编号已由另一个平台使用');
  if (existsSync(path) && !input.overwrite) throw Object.assign(new Error('专家已存在'), { code: 'preset_exists', details: {} });
  const fields = Object.fromEntries(FIELDS.map(key => [key, preset[key]]));
  mkdirSync(dirname(path), { recursive: true });
  for (const leftover of readdirSync(dirname(path))) {
    if (/\.md\.[0-9a-f-]{36}\.tmp$/.test(leftover)) rmSync(join(dirname(path), leftover), { force: true });
  }
  const tmp = path + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(tmp, serialize_markdown({ name: name === platform ? '' : id, platform, ...fields }, preset.system_prompt));
    renameSync(tmp, path);
  } finally { rmSync(tmp, { force: true }); }
  if (root) record_trust(home, root, disk, path);
}

function update_templates(home, templates) {
  if (templates === undefined) return;
  const lock = new DatabaseSync(join(home, 'launch-settings-lock.sqlite3'));
  try {
    lock.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
    const file = join(home, 'launch-settings.json');
    const settings = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { participants: {} };
    atomic_json(file, { ...settings, description_templates: templates });
  } finally { lock.close(); }
}

/** Copy legacy skills through a staging directory so an interrupted backup can be retried. */
function backup_legacy_skills(source, destination) {
  if (existsSync(destination)) return;
  mkdirSync(dirname(destination), { recursive: true });
  const staging = destination + '.' + randomUUID() + '.tmp';
  try {
    cpSync(source, staging, { recursive: true });
    renameSync(staging, destination);
  } finally { rmSync(staging, { force: true, recursive: true }); }
}

/** Migrate legacy definitions once, retaining the source and copies of shared platform skills. */
export function ensure_global_experts_migrated(home) {
  const marker = join(home, 'experts-migrated-v1');
  if (existsSync(marker)) return;
  with_expert_lock(home, () => {
    if (existsSync(marker)) return;
    const legacy = join(home, 'expert-presets.json'), archived = legacy + '.migrated';
    const source = existsSync(legacy) ? legacy : archived;
    const data = existsSync(source) ? JSON.parse(readFileSync(source, 'utf8')) : {};
    const presets = [...(data.presets || [])];
    for (const preset of BUILTIN_EXPERT_PRESETS) {
      if (!data.hidden_builtins?.includes(preset.name) && !presets.some(item => item.name === preset.name)) presets.push(preset);
    }
    const names = new Set(presets.map(item => item.name));
    const directory = root_path(null, home), backups = join(home, 'backups');
    if (existsSync(source)) {
      mkdirSync(backups, { recursive: true });
      const copy = join(backups, 'expert-presets-migration-v1.json');
      if (!existsSync(copy)) cpSync(source, copy);
    }
    for (const original of presets) {
      const preset = { ...original }, [platform] = preset.name.split('-');
      if (!/^[A-Za-z]+$/.test(platform)) throw new Error('无效的旧专家平台');
      const original_id = preset.name.slice(platform.length + 1) || platform;
      let id = original_id;
      if (!ID.test(id)) {
        let index = 1;
        while (names.has(platform + '-preset' + index)) index++;
        id = 'preset' + index;
        preset.label ||= preset.name;
        preset.name = platform + '-' + id;
        names.add(preset.name);
      }
      const disk = expert_disk_key(directory, platform, id);
      if (disk !== original_id && /^[\p{L}\p{N}_-]+$/u.test(original_id)) {
        const shared = checked(join(directory, original_id), join(directory, original_id, 'skills'));
        if (existsSync(shared)) {
          const backup = join(backups, 'expert-skills-v1-' + original_id);
          backup_legacy_skills(shared, backup);
          cpSync(backup, join(directory, disk, 'skills'), { recursive: true });
        }
      }
      update_definition(home, null, { action: 'save', preset, overwrite: true });
    }
    update_templates(home, data.description_templates);
    if (existsSync(legacy)) renameSync(legacy, archived);
    writeFileSync(marker, '1\n');
  });
}

/** Reconcile legacy bulk updates with definitions while preserving unchanged skill folders. */
export function replace_global_experts(home, presets, templates, validate) {
  with_expert_lock(home, () => {
    if (presets) {
      const before = project_experts(home, null, validate);
      for (const preset of presets) update_definition(home, null, { action: 'save', preset, overwrite: true }, validate);
      for (const previous of before) if (!presets.some(item => item.name === previous.name)) {
        update_definition(home, null, { action: 'delete', name: previous.name }, validate);
      }
    }
    update_templates(home, templates);
  });
}

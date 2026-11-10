/**
 * Room workflows: a host's SKILL.md plus a set of agent cards, kept as a shareable folder in the service home.
 * The program only stores, previews and loads them; the host follows SKILL.md on its own judgment.
 */
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { flow_in_use, normalize_flow } from './workflow_flow.mjs';

// A workflow ID follows the Agent Skills naming rule: lowercase letters and digits joined by single hyphens.
export const WORKFLOW_ID_PATTERN = /^(?=.{1,40}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;
// Characters of a SKILL.md hash the host compares to know whether its earlier reading is still current.
const REVISION_LENGTH = 12;
// A card ID becomes the member name's suffix (`platform-card`), which has no hyphen of its own.
export const CARD_ID_PATTERN = /^[a-z0-9_]{1,16}$/;
export const MAX_WORKFLOW_SKILL = 20000;
export const MAX_WORKFLOW_CARDS = 30;
const MAX_WORKFLOW_LABEL = 32;
const MAX_WORKFLOW_DESCRIPTION = 500;
const MAX_DRAFT_PARTS = 20;
const WORKFLOW_LOCK_WAIT_MS = 5000;
const BACKUP_DIRECTORY = /^\.old-([a-z0-9_-]{1,40})-[0-9a-f-]{36}$/;
// A card file is shaped like an agent definition: `name` is the card ID (its file name) and `platform` the software.
const CARD_FIELDS = ['name', 'label', 'description', 'project_access', 'model', 'effort', 'image_model'];
const CARD_FILE_FIELDS = ['name', 'platform', 'label', 'description', 'project_access', 'model', 'effort', 'image_model'];
const PART_LINE = /^<!-- workflow-part: (\d+)\/(\d+) id: ([a-z0-9_-]{1,40}) -->$/;
const FILE_LINE = /^<!-- workflow-file: (\S+) -->$/;
const CARD_PATH = /^agents\/([A-Za-z0-9_]{1,16})\.md$/;
// Like a skill folder, a workflow carries any other text files beside SKILL.md (templates, references, examples).
const MAX_RESOURCE_FILES = 100;
const MAX_RESOURCE_BYTES = 1000000;
// Each path segment: no leading dot, no Windows-reserved characters.
const RESOURCE_SEGMENT = /^[^./\\:*?"<>|\x00-\x1f][^/\\:*?"<>|\x00-\x1f]{0,99}$/;
const utf8 = new TextDecoder('utf-8', { fatal: true });
// Commands an API member may run, registered beside SKILL.md so they travel with the workflow.
export const COMMANDS_FILE = 'commands.json';
// The canvas of cards and arrows the host's relay follows; a field of its own, not one of the folder's other files.
export const FLOW_FILE = 'flow.json';
const COMMAND_ID_PATTERN = /^(?=.{1,40}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;
const COMMAND_FIELDS = ['id', 'description', 'run', 'path', 'access', 'timeout_seconds'];
const MAX_COMMANDS = 20;
const MAX_COMMAND_ARGS = 32;
const MAX_COMMAND_ARG = 1000;
const MAX_COMMAND_TEXT = 300;
const DEFAULT_COMMAND_TIMEOUT = 120;
const MAX_COMMAND_TIMEOUT = 600;
// Replaced when the command runs: the workflow folder, the project directory and the one path the member passes.
const PATH_PLACEHOLDER = '{path}';

/** One single-line text field of a command, trimmed. */
function command_text(value, label, required) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (value !== undefined && typeof value !== 'string') throw new Error(`${label} 须为文本`);
  if (required && !text) throw new Error(`${label} 不能为空`);
  if (text.length > MAX_COMMAND_TEXT || /\n/.test(text)) throw new Error(`${label} 最多 ${MAX_COMMAND_TEXT} 字，且不能换行`);
  return text;
}

/**
 * Parse and check `commands.json`: `{ "commands": [{ id, description, run: [程序, 参数…], path?, access, timeout_seconds? }] }`.
 * `run` is an argument list started without a shell, so the member cannot add to it; `{workflow}` and `{project}` stand for
 * the two folders, and `{path}` for the one project path the member passes, allowed only when `path` says what it means.
 * @returns {{id: string, description: string, run: string[], path: string, access: 'read' | 'write', timeout_seconds: number}[]}
 */
export function parse_workflow_commands(text) {
  let value;
  try { value = JSON.parse(text); } catch (error) { throw new Error(`${COMMANDS_FILE} 不是合法 JSON：${error.message}`); }
  const list = value?.commands;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => key !== 'commands') || !Array.isArray(list)) {
    throw new Error(`${COMMANDS_FILE} 须为 { "commands": [ … ] }`);
  }
  if (list.length > MAX_COMMANDS) throw new Error(`${COMMANDS_FILE} 最多登记 ${MAX_COMMANDS} 条命令`);
  const ids = new Set();
  return list.map((item, index) => {
    const label = `${COMMANDS_FILE} 第 ${index + 1} 条命令`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`${label} 须为对象`);
    const unknown = Object.keys(item).filter(key => !COMMAND_FIELDS.includes(key));
    if (unknown.length) throw new Error(`${label} 含不支持的字段：${unknown.join('、')}`);
    if (!COMMAND_ID_PATTERN.test(item.id || '')) throw new Error(`${label} 的 id 只能用小写英文和数字，可用单个连字符连接，1—40 位`);
    if (ids.has(item.id)) throw new Error(`${COMMANDS_FILE} 的命令 id 重复：${item.id}`);
    ids.add(item.id);
    const description = command_text(item.description, `${label} 的 description`, true);
    const path = command_text(item.path, `${label} 的 path`, false);
    const { run } = item;
    if (!Array.isArray(run) || !run.length || run.length > MAX_COMMAND_ARGS
      || run.some(arg => typeof arg !== 'string' || !arg || arg.length > MAX_COMMAND_ARG)) {
      throw new Error(`${label} 的 run 须为 1—${MAX_COMMAND_ARGS} 个非空文本（程序与参数），每个最多 ${MAX_COMMAND_ARG} 字`);
    }
    if (run[0].includes(PATH_PLACEHOLDER)) throw new Error(`${label} 的程序名不能含 ${PATH_PLACEHOLDER}`);
    if (run.some(arg => arg.includes(PATH_PLACEHOLDER)) !== Boolean(path)) {
      throw new Error(`${label}：run 里用了 ${PATH_PLACEHOLDER} 就须用 path 说明成员要传什么路径，没用就不写 path`);
    }
    if (!['read', 'write'].includes(item.access)) throw new Error(`${label} 的 access 须为 read（只读文件）或 write（会改文件）`);
    const timeout = item.timeout_seconds ?? DEFAULT_COMMAND_TIMEOUT;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_COMMAND_TIMEOUT) throw new Error(`${label} 的 timeout_seconds 须为 1—${MAX_COMMAND_TIMEOUT} 的整数`);
    return { id: item.id, description, run: [...run], path, access: item.access, timeout_seconds: timeout };
  });
}

/** The commands a workflow's files register; none without `commands.json`. */
function workflow_commands(resources) {
  return typeof resources?.[COMMANDS_FILE] === 'string' ? parse_workflow_commands(resources[COMMANDS_FILE]) : [];
}

/** The folder holding every workflow of this computer. */
export function workflows_home(home) { return join(home, 'workflows'); }

/** A workflow's folder, built from a checked ID and never from a caller's path. */
// Built-in room modes own these "/" commands, so no workflow may take their names.
export const RESERVED_WORKFLOW_IDS = ['goal', 'discuss'];

export function workflow_directory(home, id) {
  if (!WORKFLOW_ID_PATTERN.test(id || '')) throw new Error('工作流 ID 只能用小写英文和数字，可用单个连字符连接（不在首尾），1—40 位');
  return join(workflows_home(home), id);
}

/** Split single-line `key: value` frontmatter from a Markdown body. */
export function parse_markdown(text, label) {
  const lines = String(text).replace(/^﻿/, '').replace(/\r\n/g, '\n').split('\n');
  if (lines[0] !== '---') throw new Error(`${label} 须以 --- 开头的头信息开始`);
  const end = lines.indexOf('---', 1);
  if (end < 0) throw new Error(`${label} 的头信息缺少结尾 ---`);
  const fields = {};
  for (const line of lines.slice(1, end)) {
    if (!line.trim()) continue;
    const colon = line.indexOf(':');
    if (colon < 1) throw new Error(`${label} 的头信息只支持单行 key: value：${line}`);
    // Quotes around a value are YAML's, not part of it.
    fields[line.slice(0, colon).trim()] = line.slice(colon + 1).trim().replace(/^(["'])(.*)\1$/, '$2');
  }
  return { fields, body: lines.slice(end + 1).join('\n').trim() };
}

/** Write fields back as single-line frontmatter; empty fields are left out. */
export function serialize_markdown(fields, body) {
  const header = Object.entries(fields).filter(([, value]) => value !== undefined && value !== '').map(([key, value]) => `${key}: ${String(value ?? '').replace(/\s*\n\s*/g, ' ')}`.trimEnd());
  return `---\n${header.join('\n')}\n---\n${body ? `${body.trim()}\n` : ''}`;
}

/** Turn one parsed card file into the card shape the page edits. */
function card_from_markdown(card, text) {
  const { fields, body } = parse_markdown(text, `agents/${card}.md`);
  const unknown = Object.keys(fields).filter(key => !CARD_FILE_FIELDS.includes(key));
  if (unknown.length) throw new Error(`agents/${card}.md 含不支持的字段：${unknown.join('、')}`);
  const value = { card };
  for (const key of CARD_FIELDS) if (fields[key]) value[key] = fields[key];
  // Older cards wrote the member name `platform-card` as `name` and had no `platform`.
  if (fields.platform) {
    if (fields.name && fields.name !== card) throw new Error(`agents/${card}.md 的 name 须与文件名相同：${fields.name}`);
    value.name = `${fields.platform}-${card}`;
  }
  if (body) value.system_prompt = body;
  return value;
}

/** Turn SKILL.md, card files and the folder's other files into one workflow object, unchecked; flow.json becomes `flow`. */
function workflow_from_files(skill_text, cards, resources = {}) {
  const { fields, body } = parse_markdown(skill_text, 'SKILL.md');
  const { [FLOW_FILE]: flow_text, ...rest } = resources;
  let flow;
  if (typeof flow_text === 'string') {
    try { flow = JSON.parse(flow_text); } catch (error) { throw new Error(`${FLOW_FILE} 不是合法 JSON：${error.message}`); }
  }
  return { id: fields.name || '', label: fields.label || '', description: fields.description || '', skill: body,
    agents: Object.entries(cards).map(([card, text]) => card_from_markdown(card, text)), resources: rest, ...(flow ? { flow } : {}) };
}

/**
 * A well-formed canvas over the workflow's cards, or null for none. It only illustrates SKILL.md, so any arrangement of
 * arrows is kept; only a malformed file or a card the workflow lacks is refused.
 */
function validate_flow(flow, cards) {
  if (flow === undefined || flow === null) return flow;
  const normalized = normalize_flow(flow);
  if (!flow_in_use(normalized)) return null;
  const unknown = normalized.nodes.filter(node => node.type === 'card' && !cards.includes(node.card)).map(node => node.card);
  if (unknown.length) throw new Error(`流程画布引用了不存在的卡片：${unknown.join('、')}`);
  return normalized;
}

/** A path, relative to the workflow folder, that a resource may take: inside it, not SKILL.md and not under agents/. */
function resource_path_allowed(path) {
  return path !== 'SKILL.md' && path !== FLOW_FILE && !path.startsWith('agents/') && path.split('/').every(segment => RESOURCE_SEGMENT.test(segment));
}

/** Check resource files `{ "relative/path": text }`. */
function validate_resources(resources) {
  if (!resources || typeof resources !== 'object' || Array.isArray(resources)) throw new Error('附带文件须为 { 路径: 文本 }');
  const entries = Object.entries(resources);
  if (entries.length > MAX_RESOURCE_FILES) throw new Error(`附带文件最多 ${MAX_RESOURCE_FILES} 个`);
  const seen = new Set();
  for (const [path, text] of entries) {
    if (!resource_path_allowed(path)) throw new Error(`附带文件路径不合法：${path}`);
    if (seen.has(path.toLowerCase())) throw new Error(`附带文件路径重复（不区分大小写）：${path}`);
    seen.add(path.toLowerCase());
    if (typeof text !== 'string') throw new Error(`附带文件 ${path} 须为文本`);
    if (Buffer.byteLength(text, 'utf8') > MAX_RESOURCE_BYTES) throw new Error(`附带文件 ${path} 超过 ${MAX_RESOURCE_BYTES / 1000000} MB`);
  }
  workflow_commands(resources);
  return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));
}

/** A folder's files other than SKILL.md and agents/: UTF-8 text is kept, anything else is named back as ignored. */
function read_resource_folder(directory, prefix, resources, ignored) {
  for (const name of readdirSync(directory).sort()) {
    const relative = `${prefix}${name}`;
    if (relative === 'SKILL.md' || relative === 'agents') continue;
    // The canvas is read as a resource here and taken out as `flow` with the rest of the folder.
    if (relative === FLOW_FILE) { resources[relative] = readFileSync(join(directory, name), 'utf8'); continue; }
    const path = join(directory, name);
    if (lstatSync(path).isDirectory()) { read_resource_folder(path, `${relative}/`, resources, ignored); continue; }
    let text = null;
    try { text = utf8.decode(readFileSync(path)); } catch { /* not text */ }
    if (text !== null && resource_path_allowed(relative)) resources[relative] = text;
    else ignored.push(relative);
  }
}

/** Write resource files below a workflow folder. */
function write_resources(directory, resources) {
  for (const [path, text] of Object.entries(resources)) {
    const target = join(directory, ...path.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
}

/** Copy a saved folder's files other than SKILL.md and agents/, for a save that carries none of its own. */
function keep_resources(directory, staging) {
  for (const name of readdirSync(directory)) {
    if (name === 'SKILL.md' || name === 'agents') continue;
    cpSync(join(directory, name), join(staging, name), { recursive: true });
  }
}

/**
 * Check a whole workflow. `validate_card` is the expert preset check, shared so a card and a preset obey one rule.
 * Returns a normalized copy with only known fields.
 */
export function validate_workflow(input, validate_card) {
  if (!input || typeof input !== 'object') throw new Error('工作流须为对象');
  const { id } = input;
  workflow_directory('.', id);
  // Checked only when saving: a workflow saved earlier under one of these names can still be read and deleted.
  if (RESERVED_WORKFLOW_IDS.includes(id)) throw new Error(`工作流 ID 不能用 ${id}：它是内置模式 /${id} 的命令`);
  const label = String(input.label || '').trim(), description = String(input.description || '').trim(), skill = String(input.skill || '').trim();
  if (label.length > MAX_WORKFLOW_LABEL) throw new Error(`工作流显示名最多 ${MAX_WORKFLOW_LABEL} 字`);
  if (description.length > MAX_WORKFLOW_DESCRIPTION || /\n/.test(description)) throw new Error(`工作流描述最多 ${MAX_WORKFLOW_DESCRIPTION} 字，且不能换行`);
  if (!skill) throw new Error('SKILL.md 正文不能为空');
  if (skill.length > MAX_WORKFLOW_SKILL) throw new Error(`SKILL.md 正文最多 ${MAX_WORKFLOW_SKILL} 字`);
  const agents = input.agents || [];
  if (!Array.isArray(agents) || agents.length > MAX_WORKFLOW_CARDS) throw new Error(`卡片须为列表，最多 ${MAX_WORKFLOW_CARDS} 张`);
  const cards = new Set(), names = new Set();
  const normalized = agents.map(agent => {
    // requested_access and needs_platform are an import preview's notes for the page, not card fields.
    const { card, requested_access: ignored_request, needs_platform: ignored_platform, ...preset } = agent || {};
    if (!CARD_ID_PATTERN.test(card || '')) throw new Error(`卡片 ID 只能用小写英文、数字和下划线，1—16 位：${card || '（空）'}`);
    if (cards.has(card.toLowerCase())) throw new Error(`卡片 ID 重复（不区分大小写）：${card}`);
    cards.add(card.toLowerCase());
    // Empty fields are dropped; unknown ones stay so the preset check refuses them.
    const kept = Object.fromEntries(Object.entries(preset).filter(([, value]) => value !== undefined && value !== ''));
    try { validate_card(kept); } catch (error) { throw new Error(`卡片 ${card}：${error.message}`); }
    if (!kept.name?.endsWith(`-${card}`)) throw new Error(`卡片 ${card} 的成员名须为“平台-${card}”：${kept.name || '（空）'}`);
    if (names.has(kept.name)) throw new Error(`同一工作流内卡片名称重复：${kept.name}`);
    names.add(kept.name);
    if ((kept.description || '').includes('\n')) throw new Error(`${kept.name} 的描述不能换行`);
    return { card, ...kept };
  });
  // Absent resources mean "keep the saved folder's other files" (a host draft or the editor carries none); `{}` clears them.
  // Likewise an absent flow keeps the saved canvas, and null removes it.
  const flow = validate_flow(input.flow, normalized.map(agent => agent.card));
  return { id, label, description, skill, agents: normalized,
    ...(input.resources === undefined ? {} : { resources: validate_resources(input.resources) }),
    ...(flow === undefined ? {} : { flow }) };
}

/** Refuse links anywhere in a folder, so a shared workflow cannot point outside itself. */
function assert_no_links(directory) {
  if (lstatSync(directory).isSymbolicLink()) throw new Error('工作流目录不能是符号链接');
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`工作流目录包含符号链接：${name}`);
    if (stat.isDirectory()) assert_no_links(path);
  }
}

/** Recover an interrupted replacement before any reader can observe a missing workflow. Called under the library lock. */
function recover_workflows(home) {
  const root = workflows_home(home);
  for (const name of readdirSync(root)) {
    const match = BACKUP_DIRECTORY.exec(name);
    if (!match) continue;
    const backup = join(root, name), directory = workflow_directory(home, match[1]);
    assert_no_links(backup);
    if (existsSync(directory)) rmSync(backup, { recursive: true, force: true });
    else renameSync(backup, directory);
  }
}

/** Serialize publication, recovery and reads across processes; SQLite releases the lock even if its owner exits. */
function with_workflow_lock(home, action) {
  mkdirSync(workflows_home(home), { recursive: true });
  const lock = new DatabaseSync(join(home, 'workflows-lock.sqlite3'));
  try {
    lock.exec(`PRAGMA busy_timeout=${WORKFLOW_LOCK_WAIT_MS}; BEGIN IMMEDIATE`);
    recover_workflows(home);
    return action();
  } finally { lock.close(); }
}

/** Read a workflow folder (the library's own or one being imported) without checking its content. */
export function read_workflow_folder(directory) {
  if (!existsSync(join(directory, 'SKILL.md'))) throw new Error('文件夹里没有 SKILL.md');
  assert_no_links(directory);
  const agents = join(directory, 'agents');
  const cards = {};
  const resources = {}, ignored = [];
  read_resource_folder(directory, '', resources, ignored);
  if (existsSync(agents)) {
    for (const name of readdirSync(agents).sort()) {
      const match = CARD_PATH.exec(`agents/${name}`);
      if (match) cards[match[1]] = readFileSync(join(agents, name), 'utf8');
      else ignored.push(`agents/${name}`);
    }
  }
  return { workflow: workflow_from_files(readFileSync(join(directory, 'SKILL.md'), 'utf8'), cards, resources), ignored };
}

/**
 * Read a workflow sent as files (a zip or folder the page opened): `{ "SKILL.md": text, "agents/<card>.md": text,
 * "<other path>": text }`, paths relative to the folder holding SKILL.md. Other text files come along as resources;
 * a path sent as null (a file the page could not read as text) or one a resource may not take is named back as ignored.
 */
export function read_workflow_files(files) {
  if (!files || typeof files !== 'object' || Array.isArray(files)) throw new Error('工作流文件须为 { 路径: 文本 }');
  if (typeof files['SKILL.md'] !== 'string') throw new Error('没有 SKILL.md');
  const cards = {}, resources = {}, ignored = [];
  for (const path of Object.keys(files).sort()) {
    if (path === 'SKILL.md') continue;
    const match = CARD_PATH.exec(path);
    if (match && typeof files[path] === 'string') cards[match[1]] = files[path];
    else if (typeof files[path] === 'string' && (path === FLOW_FILE || resource_path_allowed(path))) resources[path] = files[path];
    else ignored.push(path);
  }
  return { workflow: workflow_from_files(files['SKILL.md'], cards, resources), ignored };
}

/** Summaries for the library list; a broken folder is listed with its error instead of hiding it. */
export function list_workflows(home) {
  return with_workflow_lock(home, () => {
    const disabled = disabled_workflows(home);
    return readdirSync(workflows_home(home)).filter(name => WORKFLOW_ID_PATTERN.test(name)).sort().map(id => {
      const flag = disabled.includes(id) ? { disabled: true } : {};
      try {
        const workflow = read_saved_workflow(home, id);
        return { id, label: workflow.label || id, description: workflow.description, cards: workflow.agents.length, directory: workflow.directory, ...flag };
      } catch (error) { return { id, label: id, description: '', cards: 0, error: error.message, ...flag }; }
    });
  });
}

// IDs of workflows the user switched off on this computer: kept in the library, but no room may use them. It is this
// computer's choice, so it lives beside the library and never travels with a workflow folder.
function disabled_path(home) { return join(home, 'workflows-disabled.json'); }

/** The disabled workflow IDs. */
function disabled_workflows(home) {
  try { const list = JSON.parse(readFileSync(disabled_path(home), 'utf8')); return Array.isArray(list) ? list : []; }
  catch { return []; }
}

/** Write the disabled IDs (call under the lock). */
function write_disabled(home, list) {
  writeFileSync(disabled_path(home), `${JSON.stringify([...new Set(list)].sort())}
`);
}

/** Switch a workflow off or back on for every room on this computer. */
export function set_workflow_disabled(home, id, disabled) {
  return with_workflow_lock(home, () => {
    if (!existsSync(workflow_directory(home, id))) throw new Error(`工作流不存在：${id}`);
    const others = disabled_workflows(home).filter(item => item !== id);
    write_disabled(home, disabled ? [...others, id] : others);
    return { id, disabled: Boolean(disabled) };
  });
}

/** Refuse a workflow the user disabled, before a room starts using it. */
export function assert_workflow_enabled(home, id) {
  if (disabled_workflows(home).includes(id)) throw new Error(`工作流 ${id} 已停用；请先在“工作流”页启用`);
}

/** Change only a workflow's display name; its cards, canvas and files stay as they are. */
export function rename_workflow(home, id, label) {
  const text = String(label || '').trim();
  if (!text) throw new Error('工作流名称不能为空');
  if (text.length > MAX_WORKFLOW_LABEL) throw new Error(`工作流显示名最多 ${MAX_WORKFLOW_LABEL} 字`);
  return with_workflow_lock(home, () => {
    const workflow = read_saved_workflow(home, id);
    writeFileSync(join(workflow.directory, 'SKILL.md'), serialize_markdown({ name: id, label: text, description: workflow.description }, workflow.skill));
    return { id, label: text };
  });
}

/** Read a library entry while its caller holds the publication lock. */
function read_saved_workflow(home, id) {
  const directory = workflow_directory(home, id);
  if (!existsSync(directory)) throw new Error(`工作流不存在：${id}`);
  const { workflow } = read_workflow_folder(directory);
  return { ...workflow, id, directory, commands: workflow_commands(workflow.resources) };
}

/** One workflow in full, as the editor shows it. */
export function get_workflow(home, id) {
  return with_workflow_lock(home, () => read_saved_workflow(home, id));
}

/** Fill a staging folder, then swap it in for the library entry, recoverable if the process dies midway. Call under the lock. */
function publish_directory(home, id, fill) {
  const directory = workflow_directory(home, id);
  if (existsSync(directory)) assert_no_links(directory);
  const staging = join(workflows_home(home), `.tmp-${id}-${randomUUID()}`);
  mkdirSync(staging, { recursive: true });
  fill(staging, directory);
  const old = existsSync(directory) ? join(workflows_home(home), `.old-${id}-${randomUUID()}`) : '';
  if (old) renameSync(directory, old);
  try { renameSync(staging, directory); }
  catch (error) { if (old) renameSync(old, directory); throw error; }
  if (old) rmSync(old, { recursive: true, force: true });
}

/** Copy a distributed workflow folder into the library as it is, replacing any entry of that ID. */
export function install_workflow_folder(home, id, source) {
  assert_no_links(source);
  with_workflow_lock(home, () => publish_directory(home, id, staging => cpSync(source, staging, { recursive: true })));
}

/** Write a checked workflow as files, publishing a complete directory with crash recovery. */
export function save_workflow(home, input, validate_card) {
  const workflow = validate_workflow(input, validate_card);
  return with_workflow_lock(home, () => {
    publish_directory(home, workflow.id, (staging, directory) => {
      mkdirSync(join(staging, 'agents'), { recursive: true });
      writeFileSync(join(staging, 'SKILL.md'), serialize_markdown({ name: workflow.id, label: workflow.label, description: workflow.description }, workflow.skill));
      for (const { card, system_prompt, name, ...fields } of workflow.agents) {
        const platform = name.slice(0, name.length - card.length - 1);
        writeFileSync(join(staging, 'agents', `${card}.md`), serialize_markdown({ name: card, platform,
          ...Object.fromEntries(CARD_FIELDS.slice(1).map(key => [key, fields[key]])) }, system_prompt));
      }
      if (workflow.resources) write_resources(staging, workflow.resources);
      else if (existsSync(directory)) keep_resources(directory, staging);
      if (workflow.flow) writeFileSync(join(staging, FLOW_FILE), `${JSON.stringify(workflow.flow, null, 2)}
`);
      else if (workflow.flow === null || workflow.resources) rmSync(join(staging, FLOW_FILE), { force: true });
    });
    return read_saved_workflow(home, workflow.id);
  });
}

/** Remove one workflow folder. */
export function delete_workflow(home, id) {
  return with_workflow_lock(home, () => {
    const directory = workflow_directory(home, id);
    if (!existsSync(directory)) throw new Error(`工作流不存在：${id}`);
    assert_no_links(directory);
    rmSync(directory, { recursive: true, force: true });
    if (disabled_workflows(home).includes(id)) write_disabled(home, disabled_workflows(home).filter(item => item !== id));
    return { deleted: id };
  });
}

/** Lines of a pasted part, without its header; the header gives order, total and workflow. */
function draft_part(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const headers = lines.map(line => PART_LINE.exec(line)).filter(Boolean);
  if (headers.length !== 1) throw new Error('每段草稿须有且只有一行 <!-- workflow-part: 序号/总数 id: 工作流ID -->');
  const [, index, total, id] = headers[0];
  return { index: Number(index), total: Number(total), id, lines: lines.filter(line => !PART_LINE.test(line)) };
}

/**
 * Parse pasted host drafts (one message each) into SKILL.md and card texts.
 * Separators count only as whole, unindented lines; text before the first file is ignored.
 */
export function parse_workflow_draft(parts) {
  if (!Array.isArray(parts) || !parts.length || parts.length > MAX_DRAFT_PARTS) throw new Error(`草稿须为 1—${MAX_DRAFT_PARTS} 段文本`);
  const pieces = parts.map(draft_part).sort((a, b) => a.index - b.index);
  const { total, id } = pieces[0];
  if (pieces.some(piece => piece.total !== total || piece.id !== id)) throw new Error('各段草稿的总数或工作流 ID 不一致');
  const missing = Array.from({ length: total }, (_, index) => index + 1).filter(index => !pieces.some(piece => piece.index === index));
  if (missing.length) throw new Error(`还缺第 ${missing.join('、')} 段`);
  if (pieces.length !== total) throw new Error('草稿有重复的段');
  const files = new Map();
  let current = null;
  for (const line of pieces.flatMap(piece => piece.lines)) {
    const marker = FILE_LINE.exec(line);
    if (!marker) { current?.push(line); continue; }
    const path = marker[1];
    if (path !== 'SKILL.md' && path !== FLOW_FILE && !CARD_PATH.test(path)) throw new Error(`草稿只能包含 SKILL.md、${FLOW_FILE} 和 agents/卡片ID.md：${path}`);
    if (files.has(path)) throw new Error(`草稿里 ${path} 出现了两次`);
    current = [];
    files.set(path, current);
  }
  if (!files.size) throw new Error('草稿里没有任何 <!-- workflow-file: 路径 --> 分隔行');
  if (!files.has('SKILL.md')) throw new Error('草稿里缺少 SKILL.md');
  const text = path => files.get(path).join('\n').replace(/\s+$/, '');
  const cards = Object.fromEntries([...files.keys()].filter(path => CARD_PATH.test(path)).map(path => [CARD_PATH.exec(path)[1], text(path)]));
  // A draft carries no other files, so it leaves the saved folder's templates and tools alone (no `resources` at all);
  // its canvas, when it has one, replaces the saved one.
  const { resources: none, ...workflow } = workflow_from_files(text('SKILL.md'), cards, files.has(FLOW_FILE) ? { [FLOW_FILE]: text(FLOW_FILE) } : {});
  if (workflow.id !== id) throw new Error(`SKILL.md 的 name（${workflow.id}）与分段头的 id（${id}）不一致`);
  return workflow;
}

/** Order of project access by what it allows; an imported card asking for more than reading starts at reading. */
const READ_ONLY = 'read';

/**
 * Parse an import (files sent by the page, a folder on this computer or a draft) without saving it.
 * Imported cards asking for project writes start read-only and carry `requested_access` for the page to offer.
 */
export function preview_workflow(input, validate_card, known_platform) {
  let source;
  if (input.files) source = read_workflow_files(input.files);
  else if (typeof input.folder === 'string' && input.folder) source = read_workflow_folder(resolve(input.folder));
  else source = { workflow: parse_workflow_draft(input.parts), ignored: [] };
  const workflow = validate_workflow(source.workflow, validate_card);
  const agents = workflow.agents.map(agent => {
    const requested = agent.project_access && agent.project_access !== READ_ONLY ? agent.project_access : '';
    return { ...agent, ...(requested ? { project_access: READ_ONLY, requested_access: requested } : {}),
      ...(known_platform(agent.name) ? {} : { needs_platform: true }) };
  });
  // Shown for the user to allow before saving: the page drops an import's commands file unless they do.
  return { ...workflow, agents, commands: workflow_commands(workflow.resources), ignored: source.ignored };
}

/**
 * What a room's runner needs from its enabled workflow, read fresh for each execution.
 * Returns null when no workflow is enabled; an unreadable one returns its error so members fall back to room settings.
 */
export function load_room_workflow(config) {
  const binding = config.workflow;
  if (!binding?.enabled || !config.api_home) return null;
  try {
    assert_workflow_enabled(config.api_home, binding.id);
    const workflow = get_workflow(config.api_home, binding.id);
    const { directory } = workflow;
    const cards = Object.fromEntries(workflow.agents.map(agent => [agent.card, agent]));
    // The canvas is for the user to see; the host works from SKILL.md alone.
    return { id: binding.id, label: workflow.label || binding.id, description: workflow.description || '', directory, skill_path: join(directory, 'SKILL.md'), skill: workflow.skill,
      revision: createHash('sha256').update(workflow.skill).digest('hex').slice(0, REVISION_LENGTH),
      members: binding.members || {}, cards, commands: workflow.commands };
  } catch (error) { return { id: binding.id, error: error.message }; }
}

/** The member's profile for this execution: a workflow member's prompt comes from its card as it is now. */
export function effective_profile(profile, member_name, workflow) {
  if (!profile || !workflow || workflow.error) return profile;
  const card = Object.entries(workflow.members).find(([, name]) => name === member_name)?.[0];
  const source = card && workflow.cards[card];
  if (!source) return profile;
  const { system_prompt: ignored, ...rest } = profile;
  // An empty card prompt leaves the software's own preset in place, as an unset member prompt does.
  return source.system_prompt ? { ...rest, system_prompt: source.system_prompt } : rest;
}

/**
 * The host's view of the workflow: which card is which member now, whether present, and what it may do. A card the
 * workflow dropped is left out; `missing` lists cards added after it was enabled, which no member plays yet.
 */
export function workflow_task_field(workflow, room_members, participants) {
  const members = Object.entries(workflow.members).map(([card, name]) => {
    const member = (room_members || []).find(item => item.name === name);
    const source = workflow.cards[card];
    if (!member || member.status === 'removed' || !source) return null;
    return { card, member: member.label || name, label: source.label || '', description: source.description || '',
      status: member.status, project_access: participants?.[name]?.project_access || 'read' };
  }).filter(Boolean);
  const missing = Object.values(workflow.cards).filter(card => !workflow.members[card.card])
    .map(card => ({ card: card.card, label: card.label || '', description: card.description || '' }));
  // The host reads SKILL.md only when a request fits the description and its revision is one it has not read.
  return { id: workflow.id, label: workflow.label, description: workflow.description || '', revision: workflow.revision || '', members,
    ...(missing.length ? { missing } : {}) };
}

/**
 * Whether a bound workflow is in use: while at least one member it brought (other than the host) is here. Sending them
 * away or removing them ends it; a workflow that brought no one but the host lasts while it is bound.
 */
export function workflow_in_use(workflow, room_members) {
  const host = (room_members || []).find(member => member.role === 'host')?.name;
  const brought = Object.values(workflow.members || {}).filter(name => name !== host);
  return !brought.length || (room_members || []).some(member => brought.includes(member.name) && member.status === 'active');
}

/** Write a room's workflow binding into its configuration object (the caller saves it). */
export function bind_room_workflow(config, { id, enabled, members }) {
  workflow_directory('.', id);
  if (members && (typeof members !== 'object' || Array.isArray(members)
    || Object.entries(members).some(([card, name]) => !CARD_ID_PATTERN.test(card) || typeof name !== 'string' || !name))) {
    throw new Error('workflow.members 须为 {卡片ID: 成员名}');
  }
  return { ...config, workflow: { id, enabled: Boolean(enabled), members: { ...(config.workflow?.id === id ? config.workflow.members : {}), ...(members || {}) } } };
}

/**
 * Room workflows: a host's SKILL.md plus a set of agent cards, kept as a shareable folder in the service home.
 * The program only stores, previews and loads them; the host follows SKILL.md on its own judgment.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

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
const CARD_FIELDS = ['name', 'label', 'description', 'project_access', 'model', 'effort'];
const CARD_FILE_FIELDS = ['name', 'platform', 'label', 'description', 'project_access', 'model', 'effort'];
const PART_LINE = /^<!-- workflow-part: (\d+)\/(\d+) id: ([a-z0-9_-]{1,40}) -->$/;
const FILE_LINE = /^<!-- workflow-file: (\S+) -->$/;
const CARD_PATH = /^agents\/([A-Za-z0-9_]{1,16})\.md$/;

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

/** Turn SKILL.md and card files into one workflow object, unchecked. */
function workflow_from_files(skill_text, cards) {
  const { fields, body } = parse_markdown(skill_text, 'SKILL.md');
  return { id: fields.name || '', label: fields.label || '', description: fields.description || '', skill: body,
    agents: Object.entries(cards).map(([card, text]) => card_from_markdown(card, text)) };
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
  return { id, label, description, skill, agents: normalized };
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
  const ignored = readdirSync(directory).filter(name => !['SKILL.md', 'agents'].includes(name));
  if (existsSync(agents)) {
    for (const name of readdirSync(agents).sort()) {
      const match = CARD_PATH.exec(`agents/${name}`);
      if (match) cards[match[1]] = readFileSync(join(agents, name), 'utf8');
      else ignored.push(`agents/${name}`);
    }
  }
  return { workflow: workflow_from_files(readFileSync(join(directory, 'SKILL.md'), 'utf8'), cards), ignored };
}

/**
 * Read a workflow sent as files (a zip or folder the page opened): `{ "SKILL.md": text, "agents/<card>.md": text, other: "" }`,
 * paths relative to the folder holding SKILL.md. Other paths are only named back as ignored.
 */
export function read_workflow_files(files) {
  if (!files || typeof files !== 'object' || Array.isArray(files)) throw new Error('工作流文件须为 { 路径: 文本 }');
  if (typeof files['SKILL.md'] !== 'string') throw new Error('没有 SKILL.md');
  const cards = {}, ignored = [];
  for (const path of Object.keys(files).sort()) {
    if (path === 'SKILL.md') continue;
    const match = CARD_PATH.exec(path);
    if (match && typeof files[path] === 'string') cards[match[1]] = files[path];
    else ignored.push(path);
  }
  return { workflow: workflow_from_files(files['SKILL.md'], cards), ignored };
}

/** Summaries for the library list; a broken folder is listed with its error instead of hiding it. */
export function list_workflows(home) {
  return with_workflow_lock(home, () => readdirSync(workflows_home(home)).filter(name => WORKFLOW_ID_PATTERN.test(name)).sort().map(id => {
    try {
      const workflow = read_saved_workflow(home, id);
      return { id, label: workflow.label || id, description: workflow.description, cards: workflow.agents.length };
    } catch (error) { return { id, label: id, description: '', cards: 0, error: error.message }; }
  }));
}

/** Read a library entry while its caller holds the publication lock. */
function read_saved_workflow(home, id) {
  const directory = workflow_directory(home, id);
  if (!existsSync(directory)) throw new Error(`工作流不存在：${id}`);
  const { workflow } = read_workflow_folder(directory);
  return { ...workflow, id, directory };
}

/** One workflow in full, as the editor shows it. */
export function get_workflow(home, id) {
  return with_workflow_lock(home, () => read_saved_workflow(home, id));
}

/** Write a checked workflow as files, publishing a complete directory with crash recovery. */
export function save_workflow(home, input, validate_card) {
  const workflow = validate_workflow(input, validate_card);
  return with_workflow_lock(home, () => {
    const directory = workflow_directory(home, workflow.id);
    if (existsSync(directory)) assert_no_links(directory);
    const staging = join(workflows_home(home), `.tmp-${workflow.id}-${randomUUID()}`);
    mkdirSync(join(staging, 'agents'), { recursive: true });
    writeFileSync(join(staging, 'SKILL.md'), serialize_markdown({ name: workflow.id, label: workflow.label, description: workflow.description }, workflow.skill));
    for (const { card, system_prompt, name, ...fields } of workflow.agents) {
      const platform = name.slice(0, name.length - card.length - 1);
      writeFileSync(join(staging, 'agents', `${card}.md`), serialize_markdown({ name: card, platform,
        ...Object.fromEntries(CARD_FIELDS.slice(1).map(key => [key, fields[key]])) }, system_prompt));
    }
    const old = existsSync(directory) ? join(workflows_home(home), `.old-${workflow.id}-${randomUUID()}`) : '';
    if (old) renameSync(directory, old);
    try { renameSync(staging, directory); }
    catch (error) { if (old) renameSync(old, directory); throw error; }
    if (old) rmSync(old, { recursive: true, force: true });
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
    if (path !== 'SKILL.md' && !CARD_PATH.test(path)) throw new Error(`草稿只能包含 SKILL.md 和 agents/卡片ID.md：${path}`);
    if (files.has(path)) throw new Error(`草稿里 ${path} 出现了两次`);
    current = [];
    files.set(path, current);
  }
  if (!files.size) throw new Error('草稿里没有任何 <!-- workflow-file: 路径 --> 分隔行');
  if (!files.has('SKILL.md')) throw new Error('草稿里缺少 SKILL.md');
  const text = path => files.get(path).join('\n').replace(/\s+$/, '');
  const cards = Object.fromEntries([...files.keys()].filter(path => path !== 'SKILL.md').map(path => [CARD_PATH.exec(path)[1], text(path)]));
  const workflow = workflow_from_files(text('SKILL.md'), cards);
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
  return { ...workflow, agents, ignored: source.ignored };
}

/**
 * What a room's runner needs from its enabled workflow, read fresh for each execution.
 * Returns null when no workflow is enabled; an unreadable one returns its error so members fall back to room settings.
 */
export function load_room_workflow(config) {
  const binding = config.workflow;
  if (!binding?.enabled || !config.api_home) return null;
  try {
    const workflow = get_workflow(config.api_home, binding.id);
    const { directory } = workflow;
    const cards = Object.fromEntries(workflow.agents.map(agent => [agent.card, agent]));
    return { id: binding.id, label: workflow.label || binding.id, description: workflow.description || '', directory, skill_path: join(directory, 'SKILL.md'), skill: workflow.skill,
      revision: createHash('sha256').update(workflow.skill).digest('hex').slice(0, REVISION_LENGTH),
      members: binding.members || {}, cards };
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

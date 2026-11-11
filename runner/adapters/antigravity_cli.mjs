/**
 * agy (Antigravity CLI) adapter: one headless `agy -p` turn per execution, isolated via `--project outside-of-project`
 * and a per-member `--settings` file so permissions apply without adding blank projects to the shared App sidebar.
 * Sessions are conversation databases, branched by copying them (not an official interface; tested on agy 1.4.9).
 */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { atomic_json } from '../files.mjs';
import { cli_delivery } from './cli.mjs';
import { DENIAL_FIELD, EDIT_TOOLS, json_line, launch_directory, MAX_DENIALS, model_entry, MODEL_PATTERN, not_sent, project_directory,
  query_catalog, read_json, same_path, TASK_SUBCOMMANDS } from './common.mjs';

// agy stores its generation settings as protobuf; field 28 (tag bytes 0xe2 0x01) holds the model actually used.
const AGY_MODEL_TAG = [0xe2, 0x01];
const AGY_OUTSIDE_PROJECT = 'outside-of-project';
const SKILL_HEADER_BYTES = 64 * 1024;

/**
 * One operation a headless agy run refused, from the failed tool step, with the project grant that would allow it.
 * agy names the check that failed: a sandboxed or unsandboxed command, a file write, or (1.5.3+) a file read outside
 * the project folders.
 */
export function agy_denial(step) {
  const message = step.tool_info?.error?.message || '';
  if (!/permission check failed/.test(message)) return null;
  const parameters = step.tool_info.parameters || {};
  // Older agy did not name the check; a refused step with a command line was a command.
  const kind = message.match(/permission check failed for (\w+)/)?.[1] || (parameters.CommandLine ? 'command' : '');
  if (!kind) return null;
  if (kind === 'write_file' || kind === 'read_file') {
    const path = String(parameters.Path || parameters.TargetFile || message.match(new RegExp(`${kind}\\(([^)]+)\\)`))?.[1] || '');
    return { tool: kind, detail: path.slice(0, DENIAL_FIELD), rule: path ? `${kind}(${resolve(dirname(path)).replaceAll('\\', '/')})` : '' };
  }
  const command = String(parameters.CommandLine || '');
  const rule = `${kind === 'unsandboxed' ? 'unsandboxed_command' : 'command'}(${command})`;
  return { tool: step.tool_name || 'run_command', detail: command.slice(0, DENIAL_FIELD), rule: command && rule.length <= DENIAL_FIELD ? rule : '' };
}

/** Allow only the discussion website commands, without shell separators or expressions. */
export function agy_rule() {
  const safe = '[^;&|<>$`()\\r\\n]';
  return `command(regex:^codiscuss(\\.cmd)?( --site ${safe.replace('[^', '[^ ')}+)? (${TASK_SUBCOMMANDS.join('|')})( ${safe}*)?$)`;
}

/** Native headless review blocks unapproved shell commands; a wildcard grant in global or outside-of-project settings could bypass session rules. */
function check_agy_shell(user_home) {
  const cli = read_json(join(user_home, '.gemini', 'antigravity-cli', 'settings.json'));
  const shared = read_json(join(user_home, '.gemini', 'config', 'config.json'));
  const outside = read_json(join(user_home, '.gemini', 'config', 'projects', `${AGY_OUTSIDE_PROJECT}.json`));
  const grants = [...(cli.permissions?.allow || []), ...(shared.userSettings?.globalPermissionGrants?.allow || []),
    ...(outside.permissionGrants?.permissionGrants?.allow || [])];
  if (grants.some(rule => rule === '*' || /^(?:command|unsandboxed|unsandboxed_command)\((?:\*|regex:\.\*)\)$/.test(rule))) {
    throw new Error('agy 全局或项目外（Outside of Project）设置放行了所有命令，会绕过讨论权限；请移除 command(*) / unsandboxed(*) 通配放行，具体命令的放行不受影响（本工具旧版写入的规则可运行 codiscuss setup 清理），未交付讨论任务');
  }
}

/**
 * Skill folders agy loads by itself: its own folder and every entry in its global skills.json. agy shows the model these
 * skills' paths, so a run must be able to read them (1.5.3 refuses reads outside the added directories); agy leaves ~/
 * unexpanded on Windows.
 */
export function agy_skill_directories(user_home = homedir()) {
  const entries = read_json(join(user_home, '.gemini', 'config', 'skills.json')).entries;
  const listed = (Array.isArray(entries) ? entries : []).map(entry => entry?.path).filter(value => typeof value === 'string')
    .map(value => process.platform !== 'win32' && value.startsWith('~/') ? join(user_home, value.slice(2)) : value);
  return [join(user_home, '.gemini', 'config', 'skills'), ...listed].filter(value => isAbsolute(value) && existsSync(value));
}

/** Read only the frontmatter's name and description; listing a skill never evaluates its instructions. */
function skill_file(path) {
  let descriptor;
  try {
    descriptor = openSync(path, 'r');
    const buffer = Buffer.alloc(SKILL_HEADER_BYTES);
    const text = buffer.subarray(0, readSync(descriptor, buffer, 0, buffer.length, 0)).toString('utf8');
    const header = text.replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
    if (!header) return null;
    const field = key => {
      const match = header.match(new RegExp(`^${key}:\\s*([^\\r\\n]*)(?:\\r?\\n((?:[ \\t]+[^\\r\\n]*(?:\\r?\\n|$))*))?`, 'm'));
      const value = match?.[1]?.trim() || '';
      if (/^[>|][-+]?\s*$/.test(value)) return (match[2] || '').trim().replace(/\s+/g, ' ');
      if (value.startsWith('"')) { try { return JSON.parse(value); } catch { return ''; } }
      return value.startsWith("'") && value.endsWith("'") ? value.slice(1, -1).replaceAll("''", "'") : value;
    };
    const id = field('name'), description = field('description');
    return id && description ? { id, label: id, description, prompt: `请调用技能「${id}」：` } : null;
  } catch { return null; }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}

/** List a skill itself or the immediate skill folders in one configured source, applying its manifest filters. */
function skill_source(directory, filter = {}) {
  const direct = directory.endsWith('SKILL.md') ? skill_file(directory) : skill_file(join(directory, 'SKILL.md'));
  let names;
  try { names = direct ? [''] : Array.isArray(filter.include_only) ? filter.include_only
    : readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name); }
  catch { return []; }
  return names.flatMap(name => {
    const skill = direct || skill_file(join(directory, name, 'SKILL.md'));
    if (!skill) return [];
    const matches = value => value === name || value === skill.id;
    if (filter.exclude?.some(matches) || filter.include_only && !filter.include_only.some(matches)) return [];
    return [skill];
  });
}

/** Resolve agy's discovery manifests, including inherited lists; a visited set stops manifest cycles. */
function manifest_skills(path, base, visited = new Set()) {
  if (visited.has(path)) return { skills: [], exclude: [] };
  visited.add(path);
  const manifest = read_json(path);
  const skills = (manifest.entries || []).flatMap(entry => typeof entry?.path === 'string'
    ? skill_source(resolve(base, entry.path), entry) : []);
  for (const entry of manifest.inherits || []) {
    if (typeof entry?.path !== 'string') continue;
    const inherited = resolve(base, entry.path), parent = dirname(inherited);
    const loaded = manifest_skills(inherited, parent.endsWith('.agents') ? dirname(parent) : parent, visited);
    skills.push(...loaded.skills.filter(skill => !entry.exclude?.includes(skill.id)
      && (!entry.include_only || entry.include_only.includes(skill.id))));
  }
  return { skills: skills.filter(skill => !manifest.exclude?.includes(skill.id)), exclude: manifest.exclude || [] };
}

/** Read agy's installed local skills and project manifests, without starting its model or creating a conversation. */
export function agy_skills(profile, { home = homedir() } = {}) {
  const global = join(home, '.gemini', 'config');
  const personal = manifest_skills(join(global, 'skills.json'), global);
  const skills = [...skill_source(join(global, 'skills')), ...personal.skills];
  const excluded = new Set(personal.exclude);
  const ancestors = [];
  for (let directory = profile.cwd; directory; directory = dirname(directory)) {
    ancestors.push(directory);
    if (existsSync(join(directory, '.git'))) break;
    if (dirname(directory) === directory) { ancestors.splice(1); break; }
  }
  for (const directory of ancestors.reverse()) {
    const project = manifest_skills(join(directory, '.agents', 'skills.json'), directory);
    skills.push(...skill_source(join(directory, '.agents', 'skills')), ...project.skills);
    project.exclude.forEach(name => excluded.add(name));
  }
  const selected = new Map(skills.filter(skill => !excluded.has(skill.id)).map(skill => [skill.id, skill]));
  // These legacy CLI locations override the shared discovery rules; the App does not load them.
  if (profile.adapter === 'antigravity_cli') {
    for (const root of ['skills', 'antigravity-cli/skills']) {
      for (const skill of skill_source(join(home, '.gemini', root))) selected.set(skill.id, skill);
    }
  }
  return [...selected.values()];
}

/** Test directory containment on the current platform, including Windows drive boundaries. */
function within_directory(parent, child) {
  const path = relative(resolve(parent), resolve(child));
  return !path || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`));
}

/** Deduplicate directory paths with platform case rules while preserving each first-seen string. */
function unique_paths(paths) {
  const result = [];
  for (const path of paths.filter(Boolean)) {
    if (!result.some(existing => same_path(existing, path))) result.push(path);
  }
  return result;
}

/** Resolve Antigravity's real project resources without reading any conversation; shared with the App adapter. */
export function antigravity_project(config, root = join(homedir(), '.gemini', 'config')) {
  if (!config.project_id && !config.project_name && !config.cwd) return { id: AGY_OUTSIDE_PROJECT };
  const directory = join(root, 'projects');
  const projects = readdirSync(directory).filter(name => name.endsWith('.json')).map(name => JSON.parse(readFileSync(join(directory, name), 'utf8')));
  const matching = projects.filter(project => (!config.project_id || project.id === config.project_id)
    && (!config.project_name || project.name === config.project_name)
    && (!config.cwd || (project.projectResources?.resources || []).some(resource => {
      const uri = resource.gitFolder?.folderUri || resource.folder?.folderUri;
      return uri?.startsWith('file:') && same_path(fileURLToPath(uri), config.cwd);
    })));
  if (matching.length !== 1) throw new Error('Antigravity 项目与 cwd 无法唯一匹配；请先在 App 添加目录并核对配置');
  return matching[0];
}

/**
 * Resolve only the user's selected folders, plus the room's other project directories (`task.extra_directories`); do
 * not inherit another project's grants or settings.
 */
function agy_folders(config, task, root) {
  const selected = (config.project_id || config.project_name)
    ? (antigravity_project(config, root).projectResources?.resources || [])
      .map(resource => resource.gitFolder?.folderUri || resource.folder?.folderUri)
      .filter(uri => uri?.startsWith('file:')).map(uri => fileURLToPath(uri))
    : [launch_directory(config, task)];
  return unique_paths([...selected, ...(task.extra_directories || []).map(item => item.path)]);
}

/**
 * Build native deny rules for protected directories, with separate writable answer storage. The room's project
 * directories this member may only read are protected whatever its own access.
 */
function agy_project_grants(config, task, folders, user_home) {
  const read_only = (task.extra_directories || []).filter(item => item.access === 'read').map(item => item.path);
  const projects = [...new Set([project_directory(config), ...folders].filter(directory => directory && !same_path(directory, task.draft_directory)
    && !read_only.some(path => same_path(path, directory))))];
  const protected_paths = [task.directory, ...task.skill_directories, ...agy_skill_directories(user_home), join(user_home, '.gemini'),
    ...(config.project_access === 'read' ? projects : []), ...read_only];
  if (protected_paths.some(directory => within_directory(directory, task.draft_directory))) {
    throw new Error('agy 草稿目录不能位于只读项目、运行目录、技能或 .gemini 配置目录中，未交付讨论任务');
  }
  const write_rule = directory => `write_file(${resolve(directory).replaceAll('\\', '/')})`;
  // 全放开 also allows commands outside agy's sandbox and MCP tools; deny rules are still written, but bypass may override them.
  const full = config.project_access === 'full';
  return { allow: [agy_rule(), write_rule(task.draft_directory),
    ...(config.project_access === 'read' ? [] : [...projects.map(write_rule), 'command(*)']), ...(full ? ['unsandboxed_command(*)'] : []),
    // Grants the owner allowed from a refused operation on the page.
    ...(config.allowed_tools || [])],
  deny: [...new Set(protected_paths.map(write_rule)), ...(full ? [] : ['mcp(*)'])] };
}

/** Initialize Antigravity's hidden placeholder project once on CLI-only setups; never overwrite an existing file. */
function ensure_outside_project(root) {
  const path = join(root, 'projects', `${AGY_OUTSIDE_PROJECT}.json`);
  if (existsSync(path)) return;
  mkdirSync(dirname(path), { recursive: true });
  atomic_json(path, { id: AGY_OUTSIDE_PROJECT, name: 'Outside of Project', projectResources: {},
    permissionGrants: { permissionGrants: {}, v2Migrated: true } });
}

/**
 * Prepare per-member native permissions via `--project outside-of-project` and a session `--settings` file; external
 * conversations keep their own project, so they are refused. Any legacy per-room project file is removed on upgrade.
 */
export function prepare_agy_project(config, binding, task, user_home = homedir()) {
  const key = createHash('sha256').update(task.participant).digest('hex');
  const record_path = join(task.directory, `agy-project-${key}.json`);
  const settings_path = join(task.directory, `agy-settings-${key}.json`);
  const record = read_json(record_path);
  if (binding.session_id && !record.project_id) {
    throw new Error('agy 只在本工具新建的讨论会话中自动执行；该会话不是本工具创建的，无法套用讨论项目权限，未交付讨论任务');
  }
  if (record.session_id && record.session_id !== binding.session_id) throw new Error('agy 项目记录与会话绑定不符，未交付讨论任务');
  check_agy_shell(user_home);
  const root = join(user_home, '.gemini', 'config');
  const directories = agy_folders(config, task, root);
  const grants = agy_project_grants(config, task, directories, user_home);
  if (record.project_id && record.project_id !== AGY_OUTSIDE_PROJECT && !/^[a-f0-9-]{36}$/.test(record.project_id)) {
    throw new Error('agy 项目记录无效，未交付讨论任务');
  }
  if (/^[a-f0-9-]{36}$/.test(record.project_id || '')) {
    const legacy_path = join(root, 'projects', `${record.project_id}.json`);
    if (read_json(legacy_path).id === record.project_id) rmSync(legacy_path, { force: true });
  }
  ensure_outside_project(root);
  atomic_json(settings_path, { permissions: grants });
  const saved = { project_id: AGY_OUTSIDE_PROJECT, session_id: record.session_id || '' };
  atomic_json(record_path, saved);
  return { project_id: AGY_OUTSIDE_PROJECT, settings_path, directories, bind: session_id => atomic_json(record_path, { ...saved, session_id }) };
}

/**
 * Delete the agy session records (and any legacy native project file) this room created after the room itself is deleted;
 * `outside-of-project` and the user's own projects are never touched.
 * @returns {number} How many project records were cleared.
 */
export function remove_agy_projects(directory, user_home = homedir()) {
  if (!existsSync(directory)) return 0;
  const files = readdirSync(directory);
  const records = files.filter(name => /^agy-project-[a-f0-9]{64}\.json$/.test(name));
  for (const file of records) {
    const { project_id } = read_json(join(directory, file));
    const path = join(user_home, '.gemini', 'config', 'projects', `${project_id}.json`);
    if (/^[a-f0-9-]{36}$/.test(project_id || '') && read_json(path).id === project_id) rmSync(path, { force: true });
    rmSync(join(directory, file), { force: true });
  }
  for (const file of files.filter(name => /^agy-settings-[a-f0-9]{64}\.json$/.test(name))) {
    rmSync(join(directory, file), { force: true });
  }
  return records.length;
}

/** Native agy arguments; an expert the owner chose to host keeps its own conversation's project and permissions. */
function invocation(config, binding, task, user_home) {
  const project = config.session_id ? null : prepare_agy_project(config, binding, task, user_home);
  const cwd = launch_directory(config, task);
  const extra = (project ? project.directories : (task.extra_directories || []).map(item => item.path))
    .filter(directory => !same_path(directory, cwd));
  const added = unique_paths([task.directory, task.draft_directory, ...task.skill_directories,
    ...agy_skill_directories(user_home), ...extra]);
  const args = ['--output-format', 'stream-json', '--print-timeout', '0',
    ...added.flatMap(directory => ['--add-dir', directory])];
  // Headless agy refuses `--mode auto` ("not available for this account", 1.4.10–1.4.11) though its interactive window
  // offers it; 全放开 uses the flag its own denial message suggests on top of the open session grants.
  args.push('--mode', 'accept-edits', ...(config.project_access === 'full' ? ['--dangerously-skip-permissions'] : []),
    ...(project ? ['--project', project.project_id, '--settings', project.settings_path] : []));
  if (binding.session_id) args.push('--conversation', binding.session_id);
  if (config.model) args.push('--model', config.model);
  if (config.effort) args.push('--effort', config.effort);
  args.push('-p', task.prompt);
  return { args, ...(project ? { on_session: project.bind } : {}) };
}

/** Consume only documented lifecycle events, and remember refused operations so the page can name and allow them. */
function lifecycle(state, event, task, bind) {
  if (event.event === 'init') bind(event.conversation_id);
  const step = event.step_update;
  // Headless agy ends its turn when an operation needs approval; remember which ones so the page can name and allow them.
  const denied = step?.state === 'ERROR' ? agy_denial(step) : null;
  if (denied) {
    if (!state.denials.some(item => item.detail === denied.detail) && state.denials.length < MAX_DENIALS) state.denials.push(denied);
    const action = { write_file: '写入了未授权的文件', read_file: '读取了未授权的文件' }[denied.tool] || '运行了未授权的命令';
    state.denial = `${action}「${denied.detail.slice(0, 120)}」，无人值守模式下无法确认权限而被自动拒绝，随后会话结束`;
  }
  if (event.event === 'result') {
    const result = event.result || {};
    if (result.conversation_id) bind(result.conversation_id);
    state.completed = result.status === 'SUCCESS';
    // A refused operation still ends with SUCCESS and an empty response; name it even when no failed step was seen.
    if (!state.denial && Array.isArray(result.denied_actions) && result.denied_actions.length) {
      state.denial = `的${result.denied_actions.map(item => item.display_name || item.action).join('、')}操作未获授权，无人值守模式下被自动拒绝，随后会话结束`;
    }
    // agy reports `error` as a plain string (1.4.x), older builds as { message }.
    const reason = typeof result.error === 'string' ? result.error : result.error?.message;
    if (!state.completed) state.error = `Antigravity CLI ${result.status || '缺少结果状态'}：${reason || result.response || '执行未成功'}`;
    // Failed before opening a conversation (sign-in, eligibility check): no turn ran, so delivering again repeats nothing.
    if (!state.completed && !state.initialized && !result.conversation_id && !result.num_turns) state.not_started = true;
  }
}

/**
 * What agy's stream events say the agent is doing and which tool it starts. agy streams a response in deltas, so its
 * text is collected per step in `responses` and returned as a note when the step ends.
 */
const events = {
  phase(event) {
    if (event.event === 'init') return 'thinking';
    const step = event.step_update;
    if (!step) return '';
    if (step.step_type === 'agent_response' && step.state === 'ACTIVE') return 'writing';
    if (step.step_type !== 'tool' || ['DONE', 'ERROR'].includes(step.state)) return 'thinking';
    return step.tool_name === 'run_command' ? 'command' : EDIT_TOOLS.test(step.tool_name || '') ? 'editing' : 'tool';
  },
  tool(event) {
    const step = event.step_update;
    return step?.step_type === 'tool' && !['DONE', 'ERROR'].includes(step.state) ? String(step.tool_name || '') : '';
  },
  note(event, responses = new Map()) {
    const step = event.step_update;
    if (step?.step_type !== 'agent_response') return '';
    responses.set(step.step_index, (responses.get(step.step_index) || '') + (step.text_delta || ''));
    if (step.state === 'ACTIVE') return '';
    const text = responses.get(step.step_index).trim();
    responses.delete(step.step_index);
    return text;
  },
  detail: agy_detail,
};

/**
 * One agy stream event as execution-detail entries keyed by step: a response grows by its text deltas, a tool step
 * shows its main parameter and, once finished, its output or error.
 */
function agy_detail(event) {
  if (event.event === 'result' && event.result?.status === 'ERROR') return [{ kind: 'error', body: String(event.result.error || '本轮失败') }];
  const step = event.step_update;
  if (!step) return [];
  const id = `step-${step.step_index}`;
  if (step.step_type === 'agent_response') return step.text_delta ? [{ id, kind: 'message', append: step.text_delta }] : [];
  if (step.step_type !== 'tool') return [];
  const parameters = step.tool_info?.parameters || {};
  const subject = parameters.CommandLine ?? parameters.Path ?? parameters.AbsolutePath ?? parameters.TargetFile ?? Object.values(parameters).find(value => typeof value === 'string');
  const finished = ['DONE', 'ERROR'].includes(step.state);
  return [{ id, kind: step.tool_name === 'run_command' ? 'command' : EDIT_TOOLS.test(step.tool_name || '') ? 'edit' : 'tool',
    title: step.tool_name === 'run_command' ? String(subject ?? '') : `${step.tool_name} ${subject ?? ''}`.trim(),
    state: step.state === 'ERROR' ? 'failed' : finished ? 'done' : 'running',
    body: finished ? String(step.tool_info?.error?.message ?? step.tool_info?.output ?? '') : undefined }];
}

/** Where agy keeps one conversation database, or '' when this machine has none by that ID. */
export function session_path(session_id, env = process.env, home = homedir()) {
  const file = join(home, '.gemini', 'antigravity-cli', 'conversations', `${session_id}.db`);
  return existsSync(file) ? file : '';
}

/** Whether agy stored a conversation by that ID on this machine. */
export function session_exists(session_id, { env = process.env, home = homedir() } = {}) {
  return Boolean(session_id && session_path(session_id, env, home));
}

/** Copy the conversation database under a new ID, without the steps from the first marked one on. */
function branch(profile, session_id, markers, { always, home }) {
  const file = session_path(session_id, process.env, home);
  if (!file) throw new Error(`本机找不到 agy 会话 ${session_id}`);
  const encoded = markers.map(marker => Buffer.from(marker, 'utf8'));
  const source = new DatabaseSync(file, { readOnly: true });
  const target = join(file, '..', `${randomUUID()}.db`);
  let cut;
  try {
    // The prompt is stored inside the step's protobuf payload, as UTF-8 text.
    cut = source.prepare('SELECT idx,step_payload FROM steps ORDER BY idx').all()
      .find(row => row.step_payload && encoded.some(marker => Buffer.from(row.step_payload).includes(marker)))?.idx;
    if (cut === undefined && !always) return null;
    if (cut === 0) return { session_id: '' };
    source.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
  } finally { source.close(); }
  const id = target.slice(-39, -3);
  const copy = new DatabaseSync(target);
  try {
    if (cut !== undefined) copy.prepare('DELETE FROM steps WHERE idx>=?').run(cut);
    copy.prepare('UPDATE trajectory_meta SET cascade_id=?').run(id);
  } finally { copy.close(); }
  return { session_id: id };
}

/** The model string after agy's model tag in one protobuf blob. */
function agy_model(blob) {
  const bytes = Buffer.from(blob);
  for (let at = bytes.indexOf(Buffer.from(AGY_MODEL_TAG)); at >= 0; at = bytes.indexOf(Buffer.from(AGY_MODEL_TAG), at + 1)) {
    const length = bytes[at + 2], text = bytes.subarray(at + 3, at + 3 + length).toString('latin1');
    if (length && text.length === length && MODEL_PATTERN.test(text)) return text;
  }
  return '';
}

/** The model a conversation last ran with, from its database; agy names the effort inside the model ID (gemini-…-medium). */
export function session_settings(session_id, { env = process.env, home = homedir() } = {}) {
  return database_settings(session_path(session_id, env, home));
}

/** The model a conversation database last ran with; agy and the Antigravity App store it alike. */
export function database_settings(file) {
  if (!file) return null;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    for (const { data } of db.prepare('SELECT data FROM gen_metadata ORDER BY idx DESC LIMIT 5').all()) {
      const model = data ? agy_model(data) : '';
      if (model) return { model, effort: '' };
    }
  } finally { db.close(); }
  return null;
}

/** agy's native slash commands answer without an agent turn: /effort lists levels, /model names the current model. */
function slash_command(profile, command, options) {
  const args = ['-p', `/${command}`, '--output-format', 'json', ...(command === 'effort' && profile.model ? ['--model', profile.model] : [])];
  return query_catalog(profile, args, (send, finish) => ({ start: () => {}, line: line => {
    const reply = json_line(line), data = reply?.command?.data;
    if (reply?.status !== 'SUCCESS' || reply.command?.name !== command || !data) return;
    if (command === 'effort' && Array.isArray(data.available)) finish(null, data.adjustable ? data.available.filter(level => typeof level === 'string') : []);
    if (command === 'model') finish(null, { model: MODEL_PATTERN.test(data.id || '') ? data.id : '', effort: typeof data.effort === 'string' ? data.effort : '' });
  } }), options);
}

/** `agy models` prints tab-separated ids and labels. */
function models(profile, options) {
  return query_catalog(profile, ['models'], () => {
    const list = [];
    return { start: () => {}, complete: () => list, line: line => {
      const fields = line.trim().split(/\t+| {2,}/);
      if (fields.length >= 2) list.push(model_entry(fields[0], fields.slice(1).join(' ')));
    } };
  }, options);
}

/** The effort levels agy offers for the selected model. */
function effort(profile, options) {
  if (!isAbsolute(profile.executable || '') || (profile.model && !MODEL_PATTERN.test(profile.model))) return Promise.reject(new Error('无法读取所选模型的思考档位'));
  return slash_command(profile, 'effort', options);
}

/** What agy runs with when the card leaves model or effort empty, from its native /model. */
async function defaults(profile, options = {}) {
  if (!isAbsolute(profile.executable || '')) return { model: '', effort: '' };
  try { return await slash_command(profile, 'model', options); }
  catch { return { model: '', effort: '' }; }
}

/**
 * Whether another agy process has this conversation open: while it does, agy holds an exclusive lock on
 * presence/<id>.lock, and reading the locked byte fails. Only Windows enforces that lock, so elsewhere this says false.
 */
export function conversation_open_elsewhere(session_id, user_home = homedir()) {
  let descriptor;
  try { descriptor = openSync(join(user_home, '.gemini', 'antigravity-cli', 'presence', `${session_id}.lock`), 'r'); }
  catch { return false; }
  try { readSync(descriptor, Buffer.alloc(1), 0, 1, 0); return false; }
  catch (error) { return error.code === 'EBUSY'; }
  finally { closeSync(descriptor); }
}

/**
 * Deliver one turn, except into a conversation the user has open in an agy terminal: that window keeps its own copy
 * and its next write drops a turn run from outside, so a room task or a private chat line is refused before anything
 * runs and the runner reports why (tested on agy 1.5.2).
 */
function deliver(config, binding, task, spawn_process, user_home = homedir()) {
  if (binding.session_id && conversation_open_elsewhere(binding.session_id, user_home)) {
    throw not_sent(new Error('这个会话正在你的 agy 终端里打开，外部写入会被终端覆盖；请先关闭终端，或直接在终端里继续'));
  }
  return cli_delivery(antigravity_cli, config, binding, task, spawn_process, user_home);
}

/**
 * Back up and remove legacy CoDiscuss-created blank project files from `~/.gemini/config/projects/`; user projects,
 * `outside-of-project`, `default-cli-project` and any project bound to an installed Sidecar are never touched.
 */
export function sweep_legacy_agy_projects(service_home, user_home = homedir()) {
  const root = join(user_home, '.gemini', 'config'), projects = join(root, 'projects');
  if (!existsSync(projects)) return 0;
  const sidecars = Object.values(read_json(join(root, 'config.json')).sidecars || {});
  const pinned = new Set(sidecars.map(item => item?.projectId).filter(Boolean));
  const targets = readdirSync(projects).filter(file => /^[a-f0-9-]{36}\.json$/.test(file)).filter(file => {
    const data = read_json(join(projects, file));
    return data.id === file.slice(0, -5) && !pinned.has(data.id)
      && /^(?:CoDiscuss(?: · |$)|codiscuss-(?:[0-9a-f]{12}|verification)$)/.test(String(data.name || ''));
  });
  if (!targets.length) return 0;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');
  const backup = join(service_home, 'backups', `antigravity-projects-${stamp}`);
  mkdirSync(backup, { recursive: true });
  let removed = 0;
  try {
    for (const file of targets) {
      copyFileSync(join(projects, file), join(backup, file));
      rmSync(join(projects, file));
      removed += 1;
    }
  } catch (error) {
    if (!removed) rmSync(backup, { recursive: true, force: true });
    throw error;
  }
  return removed;
}

/** agy's behaviour; its static facts are in profiles.mjs. */
export const antigravity_cli = {
  id: 'antigravity_cli', catalog_source: 'antigravity-cli',
  // A deleted room's session records and any legacy private agy projects are removed with it.
  cleanup: remove_agy_projects, sweep: sweep_legacy_agy_projects,
  deliver,
  invocation, lifecycle, events,
  session: { path: session_path, exists: session_exists, owns: session_exists, branch, settings: session_settings },
  models: { list: models, effort, defaults },
  skills: agy_skills,
};

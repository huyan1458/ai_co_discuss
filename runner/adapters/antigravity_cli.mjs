/**
 * agy (Antigravity CLI) adapter: one headless `agy -p` turn per execution, run inside a private native project this tool
 * creates so its permission grants apply. Sessions are conversation databases, branched by copying them (not an
 * official interface; tested on agy 1.4.9). Antigravity's project registry is shared with the App adapter.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { atomic_json } from '../files.mjs';
import { cli_delivery } from './cli.mjs';
import { DENIAL_FIELD, EDIT_TOOLS, json_line, launch_directory, MAX_DENIALS, model_entry, MODEL_PATTERN, project_directory,
  query_catalog, read_json, same_path, TASK_SUBCOMMANDS } from './common.mjs';

// agy stores its generation settings as protobuf; field 28 (tag bytes 0xe2 0x01) holds the model actually used.
const AGY_MODEL_TAG = [0xe2, 0x01];

/**
 * One operation a headless agy run refused, from the failed tool step, with the project grant that would allow it.
 * agy names the check that failed: a sandboxed or unsandboxed command, or a file write.
 */
export function agy_denial(step) {
  const message = step.tool_info?.error?.message || '';
  if (!/permission check failed/.test(message)) return null;
  const parameters = step.tool_info.parameters || {};
  // Older agy did not name the check; a refused step with a command line was a command.
  const kind = message.match(/permission check failed for (\w+)/)?.[1] || (parameters.CommandLine ? 'command' : '');
  if (!kind) return null;
  if (kind === 'write_file') {
    const path = String(parameters.Path || parameters.TargetFile || message.match(/write_file\(([^)]+)\)/)?.[1] || '');
    return { tool: 'write_file', detail: path.slice(0, DENIAL_FIELD), rule: path ? `write_file(${resolve(dirname(path)).replaceAll('\\', '/')})` : '' };
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

/** Native headless review blocks unapproved shell commands; only a global grant of every command could bypass the project rules. */
function check_agy_shell(user_home) {
  const cli = read_json(join(user_home, '.gemini', 'antigravity-cli', 'settings.json'));
  const shared = read_json(join(user_home, '.gemini', 'config', 'config.json'));
  const grants = [...(cli.permissions?.allow || []), ...(shared.userSettings?.globalPermissionGrants?.allow || [])];
  if (grants.some(rule => rule === '*' || /^(?:command|unsandboxed|unsandboxed_command)\((?:\*|regex:\.\*)\)$/.test(rule))) {
    throw new Error('agy 全局设置放行了所有命令，会绕过讨论项目的权限；请移除全局 command(*) / unsandboxed(*) 放行，具体命令的放行不受影响（本工具旧版写入的规则可运行 codiscuss setup 清理），未交付讨论任务');
  }
}

/** Test directory containment on the current platform, including Windows drive boundaries. */
function within_directory(parent, child) {
  const path = relative(resolve(parent), resolve(child));
  return !path || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`));
}

/** Resolve Antigravity's real project resources without reading any conversation; shared with the App adapter. */
export function antigravity_project(config, root = join(homedir(), '.gemini', 'config')) {
  if (!config.project_id && !config.project_name && !config.cwd) return { id: 'outside-of-project' };
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

/** Resolve only the user's selected folders; do not inherit another project's grants or settings. */
function agy_resources(config, task, root) {
  if (config.project_id || config.project_name) return antigravity_project(config, root).projectResources?.resources || [];
  return [{ folder: { folderUri: pathToFileURL(launch_directory(config, task)).href } }];
}

/** Build native deny rules for protected directories, with separate writable answer storage. */
function agy_project_grants(config, task, resources, user_home) {
  const folders = resources.map(resource => resource.gitFolder?.folderUri || resource.folder?.folderUri)
    .filter(uri => uri?.startsWith('file:')).map(uri => fileURLToPath(uri));
  const projects = [...new Set([project_directory(config), ...folders].filter(directory => directory && !same_path(directory, task.draft_directory)))];
  const protected_paths = [task.directory, task.skills_directory, join(user_home, '.gemini'),
    ...(config.project_access === 'read' ? projects : [])];
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

/** Run agy only inside a private native project this tool created; external conversations keep their own project, so they are refused. */
export function prepare_agy_project(config, binding, task, user_home = homedir()) {
  const key = createHash('sha256').update(task.participant).digest('hex');
  const record_path = join(task.directory, `agy-project-${key}.json`);
  const record = read_json(record_path);
  if (binding.session_id && !record.project_id) {
    throw new Error('agy 只在本工具新建的讨论会话中自动执行；该会话不是本工具创建的，无法套用讨论项目权限，未交付讨论任务');
  }
  if (record.session_id && record.session_id !== binding.session_id) throw new Error('agy 项目记录与会话绑定不符，未交付讨论任务');
  check_agy_shell(user_home);
  const root = join(user_home, '.gemini', 'config');
  const resources = agy_resources(config, task, root);
  const grants = agy_project_grants(config, task, resources, user_home);
  const project_id = record.project_id || randomUUID();
  if (!/^[a-f0-9-]{36}$/.test(project_id)) throw new Error('agy 项目记录无效，未交付讨论任务');
  const path = join(root, 'projects', `${project_id}.json`);
  const current = read_json(path);
  if (record.project_id && current.id !== project_id) throw new Error('agy 讨论项目已丢失或不匹配，未交付讨论任务');
  mkdirSync(join(root, 'projects'), { recursive: true });
  const name = ['CoDiscuss', task.room_title, task.participant].filter(Boolean).join(' · ');
  atomic_json(path, { ...current, id: project_id, name,
    projectResources: { resources }, settings: {}, permissionGrants: { permissionGrants: grants, v2Migrated: true } });
  const saved = { project_id, session_id: record.session_id || '' };
  atomic_json(record_path, saved);
  return { project_id, bind: session_id => atomic_json(record_path, { ...saved, session_id }) };
}

/**
 * Delete the agy projects this room created after the room itself is deleted; the user's own projects are never touched.
 * @returns {number} How many project records were cleared.
 */
export function remove_agy_projects(directory, user_home = homedir()) {
  if (!existsSync(directory)) return 0;
  const records = readdirSync(directory).filter(name => /^agy-project-[a-f0-9]{64}\.json$/.test(name));
  for (const file of records) {
    const { project_id } = read_json(join(directory, file));
    const path = join(user_home, '.gemini', 'config', 'projects', `${project_id}.json`);
    if (/^[a-f0-9-]{36}$/.test(project_id || '') && read_json(path).id === project_id) rmSync(path);
    rmSync(join(directory, file));
  }
  return records.length;
}

/** Native agy arguments; an expert the owner chose to host keeps its own conversation's project and permissions. */
function invocation(config, binding, task, user_home) {
  const project = config.session_id ? null : prepare_agy_project(config, binding, task, user_home);
  const args = ['--output-format', 'stream-json', '--print-timeout', '0', '--add-dir', task.directory,
    '--add-dir', task.draft_directory, '--add-dir', task.skills_directory];
  // Headless agy refuses `--mode auto` ("not available for this account", 1.4.10–1.4.11) though its interactive window
  // offers it; 全放开 uses the flag its own denial message suggests on top of the open project grants.
  args.push('--mode', 'accept-edits', ...(config.project_access === 'full' ? ['--dangerously-skip-permissions'] : []),
    ...(project ? ['--project', project.project_id] : []));
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
    state.denial = `${denied.tool === 'write_file' ? '写入' : '运行'}了未授权的${denied.tool === 'write_file' ? '文件' : '命令'}「${denied.detail.slice(0, 120)}」，无人值守模式下无法确认权限而被自动拒绝，随后会话结束`;
  }
  if (event.event === 'result') {
    const result = event.result || {};
    if (result.conversation_id) bind(result.conversation_id);
    state.completed = result.status === 'SUCCESS';
    // A refused operation still ends with SUCCESS and an empty response; name it even when no failed step was seen.
    if (!state.denial && Array.isArray(result.denied_actions) && result.denied_actions.length) {
      state.denial = `的${result.denied_actions.map(item => item.display_name || item.action).join('、')}操作未获授权，无人值守模式下被自动拒绝，随后会话结束`;
    }
    if (!state.completed) state.error = `Antigravity CLI ${result.status || '缺少结果状态'}：${result.error?.message || result.response || '执行未成功'}`;
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
};

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

/** agy's behaviour; its static facts are in profiles.mjs. */
export const antigravity_cli = {
  id: 'antigravity_cli', catalog_source: 'antigravity-cli',
  // A deleted room's private agy projects are removed with it.
  cleanup: remove_agy_projects,
  deliver: (config, binding, task, spawn_process, user_home) => cli_delivery(antigravity_cli, config, binding, task, spawn_process, user_home),
  invocation, lifecycle, events,
  session: { path: session_path, exists: session_exists, owns: session_exists, branch, settings: session_settings },
  models: { list: models, effort, defaults },
};

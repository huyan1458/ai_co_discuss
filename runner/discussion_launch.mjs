/** Shared launch configuration for an existing AI conversation and the local website. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { atomic_json } from './discussion_adapters.mjs';
import { acquire_lock, api, DiscussionStore, task_files, validate_config } from './discussion_runner.mjs';
import { read_registry, registered_identity, register_room, service_home, start_service } from './discussion_service.mjs';

const CLIENTS = { Codex: ['codex_cli', 'codex'], Claude: ['claude'], Gemini: ['antigravity_cli', 'antigravity'] };
const PROFILE_FIELDS = ['adapter', 'executable', 'source_thread_id', 'ipc_directory', 'allowed_tools', 'cwd', 'project_name', 'project_id'];
const MAX_MINUTES = 1440;
const HELP = `用法：codiscuss launch settings [--file FILE]
      codiscuss launch start --file FILE [--dry-run]

settings 读取本机软件默认配置；指定文件时保存，不启动 AI。
start 使用启动 JSON 创建或接入房间并启动；--dry-run 只校验和预览。
JSON 指定 site、entry（conversation/web）、room（建房内容，含 submission_id）
或 room_id（已有房间）、participants（本次软件覆盖配置）。
conversation 还须 current_session_id，当前会话接手首个主持任务。
已有受保护房间使用 access_file。路径、凭据只保存在本机。
详见 docs/runner.md 的“两种讨论入口与启动配置”。
`;

/** Read private defaults without selecting a global room or identity. */
export function launch_settings(home) {
  const path = join(home, 'launch-settings.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { participants: {} };
}

/** Save only reusable client settings; room credentials and session bindings are never defaults. */
export function save_launch_settings(home, input) {
  const participants = {};
  for (const [name, profile] of Object.entries(input.participants || {})) {
    validate_profile(name, profile);
    participants[name] = profile;
  }
  const settings = { participants };
  mkdirSync(home, { recursive: true, mode: 0o700 });
  atomic_json(join(home, 'launch-settings.json'), settings);
  return settings;
}

/** Reject malformed client fields before saving defaults or creating any discussion. */
function validate_profile(name, profile, binding = false) {
  if (!CLIENTS[name] || !profile || typeof profile !== 'object' || Array.isArray(profile)) throw new Error(`不支持的软件配置：${name}`);
  if (profile.adapter && !CLIENTS[name].includes(profile.adapter)) throw new Error(`${name} 的客户端不匹配`);
  const fields = binding ? [...PROFILE_FIELDS, 'session_id'] : PROFILE_FIELDS;
  if (Object.keys(profile).some(key => !fields.includes(key))) throw new Error('软件配置包含不支持的字段；默认配置不能保存房间或会话绑定');
  for (const [key, value] of Object.entries(profile)) {
    if (key === 'allowed_tools') {
      if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error(`${name}.allowed_tools 必须为工具名称数组`);
    } else if (typeof value !== 'string') throw new Error(`${name}.${key} 必须为文本`);
    if (['executable', 'cwd', 'ipc_directory'].includes(key) && value && !isAbsolute(value)) throw new Error(`${name}.${key} 必须为完整绝对路径`);
  }
}

/** Send one request without following redirects that could disclose the room credential. */
async function site_request(site, path, token, body) {
  const response = await fetch(`${site}${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Discussion-Token': token },
    body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(10000) });
  const result = await response.json();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${result.error || '请求失败'}`);
  return result;
}

/** Require an explicit website, launch entry and stable creation identity. */
function launch_input(input) {
  const value = structuredClone(input);
  const url = new URL(value.site);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('site 必须为 HTTP(S) 根地址');
  value.site = url.origin;
  if (!['conversation', 'web'].includes(value.entry)) throw new Error('entry 必须为 conversation 或 web');
  if (value.entry === 'conversation' && (typeof value.current_session_id !== 'string' || !value.current_session_id.trim())) throw new Error('对话入口须提供当前实际会话的 current_session_id');
  if (value.cwd && (typeof value.cwd !== 'string' || !isAbsolute(value.cwd))) throw new Error('cwd 必须为完整绝对路径');
  if (value.room_id && !/^[A-Za-z0-9_-]+$/.test(value.room_id)) throw new Error('房间编号无效');
  if (!value.room_id && !value.room?.submission_id) throw new Error('新房间须提供 room.submission_id；重试沿用原编号');
  if (value.access_file) {
    const access = JSON.parse(readFileSync(resolve(value.access_file), 'utf8'));
    if (access.site?.replace(/\/$/, '') !== value.site || access.room !== value.room_id) throw new Error('access_file 与本次站点或房间不符');
    value.token = access.token;
  }
  return value;
}

/** Merge machine defaults and explicit room overrides, preserving the selected participants. */
function launch_config(home, input, room, directory, options) {
  if (!room.experts || room.experts[room.host] !== 'cli' || !CLIENTS[room.host]) throw new Error('请将 AI 主持人的参与方式设为本地读写');
  const online = Object.entries(room.experts).filter(([, mode]) => mode !== 'cli').map(([name]) => name);
  if (online.length) throw new Error(`全自动无法接入在线专家：${online.join('、')}。请调整参与方式或改用手动推进`);
  const defaults = options.defaults || launch_settings(home).participants;
  const participants = {};
  for (const name of new Set([room.host, ...Object.keys(room.experts)])) {
    const profile = { ...defaults[name], ...input.participants?.[name] };
    for (const field of ['cwd', 'project_name', 'project_id']) if (profile[field] === '') delete profile[field];
    validate_profile(name, profile, true);
    if (!CLIENTS[name]?.includes(profile.adapter)) throw new Error(`请配置 ${name} 的 CLI / App 客户端`);
    if (profile.adapter !== 'antigravity' && (!existsSync(profile.executable || '') || !statSync(profile.executable).isFile()
      || (process.platform === 'win32' && !/\.exe$/i.test(profile.executable)))) throw new Error(`${name}：请指定实际原生可执行文件，Windows 使用 .exe`);
    const cwd = profile.cwd || input.cwd;
    if (cwd && (!existsSync(cwd) || !statSync(cwd).isDirectory())) throw new Error(`${name}：工作目录不存在或不是文件夹，请核对本次目录配置`);
    if (input.entry === 'conversation' && name === room.host) profile.session_id = input.current_session_id;
    participants[name] = profile;
  }
  return validate_config({ site: input.site, room: room.id || 'preview', token: options.token, participants,
    cwd: input.cwd, discussion_project: input.discussion_project, data_directory: join(directory, 'runtime') }, directory);
}

/** Stable signatures make changed retry requests explicit without putting credentials in receipts. */
function signature(value) {
  if (Array.isArray(value)) return `[${value.map(signature).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => `${JSON.stringify(key)}:${signature(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

/** Choose a finite execution deadline; zero topic minutes still require an explicit run budget. */
function launch_minutes(input, room) {
  const minutes = Number(input.minutes ?? room.limits?.max_minutes);
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > MAX_MINUTES) throw new Error('请设置讨论总时长或 minutes，范围 (0,1440]');
  return minutes;
}

/** Refuse a second registry owner before changing the website runtime. */
function check_registration(home, config, path) {
  for (const registered of read_registry(home)) {
    if (resolve(registered) === path || !existsSync(registered)) continue;
    const other = registered_identity(registered);
    if (other?.site === config.site && other.room === config.room) throw new Error('房间已使用另一份接入配置登记；请沿用原配置，不重复接入');
  }
}

/** Start once; a lost start response is reconciled from the persisted expected generation. */
async function enable_run(config, record, persist, minutes) {
  let runtime = await api(config, '/runtime');
  if (!record.generation && record.expected_generation === runtime.generation && runtime.revision === record.start_revision && runtime.status === 'running') {
    record.generation = runtime.generation;
    persist();
  }
  if (record.generation) {
    if (runtime.generation !== record.generation || runtime.status !== 'running' || runtime.expired) throw new Error('这次启动已暂停、停止或过期；请在原房间核对并明确继续');
    return runtime;
  }
  if (runtime.status === 'running') throw new Error('房间已在运行；不会重复启动或替换会话');
  if (!record.start_revision) { record.start_revision = runtime.revision + 1; persist(); }
  if (runtime.revision + 1 !== record.start_revision) throw new Error('启动期间房间状态已变化，请核对原房间');
  record.expected_generation = runtime.generation + 1;
  persist();
  try {
    runtime = await api(config, '/runtime', { action: 'start', mode: 'automatic', revision: runtime.revision,
      deadline: Math.floor(Date.now() / 1000 + minutes * 60) });
  } catch (error) {
    const latest = await api(config, '/runtime');
    if (latest.generation !== record.expected_generation || latest.status !== 'running') throw error;
    runtime = latest;
  }
  record.generation = runtime.generation;
  persist();
  return runtime;
}

/** Reserve the first host task for the calling conversation without sending it a duplicate prompt. */
async function current_host_task(config, record, persist, room) {
  const page = await api(config, '/events?after=0');
  const event = record.event_id ? page.events.find(item => item.id === record.event_id)
    : page.events.filter(item => item.generation === record.generation && item.role === 'host' && item.participant === room.host && item.status === 'pending').at(-1);
  if (!event) throw new Error('没有可由当前会话接手的主持任务；请核对原房间');
  record.event_id = event.id;
  record.execution_token ||= randomUUID();
  persist();
  if (event.status === 'pending') await api(config, `/events/${event.id}`, { action: 'reserve', execution_token: record.execution_token });
  else await api(config, `/events/${event.id}`, { action: 'view' }, record.execution_token);
  const store = new DiscussionStore(config.directory);
  try {
    store.context(config);
    const runtime = await api(config, '/runtime');
    store.scope(config, runtime.run_id);
    store.receive(page);
    const session_id = config.participants[room.host].session_id;
    store.bind(room.host, session_id);
    const task = task_files(config, event, record.execution_token, { session_id });
    store.record(event.id, { status: 'accepted', token: record.execution_token, sent_at: Date.now() });
    return { event_id: event.id, access_file: task.access_path, task_file: join(config.directory, `${task.id}.task.json`) };
  } finally { store.close(); }
}

/** Return launch evidence and paths, never raw control or execution tokens. */
async function launch_receipt(config, record, config_path) {
  const room = await api(config, '');
  return { entry: record.entry, room, url: `${config.site}/?room=${config.room}`, config_path,
    status: room.runtime.status, current_task: record.current_task || null };
}

/** Read a saved launch without creating state during validation or preview. */
function read_launch(directory) {
  const path = join(directory, 'launch.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

/** Prove dispatcher access before a protected room is started or a corrected credential is saved. */
async function verify_control(config, room) {
  if (room.runtime?.protected) await api({ ...config, room: room.id }, '/events?after=0');
}

/** Pin resolved defaults, while comparing retries against only the caller's explicit request. */
async function prepare_launch(home, input, directory) {
  const previous = read_launch(directory);
  const { token: ignored_token, access_file: ignored_access, ...request } = input;
  const request_signature = signature(request);
  if (previous?.request_signature && previous.request_signature !== request_signature) throw new Error('启动配置与原请求不同；同一次重试须沿用原配置，新讨论请使用新提交编号');
  const legacy = previous && !previous.request_signature ? JSON.parse(previous.signature) : null;
  const config_path = join(directory, 'config.json');
  const saved = previous?.config || (previous && existsSync(config_path) ? JSON.parse(readFileSync(config_path, 'utf8')) : null);
  const token = input.token || previous?.token || randomUUID();
  const room_id = input.room_id || previous?.room_id || (saved?.room !== 'preview' ? saved?.room : null);
  const room = room_id ? await site_request(input.site, `/api/rooms/${room_id}`, token) : input.room;
  if (room.runtime?.protected && !input.token && !previous) throw new Error('已有房间需要原接入配置的 access_file');
  if (!previous && room.runtime && room.runtime.status !== 'ready') throw new Error('房间已启动过；请沿用原配置核对或从原进度看板明确继续');
  const config = previous?.request_signature ? { ...structuredClone(saved), token }
    : launch_config(home, input, room, directory, { token, defaults: saved?.participants || legacy?.participants });
  if (previous?.request_signature && !previous.finished) validate_config(config, directory);
  const minutes = previous?.minutes ?? legacy?.minutes ?? launch_minutes(input, room);
  const draft = signature({ entry: input.entry, room_id: input.room_id, room: input.room, participants: config.participants, cwd: input.cwd, discussion_project: input.discussion_project, minutes });
  if (legacy && previous.signature !== draft) throw new Error('启动配置与原请求不同；同一次重试须沿用原配置，新讨论请使用新提交编号');
  await verify_control(config, room);
  return { input, config, room, minutes, draft, request_signature, directory, previous };
}

/** Launch a room through either entry, using a durable journal for safe retries. */
export async function launch_discussion(home, raw, options = {}) {
  const input = launch_input(raw);
  const key = createHash('sha256').update(`${input.site}/${input.room_id || input.room.submission_id}`).digest('hex');
  const directory = join(home, 'launches', key);
  const preview = await prepare_launch(home, input, directory);
  if (options.dry_run) return { dry_run: true, entry: input.entry, site: input.site, room_id: input.room_id || null,
    host: preview.room.host, participants: preview.config.participants, cwd: preview.config.cwd || null,
    discussion_project: preview.config.discussion_project || null, minutes: preview.minutes };
  const release = acquire_lock(directory);
  try { return await perform_launch(home, await prepare_launch(home, input, directory), options); }
  finally { release(); }
}

/** Persist preparation before writes, hand off the current host when needed, then register once. */
async function perform_launch(home, context, options) {
  const { input, config, minutes, draft, request_signature, directory, previous } = context;
  const record = previous || { token: config.token, signature: draft, request_signature, config, minutes, entry: input.entry };
  const persist = () => atomic_json(join(directory, 'launch.json'), record);
  if (!previous) persist();
  let room = context.room;
  if (!input.room_id) room = await site_request(input.site, '/api/rooms', config.token, { ...input.room, runtime_mode: 'automatic' });
  config.room = room.id;
  await verify_control(config, room);
  Object.assign(record, { token: config.token, request_signature, config, minutes, room_id: room.id });
  persist();
  const config_path = join(directory, 'config.json');
  check_registration(home, config, config_path);
  if (record.finished) {
    const saved = existsSync(config_path) ? JSON.parse(readFileSync(config_path, 'utf8')) : config;
    if (saved.token !== config.token || !existsSync(config_path)) atomic_json(config_path, { ...saved, token: config.token });
    return launch_receipt(config, record, config_path);
  }
  atomic_json(config_path, config);
  const service = await (options.start_service || start_service)(home);
  if (!service?.running) throw new Error('讨论服务未就绪，未开始本次讨论');
  await enable_run(config, record, persist, minutes);
  if (input.entry === 'conversation') record.current_task = await current_host_task(config, record, persist, room);
  register_room(home, config_path);
  record.finished = true;
  persist();
  return launch_receipt(config, record, config_path);
}

/** CLI and local HTTP bridge use the same commands and configuration validation. */
export async function launch_main(args = process.argv.slice(2), input_text) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    file: { type: 'string' }, 'dry-run': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help || !positionals.length) return process.stdout.write(HELP);
  const input = input_text === undefined ? (values.file ? JSON.parse(readFileSync(values.file, 'utf8').replace(/^\uFEFF/, '')) : null) : JSON.parse(input_text);
  const home = service_home();
  let result;
  if (positionals[0] === 'settings') result = input ? save_launch_settings(home, input) : launch_settings(home);
  else if (positionals[0] === 'start' && input) result = await launch_discussion(home, input, { dry_run: values['dry-run'] });
  else throw new Error(HELP);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  const stdin = args.includes('--stdin') ? readFileSync(0, 'utf8') : undefined;
  launch_main(args.filter(arg => arg !== '--stdin'), stdin).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}

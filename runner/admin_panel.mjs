#!/usr/bin/env node
/**
 * The computer owner's management panel: hosted accounts, their Windows users, AI command-line sign-ins and API keys.
 *
 * A small HTTP server on 127.0.0.1 serves web/admin.html and a JSON API, and a taskbar icon opens it. Loopback is shared
 * by every user and program on this computer, including the AI programs of hosted accounts, so the API also requires a
 * session that only the owner can start: the icon (or `codiscuss panel open`) opens the page with a key kept in the
 * owner's private service directory.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, realpathSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { account_home, add_account, data_home, entry_settings, entry_status, instance_home, read_accounts, remove_account, reset_password, save_entry_settings,
  instance_key, set_account_disabled, set_account_protected, start_entry, stop_entry } from '../gateway/gateway.mjs';
import { verified_connection } from './entry_client.mjs';
import { API_PROVIDERS, save_api_key } from './discussion_api.mjs';
import { STT_PROVIDERS, TTS_PROVIDERS } from './tts_providers.mjs';
import { ensure_tunnel, start_tunnel_setup, tunnel_setup_state, tunnel_status } from './hosting_tunnel.mjs';
import { machine_links } from './remote_launch.mjs';
import { apply_login, cancel_login, LOGIN_METHODS, login_progress, login_status, logout, start_login, submit_login } from './cli_login.mjs';
import { create_os_user, install_shared_runtime, instance_key_file, place_instance_key, read_os_users, remove_os_user, run_as_user, shared_cli_state, shared_executables, shared_paths,
  start_instance_as_user } from './os_users.mjs';
import { install_workflows, shipped_workflows } from './discussion_skills.mjs';
import { list_workflows, workflows_home } from './workflows.mjs';
import { hosted_prompt, import_skill, library_root, list_library, remove_library_skill, save_hosted_prompt } from './skill_library.mjs';
import { local_status } from './discussion_local.mjs';
import { autostart_enabled, launcher_path, set_autostart } from './launcher.mjs';
import { show_tray } from './tray.mjs';
import { OPERATOR_EVENTS_FILE } from './account_space.mjs';
import { can_notify, send_notice } from './weixin.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WEB = join(ROOT, 'web');
const LOCAL_SCRIPT = join(ROOT, 'runner', 'discussion_local.mjs');
const DEFAULT_PORT = 8790;
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const NPM_PACKAGE = 'ai_co_discuss';
const LATEST_URL = `https://registry.npmjs.org/${NPM_PACKAGE}/latest`;
const LATEST_TTL_MS = 60 * 60 * 1000;
const LATEST_TIMEOUT_MS = 8000;
const STATE_FILE = 'admin-panel.json';
// An update's progress and report, kept in the service directory (panel_updater.mjs writes it too), and how long an
// unfinished one blocks another.
const UPDATE_JOB_FILE = 'panel-update.json';
const UPDATE_STALE_MS = 10 * 60 * 1000;
const OWNER_ENV_TIMEOUT_MS = 120_000;
// How often the panel makes sure the entry's tunnel runs as set, and how long an update waits for the entry to be back.
const TUNNEL_CHECK_MS = 60_000;
const ENTRY_BACK_MS = 15_000;
// How long the panel waits for the relay's entry Worker to answer whether it is reachable.
const RELAY_CHECK_MS = 5000;
// Hosted accounts' failures, relayed to the owner's Weixin: how often, how far each account's outbox was read, and limits
// on what one notice carries (the outbox is in the account's own folder, so its text is the account's, not ours).
const RELAY_MS = 30_000;
const RELAY_STATE_FILE = 'operator-relay.json';
const RELAY_READ_LIMIT = 64 * 1024;
const RELAY_LISTED = 5;
const RELAY_TEXT_LIMIT = 160;
// Where account_env.mjs (and setup) record the skills they installed, in the service home.
const SKILL_RECORD = 'skills-manifest.json';
// How a panel started by an update receives its predecessor's key and sessions (only that child process sees it).
const HANDOVER_VARIABLE = 'CODISCUSS_PANEL_HANDOVER';
const SESSION_COOKIE = 'codiscuss_panel';
const BODY_LIMIT = 64 * 1024;
const UPLOAD_LIMIT = 40 * 1024 * 1024;
const PROBE_TIMEOUT_MS = 1500;
// How long a restarted instance may take to answer again, and how often it is asked.
const INSTANCE_READY_MS = 30_000;
const INSTANCE_POLL_MS = 500;
const STATIC_FILES = { '/': 'admin.html', '/admin.html': 'admin.html', '/admin.js': 'admin.js', '/admin.css': 'admin.css', '/mark.svg': 'mark.svg' };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png' };
const HELP = `用法：codiscuss panel [run|start|open|stop] [--port ${DEFAULT_PORT}]

  run    在前台运行管理面板与任务栏图标
  start  在后台启动（已在运行则不重复启动）
  open   打开管理面板（未运行时先启动）
  stop   停止管理面板与任务栏图标
`;

// ---- This computer's service ----

/** The owner's own service as the overview shows it: whether it runs, where, and which version. */
function service_overview(data) {
  const status = local_status(data);
  return { running: Boolean(status.running), website: Boolean(status.website_running), url: status.url || '', version: status.version || '',
    home: data, error: status.service_error || '' };
}

let latest = { at: 0, version: '' };

/** The newest published version, asked of the npm registry at most once an hour (nothing about this computer is sent). */
async function latest_version(force = false) {
  if (!force && latest.version && Date.now() - latest.at < LATEST_TTL_MS) return latest.version;
  const response = await fetch(LATEST_URL, { signal: AbortSignal.timeout(LATEST_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`查询新版本失败（HTTP ${response.status}）`);
  latest = { at: Date.now(), version: String((await response.json()).version || '') };
  return latest.version;
}

/** Whether version a is newer than b (plain x.y.z). */
export function newer_version(a, b) {
  const left = String(a).split('.').map(Number), right = String(b).split('.').map(Number);
  for (let index = 0; index < 3; index += 1) if ((left[index] || 0) !== (right[index] || 0)) return (left[index] || 0) > (right[index] || 0);
  return false;
}

/** Run a command to its end, failing with the last of its output. */
function run_command(command, args) {
  return new Promise((done, fail) => {
    // No shell: an unquoted path with a space (C:\Program Files\nodejs\node.exe) would be cut at the space.
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output = (output + chunk).slice(-4000); });
    child.stderr.on('data', chunk => { output = (output + chunk).slice(-4000); });
    child.on('error', fail);
    child.on('exit', code => code === 0 ? done() : fail(Object.assign(new Error(`${command} ${args.join(' ')} 失败（退出码 ${code}）：${output.trim().split(/\r?\n/).slice(-3).join(' ')}`), { code })));
  });
}

function update_job(data) {
  try { return JSON.parse(readFileSync(join(data, UPDATE_JOB_FILE), 'utf8')); } catch { return null; }
}

function write_update_job(data, job) {
  writeFileSync(join(data, UPDATE_JOB_FILE), JSON.stringify(job), { mode: 0o600 });
}

/** A step of an update, recorded as done or as failed with its reason; the steps after it still run. */
async function update_step(steps, done, work) {
  try { await work(); steps.push(done); } catch (error) { steps.push(`${done.replace(/^已/, '')}失败：${error.message}`); }
}

/**
 * Start installing a published version. npm cannot replace the package while anything runs from it (Windows refuses with
 * EBUSY), so the owner's service and the running instances of accounts without their own Windows user (they run from the
 * package) are stopped first; then this panel hands over to panel_updater.mjs, run from the service directory, which
 * installs and starts the new panel (`finish_update`). The page follows along with GET update/progress.
 */
async function begin_update(data, version, hand_over) {
  const current = update_job(data);
  if (current && current.status !== 'done' && Date.now() - current.started_at < UPDATE_STALE_MS) throw new Error('正在更新，请稍候');
  const running = hosting_enabled(data) ? (await list_accounts(data)).filter(account => account.running) : [];
  const job = { version, status: 'stopping', steps: [], restart: running.map(account => account.name), started_at: Date.now() };
  write_update_job(data, job);
  (async () => {
    await update_step(job.steps, '已停止本机服务', () => run_owner_service(data, 'stop'));
    // The entry runs the package's code too: stopped here, the installed panel starts it again on the new version.
    if (hosting_enabled(data) && (await entry_status(data)).running) await update_step(job.steps, '已停止登录入口', () => stop_entry(data));
    for (const account of running) if (!account.os_user) await update_step(job.steps, `已停止 ${account.name} 的实例`, () => run_instance(data, account.name, 'stop'));
    const updater = join(data, 'update', 'panel_updater.mjs');
    mkdirSync(dirname(updater), { recursive: true });
    copyFileSync(join(ROOT, 'runner', 'panel_updater.mjs'), updater);
    write_update_job(data, { ...job, status: 'installing' });
    hand_over(updater);
  })().catch(error => {
    // Nothing was installed: what was stopped starts again on finish_update's path.
    write_update_job(data, { ...job, status: 'install_failed', steps: [...job.steps, `更新失败：${error.message}`] });
    finish_update(data).catch(() => {});
  });
  return { version, status: 'stopping' };
}

/**
 * Finish an update panel_updater.mjs installed (or failed to), from the panel it started, reporting each step: with the
 * new version, the owner's skills (setup without questions), the shared copy and the skills of every account with its own
 * Windows user; in any case the owner's service started again and the instances that ran before restarted.
 */
async function finish_update(data) {
  const job = update_job(data);
  if (!['installed', 'install_failed'].includes(job?.status)) return;
  const installed = job.status === 'installed', steps = [...job.steps];
  write_update_job(data, { ...job, status: 'finishing' });
  if (installed) await update_step(steps, '已更新本机技能', () => run_command(process.execPath, [installed_script('codiscuss.mjs'), 'setup', '--yes', '--no-start', '--json']).catch(error => {
    // Setup exits 2 when it finished with items to look at (an edited skill is kept, for one); that still counts.
    if (error.code !== 2) throw error;
  }));
  await update_step(steps, '已启动本机服务', () => run_owner_service(data, 'start'));
  // The panel itself starts an entry left on (run_panel); the report says once it serves again.
  if (hosting_enabled(data) && entry_settings(data).running) await update_step(steps, '已重新启动登录入口', async () => {
    for (let waited = 0; waited < ENTRY_BACK_MS; waited += 500) { if ((await entry_status(data)).running) return; await new Promise(done => setTimeout(done, 500)); }
    throw new Error('入口没有重新启动，在“概览”页“托管”下点“启动”看原因');
  });
  if (hosting_enabled(data)) {
    if (installed) await update_step(steps, '已同步隔离账号的程序副本', () => { const result = install_runtime(data); if (result.warnings.length) throw new Error(result.warnings.join('；')); });
    for (const account of await list_accounts(data)) {
      if (installed && account.os_user) await update_step(steps, `已更新 ${account.name} 的技能`, () => prepare_account(data, account.name));
      // Reported restarted only once it serves again as the account is set (start_verified). Instances run from the
      // package were stopped before the install; those running from the shared copy are stopped here.
      if ((job.restart || []).includes(account.name)) await update_step(steps, `已重启 ${account.name} 的实例`, async () => {
        if (account.os_user) await run_instance(data, account.name, 'stop');
        await start_verified(data, account.name);
      });
    }
  }
  write_update_job(data, { ...job, status: 'done', ok: installed, steps });
}

// ---- Accounts ----

/** Whether an instance answers on its port. */
/** The status of a plain GET /api/rooms: a number when answered, 'down' when the port refuses, 'unknown' otherwise. */
function plain_status(port) {
  return new Promise(done => {
    const request = http.get({ host: '127.0.0.1', port, path: '/api/rooms', timeout: PROBE_TIMEOUT_MS }, response => { response.resume(); done(response.statusCode); });
    request.on('timeout', () => { request.destroy(); done('unknown'); });
    request.on('error', error => done(error.code === 'ECONNREFUSED' ? 'down' : 'unknown'));
  });
}

/** 'up' when something answers on the port, 'down' when nothing listens there, 'unknown' when it cannot be told. */
export async function instance_state(port) {
  const status = await plain_status(port);
  return typeof status === 'number' ? 'up' : status;
}

/**
 * Whether the instance on `port` serves as its account is set: unprotected, a plain request is served; protected, a plain
 * request is refused and one on a connection where the instance proved `key` is served. Any other answer (a 403 from
 * something that is not the instance, a key that does not match) does not conform.
 */
export async function instance_conforms(port, key = '') {
  const status = await plain_status(port);
  if (!key) return status === 200;
  if (status !== 403) return false;
  try {
    const { socket, header } = await verified_connection(port, key);
    return await new Promise(done => {
      const request = http.request({ host: '127.0.0.1', port, path: '/api/rooms', headers: { 'x-codiscuss-entry': header }, createConnection: () => socket },
        response => { response.resume(); done(response.statusCode === 200); });
      request.setTimeout(PROBE_TIMEOUT_MS, () => { request.destroy(); done(false); });
      request.on('error', () => done(false));
      request.end();
    });
  } catch { return false; }
}

/** Wait until the instance conforms (see instance_conforms), or `wait_ms` passes; returns whether it did. */
/**
 * Ask `probe` until `accept` holds for its answer or `wait_ms` has passed, measured on the clock: each probe gets only
 * the time left (a probe still running at the deadline counts as not accepted), so the whole wait never runs past it.
 */
async function poll_until(probe, accept, wait_ms) {
  const deadline = Date.now() + wait_ms;
  for (;;) {
    const left = Math.max(0, deadline - Date.now());
    let timer;
    const answer = await Promise.race([probe(), new Promise(done => { timer = setTimeout(() => done(undefined), left); })]);
    clearTimeout(timer);
    if (answer !== undefined && accept(answer)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise(done => setTimeout(done, Math.min(INSTANCE_POLL_MS, Math.max(0, deadline - Date.now()))));
  }
}

async function instance_ready(port, key, { conforms = instance_conforms, wait_ms = INSTANCE_READY_MS } = {}) {
  return poll_until(() => conforms(port, key), answer => answer === true, wait_ms);
}

/** Wait until nothing listens on the instance's port any more; returns whether that happened within `wait_ms`. */
async function instance_stopped(port, { state = instance_state, wait_ms = INSTANCE_READY_MS } = {}) {
  return poll_until(() => state(port), answer => answer === 'down', wait_ms);
}

/** Start an account's instance and wait until it serves as the account is set; a start that does not get there fails. */
async function start_verified(data, name, { start = run_instance, conforms = instance_conforms, wait_ms = INSTANCE_READY_MS } = {}) {
  const account = read_accounts(data)[name];
  if (!account) throw new Error(`账号不存在：${name}`);
  await start(data, name, 'start');
  const key = account.protected === true ? instance_key(data, name) : '';
  if (account.protected === true && !key) throw new Error('这个账号开启了入口保护，但入口读不到它的密钥');
  if (!await instance_ready(account.port, key, { conforms, wait_ms })) {
    throw new Error(account.protected === true ? '实例没有按入口保护启动起来（启动失败，或密钥对不上）' : '实例没有启动起来');
  }
}

function instance_running(port) {
  return new Promise(done => {
    const request = http.get({ host: '127.0.0.1', port, path: '/api/rooms', timeout: PROBE_TIMEOUT_MS }, response => { response.resume(); done(true); });
    request.on('timeout', () => { request.destroy(); done(false); });
    request.on('error', () => done(false));
  });
}

async function list_accounts(data) {
  const users = read_os_users(data);
  return Promise.all(Object.entries(read_accounts(data)).map(async ([name, account]) => ({ name, port: account.port, home: account_home(data, name), disabled: Boolean(account.disabled), protected: account.protected === true,
    os_user: users[name]?.user || '', running: await instance_running(account.port), keys: list_keys(instance_home(data, name)).length,
    // The AI environment is set up once account_env.mjs has run for its Windows user (it records skills in the service home).
    skills: Boolean(users[name]) && existsSync(join(instance_home(data, name), SKILL_RECORD)) })));
}

function write_settings(path, value) {
  const draft = `${path}.${process.pid}.tmp`;
  writeFileSync(draft, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(draft, path);
}

/** Point the account's command-line members and its website's Python at the shared copies every Windows user can run. */
function use_shared_programs(data, name) {
  const service = instance_home(data, name), path = join(service, 'launch-settings.json');
  const settings = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  const shared = shared_executables(), participants = { ...(settings.participants || {}) };
  for (const [member, profile] of Object.entries(participants)) if (shared[profile?.adapter]) participants[member] = { ...profile, executable: shared[profile.adapter] };
  write_settings(path, { ...settings, participants });
  const local = join(service, 'local-settings.json'), python = shared_paths().python;
  if (existsSync(local) && existsSync(python)) write_settings(local, { ...JSON.parse(readFileSync(local, 'utf8')), python });
}

/** The Python the owner's own website runs, which the shared copy is made from. */
function owner_python(data) {
  try { return JSON.parse(readFileSync(join(data, 'local-settings.json'), 'utf8')).python || ''; } catch { return ''; }
}

/** Copy the shared programs, then point every account with its own Windows user at them. */
function install_runtime(data) {
  const result = install_shared_runtime(owner_python(data));
  for (const name of Object.keys(read_os_users(data))) if (read_accounts(data)[name]) use_shared_programs(data, name);
  return result;
}

/**
 * Run account_env.mjs as the account's own Windows user, from the shared copy, and return its JSON answer.
 * `folders` are folders of the owner's copied into the job folder for it (library skills).
 */
function account_env(data, name, action, request = {}, folders = {}) {
  const { env_script } = shared_paths();
  if (!existsSync(env_script)) throw new Error('还没有安装隔离账号的程序副本，请先在“托管账号”页底部安装');
  const text = run_as_user(data, name, `& ${ps_quote(process.execPath)} ${ps_quote(env_script)} ${action} $Job`,
    { files: { 'request.json': JSON.stringify(request) }, folders, timeout: 120_000 });
  const line = text.split(/\r?\n/).reverse().find(item => item.trim().startsWith('{'));
  const result = line ? JSON.parse(line) : { error: text.trim().slice(0, 300) || '没有读到结果' };
  if (result.error) throw new Error(result.error);
  return result;
}

/**
 * Set up an account's AI environment, safe to repeat: for an account with its own Windows user, the shared skills folder
 * and system prompt laid out like the owner's, the discussion skills, and the shipped workflows its instance lacks (an
 * existing prompt and workflows are kept). One without its own user uses the owner's, so only its workflows are filled in.
 */
function prepare_account(data, name) {
  const service = instance_home(data, name);
  if (!read_os_users(data)[name]) {
    const missing = shipped_workflows().map(item => item.name).filter(item => !existsSync(join(service, 'workflows', item)));
    return { skills: [], workflows: (missing.length ? install_workflows(service, missing) : []).map(({ name: item, status }) => ({ name: item, status })) };
  }
  return account_env(data, name, 'init', { home: service, prompt: hosted_prompt(data) });
}

/** The library folders of the skills to install, placed as account_env.mjs expects them in its job folder. */
function library_folders(data, install) {
  const library = library_root(data), folders = {};
  for (const skill of install) {
    if (!existsSync(join(library, String(skill), 'SKILL.md'))) throw new Error(`技能库里没有 ${skill}`);
    folders[join('skills', String(skill))] = join(library, String(skill));
  }
  return folders;
}

/** Install library skills for an account's own Windows user and remove others: { install: [name], remove: [name] }. */
function account_skills(data, name, { install = [], remove = [] } = {}) {
  return account_env(data, name, 'skills', { remove }, library_folders(data, install));
}

/**
 * Run account_env.mjs as the owner (this process's own user), whose skills folder is laid out the same way: 'status'
 * lists the owner's skills, 'skills' installs library skills and removes others. The owner's layout and prompt are not
 * touched (no 'init' or 'prompt' here).
 */
function owner_env(action, request = {}, folders = {}) {
  if (!['status', 'skills'].includes(action)) throw new Error(`未知操作：${action}`);
  const job = mkdtempSync(join(tmpdir(), 'codiscuss-env-'));
  try {
    writeFileSync(join(job, 'request.json'), JSON.stringify(request));
    for (const [target, source] of Object.entries(folders)) cpSync(source, join(job, target), { recursive: true });
    const result = spawnSync(process.execPath, [join(ROOT, 'runner', 'account_env.mjs'), action, job], { encoding: 'utf8', windowsHide: true, timeout: OWNER_ENV_TIMEOUT_MS });
    const line = String(result.stdout || '').split(/\r?\n/).reverse().find(item => item.trim().startsWith('{'));
    const parsed = line ? JSON.parse(line) : { error: String(result.stderr || '').trim().slice(0, 300) || '没有读到结果' };
    if (parsed.error) throw new Error(parsed.error);
    return parsed;
  } finally { rmSync(job, { recursive: true, force: true }); }
}

// The owner's system prompts: one file per program, often hard links to one file (the layout account_env.mjs sets up).
const OWNER_PROMPTS = [['claude', 'Claude Code', ['.claude', 'CLAUDE.md']], ['codex', 'Codex', ['.codex', 'AGENTS.md']],
  ['agy', 'Antigravity', ['.gemini', 'config', 'AGENTS.md']]];

/** A file's identity, the same for its hard links; '' when it does not exist. */
function file_id(path) {
  try { const stat = statSync(path, { bigint: true }); return `${stat.dev}:${stat.ino}`; } catch { return ''; }
}

/**
 * The owner's system prompts, grouped by file: hard links to one file form one group, edited once. Each group is
 * { key, programs: [{ key, label, path }], exists, text }; `key` is the first program's, for saving.
 */
export function owner_prompts(home = homedir()) {
  const groups = [];
  for (const [key, label, parts] of OWNER_PROMPTS) {
    const path = join(home, ...parts), id = file_id(path);
    const group = id && groups.find(item => item.id === id);
    const shown = join('~', ...parts);
    if (group) { group.programs.push({ key, label, path: shown }); continue; }
    groups.push({ id, key, programs: [{ key, label, path: shown }], exists: Boolean(id), text: id ? readFileSync(path, 'utf8') : '' });
  }
  return groups.map(({ id: _id, ...group }) => group);
}

/**
 * Save one of the owner's system prompts in place, which keeps its hard links. `original` is the text the page read: a
 * file changed since (edited elsewhere) is refused rather than overwritten.
 */
export function save_owner_prompt(key, text, original, home = homedir()) {
  const entry = OWNER_PROMPTS.find(([name]) => name === key);
  if (!entry) throw new Error(`未知程序：${key}`);
  const path = join(home, ...entry[2]);
  const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
  if (current !== String(original ?? '')) throw Object.assign(new Error('文件已在别处被修改，请重新读取后再编辑'), { status: 409 });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, String(text ?? ''));
  return owner_prompts(home);
}

/**
 * The workflows in a service home's library, and the shipped workflows it lacks:
 * { workflows: [{ id, label, description, cards, disabled?, error? }], missing: [id] }.
 */
export function account_workflows(home) {
  const workflows = existsSync(workflows_home(home)) ? list_workflows(home).map(({ directory: _directory, unavailable: _unavailable, ...item }) => item) : [];
  const installed = new Set(workflows.map(item => item.id));
  return { workflows, missing: shipped_workflows().map(item => item.name).filter(name => !installed.has(name)) };
}

function owner_skills(data, { install = [], remove = [] } = {}) {
  return owner_env('skills', { remove }, library_folders(data, install));
}

const ps_quote = text => `'${String(text).replaceAll("'", "''")}'`;

/**
 * Turn an account's entry protection on or off, restarting its instance if it runs so the change applies at once (the
 * instance reads whether it is protected when it starts; its open pages and streams end with the old process).
 *
 * On: a new key is placed in the account's protected key folder (checked before anything is written), kept as the
 * entry's copy, and the account is marked protected. Off: the mark is removed; the entry forwards as before.
 */
export async function protect_account(data, name, on, { place = place_instance_key, state = instance_state, conforms = instance_conforms,
  restart = run_instance, wait_ms = INSTANCE_READY_MS } = {}) {
  const account = read_accounts(data)[name];
  if (!account) throw new Error(`账号不存在：${name}`);
  if (on && process.platform !== 'win32' && place === place_instance_key) throw new Error('入口保护目前只支持 Windows');
  // Whether the instance runs must be known, not guessed: a port that neither answers nor refuses stops everything.
  const before = await state(account.port);
  if (before === 'unknown') throw new Error('无法确认实例是否在运行（端口没有回应），入口保护没有改动');
  // A running instance is stopped first and must be seen gone (its port refusing connections) before anything changes,
  // so the account is never marked one way while an instance of the other kind keeps serving.
  if (before === 'up') {
    await restart(data, name, 'stop');
    if (!await instance_stopped(account.port, { state, wait_ms })) throw new Error('实例没有停下来，入口保护没有改动');
  }
  if (on) {
    const key = randomBytes(32).toString('hex');
    place(data, name, key);
    set_account_protected(data, name, key);
  } else set_account_protected(data, name, '');
  if (before === 'down') return { protected: Boolean(on), running: false };
  await start_verified(data, name, { start: restart, conforms, wait_ms });
  return { protected: Boolean(on), running: true };
}

/** Start or stop an account's instance: as its Windows user from the shared copy when it has one, otherwise as the owner. */
function run_instance(data, name, command) {
  const account = read_accounts(data)[name];
  if (!account) throw new Error(`账号不存在：${name}`);
  const service = instance_home(data, name);
  // A protected instance starts knowing its key file; it then serves only callers that prove the key.
  const key_file = account.protected === true ? instance_key_file(name) : '';
  if (command === 'start' && read_os_users(data)[name]) {
    const { local_script } = shared_paths();
    if (!existsSync(local_script)) throw new Error('还没有安装隔离账号的程序副本，请先在“托管账号”页底部安装');
    // Whatever was set up first, the instance starts on the shared copies its Windows user can run.
    use_shared_programs(data, name);
    return start_instance_as_user(data, name, service, local_script, process.execPath, { key_file });
  }
  const { DISCUSS_ENTRY_KEY_FILE: _inherited, ...environment } = process.env;
  const child = spawn(process.execPath, [LOCAL_SCRIPT, command, '--json'], { stdio: 'ignore', windowsHide: true,
    env: { ...environment, DISCUSS_SERVICE_HOME: service, ...(key_file ? { DISCUSS_ENTRY_KEY_FILE: key_file } : {}) } });
  return new Promise((done, fail) => {
    child.on('error', fail);
    child.on('exit', code => code === 0 ? done() : fail(new Error(`实例${command === 'start' ? '启动' : '停止'}失败（退出码 ${code}）`)));
  });
}

// ---- API keys an account's instance holds ----

const KEY_FILE = /^[a-f0-9-]{36}\.json$/i;

/** The keys saved in an instance, newest first, with only the last characters of each key. */
/**
 * What a saved key is for when it belongs to a speech service, read from its address: the speech services keep their keys
 * in the same folder as the model API keys. Returns { label, uses: ['语音朗读' | '语音识别'], local } or null.
 */
export function key_use(base_url) {
  const root = String(base_url || '').replace(/\/+$/, '');
  const match = list => list.find(item => [item.key_base_url, item.legacy_key_base_url].some(url => url && url.replace(/\/+$/, '') === root));
  const speak = match(TTS_PROVIDERS), listen = match(STT_PROVIDERS), provider = speak || listen;
  if (!provider) return null;
  return { label: provider.local ? '本机语音服务' : provider.label, uses: [speak && '语音朗读', listen && '语音识别'].filter(Boolean), local: Boolean(provider.local) };
}

export function list_keys(service) {
  const directory = join(service, 'api-keys');
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter(name => KEY_FILE.test(name)).map(name => {
    const path = join(directory, name);
    try {
      const saved = JSON.parse(readFileSync(path, 'utf8'));
      return { ref: name.slice(0, -5), base_url: saved.base_url, managed: saved.managed === true, tail: String(saved.api_key || '').slice(-4), time: statSync(path).mtimeMs,
        speech: key_use(saved.base_url) };
    } catch { return null; }
  }).filter(Boolean).sort((left, right) => right.time - left.time);
}

function remove_key(service, ref) {
  if (!/^[a-f0-9-]{36}$/i.test(ref)) throw new Error('密钥编号无效');
  rmSync(join(service, 'api-keys', `${ref}.json`), { force: true });
}

// ---- HTTP ----

function send_json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

function read_body(request, limit = BODY_LIMIT) {
  return new Promise((done, fail) => {
    let size = 0; const chunks = [];
    request.on('data', chunk => { size += chunk.length; if (size > limit) { fail(new Error(limit > BODY_LIMIT ? '技能太大（上限 40 MB）' : '请求过大')); request.destroy(); } else chunks.push(chunk); });
    request.on('end', () => { try { done(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { fail(new Error('请求不是 JSON')); } });
    request.on('error', fail);
  });
}

function cookie(request, name) {
  return String(request.headers.cookie || '').split(';').map(part => part.trim().split('=')).find(([key]) => key === name)?.[1] || '';
}

/**
 * The panel's request handler.
 *
 * Args:
 *   data: The owner's service directory.
 *   key: The secret that starts a session; only the owner can read it.
 *   port: The port this server listens on, so only requests addressed to it as a local page are accepted.
 *   ops: Injected for tests; defaults to the real account and Windows operations.
 */
export function create_panel({ data, key, port, ops = {}, sessions = new Set() }) {
  const op = { list_accounts, add_account, reset_password, set_account_disabled, remove_account, run_instance, create_os_user, remove_os_user,
    login_status, apply_login, logout, start_login, login_progress, submit_login, cancel_login, install_runtime, prepare_account, account_env, account_skills, account_workflows, owner_env, owner_skills, owner_prompts, save_owner_prompt, shared_cli_state,
    save_api_key, list_keys, remove_key, use_shared_programs, service_overview, run_owner_service, latest_version, begin_update,
    autostart_enabled, set_autostart, entry_overview, start_entry, stop_entry, keep_tunnel, start_tunnel_setup, set_entry_mode, set_relay_url, connect_site, protect_account, start_verified, hand_over: () => {}, ...ops };
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

  async function api(method, path, body) {
    const parts = path.split('/').filter(Boolean).slice(1);
    const [section, name, action, extra] = parts;
    const account = () => { if (!read_accounts(data)[name]) throw new Error(`账号不存在：${name}`); return name; };
    const hosting = hosting_enabled(data);
    if (method === 'GET' && section === 'state') {
      const windows = process.platform === 'win32';
      return { hosting, version: VERSION, service: op.service_overview(data), platform: process.platform,
        launcher: windows && existsSync(launcher_path(data)), autostart: windows && op.autostart_enabled(), login_methods: LOGIN_METHODS, providers: API_PROVIDERS,
        ...(hosting ? { accounts: await op.list_accounts(data), clis: op.shared_cli_state(), entry: await op.entry_overview(data) }
          : { accounts: [], clis: {}, entry: null }) };
    }
    // This computer: the owner's own service, its updates and login autostart.
    if (method === 'POST' && section === 'service' && ['start', 'stop', 'restart'].includes(name)) {
      if (name !== 'start') await op.run_owner_service(data, 'stop');
      if (name !== 'stop') await op.run_owner_service(data, 'start');
      return op.service_overview(data);
    }
    if (method === 'GET' && section === 'update' && name === 'progress') return update_job(data) || { status: 'none' };
    if (method === 'GET' && section === 'update') {
      const current = op.service_overview(data).version || VERSION, version = await op.latest_version(name === 'check');
      return { current, latest: version, available: newer_version(version, current) };
    }
    if (method === 'POST' && section === 'update') return op.begin_update(data, await op.latest_version(true), op.hand_over);
    if (method === 'POST' && section === 'autostart') return { autostart: op.set_autostart(Boolean(body.on), data) };
    // Command-line sign-in: '_' is the owner; an account name is a hosted account with its own Windows user.
    if (section === 'login-jobs') {
      if (method === 'GET') return op.login_progress(name);
      if (method === 'POST' && action === 'submit') return op.submit_login(name, body.text);
      if (method === 'POST' && action === 'cancel') return op.cancel_login(name);
    }
    if (section === 'logins') {
      const target = name === '_' ? '' : name;
      if (target && (!hosting || !read_accounts(data)[target])) throw new Error(target && !hosting ? '托管管理未打开' : `账号不存在：${target}`);
      if (method === 'GET' && !action) return op.login_status(data, target);
      if (method === 'POST' && extra === 'apply') return op.apply_login(data, target, action, body);
      if (method === 'POST' && extra === 'logout') return op.logout(data, target, action);
      if (method === 'POST' && extra === 'start') return op.start_login(data, target, action, body.method);
      throw new Error('接口不存在');
    }
    // The owner as an account: its skills (from its own folder, library skills installed or removed) and API keys.
    if (section === 'owner') {
      if (method === 'GET' && name === 'env') return op.owner_env('status');
      if (method === 'POST' && name === 'env' && action === 'skills') return op.owner_skills(data, { install: body.install || [], remove: body.remove || [] });
      if (method === 'GET' && name === 'prompts') return op.owner_prompts();
      if (method === 'POST' && name === 'prompts') return op.save_owner_prompt(String(body.key || ''), body.text, body.original);
      if (method === 'GET' && name === 'workflows') return op.account_workflows(data);
      // Only the shipped workflows the owner's library lacks: an existing one, edited or not, is kept.
      if (method === 'POST' && name === 'workflows' && action === 'install') { install_workflows(data, op.account_workflows(data).missing); return op.account_workflows(data); }
      if (method === 'GET' && name === 'keys') return op.list_keys(data);
      if (method === 'POST' && name === 'keys' && action === 'remove') { op.remove_key(data, String(body.ref || '')); return { ok: true }; }
      if (method === 'POST' && name === 'keys') return op.save_api_key(data, { base_url: body.base_url, api_key: body.api_key });
      throw new Error('接口不存在');
    }
    // The skill library is the owner's, for the owner and the hosted accounts alike.
    if (section === 'skill-library') {
      if (method === 'GET') return list_library(data);
      if (method === 'POST' && !name) return import_skill(data, body);
      if (method === 'POST' && action === 'remove') { remove_library_skill(data, name); return { ok: true }; }
    }
    // Hosting: only once the owner turned it on in setup.
    if (!hosting) throw new Error('托管管理未打开：运行 codiscuss setup 勾选“托管管理（管理面板）”');
    if (method === 'POST' && section === 'clis' && name === 'install') return op.install_runtime(data);
    // The account entry customers sign in at: started and stopped here, and started again with the panel if it was left on.
    if (method === 'POST' && section === 'entry' && (name === 'start' || name === 'stop')) {
      await (name === 'start' ? op.start_entry(data) : op.stop_entry(data));
      save_entry_settings(data, { running: name === 'start' });
      // Its tunnel goes with it.
      await op.keep_tunnel(data);
      return op.entry_overview(data);
    }
    // How people outside reach the entry, the relay's entry address, and binding this computer to an online site.
    if (method === 'POST' && section === 'entry' && name === 'mode') return op.set_entry_mode(data, String(body.mode || ''));
    if (method === 'POST' && section === 'entry' && name === 'relay') return op.set_relay_url(data, body.url);
    if (method === 'POST' && section === 'site' && name === 'connect') return op.connect_site(data, body.site, body.setup_key);
    // The outside address: a Cloudflare tunnel set up by a job of its own (it waits for the owner in the browser).
    if (section === 'tunnel' && name === 'setup') {
      if (method === 'GET') return tunnel_setup_state(data);
      if (method === 'POST') return op.start_tunnel_setup(data, body.host, body.name);
    }
    if (method === 'POST' && section === 'entry' && name === 'settings') { save_entry_settings(data, { public_url: body.public_url }); return op.entry_overview(data); }
    // The default system prompt of new hosted accounts.
    if (section === 'hosted-prompt') {
      if (method === 'GET') return { text: hosted_prompt(data) };
      if (method === 'POST') { save_hosted_prompt(data, body.text); return { ok: true }; }
    }
    if (section !== 'accounts') throw new Error('接口不存在');
    if (method === 'POST' && !name) return op.add_account(data, String(body.name || '').trim());
    account();
    if (method === 'POST' && action === 'password') return { password: op.reset_password(data, name) };
    if (method === 'POST' && action === 'protect') return op.protect_account(data, name, body.on !== false);
    if (method === 'POST' && (action === 'disable' || action === 'enable')) { op.set_account_disabled(data, name, action === 'disable'); return { disabled: action === 'disable' }; }
    if (method === 'POST' && action === 'remove') { op.remove_account(data, name); return { removed: name, kept: account_home(data, name) }; }
    // A start is reported only once the instance serves as the account is set (protected or not).
    if (method === 'POST' && action === 'start') { await op.start_verified(data, name); return { ok: true }; }
    if (method === 'POST' && action === 'stop') { await op.run_instance(data, name, action); return { ok: true }; }
    if (method === 'POST' && action === 'os-user' && extra === 'remove') { op.remove_os_user(data, name); return { ok: true }; }
    if (method === 'POST' && action === 'os-user') {
      const result = op.create_os_user(data, name, account_home(data, name));
      op.use_shared_programs(data, name);
      return result;
    }
    // Its AI environment: set up (safe to repeat), what is installed, chosen library skills, its system prompt.
    if (method === 'POST' && action === 'env' && extra === 'init') return op.prepare_account(data, name);
    if (method === 'GET' && action === 'env') return op.account_env(data, name, 'status');
    if (method === 'POST' && action === 'env' && extra === 'skills') return op.account_skills(data, name, { install: body.install || [], remove: body.remove || [] });
    if (method === 'POST' && action === 'env' && extra === 'prompt') return op.account_env(data, name, 'prompt', { prompt: String(body.text ?? '') });
    const service = instance_home(data, name);
    if (method === 'GET' && action === 'workflows') return op.account_workflows(service);
    // Set up again (safe to repeat): it installs the shipped workflows the account lacks and keeps the rest.
    if (method === 'POST' && action === 'workflows' && extra === 'install') { await op.prepare_account(data, name); return op.account_workflows(service); }
    if (method === 'GET' && action === 'keys') return op.list_keys(service);
    if (method === 'POST' && action === 'keys' && extra === 'remove') { op.remove_key(service, String(body.ref || '')); return { ok: true }; }
    if (method === 'POST' && action === 'keys') return op.save_api_key(service, { base_url: body.base_url, api_key: body.api_key, managed: true });
    throw new Error('接口不存在');
  }

  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      // Only a page this browser opened from this address; anything else (another site, a renamed host) is refused.
      if (!hosts.has(String(request.headers.host || ''))) return send_json(response, 403, { error: '只接受本机访问' });
      if (url.pathname === '/enter') {
        if (url.searchParams.get('key') !== key) return send_json(response, 403, { error: '钥匙无效，请从任务栏图标打开管理面板' });
        const session = randomBytes(24).toString('hex');
        sessions.add(session);
        const page = /^[a-z]+$/.test(url.searchParams.get('page') || '') ? `#${url.searchParams.get('page')}` : '';
        response.writeHead(302, { Location: `/${page}`, 'Set-Cookie': `${SESSION_COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/` });
        return response.end();
      }
      const signed_in = sessions.has(cookie(request, SESSION_COOKIE));
      if (url.pathname.startsWith('/api/')) {
        if (!signed_in) return send_json(response, 401, { error: '请从任务栏图标重新打开管理面板' });
        const origin = request.headers.origin;
        if (request.method !== 'GET' && (!origin || !hosts.has(origin.replace(/^http:\/\//, '')) || request.headers['x-codiscuss-panel'] !== '1')) {
          return send_json(response, 403, { error: '拒绝跨站请求' });
        }
        // A dropped skill arrives whole (its files in base64), so that one request may be large.
        const body = request.method === 'POST' ? await read_body(request, url.pathname === '/api/skill-library' ? UPLOAD_LIMIT : BODY_LIMIT) : {};
        return send_json(response, 200, await api(request.method, url.pathname, body));
      }
      const name = STATIC_FILES[url.pathname] || (url.pathname.startsWith('/icons/') && /^\/icons\/[\w.-]+$/.test(url.pathname) ? url.pathname.slice(1) : '');
      if (!name) return send_json(response, 404, { error: '页面不存在' });
      if (name === 'admin.html' && !signed_in) {
        response.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
        return response.end('<!doctype html><meta charset="utf-8"><title>共议管理面板</title><p style="font:15px system-ui;padding:40px">请从任务栏的共议图标打开管理面板。</p>');
      }
      const file = join(WEB, name);
      if (!existsSync(file)) return send_json(response, 404, { error: '页面尚未构建，请运行 npm run build' });
      response.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      response.end(readFileSync(file));
    } catch (error) {
      if (response.headersSent) response.destroy();
      else send_json(response, error.status || 400, { error: error.message });
    }
  });
}

/** The account entry as the hosting page shows it: whether it runs, its loopback port and the address customers open. */
/** Keep the entry's tunnel as the settings say: running while hosting is on and the entry is meant to run. */
function keep_tunnel(data) {
  const { tunnel, port, running, mode } = entry_settings(data);
  return ensure_tunnel(data, hosting_enabled(data) && mode === 'tunnel' ? tunnel : null, port, running);
}

/** The online site this computer is bound to (`codiscuss local connect`) and its id there, or null. */
function bound_site(data) {
  const [site, link] = Object.entries(machine_links(data).sites || {}).find(([, item]) => item?.id && item?.private_key) || [];
  return site ? { site, machine: link.id } : null;
}

/** Ask the relay's entry Worker whether it is one and whether this computer is connected to it. */
async function relay_status(relay_url, machine) {
  try {
    const answer = await fetch(`${relay_url}/_codiscuss/status?machine=${machine || '0'.repeat(32)}`, { signal: AbortSignal.timeout(RELAY_CHECK_MS) });
    const result = await answer.json();
    return result.service === 'codiscuss-entry' ? { reachable: true, online: Boolean(result.online) } : { reachable: false, online: false };
  } catch { return { reachable: false, online: false }; }
}

async function entry_overview(data) {
  const { port, public_url, tunnel, mode, relay_url } = entry_settings(data), status = await entry_status(data);
  const bound = bound_site(data);
  const relay = { url: relay_url, site: bound?.site || '', link: relay_url && bound ? `${relay_url}/?m=${bound.machine}` : '',
    ...(mode === 'relay' && relay_url && bound ? await relay_status(relay_url, bound.machine) : {}) };
  // The address people open in the mode in use.
  const address = mode === 'relay' ? relay.link : mode === 'tunnel' ? public_url : '';
  return { running: status.running, port: status.running ? status.port : port, public_url, mode, address, relay,
    tunnel: tunnel ? { host: tunnel.host, name: tunnel.name, ...(await tunnel_status(data)) } : null };
}

/** Switch how people outside reach the entry, once what that way needs is there; the tunnel follows at once. */
async function set_entry_mode(data, mode) {
  const settings = entry_settings(data);
  if (mode === 'relay') {
    if (!bound_site(data)) throw new Error('这台电脑还没有绑定线上站点：先在下面绑定');
    if (!settings.relay_url) throw new Error('还没有填写入口地址（入口 Worker 的 workers.dev 地址）');
  }
  if (mode === 'tunnel' && !settings.tunnel) throw new Error('还没有设好 Cloudflare 隧道：先点“设置”填写你的域名');
  save_entry_settings(data, { mode });
  await keep_tunnel(data);
  return entry_overview(data);
}

/** Save the relay's entry address after checking that it answers as one. */
async function set_relay_url(data, url) {
  const origin = String(url || '').trim().replace(/\/+$/, '');
  const checked = await relay_status(origin, bound_site(data)?.machine);
  if (!checked.reachable) throw new Error(`${origin} 不是共议的入口 Worker，或现在连不上`);
  save_entry_settings(data, { relay_url: origin });
  return entry_overview(data);
}

/** Bind this computer to an online site with a one-time token, as `codiscuss local connect` does. */
function connect_site(data, site, setup_key) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [installed_script('discussion_local.mjs'), 'connect', String(site || '').trim(), '--setup-key', String(setup_key || '').trim(), '--no-open', '--json'],
      { cwd: data, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DISCUSS_SERVICE_HOME: data } });
    let output = '', errors = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { errors += chunk; });
    child.on('error', fail);
    child.on('exit', code => (code === 0 ? done(bound_site(data)) : fail(new Error(errors.trim().split(/\r?\n/).pop() || `绑定失败（退出码 ${code}）`))));
  });
}

// ---- Hosted accounts' failures, to the owner's Weixin ----

/** Whether two paths name the same place, as written (Windows paths compare without regard to case). */
function same_path(a, b) {
  const left = resolve(a), right = resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

const NEWLINE = 0x0a;
const EVENT_ID = /^[A-Za-z0-9-]{8,64}$/;

/** Read bytes [start, end) of a file; fewer when it shrank meanwhile. */
function read_bytes(path, start, end) {
  const buffer = Buffer.alloc(Math.max(0, end - start)), handle = openSync(path, 'r');
  try { return buffer.subarray(0, readSync(handle, buffer, 0, buffer.length, start)); } finally { closeSync(handle); }
}

/** A recorded failure as the relay uses it, or null for a line that is not one (the outbox is the account's to write). */
function failure_event(line) {
  let value = null;
  try { value = JSON.parse(line); } catch { return null; }
  if (!value || typeof value !== 'object' || value.kind !== 'failed' || typeof value.id !== 'string' || !EVENT_ID.test(value.id)) return null;
  const text = field => typeof value[field] === 'string' ? value[field].replace(/\s+/g, ' ').trim().slice(0, RELAY_TEXT_LIMIT) : '';
  return { id: value.id, title: text('title') || text('room'), member: text('member'), reason: text('reason') };
}

/**
 * The failures one account's outbox gained since `mark` ({ offset, head }), and the mark after them.
 *
 * The outbox is identified by its first record's id: a file replaced, emptied or rewritten (even to the same length)
 * has another first record and is read from the start. Lines are cut on the raw bytes, so a character split at the
 * read limit never shifts the offset; a flood is cut to its tail, and the partial line where the cut falls is skipped.
 */
function outbox_failures(path, mark) {
  const size = statSync(path).size;
  const first = read_bytes(path, 0, Math.min(size, RELAY_READ_LIMIT));
  const first_end = first.indexOf(NEWLINE);
  const head = first_end < 0 ? '' : failure_event(first.subarray(0, first_end).toString('utf8'))?.id || '';
  let start = mark.head === head && Number.isInteger(mark.offset) && mark.offset <= size ? mark.offset : 0;
  let partial = false;
  if (size - start > RELAY_READ_LIMIT) { start = size - RELAY_READ_LIMIT; partial = true; }
  const bytes = read_bytes(path, start, size);
  const end = bytes.lastIndexOf(NEWLINE) + 1;
  let begin = 0;
  if (partial) begin = bytes.indexOf(NEWLINE) + 1;
  const lines = end > begin ? bytes.subarray(begin, end).toString('utf8').split('\n').filter(Boolean) : [];
  return { events: lines.map(failure_event).filter(Boolean), mark: { offset: start + end, head } };
}

/**
 * Send one Weixin notice per hosted account whose instance recorded failures since the last pass, and remember how far
 * each outbox was read. Nothing is read while hosting is off or the owner's Weixin cannot be reached, so failures wait.
 * One account's unreadable outbox is skipped without holding up the others.
 *
 * Args:
 *   data: The owner's service directory.
 *   send, ready: The Weixin sender and readiness check, replaceable in tests.
 *
 * Returns:
 *   The accounts a notice was sent for.
 */
export async function relay_operator_events(data, send = send_notice, ready = can_notify) {
  if (!hosting_enabled(data) || !ready(data)) return [];
  const state_file = join(data, RELAY_STATE_FILE);
  let marks = {};
  try { marks = JSON.parse(readFileSync(state_file, 'utf8')) || {}; } catch { marks = {}; }
  const notified = [];
  for (const name of Object.keys(read_accounts(data))) {
    const path = join(instance_home(data, name), OPERATOR_EVENTS_FILE);
    let read = null;
    // The outbox is in the account's own folder: a link anywhere on its path (the file, or a folder above it that the
    // account replaced with a junction) is not followed, so only a file really inside that folder is read.
    try { read = existsSync(path) && same_path(realpathSync.native(path), path) ? outbox_failures(path, marks[name] || {}) : null; }
    catch (error) { process.stderr.write(`托管账号 ${name} 的失败记录读不了：${error.message}\n`); continue; }
    if (!read || (read.mark.offset === marks[name]?.offset && read.mark.head === marks[name]?.head)) continue;
    const { events, mark } = read;
    if (events.length) {
      const listed = events.slice(-RELAY_LISTED).map(event => `「${event.title}」${event.member}：${event.reason}`);
      let result = null;
      try {
        // Keyed by the last failure it reports, so a later notice is never mistaken for an earlier one.
        result = await send(data, { key: `operator-${name}-${events.at(-1).id}`, room: { title: `托管账号 ${name}` },
          paragraphs: [`${events.length} 次执行失败${events.length > RELAY_LISTED ? `，最近 ${RELAY_LISTED} 次` : ''}：`, ...listed,
            '客户那边看到的是失败卡片和重试按钮；登录失效、额度用完这类问题要你在管理面板处理。'] });
      } catch { result = null; }
      // Not sent (no reply context yet, or a network error): read again next time.
      if (!['sent', 'duplicate'].includes(result?.status)) continue;
      notified.push(name);
    }
    marks[name] = mark;
  }
  write_settings(state_file, marks);
  return notified;
}

// ---- Process ----

function state_path(data) {
  return join(data, STATE_FILE);
}

function read_state(data) {
  try { return JSON.parse(readFileSync(state_path(data), 'utf8')); } catch { return null; }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Open a page in this computer's default browser. */
function open_browser(url) {
  spawn('rundll32', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

// The panel page's <title>; its own window carries it, which is how an open window is found again.
const WINDOW_TITLE = '共议 · 管理面板';
const WINDOW_SIZE = '1180,860';
const EDGE_PATHS = [join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe')];

/**
 * Show the panel in a window of its own: Edge, which every Windows 10/11 has, in app mode (no address bar or tabs, its
 * own taskbar entry), with a profile kept in the owner's service directory. A window already open is brought forward
 * instead of opening another; without Edge the default browser opens the page. `look_first` is false when the taskbar
 * icon asks: it has just looked for the window itself, and looking again here delays the new window by a second.
 */
function open_panel_window(data, url, look_first = true) {
  if (!look_first) return launch_panel_window(data, url);
  // The title goes in a script file with a byte-order mark: on a command line Windows would pass it in the ANSI code page,
  // the Chinese title would no longer match, and every call would open another window.
  const script = join(tmpdir(), `codiscuss-focus-${process.pid}.ps1`);
  writeFileSync(script, `﻿if ((New-Object -ComObject WScript.Shell).AppActivate('${WINDOW_TITLE}')) { 'focused' }`, 'utf8');
  const focused = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  rmSync(script, { force: true });
  if (focused.stdout?.trim() === 'focused') return;
  launch_panel_window(data, url);
}

function launch_panel_window(data, url) {
  const edge = EDGE_PATHS.find(path => existsSync(path));
  if (!edge) return open_browser(url);
  const profile = join(data, 'panel-window');
  // Edge keeps the size and place the owner left the window at (app_window_placement), but --window-size overrides it,
  // so the default size is given only until Edge has kept one.
  let placed = false;
  try { placed = readFileSync(join(profile, 'Default', 'Preferences'), 'utf8').includes('"app_window_placement"'); } catch { placed = false; }
  spawn(edge, [`--app=${url}`, `--user-data-dir=${profile}`, ...(placed ? [] : [`--window-size=${WINDOW_SIZE}`]), '--no-first-run', '--no-default-browser-check', '--lang=zh-CN', '--disable-features=Translate,msTranslate'],
    { detached: true, stdio: 'ignore', windowsHide: false }).unref();
}

function panel_url(state) {
  return `http://127.0.0.1:${state.port}/enter?key=${state.key}`;
}

/** The owner's own site, for the icon's second entry. */
function site_url(data) {
  try { return `http://127.0.0.1:${JSON.parse(readFileSync(join(data, 'local-settings.json'), 'utf8')).port || 8765}/`; }
  catch { return 'http://127.0.0.1:8765/'; }
}

/** A runner script of the installed codiscuss package (npm puts its command beside node_modules), or this tree's copy. */
function installed_script(name) {
  const command_file = spawnSync('where.exe', ['codiscuss.cmd'], { encoding: 'utf8', windowsHide: true }).stdout?.split(/\r?\n/).find(Boolean);
  const installed = command_file && join(dirname(command_file), 'node_modules', NPM_PACKAGE, 'runner', name);
  return installed && existsSync(installed) ? installed : join(ROOT, 'runner', name);
}

/**
 * Start or stop the owner's own local service (website and discussion service), the way `codiscuss local` does.
 *
 * The installed package's script is preferred, so a restart keeps the version the owner installed. Hosted accounts'
 * instances are separate processes and are left alone.
 */
function run_owner_service(data, command) {
  const child = spawn(process.execPath, [installed_script('discussion_local.mjs'), command], { stdio: 'ignore', windowsHide: true, env: { ...process.env, DISCUSS_SERVICE_HOME: data } });
  return new Promise((done, fail) => {
    child.on('error', fail);
    child.on('exit', code => code === 0 ? done() : fail(new Error(`codiscuss local ${command} 失败（退出码 ${code}）`)));
  });
}

/** Whether the owner turned on hosting (setup's "托管管理"); only then does the panel show the hosting pages. */
export function hosting_enabled(data) {
  try { return JSON.parse(readFileSync(join(data, 'local-settings.json'), 'utf8')).hosting === true; } catch { return false; }
}

/** Run the server and the icon until the icon's "close service" entry or `panel stop`. */
function run_panel(data, port) {
  const running = read_state(data);
  if (running && running.pid !== process.pid && alive(running.pid)) throw new Error(`管理面板已在运行：http://127.0.0.1:${running.port}`);
  // Out of the package folder (the 共议 launcher starts here from it), with everything this starts, the panel window
  // included: Windows will not let npm replace a folder that is any process's working directory.
  process.chdir(data);
  // A panel started by an update takes over its predecessor's key and sessions, so the open window keeps working.
  let handover = {};
  try { handover = JSON.parse(process.env[HANDOVER_VARIABLE] || '{}'); } catch { handover = {}; }
  delete process.env[HANDOVER_VARIABLE];
  const state = { pid: process.pid, port, key: handover.key || randomBytes(24).toString('hex'), version: VERSION };
  const sessions = new Set(Array.isArray(handover.sessions) ? handover.sessions : []);
  // For an update this process steps aside: the updater, run from outside the package, installs once it has exited and
  // starts the installed panel, which takes over the key and sessions.
  const hand_over = updater => {
    shutdown(false);
    spawn(process.execPath, [updater, '--data', data, '--pid', String(process.pid), '--panel', installed_script('admin_panel.mjs'), '--port', String(port)],
      { cwd: dirname(updater), detached: true, stdio: 'ignore', windowsHide: true,
        env: { ...process.env, [HANDOVER_VARIABLE]: JSON.stringify({ key: state.key, sessions: [...sessions] }) } }).unref();
    setTimeout(() => process.exit(0), 300);
  };
  const server = create_panel({ data, key: state.key, port, ops: { hand_over }, sessions });
  // An entry left on starts again with the panel (only the entry: the accounts' instances are separate).
  if (hosting_enabled(data) && entry_settings(data).running) start_entry(data).catch(error => process.stderr.write(`入口没有启动：${error.message}\n`));
  // The entry's outside address runs on its own; the panel keeps it as set now and every minute (restarted if it stopped
  // or its settings changed, stopped when the entry is off).
  const keep = () => keep_tunnel(data).catch(error => process.stderr.write(`隧道：${error.message}\n`));
  keep();
  const keeper = setInterval(keep, TUNNEL_CHECK_MS);
  // Hosted accounts' failures reach the owner's Weixin; one pass at a time.
  let relaying = false;
  const relay = setInterval(() => {
    if (relaying) return;
    relaying = true;
    relay_operator_events(data).catch(error => process.stderr.write(`失败通知未转发：${error.message}\n`)).finally(() => { relaying = false; });
  }, RELAY_MS);
  server.listen(port, '127.0.0.1', () => {
    writeFileSync(state_path(data), JSON.stringify(state), { mode: 0o600 });
    process.stdout.write(`管理面板已启动：http://127.0.0.1:${port}\n`);
    finish_update(data).catch(error => process.stderr.write(`更新收尾失败：${error.message}\n`));
  });
  // The icon that ships with the package, the same on every computer.
  const icon = join(ROOT, 'web', 'codiscuss.ico');
  const tray = show_tray({ title: '共议', icon_path: existsSync(icon) ? icon : '', window_title: WINDOW_TITLE,
    host: join(data, 'launcher', '共议.exe'), on_action: action => {
    if (action === 'open') open_panel_window(data, panel_url(state), false);
    if (action === 'site') open_browser(site_url(data));
    // Restarting and closing take seconds and show nothing of their own, so the icon says what is happening.
    if (action === 'restart') {
      tray.notify('busy', '正在重启共议服务…');
      run_owner_service(data, 'stop').then(() => run_owner_service(data, 'start'))
        .then(() => tray.notify('done', '共议服务已重启'), error => tray.notify('error', `重启失败：${error.message}。可在命令行运行 codiscuss local open`));
    }
    if (action === 'stop') {
      tray.notify('busy', '正在关闭共议服务…');
      run_owner_service(data, 'stop')
        .then(() => tray.notify('done', '共议服务已关闭'), error => tray.notify('error', `关闭失败：${error.message}`))
        // The note goes with the icon, so it stays a moment before the icon closes.
        .finally(() => setTimeout(shutdown, 2500));
    }
  } });
  function shutdown(exit = true) {
    clearInterval(relay);
    // The tunnel runs on without the panel, like the entry.
    clearInterval(keeper);
    tray?.close();
    server.close();
    if (read_state(data)?.pid === process.pid) rmSync(state_path(data), { force: true });
    if (exit) setTimeout(() => process.exit(0), 300);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return server;
}

/** Start the panel in the background unless it already runs; returns its state. */
async function start_panel(data, port) {
  const running = read_state(data);
  if (running && alive(running.pid) && running.version === VERSION) return running;
  // A panel of another version (left running across an update) is replaced, so the icon and panel match what is installed.
  if (running && alive(running.pid)) {
    process.kill(running.pid);
    rmSync(state_path(data), { force: true });
    await new Promise(done => setTimeout(done, 800));
  }
  const log = join(data, 'admin-panel.log');
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'run', '--port', String(port)],
    { detached: true, stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true, env: { ...process.env, CODISCUSS_GATEWAY_HOME: data } });
  child.unref();
  for (let waited = 0; waited < 10_000; waited += 200) {
    await new Promise(done => setTimeout(done, 200));
    const state = read_state(data);
    if (state?.pid === child.pid) return state;
  }
  throw new Error(`管理面板没有启动，可运行 codiscuss panel run 查看原因（日志 ${log}）`);
}

export async function panel_main(args) {
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: { port: { type: 'string' }, data: { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
  const command = positionals[0] || 'open';
  if (values.help) return process.stdout.write(HELP);
  const data = data_home(values.data), port = Number(values.port || DEFAULT_PORT);
  if (command === 'run') return run_panel(data, port);
  if (command === 'start') { const state = await start_panel(data, port); return process.stdout.write(`管理面板：http://127.0.0.1:${state.port}\n`); }
  if (command === 'open') {
    const state = await start_panel(data, port);
    // An icon from 0.4.28 or 0.4.29 may run without a panel; it is replaced by one that has it.
    if (!state.port) throw new Error('正在运行的任务栏图标来自旧版本：运行 codiscuss panel stop 后再运行 codiscuss panel open');
    open_panel_window(data, panel_url(state));
    return;
  }
  if (command === 'stop') {
    const state = read_state(data);
    if (state && alive(state.pid)) process.kill(state.pid);
    rmSync(state_path(data), { force: true });
    return process.stdout.write('管理面板已停止\n');
  }
  throw new Error(HELP);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  panel_main(process.argv.slice(2)).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}

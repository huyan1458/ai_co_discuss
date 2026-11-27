#!/usr/bin/env node
/**
 * The computer owner's management panel: hosted accounts, their Windows users, AI command-line sign-ins and API keys.
 *
 * A small HTTP server on 127.0.0.1 serves web/admin.html and a JSON API, and a taskbar icon opens it. Loopback is shared
 * by every user and program on this computer, including the AI programs of hosted accounts, so the API also requires a
 * session that only the owner can start: the icon (or `codiscuss panel open`) opens the page with a key kept in the
 * owner's private service directory.
 */
import { attachment_limit, checked_quota, clear_object_storage, object_quota_path, object_storage_status, policy_path, save_attachment_limit, save_object_quota, save_object_storage, test_object_storage } from './attachment_policy.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, realpathSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { panel_clean, panel_clear_attachments, panel_room_attachments, panel_storage, panel_repair } from './admin_maintenance.mjs';
import { homedir, tmpdir } from 'node:os';
import tls from 'node:tls';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { account_home, add_account, data_home, entry_settings, entry_status, instance_home as plain_instance_home, read_accounts, remove_account, reset_password, save_entry_settings,
  instance_key, set_account_disabled, set_account_protected, set_instance_wanted, start_entry, stop_entry, ENTRY_WAYS } from '../gateway/gateway.mjs';
import { owner_key_file, signed_site_url, site_fetch, verified_connection } from './entry_client.mjs';
import { API_PROVIDERS, save_api_key } from './discussion_api.mjs';
import { STT_PROVIDERS, TTS_PROVIDERS } from './tts_providers.mjs';
import { ensure_tunnel, stop_tunnel, start_tunnel_setup, tunnel_setup_state, tunnel_status } from './hosting_tunnel.mjs';
import { pairing_origins, update_pairing_origins, RELAY_REGIONS } from './device_auth.mjs';
import { machine_links, save_machine_links } from './remote_launch.mjs';
import { read_relay_health, request_relay_reconnect } from './relay_health.mjs';
import { instance_recovery } from './instance_recovery.mjs';
import { mark_backup_release, reserve_project_root, set_project_migration } from '../gateway/gateway.mjs';
import { backup_operation, migration_folders, move_project_files } from './project_migration.mjs';
import { require_idle_os_user } from './os_users.mjs';
import { DIRECT_ACCOUNTS_FILE } from '../gateway/direct.mjs';
import { apply_login, cancel_login, LOGIN_METHODS, login_progress, login_status, logout, start_login, submit_login } from './cli_login.mjs';
import { clear_instance_flag, create_os_user, install_shared_runtime, restrict_other_drives, instance_flag_set, instance_key_file, place_instance_key, read_os_users, remove_os_user, run_as_user, shared_cli_state, shared_executables, shared_paths,
  start_instance_as_user } from './os_users.mjs';
import { install_workflows, outdated_workflows, shipped_workflows } from './discussion_skills.mjs';
import { list_workflows, workflows_home } from './workflows.mjs';
import { launch_settings, save_managed_prompt } from './discussion_launch.mjs';
import { hosted_prompt, import_skill, library_root, list_library, remove_library_skill, save_hosted_prompt } from './skill_library.mjs';
import { local_status, save_site_connection } from './discussion_local.mjs';
import { autostart_enabled, launcher_path, set_autostart } from './launcher.mjs';
import { show_tray } from './tray.mjs';
import { OPERATOR_EVENTS_FILE } from './account_space.mjs';
import { can_notify, send_notice } from './channels.mjs';
import { resolve_locale, t } from './i18n.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WEB = join(ROOT, 'web');
const LOCAL_SCRIPT = join(ROOT, 'runner', 'discussion_local.mjs');
const DEFAULT_PORT = 8790;
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const NPM_PACKAGE = 'ai_co_discuss';
const LATEST_URL = `https://registry.npmjs.org/${NPM_PACKAGE}/latest`;
const LATEST_TTL_MS = 60 * 60 * 1000;
const OUTSIDE_TIMEOUT_MS = 8000, OUTSIDE_ATTEMPTS = 2;
// Node 24 (OpenSSL 3.5) offers a post-quantum key share first, which makes its TLS greeting span several packets; behind
// a Clash (Mihomo) TUN such connections were reset more than half the time, while curl and browsers got through (seen
// 2026-11-14). What the panel fetches outside is public (the latest version, a site's entry address, the relay's state),
// so it offers the classic key shares only.
tls.DEFAULT_ECDH_CURVE = 'X25519:prime256v1:secp384r1';
const STATE_FILE = 'admin-panel.json';
// An update's progress and report, kept in the service directory (panel_updater.mjs writes it too), and how long an
// unfinished one blocks another.
const UPDATE_JOB_FILE = 'panel-update.json';
const UPDATE_STALE_MS = 10 * 60 * 1000;
// How often a running panel looks for an install to finish: one started during the install never gets the updater's start.
const UPDATE_FINISH_CHECK_MS = 3000;
const OWNER_ENV_TIMEOUT_MS = 120_000;
const STORAGE_STEWARD_TIMEOUT_MS = 60_000;
// How often the panel makes sure the entry's tunnel runs as set, and how long an update waits for the entry to be back.
const TUNNEL_CONNECT_MS = 30_000;
const TUNNEL_POLL_MS = 500;
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
const STATIC_FILES = { '/': 'admin.html', '/admin.html': 'admin.html', '/admin.js': 'admin.js', '/admin.css': 'admin.css', '/i18n.js': 'i18n.js', '/mark.svg': 'mark.svg' };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png' };
const HELP = t(`用法：codiscuss panel [run|start|open|stop] [--port {value1}]

  run    在前台运行管理面板与任务栏图标
  start  在后台启动（已在运行则不重复启动）
  open   打开管理面板（未运行时先启动）
  stop   停止管理面板与任务栏图标
`, { value1: DEFAULT_PORT });

// ---- This computer's service ----

/** The owner's own service as the overview shows it: whether it runs, where, and which version. */
function service_overview(data) {
  const status = local_status(data);
  return { running: Boolean(status.running), website: Boolean(status.website_running), url: status.url || '', version: status.version || '',
    home: data, pid: status.service_pid, error: status.service_error || '' };
}

let latest = { at: 0, version: '' };

/**
 * Fetch an outside address, trying once more when it fails: now and then a request to Cloudflare stalls for many seconds
 * while the next one answers in under two (seen 2026-11-14). Failing is reported naming the host, not as a problem of
 * the site.
 */
async function fetch_outside(url, timeout_ms, init = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(timeout_ms) });
    } catch (error) {
      const timed_out = error.name === 'TimeoutError';
      if (attempt < OUTSIDE_ATTEMPTS) continue;
      if (timed_out) throw panel_error('连不上 {host}：{seconds} 秒内没有响应，请检查这台电脑的网络或代理后重试', { host: new URL(url).host, seconds: timeout_ms / 1000 });
      throw panel_error('连不上 {host}：连接被断开（{reason}），请检查这台电脑的网络或代理后重试', { host: new URL(url).host, reason: error.cause?.code || error.message });
    }
  }
}

/** The newest published version, asked of the npm registry at most once an hour (nothing about this computer is sent). */
async function latest_version(force = false) {
  if (!force && latest.version && Date.now() - latest.at < LATEST_TTL_MS) return latest.version;
  const response = await fetch_outside(LATEST_URL, OUTSIDE_TIMEOUT_MS);
  if (!response.ok) throw panel_error('查询新版本失败（HTTP {value1}）', { value1: response.status });
  latest = { at: Date.now(), version: String((await response.json()).version || '') };
  return latest.version;
}

/** Refuse an update npm cannot deliver yet, before anything is stopped: a new version is listed minutes before its package downloads. */
async function check_package(version) {
  const response = await fetch_outside(`https://registry.npmjs.org/${NPM_PACKAGE}/-/${NPM_PACKAGE}-${version}.tgz`, OUTSIDE_TIMEOUT_MS, { method: 'HEAD' });
  if (response.status === 404) throw panel_error('v{value1} 刚发布，npm 还在准备安装包，请过几分钟再更新；当前版本和服务没有受影响', { value1: version });
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
    child.on('exit', code => code === 0 ? done() : fail(Object.assign(panel_error('{value1} {value2} 失败（退出码 {value3}）：{value4}', { value1: command, value2: args.join(' '), value3: code, value4: output.trim().split(/\r?\n/).slice(-3).join(' ') }), { code })));
  });
}

function update_job(data) {
  try {
    const job = JSON.parse(readFileSync(join(data, UPDATE_JOB_FILE), 'utf8'));
    job.steps = (job.steps || []).map(step => {
      if (typeof step !== 'string') return step;
      // Older jobs and the standalone updater write strings; normalize at this read boundary only.
      const failed = /失败/.test(step);
      const text = step.startsWith('安装失败：') ? t('安装失败：{reason}', { reason: step.slice(5) })
        : step.startsWith('已安装 v') ? t('已安装 v{version}', { version: step.slice(5) }) : step;
      return { text, failed };
    });
    return job;
  } catch { return null; }
}

function write_update_job(data, job) {
  writeFileSync(join(data, UPDATE_JOB_FILE), JSON.stringify(job), { mode: 0o600 });
}

/**
 * Record an update step with an explicit result; later steps still run after failure.
 * @param {object[]} steps Destination update log.
 * @param {string} done Description of the completed operation.
 * @param {Function} work Operation to await.
 * @returns {Promise<void>}
 */
export async function update_step(steps, done, work) {
  try { await work(); steps.push({ text: done, failed: false }); }
  catch (error) { steps.push({ text: t('{step}失败：{reason}', { step: done.replace(/^已/, ''), reason: error.message }), failed: true }); }
}

/**
 * Start installing a published version. npm cannot replace the package while anything runs from it (Windows refuses with
 * EBUSY), so the owner's service and the running instances of accounts without their own Windows user (they run from the
 * package) are stopped first; then this panel hands over to panel_updater.mjs, run from the service directory, which
 * installs and starts the new panel (`finish_update`). The page follows along with GET update/progress.
 */
async function begin_update(data, version, hand_over) {
  const current = update_job(data);
  if (current && current.status !== 'done' && Date.now() - current.started_at < UPDATE_STALE_MS) throw panel_error('正在更新，请稍候');
  const running = hosting_enabled(data) ? (await list_accounts(data)).filter(account => account.running) : [];
  const job = { version, status: 'stopping', steps: [], restart: running.map(account => account.name), started_at: Date.now() };
  write_update_job(data, job);
  (async () => {
    await update_step(job.steps, t('已停止本机服务'), () => run_owner_service(data, 'stop'));
    // The entry runs the package's code too: stopped here, the installed panel starts it again on the new version.
    if (hosting_enabled(data) && (await entry_status(data)).running) await update_step(job.steps, t('已停止登录入口'), () => stop_entry(data));
    for (const account of running) if (!account.os_user) await update_step(job.steps, t('已停止 {value1} 的实例', { value1: account.name }), () => run_instance(data, account.name, 'stop'));
    const updater = join(data, 'update', 'panel_updater.mjs');
    mkdirSync(dirname(updater), { recursive: true });
    copyFileSync(join(ROOT, 'runner', 'panel_updater.mjs'), updater);
    write_update_job(data, { ...job, status: 'installing' });
    hand_over(updater);
  })().catch(error => {
    // Nothing was installed: what was stopped starts again on finish_update's path.
    write_update_job(data, { ...job, status: 'install_failed', steps: [...job.steps, { text: t('更新失败：{reason}', { reason: error.message }), failed: true }] });
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
  if (installed) await update_step(steps, t('已更新本机技能'), () => run_command(process.execPath, [installed_script('codiscuss.mjs'), 'setup', '--yes', '--no-start', '--json']).catch(error => {
    // Setup exits 2 when it finished with items to look at (an edited skill is kept, for one); that still counts.
    if (error.code !== 2) throw error;
  }));
  await update_step(steps, t('已启动本机服务'), () => run_owner_service(data, 'start'));
  // The panel itself starts an entry left on (run_panel); the report says once it serves again.
  if (hosting_enabled(data) && entry_settings(data).running) await update_step(steps, t('已重新启动登录入口'), async () => {
    for (let waited = 0; waited < ENTRY_BACK_MS; waited += 500) { if ((await entry_status(data)).running) return; await new Promise(done => setTimeout(done, 500)); }
    throw panel_error('入口没有重新启动，在“概览 → 登录入口 → 托管账号入口”点“启动”看原因');
  });
  if (hosting_enabled(data)) {
    const accounts = await list_accounts(data);
    // Isolated instances run from the shared copy: they stop before it is replaced, or files in use stay old.
    for (const account of accounts) {
      if (account.os_user && (job.restart || []).includes(account.name)) await update_step(steps, t('已停止 {value1} 的实例', { value1: account.name }), () => run_instance(data, account.name, 'stop'));
    }
    if (installed) await update_step(steps, t('已同步隔离账号的程序副本'), () => { const result = install_runtime(data); if (result.warnings.length) throw new Error(result.warnings.join('；')); });
    for (const account of accounts) {
      if (installed && account.os_user) await update_step(steps, t('已更新 {value1} 的技能', { value1: account.name }), () => prepare_account(data, account.name));
      // Reported restarted only once it serves again as the account is set (start_verified). Instances run from the
      // package were stopped before the install; those running from the shared copy were stopped above.
      if ((job.restart || []).includes(account.name)) await update_step(steps, t('已重启 {value1} 的实例', { value1: account.name }), () => start_verified(data, account.name));
    }
  }
  write_update_job(data, { ...job, status: 'done', ok: installed, steps });
}

/**
 * Bring an installed program copy up to date when the panel starts: a version installed some other way than the panel's
 * update (npm, setup) or an AI program that upgraded itself leaves it behind (user 2026-11-19). Same order as an update:
 * the isolated instances running from the copy stop first, or files in use stay old, then start again. What fails stays
 * on the overview's program copy row for the owner.
 */
async function sync_stale_copy(data) {
  if (!hosting_enabled(data)) return;
  const copy = shared_cli_state();
  if (!copy.app || (copy.app_version === VERSION && !copy.outdated.length)) return;
  const running = (await list_accounts(data)).filter(account => account.os_user && account.running);
  for (const account of running) await run_instance(data, account.name, 'stop');
  try {
    const result = install_runtime(data);
    if (result.warnings.length) throw new Error(result.warnings.join('；'));
    for (const name of Object.keys(read_os_users(data))) if (read_accounts(data)[name]) await prepare_account(data, name);
  } finally {
    for (const account of running) await start_verified(data, account.name);
  }
}

// ---- Accounts ----

/**
 * An account's service directory, for the owner's own reads and writes there. An isolated account may change everything
 * in its folder, including replacing `service` with a link to one of the owner's folders (its keys, its launch settings);
 * a path that does not lead where it says is refused, so the owner's writes cannot be redirected.
 */
function instance_home(data, name) {
  const path = plain_instance_home(data, name);
  // Node reports a junction as a symbolic link too. The owner writes into the folder and its api-keys folder.
  for (const folder of [path, join(path, 'api-keys')]) {
    let link = false;
    try { link = lstatSync(folder).isSymbolicLink(); } catch { link = false; }
    if (link) throw panel_error('{value1} 的服务目录里有指向别处的链接（{value2}），已停止操作', { value1: name, value2: folder });
  }
  return path;
}

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
  if (!account) throw panel_error('账号不存在：{value1}', { value1: name });
  await start(data, name, 'start');
  const key = account.protected === true ? instance_key(data, name) : '';
  if (account.protected === true && !key) throw panel_error('这个账号开启了入口保护，但入口读不到它的密钥');
  if (!await instance_ready(account.port, key, { conforms, wait_ms })) {
    throw (account.protected === true ? panel_error('实例没有按入口保护启动起来（启动失败，或密钥对不上）') : panel_error('实例没有启动起来'));
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
  return Promise.all(Object.entries(read_accounts(data)).map(async ([name, account]) => ({ name, port: account.port, home: account_home(data, name), project_data_root: account.project_data_root || '', disabled: Boolean(account.disabled), protected: account.protected === true,
    os_user: users[name]?.user || '', running: await instance_running(account.port), keys: list_keys(instance_home(data, name)).length,
    // The AI environment is set up once account_env.mjs has run for its Windows user (it records skills in the service home).
    skills: Boolean(users[name]) && existsSync(join(instance_home(data, name), SKILL_RECORD)),
    external: Boolean(read_account_sites(data)[name]) })));
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
  if (!existsSync(env_script)) throw panel_error('还没有安装隔离账号的程序副本，请先在“概览 → 本机 → 程序副本”中安装');
  const text = run_as_user(data, name, `& ${ps_quote(process.execPath)} ${ps_quote(env_script)} ${action} $Job`,
    { files: { 'request.json': JSON.stringify(request) }, folders, timeout: 120_000 });
  const line = text.split(/\r?\n/).reverse().find(item => item.trim().startsWith('{'));
  const result = line ? JSON.parse(line) : text.trim() ? { error: text.trim().slice(0, 300) } : error_body(panel_error('没有读到结果'));
  if (result.error) throw Object.assign(new Error(result.error), { error_text: result.error_text });
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
    // It shares the owner's software files, which CoDiscuss leaves alone; its own members get the default prompt instead.
    if (!Object.hasOwn(launch_settings(service).system_prompts || {}, 'managed')) save_managed_prompt(service, hosted_prompt(data));
    return { skills: [], workflows: (missing.length ? install_workflows(service, missing) : []).map(({ name: item, status }) => ({ name: item, status })) };
  }
  return account_env(data, name, 'init', { home: service, prompt: hosted_prompt(data) });
}

/** The library folders of the skills to install, placed as account_env.mjs expects them in its job folder. */
function library_folders(data, install) {
  const library = library_root(data), folders = {};
  for (const skill of install) {
    if (!existsSync(join(library, String(skill), 'SKILL.md'))) throw panel_error('技能库里没有 {value1}', { value1: skill });
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
  if (!['status', 'skills'].includes(action)) throw panel_error('未知操作：{value1}', { value1: action });
  const job = mkdtempSync(join(tmpdir(), 'codiscuss-env-'));
  try {
    writeFileSync(join(job, 'request.json'), JSON.stringify(request));
    for (const [target, source] of Object.entries(folders)) cpSync(source, join(job, target), { recursive: true });
    const result = spawnSync(process.execPath, [join(ROOT, 'runner', 'account_env.mjs'), action, job], { encoding: 'utf8', windowsHide: true, timeout: OWNER_ENV_TIMEOUT_MS });
    const line = String(result.stdout || '').split(/\r?\n/).reverse().find(item => item.trim().startsWith('{'));
    const parsed = line ? JSON.parse(line) : result.stderr?.trim() ? { error: result.stderr.trim().slice(0, 300) } : error_body(panel_error('没有读到结果'));
    if (parsed.error) throw Object.assign(new Error(parsed.error), { error_text: parsed.error_text });
    return parsed;
  } finally { rmSync(job, { recursive: true, force: true }); }
}

/**
 * The workflows in a service home's library, the shipped workflows it lacks, and the shipped ones whose copy differs
 * from the shipped version: { workflows: [{ id, label, description, cards, disabled?, error? }], missing: [id], outdated: [id] }.
 */
export function account_workflows(home) {
  const workflows = existsSync(workflows_home(home)) ? list_workflows(home).map(({ directory: _directory, unavailable: _unavailable, ...item }) => item) : [];
  const installed = new Set(workflows.map(item => item.id));
  return { workflows, missing: shipped_workflows().map(item => item.name).filter(name => !installed.has(name)),
    outdated: installed.size ? outdated_workflows(home) : [] };
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
  if (!account) throw panel_error('账号不存在：{value1}', { value1: name });
  if (on && process.platform !== 'win32' && place === place_instance_key) throw panel_error('入口保护目前只支持 Windows');
  // Whether the instance runs must be known, not guessed: a port that neither answers nor refuses stops everything.
  const before = await state(account.port);
  if (before === 'unknown') throw panel_error('无法确认实例是否在运行（端口没有回应），入口保护没有改动');
  // A running instance is stopped first and must be seen gone (its port refusing connections) before anything changes,
  // so the account is never marked one way while an instance of the other kind keeps serving.
  if (before === 'up') {
    await restart(data, name, 'stop');
    if (!await instance_stopped(account.port, { state, wait_ms })) throw panel_error('实例没有停下来，入口保护没有改动');
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
  if (command === 'start' && account?.project_migration) throw new Error('请先完成数据迁移 / Finish the pending data migration first');
  if (!account) throw panel_error('账号不存在：{value1}', { value1: name });
  const service = instance_home(data, name);
  // A protected instance starts knowing its key file; it then serves only callers that prove the key.
  const key_file = account.protected === true ? instance_key_file(name) : '';
  // An account without its own Windows user runs as the owner and could read everything the owner can; it is not let
  // run while people outside can reach the entry.
  if (command === 'start' && process.platform === 'win32' && !read_os_users(data)[name] && (entry_settings(data).relay_enabled || entry_settings(data).tunnel_enabled)) {
    throw panel_error('外网访问已开启，{value1} 未隔离（以你的身份运行），不能启动：请先隔离该账号，或关闭登录入口的自建中转和 Cloudflare 隧道', { value1: name });
  }
  if (command === 'start' && read_os_users(data)[name]) {
    const { local_script } = shared_paths();
    if (!existsSync(local_script)) throw panel_error('还没有安装隔离账号的程序副本，请先在“概览 → 本机 → 程序副本”中安装');
    // Whatever was set up first, the instance starts on the shared copies its Windows user can run.
    use_shared_programs(data, name);
    if (!existsSync(policy_path(data))) save_attachment_limit(data, attachment_limit(data));
    return start_instance_as_user(data, name, service, local_script, process.execPath, { key_file });
  }
  // An isolated instance runs as a scheduled task that comes back when the computer starts unless it was stopped here.
  if (read_os_users(data)[name]) clear_instance_flag(name);
  else set_instance_wanted(data, name, command === 'start');
  const { DISCUSS_ENTRY_KEY_FILE: _inherited, ...environment } = process.env;
  const child = spawn(process.execPath, [LOCAL_SCRIPT, command, '--json'], { stdio: 'ignore', windowsHide: true,
    env: { ...environment, DISCUSS_ATTACHMENT_POLICY_FILE: policy_path(data), DISCUSS_OBJECT_STORAGE_QUOTA_FILE: object_quota_path(data, name),
      DISCUSS_SERVICE_HOME: service, ...(key_file ? { DISCUSS_ENTRY_KEY_FILE: key_file } : {}) } });
  return new Promise((done, fail) => {
    child.on('error', fail);
    child.on('exit', code => code === 0 ? done() : fail(command === 'start'
      ? panel_error('实例启动失败（退出码 {code}）', { code }) : panel_error('实例停止失败（退出码 {code}）', { code })));
  });
}

/** Stop the account and complete or resume the move recorded in the owner-only registry. */
export async function migrate_account_data(data, name, requested, { stop = run_instance, reserve = reserve_project_root } = {}) {
  const account = read_accounts(data)[name], service = instance_home(data, name);
  let job = account.project_migration;
  if (!requested || (job && resolve(requested) !== job.target)) throw new Error('请指定原迁移目标 / Specify the migration destination');
  if (!job && account.project_data_root && resolve(requested) === account.project_data_root) return { project_data_root: account.project_data_root };
  const user = read_os_users(data)[name]?.user || '';
  if (!job) {
    const target = reserve(data, name, requested, user);
    job = { target, previous: account.project_data_root || '', id: randomBytes(8).toString('hex') };
    set_project_migration(data, name, job);
  }
  try {
    await stop(data, name, 'stop');
    const state = local_status(service);
    if (state.pid || state.service_pid || await instance_state(account.port) !== 'down') throw new Error('实例仍在运行 / Instance is still running');
    if (user) require_idle_os_user(user);
  } catch (error) {
    if (!account.project_migration) set_project_migration(data, name, null);
    throw error;
  }
  const request = { ...job, service };
  let receipts;
  try { receipts = await migration_worker(data, name, request, user); } catch (error) {
    if (error.rolled_back) set_project_migration(data, name, null);
    throw error;
  }
  const kinds = {};
  for (const kind of ['workspace', 'projects', 'drafts']) {
    if (!receipts[kind]) continue;
    const path = receipt_path(data, job.id, kind);
    mkdirSync(dirname(path), { recursive: true });
    const temp = path + '.' + randomBytes(8).toString('hex');
    writeFileSync(temp, JSON.stringify(receipts[kind]), { flag: 'wx', mode: 0o600 });
    renameSync(temp, path);
    kinds[kind] = 'ready';
  }
  set_project_migration(data, name, null, job.target, Object.keys(kinds).length ? { ...job, kinds } : null);
  return { project_data_root: job.target, backup_suffix: '.before-' + job.id };
}

function receipt_path(data, id, kind) {
  return join(data, 'project-migration-receipts', id + '-' + kind + '.json');
}

/** Report current bytes for each registered backup, or why its identity could not be verified. */
export async function list_migration_backups(data, name) {
  const account = read_accounts(data)[name], rows = [], service = instance_home(data, name);
  const user = read_os_users(data)[name]?.user;
  for (const job of account.migration_backups || []) {
    for (const folder of migration_folders({ ...job, service })) {
      const kind = folder.name;
      if (!job.kinds[kind]) continue;
      const row = { id: job.id, kind, path: folder.backup, state: job.kinds[kind] };
      try {
        const record = JSON.parse(readFileSync(receipt_path(data, job.id, kind), 'utf8'));
        Object.assign(row, await migration_worker(data, name, { ...job, service, kind, record, action: 'list', releasing: row.state === 'releasing' }, user));
      } catch (error) { row.error = error.message; }
      rows.push(row);
    }
  }
  return rows;
}

/** Release one confirmed backup, keeping its junction and active target in place. */
export async function release_migration_backup(data, name, body, stop = run_instance) {
  const account = read_accounts(data)[name], { id, kind } = body;
  const job = account.migration_backups?.find(item => item.id === id);
  if (body.confirm !== true || !job || !['projects', 'workspace', 'drafts'].includes(kind) || !job.kinds[kind]) {
    throw new Error('请选择已登记的备份并确认 / Select and confirm a registered backup');
  }
  const service = instance_home(data, name), user = read_os_users(data)[name]?.user;
  const record = JSON.parse(readFileSync(receipt_path(data, id, kind), 'utf8'));
  await stop(data, name, 'stop');
  const state = local_status(service);
  if (state.pid || state.service_pid || await instance_state(account.port) !== 'down') throw new Error('实例仍在运行 / Instance is still running');
  if (user) require_idle_os_user(user);
  const request = { ...job, kind, service, record, releasing: job.kinds[kind] === 'releasing' };
  await migration_worker(data, name, { ...request, action: 'verify' }, user);
  mark_backup_release(data, name, id, kind, false);
  await migration_worker(data, name, { ...request, releasing: true, action: 'release' }, user);
  mark_backup_release(data, name, id, kind, true);
  rmSync(receipt_path(data, id, kind), { force: true });
  return { released: kind, id };
}

async function migration_worker(data, name, request, user) {
  if (user) {
    const code = readFileSync(new URL('./project_migration.mjs', import.meta.url), 'utf8');
    const output = run_as_user(data, name, `& ${ps_quote(process.execPath)} (Join-Path $Job 'move.mjs') (Join-Path $Job 'request.json')`,
      { files: { 'move.mjs': code, 'request.json': JSON.stringify(request) }, timeout: 3600_000 });
    const reply = JSON.parse(output);
    if (!reply.result) throw Object.assign(new Error(reply.error || 'Migration incomplete'), { rolled_back: reply.rolled_back === true });
    return reply.result;
  }
  return request.action ? backup_operation(request) : move_project_files(request);
}

// ---- API keys an account's instance holds ----

const KEY_FILE = /^[a-f0-9-]{36}\.json$/i;

/** The keys saved in an instance, newest first, with only the last characters of each key. */
/**
 * Recognize keys saved for speech and the account's configured resource center by address.
 */
export function key_use(base_url, storage_url = '') {
  const root = String(base_url || '').replace(/\/+$/, '');
  const match = list => list.find(item => [item.key_base_url, item.legacy_key_base_url].some(url => url && url.replace(/\/+$/, '') === root));
  const speak = match(TTS_PROVIDERS), listen = match(STT_PROVIDERS), provider = speak || listen;
  const speech = provider ? { label: provider.local ? t('本机语音服务') : provider.label,
    uses: [speak && t('语音朗读'), listen && t('语音识别')].filter(Boolean), local: Boolean(provider.local) } : null;
  return { speech, object_storage: Boolean(storage_url && storage_url === root) };
}

export function list_keys(service) {
  const directory = join(service, 'api-keys');
  if (!existsSync(directory)) return [];
  const { base_url: storage_url } = object_storage_status(service);
  return readdirSync(directory).filter(name => KEY_FILE.test(name)).map(name => {
    const path = join(directory, name);
    try {
      const saved = JSON.parse(readFileSync(path, 'utf8'));
      return { ref: name.slice(0, -5), base_url: saved.base_url, managed: saved.managed === true, tail: String(saved.api_key || '').slice(-4), time: statSync(path).mtimeMs,
        ...key_use(saved.base_url, storage_url) };
    } catch { return null; }
  }).filter(Boolean).sort((left, right) => right.time - left.time);
}

function remove_key(service, ref) {
  if (!/^[a-f0-9-]{36}$/i.test(ref)) throw panel_error('密钥编号无效');
  rmSync(join(service, 'api-keys', `${ref}.json`), { force: true });
}

function panel_object_storage(home, method, action, body, options) {
  if (method === 'GET' && !action) return object_storage_status(home, options);
  if (method === 'POST' && !action) {
    const { quota_mib, ...settings } = body ?? {};
    const set_quota = Object.hasOwn(body ?? {}, 'quota_mib');
    if (set_quota) checked_quota(quota_mib);
    if (!set_quota || Object.keys(settings).length) save_object_storage(home, settings, options);
    if (set_quota) save_object_quota(options.quota_file, quota_mib);
    return object_storage_status(home, options);
  }
  if (method === 'POST' && action === 'test') return test_object_storage(home);
  if (method === 'POST' && action === 'clear') return clear_object_storage(home, options);
  throw panel_error('接口不存在');
}

/** Forward this panel's authenticated cloud inventory request to the selected account's own site. */
async function panel_object_files(local, key_file, deleting, body) {
  const route = 'api/rooms/cloud-attachments' + (deleting ? '/delete' : '');
  const init = { redirect: 'error', signal: AbortSignal.timeout(15_000) };
  if (deleting) Object.assign(init, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: body?.id }) });
  const response = await site_fetch(new URL(route, local).href, init, key_file ? { key_file } : undefined);
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error || t('接口不存在')), { status: response.status, error_text: result.error_text });
  return result;
}

// ---- HTTP ----

/** Keep CLI errors localized while carrying the Chinese template to the browser. */
function panel_error(template, params = {}) {
  return Object.assign(new Error(t(template, params)), { error_text: { template, params } });
}

/** Preserve the legacy Chinese error and let the page choose its own language. */
function error_body(error) {
  const error_text = error.error_text || { template: error.message, params: {} };
  return { error: error_text.template.replace(/\{(\w+)\}/g, (match, name) => Object.hasOwn(error_text.params, name) ? String(error_text.params[name]) : match), error_text };
}

function send_json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

function read_body(request, limit = BODY_LIMIT) {
  return new Promise((done, fail) => {
    let size = 0; const chunks = [];
    request.on('data', chunk => { size += chunk.length; if (size > limit) { fail((limit > BODY_LIMIT ? panel_error('技能太大（上限 40 MB）') : panel_error('请求过大'))); request.destroy(); } else chunks.push(chunk); });
    request.on('end', () => { try { done(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { fail(panel_error('请求不是 JSON')); } });
    request.on('error', fail);
  });
}

function cookie(request, name) {
  return String(request.headers.cookie || '').split(';').map(part => part.trim().split('=')).find(([key]) => key === name)?.[1] || '';
}

/** The instance port to watch when the owner wants the account running. */
function wanted_port(data, name, flag_set) {
  if (!hosting_enabled(data)) return;
  const job = update_job(data);
  if (job && job.status !== 'done' && Date.now() - job.started_at < UPDATE_STALE_MS) return;
  const account = read_accounts(data)[name];
  if (!account || account.disabled || account.project_migration) return;
  if (read_os_users(data)[name]) return flag_set(name) ? account.port : undefined;
  if (account.instance_wanted === undefined && local_status(instance_home(data, name)).website_running) {
    set_instance_wanted(data, name, true);
    return account.port;
  }
  return account.instance_wanted ? account.port : undefined;
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
  const op = { list_accounts, add_account, reset_password, set_account_disabled, remove_account, run_instance, create_os_user, remove_os_user, restrict_other_drives,
    login_status, apply_login, logout, start_login, login_progress, submit_login, cancel_login, install_runtime, prepare_account, account_env, account_skills, account_workflows, owner_env, owner_skills, shared_cli_state,
    save_api_key, list_keys, remove_key, use_shared_programs, service_overview, run_owner_service, latest_version, check_package, begin_update,
    set_account_external, reconcile_external, autostart_enabled, set_autostart, entry_overview, start_entry, stop_entry, keep_tunnel, start_tunnel_setup, set_entry_way, set_relay_url, connect_site, make_access_code, join_relay, protect_account, start_verified, hand_over: () => {}, ...ops };
  let reconnecting_tunnel;
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const recovery = instance_recovery(data, { wanted: name => wanted_port(data, name, ops.instance_flag_set || instance_flag_set),
    probe: ops.instance_state || instance_state, start: name => op.start_verified(data, name), now: ops.now,
    on_block(name) { if (read_os_users(data)[name]) (ops.clear_instance_flag || clear_instance_flag)(name); } });

  async function api(method, path, body) {
    const parts = path.split('/').filter(Boolean).slice(1);
    const [section, name, action, extra] = parts;
    const account = () => { if (!read_accounts(data)[name]) throw panel_error('账号不存在：{value1}', { value1: name }); return name; };
    // Accounts follow the way external members can reach them, in the background (#5660).
    const after_change = () => { op.reconcile_external(data).catch(() => {}); };
    const hosting = hosting_enabled(data);
    if (path === '/api/room-links/room-links' && method === 'POST') {
      const room = body.room;
      if (typeof room !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(room)) throw panel_error('房间编号无效');
      const url = new URL(`api/rooms/${room}/room-links`, site_url(data));
      const response = await site_fetch(url.href, { redirect: 'error', signal: AbortSignal.timeout(10000) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      return result;
    }
    if (path === '/api/storage/attachment-limit' && method === 'GET') return { limit_mib: attachment_limit(data) };
    if (path === '/api/storage/attachment-limit' && method === 'POST') return save_attachment_limit(data, body.limit_mib);
    if (path === '/api/storage/object/files' && method === 'GET' || path === '/api/storage/object/files/delete' && method === 'POST') {
      const key_file = owner_key_file(data);
      return panel_object_files(site_url(data), existsSync(key_file) ? key_file : '', method === 'POST', body);
    }
    if (section === 'storage' && name === 'object' && parts.length <= 3)
      return panel_object_storage(data, method, action, body, { limit: attachment_limit(data), quota_file: object_quota_path(data) });
    if (path === '/api/storage' && method === 'GET') return panel_storage(data, site_url(data));
    if (path === '/api/storage/steward' && method === 'POST') return panel_storage_steward(data);
    if (path === '/api/storage/clean' && method === 'POST') return panel_clean(data, site_url(data), body);
    if (path === '/api/storage/repair' && method === 'POST') return panel_repair(data, site_url(data), body);
    if (path === '/api/storage/attachments' && method === 'POST') return panel_room_attachments(site_url(data), body);
    if (path === '/api/storage/attachments/clear' && method === 'POST') return panel_clear_attachments(site_url(data), body);
    if (method === 'GET' && section === 'state') {
      const windows = process.platform === 'win32';
      const service = op.service_overview(data), bound = bound_site(data);
      const restarts = hosting ? recovery.status() : {};
      return { hosting, version: VERSION, service, online_site: bound?.site || '', relay_region: bound?.region ?? 'apac', platform: process.platform,
        relay_health: read_relay_health(data, bound, service.running && service.pid),
        launcher: windows && existsSync(launcher_path(data)), autostart: windows && op.autostart_enabled(), login_methods: LOGIN_METHODS, providers: API_PROVIDERS,
        ...(hosting ? { accounts: (await op.list_accounts(data)).map(item => ({ ...item, last_restart: restarts[item.name] })), clis: op.shared_cli_state(), entry: await op.entry_overview(data, { reach: false }) }
          : { accounts: [], clis: {}, entry: null }) };
    }
    // The entry with what needs the network (the relay's reach, the tunnel's connection), asked apart so the state is quick.
    if (method === 'GET' && section === 'entry' && !name) return hosting ? op.entry_overview(data) : null;
    // This computer: the owner's own service, its updates and login autostart.
    // The owner's site opens in the default browser (not the panel's own window), through a signed link while it is protected.
    if (method === 'POST' && section === 'service' && name === 'open') { open_browser(signed_site_url(site_url(data), data)); return { ok: true }; }
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
    if (method === 'POST' && section === 'update') {
      const version = await op.latest_version(true);
      await op.check_package(version);
      return op.begin_update(data, version, op.hand_over);
    }
    if (method === 'POST' && section === 'autostart') return { autostart: op.set_autostart(Boolean(body.on), data) };
    // Command-line sign-in: '_' is the owner; an account name is a hosted account with its own Windows user.
    if (section === 'login-jobs') {
      if (method === 'GET') return op.login_progress(name);
      if (method === 'POST' && action === 'submit') return op.submit_login(name, body.text);
      if (method === 'POST' && action === 'cancel') return op.cancel_login(name);
    }
    if (section === 'logins') {
      const target = name === '_' ? '' : name;
      if (target && (!hosting || !read_accounts(data)[target])) throw (target && !hosting ? panel_error('托管管理未打开') : panel_error('账号不存在：{value1}', { value1: target }));
      if (method === 'GET' && !action) return op.login_status(data, target);
      if (method === 'POST' && extra === 'apply') return op.apply_login(data, target, action, body);
      if (method === 'POST' && extra === 'logout') return op.logout(data, target, action);
      if (method === 'POST' && extra === 'start') return op.start_login(data, target, action, body.method);
      throw panel_error('接口不存在');
    }
    // The owner as an account: its skills (from its own folder, library skills installed or removed) and API keys.
    if (section === 'owner') {
      if (method === 'GET' && name === 'env') return op.owner_env('status');
      if (method === 'POST' && name === 'env' && action === 'skills') return op.owner_skills(data, { install: body.install || [], remove: body.remove || [] });
      if (method === 'GET' && name === 'workflows') return op.account_workflows(data);
      // Only the shipped workflows the owner's library lacks: an existing one, edited or not, is kept.
      if (method === 'POST' && name === 'workflows' && action === 'install') { install_workflows(data, op.account_workflows(data).missing); return op.account_workflows(data); }
      // Replace the ones that differ from the shipped version; each old copy is backed up first (as setup --workflows).
      if (method === 'POST' && name === 'workflows' && action === 'update') { install_workflows(data, outdated_workflows(data)); return op.account_workflows(data); }
      if (method === 'GET' && name === 'keys') return op.list_keys(data);
      if (method === 'POST' && name === 'keys' && action === 'remove') { op.remove_key(data, String(body.ref || '')); return { ok: true }; }
      if (method === 'POST' && name === 'keys') return op.save_api_key(data, { base_url: body.base_url, api_key: body.api_key });
      throw panel_error('接口不存在');
    }
    // The skill library is the owner's, for the owner and the hosted accounts alike.
    if (section === 'skill-library') {
      if (method === 'GET') return list_library(data);
      if (method === 'POST' && !name) return import_skill(data, body);
      if (method === 'POST' && action === 'remove') { remove_library_skill(data, name); return { ok: true }; }
    }
    // The owner's own online site: bound, checked and left here whether or not this computer hosts accounts.
    if (method === 'POST' && section === 'site' && name === 'connect') { const bound = await bind_online_site(data, body, op.connect_site); after_change(); return bound; }
    if (method === 'POST' && section === 'site' && name === 'disconnect') { const left = await disconnect_site(data); after_change(); return left; }
    if (section === 'site' && name === 'origins' && ['GET', 'POST'].includes(method)) {
      const bound = bound_site(data);
      if (!bound) throw panel_error('尚未绑定自建中转');
      return method === 'GET' ? pairing_origins(data, bound.site)
        : update_pairing_origins(data, bound.site, body.action, body.origin, body.subdomains);
    }
    if (section === 'site' && name === 'region' && ['GET', 'POST'].includes(method)) {
      const bound = bound_site(data);
      if (!bound) throw panel_error('尚未绑定自建中转');
      if (method === 'GET') return { region: bound.region };
      if (!RELAY_REGIONS.includes(body.region)) throw panel_error('中转地区无效');
      if (bound.region === body.region) return { region: bound.region };
      const links = machine_links(data);
      links.sites[bound.site].relay_region = body.region;
      save_machine_links(data, links);
      const service = op.service_overview(data);
      if (service.pid) request_relay_reconnect(data, { ...bound, wait_region: body.region }, service.pid);
      after_change();
      return { region: body.region };
    }
    if (method === 'POST' && section === 'site' && name === 'reconnect') {
      const bound = bound_site(data), service = op.service_overview(data);
      if (!bound) throw panel_error('尚未绑定自建中转');
      if (!service.pid) throw panel_error('请先启动共议服务，再重连中转');
      request_relay_reconnect(data, bound, service.pid);
      return { requested: true, site: bound.site };
    }
    // Hosting: only once the owner turned it on in setup.
    if (!hosting) throw panel_error('托管管理未打开：运行 codiscuss setup 勾选“托管管理（管理面板）”');
    if (method === 'POST' && section === 'clis' && name === 'install') return op.install_runtime(data);
    // Hosted accounts' Windows users kept off every drive but the system drive; what they run must already lie there.
    if (method === 'POST' && section === 'drives' && name === 'restrict') {
      const accounts = read_accounts(data);
      return op.restrict_other_drives(data, Object.entries(accounts).flatMap(([id, account]) =>
        [account_home(data, id), account.project_data_root, account.project_migration?.target].filter(Boolean)));
    }
    // The account entry customers sign in at: started and stopped here, and started again with the panel if it was left on.
    if (method === 'POST' && section === 'entry' && (name === 'start' || name === 'stop')) {
      await (name === 'start' ? op.start_entry(data) : op.stop_entry(data));
      save_entry_settings(data, { running: name === 'start' });
      // Its tunnel goes with it.
      await op.keep_tunnel(data);
      return op.entry_overview(data);
    }
    // How people outside reach the entry, the relay's entry address, and binding this computer to an online site.
    if (method === 'POST' && section === 'entry' && name === 'way') {
      const overview = await op.set_entry_way(data, String(body.way || ''), body.enabled === true);
      after_change();
      return overview;
    }
    if (method === 'POST' && section === 'entry' && name === 'relay') return op.set_relay_url(data, body.url);
    // The access code: made on the computer that deployed the online site, pasted on a hosting computer.
    if (method === 'GET' && section === 'site' && name === 'code') return { ...deploy_settings(data), site: deploy_settings(data).site || bound_site(data)?.site || '' };
    if (method === 'POST' && section === 'site' && name === 'code') return op.make_access_code(data, body);
    if (method === 'POST' && section === 'relay' && name === 'join') return op.join_relay(data, body.code);
    // The outside address: a Cloudflare tunnel set up by a job of its own (it waits for the owner in the browser).
    if (method === 'POST' && section === 'tunnel' && name === 'reconnect') {
      reconnecting_tunnel ??= reconnect_tunnel(data).finally(() => { reconnecting_tunnel = null; });
      return reconnecting_tunnel;
    }
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
    if (section !== 'accounts') throw panel_error('接口不存在');
    if (method === 'POST' && !name) { const added = await op.add_account(data, String(body.name || '').trim(), undefined, body.project_data_root); after_change(); return added; }
    account();
    if (method === 'POST' && action === 'migrate-data') return recovery.manage(name, action,
      () => migrate_account_data(data, name, body.project_data_root, { stop: op.run_instance }));
    if (method === 'POST' && read_accounts(data)[name].project_migration && action !== 'stop') throw new Error('请先完成数据迁移 / Finish the pending data migration first');
    if (method === 'GET' && action === 'migration-backups') return list_migration_backups(data, name);
    if (method === 'POST' && action === 'release-backup') return recovery.manage(name, action,
      () => release_migration_backup(data, name, body, op.run_instance));
    if (method === 'POST' && action === 'password') return { password: op.reset_password(data, name) };
    if (method === 'POST' && action === 'protect') return recovery.manage(name, action, () => op.protect_account(data, name, body.on !== false));
    if (method === 'POST' && (action === 'disable' || action === 'enable')) { op.set_account_disabled(data, name, action === 'disable'); return { disabled: action === 'disable' }; }
    // The instance stops first: its port goes to the next new account, which must not reach this one's instance.
    if (method === 'POST' && action === 'remove') return recovery.manage(name, action, async () => {
      await op.run_instance(data, name, 'stop');
      // Its online-site binding goes first, or the owner could never unbind the computer afterwards.
      await change_external(data, name, false, { removing: true }).catch(() => {});
      op.remove_account(data, name);
      return { removed: name, kept: account_home(data, name) };
    });
    // A start is reported only once the instance serves as the account is set (protected or not).
    if (method === 'POST' && action === 'start') { await recovery.manage(name, action, () => op.start_verified(data, name)); return { ok: true }; }
    if (method === 'POST' && action === 'stop') { await recovery.manage(name, action, () => op.run_instance(data, name, action)); return { ok: true }; }
    // Its identity file is sealed for whichever Windows user wrote it: it goes before that user changes, and is made
    // again for the new one by the next reconcile (#5660).
    // Taken down first and for real: a failure stops the change, or the new user could never open what is left (#5666).
    if (method === 'POST' && action === 'os-user') await change_external(data, name, false);
    if (method === 'POST' && action === 'os-user' && extra === 'remove') { set_instance_wanted(data, name, false); op.remove_os_user(data, name); after_change(); return { ok: true }; }
    if (method === 'POST' && action === 'os-user') {
      const result = op.create_os_user(data, name, account_home(data, name), { project_data_root: read_accounts(data)[name].project_data_root });
      op.use_shared_programs(data, name);
      after_change();
      return result;
    }
    // Its AI environment: set up (safe to repeat), what is installed, chosen library skills, its system prompt.
    if (method === 'POST' && action === 'env' && extra === 'init') return op.prepare_account(data, name);
    if (method === 'GET' && action === 'env') return op.account_env(data, name, 'status', { home: instance_home(data, name) });
    if (method === 'POST' && action === 'env' && extra === 'skills') return op.account_skills(data, name, { install: body.install || [], remove: body.remove || [] });
    if (method === 'POST' && action === 'env' && extra === 'prompt') return op.account_env(data, name, 'prompt', { home: instance_home(data, name), prompt: String(body.text ?? '') });
    const service = instance_home(data, name);
    if (action === 'object-storage' && extra === 'files' && (parts.length === 4 && method === 'GET'
      || parts.length === 5 && parts[4] === 'delete' && method === 'POST')) {
      const target = read_accounts(data)[name];
      return panel_object_files(`http://127.0.0.1:${target.port}/`, target.protected ? instance_key_file(name) : '', method === 'POST', body);
    }
    if (action === 'object-storage' && parts.length <= 4)
      return panel_object_storage(service, method, extra, body, { limit: attachment_limit(data), quota_file: object_quota_path(data, name) });
    if (method === 'GET' && action === 'workflows') return op.account_workflows(service);
    // Set up again (safe to repeat): it installs the shipped workflows the account lacks and keeps the rest.
    if (method === 'POST' && action === 'workflows' && extra === 'install') { await op.prepare_account(data, name); return op.account_workflows(service); }
    if (method === 'POST' && action === 'workflows' && extra === 'update') { install_workflows(service, outdated_workflows(service)); return op.account_workflows(service); }
    if (method === 'GET' && action === 'keys') return op.list_keys(service);
    if (method === 'POST' && action === 'keys' && extra === 'remove') { op.remove_key(service, String(body.ref || '')); return { ok: true }; }
    if (method === 'POST' && action === 'keys') return op.save_api_key(service, { base_url: body.base_url, api_key: body.api_key, managed: true });
    throw panel_error('接口不存在');
  }

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      // Only a page this browser opened from this address; anything else (another site, a renamed host) is refused.
      if (!hosts.has(String(request.headers.host || ''))) return send_json(response, 403, error_body(panel_error('只接受本机访问')));
      if (url.pathname === '/enter' || (url.pathname === '/' && url.searchParams.has('key'))) {
        if (url.searchParams.get('key') !== key) return send_json(response, 403, error_body(panel_error('钥匙无效，请从任务栏图标打开管理面板')));
        const session = randomBytes(24).toString('hex');
        sessions.add(session);
        const page = /^[a-z]+$/.test(url.searchParams.get('page') || '') ? `#${url.searchParams.get('page')}` : '';
        response.writeHead(302, { Location: `/${page}`, 'Set-Cookie': `${SESSION_COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/` });
        return response.end();
      }
      const signed_in = sessions.has(cookie(request, SESSION_COOKIE));
      if (url.pathname.startsWith('/api/')) {
        if (!signed_in) return send_json(response, 401, error_body(panel_error('请从任务栏图标重新打开管理面板')));
        const origin = request.headers.origin;
        if (request.method !== 'GET' && (!origin || !hosts.has(origin.replace(/^http:\/\//, '')) || request.headers['x-codiscuss-panel'] !== '1')) {
          return send_json(response, 403, error_body(panel_error('拒绝跨站请求')));
        }
        // A dropped skill arrives whole (its files in base64), so that one request may be large.
        const body = request.method === 'POST' ? await read_body(request, url.pathname === '/api/skill-library' ? UPLOAD_LIMIT : BODY_LIMIT) : {};
        return send_json(response, 200, await api(request.method, url.pathname, body));
      }
      const name = STATIC_FILES[url.pathname] || (url.pathname.startsWith('/icons/') && /^\/icons\/[\w.-]+$/.test(url.pathname) ? url.pathname.slice(1) : '');
      if (!name) return send_json(response, 404, error_body(panel_error('页面不存在')));
      if (name === 'admin.html' && !signed_in) {
        response.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
        const chinese = /^zh\b/i.test(request.headers['accept-language'] || 'zh');
        return response.end(chinese
          ? '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>共议管理面板</title><p style="font:15px system-ui;padding:40px">请从任务栏的共议图标打开管理面板。</p></html>'
          : '<!doctype html><html lang="en"><meta charset="utf-8"><title>CoDiscuss admin panel</title><p style="font:15px system-ui;padding:40px">Open the admin panel from the CoDiscuss taskbar icon.</p></html>');
      }
      const file = join(WEB, name);
      if (!existsSync(file)) return send_json(response, 404, error_body(panel_error('页面尚未构建，请运行 npm run build')));
      response.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      // The page names its own version and asks for its scripts by version, so a page left open across an update
      // can tell it is old and nothing cached is taken for the new one (user 2026-11-19, #5679).
      if (name === 'admin.html') return response.end(readFileSync(file, 'utf8').replace('<head>', `<head>
  <meta name="codiscuss-version" content="${VERSION}">`)
        .replace(/(href|src)="\/(admin\.css|i18n\.js|admin\.js)"/g, `$1="/$2?v=${VERSION}"`));
      response.end(readFileSync(file));
    } catch (error) {
      if (response.headersSent) response.destroy();
      else send_json(response, error.status || 400, error_body(error));
    }
  });
  // The same operations without HTTP, for `codiscuss admin` run elevated (the steps that need administrator rights).
  server.api = api;
  server.recover_instances = async () => {
    if (hosting_enabled(data)) await Promise.all(Object.keys(read_accounts(data)).map(name => recovery.check(name)));
  };
  return server;
}

/** The account entry as the hosting page shows it: whether it runs, its loopback port and the address customers open. */
/** Restart only cloudflared and return the final readiness probe. */
async function reconnect_tunnel(data) {
  const entry = await entry_status(data);
  const { tunnel, tunnel_enabled } = entry_settings(data);
  if (!tunnel) throw panel_error('请先配置 Cloudflare 隧道');
  if (!tunnel_enabled) throw panel_error('请先开启 Cloudflare 隧道');
  if (!entry.running) throw panel_error('请先启动登录入口');
  stop_tunnel(data);
  await ensure_tunnel(data, tunnel, entry.port);
  const deadline = Date.now() + TUNNEL_CONNECT_MS;
  while (true) {
    const status = await tunnel_status(data);
    if (status.connected || Date.now() >= deadline) return status;
    await new Promise(resolve => setTimeout(resolve, TUNNEL_POLL_MS));
  }
}

/** Keep the entry's tunnel as the settings say: running while hosting is on and the entry is meant to run. */
function keep_tunnel(data) {
  const { tunnel, port, running, tunnel_enabled } = entry_settings(data);
  return ensure_tunnel(data, hosting_enabled(data) && tunnel_enabled ? tunnel : null, port, running);
}

/** The online site this computer is bound to (`codiscuss local connect`) and its id there, or null. */
function bound_site(data) {
  const [site, link] = Object.entries(machine_links(data).sites || {}).find(([, item]) => item?.id && item?.private_key) || [];
  return site ? { site, machine: link.id, region: RELAY_REGIONS.includes(link.relay_region) ? link.relay_region : 'apac' } : null;
}

/** Ask the relay's entry Worker whether it is one and whether this computer is connected to it. */
async function relay_status(relay_url, machine) {
  try {
    const answer = await fetch_outside(`${relay_url}/_codiscuss/status?machine=${machine || '0'.repeat(32)}`, RELAY_CHECK_MS);
    const result = await answer.json();
    return result.service === 'codiscuss-entry' ? { reachable: true, online: Boolean(result.online) } : { reachable: false, online: false };
  } catch { return { reachable: false, online: false }; }
}

/** What stands between people outside and this computer over the relay, in the order to look at it; '' when nothing. */
function relay_problem(relay, entry_running, service_running) {
  if (!relay.reachable) return t('入口地址连不上：检查网络与代理是否放行 *.workers.dev');
  if (!service_running) return t('本机服务没有在运行，电脑连不上线上站点：在上面“本机”里启动共议服务');
  if (!relay.online) return t('电脑还没连上线上站点：本机服务刚启动时稍等几秒；持续如此，可能这台电脑绑定的站点与入口不属于同一个 Cloudflare 账号，重新用接入码接入');
  if (!entry_running) return t('登录入口没有在运行：点上面的“启动”');
  return '';
}

/**
 * The entry and its ways from outside. With `reach` off it leaves out what needs asking the relay over the network and
 * cloudflared (`checked: false`), so the panel's state answers at once; the page then asks `GET entry` for the rest.
 */
async function entry_overview(data, { reach = true } = {}) {
  const { port, public_url, tunnel, relay_enabled, tunnel_enabled, relay_url } = entry_settings(data), status = await entry_status(data);
  const bound = bound_site(data);
  const relay = { url: relay_url, site: bound?.site || '', link: relay_url && bound ? `${relay_url}/?m=${bound.machine}` : '',
    ...(reach && relay_enabled && relay_url && bound ? await relay_status(relay_url, bound.machine) : {}) };
  if (reach && relay_enabled) relay.problem = relay_problem(relay, status.running, Boolean(local_status(data).running));
  // The address handed to people: the owner's domain when it is on (direct, and outside the Workers quota), else the relay.
  const address = tunnel_enabled && public_url ? public_url : relay_enabled ? relay.link : '';
  return { running: status.running, port: status.running ? status.port : port, public_url, relay_enabled, tunnel_enabled, address, relay, checked: reach,
    tunnel: tunnel ? { host: tunnel.host, name: tunnel.name, ...(reach ? await tunnel_status(data) : {}) } : null };
}

/** Make sure what a way from outside needs is there before it is turned on. */
async function prepare_entry_way(data, way) {
  const settings = entry_settings(data);
  if (way === 'relay') {
    const bound = bound_site(data);
    if (!bound) throw panel_error('这台电脑还没有接入线上站点：先用接入码接入');
    // Bound without an access code (`codiscuss local connect`): the site it is bound to gives the entry address.
    if (!settings.relay_url) await set_relay_url(data, await site_entry_url(bound.site));
  }
  if (way === 'tunnel' && !settings.tunnel) throw panel_error('还没有设好 Cloudflare 隧道：先点“设置”填写你的域名');
  if (process.platform === 'win32') {
    const users = read_os_users(data), accounts = read_accounts(data);
    const exposed = [];
    for (const [name, account] of Object.entries(accounts)) if (!users[name] && await instance_running(account.port)) exposed.push(name);
    if (exposed.length) throw panel_error('未隔离的账号正在运行（{value1}），它们以你的身份运行，开启自建中转或 Cloudflare 隧道前请先停止或隔离', { value1: exposed.join('、') });
  }
}

/**
 * Turn one way from outside on or off; the other way is left as it is. Reaching the entry from outside needs it running,
 * and the relay needs this computer's service (which holds the relay connection): both are started here rather than left
 * for the first person to find a broken link. The tunnel follows at once.
 */
async function set_entry_way(data, way, enabled) {
  if (!ENTRY_WAYS.includes(way)) throw panel_error('未知的访问方式：{value1}', { value1: way });
  if (enabled) await prepare_entry_way(data, way);
  save_entry_settings(data, { [`${way}_enabled`]: enabled });
  if (enabled && !(await entry_status(data)).running) { await start_entry(data); save_entry_settings(data, { running: true }); }
  // With no way left on nobody can reach the entry, so it does not keep running.
  const settings = entry_settings(data);
  if (!enabled && !settings.relay_enabled && !settings.tunnel_enabled) {
    if ((await entry_status(data)).running) await stop_entry(data);
    save_entry_settings(data, { running: false });
  }
  if (enabled && way === 'relay' && !local_status(data).running) await run_owner_service(data, 'start');
  await keep_tunnel(data);
  return entry_overview(data);
}

// Where the panel of the computer that deployed the online site remembers its deployment config and the site's address.
const DEPLOY_FILE = 'panel-deploy.json';
const BIND_MARK = '#codiscuss-bind=';

function deploy_settings(data) {
  try { return JSON.parse(readFileSync(join(data, DEPLOY_FILE), 'utf8')); } catch { return {}; }
}

/** The folder above a deployment config that has wrangler installed, so npx finds it rather than downloading it. */
function wrangler_folder(config) {
  for (let folder = dirname(config); ; folder = dirname(folder)) {
    if (existsSync(join(folder, 'node_modules', 'wrangler'))) return folder;
    if (dirname(folder) === folder) return dirname(config);
  }
}

/**
 * On the computer that deployed the online site: make an access code for a hosting computer, the site's address with a
 * one-time binding token (`codiscuss token`, written to the site's database through wrangler, in a child process so the
 * panel keeps answering). A new code makes an unused earlier one invalid. The config and site are remembered.
 */
function make_access_code(data, { config, site }) {
  const saved = deploy_settings(data);
  const path = resolve(String(config || saved.config || '').trim() || '.');
  if (!existsSync(path) || !/\.jsonc?$/.test(path)) throw panel_error('找不到线上站点的部署配置：填写源码仓库里 .wrangler\\deploy\\wrangler.jsonc 的完整路径');
  let origin;
  try { origin = new URL(String(site || saved.site || bound_site(data)?.site || '').trim()).origin; } catch { throw panel_error('线上网站地址格式不对，例如 https://xxx.pages.dev'); }
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [installed_script('codiscuss.mjs'), 'token', '--config', path], { cwd: wrangler_folder(path), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { errors += chunk; });
    child.on('error', fail);
    child.on('exit', code => {
      const token = output.match(/^([0-9a-f]{32,})$/m)?.[1];
      if (code !== 0 || !token) return fail(errors.trim() ? new Error(errors.trim().split(/\r?\n/).pop()) : panel_error('没有生成绑定令牌'));
      write_settings(join(data, DEPLOY_FILE), { config: path, site: origin });
      done({ code: `${origin}/${BIND_MARK}${token}`, site: origin });
    });
  });
}

/**
 * On a hosting computer: join the online relay with an access code, each step reported. Bind to the site (unless bound
 * already), take the entry address the site gives, then turn the relay on, which starts what it needs.
 */
async function join_relay(data, text) {
  const value = String(text || '').trim();
  const at = value.indexOf(BIND_MARK);
  if (at < 0) throw panel_error('接入码不对：应是部署线上站点的电脑上生成的一整串，形如 https://xxx.pages.dev/#codiscuss-bind=…');
  const site = new URL(value.slice(0, at)).origin, token = value.slice(at + BIND_MARK.length);
  const steps = [];
  if (bound_site(data)?.site === site) steps.push(t('已接入 {value1}', { value1: site }));
  else { await connect_site(data, site, token); steps.push(t('已接入 {value1}', { value1: site })); }
  const entry_url = await site_entry_url(site);
  await set_relay_url(data, entry_url);
  steps.push(t('入口地址 {value1}', { value1: entry_url }));
  const overview = await set_entry_way(data, 'relay', true);
  steps.push(t('已开启自建中转'));
  return { steps, entry: overview };
}

/** The entry Worker address an online site gives (`GET /api/entry`). */
async function site_entry_url(site) {
  const answer = await fetch_outside(`${site}/api/entry`, OUTSIDE_TIMEOUT_MS);
  const given = await answer.json().catch(() => ({}));
  if (!given.entry_url) throw panel_error('{value1} 没有提供入口地址：请部署线上站点的人在部署配置里设置 ENTRY_URL 并重新发布', { value1: site });
  return given.entry_url;
}

/** Save the relay's entry address after checking that it answers as one. */
async function set_relay_url(data, url) {
  const origin = String(url || '').trim().replace(/\/+$/, '');
  const checked = await relay_status(origin, bound_site(data)?.machine);
  if (!checked.reachable) throw panel_error('{value1} 不是共议的入口 Worker，或现在连不上', { value1: origin });
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
    child.on('exit', code => (code === 0 ? done(bound_site(data)) : fail(errors.trim() ? new Error(errors.trim().split(/\r?\n/).pop()) : panel_error('绑定失败（退出码 {value1}）', { value1: code }))));
  });
}

/** Bind this computer to the owner's online site; it has one at a time, and the address must be such a site. */
async function bind_online_site(data, { site, setup_key }, connect) {
  const bound = bound_site(data);
  // An access code (`站点/#codiscuss-bind=令牌`) carries both, so one paste binds (user 2026-11-19, #5469).
  const text = String(site || '').trim(), at = text.indexOf(BIND_MARK);
  if (at >= 0) { setup_key = text.slice(at + BIND_MARK.length); site = text.slice(0, at); }
  let origin;
  try { origin = new URL(String(site || '').trim()).origin; } catch { throw panel_error('线上网站地址格式不对，例如 https://xxx.pages.dev'); }
  if (bound && bound.site !== origin) throw panel_error('这台电脑已绑定 {value1}，请先解绑', { value1: bound.site });
  const result = await connect(data, origin, setup_key);
  if (!result) throw panel_error('这个地址不是共议线上站点：{value1}', { value1: origin });
  return result;
}

/** Leave the online site: its paired devices can no longer reach this computer. The hosted accounts' address depends on it. */
async function disconnect_site(data) {
  const bound = bound_site(data);
  if (!bound) return { disconnected: '' };
  if (entry_settings(data).relay_enabled) throw panel_error('托管账号入口的自建中转还开着，请先关闭它');
  // The accounts bound under this computer are released first (a failure stops here, to be retried); those reached on
  // the owner's domain do not use the online site (#5617, #5660).
  for (const [name, record] of Object.entries(read_account_sites(data))) if (!record.direct) await change_external(data, name, false);
  save_site_connection(data, bound.site);
  return { disconnected: bound.site };
}

// ---- Hosted accounts on the online site (#5494) ----

const ACCOUNT_SITES_FILE = 'account-sites.json';

/** The accounts this panel bound to the online site: { name: { site, machine, at } }; their own files are sealed for them. */
function read_account_sites(data) {
  try { return JSON.parse(readFileSync(join(data, ACCOUNT_SITES_FILE), 'utf8')); } catch { return {}; }
}

/**
 * Let a hosted account invite external experts, or stop. On: this computer, bound to the online site, asks it for a
 * one-time child token and binds the account's own service home with it, so the account is a computer of its own there
 * and every external-member protection works as for the owner. Off: the site releases that computer first (its slot
 * under the cap comes back; a failure stops here for a retry), then the account's own binding is removed. An account
 * being removed lets go of the record whatever happens. Off by default.
 */
async function set_account_external(data, name, on, bind = bind_account_site, { removing = false, direct = direct_account_site } = {}) {
  const sites = read_account_sites(data);
  const save = () => write_settings(join(data, ACCOUNT_SITES_FILE), sites);
  if (!on) {
    const record = sites[name];
    if (!record) return { external: false };
    if (record.direct) {
      // Reached on the owner's domain: the entry stops answering for it first, then its direct identity goes.
      write_direct_accounts(data, Object.fromEntries(Object.entries(read_direct_accounts(data)).filter(([, account]) => account !== name)));
      try { await direct(data, name, { site: record.site, remove: true }); } catch (error) { if (!removing) throw error; }
      delete sites[name];
      save();
      return { external: false };
    }
    // The site's slot first: a failure stops here so it can be retried, never leaving a slot held with nothing bound.
    // An account being removed lets go of the record whatever happens, or the owner could never unbind afterwards.
    try { await release_account_site(data, record); } catch (error) { if (!removing) throw error; }
    try { await bind(data, name, { site: record.site, unbind: true }); } catch (error) { if (!removing) throw error; }
    delete sites[name];
    save();
    return { external: false };
  }
  // With the owner's domain on, external members reach the account through it, never the online relay (#5588).
  const settings = entry_settings(data);
  const wants_direct = Boolean(settings.tunnel_enabled && settings.tunnel?.host);
  // Already on: the same way stays; the other way is turned off first, so no slot or identity is left behind (#5617).
  if (sites[name]) {
    if (Boolean(sites[name].direct) === wants_direct) return { external: true, site: sites[name].site };
    await set_account_external(data, name, false, bind, { direct });
    delete sites[name];
  }
  if (wants_direct) {
    const site = `https://${settings.tunnel.host}`;
    const result = await direct(data, name, { site });
    if (!/^[0-9a-f]{32}$/.test(String(result.machine || ''))) throw panel_error('没有建立直连身份');
    write_direct_accounts(data, { ...Object.fromEntries(Object.entries(read_direct_accounts(data)).filter(([, account]) => account !== name)), [result.machine]: name });
    sites[name] = { site, machine: result.machine, direct: true, at: Date.now() };
    save();
    return { external: true, site };
  }
  const bound = bound_site(data);
  if (!bound) throw panel_error('这台电脑未绑定自建中转，请在管理面板“本机 → 自建中转”处绑定');
  const answer = await fetch_outside(`${bound.site}/api/machines/${bound.machine}/setup`, OUTSIDE_TIMEOUT_MS,
    { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Machine-Token': machine_links(data).sites[bound.site].token }, body: '{}' });
  const given = await answer.json().catch(() => ({}));
  if (answer.status === 404) throw panel_error('{value1} 的线上网站版本过旧，请部署方更新线上网站后再试', { value1: bound.site });
  if (!answer.ok || !given.setup_key) throw panel_error('线上网站没有签发绑定令牌：{value1}', { value1: given.error || answer.status });
  let result;
  try { result = await bind(data, name, { site: bound.site, setup_key: given.setup_key }); }
  catch (error) {
    // The website words a used or expired token for someone running codiscuss token by hand.
    if (String(error.message).includes('绑定令牌错误或已用过')) throw panel_error('绑定令牌已过期，请重试');
    throw error;
  }
  sites[name] = { site: bound.site, machine: result.machine || '', at: Date.now() };
  save();
  return { external: true, site: bound.site };
}

/**
 * Every hosted account can invite external experts, with no switch (user 2026-11-19, #5660): reached on the owner's
 * domain while it is on, else bound under this computer's online site while that is bound, else neither. Run every
 * minute and after changes that affect the way: an account whose record no longer fits (the domain changed or went off,
 * the account is gone) is taken down, and accounts without one get one. A failure is retried after a pause.
 */
const reconcile_failures = new Map();
const RECONCILE_RETRY_MS = 10 * 60 * 1000;
// Every change to an account's way runs in one queue, so a reconcile and a direct call (removal, isolation, leaving the
// online site) never read and write account-sites.json across each other's waits (#5666).
let external_queue = Promise.resolve(), reconcile_queued = false;
function serial(task) {
  const run = external_queue.then(task, task);
  external_queue = run.catch(() => {});
  return run;
}
/** Take an account's way down or set it up, in the queue. */
export function change_external(data, name, on, options) {
  return serial(() => set_account_external(data, name, on, undefined, options));
}
export function reconcile_external(data, options = {}) {
  if (reconcile_queued) return external_queue;
  reconcile_queued = true;
  return serial(() => { reconcile_queued = false; return reconcile_now(data, options); });
}
async function reconcile_now(data, { now = Date.now, log = message => process.stderr.write(`${message}\n`) } = {}) {
  if (!hosting_enabled(data)) return;
  const accounts = read_accounts(data), settings = entry_settings(data), bound = bound_site(data);
  const direct_site = settings.tunnel_enabled && settings.tunnel?.host ? `https://${settings.tunnel.host}` : '';
  for (const [name, record] of Object.entries(read_account_sites(data))) {
    const fits = accounts[name] && (record.direct ? record.site === direct_site : !direct_site && bound?.site === record.site);
    if (fits) continue;
    // Only a removed account lets go of its record whatever happens; an existing one keeps it until its own side is
    // really taken down, so no identity is left behind that invites would still use (#5666).
    try { await set_account_external(data, name, false, undefined, { removing: !accounts[name] }); }
    catch (error) { log(t('外部专家入口没有拆除（{value1}）：{value2}', { value1: name, value2: error.message })); }
  }
  if (!direct_site && !bound) return;
  for (const name of Object.keys(accounts)) {
    if (read_account_sites(data)[name] || now() - (reconcile_failures.get(name) || 0) < RECONCILE_RETRY_MS) continue;
    try { await set_account_external(data, name, true); reconcile_failures.delete(name); }
    catch (error) { reconcile_failures.set(name, now()); log(t('外部专家入口没有建立（{value1}）：{value2}', { value1: name, value2: error.message })); }
  }
}

/** Which computer id is which account on the owner's domain, for the sign-in entry (gateway/direct.mjs). */
function read_direct_accounts(data) {
  try { return JSON.parse(readFileSync(join(data, DIRECT_ACCOUNTS_FILE), 'utf8')); } catch { return {}; }
}
function write_direct_accounts(data, mapping) {
  write_settings(join(data, DIRECT_ACCOUNTS_FILE), mapping);
}

/** Create or remove an account's direct identity, as its own Windows user when it has one (the identity is sealed for it). */
async function direct_account_site(data, name, { site, remove = false }) {
  const home = instance_home(data, name);
  if (read_os_users(data)[name]) return account_env(data, name, 'direct', { home, site, remove });
  const { create_direct_link, remove_direct_link } = await import('./remote_launch.mjs');
  if (remove) { remove_direct_link(home); return { ok: true }; }
  return { machine: create_direct_link(home, site).id };
}

/** Ask the online site to let go of an account's computer; a site without this (older) or without it any more is done. */
async function release_account_site(data, record) {
  const owner = machine_links(data).sites[record.site];
  if (!owner?.token || !record.machine) return;
  const answer = await fetch_outside(`${record.site}/api/machines/${owner.id}/release`, OUTSIDE_TIMEOUT_MS,
    { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Machine-Token': owner.token }, body: JSON.stringify({ machine: record.machine }) });
  if (answer.ok || answer.status === 404) return;
  const given = await answer.json().catch(() => ({}));
  throw panel_error('线上网站没有释放这个账号：{value1}', { value1: given.error || answer.status });
}

/**
 * Bind or unbind one account's service home without starting anything (its instance re-reads bindings by itself), as
 * the account's own Windows user when it has one: the binding file is sealed for whoever writes it.
 */
async function bind_account_site(data, name, { site, setup_key = '', unbind = false }) {
  const home = instance_home(data, name);
  if (read_os_users(data)[name]) return account_env(data, name, 'site', { home, site, setup_key, unbind });
  if (unbind) { save_site_connection(home, site); return { ok: true }; }
  const { bind_machine } = await import('./discussion_local.mjs');
  return { machine: await bind_machine(home, site, setup_key) };
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
    const path = join(plain_instance_home(data, name), OPERATOR_EVENTS_FILE);
    let read = null;
    // The outbox is in the account's own folder: a link anywhere on its path (the file, or a folder above it that the
    // account replaced with a junction) is not followed, so only a file really inside that folder is read.
    try { read = existsSync(path) && same_path(realpathSync.native(path), path) ? outbox_failures(path, marks[name] || {}) : null; }
    catch (error) { process.stderr.write(t(`托管账号 {value1} 的失败记录读不了：{value2}
`, { value1: name, value2: error.message })); continue; }
    if (!read || (read.mark.offset === marks[name]?.offset && read.mark.head === marks[name]?.head)) continue;
    const { events, mark } = read;
    if (events.length) {
      const listed = events.slice(-RELAY_LISTED).map(event => `「${event.title}」${event.member}：${event.reason}`);
      let result = null;
      try {
        // Keyed by the last failure it reports, so a later notice is never mistaken for an earlier one.
        result = await send(data, { key: `operator-${name}-${events.at(-1).id}`, room: { title: t('托管账号 {value1}', { value1: name }) },
          paragraphs: [t('{value1} 次执行失败{value2}：', { value1: events.length, value2: events.length > RELAY_LISTED ? t('，最近 {value1} 次', { value1: RELAY_LISTED }) : '' }), ...listed,
            t('客户那边看到的是失败卡片和重试按钮；登录失效、额度用完这类问题要你在管理面板处理。')] });
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

// The panel page's <title> (web/admin.html, the same in every language); its own window carries it, which is how an open
// window is found again. Not translated: a translated title missed the open window and opened another one beside it.
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

/**
 * The Edge arguments that reopen the panel at the size the owner left it.
 *
 * Edge records an app window's size under app_window_placement when it closes but does not apply it on the next --app
 * launch (seen on Edge 157), so the recorded size is passed back. The position is not: Edge does not keep a window given
 * --window-position on screen, and the monitor it was recorded on may be gone.
 *
 * Args:
 *   profile: The panel window's Edge profile directory.
 *
 * Returns:
 *   The window arguments for Edge; the default size until Edge has recorded one.
 */
export function panel_window_args(profile) {
  let placement = null;
  // The record's key is the app name "127.0.0.1_/", which Edge splits into nested objects at each dot.
  try { placement = JSON.parse(readFileSync(join(profile, 'Default', 'Preferences'), 'utf8')).browser.app_window_placement['127']['0']['0']['1_/']; } catch { placement = null; }
  if (placement?.maximized) return ['--start-maximized'];
  const width = placement?.right - placement?.left, height = placement?.bottom - placement?.top;
  return [`--window-size=${width > 0 && height > 0 ? `${width},${height}` : WINDOW_SIZE}`];
}

function launch_panel_window(data, url) {
  const edge = EDGE_PATHS.find(path => existsSync(path));
  if (!edge) return open_browser(url);
  const profile = join(data, 'panel-window');
  spawn(edge, [`--app=${url}`, `--user-data-dir=${profile}`, ...panel_window_args(profile), '--no-first-run', '--no-default-browser-check', '--lang=zh-CN', '--disable-features=Translate,msTranslate'],
    { detached: true, stdio: 'ignore', windowsHide: false }).unref();
}

// The window opens on the page's own address: Edge records an app window's size under the path it was opened on, and
// panel_window_args reads the record for /.
function panel_url(state) {
  return `http://127.0.0.1:${state.port}/?key=${state.key}`;
}

/** The owner's own site, for the icon's second entry. */
function site_url(data) {
  try { return `http://127.0.0.1:${JSON.parse(readFileSync(join(data, 'local-settings.json'), 'utf8')).port || 8765}/`; }
  catch { return 'http://127.0.0.1:8765/'; }
}

/** Send a read-only storage inventory request via this panel owner's local website. */
async function panel_storage_steward(data) {
  const { href } = new URL('api/local/steward-request', site_url(data));
  const key_file = owner_key_file(data);
  const response = await site_fetch(href, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(STORAGE_STEWARD_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/json', 'X-CoDiscuss-Local': '1' },
    body: JSON.stringify({ skill: 'codiscuss-draft-cleanup', lang: resolve_locale(),
      context: t('请盘点共议占用并报告结果，不要删除任何文件。') }),
  }, existsSync(key_file) ? { key_file } : undefined);
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error), { status: response.status, error_text: result.error_text });
  return { room_id: result.room_id, message_id: result.message_id };
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
  const child = spawn(process.execPath, [installed_script('discussion_local.mjs'), command], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, env: { ...process.env, DISCUSS_SERVICE_HOME: data } });
  // Keep the reason it prints (the last lines of stderr) so the failure says why, not just its exit code.
  let errors = '';
  child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-4000); });
  return new Promise((done, fail) => {
    child.on('error', fail);
    child.on('exit', code => code === 0 ? done() : fail(panel_error('{value1} {value2} 失败（退出码 {value3}）：{value4}',
      { value1: 'codiscuss local', value2: command, value3: code, value4: errors.trim().split(/\r?\n/).slice(-3).join(' ') })));
  });
}

/** Whether the owner turned on hosting (setup's "托管管理"); only then does the panel show the hosting pages. */
export function hosting_enabled(data) {
  try { return JSON.parse(readFileSync(join(data, 'local-settings.json'), 'utf8')).hosting === true; } catch { return false; }
}

/** Run the server and the icon until the icon's "close service" entry or `panel stop`. */
function run_panel(data, port) {
  const running = read_state(data);
  if (running && running.pid !== process.pid && alive(running.pid)) throw panel_error('管理面板已在运行：http://127.0.0.1:{value1}', { value1: running.port });
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
  if (hosting_enabled(data) && entry_settings(data).running) start_entry(data).catch(error => process.stderr.write(t(`入口没有启动：{value1}
`, { value1: error.message })));
  // The entry's outside address runs on its own; the panel keeps it as set now and every minute (restarted if it stopped
  // or its settings changed, stopped when the entry is off).
  const keep = () => {
    server.recover_instances().catch(error => process.stderr.write(t('托管实例巡检失败：{reason}\n', { reason: error.message })));
    keep_tunnel(data).catch(error => process.stderr.write(t(`隧道：{value1}
`, { value1: error.message }))).then(() => reconcile_external(data)).catch(() => {});
  };
  keep();
  const keeper = setInterval(keep, TUNNEL_CHECK_MS);
  // Hosted accounts' failures reach the owner's Weixin; one pass at a time.
  let relaying = false;
  const finisher = setInterval(() => finish_update(data).catch(error => process.stderr.write(t(`更新收尾失败：{value1}
`, { value1: error.message }))), UPDATE_FINISH_CHECK_MS);
  const relay = setInterval(() => {
    if (relaying) return;
    relaying = true;
    relay_operator_events(data).catch(error => process.stderr.write(t(`失败通知未转发：{value1}
`, { value1: error.message }))).finally(() => { relaying = false; });
  }, RELAY_MS);
  server.listen(port, '127.0.0.1', () => {
    writeFileSync(state_path(data), JSON.stringify(state), { mode: 0o600 });
    process.stdout.write(t(`管理面板已启动：http://127.0.0.1:{value1}
`, { value1: port }));
    finish_update(data).catch(error => process.stderr.write(t(`更新收尾失败：{value1}
`, { value1: error.message })))
      // After an update's own finish, which already synced the copy it installed.
      .then(() => sync_stale_copy(data)).catch(error => process.stderr.write(t('程序副本没有自动同步：{value1}\n', { value1: error.message })));
  });
  // The icon that ships with the package, the same on every computer.
  const icon = join(ROOT, 'web', 'codiscuss.ico');
  // A tray that fails to start must not leave `tray` uninitialised: shutdown (and so every update) reads it.
  let tray = null;
  try { tray = show_tray({ title: t('共议'), icon_path: existsSync(icon) ? icon : '', window_title: WINDOW_TITLE,
    host: join(data, 'launcher', '共议.exe'), on_action: action => {
    if (action === 'open') open_panel_window(data, panel_url(state), false);
    if (action === 'site') open_browser(signed_site_url(site_url(data), data));
    // Restarting and closing take seconds and show nothing of their own, so the icon says what is happening.
    if (action === 'restart') {
      tray.notify('busy', t('正在重启共议服务…'));
      run_owner_service(data, 'stop').then(() => run_owner_service(data, 'start'))
        .then(() => tray.notify('done', t('共议服务已重启')), error => tray.notify('error', t('重启失败：{value1}。可在命令行运行 codiscuss local open', { value1: error.message })));
    }
    if (action === 'stop') {
      tray.notify('busy', t('正在关闭共议服务…'));
      run_owner_service(data, 'stop')
        .then(() => tray.notify('done', t('共议服务已关闭')), error => tray.notify('error', t('关闭失败：{value1}', { value1: error.message })))
        // The note goes with the icon, so it stays a moment before the icon closes.
        .finally(() => setTimeout(shutdown, 2500));
    }
  } }); } catch (error) {
    process.stderr.write(t(`任务栏图标没有启动：{value1}
`, { value1: error.message }));
  }
  function shutdown(exit = true) {
    clearInterval(relay);
    clearInterval(finisher);
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
  // The failure message below points here, so the panel's output (its startup errors among it) has to land in this file.
  const log = join(data, 'admin-panel.log');
  const output = openSync(log, 'w');
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'run', '--port', String(port)],
    { detached: true, stdio: ['ignore', output, output], windowsHide: true, env: { ...process.env, CODISCUSS_GATEWAY_HOME: data } });
  closeSync(output);
  child.unref();
  for (let waited = 0; waited < 10_000; waited += 200) {
    await new Promise(done => setTimeout(done, 200));
    const state = read_state(data);
    if (state?.pid === child.pid) return state;
  }
  throw panel_error('管理面板没有启动，可运行 codiscuss panel run 查看原因（日志 {value1}）', { value1: log });
}

export async function panel_main(args) {
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: { port: { type: 'string' }, data: { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
  const command = positionals[0] || 'open';
  if (values.help) return process.stdout.write(HELP);
  const data = data_home(values.data), port = Number(values.port || DEFAULT_PORT);
  if (command === 'run') return run_panel(data, port);
  if (command === 'start') { const state = await start_panel(data, port); return process.stdout.write(t(`管理面板：http://127.0.0.1:{value1}
`, { value1: state.port })); }
  if (command === 'open') {
    const state = await start_panel(data, port);
    // An icon from 0.4.28 or 0.4.29 may run without a panel; it is replaced by one that has it.
    if (!state.port) throw panel_error('正在运行的任务栏图标来自旧版本：运行 codiscuss panel stop 后再运行 codiscuss panel open');
    open_panel_window(data, panel_url(state));
    return;
  }
  if (command === 'stop') {
    const state = read_state(data);
    if (state && alive(state.pid)) process.kill(state.pid);
    rmSync(state_path(data), { force: true });
    return process.stdout.write(t(`管理面板已停止
`));
  }
  throw new Error(HELP);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  panel_main(process.argv.slice(2)).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}

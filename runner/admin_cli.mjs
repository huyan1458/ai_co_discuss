/**
 * `codiscuss admin`: every operation of the management panel from a command line (for instance over SSH), through the
 * running panel's own interface, so a command does exactly what the same click does.
 *
 * It opens the panel the way the taskbar icon does, with the key in the owner's service directory
 * (`admin-panel.json`, readable by the owner only), so only the computer's owner can use it. Browser windows the panel
 * opens appear in the owner's desktop session, not in this terminal. Steps that need administrator rights run in this
 * command when it already has them (an elevated terminal, an administrator's SSH session), through the panel's own
 * operations; otherwise the panel asks on the desktop.
 *
 * Starting, stopping, restarting and updating work without the panel running: `start` launches everything in the owner's
 * desktop session (from an SSH session, through a one-time scheduled task that runs there), so the taskbar icon appears
 * and nothing ends when the SSH connection closes; `stop` ends the panel with its icon, the entry, the tunnel and the
 * owner's service, keeping every setting, so the next `start` brings back what was running.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { data_home, entry_settings, entry_status, stop_entry } from '../gateway/gateway.mjs';
import { local_status } from './discussion_local.mjs';
import { relay_health_text } from './relay_health_text.mjs';
import { stop_tunnel } from './hosting_tunnel.mjs';
import { launcher_path } from './launcher.mjs';
import { running_elevated } from './os_users.mjs';
import { t } from './i18n.mjs';

const STATE_FILE = 'admin-panel.json';
const OWNER = 'owner';
// What needs administrator rights (creating or removing an account's Windows user, which registers its instance task).
const ELEVATED_PATHS = /^(accounts\/[^/]+\/os-user(\/remove)?|drives\/restrict)$/;
const LOGIN_WAIT_MS = 60_000, UPDATE_WAIT_MS = 10 * 60_000, START_WAIT_MS = 90_000, POLL_MS = 1500;
const RUNNER = dirname(fileURLToPath(import.meta.url));
const DESKTOP_TASK = 'CoDiscuss start (one time)';

export const HELP = t(`用法：codiscuss admin <命令> [参数]（与管理面板的操作一一对应；除启动与退出外，需管理面板正在运行）
需要管理员权限的步骤（建或删 Windows 用户），在管理员终端或管理员的 SSH 会话里直接执行；否则在电脑桌面上弹出确认。

启动与退出（不需要面板在运行）
  start                                    启动共议：服务、管理面板与任务栏图标、登录入口与隧道（在桌面会话里启动）
  stop                                     彻底退出：管理面板与图标、登录入口、隧道、共议服务；托管账号的实例照常运行
  restart                                  stop 后 start
  update [check]                           检查更新；不带 check 时安装最新版（面板未运行时先启动）并等待每一步结果

本机
  status [--full]                          概览：服务、中转状态、版本、开机自启、登录入口、托管账号；--full 输出面板的完整状态
  service start|stop|restart               只启停共议服务（网站与讨论服务）
  autostart on|off                         登录 Windows 时自动启动

管理员入口
  site status                              本地网页与线上网站的地址
  site connect <接入码|站点> [绑定令牌]     绑定线上网站（管理员外出、邀请外部专家用）；在部署该网站的电脑上只填站点即可
  site disconnect                          解绑线上网站，已配对的设备不能再连到这台电脑
  site reconnect                           立即重连已绑定网站的中转

登录入口与访问方式（需打开托管管理）
  entry start|stop                         启动或停止登录入口
  entry open|close relay|tunnel            开启或关闭访问方式：线上网站 | 自有域名，两种可同时开启
  entry join <接入码>                       用接入码接入线上站点并开启线上网站
  entry code [--config <wrangler.jsonc>] [--site <地址>]   在部署线上站点的电脑上生成接入码（不填用上次的）
  entry tunnel <域名> [隧道名]              设置自有域名（Cloudflare 隧道），输出授权链接；域名须已托管在 Cloudflare
  entry tunnel status                      查看自有域名设置的进度
  runtime sync                             同步隔离账号的程序副本
  drives restrict                          只允许隔离账号用系统盘：其他固定磁盘对它们的 Windows 用户拒绝访问（需管理员权限，之后重启它们的实例）

托管账号
  account list
  account add <名> [--no-isolate] [--no-start]   创建、隔离、初始化 AI 环境、开启入口保护、启动；输出一次性密码。
                                           中途失败时解决后重新执行同一命令，从缺少的步骤接着做
  account start|stop|disable|enable|remove|password <名>
  account isolate|unisolate|protect|unprotect <名>

命令行登录（目标 owner 为管理员自己，否则为托管账号名）
  login status <目标>                       各程序的登录状态，以及每个程序可用的登录方式
  login set <目标> <claude|codex> <方式> --set 字段=值 ...   如 login set alice claude setup_token --set token=sk-ant-oat01-…
  login start <目标> <程序> <方式>          浏览器登录：输出链接，之后用 login submit 提交授权码或回调地址
  login submit <作业> <文本>  /  login progress <作业>  /  login cancel <作业>
  logout <目标> <程序>

API 密钥、技能、工作流、系统提示词（目标同上）
  key list <目标>  /  key add <目标> --base-url <地址> --key <密钥>  /  key remove <目标> <编号>
  skill library  /  skill import <文件夹或.zip>  /  skill delete <名>
  skill list <目标>  /  skill install <目标> <名>...  /  skill remove <目标> <名>...
  workflow list <目标>  /  workflow install <目标>  /  workflow update <目标>
  prompt get <账号>  /  prompt set <账号> --file <文件>   托管账号的系统提示词（管理员本人的成员用 codiscuss launch prompts）
  prompt default get  /  prompt default set --file <文件>             新托管账号的默认系统提示词

结果以 JSON 输出。--data 指定管理员服务目录（默认 ~/.codiscuss）。
`) + t('  room-links A    查看父子房间') + '\n' + t('  storage [clean]                          查看存储用量，或清理已确认结束的执行临时目录') + '\n'
  + t('  account add <名> --project-data-root <目录>   将新账号的项目、工作区和成员草稿放在指定目录') + '\n'
  + t('  account migrate-data <名> --project-data-root <目录>   停止实例并迁移项目数据') + '\n'
  + t('  account migration-backups <名>   查看各迁移备份的位置与字节数') + '\n'
  + t('  account release-backup <名> <迁移编号> <目录类别> --confirm   停止实例并释放指定备份') + '\n';

/** A client of the running panel: enters with the owner key and keeps the session for the requests that follow. */
export async function panel_client(data) {
  let state;
  try { state = JSON.parse(readFileSync(join(data, STATE_FILE), 'utf8')); } catch { state = null; }
  if (!state?.port || !state?.key) throw new Error(t('管理面板没有在运行：在这台电脑的桌面上运行 codiscuss panel open，或从任务栏图标打开'));
  const origin = `http://127.0.0.1:${state.port}`;
  let entered;
  try { entered = await fetch(`${origin}/enter?key=${state.key}`, { redirect: 'manual', signal: AbortSignal.timeout(10_000) }); }
  catch { throw new Error(t('管理面板没有响应：在这台电脑的桌面上运行 codiscuss panel open')); }
  const cookie = (entered.headers.get('set-cookie') || '').split(';')[0];
  if (entered.status !== 302 || !cookie) throw new Error(t('管理面板拒绝了钥匙（面板可能刚重启）：稍后重试'));
  return async function call(path, body) {
    const init = { headers: { cookie }, signal: AbortSignal.timeout(15 * 60_000) };
    if (body !== undefined) Object.assign(init, { method: 'POST', body: JSON.stringify(body),
      headers: { cookie, origin, 'x-codiscuss-panel': '1', 'content-type': 'application/json' } });
    const response = await fetch(`${origin}/api/${path}`, init);
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || t('管理面板返回 {value1}', { value1: response.status }));
    return result;
  };
}

const wait = ms => new Promise(done => setTimeout(done, ms));
const need = (value, usage) => { if (!value) throw new Error(t('缺少参数：{value1}', { value1: usage })); return value; };
const is_owner = target => target === OWNER;

/**
 * Create an account the way the panel's wizard does, step by step. Run again for an account that exists, it goes on
 * from the first step missing; the password is reported once created, even if a later step fails.
 */
async function add_account(call, name, { isolate, start, project_data_root }) {
  const steps = [];
  const existing = (await call('state')).accounts?.find(item => item.name === name);
  if (existing && project_data_root && (!existing.project_data_root || relative(existing.project_data_root, project_data_root))) {
    throw new Error(t('已有账号使用不同的数据目录，请用 account migrate-data 显式迁移。'));
  }
  let password = '';
  if (existing) steps.push(t('账号已存在，从缺少的步骤接着做（密码不变；需要新密码用 account password）'));
  else { password = (await call('accounts', { name, ...(project_data_root ? { project_data_root } : {}) })).password; steps.push(t('已创建账号与文件夹')); }
  const report = extra => ({ name, ...(password ? { password } : {}), steps, ...extra });
  try {
    if (isolate && !existing?.os_user) {
      await call(`accounts/${name}/os-user`, {});
      steps.push(running_elevated() ? t('已创建独立的 Windows 用户') : t('已创建独立的 Windows 用户（电脑上的管理员确认已通过）'));
    }
    if (isolate) {
      const state = await call('state');
      if (!state.clis?.app || !state.clis?.python) { await call('clis/install', {}); steps.push(t('已安装隔离账号的程序副本')); }
    }
    await call(`accounts/${name}/env/init`, {});
    steps.push(isolate ? t('已初始化 AI 环境') : t('已安装随包工作流'));
    if (process.platform === 'win32' && !existing?.protected) { await call(`accounts/${name}/protect`, { on: true }); steps.push(t('已开启入口保护')); }
    if (start && !existing?.running) { await call(`accounts/${name}/start`, {}); steps.push(t('已启动实例')); }
  } catch (error) {
    const rights = /管理员权限/.test(error.message) ? t('在管理员终端或管理员的 SSH 会话里执行，或在电脑桌面上确认提权，') : '';
    return report({ failed: error.message, next: t('{value1}解决后重新执行 codiscuss admin account add {value2}，会从这一步接着做', { value1: rights, value2: name }) });
  }
  return report({});
}

const ACCOUNT_ACTIONS = { start: 'start', stop: 'stop', disable: 'disable', enable: 'enable', remove: 'remove', password: 'password',
  isolate: 'os-user', unisolate: 'os-user/remove' };

async function account_command(call, [action, name, id, kind], values) {
  if (action === 'list') return (await call('state')).accounts;
  need(name, t('account {value1} <名>', { value1: action }));
  if (action === 'add') return add_account(call, name, { isolate: !values['no-isolate'], start: !values['no-start'], project_data_root: values['project-data-root'] });
  if (action === 'migrate-data') return call(`accounts/${name}/migrate-data`, { project_data_root: need(values['project-data-root'], '--project-data-root') });
  if (action === 'migration-backups') return call(`accounts/${name}/migration-backups`);
  if (action === 'release-backup') return call(`accounts/${name}/release-backup`, { id, kind, confirm: values.confirm === true });
  if (action === 'protect' || action === 'unprotect') return call(`accounts/${name}/protect`, { on: action === 'protect' });
  if (!ACCOUNT_ACTIONS[action]) throw new Error(HELP);
  return call(`accounts/${name}/${ACCOUNT_ACTIONS[action]}`, {});
}

/** Start a browser sign-in and wait until its link (or its end) is there. */
async function start_login(call, target, cli, method) {
  const { id } = await call(`logins/${target}/${cli}/start`, { method });
  for (let waited = 0; waited < LOGIN_WAIT_MS; waited += POLL_MS) {
    await wait(POLL_MS);
    const progress = await call(`login-jobs/${id}`);
    if (progress.link || progress.ended) return { job: id, ...progress };
  }
  return { job: id, link: '', note: t('一分钟内没有出现登录链接，可用 login progress 继续查看') };
}

async function login_command(call, [action, ...rest], values) {
  const target = (name) => (is_owner(name) ? '_' : need(name, t('目标')));
  if (action === 'status') {
    const [status, state] = await Promise.all([call(`logins/${target(rest[0])}`), call('state')]);
    return { status, methods: login_methods(state.login_methods) };
  }
  if (action === 'set') {
    const [who, cli, method] = rest;
    const fields = Object.fromEntries((values.set || []).map(pair => { const at = pair.indexOf('='); return [pair.slice(0, at), pair.slice(at + 1)]; }));
    return call(`logins/${target(who)}/${need(cli, t('程序'))}/apply`, { method: need(method, t('方式')), ...fields });
  }
  if (action === 'start') return start_login(call, target(rest[0]), need(rest[1], t('程序')), need(rest[2], t('方式')));
  if (action === 'submit') return call(`login-jobs/${need(rest[0], t('作业'))}/submit`, { text: need(rest.slice(1).join(' '), t('文本')) });
  if (action === 'progress') return call(`login-jobs/${need(rest[0], t('作业'))}`);
  if (action === 'cancel') return call(`login-jobs/${need(rest[0], t('作业'))}/cancel`, {});
  throw new Error(HELP);
}

/** The ways each program signs in, as `login set` (filled-in fields) or `login start` (in a browser) takes them. */
function login_methods(methods = {}) {
  return Object.fromEntries(Object.entries(methods).map(([cli, list]) => [cli, list.map(item => (item.interactive
    ? t('{value1}：{value2}（login start <目标> {value3} {value4}）', { value1: item.key, value2: item.label, value3: cli, value4: item.key })
    : t('{value1}：{value2}（login set <目标> {value3} {value4} {value5}）', { value1: item.key, value2: item.label, value3: cli, value4: item.key, value5: (item.fields || []).map(field => `--set ${field}=…`).join(' ') })))]));
}

async function key_command(call, [action, who, ref], values) {
  const base = is_owner(need(who, t('目标'))) ? 'owner/keys' : `accounts/${who}/keys`;
  if (action === 'list') return call(base);
  if (action === 'add') return call(base, { base_url: need(values['base-url'], '--base-url'), api_key: need(values.key, '--key') });
  if (action === 'remove') return call(`${base}/remove`, { ref: need(ref, t('编号')) });
  throw new Error(HELP);
}

/** A skill folder as the panel's drop zone sends it: every file with its path and base64 content. */
function folder_files(folder) {
  const files = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else files.push({ path: relative(folder, path).replaceAll('\\', '/'), data: readFileSync(path).toString('base64') });
    }
  };
  walk(folder);
  return files;
}

async function skill_command(call, [action, who, ...names]) {
  if (action === 'library') return call('skill-library');
  if (action === 'import') {
    const path = need(who, t('文件夹或 .zip'));
    const body = statSync(path).isDirectory() ? { name: basename(path), files: folder_files(path) } : { zip: readFileSync(path).toString('base64') };
    return call('skill-library', body);
  }
  if (action === 'delete') return call(`skill-library/${need(who, t('名'))}/remove`, {});
  const base = is_owner(need(who, t('目标'))) ? 'owner/env' : `accounts/${who}/env`;
  if (action === 'list') return (await call(base)).skills;
  if (action === 'install' || action === 'remove') return call(`${base}/skills`, { [action]: names });
  throw new Error(HELP);
}

async function workflow_command(call, [action, who]) {
  const base = is_owner(need(who, t('目标'))) ? 'owner/workflows' : `accounts/${who}/workflows`;
  if (action === 'list') return call(base);
  if (action === 'install') return call(`${base}/install`, {});
  if (action === 'update') return call(`${base}/update`, {});
  throw new Error(HELP);
}

async function prompt_command(call, [action, who], values) {
  if (action === 'default') {
    if (who === 'get') return call('hosted-prompt');
    if (who === 'set') return call('hosted-prompt', { text: readFileSync(need(values.file, '--file'), 'utf8') });
    throw new Error(HELP);
  }
  need(who, t('目标'));
  // The admin's own CLAUDE.md / AGENTS.md are also read by plain AI windows, so CoDiscuss no longer writes them
  // (user 2026-11-25): the admin's members take their prompts from `codiscuss launch prompts` instead.
  if (is_owner(who)) throw new Error(t('管理员本人的系统提示词改用 codiscuss launch prompts 设置，不再修改 CLAUDE.md、AGENTS.md'));
  if (action === 'get') return { prompt: (await call(`accounts/${who}/env`)).prompt };
  if (action === 'set') return call(`accounts/${who}/env/prompt`, { text: readFileSync(need(values.file, '--file'), 'utf8') });
  throw new Error(HELP);
}

// ---- Starting and quitting, without the panel ----

function panel_state(data) {
  try { return JSON.parse(readFileSync(join(data, STATE_FILE), 'utf8')); } catch { return null; }
}

function alive(pid) {
  if (!(pid > 0)) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * Run a program in the owner's desktop session. From an SSH session (no desktop) a one-time scheduled task of the owner,
 * interactive only, runs it there and is removed again; elsewhere it is started directly.
 */
function start_in_desktop(program, args) {
  if (!(process.platform === 'win32' && process.env.SSH_CONNECTION)) {
    spawn(program, args, { stdio: 'ignore', windowsHide: true }).unref();
    return;
  }
  const quote = text => `'${String(text).replaceAll("'", "''")}'`;
  const script = `$ErrorActionPreference = 'Stop'
$action = New-ScheduledTaskAction -Execute ${quote(program)} -Argument ${quote(args.map(arg => `"${arg}"`).join(' '))}
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName ${quote(DESKTOP_TASK)} -Action $action -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName ${quote(DESKTOP_TASK)}
Start-Sleep -Seconds 3
Unregister-ScheduledTask -TaskName ${quote(DESKTOP_TASK)} -Confirm:$false`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  if (result.status !== 0) {
    throw new Error(t('没能在桌面会话里启动（需要这台电脑上有人登录着 Windows）：{value1}', { value1: (result.stderr || result.error?.message || '').trim().split(/\r?\n/)[0] }));
  }
}

/** Start everything as the 共议 launcher does at login, and wait until the service and the panel answer. */
async function start_all(data) {
  if (local_status(data).running && panel_state(data)?.pid && alive(panel_state(data).pid)) return { started: false, note: t('已在运行') };
  const launcher = launcher_path(data);
  if (existsSync(launcher)) start_in_desktop(launcher, ['--start']);
  else start_in_desktop(process.execPath, [join(RUNNER, 'discussion_local.mjs'), 'start']);
  for (let waited = 0; waited < START_WAIT_MS; waited += POLL_MS) {
    await wait(POLL_MS);
    const state = panel_state(data);
    if (local_status(data).running && state?.pid && alive(state.pid)) return { started: true, service: local_status(data).url, panel: state.port };
  }
  throw new Error(t('启动超过 {value1} 秒没有完成：查看 {value2} 与 admin-panel.log', { value1: START_WAIT_MS / 1000, value2: join(data, 'local', 'supervisor.log') }));
}

/** Quit everything but the hosted accounts' instances, keeping every setting (what ran comes back with the next start). */
async function stop_all(data) {
  const steps = [];
  const panel = panel_state(data);
  // The panel first: it would start the entry and the tunnel again.
  if (panel?.pid && alive(panel.pid)) { process.kill(panel.pid); steps.push(t('已关闭管理面板与任务栏图标')); }
  rmSync(join(data, STATE_FILE), { force: true });
  if ((await entry_status(data)).running) { await stop_entry(data); steps.push(t('已停止登录入口')); }
  if (entry_settings(data).tunnel) { stop_tunnel(data); steps.push(t('已停止隧道')); }
  if (local_status(data).pid || local_status(data).service_pid) {
    const result = spawnSync(process.execPath, [join(RUNNER, 'discussion_local.mjs'), 'stop'], { encoding: 'utf8', windowsHide: true,
      env: { ...process.env, DISCUSS_SERVICE_HOME: data }, timeout: 120_000 });
    if (result.status !== 0) throw new Error(t('共议服务没有停下：{value1}', { value1: (result.stderr || '').trim() }));
    steps.push(t('已停止共议服务'));
  }
  return { stopped: true, steps: steps.length ? steps : [t('原本就没有在运行')] };
}

/** Install the latest version and wait for the panel, which restarts on it, to report every step. */
async function update(call, data) {
  await call('update', {});
  for (let waited = 0; waited < UPDATE_WAIT_MS; waited += POLL_MS) {
    await wait(POLL_MS);
    try { const job = await (await panel_client(data))('update/progress'); if (job.status === 'done') return job; } catch { /* restarting */ }
  }
  throw new Error(t('更新超过 10 分钟没有完成：之后用 codiscuss admin status 查看版本'));
}

async function entry_command(call, [action, first, second], values) {
  if (action === 'start' || action === 'stop') return call(`entry/${action}`, {});
  if (action === 'open' || action === 'close') return call('entry/way', { way: need(first, 'relay|tunnel'), enabled: action === 'open' });
  if (action === 'join') return call('relay/join', { code: need(first, t('接入码')) });
  if (action === 'code') return call('site/code', { config: values.config || '', site: values.site || '' });
  if (action === 'tunnel') return first === 'status' ? call('tunnel/setup') : setup_tunnel(call, need(first, t('域名')), second || '');
  throw new Error(HELP);
}

/** The owner's own ways in: the local page and the online site this computer is bound to. */
async function site_command(call, [action, first, second]) {
  if (!action || action === 'status') {
    const state = await call('state');
    return { local: state.service.url || null, online: state.online_site || null };
  }
  if (action === 'connect') return call('site/connect', { site: need(first, t('站点')), setup_key: second || '' });
  if (action === 'disconnect') return call('site/disconnect', {});
  if (action === 'reconnect') return call('site/reconnect', {});
  throw new Error(HELP);
}

/** Start setting up the owner's domain and wait for the Cloudflare authorization link (or the end). */
async function setup_tunnel(call, host, name) {
  await call('tunnel/setup', { host, name });
  for (let waited = 0; waited < LOGIN_WAIT_MS; waited += POLL_MS) {
    await wait(POLL_MS);
    const job = await call('tunnel/setup');
    if (job.url) return { ...job, note: t('用任一浏览器打开 url，登录 Cloudflare 并选择这个域名授权；之后用 entry tunnel status 查看进度') };
    if (job.status !== 'running') return job;
  }
  return { ...(await call('tunnel/setup')), note: t('仍在进行，用 entry tunnel status 查看进度') };
}

/** The overview at a glance: what runs, where users sign in, and each account in one line. */
function summary(state) {
  const { entry, service } = state;
  const tunnel = entry?.tunnel ? (entry.tunnel.connected ? t('已连接') : entry.tunnel.running ? t('连接中') : t('未运行')) : undefined;
  return { hosting: state.hosting, version: state.version, autostart: state.autostart,
    service: { running: service.running, url: service.url, version: service.version, error: service.error || undefined },
    online_site: state.online_site || undefined, relay_health: state.relay_health || undefined,
    ...(state.hosting ? {
      entry: entry && { running: entry.running, relay_enabled: entry.relay_enabled, tunnel_enabled: entry.tunnel_enabled, address: entry.address || undefined, tunnel, problem: entry.relay?.problem || undefined },
      runtime: state.clis,
      accounts: state.accounts.map(item => ({ name: item.name, isolated: Boolean(item.os_user), protected: item.protected, running: item.running, disabled: item.disabled, last_restart: item.last_restart })),
    } : {}) };
}

/**
 * The panel's client, with the steps that need administrator rights done in this command when it already has them: an
 * administrator's SSH session has no desktop to answer the panel's prompt.
 */
async function with_elevation(call, data) {
  if (!running_elevated()) return call;
  const { create_panel } = await import('./admin_panel.mjs');
  const { api } = create_panel({ data, key: '', port: 0 });
  return (path, body) => (body !== undefined && ELEVATED_PATHS.test(path) ? api('POST', `/api/${path}`, body) : call(path, body));
}

/** Run one `codiscuss admin` command and print its result as JSON. */
export async function admin_cli(args, { client = panel_client, print = text => process.stdout.write(text) } = {}) {
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: {
    data: { type: 'string' }, help: { type: 'boolean', short: 'h' }, 'no-isolate': { type: 'boolean' }, 'no-start': { type: 'boolean' },
    'project-data-root': { type: 'string' },
    confirm: { type: 'boolean' },
    set: { type: 'string', multiple: true }, 'base-url': { type: 'string' }, key: { type: 'string' }, file: { type: 'string' }, group: { type: 'string' },
    full: { type: 'boolean' }, config: { type: 'string' }, site: { type: 'string' },
  } });
  const [command, ...rest] = positionals;
  if (!command || values.help || command === 'help') return print(HELP);
  const data = data_home(values.data);
  // These work without the panel; update starts it first when it is not running.
  const lifecycle = {
    start: () => start_all(data),
    stop: () => stop_all(data),
    restart: async () => ({ stop: await stop_all(data), start: await start_all(data) }),
  };
  if (command === 'update' && rest[0] !== 'check' && !alive(panel_state(data)?.pid || 0)) await start_all(data);
  if (lifecycle[command]) {
    const result = await lifecycle[command]();
    print(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  }
  const call = await with_elevation(await client(data), data);
  if (command === 'room-links') {
    if (rest.length !== 1 || rest.some(id => !/^[a-zA-Z0-9_-]{1,64}$/.test(id))) throw new Error(HELP);
    const result = await call(`room-links/${command}`, { room: rest[0] });
    print(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  }
  const commands = {
    storage: () => {
      if (!rest.length) return call('storage');
      if (rest.length === 1 && rest[0] === 'clean') return call('storage/clean', {});
      throw new Error(HELP);
    },
    status: async () => {
      const { login_methods: _methods, providers: _providers, ...state } = await call('state');
      if (state.online_site) {
        const { label, detail } = relay_health_text(state.online_site, state.relay_health, t);
        state.relay_health = { state: 'unknown', ...state.relay_health, label, detail };
      }
      // The state leaves out the entry's checks over the network; they are asked apart.
      if (state.hosting) {
        state.entry = await call('entry');
        for (const account of state.accounts) {
          const restart = account.last_restart;
          if (restart) account.last_restart = { at: new Date(restart.at).toISOString(), result: restart.result,
            reason: t(restart.reason.template, restart.reason.params), blocked: restart.blocked,
            error: restart.error && t(restart.error.template, restart.error.params) };
        }
      }
      return values.full ? state : summary(state);
    },
    service: () => call(`service/${need(rest[0], 'start|stop|restart')}`, {}),
    autostart: () => call('autostart', { on: need(rest[0], 'on|off') === 'on' }),
    update: () => (rest[0] === 'check' ? call('update/check') : update(call, data)),
    site: () => site_command(call, rest),
    entry: () => entry_command(call, rest, values),
    runtime: () => (rest[0] === 'sync' ? call('clis/install', {}) : Promise.reject(new Error(HELP))),
    drives: () => (rest[0] === 'restrict' ? call('drives/restrict', {}) : Promise.reject(new Error(HELP))),
    account: () => account_command(call, rest, values),
    login: () => login_command(call, rest, values),
    logout: () => call(`logins/${is_owner(need(rest[0], t('目标'))) ? '_' : rest[0]}/${need(rest[1], t('程序'))}/logout`, {}),
    key: () => key_command(call, rest, values),
    skill: () => skill_command(call, rest),
    workflow: () => workflow_command(call, rest),
    prompt: () => prompt_command(call, rest, values),
  };
  if (!commands[command]) throw new Error(HELP);
  const result = await commands[command]();
  print(`${JSON.stringify(result, null, 2)}\n`);
  // A step that failed part way (account add) is reported in the result, and in the exit code for scripts.
  if (result?.failed) process.exitCode = 1;
  return result;
}

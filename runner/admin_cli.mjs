/**
 * `codiscuss admin`: every operation of the management panel from a command line (for instance over SSH), through the
 * running panel's own interface, so a command does exactly what the same click does.
 *
 * It opens the panel the way the taskbar icon does, with the key in the owner's service directory
 * (`admin-panel.json`, readable by the owner only), so only the computer's owner can use it. Elevation prompts and
 * browser windows the panel opens appear in the owner's desktop session, not in this terminal.
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
import { stop_tunnel } from './hosting_tunnel.mjs';
import { launcher_path } from './launcher.mjs';

const STATE_FILE = 'admin-panel.json';
const OWNER = 'owner';
const LOGIN_WAIT_MS = 60_000, UPDATE_WAIT_MS = 10 * 60_000, START_WAIT_MS = 90_000, POLL_MS = 1500;
const RUNNER = dirname(fileURLToPath(import.meta.url));
const DESKTOP_TASK = 'CoDiscuss start (one time)';

export const HELP = `用法：codiscuss admin <命令> [参数]（与管理面板的操作一一对应，需管理面板正在运行）

启动与退出（不需要面板在运行）
  start                                    启动共议：服务、管理面板与任务栏图标、登录入口与隧道（在桌面会话里启动）
  stop                                     彻底退出：管理面板与图标、登录入口、隧道、共议服务；托管账号的实例照常运行
  restart                                  stop 后 start
  update [check]                           检查更新；不带 check 时安装最新版（面板未运行时先启动）并等待每一步结果

本机
  status                                   概览：服务、版本、开机自启、登录入口、托管账号
  service start|stop|restart               只启停共议服务（网站与讨论服务）
  autostart on|off                         登录 Windows 时自动启动

登录入口与外网访问（需打开托管管理）
  entry start|stop                         启动或停止登录入口
  entry mode local|relay|tunnel            外网访问方式
  entry join <接入码>                       用接入码接入线上站点并切换到线上中转
  entry connect <站点> <绑定令牌>           只绑定线上站点（管理员远程用），不改外网访问方式
  runtime sync                             同步隔离账号的程序副本

托管账号
  account list
  account add <名> [--no-isolate] [--no-start]   创建、隔离、初始化 AI 环境、开启入口保护、启动；输出一次性密码
  account start|stop|disable|enable|remove|password <名>
  account isolate|unisolate|protect|unprotect <名>

命令行登录（目标 owner 为管理员自己，否则为托管账号名）
  login status <目标>
  login set <目标> <claude|codex> <方式> --set 字段=值 ...   如 login set alice claude setup_token --set token=sk-ant-oat01-…
  login start <目标> <程序> <方式>          浏览器登录：输出链接，之后用 login submit 提交授权码或回调地址
  login submit <作业> <文本>  /  login progress <作业>  /  login cancel <作业>
  logout <目标> <程序>

API 密钥、技能、工作流、系统提示词（目标同上）
  key list <目标>  /  key add <目标> --base-url <地址> --key <密钥>  /  key remove <目标> <编号>
  skill library  /  skill import <文件夹或.zip>  /  skill delete <名>
  skill list <目标>  /  skill install <目标> <名>...  /  skill remove <目标> <名>...
  workflow list <目标>  /  workflow install <目标>
  prompt get <目标>  /  prompt set <目标> --file <文件> [--group <键>]   管理员的提示词按组保存（见 prompt get）
  prompt default get  /  prompt default set --file <文件>             新托管账号的默认系统提示词

结果以 JSON 输出。--data 指定管理员服务目录（默认 ~/.codiscuss）。
`;

/** A client of the running panel: enters with the owner key and keeps the session for the requests that follow. */
export async function panel_client(data) {
  let state;
  try { state = JSON.parse(readFileSync(join(data, STATE_FILE), 'utf8')); } catch { state = null; }
  if (!state?.port || !state?.key) throw new Error('管理面板没有在运行：在这台电脑的桌面上运行 codiscuss panel open，或从任务栏图标打开');
  const origin = `http://127.0.0.1:${state.port}`;
  let entered;
  try { entered = await fetch(`${origin}/enter?key=${state.key}`, { redirect: 'manual', signal: AbortSignal.timeout(10_000) }); }
  catch { throw new Error('管理面板没有响应：在这台电脑的桌面上运行 codiscuss panel open'); }
  const cookie = (entered.headers.get('set-cookie') || '').split(';')[0];
  if (entered.status !== 302 || !cookie) throw new Error('管理面板拒绝了钥匙（面板可能刚重启）：稍后重试');
  return async function call(path, body) {
    const init = { headers: { cookie }, signal: AbortSignal.timeout(15 * 60_000) };
    if (body !== undefined) Object.assign(init, { method: 'POST', body: JSON.stringify(body),
      headers: { cookie, origin, 'x-codiscuss-panel': '1', 'content-type': 'application/json' } });
    const response = await fetch(`${origin}/api/${path}`, init);
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `管理面板返回 ${response.status}`);
    return result;
  };
}

const wait = ms => new Promise(done => setTimeout(done, ms));
const need = (value, usage) => { if (!value) throw new Error(`缺少参数：${usage}`); return value; };
const is_owner = target => target === OWNER;

/** Create an account the way the panel's wizard does, step by step; the password is reported even if a later step fails. */
async function add_account(call, name, { isolate, start }) {
  const steps = [];
  const created = await call('accounts', { name });
  steps.push('已创建账号与文件夹');
  try {
    if (isolate) {
      await call(`accounts/${name}/os-user`, {});
      steps.push('已创建独立的 Windows 用户（电脑上的管理员确认已通过）');
      const state = await call('state');
      if (!state.clis?.app || !state.clis?.python) { await call('clis/install', {}); steps.push('已安装隔离账号的程序副本'); }
    }
    await call(`accounts/${name}/env/init`, {});
    steps.push(isolate ? '已初始化 AI 环境' : '已安装随包工作流');
    if (process.platform === 'win32') { await call(`accounts/${name}/protect`, { on: true }); steps.push('已开启入口保护'); }
    if (start) { await call(`accounts/${name}/start`, {}); steps.push('已启动实例'); }
  } catch (error) { return { name, password: created.password, steps, failed: error.message }; }
  return { name, password: created.password, steps };
}

const ACCOUNT_ACTIONS = { start: 'start', stop: 'stop', disable: 'disable', enable: 'enable', remove: 'remove', password: 'password',
  isolate: 'os-user', unisolate: 'os-user/remove' };

async function account_command(call, [action, name], values) {
  if (action === 'list') return (await call('state')).accounts;
  need(name, `account ${action} <名>`);
  if (action === 'add') return add_account(call, name, { isolate: !values['no-isolate'], start: !values['no-start'] });
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
  return { job: id, link: '', note: '一分钟内没有出现登录链接，可用 login progress 继续查看' };
}

async function login_command(call, [action, ...rest], values) {
  const target = (name) => (is_owner(name) ? '_' : need(name, '目标'));
  if (action === 'status') return call(`logins/${target(rest[0])}`);
  if (action === 'set') {
    const [who, cli, method] = rest;
    const fields = Object.fromEntries((values.set || []).map(pair => { const at = pair.indexOf('='); return [pair.slice(0, at), pair.slice(at + 1)]; }));
    return call(`logins/${target(who)}/${need(cli, '程序')}/apply`, { method: need(method, '方式'), ...fields });
  }
  if (action === 'start') return start_login(call, target(rest[0]), need(rest[1], '程序'), need(rest[2], '方式'));
  if (action === 'submit') return call(`login-jobs/${need(rest[0], '作业')}/submit`, { text: need(rest.slice(1).join(' '), '文本') });
  if (action === 'progress') return call(`login-jobs/${need(rest[0], '作业')}`);
  if (action === 'cancel') return call(`login-jobs/${need(rest[0], '作业')}/cancel`, {});
  throw new Error(HELP);
}

async function key_command(call, [action, who, ref], values) {
  const base = is_owner(need(who, '目标')) ? 'owner/keys' : `accounts/${who}/keys`;
  if (action === 'list') return call(base);
  if (action === 'add') return call(base, { base_url: need(values['base-url'], '--base-url'), api_key: need(values.key, '--key') });
  if (action === 'remove') return call(`${base}/remove`, { ref: need(ref, '编号') });
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
    const path = need(who, '文件夹或 .zip');
    const body = statSync(path).isDirectory() ? { name: basename(path), files: folder_files(path) } : { zip: readFileSync(path).toString('base64') };
    return call('skill-library', body);
  }
  if (action === 'delete') return call(`skill-library/${need(who, '名')}/remove`, {});
  const base = is_owner(need(who, '目标')) ? 'owner/env' : `accounts/${who}/env`;
  if (action === 'list') return (await call(base)).skills;
  if (action === 'install' || action === 'remove') return call(`${base}/skills`, { [action]: names });
  throw new Error(HELP);
}

async function workflow_command(call, [action, who]) {
  const base = is_owner(need(who, '目标')) ? 'owner/workflows' : `accounts/${who}/workflows`;
  if (action === 'list') return call(base);
  if (action === 'install') return call(`${base}/install`, {});
  throw new Error(HELP);
}

async function prompt_command(call, [action, who], values) {
  if (action === 'default') {
    if (who === 'get') return call('hosted-prompt');
    if (who === 'set') return call('hosted-prompt', { text: readFileSync(need(values.file, '--file'), 'utf8') });
    throw new Error(HELP);
  }
  need(who, '目标');
  if (!is_owner(who)) {
    if (action === 'get') return { prompt: (await call(`accounts/${who}/env`)).prompt };
    if (action === 'set') return call(`accounts/${who}/env/prompt`, { text: readFileSync(need(values.file, '--file'), 'utf8') });
    throw new Error(HELP);
  }
  const groups = await call('owner/prompts');
  if (action === 'get') return groups;
  if (action !== 'set') throw new Error(HELP);
  // The owner's prompt files are kept as groups of hard links; the one to write is named, or the only one there is.
  const group = values.group ? groups.find(item => item.key === values.group) : groups.length === 1 ? groups[0] : null;
  if (!group) throw new Error(`请用 --group 指定要写入的组：${groups.map(item => item.key).join('、')}`);
  return call('owner/prompts', { key: group.key, text: readFileSync(need(values.file, '--file'), 'utf8'), original: group.text });
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
    throw new Error(`没能在桌面会话里启动（需要这台电脑上有人登录着 Windows）：${(result.stderr || result.error?.message || '').trim().split(/\r?\n/)[0]}`);
  }
}

/** Start everything as the 共议 launcher does at login, and wait until the service and the panel answer. */
async function start_all(data) {
  if (local_status(data).running && panel_state(data)?.pid && alive(panel_state(data).pid)) return { started: false, note: '已在运行' };
  const launcher = launcher_path(data);
  if (existsSync(launcher)) start_in_desktop(launcher, ['--start']);
  else start_in_desktop(process.execPath, [join(RUNNER, 'discussion_local.mjs'), 'start']);
  for (let waited = 0; waited < START_WAIT_MS; waited += POLL_MS) {
    await wait(POLL_MS);
    const state = panel_state(data);
    if (local_status(data).running && state?.pid && alive(state.pid)) return { started: true, service: local_status(data).url, panel: state.port };
  }
  throw new Error(`启动超过 ${START_WAIT_MS / 1000} 秒没有完成：查看 ${join(data, 'local', 'supervisor.log')} 与 admin-panel.log`);
}

/** Quit everything but the hosted accounts' instances, keeping every setting (what ran comes back with the next start). */
async function stop_all(data) {
  const steps = [];
  const panel = panel_state(data);
  // The panel first: it would start the entry and the tunnel again.
  if (panel?.pid && alive(panel.pid)) { process.kill(panel.pid); steps.push('已关闭管理面板与任务栏图标'); }
  rmSync(join(data, STATE_FILE), { force: true });
  if ((await entry_status(data)).running) { await stop_entry(data); steps.push('已停止登录入口'); }
  if (entry_settings(data).tunnel) { stop_tunnel(data); steps.push('已停止隧道'); }
  if (local_status(data).pid || local_status(data).service_pid) {
    const result = spawnSync(process.execPath, [join(RUNNER, 'discussion_local.mjs'), 'stop'], { encoding: 'utf8', windowsHide: true,
      env: { ...process.env, DISCUSS_SERVICE_HOME: data }, timeout: 120_000 });
    if (result.status !== 0) throw new Error(`共议服务没有停下：${(result.stderr || '').trim()}`);
    steps.push('已停止共议服务');
  }
  return { stopped: true, steps: steps.length ? steps : ['原本就没有在运行'] };
}

/** Install the latest version and wait for the panel, which restarts on it, to report every step. */
async function update(call, data) {
  await call('update', {});
  for (let waited = 0; waited < UPDATE_WAIT_MS; waited += POLL_MS) {
    await wait(POLL_MS);
    try { const job = await (await panel_client(data))('update/progress'); if (job.status === 'done') return job; } catch { /* restarting */ }
  }
  throw new Error('更新超过 10 分钟没有完成：之后用 codiscuss admin status 查看版本');
}

async function entry_command(call, [action, first, second]) {
  if (action === 'start' || action === 'stop') return call(`entry/${action}`, {});
  if (action === 'mode') return call('entry/mode', { mode: need(first, 'local|relay|tunnel') });
  if (action === 'join') return call('relay/join', { code: need(first, '接入码') });
  if (action === 'connect') return call('site/connect', { site: need(first, '站点'), setup_key: need(second, '绑定令牌') });
  throw new Error(HELP);
}

/** Run one `codiscuss admin` command and print its result as JSON. */
export async function admin_cli(args, { client = panel_client, print = text => process.stdout.write(text) } = {}) {
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: {
    data: { type: 'string' }, help: { type: 'boolean', short: 'h' }, 'no-isolate': { type: 'boolean' }, 'no-start': { type: 'boolean' },
    set: { type: 'string', multiple: true }, 'base-url': { type: 'string' }, key: { type: 'string' }, file: { type: 'string' }, group: { type: 'string' },
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
  const call = await client(data);
  const commands = {
    status: async () => { const { login_methods: _methods, providers: _providers, ...state } = await call('state'); return state; },
    service: () => call(`service/${need(rest[0], 'start|stop|restart')}`, {}),
    autostart: () => call('autostart', { on: need(rest[0], 'on|off') === 'on' }),
    update: () => (rest[0] === 'check' ? call('update/check') : update(call, data)),
    entry: () => entry_command(call, rest),
    runtime: () => (rest[0] === 'sync' ? call('clis/install', {}) : Promise.reject(new Error(HELP))),
    account: () => account_command(call, rest, values),
    login: () => login_command(call, rest, values),
    logout: () => call(`logins/${is_owner(need(rest[0], '目标')) ? '_' : rest[0]}/${need(rest[1], '程序')}/logout`, {}),
    key: () => key_command(call, rest, values),
    skill: () => skill_command(call, rest),
    workflow: () => workflow_command(call, rest),
    prompt: () => prompt_command(call, rest, values),
  };
  if (!commands[command]) throw new Error(HELP);
  const result = await commands[command]();
  print(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

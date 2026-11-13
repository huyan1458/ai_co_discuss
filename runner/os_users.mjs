/**
 * Windows system users for hosted accounts, and the AI command-line programs signed in under them.
 *
 * Each ordinary account can get its own Windows user, so Windows itself keeps that account's AI out of the computer
 * owner's files. The owner's management panel creates the user (one elevation prompt), runs programs as it with the
 * stored password, installs the command-line programs where every user can run them, and signs them in.
 *
 * The password is kept in the owner's service directory, encrypted with Windows DPAPI for the owner's own user, so only
 * the owner can use it. Everything here is Windows only.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const USERS_FILE = 'os-users.json';
const USER_PREFIX = 'cd-';
// Windows local user names are at most 20 characters.
const MAX_USER_NAME = 20;
const SHARED_ROOT = join(process.env.ProgramData || 'C:\\ProgramData', 'CoDiscuss');
const CLI_ROOT = join(SHARED_ROOT, 'cli');
const JOB_ROOT = join(SHARED_ROOT, 'jobs');
const POWERSHELL = 'powershell.exe';
const DEFAULT_TIMEOUT_MS = 120_000;
const ELEVATED_TIMEOUT_MS = 300_000;

/** Where the owner's own copies of the command-line programs are, and where the shared copy of each goes. */
export function cli_sources(home = homedir(), env = process.env) {
  const app_data = env.APPDATA || join(home, 'AppData', 'Roaming');
  const local = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
  return {
    claude: { label: 'Claude Code', source: join(home, '.local', 'bin', 'claude.exe'), target: join(CLI_ROOT, 'claude.exe'), adapter: 'claude' },
    codex: { label: 'Codex', source: join(app_data, 'npm', 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc'),
      target: join(CLI_ROOT, 'codex'), executable: join(CLI_ROOT, 'codex', 'bin', 'codex.exe'), adapter: 'codex_cli', folder: true },
    agy: { label: 'Antigravity CLI', source: join(local, 'agy', 'bin', 'agy.exe'), target: join(CLI_ROOT, 'agy.exe'), adapter: 'antigravity_cli' },
  };
}

/** The shared program each adapter runs for accounts with their own Windows user. */
export function shared_executables() {
  return Object.fromEntries(Object.values(cli_sources()).map(cli => [cli.adapter, cli.executable || cli.target]));
}

/** The Windows user name of one account. */
export function os_user_name(account) {
  const name = `${USER_PREFIX}${account}`;
  if (name.length > MAX_USER_NAME) throw new Error(`账号名过长：Windows 用户名最多 ${MAX_USER_NAME} 个字符，账号名请不超过 ${MAX_USER_NAME - USER_PREFIX.length} 个字符`);
  return name;
}

function users_path(data) {
  return join(data, USERS_FILE);
}

/** The accounts that have a Windows user: { account: { user, secret } }, secret being the DPAPI-encrypted password. */
export function read_os_users(data) {
  const path = users_path(data);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
}

function write_os_users(data, users) {
  const path = users_path(data), draft = `${path}.${process.pid}.tmp`;
  writeFileSync(draft, `${JSON.stringify(users, null, 2)}\n`, { mode: 0o600 });
  renameSync(draft, path);
}

const quote = text => `'${String(text).replaceAll("'", "''")}'`;

/**
 * Run a PowerShell script and return what it printed.
 *
 * Args:
 *   script: The script text; written to a file with a byte-order mark, since Windows PowerShell 5.1 reads one without it
 *     in the ANSI code page.
 *   elevated: Run through a UAC prompt; output then comes back through a file.
 */
export function run_powershell(script, { elevated = false, timeout = DEFAULT_TIMEOUT_MS } = {}) {
  mkdirSync(JOB_ROOT, { recursive: true });
  const job = join(JOB_ROOT, `owner-${process.pid}-${randomBytes(6).toString('hex')}`);
  mkdirSync(job);
  // The shared folder lets every user read by default; a script may carry a password, so only the owner may open this one.
  spawnSync('icacls', [job, '/inheritance:r', '/grant:r', `${process.env.USERNAME || 'Administrator'}:(OI)(CI)F`, 'SYSTEM:(OI)(CI)F'], { windowsHide: true });
  try {
    const file = join(job, 'script.ps1'), output = join(job, 'output.txt');
    writeFileSync(file, `\ufeff$ErrorActionPreference = 'Stop'\ntry {\n${script}\n} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }\n`, 'utf8');
    if (!elevated) {
      const result = spawnSync(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file], { encoding: 'utf8', windowsHide: true, timeout });
      if (result.status !== 0) throw new Error((result.stderr || result.error?.message || 'PowerShell 失败').trim());
      return result.stdout.trim();
    }
    const wrapper = `$process = Start-Process ${POWERSHELL} -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-Command',${quote(`& ${quote(file)} *> ${quote(output)}; exit $LASTEXITCODE`)}
exit $process.ExitCode`;
    const result = spawnSync(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', wrapper], { encoding: 'utf8', windowsHide: true, timeout: ELEVATED_TIMEOUT_MS });
    const text = existsSync(output) ? readFileSync(output, 'utf8').replace(/^\ufeff/, '').trim() : '';
    if (result.status !== 0) throw new Error(text || (result.stderr || '').trim() || '没有获得管理员权限（提权确认被取消或超时）');
    return text;
  } finally { rmSync(job, { recursive: true, force: true }); }
}

/** The owner's DPAPI encryption of a password, usable only by the owner on this computer. */
function protect(password) {
  return run_powershell(`ConvertTo-SecureString ${quote(password)} -AsPlainText -Force | ConvertFrom-SecureString`);
}

/**
 * Create the Windows user of one account and let it work in the account's folder.
 *
 * The user is an ordinary member of Users. It gets modify rights on the account's folder only; the owner's own profile
 * stays closed to it, and Windows lets it reach its folder inside that profile without listing anything on the way.
 */
export function create_os_user(data, account, account_folder, { run = run_powershell } = {}) {
  const user = os_user_name(account);
  if (read_os_users(data)[account]) throw new Error(`账号 ${account} 已有 Windows 用户 ${user}`);
  const password = `Cd!${randomBytes(18).toString('base64url')}`;
  run(`$secure = ConvertTo-SecureString ${quote(password)} -AsPlainText -Force
if (Get-LocalUser -Name ${quote(user)} -ErrorAction SilentlyContinue) { Set-LocalUser -Name ${quote(user)} -Password $secure }
else { New-LocalUser -Name ${quote(user)} -Password $secure -PasswordNeverExpires -UserMayNotChangePassword -Description 'AI CoDiscuss hosted account' | Out-Null }
if (-not (Get-LocalGroupMember -Group 'Users' -Member ${quote(user)} -ErrorAction SilentlyContinue)) { Add-LocalGroupMember -Group 'Users' -Member ${quote(user)} }
icacls ${quote(account_folder)} /grant ${quote(`${user}:(OI)(CI)M`)} /T /C /Q | Out-Null
'ok'`, { elevated: true });
  write_os_users(data, { ...read_os_users(data), [account]: { user, secret: protect(password) } });
  return { user };
}

/** Delete one account's Windows user and its profile folder; the account's own folder stays. */
export function remove_os_user(data, account, { run = run_powershell } = {}) {
  const record = read_os_users(data)[account];
  if (!record) throw new Error(`账号 ${account} 没有 Windows 用户`);
  run(`$user = Get-LocalUser -Name ${quote(record.user)} -ErrorAction SilentlyContinue
if ($user) {
  Get-CimInstance Win32_UserProfile | Where-Object SID -eq $user.SID.Value | Remove-CimInstance
  Remove-LocalUser -Name ${quote(record.user)}
}
'ok'`, { elevated: true });
  const { [account]: removed, ...rest } = read_os_users(data);
  write_os_users(data, rest);
}

/** A job folder the account's user may read and write, for a script it runs and what that script prints. */
function job_folder(user) {
  mkdirSync(JOB_ROOT, { recursive: true });
  const folder = join(JOB_ROOT, `${user}-${randomBytes(6).toString('hex')}`);
  mkdirSync(folder);
  spawnSync('icacls', [folder, '/inheritance:r', '/grant:r', `${process.env.USERNAME || 'Administrator'}:(OI)(CI)F`, `${user}:(OI)(CI)M`, 'SYSTEM:(OI)(CI)F'], { windowsHide: true });
  return folder;
}

/**
 * Start a PowerShell script as the account's user.
 *
 * Args:
 *   script: Runs with $Job set to its job folder; input files can be placed there first through `files`.
 *   visible: Show its window on this desktop instead of running hidden (for programs that need a person to type).
 *   wait: Wait for it and return its output; otherwise return { folder } at once, and the caller reads output.txt later.
 */
export function run_as_user(data, account, script, { files = {}, visible = false, wait = true, timeout = DEFAULT_TIMEOUT_MS, run = run_powershell } = {}) {
  const record = read_os_users(data)[account];
  if (!record) throw new Error(`账号 ${account} 还没有 Windows 用户，请先在“用户”页创建`);
  const folder = job_folder(record.user);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(folder, name), text, 'utf8');
  const job = join(folder, 'job.ps1'), output = join(folder, 'output.txt');
  writeFileSync(job, `\ufeff[Console]::OutputEncoding = [Text.Encoding]::UTF8\n$Job = ${quote(folder)}\n${script}\n`, 'utf8');
  const command = visible ? `-NoProfile -ExecutionPolicy Bypass -NoExit -File ${quote(job)}`
    : `-NoProfile -ExecutionPolicy Bypass -Command & ${quote(job)} *> ${quote(output)}`;
  const start = `$credential = New-Object System.Management.Automation.PSCredential(${quote(record.user)}, (ConvertTo-SecureString ${quote(record.secret)}))
$process = Start-Process ${POWERSHELL} -Credential $credential -LoadUserProfile -WorkingDirectory ${quote(folder)} -PassThru ${visible ? '' : '-WindowStyle Hidden'} -ArgumentList ${quote(command)}
${wait ? `if (-not $process.WaitForExit(${timeout})) { $process.Kill(); throw '运行超时' }` : ''}
$process.Id`;
  try {
    run(start, { timeout: timeout + 10_000 });
    if (!wait) return { folder, output };
    return existsSync(output) ? readFileSync(output, 'utf8').replace(/^\ufeff/, '').trim() : '';
  } finally { if (wait) rmSync(folder, { recursive: true, force: true }); }
}

/** The last JSON object a script printed. */
function last_json(text) {
  const line = String(text).split(/\r?\n/).reverse().find(item => item.trim().startsWith('{'));
  if (!line) throw new Error(String(text).trim() || '没有读到结果');
  return JSON.parse(line);
}

// Reads the Antigravity sign-in entry Windows keeps for the current user (Credential Manager, target gemini:antigravity).
const AGY_CREDENTIAL_CHECK = `Add-Type @'
using System; using System.Runtime.InteropServices;
public static class AgyCredential {
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CredReadW(string target, uint type, uint flags, out IntPtr credential);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr buffer);
  public static bool Exists() { IntPtr pointer; if (!CredReadW("gemini:antigravity", 1, 0, out pointer)) return false; CredFree(pointer); return true; }
}
'@`;

/**
 * Which command-line programs are signed in under the account's user.
 *
 * Returns:
 *   { claude, codex, agy }: each true when signed in. Claude counts as signed in when its token variable is set.
 */
export function cli_status(data, account, options = {}) {
  const clis = cli_sources();
  const text = run_as_user(data, account, `${AGY_CREDENTIAL_CHECK}
$claude = [bool][Environment]::GetEnvironmentVariable('CLAUDE_CODE_OAUTH_TOKEN', 'User')
$codex = $false
if (Test-Path ${quote(clis.codex.executable)}) { & ${quote(clis.codex.executable)} login status *> $null; $codex = $LASTEXITCODE -eq 0 }
@{ claude = $claude; codex = $codex; agy = [AgyCredential]::Exists() } | ConvertTo-Json -Compress`, options);
  return last_json(text);
}

/** Give the account's Claude Code a long-lived token from `claude setup-token`, as a user environment variable. */
export function set_claude_token(data, account, token, options = {}) {
  const value = String(token || '').trim();
  if (!/^sk-ant-oat\d+-[A-Za-z0-9_-]{20,}$/.test(value)) throw new Error('请粘贴 claude setup-token 生成的令牌（以 sk-ant-oat 开头）');
  run_as_user(data, account, `[Environment]::SetEnvironmentVariable('CLAUDE_CODE_OAUTH_TOKEN', (Get-Content (Join-Path $Job 'token.txt') -Raw).Trim(), 'User')
Remove-Item (Join-Path $Job 'token.txt') -Force
'ok'`, { ...options, files: { 'token.txt': value } });
}

/** Remove the account's Claude Code token. */
export function clear_claude_token(data, account, options = {}) {
  run_as_user(data, account, `[Environment]::SetEnvironmentVariable('CLAUDE_CODE_OAUTH_TOKEN', $null, 'User'); 'ok'`, options);
}

/**
 * Start Codex's browser sign-in as the account's user.
 *
 * Codex prints a sign-in link and waits on 127.0.0.1:1455 for the browser to come back, so the link must be opened in a
 * browser on this computer. Returns the job, whose output carries the link; read it with codex_login_progress.
 */
export function start_codex_login(data, account, options = {}) {
  const codex = cli_sources().codex.executable;
  if (!existsSync(codex)) throw new Error('还没有安装共享的 Codex，请先在“命令行登录”页安装命令行程序');
  return run_as_user(data, account, `Set-Location $env:USERPROFILE\n& ${quote(codex)} login`, { ...options, wait: false });
}

/** The sign-in link and outcome of a Codex sign-in job. */
export function codex_login_progress(job) {
  const text = existsSync(job.output) ? readFileSync(job.output, 'utf8') : '';
  const link = text.match(/https:\/\/auth\.openai\.com\/oauth\/authorize\?\S+/)?.[0] || '';
  return { link, done: /Successfully logged in/i.test(text), failed: /error|failed/i.test(text) && !/Successfully logged in/i.test(text) };
}

/**
 * Open Antigravity's own sign-in as the account's user, in a window on this desktop.
 *
 * agy reads the authorization code only from its own console, so a person signs in there: open the link it shows,
 * approve, and paste the code back into that window.
 */
export function open_agy_login(data, account, options = {}) {
  const agy = cli_sources().agy.target;
  if (!existsSync(agy)) throw new Error('还没有安装共享的 Antigravity CLI，请先在“命令行登录”页安装命令行程序');
  return run_as_user(data, account, `$Host.UI.RawUI.WindowTitle = "Antigravity 登录（$(whoami)）"
Set-Location $env:USERPROFILE
Write-Host '在浏览器打开下方链接并同意，再把页面上的授权码粘贴到这里。完成后输入 /exit 或关闭窗口。' -ForegroundColor Yellow
& ${quote(agy)}`, { ...options, visible: true, wait: false });
}

/**
 * Copy the owner's command-line programs to a folder every user can run them from.
 *
 * Returns:
 *   { installed: [label], missing: [label] }.
 */
export function install_shared_clis() {
  const installed = [], missing = [];
  for (const cli of Object.values(cli_sources())) {
    if (!existsSync(cli.source)) { missing.push(cli.label); continue; }
    mkdirSync(dirname(cli.target), { recursive: true });
    cpSync(cli.source, cli.target, { recursive: Boolean(cli.folder), force: true });
    installed.push(cli.label);
  }
  return { installed, missing };
}

/** Which shared programs are installed: { claude, codex, agy } booleans. */
export function shared_cli_state() {
  return Object.fromEntries(Object.entries(cli_sources()).map(([key, cli]) => [key, existsSync(cli.executable || cli.target)]));
}

/**
 * Start one account's instance as its Windows user, in the background.
 *
 * The instance supervisor runs with the account's service directory; it keeps running after this returns.
 */
export function start_instance_as_user(data, account, service_home, local_script, node = process.execPath, options = {}) {
  run_as_user(data, account, `$env:DISCUSS_SERVICE_HOME = ${quote(service_home)}
& ${quote(node)} ${quote(local_script)} start --json`, { ...options, timeout: 90_000 });
}

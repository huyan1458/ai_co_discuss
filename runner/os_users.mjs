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
    const text = existsSync(output) ? read_output(output).trim() : '';
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
    return existsSync(output) ? read_output(output).trim() : '';
  } finally { if (wait) rmSync(folder, { recursive: true, force: true }); }
}

/**
 * What a job script printed. Windows PowerShell 5.1 writes `*>` redirections as UTF-16 with a byte-order mark; anything
 * else is read as UTF-8.
 */
export function read_output(path) {
  const bytes = readFileSync(path);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le');
  return bytes.toString('utf8').replace(/^﻿/, '');
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

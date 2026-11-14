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
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const USERS_FILE = 'os-users.json';
const USER_PREFIX = 'cd-';
// Windows local user names are at most 20 characters.
const MAX_USER_NAME = 20;
const SHARED_ROOT = join(process.env.ProgramData || 'C:\\ProgramData', 'CoDiscuss');
const CLI_ROOT = join(SHARED_ROOT, 'cli');
const APP_ROOT = join(SHARED_ROOT, 'app');
const PYTHON_ROOT = join(SHARED_ROOT, 'python');
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
// What an account's instance runs from the shared copy of this program.
const APP_PARTS = ['package.json', 'server.py', 'runner', 'gateway', 'backend', 'web', '.agents', 'workflows'];
// Parts of a Python installation the website does not need; site-packages is most of its size.
const PYTHON_SKIP = new Set(['site-packages', 'Doc', 'include', 'libs', 'tcl', 'share', 'Scripts', 'test', 'idlelib', 'tkinter', 'turtledemo', '__pycache__']);
const JOB_ROOT = join(SHARED_ROOT, 'jobs');
// The owner's own scripts run from the owner's private temporary folder, never from the shared one: they are what secures
// the shared folder, so they cannot depend on it already being secure.
const OWNER_JOB_ROOT = join(tmpdir(), 'codiscuss-owner-jobs');
const POWERSHELL = 'powershell.exe';
const DEFAULT_TIMEOUT_MS = 120_000;
const ELEVATED_TIMEOUT_MS = 300_000;

/** Where the owner's own copies of the command-line programs are, and where the shared copy of each goes. */
export function cli_sources(home = homedir(), env = process.env) {
  const app_data = env.APPDATA || join(home, 'AppData', 'Roaming');
  const local = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
  const codex = codex_source(app_data, env);
  return {
    claude: { label: 'Claude Code', source: installed_program(join(home, '.local', 'bin', 'claude.exe'), 'claude.exe', env), target: join(CLI_ROOT, 'claude.exe'), adapter: 'claude' },
    codex: codex.single
      ? { label: 'Codex', source: codex.program, target: join(CLI_ROOT, 'codex', 'codex.exe'), adapter: 'codex_cli' }
      : { label: 'Codex', source: codex.folder, program: codex.program, target: join(CLI_ROOT, 'codex'), executable: join(CLI_ROOT, 'codex', 'bin', 'codex.exe'),
        adapter: 'codex_cli', folder: true },
    agy: { label: 'Antigravity CLI', source: installed_program(join(local, 'agy', 'bin', 'agy.exe'), 'agy.exe', env), target: join(CLI_ROOT, 'agy.exe'), adapter: 'antigravity_cli' },
  };
}

/** The first `name` on PATH, or ''. */
function on_path(name, env) {
  const found = spawnSync('where.exe', [name], { encoding: 'utf8', windowsHide: true, env }).stdout?.split(/\r?\n/).find(Boolean);
  return found?.trim() || '';
}

/** A program at its installer's usual place, else the one on PATH; the usual place when neither is there. */
function installed_program(usual, name, env) {
  return existsSync(usual) ? usual : on_path(name, env) || usual;
}

const CODEX_PLATFORM = process.arch === 'arm64' ? ['codex-win32-arm64', 'aarch64-pc-windows-msvc'] : ['codex-win32-x64', 'x86_64-pc-windows-msvc'];

/**
 * Codex's native program as installed. npm puts it in a platform package with the tools it runs beside it (the whole
 * folder is what the shared copy takes): nested under @openai/codex, or beside it with newer npm, in the npm folder the
 * codex command is in (any prefix) or the default one. A standalone codex.exe on PATH is taken alone (`single`). Returns
 * { folder, program, single }; when Codex is not installed, the default npm place, so a message names where it was looked for.
 */
function codex_source(app_data, env) {
  const [platform, triple] = CODEX_PLATFORM;
  const command = on_path('codex.cmd', env);
  const npm_folders = [...new Set([command ? dirname(command) : '', join(app_data, 'npm')].filter(Boolean))];
  const folders = npm_folders.flatMap(npm => [join(npm, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', platform, 'vendor', triple),
    join(npm, 'node_modules', '@openai', platform, 'vendor', triple)]);
  const folder = folders.find(item => existsSync(join(item, 'bin', 'codex.exe')));
  if (folder) return { folder, program: join(folder, 'bin', 'codex.exe'), single: false };
  const standalone = on_path('codex.exe', env);
  if (standalone) return { folder: dirname(standalone), program: standalone, single: true };
  return { folder: folders.at(-2), program: join(folders.at(-2), 'bin', 'codex.exe'), single: false };
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
  mkdirSync(OWNER_JOB_ROOT, { recursive: true });
  const job = join(OWNER_JOB_ROOT, `owner-${process.pid}-${randomBytes(6).toString('hex')}`);
  mkdirSync(job);
  // A script may carry a password, so only the owner may open this one.
  spawnSync('icacls', [job, '/inheritance:r', '/grant:r', `${process.env.USERNAME || 'Administrator'}:(OI)(CI)F`, 'SYSTEM:(OI)(CI)F'], { windowsHide: true });
  try {
    const file = join(job, 'script.ps1'), output = join(job, 'output.txt');
    // Output and errors in UTF-8: in the console's code page, the Chinese messages arrive garbled.
    writeFileSync(file, `\ufeff[Console]::OutputEncoding = [Text.Encoding]::UTF8\n$ErrorActionPreference = 'Stop'\ntry {\n${script}\n} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }\n`, 'utf8');
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
${register_task_script(account, user, '$secure', owner_sid({ run }))}
'ok'`, { elevated: true });
  write_os_users(data, { ...read_os_users(data), [account]: { user, secret: protect(password) } });
  return { user };
}

/** Delete one account's Windows user and its profile folder; the account's own folder stays. */
export function remove_os_user(data, account, { run = run_powershell } = {}) {
  const record = read_os_users(data)[account];
  if (!record) throw new Error(`账号 ${account} 没有 Windows 用户`);
  run(`Unregister-ScheduledTask -TaskName ${quote(task_name(account))} -Confirm:$false -ErrorAction SilentlyContinue
$user = Get-LocalUser -Name ${quote(record.user)} -ErrorAction SilentlyContinue
if ($user) {
  Get-CimInstance Win32_UserProfile | Where-Object SID -eq $user.SID.Value | Remove-CimInstance
  Remove-LocalUser -Name ${quote(record.user)}
}
'ok'`, { elevated: true });
  const { [account]: removed, ...rest } = read_os_users(data);
  write_os_users(data, rest);
}

let shared_root_secured = false;

/**
 * A job folder for one run as the account's user: the owner writes the script, its input and any control files into it,
 * and the account's user may only read them; what the script writes goes to its `out` folder, the one place it may write.
 *
 * Nothing the owner writes is ever in a folder the account can change, so the account cannot redirect those writes
 * (for instance by replacing the folder with a junction). The shared folder is secured once per process first.
 */
function job_folder(user, { run = run_powershell } = {}) {
  // Every folder on the way is secured and checked: the shared folder, then the jobs folder within it.
  if (!shared_root_secured) {
    secure_shared_root({ run });
    secure_folder(JOB_ROOT, [`(New-Object Security.Principal.SecurityIdentifier('${USERS_SID}'))`], { run });
    shared_root_secured = true;
  }
  mkdirSync(JOB_ROOT, { recursive: true });
  const folder = join(JOB_ROOT, `${user}-${randomBytes(6).toString('hex')}`);
  mkdirSync(folder);
  const me = process.env.USERNAME || 'Administrator';
  const sealed = spawnSync('icacls', [folder, '/inheritance:r', '/grant:r', `${me}:(OI)(CI)F`, `${user}:(OI)(CI)RX`, 'SYSTEM:(OI)(CI)F'], { windowsHide: true });
  const out = join(folder, 'out');
  mkdirSync(out);
  const opened = spawnSync('icacls', [out, '/grant', `${user}:(OI)(CI)M`], { windowsHide: true });
  if (sealed.status !== 0 || opened.status !== 0) {
    rmSync(folder, { recursive: true, force: true });
    throw new Error('作业目录的权限没有设置成功，已停止');
  }
  return folder;
}

/**
 * Start a PowerShell script as the account's user.
 *
 * Args:
 *   script: Runs with $Job set to its job folder; input files can be placed there first through `files` (name → text)
 *     and `folders` (name → a folder of the owner's, copied in, as the account's user cannot read the owner's files).
 *   visible: Show its window on this desktop instead of running hidden (for programs that need a person to type).
 *   wait: Wait for it and return its output; otherwise return { folder } at once, and the caller reads output.txt later.
 */
export function run_as_user(data, account, script, { files = {}, folders = {}, visible = false, wait = true, timeout = DEFAULT_TIMEOUT_MS, run = run_powershell } = {}) {
  const record = read_os_users(data)[account];
  if (!record) throw new Error(`账号 ${account} 还没有 Windows 用户，请先隔离这个账号`);
  const folder = job_folder(record.user, { run });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(folder, name), text, 'utf8');
  for (const [name, source] of Object.entries(folders)) cpSync(source, join(folder, name), { recursive: true });
  const job = join(folder, 'job.ps1'), output = join(folder, 'out', 'output.txt');
  writeFileSync(job, `\ufeff[Console]::OutputEncoding = [Text.Encoding]::UTF8\n$Job = ${quote(folder)}\n$Out = ${quote(join(folder, 'out'))}\n${script}\n`, 'utf8');
  const command = visible ? `-NoProfile -ExecutionPolicy Bypass -NoExit -File ${quote(job)}`
    : `-NoProfile -ExecutionPolicy Bypass -Command & ${quote(job)} *> ${quote(output)}`;
  const start = `$credential = New-Object System.Management.Automation.PSCredential(${quote(record.user)}, (ConvertTo-SecureString ${quote(record.secret)}))
$process = Start-Process ${POWERSHELL} -Credential $credential -LoadUserProfile -WorkingDirectory ${quote(folder)} -PassThru ${visible ? '' : '-WindowStyle Hidden'} -ArgumentList ${quote(command)}
${wait ? `if (-not $process.WaitForExit(${timeout})) { $process.Kill(); throw '运行超时' }` : ''}
$process.Id`;
  try {
    const started = run(start, { timeout: timeout + 10_000 });
    // Not waiting: the started process's id comes back too (the last line the start printed).
    if (!wait) return { folder, output, pid: Number(String(started).trim().split(/\s+/).pop()) || 0 };
    return existsSync(output) ? read_output(output).trim() : '';
  } finally {
    // A program the script started may still hold the folder; the job's result does not depend on removing it.
    if (wait) try { rmSync(folder, { recursive: true, force: true }); } catch { /* left for the next cleanup */ }
  }
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

// ---- Folders no hosted account can change ----

// Well-known SIDs: the local Users group (every hosted account's Windows user belongs to it).
const USERS_SID = 'S-1-5-32-545';
const KEY_FILE = 'entry-key.json';

/**
 * Make `path` a folder whose rights the owner alone decides, and check what is actually in force afterwards.
 *
 * The folder must not be a link; its owner becomes the current user; inheritance is cut; the current user, SYSTEM and
 * Administrators get full control and each of `readers` read-and-run only. The ACL is then read back: an owner other
 * than those three, inheritance still on, or any other principal allowed more than read-and-run stops with an error,
 * and so does any failure to set it, so nothing is written into a folder that is not as intended.
 *
 * Args:
 *   readers: PowerShell expressions for the identities that may read, e.g. a SecurityIdentifier or NTAccount.
 */
export function secure_folder(path, readers = [], { run = run_powershell } = {}) {
  return run(`$path = ${quote(path)}
# No folder on the way may be a link either: each ancestor is checked, up to the drive.
$parent = [IO.Path]::GetDirectoryName($path)
while ($parent) {
  if ((Get-Item -LiteralPath $parent -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "受保护目录 $path 的上级 $parent 是一个链接，已停止" }
  $next = [IO.Path]::GetDirectoryName($parent)
  if (-not $next -or $next -eq $parent) { break }
  $parent = $next
}
if (Test-Path -LiteralPath $path) {
  if ((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "受保护目录 $path 是一个链接，已停止" }
} else { New-Item -ItemType Directory -Path $path | Out-Null }
$me = [Security.Principal.WindowsIdentity]::GetCurrent().User
$system = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
$admins = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')
$trusted = @($me.Value, $system.Value, $admins.Value)
$inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
# Only the owner and the access list are written (not the audit list, which would need a privilege the owner lacks).
$item = Get-Item -LiteralPath $path -Force
$sections = [Security.AccessControl.AccessControlSections]'Access, Owner'
$acl = $item.GetAccessControl($sections)
$acl.SetAccessRuleProtection($true, $false)
foreach ($rule in @($acl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]))) { [void]$acl.RemoveAccessRuleSpecific($rule) }
$acl.SetOwner($me)
foreach ($sid in @($me, $system, $admins)) { $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', $inherit, 'None', 'Allow'))) }
foreach ($reader in @(${readers.join(', ')})) { $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($reader, 'ReadAndExecute', $inherit, 'None', 'Allow'))) }
$item.SetAccessControl($acl)
$read = Get-Acl -LiteralPath $path
$owner = (New-Object Security.Principal.NTAccount($read.Owner)).Translate([Security.Principal.SecurityIdentifier]).Value
if ($trusted -notcontains $owner) { throw "受保护目录 $path 的所有者不对：$($read.Owner)" }
if (-not $read.AreAccessRulesProtected) { throw "受保护目录 $path 仍在继承上级权限" }
$allowed = [long]([Security.AccessControl.FileSystemRights]'ReadAndExecute, Synchronize')
foreach ($rule in $read.Access) {
  $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
  if ($trusted -contains $sid -or $rule.AccessControlType -ne 'Allow') { continue }
  # Rights are a 32-bit mask; generic rights come back negative as Int32, so they are widened before the comparison.
  $rights = [long]([int]$rule.FileSystemRights); if ($rights -lt 0) { $rights += 4294967296 }
  if (($rights -band (-bnot $allowed)) -ne 0) { throw "受保护目录 $path 上 $($rule.IdentityReference) 有超出读取的权限" }
}
'ok'`);
}

/** The shared folder, made one that only the owner can change: every account may read and run what is in it. */
export function secure_shared_root({ root = SHARED_ROOT, run = run_powershell } = {}) {
  return secure_folder(root, [`(New-Object Security.Principal.SecurityIdentifier('${USERS_SID}'))`], { run });
}

/** Where an account's instance reads its key: inside the shared folder, in a folder only that account may read. */
export function instance_key_file(account, root = SHARED_ROOT) {
  return join(root, 'keys', account, KEY_FILE);
}

/**
 * Place an account's instance key where its instance (and its members' command lines) can read it and nothing hosted
 * can change it: the shared folder and the account's key folder are secured and checked first, then the key is written
 * by the owner. An account without its own Windows user runs as the owner, so its folder has no extra reader.
 *
 * Returns:
 *   The key file's path.
 */
export function place_instance_key(data, account, key, { root = SHARED_ROOT, run = run_powershell } = {}) {
  if (!/^[0-9a-f]{64}$/.test(String(key))) throw new Error('实例密钥格式不对');
  return place_account_file(data, account, KEY_FILE, `${JSON.stringify({ key })}\n`, { root, run });
}

/**
 * Write one file into the account's folder of the shared folder, which only the owner can change and only the account's
 * Windows user (if any) can read: the folder and every level above are secured and checked first.
 *
 * Returns:
 *   The file's path.
 */
function place_account_file(data, account, file_name, text, { root = SHARED_ROOT, run = run_powershell } = {}) {
  // Each level is secured and checked in turn: the shared folder, the keys folder, then the account's own.
  secure_shared_root({ root, run });
  secure_folder(join(root, 'keys'), [`(New-Object Security.Principal.SecurityIdentifier('${USERS_SID}'))`], { run });
  const user = read_os_users(data)[account]?.user;
  const folder = join(root, 'keys', account);
  secure_folder(folder, user ? [`(New-Object Security.Principal.NTAccount(${quote(user)}))`] : [], { run });
  // A new file of its own (never one that was already there, which could carry its own grants), then only the folder's
  // inherited rights on the final file, checked.
  const path = join(folder, file_name), draft = join(folder, `${randomBytes(12).toString('hex')}.tmp`);
  writeFileSync(draft, text, { flag: 'wx' });
  renameSync(draft, path);
  run(`$file = ${quote(path)}
& icacls $file /reset /Q | Out-Null
if ($LASTEXITCODE -ne 0) { throw "文件的权限没有重置成功" }
$read = Get-Acl -LiteralPath $file
if ($read.AreAccessRulesProtected) { throw "文件没有沿用所在目录的权限" }
foreach ($rule in $read.Access) { if (-not $rule.IsInherited) { throw "文件带有单独的授权：$($rule.IdentityReference)" } }
'ok'`);
  return path;
}

/** Where the shared copies of this program and of Python are, for accounts with their own Windows user. */
export function shared_paths() {
  return { app: APP_ROOT, local_script: join(APP_ROOT, 'runner', 'discussion_local.mjs'), env_script: join(APP_ROOT, 'runner', 'account_env.mjs'),
    python: join(PYTHON_ROOT, 'python.exe') };
}

/** Copy a folder over an older copy, reporting a file in use (a running instance holds Python) instead of failing. */
function copy_over(source, target, filter) {
  try { cpSync(source, target, { recursive: true, force: true, filter }); return ''; }
  catch (error) { return error.code === 'EBUSY' || error.code === 'EPERM' ? '部分文件正被运行中的实例使用，停止实例后再更新一次' : error.message; }
}

/**
 * Copy what an account's own Windows user needs to run to a folder every user can read: the owner's command-line
 * programs, this program (the owner's npm folder is inside the owner's profile, which other users cannot open) and the
 * Python the owner's instance uses, without its third-party packages, tests and documentation (the website needs only
 * the standard library).
 *
 * Returns:
 *   { installed: [label], missing: [label], warnings: [text] }.
 */
export function install_shared_runtime(python_source = '', { run = run_powershell } = {}) {
  const installed = [], missing = [], warnings = [];
  // Secured before anything is copied in: a file another user put there first would stay theirs.
  secure_shared_root({ run });
  for (const cli of Object.values(cli_sources())) {
    if (!existsSync(cli.source)) { missing.push(cli.label); continue; }
    mkdirSync(dirname(cli.target), { recursive: true });
    const failed = cli.folder ? copy_over(cli.source, cli.target) : (() => { try { cpSync(cli.source, cli.target, { force: true }); return ''; } catch (error) { return error.message; } })();
    if (failed) warnings.push(`${cli.label}：${failed}`); else installed.push(cli.label);
  }
  mkdirSync(APP_ROOT, { recursive: true });
  const app_failed = APP_PARTS.filter(part => existsSync(join(PACKAGE_ROOT, part))).map(part => copy_over(join(PACKAGE_ROOT, part), join(APP_ROOT, part))).find(Boolean);
  if (app_failed) warnings.push(`共议程序：${app_failed}`); else installed.push('共议程序');
  if (python_source && existsSync(python_source)) {
    const failed = copy_over(dirname(python_source), PYTHON_ROOT, source => !PYTHON_SKIP.has(basename(source)));
    if (failed) warnings.push(`Python：${failed}`); else installed.push('Python');
  } else missing.push('Python');
  return { installed, missing, warnings };
}

/** Which shared programs are installed: { claude, codex, agy, app, python } booleans, and the shared program's version. */
export function shared_cli_state() {
  const paths = shared_paths();
  let app_version = '';
  try { app_version = JSON.parse(readFileSync(join(APP_ROOT, 'package.json'), 'utf8')).version; } catch { /* not installed */ }
  return { ...Object.fromEntries(Object.entries(cli_sources()).map(([key, cli]) => [key, existsSync(cli.executable || cli.target)])),
    app: existsSync(paths.local_script), python: existsSync(paths.python), app_version };
}

// ---- The instance of an account with its own Windows user: a scheduled task ----
//
// The instance runs as a scheduled task of the account's Windows user that runs whether or not anyone is signed in: it
// is then in a session of its own with no desktop, out of reach of the owner's windows, keyboard and clipboard (a
// program started with the user's credentials on the owner's desktop would share them), and it comes back when the
// computer starts. The task runs START_SCRIPT from the account's folder of the shared folder, which only the owner can
// change; it starts the instance only while RUN_FLAG is there (the owner's start puts it, the owner's stop removes it),
// so an instance the owner stopped stays stopped after a restart.

const START_SCRIPT = 'start-instance.ps1';
const RUN_FLAG = 'run.flag';
const TASK_PREFIX = 'CoDiscuss instance ';

/** The scheduled task of one account's instance. */
export function task_name(account) {
  return `${TASK_PREFIX}${account}`;
}

let cached_owner_sid = '';

/** The owner's own security identifier (granted by the elevated scripts, even when another administrator elevates). */
function owner_sid({ run = run_powershell } = {}) {
  if (!cached_owner_sid) cached_owner_sid = run('[Security.Principal.WindowsIdentity]::GetCurrent().User.Value');
  return cached_owner_sid;
}

/**
 * PowerShell, run elevated, that (re)registers the account's instance task as `user` with the SecureString in
 * `password_variable`, and lets the owner (`sid`) start it without elevation.
 */
function register_task_script(account, user, password_variable, sid) {
  const script = join(SHARED_ROOT, 'keys', account, START_SCRIPT);
  return `$action = New-ScheduledTaskAction -Execute ${quote(POWERSHELL)} -Argument ${quote(`-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "${script}"`)}
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
$plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR(${password_variable}))
Register-ScheduledTask -TaskName ${quote(task_name(account))} -Action $action -Trigger $trigger -Settings $settings -User ${quote(user)} -Password $plain -RunLevel Limited -Force | Out-Null
$service = New-Object -ComObject Schedule.Service
$service.Connect()
$task = $service.GetFolder('\').GetTask(${quote(task_name(account))})
$task.SetSecurityDescriptor($task.GetSecurityDescriptor(4) + '(A;;GRGX;;;${sid})', 0)`;
}

/** Register the instance task of an account isolated before instances ran as tasks (one elevation prompt). */
function register_instance_task(data, account, { run = run_powershell } = {}) {
  const record = read_os_users(data)[account];
  run(`$secure = ConvertTo-SecureString ${quote(record.secret)}
${register_task_script(account, record.user, '$secure', owner_sid({ run }))}
'ok'`, { elevated: true });
}

/**
 * Start one account's instance as its Windows user, in the background: write its start script and run flag, then start
 * its task. The instance keeps running after this returns; a protected instance, and every member it starts, gets the
 * key file it proves itself with.
 */
export function start_instance_as_user(data, account, service_home, local_script, node = process.execPath, { key_file = '', run = run_powershell } = {}) {
  const record = read_os_users(data)[account];
  if (!record) throw new Error(`账号 ${account} 还没有 Windows 用户，请先隔离这个账号`);
  place_account_file(data, account, START_SCRIPT, `﻿$flag = ${quote(join(SHARED_ROOT, 'keys', account, RUN_FLAG))}
if (-not (Test-Path -LiteralPath $flag)) { exit 0 }
$env:DISCUSS_SERVICE_HOME = ${quote(service_home)}
${key_file ? `$env:DISCUSS_ENTRY_KEY_FILE = ${quote(key_file)}\n` : ''}Set-Location -LiteralPath ${quote(service_home)}
& ${quote(node)} ${quote(local_script)} run
exit $LASTEXITCODE
`, { run });
  writeFileSync(join(SHARED_ROOT, 'keys', account, RUN_FLAG), `${Date.now()}\n`);
  const name = quote(task_name(account));
  const found = run(`if (Get-ScheduledTask -TaskName ${name} -ErrorAction SilentlyContinue) { 'yes' } else { 'no' }`);
  if (found !== 'yes') register_instance_task(data, account, { run });
  run(`Start-ScheduledTask -TaskName ${name}
'ok'`);
}

/** Keep a stopped instance stopped when the computer starts again (its supervisor is stopped separately). */
export function clear_instance_flag(account) {
  rmSync(join(SHARED_ROOT, 'keys', account, RUN_FLAG), { force: true });
}

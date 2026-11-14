/**
 * Sign-in of the AI command-line programs for the computer owner and for hosted accounts, as the management panel offers
 * it. Only each program's own sign-in is used: settings it documents, or its own login command with a person completing
 * the browser step and giving back the code it shows.
 *
 * The work happens in cli_login_agent.mjs, run as the user being signed in: the owner directly, a hosted account through
 * its Windows user (run_as_user). Antigravity reads the authorization code only from its own console, so its sign-in runs
 * in a Windows pseudo console (ConPTY) that a small PowerShell host drives, typing what the person gives.
 *
 * A target is '' for the owner, or the name of a hosted account that has its own Windows user.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cli_sources, read_os_users, read_output, run_as_user, run_powershell } from './os_users.mjs';

const AGENT = join(dirname(fileURLToPath(import.meta.url)), 'cli_login_agent.mjs');
const POWERSHELL = 'powershell.exe';
const AGENT_TIMEOUT_MS = 90_000;
const LOGIN_TIMEOUT_S = 900;
const CODEX_CALLBACK = 'http://127.0.0.1:1455';
const ANSI = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b[=>]/g;

/**
 * The sign-in methods the panel offers for each program, in the order shown; `fields` are what a person fills in, and
 * `interactive` ones run the program's own login. Claude's setup token comes first (user's choice, 2026-11-12): it
 * lasts a year and avoids the subscription sign-in's refresh problems on Windows.
 */
export const LOGIN_METHODS = {
  claude: [
    { key: 'setup_token', label: 'Setup Token（推荐）', fields: ['token'] },
    { key: 'subscription', label: 'Claude 账号登录', interactive: true, args: ['auth', 'login'] },
    { key: 'console', label: 'Anthropic Console 账号登录', interactive: true, args: ['auth', 'login', '--console'] },
    { key: 'api_key', label: '官方 API 密钥', fields: ['key'] },
    { key: 'third_party', label: '第三方 API（Anthropic 兼容）', fields: ['base_url', 'token', 'model', 'small_model'] },
    { key: 'env', label: '高级：环境变量', fields: ['env'] },
  ],
  codex: [
    { key: 'chatgpt', label: 'ChatGPT 账号登录', interactive: true, args: ['login'] },
    { key: 'device', label: 'ChatGPT 设备码登录', interactive: true, args: ['login', '--device-auth'] },
    { key: 'api_key', label: 'OpenAI API 密钥', fields: ['key'] },
    { key: 'third_party', label: '第三方 API（Responses 兼容）', fields: ['base_url', 'key', 'model'] },
    { key: 'access_token', label: 'Enterprise 访问令牌', fields: ['key'] },
  ],
  agy: [
    { key: 'google', label: 'Google 账号登录', interactive: true, pty: true },
  ],
};

/** The programs a target runs: the owner's own copies, or the shared copies a hosted account's user runs. */
function executables(target) {
  return Object.fromEntries(Object.entries(cli_sources()).map(([key, cli]) => [key, target ? cli.executable || cli.target
    : cli.program || cli.source]));
}

function check_target(data, target) {
  if (target && !read_os_users(data)[target]) throw new Error(`账号 ${target} 还没有 Windows 用户，它的 AI 用的是你自己的登录`);
}

// ---- Running as the target ----

/** A job folder for the owner, in the owner's own temporary folder, laid out like an account's (output in `out`). */
function owner_folder(files) {
  const folder = join(tmpdir(), `codiscuss-login-${randomBytes(6).toString('hex')}`);
  mkdirSync(join(folder, 'out'), { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(folder, name), text, 'utf8');
  return folder;
}

/** Run the agent once as the target and return its JSON answer. */
function agent(data, target, action, request) {
  const files = { 'request.json': JSON.stringify({ ...request, executables: executables(target) }) };
  let text;
  if (target) {
    files['agent.mjs'] = readFileSync(AGENT, 'utf8');
    text = run_as_user(data, target, `& ${quote(process.execPath)} (Join-Path $Job 'agent.mjs') ${action} $Job`, { files, timeout: AGENT_TIMEOUT_MS });
  } else {
    const folder = owner_folder(files);
    try { text = spawnSync(process.execPath, [AGENT, action, folder], { encoding: 'utf8', windowsHide: true, timeout: AGENT_TIMEOUT_MS }).stdout || ''; }
    finally { rmSync(folder, { recursive: true, force: true }); }
  }
  const line = String(text).split(/\r?\n/).reverse().find(item => item.trim().startsWith('{'));
  if (!line) throw new Error(String(text).trim().slice(0, 300) || '没有读到结果');
  const answer = JSON.parse(line);
  if (answer.error) throw new Error(answer.error);
  return answer;
}

const quote = text => `'${String(text).replaceAll("'", "''")}'`;

/** Which programs are signed in for a target, and how: { claude, codex, agy } of { installed, signed_in, method, detail }. */
export function login_status(data, target) {
  check_target(data, target);
  return agent(data, target, 'status', {});
}

/** Sign a program in with values a person filled in (a token, a key, an address). */
export function apply_login(data, target, cli, values) {
  check_target(data, target);
  const method = LOGIN_METHODS[cli]?.find(item => item.key === values.method);
  if (!method || method.interactive) throw new Error('这种方式需要在登录窗口里完成');
  return agent(data, target, 'apply', { ...values, cli });
}

/** Sign a program out, clearing what this panel wrote for it. */
export function logout(data, target, cli) {
  check_target(data, target);
  if (!LOGIN_METHODS[cli]) throw new Error(`未知程序：${cli}`);
  return agent(data, target, 'logout', { cli });
}

// ---- Interactive sign-in ----

const jobs = new Map();

/**
 * Start a program's own sign-in for a target. Returns an id; progress() shows its link and what it asks for, submit()
 * gives it the code or address a person copied, cancel() stops it.
 */
export function start_login(data, target, cli, method_key) {
  check_target(data, target);
  const method = LOGIN_METHODS[cli]?.find(item => item.key === method_key && item.interactive);
  if (!method) throw new Error('这种方式不需要登录窗口');
  const job = method.pty ? start_console(data, target, executables(target)[cli]) : start_agent_login(data, target, cli, method.args);
  const id = randomUUID();
  jobs.set(id, { ...job, cli, method: method_key, target, started: Date.now(), typed_menu: false });
  return { id };
}

function start_agent_login(data, target, cli, args) {
  const files = { 'request.json': JSON.stringify({ cli, args, executables: executables(target) }) };
  if (target) {
    files['agent.mjs'] = readFileSync(AGENT, 'utf8');
    return run_as_user(data, target, `& ${quote(process.execPath)} (Join-Path $Job 'agent.mjs') login $Job`, { files, wait: false });
  }
  const folder = owner_folder(files);
  const child = spawn(process.execPath, [AGENT, 'login', folder], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  return { folder, pid: child.pid || 0 };
}

/**
 * Whether the program listening on Codex's callback port was started by this sign-in (the port is shared by every user
 * of this computer: another hosted account's process could listen there first and receive the authorization code).
 */
function callback_listener_is(pid) {
  if (!pid) return false;
  return run_powershell(`$listener = (Get-NetTCPConnection -LocalPort 1455 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess
if (-not $listener) { 'none'; exit 0 }
$parents = @{}
Get-CimInstance Win32_Process | ForEach-Object { $parents[[int]$_.ProcessId] = [int]$_.ParentProcessId }
$current = [int]$listener
for ($step = 0; $step -lt 12 -and $current; $step++) { if ($current -eq ${Number(pid)}) { 'ours'; exit 0 }; $current = $parents[$current] }
'other'`) === 'ours';
}

function start_console(data, target, exe) {
  const files = { 'host.ps1': `﻿${CONSOLE_HOST}`, 'command.txt': `"${exe}"` };
  if (target) return run_as_user(data, target, "& (Join-Path $Job 'host.ps1') -Job $Job", { files, wait: false });
  const folder = owner_folder(files);
  // Not detached: a PowerShell started detached (no console) exits at once with code 0 without running its script.
  spawn(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(folder, 'host.ps1'), '-Job', folder], { stdio: 'ignore', windowsHide: true }).unref();
  return { folder };
}

function screen_text(folder) {
  const path = join(folder, 'out', 'screen.txt');
  if (!existsSync(path)) return '';
  return read_output(path).replace(ANSI, '').replace(/\r/g, '');
}

function job_of(id) {
  const job = jobs.get(id);
  if (!job) throw new Error('登录已结束，请重新开始');
  return job;
}

/**
 * Where a sign-in stands: the link to open, what to give back ('code' for Claude and Antigravity, 'callback' for Codex's
 * browser sign-in, nothing for its device code), the device code, the last error the program showed, and whether it ended.
 */
export function login_progress(id) {
  const job = job_of(id);
  const screen = screen_text(job.folder), flat = screen.replace(/\s+/g, ' ');
  // Antigravity first asks which sign-in to use; the first entry is the Google account.
  if (job.cli === 'agy' && !job.typed_menu && /Select login method/i.test(screen)) { appendFileSync(join(job.folder, 'input.txt'), '\r'); job.typed_menu = true; }
  const link = { claude: /https:\/\/(?:claude\.com|claude\.ai|platform\.claude\.com|console\.anthropic\.com)\/\S*oauth\/authorize\S*/,
    codex: job.method === 'device' ? /https:\/\/auth\.openai\.com\/codex\/device\S*/ : /https:\/\/auth\.openai\.com\/oauth\/authorize\S*/,
    agy: /https:\/\/accounts\.google\.com\/o\/oauth2\/auth\S*/ }[job.cli];
  const exit = existsSync(join(job.folder, 'out', 'exit.txt')) ? Number(readFileSync(join(job.folder, 'out', 'exit.txt'), 'utf8')) : null;
  const signed = existsSync(join(job.folder, 'out', 'done.txt'));
  const errors = [...flat.matchAll(/(Invalid code[^.]*\.|Got an error: [^.]*\.?|error[:：][^\n]{0,160})/gi)].map(match => match[1].trim());
  const done = signed || exit === 0;
  // Links are matched line by line: the console is wide enough that none wraps, and joining lines would glue the next
  // line onto a link that ends one (Codex's device page is followed by "2. Enter this code").
  const result = { link: (screen.match(link) || [''])[0].replace(/[.,)]+$/, ''),
    asks: job.cli === 'codex' ? (job.method === 'device' ? '' : 'callback') : 'code',
    user_code: job.method === 'device' ? (flat.match(/\b[A-Z0-9]{4,5}-[A-Z0-9]{4,6}\b/) || [''])[0] : '',
    error: errors.at(-1) || '', done, ended: done || exit !== null, tail: screen.split('\n').filter(Boolean).slice(-6).join('\n') };
  // A sign-in that ended without success says why on its last line, whatever wording the program used.
  if (result.ended && !done && !result.error) result.error = screen.split('\n').map(line => line.trim()).filter(Boolean).at(-1) || '登录已退出';
  if (result.ended) finish(id, job);
  return result;
}

function finish(id, job) {
  jobs.delete(id);
  if (!existsSync(join(job.folder, 'out', 'exit.txt'))) appendFileSync(join(job.folder, 'cancel.txt'), 'x');
  setTimeout(() => rmSync(job.folder, { recursive: true, force: true }), 5000);
}

/**
 * Give a sign-in what a person copied: the code the page showed, or for Codex the address the browser ended on, which is
 * passed to Codex's own sign-in server on this computer as if that browser had reached it.
 */
export async function submit_login(id, text) {
  const job = job_of(id), value = String(text || '').trim();
  if (!value) throw new Error('请粘贴授权码');
  if (job.cli !== 'codex') { appendFileSync(join(job.folder, 'input.txt'), `${value}\r${job.cli === 'claude' ? '\n' : ''}`); return { ok: true }; }
  let address;
  try { address = new URL(value); } catch { throw new Error('请粘贴浏览器地址栏里的完整地址（以 http://localhost:1455/auth/callback 开头）'); }
  if (!['localhost', '127.0.0.1'].includes(address.hostname) || address.port !== '1455' || address.pathname !== '/auth/callback') {
    throw new Error('这不是 Codex 的登录回调地址：应以 http://localhost:1455/auth/callback 开头');
  }
  if (process.platform === 'win32' && !callback_listener_is(job.pid)) {
    throw new Error('1455 端口上不是本次登录启动的 Codex（可能被其他程序占用），为防止授权码泄露，已停止；请重新开始登录');
  }
  const response = await fetch(`${CODEX_CALLBACK}${address.pathname}${address.search}`, { redirect: 'manual', signal: AbortSignal.timeout(20_000) });
  if (response.status >= 400) throw new Error(`Codex 没有接受这个地址（HTTP ${response.status}），请重新开始登录`);
  return { ok: true };
}

export function cancel_login(id) {
  const job = jobs.get(id);
  if (job) finish(id, job);
  return { ok: true };
}

// The pseudo-console host: runs the command line in command.txt under ConPTY as the user it runs as, appends its screen
// to screen.txt, types new text from input.txt, stops on cancel.txt or after LOGIN_TIMEOUT_S, writes exit.txt, and
// writes done.txt and stops once Antigravity's sign-in is stored (Credential Manager entry gemini:antigravity).
const CONSOLE_HOST = `param([string]$Job)
$ErrorActionPreference = 'Stop'
$CommandLine = (Get-Content (Join-Path $Job 'command.txt') -Raw).Trim()
Add-Type -TypeDefinition @'
using System; using System.IO; using System.Runtime.InteropServices; using System.Text; using System.Threading;
using Microsoft.Win32.SafeHandles;
public static class ConsoleHost {
  [StructLayout(LayoutKind.Sequential)] public struct COORD { public short X, Y; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct STARTUPINFO {
    public int cb; public string lpReserved, lpDesktop, lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError; }
  [StructLayout(LayoutKind.Sequential)] public struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
  [StructLayout(LayoutKind.Sequential)] public struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CreatePipe(out SafeFileHandle read, out SafeFileHandle write, IntPtr attributes, int size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern int CreatePseudoConsole(COORD size, SafeFileHandle input, SafeFileHandle output, uint flags, out IntPtr console);
  [DllImport("kernel32.dll")] static extern void ClosePseudoConsole(IntPtr console);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CreateProcessW(string application, StringBuilder command, IntPtr process, IntPtr thread, bool inherit, uint flags, IntPtr environment, string directory, ref STARTUPINFOEX startup, out PROCESS_INFORMATION information);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr handle, out uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr handle, uint code);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredReadW(string target, uint type, uint flags, out IntPtr credential);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr buffer);

  static bool SignedIn() { IntPtr pointer; if (!CredReadW("gemini:antigravity", 1, 0, out pointer)) return false; CredFree(pointer); return true; }

  static byte[] ReadShared(string path) {
    using (FileStream stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete)) {
      byte[] all = new byte[stream.Length]; int read = 0;
      while (read < all.Length) { int count = stream.Read(all, read, all.Length - read); if (count <= 0) break; read += count; }
      return all; }
  }

  public static void Run(string command_line, string folder, string directory, int timeout_seconds) {
    bool was_signed_in = SignedIn();
    SafeFileHandle input_read, input_write, output_read, output_write;
    CreatePipe(out input_read, out input_write, IntPtr.Zero, 0);
    CreatePipe(out output_read, out output_write, IntPtr.Zero, 0);
    IntPtr console; COORD size = new COORD(); size.X = 2000; size.Y = 60;
    int result = CreatePseudoConsole(size, input_read, output_write, 0, out console);
    if (result != 0) throw new Exception("CreatePseudoConsole " + result);
    input_read.Dispose(); output_write.Dispose();
    IntPtr list_size = IntPtr.Zero;
    InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref list_size);
    IntPtr list = Marshal.AllocHGlobal(list_size);
    InitializeProcThreadAttributeList(list, 1, 0, ref list_size);
    UpdateProcThreadAttribute(list, 0, (IntPtr)0x00020016, console, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero);
    STARTUPINFOEX startup = new STARTUPINFOEX(); startup.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX)); startup.lpAttributeList = list;
    PROCESS_INFORMATION information;
    if (!CreateProcessW(null, new StringBuilder(command_line), IntPtr.Zero, IntPtr.Zero, false, 0x00080000, IntPtr.Zero, directory, ref startup, out information))
      throw new Exception("CreateProcess " + Marshal.GetLastWin32Error());
    string screen = Path.Combine(folder, "out", "screen.txt"), typed = Path.Combine(folder, "input.txt");
    Thread reader = new Thread(delegate () {
      try {
        using (FileStream source = new FileStream(output_read, FileAccess.Read))
        using (FileStream sink = new FileStream(screen, FileMode.Append, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete)) {
          byte[] buffer = new byte[8192]; int count;
          while ((count = source.Read(buffer, 0, buffer.Length)) > 0) { sink.Write(buffer, 0, count); sink.Flush(); }
        }
      } catch { }
    });
    reader.IsBackground = true; reader.Start();
    FileStream writer = new FileStream(input_write, FileAccess.Write);
    long sent = 0; DateTime deadline = DateTime.Now.AddSeconds(timeout_seconds);
    while (WaitForSingleObject(information.hProcess, 300) != 0) {
      if (!was_signed_in && SignedIn()) { File.WriteAllText(Path.Combine(folder, "out", "done.txt"), "1"); Thread.Sleep(1500); TerminateProcess(information.hProcess, 0); break; }
      if (DateTime.Now > deadline || File.Exists(Path.Combine(folder, "cancel.txt"))) { TerminateProcess(information.hProcess, 1); break; }
      if (!File.Exists(typed)) continue;
      byte[] all = ReadShared(typed);
      if (all.Length > sent) { writer.Write(all, (int)sent, (int)(all.Length - sent)); writer.Flush(); sent = all.Length; }
    }
    uint code; GetExitCodeProcess(information.hProcess, out code);
    Thread.Sleep(500);
    ClosePseudoConsole(console);
    File.WriteAllText(Path.Combine(folder, "out", "exit.txt"), code.ToString());
  }
}
'@
[ConsoleHost]::Run($CommandLine, $Job, $env:USERPROFILE, ${LOGIN_TIMEOUT_S})
`;

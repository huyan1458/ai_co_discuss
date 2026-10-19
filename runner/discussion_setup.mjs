/** npm bootstrap and per-user setup; never logs in or starts an AI conversation. */
import { spawnSync } from 'node:child_process';
import { accessSync, constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { atomic_json, TASK_SUBCOMMANDS } from './discussion_adapters.mjs';
import { launch_settings, save_launch_settings } from './discussion_launch.mjs';
import { service_home } from './discussion_service.mjs';
import { install_skills } from './discussion_skills.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PROBE_TIMEOUT = 10000;
const MIN_NODE_MAJOR = 24;
const DEFAULT_PORT = 8765;
const ATTENTION_EXIT_CODE = 2;
const AGY_SETTINGS = ['.gemini', 'antigravity-cli', 'settings.json'];
const AGY_RULE_RECORD = 'agy-permission.json';
const AGY_SETTINGS_BACKUP = 'agy-settings.backup.json';
const CLIENTS = {
  codex: { name: 'Codex', commands: ['codex'], adapter: 'codex_cli', skills: ['.agents', 'skills'] },
  claude: { name: 'Claude', commands: ['claude'], adapter: 'claude', skills: ['.claude', 'skills'] },
  antigravity: { name: 'Gemini', commands: ['agy'], adapter: 'antigravity_cli', skills: ['.gemini', 'antigravity-cli', 'skills'] },
  cursor: { name: 'Grok（Cursor CLI）', commands: ['agent', 'cursor-agent'], skills: ['.cursor', 'skills'] },
};
const OPTIONS = { yes: { type: 'boolean' }, clients: { type: 'string' }, python: { type: 'string' },
  codex: { type: 'string' }, claude: { type: 'string' }, antigravity: { type: 'string' }, cursor: { type: 'string' },
  port: { type: 'string' }, prefix: { type: 'string' }, 'skills-home': { type: 'string' },
  'no-start': { type: 'boolean' }, 'no-open': { type: 'boolean' }, help: { type: 'boolean', short: 'h' } };
const HELP = `用法：codiscuss install [选项] / codiscuss setup [选项]
install 将当前 npm 包安装为持久命令，再运行 setup；setup 配置已有安装。
  --yes                     使用已检测且支持自动接入的软件，冲突保留并报告
  --clients codex,claude,antigravity,cursor  选择 CLI；none 只配置网站
  --python PATH             指定 Python 3.10+ 原生可执行文件
  --codex/--claude/--antigravity/--cursor PATH  指定 CLI（Windows 为 .exe，Cursor 也支持 .cmd）
  --port PORT               本机网站端口，默认 8765
  --no-start / --no-open     只配置 / 启动但不打开浏览器
  --prefix DIR              npm 安装前缀（install）
  --skills-home DIR         技能用户根目录（默认当前用户目录）
Gemini 使用 agy；Grok 使用 Cursor CLI（agent / cursor-agent）。仅检测 CLI。
Cursor 当前只安装技能，可手动参与；全自动接入尚未提供。已有软件设置保留。
显式软件路径可更新已支持的 CLI 配置。安装不会开始讨论。
结果输出 JSON，中文摘要写入 stderr；退出码 0=完成，2=配置待处理，1=失败。
`;

/** Read local settings stored outside the npm installation. */
export function local_settings(home = service_home()) {
  const path = join(home, 'local-settings.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
}

/** Validate prerequisites before installing a package or changing configuration. */
function setup_environment(options) {
  if (Number(process.versions.node.split('.')[0]) < MIN_NODE_MAJOR) throw new Error('需要 Node.js 24+，请升级后重试。');
  const home = service_home();
  const previous = local_settings(home);
  const python = detect_python(options.python || previous.python);
  const port = Number(options.port || previous.port || DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须为 1–65535 的整数');
  return { home, previous, python, port };
}

/** Find executable PATH entries, explicitly allowing Cursor's Windows .cmd launcher. */
function path_program(name, search_path = process.env.PATH || '', allow_cmd = false) {
  const suffixes = process.platform === 'win32' ? (allow_cmd ? ['.exe', '.cmd'] : ['.exe']) : [''];
  for (const directory of search_path.split(delimiter).filter(Boolean)) {
    for (const suffix of suffixes) {
      const path = join(directory.replace(/^"|"$/g, ''), `${name}${suffix}`);
      try {
        if (!statSync(path).isFile()) continue;
        accessSync(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
        return path;
      } catch { /* Continue through PATH when an entry is absent or not executable. */ }
    }
  }
  return '';
}

/** Locate npm Codex's native binary inside its package when only its shim is on PATH; dot directories are npm upgrade leftovers. */
function codex_binary(search_path) {
  const roots = search_path.split(delimiter).filter(Boolean)
    .map(directory => join(directory, 'node_modules', '@openai'));
  const queue = roots.filter(existsSync).map(path => [path, 0]);
  for (let index = 0; index < queue.length; index++) {
    const [directory, depth] = queue[index];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isFile() && entry.name === 'codex.exe') return path;
      if (entry.isDirectory() && !entry.name.startsWith('.') && depth < 7) queue.push([path, depth + 1]);
    }
  }
  return '';
}

/** Probe Python, recording sys.executable so aliases and py launcher arguments are unnecessary later. */
export function detect_python(explicit = '') {
  const candidates = explicit ? [[explicit]] : [['python3'], ['python'], ['py', '-3']];
  for (const [command, ...args] of candidates) {
    const result = spawnSync(command, [...args, '-c',
      'import json,sys; print(json.dumps({"path":sys.executable,"version":list(sys.version_info[:3])}))'],
    { encoding: 'utf8', windowsHide: true, timeout: PROBE_TIMEOUT });
    if (result.status !== 0) continue;
    try {
      const found = JSON.parse(result.stdout);
      if (found.version[0] === 3 && found.version[1] >= 10 && isAbsolute(found.path)) return found.path;
    } catch { /* Try the next installed Python. */ }
  }
  throw new Error('未找到 Python 3.10+；安装后重试，或用 --python 指定可执行文件。');
}

/** Probe the fixed --version argument; Cursor's Windows launcher runs through a fixed PowerShell command. */
function probe_cli(executable, allow_cmd) {
  const options = { encoding: 'utf8', windowsHide: true, timeout: PROBE_TIMEOUT };
  if (process.platform === 'win32' && /\.cmd$/i.test(executable) && allow_cmd) {
    return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '& $env:DISCUSS_PROBE_PATH --version; exit $LASTEXITCODE'],
    { ...options, env: { ...process.env, DISCUSS_PROBE_PATH: executable } });
  }
  if (process.platform === 'win32' && !/\.exe$/i.test(executable)) return null;
  return spawnSync(executable, ['--version'], options);
}

/** Detect only the four supported CLI families; no App, login or model invocation checks. */
export function detect_clients(options = {}, search_path = process.env.PATH || '') {
  return Object.entries(CLIENTS).map(([key, client]) => {
    const allow_cmd = key === 'cursor';
    const executable = options[key] ? resolve(options[key])
      : client.commands.map(command => path_program(command, search_path, allow_cmd)).find(Boolean)
        || (key === 'codex' && process.platform === 'win32' ? codex_binary(search_path) : '');
    const probe = executable ? probe_cli(executable, allow_cmd) : null;
    if (options[key] && probe?.status !== 0) throw new Error(`${client.name} 路径无法运行：${executable}`);
    return { key, ...client, executable: probe?.status === 0 ? executable : '' };
  });
}

/** Select detected clients interactively or through explicit noninteractive options. */
async function selected_clients(options, detected) {
  let choice = options.clients;
  const available = detected.filter(item => item.executable);
  const defaults = available.filter(item => item.adapter);
  for (const item of detected) process.stderr.write(`${item.name}：${item.executable || '未检测到 CLI'}\n`);
  if (choice === undefined && !options.yes) {
    if (!process.stdin.isTTY) throw new Error('非交互终端请使用 --yes 或 --clients；只配置网站可用 --clients none。');
    const prompt = createInterface({ input: process.stdin, output: process.stderr });
    try { choice = await prompt.question(`选择软件（逗号分隔，回车选择 ${defaults.map(item => item.key).join(',') || 'none'}）：`); }
    finally { prompt.close(); }
  }
  return requested_clients(choice, detected);
}

/** Validate an explicit selection without prompting or changing files. */
function requested_clients(choice, detected) {
  const available = detected.filter(item => item.executable);
  const keys = !choice ? available.filter(item => item.adapter).map(item => item.key)
    : choice === 'none' ? [] : choice.split(',').map(item => item.trim());
  for (const key of keys) {
    if (!CLIENTS[key]) throw new Error(`不支持的软件：${key}`);
    if (!available.some(item => item.key === key)) throw new Error(`${key} 未检测到，请安装其 CLI 或提供路径。`);
  }
  return detected.filter(item => keys.includes(item.key));
}

/** Compare executable destinations, including symlinks and Windows path casing. */
function same_executable(left, right) {
  const canonical = path => {
    if (!path) return '';
    const value = existsSync(path) ? realpathSync(path) : resolve(path);
    return process.platform === 'win32' ? value.toLowerCase() : value;
  };
  return canonical(left) === canonical(right);
}

/** Resolve an existing profile mismatch without silently switching the user's client. */
async function choose_profile(client, current, options) {
  const detected = { adapter: client.adapter, executable: client.executable };
  if (!client.adapter) return { client: client.name, status: 'manual' };
  const differs = current && (current.adapter !== client.adapter || !same_executable(current.executable, client.executable));
  let update = Boolean(options[client.key]), acknowledged = false;
  if (differs && !update && !options.yes && process.stdin.isTTY) {
    const prompt = createInterface({ input: process.stdin, output: process.stderr });
    try {
      const choice = await prompt.question(`${client.name} 已有配置：${current.adapter || '未设置类型'} / ${current.executable || '未设置路径'}\n检测到 CLI：${client.executable}\n保留已有配置或更新为此 CLI？[保留/更新，默认保留]：`);
      update = ['更新', 'update', 'u'].includes(choice.trim().toLowerCase());
      acknowledged = !choice.trim() || ['保留', 'keep', 'k'].includes(choice.trim().toLowerCase());
    } finally { prompt.close(); }
  }
  if (differs && !update) return { client: client.name, status: acknowledged ? 'retained' : 'pending',
    effective: { adapter: current.adapter, executable: current.executable }, detected,
    action: `如需更新，运行 codiscuss setup --clients ${client.key} --${client.key} "${client.executable}"；交互 setup 也可确认保留。` };
  return { client: client.name, status: 'configured', effective: detected };
}

/** agy only reads command rules from user settings; allow just the task's codiscuss website subcommands. */
export function agy_rule() {
  // Arguments may not contain separators, redirection or PowerShell expressions, so no second command fits.
  // A single --site value may precede the subcommand; codiscuss.cmd avoids blocked PowerShell scripts.
  const safe = '[^;&|<>$`\\r\\n]';
  return `command(regex:^codiscuss(\\.cmd)?( --site ${safe.replace('[^', '[^ ')}+)? (${TASK_SUBCOMMANDS.join('|')})( ${safe}*)?$)`;
}

/** Drafts live under the service home; agy does not treat --add-dir directories as writable. */
export function agy_rules(home) {
  // Verified with agy 1.4.2 on Windows: the rule matches forward slashes with the drive letter kept.
  const drafts = join(resolve(home), 'launches').replaceAll('\\', '/');
  return [agy_rule(), `write_file(${drafts})`];
}

/** Ask once before adding the rules; --yes counts as consent, other noninteractive runs only report. */
async function agy_consent(path, rules, options) {
  if (options.yes) return true;
  if (!process.stdin.isTTY) return false;
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await prompt.question(`允许 Gemini（agy）在全自动讨论中执行讨论命令并写讨论草稿？将向 ${path} 的 permissions.allow 追加 ${rules.length} 条只匹配讨论命令与草稿目录的规则 [Y/n]：`);
    return !['n', 'no', '否'].includes(answer.trim().toLowerCase());
  } finally { prompt.close(); }
}

/** Keep the installer-managed allow rules current, never touching other settings or user rules. */
export async function allow_agy_command(home, user_home, options) {
  const path = join(user_home, ...AGY_SETTINGS);
  const record = join(home, AGY_RULE_RECORD);
  const rules = agy_rules(home);
  let settings = {};
  try { if (existsSync(path)) settings = JSON.parse(readFileSync(path, 'utf8')); }
  catch { return { status: 'invalid', path, rules }; }
  const allow = settings.permissions?.allow ?? [];
  if (!Array.isArray(allow)) return { status: 'invalid', path, rules };
  const saved = existsSync(record) ? JSON.parse(readFileSync(record, 'utf8')) : {};
  const previous = saved.rules || (saved.rule ? [saved.rule] : []);
  const stale = previous.some(rule => !rules.includes(rule) && allow.includes(rule));
  mkdirSync(home, { recursive: true });
  if (rules.every(rule => allow.includes(rule)) && !stale) {
    if (previous.join('\n') !== rules.join('\n')) atomic_json(record, { rules });
    return { status: 'unchanged', path, rules };
  }
  if (!await agy_consent(path, rules, options)) return { status: options.yes || process.stdin.isTTY ? 'declined' : 'pending', path, rules };
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) copyFileSync(path, join(home, AGY_SETTINGS_BACKUP));
  const next = [...allow.filter(item => !previous.includes(item) && !rules.includes(item)), ...rules];
  atomic_json(path, { ...settings, permissions: { ...settings.permissions, allow: next } });
  atomic_json(record, { rules });
  return { status: 'allowed', path, rules };
}

/** Save the selected effective profiles and copy complete skills without overwriting edits. */
async function configure_clients(home, selected, options, existing) {
  const participants = { ...existing };
  const skills = [], profiles = [], permissions = [];
  const user_home = resolve(options['skills-home'] || homedir());
  for (const client of selected) {
    const profile = await choose_profile(client, participants[client.name], options);
    profiles.push(profile);
    if (profile.status === 'configured') participants[client.name] = { ...participants[client.name], ...profile.effective };
    skills.push({ client: client.name, results: install_skills(join(user_home, ...client.skills)) });
    if (client.key === 'antigravity') permissions.push({ client: client.name, ...await allow_agy_command(home, user_home, options) });
  }
  save_launch_settings(home, { participants });
  return { skills, profiles, permissions };
}

/** Exclude npm exec's temporary command wrappers when checking persistent availability. */
function persistent_search_path() {
  return (process.env.PATH || '').split(delimiter).filter(path => !path.split(/[\\/]/).includes('_npx')).join(delimiter);
}

/** Verify the resolved persistent npm command belongs to this installation and can run. */
export function check_command(search_path = persistent_search_path()) {
  const executable = path_program('codiscuss', search_path, true);
  const cli = join(ROOT, 'runner', 'codiscuss.mjs');
  const package_root = resolve(ROOT);
  const prefix = basename(dirname(package_root)) === 'node_modules' ? dirname(dirname(package_root)) : '';
  const directory = prefix ? (process.platform === 'win32' ? prefix : join(dirname(prefix), 'bin')) : '';
  if (!executable) return { status: 'missing', directory,
    action: directory ? `将 ${directory} 加入 PATH，重新打开终端后运行 codiscuss setup。`
      : '尚未找到持久命令，请先运行 install，再重新打开终端运行 codiscuss setup。' };
  const target = process.platform === 'win32' ? join(dirname(executable), 'node_modules', 'ai_co_discuss', 'runner', 'codiscuss.mjs') : executable;
  const shim_matches = process.platform !== 'win32' || (/\.cmd$/i.test(executable)
    && readFileSync(executable, 'utf8').replaceAll('\\', '/').includes('node_modules/ai_co_discuss/runner/codiscuss.mjs'));
  if (!shim_matches || !same_executable(target, cli)) return { status: 'shadowed', path: executable, directory,
    action: `PATH 中的 ${executable} 未指向本次安装；${directory ? `将 ${directory} 放在旧入口之前` : '先运行 install 安装本版本'}，再运行 setup。` };
  const probe = process.platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '& $env:DISCUSS_COMMAND_PATH --help; exit $LASTEXITCODE'],
      { encoding: 'utf8', windowsHide: true, timeout: PROBE_TIMEOUT, env: { ...process.env, PATH: search_path, DISCUSS_COMMAND_PATH: executable } })
    : spawnSync(executable, ['--help'], { encoding: 'utf8', timeout: PROBE_TIMEOUT, env: { ...process.env, PATH: search_path } });
  return probe.status === 0 ? { status: 'ready', path: executable }
    : { status: 'failed', path: executable, action: `命令无法运行：${executable}；请在终端运行此入口的 --help 检查 Node 和执行权限，再运行 setup。` };
}

/** Collect only unresolved setup work, keeping actual AI execution a separate validation. */
function setup_issues(result) {
  const issues = result.profiles.filter(profile => profile.status === 'pending')
    .map(profile => `${profile.client} 保留了与检测结果不同的配置。${profile.action}`);
  for (const group of result.skills) for (const skill of group.results) {
    if (skill.status === 'conflict') issues.push(`${group.client} 技能冲突，已保留 ${skill.path}；请核对并移走需替换的旧副本，再运行 setup。`);
  }
  for (const permission of result.permissions) {
    if (permission.status === 'invalid') issues.push(`${permission.client} 设置文件无法解析，未写入讨论命令规则：${permission.path}；修复后重新运行 setup。`);
    if (['declined', 'pending'].includes(permission.status)) issues.push(`${permission.client} 未放行讨论命令，全自动讨论会被拦截；运行 codiscuss setup --clients antigravity --yes 授权。`);
  }
  if (result.command.status !== 'ready') issues.push(result.command.action);
  return issues;
}

/** Configure Python, selected clients and skills, returning partial results on startup failure. */
async function setup(options) {
  const { home, previous, python, port } = setup_environment(options);
  const selected = await selected_clients(options, detect_clients(options));
  const configured = await configure_clients(home, selected, options, launch_settings(home).participants);
  atomic_json(join(home, 'local-settings.json'), { ...previous, python, port });
  const result = { home, python, clients: selected.map(item => item.name), ...configured,
    command: check_command(), ai_verified: false };
  result.issues = setup_issues(result);
  result.configured = result.issues.length === 0;
  result.status = result.configured ? 'configured' : 'needs_attention';
  if (!options['no-start']) {
    const { local_main } = await import('./discussion_local.mjs');
    try {
      result.local = await local_main([options['no-open'] ? 'start' : 'open'], () => {});
      if (result.configured) result.status = 'ready';
    } catch (error) {
      result.status = 'start_failed';
      result.issues.push(`本机启动失败：${error.message}；配置已保存，修复后重新运行 setup。`);
    }
  }
  return result;
}

/** Print a concise human receipt while keeping stdout machine-readable. */
function report_setup(result) {
  const labels = { ready: '安装配置完成，网站与讨论服务已就绪', configured: '配置完成，本次未启动网站',
    needs_attention: '配置待处理', start_failed: '本机启动失败' };
  const lines = [labels[result.status]];
  for (const profile of result.profiles) lines.push(profile.status === 'manual'
    ? `${profile.client}：仅安装技能，可手动参与，尚不支持全自动接入。`
    : `${profile.client}：${profile.status === 'configured' ? 'CLI 已配置' : '沿用已有配置'}（${profile.effective.adapter} / ${profile.effective.executable || '未设置路径'}）`);
  for (const permission of result.permissions) {
    if (['allowed', 'unchanged'].includes(permission.status)) lines.push(`${permission.client}：已放行讨论命令（${permission.path}）`);
  }
  for (const group of result.skills) lines.push(`${group.client} Skill：${group.results.filter(skill => skill.status !== 'conflict').length}/${group.results.length} 份文件就绪，目录 ${dirname(group.results[0].path)}`);
  if (result.command.path) lines.push(`持久命令：${result.command.path}（${result.command.status}）`);
  if (result.local?.running) lines.push(`本机网站：${result.local.url}`);
  lines.push(...result.issues, '真实 AI 执行尚未验证；可从网页创建讨论，或在新会话调用 Skill。');
  if (result.skills.length) lines.push('若新会话未发现技能，请让 AI 读取上述目录内的 discuss-host/SKILL.md 和 discuss-participant/SKILL.md。');
  process.stderr.write(`${lines.join('\n')}\n`);
}

/** Locate npm's JavaScript entrypoint so paths with spaces never need shell quoting. */
function npm_entry() {
  const candidates = [process.env.npm_execpath, join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')];
  const executable = path_program('npm');
  if (executable) candidates.push(realpathSync(executable));
  const entry = candidates.find(path => path && /\.(?:c?js|mjs)$/.test(path) && existsSync(path));
  if (!entry) throw new Error('未找到 npm；请安装带 npm 的 Node.js 24+ 后重试。');
  return entry;
}

/** Execute npm without lifecycle scripts; surface actionable npm errors. */
function npm_run(entry, args) {
  const result = spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || result.error?.message || 'npm 执行失败');
  return result.stdout.trim();
}

/** Install a real package copy, never a symlink into a disposable npx cache. */
function install(args, options) {
  setup_environment(options);
  requested_clients(options.clients, detect_clients(options));
  const entry = npm_entry();
  const temporary = mkdtempSync(join(tmpdir(), 'codiscuss-install-'));
  const prefix = options.prefix ? ['--prefix', resolve(options.prefix)] : [];
  try {
    const packed = JSON.parse(npm_run(entry, ['pack', ROOT, '--ignore-scripts', '--json', '--pack-destination', temporary]));
    npm_run(entry, ['install', '--global', ...prefix, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', join(temporary, packed[0].filename)]);
    const installed = join(npm_run(entry, ['root', '--global', ...prefix]), 'ai_co_discuss', 'runner', 'codiscuss.mjs');
    const install_prefix = npm_run(entry, ['prefix', '--global', ...prefix]);
    process.stderr.write(`命令目录：${process.platform === 'win32' ? install_prefix : join(install_prefix, 'bin')}\n`);
    const result = spawnSync(process.execPath, [installed, 'setup', ...args], { stdio: 'inherit', windowsHide: true,
      env: { ...process.env, PATH: persistent_search_path() } });
    process.exitCode = result.status ?? 1;
    if (result.error) throw result.error;
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

/** Dispatch bootstrap or setup, leaving website and launch commands untouched. */
export async function setup_main(command, args) {
  const { values } = parseArgs({ args, options: OPTIONS });
  if (values.help) return process.stdout.write(HELP);
  if (command === 'install') return install(args, values);
  const result = await setup(values);
  report_setup(result);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.status === 'start_failed' ? 1 : result.status === 'needs_attention' ? ATTENTION_EXIT_CODE : 0;
  return result;
}

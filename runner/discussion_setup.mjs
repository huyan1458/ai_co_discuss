/** npm bootstrap and per-user setup; never logs in or starts an AI conversation. */
import { spawn, spawnSync } from 'node:child_process';
import { accessSync, constants, copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { atomic_json } from './discussion_adapters.mjs';
import { launch_settings, save_launch_settings } from './discussion_launch.mjs';
import { assert_shared_home, service_home } from './discussion_service.mjs';
import { install_skills, remove_legacy_skills } from './discussion_skills.mjs';
import { ask, checkbox_prompt, intro, outro, pad, short_path, spinner, step, styled, text_width, tone } from './discussion_tui.mjs';
export { checkbox_prompt } from './discussion_tui.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PACKAGE = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const PROBE_TIMEOUT = 10000;
const MIN_NODE_MAJOR = 24;
const DEFAULT_PORT = 8765;
const ATTENTION_EXIT_CODE = 2;
const AGY_SETTINGS = ['.gemini', 'antigravity-cli', 'settings.json'];
const AGY_RULE_RECORD = 'agy-permission.json';
const AGY_SETTINGS_BACKUP = 'agy-settings.backup.json';
const SKILL_RECORD = 'skills-manifest.json';
const CLIENTS = {
  codex: { name: 'Codex', commands: ['codex'], adapter: 'codex_cli', skills: ['.agents', 'skills'] },
  claude: { name: 'Claude', commands: ['claude'], adapter: 'claude', skills: ['.claude', 'skills'] },
  antigravity: { name: 'Gemini', commands: ['agy'], adapter: 'antigravity_cli', skills: ['.gemini', 'config', 'skills'],
    legacy_skills: ['.gemini', 'antigravity-cli', 'skills'] },
  cursor: { name: 'Grok（Cursor CLI）', commands: ['agent', 'cursor-agent'], skills: ['.cursor', 'skills'] },
};
const OPTIONS = { yes: { type: 'boolean' }, clients: { type: 'string' }, python: { type: 'string' },
  codex: { type: 'string' }, claude: { type: 'string' }, antigravity: { type: 'string' }, cursor: { type: 'string' },
  port: { type: 'string' }, prefix: { type: 'string' }, 'skills-home': { type: 'string' },
  'no-start': { type: 'boolean' }, 'no-open': { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } };
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
中文摘要写入 stderr；输出被重定向或加 --json 时结果 JSON 写入 stdout；退出码 0=完成，2=配置待处理，1=失败。
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
  assert_shared_home(home);
  const previous = local_settings(home);
  const python = detect_python(options.python || previous.python);
  const port = Number(options.port || previous.port || DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须为 1–65535 的整数');
  return { home, previous, python, port };
}

/** Summarise the checked runtime in one short line for the styled installer. */
function environment_line(python, port) {
  const probe = spawnSync(python, ['-c', 'import sys; print(".".join(map(str, sys.version_info[:3])))'],
    { encoding: 'utf8', windowsHide: true, timeout: PROBE_TIMEOUT });
  return `Node ${process.version.slice(1)} · Python ${probe.stdout?.trim() || short_path(python)} · 端口 ${port}`;
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
  if (choice === undefined && !options.yes) {
    if (!process.stdin.isTTY) throw new Error('非交互终端请使用 --yes 或 --clients；只配置网站可用 --clients none。');
    const items = detected.map(item => ({ label: item.name, hint: item.executable ? short_path(item.executable) : '未检测到 CLI',
      checked: Boolean(item.executable && item.adapter), disabled: !item.executable }));
    const checked = await checkbox_prompt('选择要接入的软件', items);
    choice = detected.filter((_, index) => checked[index]).map(item => item.key).join(',') || 'none';
  } else if (!styled) for (const item of detected) process.stderr.write(`${item.name}：${item.executable || '未检测到 CLI'}\n`);
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
    const choice = await ask(`${client.name} 已有配置：${current.adapter || '未设置类型'} / ${current.executable || '未设置路径'}\n检测到 CLI：${client.executable}\n保留已有配置或更新为此 CLI？`, '[保留/更新，默认保留]');
    update = ['更新', 'update', 'u'].includes(choice.trim().toLowerCase());
    acknowledged = !choice.trim() || ['保留', 'keep', 'k'].includes(choice.trim().toLowerCase());
  }
  if (differs && !update) return { client: client.name, status: acknowledged ? 'retained' : 'pending',
    effective: { adapter: current.adapter, executable: current.executable }, detected,
    action: `如需更新，运行 codiscuss setup --clients ${client.key} --${client.key} "${client.executable}"；交互 setup 也可确认保留。` };
  return { client: client.name, status: 'configured', effective: detected };
}

/**
 * Remove global agy rules that earlier versions added; agy permissions now live only in each discussion project.
 * Only rules recorded by the installer are removed, after a backup; other settings and user rules stay untouched.
 */
export function remove_legacy_agy_rules(home, user_home) {
  const record = join(home, AGY_RULE_RECORD);
  if (!existsSync(record)) return null;
  const path = join(user_home, ...AGY_SETTINGS);
  const saved = JSON.parse(readFileSync(record, 'utf8'));
  const legacy = saved.rules || (saved.rule ? [saved.rule] : []);
  let settings = {};
  try { if (existsSync(path)) settings = JSON.parse(readFileSync(path, 'utf8')); }
  catch { return { client: 'Gemini', status: 'invalid', path }; }
  const allow = settings.permissions?.allow ?? [];
  if (!Array.isArray(allow)) return { client: 'Gemini', status: 'invalid', path };
  const next = allow.filter(rule => !legacy.includes(rule));
  if (next.length !== allow.length) {
    copyFileSync(path, join(home, AGY_SETTINGS_BACKUP));
    atomic_json(path, { ...settings, permissions: { ...settings.permissions, allow: next } });
  }
  rmSync(record);
  return { client: 'Gemini', status: next.length !== allow.length ? 'removed' : 'unchanged', path };
}

/** Save the selected effective profiles and copy complete skills without overwriting edits. */
async function configure_clients(home, selected, options, existing) {
  const participants = { ...existing };
  const skills = [], profiles = [];
  const user_home = resolve(options['skills-home'] || homedir());
  for (const client of selected) {
    const profile = await choose_profile(client, participants[client.name], options);
    profiles.push(profile);
    if (profile.status === 'configured') participants[client.name] = { ...participants[client.name], ...profile.effective };
    const record = join(home, SKILL_RECORD);
    const results = install_skills(join(user_home, ...client.skills), record);
    const legacy = client.legacy_skills ? remove_legacy_skills(join(user_home, ...client.legacy_skills), record) : [];
    skills.push({ client: client.name, results, legacy });
  }
  save_launch_settings(home, { participants });
  const legacy = remove_legacy_agy_rules(home, user_home);
  return { skills, profiles, permissions: legacy ? [legacy] : [] };
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
  for (const group of result.skills) for (const skill of group.legacy) {
    if (skill.status === 'kept') issues.push(`${group.client} 旧技能目录中的副本有改动，已保留 ${skill.path}；软件会同时加载新旧两份，请核对后删除。`);
  }
  for (const permission of result.permissions) {
    if (permission.status === 'invalid') issues.push(`${permission.client} 设置文件无法解析，未能移除旧版全局放行规则：${permission.path}；修复后重新运行 setup，否则全自动讨论会拒绝交付给 agy。`);
  }
  if (result.command.status !== 'ready') issues.push(result.command.action);
  return issues;
}

/** Ask before restarting a running website; non-interactive runs never stop it and report the pending restart instead. */
async function confirm_restart(reason, options) {
  if (options.yes || !process.stdin.isTTY) return false;
  const choice = await ask(`${reason}\n重启后生效，重启会暂停托管中的讨论。现在重启？`, '[Y/N，默认 Y]');
  return !choice.trim() || ['重启', 'restart', 'r', 'y', 'yes'].includes(choice.trim().toLowerCase());
}

/** Configure Python, selected clients and skills, returning partial results on startup failure. */
async function setup(options) {
  intro('配置 AI CoDiscuss', PACKAGE.version, PACKAGE.description);
  const { home, previous, python, port } = setup_environment(options);
  if (styled && !process.env.CODISCUSS_TUI_NESTED) step('运行环境就绪', [environment_line(python, port)]);
  const scan = spinner('检测已安装的 AI 软件');
  const detected = detect_clients(options);
  const width = Math.max(...detected.map(item => text_width(item.name)));
  const listed = options.clients !== undefined || options.yes
    ? detected.map(item => `${pad(item.name, width)}  ${tone.dim(item.executable ? short_path(item.executable) : '未检测到 CLI')}`) : [];
  scan.done(`检测到 ${detected.filter(item => item.executable).length} 个可接入的 CLI`, listed);
  const selected = await selected_clients(options, detected);
  const configured = await configure_clients(home, selected, options, launch_settings(home).participants);
  atomic_json(join(home, 'local-settings.json'), { ...previous, python, port });
  step('已写入软件配置与技能', configured.skills.map(group => `${pad(group.client, width)}  ${tone.dim(short_path(dirname(group.results[0].path)))}`));
  const result = { home, python, clients: selected.map(item => item.name), ...configured,
    command: check_command(), ai_verified: false };
  result.issues = setup_issues(result);
  result.configured = result.issues.length === 0;
  result.status = result.configured ? 'configured' : 'needs_attention';
  if (!options['no-start']) {
    const { local_main, restart_reason } = await import('./discussion_local.mjs');
    const reason = restart_reason(home);
    if (reason && !await confirm_restart(reason, options)) {
      result.issues.push(`${reason}；重启后才生效，重启会暂停托管中的讨论。确认后运行 codiscuss local stop，再运行 codiscuss local open。`);
      result.configured = false;
      result.status = 'needs_attention';
      return result;
    }
    const launch = spinner(reason ? '重启本机网站与讨论服务' : '启动本机网站与讨论服务');
    try {
      if (reason) await local_main(['stop'], () => {});
      result.local = await local_main([options['no-open'] ? 'start' : 'open'], () => {});
      launch.done('网站与讨论服务已在后台运行', [`${tone.cyan(result.local.url)}${options['no-open'] ? tone.dim('  未打开浏览器，可直接访问此地址') : tone.dim('  已在浏览器打开')}`]);
      if (result.configured) result.status = 'ready';
    } catch (error) {
      launch.fail(error.message);
      result.status = 'start_failed';
      result.issues.push(`本机启动失败：${error.message}；配置已保存，修复后重新运行 setup。`);
    }
  }
  return result;
}

/** Print a concise human receipt while keeping stdout machine-readable. */
function report_setup(result, options = {}) {
  if (styled) return report_styled(result, options);
  const labels = { ready: '安装配置完成，网站与讨论服务已就绪', configured: '配置完成，本次未启动网站',
    needs_attention: '配置待处理', start_failed: '本机启动失败' };
  const lines = [labels[result.status]];
  for (const profile of result.profiles) lines.push(profile.status === 'manual'
    ? `${profile.client}：仅安装技能，可手动参与，尚不支持全自动接入。`
    : `${profile.client}：${profile.status === 'configured' ? 'CLI 已配置' : '沿用已有配置'}（${profile.effective.adapter} / ${profile.effective.executable || '未设置路径'}）`);
  for (const permission of result.permissions) {
    if (permission.status === 'removed') lines.push(`${permission.client}：已移除旧版全局放行规则（${permission.path}）`);
  }
  for (const group of result.skills) lines.push(`${group.client} Skill：${group.results.filter(skill => skill.status !== 'conflict').length}/${group.results.length} 份文件就绪，目录 ${dirname(group.results[0].path)}`);
  if (result.command.path) lines.push(`持久命令：${result.command.path}（${result.command.status}）`);
  if (result.local?.running) {
    lines.push(`本机网站：${result.local.url}${options['no-open'] ? '' : '（已在浏览器打开）'}`,
      '网站与讨论服务在后台运行，关闭此终端不影响；查看状态 codiscuss local status，停止 codiscuss local stop；电脑重启后运行 codiscuss local open 重新启动。');
  }
  lines.push(...result.issues, '真实 AI 执行尚未验证；可从网页创建讨论，或在新会话调用 Skill。');
  if (result.skills.length) lines.push('若新会话未发现技能，请让 AI 读取上述目录内的 discuss-host/SKILL.md 和 discuss-participant/SKILL.md。');
  process.stderr.write(`${lines.join('\n')}\n`);
}

/** Close the styled installer with aligned results, open issues and the commands to manage the site. */
function report_styled(result, options) {
  const titles = { ready: ['安装完成', tone.green('◆')], configured: ['配置完成，本次未启动网站', tone.green('◆')],
    needs_attention: ['配置完成，仍有待处理项', tone.yellow('▲')], start_failed: ['本机启动失败', tone.red('■')] };
  const [title, mark] = titles[result.status];
  const rows = [];
  if (result.local?.running) rows.push(['网站', tone.cyan(result.local.url), options['no-open'] ? '' : '已在浏览器打开']);
  for (const profile of result.profiles) rows.push(profile.status === 'manual' ? [profile.client, '仅安装技能，可手动参与', '尚不支持全自动接入']
    : [profile.client, `${profile.status === 'configured' ? 'CLI 已配置' : '沿用已有配置'} · ${profile.effective.adapter}`, short_path(profile.effective.executable) || '未设置路径']);
  for (const permission of result.permissions) {
    if (permission.status === 'removed') rows.push([permission.client, '已移除旧版全局放行规则', short_path(permission.path)]);
  }
  if (result.skills.length) rows.push(['技能', result.skills.map(group => `${group.client} ${group.results.filter(skill => skill.status !== 'conflict').length}/${group.results.length}`).join(' · '), 'discuss-host · discuss-participant · discuss-report']);
  if (result.command.path) rows.push(['命令', `codiscuss ${tone.dim(`(${result.command.status})`)}`, short_path(result.command.path)]);
  const notes = result.issues.map(issue => tone.yellow(`▲ ${issue}`));
  if (result.local?.running) notes.push(tone.dim('网站与讨论服务在后台运行，关闭此终端不影响'),
    `${tone.cyan('codiscuss local status')}  ${tone.dim('查看状态')}`, `${tone.cyan('codiscuss local stop')}    ${tone.dim('停止')}`,
    `${tone.cyan('codiscuss local open')}    ${tone.dim('重启电脑后重新启动')}`);
  const closing = result.local?.running ? `在网页新建讨论，或在 AI 会话里调用 ${tone.cyan('discuss-host')} ${tone.dim('· 真实 AI 执行尚未验证')}`
    : `运行 ${tone.cyan('codiscuss local open')} 启动网站`;
  outro(title, rows, notes, closing, mark);
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

/** Execute npm without lifecycle scripts asynchronously, so a progress spinner can animate. */
function npm_run(entry, args) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [entry, ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', fail);
    child.on('close', code => (code === 0 ? done(stdout.trim()) : fail(new Error(stderr || 'npm 执行失败'))));
  });
}

/** Install a real package copy, never a symlink into a disposable npx cache. */
async function install(args, options) {
  intro('安装 AI CoDiscuss', PACKAGE.version, PACKAGE.description);
  const { python, port } = setup_environment(options);
  requested_clients(options.clients, detect_clients(options));
  if (styled) step('运行环境就绪', [environment_line(python, port)]);
  const entry = npm_entry();
  const temporary = mkdtempSync(join(tmpdir(), 'codiscuss-install-'));
  const prefix = options.prefix ? ['--prefix', resolve(options.prefix)] : [];
  const progress = spinner('安装 codiscuss 命令');
  try {
    const packed = JSON.parse(await npm_run(entry, ['pack', ROOT, '--ignore-scripts', '--json', '--pack-destination', temporary]));
    await npm_run(entry, ['install', '--global', ...prefix, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', join(temporary, packed[0].filename)]);
    // npm masks UUID-like path segments as *** in its output, so an explicit prefix is resolved locally.
    const install_prefix = options.prefix ? resolve(options.prefix) : await npm_run(entry, ['prefix', '--global']);
    const global_root = process.platform === 'win32' ? join(install_prefix, 'node_modules') : join(install_prefix, 'lib', 'node_modules');
    const installed = join(global_root, 'ai_co_discuss', 'runner', 'codiscuss.mjs');
    const directory = process.platform === 'win32' ? install_prefix : join(install_prefix, 'bin');
    progress.done('已安装 codiscuss 命令', [tone.dim(short_path(directory))]);
    if (!styled) process.stderr.write(`命令目录：${directory}\n`);
    const result = spawnSync(process.execPath, [installed, 'setup', ...args], { stdio: 'inherit', windowsHide: true,
      env: { ...process.env, PATH: persistent_search_path(), CODISCUSS_TUI_NESTED: '1' } });
    process.exitCode = result.status ?? 1;
    if (result.error) throw result.error;
  } catch (error) { progress.fail(error.message); throw error; }
  finally { rmSync(temporary, { recursive: true, force: true }); }
}

/** Dispatch bootstrap or setup, leaving website and launch commands untouched. */
export async function setup_main(command, args) {
  const { values } = parseArgs({ args, options: OPTIONS });
  if (values.help) return process.stdout.write(HELP);
  if (command === 'install') return install(args, values);
  const result = await setup(values);
  report_setup(result, values);
  if (values.json || !process.stdout.isTTY) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.status === 'start_failed' ? 1 : result.status === 'needs_attention' ? ATTENTION_EXIT_CODE : 0;
  return result;
}

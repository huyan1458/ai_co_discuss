#!/usr/bin/env node
/** Unified entrypoint for the local service and the discussion website client. */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { main as service_main, read_registry, run_service, service_home, service_pid } from './discussion_service.mjs';

const HELP = `AI CoDiscuss CLI

用法：codiscuss [命令] [选项]

  （无命令）            在当前终端启动服务，Ctrl+C 停止
  service COMMAND       启动、停止、查询服务，或登记房间
  room COMMAND          创建、读取或更新讨论房间
  message COMMAND       检索原文、提交观点
  turn COMMAND          安排发言、读取待办与回答
  state COMMAND         读取或保存共享状态
  floor COMMAND         查看、领取或归还发言权
  run COMMAND           配置、启动或暂停网站上的讨论
  execution COMMAND     进入或查询一次 AI 执行
  health                检查网站健康状态
  schema [COMMAND]      离线查看命令与参数
  api PATH              访问尚未封装的网站接口

  codiscuss service --help
  codiscuss room --help
  codiscuss health --site http://127.0.0.1:8765

网站操作使用 --site 或 DISCUSS_URL，并需要 Python 3.10+。
原有 start、status、stop、add 等服务命令继续兼容。
`;
const SERVICE_HELP = `AI CoDiscuss 讨论服务

用法：codiscuss service [命令] [选项]

  （无命令） / run       在当前终端运行，Ctrl+C 停止
  start                 在后台启动，已运行时复用
  status                查看服务与房间状态
  stop                  暂停托管中的讨论并停止服务
  add --config FILE     登记房间的私有接入配置
  remove --config FILE  移除已登记配置
  list                  列出已登记配置
  open                  后台启动并打开讨论网站
  shortcut              创建 Windows 桌面快捷方式
  autostart on|off      开启或关闭 Windows 登录自启

  --json                以 JSON 输出命令结果（前台运行除外）
  -h, --help            显示帮助

登记或启动服务不会自动开始讨论，仍需在网页明确启动。
`;
const STATUS_LABELS = { running: '运行中', paused: '已暂停', idle: '等待启动', error: '异常' };
const SERVICE_COMMANDS = new Set(['start', 'status', 'stop', 'add', 'remove', 'list', 'open', 'shortcut', 'autostart']);
const WEBSITE_CLIENT = fileURLToPath(new URL('../discuss.py', import.meta.url));

/** Forward untouched arguments, streams and exit codes to the existing Python client. */
function website_cli(args) {
  const executable = process.platform === 'win32' ? 'python' : 'python3';
  const result = spawnSync(executable, ['-X', 'utf8', WEBSITE_CLIENT, ...args], {
    stdio: 'inherit', windowsHide: true, env: { ...process.env, DISCUSS_CLI_NAME: 'codiscuss' },
  });
  if (result.error) throw new Error(`网站操作需要 Python 3.10+，无法启动 ${executable}：${result.error.message}`);
  process.exitCode = result.status ?? (result.signal === 'SIGINT' ? 130 : 1);
}

/** Format service receipts without exposing room credentials. */
function print_result(result) {
  const lines = [];
  if (typeof result.running === 'boolean') {
    lines.push(result.running ? `讨论服务运行中（PID ${result.pid}）` : '讨论服务未运行');
  }
  if (result.home) lines.push(`服务目录：${result.home}`);
  if (result.configs) lines.push(`已登记 ${result.configs.length} 个房间`, ...result.configs);
  for (const room of result.rooms || []) {
    lines.push(`${room.site || ''}/${room.room || room.config}：${STATUS_LABELS[room.status] || room.status}${room.error ? `；${room.error}` : ''}`);
  }
  if (result.added) lines.push(`已登记房间：${result.site}/${result.added}`);
  if (result.removed) lines.push(`已移除：${result.removed}`);
  if (result.shortcut) lines.push(`已创建快捷方式：${result.shortcut}`);
  if (result.autostart) lines.push(`已开启登录自启：${result.autostart}`);
  if (result.opened) lines.push(...result.opened.map(site => `已打开：${site}`));
  process.stdout.write(`${lines.join('\n')}\n`);
}

/** Run the resident service or one of its management commands. */
async function service_cli(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    config: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help || positionals[0] === 'help') return process.stdout.write(SERVICE_HELP);
  const command = positionals[0] || 'run';
  if (command === 'run') {
    const home = service_home();
    if (service_pid(home)) return service_main(['status'], print_result);
    const count = read_registry(home).length;
    process.stdout.write(`AI CoDiscuss 讨论服务\n服务目录：${home}\n已登记 ${count} 个房间\nCtrl+C 停止服务\n`);
    if (!count) process.stdout.write('尚未登记房间；可在另一终端运行 codiscuss service add --config FILE。\n');
    return run_service(home, line => process.stdout.write(`${line}\n`));
  }
  const forwarded = [...positionals];
  if (values.config) forwarded.push('--config', values.config);
  return service_main(forwarded, values.json ? value => process.stdout.write(`${JSON.stringify(value)}\n`) : print_result);
}

/** Keep startup convenient while separating local service management from website operations. */
async function main(args = process.argv.slice(2)) {
  const [command] = args;
  if (['--help', '-h', 'help'].includes(command)) return process.stdout.write(HELP);
  if (command === 'service') return service_cli(args.slice(1));
  if (!command || (command === 'run' && args.length === 1)) return service_cli([]);
  if (SERVICE_COMMANDS.has(command) || command === '--json') return service_cli(args);
  return website_cli(args);
}

main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });

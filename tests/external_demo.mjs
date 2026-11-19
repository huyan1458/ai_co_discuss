/**
 * A standing demo of external members for browser checks, built on tests/external_harness.mjs: computer B's local site
 * (port 8830) with a room that opens a sample project, computer A's local site (port 8831), and a stand-in for B's
 * online site between them. A's pull loop for invited rooms runs in this process and wakes a fake AI that only runs
 * `codiscuss` commands. Everything lives in temporary directories, removed when the demo stops (Ctrl+C).
 *
 *   node tests/external_demo.mjs [--b-port 8830] [--a-port 8831] [--exit-after SECONDS]
 *
 * `--exit-after` stops and cleans up by itself after that many seconds (a smoke check; on Windows another program cannot
 * send this process Ctrl+C, and killing it leaves the temporary directories behind).
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { b_runner_delivery, create_room, machine_identity, public_machine, register_room_config, run_codiscuss, sample_project,
  start_fake_relay, start_python_site, temp_home, write_fake_ai } from './external_harness.mjs';

process.env.CODISCUSS_LANG ??= 'zh-CN';

const { values } = parseArgs({ options: { 'b-port': { type: 'string', default: '8830' }, 'a-port': { type: 'string', default: '8831' },
  'exit-after': { type: 'string' } } });

// The harness registers cleanups on a test context; the demo keeps them and runs them, newest first, on exit.
const cleanups = [];
const context = { after: fn => cleanups.push(fn) };
const stop = new AbortController();
let stopping = false;

/** Stop the pull loop, the sites and the stand-in, then remove the temporary directories. */
async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  stop.abort();
  for (const fn of cleanups.reverse()) {
    try { await fn(); } catch { /* Keep cleaning the rest. */ }
  }
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
if (values['exit-after']) setTimeout(() => shutdown(0), Number(values['exit-after']) * 1000);

/** What the fake AI does for each request: list and read B's project, try a secret file, then answer in B's room. */
const FAKE_PLAN = [
  ['repo', 'ls'],
  ['repo', 'ls', '', '--root', '0'],
  ['repo', 'read', 'README.md', '--root', '0'],
  ['repo', 'read', 'src/main.js', '--root', '0'],
  ['repo', 'read', '.env', '--root', '0'],
  ['message', 'post', '--body', '（演示用假 AI）已列出对方开放的目录，读取了 README.md 与 src/main.js：ANSWER = 42。尝试读取 .env 被拒绝（固定排除的敏感文件）。'],
];

/**
 * The adapter layer's place in A's pull loop: run the fake AI with the task's access file and A's service directory,
 * and end the run when it exits. (Real AI tools need an executable; a script cannot stand in for one on Windows.)
 */
function fake_delivery(a_home, fake) {
  return async (profile, binding, task) => {
    const child = spawn(process.execPath, [fake.script], { windowsHide: true, stdio: 'ignore', env: { ...process.env, DISCUSS_SERVICE_HOME: a_home,
      DISCUSS_ACCESS_FILE: task.access_path, ...(task.tool_lockdown ? { CODISCUSS_TOOL_LOCKDOWN: '1' } : {}) } });
    child.once('close', code => (code === 0 ? task.on_exit() : task.on_failure(new Error(`假 AI 退出码 ${code}（有一步被拒属正常，详见 ${fake.log}）`))));
    return { session_id: '' };
  };
}

async function main() {
  // Computer B: its local site, its pairing with the stand-in online site, and a room that opens the sample project.
  const b_home = temp_home(context, 'demo-b');
  const relay = await start_fake_relay(context);
  const b_site = await start_python_site(context, b_home, {}, { port: Number(values['b-port']), local_launch: true });
  const link = await machine_identity(b_home, relay.url);
  relay.deliver = await b_runner_delivery(b_home, relay.url);
  relay.machines = [public_machine(link)];
  const files = sample_project(join(b_home, 'work'));
  const room = await create_room(b_site.url, { title: '外部成员演示', goal: '借用另一台电脑的 AI 只读本项目并回答', members: [] });
  register_room_config(b_home, { site: b_site.url, room: room.room.id, token: room.owner, cwd: files.project });

  // Computer A: its local site, its Claude Code set to the fake AI, and its pull loop for invited rooms.
  const a_home = temp_home(context, 'demo-a');
  const fake = write_fake_ai(join(a_home, 'fake-ai'), FAKE_PLAN, { name: 'fake-claude' });
  writeFileSync(join(a_home, 'launch-settings.json'), JSON.stringify({ participants: { Claude: { adapter: 'claude', executable: fake.command } } }));
  const a_site = await start_python_site(context, a_home, {}, { port: Number(values['a-port']), local_launch: true });
  const { start_external_client } = await import('../runner/external_client.mjs');
  start_external_client(a_home, { signal: stop.signal, deps: { deliver: fake_delivery(a_home, fake) },
    log: line => process.stdout.write(`[A 拉取] ${line}\n`) });

  // A spare invite made with B's command, for when the page cannot make one (it is single use and lasts 10 minutes).
  const input = join(b_home, 'demo-invite.json');
  writeFileSync(input, JSON.stringify({ room_id: room.room.id, token: room.owner, level: 'read', duration: '1h', site_url: relay.url }));
  const invite = await run_codiscuss(b_home, ['launch', 'room-invite', '--file', input]);
  const spare = invite.status === 0 ? invite.json : null;

  const lines = [
    '',
    '外部成员演示已启动（Ctrl+C 结束并清理临时目录）',
    '',
    `  B 的本机网页：${b_site.url}/   房间「外部成员演示」 ${b_site.url}/#/rooms/${room.room.id}`,
    `  A 的本机网页：${a_site.url}/`,
    `  B 的线上站点（替身，只转发密文）：${relay.url}`,
    `  B 开放的示例项目：${files.project}（含 README.md、src/main.js，以及会被拒绝的 .env、id_rsa、data/）`,
    '',
    '操作顺序：',
    '  1. B 网页：打开房间 → 邀请外部成员（等级“只读项目”）→ 复制链接。',
    '  2. A 网页：外部房间 → 粘贴链接加入（派出 Claude；它已指向假 AI）。新电脑默认等级为“默认（每次须你同意）”。',
    '  3. B 网页：在房间里点名该外部成员（如 @Claude-ext 请读一下 src/main.js）。',
    '  4. A 网页：几秒内出现待确认请求 → 同意。A 的拉取循环每 5 秒一次，同意后下一次拉取唤醒假 AI。',
    '  5. B 网页：看到假 AI 的回答（绑定执行）；在外部成员卡片上查看读取记录（含 .env 被拒）→ 撤销。',
    '',
    spare ? `若 B 网页无法生成邀请，可用预先生成的邀请（10 分钟内有效、只能用一次）：\n  链接：${spare.url}\n  配对码：${spare.code}（手动输入时站点填 ${relay.url}）`
      : `预生成邀请失败：${invite.stderr.trim() || invite.stdout.trim()}`,
    '',
    '命令行代替界面（PowerShell 先设 $env:DISCUSS_SERVICE_HOME，CMD 用 set）：',
    `  A 加入：DISCUSS_SERVICE_HOME=${a_home}  node runner/codiscuss.mjs join <链接> --adapter claude`,
    `  A 查看与同意：node runner/codiscuss.mjs invited list / invited approve <记录> <待确认编号>`,
    `  B 点名：在 B 网页发消息并 @ 外部成员，或 POST ${b_site.url}/api/rooms/${room.room.id}/messages（房主凭据见下）`,
    '',
    `B 房间房主凭据（仅本演示）：${room.owner}`,
    `假 AI 每步日志：${fake.log}`,
    `临时目录：B ${b_home}；A ${a_home}`,
    '',
    '说明：替身站点为 http 回环地址，不做 Worker 的签名名单放行；A 的拉取循环在本进程内运行，适配层投递换成假 AI 脚本，',
    '因此不验证各 AI 软件的收窄参数；B 没有运行讨论服务（房间里没有 B 自己的 AI 成员）。',
    '',
  ];
  process.stdout.write(lines.join('\n'));
}

main().catch(async error => {
  process.stderr.write(`演示启动失败：${error.stack || error.message}\n`);
  await shutdown(1);
});
// Keep running until stopped.
setInterval(() => {}, 1 << 30);

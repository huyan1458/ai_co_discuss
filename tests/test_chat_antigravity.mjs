import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { listen_local } from './local_port.mjs';
import { CHAT_TIMING, ROOM_TIMING } from '../runner/adapters/antigravity_app.mjs';
import { conversation_open_elsewhere } from '../runner/adapters/antigravity_cli.mjs';
import { deliver_task } from '../runner/adapters/index.mjs';

Object.assign(CHAT_TIMING, { receipt_ms: 3000, poll_ms: 20, start_ms: 2000, rpc_ms: 2000, read_failures: 2 });

const step = (type, extra = {}, status = 'CORTEX_STEP_STATUS_DONE') => ({ type: `CORTEX_STEP_TYPE_${type}`, status, ...extra });
const response = (text, toolCalls = []) => step('PLANNER_RESPONSE', { plannerResponse: { response: text, toolCalls } });

/**
 * A stand-in for the App: an IPC directory whose Sidecar accepts every request at once, and a language server whose
 * conversation runs `turn` (the steps one chat line adds) once a request arrives.
 */
async function fake_app(t, { turn = [], token = 'csrf-1', fail = '', session = 'conv-1' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'chat-agy-app-'));
  const ipc = join(root, 'ipc');
  mkdirSync(ipc);
  const app = { calls: [], steps: [response('earlier turn')], running: false, sent: [] };
  const server = createServer(async (request, reply) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const method = request.url.split('/').at(-1);
    app.calls.push({ method, token: request.headers['x-codeium-csrf-token'], body: JSON.parse(body) });
    if ([].concat(fail).includes(method)) { reply.writeHead(404); return reply.end('unknown method'); }
    // Like the App: Cancel refuses an idle conversation; ForceStop also ends commands moved to the background.
    if (method === 'CancelCascadeInvocation' && !app.running) { reply.writeHead(500); return reply.end('executor is not currently running'); }
    if (method === 'CancelCascadeInvocation') app.running = false;
    if (method === 'ForceStopCascadeTree') { app.running = false; for (const item of app.steps) if (item.taskDetails) item.status = 'CORTEX_STEP_STATUS_CANCELED'; }
    const data = method === 'GetCascadeTrajectory' ? { status: app.running ? 'CASCADE_RUN_STATUS_RUNNING' : 'CASCADE_RUN_STATUS_IDLE' }
      : method === 'GetCascadeTrajectorySteps' ? { steps: app.steps } : {};
    reply.writeHead(200, { 'Content-Type': 'application/json' });
    reply.end(JSON.stringify(data));
  });
  const { port } = (await listen_local(server)).address();
  writeFileSync(join(ipc, 'ready.json'), JSON.stringify({ pid: process.pid, project_id: '',
    ...(token ? { language_server: { address: `127.0.0.1:${port}`, csrf_token: token } } : {}) }));
  // The Sidecar's side: accept each request; the first starts the turn, which ends after its steps appear.
  const sidecar = setInterval(() => {
    for (const name of readdirSync(ipc).filter(item => item.endsWith('.request.json'))) {
      const request = JSON.parse(readFileSync(join(ipc, name), 'utf8'));
      if (existsSync(join(ipc, `${request.id}.result.json`))) continue;
      app.sent.push(request);
      writeFileSync(join(ipc, `${request.id}.result.json`), JSON.stringify({ id: request.id, session_id: request.session_id || session, status: 'accepted' }));
      if (app.sent.length === 1) {
        app.running = true;
        setTimeout(() => { app.steps.push(...turn); }, 60);
        setTimeout(() => { if (!app.hold) app.running = false; }, 150);
      }
    }
  }, 10);
  t.after(() => { clearInterval(sidecar); server.close(); rmSync(root, { recursive: true, force: true }); });
  const access_path = join(root, 'chat-1.access.json');
  writeFileSync(access_path, JSON.stringify({ site: 'http://127.0.0.1:1', room: 'r', token: 't' }));
  return { app, root, config: { adapter: 'antigravity', ipc_directory: ipc }, access_path };
}

/** Run one chat line and wait for how it ends. */
async function run_chat(f, binding = { session_id: 'conv-1' }, during = async () => {}) {
  const notes = [], logs = [];
  let child = null, settle;
  const ended = new Promise(resolve => { settle = resolve; });
  const result = await deliver_task(f.config, binding, { id: 'chat-1', chat: true, directory: f.root, access_path: f.access_path, prompt: 'hello',
    on_note: text => notes.push(text), on_output: (path, line) => logs.push(line), on_process: handle => { child = handle; },
    on_exit: () => settle({}), on_failure: reason => settle({ error: reason }) });
  await during(result, child);
  return { result, notes, logs, child, ...(await ended) };
}

test('an App chat line is followed to its reply, with steps logged and only this turn read', async t => {
  const f = await fake_app(t, { turn: [step('SYSTEM_MESSAGE'),
    response('先看一下', [{ id: 'c1', name: 'run_command', argumentsJson: '{}' }, { id: 'c2', name: 'view_file', argumentsJson: '{"Path":"a.txt"}' }]),
    step('RUN_COMMAND', { runCommand: { commandLine: 'echo hi', exitCode: 0, combinedOutput: { full: 'hi' } } }),
    response('最终回复')] });
  const run = await run_chat(f);
  assert.equal(run.error, undefined);
  assert.deepEqual(run.notes, ['先看一下', '最终回复']);
  assert.deepEqual(run.result.capabilities, { stoppable: true, progress: true });
  assert.ok(f.app.calls.every(call => call.token === 'csrf-1' && call.body.cascadeId === 'conv-1'));
  assert.deepEqual(f.app.sent.map(request => [request.chat, request.session_id, request.prompt]), [[true, 'conv-1', 'hello']]);
  const entries = run.logs.map(line => JSON.parse(line).entry);
  assert.ok(entries.some(entry => entry.kind === 'command' && entry.title === 'echo hi' && entry.body === 'hi' && entry.state === 'done'));
  assert.ok(entries.some(entry => entry.kind === 'tool' && entry.title.startsWith('view_file')));
  assert.ok(!entries.some(entry => entry.body === 'earlier turn'));
});

test('an App chat line sent while the turn runs is passed in as an interjection', async t => {
  const f = await fake_app(t, { turn: [response('收到插话')] });
  f.app.hold = true;
  const run = await run_chat(f, undefined, async result => {
    assert.equal(await result.steer('再补一句'), true);
    f.app.running = false;
  });
  assert.equal(run.notes.at(-1), '收到插话');
  assert.deepEqual(f.app.sent.map(request => [request.id, request.chat, request.prompt]), [['chat-1', true, 'hello'], ['chat-1-steer-1', true, '再补一句']]);
  assert.ok(run.logs.some(line => JSON.parse(line).type === 'codiscuss.interjection'));
});

test('stopping an App chat turn cancels it in the App', async t => {
  const f = await fake_app(t);
  f.app.hold = true;
  const run = await run_chat(f, undefined, async (result, child) => { await delay(50); child.kill(); });
  assert.equal(run.error, '已停止');
  assert.ok(f.app.calls.some(call => call.method === 'CancelCascadeInvocation' && call.body.cascadeId === 'conv-1'));
});

test('an App chat whose internal interface fails names the method and that the App may have changed', async t => {
  const f = await fake_app(t, { fail: 'GetCascadeTrajectorySteps' });
  await assert.rejects(run_chat(f), error => error.delivery_status === 'not_sent'
    && /GetCascadeTrajectorySteps 返回 HTTP 404.*App 版本可能已变/.test(error.message));
  assert.equal(f.app.sent.length, 0);
});

test('without the App server token an App chat line is still sent and honestly reports no reply', async t => {
  const f = await fake_app(t, { token: '' });
  const run = await run_chat(f, {});
  assert.equal(run.result.session_id, 'conv-1');
  assert.deepEqual(run.result.capabilities, { stoppable: false, progress: false });
  assert.equal(f.app.sent.length, 1);
  assert.match(run.error, /拿不到回复/);
});

test('the Sidecar hands over the App server and sends a chat line without a room execution check', async t => {
  const root = mkdtempSync(join(tmpdir(), 'chat-agy-sidecar-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // A stand-in for agentapi, run as `node agentapi send-message ...` from the Sidecar's working directory.
  writeFileSync(join(root, 'agentapi'), "process.stdout.write(JSON.stringify({ response: { sendMessage: { recipientId: process.argv[3] } } }));");
  const access_path = join(root, 'chat-5.access.json');
  writeFileSync(access_path, JSON.stringify({ site: 'http://127.0.0.1:1', room: 'r', token: 't' }));
  writeFileSync(join(root, 'chat-5.request.json'), JSON.stringify({ id: 'chat-5', chat: true, prompt: 'hi', session_id: 'conv-9', access_path }));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../runner/discussion_sidecar.mjs', import.meta.url))], { cwd: root, windowsHide: true, stdio: 'ignore',
    env: { ...process.env, CODISCUSS_IPC_DIRECTORY: root, ANTIGRAVITY_AGENTAPI_EXE: process.execPath, ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:9', ANTIGRAVITY_CSRF_TOKEN: 'csrf-9' } });
  const exited = once(child, 'exit');
  try {
    const receipt = join(root, 'chat-5.result.json');
    for (let attempt = 0; attempt < 200 && !existsSync(receipt); attempt++) await delay(25);
    assert.deepEqual(JSON.parse(readFileSync(receipt, 'utf8')), { id: 'chat-5', session_id: 'conv-9', status: 'accepted' });
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'ready.json'), 'utf8')).language_server, { address: '127.0.0.1:9', csrf_token: 'csrf-9' });
  } finally { child.kill(); await exited; }
});

test('an agy chat into a conversation another agy process holds open is refused before anything runs', { skip: process.platform !== 'win32' }, async t => {
  const home = mkdtempSync(join(tmpdir(), 'chat-agy-cli-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const presence = join(home, '.gemini', 'antigravity-cli', 'presence');
  mkdirSync(presence, { recursive: true });
  const lock = join(presence, 'conv-7.lock');
  writeFileSync(lock, '');
  // agy's interactive window holds an exclusive byte-range lock on the conversation's presence file.
  const holder = spawn('powershell.exe', ['-NoProfile', '-Command',
    `$f=[IO.File]::Open('${lock}','Open','ReadWrite','ReadWrite'); $f.Lock(0,1); 'locked'; [Console]::In.ReadLine() | Out-Null`], { windowsHide: true });
  t.after(() => holder.kill());
  await new Promise((resolve, reject) => { holder.stdout.on('data', chunk => String(chunk).includes('locked') && resolve()); holder.once('exit', reject); });
  let spawned = 0;
  const spawn_process = () => { spawned++; throw new Error('spawned'); };
  const config = { adapter: 'antigravity_cli', executable: process.execPath, session_id: 'conv-7', cwd: home };
  const access_path = join(home, 'chat-1.access.json');
  writeFileSync(access_path, '{}');
  const task = { id: 'chat-1', chat: true, directory: home, draft_directory: home, skill_directories: [], access_path, prompt: 'hi' };
  assert.equal(conversation_open_elsewhere('conv-7', home), true);
  await assert.rejects(async () => deliver_task(config, { session_id: 'conv-7' }, task, spawn_process, home),
    error => error.delivery_status === 'not_sent' && /正在你的 agy 终端里打开/.test(error.message));
  // A room task into the same open conversation is refused the same way: the terminal would drop it too.
  await assert.rejects(async () => deliver_task(config, { session_id: 'conv-7' }, { ...task, id: 'free-1', chat: false }, spawn_process, home),
    error => error.delivery_status === 'not_sent' && /正在你的 agy 终端里打开/.test(error.message));
  assert.equal(spawned, 0);
  holder.kill();
  await once(holder, 'exit');
  assert.equal(conversation_open_elsewhere('conv-7', home), false);
  await deliver_task(config, { session_id: 'conv-7' }, task, spawn_process, home).catch(() => {});
  assert.equal(spawned, 1);
});

// A command the App moved to the background: running as a generic step, the App idle with an interim remark.
const background = [response('', [{ id: 'c1', name: 'run_command', argumentsJson: '{}' }]),
  step('GENERIC', { taskDetails: { id: 'conv-1/task-2', description: 'Start-Sleep 40' } }, 'CORTEX_STEP_STATUS_RUNNING'), response('已启动命令，正在等待')];

test('an App chat turn waits for a background command to report and takes the reply of the run that follows', async t => {
  const f = await fake_app(t, { turn: background });
  setTimeout(() => { f.app.steps[2] = step('RUN_COMMAND', { taskDetails: { id: 'conv-1/task-2' }, runCommand: { commandLine: 'Start-Sleep 40', exitCode: 0, combinedOutput: { full: 'BG-OK' } } }); }, 400);
  setTimeout(() => { f.app.running = true; f.app.steps.push(step('SYSTEM_MESSAGE', { systemMessage: { message: '[Message] sender=conv-1/task-2 priority=HIGH content=done' } })); }, 500);
  setTimeout(() => { f.app.steps.push(response('后台完成后的最终回复')); f.app.running = false; }, 600);
  const run = await run_chat(f);
  assert.equal(run.error, undefined);
  assert.equal(run.notes.at(-1), '后台完成后的最终回复');
  const commands = run.logs.map(line => JSON.parse(line).entry).filter(entry => entry.kind === 'command');
  assert.deepEqual(commands.map(entry => [entry.title, entry.state]), [['Start-Sleep 40', 'running'], ['Start-Sleep 40', 'done']]);
  assert.equal(commands.at(-1).body, 'BG-OK');
});

test('stopping an App chat turn also stops its background command, or says it may still run', async t => {
  const f = await fake_app(t, { turn: background });
  const run = await run_chat(f, undefined, async (result, child) => { await delay(300); child.kill(); });
  assert.equal(run.error, '已停止');
  assert.ok(f.app.calls.some(call => call.method === 'ForceStopCascadeTree' && call.body.conversationId === 'conv-1'));
  assert.equal(f.app.steps[2].status, 'CORTEX_STEP_STATUS_CANCELED');
  const g = await fake_app(t, { turn: background, fail: 'ForceStopCascadeTree' });
  g.app.hold = true;
  const failed = await run_chat(g, undefined, async (result, child) => { await delay(100); child.kill(); });
  assert.match(failed.error, /已停止这一轮，但未能停止后台命令.*后台命令可能仍在运行/);
});

test('an App room task is not stopped from here but its end is heard', async t => {
  Object.assign(ROOM_TIMING, { poll_ms: 20, read_failures: 2 });
  const f = await fake_app(t, { turn: [
    response('修改中', [
      { id: 't1', name: 'edit_file', argumentsJson: JSON.stringify({ Path: 'src/app-edit.js' }) },
      { id: 't2', name: 'view_file', argumentsJson: JSON.stringify({ Path: 'src/read-only.js' }) },
    ]),
    step('RUN_COMMAND', { runCommand: { commandLine: 'cp src/read-only.js out/app-copy.js', exitCode: 0 } }),
    step('RUN_COMMAND', { runCommand: { commandLine: 'echo x > out/app-fail.js', exitCode: 1 } }),
    step('RUN_COMMAND', { runCommand: { commandLine: 'echo x > out/app-cancel.js', exitCode: 0 } }, 'CORTEX_STEP_STATUS_CANCELED'),
    response('房间任务做完'),
  ] });
  let ended;
  const heard = new Promise(resolve => { ended = resolve; });
  const edits = [];
  const result = await deliver_task(f.config, { session_id: 'conv-1' }, { id: 'free-9', directory: f.root, access_path: f.access_path, prompt: 'room',
    on_turn_end: () => ended(true), on_edits: paths => edits.push(paths) });
  assert.deepEqual(result.capabilities, { stoppable: false, progress: false, ends: true });
  assert.equal(await heard, true);
  assert.ok(f.app.steps.length > 1, 'only after the new turn added its steps and the App went idle');
  assert.deepEqual(edits, [[], ['src/app-edit.js'], ['out/app-copy.js']]);
  // Without language_server, the App cannot be read, so edits stay untracked instead of claiming empty.
  const blind = await fake_app(t, { token: '' });
  const blind_edits = [];
  const blind_result = await deliver_task(blind.config, { session_id: 'conv-1' }, { id: 'free-10', directory: blind.root, access_path: blind.access_path, prompt: 'room',
    on_edits: paths => blind_edits.push(paths) });
  assert.deepEqual(blind_result.capabilities, { stoppable: false, progress: false });
  assert.deepEqual(blind_edits, []);
});

// Steps as App 2.35.1 records them (2026-11-25): each run has its own executionId, a sub-agent its own step and
// conversation, and a report comes as a message from that conversation or from `<conversation>/task-N`.
const in_run = (item, run) => ({ ...item, metadata: { ...item.metadata, executionId: run } });
const report = (sender, run, title) => step('SYSTEM_MESSAGE', { metadata: { executionId: run },
  systemMessage: { message: `[Message] sender=${sender} priority=MESSAGE_PRIORITY_HIGH content=x`, renderInfo: { title }, agentMessage: { sender } } });
const subagent = (run, id = 'sub-1', role = 'reviewer') => step('INVOKE_SUBAGENT', { metadata: { executionId: run, toolCall: { name: 'invoke_subagent' } },
  invokeSubagent: { subagents: [{ role, typeName: 'self' }], results: [{ conversationId: id }] } });

/** Deliver a room task to the fake App and collect what the watch reports until it hears the turn end. */
async function watch_room(f, id, answers = []) {
  const followups = [];
  let list = [], ended;
  const heard = new Promise(resolve => { ended = resolve; });
  await deliver_task(f.config, { session_id: 'conv-1' }, { id, directory: f.root, access_path: f.access_path, prompt: 'room',
    on_turn_end: () => ended(), on_background_tasks: items => { list = items; },
    on_followup: async reports => { followups.push(reports[0].id); return answers[followups.length - 1] ?? true; } });
  await heard;
  return { followups, list };
}

test('an App chat turn waits for a sub-agent it started to report', async t => {
  const f = await fake_app(t, { turn: [in_run(response('', [{ id: 'a', name: 'invoke_subagent', argumentsJson: '{}' }]), 'r1'), subagent('r1'), in_run(response('已派出子代理'), 'r1')] });
  setTimeout(() => { f.app.running = true; f.app.steps.push(report('sub-1', 'r2', 'Message from reviewer (self)')); }, 400);
  setTimeout(() => { f.app.steps.push(in_run(response('子代理回报后的最终回复'), 'r2')); f.app.running = false; }, 500);
  const run = await run_chat(f);
  assert.equal(run.error, undefined);
  assert.equal(run.notes.at(-1), '子代理回报后的最终回复');
});

test('an App room task lists its background work and puts a report that starts a new run to the runner', async t => {
  Object.assign(ROOM_TIMING, { poll_ms: 20, read_failures: 2 });
  const RUNNING = 'CORTEX_STEP_STATUS_RUNNING';
  const command = status => step(status === RUNNING ? 'GENERIC' : 'RUN_COMMAND', { metadata: { executionId: 'r1', toolCall: { name: 'run_command' } },
    taskDetails: { id: 'conv-1/task-3', title: 'npm test' }, runCommand: { commandLine: 'npm test', exitCode: 0 } }, status);
  const f = await fake_app(t, { turn: [report('system', 'r1', 'task'), subagent('r1'), command(RUNNING),
    step('GENERIC', { metadata: { executionId: 'r1', toolCall: { name: 'schedule', argumentsJson: '{"CronExpression":"0 9 * * *","Prompt":"daily check"}' } },
      taskDetails: { id: 'conv-1/task-4', description: 'Cron: 0 9 * * *', title: 'cron' } }, RUNNING),
    in_run(response('已派出，回答已提交'), 'r1')] });
  // The sub-agent reports in a new run, then the schedule fires (only shown), then the command finishes and reports,
  // as App 2.35.1 did once: under the last run's executionId, recorded twice.
  setTimeout(() => { f.app.running = true; f.app.steps.push(report('sub-1', 'r2', 'Message from reviewer (self)')); }, 400);
  setTimeout(() => { f.app.steps.push(in_run(response('子代理已回报'), 'r2')); f.app.running = false; }, 450);
  setTimeout(() => { f.app.running = true; f.app.steps.push(report('conv-1/task-4', 'r3', 'cron fired')); }, 550);
  setTimeout(() => { f.app.steps.push(in_run(response('定时到了'), 'r3')); f.app.running = false; }, 600);
  setTimeout(() => { f.app.steps[3] = command('CORTEX_STEP_STATUS_DONE'); f.app.running = true;
    f.app.steps.push(report('conv-1/task-3', 'r3', 'npm test finished'), report('conv-1/task-3', 'r3', 'npm test finished')); }, 700);
  setTimeout(() => { f.app.steps.push(in_run(response('测试通过'), 'r3')); f.app.running = false; }, 750);
  const followups = [], phases = [];
  let list = [], ended;
  const heard = new Promise(resolve => { ended = resolve; });
  await deliver_task(f.config, { session_id: 'conv-1' }, { id: 'free-11', directory: f.root, access_path: f.access_path, prompt: 'room',
    on_turn_end: () => ended(), on_activity: phase => phases.push(phase), on_background_tasks: items => { list = items; },
    on_followup: async (reports, handle, options) => { followups.push([reports, handle, options]); return true; } });
  await heard;
  assert.deepEqual(followups, [
    [[{ id: 'sub-1', status: 'completed', summary: 'Message from reviewer (self)' }], null, { steer: false }],
    [[{ id: 'conv-1/task-3', status: 'completed', summary: 'npm test finished' }], null, { steer: false }],
  ]);
  assert.ok(phases.includes('waiting'));
  assert.deepEqual(list.map(item => [item.id, item.kind, item.title, item.state, item.schedule]).sort(), [
    ['conv-1/task-3', 'command', 'npm test', 'done', ''],
    ['conv-1/task-4', 'schedule', 'daily check', 'running', '0 9 * * *'],
    ['sub-1', 'agent', 'reviewer', 'done', ''],
  ]);
});

test('after the next task arrives an App room watch follows only the work it listed, and keeps following on a keep', async t => {
  Object.assign(ROOM_TIMING, { poll_ms: 20, read_failures: 2 });
  const f = await fake_app(t, { turn: [report('system', 'r1', 'task'), subagent('r1'),
    step('GENERIC', { metadata: { executionId: 'r1', toolCall: { name: 'run_command' } }, taskDetails: { id: 'conv-1/task-3', title: 'npm test' } }, 'CORTEX_STEP_STATUS_RUNNING'),
    in_run(response('已派出，回答已提交'), 'r1')] });
  // The next task goes into the same conversation and launches its own sub-agent, which reports first; then this task's
  // sub-agent and command report. An App notice from `system` in between is no next task.
  setTimeout(async () => {
    f.app.steps.push(report('system', 'r1', 'notice'));
    await deliver_task(f.config, { session_id: 'conv-1' }, { id: 'free-12b', directory: f.root, access_path: f.access_path, prompt: 'next' });
    f.app.steps.push(report('system', 'r2', 'task 2'), subagent('r2', 'sub-2', 'other'), in_run(response('第二个任务答完'), 'r2'));
  }, 300);
  setTimeout(() => { f.app.steps.push(report('sub-2', 'r3', 'Message from other'), in_run(response('收到'), 'r3')); }, 450);
  setTimeout(() => { f.app.steps.push(report('sub-1', 'r4', 'Message from reviewer'), in_run(response('收到'), 'r4')); }, 550);
  setTimeout(() => { f.app.steps[3].status = 'CORTEX_STEP_STATUS_DONE'; f.app.steps.push(report('conv-1/task-3', 'r5', 'npm test finished'), in_run(response('收到'), 'r5')); }, 650);
  const watched = await watch_room(f, 'free-12', ['keep', false]);
  assert.deepEqual(watched.followups, ['sub-1', 'conv-1/task-3']);
  assert.ok(!watched.list.some(item => item.id === 'sub-2'));
});

test('an App sub-agent its turn killed is shown stopped and not waited for', async t => {
  Object.assign(ROOM_TIMING, { poll_ms: 20, read_failures: 2 });
  // As App 2.35.1 records a kill: the finished manage_subagents step names the conversations it ended.
  const f = await fake_app(t, { turn: [report('system', 'r1', 'task'), subagent('r1'),
    step('GENERIC', { metadata: { executionId: 'r1', toolCall: { name: 'manage_subagents', argumentsJson: '{"Action":"kill_all"}' } },
      generic: { result: { payload: { action: 'kill_all', conversationIds: ['sub-1'] } } } }),
    report('sub-1', 'r1', 'Message from reviewer (self)'), in_run(response('已结束子代理'), 'r1')] });
  const watched = await watch_room(f, 'free-13');
  assert.deepEqual(watched.followups, []);
  assert.deepEqual(watched.list.map(item => [item.id, item.state]), [['sub-1', 'stopped']]);
});

test('agy gets the thinking level only through the model ID: a stored effort is never passed beside it', async t => {
  const home = mkdtempSync(join(tmpdir(), 'agy-effort-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  let args = null;
  const spawn_process = (_executable, argv) => { args = argv; throw new Error('spawned'); };
  // agy 1.5 refuses `--model gemini-4-neon-xhigh --effort medium` outright, so every retry of such a member failed.
  const config = { adapter: 'antigravity_cli', executable: process.execPath, session_id: 'conv-9', cwd: home, model: 'gemini-4-neon-xhigh', effort: 'medium' };
  const access_path = join(home, 'chat-2.access.json');
  writeFileSync(access_path, '{}');
  const task = { id: 'chat-2', chat: true, directory: home, draft_directory: home, skill_directories: [], access_path, prompt: 'hi' };
  await deliver_task(config, { session_id: 'conv-9' }, task, spawn_process, home).catch(() => {});
  assert.ok(args, 'agy was started');
  assert.equal(args[args.indexOf('--model') + 1], 'gemini-4-neon-xhigh');
  assert.ok(!args.includes('--effort'));
});

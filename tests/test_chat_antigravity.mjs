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
import { CHAT_TIMING } from '../runner/adapters/antigravity_app.mjs';
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

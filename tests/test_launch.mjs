import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { request as http_request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

import { adopt_member_profile, adopt_workflow, borrowed_session, launch_discussion, launch_settings, room_configuration, room_files, room_models, room_member, room_member_model, room_workflow, save_launch_projects, save_launch_settings, validate_preset } from '../runner/discussion_launch.mjs';
import { get_workflow, list_workflows, save_workflow } from '../runner/workflows.mjs';
import { read_project_files } from '../runner/project_files.mjs';
import { api, DiscussionStore, load_config } from '../runner/discussion_runner.mjs';
import { FreeRoomRunner } from '../runner/free_runner.mjs';
import { DiscussionService, read_registry } from '../runner/discussion_service.mjs';
import { save_site_connection } from '../runner/discussion_local.mjs';
import { software_models } from '../runner/adapters/index.mjs';
const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Simulate the software control stream, recording every request and process cleanup. */
function catalog_process(on_request = () => {}) {
  const child = new EventEmitter(), requests = [], invocations = [];
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => { child.killed = true; queueMicrotask(() => child.emit('close', null)); };
  let pending = '';
  child.stdin.on('data', chunk => {
    pending += chunk;
    while (pending.includes('\n')) {
      const end = pending.indexOf('\n'), request = JSON.parse(pending.slice(0, end));
      pending = pending.slice(end + 1); requests.push(request);
      queueMicrotask(() => on_request(request, child));
    }
  });
  return { child, requests, invocations, spawn: (...args) => { invocations.push(args); return child; } };
}

test('model discovery initializes Codex and reads every catalog page without creating a turn', async () => {
  const f = catalog_process((request, child) => {
    let result;
    if (request.method === 'initialize') result = {};
    else if (request.method === 'model/list') result = request.params.cursor
      ? { data: [{ model: 'second', displayName: 'Second', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }] }
      : { data: [{ model: 'first', displayName: 'First', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] },
        { model: 'hidden', hidden: true }], nextCursor: 'page-2' };
    if (result) child.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
  });
  const result = await software_models({ adapter: 'codex_cli', executable: process.execPath }, f);
  assert.deepEqual(result, { adapter: 'codex_cli', source: 'codex-app-server', models: [
    { id: 'first', label: 'First', efforts: ['high'] }, { id: 'second', label: 'Second', efforts: ['low'] }] });
  assert.deepEqual(f.requests.map(row => row.method), ['initialize', 'initialized', 'model/list', 'model/list']);
  assert.equal(f.child.killed, true);
  assert.equal(f.invocations[0][2].shell, false);
});

test('paused room path correction is authenticated, versioned and adopted before an explicit restart', async t => {
  let service;
  t.after(() => service?.close());
  const f = await fixture(t);
  save_launch_settings(f.home, { participants: f.input.participants });
  const launched = await launch_discussion(f.home, f.input, f.options);
  const config = load_config(launched.config_path);
  const input = { site: f.site, room_id: config.room, token: config.token };
  const calls = [];
  service = new DiscussionService(f.home, (current, store) => new FreeRoomRunner(current, store,
    async (profile, binding, task) => { calls.push({ executable: profile.executable, session_id: binding.session_id });
      const child = Object.assign(new EventEmitter(), { kill() { this.emit('close'); return true; } });
      task.on_process(child);
      return { status: 'accepted', session_id: 'original-host' }; }));
  await service.tick();
  await assert.rejects(room_configuration(f.home, input), /先暂停/);
  let discussion = await api(config, '/discussion');
  await api(config, '/discussion', { action: 'pause', revision: discussion.revision });
  await service.tick();
  await assert.rejects(room_configuration(f.home, { ...input, token: 'wrong-owner' }), /403/);
  const before = await room_configuration(f.home, input);
  assert.doesNotMatch(JSON.stringify(before), new RegExp(config.token));
  const replacement = join(f.directory, 'replacement.exe');
  writeFileSync(replacement, 'not executed by this test');
  const corrected = { ...input, version: before.version, session_revision: before.session_revision,
    participants: { Codex: { executable: replacement } } };
  await assert.rejects(room_configuration(f.home, { ...corrected, version: 'stale' }), /已变化/);
  await assert.rejects(room_configuration(f.home, { ...corrected, participants: { Codex: { session_id: 'other-chat' } } }), /本场修正仅支持/);
  writeFileSync(join(f.home, 'runner.lock'), String(process.pid));
  let checking;
  const interval = setInterval(() => { checking = service.tick(); }, 100);
  let saved;
  try { saved = await room_configuration(f.home, corrected); }
  // Clearing the timer does not finish its in-flight paused-room check.
  finally { clearInterval(interval); await checking; }
  assert.equal(saved.applied, true, 'the resident service confirms the corrected config');
  assert.equal((await api(config, '/discussion')).session.status, 'paused');
  assert.equal(calls.length, 1, 'saving a path must not dispatch AI');
  assert.deepEqual(launch_settings(f.home).participants, f.input.participants);
  const worker = service.workers.get(launched.config_path);
  assert.equal(worker.store.binding('Codex').session_id, 'original-host');
  assert.equal(worker.config.participants.Codex.executable, replacement);
  await launch_discussion(f.home, f.input, f.options);
  assert.equal(load_config(launched.config_path).participants.Codex.executable, replacement, 'an original launch retry must not undo the correction');
  discussion = await api(config, '/discussion');
  await api(config, '/discussion', { action: 'resume', revision: discussion.revision });
  await service.tick();
  assert.deepEqual(calls.at(-1), { executable: replacement, session_id: 'original-host' });
});

test('paused Codex switches App and CLI with the same room and session, without dispatching on save', async t => {
  let service;
  t.after(() => service?.close());
  const f = await fixture(t);
  const launched = await launch_discussion(f.home, f.input, f.options);
  const config = load_config(launched.config_path), calls = [];
  const input = { site: f.site, room_id: config.room, token: config.token };
  service = new DiscussionService(f.home, (current, store) => new FreeRoomRunner(current, store,
    // A stoppable stand-in: this test is about switching entrypoints, not the wait after voiding software the runner cannot stop.
    async (profile, binding, task) => { calls.push([profile.adapter, binding.session_id]);
      const child = Object.assign(new EventEmitter(), { kill() { this.emit('close'); return true; } });
      task.on_process(child);
      return { status: 'accepted', session_id: 'original-host', capabilities: { stoppable: true, progress: true } }; }));
  await service.tick();
  let discussion = await api(config, '/discussion');
  await api(config, '/discussion', { action: 'pause', revision: discussion.revision });
  await service.tick();
  writeFileSync(join(f.home, 'runner.lock'), String(process.pid));
  const before = await api(config, '');
  for (const adapter of ['codex', 'codex_cli']) {
    const current = await room_configuration(f.home, input);
    const count = calls.length;
    let checking;
    const interval = setInterval(() => { checking = service.tick(); }, 100);
    let saved;
    try { saved = await room_configuration(f.home, { ...input, version: current.version,
      session_revision: current.session_revision, participants: { Codex: { adapter } } }); }
    // A concurrent tick only joins the old check; drain it before resuming the room.
    finally { clearInterval(interval); await checking; }
    assert.equal(saved.applied, true, 'the resident service confirms the corrected config');
    assert.equal(calls.length, count, 'saving an entrypoint must not start AI');
    assert.equal(saved.participants.Codex.adapter, adapter);
    assert.equal(service.workers.get(launched.config_path).store.binding('Codex').session_id, 'original-host');
    assert.equal(load_config(launched.config_path).participants.Codex.session_id, 'original-host');
    const room = await api(config, '');
    assert.equal(room.session.status, 'paused');
    assert.equal(room.session.id, before.session.id);
    assert.deepEqual(room.current_turn, before.current_turn);
    discussion = await api(config, '/discussion');
    await api(config, '/discussion', { action: 'resume', revision: discussion.revision });
    await service.tick();
    assert.equal(calls.length, count + 1, 'resuming dispatches exactly one new request');
    assert.deepEqual(calls.at(-1), [adapter, 'original-host']);
    discussion = await api(config, '/discussion');
    await api(config, '/discussion', { action: 'pause', revision: discussion.revision });
    await service.tick();
  }
});

test('local room-config route edits only the authorized paused room and reports an offline worker honestly', async t => {
  const f = await fixture(t);
  const launched = await launch_discussion(f.home, f.input, f.options);
  const config = load_config(launched.config_path);
  const discussion = await api(config, '/discussion');
  await api(config, '/discussion', { action: 'pause', revision: discussion.revision });
  const input = { room_id: config.room, token: config.token };
  const headers = { 'X-CoDiscuss-Local': '1', Origin: f.site };
  const read = await request(f.site, '/api/local/room-config', input, headers);
  assert.equal(read.status, 200);
  assert.equal((await request(f.site, '/api/local/room-config', { ...input, token: 'wrong' }, headers)).status, 400);
  const saved = await request(f.site, '/api/local/room-config', { ...input, version: read.body.version,
    session_revision: read.body.session_revision, participants: { Codex: { executable: process.execPath } } }, headers);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.applied, false);
  assert.equal((await api(config, '/discussion')).session.status, 'paused');
});

/** Run the real website in a temporary database; no actual AI software is invoked. */
async function fixture(t, local_launch = true, remote_entry = false) {
  const directory = mkdtempSync(join(tmpdir(), 'codiscuss-launch-'));
  const home = join(directory, 'service');
  const script = 'import sys; from backend.server import DiscussionServer,init_database; '
    + 'init_database(sys.argv[1],seed=False); '
    + `server=DiscussionServer(('127.0.0.1',0),sys.argv[1],local_launch=${local_launch ? 'True' : 'False'});\n`
    + `while server.server_port <= 10080:\n server.server_close(); server=DiscussionServer(('127.0.0.1',0),sys.argv[1],local_launch=${local_launch ? 'True' : 'False'})\n`
    + (remote_entry ? "from threading import Thread; remote=DiscussionServer(('127.0.0.1',0),sys.argv[1],hub=server); Thread(target=remote.serve_forever,daemon=True).start(); print(str(server.server_port)+' '+str(remote.server_port),flush=True); " : 'print(server.server_port,flush=True); ')
    + 'server.serve_forever()';
  const child = spawn(process.platform === 'win32' ? 'python' : 'python3', ['-u', '-c', script, join(directory, 'site.sqlite3')],
    { cwd: ROOT, windowsHide: true, env: { ...process.env, DISCUSS_SERVICE_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = new Promise(resolve => child.once('close', resolve));
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  t.after(async () => { child.kill(); await closed; rmSync(directory, { recursive: true, force: true }); });
  const port = await new Promise((resolve, reject) => {
    child.stdout.once('data', data => resolve(String(data).trim().split(' ').map(Number)));
    child.once('error', reject);
    child.once('exit', () => reject(new Error(errors)));
  });
  const site = `http://127.0.0.1:${port[0]}`;
  const participants = { Codex: { adapter: 'codex_cli', executable: process.execPath }, Claude: { adapter: 'claude', executable: process.execPath } };
  const input = { site, entry: 'web', participants,
    room: { title: '隔离启动验证', host: 'Codex', experts: { Codex: 'cli', Claude: 'cli' },
      limits: { max_rounds: 3, max_minutes: 15 }, submission_id: randomUUID() } };
  const starts = [];
  const options = { start_service: async value => { starts.push(value); return { running: true }; } };
  return { directory, home, site, remote_site: remote_entry ? `http://127.0.0.1:${port[1]}` : '', input, options, starts };
}

/** Read/write the real API, retaining structured failures for assertions. */
async function request(site, path, body, headers = {}) {
  const text = body === undefined ? '' : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const outgoing = http_request(site + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), ...headers } }, response => {
      let output = '';
      response.on('data', chunk => { output += chunk; });
      response.on('end', () => { try { resolve({ status: response.statusCode, headers: response.headers, body: JSON.parse(output) }); } catch (error) { reject(error); } });
    });
    outgoing.on('error', reject);
    outgoing.end(text);
  });
}

test('room files use the saved project and require the authenticated bridge and room owner', async t => {
  const f = await fixture(t);
  const project = join(f.directory, 'project');
  mkdirSync(project);
  writeFileSync(join(project, '报告.md'), '# 项目报告\n正文');
  const launched = await launch_discussion(f.home, { ...f.input, cwd: project }, f.options);
  const config = load_config(launched.config_path);
  const input = { site: f.site, room_id: config.room, token: config.token };
  const models = await room_models(f.home, input, { read_defaults: async () => ({}), read_session: () => ({}) });
  assert.equal(models.project_directory, project);
  assert.deepEqual((await room_files(f.home, input)).entries.map(item => item.name), ['报告.md']);
  assert.equal((await room_files(f.home, { ...input, path: '报告.md', cwd: f.directory })).text, '# 项目报告\n正文');
  await assert.rejects(room_files(f.home, { ...input, token: '' }), /控制凭据/);
  await assert.rejects(room_files(f.home, { ...input, token: 'invalid-owner' }), /403/);
  const body = { room_id: config.room, path: '报告.md' };
  assert.equal((await request(f.site, '/api/local/room-files', body)).status, 403);
  const local = await request(f.site, '/api/local/room-files', body, { 'X-CoDiscuss-Local': '1' });
  assert.equal(local.status, 200, JSON.stringify(local.body));
  assert.equal(local.body.text, '# 项目报告\n正文', 'another local browser uses its administrator authority');
  const denied = await request(f.site, '/api/local/room-files', { ...body, token: 'invalid-owner' }, { 'X-CoDiscuss-Local': '1' });
  assert.equal(denied.status, 400);
  assert.match(denied.body.error, /403/);
  const { computer_command } = await import('../runner/relay_channel.mjs');
  const { relayed_command } = await import('../runner/remote_launch.mjs');
  writeFileSync(join(f.home, 'local-settings.json'), JSON.stringify({ port: Number(new URL(f.site).port) }));
  const command = computer_command(f.home, 'https://paired.test', 'room-files', body);
  assert.equal(command.command, 'room-files');
  assert.equal((await room_files(f.home, command.input)).text, local.body.text);
  assert.equal(relayed_command(f.site, 'room-files', { ...input, site: 'https://evil.test', access_file: 'ignored' }).input.access_file, undefined);
  assert.equal(relayed_command(f.site, 'room-files', { ...input, site: 'https://evil.test' }).input.site, f.site);
  const saved = JSON.parse(readFileSync(launched.config_path, 'utf8'));
  delete saved.cwd;
  saved.participants.Codex.cwd = project;
  writeFileSync(launched.config_path, JSON.stringify(saved));
  const no_project = await room_models(f.home, input, { read_defaults: async () => ({}), read_session: () => ({}) });
  assert.equal(no_project.project_directory, '', 'a member directory does not enable the room project page');
  await assert.rejects(room_files(f.home, input), /未设置项目目录/);
});

test('project file browsing blocks traversal, absolute paths and links outside the saved root', t => {
  const directory = mkdtempSync(join(tmpdir(), 'codiscuss-files-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const project = join(directory, 'project');
  mkdirSync(project);
  writeFileSync(join(directory, 'private.txt'), 'outside');
  mkdirSync(join(project, '文档'));
  writeFileSync(join(project, '文档', '说明.txt'), 'inside');
  assert.throws(() => read_project_files('', ''), /未设置项目目录/);
  for (const path of ['../private.txt', '..\\private.txt', join(directory, 'private.txt'), 'C:\\private.txt', '说明.txt:stream', 'bad\0']) {
    assert.throws(() => read_project_files(project, path), /相对路径/);
  }
  assert.equal(read_project_files(project, '文档/说明.txt').text, 'inside');
  symlinkSync(directory, join(project, '外部链接'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => read_project_files(project, '外部链接/private.txt'), /目录之外/);
  assert.equal(read_project_files(project).entries.find(item => item.name === '外部链接').kind, 'unavailable');
});

test('project text previews handle binary, empty, UTF-16 and large files and paginate directories', t => {
  const project = mkdtempSync(join(tmpdir(), 'codiscuss-preview-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  writeFileSync(join(project, 'empty.txt'), '');
  writeFileSync(join(project, 'binary.dat'), Buffer.from([0, 1, 2, 3]));
  writeFileSync(join(project, 'utf16.txt'), Buffer.from('\ufeff中文说明', 'utf16le'));
  writeFileSync(join(project, 'large.txt'), '中'.repeat(200000));
  assert.equal(read_project_files(project, 'empty.txt').text, '');
  assert.equal(read_project_files(project, 'binary.dat').text, null);
  assert.equal(read_project_files(project, 'utf16.txt').text, '中文说明');
  const large = read_project_files(project, 'large.txt');
  assert.equal(large.truncated, true);
  assert.equal(large.size, 600000);
  assert.ok(large.text && Buffer.byteLength(large.text) <= large.limit);
  for (let index = 0; index < 205; index++) writeFileSync(join(project, `item-${index}.txt`), 'x');
  const first = read_project_files(project);
  const last = read_project_files(project, '', first.next_offset);
  assert.equal(first.entries.length, 200);
  assert.equal(last.next_offset, null);
  assert.equal(new Set([...first.entries, ...last.entries].map(item => item.path)).size, first.total);
});

test('connected website needs its own credential and CORS preflight never starts or configures anything', async t => {
  const f = await fixture(t);
  const site = 'https://discussion.example';
  const token = 'a'.repeat(64);
  save_site_connection(f.home, site, token);
  save_launch_settings(f.home, { participants: f.input.participants });
  const headers = { Origin: site, 'X-CoDiscuss-Local': '1', 'X-CoDiscuss-Connection': token };
  const preflight = async origin => {
    const response = await fetch(`${f.site}/api/local/launch`, { method: 'OPTIONS', headers: {
      Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Private-Network': 'true',
      'Access-Control-Request-Headers': 'content-type,x-codiscuss-local,x-codiscuss-connection' } });
    await response.json();
    return response;
  };
  const allowed = await preflight(site);
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('access-control-allow-origin'), site);
  assert.equal(allowed.headers.get('access-control-allow-private-network'), 'true');
  const rejected = await preflight('https://unrelated.example');
  assert.equal(rejected.status, 403);
  assert.equal(rejected.headers.get('access-control-allow-origin'), null);
  for (const overrides of [{ 'X-CoDiscuss-Connection': '' }, { 'X-CoDiscuss-Connection': 'b'.repeat(64) },
    { Origin: 'https://unrelated.example' }, { Origin: 'null' }, { Host: 'discussion.example' }]) {
    const denied = await request(f.site, '/api/local/settings', undefined, { ...headers, ...overrides });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.participants, undefined);
  }
  const settings = await request(f.site, '/api/local/settings', undefined, headers);
  assert.equal(settings.status, 200);
  assert.equal(settings.headers['access-control-allow-origin'], site);
  assert.equal(settings.headers['access-control-allow-credentials'], undefined);
  assert.deepEqual(settings.body.participants, f.input.participants);
  assert.equal((await request(f.site, '/api/local/room-config', {}, headers)).status, 404);
  const other = await fetch(`${f.site}/api/rooms`, { method: 'OPTIONS' });
  assert.equal(other.status, 404);
  await other.json();
  assert.equal(read_registry(f.home).length, 0);
  assert.equal((await request(f.site, '/api/rooms')).body.rooms.length, 0);
});

test('connected browser launches on its authorized website, resumes the same request and dispatches locally once', async t => {
  const local = await fixture(t);
  const online = await fixture(t, false);
  const credential = 'c'.repeat(64);
  save_site_connection(local.home, online.site, credential);
  save_launch_settings(local.home, { participants: local.input.participants });
  writeFileSync(join(local.home, 'runner.lock'), String(process.pid));
  writeFileSync(join(local.home, 'status.json'), JSON.stringify({ pid: process.pid, ready: true, updated_at: Date.now() }));
  const headers = { Origin: online.site, 'X-CoDiscuss-Local': '1', 'X-CoDiscuss-Connection': credential };
  const input = { site: local.site, access_file: 'must-be-ignored', entry: 'conversation', token: randomUUID(), room: online.input.room };
  const first = await request(local.site, '/api/local/launch', input, headers);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.headers['access-control-allow-origin'], online.site);
  assert.equal((await request(local.site, '/api/rooms')).body.rooms.length, 0);
  assert.equal((await request(online.site, '/api/rooms')).body.rooms.length, 1);
  const config = load_config(first.body.config_path);
  assert.equal(config.site, online.site);
  assert.equal(config.token, input.token);
  const calls = [];
  const service = new DiscussionService(local.home, (current, store) => new FreeRoomRunner(current, store,
    async (profile, binding, task) => { calls.push({ participant: task.participant,
      site: JSON.parse(readFileSync(join(current.directory, `${task.id}.task.json`), 'utf8')).site });
      return { status: 'accepted', session_id: 'connected-host-session' }; }));
  try {
    await service.tick();
    const repeated = await request(local.site, '/api/local/launch', input, headers);
    assert.equal(repeated.body.room.id, first.body.room.id);
    await service.tick();
    assert.deepEqual(calls, [{ participant: 'Codex', site: online.site }]);
    assert.equal(read_registry(local.home).length, 1);
    const discussion = await api(config, '/discussion');
    await api(config, '/discussion', { action: 'pause', revision: discussion.revision });
    await request(local.site, '/api/local/launch', input, headers);
    await service.tick();
    assert.equal((await api(config, '/discussion')).session.status, 'paused');
    assert.equal(calls.length, 1);
    assert.equal((await request(online.site, '/api/local/settings', undefined, headers)).status, 404);
  } finally { await service.close(); }
});

for (const entry of ['web', 'conversation']) {
  test(`${entry} launch accepts unlimited duration and retries without recreating the run`, async t => {
    const f = await fixture(t);
    f.input.entry = entry;
    f.input.room.limits.max_minutes = 0;
    if (entry === 'conversation') f.input.current_session_id = 'actual-host-session';
    assert.equal((await launch_discussion(f.home, f.input, { dry_run: true })).minutes, 0);
    const result = await launch_discussion(f.home, f.input, f.options);
    assert.equal(result.room.session.status, 'active');
    assert.equal(result.room.limits.max_rounds, 3);
    assert.equal(result.room.limits.execution_minutes, 0);
    assert.equal(result.room.limits.max_minutes, 0);
    const retry = await launch_discussion(f.home, f.input, f.options);
    assert.equal(retry.room.id, result.room.id);
    assert.equal(retry.room.session.id, result.room.session.id);
    assert.equal(read_registry(f.home).length, 1);
    if (entry === 'conversation') assert.equal(retry.current_task.execution_id, result.current_task.execution_id);
  });
}

test('project write access is per launch, defaults to read and can differ per participant', async t => {
  const f = await fixture(t);
  assert.throws(() => save_launch_settings(f.home, { participants: { Codex: { ...f.input.participants.Codex, project_access: 'write' } } }), /不能保存房间或会话/);
  const preview = input => launch_discussion(f.home, { ...f.input, cwd: f.directory, ...input }, { dry_run: true });
  assert.equal((await preview({})).participants.Codex.project_access, 'read');
  const mixed = await preview({ project_access: 'write', participants: { ...f.input.participants, Claude: { ...f.input.participants.Claude, project_access: 'read' } } });
  assert.equal(mixed.participants.Codex.project_access, 'write'); assert.equal(mixed.participants.Claude.project_access, 'read');
  const inherited = await preview({ project_access: 'write', participants: { ...f.input.participants, Claude: { ...f.input.participants.Claude, project_access: '' } } });
  assert.equal(inherited.participants.Claude.project_access, 'write');
  await assert.rejects(preview({ project_access: 'admin' }), /read、write、auto 或 full/);
});

for (const legacy of [false, true]) test(`a ${legacy ? 'legacy' : 'current'} interrupted launch pins defaults and rejects changed explicit requests`, async t => {
  const f = await fixture(t);
  save_launch_settings(f.home, { participants: { ...f.input.participants, Codex: { ...f.input.participants.Codex, cwd: f.directory } } });
  const { participants, ...input } = f.input;
  await assert.rejects(launch_discussion(f.home, input, { start_service: async () => { throw new Error('service interrupted'); } }), /service interrupted/);
  if (legacy) {
    const journal = join(f.home, 'launches', readdirSync(join(f.home, 'launches'))[0], 'launch.json');
    const record = JSON.parse(readFileSync(journal, 'utf8'));
    for (const field of ['config', 'minutes', 'room_id', 'request_signature']) delete record[field];
    writeFileSync(journal, JSON.stringify(record));
  }
  save_launch_settings(f.home, { participants: { ...participants, Codex: { ...participants.Codex, cwd: f.home } } });
  const resumed = await launch_discussion(f.home, input, f.options);
  assert.equal(load_config(resumed.config_path).participants.Codex.cwd, f.directory);
  assert.equal((await request(f.site, '/api/rooms')).body.rooms.length, 1);
  await assert.rejects(launch_discussion(f.home, { ...input, participants: { Codex: { cwd: f.home } } }, f.options), /原请求不同/);
  const fresh = await launch_discussion(f.home, { ...input, room: { ...input.room, submission_id: randomUUID() } }, f.options);
  assert.equal(load_config(fresh.config_path).participants.Codex.cwd, f.home);
});

for (const entry of ['web', 'conversation']) test(`${entry} rejects incorrect control credentials before state changes and permits correction`, async t => {
  const f = await fixture(t);
  const token = randomUUID();
  const created = await request(f.site, '/api/rooms', { title: f.input.room.title, goal: f.input.room.title, mode: 'free',
    submission_id: randomUUID(), members: ['Codex', 'Claude'].map(name => ({ name, access: 'runner', token: randomUUID() })) },
  { 'X-Discussion-Token': token });
  const input = { site: f.site, room_id: created.body.id, entry, participants: f.input.participants,
    current_session_id: 'actual-host-session', token: randomUUID() };
  await assert.rejects(launch_discussion(f.home, input, f.options), /403/);
  assert.equal(existsSync(f.home), false, 'failed authorization must not persist a poisoned journal');
  assert.equal(f.starts.length, 0);
  const result = await launch_discussion(f.home, { ...input, token }, f.options);
  assert.equal(result.status, 'free');
  assert.equal(load_config(result.config_path).token, token);
});

test('missing software, current identity or invalid limits fail before creating rooms or starting a service', async t => {
  const f = await fixture(t);
  await assert.rejects(launch_discussion(f.home, { ...f.input, participants: {} }, f.options), /请配置 Codex/);
  await assert.rejects(launch_discussion(f.home, { ...f.input, entry: 'conversation' }, f.options), /current_session_id/);
  for (const minutes of [-1, 1441, 'invalid']) {
    await assert.rejects(launch_discussion(f.home, { ...f.input, minutes }, f.options), /总时长/);
  }
  await assert.rejects(launch_discussion(f.home, { ...f.input, cwd: './project' }, f.options), /绝对路径/);
  await assert.rejects(launch_discussion(f.home, { ...f.input, participants: { ...f.input.participants, Codex: { adapter: 'codex_cli', executable: f.directory } } }, f.options), /可执行文件/);
  await assert.rejects(launch_discussion(f.home, { ...f.input, participants: { ...f.input.participants, Claude: { adapter: 'claude', executable: join(f.directory, 'missing.exe') } } }, f.options), /可执行文件/);
  for (const model of ['-o evil', 'gpt 5', '--config=x']) {
    await assert.rejects(launch_discussion(f.home, { ...f.input, participants: { ...f.input.participants, Codex: { adapter: 'codex_cli', executable: process.execPath, model } } }, f.options), /model 只能是模型名称/);
  }
  await assert.rejects(launch_discussion(f.home, { ...f.input, participants: { ...f.input.participants, Codex: { adapter: 'codex_cli', executable: process.execPath, effort: 'turbo' } } }, f.options), /effort 只能是 low/);
  await assert.rejects(launch_discussion(f.home, { ...f.input, participants: { ...f.input.participants, Claude: { adapter: 'claude', executable: process.execPath, effort: 'ultra' } } }, f.options), /effort 只能是 low/);
  const agy = { adapter: 'antigravity_cli', executable: process.execPath };
  const agy_room = { ...f.input.room, host: 'Antigravity', experts: { Antigravity: 'cli', Claude: 'cli' } };
  await assert.rejects(launch_discussion(f.home, { ...f.input, room: agy_room, entry: 'conversation', current_session_id: 'agy-chat',
    participants: { ...f.input.participants, Antigravity: agy } }, f.options), /Antigravity CLI 不能绑定已有会话/);
  await assert.rejects(launch_discussion(f.home, { ...f.input, room: agy_room,
    participants: { ...f.input.participants, Antigravity: { ...agy, session_id: 'known-session' } } }, f.options), /Antigravity CLI 不能绑定已有会话/);
  assert.equal((await request(f.site, '/api/rooms')).body.rooms.length, 0);
  assert.equal(f.starts.length, 0);
});

test('the public CLI reads UTF-8 launch files and dry-run never starts a service or creates a room', async t => {
  const f = await fixture(t);
  const path = join(f.directory, '启动草稿.json');
  writeFileSync(path, '\uFEFF' + JSON.stringify(f.input));
  const result = spawnSync(process.execPath, [join(ROOT, 'runner', 'codiscuss.mjs'), 'launch', 'start', '--file', path, '--dry-run'],
    { encoding: 'utf8', windowsHide: true, env: { ...process.env, DISCUSS_SERVICE_HOME: f.home } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).dry_run, true);
  assert.equal(existsSync(f.home), false);
  assert.equal((await request(f.site, '/api/rooms')).body.rooms.length, 0);
});

test('web entry creates, registers and starts once; the service dispatches the host and duplicate clicks reuse the receipt', async t => {
  const f = await fixture(t);
  const first = await launch_discussion(f.home, f.input, f.options);
  const second = await launch_discussion(f.home, f.input, f.options);
  assert.equal(first.room.id, second.room.id);
  assert.equal(first.status, 'active');
  assert.equal(first.current_task, null);
  assert.equal(read_registry(f.home).length, 1);
  assert.equal(f.starts.length, 1);
  const config = load_config(first.config_path);
  assert.ok(!JSON.stringify(first).includes(config.token));
  const store = new DiscussionStore(config.directory);
  try {
    const calls = [];
    const runner = new FreeRoomRunner(config, store, async (_, binding, task) => {
      calls.push(task.participant); return { status: 'accepted', session_id: 'web-host' };
    });
    await runner.tick();
    await runner.tick();
    assert.deepEqual(calls, ['Codex']);
  } finally { store.close(); }
  await assert.rejects(launch_discussion(f.home, { ...f.input, minutes: 10 }, f.options), /原请求不同/);
});

test('conversation entry reserves the host request for the real current session and uses the normal execution path', async t => {
  const f = await fixture(t);
  const result = await launch_discussion(f.home, { ...f.input, entry: 'conversation', current_session_id: 'current-real-session' }, f.options);
  const config = load_config(result.config_path);
  const access = JSON.parse(readFileSync(result.current_task.access_file, 'utf8'));
  const task = JSON.parse(readFileSync(result.current_task.task_file, 'utf8'));
  assert.equal(task.draft_directory, config.draft_directory);
  assert.ok(task.draft_directory.startsWith(join(f.home, 'drafts')));
  assert.ok(!task.draft_directory.startsWith(config.directory));
  assert.equal(access.session_id, 'current-real-session');
  assert.equal(config.participants.Codex.session_id, access.session_id);
  assert.equal(task.execution_id, result.current_task.execution_id);
  assert.equal(task.access_file, result.current_task.access_file);
  assert.equal(task.access_env, undefined);
  assert.ok(!JSON.stringify(result).includes(access.token));
  const execution = await api(config, `/executions/${result.current_task.execution_id}`);
  assert.equal(execution.status, 'dispatched');
  assert.equal(execution.requests[0].purpose, 'discuss_host');
  assert.equal(execution.requests[0].session_id, result.room.session.id);
  const delivered = [];
  const store = new DiscussionStore(config.directory);
  try {
    const runner = new FreeRoomRunner(config, store, async (_, binding, task_info) => {
      delivered.push(task_info.participant); return { status: 'accepted', session_id: 'expert-session' };
    });
    await runner.tick();
    assert.deepEqual(delivered, [], 'the current conversation already owns the reserved host execution');
    await api(config, '/messages', { author: 'Codex', text: '我会先请专家独立陈述。', source: 'cli',
      execution_id: result.current_task.execution_id, submission_id: randomUUID() }, access.token);
    const roster = await api(config, '/turns/roster', undefined, access.token);
    await api(config, '/turns', { actor: 'Codex', roster: roster.revision, expert: 'Claude', question: '请给出独立观点',
      submission_id: randomUUID() }, access.token);
    await runner.tick();
    assert.deepEqual(delivered, ['Claude']);
    assert.equal(store.binding('Codex').session_id, 'current-real-session');
  } finally { store.close(); }
});

test('a restart after the website accepted session start reconciles the same session instead of starting again', async t => {
  const f = await fixture(t);
  const first = await launch_discussion(f.home, f.input, f.options);
  const journal_path = join(dirname(first.config_path), 'launch.json');
  const journal = JSON.parse(readFileSync(journal_path, 'utf8'));
  assert.equal(journal.start_submission_id, (await api(load_config(first.config_path), '/discussion')).session.start_submission_id);
  assert.equal(journal.start_request.submission_id, journal.start_submission_id);
  delete journal.session_id;
  journal.start_pending = true;
  delete journal.finished;
  writeFileSync(journal_path, JSON.stringify(journal));
  const next = await launch_discussion(f.home, f.input, f.options);
  assert.equal(next.room.session.id, first.room.session.id);
  assert.equal((await api(load_config(first.config_path), '/inbox')).members.flatMap(item => item.pending)
    .filter(item => item.purpose === 'discuss_host').length, 1);
  const config = load_config(first.config_path);
  const current = await api(config, '/discussion');
  await api(config, '/discussion', { action: 'pause', revision: current.revision });
  const paused = await launch_discussion(f.home, f.input, f.options);
  await assert.rejects(launch_discussion(f.home, { site: f.site, entry: 'web', room_id: first.room.id,
    access_file: first.config_path, participants: f.input.participants }, f.options), /另一份接入配置/);
  assert.equal(paused.status, 'paused');
  assert.equal(paused.room.session.id, first.room.session.id);
});

test('a lost start response resolves its original concluded session instead of claiming a newer one', async t => {
  const f = await fixture(t);
  const first = await launch_discussion(f.home, f.input, f.options);
  const journal_path = join(dirname(first.config_path), 'launch.json');
  const journal = JSON.parse(readFileSync(journal_path, 'utf8'));
  const config = load_config(first.config_path);
  let state = await api(config, '/discussion');
  await api(config, '/discussion', { action: 'end', revision: state.revision });
  state = await api(config, '/discussion');
  const newer = await api(config, '/discussion', { action: 'start', revision: state.revision,
    submission_id: randomUUID(), goal: '后来开启的新讨论', limits: journal.start_request.limits });
  delete journal.session_id;
  delete journal.finished;
  journal.start_pending = true;
  writeFileSync(journal_path, JSON.stringify(journal));

  await assert.rejects(launch_discussion(f.home, f.input, f.options), /本次讨论已暂停或结束/);
  assert.equal((await api(config, '/discussion')).session.id, newer.session.id);
  assert.equal(JSON.parse(readFileSync(journal_path, 'utf8')).session_id, first.room.session.id);
});

test('a concurrent start with another submission id cannot be mistaken for this launch', async t => {
  const f = await fixture(t);
  const first = await launch_discussion(f.home, f.input, f.options);
  const journal_path = join(dirname(first.config_path), 'launch.json');
  const journal = JSON.parse(readFileSync(journal_path, 'utf8'));
  const competing_id = randomUUID();
  delete journal.session_id;
  delete journal.finished;
  journal.start_pending = true;
  journal.start_submission_id = competing_id;
  journal.start_request = { ...journal.start_request, submission_id: competing_id };
  writeFileSync(journal_path, JSON.stringify(journal));

  await assert.rejects(launch_discussion(f.home, f.input, f.options), /409/);
  assert.equal((await api(load_config(first.config_path), '/discussion')).session.id, first.room.session.id);
  assert.equal(Object.hasOwn(JSON.parse(readFileSync(journal_path, 'utf8')), 'session_id'), false);
});

test('local configuration bridge requires opt-in, loopback Host, same origin and a custom request header', async t => {
  const f = await fixture(t);
  const headers = { 'X-CoDiscuss-Local': '1', Origin: f.site };
  assert.equal((await request(f.site, '/api/local/settings')).status, 403);
  assert.equal((await request(f.site, '/api/local/settings', undefined, { ...headers, Origin: 'https://unrelated.example' })).status, 403);
  assert.equal((await request(f.site, '/api/local/settings', undefined, { ...headers, Host: 'unrelated.example' })).status, 403);
  assert.equal((await request(f.site, '/api/local/settings', undefined, { ...headers, 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  const saved = await request(f.site, '/api/local/settings', { participants: f.input.participants }, headers);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal((await request(f.site, '/api/local/settings', undefined, headers)).body.participants.Codex.adapter, 'codex_cli');
  assert.equal((await request(f.site, '/api/local/models', { adapter: 'codex' })).status, 403);
  const models = await request(f.site, '/api/local/models', { adapter: 'codex' }, headers);
  assert.equal(models.status, 200); assert.equal(models.body.source, 'original-software');
  assert.deepEqual(models.body.models, []);
  const invalid = await request(f.site, '/api/local/launch', { room: f.input.room, participants: { Codex: { adapter: 'unsupported' } } }, headers);
  assert.equal(invalid.status, 400);
  assert.equal((await request(f.site, '/api/rooms')).body.rooms.length, 0);
});

test('ordinary website hosting keeps machine configuration and process launch unavailable', async t => {
  const f = await fixture(t, false);
  const result = await request(f.site, '/api/local/settings', undefined, { 'X-CoDiscuss-Local': '1' });
  assert.equal(result.status, 404);
  assert.equal(existsSync(f.home), false);
});

test('web partial-failure receipts preserve the original room and require its browser credential', async t => {
  const f = await fixture(t);
  const input = { ...f.input, token: randomUUID() };
  const headers = { 'X-CoDiscuss-Local': '1', Origin: f.site };
  mkdirSync(f.home, { recursive: true });
  writeFileSync(join(f.home, 'runner.lock'), String(process.pid));
  const failed = await request(f.site, '/api/local/launch', input, headers);
  assert.equal(failed.status, 400, JSON.stringify(failed.body));
  assert.equal(failed.body.launch.stage, 'created');
  const room_id = failed.body.launch.room_id;
  assert.ok(room_id);
  assert.ok(!JSON.stringify(failed.body).includes(input.token));
  assert.ok(!JSON.stringify(failed.body.launch).includes('config'));
  assert.equal((await request(f.site, '/api/rooms')).body.rooms.length, 1);
  assert.equal(read_registry(f.home).length, 0);
  const journal_path = join(f.home, 'launches', readdirSync(join(f.home, 'launches'))[0], 'launch.json');
  const original = readFileSync(journal_path, 'utf8');
  for (const token of [undefined, randomUUID()]) {
    const denied = await request(f.site, '/api/local/launch', { ...input, token }, headers);
    assert.equal(denied.status, 400);
    assert.equal(denied.body.launch.room_id, undefined);
    assert.equal(readFileSync(journal_path, 'utf8'), original);
  }
  writeFileSync(join(f.home, 'status.json'), JSON.stringify({ pid: process.pid, updated_at: Date.now(), ready: true }));
  const replies = await Promise.all([request(f.site, '/api/local/launch', input, headers), request(f.site, '/api/local/launch', input, headers)]);
  assert.ok(replies.some(reply => reply.status === 200));
  const replay = await request(f.site, '/api/local/launch', input, headers);
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body.room.id, room_id);
  assert.equal((await request(f.site, '/api/rooms')).body.rooms.length, 1);
  assert.deepEqual(read_registry(f.home), [replay.body.config_path]);
  const config = load_config(replay.body.config_path);
  assert.equal((await api(config, '/inbox')).members.flatMap(item => item.pending).filter(item => item.purpose === 'discuss_host').length, 1);
});

/** Exit a separate launcher at a real persistence or HTTP boundary, without a model process. */
function interrupted_launcher(f, input, boundary) {
  const input_path = join(f.directory, 'interrupted-input.json');
  writeFileSync(input_path, JSON.stringify(input));
  const script = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const boundary = process.argv[3];
    const crash = () => { fs.writeFileSync(process.argv[2] + '.crashed', boundary); process.kill(process.pid, 'SIGKILL'); };
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
      rename(from, to);
      const path = String(to);
      const value = JSON.parse(fs.readFileSync(to, 'utf8'));
      if ((boundary === 'prepared' && path.endsWith('launch.json') && !value.room_id)
        || (boundary === 'configured' && path.endsWith('config.json'))
        || (boundary === 'task' && path.endsWith('.task.json'))
        || (boundary === 'registered' && path.endsWith('rooms.json'))
        || (boundary === 'finished' && path.endsWith('launch.json') && value.finished)) crash();
    };
    syncBuiltinESMExports();
    const original_fetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      const response = await original_fetch(url, options);
      const action = options?.body && JSON.parse(options.body).action;
      if (response.ok && ((boundary === 'created' && String(url).endsWith('/api/rooms') && options.method === 'POST')
        || (boundary === 'started' && String(url).endsWith('/discussion') && action === 'start')
        || (boundary === 'reserved' && String(url).endsWith('/executions') && options.method === 'POST'))) crash();
      return response;
    };
    const { launch_discussion } = await import(process.argv[4]);
    const receipt = await launch_discussion(process.argv[1], JSON.parse(fs.readFileSync(process.argv[2], 'utf8')),
      { start_service: async () => ({ running: true }) });
    process.stdout.write(JSON.stringify(receipt));`;
  return spawnSync(process.execPath, ['--input-type=module', '-e', script, f.home, input_path, boundary,
    pathToFileURL(join(ROOT, 'runner/discussion_launch.mjs')).href], { encoding: 'utf8', windowsHide: true });
}

for (const entry of ['web', 'conversation']) test(`${entry} survives process death at each launch boundary without duplicate work`, async t => {
  const boundaries = ['prepared', 'created', 'configured', 'started', ...(entry === 'conversation' ? ['reserved', 'task'] : []), 'registered', 'finished'];
  for (const boundary of boundaries) await t.test(boundary, async subtest => {
    const f = await fixture(subtest);
    const input = { ...f.input, entry, current_session_id: 'original-host' };
    const interrupted = interrupted_launcher(f, input, boundary);
    assert.notEqual(interrupted.status, 0);
    assert.equal(readFileSync(join(f.directory, 'interrupted-input.json.crashed'), 'utf8'), boundary);
    const recovered = interrupted_launcher(f, input, 'recover');
    assert.equal(recovered.status, 0, recovered.stderr);
    const receipt = JSON.parse(recovered.stdout);
    const config = load_config(receipt.config_path);
    assert.equal((await request(f.site, '/api/rooms')).body.rooms.length, 1);
    assert.deepEqual(read_registry(f.home), [receipt.config_path]);
    const inbox = await api(config, '/inbox');
    assert.equal(inbox.members.flatMap(item => item.pending).filter(item => item.purpose === 'discuss_host').length,
      entry === 'conversation' ? 0 : 1);
    assert.equal(inbox.executions.length, entry === 'conversation' ? 1 : 0);
    if (entry === 'conversation') {
      const active_execution = await api(config, `/executions/${inbox.executions[0].id}`);
      assert.equal(active_execution.requests[0].session_id, receipt.room.session.id);
    }
    const store = new DiscussionStore(config.directory);
    try {
      let deliveries = 0;
      const runner = new FreeRoomRunner(config, store, async () => { deliveries++; return { status: 'accepted', session_id: 'created-host' }; });
      await runner.tick();
      await runner.tick();
      assert.equal(deliveries, entry === 'conversation' ? 0 : 1);
      if (entry === 'web') assert.equal((await api(config, '/inbox')).executions.length, 1);
      assert.equal(store.binding('Codex').session_id, entry === 'conversation' ? 'original-host' : 'created-host');
      assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    } finally { store.close(); }
    const current = await api(config, '/discussion');
    const paused = await api(config, '/discussion', { action: 'pause', revision: current.revision });
    const replayed = interrupted_launcher(f, input, 'recover');
    assert.equal(replayed.status, 0, replayed.stderr);
    assert.equal(JSON.parse(replayed.stdout).status, 'paused');
    assert.equal(JSON.parse(replayed.stdout).room.session.id, paused.session.id);
    assert.equal((await api(config, '/inbox')).executions.length, 0);
  });
});

test('a free room launches without a run, and a user message reaches its member through the service', async t => {
  const f = await fixture(t);
  const input = { site: f.site, entry: 'web', participants: f.input.participants, token: randomUUID() + randomUUID(),
    room: { title: '自由单聊', goal: '遥控 Claude', mode: 'free', members: ['Claude'], submission_id: randomUUID() } };
  const first = await launch_discussion(f.home, input, f.options);
  const again = await launch_discussion(f.home, input, f.options);
  assert.equal(first.room.id, again.room.id);
  assert.equal(first.status, 'free');
  assert.deepEqual(first.room.free.members.map(member => member.name), ['Claude']);
  const config = load_config(first.config_path);
  assert.equal(config.mode, 'free');
  assert.ok(!JSON.stringify(first).includes(config.members.Claude.token));
  const path = `/api/rooms/${config.room}`;
  assert.equal((await request(f.site, `${path}/messages`, { author: '用户', text: '改标题', submission_id: randomUUID() })).status, 201);
  const delivered = [];
  const service = new DiscussionService(f.home, (current, store) => new FreeRoomRunner(current, store,
    async (_, binding, task) => { delivered.push(task); return { status: 'accepted', session_id: 'claude-free' }; }));
  let room;
  try {
    await service.tick();
    assert.equal(delivered.length, 1);
    const task = JSON.parse(readFileSync(join(config.directory, `${delivered[0].id}.task.json`), 'utf8'));
    const access = JSON.parse(readFileSync(delivered[0].access_path, 'utf8'));
    const answered = await request(f.site, `${path}/messages`, { author: 'Claude', text: '已改', source: 'cli',
      execution_id: task.execution_id, submission_id: randomUUID() }, { 'X-Discussion-Token': access.token });
    assert.equal(answered.status, 201);
    await service.tick();
    room = (await request(f.site, path)).body;
  } finally { await service.close(); }
  assert.deepEqual(room.free.requests.map(item => item.status), ['completed']);
  assert.equal(delivered.length, 1);
});

test('a remote entry refuses anonymous room writes and accepts the owner credential', async t => {
  const f = await fixture(t, true, true), token = randomUUID() + randomUUID();
  const launched = await launch_discussion(f.home, { site: f.site, entry: 'web', participants: f.input.participants, token,
    room: { title: '远程权限边界', mode: 'free', members: ['Claude'], submission_id: randomUUID() } }, f.options);
  const path = `/api/rooms/${launched.room.id}/messages`;
  const body = { author: '用户', text: '远程写入', submission_id: randomUUID() };
  assert.equal((await request(f.remote_site, path, body)).status, 403);
  assert.equal((await request(f.remote_site, path, body, { 'X-Discussion-Token': token })).status, 201);
});

test('workflow library commands keep the local and relayed boundaries, including preview before saving', async t => {
  const f = await fixture(t);
  const { relayed_command } = await import('../runner/remote_launch.mjs');
  const headers = { 'X-CoDiscuss-Local': '1' }, workflow = { id: 'shared', label: '共享做法', skill: '先明确目标', agents: [] };
  const local = await request(f.site, '/api/local/workflows', { action: 'save', workflow }, headers);
  assert.equal(local.status, 200, JSON.stringify(local.body));
  assert.equal((await request(f.site, '/api/local/workflows', { action: 'list' }, headers)).body.workflows[0].id, 'shared');
  const command = relayed_command(f.site, 'workflows', { action: 'get', id: 'shared', site: 'https://wrong.test', access_file: 'ignored' });
  assert.equal(command.input.site, f.site);
  assert.equal(command.input.access_file, undefined);
  assert.equal(relayed_command(f.site, 'room-workflow', { action: 'disable', room_id: 'one' }).input.site, f.site);
  assert.throws(() => relayed_command(f.site, 'workflows', { action: 'preview', folder: 'private-folder' }), /粘贴导入/);
  const parts = ['<!-- workflow-part: 1/1 id: imported -->\n<!-- workflow-file: SKILL.md -->\n---\nname: imported\n---\n导入做法'];
  const preview = relayed_command(f.site, 'workflows', { action: 'preview', parts });
  assert.equal((await request(f.site, '/api/local/workflows', preview.input, headers)).body.id, 'imported');
  assert.deepEqual((await request(f.site, '/api/local/workflows', { action: 'list' }, headers)).body.workflows.map(item => item.id), ['shared']);
});

test('room cards preserve member text and portable settings without removed members, credentials or paths', async t => {
  const f = await fixture(t), token = randomUUID() + randomUUID();
  const prompt = '保留原文。\n第二行含 "引号"。';
  const participants = {
    'Codex-role': { ...f.input.participants.Codex, system_prompt: prompt, project_access: 'read', model: 'saved-model', effort: 'high' },
    'Claude-ROLE': { ...f.input.participants.Claude, system_prompt: '复核事实。' },
    Claude: f.input.participants.Claude,
  };
  const launched = await launch_discussion(f.home, { site: f.site, entry: 'web', token, participants,
    room: { title: '卡片导出', mode: 'free', host: 'Codex-role', members: Object.keys(participants), submission_id: randomUUID() } }, f.options);
  const config = load_config(launched.config_path);
  await api(config, '/labels', { labels: { 'Codex-role': '执笔', 'Claude-ROLE': '审稿' } });
  await api(config, '/descriptions', { descriptions: { 'Codex-role': '按骨架写正文', 'Claude-ROLE': '核对事实' } });
  const member = (await api(config, '')).free.members.find(item => item.name === 'Claude');
  await api(config, `/members/${member.id}`, { action: 'remove' });
  const result = await request(f.site, '/api/local/workflows', { action: 'room-cards', room_id: config.room }, { 'X-CoDiscuss-Local': '1' });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.cards.length, 2);
  const writer = result.body.cards.find(card => card.name === 'Codex-role');
  assert.deepEqual(writer, { card: 'role', name: 'Codex-role', label: '执笔', description: '按骨架写正文',
    system_prompt: prompt, project_access: 'read', model: 'saved-model', effort: 'high' });
  assert.equal(new Set(result.body.cards.map(card => card.card.toLowerCase())).size, 2);
  const saved = save_workflow(f.home, { id: 'room-export', label: '房间导出', skill: '先写再审。', agents: result.body.cards }, validate_preset);
  assert.equal(saved.agents.find(card => card.name === writer.name).system_prompt, prompt);
  for (const card of result.body.cards) assert.ok(Object.keys(card).every(key =>
    ['card', 'name', 'label', 'description', 'system_prompt', 'project_access', 'model', 'effort'].includes(key)));
  assert.doesNotMatch(JSON.stringify(result.body), new RegExp(token));
});

test('only the host of a room whose owner allowed it adopts a workflow, inviting its cards with at most write access', async t => {
  const f = await fixture(t), token = randomUUID() + randomUUID();
  save_launch_settings(f.home, { participants: f.input.participants });
  const launched = await launch_discussion(f.home, { site: f.site, entry: 'web', participants: f.input.participants, token,
    room: { title: '主持人自建', mode: 'free', host: 'Codex', members: ['Codex'], submission_id: randomUUID() } }, f.options);
  const config = load_config(launched.config_path), input = { site: f.site, room_id: launched.room.id, token };
  const access = (name, member_token) => {
    const path = join(f.directory, `${name}.access.json`);
    writeFileSync(path, JSON.stringify({ site: f.site, room: config.room, member: name, token: member_token }));
    return path;
  };
  const host_access = access('Codex', config.members.Codex.token);
  const draft = join(f.directory, 'draft.md');
  writeFileSync(draft, '<!-- workflow-part: 1/1 id: serial -->\n<!-- workflow-file: SKILL.md -->\n---\nname: serial\nlabel: 连载\n---\n先写再审。\n'
    + '<!-- workflow-file: agents/writer.md -->\n---\nname: Claude-writer\nlabel: 写手\nproject_access: full\n---\n按任务书写。\n');
  await assert.rejects(adopt_workflow(f.home, { access_file: host_access, draft_file: draft }), /没有允许/);
  assert.equal(list_workflows(f.home).length, 0);
  // A browser of the local site without the room credential grants it with the site's administrator authority.
  const granted = await request(f.site, '/api/local/room-workflow', { room_id: config.room, action: 'host', allowed: true }, { 'X-CoDiscuss-Local': '1' });
  assert.equal(granted.status, 200, JSON.stringify(granted.body));
  assert.equal(load_config(launched.config_path).host_workflows, true);
  await assert.rejects(adopt_workflow(f.home, { access_file: access('Other', randomUUID() + randomUUID()), draft_file: draft }), /只有本房间的主持人/);
  const adopted = await adopt_workflow(f.home, { access_file: host_access, draft_file: draft });
  assert.deepEqual(adopted.members, { writer: 'Claude-writer' });
  assert.equal(get_workflow(f.home, 'serial').agents[0].project_access, 'write');
  const saved = load_config(launched.config_path);
  assert.deepEqual(saved.workflow, { id: 'serial', enabled: true, members: { writer: 'Claude-writer' } });
  assert.equal(saved.participants['Claude-writer'].project_access, 'write');
  const room = await api(config, '');
  assert.equal(room.free.members.find(member => member.name === 'Claude-writer').status, 'active');
  assert.equal(room.labels['Claude-writer'], '写手');
  // The same ID again updates the workflow in place and keeps the present member.
  writeFileSync(draft, readFileSync(draft, 'utf8').replace('先写再审。', '先写，再审，再改。'));
  assert.deepEqual((await adopt_workflow(f.home, { access_file: host_access, draft_file: draft })).members, { writer: 'Claude-writer' });
  assert.equal(get_workflow(f.home, 'serial').skill, '先写，再审，再改。');
  assert.equal((await api(config, '')).free.members.length, 2);
});

test('a room without a project keeps its workflow at creation, disables work and recalls the original members', async t => {
  const f = await fixture(t), token = randomUUID() + randomUUID();
  save_workflow(f.home, { id: 'writing', label: '写作', skill: '先拟提纲，再写正文。', agents: [
    { card: 'host', name: 'Codex', project_access: 'read' }, { card: 'writer', name: 'Claude', project_access: 'read' }] }, validate_preset);
  const workflow = { id: 'writing', members: { host: 'Codex', writer: 'Claude' } };
  const launched = await launch_discussion(f.home, { site: f.site, entry: 'web', participants: f.input.participants, token, workflow,
    room: { title: '无项目工作流', mode: 'free', host: 'Codex', members: ['Codex', 'Claude'], submission_id: randomUUID() } }, f.options);
  const input = { site: f.site, room_id: launched.room.id, token }, config = load_config(launched.config_path);
  assert.equal(config.cwd || '', '');
  assert.deepEqual(config.workflow, { ...workflow, enabled: true });
  await assert.rejects(room_workflow(f.home, { ...input, token: 'wrong-owner', action: 'disable' }), /403/);
  await api(config, '/messages', { author: '用户', text: '@Claude 写正文', to: ['Claude'], submission_id: randomUUID() });
  await room_workflow(f.home, { ...input, action: 'disable' });
  let room = await api(config, '');
  assert.equal(room.free.members.find(member => member.name === 'Codex').status, 'active');
  assert.equal(room.free.members.find(member => member.name === 'Claude').status, 'away');
  assert.ok(room.free.requests.filter(request => request.member_id === room.free.members.find(member => member.name === 'Claude').id).every(request => request.status === 'cancelled'));
  assert.equal(load_config(launched.config_path).workflow.enabled, false);
  await room_member(f.home, { ...input, name: 'Claude', action: 'rejoin' });
  await room_workflow(f.home, { ...input, action: 'enable', workflow });
  room = await api(config, '');
  assert.deepEqual(room.free.members.map(member => [member.name, member.status]), [['Codex', 'active'], ['Claude', 'active']]);
  assert.equal(load_config(launched.config_path).workflow.enabled, true);
  assert.deepEqual(load_config(launched.config_path).participants, config.participants);
});

test('members join, leave and return while a free room keeps running', async t => {
  const f = await fixture(t);
  const owner = randomUUID() + randomUUID();
  const input = { site: f.site, entry: 'web', participants: f.input.participants, token: owner,
    room: { title: '多人协作', goal: 'x', mode: 'free', members: ['Claude'], submission_id: randomUUID() } };
  const launched = await launch_discussion(f.home, input, f.options);
  const room_id = launched.room.id, path = `/api/rooms/${room_id}`, auth = { 'X-Discussion-Token': owner };
  await assert.rejects(room_member(f.home, { site: f.site, room_id, token: 'wrong'.repeat(8), action: 'add', name: 'Codex' }), /403/);
  const added = await room_member(f.home, { site: f.site, room_id, token: owner, action: 'add', name: 'Codex',
    participants: { Codex: f.input.participants.Codex } });
  assert.deepEqual(added.free.members.map(member => member.name), ['Claude', 'Codex']);
  assert.ok(!JSON.stringify(added).includes(load_config(launched.config_path).members.Codex.token));
  const delivered = [];
  const service = new DiscussionService(f.home, (current, store) => new FreeRoomRunner(current, store,
    async (_, binding, task) => { delivered.push(task.participant); return { status: 'accepted' }; }));
  try {
    await service.tick();
    await request(f.site, `${path}/messages`, { author: '用户', text: '两位都看看', to: ['Claude', 'Codex'], submission_id: randomUUID() }, auth);
    await service.tick();
    assert.deepEqual(delivered.sort(), ['Claude', 'Codex']);
    const codex = (await request(f.site, path)).body.free.members.find(member => member.name === 'Codex');
    const old_token = load_config(launched.config_path).members.Codex.token;
    assert.equal((await request(f.site, `${path}/members/${codex.id}`, { action: 'away' }, auth)).status, 200);
    await service.tick();
    const back = await room_member(f.home, { site: f.site, room_id, token: owner, action: 'rejoin', name: 'Codex' });
    assert.equal(back.free.members.find(member => member.name === 'Codex').status, 'active');
    assert.notEqual(load_config(launched.config_path).members.Codex.token, old_token);
    assert.equal((await request(f.site, `${path}/messages`, { author: 'Codex', text: '旧凭证', submission_id: randomUUID() },
      { 'X-Discussion-Token': old_token })).status, 403);
    const manual = await room_member(f.home, { site: f.site, room_id, token: owner, action: 'add', name: 'Antigravity', access: 'manual' });
    const access = JSON.parse(readFileSync(manual.access_file, 'utf8'));
    assert.ok(!JSON.stringify(manual).includes(access.token));
    assert.equal(manual.free.members.find(member => member.name === 'Antigravity').access, 'manual');
    assert.equal((await request(f.site, `${path}/messages`, { author: 'Antigravity', text: '手动接入', source: 'cli', submission_id: randomUUID() },
      { 'X-Discussion-Token': access.token })).status, 201);
    // A removed member's name stays bound locally, so inviting it again joins under the next free name.
    assert.equal((await request(f.site, `${path}/members/${codex.id}`, { action: 'remove' }, auth)).status, 200);
    const again = await room_member(f.home, { site: f.site, room_id, token: owner, action: 'add', name: 'Codex',
      member_token: randomUUID() + randomUUID(), participants: { Codex: f.input.participants.Codex } });
    assert.equal(again.member, 'Codex-2');
    await room_member_model(f.home, { site: f.site, room_id, token: owner, name: 'Codex-2', model: 'gpt-x', effort: 'high' });
    assert.deepEqual([load_config(launched.config_path).participants['Codex-2'].model, load_config(launched.config_path).participants['Codex-2'].effort], ['gpt-x', 'high']);
    await assert.rejects(room_member_model(f.home, { site: f.site, room_id, token: owner, name: 'Codex-2', effort: 'huge' }), /不支持思考强度/);
    await room_member_model(f.home, { site: f.site, room_id, token: owner, name: 'Codex-2', model: '', effort: '' });
    assert.equal(Object.hasOwn(load_config(launched.config_path).participants['Codex-2'], 'model'), false);
  } finally { await service.close(); }
});

test('a running discussion admits a woken or manual expert without pausing', async t => {
  const f = await fixture(t);
  const owner = randomUUID() + randomUUID();
  const launched = await launch_discussion(f.home, { ...f.input, token: owner }, f.options);
  const room_id = launched.room.id;
  assert.equal((await request(f.site, `/api/rooms/${room_id}`)).body.session.status, 'active');
  const store = new DiscussionStore(join(f.directory, 'context-check'));
  try {
    store.context(load_config(launched.config_path));
    const manual = await room_member(f.home, { site: f.site, room_id, token: owner, action: 'add', name: 'Antigravity', access: 'manual' });
    const manual_room = (await request(f.site, `/api/rooms/${room_id}`)).body;
    assert.deepEqual([manual_room.session.status, manual_room.experts.Antigravity, manual.access], ['active', 'cli', 'manual']);
    assert.equal(Object.hasOwn(load_config(launched.config_path).participants, 'Antigravity'), false);
    const added = await room_member(f.home, { site: f.site, room_id, token: owner, action: 'add', name: 'Claude', new_instance: true,
      participants: { Claude: f.input.participants.Claude } });
    assert.equal(added.member, 'Claude-2');
    const added_room = (await request(f.site, `/api/rooms/${room_id}`)).body;
    assert.deepEqual([added_room.session.status, added_room.experts['Claude-2']], ['active', 'cli']);
    const after = load_config(launched.config_path);
    assert.doesNotThrow(() => store.context(after), 'an invited expert only adds a context entry');
    assert.throws(() => store.context({ ...after, participants: { ...after.participants, Claude: { ...after.participants.Claude, cwd: f.directory } } }), /发生变化/);
  } finally { store.close(); }
});

test('an invited existing session must exist locally, and Claude resumes only from its original directory', async t => {
  const f = await fixture(t);
  const env = { CODEX_HOME: join(f.directory, 'codex-home'), CLAUDE_CONFIG_DIR: join(f.directory, 'claude-home') };
  const codex_id = '019ffa5b-9022-7450-b9e0-3c058026dd94', claude_id = randomUUID();
  mkdirSync(join(env.CODEX_HOME, 'sessions', '2026', '10', '21'), { recursive: true });
  writeFileSync(join(env.CODEX_HOME, 'sessions', '2026', '10', '21', `rollout-2026-10-21T10-00-00-${codex_id}.jsonl`), '{}\n');
  const original = join(f.directory, 'original'), other = join(f.directory, 'other');
  for (const path of [original, other, join(env.CLAUDE_CONFIG_DIR, 'projects', 'encoded-original')]) mkdirSync(path, { recursive: true });
  writeFileSync(join(env.CLAUDE_CONFIG_DIR, 'projects', 'encoded-original', `${claude_id}.jsonl`),
    `{"type":"queue-operation"}\n${JSON.stringify({ type: 'user', cwd: original })}\n`);
  assert.equal(borrowed_session('Codex', { adapter: 'codex', session_id: codex_id }, '', env).session_id, codex_id);
  assert.throws(() => borrowed_session('Codex', { adapter: 'codex_cli', session_id: randomUUID() }, '', env), /找不到 Codex CLI 会话/);
  assert.throws(() => borrowed_session('Codex', { adapter: 'codex_cli', session_id: '../../x' }, '', env), /格式不正确/);
  assert.equal(borrowed_session('Claude', { adapter: 'claude', session_id: claude_id }, '', env).cwd, original, 'without a project the session keeps its directory');
  assert.equal(borrowed_session('Claude', { adapter: 'claude', session_id: claude_id }, original, env).cwd, original);
  assert.throws(() => borrowed_session('Claude', { adapter: 'claude', session_id: claude_id }, other, env), /只能在原目录续接/);
  assert.throws(() => borrowed_session('Antigravity', { adapter: 'antigravity_cli', session_id: claude_id }, '', env), /找不到 Antigravity CLI 会话/);
  assert.throws(() => borrowed_session('Grok', { adapter: 'api', session_id: claude_id }, '', env), /只有 Codex CLI、Codex App、Claude Code、Antigravity CLI、Antigravity App 可以接入已有会话/);
  const owner = randomUUID() + randomUUID();
  const launched = await launch_discussion(f.home, { ...f.input, token: owner }, f.options);
  await assert.rejects(room_member(f.home, { site: f.site, room_id: launched.room.id, token: owner, action: 'add', name: 'Claude-2',
    participants: { 'Claude-2': { ...f.input.participants.Claude, session_id: randomUUID() } } }), /找不到 Claude Code 会话/, 'a mistyped ID never reaches the room');
  assert.equal((await request(f.site, `/api/rooms/${launched.room.id}`)).body.experts['Claude-2'], undefined);
});

test('a manual Claude expert\'s reported session is registered as a hosted participant, and a missing session is refused', async t => {
  const f = await fixture(t);
  const claude_home = join(f.directory, 'claude-home-adopt'), claude_id = randomUUID();
  const launched = await launch_discussion(f.home, { ...f.input, token: randomUUID() + randomUUID() }, f.options);
  const cwd = load_config(launched.config_path).cwd || join(f.directory, 'original');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(claude_home, 'projects', 'encoded'), { recursive: true });
  writeFileSync(join(claude_home, 'projects', 'encoded', `${claude_id}.jsonl`), `${JSON.stringify({ type: 'user', cwd })}\n`);
  save_launch_settings(f.home, { participants: { Claude: { adapter: 'claude', executable: process.execPath, model: 'opus', effort: 'high' } } });
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = claude_home;
  try {
    assert.throws(() => adopt_member_profile(f.home, launched.config_path, 'Claude-2', randomUUID(), 'claude', randomUUID() + randomUUID()), /找不到 Claude Code 会话/);
    assert.equal(Object.hasOwn(load_config(launched.config_path).participants, 'Claude-2'), false);
    adopt_member_profile(f.home, launched.config_path, 'Claude-2', claude_id, 'claude', randomUUID() + randomUUID());
    const profile = load_config(launched.config_path).participants['Claude-2'];
    assert.deepEqual([profile.adapter, profile.session_id], ['claude', claude_id]);
    assert.equal(profile.project_access, 'own', 'a manually started member keeps its own session permissions');
    assert.deepEqual([profile.model, profile.effort], [undefined, undefined], 'the machine default never overrides the model chosen in that session');
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous;
  }
});

test('a manual Codex expert is hosted through the app for a desktop chat and the CLI otherwise', async t => {
  const f = await fixture(t);
  const codex_home = join(f.directory, 'codex-home-adopt'), [desktop_id, cli_id] = [randomUUID(), randomUUID()];
  const launched = await launch_discussion(f.home, { ...f.input, token: randomUUID() + randomUUID() }, f.options);
  mkdirSync(join(codex_home, 'sessions', '2026', '10', '23'), { recursive: true });
  for (const [id, originator] of [[desktop_id, 'Codex Desktop'], [cli_id, 'codex_cli_rs']]) {
    writeFileSync(join(codex_home, 'sessions', '2026', '10', '23', `rollout-2026-10-23T08-00-00-${id}.jsonl`), `${JSON.stringify({ type: 'session_meta', payload: { id, originator } })}
`);
  }
  save_launch_settings(f.home, { participants: { Codex: { adapter: 'codex_cli', executable: process.execPath } } });
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codex_home;
  try {
    assert.equal(adopt_member_profile(f.home, launched.config_path, 'Codex-2', desktop_id, 'codex', randomUUID() + randomUUID()), 'codex');
    assert.equal(adopt_member_profile(f.home, launched.config_path, 'Codex-3', cli_id, 'codex', randomUUID() + randomUUID()), 'codex_cli');
    const { participants } = load_config(launched.config_path);
    assert.deepEqual([participants['Codex-2'].session_id, participants['Codex-3'].session_id], [desktop_id, cli_id]);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
  }
});

test('a manual agy expert\'s reported conversation is hosted under its own project, an App one through a Sidecar, and a missing conversation is refused', async t => {
  const f = await fixture(t);
  const home = join(f.directory, 'agy-user-home'), conversation_id = randomUUID();
  const launched = await launch_discussion(f.home, { ...f.input, token: randomUUID() + randomUUID() }, f.options);
  mkdirSync(join(home, '.gemini', 'antigravity-cli', 'conversations'), { recursive: true });
  writeFileSync(join(home, '.gemini', 'antigravity-cli', 'conversations', `${conversation_id}.db`), '');
  save_launch_settings(f.home, { participants: { Antigravity: { adapter: 'antigravity_cli', executable: process.execPath } } });
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = process.env.USERPROFILE = home;
  try {
    assert.throws(() => adopt_member_profile(f.home, launched.config_path, 'Antigravity-2', randomUUID(), 'antigravity'), /找不到 Antigravity CLI 会话/);
    assert.equal(adopt_member_profile(f.home, launched.config_path, 'Antigravity-2', conversation_id, 'antigravity', randomUUID() + randomUUID()), 'antigravity_cli');
    const profile = load_config(launched.config_path).participants['Antigravity-2'];
    assert.deepEqual([profile.adapter, profile.session_id], ['antigravity_cli', conversation_id]);
    // An App conversation lives in the App's own store and is reached through a Sidecar the App starts for this room.
    const app_id = randomUUID();
    mkdirSync(join(home, '.gemini', 'antigravity', 'conversations'), { recursive: true });
    writeFileSync(join(home, '.gemini', 'antigravity', 'conversations', `${app_id}.db`), '');
    assert.equal(adopt_member_profile(f.home, launched.config_path, 'Antigravity-3', app_id, 'antigravity', randomUUID() + randomUUID()), 'antigravity');
    const app = load_config(launched.config_path).participants['Antigravity-3'];
    assert.deepEqual([app.adapter, app.session_id, app.project_access], ['antigravity', app_id, 'own']);
    const sidecars = JSON.parse(readFileSync(join(home, '.gemini', 'config', 'config.json'), 'utf8')).sidecars;
    assert.deepEqual(Object.values(sidecars).map(item => [item.enabled, item.projectId]), [[true, 'outside-of-project']]);
    const [sidecar_id] = Object.keys(sidecars);
    const sidecar = JSON.parse(readFileSync(join(home, '.gemini', 'config', 'sidecars', sidecar_id, 'sidecar.json'), 'utf8'));
    assert.equal(resolve(sidecar.env.CODISCUSS_IPC_DIRECTORY), resolve(app.ipc_directory));
  } finally {
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test('relayed launches resolve projects locally and report back to the paired site', async t => {
  const { local_request, machine_link, sync_remote_launches, unlink_machine } = await import('../runner/remote_launch.mjs');
  const home = mkdtempSync(join(tmpdir(), 'codiscuss-relay-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const link = machine_link(home, 'https://site.test/');
  assert.match(link.id, /^[0-9a-f]{32}$/);
  assert.match(link.token, /^[0-9a-f]{64}$/);
  assert.deepEqual(machine_link(home, 'https://site.test'), link);
  const [project] = save_launch_projects(home, { projects: [{ name: '演示', path: home }] }).projects;
  assert.match(project.id, /^[0-9a-f]{16}$/);
  assert.equal(save_launch_projects(home, { projects: [{ ...project, name: '改名' }] }).projects[0].id, project.id);

  const room = { title: '远程', mode: 'free', members: [], submission_id: 'relay-1' };
  assert.equal(local_request(home, 'https://site.test', { token: 't', room, local_project: project.id }).cwd, home);
  assert.throws(() => local_request(home, 'https://site.test', { token: 't', room, cwd: home }), /已配置的项目/);
  assert.throws(() => local_request(home, 'https://site.test', { token: 't', room, local_project: 'deadbeef' }), /已从这台电脑移除/);

  const calls = [], original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const launches = [{ id: 'relay-1', request: { token: 't', room, local_project: project.id } },
    { id: 'relay-2', request: { token: 't', room: { ...room, submission_id: 'relay-2' }, local_project: 'deadbeef' } }];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, token: options.headers['X-Machine-Token'], body: JSON.parse(options.body) });
    return new Response(JSON.stringify(url.endsWith('/sync') ? { launches } : { status: 'ok' }), { status: 200 });
  };
  const started = [];
  await sync_remote_launches(home, { launch: async (_, input, options) => { started.push({ input, options }); return { room: { id: 'room-9' }, status: 'free' }; } });
  const { public_key, ...published } = calls[0].body;
  assert.deepEqual(published, { projects: [{ id: project.id, name: '改名' }], clients: {} });
  assert.deepEqual(Object.keys(public_key).sort(), ['crv', 'kty', 'x', 'y']);
  assert.equal(link.private_key, undefined, 'the browser forwards the pairing, so it never carries the private key');
  assert.ok(calls.every(call => call.token === link.token && call.url.startsWith(`https://site.test/api/machines/${link.id}/`)));
  assert.deepEqual(started.map(item => [item.input.cwd, item.input.site, item.input.entry, item.options.browser_request]), [[home, 'https://site.test', 'web', true]]);
  assert.deepEqual(calls.slice(1).map(call => call.body.action), ['claim', 'finish', 'claim', 'fail']);
  assert.equal(calls[2].body.room_id, 'room-9');
  assert.match(calls[4].body.error, /已从这台电脑移除/);
  assert.equal(calls[4].body.stage, 'not_started');

  unlink_machine(home, 'https://site.test');
  calls.length = 0;
  await sync_remote_launches(home);
  assert.equal(calls.length, 0);
});

test('relayed commands are decrypted, pinned to the site and answered encrypted', async t => {
  const { machine_link, relay_cipher, relay_commands, relayed_command, seal, sync_remote_launches, unseal } = await import('../runner/remote_launch.mjs');
  const home = mkdtempSync(join(tmpdir(), 'codiscuss-relay-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  machine_link(home, 'https://site.test');
  assert.deepEqual(relayed_command('https://site.test', 'room-member', { room_id: 'r', access_file: 'x', site: 'https://evil.test' }),
    { command: 'room-member', input: { room_id: 'r', site: 'https://site.test', entry: 'web' }, browser: false });
  assert.deepEqual(relayed_command('https://site.test', 'settings', undefined), { command: 'settings', input: undefined, browser: false });
  assert.equal(relayed_command('https://site.test', 'launch', { room: {} }).command, 'start');
  for (const action of ['pick-directory', 'machine-link', 'room-config']) assert.throws(() => relayed_command('https://site.test', action, {}), /不能经其他设备执行/);

  const calls = [], original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let commands = [];
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, body });
    return new Response(JSON.stringify(url.endsWith('/sync') ? { launches: [] } : url.endsWith('/claim') ? { commands } : { status: 'done' }), { status: 200 });
  };
  await sync_remote_launches(home);
  const machine_key = calls[0].body.public_key;
  // The sending device: an ephemeral key pair, a shared key, and the command sealed under its id.
  const ephemeral = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const key = await relay_cipher(await crypto.subtle.exportKey('jwk', ephemeral.privateKey), machine_key);
  const { kty, crv, x, y } = await crypto.subtle.exportKey('jwk', ephemeral.publicKey);
  const sealed = await seal(key, { action: 'room-member', payload: { room_id: 'r', action: 'add', name: 'Antigravity' } }, 'command-0000000001');
  commands = [{ id: 'command-0000000001', envelope: { ...sealed, key: { kty, crv, x, y } } },
    { id: 'command-0000000002', envelope: { ...sealed, key: { kty, crv, x, y } } }];
  const ran = [];
  const running = await relay_commands(home, { wait: 0, run: async request => { ran.push(request); return { status: 200, body: { member: 'Antigravity' } }; } });
  await Promise.all(running);
  assert.equal(calls[1].body.wait, 0);
  assert.deepEqual(ran, [{ command: 'room-member', input: { room_id: 'r', action: 'add', name: 'Antigravity', site: 'https://site.test', entry: 'web' }, browser: false }],
    'a command sealed under another id is not run');
  const answer = calls.find(call => call.url.endsWith('/commands/command-0000000001'));
  assert.deepEqual(await unseal(key, answer.body.envelope, 'command-0000000001:response'), { status: 200, body: { member: 'Antigravity' } });
  assert.ok(!calls.some(call => call.url.endsWith('/commands/command-0000000002')));
});

test('the relay channel reaches only local room routes, as the bridge, and answers compressed and encrypted', async t => {
  const { machine_link, machine_links, relay_cipher, seal } = await import('../runner/remote_launch.mjs');
  const { answer_request, room_api } = await import('../runner/relay_channel.mjs');
  const { gunzipSync } = await import('node:zlib');
  const home = mkdtempSync(join(tmpdir(), 'codiscuss-relay-channel-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  machine_link(home, 'https://site.test');
  writeFileSync(join(home, 'site-connections.json'), JSON.stringify({ sites: { 'https://site.test': { token_hash: 'a'.repeat(64) } } }));
  writeFileSync(join(home, 'local-settings.json'), JSON.stringify({ port: 9876 }));
  const calls = [];
  const fetcher = async (url, options) => { calls.push({ url, options }); return Response.json({ messages: [] }); };

  for (const path of ['/api/local/settings', '/api/admin', '/api/rooms/../local/settings', 'http://evil.test/api/rooms', '/api/rooms?x=<script>']) {
    assert.equal((await room_api(home, 'https://site.test', { path }, { fetcher })).status, 400, path);
  }
  assert.equal(calls.length, 0, 'a refused route never reaches the local website');
  const read = await room_api(home, 'https://site.test', { path: '/api/rooms/abc123/messages?after=0&limit=200' }, { fetcher });
  assert.deepEqual(read, { status: 200, body: { messages: [] } });
  assert.equal(calls[0].url, 'http://127.0.0.1:9876/api/rooms/abc123/messages?after=0&limit=200');
  const bridge = calls[0].options.headers['X-CoDiscuss-Bridge'];
  assert.match(bridge, /^[0-9a-f]{64}$/);
  assert.equal(calls[0].options.headers['X-CoDiscuss-Bridge-Site'], 'https://site.test');
  const connection = JSON.parse(readFileSync(join(home, 'site-connections.json'), 'utf8')).sites['https://site.test'];
  assert.equal(connection.bridge_hash, (await import('node:crypto')).createHash('sha256').update(bridge).digest('hex'), 'the local website keeps only the hash');
  assert.equal(connection.token_hash, 'a'.repeat(64), 'the browser connection is kept');

  // A device seals the request under its id; the answer comes back gzipped and bound to the same id.
  const link = machine_links(home).sites['https://site.test'];
  const ephemeral = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const key = await relay_cipher(await crypto.subtle.exportKey('jwk', ephemeral.privateKey), link.public_key);
  const { kty, crv, x, y } = await crypto.subtle.exportKey('jwk', ephemeral.publicKey);
  const id = 'relay-request-0000000001';
  const sealed = await seal(key, { action: 'room-api', payload: { method: 'POST', path: '/api/rooms/abc123/messages', body: { text: '外出' } } }, id);
  const answer = await answer_request(home, 'https://site.test', link, { id, envelope: { ...sealed, key: { kty, crv, x, y } } }, { fetcher });
  assert.equal(answer.type, 'response');
  assert.equal(answer.envelope.encoding, 'gzip');
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(answer.envelope.iv, 'base64'), additionalData: new TextEncoder().encode(`${id}:response`) },
    key, Buffer.from(answer.envelope.data, 'base64'));
  assert.deepEqual(JSON.parse(gunzipSync(Buffer.from(plain)).toString()), { status: 200, body: { messages: [] } });
  assert.deepEqual(JSON.parse(calls[1].options.body), { text: '外出' });
  await assert.rejects(answer_request(home, 'https://site.test', link, { id: 'relay-request-0000000002', envelope: { ...sealed, key: { kty, crv, x, y } } }, { fetcher }),
    'a request sealed under another id is not run');
  assert.equal(calls.length, 2);
});

test('the relay channel reads and sends files in parts, and runs computer-room operations with the credentials kept here', async t => {
  const { machine_link } = await import('../runner/remote_launch.mjs');
  const { computer_command, room_api, room_upload } = await import('../runner/relay_channel.mjs');
  const home = mkdtempSync(join(tmpdir(), 'codiscuss-relay-files-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  machine_link(home, 'https://site.test');
  writeFileSync(join(home, 'site-connections.json'), JSON.stringify({ sites: { 'https://site.test': {} } }));
  writeFileSync(join(home, 'local-settings.json'), JSON.stringify({ port: 9876 }));

  // A file larger than one frame is read in parts.
  const file = Buffer.alloc(900 * 1024, 7);
  const reader = async () => new Response(file, { headers: { 'Content-Type': 'image/png' } });
  const path = '/api/rooms/abc123/attachments/f1/content';
  const first = await room_api(home, 'https://site.test', { path }, { fetcher: reader });
  const rest = await room_api(home, 'https://site.test', { path, offset: Buffer.from(first.body_base64, 'base64').length }, { fetcher: reader });
  assert.equal(first.total, file.length);
  assert.ok(Buffer.concat([Buffer.from(first.body_base64, 'base64'), Buffer.from(rest.body_base64, 'base64')]).equals(file));

  // An upload reaches the local website once, whole, after every part has arrived; a resent part is not counted twice.
  const sent = [];
  const writer = async (url, options) => { sent.push({ url, options }); return Response.json({ attachment: { id: 'new' } }); };
  const upload = { id: 'upload-000000000001', path: '/api/rooms/abc123/attachments?file_name=a.png&actor=%E7%94%A8%E6%88%B7', total: 2, size: 6 };
  assert.deepEqual(await room_upload(home, 'https://site.test', { ...upload, index: 0, data: Buffer.from('abc').toString('base64') }, { fetcher: writer }),
    { status: 200, body: { received: 1 } });
  await room_upload(home, 'https://site.test', { ...upload, index: 0, data: Buffer.from('abc').toString('base64') }, { fetcher: writer });
  assert.equal(sent.length, 0);
  const done = await room_upload(home, 'https://site.test', { ...upload, index: 1, data: Buffer.from('def').toString('base64') }, { fetcher: writer });
  assert.deepEqual(done, { status: 200, body: { attachment: { id: 'new' } } });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, `http://127.0.0.1:9876${upload.path}`);
  assert.equal(Buffer.from(sent[0].options.body).toString(), 'abcdef');
  assert.match(sent[0].options.headers['X-CoDiscuss-Bridge'], /^[0-9a-f]{64}$/);
  assert.equal((await room_upload(home, 'https://site.test', { ...upload, path: '/api/local/settings', index: 0, data: '' }, { fetcher: writer })).status, 400);

  // A room operation for the computer's rooms names the local website and takes the room credential kept here.
  const config_path = join(home, 'room.json');
  writeFileSync(config_path, JSON.stringify({ site: 'http://localhost:9876', room: 'abc123', token: 'owner-token' }));
  writeFileSync(join(home, 'rooms.json'), JSON.stringify({ configs: [config_path] }));
  const command = computer_command(home, 'https://site.test', 'room-member', { room_id: 'abc123', token: null, action: 'add', name: 'Antigravity' });
  assert.equal(command.input.site, 'http://localhost:9876');
  assert.equal(command.input.token, 'owner-token');
  assert.equal(computer_command(home, 'https://site.test', 'room-member', { room_id: 'other', action: 'add' }).input.token, '', 'no credential for a room served elsewhere');
  assert.equal(computer_command(home, 'https://site.test', 'models', { client: 'claude' }).input.site, undefined, 'other operations are unchanged');
});

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { request as http_request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

import { adopt_member_profile, borrowed_session, cached_software_models, launch_discussion, pick_directory, launch_settings, room_configuration, room_member, save_launch_settings } from '../runner/discussion_launch.mjs';
import { api, DiscussionRunner, DiscussionStore, load_config } from '../runner/discussion_runner.mjs';
import { DiscussionService, read_registry, register_room } from '../runner/discussion_service.mjs';
import { FreeRoomRunner } from '../runner/free_runner.mjs';
import { save_site_connection } from '../runner/discussion_local.mjs';
import { software_effort, software_models } from '../runner/discussion_models.mjs';

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

test('Claude model discovery sends only initialization and strips account metadata', async () => {
  const f = catalog_process((request, child) => child.stdout.write(`${JSON.stringify({ type: 'control_response', response: {
    subtype: 'success', request_id: request.request_id, response: { account: { email: 'private@example.test' }, models: [
      { value: 'opus', displayName: 'Opus', supportedEffortLevels: ['low', 'max'], supportsEffort: true },
      { value: 'older', displayName: 'Older', supportsEffort: false }] } } })}\n`));
  const result = await software_models({ adapter: 'claude', executable: process.execPath }, f);
  assert.deepEqual(result.models, [{ id: 'opus', label: 'Opus', efforts: ['low', 'max'] }, { id: 'older', label: 'Older', efforts: [] }]);
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].request.subtype, 'initialize');
  assert.ok(f.invocations[0][1].includes('--safe-mode'));
  assert.ok(f.invocations[0][1].includes('--no-session-persistence'));
  assert.ok(!JSON.stringify(result).includes('private@example.test'));
  assert.equal(f.child.killed, true);
});

test('directory picker returns only an absolute chosen path and never guesses on cancel', async () => {
  const runs = [];
  const fake = (output, code = 0) => (command, args, options) => {
    runs.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    queueMicrotask(() => { child.stdout.end(output); child.stdout.on('end', () => child.emit('close', code)); child.stdout.resume(); });
    return child;
  };
  const chosen = await pick_directory({ platform: 'win32', spawn_process: fake('D:\\项目\\demo\r\n') });
  assert.deepEqual(chosen, { path: 'D:\\项目\\demo' });
  assert.equal(runs[0].command, 'powershell.exe');
  assert.equal(runs[0].options.shell, false);
  assert.deepEqual(await pick_directory({ platform: 'darwin', spawn_process: fake('', 1) }), { cancelled: true });
  assert.deepEqual(await pick_directory({ platform: 'linux', spawn_process: fake('relative/path\n') }), { cancelled: true });
  await assert.rejects(pick_directory({ platform: 'aix', spawn_process: fake('') }), /直接输入/);
});

test('slow model catalogs are reused until the executable changes or the user retries', async t => {
  const home = mkdtempSync(join(tmpdir(), 'codiscuss-models-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const executable = join(home, 'agy.exe');
  writeFileSync(executable, 'v1');
  const calls = [];
  const query = async profile => { calls.push(profile.adapter); return calls.length === 3
    ? { adapter: profile.adapter, models: [], source: 'antigravity-cli', error: '超时' }
    : { adapter: profile.adapter, models: [{ id: `model-${calls.length}`, label: 'Model' }], source: 'antigravity-cli' }; };
  const profile = { adapter: 'antigravity_cli', executable };
  const effort_calls = [], query_effort = async profile => { effort_calls.push(profile.model || ''); return { levels: ['low', 'medium', 'high'] }; };
  const options = { query, query_effort };
  assert.equal((await cached_software_models(home, profile, options)).models[0].id, 'model-1');
  assert.equal((await cached_software_models(home, profile, options)).models[0].id, 'model-1', 'a new page reads the saved list');
  assert.equal(calls.length, 1);
  assert.equal(effort_calls.length, 1);
  await cached_software_models(home, { ...profile, model: 'model-1' }, options);
  assert.deepEqual(effort_calls, ['', 'model-1']); assert.equal(calls.length, 1, 'changing models only queries native effort');
  assert.equal((await cached_software_models(home, profile, { ...options, refresh: true })).models[0].id, 'model-2');
  assert.match((await cached_software_models(home, profile, { ...options, refresh: true })).error, /超时/);
  assert.equal((await cached_software_models(home, profile, options)).models[0].id, 'model-2', 'a failed retry keeps the last good list');
  writeFileSync(executable, 'v2 upgraded');
  assert.equal((await cached_software_models(home, profile, options)).models[0].id, 'model-4');
  assert.equal(Object.keys(JSON.parse(readFileSync(join(home, 'model-catalogs.json'), 'utf8'))).length, 2, 'old catalog and effort entries are replaced');
});

test('agy effort discovery uses a read-only native command and never guesses on failure', async () => {
  const f = catalog_process();
  const pending = software_effort({ adapter: 'antigravity_cli', executable: process.execPath, model: 'native-model' }, f);
  f.child.stdout.write(JSON.stringify({ status: 'SUCCESS', command: { name: 'effort', data: {
    adjustable: true, current: 'medium', available: ['low', 'medium', 'high'] } } }) + '\n');
  assert.deepEqual(await pending, { levels: ['low', 'medium', 'high'] });
  assert.deepEqual(f.invocations[0][1], ['-p', '/effort', '--output-format', 'json', '--model', 'native-model']);
  assert.equal(f.child.killed, true); assert.deepEqual(f.requests, []);
  const older = catalog_process();
  const unsupported = software_effort({ adapter: 'antigravity_cli', executable: process.execPath }, older);
  older.child.emit('close', 1);
  assert.equal((await unsupported).levels, undefined);
  const fixed = catalog_process();
  const immutable = software_effort({ adapter: 'antigravity_cli', executable: process.execPath }, fixed);
  fixed.child.stdout.write(JSON.stringify({ status: 'SUCCESS', command: { name: 'effort', data: {
    adjustable: false, available: [] } } }) + '\n');
  assert.deepEqual(await immutable, { levels: [] });
});

test('agy explicit effort can be saved without changing its native default model', t => {
  const home = mkdtempSync(join(tmpdir(), 'codiscuss-effort-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const profile = { adapter: 'antigravity_cli', executable: process.execPath, effort: 'low' };
  assert.deepEqual(save_launch_settings(home, { participants: { Gemini: profile } }).participants.Gemini, profile);
  assert.throws(() => save_launch_settings(home, { participants: { Gemini: { ...profile, effort: 'turbo' } } }), /effort 只能是/);
});

test('agy discovery parses native model output and failure never invents choices', async () => {
  const f = catalog_process();
  const pending = software_models({ adapter: 'antigravity_cli', executable: process.execPath }, f);
  f.child.stdout.write('model-high\tModel (High)\nmodel-low  Model (Low)\nFetching models...\n');
  f.child.emit('close', 0);
  assert.deepEqual((await pending).models, [{ id: 'model-high', label: 'Model (High)' }, { id: 'model-low', label: 'Model (Low)' }]);
  assert.deepEqual(f.invocations[0][1], ['models']); assert.deepEqual(f.requests, []);
  const slow = catalog_process();
  const timeout = await software_models({ adapter: 'claude', executable: process.execPath }, { ...slow, timeout_ms: 5 });
  assert.equal(slow.child.killed, true); assert.deepEqual(timeout.models, []); assert.match(timeout.error, /超时/);
  const unused = catalog_process();
  assert.match((await software_models({ adapter: 'codex' }, unused)).error, /原软件/);
  assert.match((await software_models({ adapter: 'claude' }, unused)).error, /完整路径/);
  assert.equal(unused.invocations.length, 0);
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
  service = new DiscussionService(f.home, (current, store) => new DiscussionRunner(current, store,
    async (profile, binding) => { calls.push({ executable: profile.executable, session_id: binding.session_id });
      return { status: 'accepted', session_id: 'original-host' }; }));
  await service.tick();
  await assert.rejects(room_configuration(f.home, input), /先暂停/);
  await api(config, '/runtime', { action: 'pause', revision: (await api(config, '/runtime')).revision });
  await service.tick();
  await assert.rejects(room_configuration(f.home, { ...input, token: 'wrong-owner' }), /403/);
  const before = await room_configuration(f.home, input);
  assert.doesNotMatch(JSON.stringify(before), new RegExp(config.token));
  const replacement = join(f.directory, 'replacement.exe');
  writeFileSync(replacement, 'not executed by this test');
  const corrected = { ...input, version: before.version, runtime_revision: before.runtime_revision,
    participants: { Codex: { executable: replacement } } };
  await assert.rejects(room_configuration(f.home, { ...corrected, version: 'stale' }), /已变化/);
  await assert.rejects(room_configuration(f.home, { ...corrected, participants: { Codex: { session_id: 'other-chat' } } }), /本场修正仅支持/);
  writeFileSync(join(f.home, 'runner.lock'), String(process.pid));
  const interval = setInterval(() => service.tick(), 100);
  let saved;
  try { saved = await room_configuration(f.home, corrected); }
  finally { clearInterval(interval); }
  assert.equal(saved.applied, true);
  assert.equal((await api(config, '/runtime')).status, 'paused');
  assert.equal(calls.length, 1, 'saving a path must not dispatch AI');
  assert.deepEqual(launch_settings(f.home).participants, f.input.participants);
  const worker = service.workers.get(launched.config_path);
  assert.equal(worker.store.binding('Codex').session_id, 'original-host');
  assert.equal(worker.config.participants.Codex.executable, replacement);
  await launch_discussion(f.home, f.input, f.options);
  assert.equal(load_config(launched.config_path).participants.Codex.executable, replacement, 'an original launch retry must not undo the correction');
  const runtime = await api(config, '/runtime');
  await api(config, '/runtime', { action: 'start', mode: 'automatic', revision: runtime.revision, deadline: Math.floor(Date.now() / 1000) + 600 });
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
  service = new DiscussionService(f.home, (current, store) => new DiscussionRunner(current, store,
    async (profile, binding) => { calls.push([profile.adapter, binding.session_id]);
      return { status: 'accepted', session_id: 'original-host' }; }));
  await service.tick();
  await api(config, '/runtime', { action: 'pause', revision: (await api(config, '/runtime')).revision });
  await service.tick();
  writeFileSync(join(f.home, 'runner.lock'), String(process.pid));
  const before = await api(config, '');
  for (const adapter of ['codex', 'codex_cli']) {
    const current = await room_configuration(f.home, input);
    const count = calls.length;
    const interval = setInterval(() => service.tick(), 100);
    let saved;
    try { saved = await room_configuration(f.home, { ...input, version: current.version,
      runtime_revision: current.runtime_revision, participants: { Codex: { adapter } } }); }
    finally { clearInterval(interval); }
    assert.equal(saved.applied, true);
    assert.equal(calls.length, count, 'saving an entrypoint must not start AI');
    assert.equal(saved.participants.Codex.adapter, adapter);
    assert.equal(service.workers.get(launched.config_path).store.binding('Codex').session_id, 'original-host');
    assert.equal(load_config(launched.config_path).participants.Codex.session_id, 'original-host');
    const room = await api(config, '');
    assert.equal(room.runtime.status, 'paused');
    assert.equal(room.runtime.run_id, before.runtime.run_id);
    assert.deepEqual(room.current_turn, before.current_turn);
    await api(config, '/runtime', { action: 'start', mode: 'automatic', revision: room.runtime.revision,
      deadline: Math.floor(Date.now() / 1000) + 600 });
    await service.tick();
    assert.deepEqual(calls.at(-1), [adapter, 'original-host']);
    await api(config, '/runtime', { action: 'pause', revision: (await api(config, '/runtime')).revision });
    await service.tick();
  }
});

test('Codex entrypoint changes reject unbound sessions and unrelated participant changes', async t => {
  const f = await fixture(t);
  const launched = await launch_discussion(f.home, f.input, f.options);
  const config = load_config(launched.config_path);
  await api(config, '/runtime', { action: 'pause', revision: (await api(config, '/runtime')).revision });
  const input = { site: f.site, room_id: config.room, token: config.token };
  const current = await room_configuration(f.home, input);
  const saved = readFileSync(launched.config_path, 'utf8');
  const change = participants => room_configuration(f.home, { ...input, version: current.version,
    runtime_revision: current.runtime_revision, participants });
  await assert.rejects(change({ Codex: { adapter: 'codex' } }), /尚无实际 Codex 会话/);
  await assert.rejects(change({ Claude: { adapter: 'codex' } }), /本场修正仅支持/);
  await assert.rejects(change({ Codex: { adapter: 'codex', session_id: 'replacement' } }), /本场修正仅支持/);
  assert.equal(readFileSync(launched.config_path, 'utf8'), saved);
});

test('local room-config route edits only the authorized paused room and reports an offline worker honestly', async t => {
  const f = await fixture(t);
  const launched = await launch_discussion(f.home, f.input, f.options);
  const config = load_config(launched.config_path);
  await api(config, '/runtime', { action: 'pause', revision: (await api(config, '/runtime')).revision });
  const input = { room_id: config.room, token: config.token };
  const headers = { 'X-CoDiscuss-Local': '1', Origin: f.site };
  const read = await request(f.site, '/api/local/room-config', input, headers);
  assert.equal(read.status, 200);
  assert.equal((await request(f.site, '/api/local/room-config', { ...input, token: 'wrong' }, headers)).status, 400);
  const saved = await request(f.site, '/api/local/room-config', { ...input, version: read.body.version,
    runtime_revision: read.body.runtime_revision, participants: { Codex: { executable: process.execPath } } }, headers);
  assert.equal(saved.status, 200);
  assert.equal(saved.body.applied, false);
  assert.equal((await api(config, '/runtime')).status, 'paused');
});

test('room-models bridge pins the connected site and reads without changing a running discussion', async t => {
  const f = await fixture(t);
  f.input.participants.Codex.model = 'gpt-6-astra';
  f.input.participants.Codex.effort = 'xhigh';
  const launched = await launch_discussion(f.home, f.input, f.options);
  const config = load_config(launched.config_path);
  const before = await api(config, '/runtime');
  const contents = readFileSync(launched.config_path, 'utf8');
  const input = { room_id: config.room, site: 'https://spoof.example', access_file: 'must-not-be-read',
    participants: { Codex: { model: 'must-not-be-written' } } };
  const headers = { 'X-CoDiscuss-Local': '1', Origin: f.site };
  const read = await request(f.site, '/api/local/room-models', input, headers);
  assert.equal(read.status, 200);
  assert.deepEqual(read.body.participants.Codex, { adapter: 'codex_cli', model: 'gpt-6-astra', effort: 'xhigh' });
  assert.equal(readFileSync(launched.config_path, 'utf8'), contents);
  assert.equal((await api(config, '/runtime')).revision, before.revision);
  assert.equal((await api(config, '/runtime')).status, 'running');
  assert.equal((await request(f.site, '/api/local/room-models', input)).status, 403);
  const origin = 'https://discussion.example', token = 'c'.repeat(64);
  const remote_path = join(f.directory, 'connected-room.json');
  writeFileSync(remote_path, JSON.stringify({ ...config, site: origin,
    participants: { Codex: { ...config.participants.Codex, model: 'connected-room-model' } } }));
  register_room(f.home, remote_path);
  save_site_connection(f.home, origin, token);
  const connected = { Origin: origin, 'X-CoDiscuss-Local': '1', 'X-CoDiscuss-Connection': token };
  const remote_read = await request(f.site, '/api/local/room-models', { room_id: config.room, site: f.site }, connected);
  assert.equal(remote_read.status, 200);
  assert.equal(remote_read.body.participants.Codex.model, 'connected-room-model');
  assert.equal(remote_read.headers['access-control-allow-origin'], origin);
  assert.equal((await request(f.site, '/api/local/room-models', input, { ...connected, 'X-CoDiscuss-Connection': '' })).status, 403);
  const preflight = await fetch(`${f.site}/api/local/room-models`, { method: 'OPTIONS', headers: {
    Origin: origin, 'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'content-type,x-codiscuss-local,x-codiscuss-connection' } });
  assert.equal(preflight.status, 200);
  await preflight.json();
  assert.equal(f.starts.length, 1, 'readback must not start another service or dispatch AI');
});

/** Run the real website in a temporary database; no actual AI software is invoked. */
async function fixture(t, local_launch = true) {
  const directory = mkdtempSync(join(tmpdir(), 'codiscuss-launch-'));
  const home = join(directory, 'service');
  const script = 'import sys; from backend.server import DiscussionServer,init_database; '
    + 'init_database(sys.argv[1],seed=False); '
    + `server=DiscussionServer(('127.0.0.1',0),sys.argv[1],local_launch=${local_launch ? 'True' : 'False'});\n`
    + `while server.server_port <= 10080:\n server.server_close(); server=DiscussionServer(('127.0.0.1',0),sys.argv[1],local_launch=${local_launch ? 'True' : 'False'})\n`
    + 'print(server.server_port,flush=True); server.serve_forever()';
  const child = spawn(process.platform === 'win32' ? 'python' : 'python3', ['-u', '-c', script, join(directory, 'site.sqlite3')],
    { cwd: ROOT, windowsHide: true, env: { ...process.env, DISCUSS_SERVICE_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = new Promise(resolve => child.once('close', resolve));
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  t.after(async () => { child.kill(); await closed; rmSync(directory, { recursive: true, force: true }); });
  const port = await new Promise((resolve, reject) => {
    child.stdout.once('data', data => resolve(Number(String(data).trim())));
    child.once('error', reject);
    child.once('exit', () => reject(new Error(errors)));
  });
  const site = `http://127.0.0.1:${port}`;
  const participants = { Codex: { adapter: 'codex_cli', executable: process.execPath }, Claude: { adapter: 'claude', executable: process.execPath } };
  const input = { site, entry: 'web', participants,
    room: { title: '隔离启动验证', host: 'Codex', experts: { Codex: 'cli', Claude: 'cli' },
      limits: { max_rounds: 3, max_minutes: 15 }, submission_id: randomUUID() } };
  const starts = [];
  const options = { start_service: async value => { starts.push(value); return { running: true }; } };
  return { directory, home, site, input, options, starts };
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

test('machine defaults and per-discussion overrides share validation without persisting session IDs', async t => {
  const f = await fixture(t);
  save_launch_settings(f.home, { participants: f.input.participants });
  assert.deepEqual(launch_settings(f.home).participants, f.input.participants);
  assert.throws(() => save_launch_settings(f.home, { participants: { Codex: { ...f.input.participants.Codex, session_id: 'must-not-be-global' } } }), /不能保存房间或会话/);
  assert.throws(() => save_launch_settings(f.home, { participants: { Codex: { executable: './codex.exe' } } }), /绝对路径/);
  const input = { ...f.input, participants: { Claude: { cwd: f.directory } } };
  const result = await launch_discussion(f.home, input, { dry_run: true });
  assert.equal(result.participants.Claude.cwd, f.directory);
  assert.equal(result.participants.Codex.adapter, 'codex_cli');
  assert.equal((await request(f.site, '/api/rooms')).body.rooms.length, 0);
  assert.equal(read_registry(f.home).length, 0);
  assert.equal(existsSync(join(f.home, 'launches')), false);
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
  const service = new DiscussionService(local.home, (current, store) => new DiscussionRunner(current, store,
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
    const runtime = await api(config, '/runtime');
    await api(config, '/runtime', { action: 'pause', revision: runtime.revision });
    await request(local.site, '/api/local/launch', input, headers);
    await service.tick();
    assert.equal((await api(config, '/runtime')).status, 'paused');
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
    assert.equal(result.room.runtime.deadline, 0);
    assert.equal(result.room.runtime.expired, false);
    assert.equal(result.room.limits.max_rounds, 3);
    assert.equal(result.room.limits.execution_minutes, 0);
    assert.equal(result.room.limits.remaining_seconds, null);
    const retry = await launch_discussion(f.home, f.input, f.options);
    assert.equal(retry.room.id, result.room.id);
    assert.equal(retry.room.runtime.generation, result.room.runtime.generation);
    assert.equal(read_registry(f.home).length, 1);
    if (entry === 'conversation') assert.equal(retry.current_task.event_id, result.current_task.event_id);
  });
}

test('zero launch minutes still respects a finite topic duration', async t => {
  const f = await fixture(t);
  const result = await launch_discussion(f.home, { ...f.input, minutes: 0 }, f.options);
  assert.ok(result.room.runtime.deadline > Math.floor(Date.now() / 1000));
  assert.ok(result.room.runtime.deadline <= Math.floor(Date.now() / 1000) + 15 * 60);
});

test('project write access is per launch, defaults to read and can differ per participant', async t => {
  const f = await fixture(t);
  assert.throws(() => save_launch_settings(f.home, { participants: { Codex: { ...f.input.participants.Codex, project_access: 'write' } } }), /不能保存房间或会话/);
  const preview = input => launch_discussion(f.home, { ...f.input, cwd: f.directory, ...input }, { dry_run: true });
  assert.equal((await preview({})).participants.Codex.project_access, 'read');
  const mixed = await preview({ project_access: 'write', participants: { ...f.input.participants, Claude: { ...f.input.participants.Claude, project_access: 'read' } } });
  assert.equal(mixed.participants.Codex.project_access, 'write'); assert.equal(mixed.participants.Claude.project_access, 'read');
  const inherited = await preview({ project_access: 'write', participants: { ...f.input.participants, Claude: { ...f.input.participants.Claude, project_access: '' } } });
  assert.equal(inherited.participants.Claude.project_access, 'write');
  await assert.rejects(preview({ project_access: 'admin' }), /read 或 write/);
});

test('explicit empty participant settings fall back to this discussion without changing saved defaults', async t => {
  const f = await fixture(t);
  const defaults = { ...f.input.participants, Codex: { ...f.input.participants.Codex,
    cwd: f.directory, project_name: 'saved-project', project_id: 'saved-id' } };
  save_launch_settings(f.home, { participants: defaults });
  const result = await launch_discussion(f.home, { ...f.input, cwd: f.home, discussion_project: 'this-project',
    participants: { Codex: { cwd: '', project_name: '', project_id: '' } } }, { dry_run: true });
  assert.equal(result.participants.Codex.cwd, f.home);
  assert.equal(result.participants.Codex.project_name, 'this-project');
  assert.equal(result.participants.Codex.project_id, undefined);
  assert.deepEqual(launch_settings(f.home).participants, defaults);
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
  const created = await request(f.site, '/api/rooms', { ...f.input.room, runtime_mode: 'automatic',
    members: Object.keys(f.input.room.experts).map(name => ({ name, access: 'runner', token: randomUUID() })) }, { 'X-Discussion-Token': token });
  const input = { site: f.site, room_id: created.body.id, entry, participants: f.input.participants,
    current_session_id: 'actual-host-session', token: randomUUID() };
  await assert.rejects(launch_discussion(f.home, input, f.options), /403/);
  assert.equal(existsSync(f.home), false, 'failed authorization must not persist a poisoned journal');
  assert.equal(f.starts.length, 0);
  assert.equal((await request(f.site, `/api/rooms/${input.room_id}`)).body.runtime.status, 'ready');
  const result = await launch_discussion(f.home, { ...input, token }, f.options);
  assert.equal(result.status, 'running');
  assert.equal(load_config(result.config_path).token, token);
});

test('correcting a legacy credential updates its live worker without changing the run or session', async t => {
  const f = await fixture(t);
  const token = randomUUID();
  const input = { ...f.input, token };
  const first = await launch_discussion(f.home, input, f.options);
  const journal_path = join(dirname(first.config_path), 'launch.json');
  const journal = JSON.parse(readFileSync(journal_path, 'utf8'));
  const saved = JSON.parse(readFileSync(first.config_path, 'utf8'));
  journal.token = saved.token = randomUUID();
  for (const field of ['config', 'minutes', 'room_id', 'request_signature']) delete journal[field];
  writeFileSync(journal_path, JSON.stringify(journal));
  writeFileSync(first.config_path, JSON.stringify(saved));
  const calls = [];
  const service = new DiscussionService(f.home, (config, store) => new DiscussionRunner(config, store,
    async () => { calls.push('delivered'); return { status: 'accepted', session_id: 'same-host' }; }));
  try {
    await service.tick();
    assert.match([...service.workers.values()][0].state.error, /403/);
    const recovered = await launch_discussion(f.home, input, { ...f.options, browser_request: true });
    assert.equal(recovered.room.runtime.generation, first.room.runtime.generation);
    assert.equal(load_config(first.config_path).token, token);
    await service.tick();
    await service.tick();
    assert.deepEqual(calls, ['delivered']);
    assert.equal([...service.workers.values()][0].store.binding('Codex').session_id, 'same-host');
  } finally { await service.close(); }
});

test('unrelated malformed registrations do not block launch and broken software still preserves room ownership', async t => {
  const f = await fixture(t);
  mkdirSync(f.home, { recursive: true });
  const broken = join(f.home, 'unrelated.json');
  writeFileSync(broken, '{');
  writeFileSync(join(f.home, 'rooms.json'), JSON.stringify({ configs: [broken] }));
  const started = await launch_discussion(f.home, f.input, f.options);
  assert.equal(started.status, 'running');
  assert.deepEqual(read_registry(f.home), [broken, started.config_path]);
  const conflicting = join(f.home, 'same-room.json');
  writeFileSync(conflicting, JSON.stringify({ site: f.site, room: started.room.id, participants: {} }));
  writeFileSync(join(f.home, 'rooms.json'), JSON.stringify({ configs: [broken, conflicting] }));
  await assert.rejects(launch_discussion(f.home, f.input, f.options), /另一份接入配置/);
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
  const agy_room = { ...f.input.room, host: 'Gemini', experts: { Gemini: 'cli', Claude: 'cli' } };
  await assert.rejects(launch_discussion(f.home, { ...f.input, room: agy_room, entry: 'conversation', current_session_id: 'agy-chat',
    participants: { ...f.input.participants, Gemini: agy } }, f.options), /agy 不能绑定已有会话/);
  await assert.rejects(launch_discussion(f.home, { ...f.input, room: agy_room,
    participants: { ...f.input.participants, Gemini: { ...agy, session_id: 'known-session' } } }, f.options), /agy 不能绑定已有会话/);
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
  assert.equal(first.status, 'running');
  assert.equal(first.current_task, null);
  assert.equal(read_registry(f.home).length, 1);
  assert.equal(f.starts.length, 1);
  const config = load_config(first.config_path);
  assert.ok(!JSON.stringify(first).includes(config.token));
  const store = new DiscussionStore(config.directory);
  try {
    const calls = [];
    const runner = new DiscussionRunner(config, store, async (_, binding, task) => {
      calls.push(task.participant); return { status: 'accepted', session_id: 'web-host' };
    });
    await runner.tick();
    await runner.tick();
    assert.deepEqual(calls, ['Codex']);
  } finally { store.close(); }
  await assert.rejects(launch_discussion(f.home, { ...f.input, minutes: 10 }, f.options), /原请求不同/);
});

test('conversation entry gives the first host task to the real current session, then hands the next turn to the expert', async t => {
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
  assert.ok(!JSON.stringify(result).includes(access.token));
  const calls = [];
  const store = new DiscussionStore(config.directory);
  try {
    const runner = new DiscussionRunner(config, store, async (_, binding, task) => {
      calls.push(task.participant); return { status: 'accepted', session_id: 'expert-session' };
    });
    await runner.tick();
    assert.deepEqual(calls, []);
    await api(config, `/events/${result.current_task.event_id}`, { action: 'enter', session_id: access.session_id }, access.token);
    await runner.tick();
    const room = await api(config, '');
    if (room.floor.holder !== 'Codex') await api(config, '/floor', { action: 'take', actor: 'Codex', revision: room.floor.revision }, access.token);
    await api(config, '/turns', { actor: 'Codex', expert: 'Claude', question: '请给出独立观点', submission_id: randomUUID() }, access.token);
    await runner.tick();
    assert.deepEqual(calls, ['Claude']);
    assert.equal(store.binding('Codex').session_id, 'current-real-session');
  } finally { store.close(); }
});

test('a restart after the website accepted start reconciles the same generation instead of starting again', async t => {
  const f = await fixture(t);
  const first = await launch_discussion(f.home, f.input, f.options);
  const journal_path = join(dirname(first.config_path), 'launch.json');
  const journal = JSON.parse(readFileSync(journal_path, 'utf8'));
  delete journal.generation;
  delete journal.finished;
  writeFileSync(journal_path, JSON.stringify(journal));
  const next = await launch_discussion(f.home, f.input, f.options);
  assert.equal(next.room.runtime.generation, first.room.runtime.generation);
  assert.equal((await api(load_config(first.config_path), '/events?after=0')).events.length, 1);
  const config = load_config(first.config_path);
  const runtime = await api(config, '/runtime');
  const stopped = await api(config, '/runtime', { action: 'pause', revision: runtime.revision });
  const paused = await launch_discussion(f.home, f.input, f.options);
  await assert.rejects(launch_discussion(f.home, { site: f.site, entry: 'web', room_id: first.room.id,
    access_file: first.config_path, participants: f.input.participants }, f.options), /房间已启动过/);
  assert.equal(paused.status, 'paused');
  assert.equal(paused.room.runtime.generation, stopped.generation);
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
  assert.equal((await api(config, '/events?after=0')).events.length, 1);
});

test('an interrupted launch cannot start a room paused before service recovery', async t => {
  const f = await fixture(t);
  const input = { ...f.input, token: randomUUID() };
  let failure;
  await assert.rejects(launch_discussion(f.home, input, { browser_request: true,
    start_service: async () => { throw new Error('interrupted before start'); } }), error => {
    failure = error.launch;
    return error.message === 'interrupted before start';
  });
  assert.equal(failure.stage, 'created');
  const journal = JSON.parse(readFileSync(join(f.home, 'launches', readdirSync(join(f.home, 'launches'))[0], 'launch.json'), 'utf8'));
  const config = { ...journal.config, room: failure.room_id };
  const runtime = await api(config, '/runtime');
  const paused = await api(config, '/runtime', { action: 'pause', revision: runtime.revision });
  await assert.rejects(launch_discussion(f.home, input, { ...f.options, browser_request: true }), /暂停|状态已变化/);
  const actual = await api(config, '/runtime');
  assert.equal(actual.status, 'paused');
  assert.equal(actual.generation, paused.generation);
  assert.equal((await api(config, '/events?after=0')).events.length, 0);
  assert.equal(read_registry(f.home).length, 0);
});

test('a rejected first launch reports no side effects and a changed retry cannot replace its saved request', async t => {
  const f = await fixture(t);
  await assert.rejects(launch_discussion(f.home, { ...f.input, participants: {} }, { browser_request: true }), error => {
    assert.equal(error.launch.stage, 'not_started');
    return true;
  });
  assert.equal((await request(f.site, '/api/rooms')).body.rooms.length, 0);
  const input = { ...f.input, token: randomUUID() };
  await assert.rejects(launch_discussion(f.home, input, { start_service: async () => { throw new Error('offline'); } }), /offline/);
  await assert.rejects(launch_discussion(f.home, { ...input, room: { ...input.room, title: 'changed' } }, { ...f.options, browser_request: true }), /原请求不同/);
  const recovered = await launch_discussion(f.home, input, { ...f.options, browser_request: true });
  assert.equal(recovered.room.title, f.input.room.title);
  assert.equal((await request(f.site, '/api/rooms')).body.rooms.length, 1);
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
        || (boundary === 'started' && action === 'start')
        || (boundary === 'reserved' && action === 'reserve'))) crash();
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
    const events = (await api(config, '/events?after=0')).events;
    assert.equal(events.length, 1);
    assert.equal(events[0].generation, receipt.room.runtime.generation);
    const store = new DiscussionStore(config.directory);
    try {
      let deliveries = 0;
      const runner = new DiscussionRunner(config, store, async () => { deliveries++; return { status: 'accepted', session_id: 'created-host' }; });
      await runner.tick();
      await runner.tick();
      assert.equal(deliveries, entry === 'conversation' ? 0 : 1);
      assert.equal(store.binding('Codex').session_id, entry === 'conversation' ? 'original-host' : 'created-host');
      assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    } finally { store.close(); }
    const runtime = await api(config, '/runtime');
    const paused = await api(config, '/runtime', { action: 'pause', revision: runtime.revision });
    const replayed = interrupted_launcher(f, input, 'recover');
    assert.equal(replayed.status, 0, replayed.stderr);
    assert.equal(JSON.parse(replayed.stdout).status, 'paused');
    assert.equal(JSON.parse(replayed.stdout).room.runtime.generation, paused.generation);
    assert.equal((await api(config, '/events?after=0')).events.length, 1);
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
  assert.equal(first.room.runtime.mode, 'manual');
  assert.deepEqual(first.room.free.members.map(member => member.name), ['Claude']);
  const config = load_config(first.config_path);
  assert.equal(config.mode, 'free');
  assert.ok(!JSON.stringify(first).includes(config.members.Claude.token));
  const path = `/api/rooms/${config.room}`;
  assert.equal((await request(f.site, `${path}/messages`, { author: '用户', text: '改标题', submission_id: randomUUID() })).status, 403);
  assert.equal((await request(f.site, `${path}/messages`, { author: '用户', text: '改标题', submission_id: randomUUID() },
    { 'X-Discussion-Token': input.token })).status, 201);
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
    const manual = await room_member(f.home, { site: f.site, room_id, token: owner, action: 'add', name: 'Gemini', access: 'manual' });
    const access = JSON.parse(readFileSync(manual.access_file, 'utf8'));
    assert.ok(!JSON.stringify(manual).includes(access.token));
    assert.equal(manual.free.members.find(member => member.name === 'Gemini').access, 'manual');
    assert.equal((await request(f.site, `${path}/messages`, { author: 'Gemini', text: '手动接入', source: 'cli', submission_id: randomUUID() },
      { 'X-Discussion-Token': access.token })).status, 201);
  } finally { await service.close(); }
});

test('a free room is created with woken, manual and online members chosen one by one', async t => {
  const f = await fixture(t);
  const owner = randomUUID() + randomUUID(), manual_token = randomUUID() + randomUUID();
  const members = [{ name: 'Claude', access: 'runner', token: randomUUID() + randomUUID() },
    { name: 'Codex', access: 'manual', token: manual_token }, { name: 'DeepSeek', access: 'online', token: randomUUID() + randomUUID() }];
  const launched = await launch_discussion(f.home, { site: f.site, entry: 'web', participants: f.input.participants, token: owner,
    room: { title: '混合接入', goal: 'x', mode: 'free', members, submission_id: randomUUID() } }, f.options);
  assert.deepEqual(launched.room.free.members.map(member => [member.name, member.access]), [['Claude', 'runner'], ['Codex', 'manual'], ['DeepSeek', 'online']]);
  assert.deepEqual(Object.keys(load_config(launched.config_path).participants), ['Claude'], 'only woken members get local configuration');
  assert.equal((await request(f.site, `/api/rooms/${launched.room.id}/messages`, { author: 'Codex', text: '手动成员', source: 'cli', submission_id: randomUUID() },
    { 'X-Discussion-Token': manual_token })).status, 201);
});

test('a discussion is created with a manual expert that gets no local configuration and answers with its own credential', async t => {
  const f = await fixture(t);
  const owner = randomUUID() + randomUUID(), manual_token = randomUUID() + randomUUID();
  const room = { ...f.input.room, experts: { Codex: 'cli', Claude: 'cli', Gemini: 'cli' },
    members: [{ name: 'Gemini', access: 'manual', token: manual_token }], submission_id: randomUUID() };
  const launched = await launch_discussion(f.home, { ...f.input, room, token: owner }, f.options);
  assert.deepEqual(Object.keys(load_config(launched.config_path).participants).sort(), ['Claude', 'Codex']);
  const access = Object.fromEntries(launched.room.members.map(member => [member.name, member.access]));
  assert.deepEqual(access, { Codex: 'runner', Claude: 'runner', Gemini: 'manual' });
  await assert.rejects(launch_discussion(f.home, { ...f.input, token: owner, room: { ...f.input.room, host: 'Gemini', experts: { Gemini: 'cli', Claude: 'cli' },
    members: [{ name: 'Gemini', access: 'manual', token: manual_token }], submission_id: randomUUID() } }, f.options), /不能选择手动接入/);
});

test('a running discussion admits a woken or manual expert without pausing', async t => {
  const f = await fixture(t);
  const owner = randomUUID() + randomUUID();
  const launched = await launch_discussion(f.home, { ...f.input, token: owner }, f.options);
  const room_id = launched.room.id;
  assert.equal((await request(f.site, `/api/rooms/${room_id}`)).body.runtime.status, 'running');
  const store = new DiscussionStore(join(f.directory, 'context-check'));
  try {
    store.context(load_config(launched.config_path));
    const manual = await room_member(f.home, { site: f.site, room_id, token: owner, action: 'add', name: 'Gemini', access: 'manual' });
    assert.deepEqual([manual.room.runtime.status, manual.room.experts.Gemini, manual.access], ['running', 'cli', 'manual']);
    assert.equal(Object.hasOwn(load_config(launched.config_path).participants, 'Gemini'), false);
    const added = await room_member(f.home, { site: f.site, room_id, token: owner, action: 'add', name: 'Claude', new_instance: true,
      participants: { Claude: f.input.participants.Claude } });
    assert.equal(added.member, 'Claude-2');
    assert.deepEqual([added.room.runtime.status, added.room.experts['Claude-2']], ['running', 'cli']);
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
  assert.throws(() => borrowed_session('Codex', { adapter: 'codex_cli', session_id: randomUUID() }, '', env), /找不到 Codex 会话/);
  assert.throws(() => borrowed_session('Codex', { adapter: 'codex_cli', session_id: '../../x' }, '', env), /格式不正确/);
  assert.equal(borrowed_session('Claude', { adapter: 'claude', session_id: claude_id }, '', env).cwd, original, 'without a project the session keeps its directory');
  assert.equal(borrowed_session('Claude', { adapter: 'claude', session_id: claude_id }, original, env).cwd, original);
  assert.throws(() => borrowed_session('Claude', { adapter: 'claude', session_id: claude_id }, other, env), /只能在原目录续接/);
  assert.throws(() => borrowed_session('Gemini', { adapter: 'antigravity_cli', session_id: claude_id }, '', env), /只有 Codex 与 Claude/);
  const owner = randomUUID() + randomUUID();
  const launched = await launch_discussion(f.home, { ...f.input, token: owner }, f.options);
  await assert.rejects(room_member(f.home, { site: f.site, room_id: launched.room.id, token: owner, action: 'add', name: 'Claude-2',
    participants: { 'Claude-2': { ...f.input.participants.Claude, session_id: randomUUID() } } }), /找不到 Claude 会话/, 'a mistyped ID never reaches the room');
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
  save_launch_settings(f.home, { participants: { Claude: { adapter: 'claude', executable: process.execPath } } });
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = claude_home;
  try {
    assert.throws(() => adopt_member_profile(f.home, launched.config_path, 'Claude-2', randomUUID()), /找不到 Claude 会话/);
    assert.equal(Object.hasOwn(load_config(launched.config_path).participants, 'Claude-2'), false);
    adopt_member_profile(f.home, launched.config_path, 'Claude-2', claude_id);
    const profile = load_config(launched.config_path).participants['Claude-2'];
    assert.deepEqual([profile.adapter, profile.session_id], ['claude', claude_id]);
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
    assert.equal(adopt_member_profile(f.home, launched.config_path, 'Codex-2', desktop_id, 'codex'), 'codex');
    assert.equal(adopt_member_profile(f.home, launched.config_path, 'Codex-3', cli_id, 'codex'), 'codex_cli');
    const { participants } = load_config(launched.config_path);
    assert.deepEqual([participants['Codex-2'].session_id, participants['Codex-3'].session_id], [desktop_id, cli_id]);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
  }
});

test('an extra instance inherits its platform settings but not its bound session, and names are never reused', async t => {
  const f = await fixture(t);
  assert.throws(() => save_launch_settings(f.home, { participants: { 'Claude-2': { adapter: 'claude', executable: process.execPath } } }), /按平台保存/);
  const owner = randomUUID() + randomUUID();
  const input = { site: f.site, entry: 'web', token: owner,
    participants: { Claude: { ...f.input.participants.Claude, session_id: 'my-open-chat', model: 'sonnet' }, 'Claude-评审': { model: 'opus', effort: 'high' } },
    room: { title: '双 Claude', goal: 'x', mode: 'free', members: ['Claude', 'Claude-评审'], submission_id: randomUUID() } };
  const launched = await launch_discussion(f.home, input, f.options);
  const config = load_config(launched.config_path);
  assert.equal(config.participants.Claude.session_id, 'my-open-chat');
  assert.equal(config.participants['Claude-评审'].session_id, undefined);
  assert.deepEqual([config.participants['Claude-评审'].adapter, config.participants['Claude-评审'].model, config.participants['Claude-评审'].effort], ['claude', 'opus', 'high']);
  assert.notEqual(config.members.Claude.token, config.members['Claude-评审'].token);
  assert.deepEqual(launched.room.free.members.map(member => [member.name, member.session_mode]), [['Claude', 'borrowed'], ['Claude-评审', 'new']]);
  const room_id = launched.room.id;
  const added = await room_member(f.home, { site: f.site, room_id, token: owner, action: 'add', name: 'Claude', new_instance: true,
    participants: { Claude: f.input.participants.Claude } });
  assert.equal(added.member, 'Claude-2');
  const member = added.free.members.find(item => item.name === 'Claude-2');
  assert.equal((await request(f.site, `/api/rooms/${room_id}/members/${member.id}`, { action: 'remove' }, { 'X-Discussion-Token': owner })).status, 200);
  const again = await room_member(f.home, { site: f.site, room_id, token: owner, action: 'add', name: 'Claude', new_instance: true,
    participants: { Claude: f.input.participants.Claude } });
  assert.equal(again.member, 'Claude-3', 'a removed instance name keeps its local session, so it is skipped');
});

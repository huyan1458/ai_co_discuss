import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { request as http_request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

import { launch_discussion, launch_settings, room_configuration, save_launch_settings } from '../runner/discussion_launch.mjs';
import { api, DiscussionRunner, DiscussionStore, load_config } from '../runner/discussion_runner.mjs';
import { DiscussionService, read_registry } from '../runner/discussion_service.mjs';
import { save_site_connection } from '../runner/discussion_local.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

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
  const created = await request(f.site, '/api/rooms', { ...f.input.room, runtime_mode: 'automatic' }, { 'X-Discussion-Token': token });
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

test('missing software, current identity or finite limits fail before creating rooms or starting a service', async t => {
  const f = await fixture(t);
  await assert.rejects(launch_discussion(f.home, { ...f.input, participants: {} }, f.options), /请配置 Codex/);
  await assert.rejects(launch_discussion(f.home, { ...f.input, entry: 'conversation' }, f.options), /current_session_id/);
  await assert.rejects(launch_discussion(f.home, { ...f.input, minutes: 0 }, f.options), /总时长/);
  await assert.rejects(launch_discussion(f.home, { ...f.input, cwd: './project' }, f.options), /绝对路径/);
  await assert.rejects(launch_discussion(f.home, { ...f.input, participants: { ...f.input.participants, Codex: { adapter: 'codex_cli', executable: f.directory } } }, f.options), /可执行文件/);
  await assert.rejects(launch_discussion(f.home, { ...f.input, participants: { ...f.input.participants, Claude: { adapter: 'claude', executable: join(f.directory, 'missing.exe') } } }, f.options), /可执行文件/);
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

/** Verify release isolation, static routing, and the direct D1 deployment contract. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import vm from "node:vm";

import { build_pages } from "../scripts/build_pages.mjs";
import worker from "../backend/worker.mjs";
import { MachineRelay } from "../backend/updates.mjs";

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Run the Worker against an in-memory copy of the D1 schema. */
async function worker_fixture(test_case) {
  const sql = new DatabaseSync(':memory:');
  sql.exec(await readFile(join(PROJECT_ROOT, 'backend', 'schema.sql'), 'utf8'));
  test_case.after(() => sql.close());
  function prepare(query, values = []) {
    const statement = sql.prepare(query);
    const execute = () => ({ results: statement.all(...values), meta: sql.prepare('SELECT changes() AS changes').get() });
    return { bind: (...args) => prepare(query, args), execute,
      all: async () => execute(), run: async () => execute(),
      first: async column => { const row = statement.get(...values); return column ? row?.[column] ?? null : row ?? null; } };
  }
  const database = { prepare, batch: async statements => {
    sql.exec('BEGIN IMMEDIATE');
    try { const results = statements.map(statement => statement.execute()); sql.exec('COMMIT'); return results; }
    catch (error) { sql.exec('ROLLBACK'); throw error; }
  } };
  return { sql, env: { DB: database } };
}

/** Create a pinned release without reading the shared development assets. */
async function release_fixture(test_case, legacy_layout = false) {
  const root = await mkdtemp(join(tmpdir(), "discuss-pages-test-"));
  test_case.after(async () => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + "/") || resolve(root).startsWith(resolve(tmpdir()) + "\\"));
    await rm(root, { recursive: true, force: true });
  });
  const source = join(root, "release");
  await mkdir(join(source, "web", "modern"), { recursive: true });
  await mkdir(join(source, "frontend"));
  await mkdir(join(source, "backend"));
  await mkdir(join(source, "docs"));
  const worker_path = join(source, legacy_layout ? "worker.mjs" : "backend/worker.mjs");
  const notices_path = join(source, legacy_layout ? "THIRD_PARTY_NOTICES.md" : "docs/THIRD_PARTY_NOTICES.md");
  await writeFile(worker_path, "export default { fetch() { return new Response('pinned release'); } };\n");
  await writeFile(join(source, "web", "index.html"), "<h1>已验收版本</h1>\n");
  await writeFile(join(source, "web", "app.js"), "/* published assets */\n");
  await writeFile(join(source, "frontend", "Draft.vue"), "unpublished component");
  await writeFile(join(source, "web", "modern", "Draft.vue"), "unpublished legacy source");
  await writeFile(join(source, "web", ".private"), "unpublished file");
  await cp(join(PROJECT_ROOT, "pages", "public"), join(source, "pages", "public"), { recursive: true });
  await writeFile(join(source, "LICENSE"), "License from the selected release\n");
  await writeFile(notices_path, "Notices from the selected release\n");
  return { root, source, worker_path, notices_path };
}

test("a pinned release uses its own backend and assets and removes stale output", async (test_case) => {
  const { root, source, worker_path } = await release_fixture(test_case);
  const output = await build_pages(source, root);
  await writeFile(join(output, "obsolete.js"), "old deployment");
  await build_pages(source, root);
  assert.equal(await readFile(join(output, "_worker.js"), "utf8"), await readFile(worker_path, "utf8"));
  assert.equal(await readFile(join(output, "index.html"), "utf8"), "<h1>已验收版本</h1>\n");
  for (const path of ["obsolete.js", "frontend/Draft.vue", "modern/Draft.vue", "Draft.vue", ".private"]) {
    await assert.rejects(readFile(join(output, path)), { code: "ENOENT" });
  }
});

test("only API routes invoke the Function", async (test_case) => {
  const { root, source } = await release_fixture(test_case);
  const output = await build_pages(source, root);
  const routes = JSON.parse(await readFile(join(output, "_routes.json"), "utf8"));
  const matches = (pattern, path) => pattern.endsWith("*") ? path.startsWith(pattern.slice(0, -1)) : path === pattern;
  const invokes = (path) => routes.include.some((rule) => matches(rule, path)) && !routes.exclude.some((rule) => matches(rule, path));
  for (const path of ["/api", "/api/admin", "/api/machines/m/relay"]) assert.ok(invokes(path), path);
  for (const path of ["/", "/index.html", "/app.js", "/modern.css", "/icons/user.svg", "/robots.txt", "/missing", "/apiary", "/r/room"]) assert.equal(invokes(path), false, path);
  assert.deepEqual((await readFile(join(output, "robots.txt"), "utf8")).split(/\r?\n/), ["User-agent: *", "Allow: /", ""]);
  assert.match(await readFile(join(output, "404.html"), "utf8"), /页面不存在/);
});

test("Pages binds D1 directly and has no external Worker service dependency", async () => {
  const config = JSON.parse(await readFile(join(PROJECT_ROOT, "wrangler.jsonc"), "utf8"));
  assert.equal(config.pages_build_output_dir, "./dist/pages");
  assert.equal(config.services, undefined);
  assert.equal(config.main, undefined);
  assert.equal(config.d1_databases.length, 1);
  assert.equal(config.d1_databases[0].binding, "DB");
  assert.ok(config.d1_databases[0].database_id);
  const scripts = JSON.parse(await readFile(join(PROJECT_ROOT, "package.json"), "utf8")).scripts;
  assert.match(scripts.deploy, /npm run build && wrangler pages deploy/);
  assert.equal(scripts["deploy:pages"], "npm run deploy");
});

/** Call /api/admin* or any path with an optional admin session header. */
async function admin_call(f, path, payload, session) {
  const response = await worker.fetch(new Request(`https://discussion.test${path}`, {
    method: payload === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(session ? { 'X-Discussion-Admin': session } : {}) },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  }), f.env);
  return { status: response.status, body: await response.json() };
}

async function admin_fixture(t) {
  const f = await worker_fixture(t);
  f.env.ADMIN_SETUP_KEY = 'setup-key-for-tests';
  const account = { username: '房主', password: 'correct-horse', setup_key: 'setup-key-for-tests' };
  f.register = () => admin_call(f, '/api/admin/register', account);
  f.login = password => admin_call(f, '/api/admin/login', { username: '房主', password });
  return f;
}

test('Worker admin registration needs the setup key and only succeeds once', async t => {
  const f = await admin_fixture(t);
  // The online website keeps no rooms; pages learn to list the paired computer's instead.
  assert.deepEqual((await admin_call(f, '/api/admin')).body, { computer_rooms: true, registered: false, setup_available: true, logged_in: false, profile: null });
  for (const path of ['/api/rooms', '/api/folders', '/api/revisions', '/api/updates']) assert.equal((await admin_call(f, path)).status, 404, path);
  const wrong = await admin_call(f, '/api/admin/register', { username: '房主', password: 'correct-horse', setup_key: 'nope' });
  assert.equal(wrong.status, 403);
  const short = await admin_call(f, '/api/admin/register', { username: '房主', password: 'short', setup_key: 'setup-key-for-tests' });
  assert.equal(short.status, 400);
  const unconfigured = await worker_fixture(t);
  assert.equal((await admin_call(unconfigured, '/api/admin/register', { username: 'a', password: 'correct-horse', setup_key: 'x' })).status, 503);
  const created = await f.register();
  assert.equal(created.status, 201);
  assert.match(created.body.token, /^[0-9a-f]{64}$/);
  assert.equal((await f.register()).status, 409);
  const state = (await admin_call(f, '/api/admin', undefined, created.body.token)).body;
  assert.deepEqual(state, { computer_rooms: true, registered: true, setup_available: false, logged_in: true, profile: { username: '房主', avatar: '' } });
  assert.match(f.sql.prepare('SELECT password_hash FROM site_admin').get().password_hash, /^pbkdf2_sha256\$100000\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
});

test('Worker registers the administrator with the one-time CLI token', async t => {
  const f = await worker_fixture(t);
  const token = 'ab'.repeat(32), hashed = createHash('sha256').update(token).digest('hex');
  assert.equal((await admin_call(f, '/api/admin')).body.setup_available, false);
  f.sql.prepare('INSERT INTO admin_setup (id,token_hash,created_at) VALUES (1,?,0)').run(hashed);
  assert.equal((await admin_call(f, '/api/admin')).body.setup_available, true);
  const account = { username: 'Admin', password: 'Admin123456.' };
  assert.equal((await admin_call(f, '/api/admin/register', { ...account, setup_key: 'cd'.repeat(32) })).status, 403);
  assert.equal((await admin_call(f, '/api/admin/register', { ...account, setup_key: ` ${token} ` })).status, 201);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS count FROM admin_setup').get().count, 0);
  assert.equal((await admin_call(f, '/api/admin/login', account)).status, 200);
});

test('Worker admin login locks for a fixed time after five failures and clears on success', async t => {
  const f = await admin_fixture(t);
  await f.register();
  assert.equal((await f.login('wrong-password')).status, 401);
  assert.equal((await admin_call(f, '/api/admin/login', { username: '陌生人', password: 'correct-horse' })).status, 401);
  for (let attempt = 0; attempt < 3; attempt++) await f.login('wrong-password');
  const row = f.sql.prepare('SELECT failed_attempts, locked_until FROM site_admin').get();
  assert.equal(row.failed_attempts, 0);
  assert.ok(Math.abs(row.locked_until - (Math.floor(Date.now() / 1000) + 300)) <= 5);
  assert.equal((await f.login('correct-horse')).status, 429);
  f.sql.prepare('UPDATE site_admin SET locked_until=0').run();
  await f.login('wrong-password');
  const ok = await f.login('correct-horse');
  assert.equal(ok.status, 200);
  assert.equal(f.sql.prepare('SELECT failed_attempts FROM site_admin').get().failed_attempts, 0);
  assert.equal((await admin_call(f, '/api/admin', undefined, ok.body.token)).body.logged_in, true);
});

test('a page without the local service runs operations on the paired computer end to end', async t => {
  const { machine_link, relay_commands, sync_remote_launches } = await import('../runner/remote_launch.mjs');
  const f = await admin_fixture(t);
  const session = (await f.register()).body.token;
  const home = await mkdtemp(join(tmpdir(), 'codiscuss-relay-page-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  // The computer reaches the same Worker the page uses.
  globalThis.fetch = (url, options) => worker.fetch(new Request(url, options), f.env);
  await admin_call(f, '/api/machines', machine_link(home, 'https://discussion.test'), session);
  await sync_remote_launches(home);
  const [machine] = (await admin_call(f, '/api/machines', undefined, session)).body.machines;

  // The page's own relay code, with request_json going to the Worker under the administrator session.
  const source = await readFile(join(PROJECT_ROOT, 'web', 'app.js'), 'utf8');
  const constants = source.slice(source.indexOf('const RELAY_COMMAND_POLL_MS'), source.indexOf('let local_connection'));
  const start = source.indexOf('function bytes_to_base64(');
  const end = source.indexOf("\n/** Read this browser's submitted requests");
  assert.ok(start >= 0 && end > start, 'relay functions are present');
  const request_json = async (path, payload) => {
    const { status, body } = await admin_call(f, path, payload, session);
    if (status >= 400) throw Object.assign(new Error(body.error), { status });
    return body;
  };
  const relay_command = vm.runInNewContext([`const MODEL_CATALOG_TIMEOUT_MS = 35000;`, constants, source.slice(start, end), 'relay_command'].join('\n'),
    { crypto, TextEncoder, TextDecoder, btoa, atob, setTimeout, Uint8Array, JSON, Date, Object, Error, Promise, request_json, relay_machine: machine,
      state: { remote_rooms: false, admin: {} } });

  const ran = [];
  const run = async request => {
    ran.push(request);
    return request.command === 'api-key' ? { status: 400, body: { error: 'Base URL 无效' } } : { status: 200, body: { member: 'Antigravity' } };
  };
  const page = relay_command('room-member', { room_id: 'room-1', action: 'add', name: 'Antigravity', access_file: 'C:/elsewhere' });
  await Promise.all(await relay_commands(home, { wait: 5, run }));
  assert.deepEqual(await page, { member: 'Antigravity' });
  assert.deepEqual(ran[0].input, { room_id: 'room-1', action: 'add', name: 'Antigravity', site: 'https://discussion.test', entry: 'web' });

  const secret = 'sk-never-on-the-site';
  const failing = relay_command('api-key', { base_url: 'nope', api_key: secret });
  const stored = [];
  for (let tries = 0; !stored.length && tries < 50; tries++) {
    await new Promise(resolve => setTimeout(resolve, 20));
    stored.push(...f.sql.prepare('SELECT request FROM machine_commands').all().map(row => row.request));
  }
  assert.ok(stored.length && !stored.some(text => text.includes(secret)), 'the site holds only ciphertext');
  await Promise.all(await relay_commands(home, { wait: 5, run }));
  await assert.rejects(failing, /Base URL 无效/);
  assert.equal(ran[1].input.api_key, secret);
  await assert.rejects(relay_command('pick-directory', {}), /完整路径/);
});

test('Worker relays encrypted commands only between the administrator and the paired computer', async t => {
  const f = await admin_fixture(t);
  const machine_id = crypto.randomUUID().replaceAll('-', ''), machine_token = 'cd'.repeat(32);
  const machine_call = async (path, payload, token = machine_token) => {
    const response = await worker.fetch(new Request(`https://discussion.test${path}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Machine-Token': token }, body: JSON.stringify(payload) }), f.env);
    return { status: response.status, body: await response.json() };
  };
  const session = (await f.register()).body.token;
  await admin_call(f, '/api/machines', { id: machine_id, name: '工作站', token: machine_token }, session);
  const commands = `/api/machines/${machine_id}/commands`;
  const key = { kty: 'EC', crv: 'P-256', x: 'A'.repeat(43), y: 'B'.repeat(43) };
  const envelope = { key, iv: 'C'.repeat(16), data: 'ZGF0YQ==' }, command = { id: 'command-0000000001', envelope };
  assert.equal((await admin_call(f, commands, command)).status, 401);
  assert.equal((await admin_call(f, commands, command, session)).status, 409, 'a computer without a published key cannot take commands');
  const state = { projects: [], clients: {} };
  assert.equal((await machine_call(`/api/machines/${machine_id}/sync`, { ...state, public_key: { ...key, x: 'short' } })).status, 400);
  await machine_call(`/api/machines/${machine_id}/sync`, { ...state, public_key: key });
  assert.deepEqual((await admin_call(f, '/api/machines', undefined, session)).body.machines[0].public_key, key);
  assert.equal((await admin_call(f, commands, { ...command, envelope: { ...envelope, data: 'not base64!' } }, session)).status, 400);
  assert.deepEqual((await admin_call(f, commands, command, session)).body, { id: 'command-0000000001', status: 'pending' });
  assert.equal((await admin_call(f, commands, command, session)).status, 409);

  const claim = `${commands}/claim`;
  assert.equal((await machine_call(claim, { wait: 0 }, '0'.repeat(64))).status, 401);
  assert.deepEqual((await machine_call(claim, { wait: 0 })).body, { commands: [{ id: 'command-0000000001', envelope }] });
  assert.equal(f.sql.prepare('SELECT request FROM machine_commands').get().request, '{}');
  assert.deepEqual((await machine_call(claim, { wait: 0 })).body, { commands: [] });
  assert.equal((await admin_call(f, `${commands}/command-0000000001`, undefined, session)).body.status, 'claimed');
  const answer = { envelope: { iv: 'D'.repeat(16), data: 'YW5zd2Vy' } };
  assert.equal((await machine_call(`${commands}/command-0000000001`, answer)).body.status, 'done');
  assert.equal((await machine_call(`${commands}/command-0000000001`, answer)).status, 409);
  assert.deepEqual((await admin_call(f, `${commands}/command-0000000001`, undefined, session)).body, { id: 'command-0000000001', status: 'done', response: answer.envelope });
  assert.equal((await admin_call(f, `${commands}/command-0000000001`, undefined, session)).status, 404, 'a response is handed over once');

  await admin_call(f, commands, { ...command, id: 'command-0000000002' }, session);
  f.sql.prepare('UPDATE machine_commands SET created_at=0').run();
  assert.deepEqual((await machine_call(claim, { wait: 0 })).body, { commands: [] }, 'an expired command is never run');
});

/** A Durable Object state with hibernatable sockets, enough to drive the relay without the Cloudflare runtime. */
function relay_context() {
  const sockets = [];
  const ctx = {
    acceptWebSocket: (socket, tags) => { socket.tags = tags; sockets.push(socket); },
    getWebSockets: tag => sockets.filter(socket => socket.tags.includes(tag) && socket.readyState !== 3),
  };
  const socket = () => {
    const sent = [];
    let attachment = null;
    return { sent, readyState: 1, send: text => sent.push(JSON.parse(text)), close() { this.readyState = 3; },
      serializeAttachment: value => { attachment = value; }, deserializeAttachment: () => attachment };
  };
  return { ctx, socket };
}

test('the machine relay hands requests to the computer, answers once, and never retries on its own', async t => {
  const { ctx, socket } = relay_context();
  const relay = new MachineRelay(ctx);
  const device = socket();
  relay.accept(device, 'device');
  assert.deepEqual(device.sent.pop(), { type: 'presence', online: false });
  assert.deepEqual(await relay.relay({ id: 'request-1', envelope: { data: 'x' } }), { id: 'request-1', status: 'offline' });

  const machine = socket();
  relay.accept(machine, 'machine');
  assert.deepEqual(device.sent.pop(), { type: 'presence', online: true });
  const waiting = relay.relay({ id: 'request-2', envelope: { data: 'secret' } });
  assert.deepEqual(machine.sent.pop(), { type: 'request', id: 'request-2', envelope: { data: 'secret' } });
  assert.deepEqual(await relay.relay({ id: 'request-2', envelope: {} }), { id: 'request-2', status: 'duplicate' });
  relay.webSocketMessage(device, JSON.stringify({ type: 'response', id: 'request-2', envelope: { data: 'forged' } }));
  relay.webSocketMessage(machine, JSON.stringify({ type: 'response', id: 'request-2', envelope: { data: 'answer' } }));
  assert.deepEqual(await waiting, { id: 'request-2', status: 'done', response: { data: 'answer' } }, 'only the computer can answer');

  relay.webSocketMessage(machine, JSON.stringify({ type: 'event', rooms: ['room-a'] }));
  assert.deepEqual(device.sent.pop(), { type: 'change', rooms: ['room-a'] });

  const left = relay.relay({ id: 'request-3', envelope: {} });
  machine.close();
  relay.webSocketClose(machine);
  assert.deepEqual(await left, { id: 'request-3', status: 'offline' }, 'a leaving computer fails its requests at once');
  assert.deepEqual(device.sent.pop(), { type: 'presence', online: false });

  const again = socket();
  relay.accept(again, 'machine');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const slow = relay.relay({ id: 'request-4', envelope: {} });
  t.mock.timers.tick(9000);
  assert.deepEqual(await slow, { id: 'request-4', status: 'unknown' }, 'a late answer leaves the outcome unconfirmed');
  relay.webSocketMessage(again, JSON.stringify({ type: 'response', id: 'request-4', envelope: {} }));
  assert.equal(relay.pending.size, 0);
  // A long local operation asks to wait longer, within a bound.
  const long = relay.relay({ id: 'request-5', envelope: {}, wait: 60000 });
  t.mock.timers.tick(59000);
  assert.equal(relay.pending.size, 1, 'a requested longer wait is kept');
  t.mock.timers.tick(1000);
  assert.deepEqual(await long, { id: 'request-5', status: 'unknown' });
  const bounded = relay.relay({ id: 'request-6', envelope: {}, wait: 3600000 });
  t.mock.timers.tick(80000);
  assert.deepEqual(await bounded, { id: 'request-6', status: 'unknown' }, 'no device holds the relay longer than the bound');
});

test('Worker hands relay sockets and requests to the computer relay only after checking who sends them', async t => {
  const f = await admin_fixture(t);
  const machine_id = crypto.randomUUID().replaceAll('-', ''), machine_token = 'cd'.repeat(32);
  const session = (await f.register()).body.token;
  const path = `/api/machines/${machine_id}/relay`;
  const upgrade = credential => worker.fetch(new Request(`https://discussion.test${path}`, {
    headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': ['codiscuss-relay', credential].filter(Boolean).join(', ') } }), f.env);
  assert.equal((await upgrade(`m.${machine_token}`)).status, 404, 'without the relay binding the D1 queue stays in use');

  const seen = [];
  f.env.RELAY = { idFromName: name => name, get: id => ({ fetch: async (input, init) => {
    const request = new Request(input, init);
    seen.push({ id, role: request.headers.get('X-Relay-Role'), body: request.method === 'POST' ? await request.json() : null });
    return request.method === 'POST' ? Response.json({ id: 'relay-request-000001', status: 'unknown' }) : new Response(null, { status: 204 });
  } }) };
  await admin_call(f, '/api/machines', { id: machine_id, name: '工作站', token: machine_token }, session);
  const key = { kty: 'EC', crv: 'P-256', x: 'A'.repeat(43), y: 'B'.repeat(43) };
  const request = { id: 'relay-request-000001', envelope: { key, iv: 'C'.repeat(16), data: 'ZGF0YQ==' } };
  assert.equal((await upgrade(`m.${'ef'.repeat(32)}`)).status, 401, 'a wrong computer token is refused');
  assert.equal((await upgrade(`a.${'ef'.repeat(32)}`)).status, 401, 'a device needs a valid administrator session');
  assert.equal((await upgrade('')).status, 401);
  assert.equal((await admin_call(f, path, request)).status, 401);
  assert.equal((await admin_call(f, path, request, session)).status, 409, 'a computer without a published key cannot take requests');
  assert.equal(seen.length, 0, 'nothing reached the relay before authentication');

  const sync = await worker.fetch(new Request(`https://discussion.test/api/machines/${machine_id}/sync`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Machine-Token': machine_token }, body: JSON.stringify({ projects: [], clients: {}, public_key: key }) }), f.env);
  assert.equal(sync.status, 200);
  assert.equal((await upgrade(`m.${machine_token}`)).status, 204);
  assert.equal((await upgrade(`a.${session}`)).status, 204);
  assert.equal((await admin_call(f, path, { ...request, envelope: { ...request.envelope, data: 'not base64!' } }, session)).status, 400);
  assert.deepEqual((await admin_call(f, path, request, session)).body, { id: 'relay-request-000001', status: 'unknown' });
  assert.deepEqual(seen.map(item => [item.id, item.role]), [[machine_id, 'machine'], [machine_id, 'device'], [machine_id, 'request']]);
  assert.deepEqual(seen[2].body, request);
});

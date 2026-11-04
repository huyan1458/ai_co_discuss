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

/** Call a website path, with optional extra headers; answers whatever status the website gives. */
async function call(f, path, payload, headers = {}) {
  const response = await worker.fetch(new Request(`https://discussion.test${path}`, {
    method: payload === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  }), f.env);
  return { status: response.status, body: await response.json() };
}

/**
 * A website with one computer bound by the one-time setup token and, unless `pair` is false, one device paired at that
 * computer with its passkey. The computer's own requests reach the same Worker.
 */
async function bound_fixture(t, { pair = true } = {}) {
  const { machine_link, sync_remote_launches } = await import('../runner/remote_launch.mjs');
  const { device_command, pairing_passkey_challenge, pairing_proof, start_pairing } = await import('../runner/device_auth.mjs');
  const { software_device, software_passkey } = await import('./passkey_authenticator.mjs');
  const f = await worker_fixture(t);
  f.env.ADMIN_SETUP_KEY = 'setup-key-for-tests';
  f.home = await mkdtemp(join(tmpdir(), 'codiscuss-bound-'));
  t.after(() => rm(f.home, { recursive: true, force: true }));
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = (url, options) => worker.fetch(new Request(url, options), f.env);
  const link = machine_link(f.home, 'https://discussion.test');
  f.machine_id = link.id;
  f.sync = () => sync_remote_launches(f.home);
  assert.equal((await call(f, '/api/machines', { ...link, setup_key: 'setup-key-for-tests' })).status, 200);
  await f.sync();
  if (pair) {
    const device = await software_device(link.id), passkey = software_passkey('discussion.test');
    const { code } = start_pairing(f.home, { site: 'https://discussion.test' });
    const answer = await device_command(f.home, { site: 'https://discussion.test', machine_id: link.id, device_id: null, on_change: f.sync }, 'device-pair',
      { public_key: device.public_key, label: 'iPhone', proof: pairing_proof(code, link.id, device.public_key),
        passkey: passkey.create(pairing_passkey_challenge(code, device.public_key), 'https://discussion.test') });
    assert.equal(answer.status, 200, answer.body.error);
    f.device = device;
  }
  f.signed = async (path, payload, device = f.device) =>
    call(f, path, payload, { 'X-CoDiscuss-Device': await device.credential(payload === undefined ? 'GET' : 'POST', path.split('?')[0]) });
  return f;
}

test('the website has no accounts: a computer binds only with the one-time setup token', async t => {
  const f = await worker_fixture(t);
  // The online website keeps no rooms and no accounts; pages learn to pair with the computer instead.
  assert.deepEqual((await call(f, '/api/admin')).body, { computer_rooms: true, devices: true, registered: false, setup_available: false, profile: null });
  for (const path of ['/api/rooms', '/api/folders', '/api/revisions', '/api/updates']) assert.equal((await call(f, path)).status, 404, path);
  for (const action of ['register', 'login', 'logout', 'password', 'sessions', 'passkey-login']) {
    assert.equal((await call(f, `/api/admin/${action}`, { username: 'a', password: 'correct-horse' })).status, 404, action);
  }
  const link = { id: crypto.randomUUID().replaceAll('-', ''), token: 'cd'.repeat(32), name: '工作站' };
  assert.equal((await call(f, '/api/machines', link)).status, 403, 'binding needs the setup token');
  assert.equal((await call(f, '/api/machines', { ...link, setup_key: 'nope' })).status, 403);
  const token = 'ab'.repeat(32);
  f.sql.prepare('INSERT INTO admin_setup (id,token_hash,created_at) VALUES (1,?,0)').run(createHash('sha256').update(token).digest('hex'));
  assert.equal((await call(f, '/api/admin')).body.setup_available, true);
  assert.equal((await call(f, '/api/machines', { ...link, setup_key: ` ${token} ` })).status, 200);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS count FROM admin_setup').get().count, 0, 'the token is used up');
  assert.equal((await call(f, '/api/admin')).body.registered, true);
  assert.equal((await call(f, '/api/machines', { ...link, token: 'ef'.repeat(32), setup_key: token })).status, 403, 'nobody can rebind with a used token');
});

test('the website accepts only devices the computer signed into its list', async t => {
  const { device_command } = await import('../runner/device_auth.mjs');
  const { software_device } = await import('./passkey_authenticator.mjs');
  const f = await bound_fixture(t);
  const [machine] = (await call(f, '/api/machines')).body.machines;
  assert.ok(machine.public_key && machine.sign_key, 'anyone sees the keys an unpaired device needs to pair');
  const commands = `/api/machines/${f.machine_id}/commands`;
  const key = { kty: 'EC', crv: 'P-256', x: 'A'.repeat(43), y: 'B'.repeat(43) };
  const command = { id: 'command-0000000001', envelope: { key, iv: 'C'.repeat(16), data: 'ZGF0YQ==' } };
  assert.equal((await call(f, commands, command)).status, 401, 'no device credential');
  const stranger = await software_device(f.machine_id);
  assert.equal((await f.signed(commands, command, stranger)).status, 401, 'a device the computer never paired');
  const stale = await f.device.credential('POST', commands, Math.floor(Date.now() / 1000) - 600);
  assert.equal((await call(f, commands, command, { 'X-CoDiscuss-Device': stale })).status, 401, 'an old credential');
  const elsewhere = await f.device.credential('POST', '/api/admin/profile');
  assert.equal((await call(f, commands, command, { 'X-CoDiscuss-Device': elsewhere })).status, 401, 'a credential for another path');
  assert.deepEqual((await f.signed(commands, command)).body, { id: 'command-0000000001', status: 'pending' });
  // The display name is changed only by a paired device.
  assert.equal((await call(f, '/api/admin/profile', { username: '房主' })).status, 401);
  assert.deepEqual((await f.signed('/api/admin/profile', { username: '房主' })).body.profile, { username: '房主', avatar: '' });
  assert.equal((await call(f, '/api/admin')).body.profile, null, 'an unpaired visitor does not see the owner');
  assert.deepEqual((await f.signed('/api/admin')).body.profile, { username: '房主', avatar: '' });
  // A list not signed by the computer's key is refused, so the website cannot add a device of its own.
  const machine_token = (await import('../runner/remote_launch.mjs')).machine_links(f.home).sites['https://discussion.test'].token;
  const forged = await worker.fetch(new Request(`https://discussion.test/api/machines/${f.machine_id}/sync`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Machine-Token': machine_token },
    body: JSON.stringify({ projects: [], clients: {}, sign_key: machine.sign_key, devices: { body: JSON.stringify({ machine: f.machine_id, issued_at: Date.now() + 1, devices: [] }), signature: 'AAAA' } }) }), f.env);
  assert.equal(forged.status, 400);
  // Revoking on the computer sends a new list at once; the device is refused from then on.
  await device_command(f.home, { site: 'https://discussion.test', machine_id: f.machine_id, device_id: f.device.id, on_change: f.sync }, 'device-revoke', { device_id: f.device.id });
  assert.equal((await f.signed(commands, { ...command, id: 'command-0000000002' })).status, 401);
});

test('an unpaired device reaches the computer only through the rate-limited pairing entry', async t => {
  const f = await bound_fixture(t, { pair: false });
  const key = { kty: 'EC', crv: 'P-256', x: 'A'.repeat(43), y: 'B'.repeat(43) };
  const send = index => call(f, `/api/machines/${f.machine_id}/pair`, { id: `pairing-request-${String(index).padStart(4, '0')}`, envelope: { key, iv: 'C'.repeat(16), data: 'ZGF0YQ==' } },
    { 'CF-Connecting-IP': '203.0.113.9' });
  for (let index = 0; index < 10; index++) assert.equal((await send(index)).status, 200, `request ${index}`);
  assert.equal((await send(10)).status, 429, 'too many pairing requests from one address');
  assert.equal((await call(f, `/api/machines/${f.machine_id}/commands`, { id: 'command-0000000009', envelope: { key, iv: 'C'.repeat(16), data: 'ZGF0YQ==' } })).status, 401,
    'other entries still need a paired device');
});

test('a page pairs at the computer with a passkey, then runs operations on it end to end', async t => {
  const { relay_commands } = await import('../runner/remote_launch.mjs');
  const { start_pairing } = await import('../runner/device_auth.mjs');
  const { software_passkey } = await import('./passkey_authenticator.mjs');
  const f = await bound_fixture(t, { pair: false });
  const [machine] = (await call(f, '/api/machines')).body.machines;

  // The page's own relay and pairing code, with its requests going to the Worker as the page sends them.
  const source = await readFile(join(PROJECT_ROOT, 'web', 'app.js'), 'utf8');
  const constants = source.slice(source.indexOf('const RELAY_COMMAND_POLL_MS'), source.indexOf('let local_connection'));
  const start = source.indexOf('function bytes_to_base64(');
  const end = source.indexOf("\n/** Read this browser's submitted requests");
  assert.ok(start >= 0 && end > start, 'relay functions are present');
  const storage = new Map();
  const passkey = software_passkey('discussion.test');
  const state = { remote_rooms: false, admin: { devices: true }, device: { id: '', needs: '', pairing_code: '', pairing_fp: '', prompt: null } };
  let page_code;
  const request_json = async (path, payload) => {
    const credential = await page_code.device_credential(payload === undefined ? 'GET' : 'POST', path.split('?')[0]);
    const { status, body } = await call(f, path, payload, credential ? { 'X-CoDiscuss-Device': credential } : {});
    if (status >= 400) throw Object.assign(new Error(body.error), { status });
    return body;
  };
  page_code = vm.runInNewContext([`const MODEL_CATALOG_TIMEOUT_MS = 35000;`, constants, source.slice(start, end), '({ relay_command, pair_this_device, device_credential })'].join('\n'),
    { crypto, TextEncoder, TextDecoder, btoa, atob, setTimeout, Uint8Array, JSON, Date, Object, Error, Promise, Math, request_json, relay_machine: machine,
      fetch: (url, options) => worker.fetch(new Request(new URL(url, 'https://discussion.test'), options), f.env), URL,
      localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key) },
      location: { hostname: 'discussion.test' },
      navigator: { userAgent: 'Mozilla/5.0 (iPhone) Safari/605.1', credentials: { create: async ({ publicKey }) => {
        const made = passkey.create(Buffer.from(publicKey.challenge).toString('base64url'), 'https://discussion.test');
        return { rawId: Buffer.from(made.id, 'base64url'), response: { clientDataJSON: Buffer.from(made.client_data_json, 'base64url'),
          attestationObject: Buffer.from(made.attestation_object, 'base64url') } };
      } } },
      publish_view: () => {}, notify: () => {}, load_admin_state: async () => {}, load_launch_settings: async () => {}, computer_rooms_only: () => false, connect_computer_rooms: () => {}, state });
  const { relay_command } = page_code;

  // Before pairing, the website refuses the page; pairing runs on the user's tap and creates the passkey in the same step.
  await assert.rejects(relay_command('settings'), /配对/);
  const pairing = page_code.pair_this_device(start_pairing(f.home, { site: 'https://discussion.test' }).code);
  for (let tries = 0; !state.device.prompt && tries < 50; tries++) await new Promise(resolve => setTimeout(resolve, 10));
  const confirmed = state.device.prompt.run();
  for (let tries = 0; !storage.has('codiscuss-paired') && tries < 100; tries++) {
    await Promise.all(await relay_commands(f.home, { wait: 0, run: async () => ({ status: 200, body: {} }) }));
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  await confirmed;
  await pairing;
  assert.equal(JSON.parse(storage.get('codiscuss-paired')).machine_id, machine.id);

  const ran = [];
  const run = async request => {
    ran.push(request);
    return request.command === 'api-key' ? { status: 400, body: { error: 'Base URL 无效' } } : { status: 200, body: { member: 'Antigravity' } };
  };
  const page = relay_command('room-member', { room_id: 'room-1', action: 'add', name: 'Antigravity', access_file: 'C:/elsewhere' });
  for (let tries = 0; !ran.length && tries < 50; tries++) {
    await Promise.all(await relay_commands(f.home, { wait: 0, run }));
    await new Promise(resolve => setTimeout(resolve, 20));
  }
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
  await Promise.all(await relay_commands(f.home, { wait: 5, run }));
  await assert.rejects(failing, /Base URL 无效/);
  assert.equal(ran[1].input.api_key, secret);
  await assert.rejects(relay_command('pick-directory', {}), /完整路径/);
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
  const f = await bound_fixture(t);
  const machine_token = (await import('../runner/remote_launch.mjs')).machine_links(f.home).sites['https://discussion.test'].token;
  const path = `/api/machines/${f.machine_id}/relay`;
  const upgrade = credential => worker.fetch(new Request(`https://discussion.test${path}`, {
    headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': ['codiscuss-relay', credential].filter(Boolean).join(', ') } }), f.env);
  assert.equal((await upgrade(`m.${machine_token}`)).status, 404, 'without the relay binding the D1 queue stays in use');

  const seen = [];
  f.env.RELAY = { idFromName: name => name, get: id => ({ fetch: async (input, init) => {
    const request = new Request(input, init);
    seen.push({ id, role: request.headers.get('X-Relay-Role'), body: request.method === 'POST' ? await request.json() : null });
    return request.method === 'POST' ? Response.json({ id: 'relay-request-000001', status: 'unknown' }) : new Response(null, { status: 204 });
  } }) };
  const key = { kty: 'EC', crv: 'P-256', x: 'A'.repeat(43), y: 'B'.repeat(43) };
  const request = { id: 'relay-request-000001', envelope: { key, iv: 'C'.repeat(16), data: 'ZGF0YQ==' } };
  assert.equal((await upgrade(`m.${'ef'.repeat(32)}`)).status, 401, 'a wrong computer token is refused');
  assert.equal((await upgrade(`a.${'ef'.repeat(32)}`)).status, 401, 'an old login token means nothing now');
  assert.equal((await upgrade(`d.${await f.device.credential('GET', '/api/machines/other/relay')}`)).status, 401, 'a credential for another path');
  assert.equal((await upgrade('')).status, 401);
  assert.equal((await call(f, path, request)).status, 401);
  assert.equal(seen.length, 0, 'nothing reached the relay before authentication');

  assert.equal((await upgrade(`m.${machine_token}`)).status, 204);
  assert.equal((await upgrade(`d.${await f.device.credential('GET', path)}`)).status, 204);
  assert.equal((await f.signed(path, { ...request, envelope: { ...request.envelope, data: 'not base64!' } })).status, 400);
  assert.deepEqual((await f.signed(path, request)).body, { id: 'relay-request-000001', status: 'unknown' });
  assert.deepEqual(seen.map(item => [item.id, item.role]), [[f.machine_id, 'machine'], [f.machine_id, 'device'], [f.machine_id, 'request']]);
  assert.deepEqual(seen[2].body, request);
});

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { add_account, claim_entry, claim_path, create_gateway, entry_status, read_accounts, remove_account, reset_password, save_entry_settings, set_account_disabled,
  start_entry, stop_entry } from '../gateway/gateway.mjs';

function listen(server) {
  return new Promise(done => server.listen(0, '127.0.0.1', () => done(server.address().port)));
}

/** Two accounts, each with a stand-in instance that reports which instance answered and the headers it received. */
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'codiscuss-gateway-')), data = join(root, '.codiscuss');
  const servers = [];
  t.after(() => { servers.forEach(server => server.close()); rmSync(root, { recursive: true, force: true }); });
  const instance = async label => {
    const server = http.createServer((request, response) => {
      response.setHeader('Content-Type', 'application/json');
      // Whatever answers on an instance's port may try to plant a cookie; the entry must not pass it on.
      response.setHeader('Set-Cookie', 'planted=1; Domain=example.com; Path=/');
      response.end(JSON.stringify({ label, url: request.url, headers: request.headers }));
    });
    servers.push(server);
    return listen(server);
  };
  const alice = add_account(data, 'alice', await instance('alice'));
  const bob = add_account(data, 'bob', await instance('bob'));
  let clock = 1_000_000;
  const gateway = create_gateway({ data, now: () => clock });
  servers.push(gateway);
  const origin = `http://127.0.0.1:${await listen(gateway)}`;
  const login = async (name, password) => {
    const response = await fetch(`${origin}/_entry/login`, { method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ name, password }) });
    return { status: response.status, cookie: (response.headers.get('set-cookie') || '').split(';')[0] };
  };
  // A second entry on the same account list, as after a restart.
  const restart = async () => { const again = create_gateway({ data, now: () => clock }); servers.push(again); return `http://127.0.0.1:${await listen(again)}`; };
  return { data, origin, alice, bob, login, restart, advance: ms => { clock += ms; } };
}

test('nothing reaches an instance without signing in', async t => {
  const f = await fixture(t);
  const page = await fetch(`${f.origin}/`, { redirect: 'manual', headers: { Accept: 'text/html' } });
  assert.equal(page.status, 302);
  assert.equal(page.headers.get('location'), '/_entry/login');
  const api = await fetch(`${f.origin}/api/local/settings`, { headers: { 'X-CoDiscuss-Local': '1' } });
  assert.equal(api.status, 401);
  assert.equal((await f.login('alice', 'wrong-password')).status, 401);
  assert.equal((await f.login('nobody', f.alice.password)).status, 401);
  assert.equal((await fetch(`${f.origin}/_entry/session`)).status, 401);
  const forged = await fetch(`${f.origin}/api/rooms`, { headers: { Cookie: 'codiscuss_entry=' + 'a'.repeat(64) } });
  assert.equal(forged.status, 401);
});

test('a signed-in person whose instance is down gets a plain page, and the site\'s own requests an error', async t => {
  const f = await fixture(t);
  const idle = http.createServer();
  const port = await listen(idle);
  await new Promise(done => idle.close(done));
  const accounts = read_accounts(f.data);
  writeFileSync(join(f.data, 'gateway-accounts.json'), JSON.stringify({ ...accounts, alice: { ...accounts.alice, port } }));
  const { cookie } = await f.login('alice', f.alice.password);
  assert.equal((await fetch(`${f.origin}/_entry/session`, { headers: { Cookie: cookie } })).status, 200, 'the site can tell it was opened through the entry');
  const page = await fetch(`${f.origin}/`, { headers: { Cookie: cookie, Accept: 'text/html' } });
  assert.equal(page.status, 502);
  assert.match(await page.text(), /暂时打不开/);
  const api = await fetch(`${f.origin}/api/rooms`, { headers: { Cookie: cookie } });
  assert.equal(api.status, 502);
  assert.ok((await api.json()).error);
});

test('a signed-in account reaches only its own instance, presented as that instance\'s loopback page', async t => {
  const f = await fixture(t);
  const alice = await f.login('alice', f.alice.password), bob = await f.login('bob', f.bob.password);
  assert.equal(alice.status, 303);
  const seen = await (await fetch(`${f.origin}/api/local/settings?x=1`, { method: 'POST', body: '{}',
    headers: { Cookie: `${alice.cookie}; codiscuss_panel=owner-session`, Origin: f.origin, 'Content-Type': 'application/json' } })).json();
  assert.equal(seen.label, 'alice');
  assert.equal(seen.url, '/api/local/settings?x=1');
  assert.equal(seen.headers.host, `127.0.0.1:${f.alice.port}`);
  assert.equal(seen.headers.origin, `http://127.0.0.1:${f.alice.port}`);
  // Cookies are kept per host, not per port: the panel's would otherwise reach the account's own process.
  assert.equal(seen.headers.cookie, undefined, 'no cookie of this computer reaches an instance');
  const reply = await fetch(`${f.origin}/api/rooms`, { headers: { Cookie: bob.cookie } });
  assert.equal(reply.headers.get('set-cookie'), null, 'an instance cannot set cookies through the entry');
  assert.equal((await reply.json()).label, 'bob');
});

test('another website cannot use a signed-in browser', async t => {
  const f = await fixture(t);
  const { cookie } = await f.login('alice', f.alice.password);
  const response = await fetch(`${f.origin}/api/local/launch`, { method: 'POST', body: '{}',
    headers: { Cookie: cookie, Origin: 'https://attacker.example', 'Content-Type': 'application/json' } });
  assert.equal(response.status, 403);
});

test('sessions end with the account or on expiry, a reset replaces the password, and repeated failures lock the account', async t => {
  const f = await fixture(t);
  const { cookie } = await f.login('alice', f.alice.password);
  remove_account(f.data, 'alice');
  assert.equal((await fetch(`${f.origin}/api/rooms`, { headers: { Cookie: cookie } })).status, 401);
  const bob = await f.login('bob', f.bob.password);
  f.advance(31 * 24 * 3600 * 1000);
  assert.equal((await fetch(`${f.origin}/api/rooms`, { headers: { Cookie: bob.cookie } })).status, 401);
  const password = reset_password(f.data, 'bob');
  assert.equal((await f.login('bob', f.bob.password)).status, 401);
  for (let attempt = 0; attempt < 4; attempt++) assert.equal((await f.login('bob', 'wrong')).status, 401);
  assert.equal((await f.login('bob', password)).status, 429);
  f.advance(11 * 60 * 1000);
  assert.equal((await f.login('bob', password)).status, 303);
});

test('accounts get distinct ports and stored passwords are hashed', async t => {
  const f = await fixture(t);
  const carol = add_account(f.data, 'carol');
  const accounts = read_accounts(f.data);
  assert.equal(new Set(Object.values(accounts).map(account => account.port)).size, 3);
  assert.ok(!JSON.stringify(accounts).includes(carol.password));
  assert.throws(() => add_account(f.data, 'carol'), /账号已存在/);
  assert.throws(() => add_account(f.data, 'dave', f.alice.port), /已分配/);
  assert.throws(() => add_account(f.data, '../evil'), /账号须为/);
});

test('the administrator is not an entry account, and an account never takes over an existing folder', async t => {
  const f = await fixture(t);
  for (const name of ['admin', 'workspace']) assert.throws(() => add_account(f.data, name), /管理员/);
  mkdirSync(`${f.data}-recovery`);
  assert.throws(() => add_account(f.data, 'recovery'), /目录已存在/);
  assert.equal((await f.login('admin', 'anything')).status, 401);
});

test('a new account gets a service directory, a projects folder and a draft space, taking only program locations from the administrator', async t => {
  const f = await fixture(t);
  mkdirSync(f.data, { recursive: true });
  writeFileSync(join(f.data, 'launch-settings.json'), JSON.stringify({ participants: {
    Claude: { adapter: 'claude', executable: 'C:/tools/claude.exe', session_id: 'private-session', cwd: 'C:/private', system_prompt: 'private' } } }));
  writeFileSync(join(f.data, 'local-settings.json'), JSON.stringify({ port: 8765, python: 'C:/python/python.exe' }));
  const carol = add_account(f.data, 'carol');
  const home = `${f.data}-carol`;
  assert.deepEqual(readdirSync(home).sort(), ['projects', 'service', 'workspace']);
  assert.deepEqual(JSON.parse(readFileSync(join(home, 'service', 'local-settings.json'), 'utf8')),
    { port: carol.port, python: 'C:/python/python.exe', workspace: join(home, 'workspace'), projects_root: join(home, 'projects') });
  assert.deepEqual(JSON.parse(readFileSync(join(home, 'service', 'launch-settings.json'), 'utf8')),
    { participants: { Claude: { adapter: 'claude', executable: 'C:/tools/claude.exe' } } });
});

test('resetting the password or disabling the account ends its sessions at once; a restart keeps the rest', async t => {
  const f = await fixture(t);
  const reach = (origin, cookie) => fetch(`${origin}/api/rooms`, { headers: { Cookie: cookie } }).then(response => response.status);
  const alice = await f.login('alice', f.alice.password), bob = await f.login('bob', f.bob.password);
  const restarted = await f.restart();
  assert.equal(await reach(restarted, alice.cookie), 200, 'a restarted entry keeps signed-in sessions');
  const stored = readFileSync(join(f.data, 'gateway-sessions.json'), 'utf8');
  assert.ok(!stored.includes(alice.cookie.split('=')[1]), 'only token hashes are stored');
  const password = reset_password(f.data, 'alice');
  assert.equal(await reach(f.origin, alice.cookie), 401, "the old password's session ends");
  assert.equal(await reach(restarted, alice.cookie), 401);
  assert.equal((await f.login('alice', password)).status, 303);
  set_account_disabled(f.data, 'bob', true);
  assert.equal(await reach(f.origin, bob.cookie), 401, "a disabled account's session ends");
  assert.equal((await f.login('bob', f.bob.password)).status, 403);
  set_account_disabled(f.data, 'bob', false);
  assert.equal((await f.login('bob', f.bob.password)).status, 303, 'enabling restores sign-in with the same password');
  assert.equal(read_accounts(f.data).bob.disabled, undefined);
});

test('enabling a disabled account never revives a session signed in before, even one unused meanwhile', async t => {
  const f = await fixture(t);
  const alice = await f.login('alice', f.alice.password);
  set_account_disabled(f.data, 'alice', true);
  set_account_disabled(f.data, 'alice', false);
  assert.equal((await fetch(`${f.origin}/api/rooms`, { headers: { Cookie: alice.cookie } })).status, 401);
  const restarted = await f.restart();
  assert.equal((await fetch(`${restarted}/api/rooms`, { headers: { Cookie: alice.cookie } })).status, 401);
});

test('a malformed session file signs everyone out instead of stopping the entry, and one directory has one entry at a time', async t => {
  const f = await fixture(t);
  const alice = await f.login('alice', f.alice.password);
  for (const content of ['null', '[]', '{"' + 'a'.repeat(64) + '": {"name": "alice"}}']) {
    writeFileSync(join(f.data, 'gateway-sessions.json'), content);
    const restarted = await f.restart();
    assert.equal((await fetch(`${restarted}/api/rooms`, { headers: { Cookie: alice.cookie } })).status, 401, content);
  }
  const held = await claim_entry(f.data);
  await assert.rejects(claim_entry(f.data), /入口已在运行/);
  held.close();
  (await claim_entry(f.data)).close();
});

/** Start several separate processes that claim the same directory at once and hold it; count how many succeed. */
async function race_claims(data, count) {
  const gateway = pathToFileURL(join(import.meta.dirname, '..', 'gateway', 'gateway.mjs')).href;
  const script = `import { claim_entry } from ${JSON.stringify(gateway)};
    try { await claim_entry(process.argv[1]); console.log('claimed'); } catch { console.log('refused'); }
    setTimeout(() => process.exit(), 1500);`;
  const results = await Promise.all(Array.from({ length: count }, () => new Promise(done => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, data], { stdio: ['ignore', 'pipe', 'inherit'] });
    let output = ''; child.stdout.on('data', chunk => { output += chunk; });
    child.on('exit', () => done(output.trim()));
  })));
  return results.filter(result => result === 'claimed').length;
}

test('of several entries starting at once on one directory exactly one claims it, and the claim ends with its process', async t => {
  const root = mkdtempSync(join(tmpdir(), 'codiscuss-claim-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(await race_claims(join(root, 'data'), 6), 1);
  // Every racer has exited, including the holder, which never released explicitly: the directory is free again.
  (await claim_entry(join(root, 'data'))).close();
});

test('a junction or link to the same directory is the same claim', async t => {
  const root = mkdtempSync(join(tmpdir(), 'codiscuss-claim-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'owner'));
  symlinkSync(join(root, 'owner'), join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  const held = await claim_entry(join(root, 'owner'));
  await assert.rejects(claim_entry(join(root, 'alias')), /入口已在运行/);
  held.close();
});

test('an entry that fails to start after claiming its directory exits and frees it', async t => {
  const root = mkdtempSync(join(tmpdir(), 'codiscuss-claim-'));
  const busy = http.createServer();
  t.after(() => { busy.close(); rmSync(root, { recursive: true, force: true }); });
  const port = await listen(busy);
  const script = join(import.meta.dirname, '..', 'gateway', 'gateway.mjs');
  const child = spawn(process.execPath, [script, 'serve', '--port', String(port), '--data', join(root, 'data')], { stdio: 'ignore' });
  const timer = setTimeout(() => child.kill(), 10000);
  const [code] = await new Promise(done => child.on('exit', (...args) => done(args)));
  clearTimeout(timer);
  assert.equal(code, 1, 'the failed entry exits on its own');
  (await claim_entry(join(root, 'data'))).close();
});

/** A loopback port nothing listens on right now. */
async function free_port() {
  const spare = http.createServer();
  const port = await listen(spare);
  await new Promise(done => spare.close(done));
  return port;
}

test('the entry is stopped only through its own claim: an unrelated process or server is never taken for it, and a later entry stays controllable', async t => {
  const root = mkdtempSync(join(tmpdir(), 'codiscuss-entry-')), data = join(root, 'data');
  const bystander = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const impostor = http.createServer((request, response) => response.end('ok'));
  t.after(async () => { await stop_entry(data).catch(() => {}); bystander.kill(); impostor.close(); rmSync(root, { recursive: true, force: true }); });
  const port = await free_port();
  save_entry_settings(data, { port });
  // Something else answering on the entry's port is not the entry, and stopping with no entry running signals nothing.
  const other = await listen(impostor);
  save_entry_settings(data, { port: other });
  assert.equal((await entry_status(data)).running, false);
  await stop_entry(data);
  assert.equal(bystander.exitCode, null, 'an unrelated process is left running');
  save_entry_settings(data, { port });
  const first = await start_entry(data);
  assert.equal(first.port, port);
  await stop_entry(data);
  assert.equal((await entry_status(data)).claimed, false);
  const second = await start_entry(data);
  assert.notEqual(second.pid, first.pid);
  assert.equal((await fetch(`http://127.0.0.1:${port}/_entry/login`)).status, 200);
  await stop_entry(data);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/_entry/login`));
  assert.equal(bystander.exitCode, null);
});

test('an entry that cannot record its control key never starts serving and frees its claim', async t => {
  const root = mkdtempSync(join(tmpdir(), 'codiscuss-entry-')), data = join(root, 'data');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(data, 'gateway-control.json'), { recursive: true });
  const port = await free_port();
  const script = join(import.meta.dirname, '..', 'gateway', 'gateway.mjs');
  const child = spawn(process.execPath, [script, 'serve', '--port', String(port), '--data', data], { stdio: 'ignore' });
  const timer = setTimeout(() => child.kill(), 10000);
  const [code] = await new Promise(done => child.on('exit', (...args) => done(args)));
  clearTimeout(timer);
  assert.equal(code, 1);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/_entry/login`));
  (await claim_entry(data)).close();
});

/** Send one raw line on this directory's claim and wait for the connection to close. */
function send_control(data, line) {
  return new Promise(done => {
    const socket = net.connect(claim_path(data));
    socket.on('connect', () => socket.write(`${line}\n`));
    socket.on('error', () => done());
    socket.on('close', () => done());
    socket.resume();
  });
}

test('malformed control requests are refused without ending the entry, which still serves, answers and stops', async t => {
  const root = mkdtempSync(join(tmpdir(), 'codiscuss-entry-')), data = join(root, 'data');
  t.after(async () => { await stop_entry(data).catch(() => {}); rmSync(root, { recursive: true, force: true }); });
  const port = await free_port();
  save_entry_settings(data, { port });
  const started = await start_entry(data);
  const wrong_key = JSON.stringify({ key: 'a'.repeat(64), command: 'stop' });
  for (const line of ['{"key":{"toString":null},"command":"status"}', '{"key":[1],"command":"stop"}', 'null', '[]', '"text"', 'not json', wrong_key]) {
    await send_control(data, line);
  }
  assert.equal((await fetch(`http://127.0.0.1:${port}/_entry/login`)).status, 200);
  const status = await entry_status(data);
  assert.deepEqual([status.running, status.pid], [true, started.pid]);
  await stop_entry(data);
  assert.equal((await entry_status(data)).claimed, false);
});

/** A real Python site protected by `key`, on a free loopback port; resolves to its port. */
async function protected_site(t, root, key, extra_env = {}) {
  const key_file = join(root, 'entry-key.json');
  writeFileSync(key_file, JSON.stringify({ key }));
  const script = "import sys; from backend.server import DiscussionServer,init_database; init_database(sys.argv[1],seed=False); server=DiscussionServer(('127.0.0.1',0),sys.argv[1]); print(server.server_port,flush=True); server.serve_forever()";
  const child = spawn(process.platform === 'win32' ? 'python' : 'python3', ['-u', '-c', script, join(root, 'site.sqlite3')],
    { cwd: join(import.meta.dirname, '..'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DISCUSS_ENTRY_KEY_FILE: key_file, ...extra_env } });
  const closed = new Promise(done => child.once('close', done));
  t.after(async () => { child.kill(); await closed; });
  return new Promise((done, fail) => {
    child.stdout.once('data', chunk => done(Number(String(chunk).trim())));
    child.once('error', fail);
  });
}

test('a protected instance is reached only through a connection on which it proved its key, and an impostor gets nothing', async t => {
  const f = await fixture(t);
  const key = 'a1'.repeat(32);
  const port = await protected_site(t, join(f.data, '..'), key);
  const accounts = read_accounts(f.data);
  writeFileSync(join(f.data, 'gateway-accounts.json'), JSON.stringify({ ...accounts, alice: { ...accounts.alice, port, protected: true } }));
  writeFileSync(join(f.data, 'gateway-instance-keys.json'), JSON.stringify({ alice: key }));
  const { cookie } = await f.login('alice', f.alice.password);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/rooms`)).status, 403, 'the instance refuses a direct request');
  const through = await fetch(`${f.origin}/api/rooms`, { headers: { Cookie: cookie, 'X-CoDiscuss-Entry': 'forged' } });
  assert.equal(through.status, 200, 'the entry proves itself and the instance serves it');
  // The administrator's copy of the key is wrong: the instance's proof does not check out, nothing is sent.
  writeFileSync(join(f.data, 'gateway-instance-keys.json'), JSON.stringify({ alice: 'b2'.repeat(32) }));
  assert.equal((await fetch(`${f.origin}/api/rooms`, { headers: { Cookie: cookie } })).status, 502);
  // Something else on the port: it sees a hello and no part of the request.
  writeFileSync(join(f.data, 'gateway-instance-keys.json'), JSON.stringify({ alice: key }));
  const seen = [];
  const impostor = net.createServer(socket => socket.on('data', chunk => { seen.push(String(chunk)); socket.end('HTTP/1.1 204 No Content\r\nX-CoDiscuss-Proof: 00\r\nX-CoDiscuss-Nonce: ' + 'c'.repeat(32) + '\r\n\r\n'); }));
  const impostor_port = await listen(impostor);
  t.after(() => impostor.close());
  writeFileSync(join(f.data, 'gateway-accounts.json'), JSON.stringify({ ...accounts, alice: { ...accounts.alice, port: impostor_port, protected: true } }));
  const post = () => fetch(`${f.origin}/api/rooms/secret-room/messages`, { method: 'POST', body: '{"text":"客户的正文"}',
    headers: { Cookie: cookie, Origin: f.origin, 'Content-Type': 'application/json', 'X-Discussion-Token': 'room-token-secret' } });
  assert.equal((await post()).status, 502);
  assert.equal(seen.length, 1);
  assert.match(seen[0], /^GET \/_instance\/hello /);
  // A protected account whose key is broken, malformed, missing or unreadable is not forwarded as if unprotected.
  const keys = join(f.data, 'gateway-instance-keys.json');
  for (const [label, damage] of [['broken JSON', () => writeFileSync(keys, '{broken')], ['malformed key', () => writeFileSync(keys, JSON.stringify({ alice: 'xyz' }))],
    ['no entry for the account', () => writeFileSync(keys, JSON.stringify({ bob: key }))], ['no key file', () => rmSync(keys, { force: true })]]) {
    damage();
    assert.equal((await post()).status, 502, label);
  }
  assert.equal(seen.length, 1, 'the impostor got nothing more than the first hello');
  assert.doesNotMatch(seen.join(''), /客户的正文|secret-room|room-token-secret|codiscuss_entry/);
});

test('when the instance proves its key and then drops the connection, the request is not sent on another one', async t => {
  const f = await fixture(t);
  const key = 'd4'.repeat(32);
  let connections = 0;
  const { entry_proof } = await import('../runner/entry_client.mjs');
  const flaky = net.createServer(socket => {
    connections += 1;
    socket.once('data', chunk => {
      const nonce = /X-CoDiscuss-Nonce: ([0-9a-f]{32})/.exec(String(chunk))?.[1] || '';
      socket.write(`HTTP/1.1 204 No Content\r\nX-CoDiscuss-Proof: ${entry_proof(key, 'instance', nonce)}\r\nX-CoDiscuss-Nonce: ${'e'.repeat(32)}\r\nContent-Length: 0\r\n\r\n`);
      setTimeout(() => socket.destroy(), 20);
    });
  });
  const port = await listen(flaky);
  t.after(() => flaky.close());
  const accounts = read_accounts(f.data);
  writeFileSync(join(f.data, 'gateway-accounts.json'), JSON.stringify({ ...accounts, alice: { ...accounts.alice, port, protected: true } }));
  writeFileSync(join(f.data, 'gateway-instance-keys.json'), JSON.stringify({ alice: key }));
  const { cookie } = await f.login('alice', f.alice.password);
  await new Promise(done => setTimeout(done, 50));
  const reply = await fetch(`${f.origin}/api/rooms`, { headers: { Cookie: cookie } });
  assert.equal(reply.status, 502, 'the upstream never answered the request');
  await new Promise(done => setTimeout(done, 100));
  assert.equal(connections, 1, 'no second, unverified connection is opened');
});

test('a protected service reaches its own website only through the handshake, and stops when its key cannot be read', async t => {
  const root = mkdtempSync(join(tmpdir(), 'codiscuss-site-fetch-'));
  const key = 'f6'.repeat(32);
  const port = await protected_site(t, root, key);
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10 }));
  const { site_fetch } = await import('../runner/entry_client.mjs');
  const previous = process.env.DISCUSS_ENTRY_KEY_FILE;
  process.env.DISCUSS_ENTRY_KEY_FILE = join(root, 'entry-key.json');
  t.after(() => { if (previous === undefined) delete process.env.DISCUSS_ENTRY_KEY_FILE; else process.env.DISCUSS_ENTRY_KEY_FILE = previous; });
  const site = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(`${site}/api/rooms`)).status, 403, 'a plain request is refused');
  const listed = await site_fetch(`${site}/api/rooms`);
  assert.equal(listed.status, 200);
  assert.ok(Array.isArray((await listed.json()).rooms));
  const created = await site_fetch(`${site}/api/rooms`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Discussion-Token': 'c'.repeat(32) },
    body: JSON.stringify({ title: '受保护的房间', goal: '核对握手', mode: 'free', members: [], submission_id: 'site-fetch-1' }) });
  assert.equal(created.status, 201, await created.clone().text());
  const controller = new AbortController();
  const stream = await site_fetch(`${site}/api/updates`, { signal: controller.signal, headers: { accept: 'text/event-stream' } });
  assert.equal(stream.status, 200);
  const first = await stream.body.getReader().read();
  assert.match(Buffer.from(first.value).toString(), /event: ready/);
  controller.abort();
  // Protection configured but the key file broken: the request is not sent at all.
  writeFileSync(join(root, 'entry-key.json'), '{broken');
  await assert.rejects(site_fetch(`${site}/api/rooms`), /读不到它的密钥/);
});

test('room reads, uploads and an API member\'s room tools go through the handshake by default, and a stop applies while it waits', async t => {
  const root = mkdtempSync(join(tmpdir(), 'codiscuss-default-transport-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const key = '9a'.repeat(32), key_file = join(root, 'entry-key.json');
  writeFileSync(key_file, JSON.stringify({ key }));
  const previous = process.env.DISCUSS_ENTRY_KEY_FILE;
  process.env.DISCUSS_ENTRY_KEY_FILE = key_file;
  t.after(() => { if (previous === undefined) delete process.env.DISCUSS_ENTRY_KEY_FILE; else process.env.DISCUSS_ENTRY_KEY_FILE = previous; });
  // Something that is not the instance holds the port: it records what reaches it and never proves the key.
  const seen = [];
  const impostor = net.createServer(socket => socket.on('data', chunk => { seen.push(String(chunk)); socket.end('HTTP/1.1 204 No Content\r\nX-CoDiscuss-Proof: 00\r\n\r\n'); }));
  const port = await listen(impostor);
  t.after(() => impostor.close());
  const home = join(root, 'service');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'local-settings.json'), JSON.stringify({ port }));
  const { room_api, room_upload } = await import('../runner/relay_channel.mjs');
  const { execute_tool } = await import('../runner/adapters/api.mjs');
  const site = `http://127.0.0.1:${port}`;
  const attempts = [
    () => room_api(home, 'https://paired.example', { method: 'POST', path: '/api/rooms/secret-room/messages', body: { text: '客户的正文' }, token: 'room-token-secret' }),
    () => room_upload(home, 'https://paired.example', { id: 'upload-0000000000000001', path: '/api/rooms/secret-room/attachments', index: 0, total: 1,
      size: Buffer.byteLength('附件内容'), data: Buffer.from('附件内容').toString('base64') }),
    () => execute_tool({ site, room: 'secret-room', token: 'room-token-secret', signal: new AbortController().signal, role: 'host', goal: { objective: 'x' } },
      { name: 'read_goal', arguments: '{}' }, [{ name: 'read_goal' }]),
  ];
  for (const attempt of attempts) await assert.rejects(attempt());
  assert.equal(seen.length, attempts.length, 'each call reached the handshake');
  // With the key file broken, nothing is even attempted.
  writeFileSync(key_file, '{broken');
  for (const attempt of attempts) await assert.rejects(attempt());
  assert.equal(seen.length, attempts.length, 'nothing more reached the port');
  assert.ok(seen.every(chunk => chunk.startsWith('GET /_instance/hello ')), 'the impostor only ever saw hellos');
  assert.doesNotMatch(seen.join(''), /secret-room|room-token-secret|客户的正文|附件内容/);
  // A caller's timeout ends a handshake that is not being answered, instead of waiting out the handshake's own limit.
  writeFileSync(key_file, JSON.stringify({ key }));
  const silent = net.createServer(() => {});
  const silent_port = await listen(silent);
  t.after(() => silent.close());
  const { site_fetch } = await import('../runner/entry_client.mjs');
  const started = Date.now();
  await assert.rejects(site_fetch(`http://127.0.0.1:${silent_port}/api/rooms`, { signal: AbortSignal.timeout(50) }));
  assert.ok(Date.now() - started < 2000, `stopped after ${Date.now() - started} ms`);
});

test('a paired device reads, writes and uploads to a protected instance through the relay with its bridge credential', async t => {
  const root = mkdtempSync(join(tmpdir(), 'codiscuss-relay-protected-'));
  const home = join(root, 'service');
  mkdirSync(home, { recursive: true });
  const key = '7b'.repeat(32);
  const port = await protected_site(t, root, key, { DISCUSS_SERVICE_HOME: home });
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10 }));
  const previous = process.env.DISCUSS_ENTRY_KEY_FILE;
  process.env.DISCUSS_ENTRY_KEY_FILE = join(root, 'entry-key.json');
  t.after(() => { if (previous === undefined) delete process.env.DISCUSS_ENTRY_KEY_FILE; else process.env.DISCUSS_ENTRY_KEY_FILE = previous; });
  writeFileSync(join(home, 'local-settings.json'), JSON.stringify({ port }));
  const { save_machine_links } = await import('../runner/remote_launch.mjs');
  const { room_api, room_upload } = await import('../runner/relay_channel.mjs');
  const { site_fetch } = await import('../runner/entry_client.mjs');
  const paired = 'https://paired.example';
  save_machine_links(home, { sites: { [paired]: { id: 'machine-1' } } });
  const created = await site_fetch(`http://127.0.0.1:${port}/api/rooms`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Discussion-Token': 'd'.repeat(32) },
    body: JSON.stringify({ title: '中转房间', goal: '核对中转', mode: 'free', members: [], submission_id: 'relay-protected-1' }) });
  const room = await created.json();
  assert.equal(created.status, 201, JSON.stringify(room));
  const listed = await room_api(home, paired, { method: 'GET', path: '/api/rooms' });
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.ok(listed.body.rooms.some(item => item.id === room.id));
  const posted = await room_api(home, paired, { method: 'POST', path: `/api/rooms/${room.id}/messages`,
    body: { author: '用户', text: '经中转的发言', submission_id: 'relay-protected-message' } });
  assert.ok([200, 201].includes(posted.status), JSON.stringify(posted.body));
  const content = Buffer.from('中转附件');
  const uploaded = await room_upload(home, paired, { id: 'upload-relay-protected-1', path: `/api/rooms/${room.id}/attachments?file_name=note.txt&actor=%E7%94%A8%E6%88%B7&submission_id=relay-protected-upload`,
    index: 0, total: 1, size: content.length, content_type: 'text/plain', data: content.toString('base64') });
  assert.ok([200, 201].includes(uploaded.status), JSON.stringify(uploaded.body));
});

test('the command line refuses to start a protected account, which would run without its protection', async t => {
  const f = await fixture(t);
  const accounts = read_accounts(f.data);
  writeFileSync(join(f.data, 'gateway-accounts.json'), JSON.stringify({ ...accounts, alice: { ...accounts.alice, protected: true } }));
  const script = join(import.meta.dirname, '..', 'gateway', 'gateway.mjs');
  const child = spawn(process.execPath, [script, 'start', 'alice', '--data', f.data], { stdio: ['ignore', 'ignore', 'pipe'] });
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  const [code] = await new Promise(done => child.on('exit', (...args) => done(args)));
  assert.equal(code, 1);
  assert.match(errors, /入口保护/);
});

test('the panel\'s readiness check accepts a real protected instance only with its own key', async t => {
  const root = mkdtempSync(join(tmpdir(), 'codiscuss-conforms-'));
  const key = '5e'.repeat(32);
  const port = await protected_site(t, root, key);
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10 }));
  const { instance_conforms, instance_state } = await import('../runner/admin_panel.mjs');
  assert.equal(await instance_state(port), 'up');
  assert.equal(await instance_conforms(port, key), true);
  assert.equal(await instance_conforms(port, '6f'.repeat(32)), false, 'another key does not pass');
  assert.equal(await instance_conforms(port, ''), false, 'nor does treating it as unprotected');
});

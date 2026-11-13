import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { add_account, create_gateway, read_accounts, remove_account, reset_password } from '../gateway/gateway.mjs';

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
  return { data, origin, alice, bob, login, advance: ms => { clock += ms; } };
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
  const forged = await fetch(`${f.origin}/api/rooms`, { headers: { Cookie: 'codiscuss_entry=' + 'a'.repeat(64) } });
  assert.equal(forged.status, 401);
});

test('a signed-in account reaches only its own instance, presented as that instance\'s loopback page', async t => {
  const f = await fixture(t);
  const alice = await f.login('alice', f.alice.password), bob = await f.login('bob', f.bob.password);
  assert.equal(alice.status, 303);
  const seen = await (await fetch(`${f.origin}/api/local/settings?x=1`, { method: 'POST', body: '{}',
    headers: { Cookie: `${alice.cookie}; other=kept`, Origin: f.origin, 'Content-Type': 'application/json' } })).json();
  assert.equal(seen.label, 'alice');
  assert.equal(seen.url, '/api/local/settings?x=1');
  assert.equal(seen.headers.host, `127.0.0.1:${f.alice.port}`);
  assert.equal(seen.headers.origin, `http://127.0.0.1:${f.alice.port}`);
  assert.equal(seen.headers.cookie, 'other=kept');
  assert.equal((await (await fetch(`${f.origin}/api/rooms`, { headers: { Cookie: bob.cookie } })).json()).label, 'bob');
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

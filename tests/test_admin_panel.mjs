import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { add_account, instance_home, read_accounts, stop_entry } from '../gateway/gateway.mjs';
import { managed_api_keys, save_api_key } from '../runner/discussion_api.mjs';
import { create_panel, instance_conforms, instance_state, list_keys, protect_account, relay_operator_events } from '../runner/admin_panel.mjs';
import { instance_key_file, os_user_name, place_instance_key, secure_folder, secure_shared_root } from '../runner/os_users.mjs';
import { tray_script } from '../runner/tray.mjs';

const KEY = 'owner-key';
const folders = [];
after(() => { for (const folder of folders) rmSync(folder, { recursive: true, force: true }); });

function fixture() {
  const data = mkdtempSync(join(tmpdir(), 'panel-')), folder = `${data}-demo`;
  folders.push(data, folder);
  add_account(data, 'demo');
  writeFileSync(join(data, 'local-settings.json'), JSON.stringify({ hosting: true }));
  // Windows and service operations are stubbed: the panel's own checks are what these tests cover.
  const ops = { list_accounts: async () => [{ name: 'demo' }], shared_cli_state: () => ({}), service_overview: () => ({ running: true }), autostart_enabled: () => false };
  return { data, ops };
}

/** Serve the panel on a free port and return a request helper bound to its address. */
async function serve(data, ops) {
  let port;
  const server = await new Promise(done => { const created = create_panel({ data, key: KEY, port: 0, ops }); created.listen(0, '127.0.0.1', () => done(created)); });
  port = server.address().port;
  server.close();
  const real = create_panel({ data, key: KEY, port, ops });
  await new Promise(done => real.listen(port, '127.0.0.1', done));
  after(() => real.close());
  const base = `http://127.0.0.1:${port}`;
  const request = (path, { host = `127.0.0.1:${port}`, cookie = '', body, origin = base, header = true } = {}) => fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
    headers: { host, ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json', origin, ...(header ? { 'x-codiscuss-panel': '1' } : {}) }) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { request, port };
}

test('the panel opens only with the owner key, only for its own address, and refuses cross-site writes', async () => {
  const { data, ops } = fixture();
  const { request, port } = await serve(data, ops);
  assert.equal((await request('/api/state')).status, 401);
  assert.equal((await request('/enter?key=wrong')).status, 403);
  const entered = await request('/enter?key=owner-key&page=keys');
  assert.equal(entered.status, 302);
  assert.equal(entered.headers.get('location'), '/#keys');
  const cookie = entered.headers.get('set-cookie').split(';')[0];
  assert.equal((await request('/api/state', { cookie })).status, 200);
  // fetch keeps its own Host header, so a renamed host is sent with node:http.
  const renamed = await new Promise(done => http.get({ host: '127.0.0.1', port, path: '/api/state', headers: { host: `evil.example:${port}`, cookie } }, response => { response.resume(); done(response.statusCode); }));
  assert.equal(renamed, 403);
  assert.equal((await request('/api/accounts', { cookie, body: { name: 'next' }, origin: 'http://evil.example' })).status, 403);
  assert.equal((await request('/api/accounts', { cookie, body: { name: 'next' }, header: false })).status, 403);
  const created = await request('/api/accounts', { cookie, body: { name: 'next' } });
  assert.equal(created.status, 200);
  assert.ok((await created.json()).password);
  // With hosting off the panel keeps its overview but refuses every account operation.
  writeFileSync(join(data, 'local-settings.json'), JSON.stringify({}));
  const plain = await (await request('/api/state', { cookie })).json();
  assert.deepEqual([plain.hosting, plain.accounts], [false, []]);
  assert.equal((await request('/api/accounts', { cookie, body: { name: 'third' } })).status, 400);
  assert.equal((await request('/api/accounts/demo/keys', { cookie })).status, 400);
});

test('a key the owner gives an account is marked as provided and never returned in full', async () => {
  const { data, ops } = fixture();
  const { request } = await serve(data, ops);
  const cookie = (await request('/enter?key=owner-key')).headers.get('set-cookie').split(';')[0];
  const saved = await request('/api/accounts/demo/keys', { cookie, body: { base_url: 'https://api.deepseek.com/v1', api_key: 'sk-secret-1234' } });
  assert.equal(saved.status, 200);
  const service = instance_home(data, 'demo');
  save_api_key(service, { base_url: 'https://api.openai.com/v1', api_key: 'sk-own-5678' });
  const listed = await (await request('/api/accounts/demo/keys', { cookie })).json();
  assert.deepEqual(listed.map(key => [key.base_url, key.managed, key.tail]).sort(), [['https://api.deepseek.com/v1', true, '1234'], ['https://api.openai.com/v1', false, '5678']]);
  assert.ok(!JSON.stringify(listed).includes('sk-secret'));
  assert.deepEqual(managed_api_keys(service), [listed.find(key => key.managed).ref]);
  const removed = await request('/api/accounts/demo/keys/remove', { cookie, body: { ref: listed[0].ref } });
  assert.equal(removed.status, 200);
  assert.equal(list_keys(service).length, 1);
  assert.equal(readdirSync(join(service, 'api-keys')).length, 1);
});

test('the panel starts the real entry in the background, keeps only an https public address, and stops it', async t => {
  const { data, ops } = fixture();
  const spare = http.createServer();
  const entry_port = await new Promise(done => spare.listen(0, '127.0.0.1', () => done(spare.address().port)));
  await new Promise(done => spare.close(done));
  writeFileSync(join(data, 'gateway-settings.json'), JSON.stringify({ port: entry_port }));
  const { request } = await serve(data, ops);
  const cookie = (await request('/enter?key=owner-key')).headers.get('set-cookie').split(';')[0];
  t.after(() => stop_entry(data));
  assert.equal((await request('/api/entry/settings', { cookie, body: { public_url: 'http://entry.example.com' } })).status, 400);
  const saved = await (await request('/api/entry/settings', { cookie, body: { public_url: 'https://entry.example.com/login' } })).json();
  assert.equal(saved.public_url, 'https://entry.example.com');
  const started = await (await request('/api/entry/start', { cookie, body: {} })).json();
  assert.deepEqual([started.running, started.port], [true, entry_port]);
  assert.equal((await fetch(`http://127.0.0.1:${entry_port}/_entry/login`)).status, 200);
  assert.equal(JSON.parse(readFileSync(join(data, 'gateway-settings.json'), 'utf8')).running, true, 'an entry left on starts again with the panel');
  const stopped = await (await request('/api/entry/stop', { cookie, body: {} })).json();
  assert.equal(stopped.running, false);
  await assert.rejects(fetch(`http://127.0.0.1:${entry_port}/_entry/login`));
});

test('an account page cannot mark its own key as provided by the owner', () => {
  const service = mkdtempSync(join(tmpdir(), 'keys-'));
  folders.push(service);
  const { api_key_ref } = save_api_key(service, { base_url: 'https://api.openai.com/v1', api_key: 'sk-1' });
  assert.equal(JSON.parse(readFileSync(join(service, 'api-keys', `${api_key_ref}.json`), 'utf8')).managed, undefined);
});

test('Windows user names stay within the system limit, and the tray script names its menu entries', () => {
  assert.equal(os_user_name('demo'), 'cd-demo');
  assert.throws(() => os_user_name('a-very-long-account-name'), /最多 20/);
  const script = tray_script("Owner's panel", '', 0, '共议 · 管理面板');
  assert.match(script, /'打开管理面板'/);
  assert.match(script, /'Owner''s panel'/);
  // Without a panel the icon still runs the service entries, with nothing to open the panel.
  const bare = tray_script('共议');
  assert.doesNotMatch(bare, /'打开管理面板'/);
  assert.match(bare, /'关闭服务'/);
});

test('the launcher icon file lists each size and the launcher source quotes paths for C#', async () => {
  const { ico_from_pngs, launcher_source } = await import('../runner/launcher.mjs');
  const ico = ico_from_pngs([{ size: 256, png: Buffer.from('aaaa') }, { size: 16, png: Buffer.from('bb') }]);
  assert.deepEqual([ico.readUInt16LE(2), ico.readUInt16LE(4), ico[6], ico[22], ico.readUInt32LE(18), ico.readUInt32LE(34)], [1, 2, 0, 16, 38, 42]);
  assert.equal(ico.subarray(38).toString(), 'aaaabb');
  const source = launcher_source({ node: 'C:\node.exe', local_script: 'C:\a "b"\local.mjs', panel_script: '', home: 'C:\h' });
  assert.match(source, /@"C:\a ""b""\local\.mjs"/);
});

test('failures a hosted instance records reach the owner once each, and wait while the notice cannot be sent', async () => {
  const { data } = fixture();
  const service = instance_home(data, 'demo');
  mkdirSync(service, { recursive: true });
  const outbox = join(service, 'operator-events.jsonl');
  let next_id = 0;
  const failure = (reason) => `${JSON.stringify({ id: `event-${String(++next_id).padStart(4, '0')}`, kind: 'failed', member: 'Codex', reason, room: 'r1', title: '周报' })}\n`;
  writeFileSync(outbox, failure('Codex 未登录') + failure('额度已用完') + '{"id":"event-half","kind":"failed","reason":"half');
  const sent = [];
  let status = 'sent';
  const keys = new Set();
  // Duplicate keys are refused, as the real sender does.
  const send = async (home, notice) => { if (keys.has(notice.key)) return { status: 'duplicate' }; sent.push(notice); if (status === 'sent') keys.add(notice.key); return { status }; };
  assert.deepEqual(await relay_operator_events(data, send, () => true), ['demo']);
  assert.equal(sent.length, 1);
  assert.match(sent[0].paragraphs.join('\n'), /2 次执行失败[\s\S]*「周报」Codex：Codex 未登录[\s\S]*额度已用完/);
  assert.equal(sent[0].room.site, undefined, 'a reply to the notice is not routed into the account\'s room');
  assert.deepEqual(await relay_operator_events(data, send, () => true), [], 'nothing new, nothing sent');
  // The unfinished line is read once it is complete; a notice that could not go out is tried again.
  appendFileSync(outbox, '"}\n' + failure('进程退出'));
  status = 'no_context';
  assert.deepEqual(await relay_operator_events(data, send, () => true), []);
  status = 'sent';
  assert.deepEqual(await relay_operator_events(data, send, () => true), ['demo']);
  assert.equal(sent.length, 3);
  assert.equal(sent[1].key, sent[2].key);
  assert.match(sent[2].paragraphs.join('\n'), /2 次执行失败[\s\S]*进程退出/);
  // Without a reachable Weixin nothing is read, so failures wait for it.
  assert.deepEqual(await relay_operator_events(data, send, () => false), []);
});

test('a rewritten, emptied or flooded outbox, or one bad record, never hides an account\'s new failures or another account\'s', async () => {
  const { data } = fixture();
  add_account(data, 'other');
  folders.push(`${data}-other`);
  const outbox = name => { const service = instance_home(data, name); mkdirSync(service, { recursive: true }); return join(service, 'operator-events.jsonl'); };
  const line = (id, reason) => `${JSON.stringify({ id, kind: 'failed', member: 'Codex', reason, room: 'r1', title: '周报' })}\n`;
  const sent = [], keys = new Set();
  const send = async (home, notice) => { if (keys.has(notice.key)) return { status: 'duplicate' }; keys.add(notice.key); sent.push(notice); return { status: 'sent' }; };
  const relay = () => relay_operator_events(data, send, () => true);
  // A record whose fields are not text is skipped, and the next account is still read.
  writeFileSync(outbox('demo'), '{"id":"bad-record-1","kind":"failed","reason":{"toString":null}}\n' + line('aaaa-0001', '正常一'));
  writeFileSync(outbox('other'), line('bbbb-0001', '另一个账号'));
  assert.deepEqual((await relay()).sort(), ['demo', 'other']);
  assert.match(sent.map(notice => notice.paragraphs.join('\n')).join('\n'), /正常一[\s\S]*另一个账号|另一个账号[\s\S]*正常一/);
  // Rewritten to the same length with other records: read again from the start.
  writeFileSync(outbox('demo'), '{"id":"bad-record-2","kind":"failed","reason":{"toString":null}}\n' + line('aaaa-0002', '正常二'));
  assert.deepEqual(await relay(), ['demo']);
  assert.match(sent.at(-1).paragraphs.join('\n'), /正常二/);
  // Emptied and started again with one record: a new notice, not taken for the earlier one.
  writeFileSync(outbox('demo'), line('aaaa-0003', '重来'));
  assert.deepEqual(await relay(), ['demo']);
  assert.match(sent.at(-1).paragraphs.join('\n'), /重来/);
  // A flood of Chinese text cut at the read limit: the record after it is read whole.
  appendFileSync(outbox('demo'), Array.from({ length: 900 }, (_, index) => line(`flood-${String(index).padStart(4, '0')}`, '中文原因'.repeat(10))).join(''));
  assert.deepEqual(await relay(), ['demo']);
  appendFileSync(outbox('demo'), line('aaaa-0004', '洪水之后'));
  assert.deepEqual(await relay(), ['demo']);
  assert.match(sent.at(-1).paragraphs.join('\n'), /1 次执行失败[\s\S]*洪水之后/);
});

/** Who may do what on a folder, as Windows reports it (icacls). */
function rights_of(path) {
  return spawnSync('icacls', [path], { encoding: 'utf8', windowsHide: true }).stdout;
}

test('a protected folder ends up with only the owner\'s rights plus read for its readers, and a link is refused', { skip: process.platform !== 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'protected-'));
  folders.push(root);
  const target = join(root, 'shared');
  mkdirSync(target);
  // A grant left by someone else beforehand (here: every user may modify) must not survive.
  spawnSync('icacls', [target, '/grant', '*S-1-5-32-545:(OI)(CI)M'], { windowsHide: true });
  assert.match(rights_of(target), /BUILTIN\\Users:.*\(M\)/);
  assert.equal(secure_shared_root({ root: target }), 'ok');
  const after_rights = rights_of(target);
  assert.match(after_rights, /BUILTIN\\Users:\(OI\)\(CI\)\(RX\)/);
  assert.doesNotMatch(after_rights, /BUILTIN\\Users:.*\((M|F|W)\)/);
  assert.doesNotMatch(after_rights, /\(I\)/, 'nothing is inherited from above');
  // A junction in place of the folder is not followed.
  const elsewhere = join(root, 'elsewhere'), link = join(root, 'link');
  mkdirSync(elsewhere);
  spawnSync('cmd', ['/c', 'mklink', '/J', link, elsewhere], { windowsHide: true });
  assert.throws(() => secure_folder(link), /是一个链接/);
});

test('an account\'s key is placed in its own protected folder, with only that folder\'s rights, and never through a link on the way', { skip: process.platform !== 'win32' }, () => {
  const { data } = fixture();
  const root = mkdtempSync(join(tmpdir(), 'keys-'));
  folders.push(root);
  // A key file left there beforehand, readable by every user, is replaced by one with only the folder's rights.
  mkdirSync(join(root, 'keys', 'demo'), { recursive: true });
  writeFileSync(join(root, 'keys', 'demo', 'entry-key.json'), '{}');
  spawnSync('icacls', [join(root, 'keys', 'demo', 'entry-key.json'), '/grant', '*S-1-5-32-545:R'], { windowsHide: true });
  const key = 'c3'.repeat(32);
  const path = place_instance_key(data, 'demo', key, { root });
  assert.equal(path, instance_key_file('demo', root));
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).key, key);
  assert.doesNotMatch(rights_of(join(root, 'keys', 'demo')), /BUILTIN\\Users/, 'other accounts cannot read the folder');
  assert.doesNotMatch(rights_of(path), /BUILTIN\\Users/, 'nor the key file');
  // The keys folder replaced by a junction elsewhere: refused, though the root and the account folder look fine.
  const other = mkdtempSync(join(tmpdir(), 'keys-other-'));
  folders.push(other);
  rmSync(join(root, 'keys'), { recursive: true, force: true });
  spawnSync('cmd', ['/c', 'mklink', '/J', join(root, 'keys'), other], { windowsHide: true });
  assert.throws(() => place_instance_key(data, 'demo', key, { root }), /链接/);
});

test('protection changes only once a running instance is seen gone, and is reported on only once the restarted one serves as set', async () => {
  const { data } = fixture();
  // A stand-in for the instance: whether it listens, and whether it runs protected (as its start found the account).
  const instance = { state: 'up', protected: false, stops: true, starts: true, conforms: true };
  const options = (extra = {}) => ({ place: () => '', wait_ms: 0,
    state: async () => instance.state,
    conforms: async (port, key) => instance.state === 'up' && instance.conforms && Boolean(key) === instance.protected,
    restart: async (home, name, command) => {
      if (command === 'stop' && instance.stops) instance.state = 'down';
      if (command === 'start' && instance.starts) Object.assign(instance, { state: 'up', protected: read_accounts(home)[name].protected === true });
    }, ...extra });
  // Whether it runs cannot be told (the port neither answers nor refuses): nothing changes.
  instance.state = 'unknown';
  await assert.rejects(protect_account(data, 'demo', true, options()), /无法确认/);
  assert.equal(read_accounts(data).demo.protected, undefined);
  instance.state = 'up';
  instance.stops = false;
  await assert.rejects(protect_account(data, 'demo', true, options()), /没有停下来/);
  assert.equal(read_accounts(data).demo.protected, undefined, 'nothing changed while the old instance still serves');
  instance.stops = true;
  assert.deepEqual(await protect_account(data, 'demo', true, options()), { protected: true, running: true });
  assert.equal(read_accounts(data).demo.protected, true);
  assert.equal(instance.protected, true);
  // Started but not serving as set (a wrong key, something else answering): an error, not a success.
  instance.conforms = false;
  await assert.rejects(protect_account(data, 'demo', true, options()), /没有按入口保护启动起来/);
  instance.conforms = true;
  // Not coming back at all: said so.
  instance.starts = false;
  instance.state = 'up';
  await assert.rejects(protect_account(data, 'demo', false, options()), /没有启动起来/);
  // Not running: only the mark changes, and that is what is reported.
  instance.state = 'down';
  assert.deepEqual(await protect_account(data, 'demo', true, options()), { protected: true, running: false });
});

test('a port that does not answer is not taken for a stopped instance, and an answer of 403 alone is not taken for protection', async () => {
  const silent = http.createServer(() => {});
  const silent_port = await new Promise(done => silent.listen(0, '127.0.0.1', () => done(silent.address().port)));
  const refusing = http.createServer((request, response) => { response.statusCode = 403; response.end('{}'); });
  const refusing_port = await new Promise(done => refusing.listen(0, '127.0.0.1', () => done(refusing.address().port)));
  const closed = http.createServer();
  const closed_port = await new Promise(done => closed.listen(0, '127.0.0.1', () => done(closed.address().port)));
  await new Promise(done => closed.close(done));
  after(() => { silent.closeAllConnections(); silent.close(); refusing.close(); });
  assert.equal(await instance_state(silent_port), 'unknown');
  assert.equal(await instance_state(closed_port), 'down');
  assert.equal(await instance_state(refusing_port), 'up');
  assert.equal(await instance_conforms(refusing_port, 'a1'.repeat(32)), false, 'refusing everything is not proving the key');
});

test('a hosted account\'s outbox reached through a junction in its folder is not read', { skip: process.platform !== 'win32' }, async () => {
  const { data } = fixture();
  const service = instance_home(data, 'demo'), outside = mkdtempSync(join(tmpdir(), 'outside-'));
  folders.push(outside);
  writeFileSync(join(outside, 'operator-events.jsonl'), `${JSON.stringify({ id: 'outside-0001', kind: 'failed', member: 'x', reason: '外面的文件', room: 'r' })}\n`);
  rmSync(service, { recursive: true, force: true });
  spawnSync('cmd', ['/c', 'mklink', '/J', service, outside], { windowsHide: true });
  const sent = [];
  assert.deepEqual(await relay_operator_events(data, async (home, notice) => { sent.push(notice); return { status: 'sent' }; }, () => true), []);
  assert.equal(sent.length, 0);
});

test('waiting for a restarted instance keeps to its time limit even when each check is slow', async () => {
  const { data } = fixture();
  let state = 'up';
  const slow = ms => new Promise(done => setTimeout(done, ms));
  const started = Date.now();
  await assert.rejects(protect_account(data, 'demo', true, { place: () => '', wait_ms: 1000,
    state: async () => state,
    restart: async (home, name, command) => { state = command === 'stop' ? 'down' : 'up'; },
    conforms: async () => { await slow(600); return false; } }), /没有按入口保护启动起来/);
  assert.ok(Date.now() - started < 1700, `gave up after ${Date.now() - started} ms`);
});

test('setup sets the entry up only when hosting is asked for, and keeps it to this computer without a domain', async () => {
  const { configure_hosting, hosting_requested } = await import('../runner/hosting_setup.mjs');
  const { entry_settings } = await import('../gateway/gateway.mjs');
  // The panel's update runs `setup --yes` without --hosting: it must not turn the entry or starting with Windows back on.
  assert.equal(hosting_requested({ yes: true }, true), false);
  assert.equal(hosting_requested({ hosting: true }, true), process.platform === 'win32');
  const data = mkdtempSync(join(tmpdir(), 'hosting-'));
  folders.push(data);
  const result = configure_hosting(data, { hosting: true, 'entry-port': '8790' }, { interactive: false });
  assert.deepEqual({ ...entry_settings(data) }, { port: 8790, public_url: '', running: true, tunnel: null });
  // No launcher in a fresh folder: starting with Windows is left for the owner, and said so.
  assert.ok(result.issues.some(issue => issue.includes('登录自启')));
});

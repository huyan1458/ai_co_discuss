import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { add_account, instance_home, stop_entry } from '../gateway/gateway.mjs';
import { managed_api_keys, save_api_key } from '../runner/discussion_api.mjs';
import { create_panel, list_keys, relay_operator_events } from '../runner/admin_panel.mjs';
import { os_user_name } from '../runner/os_users.mjs';
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

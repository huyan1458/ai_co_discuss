import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { add_account, instance_home } from '../gateway/gateway.mjs';
import { managed_api_keys, save_api_key } from '../runner/discussion_api.mjs';
import { create_panel, list_keys } from '../runner/admin_panel.mjs';
import { os_user_name } from '../runner/os_users.mjs';
import { tray_script } from '../runner/tray.mjs';

const KEY = 'owner-key';
const folders = [];
after(() => { for (const folder of folders) rmSync(folder, { recursive: true, force: true }); });

function fixture() {
  const data = mkdtempSync(join(tmpdir(), 'panel-')), folder = `${data}-demo`;
  folders.push(data, folder);
  add_account(data, 'demo');
  // Windows operations are stubbed: the panel's own checks are what these tests cover.
  const ops = { list_accounts: async () => [{ name: 'demo' }], shared_cli_state: () => ({}) };
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

test('an account page cannot mark its own key as provided by the owner', () => {
  const service = mkdtempSync(join(tmpdir(), 'keys-'));
  folders.push(service);
  const { api_key_ref } = save_api_key(service, { base_url: 'https://api.openai.com/v1', api_key: 'sk-1' });
  assert.equal(JSON.parse(readFileSync(join(service, 'api-keys', `${api_key_ref}.json`), 'utf8')).managed, undefined);
});

test('Windows user names stay within the system limit, and the tray script names its menu entries', () => {
  assert.equal(os_user_name('demo'), 'cd-demo');
  assert.throws(() => os_user_name('a-very-long-account-name'), /最多 20/);
  const script = tray_script("Owner's panel");
  assert.match(script, /'打开管理面板'/);
  assert.match(script, /'Owner''s panel'/);
});

test('the launcher icon file lists each size and the launcher source quotes paths for C#', async () => {
  const { ico_from_pngs, launcher_source } = await import('../runner/launcher.mjs');
  const ico = ico_from_pngs([{ size: 256, png: Buffer.from('aaaa') }, { size: 16, png: Buffer.from('bb') }]);
  assert.deepEqual([ico.readUInt16LE(2), ico.readUInt16LE(4), ico[6], ico[22], ico.readUInt32LE(18), ico.readUInt32LE(34)], [1, 2, 0, 16, 38, 42]);
  assert.equal(ico.subarray(38).toString(), 'aaaabb');
  const source = launcher_source({ node: 'C:\node.exe', local_script: 'C:\a "b"\local.mjs', panel_script: '', home: 'C:\h' });
  assert.match(source, /@"C:\a ""b""\local\.mjs"/);
});

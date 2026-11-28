import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import pages from '../backend/worker.mjs';
import entry from '../backend/entry_worker.mjs';
import { MachineRelay } from '../backend/updates.mjs';
import { add_account, create_gateway, save_entry_settings } from '../gateway/gateway.mjs';
import { admin_cli } from '../runner/admin_cli.mjs';
import { create_panel } from '../runner/admin_panel.mjs';
import { entry_proxy } from '../runner/relay_channel.mjs';
import { listen_local } from './local_port.mjs';

const MACHINE = 'a'.repeat(32);
const FILE = 'b'.repeat(32);
const SHARE = 'c'.repeat(32);
const TOKEN = 'd'.repeat(64);
const LOCAL_SHARE = '/_cloud-share/' + TOKEN;
const CODE = '3E7H';

async function listening(t, server) {
  await listen_local(server);
  t.after(() => server.close());
  return server.address().port;
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'cloud-share-')), data = join(root, 'data');
  mkdirSync(data);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return data;
}

test('online and hosted public links reach only the selected local file endpoint', async t => {
  const data = fixture(t), seen = [];
  const instance = label => listening(t, createServer((request, response) => {
    seen.push({ label, path: request.url, headers: request.headers });
    response.writeHead(302, { Location: 'https://cos.test/' + label, 'Cache-Control': 'no-store' }).end();
  }));
  const owner = await instance('owner'), tenant = await instance('alice');
  add_account(data, 'alice', tenant);
  const gateway = await listening(t, create_gateway({ data }));
  writeFileSync(join(data, 'local-settings.json'), JSON.stringify({ port: owner }));
  save_entry_settings(data, { port: gateway, relay_enabled: false });
  const socket = { readyState: 1, deserializeAttachment: () => ({ role: 'machine', connection: 'current' }),
    send: value => receive(JSON.parse(value)) };
  const relay = new MachineRelay({ storage: { kv: { get: () => 'current' } }, getWebSockets: role => role === 'machine' ? [socket] : [] });
  const receive = entry_proxy(data, { send: frame => relay.entry_frame(frame) });
  const env = { RELAY: {
    idFromName: id => id,
    get: id => {
      assert.ok(id.startsWith(MACHINE + ':'));
      return { fetch: (url, init) => relay.fetch(new Request(url, init)) };
    },
  } };
  const headers = { Cookie: 'secret=1', Authorization: 'secret', 'X-CoDiscuss-Cloud-Base': 'https://bad.test' };
  const online_url = 'https://pages.test/api/cloud-share/' + MACHINE + '/' + TOKEN;
  const hosted_url = 'https://entry.test/cloud-share/' + MACHINE + '/alice/' + TOKEN;
  const tunnel_url = 'http://127.0.0.1:' + gateway + '/cloud-share/alice/' + TOKEN;
  for (const suffix of ['', '/' + CODE]) {
    save_entry_settings(data, { relay_enabled: false });
    const online = await pages.fetch(new Request(online_url + suffix, { headers }), env);
    assert.equal(online.status, 302);
    assert.equal(online.headers.get('Location'), 'https://cos.test/owner');
    await online.text();
    save_entry_settings(data, { relay_enabled: true });
    const hosted = await entry.fetch(new Request(hosted_url + suffix, { headers }), env);
    assert.equal(hosted.status, 302);
    assert.equal(hosted.headers.get('Location'), 'https://cos.test/alice');
    assert.equal(hosted.headers.get('Set-Cookie'), null);
    await hosted.text();
    const tunnel = await fetch(tunnel_url + suffix, { headers, redirect: 'manual' });
    assert.equal(tunnel.headers.get('Location'), 'https://cos.test/alice');
    assert.deepEqual(seen.slice(-3).map(x => [x.label, x.path]),
      ['owner', 'alice', 'alice'].map(label => [label, LOCAL_SHARE + suffix]));
  }
  for (const item of seen) {
    assert.equal(item.headers.cookie, undefined);
    assert.equal(item.headers.authorization, undefined);
    assert.equal(item.headers['x-codiscuss-cloud-base'], undefined);
  }
  for (const [worker, url] of [[pages, online_url], [entry, hosted_url]]) {
    assert.equal((await worker.fetch(new Request(url + '/' + CODE, { method: 'POST' }), env)).status, 404);
    assert.equal((await worker.fetch(new Request(url + '/' + CODE, { headers: { 'Content-Length': '1' } }), env)).status, 404);
    assert.equal((await worker.fetch(new Request(url + '/ZZZZZ'), env)).status, 404);
  }
  const forged = await relay.fetch(new Request('https://relay.internal/', { method: 'POST', headers: {
    'X-Relay-Role': 'entry', 'X-Entry-Request': encodeURIComponent(JSON.stringify({ cloud_share: true, method: 'GET', path: '/api/rooms' })),
  } }));
  assert.equal(forged.status, 400);
  assert.equal(seen.length, 6);
});

test('admin share commands use authenticated panel routes with the configured hosted entry', async t => {
  const data = fixture(t), calls = [];
  writeFileSync(join(data, 'local-settings.json'), '{"hosting":true}');
  save_entry_settings(data, { public_url: 'https://entry.test', tunnel_enabled: true });
  const port = await listening(t, createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    calls.push([request.method, request.url, request.headers['x-codiscuss-cloud-base'], Buffer.concat(chunks).toString()]);
    response.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
  }));
  add_account(data, 'alice', port);
  const { api } = create_panel({ data, key: 'fake-panel-key', port: 0 });
  const run = (...args) => admin_cli(['storage', 'object', '--data', data, '--account', 'alice', ...args], {
    client: async () => (route, body) => api(body === undefined ? 'GET' : 'POST', '/api/' + route, body),
    print: () => {},
  });
  await run('share', FILE, '--days', '30');
  await run('shares', FILE);
  await run('revoke-share', FILE, SHARE);
  await assert.rejects(run('share', FILE, '--days', '31'));
  save_entry_settings(data, { tunnel_enabled: false, relay_enabled: true, relay_url: 'https://entry.test' });
  writeFileSync(join(data, 'site-connections.json'), JSON.stringify({
    relay_site: 'https://pages.test', sites: { 'https://other.test': { machine_id: SHARE }, 'https://pages.test': { machine_id: MACHINE } },
  }));
  await run('share', FILE);
  const endpoint = '/api/rooms/cloud-attachments/' + FILE + '/shares';
  assert.deepEqual(calls, [
    ['POST', endpoint, 'https://entry.test/cloud-share/alice', '{"days":30}'],
    ['GET', endpoint, 'https://entry.test/cloud-share/alice', ''],
    ['POST', endpoint + '/' + SHARE + '/revoke', 'https://entry.test/cloud-share/alice', '{}'],
    ['POST', endpoint, 'https://entry.test/cloud-share/' + MACHINE + '/alice', '{}'],
  ]);
});

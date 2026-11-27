import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { ensure_tunnel, stop_tunnel } from '../runner/hosting_tunnel.mjs';
import { add_account, entry_status, start_entry, instance_home, read_accounts, save_entry_settings, set_account_disabled, set_instance_wanted, stop_entry } from '../gateway/gateway.mjs';
import { managed_api_keys, save_api_key } from '../runner/discussion_api.mjs';
import { create_panel, instance_conforms, instance_state, list_keys, protect_account, relay_operator_events, update_step } from '../runner/admin_panel.mjs';
import { blocking_paths, instance_key_file, os_user_name, place_instance_key, secure_folder, secure_shared_root } from '../runner/os_users.mjs';
import { tray_script } from '../runner/tray.mjs';
import { admin_cli } from '../runner/admin_cli.mjs';
import { read_relay_health, reconnect_reader, relay_health_writer, request_relay_reconnect } from '../runner/relay_health.mjs';
import { start_relay_channels } from '../runner/relay_channel.mjs';
import { relay_commands, relayed_command } from '../runner/remote_launch.mjs';
import { DatabaseSync } from 'node:sqlite';
import { service_drafts } from '../runner/discussion_runner.mjs';
import { member_drafts } from '../runner/free_runner.mjs';

process.env.CODISCUSS_LANG = 'zh-CN';

test('update steps report success independently of words in their message', async () => {
  const steps = [];
  await update_step(steps, '失败记录已清理', async () => {});
  assert.deepEqual(steps, [{ text: '失败记录已清理', failed: false }]);
});

test('update steps report failures even when the reason contains no Chinese', async () => {
  const steps = [];
  await update_step(steps, 'Restart service', async () => { throw new Error('connection refused'); });
  assert.equal(steps[0].failed, true);
  assert.match(steps[0].text, /connection refused/);
});

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

test('only a pong on the current socket confirms the relay; HTTP successes cannot refresh it', { timeout: 15_000 }, async context => {
  const { data } = fixture(), bound = { site: 'https://health.example', machine: 'test-machine' };
  writeFileSync(join(data, 'machine-links.json'), JSON.stringify({ sites: { [bound.site]: { id: bound.machine, private_key: {}, token: 'test' } } }));
  const health = relay_health_writer(data), stop = new AbortController(), sockets = [];
  const original = globalThis.WebSocket, replacement = Promise.withResolvers();
  globalThis.WebSocket = class extends EventTarget {
    static OPEN = 1;
    constructor() { super(); sockets.push(this); if (sockets.length === 2) replacement.resolve(this); }
    readyState = 1;
    send() {}
    close() { this.readyState = 3; queueMicrotask(() => this.dispatchEvent(new Event('close'))); }
  };
  context.mock.method(globalThis, 'fetch', async () => Response.json({ commands: [] }));
  context.mock.timers.enable({ apis: ['setInterval'] });
  const channels = start_relay_channels(data, { signal: stop.signal, health });
  context.after(async () => { stop.abort(); await channels.done(); globalThis.WebSocket = original; });
  const status = () => { health.flush(); return read_relay_health(data, bound, process.pid); };
  sockets[0].dispatchEvent(new Event('open'));
  assert.equal(status().state, 'confirming');
  context.mock.timers.tick(15_000);
  sockets[0].dispatchEvent(new MessageEvent('message', { data: 'pong' }));
  assert.equal(status().state, 'connected');
  context.mock.timers.tick(15_000);
  context.mock.timers.tick(15_000);
  assert.equal(status().last_failure.kind, 'heartbeat');
  assert.equal(status().state, 'reconnecting');
  sockets[0].dispatchEvent(new MessageEvent('message', { data: 'pong' }));
  assert.equal(status().state, 'reconnecting', 'a pong from a retired connection is ignored');
  const failure = new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
  globalThis.fetch.mock.mockImplementation(async () => { throw failure; });
  await relay_commands(data, { wait: 0, health });
  await relay_commands(data, { wait: 0, health });
  assert.equal(status().http_failures, 2);
  assert.equal(status().http_reason, 'reset');
  globalThis.fetch.mock.mockImplementation(async () => Response.json({ commands: [] }));
  await relay_commands(data, { wait: 0, health });
  assert.equal(status().http_failures, 0);
  assert.equal(read_relay_health(data, bound, process.pid, status().updated_at + 120_000).state, 'unknown');
  assert.equal(read_relay_health(data, bound, 0).reason, 'stopped');
  assert.equal(read_relay_health(data, bound, process.pid + 1).state, 'unknown');
  const next = await replacement.promise;
  next.dispatchEvent(new Event('open'));
  assert.equal(status().state, 'confirming');
  assert.equal(status().retries, 1);
  sockets[0].dispatchEvent(new MessageEvent('message', { data: 'pong' }));
  assert.equal(status().state, 'confirming');
  next.dispatchEvent(new MessageEvent('message', { data: 'pong' }));
  assert.equal(status().state, 'connected');
  assert.equal(status().retries, 0);
  assert.equal(status().last_failure.kind, 'heartbeat');
});

test('relay retry caps the wait at 30 seconds and sends a heartbeat when the recovered socket opens', async context => {
  const { data } = fixture(), bound = { site: 'https://retry.example', machine: 'retry' };
  writeFileSync(join(data, 'machine-links.json'), JSON.stringify({ sites: { [bound.site]: { id: bound.machine, private_key: {}, token: 'test' } } }));
  const sockets = [], stop = new AbortController(), health = relay_health_writer(data), original = globalThis.WebSocket;
  globalThis.WebSocket = class extends EventTarget {
    static OPEN = 1;
    readyState = 1;
    frames = [];
    constructor() { super(); sockets.push(this); }
    send(frame) { this.frames.push(frame); }
    close() { this.readyState = 3; }
  };
  context.mock.method(globalThis, 'fetch', async () => Response.json({}));
  context.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const channels = start_relay_channels(data, { signal: stop.signal, health });
  context.after(async () => { stop.abort(); await channels.done(); globalThis.WebSocket = original; });
  const settled = () => new Promise(done => setImmediate(done));
  // The first connection hangs during the handshake. Subsequent upgrades fail promptly.
  context.mock.timers.tick(10_000); await settled();
  health.flush();
  assert.equal(read_relay_health(data, bound, process.pid).last_failure.kind, 'timeout');
  for (const interval of [4_000, 8_000, 16_000, 30_000, 30_000]) {
    const before = sockets.length;
    context.mock.timers.tick(interval - 1); await settled();
    assert.equal(sockets.length, before);
    context.mock.timers.tick(1); await settled();
    assert.equal(sockets.length, before + 1);
    if (sockets.length < 6) { sockets.at(-1).dispatchEvent(new Event('error')); await settled(); }
  }
  const restored = sockets.at(-1);
  restored.dispatchEvent(new Event('open'));
  assert.deepEqual(restored.frames, ['ping']);
  restored.dispatchEvent(new MessageEvent('message', { data: 'pong' }));
  health.flush();
  assert.equal(read_relay_health(data, bound, process.pid).state, 'connected');
});

test('relay watchdog and manual reconnect rebuild only the addressed binding', async context => {
  const { data } = fixture(), healthy = 'https://a.example', stalled = 'https://b.example';
  const sites = Object.fromEntries([healthy, stalled].map((site, i) => [site, { id: String(i), private_key: {}, token: 'test' }]));
  writeFileSync(join(data, 'machine-links.json'), JSON.stringify({ sites }));
  const sockets = [], logs = [], health = relay_health_writer(data), stop = new AbortController();
  const original = globalThis.WebSocket;
  globalThis.WebSocket = class extends EventTarget {
    static OPEN = 1;
    readyState = 1;
    constructor(url) { super(); this.url = url; sockets.push(this); }
    send() {}
    close() { this.readyState = 3; }
  };
  context.mock.method(globalThis, 'fetch', async () => Response.json({}));
  context.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const channels = start_relay_channels(data, { signal: stop.signal, health, log: message => logs.push(message) });
  context.after(async () => { stop.abort(); await channels.done(); globalThis.WebSocket = original; });
  for (const socket of sockets) socket.dispatchEvent(new Event('open'));
  sockets[0].dispatchEvent(new MessageEvent('message', { data: 'pong' }));
  for (let elapsed = 15_000; elapsed < 180_000; elapsed += 15_000) {
    context.mock.timers.tick(15_000);
    sockets[0].dispatchEvent(new MessageEvent('message', { data: 'pong' }));
  }
  assert.equal(sockets.length, 2);
  context.mock.timers.tick(15_000);
  assert.equal(sockets.length, 3);
  assert.match(sockets[2].url, /b\.example/);
  assert.equal(sockets[0].readyState, 1);
  health.flush();
  const bound = { site: stalled, machine: sites[stalled].id };
  assert.equal(read_relay_health(data, bound, process.pid).last_rebuild.reason, 'watchdog');
  request_relay_reconnect(data, { ...bound, machine: 'old' }, process.pid);
  channels.refresh();
  request_relay_reconnect(data, bound, process.pid + 1);
  channels.refresh();
  assert.equal(sockets.length, 3);
  request_relay_reconnect(data, bound, process.pid);
  channels.refresh(); channels.refresh();
  assert.equal(sockets.length, 4);
  health.flush();
  assert.equal(read_relay_health(data, bound, process.pid).last_rebuild.reason, 'manual');
  assert.match(logs.join('\n'), /3 分钟.*\n.*管理员/);
});

test('instance recovery honors owner intent, backoff and a persistent cap; manual start restores the budget', async () => {
  const { data, ops } = fixture();
  let at = Date.now(), starts = 0, state = 'down', fails = true;
  Object.assign(ops, { now: () => at, instance_state: async () => state, start_verified: async () => {
    starts++;
    if (fails) throw new Error('state file locked');
  }, entry_overview: async () => ({}) });
  const panel = () => create_panel({ data, key: KEY, port: 0, ops });
  let server = panel();
  const check = () => server.recover_instances();
  const last = async () => (await server.api('GET', '/api/state', {})).accounts[0].last_restart;
  await check();
  set_instance_wanted(data, 'demo', true);
  set_account_disabled(data, 'demo', true);
  await check();
  set_account_disabled(data, 'demo', false);
  state = 'unknown'; await check();
  state = 'up'; await check();
  assert.equal(starts, 0);
  state = 'down';
  await Promise.all([check(), check()]);
  assert.equal(starts, 1);
  at += 59_999; await check(); assert.equal(starts, 1);
  at++; await check(); assert.equal(starts, 2);
  at += 60_000; await check(); assert.equal(starts, 2);
  at += 60_000; await check(); assert.equal(starts, 3);
  assert.equal((await last()).blocked, true);
  assert.equal((await last()).error.template, 'state file locked');
  assert.equal((await last()).at, at);
  const log = readFileSync(join(data, 'admin-panel.log'), 'utf8');
  assert.equal(log.match(/正在自动重启/g).length, 3);
  assert.equal(log.match(/state file locked/g).length, 3);
  server = panel(); at += 660_000; await check(); assert.equal(starts, 3);
  fails = false;
  await server.api('POST', '/api/accounts/demo/start', {});
  await check();
  assert.equal(starts, 5);
  assert.equal((await last()).result, 'started');
  set_instance_wanted(data, 'demo', false);
  at += 120_000; await check(); assert.equal(starts, 5);
});

test('isolated instance recovery uses the scheduler run flag and disarms it after repeated crashes', async () => {
  const { data, ops } = fixture();
  writeFileSync(join(data, 'os-users.json'), JSON.stringify({ demo: { user: 'isolated-demo' } }));
  let at = Date.now(), flag = false, starts = 0;
  set_instance_wanted(data, 'demo', true);
  Object.assign(ops, { now: () => at, instance_flag_set: () => flag, clear_instance_flag: () => { flag = false; },
    instance_state: async () => 'down', start_verified: async () => { starts++; }, entry_overview: async () => ({}) });
  const server = create_panel({ data, key: KEY, port: 0, ops });
  await server.recover_instances();
  assert.equal(starts, 0);
  flag = true;
  for (const advance of [0, 60_000, 120_000, 60_000]) {
    at += advance;
    await server.recover_instances();
  }
  assert.equal(starts, 3);
  assert.equal(flag, false);
  const { port } = await serve(data, ops);
  writeFileSync(join(data, 'admin-panel.json'), JSON.stringify({ port, key: KEY, pid: process.pid }));
  const status = await admin_cli(['status', '--data', data], { print: () => {} });
  assert.deepEqual(status.accounts[0].last_restart, { reason: '实例端口拒绝连接', result: 'started', blocked: true,
    at: new Date(at - 60_000).toISOString(), error: '实例端口拒绝连接' });
});

test('update progress normalizes old updater records and preserves structured failure flags', async () => {
  const { data, ops } = fixture();
  const { request } = await serve(data, ops);
  const cookie = (await request('/enter?key=owner-key')).headers.get('set-cookie').split(';')[0];
  writeFileSync(join(data, 'panel-update.json'), JSON.stringify({ status: 'install_failed', steps: [
    '已安装 v1.0.0', '安装失败：network', { text: 'Failed logs removed', failed: false }, { text: 'Network unavailable', failed: true },
  ] }));
  const response = await request('/api/update/progress', { cookie });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).steps, [
    { text: '已安装 v1.0.0', failed: false }, { text: '安装失败：network', failed: true },
    { text: 'Failed logs removed', failed: false }, { text: 'Network unavailable', failed: true },
  ]);
});

test('an update npm cannot deliver yet is refused before anything is stopped', async () => {
  const { data, ops } = fixture();
  let begun = false;
  const { request } = await serve(data, { ...ops, latest_version: async () => '9.9.9', begin_update: async () => { begun = true; return {}; },
    check_package: async () => { throw new Error('npm 还在准备安装包'); } });
  const cookie = (await request('/enter?key=owner-key')).headers.get('set-cookie').split(';')[0];
  const response = await request('/api/update', { cookie, body: {} });
  assert.equal(response.status, 400);
  assert.equal(begun, false);
});

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

test('tunnel reconnect replaces cloudflared and keeps the sign-in entry process', async t => {
  const { data, ops } = fixture();
  const { request } = await serve(data, ops);
  const cookie = (await request('/enter?key=owner-key')).headers.get('set-cookie').split(';')[0];
  const reconnect = () => request('/api/tunnel/reconnect', { cookie, body: {} });
  assert.equal((await reconnect()).status, 400);
  const probe = http.createServer();
  await new Promise(done => probe.listen(0, '127.0.0.1', done));
  const port = probe.address().port;
  await new Promise(done => probe.close(done));
  const tunnel = { host: 'accounts.example', name: 'test', id: 'test', credentials: 'unused' };
  save_entry_settings(data, { tunnel, tunnel_enabled: true, port, running: true });
  assert.equal((await reconnect()).status, 400);
  const entry = await start_entry(data);
  t.after(() => stop_entry(data));
  // Node receives "tunnel" as its script argument and serves cloudflared's readiness endpoint.
  writeFileSync(join(data, 'tunnel'), `const http = require('node:http');
    const address = process.argv[process.argv.indexOf('--metrics') + 1];
    http.createServer((req, res) => res.writeHead(req.url === '/ready' ? 200 : 404).end()).listen(Number(address.split(':')[1]), '127.0.0.1');`);
  const previous = process.env.CODISCUSS_CLOUDFLARED;
  process.env.CODISCUSS_CLOUDFLARED = process.execPath;
  t.after(() => {
    stop_tunnel(data);
    if (previous === undefined) delete process.env.CODISCUSS_CLOUDFLARED;
    else process.env.CODISCUSS_CLOUDFLARED = previous;
  });
  await ensure_tunnel(data, tunnel, port);
  const tunnel_pid = () => JSON.parse(readFileSync(join(data, 'tunnel.json'), 'utf8')).pid;
  const old_pid = tunnel_pid();
  const response = await reconnect();
  assert.equal(response.status, 200);
  assert.equal((await response.json()).connected, true);
  assert.notEqual(tunnel_pid(), old_pid);
  assert.equal((await entry_status(data)).pid, entry.pid);
});

test('the panel opens only with the owner key, only for its own address, and refuses cross-site writes', async () => {
  const { data, ops } = fixture();
  const { request, port } = await serve(data, ops);
  assert.equal((await request('/api/state')).status, 401);
  assert.equal((await request('/enter?key=wrong')).status, 403);
  const entered = await request('/enter?key=owner-key&page=keys');
  assert.equal(entered.status, 302);
  assert.equal(entered.headers.get('location'), '/#keys');
  // The window opens on / itself, so Edge keeps and restores its size under one address.
  assert.equal((await request('/?key=wrong')).status, 403);
  const at_root = await request('/?key=owner-key');
  assert.equal(at_root.status, 302);
  assert.equal(at_root.headers.get('location'), '/');
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

test('panel errors carry Chinese templates and parameters independently of the CLI language', async () => {
  const { data, ops } = fixture();
  const { request } = await serve(data, ops);
  const previous_language = process.env.CODISCUSS_LANG;
  process.env.CODISCUSS_LANG = 'en';
  try {
    const denied = await request('/api/state');
    assert.equal(denied.status, 401);
    assert.deepEqual(await denied.json(), { error: '请从任务栏图标重新打开管理面板', error_text: { template: '请从任务栏图标重新打开管理面板', params: {} } });
    const cookie = (await request('/enter?key=owner-key')).headers.get('set-cookie').split(';')[0];
    const missing = await request('/api/accounts/missing/start', { cookie, body: {} });
    assert.equal(missing.status, 400);
    assert.deepEqual(await missing.json(), { error: '账号不存在：missing', error_text: { template: '账号不存在：{value1}', params: { value1: 'missing' } } });
  } finally { process.env.CODISCUSS_LANG = previous_language; }
});

test('the panel API client translates structured errors and preserves legacy errors and HTTP status', async () => {
  const original_fetch = globalThis.fetch, original_i18n = globalThis.codiscuss_i18n;
  const english = JSON.parse(readFileSync(new URL('../frontend/locales/en/backend_worker.json', import.meta.url), 'utf8'));
  globalThis.codiscuss_i18n = { t: (template, params = {}) => (english[template] || template).replace(/\{(\w+)\}/g, (match, name) => Object.hasOwn(params, name) ? String(params[name]) : match) };
  try {
    const { call } = await import('../frontend/admin/api.js');
    globalThis.fetch = async () => Response.json({ error: '账号不存在：demo', error_text: { template: '账号不存在：{value1}', params: { value1: 'demo' } } }, { status: 400 });
    await assert.rejects(call('accounts/demo/start', {}), error => error.message === 'Account not found: demo' && error.status === 400);
    globalThis.fetch = async () => Response.json({ error: 'legacy error' }, { status: 409 });
    await assert.rejects(call('old-server'), error => error.message === 'legacy error' && error.status === 409);
  } finally { globalThis.fetch = original_fetch; globalThis.codiscuss_i18n = original_i18n; }
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
  const result = await configure_hosting(data, { hosting: true, 'entry-port': '8790' }, { interactive: false });
  assert.deepEqual({ ...entry_settings(data) }, { port: 8790, public_url: '', running: true, tunnel: null, relay_enabled: false, tunnel_enabled: false, relay_url: '' });
  // No launcher in a fresh folder: starting with Windows is left for the owner, and said so.
  assert.ok(result.issues.some(issue => issue.includes('登录自启')));
});

test('the entry keeps the way an older version chose, and the relay and the tunnel can be on together', async () => {
  const { entry_settings, save_entry_settings } = await import('../gateway/gateway.mjs');
  const data = mkdtempSync(join(tmpdir(), 'entry-ways-'));
  folders.push(data);
  const tunnel = { name: 'codiscuss', host: 'entry.example.com', id: 'id', credentials: 'file' };
  const ways = saved => {
    writeFileSync(join(data, 'gateway-settings.json'), JSON.stringify(saved));
    const { relay_enabled, tunnel_enabled } = entry_settings(data);
    return { relay_enabled, tunnel_enabled };
  };
  assert.deepEqual(ways({ mode: 'relay', tunnel }), { relay_enabled: true, tunnel_enabled: false });
  assert.deepEqual(ways({ mode: 'tunnel', tunnel }), { relay_enabled: false, tunnel_enabled: true });
  assert.deepEqual(ways({ mode: 'local', tunnel }), { relay_enabled: false, tunnel_enabled: false });
  assert.deepEqual(ways({ tunnel }), { relay_enabled: false, tunnel_enabled: true });
  ways({ mode: 'relay', tunnel });
  save_entry_settings(data, { tunnel_enabled: true });
  assert.equal(entry_settings(data).relay_enabled, true, 'turning the tunnel on leaves the relay on');
  assert.equal(entry_settings(data).tunnel_enabled, true);
  save_entry_settings(data, { relay_enabled: false });
  assert.equal(entry_settings(data).relay_enabled, false, 'a way turned off stays off whatever the old mode said');
  assert.equal(entry_settings(data).tunnel_enabled, true);
});

test('setup asks for the outside address in a terminal, asks again after a wrong domain, and never asks with --yes', async () => {
  const { ask_hosting } = await import('../runner/hosting_setup.mjs');
  const data = mkdtempSync(join(tmpdir(), 'hosting-ask-'));
  folders.push(data);
  const replies = (...answers) => { const asked = []; return { asked, ask: async question => { asked.push(question); return answers.shift() ?? ''; } }; };
  const shown = [];
  const show = title => shown.push(title);
  // A wrong domain is asked again; a blank tunnel name is the default; then the Cloudflare checks wait for Enter.
  let typed = replies('https://bad', 'Codiscuss.Example.com', '', '');
  let options = { hosting: true };
  await ask_hosting(data, options, { ask: typed.ask, show, interactive: true });
  assert.equal(options['public-host'], 'codiscuss.example.com');
  assert.equal(options['tunnel-name'], 'codiscuss');
  assert.equal(typed.asked.length, 4);
  assert.ok(shown.some(title => title.includes('外网域名无效')));
  // Blank keeps the entry to this computer.
  typed = replies('');
  options = { hosting: true };
  await ask_hosting(data, options, { ask: typed.ask, show, interactive: true });
  assert.equal(options['public-host'], undefined);
  // --yes (the panel's update) and runs without a terminal ask nothing.
  typed = replies('x.example.com');
  await ask_hosting(data, { hosting: true, yes: true }, { ask: typed.ask, show, interactive: true });
  await ask_hosting(data, { hosting: true }, { ask: typed.ask, show, interactive: false });
  assert.equal(typed.asked.length, 0);
});

test('joining the online relay takes one access code, and a wrong one or a missing deployment config is explained', async () => {
  const { data, ops } = fixture();
  const { request } = await serve(data, ops);
  const cookie = (await request('/enter?key=owner-key')).headers.get('set-cookie').split(';')[0];
  const joined = await request('/api/relay/join', { cookie, body: { code: 'https://site.example/without-token' } });
  assert.equal(joined.status, 400);
  assert.match((await joined.json()).error, /接入码不对/);
  const made = await request('/api/site/code', { cookie, body: { config: join(data, 'missing.jsonc'), site: 'https://site.example' } });
  assert.equal(made.status, 400);
  assert.match((await made.json()).error, /找不到线上站点的部署配置/);
});

test('the owner binds and leaves the online site without hosting, and never from under the hosted accounts', async () => {
  const { data, ops } = fixture();
  writeFileSync(join(data, 'local-settings.json'), JSON.stringify({ hosting: false }));
  const links = (site) => writeFileSync(join(data, 'machine-links.json'), JSON.stringify({ sites: site ? { [site]: { id: 'a'.repeat(32), private_key: 'key' } } : {} }));
  let bound = null;
  ops.service_overview = () => ({ running: true, pid: process.pid });
  ops.connect_site = async (_data, site) => { if (site === 'https://not-a-site.example') return null; links(site); bound = { site, machine: 'a'.repeat(32) }; return bound; };
  const { request } = await serve(data, ops);
  const cookie = (await request('/enter?key=owner-key')).headers.get('set-cookie').split(';')[0];
  const post = async (path, body) => { const answer = await request(`/api/site/${path}`, { cookie, body }); return { status: answer.status, body: await answer.json() }; };
  const online = async () => (await (await request('/api/state', { cookie })).json()).online_site;
  assert.equal(await online(), '');
  assert.match((await post('connect', { site: 'not an address' })).body.error, /线上网站地址格式不对/);
  assert.match((await post('connect', { site: 'https://not-a-site.example' })).body.error, /不是共议线上站点/);
  assert.equal((await post('connect', { site: 'https://site.example/path' })).status, 200);
  assert.equal(await online(), 'https://site.example', 'kept as the site itself, with hosting off');
  assert.match((await post('connect', { site: 'https://other.example' })).body.error, /已绑定 https:\/\/site\.example/);
  const region = async () => (await (await request('/api/site/region', { cookie })).json()).region;
  assert.equal(await region(), 'apac');
  assert.equal((await post('region', { region: 'nowhere' })).status, 400);
  assert.equal((await post('region', { region: 'weur' })).status, 200);
  assert.equal(await region(), 'weur');
  let acknowledged = 'apac';
  const reconnect = reconnect_reader(data, () => acknowledged);
  const sites = { [bound.site]: { id: bound.machine } };
  assert.equal(reconnect(sites), undefined);
  acknowledged = 'weur';
  assert.equal(reconnect(sites), bound.site);
  assert.equal(reconnect(sites), undefined);
  // The hosted accounts' address runs over this binding: leaving it would cut them off silently.
  save_entry_settings(data, { relay_enabled: true });
  assert.match((await post('disconnect', {})).body.error, /请先关闭它/);
  assert.equal(await online(), 'https://site.example');
  save_entry_settings(data, { relay_enabled: false });
  assert.deepEqual((await post('disconnect', {})).body, { disconnected: 'https://site.example' });
  assert.equal(await online(), '');
});

test('admin storage accounts for members and separate speech models and cleans only confirmed scratch', async () => {
  const { data, ops } = fixture();
  const project_data_root = mkdtempSync(join(tmpdir(), 'hosted-projects-'));
  folders.push(project_data_root);
  mkdirSync(join(project_data_root, 'drafts'));
  writeFileSync(join(data, 'local-settings.json'), JSON.stringify({ hosting: true, project_data_root }));
  const { port, request } = await serve(data, ops);
  const directory = join(data, 'runtime'), config_path = join(data, 'room.json');
  const config = { room: 'test', site: 'https://example.org', data_directory: directory, members: { Expert: {} } };
  writeFileSync(config_path, JSON.stringify(config));
  writeFileSync(join(data, 'rooms.json'), JSON.stringify({ configs: [config_path] }));
  mkdirSync(directory);
  const db = new DatabaseSync(join(directory, 'runtime.sqlite3'));
  db.exec('CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT)');
  db.prepare('INSERT INTO metadata VALUES (?,?)').run('failed-scratch:2', JSON.stringify({ member: 'Expert', id: 2, ended: 1 }));
  db.close();
  const drafts = member_drafts({ draft_directory: service_drafts(data, directory) }, 'Expert');
  assert.ok(drafts.startsWith(join(project_data_root, 'drafts')));
  for (const id of ['1', '2']) {
    const folder = join(drafts, '.scratch', id);
    mkdirSync(folder, { recursive: true }); writeFileSync(join(folder, 'temp'), 'abc');
  }
  writeFileSync(join(drafts, 'answer'), 'keep');
  mkdirSync(join(data, 'yovoice')); writeFileSync(join(data, 'yovoice', 'weights'), 'model');
  assert.equal((await request('/api/storage')).status, 401);
  assert.equal((await request('/api/storage/clean', { body: {} })).status, 401);
  writeFileSync(join(data, 'admin-panel.json'), JSON.stringify({ port, key: KEY, pid: process.pid }));
  const call = (...args) => admin_cli(['storage', ...args, '--data', data], { print() {} });
  const snapshot = await call(), room = snapshot.rooms[0];
  assert.equal(snapshot.model_bytes, 5);
  assert.equal(room.room_id, 'test');
  assert.equal(room.bytes, 10);
  assert.equal(room.scratch_bytes, 3);
  assert.equal(room.members[0].name, 'Expert');
  assert.equal(room.members[0].bytes, 10);
  const cookie = (await request('/enter?key=owner-key')).headers.get('set-cookie').split(';')[0];
  const outside = await request('/api/storage/clean', { cookie, body: { room_key: 'other' } });
  assert.equal((await outside.json()).removed, 0);
  assert.deepEqual(await call('clean'), { removed: 1, freed_bytes: 3, failed: 0 });
  assert.deepEqual(await call('clean'), { removed: 0, freed_bytes: 0, failed: 0 });
  assert.deepEqual(readdirSync(join(drafts, '.scratch')), ['1']);
  assert.equal(readFileSync(join(drafts, 'answer'), 'utf8'), 'keep');
  assert.equal(relayed_command(config.site, 'storage').command, 'storage');
  assert.deepEqual(relayed_command(config.site, 'storage-clean', { room_key: room.key }).input, { room_key: room.key });
});

test('the admin command line works the panel with the owner key only, and does what the panel does', async () => {
  const { data, ops } = fixture();
  const { port } = await serve(data, ops);
  const run = async (args) => { let text = ''; await admin_cli([...args, '--data', data], { print: chunk => { text += chunk; } }); return JSON.parse(text); };
  // Without the key file the owner keeps, nothing is reached.
  await assert.rejects(run(['status']), /管理面板没有在运行/);
  writeFileSync(join(data, 'admin-panel.json'), JSON.stringify({ port, key: 'wrong-key', pid: process.pid }));
  await assert.rejects(run(['status']), /拒绝了钥匙/);
  writeFileSync(join(data, 'admin-panel.json'), JSON.stringify({ port, key: KEY, pid: process.pid }));
  assert.equal((await run(['status'])).hosting, true);
  assert.deepEqual(await run(['account', 'migration-backups', 'demo']), []);
  await assert.rejects(run(['account', 'release-backup', 'demo', 'unknown', 'drafts']), /confirm/);
  assert.deepEqual(await run(['site', 'status']), { local: null, online: null });
  const created = await run(['key', 'add', 'demo', '--base-url', 'https://api.deepseek.com/v1', '--key', 'sk-secret-5678']);
  assert.ok(created);
  const keys = await run(['key', 'list', 'demo']);
  assert.ok(keys.some(item => item.managed) && !JSON.stringify(keys).includes('sk-secret-5678'), 'added as the owner gives it, never shown in full');
});

test('admin status and the panel use the same fresh relay snapshot', async () => {
  const { data, ops } = fixture(), site = 'https://panel-health.example', machine = 'panel-machine';
  writeFileSync(join(data, 'local-settings.json'), JSON.stringify({ hosting: false }));
  writeFileSync(join(data, 'machine-links.json'), JSON.stringify({ sites: { [site]: { id: machine, private_key: {} } } }));
  ops.service_overview = () => ({ running: true, pid: process.pid });
  const { request, port } = await serve(data, ops);
  writeFileSync(join(data, 'admin-panel.json'), JSON.stringify({ port, key: KEY, pid: process.pid }));
  const run = () => admin_cli(['status', '--data', data], { print: () => {} });
  assert.equal((await run()).relay_health.label, '状态未知');
  const health = relay_health_writer(data);
  health.channel(site, machine, 'connected');
  health.request(site, machine);
  health.http(site, machine, { cause: { code: 'ECONNRESET' } });
  health.flush();
  const cookie = (await request('/enter?key=owner-key')).headers.get('set-cookie').split(';')[0];
  const panel = await (await request('/api/state', { cookie })).json();
  const { label, detail, ...fields } = (await run()).relay_health;
  assert.deepEqual(fields, panel.relay_health);
  assert.ok(fields.last_request_at);
  assert.equal(label, '网站请求异常');
  assert.match(detail, /panel-health\.example.*1 次.*连接被重置/);
  const result = await admin_cli(['site', 'reconnect', '--data', data], { print: () => {} });
  assert.deepEqual(result, { requested: true, site });
  assert.equal(JSON.parse(readFileSync(join(data, 'relay-reconnect.json'), 'utf8')).machine, machine);
});


test('every hosted account can invite external experts: the panel binds its own service home under this computer, and releases it on leaving', async () => {
  const { machine_links } = await import('../runner/remote_launch.mjs');
  const { reconcile_external } = await import('../runner/admin_panel.mjs');
  const { data, ops } = fixture();
  const owner = 'a'.repeat(32), site = 'https://site.example';
  writeFileSync(join(data, 'machine-links.json'), JSON.stringify({ sites: { [site]: { id: owner, private_key: 'key', token: 'b'.repeat(64) } } }));
  const seen = [], real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (!String(url).startsWith(`${site}/`)) return real(url, init);
    seen.push({ path: new URL(String(url)).pathname, token: new Headers(init.headers).get('X-Machine-Token'), body: init.body ? JSON.parse(init.body) : null });
    return Response.json(String(url).endsWith('/setup') ? { setup_key: 'c'.repeat(64), expires_at: 0 } : { launches: [] });
  };
  after(() => { globalThis.fetch = real; });
  await reconcile_external(data, { log: () => {} });
  assert.deepEqual(seen[0], { path: `/api/machines/${owner}/setup`, token: 'b'.repeat(64), body: {} }, 'the token is asked for with this computer\'s own credential');
  const bound = seen.find(item => item.path === '/api/machines');
  assert.equal(bound.body.setup_key, 'c'.repeat(64));
  assert.notEqual(bound.body.id, owner, 'the account binds as a computer of its own');
  assert.equal(machine_links(instance_home(data, 'demo')).sites[site]?.id, bound.body.id, 'the binding is in the account\'s own service home');
  // Leaving the online site releases the account's slot first instead of refusing.
  const { request } = await serve(data, ops);
  const cookie = (await request('/enter?key=owner-key')).headers.get('set-cookie').split(';')[0];
  const left = await request('/api/site/disconnect', { cookie, body: {} });
  assert.deepEqual(await left.json(), { disconnected: site });
  assert.deepEqual(seen.find(item => item.path.endsWith('/release')), { path: `/api/machines/${owner}/release`, token: 'b'.repeat(64), body: { machine: bound.body.id } });
  assert.equal(machine_links(instance_home(data, 'demo')).sites[site], undefined);
});

test('with the owner\'s domain on, every account gets a direct identity that follows the domain, and none once it is off', async () => {
  const { direct_link } = await import('../runner/remote_launch.mjs');
  const { reconcile_external } = await import('../runner/admin_panel.mjs');
  const { data } = fixture();
  const settings = host => writeFileSync(join(data, 'gateway-settings.json'), JSON.stringify({ tunnel: { name: 'n', host, id: 'i', credentials: 'c' }, tunnel_enabled: Boolean(host) }));
  const mapping = () => JSON.parse(readFileSync(join(data, 'direct-accounts.json'), 'utf8'));
  const real = globalThis.fetch, outside = [];
  globalThis.fetch = async (url, init) => { if (!String(url).startsWith('http://127.0.0.1')) outside.push(String(url)); return real(url, init); };
  after(() => { globalThis.fetch = real; });
  settings('codiscuss.example');
  await reconcile_external(data, { log: () => {} });
  assert.deepEqual(outside, [], 'no online site is asked');
  const link = direct_link(instance_home(data, 'demo'));
  assert.equal(link.site, 'https://codiscuss.example');
  assert.deepEqual(mapping(), { [link.id]: 'demo' }, 'the entry learns which id is which account');
  await reconcile_external(data, { log: () => {} });
  assert.equal(direct_link(instance_home(data, 'demo')).id, link.id, 'an identity that fits is kept');
  settings('other.example');
  await reconcile_external(data, { log: () => {} });
  const moved = direct_link(instance_home(data, 'demo'));
  assert.equal(moved.site, 'https://other.example', 'a new domain gives a new identity, so invites name it');
  assert.deepEqual(mapping(), { [moved.id]: 'demo' });
  settings('');
  await reconcile_external(data, { log: () => {} });
  assert.equal(direct_link(instance_home(data, 'demo')), null);
  assert.deepEqual(mapping(), {});
});

test('an account whose side cannot be taken down keeps its record, gets no second one, and is not switched to another Windows user', async () => {
  const { reconcile_external } = await import('../runner/admin_panel.mjs');
  const { data, ops } = fixture();
  const settings = host => writeFileSync(join(data, 'gateway-settings.json'), JSON.stringify({ tunnel: { name: 'n', host, id: 'i', credentials: 'c' }, tunnel_enabled: true }));
  const records = () => JSON.parse(readFileSync(join(data, 'account-sites.json'), 'utf8'));
  settings('codiscuss.example');
  await reconcile_external(data, { log: () => {} });
  // The account's identity file can no longer be opened: taking it down fails.
  writeFileSync(join(instance_home(data, 'demo'), 'machine-links.json'), '{ broken');
  settings('other.example');
  await reconcile_external(data, { log: () => {} });
  assert.equal(records().demo.site, 'https://codiscuss.example', 'the record stays, to be taken down on a later pass');
  let switched = false;
  ops.create_os_user = () => { switched = true; return {}; };
  const { request } = await serve(data, ops);
  const cookie = (await request('/enter?key=owner-key')).headers.get('set-cookie').split(';')[0];
  const answer = await request('/api/accounts/demo/os-user', { cookie, body: {} });
  assert.notEqual(answer.status, 200);
  assert.equal(switched, false, 'the Windows user is not changed while its identity is left behind');
});

test('closing the other drives to hosted accounts is refused while what they run lies on one', () => {
  assert.deepEqual(blocking_paths(['C:\ProgramData\CoDiscuss', 'c:\Users\alice', '', 'D:\tools\node'], 'C:'), ['D:\tools\node']);
  assert.deepEqual(blocking_paths(['C:\ProgramData\CoDiscuss'], 'C:'), []);
});

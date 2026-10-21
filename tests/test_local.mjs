import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { detect_python } from '../runner/discussion_setup.mjs';
import { connection_site } from '../runner/discussion_local.mjs';

const CLI = fileURLToPath(new URL('../runner/codiscuss.mjs', import.meta.url));

async function reserve_port() {
  const server = createServer();
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return server;
}

function fixture(port) {
  const home = mkdtempSync(join(tmpdir(), 'codiscuss-local-'));
  const python = detect_python();
  writeFileSync(join(home, 'local-settings.json'), JSON.stringify({ python, port }));
  const env = { ...process.env, DISCUSS_SERVICE_HOME: home, PYTHONDONTWRITEBYTECODE: '1' };
  const execute = args => spawnSync(process.execPath, [CLI, ...args], { cwd: home, env, encoding: 'utf8', timeout: 40000 });
  const command = args => {
    const result = execute(args);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  return { home, python, env, execute, command };
}

test('website connection requires a secure root origin before any process or configuration is created', () => {
  assert.equal(connection_site('https://discussion.example:443/'), 'https://discussion.example');
  assert.equal(connection_site('http://127.0.0.1:8765'), 'http://127.0.0.1:8765');
  for (const site of ['http://discussion.example', 'https://name:secret@discussion.example', 'https://discussion.example/path',
    'https://discussion.example/?query=1', 'https://discussion.example/#fragment', 'file:///tmp']) {
    assert.throws(() => connection_site(site), /HTTPS 根地址/);
  }
});

test('local connect persists only the site-bound hash, rotates credentials and revokes without stopping the website', async () => {
  const reservation = await reserve_port();
  const port = reservation.address().port;
  await new Promise(done => reservation.close(done));
  const state = fixture(port);
  const site = 'https://discussion.example';
  try {
    assert.notEqual(state.execute(['local', 'connect', 'http://discussion.example', '--no-open']).status, 0);
    assert.equal(existsSync(join(state.home, 'local')), false);
    const connected = state.command(['local', 'connect', site, '--no-open']);
    const link = new URL(connected.url);
    assert.equal(link.origin, site);
    assert.equal(link.search, '');
    const connection = JSON.parse(new URLSearchParams(link.hash.slice(1)).get('codiscuss-connect'));
    const saved = readFileSync(join(state.home, 'site-connections.json'), 'utf8');
    assert.equal(saved.includes(connection.token), false);
    const headers = { Origin: site, 'X-CoDiscuss-Local': '1', 'X-CoDiscuss-Connection': connection.token };
    const get_settings = async current => {
      const response = await fetch(`${connected.local_url}/api/local/settings`, { headers: current });
      await response.json();
      return response.status;
    };
    assert.equal(await get_settings(headers), 200);
    state.command(['local', 'stop']);
    const reopened = state.command(['local', 'start']);
    assert.equal(await get_settings(headers), 200, 'connection survives an ordinary local restart');
    state.command(['local', 'connect', site, '--no-open']);
    assert.equal(await get_settings(headers), 403, 'old browser credential must stop working after reconnect');
    assert.equal(state.command(['local', 'disconnect', site]).disconnected, site);
    assert.equal(state.command(['local', 'status']).website_pid, reopened.website_pid);
    assert.equal(await get_settings(headers), 403);
    assert.deepEqual(JSON.parse(readFileSync(join(state.home, 'site-connections.json'))).sites, {});
  } finally {
    state.execute(['local', 'stop']);
    state.execute(['service', 'stop', '--json']);
    rmSync(state.home, { recursive: true, force: true });
  }
});

test('local lifecycle reuses processes and preserves data outside the package', async () => {
  const reservation = await reserve_port();
  const port = reservation.address().port;
  await new Promise(done => reservation.close(done));
  const state = fixture(port);
  try {
    const first = state.command(['local', 'start']);
    assert.equal(first.running, true);
    assert.equal(state.command(['local', 'start']).pid, first.pid);
    assert.equal((await fetch(`${first.url}/api/health`).then(value => value.json())).ok, true);
    const page = await fetch(first.url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /html/);
    const marker = spawnSync(state.python, ['-c',
      'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("CREATE TABLE install_marker(value TEXT)"); c.execute("INSERT INTO install_marker VALUES (\'kept\')"); c.commit()',
      first.database], { encoding: 'utf8', env: state.env });
    assert.equal(marker.status, 0, marker.stderr);
    const stopped = state.command(['local', 'stop']);
    assert.equal(stopped.running, false);
    const offline = state.command(['local', 'status']);
    assert.equal(offline.ready, false);
    assert.equal(offline.website_running, false);
    assert.equal(offline.website_pid, 0);
    assert.equal(state.command(['service', 'status', '--json']).running, false);
    const second = state.command(['local', 'start']);
    const data = spawnSync(state.python, ['-c',
      'import sqlite3,sys; print(sqlite3.connect(sys.argv[1]).execute("SELECT value FROM install_marker").fetchone()[0])', second.database],
    { encoding: 'utf8', env: state.env });
    assert.equal(data.stdout.trim(), 'kept');
    assert(existsSync(first.database));
  } finally {
    state.execute(['local', 'stop']);
    state.execute(['service', 'stop', '--json']);
    rmSync(state.home, { recursive: true, force: true });
  }
});

test('setup restarts a stale or moved website only after interactive confirmation', async () => {
  const reservation = await reserve_port();
  const port = reservation.address().port;
  await new Promise(done => reservation.close(done));
  const state = fixture(port);
  try {
    const first = state.command(['local', 'start']);
    const status_path = join(state.home, 'local', 'status.json');
    assert.equal(JSON.parse(readFileSync(status_path, 'utf8')).version, JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
    writeFileSync(status_path, JSON.stringify({ ...JSON.parse(readFileSync(status_path, 'utf8')), version: '0.0.1' }));
    for (const args of [[], ['--port', String(port + 1)]]) {
      const setup = state.execute(['setup', '--yes', '--clients', 'none', '--no-open', ...args]);
      assert.equal(setup.status, 2, setup.stderr);
      const receipt = JSON.parse(setup.stdout);
      assert.equal(receipt.status, 'needs_attention');
      assert(receipt.issues.some(issue => issue.includes(args.length ? '端口配置已改为' : '版本 0.0.1') && issue.includes('codiscuss local stop')));
      assert.equal(state.command(['local', 'status']).pid, first.pid);
    }
    const restart = spawnSync(process.execPath, ['--import', 'data:text/javascript,Object.defineProperty(process.stdin,"isTTY",{value:true})',
      CLI, 'setup', '--clients', 'none', '--no-open', '--port', String(port)], { cwd: state.home, env: state.env, input: '\n', encoding: 'utf8', timeout: 60000 });
    assert.notEqual(restart.status, 1, restart.stderr);
    const restarted = state.command(['local', 'status']);
    assert.equal(restarted.running, true);
    assert.notEqual(restarted.pid, first.pid);
    assert.notEqual(restarted.version, '0.0.1');
  } finally {
    state.execute(['local', 'stop']);
    state.execute(['service', 'stop', '--json']);
    rmSync(state.home, { recursive: true, force: true });
  }
});

test('local stop keeps a pre-existing service; occupied port cannot be mistaken for readiness', async () => {
  const reservation = await reserve_port();
  const port = reservation.address().port;
  const state = fixture(port);
  try {
    const occupied = state.execute(['local', 'start']);
    assert.equal(occupied.status, 1);
    assert.match(occupied.stderr, /启动失败|未在|未完成/);
    assert.equal(state.command(['service', 'status', '--json']).running, false);
    const setup = state.execute(['setup', '--yes', '--clients', 'none', '--no-open']);
    assert.equal(setup.status, 1, setup.stderr);
    const receipt = JSON.parse(setup.stdout);
    assert.equal(receipt.status, 'start_failed');
    assert(receipt.issues.some(issue => issue.includes('配置已保存')));
    assert(existsSync(join(state.home, 'local-settings.json')));
    await new Promise(done => reservation.close(done));
    const service = state.command(['service', 'start', '--json']);
    state.command(['local', 'start']);
    const stopped = state.execute(['local', 'stop']);
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.match(stopped.stderr, /独立讨论服务仍在运行/);
    assert.equal(JSON.parse(stopped.stdout).service_pid, service.pid);
    const retained = state.command(['service', 'status', '--json']);
    assert.equal(retained.pid, service.pid);
    assert.equal(retained.running, true);
  } finally {
    if (reservation.listening) await new Promise(done => reservation.close(done));
    state.execute(['local', 'stop']);
    state.execute(['service', 'stop', '--json']);
    rmSync(state.home, { recursive: true, force: true });
  }
});

for (const independent of [false, true]) test(`local restart ${independent ? 'preserves an independent replacement' : 'owns its replacement service'} without replacing the website`, async () => {
  const reservation = await reserve_port();
  const port = reservation.address().port;
  await new Promise(done => reservation.close(done));
  const state = fixture(port);
  try {
    const first = state.command(['local', 'start']);
    state.command(['service', 'stop', '--json']);
    const stopped = state.command(['local', 'status']);
    assert.equal(stopped.running, false);
    assert.equal(stopped.website_running, true);
    if (independent) state.command(['service', 'start', '--json']);
    const reopened = state.command(['local', 'start']);
    assert.equal(reopened.running, true);
    assert.equal(reopened.pid, first.pid);
    assert.equal(reopened.website_pid, first.website_pid);
    const service = state.command(['service', 'status', '--json']);
    assert.equal(service.running, true);
    assert.equal(service.pid, reopened.service_pid);
    // The OS may reuse a stopped process's PID; lifecycle records prove a replacement started.
    const service_log = readFileSync(join(state.home, 'service.log'), 'utf8');
    assert.equal((service_log.match(/讨论服务已启动 pid=/g) || []).length, 2);
    assert.equal((service_log.match(/讨论服务已停止/g) || []).length, 1);
    state.command(['local', 'stop']);
    assert.equal(state.command(['service', 'status', '--json']).running, independent);
  } finally {
    state.execute(['local', 'stop']);
    state.execute(['service', 'stop', '--json']);
    rmSync(state.home, { recursive: true, force: true });
  }
});

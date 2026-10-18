import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { detect_python } from '../runner/discussion_setup.mjs';

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
    assert.equal(state.command(['local', 'stop']).running, false);
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
    state.command(['local', 'stop']);
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
    assert.notEqual(service.pid, first.service_pid);
    state.command(['local', 'stop']);
    assert.equal(state.command(['service', 'status', '--json']).running, independent);
  } finally {
    state.execute(['local', 'stop']);
    state.execute(['service', 'stop', '--json']);
    rmSync(state.home, { recursive: true, force: true });
  }
});

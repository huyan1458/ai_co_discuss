import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { GIB, block_reason } from '../runner/storage_guard.mjs';
import { DiscussionService, register_room, sweep_service_home } from '../runner/discussion_service.mjs';

function service_home(t) {
  const home = mkdtempSync(join(tmpdir(), 'storage-service-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

test('a volume drop shares one early rescan; unverified growth holds dispatch but never stops active runs', async t => {
  let available = 40 * GIB, scans = 0, finish;
  const stopped = [];
  const service = new DiscussionService(service_home(t), undefined, undefined, {
    disk_free: () => ({ available_bytes: available, reserve_bytes: GIB }),
    measure: () => { scans++; return new Promise(resolve => { finish = resolve; }); },
    block_reason,
  });
  service.workers.set('r', { config: { draft_directory: 'r' }, runner: {
    children: new Set([1]), stop_for_storage: reason => stopped.push(reason),
  } });
  const snapshot = { total_bytes: 9 * GIB, rooms: {}, draft_bytes: 0, unreadable: 69 };
  service.monitor_storage(false, 0);
  finish(snapshot);
  await service.storage_scan;
  available -= GIB / 2;
  service.monitor_storage(false, 2000);
  assert.equal(scans, 1);
  available -= GIB / 2;
  service.monitor_storage(false, 4000);
  assert.equal(service.scan_storage(), service.storage_scan);
  service.monitor_storage(false, 6000);
  assert.equal(scans, 2);
  finish(snapshot);
  await service.storage_scan;
  assert.deepEqual(stopped, []);
  available -= GIB;
  service.monitor_storage(false, 8000);
  const increased = { ...snapshot, unreadable: 70 };
  finish(increased);
  await service.storage_scan;
  await Promise.all(service.storage_stops.values());
  assert.deepEqual(stopped, []);
  assert.match(block_reason(service.scan_storage(), 'r'), /70/);
  const regular_scan = service.scan_storage(true);
  finish(increased);
  await regular_scan;
  assert.equal(block_reason(service.scan_storage(), 'r'), '');
  available -= GIB;
  service.monitor_storage(false, 40000);
  finish({ ...snapshot, total_bytes: 11 * GIB });
  await service.storage_scan;
  await Promise.all(service.storage_stops.values());
  assert.equal(stopped.length, 1);
});

test('an exhausted budget does not start periodic full scans', async () => {
  for (const total_bytes of [10 * GIB, 11 * GIB]) {
    let available = 40 * GIB, scans = 0;
    const service = new DiscussionService('unused', undefined, undefined, {
      disk_free: () => ({ available_bytes: available, reserve_bytes: GIB }),
      measure: async () => { scans++; return { total_bytes, rooms: {}, unreadable: 0 }; },
      block_reason,
    });
    service.workers.set('r', { config: { draft_directory: 'r' }, runner: {
      children: new Set([1]), stop_for_storage() {},
    } });
    for (const now of [0, 2000, 28000, 30000]) {
      available -= GIB;
      service.monitor_storage(false, now);
      await service.storage_scan;
      assert.equal(scans, 1);
    }
  }
});

test('80 percent blocks only new unstoppable runs in the affected room', () => {
  const snapshot = { rooms: { a: 80, b: 79 } };
  const options = { room_limit: 100, stoppable: false };
  assert.match(block_reason(snapshot, 'a', null, options), /80%/);
  assert.equal(block_reason(snapshot, 'b', null, options), '');
  assert.equal(block_reason(snapshot, 'a', null, { ...options, stoppable: true }), '');
  assert.equal(block_reason(snapshot, 'a', null, { room_limit: 100 }), '');
});

test('disk pressure reaches both rooms during a shared pending quota scan', async t => {
  const home = service_home(t);
  const service = new DiscussionService(home);
  let scans = 0, checks = 0, finish;
  const calls = [];
  for (const room of ['a', 'b']) {
    service.workers.set(room, { config: { draft_directory: join(home, room) },
      runner: { children: new Set([1]), stop_for_storage: reason => calls.push([room, reason]) } });
  }
  const guard = {
    measure: () => { scans++; return new Promise(resolve => { finish = resolve; }); },
    disk_free: () => ({ available_bytes: ++checks === 1 ? 10 : 0, reserve_bytes: 2 }),
    block_reason: (_, room, disk) => disk.available_bytes < disk.reserve_bytes ? 'low disk' : '',
  };
  service.guard = guard;
  for (const now of [0, 1000, 2000]) service.monitor_storage(false, now);
  await Promise.all(service.storage_stops.values());
  assert.deepEqual(calls, [['a', 'low disk'], ['b', 'low disk']]);
  assert.equal(checks, 2);
  assert.equal(scans, 1);
  finish({ total_bytes: 9 * 1024 ** 3, draft_bytes: 0, rooms: {} });
  await service.storage_scan;
  service.write_status();
  assert.equal(JSON.parse(readFileSync(join(home, 'status.json'))).storage.warning, true);
});

test('maintenance keeps the last 16 MiB and reports an unreadable config', t => {
  const home = service_home(t);
  const directory = join(home, 'runtime');
  mkdirSync(directory);
  const config = join(home, 'config.json');
  writeFileSync(config, JSON.stringify({ room: 'room', site: 'http://localhost:1', token: 'x'.repeat(32),
    data_directory: directory, participants: { member: { adapter: 'antigravity', ipc_directory: directory } }, members: { member: { token: 'm'.repeat(32) } } }));
  register_room(home, config);
  const log = join(directory, 'claude-free-7.log');
  const tail = Buffer.alloc(16 * 1024 ** 2, 55);
  writeFileSync(log, Buffer.concat([Buffer.from('drop'), tail]));
  assert.deepEqual(sweep_service_home(home).logs, [log]);
  assert.deepEqual(readFileSync(log), tail);
  writeFileSync(config, '{');
  const errors = [];
  assert.equal(sweep_service_home(home, Date.now(), message => errors.push(message)).failures, 1);
  assert.ok(errors[0].includes(config));
});

test('an explicit maintenance sample stops and reclaims only the room under pressure', async () => {
  const stopped = [], reclaimed = [];
  let scans = 0;
  const guard = {
    measure: async () => ({ total_bytes: 0, draft_bytes: 0, rooms: { a: ++scans === 1 ? 0 : 2 ** 31 } }),
    disk_free: () => ({ available_bytes: 10, reserve_bytes: 2 }),
    block_reason: (snapshot, room) => snapshot?.rooms[room] > 2 ** 30 ? room : '',
  };
  const service = new DiscussionService('unused', undefined, undefined, guard);
  for (const room of ['a', 'b']) {
    service.workers.set(room, { config: { draft_directory: room }, runner: {
      inbox: { executions: [{}] }, stop_for_storage: reason => stopped.push(reason),
      reclaim_failed_scratch: () => reclaimed.push(room),
    } });
  }
  for (const now of [0, 29999, 30000]) {
    service.monitor_storage(now === 30000, now);
    await service.storage_scan;
    await Promise.all(service.storage_stops.values());
  }
  assert.equal(scans, 2);
  assert.deepEqual(stopped, ['a']);
  assert.deepEqual(reclaimed, ['a']);
});

test('storage_reason wraps unexpected measurement failures in a localized message', async t => {
  const home = service_home(t);
  const service = new DiscussionService(home);
  service.guard = {
    ...service.guard,
    measure: async () => { throw new Error('EACCES: simulated stat failure'); },
  };
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const runner = service.create_runner(
    { room: 'r1', site: 'http://127.0.0.1:8765', token: 't'.repeat(32), directory: join(home, 'runtime'), draft_directory: join(home, 'drafts', 'r1'), participants: {}, members: {} },
    { db },
    () => {},
  );
  const captured = await runner.storage_reason();
  assert.match(captured, /无法检查本机存储与磁盘空间|Could not check local storage or disk space/);
  assert.match(captured, /simulated stat failure/);
});

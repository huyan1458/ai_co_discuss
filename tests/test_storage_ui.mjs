import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  find_room_storage,
  format_storage_bytes,
  normalize_storage_snapshot,
  storage_ratio,
  storage_tone,
} from '../frontend/storage-format.js';
import { member_runtime } from '../runner/free_runner.mjs';
import { sweep_service_home } from '../runner/discussion_service.mjs';
import { DatabaseSync } from 'node:sqlite';
import { panel_clean, panel_repair, panel_storage } from '../runner/admin_maintenance.mjs';
import { storage_details } from '../runner/admin_storage.mjs';
import { GIB, MIB } from '../runner/storage_guard.mjs';

test('normalize_storage_snapshot aligns directly with runner/admin_storage.mjs storage_details()', async t => {
  const home = mkdtempSync(join(tmpdir(), 'codiscuss-storage-ui-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, 'drafts', 'room-hash-1', 'member-a'), { recursive: true });
  mkdirSync(join(home, 'local'), { recursive: true });
  mkdirSync(join(home, 'yovoice', 'data'), { recursive: true });
  writeFileSync(join(home, 'drafts', 'room-hash-1', 'member-a', 'note.md'), Buffer.alloc(4096));
  writeFileSync(join(home, 'local', 'discuss.sqlite3'), Buffer.alloc(2048));
  writeFileSync(join(home, 'yovoice', 'data', 'model.bin'), Buffer.alloc(8192));

  const raw = await storage_details(home);
  const { groups } = await panel_storage(home, "http://127.0.0.1:8765");
  assert.equal(Object.values(groups).reduce((sum, bytes) => sum + bytes, 0), raw.total_bytes);
  const snap = normalize_storage_snapshot(raw);

  assert.equal(snap.total_bytes, 6144);
  assert.equal(snap.draft_bytes, 4096);
  assert.equal(snap.local_bytes, 2048);
  assert.equal(snap.models.total_bytes, 8192);
  assert.ok(snap.models.entries.some(item => item.name === 'yovoice' && item.bytes === 8192));
  assert.equal(snap.limits.home_limit_bytes, 10 * GIB);
  assert.equal(snap.limits.home_warn_bytes, 8 * GIB);
  assert.equal(snap.limits.draft_bytes, 3 * GIB);
  assert.equal(snap.limits.room_draft_bytes, 1 * GIB);
  assert.equal(snap.limits.warn_ratio, 0.8);
  assert.equal(snap.limits.max_scan_files, 200_000);
  assert.ok(snap.disk && snap.disk.available_bytes >= 0);

  const room = find_room_storage(snap, '', 'room-hash-1');
  assert.ok(room);
  assert.equal(room.bytes, 4096);
  assert.equal(room.members[0].bytes, 4096);
});

test('manual cleanup checks the end time and retains outstanding local deliveries', async t => {
  const home = mkdtempSync(join(tmpdir(), 'storage-clean-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = join(home, 'launches', 'room', 'runtime'), site = 'http://127.0.0.1:8765';
  mkdirSync(root, { recursive: true });
  mkdirSync(join(home, 'local'));
  const config = join(root, '..', 'config.json');
  writeFileSync(config, JSON.stringify({ room: 'r', site, data_directory: root }));
  writeFileSync(join(home, 'rooms.json'), JSON.stringify({ configs: [config] }));
  const db = new DatabaseSync(join(home, 'local', 'discuss.sqlite3'));
  db.exec("CREATE TABLE member_executions(id,room_id,status,finished_at); INSERT INTO member_executions VALUES (1,'r','started',0),(2,'r','completed',unixepoch()),(3,'r','completed',1),(4,'r','failed',1)");
  db.close();
  const runtime = new DatabaseSync(join(root, 'runtime.sqlite3'));
  runtime.exec('CREATE TABLE metadata(key,value); CREATE TABLE free_deliveries(execution_id); INSERT INTO free_deliveries VALUES(4)');
  runtime.close();
  const logs = [1, 2, 3, 4].map(id => join(root, 'codex_cli-free-' + id + '.log'));
  for (const log of logs) writeFileSync(log, '123');
  assert.equal((await panel_clean(home, site)).freed_bytes, 3);
  assert.deepEqual(logs.map(path => existsSync(path)), [true, true, false, true]);
  assert.equal(panel_repair(home, site, {}).freed_bytes, 3);
  assert.ok(existsSync(logs[1]));
  panel_repair(home, site, { logs: true, confirm: true });
  assert.deepEqual(logs.map(path => existsSync(path)), [true, false, false, true]);
});

test('manual and weekly cleanup retain original files through follow-ups and idle schedule intervals', async t => {
  const home = mkdtempSync(join(tmpdir(), 'continued-storage-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const directory = join(home, 'runtime'), site = 'http://127.0.0.1:8765', room = 'r';
  const config = { directory, data_directory: directory, room, site, token: 'x'.repeat(32),
    participants: { Agent: { adapter: 'antigravity', ipc_directory: directory } }, members: { Agent: { token: 'm'.repeat(32) } } };
  mkdirSync(join(home, 'local'));
  const member = member_runtime(config, 'Agent');
  const other = member_runtime(config, 'Other');
  writeFileSync(join(home, 'config.json'), JSON.stringify(config));
  writeFileSync(join(home, 'rooms.json'), JSON.stringify({ configs: [join(home, 'config.json')] }));
  const db = new DatabaseSync(join(home, 'local', 'discuss.sqlite3'));
  db.exec("CREATE TABLE member_executions(id,room_id,status,finished_at); CREATE TABLE execution_followups(execution_id,source_id); CREATE TABLE execution_schedules(execution_id,source_id)");
  for (const id of [1,2,3,4,5,6,7,8]) db.prepare('INSERT INTO member_executions VALUES(?,?,?,?)').run(id, room, id === 3 ? 'started' : 'completed', 1);
  db.exec('INSERT INTO execution_schedules VALUES(2,1); INSERT INTO execution_followups VALUES(3,2)');
  db.close();
  const runtime = new DatabaseSync(join(directory, 'runtime.sqlite3'));
  runtime.exec("CREATE TABLE metadata(key,value); CREATE TABLE free_deliveries(member,status,execution_id); INSERT INTO free_deliveries VALUES('Agent','running',3)");
  runtime.prepare('INSERT INTO metadata VALUES(?,?)').run('lingering:123', JSON.stringify({ execution_id: 4 }));
  runtime.prepare('INSERT INTO metadata VALUES(?,?)').run('schedule-listener:5', 'instance');
  runtime.close();
  const keep = [join(directory,'claude-free-1.log'), join(other,'free-1.task.json'), join(other,'free-1.access.json'),
    join(directory,'claude-free-4.log'), join(other,'free-5.access.json'), join(member,'free-6.task.json')];
  const expired = join(directory, 'claude-free-7.log');
  for (const path of [...keep, expired]) writeFileSync(path, 'x');
  assert.equal(panel_repair(home, site, { logs: true, confirm: true }).freed_bytes, 1);
  writeFileSync(expired, 'x');
  assert.equal((await panel_clean(home, site)).freed_bytes, 1);
  writeFileSync(expired, 'x');
  const swept = sweep_service_home(home, Date.now() + 8 * 86400000);
  assert.equal(swept.failures, 0);
  assert.ok(!existsSync(expired));
  for (const path of keep) assert.ok(existsSync(path), path);
});

test('storage_tone and 8 GiB / 80% / 100% thresholds trigger warning and error states accurately', () => {
  assert.equal(storage_tone(799 * MIB, 1 * GIB, 0.8), 'normal');
  assert.equal(storage_tone(820 * MIB, 1 * GIB, 0.8), 'warning');
  assert.equal(storage_tone(1.05 * GIB, 1 * GIB, 0.8), 'error');
  assert.equal(storage_ratio(512 * MIB, 1 * GIB), 0.5);
  assert.equal(storage_ratio(2 * GIB, 1 * GIB), 1);
  assert.equal(format_storage_bytes(1.5 * GIB), '1.5 GiB');
  assert.equal(format_storage_bytes(10 * GIB), '10 GiB');

  const warned = normalize_storage_snapshot({
    total_bytes: 8.2 * GIB,
    draft_bytes: 900 * MIB,
    rooms: [{ key: 'k1', room_id: 'r1', bytes: 900 * MIB, members: [] }],
    models: [],
    model_bytes: 0,
    limits: { home_bytes: 10 * GIB, warn_bytes: 8 * GIB, draft_bytes: 3 * GIB, room_bytes: 1 * GIB, pressure_ratio: 0.8 },
  });
  assert.equal(warned.warning, true);
  assert.equal(warned.over_limit, false);
  const found = find_room_storage(warned, 'r1');
  assert.equal(found.bytes, 900 * MIB);
  assert.equal(storage_tone(found.bytes, warned.limits.room_draft_bytes, warned.limits.warn_ratio), 'warning');
});

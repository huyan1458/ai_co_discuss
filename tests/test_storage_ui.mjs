import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

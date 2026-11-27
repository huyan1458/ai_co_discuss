import assert from 'node:assert/strict';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import english from '../runner/i18n_en.mjs';
import {
  block_reason,
  disk_free,
  storage_disk,
  DISK_RESERVE_MAX,
  DISK_RESERVE_MIN,
  DRAFT_LIMIT,
  format_bytes,
  GIB,
  HOME_LIMIT,
  HOME_WARN,
  LOG_TAIL,
  MAX_SCAN_FILES,
  measure,
  MIB,
  MODEL_DIRS,
  ROOM_DRAFT_LIMIT,
  storage_error_reason,
  warn_reason,
} from '../runner/storage_guard.mjs';

function make_home(t) {
  const root = mkdtempSync(join(tmpdir(), 'codiscuss-storage-guard-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('default storage constants match the approved 8/10 GiB, 3 GiB, 1 GiB, 16 MiB and 200k limits', () => {
  assert.equal(ROOM_DRAFT_LIMIT, 1 * GIB);
  assert.equal(DRAFT_LIMIT, 3 * GIB);
  assert.equal(HOME_WARN, 8 * GIB);
  assert.equal(HOME_LIMIT, 10 * GIB);
  assert.equal(LOG_TAIL, 16 * MIB);
  assert.equal(DISK_RESERVE_MIN, 10 * GIB);
  assert.equal(DISK_RESERVE_MAX, 30 * GIB);
  assert.equal(MAX_SCAN_FILES, 200_000);
  assert.deepEqual(MODEL_DIRS, ['yovoice', 'crispasr']);
});

test('measure sums drafts, local records and home total while excluding legacy and configured speech model directories', async t => {
  const home = make_home(t);
  const custom_models = join(home, 'custom-models');
  mkdirSync(join(home, 'drafts', 'room-a', 'member-1'), { recursive: true });
  mkdirSync(join(home, 'drafts', 'room-b', '.scratch', '42'), { recursive: true });
  mkdirSync(join(home, 'local', 'discuss.sqlite3.attachments'), { recursive: true });
  mkdirSync(join(home, 'yovoice', 'data'), { recursive: true });
  mkdirSync(join(custom_models, 'crispasr', 'models'), { recursive: true });

  writeFileSync(join(home, 'drafts', 'room-a', 'member-1', 'answer.md'), Buffer.alloc(1000));
  writeFileSync(join(home, 'drafts', 'room-b', '.scratch', '42', 'tmp.bin'), Buffer.alloc(2500));
  writeFileSync(join(home, 'drafts', 'stray.txt'), Buffer.alloc(300));
  writeFileSync(join(home, 'local', 'discuss.sqlite3'), Buffer.alloc(4000));
  writeFileSync(join(home, 'local', 'discuss.sqlite3.attachments', 'a.bin'), Buffer.alloc(1500));
  // Legacy top-level yovoice AND nested custom crispasr configured via crispasr-root.txt must both be excluded (N5).
  writeFileSync(join(home, 'yovoice', 'data', 'model.bin'), Buffer.alloc(50_000));
  writeFileSync(join(home, 'crispasr-root.txt'), `${custom_models}\n`, 'utf8');
  writeFileSync(join(custom_models, 'crispasr', 'models', 'asr.gguf'), Buffer.alloc(40_000));

  const root_txt_size = readFileSync(join(home, 'crispasr-root.txt')).length;
  const snapshot = await measure(home);
  assert.equal(snapshot.draft_bytes, 3800);
  assert.equal(snapshot.local_bytes, 5500);
  assert.equal(snapshot.total_bytes, 3800 + 5500 + root_txt_size);
  assert.deepEqual(snapshot.rooms, { 'room-a': 1000, 'room-b': 2500 });
  assert.equal(snapshot.unreadable, 0);
  assert.equal(snapshot.truncated, false);
});

test('measure resolves a junctioned/symlinked service root while still skipping nested links (N2)', async t => {
  const real_home = make_home(t);
  const link_parent = make_home(t);
  const outside = make_home(t);
  const linked_home = join(link_parent, '.codiscuss');

  mkdirSync(join(real_home, 'drafts', 'room-a'), { recursive: true });
  mkdirSync(join(real_home, 'local'), { recursive: true });
  writeFileSync(join(real_home, 'drafts', 'room-a', 'file.bin'), Buffer.alloc(2048));
  writeFileSync(join(real_home, 'local', 'discuss.sqlite3'), Buffer.alloc(1024));
  writeFileSync(join(outside, 'escape.bin'), Buffer.alloc(99_999));

  try {
    symlinkSync(real_home, linked_home, process.platform === 'win32' ? 'junction' : 'dir');
    symlinkSync(outside, join(real_home, 'drafts', 'room-a', 'escape-link'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    return t.skip('directory links unavailable in this environment');
  }

  const scratch_entry = { bytes: 0 };
  const scratch = new Map([[join(linked_home, 'drafts', 'room-a'), scratch_entry]]);
  const snapshot = await measure(linked_home, { scratch });
  assert.equal(snapshot.rooms['room-a'], 2048);
  assert.equal(snapshot.draft_bytes, 2048);
  assert.equal(snapshot.local_bytes, 1024);
  assert.equal(snapshot.total_bytes, 3072);
  assert.equal(scratch_entry.bytes, 2048);
  assert.equal(snapshot.truncated, false);
});

test('measure skips symlinks and junctions and deduplicates hard links', async t => {
  const home = make_home(t);
  const outside = make_home(t);
  mkdirSync(join(home, 'drafts', 'room-a'), { recursive: true });
  writeFileSync(join(outside, 'huge.bin'), Buffer.alloc(10_000));
  const original = join(home, 'drafts', 'room-a', 'data.bin');
  writeFileSync(original, Buffer.alloc(1200));

  let linked = false;
  try {
    linkSync(original, join(home, 'drafts', 'room-a', 'data-hardlink.bin'));
    linked = true;
  } catch { /* Filesystem without hard links. */ }

  try {
    symlinkSync(outside, join(home, 'drafts', 'room-a', 'escape-link'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch { /* Symlinks unavailable in this environment. */ }

  const snapshot = await measure(home);
  assert.equal(snapshot.rooms['room-a'], 1200, linked ? 'hard link should not double-count' : 'single file size');
  assert.equal(snapshot.draft_bytes, 1200);
  assert.equal(snapshot.total_bytes, 1200);
  assert.equal(snapshot.truncated, false);
});

test('measure sets truncated when file count exceeds max_files and handles missing home', async t => {
  const missing = await measure(join(tmpdir(), `codiscuss-missing-${Date.now()}`));
  assert.deepEqual(missing, { total_bytes: 0, draft_bytes: 0, local_bytes: 0, rooms: {}, unreadable: 0, truncated: false });

  const home = make_home(t);
  mkdirSync(join(home, 'drafts', 'room-x'), { recursive: true });
  for (let i = 0; i < 6; i += 1) writeFileSync(join(home, 'drafts', 'room-x', `f-${i}.txt`), 'abcd');

  const ok = await measure(home, { max_files: 6 });
  assert.equal(ok.truncated, false);
  assert.equal(ok.draft_bytes, 24);

  const cut = await measure(home, { max_files: 5 });
  assert.equal(cut.truncated, true);
  assert.equal(cut.rooms['room-x'], 20);
});

test('measure counts unreadable entries without throwing and ignores vanished ENOENT entries', async t => {
  const home = make_home(t);
  const locked_dir = join(home, 'drafts', 'room-locked', 'denied');
  const ok_dir = join(home, 'drafts', 'room-ok');
  const blocked_file = join(ok_dir, 'locked.bin');
  const vanished_file = join(ok_dir, 'vanished.bin');
  const good_file = join(ok_dir, 'good.bin');
  mkdirSync(locked_dir, { recursive: true });
  mkdirSync(ok_dir, { recursive: true });
  writeFileSync(blocked_file, Buffer.alloc(100));
  writeFileSync(vanished_file, Buffer.alloc(100));
  writeFileSync(good_file, Buffer.alloc(500));

  const snapshot = await measure(home, {
    readdir: async (target, opts) => {
      if (resolve(target) === resolve(locked_dir)) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return readdir(target, opts);
    },
    lstat: async (target, opts) => {
      if (resolve(target) === resolve(blocked_file)) throw Object.assign(new Error('denied'), { code: 'EPERM' });
      if (resolve(target) === resolve(vanished_file)) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      return lstat(target, opts);
    },
  });
  assert.equal(snapshot.unreadable, 2);
  assert.equal(snapshot.rooms['room-ok'], 500);
  assert.equal(snapshot.draft_bytes, 500);
  assert.equal(snapshot.total_bytes, 500);
});

test('split hosted drafts are counted per room while projects stay outside the budget', async t => {
  const root = mkdtempSync(join(tmpdir(), 'split-drafts-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'service'), data = join(root, 'data'), drafts = join(data, 'drafts');
  mkdirSync(join(drafts, 'room', 'member'), { recursive: true });
  mkdirSync(home);
  mkdirSync(join(data, 'projects'));
  writeFileSync(join(home, 'config'), 'abc');
  writeFileSync(join(data, 'projects', 'asset'), '123456789');
  writeFileSync(join(drafts, 'room', 'member', 'file'), '1234');
  const usage = await measure(home, { drafts_root: drafts, members: true });
  assert.equal(usage.total_bytes, 7);
  assert.equal(usage.draft_bytes, 4);
  assert.equal(usage.members.room.member, 4);
  const check = path => ({ available_bytes: path === home ? 100 : 5, reserve_bytes: 10 });
  const disk = storage_disk(home, drafts, check, path => path === home ? 1 : 2);
  assert.deepEqual(disk.volumes, [100, 5]);
  assert.ok(block_reason(usage, 'room', disk));
  assert.deepEqual(storage_disk(home, drafts, check, () => 1), check(home));
});

test('disk_free computes min(max(10 GiB, 5%), 30 GiB) and walks up missing paths', () => {
  const block = 4096;
  const mock = (total_gib, avail_gib) => () => ({
    bsize: block,
    blocks: Math.round((total_gib * GIB) / block),
    bavail: Math.round((avail_gib * GIB) / block),
  });

  const small = disk_free('/fake/small', { statfs: mock(100, 12) });
  assert.equal(small.reserve_bytes, 10 * GIB);
  assert.equal(small.available_bytes, 12 * GIB);

  const medium = disk_free('/fake/medium', { statfs: mock(400, 15) });
  assert.equal(medium.reserve_bytes, 20 * GIB);
  assert.equal(medium.available_bytes, 15 * GIB);

  const large = disk_free('/fake/large', { statfs: mock(1000, 40) });
  assert.equal(large.reserve_bytes, 30 * GIB);
  assert.equal(large.available_bytes, 40 * GIB);

  const real = disk_free(join(tmpdir(), 'codiscuss-nonexistent-subdir-check', 'leaf'));
  assert.ok(real.available_bytes >= 0);
  assert.ok(real.reserve_bytes >= DISK_RESERVE_MIN && real.reserve_bytes <= DISK_RESERVE_MAX);
});

test('block_reason, warn_reason and storage_error_reason guide users to cleanup and explain the limit', () => {
  const safe_disk = { available_bytes: 50 * GIB, reserve_bytes: 20 * GIB };
  const low_disk = { available_bytes: 8.5 * GIB, reserve_bytes: 10 * GIB };
  const ok_snap = { total_bytes: 5 * GIB, draft_bytes: 512 * MIB, local_bytes: 2.5 * GIB, rooms: { r1: 512 * MIB }, unreadable: 0, truncated: false };

  assert.equal(block_reason(ok_snap, 'r1', safe_disk, { locale: 'zh-CN' }), '');
  assert.equal(warn_reason(ok_snap, { locale: 'zh-CN' }), '');

  // 1. Disk safety reserve breached (highest priority).
  const disk_msg = block_reason(ok_snap, 'r1', low_disk, { locale: 'zh-CN' });
  assert.match(disk_msg, /8\.5 GiB/);
  assert.match(disk_msg, /10 GiB/);
  assert.match(disk_msg, /管理面板“存储”/);

  // 2. Truncated scan (> 200k files).
  const trunc_msg = block_reason({ ...ok_snap, truncated: true }, 'r1', safe_disk, { locale: 'zh-CN' });
  assert.match(trunc_msg, /200000/);
  assert.match(trunc_msg, /管理面板“存储”/);

  // 3. Room draft limit (> 1 GiB) blocks only that room when total drafts stay under 3 GiB.
  const room_snap = { ...ok_snap, rooms: { r1: 1.25 * GIB, r2: 200 * MIB }, draft_bytes: 1.45 * GIB };
  const room_msg = block_reason(room_snap, 'r1', safe_disk, { locale: 'zh-CN' });
  assert.match(room_msg, /1\.25 GiB/);
  assert.match(room_msg, /1 GiB/);
  assert.match(room_msg, /drafts\/r1/);
  assert.match(room_msg, /管理面板“存储”/);
  assert.equal(block_reason(room_snap, 'r2', safe_disk, { locale: 'zh-CN' }), '');

  // 4. Total draft limit (> 3 GiB).
  const draft_msg = block_reason({ ...ok_snap, rooms: { r1: 200 * MIB, r2: 3.1 * GIB }, draft_bytes: 3.3 * GIB }, 'r1', safe_disk, { locale: 'zh-CN' });
  assert.match(draft_msg, /3\.3 GiB/);
  assert.match(draft_msg, /3 GiB/);
  assert.match(draft_msg, /管理面板“存储”/);

  // 5. Total home limit (> 10 GiB) calls out room records/attachments (N3) and never auto-deletes them.
  const home_msg = block_reason({ ...ok_snap, total_bytes: 10.5 * GIB, local_bytes: 9.2 * GIB }, 'r1', safe_disk, { locale: 'zh-CN' });
  assert.match(home_msg, /10\.5 GiB/);
  assert.match(home_msg, /9\.2 GiB/);
  assert.match(home_msg, /10 GiB/);
  assert.match(home_msg, /不会自动删除/);
  assert.match(home_msg, /销毁/);

  // 6. 8 GiB warning includes unreadable count when > 0 (N1).
  const warn_snap = { ...ok_snap, total_bytes: 8.5 * GIB, unreadable: 12 };
  assert.equal(block_reason(warn_snap, 'r1', safe_disk, { locale: 'zh-CN' }), '');
  const warn_msg = warn_reason(warn_snap, { locale: 'zh-CN' });
  assert.match(warn_msg, /8\.5 GiB/);
  assert.match(warn_msg, /12 处/);
  assert.match(warn_msg, /管理面板“存储”/);

  // 7. Measurement error wrapper (N4) in both Chinese and English.
  const err_zh = storage_error_reason(new Error('EPERM'), { locale: 'zh-CN' });
  assert.match(err_zh, /无法检查本机存储与磁盘空间/);
  assert.match(err_zh, /EPERM/);
  const err_en = storage_error_reason(new Error('EPERM'), { locale: 'en' });
  assert.match(err_en, /Could not check local storage or disk space/);
  assert.match(err_en, /EPERM/);

  // English translations work cleanly.
  const en_msg = block_reason(ok_snap, 'r1', low_disk, { locale: 'en' });
  assert.match(en_msg, /Only 8\.5 GiB/);
  assert.match(en_msg, /Storage tab/);
  assert.equal(format_bytes(0), '0 B');
});

test('every t() literal in runner/storage_guard.mjs has an English translation in runner/i18n_en.mjs', () => {
  const source = readFileSync(new URL('../runner/storage_guard.mjs', import.meta.url), 'utf8');
  const keys = [...source.matchAll(/(?<![\w.$])t\(\s*(['"])((?:\\.|(?!\1)[^\\])*)\1/g)].map(match => match[2]);
  assert.ok(keys.length >= 8, 'expected storage_guard translations');
  for (const key of keys) {
    assert.equal(typeof english[key], 'string', `missing English translation for: ${key}`);
    assert.ok(english[key].length > 0, `empty English translation for: ${key}`);
  }
});

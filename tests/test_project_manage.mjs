/** The file page's changes to project folders stay inside the chosen root, keep what they replace, and refuse stale saves. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { project_zip } from '../runner/project_files.mjs';
import { zip_store } from '../frontend/workflow-files.js';
import { delete_entry, make_folder, paste_entry, read_text, RecycleArea, rename_entry, save_text, TRASH_KEEP_MS, upload_part } from '../runner/project_manage.mjs';

function fixture(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'codiscuss-manage-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'projects', '作品');
  const other = join(base, 'workspace', '草稿-1');
  mkdirSync(root, { recursive: true });
  mkdirSync(other, { recursive: true });
  writeFileSync(join(base, 'secret.txt'), 'outside');
  return { base, root, other, recycle: new RecycleArea(join(base, 'trash')), parts: join(base, 'service', 'file-uploads') };
}

test('project ZIP lists GBK and UTF-8 names and reads only the bounded selected entry in parts', t => {
  const f = fixture(t), path = 'fixture.zip', archive = join(f.root, path);
  const query = (op, parameters = {}) => project_zip(f.root, { path, op, ...parameters }, true);
  // A standard deflated archive with the unflagged GBK filename 中文.md.
  const gbk = Buffer.from('UEsDBBQAAAAIAAAAIQC2a6WWDgAAAAwAAAAHAAAA1tDOxC5tZCsoSi3LTC1XKEmtKAEAUEsBAhQAFAAAAAgAAAAhALZrpZYOAAAADAAAAAcAAAAAAAAAAAAAAIABAAAAANbQzsQubWRQSwUGAAAAAAEAAQA1AAAAMwAAAAAA', 'base64');
  writeFileSync(archive, gbk);
  assert.deepEqual(query('zip-list').entries.map(item => item.path), ['中文.md']);
  assert.equal(Buffer.from(query('zip-entry', { entry_path: '中文.md' }).data, 'base64').toString(), 'preview text');
  const name = '资料/样本.txt', text = 'A'.repeat(200 * 1024);
  writeFileSync(archive, zip_store({ [name]: text, '__MACOSX/._data': '', '.DS_Store': '', '../outside': '' }));
  assert.deepEqual(query('zip-list').entries.map(item => item.path), [name]);
  const first = query('zip-entry', { entry_path: name }), second = query('zip-entry', { entry_path: name, offset: 192 * 1024 });
  assert.equal(first.version, second.version);
  assert.equal(first.total, text.length);
  assert.equal(Buffer.from(second.data, 'base64').length, 8 * 1024);
  assert.throws(() => query('zip-entry', { entry_path: '../outside' }));
  assert.throws(() => query('zip-entry', { entry_path: name, offset: text.length + 1 }));
  assert.throws(() => query('zip-list', { path: '../fixture.zip' }));
  // Exercise the pre-decompression size check using just the directory metadata.
  gbk.writeUInt32LE(64 * 1024 * 1024 + 1, gbk.indexOf(Buffer.from([80, 75, 1, 2])) + 24);
  writeFileSync(archive, gbk);
  assert.throws(() => query('zip-entry', { entry_path: '中文.md' }), /64 MiB/);
});

test('changes stay inside the root and never touch the root folder itself', t => {
  const f = fixture(t);
  assert.throws(() => make_folder(f.root, '../', '外面'), /相对路径/);
  assert.throws(() => make_folder(f.root, '', 'a/b'), /名称须为/);
  assert.throws(() => make_folder(f.root, '', 'con'), /名称须为/);
  assert.throws(() => rename_entry(f.root, '', '新名字'), /本身不能/);
  assert.throws(() => delete_entry(f.root, '', f.recycle), /本身不能/);
  assert.throws(() => delete_entry(f.root, '../../secret.txt', f.recycle), /相对路径/);
  make_folder(f.root, '', '章节');
  assert.throws(() => make_folder(f.root, '', '章节'), /已存在/);
  writeFileSync(join(f.root, '章节', '一.md'), '第一章');
  assert.deepEqual(rename_entry(f.root, '章节/一.md', '第一章.md'), { path: '章节/第一章.md' });
  assert.throws(() => paste_entry({ source_root: f.root, source_path: '章节', root: f.root, path: '章节', mode: 'move', recycle: f.recycle }), /自己/);
});

test('links are not changed, so a change cannot reach what a link points to', t => {
  const f = fixture(t);
  try { symlinkSync(f.base, join(f.root, '链接'), 'junction'); } catch { t.skip('cannot create links here'); return; }
  assert.throws(() => delete_entry(f.root, '链接', f.recycle), /链接/);
  assert.throws(() => rename_entry(f.root, '链接', '别名'), /链接/);
  assert.ok(existsSync(join(f.base, 'secret.txt')));
});

test('deleted and replaced files go to the recycle area and come back where they were', t => {
  const f = fixture(t);
  writeFileSync(join(f.root, '大纲.md'), '旧大纲');
  delete_entry(f.root, '大纲.md', f.recycle);
  assert.ok(!existsSync(join(f.root, '大纲.md')));
  const [kept] = f.recycle.list();
  assert.deepEqual([kept.name, kept.path, kept.root_name, kept.size], ['大纲.md', '大纲.md', '作品', 9]);
  writeFileSync(join(f.root, '大纲.md'), '新大纲');
  // The name was taken meanwhile: the restored file gets a free one, and only a root the caller may use is accepted.
  assert.throws(() => f.recycle.restore(kept.id, () => false), /无法还原/);
  assert.deepEqual(f.recycle.restore(kept.id, () => true), { path: '大纲 (1).md', root_name: '作品' });
  assert.equal(readFileSync(join(f.root, '大纲 (1).md'), 'utf8'), '旧大纲');
  assert.deepEqual(f.recycle.list(), []);
  // Items past the keeping period are dropped.
  delete_entry(f.root, '大纲 (1).md', f.recycle);
  f.recycle.purge(Date.now() + TRASH_KEEP_MS + 1000);
  assert.deepEqual(f.recycle.list(), []);
});

test('pasting into another root asks about a taken name, then replaces (keeping the old one) or keeps both', t => {
  const f = fixture(t);
  writeFileSync(join(f.other, '资料.txt'), '新资料');
  writeFileSync(join(f.root, '资料.txt'), '旧资料');
  const paste = conflict => paste_entry({ source_root: f.other, source_path: '资料.txt', root: f.root, path: '', mode: 'copy', conflict, recycle: f.recycle });
  assert.deepEqual(paste(undefined), { conflict: true, name: '资料.txt' });
  assert.deepEqual(paste('keep_both'), { path: '资料 (1).txt' });
  assert.deepEqual(paste('replace'), { path: '资料.txt' });
  assert.equal(readFileSync(join(f.root, '资料.txt'), 'utf8'), '新资料');
  assert.deepEqual(f.recycle.list().map(item => item.name), ['资料.txt']);
  paste_entry({ source_root: f.other, source_path: '资料.txt', root: f.root, path: '', mode: 'move', conflict: 'keep_both', recycle: f.recycle });
  assert.ok(!existsSync(join(f.other, '资料.txt')));
});

test('an upload is written once all its parts arrive, within the size limit', t => {
  const f = fixture(t);
  const bytes = Buffer.from('上传的内容'.repeat(10));
  const half = Math.ceil(bytes.length / 2);
  const part = (index, data, extra = {}) => upload_part({ root: f.root, path: '', name: '上传.txt', upload_id: 'upload-0123456789abcdef', index, total: 2,
    size: bytes.length, data: data.toString('base64'), parts_directory: f.parts, recycle: f.recycle, ...extra });
  assert.deepEqual(part(1, bytes.subarray(half)), { received: 1, missing: [0] });
  assert.ok(!existsSync(join(f.root, '上传.txt')));
  assert.deepEqual(part(0, bytes.subarray(0, half)), { path: '上传.txt', size: bytes.length });
  assert.deepEqual(readFileSync(join(f.root, '上传.txt')), bytes);
  assert.throws(() => upload_part({ root: f.root, path: '', name: '大.bin', upload_id: 'upload-0123456789abcdeg', index: 0, total: 1,
    size: 51 * 1024 * 1024, data: '', parts_directory: f.parts, recycle: f.recycle }), /50 MiB/);
});

test('saving an edit keeps encoding and line endings, and refuses when the file changed after it was read', t => {
  const f = fixture(t);
  const path = join(f.root, 'config.txt');
  writeFileSync(path, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('第一行\r\n第二行\r\n')]));
  const opened = read_text(f.root, 'config.txt');
  assert.equal(opened.text, '第一行\r\n第二行\r\n');
  // The browser's text box hands back plain line feeds.
  const saved = save_text(f.root, 'config.txt', '第一行\n改过的第二行\n', opened.version);
  assert.deepEqual(readFileSync(path), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('第一行\r\n改过的第二行\r\n')]));
  assert.deepEqual(save_text(f.root, 'config.txt', '覆盖', opened.version), { conflict: true });
  writeFileSync(path, 'AI 刚写的');
  assert.deepEqual(save_text(f.root, 'config.txt', '覆盖', saved.version), { conflict: true });
  assert.equal(readFileSync(path, 'utf8'), 'AI 刚写的');
  writeFileSync(join(f.root, '图.bin'), Buffer.from([0, 1, 2, 3]));
  assert.throws(() => read_text(f.root, '图.bin'), /二进制/);
  writeFileSync(join(f.root, '大.txt'), 'x'.repeat(1024 * 1024 + 1));
  assert.throws(() => read_text(f.root, '大.txt'), /超过/);
});

test('a path ending in `..` is refused, so neither the root nor its parent can be changed', t => {
  const f = fixture(t);
  make_folder(f.root, '', '子文件夹');
  for (const path of ['..', '子文件夹/..', './..', '子文件夹/../..']) {
    assert.throws(() => delete_entry(f.root, path, f.recycle), /相对路径/);
    assert.throws(() => rename_entry(f.root, path, '改名'), /相对路径/);
    assert.throws(() => paste_entry({ source_root: f.root, source_path: path, root: f.other, path: '', mode: 'copy', recycle: f.recycle }), /相对路径/);
  }
  assert.ok(existsSync(join(f.root, '子文件夹')) && existsSync(join(f.base, 'secret.txt')));
});

test('a folder a room works in keeps its place, and replacing the pasted entry itself keeps both', t => {
  const f = fixture(t);
  make_folder(f.root, '', '工作区');
  const rooms_in = folder => (folder.endsWith('工作区') ? ['room-1'] : []);
  assert.throws(() => rename_entry(f.root, '工作区', '别处', rooms_in), /1 个房间/);
  assert.throws(() => delete_entry(f.root, '工作区', f.recycle, rooms_in), /1 个房间/);
  assert.throws(() => paste_entry({ source_root: f.root, source_path: '工作区', root: f.other, path: '', mode: 'move', recycle: f.recycle, rooms_in }), /1 个房间/);
  writeFileSync(join(f.root, 'a.txt'), '原文');
  assert.deepEqual(paste_entry({ source_root: f.root, source_path: 'a.txt', root: f.root, path: '', mode: 'copy', conflict: 'replace', recycle: f.recycle }), { path: 'a (1).txt' });
  assert.equal(readFileSync(join(f.root, 'a.txt'), 'utf8'), '原文');
  assert.deepEqual(f.recycle.list(), []);
});

test('an upload never keeps more than it declared, and a resent last part answers with the file already written', t => {
  const f = fixture(t);
  const base = { root: f.root, path: '', name: '资料.bin', parts_directory: f.parts, recycle: f.recycle };
  assert.throws(() => upload_part({ ...base, upload_id: 'upload-oversize-000001', index: 0, total: 2, size: 4, data: Buffer.alloc(8).toString('base64') }), /超过声明/);
  assert.throws(() => upload_part({ ...base, upload_id: 'upload-toomany-000001', index: 0, total: 1024, size: 1, data: 'AA==' }), /上传请求无效/);
  const once = { ...base, upload_id: 'upload-resent-0000001', index: 0, total: 1, size: 3, data: Buffer.from('abc').toString('base64') };
  assert.deepEqual(upload_part(once), { path: '资料.bin', size: 3 });
  assert.deepEqual(upload_part(once), { path: '资料.bin', size: 3 });
  assert.ok(!existsSync(join(f.root, '资料 (1).bin')));
});

test('a delete across disks that cannot remove everything keeps the whole copy in the recycle area', t => {
  const f = fixture(t);
  mkdirSync(join(f.root, '资料', '在用'), { recursive: true });
  writeFileSync(join(f.root, '资料', '说明.txt'), '内容');
  const exdev = () => { throw Object.assign(new Error('cross-device'), { code: 'EXDEV' }); };
  // A folder that is some process's current directory cannot be removed on Windows; elsewhere this case does not arise.
  const back = process.cwd();
  process.chdir(join(f.root, '资料', '在用'));
  try {
    assert.throws(() => f.recycle.keep(join(f.root, '资料'), { root: f.root, path: '资料', kind: 'directory' }, { rename: exdev }), process.platform === 'win32' ? /完整副本/ : () => true);
  } catch (error) {
    if (process.platform === 'win32') throw error;
  } finally { process.chdir(back); }
  if (process.platform !== 'win32') return;
  const [kept] = f.recycle.list();
  assert.equal(kept.name, '资料');
  assert.equal(readFileSync(join(f.base, 'trash', kept.id, 'item', '资料', '说明.txt'), 'utf8'), '内容');
});

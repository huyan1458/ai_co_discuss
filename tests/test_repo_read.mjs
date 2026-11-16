import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { REPO_READ_MAX_BYTES, repo_excluded, repo_grep, repo_list, repo_read } from '../runner/repo_read.mjs';

const RELAY_ENVELOPE_BYTES = 512 * 1024;

function temp_dir(t, name = 'codiscuss-repo-') {
  const dir = mkdtempSync(join(tmpdir(), name));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write_files(root, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

/** Create a link if this machine allows it; Windows without Developer Mode refuses file symlinks. */
function try_link(target, path, type) {
  try { symlinkSync(target, path, type); return true; } catch { return false; }
}

const SENSITIVE = {
  '.env': 'TOKEN=secret-env', 'config/.env.local': 'TOKEN=secret-env', 'prod.env': 'x', 'data/room.json': '{"token":"secret-data"}',
  'keys/server.pem': 'secret-key', 'id_rsa': 'secret-key', '.npmrc': '//registry/:_authToken=secret', 'secrets.yaml': 'secret',
  '.ssh/config': 'Host x', 'sub/.git': 'gitdir: nowhere',
};

function git_repo(t) {
  const root = temp_dir(t);
  execFileSync('git', ['init', '-q'], { cwd: root });
  write_files(root, {
    'README.md': '# demo\nfind me here\n', 'src/app.js': 'const word = "Find Me";\n', '.gitignore': 'dist/\nignored.txt\n',
    'dist/out.js': 'find me in build', 'ignored.txt': 'find me ignored', ...SENSITIVE,
  });
  execFileSync('git', ['-c', 'core.autocrlf=false', 'add', 'README.md', '.gitignore', 'src/app.js', '.env'], { cwd: root });
  return root;
}

test('fixed exclusions cover env, keys, credentials, data and .git in any case', () => {
  for (const [path, rule] of [['.env', 'env_file'], ['a/.ENV.production', 'env_file'], ['prod.env', 'env_file'], ['.envrc', 'env_file'],
    ['data/x.json', 'data_dir'], ['Data/b', 'data_dir'], ['.git/config', 'dotgit'], ['k/server.PEM', 'private_key'],
    ['id_ed25519.pub', 'private_key'], ['.npmrc', 'credential_file'], ['secrets.json', 'credential_file'], ['.aws/credentials', 'credential_dir']]) {
    assert.equal(repo_excluded(path), rule, path);
  }
  for (const path of ['src/app.js', 'README.md', 'docs/environment.md', 'database/x.sql', 'src/data/x.json', 'a/Data/b']) assert.equal(repo_excluded(path), null, path);
});

test('git directory: list, read and grep share tracked + untracked-not-ignored scope', async (t) => {
  const root = git_repo(t);
  const listing = await repo_list(root);
  assert.equal(listing.ok, true);
  assert.equal(listing.scope_mode, 'git');
  assert.deepEqual(listing.entries.map((entry) => entry.name), ['src', '.gitignore', 'README.md']);
  assert.ok(listing.bytes > 0);
  const nested = await repo_list(root, 'src');
  assert.deepEqual(nested.entries, [{ name: 'app.js', path: 'src/app.js', kind: 'file', size: 24 }]);

  const read = await repo_read(root, 'src\\app.js');
  assert.equal(read.ok, true);
  assert.equal(read.path, 'src/app.js');
  assert.equal(read.text, 'const word = "Find Me";\n');
  assert.equal(read.bytes, 24);
  assert.equal(read.next_offset, null);

  const grep = await repo_grep(root, 'find me');
  assert.deepEqual(grep.matches.map((match) => [match.path, match.line]), [['README.md', 2], ['src/app.js', 1]]);
  assert.equal(grep.truncated, false);
  assert.equal((await repo_grep(root, 'find me', { case_sensitive: true })).matches.length, 1);
  assert.equal((await repo_grep(root, 'secret')).matches.length, 0);
  assert.equal((await repo_grep(root, 'find', { path: 'src' })).matches.length, 1);

  assert.deepEqual(await repo_read(root, 'dist/out.js'), { ok: false, reason: 'not_in_scope' });
  assert.deepEqual(await repo_read(root, 'ignored.txt'), { ok: false, reason: 'not_in_scope' });
  assert.deepEqual(await repo_read(root, 'missing.txt'), { ok: false, reason: 'not_in_scope' });
  assert.deepEqual(await repo_list(root, 'dist'), { ok: false, reason: 'not_in_scope' });
  assert.deepEqual(await repo_read(root, '.env'), { ok: false, reason: 'excluded', detail: 'env_file' });
  assert.deepEqual(await repo_read(root, 'data/room.json'), { ok: false, reason: 'excluded', detail: 'data_dir' });
  assert.deepEqual(await repo_list(root, 'data'), { ok: false, reason: 'excluded', detail: 'data_dir' });
  write_files(root, { 'src/data/x.json': '{"nested":"find me deep"}' });
  assert.equal((await repo_read(root, 'src/data/x.json')).text, '{"nested":"find me deep"}');
  assert.deepEqual((await repo_list(root, 'src')).entries.map((entry) => entry.name), ['data', 'app.js']);
  assert.ok((await repo_grep(root, 'find me deep')).matches.some((match) => match.path === 'src/data/x.json'));
  assert.deepEqual(await repo_grep(root, 'x', { path: 'keys/server.pem' }), { ok: false, reason: 'excluded', detail: 'private_key' });
  assert.deepEqual(await repo_read(root, 'src'), { ok: false, reason: 'not_a_file' });
  assert.deepEqual(await repo_list(root, 'README.md'), { ok: false, reason: 'not_a_directory' });
});

test('path syntax: traversal, absolute, drive, UNC, streams and Windows trailing dots are refused', async (t) => {
  const root = git_repo(t);
  const cases = [['../secret.txt', 'path_traversal'], ['src/../../x', 'path_traversal'], ['/etc/passwd', 'absolute_path'],
    ['C:/Windows/win.ini', 'absolute_path'], ['\\\\server\\share\\x', 'absolute_path'], [join(root, 'README.md'), 'absolute_path'],
    ['README.md:stream', 'invalid_path'], ['.env.', 'invalid_path'], ['README.md ', 'invalid_path'], ['a\0b', 'invalid_path'], [42, 'invalid_path']];
  for (const [path, reason] of cases) {
    assert.equal((await repo_read(root, path)).reason, reason, String(path));
    assert.equal((await repo_list(root, path)).reason, reason, String(path));
    assert.equal((await repo_grep(root, 'x', { path })).reason, reason, String(path));
  }
  assert.equal((await repo_read('relative/root', 'a')).reason, 'invalid_root');
  assert.equal((await repo_read(join(root, 'nope'), 'a')).reason, 'invalid_root');
  assert.equal((await repo_read(root, 'README.md', { offset: -1 })).reason, 'invalid_argument');
  assert.equal((await repo_grep(root, '')).reason, 'invalid_query');
  assert.equal((await repo_grep(root, 'a\nb')).reason, 'invalid_query');
});

test('git failure inside a work tree refuses instead of walking past .gitignore', async (t) => {
  const root = temp_dir(t);
  write_files(root, { '.git': 'not a gitdir', 'a.txt': 'a' });
  const result = await repo_list(root);
  assert.equal(result.reason, 'scope_unavailable');
  assert.ok(result.detail);
});

test('plain directory: walk skips generated folders and fixed exclusions', async (t) => {
  const root = temp_dir(t);
  write_files(root, { 'notes.md': 'hello', 'node_modules/pkg/index.js': 'hello', 'docs/guide.md': 'hello', ...SENSITIVE });
  const listing = await repo_list(root);
  assert.equal(listing.scope_mode, 'walk');
  assert.deepEqual(listing.entries.map((entry) => entry.name), ['docs', 'notes.md']);
  assert.deepEqual((await repo_grep(root, 'hello')).matches.map((match) => match.path), ['docs/guide.md', 'notes.md']);
  assert.equal((await repo_read(root, 'node_modules/pkg/index.js')).reason, 'not_in_scope');
  assert.equal((await repo_read(root, 'sub/.git')).reason, 'excluded');
});

test('links and junctions leading outside the open directory are refused', async (t) => {
  const outside = temp_dir(t, 'codiscuss-outside-');
  write_files(outside, { 'secret.txt': 'outside secret' });
  for (const make_repo of [false, true]) {
    const root = temp_dir(t);
    if (make_repo) execFileSync('git', ['init', '-q'], { cwd: root });
    write_files(root, { 'inner.txt': 'inner', 'dir/x.txt': 'x' });
    const junction = try_link(outside, join(root, 'jx'), 'junction');
    const file_link = try_link(join(outside, 'secret.txt'), join(root, 'leak.txt'), 'file');
    const inner_link = try_link(join(root, 'inner.txt'), join(root, 'alias.txt'), 'file');
    const listing = await repo_list(root);
    const names = listing.entries.map((entry) => entry.name);
    assert.ok(!names.includes('leak.txt'));
    if (junction) {
      assert.ok(['not_in_scope', 'outside_root'].includes((await repo_read(root, 'jx/secret.txt')).reason));
      const jx = listing.entries.find((entry) => entry.name === 'jx');
      assert.equal(jx, undefined);
      // A walk lists the junction itself; Git may or may not, but either way nothing behind it is served.
      for (const result of [await repo_read(root, 'jx'), await repo_list(root, 'jx'), await repo_grep(root, 'secret', { path: 'jx' })]) {
        if (make_repo) assert.ok(['not_in_scope', 'outside_root'].includes(result.reason), result.reason);
        else assert.equal(result.reason, 'outside_root');
      }
    }
    if (file_link) assert.equal((await repo_read(root, 'leak.txt')).reason, 'outside_root');
    if (inner_link) assert.equal((await repo_read(root, 'alias.txt')).text, 'inner');
    const grep = await repo_grep(root, 'secret');
    assert.equal(grep.matches.length, 0);
    if (!junction && !file_link) t.diagnostic('links not permitted on this machine; link checks skipped');
  }
});

test('reads stop at 128 KiB on character boundaries and continue by offset', async (t) => {
  const root = temp_dir(t);
  const text = '汉字'.repeat(60000);
  write_files(root, { 'big.txt': text, 'bin.dat': Buffer.from([0, 1, 2, 3, 255]), 'u16.txt': Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('宽字符', 'utf16le')]) });
  let offset = 0, collected = '', pieces = 0;
  for (;;) {
    const part = await repo_read(root, 'big.txt', { offset });
    assert.equal(part.ok, true);
    assert.ok(part.bytes <= REPO_READ_MAX_BYTES);
    assert.equal(Buffer.byteLength(part.text), part.bytes);
    collected += part.text; pieces += 1;
    if (part.next_offset === null) break;
    assert.equal(part.truncated, true);
    offset = part.next_offset;
  }
  assert.equal(collected, text);
  assert.equal(pieces, Math.ceil(Buffer.byteLength(text) / (REPO_READ_MAX_BYTES - 2)));
  const middle = await repo_read(root, 'big.txt', { offset: 1, max_bytes: 10 });
  assert.equal(middle.offset, 3);
  assert.equal(middle.text, '字汉');
  assert.equal(middle.next_offset, 9);
  assert.equal((await repo_read(root, 'big.txt', { max_bytes: 10 ** 9 })).bytes <= REPO_READ_MAX_BYTES, true);
  assert.deepEqual(await repo_read(root, 'bin.dat'), { ok: false, reason: 'binary' });
  const wide = await repo_read(root, 'u16.txt');
  assert.equal(wide.encoding, 'utf-16le');
  assert.equal(wide.text, '宽字符');
});

test('worst-case results fit the 512 KiB relay envelope after JSON escaping and base64', async (t) => {
  const root = temp_dir(t);
  write_files(root, { 'quotes.txt': '"\\'.repeat(200000), 'many.txt': `${'needle "\\" '.repeat(60)}\n`.repeat(2000) });
  for (let i = 0; i < 1500; i += 1) write_files(root, { [`d/${'n'.repeat(80)}${i}.txt`]: 'x' });
  const envelope = (value) => Math.ceil(Buffer.byteLength(JSON.stringify(value)) / 3) * 4;
  const read = await repo_read(root, 'quotes.txt');
  assert.ok(envelope(read) < RELAY_ENVELOPE_BYTES, `read ${envelope(read)}`);
  // Loaded CI machines can exceed the 3 s default; the limits under test here are results and bytes, not time.
  const slow_ok = { time_limit_ms: 30000 };
  const grep = await repo_grep(root, 'needle', { max_results: 500, ...slow_ok });
  assert.equal(grep.truncated, true);
  assert.ok(['bytes', 'results'].includes(grep.truncated_by));
  assert.ok(envelope(grep) < RELAY_ENVELOPE_BYTES, `grep ${envelope(grep)}`);
  const timed_out = await repo_grep(root, 'needle', { time_limit_ms: 0 });
  assert.deepEqual([timed_out.ok, timed_out.matches.length, timed_out.truncated, timed_out.truncated_by], [true, 0, true, 'time']);
  const few = await repo_grep(root, 'needle', { max_results: 3, ...slow_ok });
  assert.equal(few.matches.length, 3);
  assert.equal(few.truncated_by, 'results');
  assert.ok(few.matches.every((match) => match.text.length <= 400));
  const listing = await repo_list(root, 'd', { limit: 1000 });
  assert.equal(listing.total, 1500);
  assert.ok(listing.entries.length < 1000, 'page is cut by the result byte cap');
  assert.equal(listing.next_offset, listing.entries.length);
  assert.ok(envelope(listing) < RELAY_ENVELOPE_BYTES, `list ${envelope(listing)}`);
  const seen = new Set(listing.entries.map((entry) => entry.path));
  for (let page = listing; page.next_offset !== null;) {
    page = await repo_list(root, 'd', { offset: page.next_offset, limit: 1000 });
    for (const entry of page.entries) seen.add(entry.path);
  }
  assert.equal(seen.size, 1500);
});

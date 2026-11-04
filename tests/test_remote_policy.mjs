import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { claim_relayed_command, COMMAND_MAX_AGE_MS, guard_remote_request, list_remote_directories, remote_directory, remote_roots } from '../runner/remote_policy.mjs';

/** A service home, one saved project with sub-folders, and a folder outside it. */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'codiscuss-remote-policy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home'), project = join(root, 'projects'), outside = join(root, 'private');
  for (const folder of [home, join(project, 'alpha'), join(project, 'beta', 'deep'), outside]) mkdirSync(folder, { recursive: true });
  writeFileSync(join(project, 'notes.txt'), 'not a folder');
  const projects = [{ id: 'p1', name: 'Projects', path: project }];
  return { root, home, project, outside, projects, roots: remote_roots(projects) };
}

test('other devices reach only folders inside the saved projects, never shares, devices or the service directory', t => {
  const f = fixture(t);
  assert.ok(remote_directory(join(f.project, 'beta', 'deep'), f).endsWith('deep'));
  for (const path of [f.outside, join(f.project, '..', 'private'), 'relative/path', '\\\\attacker\\share', '//attacker/share', '\\\\?\\C:\\', '\\\\.\\PhysicalDrive0', join(f.project, 'missing')]) {
    assert.throws(() => remote_directory(path, f), /未允许其他设备使用这个目录/, path);
  }
  // A link inside a project that points outside it is judged by where it really leads.
  const link = join(f.project, 'escape');
  try { symlinkSync(f.outside, link, 'junction'); } catch { return t.diagnostic('cannot create links here'); }
  assert.throws(() => remote_directory(link, f), /未允许/);
  // The service's own directory stays closed even when a project contains it.
  const projects = [{ id: 'all', name: 'All', path: f.root }];
  assert.throws(() => remote_directory(f.home, { roots: remote_roots(projects), home: f.home }), /未允许/);
});

test('a relayed request cannot widen folders, change program locations or turn on full access', t => {
  const f = fixture(t);
  const participants = { Claude: { adapter: 'claude', executable: 'C:/Tools/claude.exe' } };
  const guard = (command, input) => guard_remote_request(command, input, { projects: f.projects, participants, home: f.home });
  // Repeating what this computer saved, inside the projects, passes.
  guard('start', { cwd: join(f.project, 'alpha'), participants: { Claude: { executable: 'C:/Tools/claude.exe', project_access: 'read' } } });
  assert.throws(() => guard('start', { cwd: f.outside }), /未允许/);
  assert.throws(() => guard('start', { participants: { Claude: { cwd: f.outside } } }), /未允许/, 'nested cwd is checked too');
  assert.throws(() => guard('settings', { participants: { Claude: { executable: 'C:/Windows/System32/cmd.exe' } } }), /软件位置/);
  assert.throws(() => guard('room-member-access', { name: 'Claude', project_access: 'full' }), /全放开/);
  assert.throws(() => guard('room-config', {}), /只能在这台电脑上/);
  // Saved projects may be renamed or narrowed, but a new or moved one must lie inside the old ones.
  guard('projects', { projects: [{ id: 'p1', name: 'Renamed', path: f.project }, { name: 'Alpha', path: join(f.project, 'alpha') }] });
  assert.throws(() => guard('projects', { projects: [{ id: 'p1', name: 'Projects', path: f.outside }] }), /未允许/);
  assert.throws(() => guard('projects', { projects: [{ name: 'Disk', path: f.root }] }), /未允许/);
});

test('folder browsing lists only folder names inside the saved projects, a page at a time', t => {
  const f = fixture(t);
  const top = list_remote_directories({}, f);
  assert.deepEqual(top.entries.map(entry => entry.name), ['Projects']);
  const inside = list_remote_directories({ path: top.entries[0].path }, f);
  assert.deepEqual(inside.entries.map(entry => entry.name), ['alpha', 'beta'], 'files are not listed');
  assert.equal(inside.parent, '', 'a project root goes back to the project list');
  const deeper = list_remote_directories({ path: inside.entries[1].path }, f);
  assert.equal(deeper.parent, inside.path);
  assert.throws(() => list_remote_directories({ path: f.outside }, f), /未允许/);
  assert.throws(() => list_remote_directories({ path: f.project, offset: -1 }, f), /分页/);
});

test('a relayed command runs once, only within its time window, across restarts', t => {
  const f = fixture(t);
  const now = Date.now();
  claim_relayed_command(f.home, 'command-1', now, now);
  assert.throws(() => claim_relayed_command(f.home, 'command-1', now, now + 1000), /已执行过/, 'a replay is refused');
  assert.throws(() => claim_relayed_command(f.home, 'command-2', undefined, now), /过期/, 'a request without a send time is refused');
  assert.throws(() => claim_relayed_command(f.home, 'command-3', now - COMMAND_MAX_AGE_MS - 1, now), /过期/);
  // Ids older than the window are forgotten; a request that old is refused by its time anyway.
  claim_relayed_command(f.home, 'command-4', now + 3 * COMMAND_MAX_AGE_MS, now + 3 * COMMAND_MAX_AGE_MS);
  claim_relayed_command(f.home, 'command-1', now + 3 * COMMAND_MAX_AGE_MS, now + 3 * COMMAND_MAX_AGE_MS);
});

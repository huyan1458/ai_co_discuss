import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { claim_relayed_command, COMMAND_MAX_AGE_MS, guard_remote_request, list_remote_directories, remote_directory, remote_roots } from '../runner/remote_policy.mjs';

import { relayed_command } from '../runner/remote_launch.mjs';

test('a paired share job is bound to the room on the selected computer', () => {
  const request = { room_id: 'one', op: 'get', id: 'one-job', site: 'https://other.test', access_file: 'other-room' };
  const command = relayed_command('http://localhost:8765', 'share-job', request);
  assert.equal(command.input.site, 'http://localhost:8765');
  assert.equal(command.input.room_id, 'one');
  assert.equal(command.input.access_file, undefined);
});

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
    assert.throws(() => remote_directory(path, f), /常用项目|Saved projects/, path);
  }
  // A link inside a project that points outside it is judged by where it really leads.
  const link = join(f.project, 'escape');
  try { symlinkSync(f.outside, link, 'junction'); } catch { return t.diagnostic('cannot create links here'); }
  assert.throws(() => remote_directory(link, f), /常用项目|Saved projects/);
  // The service's own directory stays closed even when a project contains it.
  const projects = [{ id: 'all', name: 'All', path: f.root }];
  assert.throws(() => remote_directory(f.home, { roots: remote_roots(projects), home: f.home }), /常用项目|Saved projects/);
});

test('a relayed request cannot widen folders, change program locations or turn on full access', t => {
  const f = fixture(t);
  const participants = { Claude: { adapter: 'claude', executable: 'C:/Tools/claude.exe' } };
  const guard = (command, input) => guard_remote_request(command, input, { projects: f.projects, participants, home: f.home });
  // Repeating what this computer saved, inside the projects, passes.
  guard('start', { cwd: join(f.project, 'alpha'), participants: { Claude: { executable: 'C:/Tools/claude.exe', project_access: 'read' } } });
  assert.throws(() => guard('start', { cwd: f.outside }), /常用项目|Saved projects/);
  assert.throws(() => guard('start', { participants: { Claude: { cwd: f.outside } } }), /常用项目|Saved projects/, 'nested cwd is checked too');
  guard('room-settings', { room_id: 'room-a', extra_directories: [join(f.project, 'alpha')] });
  assert.throws(() => guard('room-settings', { room_id: 'room-a', extra_directories: [join(f.project, 'alpha'), f.outside] }), /常用项目|Saved projects/, 'every extra project directory is checked');
  // A folder the room or group already holds (set on this computer) stays usable and removable; a new one is still refused.
  const kept = (command, input) => guard_remote_request(command, input, { projects: f.projects, participants, home: f.home, kept: [f.outside] });
  kept('start', { cwd: join(f.project, 'alpha'), extra_directories: [f.outside] });
  kept('room-settings', { room_id: 'room-a', extra_directories: [] });
  assert.throws(() => kept('room-settings', { room_id: 'room-a', extra_directories: [f.outside, f.root] }), /常用项目|Saved projects/);
  // The page shows the refusal in its own language, whatever this computer's language is.
  assert.throws(() => guard('start', { cwd: f.outside }), error => error.error_text?.template.includes('常用项目') && error.error_text.params.path === f.outside);
  assert.throws(() => guard('settings', { participants: { Claude: { executable: 'C:/Windows/System32/cmd.exe' } } }), /软件位置/);
  // 全放开 may be given to a room's member, but not saved as a default from afar.
  guard('room-member-access', { room_id: 'room-a', name: 'Claude', project_access: 'full' });
  assert.throws(() => guard('settings', { participants: { Claude: { project_access: 'full' } } }), /全放开/);
  assert.throws(() => guard('room-config', {}), /只能在这台电脑上/);
  // Saved projects may be renamed or narrowed, but a new or moved one must lie inside the old ones.
  guard('projects', { projects: [{ id: 'p1', name: 'Renamed', path: f.project }, { name: 'Alpha', path: join(f.project, 'alpha') }] });
  assert.throws(() => guard('projects', { projects: [{ id: 'p1', name: 'Projects', path: f.outside }] }), /常用项目|Saved projects/);
  assert.throws(() => guard('projects', { projects: [{ name: 'Disk', path: f.root }] }), /常用项目|Saved projects/);
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
  assert.throws(() => list_remote_directories({ path: f.outside }, f), /常用项目|Saved projects/);
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

test('relayed project libraries select room and project IDs and reject supplied paths', t => {
  const { project } = fixture(t);
  for (const action of ['presets', 'workflows']) {
    assert.throws(() => relayed_command('http://localhost', action, { action: 'list', cwd: project }));
    assert.throws(() => relayed_command('http://localhost', action, { action: 'list', extra_directories: [project] }));
    const { input } = relayed_command('http://localhost', action, { action: 'list', room_id: 'one', project_id: 'known', site: 'https://other.test' });
    assert.equal(input.site, 'http://localhost');
    assert.equal(input.project_id, 'known');
  }
});

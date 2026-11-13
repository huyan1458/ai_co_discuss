import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { account_projects, account_space, create_account_project, draft_folder } from '../runner/account_space.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'codiscuss-space-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'service');
  mkdirSync(home);
  return { root, home };
}

test('the draft space sits beside the service directory unless the settings name one', t => {
  const f = fixture(t);
  assert.deepEqual(account_space(f.home), { workspace: `${f.home}-workspace`, projects_root: null });
  writeFileSync(join(f.home, 'local-settings.json'), JSON.stringify({ port: 1, workspace: join(f.root, 'workspace'), projects_root: join(f.root, 'projects') }));
  assert.deepEqual(account_space(f.home), { workspace: join(f.root, 'workspace'), projects_root: join(f.root, 'projects') });
});

test('each new room gets its own draft folder, and a retried creation reuses it', t => {
  const f = fixture(t);
  const first = draft_folder(f.home, '市场/分析: 一', 'submission-1');
  assert.equal(draft_folder(f.home, '市场/分析: 一', 'submission-1'), first);
  const second = draft_folder(f.home, '市场/分析: 一', 'submission-2');
  assert.notEqual(second, first);
  assert.ok(existsSync(first) && existsSync(second));
  assert.equal(readdirSync(`${f.home}-workspace`).length, 2);
  for (const name of readdirSync(`${f.home}-workspace`)) assert.doesNotMatch(name, /[\\/:]/);
  assert.match(draft_folder(f.home, '..', 'submission-3'), /房间-[0-9a-f]{6}$/);
});

test('an ordinary account creates projects only as flat folders under its root', t => {
  const f = fixture(t);
  const root = join(f.root, 'projects');
  assert.deepEqual(account_projects(root), []);
  assert.equal(create_account_project(root, '新品方案').path, join(root, '新品方案'));
  for (const name of ['', '..', '.hidden', 'a/b', 'a\\b', '..\\escape', 'C:evil', 'con', 'tail.', 'x'.repeat(81)]) {
    assert.throws(() => create_account_project(root, name), /项目名称须为/, name);
  }
  assert.throws(() => create_account_project(root, '新品方案'), /项目已存在/);
  writeFileSync(join(root, 'note.txt'), 'not a project');
  assert.deepEqual(account_projects(root).map(project => project.name), ['新品方案']);
  assert.deepEqual(readdirSync(f.root).sort(), ['projects', 'service']);
});

/** Run the local command entry as the website does, against one service directory. */
function command(home, name, input) {
  const args = [join(import.meta.dirname, '..', 'runner', 'discussion_launch.mjs'), name, ...(input === undefined ? [] : ['--stdin'])];
  const result = spawnSync(process.execPath, args, { input: input === undefined ? undefined : JSON.stringify(input), encoding: 'utf8',
    env: { ...process.env, DISCUSS_SERVICE_HOME: home } });
  if (result.status !== 0) throw new Error(result.stderr.trim());
  return JSON.parse(result.stdout);
}

test('an ordinary account\'s instance uses only its own projects and draft space, whatever page asks', t => {
  const f = fixture(t);
  const projects = join(f.root, 'projects'), workspace = join(f.root, 'workspace'), outside = join(f.root, 'elsewhere');
  for (const folder of [projects, workspace, outside]) mkdirSync(folder);
  writeFileSync(join(f.home, 'local-settings.json'), JSON.stringify({ workspace, projects_root: projects }));
  const created = command(f.home, 'projects', { create: '新品方案' });
  assert.deepEqual(created.projects.map(project => project.path), [join(projects, '新品方案')]);
  assert.throws(() => command(f.home, 'projects', { create: '../elsewhere/x' }), /项目名称须为/);
  assert.throws(() => command(f.home, 'projects', { projects: [{ name: '外面', path: outside }] }), /未允许|只能在自己的项目文件夹内新建/);
  const settings = command(f.home, 'settings');
  assert.equal(settings.projects_restricted, true);
  assert.equal(settings.workspace, workspace);
  assert.deepEqual(command(f.home, 'browse-directory', {}).entries.map(entry => entry.name), ['新品方案', '草稿空间']);
  for (const path of [outside, f.root, f.home, projects.slice(0, 3)]) {
    assert.throws(() => command(f.home, 'browse-directory', { path }), /未允许/, path);
    assert.throws(() => command(f.home, 'room-settings', { site: 'http://127.0.0.1:1', room_id: 'r', token: 't', cwd: path }), /未允许/, path);
    assert.throws(() => command(f.home, 'room-settings', { site: 'http://127.0.0.1:1', room_id: 'r', token: 't', extra_directories: [path] }), /未允许/, path);
  }
  assert.throws(() => command(f.home, 'pick-directory'), /只能使用自己的项目文件夹/);
});

test('the computer owner\'s instance keeps its saved project list and may name any folder', t => {
  const f = fixture(t);
  const settings = command(f.home, 'settings');
  assert.equal(settings.projects_restricted, false);
  assert.equal(settings.workspace, `${f.home}-workspace`);
  assert.deepEqual(command(f.home, 'projects', { projects: [{ name: '任意', path: f.root }] }).projects.map(project => project.path), [f.root]);
});

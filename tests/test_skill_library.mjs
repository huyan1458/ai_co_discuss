import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { import_skill, library_root, list_library } from '../runner/skill_library.mjs';

const ENV_SCRIPT = fileURLToPath(new URL('../runner/account_env.mjs', import.meta.url));
const folders = [];
after(() => { for (const folder of folders) rmSync(folder, { recursive: true, force: true }); });
const temp = prefix => { const folder = mkdtempSync(join(tmpdir(), prefix)); folders.push(folder); return folder; };
const encode = text => Buffer.from(text).toString('base64');

test('a dropped skill folder is unwrapped and named by its SKILL.md, and no path may leave the library', () => {
  const data = temp('library-');
  const skill = import_skill(data, { files: [
    { path: 'wrapper/SKILL.md', data: encode('---\nname: weekly-report\ndescription: 周报\n---\n') },
    { path: 'wrapper/scripts/run.ps1', data: encode('Write-Output 1') },
  ] });
  assert.equal(skill.name, 'weekly-report');
  assert.ok(existsSync(join(library_root(data), 'weekly-report', 'scripts', 'run.ps1')));
  assert.deepEqual(list_library(data).map(item => [item.name, item.description, item.files]), [['weekly-report', '周报', 2]]);
  assert.throws(() => import_skill(data, { files: [{ path: '../escape/SKILL.md', data: encode('x') }] }), /文件路径无效/);
  assert.throws(() => import_skill(data, { files: [{ path: 'notes.txt', data: encode('x') }] }), /SKILL\.md/);
  assert.ok(!existsSync(join(data, 'escape')));
});

test('an account\'s AI environment shares one skills folder and one system prompt among the three programs', { skip: process.platform !== 'win32' }, () => {
  const home = temp('env-home-'), service = temp('env-service-');
  const run = (action, request) => {
    const job = temp('env-job-');
    writeFileSync(join(job, 'request.json'), JSON.stringify(request));
    const result = spawnSync(process.execPath, [ENV_SCRIPT, action, job], { encoding: 'utf8', env: { ...process.env, USERPROFILE: home, HOME: home } });
    return JSON.parse(result.stdout.trim().split('\n').at(-1));
  };
  const first = run('init', { home: service, prompt: '# 默认\n' });
  assert.deepEqual(first.layout, { skills_folder: true, claude_linked: true, agy_listed: true, prompt_linked: true });
  assert.ok(first.skills.some(skill => skill.name === 'discuss-participant' && skill.status === 'installed'));
  assert.ok(existsSync(join(home, '.claude', 'skills', 'discuss-participant', 'SKILL.md')), 'Claude sees the shared folder through the junction');
  assert.deepEqual(JSON.parse(readFileSync(join(home, '.gemini', 'config', 'skills.json'), 'utf8')).entries.map(entry => entry.path), [join(home, '.agents', 'skills').replaceAll('\\', '/')]);
  run('prompt', { prompt: '# 新的\n' });
  for (const path of [['.codex', 'AGENTS.md'], ['.claude', 'CLAUDE.md'], ['.gemini', 'config', 'AGENTS.md']]) assert.equal(readFileSync(join(home, ...path), 'utf8'), '# 新的\n');
  assert.equal(lstatSync(join(home, '.claude', 'CLAUDE.md')).ino, lstatSync(join(home, '.codex', 'AGENTS.md')).ino);
  // Repeating it keeps the prompt someone wrote and does not list the folder twice.
  const again = run('init', { home: service, prompt: '# 默认\n' });
  assert.ok(Object.values(again.layout).every(Boolean));
  assert.equal(readFileSync(join(home, '.codex', 'AGENTS.md'), 'utf8'), '# 新的\n');
  assert.equal(JSON.parse(readFileSync(join(home, '.gemini', 'config', 'skills.json'), 'utf8')).entries.length, 1);
});

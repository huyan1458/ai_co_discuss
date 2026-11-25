import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

test('an account\'s AI environment shares one skills folder, and its prompt goes to CoDiscuss members, not the programs\' files', { skip: process.platform !== 'win32' }, () => {
  const home = temp('env-home-'), service = temp('env-service-');
  const run = (action, request) => {
    const job = temp('env-job-');
    writeFileSync(join(job, 'request.json'), JSON.stringify(request));
    const result = spawnSync(process.execPath, [ENV_SCRIPT, action, job], { encoding: 'utf8', env: { ...process.env, USERPROFILE: home, HOME: home } });
    return JSON.parse(result.stdout.trim().split('\n').at(-1));
  };
  // An earlier version wrote the prompt into the programs' own files, which plain AI windows also read; a program that
  // saved one by replacement broke its hard link, so that file holds text of its own.
  mkdirSync(join(home, '.codex'), { recursive: true });
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.codex', 'AGENTS.md'), '# 旧的\n');
  writeFileSync(join(home, '.claude', 'CLAUDE.md'), '# 另存过的\n');
  const first = run('init', { home: service, prompt: '# 默认\n' });
  assert.deepEqual(first.layout, { skills_folder: true, claude_linked: true, agy_listed: true });
  assert.ok(first.skills.some(skill => skill.name === 'discuss-participant' && skill.status === 'installed'));
  assert.ok(existsSync(join(home, '.claude', 'skills', 'discuss-participant', 'SKILL.md')), 'Claude sees the shared folder through the junction');
  assert.deepEqual(JSON.parse(readFileSync(join(home, '.gemini', 'config', 'skills.json'), 'utf8')).entries.map(entry => entry.path), [join(home, '.agents', 'skills').replaceAll('\\', '/')]);
  // The old text became the administrator's prompt, every distinct file was kept as a copy, and the files are gone.
  assert.equal(run('status', { home: service }).prompt, '# 旧的');
  assert.equal(readFileSync(join(service, 'account-prompt-backup.md'), 'utf8'), '# 旧的\n');
  assert.equal(readFileSync(join(service, 'account-prompt-backup-claude.md'), 'utf8'), '# 另存过的\n');
  assert.ok(!existsSync(join(home, '.codex', 'AGENTS.md')) && !existsSync(join(home, '.claude', 'CLAUDE.md')));
  run('prompt', { home: service, prompt: '# 新的\n' });
  assert.equal(run('status', { home: service }).prompt, '# 新的');
  for (const path of [['.codex', 'AGENTS.md'], ['.claude', 'CLAUDE.md'], ['.gemini', 'config', 'AGENTS.md']]) assert.ok(!existsSync(join(home, ...path)));
  // The administrator's layer is apart from the account user's own: the user's settings keep theirs.
  const settings = JSON.parse(readFileSync(join(service, 'launch-settings.json'), 'utf8')).system_prompts;
  assert.equal(settings.managed, '# 新的');
  assert.equal(settings.program, undefined);
  // Repeating it keeps the prompt someone wrote and does not list the folder twice; a cleared one is not filled again.
  const again = run('init', { home: service, prompt: '# 默认\n' });
  assert.ok(Object.values(again.layout).every(Boolean));
  assert.equal(run('status', { home: service }).prompt, '# 新的');
  run('prompt', { home: service, prompt: '' });
  run('init', { home: service, prompt: '# 默认\n' });
  assert.equal(run('status', { home: service }).prompt, '', 'a prompt the administrator cleared stays cleared');
  assert.equal(JSON.parse(readFileSync(join(home, '.gemini', 'config', 'skills.json'), 'utf8')).entries.length, 1);
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { install_skills } from '../runner/discussion_skills.mjs';
import { agy_rule, agy_rules, allow_agy_command, check_command, detect_clients, detect_python } from '../runner/discussion_setup.mjs';

const CLI = fileURLToPath(new URL('../runner/codiscuss.mjs', import.meta.url));

/** Provide --version fixtures without invoking installed AI clients. */
function fixture_cli(directory, name) {
  const path = join(directory, `${name}${process.platform === 'win32' ? '.exe' : ''}`);
  if (process.platform === 'win32') {
    try { linkSync(process.execPath, path); } catch { copyFileSync(process.execPath, path); }
  } else writeFileSync(path, '#!/bin/sh\nprintf "fixture 1.0\\n"\n', { mode: 0o755 });
  return path;
}

test('agy rule matches only codiscuss website subcommands without separators', () => {
  const pattern = new RegExp(agy_rule().slice('command(regex:'.length, -1));
  assert.ok(pattern.test('codiscuss execution enter room 1 --access-file C:/data/event-1.access.json'));
  assert.ok(pattern.test('codiscuss message post room --as Gemini --file "D:/drafts/answer one.md"'));
  assert.ok(pattern.test('codiscuss --site http://127.0.0.1:8797 execution enter room 1 --access-file C:/x.json'));
  assert.ok(pattern.test('codiscuss.cmd room view room --site http://127.0.0.1:8797'));
  for (const command of ['codiscuss --site http://x service stop', 'codiscuss --site a b room view',
    'codiscuss service stop', 'codiscuss launch start --file x', 'codiscuss run pause room',
    'codiscuss api /rooms', 'codiscuss setup --yes', 'codiscuss roomx view', 'python discuss.py room view', 'x codiscuss room view']) {
    assert.equal(pattern.test(command), false, command);
  }
  for (const tail of ['; Remove-Item x', ' | Out-File x', ' $(evil)', ' `evil', ' && evil', ' > x', ' (Set-Content x changed)']) {
    assert.equal(pattern.test('codiscuss room view room' + tail), false, tail);
  }
});

test('agy setup narrows the old launch write rule to drafts and leaves user settings untouched', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'codiscuss-agy-'));
  try {
    const home = join(directory, 'service');
    const path = join(directory, '.gemini', 'antigravity-cli', 'settings.json');
    assert.equal((await allow_agy_command(home, directory, {})).status, 'pending');
    assert.equal(existsSync(path), false);
    mkdirSync(join(directory, '.gemini', 'antigravity-cli'), { recursive: true });
    mkdirSync(home, { recursive: true });
    const previous = ['command(old-managed)', `write_file(${join(home, 'launches').replaceAll('\\', '/')})`];
    writeFileSync(join(home, 'agy-permission.json'), JSON.stringify({ rules: previous }));
    writeFileSync(path, JSON.stringify({ trustedWorkspaces: 'C:/Users/A',
      permissions: { allow: ['command(git)', ...previous], deny: ['command(sudo)'] } }));
    assert.equal((await allow_agy_command(home, directory, { yes: true })).status, 'allowed');
    assert.equal((await allow_agy_command(home, directory, {})).status, 'unchanged');
    const settings = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(settings.trustedWorkspaces, 'C:/Users/A'); assert.deepEqual(settings.permissions.deny, ['command(sudo)']);
    assert.deepEqual(settings.permissions.allow, ['command(git)', ...agy_rules(home)]);
    assert.equal(agy_rules(home)[1], `write_file(${join(home, 'drafts').replaceAll('\\', '/')})`);
    assert.ok(existsSync(join(home, 'agy-settings.backup.json')));
    writeFileSync(path, '{ broken');
    assert.equal((await allow_agy_command(home, directory, { yes: true })).status, 'invalid');
    assert.equal(readFileSync(path, 'utf8'), '{ broken');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('CLI detection is limited to Claude, Codex, agy and Cursor command aliases', () => {
  const directory = mkdtempSync(join(tmpdir(), 'codiscuss-cli fixtures-'));
  try {
    for (const command of ['claude', 'codex', 'agy', 'agent']) fixture_cli(directory, command);
    const clients = detect_clients({}, directory);
    assert.deepEqual(clients.map(item => item.key), ['codex', 'claude', 'antigravity', 'cursor']);
    assert(clients.every(item => item.executable.startsWith(directory)));
    assert.equal(clients.find(item => item.key === 'cursor').adapter, undefined);
    const agent = clients.find(item => item.key === 'cursor').executable;
    rmSync(agent);
    const alias = fixture_cli(directory, 'cursor-agent');
    assert.equal(detect_clients({}, directory).find(item => item.key === 'cursor').executable, alias);
    rmSync(alias);
    assert.equal(detect_clients({}, directory).find(item => item.key === 'cursor').executable, '');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Cursor Windows cmd launcher is probed with a fixed argument and a path containing spaces', { skip: process.platform !== 'win32' }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'codiscuss-cursor space-'));
  try {
    const path = join(directory, 'agent.cmd');
    writeFileSync(path, '@echo off\r\nif not "%~1"=="--version" exit /b 8\r\necho Cursor fixture 1.0\r\n');
    assert.equal(detect_clients({}, directory).find(item => item.key === 'cursor').executable, path);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('npm Codex binary search skips dot-prefixed upgrade leftovers', { skip: process.platform !== 'win32' }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'codiscuss-codex npm-'));
  try {
    const scope = join(directory, 'node_modules', '@openai');
    const leftover = join(scope, '.codex-awaeVzrD');
    const vendor = join(scope, 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'codex');
    for (const path of [leftover, vendor]) mkdirSync(path, { recursive: true });
    fixture_cli(leftover, 'codex');
    const current = fixture_cli(vendor, 'codex');
    assert.equal(detect_clients({}, directory).find(item => item.key === 'codex').executable, current);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('complete skills install idempotently and preserve user edits', () => {
  const directory = mkdtempSync(join(tmpdir(), 'codiscuss-skills-'));
  try {
    assert(install_skills(directory).every(item => item.status === 'installed'));
    assert(existsSync(join(directory, 'discuss-host/references/manual.md')));
    assert(existsSync(join(directory, 'discuss-report/assets/Discussion_Report_Template.md')));
    assert(install_skills(directory).every(item => item.status === 'unchanged'));
    const manifest = JSON.parse(readFileSync(join(directory, '.codiscuss-skills.json'), 'utf8'));
    writeFileSync(join(directory, 'discuss-host/extra.txt'), 'local addition');
    assert.equal(install_skills(directory)[0].status, 'conflict');
    rmSync(join(directory, 'discuss-host/extra.txt'));
    assert.equal(install_skills(directory)[0].status, 'unchanged');
    assert.deepEqual(JSON.parse(readFileSync(join(directory, '.codiscuss-skills.json'), 'utf8')), manifest);
    const path = join(directory, 'discuss-host/SKILL.md');
    writeFileSync(path, 'custom skill');
    assert.equal(install_skills(directory)[0].status, 'conflict');
    assert.equal(readFileSync(path, 'utf8'), 'custom skill');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('setup configures native CLI, preserves existing profile and uses configured Python', () => {
  const directory = mkdtempSync(join(tmpdir(), 'codiscuss-setup-'));
  const env = { ...process.env, DISCUSS_SERVICE_HOME: join(directory, 'service'), PYTHONDONTWRITEBYTECODE: '1' };
  fixture_cli(directory, 'codex');
  fixture_cli(directory, 'codiscuss');
  env.PATH = `${directory}${delimiter}${process.env.PATH || ''}`;
  const options = ['--yes', '--clients', 'codex', '--no-start', '--skills-home', directory, '--python', detect_python()];
  const execute = args => spawnSync(process.execPath, [CLI, ...args], { env, cwd: directory, encoding: 'utf8', timeout: 60000 });
  try {
    const first = execute(['setup', ...options, '--codex', process.execPath]);
    assert.equal(first.status, 2, first.stderr);
    assert.equal(JSON.parse(first.stdout).profiles[0].status, 'configured');
    const settings_path = join(env.DISCUSS_SERVICE_HOME, 'launch-settings.json');
    const settings = JSON.parse(readFileSync(settings_path, 'utf8'));
    assert.equal(settings.participants.Codex.executable, process.execPath);
    settings.participants.Codex = { adapter: 'codex', source_thread_id: 'keep-real-binding', cwd: directory };
    writeFileSync(settings_path, JSON.stringify(settings));
    const second = execute(['setup', ...options]);
    assert.equal(second.status, 2, second.stderr);
    const receipt = JSON.parse(second.stdout);
    assert.equal(receipt.status, 'needs_attention');
    assert.equal(receipt.configured, false);
    assert.equal(receipt.profiles[0].status, 'pending');
    assert.equal(receipt.profiles[0].effective.adapter, 'codex');
    assert(receipt.issues.some(issue => issue.includes('--codex')));
    assert.deepEqual(JSON.parse(readFileSync(settings_path, 'utf8')), settings);
    const updated = execute(['setup', ...options, '--codex', process.execPath]);
    assert.equal(updated.status, 2, updated.stderr);
    assert.equal(JSON.parse(updated.stdout).profiles[0].status, 'configured');
    const effective = JSON.parse(readFileSync(settings_path, 'utf8')).participants.Codex;
    assert.equal(effective.adapter, 'codex_cli');
    assert.equal(effective.executable, process.execPath);
    assert.equal(effective.cwd, directory);
    assert(!existsSync(join(env.DISCUSS_SERVICE_HOME, 'runner.lock')));
    assert(existsSync(join(directory, '.agents/skills/discuss-report/assets/Discussion_Report_Template.md')));
    const schema = execute(['schema', 'message', 'post']);
    assert.equal(schema.status, 0, schema.stderr);
    const missing = execute(['setup', ...options, '--python', join(directory, 'missing-python')]);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /Python 3\.10/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Claude, Codex and agy detection uses only executable CLI entries', () => {
  const directory = mkdtempSync(join(tmpdir(), 'codiscuss-three-cli-'));
  try {
    for (const command of ['claude', 'codex', 'agy']) fixture_cli(directory, command);
    const selected = detect_clients({}, directory).filter(client => client.adapter);
    assert.deepEqual(selected.map(client => client.key), ['codex', 'claude', 'antigravity']);
    assert(selected.every(client => client.executable.startsWith(directory)));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('install validates Python and explicit client paths before writing the package or settings', () => {
  const directory = mkdtempSync(join(tmpdir(), 'codiscuss-preflight-'));
  const prefix = join(directory, 'prefix');
  const home = join(directory, 'service');
  const env = { ...process.env, DISCUSS_SERVICE_HOME: home };
  const execute = args => spawnSync(process.execPath, [CLI, 'install', '--prefix', prefix, '--yes', '--no-start', ...args],
    { env, encoding: 'utf8', timeout: 40000 });
  try {
    const missing_python = execute(['--clients', 'none', '--python', join(directory, 'missing-python')]);
    assert.equal(missing_python.status, 1);
    assert.match(missing_python.stderr, /Python 3\.10/);
    const missing_client = execute(['--python', detect_python(), '--clients', 'claude', '--claude', join(directory, 'missing-cli')]);
    assert.equal(missing_client.status, 1);
    assert.match(missing_client.stderr, /Claude 路径无法运行/);
    assert(!existsSync(prefix));
    assert(!existsSync(home));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('skill conflicts report pending configuration and preserve the edited copy', () => {
  const directory = mkdtempSync(join(tmpdir(), 'codiscuss-conflict-'));
  const home = join(directory, 'service');
  fixture_cli(directory, 'codiscuss');
  const env = { ...process.env, DISCUSS_SERVICE_HOME: home, PATH: `${directory}${delimiter}${process.env.PATH || ''}` };
  const args = [CLI, 'setup', '--yes', '--clients', 'claude', '--claude', process.execPath,
    '--skills-home', directory, '--python', detect_python(), '--no-start'];
  const execute = () => spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 40000 });
  try {
    const first = execute();
    assert.equal(first.status, 2, first.stderr);
    const path = join(directory, '.claude/skills/discuss-host/SKILL.md');
    writeFileSync(path, 'my local skill');
    const second = execute();
    assert.equal(second.status, 2, second.stderr);
    const result = JSON.parse(second.stdout);
    assert.equal(result.configured, false);
    assert.equal(result.ai_verified, false);
    assert.equal(result.status, 'needs_attention');
    assert(result.issues.some(issue => issue.includes(join(directory, '.claude/skills/discuss-host')) && issue.includes('技能冲突')));
    assert.equal(result.skills[0].results.filter(skill => skill.status === 'unchanged').length, 2);
    assert.equal(readFileSync(path, 'utf8'), 'my local skill');
    assert.match(second.stderr, /配置待处理/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('persistent command check reports a missing command or a different installation', () => {
  const directory = mkdtempSync(join(tmpdir(), 'codiscuss-command-'));
  try {
    assert.equal(check_command(directory).status, 'missing');
    const path = fixture_cli(directory, 'codiscuss');
    const result = check_command(directory);
    assert.equal(result.status, 'shadowed');
    assert.equal(result.path, path);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

for (const [answer, status] of [['', 'retained'], ['更新', 'configured']]) {
  test(`interactive setup explicitly chooses ${status} for a mismatched profile`, () => {
    const directory = mkdtempSync(join(tmpdir(), 'codiscuss-profile-choice-'));
    const executable = fixture_cli(directory, 'codex');
    fixture_cli(directory, 'codiscuss');
    const env = { ...process.env, DISCUSS_SERVICE_HOME: directory, PATH: `${directory}${delimiter}${process.env.PATH || ''}` };
    const original = { adapter: 'codex', source_thread_id: 'keep-binding', cwd: directory };
    const settings = join(directory, 'launch-settings.json');
    writeFileSync(settings, JSON.stringify({ participants: { Codex: original } }));
    try {
      const result = spawnSync(process.execPath, ['--import', 'data:text/javascript,Object.defineProperty(process.stdin,"isTTY",{value:true})',
        CLI, 'setup', '--clients', 'codex', '--python', detect_python(), '--skills-home', directory, '--no-start'],
      { env, input: `${answer}\n`, encoding: 'utf8', timeout: 40000 });
      assert.equal(result.status, 2, result.stderr);
      const receipt = JSON.parse(result.stdout);
      assert.equal(receipt.profiles[0].status, status);
      assert(!receipt.issues.some(issue => issue.includes('不同的配置')));
      const saved = JSON.parse(readFileSync(settings, 'utf8')).participants.Codex;
      if (status === 'retained') assert.deepEqual(saved, original);
      else {
        assert.equal(saved.adapter, 'codex_cli');
        assert.equal(saved.executable, executable);
        assert.equal(saved.cwd, directory);
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}

test('Cursor setup installs complete skills without writing an unsupported launch profile', () => {
  const directory = mkdtempSync(join(tmpdir(), 'codiscuss-cursor-'));
  const home = join(directory, 'service');
  const env = { ...process.env, DISCUSS_SERVICE_HOME: home, PYTHONDONTWRITEBYTECODE: '1' };
  try {
    const cursor = fixture_cli(directory, 'agent');
    const setup = spawnSync(process.execPath, [CLI, 'setup', '--clients', 'cursor', '--cursor', cursor,
      '--skills-home', directory, '--python', detect_python(), '--no-start'], { env, encoding: 'utf8' });
    assert([0, 2].includes(setup.status), setup.stderr);
    assert.match(setup.stderr, /尚不支持全自动接入/);
    assert(existsSync(join(directory, '.cursor/skills/discuss-report/assets/Discussion_Report_Template.md')));
    assert.deepEqual(JSON.parse(readFileSync(join(home, 'launch-settings.json'), 'utf8')).participants, {});
    assert(!existsSync(join(home, 'runner.lock')));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

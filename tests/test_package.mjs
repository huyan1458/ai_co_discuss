import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const NPM = process.env.npm_execpath || join(dirname(process.execPath), process.platform === 'win32'
  ? 'node_modules/npm/bin/npm-cli.js' : '../lib/node_modules/npm/bin/npm-cli.js');

/** Start the installed package, including Python backend and built assets, outside the checkout. */
async function verify_installed_website(package_path, execute, env) {
  const cli = join(package_path, 'runner/codiscuss.mjs');
  const settings = JSON.parse(readFileSync(join(env.DISCUSS_SERVICE_HOME, 'local-settings.json'), 'utf8'));
  const port = spawnSync(settings.python, ['-c',
    'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()'], { encoding: 'utf8' });
  assert.equal(port.status, 0, port.stderr);
  try {
    const setup = execute(cli, ['setup', '--yes', '--clients', 'none', '--no-open', '--port', port.stdout.trim()]);
    assert.equal(setup.status, 0, setup.stderr);
    const result = JSON.parse(setup.stdout);
    assert.equal(result.local.running, true);
    assert.equal(result.status, 'ready');
    assert.equal(result.configured, true);
    assert.equal(result.command.status, 'ready');
    assert.equal(result.ai_verified, false);
    const website = spawnSync(settings.python, ['-c',
      'import json,sys,urllib.request; base=sys.argv[1]; assert json.load(urllib.request.urlopen(base+"/api/health"))["ok"]; assert urllib.request.urlopen(base).status==200; assert len(urllib.request.urlopen(base+"/modern.js").read())>100',
      result.local.url], { encoding: 'utf8' });
    assert.equal(website.status, 0, website.stderr);
    await verify_installed_launches(package_path, execute, env, result.local.url);
  } finally {
    const stopped = execute(cli, ['local', 'stop']);
    assert.equal(stopped.status, 0, stopped.stderr);
  }
}

/** Execute the installed CLI and retain its structured receipt for integration assertions. */
function installed_command(execute, cli, args) {
  const result = execute(cli, args);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

/** A Node executable running an exec file replaces Codex; only test acknowledgements are sent. */
function write_cli_stub(home) {
  writeFileSync(join(home, 'exec'), `const fs = require('node:fs');
    const { spawnSync } = require('node:child_process');
    const { setTimeout: delay } = require('node:timers/promises');
    const { join } = require('node:path');
    (async () => {
      const prompt = fs.readFileSync(0, 'utf8');
      const task = JSON.parse(fs.readFileSync(prompt.match(/任务文件：(.*?)，立即/)[1], 'utf8'));
      const session = 'package-test-' + task.room;
      process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: session }) + '\\n');
      for (let attempt = 0; attempt < 250; attempt++) {
        if (JSON.parse(fs.readFileSync(task.access_file, 'utf8')).session_id === session) break;
        await delay(20);
      }
      const settings = JSON.parse(fs.readFileSync(join(process.env.DISCUSS_SERVICE_HOME, 'local-settings.json'), 'utf8'));
      for (const [action, ...args] of [['enter'], ['fail', '--reason', 'package-integration-complete']]) {
        const result = spawnSync(settings.python, ['-X', 'utf8', task.cli, '--site', task.site, 'execution', action,
          task.room, String(task.event_id), '--access-file', task.access_file, ...args], { encoding: 'utf8', windowsHide: true });
        if (result.status !== 0) throw new Error(result.stderr);
      }
      process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\\n');
    })().catch(error => { process.stderr.write(error.message); process.exitCode = 1; });`);
}

/** Verify both entries against the installed website, package skills and package-external state. */
async function verify_installed_launches(package_path, execute, env, site) {
  const cli = join(package_path, 'runner/codiscuss.mjs');
  const home = env.DISCUSS_SERVICE_HOME;
  installed_command(execute, cli, ['setup', '--yes', '--clients', 'codex', '--codex', process.execPath,
    '--skills-home', dirname(home), '--no-start']);
  assert(existsSync(join(dirname(home), '.agents/skills/discuss-host/references/launch.md')));
  write_cli_stub(home);
  const input = { site, entry: 'conversation', current_session_id: 'current-package-session', cwd: home,
    room: { title: '安装后的入口验收', host: 'Codex', experts: { Codex: 'cli' },
      limits: { max_rounds: 1, max_minutes: 5 }, submission_id: randomUUID() } };
  const draft = join(home, 'conversation.json');
  writeFileSync(draft, JSON.stringify(input));
  const conversation = installed_command(execute, cli, ['launch', 'start', '--file', draft]);
  const task = JSON.parse(readFileSync(conversation.current_task.task_file, 'utf8'));
  assert.equal(task.cli, join(package_path, 'runner/discuss.py'));
  assert(task.skills.every(path => path.startsWith(package_path) && existsSync(path)));
  assert(conversation.config_path.startsWith(home));
  const entered = installed_command(execute, cli, ['--site', site, 'execution', 'enter', task.room, String(task.event_id), '--access-file', task.access_file]);
  assert.equal(entered.data.status, 'started');
  installed_command(execute, cli, ['--site', site, 'execution', 'fail', task.room, String(task.event_id), '--access-file', task.access_file, '--reason', 'conversation-integration-complete']);
  const web_token = randomUUID();
  const response = await fetch(`${site}/api/local/launch`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CoDiscuss-Local': '1', Origin: site },
    body: JSON.stringify({ cwd: home, token: web_token, room: { ...input.room, submission_id: randomUUID() } }) });
  const web = await response.json();
  assert.equal(response.status, 200, JSON.stringify(web));
  let room;
  for (let attempt = 0; attempt < 40; attempt++) {
    room = await fetch(`${site}/api/rooms/${web.room.id}`).then(result => result.json());
    if (room.runtime.status === 'paused') break;
    await delay(250);
  }
  assert.equal(room.runtime.status, 'paused', 'the stub must enter and finish its delivered task');
  const config = JSON.parse(readFileSync(web.config_path, 'utf8'));
  assert.equal(config.token, web_token);
  const tasks = readdirSync(config.directory).filter(name => name.endsWith('.task.json'));
  assert.equal(tasks.length, 1);
  const delivered = JSON.parse(readFileSync(join(config.directory, tasks[0]), 'utf8'));
  assert.equal(realpathSync.native(delivered.cli), realpathSync.native(task.cli));
  assert.equal(JSON.parse(readFileSync(delivered.access_file, 'utf8')).session_id, `package-test-${web.room.id}`);
  const receipt = installed_command(execute, cli, ['--site', site, 'execution', 'view', delivered.room, String(delivered.event_id), '--access-file', web.config_path]);
  assert.equal(receipt.data.result, 'package-integration-complete');
  assert.equal(JSON.parse(readFileSync(join(home, 'rooms.json'), 'utf8')).configs.length, 2);
}

test('npm tarball installs outside the checkout and launches both entries with package-external state', async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'codiscuss-package-'));
  const prefix = join(temporary, 'prefix with space');
  const env = { ...process.env, DISCUSS_SERVICE_HOME: join(temporary, 'service'), PYTHONDONTWRITEBYTECODE: '1' };
  const execute = (entry, args) => spawnSync(process.execPath, [entry, ...args], { cwd: temporary, env, encoding: 'utf8', timeout: 90000 });
  try {
    const packed = execute(NPM, ['pack', ROOT, '--ignore-scripts', '--json', '--pack-destination', temporary]);
    assert.equal(packed.status, 0, packed.stderr);
    const tarball = JSON.parse(packed.stdout)[0];
    const files = tarball.files.map(item => item.path);
    for (const required of ['server.py', 'backend/server.py', 'backend/runtime.py', 'backend/schema.sql', 'web/modern.js',
      'runner/discuss.py', 'runner/discussion_setup.mjs', '.agents/skills/discuss-host/references/manual.md',
      '.agents/skills/discuss-host/references/launch.md',
      '.agents/skills/discuss-report/assets/Discussion_Report_Template.md']) assert(files.includes(required), required);
    assert(!files.some(path => /(^|\/)(data|node_modules|__pycache__|\.wrangler|\.dev|tests|frontend)(\/|$)|\.sqlite3$|\.pyc$/.test(path)));
    const installed = execute(NPM, ['exec', '--offline', '--cache', join(temporary, 'npm-cache'), '--yes',
      '--package', join(temporary, tarball.filename), '--', 'codiscuss', 'install', '--prefix', prefix,
      '--yes', '--clients', 'none', '--no-start', '--skills-home', temporary]);
    assert.equal(installed.status, 2, installed.stderr);
    const receipt = JSON.parse(installed.stdout);
    assert.equal(receipt.status, 'needs_attention');
    assert.equal(receipt.configured, false);
    assert(['missing', 'shadowed'].includes(receipt.command.status));
    const command_directory = process.platform === 'win32' ? prefix : join(prefix, 'bin');
    env.PATH = `${command_directory}${delimiter}${process.env.PATH || ''}`;
    const global_root = process.platform === 'win32' ? join(prefix, 'node_modules') : join(prefix, 'lib/node_modules');
    const package_path = join(global_root, 'ai_co_discuss');
    const manifest = JSON.parse(readFileSync(join(package_path, 'package.json'), 'utf8'));
    assert(!manifest.dependencies || Object.keys(manifest.dependencies).length === 0);
    assert(!existsSync(join(package_path, 'node_modules/vue')));
    const help = execute(join(package_path, 'runner/codiscuss.mjs'), ['--help']);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /install \/ setup/);
    const schema = execute(join(package_path, 'runner/codiscuss.mjs'), ['schema', 'message', 'post']);
    assert.equal(schema.status, 0, schema.stderr);
    const bin = process.platform === 'win32' ? join(prefix, 'codiscuss.cmd') : join(prefix, 'bin/codiscuss');
    const shell = process.platform === 'win32'
      ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'codiscuss --help'],
        { cwd: temporary, env: { ...env, CODISCUSS_TEST_BIN: bin }, encoding: 'utf8' })
      : spawnSync(bin, ['--help'], { cwd: temporary, env, encoding: 'utf8' });
    assert.equal(shell.status, 0, shell.stderr);
    assert.match(shell.stdout, /AI CoDiscuss CLI/);
    await verify_installed_website(package_path, execute, env);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

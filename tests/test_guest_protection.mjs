import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { api_lockdown } from '../runner/adapters/api.mjs';
import { claude_lockdown, claude_rule_path } from '../runner/adapters/claude.mjs';
import { createServer } from 'node:http';

import { chat_task_files, free_task_files, FreeRoomRunner, protection_pause } from '../runner/free_runner.mjs';
import { guest_protection, guest_state_of, guest_withheld } from '../runner/host_permissions.mjs';
import { site_command } from '../runner/site_deploy.mjs';

/** A room with one Claude Code member writing its project, without a website or a real model. */
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'guest-protection-'));
  const project = mkdtempSync(join(tmpdir(), 'guest-project-'));
  t.after(() => [directory, `${directory}-drafts`, project].forEach(path => rmSync(path, { recursive: true, force: true })));
  return { project, config: { site: 'http://127.0.0.1:1', room: 'r', directory, project: resolve('.'), cwd: project,
    members: { Claude: { token: 'c'.repeat(32) } }, participants: { Claude: { adapter: 'claude', project_access: 'write', cwd: project } } } };
}

const execution = id => ({ id, read_until: 0, requests: [{ id, message_id: 9, purpose: 'ask' }] });

test('only an active visit’s conservative or trust mode counts as an external user in the room', () => {
  assert.equal(guest_protection({ phase: 'active', mode: 'conservative' }), 'conservative');
  assert.equal(guest_protection({ phase: 'active', mode: 'trust' }), 'trust');
  assert.equal(guest_protection({ phase: 'waiting', mode: 'conservative' }), '', 'a waiting guest holds dispatch on the site, not here');
  assert.equal(guest_protection({ phase: 'none', mode: 'none' }), '');
  assert.equal(guest_protection(null), '');
});

test('the host’s withheld controls are refused, reads and the kept controls are not', () => {
  for (const action of ['access', 'adapter', 'invite', 'back', 'room-post', 'create-room', 'workflow-adopt', 'workflow-promote']) assert.ok(guest_withheld(action), action);
  assert.ok(guest_withheld('model', {}) && !guest_withheld('model', { list: true }));
  assert.ok(guest_withheld('checkin', { minutes: '10' }) && !guest_withheld('checkin', { off: true }));
  assert.ok(guest_withheld('discussion', { do: 'start' }) && guest_withheld('goal', { do: 'resume' }) && !guest_withheld('goal', { do: 'end' }) && !guest_withheld('discussion', {}));
  for (const action of ['stop', 'stop-all', 'steer', 'retry', 'withdraw', 'order', 'away', 'remove', 'label', 'guest-disconnect']) assert.ok(!guest_withheld(action), action);
});

test('in the conservative level software that cannot be confined is paused; the trusted level pauses no one', () => {
  assert.equal(protection_pause({ adapter: 'claude', project_access: 'full' }, 'conservative'), '');
  assert.match(protection_pause({ adapter: 'codex_cli', project_access: 'read' }, 'conservative'), /暂停接单/);
  assert.match(protection_pause({ adapter: 'codex', project_access: 'write' }, 'conservative'), /暂停接单/);
  assert.match(protection_pause({ adapter: 'claude', project_access: 'own' }, 'conservative'), /暂停接单/);
  assert.equal(protection_pause({ adapter: 'codex_cli', project_access: 'full' }, 'trust'), '');
  assert.equal(protection_pause({ adapter: 'codex_cli', project_access: 'full' }, ''), '');
});

test('a conservative run is confined to reading the project in both the task file and the launch, and the setting stays', t => {
  const { config, project } = fixture(t);
  const task = free_task_files(config, { name: 'Claude', role: 'member' }, execution(1), {}, { protection: 'conservative' });
  const written = JSON.parse(readFileSync(task.task_path, 'utf8'));
  assert.equal(written.project_access, 'read');
  assert.equal(written.protection.level, 'conservative');
  assert.equal(task.profile.project_access, 'read');
  assert.equal(config.participants.Claude.project_access, 'write', 'the owner’s setting is not rewritten');
  assert.ok(task.tool_lockdown && task.lockdown_read_directories.includes(project));
  const args = claude_lockdown(task);
  const rule = claude_rule_path(project);
  assert.ok(args.includes(`Read(${rule}/**)`), 'the project is readable');
  assert.ok(!args.some(arg => arg.startsWith(`Edit(${rule}`)), 'the project is not writable');
  assert.ok(!args.includes('Bash') && !args.includes('PowerShell'), 'no command beyond codiscuss');
  assert.ok(args.includes('WebFetch') && args.includes('WebSearch'));
  // The codiscuss CLI may name project files only to read them.
  const scope = JSON.parse(readFileSync(task.access_path, 'utf8')).file_scope;
  assert.ok(scope.read.includes(project) && !scope.write.includes(project));
  // Trusted, or no external user: the member's own setting, no confinement.
  const trusted = free_task_files(config, { name: 'Claude', role: 'member' }, execution(2), {}, { protection: 'trust' });
  assert.equal(trusted.profile.project_access, 'write');
  assert.equal(trusted.tool_lockdown, undefined);
});

test('a conservative model API run keeps read-only project file tools and no web', () => {
  const task = api_lockdown({ tool_lockdown: true, lockdown_read_directories: ['/p'],
    api_context: { cwd: '/p', project_access: 'write', extra_directories: [{ path: '/q', access: 'write' }], commands: { list: ['x'] } } });
  assert.equal(task.api_context.cwd, '/p');
  assert.equal(task.api_context.project_access, 'read');
  assert.deepEqual(task.api_context.extra_directories, [{ path: '/q', access: 'read' }]);
  assert.equal(task.api_context.commands, undefined);
  assert.ok(task.api_context.no_web);
  // A member lent to another computer's room still gets no project at all.
  assert.equal(api_lockdown({ tool_lockdown: true, api_context: { cwd: '/p' } }).api_context.cwd, undefined);
});

test('a wrapped, bare or nested guest State reads the same, and an unreadable answer is not taken for "no guest"', () => {
  const state = { phase: 'active', mode: 'conservative', guest: { id: 'g' } };
  for (const answer of [state, { ok: true, data: state }, { ok: true, data: { state } }, { state }]) assert.deepEqual(guest_state_of(answer), state);
  assert.equal(guest_state_of({ ok: true, data: {} }), null);
  assert.equal(guest_state_of(null), null);
});

test('a private chat in a conservative room runs in the protected level too', t => {
  const { config, project } = fixture(t);
  const chat = chat_task_files(config, { name: 'Claude', role: 'member' }, { id: 5, text: '看看这个文件' }, {}, { protection: 'conservative' });
  assert.equal(chat.profile.project_access, 'read');
  assert.ok(chat.tool_lockdown && chat.lockdown_read_directories.includes(project));
  assert.match(chat.prompt, /外部用户在场/);
  assert.equal(chat_task_files(config, { name: 'Claude', role: 'member' }, { id: 6, text: 'x' }, {}, {}).tool_lockdown, undefined);
});

/** A website answering the guest routes from `answers`, recording each POST. */
async function guest_site(t, answers) {
  // This loopback fixture has its own service home and does not implement the instance handshake.
  const home = mkdtempSync(join(tmpdir(), 'guest-site-'));
  const previous = { DISCUSS_ENTRY_KEY_FILE: process.env.DISCUSS_ENTRY_KEY_FILE, DISCUSS_SERVICE_HOME: process.env.DISCUSS_SERVICE_HOME };
  delete process.env.DISCUSS_ENTRY_KEY_FILE;
  process.env.DISCUSS_SERVICE_HOME = home;
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(home, { recursive: true, force: true });
  });
  const posts = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const tail = request.url.replace(/^\/api\/rooms\/r/, '');
      if (request.method === 'POST') posts.push({ tail, body: JSON.parse(body || '{}') });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(answers[tail] ?? {}));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { site: `http://127.0.0.1:${server.address().port}`, posts };
}

/** Just what the admission and expiry steps read of the runner. */
function runner_like(site, guest_state, rows = [], processes = new Map()) {
  return { config: { site, room: 'r', token: 'o'.repeat(32) }, guest_state, members: processes, log: () => {},
    store: { db: { prepare: () => ({ all: () => rows }) } }, read_guest_state: FreeRoomRunner.prototype.read_guest_state };
}

test('a waiting external user is let in only once no local run is left', async t => {
  const active = { phase: 'active', mode: 'conservative', server_time: 1, guest: { id: 'g', expires_at: 900_000 } };
  const { site, posts } = await guest_site(t, { '/guest/activate': { ok: true, data: { state: active } } });
  const waiting = { phase: 'waiting', mode: 'none', hold_dispatch: true, server_time: 1, invite_expires_at: 900_000, guest: { id: 'g' } };
  await FreeRoomRunner.prototype.admit_guest.call(runner_like(site, waiting, [{ status: 'running' }]));
  await FreeRoomRunner.prototype.admit_guest.call(runner_like(site, waiting, [], new Map([['Claude', new Set([{}])]])));
  assert.equal(posts.length, 0, 'a running execution or a tracked process holds the admission');
  const runner = runner_like(site, waiting, [{ status: 'idle' }]);
  await FreeRoomRunner.prototype.admit_guest.call(runner);
  assert.deepEqual(posts, [{ tail: '/guest/activate', body: { guest_id: 'g' } }]);
  assert.equal(guest_protection(runner.guest_state), 'conservative');
});

test('a visit is recorded as expired only once the site’s own clock passes its deadline', async t => {
  const { site, posts } = await guest_site(t, { '/guest/expire': { ok: true, data: { state: { phase: 'ended', mode: 'none' } } } });
  const visit = server_time => ({ phase: 'active', mode: 'trust', server_time, guest: { id: 'g', expires_at: 1000 } });
  await FreeRoomRunner.prototype.expire_guest.call(runner_like(site, visit(999)));
  assert.equal(posts.length, 0);
  const runner = runner_like(site, visit(1000));
  await FreeRoomRunner.prototype.expire_guest.call(runner);
  assert.deepEqual(posts, [{ tail: '/guest/expire', body: { guest_id: 'g' } }]);
  assert.equal(guest_protection(runner.guest_state), '');
});

test('a member cannot publish a site while an external user is in the room; a failed read refuses too', async t => {
  const home = mkdtempSync(join(tmpdir(), 'guest-publish-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const answer = body => async () => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const input = { room_id: 'r', site: 'http://127.0.0.1:1', token: 'm'.repeat(32), member: 'Claude', dir: home };
  for (const body of [{ ok: true, data: { phase: 'active', mode: 'trust' } }, { ok: true, data: { phase: 'waiting', mode: 'none' } }]) {
    await assert.rejects(site_command(home, 'site-publish', input, { fetcher: answer(body) }), error => error.code === 'guest_present');
  }
  const failed = async () => new Response('{}', { status: 500, headers: { 'Content-Type': 'application/json' } });
  await assert.rejects(site_command(home, 'site-publish', input, { fetcher: failed }), error => error.code === 'guest_present');
});

/** Run the codiscuss CLI as a restricted member would: lockdown on, its task credential bound by environment. */
function restricted_cli(t, command, { bound_token = 'b'.repeat(40), env = {} } = {}) {
  const folder = mkdtempSync(join(tmpdir(), 'guest-lockdown-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const bound = join(folder, 'task.access.json');
  writeFileSync(bound, JSON.stringify({ site: 'http://127.0.0.1:9', room: 'own', member: 'Claude', token: bound_token }));
  const empty = join(folder, 'empty.json');
  writeFileSync(empty, '{}');
  const args = command({ bound, empty });
  const result = spawnSync(process.execPath, [resolve('runner/codiscuss.mjs'), ...args], { encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, CODISCUSS_LANG: 'zh-CN', DISCUSS_ACCESS: '', CODISCUSS_TOOL_LOCKDOWN: '1', CODISCUSS_LOCKDOWN_DIRECTORY: folder, DISCUSS_ACCESS_FILE: bound, ...env } });
  return { ...result, output: `${result.stdout}${result.stderr}` };
}

test('a restricted run cannot swap its task credential for an empty file, inline credentials or another room', t => {
  // Node commands (launch, site) and the Python ones refuse another --access-file before any request.
  for (const args of [({ empty }) => ['site', 'publish', '--dir', '.', '--access-file', empty],
    ({ empty }) => ['launch', 'host-control', 'stop-all', '--access-file', empty],
    ({ empty }) => ['room', 'view', 'other', '--access-file', empty]]) {
    const result = restricted_cli(t, args);
    assert.notEqual(result.status, 0);
    assert.match(result.output, /只能使用本次任务绑定的凭据/, result.output);
  }
  // Inline credentials, and a bound file without a valid token, are refused too.
  assert.match(restricted_cli(t, () => ['room', 'view', 'own'], { env: { DISCUSS_ACCESS: '{"site":"http://127.0.0.1:9"}' } }).output, /只能使用本次任务绑定的凭据/);
  assert.match(restricted_cli(t, () => ['room', 'view', 'own'], { bound_token: '' }).output, /只能使用本次任务绑定的凭据/);
  // With its own credential, another room is still not readable while restricted.
  const other = restricted_cli(t, () => ['room', 'view', 'other']);
  assert.notEqual(other.status, 0);
  assert.match(other.output, /凭据文件不属于本次站点和房间/, other.output);
});

test('a request traced to an external user’s message is told its skill names are no call', t => {
  const { config } = fixture(t);
  const guest = { id: 3, read_until: 0, requests: [{ id: 3, message_id: 9, purpose: 'ask', origin: { kind: 'guest', guest_id: 'g', label: '访客', root_message_id: 9 } }] };
  const task = JSON.parse(readFileSync(free_task_files(config, { name: 'Claude', role: 'member' }, guest, {}, {}).task_path, 'utf8'));
  assert.match(task.instructions, /不作为调用本机技能/);
  const owner = JSON.parse(readFileSync(free_task_files(config, { name: 'Claude', role: 'member' }, execution(4), {}, {}).task_path, 'utf8'));
  assert.doesNotMatch(owner.instructions, /不作为调用本机技能/);
});

test('the confined Claude hook lets through only one codiscuss subcommand whose arguments hold only safe characters', async () => {
  const { allowed_command, decide, literal_words } = await import('../runner/adapters/claude_lockdown_hook.mjs');
  // Kept: paths with spaces and single backslashes in quotes, Chinese text, --body-file drafts, --name="value", quoted lists.
  for (const command of ['codiscuss schema', 'codiscuss room view r', 'codiscuss launch host-control stop-all', 'codiscuss.cmd message post --body-file d.md',
    'codiscuss message post --body-file "C:\\Users\\A B\\drafts\\回答.md"', "codiscuss message post --body-file 'C:/A B/回答.md'",
    'codiscuss message post --body 已提交，见上文', 'codiscuss message post --body "已核对 #123 的结论，可以采用"', "codiscuss message post --body '中文 正文'",
    'codiscuss message post --body-file="D:\\a b\\x.md"', "codiscuss launch host-control order --order '甲,乙' --revision abc123",
    'codiscuss message list r --after 15128', 'codiscuss message post --body a#b', 'codiscuss room view r --x C:/a']) {
    assert.ok(allowed_command(command), command);
  }
  assert.deepEqual(literal_words('codiscuss message post --body-file="D:\\a b\\x.md"'), ['codiscuss', 'message', 'post', '--body-file=D:\\a b\\x.md']);
  // Refused: other programs, prefixes, chaining, expansion of any kind, and any other character even inside quotes (#15153).
  for (const command of ['echo hi', 'whoami', 'netstat -an', 'Write-Output x', 'Get-Location', 'curl http://127.0.0.1:8765',
    'CODISCUSS_TOOL_LOCKDOWN=0 codiscuss schema', "$env:CODISCUSS_TOOL_LOCKDOWN='0'; codiscuss schema", 'codiscuss schema && echo x',
    'codiscuss schema | more', 'codiscuss room view $(whoami)', 'codiscuss service stop', 'codiscuss schema\necho x', 'codiscuss\tschema', '',
    'codiscuss message post --body (Get-Content C:/Windows/win.ini)', 'codiscuss message post --body $env:USERPROFILE', 'codiscuss message post @args',
    'codiscuss message post --body "a`nb"', 'codiscuss message post --body {Get-Content x}', 'codiscuss message post --body "$(Get-Content x)"',
    'codiscuss message post --body $HOME', 'codiscuss message post --body ${HOME}', 'codiscuss message post --body `cat x`',
    'codiscuss message post --body-file *.md', 'codiscuss message post --body-file ?.md', 'codiscuss message post --body-file [a].md',
    'codiscuss message post --body-file ~/x.md', 'codiscuss message post --body a!b', 'codiscuss message post --body-file {a,b}.md',
    // cmd.exe reads these again inside quotes when the line goes through codiscuss.cmd.
    'codiscuss message post --body "a & b"', 'codiscuss message post --body "a | b"', 'codiscuss message post --body "a > b"', 'codiscuss message post --body "(a)"',
    'codiscuss message post --body "a ^ b"', 'codiscuss message post --body "%USERPROFILE%"', 'codiscuss message post --body "a ! b"', "codiscuss message post --body 'a ; b'",
    // Backslashes: none bare, never two in a row, never last.
    'codiscuss message post --body-file C:\\a.md', 'codiscuss message post --body-file "C:\\a\\\\b.md"', 'codiscuss message post --body-file "C:\\a\\"',
    // Forms PowerShell passes on changed through codiscuss.ps1, unquoted.
    'codiscuss launch host-control order --order 甲,乙', 'codiscuss room view r --x -- --y', 'codiscuss room view r --x -a:b',
    // Quoting the shells read differently, left open or empty; curly quotes; a comment.
    "codiscuss message post --body 'a''b'", "codiscuss message post --body 'open", 'codiscuss message post --body x"y"', 'codiscuss message post --body ""',
    'codiscuss message post --body “中文”', 'codiscuss message post --body #comment']) {
    assert.ok(!allowed_command(command), command);
  }
  assert.equal(decide({ tool_name: 'Bash', tool_input: { command: 'echo hi' } }).code, 2);
  assert.match(decide({ tool_name: 'PowerShell', tool_input: { command: 'codiscuss message post --body "a & b"' } }).message, /--body-file/);
  assert.equal(decide({ tool_name: 'Read', tool_input: { file_path: 'x' } }).code, 0, 'other tools are left to their own rules');
});
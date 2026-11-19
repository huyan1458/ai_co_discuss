// A task with `tool_lockdown: true` (an external member's AI on another computer) runs only where the software can be
// confined to the codiscuss subcommands; these check the arguments the adapters build, without starting any AI software.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { agy_rule, antigravity_cli } from '../runner/adapters/antigravity_cli.mjs';
import { api_lockdown, execute_tool, participant_tools, system_prompt } from '../runner/adapters/api.mjs';
import { claude_lockdown, claude_lockdown_env, claude_rule_path } from '../runner/adapters/claude.mjs';
import { TASK_SUBCOMMANDS } from '../runner/adapters/common.mjs';
import { deliver_task, lockdown_support } from '../runner/adapters/index.mjs';
import { ADAPTER_IDS, ADAPTER_PROFILES } from '../runner/adapters/profiles.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'lockdown-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = Object.fromEntries(['member', 'drafts', 'skills', 'project', 'other'].map(name => [name, join(root, name)]));
  for (const path of Object.values(paths)) mkdirSync(path, { recursive: true });
  writeFileSync(join(paths.member, 'free-1.access.json'), '{}');
  const task = { id: 'free-1', directory: paths.member, member_directory: paths.member, draft_directory: paths.drafts,
    skill_directories: [paths.skills], extra_directories: [{ path: paths.other, access: 'write' }], access_path: join(paths.member, 'free-1.access.json'),
    prompt: 'hi', images: [], tool_lockdown: true, on_output() {}, on_process() {}, on_binding() {}, on_failure() {}, on_exit() {} };
  return { root, paths, task };
}

/** A spawn stand-in that records the call and starts nothing. */
function recorder() {
  const calls = [];
  const spawn_process = (executable, args, options) => {
    calls.push({ executable, args, options });
    const child = new EventEmitter();
    Object.assign(child, { stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null, pid: 1, kill() {} });
    child.stdin = Object.assign(new EventEmitter(), { writableEnded: false, write() {}, end() {} });
    setImmediate(() => child.emit('spawn'));
    return child;
  };
  return { calls, spawn_process };
}

test('every adapter declares whether it can be confined, and says why when it cannot', () => {
  for (const id of ADAPTER_IDS) {
    const declared = ADAPTER_PROFILES[id].capabilities.tool_lockdown;
    assert.equal(typeof declared, 'boolean', id);
    const support = lockdown_support(id);
    assert.equal(support.supported, declared, id);
    if (!declared) assert.ok(support.reason, `${id} gives a reason`);
  }
  assert.deepEqual(ADAPTER_IDS.filter(id => lockdown_support(id).supported).sort(), ['antigravity_cli', 'api', 'claude']);
  assert.equal(lockdown_support('claude', { project_access: 'own' }).supported, false, 'a taken-over session keeps its own permissions');
  assert.equal(lockdown_support('nope').supported, false);
});

test('a confined task on software that cannot be confined starts nothing and says why', async t => {
  const { task } = fixture(t);
  for (const [config, pattern] of [[{ adapter: 'codex_cli' }, /Codex CLI 不能收窄/],
    [{ adapter: 'claude', project_access: 'own', session_id: 'abc' }, /托管的已有会话/]]) {
    const { calls, spawn_process } = recorder();
    await assert.rejects(deliver_task(config, {}, task, spawn_process), error =>
      pattern.test(error.message) && error.code === 'tool_lockdown_unsupported' && error.delivery_status === 'not_sent');
    assert.equal(calls.length, 0, config.adapter);
  }
});

test('confined Claude runs only the codiscuss subcommands and reads only its skills, drafts and own folder', async t => {
  const { paths, task } = fixture(t);
  const args = claude_lockdown(task);
  for (const flag of ['--restricted', '--safe-mode', '--strict-mcp-config', '--disable-slash-commands', '--no-chrome']) assert.ok(args.includes(flag), flag);
  assert.equal(args[args.indexOf('--tools') + 1], 'Bash,PowerShell,Read,Write,Edit');
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
  // CLAUDE_CODE_SUBPROCESS_ENV_SCRUB turns dontAsk back into default (2.1.325), so nothing may be left to ask.
  assert.equal(args[args.indexOf('--permission-prompts') + 1], 'none');
  assert.equal(args[args.indexOf('--mcp-config') + 1], '{"mcpServers":{}}');
  const allowed = args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--disallowedTools'));
  assert.deepEqual(allowed.filter(rule => /^(Bash|PowerShell)/.test(rule)),
    TASK_SUBCOMMANDS.flatMap(command => [`Bash(codiscuss ${command} *)`, `PowerShell(codiscuss ${command} *)`]), 'no whole Bash, no other command');
  assert.deepEqual(allowed.filter(rule => rule.startsWith('Edit(')), [`Edit(${claude_rule_path(paths.drafts)}/**)`]);
  assert.deepEqual(allowed.filter(rule => rule.startsWith('Read(')).sort(),
    [paths.member, paths.drafts, paths.skills].map(path => `Read(${claude_rule_path(path)}/**)`).sort());
  assert.deepEqual(args.slice(args.indexOf('--disallowedTools') + 1), ['WebFetch', 'WebSearch']);
  for (const path of [paths.project, paths.other]) assert.ok(!args.some(arg => arg.includes(path) || arg.includes(claude_rule_path(path))), path);

  const { calls, spawn_process } = recorder();
  const config = { adapter: 'claude', executable: 'claude.exe', cwd: paths.project, project_access: 'write', allowed_tools: ['Bash(git *)'] };
  await deliver_task(config, {}, task, spawn_process);
  const [{ args: run, options }] = calls;
  assert.equal(options.cwd, paths.drafts, 'never the member project');
  assert.ok(!run.includes('Bash') && !run.includes('Bash(git *)') && !run.includes('bypassPermissions'), 'project access and owner rules are ignored');
  assert.ok(run.includes('--restricted'));
  assert.equal(options.env.CODISCUSS_TOOL_LOCKDOWN, '1');
  assert.equal(options.env.CODISCUSS_LOCKDOWN_DIRECTORY, paths.drafts);
  assert.equal(options.env.DISCUSS_ACCESS_FILE, task.access_path);

  const { calls: plain, spawn_process: plain_spawn } = recorder();
  await deliver_task(config, {}, { ...task, tool_lockdown: false }, plain_spawn);
  assert.ok(!plain[0].args.includes('--restricted') && plain[0].args.includes('Bash'), 'an unconfined task keeps its access level');
  assert.equal(plain[0].options.env.CODISCUSS_TOOL_LOCKDOWN, undefined);
});

test('confined agy allows only the codiscuss commands, opens no project and denies what the user allowed agy for itself', t => {
  const { root, paths, task: base } = fixture(t);
  const task = { ...base, participant: 'Gemini-ext' };
  const home = join(root, 'home'), cli_settings = join(home, '.gemini', 'antigravity-cli');
  mkdirSync(cli_settings, { recursive: true });
  const config = { adapter: 'antigravity_cli', executable: 'agy.exe', cwd: paths.project, project_access: 'full', allowed_tools: ['command(git *)'] };
  const { args, env } = antigravity_cli.invocation(config, {}, task, home);
  const settings = JSON.parse(readFileSync(args[args.indexOf('--settings') + 1], 'utf8')).permissions;
  const rule = path => `write_file(${path.replaceAll('\\', '/')})`;
  assert.deepEqual(settings.allow, [agy_rule(), rule(paths.drafts)], 'no project, no other command, no owner grant');
  assert.ok(settings.deny.includes('mcp(*)') && settings.deny.includes('read_url(*)'));
  assert.ok(!args.includes('--dangerously-skip-permissions'), 'full access is ignored');
  for (const path of [paths.project, paths.other]) assert.ok(!args.includes(path), path);
  assert.deepEqual(env, { CODISCUSS_TOOL_LOCKDOWN: '1', CODISCUSS_LOCKDOWN_DIRECTORY: paths.drafts });

  // The user's own grants stay in their settings; beyond codiscuss commands, the confined session denies each of them.
  const own = ["command(regex:^(\\$env:DISCUSS_ACCESS='[^']*'; )?codiscuss(\\.cmd)?( [^;&|]*)?$)", 'command(lark-cli docs +fetch)', 'read_file(*)'];
  writeFileSync(join(cli_settings, 'settings.json'), JSON.stringify({ permissions: { allow: own } }));
  const again = antigravity_cli.invocation(config, {}, task, home).args;
  const denied = JSON.parse(readFileSync(again[again.indexOf('--settings') + 1], 'utf8')).permissions.deny;
  assert.ok(denied.includes('command(lark-cli docs +fetch)') && denied.includes('read_file(*)'));
  assert.ok(!denied.includes(own[0]), 'codiscuss grants are left alone');
  assert.throws(() => antigravity_cli.invocation({ ...config, session_id: 's' }, { session_id: 's' }, task, home), /托管的已有会话/);
});

test('confined Claude keeps the user settings env, which --restricted would drop', t => {
  const { root, task } = fixture(t);
  writeFileSync(join(root, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://proxy.example', BAD: 1 }, permissions: { allow: ['Bash'] } }));
  const env = claude_lockdown_env(task, { CLAUDE_CONFIG_DIR: root });
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://proxy.example');
  assert.equal(env.BAD, undefined);
  assert.equal(env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, '1');
  assert.equal(claude_lockdown_env(task, { CLAUDE_CONFIG_DIR: join(root, 'missing') }).CODISCUSS_TOOL_LOCKDOWN, '1');
});

test('a confined model API member keeps only its room tools', () => {
  const api_context = { site: 'http://127.0.0.1:1', room: 'r', token: 't', cwd: '/project', workdir: '/project', project_access: 'write',
    extra_directories: [{ path: '/other', access: 'write' }], commands: { directory: '/wf', list: [{ id: 'x', access: 'read' }] }, image_generation: true };
  const confined = api_lockdown({ tool_lockdown: true, api_context }).api_context;
  assert.deepEqual(confined, { site: 'http://127.0.0.1:1', room: 'r', token: 't', project_access: 'read', no_web: true });
  const plain = { tool_lockdown: false, api_context };
  assert.equal(api_lockdown(plain), plain);
});

test('an external model API task reads the inviting computer project through repo tools, as codiscuss repo does', async () => {
  const access = { transport: 'external', record: '0123456789abcdef', room: 'r', member: 'M', execution_id: 3 };
  const names = context => participant_tools({ role: 'member', ...context }).map(item => item.name);
  assert.ok(!names({}).some(name => name.startsWith('repo_')), 'only an external task has them');
  const calls = [];
  const context = { role: 'member', home: '/service', external_access: access, signal: new AbortController().signal,
    repo_command: async (home, op, options, given) => {
      calls.push({ home, op, options, given });
      if (options.path === 'secret.env') throw Object.assign(new Error('该文件属于固定排除的敏感文件，不能读取'), { reason: 'excluded' });
      return { ok: true, op };
    } };
  const definitions = participant_tools(context);
  assert.deepEqual(definitions.filter(item => item.name.startsWith('repo_')).map(item => item.name), ['repo_list', 'repo_read', 'repo_grep']);
  assert.deepEqual((await execute_tool(context, { name: 'repo_list', arguments: {} }, definitions)).result, { ok: true, op: 'ls' });
  await execute_tool(context, { name: 'repo_read', arguments: { root: 0, path: 'a.md', offset: 10, max_bytes: 100 } }, definitions);
  await execute_tool(context, { name: 'repo_grep', arguments: { root: 1, query: 'x', path: 'src', case_sensitive: true, max_results: 5 } }, definitions);
  assert.deepEqual(calls.map(({ op, options }) => [op, options]), [['ls', {}], ['read', { root: 0, path: 'a.md', offset: 10, max_bytes: 100 }],
    ['grep', { root: 1, query: 'x', path: 'src', case_sensitive: true, max_results: 5 }]]);
  assert.ok(calls.every(call => call.home === '/service' && call.given === access));
  assert.deepEqual((await execute_tool(context, { name: 'repo_read', arguments: { root: 0, path: 'secret.env' } }, definitions)).result,
    { error: '该文件属于固定排除的敏感文件，不能读取', reason: 'excluded' }, 'a refusal goes back to the model');
  assert.match(system_prompt({ participant: 'M', role: 'member', external_access: access }), /repo_list \/ repo_read \/ repo_grep/);
  assert.equal(api_lockdown({ tool_lockdown: true, api_context: { cwd: '/p', external_access: access } }).api_context.external_access, access, 'confinement keeps them');
});

test('an external model API task reaches its room only through the A-side relay entry, never the site directly', async t => {
  const { paths } = fixture(t);
  const access = { transport: 'external', record: '0123456789abcdef', room: 'r1', member: 'M', execution_id: 7 };
  const sent = [];
  let answer = { status: 200, body: { receipt: { submission_id: 'x', message_id: 9 } } };
  const context = { role: 'member', participant: 'M', room: 'r1', execution_id: 7, home: '/service', directory: paths.member, task_id: 'external-7',
    site: 'http://127.0.0.1:9', external_access: access, signal: new AbortController().signal,
    proxy_request: async (home, request) => {
      sent.push({ home, ...request });
      if (request.method === 'POST') return answer;
      return { status: 200, body: request.path.includes('/messages') ? { messages: [{ id: 1, text: 'hi' }] } : { id: 'r1', title: 'T' } };
    } };
  const definitions = participant_tools(context);
  assert.deepEqual(definitions.map(item => item.name).sort(),
    ['read_message', 'read_messages', 'read_room', 'repo_grep', 'repo_list', 'repo_read', 'submit_chat']);
  assert.deepEqual((await execute_tool(context, { name: 'read_room', arguments: {} }, definitions)).result, { id: 'r1', title: 'T' });
  await execute_tool(context, { name: 'read_messages', arguments: { after: 3 } }, definitions);
  const saved = await execute_tool(context, { name: 'submit_chat', arguments: { text: '答复' } }, definitions);
  assert.equal(saved.terminal, true);
  assert.deepEqual(sent.map(({ method, path }) => [method, path.split('?')[0]]),
    [['GET', '/api/rooms/r1'], ['GET', '/api/rooms/r1/messages'], ['POST', '/api/rooms/r1/messages']]);
  assert.ok(sent.every(item => item.home === '/service' && item.access === access));
  assert.match(sent[1].path, /execution_id=7/);
  assert.equal(sent[2].body.text, '答复');
  assert.equal(sent[2].body.execution_id, 7);
  assert.match(sent[2].body.submission_id, /^api-/);
  answer = { status: 409, body: { error: '执行已结束' } };
  assert.match((await execute_tool(context, { name: 'submit_chat', arguments: { text: '迟到' } }, definitions)).result.error, /房间 HTTP 409: 执行已结束/);
});

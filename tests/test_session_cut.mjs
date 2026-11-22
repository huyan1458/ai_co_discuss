/** Branch member sessions before taken-back executions, from each software's own session format; originals stay intact. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { branch_session, execution_marker, session_exists, session_preview, software_sessions } from '../runner/adapters/index.mjs';
import { browse_sessions } from '../runner/discussion_launch.mjs';
import { destroy_room_sessions } from '../runner/room_destruction.mjs';

const SESSION = '11111111-2222-3333-4444-555555555555';
const prompt = id => `请先读取任务文件：D:/runs/${execution_marker(id)}，完成后提交。`;

function home_fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'codiscuss-cut-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

const lines = entries => `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`;

test('Claude forks on its next turn at the last answer before the first taken-back prompt', async t => {
  const home = home_fixture(t), directory = join(home, '.claude', 'projects', 'D--p');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${SESSION}.jsonl`), lines([
    { type: 'user', uuid: 'u1', message: { content: prompt(1) } },
    { type: 'assistant', uuid: 'a1' },
    { type: 'user', uuid: 't1', message: { content: [{ type: 'tool_result', content: execution_marker(2) }] } },
    { type: 'assistant', uuid: 'a2' },
    { type: 'user', uuid: 'u2', message: { content: [{ type: 'text', text: prompt(2) }] } },
    { type: 'assistant', uuid: 'a3' },
  ]));
  const profile = { adapter: 'claude' }, options = { home, env: {} };
  const cut = await branch_session(profile, SESSION, [2, 3], options);
  assert.deepEqual(cut.fork, { from: SESSION, at: 'a2' });
  assert.match(cut.session_id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(await branch_session(profile, SESSION, [1], options), { session_id: '' });
  assert.equal(await branch_session(profile, SESSION, [9], options), null);
  assert.equal((await branch_session(profile, SESSION, [9], { ...options, always: true })).fork.at, '');
  assert.ok(session_exists('claude', SESSION, options));
  assert.equal(session_exists('claude', cut.session_id, options), false);
  await assert.rejects(branch_session(profile, 'missing', [1], options), /找不到 Claude 会话/);
});

/** A Codex app server that answers initialize and thread/fork, recording what it was asked. */
function codex_server(calls) {
  return (executable, args) => {
    const child = new EventEmitter();
    Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => {} });
    calls.push({ executable, args });
    child.stdin.on('data', chunk => {
      for (const line of String(chunk).split('\n').filter(Boolean)) {
        const message = JSON.parse(line);
        calls.push(message);
        if (message.method === 'initialize') child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
        if (message.method === 'thread/fork') child.stdout.write(`${JSON.stringify({ id: message.id, result: { thread: { id: 'forked-thread' } } })}\n`);
      }
    });
    return child;
  };
}

test('Codex forks through the turn before the first taken-back prompt with its app server', async t => {
  const home = home_fixture(t), directory = join(home, '.codex', 'sessions', '2026', '10', '28');
  mkdirSync(directory, { recursive: true });
  const user = id => ({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt(id) }] } });
  writeFileSync(join(directory, `rollout-2026-10-28T20-10-07-${SESSION}.jsonl`), lines([
    { type: 'session_meta', payload: { id: SESSION } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } }, user(1),
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-2' } }, user(2),
  ]));
  const calls = [], profile = { adapter: 'codex_cli', executable: 'codex.exe' };
  const options = { home, env: {}, spawn_process: codex_server(calls) };
  assert.deepEqual(await branch_session(profile, SESSION, [2], options), { session_id: 'forked-thread' });
  assert.deepEqual(calls[0], { executable: 'codex.exe', args: ['app-server'] });
  assert.deepEqual(calls.find(call => call.method === 'thread/fork').params, { threadId: SESSION, excludeTurns: true, lastTurnId: 'turn-1' });
  assert.deepEqual(await branch_session(profile, SESSION, [1], options), { session_id: '' });
  assert.equal(await branch_session(profile, SESSION, [7], options), null);
  calls.length = 0;
  assert.deepEqual(await branch_session(profile, SESSION, [7], { ...options, always: true }), { session_id: 'forked-thread' });
  assert.equal(calls.find(call => call.method === 'thread/fork').params.lastTurnId, undefined);
});

test('agy copies its conversation database without the steps from the first taken-back prompt on', async t => {
  const home = home_fixture(t), directory = join(home, '.gemini', 'antigravity-cli', 'conversations');
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `${SESSION}.db`);
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE trajectory_meta (trajectory_id TEXT PRIMARY KEY, cascade_id TEXT); CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_payload BLOB)');
  db.prepare('INSERT INTO trajectory_meta VALUES (?,?)').run('trajectory', SESSION);
  const payload = text => Buffer.concat([Buffer.from([0x0a, 0x10]), Buffer.from(text, 'utf8')]);
  [prompt(1), 'answer', prompt(2), 'answer'].forEach((text, idx) => db.prepare('INSERT INTO steps VALUES (?,?)').run(idx, payload(text)));
  db.close();
  const profile = { adapter: 'antigravity_cli' }, options = { home, env: {} };
  const cut = await branch_session(profile, SESSION, [2], options);
  const copy = new DatabaseSync(join(directory, `${cut.session_id}.db`), { readOnly: true });
  assert.deepEqual(copy.prepare('SELECT idx FROM steps ORDER BY idx').all().map(row => row.idx), [0, 1]);
  assert.equal(copy.prepare('SELECT cascade_id FROM trajectory_meta').get().cascade_id, cut.session_id);
  copy.close();
  const original = new DatabaseSync(file, { readOnly: true });
  assert.equal(original.prepare('SELECT COUNT(*) AS count FROM steps').get().count, 4);
  original.close();
  assert.deepEqual(await branch_session(profile, SESSION, [1], options), { session_id: '' });
  assert.equal(await branch_session(profile, SESSION, [5], options), null);
  const whole = await branch_session(profile, SESSION, [5], { ...options, always: true });
  const kept = new DatabaseSync(join(directory, `${whole.session_id}.db`), { readOnly: true });
  assert.equal(kept.prepare('SELECT COUNT(*) AS count FROM steps').get().count, 4);
  kept.close();
  assert.ok(readFileSync(file).length);
});

test('a model API member copies its Pi session up to the first taken-back prompt into a new session', async t => {
  const home = home_fixture(t), directory = join(home, '.codiscuss', 'pi', 'sessions');
  mkdirSync(directory, { recursive: true });
  const user = (id, parent, execution) => ({ type: 'message', id, parentId: parent,
    message: { role: 'user', content: [{ type: 'text', text: `{"room":{}}\n\n（执行标记 ${execution_marker(execution)}，无需处理）` }] } });
  const assistant = (id, parent) => ({ type: 'message', id, parentId: parent, message: { role: 'assistant', content: [] } });
  const original = lines([{ type: 'session', version: 3, id: SESSION, cwd: home },
    { type: 'model_change', id: 'm0', parentId: null, provider: 'codiscuss', modelId: 'deepseek-flash' },
    user('u1', 'm0', 1), assistant('a1', 'u1'), user('u2', 'a1', 2), assistant('a2', 'u2')]);
  const file = join(directory, `2026-11-11T00-00-00-000Z_${SESSION}.jsonl`);
  writeFileSync(file, original);
  const profile = { adapter: 'api' };
  const copy_of = id => readFileSync(join(directory, readdirSync(directory).find(name => name.endsWith(`_${id}.jsonl`))), 'utf8')
    .trim().split('\n').map(line => JSON.parse(line));

  assert.equal(await branch_session(profile, SESSION, [3], { home }), null, 'nothing taken back is in the session');
  const cut = await branch_session(profile, SESSION, [2], { home });
  assert.ok(session_exists('api', cut.session_id, { home }));
  const copy = copy_of(cut.session_id);
  assert.deepEqual(copy.map(entry => entry.id), [cut.session_id, 'm0', 'u1', 'a1']);
  assert.equal(copy[0].parentSession, file);
  assert.equal(readFileSync(file, 'utf8'), original);
  assert.deepEqual(await branch_session(profile, SESSION, [1], { home }), { session_id: '' }, 'a cut before every prompt starts anew');
  // A forked room copies the whole session; one bound before Pi ran API members has no session here and starts anew.
  assert.deepEqual(copy_of((await branch_session(profile, SESSION, [], { home, always: true })).session_id).length, 6);
  assert.deepEqual(await branch_session(profile, 'api-0000', [], { home, always: true }), { session_id: '' });
});

test('stored conversations are listed newest first with their titles and previewed without injected context', t => {
  const home = home_fixture(t), options = { home, env: {} };
  const project = join(home, 'project'), elsewhere = join(home, 'elsewhere');
  const claude = join(home, '.claude', 'projects', 'D--p');
  mkdirSync(claude, { recursive: true });
  const titled = '22222222-2222-3333-4444-555555555555';
  writeFileSync(join(claude, `${SESSION}.jsonl`), lines([
    { type: 'user', cwd: elsewhere, message: { content: '<system-reminder>injected</system-reminder>compare the two layouts' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'The second one.' }] } },
  ]));
  writeFileSync(join(claude, `${titled}.jsonl`), lines([
    { type: 'user', cwd: project, timestamp: '2026-11-15T00:00:00.000Z', message: { content: 'first prompt' } },
    { type: 'user', isMeta: true, message: { content: 'meta' } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'output' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }, { type: 'text', text: 'done' }] } },
    { type: 'ai-title', aiTitle: 'machine title' }, { type: 'custom-title', customTitle: 'owner title' },
  ]));
  utimesSync(join(claude, `${SESSION}.jsonl`), new Date(1000), new Date(1000));
  const listed = software_sessions('claude', options);
  assert.equal(listed.available, true);
  assert.deepEqual(listed.sessions.map(session => [session.id, session.title, session.cwd]),
    [[titled, 'owner title', project], [SESSION, 'compare the two layouts', elsewhere]]);
  assert.equal(listed.next_offset, null);
  assert.deepEqual(software_sessions('claude', { ...options, query: 'LAYOUTS' }).sessions.map(session => session.id), [SESSION]);
  assert.deepEqual(software_sessions('claude', { ...options, cwd: project }).sessions.map(session => session.id), [titled]);
  assert.deepEqual(software_sessions('claude', { ...options, limit: 1 }).next_offset, 1);
  const preview = session_preview('claude', titled, options);
  assert.deepEqual(preview.messages.map(message => [message.role, message.text]), [['user', 'first prompt'], ['assistant', 'done']]);
  assert.equal(preview.cwd, project);
  assert.throws(() => session_preview('claude', '33333333-2222-3333-4444-555555555555', options), /找不到 Claude 会话/);

  const threads = join(home, '.codex', 'sessions', '2026', '11', '15');
  mkdirSync(threads, { recursive: true });
  const thread = '01a1de46-e39a-73f2-874e-b38731e8465c', review = '01a1de46-e39a-73f2-874e-b38731e84000';
  const message = (role, text) => ({ type: 'response_item', payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } });
  writeFileSync(join(threads, `rollout-2026-11-15T00-00-00-${thread}.jsonl`), lines([
    { type: 'session_meta', payload: { id: thread, cwd: project, thread_source: 'user' } },
    message('user', '# AGENTS.md instructions for the project'), message('user', '<environment_context>shell</environment_context>'),
    message('user', 'say hello'), message('assistant', 'Hello.'),
  ]));
  writeFileSync(join(threads, `rollout-2026-11-15T00-00-01-${review}.jsonl`), lines([{ type: 'session_meta', payload: { id: review, cwd: project, thread_source: 'guardian_review' } }]));
  writeFileSync(join(home, '.codex', 'session_index.jsonl'), lines([{ id: thread, thread_name: 'old name' }, { id: thread, thread_name: 'Respond to greeting' }]));
  for (const adapter of ['codex_cli', 'codex']) {
    assert.deepEqual(software_sessions(adapter, options).sessions.map(session => [session.id, session.title]), [[thread, 'Respond to greeting']], adapter);
  }
  assert.deepEqual(session_preview('codex_cli', thread, options).messages.map(item => item.text), ['say hello', 'Hello.']);

  // agy: titles and folders from its own index, prompts and replies from the conversation's protobuf steps.
  const agy = join(home, '.gemini', 'antigravity-cli'), conversation = '7acccfdf-7685-4e43-81a0-ff89f4caab17', room_made = 'a0713e60-0f23-4746-aeb9-ca591552a8cf';
  mkdirSync(join(agy, 'conversations'), { recursive: true });
  const varint = value => { const bytes = []; do { bytes.push((value & 127) | (value > 127 ? 128 : 0)); value = Math.floor(value / 128); } while (value); return bytes; };
  const field = (number, value) => typeof value === 'number' ? Buffer.from([...varint(number * 8), ...varint(value)])
    : (body => Buffer.concat([Buffer.from([...varint(number * 8 + 2), ...varint(body.length)]), body]))(Buffer.isBuffer(value) ? value : Buffer.from(value));
  const index = new DatabaseSync(join(agy, 'conversation_summaries.db'));
  index.exec(`CREATE TABLE conversation_summaries (conversation_id text, title text, preview text, workspace_uris text, app_data_dir text,
    project_id text, agent_name text DEFAULT '', parent_conversation_id text DEFAULT '', nesting_depth integer DEFAULT 0)`);
  const summary = index.prepare('INSERT INTO conversation_summaries (conversation_id,title,preview,workspace_uris,app_data_dir,project_id) VALUES (?,?,?,?,?,?)');
  summary.run(conversation, '', 'compare the agy layouts', JSON.stringify([pathToFileURL(project).href]), 'antigravity-cli', 'default-cli-project');
  summary.run(room_made, '', 'room task', JSON.stringify([pathToFileURL(project).href]), 'antigravity-cli', 'outside-of-project');
  index.close();
  for (const id of [conversation, room_made]) {
    const db = new DatabaseSync(join(agy, 'conversations', `${id}.db`));
    db.exec('CREATE TABLE steps (idx integer PRIMARY KEY, step_type integer, step_payload blob)');
    const step = db.prepare('INSERT INTO steps VALUES (?,?,?)');
    step.run(0, 14, Buffer.concat([field(5, field(1, field(1, 1794787200))), field(19, field(2, 'say hello'))]));
    step.run(1, 17, Buffer.alloc(0));
    step.run(2, 15, field(20, field(1, 'Hello.')));
    db.close();
  }
  assert.deepEqual(software_sessions('antigravity_cli', options).sessions.map(session => [session.id, session.title, session.cwd]),
    [[conversation, 'compare the agy layouts', project]]);
  assert.deepEqual(session_preview('antigravity_cli', conversation, options).messages.map(item => [item.role, item.text, item.at]),
    [['user', 'say hello', '2026-11-16T00:00:00.000Z'], ['assistant', 'Hello.', '']]);
  assert.throws(() => session_preview('antigravity_cli', room_made, options), /找不到可续接的 agy 会话/);

  // A request without the computer owner's standing sees only conversations made in folders it may use.
  const list = (adapter, extra) => software_sessions(adapter, { ...options, ...extra });
  const preview_of = (adapter, id) => session_preview(adapter, id, options);
  const accept = cwd => cwd === project;
  assert.deepEqual(browse_sessions({ adapter: 'claude' }, { accept, list }).sessions.map(session => session.id), [titled]);
  assert.equal(browse_sessions({ adapter: 'claude', action: 'preview', session_id: titled }, { accept, preview: preview_of }).title, 'owner title');
  assert.throws(() => browse_sessions({ adapter: 'claude', action: 'preview', session_id: SESSION }, { accept, preview: preview_of }), /未允许/);
  assert.throws(() => browse_sessions({ adapter: 'unknown' }), /适配器/);
  assert.throws(() => browse_sessions({ adapter: 'claude', offset: -1 }), /分页/);
});

test('a destroyed room removes the sessions it created with their copies and keeps borrowed or shared ones', t => {
  const home = home_fixture(t), env = {}, room = join(home, 'room'), projects = join(home, '.claude', 'projects', 'D--p');
  const own = SESSION, borrowed = '22222222-2222-3333-4444-555555555555', shared = '33333333-2222-3333-4444-555555555555';
  mkdirSync(projects, { recursive: true });
  mkdirSync(join(projects, own, 'subagents'), { recursive: true });
  for (const id of [own, borrowed, shared]) writeFileSync(join(projects, `${id}.jsonl`), lines([{ type: 'user', sessionId: id }]));
  writeFileSync(join(home, '.claude', 'history.jsonl'), lines([{ display: '秘密', sessionId: own }, { display: '别的', sessionId: borrowed }]));
  const codex = join(home, '.codex', 'sessions', '2026', '11', '22'), thread = '44444444-2222-3333-4444-555555555555';
  mkdirSync(codex, { recursive: true });
  writeFileSync(join(codex, `rollout-2026-11-22T00-00-00-${thread}.jsonl`), lines([{ type: 'session_meta', payload: { id: thread } }]));
  writeFileSync(join(home, '.codex', 'session_index.jsonl'), lines([{ id: thread, thread_name: '机密' }]));
  mkdirSync(room, { recursive: true });
  const db = new DatabaseSync(join(room, 'runtime.sqlite3'));
  db.exec('CREATE TABLE bindings(participant TEXT PRIMARY KEY,session_id TEXT NOT NULL)');
  for (const [name, id] of [['Claude', own], ['Borrowed', borrowed], ['Shared', shared], ['Codex', thread]]) db.prepare('INSERT INTO bindings VALUES (?,?)').run(name, id);
  db.close();
  const config = { directory: room, participants: { Claude: { adapter: 'claude' }, Borrowed: { adapter: 'claude', session_id: borrowed },
    Shared: { adapter: 'claude' }, Codex: { adapter: 'codex_cli' } } };
  const rewound = '55555555-2222-3333-4444-555555555555';
  writeFileSync(join(projects, `${rewound}.jsonl`), lines([{ type: 'user', sessionId: rewound }]));
  const items = destroy_room_sessions(config, new Set([shared]), { env, home }, { Claude: [rewound, 'never-ran-here'] });
  assert.deepEqual(items.filter(item => item.kind === 'sessions'), [{ kind: 'sessions', adapter: 'claude', state: 'deleted', count: 2 },
    { kind: 'sessions', adapter: 'codex_cli', state: 'deleted', count: 1 }]);
  assert.deepEqual(items.find(item => item.kind === 'kept_sessions'), { kind: 'kept_sessions', state: 'kept', count: 2 });
  assert.equal(session_exists('claude', own, { env, home }), false);
  assert.deepEqual(readdirSync(projects).sort(), [`${borrowed}.jsonl`, `${shared}.jsonl`].sort());
  // The software's shared prompt history and thread index are reported as kept, never rewritten.
  assert.match(readFileSync(join(home, '.claude', 'history.jsonl'), 'utf8'), /秘密/);
  assert.deepEqual(items.filter(item => item.kind === 'software_stores').map(item => item.adapter), ['claude', 'codex_cli']);
  assert.equal(session_exists('codex_cli', thread, { env, home }), false);
});

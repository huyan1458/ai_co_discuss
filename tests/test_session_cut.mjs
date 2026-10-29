/** Branch member sessions before taken-back executions, from each software's own session format; originals stay intact. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { branch_session, execution_marker, session_exists } from '../runner/session_cut.mjs';

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

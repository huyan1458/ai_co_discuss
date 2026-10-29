/** A forked room registers its local members on branches of the source room's sessions; the source stays as it was. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fork_room } from '../runner/discussion_launch.mjs';
import { DiscussionStore } from '../runner/discussion_runner.mjs';
import { read_registry, register_room } from '../runner/discussion_service.mjs';
import { execution_marker } from '../runner/session_cut.mjs';

test('forking registers members on branches of their sessions without the executions left out', async t => {
  const home = mkdtempSync(join(tmpdir(), 'discussion-fork-'));
  const saved = process.env.CLAUDE_CONFIG_DIR;
  const source_token = 'source-owner'.repeat(4), token = 'forked-owner'.repeat(4);
  const tokens = { source: source_token, forked: token };
  const server = createServer((request, response) => {
    const room = request.url.split('/')[3];
    const ok = request.headers['x-discussion-token'] === tokens[room];
    response.writeHead(ok ? 200 : 403, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(!ok ? { error: '凭据无效' } : request.url.endsWith('/inbox') ? { members: [] }
      : { mode: 'free', free: { members: ['Claude', 'Codex'].map(name => ({ name, access: 'runner', status: 'away' })) } }));
  });
  await new Promise(resolve_listen => server.listen(0, '127.0.0.1', resolve_listen));
  t.after(async () => {
    saved === undefined ? delete process.env.CLAUDE_CONFIG_DIR : process.env.CLAUDE_CONFIG_DIR = saved;
    await new Promise(resolve_close => server.close(resolve_close));
    rmSync(home, { recursive: true, force: true });
  });
  process.env.CLAUDE_CONFIG_DIR = join(home, 'claude');
  const sessions = join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'work');
  mkdirSync(sessions, { recursive: true });
  const claude_log = join(sessions, 'claude-session-1.jsonl');
  const log = [
    { type: 'user', uuid: 'u1', cwd: home, message: { content: `读取 ${execution_marker(7)}` } }, { type: 'assistant', uuid: 'a1', cwd: home },
    { type: 'user', uuid: 'u2', cwd: home, message: { content: `读取 ${execution_marker(9)}` } }, { type: 'assistant', uuid: 'a2', cwd: home }];
  writeFileSync(claude_log, `${log.map(entry => JSON.stringify(entry)).join('\n')}\n`);
  const site = `http://127.0.0.1:${server.address().port}`;
  const path = join(home, 'source.json');
  writeFileSync(path, JSON.stringify({ site, room: 'source', token: source_token, mode: 'free', data_directory: join(home, 'runtime'),
    members: { Claude: { token: 'claude-member'.repeat(3) }, Codex: { token: 'codex-member'.repeat(3) } }, participants: {
      Claude: { adapter: 'claude', executable: process.execPath },
      Codex: { adapter: 'codex_cli', executable: process.execPath } } }));
  register_room(home, path);
  const source_store = new DiscussionStore(join(home, 'runtime'));
  source_store.bind('Claude', 'claude-session-1');
  source_store.close();

  const input = { site, room_id: 'forked', token, source_room_id: 'source', source_token, executions: { Claude: [9], Codex: [3] } };
  await assert.rejects(() => fork_room(home, { ...input, source_token: 'wrong-owner'.repeat(4) }), /HTTP 403/);
  const result = await fork_room(home, input);
  assert.deepEqual(result, { room_id: 'forked', registered: true, members: [{ name: 'Claude', status: 'forked' }, { name: 'Codex', status: 'fresh' }] });
  const forked_path = read_registry(home).find(item => item !== resolve(path));
  const forked = JSON.parse(readFileSync(forked_path, 'utf8'));
  assert.equal(forked.room, 'forked');
  assert.deepEqual(forked.keep_manual, []);
  assert.equal(forked.participants.Claude.cwd, home, 'Claude works where its session was recorded');
  assert.equal('session_id' in forked.participants.Claude, false);
  const store = new DiscussionStore(forked.data_directory);
  const binding = store.binding('Claude').session_id;
  const pending = JSON.parse(store.db.prepare("SELECT value FROM metadata WHERE key='session-fork:Claude'").get().value);
  store.close();
  assert.match(binding, /^[0-9a-f-]{36}$/);
  assert.deepEqual(pending, { from: 'claude-session-1', at: 'a1' });
  assert.equal(readFileSync(claude_log, 'utf8').split('\n').filter(Boolean).length, 4, 'the source session is untouched');
  await assert.rejects(() => fork_room(home, input), /已在本机登记/);
});

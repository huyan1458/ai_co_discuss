/** Verify release isolation, static routing, and the direct D1 deployment contract. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import vm from "node:vm";

import { build_pages } from "../scripts/build_pages.mjs";
import worker from "../backend/worker.mjs";
import updates_worker, { DiscussionUpdates } from "../backend/updates.mjs";

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Load the actual browser fork_snapshot function without evaluating the rest of the page. */
async function load_fork_snapshot() {
  const source = await readFile(join(PROJECT_ROOT, 'web', 'app.js'), 'utf8');
  const start = source.indexOf('function fork_snapshot(');
  const end = source.indexOf('\n}\n\n/** Copy the fork\'s attachment files', start) + 2;
  assert.ok(start >= 0 && end > start, 'fork_snapshot source is present');
  return vm.runInNewContext(`${source.slice(start, end)}\nfork_snapshot`);
}

/** Load the real topic save handler with only its browser and network edges replaced. */
async function load_topic_save_handler(browser) {
  const source = await readFile(join(PROJECT_ROOT, 'web', 'app.js'), 'utf8');
  const web_start = source.indexOf('function is_web_member(member) {');
  const web_end = source.indexOf('\n}\n\n/** Read and validate the current composer', web_start) + 2;
  const members_start = source.indexOf('function topic_member_requests(room, experts) {');
  const members_end = source.indexOf('\n}\n\n/** Save owner-edited topic data', members_start) + 2;
  const save_start = source.indexOf('async function save_topic(event) {');
  const save_end = source.indexOf('\n}\n\n/** Schedule an expert', save_start) + 2;
  assert.ok(web_start >= 0 && web_end > web_start && members_start >= 0 && members_end > members_start
    && save_start >= 0 && save_end > save_start, 'topic save functions are present');
  return vm.runInNewContext(`(() => {
    const MEMBER_PENDING_PREFIX = "discuss-member-pending:";
    ${source.slice(web_start, web_end)}
    ${source.slice(members_start, members_end)}
    ${source.slice(save_start, save_end)}
    return save_topic;
  })()`, browser);
}

/** Run Worker SQL transactions locally with a deterministic concurrent-write hook. */
async function worker_fixture(test_case) {
  const sql = new DatabaseSync(':memory:');
  sql.exec(await readFile(join(PROJECT_ROOT, 'backend', 'schema.sql'), 'utf8'));
  test_case.after(() => sql.close());
  const fixture = { sql, before_batch: null, objects: new Map() };
  fixture.bucket = {
    put: async (key, bytes) => { fixture.objects.set(key, new Uint8Array(bytes)); },
    get: async key => fixture.objects.has(key) ? { body: new Response(fixture.objects.get(key)).body } : null,
    delete: async key => { fixture.objects.delete(key); },
    head: async key => fixture.objects.has(key) ? {} : null,
  };
  function prepare(query, values = []) {
    const statement = sql.prepare(query);
    const execute = () => ({ results: statement.all(...values), meta: sql.prepare('SELECT changes() AS changes').get() });
    return { bind: (...args) => prepare(query, args), execute,
      all: async () => execute(), run: async () => execute(),
      first: async column => { const row = statement.get(...values); return column ? row?.[column] ?? null : row ?? null; } };
  }
  const database = { prepare, batch: async statements => {
    const mutation = fixture.before_batch;
    fixture.before_batch = null;
    mutation?.();
    sql.exec('BEGIN IMMEDIATE');
    try { const results = statements.map(statement => statement.execute()); sql.exec('COMMIT'); return results; }
    catch (error) { sql.exec('ROLLBACK'); throw error; }
  } };
  fixture.env = { DB: database, ATTACHMENTS: fixture.bucket };
  fixture.member_tokens = {};
  fixture.request = async (path, payload, token) => {
    if (payload && path === '' && payload.mode !== 'free') {
      const experts = payload.experts ?? { Codex: 'cli', Claude: 'online', Gemini: 'online', DeepSeek: 'online', Qwen: 'online' };
      payload = { ...payload, members: payload.members ?? Object.entries(experts).map(([name, mode]) => ({ name,
        token: fixture.member_tokens[name] ??= crypto.randomUUID(),
        access: mode === 'online' ? 'online' : payload.runtime_mode === 'automatic' ? 'runner' : 'manual' })) };
    }
    const actor = payload?.actor ?? payload?.submitted_by ?? payload?.author ?? '用户';
    token ??= path === '' || actor === '用户' ? 'owner-credential'.repeat(3) : fixture.member_tokens[actor] || '';
    const response = await worker.fetch(new Request(`https://discussion.test/api/rooms${path}`, {
      method: payload === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'X-Discussion-Token': token },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    }), fixture.env);
    return { status: response.status, body: await response.json() };
  };
  fixture.raw = (path, options = {}, bucket = fixture.bucket) => worker.fetch(
    new Request(`https://discussion.test/api/rooms${path}`, { ...options,
      headers: { 'X-Discussion-Token': 'owner-credential'.repeat(3), ...options.headers } }), { ...fixture.env, ATTACHMENTS: bucket || undefined });
  return fixture;
}

/** Bind the hub to a test namespace and track invalidations without opening public writes. */
function bind_updates(fixture) {
  const hub = new DiscussionUpdates(), notifications = [];
  fixture.env.UPDATES = { idFromName: name => name, get: channel => ({
    fetch: (input, init) => {
      const request = new Request(input, init);
      if (request.method === "POST") notifications.push(channel);
      return hub.fetch(request);
    },
  }) };
  return { hub, notifications };
}

test('Worker revisions move with the writes of each room and with directory changes, like Python', async t => {
  const f = await worker_fixture(t);
  const first = await free_worker_room(f, []);
  const second = await f.request('', { title: '另一议题', goal: 'x', mode: 'free', submission_id: 'free-worker-revisions',
    members: [{ name: 'Claude', adapter: 'claude', token: 'claude-second'.repeat(4) }] }, 'owner-second'.repeat(4));
  assert.equal(second.status, 201, JSON.stringify(second.body));
  const site = async (path, init) => worker.fetch(new Request(`https://discussion.test${path}`, init), f.env);
  const revisions = async () => {
    const response = await site(`/api/revisions?rooms=${first.room.id},${second.body.id},missing`);
    assert.equal(response.status, 200);
    return response.json();
  };
  const before = await revisions();
  assert.deepEqual(Object.keys(before.rooms).sort(), [first.room.id, second.body.id].sort(), 'a missing room is left out');
  assert.deepEqual(await revisions(), before, 'reading changes nothing');
  await first.say('新消息');
  const after = await revisions();
  assert.ok(after.rooms[first.room.id] > before.rooms[first.room.id]);
  assert.equal(after.rooms[second.body.id], before.rooms[second.body.id]);
  assert.ok(after.site > before.site);
  await site('/api/folders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '甲组' }) });
  const moved = await revisions();
  assert.ok(moved.site > after.site, 'a directory change raises only the site revision');
  assert.deepEqual(moved.rooms, after.rooms);
});

test('Worker message pages honor a bounded limit, like Python', async t => {
  const f = await worker_fixture(t);
  const room = (await f.request('', { title: '分页' })).body;
  for (let index = 0; index < 25; index++) {
    const posted = await f.request(`/${room.id}/messages`, { author: '用户', text: `第 ${index} 条`, submission_id: `paging-${index}` });
    assert.equal(posted.status, 201, JSON.stringify(posted.body));
  }
  const plain = (await f.request(`/${room.id}/messages?after=0`)).body;
  assert.deepEqual([plain.messages.length, plain.has_more], [20, true]);
  const wide = (await f.request(`/${room.id}/messages?after=0&limit=200`)).body;
  assert.deepEqual([wide.messages.length, wide.has_more, wide.pages], [25, false, 1]);
  const capped = (await f.request(`/${room.id}/messages?page=1&limit=5000`)).body;
  assert.equal(capped.messages.length, 25, 'a limit above the cap is clamped, not rejected');
  assert.equal((await f.request(`/${room.id}/messages?limit=abc`)).status, 400);
});

test('Worker manual member credentials are scoped and revocation is checked in the write transaction', async t => {
  const f = await worker_fixture(t);
  const member = 'manual-credential'.repeat(3), r = await free_worker_room(f, [{ name: 'Qwen', access: 'manual', token: member }]);
  const path = r.path;
  assert.equal((await f.request(`${path}/register`, {}, member)).status, 200);
  const message = (await r.say('请 Qwen 回答', { to: ['Qwen'] })).body.message;
  const request = (await f.request(`${path}/inbox`, undefined, r.owner)).body.observers[0].pending[0];
  const answer = { author: 'Qwen', text: '已回答', request_ids: [request.id], submission_id: 'manual-revocation-answer' };
  for (const token of ['', crypto.randomUUID(), r.claude, r.owner]) assert.equal((await f.request(`${path}/messages`, answer, token)).status, 403);
  f.before_batch = () => f.sql.prepare("UPDATE room_members SET status='removed' WHERE room_id=? AND name='Qwen'").run(r.room.id);
  assert.equal((await f.request(`${path}/messages`, answer, member)).status, 409);
  assert.equal((await f.request(path)).body.latest_id, message.id);
  const public_data = JSON.stringify([(await f.request(path)).body, (await f.request(`${path}/backup`)).body]);
  for (const token of [r.claude, member, r.owner]) assert.ok(!public_data.includes(token));
  assert.doesNotMatch(public_data, /token_hash|control_hash/);
});

test('Worker proxies only active online members and rechecks that identity atomically', async t => {
  const f = await worker_fixture(t);
  const r = await free_worker_room(f), token = 'online-proxy'.repeat(4);
  assert.equal((await f.request(`${r.path}/members`, { name: 'Qwen', token, access: 'online' }, r.owner)).status, 200);
  await r.say('请 Qwen 回答', { to: ['Qwen'] });
  const request = (await f.request(`${r.path}/inbox`, undefined, r.owner)).body.observers[0].pending[0];
  const answer = { author: 'Qwen', submitted_by: '用户', text: '在线原文', request_ids: [request.id], submission_id: 'proxy-answer' };
  assert.equal((await f.request(`${r.path}/messages`, answer, token)).status, 403);
  f.before_batch = () => f.sql.prepare("UPDATE room_members SET status='removed' WHERE room_id=? AND name='Qwen'").run(r.room.id);
  assert.equal((await f.request(`${r.path}/messages`, answer, r.owner)).status, 409);
  assert.equal((await f.request(r.path)).body.message_count, 1);
});

test('Worker creation retries bind the full credential set and reject reused member secrets', async t => {
  const f = await worker_fixture(t);
  const owner = crypto.randomUUID(), first = crypto.randomUUID(), second = crypto.randomUUID();
  const payload = { title: '固定凭证', host: 'Codex', experts: { Codex: 'cli', Claude: 'cli' }, submission_id: 'credential-replay',
    members: [{ name: 'Codex', access: 'manual', token: first }, { name: 'Claude', access: 'manual', token: second }] };
  assert.equal((await f.request('', payload, '')).status, 400);
  const created = await f.request('', payload, owner);
  assert.equal(created.status, 201);
  assert.equal((await f.request('', payload, owner)).body.id, created.body.id);
  assert.equal((await f.request('', payload, crypto.randomUUID())).status, 409);
  assert.equal((await f.request('', { ...payload, members: payload.members.map(item => ({ ...item, token: crypto.randomUUID() })) }, owner)).status, 409);
  assert.equal((await f.request('', { ...payload, submission_id: 'another-create', members: payload.members.map(item => ({ ...item, token: first })) }, owner)).status, 400);
});

test('Pages streams committed changes across aliases and rejects public notification writes', async t => {
  const f = await worker_fixture(t), { notifications, hub } = bind_updates(f);
  const response = await worker.fetch(new Request('https://alias.test/api/updates'), f.env);
  assert.match(response.headers.get('Content-Type'), /^text\/event-stream/);
  const reader = response.body.getReader(), decode = value => new TextDecoder().decode(value);
  t.after(() => reader.cancel());
  assert.match(decode((await reader.read()).value), /event: ready/);
  const room = (await f.request('', { title: '事件更新' })).body;
  assert.equal(decode((await reader.read()).value), 'event: change\ndata: {}\n\n');
  assert.equal((await f.request(`/${room.id}`)).body.title, '事件更新', 'data is committed before notification');
  assert.deepEqual(notifications, ['default']);
  assert.equal((await f.request(`/${room.id}/messages`, { author: '用户', text: '' })).status, 400);
  assert.equal(notifications.length, 1, 'rejected writes do not trigger refresh');
  assert.equal((await f.request(`/${room.id}/messages`, { author: '用户', text: '指名房间', submission_id: 'push-room' })).status, 201);
  assert.equal(decode((await reader.read()).value), `event: change\ndata: {"rooms":["${room.id}"]}\n\n`);
  assert.equal((await worker.fetch(new Request('https://alias.test/api/updates', { method: 'POST' }), f.env)).status, 404);
  assert.equal(updates_worker.fetch().status, 404);
  await reader.cancel();
  assert.equal(hub.clients.size, 0);
  assert.equal(hub.heartbeat, null);
});

test('Pages without a push binding retains reads and tells EventSource to stop reconnecting', async t => {
  const f = await worker_fixture(t);
  assert.equal((await worker.fetch(new Request('https://discussion.test/api/updates'), f.env)).status, 204);
  assert.equal((await f.request('', { title: '轮询兼容' })).status, 201);
});

test('Pages publishes discussion changes but not ordinary execution lease renewal', async t => {
  const f = await worker_fixture(t);
  const r = await free_worker_room(f, [{ name: 'Codex', token: 'push-codex'.repeat(4) }]);
  const { notifications } = bind_updates(f);
  const initial = (await f.request(`${r.path}/discussion`)).body;
  assert.equal((await f.request(`${r.path}/discussion`, { action: 'start', revision: initial.revision, goal: '推送变更' }, r.owner)).status, 200);
  assert.equal(notifications.length, 1, 'session state changes are published');
  await f.request(`${r.path}/discussion`, { action: 'end', revision: (await f.request(`${r.path}/discussion`)).body.revision }, r.owner);
  await r.say('lease', { to: ['Codex'] });
  const execution = (await r.reserve('Codex')).body;
  notifications.length = 0;
  assert.equal((await f.request(`${r.path}/executions/${execution.id}`, { action: 'renew' }, r.owner)).status, 200);
  assert.equal(notifications.length, 0);
  assert.equal((await f.request(`${r.path}/messages`, { author: 'Codex', text: 'lease renewed', execution_id: execution.id,
    submission_id: 'push-lease-answer' }, 'push-codex'.repeat(4))).status, 201);
  assert.equal(notifications.length, 1);
});

test('push failures cannot turn committed writes into failed API responses', async t => {
  const f = await worker_fixture(t);
  f.env.UPDATES = { idFromName() { throw new Error('hub unavailable'); } };
  const log = console.error;
  console.error = () => {};
  try {
    const result = await f.request('', { title: '推送中断' });
    assert.equal(result.status, 201);
    assert.equal((await f.request(`/${result.body.id}`)).body.title, '推送中断');
  } finally { console.error = log; }
});

test('hub disconnects slow subscribers and releases resources after reconnect', async () => {
  const hub = new DiscussionUpdates();
  const slow = hub.fetch(new Request('https://updates.internal/'));
  for (let index = 0; index < 20; index++) hub.broadcast('event: change\ndata: {}\n\n');
  await assert.rejects(slow.text(), /too slow/);
  assert.equal(hub.clients.size, 0);
  assert.equal(hub.heartbeat, null);
  const fresh = hub.fetch(new Request('https://updates.internal/')).body.getReader();
  assert.match(new TextDecoder().decode((await fresh.read()).value), /event: ready/);
  await fresh.cancel();
});

test('Worker attachments preserve bytes and metadata through upload, publication, replay and deletion', async t => {
  const f = await worker_fixture(t);
  const room = (await f.request('', { title: '附件' })).body;
  const data = new TextEncoder().encode('%PDF-1.7\noriginal document');
  const params = new URLSearchParams({ actor: '用户', file_name: '中文资料.pdf', submission_id: 'upload-pdf' });
  const upload = () => f.raw(`/${room.id}/attachments?${params}`, { method: 'POST', body: data });
  const response = await upload();
  assert.equal(response.status, 201);
  const file = (await response.json()).attachment;
  assert.equal(file.content_type, 'application/pdf');
  assert.equal((await f.request(`/${room.id}/attachments`)).body.total, 0);
  assert.equal((await f.request(`/${room.id}/attachments?submission_id=upload-pdf`)).body.attachments[0].id, file.id);
  assert.equal((await (await upload()).json()).attachment.id, file.id);
  assert.equal(f.objects.size, 1);
  const message = { author: '用户', text: '', attachment_ids: [file.id], submission_id: 'message-files' };
  const saved = await f.request(`/${room.id}/messages`, message);
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  assert.equal(saved.body.message.attachments[0].id, file.id);
  assert.deepEqual((await f.request(`/${room.id}/messages`, message)).body.message, saved.body.message);
  assert.deepEqual((await f.request(`/${room.id}/messages`)).body.messages[0].attachments, saved.body.message.attachments);
  const download = await f.raw(`/${room.id}/attachments/${file.id}/content?download=1`);
  assert.match(download.headers.get('Content-Disposition'), /^attachment; filename\*=UTF-8''/);
  assert.equal(download.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(download.headers.get('X-Content-SHA256'), file.sha256);
  assert.deepEqual(new Uint8Array(await download.arrayBuffer()), data);
  assert.equal((await f.request(`/${room.id}/backup`)).body.tables.attachments[0].id, file.id);
  assert.equal((await f.request(`/${room.id}/messages`, { ...message, submission_id: 'reuse-files' })).status, 409);
  assert.equal((await f.request(`/${room.id}/messages`, { ...message, text: 'changed', attachment_ids: [] })).status, 409);
  assert.equal((await f.request(`/${room.id}/delete`, { actor: '用户', confirm_title: '附件' })).status, 200);
  assert.equal(f.objects.size, 0);
  assert.equal((await f.raw(`/${room.id}/attachments/${file.id}/content`)).status, 404);
});

test('Worker imports a backup under fresh numbers, rewritten references and the importer credential, like Python', async t => {
  const f = await worker_fixture(t);
  const r = await free_worker_room(f, [{ name: 'Qwen', access: 'online', token: 'import-qwen'.repeat(4) }]);
  const room = r.room, path = r.path;
  const first = (await r.say('原始问题')).body.message;
  const data = new TextEncoder().encode('%PDF-1.7\nimported');
  const params = new URLSearchParams({ actor: '用户', file_name: '资料.pdf', submission_id: 'import-file' });
  const file = (await (await f.raw(`${path}/attachments?${params}`, { method: 'POST', body: data, headers: { 'X-Discussion-Token': r.owner } })).json()).attachment;
  const second = await r.say(`补充 #${first.id}`, { reply_to: first.id, attachment_ids: [file.id] });
  assert.equal(second.status, 201, JSON.stringify(second.body));
  await r.say(`请 Qwen 回应 #${first.id}`, { to: ['Qwen'] });
  const qwen_request = (await f.request(`${path}/inbox`, undefined, r.owner)).body.observers[0].pending[0];
  const answer = await f.request(`${path}/messages`, { author: 'Qwen', submitted_by: '用户', source: 'proxy', request_ids: [qwen_request.id],
    text: `回应 #${first.id}`, submission_id: 'import-answer' }, r.owner);
  assert.equal(answer.status, 201, JSON.stringify(answer.body));
  const backup = JSON.parse(JSON.stringify((await f.request(`${path}/backup`)).body).replaceAll(room.id, 'importedroom'));
  backup.version = 1;
  for (const table of ['discussion_sessions', 'discussion_conclusions', 'session_requests', 'session_state', 'session_limits',
    'session_round_budgets', 'session_pauses', 'session_options', 'task_message_sources']) delete backup.tables[table];
  backup.tables.room_modes[0].mode = 'brainstorm';
  backup.tables.topic_settings[0].phase = 'discussing';
  backup.tables.discussion_turns = [{ id: 90, room_id: room.id, expert: 'Claude', question: '旧版安排', status: 'answered',
    submission_id: 'legacy-import-turn', created_at: '2026-10-28T00:00:00Z', notified_at: '', answer_id: first.id }];
  backup.tables.message_details[0].turn_id = 90;
  backup.tables.scheduler_decisions = [{ id: 1, after_message_id: first.id, kind: 'interjection', label: '交给主持人 Codex', confidence: 0.66, applied: 0, provider: 'jev',
    created_at: '2026-10-25T00:00:00Z', feedback: 'bad', should_be: 'Qwen', note: '该问 Qwen', context: '{"prompt":2}' }];
  await r.say('占用新编号');
  const imported = await f.request('/import', backup);
  assert.equal(imported.status, 201, JSON.stringify(imported.body));
  assert.deepEqual(Object.keys(imported.body.attachments), [file.id]);
  assert.equal((await f.request('/import', backup)).body.skipped, true);
  const copy = (await f.request('/importedroom')).body;
  assert.deepEqual([copy.host, copy.phase], ['Claude', 'paused']);
  assert.equal(copy.mode, 'free', 'version 1 brainstorm backups import as free rooms');
  assert.equal((await f.request('/importedroom/turns?legacy=1')).body.turns[0].question, '旧版安排', 'legacy turns remain readable');
  assert.equal((await f.request('/importedroom/turns', { actor: 'Claude', submission_id: 'new-legacy-turn', expert: 'Claude', question: '不可恢复' }, r.claude)).status, 400,
    'imported legacy history cannot resume the old arrangement engine');
  assert.equal((await f.request('/importedroom/runtime', { action: 'start', revision: 0 }, r.owner)).status, 400);
  assert.deepEqual(copy.scheduler_decisions.map(item => [item.feedback, item.should_be, item.note, item.context]), [['bad', 'Qwen', '该问 Qwen', '{"prompt":2}']]);
  const imported_messages = (await f.request('/importedroom/messages')).body.messages;
  const new_first = imported_messages.find(message => message.text === '原始问题');
  const new_second = imported_messages.find(message => message.text.startsWith('补充'));
  const new_answer = imported_messages.find(message => message.source === 'proxy');
  assert.ok(new_first.id > answer.body.message.id + 1);
  assert.deepEqual([new_second.text, new_second.reply_to], [`补充 #${new_first.id}`, new_first.id]);
  assert.deepEqual([new_answer.text, new_answer.source, new_answer.submitted_by], [`回应 #${new_first.id}`, 'proxy', '用户']);
  const attachment = `/importedroom/attachments/${imported.body.attachments[file.id]}`;
  assert.equal((await f.raw(`${attachment}/content`)).status, 404);
  assert.equal((await f.raw(`${attachment}/import`, { method: 'POST', body: new TextEncoder().encode('changed') })).status, 400);
  assert.equal((await f.raw(`${attachment}/import`, { method: 'POST', body: data, headers: { 'X-Discussion-Token': crypto.randomUUID() } })).status, 403);
  assert.equal((await f.raw(`${attachment}/import`, { method: 'POST', body: data })).status, 200);
  assert.deepEqual(new Uint8Array(await (await f.raw(`${attachment}/content`)).arrayBuffer()), data);
});

test('Worker version 2 backups preserve session history under remapped, inert identifiers', async t => {
  const f = await worker_fixture(t);
  const r = await free_worker_room(f, [{ name: 'Codex', adapter: 'codex_cli', token: 'backup-codex'.repeat(4) }]);
  const preface = (await r.say('会前原文')).body.message;
  const discussion = `${r.path}/discussion`;
  const initial = (await f.request(discussion)).body;
  const first_session = await f.request(discussion, { action: 'start', revision: initial.revision, goal: '首场历史' }, r.owner);
  assert.equal(first_session.status, 200, JSON.stringify(first_session.body));
  const first_revision = (await f.request(discussion)).body.revision;
  assert.equal((await f.request(discussion, { action: 'end', revision: first_revision }, r.owner)).status, 200);
  const second_initial = (await f.request(discussion)).body;
  const started = await f.request(discussion, { action: 'start', revision: second_initial.revision, goal: `目标引用 #${preface.id}` }, r.owner);
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const roster = (await f.request(`${r.path}/turns/roster`)).body;
  const plan = await f.request(`${r.path}/turns`, { actor: 'Claude', submission_id: 'backup-session-plan', roster: roster.revision,
    turns: [{ expert: 'Claude', question: '主持安排' }, { expert: 'Codex', question: `请检查 #${preface.id}` }] }, r.claude);
  assert.equal(plan.status, 201, JSON.stringify(plan.body));
  const execution = await r.reserve('Claude');
  assert.equal(execution.status, 200, JSON.stringify(execution.body));
  f.sql.prepare('UPDATE member_requests SET chain_id=?,batch_id=? WHERE id=?').run(preface.id, preface.id, plan.body.turn.member_request_id);
  f.sql.prepare('UPDATE session_state SET held_since=? WHERE session_id=?').run(preface.id, started.body.session.id);
  const backup = (await f.request(`${r.path}/backup`, undefined, r.owner)).body;
  assert.equal(backup.version, 2);
  for (const table of ['discussion_sessions', 'discussion_conclusions', 'session_requests', 'session_state', 'session_limits',
    'session_round_budgets', 'session_pauses', 'session_options', 'task_message_sources']) assert.ok(Array.isArray(backup.tables[table]), table);
  assert.ok(Object.hasOwn(backup.tables.member_requests[0], 'execution_id'));
  const original_session = backup.tables.discussion_sessions.find(row => row.id === started.body.session.id);
  const original_execution_request = backup.tables.member_requests.find(row => row.execution_id === execution.body.id);
  assert.ok(original_execution_request, 'backup carries the execution ID needed by fork_snapshot');
  const fork_snapshot = await load_fork_snapshot();
  const forked = fork_snapshot(backup, preface.id, 'forkcopy');
  assert.ok(forked.executions.Claude?.includes(execution.body.id), 'fork_snapshot excludes an execution attached to a later request');
  const imported = await f.request('/import', { ...backup, tables: { ...backup.tables, rooms: [{ ...backup.tables.rooms[0], id: 'sessioncopy' }] } });
  assert.equal(imported.status, 201, JSON.stringify(imported.body));
  const imported_sessions = f.sql.prepare('SELECT * FROM discussion_sessions WHERE room_id=? ORDER BY id').all('sessioncopy');
  const remapped_preface = f.sql.prepare('SELECT id FROM messages WHERE room_id=? AND text=?').get('sessioncopy', '会前原文').id;
  const active_copy = imported_sessions.find(row => row.goal === `目标引用 #${remapped_preface}`);
  assert.ok(imported_sessions.every(row => row.status === 'concluded'));
  assert.ok(imported_sessions.every(row => row.id > Math.max(...backup.tables.discussion_sessions.map(item => item.id))));
  const latest_visible_message = f.sql.prepare(`SELECT COALESCE(MAX(m.id),0) AS id FROM messages m WHERE m.room_id=?
    AND NOT EXISTS(SELECT 1 FROM task_message_sources t WHERE t.message_id=m.id)`).get('sessioncopy').id;
  assert.equal(active_copy.ended_message_id, latest_visible_message, 'active history ends at the newest visible message, not an internal task');
  const session_copy_id = active_copy.id;
  const active_source_requests = backup.tables.session_requests.filter(row => row.session_id === original_session.id);
  const imported_requests = f.sql.prepare('SELECT * FROM session_requests WHERE session_id=? ORDER BY id').all(session_copy_id);
  assert.deepEqual(imported_requests.map(row => row.status), active_source_requests.map(row => ['open', 'queued'].includes(row.status) ? 'cancelled' : row.status));
  assert.ok(imported_requests.every(row => row.id > Math.max(0, ...backup.tables.session_requests.map(item => item.id))));
  const imported_member_requests = f.sql.prepare('SELECT * FROM member_requests WHERE room_id=?').all('sessioncopy');
  assert.ok(imported_member_requests.every(row => row.execution_id == null));
  assert.deepEqual(imported_member_requests.map(row => row.status), backup.tables.member_requests.map(row => ['pending', 'delivering'].includes(row.status) ? 'cancelled' : row.status));
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS count FROM member_executions WHERE room_id=?').get('sessioncopy').count, 0,
    'session import does not create executable work');
  const sources = f.sql.prepare('SELECT * FROM task_message_sources WHERE session_id=?').all(session_copy_id);
  assert.equal(sources.length, backup.tables.task_message_sources.filter(row => row.session_id === original_session.id).length);
  assert.ok(sources.every(row => row.message_id > Math.max(0, ...backup.tables.messages.map(item => item.id))));
  assert.ok(active_copy.id > original_session.id);
  const original_conclusion = backup.tables.discussion_conclusions[0];
  const imported_conclusion = f.sql.prepare('SELECT * FROM discussion_conclusions WHERE room_id=?').get('sessioncopy');
  assert.equal(imported_conclusion.stop_reason, original_conclusion.stop_reason);
  assert.notEqual(imported_conclusion.session_id, original_conclusion.session_id);
  const imported_message_rows = f.sql.prepare('SELECT id FROM messages WHERE room_id=? ORDER BY id').all('sessioncopy');
  const message_id_map = new Map(backup.tables.messages.map((row, index) => [row.id, imported_message_rows[index].id]));
  assert.equal(imported_conclusion.state_until,
    Math.max(0, ...[...message_id_map].filter(([old_id]) => old_id <= original_conclusion.state_until).map(([, id]) => id)));
  assert.equal(f.sql.prepare('SELECT chain_id,batch_id FROM member_requests WHERE room_id=? AND purpose=?').get('sessioncopy', 'discuss').chain_id, remapped_preface);
  assert.equal(f.sql.prepare('SELECT held_since FROM session_state WHERE session_id=?').get(session_copy_id).held_since, remapped_preface);
  assert.ok(f.sql.prepare('SELECT read_until FROM session_state WHERE session_id=?').get(session_copy_id).read_until >= remapped_preface);
});

test('Worker attachment routes reject unsafe metadata, missing storage and cross-room links', async t => {
  const f = await worker_fixture(t);
  const room = (await f.request('', { title: '文件边界' })).body;
  const base = `/${room.id}/attachments`;
  const params = new URLSearchParams({ actor: '用户', file_name: 'active.html', submission_id: 'upload-html' });
  assert.equal((await f.raw(`${base}?${params}`, { method: 'POST', body: '<script>bad()</script>' }, null)).status, 503);
  const file = (await (await f.raw(`${base}?${params}`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: '<script>bad()</script>' })).json()).attachment;
  const content = await f.raw(`${base}/${file.id}/content`);
  assert.equal(content.headers.get('Content-Type'), 'application/octet-stream');
  assert.match(content.headers.get('Content-Disposition'), /^attachment/);
  const other = (await f.request('', { title: '另一房间' })).body;
  assert.equal((await f.raw(`/${other.id}/attachments/${file.id}/content`)).status, 404);
  assert.equal((await f.request(`/${other.id}/messages`, { author: '用户', text: '', attachment_ids: [file.id], submission_id: 'cross-files' })).status, 404);
  assert.equal((await f.raw(`${base}?${params}`, { method: 'POST', body: 'changed' })).status, 409);
  for (const name of ['../escape', 'folder\\file', 'bad\nfile', 'x'.repeat(256)]) {
    const invalid = new URLSearchParams({ actor: '用户', file_name: name, submission_id: 'invalid-upload' });
    assert.equal((await f.raw(`${base}?${invalid}`, { method: 'POST', body: 'x' })).status, 400);
  }
  assert.equal((await f.raw(`${base}?${params}`, { method: 'POST', headers: { 'Content-Length': String(20 * 1024 * 1024 + 1) }, body: 'x' })).status, 413);
  assert.equal(f.objects.size, 1);
});

test('Worker concurrent message retries cannot change an already saved attachment set', async t => {
  const f = await worker_fixture(t);
  const room = (await f.request('', { title: '并发附件' })).body;
  const params = new URLSearchParams({ actor: '用户', file_name: 'notes.txt', submission_id: 'concurrent-upload' });
  const file = (await (await f.raw(`/${room.id}/attachments?${params}`, { method: 'POST', body: 'notes' })).json()).attachment;
  f.before_batch = () => {
    f.sql.prepare("INSERT INTO messages(room_id,author,text,source,submission_id,created_at) VALUES (?,'用户','说明','user','same-message',?)")
      .run(room.id, new Date().toISOString());
    f.sql.exec("INSERT INTO message_details(message_id,kind,submitted_by) VALUES (last_insert_rowid(),'opinion','用户')");
  };
  const raced = await f.request(`/${room.id}/messages`, { author: '用户', text: '说明', attachment_ids: [file.id], submission_id: 'same-message' });
  assert.equal(raced.status, 409);
  assert.equal(f.sql.prepare('SELECT message_id FROM attachments WHERE id=?').get(file.id).message_id, null);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS count FROM messages WHERE room_id=?').get(room.id).count, 1);
});

test('Worker upload failure or revoked member leaves no R2 object or attachment metadata', async t => {
  const f = await timed_message_fixture(t, 'expert');
  const params = new URLSearchParams({ actor: 'Codex', file_name: 'result.txt', submission_id: 'revoked-upload' });
  f.before_batch = () => f.sql.prepare("UPDATE room_members SET status='removed' WHERE room_id=? AND name='Codex'").run(f.path.slice(1));
  const response = await f.raw(`${f.path}/attachments?${params}`, { method: 'POST', body: 'result', headers: { 'X-Discussion-Token': f.token } });
  assert.equal(response.status, 403);
  assert.equal(f.objects.size, 0);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS count FROM attachments').get().count, 0);
  const broken = { ...f.bucket, put: async () => { throw new Error('storage unavailable'); } };
  params.set('actor', '用户');
  assert.equal((await f.raw(`${f.path}/attachments?${params}`, { method: 'POST', body: 'result', headers: { 'X-Discussion-Token': f.owner } }, broken)).status, 500);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS count FROM attachments').get().count, 0);
});

/** Reserve a free-room execution and backdate its dispatch timestamp for message timing checks. */
async function timed_message_fixture(test_case, role) {
  const f = await worker_fixture(test_case);
  const codex = 'timed-execution-token'.repeat(3);
  const r = await free_worker_room(f, [{ name: 'Codex', token: codex }]);
  f.path = r.path; f.owner = r.owner; f.title = r.room.title;
  f.token = role === 'host' ? r.claude : codex;
  const target = role === 'host' ? 'Claude' : 'Codex';
  await r.say('计时回答', role === 'host' ? {} : { to: ['Codex'] });
  f.execution = (await r.reserve(target)).body;
  f.event = f.execution.id;
  f.dispatched = Math.floor(Date.now() / 1000) - 125;
  f.sql.prepare('UPDATE member_executions SET created_at=? WHERE id=?').run(f.dispatched, f.event);
  f.payload = { author: target, source: 'cli', text: '定时保存的正文', submission_id: 'timed-message',
    kind: 'chat', execution_id: f.execution.id, elapsed_seconds: 999999 };
  return f;
}

for (const role of ['host', 'expert']) test(`Worker freezes ${role} message time from dispatch through publication`, async t => {
  const f = await timed_message_fixture(t, role);
  const saved = await f.request(`${f.path}/messages`, f.payload, f.token);
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  const message = saved.body.message;
  assert.equal(message.elapsed_seconds, Math.floor(Date.parse(message.created_at) / 1000) - f.dispatched);
  assert.ok(message.elapsed_seconds >= 125 && message.elapsed_seconds < 150, 'wake is included, queue and supplied duration are not');
  f.sql.prepare('UPDATE member_executions SET created_at=created_at-500 WHERE id=?').run(f.event);
  const retry = await f.request(`${f.path}/messages`, f.payload, f.token);
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.deepEqual(retry.body.message, message);
  assert.deepEqual((await f.request(`${f.path}/messages/${message.id}`)).body, message);
  assert.deepEqual((await f.request(`${f.path}/messages`)).body.messages.find(item => item.id === message.id), message);
  assert.deepEqual((await f.request(`${f.path}/backup`)).body.tables.message_timings,
    [{ message_id: message.id, elapsed_seconds: message.elapsed_seconds }]);
  f.sql.exec(await readFile(join(PROJECT_ROOT, 'backend', 'schema.sql'), 'utf8'));
  assert.equal((await f.request(`${f.path}/messages/${message.id}`)).body.elapsed_seconds, message.elapsed_seconds);
  assert.equal((await f.request(`${f.path}/delete`, { actor: '用户', confirm_title: f.title }, f.owner)).status, 200);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS count FROM message_timings').get().count, 0);
});

test('Worker accepts Grok and records API provenance and execution timing with the same authorization', async t => {
  const f = await timed_message_fixture(t, 'expert');
  const saved = await f.request(`${f.path}/messages`, { ...f.payload, source: 'api' }, f.token);
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  assert.equal(saved.body.message.source, 'api');
  assert.equal(saved.body.message.submitted_by, 'Codex');
  assert.ok(saved.body.message.elapsed_seconds >= 125);
  const grok = await f.request('', { title: 'Grok API', host: 'Grok', experts: { Grok: 'cli', 'Grok-评审': 'cli' } });
  assert.equal(grok.status, 201, JSON.stringify(grok.body));
  assert.equal(grok.body.host, 'Grok');
  assert.equal((await f.request(`${f.path}/messages`, { ...f.payload, source: 'api', submission_id: 'expired-api' }, f.token)).status, 409);
});

test('Worker leaves user timings unknown and refuses to proxy a local execution', async t => {
  const f = await timed_message_fixture(t, 'expert');
  const user = await f.request(`${f.path}/messages`, { author: '用户', text: '留言', submission_id: 'untimed-user', elapsed_seconds: 999999 }, f.owner);
  assert.equal(user.status, 201, JSON.stringify(user.body));
  assert.equal(user.body.message.elapsed_seconds, null);
  const proxy = await f.request(`${f.path}/messages`, { ...f.payload, source: 'proxy', submitted_by: '用户' }, f.owner);
  assert.equal(proxy.status, 403, JSON.stringify(proxy.body));
  f.sql.exec(await readFile(join(PROJECT_ROOT, 'backend', 'schema.sql'), 'utf8'));
  assert.equal((await f.request(`${f.path}/messages/${user.body.message.id}`)).body.elapsed_seconds, null);
});

test('schema backfills only exact historical expert results and preserves frozen durations', async t => {
  for (const role of ['host', 'expert']) {
    const f = await timed_message_fixture(t, role);
    const message = (await f.request(`${f.path}/messages`, f.payload, f.token)).body.message;
    f.sql.prepare('DELETE FROM message_timings WHERE message_id=?').run(message.id);
    const legacy = f.sql.prepare(`INSERT INTO discussion_events(room_id,run_id,generation,cause,participant,role,status,started_at,result)
      VALUES (?,'legacy-backfill',1,'expert','Codex',?,'completed',1,?) RETURNING id`)
      .get(f.room_id ?? f.path.split('/').at(-1), role, `message:${message.id}`);
    f.sql.prepare('INSERT INTO event_timings(event_id,dispatched_at,finished_at) VALUES (?, ?, ?)')
      .run(legacy.id, f.dispatched, f.dispatched + 125);
    const schema = await readFile(join(PROJECT_ROOT, 'backend', 'schema.sql'), 'utf8');
    f.sql.exec(schema);
    f.sql.exec(schema);
    assert.equal((await f.request(`${f.path}/messages/${message.id}`)).body.elapsed_seconds,
      role === 'expert' ? message.elapsed_seconds : null);
  }
});

test('Worker retains the creation request as room metadata for export and deletion', async t => {
  const f = await worker_fixture(t);
  const original = '  用户要求🙂\n保留换行  \n';
  const payload = { title: '原文与背景', user_request: original, background: '项目背景', submission_id: 'request-create' };
  const created = await f.request('', payload);
  assert.equal(created.status, 201);
  const id = created.body.id;
  assert.equal(created.body.user_request, original);
  assert.equal((await f.request('', payload)).body.duplicate, true);
  assert.equal((await f.request('', { ...payload, user_request: '另一要求' })).status, 409);
  const backup = await f.request(`/${id}/backup`);
  assert.deepEqual(backup.body.tables.room_user_requests, [{ room_id: id, text: original }]);
  assert.equal((await f.request(`/${id}/topic`, { actor: '用户', background: '更新背景' })).status, 400,
    'room topic writes remain on the discussion session API');
  assert.equal((await f.request(`/${id}/delete`, { actor: '用户', confirm_title: payload.title })).status, 200);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS count FROM room_user_requests WHERE room_id=?').get(id).count, 0);
});

test('Worker reads explicitly marked legacy user requests without rewriting raw background', async t => {
  const f = await worker_fixture(t);
  const created = await f.request('', { title: '旧资料' });
  const id = created.body.id;
  const background = '用户原文：\n原始要求\n第二行\n\n项目背景与入口：\n补充材料';
  f.sql.prepare('DELETE FROM room_user_requests WHERE room_id=?').run(id);
  f.sql.prepare('UPDATE topic_settings SET background=? WHERE room_id=?').run(background, id);
  f.sql.exec(await readFile(join(PROJECT_ROOT, 'backend', 'schema.sql'), 'utf8'));
  const room = (await f.request(`/${id}`)).body;
  assert.equal(room.user_request, '原始要求\n第二行');
  assert.equal(room.background, '项目背景与入口：\n补充材料');
  assert.equal(f.sql.prepare('SELECT background FROM topic_settings WHERE room_id=?').get(id).background, background);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS count FROM room_user_requests WHERE room_id=?').get(id).count, 0);
  assert.equal((await f.request(`/${id}/topic`, { actor: '用户', goal: '更新目标' })).status, 400);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS count FROM room_user_requests WHERE room_id=?').get(id).count, 0);
  f.sql.prepare('DELETE FROM room_user_requests WHERE room_id=?').run(id);
  const plain = '用户原文：\n没有明确背景分隔的整段文字';
  f.sql.prepare('UPDATE topic_settings SET background=? WHERE room_id=?').run(plain, id);
  const unchanged = (await f.request(`/${id}`)).body;
  assert.equal(unchanged.user_request, '');
  assert.equal(unchanged.background, plain);
});

test('Worker preserves SQLite-formatted legacy discussion history without using it for new sessions', async t => {
  const f = await worker_fixture(t);
  const r = await free_worker_room(f, [{ name: 'Codex', token: 'legacy-json'.repeat(4) }]);
  f.sql.prepare('UPDATE topic_settings SET experts=? WHERE room_id=?').run('{"Codex": "cli"}', r.room.id);
  const message = f.sql.prepare(`INSERT INTO messages(room_id,author,text,source,submission_id,created_at)
    VALUES (?,'Codex','历史观点','cli','legacy-json-answer','2026-10-29T00:00:00Z') RETURNING id`).get(r.room.id);
  f.sql.prepare(`INSERT INTO discussion_turns(room_id,expert,question,status,submission_id,created_at)
    VALUES (?,'Codex','旧安排','pending','legacy-json-turn','2026-10-29T00:00:00Z')`).run(r.room.id);
  const legacy_turn = f.sql.prepare('SELECT id FROM discussion_turns WHERE room_id=?').get(r.room.id).id;
  f.sql.prepare("INSERT INTO message_details(message_id,kind,submitted_by,turn_id) VALUES (?,'opinion','Codex',?)").run(message.id, legacy_turn);
  const room = (await f.request(r.path)).body;
  assert.equal(room.mode, 'free');
  assert.equal(room.experts.Codex, 'cli');
  const before = (await f.request(`${r.path}/discussion`)).body;
  assert.equal((await f.request(`${r.path}/discussion`, { action: 'start', revision: before.revision, goal: '保留历史兼容' }, r.owner)).status, 200);
  assert.equal((await f.request(`${r.path}/turns`)).body.total, 0, 'new history does not read retired turns');
  assert.equal((await f.request(`${r.path}/turns?legacy=1`)).body.total, 1);
  assert.equal((await f.request(`${r.path}/turns/${legacy_turn}?legacy=1`)).body.question, '旧安排');
});

test('Worker excludes paused time from a session elapsed-time limit', async t => {
  const f = await worker_fixture(t);
  const r = await free_worker_room(f);
  const discussion = `${r.path}/discussion`;
  const initial = (await f.request(discussion)).body;
  const started = await f.request(discussion, { action: 'start', revision: initial.revision,
    goal: '暂停不计时', limits: { max_minutes: 1 } }, r.owner);
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const paused = await f.request(discussion, { action: 'pause', revision: started.body.revision }, r.owner);
  assert.equal(paused.status, 200, JSON.stringify(paused.body));
  f.sql.prepare('UPDATE session_limits SET started_at=unixepoch()-120 WHERE session_id=?').run(started.body.session.id);
  f.sql.prepare('UPDATE session_pauses SET paused_at=unixepoch()-600 WHERE session_id=?').run(started.body.session.id);
  const changed = (await f.request(discussion)).body;
  const resumed = await f.request(discussion, { action: 'resume', revision: changed.revision }, r.owner);
  assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
  assert.ok(resumed.body.session.pause.paused_seconds >= 600);
  assert.ok(resumed.body.session.limits.started_at + 60 + resumed.body.session.pause.paused_seconds > Math.floor(Date.now() / 1000));
  await f.request(`${r.path}/inbox`, undefined, r.owner);
  assert.equal(f.sql.prepare('SELECT status FROM discussion_sessions WHERE id=?').get(started.body.session.id).status, 'active',
    'two minutes of wall time do not reach the one-minute limit after ten paused minutes');
});

test('Worker defaults to unlimited session duration while keeping execution leases bounded', async t => {
  const f = await worker_fixture(t);
  const codex = 'unlimited-work-token'.repeat(3);
  const r = await free_worker_room(f, [{ name: 'Codex', adapter: 'codex_cli', token: codex }]);
  const discussion = `${r.path}/discussion`;
  const initial = (await f.request(discussion)).body;
  const started = await f.request(discussion, { action: 'start', revision: initial.revision, goal: '单次不限' }, r.owner);
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.deepEqual([started.body.session.limits.max_minutes, started.body.session.limits.execution_minutes], [0, 0]);
  f.sql.prepare('UPDATE session_limits SET started_at=unixepoch()-7200 WHERE session_id=?').run(started.body.session.id);
  await f.request(`${r.path}/inbox`, undefined, r.owner);
  assert.equal(f.sql.prepare('SELECT status FROM discussion_sessions WHERE id=?').get(started.body.session.id).status, 'active',
    'an unlimited session has no total-duration deadline');
  const roster = (await f.request(`${r.path}/turns/roster`)).body;
  const plan = await f.request(`${r.path}/turns`, { actor: 'Claude', submission_id: 'unlimited-session-plan', roster: roster.revision,
    expert: 'Codex', question: '继续处理长任务' }, r.claude);
  assert.equal(plan.status, 201, JSON.stringify(plan.body));
  const execution = await r.reserve('Codex');
  assert.equal(execution.status, 200, JSON.stringify(execution.body));
  const path = `${r.path}/executions/${execution.body.id}`;
  assert.equal((await f.request(path, { action: 'renew' }, codex)).status, 403, 'only the runner owner can renew a lease');
  const renewed = await f.request(path, { action: 'renew' }, r.owner);
  assert.equal(renewed.status, 200, JSON.stringify(renewed.body));
  assert.ok(renewed.body.lease_until > Date.now() / 1000);
  assert.ok(renewed.body.lease_until <= Math.floor(Date.now() / 1000) + 120);
  f.sql.prepare('UPDATE member_executions SET lease_until=0 WHERE id=?').run(execution.body.id);
  assert.equal((await f.request(path, { action: 'renew' }, r.owner)).status, 409);
});

test('Worker session executions keep leases, authorization and pause/resume without a time limit', async t => {
  const f = await worker_fixture(t);
  const codex = 'bounded-session-execution-token'.repeat(3);
  const r = await free_worker_room(f, [{ name: 'Codex', adapter: 'codex_cli', token: codex }]);
  const discussion = `${r.path}/discussion`;
  const initial = (await f.request(discussion)).body;
  const started = await f.request(discussion, { action: 'start', revision: initial.revision, goal: '单次执行不限时', limits: { execution_minutes: 1 } }, r.owner);
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal(started.body.session.limits.execution_minutes, 1);
  const roster = (await f.request(`${r.path}/turns/roster`)).body;
  const plan = await f.request(`${r.path}/turns`, { actor: 'Claude', submission_id: 'bounded-session-plan', roster: roster.revision,
    expert: 'Codex', question: '执行一项工作' }, r.claude);
  assert.equal(plan.status, 201, JSON.stringify(plan.body));
  const execution = await r.reserve('Codex');
  assert.equal(execution.status, 200, JSON.stringify(execution.body));
  const path = `${r.path}/executions/${execution.body.id}`;
  const renewed = await f.request(path, { action: 'renew' }, r.owner);
  assert.equal(renewed.status, 200, JSON.stringify(renewed.body));
  assert.ok(renewed.body.lease_until > Date.now() / 1000);
  assert.ok(renewed.body.lease_until <= Math.floor(Date.now() / 1000) + 120);
  assert.equal((await f.request(path, { action: 'renew' }, codex)).status, 403);
  f.sql.prepare('UPDATE member_executions SET created_at=unixepoch()-61 WHERE id=?').run(execution.body.id);
  assert.equal((await f.request(path, { action: 'renew' }, r.owner)).status, 200, 'a stored execution_minutes no longer ends a running execution');
  const latest = (await f.request(discussion)).body;
  const paused = await f.request(discussion, { action: 'pause', revision: latest.revision }, r.owner);
  assert.equal(paused.status, 200, JSON.stringify(paused.body));
  const resumed_view = (await f.request(discussion)).body;
  const resumed = await f.request(discussion, { action: 'resume', revision: resumed_view.revision }, r.owner);
  assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
  assert.equal(f.sql.prepare('SELECT status FROM member_executions WHERE id=?').get(execution.body.id).status, 'cancelled');
  assert.equal(f.sql.prepare('SELECT status FROM discussion_sessions WHERE id=?').get(started.body.session.id).status, 'active');
});

test('Worker unlimited sessions end at the round limit and refuse the removed summary mode', async t => {
  const f = await worker_fixture(t), codex = 'round-limit-codex'.repeat(4);
  const r = await free_worker_room(f, [{ name: 'Codex', token: codex }]);
  const revision = (await f.request(`${r.path}/discussion`)).body.revision;
  assert.equal((await f.request(`${r.path}/discussion`, { action: 'start', revision, goal: '旧总结方式',
    limits: { on_limit: 'summarize' } }, r.owner)).status, 400);
  assert.equal((await f.request(`${r.path}/discussion`, { action: 'start', revision, goal: '轮次到限',
    limits: { max_rounds: 1 } }, r.owner)).status, 200);
  const turn = await f.request(`${r.path}/turns`, { actor: 'Claude', expert: 'Codex', question: '观点',
    roster: (await f.request(`${r.path}/turns/roster`)).body.revision, submission_id: 'unlimited-turn' }, r.claude);
  assert.equal(turn.status, 201);
  const execution = (await r.reserve('Codex')).body;
  assert.equal((await r.answer(execution.id, codex, 'Codex')).status, 201);
  const room = (await f.request(r.path)).body;
  assert.equal(room.limits.reason, 'round_limit');
  assert.deepEqual([room.mode, room.session.status], ['free', 'concluded']);
  assert.equal(room.limits.closing, undefined);
});

test('Worker reaches the session elapsed-time limit and returns to free collaboration', async t => {
  const f = await worker_fixture(t);
  const r = await free_worker_room(f);
  const discussion = `${r.path}/discussion`;
  const initial = (await f.request(discussion)).body;
  const started = await f.request(discussion, { action: 'start', revision: initial.revision,
    goal: '时长到限', limits: { max_minutes: 1 } }, r.owner);
  assert.equal(started.status, 200, JSON.stringify(started.body));
  f.sql.prepare('UPDATE session_limits SET started_at=1 WHERE session_id=?').run(started.body.session.id);
  await f.request(`${r.path}/inbox`, undefined, r.owner);
  const ended = (await f.request(r.path)).body;
  assert.equal(f.sql.prepare('SELECT stop_reason FROM session_limits WHERE session_id=?').get(started.body.session.id).stop_reason, 'time_limit');
  assert.deepEqual([f.sql.prepare('SELECT status FROM discussion_sessions WHERE id=?').get(started.body.session.id).status, ended.mode,
    ended.phase, ended.session.status], ['concluded', 'free', 'discussing', 'concluded']);
  const conclusion = f.sql.prepare('SELECT stop_reason,concluded_at FROM discussion_conclusions WHERE session_id=?').get(started.body.session.id);
  assert.equal(conclusion.stop_reason, 'time_limit');
  assert.ok(conclusion.concluded_at);
  const frozen_elapsed = ended.limits.elapsed_seconds;
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal((await f.request(r.path)).body.limits.elapsed_seconds, frozen_elapsed);
});

test('Worker interruption closes the open discussion request and returns control to the host', async t => {
  const codex = 'interrupt-codex'.repeat(3), gemini = 'interrupt-gemini'.repeat(3);
  const { f, r, session } = await session_control_fixture(t, {}, [
    { name: 'Codex', adapter: 'codex_cli', token: codex }, { name: 'Gemini', adapter: 'api', token: gemini },
  ]);
  const roster = (await f.request(`${r.path}/turns/roster`)).body;
  const plan = await f.request(`${r.path}/turns`, { actor: 'Claude', submission_id: 'interrupt-plan', roster: roster.revision,
    turns: [{ expert: 'Codex', question: '先回答' }, { expert: 'Gemini', question: '接着回答' }] }, r.claude);
  assert.equal(plan.status, 201, JSON.stringify(plan.body));
  const execution = (await r.reserve('Codex')).body;
  assert.equal((await f.request(`${r.path}/members/${await r.member_id('Codex')}/interrupt`, {}, r.owner)).status, 200);
  assert.equal(f.sql.prepare('SELECT status FROM member_requests WHERE id=?').get(execution.requests[0].id).status, 'cancelled');
  assert.equal(f.sql.prepare('SELECT status FROM session_requests WHERE id=?').get(plan.body.turn.id).status, 'cancelled');
  assert.equal(f.sql.prepare('SELECT status FROM session_requests WHERE id=?').get(plan.body.queued[0].id).status, 'open');
  assert.equal(f.sql.prepare("SELECT COUNT(*) AS count FROM member_requests WHERE member_id=? AND purpose='discuss_host' AND status='pending'")
    .get(await r.member_id('Claude')).count, 0);
  assert.equal((await f.request(`${r.path}/turns/${plan.body.queued[0].id}`)).body.expert, 'Gemini');
});

test('Worker interruption hands an exhausted plan back to the host once', async t => {
  const codex = 'interrupt-single-codex'.repeat(3);
  const { f, r } = await session_control_fixture(t, {}, [{ name: 'Codex', adapter: 'codex_cli', token: codex }]);
  const roster = (await f.request(`${r.path}/turns/roster`)).body;
  const plan = await f.request(`${r.path}/turns`, { actor: 'Claude', submission_id: 'interrupt-single-plan', roster: roster.revision,
    expert: 'Codex', question: '最后一位发言' }, r.claude);
  const execution = (await r.reserve('Codex')).body;
  assert.equal((await f.request(`${r.path}/members/${await r.member_id('Codex')}/interrupt`, {}, r.owner)).status, 200);
  assert.equal(f.sql.prepare('SELECT status FROM session_requests WHERE id=?').get(plan.body.turn.id).status, 'cancelled');
  const host_id = await r.member_id('Claude');
  assert.equal(f.sql.prepare("SELECT COUNT(*) AS count FROM member_requests WHERE member_id=? AND purpose='discuss_host' AND status='pending'")
    .get(host_id).count, 1);
  assert.equal(f.sql.prepare('SELECT cause_kind FROM task_message_sources WHERE cause_request_id=?').get(execution.requests[0].id).cause_kind, 'member_change');
  await f.request(`${r.path}/inbox`, undefined, r.owner);
  assert.equal(f.sql.prepare("SELECT COUNT(*) AS count FROM member_requests WHERE member_id=? AND purpose='discuss_host' AND status='pending'")
    .get(host_id).count, 1);
});

test('Worker topic writes reject phase in free rooms and live-session limits or roster edits', async t => {
  const f = await worker_fixture(t);
  const free = await free_worker_room(f);
  assert.equal((await f.request(`${free.path}/topic`, { actor: 'Claude', title: '更新', phase: 'discussing' }, free.claude)).status, 400);
  const topic_update = await f.request(`${free.path}/topic`, { actor: 'Claude', title: '更新' }, free.claude);
  assert.equal(topic_update.status, 200, JSON.stringify(topic_update.body));
  const { f: live_f, r, control } = await session_control_fixture(t, {}, [{ name: 'Codex', adapter: 'codex_cli', token: 'topic-codex'.repeat(3) }]);
  const active_title = await live_f.request(`${r.path}/topic`, { actor: 'Claude', title: '活跃中的部分更新' }, r.claude);
  assert.equal(active_title.status, 200, JSON.stringify(active_title.body));
  assert.equal((await live_f.request(`${r.path}/topic`, { actor: 'Claude', title: '改上限', limits: { max_rounds: 5 } }, r.claude)).status, 400);
  const room = (await live_f.request(r.path)).body;
  const experts = { ...room.experts, Gemini: 'online' };
  assert.equal((await live_f.request(`${r.path}/topic`, { actor: 'Claude', title: '改成员', experts }, r.claude)).status, 400);
  assert.equal((await live_f.request(`${r.path}/topic`, { actor: 'Claude', title: '改主持', host: 'Codex' }, r.claude)).status, 400);
  assert.equal((await control('pause')).status, 200);
  const paused_title = await live_f.request(`${r.path}/topic`, { actor: 'Claude', background: '暂停中的部分更新' }, r.claude);
  assert.equal(paused_title.status, 200, JSON.stringify(paused_title.body));
  assert.equal((await live_f.request(`${r.path}/topic`, { actor: 'Claude', title: '暂停时改上限', limits: { max_rounds: 5 } }, r.claude)).status, 400);
});

test('Worker accepts the real topic save payload during active and paused sessions without changing access or controls', async t => {
  const f = await worker_fixture(t);
  const r = await free_worker_room(f, [
    { name: 'Codex', adapter: 'codex_cli', token: 'topic-codex-real-payload'.repeat(2) },
    { name: 'Gemini', access: 'manual', manual_source: 'web', token: 'topic-gemini-web-real-payload'.repeat(2) },
  ]);
  const topic_path = `${r.path}/topic`;
  const save_topic_with_browser = async (room, reverse_experts, label) => {
    const expert_entries = Object.entries(room.experts);
    const experts = Object.fromEntries(reverse_experts ? expert_entries.reverse() : expert_entries);
    const fields = {
      'topic-host-select': room.host,
      'topic-title-input': `保存${label}`,
      'topic-goal-input': room.goal,
      'topic-focus-input': room.focus,
      'topic-user_request-input': room.user_request,
      'topic-background-input': `保存${label}背景`,
      'topic-boundaries-input': room.boundaries,
    };
    const browser = {
      state: { room, topic_dirty: true },
      localStorage: { getItem: () => null, removeItem: () => {} },
      element: id => ({ value: fields[id] ?? '' }),
      read_expert_inputs: () => experts,
      read_limits: () => { throw new Error('live-session topic saves must not read limits'); },
      prepare_member_request: () => { throw new Error('an unchanged roster must not create member credentials'); },
      request_json: async (path, payload) => {
        assert.equal(path, `/api/rooms/${room.id}/topic`);
        const response = await f.request(topic_path, payload, r.owner);
        if (response.status < 200 || response.status >= 300) throw Object.assign(new Error(response.body.error), { status: response.status });
        return response.body;
      },
      save_room_credentials: () => {},
      refresh_room: async () => {},
      show_toast: () => {},
    };
    const save_topic = await load_topic_save_handler(browser);
    await save_topic({ preventDefault() {} });
    return { payload_experts: experts, room: browser.state.room };
  };
  const managed_state = session_id => ({
    session: f.sql.prepare(`SELECT s.id,s.status,st.phase FROM discussion_sessions s
      JOIN session_state st ON st.session_id=s.id WHERE s.id=?`).get(session_id),
    limits: f.sql.prepare(`SELECT max_rounds,max_minutes,execution_minutes,revision,stop_reason
      FROM session_limits WHERE session_id=?`).get(session_id),
    topic: f.sql.prepare('SELECT host,experts,phase FROM topic_settings WHERE room_id=?').get(r.room.id),
    members: f.sql.prepare(`SELECT m.name,m.access,m.role,m.status,m.token_hash,COALESCE(src.source,'') AS manual_source
      FROM room_members m LEFT JOIN member_manual_sources src ON src.member_id=m.id WHERE m.room_id=? ORDER BY m.name`).all(r.room.id),
  });
  const full_payload_negative = (room, overrides) => ({ actor: '用户', host: room.host, experts: room.experts, members: [],
    title: '必须拒绝的设置变更', goal: room.goal, focus: room.focus, user_request: room.user_request,
    background: room.background, boundaries: room.boundaries, ...overrides });

  const initial = (await f.request(`${r.path}/discussion`, undefined, r.owner)).body;
  const started = await f.request(`${r.path}/discussion`, { action: 'start', revision: initial.revision, goal: '真实表单回归',
    limits: { max_rounds: 3, max_minutes: 0 } }, r.owner);
  assert.equal(started.status, 200, JSON.stringify(started.body));
  let room = (await f.request(r.path, undefined, r.owner)).body;
  assert.ok(room.members.some(member => member.name === 'Gemini' && member.manual_source === 'web'), 'the room includes a web-relay member');

  for (const status of ['active', 'paused']) {
    if (status === 'paused') {
      const revision = (await f.request(`${r.path}/discussion`, undefined, r.owner)).body.revision;
      const paused = await f.request(`${r.path}/discussion`, { action: 'pause', revision }, r.owner);
      assert.equal(paused.status, 200, JSON.stringify(paused.body));
      room = (await f.request(r.path, undefined, r.owner)).body;
      assert.equal(room.session.status, 'paused');
    }

    const before = managed_state(room.session.id);
    const saved = await save_topic_with_browser(room, true, status);
    assert.deepEqual(Object.keys(saved.payload_experts), Object.keys(room.experts).reverse(), 'the browser payload may reverse mapping key order');
    assert.deepEqual(managed_state(room.session.id), before, `${status} topic editing preserves roster credentials and discussion controls`);
    const updated = (await f.request(r.path, undefined, r.owner)).body;
    assert.equal(updated.title, `保存${status}`);
    assert.equal(updated.background, `保存${status}背景`);

    const invalid_changes = [
      { host: 'Codex' },
      { experts: { ...room.experts, DeepSeek: 'online' } },
      { experts: Object.fromEntries(Object.entries(room.experts).filter(([name]) => name !== 'Gemini')) },
      { experts: { ...room.experts, Codex: 'online' } },
      { limits: { max_rounds: 5 } },
      { phase: 'discussing' },
    ];
    for (const change of invalid_changes) {
      const rejected = await f.request(topic_path, full_payload_negative(room, change), r.owner);
      assert.equal(rejected.status, 400, `${status} rejects ${Object.keys(change)[0]} changes: ${JSON.stringify(rejected.body)}`);
      assert.deepEqual(managed_state(room.session.id), before, `${status} rejected ${Object.keys(change)[0]} changes leave stored state untouched`);
    }
  }
});

test('Worker paused-session unaddressed messages follow ordinary free routing', async t => {
  const { f, r, control, session } = await session_control_fixture(t);
  await control('pause');
  const message = await r.say('暂停时的一般协作消息');
  assert.equal(message.status, 201, JSON.stringify(message.body));
  assert.equal(f.sql.prepare('SELECT held_since FROM session_state WHERE session_id=?').get(session.id).held_since, 0);
  const room_view = (await f.request(r.path, undefined, r.owner)).body;
  assert.ok(room_view.free.requests.some(item => item.message_id === message.body.message.id), JSON.stringify({ message: message.body.message, free: room_view.free }));
});

test('Worker clears held_since only after host state covers the held message', async t => {
  const { f, r, session } = await session_control_fixture(t);
  const message = await r.say('等待主持处理的用户意见');
  const held = f.sql.prepare('SELECT held_since FROM session_state WHERE session_id=?').get(session.id).held_since;
  assert.equal(held, message.body.message.id);
  const roster = (await f.request(`${r.path}/turns/roster`)).body;
  assert.equal((await f.request(`${r.path}/turns`, { actor: 'Claude', expert: 'Claude', question: '继续安排',
    roster: roster.revision, submission_id: 'held-survives-plan' }, r.claude)).status, 201);
  assert.equal(f.sql.prepare('SELECT held_since FROM session_state WHERE session_id=?').get(session.id).held_since, held);
  assert.equal((await f.request(`${r.path}/state`, { actor: 'Claude', text: '已处理用户意见', until: message.body.message.id }, r.claude)).status, 200);
  assert.equal(f.sql.prepare('SELECT held_since FROM session_state WHERE session_id=?').get(session.id).held_since, 0);
});

test('Worker reading pages enforce the initial independent-view boundary and expose session turns', async t => {
  const codex = 'read-boundary-codex'.repeat(3);
  const { f, r, session } = await session_control_fixture(t, {}, [{ name: 'Codex', adapter: 'codex_cli', token: codex }]);
  const roster = (await f.request(`${r.path}/turns/roster`)).body;
  const plan = await f.request(`${r.path}/turns`, { actor: 'Claude', submission_id: 'read-boundary-plan', roster: roster.revision,
    expert: 'Codex', question: '初始期的独立安排题' }, r.claude);
  assert.equal(plan.status, 201, JSON.stringify(plan.body));
  const start_id = f.sql.prepare('SELECT read_until FROM session_state WHERE session_id=?').get(session.id).read_until;
  const later = await r.say('初始期后续私密观点');
  assert.equal(later.status, 201, JSON.stringify(later.body));
  const direct = await r.say('点名请求可读正文', { to: ['Codex'] });
  assert.equal(direct.status, 201, JSON.stringify(direct.body));
  const direct_request = f.sql.prepare("SELECT id FROM member_requests WHERE message_id=? AND member_id=?")
    .get(direct.body.message.id, (await r.member_id('Codex'))).id;
  const host_execution = (await r.reserve('Claude')).body;
  const note_write = await f.request(`${r.path}/executions/${host_execution.id}`,
    { action: 'renew', notes: [{ seq: 1, text: '主持执行的过程说明' }] }, r.owner);
  assert.equal(note_write.status, 200, JSON.stringify(note_write.body));
  assert.equal((await f.request(`${r.path}/state`, { actor: '用户', text: '初始期后续私密观点' }, r.owner)).status, 200);
  const read = async (path, token = '') => {
    const response = await worker.fetch(new Request(`https://discussion.test/r${path}`, {
      headers: token ? { 'X-Discussion-Token': token } : {},
    }), f.env);
    return { status: response.status, text: await response.text() };
  };
  for (const [token, can_read] of [['', false], [codex, false], [r.owner, true], [r.claude, true]]) {
    const page = await read(`${r.path}/messages?q=${encodeURIComponent('初始期后续私密观点')}`, token);
    assert.equal(page.status, 200);
    assert.equal(/初始期后续私密观点/.test(page.text), can_read);
    assert.equal((await read(`${r.path}/messages/${later.body.message.id}`, token)).status, can_read ? 200 : 404);
    assert.equal(/初始期后续私密观点/.test((await read(`${r.path}/state`, token)).text), can_read);
  }
  assert.ok(start_id >= 0);
  assert.match((await read(`${r.path}/messages?request_id=${direct_request}`, codex)).text, /点名请求可读正文/);
  assert.deepEqual((await f.request(`${r.path}/executions/${host_execution.id}/notes`, undefined, '')).body.notes, []);
  assert.match(JSON.stringify((await f.request(`${r.path}/executions/${host_execution.id}/notes`, undefined, r.owner)).body.notes), /主持执行的过程说明/);
  assert.doesNotMatch(JSON.stringify((await f.request(`${r.path}/timeline`, undefined, '')).body), /主持执行的过程说明/);
  const codex_execution = (await r.reserve('Codex')).body;
  f.sql.prepare("UPDATE member_executions SET status='failed',finished_at=unixepoch(),result='越界失败结果' WHERE id=?").run(codex_execution.id);
  for (const token of ['', codex]) {
    const limited = (await f.request(r.path, undefined, token)).body;
    assert.equal(limited.free.executions.find(item => item.id === codex_execution.id).result, '');
    assert.equal(limited.free.members.find(item => item.name === 'Codex').execution.result, '');
  }
  const owner_view = (await f.request(r.path, undefined, r.owner)).body;
  assert.equal(owner_view.free.executions.find(item => item.id === codex_execution.id).result, '越界失败结果');
  assert.equal(owner_view.free.members.find(item => item.name === 'Codex').execution.result, '越界失败结果');
  assert.equal((await f.request(`${r.path}/backup`, undefined, '')).status, 403);
  assert.equal((await f.request(`${r.path}/backup`, undefined, r.owner)).status, 200);
  const public_room = await f.request(r.path, undefined, '');
  assert.equal(public_room.status, 200);
  assert.doesNotMatch(JSON.stringify(public_room.body.free), /初始期后续私密观点|初始期的独立安排题/);
  const brief = await read(`${r.path}/brief`);
  assert.doesNotMatch(brief.text, /初始期后续私密观点/);
  const turns = await read(`${r.path}/turns`);
  assert.equal(turns.status, 200);
  assert.match(turns.text, /初始期的独立安排题/);
});

test('Worker retries an exact saved answer to recover an interrupted session handoff', async t => {
  const codex = 'handoff-retry-codex'.repeat(3), gemini = 'handoff-retry-gemini'.repeat(3);
  const { f, r } = await session_control_fixture(t, {}, [
    { name: 'Codex', adapter: 'codex_cli', token: codex }, { name: 'Gemini', adapter: 'api', token: gemini },
  ]);
  const roster = (await f.request(`${r.path}/turns/roster`)).body;
  const plan = await f.request(`${r.path}/turns`, { actor: 'Claude', submission_id: 'handoff-retry-plan', roster: roster.revision,
    turns: [{ expert: 'Codex', question: '先回答' }, { expert: 'Gemini', question: '随后回答' }] }, r.claude);
  const reserved = await r.reserve('Codex');
  assert.ok([200, 201].includes(reserved.status), JSON.stringify(reserved.body));
  const execution = reserved.body;
  const submission_id = 'handoff-retry-answer';
  const answer_payload = { author: 'Codex', source: 'cli', kind: 'chat', execution_id: execution.id,
    submission_id, text: '精确重试的回答' };
  const first_answer = await f.request(`${r.path}/messages`, answer_payload, codex);
  assert.equal(first_answer.status, 201, JSON.stringify(first_answer.body));
  const next = plan.body.queued[0];
  const next_task = f.sql.prepare("SELECT member_request_id FROM session_requests WHERE id=?").get(next.id).member_request_id;
  const task_message = f.sql.prepare("SELECT message_id FROM task_message_sources WHERE session_request_id=?").get(next.id).message_id;
  f.sql.prepare("UPDATE session_requests SET status='queued',member_request_id=NULL WHERE id=?").run(next.id);
  f.sql.prepare("DELETE FROM member_requests WHERE id=?").run(next_task);
  f.sql.prepare("DELETE FROM messages WHERE id=?").run(task_message);
  const retried = await f.request(`${r.path}/messages`, answer_payload, codex);
  assert.deepEqual([retried.status, retried.body.duplicate], [200, true], JSON.stringify(retried.body));
  assert.equal(f.sql.prepare('SELECT status FROM session_requests WHERE id=?').get(next.id).status, 'open');
});

test('Worker direct ask reading requires a live explicit request or execution binding', async t => {
  const codex = 'direct-ask-boundary-codex'.repeat(3);
  const { f, r } = await session_control_fixture(t, {}, [{ name: 'Codex', adapter: 'codex_cli', token: codex }]);
  const ask = await r.say('绑定到这条直接提问的材料', { to: ['Codex'] });
  assert.equal(ask.status, 201, JSON.stringify(ask.body));
  const request_id = f.sql.prepare('SELECT id FROM member_requests WHERE message_id=? AND purpose=\'ask\'').get(ask.body.message.id).id;
  const read = async query => {
    const response = await worker.fetch(new Request(`https://discussion.test/r${r.path}/messages?${query}`, {
      headers: { 'X-Discussion-Token': codex },
    }), f.env);
    return { status: response.status, text: await response.text() };
  };
  assert.match((await read(`request_id=${request_id}`)).text, /绑定到这条直接提问的材料/);
  const execution = (await r.reserve('Codex')).body;
  assert.match((await read(`execution_id=${execution.id}`)).text, /绑定到这条直接提问的材料/);
  f.sql.prepare("UPDATE member_executions SET status='completed',finished_at=unixepoch() WHERE id=?").run(execution.id);
  f.sql.prepare("UPDATE member_requests SET status='completed' WHERE execution_id=?").run(execution.id);
  assert.equal((await read(`request_id=${request_id}`)).status, 409);
  assert.equal((await read(`execution_id=${execution.id}`)).status, 409);
});

test('Worker session plans require the current roster and continue after a skip', async t => {
  const codex = 'session-codex'.repeat(4), gemini = 'session-gemini'.repeat(4);
  const { f, r } = await session_control_fixture(t, {}, [
    { name: 'Codex', adapter: 'codex_cli', token: codex }, { name: 'Gemini', adapter: 'api', token: gemini },
  ]);
  const make_plan = (submission_id, roster, names) => f.request(`${r.path}/turns`, { actor: 'Claude', submission_id, roster,
    turns: names.map(expert => ({ expert, question: `请 ${expert} 发言` })) }, r.claude);
  const original = (await f.request(`${r.path}/turns/roster`)).body;
  assert.equal((await make_plan('session-roster-1', undefined, ['Codex', 'Gemini'])).status, 400);
  const invited = await f.request(`${r.path}/members`, { name: 'DeepSeek', access: 'runner', adapter: 'api', token: 'deepseek-session'.repeat(3) }, r.owner);
  assert.equal(invited.status, 200, JSON.stringify(invited.body));
  assert.equal((await make_plan('session-roster-2', original.revision, ['Codex', 'Gemini', 'DeepSeek'])).status, 409);
  const roster = (await f.request(`${r.path}/turns/roster`)).body;
  const missing = await make_plan('session-roster-3', roster.revision, ['Codex', 'Gemini']);
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /DeepSeek/);
  const plan = await make_plan('session-roster-4', roster.revision, ['Codex', 'Gemini', 'DeepSeek']);
  assert.equal(plan.status, 201, JSON.stringify(plan.body));
  const skipped = await f.request(`${r.path}/turns/${plan.body.turn.id}`, { actor: 'Claude' }, r.claude);
  assert.equal(skipped.status, 200, JSON.stringify(skipped.body));
  assert.equal(f.sql.prepare('SELECT status FROM session_requests WHERE id=?').get(plan.body.turn.id).status, 'cancelled');
  const fresh = (await f.request(`${r.path}/turns/roster`)).body;
  const continued = await f.request(`${r.path}/turns/continue`, { actor: 'Claude', revision: fresh.revision }, r.claude);
  assert.equal(continued.status, 200, JSON.stringify(continued.body));
  assert.deepEqual([continued.body.turn.expert, continued.body.turn.status], ['Gemini', 'open']);
});

test('Worker interjection ask keeps queue and other host work, retries once and supports the host', async t => {
  const { f, r } = await session_control_fixture(t, {}, ['Codex', 'Gemini'].map(name => ({ name, token: name.repeat(8) })));
  let roster = (await f.request(`${r.path}/turns/roster`)).body;
  await f.request(`${r.path}/turns`, { actor: 'Claude', roster: roster.revision, submission_id: 'ask-queue-plan',
    turns: ['Codex', 'Gemini'].map(expert => ({ expert, question: '请分析' })) }, r.claude);
  const first = (await r.say('请解释第一处风险')).body.message.id;
  const stale = (await f.request(`${r.path}/turns/roster`)).body;
  const second = (await r.say('请解释第二处风险')).body.message.id;
  const execution = await r.reserve();
  assert.equal(execution.status, 200, JSON.stringify(execution.body));
  roster = (await f.request(`${r.path}/turns/roster`)).body;
  const source = roster.host_requests.find(item => item.message_id === first);
  const payload = { actor: 'Claude', request_id: source.id, expert: 'Codex', submission_id: 'ask-convert-one' };
  const ask = value => f.request(`${r.path}/turns/ask`, value, r.claude);
  assert.equal((await ask(payload)).status, 400);
  assert.equal((await ask({ ...payload, revision: stale.revision })).status, 409);
  payload.revision = roster.revision;
  const converted = await ask(payload);
  assert.equal(converted.status, 201, JSON.stringify(converted.body));
  assert.equal(converted.body.execution_completed, false);
  assert.deepEqual([converted.body.request.purpose, converted.body.request.message_id], ['ask', first]);
  const after = (await f.request(`${r.path}/turns/roster`)).body;
  assert.deepEqual([after.queue, after.waiting], [roster.queue, roster.waiting]);
  assert.deepEqual(after.host_requests.map(item => item.message_id), [second]);
  assert.equal(after.held_since, second);
  assert.equal((await ask(payload)).body.duplicate, true);
  assert.equal((await ask({ ...payload, expert: 'Gemini' })).status, 409);
  const last = await ask({ ...payload, request_id: after.host_requests[0].id, expert: 'Claude', revision: after.revision, submission_id: 'ask-convert-two' });
  assert.equal(last.status, 201, JSON.stringify(last.body));
  assert.equal(last.body.execution_completed, true);
  const retry = await ask({ ...payload, request_id: after.host_requests[0].id, expert: 'Claude', revision: after.revision, submission_id: 'ask-convert-two' });
  assert.equal(retry.body.execution_completed, true);
  assert.equal((await f.request(`${r.path}/turns/roster`)).body.held_since, 0);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM session_requests WHERE member_request_id=?').get(last.body.request.id).n, 0);
});

test('Worker interjection ask supports spoken members and concurrent identical retries', async t => {
  const token = 'codex'.repeat(8);
  const { f, r } = await session_control_fixture(t, {}, [{ name: 'Codex', token }]);
  const before = (await f.request(`${r.path}/turns/roster`)).body;
  await f.request(`${r.path}/turns`, { actor: 'Claude', roster: before.revision, expert: 'Codex',
    question: '请分析', submission_id: 'ask-spoken-plan' }, r.claude);
  const execution = await r.reserve('Codex');
  assert.equal((await r.answer(execution.body.id, token, 'Codex')).status, 201);
  await r.say('你说的数字有什么来源？');
  const roster = (await f.request(`${r.path}/turns/roster`)).body;
  assert.deepEqual(roster.waiting, []);
  const payload = { actor: 'Claude', request_id: roster.host_requests[0].id, expert: 'Codex',
    revision: roster.revision, submission_id: 'ask-spoken-convert' };
  const results = await Promise.all([1, 2].map(() => f.request(`${r.path}/turns/ask`, payload, r.claude)));
  assert.deepEqual(results.map(item => item.status).sort(), [200, 201]);
  assert.equal(results[0].body.request.id, results[1].body.request.id);
  const after = (await f.request(`${r.path}/turns/roster`)).body;
  assert.deepEqual([after.round, after.queue, after.waiting], [roster.round, roster.queue, []]);
});

test('Worker interjection ask rejects in-batch roster changes without partial conversion', async t => {
  const { f, r } = await session_control_fixture(t, {}, [{ name: 'Codex', token: 'codex'.repeat(8) }]);
  await r.say('请补充依据');
  const roster = (await f.request(`${r.path}/turns/roster`)).body;
  const source = roster.host_requests[0];
  f.before_batch = () => f.sql.prepare("UPDATE room_members SET status='away' WHERE room_id=? AND name='Codex'").run(r.room.id);
  const result = await f.request(`${r.path}/turns/ask`, { actor: 'Claude', request_id: source.id, expert: 'Codex',
    revision: roster.revision, submission_id: 'ask-race-convert' }, r.claude);
  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.equal(f.sql.prepare('SELECT status FROM member_requests WHERE id=?').get(source.id).status, 'pending');
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM session_ask_submissions').get().n, 0);
  assert.equal(f.sql.prepare("SELECT COUNT(*) AS n FROM member_requests WHERE message_id=? AND purpose='ask'").get(source.message_id).n, 0);
});

test('Worker roster revisions expire after direct questions and their answers', async t => {
  const codex = 'roster-visible-codex'.repeat(3);
  const { f, r } = await session_control_fixture(t, {}, [{ name: 'Codex', adapter: 'codex_cli', token: codex }]);
  const make_plan = (submission_id, roster) => f.request(`${r.path}/turns`, { actor: 'Claude', expert: 'Codex',
    question: '基于当前讨论状态安排', roster, submission_id }, r.claude);
  let roster = (await f.request(`${r.path}/turns/roster`)).body;
  const question = await r.say('@Codex 一个直接问题', { to: ['Codex'] });
  assert.equal(question.status, 201, JSON.stringify(question.body));
  assert.equal((await make_plan('roster-after-question', roster.revision)).status, 409);

  roster = (await f.request(`${r.path}/turns/roster`)).body;
  const execution = (await r.reserve('Codex')).body;
  const answer = await r.answer(execution.id, codex, 'Codex');
  assert.equal(answer.status, 201, JSON.stringify(answer.body));
  assert.equal((await make_plan('roster-after-answer', roster.revision)).status, 409);
});

test('Worker invitations append registered experts to the active session plan', async t => {
  const codex = 'invite-session-codex'.repeat(3), qwen = 'invite-session-qwen'.repeat(3);
  const { f, r, session } = await session_control_fixture(t, {}, [{ name: 'Codex', adapter: 'codex_cli', token: codex }]);
  const before = (await f.request(`${r.path}/discussion`)).body.session;
  const read_until = f.sql.prepare('SELECT read_until FROM session_state WHERE session_id=?').get(session.id).read_until;
  const roster = (await f.request(`${r.path}/turns/roster`)).body;
  const plan = await f.request(`${r.path}/turns`, { actor: 'Claude', submission_id: 'invite-session-plan', roster: roster.revision,
    expert: 'Codex', question: '请先回答' }, r.claude);
  assert.equal(plan.status, 201, JSON.stringify(plan.body));
  await r.say('会话中的补充材料');
  const deepseek = await f.request(`${r.path}/members`, { name: 'DeepSeek', access: 'runner', adapter: 'api', token: 'invite-deepseek'.repeat(3) }, r.owner);
  assert.equal(deepseek.status, 200, JSON.stringify(deepseek.body));
  const qwen_add = await f.request(`${r.path}/members`, { name: 'Qwen', access: 'manual', token: qwen }, r.owner);
  assert.equal(qwen_add.status, 200, JSON.stringify(qwen_add.body));
  assert.equal(f.sql.prepare("SELECT COUNT(*) AS count FROM session_requests WHERE session_id=? AND submission_id LIKE 'invite:%'").get(before.id).count, 1);
  const registered = await f.request(`${r.path}/register`, {}, qwen);
  assert.equal(registered.status, 200, JSON.stringify(registered.body));
  const invitations = f.sql.prepare("SELECT m.name,q.status,q.question,q.read_until FROM session_requests q JOIN room_members m ON m.id=q.member_id WHERE q.session_id=? AND q.submission_id LIKE 'invite:%' ORDER BY q.position").all(before.id);
  assert.deepEqual(invitations.map(row => [row.name, row.status]), [['DeepSeek', 'queued'], ['Qwen', 'queued']]);
  assert.match(invitations[0].question, /独立/);
  assert.equal(invitations[0].read_until, read_until);
  assert.equal(f.sql.prepare('SELECT held_since FROM session_state WHERE session_id=?').get(before.id).held_since > 0, true);
  assert.equal(f.sql.prepare('SELECT status FROM session_requests WHERE id=?').get(plan.body.turn.id).status, 'open');
});

test('Worker roster changes invalidate queued requests and host changes pause the session', async t => {
  const codex = 'roster-codex'.repeat(4), gemini = 'roster-gemini'.repeat(4);
  const { f, r, session } = await session_control_fixture(t, {}, [
    { name: 'Codex', adapter: 'codex_cli', token: codex }, { name: 'Gemini', adapter: 'api', token: gemini },
  ]);
  const names = Object.fromEntries((await f.request(r.path)).body.members.map(member => [member.name, member.id]));
  const roster = (await f.request(`${r.path}/turns/roster`)).body;
  const plan = await f.request(`${r.path}/turns`, { actor: 'Claude', submission_id: 'roster-change-plan', roster: roster.revision,
    turns: [{ expert: 'Codex', question: '先答' }, { expert: 'Gemini', question: '后答' }] }, r.claude);
  assert.equal(plan.status, 201, JSON.stringify(plan.body));
  const away = await f.request(`${r.path}/members/${names.Codex}`, { action: 'away' }, r.owner);
  assert.equal(away.status, 200, JSON.stringify(away.body));
  assert.equal(f.sql.prepare('SELECT status FROM session_requests WHERE id=?').get(plan.body.turn.id).status, 'cancelled');
  assert.equal(f.sql.prepare('SELECT status FROM session_requests WHERE id=?').get(plan.body.queued[0].id).status, 'skipped');
  assert.ok((await f.request(`${r.path}/inbox`, undefined, r.owner)).body.members[0].pending.some(item => item.purpose === 'discuss_host'));
  const recall = await f.request(`${r.path}/members/${names.Codex}`, { action: 'active', token: 'new-codex-roster'.repeat(3) }, r.owner);
  assert.equal(recall.status, 200, JSON.stringify(recall.body));
  assert.ok((await f.request(`${r.path}/turns/roster`)).body.waiting.includes('Codex'));
  const role = await f.request(`${r.path}/members/${names.Gemini}`, { action: 'role', role: 'host' }, r.owner);
  assert.equal(role.status, 200, JSON.stringify(role.body));
  assert.equal(f.sql.prepare('SELECT status FROM discussion_sessions WHERE id=?').get(session.id).status, 'paused');
});

test('Worker manual expert registers with its own credential, keeps the first time and must register again with a new credential', async t => {
  const f = await worker_fixture(t);
  const id = (await f.request('', { title: '注册', host: 'Codex', experts: { Codex: 'cli', Claude: 'cli' } })).body.id;
  const token = f.member_tokens.Qwen = crypto.randomUUID();
  const joined = await f.request(`/${id}/members`, { name: 'Qwen', token, access: 'manual', adapter: '' });
  const member = joined.body.members.find(item => item.name === 'Qwen');
  assert.equal(member.registered_at, '');
  assert.equal((await f.request(`/${id}/register`, {})).status, 403, 'the owner cannot register for a member');
  const first = await f.request(`/${id}/register`, {}, token);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal((await f.request(`/${id}/register`, {}, token)).body.registered_at, first.body.registered_at);
  const room = () => f.request(`/${id}`).then(response => response.body.members.find(item => item.name === 'Qwen'));
  assert.equal((await room()).registered_at, first.body.registered_at);
  assert.equal((await f.request(`/${id}/members/${member.id}`, { action: 'away' })).status, 200);
  const renewed = crypto.randomUUID();
  assert.equal((await f.request(`/${id}/members/${member.id}`, { action: 'active', token: renewed })).status, 200);
  assert.equal((await room()).registered_at, '');
  assert.equal((await f.request(`/${id}/register`, {}, renewed)).status, 200);
});

test('Worker manual expert answers a woken discussion with its own credential and mode switches keep it manual', async t => {
  const f = await worker_fixture(t);
  const manual_token = 'manual-session-qwen'.repeat(3);
  const r = await free_worker_room(f, [{ name: 'Qwen', token: manual_token, access: 'manual' }]);
  const discussion = `${r.path}/discussion`;
  const initial = (await f.request(discussion)).body;
  const started = await f.request(discussion, { action: 'start', revision: initial.revision, goal: '手动专家' }, r.owner);
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal((await f.request(r.path)).body.members.find(member => member.name === 'Qwen').access, 'manual');
  let roster = (await f.request(`${r.path}/turns/roster`)).body;
  assert.deepEqual([roster.unregistered, roster.waiting.includes('Qwen')], [['Qwen'], false]);
  assert.equal((await f.request(`${r.path}/register`, {}, manual_token)).status, 200);
  roster = (await f.request(`${r.path}/turns/roster`)).body;
  assert.equal(roster.waiting.includes('Qwen'), true);
  const plan = await f.request(`${r.path}/turns`, { actor: 'Claude', submission_id: 'manual-session-plan', roster: roster.revision,
    expert: 'Qwen', question: '观点' }, r.claude);
  assert.equal(plan.status, 201, JSON.stringify(plan.body));
  const answer = await f.request(`${r.path}/messages`, { author: 'Qwen', source: 'cli', kind: 'chat', request_ids: [plan.body.turn.member_request_id],
    text: '实际回答', summary: '摘要', submission_id: 'manual-session-answer' }, manual_token);
  assert.equal(answer.status, 201, JSON.stringify(answer.body));
  assert.equal(f.sql.prepare('SELECT status FROM session_requests WHERE id=?').get(plan.body.turn.id).status, 'answered');

  const pause_revision = (await f.request(discussion)).body.revision;
  const paused = await f.request(discussion, { action: 'pause', revision: pause_revision }, r.owner);
  assert.equal(paused.status, 200, JSON.stringify(paused.body));
  const resume_revision = (await f.request(discussion)).body.revision;
  assert.equal((await f.request(discussion, { action: 'resume', revision: resume_revision }, r.owner)).status, 200);
  const end_revision = (await f.request(discussion)).body.revision;
  assert.equal((await f.request(discussion, { action: 'end', revision: end_revision }, r.owner)).status, 200);
  const access = Object.fromEntries((await f.request(r.path)).body.members.map(member => [member.name, member.access]));
  assert.deepEqual([access.Qwen, access.Claude], ['manual', 'runner'], 'session lifecycle does not change member access');
});

test('Worker keeps the named follow-up option and records smart-scheduling decisions for the transcript', async t => {
  const f = await worker_fixture(t);
  const r = await free_worker_room(f);
  const discussion = `${r.path}/discussion`;
  const revision = (await f.request(discussion)).body.revision;
  const started = await f.request(discussion, { action: 'start', revision, goal: '点名追问', named_followup: true }, r.owner);
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal((await f.request(discussion)).body.session.named_followup, true);

  const plain_f = await worker_fixture(t), plain = await free_worker_room(plain_f);
  const plain_revision = (await plain_f.request(`${plain.path}/discussion`)).body.revision;
  const default_session = await plain_f.request(`${plain.path}/discussion`, { action: 'start', revision: plain_revision, goal: '默认关闭' }, plain.owner);
  assert.equal(default_session.status, 200, JSON.stringify(default_session.body));
  assert.equal((await plain_f.request(`${plain.path}/discussion`)).body.session.named_followup, false);
  const invalid_f = await worker_fixture(t), invalid = await free_worker_room(invalid_f);
  const invalid_revision = (await invalid_f.request(`${invalid.path}/discussion`)).body.revision;
  assert.equal((await invalid_f.request(`${invalid.path}/discussion`, { action: 'start', revision: invalid_revision, goal: '无效', named_followup: 'yes' }, invalid.owner)).status, 400);

  const decision = { kind: 'round', label: '继续下一轮，先请 Codex 发言', confidence: 0.9, applied: true, provider: 'jev', after_message_id: 0 };
  const saved_decision = await f.request(`${r.path}/scheduler-decisions`, decision, r.owner);
  assert.equal(saved_decision.status, 200, JSON.stringify(saved_decision.body));
  assert.equal((await f.request(`${r.path}/scheduler-decisions`, { ...decision, kind: 'other' }, r.owner)).status, 400);
  assert.equal((await f.request(`${r.path}/scheduler-decisions`, { ...decision, confidence: 2 }, r.owner)).status, 400);
  assert.equal((await f.request(`${r.path}/scheduler-decisions`, decision, r.claude)).status, 403);
  assert.deepEqual((await f.request(r.path)).body.scheduler_decisions.map(item => [item.kind, item.label, item.applied, item.confidence]),
    [['round', '继续下一轮，先请 Codex 发言', 1, 0.9]]);
});

/** Start a session and expose revision-bound controls for lifecycle tests. */
async function session_control_fixture(t, limits = {}, members = []) {
  const f = await worker_fixture(t), r = await free_worker_room(f, members);
  const control = async (action, fields = {}, token = r.owner) => f.request(`${r.path}/discussion`, {
    action, revision: (await f.request(`${r.path}/discussion`)).body.revision, ...fields,
  }, token);
  const started = await control('start', { goal: '会话生命周期验证', limits });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  return { f, r, control, session: started.body.session };
}

test('Worker session limits reject invalid values and the retired deadline cannot bypass them', async t => {
  const f = await worker_fixture(t), r = await free_worker_room(f);
  const revision = (await f.request(`${r.path}/discussion`)).body.revision;
  for (const max_minutes of [-1, true, '0', 1441]) {
    const result = await f.request(`${r.path}/discussion`, { action: 'start', revision, goal: '有限时长', limits: { max_minutes } }, r.owner);
    assert.equal(result.status, 400, JSON.stringify(result.body));
  }
  const started = await f.request(`${r.path}/discussion`, { action: 'start', revision, goal: '有限时长', limits: { max_minutes: 1 } }, r.owner);
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal((await f.request(`${r.path}/runtime`, { action: 'start', revision: 0, deadline: 0 }, r.owner)).status, 400);
  const limits = (await f.request(r.path)).body.limits;
  assert.ok(limits.deadline > Date.now() / 1000);
  assert.ok(limits.deadline <= Math.floor(Date.now() / 1000) + 60);
});

test('Worker retains failed session attempts and frozen timing after a fresh request', async t => {
  const codex = 'frozen-codex'.repeat(4);
  const { f, r, session } = await session_control_fixture(t, {}, [{ name: 'Codex', token: codex }]);
  const plan = async submission_id => f.request(`${r.path}/turns`, { actor: 'Claude', expert: 'Codex', question: '待回应问题',
    roster: (await f.request(`${r.path}/turns/roster`)).body.revision, submission_id }, r.claude);
  assert.equal((await plan('timed-failure-first')).status, 201);
  const execution = (await r.reserve('Codex')).body;
  f.sql.prepare('UPDATE member_executions SET created_at=unixepoch()-125,lease_until=unixepoch()+120 WHERE id=?').run(execution.id);
  assert.equal((await f.request(`${r.path}/executions/${execution.id}`, { action: 'fail', reason: '三次送达失败' }, r.owner)).status, 200);
  const failure = (await f.request(r.path, undefined, r.owner)).body.free.members.find(item => item.name === 'Codex').execution;
  assert.equal(failure.status, 'failed');
  assert.equal(failure.result, '三次送达失败');
  const elapsed = failure.finished_at - failure.created_at;
  assert.ok(elapsed >= 125 && elapsed < 130);
  assert.equal((await f.request(r.path)).body.session.status, 'active');
  assert.equal(f.sql.prepare('SELECT status FROM session_requests WHERE member_request_id=?').get(execution.requests[0].id).status, 'failed');
  assert.equal((await plan('timed-failure-replanned')).status, 201);
  const retried = (await r.reserve('Codex')).body;
  assert.notEqual(retried.id, execution.id);
  assert.equal((await r.answer(retried.id, codex, 'Codex')).status, 201);
  const saved = f.sql.prepare('SELECT status,result,finished_at-created_at AS elapsed FROM member_executions WHERE id=?').get(execution.id);
  assert.deepEqual([saved.status, saved.result, saved.elapsed], ['failed', failure.result, elapsed]);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS count FROM session_requests WHERE session_id=? AND status=\'failed\'').get(session.id).count, 1);
});

test('Worker reports requests separately from execution and has no forced summary closing', async t => {
  const { f, r, session } = await session_control_fixture(t, { max_rounds: 3 });
  let member = (await f.request(r.path, undefined, r.owner)).body.free.members[0];
  assert.equal(member.execution, null);
  const pending = (await f.request(`${r.path}/inbox`, undefined, r.owner)).body.members[0].pending;
  assert.deepEqual(pending.map(item => item.purpose), ['discuss_host']);
  const execution = (await r.reserve()).body;
  member = (await f.request(r.path, undefined, r.owner)).body.free.members[0];
  assert.equal(member.execution.id, execution.id);
  const unchanged = await f.request(`${r.path}/limits`, { actor: '用户', action: 'check', force: true }, r.owner);
  assert.equal(unchanged.status, 200, JSON.stringify(unchanged.body));
  assert.equal((await f.request(`${r.path}/discussion`)).body.session.status, 'active');
  assert.equal(f.sql.prepare('SELECT stop_reason FROM session_limits WHERE session_id=?').get(session.id).stop_reason, '');
  assert.equal((await f.request(r.path)).body.free.members[0].execution.status, 'dispatched');
});

test('Worker host conclusion uses the current revision and returns to free collaboration', async t => {
  const { f, r, control, session } = await session_control_fixture(t, { max_rounds: 2 });
  await r.reserve();
  assert.equal((await f.request(`${r.path}/limits`, { actor: 'Claude', action: 'done' }, r.claude)).status, 400);
  const stale = (await f.request(`${r.path}/conclusion`)).body.revision;
  await r.say('补充结论要求');
  assert.equal((await f.request(`${r.path}/limits`, { actor: 'Claude', action: 'done', conclusion: stale }, r.claude)).status, 409);
  assert.equal((await f.request(`${r.path}/state`, { actor: 'Claude', text: '最终共识' }, r.claude)).status, 200);
  const conclusion = (await f.request(`${r.path}/conclusion`)).body;
  const done = await f.request(`${r.path}/limits`, { actor: 'Claude', action: 'done', conclusion: conclusion.revision }, r.claude);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  const room = (await f.request(r.path)).body;
  assert.equal(room.mode, 'free');
  assert.equal(room.session.status, 'concluded');
  assert.equal(f.sql.prepare('SELECT status FROM discussion_sessions WHERE id=?').get(session.id).status, 'concluded');
  assert.equal(f.sql.prepare('SELECT stop_reason FROM discussion_conclusions WHERE session_id=?').get(session.id).stop_reason, 'goal_done');
  assert.equal((await r.say('讨论结束后继续协作')).status, 201);
  assert.equal((await f.request(`${r.path}/limits`, { actor: '用户', action: 'reopen' }, r.owner)).status, 400);
  const restarted = await control('start', { goal: '第二次讨论' });
  assert.equal(restarted.status, 200);
  assert.notEqual(restarted.body.session.id, session.id);
});

test('Worker requires the owner key for session controls and destructive room actions', async t => {
  const { f, r, control } = await session_control_fixture(t);
  const revision = (await f.request(`${r.path}/discussion`)).body.revision;
  assert.equal((await f.request(`${r.path}/state`, { actor: 'Claude', text: '无凭据' }, '')).status, 403);
  for (const token of ['', crypto.randomUUID(), r.claude]) {
    for (const [tail, payload] of [['/discussion', { action: 'pause', revision }], ['/archive', { actor: '用户' }],
      ['/delete', { actor: '用户', confirm_title: '自由协作' }]]) {
      assert.equal((await f.request(`${r.path}${tail}`, payload, token)).status, 403);
    }
    assert.equal((await f.request(`${r.path}/folder`, { actor: '用户', folder_id: null }, token)).status, 200);
    assert.equal((await f.request(`${r.path}/move`, { actor: '用户' }, token)).status, 200);
  }
  assert.equal((await control('pause')).body.session.status, 'paused');
  assert.ok((await f.request(`${r.path}/archive`, { actor: '用户' }, r.owner)).body.archived);
  assert.equal((await f.request(`${r.path}/restore`, { actor: '用户' }, r.owner)).status, 200);
  assert.equal((await f.request(`${r.path}/delete`, { actor: '用户', confirm_title: '自由协作' }, r.owner)).status, 200);
  assert.equal((await f.request(r.path)).status, 404);
});

for (const change of ['roster', 'archive', 'message']) {
  test(`Worker session start rolls back when ${change} changes after validation`, async t => {
    const f = await worker_fixture(t), r = await free_worker_room(f);
    const revision = (await f.request(`${r.path}/discussion`)).body.revision;
    f.before_batch = () => {
      const query = { roster: "UPDATE room_members SET status='away' WHERE room_id=? AND role='host'",
        archive: 'UPDATE room_directory SET archived=1 WHERE room_id=?',
        message: "INSERT INTO messages(room_id,author,text,source,submission_id,created_at) VALUES(?,'用户','并发消息','web','start-race-message','test')" }[change];
      f.sql.prepare(query).run(r.room.id);
    };
    const started = await f.request(`${r.path}/discussion`, { action: 'start', revision, goal: '并发启动' }, r.owner);
    assert.equal(started.status, 409, JSON.stringify(started.body));
    for (const table of ['discussion_sessions', 'member_requests', 'discussion_events']) {
      assert.equal(f.sql.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE room_id=?`).get(r.room.id).count, 0);
    }
    assert.equal(f.sql.prepare('SELECT COUNT(*) AS count FROM task_message_sources').get().count, 0);
  });
}

test('Worker session clock survives schema reinitialization and does not reuse the old clock', async t => {
  const { f, r, session } = await session_control_fixture(t);
  f.sql.prepare('UPDATE discussion_limits SET started_at=17 WHERE room_id=?').run(r.room.id);
  const started_at = f.sql.prepare('SELECT started_at FROM session_limits WHERE session_id=?').get(session.id).started_at;
  assert.ok(started_at > 17);
  f.sql.exec(await readFile(join(PROJECT_ROOT, 'backend/schema.sql'), 'utf8'));
  assert.equal(f.sql.prepare('SELECT started_at FROM session_limits WHERE session_id=?').get(session.id).started_at, started_at);
  assert.equal(f.sql.prepare('SELECT started_at FROM discussion_limits WHERE room_id=?').get(r.room.id).started_at, 17);
  assert.equal((await f.request(`${r.path}/runtime`, { action: 'start', revision: 0 }, r.owner)).status, 400);
});

test('Worker legacy runtime and event APIs retain ended history reads but cannot resume the old engine', async t => {
  const { f, r, control } = await session_control_fixture(t);
  await control('end');
  const control_hash = createHash('sha256').update(r.owner).digest('hex');
  f.sql.prepare(`INSERT INTO discussion_runtime(room_id,mode,run_id,status,control_hash,updated_at)
    VALUES(?,'automatic','legacy-run','stopped',?,'2026-10-29T00:00:00Z')`).run(r.room.id, control_hash);
  const event = f.sql.prepare(`INSERT INTO discussion_events(room_id,run_id,generation,cause,participant,role,status,result,created_at)
    VALUES(?,'legacy-run',1,'host_turn','Claude','host','completed','历史结果','2026-10-29T00:00:01Z') RETURNING id`).get(r.room.id);
  assert.equal((await f.request(`${r.path}/runtime`)).body.status, 'stopped');
  assert.deepEqual((await f.request(`${r.path}/events?after=0`, undefined, r.owner)).body.events.map(row => row.id), [event.id]);
  const historical = await f.request(`${r.path}/events/${event.id}`, { action: 'view' }, r.owner);
  assert.equal(historical.status, 200, JSON.stringify(historical.body));
  assert.deepEqual([historical.body.id, historical.body.status, historical.body.result], [event.id, 'completed', '历史结果']);
  for (const action of ['reserve', 'enter', 'renew', 'fail', 'segments']) {
    assert.equal((await f.request(`${r.path}/events/${event.id}`, { action }, r.owner)).status, 409, action);
  }
  assert.equal((await f.request(`${r.path}/runtime`, { action: 'stop', revision: 0 }, r.owner)).status, 409);
  assert.equal(f.sql.prepare('SELECT status FROM discussion_events WHERE id=?').get(event.id).status, 'completed');
  assert.equal(f.sql.prepare('SELECT status FROM discussion_runtime WHERE room_id=?').get(r.room.id).status, 'stopped');
});

test('Worker legacy brainstorm rooms without a session cannot enter the retired runtime', async t => {
  const f = await worker_fixture(t), r = await free_worker_room(f);
  const control_hash = createHash('sha256').update(r.owner).digest('hex');
  f.sql.prepare("UPDATE room_modes SET mode='brainstorm' WHERE room_id=?").run(r.room.id);
  f.sql.prepare(`INSERT INTO discussion_runtime(room_id,mode,run_id,status,control_hash,updated_at)
    VALUES(?,'automatic','legacy-run','stopped',?,'2026-10-29T00:00:00Z')`).run(r.room.id, control_hash);
  const event = f.sql.prepare(`INSERT INTO discussion_events(room_id,run_id,generation,cause,participant,role,status,result,created_at)
    VALUES(?,'legacy-run',1,'host_turn','Claude','host','completed','历史结果','2026-10-29T00:00:01Z') RETURNING id`).get(r.room.id);
  assert.equal((await f.request(`${r.path}/runtime`)).body.status, 'stopped');
  assert.deepEqual((await f.request(`${r.path}/events?after=0`, undefined, r.owner)).body.events.map(row => row.id), [event.id]);
  for (const [path, payload] of [[`${r.path}/runtime`, { action: 'start', revision: 0 }],
    [`${r.path}/events/${event.id}`, { action: 'reserve' }]]) {
    assert.equal((await f.request(path, payload, r.owner)).status, 400, path);
  }
  const historical = await f.request(`${r.path}/events/${event.id}`, { action: 'view' }, r.owner);
  assert.equal(historical.status, 200, JSON.stringify(historical.body));
  assert.equal(historical.body.result, '历史结果');
  assert.equal(f.sql.prepare('SELECT status FROM discussion_runtime WHERE room_id=?').get(r.room.id).status, 'stopped');
  assert.equal(f.sql.prepare('SELECT status FROM discussion_events WHERE id=?').get(event.id).status, 'completed');
});

test('Worker old database migration stops legacy runs and keeps only historical reads', async t => {
  const f = await worker_fixture(t), r = await free_worker_room(f);
  const control_hash = createHash('sha256').update(r.owner).digest('hex');
  f.sql.prepare("UPDATE room_modes SET mode='brainstorm' WHERE room_id=?").run(r.room.id);
  f.sql.prepare("UPDATE topic_settings SET phase='discussing' WHERE room_id=?").run(r.room.id);
  f.sql.prepare(`INSERT INTO discussion_runtime(room_id,mode,run_id,status,control_hash,updated_at)
    VALUES(?,'automatic','pre-upgrade-run','running',?,'2026-10-29T00:00:00Z')`).run(r.room.id, control_hash);
  const event = f.sql.prepare(`INSERT INTO discussion_events(room_id,run_id,generation,cause,participant,role,status,created_at)
    VALUES(?,'pre-upgrade-run',1,'host_turn','Claude','host','pending','2026-10-29T00:00:01Z') RETURNING id`).get(r.room.id);
  f.sql.prepare("DELETE FROM schema_migrations WHERE name='discussion_session_requests_v1'").run();
  f.sql.exec(await readFile(join(PROJECT_ROOT, 'backend', 'schema.sql'), 'utf8'));
  assert.equal(f.sql.prepare('SELECT mode FROM room_modes WHERE room_id=?').get(r.room.id).mode, 'free');
  assert.equal(f.sql.prepare('SELECT status FROM discussion_sessions WHERE room_id=?').get(r.room.id).status, 'concluded');
  assert.equal(f.sql.prepare('SELECT status FROM discussion_runtime WHERE room_id=?').get(r.room.id).status, 'stopped');
  assert.equal((await f.request(`${r.path}/runtime`, { action: 'start', revision: 0 }, r.owner)).status, 400);
  assert.equal((await f.request(`${r.path}/events/${event.id}`, { action: 'reserve' }, r.owner)).status, 400);
  assert.equal((await f.request(`${r.path}/events/${event.id}`, { action: 'view' }, r.owner)).status, 200);
  assert.equal(f.sql.prepare('SELECT status FROM discussion_events WHERE id=?').get(event.id).status, 'pending');
});

test('Worker idle session revisions change after new visible messages', async t => {
  const f = await worker_fixture(t), r = await free_worker_room(f);
  const stale = (await f.request(`${r.path}/discussion`)).body.revision;
  await r.say('开启讨论之前新增的需求');
  const rejected = await f.request(`${r.path}/discussion`, { action: 'start', revision: stale, goal: '讨论最新需求' }, r.owner);
  assert.equal(rejected.status, 409, JSON.stringify(rejected.body));
  const current = (await f.request(`${r.path}/discussion`)).body.revision;
  assert.notEqual(current, stale);
  assert.equal((await f.request(`${r.path}/discussion`, { action: 'start', revision: current, goal: '讨论最新需求' }, r.owner)).status, 200);
});

test('Worker arranging a session preserves user requests that arrived after the host started', async t => {
  const codex = 'late-user-codex'.repeat(4);
  const { f, r } = await session_control_fixture(t, {}, [{ name: 'Codex', token: codex }]);
  const host = (await r.reserve()).body;
  const late = (await r.say('执行开始后的新要求')).body.message.id;
  const before = (await f.request(r.path)).body.free.requests;
  const pending = before.find(item => item.status === 'pending' && item.purpose === 'discuss_host');
  assert.ok(pending);
  assert.ok(!host.requests.some(item => item.id === pending.id));
  const planned = await f.request(`${r.path}/turns`, { actor: 'Claude', expert: 'Codex', question: '安排一位专家',
    roster: (await f.request(`${r.path}/turns/roster`)).body.revision, submission_id: 'late-user-plan' }, r.claude);
  assert.equal(planned.status, 201, JSON.stringify(planned.body));
  const after = (await f.request(r.path)).body.free.requests;
  assert.equal(after.find(item => item.id === host.requests[0].id).status, 'completed');
  assert.equal(after.find(item => item.id === pending.id).status, 'pending');
  assert.equal(f.sql.prepare('SELECT status FROM session_requests WHERE member_request_id=?').get(pending.id).status, 'open');
  assert.equal((await f.request(r.path)).body.latest_id, late);
});

test('Worker paused sessions allow ordinary host routing and answers', async t => {
  const { f, r, control } = await session_control_fixture(t, {}, [{ name: 'Codex', token: 'paused-codex'.repeat(4) }]);
  assert.equal((await control('pause')).status, 200);
  const message = await r.say('暂停后仍需自由协作');
  assert.equal(message.status, 201, JSON.stringify(message.body));
  const requests = (await f.request(r.path, undefined, r.owner)).body.free.requests.filter(item => item.message_id === message.body.message.id);
  assert.deepEqual(requests.map(item => item.purpose), ['route']);
  const execution = (await r.reserve()).body;
  assert.deepEqual(execution.requests.map(item => item.purpose), ['route']);
  assert.equal((await r.answer(execution.id)).status, 201);
  assert.equal((await f.request(`${r.path}/discussion`)).body.session.status, 'paused');
});

for (const timing of ['before request', 'after validation']) {
  test(`Worker refuses a discussion answer when its time limit expires ${timing}`, async t => {
    const codex = 'atomic-time-codex'.repeat(4);
    const { f, r, session } = await session_control_fixture(t, { max_minutes: 1 }, [{ name: 'Codex', token: codex }]);
    const planned = await f.request(`${r.path}/turns`, { actor: 'Claude', expert: 'Codex', question: '到限写入',
      roster: (await f.request(`${r.path}/turns/roster`)).body.revision, submission_id: 'atomic-time-plan' }, r.claude);
    assert.equal(planned.status, 201);
    const execution = (await r.reserve('Codex')).body;
    const expire = () => f.sql.prepare('UPDATE session_limits SET started_at=unixepoch()-120 WHERE session_id=?').run(session.id);
    if (timing === 'before request') expire();
    else f.before_batch = expire;
    const answer = await r.answer(execution.id, codex, 'Codex');
    assert.equal(answer.status, 409, JSON.stringify(answer.body));
    assert.equal((await f.request(r.path)).body.message_count, 0);
    await f.request(`${r.path}/inbox`, undefined, r.owner);
    assert.equal(f.sql.prepare('SELECT status FROM discussion_sessions WHERE id=?').get(session.id).status, 'concluded');
  });
}

test('Worker session rounds advance once and the owner may cancel the current plan', async t => {
  const codex = 'round-id-codex'.repeat(4);
  const { f, r } = await session_control_fixture(t, {}, [{ name: 'Codex', token: codex }]);
  const plan = async submission_id => f.request(`${r.path}/turns`, { actor: 'Claude', expert: 'Codex', question: '逐轮编号',
    roster: (await f.request(`${r.path}/turns/roster`)).body.revision, submission_id }, r.claude);
  const first = (await plan('round-id-first')).body.turn;
  assert.equal(first.round, 1);
  const execution = (await r.reserve('Codex')).body;
  assert.equal((await r.answer(execution.id, codex, 'Codex')).status, 201);
  const second = (await plan('round-id-second')).body.turn;
  assert.equal(second.round, 2);
  const cancelled = await f.request(`${r.path}/turns/${second.id}`, { actor: '用户', status: 'cancelled' }, r.owner);
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  const pending_host_requests = f.sql.prepare("SELECT COUNT(*) AS count FROM member_requests WHERE member_id=? AND purpose='discuss_host' AND status='pending'")
    .get(await r.member_id('Claude')).count;
  assert.equal((await f.request(`${r.path}/turns/${second.id}`, { actor: '用户', status: 'cancelled' }, r.owner)).status, 409);
  assert.equal(f.sql.prepare("SELECT COUNT(*) AS count FROM member_requests WHERE member_id=? AND purpose='discuss_host' AND status='pending'")
    .get(await r.member_id('Claude')).count, pending_host_requests);
  assert.equal((await f.request(`${r.path}/turns/${second.id}`)).body.status, 'cancelled');
});

test('Worker session roster retains and labels members that have not registered', async t => {
  const qwen = 'unregistered-qwen'.repeat(4);
  const { f, r } = await session_control_fixture(t, {}, [{ name: 'Qwen', access: 'manual', token: qwen }]);
  let roster = (await f.request(`${r.path}/turns/roster`)).body;
  assert.ok(roster.experts.some(item => item.name === 'Qwen'));
  assert.ok(roster.unregistered.includes('Qwen'));
  assert.ok(!roster.waiting.includes('Qwen'));
  assert.equal((await f.request(`${r.path}/register`, {}, qwen)).status, 200);
  roster = (await f.request(`${r.path}/turns/roster`)).body;
  assert.ok(!roster.unregistered.includes('Qwen'));
  assert.ok(roster.waiting.includes('Qwen'));
});

/** Create a pinned release without reading the shared development assets. */
async function release_fixture(test_case, legacy_layout = false) {
  const root = await mkdtemp(join(tmpdir(), "discuss-pages-test-"));
  test_case.after(async () => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + "/") || resolve(root).startsWith(resolve(tmpdir()) + "\\"));
    await rm(root, { recursive: true, force: true });
  });
  const source = join(root, "release");
  await mkdir(join(source, "web", "modern"), { recursive: true });
  await mkdir(join(source, "frontend"));
  await mkdir(join(source, "backend"));
  await mkdir(join(source, "docs"));
  const worker_path = join(source, legacy_layout ? "worker.mjs" : "backend/worker.mjs");
  const notices_path = join(source, legacy_layout ? "THIRD_PARTY_NOTICES.md" : "docs/THIRD_PARTY_NOTICES.md");
  await writeFile(worker_path, "export default { fetch() { return new Response('pinned release'); } };\n");
  await writeFile(join(source, "web", "index.html"), "<h1>已验收版本</h1>\n");
  await writeFile(join(source, "web", "app.js"), "/* published assets */\n");
  await writeFile(join(source, "frontend", "Draft.vue"), "unpublished component");
  await writeFile(join(source, "web", "modern", "Draft.vue"), "unpublished legacy source");
  await writeFile(join(source, "web", ".private"), "unpublished file");
  await cp(join(PROJECT_ROOT, "pages", "public"), join(source, "pages", "public"), { recursive: true });
  await writeFile(join(source, "LICENSE"), "License from the selected release\n");
  await writeFile(notices_path, "Notices from the selected release\n");
  return { root, source, worker_path, notices_path };
}

test("a pinned release uses its own backend and assets and removes stale output", async (test_case) => {
  const { root, source, worker_path } = await release_fixture(test_case);
  const output = await build_pages(source, root);
  await writeFile(join(output, "obsolete.js"), "old deployment");
  await build_pages(source, root);
  assert.equal(await readFile(join(output, "_worker.js"), "utf8"), await readFile(worker_path, "utf8"));
  assert.equal(await readFile(join(output, "index.html"), "utf8"), "<h1>已验收版本</h1>\n");
  for (const path of ["obsolete.js", "frontend/Draft.vue", "modern/Draft.vue", "Draft.vue", ".private"]) {
    await assert.rejects(readFile(join(output, path)), { code: "ENOENT" });
  }
});

test("only API and dynamic reading routes invoke the Function", async (test_case) => {
  const { root, source } = await release_fixture(test_case);
  const output = await build_pages(source, root);
  const routes = JSON.parse(await readFile(join(output, "_routes.json"), "utf8"));
  const matches = (pattern, path) => pattern.endsWith("*") ? path.startsWith(pattern.slice(0, -1)) : path === pattern;
  const invokes = (path) => routes.include.some((rule) => matches(rule, path)) && !routes.exclude.some((rule) => matches(rule, path));
  for (const path of ["/api", "/api/rooms", "/api/rooms/room/messages", "/r", "/r/room/messages/1"]) assert.ok(invokes(path), path);
  for (const path of ["/", "/index.html", "/app.js", "/modern.css", "/icons/user.svg", "/robots.txt", "/missing", "/apiary"]) assert.equal(invokes(path), false, path);
  assert.deepEqual((await readFile(join(output, "robots.txt"), "utf8")).split(/\r?\n/), ["User-agent: *", "Allow: /", ""]);
  assert.match(await readFile(join(output, "404.html"), "utf8"), /页面不存在/);
});

test("a pinned release keeps its own routing policy, fallback page, and license notices", async (test_case) => {
  const { root, source, notices_path } = await release_fixture(test_case);
  const public_root = join(source, "pages", "public");
  await writeFile(join(public_root, "robots.txt"), "User-agent: *\r\nDisallow: /\r\n");
  await writeFile(join(public_root, "404.html"), "<h1>Release-specific fallback</h1>\n");
  const output = await build_pages(source, root);
  for (const name of ["robots.txt", "404.html", "_routes.json"]) {
    assert.equal(await readFile(join(output, name), "utf8"), await readFile(join(public_root, name), "utf8"));
  }
  for (const [name, path] of [["LICENSE", join(source, "LICENSE")], ["THIRD_PARTY_NOTICES.md", notices_path]]) {
    assert.equal(await readFile(join(output, name), "utf8"), await readFile(path, "utf8"));
  }
});

test("a release snapshot from before the directory move still packages its own files", async (test_case) => {
  const { root, source, worker_path, notices_path } = await release_fixture(test_case, true);
  const output = await build_pages(source, root);
  assert.equal(await readFile(join(output, "_worker.js"), "utf8"), await readFile(worker_path, "utf8"));
  assert.equal(await readFile(join(output, "THIRD_PARTY_NOTICES.md"), "utf8"), await readFile(notices_path, "utf8"));
  await assert.rejects(readFile(join(output, "modern", "Draft.vue")), { code: "ENOENT" });
});

test("Pages binds D1 directly and has no external Worker service dependency", async () => {
  const config = JSON.parse(await readFile(join(PROJECT_ROOT, "wrangler.jsonc"), "utf8"));
  assert.equal(config.pages_build_output_dir, "./dist/pages");
  assert.equal(config.services, undefined);
  assert.equal(config.main, undefined);
  assert.equal(config.d1_databases.length, 1);
  assert.equal(config.d1_databases[0].binding, "DB");
  assert.ok(config.d1_databases[0].database_id);
  const scripts = JSON.parse(await readFile(join(PROJECT_ROOT, "package.json"), "utf8")).scripts;
  assert.match(scripts.deploy, /npm run build && wrangler pages deploy/);
  assert.equal(scripts["deploy:pages"], "npm run deploy");
});

/** Create a free room on the Worker fixture with Claude, and optionally Codex, as runner members. */
async function free_worker_room(f, extra = []) {
  const owner = 'owner-free'.repeat(4), claude = 'claude-free'.repeat(4);
  const created = await f.request('', { title: '自由协作', goal: 'x', mode: 'free', submission_id: 'free-worker-1',
    members: [{ name: 'Claude', adapter: 'claude', token: claude }, ...extra] }, owner);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const path = `/${created.body.id}`;
  const say = (text, extra_fields = {}, token = owner) => f.request(`${path}/messages`, { author: '用户', text, submission_id: crypto.randomUUID().replaceAll('-', ''), ...extra_fields }, token);
  const member_id = async name => (await f.request(path)).body.free.members.find(member => member.name === name).id;
  const reserve = async (name = 'Claude') => f.request(`${path}/executions`, { member_id: await member_id(name), client_id: crypto.randomUUID(), cwd: 'd:/p' }, owner);
  const answer = (execution_id, token = claude, author = 'Claude', extra_fields = {}) => f.request(`${path}/messages`, { author, text: '已处理', source: 'cli',
    submission_id: crypto.randomUUID().replaceAll('-', ''), ...(execution_id === null ? {} : { execution_id }), ...extra_fields }, token);
  return { owner, claude, path, room: created.body, say, member_id, reserve, answer };
}

test('Worker review capability binds owner facts to membership and rolls back a concurrent change', async t => {
  const f = await worker_fixture(t), r = await free_worker_room(f, [{ name: 'Codex-评审', adapter: 'codex_cli', token: 'review-token'.repeat(4) }]);
  const id = await r.member_id('Codex-评审'), path = `${r.path}/members/${id}/review-capability`;
  const state = (await f.request(path, undefined, r.owner)).body;
  const payload = { revision: state.revision, read_only: true, config_version: 'a'.repeat(64) };
  assert.equal((await f.request(path, payload, r.claude)).status, 403);
  assert.equal((await f.request(path, { read_only: true }, r.owner)).status, 400);
  assert.equal((await f.request(path, { ...payload, revision: 'stale' }, r.owner)).status, 409);
  assert.equal((await f.request(path, payload, r.owner)).status, 200);
  const roster = (await f.request(`${r.path}/reviews/roster`, undefined, r.claude)).body;
  assert.equal(roster.members[0].name, 'Codex-评审');
  assert.doesNotMatch(JSON.stringify(roster), /token_hash|control_hash/);
  assert.equal((await f.request(`${r.path}/backup`)).body.tables.member_review_capabilities, undefined);
  f.before_batch = () => f.sql.prepare("UPDATE room_members SET status='away' WHERE id=?").run(id);
  assert.equal((await f.request(path, payload, r.owner)).status, 409);
  f.sql.prepare("UPDATE room_members SET status='active' WHERE id=?").run(id);
  assert.deepEqual((await f.request(`${r.path}/reviews/roster`, undefined, r.owner)).body.members, []);
  assert.equal((await f.request(path, payload, r.owner)).status, 409, 'returning to the same state cannot revive a stale proof');
  payload.revision = (await f.request(path, undefined, r.owner)).body.revision;
  assert.equal((await f.request(path, payload, r.owner)).status, 200);
  assert.equal((await f.request(path, { revision: payload.revision, read_only: false }, r.owner)).status, 200);
  assert.deepEqual((await f.request(`${r.path}/reviews/roster`, undefined, r.owner)).body.members, []);
});

test('Worker review preauthorization is atomic, excludes implementers, and rejects stale retries', async t => {
  const f = await worker_fixture(t), r = await free_worker_room(f, [
    { name: 'Codex-评审', adapter: 'codex_cli', token: 'review-token'.repeat(4) },
    { name: 'Gemini', adapter: 'gemini', token: 'gemini-token'.repeat(4) },
  ]);
  const id = await r.member_id('Codex-评审'), path = `${r.path}/members/${id}/review-capability`;
  const capability = (await f.request(path, undefined, r.owner)).body;
  await f.request(path, { revision: capability.revision, read_only: true, config_version: 'a'.repeat(64) }, r.owner);
  await r.say('实现功能后交评审', { to: ['Claude'] });
  const execution = (await r.reserve()).body;
  const roster = (await f.request(`${r.path}/reviews/roster`, undefined, r.claude)).body;
  const base = { to: ['Gemini'], next_review: 'Codex-评审', review_scope: '核对功能', submission_id: 'review-implementation-1' };
  const post = payload => r.answer(execution.id, r.claude, 'Claude', payload);
  assert.equal((await post(base)).status, 400);
  assert.equal((await post({ ...base, review_roster: 'stale' })).status, 409);
  assert.equal((await post({ ...base, to: ['Codex-评审'], review_roster: roster.revision })).status, 400);
  f.before_batch = () => f.sql.prepare("UPDATE member_review_capabilities SET config_version=? WHERE member_id=?").run('b'.repeat(64), id);
  assert.equal((await post({ ...base, review_roster: roster.revision })).status, 409);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM review_plans').get().n, 0);
  const revision = (await f.request(`${r.path}/reviews/roster`, undefined, r.claude)).body.revision;
  const saved = await post({ ...base, review_roster: revision });
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  assert.equal((await post({ ...base, review_roster: revision })).body.duplicate, true);
  assert.equal((await post({ ...base, review_scope: '改范围', review_roster: revision })).status, 409);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM free_handoffs WHERE batch_id=?').get(saved.body.message.id).n, 1);
  assert.equal((await f.request(`${r.path}/backup`)).body.tables.review_plans[0].scope, '核对功能');
  const copied = JSON.parse(JSON.stringify((await f.request(`${r.path}/backup`)).body).replaceAll(r.room.id, 'reviewcopy'));
  const imported = await f.request('/import', copied, 'importer-token'.repeat(4));
  assert.equal(imported.status, 201, JSON.stringify(imported.body));
  const history = f.sql.prepare('SELECT status,config_version,member_revision FROM review_plans WHERE room_id=?').get(imported.body.id);
  assert.deepEqual({ ...history }, { status: 'imported', config_version: '', member_revision: '' });
});

/** Prepare an implementation answer with a still-pending authorized review handoff. */
async function completed_worker_review(t) {
  const f = await worker_fixture(t), reviewer_token = 'review-token'.repeat(4), implementer_token = 'gemini-token'.repeat(4);
  const r = await free_worker_room(f, [{ name: 'Codex-评审', adapter: 'codex_cli', token: reviewer_token },
    { name: 'Gemini', adapter: 'gemini', token: implementer_token }]);
  const reviewer = await r.member_id('Codex-评审'), path = `${r.path}/members/${reviewer}/review-capability`;
  const capability = (await f.request(path, undefined, r.owner)).body;
  await f.request(path, { revision: capability.revision, read_only: true, config_version: 'a'.repeat(64) }, r.owner);
  await r.say('实现功能', { to: ['Claude'] });
  const host = (await r.reserve()).body;
  const roster = (await f.request(`${r.path}/reviews/roster`, undefined, r.claude)).body;
  const saved = await r.answer(host.id, r.claude, 'Claude', { to: ['Gemini'], next_review: 'Codex-评审', review_scope: '核对功能', review_roster: roster.revision });
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  const work = (await r.reserve('Gemini')).body;
  assert.equal((await r.answer(work.id, implementer_token, 'Gemini')).status, 201);
  return { f, r, reviewer, reviewer_token, batch_id: saved.body.message.id };
}

test('Worker review advance consumes one handoff, rolls back races and preserves other host work', async t => {
  const { f, r, reviewer, batch_id } = await completed_worker_review(t);
  await r.say('另一个问题', { to: ['Claude'] });
  const host = (await r.reserve()).body;
  const read = async () => (await f.request(`${r.path}/reviews/${batch_id}/ready`, undefined, r.claude)).body;
  let ready = await read();
  assert.equal(ready.ready, true, JSON.stringify(ready));
  const base = { actor: 'Claude', batch_id, submission_id: 'review-advance-test' };
  const advance = payload => f.request(`${r.path}/reviews/advance`, payload, r.claude);
  assert.equal((await advance(base)).status, 400);
  assert.equal((await advance({ ...base, revision: 'stale' })).status, 409);
  f.before_batch = () => f.sql.prepare("UPDATE member_review_capabilities SET config_version=? WHERE member_id=?").run('b'.repeat(64), reviewer);
  assert.equal((await advance({ ...base, revision: ready.revision })).status, 409);
  assert.equal(f.sql.prepare('SELECT review_batch_id FROM review_plans WHERE batch_id=?').get(batch_id).review_batch_id, null);
  assert.match((await read()).reason, /能力配置已变化/);
  f.sql.prepare('UPDATE member_review_capabilities SET config_version=? WHERE member_id=?').run('a'.repeat(64), reviewer);
  ready = await read();
  const payload = { ...base, revision: ready.revision };
  const [first, second] = await Promise.all([advance(payload), advance(payload)]);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(first.body.review_batch_id, second.body.review_batch_id);
  assert.equal(second.body.execution_completed, false);
  assert.equal((await advance({ ...payload, submission_id: 'different-review-submission' })).status, 409);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM free_batches WHERE room_id=?').get(r.room.id).n, 2);
  assert.equal((await f.request(`${r.path}/messages/${first.body.review_batch_id}`)).status, 404);
  const execution = (await r.reserve('Codex-评审')).body;
  assert.equal(execution.requests[0].review.batch_id, batch_id);
  const other = (await f.request(`${r.path}/executions/${host.id}`, undefined, r.owner)).body;
  assert.deepEqual(other.requests.map(item => item.status), ['completed', 'delivering']);
});

test('Worker review replay reports a completed host and hard preconditions reject stale evidence', async t => {
  const { f, r, batch_id } = await completed_worker_review(t);
  await r.reserve();
  const read = async () => (await f.request(`${r.path}/reviews/${batch_id}/ready`, undefined, r.claude)).body;
  let ready = await read();
  f.sql.prepare('INSERT INTO free_round_limits(room_id,max_rounds) VALUES(?,1) ON CONFLICT(room_id) DO UPDATE SET max_rounds=1').run(r.room.id);
  assert.match((await read()).reason, /额度不足/);
  f.sql.prepare('UPDATE free_round_limits SET max_rounds=3 WHERE room_id=?').run(r.room.id);
  const answer = f.sql.prepare('SELECT answer_id FROM member_requests WHERE room_id=? AND batch_id=?').get(r.room.id, batch_id);
  const original = f.sql.prepare('SELECT text FROM messages WHERE id=?').get(answer.answer_id).text;
  f.sql.prepare('UPDATE messages SET text=? WHERE id=?').run('长'.repeat(60001), answer.answer_id);
  assert.match((await read()).reason, /60000/);
  f.sql.prepare('UPDATE messages SET text=? WHERE id=?').run(original, answer.answer_id);
  ready = await read();
  const payload = { actor: 'Claude', batch_id, revision: ready.revision, submission_id: 'review-terminal-test' };
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await f.request(`${r.path}/reviews/advance`, payload, r.claude);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.execution_completed, true);
    assert.equal(result.body.duplicate, Boolean(attempt));
  }
});

test('Worker review delivery rejection preserves other requests and tells the host why', async t => {
  const { f, r, reviewer, reviewer_token, batch_id } = await completed_worker_review(t);
  const ready = (await f.request(`${r.path}/reviews/${batch_id}/ready`, undefined, r.claude)).body;
  await f.request(`${r.path}/reviews/advance`, { actor: 'Claude', batch_id, revision: ready.revision, submission_id: 'review-reject-test' }, r.claude);
  await r.say('另一个问题', { to: ['Codex-评审'] });
  const execution = (await r.reserve('Codex-评审')).body;
  assert.equal(execution.requests.length, 1);
  const payload = { action: 'reject_review', reason: '只读权限已改变' };
  assert.equal((await f.request(`${r.path}/executions/${execution.id}`, payload, reviewer_token)).status, 403);
  const rejected = await f.request(`${r.path}/executions/${execution.id}`, payload, r.owner);
  assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
  assert.equal(rejected.body.status, 'cancelled');
  const inbox = (await f.request(`${r.path}/inbox`, undefined, r.owner)).body;
  assert.match(inbox.members.find(item => item.name === 'Claude').pending[0].review.reason, /只读权限已改变/);
  assert.equal(inbox.members.find(item => item.id === reviewer).pending.length, 1);
});

test('Worker free rooms need the owner credential and keep secrets out of views and backups', async t => {
  const f = await worker_fixture(t);
  assert.equal((await f.request('', { title: '自由', goal: 'x', mode: 'free', members: [{ name: 'Claude', token: 'm'.repeat(40) }] }, '')).status, 400);
  assert.equal((await f.request('', { title: '讨论', goal: 'x', mode: 'other' })).status, 400);
  const r = await free_worker_room(f);
  assert.equal(r.room.mode, 'free');
  assert.equal(r.room.host, 'Claude');
  for (const token of ['', 'x'.repeat(40), r.claude]) assert.equal((await r.say('冒充', {}, token)).status, 403);
  assert.equal((await r.say('主人冒充成员', { author: 'Claude' })).status, 403);
  for (const tail of ['/turns', '/floor', '/topic', '/runtime']) {
    assert.equal((await f.request(`${r.path}${tail}`, { actor: '用户', action: 'take', revision: 0, phase: 'paused' }, r.owner)).status, 400, tail);
  }
  const view = await f.request(r.path);
  const backup = await f.request(`${r.path}/backup`);
  assert.ok(backup.body.tables.room_members.length);
  assert.doesNotMatch(JSON.stringify(view.body) + JSON.stringify(backup.body), /token_hash|control_hash/);
  const again = await f.request('', { title: '自由协作', goal: 'x', mode: 'free', submission_id: 'free-worker-1',
    members: [{ name: 'Claude', adapter: 'claude', token: r.claude }] }, r.owner);
  assert.deepEqual([again.status, again.body.id], [200, r.room.id]);
});

test('Worker retract takes back a message only until a member starts it, and rewind hides the rest for the runner to cut', async t => {
  const f = await worker_fixture(t);
  const r = await free_worker_room(f);
  const messages = async (include = false) => (await f.request(`${r.path}/messages?after=0${include ? '&withdrawn=include' : ''}`)).body.messages
    .map(item => [item.id, item.text, item.withdrawn]);
  const retracted = (await r.say('先别做这个')).body.message.id;
  const retract = id => f.request(`${r.path}/messages/${id}/retract`, {}, r.owner);
  assert.equal((await f.request(`${r.path}/messages/${retracted}/retract`, {}, r.claude)).status, 403);
  assert.deepEqual([(await retract(retracted)).body.text, (await retract(retracted)).body.duplicate], ['先别做这个', true]);
  assert.deepEqual(await messages(true), [[retracted, '', 'retracted']]);
  assert.deepEqual((await f.request(r.path)).body.withdrawals, [{ message_id: retracted, kind: 'retracted' }]);
  const first = (await r.say('一')).body.message.id;
  const kept = await r.reserve();
  assert.equal((await retract(first)).status, 409);
  const first_answer = (await r.answer(kept.body.id)).body.message.id;
  const second = (await r.say('二')).body.message.id;
  const taken = await r.reserve();
  await r.answer(taken.body.id);
  await r.say('三');
  // The plan shows what the runner reported its adapter does to the session; without a report the session is kept.
  const unreported = (await f.request(`${r.path}/rewind?message_id=${second}`, undefined, r.owner)).body;
  assert.equal(unreported.members[0].session, 'kept');
  const capability = `${r.path}/members/${await r.member_id('Claude')}/capabilities`;
  assert.equal((await f.request(capability, { rewind: 'shred' }, r.owner)).status, 400);
  assert.equal((await f.request(capability, { rewind: 'cut' })).status, 403);
  assert.equal((await f.request(capability, { rewind: 'cut' }, r.owner)).status, 200);
  const plan = (await f.request(`${r.path}/rewind?message_id=${second}`, undefined, r.owner)).body;
  assert.deepEqual([plan.messages, plan.members.map(item => [item.name, item.executions, item.session])], [3, [['Claude', [taken.body.id], 'cut']]]);
  assert.equal((await f.request(`${r.path}/rewind`, { message_id: second }, r.owner)).status, 400);
  assert.equal((await f.request(`${r.path}/rewind`, { message_id: second, revision: 'stale' }, r.owner)).status, 409);
  const rewound = await f.request(`${r.path}/rewind`, { message_id: second, revision: plan.revision }, r.owner);
  assert.equal(rewound.status, 200, JSON.stringify(rewound.body));
  assert.deepEqual(await messages(), [[first, '一', ''], [first_answer, '已处理', '']]);
  const room = (await f.request(r.path)).body;
  assert.equal(room.free.members[0].read_until, second - 1);
  assert.equal(room.free.requests.at(-1).status, 'cancelled');
  await r.say('改过的二');
  assert.deepEqual((await r.reserve()).body.rewound_executions, [taken.body.id]);
  assert.equal((await f.request(`${r.path}/rewind?message_id=${first_answer}`, undefined, r.owner)).status, 400);
});

test('Worker @全体依次 asks the host first and the next member only after the previous one ends', async t => {
  const f = await worker_fixture(t);
  const codex = 'codex-free'.repeat(4);
  const r = await free_worker_room(f, [{ name: 'Codex', adapter: 'codex_cli', token: codex }]);
  await f.request(`${r.path}/members/${await r.member_id('Codex')}`, { action: 'role', role: 'host' }, r.owner);
  const requests = async () => (await f.request(r.path)).body.free.requests.map(item => [item.member, item.status]);
  assert.equal((await r.say('依次说说', { to: ['Claude', 'Codex'], sequential: true })).status, 201);
  assert.deepEqual(await requests(), [['Codex', 'pending']]);
  const hosted = await r.reserve('Codex');
  assert.equal((await r.answer(hosted.body.id, codex, 'Codex')).status, 201);
  assert.deepEqual(await requests(), [['Codex', 'completed'], ['Claude', 'pending']]);
  assert.deepEqual((await f.request(r.path)).body.speaking_order.items.map(item => [item.name, item.state]), [['Codex', 'done'], ['Claude', 'speaking']]);
});

test('Worker @全体成员 waits for the runner to have everyone answer at once or in turn', async t => {
  const f = await worker_fixture(t);
  const codex = 'codex-free'.repeat(4);
  const r = await free_worker_room(f, [{ name: 'Codex', adapter: 'codex_cli', token: codex }]);
  const requests = async () => (await f.request(r.path)).body.free.requests.map(item => [item.member, item.purpose, item.status]);
  const everyone = { to: ['Claude', 'Codex'], order: 'auto' };
  const first = (await r.say('大家打个招呼', everyone)).body.message.id;
  assert.deepEqual(await requests(), [['Claude', 'group', 'pending']]);
  assert.equal((await r.reserve('Claude')).status, 409);
  const arrange = async (id, action) => {
    const plan = (await f.request(`${r.path}/recommendations/${id}`, undefined, r.owner)).body;
    return f.request(`${r.path}/recommendations/${id}`, { action, revision: plan.revision }, r.owner);
  };
  assert.equal((await arrange(first, 'none')).status, 400);
  assert.equal((await arrange(first, 'all')).status, 200);
  assert.deepEqual(await requests(), [['Claude', 'all', 'pending'], ['Codex', 'all', 'pending']]);
  for (const [name, token] of [['Claude', r.claude], ['Codex', codex]]) assert.equal((await r.answer((await r.reserve(name)).body.id, token, name)).status, 201);
  const second = (await r.say('接龙', everyone)).body.message.id;
  assert.equal((await arrange(second, 'sequential')).status, 200);
  assert.deepEqual((await requests()).slice(2), [['Claude', 'ask', 'pending']]);
  assert.equal((await arrange(second, 'all')).status, 409);
});

test('Worker group handback keeps the original request and its durable receipt after delivery', async t => {
  const f = await worker_fixture(t);
  const r = await free_worker_room(f, [{ name: 'Codex', adapter: 'codex_cli', token: 'codex-free'.repeat(4) }]);
  const message = (await r.say('大家处理', { to: ['Claude', 'Codex'], order: 'auto' })).body.message.id;
  const url = `${r.path}/recommendations/${message}`;
  const before = (await f.request(r.path)).body.free.requests[0];
  assert.equal((await f.request(url, undefined, r.claude)).status, 403);
  assert.equal((await f.request(url, { action: 'host' }, r.claude)).status, 403);
  const result = await f.request(url, { action: 'host' }, r.owner);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const after = (await f.request(r.path)).body.free.requests[0];
  for (const key of ['id', 'message_id', 'chain_id', 'created_by']) assert.equal(after[key], before[key]);
  assert.equal(after.purpose, 'route');
  assert.equal((await f.request(`${r.path}/inbox`, undefined, r.owner)).body.members[0].pending[0].group_action, 'host');
  assert.equal((await r.reserve()).status, 200);
  assert.deepEqual(await f.request(url, { action: 'host' }, r.owner), result);
  assert.deepEqual((await f.request(url, undefined, r.owner)).body.result, result.body);
  assert.equal((await f.request(url, { action: 'all' }, r.owner)).status, 409);
});

test('Worker group revisions reject changed state and changes inside the atomic batch', async t => {
  for (const change of ['members', 'order', 'message', 'atomic', 'cancelled']) {
    const f = await worker_fixture(t);
    const r = await free_worker_room(f, [{ name: 'Codex', adapter: 'codex_cli', token: 'codex-free'.repeat(4) }]);
    const message = (await r.say('大家处理', { to: ['Claude', 'Codex'], order: 'auto' })).body.message.id;
    const url = `${r.path}/recommendations/${message}`;
    const plan = (await f.request(url, undefined, r.owner)).body;
    assert.equal((await f.request(url, { action: 'all' }, r.owner)).status, 400);
    assert.equal((await f.request(url, { action: 'sequential' }, r.owner)).status, 400);
    const remove = () => f.sql.prepare("UPDATE room_members SET status='away' WHERE room_id=? AND name='Codex'").run(r.room.id);
    if (change === 'members') remove();
    if (change === 'order') {
      const order = (await f.request(`${r.path}/speaking-order`)).body;
      assert.equal((await f.request(`${r.path}/speaking-order`, { revision: order.revision, order: ['Codex', 'Claude'] }, r.owner)).status, 200);
    }
    if (change === 'message') await r.say('先等等，需求变化');
    if (change === 'atomic') f.before_batch = remove;
    if (change === 'cancelled') f.sql.prepare("UPDATE member_requests SET status='cancelled' WHERE id=?").run(plan.request.id);
    const result = await f.request(url, { action: 'all', revision: plan.revision }, r.owner);
    assert.equal(result.status, 409, `${change}: ${JSON.stringify(result.body)}`);
    assert.equal(f.sql.prepare('SELECT COUNT(*) AS count FROM group_routes').get().count, 0);
    assert.equal(f.sql.prepare("SELECT purpose FROM member_requests WHERE id=?").get(plan.request.id).purpose, 'group');
    assert.equal((await f.request(url, { action: 'host' }, r.owner)).status, change === 'cancelled' ? 409 : 200);
  }
});

test('Worker owner reorders who has not spoken against the latest revision, or sets the default order when idle', async t => {
  const f = await worker_fixture(t);
  const codex = 'codex-free'.repeat(4), gemini = 'gemini-free'.repeat(4);
  const r = await free_worker_room(f, [{ name: 'Codex', adapter: 'codex_cli', token: codex }, { name: 'Gemini', adapter: 'claude', token: gemini }]);
  const url = `${r.path}/speaking-order`;
  const idle = (await f.request(url)).body;
  assert.deepEqual([idle.kind, idle.movable], ['default', ['Claude', 'Codex', 'Gemini']]);
  assert.equal((await f.request(url, { revision: idle.revision, order: ['Gemini', 'Claude', 'Codex'] }, r.claude)).status, 403);
  assert.equal((await f.request(url, { revision: idle.revision, order: ['Gemini', 'Claude', 'Codex'] }, r.owner)).status, 200);
  await r.say('依次说说', { to: ['Claude', 'Codex', 'Gemini'], sequential: true });
  const queue = (await f.request(url)).body;
  assert.deepEqual([queue.kind, queue.items.map(item => [item.name, item.state])], ['queue', [['Gemini', 'speaking'], ['Claude', 'queued'], ['Codex', 'queued']]]);
  assert.equal((await f.request(url, { order: ['Codex', 'Claude'] }, r.owner)).status, 400);
  const refused = await f.request(url, { revision: queue.revision, order: ['Codex', 'Gemini'] }, r.owner);
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /缺少：Claude.*多出：Gemini/);
  assert.equal((await f.request(url, { revision: 'stale', order: ['Codex', 'Claude'] }, r.owner)).status, 409);
  const moved = await f.request(url, { revision: queue.revision, order: ['Codex', 'Claude'] }, r.owner);
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.deepEqual(moved.body.speaking_order.items.map(item => item.name), ['Gemini', 'Codex', 'Claude']);
  const first = await r.reserve('Gemini');
  assert.equal((await r.answer(first.body.id, gemini, 'Gemini')).status, 201);
  assert.deepEqual((await f.request(r.path)).body.free.requests.map(item => [item.member, item.status]), [['Gemini', 'completed'], ['Codex', 'pending']]);
});

test('Worker free rooms record every scheduling decision with the owner credential and keep the rating of the owner', async t => {
  const f = await admin_fixture(t);
  const r = await free_worker_room(f);
  const message_id = (await r.say('claude在吗')).body.message.id;
  const input = { state: '待处理的用户消息：#1 用户：claude在吗', questions: [{ type: 'choice', name: 'handler', instructions: '判断回应对象', choices: [{ value: 'Claude', description: '叫了 Claude' }] }] };
  const body = { kind: 'interjection', label: '交给主持人 Claude', confidence: 0.66, applied: false, provider: 'jev', after_message_id: message_id, context: { model: 'jev-latest', threshold: 0.7 }, input };
  assert.equal((await f.request(`${r.path}/scheduler-decisions`, body, r.claude)).status, 403);
  const saved = await f.request(`${r.path}/scheduler-decisions`, body, r.owner);
  assert.equal(saved.status, 200);
  const rate = (rating, token = r.owner) => f.request(`${r.path}/scheduler-decisions/${saved.body.id}`, { rating }, token);
  assert.equal((await rate('bad', r.claude)).status, 403);
  assert.equal((await rate('great')).status, 400);
  assert.equal((await f.request(`${r.path}/scheduler-decisions/${saved.body.id}`, { rating: 'bad', note: 'x'.repeat(201) }, r.owner)).status, 400);
  assert.equal((await f.request(`${r.path}/scheduler-decisions/${saved.body.id}`, { rating: 'bad', should_be: 'Codex', note: '该直接问它' }, r.owner)).status, 200);
  const feedback = async () => (await f.request(r.path)).body.scheduler_decisions.map(item => [item.after_message_id, item.applied, item.feedback]);
  assert.deepEqual(await feedback(), [[message_id, 0, 'bad']]);
  assert.deepEqual((await f.request(r.path)).body.scheduler_decisions.map(item => [item.should_be, item.note, item.context]), [['Codex', '该直接问它', '{"model":"jev-latest","threshold":0.7}']]);
  // A bad rating keeps a self-contained copy for the administrator, dropped when withdrawn and kept when the room is deleted.
  const session = (await f.register()).body.token;
  const cases = async () => (await admin_call(f, '/api/scheduler-feedback', undefined, session)).body.cases;
  assert.equal((await admin_call(f, '/api/scheduler-feedback')).status, 401);
  assert.deepEqual((await cases()).map(item => [item.room_title, item.should_be, item.note, item.snapshot.label, item.snapshot.input, item.snapshot.context]),
    [['自由协作', 'Codex', '该直接问它', '交给主持人 Claude', input, { model: 'jev-latest', threshold: 0.7 }]]);
  assert.equal((await rate(null)).status, 200);
  assert.deepEqual(await feedback(), [[message_id, 0, null]]);
  assert.deepEqual(await cases(), []);
  assert.equal((await rate('bad')).status, 200);
  assert.equal((await f.request(`${r.path}/delete`, { actor: '用户', confirm_title: '自由协作' }, r.owner)).status, 200);
  assert.deepEqual((await cases()).map(item => item.snapshot.input), [input]);
});

test('Worker exact decision reads keep old evidence room-bound and protect independent opinions', async t => {
  const f = await worker_fixture(t);
  const codex = 'decision-codex'.repeat(4);
  const r = await free_worker_room(f, [{ name: 'Codex', adapter: 'codex_cli', token: codex }]);
  const message = (await r.say('原问题')).body.message.id;
  const payload = { kind: 'interjection', label: '未自动生效', confidence: 0.4, applied: false, provider: 'jev',
    after_message_id: message, detail: [{ choice: '__host__' }], context: { prompt: 9 }, input: { state: '原文', questions: [] } };
  const saved = (await f.request(`${r.path}/scheduler-decisions`, payload, r.owner)).body;
  for (let index = 0; index < 100; index++) await f.request(`${r.path}/scheduler-decisions`, payload, r.owner);
  assert.equal((await f.request(r.path)).body.scheduler_decisions.some(item => item.id === saved.id), false);
  const read = await f.request(`${r.path}/scheduler-decisions/${saved.id}`, undefined, r.claude);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  for (const key of ['detail', 'context', 'input']) assert.deepEqual(read.body[key], payload[key]);
  assert.equal((await f.request(`${r.path}/scheduler-decisions/999999`)).status, 404);
  const state = (await f.request(`${r.path}/discussion`)).body;
  assert.equal((await f.request(`${r.path}/discussion`, { action: 'start', revision: state.revision, goal: '独立观点' }, r.owner)).status, 200);
  const roster = (await f.request(`${r.path}/turns/roster`)).body;
  assert.equal((await f.request(`${r.path}/turns`, { actor: 'Claude', expert: 'Codex', question: '独立回答',
    roster: roster.revision, submission_id: crypto.randomUUID() }, r.claude)).status, 201);
  assert.equal((await f.request(`${r.path}/scheduler-decisions/${saved.id}`, undefined, codex)).status, 403);
});

test('Worker smart scheduling recommendations wait for the user, then interrupt the host or follow it', async t => {
  const f = await worker_fixture(t);
  const codex = 'codex-free'.repeat(4);
  const r = await free_worker_room(f, [{ name: 'Codex', adapter: 'codex_cli', token: codex }]);
  const codex_id = await r.member_id('Codex');
  const recommend = (message_id, extra = {}, token = r.owner) => f.request(`${r.path}/recommendations`,
    { message_id, member_id: codex_id, provider: 'jev', confidence: 0.91, ...extra }, token);
  const adopt = (message_id, mode) => f.request(`${r.path}/recommendations/${message_id}`, { action: 'adopt', mode }, r.owner);
  const pending = async name => (await f.request(`${r.path}/inbox`, undefined, r.owner)).body.members.find(member => member.name === name).pending;
  // Interrupt while the host has not started: its request is cancelled and the member is asked instead.
  const first = (await r.say('帮我看看登录报错')).body.message.id;
  assert.deepEqual((await pending('Claude')).map(item => item.purpose), ['route']);
  assert.equal((await recommend(first, {}, r.claude)).status, 403);
  assert.equal((await recommend(first, { confidence: 1.5 })).status, 400);
  assert.equal((await recommend(first, { member_id: await r.member_id('Claude') })).status, 404);
  assert.equal((await recommend(first)).status, 200);
  assert.deepEqual((await pending('Claude')).length, 1);
  const view = (await f.request(r.path)).body.free.recommendations[0];
  assert.deepEqual([view.member, view.status, view.confidence], ['Codex', 'open', 0.91]);
  assert.ok(view.expires_in > 55 && view.expires_in <= 60);
  assert.equal((await adopt(first, 'interrupt')).body.recommendation.status, 'adopted');
  assert.deepEqual([(await pending('Claude')).length, (await pending('Codex')).map(item => item.message_id)], [0, [first]]);
  // After: the host keeps working; the member is asked once the host's request ends.
  const second = (await r.say('再看看注册')).body.message.id;
  await recommend(second);
  const host_execution = (await r.reserve('Claude')).body;
  assert.equal((await adopt(second, 'after')).body.recommendation.status, 'waiting');
  assert.deepEqual((await pending('Codex')).map(item => item.message_id), [first]);
  assert.equal((await r.answer(host_execution.id)).status, 201);
  assert.deepEqual((await pending('Codex')).map(item => item.message_id), [first, second]);
  assert.equal((await f.request(r.path)).body.free.recommendations.find(item => item.message_id === second).status, 'adopted');
  // An expired recommendation can no longer be adopted.
  const third = (await r.say('第三条')).body.message.id;
  await recommend(third);
  f.sql.prepare('UPDATE member_recommendations SET expires_at=unixepoch()-30 WHERE message_id=?').run(third);
  assert.equal((await adopt(third, 'after')).status, 409);
});

test('Worker free-room members answer user asks through member executions', async t => {
  const f = await worker_fixture(t);
  const r = await free_worker_room(f, [{ name: 'Qwen', token: 'qwen-request'.repeat(4) }]);
  const path = r.path;
  const ask = (text, to) => f.request(`${path}/messages`, { author: '用户', text, to, submission_id: crypto.randomUUID().replaceAll('-', '') }, r.owner);
  assert.equal((await ask('谁是主持？', ['Nobody'])).status, 400);
  assert.equal((await ask('@Qwen 你怎么看？', ['Qwen'])).status, 201);
  const inbox = (await f.request(`${path}/inbox`, undefined, r.owner)).body;
  const qwen = inbox.members.find(member => member.name === 'Qwen');
  assert.deepEqual(qwen.pending.map(item => item.purpose), ['ask']);
  const execution = await r.reserve('Qwen');
  assert.equal(execution.status, 200, JSON.stringify(execution.body));
  const answer = { author: 'Qwen', text: '我的看法', source: 'cli', kind: 'chat', execution_id: execution.body.id, submission_id: crypto.randomUUID().replaceAll('-', '') };
  const qwen_token = 'qwen-request'.repeat(4);
  assert.equal((await f.request(`${path}/messages`, { ...answer, execution_id: 0 }, qwen_token)).status, 403);
  const saved = await f.request(`${path}/messages`, answer, qwen_token);
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  const view = (await f.request(path)).body;
  assert.equal(view.floor, undefined);
  assert.deepEqual(view.free.requests.map(item => item.status), ['completed']);
  assert.equal(view.session, null);
});

test('Worker discussions use revision-bound session requests and hide internal task messages', async t => {
  const f = await worker_fixture(t);
  const r = await free_worker_room(f);
  const discussion = `${r.path}/discussion`;
  const first = (await r.say('先聊几句')).body.message.id;
  assert.equal((await f.request(discussion, { action: 'start' }, r.claude)).status, 403);
  assert.equal((await f.request(discussion, { action: 'pause' }, r.owner)).status, 400);
  const initial = (await f.request(discussion)).body;
  assert.equal(initial.session, null);
  assert.equal((await f.request(discussion, { action: 'end', revision: initial.revision }, r.owner)).status, 409);
  const started = await f.request(discussion, { action: 'start', revision: initial.revision, goal: '选方案', limits: { max_rounds: 2, max_minutes: 30 } }, r.owner);
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.deepEqual([started.body.session.status, started.body.session.goal, started.body.session.phase,
    started.body.session.limits.max_rounds, (await f.request(r.path)).body.mode], ['active', '选方案', 'initial', 2, 'free']);
  assert.equal((await f.request(discussion, { action: 'start', revision: initial.revision }, r.owner)).status, 409);
  assert.equal((await f.request(`${r.path}/messages/${first}`)).body.text, '先聊几句');
  const roster = (await f.request(`${r.path}/turns/roster`)).body;
  const plan = await f.request(`${r.path}/turns`, { actor: 'Claude', submission_id: 'session-plan-0001', roster: roster.revision,
    expert: 'Claude', question: '请给出主持人的独立观点' }, r.claude);
  assert.equal(plan.status, 201, JSON.stringify(plan.body));
  assert.equal(plan.body.turn.status, 'open');
  const retry = await f.request(`${r.path}/turns`, { actor: 'Claude', submission_id: 'session-plan-0001', roster: 'stale',
    expert: 'Claude', question: '请给出主持人的独立观点' }, r.claude);
  assert.deepEqual([retry.status, retry.body.duplicate], [200, true], 'an exact replay returns its existing plan before checking revision');
  const source = f.sql.prepare('SELECT message_id FROM task_message_sources WHERE session_id=? ORDER BY message_id DESC LIMIT 1')
    .get(started.body.session.id);
  assert.ok(source);
  assert.equal((await f.request(`${r.path}/messages/${source.message_id}`)).status, 404);
  const visible = (await f.request(`${r.path}/messages?q=讨论已开启`)).body;
  assert.equal(visible.total, 0, 'system tasks are omitted from ordinary search');
  assert.equal((await f.request(r.path)).body.latest_id, first, 'system tasks do not advance the public message cursor');
  const pending = (await f.request(`${r.path}/inbox`, undefined, r.owner)).body.members.find(item => item.name === 'Claude').pending
    .find(item => item.purpose === 'discuss');
  assert.deepEqual([pending.session_request_id, pending.session_id, pending.round, pending.position, pending.source_question, pending.cause_kind],
    [plan.body.turn.id, started.body.session.id, plan.body.turn.round, plan.body.turn.position, '请给出主持人的独立观点', 'scheduled_speaker'], JSON.stringify(pending));
  const execution = await r.reserve();
  assert.equal(execution.status, 200, JSON.stringify(execution.body));
  const discuss_request = execution.body.requests.find(item => item.purpose === 'discuss');
  assert.equal(discuss_request.source_question, '请给出主持人的独立观点');
  assert.equal(discuss_request.session_id, started.body.session.id);
  assert.equal(discuss_request.session_request_id, plan.body.turn.id);
  assert.equal(discuss_request.round, plan.body.turn.round);
  assert.equal(discuss_request.position, plan.body.turn.position);
  assert.equal(discuss_request.cause_kind, 'scheduled_speaker');
  assert.equal(discuss_request.source_message_id, null);
  assert.equal(discuss_request.cause_request_id, null);
  const timeline = (await f.request(`${r.path}/timeline`)).body.executions.find(item => item.id === execution.body.id);
  assert.deepEqual([timeline.task_id, timeline.task], [null, null], 'ordinary execution timeline does not expose task-source messages');
  const fresh = (await f.request(discussion)).body;
  assert.equal((await f.request(discussion, { action: 'pause', revision: initial.revision }, r.owner)).status, 409);
  const paused = await f.request(discussion, { action: 'pause', revision: fresh.revision }, r.owner);
  assert.equal(paused.status, 200, JSON.stringify(paused.body));
  assert.equal(f.sql.prepare('SELECT status FROM member_executions WHERE id=?').get(execution.body.id).status, 'cancelled');
  assert.equal(f.sql.prepare(`SELECT reason FROM request_cancel_reasons WHERE request_id=(
    SELECT id FROM member_requests WHERE execution_id=? LIMIT 1)`).get(execution.body.id).reason, 'user_stop');
  const ended = await f.request(discussion, { action: 'end', revision: paused.body.revision }, r.owner);
  assert.equal(ended.status, 200, JSON.stringify(ended.body));
  assert.equal(ended.body.session, null);
  assert.equal((await f.request(`${r.path}/runtime`, { action: 'stop', revision: 0 }, r.owner)).status, 409,
    'legacy runtime writes stay disabled after the new session ends');
  assert.equal((await f.request(`${r.path}/turns`, { actor: '用户', submission_id: 'legacy-after-session', expert: 'Claude', question: '旧安排' }, r.owner)).status, 409,
    'legacy turn writes stay disabled after the new session ends');
  assert.equal((await f.request(`${r.path}/turns`)).body.total, 1, 'ended session turns remain readable through the new history API');
  assert.deepEqual([(await f.request(r.path)).body.mode, (await f.request(r.path)).body.session.status,
    (await f.request(`${r.path}/messages/${first}`)).body.text], ['free', 'concluded', '先聊几句']);
});

test('Worker session timeline preserves older free tasks and hides discussion and later task failures', async t => {
  const f = await worker_fixture(t);
  const codex = 'timeline-codex'.repeat(4);
  const r = await free_worker_room(f, [{ name: 'Codex', adapter: 'codex_cli', token: codex }]);
  const old_task = (await r.say('可见的早期普通任务', { to: ['Claude'] })).body.message.id;
  const old_execution = (await r.reserve('Claude')).body;
  assert.equal((await r.answer(old_execution.id)).status, 201);
  f.sql.prepare("UPDATE member_executions SET status='failed',result='可见的旧失败原因' WHERE id=?").run(old_execution.id);

  const discussion = `${r.path}/discussion`;
  const initial = (await f.request(discussion)).body;
  const started = await f.request(discussion, { action: 'start', revision: initial.revision, goal: '时间线边界' }, r.owner);
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const legacy_event = f.sql.prepare(`INSERT INTO discussion_events(room_id,run_id,generation,cause,participant,role,status,result,created_at)
    VALUES(?,'old-run',1,'host_turn','Claude','host','failed','旧讨论失败原因','2026-10-29T00:00:01Z') RETURNING id`).get(r.room.id);
  f.sql.prepare('INSERT INTO event_timings(event_id,dispatched_at,finished_at) VALUES(?,1,2)').run(legacy_event.id);

  await r.say('不可公开的后续普通任务', { to: ['Codex'] });
  const later_execution = (await r.reserve('Codex')).body;
  f.sql.prepare("UPDATE member_executions SET status='failed',finished_at=unixepoch(),result='越界失败原因' WHERE id=?")
    .run(later_execution.id);
  const timeline = (await f.request(`${r.path}/timeline`)).body.executions;
  const visible_old_task = timeline.find(item => item.source === 'free' && item.id === old_execution.id);
  assert.deepEqual([visible_old_task.task, visible_old_task.task_id, visible_old_task.reason],
    ['可见的早期普通任务', old_task, '可见的旧失败原因']);
  const hidden_legacy = timeline.find(item => item.source === 'discussion' && item.id === legacy_event.id);
  assert.deepEqual([hidden_legacy.task, hidden_legacy.task_id, hidden_legacy.reason], ['', null, '']);
  const hidden_later = timeline.find(item => item.source === 'free' && item.id === later_execution.id);
  assert.deepEqual([hidden_later.task, hidden_later.task_id, hidden_later.reason], ['', null, '']);
});

test('Worker disambiguates a legacy turn id from a colliding session request id', async t => {
  const f = await worker_fixture(t);
  const r = await free_worker_room(f);
  const room_id = r.room.id;
  const legacy_turn_id = 2;
  const old_message = f.sql.prepare(`INSERT INTO messages(room_id,author,text,source,submission_id,created_at)
    VALUES (?,'Claude','历史观点','cli','legacy-answer','2026-10-29T00:00:00Z') RETURNING id`).get(room_id);
  f.sql.prepare(`INSERT INTO discussion_turns(id,room_id,expert,question,status,submission_id,created_at,answer_id)
    VALUES (?,?,'Claude','历史问题','pending','legacy-plan','2026-10-29T00:00:00Z',NULL)`).run(legacy_turn_id, room_id);
  f.sql.prepare("INSERT INTO message_details(message_id,kind,submitted_by,turn_id) VALUES (?,'opinion','Claude',?)").run(old_message.id, legacy_turn_id);
  f.sql.prepare("UPDATE discussion_turns SET status='answered',answer_id=? WHERE id=?").run(old_message.id, legacy_turn_id);
  const initial = (await f.request(`${r.path}/discussion`)).body;
  const started = await f.request(`${r.path}/discussion`, { action: 'start', revision: initial.revision, goal: '编号冲突' }, r.owner);
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const roster = (await f.request(`${r.path}/turns/roster`)).body;
  const plan = await f.request(`${r.path}/turns`, { actor: 'Claude', submission_id: 'new-plan-collision', roster: roster.revision,
    expert: 'Claude', question: '新安排' }, r.claude);
  assert.equal(plan.status, 201, JSON.stringify(plan.body));
  assert.equal(plan.body.turn.id, legacy_turn_id, 'the numeric id collides by design');
  assert.equal((await f.request(`${r.path}/turns/${legacy_turn_id}`)).body.purpose, 'discuss');
  assert.equal((await f.request(`${r.path}/turns/${legacy_turn_id}?legacy=1`)).body.question, '历史问题');
  const text = await worker.fetch(new Request(`https://discussion.test/r/${room_id}/messages/${old_message.id}`), f.env);
  assert.match(await text.text(), new RegExp(`/r/${room_id}/turns/${legacy_turn_id}\\?legacy=1`));
});

test('Worker session round limit uses free-room experts and ends without a host summary request', async t => {
  const f = await worker_fixture(t);
  const codex = 'codex-free'.repeat(4);
  const r = await free_worker_room(f, [{ name: 'Codex', adapter: 'codex_cli', token: codex }]);
  const discussion = `${r.path}/discussion`;
  const initial = (await f.request(discussion)).body;
  const started = await f.request(discussion, { action: 'start', revision: initial.revision, goal: '一轮结束' }, r.owner);
  assert.equal(started.status, 200, JSON.stringify(started.body));
  f.sql.prepare('UPDATE session_limits SET max_rounds=1,revision=revision+1 WHERE session_id=?').run(started.body.session.id);
  const roster = (await f.request(`${r.path}/turns/roster`)).body;
  const plan = await f.request(`${r.path}/turns`, { actor: 'Claude', submission_id: 'limit-session-plan', roster: roster.revision,
    expert: 'Codex', question: '给出意见' }, r.claude);
  assert.equal(plan.status, 201, JSON.stringify(plan.body));
  assert.equal((await f.request(`${r.path}/turns`)).body.total, 1, 'the new turns view excludes host system tasks');
  const execution = await r.reserve('Codex');
  assert.equal(execution.status, 200, JSON.stringify(execution.body));
  assert.equal((await r.answer(execution.body.id, codex, 'Codex')).status, 201);
  assert.equal(f.sql.prepare("SELECT status FROM discussion_sessions WHERE id=?").get(started.body.session.id).status, 'concluded');
  assert.equal(f.sql.prepare("SELECT COUNT(*) AS count FROM task_message_sources WHERE session_id=? AND cause_kind='round_complete'")
    .get(started.body.session.id).count, 0);
  assert.equal((await f.request(r.path)).body.mode, 'free');
});

test('Worker room view keeps legacy rounds and partitions answered rounds across all sessions', async t => {
  const f = await worker_fixture(t), codex = 'round-group-codex'.repeat(3);
  const r = await free_worker_room(f, [{ name: 'Codex', adapter: 'codex_cli', token: codex }]);
  f.sql.prepare("UPDATE topic_settings SET host=?,experts=?,phase='discussing' WHERE room_id=?")
    .run('Claude', JSON.stringify({ Codex: 'cli' }), r.room.id);
  const legacy_turn = f.sql.prepare(`INSERT INTO discussion_turns(room_id,expert,question,status,submission_id,created_at,notified_at)
    VALUES(?,'Codex','旧安排','notified','legacy-round-turn','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`).run(r.room.id).lastInsertRowid;
  const legacy = f.sql.prepare(`INSERT INTO messages(room_id,author,text,source,submission_id,created_at)
    VALUES(?,?,'旧观点','cli','legacy-round-opinion','2026-01-01T00:01:00Z')`).run(r.room.id, 'Codex').lastInsertRowid;
  f.sql.prepare('INSERT INTO message_details(message_id,kind,submitted_by,turn_id) VALUES(?,?,?,?)').run(legacy, 'opinion', 'Codex', legacy_turn);
  f.sql.prepare("UPDATE discussion_turns SET status='answered',answer_id=? WHERE id=?").run(legacy, legacy_turn);
  const session_ids = [];
  for (let index = 0; index < 2; index++) {
    const initial = (await f.request(`${r.path}/discussion`)).body;
    const started = await f.request(`${r.path}/discussion`, { action: 'start', revision: initial.revision, goal: `第 ${index + 1} 次` }, r.owner);
    assert.equal(started.status, 200, JSON.stringify(started.body));
    session_ids.push(started.body.session.id);
    const roster = (await f.request(`${r.path}/turns/roster`)).body;
    const plan = await f.request(`${r.path}/turns`, { actor: 'Claude', submission_id: `round-session-plan-${index}`,
      roster: roster.revision, expert: 'Codex', question: '请发言' }, r.claude);
    assert.equal(plan.status, 201, JSON.stringify(plan.body));
    const execution = await r.reserve('Codex');
    assert.equal(execution.status, 200, JSON.stringify(execution.body));
    assert.equal((await r.answer(execution.body.id, codex, 'Codex')).status, 201);
    const current = (await f.request(`${r.path}/discussion`)).body;
    assert.equal((await f.request(`${r.path}/discussion`, { action: 'end', revision: current.revision }, r.owner)).status, 200);
  }
  const ordinary = (await r.say('討論結束後')).body.message.id;
  const groups = (await f.request(r.path)).body.round_groups;
  assert.deepEqual(groups.map(group => group.key), [
    'legacy-round-1', `session-${session_ids[0]}-round-1`, `session-${session_ids[1]}-round-1`,
  ]);
  assert.deepEqual(groups.slice(1).map(group => group.session_id), session_ids);
  assert.deepEqual(groups.slice(1).map(group => group.participants), [1, 1]);
  assert.ok(groups.slice(1).every(group => group.speakers.length === 1));
  assert.ok(groups.slice(1).every(group => group.end_id < ordinary), 'post-session messages are outside ended round ranges');
});

test('Worker assignment cards use stable visible slots and omit queued or failed cancellations', async t => {
  const f = await worker_fixture(t), codex = 'cancel-card-codex'.repeat(3);
  const r = await free_worker_room(f, [{ name: 'Codex', adapter: 'codex_cli', token: codex }, { name: 'Gemini', token: 'queued-only-gemini'.repeat(3) }]);
  f.sql.prepare(`INSERT INTO discussion_turns(room_id,expert,question,status,submission_id,created_at,notified_at)
    VALUES(?,'Codex','旧已发送','cancelled','legacy-cancelled-sent','2026-01-01T00:00:00Z','2026-01-01T00:00:01Z')`).run(r.room.id);
  f.sql.prepare(`INSERT INTO discussion_turns(room_id,expert,question,status,submission_id,created_at)
    VALUES(?,'Gemini','旧未发送','cancelled','legacy-cancelled-queued','2026-01-01T00:00:02Z')`).run(r.room.id);
  const initial = (await f.request(`${r.path}/discussion`)).body;
  const started = await f.request(`${r.path}/discussion`, { action: 'start', revision: initial.revision, goal: '计划显示' }, r.owner);
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const roster = (await f.request(`${r.path}/turns/roster`)).body;
  const plan = await f.request(`${r.path}/turns`, { actor: 'Claude', submission_id: 'slot-plan-batch', roster: roster.revision,
    turns: [{ expert: 'Codex', question: '已派发' }, { expert: 'Gemini', question: '未派发' }] }, r.claude);
  assert.equal(plan.status, 201, JSON.stringify(plan.body));
  const view = (await f.request(r.path, undefined, r.owner)).body;
  const card = view.host_arrangements.find(item => item.id === `session-${started.body.session.id}-plan-${plan.body.turn.id}`);
  assert.ok(card?.key);
  const fixed_anchor = card.after_message_id;
  await r.say('后来的普通留言');
  assert.equal((await f.request(r.path)).body.host_arrangements.find(item => item.id === card.id).after_message_id, fixed_anchor);
  const execution = await r.reserve('Codex');
  assert.equal(execution.status, 200, JSON.stringify(execution.body));
  const current = (await f.request(`${r.path}/discussion`)).body;
  assert.equal((await f.request(`${r.path}/discussion`, { action: 'pause', revision: current.revision }, r.owner)).status, 200);
  let cancelled = (await f.request(r.path)).body.cancelled_turns;
  assert.deepEqual(cancelled.map(item => [item.key, item.execution_id]), [
    ['legacy-turn-1', undefined], [`session-${started.body.session.id}-request-${plan.body.turn.id}`, execution.body.id],
  ]);
  f.sql.prepare("UPDATE member_executions SET status='failed' WHERE id=?").run(execution.body.id);
  cancelled = (await f.request(r.path)).body.cancelled_turns;
  assert.deepEqual(cancelled.map(item => item.key), ['legacy-turn-1'], 'a failure card replaces only the new cancelled assignment card');
});

test('Worker discussion revisions distinguish closed sessions and current roster without visible-message changes', async t => {
  const f = await worker_fixture(t);
  const r = await free_worker_room(f, [{ name: 'Codex', token: 'revision-codex'.repeat(4) }]);
  const discussion = `${r.path}/discussion`;
  const initial = (await f.request(discussion)).body;
  const first = await f.request(discussion, { action: 'start', revision: initial.revision, goal: '空会话重开' }, r.owner);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const end = await f.request(discussion, { action: 'end', revision: first.body.revision }, r.owner);
  assert.equal(end.status, 200, JSON.stringify(end.body));
  const after_end = (await f.request(discussion)).body;
  assert.equal(after_end.session, null);
  assert.notEqual(after_end.revision, first.body.revision, 'ending an empty session changes its revision even when no visible message changes');
  assert.equal((await f.request(discussion, { action: 'start', revision: first.body.revision, goal: '过期revision' }, r.owner)).status, 409);
  const second = await f.request(discussion, { action: 'start', revision: after_end.revision, goal: '再次开始' }, r.owner);
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.notEqual(second.body.session.id, first.body.session.id);
  await f.request(discussion, { action: 'end', revision: second.body.revision }, r.owner);
  const roster_revision = (await f.request(discussion)).body.revision;
  assert.equal((await f.request(`${r.path}/members/${await r.member_id('Codex')}`, { action: 'role', role: 'host' }, r.owner)).status, 200);
  const changed_roster = (await f.request(discussion)).body;
  assert.notEqual(changed_roster.revision, roster_revision, 'the current host roster participates in the next revision');
  assert.equal((await f.request(discussion, { action: 'start', revision: roster_revision, goal: '名单仍有效' }, r.owner)).status, 409);
  assert.equal((await f.request(discussion, { action: 'start', revision: changed_roster.revision, goal: '名单仍有效' }, r.owner)).status, 200);
});

test('Worker discussion start retries return the bound session without reopening or taking over a later session', async t => {
  const f = await worker_fixture(t);
  const r = await free_worker_room(f, [{ name: 'Codex', token: 'start-retry-codex'.repeat(3) }]);
  const discussion = `${r.path}/discussion`;
  const initial = (await f.request(discussion)).body;
  assert.equal((await f.request(discussion, { action: 'start', revision: initial.revision, goal: '无效编号', submission_id: 'short' }, r.owner)).status, 400);
  const first_payload = { action: 'start', revision: initial.revision, goal: '第一次启动',
    limits: { max_rounds: 2, max_minutes: 30 }, named_followup: true, submission_id: 'discussion-start-retry-001' };
  await f.raw(discussion, { method: 'POST', body: JSON.stringify(first_payload), headers: { 'X-Discussion-Token': r.owner } }); // The client loses this response.
  const original_session_id = f.sql.prepare('SELECT session_id FROM session_start_submissions WHERE room_id=? AND submission_id=?')
    .get(r.room.id, first_payload.submission_id).session_id;

  const retry = await f.request(discussion, first_payload, r.owner);
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.duplicate, true);
  assert.equal(retry.body.session.id, original_session_id);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS count FROM discussion_sessions WHERE room_id=?').get(r.room.id).count, 1);
  assert.equal((await f.request(discussion, { ...first_payload, goal: '不同内容' }, r.owner)).status, 409);

  const ended = await f.request(discussion, { action: 'end', revision: retry.body.revision }, r.owner);
  assert.equal(ended.status, 200, JSON.stringify(ended.body));
  const next_view = (await f.request(discussion)).body;
  const next = await f.request(discussion, { action: 'start', revision: next_view.revision, goal: '第二次启动',
    submission_id: 'discussion-start-retry-002' }, r.owner);
  assert.equal(next.status, 200, JSON.stringify(next.body));
  assert.equal(next.body.duplicate, false);
  assert.notEqual(next.body.session.id, original_session_id);
  const old_retry = await f.request(discussion, first_payload, r.owner);
  assert.equal(old_retry.status, 200, JSON.stringify(old_retry.body));
  assert.equal(old_retry.body.duplicate, true);
  assert.equal(old_retry.body.session.id, original_session_id);
  assert.equal(old_retry.body.session.start_submission_id, first_payload.submission_id);
  assert.equal(f.sql.prepare('SELECT status FROM discussion_sessions WHERE id=?').get(next.body.session.id).status, 'active');
  assert.equal((await f.request(discussion)).body.session.start_submission_id, 'discussion-start-retry-002');
});

test('Worker concurrent discussion starts from one revision reject the loser submission', async t => {
  const f = await worker_fixture(t);
  const r = await free_worker_room(f, [{ name: 'Codex', token: 'concurrent-start-codex'.repeat(3) }]);
  const discussion = `${r.path}/discussion`;
  const revision = (await f.request(discussion)).body.revision;
  const submissions = [
    { action: 'start', revision, goal: '并发方案甲', submission_id: 'concurrent-start-alpha' },
    { action: 'start', revision, goal: '并发方案乙', submission_id: 'concurrent-start-beta' },
  ];
  const results = await Promise.all(submissions.map(payload => f.request(discussion, payload, r.owner)));
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS count FROM discussion_sessions WHERE room_id=?').get(r.room.id).count, 1);
  const winner = results.find(result => result.status === 200);
  const loser_index = results.findIndex(result => result.status === 409);
  const winner_id = submissions[results.indexOf(winner)].submission_id;
  const loser = submissions[loser_index];
  const current = (await f.request(discussion)).body;
  assert.equal(current.session.start_submission_id, winner_id);
  const loser_retry = await f.request(discussion, loser, r.owner);
  assert.equal(loser_retry.status, 409);
  assert.equal((await f.request(discussion)).body.session.start_submission_id, winner_id);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS count FROM session_start_submissions WHERE room_id=?').get(r.room.id).count, 1);
});

test('Worker initial session read boundary preserves an empty cutoff and task sources do not count', async t => {
  const f = await worker_fixture(t);
  const r = await free_worker_room(f);
  const discussion = `${r.path}/discussion`;
  const initial = (await f.request(discussion)).body;
  const started = await f.request(discussion, { action: 'start', revision: initial.revision, goal: '空房间独立观点' }, r.owner);
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const roster = (await f.request(`${r.path}/turns/roster`)).body;
  const plan = await f.request(`${r.path}/turns`, { actor: 'Claude', submission_id: 'empty-session-plan', roster: roster.revision,
    expert: 'Claude', question: '请独立思考' }, r.claude);
  assert.equal(plan.status, 201, JSON.stringify(plan.body));
  const requestId = plan.body.turn.member_request_id;
  const later = await r.say('独立观点期间的新消息');
  assert.equal(later.status, 201, JSON.stringify(later.body));
  const bounded = await f.request(`${r.path}/messages?request_id=${requestId}`, undefined, r.claude);
  assert.equal(bounded.status, 200, JSON.stringify(bounded.body));
  assert.equal(bounded.body.total, 0, 'read_until=0 is an active independent-view boundary');
  const token_only = await f.request(`${r.path}/messages`, undefined, r.claude);
  assert.equal(token_only.status, 200, JSON.stringify(token_only.body));
  assert.equal(token_only.body.total, 0, 'a member token infers its active discussion request when no id is supplied');
  assert.equal((await f.request(`${r.path}/messages/${later.body.message.id}`, undefined, r.claude)).status, 404,
    'exact message reads use the same independent-view boundary');
  assert.equal((await f.request(r.path)).body.message_count, 1, 'internal tasks stay out of ordinary message counts');
});

test('Worker applies initial read cutoffs only to the first round of a multi-round plan', async t => {
  const f = await worker_fixture(t);
  const codex = 'cutoff-codex'.repeat(4);
  const r = await free_worker_room(f, [{ name: 'Codex', token: codex }]);
  const initial = (await f.request(`${r.path}/discussion`)).body;
  const started = await f.request(`${r.path}/discussion`, { action: 'start', revision: initial.revision, goal: '跨轮阅读边界' }, r.owner);
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const roster = (await f.request(`${r.path}/turns/roster`)).body;
  const plan = await f.request(`${r.path}/turns`, { actor: 'Claude', submission_id: 'cross-round-cutoff', roster: roster.revision,
    turns: [{ expert: 'Claude', question: '主持人独立观点' }, { expert: 'Codex', question: '专家独立观点' },
      { expert: 'Claude', question: '主持人后续讨论' }] }, r.claude);
  assert.equal(plan.status, 201, JSON.stringify(plan.body));
  const cutoff = f.sql.prepare('SELECT read_until FROM session_state WHERE session_id=?').get(started.body.session.id).read_until;
  const rows = f.sql.prepare('SELECT round,read_until FROM session_requests WHERE session_id=? AND purpose=\'discuss\' ORDER BY id')
    .all(started.body.session.id);
  assert.deepEqual(rows.map(row => row.round), [1, 1, 2]);
  assert.deepEqual(rows.map(row => row.read_until), [cutoff, cutoff, null]);
  const host = (await r.reserve('Claude')).body;
  assert.equal((await r.answer(host.id, r.claude, 'Claude')).status, 201);
  assert.equal(f.sql.prepare('SELECT read_until FROM session_requests WHERE id=?').get(plan.body.queued[1].id).read_until, null,
    'the queued second round keeps its unbounded discussion read after phase advances');
});

test('Worker explicit ordinary ask reads are unbounded while discussion reads retain session bounds', async t => {
  const f = await worker_fixture(t);
  const r = await free_worker_room(f);
  const ask = (await r.say('普通请求', { to: ['Claude'] })).body.message;
  const ask_request = (await f.request(`${r.path}/inbox`, undefined, r.owner)).body.members[0].pending[0];
  await r.say('另一个普通请求', { to: ['Claude'] });
  const ordinary = await f.request(`${r.path}/messages?request_id=${ask_request.id}`, undefined, r.claude);
  assert.equal(ordinary.status, 200, JSON.stringify(ordinary.body));
  assert.equal(ordinary.body.total, 2, 'an ask request does not impose a discussion cutoff');
  const ask_execution = (await r.reserve()).body;
  assert.equal((await f.request(`${r.path}/messages?execution_id=${ask_execution.id}`, undefined, r.claude)).body.total, 2,
    'an ordinary execution does not impose a discussion cutoff');
  assert.equal((await f.request(`${r.path}/messages?request_id=${ask_request.id}&execution_id=${ask_execution.id}`, undefined, r.claude)).status, 400);
  const initial = (await f.request(`${r.path}/discussion`)).body;
  await f.request(`${r.path}/discussion`, { action: 'start', revision: initial.revision, goal: '范围验证' }, r.owner);
  const roster = (await f.request(`${r.path}/turns/roster`)).body;
  const plan = await f.request(`${r.path}/turns`, { actor: 'Claude', submission_id: 'bounded-discussion', roster: roster.revision,
    expert: 'Claude', question: '独立阅读' }, r.claude);
  assert.equal(plan.status, 201, JSON.stringify(plan.body));
  const bounded = await f.request(`${r.path}/messages?request_id=${plan.body.turn.member_request_id}`, undefined, r.claude);
  assert.equal(bounded.status, 200, JSON.stringify(bounded.body));
  assert.equal(bounded.body.total, 2, 'discussion requests are limited to messages before their read cutoff');
  assert.equal(ask.id > bounded.body.messages.at(-1).id, false);
  const host_message = (await r.say('主持人收到的普通用户留言')).body.message;
  const host_request = (await f.request(`${r.path}/inbox`, undefined, r.owner)).body.members[0].pending.find(item => item.purpose === 'discuss_host');
  const host_read = await f.request(`${r.path}/messages?request_id=${host_request.id}`, undefined, r.claude);
  assert.equal(host_read.status, 200, JSON.stringify(host_read.body));
  assert.ok(host_read.body.messages.some(item => item.id === host_message.id), 'host tasks retain ordinary history reads');
});

test('Worker failed discussion delivery creates one deterministic host task with the failure cause', async t => {
  const f = await worker_fixture(t);
  const codex = 'codex-free'.repeat(4);
  const r = await free_worker_room(f, [{ name: 'Codex', adapter: 'codex_cli', token: codex }]);
  const discussion = `${r.path}/discussion`;
  const initial = (await f.request(discussion)).body;
  const started = await f.request(discussion, { action: 'start', revision: initial.revision, goal: '处理失败' }, r.owner);
  const roster = (await f.request(`${r.path}/turns/roster`)).body;
  const plan = await f.request(`${r.path}/turns`, { actor: 'Claude', submission_id: 'failed-session-plan', roster: roster.revision,
    expert: 'Codex', question: '请检查问题' }, r.claude);
  assert.equal(plan.status, 201, JSON.stringify(plan.body));
  f.sql.prepare("UPDATE member_requests SET status='failed' WHERE id=?").run(plan.body.turn.member_request_id);
  assert.equal((await f.request(`${r.path}/inbox`, undefined, r.owner)).status, 200);
  assert.equal(f.sql.prepare("SELECT status FROM session_requests WHERE id=?").get(plan.body.turn.id).status, 'failed');
  const host_tasks = f.sql.prepare(`SELECT COUNT(*) AS count FROM task_message_sources WHERE session_id=? AND cause_kind='request_failed'
    AND cause_request_id=?`).get(started.body.session.id, plan.body.turn.member_request_id).count;
  assert.equal(host_tasks, 1);
  await f.request(`${r.path}/inbox`, undefined, r.owner);
  assert.equal(f.sql.prepare(`SELECT COUNT(*) AS count FROM task_message_sources WHERE session_id=? AND cause_kind='request_failed'
    AND cause_request_id=?`).get(started.body.session.id, plan.body.turn.member_request_id).count, 1,
  'reconciliation reuses the failed request as a stable cause');
});

test('Worker discussion requests stay separate from a direct ask already using that member session', async t => {
  const f = await worker_fixture(t);
  const codex = 'codex-free'.repeat(4);
  const r = await free_worker_room(f, [{ name: 'Codex', adapter: 'codex_cli', token: codex }]);
  assert.equal((await r.say('先回答这个问题', { to: ['Codex'] })).status, 201);
  const ask = await r.reserve('Codex');
  assert.equal(ask.status, 200, JSON.stringify(ask.body));
  const discussion = `${r.path}/discussion`;
  const initial = (await f.request(discussion)).body;
  const started = await f.request(discussion, { action: 'start', revision: initial.revision, goal: '不要合并执行' }, r.owner);
  const roster = (await f.request(`${r.path}/turns/roster`)).body;
  const plan = await f.request(`${r.path}/turns`, { actor: 'Claude', submission_id: 'separate-session-plan', roster: roster.revision,
    turns: [{ expert: 'Claude', question: '先由主持人发言' }, { expert: 'Codex', question: '随后由 Codex 发言' }] }, r.claude);
  assert.equal(plan.status, 201, JSON.stringify(plan.body));
  const host_execution = await r.reserve('Claude');
  assert.equal(host_execution.status, 200, JSON.stringify(host_execution.body));
  assert.equal((await r.answer(host_execution.body.id)).status, 201);
  assert.equal((await r.reserve('Codex')).status, 409, 'the existing ask execution prevents parallel discussion execution');
  assert.equal((await r.answer(ask.body.id, codex, 'Codex')).status, 201);
  const discussion_execution = await r.reserve('Codex');
  assert.equal(discussion_execution.status, 200, JSON.stringify(discussion_execution.body));
  assert.deepEqual(discussion_execution.body.requests.map(item => item.purpose), ['discuss']);
  assert.equal(discussion_execution.body.requests[0].source_question, '随后由 Codex 发言');
  assert.equal(f.sql.prepare('SELECT status FROM session_requests WHERE id=?').get(plan.body.queued[0].id).status, 'open');
  assert.ok(started.body.session.id);
});

test('Worker smart scheduling can recommend a manual member, which the inbox lists apart from woken ones', async t => {
  const f = await worker_fixture(t);
  const gemini_token = 'gemini-free'.repeat(4);
  const r = await free_worker_room(f, [{ name: 'Gemini', access: 'manual', token: gemini_token }]);
  const inbox = async () => (await f.request(`${r.path}/inbox`, undefined, r.owner)).body;
  assert.deepEqual((await inbox()).observers, [], 'an unregistered manual member does not exist yet');
  assert.equal((await f.request(`${r.path}/register`, {}, gemini_token)).status, 200);
  const first = (await r.say('帮我看看登录报错')).body.message.id;
  const listed = await inbox();
  assert.deepEqual([listed.members.map(member => member.name), listed.observers.map(member => member.name)], [['Claude'], ['Gemini']]);
  const gemini_id = await r.member_id('Gemini');
  assert.equal((await f.request(`${r.path}/recommendations`, { message_id: first, member_id: gemini_id, provider: 'jev', confidence: 0.9 }, r.owner)).status, 200);
  assert.equal((await f.request(`${r.path}/recommendations/${first}`, { action: 'adopt', mode: 'interrupt' }, r.owner)).body.recommendation.status, 'adopted');
  assert.deepEqual((await inbox()).observers[0].pending.map(item => item.message_id), [first]);
});

test('Worker free rooms take over a registered manual member with a credential the service generates', async t => {
  const f = await worker_fixture(t);
  const gemini = 'gemini-free'.repeat(4);
  const r = await free_worker_room(f, [{ name: 'Gemini', access: 'manual', token: gemini }]);
  const id = await r.member_id('Gemini');
  const renewed = 'service-made-credential'.repeat(2);
  const adopt = { action: 'adopt', adapter: 'antigravity_cli', session_id: 'session-1', token: renewed };
  assert.equal((await f.request(`${r.path}/members/${id}`, adopt, r.owner)).status, 400, 'not registered yet');
  assert.equal((await f.request(`${r.path}/register`, {}, gemini)).status, 200);
  assert.equal((await f.request(`${r.path}/members/${id}`, adopt, r.owner)).status, 400, 'no session reported yet');
  await f.raw(r.path, { headers: { 'X-Discussion-Token': gemini, 'X-Discussion-Session': 'session-1', 'X-Discussion-Session-Client': 'antigravity' } });
  for (const adapter of [['antigravity_cli'], { value: 'antigravity_cli' }, 1]) {
    assert.equal((await f.request(`${r.path}/members/${id}`, { ...adopt, adapter }, r.owner)).status, 400);
  }
  assert.equal((await f.request(`${r.path}/members/${id}`, { ...adopt, token: 'short' }, r.owner)).status, 400, 'an invalid credential is refused');
  const adopted = await f.request(`${r.path}/members/${id}`, adopt, r.owner);
  assert.equal(adopted.status, 200, JSON.stringify(adopted.body));
  const member = adopted.body.members.find(item => item.name === 'Gemini');
  assert.deepEqual([member.access, member.session_mode], ['runner', 'borrowed']);
  assert.equal((await f.request(`${r.path}/register`, {}, gemini)).status, 403, 'the browser-made credential no longer works');
  assert.ok((await f.request(`${r.path}/inbox`, undefined, r.owner)).body.members.some(item => item.name === 'Gemini'));
});

test('Worker free rooms bundle requests into one execution and reject late or unbound answers', async t => {
  const f = await worker_fixture(t);
  const r = await free_worker_room(f);
  const first = (await r.say('改标题')).body.message;
  await r.say('先别动 footer');
  const reserved = await r.reserve();
  assert.equal(reserved.status, 200, JSON.stringify(reserved.body));
  assert.deepEqual(reserved.body.requests.map(item => item.message_id), [first.id, first.id + 1]);
  assert.equal((await r.reserve()).status, 409);
  assert.equal((await r.answer(null)).status, 400);
  const saved = await r.answer(reserved.body.id);
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  assert.equal(saved.body.message.kind, 'chat');
  const free = (await f.request(r.path)).body.free;
  assert.deepEqual(free.requests.map(item => item.status), ['completed', 'completed']);
  assert.equal(free.members[0].read_until, saved.body.message.id);
  await r.say('再来');
  const second = (await r.reserve()).body;
  assert.equal((await f.request(`${r.path}/members/${await r.member_id('Claude')}/interrupt`, {}, r.owner)).status, 200);
  assert.equal((await r.answer(second.id)).status, 409);
  await r.say('第三条');
  const third = (await r.reserve()).body;
  f.sql.prepare('UPDATE member_executions SET created_at=unixepoch()-3600,lease_until=unixepoch()-3480 WHERE id=?').run(third.id);
  assert.equal((await r.answer(third.id)).status, 409);
  assert.deepEqual((await f.request(`${r.path}/inbox`, undefined, r.owner)).body.executions, []);
  assert.equal((await f.request(r.path)).body.free.members[0].execution.result, '执行租约到期，接入程序未续租');
  await r.say('长任务');
  const long = (await r.reserve()).body;
  f.sql.prepare('UPDATE discussion_limits SET execution_minutes=1 WHERE room_id=?').run(r.room.id);
  f.sql.prepare('UPDATE member_executions SET created_at=unixepoch()-3600 WHERE id=?').run(long.id);
  const kept = await f.request(`${r.path}/executions/${long.id}`, { action: 'renew' }, r.owner);
  assert.equal(kept.status, 200, 'one execution has no time limit, even with a legacy stored value');
  assert.ok(kept.body.lease_until > Math.floor(Date.now() / 1000) + 60);
  assert.equal('execution_minutes' in (await f.request(`${r.path}/inbox`, undefined, r.owner)).body, false);
  assert.equal((await f.request(`${r.path}/inbox`, undefined, r.claude)).status, 403);
});

test('Worker records what each delivery can do and how a voided one stopped', async t => {
  const f = await worker_fixture(t);
  const r = await free_worker_room(f, [{ name: 'Codex', adapter: 'codex_cli', token: 'delivery-codex'.repeat(3) }]);
  await r.say('先做这个', { to: ['Codex'] });
  const working = (await r.reserve('Codex')).body;
  const url = `${r.path}/executions/${working.id}`;
  assert.equal((await f.request(url, { action: 'delivery', stoppable: 'no', progress: false }, r.owner)).status, 400);
  assert.equal((await f.request(url, { action: 'stopped', result: 'stopped' }, r.owner)).status, 409, 'a live execution has no stop result');
  assert.equal((await f.request(url, { action: 'delivery', stoppable: false, progress: false }, r.owner)).status, 200);
  const member = (await f.request(r.path)).body.free.members.find(item => item.name === 'Codex');
  assert.deepEqual([member.execution.capabilities, member.execution.stop_result], [{ stoppable: false, progress: false }, '']);
  assert.equal((await f.request(`${r.path}/members/${await r.member_id('Codex')}/interrupt`, {}, r.owner)).status, 200);
  assert.equal((await f.request(url, { action: 'delivery', stoppable: false, progress: false }, r.owner)).status, 200);
  assert.equal((await f.request(url, { action: 'stopped', result: 'unstoppable' }, r.owner)).status, 200);
  assert.equal((await f.request(url, { action: 'stopped', result: 'unstoppable' }, r.owner)).body.duplicate, true);
  assert.equal((await f.request(url, { action: 'stopped', result: 'stopped' }, r.owner)).status, 409, 'recorded once');
  const report = (await f.request(r.path)).body.free.executions.find(item => item.id === working.id);
  assert.deepEqual([report.status, report.capabilities, report.stop_result], ['cancelled', { stoppable: false, progress: false }, 'unstoppable']);
  // The window may still be on the voided turn: the member's next message waits instead of arriving mid-turn.
  await r.say('补充一句', { to: ['Codex'] });
  assert.equal((await r.reserve('Codex')).status, 409);
  assert.ok((await f.request(`${r.path}/inbox`, undefined, r.owner)).body.members.find(item => item.name === 'Codex').held_until > 0);
  // Its late answer is refused as an answer, kept apart for the page, and ends the wait.
  const late = { author: 'Codex', text: '迟到的回答', source: 'cli', kind: 'chat', execution_id: working.id, submission_id: crypto.randomUUID().replaceAll('-', '') };
  assert.equal((await f.request(`${r.path}/messages`, late, 'delivery-codex'.repeat(3))).status, 409);
  const after = (await f.request(r.path)).body.free.executions.find(item => item.id === working.id);
  assert.deepEqual(Object.keys(after.late_answer), ['created_at']);
  for (const token of ['delivery-codex'.repeat(3), 'anonymous']) {
    assert.ok(!JSON.stringify((await f.request(r.path, undefined, token)).body).includes('迟到的回答'));
    assert.equal((await f.request(url + '/late-answer', undefined, token)).status, 403);
  }
  assert.equal((await f.request(url + '/late-answer', undefined, r.owner)).body.text, '迟到的回答');
  assert.ok(!(await f.request(`${r.path}/messages`)).body.messages.some(item => item.text === '迟到的回答'));
  assert.equal((await r.reserve('Codex')).status, 200);
});

test('Worker late delivery and unconfirmed stop reports keep the original hold deadline', async t => {
  const f = await worker_fixture(t), r = await free_worker_room(f, []);
  const id = await r.member_id('Claude');
  for (const result of ['unstoppable', 'unconfirmed']) {
    await r.say('开始', { to: ['Claude'] });
    const execution = (await r.reserve()).body, url = `${r.path}/executions/${execution.id}`;
    await f.request(`${r.path}/members/${id}/interrupt`, {}, r.owner);
    const payload = { action: 'stopped', result };
    assert.equal((await f.request(url, payload, r.owner)).status, 200);
    assert.equal((await f.request(url, payload, r.owner)).body.duplicate, true);
    const held = async () => (await f.request(`${r.path}/inbox`, undefined, r.owner)).body.members[0].held_until;
    const deadline = await held();
    assert.ok(deadline > 0);
    assert.equal((await f.request(url, { action: 'delivery', stoppable: true, progress: true }, r.owner)).status, 200);
    await r.say('主动重发', { to: ['Claude'] });
    assert.equal(await held(), deadline);
    assert.equal((await r.reserve()).status, 409);
    if (result === 'unconfirmed') assert.equal((await f.request(url, { action: 'stopped', result: 'stopped' }, r.owner)).status, 200);
    else f.sql.prepare('UPDATE member_executions SET finished_at=unixepoch()-601 WHERE id=?').run(execution.id);
    assert.equal(await held(), 0);
    assert.equal((await r.answer((await r.reserve()).body.id, r.claude, 'Claude')).status, 201);
  }
});

test('Worker rewind rejects a capability change at transaction commit', async t => {
  const f = await worker_fixture(t), r = await free_worker_room(f, []);
  const id = await r.member_id('Claude');
  await f.request(`${r.path}/members/${id}/capabilities`, { rewind: 'cut' }, r.owner);
  const message = (await r.say('处理', { to: ['Claude'] })).body.message;
  await r.answer((await r.reserve()).body.id, r.claude, 'Claude');
  const plan = (await f.request(`${r.path}/rewind?message_id=${message.id}`, undefined, r.owner)).body;
  assert.equal(plan.members[0].session, 'cut');
  f.before_batch = () => f.sql.prepare("UPDATE member_capabilities SET rewind='kept' WHERE member_id=?").run(id);
  const result = await f.request(`${r.path}/rewind`, { message_id: message.id, revision: plan.revision }, r.owner);
  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS count FROM room_rewinds').get().count, 0);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS count FROM message_withdrawals').get().count, 0);
});

test('schema reinitialization retains pre-capability delivery records', async t => {
  const f = await worker_fixture(t);
  f.sql.exec("CREATE TABLE execution_deliveries(execution_id INTEGER PRIMARY KEY,delivery TEXT); INSERT INTO execution_deliveries VALUES(1,'window')");
  f.sql.exec(await readFile(join(PROJECT_ROOT, 'backend', 'schema.sql'), 'utf8'));
  assert.equal(f.sql.prepare('SELECT delivery FROM execution_deliveries WHERE execution_id=1').get().delivery, 'window');
});

test('Worker owner stop ends every live and queued request of a free room', async t => {
  const f = await worker_fixture(t);
  const r = await free_worker_room(f, [{ name: 'Codex', adapter: 'codex_cli', token: 'stop-all-codex'.repeat(3) }]);
  await r.say('先做这个', { to: ['Codex'] });
  const working = (await r.reserve('Codex')).body;
  await r.say('再补充一句', { to: ['Codex'] });
  assert.equal((await f.request(`${r.path}/stop`, {})).status, 403);
  assert.equal((await f.request(`${r.path}/stop`, {}, r.owner)).status, 200);
  const view = (await f.request(r.path)).body.free;
  assert.deepEqual([...new Set(view.requests.map(item => `${item.status}:${item.cancel_reason}`))], ['cancelled:user_stop']);
  assert.equal(view.executions.find(item => item.id === working.id).status, 'cancelled');
});

test('Worker free rooms hand unnamed messages to the new host, record cancel reasons and void work on archive', async t => {
  const f = await worker_fixture(t);
  const codex = 'codex-free'.repeat(4);
  const r = await free_worker_room(f, [{ name: 'Codex', adapter: 'codex_cli', token: codex }]);
  const for_message = async id => (await f.request(r.path)).body.free.requests.filter(item => item.message_id === id)
    .map(item => [item.member, item.status, item.purpose, item.cancel_reason]).sort();
  const first = (await r.say('没点名的问题')).body.message;
  assert.equal((await f.request(`${r.path}/members/${await r.member_id('Claude')}`, { action: 'remove' }, r.owner)).status, 200);
  assert.equal((await f.request(r.path)).body.host, 'Codex');
  assert.deepEqual(await for_message(first.id), [['Claude', 'cancelled', 'route', 'member_removed'], ['Codex', 'pending', 'route', null]]);
  // A host change moves unstarted routes, a user stop records its reason and keeps what arrived meanwhile, and archiving voids what is still owed.
  const g = await worker_fixture(t);
  const room = await free_worker_room(g, [{ name: 'Codex', adapter: 'codex_cli', token: codex }]);
  const route = async id => (await g.request(room.path)).body.free.requests.filter(item => item.message_id === id)
    .map(item => [item.member, item.status, item.cancel_reason]).sort();
  const second = (await room.say('另一个没点名的问题')).body.message;
  assert.equal((await g.request(`${room.path}/members/${await room.member_id('Codex')}`, { action: 'role', role: 'host' }, room.owner)).status, 200);
  assert.deepEqual(await route(second.id), [['Claude', 'cancelled', 'rerouted'], ['Codex', 'pending', null]]);
  const working = (await room.reserve('Codex')).body;
  const follow_up = (await room.say('补充一句', { to: ['Codex'] })).body.message;
  assert.equal((await g.request(`${room.path}/members/${await room.member_id('Codex')}/interrupt`, {}, room.owner)).status, 200);
  assert.deepEqual(await route(second.id), [['Claude', 'cancelled', 'rerouted'], ['Codex', 'cancelled', 'user_stop']]);
  assert.deepEqual(await route(follow_up.id), [['Codex', 'pending', null]], 'a message sent while the member worked waits for its next turn');
  assert.equal((await g.request(room.path)).body.free.executions.find(item => item.id === working.id).status, 'cancelled');
  await room.say('给 Claude', { to: ['Claude'] });
  const execution = (await room.reserve('Claude')).body;
  await room.say('再来一条', { to: ['Claude'] });
  assert.equal((await g.request(`${room.path}/archive`, { actor: '用户' }, room.owner)).status, 200);
  const view = (await g.request(room.path)).body.free;
  assert.deepEqual([...new Set(view.requests.filter(item => item.cancel_reason === 'archived').map(item => item.status))], ['cancelled']);
  assert.equal(view.executions.find(item => item.id === execution.id).status, 'cancelled');
});

test('Worker free rooms keep runner lifecycle, membership and manual members consistent with Python', async t => {
  const f = await worker_fixture(t);
  const codex = 'codex-free'.repeat(4);
  const r = await free_worker_room(f, [{ name: 'Codex', adapter: 'codex_cli', token: codex }]);
  assert.equal((await r.say('没有点名')).status, 201);
  // The user is the client: Claude, the first runner member, hosts and routes the unnamed message.
  assert.deepEqual((await f.request(r.path)).body.free.requests.map(item => [item.member, item.purpose]), [['Claude', 'route']]);
  assert.equal((await r.say('不在场', { to: ['Gemini'] })).status, 400);
  await r.say('两位都看', { to: ['Claude', 'Codex'] });
  const claude = (await r.reserve('Claude')).body, other = (await r.reserve('Codex')).body;
  const report = (execution, changes) => f.request(`${r.path}/executions/${execution.id}`, { action: 'report', changes }, r.owner);
  assert.equal((await report(claude, ['index.html'])).status, 200);
  assert.equal((await report(claude, ['b.css'])).status, 409);
  assert.equal((await report(other, ['index.html', 'x.js'])).status, 200);
  const denial = { tool: 'PowerShell', detail: 'lark-cli docs get x', rule: 'PowerShell(lark-cli *)' };
  const deny = denials => f.request(`${r.path}/executions/${claude.id}`, { action: 'denials', denials }, r.owner);
  assert.equal((await deny([{ detail: 'no tool' }])).status, 400);
  assert.equal((await deny([denial])).status, 200);
  assert.equal((await deny([denial])).status, 409);
  // A manual member's refused delivery waits for a retry the owner can ask for now or stop.
  const answer_retry = body => f.request(`${r.path}/executions/${claude.id}`, body, r.owner);
  const wait = { action: 'retry_wait', attempt: 1, retry_at: Math.floor(Date.now() / 1000) + 60, reason: '投递失败：原窗口拒绝' };
  assert.equal((await answer_retry({ ...wait, attempt: 4 })).status, 400);
  assert.equal((await answer_retry({ action: 'retry_now' })).status, 409);
  assert.equal((await answer_retry(wait)).status, 200);
  assert.deepEqual((await f.request(r.path)).body.free.members.find(item => item.name === 'Claude').execution.retry,
    { attempt: 1, retry_at: wait.retry_at, reason: wait.reason, stopped: 0 });
  assert.equal((await answer_retry({ action: 'retry_now' })).status, 200);
  assert.ok((await f.request(`${r.path}/executions/${claude.id}`, undefined, r.owner)).body.retry.retry_at <= Math.floor(Date.now() / 1000));
  assert.equal((await answer_retry({ action: 'retry_stop' })).status, 200);
  assert.equal((await answer_retry({ action: 'retry_stop' })).status, 409);
  assert.equal((await f.request(`${r.path}/inbox`, undefined, r.owner)).body.executions.find(item => item.id === claude.id).retry.stopped, 1);
  const reports = (await f.request(r.path)).body.free.executions;
  assert.deepEqual(reports.find(item => item.id === claude.id).changes, ['index.html']);
  assert.deepEqual([reports.find(item => item.id === claude.id).denials, reports.find(item => item.id === other.id).denials], [[denial], []]);
  assert.equal(reports[0].changes_recorded, true);
  assert.doesNotMatch(JSON.stringify(reports), /token_hash|control_hash|client_id/);
  assert.deepEqual((await f.request(r.path)).body.free.conflicts, [{ members: ['Claude', 'Codex'], executions: [claude.id, other.id], files: ['index.html'] }]);
  const codex_id = await r.member_id('Codex');
  const away = await f.request(`${r.path}/members/${codex_id}`, { action: 'away' }, r.owner);
  assert.deepEqual(away.body.members.map(member => [member.name, member.status, member.execution.status]),
    [['Claude', 'active', 'dispatched'], ['Codex', 'away', 'cancelled']]);
  assert.deepEqual((await f.request(r.path)).body.experts, { Claude: 'cli', Codex: 'cli' });
  assert.equal((await f.request(`${r.path}/members/${codex_id}`, { action: 'active', token: codex }, r.owner)).status, 400);
  const renewed = 'codex-new'.repeat(5);
  assert.equal((await f.request(`${r.path}/members/${codex_id}`, { action: 'active', token: renewed }, r.owner)).status, 200);
  assert.equal((await r.answer(other.id, codex, 'Codex')).status, 403);
  assert.equal((await r.answer(claude.id)).status, 201);
  const fail_release = await r.say('失败与退回', { to: ['Claude'] });
  assert.equal(fail_release.status, 201);
  const failing = (await r.reserve('Claude')).body;
  assert.equal((await f.request(`${r.path}/executions/${failing.id}`, { action: 'release', reason: '未送达' }, r.owner)).body.status, 'cancelled');
  const retry = (await r.reserve('Claude')).body;
  assert.deepEqual(retry.requests.map(item => item.message_id), failing.requests.map(item => item.message_id));
  const future = Math.floor(Date.now() / 1000) + 600;
  assert.equal((await f.request(`${r.path}/executions/${retry.id}`, { action: 'renew', activity: 'command', activity_at: future }, r.owner)).status, 200);
  const working = (await f.request(r.path)).body.free.members.find(item => item.name === 'Claude').execution;
  assert.equal(working.activity, 'command');
  assert.ok(working.activity_at <= Math.floor(Date.now() / 1000), 'a future output time is capped at the server clock');
  assert.equal((await f.request(`${r.path}/executions/${retry.id}`, { action: 'renew', activity: 'sleeping', activity_at: future }, r.owner)).status, 400);
  assert.equal((await f.request(`${r.path}/descriptions`, { descriptions: { Claude: '审美好' } }, codex)).status, 403);
  assert.deepEqual((await f.request(`${r.path}/descriptions`, { descriptions: { Claude: ' 审美好 ', Codex: '代码写得好' } }, r.owner)).body.descriptions, { Claude: '审美好', Codex: '代码写得好' });
  assert.deepEqual((await f.request(r.path)).body.descriptions, { Claude: '审美好', Codex: '代码写得好' });
  assert.equal((await f.request(`${r.path}/descriptions`, { descriptions: { Claude: 'x'.repeat(501) } }, r.owner)).status, 400);
  assert.deepEqual((await f.request(`${r.path}/descriptions`, { descriptions: { Codex: '' } }, r.owner)).body.descriptions, { Claude: '审美好' });
  // Display labels follow the same owner-only, empty-removes rule; the member's name stays its identity.
  assert.equal((await f.request(`${r.path}/labels`, { labels: { Claude: '评审官' } }, codex)).status, 403);
  assert.deepEqual((await f.request(`${r.path}/labels`, { labels: { Claude: ' 评审官 ' } }, r.owner)).body.labels, { Claude: '评审官' });
  assert.deepEqual((await f.request(r.path)).body.labels, { Claude: '评审官' });
  assert.equal((await f.request(`${r.path}/labels`, { labels: { Claude: 'x'.repeat(33) } }, r.owner)).status, 400);
  assert.deepEqual((await f.request(`${r.path}/labels`, { labels: { Claude: '' } }, r.owner)).body.labels, {});
  const notes = [{ seq: 1, text: '读完材料' }, { seq: 2, text: '开始验证' }];
  for (let index = 0; index < 2; index++) assert.equal((await f.request(`${r.path}/executions/${retry.id}`, { action: 'renew', notes }, r.owner)).status, 200);
  assert.equal((await f.request(r.path)).body.free.members.find(item => item.name === 'Claude').execution.notes, 2);
  assert.deepEqual((await f.request(`${r.path}/executions/${retry.id}/notes`)).body.notes.map(note => note.text), ['读完材料', '开始验证']);
  assert.equal((await f.request(`${r.path}/executions/${retry.id}`, { action: 'renew', notes: [{ seq: 51, text: 'x' }] }, r.owner)).status, 400);
  const segments = [{ seq: 1, phase: 'thinking', start_ms: -50, end_ms: 400 }, { seq: 2, phase: 'command', tool: 'Bash', start_ms: 400, end_ms: 10 ** 9 }];
  for (let index = 0; index < 2; index++) assert.equal((await f.request(`${r.path}/executions/${retry.id}`, { action: 'segments', segments }, r.owner)).status, 200);
  assert.equal((await f.request(`${r.path}/executions/${retry.id}`, { action: 'segments', segments: [{ seq: 3, phase: 'sleeping', start_ms: 0, end_ms: 1 }] }, r.owner)).status, 400);
  const timed = (await f.request(`${r.path}/timeline`)).body.executions.find(item => item.source === 'free' && item.id === retry.id);
  assert.equal(timed.state, 'running');
  assert.deepEqual(timed.segments.map(item => [item.phase, item.tool, item.start_ms]), [['thinking', '', 0], ['command', 'Bash', 400]]);
  assert.ok(timed.segments[1].end_ms <= (Math.floor(Date.now() / 1000) - timed.dispatched_at + 1) * 1000, 'segments stay within the execution');
  assert.equal((await f.request(`${r.path}/executions/${retry.id}`, { action: 'segments', segments: [], notes: [{ seq: 3, text: '随阶段上报' }] }, r.owner)).status, 200);
  assert.equal((await f.request(`${r.path}/executions/${retry.id}`, { action: 'segments', segments: [] }, r.owner)).status, 400);
  const noted = (await f.request(`${r.path}/timeline`)).body;
  const noted_item = noted.executions.find(item => item.source === 'free' && item.id === retry.id);
  assert.equal(noted_item.notes.length, 3);
  assert.deepEqual([noted_item.last_note, noted_item.result, typeof noted_item.task], ['随阶段上报', null, 'string']);
  const later = (await f.request(`${r.path}/timeline?after=${noted.now + 60}`)).body.executions;
  assert.deepEqual(later.map(item => item.id), [retry.id], 'only the running execution is read again');
  assert.equal((await f.request(`${r.path}/executions/${retry.id}`, { action: 'fail', reason: 'CLI 退出' }, r.owner)).body.status, 'failed');
  assert.equal((await f.request(r.path)).body.phase, 'discussing');
  const gemini = 'gemini-free'.repeat(4);
  assert.equal((await f.request(`${r.path}/members`, { name: 'Gemini', token: gemini, access: 'manual' }, r.owner)).status, 200);
  assert.equal((await f.request(`${r.path}/members`, { name: 'Gemini', token: gemini }, r.owner)).status, 409);
  assert.equal((await r.say('先别点 Gemini', { to: ['Gemini'] })).status, 400, 'an unregistered manual member cannot be named');
  assert.equal((await f.request(`${r.path}/register`, {}, gemini)).status, 200);
  await r.say('请 Gemini 看看', { to: ['Gemini'] });
  assert.deepEqual((await f.request(`${r.path}/inbox`, undefined, r.owner)).body.members.map(member => member.name), ['Claude', 'Codex']);
  assert.equal((await r.reserve('Gemini')).status, 404);
  const request_id = (await f.request(r.path)).body.free.requests.find(item => item.member === 'Gemini').id;
  assert.equal((await r.answer(null, gemini, 'Gemini', { request_ids: [request_id + 999] })).status, 409);
  assert.equal((await r.answer(null, gemini, 'Gemini', { request_ids: [request_id] })).status, 201);
  assert.equal((await f.request(r.path)).body.free.requests.find(item => item.id === request_id).status, 'completed');
  assert.equal((await f.request(`${r.path}/members/${codex_id}`, { action: 'remove' }, r.owner)).status, 200);
  assert.deepEqual((await f.request(r.path)).body.experts, { Claude: 'cli', Gemini: 'cli' });
  assert.equal((await f.request(`${r.path}/delete`, { actor: '用户', confirm_title: '自由协作' }, r.owner)).status, 200);
  for (const table of ['room_modes', 'room_members', 'member_requests', 'member_executions', 'execution_segments']) {
    assert.equal(f.sql.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0, table);
  }
});

test('Worker execution reports distinguish missing and empty detection and cap history', async t => {
  const f = await worker_fixture(t), r = await free_worker_room(f);
  const message = (await r.say('只读检查')).body.message;
  const execution = (await r.reserve()).body;
  const answer = (await r.answer(execution.id)).body.message;
  assert.equal((await f.request(r.path)).body.free.executions[0].changes_recorded, false);
  await f.request(`${r.path}/executions/${execution.id}`, { action: 'report', changes: [] }, r.owner);
  const report = (await f.request(r.path)).body.free.executions[0];
  assert.deepEqual([report.answer_id, report.request_message_id, report.request_ids], [answer.id, message.id, execution.requests.map(item => item.id)]);
  assert.deepEqual([report.changes_recorded, report.changes], [true, []]);
  for (let index = 0; index < 101; index++) f.sql.prepare(`INSERT INTO member_executions (room_id,member_id,client_id,status,created_at) VALUES (?,?,?,'failed',1)`).run(r.room.id, execution.member_id, `history-${index}`);
  assert.equal((await f.request(r.path)).body.free.executions.length, 100);
  // The answer keeps naming its execution after the report ages out, so its card keeps its slot.
  const listed = (await f.request(`${r.path}/messages`)).body.messages.find(item => item.id === answer.id);
  assert.deepEqual([listed.execution_id, listed.request_message_id], [execution.id, message.id]);
});

test('Worker free answers are rejected atomically when the execution is cancelled mid-request', async t => {
  const f = await worker_fixture(t);
  const r = await free_worker_room(f);
  await r.say('开始');
  const execution = (await r.reserve()).body;
  const before = f.sql.prepare('SELECT COUNT(*) AS count FROM messages').get().count;
  f.before_batch = () => f.sql.prepare("UPDATE member_executions SET status='cancelled' WHERE id=?").run(execution.id);
  assert.equal((await r.answer(execution.id)).status, 409);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS count FROM messages').get().count, before);
  assert.equal(f.sql.prepare('SELECT status FROM member_requests').get().status, 'delivering');
});

test('Worker free hosts route, dispatch, hand back once, hold a dispatch past the round limit and continue it', async t => {
  const f = await worker_fixture(t);
  const codex = 'codex-free'.repeat(4), gemini = 'gemini-free'.repeat(4);
  const r = await free_worker_room(f, [{ name: 'Codex', token: codex }, { name: 'Gemini', token: gemini }]);
  const tokens = { Claude: r.claude, Codex: codex, Gemini: gemini };
  assert.equal((await f.request(`${r.path}/members/${await r.member_id('Claude')}`, { action: 'role', role: 'host' }, r.owner)).status, 200);
  const requests = async () => (await f.request(r.path)).body.free.requests.map(item => [item.member, item.purpose, item.status]);
  const work = async (name, extra = {}) => {
    const execution = (await r.reserve(name)).body;
    const saved = await r.answer(execution.id, tokens[name], name, extra);
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
  };
  await r.say('请安排');
  assert.deepEqual(await requests(), [['Claude', 'route', 'pending']]);
  const codex_execution = (await r.reserve('Codex'));
  assert.equal(codex_execution.status, 409);
  const host = (await r.reserve('Claude')).body;
  assert.equal((await r.answer(host.id, r.claude, 'Claude', { to: ['Claude'] })).status, 400);
  assert.equal((await r.answer(host.id, r.claude, 'Claude', { to: ['Codex', 'Gemini'] })).status, 201);
  await work('Codex');
  assert.equal((await requests()).filter(item => item[1] === 'handoff').length, 0);
  await work('Gemini');
  assert.deepEqual((await requests()).filter(item => item[1] === 'handoff'), [['Claude', 'handoff', 'pending']]);
  const codex_bad = (await r.say('越权检查', { to: ['Codex'] })).body;
  assert.ok(codex_bad.message);
  const codex_run = (await r.reserve('Codex')).body;
  assert.equal((await r.answer(codex_run.id, codex, 'Codex', { to: ['Gemini'] })).status, 201);
  assert.equal((await requests()).filter(item => item[0] === 'Gemini' && item[2] === 'pending').length, 0);
  // Chain one ran one round; two more reach the limit of 3, and each still hands back for its summary.
  for (let cycle = 0; cycle < 2; cycle++) { await work('Claude', { to: ['Codex', 'Gemini'] }); await work('Codex'); await work('Gemini'); }
  assert.equal((await requests()).filter(item => item[0] === 'Claude' && item[2] === 'pending').length, 1, 'the last round still hands back');
  await work('Claude', { to: ['Codex', 'Gemini'] });
  const held = (await f.request(r.path)).body.free;
  assert.deepEqual(held.halted_chains.map(item => item.reason), ['budget']);
  assert.equal((await requests()).filter(item => item[2] === 'pending').length, 0, 'the dispatch past the limit is held');
  const chain_url = `${r.path}/chains/${held.halted_chains[0].chain_id}`;
  assert.equal((await f.request(chain_url, { action: 'continue', rounds: 1 }, r.claude)).status, 403);
  const continued = await f.request(chain_url, { action: 'continue', rounds: 1 }, r.owner);
  assert.equal(continued.status, 200, JSON.stringify(continued.body));
  assert.deepEqual((await requests()).filter(item => item[2] === 'pending').map(item => item[0]).sort(), ['Codex', 'Gemini'], 'continuing sends the held dispatch');
  assert.equal((await f.request(chain_url, { action: 'continue', rounds: 1 }, r.owner)).status, 409);
  await work('Codex'); await work('Gemini'); await work('Claude');
  const failing = await r.say('全失败', { to: ['Claude'] });
  assert.equal(failing.status, 201);
  await work('Claude', { to: ['Gemini'] });
  const gemini_run = (await r.reserve('Gemini')).body;
  await f.request(`${r.path}/executions/${gemini_run.id}`, { action: 'fail', reason: '退出' }, r.owner);
  assert.deepEqual((await f.request(r.path)).body.free.halted_chains.map(item => item.reason), ['all_failed']);
  const roles = Object.fromEntries((await f.request(`${r.path}/members/${await r.member_id('Codex')}`, { action: 'role', role: 'host' }, r.owner)).body.members
    .map(member => [member.name, member.role]));
  assert.deepEqual(roles, { Claude: 'member', Codex: 'host', Gemini: 'member' });
  assert.equal((await f.request(r.path)).body.host, 'Codex');
  assert.equal((await f.request(`${r.path}/members/${await r.member_id('Codex')}`, { action: 'role', role: 'member' }, r.owner)).status, 400);
  await f.request(`${r.path}/members/${await r.member_id('Codex')}`, { action: 'away' }, r.owner);
  assert.equal((await f.request(r.path)).body.host, 'Claude');
});

test('Worker hands a single dispatch back only when asked and follows the owner round limit, like Python', async t => {
  const f = await worker_fixture(t);
  const codex = 'codex-hops'.repeat(4), gemini = 'gemini-hops'.repeat(4);
  const r = await free_worker_room(f, [{ name: 'Codex', token: codex }, { name: 'Gemini', token: gemini }]);
  const tokens = { Claude: r.claude, Codex: codex, Gemini: gemini };
  await f.request(`${r.path}/members/${await r.member_id('Claude')}`, { action: 'role', role: 'host' }, r.owner);
  const requests = async () => (await f.request(r.path)).body.free.requests.map(item => [item.member, item.purpose, item.status]);
  const work = async (name, extra = {}) => assert.equal((await r.answer((await r.reserve(name)).body.id, tokens[name], name, extra)).status, 201);
  const url = `${r.path}/budget`;
  assert.equal((await f.request(r.path)).body.free.max_rounds, 3);
  assert.equal((await f.request(url, { max_rounds: 2 }, r.claude)).status, 403);
  for (const bad of [0, 21, '3', 2.5]) assert.equal((await f.request(url, { max_rounds: bad }, r.owner)).status, 400);
  await r.say('单人派活');
  await work('Claude', { to: ['Codex'] });
  await work('Codex');
  assert.equal((await requests()).filter(item => item[1] === 'handoff').length, 0, 'one member answers the user directly');
  const member_run = (await r.reserve('Codex')).status;
  assert.equal(member_run, 409);
  await r.say('做完交回我', { to: ['Claude'] });
  const host_run = (await r.reserve('Claude')).body;
  assert.equal((await r.answer(host_run.id, r.claude, 'Claude', { handoff: true })).status, 400, 'handoff needs to');
  assert.equal((await r.answer(host_run.id, r.claude, 'Claude', { to: ['Codex'], handoff: true })).status, 201);
  await work('Codex');
  assert.deepEqual((await requests()).filter(item => item[1] === 'handoff'), [['Claude', 'handoff', 'pending']]);
  assert.deepEqual((await f.request(url, { max_rounds: 1 }, r.owner)).body, { max_rounds: 1 });
  // This chain ran its one round; the host's next dispatch is held whatever the number of members.
  await work('Claude', { to: ['Codex', 'Gemini'] });
  const free = (await f.request(r.path)).body.free;
  assert.deepEqual([free.max_rounds, free.halted_chains.map(item => item.reason), free.chain_rounds[0].used, free.chain_rounds[0].allowed], [1, ['budget'], 1, 1]);
});

test('Worker smart scheduling asks everyone without a hand-off, or no one, like Python', async t => {
  const f = await worker_fixture(t);
  const codex = 'codex-wide'.repeat(4), gemini = 'gemini-wide'.repeat(4);
  const r = await free_worker_room(f, [{ name: 'Codex', token: codex }, { name: 'Gemini', token: gemini }]);
  const tokens = { Claude: r.claude, Codex: codex, Gemini: gemini };
  await f.request(`${r.path}/members/${await r.member_id('Claude')}`, { action: 'role', role: 'host' }, r.owner);
  const requests = async () => (await f.request(r.path)).body.free.requests.map(item => [item.member, item.purpose, item.status]);
  const route = async (text, action) => {
    const message_id = (await r.say(text)).body.message.id;
    return f.request(`${r.path}/recommendations/${message_id}`, { action }, r.owner);
  };
  assert.equal((await route('都出来打个招呼', 'all')).status, 200);
  assert.deepEqual(await requests(), [['Claude', 'all', 'pending'], ['Codex', 'all', 'pending'], ['Gemini', 'all', 'pending']]);
  const host = (await r.reserve('Claude')).body;
  assert.equal((await r.answer(host.id, r.claude, 'Claude', { to: ['Codex'] })).status, 400);
  assert.equal((await r.answer(host.id, r.claude, 'Claude')).status, 201);
  for (const name of ['Codex', 'Gemini']) assert.equal((await r.answer((await r.reserve(name)).body.id, tokens[name], name)).status, 201);
  assert.ok(!(await requests()).some(item => item[1] === 'handoff'));
  assert.equal((await route('好的，谢谢', 'none')).status, 200);
  assert.deepEqual((await requests()).at(-1), ['Claude', 'route', 'cancelled']);
  const started = (await r.say('已经开始处理')).body.message.id;
  await r.reserve('Claude');
  assert.equal((await f.request(`${r.path}/recommendations/${started}`, { action: 'all' }, r.owner)).status, 409);
});

test('Worker free rooms forward online answers and create discussions in place', async t => {
  const f = await worker_fixture(t);
  const r = await free_worker_room(f);
  const online = 'deepseek-free'.repeat(3);
  assert.equal((await f.request(`${r.path}/members`, { name: 'DeepSeek', token: online, access: 'online' }, r.owner)).status, 200);
  assert.equal((await f.request(`${r.path}/members`, { name: 'Codex', token: 'codex-relay'.repeat(3) }, r.owner)).status, 200);
  assert.equal((await f.request(r.path)).body.experts.DeepSeek, 'online');
  assert.equal((await f.request(`${r.path}/members/${await r.member_id('DeepSeek')}`, { action: 'role', role: 'host' }, r.owner)).status, 400);
  await r.say('请 DeepSeek 看看', { to: ['DeepSeek'] });
  const ask_message = (await f.request(`${r.path}/messages?after=0`)).body.messages.at(-1).id;
  const ask_request = (await f.request(r.path)).body.free.requests.find(item => item.member === 'DeepSeek' && item.message_id === ask_message);
  assert.ok(ask_request);
  assert.equal((await r.answer(null, online, 'DeepSeek')).status, 403);
  assert.equal((await r.say('请 DeepSeek 和 Codex 一起回答', { to: ['DeepSeek', 'Codex'], order: 'auto' })).status, 201);
  const all_message = (await f.request(`${r.path}/messages?after=0`)).body.messages.at(-1).id;
  const group_plan = (await f.request(`${r.path}/recommendations/${all_message}`, undefined, r.owner)).body;
  const recommend = await f.request(`${r.path}/recommendations/${all_message}`, { action: 'all', revision: group_plan.revision }, r.owner);
  assert.equal(recommend.status, 200, JSON.stringify(recommend.body));
  const all_request = (await f.request(r.path)).body.free.requests.find(item => item.member === 'DeepSeek' && item.message_id === all_message);
  assert.equal(all_request.purpose, 'all');
  const request_ids = [ask_request.id, all_request.id];
  const forward = { author: 'DeepSeek', text: '在线回答原文', submission_id: 'forward-0001', request_ids,
    summary: '结论与关键依据', summary_by: 'DeepSeek' };
  assert.equal((await f.request(`${r.path}/messages`, { ...forward, author: 'Qwen' }, r.owner)).status, 403);
  const saved = await f.request(`${r.path}/messages`, forward, r.owner);
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  assert.deepEqual([saved.body.message.author, saved.body.message.submitted_by, saved.body.message.source], ['DeepSeek', '用户', 'proxy']);
  assert.deepEqual([saved.body.message.summary, saved.body.message.summary_by], ['结论与关键依据', 'DeepSeek']);
  const completed = (await f.request(r.path)).body.free.requests.filter(item => request_ids.includes(item.id));
  assert.deepEqual(completed.map(item => [item.status, item.answer_id]), request_ids.map(() => ['completed', saved.body.message.id]));
  const initial = (await f.request(`${r.path}/discussion`)).body;
  const started = await f.request(`${r.path}/discussion`, { action: 'start', revision: initial.revision, goal: '方案讨论' }, r.owner);
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal((await f.request(r.path)).body.id, r.room.id, 'discussion runs in the same collaboration room');
  assert.equal((await f.request('', { title: '来源子房间', parent_room_id: r.room.id })).status, 400);
});

test('Worker owner relay keeps a discussion request separate from direct asks', async t => {
  const f = await worker_fixture(t);
  const r = await free_worker_room(f);
  const web_token = 'web-member-d3'.repeat(3);
  assert.equal((await f.request(`${r.path}/members`, { name: 'Qwen', token: web_token, access: 'online' }, r.owner)).status, 200);
  const initial = (await f.request(`${r.path}/discussion`)).body;
  assert.equal((await f.request(`${r.path}/discussion`, { action: 'start', revision: initial.revision, goal: '请求隔离' }, r.owner)).status, 200);
  const roster = (await f.request(`${r.path}/turns/roster`)).body;
  const plan = await f.request(`${r.path}/turns`, { actor: 'Claude', submission_id: 'web-d3-plan-0001', roster: roster.revision,
    expert: 'Qwen', question: '单独回答讨论安排' }, r.claude);
  assert.equal(plan.status, 201, JSON.stringify(plan.body));
  const ask = await r.say('请 Qwen 另外回答一个问题', { to: ['Qwen'] });
  assert.equal(ask.status, 201, JSON.stringify(ask.body));

  const free = (await f.request(r.path)).body.free;
  const discuss_request = free.requests.find(item => item.member === 'Qwen' && item.purpose === 'discuss');
  const ask_request = free.requests.find(item => item.member === 'Qwen' && item.purpose === 'ask');
  assert.ok(ask_request, JSON.stringify(free.requests));
  assert.equal(ask_request.purpose, 'ask');
  const before = (await f.request(`${r.path}/messages?after=0`)).body.messages.length;
  const mixed = await f.request(`${r.path}/messages`, { author: 'Qwen', text: '不得合并', submitted_by: '用户',
    request_ids: [discuss_request.id, ask_request.id], submission_id: 'web-d3-mixed-0001' }, r.owner);
  assert.equal(mixed.status, 400, JSON.stringify(mixed.body));
  const unchanged = (await f.request(r.path)).body.free.requests.filter(item => [discuss_request.id, ask_request.id].includes(item.id));
  assert.deepEqual(unchanged.map(item => [item.id, item.status]), [[discuss_request.id, 'pending'], [ask_request.id, 'pending']]);
  assert.equal((await f.request(`${r.path}/messages?after=0`)).body.messages.length, before);

  const saved = await f.request(`${r.path}/messages`, { author: 'Qwen', text: '讨论安排回答', submitted_by: '用户',
    request_ids: [discuss_request.id], summary: '只关联讨论安排', summary_by: '用户', submission_id: 'web-d3-discuss-0001' }, r.owner);
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  assert.deepEqual([saved.body.message.author, saved.body.message.submitted_by, saved.body.message.summary, saved.body.message.summary_by],
    ['Qwen', '用户', '只关联讨论安排', '用户']);
  const after = (await f.request(r.path)).body.free.requests.filter(item => [discuss_request.id, ask_request.id].includes(item.id));
  assert.deepEqual(after.map(item => [item.id, item.status, item.answer_id]),
    [[discuss_request.id, 'completed', saved.body.message.id], [ask_request.id, 'pending', null]]);
  assert.equal(f.sql.prepare('SELECT status FROM session_requests WHERE id=?').get(plan.body.turn.id).status, 'answered');
});

test('Worker host credentials can proxy a web answer without completing the host execution', async t => {
  const f = await worker_fixture(t);
  const r = await free_worker_room(f);
  const web_token = 'web-member'.repeat(4);
  assert.equal((await f.request(`${r.path}/members`, { name: 'Qwen', token: web_token, access: 'online' }, r.owner)).status, 200);
  const discussion = `${r.path}/discussion`;
  const initial = (await f.request(discussion)).body;
  const started = await f.request(discussion, { action: 'start', revision: initial.revision, goal: '网页专家参会' }, r.owner);
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const roster = (await f.request(`${r.path}/turns/roster`)).body;
  assert.ok(roster.waiting.includes('Qwen'), 'online members join the roster without local registration');
  const plan = await f.request(`${r.path}/turns`, { actor: 'Claude', submission_id: 'web-discuss-plan-01', roster: roster.revision,
    expert: 'Qwen', question: '请网页专家回答' }, r.claude);
  assert.equal(plan.status, 201, JSON.stringify(plan.body));
  await r.say('请主持人和 Qwen 分别处理', { to: ['Claude', 'Qwen'] });
  const host_execution = (await r.reserve('Claude')).body;
  const qwen_request = (await f.request(`${r.path}/inbox`, undefined, r.owner)).body.observers
    .find(member => member.name === 'Qwen').pending.find(item => item.purpose === 'discuss');
  await r.say('请 Qwen 另外回答', { to: ['Qwen'] });
  const qwen_ask = (await f.request(r.path)).body.free.requests.find(item => item.member === 'Qwen' && item.purpose === 'ask');
  assert.ok(qwen_ask);
  const before_mixed = (await f.request(`${r.path}/messages?after=0`)).body.messages.length;
  const mixed = await f.request(`${r.path}/messages`, { author: 'web', submitted_by: 'Claude', text: '不得合并讨论与提问',
    request_ids: [qwen_request.id, qwen_ask.id], summary: '错误摘要', summary_by: 'web', submission_id: 'host-web-proxy-mixed' }, r.claude);
  assert.equal(mixed.status, 400, JSON.stringify(mixed.body));
  assert.deepEqual(f.sql.prepare('SELECT status FROM member_requests WHERE id IN (?,?) ORDER BY id').all(qwen_request.id, qwen_ask.id)
    .map(row => row.status), ['pending', 'pending']);
  assert.equal((await f.request(`${r.path}/messages?after=0`)).body.messages.length, before_mixed);
  const proxy = await f.request(`${r.path}/messages`, { author: 'web', submitted_by: 'Claude', text: '网页专家的回答',
    request_ids: [qwen_request.id], summary: '已完成网页分析', summary_by: 'web', submission_id: 'host-web-proxy-1' }, r.claude);
  assert.equal(proxy.status, 201, JSON.stringify(proxy.body));
  assert.deepEqual([proxy.body.message.source, proxy.body.message.submitted_by, proxy.body.message.author], ['host_proxy', 'Claude', 'web']);
  assert.equal(f.sql.prepare('SELECT status FROM member_executions WHERE id=?').get(host_execution.id).status, 'dispatched');
  assert.equal(f.sql.prepare('SELECT status FROM session_requests WHERE id=?').get(plan.body.turn.id).status, 'answered');

  const next_roster = (await f.request(`${r.path}/turns/roster`)).body;
  const next_plan = await f.request(`${r.path}/turns`, { actor: 'Claude', submission_id: 'web-discuss-plan-02', roster: next_roster.revision,
    expert: 'Qwen', question: '暂停后不可代发' }, r.claude);
  assert.equal(next_plan.status, 201, JSON.stringify(next_plan.body));
  const stale_request = (await f.request(`${r.path}/inbox`, undefined, r.owner)).body.observers
    .find(member => member.name === 'Qwen').pending.find(item => item.purpose === 'discuss');
  f.sql.prepare("UPDATE discussion_sessions SET status='paused' WHERE id=?").run(started.body.session.id);
  const before_stale = (await f.request(`${r.path}/messages?after=0`)).body.messages.length;
  const stale_owner_proxy = await f.request(`${r.path}/messages`, { author: 'Qwen', text: '暂停后不可代发', submitted_by: '用户',
    request_ids: [stale_request.id], submission_id: 'web-discuss-stale-owner' }, r.owner);
  assert.equal(stale_owner_proxy.status, 409, JSON.stringify(stale_owner_proxy.body));
  const stale_host_proxy = await f.request(`${r.path}/messages`, { author: 'web', submitted_by: 'Claude', text: '暂停后不可代发',
    request_ids: [stale_request.id], submission_id: 'web-discuss-stale-host' }, r.claude);
  assert.equal(stale_host_proxy.status, 409, JSON.stringify(stale_host_proxy.body));
  assert.equal((await f.request(`${r.path}/messages?after=0`)).body.messages.length, before_stale);
  assert.equal(f.sql.prepare('SELECT status FROM member_requests WHERE id=?').get(stale_request.id).status, 'pending');
  assert.equal(f.sql.prepare('SELECT status FROM session_requests WHERE id=?').get(next_plan.body.turn.id).status, 'open');
});

test('Worker free-room answers reject retired kinds, require host execution for moderation, and reject turn links', async t => {
  const f = await worker_fixture(t);
  const r = await free_worker_room(f);
  await r.say('请回答');
  const execution = (await r.reserve()).body;
  for (const payload of [{ kind: 'opinion' }, { kind: 'receipt' }, { turn_id: 1 }]) {
    assert.equal((await r.answer(execution.id, r.claude, 'Claude', payload)).status, 400, JSON.stringify(payload));
  }
  assert.equal((await r.answer(execution.id, r.claude, 'Claude', { kind: 'moderation' })).status, 409,
    'moderation is supported only for a live host discuss_host execution');
});

test('Worker members may fail only their own live execution; other lifecycle writes remain owner-only', async t => {
  const f = await worker_fixture(t), codex = 'member-fail-codex-token'.repeat(2);
  const r = await free_worker_room(f, [{ name: 'Codex', adapter: 'codex_cli', token: codex }]);
  await r.say('请 Codex 处理', { to: ['Codex'] });
  const execution = (await r.reserve('Codex')).body;
  const path = `${r.path}/executions/${execution.id}`;
  assert.equal((await f.request(path, { action: 'renew' }, codex)).status, 403, 'renewal remains owner-only');
  assert.equal((await f.request(path, { action: 'fail', reason: '越权' }, r.claude)).status, 403, 'another member cannot fail it');
  assert.equal((await f.request(path, { action: 'fail', reason: '凭据无效' }, crypto.randomUUID())).status, 403);
  assert.equal((await f.request(path, { action: 'fail', reason: '本次失败' }, codex)).status, 200);
  assert.equal((await f.request(path, { action: 'fail', reason: '重复失败' }, codex)).status, 409, 'terminal executions cannot be failed again');
});

test('Worker host moderation keeps its execution live and cannot be used by experts or stale executions', async t => {
  const f = await worker_fixture(t);
  const codex = 'host-moderation-codex-token'.repeat(2);
  const r = await free_worker_room(f, [{ name: 'Codex', adapter: 'codex_cli', token: codex }]);
  const discussion = `${r.path}/discussion`;
  const initial = (await f.request(discussion)).body;
  const started = await f.request(discussion, { action: 'start', revision: initial.revision, goal: '主持说明兼容' }, r.owner);
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const execution = (await r.reserve('Claude')).body;
  const payload = { author: 'Claude', kind: 'moderation', text: '开场说明', execution_id: execution.id,
    source: 'api', submission_id: 'host-moderation-worker-01' };
  const saved = await f.request(`${r.path}/messages`, payload, r.claude);
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  assert.equal(saved.body.message.kind, 'moderation');
  assert.equal((await f.request(`${r.path}/messages`, payload, r.claude)).body.duplicate, true);
  assert.equal((await f.request(`${r.path}/messages`, { ...payload, summary: '禁止摘要' }, r.claude)).status, 400);
  assert.equal(f.sql.prepare('SELECT status FROM member_executions WHERE id=?').get(execution.id).status, 'dispatched');
  assert.equal(f.sql.prepare("SELECT COUNT(*) AS count FROM session_requests WHERE session_id=? AND purpose='discuss'").get(started.body.session.id).count, 0);
  assert.equal(f.sql.prepare("SELECT COUNT(*) AS count FROM member_requests WHERE execution_id=? AND purpose='discuss_host'").get(execution.id).count, 1);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS count FROM member_requests WHERE message_id=?').get(saved.body.message.id).count, 0);
  const state = await f.request(`${r.path}/state`, { actor: 'Claude', text: '已整理', until: saved.body.message.id }, r.claude);
  assert.equal(state.status, 200, JSON.stringify(state.body));
  const roster = (await f.request(`${r.path}/turns/roster`)).body;
  const plan = await f.request(`${r.path}/turns`, { actor: 'Claude', submission_id: 'host-moderation-plan', roster: roster.revision,
    expert: 'Codex', question: '继续讨论' }, r.claude);
  assert.equal(plan.status, 201, JSON.stringify(plan.body));
  assert.equal((await r.answer(execution.id, codex, 'Codex', { kind: 'moderation', text: '冒充主持人', execution_id: execution.id,
    submission_id: 'host-moderation-worker-02' })).status, 403);
  f.sql.prepare('UPDATE member_executions SET lease_until=0 WHERE id=?').run(execution.id);
  const late = await f.request(`${r.path}/messages`, { ...payload, text: '迟到说明', submission_id: 'host-moderation-worker-03' }, r.claude);
  assert.equal(late.status, 409, JSON.stringify(late.body));
});

test('Worker room view exposes visible anchors and provenance for session execution cards', async t => {
  const f = await worker_fixture(t);
  const codex = 'session-card-codex-token'.repeat(2);
  const r = await free_worker_room(f, [{ name: 'Codex', adapter: 'codex_cli', token: codex }]);
  const visible = (await r.say('讨论前的问题')).body.message;
  const discussion = `${r.path}/discussion`;
  const initial = (await f.request(discussion)).body;
  const started = await f.request(discussion, { action: 'start', revision: initial.revision, goal: '执行卡来源' }, r.owner);
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const roster = (await f.request(`${r.path}/turns/roster`)).body;
  const plan = await f.request(`${r.path}/turns`, { actor: 'Claude', submission_id: 'session-card-plan-01', roster: roster.revision,
    expert: 'Codex', question: '请核对原问题' }, r.claude);
  assert.equal(plan.status, 201, JSON.stringify(plan.body));
  const execution = (await r.reserve('Codex')).body;
  const view = (await f.request(r.path, undefined, r.owner)).body;
  const request = view.free.requests.find(item => item.execution_id === execution.id);
  assert.ok(request);
  assert.deepEqual([request.session_request_id, request.discussion_session_id, request.purpose, request.round],
    [plan.body.turn.id, started.body.session.id, 'discuss', 1]);
  assert.equal(request.source_question, '请核对原问题');
  assert.equal(request.after_message_id, visible.id);
  assert.ok(request.message_id > request.after_message_id, 'the internal task message is not used as the transcript anchor');
  const report = view.free.executions.find(item => item.id === execution.id);
  assert.equal(report.member, 'Codex');
  assert.equal(report.requests[0].source_question, '请核对原问题');
  assert.equal(report.requests[0].after_message_id, visible.id);
  f.sql.prepare("UPDATE room_members SET status='removed' WHERE name='Codex' AND room_id=?").run(r.room.id);
  const removed_report = (await f.request(r.path, undefined, r.owner)).body.free.executions.find(item => item.id === execution.id);
  assert.equal(removed_report.member, 'Codex', 'execution cards retain the original member name after removal');
});

test('Worker deletes session requests before their member and room foreign keys', async t => {
  const f = await worker_fixture(t);
  const r = await free_worker_room(f);
  const initial = (await f.request(`${r.path}/discussion`)).body;
  const started = await f.request(`${r.path}/discussion`, { action: 'start', revision: initial.revision, goal: '删除关联' }, r.owner);
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const roster = (await f.request(`${r.path}/turns/roster`)).body;
  const plan = await f.request(`${r.path}/turns`, { actor: 'Claude', submission_id: 'delete-session-plan', roster: roster.revision,
    expert: 'Claude', question: '删除前安排' }, r.claude);
  assert.equal(plan.status, 201, JSON.stringify(plan.body));
  const deleted = await f.request(`${r.path}/delete`, { actor: '用户', confirm_title: r.room.title }, r.owner);
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS count FROM discussion_sessions WHERE room_id=?').get(r.room.id).count, 0);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS count FROM session_requests').get().count, 0);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS count FROM task_message_sources').get().count, 0);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS count FROM room_members WHERE room_id=?').get(r.room.id).count, 0);
});

test('Worker accepts named instances of one platform and rejects invalid names', async t => {
  const f = await worker_fixture(t);
  const room = await f.request('', { title: '双 Claude', goal: 'x', host: 'Claude-主持', experts: { 'Claude-主持': 'cli', Claude: 'cli' } });
  assert.equal(room.status, 201, JSON.stringify(room.body));
  assert.equal(room.body.host, 'Claude-主持');
  assert.equal((await f.request('', { title: '无效', goal: 'x', experts: { Claudex: 'cli' } })).status, 400);
  const r = await free_worker_room(f);
  assert.equal((await f.request(`${r.path}/members`, { name: 'Claude-评审', token: 'reviewer-free'.repeat(4) }, r.owner)).status, 200);
  assert.equal((await f.request(`${r.path}/members`, { name: 'Claude-', token: 'bad-free'.repeat(5) }, r.owner)).status, 400);
  await r.say('请评审', { to: ['Claude-评审'] });
  assert.deepEqual((await f.request(r.path)).body.free.requests.map(item => item.member), ['Claude-评审']);
});

test('Worker member suggestions require owner confirmation and concurrent retries create one request', async t => {
  const f = await worker_fixture(t), codex = 'suggestion-codex'.repeat(3);
  const r = await free_worker_room(f, [{ name: 'Codex', token: codex }]);
  // Codex hosts so that Claude's mentions stay suggestions.
  await f.request(`${r.path}/members/${await r.member_id('Codex')}`, { action: 'role', role: 'host' }, r.owner);
  const original = (await r.say('先看', { to: ['Claude'] })).body.message;
  const execution = (await r.reserve()).body;
  const saved = await r.answer(execution.id, r.claude, 'Claude', { text: '请 @Codex 检查', to: ['Codex', 'Codex'] });
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  const source = saved.body.message;
  assert.deepEqual(source.suggestions.map(item => item.member), ['Codex']);
  assert.equal((await f.request(r.path)).body.free.requests.length, 1);
  const payload = { message_id: source.id, member_id: await r.member_id('Codex') };
  for (const token of ['', 'wrong-token', r.claude, codex]) {
    assert.equal((await f.request(`${r.path}/suggestions`, payload, token)).status, 403);
  }
  const [first, retry] = await Promise.all([1, 2].map(() => f.request(`${r.path}/suggestions`, payload, r.owner)));
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(first.body.request.id, retry.body.request.id);
  const request = first.body.request;
  assert.equal(request.message_id, source.id);
  assert.equal(request.created_by, 'user');
  assert.ok(![source.id, original.id].includes(request.chain_id));
  assert.deepEqual(f.sql.prepare('SELECT author,reply_to FROM messages WHERE id=?').get(request.chain_id),
    Object.assign(Object.create(null), { author: '用户', reply_to: source.id }));
  assert.equal(f.sql.prepare("SELECT COUNT(*) AS count FROM messages WHERE reply_to=? AND author='用户'").get(source.id).count, 1);
  const delivered = (await r.reserve('Codex')).body;
  assert.deepEqual(delivered.requests.map(item => item.message_id), [source.id]);
  assert.equal((await r.answer(delivered.id, codex, 'Codex')).status, 201);
  assert.equal((await f.request(`${r.path}/suggestions`, payload, r.owner)).body.request.status, 'completed');
  assert.equal((await f.request(`${r.path}/messages/${source.id}`)).body.suggestions[0].request_id, request.id);
  assert.equal((await f.request(r.path)).body.free.requests.length, 2);
});

test('Worker suggestion parsing excludes code quotes partial names and self mentions', async t => {
  const f = await worker_fixture(t);
  const r = await free_worker_room(f, [{ name: 'Codex', token: 'suggestion-target'.repeat(3) }]);
  // Codex hosts so that Claude's mentions stay suggestions.
  await f.request(`${r.path}/members/${await r.member_id('Codex')}`, { action: 'role', role: 'host' }, r.owner);
  for (const text of ['`@Codex`', '`` @Codex ` nested ``', '```txt\n@Codex\n```', '~~~\n@Codex\n~~~',
    '    @Codex', '  > quote\n@Codex', '> @Codex', '@Codex-评审', '@Claude', '```\n@Codex']) {
    await r.say('查看', { to: ['Claude'] });
    const execution = (await r.reserve()).body;
    const saved = await r.answer(execution.id, r.claude, 'Claude', { text });
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
    assert.deepEqual(saved.body.message.suggestions, [], text);
  }
  await r.say('查看', { to: ['Claude'] });
  const saved = await r.answer((await r.reserve()).body.id, r.claude, 'Claude', { text: '> @Claude\n\n请 @Codex 看看。 @Codex 再核对。' });
  assert.deepEqual(saved.body.message.suggestions.map(item => item.member), ['Codex']);
});

test('Worker conversion rechecks membership archive and owner inside the transaction', async t => {
  const f = await worker_fixture(t);
  const r = await free_worker_room(f, [{ name: 'Codex', token: 'suggestion-target'.repeat(3) }]);
  // Codex hosts so that Claude's mentions stay suggestions.
  await f.request(`${r.path}/members/${await r.member_id('Codex')}`, { action: 'role', role: 'host' }, r.owner);
  await r.say('查看', { to: ['Claude'] });
  const source = (await r.answer((await r.reserve()).body.id, r.claude, 'Claude', { to: ['Codex'] })).body.message;
  const payload = { message_id: source.id, member_id: await r.member_id('Codex') };
  assert.equal((await f.request(`${r.path}/suggestions`, { ...payload, message_id: 99999 }, r.owner)).status, 404);
  assert.equal((await f.request(`${r.path}/suggestions`, { ...payload, member_id: true }, r.owner)).status, 400);
  for (const mutation of [
    () => f.sql.prepare("UPDATE room_members SET status='away' WHERE id=?").run(payload.member_id),
    () => f.sql.prepare('UPDATE room_directory SET archived=1 WHERE room_id=?').run(r.room.id),
    () => f.sql.prepare("UPDATE room_modes SET control_hash='revoked' WHERE room_id=?").run(r.room.id),
  ]) {
    const owner_hash = f.sql.prepare('SELECT control_hash FROM room_modes WHERE room_id=?').get(r.room.id).control_hash;
    f.before_batch = mutation;
    assert.equal((await f.request(`${r.path}/suggestions`, payload, r.owner)).status, 403);
    assert.equal(f.sql.prepare('SELECT COUNT(*) AS count FROM member_requests WHERE message_id=?').get(source.id).count, 0);
    assert.equal(f.sql.prepare('SELECT COUNT(*) AS count FROM messages WHERE reply_to=?').get(source.id).count, 0);
    f.sql.prepare("UPDATE room_members SET status='active' WHERE id=?").run(payload.member_id);
    f.sql.prepare('UPDATE room_directory SET archived=0 WHERE room_id=?').run(r.room.id);
    f.sql.prepare('UPDATE room_modes SET control_hash=? WHERE room_id=?').run(owner_hash, r.room.id);
  }
  await f.request(`${r.path}/members/${payload.member_id}`, { action: 'away' }, r.owner);
  assert.equal((await f.request(`${r.path}/suggestions`, payload, r.owner)).status, 409);
});

/** Call /api/admin* or any path with an optional admin session header. */
async function admin_call(f, path, payload, session) {
  const response = await worker.fetch(new Request(`https://discussion.test${path}`, {
    method: payload === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(session ? { 'X-Discussion-Admin': session } : {}) },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  }), f.env);
  return { status: response.status, body: await response.json() };
}

async function admin_fixture(t) {
  const f = await worker_fixture(t);
  f.env.ADMIN_SETUP_KEY = 'setup-key-for-tests';
  const account = { username: '房主', password: 'correct-horse', setup_key: 'setup-key-for-tests' };
  f.register = () => admin_call(f, '/api/admin/register', account);
  f.login = password => admin_call(f, '/api/admin/login', { username: '房主', password });
  return f;
}

test('Worker admin registration needs the setup key and only succeeds once', async t => {
  const f = await admin_fixture(t);
  assert.deepEqual((await admin_call(f, '/api/admin')).body, { registered: false, setup_available: true, logged_in: false, profile: null });
  const wrong = await admin_call(f, '/api/admin/register', { username: '房主', password: 'correct-horse', setup_key: 'nope' });
  assert.equal(wrong.status, 403);
  const short = await admin_call(f, '/api/admin/register', { username: '房主', password: 'short', setup_key: 'setup-key-for-tests' });
  assert.equal(short.status, 400);
  const unconfigured = await worker_fixture(t);
  assert.equal((await admin_call(unconfigured, '/api/admin/register', { username: 'a', password: 'correct-horse', setup_key: 'x' })).status, 503);
  const created = await f.register();
  assert.equal(created.status, 201);
  assert.match(created.body.token, /^[0-9a-f]{64}$/);
  assert.equal((await f.register()).status, 409);
  const state = (await admin_call(f, '/api/admin', undefined, created.body.token)).body;
  assert.deepEqual(state, { registered: true, setup_available: false, logged_in: true, profile: { username: '房主', avatar: '' } });
  assert.match(f.sql.prepare('SELECT password_hash FROM site_admin').get().password_hash, /^pbkdf2_sha256\$100000\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
});

test('Worker registers the administrator with the one-time CLI token', async t => {
  const f = await worker_fixture(t);
  const token = 'ab'.repeat(32), hashed = createHash('sha256').update(token).digest('hex');
  assert.equal((await admin_call(f, '/api/admin')).body.setup_available, false);
  f.sql.prepare('INSERT INTO admin_setup (id,token_hash,created_at) VALUES (1,?,0)').run(hashed);
  assert.equal((await admin_call(f, '/api/admin')).body.setup_available, true);
  const account = { username: 'Admin', password: 'Admin123456.' };
  assert.equal((await admin_call(f, '/api/admin/register', { ...account, setup_key: 'cd'.repeat(32) })).status, 403);
  assert.equal((await admin_call(f, '/api/admin/register', { ...account, setup_key: ` ${token} ` })).status, 201);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS count FROM admin_setup').get().count, 0);
  assert.equal((await admin_call(f, '/api/admin/login', account)).status, 200);
});

test('Worker admin login locks for a fixed time after five failures and clears on success', async t => {
  const f = await admin_fixture(t);
  await f.register();
  assert.equal((await f.login('wrong-password')).status, 401);
  assert.equal((await admin_call(f, '/api/admin/login', { username: '陌生人', password: 'correct-horse' })).status, 401);
  for (let attempt = 0; attempt < 3; attempt++) await f.login('wrong-password');
  const row = f.sql.prepare('SELECT failed_attempts, locked_until FROM site_admin').get();
  assert.equal(row.failed_attempts, 0);
  assert.ok(Math.abs(row.locked_until - (Math.floor(Date.now() / 1000) + 300)) <= 5);
  assert.equal((await f.login('correct-horse')).status, 429);
  f.sql.prepare('UPDATE site_admin SET locked_until=0').run();
  await f.login('wrong-password');
  const ok = await f.login('correct-horse');
  assert.equal(ok.status, 200);
  assert.equal(f.sql.prepare('SELECT failed_attempts FROM site_admin').get().failed_attempts, 0);
  assert.equal((await admin_call(f, '/api/admin', undefined, ok.body.token)).body.logged_in, true);
});

test('Worker admin sessions persist until logout', async t => {
  const f = await admin_fixture(t);
  const a = (await f.register()).body.token, b = (await f.login('correct-horse')).body.token;
  f.sql.exec('UPDATE admin_sessions SET created_at=1');
  assert.equal((await admin_call(f, '/api/admin', undefined, a)).body.logged_in, true);
  assert.equal((await admin_call(f, '/api/admin/logout', {}, a)).status, 200);
  assert.equal((await admin_call(f, '/api/admin', undefined, a)).body.logged_in, false);
  assert.equal((await admin_call(f, '/api/admin', undefined, b)).body.logged_in, true);
  assert.equal((await admin_call(f, '/api/admin/logout', {})).status, 200);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM admin_sessions').get().n, 1);
});

test('Worker admin profile changes need a session', async t => {
  const f = await admin_fixture(t);
  const current = (await f.register()).body.token;
  assert.equal((await admin_call(f, '/api/admin/profile', { username: '新名' })).status, 401);
  const avatar = 'data:image/png;base64,AAAA';
  assert.deepEqual((await admin_call(f, '/api/admin/profile', { avatar }, current)).body, { profile: { username: '房主', avatar } });
  assert.deepEqual((await admin_call(f, '/api/admin/profile', { username: ' 新名 ' }, current)).body, { profile: { username: '新名', avatar } });
  assert.equal((await admin_call(f, '/api/admin/profile', { avatar: 'http://x/y.png' }, current)).status, 400);
});

test('Worker admin session bypasses room credentials for archive restore delete', async t => {
  const f = await admin_fixture(t);
  const session = (await f.register()).body.token;
  const room = (await f.request('', { title: '管理员清理', host: 'Codex', phase: 'initial', experts: { Codex: 'cli' } })).body;
  const path = `/${room.id}`, stranger = 'stranger-credential'.repeat(3);
  for (const action of ['archive', 'restore']) {
    assert.equal((await f.request(`${path}/${action}`, { actor: '用户' }, stranger)).status, 403);
    assert.equal((await admin_call(f, `/api/rooms${path}/${action}`, { actor: '用户' }, session)).status, 200);
  }
  assert.equal((await f.request(`${path}/delete`, { actor: '用户', confirm_title: '管理员清理' }, stranger)).status, 403);
  const wrong = await admin_call(f, `/api/rooms${path}/delete`, { actor: '用户', confirm_title: '错误名称' }, session);
  assert.equal(wrong.status, 400);
  assert.equal((await admin_call(f, `/api/rooms${path}/delete`, { actor: '用户', confirm_title: '管理员清理' }, session)).status, 200);
});

test('Worker admin session writes as the room owner without its credential', async t => {
  const f = await admin_fixture(t);
  const session = (await f.register()).body.token;
  const room = (await f.request('', { title: '平板发言', host: 'Codex', phase: 'initial', experts: { Codex: 'cli' } })).body;
  const path = `/api/rooms/${room.id}/messages`, message = () => ({ author: '用户', text: '平板上的发言', submission_id: crypto.randomUUID() });
  assert.equal((await admin_call(f, path, message())).status, 403);
  assert.equal((await admin_call(f, path, message(), '0'.repeat(64))).status, 403);
  assert.equal((await admin_call(f, path, message(), session)).status, 201);
  // A supplied credential is never replaced, so a member cannot borrow the session to speak as the owner.
  const response = await worker.fetch(new Request(`https://discussion.test${path}`, { method: 'POST', body: JSON.stringify(message()),
    headers: { 'Content-Type': 'application/json', 'X-Discussion-Admin': session, 'X-Discussion-Token': 'stranger-credential'.repeat(3) } }), f.env);
  assert.equal(response.status, 403);
});

test('Worker relays a remote launch only to the paired computer', async t => {
  const f = await admin_fixture(t);
  const machine_id = crypto.randomUUID().replaceAll('-', ''), machine_token = 'ab'.repeat(32);
  const machine_call = async (path, payload, token = machine_token) => {
    const response = await worker.fetch(new Request(`https://discussion.test${path}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Machine-Token': token }, body: JSON.stringify(payload) }), f.env);
    return { status: response.status, body: await response.json() };
  };
  const pairing = { id: machine_id, name: '工作站', token: machine_token };
  assert.equal((await admin_call(f, '/api/machines')).status, 401);
  assert.equal((await admin_call(f, '/api/machines', pairing)).status, 401);
  const session = (await f.register()).body.token;
  assert.equal((await admin_call(f, '/api/machines', pairing, session)).status, 200);
  const sync = `/api/machines/${machine_id}/sync`, state = { projects: [{ id: 'abcdef12', name: '演示' }], clients: { Claude: 'claude' } };
  assert.equal((await machine_call(sync, state, '0'.repeat(64))).status, 401);
  assert.deepEqual((await machine_call(sync, state)).body, { launches: [] });
  const [machine] = (await admin_call(f, '/api/machines', undefined, session)).body.machines;
  assert.deepEqual([machine.projects, machine.clients, machine.online, machine.token_hash], [state.projects, state.clients, true, undefined]);

  const request = { site: 'https://example.test', entry: 'web', token: 'room-credential', local_project: 'abcdef12',
    room: { title: '远程建房', mode: 'free', members: [], submission_id: 'launch-1' } };
  const submit = (body, id = 'launch-1') => admin_call(f, '/api/remote-launches', { id, machine_id, request: body }, session);
  assert.equal((await admin_call(f, '/api/remote-launches', { id: 'launch-1', machine_id, request })).status, 401);
  assert.equal((await submit({ ...request, cwd: 'D:\project' })).status, 400);
  assert.equal((await submit({ ...request, local_project: 'deadbeef' })).status, 409);
  assert.equal((await submit(request)).body.status, 'pending');
  assert.deepEqual((await machine_call(sync, state)).body.launches, [{ id: 'launch-1', request }]);
  const action = `/api/machines/${machine_id}/launches/launch-1`;
  assert.equal((await machine_call(action, { action: 'claim' })).body.status, 'claimed');
  assert.equal((await submit(request)).body.status, 'claimed');
  const done = (await machine_call(action, { action: 'finish', room_id: 'room-1', status: 'free' })).body;
  assert.deepEqual([done.status, done.result], ['done', { room_id: 'room-1', status: 'free' }]);
  assert.equal((await machine_call(action, { action: 'fail', error: 'late' })).status, 409);
  assert.equal((await admin_call(f, '/api/remote-launches/launch-1', undefined, session)).body.status, 'done');
  assert.equal(f.sql.prepare("SELECT request FROM remote_launches WHERE id='launch-1'").get().request, '{}');

  const failing = { ...request, room: { ...request.room, submission_id: 'launch-2' } };
  await submit(failing, 'launch-2');
  const failure = (await machine_call(`/api/machines/${machine_id}/launches/launch-2`, { action: 'fail', error: 'Claude 未配置', stage: 'not_started' })).body;
  assert.deepEqual([failure.status, failure.error, failure.result], ['failed', 'Claude 未配置', { stage: 'not_started' }]);
  const retried = (await submit(failing, 'launch-2')).body;
  assert.deepEqual([retried.status, retried.error], ['pending', '']);
});

test('a page without the local service runs operations on the paired computer end to end', async t => {
  const { machine_link, relay_commands, sync_remote_launches } = await import('../runner/remote_launch.mjs');
  const f = await admin_fixture(t);
  const session = (await f.register()).body.token;
  const home = await mkdtemp(join(tmpdir(), 'codiscuss-relay-page-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  // The computer reaches the same Worker the page uses.
  globalThis.fetch = (url, options) => worker.fetch(new Request(url, options), f.env);
  await admin_call(f, '/api/machines', machine_link(home, 'https://discussion.test'), session);
  await sync_remote_launches(home);
  const [machine] = (await admin_call(f, '/api/machines', undefined, session)).body.machines;

  // The page's own relay code, with request_json going to the Worker under the administrator session.
  const source = await readFile(join(PROJECT_ROOT, 'web', 'app.js'), 'utf8');
  const constants = source.slice(source.indexOf('const RELAY_COMMAND_POLL_MS'), source.indexOf('let local_connection'));
  const start = source.indexOf('function bytes_to_base64(');
  const end = source.indexOf("\n/** Read this browser's submitted requests");
  assert.ok(start >= 0 && end > start, 'relay functions are present');
  const request_json = async (path, payload) => {
    const { status, body } = await admin_call(f, path, payload, session);
    if (status >= 400) throw new Error(body.error);
    return body;
  };
  const relay_command = vm.runInNewContext([`const MODEL_CATALOG_TIMEOUT_MS = 35000;`, constants, source.slice(start, end), 'relay_command'].join('\n'),
    { crypto, TextEncoder, TextDecoder, btoa, atob, setTimeout, Uint8Array, JSON, Date, Object, Error, Promise, request_json, relay_machine: machine });

  const ran = [];
  const run = async request => {
    ran.push(request);
    return request.command === 'api-key' ? { status: 400, body: { error: 'Base URL 无效' } } : { status: 200, body: { member: 'Gemini' } };
  };
  const page = relay_command('room-member', { room_id: 'room-1', action: 'add', name: 'Gemini', access_file: 'C:/elsewhere' });
  await Promise.all(await relay_commands(home, { wait: 5, run }));
  assert.deepEqual(await page, { member: 'Gemini' });
  assert.deepEqual(ran[0].input, { room_id: 'room-1', action: 'add', name: 'Gemini', site: 'https://discussion.test', entry: 'web' });

  const secret = 'sk-never-on-the-site';
  const failing = relay_command('api-key', { base_url: 'nope', api_key: secret });
  const stored = [];
  for (let tries = 0; !stored.length && tries < 50; tries++) {
    await new Promise(resolve => setTimeout(resolve, 20));
    stored.push(...f.sql.prepare('SELECT request FROM machine_commands').all().map(row => row.request));
  }
  assert.ok(stored.length && !stored.some(text => text.includes(secret)), 'the site holds only ciphertext');
  await Promise.all(await relay_commands(home, { wait: 5, run }));
  await assert.rejects(failing, /Base URL 无效/);
  assert.equal(ran[1].input.api_key, secret);
  await assert.rejects(relay_command('pick-directory', {}), /完整路径/);
});

test('Worker relays encrypted commands only between the administrator and the paired computer', async t => {
  const f = await admin_fixture(t);
  const machine_id = crypto.randomUUID().replaceAll('-', ''), machine_token = 'cd'.repeat(32);
  const machine_call = async (path, payload, token = machine_token) => {
    const response = await worker.fetch(new Request(`https://discussion.test${path}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Machine-Token': token }, body: JSON.stringify(payload) }), f.env);
    return { status: response.status, body: await response.json() };
  };
  const session = (await f.register()).body.token;
  await admin_call(f, '/api/machines', { id: machine_id, name: '工作站', token: machine_token }, session);
  const commands = `/api/machines/${machine_id}/commands`;
  const key = { kty: 'EC', crv: 'P-256', x: 'A'.repeat(43), y: 'B'.repeat(43) };
  const envelope = { key, iv: 'C'.repeat(16), data: 'ZGF0YQ==' }, command = { id: 'command-0000000001', envelope };
  assert.equal((await admin_call(f, commands, command)).status, 401);
  assert.equal((await admin_call(f, commands, command, session)).status, 409, 'a computer without a published key cannot take commands');
  const state = { projects: [], clients: {} };
  assert.equal((await machine_call(`/api/machines/${machine_id}/sync`, { ...state, public_key: { ...key, x: 'short' } })).status, 400);
  await machine_call(`/api/machines/${machine_id}/sync`, { ...state, public_key: key });
  assert.deepEqual((await admin_call(f, '/api/machines', undefined, session)).body.machines[0].public_key, key);
  assert.equal((await admin_call(f, commands, { ...command, envelope: { ...envelope, data: 'not base64!' } }, session)).status, 400);
  assert.deepEqual((await admin_call(f, commands, command, session)).body, { id: 'command-0000000001', status: 'pending' });
  assert.equal((await admin_call(f, commands, command, session)).status, 409);

  const claim = `${commands}/claim`;
  assert.equal((await machine_call(claim, { wait: 0 }, '0'.repeat(64))).status, 401);
  assert.deepEqual((await machine_call(claim, { wait: 0 })).body, { commands: [{ id: 'command-0000000001', envelope }] });
  assert.equal(f.sql.prepare('SELECT request FROM machine_commands').get().request, '{}');
  assert.deepEqual((await machine_call(claim, { wait: 0 })).body, { commands: [] });
  assert.equal((await admin_call(f, `${commands}/command-0000000001`, undefined, session)).body.status, 'claimed');
  const answer = { envelope: { iv: 'D'.repeat(16), data: 'YW5zd2Vy' } };
  assert.equal((await machine_call(`${commands}/command-0000000001`, answer)).body.status, 'done');
  assert.equal((await machine_call(`${commands}/command-0000000001`, answer)).status, 409);
  assert.deepEqual((await admin_call(f, `${commands}/command-0000000001`, undefined, session)).body, { id: 'command-0000000001', status: 'done', response: answer.envelope });
  assert.equal((await admin_call(f, `${commands}/command-0000000001`, undefined, session)).status, 404, 'a response is handed over once');

  await admin_call(f, commands, { ...command, id: 'command-0000000002' }, session);
  f.sql.prepare('UPDATE machine_commands SET created_at=0').run();
  assert.deepEqual((await machine_call(claim, { wait: 0 })).body, { commands: [] }, 'an expired command is never run');
});

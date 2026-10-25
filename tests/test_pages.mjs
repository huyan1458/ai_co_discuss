/** Verify release isolation, static routing, and the direct D1 deployment contract. */
import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { build_pages } from "../scripts/build_pages.mjs";
import worker from "../backend/worker.mjs";
import updates_worker, { DiscussionUpdates } from "../backend/updates.mjs";

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

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

test('Worker manual members have scoped credentials and revocation is checked in the write transaction', async t => {
  const f = await worker_fixture(t);
  const room = (await f.request('', { title: '手动凭证', host: 'Codex', phase: 'initial', experts: { Codex: 'cli', Claude: 'cli' } })).body;
  const path = `/${room.id}`, host = f.member_tokens.Codex, member = f.member_tokens.Claude;
  const own = { author: 'Codex', source: 'cli', kind: 'moderation', text: '主持观点', submission_id: 'manual-host' };
  for (const token of ['', crypto.randomUUID(), member, 'owner-credential'.repeat(3)]) {
    assert.equal((await f.request(`${path}/messages`, own, token)).status, 403);
  }
  assert.equal((await f.request(`${path}/messages`, own, host)).status, 201);
  assert.equal((await f.request(`${path}/state`, { actor: 'Claude', text: '非主持' }, member)).status, 403);
  assert.equal((await f.request(`${path}/topic`, { actor: 'Codex', experts: { Codex: 'cli' } }, host)).status, 403);
  assert.equal((await f.request(`${path}/runtime`, { revision: 0, mode: 'automatic' }, host)).status, 403);
  f.before_batch = () => f.sql.prepare("UPDATE room_members SET status='removed' WHERE room_id=? AND name='Codex'").run(room.id);
  assert.equal((await f.request(`${path}/state`, { actor: 'Codex', text: '撤销后禁止写入' }, host)).status, 403);
  assert.equal((await f.request(path)).body.state_text, '');
  const public_data = JSON.stringify([(await f.request(path)).body, (await f.request(`${path}/backup`)).body]);
  for (const token of [host, member, 'owner-credential'.repeat(3)]) assert.ok(!public_data.includes(token));
  assert.doesNotMatch(public_data, /token_hash|control_hash/);
});

test('Worker proxies only active online members and rechecks that identity atomically', async t => {
  const f = await worker_fixture(t);
  const room = (await f.request('', { title: '在线代发', host: 'Codex', phase: 'initial', experts: { Codex: 'cli', Qwen: 'online' } })).body;
  const path = `/${room.id}`;
  const turn = (await f.request(`${path}/turns`, { actor: '用户', expert: 'Qwen', question: '问题', submission_id: 'proxy-turn' })).body.turn;
  const floor = (await f.request(`${path}/floor`)).body;
  assert.equal((await f.request(`${path}/floor`, { actor: '用户', speaker: 'Qwen', action: 'take', revision: floor.revision })).status, 200);
  const answer = { author: 'Qwen', submitted_by: 'Qwen', source: 'cli', text: '在线原文', turn_id: turn.id, submission_id: 'proxy-answer' };
  assert.equal((await f.request(`${path}/messages`, answer, f.member_tokens.Qwen)).status, 403);
  answer.submitted_by = '用户'; answer.source = 'proxy';
  f.before_batch = () => f.sql.prepare("UPDATE room_members SET status='removed' WHERE room_id=? AND name='Qwen'").run(room.id);
  assert.equal((await f.request(`${path}/messages`, answer)).status, 403);
  assert.equal((await f.request(path)).body.message_count, 0);
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

test('Pages publishes runtime changes but not ordinary lease renewal', async t => {
  const f = await timed_message_fixture(t, 'host'), { notifications } = bind_updates(f);
  assert.equal((await f.request(`${f.path}/events/${f.event}`, { action: 'renew' })).status, 200);
  assert.equal(notifications.length, 0);
  assert.equal((await f.request(`${f.path}/messages`, f.payload, f.token)).status, 201);
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
  const room = (await f.request('', { title: '导入', host: 'Codex', phase: 'initial', experts: { Codex: 'cli', Qwen: 'online' } })).body;
  const path = `/${room.id}`;
  const first = (await f.request(`${path}/messages`, { author: '用户', text: '原始问题', submission_id: 'import-first' })).body.message;
  const data = new TextEncoder().encode('%PDF-1.7\nimported');
  const params = new URLSearchParams({ actor: '用户', file_name: '资料.pdf', submission_id: 'import-file' });
  const file = (await (await f.raw(`${path}/attachments?${params}`, { method: 'POST', body: data })).json()).attachment;
  await f.request(`${path}/messages`, { author: '用户', text: `补充 #${first.id}`, reply_to: first.id, attachment_ids: [file.id], submission_id: 'import-second' });
  const turn = (await f.request(`${path}/turns`, { actor: '用户', expert: 'Qwen', question: `请回应 #${first.id}`, submission_id: 'import-turn' })).body.turn;
  const floor = (await f.request(`${path}/floor`)).body;
  await f.request(`${path}/floor`, { actor: '用户', speaker: 'Qwen', action: 'take', revision: floor.revision });
  const answer = await f.request(`${path}/messages`, { author: 'Qwen', submitted_by: '用户', source: 'proxy', text: `回应 #${first.id}`, turn_id: turn.id, submission_id: 'import-answer' });
  assert.equal(answer.status, 201, JSON.stringify(answer.body));
  const backup = JSON.parse(JSON.stringify((await f.request(`${path}/backup`)).body).replaceAll(room.id, 'importedroom'));
  await f.request(`${path}/messages`, { author: '用户', text: '占用新编号', submission_id: 'import-later' });
  const imported = await f.request('/import', backup);
  assert.equal(imported.status, 201, JSON.stringify(imported.body));
  assert.deepEqual(Object.keys(imported.body.attachments), [file.id]);
  assert.equal((await f.request('/import', backup)).body.skipped, true);
  const copy = (await f.request('/importedroom')).body;
  assert.deepEqual([copy.host, copy.phase], ['Codex', 'paused']);
  const [new_first, second, new_answer] = (await f.request('/importedroom/messages')).body.messages.sort((a, b) => a.id - b.id);
  assert.ok(new_first.id > answer.body.message.id + 1);
  assert.deepEqual([second.text, second.reply_to], [`补充 #${new_first.id}`, new_first.id]);
  assert.deepEqual([new_answer.text, new_answer.turn_id], [`回应 #${new_first.id}`, copy.current_turn.id]);
  assert.deepEqual([copy.current_turn.answer_id, copy.current_turn.question], [new_answer.id, `请回应 #${new_first.id}`]);
  const attachment = `/importedroom/attachments/${imported.body.attachments[file.id]}`;
  assert.equal((await f.raw(`${attachment}/content`)).status, 404);
  assert.equal((await f.raw(`${attachment}/import`, { method: 'POST', body: new TextEncoder().encode('changed') })).status, 400);
  assert.equal((await f.raw(`${attachment}/import`, { method: 'POST', body: data, headers: { 'X-Discussion-Token': crypto.randomUUID() } })).status, 403);
  assert.equal((await f.raw(`${attachment}/import`, { method: 'POST', body: data })).status, 200);
  assert.deepEqual(new Uint8Array(await (await f.raw(`${attachment}/content`)).arrayBuffer()), data);
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

test('Worker upload failure or revoked execution leaves no R2 object or attachment metadata', async t => {
  const f = await timed_message_fixture(t, 'expert');
  const params = new URLSearchParams({ actor: 'Codex', file_name: 'result.txt', submission_id: 'revoked-upload' });
  f.before_batch = () => f.sql.prepare("UPDATE discussion_runtime SET status='paused',generation=generation+1 WHERE room_id=?").run(f.path.slice(1));
  const response = await f.raw(`${f.path}/attachments?${params}`, { method: 'POST', body: 'result', headers: { 'X-Discussion-Token': f.token } });
  assert.equal(response.status, 403);
  assert.equal(f.objects.size, 0);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS count FROM attachments').get().count, 0);
  const broken = { ...f.bucket, put: async () => { throw new Error('storage unavailable'); } };
  params.set('actor', '用户');
  assert.equal((await f.raw(`${f.path}/attachments?${params}`, { method: 'POST', body: 'result' }, broken)).status, 500);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS count FROM attachments').get().count, 0);
});

/** Enter a real isolated execution and backdate its stages to distinguish queue from wake time. */
async function timed_message_fixture(test_case, role) {
  const f = await worker_fixture(test_case);
  const created = await f.request('', { title: '消息耗时', host: 'Codex', phase: 'initial', experts: { Codex: 'cli' } });
  f.path = `/${created.body.id}`;
  let turn_id;
  if (role === 'expert') {
    const turn = await f.request(`${f.path}/turns`, { actor: '用户', expert: 'Codex', question: '计时回答', submission_id: 'timed-turn' });
    turn_id = turn.body.turn.id;
  }
  await f.request(`${f.path}/runtime`, { action: 'start', revision: 0, deadline: Math.floor(Date.now() / 1000) + 600 });
  f.event = (await f.request(`${f.path}/events`)).body.events.at(-1).id;
  f.token = 'timed-execution-token'.repeat(3);
  assert.equal((await f.request(`${f.path}/events/${f.event}`, { action: 'reserve', execution_token: f.token })).status, 200);
  assert.equal((await f.request(`${f.path}/events/${f.event}`, { action: 'enter', session_id: 'timed-session' }, f.token)).status, 200);
  f.dispatched = Math.floor(Date.now() / 1000) - 125;
  f.sql.prepare("UPDATE discussion_events SET created_at=strftime('%Y-%m-%dT%H:%M:%SZ',?,'unixepoch'),started_at=? WHERE id=?")
    .run(f.dispatched - 200, f.dispatched + 25, f.event);
  f.sql.prepare('UPDATE event_timings SET dispatched_at=? WHERE event_id=?').run(f.dispatched, f.event);
  if (role === 'expert') {
    const floor = (await f.request(`${f.path}/floor`)).body;
    assert.equal((await f.request(`${f.path}/floor`, { actor: 'Codex', action: 'take', revision: floor.revision }, f.token)).status, 200);
  }
  f.payload = { author: 'Codex', source: 'cli', text: '定时保存的正文', submission_id: 'timed-message',
    kind: role === 'host' ? 'moderation' : 'opinion', ...(turn_id ? { turn_id } : {}), elapsed_seconds: 999999 };
  return f;
}

for (const role of ['host', 'expert']) test(`Worker freezes ${role} message time from dispatch through publication`, async t => {
  const f = await timed_message_fixture(t, role);
  const saved = await f.request(`${f.path}/messages`, f.payload, f.token);
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  const message = saved.body.message;
  assert.equal(message.elapsed_seconds, Math.floor(Date.parse(message.created_at) / 1000) - f.dispatched);
  assert.ok(message.elapsed_seconds >= 125 && message.elapsed_seconds < 150, 'wake is included, queue and supplied duration are not');
  f.sql.prepare('UPDATE event_timings SET dispatched_at=dispatched_at-500 WHERE event_id=?').run(f.event);
  const retry = await f.request(`${f.path}/messages`, f.payload, f.token);
  assert.equal(retry.status, role === 'host' ? 200 : 403, JSON.stringify(retry.body));
  if (role === 'host') assert.deepEqual(retry.body.message, message);
  assert.deepEqual((await f.request(`${f.path}/messages/${message.id}`)).body, message);
  assert.deepEqual((await f.request(`${f.path}/messages`)).body.messages[0], message);
  assert.deepEqual((await f.request(`${f.path}/backup`)).body.tables.message_timings,
    [{ message_id: message.id, elapsed_seconds: message.elapsed_seconds }]);
  f.sql.exec(await readFile(join(PROJECT_ROOT, 'backend', 'schema.sql'), 'utf8'));
  assert.equal((await f.request(`${f.path}/messages/${message.id}`)).body.elapsed_seconds, message.elapsed_seconds);
  assert.equal((await f.request(`${f.path}/delete`, { actor: '用户', confirm_title: '消息耗时' })).status, 200);
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
  assert.equal((await f.request(`${f.path}/messages`, { ...f.payload, source: 'api', submission_id: 'expired-api' }, f.token)).status, 403);
});

test('Worker leaves user timings unknown and refuses to proxy a local execution', async t => {
  const f = await timed_message_fixture(t, 'expert');
  const user = await f.request(`${f.path}/messages`, { author: '用户', text: '留言', submission_id: 'untimed-user', elapsed_seconds: 999999 });
  assert.equal(user.status, 201, JSON.stringify(user.body));
  assert.equal(user.body.message.elapsed_seconds, null);
  const proxy = await f.request(`${f.path}/messages`, { ...f.payload, source: 'proxy', submitted_by: '用户' });
  assert.equal(proxy.status, 403, JSON.stringify(proxy.body));
  f.sql.exec(await readFile(join(PROJECT_ROOT, 'backend', 'schema.sql'), 'utf8'));
  assert.equal((await f.request(`${f.path}/messages/${user.body.message.id}`)).body.elapsed_seconds, null);
});

test('schema backfills only exact historical expert results and preserves frozen durations', async t => {
  for (const role of ['host', 'expert']) {
    const f = await timed_message_fixture(t, role);
    const message = (await f.request(`${f.path}/messages`, f.payload, f.token)).body.message;
    f.sql.prepare('DELETE FROM message_timings WHERE message_id=?').run(message.id);
    const schema = await readFile(join(PROJECT_ROOT, 'backend', 'schema.sql'), 'utf8');
    f.sql.exec(schema);
    f.sql.exec(schema);
    assert.equal((await f.request(`${f.path}/messages/${message.id}`)).body.elapsed_seconds,
      role === 'expert' ? message.elapsed_seconds : null);
  }
});

test('Worker preserves independent user requests, checks replays, exports and deletes them', async t => {
  const f = await worker_fixture(t);
  const original = '  用户要求🙂\n保留换行  \n';
  const payload = { title: '原文与背景', user_request: original, background: '项目背景', submission_id: 'request-create' };
  const created = await f.request('', payload);
  assert.equal(created.status, 201);
  const id = created.body.id;
  assert.equal(created.body.user_request, original);
  assert.equal((await f.request('', payload)).body.duplicate, true);
  assert.equal((await f.request('', { ...payload, user_request: '另一要求' })).status, 409);
  const updated = await f.request(`/${id}/topic`, { actor: '用户', background: '更新背景' });
  assert.equal(updated.body.user_request, original);
  assert.equal(updated.body.background, '更新背景');
  const backup = await f.request(`/${id}/backup`);
  assert.deepEqual(backup.body.tables.room_user_requests, [{ room_id: id, text: original }]);
  assert.equal((await f.request(`/${id}/topic`, { actor: '用户', user_request: '🙂'.repeat(4000) })).status, 200);
  assert.equal((await f.request(`/${id}/topic`, { actor: '用户', user_request: '🙂'.repeat(4001) })).status, 400);
  const cleared = await f.request(`/${id}/topic`, { actor: '用户', user_request: '' });
  assert.equal(cleared.body.user_request, '');
  assert.equal(cleared.body.background, '更新背景');
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
  const saved = await f.request(`/${id}/topic`, { actor: '用户', goal: '更新目标' });
  assert.equal(saved.body.user_request, room.user_request);
  assert.equal(f.sql.prepare('SELECT text FROM room_user_requests WHERE room_id=?').get(id).text, room.user_request);
  f.sql.prepare('DELETE FROM room_user_requests WHERE room_id=?').run(id);
  const plain = '用户原文：\n没有明确背景分隔的整段文字';
  f.sql.prepare('UPDATE topic_settings SET background=? WHERE room_id=?').run(plain, id);
  const unchanged = (await f.request(`/${id}`)).body;
  assert.equal(unchanged.user_request, '');
  assert.equal(unchanged.background, plain);
});

test('Worker accepts SQLite-formatted expert JSON after migration, including reached limits', async t => {
  const f = await worker_fixture(t);
  const created = await f.request('', { title: '迁移兼容', host: 'Codex', experts: { Codex: 'cli' }, limits: { max_rounds: 1 } });
  assert.equal(created.status, 201);
  const id = created.body.id;
  f.sql.prepare('UPDATE topic_settings SET experts=? WHERE room_id=?').run('{"Codex": "cli"}', id);
  const turn = await f.request(`/${id}/turns`, { actor: '用户', expert: 'Codex', question: '迁移后继续', submission_id: 'migration-turn' });
  assert.equal(turn.status, 201, JSON.stringify(turn.body));
  const floor = await f.request(`/${id}/floor`);
  assert.equal((await f.request(`/${id}/floor`, { actor: 'Codex', action: 'take', revision: floor.body.revision })).status, 200);
  const answer = await f.request(`/${id}/messages`, { author: 'Codex', kind: 'opinion', source: 'cli', text: '迁移后的回答', turn_id: turn.body.turn.id, submission_id: 'migration-answer' });
  assert.equal(answer.status, 201, JSON.stringify(answer.body));
  const checked = await f.request(`/${id}/limits`, { actor: '用户' });
  assert.equal(checked.status, 200, JSON.stringify(checked.body));
  assert.equal(checked.body.phase, 'paused');
});

test('Worker excludes paused time from elapsed time and the total-duration deadline', async t => {
  const f = await worker_fixture(t);
  const created = await f.request('', { title: '暂停不计时', host: 'Codex', experts: { Codex: 'cli' }, limits: { max_minutes: 60 } });
  const id = created.body.id;
  const started = await f.request(`/${id}/runtime`, { action: 'start', revision: 0 });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const before = (await f.request(`/${id}`)).body.limits;
  await f.request(`/${id}/runtime`, { action: 'pause', revision: started.body.revision });
  f.sql.prepare('UPDATE discussion_pauses SET paused_at=paused_at-600 WHERE room_id=?').run(id);
  const paused = (await f.request(`/${id}`)).body.limits;
  assert.ok(paused.elapsed_seconds < 60);
  assert.ok(paused.deadline >= before.deadline + 600);
  assert.equal(paused.reached, false);
});

test('Worker defaults to unlimited execution while enforcing leases and explicit run deadlines', async t => {
  const f = await worker_fixture(t);
  const room = (await f.request('', { title: '单次不限', host: 'Codex', experts: { Codex: 'cli' } })).body;
  assert.equal(room.limits.execution_minutes, 0);
  assert.equal((await f.request(`/${room.id}/topic`, { actor: '用户', limits: { execution_minutes: 0 } })).status, 200);
  for (const minutes of [-1, 61]) {
    assert.equal((await f.request(`/${room.id}/topic`, { actor: '用户', limits: { execution_minutes: minutes } })).status, 400);
  }
  const deadline = Math.floor(Date.now() / 1000) + 60;
  assert.equal((await f.request(`/${room.id}/runtime`, { action: 'start', revision: 0, deadline })).status, 200);
  const event = (await f.request(`/${room.id}/events`)).body.events.at(-1);
  const path = `/${room.id}/events/${event.id}`, token = 'unlimited-work-token'.repeat(3);
  assert.equal((await f.request(path, { action: 'reserve', execution_token: token })).status, 200);
  const entered = await f.request(path, { action: 'enter', session_id: 'long-session' }, token);
  assert.equal(entered.status, 200);
  assert.equal(entered.body.lease_until, deadline);
  f.sql.prepare('UPDATE discussion_events SET started_at=started_at-7200 WHERE id=?').run(event.id);
  const renewed = await f.request(path, { action: 'renew' });
  assert.equal(renewed.status, 200);
  assert.equal(renewed.body.lease_until, deadline);
  assert.equal((await f.request(`/${room.id}/state`, { actor: 'Codex', text: '长任务仍有效' }, token)).status, 200);
  f.sql.prepare('UPDATE discussion_events SET lease_until=0 WHERE id=?').run(event.id);
  assert.equal((await f.request(`/${room.id}/state`, { actor: 'Codex', text: '过期' }, token)).status, 403);
  assert.equal((await f.request(path, { action: 'renew' })).status, 409);
});

test('Worker unlimited runs keep bounded execution leases, authorization and pause/resume', async t => {
  const f = await worker_fixture(t);
  const id = (await f.request('', { title: '不限时长', host: 'Codex', experts: { Codex: 'cli' }, limits: { execution_minutes: 1 } })).body.id;
  const started = await f.request(`/${id}/runtime`, { action: 'start', revision: 0 });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal(started.body.deadline, 0);
  assert.equal(started.body.expired, false);
  assert.equal((await f.request(`/${id}`)).body.limits.remaining_seconds, null);
  const event = (await f.request(`/${id}/events`)).body.events.at(-1);
  const token = 'unlimited-execution-token'.repeat(3);
  assert.equal((await f.request(`/${id}/events/${event.id}`, { action: 'reserve', execution_token: token })).status, 200);
  assert.equal((await f.request(`/${id}/events/${event.id}`, { action: 'enter', session_id: 'test' }, token)).status, 200);
  const renewed = await f.request(`/${id}/events/${event.id}`, { action: 'renew' });
  assert.equal(renewed.status, 200);
  assert.ok(renewed.body.lease_until > Date.now() / 1000);
  assert.ok(renewed.body.lease_until <= Math.floor(Date.now() / 1000) + 60);
  assert.equal((await f.request(`/${id}/state`, { actor: 'Codex', text: '有效' }, token)).status, 200);
  f.sql.prepare('UPDATE discussion_events SET started_at=started_at-61 WHERE id=?').run(event.id);
  assert.equal((await f.request(`/${id}/state`, { actor: 'Codex', text: '超时' }, token)).status, 403);
  assert.equal((await f.request(`/${id}/events/${event.id}`, { action: 'renew' })).status, 409);
  const paused = (await f.request(`/${id}/runtime`, { action: 'pause', revision: started.body.revision })).body;
  const resumed = await f.request(`/${id}/runtime`, { action: 'start', revision: paused.revision, deadline: 0 });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.deadline, 0);
  assert.equal((await f.request(`/${id}/state`, { actor: 'Codex', text: '旧执行' }, token)).status, 403);
  assert.equal((await f.request(`/${id}/runtime`, { action: 'stop', revision: resumed.body.revision })).body.status, 'stopped');
});

{
  test('Worker unlimited runs pause at the round limit, and the removed summary mode is refused', async t => {
    const f = await worker_fixture(t);
    assert.equal((await f.request('', { title: '旧总结方式', host: 'Codex', experts: { Codex: 'cli' }, limits: { on_limit: 'summarize' } })).status, 400);
    const id = (await f.request('', { title: '轮次到限', host: 'Codex', experts: { Codex: 'cli' },
      limits: { max_rounds: 1 } })).body.id;
    assert.equal((await f.request(`/${id}/runtime`, { action: 'start', revision: 0, deadline: 0 })).status, 200);
    const turn = (await f.request(`/${id}/turns`, { actor: '用户', expert: 'Codex', question: '观点', submission_id: 'unlimited-turn' })).body.turn;
    const execution = (await f.request(`/${id}/events`)).body.events.at(-1);
    const answer_token = crypto.randomUUID();
    assert.equal((await f.request(`/${id}/events/${execution.id}`, { action: 'reserve', execution_token: answer_token })).status, 200);
    assert.equal((await f.request(`/${id}/events/${execution.id}`, { action: 'enter', session_id: 'answer' }, answer_token)).status, 200);
    const floor = (await f.request(`/${id}/floor`)).body;
    assert.equal((await f.request(`/${id}/floor`, { actor: 'Codex', action: 'take', revision: floor.revision }, answer_token)).status, 200);
    assert.equal((await f.request(`/${id}/messages`, { author: 'Codex', kind: 'opinion', source: 'cli',
      text: '原文', submission_id: 'unlimited-answer', turn_id: turn.id }, answer_token)).status, 201);
    const room = (await f.request(`/${id}/limits`, { actor: '用户' })).body;
    assert.equal(room.limits.reason, 'round_limit');
    assert.equal(room.runtime.status, 'paused');
    assert.equal(room.limits.closing, undefined);
  });
}

test('Worker invitations append automatic and manual experts while preserving the live plan and user hold', async t => {
  const f = await worker_fixture(t);
  const id = (await f.request('', { title: '追加本轮', host: 'Codex', phase: 'initial', experts: { Codex: 'cli', Claude: 'cli', Gemini: 'cli' } })).body.id;
  await f.request(`/${id}/runtime`, { action: 'start', revision: 0, deadline: 0 });
  const plan = await f.request(`/${id}/turns`, { actor: '用户', submission_id: 'invite-tail-plan', roster: (await f.request(`/${id}/turns/roster`)).body.revision,
    turns: [{ expert: 'Claude', question: '先答' }, { expert: 'Gemini', question: '再答' }] });
  assert.equal(plan.status, 201, JSON.stringify(plan.body));
  await f.request(`/${id}/messages`, { author: '用户', text: '补充材料', submission_id: 'invite-hold' });
  const before = (await f.request(`/${id}`)).body;
  const qwen_token = crypto.randomUUID();
  for (const [name, access] of [['DeepSeek', 'runner'], ['Qwen', 'manual']]) {
    const payload = { name, access, adapter: access === 'runner' ? 'api' : '', token: name === 'Qwen' ? qwen_token : crypto.randomUUID() };
    const joined = await f.request(`/${id}/members`, payload);
    assert.equal(joined.status, 200, JSON.stringify(joined.body));
    assert.deepEqual((await f.request(`/${id}/members`, payload)).body.queued_turns, joined.body.queued_turns);
  }
  assert.deepEqual((await f.request(`/${id}`)).body.queued_turns.map(turn => turn.expert), ['Gemini', 'DeepSeek'], 'an unregistered manual invitee is not queued');
  assert.equal((await f.request(`/${id}/register`, {}, qwen_token)).status, 200);
  assert.equal((await f.request(`/${id}/register`, {}, qwen_token)).status, 200);
  const after = (await f.request(`/${id}`)).body;
  assert.deepEqual(after.current_turn, before.current_turn);
  assert.deepEqual(after.queued_turns.map(turn => turn.expert), ['Gemini', 'DeepSeek', 'Qwen'], 'registering queues it once');
  assert.deepEqual(after.queued_turns[0], before.queued_turns[0]);
  assert.equal(after.held_since, before.held_since);
  assert.equal(after.runtime.generation, before.runtime.generation);
  assert.match(after.queued_turns[1].question, /独立/);
  await f.request(`/${id}/topic`, { actor: '用户', phase: 'paused' });
  const paused = await f.request(`/${id}/members`, { name: 'Grok', access: 'manual', token: crypto.randomUUID() });
  assert.equal(paused.status, 200, JSON.stringify(paused.body));
  assert.deepEqual(paused.body.queued_turns, after.queued_turns);
  assert.equal(paused.body.runtime.status, 'paused');
});

test('Worker invitation joins at the tail of the plan, like Python', async t => {
  const f = await worker_fixture(t);
  const id = (await f.request('', { title: '补齐本轮', host: 'Codex', phase: 'initial', experts: { Codex: 'cli', Claude: 'cli', Gemini: 'cli' } })).body.id;
  await f.request(`/${id}/runtime`, { action: 'start', revision: 0, deadline: 0 });
  const names = ['Claude', 'Gemini', 'Claude', 'Gemini'];
  const plan = await f.request(`/${id}/turns`, { actor: '用户', submission_id: 'invite-slot-plan', roster: (await f.request(`/${id}/turns/roster`)).body.revision, turns: names.map((expert, index) => ({ expert, question: `第 ${index} 句` })) });
  assert.equal(plan.status, 201, JSON.stringify(plan.body));
  const joined = await f.request(`/${id}/members`, { name: 'DeepSeek', access: 'runner', adapter: 'api', token: crypto.randomUUID() });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  assert.deepEqual(joined.body.queued_turns.map(turn => [turn.expert, turn.question]),
    [['Gemini', '第 1 句'], ['Claude', '第 2 句'], ['Gemini', '第 3 句'], ['DeepSeek', '欢迎加入：请先读取议题，独立给出你的开场观点。']]);
});

test('Worker running discussions admit and release experts without pausing, like Python', async t => {
  const f = await worker_fixture(t);
  const id = (await f.request('', { title: '成员进出', host: 'Codex', experts: { Codex: 'cli', Claude: 'cli' } })).body.id;
  assert.equal((await f.request(`/${id}/runtime`, { action: 'start', revision: 0, deadline: 0 })).status, 200);
  const turn = (await f.request(`/${id}/turns`, { actor: '用户', expert: 'Claude', question: '观点', submission_id: 'member-turn' })).body.turn;
  const members = Object.fromEntries((await f.request(`/${id}`)).body.members.map(member => [member.name, member]));
  assert.equal((await f.request(`/${id}/members/${members.Codex.id}`, { action: 'away' })).status, 400);
  const speaking = await f.request(`/${id}/members/${members.Claude.id}`, { action: 'away' });
  assert.deepEqual([speaking.status, speaking.body.error.includes('正在发言')], [400, true]);
  const set_phase = phase => f.sql.prepare('UPDATE topic_settings SET phase=? WHERE room_id=?').run(phase, id);
  f.sql.prepare("UPDATE discussion_turns SET status='cancelled' WHERE id=?").run(turn.id);
  let room = (await f.request(`/${id}/members/${members.Claude.id}`, { action: 'away' })).body;
  assert.deepEqual([room.runtime.status, Object.keys(room.experts), room.current_turn.id, room.current_turn.status], ['running', ['Codex'], turn.id, 'cancelled']);
  const events = (await f.request(`/${id}/events`)).body.events;
  assert.deepEqual([events.at(-1).participant, events.at(-1).role, events.at(-1).status], ['Codex', 'host', 'pending']);
  assert.equal((await f.request(`/${id}/topic`, { actor: '用户', experts: { Codex: 'cli', Claude: 'cli' } })).status, 400);
  const invited = { name: 'DeepSeek', token: crypto.randomUUID(), access: 'runner', adapter: 'api' };
  room = (await f.request(`/${id}/members`, invited)).body;
  assert.deepEqual([room.runtime.status, room.experts.DeepSeek], ['running', 'cli']);
  assert.equal((await f.request(`/${id}/members/${members.Claude.id}`, { action: 'active', token: f.member_tokens.Claude })).status, 400);
  room = (await f.request(`/${id}/members/${members.Claude.id}`, { action: 'active', token: crypto.randomUUID() })).body;
  assert.deepEqual([room.runtime.status, room.experts.Claude], ['running', 'cli']);
  // An opinion is part of the record: no member action deletes it any more.
  set_phase('paused');
  assert.equal((await f.request(`/${id}/members/${members.Claude.id}`, { action: 'redo', latest_id: 1 })).status, 400);
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
  const id = (await f.request('', { title: '手动专家', host: 'Codex', experts: { Codex: 'cli', Claude: 'cli' } })).body.id;
  assert.equal((await f.request(`/${id}/runtime`, { action: 'start', revision: 0, deadline: 0 })).status, 200);
  const manual = { name: 'Qwen', token: f.member_tokens.Qwen = crypto.randomUUID(), access: 'manual', adapter: '' };
  const joined = await f.request(`/${id}/members`, manual);
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  assert.equal(joined.body.members.find(member => member.name === 'Qwen').access, 'manual');
  const refused_turn = await f.request(`/${id}/turns`, { actor: '用户', expert: 'Qwen', question: '观点', submission_id: 'manual-turn-early' });
  assert.equal(refused_turn.status, 400);
  assert.match(refused_turn.body.error, /Qwen/);
  const roster = (await f.request(`/${id}/turns/roster`)).body;
  assert.deepEqual([roster.unregistered, roster.waiting.includes('Qwen')], [['Qwen'], false]);
  assert.equal((await f.request(`/${id}/register`, {}, manual.token)).status, 200);
  const turn = (await f.request(`/${id}/turns`, { actor: '用户', expert: 'Qwen', question: '观点', submission_id: 'manual-turn' })).body.turn;
  const floor = (await f.request(`/${id}/floor`)).body;
  assert.equal((await f.request(`/${id}/floor`, { actor: 'Qwen', action: 'take', revision: floor.revision })).status, 200);
  const answer = await f.request(`/${id}/messages`, { author: 'Qwen', submitted_by: 'Qwen', source: 'cli', kind: 'opinion',
    turn_id: turn.id, text: '实际回答', summary: '摘要', submission_id: 'manual-answer' });
  assert.equal(answer.status, 201, JSON.stringify(answer.body));
  const events = (await f.request(`/${id}/events`)).body.events;
  assert.deepEqual([events.at(-1).participant, events.at(-1).role, events.at(-1).status], ['Codex', 'host', 'pending']);
  assert.equal((await f.request(`/${id}/state`, { actor: 'Codex', text: 'x' })).status, 403, 'a woken host still needs its execution');
  let run = (await f.request(`/${id}/runtime`, { action: 'pause', revision: (await f.request(`/${id}`)).body.runtime.revision })).body;
  run = (await f.request(`/${id}/runtime`, { mode: 'manual', revision: run.revision })).body;
  assert.equal((await f.request(`/${id}/runtime`, { mode: 'automatic', revision: run.revision })).status, 200);
  const access = Object.fromEntries((await f.request(`/${id}`)).body.members.map(member => [member.name, member.access]));
  assert.deepEqual([access.Qwen, access.Claude], ['manual', 'runner']);
  const refused = await f.request('', { title: '手动主持', host: 'Codex', phase: 'initial', runtime_mode: 'automatic', experts: { Codex: 'cli', Claude: 'cli' },
    members: [{ name: 'Codex', token: crypto.randomUUID(), access: 'manual' }, { name: 'Claude', token: crypto.randomUUID(), access: 'runner' }] });
  assert.equal(refused.status, 400);
});

test('Worker keeps the named follow-up option and records smart-scheduling decisions for the transcript', async t => {
  const f = await worker_fixture(t);
  const id = (await f.request('', { title: '点名追问', host: 'Codex', experts: { Codex: 'cli' }, named_followup: true })).body.id;
  assert.equal((await f.request(`/${id}`)).body.named_followup, true);
  const plain = (await f.request('', { title: '默认关闭', host: 'Codex', experts: { Codex: 'cli' } })).body;
  assert.equal(plain.named_followup, false);
  f.sql.prepare('DELETE FROM discussion_options WHERE room_id=?').run(plain.id);
  assert.equal((await f.request(`/${plain.id}`)).body.named_followup, true, 'a room created before the option keeps named follow-ups');
  assert.equal((await f.request('', { title: '无效', host: 'Codex', experts: { Codex: 'cli' }, named_followup: 'yes' })).status, 400);
  await f.request(`/${id}/runtime`, { action: 'start', revision: 0, deadline: 0 });
  const decision = { kind: 'round', label: '继续下一轮，先请 Codex 发言', confidence: 0.9, applied: true, provider: 'jev', after_message_id: 0 };
  assert.equal((await f.request(`/${id}/scheduler-decisions`, decision)).status, 200);
  assert.equal((await f.request(`/${id}/scheduler-decisions`, { ...decision, kind: 'other' })).status, 400);
  assert.equal((await f.request(`/${id}/scheduler-decisions`, { ...decision, confidence: 2 })).status, 400);
  assert.equal((await f.request(`/${id}/scheduler-decisions`, decision, 'x'.repeat(40))).status, 403);
  assert.deepEqual((await f.request(`/${id}`)).body.scheduler_decisions.map(item => [item.kind, item.label, item.applied, item.confidence]),
    [['round', '继续下一轮，先请 Codex 发言', 1, 0.9]]);
});

test('Worker zero deadline cannot bypass finite topic limits and rejects invalid deadlines', async t => {
  const f = await worker_fixture(t);
  const id = (await f.request('', { title: '有限时长', host: 'Codex', experts: { Codex: 'cli' } })).body.id;
  for (const deadline of [-1, true, '0', Math.floor(Date.now() / 1000) - 1, Math.floor(Date.now() / 1000) + 90000]) {
    assert.equal((await f.request(`/${id}/runtime`, { action: 'start', revision: 0, deadline })).status, 400);
  }
  await f.request(`/${id}/topic`, { actor: '用户', limits: { max_minutes: 1 } });
  const run = (await f.request(`/${id}/runtime`, { action: 'start', revision: 0, deadline: 0 })).body;
  assert.ok(run.deadline > Date.now() / 1000);
  assert.ok(run.deadline <= Math.floor(Date.now() / 1000) + 60);
});

test('Worker retains failed attempts and frozen timing after retry, including legacy failures', async t => {
  const f = await timed_message_fixture(t, 'expert');
  const failed = await f.request(`${f.path}/events/${f.event}`, { action: 'fail', reason: '模型未调用房间工具保存结果' });
  assert.equal(failed.status, 200);
  const room = (await f.request(f.path)).body;
  const failure = room.runtime.failures[0];
  assert.deepEqual(Object.keys(failure).sort(), ['id', 'participant', 'role', 'turn_id', 'result', 'created_at', 'elapsed_seconds'].sort());
  assert.equal(failure.result, '模型未调用房间工具保存结果');
  assert.equal(failure.turn_id, f.payload.turn_id);
  assert.ok(failure.elapsed_seconds >= 125 && failure.elapsed_seconds < 130);
  assert.equal(room.message_count, 0);
  const restarted = await f.request(`${f.path}/runtime`, { action: 'start', revision: room.runtime.revision, deadline: 0 });
  assert.equal(restarted.status, 200, JSON.stringify(restarted.body));
  assert.deepEqual(restarted.body.failures, [failure]);
  assert.notEqual(restarted.body.latest_execution.id, failure.id);
  assert.equal((await f.request(f.path)).body.current_turn.id, failure.turn_id);
  f.sql.prepare('DELETE FROM event_timings WHERE event_id=?').run(f.event);
  assert.deepEqual((await f.request(f.path)).body.runtime.failures, [{ ...failure, elapsed_seconds: null }]);
});

test('Worker reports per-participant executions and has no forced summary closing', async t => {
  const f = await worker_fixture(t);
  const created = await f.request('', { title: '提前收尾', host: 'Codex', experts: { Codex: 'cli' }, limits: { max_rounds: 3 } });
  const id = created.body.id;
  await f.request(`/${id}/turns`, { actor: '用户', expert: 'Codex', question: '待打断', submission_id: 'forced-turn' });
  const started = await f.request(`/${id}/runtime`, { action: 'start', revision: 0, deadline: 0 });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.deepEqual(started.body.participants.map(item => [item.participant, item.status, item.failures, item.stale]), [['Codex', 'pending', 0, false]]);
  assert.equal(started.body.participants[0].lease_until, undefined);
  assert.equal(started.body.participants[0].session_id, '');
  // `force` is gone: asking for it changes nothing, and a limit that is not reached leaves the run alone.
  const unchanged = await f.request(`/${id}/limits`, { actor: '用户', force: true });
  assert.equal(unchanged.status, 200, JSON.stringify(unchanged.body));
  assert.deepEqual([unchanged.body.limits.stop_reason, unchanged.body.current_turn.status, unchanged.body.runtime.status], ['', 'pending', 'running']);
});

test('Worker pauses on declared completion, lets the user extend, and reopens a concluded room', async t => {
  const f = await worker_fixture(t);
  const id = (await f.request('', { title: '到限暂停', host: 'Codex', experts: { Codex: 'cli' }, limits: { max_rounds: 2 } })).body.id;
  assert.equal((await f.request(`/${id}/runtime`, { action: 'start', revision: 0, deadline: 0 })).status, 200);
  const event = (await f.request(`/${id}/events`)).body.events.at(-1), token = 'declared-done-token'.repeat(3);
  assert.equal((await f.request(`/${id}/events/${event.id}`, { action: 'reserve', execution_token: token })).status, 200);
  assert.equal((await f.request(`/${id}/events/${event.id}`, { action: 'enter', session_id: 'host' }, token)).status, 200);
  const host_conclude = await f.request(`/${id}/topic`, { actor: 'Codex', phase: 'concluded' }, token);
  assert.equal(host_conclude.status, 400, JSON.stringify(host_conclude.body));
  assert.equal((await f.request(`/${id}/limits`, { actor: 'Codex', action: 'done' }, token)).status, 400, 'done needs the conclusion revision');
  const conclusion = (await f.request(`/${id}/conclusion`)).body.revision;
  const done = await f.request(`/${id}/limits`, { actor: 'Codex', action: 'done', conclusion }, token);
  assert.deepEqual([done.status, done.body.phase, done.body.limits.stop_reason], [200, 'paused', 'goal_done']);
  const extended = await f.request(`/${id}/limits`, { actor: '用户', action: 'extend', rounds: 3 });
  assert.equal(extended.status, 200, JSON.stringify(extended.body));
  const { max_rounds, extra_rounds, round_cap, segment_rounds, stop_reason } = extended.body.limits;
  assert.deepEqual([max_rounds, extra_rounds, round_cap, segment_rounds, stop_reason], [2, 3, 3, 0, '']);
  assert.equal((await f.request(`/${id}/limits`, { actor: '用户', action: 'summarize' })).status, 400);
  assert.equal((await f.request(`/${id}/limits`, { actor: '用户', action: 'reopen', max_rounds: 1 })).status, 400);
  assert.equal((await f.request(`/${id}/topic`, { actor: '用户', phase: 'concluded' })).status, 200);
  const reopened = await f.request(`/${id}/limits`, { actor: '用户', action: 'reopen', max_rounds: 2, max_minutes: 30 });
  assert.equal(reopened.status, 200, JSON.stringify(reopened.body));
  assert.deepEqual([reopened.body.phase, reopened.body.limits.max_rounds, reopened.body.limits.max_minutes, reopened.body.limits.extra_rounds, reopened.body.limits.reached],
    ['paused', 2, 30, 0, false]);
});

test('Worker requires the owner key for user controls in every room mode', async t => {
  const f = await worker_fixture(t);
  const created = await f.request('', { title: '目录保护', host: 'Codex', experts: { Codex: 'cli' } });
  const id = created.body.id;
  const started = await f.request(`/${id}/runtime`, { action: 'start', revision: 0, deadline: Math.floor(Date.now() / 1000) + 600 });
  assert.equal((await f.request(`/${id}/state`, { actor: 'Codex', text: '无执行' }, '')).status, 403);
  for (const token of ['', crypto.randomUUID(), f.member_tokens.Codex]) {
    for (const [tail, payload] of [['/runtime', { action: 'pause', revision: started.body.revision }], ['/archive', { actor: '用户' }],
      ['/delete', { actor: '用户', confirm_title: '目录保护' }]]) assert.equal((await f.request(`/${id}${tail}`, payload, token)).status, 403);
    // Ordering and filing only rearrange the shared directory, like folder edits.
    assert.equal((await f.request(`/${id}/folder`, { actor: '用户', folder_id: null }, token)).status, 200);
    assert.equal((await f.request(`/${id}/move`, { actor: '用户' }, token)).status, 200);
  }
  const paused = await f.request(`/${id}/runtime`, { action: 'pause', revision: started.body.revision });
  assert.equal(paused.status, 200, JSON.stringify(paused.body));
  assert.equal(paused.body.status, 'paused');
  const archived = await f.request(`/${id}/archive`, { actor: '用户' });
  assert.equal(archived.status, 200, JSON.stringify(archived.body));
  assert.ok(archived.body.archived);
  assert.equal((await f.request(`/${id}/restore`, { actor: '用户' })).status, 200);
  assert.equal((await f.request(`/${id}/delete`, { actor: '用户', confirm_title: '目录保护' })).status, 200);
  assert.equal((await f.request(`/${id}`)).status, 404);
});

for (const change of ['limits', 'archive', 'phase']) {
  test(`Worker start rolls back when ${change} changes after validation`, async t => {
    const f = await worker_fixture(t);
    const created = await f.request('', { title: '并发启动', host: 'Codex', experts: { Codex: 'cli' } });
    const id = created.body.id;
    f.before_batch = () => {
      const query = { limits: 'UPDATE discussion_limits SET max_minutes=1,revision=revision+1 WHERE room_id=?',
        archive: 'UPDATE room_directory SET archived=1 WHERE room_id=?',
        phase: "UPDATE topic_settings SET phase='concluded' WHERE room_id=?" }[change];
      f.sql.prepare(query).run(id);
    };
    const started = await f.request(`/${id}/runtime`, { action: 'start', revision: 0, deadline: Math.floor(Date.now() / 1000) + 600 });
    assert.equal(started.status, 403, JSON.stringify(started.body));
    assert.equal(f.sql.prepare('SELECT COUNT(*) AS count FROM discussion_runtime WHERE room_id=?').get(id).count, 0);
    assert.equal(f.sql.prepare('SELECT COUNT(*) AS count FROM discussion_events WHERE room_id=?').get(id).count, 0);
  });
}

test('Worker starts the clock for migrated active rooms without resetting an existing clock', async t => {
  const f = await worker_fixture(t);
  const created = await f.request('', { title: '旧房间开始计时', host: 'Codex', phase: 'initial', experts: { Codex: 'cli' } });
  const id = created.body.id;
  f.sql.prepare('UPDATE discussion_limits SET started_at=0 WHERE room_id=?').run(id);
  const started = await f.request(`/${id}/runtime`, { action: 'start', revision: 0, deadline: Math.floor(Date.now() / 1000) + 600 });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.ok((await f.request(`/${id}`)).body.limits.started_at > 0);
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

test('Worker discussion members answer direct questions from the user outside the floor, turns and rounds', async t => {
  const f = await worker_fixture(t);
  const created = await f.request('', { title: '直接提问', host: 'Codex', phase: 'paused', runtime_mode: 'automatic', experts: { Codex: 'cli', Claude: 'cli' } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const path = `/${created.body.id}`;
  const floor_before = (await f.request(path)).body.floor;
  const ask = (text, to) => f.request(`${path}/messages`, { author: '用户', text, to, submission_id: crypto.randomUUID().replaceAll('-', '') });
  assert.equal((await ask('谁是主持？', ['Nobody'])).status, 400);
  assert.equal((await ask('@Claude 你怎么看？', ['Claude'])).status, 201);
  const inbox = (await f.request(`${path}/inbox`, undefined, 'owner-credential'.repeat(3))).body;
  const claude = inbox.members.find(member => member.name === 'Claude');
  assert.deepEqual(claude.pending.map(item => item.purpose), ['ask']);
  const execution = await f.request(`${path}/executions`, { member_id: claude.id, client_id: crypto.randomUUID(), cwd: '' }, 'owner-credential'.repeat(3));
  assert.equal(execution.status, 200, JSON.stringify(execution.body));
  const answer = { author: 'Claude', text: '我的看法', source: 'cli', kind: 'chat', execution_id: execution.body.id, submission_id: crypto.randomUUID().replaceAll('-', '') };
  assert.equal((await f.request(`${path}/messages`, { ...answer, execution_id: 0 }, f.member_tokens.Claude)).status, 403);
  const saved = await f.request(`${path}/messages`, answer, f.member_tokens.Claude);
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  const view = (await f.request(path)).body;
  assert.deepEqual(view.floor, floor_before);
  assert.deepEqual(view.asks.requests.map(item => item.status), ['completed']);
  assert.deepEqual([view.completed_rounds, view.current_turn], [0, null]);
});

test('Worker free room starts and ends a discussion and stays one room', async t => {
  const f = await worker_fixture(t);
  const r = await free_worker_room(f, [{ name: 'Gemini', access: 'manual', token: 'gemini-free'.repeat(4) }]);
  const discussion = `${r.path}/discussion`;
  const first = (await r.say('先聊几句')).body.message.id;
  assert.equal((await f.request(discussion, { action: 'start' }, r.claude)).status, 403);
  assert.equal((await f.request(discussion, { action: 'pause' }, r.owner)).status, 400);
  assert.equal((await f.request(discussion, { action: 'end' }, r.owner)).status, 409);
  const started = await f.request(discussion, { action: 'start', goal: '选方案', limits: { max_rounds: 2, max_minutes: 30 } }, r.owner);
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.deepEqual([started.body.mode, started.body.host, started.body.goal, started.body.limits.max_rounds], ['brainstorm', 'Claude', '选方案', 2]);
  assert.deepEqual(started.body.experts, { Claude: 'cli', Gemini: 'cli' });
  assert.deepEqual(Object.fromEntries(started.body.members.map(member => [member.name, member.access])), { Claude: 'runner', Gemini: 'manual' });
  assert.deepEqual([started.body.session.status, started.body.runtime.mode, started.body.round_budget.base], ['paused', 'automatic', 0]);
  assert.equal((await f.request(discussion, { action: 'start' }, r.owner)).status, 409);
  assert.equal((await f.request(`${r.path}/messages/${first}`)).body.text, '先聊几句');
  const ended = await f.request(discussion, { action: 'end' }, r.owner);
  assert.equal(ended.status, 200, JSON.stringify(ended.body));
  assert.deepEqual([ended.body.mode, ended.body.phase, ended.body.session.status, ended.body.runtime.status], ['free', 'concluded', 'concluded', 'concluded']);
  const again = await f.request(discussion, { action: 'start', goal: '第二轮' }, r.owner);
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.deepEqual([again.body.session.goal, again.body.session.id], ['第二轮', 2]);
});

test('Worker smart scheduling can recommend a manual member, which the inbox lists apart from woken ones', async t => {
  const f = await worker_fixture(t);
  const r = await free_worker_room(f, [{ name: 'Gemini', access: 'manual', token: 'gemini-free'.repeat(4) }]);
  const inbox = async () => (await f.request(`${r.path}/inbox`, undefined, r.owner)).body;
  const first = (await r.say('帮我看看登录报错')).body.message.id;
  const listed = await inbox();
  assert.deepEqual([listed.members.map(member => member.name), listed.observers.map(member => member.name)], [['Claude'], ['Gemini']]);
  const gemini_id = await r.member_id('Gemini');
  assert.equal((await f.request(`${r.path}/recommendations`, { message_id: first, member_id: gemini_id, provider: 'jev', confidence: 0.9 }, r.owner)).status, 200);
  assert.equal((await f.request(`${r.path}/recommendations/${first}`, { action: 'adopt', mode: 'interrupt' }, r.owner)).body.recommendation.status, 'adopted');
  assert.deepEqual((await inbox()).observers[0].pending.map(item => item.message_id), [first]);
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
  await r.say('等待超时');
  const timed = (await r.reserve()).body;
  f.sql.prepare('UPDATE discussion_limits SET execution_minutes=1 WHERE room_id=?').run(r.room.id);
  f.sql.prepare('UPDATE member_executions SET created_at=unixepoch()-60,lease_until=unixepoch() WHERE id=?').run(timed.id);
  await f.request(`${r.path}/inbox`, undefined, r.owner);
  assert.equal((await f.request(r.path)).body.free.members[0].execution.result, '已达到单次执行时限');
  assert.equal((await f.request(`${r.path}/inbox`, undefined, r.claude)).status, 403);
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
  const reports = (await f.request(r.path)).body.free.executions;
  assert.deepEqual(reports.find(item => item.id === claude.id).changes, ['index.html']);
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
  assert.equal((await f.request(`${r.path}/executions/${retry.id}`, { action: 'fail', reason: 'CLI 退出' }, r.owner)).body.status, 'failed');
  assert.equal((await f.request(r.path)).body.phase, 'discussing');
  const gemini = 'gemini-free'.repeat(4);
  assert.equal((await f.request(`${r.path}/members`, { name: 'Gemini', token: gemini, access: 'manual' }, r.owner)).status, 200);
  assert.equal((await f.request(`${r.path}/members`, { name: 'Gemini', token: gemini }, r.owner)).status, 409);
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
  for (const table of ['room_modes', 'room_members', 'member_requests', 'member_executions']) {
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

test('Worker free hosts route, dispatch, hand back once and stop at the chain budget', async t => {
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
  // Chain one already used 3 AI requests; three dispatch/hand-off cycles reach 8, so the last hand-off is refused.
  for (let cycle = 0; cycle < 3; cycle++) { await work('Claude', { to: ['Codex'] }); await work('Codex'); }
  assert.deepEqual((await f.request(r.path)).body.free.halted_chains.map(item => item.reason), ['budget']);
  assert.equal((await requests()).filter(item => item[0] === 'Claude' && item[2] === 'pending').length, 0);
  const failing = await r.say('全失败', { to: ['Claude'] });
  assert.equal(failing.status, 201);
  await work('Claude', { to: ['Gemini'] });
  const gemini_run = (await r.reserve('Gemini')).body;
  await f.request(`${r.path}/executions/${gemini_run.id}`, { action: 'fail', reason: '退出' }, r.owner);
  assert.deepEqual((await f.request(r.path)).body.free.halted_chains.map(item => item.reason).sort(), ['all_failed', 'budget']);
  const roles = Object.fromEntries((await f.request(`${r.path}/members/${await r.member_id('Codex')}`, { action: 'role', role: 'host' }, r.owner)).body.members
    .map(member => [member.name, member.role]));
  assert.deepEqual(roles, { Claude: 'member', Codex: 'host', Gemini: 'member' });
  assert.equal((await f.request(r.path)).body.host, 'Codex');
  assert.equal((await f.request(`${r.path}/members/${await r.member_id('Codex')}`, { action: 'role', role: 'member' }, r.owner)).status, 400);
  await f.request(`${r.path}/members/${await r.member_id('Codex')}`, { action: 'away' }, r.owner);
  assert.equal((await f.request(r.path)).body.host, 'Claude');
});

test('Worker free rooms forward online answers and link brainstorm rooms', async t => {
  const f = await worker_fixture(t);
  const r = await free_worker_room(f);
  const online = 'deepseek-free'.repeat(3);
  assert.equal((await f.request(`${r.path}/members`, { name: 'DeepSeek', token: online, access: 'online' }, r.owner)).status, 200);
  assert.equal((await f.request(r.path)).body.experts.DeepSeek, 'online');
  assert.equal((await f.request(`${r.path}/members/${await r.member_id('DeepSeek')}`, { action: 'role', role: 'host' }, r.owner)).status, 400);
  await r.say('请 DeepSeek 看看', { to: ['DeepSeek'] });
  const request_id = (await f.request(r.path)).body.free.requests[0].id;
  assert.equal((await r.answer(null, online, 'DeepSeek')).status, 403);
  const forward = { author: 'DeepSeek', text: '在线回答原文', submission_id: 'forward-0001', request_ids: [request_id] };
  assert.equal((await f.request(`${r.path}/messages`, { ...forward, author: 'Qwen' }, r.owner)).status, 403);
  const saved = await f.request(`${r.path}/messages`, forward, r.owner);
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  assert.deepEqual([saved.body.message.author, saved.body.message.submitted_by, saved.body.message.source], ['DeepSeek', '用户', 'proxy']);
  assert.equal((await f.request(r.path)).body.free.requests[0].status, 'completed');
  const child = await f.request('', { title: '方案头脑风暴', goal: 'x', parent_room_id: r.room.id });
  assert.equal(child.status, 201, JSON.stringify(child.body));
  assert.deepEqual(child.body.parent_room, { id: r.room.id, title: '自由协作' });
  assert.deepEqual((await f.request(r.path)).body.linked_rooms, [{ id: child.body.id, title: '方案头脑风暴', phase: 'preparing' }]);
  assert.equal((await f.request('', { title: '无效', goal: 'x', parent_room_id: child.body.id })).status, 400);
});

test('Worker accepts named instances of one platform and rejects invalid names', async t => {
  const f = await worker_fixture(t);
  const room = await f.request('', { title: '双 Claude', goal: 'x', host: 'Claude-主持', experts: { 'Claude-主持': 'cli', Claude: 'cli' } });
  assert.equal(room.status, 201, JSON.stringify(room.body));
  assert.equal(room.body.floor.holder, 'Claude-主持');
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

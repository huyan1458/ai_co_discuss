/** Verify release isolation, static routing, and the direct D1 deployment contract. */
import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { build_pages } from "../scripts/build_pages.mjs";
import worker from "../worker.mjs";

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Run Worker SQL transactions locally with a deterministic concurrent-write hook. */
async function worker_fixture(test_case) {
  const sql = new DatabaseSync(':memory:');
  sql.exec(await readFile(join(PROJECT_ROOT, 'schema.sql'), 'utf8'));
  test_case.after(() => sql.close());
  const fixture = { sql, before_batch: null };
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
  fixture.request = async (path, payload, token = 'owner-credential'.repeat(3)) => {
    const response = await worker.fetch(new Request(`https://discussion.test/api/rooms${path}`, {
      method: payload === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'X-Discussion-Token': token },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    }), { DB: database });
    return { status: response.status, body: await response.json() };
  };
  return fixture;
}

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
  f.sql.exec(await readFile(join(PROJECT_ROOT, 'schema.sql'), 'utf8'));
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

test('Worker forces an early host summary and reports per-participant executions', async t => {
  const f = await worker_fixture(t);
  const created = await f.request('', { title: '提前收尾', host: 'Codex', experts: { Codex: 'cli' }, limits: { max_rounds: 3, summary_minutes: 2 } });
  const id = created.body.id;
  await f.request(`/${id}/turns`, { actor: '用户', expert: 'Codex', question: '待打断', submission_id: 'forced-turn' });
  const started = await f.request(`/${id}/runtime`, { action: 'start', revision: 0, deadline: Math.floor(Date.now() / 1000) + 600 });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.deepEqual(started.body.participants.map(item => [item.participant, item.status, item.failures, item.stale]), [['Codex', 'pending', 0, false]]);
  assert.equal(started.body.participants[0].lease_until, undefined);
  const closed = await f.request(`/${id}/limits`, { actor: '用户', force: true });
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  assert.equal(closed.body.limits.closing, true);
  assert.equal(closed.body.limits.stop_reason, 'user_stop');
  assert.equal(closed.body.current_turn.status, 'cancelled');
  assert.equal(closed.body.runtime.participants.at(-1).role, 'host');
  await f.request(`/${id}/runtime`, { action: 'pause', revision: closed.body.runtime.revision });
  assert.equal((await f.request(`/${id}/limits`, { actor: '用户', force: true })).status, 400);
});

test('Worker lets paused protected rooms be organized without the owner key, never deleted', async t => {
  const f = await worker_fixture(t);
  const created = await f.request('', { title: '目录保护', host: 'Codex', experts: { Codex: 'cli' } });
  const id = created.body.id;
  const started = await f.request(`/${id}/runtime`, { action: 'start', revision: 0, deadline: Math.floor(Date.now() / 1000) + 600 });
  const running = await f.request(`/${id}/archive`, { actor: '用户' }, '');
  assert.equal(running.status, 403);
  assert.match(running.body.error, /正在自动运行/);
  await f.request(`/${id}/runtime`, { action: 'pause', revision: started.body.revision });
  const archived = await f.request(`/${id}/archive`, { actor: '用户' }, '');
  assert.equal(archived.status, 200, JSON.stringify(archived.body));
  assert.ok(archived.body.archived);
  assert.equal((await f.request(`/${id}/restore`, { actor: '用户' }, '')).status, 200);
  const deleted = await f.request(`/${id}/delete`, { actor: '用户', confirm: '目录保护' }, '');
  assert.equal(deleted.status, 403);
  assert.match(deleted.body.error, /控制凭据/);
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
async function release_fixture(test_case) {
  const root = await mkdtemp(join(tmpdir(), "discuss-pages-test-"));
  test_case.after(async () => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + "/") || resolve(root).startsWith(resolve(tmpdir()) + "\\"));
    await rm(root, { recursive: true, force: true });
  });
  const source = join(root, "release");
  await mkdir(join(source, "web", "modern"), { recursive: true });
  await writeFile(join(source, "worker.mjs"), "export default { fetch() { return new Response('pinned release'); } };\n");
  await writeFile(join(source, "web", "index.html"), "<h1>已验收版本</h1>\n");
  await writeFile(join(source, "web", "app.js"), "/* published assets */\n");
  await writeFile(join(source, "web", "modern", "Draft.vue"), "unpublished component");
  await writeFile(join(source, "web", ".assetsignore"), "modern/\n");
  await cp(join(PROJECT_ROOT, "pages", "public"), join(source, "pages", "public"), { recursive: true });
  await writeFile(join(source, "LICENSE"), "License from the selected release\n");
  await writeFile(join(source, "THIRD_PARTY_NOTICES.md"), "Notices from the selected release\n");
  return { root, source };
}

test("a pinned release uses its own backend and assets and removes stale output", async (test_case) => {
  const { root, source } = await release_fixture(test_case);
  const output = await build_pages(source, root);
  await writeFile(join(output, "obsolete.js"), "old deployment");
  await build_pages(source, root);
  assert.equal(await readFile(join(output, "_worker.js"), "utf8"), await readFile(join(source, "worker.mjs"), "utf8"));
  assert.equal(await readFile(join(output, "index.html"), "utf8"), "<h1>已验收版本</h1>\n");
  for (const path of ["obsolete.js", "modern/Draft.vue", ".assetsignore"]) {
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
  const { root, source } = await release_fixture(test_case);
  const public_root = join(source, "pages", "public");
  await writeFile(join(public_root, "robots.txt"), "User-agent: *\r\nDisallow: /\r\n");
  await writeFile(join(public_root, "404.html"), "<h1>Release-specific fallback</h1>\n");
  const output = await build_pages(source, root);
  for (const name of ["robots.txt", "404.html", "_routes.json"]) {
    assert.equal(await readFile(join(output, name), "utf8"), await readFile(join(public_root, name), "utf8"));
  }
  for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.md"]) {
    assert.equal(await readFile(join(output, name), "utf8"), await readFile(join(source, name), "utf8"));
  }
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

/**
 * End to end: computer A's AI joins computer B's room as an external member, all on one machine (tests/external_harness.mjs).
 * B runs a real Python site and answers relayed requests with its own runner code; a loopback stand-in plays B's online
 * site and sees only ciphertext; A has its own service directory and a fake AI that only runs `codiscuss`.
 *
 * The protocol scenarios play A by hand (a software key that redeems and signs like A's runner), so they check B's side
 * on its own; the A-chain scenarios use A's real commands and runner.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { b_runner_delivery, create_room, external_signer, invite_proof, machine_identity, missing_modules, public_machine, register_room_config,
  python_command, relay_call, run_codiscuss, sample_project, site_json, site_sql, start_fake_relay, start_python_site, temp_home, until,
  write_fake_ai } from './external_harness.mjs';
import { software_passkey } from './passkey_authenticator.mjs';

process.env.CODISCUSS_LANG = 'zh-CN';

// Providers of each side (DESIGN 外部成员实现 §4); a scenario is skipped, with the missing files named, until they land.
const B_SIDE = ['backend/external_members.py', 'runner/external_gateway.mjs', 'runner/repo_read.mjs'];
const A_CHAIN = [...B_SIDE, 'runner/external_client.mjs'];

/** Skip `t` when a provider file is missing; returns whether the scenario can run. */
function needs(t, files) {
  const missing = missing_modules(files);
  if (missing.length) t.skip(`合同提供方未落地：${missing.join('、')}`);
  return !missing.length;
}

/** Computer B: service directory, Python site, a room, its pairing with the stand-in site, and the relay delivering to B's runner. */
async function computer_b(t) {
  const home = temp_home(t, 'b');
  const site = await start_python_site(t, home);
  const relay = await start_fake_relay(t);
  const link = await machine_identity(home, relay.url);
  relay.deliver = await b_runner_delivery(home, relay.url);
  relay.machines = [public_machine(link)];
  const room = await create_room(site.url);
  return { home, site, relay, link, room, machine: { id: link.id, public_key: link.public_key } };
}

/** Computer B with a project opened by the room (its configuration names the project as the room's directory). */
async function computer_b_with_project(t) {
  const b = await computer_b(t);
  b.files = sample_project(join(b.home, 'work'));
  register_room_config(b.home, { site: b.site.url, room: b.room.room.id, token: b.room.owner, cwd: b.files.project });
  return b;
}

/** B issues an invite with its local command (`room-invite`); resolves to `{ code, url, ... }`. */
async function invite(b, options = {}) {
  const file = join(b.home, `invite-${randomUUID()}.json`);
  writeFileSync(file, JSON.stringify({ room_id: b.room.room.id, token: b.room.owner, level: 'read', duration: '1h', site_url: b.relay.url, ...options }));
  const result = await run_codiscuss(b.home, ['launch', 'room-invite', '--file', file]);
  assert.equal(result.status, 0, `room-invite: ${result.stderr}${result.stdout}`);
  assert.match(result.json.code, /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  return result.json;
}

/** Play A by hand: a fresh key redeems `code` through the stand-in site's pairing route; resolves to `{ status, body, signer }`. */
async function redeem(b, code, signer = null) {
  const key = signer ?? await external_signer(b.link.id);
  const answer = await relay_call(b.relay.url, b.machine, { action: 'external-redeem',
    payload: { public_key: key.public_key, proof: invite_proof(code, b.link.id, key.raw), label: 'A 的电脑', platform: 'Claude', adapter: 'claude', model: 'claude-opus-5-5' } }, { signer: key, as: 'proof', route: 'pair' });
  return { ...answer, signer: key };
}

/** Join B's room as an external member (invite + redeem), asserting success; resolves to A's identity at B. */
async function joined(b, options) {
  const { code } = await invite(b, options);
  const answer = await redeem(b, code);
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  return { signer: answer.signer, token: answer.body.token, member: answer.body.member, external_id: answer.body.external_id, body: answer.body };
}

/** One external action signed with A's registered key; resolves to `{ status, body }`. */
function external(b, a, action, payload = {}) {
  return relay_call(b.relay.url, b.machine, { action, payload: { ...payload, token: a.token }, room: b.room.room.id }, { signer: a.signer, as: 'external' });
}

/**
 * A member-scope call on B's room through the gateway (`external-api`); `route` follows `/api/external/rooms/<room>`
 * (子Task1 合同 §3, 子Task2 合同 §4.2).
 */
function member_api(b, a, method, route, body) {
  return external(b, a, 'external-api', { method, path: `/api/external/rooms/${b.room.room.id}${route}`, ...(body === undefined ? {} : { body }) });
}

/** The owner's view of external member `member_id` and its read records on B's site. */
async function owner_external(b, member_id) {
  const base = `${b.room.path}/external-members/${member_id}`;
  const view = await site_json(b.site.url, base, { token: b.room.owner });
  const reads = await site_json(b.site.url, `${base}/reads?after=0&limit=500`, { token: b.room.owner });
  return { view: view.body, reads: reads.body.reads ?? [] };
}

/** External member id at B for a joined A (the member list names it). */
async function member_id_of(b, a) {
  const list = await site_json(b.site.url, `${b.room.path}/external-members`, { token: b.room.owner });
  const found = list.body.members?.find(item => item.name === a.member.name);
  assert.ok(found, `external member ${a.member.name} listed: ${JSON.stringify(list.body)}`);
  return found.member_id;
}

test('harness: a paired device reaches B\'s room through the stand-in site, which only ever sees ciphertext', async t => {
  const b = await computer_b(t);
  const { start_pairing, pairing_proof, pairing_passkey_challenge } = await import('../runner/device_auth.mjs');
  const device = await external_signer(b.link.id), passkey = software_passkey(new URL(b.relay.url).hostname);
  const { code } = start_pairing(b.home, { site: b.relay.url });
  const paired = await relay_call(b.relay.url, b.machine, { action: 'device-pair', payload: { public_key: device.public_key, label: '测试设备',
    proof: pairing_proof(code, b.link.id, device.public_key), passkey: passkey.create(pairing_passkey_challenge(code, device.public_key), b.relay.url) } });
  assert.equal(paired.status, 200, JSON.stringify(paired.body));
  const listed = await relay_call(b.relay.url, b.machine, { action: 'room-api', payload: { method: 'GET', path: '/api/rooms' } }, { signer: device });
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.ok(listed.body.rooms.some(item => item.id === b.room.room.id));
  const stranger = await external_signer(b.link.id);
  const refused = await relay_call(b.relay.url, b.machine, { action: 'room-api', payload: { method: 'GET', path: '/api/rooms' } }, { signer: stranger });
  assert.equal(refused.status, 400);
  const seen = b.relay.frames.map(frame => frame.raw).join('\n');
  assert.doesNotMatch(seen, /外部成员测试|device-pair|room-api|\/api\/rooms/, 'the site only relays ciphertext');
});

test('protocol: join, B names the member, it claims, reads B\'s file and answers bound to its execution', async t => {
  if (!needs(t, B_SIDE)) return;
  const b = await computer_b_with_project(t);
  const a = await joined(b);
  assert.match(a.token, /^.{32,256}$/);
  assert.equal(a.body.level, 'read');
  const member_id = await member_id_of(b, a);
  const before = await owner_external(b, member_id);
  assert.equal(before.view.status, 'active');
  assert.equal(before.view.scope, 'read');
  assert.deepEqual([before.view.adapter, before.view.platform, before.view.model], ['claude', 'Claude', 'claude-opus-5-5'], 'the room keeps the AI reported at check-in');
  assert.equal((await member_api(b, a, 'POST', '/ai', { adapter: 'codex_cli', platform: 'Codex', model: 'gpt-6.1-sol' })).status, 200, 'a later switch passes the gateway');
  assert.equal((await owner_external(b, member_id)).view.platform, 'Codex');
  assert.deepEqual(before.view.directories.map(item => item.replaceAll('\\', '/')), [b.files.project.replaceAll('\\', '/')]);

  const said = await b.room.say('请读 src/main.js，告诉我 ANSWER 的值', { to: [a.member.name] });
  assert.equal(said.status, 201, JSON.stringify(said.body));
  const inbox = await member_api(b, a, 'GET', '/inbox');
  assert.equal(inbox.status, 200, JSON.stringify(inbox.body));
  assert.equal(inbox.body.pending.length, 1);
  const claimed = await member_api(b, a, 'POST', '/claim', { client_id: randomUUID() });
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  const execution_id = claimed.body.id;

  const folders = await external(b, a, 'external-repo', { op: 'ls' });
  assert.equal(folders.status, 200, JSON.stringify(folders.body));
  assert.deepEqual(folders.body.directories, [{ root: 0, name: 'project' }], 'only the folder name leaves B, never its path');
  const read = await external(b, a, 'external-repo', { op: 'read', root: 0, path: 'src/main.js' });
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.match(read.body.text, /ANSWER = 42/);

  const answer = await member_api(b, a, 'POST', '/answer', { text: 'ANSWER 的值是 42', execution_id, submission_id: randomUUID() });
  assert.equal(answer.status, 201, JSON.stringify(answer.body));
  const room = await b.room.view();
  const request = room.free.requests.find(item => item.execution_id === execution_id);
  assert.ok(request, 'the request was answered by this execution');
  assert.equal(request.status, 'completed');
  assert.equal(request.answer_id, answer.body.message.id, 'the answer is bound to the execution');
  assert.equal(answer.body.message.author, a.member.name);

  const { reads } = await owner_external(b, member_id);
  assert.ok(reads.some(item => item.op === 'read' && item.path === 'src/main.js' && item.allowed && item.bytes > 0), JSON.stringify(reads));
  const seen = b.relay.frames.map(frame => frame.raw).join('\n');
  for (const secret of ['ANSWER', 'src/main.js', a.token, 'external-api', b.files.project]) assert.ok(!seen.includes(secret), `the site never sees ${secret}`);
});

test('protocol: A declining or timing out is shown on B\'s request', async t => {
  if (!needs(t, B_SIDE)) return;
  const b = await computer_b_with_project(t);
  const a = await joined(b);
  for (const outcome of ['declined', 'timeout']) {
    assert.equal((await b.room.say(`第 ${outcome} 次点名`, { to: [a.member.name] })).status, 201);
    const inbox = await member_api(b, a, 'GET', '/inbox');
    const request_ids = inbox.body.pending.map(item => item.id ?? item.request_id);
    assert.equal(request_ids.length, 1, JSON.stringify(inbox.body));
    const declined = await member_api(b, a, 'POST', '/decline', { request_ids, outcome });
    assert.equal(declined.status, 200, JSON.stringify(declined.body));
    const request = (await b.room.view()).free.requests.find(item => item.id === request_ids[0]);
    assert.equal(request.external_outcome, outcome, JSON.stringify(request));
    assert.equal(request.status, 'cancelled');
  }
  // A request that is not its own, or already handled, is refused.
  const again = await member_api(b, a, 'POST', '/decline', { request_ids: [1], outcome: 'declined' });
  assert.ok(again.status >= 400, JSON.stringify(again));
});

test('protocol: invites are single use and revocable; a revoked or expired member is refused everything', async t => {
  if (!needs(t, B_SIDE)) return;
  const b = await computer_b_with_project(t);
  // A used code does not work again, and a revoked invite never works.
  const first = await invite(b);
  assert.equal((await redeem(b, first.code)).status, 200);
  assert.equal((await redeem(b, first.code)).status, 409, 'a different key cannot take a claimed seat');
  const second = await invite(b);
  const file = join(b.home, 'revoke-invite.json');
  writeFileSync(file, JSON.stringify({ room_id: b.room.room.id, token: b.room.owner, invite_id: second.invite_id }));
  const revoked_invite = await run_codiscuss(b.home, ['launch', 'room-invite-revoke', '--file', file]);
  assert.equal(revoked_invite.status, 0, revoked_invite.stderr);
  assert.equal((await redeem(b, second.code)).status, 400, 'a revoked invite is refused');
  const old = await invite(b);
  const fresh = await invite(b, { member_id: old.member_id });
  assert.equal(fresh.member_id, old.member_id);
  assert.equal((await redeem(b, old.code)).status, 400, 'regeneration invalidates the old link');
  await site_json(b.site.url, `${b.room.path}/external-members/${fresh.member_id}`, { token: b.room.owner, body: { action: 'revoke' } });
  assert.equal((await redeem(b, fresh.code)).status, 409, 'removal prevents redemption');

  const revoked = await joined(b), expired = await joined(b);
  for (const a of [revoked, expired]) assert.equal((await member_api(b, a, 'GET', '/view')).status, 200);
  const revoked_id = await member_id_of(b, revoked), expired_id = await member_id_of(b, expired);
  const revoke = await site_json(b.site.url, `${b.room.path}/external-members/${revoked_id}`, { token: b.room.owner, body: { action: 'revoke' } });
  assert.equal(revoke.status, 200, JSON.stringify(revoke.body));
  // Membership ends when its time is up: move the expiry into the past, as the clock would.
  assert.equal(site_sql(b.home, 'UPDATE external_members SET expires_at=? WHERE member_id=?', [Math.floor(Date.now() / 1000) - 5, expired_id]), 1);
  for (const [a, reason] of [[revoked, 'revoked'], [expired, 'expired']]) {
    for (const attempt of [() => member_api(b, a, 'GET', '/view'), () => member_api(b, a, 'GET', '/inbox'),
      () => member_api(b, a, 'POST', '/claim', { client_id: randomUUID() }), () => external(b, a, 'external-repo', { op: 'read', root: 0, path: 'README.md' })]) {
      const answer = await attempt();
      assert.ok([401, 403].includes(answer.status), `${reason}: ${JSON.stringify(answer)}`);
      assert.doesNotMatch(JSON.stringify(answer.body), /示例项目/);
    }
    const id = a === revoked ? revoked_id : expired_id;
    const { view } = await owner_external(b, id);
    assert.equal(view.status, 'removed');
    assert.equal(view.end_reason, reason);
  }
});

test('protocol: an external signer cannot act as the owner, reach other rooms or use any other relayed action', async t => {
  if (!needs(t, B_SIDE)) return;
  const b = await computer_b_with_project(t);
  const a = await joined(b);
  const other = await create_room(b.site.url, { title: '另一个房间' });
  const room_id = b.room.room.id;
  const snapshot = async () => {
    const view = await b.room.view();
    return JSON.stringify({ messages: (await b.room.messages()).length, members: view.free.members.map(item => [item.name, item.status]),
      other: (await other.messages()).length });
  };
  const before = await snapshot();
  const attempts = [
    ['speak as the user', member_api(b, a, 'POST', '/messages', { author: '用户', text: '房主发言', submission_id: randomUUID() })],
    ['invite a member', member_api(b, a, 'POST', '/members', { name: 'Codex', adapter: 'codex_cli', token: randomUUID().replaceAll('-', '') })],
    ['create an external member', member_api(b, a, 'POST', '/external-members', { name: 'Claude-ext9', adapter: 'claude', token: randomUUID().replaceAll('-', '') })],
    ['revoke someone', member_api(b, a, 'POST', `/external-members/${await member_id_of(b, a)}`, { action: 'update', scope: 'read', expires_at: Math.floor(Date.now() / 1000) + 300 * 86400 })],
    ['stop the room', member_api(b, a, 'POST', '/stop', {})],
    ['read the event log', member_api(b, a, 'GET', '/events')],
    ['start a discussion', member_api(b, a, 'POST', '/discussion', { action: 'start' })],
    ['owner inbox', member_api(b, a, 'GET', '/executions')],
    ['answer without an execution', member_api(b, a, 'POST', '/answer', { text: '没有执行的回答', submission_id: randomUUID() })],
    ['list all rooms', external(b, a, 'external-api', { method: 'GET', path: '/api/rooms' })],
    ['another room', external(b, a, 'external-api', { method: 'GET', path: `/api/rooms/${other.room.id}/messages` })],
    ['another room, member prefix', external(b, a, 'external-api', { method: 'GET', path: `/api/external/rooms/${other.room.id}/messages` })],
    ['owner route under the member prefix', external(b, a, 'external-api', { method: 'GET', path: `/api/external/rooms/${room_id}/../../rooms/${room_id}/events` })],
    ['another room by prefix', external(b, a, 'external-api', { method: 'GET', path: `/api/rooms/${room_id}/../${other.room.id}` })],
    ['admin', external(b, a, 'external-api', { method: 'GET', path: '/api/admin/status' })],
    ['local settings', external(b, a, 'external-api', { method: 'GET', path: '/api/local/settings' })],
    ['room name of another room in the body', relay_call(b.relay.url, b.machine, { action: 'external-api', payload: { method: 'GET', path: `/api/external/rooms/${other.room.id}/view`, token: a.token }, room: other.room.id }, { signer: a.signer, as: 'external' })],
  ];
  for (const [label, pending] of attempts) {
    const answer = await pending;
    assert.ok(answer.status >= 400, `${label}: ${JSON.stringify(answer)}`);
  }
  // Every relayed action other than the four external ones, signed with the external key either way, is refused.
  for (const action of ['room-api', 'room-upload', 'launch', 'room-invite', 'room-invites', 'room-member', 'room-files', 'room-settings',
    'settings', 'computer-site', 'device-list', 'device-revoke', 'execution-details', 'projects', 'browse-directory', 'api-key']) {
    for (const as of ['external', 'device']) {
      const answer = await relay_call(b.relay.url, b.machine, { action, payload: { room_id, token: a.token, method: 'GET', path: '/api/rooms' }, room: room_id },
        { signer: a.signer, as });
      assert.ok(answer.status >= 400, `${action} as ${as}: ${JSON.stringify(answer)}`);
    }
  }
  // The member credential alone, without A's signature, reaches nothing: neither direct nor as a device.
  const direct = await site_json(b.site.url, `/api/rooms/${room_id}/messages`, { token: a.token, body: { author: a.member.name, text: '直连', submission_id: randomUUID() } });
  assert.ok(direct.status >= 400, JSON.stringify(direct));
  assert.equal(await snapshot(), before, 'nothing in either room changed');
});

test('protocol: secrets, ignored files and paths outside the project are refused, and each refusal is audited', async t => {
  if (!needs(t, B_SIDE)) return;
  const b = await computer_b_with_project(t);
  const a = await joined(b);
  const member_id = await member_id_of(b, a);
  const refused = [
    ['.env', 'excluded'], ['id_rsa', 'excluded'], ['data/rooms.sqlite3', 'excluded'], ['../outside.txt', 'path_traversal'],
    [b.files.outside, 'absolute_path'], ...(b.files.git ? [['ignored.log', 'not_in_scope']] : []),
  ];
  for (const [path, reason] of refused) {
    const answer = await external(b, a, 'external-repo', { op: 'read', root: 0, path });
    assert.equal(answer.status, 403, `${path}: ${JSON.stringify(answer)}`);
    assert.equal(answer.body.reason, reason, path);
    assert.doesNotMatch(JSON.stringify(answer.body), /sk-should-never-leave|PRIVATE KEY|private room data|项目目录之外/);
  }
  const grep = await external(b, a, 'external-repo', { op: 'grep', root: 0, query: 'sk-should-never-leave' });
  assert.equal(grep.status, 200, JSON.stringify(grep.body));
  assert.deepEqual(grep.body.matches, [], 'a search never looks into excluded files');
  const listing = await external(b, a, 'external-repo', { op: 'ls', root: 0, path: '' });
  assert.equal(listing.status, 200, JSON.stringify(listing.body));
  const names = listing.body.entries.map(item => item.name);
  for (const hidden of ['.env', 'id_rsa', 'data', '.git']) assert.ok(!names.includes(hidden), `${hidden} is not listed`);
  const unopened = await external(b, a, 'external-repo', { op: 'read', root: 1, path: 'README.md' });
  assert.ok(unopened.status >= 400, `a folder the room does not open: ${JSON.stringify(unopened)}`);

  const { reads } = await owner_external(b, member_id);
  for (const [path, reason] of refused) {
    assert.ok(reads.some(item => !item.allowed && item.reason.includes(reason) && (item.path === path || item.path === path.replaceAll('\\', '/'))),
      `refusal of ${path} is audited: ${JSON.stringify(reads)}`);
  }
  const events = await b.room.events();
  assert.ok(JSON.stringify(events).includes('external.read'), 'reads appear in the room event log');
});

/** Computer A: its own service directory, with Python known so its `codiscuss` can run room commands. */
function computer_a(t) {
  const home = temp_home(t, 'a');
  writeFileSync(join(home, 'local-settings.json'), JSON.stringify({ python: python_command() }));
  return { home };
}

/** A joins B's room with its own command line (`codiscuss join <link>`); resolves to the invited record. */
async function cli_join(a, b, options) {
  const { url } = await invite(b, options);
  const joined_cli = await run_codiscuss(a.home, ['join', url, '--adapter', 'claude', '--json']);
  assert.equal(joined_cli.status, 0, `join: ${joined_cli.stderr}${joined_cli.stdout}`);
  return joined_cli.json.record;
}

/**
 * The adapter layer's place, played by the fake AI: each delivery runs `fake` with the task's access file and A's service
 * directory, as an AI tool started for the task would, and ends the run when it exits. Records every task it is given.
 */
function fake_delivery(a, fake) {
  const tasks = [];
  const deliver = async (profile, binding, task) => {
    tasks.push({ profile, task });
    const child = spawn(process.execPath, [fake.script], { windowsHide: true, stdio: 'ignore', env: { ...process.env, DISCUSS_SERVICE_HOME: a.home,
      DISCUSS_ACCESS_FILE: task.access_path, CODISCUSS_LANG: 'zh-CN', ...(task.tool_lockdown ? { CODISCUSS_TOOL_LOCKDOWN: '1' } : {}) } });
    child.once('close', code => (code === 0 ? task.on_exit() : task.on_failure(new Error(`fake AI exited ${code}`))));
    return { session_id: '' };
  };
  return { deliver, tasks };
}

test('A chain: join by link; at the default level a request waits for A, and A refusing or not answering reaches B', async t => {
  if (!needs(t, A_CHAIN)) return;
  const b = await computer_b_with_project(t), a = computer_a(t);
  const { invited_command, poll_record, APPROVAL_TIMEOUT_MS } = await import('../runner/external_client.mjs');
  const record = await cli_join(a, b);
  assert.equal(record.trust, 'default');
  assert.equal(record.lockdown, true);
  assert.equal(record.fingerprint_checked, true, 'the link\'s fingerprint was checked against B\'s keys');
  assert.equal(record.machine, b.link.id);
  const stored = readFileSync(join(a.home, 'external', 'invited.json'), 'utf8');
  assert.doesNotMatch(stored, /private_key|"token"/, 'the record file holds no secrets');

  const now = Date.now();
  for (const [outcome, settle] of [
    ['declined', async approval => invited_command(a.home, 'invited-refuse', { id: record.id, approval })],
    ['timeout', async () => poll_record(a.home, record.id, { now: () => now + APPROVAL_TIMEOUT_MS + 1 })],
  ]) {
    assert.equal((await b.room.say(`请看一下（${outcome}）`, { to: [record.member] })).status, 201);
    const polled = await poll_record(a.home, record.id, { now: () => now });
    assert.ok(polled.approval, `the request waits for A: ${JSON.stringify(polled)}`);
    const listed = await invited_command(a.home, 'invited-list', {});
    assert.ok(listed.records[0].approvals.some(item => item.id === polled.approval));
    await settle(polled.approval);
    const requests = (await b.room.view()).free.requests;
    const request = requests.at(-1);
    assert.equal(request.external_outcome, outcome, JSON.stringify(requests));
    assert.equal(request.status, 'cancelled');
  }
  // Leaving ends the membership at B and deletes A's key and credential.
  const left = await invited_command(a.home, 'invited-leave', { id: record.id });
  assert.equal(left.record.status, 'left');
  const list = await site_json(b.site.url, `${b.room.path}/external-members`, { token: b.room.owner });
  const member = list.body.members.find(item => item.name === record.member);
  assert.equal(member.end_reason, 'left', JSON.stringify(member));
});

test('A chain: borrowed, A\'s fake AI reads B\'s file with codiscuss repo and answers in B\'s room, bound to its execution', async t => {
  if (!needs(t, A_CHAIN)) return;
  const b = await computer_b_with_project(t), a = computer_a(t);
  const { invited_command, poll_record } = await import('../runner/external_client.mjs');
  const record = await cli_join(a, b);
  assert.equal((await invited_command(a.home, 'invited-trust', { id: record.id, trust: 'borrow', max_wakes: 5, hours: 1 })).record.trust, 'borrow');
  const fake = write_fake_ai(join(a.home, 'fake-ai'), [
    ['repo', 'read', 'src/main.js', '--root', '0'],
    ['repo', 'read', '.env', '--root', '0'],
    ['message', 'post', '--body', 'ANSWER 的值是 42（读自对方项目的 src/main.js）'],
  ]);
  const delivery = fake_delivery(a, fake);
  // A's software settings name where its Claude Code is, as `codiscuss setup` saves them; here it is the fake AI.
  writeFileSync(join(a.home, 'launch-settings.json'), JSON.stringify({ participants: { Claude: { adapter: 'claude', executable: fake.command } } }));
  assert.equal((await b.room.say('请读 src/main.js，告诉我 ANSWER 的值', { to: [record.member] })).status, 201);
  const polled = await poll_record(a.home, record.id, { deliver: delivery.deliver });
  assert.ok(Number.isInteger(polled.execution_id), `woken directly: ${JSON.stringify(polled)}`);
  const steps = await until(() => { const all = fake.steps().filter(step => step.args); return all.length === 3 && all; }, { limit: 60000, label: 'fake AI steps' });
  await until(async () => !(await invited_command(a.home, 'invited-list', {})).records[0].running, { limit: 20000, label: 'run finished at A' });

  const [read, secret, post] = steps;
  assert.equal(read.status, 0, read.stderr);
  assert.match(read.stdout, /ANSWER = 42/);
  assert.notEqual(secret.status, 0, 'a secret file is refused to the AI');
  assert.doesNotMatch(secret.stdout + secret.stderr, /sk-should-never-leave/);
  assert.equal(post.status, 0, post.stderr);

  const [{ task, profile }] = delivery.tasks;
  assert.equal(task.tool_lockdown, true, 'a borrowed AI runs narrowed to codiscuss commands');
  assert.equal(profile.project_access, 'read');
  const access = JSON.parse(readFileSync(task.access_path, 'utf8'));
  assert.equal(access.transport, 'external');
  assert.ok(!('token' in access), 'the AI never holds the member credential');
  assert.ok(!readdirSync(task.directory).some(name => /secret/i.test(name)));

  const room = await b.room.view();
  const request = room.free.requests.find(item => item.execution_id === polled.execution_id);
  assert.ok(request, JSON.stringify(room.free.requests));
  assert.equal(request.status, 'completed');
  const answer = (await b.room.messages()).find(item => item.id === request.answer_id);
  assert.equal(answer.author, record.member);
  assert.match(answer.text, /42/);

  // Once B revokes the member, the same command is refused.
  const member_id = (await site_json(b.site.url, `${b.room.path}/external-members`, { token: b.room.owner })).body.members.find(item => item.name === record.member).member_id;
  assert.equal((await site_json(b.site.url, `${b.room.path}/external-members/${member_id}`, { token: b.room.owner, body: { action: 'revoke' } })).status, 200);
  const after = await run_codiscuss(a.home, ['repo', 'read', 'src/main.js', '--root', '0'], { env: { DISCUSS_ACCESS_FILE: task.access_path } });
  assert.notEqual(after.status, 0, 'reading after revocation is refused');
  assert.doesNotMatch(after.stdout, /ANSWER = 42/);
});

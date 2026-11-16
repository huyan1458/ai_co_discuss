import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import { external_task_text, TASK_SUBCOMMANDS } from '../runner/expert_prompts.mjs';
import { APPROVAL_TIMEOUT_MS, fingerprint_of, invite_proof, invited_command, key_id_of, MEMBER_API, parse_invite, poll_record, proxy_request,
  lockdown_launch_guard, read_store, RENEW_MS, repo_command, use_plain_secrets } from '../runner/external_client.mjs';

use_plain_secrets();

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SITE = 'https://b.pages.dev', MACHINE = 'b'.repeat(32), ROOM = 'roomabcdef12', CODE = '0123456789AB', TOKEN = 't'.repeat(64);
const subtle = globalThis.crypto.subtle, encoder = new TextEncoder();

function jwk_pair() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const { kty, crv, x, y } = publicKey.export({ format: 'jwk' });
  return { public_key: { kty, crv, x, y }, private_key: privateKey.export({ format: 'jwk' }) };
}

async function cipher(private_jwk, public_jwk) {
  const own = await subtle.importKey('jwk', private_jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const peer = await subtle.importKey('jwk', public_jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const material = await subtle.importKey('raw', await subtle.deriveBits({ name: 'ECDH', public: peer }, own, 256), 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(), info: encoder.encode('codiscuss-relay-v1') },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function verify(jwk, signature, text) {
  const key = await subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  return subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, Buffer.from(signature, 'base64url'), encoder.encode(text));
}

/**
 * A fake inviting computer B behind its website, per 子Task2 CONTRACT §3–4 and 子Task1 CONTRACT §3: the public machine
 * list, the relay (decrypt, check signatures like the Worker and the gateway), and the member-scope routes.
 */
function fake_b() {
  const ecdh = jwk_pair(), sign = jwk_pair();
  const state = { online: true, registered: {}, pending: [], open: new Set(), declines: [], executions: [], claims: 0, answers: [], leaves: 0, posts: 0,
    calls: [], next_execution: 100, ended: '', me: { name: 'Claude-ext', scope: 'read', expires_at: 1763203600, directories: [{ root: 0, name: 'app' }] } };
  const api = (method, path, body) => {
    state.calls.push(`${method} ${path}`);
    if (state.ended) return { status: 403, body: { error: '外部成员已结束', code: 'external_ended', reason: state.ended } };
    if (path === MEMBER_API.inbox(ROOM)) return { status: 200, body: { pending: state.pending, executions: [...state.open].map(id => ({ id })) } };
    if (path === MEMBER_API.claim(ROOM)) {
      assert.match(body.client_id, /^.{8,100}$/);
      // 子Task1 adds the optional request_ids: only those are claimed.
      const taken = body.request_ids ? state.pending.filter(item => body.request_ids.includes(item.id)) : state.pending;
      if (!taken.length) return { status: 409, body: { error: '没有待处理请求' } };
      state.claims += 1;
      state.claim_bodies = [...(state.claim_bodies || []), body];
      const execution = { id: state.next_execution++, requests: taken, read_until: 5 };
      state.pending = state.pending.filter(item => !taken.includes(item));
      state.open.add(execution.id);
      return { status: 200, body: execution };
    }
    if (path === MEMBER_API.decline(ROOM)) { state.declines.push(body); state.pending = state.pending.filter(item => !body.request_ids.includes(item.id)); return { status: 200, body: { declined: body.request_ids } }; }
    const execution = path.match(/\/executions\/(\d+)$/);
    if (execution) {
      state.executions.push({ id: Number(execution[1]), ...body });
      if (body.action === 'fail') state.open.delete(Number(execution[1]));
      return { status: 200, body: { id: Number(execution[1]) } };
    }
    if (path === MEMBER_API.answer(ROOM)) { state.answers.push(body); state.open.delete(body.execution_id); return { status: 201, body: { id: 77 } }; }
    if (path === MEMBER_API.view(ROOM)) return { status: 200, body: { room: { id: ROOM }, me: state.me } };
    const one = path.match(new RegExp(`^${MEMBER_API.messages(ROOM)}/(\\d+)$`));
    if (one) return { status: 200, body: { message: { id: Number(one[1]), author: '用户', text: `请求正文 ${one[1]} ` + 'x'.repeat(5000) } } };
    if (path === `${MEMBER_API.messages(ROOM)}?mention=Claude-ext`) return { status: 200, body: { messages: [{ id: 40, author: '用户', text: '@Claude-ext 看看' }, { id: 44, author: '用户', text: '再看' }] } };
    if (path === `${MEMBER_API.messages(ROOM)}?author=Claude-ext`) return { status: 200, body: { messages: [{ id: 42, author: 'Claude-ext', text: '方案' }, { id: 40, author: '用户', text: '@Claude-ext 看看' },
      ...state.answers.map((answer, index) => ({ id: 200 + index, author: 'Claude-ext', text: answer.text, execution_id: answer.execution_id }))] } };
    if (path.startsWith(`/api/external/rooms/${ROOM}/messages`)) return { status: 200, body: { ok: true, path } };
    return { status: 403, body: { error: 'external_route_forbidden' } };
  };
  const answer_for = (action, payload) => {
    if (action === 'external-redeem') {
      if (payload.proof !== invite_proof(CODE, MACHINE, payload.public_key)) return { status: 400, body: { error: '邀请码不对或已过期' } };
      state.registered[key_id_of(payload.public_key)] = payload.public_key;
      return { status: 200, body: { external_id: key_id_of(payload.public_key), site: SITE, machine: { id: MACHINE, name: 'B-PC', fingerprint: fingerprint_of(ecdh.public_key, sign.public_key) },
        room: { id: ROOM, name: '求助' }, member: { id: 7, name: `${payload.platform}-ext` }, token: TOKEN, level: 'read', directories: [{ root: 0, name: 'app' }], expires_at: 1763203600 } };
    }
    if (payload.token !== TOKEN) return { status: 403, body: { error: '成员凭据无效' } };
    if (action === 'external-leave') { state.leaves += 1; return { status: 200, body: { ok: true } }; }
    if (action === 'external-repo') {
      if (payload.op === 'ls' && payload.root === undefined) return { status: 200, body: { directories: [{ root: 0, name: 'app' }] } };
      if (payload.path === '.env') return { status: 403, body: { error: 'excluded', reason: 'excluded' } };
      return { status: 200, body: { ok: true, kind: 'file', path: payload.path, root: payload.root, text: 'hello' } };
    }
    if (action !== 'external-api') return { status: 400, body: { error: '外部签名者不能执行此操作' } };
    if (!payload.path.startsWith(`/api/external/rooms/${ROOM}/`)) return { status: 400, body: { error: '外部请求地址无效' } };
    return api(payload.method, payload.path, payload.body);
  };
  const handle = async (url, init = {}) => {
    const { pathname } = new URL(url);
    if (pathname === '/api/machines') return Response.json({ machines: [{ id: MACHINE, name: 'B-PC', public_key: ecdh.public_key, sign_key: sign.public_key, online: state.online }] });
    const route = pathname.match(/^\/api\/machines\/([0-9a-f]{32})\/(relay|pair)$/);
    if (!route) return Response.json({ error: 'not found' }, { status: 404 });
    state.posts += 1;
    const { id, envelope } = JSON.parse(init.body);
    if (!state.online) return Response.json({ status: 'offline' });
    const key = await cipher(ecdh.private_key, envelope.key);
    const plain = JSON.parse(new TextDecoder().decode(await subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(envelope.iv, 'base64'), additionalData: encoder.encode(id) },
      key, Buffer.from(envelope.data, 'base64'))));
    const request = JSON.parse(plain.body);
    assert.equal(request.machine, MACHINE);
    assert.ok(!('device_id' in plain));
    let response;
    if (route[2] === 'relay') {
      const holder = state.registered[plain.external_id];
      const [machine, external_id, seconds, signature] = init.headers['X-CoDiscuss-Device'].split('.');
      const header_ok = holder && machine === MACHINE && external_id === plain.external_id && await verify(holder, signature, `POST\n${pathname}\n${seconds}`);
      if (!header_ok) return Response.json({ error: '这台设备没有与电脑配对' }, { status: 401 });
      assert.equal(request.room, ROOM);
      response = await verify(holder, plain.signature, `${id}\n${plain.body}`) ? answer_for(request.action, request.payload) : { status: 400, body: { error: '签名无效' } };
    } else {
      assert.equal(request.action, 'external-redeem');
      assert.ok(!('room' in request));
      response = await verify(request.payload.public_key, plain.signature, `${id}\n${plain.body}`) ? answer_for(request.action, request.payload) : { status: 400, body: { error: '持有签名无效' } };
    }
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const data = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(`${id}:response`) }, key, gzipSync(Buffer.from(JSON.stringify(response))));
    return Response.json({ status: 'done', response: { iv: Buffer.from(iv).toString('base64'), data: Buffer.from(data).toString('base64'), encoding: 'gzip' } });
  };
  return { state, fetcher: handle, fingerprint: fingerprint_of(ecdh.public_key, sign.public_key) };
}

/** A fake adapter: records what it was handed and lets the test end the run. */
function fake_deliver() {
  const runs = [];
  const deliver = async (profile, binding, task) => { runs.push({ profile, binding, task }); return { session_id: 'session-1' }; };
  return { runs, deliver };
}

function home_dir(t) {
  const home = mkdtempSync(join(tmpdir(), 'codiscuss-external-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

const link = fingerprint => `${SITE}/join#${Buffer.from(JSON.stringify({ v: 1, site: SITE, machine: MACHINE, machine_name: 'B-PC', fp: fingerprint, code: CODE,
  room_name: '求助', level: 'read', expires_at: Date.now() + 600000 })).toString('base64url')}`;

async function joined(t, b, extra = {}) {
  const home = home_dir(t);
  const { record } = await invited_command(home, 'invited-join', { invite: link(b.fingerprint), adapter: 'claude', ...extra }, { fetcher: b.fetcher });
  return { home, record };
}

const deps = (b, delivery, more = {}) => ({ fetcher: b.fetcher, deliver: delivery.deliver, software: { executable: 'C:/fake/claude.exe' }, ...more });
/**
 * Wait until `check()` holds: a run's end is reported in the background (its adapter callback), so the test waits for the
 * state that report leaves rather than for a fixed time. Fails after `limit` ms.
 */
async function wait_for(check, limit = 5000) {
  for (const started = Date.now(); !check();) {
    if (Date.now() - started > limit) throw new Error('等待的状态没有出现');
    await new Promise(done => setTimeout(done, 10));
  }
}
const ended = (home, id, execution_id) => () => read_store(home).records[id].history.some(item => item.execution_id === execution_id && item.outcome !== 'woken');
const reported = (b, action) => () => b.state.executions.some(item => item.action === action);

test('joining keeps the key and credential out of the record and every command output', async t => {
  const b = fake_b();
  const { home, record } = await joined(t, b);
  assert.equal(record.trust, 'default');
  assert.equal(record.fingerprint_checked, true);
  assert.equal(record.member, 'Claude-ext');
  assert.deepEqual(record.directories, [{ root: 0, name: 'app' }]);
  const listed = JSON.stringify(await invited_command(home, 'invited-list'));
  const stored = readFileSync(join(home, 'external', 'invited.json'), 'utf8');
  for (const text of [listed, stored, JSON.stringify(record)]) {
    assert.ok(!text.includes(TOKEN), 'credential leaked');
    assert.ok(!text.includes('"d"'), 'private key leaked');
  }
  assert.ok(readFileSync(join(home, 'external', 'secrets.json'), 'utf8').includes(TOKEN));
});

test('joining after a lost response reuses the persisted signing key and record', async t => {
  const b = fake_b(), home = home_dir(t);
  const input = { invite: link(b.fingerprint), adapter: 'claude' };
  let dropped = false;
  const fetcher = async (url, init) => {
    const result = await b.fetcher(url, init);
    if (!dropped && new URL(url).pathname.endsWith('/pair')) {
      dropped = true;
      throw new Error('lost reply');
    }
    return result;
  };
  await assert.rejects(invited_command(home, 'invited-join', input, { fetcher }));
  const retry = await invited_command(home, 'invited-join', input, { fetcher });
  const again = await invited_command(home, 'invited-join', input, { fetcher });
  assert.equal(retry.record.id, again.record.id);
  assert.equal(Object.keys(b.state.registered).length, 1);
  assert.equal(Object.keys(read_store(home).records).length, 1);
});

test('a link whose fingerprint does not match is refused before anything is sent', async t => {
  const b = fake_b(), home = home_dir(t);
  await assert.rejects(invited_command(home, 'invited-join', { invite: link('c'.repeat(32)), adapter: 'claude' }, { fetcher: b.fetcher }), /指纹不符|fingerprint/);
  assert.equal(b.state.posts, 0);
  assert.deepEqual(read_store(home).records, {});
});

test('a bare code needs the site, takes its only computer, and is marked unchecked', async t => {
  assert.throws(() => parse_invite('0123-4567-89AB'), /--site|site/);
  const b = fake_b(), home = home_dir(t);
  const { record } = await invited_command(home, 'invited-join', { invite: '0123-4567-89ab', site: SITE, adapter: 'claude' }, { fetcher: b.fetcher });
  assert.equal(record.fingerprint_checked, false);
  assert.equal(record.machine, MACHINE);
  await assert.rejects(invited_command(home, 'invited-join', { invite: 'ZZZZ-4567-89AB', site: SITE, adapter: 'claude' }, { fetcher: b.fetcher }), /邀请码不对/);
  await assert.rejects(invited_command(home, 'invited-join', { invite: link(b.fingerprint), adapter: 'codex' }, { fetcher: b.fetcher }), /命令行软件|command-line/);
});

test('default trust waits for consent; approving lets the service wake a locked-down run bound to its execution', async t => {
  const b = fake_b(), delivery = fake_deliver();
  const { home, record } = await joined(t, b);
  b.state.pending = [{ id: 7, message_id: 40, purpose: 'host_ask', created_by: 'host' }];
  const first = await poll_record(home, record.id, deps(b, delivery));
  assert.ok(first.approval);
  await poll_record(home, record.id, deps(b, delivery));
  assert.equal(read_store(home).records[record.id].approvals.length, 1, 'the same request is queued once');
  assert.equal(delivery.runs.length, 0);
  assert.equal(b.state.claims, 0);
  const approved = await invited_command(home, 'invited-approve', { id: record.id, approval: first.approval });
  assert.deepEqual(approved.record.approvals, []);
  const woke = await poll_record(home, record.id, deps(b, delivery));
  assert.equal(woke.execution_id, 100);
  const [run] = delivery.runs;
  assert.equal(run.task.tool_lockdown, true);
  assert.equal(run.profile.project_access, 'read');
  const access = JSON.parse(readFileSync(run.task.access_path, 'utf8'));
  assert.deepEqual({ transport: access.transport, record: access.record, execution_id: access.execution_id, tool_lockdown: access.tool_lockdown },
    { transport: 'external', record: record.id, execution_id: 100, tool_lockdown: true });
  assert.equal(access.draft_directory, run.task.draft_directory);
  assert.ok(!JSON.stringify(access).includes(TOKEN));
  const task = JSON.parse(readFileSync(run.task.task_path, 'utf8'));
  assert.ok(task.subcommands.includes('repo'));
  assert.match(run.task.prompt, /repo read 文件 --root/);
  assert.deepEqual(b.state.executions.map(item => item.action), ['delivery']);
  assert.equal(read_store(home).records[record.id].running.execution_id, 100);
});

test('a running execution is renewed, and ending without an answer fails it there', async t => {
  const b = fake_b(), delivery = fake_deliver();
  const { home, record } = await joined(t, b);
  await invited_command(home, 'invited-trust', { id: record.id, trust: 'trusted' });
  b.state.pending = [{ id: 1, message_id: 10 }];
  const start = Date.now();
  await poll_record(home, record.id, deps(b, delivery, { now: () => start }));
  assert.equal((await poll_record(home, record.id, deps(b, delivery, { now: () => start + 1000 }))).renewed, undefined);
  assert.equal((await poll_record(home, record.id, deps(b, delivery, { now: () => start + RENEW_MS + 1 }))).renewed, true);
  assert.ok(b.state.executions.some(item => item.action === 'renew'));
  delivery.runs[0].task.on_exit();
  await wait_for(reported(b, 'fail'));
  const failed = b.state.executions.find(item => item.action === 'fail');
  assert.match(failed.reason, /未提交本次回答|without submitting/);
  const after = read_store(home).records[record.id];
  assert.equal(after.running, null);
  assert.equal(after.session_id, 'session-1');
  // An answer that arrived leaves nothing to fail.
  b.state.pending = [{ id: 2, message_id: 11 }];
  await poll_record(home, record.id, deps(b, delivery));
  await proxy_request(home, { access: { transport: 'external', record: record.id, room: ROOM }, method: 'POST', path: `/api/rooms/${ROOM}/messages`,
    body: { author: 'Claude-ext', text: '方案如下', execution_id: 101, submission_id: 'sub-1', kind: 'chat', to: ['Codex'] } }, { fetcher: b.fetcher });
  assert.deepEqual(b.state.answers, [{ text: '方案如下', execution_id: 101, submission_id: 'sub-1' }]);
  delivery.runs[1].task.on_exit();
  await wait_for(ended(home, record.id, 101));
  assert.equal(b.state.executions.filter(item => item.action === 'fail').length, 1);
});

test('refusing or letting a request time out tells the inviting room it was not agreed to', async t => {
  const b = fake_b(), delivery = fake_deliver();
  const { home, record } = await joined(t, b);
  b.state.pending = [{ id: 8, message_id: 41 }];
  const { approval } = await poll_record(home, record.id, deps(b, delivery));
  await invited_command(home, 'invited-refuse', { id: record.id, approval }, deps(b, delivery));
  assert.deepEqual(b.state.declines.at(-1), { request_ids: [8], outcome: 'declined' });
  b.state.pending = [{ id: 9, message_id: 42 }];
  const start = Date.now();
  await poll_record(home, record.id, deps(b, delivery, { now: () => start }));
  await poll_record(home, record.id, deps(b, delivery, { now: () => start + APPROVAL_TIMEOUT_MS + 1 }));
  assert.deepEqual(b.state.declines.at(-1), { request_ids: [9], outcome: 'timeout' });
  assert.equal(delivery.runs.length, 0);
  assert.deepEqual(read_store(home).records[record.id].history.map(item => item.outcome), ['refused', 'timeout']);
});

test('full borrowing wakes directly within its limits, then falls back to asking', async t => {
  const b = fake_b(), delivery = fake_deliver();
  const { home, record } = await joined(t, b);
  await invited_command(home, 'invited-trust', { id: record.id, trust: 'borrow', max_wakes: 1, hours: 2 });
  b.state.pending = [{ id: 10, message_id: 50 }];
  assert.equal((await poll_record(home, record.id, deps(b, delivery))).execution_id, 100);
  assert.equal(delivery.runs[0].task.tool_lockdown, true);
  delivery.runs[0].task.on_failure(new Error('模型额度用尽'));
  await wait_for(reported(b, 'fail'));
  assert.equal(b.state.executions.at(-1).reason, '模型额度用尽');
  b.state.pending = [{ id: 11, message_id: 51 }];
  assert.ok((await poll_record(home, record.id, deps(b, delivery))).approval, 'limit used up: ask the owner');
  assert.equal(delivery.runs.length, 1);
  const shown = (await invited_command(home, 'invited-list')).records[0];
  assert.equal(shown.wakes, 1);
  assert.equal(shown.limits.used, 1);
});

test('a trusted computer wakes without lockdown, and its later invitations join as trusted', async t => {
  const b = fake_b(), delivery = fake_deliver();
  const { home, record } = await joined(t, b);
  await invited_command(home, 'invited-trust', { id: record.id, trust: 'trusted' });
  b.state.pending = [{ id: 12, message_id: 60 }];
  await poll_record(home, record.id, deps(b, delivery));
  assert.equal(delivery.runs[0].task.tool_lockdown, false);
  const again = await invited_command(home, 'invited-join', { invite: link(b.fingerprint), adapter: 'claude' }, { fetcher: b.fetcher });
  assert.equal(again.record.trust, 'trusted');
});

test('software that cannot be locked down is not started below the trusted level', async t => {
  const b = fake_b(), delivery = fake_deliver();
  const { home, record } = await joined(t, b, { adapter: 'codex_cli' });
  await invited_command(home, 'invited-trust', { id: record.id, trust: 'borrow' });
  b.state.pending = [{ id: 13, message_id: 70 }];
  await poll_record(home, record.id, deps(b, delivery));
  assert.equal(delivery.runs.length, 0);
  assert.equal(b.state.claims, 0);
  assert.deepEqual(b.state.declines.at(-1), { request_ids: [13], outcome: 'declined' });
  assert.equal(read_store(home).records[record.id].history.at(-1).outcome, 'lockdown_unsupported');
});

test('an offline computer reads as offline, an ended membership as ended, and pausing stops pulling', async t => {
  const b = fake_b(), delivery = fake_deliver();
  const { home, record } = await joined(t, b);
  b.state.online = false;
  await assert.rejects(poll_record(home, record.id, deps(b, delivery)), error => error.offline === true);
  assert.equal((await invited_command(home, 'invited-list')).records[0].contact.state, 'offline');
  b.state.online = true;
  await invited_command(home, 'invited-pause', { id: record.id, paused: true });
  const calls = b.state.calls.length;
  assert.deepEqual(await poll_record(home, record.id, deps(b, delivery)), { skipped: true });
  assert.equal(b.state.calls.length, calls);
  await invited_command(home, 'invited-pause', { id: record.id, paused: false });
  b.state.ended = 'revoked';
  await assert.rejects(poll_record(home, record.id, deps(b, delivery)));
  const shown = (await invited_command(home, 'invited-list')).records[0];
  assert.deepEqual([shown.status, shown.end_reason], ['ended', 'revoked']);
});

test('the AI entry reaches only its own room through member-scope routes, and repo refusals are explained', async t => {
  const b = fake_b();
  const { home, record } = await joined(t, b);
  const access = { transport: 'external', record: record.id, room: ROOM };
  const message = await proxy_request(home, { access, method: 'GET', path: `/api/rooms/${ROOM}/messages/40?execution_id=100` }, { fetcher: b.fetcher });
  assert.deepEqual(message.body, { ok: true, path: `/api/external/rooms/${ROOM}/messages/40?execution_id=100` });
  assert.equal((await proxy_request(home, { access, method: 'GET', path: `/api/rooms/${ROOM}` }, { fetcher: b.fetcher })).body.me.name, 'Claude-ext');
  for (const [method, path] of [['GET', '/api/rooms/otherroom123/messages'], ['GET', '/api/admin'], ['POST', `/api/rooms/${ROOM}/state`], ['GET', `/api/rooms/${ROOM}/events`]]) {
    assert.equal((await proxy_request(home, { access, method, path }, { fetcher: b.fetcher })).status, 403, path);
  }
  assert.deepEqual((await repo_command(home, 'ls', {}, access, { fetcher: b.fetcher })).directories, [{ root: 0, name: 'app' }]);
  assert.equal((await repo_command(home, 'read', { root: 0, path: 'src/a.js' }, access, { fetcher: b.fetcher })).text, 'hello');
  await assert.rejects(repo_command(home, 'read', { root: 0, path: '.env' }, access, { fetcher: b.fetcher }), error => error.reason === 'excluded');
  await assert.rejects(repo_command(home, 'read', { path: 'a' }, { site: SITE, room: ROOM, token: TOKEN }, { fetcher: b.fetcher }), /另一台电脑|another computer/);
});

test('leaving tells the inviting computer and drops the key here', async t => {
  const b = fake_b();
  const { home, record } = await joined(t, b);
  const { record: left, remote } = await invited_command(home, 'invited-leave', { id: record.id }, { fetcher: b.fetcher });
  assert.equal(remote, 'done');
  assert.equal(left.status, 'left');
  assert.equal(b.state.leaves, 1);
  assert.ok(!readFileSync(join(home, 'external', 'secrets.json'), 'utf8').includes(TOKEN));
});

test('the external task text points the AI at repo and its own access file', () => {
  assert.ok(TASK_SUBCOMMANDS.includes('repo'));
  const { prompt } = external_task_text({ name: 'Claude-ext', messages: '#40', cli: 'codiscuss', access_file: '/x/a.json', task_path: '/x/t.json', lockdown: true,
    draft_directory: '/x/drafts', directories: [{ root: 0, name: 'app' }] });
  assert.match(prompt, /codiscuss repo grep 关键词 --root 序号 --access-file \/x\/a\.json/);
  assert.match(prompt, /0 app/);
  const discuss = external_task_text({ name: 'Claude-ext', messages: '#40', cli: 'codiscuss', access_file: '/x/a.json', task_path: '/x/t.json', lockdown: true, draft_directory: '/x/drafts' });
  assert.doesNotMatch(discuss.prompt, /repo read/);
  assert.match(discuss.prompt, /没有开放项目文件/);
  assert.match(prompt, /只能在 \/x\/drafts 写草稿/);
});

/** Run discuss.py as the AI would, asynchronously: the fake website answers from this same process. */
function run_cli(home, args, env = {}, program = ['-X', 'utf8', join(ROOT, 'runner', 'discuss.py')], executable = process.platform === 'win32' ? 'python' : 'python3') {
  return new Promise((done, fail) => {
    const child = spawn(executable, [...program, ...args],
      { env: { ...process.env, DISCUSS_SERVICE_HOME: home, CODISCUSS_NODE: process.execPath, DISCUSS_URL: '', DISCUSS_ACCESS_FILE: '', ...env }, windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', fail);
    child.on('close', status => done({ status, stdout, stderr }));
  });
}

test('discuss.py sends an external task\'s requests through the local entry, and keeps a locked-down run to its draft folder', async t => {
  const b = fake_b();
  const { home, record } = await joined(t, b);
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const answer = await b.fetcher(`http://127.0.0.1${request.url}`, { method: request.method, headers: { 'X-CoDiscuss-Device': request.headers['x-codiscuss-device'] },
      body: chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined });
    response.writeHead(answer.status, { 'Content-Type': 'application/json' });
    response.end(await answer.text());
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => server.close());
  const site = `http://127.0.0.1:${server.address().port}`;
  const path = join(home, 'external', 'invited.json');
  const store = JSON.parse(readFileSync(path, 'utf8'));
  store.records[record.id].site = site;
  writeFileSync(path, JSON.stringify(store));
  const drafts = mkdtempSync(join(home, 'drafts-'));
  const access = join(home, 'access.json');
  writeFileSync(access, JSON.stringify({ transport: 'external', record: record.id, site, room: ROOM, member: 'Claude-ext', execution_id: 100, tool_lockdown: true, draft_directory: drafts }));
  const viewed = await run_cli(home, ['--access-file', access, 'message', 'view', '40']);
  assert.equal(viewed.status, 0, viewed.stderr || viewed.stdout);
  // The execution from the credential goes along, as for any member.
  assert.equal(JSON.parse(viewed.stdout).data.path, `/api/external/rooms/${ROOM}/messages/40?execution_id=100`);
  assert.ok(!viewed.stdout.includes(TOKEN));
  const outside = join(home, 'invited-copy.json');
  writeFileSync(outside, 'secret');
  const blocked = await run_cli(home, ['--access-file', access, 'message', 'post', '--body-file', outside]);
  assert.equal(blocked.status, 2, blocked.stdout);
  assert.equal(b.state.answers.length, 0);
});

test('a restricted run reads files only from its draft folder, never standard input, in every room command', async t => {
  const home = home_dir(t), drafts = mkdtempSync(join(home, 'drafts-'));
  const inside = join(drafts, 'answer.md'), outside = join(home, 'private.txt');
  writeFileSync(inside, '回答');
  writeFileSync(outside, 'secret');
  const env = { CODISCUSS_TOOL_LOCKDOWN: '1', CODISCUSS_LOCKDOWN_DIRECTORY: drafts };
  const common = ['--site', 'http://127.0.0.1:9', '--dry-run'];
  const refused = /草稿目录|draft folder/;
  for (const args of [
    ['message', 'post', 'room00000001', '--as', 'Claude', '--body-file', outside],
    ['message', 'post', 'room00000001', '--as', 'Claude', '--body', 'x', '--summary-file', outside],
    ['attachment', 'upload', 'room00000001', '--file', outside],
    ['question', 'ask', 'room00000001', '--file', outside],
    ['api', '/api/rooms/room00000001/state', '--method', 'POST', '--input', outside],
  ]) {
    const result = await run_cli(home, [...common, ...args], env);
    assert.equal(result.status, 2, args.join(' '));
    assert.match(result.stdout + result.stderr, refused, args.join(' '));
  }
  const piped = await run_cli(home, [...common, 'message', 'post', 'room00000001', '--as', 'Claude', '--body-file', '-'], env);
  assert.match(piped.stdout + piped.stderr, /标准输入|standard input/);
  const allowed = await run_cli(home, [...common, 'message', 'post', 'room00000001', '--as', 'Claude', '--body-file', inside], env);
  assert.doesNotMatch(allowed.stdout + allowed.stderr, refused);
  const unrestricted = await run_cli(home, [...common, 'message', 'post', 'room00000001', '--as', 'Claude', '--body-file', outside]);
  assert.doesNotMatch(unrestricted.stdout + unrestricted.stderr, refused);
});

test('a restricted run cannot use launch image or launch files outside its draft folder', async t => {
  const home = home_dir(t), drafts = mkdtempSync(join(home, 'drafts-'));
  const env = { CODISCUSS_TOOL_LOCKDOWN: '1', CODISCUSS_LOCKDOWN_DIRECTORY: drafts };
  assert.throws(() => lockdown_launch_guard(['image', '--file', join(drafts, 'a.json')], env), /launch image/);
  assert.throws(() => lockdown_launch_guard(['workflow-adopt', '--draft', join(home, 'x')], env), /草稿目录|draft folder/);
  assert.throws(() => lockdown_launch_guard(['workflow-adopt', `--draft=${join(home, 'x')}`], env), /草稿目录|draft folder/);
  assert.throws(() => lockdown_launch_guard(['host-control', '--stdin'], env), /标准输入|standard input/);
  lockdown_launch_guard(['workflow-adopt', '--draft', join(drafts, 'wf')], env);
  lockdown_launch_guard(['image', '--file', join(home, 'a.json')], {});
  const result = await run_cli(home, ['launch', 'image', '--file', join(drafts, 'a.json')], env, [join(ROOT, 'runner', 'codiscuss.mjs')], process.execPath);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /launch image/);
});

test('approving one request claims only that one; others keep waiting for consent', async t => {
  const b = fake_b(), delivery = fake_deliver();
  const { home, record } = await joined(t, b);
  b.state.pending = [{ id: 20, message_id: 80 }];
  const { approval } = await poll_record(home, record.id, deps(b, delivery));
  b.state.pending.push({ id: 21, message_id: 81 });
  await poll_record(home, record.id, deps(b, delivery));
  await invited_command(home, 'invited-approve', { id: record.id, approval });
  await poll_record(home, record.id, deps(b, delivery));
  assert.deepEqual(b.state.claim_bodies[0].request_ids, [20]);
  assert.deepEqual(b.state.pending.map(item => item.id), [21]);
  assert.deepEqual(read_store(home).records[record.id].approvals.filter(item => item.status === 'waiting').map(item => item.request_ids), [[21]]);
});

test('the room view carries requests naming this AI and its answers', async t => {
  const b = fake_b();
  const { home, record } = await joined(t, b);
  const view = await invited_command(home, 'invited-room', { id: record.id }, { fetcher: b.fetcher });
  assert.deepEqual(view.messages.map(item => item.id), [40, 42, 44]);
  assert.deepEqual(view.room.messages, view.messages);
  assert.equal(view.room.me.name, 'Claude-ext');
});

test('a model API member joins and runs with its saved endpoint and an external context, never the credential', async t => {
  const b = fake_b(), delivery = fake_deliver();
  const home = home_dir(t);
  writeFileSync(join(home, 'launch-settings.json'), JSON.stringify({ participants: { DeepSeek: { adapter: 'api', base_url: 'https://api.example.com/v1',
    api_protocol: 'openai-completions', api_key_ref: 'key-1', model: 'deepseek-chat' } } }));
  const { record } = await invited_command(home, 'invited-join', { invite: link(b.fingerprint), adapter: 'api' }, { fetcher: b.fetcher });
  assert.equal(record.member, 'Custom-ext');
  await invited_command(home, 'invited-trust', { id: record.id, trust: 'borrow' });
  b.state.pending = [{ id: 30, message_id: 90 }];
  await poll_record(home, record.id, { fetcher: b.fetcher, deliver: delivery.deliver });
  const [run] = delivery.runs;
  assert.equal(run.profile.base_url, 'https://api.example.com/v1');
  assert.equal(run.profile.model, 'deepseek-chat');
  assert.equal(run.task.tool_lockdown, true);
  const context = run.task.api_context;
  assert.equal(context.home, home);
  assert.deepEqual([context.room, context.execution_id, context.external_access.transport, context.external_access.record], [ROOM, 100, 'external', record.id]);
  assert.ok(!JSON.stringify(run.task.api_context).includes(TOKEN));
  assert.ok(!('token' in context));
  const read = await repo_command(context.home, 'read', { root: 0, path: 'a.js' }, context.external_access, { fetcher: b.fetcher });
  assert.equal(read.text, 'hello');
});

test('a run that answered but ended with an error counts as answered, not failed', async t => {
  const b = fake_b(), delivery = fake_deliver();
  const { home, record } = await joined(t, b);
  await invited_command(home, 'invited-trust', { id: record.id, trust: 'trusted' });
  b.state.pending = [{ id: 40, message_id: 120 }];
  await poll_record(home, record.id, deps(b, delivery));
  await proxy_request(home, { access: { transport: 'external', record: record.id, room: ROOM }, method: 'POST', path: `/api/rooms/${ROOM}/messages`,
    body: { text: '已答', execution_id: 100, submission_id: 'sub-9' } }, { fetcher: b.fetcher });
  delivery.runs[0].task.on_failure(new Error('进程退出码 1'));
  await wait_for(ended(home, record.id, 100));
  assert.ok(!b.state.executions.some(item => item.action === 'fail'));
  const last = read_store(home).records[record.id].history.at(-1);
  assert.deepEqual([last.outcome, last.execution_id, last.reason], ['answered', 100, '进程退出码 1']);
});

test('errors shown on the page carry a template and a stable code', async t => {
  const b = fake_b();
  const { home, record } = await joined(t, b);
  await assert.rejects(invited_command(home, 'invited-trust', { id: record.id, trust: 'full' }), error =>
    error.code === 'invalid_trust' && error.error_text.template === '信任等级只能是 default、borrow 或 trusted');
  await assert.rejects(invited_command(home, 'invited-approve', { id: 'missing' }), error =>
    error.code === 'record_not_found' && error.error_text.params.id === 'missing');
  b.state.online = false;
  await assert.rejects(invited_command(home, 'invited-leave', { id: record.id }, { fetcher: b.fetcher }).then(() => { throw new Error('left'); }), /left/);
  const { contact } = (await invited_command(home, 'invited-list')).records[0];
  assert.equal(contact.state, 'offline');
  assert.equal(contact.code, 'offline');
  assert.match(contact.error_text.template, /对方电脑不在线/);
});

test('the record and the AI follow what the inviting room grants now', async t => {
  const b = fake_b(), delivery = fake_deliver();
  const { home, record } = await joined(t, b);
  await invited_command(home, 'invited-trust', { id: record.id, trust: 'trusted' });
  b.state.me = { name: 'Claude-ext', scope: 'discuss', expires_at: 1763900000, directories: [] };
  await poll_record(home, record.id, deps(b, delivery));
  const shown = (await invited_command(home, 'invited-list')).records[0];
  assert.deepEqual([shown.open_level, shown.expires_at, shown.directories], ['discuss', 1763900000000, []]);
  b.state.me = { name: 'Claude-ext', scope: 'read', expires_at: 1764000000, directories: [{ root: 0, name: 'app' }, { root: 1, name: 'lib' }] };
  b.state.pending = [{ id: 50, message_id: 130 }];
  await poll_record(home, record.id, deps(b, delivery));
  const [run] = delivery.runs;
  assert.match(run.task.prompt, /0 app、1 lib/);
  const task = JSON.parse(readFileSync(run.task.task_path, 'utf8'));
  assert.deepEqual(task.directories, [{ root: 0, name: 'app' }, { root: 1, name: 'lib' }]);
  assert.equal(read_store(home).records[record.id].expires_at, 1764000000000);
});

test('the kept history still shows request and answer texts once the inviting room cannot be read', async t => {
  const b = fake_b(), delivery = fake_deliver();
  const { home, record } = await joined(t, b);
  await invited_command(home, 'invited-trust', { id: record.id, trust: 'trusted' });
  b.state.pending = [{ id: 60, message_id: 140 }];
  await poll_record(home, record.id, deps(b, delivery));
  await proxy_request(home, { access: { transport: 'external', record: record.id, room: ROOM }, method: 'POST', path: `/api/rooms/${ROOM}/messages`,
    body: { text: '回答正文', execution_id: 100, submission_id: 'sub-60' } }, { fetcher: b.fetcher });
  delivery.runs[0].task.on_exit();
  await wait_for(ended(home, record.id, 100));
  b.state.online = false;
  const view = await invited_command(home, 'invited-room', { id: record.id }, { fetcher: b.fetcher });
  assert.equal(view.room, null);
  assert.ok(view.error);
  const request = view.messages.find(item => item.id === 140);
  assert.ok(request.text.startsWith('请求正文 140'));
  assert.equal(request.text.length, 4000);
  const answer = view.messages.find(item => item.execution_id === 100);
  assert.deepEqual([answer.author, answer.text, answer.kept], ['Claude-ext', '回答正文', true]);
  assert.ok(view.messages.every((item, index, list) => index === 0 || list[index - 1].id < item.id));
});

/** External members (子Task2): invites, redemption, the gateway's four actions, and the website letting their keys through. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';

import worker from '../backend/worker.mjs';
import { DEVICE_ACTIONS, device_command, machine_fingerprint, pairing_passkey_challenge, pairing_proof, signed_device_list, start_pairing } from '../runner/device_auth.mjs';
import { create_invite, external_entries, invite_proof, list_invites, revoke_invite } from '../runner/external_gateway.mjs';
import { answer_request } from '../runner/relay_channel.mjs';
import { guard_remote_request } from '../runner/remote_policy.mjs';
import { keyed_links, machine_link, RELAYED_ACTIONS, relay_cipher, seal } from '../runner/remote_launch.mjs';
import { software_device, software_passkey } from './passkey_authenticator.mjs';

// Messages are asserted in their Chinese source text, whatever this computer's language.
process.env.CODISCUSS_LANG = 'zh-CN';
const SITE = 'https://discussion.test', LOCAL = 'http://127.0.0.1:9876', ROOM = 'room1', OWNER = 'o'.repeat(48);
let sequence = 0;
const next_id = () => `external-request-${String(++sequence).padStart(6, '0')}`;

/** A computer bound to SITE with one local room whose project folder holds a source file and a secret. */
function computer(t) {
  const home = mkdtempSync(join(tmpdir(), 'codiscuss-external-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const project = join(home, 'project');
  mkdirSync(join(project, 'src'), { recursive: true });
  writeFileSync(join(project, 'src', 'app.js'), 'export const answer = 42;\n');
  writeFileSync(join(project, '.env'), 'SECRET=1\n');
  const config = join(home, 'room1.json');
  writeFileSync(config, JSON.stringify({ room: ROOM, site: LOCAL, token: OWNER, cwd: project, extra_directories: [] }));
  writeFileSync(join(home, 'rooms.json'), JSON.stringify({ configs: [config] }));
  writeFileSync(join(home, 'local-settings.json'), JSON.stringify({ port: 9876 }));
  machine_link(home, SITE);
  const link = keyed_links(home).sites[SITE];
  return { home, project, config, link };
}

/**
 * The local website as far as the gateway sees it: the owner's external-member routes and the member-scope routes, with
 * every call recorded. `state` lets a test end the membership or make the audit refuse.
 */
function local_website(project) {
  const calls = [], state = { member_token: '', ended: false, scope: 'read', audit: { status: 200, allowed: true, recorded: true }, directories: [project] };
  const fetcher = async (url, options = {}) => {
    const { pathname, search } = new URL(url), headers = options.headers || {}, body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ path: pathname + search, method: options.method, headers, body });
    const owner = headers['X-Discussion-Token'] === OWNER;
    if (pathname === `/api/rooms/${ROOM}` && owner) return Response.json({ title: '代码求助', free: { members: [{ name: 'Codex' }, { name: 'Claude-ext' }] } });
    if (pathname === `/api/rooms/${ROOM}/external-members` && owner && options.method === 'GET') return Response.json({ revision: 'rev-1', members: [] });
    if (pathname === `/api/rooms/${ROOM}/external-members` && owner) {
      state.member_token = body.token;
      return Response.json({ member: { member_id: 7, name: body.name, expires_at: body.expires_at }, revision: 'rev-2' }, { status: 201 });
    }
    if (pathname === `/api/rooms/${ROOM}/external-members/7` && owner) {
      return Response.json({ member_id: 7, status: state.ended ? 'removed' : 'active', end_reason: state.ended ? 'revoked' : '', scope: state.scope, directories: state.directories });
    }
    if (pathname === `/api/rooms/${ROOM}/external-members/7/reads` && owner) {
      return Response.json({ allowed: state.audit.allowed, recorded: state.audit.recorded, code: state.audit.allowed ? 'ok' : 'quota_hour_bytes' }, { status: state.audit.status });
    }
    if (pathname.startsWith(`/api/external/rooms/${ROOM}/`) && headers['X-CoDiscuss-External'] === '1' && headers['X-Discussion-Token'] === state.member_token) {
      if (state.ended) return Response.json({ error: '已结束', code: 'external_ended', reason: 'revoked' }, { status: 403 });
      if (pathname.endsWith('/leave')) { state.ended = true; return Response.json({ left: true }); }
      return Response.json({ ok: true, path: pathname });
    }
    return Response.json({ error: 'forbidden' }, { status: 403 });
  };
  return { calls, state, fetcher };
}

/** A's side: one key per invited record, sealing requests the way A's runner does. */
async function invitee(link) {
  const key = await software_device(link.id);
  const encrypt = async (id, plain) => {
    const ephemeral = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const shared = await relay_cipher(await crypto.subtle.exportKey('jwk', ephemeral.privateKey), link.public_key);
    const { kty, crv, x, y } = await crypto.subtle.exportKey('jwk', ephemeral.publicKey);
    return { shared, frame: { id, envelope: { ...await seal(shared, plain, id), key: { kty, crv, x, y } } } };
  };
  return {
    key,
    /** A request signed by this key as a registered external member. */
    async signed(id, request) {
      const { device_id, ...sealed } = await key.seal(id, { room: ROOM, ...request });
      return encrypt(id, { ...sealed, external_id: device_id });
    },
    /** Redeeming an invite: unsigned at the device level, but proving the code and holding the key. */
    async redeem(id, code, extra = {}) {
      const { device_id, ...sealed } = await key.seal(id, { action: 'external-redeem', payload: { public_key: key.public_key, proof: invite_proof(code, link.id, key.public_key),
        label: 'A 的笔记本', platform: 'Claude', adapter: 'claude', ...extra } });
      return encrypt(id, sealed);
    },
  };
}

/** Deliver one sealed frame to B's relay connection and open the answer. */
async function deliver(env, { shared, frame }, options = {}) {
  const answer = await answer_request(env.home, SITE, env.link, frame, { fetcher: env.website.fetcher, ...options });
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(answer.envelope.iv, 'base64'), additionalData: new TextEncoder().encode(`${frame.id}:response`) },
    shared, Buffer.from(answer.envelope.data, 'base64'));
  return JSON.parse(gunzipSync(Buffer.from(plain)).toString());
}

/** A computer with one external member already joined through an invite. */
async function joined(t) {
  const env = computer(t);
  env.website = local_website(env.project);
  const { code } = await create_invite(env.home, { room_id: ROOM, token: OWNER, level: 'read', duration: '1h' });
  env.member = await invitee(env.link);
  const answer = await deliver(env, await env.member.redeem(next_id(), code));
  assert.equal(answer.status, 200, answer.body.error);
  env.token = answer.body.token;
  env.send = async (action, payload, extra = {}) => deliver(env, await env.member.signed(next_id(), { action, payload, ...extra }));
  return { env, joined: answer.body };
}

test('invites are issued only with the room owner credential, kept as a hash, listed without the code and revocable', async t => {
  const { home, link } = computer(t);
  await assert.rejects(create_invite(home, { room_id: ROOM, token: 'x'.repeat(48) }),
    error => error.code === 'owner_required' && error.error_text.template === '需要本房间的控制凭据，且房间须在这台电脑上');
  await assert.rejects(create_invite(home, { room_id: ROOM, token: OWNER, folders: [3] }), /项目目录的序号/);
  const invite = await create_invite(home, { room_id: ROOM, token: OWNER, level: 'read', duration: 'today' });
  assert.match(invite.code, /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  assert.ok(invite.expires_at - Date.now() <= 10 * 60000 && invite.expires_at - Date.now() > 9 * 60000, 'ten minutes to redeem');
  const [base, fragment] = invite.url.split('#');
  assert.equal(base, `${SITE}/join`);
  const payload = JSON.parse(Buffer.from(fragment, 'base64url').toString());
  assert.deepEqual({ machine: payload.machine, fp: payload.fp, code: payload.code, level: payload.level },
    { machine: link.id, fp: machine_fingerprint(link), code: invite.code.replaceAll('-', ''), level: 'read' });
  assert.ok(!JSON.stringify(payload).includes('project'), 'the link carries no local path');
  const stored = readFileSync(join(home, 'external.json'), 'utf8');
  assert.ok(!stored.includes(invite.code.replaceAll('-', '')), 'only the code hash is kept');
  const listed = (await list_invites(home, { room_id: ROOM, token: OWNER })).invites;
  assert.deepEqual(listed.map(item => item.invite_id), [invite.invite_id]);
  assert.ok(!JSON.stringify(listed).includes(invite.code.replaceAll('-', '')));
  assert.deepEqual(await revoke_invite(home, { room_id: ROOM, token: OWNER, invite_id: invite.invite_id }), { ok: true, revoked: true });
  assert.equal((await list_invites(home, { room_id: ROOM, token: OWNER })).invites.length, 0);
});

test('redeeming proves the code and the key once; B adds the member with the owner credential and publishes the key', async t => {
  const env = computer(t);
  env.website = local_website(env.project);
  const { code } = await create_invite(env.home, { room_id: ROOM, token: OWNER });
  const member = await invitee(env.link), thief = await invitee(env.link);
  // A request signed with another key than the one it registers proves nothing.
  const forged = await member.redeem(next_id(), code, { public_key: thief.key.public_key });
  assert.match((await deliver(env, forged)).body.error, /签名无效/);
  const answer = await deliver(env, await member.redeem(next_id(), code));
  assert.equal(answer.status, 200, answer.body.error);
  assert.equal(answer.body.external_id, member.key.id);
  assert.deepEqual(answer.body.member, { id: 7, name: 'Claude-ext2' }, 'the first free <platform>-ext name');
  assert.equal(answer.body.machine.fingerprint, machine_fingerprint(env.link));
  assert.deepEqual(answer.body.directories, [{ root: 0, name: 'project' }], 'folder names only, no paths');
  const created = env.website.calls.find(call => call.method === 'POST' && call.path === `/api/rooms/${ROOM}/external-members`);
  assert.equal(created.headers['X-Discussion-Token'], OWNER);
  assert.deepEqual({ revision: created.body.revision, scope: created.body.scope, directories: created.body.directories, machine: created.body.machine, token: created.body.token },
    { revision: 'rev-1', scope: 'read', directories: [env.project], machine: `ext:${member.key.id}`, token: answer.body.token });
  assert.ok(!readFileSync(join(env.home, 'external.json'), 'utf8').includes(answer.body.token), 'only the member credential hash is kept');
  // The invite is used up, and the key is published with the signed list.
  assert.match((await deliver(env, await thief.redeem(next_id(), code))).body.error, /邀请码不对或已过期/);
  const list = JSON.parse((await signed_device_list(env.home, env.link, Date.now(), external_entries(env.home))).body).devices;
  assert.deepEqual(list.map(({ id, kind, room }) => ({ id, kind, room })), [{ id: member.key.id, kind: 'external', room: ROOM }]);
});

test('five wrong proofs use every waiting invite up', async t => {
  const env = computer(t);
  env.website = local_website(env.project);
  const { code } = await create_invite(env.home, { room_id: ROOM, token: OWNER });
  const member = await invitee(env.link);
  for (let attempt = 0; attempt < 5; attempt++) assert.equal((await deliver(env, await member.redeem(next_id(), 'AAAAAAAAAAAA'))).status, 400);
  assert.match((await deliver(env, await member.redeem(next_id(), code))).body.error, /邀请码不对或已过期/);
});

test('an external signer reaches only the external actions, never the device actions, the local entrypoint or the owner credential', async t => {
  const { env } = await joined(t);
  const ran = [];
  const options = { run: command => { ran.push(command); return { status: 200, body: {} }; } };
  const allowed = new Set(['external-api', 'external-repo', 'external-leave']);
  const every = [...new Set([...DEVICE_ACTIONS, ...RELAYED_ACTIONS, 'computer-site', 'room-api', 'room-upload', 'external-redeem', 'external-other', ...allowed])];
  for (const action of every) {
    if (action === 'external-leave') continue;
    const payload = { room_id: ROOM, token: env.token, path: `/api/external/rooms/${ROOM}/view`, op: 'ls', method: 'GET' };
    const answer = await deliver(env, await env.member.signed(next_id(), { action, payload, target: 'computer' }), options);
    if (allowed.has(action)) assert.equal(answer.status, 200, `${action}: ${answer.body.error}`);
    else assert.deepEqual([answer.status, answer.body.error], [403, '该操作不对外部成员开放'], action);
  }
  assert.equal(ran.length, 0, 'nothing reached the local entrypoint');
  const external_calls = env.website.calls.filter(call => !call.path.startsWith(`/api/rooms/${ROOM}/external-members`) && call.path !== `/api/rooms/${ROOM}`);
  assert.ok(external_calls.length > 0);
  for (const call of env.website.calls) assert.equal(call.headers['X-CoDiscuss-Bridge'], undefined, 'never the bridge');
  for (const call of external_calls) {
    assert.ok(call.path.startsWith(`/api/external/rooms/${ROOM}/`), call.path);
    assert.equal(call.headers['X-Discussion-Token'], env.token, 'only the member\'s own credential');
    assert.deepEqual([call.headers['X-CoDiscuss-External'], call.headers.Origin, call.headers['Sec-Fetch-Site']], ['1', 'null', 'cross-site']);
  }
  // A paired device cannot use the external actions either, and gets the owner credential only for its own room actions.
  const device = await software_device(env.link.id);
  const { code } = start_pairing(env.home, { site: SITE });
  assert.equal((await device_command(env.home, { site: SITE, machine_id: env.link.id, device_id: null }, 'device-pair', { public_key: device.public_key, label: 'x',
    proof: pairing_proof(code, env.link.id, device.public_key), passkey: software_passkey('discussion.test').create(pairing_passkey_challenge(code, device.public_key), SITE) })).status, 200);
  const as_device = async (action, payload) => {
    const id = next_id(), ephemeral = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const shared = await relay_cipher(await crypto.subtle.exportKey('jwk', ephemeral.privateKey), env.link.public_key);
    const { kty, crv, x, y } = await crypto.subtle.exportKey('jwk', ephemeral.publicKey);
    return deliver(env, { shared, frame: { id, envelope: { ...await seal(shared, await device.seal(id, { action, payload, target: 'computer' }), id), key: { kty, crv, x, y } } } }, options);
  };
  assert.equal((await as_device('external-api', { token: env.token, path: `/api/external/rooms/${ROOM}/view` })).status, 400);
  await as_device('room-invite', { room_id: ROOM, level: 'discuss' });
  assert.deepEqual([ran[0].command, ran[0].input.token, ran[0].input.site_url, ran[0].device], ['room-invite', OWNER, SITE, device.id], 'a paired device issues invites as the owner');
});

test('external-api forwards only the member\'s own room routes with its own credential; an ended membership drops the key', async t => {
  const { env } = await joined(t);
  for (const path of [`/api/rooms/${ROOM}/messages`, `/api/external/rooms/other/view`, `/api/external/rooms/${ROOM}/../../local/settings`, '/api/local/settings',
    `http://evil.test/api/external/rooms/${ROOM}/view`, `/api/external/rooms/${ROOM}/view?x=<script>`]) {
    assert.equal((await env.send('external-api', { path, token: env.token })).status, 400, path);
  }
  assert.equal((await env.send('external-api', { path: `/api/external/rooms/${ROOM}/view`, token: 'z'.repeat(64) })).status, 403, 'a credential not given to this key');
  const posted = await env.send('external-api', { method: 'POST', path: `/api/external/rooms/${ROOM}/answer`, token: env.token, body: { text: '方案', execution_id: 1, submission_id: 's1' } });
  assert.deepEqual(posted, { status: 200, body: { ok: true, path: `/api/external/rooms/${ROOM}/answer` } });
  assert.deepEqual(env.website.calls.at(-1).body, { text: '方案', execution_id: 1, submission_id: 's1' });
  // Another room or another computer named in the signed body is refused before anything is forwarded.
  assert.equal((await env.send('external-api', { path: `/api/external/rooms/${ROOM}/view`, token: env.token }, { room: 'room2' })).status, 403);
  assert.equal((await env.send('external-api', { path: `/api/external/rooms/${ROOM}/view`, token: env.token }, { machine: 'f'.repeat(32) })).status, 403);
  env.website.state.ended = true;
  assert.equal((await env.send('external-api', { path: `/api/external/rooms/${ROOM}/view`, token: env.token })).body.code, 'external_ended');
  assert.deepEqual(external_entries(env.home), [], 'the key leaves the signed list');
  const gone = (await env.send('external-api', { path: `/api/external/rooms/${ROOM}/view`, token: env.token })).body;
  assert.deepEqual([gone.code, gone.error_text], ['external_ended', { template: '这位外部成员未登记或已移除', params: {} }], 'A can tell the membership ended, and a page can translate it');
});

test('a replayed request is not run twice', async t => {
  const { env } = await joined(t);
  const sealed = await env.member.signed(next_id(), { action: 'external-api', payload: { path: `/api/external/rooms/${ROOM}/view`, token: env.token } });
  assert.equal((await deliver(env, sealed)).status, 200);
  assert.match((await deliver(env, sealed)).body.error, /已执行过/);
});

test('external-repo returns content only after the read is recorded and charged; refusals are recorded too', async t => {
  const { env } = await joined(t);
  assert.deepEqual((await env.send('external-repo', { op: 'ls', token: env.token })).body, { directories: [{ root: 0, name: 'project' }] });
  const read = await env.send('external-repo', { op: 'read', root: 0, path: 'src/app.js', token: env.token });
  assert.equal(read.status, 200, read.body.error);
  assert.equal(read.body.text, 'export const answer = 42;\n');
  const audit = env.website.calls.filter(call => call.path.endsWith('/reads'));
  assert.deepEqual(audit.at(-1).body, { op: 'read', root: 0, path: 'src/app.js', bytes: 26, outcome: 'ok', reason: '' });
  assert.equal(audit.at(-1).headers['X-Discussion-Token'], OWNER, 'the gateway records with the owner credential on its own fixed route');
  const secret = await env.send('external-repo', { op: 'read', root: 0, path: '.env', token: env.token });
  assert.deepEqual([secret.status, secret.body.reason, secret.body.text], [403, 'excluded', undefined]);
  assert.equal(env.website.calls.filter(call => call.path.endsWith('/reads')).at(-1).body.outcome, 'denied');
  env.website.state.audit = { status: 200, allowed: false, recorded: true };
  const over = await env.send('external-repo', { op: 'read', root: 0, path: 'src/app.js', token: env.token });
  assert.deepEqual([over.status, over.body.text], [403, undefined], 'over quota: no content');
  env.website.state.audit = { status: 500, allowed: true, recorded: false };
  const unrecorded = await env.send('external-repo', { op: 'grep', root: 0, query: 'answer', token: env.token });
  assert.deepEqual([unrecorded.status, unrecorded.body.matches], [503, undefined], 'a read that cannot be recorded is not returned');
  env.website.state.audit = { status: 200, allowed: true, recorded: true };
  // A folder the room no longer has, or a discuss-only member, reads nothing.
  writeFileSync(env.config, JSON.stringify({ room: ROOM, site: LOCAL, token: OWNER, cwd: join(env.home, 'elsewhere'), extra_directories: [] }));
  assert.equal((await env.send('external-repo', { op: 'read', root: 0, path: 'src/app.js', token: env.token })).body.reason, 'bad_root');
  env.website.state.scope = 'discuss';
  assert.equal((await env.send('external-repo', { op: 'ls', token: env.token })).body.reason, 'not_readable');
});

test('leaving ends the membership with the member\'s own credential and removes the key', async t => {
  const { env } = await joined(t);
  assert.deepEqual(await env.send('external-leave', { token: env.token }), { status: 200, body: { ok: true } });
  assert.equal(env.website.calls.at(-1).path, `/api/external/rooms/${ROOM}/leave`);
  assert.deepEqual(external_entries(env.home), []);
  assert.equal((await env.send('external-repo', { op: 'ls', token: env.token })).status, 403);
});

/** The Worker against an in-memory D1, with the computer bound and syncing through it. */
async function website(t, home) {
  const sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../backend/schema.sql', import.meta.url), 'utf8'));
  t.after(() => sql.close());
  function prepare(query, values = []) {
    const statement = sql.prepare(query);
    const execute = () => ({ results: statement.all(...values), meta: sql.prepare('SELECT changes() AS changes').get() });
    return { bind: (...args) => prepare(query, args), execute, all: async () => execute(), run: async () => execute(),
      first: async column => { const row = statement.get(...values); return column ? row?.[column] ?? null : row ?? null; } };
  }
  const relayed = [];
  const env = { DB: { prepare, batch: async statements => statements.map(statement => statement.execute()) }, ADMIN_SETUP_KEY: 'setup-key-for-tests',
    RELAY: { idFromName: name => name, get: () => ({ fetch: async (input, init) => {
      const request = new Request(input, init);
      relayed.push(request.headers.get('X-Relay-Role'));
      return request.method === 'POST' ? Response.json({ status: 'unknown' }) : new Response(null, { status: 204 });
    } }) } };
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = (url, options) => worker.fetch(new Request(url, options), env);
  const call = async (path, payload, headers = {}) => {
    const response = await worker.fetch(new Request(`${SITE}${path}`, { method: payload === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...headers },
      body: payload === undefined ? undefined : JSON.stringify(payload) }), env);
    return { status: response.status, body: response.status === 101 || response.status === 204 ? null : await response.json() };
  };
  const link = machine_link(home, SITE);
  assert.equal((await call('/api/machines', { ...link, setup_key: 'setup-key-for-tests' })).status, 200);
  return { call, relayed, env };
}

test('the website lets a listed external key through for relayed requests only', async t => {
  const { env } = await joined(t);
  const site = await website(t, env.home);
  await (await import('../runner/remote_launch.mjs')).sync_remote_launches(env.home);
  const key = env.member.key, machine = env.link.id;
  const relay = `/api/machines/${machine}/relay`, request = { id: 'relay-request-000001', envelope: { key: { kty: 'EC', crv: 'P-256', x: 'A'.repeat(43), y: 'B'.repeat(43) }, iv: 'C'.repeat(16), data: 'ZGF0YQ==' } };
  const signed = async (path, payload, method = payload === undefined ? 'GET' : 'POST') => ({ 'X-CoDiscuss-Device': await key.credential(method, path) });
  assert.equal((await site.call(relay, request, await signed(relay, request))).status, 200, 'a relayed request goes through');
  assert.equal(site.relayed.at(-1), 'request');
  const socket = await worker.fetch(new Request(`${SITE}${relay}`, { headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': `codiscuss-relay, d.${await key.credential('GET', relay)}` } }), site.env);
  assert.equal(socket.status, 401, 'no relay socket');
  const commands = `/api/machines/${machine}/commands`;
  assert.equal((await site.call(commands, request, await signed(commands, request))).status, 401, 'no command queue');
  assert.equal((await site.call('/api/admin/profile', { username: 'x' }, await signed('/api/admin/profile', {}))).status, 401, 'no profile change');
  assert.equal((await site.call('/api/admin', undefined, await signed('/api/admin'))).body.profile, null, 'not shown the owner');
  // Once the computer drops the key, the website refuses it too.
  writeFileSync(join(env.home, 'external.json'), JSON.stringify({ invites: {}, externals: {} }));
  await (await import('../runner/remote_launch.mjs')).sync_remote_launches(env.home);
  assert.equal((await site.call(relay, { ...request, id: 'relay-request-000002' }, await signed(relay, request))).status, 401);
});

test('a paired device manages this computer\'s invited rooms as the computer does, joining only public HTTPS sites', async t => {
  const env = computer(t);
  env.website = local_website(env.project);
  const device = await software_device(env.link.id);
  const { code } = start_pairing(env.home, { site: SITE });
  assert.equal((await device_command(env.home, { site: SITE, machine_id: env.link.id, device_id: null }, 'device-pair', { public_key: device.public_key, label: 'x',
    proof: pairing_proof(code, env.link.id, device.public_key), passkey: software_passkey('discussion.test').create(pairing_passkey_challenge(code, device.public_key), SITE) })).status, 200);
  const ran = [];
  const options = { run: command => { ran.push(command); return { status: 200, body: { records: [] } }; } };
  const actions = ['invited-list', 'invited-join', 'invited-trust', 'invited-ai', 'invited-pause', 'invited-approve', 'invited-refuse', 'invited-leave', 'invited-room'];
  for (const action of actions) {
    const id = next_id(), ephemeral = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const shared = await relay_cipher(await crypto.subtle.exportKey('jwk', ephemeral.privateKey), env.link.public_key);
    const { kty, crv, x, y } = await crypto.subtle.exportKey('jwk', ephemeral.publicKey);
    const payload = { id: 'record-1', invite: 'https://b.pages.dev/join#x', trust: 'borrow' };
    const answer = await deliver(env, { shared, frame: { id, envelope: { ...await seal(shared, await device.seal(id, { action, payload, target: 'computer' }), id), key: { kty, crv, x, y } } } }, options);
    assert.equal(answer.status, 200, `${action}: ${answer.body.error}`);
  }
  assert.deepEqual(ran.map(command => [command.command, command.device, command.input.id]), actions.map(action => [action, device.id, 'record-1']),
    'each reaches the local entrypoint as that device, with what it sent');
  // The entrypoint runs a relayed request under the remote policy: an invite may only send this computer to a public HTTPS site.
  const policy = input => guard_remote_request('invited-join', input, { projects: [], participants: {}, home: env.home });
  assert.doesNotThrow(() => policy({ invite: 'https://b.pages.dev/join#payload' }));
  assert.doesNotThrow(() => policy({ invite: 'ABCD-EFGH-JKMN', site: 'https://b.pages.dev' }));
  for (const input of [{ invite: 'http://b.pages.dev/join#payload' }, { invite: 'ABCD-EFGH-JKMN', site: 'https://localhost:8765' }, { invite: 'https://127.0.0.1/join#x' },
    { invite: 'ABCD-EFGH-JKMN', site: 'https://192.168.1.20' }, { invite: 'ABCD-EFGH-JKMN', site: 'https://[::1]' }, { invite: 'ABCD-EFGH-JKMN' }]) {
    assert.throws(() => policy(input), /公网 HTTPS/, JSON.stringify(input));
  }
});

test('the local website\'s own page issues and lists invites without a credential, through the owner stand-in it adds', async t => {
  const { start_python_site, create_room, site_json } = await import('./external_harness.mjs');
  const env = computer(t);
  const site = await start_python_site(t, env.home, {}, { local_launch: true });
  const room = await create_room(site.url);
  writeFileSync(env.config, JSON.stringify({ room: room.room.id, site: site.url, token: room.owner, cwd: env.project, extra_directories: [] }));
  // What the page sends: same-origin, marked local, no room credential; the website stands in for the owner.
  const local = (command, body) => site_json(site.url, `/api/local/${command}`, { body, headers: { 'X-CoDiscuss-Local': '1' } });
  const issued = await local('room-invite', { room_id: room.room.id, level: 'read', duration: '1h' });
  assert.equal(issued.status, 200, JSON.stringify(issued.body));
  assert.match(issued.body.code, /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  const listed = await local('room-invites', { room_id: room.room.id });
  assert.deepEqual(listed.body.invites.map(item => item.invite_id), [issued.body.invite_id]);
  assert.deepEqual((await local('room-invite-revoke', { room_id: room.room.id, invite_id: issued.body.invite_id })).body, { ok: true, revoked: true });
  // A credential the website does not accept for the owner is still refused, with a code and a translatable template.
  const forged = await local('room-invites', { room_id: room.room.id, token: 'f'.repeat(64) });
  assert.deepEqual([forged.status, forged.body.code, forged.body.error_text?.template], [400, 'owner_required', '需要本房间的控制凭据，且房间须在这台电脑上']);
});

test('only this computer may make an inviting computer a trusted device; going back to default or borrowing works from afar', () => {
  const home = mkdtempSync(join(tmpdir(), 'codiscuss-trust-'));
  try {
    const policy = (command, input) => guard_remote_request(command, input, { projects: [], participants: {}, home });
    for (const [command, input] of [['invited-trust', { id: 'record-1', trust: 'trusted' }], ['invited-join', { invite: 'https://b.pages.dev/join#x', adapter: 'claude', trust: 'trusted' }]]) {
      assert.throws(() => policy(command, input), error => error.code === 'trusted_local_only'
        && error.error_text.template === '“信任设备”只能在这台电脑上设置；其他设备可以改回“默认”或“完全借用”', command);
    }
    assert.doesNotThrow(() => policy('invited-trust', { id: 'record-1', trust: 'default' }));
    assert.doesNotThrow(() => policy('invited-trust', { id: 'record-1', trust: 'borrow', max_wakes: 5, hours: 2 }));
    assert.doesNotThrow(() => policy('invited-join', { invite: 'https://b.pages.dev/join#x', adapter: 'claude' }));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

/** Hosted accounts reached on the owner's domain without the online relay (#5588): the receiver and the entry's three addresses. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { add_account, create_gateway, instance_home } from '../gateway/gateway.mjs';
import { external_signer, open_answer, seal_for_machine } from './external_harness.mjs';

const SITE = 'https://codiscuss.example';

function temp(t, label) {
  const home = mkdtempSync(join(tmpdir(), label));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

/** Register member `signer` in `home`'s external registry for the direct address, as a redemption would. */
function register(home, signer, site = SITE) {
  writeFileSync(join(home, 'external.json'), JSON.stringify({ invites: {}, externals: { [signer.id]: {
    public_key: signer.public_key, room_id: 'room-1', member_id: 7, member_name: 'Custom', token_hash: 'x', label: '', site,
    created_at: Date.now(), key_expires_at: Date.now() + 86_400_000 } } }));
}

test('the direct receiver takes only external members\' requests, and checks a member\'s credential before opening anything', async t => {
  const { create_direct_link, direct_link } = await import('../runner/remote_launch.mjs');
  const { answer_direct } = await import('../runner/direct_entry.mjs');
  const home = temp(t, 'direct-receiver-');
  assert.equal((await answer_direct(home, {})).status, 404, 'no direct identity, nothing is answered');
  create_direct_link(home, SITE);
  const link = direct_link(home);
  const machine = { id: link.id, public_key: link.public_key };
  const path = route => `/api/machines/${link.id}/${route}`;

  // A paired device's command (or anything but an external member's request) is refused even when it opens.
  const command = await seal_for_machine(machine, 'command-0000000000001', { action: 'room-api', payload: { method: 'GET', path: '/api/rooms' } });
  assert.equal((await answer_direct(home, { kind: 'pair', path: path('pair'), id: 'command-0000000000001', envelope: command.envelope })).status, 403);
  // Another computer's path, an unknown kind or a malformed id are refused before anything is opened.
  assert.equal((await answer_direct(home, { kind: 'pair', path: `/api/machines/${'f'.repeat(32)}/pair`, id: 'command-0000000000001', envelope: command.envelope })).status, 404);
  assert.equal((await answer_direct(home, { kind: 'sync', path: path('sync'), id: 'command-0000000000001', envelope: command.envelope })).status, 400);

  // A redemption reaches the external gateway: unsigned, it is refused there, inside the sealed answer.
  const unsigned = await seal_for_machine(machine, 'redeem-00000000000001', { action: 'external-redeem', payload: {} });
  const redeemed = await answer_direct(home, { kind: 'pair', path: path('pair'), id: 'redeem-00000000000001', envelope: unsigned.envelope });
  assert.equal(redeemed.status, 200);
  assert.equal(redeemed.body.status, 'done');
  assert.equal((await open_answer(unsigned.key, 'redeem-00000000000001', redeemed.body.response)).status, 400);

  // A relayed request needs a registered member's fresh credential for this exact path.
  const member = await external_signer(link.id), other = await external_signer(link.id);
  register(home, member);
  const relayed = await seal_for_machine(machine, 'relay-000000000000001', { action: 'external-api', payload: { method: 'GET', path: '/api/rooms/room-1' } }, member, 'external');
  const send = async credential => answer_direct(home, { kind: 'relay', path: path('relay'), credential, id: 'relay-000000000000001', envelope: relayed.envelope });
  assert.equal((await send('')).status, 401, 'no credential');
  assert.equal((await send(await other.credential('POST', path('relay')))).status, 401, 'a member this account never registered');
  assert.equal((await send(await member.credential('POST', path('pair')))).status, 401, 'a credential for another path');
  assert.equal((await send(await member.credential('POST', path('relay'), Math.floor(Date.now() / 1000) - 600))).status, 401, 'an old credential');
  // A registered member's credential cannot carry another member's sealed request.
  register(home, other);
  const swapped = await seal_for_machine(machine, 'relay-000000000000002', { action: 'external-api', payload: {} }, member, 'external');
  assert.equal((await answer_direct(home, { kind: 'relay', path: path('relay'), credential: await other.credential('POST', path('relay')), id: 'relay-000000000000002', envelope: swapped.envelope })).status, 403);
  register(home, member);
  const answered = await send(await member.credential('POST', path('relay')));
  assert.equal(answered.status, 200, 'the member\'s own request reaches the gateway, which answers inside the seal');
  assert.ok((await open_answer(relayed.key, 'relay-000000000000001', answered.body.response)).status >= 400, 'there is no such room here');
});

/** Ask the entry with an explicit Host, as the tunnel delivers it. */
function ask(port, path, { method = 'GET', host = 'codiscuss.example', body, headers = {} } = {}) {
  return new Promise((done, fail) => {
    const text = body === undefined ? undefined : JSON.stringify(body);
    const request = http.request({ host: '127.0.0.1', port, path, method, headers: { host, ...(text ? { 'Content-Type': 'application/json' } : {}), ...headers } }, response => {
      const parts = [];
      response.on('data', part => parts.push(part));
      response.on('end', () => {
        const raw = Buffer.concat(parts).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch { /* not JSON */ }
        done({ status: response.statusCode, headers: response.headers, body: json, raw });
      });
    });
    request.on('error', fail);
    request.end(text);
  });
}

test('the entry answers the three direct addresses only on the owner\'s domain and without a session, and passes on nothing of its own', async t => {
  const root = temp(t, 'direct-entry-'), data = join(root, '.codiscuss');
  const servers = [];
  t.after(() => servers.forEach(server => server.close()));
  const listen = server => new Promise(done => { servers.push(server); server.listen(0, '127.0.0.1', () => done(server.address().port)); });
  // Alice's instance website, reached with a session as always.
  const alice_port = await listen(http.createServer((request, response) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ instance: 'alice', url: request.url })); }));
  const alice = add_account(data, 'alice', alice_port);
  // Alice's receiver, trying everything an account could: its own headers, a cookie, extra fields, a page.
  const seen = [];
  const receiver_port = await listen(http.createServer((request, response) => {
    const parts = [];
    request.on('data', part => parts.push(part));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(parts).toString('utf8'));
      seen.push({ url: request.url, headers: request.headers, body });
      response.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': 'planted=1', 'X-Planted': '1' });
      response.end(JSON.stringify({ id: body.id, status: 'done', response: { iv: 'iv', data: 'data', html: '<script>' }, page: '<form>' }));
    });
  }));
  const machine = 'a'.repeat(32);
  const service = instance_home(data, 'alice');
  mkdirSync(join(service, 'local'), { recursive: true });
  writeFileSync(join(service, 'local', 'direct.json'), JSON.stringify({ port: receiver_port, token: 'c'.repeat(64), machine, public_key: { kty: 'EC', crv: 'P-256', x: 'AA', y: 'BB', extra: 'x'.repeat(100) }, sign_key: { kty: 'EC', crv: 'P-256', x: 'CC', y: 'DD' } }));
  writeFileSync(join(data, 'direct-accounts.json'), JSON.stringify({ [machine]: 'alice' }));
  writeFileSync(join(data, 'gateway-settings.json'), JSON.stringify({ tunnel: { name: 'n', host: 'codiscuss.example', id: 'i', credentials: 'c' }, tunnel_enabled: true }));
  const port = await listen(create_gateway({ data }));
  const envelope = { key: { kty: 'EC' }, iv: 'x', data: 'y' };

  // On the owner's domain without a session: the key list and the two sealed routes.
  const listed = await ask(port, '/api/machines');
  assert.deepEqual(listed.body.machines.map(item => [item.id, item.name]), [[machine, '托管账号']], 'a neutral name, never the account\'s');
  assert.deepEqual(listed.body.machines[0].public_key, { kty: 'EC', crv: 'P-256', x: 'AA', y: 'BB' }, 'keys are rebuilt from their four fields');
  const relayed = await ask(port, `/api/machines/${machine}/relay`, { method: 'POST', body: { id: 'relay-000000000000001', envelope }, headers: { 'X-CoDiscuss-Device': 'member-credential', Cookie: 'codiscuss_entry=x' } });
  assert.equal(relayed.status, 200);
  assert.deepEqual(relayed.body, { id: 'relay-000000000000001', status: 'done', response: { iv: 'iv', data: 'data' } }, 'only the sealed reply, rebuilt');
  assert.match(relayed.headers['content-type'], /application\/json/);
  assert.equal(relayed.headers['x-content-type-options'], 'nosniff');
  assert.equal(relayed.headers['set-cookie'], undefined);
  assert.equal(relayed.headers['x-planted'], undefined);
  const [call] = seen;
  assert.equal(call.url, '/direct', 'a fixed path, never the caller\'s');
  assert.equal(call.headers['x-codiscuss-direct'], 'c'.repeat(64));
  for (const name of ['cookie', 'x-codiscuss-entry', 'x-codiscuss-device']) assert.equal(call.headers[name], undefined, name);
  assert.deepEqual({ kind: call.body.kind, path: call.body.path, credential: call.body.credential }, { kind: 'relay', path: `/api/machines/${machine}/relay`, credential: 'member-credential' });

  // Everything else on the owner's domain still needs signing in; another Host gets the entry as before.
  assert.equal((await ask(port, '/api/rooms')).status, 401);
  assert.equal((await ask(port, `/api/machines/${'b'.repeat(32)}/relay`, { method: 'POST', body: { id: 'relay-000000000000002', envelope } })).status, 404, 'an id no account has');
  assert.equal((await ask(port, '/api/machines', { host: `127.0.0.1:${port}` })).status, 401, 'not on the owner\'s domain');
  // With a session the request is the account's own, forwarded to its instance as always.
  const login = await new Promise(done => {
    const request = http.request({ host: '127.0.0.1', port, path: '/_entry/login', method: 'POST', headers: { host: 'codiscuss.example', 'Content-Type': 'application/x-www-form-urlencoded' } },
      response => { response.resume(); done(String(response.headers['set-cookie'] || '').split(';')[0]); });
    request.end(new URLSearchParams({ name: 'alice', password: alice.password }).toString());
  });
  assert.equal((await ask(port, '/api/machines', { headers: { Cookie: login } })).body.instance, 'alice');

  // Redemptions are limited per sending address.
  const pair = () => ask(port, `/api/machines/${machine}/pair`, { method: 'POST', body: { id: 'pair-0000000000000001', envelope }, headers: { 'CF-Connecting-IP': '203.0.113.7' } });
  for (let index = 0; index < 10; index++) assert.equal((await pair()).status, 200, `redemption ${index}`);
  assert.equal((await pair()).status, 429);

  // With the tunnel off the three addresses do not exist.
  writeFileSync(join(data, 'gateway-settings.json'), JSON.stringify({ tunnel: { name: 'n', host: 'codiscuss.example', id: 'i', credentials: 'c' }, tunnel_enabled: false }));
  assert.equal((await ask(port, '/api/machines')).status, 401);
});

test('an invited computer running unchanged code joins, reads and leaves through the entry on the owner\'s domain', async t => {
  const { create_direct_link, direct_link } = await import('../runner/remote_launch.mjs');
  const { create_invite } = await import('../runner/external_gateway.mjs');
  const { direct_receiver } = await import('../runner/direct_entry.mjs');
  const { invited_command, member_api, MEMBER_API } = await import('../runner/external_client.mjs');
  const ROOM = 'roomdirect01', OWNER = 'o'.repeat(48), LOCAL = 'http://127.0.0.1:9877';
  const root = temp(t, 'direct-e2e-'), data = join(root, '.codiscuss');
  add_account(data, 'alice', 9877);
  // Alice's service directory, with one room on her (stand-in) local website.
  const home = instance_home(data, 'alice');
  const project = join(home, 'project');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(home, 'room1.json'), JSON.stringify({ room: ROOM, site: LOCAL, token: OWNER, cwd: project, extra_directories: [] }));
  writeFileSync(join(home, 'rooms.json'), JSON.stringify({ configs: [join(home, 'room1.json')] }));
  writeFileSync(join(home, 'local-settings.json'), JSON.stringify({ port: 9877 }));
  const state = { name: '', token: '', ended: false };
  const local = async (url, options = {}) => {
    const { pathname } = new URL(url), headers = options.headers || {}, body = options.body ? JSON.parse(options.body) : undefined;
    const owner = headers['X-Discussion-Token'] === OWNER;
    if (pathname === `/api/rooms/${ROOM}` && owner) return Response.json({ title: '直连测试', free: { members: [] } });
    if (pathname === `/api/rooms/${ROOM}/external-members` && owner && options.method === 'GET') return Response.json({ revision: 'r1', members: [] });
    if (pathname === `/api/rooms/${ROOM}/external-members` && owner) { state.name = body.name; return Response.json({ member: { member_id: 7, name: body.name }, revision: 'r2' }, { status: 201 }); }
    if (pathname === `/api/rooms/${ROOM}/external-members/7` && owner) {
      if (body?.token) state.token = body.token;
      return Response.json({ member_id: 7, name: state.name, invite_version: 1, duration: '1h', expires_at: Math.floor(Date.now() / 1000) + 3600,
        status: state.ended ? 'removed' : 'active', scope: 'discuss', directories: [] });
    }
    if (pathname.startsWith(`/api/external/rooms/${ROOM}/`) && headers['X-CoDiscuss-External'] === '1' && headers['X-Discussion-Token'] === state.token) {
      if (pathname.endsWith('/leave')) { state.ended = true; return Response.json({ left: true }); }
      return Response.json({ ok: true, path: pathname });
    }
    return Response.json({ error: 'forbidden' }, { status: 403 });
  };
  create_direct_link(home, SITE);
  const link = direct_link(home);
  const invite = await create_invite(home, { room_id: ROOM, token: OWNER, level: 'discuss' }, { fetcher: local });
  assert.ok(invite.url.startsWith(`${SITE}/join#`), 'the invite names the owner\'s domain');

  // Alice's receiver and the entry, as on the hosting computer.
  const receiver = direct_receiver(home, { fetcher: local });
  t.after(() => receiver.close());
  receiver.refresh();
  for (let tries = 0; tries < 50 && !existsSync(join(home, 'local', 'direct.json')); tries++) await new Promise(done => setTimeout(done, 20));
  writeFileSync(join(data, 'direct-accounts.json'), JSON.stringify({ [link.id]: 'alice' }));
  writeFileSync(join(data, 'gateway-settings.json'), JSON.stringify({ tunnel: { name: 'n', host: 'codiscuss.example', id: 'i', credentials: 'c' }, tunnel_enabled: true }));
  const gateway = create_gateway({ data });
  t.after(() => gateway.close());
  const port = await new Promise(done => gateway.listen(0, '127.0.0.1', () => done(gateway.address().port)));

  // The invited computer's own code; only its network goes to this computer, with the domain's Host as through the tunnel.
  const fetcher = (url, options = {}) => new Promise((done, fail) => {
    const target = new URL(url);
    assert.equal(target.origin, SITE);
    const request = http.request({ host: '127.0.0.1', port, path: target.pathname + target.search, method: options.method || 'GET',
      headers: { ...(options.headers || {}), host: target.host } }, response => {
      const parts = [];
      response.on('data', part => parts.push(part));
      response.on('end', () => done(new Response(Buffer.concat(parts), { status: response.statusCode, headers: { 'Content-Type': String(response.headers['content-type'] || '') } })));
    });
    request.on('error', fail);
    request.end(options.body);
  });
  const invited = temp(t, 'direct-invited-');
  const { record } = await invited_command(invited, 'invited-join', { invite: invite.url, adapter: 'claude' }, { fetcher });
  assert.equal(record.fingerprint_checked, true, 'the key list on the domain matches the link\'s fingerprint');
  assert.equal(record.member, state.name);
  assert.deepEqual(await member_api(invited, record.id, 'GET', MEMBER_API.view(ROOM), undefined, { fetcher }), { ok: true, path: MEMBER_API.view(ROOM) });
  await invited_command(invited, 'invited-leave', { id: record.id }, { fetcher });
  assert.equal(state.ended, true, 'leaving reached the room');
});

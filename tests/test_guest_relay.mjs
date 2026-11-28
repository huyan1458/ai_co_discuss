import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { indexedDB } from 'fake-indexeddb';
import { MachineRelay } from '../backend/updates.mjs';
import { clearGuest, guestRequest, redeemGuest } from '../frontend/guest-relay.js';
import { DEVICE_ACTIONS, machine_fingerprint, signed_device_list } from '../runner/device_auth.mjs';
import { answer_request } from '../runner/relay_channel.mjs';
import { keyed_links, machine_link, RELAYED_ACTIONS } from '../runner/remote_launch.mjs';
import { createHash } from 'node:crypto';
import { allows_external_action, EXTERNAL_ACTIONS, external_entries, refresh_guest_entries } from '../runner/external_gateway.mjs';

for (const transport of ['pages', 'direct']) test('guest browser exchanges and polls via ' + transport, async t => {
  const home = mkdtempSync(join(tmpdir(), 'guest-relay-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const tab = new Map();
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { getItem: key => tab.get(key), setItem: (key, value) => tab.set(key, value), removeItem: key => tab.delete(key) } });
  globalThis.indexedDB = indexedDB;
  t.after(() => { delete globalThis.sessionStorage; delete globalThis.indexedDB; });
  const site = 'https://site.test', room = 'r1', code = 'test-invite';
  machine_link(home, site);
  const link = keyed_links(home).sites[site];
  const config = join(home, 'room.json');
  writeFileSync(config, JSON.stringify({ room, site: 'http://localhost:8765', token: 'owner', cwd: home }));
  writeFileSync(join(home, 'rooms.json'), JSON.stringify({ configs: [config] }));
  const expiry = Date.now() + 900000;
  const registry = { guest_invites: { first: { site, machine: link.id, room, code_hash: createHash('sha256').update(code).digest('hex'), expires_at: expiry } } };
  writeFileSync(join(home, 'external.json'), JSON.stringify(registry));
  let ended = false;
  const fetcher = async url => {
    const path = new URL(url).pathname;
    if (path.endsWith('/redeem')) return Response.json({ ok: true, data: {} });
    if (path.endsWith('/session') && ended) return Response.json({ ok: false, code: 'guest_ended', reason: 'disconnected' }, { status: 403 });
    if (path.endsWith('/session')) return Response.json({ ok: true, data: { phase: 'active', guest: { expires_at: expiry } } });
    assert.equal(path, '/api/external/rooms/r1/guest/messages');
    return Response.json({ ok: true, data: { items: [] } });
  };
  const original = globalThis.fetch;
  const originalLocation = globalThis.location;
  t.after(() => { globalThis.fetch = original; globalThis.location = originalLocation; });
  globalThis.location = { origin: site };
  const routes = [];
  const base = site + (transport === 'direct' ? '/api/guest/' : '/api/machines/') + link.id;
  globalThis.fetch = async (url, opts) => {
    // The in-process receiver publishes its device list after redemption.
    if (url === site + '/api/machines/' + link.id + '/sync' && opts.credentials === undefined) return Response.json({});
    routes.push(url);
    assert.equal(opts.credentials, 'omit');
    if (url === '/api/guest/' + link.id + '/key') {
      return Response.json({ id: link.id, public_key: link.public_key, sign_key: link.sign_public_key, transport });
    }
    assert.ok(url === base + '/pair' || url === base + '/relay', url);
    const frame = JSON.parse(opts.body);
    const answer = await answer_request(home, site, link, frame, { fetcher });
    return Response.json({ status: 'done', response: answer.envelope });
  };
  const invite = { site, fp: machine_fingerprint(link), machine: link.id, room, invite_id: 'first', code };
  const keyRoute = '/api/guest/' + link.id + '/key';
  await assert.rejects(redeemGuest({ ...invite, fp: 'wrong' }, 'Visitor'), { code: 'wrong_machine' });
  assert.deepEqual(routes.splice(0), [keyRoute]);
  const { session } = await redeemGuest(invite, 'Visitor');
  assert.deepEqual(await guestRequest(session, 'GET', '/messages'), { items: [] });
  assert.deepEqual(routes, [keyRoute, base + '/pair', base + '/relay']);
  await assert.rejects(guestRequest(session, 'GET', '/../repo'), { code: 'guest_forbidden' });
  const [entry] = external_entries(home, site);
  assert.equal(entry.kind, 'guest');
  const signed = await signed_device_list(home, link, Date.now(), [entry]);
  assert.equal(JSON.parse(signed.body).devices.find(item => item.id === entry.id).kind, 'guest');
  const stored = await new Promise((resolve, reject) => {
    const open = indexedDB.open('codiscuss-guest-visits');
    open.onsuccess = () => {
      const db = open.result;
      const read = db.transaction('visits').objectStore('visits').get(tab.get('codiscuss-guest-visit'));
      read.onsuccess = () => { db.close(); resolve(read.result); };
      read.onerror = () => reject(read.error);
    };
  });
  await assert.rejects(crypto.subtle.exportKey('jwk', stored.key), { name: 'InvalidAccessError' });
  assert.equal(stored.invite.code, undefined);
  const fresh = await import('../frontend/guest-relay.js?reload');
  const restored = await fresh.restoreGuest();
  assert.deepEqual(await fresh.guestRequest(restored.session, 'GET', '/messages'), { items: [] });
  const guest_id = createHash('sha256').update('first:' + entry.id).digest('hex').slice(0, 32);
  const check = state => refresh_guest_entries(home, { fetcher: async () => Response.json({ ok: true, data: state }) });
  for (const extension of [1000, 2000]) {
    assert.equal(await check({ phase: 'active', guest: { id: guest_id, expires_at: expiry + extension } }), true);
    assert.equal(external_entries(home, site)[0].expires_at, expiry + extension);
  }
  ended = true;
  await assert.rejects(fresh.guestRequest(restored.session, 'GET', '/session'), { code: 'guest_ended', reason: 'disconnected' });
  assert.equal(await fresh.restoreGuest(), null);
  await clearGuest(session);
  await assert.rejects(guestRequest(session, 'GET', '/session'), { code: 'guest_ended' });
  assert.deepEqual(external_entries(home, site), []);
});

test('revocation discards a waiting guest poll before forwarding the answer', async () => {
  const machine = { readyState: 1, deserializeAttachment: () => ({ role: 'machine', connection: 'current' }), send() {} };
  const relay = new MachineRelay({ storage: { kv: { get: () => 'current' } }, getWebSockets: role => role === 'machine' ? [machine] : [] });
  const answer = relay.relay({ id: 'waiting', envelope: {}, guest: { id: 'guest', expires_at: Date.now() + 30000 } });
  relay.devices([]);
  assert.deepEqual(await answer, { id: 'waiting', status: 'revoked', reason: 'disconnected' });
});

test('guest policy permits exactly guest-api across the relay action registries', () => {
  const actions = new Set([...RELAYED_ACTIONS, ...DEVICE_ACTIONS, ...EXTERNAL_ACTIONS,
    'guest-api', 'guest-redeem', 'room-api', 'timing-report', 'computer-site', 'room-upload', 'room-media', 'unknown']);
  assert.deepEqual([...actions].filter(action => allows_external_action('guest', action)), ['guest-api']);
});

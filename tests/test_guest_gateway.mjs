import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEVICE_ACTIONS, device_id_of } from '../runner/device_auth.mjs';
import { answer_external, EXTERNAL_ACTIONS } from '../runner/external_gateway.mjs';
import { RELAYED_ACTIONS } from '../runner/remote_launch.mjs';

/** Register a fixture guest and sign in-process requests against a recording backend stub. */
async function guest_fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'guest-gateway-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const project = join(home, 'main'), extra = join(home, 'extra');
  mkdirSync(project);
  mkdirSync(extra);
  writeFileSync(join(extra, 'note.txt'), 'guest-visible');
  writeFileSync(join(extra, '.env'), 'excluded');
  const config = join(home, 'fixture.json');
  writeFileSync(config, JSON.stringify({ room: 'r', site: 'http://localhost:8765', token: 'owner', cwd: project,
    extra_directories: [{ path: extra, access: 'read' }] }));
  writeFileSync(join(home, 'rooms.json'), JSON.stringify({ configs: [config] }));
  const key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const public_key = await crypto.subtle.exportKey('jwk', key.publicKey);
  const external_id = device_id_of(public_key), token = 'fixture-token', outcomes = [];
  writeFileSync(join(home, 'external.json'), JSON.stringify({ externals: { [external_id]: { kind: 'guest', room_id: 'r',
    guest_id: 'visitor', public_key, key_expires_at: Date.now() + 900000, token_hash: createHash('sha256').update(token).digest('hex') } } }));
  const fetcher = async (url, options) => {
    if (new URL(url).pathname === '/api/rooms/r/guest/file-read') {
      const { outcome } = JSON.parse(options.body);
      outcomes.push(outcome);
      return Response.json({ ok: true, data: outcome === 'check' ? { expires_at: Date.now() + 900000 } : { recorded: true } });
    }
    assert.equal(new URL(url).pathname, '/api/external/rooms/r/guest/session');
    return Response.json({ ok: true, data: { phase: 'active', guest: {} } });
  };
  async function send(action, suffix = 'session', query) {
    const id = crypto.randomUUID();
    const body = JSON.stringify({ room: 'r', machine: 'fixture', action, sent_at: Date.now(),
      payload: { token, method: 'GET', path: '/api/external/rooms/r/guest/' + suffix, query } });
    const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, new TextEncoder().encode(id + '\n' + body));
    const packet = { external_id, body, signature: Buffer.from(signature).toString('base64url') };
    return (await answer_external(home, { machine_id: 'fixture', fetcher }, id, packet)).response;
  }
  return { send, outcomes };
}

test('the signed guest gateway dispatches only guest-api', async t => {
  const { send } = await guest_fixture(t);
  const actions = new Set([...RELAYED_ACTIONS, ...DEVICE_ACTIONS, ...EXTERNAL_ACTIONS,
    'guest-api', 'guest-redeem', 'room-api', 'timing-report', 'computer-site', 'room-upload', 'room-media', 'unknown']);
  for (const action of actions) {
    const response = await send(action);
    assert.equal(response.status, action === 'guest-api' ? 200 : 403, action);
    if (action !== 'guest-api') assert.equal(response.body.code, 'action_forbidden', action);
  }
});

test('the gateway supplies guest roots and audits reads with no directory list from the backend', async t => {
  const { send, outcomes } = await guest_fixture(t);
  const roots = await send('guest-api', 'files');
  assert.deepEqual(roots.body.data, { roots: [{ id: 0, name: 'main' }, { id: 1, name: 'extra' }] });
  const preview = await send('guest-api', 'files/content', { root: 1, path: 'note.txt' });
  assert.equal(preview.body.data?.content, 'guest-visible', JSON.stringify(preview.body));
  assert.equal((await send('guest-api', 'files/content', { root: 1, path: '.env' })).status, 403);
  assert.equal((await send('guest-api', 'files', { root: 2 })).status, 403);
  assert.deepEqual(outcomes, ['check', 'served', 'check', 'served', 'check', 'denied', 'check', 'denied']);
});

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { device_command, open_signed_request, pairing_proof, start_pairing, write_allowed } from '../runner/device_auth.mjs';
import { guard_remote_request } from '../runner/remote_policy.mjs';
import { verify_assertion, verify_registration } from '../runner/webauthn.mjs';
import { software_device, software_passkey } from './passkey_authenticator.mjs';

const SITE = 'https://codiscuss.pages.dev', MACHINE = 'machine-1';

function home_dir(t) {
  const home = mkdtempSync(join(tmpdir(), 'codiscuss-devices-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

/** Pair a fresh software device through a code, as a phone would after scanning. */
async function paired_device(home) {
  const device = await software_device();
  const { code } = start_pairing(home, { site: SITE });
  const answer = await device_command(home, { site: SITE, machine_id: MACHINE, device_id: null }, 'device-pair',
    { public_key: device.public_key, label: 'iPhone · Safari', proof: pairing_proof(code, MACHINE, device.public_key) });
  assert.equal(answer.status, 200, answer.body.error);
  return device;
}

test('passkey checks accept a verified user and refuse wrong sites, challenges, missing verification and copied counters', async () => {
  const rp = { origin: SITE, rp_id: 'codiscuss.pages.dev' };
  const passkey = software_passkey(rp.rp_id);
  const kept = verify_registration(passkey.create('challenge-1', SITE), { challenge: 'challenge-1', ...rp });
  assert.equal(kept.id, passkey.id);
  assert.throws(() => verify_registration(passkey.create('challenge-1', 'https://evil.pages.dev'), { challenge: 'challenge-1', ...rp }), /其他网站/);
  assert.throws(() => verify_registration(passkey.create('old', SITE), { challenge: 'challenge-1', ...rp }), /挑战/);
  assert.throws(() => verify_registration(passkey.create('challenge-1', SITE, { flags: 0x41 }), { challenge: 'challenge-1', ...rp }), /验证身份/);
  kept.sign_count = await verify_assertion(passkey.get('challenge-2', SITE), kept, { challenge: 'challenge-2', ...rp });
  assert.equal(kept.sign_count, 1);
  const replay = passkey.get('challenge-3', SITE);
  kept.sign_count = await verify_assertion(replay, kept, { challenge: 'challenge-3', ...rp });
  await assert.rejects(verify_assertion(replay, kept, { challenge: 'challenge-3', ...rp }), /计数异常/, 'a counter that did not grow is refused');
  const forged = { ...passkey.get('challenge-4', SITE), signature: passkey.get('other', SITE).signature };
  await assert.rejects(verify_assertion(forged, kept, { challenge: 'challenge-4', ...rp }), /签名无效/);
});

test('a browser pairs only with a live code shown on a trusted screen, and wrong guesses use the code up', async t => {
  const home = home_dir(t);
  const device = await software_device(), stranger = await software_device();
  const { code } = start_pairing(home, { site: SITE });
  const context = { site: SITE, machine_id: MACHINE, device_id: null };
  for (let attempt = 0; attempt < 5; attempt++) {
    const wrong = await device_command(home, context, 'device-pair', { public_key: stranger.public_key, label: 'x', proof: pairing_proof('AAAAAAAAAAAA', MACHINE, stranger.public_key) });
    assert.equal(wrong.status, 400);
  }
  const late = await device_command(home, context, 'device-pair', { public_key: device.public_key, label: 'x', proof: pairing_proof(code, MACHINE, device.public_key) });
  assert.match(late.body.error, /配对码不对或已过期/, 'five wrong proofs use the code up');
  // A proof made for another computer, or for another key, does not match.
  const fresh = start_pairing(home, { site: SITE }).code;
  assert.equal((await device_command(home, context, 'device-pair', { public_key: device.public_key, label: 'x', proof: pairing_proof(fresh, 'other-machine', device.public_key) })).status, 400);
  assert.equal((await device_command(home, context, 'device-pair', { public_key: device.public_key, label: 'x', proof: pairing_proof(fresh, MACHINE, stranger.public_key) })).status, 400);
});

test('only a paired device\'s signed request is opened; an unpaired browser may only pair', async t => {
  const home = home_dir(t);
  const device = await paired_device(home), stranger = await software_device();
  const opened = await open_signed_request(home, 'id-1', await device.seal('id-1', { action: 'settings' }));
  assert.equal(opened.device_id, device.id);
  await assert.rejects(open_signed_request(home, 'id-2', await device.seal('id-other', { action: 'settings' })), /签名无效/, 'a signature for another id');
  const tampered = await device.seal('id-3', { action: 'settings' });
  await assert.rejects(open_signed_request(home, 'id-3', { ...tampered, body: tampered.body.replace('settings', 'launch') }), /签名无效/);
  await assert.rejects(open_signed_request(home, 'id-4', await stranger.seal('id-4', { action: 'settings' })), /未配对/);
  await assert.rejects(open_signed_request(home, 'id-5', { body: JSON.stringify({ action: 'settings' }) }), /还没有与电脑配对/);
  assert.equal((await open_signed_request(home, 'id-6', { body: JSON.stringify({ action: 'device-pair' }) })).device_id, null);
  await assert.rejects(open_signed_request(home, 'id-7', { action: 'settings', payload: {} }), /请更新网页/, 'an old unsigned page is refused');
  // A revoked device is refused at once.
  await device_command(home, { site: SITE, device_id: device.id }, 'device-revoke', { device_id: device.id });
  await assert.rejects(open_signed_request(home, 'id-8', await device.seal('id-8', { action: 'settings' })), /未配对或已被撤销/);
});

test('remote writing in a room needs this device\'s passkey confirmation, for that room only', async t => {
  const home = home_dir(t);
  const device = await paired_device(home);
  const context = { site: SITE, machine_id: MACHINE, device_id: device.id };
  const passkey = software_passkey('codiscuss.pages.dev');
  const options = (await device_command(home, context, 'passkey-options', {})).body;
  assert.equal((await device_command(home, context, 'passkey-register', { challenge_id: options.challenge_id, credential: passkey.create(options.challenge, SITE) })).status, 200);
  const guard = room_id => () => guard_remote_request('room-member-access', { room_id, name: 'Claude', project_access: 'write' },
    { projects: [], participants: {}, home, write_allowed: room => write_allowed(home, device.id, room), write_needed: room => Object.assign(new Error('need'), { need: 'write-grant', room_id: room }) });
  assert.throws(guard('room-a'), error => error.need === 'write-grant' && error.room_id === 'room-a');
  const challenge = (await device_command(home, context, 'passkey-challenge', { purpose: 'write', room_id: 'room-a' })).body;
  // A confirmation for one room cannot be spent on another.
  const elsewhere = await device_command(home, context, 'write-grant', { challenge_id: challenge.challenge_id, assertion: passkey.get(challenge.challenge, SITE), room_id: 'room-b' });
  assert.equal(elsewhere.status, 400);
  const again = (await device_command(home, context, 'passkey-challenge', { purpose: 'write', room_id: 'room-a' })).body;
  const granted = await device_command(home, context, 'write-grant', { challenge_id: again.challenge_id, assertion: passkey.get(again.challenge, SITE), room_id: 'room-a' });
  assert.equal(granted.status, 200, granted.body.error);
  assert.ok(granted.body.until - Date.now() <= 12 * 3600000 + 1000);
  guard('room-a')();
  assert.throws(guard('room-b'), error => error.need === 'write-grant');
  assert.throws(() => guard_remote_request('start', { participants: { Claude: { project_access: 'write' } } }, { projects: [], participants: {}, home }), /新建房间时成员须为只读/);
  await device_command(home, context, 'write-revoke', { room_id: 'room-a' });
  assert.throws(guard('room-a'), error => error.need === 'write-grant');
});

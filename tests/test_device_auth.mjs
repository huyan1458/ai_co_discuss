import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { device_command, open_signed_request, pairing_passkey_challenge, pairing_proof, signed_device_list, start_pairing, write_allowed } from '../runner/device_auth.mjs';
import { guard_remote_request } from '../runner/remote_policy.mjs';
import { verify_assertion, verify_registration } from '../runner/webauthn.mjs';
import { software_device, software_passkey } from './passkey_authenticator.mjs';

const SITE = 'https://codiscuss.pages.dev', MACHINE = 'machine-1';

function home_dir(t) {
  const home = mkdtempSync(join(tmpdir(), 'codiscuss-devices-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

/** What a phone sends after scanning: proof of the code for its key, and the passkey it created for the same pairing. */
function pairing_request(code, device, passkey, machine = MACHINE) {
  return { public_key: device.public_key, label: 'iPhone · Safari', proof: pairing_proof(code, machine, device.public_key),
    passkey: passkey.create(pairing_passkey_challenge(code, device.public_key), SITE) };
}

/** Pair a fresh software device at the computer, with its passkey, as a phone does after scanning the code. */
async function paired_device(home) {
  const device = await software_device(MACHINE), passkey = software_passkey('codiscuss.pages.dev');
  const { code } = start_pairing(home, { site: SITE });
  const answer = await device_command(home, { site: SITE, machine_id: MACHINE, device_id: null }, 'device-pair', pairing_request(code, device, passkey));
  assert.equal(answer.status, 200, answer.body.error);
  return Object.assign(device, { passkey });
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

test('a browser pairs only with a live code shown at the computer, with a passkey made for that pairing', async t => {
  const home = home_dir(t);
  const device = await software_device(), stranger = await software_device(), passkey = software_passkey('codiscuss.pages.dev');
  const { code, url } = start_pairing(home, { site: SITE, fingerprint: 'f'.repeat(32) });
  assert.match(url, /#pair=[0-9A-Z]{12}&fp=f{32}$/, 'the QR link carries the computer key fingerprint');
  const context = { site: SITE, machine_id: MACHINE, device_id: null };
  for (let attempt = 0; attempt < 5; attempt++) {
    const wrong = await device_command(home, context, 'device-pair', pairing_request('AAAAAAAAAAAA', stranger, passkey));
    assert.equal(wrong.status, 400);
  }
  const late = await device_command(home, context, 'device-pair', pairing_request(code, device, passkey));
  assert.match(late.body.error, /配对码不对或已过期/, 'five wrong proofs use the code up');
  // A proof made for another computer, a passkey made for another pairing, or none at all, does not pair.
  const fresh = start_pairing(home, { site: SITE }).code;
  assert.equal((await device_command(home, context, 'device-pair', pairing_request(fresh, device, passkey, 'other-machine'))).status, 400);
  const elsewhere = { ...pairing_request(fresh, device, passkey), passkey: passkey.create(pairing_passkey_challenge('BBBBBBBBBBBB', device.public_key), SITE) };
  assert.match((await device_command(home, context, 'device-pair', elsewhere)).body.error, /挑战/);
  const another = start_pairing(home, { site: SITE }).code;
  const { passkey: missing, ...without } = pairing_request(another, device, passkey);
  assert.match((await device_command(home, context, 'device-pair', without)).body.error, /通行密钥/);
});

test('no relayed action can start a pairing: new devices are added only at the computer', async t => {
  const home = home_dir(t);
  const device = await paired_device(home);
  for (const action of ['device-pairing', 'passkey-options', 'passkey-register']) {
    assert.equal((await device_command(home, { site: SITE, machine_id: MACHINE, device_id: device.id }, action, {})).status, 404, action);
  }
});

test('the website gets a device list signed by the computer, and a change is sent at once', async t => {
  const { generateKeyPairSync } = await import('node:crypto');
  const home = home_dir(t);
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const link = { id: MACHINE, sign_private_key: privateKey.export({ format: 'jwk' }) };
  let synced = 0;
  const device = await software_device(MACHINE), passkey = software_passkey('codiscuss.pages.dev');
  const { code } = start_pairing(home, { site: SITE });
  await device_command(home, { site: SITE, machine_id: MACHINE, device_id: null, on_change: () => { synced += 1; } }, 'device-pair', pairing_request(code, device, passkey));
  assert.equal(synced, 1);
  const { body, signature } = await signed_device_list(home, link);
  const key = await crypto.subtle.importKey('jwk', publicKey.export({ format: 'jwk' }), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  assert.ok(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, Buffer.from(signature, 'base64url'), new TextEncoder().encode(body)));
  const list = JSON.parse(body);
  assert.deepEqual(list.devices.map(item => [item.id, item.x]), [[device.id, device.public_key.x]]);
  assert.ok(!body.includes('passkey') && !body.includes('label'), 'only keys and expiry leave the computer');
});

test('only a paired device\'s signed request is opened; an unpaired browser may only pair', async t => {
  const home = home_dir(t);
  const device = await paired_device(home), stranger = await software_device();
  const open = (id, sealed) => open_signed_request(home, id, sealed, MACHINE);
  const opened = await open('id-1', await device.seal('id-1', { action: 'settings' }));
  assert.equal(opened.device_id, device.id);
  await assert.rejects(open('id-2', await device.seal('id-other', { action: 'settings' })), /签名无效/, 'a signature for another id');
  const tampered = await device.seal('id-3', { action: 'settings' });
  await assert.rejects(open('id-3', { ...tampered, body: tampered.body.replace('settings', 'launch') }), /签名无效/);
  await assert.rejects(open('id-4', await stranger.seal('id-4', { action: 'settings' })), /未配对/);
  await assert.rejects(open('id-5', { body: JSON.stringify({ action: 'settings' }) }), /还没有与电脑配对/);
  assert.equal((await open('id-6', { body: JSON.stringify({ action: 'device-pair' }) })).device_id, null);
  await assert.rejects(open('id-7', { action: 'settings', payload: {} }), /请更新网页/, 'an old unsigned page is refused');
  // A request signed for one paired computer is refused by another.
  await assert.rejects(open_signed_request(home, 'id-9', await device.seal('id-9', { action: 'settings' }), 'other-machine'), /另一台电脑/);
  // A revoked device is refused at once.
  await device_command(home, { site: SITE, device_id: device.id }, 'device-revoke', { device_id: device.id });
  await assert.rejects(open('id-8', await device.seal('id-8', { action: 'settings' })), /未配对或已被撤销/);
});

test('remote writing in a room needs this device\'s passkey confirmation, for that room only', async t => {
  const home = home_dir(t);
  const device = await paired_device(home);
  const context = { site: SITE, machine_id: MACHINE, device_id: device.id };
  const passkey = device.passkey;
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

test('bringing back, approving tools for, forking or enabling writers needs the grant, judged from this computer\'s config', async t => {
  const { writeFileSync } = await import('node:fs');
  const { remote_write_room } = await import('../runner/discussion_launch.mjs');
  const home = home_dir(t);
  const config = (room, participants, extra = {}) => {
    const path = join(home, `${room}.json`);
    writeFileSync(path, JSON.stringify({ site: 'http://127.0.0.1:8765', room, token: 't', participants, ...extra }));
    return path;
  };
  writeFileSync(join(home, 'rooms.json'), JSON.stringify({ configs: [
    config('writes', { Claude: { project_access: 'write' }, Codex: { project_access: 'read' } }),
    config('room-wide', { Claude: {} }, { project_access: 'auto' }),
    config('reads', { Codex: { project_access: 'read' } }),
  ] }));
  assert.equal(remote_write_room(home, 'room-member', { room_id: 'writes', action: 'rejoin', name: 'Claude' }), 'writes');
  assert.equal(remote_write_room(home, 'room-member', { room_id: 'writes', action: 'rejoin', name: 'Codex' }), null);
  assert.equal(remote_write_room(home, 'room-member-allow', { room_id: 'room-wide', name: 'Claude', rules: ['Bash(git:*)'] }), 'room-wide', 'a room-wide level counts');
  assert.equal(remote_write_room(home, 'room-fork', { room_id: 'new', source_room_id: 'writes' }), 'writes');
  assert.equal(remote_write_room(home, 'room-fork', { room_id: 'new', source_room_id: 'reads' }), null);
  assert.equal(remote_write_room(home, 'room-workflow', { room_id: 'reads', action: 'back' }), null);
  assert.throws(() => remote_write_room(home, 'room-workflow', { room_id: 'reads', action: 'host' }), /只能在电脑上开启/);
});

test('a remote request cannot claim a session\'s own access, and any tool approval needs the write grant', async t => {
  const { remote_write_room } = await import('../runner/discussion_launch.mjs');
  const home = home_dir(t);
  const options = { projects: [], participants: {}, home, write_allowed: () => false, write_needed: room => Object.assign(new Error('need'), { need: 'write-grant', room_id: room }) };
  assert.throws(() => guard_remote_request('start', { participants: { Codex: { project_access: 'own' } } }, options), /own/);
  assert.throws(() => guard_remote_request('room-member', { room_id: 'r', name: 'Claude', action: 'add', allowed_tools: ['Bash'] }, options), error => error.need === 'write-grant');
  // Approving a tool for a read-only member widens it too.
  assert.equal(remote_write_room(home, 'room-member-allow', { room_id: 'r', name: 'Claude', rules: ['Bash'] }), 'r');
});

test('remote rooms take no tool approvals saved on this computer', async t => {
  const { writeFileSync } = await import('node:fs');
  const { participant_profile } = await import('../runner/discussion_launch.mjs');
  const home = home_dir(t);
  // Every member's profile is built in one place, so the rule holds however the members were named.
  const executable = join(home, 'codex.exe');
  writeFileSync(executable, '');
  const defaults = { Codex: { adapter: 'codex_cli', executable, allowed_tools: ['Bash'] } };
  for (const name of ['Codex', 'Codex-2']) {
    assert.equal(participant_profile(name, defaults, { without_saved_tools: true }, false).allowed_tools, undefined, `${name} takes no saved approvals`);
    assert.deepEqual(participant_profile(name, defaults, {}, false).allowed_tools, ['Bash'], 'a launch from this computer keeps them');
  }
});



test('the computer records trust changes and remote writes for the device list, never content', async t => {
  const { recent_audit } = await import('../runner/device_auth.mjs');
  const home = home_dir(t);
  const device = await paired_device(home);
  await device_command(home, { site: SITE, device_id: device.id }, 'device-revoke', { device_id: device.id });
  const events = recent_audit(home).map(entry => [entry.event, entry.device ?? null]);
  assert.deepEqual(events.slice(0, 3), [['device.revoked', device.id], ['device.paired', device.id], ['pairing.started', null]]);
  assert.ok(!JSON.stringify(recent_audit(home)).includes('proof'), 'no secrets or content are kept');
});

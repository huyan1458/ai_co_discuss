import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { channel_command, CHANNELS, notice_sent, send_notice } from '../runner/channels.mjs';

/** A ready fake channel that records what it sent, or fails every send. */
function fake(id, failing = false) {
  const sent = [];
  return { sent, channel: { id, label: id, fields: [], bound: () => true, ready: () => true, status: () => ({ bound: true, ready: true }),
    deliver: async (_home, text) => { if (failing) throw new Error(`${id} down`); sent.push(text); return [`${id}-1`]; },
    receive: async () => {}, command: async () => null, not_ready: '' } };
}

test('a notice goes once to the primary channel, and to the next one in order only when the primary fails', async t => {
  const home = mkdtempSync(join(tmpdir(), 'codiscuss-channels-'));
  const first = fake('fake_first', true), second = fake('fake_second'), third = fake('fake_third');
  const saved = CHANNELS.splice(0, CHANNELS.length, first.channel, second.channel, third.channel);
  t.after(() => { CHANNELS.splice(0, CHANNELS.length, ...saved); rmSync(home, { recursive: true, force: true }); });

  const notice = { key: 'site/room-a/question-1-v1', room: { site: 's', room: 'room-a', title: 'A' }, paragraphs: ['问题'] };
  assert.equal((await send_notice(home, notice)).channel, 'fake_second', 'the failing primary falls back to the next channel');
  assert.equal(third.sent.length, 0, 'later channels are not used once one succeeds');
  assert.equal(notice_sent(home, notice.key), true);
  assert.equal((await send_notice(home, notice)).status, 'duplicate');

  await channel_command(home, { action: 'arrange', order: ['fake_third', 'fake_first', 'fake_second'], enabled: ['fake_third', 'fake_second'] });
  const { channels } = await channel_command(home, {});
  assert.deepEqual(channels.map(item => [item.id, item.enabled, item.primary]),
    [['fake_third', true, true], ['fake_first', false, false], ['fake_second', true, false]]);
  assert.equal((await send_notice(home, { ...notice, key: 'k2' })).channel, 'fake_third', 'the first enabled channel is the primary');
});

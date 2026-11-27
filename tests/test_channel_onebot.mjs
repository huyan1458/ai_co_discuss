import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { channel_command, receive_replies, send_notice } from '../runner/channels.mjs';
import { message_parts } from '../runner/channel_onebot.mjs';

const OWNER = 10001, STRANGER = 10002, SELF = 20002;

/** A OneBot 11 server in memory: answers actions by echo, and pushes events to the open event connection. */
class FakeSocket extends EventTarget {
  static sockets = [];
  static sent = [];
  static next_id = 500;
  constructor(url) {
    super();
    this.url = url;
    FakeSocket.sockets.push(this);
    queueMicrotask(() => this.dispatchEvent(new Event('open')));
  }
  send(raw) {
    const { action, params, echo } = JSON.parse(raw);
    const data = action === 'get_login_info' ? { user_id: SELF, nickname: 'bot' }
      : (FakeSocket.sent.push(params), { message_id: FakeSocket.next_id++ });
    queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ status: 'ok', retcode: 0, data, echo }) })));
  }
  close() { if (!this.closed) { this.closed = true; this.dispatchEvent(new Event('close')); } }
  static push(event) {
    for (const socket of FakeSocket.sockets.filter(item => !item.closed)) socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(event) }));
  }
}

const private_message = (user_id, message) => ({ post_type: 'message', message_type: 'private', user_id, time: Math.floor(Date.now() / 1000) + 1, message });

test('OneBot: the token rides in the URL, the first sender of the code is the owner, and a quoted reply reaches its room', async t => {
  const home = mkdtempSync(join(tmpdir(), 'codiscuss-onebot-'));
  const original = globalThis.WebSocket;
  globalThis.WebSocket = FakeSocket;
  const controller = new AbortController();
  t.after(() => { controller.abort(); globalThis.WebSocket = original; rmSync(home, { recursive: true, force: true }); });

  const configured = await channel_command(home, { channel: 'onebot', action: 'configure', values: { url: 'ws://127.0.0.1:3001', token: 'tok' } });
  assert.match(FakeSocket.sockets[0].url, /access_token=tok/);
  assert.equal(JSON.stringify(configured).includes('tok"'), false, 'the status never returns the token');
  await channel_command(home, { action: 'arrange', order: ['onebot'], enabled: ['onebot'] });

  const posted = [];
  receive_replies(home, { signal: controller.signal, on_reply: async target => { posted.push(target); return '已发到房间'; } });
  await delay(20);
  FakeSocket.push(private_message(STRANGER, [{ type: 'text', data: { text: '000000000' } }]));
  FakeSocket.push(private_message(OWNER, [{ type: 'text', data: { text: configured.bind_code } }]));
  await delay(20);
  assert.equal((await channel_command(home, { channel: 'onebot' })).owner_bound, true);

  const first = await send_notice(home, { key: 'q1', room: { site: 's', room: 'room-a', title: 'A' }, question: { id: 1, version: 1 }, paragraphs: ['问题一'] });
  await send_notice(home, { key: 'q2', room: { site: 's', room: 'room-b', title: 'B' }, paragraphs: ['问题二'] });
  assert.equal(first.channel, 'onebot');
  assert.equal(FakeSocket.sent[0].user_id, OWNER, 'notices go to the owner privately');
  const first_id = String(FakeSocket.next_id - 2);

  FakeSocket.push(private_message(STRANGER, '1'));
  FakeSocket.push(private_message(OWNER, `[CQ:reply,id=${first_id}]1`));
  await delay(30);
  assert.deepEqual(posted.map(item => [item.room, item.text, item.question_id]), [['room-a', '1', 1]], 'only the owner, routed by the quoted notice');
});

test('OneBot message parts read segments and CQ strings alike', () => {
  assert.deepEqual(message_parts([{ type: 'reply', data: { id: 7 } }, { type: 'text', data: { text: ' 好 ' } }]), { text: '好', quoted: [{ id: '7', text: '' }], media: false });
  assert.deepEqual(message_parts('[CQ:reply,id=-9]&#91;选&#93; A'), { text: '[选] A', quoted: [{ id: '-9', text: '' }], media: false });
  assert.equal(message_parts('[CQ:image,file=x.jpg]').media, true);
});

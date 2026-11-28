import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { channel_command, receive_replies, send_notice } from '../runner/channels.mjs';
import { message_parts, onebot_channel } from '../runner/channel_onebot.mjs';
import { moss_group_command } from '../runner/discussion_launch.mjs';

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
    let data, retcode = 0;
    if (action === 'get_login_info') data = { user_id: SELF, nickname: 'bot' };
    else if (action === 'get_group_list') data = [401, 402, 403, 404].map(group_id => ({ group_id, group_name: `测试群${group_id}`, member_count: 2 }));
    else if (action === 'get_group_member_list') {
      if (params.group_id === 401) data = [{ user_id: SELF }, { user_id: OWNER }];
      if (params.group_id === 402) data = [{ user_id: SELF }, { user_id: STRANGER }];
      if (params.group_id === 403) retcode = 100;
      if (params.group_id === 404) data = [{ user_id: SELF }];
    } else { FakeSocket.sent.push(params); data = { message_id: FakeSocket.next_id++ }; }
    queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ status: retcode ? 'failed' : 'ok', retcode, data, echo }) })));
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
  const onebot_status = (await channel_command(home)).channels.find(item => item.id === 'onebot');
  assert.equal(onebot_status.account_id, String(SELF));
  assert.equal(onebot_status.owner_bound, false);
  assert.equal(Object.hasOwn(onebot_status, 'token'), false);

  const posted = [];
  const groups = [];
  receive_replies(home, { signal: controller.signal, on_reply: async target => { posted.push(target); return '已发到房间'; },
    on_group: async (channel, item) => groups.push({ channel: channel.id, ...item }) });
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
  const group_message = (user_id, message_id, message) => ({ post_type: 'message', message_type: 'group',
    group_id: 401, user_id, message_id, message, sender: { nickname: '同名' } });
  FakeSocket.push(group_message(STRANGER, 301, [{ type: 'at', data: { qq: SELF } }, { type: 'text', data: { text: '问一下' } }]));
  FakeSocket.push(group_message(OWNER, 302, `[CQ:reply,id=301][CQ:at,qq=${SELF}]看看`));
  FakeSocket.push(group_message(SELF, 303, '消息不能回环'));
  FakeSocket.push(group_message(STRANGER, 304, '[CQ:image,file=x.jpg]'));
  await delay(30);
  assert.deepEqual(groups.map(item => [item.channel, item.chat.id, item.sender.id, item.owner, item.mentioned, item.text]),
    [['onebot', '401', String(STRANGER), false, true, '问一下'], ['onebot', '401', String(OWNER), true, true, '看看']]);
  assert.deepEqual(groups[1].quoted, [{ id: '301', text: '' }]);
  const listed = (await moss_group_command(home, { action: 'groups', channel: 'onebot' })).groups;
  assert.deepEqual(listed.map(({ id, title }) => [id, title]), ['401', '402', '403', '404'].map(id => [id, `测试群${id}`]));
  assert.equal(listed[0].owner_in_group, true);
  assert.equal(listed[1].owner_in_group, false);
  assert.ok(listed.slice(2).every(group => !Object.hasOwn(group, 'owner_in_group')));
  assert.ok((await onebot_channel.groups(home, { check_owner: false })).every(group => !Object.hasOwn(group, 'owner_in_group')));
  const count = FakeSocket.sent.length;
  await onebot_channel.deliver(home, '答复', { chat: { kind: 'group', id: '401' }, reply_to: '301', mention: String(OWNER) });
  assert.equal(FakeSocket.sent.length, count + 1);
  assert.deepEqual(FakeSocket.sent.at(-1), { group_id: 401, message: [
    { type: 'reply', data: { id: '301' } }, { type: 'at', data: { qq: String(OWNER) } }, { type: 'text', data: { text: '答复' } }] });
  const path = join(home, 'media');
  writeFileSync(path, 'abc');
  const options = { chat: { kind: 'group', id: '401' }, reply_to: '301' };
  for (const type of ['image', 'file']) {
    await onebot_channel.deliver(home, '', { ...options, media: [{ path, name: 'file.txt', type }] });
    assert.deepEqual(FakeSocket.sent.at(-1), { group_id: 401, message: [
      { type: 'reply', data: { id: '301' } }, { type, data: { file: 'base64://YWJj', ...(type === 'file' ? { name: 'file.txt' } : {}) } }] });
  }
});

test('OneBot message parts read segments and CQ strings alike', () => {
  assert.deepEqual(message_parts([{ type: 'reply', data: { id: 7 } }, { type: 'text', data: { text: ' 好 ' } }]), { text: '好', quoted: [{ id: '7', text: '' }], media: false });
  assert.deepEqual(message_parts('[CQ:reply,id=-9]&#91;选&#93; A'), { text: '[选] A', quoted: [{ id: '-9', text: '' }], media: false });
  assert.equal(message_parts('[CQ:image,file=x.jpg]').media, true);
});

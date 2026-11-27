import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';

import { channel_command, receive_replies, send_notice } from '../runner/channels.mjs';
import { qq_channel } from '../runner/channel_qq.mjs';

const ACCOUNT_SECRET = 'test-qq-only-secret';
const CREDENTIALS = { app_id: 'test-qq-app', app_secret: ACCOUNT_SECRET };
const GATEWAY_URL = 'wss://qq.test/gateway';

class FakeSocket extends EventTarget {
  static opened;
  readyState = 1;
  transmitted = [];
  sequence = 0;

  constructor(url) {
    super();
    assert.equal(url, GATEWAY_URL);
    FakeSocket.opened(this);
  }

  send(data) { this.transmitted.push(JSON.parse(data)); }
  close() { this.readyState = 3; }

  packet(packet) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(packet) }));
  }

  message(id, sender, content, extra = {}, type = 'C2C_MESSAGE_CREATE') {
    this.packet({ op: 0, t: type, s: ++this.sequence, d: { id, author: { user_openid: sender }, content, ...extra } });
  }
}

function mock_qq() {
  const outgoing = [];
  let failure = null;
  const fetch_impl = async (input, options) => {
    const url = new URL(input);
    if (url.hostname === 'bots.qq.com') {
      assert.deepEqual(JSON.parse(options.body), { appId: CREDENTIALS.app_id, clientSecret: ACCOUNT_SECRET });
      return Response.json({ access_token: 'test-qq-token', expires_in: 7200 });
    }
    assert.equal(url.hostname, 'api.sgroup.qq.com');
    assert.equal(options.headers.Authorization, 'QQBot test-qq-token');
    if (url.pathname === '/gateway') return Response.json({ url: GATEWAY_URL });
    const index = outgoing.push({ path: url.pathname, body: JSON.parse(options.body) });
    return failure ? Response.json(failure, { status: 403 }) : Response.json({ id: `m${index}`, ext_info: { ref_idx: `ref${index}` } });
  };
  return { fetch_impl, outgoing, fail: value => { failure = value; } };
}

async function connect(t, on_reply) {
  const home = mkdtempSync(join(tmpdir(), 'codiscuss-qq-test-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const transport = mock_qq();
  const { fetch_impl } = transport;
  const configured = await channel_command(home, { channel: 'qq', action: 'configure', values: CREDENTIALS, fetch_impl });
  assert.equal(configured.bound, true);
  assert.equal(configured.owner_bound, false);
  assert.equal(configured.ready, false);
  assert.ok(configured.bind_code);
  assert.ok(!JSON.stringify(configured).includes(ACCOUNT_SECRET));
  if (process.platform !== 'win32') assert.equal(statSync(join(home, 'qq/account.json')).mode & 0o777, 0o600);
  const opening = Promise.withResolvers();
  FakeSocket.opened = opening.resolve;
  const original = globalThis.WebSocket;
  globalThis.WebSocket = FakeSocket;
  const controller = new AbortController();
  const receiving = receive_replies(home, { on_reply, fetch_impl, signal: controller.signal });
  t.after(async () => {
    controller.abort();
    await receiving;
    globalThis.WebSocket = original;
  });
  const socket = await opening.promise;
  await setImmediate();
  socket.packet({ op: 10, d: { heartbeat_interval: 60000 } });
  assert.equal(socket.transmitted[0]?.op, 2);
  assert.equal(socket.transmitted[0]?.d.intents, 1 << 25);
  socket.packet({ op: 0, t: 'READY', s: 0, d: { session_id: 'qq-test-session' } });
  return { home, socket, ...transport, code: configured.bind_code };
}

test('QQ binds only the first exact C2C challenge, sends a proactive notice and routes a quoted reply', { timeout: 5000 }, async t => {
  const replies = [];
  const ctx = await connect(t, item => { replies.push(item); return 'saved'; });
  const { home, socket, fetch_impl, outgoing, code } = ctx;
  socket.message('group', 'outsider', code, {}, 'GROUP_AT_MESSAGE_CREATE');
  socket.message('wrong', 'outsider', ` ${code}`);
  socket.message('bind', 'owner', code);
  socket.message('second', 'outsider', code);
  await setImmediate();
  assert.equal(qq_channel.status(home).bind_code, '');
  assert.equal(qq_channel.status(home).owner_bound, true);
  assert.equal(outgoing.length, 1);
  assert.equal(outgoing[0].path, '/v2/users/owner/messages');
  assert.equal(outgoing[0].body.msg_id, 'bind');

  const ids = await qq_channel.deliver(home, 'probe', { fetch_impl });
  assert.deepEqual(ids, ['m2', 'ref2']);
  assert.deepEqual(outgoing[1].body, { content: 'probe', msg_type: 0 });

  const first = { site: 'https://room.test', room: 'first', title: 'First' };
  await send_notice(home, { key: '1', only: 'qq', room: first, paragraphs: ['First'], question: { id: 9, version: 3 } }, { fetch_impl });
  await send_notice(home, { key: '2', only: 'qq', room: { ...first, room: 'second' }, paragraphs: ['Second'] }, { fetch_impl });
  socket.message('irrelevant', 'outsider', '2');
  socket.message('bind', 'owner', code);
  socket.message('reply', 'owner', '1', { message_scene: { ext: ['ref_msg_idx=ref3'] } });
  await setImmediate();
  assert.deepEqual(replies, [{ site: first.site, room: first.room, text: '1', question_id: 9, version: 3 }]);
  assert.equal(outgoing.at(-1).body.msg_id, 'reply');

  const unbound = await channel_command(home, { channel: 'qq', action: 'unbind' });
  assert.equal(unbound.bound, false);
  socket.message('after-unbind', 'owner', '3');
  await setImmediate();
  assert.equal(replies.length, 1);
});

test('QQ persists provider rejection code and detail, and clears the failure after recovery', { timeout: 5000 }, async t => {
  const { home, socket, code, fetch_impl, fail } = await connect(t, () => {});
  socket.message('bind', 'owner', code);
  await setImmediate();
  fail({ code: 22009, message: 'proactive denied', trace: ACCOUNT_SECRET });
  await assert.rejects(qq_channel.deliver(home, 'probe', { fetch_impl }), { code: 22009, message: 'proactive denied' });
  const { last_failure } = qq_channel.status(home);
  assert.equal(last_failure.code, 22009);
  assert.equal(last_failure.detail, 'proactive denied');
  assert.match(last_failure.message, /HTTP 403/);
  assert.ok(last_failure.at > 0);
  assert.ok(!JSON.stringify(last_failure).includes(ACCOUNT_SECRET));
  fail(null);
  await qq_channel.deliver(home, 'retry', { fetch_impl });
  assert.equal(qq_channel.status(home).last_failure, null);
});

test('QQ reconnects with the prior session and sequence', { timeout: 5000 }, async t => {
  const { socket, code } = await connect(t, () => {});
  socket.message('bind', 'owner', code);
  await setImmediate();
  const reconnecting = Promise.withResolvers();
  FakeSocket.opened = reconnecting.resolve;
  socket.packet({ op: 7 });
  const reconnected = await reconnecting.promise;
  await setImmediate();
  reconnected.packet({ op: 10, d: { heartbeat_interval: 60000 } });
  assert.equal(socket.readyState, 3);
  assert.deepEqual(reconnected.transmitted[0], {
    op: 6, d: { token: 'QQBot test-qq-token', session_id: 'qq-test-session', seq: 1 },
  });
});

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { feishu_channel } from '../runner/channel_feishu.mjs';
import { receive_replies, send_notice } from '../runner/channels.mjs';
import { decode_frame, encode_frame } from '../runner/vendor/larksuite-ws/frame.mjs';

const VALUES = { app_id: 'cli_test', app_secret: 'test-app-secret' };
const OWNER = 'ou_owner';
const OTHER = 'ou_other';

async function eventually(predicate) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await sleep(10);
  }
  assert.fail('Timed out waiting for Feishu event');
}

function test_home(context) {
  const home = mkdtempSync(join(tmpdir(), 'codiscuss-feishu-'));
  context.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

function fake_api() {
  const state = { token_calls: 0, sent: [], reject: false };
  state.fetch = async (url, request) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(request.body);
    if (path === '/open-apis/auth/v3/tenant_access_token/internal') {
      state.token_calls++;
      return Response.json({ code: 0, tenant_access_token: 'tenant-test-token', expire: 7200 });
    }
    if (path === '/callback/ws/endpoint') {
      assert.deepEqual(body, { AppID: VALUES.app_id, AppSecret: VALUES.app_secret });
      return Response.json({ code: 0, data: { URL: 'wss://test.example/ws?service_id=7', ClientConfig: {} } });
    }
    assert.equal(path, '/open-apis/im/v1/messages');
    assert.equal(request.headers.Authorization, 'Bearer tenant-test-token');
    assert.equal(body.receive_id, OWNER);
    if (state.reject) return Response.json({ code: 230013, msg: 'user not in visibility range' });
    const id = `om_sent_${state.sent.length + 1}`;
    state.sent.push({ id, text: JSON.parse(body.content).text });
    return Response.json({ code: 0, data: { message_id: id } });
  };
  return state;
}

function fake_websocket() {
  const sockets = [];
  class FakeWebSocket extends EventTarget {
    constructor(url) {
      super();
      assert.equal(new URL(url).searchParams.get('service_id'), '7');
      this.sent = [];
      this.readyState = 0;
      sockets.push(this);
      queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); });
    }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
    send(bytes) { this.sent.push(decode_frame(bytes)); }
  }
  return { FakeWebSocket, sockets };
}

function event_message(sender, text, message_id, { parent_id, chat_type = 'p2p' } = {}) {
  return { header: { event_type: 'im.message.receive_v1' }, event: {
    sender: { sender_type: 'user', sender_id: { open_id: sender } }, message: {
      message_id, parent_id, chat_type, message_type: 'text', content: JSON.stringify({ text }),
    },
  } };
}

function emit_event(socket, event, fragmented = false) {
  const payload = Buffer.from(JSON.stringify(event));
  const id = event.event.message.message_id;
  const middle = Math.floor(payload.length / 2);
  const parts = fragmented ? [payload.subarray(0, middle), payload.subarray(middle)] : [payload];
  for (let seq = parts.length - 1; seq >= 0; seq--) {
    const headers = Object.entries({ type: 'event', message_id: id, seq: String(seq), sum: String(parts.length) })
      .map(([key, value]) => ({ key, value }));
    socket.dispatchEvent(new MessageEvent('message', { data: encode_frame({
      SeqID: 9_007_199_254_740_999n, LogID: 2n, method: 1, service: 7, headers, payload: parts[seq],
    }) }));
  }
}

test('Feishu binds only the first exact private code, routes quotes, and records delivery failures', async context => {
  const home = test_home(context);
  const api = fake_api();
  const replies = [];
  const { FakeWebSocket, sockets } = fake_websocket();
  const configured = await feishu_channel.command(home, 'configure', { values: VALUES, fetch_impl: api.fetch });
  assert.match(configured.bind_code, /^\d{6}$/);
  assert.equal(configured.owner_bound, false);
  assert.ok(!JSON.stringify(configured).includes(VALUES.app_secret));
  if (process.platform !== 'win32') assert.equal(statSync(join(home, 'feishu', 'account.json')).mode & 0o777, 0o600);
  const original_websocket = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket;
  context.after(() => { globalThis.WebSocket = original_websocket; });
  const controller = new AbortController();
  const listening = receive_replies(home, { fetch_impl: api.fetch, signal: controller.signal,
    on_reply: async item => { replies.push(item); return ''; } });
  try {
    await eventually(() => sockets[0]?.sent.length);
    const socket = sockets[0];
    assert.deepEqual(socket.sent[0].headers, [{ key: 'type', value: 'ping' }]);
    emit_event(socket, event_message(OTHER, configured.bind_code, 'group', { chat_type: 'group' }));
    emit_event(socket, event_message(OTHER, ` ${configured.bind_code}`, 'wrong'));
    assert.equal(feishu_channel.ready(home), false);
    const binding = event_message(OWNER, configured.bind_code, 'bind');
    emit_event(socket, binding);
    emit_event(socket, binding);
    emit_event(socket, event_message(OTHER, configured.bind_code, 'second'));
    assert.equal(feishu_channel.status(home).bind_code, '');
    assert.equal(feishu_channel.ready(home), true);
    assert.deepEqual(await feishu_channel.deliver(home, 'text', { fetch_impl: api.fetch }), ['om_sent_1']);
    const notice = (room, key) => send_notice(home, { only: 'feishu', key, room: { site: 'local', room },
      paragraphs: [room], question: { id: 47, version: 2 } }, { fetch_impl: api.fetch });
    await notice('older', 'one');
    await notice('latest', 'two');
    assert.equal(api.token_calls, 1);
    emit_event(socket, event_message(OTHER, '3', 'intruder', { parent_id: 'om_sent_2' }));
    const reply = event_message(OWNER, '1', 'reply', { parent_id: 'om_sent_2' });
    emit_event(socket, reply, true);
    emit_event(socket, reply);
    await eventually(() => socket.sent.some(frame => frame.headers.some(header => header.value === 'reply')));
    assert.deepEqual(replies, [{ site: 'local', room: 'older', text: '1', question_id: 47, version: 2 }]);
    const ack = socket.sent.find(frame => frame.headers.some(header => header.value === 'reply'));
    assert.equal(ack.SeqID, 9_007_199_254_740_999n);
    assert.deepEqual(JSON.parse(ack.payload), { code: 200 });
    api.reject = true;
    await assert.rejects(feishu_channel.deliver(home, 'denied', { fetch_impl: api.fetch }), { code: 230013 });
    const failure = feishu_channel.status(home).last_failure;
    assert.equal(failure.code, 230013);
    assert.equal(failure.detail, 'user not in visibility range');
    assert.ok(failure.at > 0 && failure.message);
    assert.equal((await feishu_channel.command(home, 'unbind')).bound, false);
  } finally {
    controller.abort();
    await listening;
  }
});

test('Feishu protobuf ping uses the SDK wire field numbers and wire types', () => {
  const frame = Buffer.from('08001000180720002a0c0a0474797065120470696e67', 'hex');
  assert.deepEqual(decode_frame(frame), { SeqID: 0n, LogID: 0n, service: 7, method: 0,
    headers: [{ key: 'type', value: 'ping' }] });
  assert.deepEqual(encode_frame(decode_frame(frame)), frame);
});

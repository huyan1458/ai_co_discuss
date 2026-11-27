import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { discord_channel } from '../runner/channel_discord.mjs';
import { receive_replies, send_notice } from '../runner/channels.mjs';

class FakeSocket extends EventTarget {
  static current;
  static sent = [];
  readyState = 1;
  constructor() {
    super();
    FakeSocket.current = this;
    queueMicrotask(() => this.frame(10, { heartbeat_interval: 60_000 }));
  }
  frame(op, d, t, s) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ op, d, t, s }) })); }
  send(data) { FakeSocket.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; }
}

test('Discord binds once, routes an old quote, resumes Gateway and records provider failure', async () => {
  const home = mkdtempSync(join(tmpdir(), 'codiscuss-discord-'));
  const controller = new AbortController();
  const sent = [];
  const routed = [];
  let throttle = true;
  let failure = false;
  let receiving;
  const fetch_impl = async (url, init) => {
    if (url.endsWith('/users/@me')) return Response.json({ username: 'bot' });
    if (url.endsWith('/users/@me/channels')) {
      assert.equal(JSON.parse(init.body).recipient_id, 'owner');
      return Response.json({ id: 'dm' });
    }
    assert.match(url, /\/channels\/dm\/messages$/);
    if (throttle) {
      throttle = false;
      return Response.json({ retry_after: 0, message: 'rate limited' }, { status: 429 });
    }
    if (failure) return Response.json({ code: 50007, message: 'Cannot send messages to this user' }, { status: 403 });
    sent.push(JSON.parse(init.body));
    return Response.json({ id: String(sent.length) });
  };
  const options = { signal: controller.signal, fetch_impl, websocket_impl: FakeSocket };
  let sequence = 1;
  const message = (sender, content, reference, guild_id) => FakeSocket.current.frame(0, {
    author: { id: sender }, channel_id: 'dm', guild_id, timestamp: new Date().toISOString(), content,
    ...(reference ? { message_reference: { message_id: reference } } : {}),
  }, 'MESSAGE_CREATE', ++sequence);
  try {
    const status = await discord_channel.command(home, 'configure', { values: { token: 'fake.token' }, fetch_impl });
    assert.equal(JSON.stringify(status).includes('fake.token'), false);
    receiving = receive_replies(home, { ...options, on_reply: value => { routed.push(value); return 'receipt'; } });
    await delay(5);
    assert.equal(FakeSocket.sent[0].op, 2);
    FakeSocket.current.frame(0, { session_id: 'session', resume_gateway_url: 'wss://gateway.discord.gg' }, 'READY', sequence);
    message('intruder', status.bind_code, null, 'guild');
    message('owner', status.bind_code);
    message('intruder', status.bind_code);
    for (let i = 0; i < 100 && !discord_channel.ready(home); i++) await delay(10);
    assert.equal(discord_channel.status(home).bind_code, '');
    assert.deepEqual(await discord_channel.deliver(home, 'direct', options), ['1']);
    await send_notice(home, { only: 'discord', room: { site: 'local', room: 'old' },
      question: { id: 21, version: 4 }, paragraphs: ['notice A'] }, options);
    await send_notice(home, { only: 'discord', room: { site: 'local', room: 'new' }, paragraphs: ['notice B'] }, options);
    message('intruder', 'bad', '2');
    message('owner', '2', '2');
    for (let i = 0; i < 100 && sent.length < 4; i++) await delay(10);
    assert.deepEqual(routed, [{ site: 'local', room: 'old', question_id: 21, version: 4, text: '2' }]);
    assert.equal(sent.at(-1).content, 'receipt');
    FakeSocket.current.frame(7);
    for (let i = 0; i < 200 && !FakeSocket.sent.some(item => item.op === 6); i++) await delay(10);
    assert.deepEqual(FakeSocket.sent.find(item => item.op === 6)?.d, { token: 'fake.token', session_id: 'session', seq: sequence });
    failure = true;
    await assert.rejects(discord_channel.deliver(home, 'fail', options), { code: 50007 });
    const record = discord_channel.status(home).last_failure;
    assert.equal(record.code, 50007);
    assert.equal(record.detail, 'Cannot send messages to this user');
    assert.ok(record.at);
    assert.equal((await discord_channel.command(home, 'unbind')).bound, false);
  } finally {
    controller.abort();
    await receiving;
    rmSync(home, { recursive: true, force: true });
  }
});

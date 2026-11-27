import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { telegram_channel } from '../runner/channel_telegram.mjs';
import { receive_replies, send_notice } from '../runner/channels.mjs';

test('Telegram binds once, routes an old quoted notice, and records provider failure', async () => {
  const home = mkdtempSync(join(tmpdir(), 'codiscuss-telegram-'));
  const controller = new AbortController();
  let receiving;
  const updates = [];
  const sent = [];
  const routed = [];
  let failure = false;
  const fetch_impl = async (url, init) => {
    const method = url.split('/').at(-1);
    const body = JSON.parse(init.body);
    if (method === 'getMe') return Response.json({ ok: true, result: { username: 'example_bot' } });
    if (method === 'sendMessage') {
      if (failure) return Response.json({ ok: false, error_code: 403, description: 'blocked by user' }, { status: 403 });
      sent.push(body);
      return Response.json({ ok: true, result: { message_id: sent.length } });
    }
    assert.equal(method, 'getUpdates');
    await delay(10, undefined, { signal: init.signal });
    return Response.json({ ok: true, result: updates.filter(item => item.update_id >= (body.offset || 0)) });
  };
  const options = { fetch_impl, signal: controller.signal };
  const message = (sender, text, reference, type = 'private') => {
    updates.push({ update_id: updates.length + 1, message: {
      from: { id: sender }, chat: { id: sender, type }, date: Math.floor(Date.now() / 1000), text,
      ...(reference ? { reply_to_message: { message_id: reference } } : {}),
    } });
  };
  try {
    const status = await telegram_channel.command(home, 'configure', { values: { token: '123:fake' }, fetch_impl });
    assert.equal(JSON.stringify(status).includes('123:fake'), false);
    receiving = receive_replies(home, { ...options, on_reply: value => { routed.push(value); return 'receipt'; } });
    message(9, status.bind_code, null, 'group');
    message(10, status.bind_code);
    message(11, status.bind_code);
    for (let i = 0; i < 100 && !telegram_channel.ready(home); i++) await delay(10);
    assert.equal(telegram_channel.status(home).bind_code, '');
    assert.deepEqual(await telegram_channel.deliver(home, 'direct', options), ['1']);
    assert.equal(sent[0].chat_id, '10');
    await send_notice(home, { only: 'telegram', room: { site: 'local', room: 'old' },
      question: { id: 12, version: 3 }, paragraphs: ['notice A'] }, options);
    await send_notice(home, { only: 'telegram', room: { site: 'local', room: 'new' }, paragraphs: ['notice B'] }, options);
    message(11, 'bad', 2);
    message(10, '1', 2);
    for (let i = 0; i < 100 && sent.length < 4; i++) await delay(10);
    assert.deepEqual(routed, [{ site: 'local', room: 'old', question_id: 12, version: 3, text: '1' }]);
    assert.equal(sent.at(-1).text, 'receipt');
    message(10, 'unknown quote', 99);
    for (let i = 0; i < 100 && sent.length < 5; i++) await delay(10);
    assert.equal(sent.length, 5);
    assert.equal(routed.length, 1);
    failure = true;
    await assert.rejects(telegram_channel.deliver(home, 'fail', options), { code: 403 });
    assert.deepEqual(telegram_channel.status(home).last_failure,
      { at: telegram_channel.status(home).last_failure.at, code: 403, message: 'blocked by user', detail: 'blocked by user' });
    assert.equal((await telegram_channel.command(home, 'unbind')).bound, false);
  } finally {
    controller.abort();
    await receiving;
    rmSync(home, { recursive: true, force: true });
  }
});

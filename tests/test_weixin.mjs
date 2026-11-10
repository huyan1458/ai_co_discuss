import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { receive_replies, send_notice, weixin_status } from '../runner/weixin.mjs';

const ACCOUNT = { account_id: 'bot@im.bot', owner_id: 'owner@im.wechat', token: 'secret-token', base_url: 'https://ilinkai.weixin.qq.com' };

/** A bound home and a fake iLink that records sends and serves one batch of updates. */
function fixture(t, updates = []) {
  const home = mkdtempSync(join(tmpdir(), 'codiscuss-weixin-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, 'weixin'));
  writeFileSync(join(home, 'weixin', 'account.json'), JSON.stringify(ACCOUNT));
  const sent = [];
  const batches = [...updates];
  const fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.endsWith('/sendmessage')) { sent.push(body.msg.item_list[0].text_item.text); return reply({ ret: 0, message_id: '1' }); }
    if (url.endsWith('/getupdates')) {
      const batch = batches.shift();
      if (!batch) { fetch.controller.abort(); return reply({ msgs: [] }); }
      return reply({ msgs: batch, get_updates_buf: `cursor-${batches.length}` });
    }
    throw new Error(`unexpected ${url}`);
  };
  fetch.controller = new AbortController();
  return { home, sent, fetch };
}

const reply = value => ({ ok: true, text: async () => JSON.stringify(value) });
const owner_text = (text, quoted = '') => ({ message_type: 1, message_state: 2, from_user_id: ACCOUNT.owner_id, to_user_id: ACCOUNT.account_id,
  context_token: 'ctx-1', item_list: [{ type: 1, text_item: { text }, ...(quoted ? { ref_msg: { message_item: { text_item: { text: quoted } } } } : {}) }] });

test('a notice waits for the owner to message the bot, is sent once, and replies go back to its room', async t => {
  const { home, sent, fetch } = fixture(t, [[owner_text('你好')]]);
  const notice = { key: 'site/room-a/goal-1-pending-100', room: { site: 'http://127.0.0.1:8765', room: 'room-a', title: '登录页' }, text: '选 A 还是 B？' };
  assert.equal((await send_notice(home, notice, { fetch })).status, 'no_context', 'iLink needs a message from the owner first');
  const posted = [];
  const on_reply = async target => { posted.push(target); return '已发到房间'; };
  await receive_replies(home, { on_reply, signal: fetch.controller.signal, fetch_impl: fetch });
  assert.equal(weixin_status(home).context_ready, true);
  assert.equal(posted.length, 0, 'a message before any room notice has nowhere to go');
  assert.equal((await send_notice(home, notice, { fetch })).status, 'sent');
  assert.equal((await send_notice(home, notice, { fetch })).status, 'duplicate');
  assert.match(sent.at(-1), /^\[CoDiscuss #1\] 登录页\n选 A 还是 B？/);
  await send_notice(home, { key: 'other', room: { site: 'http://127.0.0.1:8765', room: 'room-b', title: '支付' }, text: '要不要上线？' }, { fetch });
  const batches = [[owner_text('选 A', '[CoDiscuss #1] 登录页\n选 A 还是 B？'), owner_text('先别上线')]];
  const replay = async (url, options) => url.endsWith('/getupdates')
    ? (batches.length ? reply({ msgs: batches.shift(), get_updates_buf: 'c2' }) : (controller.abort(), reply({ msgs: [] })))
    : fetch(url, options);
  const controller = new AbortController();
  await receive_replies(home, { on_reply, signal: controller.signal, fetch_impl: replay });
  assert.deepEqual(posted.map(item => [item.room, item.text]), [['room-a', '选 A'], ['room-b', '先别上线']],
    'a quoted notice picks its room; a plain reply goes to the latest notice');
  assert.equal(sent.at(-1), '已发到房间');
});

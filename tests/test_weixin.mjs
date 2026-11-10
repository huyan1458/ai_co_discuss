import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { receive_replies, send_notice, weixin_status } from '../runner/weixin.mjs';

const ACCOUNT = { account_id: 'bot@im.bot', owner_id: 'owner@im.wechat', token: 'secret-token', base_url: 'https://ilinkai.weixin.qq.com' };

/** A bound home and a fake iLink that records sends, numbers their message ids and serves batches of updates. */
function fixture(t, updates = []) {
  const home = mkdtempSync(join(tmpdir(), 'codiscuss-weixin-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, 'weixin'));
  writeFileSync(join(home, 'weixin', 'account.json'), JSON.stringify(ACCOUNT));
  const sent = [];
  const batches = [...updates];
  let next_id = 100;
  const controller = new AbortController();
  const fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.endsWith('/sendmessage')) { sent.push(body.msg.item_list[0].text_item.text); return reply({ ret: 0, message_id: String(next_id++) }); }
    if (url.endsWith('/getupdates')) {
      const batch = batches.shift();
      if (!batch) { controller.abort(); return reply({ msgs: [] }); }
      return reply({ msgs: batch, get_updates_buf: `cursor-${batches.length}` });
    }
    throw new Error(`unexpected ${url}`);
  };
  /** Deliver one more batch of the owner's messages and receive until it is handled. */
  const receive = async (on_reply, batch) => {
    batches.push(batch);
    const local = new AbortController();
    const relay = async (url, options) => {
      if (url.endsWith('/getupdates') && !batches.length) { local.abort(); return reply({ msgs: [] }); }
      return fetch(url, options);
    };
    await receive_replies(home, { on_reply, signal: local.signal, fetch_impl: relay });
  };
  return { home, sent, fetch, receive };
}

const reply = value => ({ ok: true, text: async () => JSON.stringify(value) });
const owner_text = (text, ref_msg = null) => ({ message_type: 1, message_state: 2, from_user_id: ACCOUNT.owner_id, to_user_id: ACCOUNT.account_id,
  context_token: 'ctx-1', item_list: [{ type: 1, text_item: { text }, ...(ref_msg ? { ref_msg } : {}) }] });
const room = (id, title) => ({ site: 'http://127.0.0.1:8765', room: id, title });

test('a notice waits for the owner to message the bot, is sent once, and replies go back to its room', async t => {
  const { home, sent, fetch, receive } = fixture(t);
  const notice = { key: 'site/room-a/goal-1-pending-100', room: room('room-a', '登录页'), paragraphs: ['主持人在等你确认：', '选 **A** 还是 B？'] };
  assert.equal((await send_notice(home, notice, { fetch })).status, 'no_context', 'iLink needs a message from the owner first');
  const posted = [];
  const on_reply = async target => { posted.push(target); return '已发到房间'; };
  await receive(on_reply, [owner_text('你好')]);
  assert.equal(weixin_status(home).context_ready, true);
  assert.equal(posted.length, 0, 'a message before any room notice has nowhere to go');
  assert.match(sent.at(-1), /^🔔 CoDiscuss 系统通知：\n\n/);
  assert.equal((await send_notice(home, notice, { fetch })).status, 'sent');
  assert.equal((await send_notice(home, notice, { fetch })).status, 'duplicate');
  assert.equal(sent.at(-1), '💬 CoDiscuss（登录页）：\n\n主持人在等你确认：\n\n选 A 还是 B？', 'source first, blank lines between parts, Markdown made plain');
  const first_id = String(99 + sent.length);
  await send_notice(home, { key: 'b', room: room('room-b', '支付'), paragraphs: ['要不要上线？'] }, { fetch });
  await send_notice(home, { key: 'c', room: room('room-c', '文档'), paragraphs: ['先写哪一章？'] }, { fetch });
  await receive(on_reply, [owner_text('选 A', { svr_id: first_id }), owner_text('上线吧', { message_item: { text_item: { text: '要不要上线？' } } }),
    owner_text('先写第一章')]);
  assert.deepEqual(posted.map(item => [item.room, item.text]), [['room-a', '选 A'], ['room-b', '上线吧'], ['room-c', '先写第一章']],
    'a quoted notice picks its room by message id or text; a plain reply goes to the latest notice');
  assert.equal(sent.at(-1), '🔔 CoDiscuss 系统通知：\n\n已发到房间');
});

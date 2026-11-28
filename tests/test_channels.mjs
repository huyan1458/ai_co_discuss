import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { channel_command, CHANNELS, flush_moss_channel_replies, moss_queue_receipts, moss_setup_text, notice_sent,
  receive_replies, route_moss_message, send_notice } from '../runner/channels.mjs';
import { post_steward_channel_message, steward_status } from '../runner/steward.mjs';

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

const MOSS_LOCALES = [
  ['zh-CN', '来源渠道：second', '已发给 MOSS。', 'MOSS 正在处理上一件事，你的消息已排队',
    '已把消息作为插话发给 MOSS。', 'MOSS 正在等你在网页回答一个问题，这条消息已排队', 'MOSS 尚未配置', '在网页查看完整回答'],
  ['en', 'Source channel: second', 'Sent to MOSS.', 'MOSS is still working on the previous request. Your message is queued.',
    'Your message was sent to MOSS as an interjection.', 'MOSS is waiting for you to answer a question on the website. Your message is queued.',
    'MOSS is not configured', 'Read the full reply on the website'],
];

for (const [locale, source, sent, queued, steered, question_queued, setup, full_reply] of MOSS_LOCALES) {
  test(`MOSS channel receipts, steering, and website-only approvals (${locale})`, async t => {
    const home = mkdtempSync(join(tmpdir(), 'codiscuss-moss-channel-'));
    const old_locale = process.env.CODISCUSS_LANG;
    process.env.CODISCUSS_LANG = locale;
    t.after(() => {
      if (old_locale === undefined) delete process.env.CODISCUSS_LANG;
      else process.env.CODISCUSS_LANG = old_locale;
      rmSync(home, { recursive: true, force: true });
    });
    const config = { site: 'http://site', room: 'moss-room' }, link = 'http://site/?moss=moss-room';
    const view = { title: 'MOSS', free: { requests: [], members: [], questions: [] } };
    const calls = [];
    let busy = false, long = false, raced = false;
    const request = async (_config, path, payload) => {
      if (!path) return view;
      if (path === '/messages/31') return { text: long ? 'x'.repeat(1700) : '**answer**\n\nverbatim' };
      if (path.startsWith('/messages?')) return { messages: busy ? [] : [{ id: 21 }] };
      calls.push({ path, payload });
      if (path === '/executions/10' && raced) throw new Error('HTTP 409 execution already ended');
      if (path === '/messages') return busy ? { queued: 40 } : { message: { id: 20 } };
      return {};
    };
    const receive = (channel = 'second') => route_moss_message(home, { config, channel, label: channel,
      text: 'original**\n/rooms-overview', request, post: post_steward_channel_message });
    assert.equal(await receive(), sent);
    assert.equal(calls[0].payload.text, `${source}\n\noriginal**\n/rooms-overview`);
    assert.equal(calls[0].payload.author, '用户');
    assert.equal(calls[0].payload.queue, true);
    view.free.requests.push({ message_id: 20, execution_id: 10 });
    view.free.members.push({ execution: { id: 10, status: 'started', capabilities: { steer: false } } });
    busy = true;
    assert.equal(await receive(), queued);
    view.free.members[0].execution.capabilities.steer = true;
    assert.equal(await receive(), steered);
    assert.equal(calls.at(-1).payload.action, 'interject');
    assert.equal(await receive('first'), queued);
    assert.equal(calls.at(-1).path, '/messages', 'different channel cannot take over a running turn');
    raced = true;
    assert.equal(await receive(), queued, 'finished execution races back to the queue');
    view.free.questions = [{ status: 'waiting_user', blocking: true }];
    raced = false;
    const before_approval = calls.length;
    assert.equal(await receive(), question_queued);
    assert.equal(calls.length, before_approval + 1);
    assert.equal(calls.at(-1).path, '/messages', 'skip steering and submit only an ordinary message');
    assert.equal(calls.at(-1).payload.queue, true);
    assert.equal(calls.at(-1).payload.text, `${source}\n\noriginal**\n/rooms-overview`);
    assert.ok(moss_setup_text(link).startsWith(setup) && moss_setup_text(link).endsWith(link));
    view.free.requests[0].answer_id = 31;
    const deliveries = [];
    const send = async (_home, notice) => { deliveries.push(notice); return { status: 'sent' }; };
    await flush_moss_channel_replies(home, { config, room: view, request, link, send });
    assert.equal(deliveries[0].only, 'second');
    assert.equal(deliveries[0].room.room, 'moss-room');
    assert.deepEqual(deliveries[0].paragraphs, ['**answer**\n\nverbatim']);
    assert.equal(deliveries[0].verbatim, true);
    long = true;
    view.free.requests[0].answer_id = null;
    view.free.requests.push({ message_id: 21, answer_id: 31 });
    busy = false;
    // Only resolve the two queued messages from the second channel to this answer.
    const first_submission = calls.find(call => call.payload.text?.includes('first')).payload.submission_id;
    const resolve_queue = (room, path) => path.includes(first_submission) ? { messages: [] } : request(room, path);
    await flush_moss_channel_replies(home, { config, room: view, request: resolve_queue, link, send });
    assert.ok(deliveries[1].paragraphs[0].includes(full_reply) && deliveries[1].paragraphs[0].endsWith(link));
    assert.deepEqual(steward_status(home, {}, config.room).channel_queue_receipts, { total: 4, last_7_days: 4 });
    assert.deepEqual(moss_queue_receipts(home, Date.now() + 8 * 24 * 60 * 60 * 1000), { total: 4, last_7_days: 0 });
  });
}

test('new channel messages go to MOSS, ordinary quoted notices do not, and a web-only notice cannot take replies', async t => {
  const home = mkdtempSync(join(tmpdir(), 'codiscuss-moss-quotes-'));
  const { channel } = fake('fake');
  let inbound;
  channel.receive = async (_, { on_message }) => { inbound = on_message; };
  const saved = CHANNELS.splice(0, CHANNELS.length, channel);
  t.after(() => { CHANNELS.splice(0, CHANNELS.length, ...saved); rmSync(home, { recursive: true, force: true }); });
  const ordinary = { site: 's', room: 'ordinary' }, moss = { site: 's', room: 'moss' };
  await send_notice(home, { room: ordinary, paragraphs: ['ordinary'], question: { id: 42, version: 3 } });
  await send_notice(home, { room: moss, paragraphs: ['MOSS reply'], verbatim: true });
  await send_notice(home, { room: moss, paragraphs: ['approval http://site/?moss=moss'], web_only: true, verbatim: true });
  const posted = [];
  await receive_replies(home, { on_moss: async reply => { posted.push(reply); return 'new'; },
    on_reply: async reply => { posted.push(reply); return reply.room; } });
  assert.equal(await inbound({ text: 'new' }), 'new');
  assert.deepEqual(posted.at(-1), { channel: 'fake', label: 'fake', text: 'new' });
  assert.equal(await inbound({ text: 'old', quoted: [{ text: 'ordinary' }] }), ordinary.room);
  assert.equal(posted.at(-1).question_id, 42);
  assert.equal(await inbound({ text: 'follow-up', quoted: [{ text: 'MOSS reply' }] }), moss.room);
  assert.equal(await inbound({ text: 'yes', quoted: [{ text: 'approval' }] }), 'approval http://site/?moss=moss');
  assert.equal(posted.length, 3);
});

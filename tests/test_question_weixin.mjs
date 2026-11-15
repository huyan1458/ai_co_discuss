// Questions on Weixin (runner/question_weixin.mjs): the notice text, reading a reply as an exact answer, and applying it.
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.CODISCUSS_LANG = 'zh-CN';
const { answer_by_weixin, match_reply, question_notice, stale_reply } = await import('../runner/question_weixin.mjs');

const single = { id: 12, version: 1, status: 'waiting_user', asker: 'Codex', questions: [{ id: 'draft', question: '用哪一稿？', detail: '三稿差在结尾',
  multiSelect: false, free_text: true, options: [{ id: 'B', label: 'B 稿', recommended: true, description: '结尾最完整' }, { id: 'A', label: 'A 稿' }, { id: 'C', label: 'C 稿' }] }] };
const several = { ...single, questions: [single.questions[0], { id: 'extras', question: '加哪些？', multiSelect: true, free_text: true,
  options: [{ id: 'A', label: '配乐' }, { id: 'B', label: '地图' }] }] };
const multiple = { ...single, questions: [several.questions[1]] };

test('a question notice numbers the options in stored order, marks the recommended one and says how to reply', () => {
  const paragraphs = question_notice(single, 'Codex');
  assert.equal(paragraphs[0], '问题 #12：Codex 在等你回答');
  assert.deepEqual(paragraphs.slice(1, 5), ['用哪一稿？', '三稿差在结尾', '1. B 稿（推荐） — 结尾最完整', '2. A 稿']);
  assert.match(paragraphs.at(-1), /回复编号即可/);
  assert.match(question_notice(several, 'Codex').at(-1), /逐题回复编号/);
  assert.ok(question_notice(several, 'Codex').includes('第 2 题：加哪些？'));
});

test('exact replies map to option ids; anything else is left to the host', () => {
  assert.deepEqual(match_reply(single, ' 1 '), { answers: [{ id: 'draft', selected: ['B'] }], picked: ['1『B 稿』'] }, 'the number shown, recommended first');
  assert.deepEqual(match_reply(single, 'C 稿').answers, [{ id: 'draft', selected: ['C'] }], 'a label exactly');
  assert.equal(match_reply(single, '1 2'), null, 'a single choice takes one number');
  assert.equal(match_reply(single, '4'), null, 'out of range');
  assert.deepEqual(match_reply(multiple, '1，2').answers, [{ id: 'extras', selected: ['A', 'B'] }], 'several on a multiple choice');
  assert.equal(match_reply(multiple, '1 1'), null, 'no repeats');
  assert.deepEqual(match_reply(several, '3 2').answers, [{ id: 'draft', selected: ['C'] }, { id: 'extras', selected: ['B'] }], 'one number per question in order');
  assert.equal(match_reply(several, '3'), null, 'every question needs its number');
  assert.equal(match_reply(single, '我觉得 B 稿结尾好一些，但开头用 A 的'), null);
  assert.equal(match_reply({ ...single, questions: [{ ...single.questions[0], options: [] }] }, '1'), null, 'a free-text question has no numbers');
});

test('a stale reply answers nothing and says why', () => {
  assert.match(stale_reply({ ...single, status: 'answered' }, 1), /已经回答过了/);
  assert.match(stale_reply({ ...single, status: 'delegated' }, 1), /主持人/);
  assert.match(stale_reply({ ...single, version: 2 }, 1), /第 2 版.*另发通知/);
  assert.equal(stale_reply(single, 1), '');
});

/** A stand-in room API: the question as read, and every write. */
function room(question) {
  const writes = [];
  const request = async (path, payload) => {
    if (payload === undefined) return question;
    writes.push({ path, payload });
    return { duplicate: false };
  };
  return { writes, request };
}

test('an exact reply answers the version the notice showed; another reply is delegated with the owner\'s words', async () => {
  const exact = room(single);
  assert.equal(await answer_by_weixin(exact.request, { question_id: 12, version: 1, text: '1' }), '已按 1『B 稿』回答问题 #12。');
  assert.deepEqual(exact.writes.map(item => [item.path, item.payload.action, item.payload.version, item.payload.answers]),
    [['/questions/12/answer', 'answer', 1, [{ id: 'draft', selected: ['B'] }]]]);
  const again = room(single);
  await answer_by_weixin(again.request, { question_id: 12, version: 1, text: '1' });
  assert.equal(again.writes[0].payload.submission_id, exact.writes[0].payload.submission_id, 'a reply delivered twice is one answer');
  const vague = room(single);
  assert.match(await answer_by_weixin(vague.request, { question_id: 12, version: 1, text: '结尾用 B 的' }), /交给主持人/);
  assert.deepEqual([vague.writes[0].payload.action, vague.writes[0].payload.text], ['delegate', '结尾用 B 的']);
  const stale = room({ ...single, version: 2 });
  assert.match(await answer_by_weixin(stale.request, { question_id: 12, version: 1, text: '1' }), /另发通知/);
  assert.deepEqual(stale.writes, [], 'nothing is written for a changed question');
});

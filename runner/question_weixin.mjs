/**
 * Questions on Weixin: the notice the program writes for a blocking question the owner has left waiting, and how the
 * owner's reply maps back to it. Pure functions; the runner sends the notice (free_runner.mjs) and the service applies
 * the reply (discussion_service.mjs). Nothing here wakes the host: a reply that is plainly an option number (or label)
 * answers the question; anything else is left to the host to interpret, through the question's own "let the host
 * decide" action.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomic_json } from './files.mjs';
import { t } from './i18n.mjs';

function question_visibility_file(home, room, id, version) {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(room) || !Number.isSafeInteger(id) || id <= 0
      || !Number.isSafeInteger(version) || version <= 0) throw new Error('Invalid local question identity');
  return join(home, 'notify', 'moss-question-visibility', `${room}-${id}-${version}.json`);
}

/** Persist an explicit public marker for this version of a question. */
export function mark_question_public(home, room, id, version = 1) {
  const file = question_visibility_file(home, room, id, version);
  mkdirSync(join(home, 'notify', 'moss-question-visibility'), { recursive: true, mode: 0o700 });
  atomic_json(file, { public: true });
}

/** Unmarked questions may not be sent to a public audience. */
export function question_is_public(home, room, id, version) {
  try { return JSON.parse(readFileSync(question_visibility_file(home, room, id, version), 'utf8')).public === true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

// The longest option description a notice repeats; the full text is in the room.
const DESCRIPTION_CHARS = 80;
// Separators between option numbers in a reply: spaces and commas (half or full width) and the enumeration comma.
const SEPARATORS = /[\s,，、;；]+/u;

/** One option as a notice line: its number, label, a recommended mark, then a short dash and its description. */
function option_line(option, index) {
  const description = option.description
    ? ` — ${option.description.length > DESCRIPTION_CHARS ? `${option.description.slice(0, DESCRIPTION_CHARS)}…` : option.description}` : '';
  return `${index + 1}. ${option.label}${option.recommended ? t('（推荐）') : ''}${description}`;
}

/**
 * The paragraphs of a question's Weixin notice. Weixin folds single line breaks, so every line is its own paragraph.
 * Options are numbered in the order the question stores them, which is the order replies are read in.
 *
 * @param {object} question - The question as `GET /questions/ID` returns it.
 * @param {string} asker - How the room shows the member who asked.
 * @returns {string[]} Paragraphs; the caller adds the room link.
 */
export function question_notice(question, asker) {
  const items = question.questions || [];
  const paragraphs = [t('问题 #{id}：{asker} 在等你回答', { id: question.id, asker })];
  items.forEach((item, index) => {
    paragraphs.push(items.length > 1 ? t('第 {number} 题：{question}', { number: index + 1, question: item.question }) : item.question);
    if (item.detail) paragraphs.push(item.detail);
    if (item.multiSelect && item.options.length) paragraphs.push(t('（可多选）'));
    paragraphs.push(...item.options.map(option_line));
  });
  const numbered = items.every(item => item.options.length);
  paragraphs.push(!numbered ? t('直接回复你的回答，会交给主持人理解后代为作答。')
    : items.length > 1 ? t('按题目顺序逐题回复编号即可，用空格分隔（如“1 2”）；其他文字会交给主持人理解后代为选择。')
      : t('回复编号即可；其他文字会交给主持人理解后代为选择。'));
  return paragraphs;
}

/** Option numbers in a reply, each within 1..count, or null when the reply is anything else. */
function numbers(text, count) {
  const parts = text.split(SEPARATORS).filter(Boolean);
  if (!parts.length || parts.some(part => !/^\d{1,2}$/.test(part))) return null;
  const values = parts.map(Number);
  return values.every(value => value >= 1 && value <= count) ? values : null;
}

/**
 * Read the owner's reply as an exact answer, or return null so it goes to the host.
 *
 * Exact means: for one question, its option number(s) (several only on a multiple-choice question, no repeats) or
 * one option's label exactly; for several questions, one option number per question in their order.
 *
 * @param {object} question - The question as `GET /questions/ID` returns it.
 * @param {string} text - The owner's reply.
 * @returns {{answers: {id: string, selected: string[]}[], picked: string[]}|null} The `answers` to submit and, per
 *   picked option, "number『label』" for the confirmation; null when the reply is not an exact answer.
 */
export function match_reply(question, text) {
  const items = question.questions || [];
  const reply = String(text || '').trim().replace(/[。.!！]+$/u, '').trim();
  if (!reply || !items.length || items.some(item => !item.options.length)) return null;
  const pick = (item, index) => ({ id: item.options[index].id, shown: `${index + 1}『${item.options[index].label}』` });
  let chosen;
  if (items.length === 1) {
    const [item] = items;
    const values = numbers(reply, item.options.length);
    if (values && (item.multiSelect ? new Set(values).size === values.length : values.length === 1)) chosen = [values.map(value => pick(item, value - 1))];
    else {
      const index = item.options.findIndex(option => option.label === reply);
      if (index < 0) return null;
      chosen = [[pick(item, index)]];
    }
  } else {
    const parts = reply.split(SEPARATORS).filter(Boolean);
    if (parts.length !== items.length) return null;
    chosen = [];
    for (const [index, item] of items.entries()) {
      const value = numbers(parts[index], item.options.length);
      if (!value || value.length !== 1) return null;
      chosen.push([pick(item, value[0] - 1)]);
    }
  }
  return { answers: items.map((item, index) => ({ id: item.id, selected: chosen[index].map(entry => entry.id) })),
    picked: chosen.flat().map(entry => entry.shown) };
}

/** The confirmation sent back when a reply could not answer: the question changed, ended, or waits on the host. */
export function stale_reply(question, version) {
  if (question.status === 'answered') return t('问题 #{id} 已经回答过了，这条回复没有作答。', { id: question.id });
  if (question.status === 'cancelled') return t('问题 #{id} 已取消，这条回复没有作答。', { id: question.id });
  if (question.status === 'expired') return t('问题 #{id} 已过期，这条回复没有作答。', { id: question.id });
  if (question.status !== 'waiting_user') return t('问题 #{id} 已交给主持人处理，这条回复没有作答；需要补充请在房间里说。', { id: question.id });
  if (question.version !== version) {
    return t('问题 #{id} 已更新到第 {version} 版（例如主持人给了推荐），这条回复没有作答；新版本会另发通知。', { id: question.id, version: question.version });
  }
  return '';
}

/**
 * Apply the owner's Weixin reply to the question its notice named, as the owner (the service's room credential).
 *
 * A stale reply (the question ended, waits on the host, or moved to a new version) answers nothing. An exact reply
 * answers through the question's answer endpoint, bound to the version the notice showed, so it goes straight back to
 * the asker (or the relay's next step) without the host. Anything else is left to the host with the owner's words as
 * the delegation note. The submission id derives from the question, version and words, so a reply delivered twice
 * is one answer.
 *
 * @param {(path: string, payload?: object) => Promise<object>} request - Room API call with the owner's credential.
 * @param {{question_id: number, version: number, text: string}} reply - What the notice named and what the owner wrote.
 * @returns {Promise<string>} The confirmation sent back on Weixin.
 */
export async function answer_by_weixin(request, { question_id, version, text }) {
  const question = await request(`/questions/${question_id}`);
  const stale = stale_reply(question, version);
  if (stale) return stale;
  const match = match_reply(question, text);
  const submission_id = `weixin-${createHash('sha256').update(JSON.stringify([question_id, version, text])).digest('hex').slice(0, 40)}`;
  if (match) {
    await request(`/questions/${question_id}/answer`, { version, action: 'answer', answers: match.answers, submission_id });
    return t('已按 {picked}回答问题 #{id}。', { picked: match.picked.join('、'), id: question_id });
  }
  await request(`/questions/${question_id}/answer`, { version, action: 'delegate', text, submission_id });
  return t('已把你的回复交给主持人判断（问题 #{id}），它会代为选择或在房间里追问。', { id: question_id });
}

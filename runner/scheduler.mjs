/** Optional smart scheduling: typed decisions from TypeSafe Jev or OpenAI Decisions, never generated text. */
import { api_status_message, read_saved_api_key } from './discussion_api.mjs';

/** Each provider keeps its official root; the key saved for that root is the only credential used. */
export const SCHEDULER_PROVIDERS = {
  jev: { label: 'TypeSafe Jev', base_url: 'https://api.typesafe.ai/v1', path: '/systemone', models: ['jev-latest'] },
  decisions: { label: 'OpenAI Decisions', base_url: 'https://api.openai.com/v1', path: '/decisions', models: ['gpt-6-luna'] },
};
const REQUEST_TIMEOUT_MS = 15_000;
/** Below this confidence a free-room message stays with the host, exactly as without scheduling. */
export const ROUTE_CONFIDENCE = 0.8;
const HOST_CHOICE = '__host__';
const NOTE_CHOICE = '__note__';
const CONTEXT_MESSAGES = 10;
const MAX_MESSAGE_CHARS = 600;

/** Normalize a launch's scheduler choice and prove its key exists for that provider's root. */
export function validate_scheduler(home, scheduler) {
  const provider = SCHEDULER_PROVIDERS[scheduler?.provider];
  if (!provider) throw new Error(`智能调度供应商只能为 ${Object.keys(SCHEDULER_PROVIDERS).join(' / ')}`);
  if (!scheduler.model || typeof scheduler.model !== 'string') throw new Error('请填写智能调度模型');
  const normalized = { provider: scheduler.provider, model: scheduler.model.trim(), base_url: provider.base_url, api_key_ref: scheduler.api_key_ref };
  read_saved_api_key(home, normalized.base_url, normalized.api_key_ref);
  return normalized;
}

/** Convert neutral questions ({type: choice|predicate, name, instructions, choices}) to one provider's body. */
export function scheduler_request(scheduler, state, questions) {
  const { path } = SCHEDULER_PROVIDERS[scheduler.provider];
  if (scheduler.provider === 'jev') return { path, body: { model: scheduler.model, state, questions: Object.fromEntries(questions.map(question => [question.name,
    question.type === 'choice'
      ? { type: 'choice', instructions: question.instructions, criteria: Object.fromEntries(question.choices.map(choice => [choice.value, choice.description])) }
      : { type: 'noul', instructions: question.instructions }])) } };
  return { path, body: { model: scheduler.model, input: state, questions: questions.map(question => question.type === 'choice'
    ? { type: 'choice', name: question.name, instructions: question.instructions, choices: question.choices.map(({ value, description }) => ({ value, description })) }
    : { type: 'predicate', name: question.name, instructions: question.instructions }) } };
}

/** Read answers by question name: choices as {choice, confidence, probabilities}, predicates as {probability}. */
export function scheduler_answers(scheduler, data) {
  if (scheduler.provider === 'jev') return Object.fromEntries(Object.entries(data?.answers || {}).map(([name, answer]) => [name,
    answer.type === 'choice' ? { choice: answer.choice, confidence: answer.confidence, probabilities: answer.probabilities || {} } : { probability: answer.noul }]));
  return Object.fromEntries((data?.answers || []).map(answer => [answer.name, answer.type === 'choice'
    ? { choice: answer.choice, confidence: answer.confidence, probabilities: Object.fromEntries((answer.probabilities || []).map(item => [item.value, item.probability])) }
    : { probability: answer.probability }]));
}

/** Ask the configured provider once; errors carry only the HTTP status, never response bodies or keys. */
export async function decide(home, scheduler, state, questions, fetch_impl = fetch) {
  const key = read_saved_api_key(home, scheduler.base_url, scheduler.api_key_ref);
  const request = scheduler_request(scheduler, state, questions);
  let response;
  try {
    response = await fetch_impl(`${scheduler.base_url}${request.path}`, { method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(request.body), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch { throw new Error('智能调度请求超时或连接失败'); }
  if (!response.ok) throw new Error(api_status_message(response.status));
  return scheduler_answers(scheduler, await response.json());
}

/** Shorten a message so recent context stays small; the decision never needs whole answers. */
function excerpt(message) {
  const text = String(message.text || '').replace(/\s+/g, ' ').trim();
  return `#${message.id} ${message.author}：${text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}…` : text}`;
}

/** State shared by both uses: the room, a few earlier messages, and the message to place. */
export function scheduler_state(title, context, message) {
  const earlier = context.filter(item => item.id < message.id).slice(-CONTEXT_MESSAGES).map(excerpt);
  return [`房间：${title || ''}`, earlier.length ? `近期消息（旧→新）：\n${earlier.join('\n')}` : '近期没有其他消息。', `待处理的用户消息：\n${excerpt(message)}`].join('\n\n');
}

/**
 * Pick the member for one unnamed free-room message, or null to leave it with the host.
 * Members are [{name, description}] without the host; only a confident member choice is returned.
 */
export async function route_free_message(home, scheduler, { title, context, message, host, members }, fetch_impl) {
  const choices = [...members.map(member => ({ value: member.name, description: member.description })),
    { value: HOST_CHOICE, description: `交回主持人 ${host}：需要拆分任务、补充说明、多人协作，或无法确定由谁处理` }];
  const answers = await decide(home, scheduler, scheduler_state(title, context, message), [{ type: 'choice', name: 'handler',
    instructions: '这条用户消息没有点名成员。判断它能否直接交给一位成员独立处理；需要主持人先理解、拆分或协调时选交回主持人。', choices }], fetch_impl);
  const answer = answers.handler || {};
  const member = members.some(item => item.name === answer.choice) && answer.confidence >= ROUTE_CONFIDENCE ? answer.choice : null;
  return { member, choice: answer.choice ?? null, confidence: answer.confidence ?? null };
}

/** Suggest how the host might handle one interjection in a discussion; the host decides and may ignore it. */
export async function suggest_interjection(home, scheduler, { title, context, message, host, experts }, fetch_impl) {
  const choices = [...experts.map(name => ({ value: name, description: `请 ${name} 回应这条留言` })),
    { value: HOST_CHOICE, description: `由主持人 ${host} 处理：调整目标、方向、安排，或需要主持人决定` },
    { value: NOTE_CHOICE, description: '仅补充信息：不需要专人回应，按原计划继续' }];
  const answers = await decide(home, scheduler, scheduler_state(title, context, message), [{ type: 'choice', name: 'handling',
    instructions: '讨论进行中用户发来这条留言。判断它最适合怎样处理。', choices }], fetch_impl);
  const answer = answers.handling || {};
  const label = answer.choice === HOST_CHOICE ? '主持人处理' : answer.choice === NOTE_CHOICE ? '仅补充信息，按原计划继续'
    : experts.includes(answer.choice) ? `请 ${answer.choice} 回应` : '';
  return label ? { message_id: message.id, suggestion: label, confidence: answer.confidence ?? null } : null;
}

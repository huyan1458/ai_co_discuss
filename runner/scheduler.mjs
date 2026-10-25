/** Optional smart scheduling: typed decisions from TypeSafe Jev or OpenAI Decisions, never generated text. */
import { api_status_message, read_saved_api_key } from './discussion_api.mjs';

/** Each provider keeps its official root; the key saved for that root is the only credential used. */
export const SCHEDULER_PROVIDERS = {
  jev: { label: 'TypeSafe Jev', base_url: 'https://api.typesafe.ai/v1', path: '/systemone', models: ['jev-latest'] },
  decisions: { label: 'OpenAI Decisions', base_url: 'https://api.openai.com/v1', path: '/decisions', models: ['gpt-6-luna'] },
};
const REQUEST_TIMEOUT_MS = 30_000;
/** Below this confidence a decision stays with the host, exactly as without scheduling. */
export const ROUTE_CONFIDENCE = 0.7;
/** Bump when the routing question or its option descriptions change, so ratings can be compared across wordings. */
export const ROUTE_PROMPT_VERSION = 2;
const HOST_CHOICE = '__host__';
const NOTE_CHOICE = '__note__';
const CONTEXT_MESSAGES = 10;
/** A free-room route sees a longer stretch, enough to tell who has not spoken for a while. */
export const ROUTE_CONTEXT_MESSAGES = 20;
const MAX_MESSAGE_CHARS = 600;
const MAX_BRIEF_CHARS = 1200;

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
  const started = Date.now();
  try {
    response = await fetch_impl(`${scheduler.base_url}${request.path}`, { method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(request.body), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch { throw new Error('智能调度请求超时或连接失败'); }
  if (!response.ok) throw new Error(api_status_message(response.status));
  const answers = scheduler_answers(scheduler, await response.json());
  // Timing rides along without being an answer, so callers iterating answers by question name never see it.
  Object.defineProperty(answers, 'elapsed_ms', { value: Date.now() - started });
  return answers;
}

/** Send one tiny yes/no question so provider, model and key are checked together before a room relies on them. */
export async function scheduler_check(home, input, fetch_impl = fetch) {
  const scheduler = validate_scheduler(home, input);
  const answers = await decide(home, scheduler, '这是一条连通性检查消息。', [{ type: 'predicate', name: 'check', instructions: '这条内容是否是连通性检查？' }], fetch_impl);
  if (typeof answers.check?.probability !== 'number') throw new Error('决策模型未返回可用答案，请核对供应商与模型');
  return { ok: true };
}

/** What was asked (the instruction and options only, never the room excerpts), what the provider chose and how long the call took. */
function detail_of(questions, answers) {
  return questions.map(question => {
    const answer = answers[question.name];
    // A yes/no question is recorded as a two-way choice so the card reads it like any other.
    if (question.type === 'predicate') {
      const yes = typeof answer?.probability === 'number' ? answer.probability : null;
      return { question: question.instructions, choices: ['是', '否'], choice: yes === null ? null : yes >= 0.5 ? '是' : '否',
        probabilities: yes === null ? {} : { 是: yes, 否: Number((1 - yes).toFixed(4)) }, duration_ms: answers.elapsed_ms ?? null };
    }
    return { question: question.instructions, choices: question.choices.map(choice => choice.value),
      choice: answer?.choice ?? null, probabilities: answer?.probabilities ?? {}, duration_ms: answers.elapsed_ms ?? null };
  });
}

/** Say which option the provider leaned to when it was not sure enough, so the transcript shows how close it was. */
function unsure_label(lean) {
  return lean ? `倾向${lean}，把握不足，交给主持人` : '拿不准，交给主持人';
}

/** Shorten a message so recent context stays small; the decision never needs whole answers. */
function excerpt(message) {
  const text = String(message.text || '').replace(/\s+/g, ' ').trim();
  return `#${message.id} ${message.author}：${text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}…` : text}`;
}

/** The room's purpose in the user's words, so a decision can tell drifting from progress. */
function topic_lines(title, goal, user_request, { brief, focus, arrangement, progress } = {}) {
  return [`房间：${title || ''}`, goal && `目标：${goal}`, user_request && `用户原文：${String(user_request).slice(0, MAX_MESSAGE_CHARS)}`,
    focus && `当前焦点：${focus}`, brief && `主持简报（含分工与规则）：${String(brief).slice(0, MAX_BRIEF_CHARS)}`,
    arrangement && `主持人最近的安排：${arrangement}`, progress].filter(Boolean).join('\n');
}

/** State shared by both uses: the room, a few earlier messages, and the message to place. */
export function scheduler_state(title, context, message, goal = '', user_request = '', extra = {}, limit = CONTEXT_MESSAGES) {
  const earlier = context.filter(item => item.id < message.id).slice(-limit).map(excerpt);
  return [topic_lines(title, goal, user_request, extra), earlier.length ? `近期消息（旧→新）：\n${earlier.join('\n')}` : '近期没有其他消息。', `待处理的用户消息：\n${excerpt(message)}`].join('\n\n');
}

/**
 * How sure the provider is of its pick: the chosen option's probability when given. Jev's separate `confidence`
 * runs lower than that probability on two-way choices, so it is only the fallback.
 */
export function certainty(answer) {
  const probability = answer?.probabilities?.[answer.choice];
  return typeof probability === 'number' ? probability : typeof answer?.confidence === 'number' ? answer.confidence : null;
}

/**
 * Pick the member for one unnamed free-room message, or null to leave it with the host.
 * Members are [{name, description}] without the host; only a confident member choice is returned.
 */
export async function route_free_message(home, scheduler, { title, goal, context, message, host, members }, fetch_impl) {
  const choices = [...members.map(member => ({ value: member.name, description: member.description })),
    { value: HOST_CHOICE, description: `交回主持人 ${host}：需要拆分任务、多人协作，或消息与任何成员都无关` }];
  const answers = await decide(home, scheduler, scheduler_state(title, context, message, goal, '', {}, ROUTE_CONTEXT_MESSAGES), [{ type: 'choice', name: 'handler',
    instructions: '这条用户消息没有用 @ 点名成员，但正文可能直接提到某位成员的名字或在向其提问（如“某某在吗”），此时应选该成员。判断它能否直接交给一位成员独立处理；需要主持人先理解、拆分或协调时选交回主持人。', choices }], fetch_impl);
  const answer = answers.handler || {};
  const confidence = certainty(answer);
  const member = members.some(item => item.name === answer.choice) && confidence >= ROUTE_CONFIDENCE ? answer.choice : null;
  return { member, choice: answer.choice ?? null, confidence };
}

/**
 * Decide one interjection in a discussion: continue the plan (note), ask one expert (ask) or wake the host (host).
 * Anything but a confident note or ask is returned as host.
 */
export async function decide_interjection(home, scheduler, { title, goal, user_request, context, message, host, experts, ...extra }, fetch_impl) {
  const choices = [...experts.map(name => ({ value: name, description: `请 ${name} 回应这条留言：留言是向该专家（或其负责的内容）提问、质疑或补充要求` })),
    { value: HOST_CHOICE, description: `由主持人 ${host} 处理：留言要改变讨论目标、规则、分工、安排或结束讨论，或同时涉及多位专家` },
    { value: NOTE_CHOICE, description: '仅补充信息：留言只是旁注、信息或鼓励，不要求任何人回应，按当前安排继续' }];
  const questions = [{ type: 'choice', name: 'handling', instructions: '讨论进行中用户发来这条留言。对照当前焦点、主持简报和安排，判断它最适合怎样处理。', choices }];
  const answers = await decide(home, scheduler, scheduler_state(title, context, message, goal, user_request, extra), questions, fetch_impl);
  const detail = detail_of(questions, answers);
  const choice = answers.handling?.choice;
  const confidence = certainty(answers.handling);
  const sure = confidence !== null && confidence >= ROUTE_CONFIDENCE;
  if (sure && choice === NOTE_CHOICE) return { action: 'note', confidence, detail, label: '仅补充信息，按原计划继续' };
  if (sure && experts.includes(choice)) return { action: 'ask', expert: choice, confidence, detail, label: `先请 ${choice} 回应这条留言` };
  const lean = choice === NOTE_CHOICE ? '按原计划继续' : experts.includes(choice) ? `请 ${choice} 回应` : choice === HOST_CHOICE ? '由主持人处理' : '';
  return { action: 'host', confidence, detail, label: choice === HOST_CHOICE && sure ? '这条留言需要主持人处理' : unsure_label(lean) };
}

/**
 * Mid-round with no queued turn left: pick the next speaker among the experts who can be woken and have not spoken
 * this round, or hand back to the host when unsure or when the discussion needs steering.
 */
export async function decide_next_speaker(home, scheduler, { title, goal, user_request, context, host, candidates, spoken = [], ...extra }, fetch_impl) {
  const recent = context.slice(-CONTEXT_MESSAGES).map(excerpt);
  const progress = `本轮已发言：${spoken.join('、') || '无'}；本轮尚未发言：${candidates.join('、')}。`;
  const state = [topic_lines(title, goal, user_request, { ...extra, progress }), recent.length ? `本轮及最近发言（旧→新）：\n${recent.join('\n')}` : '还没有发言。'].join('\n\n');
  const choices = [...candidates.map(name => ({ value: name, description: `请 ${name} 接着发言：简报的分工或接龙顺序轮到 ${name}，或刚才的发言点名追问了 ${name}` })),
    { value: HOST_CHOICE, description: `交给主持人 ${host}：没有明确该谁发言，或需要主持人重新安排` }];
  // Having not spoken yet is no reason to speak: the host's plan may have ended on purpose, so the scheduler acts only on an explicit obligation.
  const questions = [{ type: 'choice', name: 'speaker',
    instructions: '主持人预排的安排已用完或被取消。对照主持简报的分工、当前焦点和主持人最近的安排，判断下一位应请谁发言。', choices },
    { type: 'predicate', name: 'obligation',
      instructions: `是否存在明确依据要求 ${candidates.join('、')} 之一接着发言：简报分工或流程规定轮到其人，或最近发言点名追问了其人？仅仅是“本轮还没发言”不算依据。` }];
  const answers = await decide(home, scheduler, state, questions, fetch_impl);
  const detail = detail_of(questions, answers);
  const choice = answers.speaker?.choice;
  const confidence = certainty(answers.speaker);
  const obligation = answers.obligation?.probability;
  if (candidates.includes(choice) && confidence !== null && confidence >= ROUTE_CONFIDENCE && obligation >= ROUTE_CONFIDENCE) {
    return { action: 'next', expert: choice, confidence, detail, label: `本轮继续，请 ${choice} 接着发言` };
  }
  if (typeof obligation === 'number' && obligation < ROUTE_CONFIDENCE) {
    return { action: 'host', confidence, detail, label: `有明确依据的概率 ${obligation.toFixed(2)}，未达 ${ROUTE_CONFIDENCE.toFixed(2)}，交给主持人安排` };
  }
  return { action: 'host', confidence, detail, label: choice === HOST_CHOICE && confidence >= ROUTE_CONFIDENCE ? '建议由主持人调整安排，交给主持人' : unsure_label(candidates.includes(choice) ? `请 ${choice} 发言` : choice === HOST_CHOICE ? '交给主持人' : '') };
}

/**
 * At the end of a round without named follow-ups: continue with another peer round, or wake the host
 * (to conclude, or because the discussion drifted, repeats itself or is stuck). The first speaker is never the last one.
 */
export async function decide_round(home, scheduler, { title, goal, user_request, context, host, experts, last_speaker, ...extra }, fetch_impl) {
  const candidates = experts.filter(name => name !== last_speaker);
  const recent = context.slice(-CONTEXT_MESSAGES).map(excerpt);
  const state = [topic_lines(title, goal, user_request, extra), recent.length ? `本轮及最近发言（旧→新）：\n${recent.join('\n')}` : '还没有发言。'].join('\n\n');
  const questions = [{ type: 'choice', name: 'next', instructions: '一轮发言刚结束。对照讨论目标、主持简报与当前焦点判断：下一轮是否还有明确的内容可以让大家互相回应、追问或补充？', choices: [
    { value: 'continue', description: '继续下一轮：最近发言里有未回应的分歧、追问或可展开的点，或简报规定的流程还没走完' },
    { value: HOST_CHOICE, description: `交给主持人 ${host}：目标已经达成可以收束，或最近发言在重复、偏离目标、卡住，需要主持人引导` }] }];
  if (candidates.length > 1) questions.push({ type: 'choice', name: 'first', instructions: '下一轮应先请谁发言？按简报分工或接龙顺序判断；没有规定时选被其他专家点名追问、最需要回应的人。',
    choices: candidates.map(name => ({ value: name, description: `先请 ${name}` })) });
  const answers = await decide(home, scheduler, state, questions, fetch_impl);
  const detail = detail_of(questions, answers);
  const choice = answers.next?.choice;
  const confidence = certainty(answers.next);
  if (choice !== 'continue' || confidence === null || confidence < ROUTE_CONFIDENCE || !candidates.length) {
    const sure = confidence !== null && confidence >= ROUTE_CONFIDENCE;
    return { action: 'host', confidence, detail, label: choice === HOST_CHOICE && sure ? '建议收束或调整方向，交给主持人' : unsure_label(choice === 'continue' ? '继续下一轮' : choice === HOST_CHOICE ? '收束或调整方向' : '') };
  }
  const first = candidates.includes(answers.first?.choice) ? answers.first.choice : candidates[0];
  return { action: 'continue', first, confidence, detail, label: `继续下一轮，先请 ${first} 发言` };
}

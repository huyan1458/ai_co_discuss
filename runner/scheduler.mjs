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
/** Waking everyone or no one costs more when wrong (N runs, or an ignored message), so it needs more certainty. */
export const ROUTE_WIDE_CONFIDENCE = 0.85;
/** Bump when the routing question or its option descriptions change, so ratings can be compared across wordings. */
export const ROUTE_PROMPT_VERSION = 9;
/** The same for the three discussion questions (interjection, next speaker, next round). */
export const DISCUSSION_PROMPT_VERSION = 4;
/** Completion of a preauthorized implementation batch is separate from routing and discussion. */
export const REVIEW_PROMPT_VERSION = 1;
export const REVIEW_CONFIDENCE = 0.85;
export const MAX_REVIEW_INPUT = 60000;
const HOST_CHOICE = '__host__';
const NOTE_CHOICE = '__note__';
const ALL_CHOICE = '__all__';
const NONE_CHOICE = '__none__';
const CONTEXT_MESSAGES = 10;
/** A free-room route sees a longer stretch, enough to tell who has not spoken for a while. */
export const ROUTE_CONTEXT_MESSAGES = 20;
const MAX_MESSAGE_CHARS = 600;
const MAX_BRIEF_CHARS = 1200;
const MAX_PROFILE_CHARS = 500;

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

/** The shown detail plus the exact input (state and full questions), kept so a rated-bad decision can be reviewed later. */
function judged_of(state, questions, answers) {
  return { detail: detail_of(questions, answers), input: { state, questions } };
}

/** Who has and has not spoken this round, so a decision knows who the plan still owes a turn. */
function round_progress(spoken, waiting) {
  return `本轮已发言：${spoken.join('、') || '无'}；本轮尚未发言：${waiting.join('、') || '无'}。`;
}

/** Say which option the provider leaned to when it was not sure enough, so the transcript shows how close it was. */
function unsure_label(lean) {
  return lean ? `倾向${lean}，把握不足，交给主持人` : '拿不准，交给主持人';
}

/** Shorten a message so recent context stays small; the decision never needs whole answers. */
function excerpt(message) {
  const text = String(message.text || '').replace(/\s+/g, ' ').trim();
  const reply = message.reply_to ? `（回复 #${message.reply_to}）` : '';
  return `#${message.id} ${message.author}${reply}：${text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}…` : text}`;
}

/** The room's purpose in the user's words, so a decision can tell drifting from progress. */
function topic_lines(title, goal, user_request, { roster, profiles, brief, focus, arrangement, progress } = {}) {
  return [`房间：${title || ''}`, roster && `房间成员（名字不区分大小写）：${roster}`, profile_lines(profiles), goal && `目标：${goal}`, user_request && `用户原文：${String(user_request).slice(0, MAX_MESSAGE_CHARS)}`,
    focus && `当前焦点：${focus}`, brief && `主持简报（含分工与规则）：${String(brief).slice(0, MAX_BRIEF_CHARS)}`,
    arrangement && `主持人最近的安排：${arrangement}`, progress].filter(Boolean).join('\n');
}

/** The owner's descriptions of members, so a decision can weigh who is good at what. */
export function profile_lines(profiles) {
  const lines = Object.entries(profiles || {}).filter(([, text]) => text).map(([name, text]) => `- ${name}：${String(text).slice(0, MAX_PROFILE_CHARS)}`);
  return lines.length ? `用户对成员的描述（擅长与分工，供参考）：\n${lines.join('\n')}` : '';
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
 * Decide who answers one unnamed free-room message: whether its addressee is already settled by the text or the thread.
 * Members are [{name, description}] without the host; host is {name, description}. Returns action member (with member),
 * all, none, or host for anything unsettled or not confident enough.
 */
export async function route_free_message(home, scheduler, { title, goal, context, message, host, members }, fetch_impl) {
  const choices = [...members.map(member => ({ value: member.name, description: member.description })),
    { value: HOST_CHOICE, description: `主持人 ${host.description}：没有指向任何人且用户没有确定负责人（如单独一句“hi”“你好”这类问候、闲聊，由主持人代表房间回应），或诉求模糊、复杂，需要主持人判断怎么安排` },
    { value: ALL_CHOICE, description: '全体成员（含主持人）各自回应一次，彼此不需要看到别人的回答；只在要求简单明确、每人独立回应一次就算完成时选，如“大家打个招呼”“各自报一下在用的模型”' },
    { value: NONE_CHOICE, description: '无需回应：只是确认、致谢或旁注，不需要任何人回答' }];
  const questions = [{ type: 'choice', name: 'handler', choices,
    instructions: '这条用户消息没有用 @ 点名成员。判断它的回应对象，按下面的顺序：1）正文叫了某位成员的名字，或在向其提问（包括“X在吗”“X还在吗”“X你怎么看”），选该成员，即使上一条是别人的回答；同时提到几位成员时，选被直接称呼、要求其回应或做事的那位（如“A 你让 B 去改”是在对 A 说）；2）正文没有指向任何人时，看它是否在延续某位成员的回答（追问、要求修改、引用，或“回复”指向其消息），或在补充、纠正一条正由某位成员处理的消息，是则选该成员，是主持人就选主持人；3）查看各成员的用户描述：已经明确由唯一一位成员负责这类任务时，直接选该成员，不需要再次点名；仅有擅长、多人分工重叠或任务还需要拆分时交主持人；4）符合“全体”选项的条件时选全体；只出现“大家”“都”“各自”“一起”等字眼不够；5）单独的问候或闲聊（如“hi”）既没有指向某位成员，也没有要求大家一起回应，选主持人；6）只是确认、致谢或旁注选无需回应；7）对象不明确，或要讨论、互相回应、分工、排先后时选主持人，由主持人安排。' }];
  const roster = [`${host.name}（主持人）`, ...members.map(member => member.name)].join('、');
  const state = scheduler_state(title, context, message, goal, '', { roster }, ROUTE_CONTEXT_MESSAGES);
  const answers = await decide(home, scheduler, state, questions, fetch_impl);
  const judged = judged_of(state, questions, answers);
  const choice = answers.handler?.choice ?? null;
  const confidence = certainty(answers.handler);
  const wide = choice === ALL_CHOICE || choice === NONE_CHOICE;
  const sure = confidence !== null && confidence >= (wide ? ROUTE_WIDE_CONFIDENCE : ROUTE_CONFIDENCE);
  if (sure && choice === ALL_CHOICE) return { action: 'all', choice, confidence, ...judged };
  if (sure && choice === NONE_CHOICE) return { action: 'none', choice, confidence, ...judged };
  if (sure && members.some(item => item.name === choice)) return { action: 'member', member: choice, choice, confidence, ...judged };
  return { action: 'host', choice, confidence, ...judged };
}

/**
 * The user named everyone (@全体成员): decide whether they answer at once (parallel) or one after another (sequential).
 * Both automatic actions need confidence; unclear division of work or a weak answer returns control to the host.
 */
export async function decide_group_order(home, scheduler, { title, goal, context, message, members, descriptions = [] }, fetch_impl) {
  const questions = [{ type: 'choice', name: 'order', choices: [
    { value: 'parallel', description: '同时回答：各自独立回应即可，不需要看到别人的回答，如打招呼、各自介绍、各说一句看法、各自投票' },
    { value: 'sequential', description: `依次回答：后发言的需要看到前面的回答，如接龙、轮流补充或反驳、逐个评审上一位的结果、按顺序分工接力；按房间发言顺序（${members.join('、')}）逐个回答` },
    { value: HOST_CHOICE, description: '交给主持人：任务或分工还不清楚，需要先澄清、分配范围或协调；仅把大家排成依次回答不能解决这些问题' }],
    instructions: '用户用 @全体成员 请房间里所有成员回应这条消息。根据任务是否已明确以及成员间的依赖，判断应同时各自回答、按既定顺序依次回答（后一位看到前一位的回答再接着说），还是先由主持人安排。' }];
  const facts = descriptions.length ? `成员的软件、项目权限与当前任务：\n${descriptions.map(member => `- ${member.description}`).join('\n')}` : '';
  const state = [scheduler_state(title, context, message, goal, '', {}, ROUTE_CONTEXT_MESSAGES), facts].filter(Boolean).join('\n\n');
  const answers = await decide(home, scheduler, state, questions, fetch_impl);
  const confidence = certainty(answers.order);
  const choice = answers.order?.choice ?? null;
  const action = confidence !== null && confidence >= ROUTE_CONFIDENCE ? { parallel: 'all', sequential: 'sequential' }[choice] || 'host' : 'host';
  return { action, choice, confidence, ...judged_of(state, questions, answers) };
}

/**
 * Decide one interjection in a discussion: continue the plan (note), ask one expert (ask) or wake the host (host).
 * Anything but a confident note or ask is returned as host.
 */
export async function decide_interjection(home, scheduler, { title, goal, user_request, context, message, host, experts, spoken = [], ...extra }, fetch_impl) {
  // Ordinary asks do not consume a discussion turn; all present members are eligible.
  const choices = [...experts.map(name => ({ value: name, description: `请 ${name} 回应这条留言：留言是向该专家（或其负责的内容）提问、质疑或补充要求` })),
    { value: HOST_CHOICE, description: `由主持人 ${host} 处理：留言要改变讨论目标、规则、分工、安排或结束讨论，同时涉及多位专家，或针对的是不在选项里的人` },
    { value: NOTE_CHOICE, description: '仅补充信息：留言补充背景、约束或偏好，或只是旁注、鼓励，没有要求某人立即回应；后续发言的专家都能看到它，按当前安排继续' }];
  const questions = [{ type: 'choice', name: 'handling', instructions: '讨论进行中用户发来这条留言。对照当前焦点、主持简报和安排，判断它最适合怎样处理。', choices }];
  const state = scheduler_state(title, context, message, goal, user_request, { ...extra, progress: round_progress(spoken, experts.filter(name => !spoken.includes(name))) });
  const answers = await decide(home, scheduler, state, questions, fetch_impl);
  const judged = judged_of(state, questions, answers);
  const choice = answers.handling?.choice;
  const confidence = certainty(answers.handling);
  const sure = confidence !== null && confidence >= ROUTE_CONFIDENCE;
  if (sure && choice === NOTE_CHOICE) return { action: 'note', confidence, ...judged, label: '仅补充信息，按原计划继续' };
  if (sure && experts.includes(choice)) return { action: 'ask', expert: choice, confidence, ...judged, label: `先请 ${choice} 回应这条留言` };
  const lean = choice === NOTE_CHOICE ? '按原计划继续' : experts.includes(choice) ? `请 ${choice} 回应` : choice === HOST_CHOICE ? '由主持人处理' : '';
  return { action: 'host', confidence, ...judged, label: choice === HOST_CHOICE && sure ? '这条留言需要主持人处理' : unsure_label(lean) };
}

/** Judge only whether full delivery evidence satisfies the already-authorized review handoff. */
export async function decide_review_completion(home, scheduler, ready, fetch_impl) {
  const fallback = reason => ({ action: 'host', confidence: null, label: reason });
  if (!ready.ready) return fallback(ready.reason || '评审推进条件未满足，交给主持人');
  if (!ready.original?.text?.trim() || !ready.deliveries?.length
    || ready.deliveries.some(item => item.status !== 'completed' || !item.answer?.trim())) return fallback('缺少完整交付原文，交给主持人');
  const questions = [{ type: 'choice', name: 'completion',
    instructions: '主持人已指定下一步只读评审者和范围。根据原委派、每位实现者的完整交付原文与执行报告，判断本批是否已经完成所要求的交付、可以进入既定评审。只判断交付完成度，不判断代码正确性，不选择评审者，不改变计划。', choices: [
      { value: 'review', description: '按既定计划交评审：原委派要求的交付和明确要求的验证均已完成，没有仍待实现、阻塞或需要澄清的任务；代码是否正确由评审者判断' },
      { value: HOST_CHOICE, description: '交给主持人：交付仅部分完成、明确要求的验证尚未完成或失败、有阻塞或待澄清事项，或原文不足以确认已完成；笼统声称完成不能覆盖具体的未完成事项' }] }];
  const state = JSON.stringify({ original: ready.original, deliveries: ready.deliveries,
    authorized_review: { reviewer: ready.plan.reviewer_name, scope: ready.plan.scope } });
  if (JSON.stringify({ state, questions }).length > MAX_REVIEW_INPUT) return fallback('完整评审判断输入超过 60000 字符，交给主持人');
  const answers = await decide(home, scheduler, state, questions, fetch_impl);
  const confidence = certainty(answers.completion), choice = answers.completion?.choice ?? null;
  const advance = choice === 'review' && confidence !== null && confidence >= REVIEW_CONFIDENCE;
  return { action: advance ? 'review' : 'host', choice, confidence, ...judged_of(state, questions, answers),
    label: advance ? '交付已完成，按既定计划交只读评审' : '交付完成度不足或把握不足，交给主持人' };
}

/**
 * Mid-round with no queued turn left: pick the next speaker among the experts who can be woken and have not spoken
 * this round, or hand back to the host when unsure or when the discussion needs steering.
 */
export async function decide_next_speaker(home, scheduler, { title, goal, user_request, context, host, candidates, spoken = [], ...extra }, fetch_impl) {
  const recent = context.slice(-CONTEXT_MESSAGES).map(excerpt);
  const state = [topic_lines(title, goal, user_request, { ...extra, progress: round_progress(spoken, candidates) }), recent.length ? `本轮及最近发言（旧→新）：\n${recent.join('\n')}` : '还没有发言。'].join('\n\n');
  // Having not spoken yet is no reason to speak: the host's plan may have ended on purpose, so a candidate needs an explicit basis.
  const choices = [...candidates.map(name => ({ value: name, description: `请 ${name} 接着发言：简报的分工或流程规定轮到 ${name}，或最近的发言点名追问了 ${name}` })),
    { value: HOST_CHOICE, description: `交给主持人 ${host}：简报和最近发言都没有明确规定下一位（仅仅是本轮还没发言不算依据），或需要主持人重新安排` }];
  const questions = [{ type: 'choice', name: 'speaker',
    instructions: '主持人预排的安排已用完或被取消，主持人可能有意只安排到这里。对照主持简报、当前焦点和主持人最近的安排，判断下一位应请谁发言。', choices }];
  const answers = await decide(home, scheduler, state, questions, fetch_impl);
  const judged = judged_of(state, questions, answers);
  const choice = answers.speaker?.choice;
  const confidence = certainty(answers.speaker);
  const sure = confidence !== null && confidence >= ROUTE_CONFIDENCE;
  if (sure && candidates.includes(choice)) return { action: 'next', expert: choice, confidence, ...judged, label: `本轮继续，请 ${choice} 接着发言` };
  return { action: 'host', confidence, ...judged, label: choice === HOST_CHOICE && sure ? '没有明确该谁发言，交给主持人安排' : unsure_label(candidates.includes(choice) ? `请 ${choice} 发言` : choice === HOST_CHOICE ? '交给主持人' : '') };
}

/**
 * At the end of a round without named follow-ups: continue with another peer round, or wake the host
 * (to conclude, or because the discussion drifted, repeats itself or is stuck). The first speaker is never the last one.
 */
export async function decide_round(home, scheduler, { title, goal, user_request, context, host, experts, last_speaker, ...extra }, fetch_impl) {
  const candidates = experts.filter(name => name !== last_speaker);
  if (!candidates.length) return { action: 'host', confidence: null, label: '没有可选的下一轮首位，交给主持人' };
  // Telling repetition or drift needs at least the last two rounds side by side.
  const recent = context.slice(-ROUTE_CONTEXT_MESSAGES).map(excerpt);
  const state = [topic_lines(title, goal, user_request, extra), recent.length ? `本轮及最近发言（旧→新）：\n${recent.join('\n')}` : '还没有发言。'].join('\n\n');
  const questions = [{ type: 'choice', name: 'next', instructions: '一轮发言刚结束。对照讨论目标、主持简报与当前焦点判断：下一轮是否还有明确的内容可以让大家互相回应、追问或补充？', choices: [
    { value: 'continue', description: '继续下一轮：最近发言里有未回应的分歧、追问或可展开的点，或简报规定的流程还没走完' },
    { value: HOST_CHOICE, description: `交给主持人 ${host}：目标已经达成可以收束，或最近发言在重复、偏离目标、卡住，需要主持人引导` }] }];
  questions.push({ type: 'choice', name: 'first', instructions: '下一轮应先请谁发言？按简报分工或接龙顺序判断；没有规定时选被其他专家点名追问、需要回应的人；没有明确依据时交主持人安排。',
    choices: [...candidates.map(name => ({ value: name, description: `先请 ${name}：简报规定下一轮由其开头，或最近发言点名追问了该成员` })),
      { value: HOST_CHOICE, description: `交给主持人 ${host}：没有明确规定首位，也没有点名追问；仅仅有未决分歧不足以确定先请谁` }] });
  const answers = await decide(home, scheduler, state, questions, fetch_impl);
  const judged = judged_of(state, questions, answers);
  const choice = answers.next?.choice;
  const confidence = certainty(answers.next);
  // A wrong "continue" costs a whole round of runs, so it needs the same certainty as waking everyone.
  if (choice !== 'continue' || confidence === null || confidence < ROUTE_WIDE_CONFIDENCE) {
    const sure = confidence !== null && confidence >= (choice === 'continue' ? ROUTE_WIDE_CONFIDENCE : ROUTE_CONFIDENCE);
    return { action: 'host', confidence, ...judged, label: choice === HOST_CHOICE && sure ? '建议收束或调整方向，交给主持人' : unsure_label(choice === 'continue' ? '继续下一轮' : choice === HOST_CHOICE ? '收束或调整方向' : '') };
  }
  const first = answers.first?.choice;
  const first_confidence = certainty(answers.first);
  if (!candidates.includes(first) || first_confidence === null || first_confidence < ROUTE_CONFIDENCE) {
    return { action: 'host', confidence: first_confidence, ...judged, label: '下一轮首位没有明确依据或把握不足，交给主持人安排' };
  }
  return { action: 'continue', first, confidence, ...judged, label: `继续下一轮，先请 ${first} 发言` };
}

/**
 * Regression eval for smart scheduling: run the fixed cases in jev_cases.json against the real decision model and
 * compare each choice and its probability with the expected answer (and optionally with an earlier run).
 * Not part of `npm test`: it sends the case texts to the provider and is billed per call.
 *
 *   node tests/jev_eval.mjs [--provider jev] [--model jev-latest] [--only S1a,G,round] [--out FILE] [--baseline FILE]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { saved_api_keys } from '../runner/discussion_api.mjs';
import { service_home } from '../runner/discussion_service.mjs';
import { DISCUSSION_PROMPT_VERSION, REVIEW_PROMPT_VERSION, ROUTE_PROMPT_VERSION, SCHEDULER_PROVIDERS, decide_group_order, decide_interjection, decide_review_completion,
  decide_next_speaker, decide_round, route_free_message } from '../runner/scheduler.mjs';

const { values: options } = parseArgs({ options: { provider: { type: 'string', default: 'jev' }, model: { type: 'string' },
  only: { type: 'string' }, out: { type: 'string' }, baseline: { type: 'string' } } });
const { fixtures, cases } = JSON.parse(readFileSync(new URL('./jev_cases.json', import.meta.url), 'utf8'));
const home = service_home();
const provider = SCHEDULER_PROVIDERS[options.provider];
if (!provider) throw new Error(`供应商只能为 ${Object.keys(SCHEDULER_PROVIDERS).join(' / ')}`);
const api_key_ref = saved_api_keys(home)[provider.base_url];
if (!api_key_ref) throw new Error(`本机服务目录 ${home} 没有 ${provider.base_url} 的密钥，请先在新建房间面板保存`);
const scheduler = { provider: options.provider, model: options.model || provider.models[0], base_url: provider.base_url, api_key_ref };

/** Run one case through the same function the runner uses; returns what the system did and what the model chose. */
async function run_case(item) {
  const context = item.context || [];
  const message = { id: Math.max(0, ...context.map(entry => entry.id)) + 1, author: '用户', text: item.message, reply_to: item.reply_to };
  const free = fixtures.free;
  if (item.scene === 'review') {
    const result = await decide_review_completion(home, scheduler, { ready: true, original: { id: 1, author: '主持人', text: item.original },
      plan: { reviewer_name: 'Codex-评审', scope: '核对本批实现和验证' },
      deliveries: item.answers.map((answer, index) => ({ member: String.fromCharCode(65 + index), status: 'completed', answer,
        execution_status: item.reports[index], result: item.reports[index] })) });
    return { result, acted: result.action === 'review' ? 'review' : '__host__' };
  }
  const talk = { ...fixtures.discussion, brief: item.brief ?? fixtures.discussion.brief, arrangement: item.arrangement, context };
  if (item.scene === 'route') {
    const result = await route_free_message(home, scheduler, { title: free.title, goal: free.goal, context, message, host: free.host, members: item.members || free.members });
    return { result, acted: { member: result.member, all: '__all__', none: '__none__' }[result.action] || '__host__' };
  }
  if (item.scene === 'group') {
    const members = [free.host.name, ...free.members.map(member => member.name)];
    const descriptions = [free.host, ...free.members];
    const result = await decide_group_order(home, scheduler, { title: free.title, goal: free.goal, context, message, members, descriptions });
    return { result, acted: { all: 'parallel', sequential: 'sequential' }[result.action] || '__host__' };
  }
  if (item.scene === 'interjection') {
    const experts = [...new Set([...(item.waiting || []), ...(item.spoken || []), talk.host])];
    const result = await decide_interjection(home, scheduler, { ...talk, message, experts, spoken: item.spoken });
    return { result, acted: { ask: result.expert, note: '__note__' }[result.action] || '__host__' };
  }
  if (item.scene === 'next_speaker') {
    const result = await decide_next_speaker(home, scheduler, { ...talk, candidates: item.candidates, spoken: item.spoken });
    return { result, acted: result.action === 'next' ? result.expert : '__host__' };
  }
  const result = await decide_round(home, scheduler, { ...talk, last_speaker: talk.experts.at(-1) });
  return { result, acted: result.action === 'continue' ? 'continue' : '__host__' };
}

/** PASS: the model chose the expected option and the system acted on it. WEAK: only one of the two. FAIL: neither. */
function status_of(expect, choice, acted) {
  if (choice === expect && acted === expect) return 'PASS';
  return choice === expect || acted === expect ? 'WEAK' : 'FAIL';
}

/** Check both the intended first speaker and the actual continuation, including a deliberate handback. */
function first_status(item, result, acted) {
  const first = result.detail[1];
  const chosen = result.detail[0].choice === item.expect && first?.choice === item.expect_first;
  const applied = item.expect_first === '__host__' ? acted === '__host__' : acted === 'continue' && result.first === item.expect_first;
  return chosen && applied ? 'PASS' : chosen || applied ? 'WEAK' : 'FAIL';
}

const filters = options.only ? options.only.split(',') : null;
const selected = cases.filter(item => !filters || filters.some(filter => item.id === filter || item.id.startsWith(filter) || item.scene === filter));
const baseline = options.baseline ? Object.fromEntries(JSON.parse(readFileSync(options.baseline, 'utf8')).results.map(item => [item.id, item])) : {};
const results = [];
for (const item of selected) {
  try {
    const { result, acted } = await run_case(item);
    const asked = result.detail[0];
    const probability = asked.probabilities?.[item.expect] ?? null;
    const entry = { id: item.id, scene: item.scene, note: item.note, expect: item.expect, choice: asked.choice, acted,
      confidence: result.confidence ?? null, expected_probability: probability, probabilities: asked.probabilities, duration_ms: asked.duration_ms,
      status: item.expect_first ? first_status(item, result, acted) : status_of(item.expect, asked.choice, acted),
      ...(item.expect_first ? { expect_first: item.expect_first, first_choice: result.detail[1]?.choice ?? null,
        first: result.first ?? null, first_probabilities: result.detail[1]?.probabilities ?? {} } : {}) };
    results.push(entry);
    const before = baseline[item.id]?.expected_probability;
    const delta = typeof before === 'number' && typeof probability === 'number' ? `  Δ${(probability - before >= 0 ? '+' : '')}${(probability - before).toFixed(2)}` : '';
    const top = Object.entries(asked.probabilities || {}).sort((left, right) => right[1] - left[1]).slice(0, 3)
      .map(([value, share]) => `${value} ${Number(share).toFixed(2)}`).join(' / ');
    const first = item.expect_first ? ` · 首位 ${entry.first_choice} → ${entry.first ?? '未安排'}（期望 ${item.expect_first}）` : '';
    console.log(`${entry.status.padEnd(4)} ${item.id.padEnd(4)} ${item.scene.padEnd(12)} 期望 ${item.expect} · 选 ${asked.choice} · 执行 ${acted} · 期望项概率 ${probability?.toFixed?.(2) ?? '-'}${delta} · ${asked.duration_ms}ms  [${top}]${first}  ${item.note}`);
  } catch (error) {
    results.push({ id: item.id, scene: item.scene, expect: item.expect, status: 'ERROR', error: error.message });
    console.log(`ERROR ${item.id} ${error.message}`);
  }
}
const count = status => results.filter(item => item.status === status).length;
console.log(`\n${scheduler.provider}/${scheduler.model} · 路由提示版本 ${ROUTE_PROMPT_VERSION} · 讨论提示版本 ${DISCUSSION_PROMPT_VERSION} · 评审提示版本 ${REVIEW_PROMPT_VERSION} · `
  + `PASS ${count('PASS')} / WEAK ${count('WEAK')} / FAIL ${count('FAIL')} / ERROR ${count('ERROR')}，共 ${results.length} 条`);
if (options.out) writeFileSync(options.out, JSON.stringify({ provider: scheduler.provider, model: scheduler.model, route_prompt: ROUTE_PROMPT_VERSION,
  discussion_prompt: DISCUSSION_PROMPT_VERSION, review_prompt: REVIEW_PROMPT_VERSION, ran_at: new Date().toISOString(), results }, null, 2));
if (count('FAIL') || count('ERROR')) process.exitCode = 1;

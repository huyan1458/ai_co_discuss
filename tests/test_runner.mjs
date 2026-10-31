import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, existsSync, readFileSync, readdirSync, realpathSync, statSync, utimesSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { listen_local } from './local_port.mjs';
import { DiscussionStore, load_config, service_drafts, validate_config } from '../runner/discussion_runner.mjs';
import { cwd_key, free_task_files, FreeRoomRunner, review_capability_version, workspace_snapshot } from '../runner/free_runner.mjs';
import { SessionDriver } from '../runner/session_driver.mjs';

import { EXPERT_PROMPT_PRESETS, expert_prompt, free_task_text, software_rules } from '../runner/expert_prompts.mjs';
import { system_prompt } from '../runner/adapters/api.mjs';
import { assert_shared_home, DiscussionService, migrate_service_home, read_registry, register_room, service_pid, service_ready, start_service, sweep_service_home, unregister_room } from '../runner/discussion_service.mjs';
import { launch_discussion, restore_room, room_models, room_profiles } from '../runner/discussion_launch.mjs';
import { adapter_of, deliver_task } from '../runner/adapters/index.mjs';
import { adopted_fork, claude_exit_error, claude_inbox_ready, claude_rule_path, standalone_claude_env } from '../runner/adapters/claude.mjs';
import { codex_permissions } from '../runner/adapters/codex_cli.mjs';
import { codex_target } from '../runner/adapters/codex_app.mjs';
import { agy_rule, antigravity_project, prepare_agy_project, remove_agy_projects } from '../runner/adapters/antigravity_cli.mjs';
import { kill_process_tree, run_program, TASK_SUBCOMMANDS } from '../runner/adapters/common.mjs';
import { MAX_EXECUTION_NOTES, MAX_EXECUTION_SEGMENTS, MAX_NOTES_PER_REPORT, MAX_SEGMENTS_PER_REPORT, SegmentLog } from '../runner/execution_progress.mjs';
const activity_phase = (adapter, event) => adapter_of(adapter).events.phase(event);
const activity_tool = (adapter, event) => adapter_of(adapter).events.tool(event);
const progress_note = (adapter, event, responses) => adapter_of(adapter).events.note(event, responses);
import { save_api_key, saved_api_keys } from '../runner/discussion_api.mjs';
import { certainty, decide, decide_group_order, decide_review_completion, DISCUSSION_GUIDED_PROMPT_VERSION, decide_interjection, decide_next_speaker, decide_round, ROUTE_CONFIDENCE, ROUTE_WIDE_CONFIDENCE, route_free_message, scheduler_thresholds, scheduler_answers, scheduler_check, scheduler_request, SCHEDULER_PROVIDERS, scheduler_state, validate_scheduler } from '../runner/scheduler.mjs';

/** The folded record of what the provider was asked is checked on its own. */
const without_detail = ({ detail, input, ...plan }) => (assert.ok(Array.isArray(detail) && detail[0].choices.length && input.state && input.questions[0].instructions), plan);

test('review capability excludes borrowed access, additional grants and writable project drafts', () => {
  const member = { access: 'runner', session_mode: 'new', adapter: 'codex_cli' };
  const profile = { adapter: 'codex_cli', project_access: 'read', cwd: resolve('review-project') };
  const config = { directory: resolve('review-runtime'), draft_directory: resolve('review-drafts') };
  const version = review_capability_version(profile, member, config);
  assert.match(version, /^[a-f0-9]{64}$/);
  for (const extra of [{ project_access: 'write' }, { project_access: 'own' }, { adapter: 'api' }, { adapter: 'claude' },
    { adapter: 'antigravity_cli' }, { allowed_tools: ['Bash(*)'] }]) {
    assert.equal(review_capability_version({ ...profile, ...extra }, { ...member, adapter: extra.adapter || member.adapter }, config), '');
  }
  assert.equal(review_capability_version(profile, { ...member, session_mode: 'borrowed' }, config), '');
  assert.equal(review_capability_version(profile, member, { ...config, draft_directory: join(profile.cwd, 'drafts') }), '');
  assert.notEqual(review_capability_version({ ...profile, cwd: resolve('another-project') }, member, config), version);
});

test('review capability synchronization publishes once and revokes changed permissions without leaking paths', async t => {
  const writes = [];
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body); writes.push(payload);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ revision: 'member-r1', capability: payload.read_only ? { config_version: payload.config_version } : null }));
  });
  await listen_local(server);
  t.after(() => new Promise(resolve => server.close(resolve)));
  const member = { id: 1, name: 'Codex', adapter: 'codex_cli', access: 'runner', session_mode: 'new', review_capability: { revision: 'member-r1', capability: null } };
  const config = { site: `http://127.0.0.1:${server.address().port}`, room: 'review-room', token: 'owner-token'.repeat(4),
    directory: resolve('review-runtime'), draft_directory: resolve('review-drafts'),
    participants: { Codex: { adapter: 'codex_cli', project_access: 'read', cwd: resolve('review-project') } } };
  const runner = { config, context_errors: new Map(), log: assert.fail };
  await FreeRoomRunner.prototype.sync_review_capabilities.call(runner, { members: [member] });
  await FreeRoomRunner.prototype.sync_review_capabilities.call(runner, { members: [member] });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].revision, 'member-r1');
  assert.doesNotMatch(JSON.stringify(writes), /review-project|review-runtime|owner-token/);
  config.participants.Codex.project_access = 'write';
  await FreeRoomRunner.prototype.sync_review_capabilities.call(runner, { members: [member] });
  assert.deepEqual(writes[1], { revision: 'member-r1', read_only: false });
  assert.equal(member.review_capability.capability, null);
});

test('review delivery refuses a changed local permission before contacting the site', async () => {
  const member = { id: 1, name: 'Codex', adapter: 'codex_cli', access: 'runner', session_mode: 'new' };
  const config = { site: 'http://127.0.0.1:1', room: 'review-room', directory: resolve('review-runtime'),
    draft_directory: resolve('review-drafts'), participants: { Codex: { adapter: 'codex_cli', project_access: 'read', cwd: resolve('review-project') } } };
  const proof = { config_version: review_capability_version(config.participants.Codex, member, config) };
  config.participants.Codex.project_access = 'write';
  await assert.rejects(FreeRoomRunner.prototype.check_review_delivery.call({ config, context_errors: new Map() }, member, { review: proof }), /本机配置与预授权能力版本不符/);
});

test('smart scheduling maps one neutral question set to both providers and reads their answers alike', async t => {
  const home = mkdtempSync(join(tmpdir(), 'scheduler-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const questions = [{ type: 'choice', name: 'handler', instructions: '交给谁？', choices: [{ value: 'Codex', description: '写代码' }, { value: '__host__', description: '主持人' }] },
    { type: 'predicate', name: 'urgent', instructions: '是否紧急？' }];
  const jev = validate_scheduler(home, { provider: 'jev', model: 'jev-1.13', ...save_api_key(home, { base_url: SCHEDULER_PROVIDERS.jev.base_url, api_key: 'jev-key' }) });
  assert.deepEqual(scheduler_request(jev, '状态', questions), { path: '/systemone', body: { model: 'jev-1.13', state: '状态', questions: {
    handler: { type: 'choice', instructions: '交给谁？', criteria: { Codex: '写代码', __host__: '主持人' } }, urgent: { type: 'noul', instructions: '是否紧急？' } } } });
  assert.deepEqual(scheduler_answers(jev, { answers: { handler: { type: 'choice', choice: 'Codex', confidence: 0.9, probabilities: { Codex: 0.9, __host__: 0.1 } }, urgent: { type: 'noul', noul: 0.2 } } }),
    { handler: { choice: 'Codex', confidence: 0.9, probabilities: { Codex: 0.9, __host__: 0.1 } }, urgent: { probability: 0.2 } });
  const decisions = validate_scheduler(home, { provider: 'decisions', model: 'gpt-6-luna', ...save_api_key(home, { base_url: SCHEDULER_PROVIDERS.decisions.base_url, api_key: 'openai-key' }) });
  assert.deepEqual(scheduler_request(decisions, '状态', questions).body.questions, [
    { type: 'choice', name: 'handler', instructions: '交给谁？', choices: [{ value: 'Codex', description: '写代码' }, { value: '__host__', description: '主持人' }] },
    { type: 'predicate', name: 'urgent', instructions: '是否紧急？' }]);
  assert.deepEqual(scheduler_answers(decisions, { answers: [{ type: 'choice', name: 'handler', choice: 'Codex', confidence: 0.9, probabilities: [{ value: 'Codex', probability: 0.9 }, { value: '__host__', probability: 0.1 }] },
    { type: 'predicate', name: 'urgent', probability: 0.2 }] }), { handler: { choice: 'Codex', confidence: 0.9, probabilities: { Codex: 0.9, __host__: 0.1 } }, urgent: { probability: 0.2 } });
  // A key saved for another root is refused, and a provider error exposes only its status.
  assert.throws(() => validate_scheduler(home, { ...jev, provider: 'decisions' }), /Base URL 已变化/);
  const failing = async () => ({ ok: false, status: 401, json: async () => ({ error: 'secret detail' }) });
  await assert.rejects(decide(home, jev, '状态', questions, failing), error => /HTTP 401/.test(error.message) && !error.message.includes('secret detail'));
  // A free-room message moves only on a confident pick; everyone or no one needs the higher threshold, anything else stays with the host.
  const reply = (choice, confidence) => async () => ({ ok: true, json: async () => ({ answers: { handler: { type: 'choice', choice, confidence, probabilities: {} } } }) });
  const input = { title: '房间', context: [], message: { id: 3, author: '用户', text: '修一下登录', reply_to: 2 }, host: { name: 'Claude', description: 'Claude（Claude Code）' },
    members: [{ name: 'Codex', description: 'Codex CLI' }] };
  // The guided wording (default) has its own lower thresholds; the stable one keeps 0.7 / 0.85.
  const limits = scheduler_thresholds('guided');
  const routed = await route_free_message(home, jev, input, reply('Codex', 0.95));
  assert.deepEqual([routed.action, routed.member, routed.detail[0].choices], ['member', 'Codex', ['Codex', '__host__', '__all__', '__all_seq__', '__none__']]);
  assert.equal((await route_free_message(home, jev, input, reply('Codex', limits.member - 0.01))).action, 'host');
  assert.equal((await route_free_message(home, { ...jev, mode: 'stable' }, input, reply('Codex', ROUTE_CONFIDENCE - 0.01))).action, 'host');
  assert.equal((await route_free_message(home, jev, input, reply('Codex', limits.member))).action, 'member');
  assert.equal((await route_free_message(home, jev, input, reply('__host__', 0.99))).action, 'host');
  assert.equal((await route_free_message(home, jev, input, reply('__all__', limits.wide))).action, 'all');
  assert.equal((await route_free_message(home, jev, input, reply('__all__', limits.wide - 0.01))).action, 'host');
  assert.equal((await route_free_message(home, { ...jev, mode: 'stable' }, input, reply('__all__', ROUTE_WIDE_CONFIDENCE - 0.01))).action, 'host');
  assert.equal((await route_free_message(home, jev, input, reply('__none__', 0.99))).action, 'none');
  // Everyone in turn is a guided-only choice with the wide threshold.
  assert.equal((await route_free_message(home, jev, input, reply('__all_seq__', limits.wide))).action, 'sequential');
  assert.equal((await route_free_message(home, jev, input, reply('__all_seq__', limits.wide - 0.01))).action, 'host');
  // When the text names two or more members, each group of them is one choice; it needs the wide threshold.
  let named_sent;
  const pair = { ...input, members: [...input.members, { name: 'Gemini', description: 'Gemini CLI' }], message: { id: 4, author: '用户', text: 'codex 和 Gemini 分别看一下' } };
  const picked = await route_free_message(home, jev, pair, async (url, init) => { named_sent = JSON.parse(init.body); return reply('__some__:Codex、Gemini', limits.wide)(); });
  assert.ok(Object.keys(named_sent.questions.handler.criteria).includes('__some__:Codex、Gemini'));
  assert.deepEqual([picked.action, picked.members], ['some', ['Codex', 'Gemini']]);
  assert.equal((await route_free_message(home, jev, pair, reply('__some__:Codex、Gemini', limits.wide - 0.01))).action, 'host');
  await route_free_message(home, jev, input, async (url, init) => { named_sent = JSON.parse(init.body); return reply('__host__', 0.9)(); });
  assert.ok(!Object.keys(named_sent.questions.handler.criteria).some(key => key.startsWith('__some__')));
  assert.match(scheduler_state('房间', [], input.message), /#3 用户（回复 #2）：修一下登录/);
  // The guided mode (default) describes the room and each member in the state; options say what each choice leads to.
  let sent_to_model;
  await route_free_message(home, jev, input, async (url, init) => { sent_to_model = JSON.parse(init.body); return reply('__host__', 0.99)(); });
  assert.match(sent_to_model.state, /成员（名字不区分大小写）：\n- 主持人 Claude/);
  const route_question = sent_to_model.questions.handler;
  assert.match(route_question.instructions, /用户想让谁来回应/);
  assert.match(route_question.criteria.__all__, /彼此看不到对方的回答/);
  // The stable mode keeps the roster line and the ordered checklist, where a name outranks continuing the previous answer.
  await route_free_message(home, { ...jev, mode: 'stable' }, input, async (url, init) => { sent_to_model = JSON.parse(init.body); return reply('__host__', 0.99)(); });
  assert.match(sent_to_model.state, /房间成员（名字不区分大小写）：Claude（主持人）、Codex/);
  assert.match(sent_to_model.questions.handler.instructions, /按下面的顺序：1）正文叫了某位成员的名字.*选该成员，即使上一条是别人的回答/);
  assert.doesNotMatch(sent_to_model.questions.handler.criteria.__host__, /延续主持人自己的回答/);
  // Both @全体成员 directions require confidence; weak and invalid answers keep the task with the host.
  const order = (choice, confidence) => async () => ({ ok: true, json: async () => ({ answers: { order: { type: 'choice', choice, confidence, probabilities: {} } } }) });
  const group = { title: '房间', context: [], message: { id: 4, author: '用户', text: '@全体成员 接龙' }, members: ['Claude', 'Codex'] };
  assert.equal((await decide_group_order(home, jev, group, order('sequential', ROUTE_CONFIDENCE))).action, 'sequential');
  assert.equal((await decide_group_order(home, jev, group, order('sequential', ROUTE_CONFIDENCE - 0.01))).action, 'host');
  assert.equal((await decide_group_order(home, jev, group, order('parallel', ROUTE_CONFIDENCE))).action, 'all');
  assert.equal((await decide_group_order(home, jev, group, order('parallel', ROUTE_CONFIDENCE - 0.01))).action, 'host');
  assert.equal((await decide_group_order(home, jev, group, order('__host__', 0.99))).action, 'host');
  assert.equal((await decide_group_order(home, jev, group, order('invalid', 0.99))).action, 'host');
  assert.equal((await decide_group_order(home, jev, group, scheduler_fetch({}))).action, 'host');
  // The configuration check asks one yes/no question and rejects an answer without a probability.
  const checked = [];
  assert.deepEqual(await scheduler_check(home, jev, async (url, init) => { checked.push([url, JSON.parse(init.body)]);
    return { ok: true, json: async () => ({ answers: { check: { type: 'noul', noul: 0.97 } } }) }; }), { ok: true });
  assert.deepEqual([checked[0][0], Object.keys(checked[0][1].questions)], ['https://api.typesafe.ai/v1/systemone', ['check']]);
  await assert.rejects(scheduler_check(home, jev, async () => ({ ok: true, json: async () => ({ answers: {} }) })), /未返回可用答案/);
  await assert.rejects(scheduler_check(home, { ...jev, provider: 'other' }), /供应商只能为/);
  // Discussion interjections act only on a confident note or ask; anything else goes to the host.
  const handling = (choice, confidence) => async () => ({ ok: true, json: async () => ({ answers: { handling: { type: 'choice', choice, confidence, probabilities: {} } } }) });
  const interjection = { ...input, experts: ['Codex'] };
  assert.equal((await decide_interjection(home, jev, interjection, handling('__note__', 0.9))).action, 'note');
  assert.deepEqual(without_detail(await decide_interjection(home, jev, interjection, handling('Codex', 0.85))), { action: 'ask', expert: 'Codex', confidence: 0.85, label: '先请 Codex 回应这条留言' });
  assert.equal((await decide_interjection(home, jev, interjection, handling('__note__', limits.member - 0.01))).action, 'host');
  // Experts who already spoke are not options, so the model is told who has spoken and that such a message goes to the host.
  let interjected;
  await decide_interjection(home, jev, { ...interjection, spoken: ['Gemini'] }, async (url, init) => { interjected = JSON.parse(init.body); return handling('__host__', 0.9)(); });
  assert.match(interjected.state, /本轮已发言：Gemini；本轮尚未发言：Codex/);
  assert.doesNotMatch(interjected.questions.handling.criteria.__host__, /本轮已发言的专家/);
  // A round continues only on a confident "continue", and never opens with the last speaker.
  let sent;
  const round = (next, confidence, first, first_confidence = 0.9) => async (url, init) => { sent = JSON.parse(init.body);
    return { ok: true, json: async () => ({ answers: { next: { type: 'choice', choice: next, confidence, probabilities: {} }, first: { type: 'choice', choice: first, confidence: first_confidence, probabilities: {} } } }) }; };
  const discussion = { title: '讨论', context: [], host: 'Claude', experts: ['Codex', 'Gemini', 'Grok'], last_speaker: 'Grok' };
  assert.deepEqual(without_detail(await decide_round(home, jev, discussion, round('continue', 0.9, 'Gemini'))), { action: 'continue', first: 'Gemini', confidence: 0.9, label: '继续下一轮，先请 Gemini 发言' });
  assert.deepEqual(Object.keys(sent.questions.first.criteria), ['Codex', 'Gemini', '__host__']);
  assert.equal((await decide_round(home, jev, discussion, round('continue', 0.9, 'Grok'))).action, 'host');
  assert.equal((await decide_round(home, jev, discussion, round('continue', 0.9, 'Codex', limits.member - 0.01))).action, 'host');
  assert.equal((await decide_round(home, jev, discussion, round('continue', 0.9, 'Codex', limits.member))).action, 'continue');
  assert.equal((await decide_round(home, jev, discussion, round('continue', 0.9, '__host__'))).action, 'host');
  const single = { ...discussion, experts: ['Codex', 'Grok'] };
  assert.equal((await decide_round(home, jev, single, round('continue', 0.9, 'Codex', limits.member - 0.01))).action, 'host');
  assert.deepEqual(Object.keys(sent.questions.first.criteria), ['Codex', '__host__']);
  assert.equal((await decide_round(home, jev, single, round('continue', 0.9, 'Codex'))).first, 'Codex');
  assert.equal((await decide_round(home, jev, { ...discussion, experts: ['Grok'] }, async () => assert.fail('no candidate must not call a model'))).action, 'host');
  // A wrong "continue" costs a whole round, so it needs the wide threshold.
  assert.equal((await decide_round(home, jev, discussion, round('continue', limits.wide - 0.01, 'Codex'))).action, 'host');
  assert.equal((await decide_round(home, jev, discussion, round('continue', limits.wide, 'Codex'))).action, 'continue');
  assert.equal((await decide_round(home, jev, discussion, round('__host__', 0.99, 'Codex'))).action, 'host');
  // The chosen option's probability decides; Jev's lower two-way `confidence` is only a fallback.
  const probable = async () => ({ ok: true, json: async () => ({ answers: { next: { type: 'choice', choice: 'continue', confidence: 0.64,
    probabilities: { continue: 0.88, __host__: 0.12 } }, first: { type: 'choice', choice: 'Codex', confidence: 0.3, probabilities: { Codex: 0.7 } } } }) });
  assert.deepEqual([(await decide_round(home, jev, discussion, probable)).action, (await decide_round(home, jev, discussion, probable)).confidence], ['continue', 0.88]);
  assert.equal((await decide_round(home, jev, single, scheduler_fetch({ next: { type: 'choice', choice: 'continue', confidence: 0.99 } }))).action, 'host');
  assert.equal(certainty({ choice: 'a', confidence: 0.5, probabilities: {} }), 0.5);
  assert.equal((await decide_round(home, jev, discussion, round('continue', 0.6, 'Codex'))).label, '倾向继续下一轮，把握不足，交给主持人');
  // Mid-round, the next speaker comes from the unspoken candidates; unsure or host goes back to the host.
  const speaker = (choice, confidence) => async () => ({ ok: true, json: async () => ({ answers: { speaker: { type: 'choice', choice, confidence, probabilities: {} } } }) });
  const midround = { title: '讨论', context: [], host: 'Claude', candidates: ['Codex', 'Gemini'] };
  const asked = [];
  await decide_next_speaker(home, jev, { ...midround, brief: '甲出上句', focus: '接龙', arrangement: 'Codex：出句', spoken: ['Claude'] }, async (url, init) => { asked.push(JSON.parse(init.body)); return speaker('Gemini', 0.9)(); });
  assert.match(asked[0].state, /主持简报[^\n]*甲出上句/);
  assert.match(asked[0].state, /本轮已发言：Claude；本轮尚未发言：Codex、Gemini/);
  assert.match(asked[0].state, /主持人最近的安排：Codex：出句/);
  assert.equal(typeof (await decide_next_speaker(home, jev, midround, speaker('Gemini', 0.9))).detail[0].duration_ms, 'number');
  assert.deepEqual(without_detail(await decide_next_speaker(home, jev, midround, speaker('Gemini', 0.9))), { action: 'next', expert: 'Gemini', confidence: 0.9, label: '本轮继续，请 Gemini 接着发言' });
  assert.equal((await decide_next_speaker(home, jev, midround, speaker('Gemini', limits.member - 0.01))).action, 'host');
  assert.equal((await decide_next_speaker(home, jev, midround, speaker('__host__', 0.95))).action, 'host');
  // One question; the guided wording explains that the host may have stopped on purpose, the stable one names it as no basis.
  assert.deepEqual(Object.keys(asked[0].questions), ['speaker']);
  assert.match(asked[0].questions.speaker.instructions, /有意只安排到这里/);
  await decide_next_speaker(home, { ...jev, mode: 'stable' }, midround, async (url, init) => { asked.push(JSON.parse(init.body)); return speaker('Gemini', 0.9)(); });
  assert.match(asked.at(-1).questions.speaker.criteria.__host__, /仅仅是本轮还没发言不算依据/);
  // The guided interjection sees who speaks next, so a question to that expert can wait for the turn.
  let upcoming_sent;
  await decide_interjection(home, jev, { ...interjection, upcoming: ['Gemini', 'Codex'] }, async (url, init) => { upcoming_sent = JSON.parse(init.body); return handling('__note__', 0.9)(); });
  assert.match(upcoming_sent.state, /接下来按安排发言：Gemini → Codex/);
});

/** Make task files without a website or a real model. */
function task_fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'session-task-test-'));
  t.after(() => { rmSync(directory, { recursive: true, force: true }); rmSync(`${directory}-drafts`, { recursive: true, force: true }); });
  return { config: { mode: 'free', site: 'https://discussion.test', room: 'room', token: 'o'.repeat(32), directory,
    project: resolve('.'), members: { Codex: { token: 'm'.repeat(32) } }, participants: { Codex: { adapter: 'codex' } } } };
}

/** Generate the same request-backed task for a host or a scheduled speaker. */
function session_task(config, { role = 'host', ...options } = {}, binding = {}) {
  const request = { id: 7, message_id: 9, purpose: role === 'host' ? 'discuss_host' : 'discuss',
    session_request_id: 5, session_id: 3, round: 1, position: 1, read_until: role === 'host' ? null : 0,
    source_question: '核对方案并回答', cause_kind: role === 'host' ? 'session_start' : 'scheduled_speaker' };
  return free_task_files(config, { name: 'Codex', role }, { id: 1, read_until: 0, requests: [request] }, binding,
    { session: { id: 3, status: 'active', phase: 'initial' }, process_access: false, ...options });
}

test('host tasks carry scheduling suggestions only when there are some', t => {
  const f = task_fixture(t);
  session_task(f.config);
  assert.equal(JSON.parse(readFileSync(join(f.config.directory, 'free-1.task.json'), 'utf8')).scheduler_suggestions, undefined);
  const suggestions = [{ message_id: 9, suggestion: '请 Claude 回应', confidence: 0.82 }];
  session_task(f.config, { suggestions });
  const task = JSON.parse(readFileSync(join(f.config.directory, 'free-1.task.json'), 'utf8'));
  assert.deepEqual(task.scheduler_suggestions, suggestions);
  assert.equal(task.discussion_request.purpose, 'discuss_host');
  assert.equal(task.session.phase, 'initial');
});

test('API profiles need a bound key but no software or filesystem permission', t => {
  const home = mkdtempSync(join(tmpdir(), 'api-config-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const base_url = 'https://openrouter.ai/api/v1';
  const key = save_api_key(home, { base_url, api_key: 'test-only-key' });
  const input = { site: 'https://discussion.test', room: 'api-room', token: 'owner'.repeat(8), api_home: home, project_access: 'write',
    participants: { Grok: { adapter: 'api', api_protocol: 'chat', base_url, model: 'vendor/model.1', ...key, project_access: 'write', cwd: home } } };
  const config = validate_config(input, home);
  assert.equal(config.participants.Grok.project_access, 'read');
  assert.equal(config.participants.Grok.cwd, undefined);
  assert.equal(config.participants.Grok.executable, undefined);
  assert.throws(() => validate_config({ ...input, participants: { Grok: { ...input.participants.Grok, base_url: 'https://api.x.ai/v1' } } }, home), /重新填写/);
  assert.deepEqual(saved_api_keys(home), { [base_url]: key.api_key_ref });
});

test('a stopped legacy service directory moves with its paths and drafts rewritten', t => {
  const root = mkdtempSync(join(tmpdir(), 'service-move-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const from = join(root, 'legacy'), to = join(root, '.codiscuss'), runtime = join(from, 'launches', 'key', 'runtime');
  const external = join(root, 'external-config.json');
  mkdirSync(runtime, { recursive: true });
  mkdirSync(service_drafts(from, runtime), { recursive: true });
  writeFileSync(join(service_drafts(from, runtime), 'turn-1-submission.json'), '{}');
  const config = { api_home: from, data_directory: runtime, draft_directory: service_drafts(from, runtime), note: `see ${from}` };
  writeFileSync(join(from, 'launches', 'key', 'config.json'), JSON.stringify(config));
  writeFileSync(external, JSON.stringify({ api_home: from, data_directory: join(root, 'elsewhere') }));
  writeFileSync(join(from, 'rooms.json'), JSON.stringify({ configs: [join(from, 'launches', 'key', 'config.json'), external] }));
  writeFileSync(join(from, 'runner.lock'), String(process.pid));
  assert.equal(migrate_service_home(from, to), false);
  rmSync(join(from, 'runner.lock'));
  assert.equal(migrate_service_home(from, to), true);
  const moved_runtime = join(to, 'launches', 'key', 'runtime');
  assert.deepEqual(JSON.parse(readFileSync(join(to, 'launches', 'key', 'config.json'), 'utf8')),
    { ...config, api_home: to, data_directory: moved_runtime, draft_directory: service_drafts(to, moved_runtime) });
  assert.deepEqual(read_registry(to), [join(to, 'launches', 'key', 'config.json'), external]);
  assert.equal(JSON.parse(readFileSync(external, 'utf8')).api_home, to);
  assert.ok(existsSync(join(service_drafts(to, moved_runtime), 'turn-1-submission.json')));
  assert.ok(!existsSync(from));
});

/** Exercise free-room execution delivery against an HTTP contract without starting real software. */
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'discussion-test-'));
  const request = { id: 1, message_id: 1, purpose: 'ask', status: 'pending' };
  const member = { id: 1, name: 'Codex', role: 'host', access: 'runner', pending: [request] };
  const room = { title: '自由协作', mode: 'free', phase: 'free', host: 'Codex', latest_id: 1,
    members: [{ id: 1, name: 'Codex', role: 'host', access: 'runner', status: 'active' }],
    limits: { reached: false, max_minutes: 0 }, session: null };
  const observers = [];
  const calls = [];
  const limits = { reached: false };
  const failures = {};
  const executions = new Map();
  let next_execution_id = 1;
  const active_executions = () => [...executions.values()].filter(item => ['dispatched', 'started'].includes(item.status));
  const add_request = (fields = {}) => {
    const id = Math.max(0, ...member.pending.map(item => item.id), ...[...executions.values()].flatMap(item => item.requests.map(row => row.id))) + 1;
    const row = { id, message_id: id, purpose: 'ask', status: 'pending', ...fields };
    member.pending.push(row); room.latest_id = Math.max(room.latest_id, row.message_id);
    return row;
  };
  const finish_execution = (id, status = 'completed', result = '') => {
    const execution = executions.get(id);
    if (execution) Object.assign(execution, { status, result, finished_at: Math.floor(Date.now() / 1000) });
  };
  const server = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk;
    const body = text ? JSON.parse(text) : null;
    const route = request.url.replace(/^\/api\/rooms\/[^/]+/, '');
    let result, status = 200;
    if (route === '/inbox') {
      for (const execution of active_executions()) {
        if (execution.lease_until <= Math.floor(Date.now() / 1000)) finish_execution(execution.id, 'failed', '执行租约到期');
      }
      if (room.session?.status === 'active' && limits.reached) {
        room.session.status = 'concluded'; room.phase = 'concluded';
        for (const execution of active_executions()) finish_execution(execution.id, 'cancelled', 'limit_reached');
        member.pending = [];
      }
      result = { archived: false, members: [member], observers, executions: active_executions(), execution_minutes: 60 };
    } else if (route === '/' || route === '') result = { ...room, limits: { ...limits, ...room.limits } };
    else if (route.startsWith('/messages?after=')) result = { messages: [] };
    else if (route === '/executions' && request.method === 'POST') {
      calls.push('reserve');
      const failure = failures.reserve;
      delete failures.reserve;
      if (failure === 'before') { request.socket.destroy(); return; }
      let execution = [...executions.values()].find(item => item.client_id === body.client_id);
      if (!execution) {
        execution = { id: next_execution_id++, client_id: body.client_id, member: member.name, status: 'dispatched',
          created_at: Math.floor(Date.now() / 1000), lease_until: Math.floor(Date.now() / 1000) + 120,
          requests: member.pending.map(item => ({ ...item, member: member.name })), read_until: 0, retry: null };
        executions.set(execution.id, execution);
        const requested_ids = new Set(execution.requests.map(item => item.id));
        member.pending = member.pending.filter(item => !requested_ids.has(item.id));
      }
      if (failure === 'after') { request.socket.destroy(); return; }
      result = execution;
    } else if (route.startsWith('/executions/')) {
      const id = Number(route.split('/')[2]);
      const execution = executions.get(id);
      if (!execution) { status = 404; result = { error: '执行不存在' }; }
      else if (request.method === 'GET') result = execution;
      else {
        calls.push(body.action);
        if (body.action === 'renew') { execution.status = 'started'; execution.lease_until = Math.floor(Date.now() / 1000) + 120; }
        if (body.action === 'fail') finish_execution(id, 'failed', body.reason);
        if (body.action === 'release') {
          finish_execution(id, 'cancelled', body.reason);
          member.pending.push(...execution.requests.map(item => ({ ...item, status: 'pending' })));
        }
        if (body.action === 'retry_wait') execution.retry = { attempt: body.attempt, retry_at: body.retry_at, reason: body.reason };
        if (body.action === 'retry_start') { execution.retry = null; execution.status = 'dispatched'; }
        result = execution;
      }
    } else if (route === '/discussion') result = { session: room.session, revision: 'session-revision' };
    else if (route === '/scheduler-routing' || route === '/scheduler-decisions') result = {};
    else { status = 404; result = { error: '未找到' }; }
    response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(result));
  });
  await listen_local(server);
  const store = new DiscussionStore(directory);
  t.after(async () => { store.close(); await new Promise(resolve => server.close(resolve));
    rmSync(directory, { recursive: true, force: true }); rmSync(`${directory}-drafts`, { recursive: true, force: true }); });
  const config = { site: `http://127.0.0.1:${server.address().port}`, room: 'room', token: 'private-token', directory, project: directory,
    members: { Codex: { token: 'member-token' } }, participants: { Codex: { adapter: 'codex' } } };
  return { store, request, member, observers, room, calls, config, limits, failures, executions, add_request, finish_execution,
    current_execution: () => [...executions.values()].at(-1) };
}

test('room model readback uses registered choices, adds the software settings for empty ones, and excludes paths and credentials', async t => {
  const home = mkdtempSync(join(tmpdir(), 'discussion-models-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const path = join(home, 'room.json');
  const config = { site: 'http://127.0.0.1:8765', room: 'models', token: 'private-owner-token'.repeat(3),
    data_directory: join(home, 'runtime'), participants: {
      Codex: { adapter: 'codex_cli', executable: process.execPath, model: 'gpt-6-astra', effort: 'xhigh', session_id: 'private-session' },
      Claude: { adapter: 'claude', executable: process.execPath },
      Gemini: { adapter: 'antigravity', ipc_directory: home, model: 'stale-cli-choice', effort: 'high' },
    } };
  writeFileSync(path, JSON.stringify(config));
  register_room(home, path);
  writeFileSync(join(home, 'launch-settings.json'), JSON.stringify({ participants: { Claude: { model: 'wrong-default', effort: 'max' } } }));
  // The software's own settings are read for empty choices; point both CLIs at private copies.
  const saved_env = { CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  t.after(() => { for (const [key, value] of Object.entries(saved_env)) value === undefined ? delete process.env[key] : process.env[key] = value; });
  process.env.CODEX_HOME = join(home, 'codex');
  process.env.CLAUDE_CONFIG_DIR = join(home, 'claude');
  mkdirSync(process.env.CODEX_HOME);
  writeFileSync(join(process.env.CODEX_HOME, 'config.toml'), 'model = "gpt-6-sol"\nmodel_reasoning_effort = "high"\n[profiles.deep]\nmodel = "ignored"\n');
  const input = { site: config.site, room_id: config.room };
  const none = { default_model: '', default_effort: '', project_access: 'read', own_project: false };
  assert.deepEqual(await room_models(home, input), { room_id: 'models', registered: true, participants: {
    Codex: { adapter: 'codex_cli', model: 'gpt-6-astra', effort: 'xhigh', default_model: 'gpt-6-sol', default_effort: 'high', project_access: 'read', own_project: false },
    Claude: { adapter: 'claude', model: '', effort: '', ...none },
    Gemini: { adapter: 'antigravity', model: '', effort: '', ...none },
  }, scheduler: null });
  mkdirSync(process.env.CLAUDE_CONFIG_DIR);
  writeFileSync(join(process.env.CLAUDE_CONFIG_DIR, 'settings.json'), JSON.stringify({ model: 'opus', effortLevel: 'high' }));
  assert.deepEqual((await room_models(home, input)).participants.Claude,
    { adapter: 'claude', model: '', effort: '', default_model: 'opus', default_effort: 'high', project_access: 'read', own_project: false });
  config.participants.Gemini = { adapter: 'antigravity_cli', executable: process.execPath, model: 'gemini-4-argon-high' };
  writeFileSync(path, JSON.stringify(config));
  // agy keeps its default in the software and answers its native /model; stub that query here.
  const agy = { read_defaults: profile => profile.adapter === 'antigravity_cli' ? { model: 'gemini-4-argon-medium', effort: 'medium' } : { model: '', effort: '' } };
  // A quick read leaves agy's slow default query for later and says so.
  assert.deepEqual((await room_models(home, { ...input, quick: true }, { read_defaults: profile => profile.adapter === 'antigravity_cli' ? assert.fail('agy must not be queried') : { model: '', effort: '' } })).participants.Gemini,
    { defaults_pending: true, adapter: 'antigravity_cli', model: 'gemini-4-argon-high', effort: '', default_model: '', default_effort: '', project_access: 'read', own_project: false });
  assert.deepEqual((await room_models(home, input, agy)).participants.Gemini,
    { adapter: 'antigravity_cli', model: 'gemini-4-argon-high', effort: '', default_model: 'gemini-4-argon-medium', default_effort: 'medium', project_access: 'read', own_project: false });
  assert.deepEqual(await room_models(home, { ...input, room_id: 'missing' }), { room_id: 'missing', registered: false, participants: {}, scheduler: null });
  assert.deepEqual((await room_models(home, { ...input, site: 'https://other.example' })).participants, {});
  await assert.rejects(() => room_models(home, { ...input, room_id: '../models' }), /房间编号无效/);
  config.scheduler = { provider: 'jev', model: 'jev-decide', api_key_ref: 'private-key-ref' };
  writeFileSync(path, JSON.stringify(config));
  assert.deepEqual((await room_models(home, input, agy)).scheduler, { provider: 'jev', model: 'jev-decide', mode: 'guided' });
  config.participants.Codex.project_access = 'write';
  writeFileSync(path, JSON.stringify(config));
  assert.equal((await room_models(home, input, agy)).participants.Codex.project_access, 'write');
  config.participants.Gemini.session_id = 'own-agy-conversation';
  writeFileSync(path, JSON.stringify(config));
  assert.equal((await room_models(home, input, agy)).participants.Gemini.own_project, true);
  // What a session last ran with comes from its log; only known values are added.
  const read_session = (adapter, session_id) => session_id === 'private-session' ? { model: 'gpt-6-astra', effort: 'medium' } : { model: '', effort: '' };
  const sessions = (await room_models(home, input, { ...agy, read_session })).participants;
  assert.equal(sessions.Codex.actual_model, 'gpt-6-astra');
  assert.equal(sessions.Codex.actual_effort, 'medium');
  assert.equal('actual_model' in sessions.Claude, false);
});

test('a backup carries local member sessions, and restoring it resumes them while Claude Code stays manual', async t => {
  const home = mkdtempSync(join(tmpdir(), 'discussion-restore-'));
  const saved_env = { CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  const token = 'owner-token'.repeat(4);
  const server = createServer((request, response) => {
    const ok = request.headers['x-discussion-token'] === token;
    response.writeHead(ok ? 200 : 403, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(!ok ? { error: '凭据无效' } : request.url.endsWith('/inbox') ? { requests: [] }
      : { mode: 'free', free: { members: [{ name: 'Claude-评审', access: 'manual', status: 'away' }] } }));
  });
  await listen_local(server);
  t.after(async () => {
    for (const [key, value] of Object.entries(saved_env)) value === undefined ? delete process.env[key] : process.env[key] = value;
    await new Promise(resolve => server.close(resolve));
    rmSync(home, { recursive: true, force: true });
  });
  process.env.CODEX_HOME = join(home, 'codex');
  process.env.CLAUDE_CONFIG_DIR = join(home, 'claude');
  mkdirSync(join(process.env.CODEX_HOME, 'sessions', '2026'), { recursive: true });
  writeFileSync(join(process.env.CODEX_HOME, 'sessions', '2026', 'rollout-codex-session-1.jsonl'), '{}\n');
  mkdirSync(join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'work'), { recursive: true });
  writeFileSync(join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'work', 'claude-session-1.jsonl'), `${JSON.stringify({ cwd: home })}\n`);
  const site = `http://127.0.0.1:${server.address().port}`;
  const path = join(home, 'source.json');
  writeFileSync(path, JSON.stringify({ site, room: 'source', token, mode: 'free', cwd: home, data_directory: join(home, 'runtime'),
    members: { Codex: { token: 'codex-member'.repeat(3) }, Claude: { token: 'claude-member'.repeat(3) } }, participants: {
      Codex: { adapter: 'codex_cli', executable: process.execPath, model: 'gpt-6-astra', effort: 'xhigh' },
      Claude: { adapter: 'claude', executable: process.execPath, session_id: 'claude-session-1', system_prompt: '只看测试' } } }));
  register_room(home, path);
  const store = new DiscussionStore(join(home, 'runtime'));
  store.bind('Codex', 'codex-session-1');
  store.close();

  await assert.rejects(() => room_profiles(home, { site, room_id: 'source', token: 'wrong-token'.repeat(4) }), /HTTP 403/);
  const { local_members } = await room_profiles(home, { site, room_id: 'source', token });
  assert.deepEqual(local_members.participants, {
    Codex: { adapter: 'codex_cli', executable: process.execPath, model: 'gpt-6-astra', effort: 'xhigh', session_id: 'codex-session-1' },
    Claude: { adapter: 'claude', executable: process.execPath, session_id: 'claude-session-1', system_prompt: '只看测试' } });
  assert.doesNotMatch(JSON.stringify(local_members), /codex-member|claude-member|owner-token/);
  assert.deepEqual(await room_profiles(home, { site, room_id: 'unregistered', token }), { room_id: 'unregistered', local_members: null });

  const result = await restore_room(home, { site, room_id: 'restored', token, local_members });
  assert.deepEqual(result, { room_id: 'restored', registered: true, members: [
    { name: 'Codex', status: 'resumed', session_id: 'codex-session-1' },
    { name: 'Claude', status: 'manual', session_id: 'claude-session-1', cwd: home,
      resume: { command: 'claude --resume claude-session-1', cwd: home } }] });
  const restored = JSON.parse(readFileSync(read_registry(home).find(item => item !== resolve(path)), 'utf8'));
  assert.equal(restored.room, 'restored');
  assert.deepEqual(Object.keys(restored.participants), ['Codex']);
  assert.equal(restored.participants.Codex.session_id, 'codex-session-1');
  assert.deepEqual(restored.keep_manual, ['Claude-评审', 'Claude']);
  await assert.rejects(() => restore_room(home, { site, room_id: 'restored', token, local_members }), /已在本机登记/);

  const lost = structuredClone(local_members);
  lost.participants.Codex.session_id = 'missing-session';
  const base_url = 'https://api.deepseek.com/v1';
  lost.participants.DeepSeek = { adapter: 'api', api_protocol: 'chat', base_url, model: 'deepseek-flash',
    ...save_api_key(home, { base_url, api_key: 'test-only-key' }), session_id: 'api-binding-1' };
  const missing = await restore_room(home, { site, room_id: 'lost', token, local_members: lost });
  assert.match(missing.members[0].error, /找不到 Codex CLI 会话 missing-session/);
  assert.equal(missing.members[0].status, 'failed');
  assert.deepEqual(missing.members[2], { name: 'DeepSeek', status: 'resumed', session_id: '' });
});

test('agy project records survive a concluded room and are dropped only after the room is deleted', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'discussion-deleted-'));
  const room = { deleted: false, unrelated_404: false };
  const server = createServer((request, response) => {
    response.statusCode = room.deleted || (room.unrelated_404 && request.url.endsWith('/inbox')) ? 404 : 200;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(room.deleted ? { error: '房间不存在' } : room.unrelated_404 ? { error: '成员不存在' }
      : request.url.endsWith('/inbox') ? { archived: false, members: [], observers: [], executions: [] }
        : { title: '已收束', phase: 'concluded', mode: 'free', limits: {}, session: null }));
  });
  await listen_local(server);
  const store = new DiscussionStore(directory);
  t.after(async () => { store.close(); await new Promise(resolve => server.close(resolve)); rmSync(directory, { recursive: true, force: true }); });
  const record = join(directory, `agy-project-${'a'.repeat(64)}.json`);
  writeFileSync(record, JSON.stringify({ project_id: randomUUID(), session_id: 'kept-session' }));
  const runner = new FreeRoomRunner({ site: `http://127.0.0.1:${server.address().port}`, room: 'room', token: 'private-token', members: {}, participants: {},
    directory, participants: { Gemini: { adapter: 'antigravity_cli' } } }, store, async () => assert.fail('must not deliver'));
  await runner.tick();
  assert.ok(existsSync(record));
  room.unrelated_404 = true;
  await assert.rejects(runner.tick(), /HTTP 404: 成员不存在/);
  assert.ok(existsSync(record), 'an unrelated 404 must not delete the room project binding');
  room.unrelated_404 = false;
  room.deleted = true;
  await assert.rejects(runner.tick(), /房间不存在/);
  assert.equal(existsSync(record), false);
});

test('a restarted free-room runner does not redeliver an active member request', async t => {
  const f = await fixture(t); let sent = 0;
  const deliver = async () => { sent++; return { status: 'accepted', session_id: 'actual-chat' }; };
  await new FreeRoomRunner(f.config, f.store, deliver).tick();
  await new FreeRoomRunner(f.config, f.store, deliver).tick();
  assert.equal(sent, 1);
  assert.equal(f.store.binding('Codex').session_id, 'actual-chat');
  assert.equal(f.calls.filter(action => action === 'reserve').length, 1);
});

test('a manual observer without a local profile is never reserved for runner delivery', async t => {
  const f = await fixture(t); let sent = 0;
  f.member.pending = [];
  f.observers.push({ id: 2, name: 'Qwen', role: 'member', access: 'manual', pending: [{ id: 2, message_id: 2, purpose: 'ask' }] });
  await new FreeRoomRunner(f.config, f.store, async () => { sent++; return { status: 'accepted' }; }).tick();
  assert.equal(sent, 0); assert.equal(f.calls.filter(action => action === 'reserve').length, 0);
});

test('a participant whose previous process is still exiting is not resumed until it closes', async t => {
  const f = await fixture(t); let sent = 0;
  const runner = new FreeRoomRunner(f.config, f.store, async () => { sent++; return { status: 'accepted' }; });
  const previous = new EventEmitter();
  runner.track('Codex', previous);
  await runner.tick();
  assert.equal(sent, 0); assert.equal(f.calls.filter(action => action === 'reserve').length, 0);
  previous.emit('close', 0);
  await runner.tick();
  assert.equal(sent, 1);
});

test('a reached discussion limit is observed before another member request is delivered', async t => {
  const f = await fixture(t); let sent = 0;
  f.room.session = { id: 1, status: 'active' };
  f.limits.reached = true;
  const runner = new FreeRoomRunner(f.config, f.store, async () => { sent++; });
  await runner.tick();
  assert.equal(sent, 0); assert.equal(f.room.session.status, 'concluded');
  assert.deepEqual([f.room.mode, f.room.phase], ['free', 'concluded']);
  assert.equal(f.calls.includes('reserve'), false);
});

test('a reached discussion limit ends once and later ticks do not deliver cancelled work', async t => {
  const f = await fixture(t);
  f.room.session = { id: 1, status: 'active' };
  Object.assign(f.limits, { reached: true });
  const runner = new FreeRoomRunner(f.config, f.store, async () => ({ status: 'accepted' }));
  await runner.tick();
  await runner.tick();
  assert.equal(f.room.session.status, 'concluded');
  assert.deepEqual([f.room.mode, f.room.phase], ['free', 'concluded']);
});

test('an uncertain software delivery is failed without a blind resend', async t => {
  const f = await fixture(t); let sent = 0;
  const deliver = async () => { sent++; throw new Error('receipt lost'); };
  await new FreeRoomRunner(f.config, f.store, deliver).tick();
  assert.equal(f.current_execution().status, 'failed');
  const runner = new FreeRoomRunner(f.config, f.store, deliver);
  await runner.tick();
  assert.equal(sent, 1);
  assert.equal(f.calls.filter(action => action === 'fail').length, 1);
});

test('a queued delivery can remain active across runner restarts without a duplicate invocation', async t => {
  const f = await fixture(t); let sent = 0;
  const deliver = async () => { sent++; return { status: 'accepted', session_id: 'busy-host-chat' }; };
  await new FreeRoomRunner(f.config, f.store, deliver).tick();
  f.store.db.prepare('UPDATE free_deliveries SET last_renew=? WHERE member=?').run(Date.now() - 31 * 60_000, 'Codex');
  const runner = new FreeRoomRunner(f.config, f.store, deliver);
  await runner.tick();
  assert.equal(f.current_execution().status, 'started');
  assert.equal(f.calls.includes('renew'), true); assert.equal(f.calls.includes('fail'), false);
  assert.equal(sent, 1);
});

test('confirmed non-delivery retries the same member request with a new execution', async t => {
  const f = await fixture(t); const attempts = [];
  const deliver = async (adapter, binding, task) => {
    const task_file = JSON.parse(readFileSync(join(task.directory, `${task.id}.task.json`), 'utf8'));
    attempts.push({ request_ids: task_file.requests.map(request => request.id), access: JSON.parse(readFileSync(task.access_path, 'utf8')) });
    if (attempts.length === 1) throw Object.assign(new Error('spawn unavailable'), { delivery_status: 'not_sent' });
    return { status: 'accepted' };
  };
  await new FreeRoomRunner(f.config, f.store, deliver).tick();
  assert.equal(f.current_execution().status, 'cancelled');
  await new FreeRoomRunner(f.config, f.store, deliver).tick();
  assert.deepEqual(attempts[0].request_ids, attempts[1].request_ids);
  assert.equal(attempts[0].access.token, attempts[1].access.token);
  assert.equal(attempts[0].access.session_id, attempts[1].access.session_id);
  assert.notEqual(attempts[0].access.execution_id, attempts[1].access.execution_id);
  assert.equal(f.executions.size, 2);
  assert.deepEqual(f.current_execution().requests.map(item => item.id), [f.request.id]);
});

test('three confirmed delivery failures fail one execution without pausing the room', async t => {
  const f = await fixture(t); let sent = 0;
  const deliver = async () => { sent++; throw Object.assign(new Error('executable missing'), { delivery_status: 'not_sent' }); };
  for (let attempt = 0; attempt < 3; attempt++) await new FreeRoomRunner(f.config, f.store, deliver).tick();
  assert.equal(sent, 3); assert.equal(f.current_execution().status, 'failed');
  assert.match(f.current_execution().result, /3 次|executable missing/);
  assert.equal(f.room.session?.status, undefined);
});

test('a member answer recorded before retry suppresses another invocation', async t => {
  const f = await fixture(t); let sent = 0;
  const runner = new FreeRoomRunner(f.config, f.store, async () => {
    sent++; throw Object.assign(new Error('spawn unavailable'), { delivery_status: 'not_sent' });
  });
  await runner.tick();
  f.member.pending = [];
  f.finish_execution(f.current_execution().id, 'completed', 'answer_saved');
  await new FreeRoomRunner(f.config, f.store, async () => { sent++; }).tick();
  assert.equal(sent, 1);
  assert.equal(f.current_execution().status, 'completed');
});

test('reserve response loss is reconciled by client id before invoking software', async t => {
  for (const failure of ['before', 'after']) {
    const f = await fixture(t); let sent = 0;
    const deliver = async () => { sent++; return { status: 'accepted' }; };
    f.failures.reserve = failure;
    await assert.rejects(new FreeRoomRunner(f.config, f.store, deliver).tick(), /fetch failed/);
    const client_id = f.store.db.prepare('SELECT client_id FROM free_deliveries WHERE member=?').get('Codex').client_id;
    assert.equal(sent, 0);
    await new FreeRoomRunner(f.config, f.store, deliver).tick();
    assert.equal(sent, 1); assert.equal(f.executions.size, 1);
    assert.equal(f.current_execution().client_id, client_id);
  }
});

test('a restart at the software invocation boundary fails for review instead of blindly resending', async t => {
  const f = await fixture(t); let sent = 0;
  await new FreeRoomRunner(f.config, f.store, async () => { sent++; return { status: 'accepted' }; }).tick();
  const id = f.current_execution().id;
  f.store.db.prepare("UPDATE free_deliveries SET status='delivering' WHERE member='Codex'").run();
  await new FreeRoomRunner(f.config, f.store, async () => { sent++; return { status: 'accepted' }; }).tick();
  assert.equal(sent, 1); assert.equal(f.executions.get(id).status, 'failed');
});

test('an uncertain delivery stays failed when the discussion reaches its limit', async t => {
  const f = await fixture(t); let sent = 0;
  f.room.session = { id: 1, status: 'active' };
  const runner = new FreeRoomRunner(f.config, f.store, async () => { sent++; throw new Error('receipt lost'); });
  await runner.tick(); f.limits.reached = true;
  await runner.tick();
  assert.equal(sent, 1); assert.equal(f.room.session.status, 'concluded');
  assert.deepEqual([f.room.mode, f.room.phase], ['free', 'concluded']);
  assert.equal(f.current_execution().status, 'failed');
});

test('an expired execution lease ends that execution without restarting the AI task', async t => {
  const f = await fixture(t); let sent = 0;
  const runner = new FreeRoomRunner(f.config, f.store, async () => { sent++; return { status: 'accepted' }; });
  await runner.tick(); f.current_execution().status = 'started'; f.current_execution().lease_until = Math.floor(Date.now() / 1000) - 1;
  await runner.tick();
  assert.equal(f.current_execution().status, 'failed'); assert.equal(sent, 1);
});

test('Claude errors reported with exit code 0 are recognized, including usage limits', () => {
  const limited = JSON.stringify({ type: 'result', is_error: true, api_error: 'usage_limit_reached', result: "You've hit your session limit · resets 2pm" });
  assert.match(claude_exit_error(0, `${limited}
`), /session limit/);
  assert.equal(claude_exit_error(1, 'not json'), 'Claude 退出码 1');
  assert.equal(claude_exit_error(0, JSON.stringify({ type: 'result', is_error: false, result: '完成' })), '');
});

test('a software error fails its execution at once with the cause instead of waiting for the lease', async t => {
  const f = await fixture(t);
  const runner = new FreeRoomRunner(f.config, f.store, async (adapter, binding, task) => {
    setImmediate(() => task.on_failure('Claude 执行出错：usage limit'));
    return { status: 'accepted' };
  });
  await runner.tick(); await delay(5);
  await runner.tick();
  assert.equal(f.current_execution().status, 'failed'); assert.equal(f.current_execution().result, 'Claude 执行出错：usage limit');
});

test('a session that exits without saving its result fails after rechecking the execution', async t => {
  const f = await fixture(t);
  const runner = new FreeRoomRunner(f.config, f.store, async (adapter, binding, task) => {
    setImmediate(() => task.on_exit());
    return { status: 'accepted' };
  });
  await runner.tick(); await delay(5);
  await runner.tick();
  assert.equal(f.current_execution().status, 'failed'); assert.match(f.current_execution().result, /会话已结束，但未提交本次回答.*请核对原会话/);
});

test('a late Sidecar receipt is reconciled without another request', async t => {
  const f = await fixture(t); let sent = 0;
  f.config.participants.Codex = { adapter: 'antigravity', ipc_directory: f.config.directory };
  const runner = new FreeRoomRunner(f.config, f.store, async () => { sent++; return { status: 'sidecar_pending' }; });
  await runner.tick();
  const path = join(f.config.directory, 'free-1.result.json');
  writeFileSync(path, JSON.stringify({ status: 'accepted', session_id: 'real-session' }));
  await runner.tick();
  assert.equal(f.store.db.prepare('SELECT status FROM free_deliveries WHERE member=?').get('Codex').status, 'running');
  assert.equal(f.store.binding('Codex').session_id, 'real-session'); assert.equal(sent, 1);
});

test('only an executable that never starts is classified as safe to retry', async t => {
  const f = await fixture(t);
  await assert.rejects(run_program(join(f.config.directory, 'missing-executable'), []), error => error.delivery_status === 'not_sent');
  await assert.rejects(run_program(process.execPath, ['-e', 'process.exit(1)']), error => !error.delivery_status);
  await assert.rejects(run_program(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeout: 50 }), error => !error.delivery_status);
});

for (const adapter of ['claude', 'codex_cli', 'antigravity_cli']) {
test(`${adapter} spawn failure can retry without binding an uncreated session`, async t => {
  const f = await fixture(t);
  f.config.participants.Codex = { adapter, executable: join(f.config.directory, 'missing-executable') };
  const runner = new FreeRoomRunner(f.config, f.store,
    (config, binding, task) => deliver_task(config, binding, task, undefined, join(f.config.directory, 'user')));
  await runner.tick(); await delay(10);
  assert.equal(f.calls.includes('release'), true);
  assert.equal(f.store.binding('Codex').session_id, undefined);
  await new FreeRoomRunner(f.config, f.store, runner.deliver).tick();
  assert.equal(f.executions.size, 2);
});
}

/** Emit real subprocess output in split UTF-8 chunks without invoking an AI account. */
function fake_cli(events, options = {}) {
  const calls = [];
  const config_calls = [];
  const source = `
    const fs = require('node:fs');
    (async () => {
      let input = ''; for await (const chunk of process.stdin) input += chunk;
      fs.writeFileSync('stdin.txt', input);
      process.stderr.write(${JSON.stringify(options.stderr || 'diagnostic 中文')});
      const output = Buffer.from(${JSON.stringify(events.map(event => JSON.stringify(event)).join('\r\n') + '\r\n')});
      const split = Math.max(1, output.indexOf(Buffer.from('中文')) + 1);
      process.stdout.write(output.subarray(0, split));
      await new Promise(resolve => setTimeout(resolve, 5));
      process.stdout.write(output.subarray(split));
      if (${Boolean(options.linger)}) setInterval(() => {}, 1000);
      process.exitCode = ${options.exit_code || 0};
    })();`;
  const spawn_process = (executable, args, settings) => {
    if (args[0] === 'app-server') {
      const name = JSON.parse(args.find(arg => arg.startsWith('default_permissions=')).split('=')[1]);
      const config = { default_permissions: name, permissions: { [name]: {} }, ...options.codex_config };
      const source = `require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
        const request = JSON.parse(line);
        const result = request.id === 1 ? { userAgent: 'Codex Desktop/${options.codex_version || '0.163.0'} (test)' } : { config: ${JSON.stringify(config)} };
        process.stdout.write(JSON.stringify({ id: request.id, result }) + '\\n');
      });`;
      const child = spawn(process.execPath, ['-e', source], settings);
      config_calls.push({ args, child, closed: once(child, 'close') });
      return child;
    }
    const child = spawn(process.execPath, ['-e', source], settings);
    calls.push({ executable, args, settings, child, closed: once(child, 'close') });
    return child;
  };
  return { calls, config_calls, spawn_process };
}

/** Represent the documented startup and terminal events of the two CLI protocols. */
test('an agy turn ended by a denied command names the command in the pause reason', async t => {
  const f = await fixture(t);
  f.config.participants.Codex = { adapter: 'antigravity_cli', executable: process.execPath };
  const denied = { event: 'step_update', step_update: { state: 'ERROR', step_type: 'tool', tool_name: 'run_command',
    tool_info: { parameters: { CommandLine: 'Get-ChildItem -Recurse' }, error: { type: 'TOOL_ERROR', message: 'permission check failed: user denied permission' } } } };
  const events = [{ event: 'init', conversation_id: 'agy-session' }, denied,
    { event: 'result', result: { conversation_id: 'agy-session', status: 'SUCCESS', response: '' } }];
  const process_fixture = fake_cli(events);
  const runner = new FreeRoomRunner(f.config, f.store,
    (config, binding, task) => deliver_task(config, binding, task, process_fixture.spawn_process, join(f.config.directory, 'user')));
  await runner.tick(); await process_fixture.calls[0].closed; await runner.tick();
  assert.equal(f.current_execution().status, 'failed');
  assert.match(f.current_execution().result, /运行了未授权的命令「Get-ChildItem -Recurse」/);
});

test('refused operations are reported with the rule that would allow them', async t => {
  // Claude names them in its final result line, even when the turn itself succeeded.
  const result = { type: 'result', is_error: false, result: '完成', permission_denials: [
    { tool_name: 'PowerShell', tool_input: { command: 'cd D:/notes && lark-cli docs get abc' } },
    { tool_name: 'Write', tool_input: { file_path: join(tmpdir(), 'outside', 'b.txt') } },
    { tool_name: 'WebFetch', tool_input: { url: 'https://example.com' } }] };
  const claude = await cli_delivery_fixture(t, 'claude', { events: [result] });
  assert.deepEqual(claude.errors, []);
  assert.deepEqual(claude.denials.map(item => item.rule), ['PowerShell(lark-cli *)', `Edit(${claude_rule_path(join(tmpdir(), 'outside'))}/**)`, 'WebFetch']);
  assert.equal(claude.denials[0].detail, 'cd D:/notes && lark-cli docs get abc');
  // agy names the check that failed in each refused step; a refused turn still ends with SUCCESS.
  const step = (tool_name, parameters, message) => ({ event: 'step_update', step_update: { state: 'ERROR', step_type: 'tool', tool_name,
    tool_info: { parameters, error: { type: 'TOOL_ERROR', message } } } });
  const agy = await cli_delivery_fixture(t, 'antigravity_cli', { events: [{ event: 'init', conversation_id: 'agy-session' },
    step('run_command', { CommandLine: 'git --version' }, 'permission check failed for unsandboxed "git --version": user denied permission'),
    step('write_file', { Path: join(tmpdir(), 'outside', 'b.txt') }, 'permission check failed for write_file "b.txt": user denied permission'),
    { event: 'result', result: { conversation_id: 'agy-session', status: 'SUCCESS', response: '', denied_actions: [{ action: 'command' }] } }] });
  assert.deepEqual(agy.denials.map(item => item.rule), ['unsandboxed_command(git --version)', `write_file(${resolve(tmpdir(), 'outside').replaceAll('\\', '/')})`]);
});

test('a refused turn without a failed step still names what agy refused', async t => {
  const agy = await cli_delivery_fixture(t, 'antigravity_cli', { events: [{ event: 'init', conversation_id: 'agy-session' },
    { event: 'result', result: { conversation_id: 'agy-session', status: 'SUCCESS', response: '', denied_actions: [{ action: 'command', display_name: 'RunCommand' }] } }] });
  assert.equal(agy.exits, 1);
  assert.deepEqual(agy.denials, []);
});

function cli_events(adapter, session_id = 'actual-cli-session') {
  return adapter === 'codex_cli'
    ? [{ type: 'thread.started', thread_id: session_id }, { type: 'item.completed', item: { text: '中文' } }, { type: 'turn.completed' }]
    : [{ event: 'init', conversation_id: session_id }, { event: 'result', result: { conversation_id: session_id, status: 'SUCCESS', response: '中文' } }];
}

/** Capture adapter callbacks and private credentials in an isolated task directory. */
async function cli_delivery_fixture(t, adapter, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'discussion-cli-adapter-'));
  const directory = join(root, 'runtime');
  const user_home = join(root, 'user');
  mkdirSync(directory);
  const draft_directory = join(root, 'drafts');
  mkdirSync(draft_directory);
  const access_path = join(directory, 'access.json');
  writeFileSync(access_path, JSON.stringify({ token: 'test-only', session_id: '' }));
  const bindings = []; const errors = []; const denials = []; let exits = 0;
  const process_fixture = fake_cli(options.events || cli_events(adapter), options);
  t.after(async () => {
    for (const call of [...process_fixture.calls, ...process_fixture.config_calls]) {
      if (call.child.exitCode === null && call.child.signalCode === null) call.child.kill();
      await call.closed;
    }
    rmSync(root, { recursive: true, force: true });
  });
  const task = { id: 'event-1', participant: 'Gemini', directory, draft_directory, access_path, prompt: '讨论中文 "quotes"\n$(literal); `literal`',
    skills_directory: join(directory, 'skills'),
    on_binding: session => bindings.push(session), on_process: () => {},
    on_output: (path, chunk) => appendFileSync(path, chunk), on_failure: error => errors.push(error), on_exit: () => { exits++; }, on_denials: list => denials.push(...list) };
  const config = { adapter, executable: process.execPath, ...options.config };
  const result = await deliver_task(config, options.binding || {}, task, process_fixture.spawn_process, user_home);
  await process_fixture.calls[0].closed;
  return { directory, user_home, config, access_path, task, result, bindings, errors, denials, exits, ...process_fixture };
}

for (const source of ['stderr', 'event']) {
test(`codex_cli explains an active writer from ${source} without replacing the original session`, async t => {
  const conflict = 'thread-store conflict: thread original-session already has an active writer';
  const f = await cli_delivery_fixture(t, 'codex_cli', {
    binding: { session_id: 'original-session' }, exit_code: 1,
    events: source === 'event' ? [{ type: 'error', message: conflict }, { type: 'error', message: 'models refresh timed out' }] : [],
    stderr: source === 'stderr' ? `${conflict}\n${'models refresh timed out\n'.repeat(100)}` : undefined,
  });
  assert.match(f.errors[0], /original-session.*active writer/);
  assert.match(f.errors[0], /Codex App 接入/);
  assert.doesNotMatch(f.errors[0], /models refresh/);
  assert.equal(f.calls.length, 1); assert.equal(f.exits, 0); assert.deepEqual(f.bindings, []);
  assert.equal(JSON.parse(readFileSync(f.access_path, 'utf8')).session_id, 'original-session');
});
}

for (const adapter of ['codex_cli', 'antigravity_cli']) {
test(`${adapter} starts headlessly, binds emitted identity and preserves UTF-8 prompt and logs`, async t => {
  const f = await cli_delivery_fixture(t, adapter);
  assert.equal(f.result.status, 'accepted'); assert.deepEqual(f.errors, []); assert.equal(f.exits, 1);
  assert.equal(f.bindings[0], 'actual-cli-session');
  assert.equal(JSON.parse(readFileSync(f.access_path, 'utf8')).session_id, 'actual-cli-session');
  const call = f.calls[0];
  assert.equal(call.settings.cwd, f.task.draft_directory); assert.equal(call.settings.shell, false);
  assert.equal(call.settings.windowsHide, true); assert.ok(call.args.includes(f.task.draft_directory));
  assert.ok(!call.args.some(arg => arg.startsWith('--dangerously')));
  if (adapter === 'codex_cli') {
    assert.equal(call.args[0], 'exec'); assert.ok(call.args.includes('--json'));
    assert.ok(call.args.includes('--skip-git-repo-check')); assert.equal(call.args.at(-1), '-');
    assert.equal(readFileSync(join(f.task.draft_directory, 'stdin.txt'), 'utf8'), f.task.prompt);
    const overrides = call.args.filter((arg, index) => call.args[index - 1] === '-c');
    assert.equal(overrides[2], 'approval_policy="never"');
    // On Windows the sandbox's TEMP moves into the writable drafts, so PowerShell keeps FullLanguage and UTF-8 output.
    const drafts = JSON.stringify(resolve(f.task.draft_directory).replaceAll('\\', '/'));
    assert.deepEqual(overrides.slice(3), process.platform === 'win32'
      ? [`shell_environment_policy.set.TEMP=${drafts}`, `shell_environment_policy.set.TMP=${drafts}`] : []);
    assert.match(overrides[1], /extends=":read-only"/); assert.match(overrides[1], /network=\{enabled=true\}/);
    assert.ok(overrides[1].includes(`${JSON.stringify(f.directory.replaceAll('\\', '/'))}="read"`));
    assert.ok(overrides[1].includes(`${JSON.stringify(f.task.draft_directory.replaceAll('\\', '/'))}="write"`));
    assert.deepEqual(f.config_calls[0].args.slice(1), call.args.slice(call.args.indexOf('-c'), call.args.indexOf('--json')));
    assert.ok(!call.args.includes('--add-dir'));
  } else {
    assert.ok(call.args.includes(f.task.skills_directory));
    assert.equal(call.args[call.args.indexOf('-p') + 1], f.task.prompt);
    assert.equal(call.args[call.args.indexOf('--output-format') + 1], 'stream-json');
    assert.equal(call.args[call.args.indexOf('--print-timeout') + 1], '0');
    assert.match(call.args[call.args.indexOf('--project') + 1], /^[a-f0-9-]{36}$/);
    assert.equal(call.args[call.args.indexOf('--mode') + 1], 'accept-edits');
  }
  assert.match(readFileSync(join(f.directory, `${adapter}-event-1.log`), 'utf8'), /中文/);
});

test(`${adapter} resumes only the bound conversation and honors its configured cwd`, async t => {
  const project = mkdtempSync(join(tmpdir(), 'discussion-cwd-')); t.after(() => rmSync(project, { recursive: true, force: true }));
  if (adapter === 'antigravity_cli') {
    // agy runs only in sessions this tool created; an external conversation cannot take the discussion project.
    await assert.rejects(cli_delivery_fixture(t, adapter, { binding: { session_id: 'actual-cli-session' }, config: { cwd: project } }),
      error => error.delivery_status === 'not_sent' && /本工具新建/.test(error.message));
    // A hosted manual expert (configured session) resumes its own conversation under its own project and permissions.
    const hosted = await cli_delivery_fixture(t, adapter, { binding: { session_id: 'actual-cli-session' }, config: { cwd: project, session_id: 'actual-cli-session' } });
    const args = hosted.calls[0].args;
    assert.equal(args[args.indexOf('--conversation') + 1], 'actual-cli-session');
    assert.equal(args.includes('--project'), false); assert.deepEqual(hosted.errors, []);
    return;
  }
  const f = await cli_delivery_fixture(t, adapter, { binding: { session_id: 'actual-cli-session' },
    config: { cwd: project, project_access: 'write' } });
  const call = f.calls[0];
  const flag = adapter === 'codex_cli' ? 'resume' : '--conversation';
  assert.equal(call.args[call.args.indexOf(flag) + 1], 'actual-cli-session');
  assert.equal(call.args.includes('--last'), false); assert.equal(call.args.includes('--continue'), false);
  assert.equal(call.args.includes('--project'), false); assert.deepEqual(f.errors, []);
  assert.equal(call.settings.cwd, project);
  if (adapter === 'codex_cli') {
    assert.ok(call.args.findIndex(arg => arg.startsWith('default_permissions=')) > call.args.indexOf('resume'));
    assert.match(call.args.find(arg => arg.startsWith('permissions.')), /extends=":workspace"/);
    assert.equal(call.args[call.args.indexOf('--cd') + 1], project);
    // A taken-over manual Codex CLI writes like 可写, so its own read-only config cannot block the answer draft.
    const own = codex_permissions({ cwd: project, project_access: 'own' }, { directory: project, draft_directory: project });
    assert.match(own.args.find(arg => arg.startsWith('permissions.')), /extends=":workspace"/);
  }
});

test(`${adapter} keeps the project cwd when project access is read-only`, async t => {
  const project = mkdtempSync(join(tmpdir(), 'discussion-cwd-')); t.after(() => rmSync(project, { recursive: true, force: true }));
  const f = await cli_delivery_fixture(t, adapter, { config: { cwd: project, project_access: 'read' } });
  const call = f.calls[0];
  assert.equal(call.settings.cwd, project); assert.deepEqual(f.errors, []);
  if (adapter === 'codex_cli') {
    assert.equal(call.args.includes('--mode'), false);
    assert.equal(call.args[call.args.indexOf('--cd') + 1], project);
    assert.match(call.args.find(arg => arg.startsWith('permissions.')), /extends=":read-only"/);
  } else {
    assert.equal(call.args[call.args.indexOf('--mode') + 1], 'accept-edits');
    assert.ok(!call.args.includes(project), 'agy does not attach its cwd a second time');
  }
});

test(`${adapter} never replaces a bound identity when the CLI returns another session`, async t => {
  // agy refuses unmanaged bindings before spawning; its managed binding mismatch is covered by the project test.
  if (adapter === 'antigravity_cli') return;
  const f = await cli_delivery_fixture(t, adapter, { binding: { session_id: 'original-session' } });
  assert.match(f.errors[0], /会话 ID 与绑定不符/); assert.equal(f.exits, 0);
  assert.deepEqual(f.bindings, []);
  assert.equal(JSON.parse(readFileSync(f.access_path, 'utf8')).session_id, 'original-session');
});

test(`${adapter} rejects successful process exit without a terminal CLI result`, async t => {
  const f = await cli_delivery_fixture(t, adapter, { events: cli_events(adapter).slice(0, 1) });
  assert.match(f.errors[0], /未返回成功结束事件/); assert.equal(f.exits, 0);
});

test(`${adapter} reports a nonzero exit without classifying the sent task as retryable`, async t => {
  const f = await cli_delivery_fixture(t, adapter, { events: [], exit_code: 7 });
  assert.match(f.errors[0], /退出码 7/); assert.match(f.errors[0], /diagnostic 中文/);
  assert.equal(f.result.status, 'accepted'); assert.equal(f.exits, 0); assert.deepEqual(f.bindings, []);
});

test(`${adapter} persists a streamed binding and resumes it after a dispatcher restart`, async t => {
  const f = await fixture(t);
  f.config.participants.Codex = { adapter, executable: process.execPath };
  const process_fixture = fake_cli(cli_events(adapter));
  const deliver = (config, binding, task) => deliver_task(config, binding, task, process_fixture.spawn_process, join(f.config.directory, 'user'));
  const runner = new FreeRoomRunner(f.config, f.store, deliver);
  await runner.tick(); await process_fixture.calls[0].closed;
  assert.equal(f.store.binding('Codex').session_id, 'actual-cli-session');
  f.finish_execution(f.current_execution().id);
  await runner.tick();
  const next_request = f.add_request({ message_id: 2 });
  const restored_store = new DiscussionStore(f.config.directory);
  try {
    await new FreeRoomRunner(f.config, restored_store, deliver).tick(); await process_fixture.calls[1].closed;
  } finally { restored_store.close(); }
  const args = process_fixture.calls[1].args;
  assert.equal(args[args.indexOf(adapter === 'codex_cli' ? 'resume' : '--conversation') + 1], 'actual-cli-session');
  assert.equal(JSON.parse(readFileSync(join(f.config.directory, 'free-2.access.json'), 'utf8')).session_id, 'actual-cli-session');
  assert.equal(f.current_execution().requests[0].id, next_request.id);
  if (adapter === 'antigravity_cli') {
    const first_args = process_fixture.calls[0].args;
    assert.equal(args[args.indexOf('--project') + 1], first_args[first_args.indexOf('--project') + 1]);
  }
});

test(`${adapter} is terminated and reported when it runs past the process time cap`, async t => {
  const f = await fixture(t);
  f.config.participants.Codex = { adapter, executable: process.execPath };
  const process_fixture = fake_cli(cli_events(adapter).slice(0, 1), { linger: true });
  const runner = new FreeRoomRunner(f.config, f.store,
    (config, binding, task) => deliver_task(config, binding, task, process_fixture.spawn_process, join(f.config.directory, 'user')));
  process.env.CODISCUSS_CLI_MAX_MS = '300';
  try {
    await runner.tick();
    await process_fixture.calls[0].closed;
    assert.match(f.store.db.prepare('SELECT error FROM free_deliveries WHERE member=?').get('Codex').error, /仍未结束，已终止/);
  } finally { delete process.env.CODISCUSS_CLI_MAX_MS; runner.stop_children(); }
});

test(`${adapter} is stopped when its assigned discussion execution is cancelled`, async t => {
  const f = await fixture(t);
  f.config.participants.Codex = { adapter, executable: process.execPath };
  const process_fixture = fake_cli(cli_events(adapter).slice(0, 1), { linger: true });
  f.room.session = { id: 1, status: 'active' };
  f.request.purpose = 'discuss'; f.request.session_request_id = 1; f.request.session_id = 1;
  const runner = new FreeRoomRunner(f.config, f.store,
    (config, binding, task) => deliver_task(config, binding, task, process_fixture.spawn_process, join(f.config.directory, 'user')));
  try {
    await runner.tick(); assert.equal(runner.children.size, 1);
    for (let attempt = 0; attempt < 100 && !f.store.binding('Codex').session_id; attempt++) await delay(10);
    assert.equal(f.store.binding('Codex').session_id, 'actual-cli-session', 'identity is available while the CLI is still running');
    f.room.session.status = 'paused'; f.finish_execution(f.current_execution().id, 'cancelled', 'session_paused');
    await runner.tick();
    await process_fixture.calls[0].closed;
    assert.equal(runner.children.size, 0); assert.equal(process_fixture.calls.length, 1);
  } finally { runner.stop_children(); }
});
}

for (const options of [{ codex_config: { sandbox_mode: 'workspace-write' } },
  { codex_config: { sandbox_workspace_write: { writable_roots: ['/'] } } }, { codex_config: { permissions: {} } },
  { codex_version: '0.162.0' }, { codex_version: 'unknown' }]) {
test(`codex refuses conflicting or unavailable permission profiles: ${JSON.stringify(options)}`, async t => {
  const f = await fixture(t);
  f.config.participants.Codex = { adapter: 'codex_cli', executable: process.execPath };
  const process_fixture = fake_cli(cli_events('codex_cli'), options);
  const runner = new FreeRoomRunner(f.config, f.store,
    (config, binding, task) => deliver_task(config, binding, task, process_fixture.spawn_process));
  await runner.tick();
  await process_fixture.config_calls[0].closed;
  assert.equal(process_fixture.calls.length, 0, 'config inspection must reject before starting an AI turn');
  assert.equal(f.store.binding('Codex').session_id, undefined);
  assert.equal(f.calls.includes('release'), true);
  assert.match(f.store.db.prepare('SELECT error FROM free_deliveries WHERE member=?').get('Codex').error, /未交付|配置/);
  if (options.codex_version) assert.match(f.store.db.prepare('SELECT error FROM free_deliveries WHERE member=?').get('Codex').error, /0\.163\.0/);
  assert.equal(runner.children.size, 0);
});
}

test('agy separates native project permissions from the selected project and preserves read/write boundaries', async t => {
  const f = task_fixture(t);
  const user_home = join(f.config.directory, 'user');
  const projects = join(user_home, '.gemini', 'config', 'projects');
  mkdirSync(projects, { recursive: true });
  const original = { id: 'original', name: 'Original project', settings: { keep: true },
    projectResources: { resources: [{ folder: { folderUri: pathToFileURL(join(f.config.directory, 'source')).href } }] },
    permissionGrants: { permissionGrants: { allow: ['command(*)'] } } };
  const original_path = join(projects, 'original.json');
  const original_text = JSON.stringify(original);
  writeFileSync(original_path, original_text);
  const task = { ...session_task(f.config), room_title: '架构评审' };
  const config = { project_id: 'original', project_access: 'read' };
  const first = prepare_agy_project(config, {}, task, user_home);
  const read = JSON.parse(readFileSync(join(projects, `${first.project_id}.json`), 'utf8'));
  assert.equal(read.name, `CoDiscuss · 架构评审 · ${task.participant}`);
  const rule = path => `write_file(${resolve(path).replaceAll('\\', '/')})`;
  assert.deepEqual(read.projectResources, original.projectResources);
  assert.deepEqual(read.settings, {});
  assert.deepEqual(read.permissionGrants.permissionGrants.allow, [agy_rule(), rule(task.draft_directory)]);
  assert.ok(read.permissionGrants.permissionGrants.deny.includes(rule(join(f.config.directory, 'source'))));
  for (const path of [task.directory, task.skills_directory, join(user_home, '.gemini')]) {
    assert.ok(read.permissionGrants.permissionGrants.deny.includes(rule(path)));
  }
  assert.ok(read.permissionGrants.permissionGrants.deny.includes('mcp(*)'));
  first.bind('real-session');
  const resumed = prepare_agy_project({ ...config, project_access: 'write' }, { session_id: 'real-session' }, task, user_home);
  assert.equal(resumed.project_id, first.project_id);
  const write = JSON.parse(readFileSync(join(projects, `${first.project_id}.json`), 'utf8')).permissionGrants.permissionGrants;
  assert.ok(write.allow.includes(rule(join(f.config.directory, 'source'))));
  assert.ok(!write.deny.includes(rule(join(f.config.directory, 'source'))));
  assert.ok(write.deny.includes(rule(task.directory)));
  assert.ok(write.allow.includes('command(*)') && !read.permissionGrants.permissionGrants.allow.includes('command(*)'));
  assert.ok(!write.allow.includes('unsandboxed_command(*)') && write.deny.includes('mcp(*)'));
  prepare_agy_project({ ...config, project_access: 'full' }, { session_id: 'real-session' }, task, user_home);
  const full = JSON.parse(readFileSync(join(projects, `${first.project_id}.json`), 'utf8')).permissionGrants.permissionGrants;
  assert.ok(full.allow.includes('unsandboxed_command(*)') && !full.deny.includes('mcp(*)'));
  assert.ok(full.deny.includes(rule(task.directory)), 'run data stays protected at every level');
  assert.equal(readFileSync(original_path, 'utf8'), original_text);
  assert.throws(() => prepare_agy_project(config, { session_id: 'other-session' }, task, user_home), /会话绑定不符/);
  // Deleting the room removes only the projects it created.
  assert.equal(remove_agy_projects(task.directory, user_home), 1);
  assert.equal(existsSync(join(projects, `${first.project_id}.json`)), false);
  assert.equal(readFileSync(original_path, 'utf8'), original_text);
  assert.equal(remove_agy_projects(task.directory, user_home), 0);
});

test('agy refuses inherited shell bypasses before invoking a model and leaves settings unchanged', async t => {
  const f = task_fixture(t);
  const user_home = join(f.config.directory, 'user');
  const cli_path = join(user_home, '.gemini', 'antigravity-cli', 'settings.json');
  const shared_path = join(user_home, '.gemini', 'config', 'config.json');
  mkdirSync(join(user_home, '.gemini', 'antigravity-cli'), { recursive: true });
  mkdirSync(join(user_home, '.gemini', 'config'), { recursive: true });
  const task = session_task(f.config);
  for (const [cli, shared] of [
    [{ permissions: { allow: ['command(*)'] } }, {}], [{ permissions: { allow: ['*'] } }, {}],
    [{}, { userSettings: { globalPermissionGrants: { allow: ['unsandboxed_command(*)'] } } }],
    [{}, { userSettings: { globalPermissionGrants: { allow: ['unsandboxed(*)'] } } }],
  ]) {
    writeFileSync(cli_path, JSON.stringify(cli)); writeFileSync(shared_path, JSON.stringify(shared));
    await assert.rejects(deliver_task({ adapter: 'antigravity_cli' }, {}, task,
      () => assert.fail('must reject before spawning'), user_home), error => error.delivery_status === 'not_sent');
    assert.deepEqual(JSON.parse(readFileSync(cli_path, 'utf8')), cli);
    assert.deepEqual(JSON.parse(readFileSync(shared_path, 'utf8')), shared);
  }
  writeFileSync(cli_path, JSON.stringify({ toolPermission: 'always-proceed', permissions: { allow: ['read_file(*)', 'command(git status)'] } }));
  writeFileSync(shared_path, JSON.stringify({ userSettings: { globalPermissionGrants: { allow: ['read_url(https://example.com)'] } } }));
  assert.ok(prepare_agy_project({}, {}, task, user_home).project_id);
});

test('agy rejects nested answer storage because native deny rules take priority over allows', async t => {
  const f = task_fixture(t);
  const task = session_task(f.config);
  for (const parent of [task.directory, task.skills_directory, join(f.config.directory, 'user', '.gemini')]) {
    assert.throws(() => prepare_agy_project({}, {}, { ...task, draft_directory: join(parent, 'drafts') },
      join(f.config.directory, 'user')), /草稿目录不能位于/);
  }
});

test('each CLI receives the configured model and effort as its own arguments', async t => {
  const codex = await cli_delivery_fixture(t, 'codex_cli', { config: { model: 'gpt-6-astra', effort: 'xhigh' } });
  const codex_args = codex.calls[0].args;
  assert.equal(codex_args[codex_args.indexOf('-m') + 1], 'gpt-6-astra'); assert.equal(codex_args.at(-1), '-');
  assert.ok(codex_args.includes('model_reasoning_effort="xhigh"'));
  const agy = await cli_delivery_fixture(t, 'antigravity_cli', { config: { model: 'gemini-4-argon-high', effort: 'low' } });
  const agy_args = agy.calls[0].args;
  assert.equal(agy_args[agy_args.indexOf('--model') + 1], 'gemini-4-argon-high'); assert.ok(agy_args.indexOf('--model') < agy_args.indexOf('-p'));
  assert.equal(agy_args[agy_args.indexOf('--effort') + 1], 'low');
  const claude = await cli_delivery_fixture(t, 'claude', { events: [{ type: 'result', is_error: false, result: '完成' }], config: { model: 'opus', effort: 'max' } });
  const claude_args = claude.calls[0].args;
  assert.equal(claude_args[claude_args.indexOf('--model') + 1], 'opus');
  assert.equal(claude_args[claude_args.indexOf('--effort') + 1], 'max'); assert.ok(claude_args.indexOf('--effort') < claude_args.indexOf('--allowedTools')); assert.ok(claude_args.indexOf('--model') < claude_args.indexOf('--allowedTools'));
  const plain = await cli_delivery_fixture(t, 'codex_cli');
  assert.equal(plain.calls[0].args.includes('-m'), false);
  assert.equal(plain.calls[0].args.some(arg => arg.startsWith('model_reasoning_effort')), false);
  const agy_default = await cli_delivery_fixture(t, 'antigravity_cli');
  assert.equal(agy_default.calls[0].args.includes('--effort'), false);
  assert.equal(agy_default.calls[0].args.includes('--model'), false);
  for (const fixture of [codex, agy, claude]) {
    assert.equal(fixture.calls[0].settings.env.DISCUSS_ACCESS_FILE, fixture.access_path);
    assert.equal(Object.entries(fixture.calls[0].settings.env).find(([key]) => key.toLowerCase() === 'path')?.[1], process.env.PATH);
    assert.notEqual(process.env.DISCUSS_ACCESS_FILE, fixture.access_path);
  }
});

test('claude allows only codiscuss website subcommands and draft writes, then user rules', async t => {
  const f = await cli_delivery_fixture(t, 'claude', { events: [{ type: 'result', is_error: false, result: '完成' }],
    config: { allowed_tools: ['Read(//d/materials/**)'] } });
  const args = f.calls[0].args;
  assert.deepEqual(f.errors, []);
  assert.ok(!args.some(arg => arg.startsWith('--dangerously') || arg === '--permission-mode'));
  const directories = args.indexOf('--add-dir');
  assert.deepEqual(args.slice(directories + 1, directories + 4), [f.directory, f.task.draft_directory, f.task.skills_directory]);
  assert.deepEqual(args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--')),
    [...['room', 'message', 'turn', 'state', 'review', 'execution', 'health', 'schema']
      .flatMap(command => [`Bash(codiscuss ${command} *)`, `PowerShell(codiscuss ${command} *)`]),
    `Edit(${claude_rule_path(f.task.draft_directory)}/**)`, 'Read(//d/materials/**)']);
  assert.ok(!args.includes(`Edit(${claude_rule_path(f.directory)}/**)`));
  assert.ok(!args.some(arg => /(Bash|PowerShell)\(codiscuss (service|launch|run|api|setup|install|local)/.test(arg)));
  assert.equal(args.at(-1), f.task.prompt);
  if (process.platform === 'win32') assert.equal(claude_rule_path('C:\\Data\\room'), '//c/Data/room');
});

test('a stopped process tree is ended with taskkill on Windows and falls back to the plain kill otherwise', () => {
  const running = () => ({ pid: 4242, exitCode: null, signalCode: null });
  const attempt = (child, platform, run) => {
    const calls = []; let plain = 0;
    const result = kill_process_tree(child, () => { plain++; return 'plain'; }, platform, (...call) => { calls.push(call); return run(); });
    return { calls, plain, result };
  };
  const windows = attempt(running(), 'win32', () => ({ status: 0 }));
  assert.deepEqual(windows.calls[0].slice(0, 2), ['taskkill', ['/PID', '4242', '/T', '/F']]);
  assert.equal(windows.plain, 0);
  assert.equal(windows.result, true);
  assert.equal(attempt(running(), 'win32', () => ({ status: 128 })).plain, 1);
  assert.equal(attempt(running(), 'win32', () => { throw new Error('taskkill missing'); }).plain, 1);
  assert.equal(attempt({ pid: undefined, exitCode: null, signalCode: null }, 'win32', () => ({ status: 0 })).plain, 1);
  assert.equal(attempt({ pid: 4242, exitCode: 0, signalCode: null }, 'win32', () => ({ status: 0 })).calls.length, 0);
  const posix = attempt(running(), 'linux', () => ({ status: 0 }));
  assert.equal(posix.calls.length, 0);
  assert.equal(posix.plain, 1);
});

test('stopping a Claude run on Windows also ends the tool process its non-Node parent started', { skip: process.platform !== 'win32' }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'discussion-claude-tree-'));
  const directory = join(root, 'runtime'); const draft_directory = join(root, 'drafts');
  mkdirSync(directory); mkdirSync(draft_directory);
  const access_path = join(directory, 'access.json');
  writeFileSync(access_path, JSON.stringify({ token: 'test-only', session_id: '' }));
  const grandchild_script = join(root, 'tool.mjs');
  writeFileSync(grandchild_script, 'console.log(process.pid); setInterval(() => {}, 1000);');
  const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
  let grandchild = 0; let started;
  const ready = new Promise(resolve => { started = resolve; });
  // cmd.exe is not a Node process, so killing it alone would leave its child running.
  const spawn_process = (executable, args, settings) => {
    const child = spawn('cmd.exe', ['/d', '/s', '/c', `""${process.execPath}" "${grandchild_script}""`],
      { ...settings, windowsVerbatimArguments: true });
    child.stdout.on('data', chunk => { grandchild = Number(String(chunk).trim()); started(); });
    return child;
  };
  let run;
  const task = { id: 'event-tree', participant: 'Claude', directory, draft_directory, access_path, prompt: 'test', skills_directory: join(directory, 'skills'),
    on_binding: () => {}, on_process: child => { run = child; }, on_output: () => {}, on_failure: () => {}, on_exit: () => {} };
  t.after(() => { if (grandchild && alive(grandchild)) process.kill(grandchild); if (run && run.exitCode === null) run.kill(); rmSync(root, { recursive: true, force: true }); });
  await deliver_task({ adapter: 'claude', executable: process.execPath }, {}, task, spawn_process);
  await ready;
  assert.ok(alive(grandchild), 'the tool process runs before the stop');
  run.kill();
  for (let waited = 0; alive(grandchild) && waited < 5000; waited += 100) await delay(100);
  assert.equal(alive(grandchild), false, 'stopping the Claude run leaves no tool process behind');
});

test('claude edits a project and runs any command only when the launch grants write access', async t => {
  const project = mkdtempSync(join(tmpdir(), 'discussion-cwd-')); t.after(() => rmSync(project, { recursive: true, force: true }));
  const result = [{ type: 'result', is_error: false, result: '完成' }];
  for (const project_access of ['read', 'write']) {
    const f = await cli_delivery_fixture(t, 'claude', { events: result, config: { cwd: project, project_access } });
    const call = f.calls[0];
    assert.equal(call.settings.cwd, project);
    assert.equal(call.args.includes(`Edit(${claude_rule_path(project)}/**)`), project_access === 'write');
    assert.equal(call.args.includes('Bash') && call.args.includes('PowerShell'), project_access === 'write');
    assert.equal(call.args.includes('Bash(codiscuss room *)'), project_access === 'read');
  }
  // A taken-over manual member runs in auto mode as its own window does, without the room's file or command limits.
  const own = await cli_delivery_fixture(t, 'claude', { events: result, config: { cwd: project, project_access: 'own' } });
  const args = own.calls[0].args;
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'auto');
  assert.ok(!args.includes('Bash') && !args.includes(`Edit(${claude_rule_path(project)}/**)`));
  assert.ok(args.includes('Bash(codiscuss room *)'), 'website commands never wait for the classifier');
  // 自动 uses the same auto mode; 全放开 skips every check.
  for (const [project_access, mode] of [['auto', 'auto'], ['full', 'bypassPermissions']]) {
    const level = (await cli_delivery_fixture(t, 'claude', { events: result, config: { cwd: project, project_access } })).calls[0].args;
    assert.equal(level[level.indexOf('--permission-mode') + 1], mode);
  }
});

/** A Codex desktop app-tools pipe that reports one chat status and records the messages sent through it. */
async function fake_codex_app(t, status) {
  const sent = [];
  const server = createNetServer(socket => {
    let buffer = Buffer.alloc(0);
    const reply = (id, result) => {
      const payload = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result }));
      const frame = Buffer.alloc(4 + payload.length); frame.writeUInt32LE(payload.length); payload.copy(frame, 4); socket.write(frame);
    };
    const tool = data => ({ success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(data) }] });
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE() + 4) {
        const request = JSON.parse(buffer.subarray(4, buffer.readUInt32LE() + 4).toString('utf8'));
        buffer = buffer.subarray(buffer.readUInt32LE() + 4);
        if (request.method === 'tools/list') reply(request.id, { tools: ['create_thread', 'read_thread', 'send_message_to_thread'].map(name => ({ name, namespace: 'codex_app' })) });
        else if (request.params.tool === 'read_thread') reply(request.id, tool({ thread: { id: request.params.arguments.threadId, status: { type: status } } }));
        else if (request.params.tool === 'send_message_to_thread') { sent.push(request.params.arguments); reply(request.id, tool({ threadId: request.params.arguments.threadId })); }
      }
    });
  });
  const pipe_path = process.platform === 'win32' ? String.raw`\\.\pipe\codiscuss-test-${randomUUID()}` : join(mkdtempSync(join(tmpdir(), 'codex-pipe-')), 'app.sock');
  await new Promise(resolve_listen => server.listen(pipe_path, resolve_listen));
  t.after(() => server.close());
  return { pipe_path, sent };
}

test('a Codex App chat the App has not loaded gets its message through the App, a loaded one through the queue', async t => {
  const access_path = join(mkdtempSync(join(tmpdir(), 'codex-app-access-')), 'access.json');
  writeFileSync(access_path, JSON.stringify({ token: 'test-only', session_id: '' }));
  const task = { id: 'free-1', participant: 'Codex', access_path, prompt: '请处理 #12' };
  const unloaded = await fake_codex_app(t, 'notLoaded');
  const result = await deliver_task({ adapter: 'codex', executable: process.execPath, pipe_path: unloaded.pipe_path }, { session_id: 'forked-thread' }, task);
  assert.deepEqual(result, { session_id: 'forked-thread', status: 'accepted', capabilities: { stoppable: false, progress: false } });
  assert.deepEqual(unloaded.sent, [{ threadId: 'forked-thread', prompt: '请处理 #12' }]);
  const loaded = await fake_codex_app(t, 'idle');
  // The queue runs the configured executable; node cannot load a module named `queue`, which shows the queue was used.
  await assert.rejects(deliver_task({ adapter: 'codex', executable: process.execPath, pipe_path: loaded.pipe_path }, { session_id: 'open-thread' }, task), /软件退出码/);
  assert.deepEqual(loaded.sent, []);
});

test('a taken-over Claude member resumes its session once no window holds it, and forks it while a window without an inbox does', async t => {
  const original = 'original-session-1';
  const own = { project_access: 'own', session_id: original };
  assert.deepEqual(adopted_fork(own, { session_id: original }, false), { session_id: original }, 'no window holds it, so nothing splits');
  const first = adopted_fork(own, { session_id: original }, true, () => true);
  assert.equal(first.fork.from, original);
  assert.notEqual(first.session_id, original);
  assert.deepEqual(adopted_fork(own, { session_id: first.session_id }, true, () => true), { session_id: first.session_id }, 'a written fork is resumed');
  assert.deepEqual(adopted_fork(own, { session_id: first.session_id }, false, () => false), { session_id: first.session_id, fork: { from: original, at: '' } },
    'a fork that was never written is retried under the same ID');
  assert.deepEqual(adopted_fork(own, { session_id: '' }, true, () => false), { session_id: '' }, 'a rewind back to the start opens a new session');
  assert.deepEqual(adopted_fork({ project_access: 'write', session_id: original }, { session_id: original }, true), { session_id: original },
    'a session the owner lent at invitation is resumed as before');
  const result = [{ type: 'result', is_error: false, result: '完成' }];
  const f = await cli_delivery_fixture(t, 'claude', { events: result, config: { ...own }, binding: { session_id: original } });
  const args = f.calls[0].args;
  assert.equal(args[args.indexOf('--resume') + 1], original);
  assert.ok(!args.includes('--fork-session'));
});

test('a taken-over Claude member whose own window is open gets its task through the window inbox, not a new process', async t => {
  const home = mkdtempSync(join(tmpdir(), 'claude-home-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const sessions = join(home, 'sessions'); mkdirSync(sessions);
  const original = randomUUID(), received = [];
  const socket_path = process.platform === 'win32' ? String.raw`\\.\pipe\codiscuss-inbox-${randomUUID()}` : join(home, 'inbox.sock');
  const server = createNetServer(socket => { let text = ''; socket.on('data', chunk => { text += chunk; }); socket.on('end', () => received.push(...text.trim().split(/\r?\n/).map(line => JSON.parse(line)))); });
  await new Promise(resolve_listen => server.listen(socket_path, resolve_listen)); t.after(() => server.close());
  writeFileSync(join(sessions, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: original, messagingSocketPath: socket_path, status: 'idle' }));
  writeFileSync(join(sessions, `${process.pid}.${'a'.repeat(64)}.key`), JSON.stringify({ peerToken: 'peer-token' }));
  const previous = process.env.CLAUDE_CONFIG_DIR; process.env.CLAUDE_CONFIG_DIR = home;
  t.after(() => { if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous; });
  const profile = { adapter: 'claude', project_access: 'own', session_id: original };
  assert.equal(claude_inbox_ready(profile, { session_id: original }), true);
  assert.equal(claude_inbox_ready(profile, { session_id: 'a-fork' }), false, 'a member already moved to a fork stays there');
  assert.equal(claude_inbox_ready({ ...profile, project_access: 'write' }, { session_id: original }), false, 'a lent session is not a manual window');
  const access_path = join(home, 'access.json'); writeFileSync(access_path, JSON.stringify({ token: 'member', session_id: '' }));
  const spawned = [], bound = [];
  const result = await deliver_task({ ...profile, executable: process.execPath }, { session_id: original },
    { id: 'free-7', inbox: true, access_path, prompt: '请先读取任务文件 free-7.task.json', on_note: () => {}, on_binding: session => bound.push(session) }, (...args) => { spawned.push(args); throw new Error('no process'); });
  assert.deepEqual(result, { session_id: original, status: 'accepted', capabilities: { stoppable: false, progress: false } }, 'the adapter reports it cannot stop a window');
  assert.deepEqual(spawned, []);
  assert.deepEqual(bound, [original], 'the discussion runner enters the execution once the session is reported');
  for (let waited = 0; received.length < 2 && waited < 2000; waited += 20) await delay(20);
  assert.deepEqual(received[0], { type: 'auth', token: 'peer-token' });
  assert.equal(received[1].type, 'user');
  assert.match(received[1].message.content, /free-7\.task\.json/);
  assert.equal(JSON.parse(readFileSync(access_path, 'utf8')).session_id, original);
});

test('agy 全放开 skips its permission prompts, which no other level does', async t => {
  for (const project_access of ['read', 'write', 'full', 'own']) {
    const session = project_access === 'own' ? { session_id: 'actual-cli-session' } : {};
    const f = await cli_delivery_fixture(t, 'antigravity_cli', { config: { project_access, ...session }, binding: session });
    assert.deepEqual(f.errors, []);
    assert.equal(f.calls[0].args.includes('--dangerously-skip-permissions'), project_access === 'full');
    assert.equal(f.calls[0].args.includes('--project'), project_access !== 'own');
  }
});

test('codex 自动 lets its automatic review approve escalations and 全放开 drops the sandbox', () => {
  const task = { directory: tmpdir(), draft_directory: tmpdir() };
  const auto = codex_permissions({ cwd: tmpdir(), project_access: 'auto' }, task).args;
  assert.ok(auto.includes('approval_policy="on-request"') && auto.includes('approvals_reviewer="auto_review"'));
  assert.match(auto.find(arg => arg.startsWith('permissions.')), /extends=":workspace"/);
  assert.ok(codex_permissions({ cwd: tmpdir(), project_access: 'write' }, task).args.includes('approval_policy="never"'));
  assert.deepEqual(codex_permissions({ project_access: 'full' }, task), { name: '', args: ['--dangerously-bypass-approvals-and-sandbox'] });
});

test('tasks state whether the discussion project is read-only or writable', t => {
  const f = task_fixture(t);
  const project = mkdtempSync(join(tmpdir(), 'discussion-cwd-')); t.after(() => rmSync(project, { recursive: true, force: true }));
  const config = load_config_from(f, project, 'write');
  session_task(config);
  const read_task = () => JSON.parse(readFileSync(join(f.config.directory, 'free-1.task.json'), 'utf8'));
  const saved = read_task();
  assert.match(saved.instructions, /允许按请求修改.*并运行所需命令/);
  assert.equal(saved.project_access, 'write'); assert.equal(saved.cwd, project);
  assert.equal(saved.draft_directory, f.config.directory + '-drafts');
  assert.ok(existsSync(saved.draft_directory));
  session_task(load_config_from(f, project));
  assert.match(read_task().instructions, /只读，不修改.*命令只用 subcommands/);
  session_task(load_config_from(f, project, 'own'));
  const own = read_task().instructions;
  assert.match(own, /权限沿用你自己会话的软件设置/);
  assert.doesNotMatch(own, /只读，不修改/);
  session_task(config, { process_access: false });
  const posted = read_task();
  assert.ok(posted.access_file && !posted.access_env);
  session_task(f.config);
  assert.match(read_task().instructions, /未指定项目目录/);
  session_task(load_config_from(f, project, 'auto'));
  assert.match(read_task().instructions, /由软件自动审批.*申请放行/);
  session_task(load_config_from(f, project, 'full'));
  assert.match(read_task().instructions, /已跳过软件审批与沙箱/);
  assert.throws(() => load_config_from(f, project, 'admin'), /read、write、auto 或 full/);
});

/** Validate the fixture room with a project directory and optional access level. */
function load_config_from(f, project, project_access) {
  return validate_config({ ...f.config, project: undefined, token: 'x'.repeat(32), cwd: project, project_access,
    participants: { Codex: { adapter: 'codex_cli', executable: process.execPath } }, data_directory: f.config.directory }, f.config.directory);
}

test('tasks direct website work to the approved codiscuss subcommands', t => {
  const f = task_fixture(t);
  const task = session_task(f.config);
  const read_task = () => JSON.parse(readFileSync(join(f.config.directory, 'free-1.task.json'), 'utf8'));
  const saved = read_task();
  const cli = process.platform === 'win32' ? 'codiscuss.cmd' : 'codiscuss';
  assert.equal(saved.cli, cli); assert.deepEqual(saved.subcommands, TASK_SUBCOMMANDS);
  assert.doesNotMatch(task.prompt, /execution enter|--kind opinion/);
  assert.match(task.prompt, /主持任务.*先读任务文件/);
  assert.equal(saved.execution_id, 1);
  assert.equal(saved.discussion_request.source_question, '核对方案并回答');
  const claude = session_task({ ...f.config, participants: { Codex: { adapter: 'claude' } } });
  assert.doesNotMatch(claude.prompt, /execution enter/);
  const has_rg = process.platform === 'win32' && spawnSync('rg', ['--version'], { stdio: 'ignore' }).status === 0;
  assert.equal(/rg --encoding utf-8/.test(claude.prompt), has_rg);
  const codex_cli = session_task({ ...f.config, participants: { Codex: { adapter: 'codex_cli' } } });
  assert.equal(/rg --encoding utf-8/.test(codex_cli.prompt), process.platform === 'win32');
  const agy = session_task({ ...f.config, participants: { Codex: { adapter: 'antigravity_cli' } } });
  assert.match(read_task().instructions, /run_command 只能运行.*subcommands/);
  assert.equal(read_task().access_file, agy.access_path, 'an existing conversation has no newly injected environment');
  const delivered = session_task({ ...f.config, participants: { Codex: { adapter: 'antigravity_cli' } } }, { process_access: true });
  const bound = read_task();
  assert.equal(bound.access_env, 'DISCUSS_ACCESS_FILE'); assert.equal(bound.access_file, undefined);
  assert.ok(!delivered.prompt.includes(delivered.access_path));
  const expert = session_task(f.config, { role: 'member' });
  assert.match(expert.prompt, /发言请求/);
  assert.equal(read_task().skills.some(path => path.includes('discuss-host')), false);
  assert.equal(read_task().discussion_request.read_until, 0);
  assert.equal(task.skills_directory, join(f.config.project, '.agents', 'skills'));
});

test('CLI failure results fail their execution immediately even when the process exits with code zero', async t => {
  for (const adapter of ['codex_cli', 'antigravity_cli']) {
    await t.test(adapter, async t => {
      const f = await fixture(t);
      f.config.participants.Codex = { adapter, executable: process.execPath };
      const events = cli_events(adapter).slice(0, 1);
      events.push(adapter === 'codex_cli' ? { type: 'turn.failed', error: { message: 'quota exceeded' } }
        : { event: 'result', result: { status: 'WAITING', response: 'permission required' } });
      const process_fixture = fake_cli(events);
      const runner = new FreeRoomRunner(f.config, f.store,
        (config, binding, task) => deliver_task(config, binding, task, process_fixture.spawn_process, join(f.config.directory, 'user')));
      await runner.tick(); await process_fixture.calls[0].closed; await runner.tick();
      assert.equal(f.current_execution().status, 'failed');
      assert.match(f.current_execution().result, /quota exceeded|permission required/);
      assert.equal(process_fixture.calls.length, 1);
    });
  }
});

test('headless CLI configuration does not require App threads or Sidecar directories', t => {
  const directory = mkdtempSync(join(tmpdir(), 'discussion-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'config.json');
  const config = { site: 'http://localhost:8765', room: 'room', token: 'x'.repeat(32),
    participants: { Codex: { adapter: 'codex_cli', executable: process.execPath },
      Gemini: { adapter: 'antigravity_cli', executable: process.execPath } } };
  writeFileSync(path, JSON.stringify(config));
  assert.equal(load_config(path).participants.Codex.adapter, 'codex_cli');
  config.participants.Codex.adapter = 'codex'; writeFileSync(path, JSON.stringify(config));
  assert.throws(() => load_config(path), /来源聊天 ID/);
  config.participants.Codex.adapter = 'codex_cli'; config.participants.Gemini.adapter = 'antigravity';
  writeFileSync(path, JSON.stringify(config)); assert.throws(() => load_config(path), /Sidecar IPC/);
});

test('legacy event inbox is left unread while the original session binding survives', t => {
  const directory = mkdtempSync(join(tmpdir(), 'discussion-legacy-'));
  const db = new DatabaseSync(join(directory, 'runtime.sqlite3'));
  db.exec(`CREATE TABLE inbox(id INTEGER PRIMARY KEY,event TEXT NOT NULL,status TEXT NOT NULL,
    token TEXT NOT NULL,sent_at INTEGER NOT NULL,last_renew INTEGER NOT NULL,error TEXT NOT NULL);
    INSERT INTO inbox VALUES (7,'{}','accepted','original-token',123,0,'');
    CREATE TABLE bindings(participant TEXT PRIMARY KEY,session_id TEXT NOT NULL);
    INSERT INTO bindings VALUES('Codex','original-session');`);
  db.close();
  const store = new DiscussionStore(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const row = store.db.prepare('SELECT * FROM inbox').get();
  assert.equal(row.id, 7); assert.equal(row.status, 'accepted'); assert.equal(row.token, 'original-token');
  assert.equal(row.sent_at, 123); assert.equal(row.attempts, undefined); assert.equal(row.retry_at, undefined);
  assert.equal(store.binding('Codex').session_id, 'original-session');
  assert.equal(typeof store.receive, 'undefined');
});

test('one data directory cannot silently share bindings across rooms or sites', async t => {
  const f = await fixture(t);
  f.store.scope(f.config, 'run');
  assert.throws(() => f.store.scope({ ...f.config, room: 'another' }, 'run'), /另一站点/);
});

test('project and cwd are optional; configured directories must match real projects', async () => {
  const app = { list_projects: async () => [{ hostId: 'local', projectId: 'project', label: 'Story', path: tmpdir() }] };
  assert.deepEqual(await codex_target(app, {}), { type: 'projectless' });
  assert.equal((await codex_target(app, { project_name: 'Story', cwd: tmpdir() })).projectId, 'project');
  await assert.rejects(codex_target(app, { project_name: 'Story', cwd: join(tmpdir(), 'different') }), /无法唯一匹配/);
  assert.equal(antigravity_project({}).id, 'outside-of-project');
});

test('common cwd is inherited and participant-specific cwd can override it', t => {
  const directory = mkdtempSync(join(tmpdir(), 'discussion-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'other')); mkdirSync(join(directory, 'runner')); writeFileSync(join(directory, 'runner', 'discuss.py'), '');
  const config_path = join(directory, 'config.json');
  writeFileSync(config_path, JSON.stringify({ site: 'http://localhost:8765', room: 'room', token: 'x'.repeat(32), cli_project: directory,
    cwd: directory, participants: { Claude: { adapter: 'claude', executable: process.execPath }, Gemini: { adapter: 'antigravity', ipc_directory: directory, cwd: join(directory, 'other') } } }));
  const config = load_config(config_path);
  assert.equal(config.participants.Claude.cwd, directory);
  assert.equal(config.participants.Gemini.cwd, join(directory, 'other'));
});

test('a bound member session rejects changed projects before the next execution', async t => {
  const f = await fixture(t); let sent = 0;
  const deliver = async () => { sent++; return { status: 'accepted', session_id: 'actual-chat' }; };
  await new FreeRoomRunner(f.config, f.store, deliver).tick();
  f.config.participants.Codex.cwd = tmpdir();
  f.finish_execution(f.current_execution().id);
  await new FreeRoomRunner(f.config, f.store, deliver).tick();
  f.add_request({ message_id: 2 });
  const runner = new FreeRoomRunner(f.config, f.store, deliver);
  await runner.tick();
  await runner.tick();
  assert.equal(sent, 1);
  assert.equal(f.current_execution().status, 'failed');
  assert.match(f.current_execution().result, /项目、cwd/);
});

test('pausing a discussion cancels its request while free collaboration can still continue', async t => {
  const f = await fixture(t);
  f.room.session = { id: 1, status: 'active' };
  f.request.purpose = 'discuss'; f.request.session_request_id = 1; f.request.session_id = 1;
  let sent = 0;
  const runner = new FreeRoomRunner(f.config, f.store, async () => { sent++; return { status: 'accepted' }; });
  await runner.tick();
  f.room.session.status = 'paused'; f.member.pending = [];
  f.finish_execution(f.current_execution().id, 'cancelled', 'session_paused');
  await runner.tick();
  f.add_request({ message_id: 2, purpose: 'ask' });
  await runner.tick();
  assert.equal(sent, 2);
  assert.equal(f.current_execution().requests[0].purpose, 'ask');
});

test('conclusion reconciles the final discussion result without ending the free-room runner', async t => {
  const f = await fixture(t); let sent = 0;
  f.room.session = { id: 1, status: 'active' };
  f.request.purpose = 'discuss'; f.request.session_request_id = 1; f.request.session_id = 1;
  const runner = new FreeRoomRunner(f.config, f.store, async () => { sent++; return { status: 'accepted' }; });
  await runner.tick();
  f.room.session.status = 'concluded'; f.room.phase = 'concluded';
  f.finish_execution(f.current_execution().id, 'completed', 'answer_saved'); f.member.pending = [];
  await runner.tick();
  assert.equal(sent, 1);
  assert.equal(f.current_execution().status, 'completed');
});

test('a Sidecar delivery checks and claims one dispatched free-room execution', async t => {
  const f = await fixture(t);
  const runner = new FreeRoomRunner(f.config, f.store, async (adapter, binding, task) => {
    writeFileSync(join(task.directory, `${task.id}.request.json`), JSON.stringify({ id: task.id, mode: 'free',
      event_id: task.api_context.execution_id, access_path: task.access_path, prompt: task.prompt }));
    return { status: 'sidecar_pending' };
  });
  await runner.tick();
  let calls = 0;
  const source = readFileSync(new URL('../runner/adapters/antigravity_sidecar.mjs', import.meta.url), 'utf8')
    .replace(/^import .+;\r?$/gm, '').split("\natomic_json(join(directory, 'ready.json')")[0];
  const context = vm.createContext({ process: { env: { CODISCUSS_IPC_DIRECTORY: f.config.directory, ANTIGRAVITY_AGENTAPI_EXE: 'test' } },
    resolve, join, existsSync, readFileSync, writeFileSync, fetch, AbortSignal,
    execFileSync: () => { calls++; return JSON.stringify({ response: { newConversation: { conversationId: 'test-session' } } }); },
    atomic_json: (path, value) => writeFileSync(path, JSON.stringify(value)),
  });
  await vm.runInContext(`${source}\nprocess_request('free-1.request.json')`, context);
  assert.equal(JSON.parse(readFileSync(join(f.config.directory, 'free-1.result.json'), 'utf8')).status, 'accepted');
  await vm.runInContext("process_request('free-1.request.json')", context);
  assert.equal(calls, 1);
});

test('a legacy Sidecar event request is rejected without calling the old APIs or software', async t => {
  const f = await fixture(t);
  const access_path = join(f.config.directory, 'legacy.access.json');
  writeFileSync(access_path, JSON.stringify({ site: f.config.site, room: f.config.room, token: 'owner' }));
  writeFileSync(join(f.config.directory, 'event-1.request.json'), JSON.stringify({ id: 'event-1', mode: 'brainstorm',
    event_id: 1, access_path, prompt: 'must not be delivered' }));
  let fetches = 0, invocations = 0;
  const source = readFileSync(new URL('../runner/adapters/antigravity_sidecar.mjs', import.meta.url), 'utf8')
    .replace(/^import .+;\r?$/gm, '').split("\natomic_json(join(directory, 'ready.json')")[0];
  const context = vm.createContext({ process: { env: { CODISCUSS_IPC_DIRECTORY: f.config.directory, ANTIGRAVITY_AGENTAPI_EXE: 'test' } },
    resolve, join, existsSync, readFileSync, writeFileSync, AbortSignal,
    fetch: async () => { fetches++; throw new Error('unexpected API call'); },
    execFileSync: () => { invocations++; throw new Error('unexpected software call'); },
    atomic_json: (path, value) => writeFileSync(path, JSON.stringify(value)),
  });
  await vm.runInContext(`${source}\nprocess_request('event-1.request.json')`, context);
  const receipt = JSON.parse(readFileSync(join(f.config.directory, 'event-1.result.json'), 'utf8'));
  assert.equal(receipt.status, 'uncertain');
  assert.match(receipt.error, /旧讨论事件已停用/);
  assert.equal(fetches, 0);
  assert.equal(invocations, 0);
});

test('the Antigravity adapter refuses legacy event IDs instead of queueing them as discussion events', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'legacy-sidecar-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'ready.json'), JSON.stringify({ pid: process.pid }));
  const task = { id: 'event-1', prompt: 'must not be queued', access_path: join(directory, 'access.json') };
  await assert.rejects(deliver_task({ adapter: 'antigravity', ipc_directory: directory }, {}, task), /旧讨论事件已停用/);
  assert.equal(existsSync(join(directory, 'event-1.request.json')), false);
});

test('a delayed Sidecar request after its execution lease expires never invokes the software', async t => {
  const f = await fixture(t);
  await new FreeRoomRunner(f.config, f.store, async (adapter, binding, task) => {
    writeFileSync(join(task.directory, `${task.id}.request.json`), JSON.stringify({ id: task.id, mode: 'free',
      event_id: task.api_context.execution_id, access_path: task.access_path, prompt: 'not delivered' }));
    return { status: 'sidecar_pending' };
  }).tick();
  f.current_execution().lease_until = Math.floor(Date.now() / 1000) - 1;
  const child = spawn(process.execPath, [fileURLToPath(new URL('../runner/discussion_sidecar.mjs', import.meta.url))], {
    windowsHide: true, stdio: 'ignore', env: { ...process.env, CODISCUSS_IPC_DIRECTORY: f.config.directory, ANTIGRAVITY_AGENTAPI_EXE: process.execPath },
  });
  const exited = once(child, 'exit');
  try {
    const receipt = join(f.config.directory, 'free-1.result.json');
    for (let attempt = 0; attempt < 80 && !existsSync(receipt); attempt++) await delay(25);
    const result = JSON.parse(readFileSync(receipt, 'utf8'));
    assert.equal(result.status, 'uncertain');
    assert.match(result.error, /执行租约已到期，未调用软件/);
  } finally { child.kill(); await exited; }
});

test('omitted cli_project defaults to this repository', t => {
  const directory = mkdtempSync(join(tmpdir(), 'discussion-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'config.json');
  writeFileSync(path, JSON.stringify({ site: 'http://127.0.0.1:8765', room: 'room1', token: 'x'.repeat(32),
    participants: { Gemini: { adapter: 'antigravity', ipc_directory: directory } } }));
  const config = load_config(path);
  assert.equal(config.project, resolve(fileURLToPath(new URL('..', import.meta.url))));
  assert.ok(existsSync(join(config.project, 'runner', 'discuss.py')));
});

/** Write a minimal valid private room configuration for the service registry. */
function room_config(directory, site, room, name = room) {
  const path = join(directory, `${name}.json`);
  writeFileSync(path, JSON.stringify({ site, room, token: 'x'.repeat(32), data_directory: join(directory, `data-${name}`),
    participants: { Gemini: { adapter: 'antigravity', ipc_directory: directory } } }));
  return path;
}

test('the service ticks every registered room and pauses a room once it is unregistered', async t => {
  const f = await fixture(t);
  const home = mkdtempSync(join(tmpdir(), 'discussion-service-'));
  const first = room_config(home, f.config.site, 'room1');
  const second = room_config(home, f.config.site, 'room2');
  register_room(home, first); register_room(home, second);
  const ticks = [];
  const service = new DiscussionService(home, config => ({ tick: async () => { ticks.push(config.room); return 'waiting'; }, stop_children() {} }));
  t.after(async () => { await service.close(); rmSync(home, { recursive: true, force: true }); });
  await service.tick();
  assert.deepEqual(ticks.sort(), ['room1', 'room2']);
  const first_worker = service.workers.get(first);
  const second_worker = service.workers.get(second);
  assert.equal(first_worker.config.draft_directory, service_drafts(home, first_worker.config.directory));
  assert.ok(first_worker.config.draft_directory.startsWith(join(home, 'drafts')));
  assert.notEqual(first_worker.config.draft_directory, second_worker.config.draft_directory);
  assert.equal(JSON.parse(readFileSync(first, 'utf8')).draft_directory, undefined, 'old configs need no on-disk migration');
  const status = JSON.parse(readFileSync(join(home, 'status.json'), 'utf8'));
  assert.deepEqual(status.rooms.map(room => room.status), ['paused', 'paused']);
  unregister_room(home, second);
  ticks.length = 0;
  await service.tick();
  assert.deepEqual(ticks, ['room1']);
  assert.ok(!existsSync(join(home, 'data-room2', 'runner.lock')), 'removed room releases its data-directory lock');
});

test('a slow room never holds up the other rooms between service polls', async t => {
  const f = await fixture(t);
  const home = mkdtempSync(join(tmpdir(), 'discussion-service-'));
  const slow = room_config(home, f.config.site, 'slow');
  const fast = room_config(home, f.config.site, 'fast');
  register_room(home, slow); register_room(home, fast);
  const ticks = [];
  let release_slow;
  const slow_gate = new Promise(done => { release_slow = done; });
  const service = new DiscussionService(home, config => ({ stop_children() {},
    tick: async () => { ticks.push(config.room); if (config.room === 'slow') await slow_gate; return 'waiting'; } }));
  service.intervals = { local: 0, remote: 0 };
  t.after(async () => { release_slow(); await service.close(); rmSync(home, { recursive: true, force: true }); });
  await service.tick({ wait: false });
  // Wait only for the fast room's complete check, including its member lookup.
  await service.workers.get(fast).busy;
  await service.tick({ wait: false });
  await service.workers.get(fast).busy;
  assert.deepEqual(ticks.filter(room => room === 'fast').length, 2, 'the fast room ticks again while the slow one is still running');
  assert.deepEqual(ticks.filter(room => room === 'slow').length, 1, 'a busy room is not ticked twice at once');
  release_slow();
  await service.workers.get(slow).busy;
  await service.tick();
  assert.deepEqual(ticks.filter(room => room === 'slow').length, 2);
});

test('a hosted site is polled less often than a local one, and a site update checks its rooms at once', async t => {
  const home = mkdtempSync(join(tmpdir(), 'discussion-service-'));
  // The test site serves the update stream; each `change` written to it should wake that site's rooms.
  let stream;
  const updates = createServer((request, response) => {
    if (request.url !== '/api/updates') { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write('event: ready\ndata: {}\n\n');
    stream = response;
  });
  await listen_local(updates);
  const local_site = `http://127.0.0.1:${updates.address().port}`;
  register_room(home, room_config(home, local_site, 'local'));
  register_room(home, room_config(home, 'http://remote.invalid', 'remote'));
  const ticks = [];
  const service = new DiscussionService(home, config => ({ stop_children() {}, tick: async () => { ticks.push(config.room); return 'waiting'; } }));
  service.intervals = { local: 50, remote: 60_000 };
  t.after(async () => { await service.close(); stream?.destroy(); updates.close(); rmSync(home, { recursive: true, force: true }); });
  const count = room => ticks.filter(item => item === room).length;
  await service.tick({ wait: false });
  await delay(80);
  await service.tick({ wait: false });
  await delay(10);
  assert.equal(count('local'), 2, 'a local room is polled again once its interval passes');
  assert.equal(count('remote'), 1, 'a hosted room waits for its longer interval');
  service.push = true;
  service.intervals.local = 60_000;
  await service.tick({ wait: false });
  for (let waited = 0; !stream && waited < 2000; waited += 10) await delay(10);
  await delay(20);
  const after_ready = count('local');
  assert.ok(after_ready >= 3, 'connecting to the stream checks the site once for changes missed meanwhile');
  stream.write('event: change\ndata: {}\n\n');
  await delay(50);
  assert.equal(count('local'), after_ready + 1, 'a change checks the local room at once, without waiting for a poll');
  assert.equal(count('remote'), 1, 'another site is not woken by this site\'s change');
  stream.write('event: change\ndata: {"rooms":["other"]}\n\n');
  await delay(50);
  assert.equal(count('local'), after_ready + 1, 'a change naming another room leaves this room to its poll');
  stream.write('event: change\ndata: {"rooms":["local"]}\n\n');
  await delay(50);
  assert.equal(count('local'), after_ready + 2, 'a change naming this room checks it at once');
});

test('a settled scheduling decision checks its room at once instead of waiting for the next poll', async t => {
  const home = mkdtempSync(join(tmpdir(), 'discussion-service-'));
  register_room(home, room_config(home, 'http://remote.invalid', 'room'));
  let ticks = 0, runner;
  const service = new DiscussionService(home, () => (runner = { stop_children() {}, on_decided() {}, room: { free: { members: [] } }, tick: async () => { ticks += 1; } }));
  service.intervals = { local: 60_000, remote: 60_000, revisions: 60_000, idle: 60_000 };
  t.after(async () => { await service.close(); rmSync(home, { recursive: true, force: true }); });
  await service.tick({ wait: false });
  await delay(10);
  assert.equal(ticks, 1);
  runner.on_decided();
  await delay(10);
  assert.equal(ticks, 2, 'the decision wakes the room without its poll interval passing');
});

test('a hosted site with a live update stream is not asked for revisions until the stream drops', async t => {
  const home = mkdtempSync(join(tmpdir(), 'discussion-service-'));
  register_room(home, room_config(home, 'https://hosted.example', 'room'));
  let revisions = 0, stream;
  const real_fetch = globalThis.fetch;
  globalThis.fetch = async url => {
    if (String(url).endsWith('/api/updates')) {
      return new Response(new ReadableStream({ start: controller => {
        stream = controller;
        controller.enqueue(new TextEncoder().encode('event: ready\ndata: {}\n\n'));
      } }), { headers: { 'Content-Type': 'text/event-stream' } });
    }
    revisions += 1;
    return Response.json({ site: 1, rooms: { room: 1 } });
  };
  const service = new DiscussionService(home, () => ({ stop_children() {}, idle: () => true,
    room: { free: { members: [] } }, tick: async () => {} }));
  service.intervals = { local: 50, remote: 40, revisions: 10, idle: 60_000 };
  service.push = true;
  t.after(async () => { await service.close(); globalThis.fetch = real_fetch; rmSync(home, { recursive: true, force: true }); });
  const run = async ms => { for (const end = Date.now() + ms; Date.now() < end;) { await service.tick({ wait: false }); await delay(5); } };
  await run(30);
  const before = revisions;
  await run(80);
  assert.equal(revisions, before, 'a live stream replaces revision polling');
  stream.close();
  await run(80);
  assert.ok(revisions > before, 'a dropped stream falls back to revision polling');
});

test('an idle hosted room is read in full only after its site reports a new revision, a busy one keeps its interval', async t => {
  const home = mkdtempSync(join(tmpdir(), 'discussion-service-'));
  register_room(home, room_config(home, 'https://hosted.example', 'idle'));
  register_room(home, room_config(home, 'https://hosted.example', 'busy'));
  const ticks = [], asked = [];
  let revision = 1, supported = true;
  const real_fetch = globalThis.fetch;
  globalThis.fetch = async url => {
    asked.push(String(url));
    if (!supported) return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
    return Response.json({ site: revision, rooms: { idle: revision, busy: 1 } });
  };
  // Like the real runner, the fake keeps the room it read, so adopting manual members reads nothing more.
  const service = new DiscussionService(home, config => ({ stop_children() {}, idle: () => config.room === 'idle',
    room: { free: { members: [] } }, tick: async () => { ticks.push(config.room); } }));
  service.intervals = { local: 50, remote: 40, revisions: 10, idle: 60_000 };
  t.after(async () => { await service.close(); globalThis.fetch = real_fetch; rmSync(home, { recursive: true, force: true }); });
  const count = room => ticks.filter(item => item === room).length;
  const run = async ms => { for (const end = Date.now() + ms; Date.now() < end;) { await service.tick({ wait: false }); await delay(5); } };
  await run(80);
  const idle_before = count('idle'), busy_before = count('busy');
  await run(200);
  assert.equal(count('idle'), idle_before, 'an unchanged idle room is not read again');
  assert.ok(count('busy') >= busy_before + 2, 'a busy room keeps its regular interval');
  assert.ok(asked.every(url => url.startsWith('https://hosted.example/api/revisions?rooms=')) && asked.length > 5, 'one small check per site');
  revision++;
  await run(60);
  assert.equal(count('idle'), idle_before + 1, 'a new revision reads the idle room at once, once');
  // A site without revisions keeps every room on the regular interval.
  supported = false;
  revision++;
  await run(60);
  const fallback = count('idle');
  await run(200);
  assert.ok(count('idle') >= fallback + 2, 'without revisions an idle room is polled as before');
});

test('the sweep removes stale unused launch folders, orphaned drafts and the old part of oversized logs only', t => {
  const home = mkdtempSync(join(tmpdir(), 'discussion-service-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const folder = name => { const path = join(home, 'launches', name); mkdirSync(join(path, 'runtime'), { recursive: true }); return path; };
  const registered = folder('registered'), stale = folder('stale'), recent = folder('recent'), held = folder('held');
  writeFileSync(join(registered, 'config.json'), readFileSync(room_config(home, 'http://127.0.0.1:1', 'kept'), 'utf8'));
  register_room(home, join(registered, 'config.json'));
  writeFileSync(join(held, 'runtime', 'runner.lock'), String(process.pid));
  const week_ago = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
  for (const path of [stale, held]) utimesSync(path, week_ago, week_ago);
  const drafts = Object.fromEntries(['registered', 'stale', 'recent'].map(name => [name, service_drafts(home, join(home, 'launches', name, 'runtime'))]));
  drafts.orphan = join(home, 'drafts', 'f'.repeat(64));
  for (const path of Object.values(drafts)) mkdirSync(path, { recursive: true });
  const log = join(home, 'local', 'website.log');
  mkdirSync(join(home, 'local'), { recursive: true });
  writeFileSync(log, `${'旧'.repeat(20)}\n`.repeat(200_000) + 'newest line\n');
  writeFileSync(join(home, 'service.log'), 'short\n');
  const removed = sweep_service_home(home);
  assert.deepEqual(removed.launches, ['stale']);
  // The stale folder's drafts go with it; only the draft folder no room uses is reported separately.
  assert.deepEqual(removed.drafts, [basename(drafts.orphan)]);
  assert.ok(!existsSync(drafts.stale));
  assert.deepEqual(readdirSync(join(home, 'launches')).sort(), ['held', 'recent', 'registered']);
  assert.ok(existsSync(drafts.registered) && existsSync(drafts.recent));
  assert.deepEqual(removed.logs, [join('local', 'website.log')]);
  assert.ok(statSync(log).size <= 1024 * 1024 && readFileSync(log, 'utf8').endsWith('newest line\n'));
  assert.ok(readFileSync(log, 'utf8').startsWith('旧'), 'the kept part starts at a whole line');
  assert.equal(readFileSync(join(home, 'service.log'), 'utf8'), 'short\n');
});

test('a room failure is reported without stopping the other rooms', async t => {
  const f = await fixture(t);
  const home = mkdtempSync(join(tmpdir(), 'discussion-service-'));
  register_room(home, room_config(home, f.config.site, 'room1'));
  register_room(home, room_config(home, f.config.site, 'room2'));
  const service = new DiscussionService(home, config => ({ stop_children() {},
    tick: async () => { if (config.room === 'room1') throw new Error('HTTP 500'); } }));
  t.after(async () => { await service.close(); rmSync(home, { recursive: true, force: true }); });
  await service.tick();
  const rooms = JSON.parse(readFileSync(join(home, 'status.json'), 'utf8')).rooms;
  assert.deepEqual(rooms.map(room => [room.room, room.status, room.error]), [['room1', 'error', 'HTTP 500'], ['room2', 'running', '']]);
});

test('a room deleted on the website is unregistered, while a missing route alone is only reported', async t => {
  const server = createServer((request, response) => {
    response.statusCode = 404;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ error: request.url === '/api/rooms/gone' ? '房间不存在' : '地址不存在' }));
  });
  await listen_local(server);
  const site = `http://127.0.0.1:${server.address().port}`;
  const home = mkdtempSync(join(tmpdir(), 'discussion-service-'));
  const gone = room_config(home, site, 'gone'), kept = room_config(home, site, 'kept');
  register_room(home, gone); register_room(home, kept);
  const drafts = service_drafts(home, join(home, 'data-gone'));
  mkdirSync(drafts, { recursive: true });
  const service = new DiscussionService(home, () => ({ stop_children() {}, tick: async () => { throw new Error('HTTP 404: 地址不存在'); } }));
  t.after(async () => { await service.close(); await new Promise(done => server.close(done)); rmSync(home, { recursive: true, force: true }); });
  await service.tick();
  assert.deepEqual(read_registry(home), [kept]);
  assert.ok(!existsSync(join(home, 'data-gone', 'runner.lock')), 'the deleted room releases its data-directory lock');
  assert.ok(!existsSync(drafts), 'the deleted room leaves no answer drafts behind');
  assert.ok(existsSync(gone), 'a configuration outside launches/ belongs to the user and stays');
  const rooms = JSON.parse(readFileSync(join(home, 'status.json'), 'utf8')).rooms;
  assert.deepEqual(rooms.map(room => [room.room, room.status]), [['kept', 'error']]);
});

test('a resident worker adopts connection corrections but rejects changes to its bound conversation context', async t => {
  const f = await fixture(t);
  const home = mkdtempSync(join(tmpdir(), 'discussion-service-'));
  const path = room_config(home, f.config.site, 'room1');
  register_room(home, path);
  const service = new DiscussionService(home, (config, store) => {
    store.context(config); store.bind('Gemini', 'existing-session');
    return { tick: async () => 'waiting', stop_children() {} };
  });
  t.after(async () => { await service.close(); rmSync(home, { recursive: true, force: true }); });
  await service.tick();
  const worker = service.workers.get(path);
  const previous_version = worker.state.config_version;
  const config = JSON.parse(readFileSync(path, 'utf8'));
  const connection = join(home, 'new-sidecar'); mkdirSync(connection);
  config.participants.Gemini.ipc_directory = connection;
  writeFileSync(path, JSON.stringify(config));
  await service.tick();
  assert.equal(worker.config.participants.Gemini.ipc_directory, connection);
  assert.notEqual(worker.state.config_version, previous_version);
  assert.equal(worker.store.binding('Gemini').session_id, 'existing-session');
  config.participants.Gemini.session_id = 'another-session';
  writeFileSync(path, JSON.stringify(config));
  await service.tick();
  assert.equal(worker.state.status, 'error');
  assert.match(worker.state.error, /身份配置发生变化/);
  assert.equal(worker.store.binding('Gemini').session_id, 'existing-session');
  assert.equal(worker.config.participants.Gemini.session_id, undefined);
});

test('a resident free room isolates member context changes and only blocks Codex switching during an active discussion', async t => {
  const f = await fixture(t);
  f.member.pending = [];
  const home = mkdtempSync(join(tmpdir(), 'discussion-service-free-context-'));
  const path = join(home, 'config.json');
  const data_directory = join(home, 'runtime');
  const config = { site: f.config.site, room: 'room', token: 'x'.repeat(32), mode: 'free', data_directory,
    members: { Codex: { token: 'm'.repeat(64) } },
    participants: { Codex: { adapter: 'codex_cli', executable: process.execPath, cwd: f.directory, session_id: 'codex-thread' } } };
  writeFileSync(path, JSON.stringify(config));
  register_room(home, path);
  const seeded = new DiscussionStore(data_directory);
  seeded.bind('Codex', 'codex-thread');
  seeded.close();
  let service = new DiscussionService(home);
  t.after(async () => { await service.close(); rmSync(home, { recursive: true, force: true }); });

  await service.tick();
  const worker = service.workers.get(path);
  const unrelated_child = { kill() {} };
  worker.runner.children.add(unrelated_child);
  worker.runner.members.set('Other', new Set([unrelated_child]));
  config.participants.Codex.adapter = 'codex';
  writeFileSync(path, JSON.stringify(config));
  await service.tick();
  assert.equal(worker.state.error, '', 'a free-room App/CLI switch does not stop the room worker');
  assert.equal(worker.runner.config.participants.Codex.adapter, 'codex');
  worker.runner.children.delete(unrelated_child);
  worker.runner.members.delete('Other');

  config.participants.Codex.cwd = tmpdir();
  writeFileSync(path, JSON.stringify(config));
  await service.tick();
  assert.equal(worker.state.error, '', 'a changed member context does not stop unrelated room work');
  assert.ok(worker.runner.context_errors.has('Codex'), 'only the changed member is blocked');
  assert.equal(worker.runner.room_title, f.room.title, 'the worker continues polling the room');

  await service.close();
  service = new DiscussionService(home);
  await service.tick();
  const restarted_worker = service.workers.get(path);
  assert.equal(restarted_worker.state.error, '', 'a service restart does not reject the stored free-room context');
  assert.ok(restarted_worker.runner.context_errors.has('Codex'), 'the changed member remains isolated after restart');

  f.room.session = { id: 1, status: 'active' };
  config.participants.Codex.adapter = 'codex_cli';
  writeFileSync(path, JSON.stringify(config));
  await service.tick();
  assert.match(restarted_worker.state.error, /讨论运行中不能切换 Codex 接入方式/);
});

test('Codex context switch is restricted to the original session and project', async t => {
  const f = await fixture(t);
  const original = { participants: { Codex: { adapter: 'codex_cli', cwd: f.config.directory } } };
  f.store.context(original);
  f.store.bind('Codex', 'original-session');
  const switched = { participants: { Codex: { ...original.participants.Codex, adapter: 'codex', session_id: 'original-session' } } };
  assert.throws(() => f.store.context(switched), /身份配置发生变化/);
  assert.throws(() => f.store.context({ participants: { Codex: { ...switched.participants.Codex, session_id: 'other-session' } } }, true), /身份配置发生变化/);
  assert.throws(() => f.store.context({ participants: { Codex: { ...switched.participants.Codex, cwd: tmpdir() } } }, true), /身份配置发生变化/);
  f.store.context(switched, true);
  f.store.context(switched);
  assert.equal(f.store.binding('Codex').session_id, 'original-session');
});

test('Codex worker waits for its old process to exit before adopting a paused switch', async t => {
  let service;
  t.after(() => service?.close());
  const f = await fixture(t);
  const home = join(f.config.directory, 'service');
  mkdirSync(home);
  const path = join(home, 'config.json');
  const config = { ...f.config, token: 'x'.repeat(32), project: undefined, data_directory: join(home, 'runtime'),
    participants: { Codex: { adapter: 'codex_cli', executable: process.execPath, session_id: 'original-session' } } };
  writeFileSync(path, JSON.stringify(config));
  register_room(home, path);
  const child = { kill() {} }, children = new Set([child]);
  service = new DiscussionService(home, (current, store) => {
    store.context(current);
    return { children, stop_children() {}, tick: async () => f.room.session?.status === 'paused' ? 'waiting' : undefined };
  });
  await service.tick();
  config.participants.Codex.adapter = 'codex';
  writeFileSync(path, JSON.stringify(config));
  await service.tick();
  const worker = service.workers.get(path);
  assert.equal(worker.config.participants.Codex.adapter, 'codex_cli', 'running rooms cannot adopt a switch');
  f.room.session = { id: 1, status: 'paused' };
  await service.tick();
  assert.match(worker.state.error, /等待原 CLI 进程退出/);
  assert.equal(worker.config.participants.Codex.adapter, 'codex_cli');
  children.clear();
  await service.tick();
  assert.equal(worker.config.participants.Codex.adapter, 'codex');
  assert.equal(worker.state.status, 'paused');
});

test('the same site and room cannot be registered twice', t => {
  const home = mkdtempSync(join(tmpdir(), 'discussion-service-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  register_room(home, room_config(home, 'http://127.0.0.1:8765', 'room1', 'a'));
  assert.throws(() => register_room(home, room_config(home, 'http://127.0.0.1:8765', 'room1', 'b')), /已由/);
});

test('invalid software in an existing configuration does not permit another owner for its room', t => {
  const home = mkdtempSync(join(tmpdir(), 'discussion-service-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const original = room_config(home, 'http://127.0.0.1:8765', 'room1', 'a');
  register_room(home, original);
  const config = JSON.parse(readFileSync(original, 'utf8'));
  config.participants = {};
  writeFileSync(original, JSON.stringify(config));
  assert.throws(() => register_room(home, room_config(home, 'http://127.0.0.1:8765', 'room1', 'b')), /已由/);
});

/** Widen overlapping registry writes in separate CLI processes without starting AI or a service. */
function concurrent_registration(home, config, gate, action = 'add') {
  const script = `import fs from 'node:fs'; import { join } from 'node:path';
    import { syncBuiltinESMExports } from 'node:module';
    const [home, config, gate, action] = process.argv.slice(1);
    const read = fs.readFileSync;
    const waiting = new Int32Array(new SharedArrayBuffer(4));
    fs.readFileSync = (...args) => {
      const value = read(...args);
      if (args[0] === join(home, 'rooms.json')) {
        if (action === 'crash') process.exit(37);
        Atomics.wait(waiting, 0, 0, 200);
      }
      return value;
    };
    syncBuiltinESMExports();
    const registry = await import(${JSON.stringify(new URL('../runner/discussion_service.mjs', import.meta.url).href)});
    process.stdout.write('ready');
    while (!fs.existsSync(gate)) Atomics.wait(waiting, 0, 0, 10);
    if (action === 'add') registry.register_room(home, config); else registry.unregister_room(home, config);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, home, config, gate, action], { windowsHide: true });
  let error = '';
  child.stderr.on('data', chunk => { error += chunk; });
  return { child, ready: once(child.stdout, 'data'), done: once(child, 'close').then(([code]) => assert.equal(code, action === 'crash' ? 37 : 0, error)) };
}

for (const action of ['add', 'remove']) test(`concurrent registry ${action} keeps the other process's room change`, async t => {
  const home = mkdtempSync(join(tmpdir(), 'discussion-registry-'));
  const gate = join(home, 'start');
  const first = room_config(home, 'http://127.0.0.1:8765', 'room1');
  const second = room_config(home, 'http://127.0.0.1:8765', 'room2');
  const third = room_config(home, 'http://127.0.0.1:8765', 'room3');
  register_room(home, first);
  const workers = [concurrent_registration(home, action === 'add' ? third : first, gate, action), concurrent_registration(home, second, gate)];
  t.after(() => { workers.forEach(worker => worker.child.kill()); rmSync(home, { recursive: true, force: true }); });
  await Promise.all(workers.map(worker => worker.ready));
  writeFileSync(gate, 'start');
  await Promise.all(workers.map(worker => worker.done));
  assert.deepEqual(read_registry(home).sort(), (action === 'add' ? [first, second, third] : [second]).sort());
  register_room(home, first);
  assert.ok(read_registry(home).includes(first), 'successful concurrent writes release their lock');
});

test('a registry writer exiting mid-update leaves existing rooms and releases the cross-process lock', async t => {
  const home = mkdtempSync(join(tmpdir(), 'discussion-registry-'));
  const gate = join(home, 'start');
  const first = room_config(home, 'http://127.0.0.1:8765', 'room1');
  const second = room_config(home, 'http://127.0.0.1:8765', 'room2');
  register_room(home, first);
  const worker = concurrent_registration(home, first, gate, 'crash');
  t.after(() => { worker.child.kill(); rmSync(home, { recursive: true, force: true }); });
  await worker.ready;
  writeFileSync(gate, 'start');
  await worker.done;
  assert.deepEqual(read_registry(home), [first]);
  register_room(home, second);
  assert.deepEqual(read_registry(home), [first, second]);
});

for (const [name, prefix] of [['discussion_service', []], ['codiscuss', []], ['codiscuss', ['service']]]) {
test(`${[name, ...prefix].join(' ')}: the detached service starts once, reports status and stops on request`, async t => {
  const home = mkdtempSync(join(tmpdir(), 'discussion-service-'));
  const script = fileURLToPath(new URL(`../runner/${name}.mjs`, import.meta.url));
  const env = { ...process.env, DISCUSS_SERVICE_HOME: home };
  const run = async (...args) => {
    const child = spawn(process.execPath, [script, ...prefix, ...args, ...(name === 'codiscuss' ? ['--json'] : [])], { env, cwd: tmpdir() });
    let output = ''; child.stdout.on('data', chunk => { output += chunk; });
    const [code] = await once(child, 'close');
    assert.equal(code, 0);
    return JSON.parse(output);
  };
  t.after(async () => { if (service_pid(home)) await run('stop'); rmSync(home, { recursive: true, force: true }); });
  const started = await run('start');
  assert.equal(started.started, true);
  assert.equal((await run('start')).started, false, 'a second start reuses the running service');
  assert.equal((await run('status')).pid, started.pid);
  assert.equal((await run('stop')).running, false);
  assert.equal(service_pid(home), 0);
});
}

/** Invoke the public CLI from outside the repository, capturing readable output. */
async function run_service_cli(env, ...args) {
  const script = fileURLToPath(new URL('../runner/codiscuss.mjs', import.meta.url));
  const child = spawn(process.execPath, [script, ...args], { env, cwd: tmpdir() });
  let output = ''; let error = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { error += chunk; });
  child.stdin.end();
  const [code] = await once(child, 'close');
  return { code, output, error };
}

test('simultaneous service starts share one process and only its creator reports ownership', async t => {
  const home = mkdtempSync(join(tmpdir(), 'discussion-start-'));
  const env = { ...process.env, DISCUSS_SERVICE_HOME: home };
  t.after(async () => { await run_service_cli(env, 'service', 'stop', '--json'); rmSync(home, { recursive: true, force: true }); });
  const results = await Promise.allSettled([start_service(home), start_service(home)]);
  assert(results.every(result => result.status === 'fulfilled'), JSON.stringify(results));
  assert.equal(new Set(results.map(result => result.value.pid)).size, 1);
  assert.equal(results.filter(result => result.value.started).length, 1);
  assert.equal(results[0].value.pid, service_pid(home));
  assert.equal(results[0].value.ready, true);
});

test('an existing process is reused only after its own readiness receipt arrives', async t => {
  const home = mkdtempSync(join(tmpdir(), 'discussion-ready-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  writeFileSync(join(home, 'runner.lock'), String(process.pid));
  writeFileSync(join(home, 'status.json'), JSON.stringify({ pid: process.pid + 1, updated_at: 1, rooms: [{ room: 'old-room' }] }));
  assert.equal(service_ready(home), false);
  let settled = false;
  const starting = start_service(home).then(result => { settled = true; return result; });
  await delay(250);
  assert.equal(settled, false, 'an alive PID and stale status must not mean ready');
  writeFileSync(join(home, 'status.json'), JSON.stringify({ pid: process.pid, updated_at: 1, ready: true }));
  const ready = await starting;
  assert.equal(ready.pid, process.pid);
  assert.equal(ready.started, false);
  assert.equal(ready.ready, true);
});

test('MSIX redirection fails before service startup or room creation and removes its probe', { skip: process.platform !== 'win32' }, async t => {
  const home = mkdtempSync(join(tmpdir(), 'discussion-msix-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  t.mock.method(realpathSync, 'native', path => join('C:\\Users\\example\\AppData\\Local\\Packages',
    'Example_123', 'LocalCache', 'Local', basename(path)));
  const redirected = /MSIX.*普通终端.*DISCUSS_SERVICE_HOME/;
  assert.throws(() => assert_shared_home(home), redirected);
  await assert.rejects(start_service(home), redirected);
  await assert.rejects(launch_discussion(home, {}), redirected);
  assert.deepEqual(readdirSync(home), [], 'no lock, launch record, or probe may remain');
});

test('service directory checks preserve absent homes and allow an explicit physical recovery path', () => {
  const home = mkdtempSync(join(tmpdir(), 'discussion-path-'));
  try {
    const absent = join(home, 'not-created', 'service');
    assert_shared_home(absent);
    assert.deepEqual(readdirSync(home), []);
    const physical = join(home, 'AppData', 'Local', 'Packages', 'Example_123', 'LocalCache', 'Local', 'service');
    mkdirSync(physical, { recursive: true });
    assert_shared_home(physical);
    assert.deepEqual(readdirSync(physical), []);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('CLI help and status do not start a service; unknown commands fail', async t => {
  const home = mkdtempSync(join(tmpdir(), 'discussion-cli-'));
  const env = { ...process.env, DISCUSS_SERVICE_HOME: home };
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const help = await run_service_cli(env, '--help');
  assert.equal(help.code, 0); assert.match(help.output, /Ctrl\+C/);
  assert.equal(existsSync(join(home, 'runner.lock')), false);
  const status = await run_service_cli(env, 'status');
  assert.equal(status.code, 0); assert.match(status.output, /讨论服务未运行/);
  const invalid = await run_service_cli(env, 'unknown');
  assert.equal(invalid.code, 2); assert.equal(invalid.output, '');
  assert.match(JSON.parse(invalid.error).error.hint, /codiscuss --help/);
  assert.equal(service_pid(home), 0);
});

test('unified help separates website run controls from the resident service', async t => {
  const home = mkdtempSync(join(tmpdir(), 'discussion-cli-'));
  const env = { ...process.env, DISCUSS_SERVICE_HOME: home, DISCUSS_URL: '' };
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const service_help = await run_service_cli(env, 'service', '--help');
  assert.equal(service_help.code, 0); assert.match(service_help.output, /codiscuss service/);
  const room_help = await run_service_cli(env, 'room', '--help');
  assert.equal(room_help.code, 0); assert.match(room_help.output, /codiscuss room/);
  const run_help = await run_service_cli(env, 'run', '--help');
  assert.equal(run_help.code, 0); assert.match(run_help.output, /codiscuss run/);
  const setup_help = await run_service_cli(env, 'setup', '--help');
  assert.equal(setup_help.code, 0); assert.match(setup_help.output, /--no-start/);
  assert.match(setup_help.output, /2=配置待处理/);
  assert.match(setup_help.output, /中文摘要写入 stderr；输出被重定向或加 --json 时结果 JSON 写入 stdout/);
  assert.match(setup_help.output, /codex,claude,antigravity,cursor/);
  assert.match(setup_help.output, /Cursor 当前只安装技能/);
  const local_help = await run_service_cli(env, 'local', '--help');
  assert.equal(local_help.code, 0); assert.match(local_help.output, /codiscuss local/);
  assert.match(local_help.output, /connect SITE/);
  assert.match(local_help.output, /disconnect SITE/);
  assert.equal(existsSync(join(home, 'local')), false);
  const schema = await run_service_cli(env, 'schema', 'message', 'post');
  assert.equal(schema.code, 0); assert.equal(JSON.parse(schema.output).ok, true);
  assert.equal(schema.error, ''); assert.equal(service_pid(home), 0);
});

test('website commands preserve global flags and return clean JSON without starting the service', async t => {
  const home = mkdtempSync(join(tmpdir(), 'discussion-cli-'));
  const requests = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      requests.push({ method: request.method, url: request.url, body: body ? JSON.parse(body) : null });
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(request.url === '/api/health' ? { ok: true } : { session: null, status: 'paused' }));
    });
  });
  await listen_local(server);
  const site = `http://127.0.0.1:${server.address().port}`;
  const env = { ...process.env, DISCUSS_SERVICE_HOME: home, DISCUSS_URL: site };
  t.after(async () => { await new Promise(resolve => server.close(resolve)); rmSync(home, { recursive: true, force: true }); });
  const health = await run_service_cli(env, '--site', site, 'health');
  assert.equal(health.code, 0, health.error || health.output); assert.equal(health.error, '');
  assert.equal(JSON.parse(health.output).data.ok, true);
  const runtime = await run_service_cli(env, 'run', 'view', 'room');
  assert.equal(runtime.code, 0); assert.equal(runtime.error, '');
  assert.equal(JSON.parse(runtime.output).data.status, 'paused');
  const started = await run_service_cli(env, 'run', 'start', 'room', '--revision', 'r1', '--goal', 'goal');
  assert.equal(started.code, 0); assert.equal(started.error, '');
  const roster = await run_service_cli(env, 'turn', 'roster', 'room');
  assert.equal(roster.code, 0); assert.equal(roster.error, '');
  const continued = await run_service_cli(env, 'turn', 'continue', 'room', '--as', 'Codex', '--roster', 'r2');
  assert.equal(continued.code, 0); assert.equal(continued.error, '');
  assert.deepEqual(requests.map(({ method, url }) => `${method} ${url}`), [
    'GET /api/health', 'GET /api/rooms/room/discussion', 'POST /api/rooms/room/discussion',
    'GET /api/rooms/room/turns/roster', 'POST /api/rooms/room/turns/continue',
  ]);
  assert.deepEqual(requests[2].body, { action: 'start', revision: 'r1', goal: 'goal' });
  assert.deepEqual(requests[4].body, { actor: 'Codex', revision: 'r2' });
  assert.equal(existsSync(join(home, 'runner.lock')), false);
});

test('unified message submission preserves UTF-8 stdin, quoted arguments and caller-relative files', async t => {
  const home = mkdtempSync(join(tmpdir(), 'discussion-cli-'));
  const env = { ...process.env, DISCUSS_SERVICE_HOME: home, DISCUSS_URL: '' };
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const script = fileURLToPath(new URL('../runner/codiscuss.mjs', import.meta.url));
  const body = '完整中文正文\n含 "引号" 与 $字面量';
  const args = ['message', 'post', 'room', '--as', 'Claude', '--summary', '中文 简述',
    '--submission-id', 'unified-preview', '--site', 'http://127.0.0.1:1', '--dry-run'];
  const child = spawn(process.execPath, [script, ...args, '--body-file', '-'], { env, cwd: tmpdir() });
  let output = ''; let error = '';
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { error += chunk; });
  child.stdin.end(body);
  const [code] = await once(child, 'close');
  assert.equal(code, 0, error); assert.equal(error, '');
  const preview = JSON.parse(output);
  assert.equal(preview.data.body.text, body); assert.equal(preview.data.body.kind, 'chat');
  assert.equal(preview.data.body.summary, '中文 简述');
  const file = join(home, '中文 正文.txt'); writeFileSync(file, body);
  const from_file = await run_service_cli(env, ...args, '--body-file', relative(tmpdir(), file));
  assert.equal(from_file.code, 0, from_file.error); assert.equal(from_file.error, '');
  assert.equal(JSON.parse(from_file.output).data.body.text, body);
  assert.equal(service_pid(home), 0);
});

test('a website write with a lost response keeps exit code 3 and is never retried by the unified CLI', async t => {
  const home = mkdtempSync(join(tmpdir(), 'discussion-cli-'));
  const env = { ...process.env, DISCUSS_SERVICE_HOME: home };
  let writes = 0;
  const server = createServer(async (request) => {
    for await (const chunk of request) { void chunk; }
    writes++;
    request.socket.destroy();
  });
  await listen_local(server);
  t.after(async () => { await new Promise(resolve => server.close(resolve)); rmSync(home, { recursive: true, force: true }); });
  const result = await run_service_cli(env, 'api', '/api/rooms', '--method', 'POST', '--input', '-',
    '--site', `http://127.0.0.1:${server.address().port}`);
  assert.equal(result.code, 2, 'missing stdin is rejected before sending');
  assert.equal(writes, 0);
  const file = join(home, 'request.json'); writeFileSync(file, JSON.stringify({ title: '测试', submission_id: 'unified-write' }));
  writeFileSync(join(home, 'owner.json'), JSON.stringify({ site: `http://127.0.0.1:${server.address().port}`,
    room: '', submission_id: 'unified-write', token: randomUUID() }));
  const uncertain = await run_service_cli(env, 'api', '/api/rooms', '--method', 'POST', '--input', file,
    '--site', `http://127.0.0.1:${server.address().port}`, '--access-file', join(home, 'owner.json'));
  assert.equal(uncertain.code, 3); assert.equal(uncertain.output, '');
  assert.equal(JSON.parse(uncertain.error).error.outcome, 'unknown');
  assert.equal(writes, 1); assert.equal(service_pid(home), 0);
});

test('the default CLI runs visibly, reports room state and can be stopped from another terminal', async t => {
  const f = await fixture(t);
  f.member.pending = [];
  f.room.session = { id: 1, status: 'paused' };
  const home = mkdtempSync(join(tmpdir(), 'discussion-cli-'));
  const env = { ...process.env, DISCUSS_SERVICE_HOME: home };
  const config = room_config(home, f.config.site, 'room1');
  const added = await run_service_cli(env, 'add', '--config', config);
  assert.equal(added.code, 0); assert.match(added.output, /已登记房间/);
  writeFileSync(join(home, 'stop.request'), 'stale request');
  const script = fileURLToPath(new URL('../runner/codiscuss.mjs', import.meta.url));
  const child = spawn(process.execPath, [script], { env, cwd: tmpdir() });
  const closed = once(child, 'close');
  let output = ''; child.stdout.on('data', chunk => { output += chunk; });
  try {
    for (let attempt = 0; attempt < 200 && !output.includes('运行中'); attempt++) await delay(25);
    assert.match(output, /讨论服务已启动/); assert.match(output, /Ctrl\+C/);
    assert.match(output, /room1: 运行中/);
    assert.equal(service_pid(home), child.pid);
    const duplicate = await run_service_cli(env);
    assert.equal(duplicate.code, 0); assert.match(duplicate.output, new RegExp(`PID ${child.pid}`));
    const status = await run_service_cli(env, 'status');
    assert.match(status.output, /运行中/); assert.match(status.output, /room1：运行中/);
  } finally {
    if (service_pid(home)) await run_service_cli(env, 'stop');
    else if (child.exitCode === null) child.kill();
    await closed;
    assert.equal(service_pid(home), 0);
    rmSync(home, { recursive: true, force: true });
  }
  assert.match(output, /讨论服务已停止/);
  assert.deepEqual(f.calls, [], 'starting the service never starts a paused discussion');
});

test('the foreground service releases its lock when interrupted', async t => {
  const home = mkdtempSync(join(tmpdir(), 'discussion-cli-'));
  const env = { ...process.env, DISCUSS_SERVICE_HOME: home };
  const script = new URL('../runner/codiscuss.mjs', import.meta.url).href;
  const source = `setTimeout(() => process.emit('SIGINT'), 500); await import(${JSON.stringify(script)});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { env, cwd: tmpdir() });
  let output = ''; child.stdout.on('data', chunk => { output += chunk; });
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const [code] = await once(child, 'close');
  assert.equal(code, 0); assert.match(output, /尚未登记房间/);
  assert.match(output, /讨论服务已启动/); assert.match(output, /讨论服务已停止/);
  assert.equal(existsSync(join(home, 'runner.lock')), false);
});

test('a Claude CLI launched from a hosting Claude session drops host variables and keeps its own login', () => {
  const host = { CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'claude-desktop', CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH: '1', PATH: 'bin' };
  const env = standalone_claude_env(host, () => ({ CLAUDE_CODE_OAUTH_TOKEN: 'persisted' }));
  assert.deepEqual(env, { PATH: 'bin', CLAUDE_CODE_OAUTH_TOKEN: 'persisted' });
  const plain = { PATH: 'bin', CLAUDE_CODE_OAUTH_TOKEN: 'own' };
  assert.equal(standalone_claude_env(plain, () => { throw new Error('not read'); }), plain);
});

/** A minimal free-room website: one member, durable executions keyed by client id. */
async function free_fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'free-room-test-'));
  // `pending` belongs to Claude (id 7); `others` adds members with their own queues.
  const state = { pending: [{ id: 1, message_id: 11 }, { id: 2, message_id: 12 }], others: [], executions: [], calls: [], archived: false, reports: {},
    room: { title: '自由单聊', mode: 'free', host: 'Claude', latest_id: 12, rounds: [], limits: { reached: false } },
    session: null, roster: null, turns: [], messages: [] };
  const server = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk;
    const body = text ? JSON.parse(text) : null;
    const url = request.url.replace('/api/rooms/room', '');
    let result;
    state.calls.push(`${request.method} ${url}${body?.action ? ` ${body.action}` : ''}`);
    if (url === '/members/7/capabilities') { state.rewind = body.rewind; result = { member_id: 7, rewind: body.rewind }; }
    else if (url === '/inbox') {
      result = { archived: state.archived, execution_minutes: 20,
        members: [{ id: 7, name: 'Claude', role: state.claude_role || 'member', pending: state.pending, held_until: state.held_until || 0,
          ...(state.rewind === undefined ? {} : { rewind: state.rewind }) }, ...state.others],
        executions: state.executions.filter(item => ['dispatched', 'started'].includes(item.status)) };
    } else if (url === '/executions') {
      let execution = state.executions.find(item => item.client_id === body.client_id);
      if (!execution) {
        const other = state.others.find(item => item.id === body.member_id);
        const queue = other ? other.pending : state.pending;
        execution = { id: state.executions.length + 1, client_id: body.client_id, status: 'dispatched', member: other?.name || 'Claude',
          cwd: body.cwd, created_at: Math.floor(Date.now() / 1000), lease_until: Math.floor(Date.now() / 1000) + 120,
          read_until: 10, requests: queue.map(item => ({ ...item, status: 'delivering' })) };
        state.executions.push(execution);
        if (other) other.pending = []; else state.pending = [];
      }
      result = execution;
    } else if (url.startsWith('/executions/')) {
      const execution = state.executions.find(item => item.id === Number(url.split('/')[2]));
      if (body?.action === 'fail') {
        execution.status = 'failed'; execution.result = body.reason;
        const failed_request = execution.requests.find(item => item.purpose === 'discuss' && item.session_id);
        if (failed_request) state.pending = [{ id: 90, purpose: 'discuss_host', session_id: failed_request.session_id,
          cause_kind: 'request_failed', source_message_id: failed_request.message_id }];
      }
      if (body?.action === 'release') { execution.status = 'cancelled'; state.pending = execution.requests; }
      if (body?.action === 'report') state.reports[execution.id] = body.changes;
      if (body?.action === 'delivery') execution.capabilities = { stoppable: body.stoppable, progress: body.progress };
      // Like the site, only a voided execution takes a stop result.
      if (body?.action === 'stopped' && execution.status !== 'cancelled') {
        response.writeHead(409, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: '只有已作废的执行才报告停止结果' })); return;
      }
      if (body?.action === 'stopped') {
        if (state.stop_failure === 'before') {
          response.writeHead(503); response.end(JSON.stringify({ error: 'temporary failure' })); return;
        }
        execution.stop_result = body.result;
        if (state.stop_failure === 'after') { response.destroy(); return; }
      }
      if (body?.action === 'renew') state.renewed = body;
      if (body?.action === 'retry_wait') execution.retry = { attempt: body.attempt, retry_at: body.retry_at, reason: body.reason, stopped: 0 };
      if (body?.action === 'retry_start') execution.retry.retry_at = 0;
      if (body?.action === 'segments') { (state.segments ||= []).push(body.segments); if (body.notes) (state.notes ||= []).push(body.notes); }
      result = execution;
    } else if (url.startsWith('/messages?after=')) {
      if (state.fail_messages) { response.writeHead(503, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: 'context unavailable' })); return; }
      // Like the website: one page of at most 20 messages after the cursor.
      const after = Number(url.split('=')[1]);
      result = { messages: (state.messages || []).filter(item => item.id > after).slice(0, 20) };
    } else if (url === '/discussion') result = { session: state.session, revision: 'session-r1' };
    else if (url === '/turns/roster') result = state.roster;
    else if (url.startsWith('/turns') && request.method === 'GET') {
      const page = Number(new URL(request.url, 'http://localhost').searchParams.get('page') || 1);
      result = { turns: state.turns.slice((page - 1) * 20, page * 20), page, pages: Math.max(1, Math.ceil(state.turns.length / 20)), total: state.turns.length };
    }
    else if (url === '/turns' && request.method === 'POST') { state.plans = [...(state.plans || []), body]; result = { ok: true }; }
    else if (url.startsWith('/messages?after=')) {
      const after = Number(url.split('=')[1]); result = { messages: state.messages.filter(item => item.id > after).slice(0, 20) };
    } else if (url.startsWith('/recommendations/') && request.method === 'GET') {
      const members = [{ id: 7, name: 'Claude', role: 'host' }, ...state.others];
      result = { request: state.pending.find(item => item.purpose === 'group'), revision: 'group-r1',
        members: members.map(member => ({ ...member, description: state.room.descriptions?.[member.name] || '' })),
        title: state.room.title, goal: state.room.goal, latest_id: state.room.latest_id };
    } else if (url.startsWith('/recommendations/') && state.pending.some(item => item.purpose === 'group')) {
      if (state.fail_apply || state.change_apply) {
        const status = state.fail_apply ? 503 : 409;
        if (state.fail_apply) state.fail_apply--; else state.change_apply--;
        response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: 'group apply unavailable' })); return;
      }
      (state.group_posts ||= []).push(body);
      state.pending = state.pending.map(item => item.purpose === 'group' ? { ...item,
        purpose: body.action === 'host' ? 'route' : body.action === 'all' ? 'all' : 'ask', group_action: body.action } : item);
      result = { action: body.action };
    } else if (url.startsWith('/reviews/') && url.endsWith('/ready')) {
      if (state.fail_review_read) { response.writeHead(503); response.end('{}'); return; }
      result = state.review_ready;
    } else if (url === '/reviews/advance') {
      if (state.stale_review) { response.writeHead(409); response.end('{}'); return; }
      (state.review_posts ||= []).push(body);
      state.review_ready.plan.advance_submission = body.submission_id;
      state.pending = state.pending.filter(item => item.review?.phase !== 'handoff');
      result = { review_batch_id: 40 };
      if (state.drop_review_reply) { request.socket.destroy(); return; }
    } else if (url === '/scheduler-decisions') { (state.decisions ||= []).push(body); result = { id: state.decisions.length }; }
    else if (url === '/scheduler-routing') { (state.routing ||= []).push(body); result = {}; }
    else result = { ...state.room, session: state.session };
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(result));
  });
  await listen_local(server);
  const store = new DiscussionStore(directory);
  t.after(async () => { store.close(); await new Promise(resolve => server.close(resolve));
    rmSync(directory, { recursive: true, force: true }); rmSync(`${directory}-drafts`, { recursive: true, force: true }); });
  const config = { site: `http://127.0.0.1:${server.address().port}`, room: 'room', token: 'owner-credential'.repeat(3), mode: 'free',
    directory, project: directory, participants: { Claude: { adapter: 'claude' } }, members: { Claude: { token: 'member-credential'.repeat(3) } } };
  return { state, store, config };
}

function scheduler_fetch(answers) {
  return async () => ({ ok: true, json: async () => ({ answers }) });
}

function with_scheduler(config) {
  const base_url = SCHEDULER_PROVIDERS.jev.base_url;
  return { ...config, api_home: config.directory, scheduler: { provider: 'jev', model: 'jev-1.13',
    base_url,
    ...save_api_key(config.directory, { base_url, api_key: 'runner-test-key' }) } };
}

/** A preauthorized review fixture exposes original text without shortening it. */
async function review_runner_fixture(t) {
  const f = await free_fixture(t);
  f.config = with_scheduler(f.config);
  f.state.claude_role = 'host';
  f.state.pending = [{ id: 1, message_id: 11, purpose: 'handoff', review: { batch_id: 11, phase: 'handoff' } }];
  f.state.review_ready = { ready: true, reason: '', revision: 'review-r1', original: { text: '实现导入并运行测试' },
    plan: { reviewer_name: 'Codex-评审', scope: '核对实现' },
    deliveries: [{ status: 'completed', answer: '导入已完成，测试通过。', execution_status: 'completed', result: '完成' }] };
  return f;
}

for (const probability of [0.85, 0.849]) test(`review completion applies its exact 0.85 threshold (${probability})`, async t => {
  const { state, config, store } = await review_runner_fixture(t);
  let seen;
  const runner = new FreeRoomRunner(config, store, async () => ({ status: 'accepted' }), () => {}, async (url, init) => {
    seen = JSON.parse(init.body);
    return scheduler_fetch({ completion: { type: 'choice', choice: 'review', probabilities: { review: probability } } })();
  });
  await runner.tick();
  assert.equal(state.executions.length, 0, 'host waits until the decision finishes');
  await Promise.all(runner.decisions);
  assert.equal(state.review_posts?.length || 0, probability === 0.85 ? 1 : 0);
  assert.equal(JSON.parse(seen.state).deliveries[0].answer, state.review_ready.deliveries[0].answer);
  assert.equal(state.decisions[0].context.scene, 'review');
  assert.equal(state.decisions[0].context.threshold, 0.85);
  if (probability < 0.85) {
    const restarted = new FreeRoomRunner(config, store, async () => ({ status: 'accepted' }), () => {}, assert.fail);
    await restarted.tick(); await Promise.all(restarted.decisions);
    assert.equal(state.executions.length, 1);
    assert.equal(restarted.saved_suggestion(1).applied, false);
  }
});

for (const cause of ['too_long', 'missing', 'hard_block', 'read_failure', 'model_failure', 'changed', 'lost_reply', 'no_scheduler']) {
  test(`review completion safely handles ${cause}`, async t => {
    const { state, config, store } = await review_runner_fixture(t);
    if (cause === 'too_long') state.review_ready.deliveries[0].answer = '长'.repeat(60000);
    if (cause === 'missing') state.review_ready.original = null;
    if (cause === 'hard_block') Object.assign(state.review_ready, { ready: false, reason: '额度不足' });
    if (cause === 'read_failure') state.fail_review_read = true;
    if (cause === 'changed') state.stale_review = true;
    if (cause === 'lost_reply') state.drop_review_reply = true;
    if (cause === 'no_scheduler') delete config.scheduler;
    let calls = 0;
    const runner = new FreeRoomRunner(config, store, async () => ({ status: 'accepted' }), () => {}, async () => {
      calls++; if (cause === 'model_failure') throw new Error('offline');
      return scheduler_fetch({ completion: { type: 'choice', choice: 'review', confidence: 0.99 } })();
    });
    await runner.tick(); await Promise.all(runner.decisions);
    assert.equal(calls, ['model_failure', 'changed', 'lost_reply'].includes(cause) ? 1 : 0);
    assert.equal(state.review_posts?.length || 0, cause === 'lost_reply' ? 1 : 0);
    if (cause === 'no_scheduler') assert.equal(runner.saved_suggestion(1), null);
    else assert.equal(runner.saved_suggestion(1).applied, cause === 'lost_reply');
    if (cause !== 'lost_reply') {
      await runner.tick(); await Promise.all(runner.decisions);
      assert.equal(state.executions.length, 1, 'the original host request is delivered');
    }
  });
}

test('review completion resumes a persisted advance without repeating the model or changing its submission', async t => {
  const { state, config, store } = await review_runner_fixture(t);
  const request = state.pending[0];
  store.db.prepare('INSERT INTO metadata VALUES (?,?)').run('review-decision:1', JSON.stringify({
    decision: { action: 'review', confidence: 0.99, label: '交评审' }, revision: 'review-r1',
    submission_id: 'persisted-review-submit', profiles: JSON.stringify(config.participants),
  }));
  const runner = new FreeRoomRunner(config, store, async () => ({ status: 'accepted' }), () => {}, assert.fail);
  await runner.tick(); await Promise.all(runner.decisions);
  assert.equal(state.review_posts[0].submission_id, 'persisted-review-submit');
  assert.equal(runner.saved_suggestion(request.id).applied, true);
});

test('the session driver schedules an opening, relays a mid-round answer, then starts and continues round two', async t => {
  const f = await free_fixture(t);
  const config = with_scheduler(f.config);
  f.state.messages = [{ id: 20, author: 'Codex', text: '开场观点' }];
  const driver = new SessionDriver(config, () => {}, scheduler_fetch({
    speaker: { type: 'choice', choice: 'Codex', confidence: 0.9, probabilities: {} },
  }));
  const session = { id: 7, status: 'active', goal: '比较方案', phase: 'initial', named_followup: false };
  const roster = { round: 1, waiting: ['Codex', 'Gemini'], experts: [
    { name: 'Claude', host: true }, { name: 'Codex', host: false, registered: true }, { name: 'Gemini', host: false, registered: true },
  ] };
  const room = { latest_id: 20, title: '房间', host: 'Claude' };
  const first = await driver.plan(session, roster, [], { cause_kind: 'round_complete' }, room);
  assert.equal(first.turn.question, '请先独立阅读议题，给出你的开场观点。');

  const first_round_turns = [
    { round: 1, expert: 'Codex', status: 'answered', answer_id: 20 },
    { round: 1, expert: 'Gemini', status: 'answered', answer_id: 21 },
  ];
  const second_driver = new SessionDriver(config, () => {}, scheduler_fetch({
    speaker: { type: 'choice', choice: 'Gemini', confidence: 0.9, probabilities: {} },
  }));
  const active_session = { ...session, phase: 'discussion' };
  const midround = await second_driver.plan(active_session, { ...roster, waiting: ['Gemini'] }, [first_round_turns[0]],
    { cause_kind: 'speaker_answered' }, room);
  assert.equal(midround.action, 'schedule', JSON.stringify(midround));
  assert.equal(midround.turn.question, '请先阅读议题和已有回答，给出你的观点。');

  const new_round_driver = new SessionDriver(config, () => {}, scheduler_fetch({
    next: { type: 'choice', choice: 'continue', confidence: 0.9, probabilities: {} },
    first: { type: 'choice', choice: 'Codex', confidence: 0.9, probabilities: {} },
  }));
  const new_round = await new_round_driver.plan(active_session, { ...roster, round: 1, waiting: [] }, first_round_turns,
    { cause_kind: 'round_complete' }, room);
  assert.match(new_round.turn.question, /第 2 轮/);

  const round_two_driver = new SessionDriver(config, () => {}, scheduler_fetch({
    speaker: { type: 'choice', choice: 'Gemini', confidence: 0.9, probabilities: {} },
  }));
  const round_two_next = await round_two_driver.plan(active_session, { ...roster, round: 2, waiting: ['Gemini'] },
    [...first_round_turns, { round: 2, expert: 'Codex', status: 'answered', answer_id: 22 }],
    { cause_kind: 'speaker_answered' }, room);
  assert.match(round_two_next.turn.question, /第 2 轮/);
});

test('user interjection planning stays separate from discussion turns, including web and registered manual candidates', async t => {
  const f = await free_fixture(t);
  const driver_config = with_scheduler(f.config);
  f.state.messages = [{ id: 21, author: '用户', text: '请回应这个风险' }];
  const roster = { round: 1, waiting: ['Codex', 'Gemini'], experts: [
    { name: 'Codex', host: false, mode: 'manual', manual_source: '', registered: true },
    { name: 'Gemini', host: false, mode: 'manual', manual_source: 'web', registered: true },
  ] };
  const driver = new SessionDriver(driver_config, () => {}, scheduler_fetch({
    handling: { type: 'choice', choice: 'Gemini', confidence: 0.9, probabilities: {} },
  }));
  const plan = await driver.plan({ id: 7, status: 'active', goal: '评估风险', phase: 'discussion', named_followup: false },
    roster, [],
    { cause_kind: 'user_message', source_message_id: 21 }, { latest_id: 21, title: '房间', host: 'Claude' });
  assert.equal(plan.kind, 'interjection');
  assert.equal(plan.expert, 'Gemini');
  assert.equal(plan.action, 'ask');
  assert.equal(plan.after_message_id, 21);
  const manual_driver = new SessionDriver(driver_config, () => {}, scheduler_fetch({
    handling: { type: 'choice', choice: 'Codex', confidence: 0.9, probabilities: {} },
  }));
  const manual_plan = await manual_driver.plan({ id: 7, status: 'active', goal: '评估风险', phase: 'discussion', named_followup: false },
    roster, [], { cause_kind: 'user_message', source_message_id: 21 },
    { latest_id: 21, title: '房间', host: 'Claude' });
  assert.equal(manual_plan.expert, 'Codex');

  const { state, store, config } = await free_fixture(t);
  state.session = { id: 7, status: 'active', goal: '讨论', phase: 'discussion' };
  state.room.phase = 'discussion';
  state.pending = [{ id: 9, message_id: 22, purpose: 'ask' }];
  const delivered = [];
  await new FreeRoomRunner(config, store, async (adapter, binding, task) => { delivered.push(JSON.parse(readFileSync(join(config.directory, 'free-1.task.json'), 'utf8'))); return { status: 'accepted' }; }).tick();
  assert.equal(delivered[0].mode, 'free');
  assert.equal(delivered[0].session.phase, 'discussion');
  assert.equal(delivered[0].discussion_request, undefined, 'a direct question is a free request outside the session plan');
});

test('interjection scheduler uses ordinary asks after all members have spoken, including the host', async t => {
  const { state, config: original_config } = await free_fixture(t);
  const config = with_scheduler(original_config);
  state.session = { id: 7, status: 'active', goal: '讨论', phase: 'discussion' };
  state.room = { ...state.room, session: state.session, latest_id: 30 };
  state.messages = [{ id: 30, author: '用户', text: 'Claude，你说的数字有什么来源？' }];
  state.pending = [{ id: 9, purpose: 'discuss_host', session_id: 7, cause_kind: 'user_message', source_message_id: 30 }];
  state.turns = [{ id: 1, round: 1, expert: 'Gemini', status: 'answered', answer_id: 29 }];
  state.roster = { revision: 'r1', round: 1, waiting: [], experts: [
    { name: 'Claude', host: true, registered: true }, { name: 'Gemini', spoken: true, registered: true }] };
  const writes = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith('/turns/ask')) { writes.push(JSON.parse(init.body)); return new Response(JSON.stringify({ request: { id: 10 } })); }
    return original(input, init);
  };
  t.after(() => { globalThis.fetch = original; });
  const driver = new SessionDriver(config, () => {}, scheduler_fetch({ handling: { type: 'choice', choice: 'Claude', confidence: 0.9 } }));
  assert.equal(await driver.tick(state.room, { archived: false, members: [{ name: 'Claude', role: 'host', pending: state.pending }], executions: [] }), true);
  assert.deepEqual(writes[0], { actor: 'Claude', revision: 'r1', request_id: 9, expert: 'Claude', submission_id: 'session-ask-7-9' });
  assert.ok(!state.calls.includes('POST /turns'));
  assert.equal(driver.take_suggestions(9)[0].actual_action, 'ask');
});

test('session scheduler failures and reached limits leave progression with the host without ordinary routing', async t => {
  const { state, store, config } = await free_fixture(t);
  Object.assign(config, with_scheduler(config));
  state.session = { id: 7, status: 'active', goal: '目标', phase: 'discussion', named_followup: false };
  state.room.phase = 'discussion';
  state.room.session = state.session;
  state.pending = [{ id: 9, purpose: 'discuss_host', session_id: 7, cause_kind: 'speaker_answered' }];
  state.roster = { revision: 'r1', round: 1, waiting: ['Gemini'], experts: [{ name: 'Gemini', host: false, spoken: false, registered: true }] };
  const logs = [];
  const runner = new FreeRoomRunner(config, store, async () => ({ status: 'accepted' }), message => logs.push(message),
    async () => { throw new Error('scheduler unavailable'); });
  const inbox = { archived: false, members: [{ name: 'Claude', role: 'host', pending: state.pending }], observers: [], executions: [] };
  runner.recommend_unnamed(inbox, state.room);
  assert.equal(state.calls.some(call => call.startsWith('POST /scheduler-routing')), false, 'a system host request is not a free message route');
  assert.equal(await runner.session_driver.tick(state.room, inbox), false);
  assert.match(logs[0], /交回主持人/);
  const saved = runner.session_driver.take_suggestions(9);
  assert.deepEqual([saved[0].request_id, saved[0].applied, saved[0].model_judgment], [9, false, false]);
  assert.equal(saved[0].decision_id, undefined);
  const restored = new SessionDriver(config, () => {}, async () => assert.fail('failed judgment must stay handed back'), store);
  assert.deepEqual(restored.take_suggestions(9), saved);
  assert.equal(await restored.tick(state.room, inbox), false);

  state.room.limits.reached = true;
  const before = state.calls.length;
  assert.equal(await runner.session_driver.tick(state.room, inbox), false);
  assert.equal(state.calls.length, before, 'a reached limit triggers no further scheduler request');
});

test('session scheduler evaluates a host request at most once across overlapping and repeated ticks', async t => {
  const { state, config } = await free_fixture(t);
  Object.assign(config, with_scheduler(config));
  state.session = { id: 7, status: 'active', goal: '目标', phase: 'discussion', named_followup: false };
  state.room.phase = 'discussion'; state.room.session = state.session;
  state.pending = [{ id: 9, purpose: 'discuss_host', session_id: 7, cause_kind: 'speaker_answered' }];
  state.roster = { revision: 'r1', round: 1, waiting: ['Gemini'], experts: [{ name: 'Gemini', host: false, spoken: false, registered: true }] };
  let model_calls = 0;
  let release_model;
  let mark_model_started;
  const model_started = new Promise(resolve => { mark_model_started = resolve; });
  const model_response = new Promise(resolve => { release_model = resolve; });
  const driver = new SessionDriver(config, () => {}, async () => {
    model_calls++;
    mark_model_started();
    await model_response;
    return { ok: true, json: async () => ({ answers: {
      speaker: { type: 'choice', choice: '__host__', confidence: 0.99, probabilities: {} },
    } }) };
  });
  const inbox = { archived: false, members: [{ name: 'Claude', role: 'host', pending: state.pending }], executions: [] };
  const first_tick = driver.tick(state.room, inbox);
  await model_started;
  assert.equal(await driver.tick(state.room, inbox), false, 'an overlapping tick must reuse the in-flight decision');
  release_model();
  assert.equal(await first_tick, false, 'the model hands this request back to its host');
  assert.equal(await driver.tick(state.room, inbox), false, 'a handed-back request must not be sent to the model again');
  assert.equal(model_calls, 1);
  state.pending = [{ id: 10, purpose: 'discuss_host', session_id: 7, cause_kind: 'speaker_answered' }];
  inbox.members[0].pending = state.pending;
  await driver.tick(state.room, inbox);
  assert.equal(model_calls, 2, 'a new host request must receive its own scheduling decision');
});

test('session auto-scheduling refuses to apply an old roster revision after the model returns', async t => {
  const { state, store, config } = await free_fixture(t);
  Object.assign(config, with_scheduler(config));
  state.session = { id: 7, status: 'active', goal: '目标', phase: 'discussion', named_followup: false };
  state.room.phase = 'discussion'; state.room.session = state.session;
  state.pending = [{ id: 9, purpose: 'discuss_host', session_id: 7, cause_kind: 'speaker_answered' }];
  state.roster = { revision: 'r1', round: 1, waiting: ['Gemini'], experts: [{ name: 'Gemini', host: false, spoken: false, registered: true }] };
  let roster_reads = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes('/turns/roster')) {
      roster_reads++;
      return new Response(JSON.stringify({ ...state.roster, revision: roster_reads === 1 ? 'r1' : 'r2' }), { status: 200 });
    }
    return originalFetch(input, init);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const driver = new SessionDriver(config, () => {}, async () => ({ ok: true, json: async () => ({ answers: {
    speaker: { type: 'choice', choice: 'Gemini', confidence: 0.9, probabilities: {} },
  } }) }));
  await driver.tick(state.room, { archived: false, members: [{ name: 'Claude', role: 'host', pending: state.pending }], executions: [] });
  assert.equal(state.plans?.length || 0, 0);
});

test('session driver reads every turns page before choosing an opening or peer question', async t => {
  const { state, store, config } = await free_fixture(t);
  Object.assign(config, with_scheduler(config));
  state.session = { id: 7, status: 'active', goal: '目标', phase: 'discussion', named_followup: false };
  state.room.phase = 'discussion'; state.room.session = state.session;
  state.room.latest_id = 40;
  state.pending = [{ id: 9, purpose: 'discuss_host', session_id: 7, cause_kind: 'speaker_answered', source_message_id: 40 }];
  state.turns = Array.from({ length: 20 }, (_, index) => ({ id: index + 1, round: 1, expert: `Expert-${index}`, status: 'answered', answer_id: index + 1 }));
  state.turns.push({ id: 21, round: 1, expert: 'Gemini', status: 'answered', answer_id: 21 });
  state.roster = { revision: 'r1', round: 2, waiting: ['Gemini'], experts: [{ name: 'Gemini', host: false, spoken: false, registered: true }] };
  const driver = new SessionDriver(config, () => {}, scheduler_fetch({
    speaker: { type: 'choice', choice: 'Gemini', confidence: 0.9, probabilities: {} },
  }));
  await driver.tick(state.room, { archived: false, members: [{ name: 'Claude', role: 'host', pending: state.pending }], executions: [] });
  assert.ok(state.calls.includes('GET /turns?page=2'));
  assert.match(state.plans[0].turns[0].question, /第 2 轮/);
});

test('a side-note interjection keeps a running plan without waking the host, and records its prompt version', async t => {
  const { state, config } = await free_fixture(t);
  Object.assign(config, with_scheduler(config));
  state.session = { id: 7, status: 'active', goal: '目标', phase: 'discussion', named_followup: false };
  state.room.phase = 'discussion'; state.room.session = state.session; state.room.latest_id = 30;
  state.messages = [{ id: 30, author: '用户', text: '补充一下，预算是十万' }];
  state.pending = [{ id: 9, purpose: 'discuss_host', session_id: 7, cause_kind: 'user_message', source_message_id: 30 }];
  // Everyone has spoken this round, but Gemini's queued turn is still running, so a side note can leave it alone.
  state.turns = [{ id: 1, round: 1, expert: 'Gemini', status: 'answered', answer_id: 29, question: '请给出开场观点' },
    { id: 2, round: 2, expert: 'Gemini', status: 'queued', question: '请回应第 1 轮的分歧' }];
  state.roster = { revision: 'r1', round: 1, waiting: [], experts: [{ name: 'Gemini', host: false, spoken: true, registered: true }] };
  const sent = [];
  const decisions = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith('/scheduler-decisions')) decisions.push(JSON.parse(init.body));
    return original(input, init);
  };
  t.after(() => { globalThis.fetch = original; });
  const driver = new SessionDriver(config, () => {}, async (url, init) => { sent.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ answers: { handling: { type: 'choice', choice: '__note__', confidence: 0.9, probabilities: {} } } }) }; });
  await driver.tick(state.room, { archived: false, members: [{ name: 'Claude', role: 'host', pending: state.pending }], executions: [] });
  assert.ok(state.calls.includes('POST /turns/continue'), 'a confident side note closes the host request by continuing the plan');
  assert.match(sent[0].state, /主持人最近的安排：Gemini（第 1 轮，已发言）：请给出开场观点；Gemini（第 2 轮，排队中）：请回应第 1 轮的分歧/);
  assert.deepEqual([decisions[0].applied, decisions[0].context.prompt], [true, DISCUSSION_GUIDED_PROMPT_VERSION]);

  // With nothing open or queued, continuing would stall the discussion, so the note goes to the host.
  state.turns = [state.turns[0]];
  state.roster = { ...state.roster, waiting: ['Codex'] };
  state.pending = [{ id: 10, purpose: 'discuss_host', session_id: 7, cause_kind: 'user_message', source_message_id: 30 }];
  const calls = state.calls.length;
  assert.equal(await driver.tick(state.room, { archived: false, members: [{ name: 'Claude', role: 'host', pending: state.pending }], executions: [] }), false);
  assert.equal(state.calls.slice(calls).includes('POST /turns/continue'), false);
  assert.equal(decisions.at(-1).label, '仅补充信息，但当前没有进行中的安排，交给主持人');
});

for (const outcome of ['accepted', 'cancelled', 'expired']) test(`free Sidecar delivery checks executions and reconciles ${outcome} without resending`, async t => {
  const { state, store, config } = await free_fixture(t);
  config.participants.Claude = { adapter: 'antigravity', ipc_directory: config.directory };
  writeFileSync(join(config.directory, 'ready.json'), JSON.stringify({ pid: process.pid }));
  const runner = new FreeRoomRunner(config, store);
  await runner.tick();
  const request = JSON.parse(readFileSync(join(config.directory, 'free-1.request.json'), 'utf8'));
  assert.equal(request.mode, 'free'); assert.equal(request.event_id, 1);
  if (outcome === 'cancelled') state.executions[0].status = 'cancelled';
  if (outcome === 'expired') state.executions[0].lease_until = 1;
  let invoked = 0;
  const source = readFileSync(new URL('../runner/adapters/antigravity_sidecar.mjs', import.meta.url), 'utf8')
    .replace(/^import .+;\r?$/gm, '').split("\natomic_json(join(directory, 'ready.json')")[0];
  const context = vm.createContext({ process: { env: { CODISCUSS_IPC_DIRECTORY: config.directory, ANTIGRAVITY_AGENTAPI_EXE: 'test' } },
    resolve, join, existsSync, readFileSync, writeFileSync, fetch, AbortSignal,
    execFileSync: () => { invoked++; return JSON.stringify({ response: { newConversation: { conversationId: 'free-session' } } }); },
    atomic_json: (path, value) => writeFileSync(path, JSON.stringify(value)),
  });
  await vm.runInContext(`${source}\nprocess_request('free-1.request.json')`, context);
  await vm.runInContext("process_request('free-1.request.json')", context);
  assert.equal(invoked, outcome === 'accepted' ? 1 : 0);
  assert.ok(state.calls.includes('GET /executions/1'));
  assert.ok(!state.calls.some(call => call.includes('/runtime') || call.includes('/events')));
  if (outcome === 'accepted') state.executions[0].status = 'completed'; // Fast answers can beat reconciliation.
  await runner.tick(); await runner.tick();
  assert.equal(state.executions.length, 1);
  assert.equal(store.binding('Claude').session_id || '', outcome === 'accepted' ? 'free-session' : '');
});

test('a free room without smart scheduling has everyone named by @全体成员 answer at once and never delivers the group request', async t => {
  const { state, store, config } = await free_fixture(t);
  state.pending = [{ id: 1, message_id: 11, purpose: 'group' }];
  const delivered = [];
  const runner = new FreeRoomRunner(config, store, async (adapter, binding, task) => { delivered.push(task); return { status: 'accepted' }; });
  await runner.tick();
  await Promise.all(runner.decisions);
  await runner.tick();
  assert.deepEqual([state.calls.filter(call => call.startsWith('POST /recommendations/11')), delivered.length], [['POST /recommendations/11 all'], 1]);
  assert.equal(state.executions[0].requests[0].purpose, 'all');
  assert.equal(state.calls.some(call => call === 'POST /scheduler-routing'), false);
});

/** A group request with real local member facts; provider calls stay test doubles. */
async function group_fixture(t) {
  const fixture = await free_fixture(t);
  const { state, config } = fixture;
  Object.assign(config, with_scheduler(config));
  config.participants.Codex = { adapter: 'codex_cli', cwd: join(config.directory, 'private-project'), project_name: 'Ledger', project_access: 'read' };
  state.claude_role = 'host';
  state.pending = [{ id: 1, message_id: 11, purpose: 'group' }];
  state.others = [{ id: 8, name: 'Codex', role: 'member', access: 'runner', pending: [] }];
  state.messages = [{ id: 11, author: '用户', text: '@全体成员 处理这个问题' }];
  state.room.descriptions = { Codex: '只负责评审' };
  state.room.free = { requests: [{ member: 'Codex', message_id: 9, status: 'delivering' }] };
  return fixture;
}

test('group context, timeout and unusable-answer failures hand back once, clear analysing and survive a runner restart', async t => {
  for (const failure of ['context', 'missing_message', 'timeout', 'answer']) await t.test(failure, async t => {
    const { state, config, store } = await group_fixture(t);
    state.fail_messages = failure === 'context';
    if (failure === 'missing_message') state.messages = [];
    let asked = 0, delivered = 0;
    const model = async () => { asked++; if (failure === 'timeout') throw new Error('timeout'); return scheduler_fetch({})(); };
    const deliver = async () => { delivered++; return { status: 'accepted' }; };
    const runner = new FreeRoomRunner(config, store, deliver, () => {}, model);
    await runner.tick();
    await Promise.all(runner.decisions);
    assert.deepEqual(state.group_posts.map(item => item.action), ['host']);
    assert.equal(state.routing.at(-1).active, false);
    assert.equal(asked, ['context', 'missing_message'].includes(failure) ? 0 : 1);
    const restarted = new FreeRoomRunner(config, store, deliver, () => {}, async () => assert.fail('fallback must not re-enter unnamed routing'));
    await restarted.tick();
    await Promise.all(restarted.decisions);
    assert.equal(delivered, 1);
    assert.equal(state.executions[0].requests[0].id, 1);
    assert.equal(state.executions[0].requests[0].message_id, 11);
    const suggestion = JSON.parse(readFileSync(join(config.directory, `free-${state.executions[0].id}.task.json`), 'utf8')).scheduler_suggestions[0];
    assert.deepEqual([suggestion.request_id, suggestion.message_id, suggestion.actual_action, suggestion.applied], [1, 11, 'host', false]);
    assert.equal('confidence' in suggestion || 'probabilities' in suggestion, false);
    if (failure !== 'answer') {
      assert.equal(suggestion.model_judgment, false);
      assert.equal(suggestion.decision_id, undefined);
      assert.match(suggestion.reason, /没有模型判断/);
    }
  });
});

test('group decisions see member facts and do not report a stale decision as applied', async t => {
  const { state, config, store } = await group_fixture(t);
  state.change_apply = 1;
  let input;
  const runner = new FreeRoomRunner(config, store, async () => ({ status: 'accepted' }), () => {}, async (url, init) => {
    input = JSON.parse(init.body);
    return scheduler_fetch({ order: { type: 'choice', choice: 'parallel', confidence: 0.9 } })();
  });
  await runner.tick();
  await Promise.all(runner.decisions);
  assert.match(input.state, /Codex CLI，项目 Ledger 只读；正在处理 #9；用户描述：只负责评审/);
  assert.doesNotMatch(input.state, /runner-test-key|private-project/);
  assert.equal(input.state.includes(config.directory), false);
  assert.deepEqual(state.calls.filter(call => call.startsWith('POST /recommendations/11')), ['POST /recommendations/11 all', 'POST /recommendations/11 host']);
  assert.equal(state.decisions.at(-1).applied, false);
  assert.match(state.decisions.at(-1).label, /未生效/);
  const suggestion = runner.saved_suggestion(1);
  assert.deepEqual([suggestion.decision_id, suggestion.actual_action, suggestion.applied], [state.decisions.length, 'host', false]);
});

test('unnamed host handoffs survive restart without repeating a judgment and stay bound to their request', async t => {
  const { state, config, store } = await group_fixture(t);
  state.pending = [{ id: 1, message_id: 11, purpose: 'route' }];
  const model = scheduler_fetch({ handler: { type: 'choice', choice: '__host__', confidence: 0.8 } });
  const runner = new FreeRoomRunner(config, store, async () => ({ status: 'accepted' }), () => {}, model);
  await runner.tick(); await Promise.all(runner.decisions);
  const suggestion = runner.saved_suggestion(1);
  assert.equal(suggestion.decision_id, 1);
  assert.equal(suggestion.applied, false);
  const restarted = new FreeRoomRunner(config, store, async () => ({ status: 'accepted' }), () => {},
    async () => assert.fail('persisted handoff must not ask again'));
  await restarted.tick(); await Promise.all(restarted.decisions);
  const task = JSON.parse(readFileSync(join(config.directory, `free-${state.executions[0].id}.task.json`), 'utf8'));
  assert.deepEqual(task.scheduler_suggestions, [suggestion]);
  assert.equal(restarted.saved_suggestion(999), null);
});

test('group website failure persists the judgment and retries the same action after restart without another model call', async t => {
  const { state, config, store } = await group_fixture(t);
  state.fail_apply = 1;
  let asked = 0;
  const model = async () => { asked++; return scheduler_fetch({ order: { type: 'choice', choice: 'sequential', confidence: 0.9 } })(); };
  const runner = new FreeRoomRunner(config, store, async () => ({ status: 'accepted' }), () => {}, model);
  await runner.tick();
  await Promise.all(runner.decisions);
  assert.equal(state.pending[0].purpose, 'group');
  assert.equal(state.decisions[0].applied, false);
  assert.equal(state.routing.at(-1).active, false);
  const restarted = new FreeRoomRunner(config, store, async () => ({ status: 'accepted' }), () => {}, model);
  await restarted.tick();
  await Promise.all(restarted.decisions);
  assert.equal(asked, 1);
  assert.deepEqual(state.calls.filter(call => call.startsWith('POST /recommendations/11')), ['POST /recommendations/11 sequential', 'POST /recommendations/11 sequential']);
  assert.equal(state.decisions.at(-1).applied, true);
});

test('smart scheduling still reads an unnamed message that follows more than a page of messages', async t => {
  const { state, store, config } = await free_fixture(t);
  config.api_home = mkdtempSync(join(tmpdir(), 'scheduler-'));
  t.after(() => rmSync(config.api_home, { recursive: true, force: true }));
  config.scheduler = { provider: 'jev', model: 'jev-1.13', ...save_api_key(config.api_home, { base_url: SCHEDULER_PROVIDERS.jev.base_url, api_key: 'jev-key' }) };
  config.scheduler.base_url = SCHEDULER_PROVIDERS.jev.base_url;
  state.claude_role = 'host';
  state.others = [{ id: 8, name: 'Codex', role: 'member', pending: [] }];
  state.messages = Array.from({ length: 40 }, (_, index) => ({ id: index + 1, author: index === 39 ? '用户' : 'Claude', text: `第 ${index + 1} 条` }));
  state.pending = [{ id: 1, message_id: 40, purpose: 'route' }];
  const asked = [];
  const runner = new FreeRoomRunner(config, store, async () => ({ status: 'accepted' }), () => {}, async (url, init) => {
    asked.push(JSON.parse(init.body).state);
    return { ok: true, json: async () => ({ answers: { handler: { type: 'choice', choice: '__host__', confidence: 0.9, probabilities: { __host__: 0.9 } } } }) };
  });
  await runner.tick();
  await Promise.all(runner.decisions);
  assert.equal(asked.length, 1);
  assert.match(asked[0], /第 40 条/);
  assert.ok(state.calls.includes('POST /scheduler-decisions'));
});

test('a free room delivers all open requests as one execution with the member credential only', async t => {
  const { state, store, config } = await free_fixture(t);
  state.session = { id: 7, status: 'active', goal: '审查方案' };
  state.room.phase = 'initial';
  const delivered = [];
  const runner = new FreeRoomRunner(config, store, async (adapter, binding, task) => { delivered.push(task); return { session_id: 'claude-session', status: 'accepted' }; });
  await runner.tick();
  await runner.tick();
  assert.equal(delivered.length, 1);
  assert.equal(state.executions.length, 1);
  const task = JSON.parse(readFileSync(join(config.directory, 'free-1.task.json'), 'utf8'));
  assert.equal(task.mode, 'free');
  assert.equal(task.session.status, 'active');
  assert.deepEqual(task.request_purposes, ['ask', 'ask']);
  assert.equal(task.discussion_request, undefined);
  assert.deepEqual(task.request_messages, [11, 12]);
  assert.equal(task.read_after, 10);
  assert.equal(task.execution_id, 1);
  assert.match(delivered[0].prompt, /free-1\.task\.json/);
  // Free rooms get the same Windows read rule as discussions; it sits in the prompt, since reading the task file may garble it.
  const has_rg = process.platform === 'win32' && spawnSync('rg', ['--version'], { stdio: 'ignore' }).status === 0;
  assert.equal(/rg --encoding utf-8/.test(delivered[0].prompt), has_rg);
  const access = JSON.parse(readFileSync(delivered[0].access_path, 'utf8'));
  assert.equal(access.token, config.members.Claude.token);
  assert.doesNotMatch(readFileSync(delivered[0].access_path, 'utf8') + readFileSync(join(config.directory, 'free-1.task.json'), 'utf8'), /owner-credential/);
  assert.equal(store.binding('Claude').session_id, 'claude-session');
});

test('a changed activity is reported with an early renewal, at most once per report interval', async t => {
  const { state, store, config } = await free_fixture(t);
  let task;
  const runner = new FreeRoomRunner(config, store, async (adapter, binding, delivered) => { task = delivered; return { status: 'accepted' }; });
  await runner.tick();
  task.on_activity('command');
  await runner.tick();
  assert.equal(state.renewed, undefined, 'a phase seen right after delivery waits for the report interval');
  runner.save('Claude', { last_renew: Date.now() - 11_000 });
  await runner.tick();
  assert.equal(state.renewed.activity, 'command');
  assert.ok(Math.abs(state.renewed.activity_at - Date.now() / 1000) < 5);
  state.renewed = undefined;
  runner.save('Claude', { last_renew: Date.now() - 11_000 });
  await runner.tick();
  assert.equal(state.renewed, undefined, 'unchanged activity waits for the regular renewal');
});

test('a free execution sends its progress notes with its segments, not with a renewal', async t => {
  const { state, store, config } = await free_fixture(t);
  let task;
  const runner = new FreeRoomRunner(config, store, async (adapter, binding, delivered) => { task = delivered; return { status: 'accepted' }; });
  await runner.tick();
  task.on_note('读完材料，改用方案 B');
  runner.save('Claude', { last_renew: Date.now() - 31_000 });
  await runner.tick();
  assert.deepEqual(state.notes[0], [{ seq: 1, text: '读完材料，改用方案 B' }]);
  assert.equal(state.renewed.notes, undefined);
});

test('phase segments merge repeats, resend the open one only once it ran further, and stop at the cap', async () => {
  let now = 1000;
  const log = new SegmentLog(() => now);
  log.mark(1, 'thinking');
  assert.deepEqual(log.batch(1).segments, [], 'an execution that was not started records nothing');
  log.start(1);
  now = 1100; log.mark(1, 'thinking');
  now = 1300; log.mark(1, 'thinking');
  now = 1500; log.mark(1, 'command', 'Bash');
  now = 1700; log.mark(1);
  assert.deepEqual(log.batch(1).segments, [{ seq: 1, phase: 'thinking', tool: '', start_ms: 100, end_ms: 500 },
    { seq: 2, phase: 'command', tool: 'Bash', start_ms: 500, end_ms: 700 }]);
  const sent = [];
  await log.report(1, false, async batch => { sent.push(batch.segments); });
  assert.equal(log.due(1, 0), false, 'an open segment that has not run further is not resent');
  now = 2000; log.mark(1);
  assert.equal(log.due(1, 0), true);
  await log.report(1, false, async batch => { sent.push(batch.segments); });
  assert.deepEqual(sent[1], [{ seq: 2, phase: 'command', tool: 'Bash', start_ms: 500, end_ms: 1000 }], 'only the open segment is sent again, further on');
  now = 2100; log.mark(1, 'writing');
  await log.report(1, false, async () => { throw new Error('fetch failed'); });
  assert.deepEqual(log.batch(1).segments.map(item => item.seq), [2, 3], 'a network failure keeps the segments');
  await log.report(1, true, async batch => { sent.push(batch.segments); });
  assert.deepEqual(sent.at(-1).map(item => [item.seq, item.end_ms]), [[2, 1100], [3, 1100]]);
  assert.deepEqual(log.batch(1).segments, [], 'a final report forgets the execution');
  log.start(2);
  for (let index = 0; index < MAX_EXECUTION_SEGMENTS + 5; index++) { now += 10; log.mark(2, index % 2 ? 'tool' : 'thinking', 'x'.repeat(80)); }
  const all = [];
  await log.report(2, true, async batch => { assert.ok(batch.segments.length <= MAX_SEGMENTS_PER_REPORT); all.push(...batch.segments); });
  assert.equal(all.length, MAX_EXECUTION_SEGMENTS);
  assert.equal(all[1].tool.length, 60);
  log.start(3); log.mark(3, 'tool', 'Read');
  await log.report(3, false, async () => { throw new Error('HTTP 409: 执行已结束较久，不再接收阶段记录'); });
  assert.deepEqual(log.batch(3).segments, [], 'a refused report drops the segments');
});

test('progress notes ride with the segments: numbered once, cut, capped and not resent', async () => {
  const log = new SegmentLog(() => 0);
  log.start(1);
  log.note(1, '读完材料，改用方案 B');
  log.note(1, 'x'.repeat(600));
  const sent = [];
  await log.report(1, false, async batch => { sent.push(batch); });
  assert.deepEqual(sent[0].segments, [], 'notes alone make a report');
  assert.deepEqual(sent[0].notes.map(note => [note.seq, note.text.length]), [[1, 11], [2, 500]]);
  log.note(1, '验证通过');
  await log.report(1, false, async batch => { sent.push(batch); });
  assert.deepEqual(sent[1].notes, [{ seq: 3, text: '验证通过' }]);
  for (let index = 0; index < MAX_EXECUTION_NOTES; index++) log.note(1, `第 ${index} 段`);
  const rest = [];
  await log.report(1, true, async batch => { assert.ok(batch.notes.length <= MAX_NOTES_PER_REPORT); rest.push(...batch.notes); });
  assert.equal(rest.at(-1).seq, MAX_EXECUTION_NOTES, 'notes past the cap are dropped');
});

test('the tool an event starts is named without its arguments', () => {
  assert.equal(activity_tool('claude', { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'rm -rf x' } }] } }), 'Bash');
  assert.equal(activity_tool('claude', { type: 'assistant', message: { content: [{ type: 'text', text: '好' }] } }), '');
  assert.equal(activity_tool('codex_cli', { type: 'item.started', item: { type: 'mcp_tool_call', server: 'docs', tool: 'search' } }), 'search');
  assert.equal(activity_tool('codex_cli', { type: 'item.started', item: { type: 'command_execution', command: 'ls' } }), '');
  assert.equal(activity_tool('antigravity_cli', { step_update: { step_type: 'tool', state: 'ACTIVE', tool_name: 'view_file' } }), 'view_file');
  assert.equal(activity_tool('antigravity_cli', { step_update: { step_type: 'tool', state: 'DONE', tool_name: 'view_file' } }), '');
});

test('a free execution reports its phase segments while it runs and the rest once it ends', async t => {
  const { state, store, config } = await free_fixture(t);
  let task;
  const runner = new FreeRoomRunner(config, store, async (adapter, binding, delivered) => { task = delivered; return { status: 'accepted' }; });
  await runner.tick();
  task.on_activity('thinking', '');
  task.on_activity('command', 'Bash');
  await runner.tick();
  assert.deepEqual(state.segments[0].map(item => [item.seq, item.phase, item.tool]), [[1, 'thinking', ''], [2, 'command', 'Bash']]);
  task.on_activity('writing', '');
  await runner.tick();
  assert.equal(state.segments.length, 1, 'later segments wait for the report interval');
  state.executions[0].status = 'completed';
  await runner.tick();
  assert.deepEqual([state.segments.at(-1).at(-1).seq, state.segments.at(-1).at(-1).phase], [3, 'writing'], 'the open segment closes with the final report');
  assert.match(state.calls.filter(call => call.endsWith('segments')).at(-1), /^POST \/executions\/1 segments$/);
});

test('agent text between tool calls becomes a note; agy deltas join when their step ends', () => {
  assert.equal(progress_note('claude', { type: 'assistant', message: { content: [{ type: 'text', text: ' 先读文件 ' }] } }), '先读文件');
  assert.equal(progress_note('claude', { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } }), '');
  assert.equal(progress_note('codex_cli', { type: 'item.completed', item: { type: 'agent_message', text: '核对完成' } }), '核对完成');
  assert.equal(progress_note('codex_cli', { type: 'item.completed', item: { type: 'reasoning', text: '内部推理' } }), '');
  const responses = new Map();
  const step = (state, text_delta) => ({ event: 'step_update', step_update: { step_type: 'agent_response', step_index: 4, state, text_delta } });
  assert.equal(progress_note('antigravity_cli', step('ACTIVE', '正在'), responses), '');
  assert.equal(progress_note('antigravity_cli', step('ACTIVE', '验证'), responses), '');
  assert.equal(progress_note('antigravity_cli', step('DONE'), responses), '正在验证');
  assert.equal(progress_note('antigravity_cli', step('DONE'), responses), '', 'an empty response step is no note');
});

test('streamed CLI events map to the phase the card shows', () => {
  const cases = [
    ['claude', { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'PowerShell' }] } }, 'command'],
    ['claude', { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit' }] } }, 'editing'],
    ['claude', { type: 'assistant', message: { content: [{ type: 'text', text: '好' }] } }, 'writing'],
    ['claude', { type: 'user' }, 'thinking'],
    ['claude', { type: 'result' }, ''],
    ['codex_cli', { type: 'item.started', item: { type: 'command_execution' } }, 'command'],
    ['codex_cli', { type: 'item.completed', item: { type: 'command_execution' } }, 'thinking'],
    ['codex_cli', { type: 'item.completed', item: { type: 'agent_message' } }, 'writing'],
    ['antigravity_cli', { event: 'step_update', step_update: { step_type: 'tool', state: 'RUNNING', tool_name: 'run_command' } }, 'command'],
    ['antigravity_cli', { event: 'step_update', step_update: { step_type: 'tool', state: 'DONE', tool_name: 'run_command' } }, 'thinking'],
  ];
  for (const [adapter, event, phase] of cases) assert.equal(activity_phase(adapter, event), phase, JSON.stringify(event));
});

test('a free member that exits without answering fails only its own execution', async t => {
  const { state, store, config } = await free_fixture(t);
  const runner = new FreeRoomRunner(config, store, async (adapter, binding, task) => { setImmediate(() => task.on_exit()); return { status: 'accepted' }; });
  await runner.tick();
  await runner.tick();
  assert.equal(state.executions[0].status, 'failed');
  assert.ok(state.calls.includes('POST /executions/1 fail'));
  assert.match(state.executions[0].result, /会话已结束，但未提交本次回答.*请核对原会话/);
});

test("the owner's member descriptions reach the scheduler's state and each member's option", async t => {
  const message = { id: 3, author: '用户', text: '把首页改好看点' };
  const state = scheduler_state('房间', [], message, '', '', { profiles: { Claude: '审美好，UI 写得好', Codex: '' } });
  assert.match(state, /用户对成员的描述[^\n]*\n- Claude：审美好，UI 写得好/);
  assert.doesNotMatch(state, /- Codex：/, 'an empty description adds no line');
  assert.doesNotMatch(scheduler_state('房间', [], message, '', '', { profiles: null }), /用户对成员的描述/);
  const { store, config } = await free_fixture(t);
  const runner = new FreeRoomRunner(config, store, async () => ({ status: 'accepted' }));
  const [described, manual] = runner.route_members([{ id: 7, name: 'Claude', role: 'member' }, { id: 8, name: 'Gemini', role: 'member', access: 'manual' }],
    { descriptions: { Claude: '审美好', Gemini: '文档整理得好' }, free: { requests: [] } }, 3);
  assert.match(described.description, /^Claude（Claude Code.*；用户描述：审美好）$/);
  assert.match(manual.description, /手动接入.*；用户描述：文档整理得好）$/);
});

test("an expert prompt is only the member's own text, and the API file rule is fixed in its system prompt", () => {
  assert.deepEqual(EXPERT_PROMPT_PRESETS, {}, 'must-know software rules are fixed by the runner, not replaceable presets');
  assert.equal(expert_prompt({ adapter: 'api' }), '');
  assert.equal(expert_prompt({ adapter: 'api', system_prompt: '  只读不写  ' }), '只读不写');
  // An API expert's own prompt cannot drop the rule about local files.
  const api = system_prompt({ participant: 'DeepSeek', role: 'member', mode: 'free', expert_prompt: '只读不写' });
  assert.match(api, /本地文件和消息附件.*内容你都读不到：以其他成员贴出的为准，不凭文件名猜测.*缺信息就写明缺什么/);
});

test('the agy command limit comes from the runner, so clearing the expert prompt cannot drop it', () => {
  assert.match(software_rules({ adapter: 'antigravity_cli' }, 'codiscuss'), /run_command 只能运行 codiscuss/);
  assert.equal(software_rules({ adapter: 'claude' }, 'codiscuss'), '');
  assert.doesNotMatch(software_rules({ adapter: 'antigravity_cli', cwd: 'D:/project', project_access: 'write' }, 'codiscuss'), /run_command/, 'a writable agy runs any command');
  // agy shows no thinking, so writing progress is a fixed rule for it in every task, beside the skill's general note.
  const agy = { cli: 'codiscuss', messages: '#3', task_path: 'free-7.task.json', name: 'Gemini', profile: { adapter: 'antigravity_cli', project_access: 'write', cwd: 'D:/project' } };
  assert.match(free_task_text(agy).instructions, /关键转折处用一句话写出进展再继续/);
  assert.doesNotMatch(free_task_text({ ...agy, profile: { adapter: 'claude', project_access: 'read' } }).instructions, /写出进展/);
});

test('the fixed free-room text loads in steps and leaves values to the task fields and rules to the skills', () => {
  const base = { name: 'Codex', profile: { adapter: 'codex_cli', project_access: 'read' }, cli: 'codiscuss', room: 'r1', messages: '#3',
    read_after: 2, execution_id: 7, task_path: 'free-7.task.json' };
  const text = free_task_text({ ...base, role: 'host' });
  // The wake-up names who was asked; a simple message is answered at once, anything else starts from the task file.
  assert.match(text.prompt, /点名了你（Codex），对应消息 #3。问候、致谢等简单消息可跳过技能：codiscuss message list r1 --after 2 看原文/);
  // A one-line answer is passed inline, so the quick path needs no draft file.
  assert.match(text.prompt, /codiscuss message post r1 --as Codex --kind chat --execution 7 --body "回答" --submission-id 新UUID 回复。其他请求先读任务文件 free-7\.task\.json，按其中列出的技能处理/);
  assert.doesNotMatch(text.prompt + text.instructions, /--handoff|不建定时任务|提交被拒绝|DISCUSS_ACCESS_FILE|--access-file/);
  // A credential not bound to the process is named on both quick commands.
  assert.equal(free_task_text({ ...base, access_file: 'a.json' }).prompt.match(/--access-file a\.json/g).length, 2);
  // What is left are the limits no skill can know: project access, the command scope and where drafts go.
  assert.equal(text.instructions, '未指定项目目录。命令只用 subcommands 列出的 codiscuss 子命令。草稿写在 draft_directory。');
  const writable = free_task_text({ ...base, profile: { adapter: 'codex_cli', project_access: 'write', cwd: 'D:/project' } });
  assert.doesNotMatch(writable.instructions, /subcommands/);
  assert.match(free_task_text({ ...base, discussion: true }).instructions, /不改变讨论安排和进度/);
});

test("the delivered task and the API system prompt carry only this member's own prompt", async t => {
  const { store, config } = await free_fixture(t);
  config.participants.Claude = { adapter: 'claude', system_prompt: '回答控制在三段内' };
  let task;
  const runner = new FreeRoomRunner(config, store, async (adapter, binding, delivered) => { task = delivered; return { status: 'accepted' }; });
  await runner.tick();
  assert.match(task.prompt, /用户为你单独设置的提示[^\n]*\n回答控制在三段内$/);
  const context = { participant: 'DeepSeek', role: 'member', mode: 'free' };
  assert.doesNotMatch(system_prompt(context), /单独设置的提示/);
  assert.match(system_prompt({ ...context, expert_prompt: '先给结论' }), /单独设置的提示[^\n]*\n先给结论$/);
});

test('a free member whose command was refused names that command in its failure', async t => {
  const { state, store, config } = await free_fixture(t);
  const denial = '运行了未授权的命令「Get-ChildItem -Recurse」，无人值守模式下无法确认权限而被自动拒绝，随后会话结束';
  const runner = new FreeRoomRunner(config, store, async (adapter, binding, task) => { setImmediate(() => task.on_exit(denial)); return { status: 'accepted' }; });
  await runner.tick();
  await runner.tick();
  assert.equal(state.executions[0].result, `Claude ${denial}，未提交本次回答`);
});

test('an interrupted free execution stops only that member and is not redelivered', async t => {
  const { state, store, config } = await free_fixture(t);
  const child = Object.assign(new EventEmitter(), { killed: false, kill() { this.killed = true; this.emit('close'); } });
  const runner = new FreeRoomRunner(config, store, async (adapter, binding, task) => { task.on_process(child); return { status: 'accepted', session_id: 'session-1' }; });
  await runner.tick();
  assert.deepEqual(state.executions[0].capabilities, { stoppable: true, progress: true });
  state.executions[0].status = 'cancelled';
  await runner.tick();
  assert.equal(child.killed, true);
  assert.equal(state.executions[0].stop_result, 'stopped', 'the site learns the process really ended');
  assert.equal(state.executions.length, 1);
  // The member's next task names the stopped execution once, so its session does not carry on with that work.
  const task = id => JSON.parse(readFileSync(join(config.directory, `free-${id}.task.json`), 'utf8'));
  state.pending = [{ id: 3, message_id: 13 }];
  await runner.tick();
  assert.deepEqual(task(2).stopped_executions, [1]);
  state.executions[1].status = 'completed';
  await runner.tick();
  state.pending = [{ id: 4, message_id: 14 }];
  await runner.tick();
  assert.equal(task(3).stopped_executions, undefined);
});

test('a voided execution the runner cannot stop, in a window or App, is reported as such after a restart too', async t => {
  const { state, store, config } = await free_fixture(t);
  await new FreeRoomRunner(config, store, async () => ({ status: 'accepted', capabilities: { stoppable: false, progress: false } })).tick();
  assert.equal(state.executions[0].capabilities.stoppable, false);
  state.executions[0].status = 'cancelled';
  // A new runner instance stands for a restarted service: the delivery is read from the local store.
  const runner = new FreeRoomRunner(config, store, async () => ({ status: 'accepted' }));
  await runner.tick();
  assert.equal(state.executions[0].stop_result, 'unstoppable');
  // While the site holds the member, its next message is not delivered into the turn that may still run.
  state.pending = [{ id: 3, message_id: 13 }];
  state.held_until = Math.floor(Date.now() / 1000) + 600;
  await runner.tick();
  assert.equal(state.executions.length, 1);
  state.held_until = 0;
  await runner.tick();
  assert.equal(state.executions.length, 2);
});

for (const sent of [false, true]) test(`a kill signal returning ${sent} stays unconfirmed until every process closes`, async t => {
  const { state, store, config } = await free_fixture(t);
  const child = Object.assign(new EventEmitter(), { kill() { return sent; } });
  const runner = new FreeRoomRunner(config, store, async (adapter, binding, task) => {
    task.on_process(child); return { status: 'accepted', capabilities: { stoppable: true, progress: true } };
  });
  await runner.tick();
  state.executions[0].status = 'cancelled';
  await runner.tick();
  assert.equal(state.executions[0].stop_result, 'unconfirmed');
  assert.ok(store.db.prepare("SELECT value FROM metadata WHERE key='delivery:1'").get());
  child.emit('close');
  await runner.tick();
  assert.equal(state.executions[0].stop_result, 'stopped');
  assert.equal(store.db.prepare("SELECT value FROM metadata WHERE key='delivery:1'").get(), undefined);
  assert.deepEqual(runner.stopped_executions('Claude'), [1]);
});

test('a restarted runner cannot claim a stoppable process exited without its handle', async t => {
  const { state, store, config } = await free_fixture(t);
  await new FreeRoomRunner(config, store, async () => ({ status: 'accepted' })).tick();
  state.executions[0].status = 'cancelled';
  await new FreeRoomRunner(config, store).tick();
  assert.equal(state.executions[0].stop_result, 'unconfirmed');
});

test('an unconfirmed process does not extend the site hold beyond its original deadline', async t => {
  const { state, store, config } = await free_fixture(t);
  const child = Object.assign(new EventEmitter(), { kill() { return false; } });
  const runner = new FreeRoomRunner(config, store, async (adapter, binding, task) => {
    task.on_process(child); return { status: 'accepted', session_id: 'session-1' };
  });
  await runner.tick();
  state.executions[0].status = 'cancelled';
  await runner.tick();
  state.pending = [{ id: 3, message_id: 13 }];
  state.held_until = Math.floor(Date.now() / 1000) + 600;
  await runner.tick();
  assert.equal(state.executions.length, 1);
  state.held_until = 0;
  await runner.tick();
  assert.equal(state.executions.length, 2);
  assert.deepEqual(JSON.parse(readFileSync(join(config.directory, 'free-2.task.json'), 'utf8')).stopped_executions, [1]);
});

for (const failure of ['before', 'after']) test(`stop reporting survives a ${failure}-write network failure and restart`, async t => {
  const { state, store, config } = await free_fixture(t);
  const runner = new FreeRoomRunner(config, store, async () => ({ status: 'accepted', capabilities: { stoppable: false, progress: false } }));
  await runner.tick();
  state.executions[0].status = 'cancelled';
  // Cover the old on-disk format at the same boundary; parsing must not discard it.
  store.db.prepare("UPDATE metadata SET value='window' WHERE key='delivery:1'").run();
  state.stop_failure = failure;
  await runner.tick();
  assert.ok(store.db.prepare("SELECT value FROM metadata WHERE key='delivery:1'").get());
  assert.deepEqual(runner.stopped_executions('Claude'), []);
  state.stop_failure = '';
  const restarted = new FreeRoomRunner(config, store, async () => ({ status: 'accepted' }));
  await restarted.tick();
  assert.equal(state.executions[0].stop_result, 'unstoppable');
  assert.equal(store.db.prepare("SELECT value FROM metadata WHERE key='delivery:1'").get(), undefined);
  assert.deepEqual(restarted.stopped_executions('Claude'), [1]);
  await restarted.tick();
  assert.deepEqual(restarted.stopped_executions('Claude'), [1]);
});

test("a member's rewind effect is reported from its adapter once, and not to a site that lists none", async t => {
  const { state, store, config } = await free_fixture(t);
  state.pending = [];
  const runner = new FreeRoomRunner(config, store, async () => ({ status: 'accepted' }));
  await runner.tick();
  assert.equal(state.calls.filter(call => call.includes('/capabilities')).length, 0, 'an older site takes no report');
  state.rewind = '';
  await runner.tick();
  assert.equal(state.rewind, 'cut', 'Claude Code sessions are cut by the runner');
  await runner.tick();
  assert.equal(state.calls.filter(call => call.includes('/capabilities')).length, 1, 'an unchanged effect is not sent again');
});

test('proven non-delivery is released and retried, then fails after three attempts', async t => {
  const { state, store, config } = await free_fixture(t);
  const runner = new FreeRoomRunner(config, store, async () => { throw Object.assign(new Error('未启动'), { delivery_status: 'not_sent' }); });
  for (let index = 0; index < 3; index++) await runner.tick();
  assert.deepEqual(state.executions.map(item => item.status), ['cancelled', 'cancelled', 'failed']);
});

test('a manual member whose session refuses a delivery is retried in the same execution after a wait, and fails when stopped', async t => {
  const { state, store, config } = await free_fixture(t);
  config.participants.Claude.project_access = 'own';
  let sent = 0;
  const runner = new FreeRoomRunner(config, store, async () => { sent++; throw Object.assign(new Error('原窗口拒绝'), { delivery_status: 'not_sent' }); });
  await runner.tick();
  const [execution] = state.executions;
  assert.equal(execution.status, 'dispatched', 'the execution stays live while it waits');
  assert.deepEqual([execution.retry.attempt, execution.retry.reason], [1, '投递失败：原窗口拒绝']);
  assert.ok(execution.retry.retry_at >= Math.floor(Date.now() / 1000) + 59);
  await runner.tick();
  assert.equal(sent, 1, 'nothing is sent before retry_at');
  execution.retry.retry_at = Math.floor(Date.now() / 1000) - 1;
  await runner.tick();
  assert.deepEqual([sent, execution.retry.attempt, state.executions.length], [2, 2, 1]);
  execution.retry.stopped = 1;
  await runner.tick();
  assert.equal(execution.status, 'failed');
  assert.match(execution.result, /原窗口拒绝（已停止自动重试）/);
});

test('a manual member is retried at most three times before the execution fails', async t => {
  const { state, store, config } = await free_fixture(t);
  config.participants.Claude.project_access = 'own';
  const runner = new FreeRoomRunner(config, store, async () => { throw Object.assign(new Error('原窗口拒绝'), { delivery_status: 'not_sent' }); });
  await runner.tick();
  const [execution] = state.executions;
  for (let index = 0; index < 3; index++) { execution.retry.retry_at = 1; await runner.tick(); }
  assert.equal(execution.status, 'failed');
  assert.match(execution.result, /已自动重试 3 次/);
});

test('discussion delivery retries a confirmed refusal after 60 seconds up to three times, then returns the failed request to its host', async t => {
  const { state, store, config } = await free_fixture(t);
  config.participants.Claude.project_access = 'own';
  state.claude_role = 'host';
  state.session = { id: 7, status: 'active', goal: '讨论目标', phase: 'discussion' };
  state.room.phase = 'discussion';
  state.pending = [{ id: 1, message_id: 11, purpose: 'discuss', session_request_id: 5, session_id: 7, round: 1, position: 1 }];
  const runner = new FreeRoomRunner(config, store, async () => {
    throw Object.assign(new Error('原窗口拒绝'), { delivery_status: 'not_sent' });
  });
  await runner.tick();
  const [execution] = state.executions;
  assert.equal(execution.retry.attempt, 1);
  assert.ok(execution.retry.retry_at >= Math.floor(Date.now() / 1000) + 59);
  for (let retry = 0; retry < 3; retry++) {
    execution.retry.retry_at = 1;
    await runner.tick();
  }
  assert.equal(execution.status, 'failed');
  assert.match(execution.result, /已自动重试 3 次/);
  assert.deepEqual(state.pending.map(item => [item.purpose, item.session_id, item.cause_kind]), [['discuss_host', 7, 'request_failed']]);
});

test('after a reached discussion limit the unified runner delivers ordinary free requests without scheduling another round', async t => {
  const { state, store, config } = await free_fixture(t);
  Object.assign(config, with_scheduler(config));
  state.claude_role = 'host';
  state.session = { id: 7, status: 'concluded', goal: '讨论目标', phase: 'concluded' };
  state.room.phase = 'concluded';
  state.pending = [{ id: 2, message_id: 12, purpose: 'ask' }];
  let task_file;
  await new FreeRoomRunner(config, store, async (adapter, binding, task) => {
    task_file = JSON.parse(readFileSync(join(config.directory, 'free-1.task.json'), 'utf8'));
    return { status: 'accepted' };
  }).tick();
  assert.equal(task_file.mode, 'free');
  assert.equal(task_file.requests[0].purpose, 'ask');
  assert.equal(task_file.discussion_request, undefined);
  assert.equal(state.calls.some(call => call.includes('/turns/roster')), false);
  assert.equal(state.calls.some(call => call.startsWith('POST /scheduler-routing')), false);
});

test('a restart between persisting and invoking never resends the free task', async t => {
  const { state, store, config } = await free_fixture(t);
  let calls = 0;
  const first = new FreeRoomRunner(config, store, async () => { calls++; return { status: 'accepted' }; });
  await first.tick();
  first.save('Claude', { status: 'delivering' });
  await new FreeRoomRunner(config, store, async () => { calls++; return { status: 'accepted' }; }).tick();
  assert.equal(calls, 1);
  assert.equal(state.executions[0].status, 'failed');
});

test('free room configurations require a member credential for every participant', t => {
  const directory = mkdtempSync(join(tmpdir(), 'free-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const config = { site: 'http://127.0.0.1:8765', room: 'room', token: 'owner-credential'.repeat(3), mode: 'free',
    participants: { Claude: { adapter: 'claude', executable: process.execPath } } };
  assert.throws(() => validate_config(config, directory), /成员凭证/);
  assert.equal(validate_config({ ...config, members: { Claude: { token: 'member-credential'.repeat(3) } } }, directory).mode, 'free');
});

test('a stopped free process reporting late cannot fail the next execution', async t => {
  const { state, store, config } = await free_fixture(t);
  const tasks = [];
  const runner = new FreeRoomRunner(config, store, async (adapter, binding, task) => { tasks.push(task); return { status: 'accepted' }; });
  await runner.tick();
  state.executions[0].status = 'cancelled';
  await runner.tick();
  state.pending = [{ id: 3, message_id: 13 }];
  await runner.tick();
  assert.equal(tasks.length, 2);
  tasks[0].on_failure('Claude 退出码 null');
  tasks[0].on_exit();
  await runner.tick();
  assert.equal(state.executions[1].status, 'dispatched');
  assert.ok(!state.calls.includes('POST /executions/2 fail'));
});

test('two free members are delivered in parallel, each with its own credential', async t => {
  const { state, store, config } = await free_fixture(t);
  config.participants.Codex = { adapter: 'codex_cli' };
  config.members.Codex = { token: 'codex-credential'.repeat(3) };
  state.others.push({ id: 8, name: 'Codex', pending: [{ id: 3, message_id: 11 }] });
  const tasks = [];
  const runner = new FreeRoomRunner(config, store, async (adapter, binding, task) => { tasks.push(task); return { status: 'accepted' }; });
  await runner.tick();
  assert.deepEqual(tasks.map(task => task.participant), ['Claude', 'Codex']);
  assert.deepEqual(state.executions.map(item => [item.member, item.status]), [['Claude', 'dispatched'], ['Codex', 'dispatched']]);
  assert.equal(JSON.parse(readFileSync(tasks[1].access_path, 'utf8')).token, config.members.Codex.token);
});

test('free members answering at once start in the room speaking order, not by joining order', async t => {
  const { state, store, config } = await free_fixture(t);
  config.participants.Codex = { adapter: 'codex_cli' };
  config.members.Codex = { token: 'codex-credential'.repeat(3) };
  state.others.push({ id: 8, name: 'Codex', pending: [{ id: 3, message_id: 11 }] });
  state.room = { speaking_order: { items: [{ name: 'Codex' }, { name: 'Claude' }] } };
  const runner = new FreeRoomRunner(config, store, async () => ({ status: 'accepted' }));
  await runner.tick();
  assert.deepEqual(state.executions.map(item => item.member), ['Codex', 'Claude']);
});

test('a free member that left is stopped while the other keeps working', async t => {
  const { state, store, config } = await free_fixture(t);
  config.participants.Codex = { adapter: 'codex_cli' };
  config.members.Codex = { token: 'codex-credential'.repeat(3) };
  state.others.push({ id: 8, name: 'Codex', pending: [{ id: 3, message_id: 11 }] });
  const children = {};
  const runner = new FreeRoomRunner(config, store, async (adapter, binding, task) => {
    children[task.participant] = Object.assign(new EventEmitter(), { killed: false, kill() { this.killed = true; this.emit('close'); } });
    task.on_process(children[task.participant]);
    return { status: 'accepted' };
  });
  await runner.tick();
  state.others = [];
  state.executions[1].status = 'cancelled';
  await runner.tick();
  assert.equal(children.Codex.killed, true);
  assert.equal(children.Claude.killed, false);
  assert.equal(runner.row('Codex').status, 'idle');
});

test('a member whose bound context changes is blocked while new members are adopted', async t => {
  const { state, store, config } = await free_fixture(t);
  config.participants.Claude.cwd = config.directory;
  const runner = new FreeRoomRunner(config, store, async () => ({ status: 'accepted' }));
  runner.adopt({ ...config, scheduler: { provider: 'jev', model: 'updated' },
    participants: { Claude: { adapter: 'claude', cwd: tmpdir() }, Codex: { adapter: 'codex_cli' } },
    members: { ...config.members, Codex: { token: 'codex-credential'.repeat(3) } } });
  assert.equal(runner.session_driver.config, runner.config);
  assert.equal(runner.session_driver.config.scheduler.model, 'updated');
  assert.ok(runner.config.participants.Codex);
  await runner.tick();
  assert.equal(state.executions[0].status, 'failed');
  assert.match(runner.row('Claude').error, /发生变化/);
});

test('changed files in a Git working tree are reported after the member exits', async t => {
  const { state, store, config } = await free_fixture(t);
  const project = mkdtempSync(join(tmpdir(), 'free-git-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const git = (...args) => spawnSync('git', ['-C', project, ...args], { encoding: 'utf8' });
  if (git('init').status !== 0) return t.skip('git unavailable');
  writeFileSync(join(project, 'index.html'), 'old');
  writeFileSync(join(project, 'keep.txt'), 'same');
  git('add', '.'); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init');
  config.participants.Claude.cwd = project;
  const child = Object.assign(new EventEmitter(), { kill() { this.emit('close'); } });
  const runner = new FreeRoomRunner(config, store, async (adapter, binding, task) => { task.on_process(child); return { status: 'accepted' }; });
  await runner.tick();
  assert.equal(state.executions[0].cwd, cwd_key(project));
  writeFileSync(join(project, 'index.html'), 'new');
  writeFileSync(join(project, 'added.css'), 'x');
  state.executions[0].status = 'completed';
  await runner.tick();
  assert.equal(state.reports[1], undefined, 'reporting waits for the process to exit');
  child.emit('close');
  await runner.tick();
  assert.deepEqual(state.reports[1], ['added.css', 'index.html']);
  state.executions.push({ ...state.executions[0], id: 2 });
  runner.snapshots.set(2, { member: 'Claude', directory: project, before: workspace_snapshot(project) });
  await runner.report_finished(new Set());
  assert.deepEqual(state.reports[2], [], 'a real unchanged Git snapshot is reported explicitly');
  runner.snapshots.set(3, { member: 'Claude', directory: join(config.directory, 'missing-directory'), before: new Map() });
  await runner.report_finished(new Set());
  assert.equal(state.reports[3], undefined, 'non-Git or unavailable detection is not an empty report');
  config.participants.Claude.project_access = 'read';
  state.pending = [{ id: 3, message_id: 13 }];
  await runner.tick();
  const read_only = state.executions.at(-1);
  writeFileSync(join(project, 'index.html'), 'written by someone else');
  read_only.status = 'completed';
  child.emit('close');
  await runner.tick();
  assert.equal(state.reports[read_only.id], undefined, 'a read-only member cannot have written the changes it would observe');
});

test('only the host task points to the host skill; other members get no dispatch rule', async t => {
  const { state, store, config } = await free_fixture(t);
  state.claude_role = 'host';
  const tasks = [];
  const runner = new FreeRoomRunner(config, store, async (adapter, binding, task) => { tasks.push(task); return { status: 'accepted' }; });
  await runner.tick();
  const task = JSON.parse(readFileSync(join(config.directory, 'free-1.task.json'), 'utf8'));
  assert.equal(task.role, 'host');
  // How to route and hand back lives in discuss-host, which only the host's task lists.
  assert.ok(task.skills.some(path => /discuss-host/.test(path)));
  state.claude_role = 'member';
  state.executions[0].status = 'completed';
  await runner.tick();
  state.pending = [{ id: 9, message_id: 19 }];
  await runner.tick();
  assert.ok(!JSON.parse(readFileSync(join(config.directory, 'free-2.task.json'), 'utf8')).skills.some(path => /discuss-host/.test(path)));
});

test('two instances of one platform keep separate sessions and credentials', async t => {
  const { state, store, config } = await free_fixture(t);
  config.participants['Claude-评审'] = { adapter: 'claude', model: 'opus' };
  config.members['Claude-评审'] = { token: 'reviewer-credential'.repeat(2) };
  state.others.push({ id: 8, name: 'Claude-评审', pending: [{ id: 3, message_id: 11 }] });
  const sessions = { Claude: 'session-main', 'Claude-评审': 'session-review' };
  const delivered = [];
  const runner = new FreeRoomRunner(config, store, async (adapter, binding, task) => {
    delivered.push([task.participant, adapter.model || '', binding.session_id || '']);
    return { status: 'accepted', session_id: sessions[task.participant] };
  });
  await runner.tick();
  assert.deepEqual(delivered, [['Claude', '', ''], ['Claude-评审', 'opus', '']]);
  assert.equal(store.binding('Claude').session_id, 'session-main');
  assert.equal(store.binding('Claude-评审').session_id, 'session-review');
  assert.equal(JSON.parse(readFileSync(join(config.directory, 'free-2.access.json'), 'utf8')).token, config.members['Claude-评审'].token);
});

test('repeated Sidecar session reports persist one member binding without a legacy enter operation', async t => {
  const f = await fixture(t);
  const config = { ...f.config, participants: { Codex: { adapter: 'antigravity_cli', executable: process.execPath } } };
  let sent = 0;
  const runner = new FreeRoomRunner(config, f.store, async (adapter, binding, task) => {
    task.on_binding('session-1'); task.on_binding('session-1');
    sent++;
    return { session_id: 'session-1', status: 'accepted' };
  });
  await runner.tick();
  await new FreeRoomRunner(config, f.store, async () => { sent++; return { status: 'accepted' }; }).tick();
  assert.equal(sent, 1);
  assert.equal(f.store.binding('Codex').session_id, 'session-1');
  assert.equal(f.calls.filter(action => action === 'reserve').length, 1);
  assert.equal(f.calls.some(action => String(action).includes('enter')), false);
});

test('codiscuss token writes only its hash through wrangler and the account is saved per site', async () => {
  const { create_admin_token, save_admin_account } = await import('../runner/admin_account.mjs');
  const root = mkdtempSync(join(tmpdir(), 'codiscuss-admin-test-'));
  try {
    assert.throws(() => create_admin_token(join(root, 'missing.jsonc'), () => {}), /找不到部署配置/);
    const config = join(root, 'wrangler.jsonc');
    writeFileSync(config, '{}');
    let sql = '', args = [];
    const { token } = create_admin_token(config, wrangler_args => { args = wrangler_args; sql = wrangler_args.at(-1); });
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.deepEqual(args.slice(0, 7), ['d1', 'execute', 'DB', '--remote', '--config', config, '--command']);
    assert.ok(!sql.includes(token) && sql.includes(createHash('sha256').update(token).digest('hex')));
    const home = join(root, 'home');
    const { saved } = save_admin_account(home, { site: 'https://example.pages.dev/', username: ' Admin ', password: 'Admin123456.' });
    save_admin_account(home, { site: 'https://other.example', username: 'B', password: 'secret-pass' });
    const accounts = JSON.parse(readFileSync(saved, 'utf8')).sites;
    assert.equal(accounts['https://example.pages.dev'].username, 'Admin');
    assert.equal(accounts['https://example.pages.dev'].password, 'Admin123456.');
    assert.equal(Object.keys(accounts).length, 2);
    assert.throws(() => save_admin_account(home, { site: 'https://example.pages.dev', username: 'Admin', password: '' }), /缺少/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

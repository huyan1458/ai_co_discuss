import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readdirSync, rmSync, existsSync, readFileSync, utimesSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { test } from 'node:test';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { listen_local } from './local_port.mjs';
import { DiscussionStore, load_config, service_drafts, validate_config } from '../runner/discussion_runner.mjs';
import { cwd_key, edited_changes, free_task_files, FreeRoomRunner, member_extra_directories, review_capability_version, workspace_snapshot } from '../runner/free_runner.mjs';
import { SessionDriver } from '../runner/session_driver.mjs';

import { EXPERT_PROMPT_PRESETS, expert_prompt, free_task_text, software_rules } from '../runner/expert_prompts.mjs';
import { participant_tools, system_prompt } from '../runner/adapters/api.mjs';
import { glob_regex, open_project, run_file_tool } from '../runner/adapters/api_files.mjs';
import { DiscussionService, migrate_platform_ids, migrate_service_home, persisted_env, read_registry, register_room, remove_room_files, service_pid, service_ready, start_service, sweep_service_home, unregister_room } from '../runner/discussion_service.mjs';
import { restore_room, room_profiles } from '../runner/discussion_launch.mjs';
import { adapter_of, deliver_task, execution_details } from '../runner/adapters/index.mjs';
import { adopted_fork, claude_api_error, claude_permissions, claude_exit_error, claude_inbox_ready, claude_rule_path, standalone_claude_env, watch_window_turn } from '../runner/adapters/claude.mjs';
import { codex_permissions } from '../runner/adapters/codex_cli.mjs';
import { agy_rule, prepare_agy_project, remove_agy_projects, sweep_legacy_agy_projects } from '../runner/adapters/antigravity_cli.mjs';
import { kill_process_tree, run_program, TASK_SUBCOMMANDS } from '../runner/adapters/common.mjs';

// The service and setup install Pi from npm unless one is given; tests never download it.
process.env.CODISCUSS_PI_CLI ??= 'pi-not-needed-in-this-test';
const activity_phase = (adapter, event) => adapter_of(adapter).events.phase(event);
import { save_api_key, saved_api_keys } from '../runner/discussion_api.mjs';
import { certainty, decide, decide_interjection, decide_next_speaker, decide_round, ROUTE_CONFIDENCE, ROUTE_WIDE_CONFIDENCE, route_free_message, scheduler_thresholds, scheduler_answers, scheduler_check, scheduler_request, SCHEDULER_PROVIDERS, scheduler_state, validate_scheduler } from '../runner/scheduler.mjs';

/** Every room configuration keeps one member credential per woken participant. */
const with_members = config => ({ ...config, members: Object.fromEntries(Object.keys(config.participants).map(name => [name, { token: 'm'.repeat(32) }])) });

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
  const pair = { ...input, members: [...input.members, { name: 'Antigravity', description: 'Antigravity CLI' }], message: { id: 4, author: '用户', text: 'codex 和 Antigravity 分别看一下' } };
  const picked = await route_free_message(home, jev, pair, async (url, init) => { named_sent = JSON.parse(init.body); return reply('__some__:Codex、Antigravity', limits.wide)(); });
  assert.ok(Object.keys(named_sent.questions.handler.criteria).includes('__some__:Codex、Antigravity'));
  assert.deepEqual([picked.action, picked.members], ['some', ['Codex', 'Antigravity']]);
  assert.equal((await route_free_message(home, jev, pair, reply('__some__:Codex、Antigravity', limits.wide - 0.01))).action, 'host');
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
  await decide_interjection(home, jev, { ...interjection, spoken: ['Antigravity'] }, async (url, init) => { interjected = JSON.parse(init.body); return handling('__host__', 0.9)(); });
  assert.match(interjected.state, /本轮已发言：Antigravity；本轮尚未发言：Codex/);
  assert.doesNotMatch(interjected.questions.handling.criteria.__host__, /本轮已发言的专家/);
  // A round continues only on a confident "continue", and never opens with the last speaker.
  let sent;
  const round = (next, confidence, first, first_confidence = 0.9) => async (url, init) => { sent = JSON.parse(init.body);
    return { ok: true, json: async () => ({ answers: { next: { type: 'choice', choice: next, confidence, probabilities: {} }, first: { type: 'choice', choice: first, confidence: first_confidence, probabilities: {} } } }) }; };
  const discussion = { title: '讨论', context: [], host: 'Claude', experts: ['Codex', 'Antigravity', 'Grok'], last_speaker: 'Grok' };
  assert.deepEqual(without_detail(await decide_round(home, jev, discussion, round('continue', 0.9, 'Antigravity'))), { action: 'continue', first: 'Antigravity', confidence: 0.9, label: '继续下一轮，先请 Antigravity 发言' });
  assert.deepEqual(Object.keys(sent.questions.first.criteria), ['Codex', 'Antigravity', '__host__']);
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
  const midround = { title: '讨论', context: [], host: 'Claude', candidates: ['Codex', 'Antigravity'] };
  const asked = [];
  await decide_next_speaker(home, jev, { ...midround, brief: '甲出上句', focus: '接龙', arrangement: 'Codex：出句', spoken: ['Claude'] }, async (url, init) => { asked.push(JSON.parse(init.body)); return speaker('Antigravity', 0.9)(); });
  assert.match(asked[0].state, /主持简报[^\n]*甲出上句/);
  assert.match(asked[0].state, /本轮已发言：Claude；本轮尚未发言：Codex、Antigravity/);
  assert.match(asked[0].state, /主持人最近的安排：Codex：出句/);
  assert.equal(typeof (await decide_next_speaker(home, jev, midround, speaker('Antigravity', 0.9))).detail[0].duration_ms, 'number');
  assert.deepEqual(without_detail(await decide_next_speaker(home, jev, midround, speaker('Antigravity', 0.9))), { action: 'next', expert: 'Antigravity', confidence: 0.9, label: '本轮继续，请 Antigravity 接着发言' });
  assert.equal((await decide_next_speaker(home, jev, midround, speaker('Antigravity', limits.member - 0.01))).action, 'host');
  assert.equal((await decide_next_speaker(home, jev, midround, speaker('__host__', 0.95))).action, 'host');
  // One question; the guided wording explains that the host may have stopped on purpose, the stable one names it as no basis.
  assert.deepEqual(Object.keys(asked[0].questions), ['speaker']);
  assert.match(asked[0].questions.speaker.instructions, /有意只安排到这里/);
  await decide_next_speaker(home, { ...jev, mode: 'stable' }, midround, async (url, init) => { asked.push(JSON.parse(init.body)); return speaker('Antigravity', 0.9)(); });
  assert.match(asked.at(-1).questions.speaker.criteria.__host__, /仅仅是本轮还没发言不算依据/);
  // The guided interjection sees who speaks next, so a question to that expert can wait for the turn.
  let upcoming_sent;
  await decide_interjection(home, jev, { ...interjection, upcoming: ['Antigravity', 'Codex'] }, async (url, init) => { upcoming_sent = JSON.parse(init.body); return handling('__note__', 0.9)(); });
  assert.match(upcoming_sent.state, /接下来按安排发言：Antigravity → Codex/);
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

test('API profiles need a bound key and no software, and take only the access their file tools enforce', t => {
  const home = mkdtempSync(join(tmpdir(), 'api-config-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const base_url = 'https://openrouter.ai/api/v1';
  const key = save_api_key(home, { base_url, api_key: 'test-only-key' });
  const input = with_members({ site: 'https://discussion.test', room: 'api-room', token: 'owner'.repeat(8), api_home: home, project_access: 'write',
    participants: { Grok: { adapter: 'api', api_protocol: 'chat', base_url, model: 'vendor/model.1', ...key, project_access: 'write', cwd: home, executable: 'x.exe' } } });
  const config = validate_config(input, home);
  assert.equal(config.participants.Grok.project_access, 'write');
  assert.equal(config.participants.Grok.cwd, home);
  assert.equal(config.participants.Grok.executable, undefined);
  // Without a command line there is nothing for a software to approve, so 自动 and 全放开 are refused.
  assert.throws(() => validate_config({ ...input, participants: { Grok: { ...input.participants.Grok, project_access: 'full' } } }, home), /没有通用命令行/);
  assert.throws(() => validate_config({ ...input, participants: { Grok: { ...input.participants.Grok, base_url: 'https://api.x.ai/v1' } } }, home), /重新填写/);
  assert.deepEqual(saved_api_keys(home), { [base_url]: key.api_key_ref });
});

test('API file tools stay inside the project, refuse secrets and private files, and modify only what they read', t => {
  const root = mkdtempSync(join(tmpdir(), 'api-files-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project'), service = join(project, '.codiscuss');
  mkdirSync(join(project, 'src'), { recursive: true });
  mkdirSync(join(project, '.git'));
  mkdirSync(join(service, 'api-keys'), { recursive: true });
  writeFileSync(join(project, 'notes.md'), 'one\r\ntwo\r\ntwo\r\n');
  writeFileSync(join(project, 'src', 'app.js'), 'const answer = 42;\n');
  writeFileSync(join(project, '.env'), 'TOKEN=secret');
  writeFileSync(join(project, '.git', 'config'), '[core]');
  writeFileSync(join(service, 'api-keys', 'k.json'), '{"api_key":"secret"}');
  writeFileSync(join(root, 'outside.txt'), 'outside');
  const tools = files => participant_tools({ role: 'member', project: files }).map(item => item.name);
  const reader = open_project({ cwd: project, project_access: 'read' }, [service]);
  assert.deepEqual(tools(null), ['read_room', 'read_messages', 'read_message', 'submit_chat']);
  assert.deepEqual(tools(reader), ['read_room', 'read_messages', 'read_message', 'read', 'glob', 'grep', 'submit_chat']);
  assert.match(system_prompt({ participant: 'DeepSeek', role: 'member', project: reader }), /可用 read、glob、grep 工具只读本房间的项目目录/);

  // The read envelope and footers follow DeepSeek Harness.
  assert.equal(run_file_tool(reader, 'read', { file_path: 'notes.md', offset: 2, limit: 1 }),
    '<path>notes.md</path>\n<type>file</type>\n<content>\n2: two\n\n(Showing lines 2-2 of 3. Use offset=3 to continue.)\n</content>');
  for (const file_path of ['.env', '.git/config', '.codiscuss/api-keys/k.json', '../outside.txt', join(root, 'outside.txt')]) {
    assert.ok(run_file_tool(reader, 'read', { file_path }).error, file_path);
  }
  assert.equal(run_file_tool(reader, 'glob', { pattern: '*.js' }), 'src/app.js');
  assert.equal(run_file_tool(reader, 'glob', { pattern: '*' }).split('\n').sort().join('\n'), 'notes.md\nsrc/app.js');
  assert.equal(run_file_tool(reader, 'grep', { pattern: 'answer|secret', include: '*.{js,json}' }), 'Found 1 match\n\nsrc/app.js\nLine 1: const answer = 42;');
  assert.equal(run_file_tool(reader, 'grep', { pattern: 'TOKEN' }), 'No matches found');

  const writer = open_project({ cwd: project, project_access: 'write' }, [service]);
  assert.deepEqual(tools(writer).slice(-3), ['write', 'edit', 'submit_chat']);
  assert.match(system_prompt({ participant: 'DeepSeek', role: 'member', project: writer }), /草稿文件与 --body-file 不适用：回答正文直接放进 submit_chat/);
  const edit = { file_path: 'notes.md', old_string: 'one', new_string: 'first' };
  assert.match(run_file_tool(writer, 'edit', edit).error, /has not been read/);
  assert.match(run_file_tool(writer, 'write', { file_path: 'notes.md', content: 'x' }).error, /has not been read/);
  run_file_tool(writer, 'read', { file_path: 'notes.md' });
  assert.match(run_file_tool(writer, 'edit', { ...edit, old_string: 'two' }).error, /matched 2 times/);
  assert.equal(run_file_tool(writer, 'edit', edit), 'The file notes.md has been updated successfully.');
  assert.equal(readFileSync(join(project, 'notes.md'), 'utf8'), 'first\r\ntwo\r\ntwo\r\n', 'the file keeps its CRLF line endings');
  assert.match(run_file_tool(writer, 'write', { file_path: 'docs/report.md', content: '# 汇报\n' }), /Created file/);
  assert.equal(readFileSync(join(project, 'docs', 'report.md'), 'utf8'), '# 汇报\n');
  // A change by someone else after the read makes the next modification re-read first.
  writeFileSync(join(project, 'notes.md'), 'changed by another member, longer\n');
  assert.match(run_file_tool(writer, 'edit', { ...edit, old_string: 'first', new_string: '1' }).error, /changed since it was read/);
  assert.ok(run_file_tool(writer, 'write', { file_path: '../escape.txt', content: 'x' }).error);
  assert.ok(run_file_tool(writer, 'write', { file_path: '.env.local', content: 'x' }).error);
  assert.equal(existsSync(join(root, 'escape.txt')), false);
  assert.ok(glob_regex('src/**/*.test.js').test('src/a/b.test.js') && glob_regex('src/**/*.test.js').test('src/b.test.js'));
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

test('saved Gemini members move to the Antigravity ID once, keeping their sessions and display labels', () => {
  const home = mkdtempSync(join(tmpdir(), 'platform-ids-')), room = join(home, 'launches', 'key');
  mkdirSync(join(room, 'runtime'), { recursive: true });
  writeFileSync(join(home, 'launch-settings.json'), JSON.stringify({ participants: { Gemini: { adapter: 'antigravity_cli' } } }));
  writeFileSync(join(room, 'config.json'), JSON.stringify({ participants: { 'Gemini-2': { adapter: 'antigravity_cli' } }, members: { 'Gemini-2': { token: 't' } }, note: 'Gemini-文档' }));
  writeFileSync(join(room, 'manual-Gemini.access.json'), JSON.stringify({ member: 'Gemini', token: 'm' }));
  const store = new DiscussionStore(join(room, 'runtime'));
  store.db.prepare('INSERT INTO bindings VALUES (?,?)').run('Gemini-2', 'session-1');
  store.db.prepare('INSERT INTO metadata VALUES (?,?)').run('member-context:Gemini-2', '[["Gemini-2","antigravity_cli"]]');
  store.close();
  migrate_platform_ids(home);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(home, 'launch-settings.json'), 'utf8')).participants), ['Antigravity']);
  const config = JSON.parse(readFileSync(join(room, 'config.json'), 'utf8'));
  assert.deepEqual([Object.keys(config.participants), Object.keys(config.members), config.note], [['Antigravity-2'], ['Antigravity-2'], 'Gemini-文档']);
  assert.equal(JSON.parse(readFileSync(join(room, 'manual-Gemini.access.json'), 'utf8')).member, 'Antigravity');
  const after = new DiscussionStore(join(room, 'runtime'));
  try {
    assert.equal(after.binding('Antigravity-2').session_id, 'session-1');
    assert.equal(after.db.prepare('SELECT value FROM metadata WHERE key=?').get('member-context:Antigravity-2').value, '[["Antigravity-2","antigravity_cli"]]');
  } finally { after.close(); }
  // The marker keeps a later start from touching the files again.
  writeFileSync(join(home, 'launch-settings.json'), JSON.stringify({ participants: { Gemini: {} } }));
  migrate_platform_ids(home);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(home, 'launch-settings.json'), 'utf8')).participants), ['Gemini']);
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
        // Like the site, a started retry keeps its attempt number with no pending time.
        if (body.action === 'retry_start') { execution.retry = { ...execution.retry, retry_at: 0 }; execution.status = 'dispatched'; }
        result = execution;
      }
    } else if (route.startsWith('/chats/')) {
      const chat = (member.chats || []).find(item => item.id === Number(route.split('/')[2]));
      calls.push(`chat:${body.action}`);
      const target = { start: 'running', reply: 'answered', fail: 'failed', steered: 'interjected' }[body.action];
      Object.assign(chat, { status: target, reply: body.text || '', reason: body.reason || '' });
      result = chat;
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

test('a backup carries local member sessions, and restoring it resumes them while Claude Code stays manual', async t => {
  const home = mkdtempSync(join(tmpdir(), 'discussion-restore-'));
  const saved_env = { CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  const token = 'owner-token'.repeat(4);
  const server = createServer((request, response) => {
    const ok = request.headers['x-discussion-token'] === token;
    response.writeHead(ok ? 200 : 403, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(!ok ? { error: '凭据无效' } : request.url.endsWith('/inbox') ? { requests: [] }
      : { mode: 'free', free: { members: [{ name: 'Claude-review', access: 'manual', status: 'away' }] } }));
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
  assert.deepEqual(restored.keep_manual, ['Claude-review', 'Claude']);
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

test('an execution inherited from a stopped or crashed runner retries once its software is gone, and waits while it runs', async t => {
  const exited = spawnSync(process.execPath, ['-e', '']).pid;
  for (const [pid, gone] of [[undefined, true], [exited, true], [process.pid, false]]) {
    const f = await fixture(t); const prompts = [];
    const deliver = async (adapter, binding, task) => {
      prompts.push(task.prompt); task.on_process(Object.assign(new EventEmitter(), { pid, kill() {} }));
      return { status: 'accepted' };
    };
    await new FreeRoomRunner(f.config, f.store, deliver).tick();
    const id = f.current_execution().id;
    // No stop_children(): a crash leaves no mark, so the next runner must judge by the recorded processes alone.
    const restarted = new FreeRoomRunner(f.config, f.store, deliver);
    await restarted.tick();
    assert.equal(prompts.length, 1); assert.equal(f.executions.get(id).status, 'dispatched');
    assert.equal(Boolean(f.executions.get(id).retry), gone);
    if (!gone) continue;
    assert.match(f.executions.get(id).retry.reason, /接入程序重启或异常退出/);
    f.executions.get(id).retry.retry_at = 1;
    // Another restart during the wait: the site's retry record still marks the redelivery as a continuation.
    await new FreeRoomRunner(f.config, f.store, deliver).tick();
    assert.equal(prompts.length, 2); assert.equal(f.executions.size, 1, 'the retry keeps the one execution card');
    // The session still holds the work so far: the redelivery asks to continue, with the original task after the notice.
    assert.match(prompts[1], new RegExp(`^本机接入程序重启或异常退出.*执行 #${id}.*不必重做`));
    assert.ok(prompts[1].endsWith(prompts[0]), 'the original task follows the restart notice unchanged');
  }
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

// Real agy 1.4.12 output from executions that failed before any turn ran (room 27395c25b03d, #317 and #318).
const AGY_NOT_STARTED = {
  network: ['Error: Eligibility check failed: Post "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist": EOF',
    'Eligibility check failed: Post "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist": EOF'],
  sign_in: ['Authentication required. Please visit the URL to log in:\nWaiting for authentication (timeout 60s)...\nError: authentication timed out.',
    'authentication failed or timed out'],
};
const agy_not_started = error => ({ event: 'result', result: { conversation_id: '', status: 'ERROR', response: '', error,
  duration_seconds: 0, num_turns: 0, finished_reason: 'error' } });

/**
 * Deliver once and let the runner react to the outcome; `runs` is how many agy processes that delivery starts, as an
 * agy that fails before any turn is restarted at once (twice) before the runner sees the failure.
 */
async function agy_not_started_attempt(f, runner, process_fixture, runs = 3) {
  const calls = process_fixture.calls.length;
  await runner.tick();
  for (let started = calls + 1; started <= calls + runs; started++) {
    while (process_fixture.calls.length < started) await delay(10);
    await process_fixture.calls[started - 1].closed;
  }
  await delay(10);
  assert.equal(process_fixture.calls.length, calls + runs, 'agy was invoked');
  await runner.tick();
}

for (const [cause, [stderr, error]] of Object.entries(AGY_NOT_STARTED)) {
test(`agy that fails before any turn (${cause}) retries the same execution, then fails with agy's own reason`, async t => {
  const f = await fixture(t);
  f.config.participants.Codex = { adapter: 'antigravity_cli', executable: process.execPath };
  const process_fixture = fake_cli([agy_not_started(error)], { stderr, exit_code: 1 });
  const deliver = (config, binding, task) => deliver_task(config, binding, task, process_fixture.spawn_process, join(f.config.directory, 'user'));
  const runner = new FreeRoomRunner(f.config, f.store, deliver);
  await agy_not_started_attempt(f, runner, process_fixture);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const execution = f.current_execution();
    assert.equal(execution.status, 'dispatched');
    assert.equal(execution.retry.attempt, attempt);
    assert.ok(execution.retry.reason.includes(error), execution.retry.reason);
    execution.retry.retry_at = 1;
    await agy_not_started_attempt(f, runner, process_fixture);
  }
  assert.equal(f.executions.size, 1, 'retries keep the one execution card');
  assert.equal(f.current_execution().status, 'failed');
  assert.ok(f.current_execution().result.includes(error), f.current_execution().result);
  assert.match(f.current_execution().result, /已自动重试 3 次/);
});
}

test('agy that fails after its conversation started is not delivered again', async t => {
  const f = await fixture(t);
  f.config.participants.Codex = { adapter: 'antigravity_cli', executable: process.execPath };
  const process_fixture = fake_cli([{ event: 'init', conversation_id: 'started' },
    { event: 'result', result: { conversation_id: 'started', status: 'ERROR', response: '', error: 'quota exhausted', num_turns: 1 } }], { exit_code: 1 });
  const deliver = (config, binding, task) => deliver_task(config, binding, task, process_fixture.spawn_process, join(f.config.directory, 'user'));
  await agy_not_started_attempt(f, new FreeRoomRunner(f.config, f.store, deliver), process_fixture, 1);
  assert.equal(f.current_execution().status, 'failed');
  assert.equal(f.current_execution().retry, null);
});

// agy's headless eligibility check fails the whole run on one dropped connection while its interactive window carries on.
test('agy whose eligibility check drops a connection is restarted at once and runs the turn without a runner retry', async t => {
  const f = await fixture(t);
  f.config.participants.Codex = { adapter: 'antigravity_cli', executable: process.execPath };
  const process_fixture = fake_cli(cli_events('antigravity_cli'),
    { earlier: [{ events: [agy_not_started(AGY_NOT_STARTED.network[1])], exit_code: 1 }] });
  const deliver = (config, binding, task) => deliver_task(config, binding, task, process_fixture.spawn_process, join(f.config.directory, 'user'));
  await agy_not_started_attempt(f, new FreeRoomRunner(f.config, f.store, deliver), process_fixture, 2);
  assert.equal(f.current_execution().retry, null, 'no runner retry was needed');
  // The fake turn ends without saving an answer, so the runner reports that, not the eligibility failure.
  assert.match(f.current_execution().result, /未提交本次回答/);
  assert.equal(f.store.binding('Codex').session_id, 'actual-cli-session');
});

/** Emit real subprocess output in split UTF-8 chunks without invoking an AI account. */
function fake_cli(events, options = {}) {
  const calls = [];
  const config_calls = [];
  // `options.earlier`: runs the first calls emit instead, as { events, exit_code }, before `events` takes over.
  const source_for = ({ events, exit_code }) => `
    const fs = require('node:fs');
    (async () => {
      // The Codex bridge and Claude keep stdin open for interjections after their first line (the task, the first
      // stream-json message); other CLIs close it.
      let input = '';
      for await (const chunk of process.stdin) {
        input += chunk;
        if (/^\\{"(prompt|type)"/.test(input) && input.includes('\\n')) break;
      }
      fs.writeFileSync('stdin.txt', input);
      process.stderr.write(${JSON.stringify(options.stderr || 'diagnostic 中文')});
      const output = Buffer.from(${JSON.stringify(events.map(event => JSON.stringify(event)).join('\r\n') + '\r\n')});
      const split = Math.max(1, output.indexOf(Buffer.from('中文')) + 1);
      process.stdout.write(output.subarray(0, split));
      await new Promise(resolve => setTimeout(resolve, 5));
      process.stdout.write(output.subarray(split));
      if (${Boolean(options.linger)}) setInterval(() => {}, 1000);
      process.exitCode = ${exit_code || 0};
    })();`;
  const runs = (options.earlier || []).map(source_for);
  const source = source_for({ events, exit_code: options.exit_code });
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
    const child = spawn(process.execPath, ['-e', runs[calls.length] || source], settings);
    const call = { executable, args, settings, child, closed: once(child, 'close'), input: '' };
    // What the runner wrote first: a CLI's prompt, or the Codex bridge's task line.
    for (const method of ['write', 'end']) {
      const original = child.stdin[method].bind(child.stdin);
      child.stdin[method] = (chunk, ...rest) => { if (!call.input && typeof chunk === 'string') call.input = chunk; return original(chunk, ...rest); };
    }
    calls.push(call);
    return child;
  };
  return { calls, config_calls, spawn_process };
}

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
  const task = { id: 'event-1', participant: 'Antigravity', directory, draft_directory, access_path, prompt: '讨论中文 "quotes"\n$(literal); `literal`',
    skill_directories: [join(directory, 'skills')],
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
  assert.equal(call.settings.windowsHide, true);
  assert.ok(!call.args.some(arg => arg.startsWith('--dangerously')));
  if (adapter === 'codex_cli') {
    // The bridge runs the configured Codex as app-server; the task travels as its first stdin line.
    assert.equal(call.executable, process.execPath); assert.match(call.args[0], /codex_bridge\.mjs$/); assert.equal(call.args[1], f.config.executable);
    const input = JSON.parse(readFileSync(join(f.task.draft_directory, 'stdin.txt'), 'utf8'));
    assert.deepEqual(input, { prompt: f.task.prompt, thread_id: '', cwd: f.task.draft_directory, model: '', effort: '', full: false });
    assert.equal(typeof f.result.steer, 'function', 'a running Codex turn takes interjections');
    const overrides = call.args.filter((arg, index) => call.args[index - 1] === '-c');
    assert.equal(overrides[2], 'approval_policy="never"');
    // On Windows the sandbox's TEMP moves into the writable drafts, so PowerShell keeps FullLanguage and UTF-8 output.
    const drafts = JSON.stringify(resolve(f.task.draft_directory).replaceAll('\\', '/'));
    assert.deepEqual(overrides.slice(3), process.platform === 'win32'
      ? [`shell_environment_policy.set.TEMP=${drafts}`, `shell_environment_policy.set.TMP=${drafts}`] : []);
    assert.match(overrides[1], /extends=":read-only"/); assert.match(overrides[1], /network=\{enabled=true\}/);
    assert.ok(overrides[1].includes(`${JSON.stringify(f.directory.replaceAll('\\', '/'))}="read"`));
    assert.ok(overrides[1].includes(`${JSON.stringify(f.task.draft_directory.replaceAll('\\', '/'))}="write"`));
    assert.deepEqual(f.config_calls[0].args.slice(1), call.args.slice(2));
    assert.ok(!call.args.includes('--add-dir'));
  } else {
    assert.ok(call.args.includes(f.task.draft_directory));
    assert.ok(call.args.includes(f.task.skill_directories[0]));
    assert.equal(call.args[call.args.indexOf('-p') + 1], f.task.prompt);
    assert.equal(call.args[call.args.indexOf('--output-format') + 1], 'stream-json');
    assert.equal(call.args[call.args.indexOf('--print-timeout') + 1], '0');
    assert.equal(call.args[call.args.indexOf('--project') + 1], 'outside-of-project');
    assert.ok(existsSync(call.args[call.args.indexOf('--settings') + 1]));
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
    assert.equal(args.includes('--project'), false); assert.equal(args.includes('--settings'), false); assert.deepEqual(hosted.errors, []);
    return;
  }
  const f = await cli_delivery_fixture(t, adapter, { binding: { session_id: 'actual-cli-session' },
    config: { cwd: project, project_access: 'write' } });
  const call = f.calls[0];
  if (adapter === 'codex_cli') assert.equal(JSON.parse(call.input).thread_id, 'actual-cli-session');
  else assert.equal(call.args[call.args.indexOf('--conversation') + 1], 'actual-cli-session');
  assert.equal(call.args.includes('--last'), false); assert.equal(call.args.includes('--continue'), false);
  assert.equal(call.args.includes('--project'), false); assert.deepEqual(f.errors, []);
  assert.equal(call.settings.cwd, project);
  if (adapter === 'codex_cli') {
    assert.ok(call.args.some(arg => arg.startsWith('default_permissions=')));
    assert.match(call.args.find(arg => arg.startsWith('permissions.')), /extends=":workspace"/);
    assert.equal(JSON.parse(call.input).cwd, project);
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
    assert.equal(JSON.parse(call.input).cwd, project);
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
  if (adapter === 'codex_cli') assert.equal(JSON.parse(process_fixture.calls[1].input).thread_id, 'actual-cli-session');
  else assert.equal(args[args.indexOf('--conversation') + 1], 'actual-cli-session');
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

test('extra project directories follow the member access, and stay read-only for a member working outside the room project', t => {
  const f = task_fixture(t);
  const [main, docs, elsewhere] = ['main', 'docs', 'elsewhere'].map(name => join(f.config.directory, name));
  for (const path of [main, docs, elsewhere]) mkdirSync(path);
  const room = { cwd: main, extra_directories: [docs] };
  assert.deepEqual(member_extra_directories(room, { adapter: 'claude', cwd: main, project_access: 'write' }), [{ path: docs, access: 'write' }]);
  assert.deepEqual(member_extra_directories(room, { adapter: 'claude', cwd: main, project_access: 'read' }), [{ path: docs, access: 'read' }]);
  assert.deepEqual(member_extra_directories(room, { adapter: 'claude', cwd: elsewhere, project_access: 'write' }),
    [{ path: main, access: 'read' }, { path: docs, access: 'read' }], 'a member working elsewhere only reads the room');
  assert.deepEqual(member_extra_directories(room, { adapter: 'codex', cwd: main, project_access: 'write' }).length, 1);
  assert.deepEqual(member_extra_directories(room, { adapter: 'claude', cwd: '', project_access: 'write' }),
    [{ path: main, access: 'write' }, { path: docs, access: 'write' }], 'a member from before the room had a project reaches it at its own access');
  const pinned = claude_permissions({ cwd: '', project_access: 'write' }, { ...session_task(f.config), extra_directories: [{ path: main, access: 'write' }] });
  assert.ok(pinned.includes('Bash') && pinned.includes(`Edit(${claude_rule_path(main)}/**)`), 'writing a room directory lets it run commands');

  const extra_directories = [{ path: docs, access: 'write' }, { path: main, access: 'read' }];
  const task = { ...session_task(f.config), extra_directories };
  const claude = claude_permissions({ cwd: elsewhere, project_access: 'write' }, task);
  const denied = claude.slice(claude.indexOf('--disallowedTools'));
  assert.ok(claude.includes(docs) && claude.includes(main), 'both are working directories');
  assert.ok(denied.includes(`Edit(${claude_rule_path(main)}/**)`), 'the read-only one is never edited');
  assert.ok(claude.includes(`Edit(${claude_rule_path(docs)}/**)`) && !denied.includes(`Edit(${claude_rule_path(docs)}/**)`));
  assert.ok(claude_permissions({ cwd: elsewhere, project_access: 'auto' }, task).slice(-2).includes(`Edit(${claude_rule_path(main)}/**)`));

  const codex = codex_permissions({ cwd: elsewhere, project_access: 'write' }, task, 'linux').args.find(arg => arg.startsWith('permissions.'));
  const entry = (path, access) => `${JSON.stringify(resolve(path).replaceAll('\\', '/'))}=${JSON.stringify(access)}`;
  assert.ok(codex.includes(entry(main, 'read')) && codex.includes(entry(docs, 'write')));

  const user_home = join(f.config.directory, 'user');
  mkdirSync(join(user_home, '.gemini', 'config', 'projects'), { recursive: true });
  const agy = prepare_agy_project({ cwd: elsewhere, project_access: 'write' }, {}, task, user_home);
  const grants = JSON.parse(readFileSync(agy.settings_path, 'utf8')).permissions;
  const rule = path => `write_file(${resolve(path).replaceAll('\\', '/')})`;
  assert.ok(grants.deny.includes(rule(main)) && !grants.allow.includes(rule(main)));
  assert.ok(grants.allow.includes(rule(docs)));
  assert.equal(agy.directories.length, 3);
  assert.deepEqual(readdirSync(join(user_home, '.gemini', 'config', 'projects')), ['outside-of-project.json']);

  writeFileSync(join(main, 'a.md'), 'main');
  writeFileSync(join(docs, 'b.md'), 'docs');
  const api = open_project({ cwd: main, project_access: 'write', extra_directories: [{ path: docs, access: 'read' }] });
  assert.match(run_file_tool(api, 'read', { file_path: join(docs, 'b.md') }), /1: docs/);
  assert.match(run_file_tool(api, 'write', { file_path: join(docs, 'b.md'), content: 'x' }).error, /read-only/);
  assert.equal(readFileSync(join(docs, 'b.md'), 'utf8'), 'docs');
  assert.ok(run_file_tool(api, 'read', { file_path: join(elsewhere, 'a.md') }).error, 'a directory outside the room stays closed');
  assert.match(system_prompt({ participant: 'DeepSeek', role: 'member', project: api }), /另有项目目录.*只读/);
});

test('agy separates native project permissions from the selected project and preserves read/write boundaries', async t => {
  const f = task_fixture(t);
  const user_home = join(f.config.directory, 'user');
  const projects = join(user_home, '.gemini', 'config', 'projects');
  mkdirSync(projects, { recursive: true });
  const source_dir = join(f.config.directory, 'source');
  const original = { id: 'original', name: 'Original project', settings: { keep: true },
    projectResources: { resources: [{ folder: { folderUri: pathToFileURL(source_dir).href } }] },
    permissionGrants: { permissionGrants: { allow: ['command(*)'] } } };
  const original_path = join(projects, 'original.json');
  const original_text = JSON.stringify(original);
  writeFileSync(original_path, original_text);
  // A folder agy loads skills from through skills.json stays readable but is never writable.
  const shared_skills = join(user_home, '.agents', 'skills');
  mkdirSync(shared_skills, { recursive: true });
  writeFileSync(join(user_home, '.gemini', 'config', 'skills.json'), JSON.stringify({ entries: [{ path: shared_skills }] }));
  const task = { ...session_task(f.config), room_title: '架构评审' };
  const config = { project_id: 'original', project_access: 'read' };
  const first = prepare_agy_project(config, {}, task, user_home);
  assert.equal(first.project_id, 'outside-of-project');
  assert.deepEqual(readdirSync(projects).sort(), ['original.json', 'outside-of-project.json']);
  assert.deepEqual(first.directories, [resolve(source_dir)]);
  const read = JSON.parse(readFileSync(first.settings_path, 'utf8')).permissions;
  const rule = path => `write_file(${resolve(path).replaceAll('\\', '/')})`;
  assert.deepEqual(read.allow, [agy_rule(), rule(task.draft_directory)]);
  assert.ok(read.deny.includes(rule(source_dir)));
  for (const path of [task.directory, ...task.skill_directories, shared_skills, join(user_home, '.gemini')]) {
    assert.ok(read.deny.includes(rule(path)));
  }
  assert.ok(read.deny.includes('mcp(*)'));
  first.bind('real-session');
  const resumed = prepare_agy_project({ ...config, project_access: 'write' }, { session_id: 'real-session' }, task, user_home);
  assert.equal(resumed.project_id, 'outside-of-project');
  const write = JSON.parse(readFileSync(resumed.settings_path, 'utf8')).permissions;
  assert.ok(write.allow.includes(rule(source_dir)));
  assert.ok(!write.deny.includes(rule(source_dir)));
  assert.ok(write.deny.includes(rule(task.directory)));
  assert.ok(write.allow.includes('command(*)') && !read.allow.includes('command(*)'));
  assert.ok(!write.allow.includes('unsandboxed_command(*)') && write.deny.includes('mcp(*)'));
  prepare_agy_project({ ...config, project_access: 'full' }, { session_id: 'real-session' }, task, user_home);
  const full = JSON.parse(readFileSync(resumed.settings_path, 'utf8')).permissions;
  assert.ok(full.allow.includes('unsandboxed_command(*)') && !full.deny.includes('mcp(*)'));
  assert.ok(full.deny.includes(rule(task.directory)), 'run data stays protected at every level');
  assert.equal(readFileSync(original_path, 'utf8'), original_text);
  assert.throws(() => prepare_agy_project(config, { session_id: 'other-session' }, task, user_home), /会话绑定不符/);
  // Legacy per-room UUID records self-migrate (whether or not their old project file still exists), and room cleanup clears both files.
  const legacy_id = '11111111-2222-3333-4444-555555555555';
  const record_file = readdirSync(task.directory).find(name => name.startsWith('agy-project-'));
  writeFileSync(join(projects, `${legacy_id}.json`), JSON.stringify({ id: legacy_id, name: 'CoDiscuss · 旧项目' }));
  writeFileSync(join(task.directory, record_file), JSON.stringify({ project_id: legacy_id, session_id: 'real-session' }));
  prepare_agy_project(config, { session_id: 'real-session' }, task, user_home);
  assert.equal(existsSync(join(projects, `${legacy_id}.json`)), false);
  writeFileSync(join(task.directory, record_file), JSON.stringify({ project_id: legacy_id, session_id: 'real-session' }));
  assert.equal( prepare_agy_project(config, { session_id: 'real-session' }, task, user_home).project_id, 'outside-of-project');
  assert.equal(remove_agy_projects(task.directory, user_home), 1);
  assert.equal(existsSync(first.settings_path), false);
  assert.equal(existsSync(join(projects, 'outside-of-project.json')), true);
  assert.equal(readFileSync(original_path, 'utf8'), original_text);
  assert.equal(remove_agy_projects(task.directory, user_home), 0);
  // Service room removal calls adapter cleanup on the room's runtime directory as well as its launch folder.
  const external_runtime = join(f.config.directory, 'external-runtime');
  mkdirSync(external_runtime, { recursive: true });
  const stale = prepare_agy_project({}, {}, { ...task, directory: external_runtime }, user_home);
  remove_room_files(f.config.directory, join(f.config.directory, 'launches', 'stale', 'config.json'), external_runtime);
  assert.equal(existsSync(stale.settings_path), false);
  // Housekeeping backs up and deletes retired CoDiscuss blank projects while sparing user, built-in and Sidecar-pinned ones.
  const orphan_a = '22222222-2222-3333-4444-555555555555', orphan_b = '33333333-2222-3333-4444-555555555555';
  const pinned_id = '44444444-2222-3333-4444-555555555555', user_id = '55555555-2222-3333-4444-555555555555';
  writeFileSync(join(projects, `${orphan_a}.json`), JSON.stringify({ id: orphan_a, name: 'CoDiscuss · 旧房间 · Antigravity' }));
  writeFileSync(join(projects, `${orphan_b}.json`), JSON.stringify({ id: orphan_b, name: 'codiscuss-92c5cc2e7bed' }));
  writeFileSync(join(projects, `${pinned_id}.json`), JSON.stringify({ id: pinned_id, name: 'CoDiscuss · Sidecar' }));
  writeFileSync(join(projects, `${user_id}.json`), JSON.stringify({ id: user_id, name: 'My Real Project' }));
  writeFileSync(join(projects, 'default-cli-project.json'), JSON.stringify({ id: 'default-cli-project', name: 'CLI Project' }));
  writeFileSync(join(user_home, '.gemini', 'config', 'config.json'), JSON.stringify({ sidecars: { s: { projectId: pinned_id } } }));
  assert.equal(sweep_legacy_agy_projects(f.config.directory, user_home), 2);
  assert.deepEqual(readdirSync(projects).sort(), [
    `${pinned_id}.json`, `${user_id}.json`, 'default-cli-project.json', 'original.json', 'outside-of-project.json',
  ]);
  const backup_folders = readdirSync(join(f.config.directory, 'backups'));
  assert.equal(backup_folders.length, 1);
  assert.deepEqual(readdirSync(join(f.config.directory, 'backups', backup_folders[0])).sort(), [`${orphan_a}.json`, `${orphan_b}.json`]);
  assert.equal(sweep_legacy_agy_projects(f.config.directory, user_home), 0);
});

test('agy refuses inherited shell bypasses before invoking a model and leaves settings unchanged', async t => {
  const f = task_fixture(t);
  const user_home = join(f.config.directory, 'user');
  const cli_path = join(user_home, '.gemini', 'antigravity-cli', 'settings.json');
  const shared_path = join(user_home, '.gemini', 'config', 'config.json');
  const outside_path = join(user_home, '.gemini', 'config', 'projects', 'outside-of-project.json');
  mkdirSync(join(user_home, '.gemini', 'antigravity-cli'), { recursive: true });
  mkdirSync(join(user_home, '.gemini', 'config', 'projects'), { recursive: true });
  const task = session_task(f.config);
  for (const [cli, shared, outside] of [
    [{ permissions: { allow: ['command(*)'] } }, {}, { id: 'outside-of-project' }],
    [{ permissions: { allow: ['*'] } }, {}, { id: 'outside-of-project' }],
    [{}, { userSettings: { globalPermissionGrants: { allow: ['unsandboxed_command(*)'] } } }, { id: 'outside-of-project' }],
    [{}, { userSettings: { globalPermissionGrants: { allow: ['unsandboxed(*)'] } } }, { id: 'outside-of-project' }],
    [{}, {}, { id: 'outside-of-project', permissionGrants: { permissionGrants: { allow: ['command(*)'] } } }],
  ]) {
    writeFileSync(cli_path, JSON.stringify(cli)); writeFileSync(shared_path, JSON.stringify(shared)); writeFileSync(outside_path, JSON.stringify(outside));
    await assert.rejects(deliver_task({ adapter: 'antigravity_cli' }, {}, task,
      () => assert.fail('must reject before spawning'), user_home), error => error.delivery_status === 'not_sent');
    assert.deepEqual(JSON.parse(readFileSync(cli_path, 'utf8')), cli);
    assert.deepEqual(JSON.parse(readFileSync(shared_path, 'utf8')), shared);
    assert.deepEqual(JSON.parse(readFileSync(outside_path, 'utf8')), outside);
  }
  writeFileSync(cli_path, JSON.stringify({ toolPermission: 'always-proceed', permissions: { allow: ['read_file(*)', 'command(git status)'] } }));
  writeFileSync(shared_path, JSON.stringify({ userSettings: { globalPermissionGrants: { allow: ['read_url(https://example.com)'] } } }));
  writeFileSync(outside_path, JSON.stringify({ id: 'outside-of-project', permissionGrants: { permissionGrants: { allow: ['command(git status)'] } } }));
  assert.equal(prepare_agy_project({}, {}, task, user_home).project_id, 'outside-of-project');
});

test('claude allows only codiscuss website subcommands and draft writes, then user rules', async t => {
  const f = await cli_delivery_fixture(t, 'claude', { events: [{ type: 'result', is_error: false, result: '完成' }],
    config: { allowed_tools: ['Read(//d/materials/**)'] } });
  const args = f.calls[0].args;
  assert.deepEqual(f.errors, []);
  assert.ok(!args.some(arg => arg.startsWith('--dangerously') || arg === '--permission-mode'));
  const directories = args.indexOf('--add-dir');
  assert.deepEqual(args.slice(directories + 1, directories + 4), [f.directory, f.task.draft_directory, f.task.skill_directories[0]]);
  assert.deepEqual(args.slice(args.indexOf('--disallowedTools') + 1), [`Edit(${claude_rule_path(f.task.skill_directories[0])}/**)`]);
  assert.deepEqual(args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--disallowedTools')),
    [...['room', 'message', 'turn', 'state', 'goal', 'mode', 'review', 'sequence', 'execution', 'health', 'schema', 'launch workflow-adopt', 'launch workflow-join', 'launch workflow-leave', 'launch host-control', 'attachment', 'launch image']
      .flatMap(command => [`Bash(codiscuss ${command} *)`, `PowerShell(codiscuss ${command} *)`]),
    `Edit(${claude_rule_path(f.task.draft_directory)}/**)`, 'Read(//d/materials/**)']);
  assert.ok(!args.includes(`Edit(${claude_rule_path(f.directory)}/**)`));
  assert.ok(!args.some(arg => /(Bash|PowerShell)\(codiscuss (service|launch (?!(workflow-(adopt|join|leave)|host-control|image) )|run|api|setup|install|local)/.test(arg)));
  // The prompt is the first stream-json message on stdin, which stays open for interjections.
  assert.ok(args.includes('--input-format') && !args.includes(f.task.prompt));
  assert.equal(JSON.parse(f.calls[0].input).message.content[0].text, f.task.prompt);
  assert.equal(typeof f.result.steer, 'function');
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
    { id: 'free-7', inbox: true, access_path, directory: home, prompt: '请先读取任务文件 free-7.task.json', on_note: () => {}, on_binding: session => bound.push(session) }, (...args) => { spawned.push(args); throw new Error('no process'); });
  assert.deepEqual(result, { session_id: original, status: 'accepted', capabilities: { stoppable: false, progress: true } }, 'the adapter reports it cannot stop a window, but reads its progress');
  assert.deepEqual(spawned, []);
  assert.deepEqual(bound, [original], 'the discussion runner enters the execution once the session is reported');
  for (let waited = 0; received.length < 2 && waited < 2000; waited += 20) await delay(20);
  assert.deepEqual(received[0], { type: 'auth', token: 'peer-token' });
  assert.equal(received[1].type, 'user');
  assert.match(received[1].message.content, /free-7\.task\.json/);
  assert.equal(JSON.parse(readFileSync(access_path, 'utf8')).session_id, original);
});

test('a Claude window turn that ends on a usage limit fails without retry, and one that ends plainly reports its end', async t => {
  const home = mkdtempSync(join(tmpdir(), 'claude-window-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const line = entry => `${JSON.stringify(entry)}\n`;
  const prompt = line({ type: 'user', message: { role: 'user', content: 'Another Claude session sent a message: 读取 free-9.task.json' } });
  const limit = line({ type: 'assistant', isApiErrorMessage: true, error: 'rate_limit',
    message: { model: '<synthetic>', content: [{ type: 'text', text: "You've hit your 5-hour limit · resets 11:50am" }] } });
  const turn_end = line({ type: 'system', subtype: 'turn_duration', durationMs: 4062 });
  const follow = async (entries) => {
    const file = join(home, `${randomUUID()}.jsonl`);
    writeFileSync(file, line({ type: 'user', message: { content: 'an earlier turn naming free-9.task.json' } }) + turn_end);
    const offset = readFileSync(file).length, seen = [];
    watch_window_turn({ file, offset, pid: process.pid, marker: 'free-9.task.json' },
      { on_failure: (error, options) => seen.push({ error, ...options }), on_exit: () => seen.push('exit') }, { interval: 10 });
    appendFileSync(file, entries);
    for (let waited = 0; !seen.length && waited < 2000; waited += 20) await delay(20);
    return seen;
  };
  const [failed] = await follow(prompt + limit + turn_end);
  assert.equal(failed.retryable, false);
  assert.equal(failed.error, 'Claude 5-hour 用量已达上限，11:50am 重置');
  assert.deepEqual(await follow(prompt + line({ type: 'assistant', message: { content: [{ type: 'text', text: '好' }] } }) + turn_end), ['exit']);
  assert.equal(claude_api_error({ type: 'assistant', is_api_error_message: true, error: 'server_error',
    message: { content: [{ type: 'text', text: 'API Error: 529 Overloaded' }] } }).lasting, false, 'an overloaded server is retried');
  // Shapes recorded by Claude Code 2.1.322 (2026-11-10): the turn ends while a background agent runs; its report starts the next.
  const launched = line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_bg', name: 'Agent', input: {} }] } })
    + line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_bg', content: [{ type: 'text', text: 'Async agent launched' }] }] },
      toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'a1' } });
  const reported = line({ type: 'attachment', attachment: { type: 'queued_command', commandMode: 'task-notification',
    prompt: '<task-notification>\n<task-id>a1</task-id>\n<tool-use-id>toolu_bg</tool-use-id>\n<status>completed</status>\n</task-notification>' } });
  const file = join(home, `${randomUUID()}.jsonl`);
  writeFileSync(file, '');
  const seen = [];
  watch_window_turn({ file, offset: 0, pid: process.pid, marker: 'free-9.task.json' }, { on_exit: () => seen.push('exit') }, { interval: 10 });
  appendFileSync(file, prompt + launched + turn_end);
  await delay(100);
  assert.deepEqual(seen, [], 'a turn waiting for its background agent has not ended');
  appendFileSync(file, reported + turn_end);
  for (let waited = 0; !seen.length && waited < 2000; waited += 20) await delay(20);
  assert.deepEqual(seen, ['exit']);
});

test('a Claude window turn reports its own work as activity, so its last remark can be captured', async t => {
  const home = mkdtempSync(join(tmpdir(), 'claude-window-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const line = entry => `${JSON.stringify(entry)}
`;
  const file = join(home, `${randomUUID()}.jsonl`), log_path = join(home, 'window.log');
  writeFileSync(file, '');
  const seen = [];
  watch_window_turn({ file, offset: 0, pid: process.pid, marker: 'free-9.task.json', log_path },
    { on_activity: phase => seen.push(`activity:${phase}`), on_note: text => seen.push(`note:${text}`), on_output: () => {}, on_exit: () => seen.push('exit') },
    { interval: 10 });
  appendFileSync(file, line({ type: 'user', message: { role: 'user', content: '读取 free-9.task.json' } })
    + line({ type: 'assistant', message: { content: [{ type: 'text', text: '完整回答' }] } })
    + line({ type: 'system', subtype: 'turn_duration', durationMs: 10 }));
  for (let waited = 0; !seen.includes('exit') && waited < 2000; waited += 20) await delay(20);
  assert.ok(seen.indexOf('activity:writing') >= 0 && seen.indexOf('activity:writing') < seen.indexOf('note:完整回答'), seen.join());
  assert.equal(seen.at(-1), 'exit');
});

test('a Claude window turn interrupted or closed before it finished exits with that reason, and its remark is not captured', async t => {
  const home = mkdtempSync(join(tmpdir(), 'claude-window-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const line = entry => `${JSON.stringify(entry)}
`;
  const start = line({ type: 'user', message: { role: 'user', content: '读取 free-9.task.json' } })
    + line({ type: 'assistant', message: { content: [{ type: 'text', text: '我接下来会修改文件，尚未完成' }] } });
  const follow = async (pid, tail) => {
    const file = join(home, `${randomUUID()}.jsonl`); writeFileSync(file, '');
    const seen = [];
    watch_window_turn({ file, offset: 0, pid, marker: 'free-9.task.json', log_path: join(home, 'window.log') },
      { on_activity: () => {}, on_note: () => {}, on_output: () => {}, on_failure: reason => seen.push(`failure:${reason}`),
        on_exit: reason => seen.push(`exit:${reason || ''}`) }, { interval: 10 });
    appendFileSync(file, start + tail);
    for (let waited = 0; !seen.length && waited < 2000; waited += 20) await delay(20);
    return seen;
  };
  const interrupted = await follow(process.pid, line({ type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } }));
  assert.deepEqual(interrupted, ['exit:在原窗口里被中断了这一轮']);
  const closed = await follow(2 ** 22 + 12345, '');
  assert.deepEqual(closed, ['exit:所在的原窗口在这一轮结束前关闭了']);
  // The runner fails such an execution at once: no capture and no retry.
  const { state, store, config } = await free_fixture(t);
  config.participants.Claude = { adapter: 'claude', project_access: 'own' };
  const runner = new FreeRoomRunner(config, store, async (adapter, binding, task) => {
    setImmediate(() => { task.on_activity('writing'); task.on_note('我接下来会修改文件，尚未完成'); task.on_exit('在原窗口里被中断了这一轮'); });
    return { status: 'accepted' };
  });
  await runner.tick();
  await runner.tick();
  assert.equal(state.executions[0].status, 'failed');
  assert.equal(state.posts, undefined);
  assert.match(state.executions[0].result, /在原窗口里被中断了这一轮，未提交本次回答/);
  assert.ok(!state.calls.some(call => call.endsWith('retry_wait')));
});

test('agy 全放开 skips its permission prompts, which no other level does', async t => {
  for (const project_access of ['read', 'write', 'full', 'own']) {
    const session = project_access === 'own' ? { session_id: 'actual-cli-session' } : {};
    const f = await cli_delivery_fixture(t, 'antigravity_cli', { config: { project_access, ...session }, binding: session });
    assert.deepEqual(f.errors, []);
    assert.equal(f.calls[0].args.includes('--dangerously-skip-permissions'), project_access === 'full');
    assert.equal(f.calls[0].args.includes('--project'), project_access !== 'own');
    assert.equal(f.calls[0].args.includes('--settings'), project_access !== 'own');
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
  return validate_config(with_members({ ...f.config, project: undefined, token: 'x'.repeat(32), cwd: project, project_access,
    participants: { Codex: { adapter: 'codex_cli', executable: process.execPath } }, data_directory: f.config.directory }), f.config.directory);
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
  assert.deepEqual(task.skill_directories, [join(f.config.project, '.agents', 'skills')]);
});

test('one data directory cannot silently share bindings across rooms or sites', async t => {
  const f = await fixture(t);
  f.store.scope(f.config, 'run');
  assert.throws(() => f.store.scope({ ...f.config, room: 'another' }, 'run'), /另一站点/);
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

/** Write a minimal valid private room configuration for the service registry. */
function room_config(directory, site, room, name = room) {
  const path = join(directory, `${name}.json`);
  writeFileSync(path, JSON.stringify(with_members({ site, room, token: 'x'.repeat(32), data_directory: join(directory, `data-${name}`),
    participants: { Antigravity: { adapter: 'antigravity', ipc_directory: directory } } })));
  return path;
}

test('the housekeeping sweep removes week-old files of ended executions and keeps current or recent ones', t => {
  const home = mkdtempSync(join(tmpdir(), 'discussion-sweep-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const path = room_config(home, 'http://127.0.0.1:1', 'room1');
  register_room(home, path);
  const config = load_config(path);
  const store = new DiscussionStore(config.directory);
  new FreeRoomRunner(config, store).save('Antigravity', { client_id: 'c', execution_id: 7, status: 'running' });
  store.close();
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  const write = (name, aged) => {
    const file = join(config.directory, name);
    writeFileSync(file, '{}');
    if (aged) utimesSync(file, old, old);
    return file;
  };
  const ended = ['free-5.task.json', 'free-5.access.json', 'claude-free-5.log', 'event-3.task.json'].map(name => write(name, true));
  const kept = [write('free-7.access.json', true), write('free-9.task.json', false), write('manual-Claude.access.json', true)];
  const removed = sweep_service_home(home);
  assert.equal(removed.execution_files, ended.length);
  for (const file of ended) assert.ok(!existsSync(file), `${file} is removed`);
  for (const file of kept) assert.ok(existsSync(file), `${file} is kept`);
  assert.ok(existsSync(join(config.directory, 'runtime.sqlite3')));
});

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

test('the same site and room cannot be registered twice', t => {
  const home = mkdtempSync(join(tmpdir(), 'discussion-service-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  register_room(home, room_config(home, 'http://127.0.0.1:8765', 'room1', 'a'));
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

test('a restarted service takes variables saved after its terminal opened, keeping the inherited PATH', () => {
  const terminal = { Path: 'bin', CLAUDE_CODE_OAUTH_TOKEN: 'stale', HOME: 'h' };
  const env = persisted_env(terminal, () => ({ claude_code_oauth_token: 'switched', PATH: 'other', OPENAI_API_KEY: 'k' }));
  assert.deepEqual(env, { Path: 'bin', HOME: 'h', claude_code_oauth_token: 'switched', OPENAI_API_KEY: 'k' });
  assert.deepEqual(persisted_env(terminal, () => ({})), terminal);
});

test('a Claude CLI launched from a hosting Claude session drops host variables and keeps its own login', () => {
  const host = { CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'claude-desktop', CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH: '1', PATH: 'bin' };
  const env = standalone_claude_env(host, () => ({ CLAUDE_CODE_OAUTH_TOKEN: 'persisted' }));
  assert.deepEqual(env, { PATH: 'bin', CLAUDE_CODE_OAUTH_TOKEN: 'persisted' });
  // A token switched after the runner started wins over the stale one it inherited.
  const plain = { PATH: 'bin', CLAUDE_CODE_OAUTH_TOKEN: 'stale' };
  assert.deepEqual(standalone_claude_env(plain, () => ({ CLAUDE_CODE_OAUTH_TOKEN: 'switched' })), { PATH: 'bin', CLAUDE_CODE_OAUTH_TOKEN: 'switched' });
  assert.deepEqual(standalone_claude_env(plain, () => ({})), plain);
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
      if (body?.action === 'resume') execution.paused_at = 0;
      if (body?.action === 'retry_wait') execution.retry = { attempt: body.attempt, retry_at: body.retry_at, reason: body.reason, stopped: 0 };
      if (body?.action === 'retry_start') execution.retry.retry_at = 0;
      if (body?.action === 'segments') { (state.segments ||= []).push(body.segments); if (body.notes) (state.notes ||= []).push(body.notes); }
      result = execution;
    } else if (url.startsWith('/messages?after=')) {
      if (state.fail_messages) { response.writeHead(503, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: 'context unavailable' })); return; }
      // Like the website: one page of at most 20 messages after the cursor.
      const after = Number(url.split('=')[1]);
      result = { messages: (state.messages || []).filter(item => item.id > after).slice(0, 20) };
    } else if (url === '/messages' && request.method === 'POST') {
      // Like the website: an answer bound to a live execution completes it.
      (state.posts ||= []).push({ body, token: request.headers['x-discussion-token'] });
      const answered = state.executions.find(item => item.id === body.execution_id);
      if (answered) answered.status = 'completed';
      result = { message: { id: 99, ...body }, duplicate: false };
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
    } else if (url.startsWith('/sequences/') && request.method === 'GET') result = state.sequence;
    else if (url === '/sequences/continue') {
      (state.sequence_posts ||= []).push(body);
      state.pending = state.pending.filter(item => item.sequence?.phase !== 'checkpoint');
      result = { pass: 2, duplicate: false, execution_completed: false };
    } else if (url === '/goal' && request.method === 'POST') {
      (state.goal_posts ||= []).push(body);
      result = { goal: { status: 'active', continues: 1, idle: false }, revision: 'goal-r2' };
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

test('an idle goal wakes the host only after the room stays unchanged for the grace period', async t => {
  const f = await free_fixture(t);
  f.state.pending = [];
  f.state.room.goal_state = { goal: { id: 1, status: 'active', idle: true }, revision: 'goal-r1' };
  const runner = new FreeRoomRunner({ ...f.config, goal_idle_ms: 80 }, f.store, async () => ({ status: 'accepted' }));
  await runner.tick();
  assert.equal(runner.idle(), false, 'the service keeps ticking while the grace period runs');
  f.state.room.goal_state = { ...f.state.room.goal_state, revision: 'goal-r1b' };
  await delay(100);
  await runner.tick();
  assert.equal(f.state.goal_posts, undefined, 'a changed room restarts the grace period');
  await delay(100);
  await runner.tick();
  assert.deepEqual(f.state.goal_posts, [{ action: 'continue', revision: 'goal-r1b' }]);
  f.state.room.goal_state = { goal: { id: 1, status: 'active', idle: false }, revision: 'goal-r2' };
  await runner.tick();
  assert.equal(runner.idle(), true);
});

for (const [answer, posted] of [[{ choice: 'wait', probabilities: { wait: 0.9, continue: 0.1 } }, 'wait'],
  [{ choice: 'wait', probabilities: { wait: 0.6, continue: 0.4 } }, 'continue']]) {
  test(`an idle goal asks the decision model and ${posted === 'wait' ? 'stands down when sure the user is awaited' : 'wakes the host when unsure'}`, async t => {
    const f = await free_fixture(t);
    f.config = { ...with_scheduler(f.config), goal_idle_ms: 0 };
    f.state.pending = [];
    f.state.messages = [{ id: 11, author: 'Codex', text: '前四项已修复。要不要继续修后四项，请你决定。' }];
    f.state.room.latest_id = 11;
    f.state.room.goal_state = { goal: { id: 1, status: 'active', idle: true, armed: 1, objective: '修完 8 项问题' }, revision: 'goal-r1' };
    const runner = new FreeRoomRunner(f.config, f.store, async () => ({ status: 'accepted' }), () => {},
      scheduler_fetch({ wake: { type: 'choice', confidence: 0.5, ...answer } }));
    await runner.tick();
    await runner.tick();
    assert.deepEqual(f.state.goal_posts, [{ action: posted, revision: 'goal-r1' }]);
    assert.equal(f.state.decisions.length, 1);
    assert.equal(f.state.decisions[0].after_message_id, 11);
    assert.equal(f.state.decisions[0].context.scene, 'goal');
  });
}

test('a goal the host declared pending skips the decision model and reaches Weixin once after the delay', async t => {
  const f = await free_fixture(t);
  f.config = { ...with_scheduler(f.config), goal_idle_ms: 0 };
  f.state.pending = [];
  const since = Math.floor(Date.now() / 1000);
  const goal = { id: 1, status: 'active', idle: false, armed: 1, objective: '修完 8 项问题', phase: 'pending', phase_note: '选 A 还是 B？', phase_since: since };
  f.state.room.goal_state = { goal, revision: 'goal-r1' };
  const sent = [];
  let model_called = false;
  const runner = new FreeRoomRunner(f.config, f.store, async () => ({ status: 'accepted' }), () => {}, async () => { model_called = true; return { ok: false }; });
  runner.notifier = { ready: () => true, sent: key => sent.some(item => item.key === key), send: async notice => { sent.push(notice); return { status: 'sent', number: 1 }; } };
  await runner.tick();
  assert.equal(sent.length, 0, 'the owner may still be typing');
  assert.equal(runner.idle(), false, 'the service keeps ticking until the notice is due');
  f.state.room.goal_state = { goal: { ...goal, phase_since: since - 301, idle: true }, revision: 'goal-r2' };
  await runner.tick();
  await runner.tick();
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].paragraphs.slice(0, 2), ['主持人在等你确认：', '选 A 还是 B？']);
  assert.equal(sent[0].room.room, 'room');
  assert.deepEqual(f.state.goal_posts, [{ action: 'continue', revision: 'goal-r2' }], 'an expired pending wakes the host without asking the model');
  assert.equal(model_called, false);
});

test('a pending goal without the host note (set by the decision model) quotes the latest message on Weixin', async t => {
  const f = await free_fixture(t);
  f.state.pending = [];
  f.state.messages = [{ id: 11, author: 'Codex', text: '前四项已修复。要不要继续修后四项，请你决定。' }, { id: 12, author: '系统', text: 'Goal 续跑 #1' }];
  f.state.room.latest_id = 12;
  f.state.room.goal_state = { goal: { id: 1, status: 'active', idle: false, objective: '修完 8 项问题', phase: 'pending', phase_note: '',
    phase_since: Math.floor(Date.now() / 1000) - 301 }, revision: 'goal-r1' };
  const sent = [];
  const runner = new FreeRoomRunner(f.config, f.store, async () => ({ status: 'accepted' }));
  runner.notifier = { ready: () => true, sent: () => false, send: async notice => { sent.push(notice); return { status: 'sent', number: 1 }; } };
  await runner.tick();
  assert.deepEqual(sent[0].paragraphs.slice(0, 2), ['房间在等你回复。最近一条是 Codex 说：', '前四项已修复。要不要继续修后四项，请你决定。']);
});

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
    plan: { reviewer_name: 'Codex-review', scope: '核对实现' },
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

/** A loop waiting at its checkpoint: the reviewer's answer is the last of the pass. */
async function loop_runner_fixture(t, last = '硬伤两条，必须改后再审。') {
  const f = await free_fixture(t);
  f.config = with_scheduler(f.config);
  f.state.claude_role = 'host';
  f.state.pending = [{ id: 1, message_id: 12, purpose: 'handoff', sequence: { id: 3, phase: 'checkpoint', pass: 1, answer_id: 13 } }];
  f.state.sequence = { id: 3, status: 'checkpoint', handoff_status: 'pending', remaining_rounds: 3, order: ['Antigravity', 'Codex'], pass: 1,
    origin: { id: 11, author: 'Claude', text: '写手写完交批评家审，按意见循环修改' },
    answers: [{ member: 'Antigravity', text: '已写完并保存。' }, { member: 'Codex', text: last }] };
  return f;
}

for (const [probability, scheduled] of [[0.85, true], [0.849, true], [0.99, false]]) {
  test(`a loop checkpoint ${scheduled ? `goes on only at 0.85 (${probability})` : 'wakes the host without smart scheduling'}`, async t => {
    const { state, config, store } = await loop_runner_fixture(t);
    if (!scheduled) delete config.scheduler;
    let seen;
    const runner = new FreeRoomRunner(config, store, async () => ({ status: 'accepted' }), () => {}, async (url, init) => {
      seen = JSON.parse(init.body);
      return scheduler_fetch({ checkpoint: { type: 'choice', choice: 'continue', probabilities: { continue: probability } } })();
    });
    await runner.tick(); await Promise.all(runner.decisions);
    const goes_on = scheduled && probability >= 0.85;
    assert.deepEqual(state.sequence_posts || [], goes_on ? [{ actor: 'Claude', request_id: 1 }] : []);
    if (!scheduled) { assert.equal(seen, undefined); assert.equal(state.executions.length, 1, 'the host decides at the checkpoint'); return; }
    assert.equal(JSON.parse(seen.state).answers[1].text, state.sequence.answers[1].text);
    assert.deepEqual([state.decisions[0].context.scene, state.decisions[0].after_message_id, state.decisions[0].applied], ['sequence', 13, goes_on]);
    await runner.tick(); await Promise.all(runner.decisions);
    assert.equal(state.executions.length, goes_on ? 0 : 1, goes_on ? 'the next pass needs no host' : 'an unsure checkpoint goes to the host');
  });
}

test('the session driver schedules an opening, relays a mid-round answer, then starts and continues round two', async t => {
  const f = await free_fixture(t);
  const config = with_scheduler(f.config);
  f.state.messages = [{ id: 20, author: 'Codex', text: '开场观点' }];
  const driver = new SessionDriver(config, () => {}, scheduler_fetch({
    speaker: { type: 'choice', choice: 'Codex', confidence: 0.9, probabilities: {} },
  }));
  const session = { id: 7, status: 'active', goal: '比较方案', phase: 'initial', named_followup: false };
  const roster = { round: 1, waiting: ['Codex', 'Antigravity'], experts: [
    { name: 'Claude', host: true }, { name: 'Codex', host: false, registered: true }, { name: 'Antigravity', host: false, registered: true },
  ] };
  const room = { latest_id: 20, title: '房间', host: 'Claude' };
  const first = await driver.plan(session, roster, [], { cause_kind: 'round_complete' }, room);
  assert.equal(first.turn.question, '请先独立阅读议题，给出你的开场观点。');

  const first_round_turns = [
    { round: 1, expert: 'Codex', status: 'answered', answer_id: 20 },
    { round: 1, expert: 'Antigravity', status: 'answered', answer_id: 21 },
  ];
  const second_driver = new SessionDriver(config, () => {}, scheduler_fetch({
    speaker: { type: 'choice', choice: 'Antigravity', confidence: 0.9, probabilities: {} },
  }));
  const active_session = { ...session, phase: 'discussion' };
  const midround = await second_driver.plan(active_session, { ...roster, waiting: ['Antigravity'] }, [first_round_turns[0]],
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
    speaker: { type: 'choice', choice: 'Antigravity', confidence: 0.9, probabilities: {} },
  }));
  const round_two_next = await round_two_driver.plan(active_session, { ...roster, round: 2, waiting: ['Antigravity'] },
    [...first_round_turns, { round: 2, expert: 'Codex', status: 'answered', answer_id: 22 }],
    { cause_kind: 'speaker_answered' }, room);
  assert.match(round_two_next.turn.question, /第 2 轮/);
});

test('session scheduler failures and reached limits leave progression with the host without ordinary routing', async t => {
  const { state, store, config } = await free_fixture(t);
  Object.assign(config, with_scheduler(config));
  state.session = { id: 7, status: 'active', goal: '目标', phase: 'discussion', named_followup: false };
  state.room.phase = 'discussion';
  state.room.session = state.session;
  state.pending = [{ id: 9, purpose: 'discuss_host', session_id: 7, cause_kind: 'speaker_answered' }];
  state.roster = { revision: 'r1', round: 1, waiting: ['Antigravity'], experts: [{ name: 'Antigravity', host: false, spoken: false, registered: true }] };
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
  state.roster = { revision: 'r1', round: 1, waiting: ['Antigravity'], experts: [{ name: 'Antigravity', host: false, spoken: false, registered: true }] };
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
  state.roster = { revision: 'r1', round: 1, waiting: ['Antigravity'], experts: [{ name: 'Antigravity', host: false, spoken: false, registered: true }] };
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
    speaker: { type: 'choice', choice: 'Antigravity', confidence: 0.9, probabilities: {} },
  } }) }));
  await driver.tick(state.room, { archived: false, members: [{ name: 'Claude', role: 'host', pending: state.pending }], executions: [] });
  assert.equal(state.plans?.length || 0, 0);
});

for (const outcome of ['accepted', 'cancelled', 'expired']) test(`free Sidecar delivery checks executions and reconciles ${outcome} without resending`, async t => {
  const { state, store, config } = await free_fixture(t);
  config.participants.Claude = { adapter: 'antigravity', ipc_directory: config.directory };
  writeFileSync(join(config.directory, 'ready.json'), JSON.stringify({ pid: process.pid }));
  const runner = new FreeRoomRunner(config, store);
  await runner.tick();
  const request = JSON.parse(readFileSync(join(config.directory, 'free-1.request.json'), 'utf8'));
  assert.equal(request.event_id, 1);
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

test('with smart scheduling configured, @全体成员 still answers at once without asking the model', async t => {
  const { state, config, store } = await group_fixture(t);
  const runner = new FreeRoomRunner(config, store, async () => ({ status: 'accepted' }), () => {}, async () => assert.fail('@全体成员 must not be judged'));
  await runner.tick();
  await Promise.all(runner.decisions);
  assert.deepEqual(state.group_posts.map(item => [item.action, item.revision]), [['all', 'group-r1']]);
  assert.equal(state.calls.some(call => call === 'POST /scheduler-routing'), false);
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

test('edit tool events name the files an agent wrote, so concurrent snapshots are not blamed on it', () => {
  const claude_event = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: String.raw`D:\proj\剧本\库存.yaml` } },
    { type: 'tool_use', name: 'Read', input: { file_path: String.raw`D:\proj\other.md` } }] } };
  const codex_event = { type: 'item.completed', item: { type: 'file_change', changes: [{ path: '/proj/剧本/成长.yaml', kind: 'update' }] } };
  assert.deepEqual(adapter_of('claude').events.edits(claude_event), [String.raw`D:\proj\剧本\库存.yaml`]);
  assert.deepEqual(adapter_of('codex_cli').events.edits(codex_event), ['/proj/剧本/成长.yaml']);
  const changes = ['剧本/库存.yaml', '剧本/成长.yaml', '剧本/第06集.md'];
  assert.deepEqual(edited_changes(changes, adapter_of('claude').events.edits(claude_event), 'win32'), ['剧本/库存.yaml']);
  assert.deepEqual(edited_changes(changes, adapter_of('codex_cli').events.edits(codex_event), 'linux'), ['剧本/成长.yaml']);
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

test('a member whose operations were refused is not captured, even when its session ends plainly', async t => {
  const { state, store, config } = await free_fixture(t);
  const runner = new FreeRoomRunner(config, store, async (adapter, binding, task) => {
    setImmediate(() => { task.on_activity('writing'); task.on_note('还差一步'); task.on_denials([{ tool: 'Bash', input: 'rm -rf x' }]); task.on_exit(); });
    return { status: 'accepted' };
  });
  await runner.tick();
  await runner.tick();
  assert.equal(state.executions[0].status, 'failed');
  assert.equal(state.posts, undefined);
});

test('a member that worked and ended without submitting has its last remark captured as the answer', async t => {
  const { state, store, config } = await free_fixture(t);
  const runner = new FreeRoomRunner(config, store, async (adapter, binding, task) => {
    setImmediate(() => { task.on_note('还没开始'); task.on_activity('writing'); task.on_note('中途说明'); task.on_note('  最终答复  '); task.on_exit(); });
    return { status: 'accepted' };
  });
  await runner.tick();
  await runner.tick();
  assert.equal(state.executions[0].status, 'completed');
  assert.ok(!state.calls.includes('POST /executions/1 fail'));
  assert.equal(state.posts.length, 1);
  const { body, token } = state.posts[0];
  assert.deepEqual([body.text, body.source, body.execution_id, body.author, body.kind], ['最终答复', 'auto', 1, 'Claude', 'chat']);
  assert.equal(token, config.members.Claude.token, 'captured under the member, not the owner');
  assert.equal(body.to, undefined);
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
  const agy = { cli: 'codiscuss', messages: '#3', task_path: 'free-7.task.json', name: 'Antigravity', profile: { adapter: 'antigravity_cli', project_access: 'write', cwd: 'D:/project' } };
  assert.match(free_task_text(agy).instructions, /关键转折处用一句话写出进展再继续/);
  assert.doesNotMatch(free_task_text({ ...agy, profile: { adapter: 'claude', project_access: 'read' } }).instructions, /写出进展/);
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

test('a paused free execution stops its turn, waits, and resumes the same execution in its session with the owner words', async t => {
  const { state, store, config } = await free_fixture(t);
  const tasks = [];
  const runner = new FreeRoomRunner(config, store, async (adapter, binding, task) => {
    const child = Object.assign(new EventEmitter(), { killed: false, kill() { this.killed = true; this.emit('close'); } });
    tasks.push({ task, child, session: binding.session_id });
    task.on_process(child);
    return { status: 'accepted', session_id: 'session-1' };
  });
  await runner.tick();
  state.executions[0].paused_at = 1;
  await runner.tick();
  assert.equal(tasks[0].child.killed, true, 'a pause stops the software turn');
  tasks[0].task.on_failure('Claude 退出码 null');
  tasks[0].task.on_exit();
  await runner.tick();
  assert.equal(state.executions[0].status, 'dispatched', 'the stopped turn does not end the execution');
  assert.equal(tasks.length, 1, 'it waits for the owner words');
  state.executions[0].interjections = [{ id: 5, text: '改用第三人称' }];
  await runner.tick();
  assert.equal(tasks.length, 2);
  assert.equal(tasks[1].session, 'session-1', 'the same session goes on');
  assert.match(tasks[1].task.prompt, /执行 #1[\s\S]*改用第三人称/);
  assert.equal(state.executions[0].paused_at, 0);
  assert.ok(state.calls.includes('POST /executions/1 interjection'));
  // The stopped turn reporting late cannot fail the resumed one.
  tasks[0].task.on_failure('late');
  tasks[0].task.on_exit();
  await runner.tick();
  assert.equal(state.executions[0].status, 'dispatched');
  assert.ok(!state.calls.includes('POST /executions/1 fail'));
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

test('two instances of one platform keep separate sessions and credentials', async t => {
  const { state, store, config } = await free_fixture(t);
  config.participants['Claude-review'] = { adapter: 'claude', model: 'opus' };
  config.members['Claude-review'] = { token: 'reviewer-credential'.repeat(2) };
  state.others.push({ id: 8, name: 'Claude-review', pending: [{ id: 3, message_id: 11 }] });
  const sessions = { Claude: 'session-main', 'Claude-review': 'session-review' };
  const delivered = [];
  const runner = new FreeRoomRunner(config, store, async (adapter, binding, task) => {
    delivered.push([task.participant, adapter.model || '', binding.session_id || '']);
    return { status: 'accepted', session_id: sessions[task.participant] };
  });
  await runner.tick();
  assert.deepEqual(delivered, [['Claude', '', ''], ['Claude-review', 'opus', '']]);
  assert.equal(store.binding('Claude').session_id, 'session-main');
  assert.equal(store.binding('Claude-review').session_id, 'session-review');
  assert.equal(JSON.parse(readFileSync(join(config.directory, 'free-2.access.json'), 'utf8')).token, config.members['Claude-review'].token);
});

test('codiscuss token writes only its hash through wrangler and no password is kept on this computer', async () => {
  const { create_admin_token, remove_legacy_admin_accounts } = await import('../runner/admin_account.mjs');
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
    mkdirSync(home);
    // An older version's plain-text password file is deleted at service start.
    writeFileSync(join(home, 'admin-accounts.json'), JSON.stringify({ sites: { 'https://example.pages.dev': { username: 'Admin', password: 'Admin123456.' } } }));
    assert.equal(remove_legacy_admin_accounts(home), true);
    assert.equal(existsSync(join(home, 'admin-accounts.json')), false);
    assert.equal(remove_legacy_admin_accounts(home), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('execution details rebuild each CLI log in order, a result filling in its call, and none for an adapter without a log', () => {
  const lines = (...events) => events.map(event => JSON.stringify(event)).join('\n');
  const codex = execution_details('codex_cli', lines(
    { type: 'item.completed', item: { id: 'e', type: 'error', message: 'config warning' } },
    { type: 'item.completed', item: { id: '1', type: 'agent_message', text: '先读任务文件' } },
    { type: 'item.started', item: { id: '2', type: 'command_execution', command: '"C:\pwsh.exe" -Command "rg x"', status: 'in_progress' } },
    { type: 'item.completed', item: { id: '2', type: 'command_execution', command: '"C:\pwsh.exe" -Command "rg x"', aggregated_output: 'hit', exit_code: 1, status: 'failed' } },
    { type: 'item.completed', item: { id: '3', type: 'web_search', query: '南半球 七月' } }));
  assert.deepEqual(codex.entries.map(entry => [entry.kind, entry.title, entry.body, entry.state]), [
    ['message', undefined, '先读任务文件', undefined], ['command', 'rg x', 'hit', 'failed'], ['search', '南半球 七月', undefined, 'done']]);
  const claude = execution_details('claude', lines(
    { type: 'assistant', timestamp: '2026-11-07T12:00:00.000Z', message: { content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'tool_use', id: 't', name: 'Bash', input: { command: 'ls' } }] } },
    { type: 'user', timestamp: '2026-11-07T12:00:12.000Z', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: 'a.md' }] }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: '完成' }] } }));
  assert.deepEqual(claude.entries.map(entry => [entry.kind, entry.title, entry.body, entry.state]), [['command', 'ls', 'a.md', 'done'], ['message', undefined, '完成', undefined]]);
  assert.deepEqual([claude.entries[0].at, claude.entries[0].ended_at], ['2026-11-07T12:00:00.000Z', '2026-11-07T12:00:12.000Z'], 'a step keeps when it started and ended');
  const agy = execution_details('antigravity_cli', lines(
    { event: 'step_update', step_update: { step_index: 1, step_type: 'agent_response', state: 'ACTIVE', text_delta: '正在' } },
    { event: 'step_update', step_update: { step_index: 1, step_type: 'agent_response', state: 'ACTIVE', text_delta: '读取' } },
    { event: 'step_update', step_update: { step_index: 2, step_type: 'tool', state: 'ACTIVE', tool_name: 'run_command', tool_info: { parameters: { CommandLine: 'dir' } } } },
    { event: 'step_update', step_update: { step_index: 2, step_type: 'tool', state: 'DONE', tool_name: 'run_command', tool_info: { parameters: { CommandLine: 'dir' }, output: 'ok' } } }));
  assert.deepEqual(agy.entries.map(entry => [entry.kind, entry.title, entry.body, entry.state]), [['message', undefined, '正在读取', undefined], ['command', 'dir', 'ok', 'done']]);
  assert.equal(execution_details('no_such_adapter', '{}'), null);
});

test('a private chat line runs as a turn of the idle member session and reports its last remark as the reply', async t => {
  const f = await fixture(t);
  f.member.pending = [];
  f.member.chats = [{ id: 5, text: '先说结论', status: 'pending' }];
  f.config.participants.Codex = { adapter: 'codex_cli', executable: process.execPath };
  f.store.bind('Codex', 'room-session');
  const process_fixture = fake_cli([{ type: 'thread.started', thread_id: 'room-session' },
    { type: 'item.completed', item: { id: '1', type: 'agent_message', text: '先读一下' } },
    { type: 'item.completed', item: { id: '2', type: 'agent_message', text: '结论：可以发。' } }, { type: 'turn.completed' }]);
  const deliver = (config, binding, task) => deliver_task(config, binding, task, process_fixture.spawn_process, join(f.config.directory, 'user'));
  await new FreeRoomRunner(f.config, f.store, deliver).tick();
  await process_fixture.calls[0].closed;
  for (let wait = 0; !f.calls.includes('chat:reply') && wait < 100; wait++) await delay(20);
  assert.deepEqual(f.calls.filter(call => call.startsWith('chat:')), ['chat:start', 'chat:reply']);
  assert.equal(f.member.chats[0].reply, '结论：可以发。');
  const task = JSON.parse(process_fixture.calls[0].input);
  assert.equal(task.thread_id, 'room-session', 'the line runs in the member session of the room');
  assert.match(task.prompt, /私聊[\s\S]*先说结论$/);
  assert.equal(f.executions.size, 0, 'a private chat is not a room execution');
});

test('an Antigravity Sidecar quits once a newer one takes its directory or the App server that started it exits', async t => {
  const sidecar = fileURLToPath(new URL('../runner/adapters/antigravity_sidecar.mjs', import.meta.url));
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const ready_pid = async directory => {
    for (let wait = 0; wait < 200; wait++) {
      try { return JSON.parse(readFileSync(join(directory, 'ready.json'), 'utf8')).pid; } catch { await delay(25); }
    }
    throw new Error('the Sidecar never wrote ready.json');
  };
  const gone = async pid => { for (let wait = 0; wait < 200 && alive(pid); wait++) await delay(25); return !alive(pid); };
  const env = directory => ({ ...process.env, ANTIGRAVITY_AGENTAPI_EXE: process.execPath, CODISCUSS_IPC_DIRECTORY: directory });
  // A newer Sidecar rewrites ready.json with its own pid.
  const replaced = mkdtempSync(join(tmpdir(), 'sidecar-replaced-'));
  t.after(() => rmSync(replaced, { recursive: true, force: true }));
  const first = spawn(process.execPath, [sidecar], { env: env(replaced), stdio: 'ignore', windowsHide: true });
  t.after(() => first.kill());
  const pid = await ready_pid(replaced);
  assert.equal(alive(pid), true);
  writeFileSync(join(replaced, 'ready.json'), JSON.stringify({ pid: pid + 1 }));
  assert.equal(await gone(pid), true, 'the replaced Sidecar stops');
  // The App server that started it exits, leaving the Sidecar behind.
  const orphaned = mkdtempSync(join(tmpdir(), 'sidecar-orphaned-'));
  t.after(() => rmSync(orphaned, { recursive: true, force: true }));
  const parent = spawn(process.execPath, ['-e', `require('node:child_process').spawn(process.execPath, [${JSON.stringify(sidecar)}],
    { stdio: 'ignore', windowsHide: true, detached: true }).unref(); setTimeout(() => process.exit(0), 300);`], { env: env(orphaned), stdio: 'ignore', windowsHide: true });
  const orphan = await ready_pid(orphaned);
  await once(parent, 'exit');
  assert.equal(await gone(orphan), true, 'the orphaned Sidecar stops');
});

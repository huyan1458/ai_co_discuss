import assert from 'node:assert/strict';
import { room_text, room_payload } from '../runner/room_text.mjs';

test('room-owned reasons carry source templates while replies and truncated text retain original content', () => {
  const reason = room_text('投递失败：{detail}', { detail: 'external error 原文' });
  assert.equal(reason, '投递失败：external error 原文');
  assert.deepEqual(room_payload({ action: 'fail', reason }), { action: 'fail', reason,
    reason_text: { template: '投递失败：{detail}', params: { detail: 'external error 原文' } } });
  assert.deepEqual(room_payload({ text: reason }), { text: reason });
  assert.deepEqual(room_payload({ reason: reason.slice(0, 4) }), { reason: reason.slice(0, 4) });
});
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readdirSync, rmSync, existsSync, readFileSync, symlinkSync, utimesSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { test } from 'node:test';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { listen_local } from './local_port.mjs';
import { DiscussionStore, load_config, service_drafts, validate_config } from '../runner/discussion_runner.mjs';
import { slash_insertion } from '../runner/slash_names.mjs';
import { cwd_key, edited_changes, expert_prompt_delivery, free_task_files, FreeRoomRunner, process_started, named_workflows, request_attachments, member_drafts, member_extra_directories, member_folders, review_capability_version, room_goal, workspace_snapshot } from '../runner/free_runner.mjs';
import { SessionDriver } from '../runner/session_driver.mjs';
import { capture_base } from '../runner/file_diff.mjs';

import { EXPERT_PROMPT_PRESETS, expert_prompt, free_task_text, software_rules } from '../runner/expert_prompts.mjs';
import { participant_tools, system_prompt } from '../runner/adapters/api.mjs';
import { pi_provider } from '../runner/adapters/api_pi.mjs';
import { glob_regex, open_project, run_file_tool } from '../runner/adapters/api_files.mjs';
import { DiscussionService, migrate_platform_ids, migrate_service_home, persisted_env, read_registry, register_room, remove_room_files, service_pid, service_ready, start_service, sweep_service_home, unregister_room } from '../runner/discussion_service.mjs';
import { restore_room, room_profiles, save_launch_settings } from '../runner/discussion_launch.mjs';
import { adapter_of, capabilities_of, deliver_task, execution_details } from '../runner/adapters/index.mjs';
import { inherited_access, NO_DESKTOP_VARIABLE } from '../runner/adapters/profiles.mjs';

test('a new host takes over the previous host access only as far as its own software offers, and never loses any', () => {
  const take = (adapter, project_access, from_adapter, from_access) =>
    inherited_access({ adapter, project_access }, { adapter: from_adapter, project_access: from_access });
  assert.equal(take('claude', 'read', 'claude', 'full'), 'full');
  // agy offers no 自动 and an API member nothing above 可写: each lands on the nearest level beneath.
  assert.equal(take('antigravity_cli', 'read', 'claude', 'auto'), 'write');
  assert.equal(take('api', 'read', 'codex_cli', 'full'), 'write');
  assert.equal(take('claude', 'full', 'claude', 'read'), 'full', 'a lower previous host lowers nothing');
  // Access the runner does not set is neither given nor taken: an App, a taken-over session.
  assert.equal(take('codex', 'read', 'claude', 'full'), 'read');
  assert.equal(take('claude', 'read', 'codex', 'full'), 'read');
  assert.equal(take('claude', 'own', 'claude', 'full'), 'own');
  assert.equal(take('claude', 'read', 'claude', 'own'), 'read');
});
import { read_only_enforced } from '../runner/project_files.mjs';
import { adopted_fork, claude_api_error, claude_input, claude_permissions, claude_exit_error, claude_inbox_ready, claude_rule_path, standalone_claude_env, watch_window_turn } from '../runner/adapters/claude.mjs';
import { codex_developer_instructions, codex_permissions, codex_sandbox_missing, codex_sandbox_refusal } from '../runner/adapters/codex_cli.mjs';
import { agy_rule, prepare_agy_project, remove_agy_projects, sweep_legacy_agy_projects } from '../runner/adapters/antigravity_cli.mjs';
import { kill_process_tree, run_program, shell_written_paths, TASK_SUBCOMMANDS, watch_events } from '../runner/adapters/common.mjs';

// The service and setup install Pi from npm unless one is given; tests never download it.
process.env.CODISCUSS_PI_CLI ??= 'pi-not-needed-in-this-test';
// Codex's permission tests must not depend on whether this computer's own Codex has a Windows sandbox set up.
const codex_test_home = mkdtempSync(join(tmpdir(), 'codex-home-'));
writeFileSync(join(codex_test_home, 'config.toml'), '[windows]\nsandbox = "elevated"\n');
process.env.CODEX_HOME = codex_test_home;
process.on('exit', () => rmSync(codex_test_home, { recursive: true, force: true }));
const activity_phase = (adapter, event) => adapter_of(adapter).events.phase(event);
import { save_api_key, saved_api_keys } from '../runner/discussion_api.mjs';
import { certainty, decide, decide_interjection, decide_next_speaker, decide_round, ROUTE_CONFIDENCE, ROUTE_WIDE_CONFIDENCE, route_free_message, scheduler_answers, scheduler_check, scheduler_request, SCHEDULER_PROVIDERS, scheduler_state, validate_scheduler } from '../runner/scheduler.mjs';
import { site_fetch } from '../runner/entry_client.mjs';

// Assertions read Chinese CLI output; the run must not depend on this computer's system locale.
process.env.CODISCUSS_LANG = 'zh-CN';

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
  const limits = { member: ROUTE_CONFIDENCE, wide: ROUTE_WIDE_CONFIDENCE };
  const routed = await route_free_message(home, jev, input, reply('Codex', 0.95));
  assert.deepEqual([routed.action, routed.member, routed.detail[0].choices], ['member', 'Codex', ['Codex', '__host__', '__all__', '__all_seq__', '__none__']]);
  assert.equal((await route_free_message(home, jev, input, reply('Codex', limits.member - 0.01))).action, 'host');
  assert.equal((await route_free_message(home, jev, input, reply('Codex', limits.member))).action, 'member');
  assert.equal((await route_free_message(home, jev, input, reply('__host__', 0.99))).action, 'host');
  assert.equal((await route_free_message(home, jev, input, reply('__all__', limits.wide))).action, 'all');
  assert.equal((await route_free_message(home, jev, input, reply('__all__', limits.wide - 0.01))).action, 'host');
  assert.equal((await route_free_message(home, jev, input, reply('__none__', 0.99))).action, 'none');
  // Everyone in turn is a choice with the wide threshold.
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
  // The state describes the room and each member; options say what each choice leads to.
  let sent_to_model;
  await route_free_message(home, jev, input, async (url, init) => { sent_to_model = JSON.parse(init.body); return reply('__host__', 0.99)(); });
  assert.match(sent_to_model.state, /成员（名字不区分大小写）：\n- 主持人 Claude/);
  const route_question = sent_to_model.questions.handler;
  assert.match(route_question.instructions, /用户想让谁来回应/);
  assert.match(route_question.criteria.__all__, /彼此看不到对方的回答/);
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
  // One question, explaining that the host may have stopped on purpose.
  assert.deepEqual(Object.keys(asked[0].questions), ['speaker']);
  assert.match(asked[0].questions.speaker.instructions, /有意只安排到这里/);
  // The interjection sees who speaks next, so a question to that expert can wait for the turn.
  let upcoming_sent;
  await decide_interjection(home, jev, { ...interjection, upcoming: ['Antigravity', 'Codex'] }, async (url, init) => { upcoming_sent = JSON.parse(init.body); return handling('__note__', 0.9)(); });
  assert.match(upcoming_sent.state, /接下来按安排发言：Antigravity → Codex/);
});

/** A task or credential file of an execution, which sits in its member's own runtime folder. */
function runtime_file(directory, name) {
  return member_folders(directory).map(folder => join(folder, name)).find(path => existsSync(path)) || join(directory, name);
}

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

test('the occasional skill page is listed only when a request carries a relay or a question (coverage item 1)', () => {
  const config = { site: 'http://127.0.0.1:1', room: 'r', directory: mkdtempSync(join(tmpdir(), 'situations-')), project: resolve('.'),
    members: { Codex: { token: 'm'.repeat(32) } }, participants: { Codex: { adapter: 'codex' } } };
  const read = task => JSON.parse(readFileSync(task.task_path, 'utf8')).skills.map(path => path.split(sep).join('/'));
  const plain = free_task_files(config, { name: 'Codex', role: 'member' }, { id: 1, read_until: 0, requests: [{ id: 7, message_id: 9, purpose: 'ask' }] }, {}, {});
  assert.ok(!read(plain).some(path => path.endsWith('situations.md')));
  const relay = free_task_files(config, { name: 'Codex', role: 'member' }, { id: 2, read_until: 0,
    requests: [{ id: 8, message_id: 10, purpose: 'ask', sequence: { id: 3, step: 2, steps: 3 } }] }, {}, {});
  assert.ok(read(relay).some(path => path.endsWith('discuss-participant/references/situations.md')));
});

test("a read-only member's credential names the folders its codiscuss file arguments may use; a writable one has none", () => {
  const project = mkdtempSync(join(tmpdir(), 'scope-project-'));
  const config = { site: 'http://127.0.0.1:1', room: 'r', directory: mkdtempSync(join(tmpdir(), 'scope-')), project: resolve('.'),
    members: { Claude: { token: 'c'.repeat(32) } }, participants: { Claude: { adapter: 'claude', project_access: 'read', cwd: project } } };
  const access = task => JSON.parse(readFileSync(task.access_path, 'utf8'));
  const execution = id => ({ id, read_until: 0, requests: [{ id, message_id: 9, purpose: 'ask' }] });
  const scope = access(free_task_files(config, { name: 'Claude', role: 'member' }, execution(1), {}, {})).file_scope;
  assert.ok(scope.read.includes(project) && scope.read.some(path => path.endsWith(join('.agents', 'skills'))));
  assert.ok(!scope.write.includes(project), 'the read-only project is not a download target');
  config.participants.Claude.project_access = 'write';
  assert.equal(access(free_task_files(config, { name: 'Claude', role: 'member' }, execution(2), {}, {})).file_scope, undefined);
});

test('a workflow or sub-workflow the "/" menu inserts reaches the host task as named_workflows', () => {
  const home = mkdtempSync(join(tmpdir(), 'named-home-'));
  mkdirSync(join(home, 'workflows', 'story-serial'), { recursive: true });
  writeFileSync(join(home, 'workflows', 'story-serial', 'SKILL.md'), '---\nname: story-serial\n---\n');
  const config = { site: 'http://127.0.0.1:1', room: 'r', directory: mkdtempSync(join(tmpdir(), 'named-')), project: resolve('.'), api_home: home,
    members: { Host: { token: 'h'.repeat(32) } }, participants: { Host: { adapter: 'codex' } } };
  const task = request_texts => JSON.parse(readFileSync(free_task_files(config, { name: 'Host', role: 'host' },
    { id: 1, read_until: 0, requests: [{ id: 1, message_id: 1, purpose: 'ask' }] }, {}, { request_texts }).task_path, 'utf8'));
  // The page writes with slash_insertion and the runner reads with slash_names: the same module on both sides.
  const host = task([`${slash_insertion('story-serial')}写第一集，见 src/a、/tmp/x/y、\`/review\`\n> /quoted`]);
  assert.deepEqual(host.named_workflows, { workflows: ['story-serial'] });
  assert.ok(host.skills.some(path => path.split(sep).join('/').endsWith('discuss-host/references/workflow.md')));
  // Unknown "/" words, such as a member's skill, are left to the message.
  assert.equal(task(['@Codex /review 看下改动']).named_workflows, undefined);
  assert.deepEqual(named_workflows([slash_insertion('rehearsal')], { sub_workflows: ['rehearsal'], current: 'story-serial', in_library: () => true }),
    { sub_workflows: ['rehearsal'] });
});

test("the host's occasional pages are listed only when the task carries what they cover", () => {
  const config = { site: 'http://127.0.0.1:1', room: 'r', directory: mkdtempSync(join(tmpdir(), 'host-pages-')), project: resolve('.'),
    members: { Host: { token: 'h'.repeat(32) } }, participants: { Host: { adapter: 'codex' } } };
  const read = task => JSON.parse(readFileSync(task.task_path, 'utf8')).skills.map(path => path.split(sep).join('/'));
  const pages = ['relay.md', 'control.md', 'workflow.md', 'dev-flow.md'];
  const host = (id, request, options = {}) => read(free_task_files(config, { name: 'Host', role: 'host' },
    { id, read_until: 0, requests: [{ id, message_id: id, ...request }] }, {}, options)).filter(path => path.includes('discuss-host/references/'));
  const listed = (paths, page) => paths.some(path => path.endsWith(`discuss-host/references/${page}`));
  assert.ok(listed(host(1, { purpose: 'route' }), 'room.md'));
  assert.ok(listed(host(1, { purpose: 'route' }), 'members.md'), 'every room request brings the member guide');
  assert.ok(listed(host(2, { purpose: 'handoff', sequence: { id: 3, phase: 'checkpoint' } }), 'relay.md'));
  assert.ok(listed(host(3, { purpose: 'route', question: { id: 5, task: 'decide' } }), 'relay.md'));
  const linked_rooms = { parent: { room_id: 'parent' }, children: [] };
  assert.ok(listed(host(11, { purpose: 'ask' }, { linked_rooms }), 'control.md'));
  assert.deepEqual(JSON.parse(readFileSync(free_task_files(config, { name: 'Host', role: 'host' },
    { id: 11, read_until: 0, requests: [] }, {}, { linked_rooms }).task_path, 'utf8')).linked_rooms, linked_rooms);
  assert.ok(listed(host(4, { purpose: 'notice' }), 'control.md'));
  assert.ok(listed(host(5, { purpose: 'route' }, { reviews: [{ batch_id: 1 }] }), 'dev-flow.md'));
  assert.ok(pages.every(page => !listed(host(6, { purpose: 'route' }), page)));
  assert.ok(listed(host(7, { purpose: 'notice', question_needed: { sequence_id: 3 } }), 'relay.md'), 'the ask-for-a-question notice brings the relay page');
  // A hand-back where someone failed or was cancelled needs the recovery page; a clean one does not.
  assert.ok(listed(host(8, { purpose: 'handoff', outcome: [{ member: 'A', status: 'completed' }, { member: 'B', status: 'failed', reason: 'timeout' }] }), 'control.md'));
  assert.ok(listed(host(9, { purpose: 'handoff', outcome: [{ member: 'B', status: 'cancelled' }] }), 'control.md'));
  assert.ok(!listed(host(10, { purpose: 'handoff', outcome: [{ member: 'A', status: 'completed' }] }), 'control.md'));
});

test('a discussion host and a goal host get their occasional pages by what woke them', () => {
  const config = { site: 'http://127.0.0.1:1', room: 'r', directory: mkdtempSync(join(tmpdir(), 'mode-pages-')), project: resolve('.'),
    members: { Host: { token: 'h'.repeat(32) } }, participants: { Host: { adapter: 'codex' } } };
  const read = task => JSON.parse(readFileSync(task.task_path, 'utf8')).skills.map(path => path.split(sep).join('/'));
  const task = (id, request, options = {}) => read(free_task_files(config, { name: 'Host', role: 'host' },
    { id, read_until: 0, requests: [{ id, message_id: id, ...request }] }, {}, options));
  const pages = paths => paths.filter(path => /discuss-session\/references\/host-|discuss-goal\/references\//.test(path)).map(path => path.split('/').pop());
  const discuss = (id, cause_kind, options) => pages(task(id, { purpose: 'discuss_host', session_request_id: id, cause_kind }, options));
  assert.deepEqual(discuss(1, 'session_started'), ['host-opening.md']);
  assert.deepEqual(discuss(2, 'member_change'), ['host-roster.md']);
  assert.deepEqual(discuss(3, 'request_failed'), ['host-roster.md']);
  assert.deepEqual(discuss(4, 'round_complete'), ['host-closing.md']);
  assert.deepEqual(discuss(5, 'speaker_answered'), [], 'an everyday discussion task lists the default page only');
  assert.deepEqual(discuss(6, 'user_message', { room: { limits: { reached: true } } }), ['host-closing.md'], 'a reached limit brings the wrap-up page');
  assert.ok(task(5, { purpose: 'discuss_host', session_request_id: 5, cause_kind: 'speaker_answered' }).some(path => path.endsWith('discuss-session/references/host.md')));
  const goal = (id, purpose, status) => pages(task(id, { purpose }, { goal: { id: 1, status, objective: 'x' } }));
  assert.deepEqual(goal(7, 'goal_start', undefined), ['start.md']);
  assert.deepEqual(goal(8, 'goal_continue', 'active'), [], 'an everyday goal wake lists the goal skill only');
  assert.deepEqual(goal(9, 'goal_continue', 'budget_limited'), ['finish.md']);
  assert.deepEqual(goal(10, 'route', 'paused'), ['finish.md']);
  assert.deepEqual(pages(task(11, { purpose: 'route' })), [], 'a plain room request lists none of them');
});

test('woken messages bring their attachments: local copies by placeholder, images only to software that takes them', async t => {
  const image = Buffer.from('89504e470d0a1a0a', 'hex'), sha = data => createHash('sha256').update(data).digest('hex');
  const files = [{ id: 'a'.repeat(32), file_name: 'shot.png', content_type: 'image/png', size: image.length, sha256: sha(image) },
    { id: 'b'.repeat(32), file_name: 'notes.pdf', content_type: 'application/pdf', size: 3, sha256: sha('bad') }];
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://local');
    if (url.pathname.endsWith('/attachments')) return response.end(JSON.stringify({ attachments: url.searchParams.get('message_id') === '9' ? files : [] }));
    response.end(url.pathname.includes('a'.repeat(32)) ? image : Buffer.from('pdf'));
  });
  await listen_local(server);
  t.after(() => server.close());
  const { config } = task_fixture(t);
  config.site = `http://127.0.0.1:${server.address().port}`;
  // An API member's model reads images only when the owner says so on its card.
  config.participants = { Claude: { adapter: 'claude' }, Agy: { adapter: 'antigravity_cli' },
    Vision: { adapter: 'api', model: 'm', api_protocol: 'chat', image_input: 'image' }, Text: { adapter: 'api', model: 'm', api_protocol: 'chat' } };
  config.members = Object.fromEntries(Object.keys(config.participants).map(name => [name, { token: name[0].repeat(32) }]));
  const execution = { id: 4, read_until: 0, requests: [{ id: 1, message_id: 9, purpose: 'ask' }] };
  const attachments = await request_attachments(config, execution);
  assert.deepEqual(attachments.map(item => [item.placeholder, Boolean(item.path), Boolean(item.error)]), [['[图片 #1]', true, false], ['[文件 #2]', false, true]]);
  assert.deepEqual(readFileSync(attachments[0].path), image);
  const task = name => free_task_files(config, { name }, execution, {}, { attachments });
  const claude = task('Claude'), agy = task('Agy');
  assert.match(claude.prompt, /#9 \[图片 #1\] shot\.png：本机副本 .+shot\.png/);
  assert.match(claude.prompt, /#9 \[文件 #2\] notes\.pdf：未能取到本机副本.+attachment download/);
  assert.doesNotMatch(claude.prompt, /简单消息可跳过技能/);
  assert.deepEqual(claude.images.map(item => item.path), [attachments[0].path]);
  assert.deepEqual(agy.images, []);
  assert.equal(task('Vision').images.length, 1);
  assert.deepEqual(task('Text').images, []);
  assert.deepEqual(pi_provider(config.participants.Vision, 'https://api.test/v1').models[0].input, ['text', 'image']);
  assert.deepEqual(pi_provider(config.participants.Text, 'https://api.test/v1').models[0].input, ['text']);
  const content = JSON.parse(claude_input('看图', claude.images)).message.content;
  assert.deepEqual(content.map(block => block.type), ['text', 'image']);
  assert.equal(content[1].source.data, image.toString('base64'));
  assert.equal(JSON.parse(claude_input('看图', [{ ...claude.images[0], size: 4_000_000 }])).message.content.length, 1);
});

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
  // Pi has no approvals: 可写 already runs commands, so 自动 and 全放开 are refused.
  assert.throws(() => validate_config({ ...input, participants: { Grok: { ...input.participants.Grok, project_access: 'full' } } }, home), /没有需要软件审批的操作/);
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
  assert.deepEqual(tools(null), ['read_room', 'read_messages', 'read_message', 'read_execution', 'read_attachment', 'read_goal', 'web_fetch', 'read_question', 'ask_question', 'read_events', 'submit_chat']);
  assert.deepEqual(tools(reader), ['read_room', 'read_messages', 'read_message', 'read_execution', 'read_attachment', 'read_goal', 'read', 'glob', 'grep', 'git', 'web_fetch', 'read_question', 'ask_question', 'read_events', 'submit_chat']);
  assert.match(system_prompt({ participant: 'DeepSeek', role: 'member', project: reader }), /可用 read、glob、grep、git 工具只读本房间的项目目录/);

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
  // git reads history and changes; options that write, run programs or name a file through a revision are refused.
  for (const args of [['--output=leak.txt'], ['--ext-diff'], ['--no-index'], ['HEAD:.env'], ['-c', 'x']]) {
    assert.ok(run_file_tool(reader, 'git', { command: 'diff', args }).error, args.join(' '));
  }
  assert.ok(run_file_tool(reader, 'git', { command: 'push' }).error);
  assert.ok(run_file_tool(reader, 'git', { command: 'diff', paths: ['../outside.txt'] }).error);

  const writer = open_project({ cwd: project, project_access: 'write' }, [service]);
  assert.deepEqual(tools(writer).slice(-7), ['write', 'edit', 'web_fetch', 'read_question', 'ask_question', 'read_events', 'submit_chat']);
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
  const diagnostics_reports = [];
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
    else if (route === '/room-links') result = { links: [] };
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
        if (body.diagnostics) diagnostics_reports.push({ action: body.action, diagnostics: body.diagnostics });
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
  return { store, request, member, observers, room, calls, config, limits, failures, executions, add_request, finish_execution, diagnostics_reports,
    current_execution: () => [...executions.values()].at(-1) };
}

test('execution diagnostics distinguish adapter progress, a synthetic pulse, and a matching interjection receipt', async t => {
  const fixture_run = await fixture(t);
  let callbacks;
  const runner = new FreeRoomRunner(fixture_run.config, fixture_run.store, async (profile, binding, task) => {
    callbacks = task;
    return { status: 'accepted', steer: () => true };
  });
  await runner.tick();
  const execution = fixture_run.current_execution();
  callbacks.on_activity('tool', 'image', undefined, { synthetic: true });
  await runner.report_segments(execution.id);
  const pulse_report = fixture_run.diagnostics_reports.at(-1).diagnostics;
  assert.equal(pulse_report.last_activity_at, undefined);

  callbacks.on_activity('thinking');
  callbacks.on_diagnostic({ retry: { layer: 'model', state: 'started', attempt: 1 } });
  execution.interjections = [{ id: 42, text: 'private debug prompt' }];
  await runner.deliver_interjections([execution]);
  assert.equal(fixture_run.diagnostics_reports.at(-1).diagnostics.confirmed_at, null);
  await callbacks.on_diagnostic({ interjection_confirmed: 42 });
  assert.ok(fixture_run.diagnostics_reports.at(-1).diagnostics.confirmed_at > 0);
  await runner.report_segments(execution.id, true);
  const report = fixture_run.diagnostics_reports.at(-1).diagnostics;
  assert.ok(report.last_activity_at > 0);
  assert.deepEqual(report.retries.map(({ layer, attempt }) => [layer, attempt]), [['model', 1]]);
  assert.doesNotMatch(JSON.stringify(report), /private debug prompt/);
});

test('Codex bridge confirms an interjection only on the matching completed user item', { timeout: 10000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-steer-receipt-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'app-server'), `
    const send = message => process.stdout.write(JSON.stringify(message) + '\\n');
    const notify = (method, params) => send({ method, params: { threadId: 'thread', turnId: 'turn', ...params } });
    require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
      const { id, method, params } = JSON.parse(line);
      if (!id) return;
      const result = method === 'thread/start' ? { thread: { id: 'thread' } }
        : method === 'turn/start' ? { turn: { id: 'turn' } } : {};
      send({ id, result });
      if (method === 'turn/steer') {
        const item = { id: 'user-item', type: 'userMessage', content: params.input };
        notify('item/started', { item });
        notify('item/completed', { item, turnId: 'wrong-turn' });
        notify('item/completed', { item: { id: 'marker', type: 'agentMessage', text: 'before valid receipt' } });
        notify('item/completed', { item });
        notify('item/completed', { item });
        notify('turn/completed', { turn: { status: 'completed' } });
      }
    });`);
  const bridge = spawn(process.execPath, [fileURLToPath(new URL('../runner/adapters/codex_bridge.mjs', import.meta.url)), process.execPath],
    { cwd: directory, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (bridge.exitCode === null) bridge.kill(); });
  bridge.stdin.write(`${JSON.stringify({ prompt: 'start', cwd: directory })}\n`);
  let output = '';
  let requested = false;
  bridge.stdout.on('data', chunk => {
    output += chunk;
    if (requested || !output.includes('"type":"codiscuss.turn"')) return;
    requested = true;
    bridge.stdin.write(`${JSON.stringify({ steer: 'private text', interjection_id: 42 })}\n`);
  });
  const [code] = await once(bridge, 'close');
  assert.equal(code, 0);
  const events = output.trim().split('\n').map(line => JSON.parse(line));
  assert.ok(events.findIndex(event => event.type === 'codiscuss.interjection_confirmed') > events.findIndex(event => event.item?.id === 'marker'));
  assert.deepEqual(events.filter(event => event.type === 'codiscuss.interjection_confirmed'),
    [{ type: 'codiscuss.interjection_confirmed', interjection_id: 42 }]);
  assert.doesNotMatch(output, /private text/);
});

for (const outcome of ['accept', 'refuse', 'interrupted', 'keep', 'same-turn', 'list-timeout']) {
  test(`Codex bridge gates late background reports on the runner: ${outcome}`, { timeout: 10000 }, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'codex-background-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    writeFileSync(join(directory, 'app-server'), `
      const send = data => console.log(JSON.stringify(data));
      let turns = 0;
      const notify = (method, extra) => send({ method, params: { threadId: 'thread', turnId: 'one', ...extra } });
      const item = (method, item, extra) => notify(method, { item, ...extra });
      const agent = { type: 'subAgentActivity', agentThreadId: 'agent', agentPath: 'review' };
      require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
        const { id, method, params } = JSON.parse(line);
        if (!id) return;
        if (method === 'initialize' && !params.capabilities.experimentalApi) process.exit(2);
        if (method === 'thread/backgroundTerminals/list') {
          if ('${outcome}' === 'list-timeout') return;
          send({ id, result: { data: [{ itemId: 'cmd', command: 'sleep 30' }, { itemId: 'unrelated' }] } });
          return;
        }
        const turnId = turns ? 'two' : 'one';
        const result = method === 'thread/start' ? { thread: { id: 'thread' } }
          : method === 'turn/start' ? { turn: { id: turnId } } : {};
        send({ id, result });
        if (method !== 'turn/start') return;
        turns++;
        if (turns > 1 && (params.threadId !== 'thread' || !params.input[0].text.includes('rootTurnId'))) process.exit(3);
        notify('turn/started', { turnId, turn: { id: turnId } });
        if (turns === 1) {
          if ('${outcome}' === 'list-timeout') {
            item('item/started', { type: 'commandExecution', id: 'cmd' });
            notify('turn/completed', { turnId, turn: { id: turnId, status: 'completed' } });
            return;
          }
          item('item/completed', { ...agent, kind: 'started' });
          if ('${outcome}' === 'same-turn') {
            setTimeout(() => {
              item('item/completed', { ...agent, kind: 'completed' });
              notify('turn/completed', { turnId, turn: { id: turnId, status: 'completed' } });
            }, 100);
            return;
          }
          item('item/started', { type: 'commandExecution', id: 'cmd' });
          item('item/completed', { ...agent, kind: 'interrupted' }, { turnId: 'foreign' });
          setTimeout(() => {
            item('item/completed', { ...agent, kind: '${outcome === 'interrupted' ? 'interrupted' : 'completed'}' });
            setTimeout(() => item('item/completed', { type: 'commandExecution', id: 'cmd', exitCode: ${outcome === 'keep' ? 1 : 0}, status: '${outcome === 'keep' ? 'failed' : outcome === 'interrupted' ? 'interrupted' : 'completed'}' }), ${outcome === 'keep' ? 200 : 0});
          }, 100);
        }
        notify('turn/completed', { turnId, turn: { id: turnId, status: 'completed' } });
      });`);
    const child = spawn(process.execPath, [fileURLToPath(new URL('../runner/adapters/codex_bridge.mjs', import.meta.url)), process.execPath],
      { cwd: directory, stdio: ['pipe', 'pipe', 'pipe'] });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    const lists = [], batches = [], phases = [], turns = [];
    const state = { child };
    const task = { on_background_tasks: list => lists.push(list), on_activity: phase => phases.push(phase),
      on_followup: async reports => { batches.push(reports); return outcome === 'keep' ? (batches.length === 1 ? 'keep' : true) : outcome === 'accept'; } };
    let partial = '';
    child.stdout.on('data', chunk => {
      const lines = (partial + chunk).split('\n');
      partial = lines.pop();
      for (const line of lines) {
        const event = JSON.parse(line);
        if (event.type === 'turn.started') turns.push(event);
        adapter_of('codex_cli').lifecycle(state, event, task, () => {});
        if (outcome === 'same-turn' && event.type === 'background.started') assert.equal(child.linger(), true);
        if (event.type === 'turn.completed' && event.waiting) assert.equal(child.linger(), true);
      }
    });
    child.stdin.write(JSON.stringify({ prompt: 'start', cwd: directory, background: true }) + '\n');
    const [code] = await once(child, 'close');
    clearTimeout(state.finish_timer);
    assert.equal(code, 0);
    if (outcome === 'same-turn' || outcome === 'list-timeout') {
      assert.deepEqual(batches, []);
      assert.equal(turns.length, 1);
      assert.deepEqual(lists.at(-1)?.map(item => item.state) || [], outcome === 'same-turn' ? ['done'] : []);
      return;
    }
    if (outcome === 'keep') {
      assert.deepEqual(batches.map(batch => batch.map(item => [item.id, item.status])), [[['agent', 'completed']], [['cmd', 'failed']]]);
      assert.equal(turns.length, 2);
      return;
    }
    assert.ok(phases.length && phases.every(phase => phase === 'waiting'));
    if (outcome !== 'refuse') assert.deepEqual(lists.at(-1).map(({ id, state }) => [id, state]),
      [['agent', outcome === 'interrupted' ? 'stopped' : 'done'], ['cmd', outcome === 'interrupted' ? 'stopped' : 'done']]);
    const reported = batches.flat().map(({ id, rootTurnId }) => [id, rootTurnId]);
    if (outcome === 'accept') assert.deepEqual(reported, [['agent', 'one'], ['cmd', 'one']]);
    else if (outcome === 'interrupted') assert.deepEqual(reported, []);
    else assert.deepEqual(reported[0], ['agent', 'one']);
    assert.equal(turns.length, outcome === 'accept' ? 1 + batches.length : 1);
  });
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
    const task_file = JSON.parse(readFileSync(task.task_path, 'utf8'));
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

test('a restarted runner fails unknown dead turns without redelivery, and waits for live processes', async t => {
  const exited = spawnSync(process.execPath, ['-e', '']).pid;
  for (const [pid, gone] of [[undefined, true], [exited, true], [process.pid, false]]) {
    const f = await fixture(t); let sent = 0;
    const deliver = async (adapter, binding, task) => {
      sent++; task.on_process(Object.assign(new EventEmitter(), { pid, kill() {} }));
      return { status: 'accepted' };
    };
    await new FreeRoomRunner(f.config, f.store, deliver).tick();
    const id = f.current_execution().id;
    await new FreeRoomRunner(f.config, f.store, deliver).tick();
    assert.equal(sent, 1);
    assert.equal(f.executions.get(id).status, gone ? 'failed' : 'dispatched');
    assert.equal(Boolean(f.executions.get(id).retry), false);
    if (gone) assert.match(f.executions.get(id).result, /重启后无法确认上次执行结果/);
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
};
// agy signed out: the 1.4.12 sign-in prompt timing out headless (room 27395c25b03d, #318), and after the account was
// switched (room 9524f49e42b5, #3203). These are `auth`, never retried by the runner. agy also asks to sign in when it
// failed to load a stored sign-in on a flaky network (#5258), so a sign-in prompt is stopped at once and restarted twice.
// Each entry: [stderr, what the reported reason includes, agy runs, whether agy keeps waiting at the prompt].
const AGY_SIGN_IN_PROMPT = 'Authentication required. Please visit the URL to log in:\n  https://accounts.google.com/o/oauth2/auth?x\n\nWaiting for authentication (timeout 60s)...\n';
const AGY_SIGNED_OUT = {
  sign_in_prompt: [AGY_SIGN_IN_PROMPT, 'authentication required', 3, true],
  sign_in_timed_out: ['Error: authentication timed out.', 'authentication failed or timed out', 3, false],
  unauthenticated: ['', 'Eligibility check failed: UNAUTHENTICATED (401)', 1, false],
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

test("Claude's own error categories classify a usage limit as quota and a sign-in failure as auth", async () => {
  const { claude_failure_class } = await import('../runner/adapters/claude.mjs');
  assert.deepEqual(claude_failure_class({ kind: 'authentication_failed', text: 'Invalid API key · Please run /login' }), { failure_class: 'auth' });
  assert.equal(claude_failure_class({ kind: 'rate_limit', text: "You've hit your 5-hour limit · resets 3pm" }).failure_class, 'quota');
  assert.deepEqual(claude_failure_class({ kind: 'server_error', text: 'Overloaded' }), {});
});

for (const [cause, [stderr, error, runs, linger]] of Object.entries(AGY_SIGNED_OUT)) {
test(`agy that is signed out (${cause}) fails once as auth after ${runs} run(s), without a runner retry`, async t => {
  const f = await fixture(t);
  f.config.participants.Codex = { adapter: 'antigravity_cli', executable: process.execPath };
  // An agy waiting at the sign-in prompt prints no result; it is stopped instead of waited out.
  const process_fixture = fake_cli(linger ? [] : [agy_not_started(error)], { stderr, exit_code: 1, linger });
  const reported = [];
  const deliver = (config, binding, task) => {
    const on_failure = task.on_failure;
    task.on_failure = (reason, details) => { reported.push(details); return on_failure(reason, details); };
    return deliver_task(config, binding, task, process_fixture.spawn_process, join(f.config.directory, 'user'));
  };
  await agy_not_started_attempt(f, new FreeRoomRunner(f.config, f.store, deliver), process_fixture, runs);
  assert.equal(f.current_execution().status, 'failed');
  assert.equal(f.current_execution().retry, null);
  assert.ok(f.current_execution().result.includes(error), f.current_execution().result);
  assert.deepEqual(reported, [{ not_started: false, retryable: false, failure_class: 'auth' }]);
});
}

test('agy that reports an unclassified failure after its conversation started is not delivered again', async t => {
  const f = await fixture(t);
  f.config.participants.Codex = { adapter: 'antigravity_cli', executable: process.execPath };
  const process_fixture = fake_cli([{ event: 'init', conversation_id: 'started' },
    { event: 'result', result: { conversation_id: 'started', status: 'ERROR', response: '', error: 'quota exhausted', num_turns: 1 } }], { exit_code: 1 });
  const deliver = (config, binding, task) => deliver_task(config, binding, task, process_fixture.spawn_process, join(f.config.directory, 'user'));
  await agy_not_started_attempt(f, new FreeRoomRunner(f.config, f.store, deliver), process_fixture, 1);
  assert.equal(f.current_execution().status, 'failed');
  assert.equal(f.current_execution().retry, null);
});

for (const outcome of ['recovered', 'exhausted', 'stopped', 'answered', 'not retryable']) {
test(`agy network interruption in a running conversation: ${outcome}`, { timeout: 20_000 }, async t => {
  const f = await free_fixture(t);
  f.config.participants.Claude = { adapter: 'antigravity_cli', executable: process.execPath };
  const session = 'actual-cli-session';
  const error = 'There was a network issue connecting to the server, please try again.';
  const diagnostic = { short_error: 'stream reading error: unexpected EOF', retryable: outcome !== 'not retryable' };
  const failure = { events: [{ event: 'init', conversation_id: session },
    { event: 'result', result: { conversation_id: session, status: 'ERROR', error, num_turns: 4 } }],
    stderr: `AGY_ERROR: ${JSON.stringify(diagnostic)}\n`, exit_code: 1 };
  const cli = outcome === 'recovered' ? fake_cli([{ event: 'init', conversation_id: session },
    { event: 'step_update', step_update: { step_index: 5, step_type: 'agent_response', state: 'DONE', text_delta: '工作已完成' } },
    { event: 'result', result: { conversation_id: session, status: 'SUCCESS' } }], { earlier: [failure] })
    : fake_cli(failure.events, failure);
  const deliver = (config, binding, task) => deliver_task(config, binding, task, cli.spawn_process, join(f.config.directory, 'user'));
  const runner = new FreeRoomRunner(f.config, f.store, deliver);
  await agy_not_started_attempt(f, runner, cli, 1);
  const [execution] = f.state.executions;
  if (outcome === 'not retryable') {
    assert.equal(execution.status, 'failed');
    assert.ok(!execution.retry);
    return;
  }
  if (outcome === 'stopped' || outcome === 'answered') {
    if (outcome === 'answered') execution.status = 'completed';
    else execution.retry.stopped = 1;
    execution.retry.retry_at = 1;
    await runner.tick();
    assert.equal(cli.calls.length, 1);
    assert.equal(execution.status, outcome === 'answered' ? 'completed' : 'failed');
    return;
  }
  for (const [index, seconds] of [10, 30, 60].entries()) {
    assert.equal(execution.retry.attempt, index + 1);
    assert.ok(Math.abs(execution.retry.retry_at - Math.floor(Date.now() / 1000) - seconds) <= 1);
    // In the recovery case the site accepted retry_start just before the runner restarted.
    execution.retry.retry_at = outcome === 'recovered' ? 0 : 1;
    const current = outcome === 'recovered' ? new FreeRoomRunner(f.config, f.store, deliver) : runner;
    await agy_not_started_attempt(f, current, cli, 1);
    const args = cli.calls.at(-1).args;
    assert.equal(args[args.indexOf('--conversation') + 1], session);
    assert.match(args[args.indexOf('-p') + 1], /网络中断/);
    if (outcome === 'recovered') {
      assert.equal(execution.status, 'completed');
      assert.deepEqual(f.state.posts.map(({ body }) => [body.execution_id, body.text]), [[execution.id, '工作已完成']]);
      return;
    }
  }
  assert.equal(f.state.executions.length, 1);
  assert.equal(execution.status, 'failed');
  assert.match(execution.result, /已自动重试 3 次/);
});
}

test('agy whose account quota is exhausted fails as quota with its reset time, without a restart or a retry (必 9)', async t => {
  const f = await fixture(t);
  f.config.participants.Codex = { adapter: 'antigravity_cli', executable: process.execPath };
  // Room #3327, agy 1.5.x: the quota failure comes before any conversation, which otherwise means "start it again".
  const quota = 'Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 141h35m10s.';
  const process_fixture = fake_cli([agy_not_started(quota)], { exit_code: 1 });
  const reported = [];
  const deliver = (config, binding, task) => {
    const on_failure = task.on_failure;
    task.on_failure = (reason, details) => { reported.push({ reason, details }); return on_failure(reason, details); };
    return deliver_task(config, binding, task, process_fixture.spawn_process, join(f.config.directory, 'user'));
  };
  const before = Date.now();
  await agy_not_started_attempt(f, new FreeRoomRunner(f.config, f.store, deliver), process_fixture, 1);
  assert.equal(f.current_execution().status, 'failed');
  assert.equal(f.current_execution().retry, null);
  const { details } = reported[0];
  assert.equal(details.failure_class, 'quota');
  assert.equal(details.retryable, false);
  assert.equal(details.not_started, false);
  // The duration becomes the moment it ends, in this computer's local time.
  const duration = (141 * 3600) + (35 * 60) + 10;
  // `reset_at` is when the reported failure was classified plus the duration, in Unix seconds.
  assert.ok(details.reset_at >= Math.floor(before / 1000) + duration && details.reset_at <= Math.floor(Date.now() / 1000) + duration, String(details.reset_at));
  const resets = new Date(before + duration * 1000);
  const pad = value => String(value).padStart(2, '0');
  assert.ok(details.resets.startsWith(`${resets.getFullYear()}-${pad(resets.getMonth() + 1)}-${pad(resets.getDate())} `), details.resets);
  assert.match(details.resets, /^\d{4}-\d\d-\d\d \d\d:\d\d \(UTC[+-]\d\d:\d\d\)$/);
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

// agy that failed to load its stored sign-in on a flaky network asks to sign in, then works on the next start (#5258).
test('agy that asks to sign in is stopped at once, restarted, and runs the turn when the sign-in loads', async t => {
  const f = await fixture(t);
  f.config.participants.Codex = { adapter: 'antigravity_cli', executable: process.execPath };
  const process_fixture = fake_cli(cli_events('antigravity_cli'),
    { earlier: [{ events: [], stderr: AGY_SIGN_IN_PROMPT, linger: true }] });
  const deliver = (config, binding, task) => deliver_task(config, binding, task, process_fixture.spawn_process, join(f.config.directory, 'user'));
  await agy_not_started_attempt(f, new FreeRoomRunner(f.config, f.store, deliver), process_fixture, 2);
  assert.equal(f.current_execution().retry, null, 'no runner retry was needed');
  assert.doesNotMatch(f.current_execution().result, /authentication/);
  assert.equal(f.store.binding('Codex').session_id, 'actual-cli-session');
});

/** Emit real subprocess output in split UTF-8 chunks without invoking an AI account. */
function fake_cli(events, options = {}) {
  const calls = [];
  const config_calls = [];
  // `options.earlier`: runs the first calls emit instead, as { events, exit_code, stderr?, linger? }, before `events` takes over.
  const source_for = ({ events, exit_code, stderr = options.stderr, linger = options.linger }) => `
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
      process.stderr.write(${JSON.stringify(stderr || 'diagnostic 中文')});
      const output = Buffer.from(${JSON.stringify(events.map(event => JSON.stringify(event)).join('\r\n') + '\r\n')});
      const split = Math.max(1, output.indexOf(Buffer.from('中文')) + 1);
      process.stdout.write(output.subarray(0, split));
      await new Promise(resolve => setTimeout(resolve, 5));
      process.stdout.write(output.subarray(split));
      if (${Boolean(linger)}) setInterval(() => {}, 1000);
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
  const bindings = []; const errors = []; const failure_options = []; const denials = []; const activities = []; const background_lists = []; let exits = 0;
  const process_fixture = fake_cli(options.events || cli_events(adapter), options);
  t.after(async () => {
    for (const call of [...process_fixture.calls, ...process_fixture.config_calls]) {
      if (call.child.exitCode === null && call.child.signalCode === null) call.child.kill();
      await call.closed;
    }
    rmSync(root, { recursive: true, force: true });
  });
  const member_directory = join(directory, 'members', 'own');
  mkdirSync(member_directory, { recursive: true });
  const task = { id: 'event-1', participant: 'Antigravity', directory, member_directory, draft_directory, access_path, prompt: '讨论中文 "quotes"\n$(literal); `literal`',
    skill_directories: [join(directory, 'skills')],
    on_binding: session => bindings.push(session), on_process: () => {},
    on_output: (path, chunk) => appendFileSync(path, chunk), on_failure: (error, options) => { errors.push(error); failure_options.push(options); }, on_exit: () => { exits++; }, on_denials: list => denials.push(...list), on_activity: phase => activities.push(phase), on_background_tasks: list => background_lists.push(list),
    ...(options.on_followup ? { on_followup: options.on_followup } : {}) };
  const config = { adapter, executable: process.execPath, ...options.config };
  const result = await deliver_task(config, options.binding || {}, task, process_fixture.spawn_process, user_home);
  await process_fixture.calls[0].closed;
  return { directory, user_home, config, access_path, task, result, bindings, errors, failure_options, denials, exits, activities, background_lists, ...process_fixture };
}

test('agy lists the background work its tool steps show and ends it as the steps and the result say (1.5.16 shapes)', async t => {
  const step = (index, state, tool_name, extra = {}) => ({ event: 'step_update', step_update: { step_index: index, state, step_type: tool_name === 'invoke_subagent' ? 'subagent' : 'tool', tool_name, ...extra } });
  const tool = (parameters, output) => ({ tool_info: { parameters, ...(output === undefined ? {} : { output }) } });
  const agent = (role, conversation_id) => ({ subagent_info: { subagents: [{ type_name: 'research', role, conversation_id }] } });
  const f = await cli_delivery_fixture(t, 'antigravity_cli', { events: [
    { event: 'init', conversation_id: 'actual-cli-session' },
    // A command that finishes in the foreground is no background work.
    step(1, 'ACTIVE', 'run_command', tool({ CommandLine: 'codiscuss room view' })),
    step(1, 'DONE', 'run_command', tool({ CommandLine: 'codiscuss room view' }, 'Command exited with code 0.')),
    step(2, 'DONE', 'invoke_subagent', agent('Readonly Probe', 'sub-1')),
    step(3, 'DONE', 'invoke_subagent', agent('Echo Probe', 'sub-2')),
    step(4, 'ACTIVE', 'schedule', tool({ CronExpression: '0 0 1 1 *', Prompt: 'CRON_PROBE' })),
    step(4, 'DONE', 'schedule', tool({ CronExpression: '0 0 1 1 *', Prompt: 'CRON_PROBE' }, 'Cron schedule cancelled after 0 iterations.')),
    step(5, 'DONE', 'manage_subagents', tool({ Action: 'kill', ConversationIds: ['sub-1'] }, 'Successfully killed 1 subagent(s) and their descendants.')),
    { event: 'result', result: { conversation_id: 'actual-cli-session', status: 'SUCCESS', response: '中文' } },
  ] });
  assert.deepEqual(f.errors, []);
  const last = f.background_lists.at(-1).map(({ id, kind, title, state, schedule }) => ({ id, kind, title, state, schedule }));
  assert.deepEqual(last, [
    { id: 'task-4', kind: 'schedule', title: 'CRON_PROBE', state: 'stopped', schedule: 'cron (0 0 1 1 *)' },
    { id: 'sub-1', kind: 'agent', title: 'Readonly Probe', state: 'stopped', schedule: '' },
    // Still listed when the result came: -p prints it only after the reports it waited for.
    { id: 'sub-2', kind: 'agent', title: 'Echo Probe', state: 'done', schedule: '' },
  ]);
  assert.ok(f.background_lists.some(list => list.some(item => item.id === 'task-4' && item.state === 'running')), 'the schedule shows while its step runs');
});

test('Codex classifies software error codes without interpreting prose or retrying the delivery', async t => {
  for (const [info, expected] of [
    [{ codex_error_info: 'usage_limit_exceeded' }, 'quota'],
    [{ codexErrorInfo: 'usageLimitExceeded' }, 'quota'],
    [{ codex_error_info: 'cyber_policy' }, 'policy_blocked'],
    [{ codexErrorInfo: 'cyber_policy' }, 'policy_blocked'],
    [{ codex_error_info: 'new_policy' }, undefined],
    [{ codex_error_info: 'constructor' }, undefined],
    [{ codex_error_info: 'cyber_policy', codexErrorInfo: 'usageLimitExceeded' }, undefined],
    [{}, undefined],
  ]) {
    const f = await cli_delivery_fixture(t, 'codex_cli', { events: [
      { type: 'thread.started', thread_id: 'actual-cli-session' },
      { type: 'turn.failed', error: { message: 'You have hit your usage limit', ...info } },
      { type: 'error', message: 'Later diagnostic must not replace the failed turn code' },
    ] });
    assert.equal(f.calls.length, 1);
    assert.equal(f.errors.length, 1);
    assert.equal(f.failure_options[0].failure_class, expected);
    if (expected) assert.equal(f.failure_options[0].retryable, false);
  }
});

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
    // The runtime directory gets no entry of its own: a "none" entry would lock other Codex members out (凭据文件隔离).
    assert.ok(!overrides[1].includes(JSON.stringify(f.directory.replaceAll('\\', '/'))));
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
  assert.equal(JSON.parse(readFileSync(runtime_file(f.config.directory, 'free-2.access.json'), 'utf8')).session_id, 'actual-cli-session');
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

test('an expert writes its own knowledge folder and nothing else while its project stays read-only', t => {
  const f = task_fixture(t);
  // A folder card's skills sit inside the workflow folder, which every member reads and none may write.
  const main = join(f.config.directory, 'main'), library = mkdtempSync(join(tmpdir(), 'expert-library-'));
  t.after(() => rmSync(library, { recursive: true, force: true }));
  mkdirSync(main);
  const workflow = join(library, 'novel');
  for (const folder of ['agents/luke/skills/cold', 'agents/jack/skills/sail', 'workflows/advisor/agents/kit/skills/sea']) mkdirSync(join(workflow, folder), { recursive: true });
  for (const file of ['SKILL.md', 'agents/writer.md', 'agents/luke/luke.md', 'agents/luke/skills/cold/SKILL.md', 'agents/jack/jack.md', 'workflows/advisor/SKILL.md']) writeFileSync(join(workflow, file), 'x');
  const knowledge = join(workflow, 'agents', 'luke', 'skills');
  const task = { ...session_task(f.config), knowledge_directory: knowledge, skill_directories: [...session_task(f.config).skill_directories, workflow],
    extra_directories: [{ path: main, access: 'read' }] };
  const config = { cwd: main, project_access: 'read' };
  const others = [join(workflow, 'SKILL.md'), join(workflow, 'agents', 'writer.md'), join(workflow, 'agents', 'luke', 'luke.md')];
  const other_folders = [join(workflow, 'workflows'), join(workflow, 'agents', 'jack')];

  const claude = claude_permissions(config, task);
  const allowed = claude.slice(0, claude.indexOf('--disallowedTools')), denied = claude.slice(claude.indexOf('--disallowedTools'));
  assert.ok(claude.includes(knowledge) && allowed.includes(`Edit(${claude_rule_path(knowledge)}/**)`), 'its knowledge is a working directory it edits');
  assert.ok(!denied.some(rule => rule.startsWith(`Edit(${claude_rule_path(workflow)}/**`)) && !denied.includes(`Edit(${claude_rule_path(knowledge)}/**)`),
    'the workflow is not denied whole, its own skills not at all');
  for (const path of others) assert.ok(denied.includes(`Edit(${claude_rule_path(path)})`), `${path} stays denied`);
  for (const path of other_folders) assert.ok(denied.includes(`Edit(${claude_rule_path(path)}/**)`), `${path} stays denied`);
  assert.ok(!allowed.includes(`Edit(${claude_rule_path(main)}/**)`) && denied.includes(`Edit(${claude_rule_path(main)}/**)`) && !allowed.includes('Bash'),
    'the project stays read-only, no general commands');
  const plain = claude_permissions(config, { ...task, knowledge_directory: undefined });
  assert.ok(!plain.includes(`Edit(${claude_rule_path(knowledge)}/**)`) && plain.includes(`Edit(${claude_rule_path(workflow)}/**)`), 'without knowledge the workflow is denied whole');

  // Codex: the sandbox grants its own skills by path; the workflow is not writable, and no read-only entry is added for
  // it, since on Windows such an entry under a writable folder becomes a lasting deny (tested 2026-11-22).
  const codex = codex_permissions(config, task, 'linux').args.find(arg => arg.startsWith('permissions.'));
  const entry = (path, access) => `${JSON.stringify(resolve(path).replaceAll('\\', '/'))}=${JSON.stringify(access)}`;
  assert.ok(codex.includes('extends=":read-only"') && codex.includes(entry(knowledge, 'write')) && codex.includes(entry(main, 'read')));
  assert.ok(!codex.includes(entry(workflow, 'write')) && !codex.includes(entry(join(workflow, 'agents', 'jack'), 'write')));

  const user_home = join(f.config.directory, 'user');
  mkdirSync(join(user_home, '.gemini', 'config', 'projects'), { recursive: true });
  const agy = prepare_agy_project(config, {}, task, user_home);
  const grants = JSON.parse(readFileSync(agy.settings_path, 'utf8')).permissions;
  const rule = path => `write_file(${resolve(path).replaceAll('\\', '/')})`;
  assert.ok(grants.allow.includes(rule(knowledge)) && !grants.deny.includes(rule(knowledge)) && !grants.deny.includes(rule(workflow)));
  for (const path of [...others, ...other_folders]) assert.ok(grants.deny.includes(rule(path)), `${path} stays denied`);
  assert.ok(grants.deny.includes(rule(main)) && !grants.allow.includes('command(*)'), 'the project is protected and only codiscuss commands run');
});

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
  // Only the member's own runtime folder is added, never the runtime directory holding every member's credential.
  assert.deepEqual(args.slice(directories + 1, directories + 4), [f.task.member_directory, f.task.draft_directory, f.task.skill_directories[0]]);
  assert.ok(!args.includes(f.directory));
  assert.deepEqual(args.slice(args.indexOf('--disallowedTools') + 1), [`Edit(${claude_rule_path(f.task.skill_directories[0])}/**)`]);
  assert.deepEqual(args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--disallowedTools')),
    [...TASK_SUBCOMMANDS.flatMap(command => [`Bash(codiscuss ${command} *)`, `PowerShell(codiscuss ${command} *)`]),
    `Edit(${claude_rule_path(f.task.draft_directory)}/**)`, 'Read(//d/materials/**)']);
  assert.ok(!args.includes(`Edit(${claude_rule_path(f.directory)}/**)`));
  assert.ok(!args.some(arg => /(Bash|PowerShell)\(codiscuss (service|launch (?!(workflow-(adopt|join|leave)|host-control|image) )|run|api|setup|install|local)/.test(arg)));
  // The prompt is the first stream-json message on stdin, which stays open for interjections.
  assert.ok(args.includes('--input-format') && !args.includes(f.task.prompt));
  assert.equal(JSON.parse(f.calls[0].input).message.content[0].text, f.task.prompt);
  assert.equal(typeof f.result.steer, 'function');
  if (process.platform === 'win32') assert.equal(claude_rule_path('C:\\Data\\room'), '//c/Data/room');
});

test('claude says it waits for background tasks its process left running after its result', async t => {
  // Shapes recorded by Claude Code 2.1.326 (2026-11-20, -p stream-json): the process outlives its result until they report.
  const started = { type: 'system', subtype: 'task_started', task_id: 'b1', tool_use_id: 'toolu_1', is_backgrounded: true, task_type: 'local_agent', description: '调研' };
  const progress = { type: 'system', subtype: 'task_progress', task_id: 'b1', tool_use_id: 'toolu_1' };
  // A sub-agent's own steps carry the call that started it; they are not the member's phases or remarks.
  const inner = { type: 'assistant', parent_tool_use_id: 'toolu_1', message: { content: [{ type: 'text', text: 'pong' }] } };
  const reported = { type: 'system', subtype: 'task_notification', task_id: 'b1', tool_use_id: 'toolu_1', status: 'completed' };
  const f = await cli_delivery_fixture(t, 'claude', { events: [started, { type: 'result', is_error: false, result: '已开始' }, progress, inner, reported,
    { type: 'result', is_error: false, result: '完成' }] });
  assert.deepEqual(f.errors, []);
  assert.deepEqual(f.activities.filter(phase => ['waiting', 'writing', 'thinking'].includes(phase)).slice(-1), ['waiting'], 'only the result left waiting says so');
  assert.deepEqual(f.background_lists.map(list => list.map(({ id, kind, title, state }) => ({ id, kind, title, state }))),
    [[{ id: 'b1', kind: 'agent', title: '调研', state: 'running' }], [{ id: 'b1', kind: 'agent', title: '调研', state: 'done' }]]);
});

test('claude puts a background report after its result to the runner as a follow-up, not one inside the turn', async t => {
  const started = id => ({ type: 'system', subtype: 'task_started', task_id: id, tool_use_id: `toolu_${id}`, is_backgrounded: true, task_type: 'local_bash', description: '跑测试' });
  const reported = id => ({ type: 'system', subtype: 'task_notification', task_id: id, tool_use_id: `toolu_${id}`, status: 'completed', summary: '测试通过' });
  const asked = [];
  const f = await cli_delivery_fixture(t, 'claude', { events: [started('b1'), started('b2'), reported('b1'), { type: 'result', is_error: false, result: '已提交' },
    reported('b2'), { type: 'assistant', message: { content: [{ type: 'text', text: '后台测试通过了' }] } }, { type: 'result', is_error: false, result: '续报' }],
  on_followup: async (reports, handle) => { asked.push({ reports, handle: Boolean(handle?.linger) }); return true; } });
  assert.deepEqual(asked, [{ reports: [{ id: 'b2', status: 'completed', summary: '测试通过' }], handle: true }],
    'only the report after the result starts a new turn');
  assert.deepEqual([f.errors, f.exits], [[], 1]);
  assert.equal(f.calls[0].child.linger(), false, 'an exited process is not kept');
});

test('a Claude window kept past a completed execution follows only its listed background work\'s report as a follow-up', async t => {
  const home = mkdtempSync(join(tmpdir(), 'claude-followup-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const line = entry => `${JSON.stringify(entry)}\n`;
  const prompt = line({ type: 'user', message: { role: 'user', content: 'Another Claude session sent a message: 读取 free-9.task.json' } });
  const bash = id => line({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'npm test', run_in_background: true } }] } })
    + line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'running in background' }] },
      toolUseResult: { stdout: '', stderr: '', backgroundTaskId: `task-${id}` } });
  const remark = text => line({ type: 'assistant', timestamp: new Date().toISOString(), message: { content: [{ type: 'text', text }] } });
  const report = id => line({ type: 'user', message: { role: 'user', content: `<task-notification>\n<task-id>task-${id}</task-id>\n<tool-use-id>${id}</tool-use-id>\n<status>completed</status>\n<summary>测试通过</summary>\n</task-notification>` } });
  const turn_end = line({ type: 'system', subtype: 'turn_duration', durationMs: 900 });
  mkdirSync(join(home, 'sessions'), { recursive: true });
  writeFileSync(join(home, 'sessions', `${process.pid}.json`), JSON.stringify({ status: 'idle', updatedAt: Date.now() + 60_000 }));
  const follow = () => {
    const file = join(home, `${randomUUID()}.jsonl`), seen = [], asked = [], handle = { kill() {} };
    writeFileSync(file, '');
    const answers = [];
    const watch = watch_window_turn({ file, offset: 0, pid: process.pid, marker: 'free-9.task.json', log_path: join(home, 'window.log') }, {
      on_output: () => {}, on_exit: reason => seen.push(reason || 'exit'), on_note: text => seen.push(text),
      on_followup: async (reports, from, options) => { asked.push([reports.map(item => item.id), from === handle, options]); return answers.shift() ?? true; },
    }, { interval: 10, env: { CLAUDE_CONFIG_DIR: home }, handle, on_end: () => seen.push('end') });
    return { file, seen, asked, answers, watch };
  };
  const wait_for = async (check) => { for (let waited = 0; !check() && waited < 2000; waited += 20) await delay(20); await delay(50); };
  for (const accepted of [true, false]) {
    const { file, seen, asked, answers, watch } = follow();
    answers.push(accepted);
    appendFileSync(file, prompt + bash('toolu_t') + remark('已提交') + turn_end);
    await wait_for(() => seen.length);
    assert.equal(watch.lingers(), true);
    assert.equal(watch.linger(), true, 'the runner keeps it once the execution completed');
    // A later task in the same window launches its own work: the kept watch does not take that on.
    appendFileSync(file, bash('toolu_new') + report('toolu_new') + report('toolu_t') + remark('后台测试通过了') + turn_end);
    await wait_for(() => seen.includes('end'));
    assert.deepEqual(asked, [[['toolu_t'], true, { steer: true }]], 'only the listed work\'s report is put to the runner');
    assert.deepEqual(seen, accepted ? ['已提交', '后台测试通过了', 'exit', 'end'] : ['已提交', 'end']);
  }
  // The runner stopping a kept watch only ends the following; with nothing left, or a stop on a voided turn, nothing lingers.
  const kept = follow();
  appendFileSync(kept.file, prompt + bash('toolu_t') + remark('已提交') + turn_end);
  await wait_for(() => kept.seen.length);
  kept.watch.linger();
  assert.equal(kept.watch.stop(), true);
  assert.deepEqual([kept.seen, kept.watch.lingers()], [['已提交', 'end'], false]);
  const voided = follow();
  appendFileSync(voided.file, prompt + bash('toolu_t') + remark('还在跑') + turn_end);
  await wait_for(() => voided.seen.length);
  voided.watch.stop();
  await wait_for(() => voided.seen.includes('end'));
  appendFileSync(voided.file, report('toolu_t'));
  await delay(100);
  assert.deepEqual([voided.seen.slice(1), voided.asked, voided.watch.linger()], [['停止时原窗口在等后台任务，后台任务仍在运行', 'end'], [], false]);
});

test('a kept Claude window goes on following the rest of its background work when a report is answered keep', async t => {
  const home = mkdtempSync(join(tmpdir(), 'claude-keep-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const line = entry => `${JSON.stringify(entry)}\n`;
  const prompt = line({ type: 'user', message: { role: 'user', content: 'Another Claude session sent a message: 读取 free-9.task.json' } });
  const bash = id => line({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'npm test', run_in_background: true } }] } })
    + line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'running in background' }] },
      toolUseResult: { stdout: '', stderr: '', backgroundTaskId: `task-${id}` } });
  const remark = text => line({ type: 'assistant', timestamp: new Date().toISOString(), message: { content: [{ type: 'text', text }] } });
  const report = (id, status) => line({ type: 'user', message: { role: 'user', content: `<task-notification>\n<task-id>task-${id}</task-id>\n<tool-use-id>${id}</tool-use-id>\n<status>${status}</status>\n</task-notification>` } });
  const turn_end = line({ type: 'system', subtype: 'turn_duration', durationMs: 900 });
  mkdirSync(join(home, 'sessions'), { recursive: true });
  writeFileSync(join(home, 'sessions', `${process.pid}.json`), JSON.stringify({ status: 'idle', updatedAt: Date.now() + 60_000 }));
  const file = join(home, 'keep.jsonl'), seen = [], asked = [], answers = ['keep', true];
  writeFileSync(file, '');
  const watch = watch_window_turn({ file, offset: 0, pid: process.pid, marker: 'free-9.task.json', log_path: join(home, 'window.log') }, {
    on_output: () => {}, on_exit: reason => seen.push(reason || 'exit'), on_note: text => seen.push(text),
    on_followup: async reports => { asked.push(reports.map(item => `${item.id}:${item.status}`)); return answers.shift(); },
  }, { interval: 10, env: { CLAUDE_CONFIG_DIR: home }, handle: { kill() {} }, on_end: () => seen.push('end') });
  appendFileSync(file, prompt + bash('toolu_server') + bash('toolu_test') + remark('已提交') + turn_end);
  for (let waited = 0; !seen.length && waited < 2000; waited += 20) await delay(20);
  assert.equal(watch.linger(), true);
  // The server Claude Code ended at its timeout brings nothing new; the long test still runs and is still followed.
  appendFileSync(file, report('toolu_server', 'killed') + remark('服务被结束了') + turn_end);
  await delay(150);
  assert.deepEqual([asked, seen, watch.lingers()], [[['toolu_server:killed']], ['已提交'], true]);
  appendFileSync(file, report('toolu_test', 'completed') + remark('测试全部通过') + turn_end);
  for (let waited = 0; !seen.includes('end') && waited < 2000; waited += 20) await delay(20);
  assert.deepEqual(asked, [['toolu_server:killed'], ['toolu_test:completed']]);
  assert.deepEqual(seen, ['已提交', '测试全部通过', 'exit', 'end']);
});

test('a schedule a Claude window host set comes back as a scheduled execution when it fires, unless a turn is followed', async t => {
  const home = mkdtempSync(join(tmpdir(), 'claude-schedule-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const line = entry => `${JSON.stringify(entry)}\n`;
  const prompt = marker => line({ type: 'user', message: { role: 'user', content: `Another Claude session sent a message: 读取 ${marker}` } });
  const remark = text => line({ type: 'assistant', timestamp: new Date().toISOString(), message: { content: [{ type: 'text', text }] } });
  const turn_end = line({ type: 'system', subtype: 'turn_duration', durationMs: 900 });
  // Shapes recorded by Claude Code 2.1.325 (2026-11-14, session 5b0d3be0, lines 4366-4382).
  const cron = (id, recurring = true) => line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `toolu_${id}`, name: 'CronCreate',
    input: { cron: '*/5 * * * *', prompt: '用 npm view 查线上版本', recurring } }] } })
    + line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `toolu_${id}`, content: 'Scheduled' }] },
      toolUseResult: { id, humanSchedule: 'Every 5 minutes', recurring, durable: false, nextFireAt: 1_794_681_548_326 } });
  const fire = id => line({ type: 'system', subtype: 'scheduled_task_fire', content: 'Running scheduled task (Nov 14 10:39am)', isMeta: false,
    taskId: id, cron: '*/5 * * * *', prompt: '用 npm view 查线上版本' }) + line({ type: 'user', isMeta: true, message: { role: 'user', content: '用 npm view 查线上版本' } });
  const cron_delete = id => line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_del', name: 'CronDelete', input: { id } }] } })
    + line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_del', content: 'Deleted' }] } });
  const wait_for = async check => { for (let waited = 0; !check() && waited < 2000; waited += 20) await delay(20); await delay(60); };
  const held_tasks = new Set();
  const room_task = (file, marker, seen, answers) => watch_window_turn({ file, offset: 0, pid: process.pid, marker, log_path: join(home, 'window.log') }, {
    on_output: () => {}, on_note: text => seen.push(text), on_exit: reason => seen.push(reason || 'exit'),
    on_schedule_listener: active => active ? held_tasks.add(marker) : held_tasks.delete(marker),
    on_schedule: async (schedule, handle) => { seen.push(`schedule:${schedule.id}:${schedule.schedule}:${schedule.prompt}:${typeof handle.kill}`); return answers.shift(); },
  }, { interval: 10, env: { CLAUDE_CONFIG_DIR: home } });
  // Idle host: the fire opens a scheduled execution and its turn is followed there, through the same callbacks.
  const idle = join(home, 'idle.jsonl'), seen = [];
  writeFileSync(idle, '');
  room_task(idle, 'free-9.task.json', seen, [true]);
  appendFileSync(idle, prompt('free-9.task.json') + cron('7ba9b755') + remark('已设定时') + turn_end);
  await wait_for(() => seen.includes('exit'));
  assert.deepEqual([...held_tasks], ['free-9.task.json']);
  appendFileSync(idle, fire('7ba9b755') + remark('线上还是 0.4.52') + turn_end);
  await wait_for(() => seen.length >= 5);
  assert.deepEqual(seen, ['已设定时', 'exit', 'schedule:7ba9b755:Every 5 minutes:用 npm view 查线上版本:function', '线上还是 0.4.52', 'exit']);
  // A fire while a room task's turn is followed belongs to that execution: nothing is asked.
  appendFileSync(idle, prompt('free-10.task.json'));
  const busy = [];
  room_task(idle, 'free-10.task.json', busy, []);
  await delay(60);
  appendFileSync(idle, fire('7ba9b755') + remark('顺便查了版本'));
  await wait_for(() => busy.length);
  assert.deepEqual([...held_tasks], ['free-10.task.json']);
  assert.deepEqual([busy, seen.length], [['顺便查了版本'], 5]);
  appendFileSync(idle, turn_end);
  await wait_for(() => busy.includes('exit'));
  // Deleting the schedule ends the listener: a later fire (as if set again elsewhere) is not asked.
  appendFileSync(idle, cron_delete('7ba9b755'));
  await delay(80);
  appendFileSync(idle, fire('7ba9b755') + remark('不该被收') + turn_end);
  await delay(120);
  assert.equal(seen.length, 5);
  assert.equal(held_tasks.size, 0);
  // The member is no longer the host: 'stop' ends the listener too.
  const stopped = join(home, 'stopped.jsonl'), told = [];
  writeFileSync(stopped, '');
  room_task(stopped, 'free-11.task.json', told, ['stop']);
  appendFileSync(stopped, prompt('free-11.task.json') + cron('ac6ebfd2') + remark('已设定时') + turn_end);
  await wait_for(() => told.includes('exit'));
  appendFileSync(stopped, fire('ac6ebfd2') + remark('第一次') + turn_end);
  await wait_for(() => told.length >= 3);
  appendFileSync(stopped, fire('ac6ebfd2') + remark('第二次') + turn_end);
  await delay(120);
  assert.deepEqual(told, ['已设定时', 'exit', 'schedule:ac6ebfd2:Every 5 minutes:用 npm view 查线上版本:function']);
  // 'drop' forgets that one schedule (set before the owner's stop); one the host sets again in a later room task is asked about.
  const dropped = join(home, 'dropped.jsonl'), asked = [], times = [];
  writeFileSync(dropped, '');
  const dropping_task = marker => watch_window_turn({ file: dropped, offset: readFileSync(dropped).length, pid: process.pid, marker, log_path: join(home, 'window.log') }, {
    on_output: () => {}, on_note: () => {}, on_exit: () => asked.push('exit'),
    on_schedule: async schedule => { asked.push(schedule.id); times.push(schedule.set_at); return schedule.id === 'old00001' ? 'drop' : false; },
  }, { interval: 10, env: { CLAUDE_CONFIG_DIR: home } });
  dropping_task('free-12.task.json');
  const stamped = text => text.split('\n').filter(Boolean).map(item => JSON.stringify({ ...JSON.parse(item), timestamp: new Date().toISOString() })).join('\n') + '\n';
  appendFileSync(dropped, prompt('free-12.task.json') + stamped(cron('old00001')) + remark('已设定时') + turn_end);
  await wait_for(() => asked.includes('exit'));
  appendFileSync(dropped, fire('old00001') + turn_end);
  await wait_for(() => asked.length >= 2);
  // Nothing is left to wait for: the listener ended, and the same schedule firing again is not asked about.
  appendFileSync(dropped, fire('old00001') + turn_end);
  await delay(80);
  dropping_task('free-13.task.json');
  appendFileSync(dropped, prompt('free-13.task.json') + cron('new00002') + remark('重新设好') + turn_end);
  await wait_for(() => asked.filter(item => item === 'exit').length >= 2);
  appendFileSync(dropped, fire('new00002') + turn_end);
  await wait_for(() => asked.includes('new00002'));
  assert.deepEqual(asked, ['exit', 'old00001', 'exit', 'new00002']);
  assert.ok(times[0] > 0, 'the schedule says when it was set');
});

test('claude background runtime limit ends a hung process without retrying or capturing success', async t => {
  const previous = process.env.CODISCUSS_CLI_MAX_MS;
  process.env.CODISCUSS_CLI_MAX_MS = '100';
  t.after(() => { if (previous === undefined) delete process.env.CODISCUSS_CLI_MAX_MS; else process.env.CODISCUSS_CLI_MAX_MS = previous; });
  const f = await cli_delivery_fixture(t, 'claude', { events: [], linger: true });
  assert.equal(f.calls.length, 1);
  assert.equal(f.errors.length, 1);
  assert.match(f.errors[0], /CLI/);
  assert.deepEqual(f.failure_options, [{ retryable: false }]);
  assert.equal(f.exits, 0);
  assert.ok(f.calls[0].child.exitCode !== null || f.calls[0].child.signalCode !== null);
});

test('a stopped process tree is ended with taskkill on Windows and falls back to the plain kill otherwise', () => {
  const running = () => ({ pid: 4242, exitCode: null, signalCode: null });
  // taskkill is not waited for: its result arrives as `outcome` ('exit' with a code, or 'error') after the call returns.
  const attempt = (child, platform, outcome) => {
    const calls = []; let plain = 0;
    const killer = new EventEmitter();
    const result = kill_process_tree(child, () => { plain++; return 'plain'; }, platform, (...call) => {
      calls.push(call);
      if (outcome === 'throw') throw new Error('taskkill missing');
      return killer;
    });
    const before = plain;
    if (outcome === 'error') killer.emit('error', new Error('spawn failed'));
    else if (typeof outcome === 'number') killer.emit('exit', outcome);
    return { calls, plain, before, result };
  };
  const windows = attempt(running(), 'win32', 0);
  assert.deepEqual(windows.calls[0].slice(0, 2), ['taskkill', ['/PID', '4242', '/T', '/F']]);
  assert.equal(windows.plain, 0);
  assert.equal(windows.result, true);
  const failed = attempt(running(), 'win32', 128);
  assert.equal(failed.before, 0);
  assert.equal(failed.plain, 1);
  assert.equal(attempt(running(), 'win32', 'error').plain, 1);
  assert.equal(attempt(running(), 'win32', 'throw').plain, 1);
  assert.equal(attempt({ pid: undefined, exitCode: null, signalCode: null }, 'win32', 0).plain, 1);
  assert.equal(attempt({ pid: 4242, exitCode: 0, signalCode: null }, 'win32', 0).calls.length, 0);
  const posix = attempt(running(), 'linux', 0);
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
  // A console that cannot be reached leaves the task unstoppable; a reachable one is covered in test_chat_claude.mjs.
  const result = await adapter_of('claude').deliver({ ...profile, executable: process.execPath }, { session_id: original },
    { id: 'free-7', inbox: true, access_path, directory: home, prompt: '请先读取任务文件 free-7.task.json', on_note: () => {}, on_binding: session => bound.push(session) }, (...args) => { spawned.push(args); throw new Error('no process'); },
    undefined, { console: () => ({ ok: false, terminal: '', reason: 'AttachConsole 错误 5' }) });
  assert.deepEqual({ ...result, steer: typeof result.steer }, { session_id: original, status: 'accepted', capabilities: { stoppable: false, progress: true }, steer: 'function' },
    'the adapter reports it cannot stop a window it cannot reach, but reads its progress and takes interjections');
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
  // Shapes recorded by Claude Code 2.1.319-2.1.326: a background Bash or Monitor names its task and its report starts a
  // turn; a Monitor's events come without a tool call; a persistent Monitor lasts as long as the session, so nothing waits.
  const notice = (id, task) => line({ type: 'user', message: { role: 'user',
    content: `<task-notification>
<task-id>${task}</task-id>
${id ? `<tool-use-id>${id}</tool-use-id>
<status>completed</status>
` : ''}<summary>Monitor event</summary>
</task-notification>` } });
  const launch = (name, result) => line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_t', name, input: {} }] } })
    + line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_t', content: 'running in background' }] }, toolUseResult: result });
  for (const [name, result, waits] of [['Bash', { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1' }, true],
    ['Monitor', { taskId: 'b1', timeoutMs: 1_800_000, persistent: false }, true], ['Monitor', { taskId: 'b1', persistent: true }, false]]) {
    const task_file = join(home, `${randomUUID()}.jsonl`), task_seen = [];
    writeFileSync(task_file, '');
    watch_window_turn({ file: task_file, offset: 0, pid: process.pid, marker: 'free-9.task.json' }, { on_exit: () => task_seen.push('exit') }, { interval: 10 });
    appendFileSync(task_file, prompt + launch(name, result) + turn_end + notice('', 'b1') + turn_end);
    await delay(100);
    assert.deepEqual(task_seen, waits ? [] : ['exit'], `${name} ${JSON.stringify(result)}`);
    if (!waits) continue;
    appendFileSync(task_file, notice('toolu_t', 'b1') + turn_end);
    for (let waited = 0; !task_seen.length && waited < 2000; waited += 20) await delay(20);
    assert.deepEqual(task_seen, ['exit']);
  }
  // A task the turn stopped itself (TaskStop) never reports; a stop asked while the window rests on its tasks ends the watch.
  const bash = launch('Bash', { stdout: '', stderr: '', backgroundTaskId: 'b1' });
  const task_stop = line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_s', name: 'TaskStop', input: { task_id: 'b1' } }] } })
    + line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_s', content: 'stopped' }] },
      toolUseResult: { message: 'Successfully stopped task: b1', task_id: 'b1', task_type: 'local_bash' } });
  mkdirSync(join(home, 'sessions'), { recursive: true });
  writeFileSync(join(home, 'sessions', `${process.pid}.json`), JSON.stringify({ status: 'idle', updatedAt: Date.now() + 60_000 }));
  for (const stopped of [true, false]) {
    const task_file = join(home, `${randomUUID()}.jsonl`), task_seen = [], phases = [], lists = [];
    writeFileSync(task_file, '');
    const watch = watch_window_turn({ file: task_file, offset: 0, pid: process.pid, marker: 'free-9.task.json' },
      { on_exit: reason => task_seen.push(reason || 'exit'), on_activity: phase => phases.push(phase), on_background_tasks: list => lists.push(list) },
      { interval: 10, env: { CLAUDE_CONFIG_DIR: home } });
    appendFileSync(task_file, prompt + bash + (stopped ? task_stop : '') + line({ type: 'assistant', timestamp: new Date().toISOString(), message: { content: [{ type: 'text', text: '好' }] } }) + turn_end);
    await delay(100);
    if (!stopped) { assert.deepEqual([task_seen, phases], [[], ['waiting']], 'a window resting on its background tasks says so once'); watch.stop(); }
    for (let waited = 0; !task_seen.length && waited < 2000; waited += 20) await delay(20);
    assert.deepEqual(task_seen, [stopped ? 'exit' : '停止时原窗口在等后台任务，后台任务仍在运行']);
    assert.deepEqual(lists.at(-1).map(({ id, kind, state }) => ({ id, kind, state })), [{ id: 'toolu_t', kind: 'command', state: stopped ? 'stopped' : 'running' }]);
  }
  // A schedule the turn set is listed with when it fires next, and ends when the turn cancels it (2.1.326 shapes).
  const cron = line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_c', name: 'CronCreate', input: { cron: '*/5 * * * *', prompt: '查版本' } }] } })
    + line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_c', content: 'Scheduled' }] },
      toolUseResult: { id: '7ba9b755', humanSchedule: 'Every 5 minutes', recurring: true, durable: false, nextFireAt: 1_800_000_000_000 } })
    + line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_d', name: 'CronDelete', input: { id: '7ba9b755' } }] } })
    + line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_d', content: 'Deleted' }] } });
  const cron_file = join(home, `${randomUUID()}.jsonl`), cron_lists = [];
  writeFileSync(cron_file, '');
  watch_window_turn({ file: cron_file, offset: 0, pid: process.pid, marker: 'free-9.task.json' }, { on_exit: () => {}, on_background_tasks: list => cron_lists.push(list) }, { interval: 10 });
  appendFileSync(cron_file, prompt + cron + turn_end);
  for (let waited = 0; cron_lists.length < 2 && waited < 2000; waited += 20) await delay(20);
  assert.deepEqual(cron_lists.map(list => list.map(({ kind, title, schedule, next_at, state }) => ({ kind, title, schedule, next_at, state }))), [
    [{ kind: 'schedule', title: '查版本', schedule: 'Every 5 minutes', next_at: 1_800_000_000_000, state: 'running' }],
    [{ kind: 'schedule', title: '查版本', schedule: 'Every 5 minutes', next_at: 1_800_000_000_000, state: 'stopped' }]]);
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

test('a member invited with an existing conversation works in a copy, while a taken-over one keeps its original', async t => {
  const home = mkdtempSync(join(tmpdir(), 'codiscuss-copy-'));
  const previous = process.env.CLAUDE_CONFIG_DIR; process.env.CLAUDE_CONFIG_DIR = home;
  t.after(() => {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous;
    rmSync(home, { recursive: true, force: true });
  });
  mkdirSync(join(home, 'projects', 'work'), { recursive: true });
  writeFileSync(join(home, 'projects', 'work', 'picked-session.jsonl'), `${JSON.stringify({ type: 'user', uuid: 'u1', message: { content: '旧对话' } })}\n`);
  for (const [project_access, copied] of [['read', true], ['own', false]]) {
    const { store, config } = await free_fixture(t);
    config.participants.Claude = { adapter: 'claude', project_access, session_id: 'picked-session' };
    const bindings = [];
    await new FreeRoomRunner(config, store, async (adapter, binding) => { bindings.push({ ...binding }); return { status: 'accepted' }; }).tick();
    if (!copied) { assert.deepEqual(bindings, [{ session_id: 'picked-session' }]); continue; }
    assert.notEqual(bindings[0].session_id, 'picked-session');
    assert.deepEqual(bindings[0].fork, { from: 'picked-session', at: '' });
    assert.equal(store.binding('Claude').session_id, bindings[0].session_id);
  }
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

test('codex in a background instance without a desktop runs unsandboxed and never claims enforced read-only', t => {
  const task = { directory: tmpdir(), draft_directory: tmpdir() };
  const read_only = { adapter: 'codex_cli', cwd: tmpdir(), project_access: 'read' };
  assert.equal(capabilities_of('codex_cli').enforces_read_only, true);
  assert.equal(read_only_enforced(read_only), true);
  assert.equal(codex_developer_instructions(), '');
  process.env[NO_DESKTOP_VARIABLE] = '1';
  t.after(() => { delete process.env[NO_DESKTOP_VARIABLE]; });
  for (const project_access of ['read', 'write', 'auto']) {
    assert.deepEqual(codex_permissions({ cwd: tmpdir(), project_access }, task).args, ['--dangerously-bypass-approvals-and-sandbox']);
  }
  assert.equal(capabilities_of('codex_cli').enforces_read_only, false);
  assert.equal(capabilities_of('codex_cli').limits_directories, false);
  assert.equal(read_only_enforced(read_only), false);
  assert.match(codex_developer_instructions(), /不要创建、修改或删除项目文件/);
  assert.equal(software_rules(read_only, 'codiscuss.cmd'), '', 'the rule is at system level, not in the task text');
  assert.equal(capabilities_of('claude').no_sandbox, undefined);
});

test('codex on a personal Windows computer without a sandbox refuses 只读 and 可写 instead of widening access', t => {
  const home = mkdtempSync(join(tmpdir(), 'codex-no-sandbox-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { CODEX_HOME: home };
  for (const project_access of ['read', 'write']) assert.match(codex_sandbox_refusal({ project_access }, 'win32', env), /codex sandbox setup --elevated/);
  for (const project_access of ['full', 'auto', 'own']) assert.equal(codex_sandbox_refusal({ project_access }, 'win32', env), '');
  assert.equal(codex_sandbox_refusal({ project_access: 'read' }, 'linux', env), '');
  writeFileSync(join(home, 'config.toml'), '[windows]\nsandbox = "elevated"\n');
  assert.equal(codex_sandbox_refusal({ project_access: 'read' }, 'win32', env), '');
  rmSync(join(home, 'config.toml'));
  process.env[NO_DESKTOP_VARIABLE] = '1';
  t.after(() => { delete process.env[NO_DESKTOP_VARIABLE]; });
  assert.equal(codex_sandbox_refusal({ project_access: 'read' }, 'win32', env), '', 'a hosted instance runs on the task rules');
});

test('codex on Windows reads the sandbox chosen in its config', t => {
  const home = mkdtempSync(join(tmpdir(), 'codex-sandbox-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { CODEX_HOME: home };
  const config = join(home, 'config.toml');
  assert.equal(codex_sandbox_missing('win32', env), true, 'no config file');
  const cases = [['model = "m"\n', true], ['[windows]\nsandbox = "elevated"\n', false], ['[windows]\r\nsandbox = "unelevated"\r\n', false],
    ['windows.sandbox = "elevated"\n', false], ['windows = { sandbox = "elevated" }\n', false],
    ['[other]\nsandbox = "elevated"\n', true], ['[windows]\n# sandbox = "elevated"\n', true]];
  cases.forEach(([text, missing], index) => {
    writeFileSync(config, text);
    utimesSync(config, new Date(), new Date(Date.now() + (index + 1) * 2000));
    assert.equal(codex_sandbox_missing('win32', env), missing, text);
  });
  assert.equal(codex_sandbox_missing('linux', env), false);
});

test('tasks state whether the discussion project is read-only or writable', t => {
  const f = task_fixture(t);
  const project = mkdtempSync(join(tmpdir(), 'discussion-cwd-')); t.after(() => rmSync(project, { recursive: true, force: true }));
  const config = load_config_from(f, project, 'write');
  session_task(config);
  const read_task = () => JSON.parse(readFileSync(runtime_file(f.config.directory, 'free-1.task.json'), 'utf8'));
  const saved = read_task();
  assert.match(saved.instructions, /允许按请求修改.*并运行所需命令/);
  assert.equal(saved.project_access, 'write'); assert.equal(saved.cwd, project);
  // 必 10: each member drafts in its own folder inside the room's, never in another member's.
  assert.equal(saved.draft_directory, member_drafts(f.config, 'Codex'));
  assert.equal(dirname(saved.draft_directory), f.config.directory + '-drafts');
  assert.notEqual(member_drafts(f.config, 'Claude'), saved.draft_directory);
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
  const read_task = () => JSON.parse(readFileSync(runtime_file(f.config.directory, 'free-1.task.json'), 'utf8'));
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
    resolve, join, existsSync, readFileSync, writeFileSync, fetch, site_fetch, AbortSignal,
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
  const path = room_config(home, 'http://127.0.0.1:8765', 'room1');
  mkdirSync(join(home, 'local'));
  const db = new DatabaseSync(join(home, 'local', 'discuss.sqlite3'));
  db.exec('CREATE TABLE member_executions(id, room_id, status)');
  db.close();
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
  mkdirSync(join(config.directory, 'members', 'abc'), { recursive: true });
  const ended = ['free-5.task.json', 'free-5.access.json', 'claude-free-5.log', 'event-3.task.json', join('members', 'abc', 'free-6.access.json')].map(name => write(name, true));
  const kept = [write('free-7.access.json', true), write('free-9.task.json', false), write('manual-Claude.access.json', true), write(join('members', 'abc', 'free-7.task.json'), true)];
  const removed = sweep_service_home(home);
  assert.equal(removed.execution_files, ended.length);
  for (const file of ended) assert.ok(!existsSync(file), `${file} is removed`);
  for (const file of kept) assert.ok(existsSync(file), `${file} is kept`);
  assert.ok(existsSync(join(config.directory, 'runtime.sqlite3')));
});

test('remove_room_files clears read-only draft files and still removes sibling drafts and launches when one draft entry is locked', async t => {
  const home = mkdtempSync(join(tmpdir(), 'discussion-remove-tree-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const launch = join(home, 'launches', 'room-ro');
  const runtime = join(launch, 'runtime');
  mkdirSync(runtime, { recursive: true });
  writeFileSync(join(launch, 'config.json'), '{}');
  const ro_drafts = service_drafts(home, runtime);
  const ro_file = join(ro_drafts, 'pack', 'readonly.pack');
  mkdirSync(dirname(ro_file), { recursive: true });
  writeFileSync(ro_file, 'data');
  chmodSync(ro_file, 0o444);
  remove_room_files(home, join(launch, 'config.json'), runtime);
  assert.equal(existsSync(ro_drafts), false);
  assert.equal(existsSync(launch), false);

  if (process.platform === 'win32') {
    const blocked_launch = join(home, 'launches', 'room-locked');
    const blocked_runtime = join(blocked_launch, 'runtime');
    mkdirSync(blocked_runtime, { recursive: true });
    writeFileSync(join(blocked_launch, 'config.json'), '{}');
    const blocked_drafts = service_drafts(home, blocked_runtime);
    const held_dir = join(blocked_drafts, 'held');
    mkdirSync(held_dir, { recursive: true });
    const sibling = join(blocked_drafts, 'removable.txt');
    writeFileSync(sibling, 'bye');
    // A child process whose cwd sits inside drafts/ holds the directory without FILE_SHARE_DELETE on Windows.
    const holder = spawn(process.execPath, ['-e', 'process.stdout.write("ready"); setInterval(() => {}, 1000)'], { cwd: held_dir, stdio: ['ignore', 'pipe', 'ignore'] });
    await once(holder.stdout, 'data');
    try {
      assert.throws(() => remove_room_files(home, join(blocked_launch, 'config.json'), blocked_runtime));
      assert.equal(existsSync(sibling), false, 'deletable sibling drafts are still removed');
      assert.equal(existsSync(blocked_launch), false, 'launch folder is still removed despite draft error');
    } finally {
      holder.kill();
      await once(holder, 'exit');
    }
    remove_room_files(home, join(blocked_launch, 'config.json'), blocked_runtime);
    assert.equal(existsSync(blocked_drafts), false);
  }
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

  // A new member that takes over a removed member's name starts clean: the old session is neither resumed nor blocking.
  restarted_worker.runner.forget_member('Codex');
  await service.tick();
  assert.ok(!restarted_worker.runner.context_errors.has('Codex'));
  assert.equal(restarted_worker.runner.store.binding('Codex').session_id, undefined);

  f.room.session = { id: 1, status: 'active' };
  config.participants.Codex.adapter = 'codex_cli';
  writeFileSync(path, JSON.stringify(config));
  await service.tick();
  assert.match(restarted_worker.state.error, /讨论运行中不能切换 Codex 接入方式/);
});

test("a manual member invited under a removed member's name is adopted clean and can speak before any task", async t => {
  // Room 9524f49e42b5 (#3318–#3325): the removed Claude-2's context stayed under the name and failed the new Claude-2.
  const home = mkdtempSync(join(tmpdir(), 'discussion-service-reuse-'));
  const claude_home = join(home, 'claude-home'), cwd = join(home, 'project'), [old_id, new_id] = [randomUUID(), randomUUID()];
  mkdirSync(join(claude_home, 'projects', 'encoded'), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(claude_home, 'projects', 'encoded', `${new_id}.jsonl`), `${JSON.stringify({ type: 'user', cwd })}
`);
  const adopted = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      if (request.method === 'POST') adopted.push([request.url, JSON.parse(body)]);
      response.setHeader('Content-Type', 'application/json');
      response.end('{"ok":true}');
    });
  });
  await listen_local(server);
  save_launch_settings(home, { participants: { Claude: { adapter: 'claude', executable: process.execPath } } });
  const path = join(home, 'config.json');
  writeFileSync(path, JSON.stringify(with_members({ site: `http://127.0.0.1:${server.address().port}`, room: 'room', token: 'x'.repeat(32),
    mode: 'free', cwd, data_directory: join(home, 'runtime'),
    participants: { 'Claude-2': { adapter: 'claude', executable: process.execPath, cwd, session_id: old_id } } })));
  register_room(home, path);
  const forgotten = [];
  const room = { free: { members: [{ id: 340, name: 'Claude-2', access: 'manual', status: 'active', registered_at: 1, reported_session: new_id, reported_client: 'claude' }] } };
  const service = new DiscussionService(home, () => ({ room, stop_children() {}, tick: async () => 'idle', forget_member: name => forgotten.push(name) }));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = claude_home;
  t.after(async () => {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous;
    await service.close(); await new Promise(done => server.close(done)); rmSync(home, { recursive: true, force: true });
  });
  await service.tick();
  assert.deepEqual(forgotten, ['Claude-2'], 'what this machine kept for the removed member under that name is dropped first');
  assert.equal(load_config(path).participants['Claude-2'].session_id, new_id);
  assert.deepEqual(adopted.map(([url, body]) => [url, body.action, body.session_id]), [['/api/rooms/room/members/340', 'adopt', new_id]]);
  // Its window may speak proactively at once: the service leaves it a credential beside its task ones, with no execution.
  const proactive = JSON.parse(readFileSync(join(home, 'runtime', 'members', createHash('sha256').update('Claude-2').digest('hex').slice(0, 16), 'proactive.access.json'), 'utf8'));
  assert.deepEqual([proactive.room, proactive.member, proactive.token, proactive.session_id, proactive.execution_id],
    ['room', 'Claude-2', adopted[0][1].token, new_id, undefined]);
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
          ...(state.schedule_stopped_at ? { schedule_stopped_at: state.schedule_stopped_at } : {}),
          ...(state.rewind === undefined ? {} : { rewind: state.rewind }) }, ...state.others],
        executions: state.executions.filter(item => ['dispatched', 'started'].includes(item.status)) };
    } else if (url === '/executions') {
      let execution = state.executions.find(item => item.client_id === body.client_id);
      // Like the website: the host's fired schedule opens one with a request on a notice of its own.
      if (!execution && body.scheduled) {
        execution = { id: state.executions.length + 1, client_id: body.client_id, status: 'dispatched', member: 'Claude', scheduled: body.scheduled,
          requests: [{ id: 60, message_id: 98, purpose: 'scheduled', status: 'delivering' }] };
        state.executions.push(execution);
      }
      // Like the website: a follow-up (续报) of an ended execution carries one request hung on its answer.
      if (!execution && body.follows) {
        execution = { id: state.executions.length + 1, client_id: body.client_id, status: 'dispatched', member: 'Claude', follows: body.follows, followup_of: body.follows,
          reports: body.reports, requests: [{ id: 50, message_id: 99, purpose: 'followup', status: 'delivering' }] };
        state.executions.push(execution);
      }
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
        if (state.before_fail && !(await state.before_fail(execution))) {
          response.writeHead(execution.status === 'completed' ? 409 : 503); response.end('{}'); return;
        }
        execution.status = 'failed'; execution.result = body.reason;
        const failed_request = execution.requests.find(item => item.purpose === 'discuss' && item.session_id);
        if (failed_request) state.pending = [{ id: 90, purpose: 'discuss_host', session_id: failed_request.session_id,
          cause_kind: 'request_failed', source_message_id: failed_request.message_id }];
      }
      if (body?.action === 'release') { execution.status = 'cancelled'; state.pending = execution.requests; }
      if (body?.action === 'quiet') execution.status = 'completed';
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

test('installed cleanup skill can recover dispatch from legacy drafts without deleting unique work', async t => {
  const { state, store, config } = await free_fixture(t);
  const { install_skills } = await import('../runner/discussion_skills.mjs');
  const { measure, block_reason } = await import('../runner/storage_guard.mjs');
  const home = join(config.directory, 'custom-home'), skills = join(config.directory, 'skills');
  config.draft_directory = join(home, 'drafts', 'room');
  const member = join(config.draft_directory, 'member');
  mkdirSync(member, { recursive: true });
  install_skills(skills, join(home, 'manifest.json'));
  const script = (file, ...args) => spawnSync(process.platform === 'win32' ? 'python' : 'python3',
    [join(skills, 'codiscuss-draft-cleanup', file), '--home', home, ...args], { encoding: 'utf8' });
  const archived = Buffer.alloc(4096, 65);
  for (const name of ['keep.zip', 'drop.zip']) writeFileSync(join(member, name), archived);
  writeFileSync(join(member, 'only.md'), 'unique');
  let sent = 0;
  const runner = new FreeRoomRunner(config, store, async () => { sent++; return { status: 'accepted' }; });
  runner.storage_reason = async () => block_reason(await measure(home), 'room', null, { room_limit: 6000 });
  await runner.tick();
  assert.equal(state.executions[0].status, 'failed');
  assert.equal(sent, 0);
  assert.match(script('scan.py').stdout, /8198\s+room\/member\/legacy/);
  const pair = ['--keep', 'room/member/keep.zip', '--drop', 'room/member/drop.zip'];
  assert.equal(script('cleanup.py', ...pair).status, 0);
  assert.ok(existsSync(join(member, 'drop.zip')));
  assert.equal(script('cleanup.py', ...pair, '--apply').status, 0);
  assert.deepEqual(readFileSync(join(member, 'keep.zip')), archived);
  assert.equal(readFileSync(join(member, 'only.md'), 'utf8'), 'unique');
  state.pending = [{ id: 3, message_id: 11 }];
  await runner.tick();
  assert.equal(sent, 1);
});

test('idle storage stays cached and concurrent retries verify the whole blocked home immediately', async t => {
  const { config, state, store } = await free_fixture(t);
  const { GIB, block_reason } = await import('../runner/storage_guard.mjs');
  config.draft_directory = join(config.directory, 'drafts', 'room');
  let total = 11 * GIB, scans = 0, delivered = 0;
  const service = new DiscussionService(config.directory, undefined, undefined, {
    disk_free: () => ({ available_bytes: 40 * GIB, reserve_bytes: GIB }),
      measure: async path => { assert.equal(path, config.directory); scans++; return { total_bytes: total, rooms: {}, draft_bytes: 0 }; },
    block_reason,
  });
  const runner = service.create_runner(config, store, () => {});
  runner.deliver = async () => { delivered++; return { status: 'accepted' }; };
  service.workers.set('room', { config, runner, state: { room: config.room, site: config.site } });
  await runner.tick();
  assert.equal(state.executions[0].status, 'failed');
  service.monitor_storage(false, Date.now() + 60000);
  assert.equal(scans, 1);
  const reasons = await Promise.all([runner.storage_reason(true), runner.storage_reason(true)]);
  assert.ok(reasons.every(Boolean));
  assert.equal(scans, 2);
  total = GIB;
  assert.equal(delivered, 0);
  state.pending = [{ id: 3, message_id: 11 }];
  await runner.tick();
  assert.equal(delivered, 1);
  assert.equal(scans, 3);
});

test('room draft pressure prevents dispatch to an app without stop support', async t => {
  const { config, state, store } = await free_fixture(t);
  const { block_reason } = await import('../runner/storage_guard.mjs');
  config.participants.Claude.adapter = 'codex';
  let deliveries = 0;
  const runner = new FreeRoomRunner(config, store, async () => { deliveries++; });
  runner.storage_reason = stoppable => block_reason({ rooms: { room: 80 } }, 'room', null, { stoppable, room_limit: 100 });
  await runner.tick();
  assert.equal(deliveries, 0);
  assert.equal(state.executions[0].status, 'failed');
  assert.match(state.executions[0].result, /80%/);
});

test('storage guard rejects a reserved execution before delivery and records the quota reason', async t => {
  const { state, store, config } = await free_fixture(t);
  let sent = 0;
  const runner = new FreeRoomRunner(config, store, async () => { sent++; });
  runner.storage_reason = async () => 'Room drafts exceed 1 GiB';
  await runner.tick();
  assert.equal(sent, 0);
  assert.equal(state.executions[0].status, 'failed');
  assert.equal(state.executions[0].result, 'Room drafts exceed 1 GiB');
});

test('storage guard stops only a stoppable delivery and reclaims its failed scratch under pressure', async t => {
  const { state, store, config } = await free_fixture(t);
  const { block_reason, disk_free } = await import('../runner/storage_guard.mjs');
  const disk = disk_free(config.directory, { statfs: () => ({ bavail: 1, blocks: 1e8, bsize: 4096 }) });
  const reason = block_reason({ rooms: {}, draft_bytes: 0, total_bytes: 0 }, 'room', disk);
  assert.ok(reason);
  let stopped = false, scratch;
  const child = Object.assign(new EventEmitter(), { kill() { stopped = true; this.emit('close'); } });
  const runner = new FreeRoomRunner(config, store, async (profile, binding, task) => {
    scratch = task.scratch_directory;
    task.on_process(child);
    return { status: 'accepted', capabilities: { stoppable: false } };
  });
  await runner.tick();
  await runner.stop_for_storage(reason);
  assert.equal(stopped, false);
  await runner.report_delivery(1, { stoppable: true, progress: true }, 'Claude');
  await runner.stop_for_storage(reason);
  assert.equal(stopped, true);
  assert.equal(state.executions[0].result, reason);
  await runner.tick();
  assert.ok(existsSync(scratch));
  assert.equal(runner.reclaim_failed_scratch(), true);
  assert.equal(existsSync(scratch), false);
});

test('storage stops all eligible processes before reporting and retries the original failure after an outage', async t => {
  const { state, store, config } = await free_fixture(t);
  for (const [id, name] of [[8, 'Second'], [9, 'Third']]) {
    state.others.push({ id, name, role: 'member', pending: [{ id, message_id: id }] });
    config.participants[name] = config.participants.Claude;
    config.members[name] = config.members.Claude;
  }
  const killed = [];
  const runner = new FreeRoomRunner(config, store, async (_, binding, task) => {
    const id = task.api_context.execution_id;
    const child = Object.assign(new EventEmitter(), { kill() { killed.push(id); this.emit('close'); } });
    task.on_process(child);
    return { status: 'accepted', capabilities: { stoppable: id !== 3 } };
  });
  await runner.tick();
  let unblock, observed;
  const gate = new Promise(resolve => { unblock = resolve; });
  const entered = new Promise(resolve => { observed = resolve; });
  state.before_fail = async execution => {
    if (execution.id !== 1) return true;
    observed(); await gate; return false;
  };
  const stopped = runner.stop_for_storage('quota exceeded');
  assert.deepEqual(killed.sort(), [1, 2]);
  await entered;
  unblock();
  await assert.rejects(stopped);
  assert.equal(state.executions[1].result, 'quota exceeded');
  state.before_fail = null;
  await runner.tick();
  assert.equal(state.executions[0].result, 'quota exceeded');
  assert.ok(['started', 'dispatched'].includes(state.executions[2].status));
  assert.deepEqual(killed.sort(), [1, 2]);
});

test('software kept for background work after a completed answer brings its report back as a follow-up', async t => {
  const { state, store, config } = await free_fixture(t);
  config.participants.Claude = { ...config.participants.Claude, adapter: 'claude' };
  const killed = [];
  let delivered, child;
  const runner = new FreeRoomRunner(config, store, async (_, binding, task) => {
    delivered = task;
    child = Object.assign(new EventEmitter(), { lingers: () => true, linger: () => true,
      kill() { killed.push(task.api_context.execution_id); this.emit('close'); } });
    task.on_process(child);
    return { status: 'accepted', capabilities: { stoppable: true, progress: true }, steer: () => true };
  });
  await runner.tick();
  assert.equal(await delivered.on_followup([{ id: 'b1' }], child), true, 'a report while the execution runs belongs to it');
  assert.equal(state.executions.length, 1);
  state.executions[0].status = 'completed';
  await runner.tick();
  assert.deepEqual([killed, runner.row('Claude').status], [[], 'idle'], 'kept for its background work, the member is free');
  assert.equal(await delivered.on_followup([{ id: 'b1', status: 'completed', summary: '测试通过' }], child, { steer: false }), true);
  const followup = state.executions[1];
  assert.deepEqual([followup.follows, followup.reports], [1, [{ id: 'b1', status: 'completed', summary: '测试通过' }]]);
  assert.deepEqual([runner.row('Claude').execution_id, runner.row('Claude').status], [2, 'running']);
  assert.ok(state.calls.includes('POST /executions/2 delivery'), 'the follow-up reports what the delivery can do');
  assert.deepEqual([runner.delivery_caps.get(2).steer, runner.steers.has(2)], [false, false], 'a turn that takes no interjection offers none');
  // The report's turn goes on through the first delivery's callbacks, now bound to the follow-up.
  delivered.on_activity('writing');
  delivered.on_note('后台测试通过了');
  delivered.on_exit();
  child.emit('close');
  await runner.tick();
  assert.deepEqual([state.posts?.at(-1).body.execution_id, state.posts?.at(-1).body.text], [2, '后台测试通过了']);
  // New work for the member first stops software kept for background reports, and starts once it closed.
  state.pending = [{ id: 3, message_id: 13 }];
  await runner.tick();
  state.executions.at(-1).status = 'completed';
  await runner.tick();
  assert.deepEqual(killed, []);
  const before = state.executions.length;
  state.pending = [{ id: 4, message_id: 14 }];
  await runner.tick();
  assert.deepEqual([killed, state.executions.length], [[3], before], 'the session is not resumed beside the kept process');
  await runner.tick();
  assert.equal(state.executions.length, before + 1);
  // A stopped execution is not carried on; a report that only says work was stopped or killed keeps following the rest.
  state.executions.at(-1).status = 'cancelled';
  assert.equal(await delivered.on_followup([{ id: 'b2', status: 'completed' }], child), false);
  assert.equal(await delivered.on_followup([{ id: 'b3', status: 'killed' }, { id: 'b4', status: 'stopped' }], child), 'keep');
});

test('a follow-up whose turn ends without an answer ends quietly, whether the adapter reports an exit or only the turn end', async t => {
  for (const ending of ['exit', 'turn_end', 'restarted', 'orphaned', 'refused']) {
    const { state, store, config } = await free_fixture(t);
    config.participants.Claude = { ...config.participants.Claude, adapter: 'claude' };
    let delivered, child;
    let runner = new FreeRoomRunner(config, store, async (_, binding, task) => {
      delivered = task;
      // The restart case stands for an App turn: only the owner may stop it, so a later runner does not take it for a dead process.
      child = Object.assign(new EventEmitter(), { lingers: () => true, linger: () => true, kill() { this.emit('close'); },
        ...(ending === 'restarted' ? { stop_on_shutdown: false } : {}) });
      task.on_process(child);
      return { status: 'accepted', capabilities: { stoppable: true, progress: true } };
    });
    await runner.tick();
    state.executions[0].status = 'completed';
    await runner.tick();
    assert.equal(await delivered.on_followup([{ id: 'b1', status: 'completed' }], child), true);
    if (ending === 'refused') {
      // A refused operation in that turn is reported, so the room sees what was refused.
      delivered.on_exit('有操作被拒绝'); child.emit('close');
      await runner.tick();
      assert.deepEqual([state.executions[1].status, state.calls.includes('POST /executions/2 quiet')], ['failed', false]);
      assert.match(state.executions[1].result, /有操作被拒绝/);
      continue;
    }
    // A runner restarted meanwhile knows the follow-up from the site, not from its memory.
    if (ending === 'restarted') {
      const previous = delivered;
      runner = new FreeRoomRunner(config, store, async () => ({ status: 'accepted' }));
      await runner.tick();
      runner.turn_ended.add(2);
      delivered = previous;
    } else if (ending === 'orphaned') {
      // The software's turn died with the runner: a later runner neither resumes nor fails the follow-up.
      runner = new FreeRoomRunner(config, store, async () => ({ status: 'accepted' }));
      await runner.tick();
    } else if (ending === 'exit') { delivered.on_exit(); child.emit('close'); } else delivered.on_turn_end();
    await runner.tick();
    assert.equal(state.executions[1].status, 'completed', ending);
    assert.ok(state.calls.includes('POST /executions/2 quiet'), ending);
    assert.ok(!state.calls.includes('POST /executions/2 fail'), `${ending}: no failure card and no host wake-up`);
    assert.equal(runner.row('Claude').status, 'idle');
  }
});

test('only the host\'s schedule fire opens a scheduled execution, and a busy host keeps it in the execution it runs', async t => {
  const { state, store, config } = await free_fixture(t);
  config.participants.Claude = { ...config.participants.Claude, adapter: 'claude' };
  let delivered;
  const runner = new FreeRoomRunner(config, store, async (_, binding, task) => {
    delivered = task;
    task.on_process(Object.assign(new EventEmitter(), { kill() { this.emit('close'); } }));
    return { status: 'accepted', capabilities: { stoppable: true, progress: true }, steer: () => true };
  });
  await runner.tick();
  const schedule = { id: '7ba9b755', schedule: 'Every 5 minutes', prompt: '查线上版本', set_at: Date.now() - 60_000 };
  const handle = () => Object.assign(new EventEmitter(), { kill() { this.emit('close'); } });
  assert.equal(await delivered.on_schedule(schedule, handle()), 'stop', 'a member\'s schedule is only shown');
  state.claude_role = 'host';
  await runner.tick();
  assert.equal(await delivered.on_schedule(schedule, handle()), 'stop', 'a host not granted "推进方式" is treated as a member');
  config.host_permissions = { items: ['pacing'] };
  runner.adopt(config);
  assert.equal(await delivered.on_schedule(schedule, handle()), false, 'a busy host keeps the fire in the execution it runs');
  state.executions[0].status = 'completed';
  state.posts = [];
  // The owner stopped the host after this schedule was set: it no longer comes in; one set afterwards does.
  state.schedule_stopped_at = Date.now() - 30_000;
  await runner.tick();
  assert.equal(await delivered.on_schedule(schedule, handle()), 'drop');
  assert.equal(state.executions.length, 1);
  schedule.set_at = Date.now();
  const fired = handle();
  assert.equal(await delivered.on_schedule(schedule, fired), true);
  const run = state.executions.at(-1);
  assert.deepEqual([run.scheduled, runner.row('Claude').execution_id, runner.row('Claude').status], [schedule, run.id, 'running']);
  assert.deepEqual([runner.delivery_caps.get(run.id).steer, runner.steers.has(run.id)], [false, false]);
  // Its turn found nothing to do: it ends quietly.
  delivered.on_turn_end();
  fired.emit('close');
  await runner.tick();
  assert.ok(state.calls.includes(`POST /executions/${run.id} quiet`));
  assert.equal(run.status, 'completed');
});

test('a later runner ends software an earlier one kept for background reports and could not stop', async t => {
  const { store, config } = await free_fixture(t);
  const kept = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  t.after(() => { try { kept.kill(); } catch { /* Already ended. */ } });
  // Another live process under a recorded pid whose start time differs (the pid was reused) is left alone.
  const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  t.after(() => { try { other.kill(); } catch { /* Already ended. */ } });
  const started = process_started(kept.pid);
  assert.ok(started, 'the start time can be read');
  const record = (pid, fields) => store.db.prepare('INSERT INTO metadata VALUES (?,?)')
    .run(`lingering:${pid}`, JSON.stringify({ instance: 'crashed-runner', member: 'Claude', execution_id: 1, ...fields }));
  record(kept.pid, { started });
  record(other.pid, { started: 'an earlier process' });
  const closed = new Promise(resolve => kept.once('exit', resolve));
  await new FreeRoomRunner(config, store, async () => ({ status: 'accepted' })).tick();
  await closed;
  for (const pid of [kept.pid, other.pid]) assert.equal(store.db.prepare('SELECT 1 FROM metadata WHERE key=?').get(`lingering:${pid}`), undefined);
  assert.equal(other.exitCode, null, 'a reused pid is not ended');
});

test('a completion racing the storage failure remains completed', async t => {
  const { state, store, config } = await free_fixture(t);
  const runner = new FreeRoomRunner(config, store, async (_, binding, task) => {
    const child = Object.assign(new EventEmitter(), { kill() { this.emit('close'); } });
    task.on_process(child);
    return { status: 'accepted', capabilities: { stoppable: true } };
  });
  await runner.tick();
  let reports = 0;
  state.before_fail = async execution => {
    reports++;
    execution.status = 'completed';
    return false;
  };
  await runner.stop_for_storage('quota exceeded');
  await runner.tick();
  assert.equal(reports, 1);
  assert.equal(state.executions[0].status, 'completed');
  assert.equal(runner.row('Claude').status, 'idle');
});

for (const status of ['cancelled', 'failed']) test(`scratch remains tracked after ${status} until exit is confirmed`, async t => {
  const { state, store, config } = await free_fixture(t);
  let ended;
  const runner = new FreeRoomRunner(config, store, async (_, binding, task) => {
    ended = task.on_turn_end;
    return { status: 'accepted', capabilities: { stoppable: false, ends: true } };
  });
  await runner.tick();
  state.executions[0].status = status;
  await runner.tick();
  assert.equal(runner.reclaim_failed_scratch(), false);
  assert.ok(store.db.prepare("SELECT 1 FROM metadata WHERE key='scratch:1'").get());
  ended();
  await runner.tick();
  assert.equal(runner.reclaim_failed_scratch(), true);
  assert.ok(!existsSync(join(member_drafts(config, 'Claude'), '.scratch', '1')));
});

test('restarted runner keeps uncertain scratch and accepts a confirmed cancellation receipt', async t => {
  const { state, store, config } = await free_fixture(t);
  let ended;
  const first = new FreeRoomRunner(config, store, async (_, binding, task) => {
    ended = task.on_turn_end;
    return { status: 'accepted', capabilities: { stoppable: false, ends: true } };
  });
  await first.tick();
  state.executions[0].status = 'cancelled';
  const restarted = new FreeRoomRunner(config, store);
  await restarted.tick();
  assert.equal(restarted.reclaim_failed_scratch(), false);
  ended();
  await first.report_stop('Claude', 1);
  assert.equal(state.executions[0].stop_result, 'stopped');
  await restarted.tick();
  assert.equal(restarted.reclaim_failed_scratch(), true);
});

test('scratch cleanup accepts a linked service home and rejects a redirected member folder', async t => {
  const { store, config } = await free_fixture(t);
  const root = join(config.directory, 'real-home'), home = join(config.directory, 'linked-home');
  mkdirSync(root);
  symlinkSync(root, home, process.platform === 'win32' ? 'junction' : 'dir');
  config.draft_directory = service_drafts(home, config.directory);
  const runner = new FreeRoomRunner(config, store);
  const member = member_drafts(config, 'Claude'), path = join(member, '.scratch', '1');
  const record = () => store.db.prepare('INSERT INTO metadata VALUES (?,?)')
    .run('failed-scratch:1', JSON.stringify({ member: 'Claude', id: 1, ended: 1 }));
  mkdirSync(path, { recursive: true });
  record();
  assert.equal(runner.reclaim_failed_scratch(), true);
  assert.equal(existsSync(path), false);
  rmSync(member, { recursive: true });
  const outside = join(config.directory, 'outside');
  mkdirSync(join(outside, '.scratch', '1'), { recursive: true });
  symlinkSync(outside, member, process.platform === 'win32' ? 'junction' : 'dir');
  record();
  assert.throws(() => runner.reclaim_failed_scratch(), /Redirected scratch path/);
  assert.ok(existsSync(join(outside, '.scratch', '1')));
  assert.ok(store.db.prepare("SELECT 1 FROM metadata WHERE key='failed-scratch:1'").get());
});

test('storage guard removes completed scratch while retaining member drafts and legacy directories', async t => {
  const { state, store, config } = await free_fixture(t);
  const guard = await import('../runner/storage_guard.mjs');
  const home = join(config.directory, 'service-home');
  config.draft_directory = join(home, 'drafts', 'room');
  mkdirSync(home, { recursive: true });
  const measured = [];
  const service = new DiscussionService(home, undefined, undefined, { ...guard,
    disk_free: () => ({ available_bytes: 40 * guard.GIB, reserve_bytes: guard.GIB }),
    measure: (path, options) => { measured.push(path); return guard.measure(path, options); },
    block_reason: (snapshot, room, disk, options) => guard.block_reason(snapshot, room, disk, { ...options, room_limit: 3 }),
  });
  const runner = service.create_runner(config, store, () => {});
  runner.deliver = async () => ({ status: 'accepted' });
  await runner.tick();
  const draft = member_drafts(config, 'Claude'), scratch = join(draft, '.scratch');
  writeFileSync(join(draft, 'answer.md'), 'keep');
  mkdirSync(join(scratch, '99'));
  state.executions[0].status = 'completed';
  await runner.tick();
  assert.equal(existsSync(join(scratch, '1')), false);
  assert.ok(existsSync(join(scratch, '99')));
  assert.equal(readFileSync(join(draft, 'answer.md'), 'utf8'), 'keep');
  assert.deepEqual(measured, [home, draft]);
  assert.equal(service.storage.rooms.room, 4);
  const reasons = await Promise.all([runner.storage_reason(true), runner.storage_reason(true)]);
  assert.ok(reasons.every(Boolean));
  assert.deepEqual(measured, [home, draft, config.draft_directory]);
  writeFileSync(join(draft, 'answer.md'), 'ok');
  assert.equal(await runner.storage_reason(true), '');
  assert.equal(measured.at(-1), config.draft_directory);
});

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
    if (answer.choice === 'wait' && posted === 'continue') {
      assert.deepEqual(f.state.decisions[0].label_text, {
        template: '倾向等用户回复，把握不足，唤醒主持人', params: {},
      }, 'the uncertain wake-up uses its own whole template, without replacing a substring');
    }
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

test('a blocking question left waiting reaches Weixin once per version, outside a goal too, without waking the host', async t => {
  const f = await free_fixture(t);
  f.state.pending = [];
  const now = Math.floor(Date.now() / 1000);
  const question = { id: 12, version: 1, status: 'waiting_user', blocking: true, asker: 'Codex', waiting_since: now,
    questions: [{ id: 'draft', question: '用哪一稿？', multiSelect: false, free_text: true, options: [{ id: 'B', label: 'B 稿', recommended: true }, { id: 'A', label: 'A 稿' }] }] };
  f.state.room.free = { ...(f.state.room.free || {}), questions: [question, { ...question, id: 13, blocking: false }] };
  const sent = [];
  const runner = new FreeRoomRunner(f.config, f.store, async () => ({ status: 'accepted' }));
  runner.notifier = { ready: () => true, sent: key => sent.some(item => item.key === key), send: async notice => { sent.push(notice); return { status: 'sent', number: sent.length }; } };
  await runner.tick();
  assert.equal(sent.length, 0, 'not before the owner has had a while');
  assert.equal(runner.idle(), false, 'the service keeps ticking until the notice is due');
  f.state.room.free.questions[0] = { ...question, waiting_since: now - 301 };
  await runner.tick();
  await runner.tick();
  assert.equal(sent.length, 1, 'once per question and version; a non-blocking question is not sent');
  assert.deepEqual([sent[0].question, sent[0].paragraphs[2]], [{ id: 12, version: 1 }, '1. B 稿（推荐）']);
  f.state.room.free.questions[0] = { ...question, version: 2, waiting_since: now - 301 };
  await runner.tick();
  assert.deepEqual(sent.map(item => item.question.version), [1, 2], 'a recommendation makes a new version, told again');
  assert.equal(f.state.goal_posts?.length || 0, 0, 'the host is not woken');
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
    resolve, join, existsSync, readFileSync, writeFileSync, fetch, site_fetch, AbortSignal,
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

test('an unnamed route waits for model failure and records it before host delivery', async t => {
  const { state, config, store } = await group_fixture(t);
  state.pending = [{ id: 1, message_id: 11, purpose: 'route' }];
  let fail;
  const pending = new Promise((resolve, reject) => { fail = reject; });
  const runner = new FreeRoomRunner(config, store, async () => ({ status: 'accepted' }), () => {}, () => pending);
  await runner.tick();
  await runner.tick();
  assert.equal(state.executions.length, 0);
  fail(new Error('offline'));
  await Promise.all(runner.decisions);
  assert.equal(state.decisions.length, 1);
  assert.equal(state.decisions[0].label_text.template, '没有模型判断：{value1}');
  assert.equal(state.decisions[0].after_message_id, 11);
  assert.equal(runner.saved_suggestion(1).decision_id, 1);
  await runner.tick();
  assert.equal(state.executions.length, 1);
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
  const task = JSON.parse(readFileSync(runtime_file(config.directory, `free-${state.executions[0].id}.task.json`), 'utf8'));
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
  const task = JSON.parse(readFileSync(runtime_file(config.directory, 'free-1.task.json'), 'utf8'));
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
  assert.doesNotMatch(readFileSync(delivered[0].access_path, 'utf8') + readFileSync(runtime_file(config.directory, 'free-1.task.json'), 'utf8'), /owner-credential/);
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
  const observed = ['src/index.js', 'D:/extra/src/index.js', 'index.js'];
  assert.deepEqual(edited_changes(observed, ['../extra/src/index.js'], 'D:/proj', 'win32'), ['D:/extra/src/index.js']);
  const claude_event = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: String.raw`D:\proj\剧本\库存.yaml` } },
    { type: 'tool_use', name: 'Read', input: { file_path: String.raw`D:\proj\other.md` } }] } };
  const codex_event = { type: 'item.completed', item: { type: 'file_change', changes: [{ path: '/proj/剧本/成长.yaml', kind: 'update' }] } };
  assert.deepEqual(adapter_of('claude').events.edits(claude_event), [String.raw`D:\proj\剧本\库存.yaml`]);
  assert.deepEqual(adapter_of('codex_cli').events.edits(codex_event), ['/proj/剧本/成长.yaml']);
  const changes = ['剧本/库存.yaml', '剧本/成长.yaml', '剧本/第06集.md'];
  assert.deepEqual(edited_changes(changes, adapter_of('claude').events.edits(claude_event), 'D:/proj', 'win32'), ['剧本/库存.yaml']);
  assert.deepEqual(edited_changes(changes, adapter_of('codex_cli').events.edits(codex_event), '/proj', 'linux'), ['剧本/成长.yaml']);
  // A writing shell command claims the paths it names; a reading one claims none.
  const shell = command => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } });
  const script = "python - <<'EOF'\np='剧本/第06集.md'\nopen(p,'w').write(s)\nEOF";
  assert.deepEqual(edited_changes(changes, adapter_of('claude').events.edits(shell(script)), 'D:/proj', 'win32'), ['剧本/第06集.md']);
  assert.deepEqual(edited_changes(changes, adapter_of('claude').events.edits(shell('sed -i s/a/b/ 剧本/库存.yaml')), 'D:/proj', 'win32'), ['剧本/库存.yaml']);
  assert.deepEqual(adapter_of('claude').events.edits(shell('grep -n x 剧本/库存.yaml 2>&1 | head')), []);
  // agy 1.5.x: a finished write_file / edit_file names its Path; a running or failed one, or a read, claims nothing.
  const agy = (tool_name, parameters, state = 'DONE', extra = {}) => ({ event: 'step_update', step_update: { step_type: 'tool', state, tool_name, tool_info: { parameters, ...extra } } });
  const agy_edits = adapter_of('antigravity_cli').events.edits;
  assert.deepEqual(edited_changes(changes, agy_edits(agy('edit_file', { Path: String.raw`D:\proj\剧本\库存.yaml` })), 'D:/proj', 'win32'), ['剧本/库存.yaml']);
  assert.deepEqual(agy_edits(agy('write_file', { Path: String.raw`D:\proj\剧本\第06集.md` }, 'ACTIVE')), []);
  assert.deepEqual(agy_edits(agy('edit_file', { Path: String.raw`D:\proj\剧本\库存.yaml` }, 'DONE', { error: { message: 'denied' } })), []);
  assert.deepEqual(agy_edits(agy('read_file', { Path: String.raw`D:\proj\剧本\第06集.md` })), []);
  assert.deepEqual(edited_changes(changes, agy_edits(agy('run_command', { CommandLine: 'sed -i s/a/b/ 剧本/成长.yaml' }, 'DONE', { output: 'Command exited with code 0.\n' })), 'D:/proj', 'win32'), ['剧本/成长.yaml']);
  // agy marks a non-zero run_command step DONE while putting the exit code in output: failed commands claim nothing.
  assert.deepEqual(agy_edits(agy('run_command', { CommandLine: 'echo hi > README.md' }, 'DONE', { output: 'Command exited with code 1.\nerror' })), []);
});

test('shell command write extraction ignores copy sources, redirected inputs and read-only compound segments', () => {
  // Concurrent edits to read-only source/input files must never be attributed to the agent.
  const observed = ['src/input.js', 'out/result.js', 'README.md', 'Makefile', 'docs/my file.md', 'err.log', 'fix.patch'];
  const claim = command => edited_changes(observed, shell_written_paths(command), 'D:/proj', 'win32');
  assert.deepEqual(claim('cp src/input.js out/result.js'), ['out/result.js']);
  assert.deepEqual(claim('Copy-Item -Path src/input.js -Destination out/result.js'), ['out/result.js']);
  assert.deepEqual(claim('cat src/input.js > out/result.js'), ['out/result.js']);
  assert.deepEqual(claim('cat < src/input.js > out/result.js'), ['out/result.js']);
  assert.deepEqual(claim('cat src/input.js 2> err.log'), []);
  assert.deepEqual(claim('git diff src/input.js && echo hi > README.md'), ['README.md']);
  assert.deepEqual(claim('grep foo src/input.js; Set-Content README.md hello'), ['README.md']);
  assert.deepEqual(claim('sed -i s/a/b/ Makefile'), ['Makefile']);
  assert.deepEqual(claim('echo hi > "docs/my file.md"'), ['docs/my file.md']);
  assert.deepEqual(claim('git apply fix.patch'), []);
  assert.deepEqual(claim("python - <<'PY'\nopen('src/input.js', 'r', encoding='ascii').read()\nPY"), []);
  assert.deepEqual(claim("python - <<'PY'\nprint(\"Path('src/input.js').write_text('x')\")\nPY"), []);
  // Unknown dynamic targets stay empty rather than blaming unrelated paths in the command.
  assert.deepEqual(shell_written_paths("node -e \"import fs from 'node:fs'; import { x } from './src/input.js'; fs.writeFileSync(process.env.OUT, x)\""), []);
});

test('Codex CLI extracts literal PowerShell/Python command writes and ignores failed items', () => {
  const codex_edits = adapter_of('codex_cli').events.edits;
  const cmd_event = (command, exit_code = 0, status = 'completed') => ({ type: 'item.completed', item: { type: 'command_execution', command, exit_code, status } });
  // Desensitized multi-file Python here-string pattern (reassignment + tuple loop, as in execution #6120).
  const py_multi = '"C:\\\\WINDOWS\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" -Command "@\'\n'
    + "from pathlib import Path\np=Path('frontend/AnswerFiles.vue')\ns=p.read_bytes()\np.write_bytes(s)\n"
    + "for path,old,new in [('docs/guide/working.md','旧','新'),('docs/en/guide/working.md','old','new')]:\n"
    + " p=Path(path);s=p.read_bytes();p.write_bytes(s)\n'@ | python -X utf8 -\"";
  assert.deepEqual(codex_edits(cmd_event(py_multi)), ['frontend/AnswerFiles.vue', 'docs/guide/working.md', 'docs/en/guide/working.md']);
  // PowerShell [IO.File]::WriteAllText with Resolve-Path binding (as in execution #6140).
  const ps_io = `"C:\\\\WINDOWS\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" -Command '$p=Resolve-Path '"'.dev/docs/Ref_外部软件通信.md'\n"'$s=[IO.File]::ReadAllText($p)\n[IO.File]::WriteAllText($p,$s)'`;
  assert.deepEqual(codex_edits(cmd_event(ps_io)), ['.dev/docs/Ref_外部软件通信.md']);
  assert.deepEqual(codex_edits(cmd_event('Set-Content src/file.js hello')), ['src/file.js']);
  assert.deepEqual(codex_edits(cmd_event('Set-Content src/file.js hello', 1)), [], 'non-zero exit claims nothing');
  assert.deepEqual(codex_edits({ type: 'item.completed', item: { type: 'file_change', status: 'failed', changes: [{ path: 'src/file.js' }] } }), []);
});

test('Claude stream-json pairs tool_use with tool_result and drops failed tool edits', async () => {
  const { PassThrough } = await import('node:stream');
  const stream = new PassThrough();
  const seen = [];
  watch_events(adapter_of('claude'), stream, { on_edits: paths => seen.push(paths) });
  const lines = [
    { type: 'assistant', message: { content: [
      { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: 'src/ok.js' } },
      { type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: 'src/denied.js' } },
      { type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'cp src/in.js out/ok.js' } },
      { type: 'tool_use', id: 't4', name: 'Bash', input: { command: 'echo x > out/fail.js' } },
    ] } },
    { type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: 't1', content: 'ok', is_error: false },
      { type: 'tool_result', tool_use_id: 't2', content: 'permission denied', is_error: true },
      { type: 'tool_result', tool_use_id: 't3', content: '', is_error: false },
      { type: 'tool_result', tool_use_id: 't4', content: 'blocked', is_error: true },
    ] } },
  ];
  for (const item of lines) stream.write(`${JSON.stringify(item)}\n`);
  stream.end();
  await once(stream, 'close');
  assert.deepEqual(seen, [[], ['src/ok.js', 'out/ok.js']]);
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

test('a turn that carried only program notices ends quietly instead of failing', async t => {
  const { state, store, config } = await free_fixture(t);
  state.pending = [{ id: 1, message_id: 11, purpose: 'notice' }];
  const runner = new FreeRoomRunner(config, store, async (adapter, binding, task) => { setImmediate(() => task.on_exit()); return { status: 'accepted' }; });
  await runner.tick();
  await runner.tick();
  assert.equal(state.executions[0].status, 'completed');
  assert.ok(state.calls.includes('POST /executions/1 quiet'));
  assert.equal(state.calls.includes('POST /executions/1 fail'), false);
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

test('a command refused for something the member can correct resumes its session up to three times with what to change', async t => {
  const { state, store, config } = await free_fixture(t);
  const deliveries = [];
  const runner = new FreeRoomRunner(config, store, async (adapter, binding, task) => {
    deliveries.push(task.prompt);
    setImmediate(() => { task.on_denials([{ tool: 'run_command', detail: `codiscuss message post --body "\`x${deliveries.length}\`"`, retry_hint: '命令含有 `，改用 --body-file' }]); task.on_exit('运行了未授权的命令'); });
    return { status: 'accepted', session_id: 'session-1' };
  });
  for (let turn = 0; turn < 4; turn++) await runner.tick();
  assert.equal(deliveries.length, 4, 'the first turn and three corrections');
  assert.match(deliveries[1], /第 1 次提醒，之后还有 2 次改正机会[\s\S]*命令「codiscuss message post --body "`x1`"」被拒：命令含有 `/);
  assert.match(deliveries[3], /这是最后一次改正机会[\s\S]*`x1`[\s\S]*`x2`[\s\S]*`x3`/, 'each reminder lists every refusal so far');
  assert.notEqual(state.executions[0].status, 'failed');
  await runner.tick();
  assert.equal(deliveries.length, 4, 'a fourth refusal is not resumed');
  assert.equal(state.executions[0].status, 'failed');
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

test('a host that kept working after its dispatch keeps its turn running, moved onto the new execution', async t => {
  const { state, store, config } = await free_fixture(t);
  const child = Object.assign(new EventEmitter(), { killed: false, kill() { this.killed = true; this.emit('close'); } });
  let task;
  const runner = new FreeRoomRunner(config, store, async (adapter, binding, given) => {
    task = given; given.on_process(child); return { status: 'accepted', session_id: 'session-1' };
  });
  await runner.tick();
  // The host's keep_working dispatch: the site completes execution 1 and opens 2 to carry the same turn on.
  state.executions[0].status = 'completed';
  const now = Math.floor(Date.now() / 1000);
  state.executions.push({ id: 2, client_id: 'keep-working-1', status: 'dispatched', member: 'Claude', continues: 1,
    created_at: now, lease_until: now + 120, requests: [] });
  await runner.tick();
  assert.equal(child.killed, false, 'the running turn is not stopped');
  task.on_activity('writing'); task.on_note('改完了'); task.on_exit();
  await runner.tick();
  assert.deepEqual((state.posts || []).map(post => [post.body.execution_id, post.body.text]), [[2, '改完了']]);
});

test("an expert prompt is only the member's own text, and the API file rule is fixed in its system prompt", () => {
  assert.deepEqual(EXPERT_PROMPT_PRESETS, {}, 'must-know software rules are fixed by the runner, not replaceable presets');
  assert.equal(expert_prompt({ adapter: 'api' }), '');
  assert.equal(expert_prompt({ adapter: 'api', system_prompt: '  只读不写  ' }), '只读不写');
  // An API expert's own prompt cannot drop the rule about local files.
  const api = system_prompt({ participant: 'DeepSeek', role: 'member', mode: 'free', expert_prompt: '只读不写' });
  assert.match(api, /本地文件你读不到；消息附件用 read_attachment 按 ID 读取.*读不到的以其他成员贴出的为准，不凭文件名猜测.*缺信息就写明缺什么/);
});

test("a member's own prompt goes into the system prompt of a new session where possible, else once into each session's task text", () => {
  const profile = adapter => ({ adapter, system_prompt: '只看测试' });
  const fresh = expert_prompt_delivery('任务', profile('claude'), adapter_of('claude'), {}, false, null);
  const record = { session_id: 's1', hash: fresh.expert_prompt_hash };
  assert.match(fresh.system_text, /只看测试/);
  assert.equal(fresh.prompt, '任务');
  // A resumed session keeps the prompt it started with, and is given the current text again for after a compaction.
  const resumed = expert_prompt_delivery('任务', profile('claude'), adapter_of('claude'), { session_id: 's1' }, false, record);
  assert.equal(resumed.prompt, '任务');
  assert.match(resumed.system_text, /只看测试/);
  // A changed prompt reaches it through the task text, saying it replaces the earlier one, also the system prompt's.
  assert.match(expert_prompt_delivery('任务', { adapter: 'claude', system_prompt: '只改文档' }, adapter_of('claude'), { session_id: 's1' }, false, record).prompt,
    /替换此前给你的同类提示（包括系统提示词里的旧版本）[\s\S]*只改文档/);
  // Clearing everything is said once to a session that had some; a session that never had any is told nothing.
  const cleared = expert_prompt_delivery('任务', { adapter: 'claude', system_prompt: '' }, adapter_of('claude'), { session_id: 's1' }, false, record);
  assert.match(cleared.prompt, /已全部撤销/);
  assert.equal(cleared.expert_prompt_hash, '');
  assert.equal(expert_prompt_delivery('任务', { adapter: 'claude', system_prompt: '' }, adapter_of('claude'), { session_id: 's1' }, false, { session_id: 's1', hash: '' }).prompt, '任务');
  // A software without a system prompt slot, or a member's own open window, gets it in the first task of each session.
  const agy = expert_prompt_delivery('任务', profile('antigravity_cli'), adapter_of('antigravity_cli'), { session_id: 'a1' }, false, null);
  assert.equal(agy.system_text, undefined);
  assert.match(agy.prompt, /只看测试/);
  assert.match(expert_prompt_delivery('任务', profile('claude'), adapter_of('claude'), {}, true, null).prompt, /只看测试/);
  // The owner's prompts for every member and for the platform come first, in the same block and fingerprint.
  const layers = { program: '先给结论', platforms: { Antigravity: '用浏览器前先截图', Claude: '不发给别家' } };
  const layered = expert_prompt_delivery('任务', profile('antigravity_cli'), adapter_of('antigravity_cli'), { session_id: 'a1' }, false, null, { layers, platform: 'Antigravity' });
  assert.match(layered.prompt, /所有成员[\s\S]*先给结论[\s\S]*Gemini 平台[\s\S]*用浏览器前先截图[\s\S]*只看测试/);
  // A hosted account administrator's layer comes first, apart from the account user's own.
  assert.match(expert_prompt_delivery('任务', profile('claude'), adapter_of('claude'), {}, false, null, { layers: { ...layers, managed: '不外传凭据' }, platform: 'Claude' }).system_text,
    /管理员[\s\S]*不外传凭据[\s\S]*所有成员[\s\S]*先给结论/);
  assert.doesNotMatch(layered.prompt, /不发给别家/);
  assert.notEqual(layered.expert_prompt_hash, agy.expert_prompt_hash, 'a changed layer is sent again');
  assert.match(expert_prompt_delivery('任务', { adapter: 'claude' }, adapter_of('claude'), {}, false, null, { layers, platform: 'Claude' }).system_text, /不发给别家/);
  // A model API member's Pi session keeps the prompt it started with too (measured 2026-11-25): a change is resent.
  const api_fresh = expert_prompt_delivery('任务', { adapter: 'api', system_prompt: '只看测试' }, adapter_of('api'), {}, false, null);
  assert.ok(api_fresh.system_text && api_fresh.prompt === '任务');
  assert.match(expert_prompt_delivery('任务', { adapter: 'api', system_prompt: '只改文档' }, adapter_of('api'), { session_id: 'p1' }, false,
    { session_id: 'p1', hash: api_fresh.expert_prompt_hash }).prompt, /替换此前给你的同类提示[\s\S]*只改文档/);
  // A manually started member takes none, even one left in its settings.
  assert.equal(expert_prompt_delivery('任务', { ...profile('claude'), project_access: 'own' }, adapter_of('claude'), { session_id: 's1' }, false, null).prompt, '任务');
});

test('the agy command limit comes from the runner, so clearing the expert prompt cannot drop it', () => {
  assert.match(software_rules({ adapter: 'antigravity_cli' }, 'codiscuss'), /run_command 只能运行 codiscuss/);
  assert.equal(software_rules({ adapter: 'codex_cli' }, 'codiscuss'), '');
  assert.doesNotMatch(software_rules({ adapter: 'antigravity_cli', cwd: 'D:/project', project_access: 'write' }, 'codiscuss'), /run_command/, 'a writable agy runs any command');
  // agy shows no thinking, so writing progress is a fixed rule for it in every task, beside the skill's general note.
  const agy = { cli: 'codiscuss', messages: '#3', task_path: 'free-7.task.json', name: 'Antigravity', profile: { adapter: 'antigravity_cli', project_access: 'write', cwd: 'D:/project' } };
  assert.match(free_task_text(agy).instructions, /转入新的一段工作时.*先用一句话说明再继续/);
  // Claude's card shows only its text between tool calls, so it gets a progress rule too; a software without one does not.
  assert.match(free_task_text({ ...agy, profile: { adapter: 'claude', project_access: 'read' } }).instructions, /转入新的一段工作时.*用请求者的语言写/);
  assert.doesNotMatch(free_task_text({ ...agy, profile: { adapter: 'codex_cli', project_access: 'read' } }).instructions, /写出进展|转入新的一段工作时/);
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
  const task = id => JSON.parse(readFileSync(runtime_file(config.directory, `free-${id}.task.json`), 'utf8'));
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

test('a voided turn the runner cannot stop but follows reports stopped once it ends in its window', async t => {
  const { state, store, config } = await free_fixture(t);
  let exit;
  const runner = new FreeRoomRunner(config, store, async (adapter, binding, task) => {
    exit = task.on_exit; return { status: 'accepted', capabilities: { stoppable: false, progress: true } };
  });
  await runner.tick();
  state.executions[0].status = 'cancelled';
  await runner.tick();
  assert.equal(state.executions[0].stop_result, 'unstoppable', 'the turn may still run in the window');
  assert.ok(store.db.prepare("SELECT value FROM metadata WHERE key='delivery:1'").get(), 'the runner keeps following it');
  exit();
  await runner.tick();
  assert.equal(state.executions[0].stop_result, 'stopped', 'its end lifts the hold');
  assert.equal(store.db.prepare("SELECT value FROM metadata WHERE key='delivery:1'").get(), undefined);
});

test('a voided App turn the adapter only hears end reports stopped once it ends, never failing a live one', async t => {
  const { state, store, config } = await free_fixture(t);
  let turn_end;
  const runner = new FreeRoomRunner(config, store, async (adapter, binding, task) => {
    turn_end = task.on_turn_end; return { status: 'accepted', capabilities: { stoppable: false, progress: false, ends: true } };
  });
  await runner.tick();
  turn_end();
  await runner.tick();
  assert.equal(state.executions[0].status, 'dispatched', 'a turn end says nothing about an answer, so a live execution stays');
  runner.turn_ended.clear();
  state.executions[0].status = 'cancelled';
  await runner.tick();
  assert.equal(state.executions[0].stop_result, 'unstoppable');
  turn_end();
  await runner.tick();
  assert.equal(state.executions[0].stop_result, 'stopped');
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

test('a changed path that is a directory (a modified submodule) has no line diff and stops no delivery', t => {
  const project = mkdtempSync(join(tmpdir(), 'free-submodule-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  mkdirSync(join(project, 'engine'));
  writeFileSync(join(project, 'note.md'), 'text');
  const base = capture_base(project, new Map([['engine', ' M:x'], ['note.md', ' M:y'], ['gone.md', ' D:missing']]));
  assert.deepEqual([base.get('engine'), base.get('note.md'), base.get('gone.md')], [{ skipped: 'binary' }, { text: 'text' }, { missing: true }]);
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
  state.executions[0].status = 'completed';
  await runner.tick();
  assert.deepEqual(state.reports[1], ['index.html'], 'what changed by the answer is reported at once, the process still running');
  writeFileSync(join(project, 'added.css'), 'x');
  child.emit('close');
  await runner.tick();
  assert.deepEqual(state.reports[1], ['added.css', 'index.html'], 'the report after the process exits replaces it');
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
  assert.equal(JSON.parse(readFileSync(runtime_file(config.directory, 'free-2.access.json'), 'utf8')).token, config.members['Claude-review'].token);
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

test('a normally completed execution leaves the software its declared close window; any other end stops it at once', async t => {
  const statuses = { 7: 'completed', 8: 'cancelled' };
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ status: statuses[request.url.split('/').pop()] }));
  });
  await listen_local(server);
  t.after(() => server.close());
  const runner = Object.assign(Object.create(FreeRoomRunner.prototype), { closed_at: new Map(), members: new Map(),
    config: { site: `http://127.0.0.1:${server.address().port}`, room: 'room', token: 't'.repeat(64),
      participants: { Codex: { adapter: 'codex_cli' }, Claude: { adapter: 'claude' } } } });
  const live = name => runner.members.set(name, new Set([{ kill() {} }]));
  live('Codex');
  assert.equal(await runner.closing({ name: 'Codex' }, { execution_id: 7 }), true, 'completed: the receipt may still be recorded');
  runner.closed_at.set(7, Date.now() - 1);
  assert.equal(await runner.closing({ name: 'Codex' }, { execution_id: 7 }), false, 'the window is bounded');
  assert.equal(await runner.closing({ name: 'Codex' }, { execution_id: 8 }), false, 'a stopped execution is not waited on');
  live('Claude');
  assert.equal(await runner.closing({ name: 'Claude' }, { execution_id: 7 }), false, 'no declared window, no wait');
  runner.members.set('Codex', new Set());
  assert.equal(await runner.closing({ name: 'Codex' }, { execution_id: 9 }), false, 'software that already exited is not waited on');
});

test('a usage-limit reset written as a clock time becomes the next such instant in its zone', async () => {
  const { clock_reset_at } = await import('../runner/adapters/common.mjs');
  const now = Date.parse('2026-11-15T06:00:00Z');
  assert.equal(clock_reset_at('3pm (Asia/Shanghai)', now) * 1000, Date.parse('2026-11-15T07:00:00Z'));
  assert.equal(clock_reset_at('2:30pm (America/Los_Angeles)', now) * 1000, Date.parse('2026-11-15T22:30:00Z'));
  assert.equal(clock_reset_at('1pm (Asia/Shanghai)', now) * 1000, Date.parse('2026-11-16T05:00:00Z'), 'a time already past is tomorrow');
  for (const text of ['Nov 16', '13pm', '', '3pm (Not/AZone)']) assert.equal(clock_reset_at(text, now), 0, text);
});

test('a host task carries the room goal so a new host or a finished Goal still knows what the room is for', t => {
  const f = task_fixture(t);
  const room = { goal: '', user_request: '把登录页改完并上线', first_user_message_id: 3 };
  assert.deepEqual({ ...room_goal(room), note: undefined }, { goal: null, user_request: '把登录页改完并上线', first_user_message_id: 3, note: undefined });
  assert.equal(room_goal({}), null);
  const request = { id: 7, message_id: 9, purpose: 'goal_continue' };
  const write = role => free_task_files(f.config, { name: 'Codex', role }, { id: 1, read_until: 0, requests: [request] }, {}, { process_access: false, room });
  const read = () => JSON.parse(readFileSync(runtime_file(f.config.directory, 'free-1.task.json'), 'utf8'));
  // The returned task carries it too, which is how an API host gets it in its task prompt.
  assert.equal(write('host').room_goal.first_user_message_id, 3);
  assert.equal(read().room_goal.first_user_message_id, 3);
  assert.match(read().room_goal.note, /Goal 或讨论结束不等于它完成/);
  write('member');
  assert.equal(read().room_goal, undefined, 'only the host gets it');
});

test('a new host learns that its former host\'s spent quota paused the goal', t => {
  const f = task_fixture(t);
  const goal = { id: 4, status: 'paused', objective: '上线', quota_paused_by: 'Claude' };
  const task = free_task_files(f.config, { name: 'Codex', role: 'host' }, { id: 1, read_until: 0, requests: [{ id: 7, message_id: 9, purpose: 'route' }] }, {},
    { process_access: false, goal });
  assert.match(task.goal.pause_note, /Goal #4 因前任主持人 Claude 额度用尽而暂停.*--do resume/);
});

test('each member credential sits in its own runtime folder and file-tool software is granted only that folder (凭据文件隔离)', t => {
  const f = task_fixture(t);
  f.config.members.Claude = { token: 'c'.repeat(32) };
  f.config.participants.Claude = { adapter: 'claude' };
  const request = { id: 7, message_id: 9, purpose: 'ask' };
  const codex = free_task_files(f.config, { name: 'Codex', role: 'member' }, { id: 1, read_until: 0, requests: [request] }, {}, { process_access: false });
  const claude = free_task_files(f.config, { name: 'Claude', role: 'member' }, { id: 2, read_until: 0, requests: [request] }, {}, { process_access: false });
  assert.notEqual(codex.member_directory, claude.member_directory);
  for (const task of [codex, claude]) {
    assert.equal(dirname(task.access_path), task.member_directory);
    assert.equal(dirname(task.task_path), task.member_directory);
  }
  assert.deepEqual(readdirSync(f.config.directory).filter(name => name.endsWith('.access.json')), [], 'no credential in the shared runtime directory');
  const granted = claude_permissions({ project_access: 'read' }, { ...claude, skill_directories: [] });
  const added = granted.slice(granted.indexOf('--add-dir') + 1, granted.indexOf('--allowedTools'));
  assert.ok(added.includes(claude.member_directory));
  for (const path of [f.config.directory, codex.member_directory]) assert.ok(!added.some(item => resolve(path).startsWith(resolve(item))), path);
});

test('only software that captures the last words is told so in its task; the rest submit as the skill says', t => {
  const f = task_fixture(t);
  const request = { id: 7, message_id: 9, purpose: 'ask' };
  const read = () => JSON.parse(readFileSync(runtime_file(f.config.directory, 'free-1.task.json'), 'utf8'));
  for (const [adapter, captured] of [['codex_cli', true], ['codex', false]]) {
    f.config.participants.Codex = { adapter };
    free_task_files(f.config, { name: 'Codex', role: 'member' }, { id: 1, read_until: 0, requests: [request] }, {}, { process_access: false });
    assert.equal('answer_capture' in read(), captured, adapter);
  }
});

test('a member whose model changed since its last delivery is told so in its next task, once', t => {
  const directory = mkdtempSync(join(tmpdir(), 'model-change-'));
  const store = new DiscussionStore(directory); t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const runner = { config: { participants: { Codex: { adapter: 'codex_cli', model: 'gpt-5', effort: 'high' } } }, store };
  const change = () => FreeRoomRunner.prototype.model_change.call(runner, 'Codex');
  assert.equal(change(), null, 'the first delivery has nothing to compare with');
  runner.config.participants.Codex = { adapter: 'codex_cli', effort: 'low' };
  assert.deepEqual(change(), { from: 'gpt-5 · high', to: '默认 · low' });
  assert.equal(change(), null);
});

test('a host in a room with a workflow is told to route the request before acting', async () => {
  const { free_task_text } = await import('../runner/expert_prompts.mjs');
  const base = { name: 'Claude', profile: { adapter: 'claude', project_access: 'read' }, cli: 'codiscuss', messages: '#5', read_after: 4, task_path: 't.json', requests: [{ purpose: 'route', created_by: 'user' }] };
  assert.match(free_task_text({ ...base, workflow: true }).prompt, /workflow\.sub_workflows.*命中就读它的 SKILL\.md/);
  assert.doesNotMatch(free_task_text(base).prompt, /sub_workflows/);
});

test('the wake-up opening says who asked: user, host, detached work, hand-back or notice', async () => {
  const { free_task_text } = await import('../runner/expert_prompts.mjs');
  const base = { name: 'Codex', profile: { adapter: 'claude', project_access: 'read' }, cli: 'codiscuss', messages: '#5', read_after: 4, task_path: 't.json' };
  const opening = requests => free_task_text({ ...base, requests }).prompt;
  assert.match(opening([{ purpose: 'ask', created_by: 'user' }]), /^用户在房间点名了你.*message view 上面的消息编号/);
  assert.match(opening([{ purpose: 'ask', created_by: 'host', batch_id: 5 }]), /^主持人给你（Codex）安排了一项请求/);
  assert.match(opening([{ purpose: 'ask', created_by: 'host', batch_id: 0 }]), /^主持人派你（Codex）在后台独立完成/);
  assert.match(opening([{ purpose: 'handoff', created_by: 'host' }]), /^你（Codex）派出的工作已交回/);
  for (const purpose of ['handoff', 'notice', 'goal_continue']) assert.doesNotMatch(opening([{ purpose }]), /点名了你|简单消息可跳过技能/);
});


test('a turn a restart ended midway goes on once in its own session, never sent again whole', async t => {
  const codex_start = { type: 'event_msg', payload: { type: 'task_started', turn_id: 'current-turn', root_turn_id: 'current-turn' } };
  const codex_end = type => ({ type: 'event_msg', payload: { type, turn_id: 'current-turn', root_turn_id: 'current-turn' } });
  // What each software left when the restart ended its turn; only its own failure is not resumed.
  const scenarios = {
    'codex-killed': [codex_start],
    'codex-interrupted': [codex_start, codex_end('turn_aborted')],
    'codex-failed': [codex_start, { ...codex_end('task_complete'), payload: { ...codex_end('task_complete').payload, error: { message: 'model error' } } }],
    'claude-killed': [{ type: 'system', subtype: 'init', session_id: 'session-id' },
      { type: 'assistant', session_id: 'session-id', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } }],
  };
  for (const [scenario, events] of Object.entries(scenarios)) {
    const f = await free_fixture(t); const prompts = [];
    const is_codex = scenario.startsWith('codex');
    f.config.participants.Claude.adapter = is_codex ? 'codex_cli' : 'claude';
    const path = join(f.config.directory, 'recovery.log');
    writeFileSync(path, [...(is_codex ? [{ type: 'session_meta', payload: { id: 'thread-id', source: 'cli' } }] : []), ...events]
      .map(JSON.stringify).join('\n') + '\n');
    const record = is_codex ? { kind: 'codex_turn', thread_id: 'thread-id', turn_id: 'current-turn', rollout_path: path }
      : { kind: 'claude_process', session_id: 'session-id', log_path: path, offset: 0 };
    const deliver = async (adapter, binding, task) => {
      prompts.push(task.prompt);
      task.on_recovery(record);
      task.on_binding(is_codex ? 'thread-id' : 'session-id');
      task.on_process(Object.assign(new EventEmitter(), { kill() {} }));
      return { status: 'accepted' };
    };
    await new FreeRoomRunner(f.config, f.store, deliver).tick();
    const execution = f.state.executions[0];
    await new FreeRoomRunner(f.config, f.store, deliver).tick();
    if (scenario === 'codex-failed') {
      assert.equal(prompts.length, 1, scenario);
      assert.match(execution.result, /重启后无法确认上次执行结果/, scenario);
      continue;
    }
    assert.equal(prompts.length, 2, scenario);
    assert.match(prompts[1], new RegExp(`执行 #${execution.id}.*被本机服务重启打断`), scenario);
    assert.notEqual(execution.status, 'failed', scenario);
    // Ended midway again: it fails as before rather than resume without end, and leaves no record behind.
    await new FreeRoomRunner(f.config, f.store, deliver).tick();
    assert.equal(prompts.length, 2, scenario);
    assert.match(execution.result, /重启后无法确认上次执行结果/, scenario);
    assert.equal(f.store.db.prepare('SELECT value FROM metadata WHERE key=?').get(`restart-resumed:${execution.id}`), undefined, scenario);
  }
});

test('restart recovery captures only the exact completed delivery and never redelivers', async t => {
  for (const scenario of ['codex', 'failed-turn', 'unknown-error', 'old-turn', 'child-turn', 'conflict', 'claude', 'wrong-session', 'denied', 'empty', 'answered', 'rejected', 'legacy-retry']) {
    const f = await free_fixture(t); let sent = 0;
    const is_codex = ['codex', 'failed-turn', 'unknown-error', 'old-turn', 'child-turn', 'conflict', 'empty'].includes(scenario);
    f.config.participants.Claude.adapter = is_codex ? 'codex_cli' : 'claude';
    const path = join(f.config.directory, 'recovery.log');
    const turn_id = scenario === 'old-turn' ? 'previous-turn' : 'current-turn';
    const root_turn_id = scenario === 'child-turn' ? 'parent-turn' : turn_id;
    const codex = [{ type: 'session_meta', payload: { id: 'thread-id', source: 'cli' } },
      { type: 'event_msg', payload: { type: 'task_started', turn_id, root_turn_id } },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id, root_turn_id, last_agent_message: scenario === 'empty' ? '' : 'Recovered answer' } }];
    if (scenario === 'conflict') codex.push({ type: 'event_msg', payload: { type: 'turn_aborted', turn_id, root_turn_id } });
    if (scenario === 'old-turn') codex.push({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'current-turn', root_turn_id: 'current-turn' } });
    // Trimmed real task_complete.error shape (2026-11-13), with a synthetic residual final remark to forbid capture.
    if (scenario === 'failed-turn') codex[2].payload.error = { message: 'This content was flagged for possible cybersecurity risk.', codex_error_info: 'cyber_policy' };
    if (scenario === 'unknown-error') codex[2].payload.error = ['unrecognized future format'];
    const claude = [{ type: 'system', subtype: 'init', session_id: 'session-id' },
      { type: 'assistant', session_id: 'session-id', message: { content: [{ type: 'text', text: 'Recovered answer' }] } },
      { type: 'result', session_id: scenario === 'wrong-session' ? 'other-session' : 'session-id', is_error: false, subtype: 'success',
        permission_denials: scenario === 'denied' ? [{ tool_name: 'Bash', tool_input: { command: 'denied-command' } }] : [] }];
    const prefix = is_codex ? '' : JSON.stringify({ type: 'result', session_id: 'old-session', subtype: 'success', is_error: false }) + '\n';
    writeFileSync(path, prefix + (is_codex ? codex : claude).map(JSON.stringify).join('\n') + '\n');
    const record = is_codex ? { kind: 'codex_turn', thread_id: 'thread-id', turn_id: 'current-turn', rollout_path: path }
      : { kind: 'claude_process', session_id: 'session-id', log_path: path, offset: Buffer.byteLength(prefix) };
    const deliver = async (adapter, binding, task) => {
      sent++; task.on_recovery(record);
      task.on_process(Object.assign(new EventEmitter(), { kill() {} }));
      return { status: 'accepted' };
    };
    await new FreeRoomRunner(f.config, f.store, deliver).tick();
    const execution = f.state.executions[0];
    if (scenario === 'answered') execution.status = 'completed';
    if (scenario === 'rejected') execution.delivery = { last_submission: { outcome: 'rejected' } };
    if (scenario === 'legacy-retry') {
      f.store.db.prepare("UPDATE free_deliveries SET status='retry_wait' WHERE member='Claude'").run();
      f.store.db.prepare('INSERT OR REPLACE INTO metadata VALUES (?,?)').run(`retry-reason:${execution.id}`, 'runner_restarted');
      f.store.db.prepare('DELETE FROM metadata WHERE key=?').run(`recovery:${execution.id}`);
      execution.retry = { attempt: 1, retry_at: 1 };
    }
    await new FreeRoomRunner(f.config, f.store, deliver).tick();
    const captured = ['codex', 'claude'].includes(scenario);
    assert.equal(sent, 1, scenario);
    assert.equal(f.state.posts?.length || 0, captured ? 1 : 0, scenario);
    assert.equal(execution.status, captured || scenario === 'answered' ? 'completed' : 'failed', scenario);
    assert.equal(f.state.calls.some(call => call.endsWith(' retry_start')), false, scenario);
    if (captured) {
      assert.equal(f.state.posts[0].body.text, 'Recovered answer');
      assert.equal(f.state.posts[0].body.submission_id, `auto-capture-${execution.id}`);
    }
    if (['failed-turn', 'unknown-error', 'old-turn', 'child-turn', 'conflict', 'wrong-session', 'legacy-retry'].includes(scenario)) assert.match(execution.result, /重启后无法确认上次执行结果/, scenario);
    if (['empty', 'denied'].includes(scenario)) assert.match(execution.result, /会话已结束，但未提交本次回答/, scenario);
  }
});

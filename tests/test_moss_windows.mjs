import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { measure } from '../runner/storage_guard.mjs';
import { save_api_key } from '../runner/discussion_api.mjs';
import { host_control, moss_group_command, save_launch_settings } from '../runner/discussion_launch.mjs';
import { api } from '../runner/discussion_runner.mjs';
import { configuration_snapshot, DiscussionService, read_registry } from '../runner/discussion_service.mjs';
import { free_task_files } from '../runner/free_runner.mjs';
import { participant_tools } from '../runner/adapters/api.mjs';
import { flush_moss_group, moss_window_delegation, moss_window_habits, moss_windows, route_moss_group, save_moss_window, send_moss_group_question } from '../runner/moss_windows.mjs';
import { group_public_text } from '../runner/channels.mjs';
import { mark_question_public } from '../runner/question_weixin.mjs';
import { relayed_command } from '../runner/remote_launch.mjs';

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'moss-window-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const chat = { kind: 'group', id: '7', title: '测试群' };
  const sent = [], notices = [], errors = [], requests = [], receipts = new Map();
  const channel = { id: 'fake', label: 'Fake', capabilities: { groups: true, text_limit: 160 },
    groups: async () => [chat], ready: () => true, owner_id: () => 'owner',
    deliver: async (_, text, options) => { sent.push({ text, options }); return ['quoted-id']; } };
  const config = { room: 'group-7', site: 'http://site.test', moss_window: { chat_id: '7', channel: 'fake' } };
  let next = 1;
  const request = async (_, path, payload) => {
    if (path === '/messages') {
      const external = payload.external;
      if (receipts.has(external.message_id)) return { duplicate: true, message: receipts.get(external.message_id) };
      const message = { id: next++, text: payload.text, external };
      receipts.set(external.message_id, message);
      return { message };
    }
    if (path === '/window-wake') { requests.push(payload.message_id); return { request_id: 30 + payload.message_id }; }
    if (path.startsWith('/messages?')) return { messages: [...receipts.values()] };
    return {};
  };
  const ops = { config, channel, request, send: async (_, notice) => { notices.push(notice); return { status: 'sent' }; },
    log: text => errors.push(text) };
  const event = (message_id, options = {}) => ({ chat, sender: { id: 'alice', name: '同名' },
    owner_id: 'owner', mentioned: true, text: '问一下', message_id, ...options });
  const enable = () => save_moss_window(home, 'fake:7', { enabled: true, title: chat.title, room: config.room });
  return { home, config, chat, channel, ops, event, enable, sent, notices, errors, requests, receipts };
}

test('group settings require a bound channel and tool lockdown, and introduction is opt-in on enable', async t => {
  const { home, channel, sent } = fixture(t);
  const command = (action, options = {}, input = {}) => moss_group_command(home, { action, channel: 'fake', chat_id: '7', ...input },
    { channels: [channel], ...options });
  channel.ready = () => false;
  await assert.rejects(command('group-enable'), /绑定|Bind/);
  channel.ready = () => true;
  await assert.rejects(command('group-enable'), /收窄|restrictions/);
  writeFileSync(join(home, 'launch-settings.json'), JSON.stringify({ steward: { adapter: 'antigravity_cli' },
    participants: { Antigravity: { adapter: 'antigravity_cli' } } }));
  let creates = 0;
  const create = async () => { creates += 1; return 'window'; };
  assert.equal((await command('groups')).groups[0].work_policy, 'small');
  assert.equal((await command('group-enable', { create })).room_id, 'window');
  assert.equal((await command('groups')).groups[0].work_policy, 'small');
  assert.deepEqual(sent, []);
  await command('group-disable');
  assert.equal((await command('groups')).groups[0].enabled, false);
  const reopened = await command('group-enable', { create }, { introduce: true });
  assert.equal(reopened.room_id, 'window');
  assert.equal(reopened.introduction_sent, true);
  await command('group-enable', { create }, { introduce: true });
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /我是 MOSS|I’m MOSS/);
  assert.equal(sent[0].options.reply_to, undefined);
  assert.equal(creates, 1);
});

test('an owner can enable and disable its group over the channel and the room round-trips a backend wake', async t => {
  const { home, channel, event, sent } = fixture(t);
  const python = spawn('python', ['-u', '-c', [
    'from pathlib import Path', 'import sys',
    'from backend.server import DiscussionServer, init_database',
    'db = Path(sys.argv[1])', 'init_database(db, seed=False)',
    'site = DiscussionServer(("127.0.0.1", 0), db)',
    'print(site.server_port, flush=True)', 'site.serve_forever()',
  ].join('\n'), join(home, 'db.sqlite3')], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true,
    env: { ...process.env, DISCUSS_SERVICE_HOME: home } });
  t.after(async () => { if (python.exitCode === null) { const exit = once(python, 'exit'); python.kill(); await exit; } });
  const lines = createInterface({ input: python.stdout });
  const [line] = await Promise.race([once(lines, 'line'), once(python, 'exit').then(() => { throw new Error('backend exited'); })]);
  lines.close();
  const port = Number(line);
  assert.ok(port > 0);
  writeFileSync(join(home, 'local-settings.json'), JSON.stringify({ port, workspace: join(home, 'workspace') }));
  const service = new DiscussionService(home);
  const incoming = (id, fields) => service.moss_group_message(channel, event(id, fields));
  const owner = { id: 'owner', name: '同名' };
  await incoming('disabled-chat', { text: '群还没开启' });
  await incoming('impostor-start', { text: '开始工作', owner: true });
  await incoming('unmentioned-start', { text: '开始工作', mentioned: false, sender: owner });
  assert.deepEqual(read_registry(home), []);
  assert.deepEqual(sent, []);
  await incoming('unsupported', { text: '开始工作', sender: owner });
  assert.match(sent[0].text, /不支持.*收窄|does not support.*restrictions/);
  assert.equal(sent[0].options.reply_to, 'unsupported');
  assert.deepEqual(read_registry(home), []);
  const base_url = 'https://api.deepseek.com/v1';
  const { api_key_ref } = save_api_key(home, { base_url, api_key: 'synthetic-not-used' });
  save_launch_settings(home, { participants: { DeepSeek: { adapter: 'api', base_url, api_key_ref,
    api_protocol: 'chat', model: 'deepseek-v4-pro', system_prompt: 'must not inherit' } } }, { adapter: 'api' });
  await incoming('start', { text: '开始工作', sender: owner });
  await incoming('start-again', { text: '开始工作', sender: owner });
  assert.equal(read_registry(home).length, 1);
  assert.deepEqual(sent.slice(1).map(item => item.options.reply_to), ['start', 'start-again']);
  assert.match(sent[1].text, /已在本群开始工作|now active/);
  const group = (await moss_group_command(home, { action: 'groups', channel: channel.id }, { channels: [channel] })).groups[0];
  assert.deepEqual([group.work_policy, group.daily_limit, group.daily_tasks, group.read_directory, group.skills], ['small', 30, 5, '', []]);
  const read_directory = join(home, 'reference');
  mkdirSync(read_directory);
  const result = await moss_group_command(home, { action: 'group-settings', channel: channel.id, chat_id: '7',
    settings: { read_directory, daily_tasks: 1, skills: ['share-card'] } },
    { channels: [channel], start_service: async () => ({ running: true }) });
  const [registration] = read_registry(home);
  const { config } = configuration_snapshot(registration);
  assert.equal(config.room, result.room_id);
  assert.deepEqual((await api(config, '/messages')).messages, []);
  assert.equal(config.participants.DeepSeek.project_access, 'read');
  assert.equal(config.participants.DeepSeek.model, 'deepseek-flash');
  assert.equal(config.participants.DeepSeek.system_prompt, undefined);
  assert.equal(config.extra_directories, undefined);
  assert.match(config.cwd, /steward-windows/);
  await route_moss_group(home, { config, channel, request: api, log: error => assert.fail(error) }, event('live-1'));
  const room = await api(config, '');
  assert.equal(room.system_kind, 'steward_group');
  assert.equal(room.free.requests.length, 1);
  const message = await api(config, `/messages/${room.free.requests[0].message_id}`);
  assert.equal(message.external.message_id, 'live-1');
  const member = room.free.members[0];
  const execution = await api(config, '/executions', { member_id: member.id, client_id: 'group-client' });
  save_launch_settings(home, {}, { habits: { group: '短答测试' } });
  const task = free_task_files(config, member, execution, {});
  const contract = JSON.parse(readFileSync(task.task_path, 'utf8'));
  assert.equal(contract.window.habit, '短答测试');
  assert.equal(contract.untrusted_speakers, true);
  assert.deepEqual(contract.skills, []);
  assert.deepEqual(contract.host_permissions, ['create_rooms']);
  assert.equal(task.tool_lockdown, true);
  assert.deepEqual(task.lockdown_read_directories, [read_directory]);
  assert.equal(JSON.parse(readFileSync(task.access_path, 'utf8')).window, 'group');
  assert.deepEqual(contract.steward_skill_catalog.map(skill => skill.id), ['share-card']);
  assert.equal(contract.tool_lockdown, true);
  assert.equal(contract.answer_capture, undefined);
  const delegate = (action, options) => host_control(home, action, { access_file: task.access_path, ...options },
    { start_service: async () => ({ running: true }) });
  const create = { title: 'Group work', preset: 'task', text: 'Synthetic group request', submission_id: 'group-task-first' };
  await assert.rejects(delegate('create-room', { ...create, preset: '' }));
  const child = await delegate('create-room', create);
  assert.equal((await delegate('create-room', create)).room_id, child.room_id);
  assert.equal(child.cwd, join(config.cwd, 'work', create.submission_id));
  const storage_before = await measure(home, { members: true });
  writeFileSync(join(child.cwd, 'work.txt'), 'delegation file');
  assert.equal((await measure(home, { members: true })).local_bytes - storage_before.local_bytes, Buffer.byteLength('delegation file'));
  const child_config = read_registry(home).map(file => configuration_snapshot(file).config).find(item => item.room === child.room_id);
  assert.equal(child_config.participants.DeepSeek.project_access, 'write');
  assert.deepEqual(child_config.extra_directories, [{ path: read_directory, access: 'read' }]);
  const child_room = await api(child_config, '');
  assert.equal(child_room.source_window_id, config.room);
  assert.equal(child_room.source_message_id, execution.requests[0].message_id);
  assert.match((await api(child_config, `/messages/${child.message_id}`)).text, /外部请求|external group chat/);
  await assert.rejects(delegate('create-room', { ...create, submission_id: 'group-task-second' }), /额度|limit/);
  await assert.rejects(delegate('room-post', { room: 'not-a-child', text: 'not allowed' }), /自己创建|own delegated/);
  assert.equal((await moss_group_command(home, { action: 'groups', channel: channel.id }, { channels: [channel] })).groups[0].tasks_used_today, 1);
  const child_host = child_room.free.members[0];
  const child_execution = await api(child_config, '/executions', { member_id: child_host.id, client_id: 'child-client' });
  await api(child_config, '/messages', { author: child_host.name, execution_id: child_execution.id,
    text: 'Synthetic group result', submission_id: 'group-task-answer' }, child_config.members[child_host.name].token);
  const returned = await api(config, '');
  const report = returned.free.requests.find(item => item.purpose === 'notice');
  assert.ok(report);
  assert.equal(moss_windows(home)['fake:7'].pending[report.message_id].platform_id, 'live-1');
  assert.equal(moss_windows(home)['fake:7'].usage.used, 1);
  const question = await api(config, '/questions', { actor: member.name, execution_id: execution.id,
    submission_id: 'group-question-first', contract: 'handoff', blocking: true, explanation: '先请房主确认',
    questions: [{ id: 'pick', prompt: '是否继续？', options: [{ id: 'yes', label: '同意' }, { id: 'no', label: '拒绝' }] }],
  }, config.members.DeepSeek.token);
  const key = 'fake:7';
  save_moss_window(home, key, { ...moss_windows(home)[key], pending_owner: { question: { id: question.question_id, version: question.version }, platform_id: 'live-1' } });
  await route_moss_group(home, { config, channel, request: api, log: error => assert.fail(error) },
    event('live-2', { owner: true, sender: { id: 'owner', name: '房主' }, text: '可以' }));
  const answered = await api(config, `/questions/${question.question_id}`);
  assert.equal(answered.status, 'answered');
  assert.equal(moss_windows(home)[key].pending_owner, null);
  await incoming('impostor-stop', { text: '停止工作', owner: true, mentioned: true });
  assert.equal(moss_windows(home)[key].enabled, true);
  await incoming('stop', { text: '停止工作', sender: owner });
  assert.equal(moss_windows(home)[key].enabled, false);
  assert.equal(moss_windows(home)[key].room, config.room);
  assert.match(sent.at(-1).text, /已停止.*记录保留|no longer active.*history is kept/);
  assert.equal(sent.at(-1).options.reply_to, 'stop');
  const before = (await api(config, '/messages')).messages;
  await incoming('after-stop', { text: '不应入库', sender: owner });
  assert.deepEqual((await api(config, '/messages')).messages, before);
});

test('group events are ignored while disabled, deduplicated, and only mentions wake without Jev', async t => {
  const { home, ops, event, enable, receipts, requests } = fixture(t);
  await route_moss_group(home, ops, event('disabled'));
  assert.equal(receipts.size, 0);
  enable();
  await route_moss_group(home, ops, event('plain', { mentioned: false }));
  await route_moss_group(home, ops, event('mention'));
  await route_moss_group(home, ops, event('mention'));
  assert.deepEqual(requests, [receipts.get('mention').id]);
  assert.equal(receipts.size, 2);
  assert.equal(moss_windows(home)['fake:7'].usage.used, 1);
});

test('a returned delegation quotes its original group request once without spending a wake', async t => {
  const { home, ops, enable, sent } = fixture(t);
  enable();
  const key = 'fake:7';
  const config = moss_windows(home)[key];
  save_moss_window(home, key, { ...config, pending: { 50: { platform_id: 'original-qq-message', delegated: true } } });
  const request = ops.request;
  ops.request = async (...args) => args[1] === '/messages/51' ? { text: 'Finished the delegated task' } : request(...args);
  const room = { free: { requests: [{ message_id: 50, purpose: 'notice', answer_id: 51 }] } };
  await flush_moss_group(home, ops, room);
  await flush_moss_group(home, ops, room);
  assert.deepEqual(sent.map(item => [item.text, item.options.reply_to]), [['Finished the delegated task', 'original-qq-message']]);
  assert.equal(moss_windows(home)[key].usage, undefined);
});

test('Jev notes and over-limit messages are recorded without waking; an owner mention bypasses Jev', async t => {
  const { home, ops, event, enable, receipts, requests, errors } = fixture(t);
  enable();
  ops.scheduler = { provider: 'jev' };
  let judgments = 0;
  ops.decide = async () => { judgments += 1; return { action: 'note' }; };
  for (let index = 0; index < 7; index += 1) await route_moss_group(home, ops, event(String(index)));
  const owner = { id: 'owner', name: '同名' };
  await route_moss_group(home, ops, event('owner', { sender: owner, owner: true }));
  assert.deepEqual(requests, [receipts.get('owner').id]);
  assert.equal(receipts.size, 8);
  assert.equal(judgments, 5);
  assert.equal(errors.filter(text => text.includes('rate limited')).length, 2);
  assert.equal(moss_windows(home)['fake:7'].usage, undefined);
});

test('Jev failures wake mentions and the owner without bypassing the daily limit', async t => {
  const { home, ops, event, enable, receipts, requests, notices } = fixture(t);
  enable();
  save_launch_settings(home, {}, { windows: { 'fake:7': { daily_limit: 1 } } });
  ops.scheduler = { provider: 'jev' };
  ops.decide = async () => { throw new Error('connection failed'); };
  await route_moss_group(home, ops, event('plain', { mentioned: false }));
  assert.ok(receipts.has('plain'));
  assert.deepEqual(requests, []);
  assert.equal(moss_windows(home)['fake:7'].last_failure.reason, 'connection failed');
  await route_moss_group(home, ops, event('mention'));
  assert.deepEqual(requests, [receipts.get('mention').id]);
  ops.decide = async () => ({ action: 'note', error: 'timed out' });
  await route_moss_group(home, ops, event('capped'));
  assert.equal(requests.length, 1);
  assert.equal(notices.length, 1);
  assert.equal(moss_windows(home)['fake:7'].last_failure.reason, 'timed out');
  const request = ops.request;
  ops.request = (...args) => args[1] === '/messages/97' ? { silent: true, text: 'handled' } : request(...args);
  await flush_moss_group(home, ops, { free: { requests: [{ message_id: requests[0], answer_id: 97 }] } });
  const window = moss_windows(home)['fake:7'];
  const pending_owner = { message_id: 99, platform_id: 'different-message' };
  save_moss_window(home, 'fake:7', { ...window, pending_owner });
  await route_moss_group(home, ops, event('owner', { mentioned: false, owner: true, sender: { id: 'owner', name: '同名' } }));
  assert.deepEqual(requests, [receipts.get('mention').id, receipts.get('owner').id]);
  assert.equal(moss_windows(home)['fake:7'].usage.used, 1);
  assert.deepEqual(moss_windows(home)['fake:7'].pending_owner, pending_owner);
});

test('private approval belongs to its owner; group output is quoted, text-only, bounded, and never retries an unknown send', async t => {
  const { home, ops, event, enable, receipts, requests, notices, sent, errors } = fixture(t);
  enable();
  ops.scheduler = { provider: 'jev' };
  ops.decide = async () => ({ action: 'owner', visibility: 'private' });
  await route_moss_group(home, ops, event('origin'));
  await route_moss_group(home, ops, event('other'));
  assert.equal(notices.length, 1);
  assert.equal(sent.length, 0);
  assert.equal(requests.length, 0);
  await route_moss_group(home, ops, event('impostor', { owner_notice: true }));
  await route_moss_group(home, ops, event('owner', { owner_notice: true, owner: true, sender: { id: 'owner', name: '同名' } }));
  assert.deepEqual(requests, [receipts.get('owner').id]);
  const answer = { id: 51, text: `${ops.config.site} ${'答'.repeat(550)}` };
  const request = ops.request;
  ops.request = (_, path, payload) => path === '/messages/51' ? answer : request(_, path, payload);
  ops.scheduler = null;
  const room = { free: { requests: [{ message_id: requests[0], answer_id: 51 }] } };
  await flush_moss_group(home, ops, room);
  assert.equal(sent.length, 3);
  assert.ok(sent.every(item => item.options.reply_to === 'origin' && !item.text.includes('site.test')));
  assert.match(sent[2].text, /已截断|Truncated/);
  await route_moss_group(home, ops, event('retry'));
  ops.channel.deliver = async () => { throw new Error('unknown provider receipt'); };
  room.free.requests = [{ message_id: requests[1], answer_id: 51 }];
  await flush_moss_group(home, ops, room);
  await flush_moss_group(home, ops, room);
  assert.equal(errors.filter(text => text.includes('unknown provider receipt')).length, 1);
});

test('group outbound attachments use channel capabilities, keep public links, and record each skip', async t => {
  const { home, ops, event, enable, requests, sent, errors } = fixture(t);
  enable();
  await route_moss_group(home, ops, event('media'));
  ops.channel.capabilities.media = { images: true, files: true, max_bytes: 5 };
  const downloads = [], delivered = [];
  ops.fetch_attachment = async (url, init) => { downloads.push({ url, init }); return new Response('abc'); };
  const deliver = ops.channel.deliver;
  ops.channel.deliver = (home, text, options) => {
    if (options.media) {
      const [{ path, name, type }] = options.media;
      delivered.push({ name, type, body: readFileSync(path, 'utf8'), reply_to: options.reply_to });
    }
    return deliver(home, text, options);
  };
  const image = { id: 'image', file_name: 'a.png', size: 3, content_type: 'image/png' };
  const file = { id: 'file', file_name: 'b.txt', size: 3, content_type: 'text/plain' };
  const answer = { text: 'https://public.test/demo [房间](http://site.test/?moss=1)', attachments: [image, file, { ...file, size: 6, id: 'oversize' }] };
  const request = ops.request;
  ops.request = (config, path, payload) => path === '/messages/61' ? answer : request(config, path, payload);
  const view = () => ({ free: { requests: [{ message_id: requests.at(-1), answer_id: 61 }] } });
  await flush_moss_group(home, ops, view());
  assert.deepEqual(delivered, [{ name: 'a.png', type: 'image', body: 'abc', reply_to: 'media' },
    { name: 'b.txt', type: 'file', body: 'abc', reply_to: 'media' }]);
  assert.equal(sent[0].text, 'https://public.test/demo 房间');
  assert.equal(downloads.length, 2);
  assert.equal(errors.length, 1);
  assert.match(sent.at(-1).text, /过大|too large/);
  ops.channel.capabilities.media = undefined;
  answer.attachments = [image];
  await route_moss_group(home, ops, event('text-only'));
  await flush_moss_group(home, ops, view());
  assert.equal(downloads.length, 2);
  assert.equal(errors.length, 2);
  assert.equal(sent.at(-1).options.reply_to, 'text-only');
});

test('where permitted, small-work delegation asks only about costly requests from non-owners', () => {
  const settings = { work_policy: 'small' };
  const decision = { action: 'respond', requests_work: true, costly: true };
  assert.deepEqual(moss_window_delegation(decision, false, settings), { ...decision, action: 'owner', visibility: 'group' });
  assert.equal(moss_window_delegation({ ...decision, costly: false }, false, settings).action, 'respond');
  assert.equal(moss_window_delegation(decision, true, settings).action, 'respond');
});

test('group link filter removes owner, relay, direct, loopback and pairing links only', () => {
  const text = '[房间](http://owner.test/r) https://relay.test/a https://direct.test/?room=1 http://[::1]:8765/ '
    + 'https://entry.test/#codiscuss-connect=opaque https://owner.test.example.org/docs https://public.test/demo';
  const result = group_public_text(text, ['http://OWNER.test', 'https://relay.test', 'https://direct.test']);
  assert.deepEqual(result.split(/\s+/), ['房间', 'https://owner.test.example.org/docs', 'https://public.test/demo']);
});

test('daily budget exhaustion is reported only once, and a silent answer costs a wake but sends nothing', async t => {
  const { home, ops, event, enable, notices, requests, sent } = fixture(t);
  enable();
  save_launch_settings(home, {}, { windows: { 'fake:7': { daily_limit: 1 } } });
  await route_moss_group(home, ops, event('first'));
  await route_moss_group(home, ops, event('second'));
  await route_moss_group(home, ops, event('third'));
  assert.equal(requests.length, 1);
  assert.equal(notices.length, 1);
  ops.request = async () => ({ silent: true, text: '不打扰群' });
  await flush_moss_group(home, ops, { free: { requests: [{ message_id: requests[0], answer_id: 13 }] } });
  assert.equal(sent.length, 0);
  assert.equal(moss_windows(home)['fake:7'].silent_count, 1);
});

test('only one request runs per group and a reply deemed obsolete stays in the window', async t => {
  const { home, ops, event, enable, requests, receipts, sent } = fixture(t);
  enable();
  await route_moss_group(home, ops, event('first'));
  await route_moss_group(home, ops, event('second'));
  assert.deepEqual(requests, [receipts.get('first').id]);
  ops.scheduler = { provider: 'jev' };
  const check = [];
  ops.check_output = async (...args) => { check.push(args[2]); return { action: 'note', send: false }; };
  const request = ops.request;
  ops.request = (config, path, payload) => path === '/messages/41' ? { id: 41, text: '旧答案' }
    : path.startsWith('/messages?after=') ? { messages: [receipts.get('second')] } : request(config, path, payload);
  await flush_moss_group(home, ops, { free: { requests: [{ message_id: requests[0], answer_id: 41 }] } });
  assert.equal(check.length, 1);
  assert.deepEqual(check[0].new_messages, [receipts.get('second')]);
  assert.equal(sent.length, 0);
  assert.deepEqual(requests, [receipts.get('first').id, receipts.get('second').id]);
});

test('window habits are scoped, and API groups have no cross-room, command or file tools', () => {
  const settings = { habits: { private: '私聊', group: '默认群' }, windows: { 'fake:7': { habit: '群覆盖' } } };
  assert.equal(moss_window_habits(settings).habit, '私聊');
  assert.equal(moss_window_habits(settings, 'fake:7').habit, '群覆盖');
  assert.equal(moss_window_habits(settings, 'fake:8').habit, '默认群');
  const tools = participant_tools({ tool_lockdown: true, role: 'member', silent_answer: true,
    allowed_room_tools: ['read_room', 'read_messages', 'read_message', 'read_question', 'ask_question', 'submit_chat'] });
  assert.ok(tools.find(item => item.name === 'submit_chat').parameters.properties.silent);
  assert.ok(tools.every(item => !item.parameters.properties.room && !/command|file|repo/.test(item.name)));
});

test('a public group question tags the actual owner once; an unmarked question stays private', async t => {
  const { home, ops, event, enable, sent, notices } = fixture(t);
  enable();
  ops.channel.owner_id = () => 'owner';
  await route_moss_group(home, ops, event('origin'));
  const notice = { key: 'question:12:1', question: { id: 12, version: 1 },
    room: { site: ops.config.site, room: ops.config.room }, paragraphs: ['公开问题', '1. 是'] };
  mark_question_public(home, ops.config.room, 12);
  assert.equal((await send_moss_group_question(home, ops, notice)).status, 'sent');
  await send_moss_group_question(home, ops, notice);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].options.mention, 'owner');
  assert.equal(sent[0].options.reply_to, 'origin');
  assert.equal(notices.length, 0);
  const window = moss_windows(home)['fake:7'];
  save_moss_window(home, 'fake:7', { ...window, pending_owner: null });
  const sensitive = { ...notice, key: 'question:13:1', question: { id: 13, version: 1 }, paragraphs: ['仅私聊'] };
  await send_moss_group_question(home, ops, sensitive);
  assert.equal(notices.length, 1);
  assert.equal(sent.length, 1);
});

test('an unquoted owner response judged relevant closes the wait, so the next owner prompt is delivered', async t => {
  const { home, ops, event, enable, sent, requests } = fixture(t);
  enable();
  ops.scheduler = { provider: 'jev' };
  ops.decide = async (_, __, { message }) =>
    message.external.owner && message.text === '可以' ? { action: 'respond' } : { action: 'owner', visibility: 'group' };
  await route_moss_group(home, ops, event('first'));
  assert.equal(sent.length, 1);
  await route_moss_group(home, ops, event('impostor', { sender: { id: 'alice', name: '房主' }, mentioned: false, text: '可以' }));
  assert.ok(moss_windows(home)['fake:7'].pending_owner);
  await route_moss_group(home, ops, event('actual', { sender: { id: 'owner', name: '房主' }, owner: true, mentioned: false, text: '可以' }));
  assert.equal(moss_windows(home)['fake:7'].pending_owner, null);
  assert.equal(requests.length, 1);
  assert.equal(moss_windows(home)['fake:7'].pending[requests[0]].reply.owner_answer_to, 1);
  await route_moss_group(home, ops, event('next'));
  assert.equal(sent.length, 2);
});

test('a qualifying owner mention accepts a natural answer to the structured question as free text', async t => {
  const { home, ops, event, enable } = fixture(t);
  enable();
  save_moss_window(home, 'fake:7', { ...moss_windows(home)['fake:7'], pending_owner: { question: { id: 4, version: 1 }, platform_id: 'original' } });
  const original_request = ops.request;
  let submitted;
  ops.request = (config, path, payload) => {
    if (path === '/questions/4') return { status: 'waiting_user', version: 1,
      questions: [{ id: 'approve', options: [{ id: 'yes', label: '同意' }, { id: 'no', label: '拒绝' }] }] };
    if (path === '/questions/4/answer') { submitted = payload; return { message_id: 52 }; }
    return original_request(config, path, payload);
  };
  await route_moss_group(home, ops, event('owner-reply', { sender: { id: 'owner', name: '房主' }, owner: true, text: '可以' }));
  assert.equal(submitted.action, 'other');
  assert.equal(submitted.text, '可以');
  assert.equal(moss_windows(home)['fake:7'].pending_owner, null);
  assert.equal(moss_windows(home)['fake:7'].pending[52].platform_id, 'original');
});

test('group input has a separate 2000-code-point storage limit', async t => {
  const { home, ops, event, enable, receipts } = fixture(t);
  enable();
  for (const length of [501, 2000, 2001]) {
    const text = '🙂'.repeat(length);
    await route_moss_group(home, ops, event(String(length), { text, mentioned: false }));
    const actual = receipts.get(String(length)).text;
    if (length <= 2000) assert.equal(actual, text);
    else { assert.equal([...actual].length, 2000); assert.match(actual, /已截断|Truncated/); }
  }
});

test('a withdrawn active request does not leave the next group request blocked', async t => {
  const { home, ops, event, enable, requests, receipts } = fixture(t);
  enable();
  await route_moss_group(home, ops, event('withdrawn'));
  await route_moss_group(home, ops, event('next'));
  assert.deepEqual(requests, [receipts.get('withdrawn').id]);
  const request = ops.request;
  const withdrawn = { free: { requests: [] } };
  let live = { free: { requests: [{ message_id: requests[0] }] } };
  ops.request = (config, path, payload) => path === '' ? live : request(config, path, payload);
  await flush_moss_group(home, ops, withdrawn);
  assert.equal(requests.length, 1, 'a stale snapshot does not discard a live request');
  live = withdrawn;
  await flush_moss_group(home, ops, withdrawn);
  assert.deepEqual(requests, [receipts.get('withdrawn').id, receipts.get('next').id]);
});

test('the paired-device notify action clears a pending wait without starting a request', async t => {
  const { home, channel, enable, requests } = fixture(t);
  enable();
  save_moss_window(home, 'fake:7', { ...moss_windows(home)['fake:7'], pending_owner: { message_id: 8 } });
  const payload = { action: 'group-clear-pending', channel: 'fake', chat_id: '7' };
  const { command, input } = relayed_command('https://example.com', 'notify', payload);
  assert.equal(command, 'notify');
  const before = await moss_group_command(home, { action: 'groups', channel: 'fake' }, { channels: [channel] });
  assert.equal(before.groups[0].pending_owner, true);
  const result = await moss_group_command(home, input, { channels: [channel] });
  assert.equal(result.group.pending_owner, false);
  assert.equal(moss_windows(home)['fake:7'].enabled, true);
  assert.deepEqual(requests, []);
});

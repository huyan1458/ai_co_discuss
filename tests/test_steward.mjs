import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import test from 'node:test';

import { activate_steward_for_delivery, host_control, launch_settings, save_launch_projects, save_launch_settings, steward_command } from '../runner/discussion_launch.mjs';
import { free_task_files, user_request_texts } from '../runner/free_runner.mjs';
import { relayed_command, run_launch_command } from '../runner/remote_launch.mjs';
import { DiscussionService, read_registry } from '../runner/discussion_service.mjs';
import { proactive_settings, revise_proactive_list, steward_proactive_tick } from '../runner/steward_proactive.mjs';
import { require_steward_skill, steward_cli, steward_defaults, steward_message, steward_settings_patch, steward_skill, steward_status, steward_task_catalog, sync_steward_platform_skills } from '../runner/steward.mjs';

function temp(t) {
  const path = mkdtempSync(join(tmpdir(), 'steward-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function add_skill(project, root, name) {
  const path = join(project, root, name, 'SKILL.md');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `---\nname: ${name}\ndescription: Test description for ${name}\n---\n# Test skill`);
  return path;
}

test('proactive polling only wakes on eligible transitions, defers when busy and groups the digest', async t => {
  const home = temp(t);
  const config = { room: 'moss', site: 'http://127.0.0.1:1' };
  const settings = proactive_settings({ enabled: true, duties: [{ text: 'track these projects' }] });
  const states = { first: 'running', second: 'running', third: '' };
  let reads = 0, busy = false;
  const sent = [];
  const tick = (hour, min, prefs = settings) => steward_proactive_tick(home, config, prefs, {
    now: new Date(2026, 10, 27, hour, min),
    rooms: async () => { reads++; return Object.entries(states).map(([id, attention]) => ({ id, attention, latest_id: 8 })); },
    send: async (_, batch) => busy ? { busy: true } : (sent.push(batch), { message: { id: sent.length } }),
  });
  await tick(9, 0, { ...settings, enabled: false });
  await tick(9, 0, { ...settings, duties: [] });
  assert.equal(reads, 0);
  await tick(8, 59);
  assert.equal(reads, 1);
  await tick(9, 0);
  await tick(9, 1);
  assert.deepEqual(sent, []);
  states.first = 'waiting_user';
  busy = true;
  await tick(9, 2);
  assert.deepEqual(sent, []);
  busy = false;
  await tick(9, 3);
  assert.deepEqual(sent.map(batch => batch.events.map(event => event.type)), [['waiting_user']]);
  states.second = '';
  states.third = 'failed';
  await tick(20, 59);
  assert.equal(sent.length, 1);
  await tick(21, 0);
  await tick(21, 1);
  await tick(22, 0);
  assert.deepEqual(sent.map(batch => batch.events.map(event => event.type)), [['waiting_user'], ['completed', 'failed']]);
});

test('night transitions carry to the next active period, resolved waits are discarded and late digest moves to opening', async t => {
  const home = temp(t), config = { room: 'moss', site: 'http://127.0.0.1:1' };
  const settings = proactive_settings({ enabled: true, digest_at: '23:30', duties: [{ text: 'Track projects' }] });
  const states = { wait: '', resolved: '', failed: 'running', done: 'running' };
  const sent = [];
  const tick = (day, hour, minute = 0) => steward_proactive_tick(home, config, settings, {
    now: new Date(2026, 10, day, hour, minute),
    rooms: async () => Object.entries(states).map(([id, attention]) => ({ id, attention })),
    send: async (_, batch) => { sent.push(batch.events.map(event => [event.room, event.type])); return { message: { id: sent.length } }; },
  });
  await tick(27, 22);
  states.wait = states.resolved = 'waiting_user';
  states.failed = 'failed';
  await tick(27, 23, 30);
  states.resolved = '';
  states.done = '';
  await tick(28, 8, 59);
  assert.deepEqual(sent, []);
  await tick(28, 9);
  await tick(28, 9, 1);
  await tick(28, 9, 2);
  assert.deepEqual(sent, [[['wait', 'waiting_user']], [['failed', 'failed'], ['done', 'completed']]]);
});

test('muted reports retain at most fifty short Unicode excerpts', () => {
  const settings = proactive_settings({ mutes: Array.from({ length: 50 }, (_, index) => ({ id: String(index) })) });
  const text = '😀'.repeat(201);
  const mutes = revise_proactive_list(settings, 'mutes', 'add', { text, reason: 'Already seen' });
  assert.equal(mutes.length, 50);
  assert.equal(mutes[0].id, '1');
  assert.equal(mutes.at(-1).text, '😀'.repeat(200));
});

test('a lost proactive receipt retries the same submission after a new polling call', async t => {
  const home = temp(t), config = { room: 'moss', site: 'http://127.0.0.1:1' };
  const settings = proactive_settings({ enabled: true, duties: [{ text: 'Track replies' }] });
  const project = { id: 'project', attention: '' }, attempts = [];
  const options = { now: new Date(2026, 10, 27, 10), rooms: async () => [project], send: async (_, batch) => {
    attempts.push(batch.id);
    if (attempts.length === 1) throw new Error('lost reply');
    return { message: { id: 1 } };
  } };
  await steward_proactive_tick(home, config, settings, options);
  project.attention = 'waiting_user';
  await assert.rejects(steward_proactive_tick(home, config, settings, options), /lost reply/);
  await steward_proactive_tick(home, config, settings, options);
  await steward_proactive_tick(home, config, settings, options);
  assert.deepEqual(attempts, [attempts[0], attempts[0]]);
});

test('steward defaults are read-only until launch and settings may only change editable fields', t => {
  const home = temp(t);
  add_skill(home, '.agents/steward-skills', 'share-card');
  add_skill(home, '.agents/steward-skills', 'dispatch-analysis');
  const settings = { participants: { Claude: { adapter: 'claude', model: 'opus', effort: 'high' } } };
  const defaults = steward_defaults(home, settings, home);
  assert.deepEqual(defaults, { adapter: '', model: '', effort: '', project_access: 'full',
    cwd: join(`${home}-workspace`, 'steward'), skills: ['dispatch-analysis', 'share-card'], create_rooms: true, proactive: proactive_settings(),
    habits: { private: '', group: '' }, windows: {} });
  assert.equal(steward_defaults(home, { ...settings, steward: { adapter: 'claude' } }, home).model, 'opus');
  assert.equal(existsSync(defaults.cwd), false);
  assert.deepEqual(steward_settings_patch({ room_id: 'wrong', skills: ['share-card', 'share-card'], effort: '' }), { skills: ['share-card'], effort: '' });
  assert.throws(() => steward_settings_patch({ cwd: 'relative', skills: ['discuss-host'] }));
  assert.deepEqual(steward_settings_patch({ project_access: 'own' }), {});
  assert.throws(() => steward_settings_patch({ create_rooms: 'off' }));
});

test('skills require permission and are resolved only in the package steward directory', t => {
  const home = temp(t);
  add_skill(home, '.agents/skills', 'share-card');
  add_skill(home, '.claude/skills', 'share-card');
  assert.equal(steward_skill('share-card', home), '');
  const skill = add_skill(home, '.agents/steward-skills', 'share-card');
  add_skill(home, '.agents/steward-skills', 'dispatch-review');
  assert.equal(steward_skill('share-card', home), skill);
  assert.doesNotThrow(() => require_steward_skill({}, 'share-card', home));
  assert.throws(() => require_steward_skill({ steward: { skills: [] } }, 'share-card', home));
  assert.throws(() => require_steward_skill({}, 'dispatch-review', home));
  assert.throws(() => require_steward_skill({}, '../share-card', home));
});

test('saving proactive controls preserves duties and mutes until removed by ID', async t => {
  const home = temp(t);
  const command = (action, input) => steward_command(home, action, input);
  const first = (await command('steward-duty', { action: 'add', text: 'Track replies' })).duties[0];
  const second = (await command('steward-duty', { action: 'add', text: 'Track failures' })).duties[1];
  const mutes = [
    { id: 'mute-one', text: 'No update needed', reason: 'Already handled', created_at: first.created_at },
    { id: 'mute-two', text: 'Old handoff', reason: 'Tracked elsewhere', created_at: first.created_at },
  ];
  const initial = launch_settings(home).steward.proactive;
  save_launch_settings(home, {}, { proactive: { ...initial, mutes } });
  const controls = { enabled: true, active_hours: { start: '08:00', end: '20:30' }, digest_at: '19:30' };
  const saved = await command('steward-settings', { proactive: controls });
  assert.deepEqual(saved.settings.proactive, { ...controls, duties: [first, second], mutes });
  await assert.rejects(command('steward-settings', { proactive: { mutes: [], duties: [] } }), /MOSS/);
  await command('steward-settings', { proactive: { enabled: false } });
  await command('steward-duty', { action: 'remove', id: first.id });
  await command('steward-mute', { action: 'remove', id: 'mute-two' });
  assert.deepEqual((await command('steward')).settings.proactive, {
    ...controls, enabled: false, duties: [second], mutes: [mutes[0]],
  });
});

test('the delivered steward task brings the participant pages and only allowed first-line skills', t => {
  const home = temp(t);
  const share = add_skill(home, '.agents/steward-skills', 'share-card');
  add_skill(home, '.agents/steward-skills', 'local-tts-setup');
  const analysis = add_skill(home, '.agents/steward-skills', 'dispatch-analysis');
  const config = { site: 'http://127.0.0.1:1', room: 'steward', directory: home, project: home, api_home: home,
    steward: true, steward_skills: ['local-tts-setup'],
    members: { Codex: { token: 'x'.repeat(32) } }, participants: { Codex: { adapter: 'codex_cli' } } };
  writeFileSync(join(home, 'launch-settings.json'), JSON.stringify({ steward: { skills: ['share-card', 'dispatch-analysis', 'notify-setup'] } }));
  const task = free_task_files(config, { name: 'Codex', role: 'host' }, {
    id: 1, read_until: 0, requests: [{ id: 1, message_id: 1, purpose: 'route' }],
  }, {}, { request_texts: ['/share-card\n\nnote\n/local-tts-setup', '/local-tts-setup', '/dispatch-analysis\r\n', '/share-card'] });
  const delivered = JSON.parse(readFileSync(task.task_path, 'utf8'));
  assert.equal(delivered.steward, true);
  assert.ok(delivered.subcommands.includes('room dispatches'));
  assert.equal(JSON.parse(readFileSync(task.access_path, 'utf8')).steward, true);
  assert.equal(delivered.role, 'member');
  assert.deepEqual(delivered.host_permissions, ['create_rooms']);
  assert.match(delivered.instructions, /steward_skill_catalog/);
  assert.deepEqual(delivered.steward_skill_catalog, [
    { id: 'dispatch-analysis', description: 'Test description for dispatch-analysis', path: analysis },
    { id: 'share-card', description: 'Test description for share-card', path: share },
  ]);
  assert.deepEqual(delivered.skills.map(path => path.slice(home.length + 1).split(sep).join('/')), [
    '.agents/skills/discuss-participant/SKILL.md', '.agents/skills/discuss-participant/references/room.md',
    '.agents/steward-skills/moss-core/SKILL.md',
    '.agents/steward-skills/share-card/SKILL.md', '.agents/steward-skills/dispatch-analysis/SKILL.md',
  ]);
  writeFileSync(join(home, 'launch-settings.json'), JSON.stringify({ steward: {
    skills: ['share-card', 'dispatch-analysis', 'notify-setup'], create_rooms: false,
  } }));
  const manual = free_task_files(config, { name: 'Codex', role: 'host' }, { id: 2, requests: [] }, {},
    { request_texts: ['帮我做一张分享卡'] });
  const direct = JSON.parse(readFileSync(manual.task_path, 'utf8'));
  assert.deepEqual(direct.skills, delivered.skills.slice(0, 3), 'every request preloads moss-core, even when delegation is disabled');
  assert.deepEqual(direct.host_permissions, []);
  assert.deepEqual(direct.steward_skill_catalog, delivered.steward_skill_catalog);
  assert.ok(manual.skill_directories.includes(dirname(share)));
});

test('request text localizes full sentences and CLI and remote actions use the same command names', async () => {
  assert.match(steward_message('share-card', { room_id: 'r' }, 'en-US'), /^\/share-card\n\nUse the specified skill[^\n]+\n\nTask context:\n[\s\S]*"room_id": "r"/);
  assert.match(steward_message('share-card', '补充', 'zh-CN'), /^\/share-card\n\n请使用指定技能[^\n]+\n\n任务上下文：\n补充$/);
  const dispatch = (...args) => args;
  assert.deepEqual(await steward_cli(['settings', '--effort', 'high', '--skills', 'share-card'], dispatch),
    ['steward-settings', { effort: 'high', skills: ['share-card'] }]);
  assert.deepEqual(await steward_cli(['settings', '--create-rooms', 'off'], dispatch), ['steward-settings', { create_rooms: false }]);
  assert.deepEqual(await steward_cli(['settings', '--create-rooms', 'on'], dispatch), ['steward-settings', { create_rooms: true }]);
  await assert.rejects(steward_cli(['settings', '--room-limit', '4'], dispatch), { code: 'ERR_PARSE_ARGS_UNKNOWN_OPTION' });
  assert.deepEqual(await steward_cli(['settings', '--proactive', 'on', '--active-hours', '09:00-22:00', '--digest-at', '21:00'], dispatch),
    ['steward-settings', { proactive: { enabled: true, active_hours: { start: '09:00', end: '22:00' }, digest_at: '21:00' } }]);
  assert.deepEqual(await steward_cli(['duty', 'add', '--text', 'Track replies'], dispatch), ['steward-duty', { action: 'add', text: 'Track replies' }]);
  assert.deepEqual(await steward_cli(['mute', '42', '--reason', 'Covered'], dispatch), ['steward-mute', { message_id: 42, reason: 'Covered' }]);
  await assert.rejects(steward_cli(['settings', '--create-rooms', 'maybe'], dispatch), /--create-rooms/);
  assert.deepEqual((await steward_cli(['ask', 'share-card', '--room', 'r'], dispatch))[1].context, { room_id: 'r' });
  assert.equal((await steward_cli(['ask', 'share-card'], dispatch))[1].confirmed, undefined);
  assert.equal((await steward_cli(['ask', 'local-tts-setup', '--confirm'], dispatch))[1].confirmed, true);
  await assert.rejects(steward_cli(['ask', 'local-tts-setup'], dispatch), /--confirm/);
  for (const action of ['steward', 'steward-settings', 'steward-request', 'steward-duty', 'steward-mute']) {
    assert.equal(relayed_command('https://relay.test', action, {}).command, action);
  }
});

test('only boolean confirmation for install, configuration or deployment skills appears in the request text', () => {
  const statement = '用户已确认本次安装、配置或部署。';
  for (const skill of ['local-tts-setup', 'local-stt-setup', 'notify-setup', 'cloudflare-deploy']) {
    assert.ok(steward_message(skill, null, 'zh-CN', true).includes(statement));
    assert.ok(!steward_message(skill, null, 'zh-CN').includes(statement));
    assert.ok(!steward_message(skill, null, 'zh-CN', 'true').includes(statement));
  }
  assert.match(steward_message('cloudflare-deploy', null, 'en', true), /The user confirmed this installation, configuration, or deployment\./);
  assert.ok(!steward_message('codiscuss-draft-cleanup', null, 'zh-CN', true).includes(statement));
});

test('steward CLI lists archived conversations and requires confirmation before deleting one or deploying', async () => {
  const dispatch = (...args) => args;
  assert.deepEqual(await steward_cli(['history'], dispatch), ['steward-history', {}]);
  assert.deepEqual(await steward_cli(['renew'], dispatch), ['steward-renew', {}]);
  await assert.rejects(steward_cli(['delete', 'old'], dispatch), /--confirm/);
  assert.deepEqual(await steward_cli(['delete', 'old', '--confirm'], dispatch), ['steward-delete', { room_id: 'old' }]);
  await assert.rejects(steward_cli(['ask', 'cloudflare-deploy'], dispatch), /--confirm/);
  assert.equal((await steward_cli(['ask', 'cloudflare-deploy', '--confirm'], dispatch))[1].confirmed, true);
});

async function steward_fixture(t, { replacement_blocked = false, selected = true, lost_switch_reply = false } = {}) {
  const home = temp(t);
  const requests = [];
  const archives = [];
  const deletes = [];
  const controls = [];
  const rooms = new Map();
  let next_room = 0;
  const server = createServer(async (request, response) => {
    const [, id, tail] = /^\/api\/rooms(?:\/([^/]+))?(?:\/(.*))?$/.exec(request.url) || [];
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const payload = raw && JSON.parse(raw);
    let room = rooms.get(id);
    let result;
    if (!id && request.method === 'POST') {
      requests.push(payload);
      const existing = [...rooms.values()].find(room => !room.archived && room.system_kind === 'steward');
      if (existing && payload.system_kind === 'steward') {
        response.statusCode = 409;
        result = { error: 'steward already exists', room_id: existing.id };
      } else if (replacement_blocked) {
        response.statusCode = 503;
        result = { error: 'replacement temporarily unavailable' };
      } else {
        next_room = Math.max(next_room, rooms.size) + 1;
        room = { id: `room-${next_room}`, title: payload.title, mode: 'free', host: payload.host,
          system_kind: payload.system_kind, archived: false, members: payload.members };
        room.free = { members: room.members.map(member => ({ ...member, status: 'active', role: member.name === room.host ? 'host' : 'member' })) };
        rooms.set(room.id, room);
        result = room;
      }
    } else if (!id && request.method === 'GET') {
      result = { rooms: [...rooms.values()].map(({ id, system_kind, archived }) => ({ id, system_kind, archived })) };
    } else if (room && tail === 'steward-member' && room.busy) {
      result = { busy: true };
    } else if (room && tail === 'steward-member') {
      room.host = payload.name;
      room.members = [...room.members.map(member => ({ ...member, status: 'removed' })), { ...payload, status: 'active' }];
      if (lost_switch_reply) {
        response.statusCode = 503;
        result = { error: 'replacement reply lost' };
      } else result = room;
    } else if (room && tail === 'archive') {
      archives.push({ id, actor: payload.actor, token: request.headers['x-discussion-token'] });
      room.archived = true;
      result = room;
    } else if (room && tail === 'delete') {
      deletes.push({ id, payload });
      if (payload.archived_steward_only !== true || room.system_kind !== 'steward' || !room.archived) {
        response.statusCode = 409;
        result = { error: 'not an archived steward' };
      } else {
        rooms.delete(id);
        result = { deleted: true };
      }
    } else if (room && tail === 'messages') {
      requests.push(payload);
      result = { message: { id: requests.length } };
    } else if (room && /^messages\/\d+$/.test(tail || '')) {
      result = room.messages?.[tail.split('/')[1]] || {};
    } else if (room && ['host-room-post', 'room-relay-sent', 'room-link', 'budget'].includes(tail)) {
      controls.push({ id, tail, payload, acting: request.headers['x-acting-member-token'] });
      result = tail === 'host-room-post' ? { message: { id: controls.length } } : {};
    } else if (room && !tail && room.unreadable) {
      response.statusCode = 503;
      result = { error: 'room temporarily unreadable' };
    } else if (room) result = tail === 'inbox' ? {} : room;
    else { response.statusCode = 404; result = { error: 'not found' }; }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(result));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  writeFileSync(join(home, 'local-settings.json'), JSON.stringify({ port: server.address().port, workspace: home }));
  writeFileSync(join(home, 'launch-settings.json'), JSON.stringify({ participants: {
    Codex: { adapter: 'codex_cli', executable: process.execPath, model: 'test-model' },
    Claude: { adapter: 'claude', executable: process.execPath, model: 'test-other-model' },
  }, ...(selected ? { steward: { adapter: 'codex_cli', skills: ['share-card'] } } : {}) }));
  return { home, requests, archives, deletes, rooms, controls, options: { start_service: async () => ({ running: true }) } };
}

test('MOSS uses saved project defaults and an isolated task preset, with no child-room cap', async t => {
  const { home, options, requests, controls, archives, rooms } = await steward_fixture(t);
  const opened = await steward_command(home, 'steward', { open: true }, options);
  assert.equal(opened.settings.room_limit, undefined);
  const source = JSON.parse(readFileSync(read_registry(home)[0], 'utf8'));
  const token = Object.values(source.members)[0].token;
  const access_file = join(home, 'steward-access.json');
  writeFileSync(access_file, JSON.stringify({ site: source.site, room: opened.room_id, token, execution_id: 1 }));
  const run = (action, input) => host_control(home, action, { ...input, access_file }, options);
  const duty = (await run('duty', { do: 'add', text: 'Track failed rooms' })).duties[0];
  assert.equal(duty.text, 'Track failed rooms');
  assert.deepEqual((await steward_command(home, 'steward-duty', { action: 'list' })).duties, [duty]);
  assert.deepEqual((await run('duty', { do: 'remove', id: duty.id })).duties, []);
  const saved_dir = join(home, 'saved');
  mkdirSync(saved_dir);
  save_launch_projects(home, { projects: [{ name: 'Saved', path: saved_dir }] });
  save_launch_settings(home, { create_preferences: { members: ['Codex', 'Claude'], host: 'Claude' } });
  const draft = { title: 'Project work', submission_id: 'project-room-001', host: 'Unknown', members: 'Unknown', access: 'full' };
  await assert.rejects(run('create-room', { ...draft, cwd: home }), /已保存|saved/);
  const child = await run('create-room', { ...draft, cwd: saved_dir });
  assert.equal(child.cwd, saved_dir);
  assert.equal(child.host, 'Claude');
  assert.deepEqual(child.members, ['Codex', 'Claude']);
  assert.equal(child.project_access, 'read');
  assert.deepEqual(controls.filter(item => item.tail === 'room-link').map(item => [item.id, item.payload.relation, item.payload.room_id]), [
    [opened.room_id, 'child', child.room_id], [child.room_id, 'parent', opened.room_id],
  ]);
  for (const option of [{ interrupt: true }, { member: 'Codex' }]) {
    await assert.rejects(run('room-post', { room: child.room_id, text: 'Hello', ...option }), /不能|cannot/);
  }
  await assert.rejects(run('room-post', { room: opened.room_id, text: 'Hello' }), /项目房间|project room/);
  const relay = await run('room-post', { room: child.room_id, text: 'Hello', expect: 'reply' });
  assert.ok(relay.message_id);
  assert.equal(controls.find(item => item.tail === 'host-room-post').payload.expect, 'reply');
  assert.equal(controls.find(item => item.tail === 'host-room-post').acting, token);
  for (const action of ['stop', 'steer', 'retry', 'invite', 'access', 'remove', 'withdraw']) {
    await assert.rejects(run(action, {}), /无权|not permitted/);
  }
  const scratch = await run('create-room', { title: 'Scratch', submission_id: 'project-room-002' });
  assert.ok(scratch.cwd && scratch.cwd !== source.cwd && scratch.cwd !== saved_dir);
  const task = await run('create-room', { title: 'Third', submission_id: 'project-room-003', preset: 'task', cwd: saved_dir,
    access: 'full', host: 'Claude', members: 'Claude,Codex', host_model: 'ignore-model' });
  assert.deepEqual([task.host, task.members, task.project_access, task.preset], ['Codex', ['Codex'], 'write', 'task']);
  assert.ok(task.cwd !== source.cwd && task.cwd !== saved_dir && task.cwd !== scratch.cwd);
  assert.equal(scratch.preset, null);
  const task_config = read_registry(home).map(path => JSON.parse(readFileSync(path, 'utf8'))).find(config => config.room === task.room_id);
  assert.equal(task_config.participants.Codex.model, source.participants.Codex.model);
  assert.equal(task_config.participants.Codex.adapter, source.participants.Codex.adapter);
  assert.equal(task_config.participants.Codex.session_id, undefined);
  assert.equal(task_config.host_permissions, undefined);
  const delivered_task = free_task_files(task_config, { name: 'Codex', role: 'host' }, { id: 99, requests: [{ id: 1, message_id: 1 }] }, {});
  const delivered = JSON.parse(readFileSync(delivered_task.task_path, 'utf8'));
  assert.equal(delivered.parent_room, opened.room_id);
  assert.ok(delivered.instructions.includes(`--room ${opened.room_id} --expect reply`));
  const fourth = await run('create-room', { title: 'Fourth', submission_id: 'project-room-004' });
  assert.ok(fourth.room_id);
  assert.equal(requests.length, 5, 'a fourth child can be created with the first three still open');
  await run('archive-room', { room: child.room_id });
  assert.equal(archives.at(-1).token, token, 'archive never borrows the target room owner token');
  save_launch_settings(home, { create_preferences: { host_project_access: 'auto',
    host_permissions: { items: ['execution', 'roster', 'create_rooms'] } } });
  const next = await run('create-room', { title: 'After archive', submission_id: 'project-room-005', access: 'full' });
  assert.equal(next.project_access, 'write');
  const config_for = id => read_registry(home).map(path => JSON.parse(readFileSync(path, 'utf8'))).find(config => config.room === id);
  const next_config = config_for(next.room_id);
  assert.ok(Object.values(next_config.participants).every(profile => profile.project_access === 'write'));
  assert.deepEqual(next_config.host_permissions.items, ['execution', 'roster']);
  assert.ok(!config_for(opened.room_id).spawned_rooms.some(item => item.room === child.room_id), 'prune an archived child');
  rooms.delete(scratch.room_id);
  rooms.get(task.room_id).unreadable = true;
  save_launch_settings(home, { create_preferences: { host_project_access: 'full' } });
  assert.equal((await run('create-room', { title: 'After deletion', submission_id: 'project-room-006' })).project_access, 'write');
  const tracked = config_for(opened.room_id).spawned_rooms.map(item => item.room);
  assert.ok(!tracked.includes(scratch.room_id), 'prune a confirmed missing child');
  assert.ok(tracked.includes(task.room_id), 'retain a child on read failure');
  await steward_command(home, 'steward-settings', { create_rooms: false }, options);
  assert.equal((await steward_command(home, 'steward')).settings.create_rooms, false);
  await assert.rejects(run('create-room', { title: 'Off' }), /新建房间|create rooms/i);
  await assert.rejects(run('room-post', { room: next.room_id, text: 'Off' }), /新建房间|create rooms/i);
});

test('the MOSS review task includes the original outbound instruction and its child room link', async t => {
  const { home, rooms, options } = await steward_fixture(t);
  const { room_id } = await steward_command(home, 'steward', { open: true }, options);
  const config = JSON.parse(readFileSync(read_registry(home)[0], 'utf8'));
  rooms.get(room_id).messages = {
    10: { id: 10, source: 'room_relay_sent', text: 'Original instruction', relay_sent_room: 'child-room',
      relay_report_state: 'completed', relay_report_message_id: 24 },
  };
  const execution = { id: 1, requests: [{ id: 1, message_id: 10, purpose: 'notice' }] };
  await user_request_texts(config, execution);
  const task = free_task_files(config, { name: 'Codex', role: 'host' }, execution, {});
  const review = JSON.parse(readFileSync(task.task_path, 'utf8')).requests[0].steward_review;
  assert.deepEqual(review, { source_message_id: 10, text: 'Original instruction', room_id: 'child-room', url: `${config.site}/?room=child-room`,
    state: 'completed', result_message_id: 24 });
});

test('history lists only archived steward rooms and paired devices can delete only those', async t => {
  const { home, deletes, rooms } = await steward_fixture(t, { selected: false });
  const previous = process.env.DISCUSS_SERVICE_HOME;
  process.env.DISCUSS_SERVICE_HOME = home;
  t.after(() => { if (previous === undefined) delete process.env.DISCUSS_SERVICE_HOME; else process.env.DISCUSS_SERVICE_HOME = previous; });
  const archived_at = '2026-11-27T12:00:00Z';
  rooms.set('old', { id: 'old', system_kind: 'steward', archived: true, archived_at, free: { members: [{ adapter: 'claude' }] } });
  rooms.set('current', { id: 'current', system_kind: 'steward', archived: false });
  rooms.set('ordinary', { id: 'ordinary', system_kind: '', archived: true });
  const relay = (action, input) => run_launch_command(relayed_command('https://relay.test', action, input));
  assert.deepEqual(await relay('steward-history'), { status: 200, body: { rooms: [{ room_id: 'old', archived_at, adapter: 'claude' }] } });
  for (const room_id of ['current', 'ordinary']) {
    await assert.rejects(steward_command(home, 'steward-delete', { room_id }), /已存档|archived/i);
    assert.ok(rooms.has(room_id));
  }
  assert.deepEqual(deletes, []);
  assert.deepEqual(await relay('steward-delete', { room_id: 'old' }), { status: 200, body: { room_id: 'old', deleted: true } });
  assert.deepEqual(deletes, [{ id: 'old', payload: { actor: '用户', archived_steward_only: true } }]);
  assert.deepEqual((await relay('steward-history')).body, { rooms: [] });
});

test('nothing opens or posts until the user chooses software, even with a configured participant', async t => {
  const { home, requests, options } = await steward_fixture(t, { selected: false });
  const command = (action, input = {}) => steward_command(home, action, input, options);
  assert.equal((await command('steward')).configured, false);
  await assert.rejects(command('steward', { open: true }), { code: 'steward_not_configured' });
  await assert.rejects(command('steward-request', { skill: 'share-card' }), { code: 'steward_not_configured' });
  await assert.rejects(steward_cli(['ask', 'share-card'], command), /codiscuss steward settings --adapter/);
  assert.equal(requests.length, 0);
  assert.equal(existsSync(join(home, 'launches')), false);
});

test('MOSS always runs with full access: no setting raises or lowers it, and command skills go to MOSS itself', async t => {
  const { home, requests, options } = await steward_fixture(t);
  const command = (action, input) => steward_command(home, action, input, options);
  await command('steward-settings', { skills: ['local-tts-setup', 'codiscuss-draft-cleanup', 'discuss-report'] });
  // A level saved by an older version, or sent by an older page or command, is ignored.
  const settings_path = join(home, 'launch-settings.json');
  const saved = JSON.parse(readFileSync(settings_path, 'utf8'));
  writeFileSync(settings_path, JSON.stringify({ ...saved, steward: { ...saved.steward, project_access: 'read' } }));
  assert.equal((await command('steward-settings', { project_access: 'read' })).settings.project_access, 'full');
  await assert.rejects(steward_cli(['settings', '--access', 'read'], command));
  await command('steward', { open: true });
  const [path] = read_registry(home);
  const config = () => JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(config().participants.Codex.project_access, 'full');
  // A room from an older version is brought to full access before the next delivery.
  writeFileSync(path, JSON.stringify({ ...config(), participants: { Codex: { ...config().participants.Codex, project_access: 'read' } } }));
  assert.equal(await activate_steward_for_delivery(config()), true);
  assert.equal(config().participants.Codex.project_access, 'full');
  for (const request of [{ skill: 'local-tts-setup', confirmed: true }, { skill: 'codiscuss-draft-cleanup' }, { skill: 'discuss-report' }]) {
    const sent = await command('steward-request', request);
    assert.equal(sent.room_id, config().room);
    assert.ok(requests.at(-1).text.startsWith(`/${request.skill}\n`));
  }
  assert.equal(read_registry(home).length, 1, 'no task room is made for them');
});

test('unquoted DMs use an independent private MOSS and quoted reports stay in their original room', async t => {
  const { home, requests, options } = await steward_fixture(t, { selected: false });
  const service = new DiscussionService(home);
  const reply = { channel: 'telegram', label: 'Telegram', text: 'How do I get started?' };
  assert.match(await service.moss_reply(reply), /\?moss=settings$/);
  assert.equal(requests.length, 0);
  await steward_command(home, 'steward-settings', { adapter: 'codex_cli', skills: [] }, options);
  const main = await steward_command(home, 'steward', { open: true }, options);
  assert.match(await service.moss_reply(reply), /\?moss=settings$/);
  await steward_command(home, 'steward-settings', { window: 'private', adapter: 'codex_cli', skills: [] }, options);
  await service.moss_reply(reply);
  assert.equal(requests.length, 3);
  assert.equal(requests[1].system_kind, 'steward_private');
  assert.equal(requests[2].author, '用户');
  assert.equal(requests[2].queue, true);
  assert.match(requests[2].text, /Telegram\n\nHow do I get started\?$/);
  const saved = launch_settings(home).steward;
  assert.notEqual(saved.private.room_id, main.room_id);
  const configs = read_registry(home).map(file => JSON.parse(readFileSync(file, 'utf8')));
  const main_config = configs.find(config => config.room === main.room_id);
  const private_config = configs.find(config => config.room === saved.private.room_id);
  assert.equal(private_config.cwd, join(dirname(main_config.cwd), 'steward-private'));
  assert.equal(private_config.participants.Codex.project_access, 'read');
  await steward_command(home, 'steward-settings', { window: 'private', project_access: 'auto' }, options);
  assert.equal((await steward_command(home, 'steward', { window: 'private' })).settings.project_access, 'auto');
  assert.equal((await steward_command(home, 'steward')).settings.project_access, 'full');
  await assert.rejects(steward_command(home, 'steward-request', { window: 'private', skill: 'cloudflare-deploy', confirmed: true }, options));
  await service.moss_reply({ ...reply, text: 'Reply to the quoted report' }, { config: main_config, wake() {} });
  assert.match(requests.at(-1).text, /Reply to the quoted report/);
});

test('platform skills are copied for the steward but never advertised in other MOSS windows', t => {
  const home = temp(t);
  const project = process.cwd();
  save_launch_settings(home, {}, { skills: ['local-stt-setup'], private: { skills: ['share-card'] }, windows: { 'fake:7': { skills: ['share-card'] } } });
  sync_steward_platform_skills(home, project);
  const config = { api_home: home, project };
  const [main] = steward_task_catalog(config);
  assert.ok(main.path.endsWith(join('steward', 'skills', 'local-stt-setup', 'SKILL.md')));
  assert.notEqual(main.path, steward_skill(main.id, project));
  assert.equal(readFileSync(main.path, 'utf8'), readFileSync(steward_skill(main.id, project), 'utf8'));
  assert.deepEqual(steward_task_catalog(config, 'private').map(skill => skill.id), ['share-card']);
  assert.deepEqual(steward_task_catalog(config, 'group', 'fake:7').map(skill => skill.id), ['share-card']);
  const { skills, group_skills } = steward_status(home, launch_settings(home));
  for (const list of [skills, group_skills]) {
    assert.ok(list.every(skill => typeof skill.platform === 'boolean'));
    assert.equal(list.find(skill => skill.id === 'local-stt-setup').platform, true);
    assert.equal(list.find(skill => skill.id === 'share-card').platform, false);
  }
});

test('marked task credentials block platform changes through the CLI while allowing read-only status', t => {
  const home = temp(t);
  const file = join(home, 'access.json');
  const other = join(home, 'other.json');
  writeFileSync(other, '{}');
  const run = args => spawnSync(process.execPath, ['runner/codiscuss.mjs', ...args], {
    encoding: 'utf8', env: { ...process.env, DISCUSS_SERVICE_HOME: home, DISCUSS_ACCESS_FILE: file }, windowsHide: true,
  });
  for (const window of ['private', 'group']) {
    writeFileSync(file, JSON.stringify({ window }));
    for (const args of [['admin', 'status'], ['setup'], ['install'], ['update'], ['uninstall'], ['local', 'settings'], ['site', 'publish'],
      ['service', 'stop'], ['service', 'remove'], ['service', 'autostart', 'on'], ['--json', 'stop'],
      ['steward', 'settings', '--adapter', 'api'], ['launch', 'settings', '--file', file], ['launch', 'notify', 'group-enable', 'fake', '7'],
      ['launch', 'device-pairing'], ['launch', 'api-key', '--file', file], ['launch', 'site-list']]) {
      const result = run(args);
      assert.equal(result.status, 1, args.join(' '));
      assert.match(result.stderr, /更改本机平台|change the local platform/);
    }
    for (const args of [['service', 'stop', '--access-file', other], ['room', 'view', `--access-file=${other}`]]) {
      const result = run(args);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /绑定的凭据|bound.*credential|credential.*bound/i);
    }
    assert.equal(typeof JSON.parse(run(['service', 'status', '--json']).stdout).home, 'string');
    assert.ok(Array.isArray(JSON.parse(run(['service', 'list', '--json']).stdout).configs));
    assert.equal(run(['launch', 'projects']).status, 0);
    assert.equal(JSON.parse(run(['steward', 'status']).stdout).window, window);
    const card = run(['share-card', 'materials', '--help']);
    assert.equal(card.status, window === 'private' ? 0 : 1);
  }
});

test('an existing steward room records its own software instead of guessing a participant default', async t => {
  const { home, requests, options } = await steward_fixture(t);
  await steward_command(home, 'steward-settings', { adapter: 'claude' });
  const { room_id } = await steward_command(home, 'steward', { open: true }, options);
  const settings = launch_settings(home);
  delete settings.steward.adapter;
  writeFileSync(join(home, 'launch-settings.json'), JSON.stringify(settings));
  const status = await steward_command(home, 'steward');
  assert.equal(status.configured, true);
  assert.equal(status.room_id, room_id);
  assert.equal(status.settings.adapter, 'claude');
  assert.equal(launch_settings(home).steward.adapter, 'claude');
  assert.equal(requests.length, 1, 'migration keeps the existing room');
});

test('same-software changes keep the member and switching software replaces it without archiving the conversation', async t => {
  const { home, requests, rooms, options } = await steward_fixture(t);
  const input = { skill: 'share-card', context: { room_id: 'project' }, lang: 'en', submission_id: 'first-request' };
  assert.equal((await steward_command(home, 'steward')).room_id, null);
  assert.deepEqual(await steward_command(home, 'steward-request', input, options), { room_id: 'room-1', message_id: 2 });
  assert.equal(launch_settings(home).steward.room_id, 'room-1');
  assert.equal(requests[0].system_kind, 'steward');
  assert.equal(requests[0].members.length, 1);
  assert.equal(requests[1].author, '用户');
  assert.equal(requests[1].text, steward_message(input.skill, input.context, 'en'));
  assert.equal(requests[1].submission_id, input.submission_id);
  const [config_path] = read_registry(home);
  const config = () => JSON.parse(readFileSync(config_path, 'utf8'));
  assert.equal(config().cwd, join(home, 'steward'));
  assert.equal(config().steward, true);
  const { settings } = await steward_command(home, 'steward-settings', { adapter: 'codex_cli', model: 'changed-model', cwd: home,
    skills: ['share-card'], room_id: 'ignored' });
  assert.equal(settings.model, 'changed-model');
  assert.equal(config().participants.Codex.adapter, 'codex_cli', 'a settings write does not change a live task');
  await steward_command(home, 'steward-request', { ...input, submission_id: 'second-request' }, options);
  assert.equal(rooms.size, 1);
  assert.equal(config().participants.Codex.model, 'changed-model');
  assert.deepEqual(config().steward_skills, ['share-card']);
  const changed = await steward_command(home, 'steward-settings', { adapter: 'claude', model: 'test-other-model' });
  assert.equal(changed.room_id, 'room-1');
  assert.equal(rooms.get('room-1').archived, false);
  const { host, members } = rooms.get('room-1');
  assert.match(host, /^Claude-/);
  assert.deepEqual(members.map(({ adapter, status, session_mode }) => ({ adapter, status, session_mode })), [
    { adapter: 'codex_cli', status: 'removed', session_mode: 'new' }, { adapter: 'claude', status: 'active', session_mode: 'new' },
  ]);
  assert.deepEqual(Object.keys(config().participants), [host]);
  assert.deepEqual(Object.keys(config().members), [host]);
  assert.equal(config().members[host].token, members[1].token);
  assert.equal((await steward_command(home, 'steward', { open: true }, options)).room_id, 'room-1');
  assert.equal(requests.length, 3);
});

test('saving a software switch while busy keeps the old member and applies the saved choice at next delivery', async t => {
  const { home, requests, rooms, options } = await steward_fixture(t);
  const { room_id } = await steward_command(home, 'steward', { open: true }, options);
  const room = rooms.get(room_id);
  const [config_path] = read_registry(home);
  const config = () => JSON.parse(readFileSync(config_path, 'utf8'));
  const original = config().members.Codex.token;
  room.busy = true;
  const saved = await steward_command(home, 'steward-settings', { adapter: 'claude' });
  assert.equal(saved.busy, true);
  assert.equal(saved.settings.adapter, 'claude');
  assert.equal(launch_settings(home).steward.adapter, 'claude');
  const request = await steward_command(home, 'steward-request', { skill: 'share-card' }, options);
  assert.equal(request.message_id, requests.length);
  assert.equal(room.host, 'Codex');
  assert.equal(config().members.Codex.token, original);
  room.busy = false;
  assert.equal(await activate_steward_for_delivery(config()), true);
  assert.match(room.host, /^Claude-/);
  assert.equal(config().participants[room.host].adapter, 'claude');
  assert.equal(await activate_steward_for_delivery(config()), false, 'refreshing the same choice does not replace it twice');
});

test('same-app renewal waits until idle and keeps the model, configuration and room', async t => {
  const { home, rooms, requests, options } = await steward_fixture(t);
  const { room_id } = await steward_command(home, 'steward', { open: true }, options);
  const [path] = read_registry(home);
  const config = () => JSON.parse(readFileSync(path, 'utf8'));
  const old = config(), room = rooms.get(room_id);
  await steward_command(home, 'steward-duty', { action: 'add', text: 'Track reports' });
  const saved = launch_settings(home).steward;
  room.busy = true;
  assert.equal((await steward_command(home, 'steward-renew')).busy, true);
  assert.equal(room.host, 'Codex');
  assert.equal(await activate_steward_for_delivery(config(), false), false);
  room.busy = false;
  assert.equal(await activate_steward_for_delivery(config(), false), true, 'renew even with no queued request');
  assert.match(room.host, /^Codex-/);
  assert.deepEqual(config().participants[room.host], old.participants.Codex);
  assert.notEqual(config().members[room.host].token, old.members.Codex.token);
  assert.equal(room.members.at(-1).session_mode, 'new');
  assert.equal(config().room, room_id);
  assert.equal(requests.length, 1);
  assert.deepEqual(launch_settings(home).steward, saved);
  assert.equal(await activate_steward_for_delivery(config(), false), false);
  assert.equal(relayed_command('https://relay.test', 'steward-renew', {}).command, 'steward-renew');
});

test('opening a new MOSS room posts one initial overview and reopening does not post again', async t => {
  const { home, requests, options } = await steward_fixture(t);
  await steward_command(home, 'steward-settings', { skills: ['rooms-overview'] });
  for (let count = 0; count < 2; count++) {
    assert.equal((await steward_command(home, 'steward', { open: true, lang: 'en' }, options)).room_id, 'room-1');
  }
  assert.equal(requests.length, 2);
  assert.equal(requests[0].title, 'MOSS');
  assert.equal(requests[1].author, '用户');
  assert.match(requests[1].text, /^\/rooms-overview\n[\s\S]*which are running/);
  assert.equal(requests[1].submission_id, 'steward-overview-room-1');
});

test('retrying a software change after a lost response reuses the member that already replaced the old one', async t => {
  const { home, rooms, options } = await steward_fixture(t, { lost_switch_reply: true });
  await steward_command(home, 'steward', { open: true }, options);
  const patch = { adapter: 'claude' };
  await assert.rejects(steward_command(home, 'steward-settings', patch), /replacement reply lost/);
  const { host } = rooms.get('room-1');
  const result = await steward_command(home, 'steward-settings', patch);
  assert.equal(result.room_id, 'room-1');
  assert.equal(rooms.get('room-1').members.length, 2);
  const launched = JSON.parse(readFileSync(read_registry(home)[0], 'utf8'));
  assert.deepEqual(Object.keys(launched.participants), [host]);
});

test('a creation conflict archives only the indicated orphan and retries with the same submission ID', async t => {
  const { home, requests, archives, rooms, options } = await steward_fixture(t);
  rooms.set('orphan', { id: 'orphan', system_kind: 'steward', archived: false });
  rooms.set('ordinary', { id: 'ordinary', system_kind: '', archived: false });
  assert.equal((await steward_command(home, 'steward', { open: true }, options)).room_id, 'room-3');
  assert.equal(rooms.get('orphan').archived, true);
  assert.equal(rooms.get('ordinary').archived, false);
  assert.deepEqual(archives, [{ id: 'orphan', actor: '用户', token: undefined }]);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].submission_id, requests[1].submission_id);
});

test('if the new attempt fails, orphan recovery reports the conflicting room ID and does not retry again', async t => {
  const { home, requests, archives, rooms, options } = await steward_fixture(t, { replacement_blocked: true });
  rooms.set('unrecoverable', { id: 'unrecoverable', system_kind: 'steward', archived: false });
  await assert.rejects(steward_command(home, 'steward', { open: true }, options), /unrecoverable.*replacement temporarily unavailable/);
  assert.equal(requests.length, 2);
  assert.equal(archives.length, 1);
  assert.equal(rooms.get('unrecoverable').archived, true);
});

test('paired devices can neither grant an outside working directory nor save unrestricted steward access', async t => {
  const home = temp(t), outside = temp(t);
  const previous = process.env.DISCUSS_SERVICE_HOME;
  process.env.DISCUSS_SERVICE_HOME = home;
  t.after(() => { if (previous === undefined) delete process.env.DISCUSS_SERVICE_HOME; else process.env.DISCUSS_SERVICE_HOME = previous; });
  const relay = input => run_launch_command(relayed_command('https://relay.test', 'steward-settings', input));
  const directory = await relay({ cwd: outside });
  assert.equal(directory.status, 400);
  assert.match(directory.body.error, /常用项目|saved projects/i);
  const access = await relay({ project_access: 'full' });
  assert.equal(access.status, 400);
  assert.match(access.body.error, /全放开/);
  assert.equal(launch_settings(home).steward, undefined);
  assert.equal((await relay({ create_rooms: false })).body.settings.create_rooms, false);
  assert.equal(launch_settings(home).steward.create_rooms, false);
  assert.equal((await relay({ create_rooms: true })).body.settings.create_rooms, true);
  assert.equal(launch_settings(home).steward.create_rooms, true);
  const roster = { members: ['Codex', 'Claude-2'], host: 'Claude-2' };
  assert.deepEqual((await relay({ create_preferences: roster })).body.create_preferences, roster);
  assert.deepEqual(launch_settings(home).create_preferences, roster);
  assert.equal((await relay({ create_preferences: { ...roster, host: 'Claude' } })).status, 400);
  assert.equal((await relay({ create_preferences: { ...roster, cwd: outside } })).status, 400);
  assert.equal((await relay({ create_preferences: { ...roster, host_project_access: 'full' } })).status, 400);
  assert.deepEqual(launch_settings(home).create_preferences, roster);
  const empty = { members: [], host: '' };
  assert.deepEqual((await relay({ create_preferences: empty })).body.create_preferences, empty);
  assert.deepEqual(launch_settings(home).create_preferences, empty);
});

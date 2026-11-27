import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import test from 'node:test';

import { launch_settings, steward_command } from '../runner/discussion_launch.mjs';
import { free_task_files } from '../runner/free_runner.mjs';
import { relayed_command, run_launch_command } from '../runner/remote_launch.mjs';
import { read_registry } from '../runner/discussion_service.mjs';
import { require_steward_skill, steward_cli, steward_defaults, steward_message, steward_settings_patch, steward_skill } from '../runner/steward.mjs';

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

test('steward defaults are read-only until launch and settings may only change editable fields', t => {
  const home = temp(t);
  add_skill(home, '.agents/steward-skills', 'share-card');
  add_skill(home, '.agents/steward-skills', 'dispatch-analysis');
  const settings = { participants: { Claude: { adapter: 'claude', model: 'opus', effort: 'high' } } };
  const defaults = steward_defaults(home, settings, home);
  assert.deepEqual(defaults, { adapter: '', model: '', effort: '', project_access: 'auto',
    cwd: join(`${home}-workspace`, 'steward'), skills: ['dispatch-analysis', 'share-card'] });
  assert.equal(steward_defaults(home, { ...settings, steward: { adapter: 'claude' } }, home).model, 'opus');
  assert.equal(existsSync(defaults.cwd), false);
  assert.deepEqual(steward_settings_patch({ room_id: 'wrong', skills: ['share-card', 'share-card'], effort: '' }), { skills: ['share-card'], effort: '' });
  assert.throws(() => steward_settings_patch({ cwd: 'relative', skills: ['discuss-host'] }));
  assert.throws(() => steward_settings_patch({ project_access: 'own' }));
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
  assert.match(delivered.instructions, /steward_skill_catalog/);
  assert.deepEqual(delivered.steward_skill_catalog, [
    { id: 'dispatch-analysis', description: 'Test description for dispatch-analysis', path: analysis },
    { id: 'share-card', description: 'Test description for share-card', path: share },
  ]);
  assert.deepEqual(delivered.skills.map(path => path.slice(home.length + 1).split(sep).join('/')), [
    '.agents/skills/discuss-participant/SKILL.md', '.agents/skills/discuss-participant/references/room.md',
    '.agents/steward-skills/share-card/SKILL.md', '.agents/steward-skills/dispatch-analysis/SKILL.md',
  ]);
  const manual = free_task_files(config, { name: 'Codex', role: 'host' }, { id: 2, requests: [] }, {},
    { request_texts: ['帮我做一张分享卡'] });
  const direct = JSON.parse(readFileSync(manual.task_path, 'utf8'));
  assert.equal(direct.skills.length, 2, 'a direct request receives skill metadata without preload');
  assert.deepEqual(direct.steward_skill_catalog, delivered.steward_skill_catalog);
  assert.ok(manual.skill_directories.includes(dirname(share)));
});

test('request text localizes full sentences and CLI and remote actions use the same command names', async () => {
  assert.match(steward_message('share-card', { room_id: 'r' }, 'en-US'), /^\/share-card\n\nUse the specified skill[^\n]+\n\nTask context:\n[\s\S]*"room_id": "r"/);
  assert.match(steward_message('share-card', '补充', 'zh-CN'), /^\/share-card\n\n请使用指定技能[^\n]+\n\n任务上下文：\n补充$/);
  const dispatch = (...args) => args;
  assert.deepEqual(await steward_cli(['settings', '--access', 'read', '--skills', 'share-card'], dispatch),
    ['steward-settings', { project_access: 'read', skills: ['share-card'] }]);
  assert.deepEqual((await steward_cli(['ask', 'share-card', '--room', 'r'], dispatch))[1].context, { room_id: 'r' });
  assert.equal((await steward_cli(['ask', 'share-card'], dispatch))[1].confirmed, undefined);
  assert.equal((await steward_cli(['ask', 'local-tts-setup', '--confirm'], dispatch))[1].confirmed, true);
  await assert.rejects(steward_cli(['ask', 'local-tts-setup'], dispatch), /--confirm/);
  for (const action of ['steward', 'steward-settings', 'steward-request']) {
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
  await assert.rejects(steward_cli(['delete', 'old'], dispatch), /--confirm/);
  assert.deepEqual(await steward_cli(['delete', 'old', '--confirm'], dispatch), ['steward-delete', { room_id: 'old' }]);
  await assert.rejects(steward_cli(['ask', 'cloudflare-deploy'], dispatch), /--confirm/);
  assert.equal((await steward_cli(['ask', 'cloudflare-deploy', '--confirm'], dispatch))[1].confirmed, true);
});

async function steward_fixture(t, { replacement_blocked = false, selected = true } = {}) {
  const home = temp(t);
  const requests = [];
  const archives = [];
  const deletes = [];
  const rooms = new Map();
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
      if (existing) {
        response.statusCode = 409;
        result = { error: 'steward already exists', room_id: existing.id };
      } else if (replacement_blocked) {
        response.statusCode = 503;
        result = { error: 'replacement temporarily unavailable' };
      } else {
        room = { id: `room-${rooms.size + 1}`, system_kind: payload.system_kind, archived: false, members: payload.members };
        rooms.set(room.id, room);
        result = room;
      }
    } else if (!id && request.method === 'GET') {
      result = { rooms: [...rooms.values()].map(({ id, system_kind, archived }) => ({ id, system_kind, archived })) };
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
  }, ...(selected ? { steward: { adapter: 'codex_cli' } } : {}) }));
  return { home, requests, archives, deletes, rooms, options: { start_service: async () => ({ running: true }) } };
}

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

test('the first request registers one room, same-platform changes keep it and changing platforms archives it', async t => {
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
  assert.equal(changed.room_id, null);
  assert.equal(rooms.get('room-1').archived, true);
  assert.equal(config().participants.Codex.adapter, 'codex_cli', 'the archived launch keeps its original identity');
  assert.equal(rooms.size, 1, 'saving settings does not create a room');
  assert.equal((await steward_command(home, 'steward')).room_id, null);
  assert.equal((await steward_command(home, 'steward', { open: true }, options)).room_id, 'room-2');
  assert.deepEqual(rooms.get('room-2').members.map(({ name, adapter }) => ({ name, adapter })), [{ name: 'Claude', adapter: 'claude' }]);
  assert.equal(requests.length, 4, 'opening alone creates a room but does not post');
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
});

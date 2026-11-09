/** Room workflows: the library on disk, pasted drafts, and what a room's host and members receive. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { participant_tools, system_prompt } from '../runner/adapters/api.mjs';
import { run_command } from '../runner/adapters/api_commands.mjs';
import { open_project } from '../runner/adapters/api_files.mjs';
import { validate_preset } from '../runner/discussion_launch.mjs';
import { free_task_files } from '../runner/free_runner.mjs';
import { assert_workflow_enabled, delete_workflow, get_workflow, list_workflows, load_room_workflow, parse_workflow_draft, preview_workflow, rename_workflow, save_workflow, set_workflow_disabled, workflow_in_use } from '../runner/workflows.mjs';

const NOVEL = {
  id: 'novel-serial', label: '连载小说', description: '主编出骨架，执笔写正文',
  skill: '先出骨架，再请执笔写正文，最后审稿。\n\n```\n代码块里的 <!-- workflow-file: x --> 不算分隔\n```',
  agents: [
    { card: 'writer', name: 'Antigravity-writer', label: '执笔', description: '按骨架写正文', project_access: 'write', system_prompt: '克制、具体。' },
    { card: 'science', name: 'DeepSeek-science', label: '科学顾问', system_prompt: '只核对技术合理性。' },
  ],
};

function home_fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'workflow-home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

test('a workflow saves as plain files, reads back the same, and refuses unsafe or ambiguous content', t => {
  const home = home_fixture(t);
  const saved = save_workflow(home, NOVEL, validate_preset);
  // Cards come back in file-name order.
  const by_card = list => [...list].sort((a, b) => a.card.localeCompare(b.card));
  assert.deepEqual({ ...saved, directory: undefined, agents: by_card(saved.agents) }, { ...NOVEL, directory: undefined, agents: by_card(NOVEL.agents), resources: {}, commands: [] });
  const card = readFileSync(join(home, 'workflows', 'novel-serial', 'agents', 'writer.md'), 'utf8');
  // A card file reads like an agent definition: its name is the card ID, the software is its own field, empty fields are left out.
  assert.equal(card, '---\nname: writer\nplatform: Antigravity\nlabel: 执笔\ndescription: 按骨架写正文\nproject_access: write\n---\n克制、具体。\n');
  // Cards written before `platform` existed, and quoted values, still read the same.
  writeFileSync(join(home, 'workflows', 'novel-serial', 'agents', 'science.md'), '---\nname: DeepSeek-science\nlabel: "科学顾问"\n---\n只核对技术合理性。\n');
  assert.deepEqual(get_workflow(home, 'novel-serial').agents.find(agent => agent.card === 'science'), NOVEL.agents[1]);
  // Editing the file by hand is what the page then shows.
  writeFileSync(join(home, 'workflows', 'novel-serial', 'agents', 'writer.md'), card.replace('克制、具体。', '更克制。'));
  assert.equal(get_workflow(home, 'novel-serial').agents.find(agent => agent.card === 'writer').system_prompt, '更克制。');
  assert.deepEqual(list_workflows(home).map(item => [item.id, item.cards]), [['novel-serial', 2]]);
  for (const [change, pattern] of [
    [{ id: '../x' }, /工作流 ID/],
    [{ id: 'novel_serial' }, /工作流 ID/],
    [{ id: '-novel' }, /工作流 ID/],
    [{ id: 'goal' }, /内置模式/],
    [{ id: 'discuss' }, /内置模式/],
    [{ agents: [{ ...NOVEL.agents[0], card: 'a/b' }] }, /卡片 ID/],
    [{ agents: [{ ...NOVEL.agents[0], card: 'Writer', name: 'Antigravity-Writer' }] }, /卡片 ID/],
    [{ agents: [{ ...NOVEL.agents[0], card: 'a', name: 'Antigravity-a' }, { ...NOVEL.agents[1], card: 'a', name: 'DeepSeek-a' }] }, /卡片 ID 重复/],
    [{ agents: [{ ...NOVEL.agents[0], name: 'Antigravity-other' }] }, /成员名须为/],
    [{ agents: [{ ...NOVEL.agents[0], secret: 'x' }] }, /预设只能包含/],
    [{ agents: [{ ...NOVEL.agents[0], system_prompt: 'x'.repeat(4001) }] }, /提示词最多/],
    [{ skill: '' }, /不能为空/],
  ]) assert.throws(() => save_workflow(home, { ...NOVEL, ...change }, validate_preset), pattern);
  assert.deepEqual(delete_workflow(home, 'novel-serial'), { deleted: 'novel-serial' });
  assert.deepEqual(list_workflows(home), []);
});

test('workflow replacement recovers a complete version after process death and deletion never revives its backup', t => {
  const home = home_fixture(t);
  for (const boundary of [1, 2]) {
    save_workflow(home, NOVEL, validate_preset);
    const updated = { ...NOVEL, skill: '新版手册', agents: [{ ...NOVEL.agents[0], system_prompt: '新版提示词' }] };
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const rename = fs.renameSync;
      let count = 0;
      fs.renameSync = (...args) => { rename(...args); if (++count === ${boundary}) process.exit(77); };
      syncBuiltinESMExports();
      const { save_workflow } = await import(${JSON.stringify(new URL('../runner/workflows.mjs', import.meta.url).href)});
      const { validate_preset } = await import(${JSON.stringify(new URL('../runner/discussion_launch.mjs', import.meta.url).href)});
      save_workflow(${JSON.stringify(home)}, ${JSON.stringify(updated)}, validate_preset);
    `], { windowsHide: true, encoding: 'utf8' });
    assert.equal(child.status, 77, child.stderr);
    assert.equal(list_workflows(home)[0].id, NOVEL.id);
    const recovered = get_workflow(home, NOVEL.id), expected = boundary === 1 ? NOVEL : updated;
    assert.equal(recovered.skill, expected.skill);
    assert.equal(recovered.agents.length, expected.agents.length);
    assert.equal(recovered.agents.find(agent => agent.card === 'writer').system_prompt, expected.agents[0].system_prompt);
    delete_workflow(home, NOVEL.id);
    assert.deepEqual(list_workflows(home), []);
  }
});

test('a workflow folder carries its other text files like a skill folder, and a save that carries none keeps them', t => {
  const home = home_fixture(t);
  const resources = { 'templates/README.md': '# 〔书名〕', 'templates/正文/第01集_标题.md': '---\n集: 01\n---\n', 'references/示例.md': '例' };
  save_workflow(home, { ...NOVEL, resources }, validate_preset);
  const folder = join(home, 'workflows', NOVEL.id);
  assert.equal(readFileSync(join(folder, 'templates', '正文', '第01集_标题.md'), 'utf8'), resources['templates/正文/第01集_标题.md']);
  assert.deepEqual(get_workflow(home, NOVEL.id).resources, resources);
  // A file that is not text is kept on disk and named back as ignored, never read as resource text.
  writeFileSync(join(folder, 'templates', 'cover.png'), Buffer.from([0x89, 0x50, 0xff, 0xfe, 0x00]));
  // A host draft or the editor carries no resources: saving keeps the whole folder.
  save_workflow(home, { ...NOVEL, skill: '新版' }, validate_preset);
  assert.deepEqual(get_workflow(home, NOVEL.id).resources, resources);
  assert.deepEqual([...readFileSync(join(folder, 'templates', 'cover.png'))], [0x89, 0x50, 0xff, 0xfe, 0x00]);
  // A folder or zip import brings text files along.
  const opened = preview_workflow({ folder }, validate_preset, () => true);
  assert.deepEqual([opened.resources, opened.ignored], [resources, ['templates/cover.png']]);
  const files = { 'SKILL.md': '---\nname: novel-serial\n---\n做法', 'templates/状态.yaml': 'time: 0\n', 'logo.png': null };
  const sent = preview_workflow({ files }, validate_preset, () => true);
  assert.deepEqual([sent.resources, sent.ignored], [{ 'templates/状态.yaml': 'time: 0\n' }, ['logo.png']]);
  for (const path of ['../x.md', 'a/../../x.md', '.hidden', 'a\\b.md', 'C:/x.md', '', 'SKILL.md', 'agents/x.md']) {
    assert.throws(() => save_workflow(home, { ...NOVEL, resources: { [path]: 'x' } }, validate_preset), /路径不合法/);
  }
  save_workflow(home, { ...NOVEL, resources: {} }, validate_preset);
  assert.deepEqual(get_workflow(home, NOVEL.id).resources, {});
});

test('folder import refuses directory links without reading outside the workflow', t => {
  const home = home_fixture(t);
  save_workflow(home, { ...NOVEL, agents: [] }, validate_preset);
  const outside = join(home, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'writer.md'), '---\nname: Codex-writer\n---\nprivate');
  const folder = join(home, 'workflows', NOVEL.id);
  rmSync(join(folder, 'agents'), { recursive: true });
  symlinkSync(outside, join(folder, 'agents'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => preview_workflow({ folder }, validate_preset), /符号链接/);
  assert.equal(readFileSync(join(outside, 'writer.md'), 'utf8'), '---\nname: Codex-writer\n---\nprivate');
});

test('pasted drafts merge by part header and refuse missing parts, repeated files and foreign paths', () => {
  const header = (index, total) => `<!-- workflow-part: ${index}/${total} id: novel-serial -->`;
  const skill = ['以下是草稿', header(1, 2), '<!-- workflow-file: SKILL.md -->', '---', 'name: novel-serial', 'label: 连载小说', '---',
    '正文第一行', '  <!-- workflow-file: agents/fake.md -->', 'x'.repeat(31000)].join('\n');
  const card = [header(2, 2), '<!-- workflow-file: agents/writer.md -->', '---', 'name: Antigravity-writer', '---', '写正文', '', ''].join('\n');
  const workflow = parse_workflow_draft([card, skill]);
  assert.equal(workflow.id, 'novel-serial');
  // An indented separator is body text, and the merged draft may exceed one message's limit.
  assert.match(workflow.skill, /^正文第一行\n {2}<!-- workflow-file: agents\/fake\.md -->/);
  assert.ok(workflow.skill.length > 31000);
  assert.deepEqual(workflow.agents, [{ card: 'writer', name: 'Antigravity-writer', system_prompt: '写正文' }]);
  assert.throws(() => parse_workflow_draft([skill]), /还缺第 2 段/);
  assert.throws(() => parse_workflow_draft([skill, card.replace('agents/writer.md', 'SKILL.md')]), /出现了两次/);
  assert.throws(() => parse_workflow_draft([skill, card.replace('agents/writer.md', 'references/a.md')]), /只能包含/);
});

test('an import starts write cards read-only and marks platforms this computer lacks', () => {
  const draft = ['<!-- workflow-part: 1/1 id: novel-serial -->', '<!-- workflow-file: SKILL.md -->', '---', 'name: novel-serial', '---', '做法',
    '<!-- workflow-file: agents/writer.md -->', '---', 'name: Antigravity-writer', 'project_access: write', '---', '写'].join('\n');
  const preview = preview_workflow({ parts: [draft] }, validate_preset, name => !name.startsWith('Antigravity'));
  assert.deepEqual(preview.agents, [{ card: 'writer', name: 'Antigravity-writer', project_access: 'read', requested_access: 'write',
    system_prompt: '写', needs_platform: true }]);
  // A zip or folder the page opened arrives as files; the same downgrade applies, other text files come along and unreadable ones are named back.
  const files = { 'SKILL.md': '---\nname: novel-serial\n---\n做法', 'agents/writer.md': '---\nname: writer\nplatform: Codex\nproject_access: write\n---\n写', 'README.md': '说明', 'cover.png': null };
  const opened = preview_workflow({ files }, validate_preset, () => true);
  assert.deepEqual(opened.agents, [{ card: 'writer', name: 'Codex-writer', project_access: 'read', requested_access: 'write', system_prompt: '写' }]);
  assert.deepEqual([opened.resources, opened.ignored], [{ 'README.md': '说明' }, ['cover.png']]);
  assert.throws(() => preview_workflow({ files: { 'agents/writer.md': '' } }, validate_preset, () => true), /没有 SKILL\.md/);
});

/** A room bound to the saved novel workflow, its writer played by an Antigravity member. */
function room_fixture(t) {
  const home = home_fixture(t);
  save_workflow(home, NOVEL, validate_preset);
  const directory = join(home, 'runtime');
  mkdirSync(directory);
  const config = { mode: 'free', site: 'https://discussion.test', room: 'room', token: 'o'.repeat(32), directory, project: resolve('.'),
    api_home: home, members: { Claude: { token: 'c'.repeat(32) }, 'Antigravity-writer': { token: 'a'.repeat(32) } },
    participants: { Claude: { adapter: 'claude', project_access: 'write' },
      'Antigravity-writer': { adapter: 'antigravity_cli', project_access: 'write', system_prompt: '加入时的旧提示词' } },
    workflow: { id: 'novel-serial', enabled: true, members: { writer: 'Antigravity-writer', science: 'DeepSeek-science' } } };
  const room_members = [{ name: 'Claude', label: 'Claude', status: 'active' },
    { name: 'Antigravity-writer', label: '执笔', status: 'active' }];
  const task = (name, role) => free_task_files(config, { name, role }, { id: role === 'host' ? 1 : 2, read_until: 0,
    requests: [{ id: 1, message_id: 9, purpose: 'route' }] }, {}, { workflow: load_room_workflow(config), room_members });
  return { home, config, task };
}

test('the host is told of the workflow to read on demand and its present members; a member gets its card prompt as it is now', t => {
  const { home, config, task } = room_fixture(t);
  const host = task('Claude', 'host');
  const host_file = JSON.parse(readFileSync(join(config.directory, 'free-1.task.json'), 'utf8'));
  // Like a skill, SKILL.md is not read on every task: the host opens it when a request fits, and again only when it changed.
  assert.ok(!host_file.skills.some(path => path.includes('workflows')));
  assert.ok(host_file.workflow.skill_path.endsWith(join('workflows', 'novel-serial', 'SKILL.md')));
  assert.equal(host_file.workflow.description, NOVEL.description);
  assert.match(host_file.workflow.revision, /^[0-9a-f]{12}$/);
  // The science card has no member in the room, so the host is not told to call it.
  assert.deepEqual(host_file.workflow.members, [{ card: 'writer', member: '执笔', label: '执笔', description: '按骨架写正文',
    status: 'active', project_access: 'write' }]);
  const revision = host_file.workflow.revision;
  assert.deepEqual(host.skill_directories.slice(1), [join(home, 'workflows', 'novel-serial')]);
  const writer = task('Antigravity-writer', 'member');
  const writer_file = JSON.parse(readFileSync(join(config.directory, 'free-2.task.json'), 'utf8'));
  assert.equal(writer_file.workflow, undefined);
  assert.ok(!writer_file.skills.some(path => path.includes('workflows')));
  assert.match(writer.prompt, /克制、具体。/);
  assert.doesNotMatch(writer.prompt, /旧提示词/);
  assert.equal(writer.profile.project_access, 'write');
  save_workflow(home, { ...NOVEL, agents: [{ ...NOVEL.agents[0], system_prompt: '改后的提示词', project_access: 'full' }] }, validate_preset);
  const updated = task('Antigravity-writer', 'member');
  task('Claude', 'host');
  assert.equal(JSON.parse(readFileSync(join(config.directory, 'free-1.task.json'), 'utf8')).workflow.revision, revision, 'a card edit leaves the host reading as it was');
  save_workflow(home, { ...NOVEL, skill: '新的做法' }, validate_preset);
  task('Claude', 'host');
  assert.notEqual(JSON.parse(readFileSync(join(config.directory, 'free-1.task.json'), 'utf8')).workflow.revision, revision);
  save_workflow(home, { ...NOVEL, agents: [{ ...NOVEL.agents[0], system_prompt: '改后的提示词', project_access: 'full' }] }, validate_preset);
  assert.match(updated.prompt, /改后的提示词/);
  assert.equal(updated.profile.project_access, 'write', 'editing a card never widens the room member permission');
  // Changing the host role moves the playbook to the new host, without binding it to the original name.
  assert.ok(task('Antigravity-writer', 'host').workflow);
  assert.equal(task('Claude', 'member').workflow, undefined);
  // A deleted workflow leaves everyone on the room's own settings without failing the delivery.
  delete_workflow(home, 'novel-serial');
  assert.match(task('Antigravity-writer', 'member').prompt, /加入时的旧提示词/);
  assert.equal(task('Claude', 'host').skill_directories.length, 1);
});

test('a workflow lasts while a member it brought is here, so sending them away or removing them ends it', () => {
  const workflow = { members: { lead: 'Claude', writer: 'Antigravity-writer' } };
  const room = status => [{ name: 'Claude', role: 'host', status: 'active' }, { name: 'Antigravity-writer', role: 'member', status }];
  assert.equal(workflow_in_use(workflow, room('active')), true);
  assert.equal(workflow_in_use(workflow, room('away')), false);
  assert.equal(workflow_in_use(workflow, room('removed')), false);
  assert.equal(workflow_in_use({ members: { lead: 'Claude' } }, room('away')), true, 'a host-only workflow lasts while bound');
});

test('an API host reads the workflow for fitting requests beside the built-in development flow', () => {
  const workflow = { id: 'novel-serial', label: '连载小说', description: '按集连载小说', skill: '先出骨架。',
    members: [{ card: 'writer', member: '执笔', label: '执笔', description: '写正文', status: 'active', project_access: 'write' }] };
  const host = system_prompt({ participant: 'DeepSeek', role: 'host', mode: 'free', workflow });
  assert.match(host, /本房间启用了工作流「连载小说」（用途：按集连载小说）/);
  assert.match(host, /- 执笔（卡片 writer，执笔；在场；项目权限 可写）：写正文/);
  assert.match(host, /先出骨架。/);
  assert.match(host, /# 开发协作（自由协作房间的主持人）/, 'requests the workflow does not fit still follow the development flow');
  assert.match(system_prompt({ participant: 'DeepSeek', role: 'host', mode: 'free' }), /# 开发协作（自由协作房间的主持人）/);
  assert.doesNotMatch(system_prompt({ participant: 'DeepSeek', role: 'member', mode: 'free', workflow }), /先出骨架/);
  workflow.members[0].project_access = 'own';
  assert.match(system_prompt({ participant: 'DeepSeek', role: 'host', mode: 'free', workflow }), /项目权限 沿用原会话权限/);
});

test('registered commands travel with the workflow, and an API member runs only them, within its access and project', async t => {
  const home = home_fixture(t);
  const node = process.execPath;
  const registered = { commands: [
    { id: 'check', description: '检查作品', run: [node, '{workflow}/tools/check.mjs', '{path}'], path: '作品文件夹', access: 'read' },
    { id: 'fail', description: '退出码 3', run: [node, '-e', 'process.stderr.write("坏了");process.exit(3)'], access: 'read' },
    { id: 'slow', description: '超时', run: [node, '-e', 'setTimeout(()=>{},60000)'], access: 'read', timeout_seconds: 1 },
    { id: 'fix', description: '会改文件', run: [node, '-e', 'console.log("fixed")'], access: 'write' },
  ] };
  const resources = { 'commands.json': JSON.stringify(registered), 'tools/check.mjs': 'console.log("checked " + process.argv[2].split(/[\\\\/]/).pop())' };
  const saved = save_workflow(home, { ...NOVEL, resources }, validate_preset);
  assert.deepEqual(saved.commands.map(item => [item.id, item.access, item.timeout_seconds]), [['check', 'read', 120], ['fail', 'read', 120], ['slow', 'read', 1], ['fix', 'write', 120]]);
  // An import shows its commands for the user to allow; a host draft carries no files, so it can neither add nor drop them.
  assert.equal(preview_workflow({ folder: saved.directory }, validate_preset, () => true).commands.length, 4);
  save_workflow(home, { ...NOVEL, skill: '新版' }, validate_preset);
  assert.equal(get_workflow(home, NOVEL.id).commands.length, 4);
  for (const [commands, message] of [
    [[{ id: 'x', description: 'd', run: ['a', '{path}'], access: 'read' }], /须用 path 说明/],
    [[{ id: 'x', description: 'd', run: ['a'], access: 'all' }], /access 须为/],
    [[{ id: 'x', description: 'd', run: 'a b', access: 'read' }], /run 须为/],
    [[{ id: 'x', description: 'd', run: ['a'], access: 'read', shell: true }], /不支持的字段/]]) {
    assert.throws(() => save_workflow(home, { ...NOVEL, resources: { 'commands.json': JSON.stringify({ commands }) } }, validate_preset), message);
  }

  const project = mkdtempSync(join(tmpdir(), 'workflow-project-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  mkdirSync(join(project, '首部'));
  writeFileSync(join(project, '.env'), 'TOKEN=secret');
  const commands = { directory: saved.directory, list: saved.commands };
  const reader = open_project({ cwd: project, project_access: 'read' });
  const tool = participant_tools({ role: 'member', project: reader, commands }).find(item => item.name === 'run_command');
  // A read-only member is offered only the read-only commands; with no workflow commands there is no such tool.
  assert.deepEqual(tool.parameters.properties.command.enum, ['check', 'fail', 'slow']);
  assert.ok(!participant_tools({ role: 'member', project: reader }).some(item => item.name === 'run_command'));
  assert.match(system_prompt({ participant: 'DeepSeek', role: 'member', project: reader, commands }), /可用 run_command 运行工作流登记的只读命令/);
  assert.equal(await run_command(reader, commands, { command: 'check', path: '首部' }), 'checked 首部\n');
  assert.equal(await run_command(reader, commands, { command: 'fail' }), '[stderr]\n坏了\n[exit code: 3]');
  assert.match(await run_command(reader, commands, { command: 'slow' }), /\[timed out after 1000ms\]/);
  for (const [args, message] of [[{ command: 'fix' }, /not a command registered for you/], [{ command: 'rm -rf .' }, /not a command registered/],
    [{ command: 'check' }, /needs path/], [{ command: 'check', path: '..' }, /outside the project/], [{ command: 'check', path: '.env' }, /secret file/],
    [{ command: 'fail', path: '首部' }, /takes no path/]]) {
    assert.match((await run_command(reader, commands, args)).error, message, JSON.stringify(args));
  }
  const writer = open_project({ cwd: project, project_access: 'write' });
  assert.equal(await run_command(writer, commands, { command: 'fix' }), 'fixed\n');
});

/** A canvas from a list of arrows between named nodes; `host…` names are checkpoints, the rest cards of that ID. */
function canvas(arrows, extra = []) {
  const names = [...new Set([...arrows.flat(), ...extra])].filter(name => name !== 'start');
  return { nodes: [{ id: 'start', type: 'start', x: 0, y: 0 }, ...names.map((name, index) => name.startsWith('host')
    ? { id: name, type: 'host', x: 0, y: 0 } : { id: name, type: 'card', card: name, x: index * 10, y: index })],
  edges: arrows.map(([source, target]) => ({ source, target })) };
}

test('a workflow keeps its canvas in flow.json as an illustration: any arrows are kept and the host never gets it', t => {
  const { home, config, task } = room_fixture(t);
  // Arrows the old relay compiler refused (a branch, a card no arrow reaches) are fine in a picture.
  const flow = canvas([['start', 'writer'], ['writer', 'science'], ['writer', 'host1'], ['science', 'writer']]);
  assert.throws(() => save_workflow(home, { ...NOVEL, flow: canvas([['start', 'writer'], ['writer', 'ghost']]) }, validate_preset), /不存在的卡片：ghost/);
  assert.throws(() => save_workflow(home, { ...NOVEL, flow: { nodes: 'x', edges: [] } }, validate_preset), /flow 须为/);
  save_workflow(home, { ...NOVEL, flow }, validate_preset);
  assert.deepEqual(JSON.parse(readFileSync(join(home, 'workflows', 'novel-serial', 'flow.json'), 'utf8')), flow);
  assert.deepEqual(get_workflow(home, 'novel-serial').flow, flow);
  assert.equal(get_workflow(home, 'novel-serial').resources['flow.json'], undefined, 'the canvas is its own field, not a resource');
  // A save without a flow (a host draft) keeps the canvas; null removes it.
  save_workflow(home, { ...NOVEL, skill: '改了说明' }, validate_preset);
  assert.deepEqual(get_workflow(home, 'novel-serial').flow, flow);
  task('Claude', 'host');
  // The host works from SKILL.md alone.
  assert.equal(JSON.parse(readFileSync(join(config.directory, 'free-1.task.json'), 'utf8')).workflow.flow, undefined);
  save_workflow(home, { ...NOVEL, flow: null }, validate_preset);
  assert.equal(get_workflow(home, 'novel-serial').flow, undefined);
});

test('a disabled workflow stays in the library but no room may enable or keep using it; renaming changes only its name', t => {
  const home = home_fixture(t);
  save_workflow(home, NOVEL, validate_preset);
  const config = { api_home: home, workflow: { id: 'novel-serial', enabled: true, members: { writer: 'Antigravity-writer' } } };
  assert.deepEqual(set_workflow_disabled(home, 'novel-serial', true), { id: 'novel-serial', disabled: true });
  assert.equal(list_workflows(home)[0].disabled, true);
  assert.throws(() => assert_workflow_enabled(home, 'novel-serial'), /已停用/);
  // A room that had it enabled falls back to its own settings, as with an unreadable workflow.
  assert.match(load_room_workflow(config).error, /已停用/);
  set_workflow_disabled(home, 'novel-serial', false);
  assert.equal(list_workflows(home)[0].disabled, undefined);
  assert.equal(load_room_workflow(config).label, '连载小说');
  assert.deepEqual(rename_workflow(home, 'novel-serial', ' 长篇连载 '), { id: 'novel-serial', label: '长篇连载' });
  const renamed = get_workflow(home, 'novel-serial');
  assert.deepEqual([renamed.label, renamed.skill, renamed.agents.length], ['长篇连载', NOVEL.skill, 2]);
  assert.throws(() => rename_workflow(home, 'novel-serial', ' '), /不能为空/);
  // Deleting forgets the switch, so a later workflow of the same ID starts enabled.
  set_workflow_disabled(home, 'novel-serial', true);
  delete_workflow(home, 'novel-serial');
  save_workflow(home, NOVEL, validate_preset);
  assert.equal(list_workflows(home)[0].disabled, undefined);
});

test('a host draft may carry the canvas and never clears the folder\'s other files', t => {
  const home = home_fixture(t);
  save_workflow(home, { ...NOVEL, resources: { 'templates/outline.md': '提纲模板', 'commands.json': '{ "commands": [] }' },
    flow: canvas([['start', 'writer']]) }, validate_preset);
  const draft = flow => [`<!-- workflow-part: 1/1 id: novel-serial -->
<!-- workflow-file: SKILL.md -->
---
name: novel-serial
label: 连载小说
---
改过的说明
<!-- workflow-file: agents/writer.md -->
---
name: writer
platform: Antigravity
---
克制。${flow ? `
<!-- workflow-file: flow.json -->
${JSON.stringify(flow)}` : ''}`];
  // Without a canvas: the saved one and the templates stay.
  save_workflow(home, parse_workflow_draft(draft()), validate_preset);
  let saved = get_workflow(home, 'novel-serial');
  assert.deepEqual([saved.skill, saved.resources['templates/outline.md'], saved.flow.edges.length], ['改过的说明', '提纲模板', 1]);
  // With a canvas written without positions: it replaces the saved one; the templates still stay.
  const flow = { nodes: [{ id: 'start', type: 'start' }, { id: 'w', type: 'card', card: 'writer' }, { id: 'h', type: 'host' }],
    edges: [{ source: 'start', target: 'w' }, { source: 'w', target: 'h' }, { source: 'h', target: 'w' }] };
  save_workflow(home, parse_workflow_draft(draft(flow)), validate_preset);
  saved = get_workflow(home, 'novel-serial');
  assert.deepEqual([saved.flow.edges.length, saved.flow.nodes[1], saved.resources['templates/outline.md']], [3, { id: 'w', type: 'card', card: 'writer', x: 0, y: 0 }, '提纲模板']);
  assert.throws(() => parse_workflow_draft([draft().join('').replace('agents/writer.md', 'notes.md')]), /只能包含 SKILL.md、flow.json/);
});

test('the canvas keeps short notes on host nodes and arrows, and refuses long or multi-line ones', t => {
  const home = home_fixture(t);
  const flow = { nodes: [{ id: 'start', type: 'start', x: 0, y: 0 }, { id: 'w', type: 'card', card: 'writer', x: 1, y: 0 }, { id: 'h', type: 'host', label: ' 验收 ', x: 2, y: 0 }],
    edges: [{ source: 'start', target: 'w' }, { source: 'w', target: 'h', label: '' }, { source: 'h', target: 'w', label: '返工' }] };
  save_workflow(home, { ...NOVEL, flow }, validate_preset);
  const saved = get_workflow(home, 'novel-serial').flow;
  assert.deepEqual([saved.nodes[2].label, saved.edges.map(edge => edge.label)], ['验收', [undefined, undefined, '返工']]);
  assert.throws(() => save_workflow(home, { ...NOVEL, flow: { ...flow, edges: [{ source: 'start', target: 'w', label: 'x'.repeat(17) }] } }, validate_preset), /最多 16 字/);
  assert.throws(() => save_workflow(home, { ...NOVEL, flow: { ...flow, edges: [{ source: 'start', target: 'w', label: '两\n行' }] } }, validate_preset), /不换行/);
});

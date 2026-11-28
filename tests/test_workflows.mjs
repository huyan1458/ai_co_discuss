/** Room workflows: the library on disk, pasted drafts, and what a room's host and members receive. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { slash_insertion } from '../runner/slash_names.mjs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { participant_tools, system_prompt } from '../runner/adapters/api.mjs';
import { run_command } from '../runner/adapters/api_commands.mjs';
import { open_project } from '../runner/adapters/api_files.mjs';
import { cached_software_models, check_or_save_workflow, expert_presets, presets_command, export_expert, import_expert, import_expert_to_workflow, launch_discussion, read_expert_source, validate_preset, workflows_command } from '../runner/discussion_launch.mjs';
import { free_task_files, member_folders, named_workflows } from '../runner/free_runner.mjs';
import { relayed_command, run_launch_command } from '../runner/remote_launch.mjs';

/** A task file, which sits in its member's own runtime folder. */
function runtime_file(directory, name) {
  return member_folders(directory).map(folder => join(folder, name)).find(path => existsSync(path)) || join(directory, name);
}
import { assert_workflow_enabled, delete_workflow, effective_profile, get_workflow, list_workflows, load_room_workflow, parse_workflow_draft, preview_workflow, rename_workflow, save_workflow, set_workflow_disabled, member_knowledge, workflow_in_use, workflow_task_field } from '../runner/workflows.mjs';
// Saves that replace a saved workflow on purpose; a save naming the version it edited is tested on its own.
const REPLACE = { overwrite: true };

const NOVEL = {
  id: 'novel-serial', label: '连载小说', description: '主编出骨架，执笔写正文',
  skill: '先出骨架，再请执笔写正文，最后审稿。\n\n```\n代码块里的 <!-- workflow-file: x --> 不算分隔\n```',
  agents: [
    { card: 'writer', name: 'Antigravity-writer', label: '执笔', description: '按骨架写正文', project_access: 'write', system_prompt: '克制、具体。' },
    { card: 'science', name: 'DeepSeek-science', label: '科学顾问', system_prompt: '只核对技术合理性。' },
  ],
};

/** Every file under a folder with its content, to compare a folder before and after a refused save. */
function list_files(directory, prefix = '') {
  return Object.fromEntries(readdirSync(join(directory, prefix), { withFileTypes: true }).flatMap(entry => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? Object.entries(list_files(directory, path)) : [[path, readFileSync(join(directory, path), 'utf8')]];
  }));
}

function home_fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'workflow-home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

test('a workflow saves as plain files, reads back the same, and refuses unsafe or ambiguous content', t => {
  const home = home_fixture(t);
  const saved = save_workflow(home, NOVEL, validate_preset, REPLACE);
  // Cards come back in file-name order.
  const by_card = list => [...list].sort((a, b) => a.card.localeCompare(b.card));
  assert.deepEqual({ ...saved, directory: undefined, revision: undefined, agents: by_card(saved.agents) }, { ...NOVEL, directory: undefined, revision: undefined, agents: by_card(NOVEL.agents), resources: {}, sub_workflows: [], commands: [] });
  const card = readFileSync(join(home, 'workflows', 'novel-serial', 'experts', 'writer.md'), 'utf8');
  // A card file reads like an agent definition: its name is the card ID, the software is its own field, empty fields are left out.
  assert.equal(card, '---\nname: writer\nplatform: Antigravity\nlabel: 执笔\ndescription: 按骨架写正文\nproject_access: write\n---\n克制、具体。\n');
  // Cards written before `platform` existed, and quoted values, still read the same.
  writeFileSync(join(home, 'workflows', 'novel-serial', 'experts', 'science.md'), '---\nname: DeepSeek-science\nlabel: "科学顾问"\n---\n只核对技术合理性。\n');
  assert.deepEqual(get_workflow(home, 'novel-serial').agents.find(agent => agent.card === 'science'), NOVEL.agents[1]);
  // Editing the file by hand is what the page then shows.
  writeFileSync(join(home, 'workflows', 'novel-serial', 'experts', 'writer.md'), card.replace('克制、具体。', '更克制。'));
  assert.equal(get_workflow(home, 'novel-serial').agents.find(agent => agent.card === 'writer').system_prompt, '更克制。');
  assert.deepEqual(list_workflows(home).map(item => [item.id, item.cards]), [['novel-serial', 2]]);
  // The list names the cards whose software this computer has not set up.
  assert.deepEqual(list_workflows(home, name => name.startsWith('Antigravity-'))[0].unavailable, [{ card: 'science', label: '科学顾问', platform: 'DeepSeek' }]);
  assert.equal(list_workflows(home, () => true)[0].unavailable, undefined);
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
  ]) assert.throws(() => save_workflow(home, { ...NOVEL, ...change }, validate_preset, REPLACE), pattern);
  assert.deepEqual(delete_workflow(home, 'novel-serial'), { deleted: 'novel-serial' });
  assert.deepEqual(list_workflows(home), []);
});

test('workflow replacement recovers a complete version after process death and deletion never revives its backup', t => {
  const home = home_fixture(t);
  for (const boundary of [1, 2]) {
    save_workflow(home, NOVEL, validate_preset, REPLACE);
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
      save_workflow(${JSON.stringify(home)}, ${JSON.stringify(updated)}, validate_preset, { overwrite: true });
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
  save_workflow(home, { ...NOVEL, resources }, validate_preset, REPLACE);
  const folder = join(home, 'workflows', NOVEL.id);
  assert.equal(readFileSync(join(folder, 'templates', '正文', '第01集_标题.md'), 'utf8'), resources['templates/正文/第01集_标题.md']);
  assert.deepEqual(get_workflow(home, NOVEL.id).resources, resources);
  // A file that is not text is kept on disk and named back as ignored, never read as resource text.
  writeFileSync(join(folder, 'templates', 'cover.png'), Buffer.from([0x89, 0x50, 0xff, 0xfe, 0x00]));
  // A host draft or the editor carries no resources: saving keeps the whole folder.
  save_workflow(home, { ...NOVEL, skill: '新版' }, validate_preset, REPLACE);
  assert.deepEqual(get_workflow(home, NOVEL.id).resources, resources);
  assert.deepEqual([...readFileSync(join(folder, 'templates', 'cover.png'))], [0x89, 0x50, 0xff, 0xfe, 0x00]);
  // A folder or zip import brings text files along.
  const opened = preview_workflow({ folder }, validate_preset, () => true);
  assert.deepEqual([opened.resources, opened.ignored], [resources, ['templates/cover.png']]);
  const files = { 'SKILL.md': '---\nname: novel-serial\n---\n做法', 'templates/状态.yaml': 'time: 0\n', 'logo.png': null };
  const sent = preview_workflow({ files }, validate_preset, () => true);
  assert.deepEqual([sent.resources, sent.ignored], [{ 'templates/状态.yaml': 'time: 0\n' }, ['logo.png']]);
  for (const path of ['../x.md', 'a/../../x.md', '.hidden', 'a\\b.md', 'C:/x.md', '', 'SKILL.md', 'agents/x.md']) {
    assert.throws(() => save_workflow(home, { ...NOVEL, resources: { [path]: 'x' } }, validate_preset, REPLACE), /路径不合法/);
  }
  save_workflow(home, { ...NOVEL, resources: {} }, validate_preset, REPLACE);
  assert.deepEqual(get_workflow(home, NOVEL.id).resources, {});
});

test('the SKILL.md panel edits a part\'s other files one at a time, never over a change it has not seen, and the page can still save', t => {
  const home = home_fixture(t);
  const check = { id: 'aigc-check', label: 'AI 率检查', description: '查 AI 率', skill: '运行脚本。', agents: [] };
  save_workflow(home, { ...NOVEL, sub_workflows: [check], resources: { 'references/a.md': '甲\n', 'commands.json': JSON.stringify({ commands: [{ id: 'check', description: '检查', run: ['node', '-v'], access: 'read' }] }), 'workflows/aigc-check/scripts/check.py': 'print(1)\n' } }, validate_preset, REPLACE);
  const folder = join(home, 'workflows', NOVEL.id);
  const main = workflows_command(home, { action: 'files', id: NOVEL.id });
  // SKILL.md, cards, the canvas and sub-workflows have fields of their own; commands.json is listed but locked.
  assert.deepEqual(main.files.map(file => [file.path, Boolean(file.locked)]), [['commands.json', true], ['references/a.md', false]]);
  assert.deepEqual(workflows_command(home, { action: 'files', id: NOVEL.id, sub: 'aigc-check' }).files.map(file => file.path), ['scripts/check.py']);
  const file = main.files[1];
  const written = workflows_command(home, { action: 'file-write', id: NOVEL.id, path: file.path, text: '乙\n', digest: file.digest });
  assert.equal(readFileSync(join(folder, 'references', 'a.md'), 'utf8'), '乙\n');
  assert.equal(written.revision_before, main.revision);
  // The page moves to the new revision and its save goes through, keeping the file.
  workflows_command(home, { action: 'save', base_revision: written.revision, workflow: { ...NOVEL, skill: '新版' } });
  assert.equal(readFileSync(join(folder, 'references', 'a.md'), 'utf8'), '乙\n');
  // Changed on disk since it was read: refused, the newer text stays.
  writeFileSync(join(folder, 'references', 'a.md'), '别处改的\n');
  for (const action of ['file-write', 'file-delete']) {
    assert.throws(() => workflows_command(home, { action, id: NOVEL.id, path: file.path, text: '旧\n', digest: written.digest }), error => error.code === 'file_changed');
  }
  assert.equal(readFileSync(join(folder, 'references', 'a.md'), 'utf8'), '别处改的\n');
  // New files only where none is; nothing the workflow reads as fields, nothing outside the part.
  workflows_command(home, { action: 'file-write', id: NOVEL.id, sub: 'aigc-check', path: 'notes/b.md', text: '丙', digest: '' });
  assert.equal(readFileSync(join(folder, 'workflows', 'aigc-check', 'notes', 'b.md'), 'utf8'), '丙');
  for (const path of ['SKILL.md', 'flow.json', 'commands.json', 'experts/x.md', 'agents/x.md', 'workflows/aigc-check/SKILL.md', '../x.md', 'a/../../x.md', '.hidden', '']) {
    assert.throws(() => workflows_command(home, { action: 'file-write', id: NOVEL.id, path, text: 'x', digest: '' }), /不能在这里修改/, path);
  }
  assert.throws(() => workflows_command(home, { action: 'files', id: NOVEL.id, sub: 'missing' }), /子工作流不存在/);
});

test('folder import refuses directory links without reading outside the workflow', t => {
  const home = home_fixture(t);
  save_workflow(home, { ...NOVEL, agents: [] }, validate_preset, REPLACE);
  const outside = join(home, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'writer.md'), '---\nname: Codex-writer\n---\nprivate');
  const folder = join(home, 'workflows', NOVEL.id);
  rmSync(join(folder, 'experts'), { recursive: true });
  symlinkSync(outside, join(folder, 'experts'), process.platform === 'win32' ? 'junction' : 'dir');
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
  save_workflow(home, NOVEL, validate_preset, REPLACE);
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
  const host_file = JSON.parse(readFileSync(runtime_file(config.directory, 'free-1.task.json'), 'utf8'));
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
  const writer_file = JSON.parse(readFileSync(runtime_file(config.directory, 'free-2.task.json'), 'utf8'));
  assert.equal(writer_file.workflow, undefined);
  assert.ok(!writer_file.skills.some(path => path.includes('workflows')));
  // A member may read the workflow folder too, though its task does not name it.
  assert.deepEqual(writer.skill_directories.slice(1), [join(home, 'workflows', 'novel-serial')]);
  assert.match(writer.prompt, /克制、具体。/);
  assert.doesNotMatch(writer.prompt, /旧提示词/);
  assert.equal(writer.profile.project_access, 'write');
  save_workflow(home, { ...NOVEL, agents: [{ ...NOVEL.agents[0], system_prompt: '改后的提示词', project_access: 'full' }] }, validate_preset, REPLACE);
  const updated = task('Antigravity-writer', 'member');
  task('Claude', 'host');
  assert.equal(JSON.parse(readFileSync(runtime_file(config.directory, 'free-1.task.json'), 'utf8')).workflow.revision, revision, 'a card edit leaves the host reading as it was');
  save_workflow(home, { ...NOVEL, skill: '新的做法' }, validate_preset, REPLACE);
  task('Claude', 'host');
  assert.notEqual(JSON.parse(readFileSync(runtime_file(config.directory, 'free-1.task.json'), 'utf8')).workflow.revision, revision);
  save_workflow(home, { ...NOVEL, agents: [{ ...NOVEL.agents[0], system_prompt: '改后的提示词', project_access: 'full' }] }, validate_preset, REPLACE);
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
  assert.match(host, /# 开发协作/, 'requests the workflow does not fit still follow the development flow');
  assert.match(system_prompt({ participant: 'DeepSeek', role: 'host', mode: 'free' }), /# 开发协作/);
  assert.doesNotMatch(system_prompt({ participant: 'DeepSeek', role: 'member', mode: 'free', workflow }), /先出骨架/);
  workflow.members[0].project_access = 'own';
  assert.match(system_prompt({ participant: 'DeepSeek', role: 'host', mode: 'free', workflow }), /项目权限 沿用原会话权限/);
});

test('sub-workflows live in workflows/<id>/ as workflows of their own: their cards join only when used and the host reads them on demand', t => {
  const home = home_fixture(t);
  const rehearsal = { id: 'rehearsal', label: '剧情试演', description: '请主角视角试演一场戏', skill: '请主角视角试演。',
    agents: [{ card: 'hero', name: 'Claude-hero', label: '主角视角', description: '代入主角', project_access: 'write', system_prompt: '你就是主角。' }],
    flow: { nodes: [{ id: 'start', type: 'start' }, { id: 'hero', type: 'card', card: 'hero' }], edges: [{ source: 'start', target: 'hero' }] } };
  const check = { id: 'aigc-check', label: 'AI 率检查', description: '查 AI 率', skill: '运行 scripts/check.py。', agents: [] };
  save_workflow(home, { ...NOVEL, sub_workflows: [rehearsal, check], resources: { 'workflows/aigc-check/scripts/check.py': 'print(1)\n' } }, validate_preset, REPLACE);
  const folder = join(home, 'workflows', 'novel-serial');
  // Each part is written the Agent Skills way: the display name under metadata, cards and canvas beside its SKILL.md.
  assert.match(readFileSync(join(folder, 'SKILL.md'), 'utf8'), /\nmetadata:\n {2}label: 连载小说\n/);
  assert.match(readFileSync(join(folder, 'workflows', 'rehearsal', 'SKILL.md'), 'utf8'), /^---\nname: rehearsal\ndescription: 请主角视角试演一场戏\nmetadata:\n {2}label: 剧情试演\n---\n/);
  assert.match(readFileSync(join(folder, 'workflows', 'rehearsal', 'experts', 'hero.md'), 'utf8'), /platform: Claude/);
  const saved = get_workflow(home, 'novel-serial');
  assert.deepEqual(saved.sub_workflows.map(sub => [sub.id, sub.label, sub.agents.map(agent => agent.card), Boolean(sub.flow)]),
    [['aigc-check', 'AI 率检查', [], false], ['rehearsal', '剧情试演', ['hero'], true]]);
  assert.deepEqual(Object.keys(saved.resources), ['workflows/aigc-check/scripts/check.py'], 'only a part\'s other files are resources');
  // A save without sub-workflows (a host draft) keeps them; a save with a list replaces them, keeping a kept part's other files.
  save_workflow(home, { ...NOVEL, skill: '改过的主线' }, validate_preset, REPLACE);
  assert.equal(get_workflow(home, 'novel-serial').sub_workflows.length, 2);
  save_workflow(home, { ...NOVEL, sub_workflows: [{ ...check, skill: '改过的检查' }] }, validate_preset, REPLACE);
  const edited = get_workflow(home, 'novel-serial');
  assert.deepEqual(edited.sub_workflows.map(sub => [sub.id, sub.skill]), [['aigc-check', '改过的检查']]);
  assert.equal(edited.resources['workflows/aigc-check/scripts/check.py'], 'print(1)\n');
  save_workflow(home, { ...NOVEL, sub_workflows: [rehearsal, check] }, validate_preset, REPLACE);
  for (const [change, pattern] of [
    [{ agents: [...NOVEL.agents, { card: 'hero', name: 'Claude-hero' }] }, /卡片 ID 重复/],
    [{ sub_workflows: [{ ...check, description: '' }] }, /描述不能为空/],
    [{ sub_workflows: [{ ...check, id: 'Bad_id' }] }, /子工作流 ID/],
    [{ sub_workflows: [check, check] }, /子工作流 ID 重复/],
    [{ sub_workflows: [{ ...rehearsal, flow: { nodes: [{ id: 'start', type: 'start' }, { id: 'g', type: 'card', card: 'ghost' }], edges: [] } }] }, /不存在的卡片/],
    [{ sub_workflows: [{ ...rehearsal, flow: { nodes: [{ id: 'start', type: 'start' }, { id: 's', type: 'sub', sub: 'aigc-check' }], edges: [] } }, check] }, /不能再放子工作流/],
    [{ sub_workflows: [check], flow: { nodes: [{ id: 'start', type: 'start' }, { id: 's', type: 'sub', sub: 'rehearsal' }], edges: [] } }, /不存在的子工作流：rehearsal/],
    [{ resources: { 'workflows/x/SKILL.md': 'x' } }, /不算附带文件/],
  ]) assert.throws(() => save_workflow(home, { ...NOVEL, ...change }, validate_preset, REPLACE), pattern);
  assert.equal(get_workflow(home, 'novel-serial').sub_workflows.length, 2, 'a refused save leaves the saved version');
  // The main canvas shows where a sub-workflow is used; a sub-workflow's canvas may show a main-flow member taking part.
  const main_flow = { nodes: [{ id: 'start', type: 'start', x: 0, y: 0 }, { id: 's', type: 'sub', sub: 'aigc-check', x: 1, y: 0 }], edges: [{ source: 'start', target: 's' }] };
  const check_flow = { nodes: [{ id: 'start', type: 'start', x: 0, y: 0 }, { id: 'w', type: 'card', card: 'writer', x: 1, y: 0 }], edges: [{ source: 'start', target: 'w' }] };
  save_workflow(home, { ...NOVEL, flow: main_flow, sub_workflows: [rehearsal, { ...check, flow: check_flow }] }, validate_preset, REPLACE);
  const drawn = get_workflow(home, 'novel-serial');
  assert.deepEqual([drawn.flow.nodes[1], drawn.sub_workflows.find(sub => sub.id === 'aigc-check').flow.nodes[1]],
    [main_flow.nodes[1], check_flow.nodes[1]]);
  // An import offers a sub-workflow's cards card by card, like the main flow's.
  const files = { 'SKILL.md': readFileSync(join(folder, 'SKILL.md'), 'utf8'),
    'workflows/rehearsal/SKILL.md': readFileSync(join(folder, 'workflows', 'rehearsal', 'SKILL.md'), 'utf8'),
    'workflows/rehearsal/agents/hero.md': readFileSync(join(folder, 'workflows', 'rehearsal', 'experts', 'hero.md'), 'utf8') };
  const imported = preview_workflow({ files }, validate_preset, () => true);
  assert.deepEqual(imported.sub_workflows[0].agents[0], { ...rehearsal.agents[0], project_access: 'read', requested_access: 'write' });
  assert.throws(() => preview_workflow({ files: { ...files, 'workflows/rehearsal/SKILL.md': undefined, 'workflows/orphan/agents/a.md': files['workflows/rehearsal/agents/hero.md'] } }, validate_preset, () => true), /没有 SKILL\.md/);
  // The host sees each sub-workflow to read on demand; its cards are not "missing" until it is used.
  const config = { api_home: home, workflow: { id: 'novel-serial', enabled: true, members: { writer: 'Antigravity-writer', hero: 'Claude-hero' } } };
  const workflow = load_room_workflow(config);
  const room_members = [{ name: 'Claude', role: 'host', status: 'active' }, { name: 'Antigravity-writer', status: 'active' }, { name: 'Claude-hero', label: '主角视角', status: 'active' }];
  const directory = join(home, 'runtime');
  mkdirSync(directory);
  const run_config = { ...config, mode: 'free', site: 'https://discussion.test', room: 'room', token: 'o'.repeat(32), directory, project: resolve('.'),
    members: { Claude: { token: 'c'.repeat(32) }, 'Claude-hero': { token: 'h'.repeat(32) } },
    participants: { Claude: { adapter: 'claude' }, 'Claude-hero': { adapter: 'claude', system_prompt: '旧的' } } };
  const task = name => free_task_files(run_config, { name, role: name === 'Claude' ? 'host' : 'member' }, { id: 1, read_until: 0,
    requests: [{ id: 1, message_id: 9, purpose: 'route' }] }, {}, { workflow, room_members });
  const host = task('Claude');
  const field = JSON.parse(readFileSync(runtime_file(directory, 'free-1.task.json'), 'utf8')).workflow;
  assert.deepEqual(field.missing.map(card => card.card), ['science']);
  assert.equal(field.members.find(member => member.card === 'hero').sub_workflow, 'rehearsal');
  const part = field.sub_workflows.find(sub => sub.id === 'rehearsal');
  assert.ok(part.skill_path.endsWith(join('workflows', 'rehearsal', 'SKILL.md')));
  assert.match(part.revision, /^[0-9a-f]{12}$/);
  assert.deepEqual(part.cards, [{ card: 'hero', label: '主角视角', description: '代入主角' }]);
  // A new Claude session takes it as its system prompt (expert_prompt_delivery); software without one gets it with its first task.
  const hero = task('Claude-hero');
  assert.match(hero.system_text || hero.prompt, /你就是主角。/, 'a sub-workflow member gets its card prompt');
});

test('a save that edits a saved workflow names the version it read, so a stale copy never replaces newer files', t => {
  const home = home_fixture(t);
  const rehearsal = { id: 'rehearsal', label: '剧情试演', description: '请主角视角试演一场戏', skill: '试演。',
    agents: [{ card: 'hero', name: 'Claude-hero', label: '主角视角', system_prompt: '你就是主角。' }] };
  // A new workflow needs no revision; reading it back gives the folder's revision.
  const created = save_workflow(home, { ...NOVEL, sub_workflows: [] }, validate_preset);
  assert.match(created.revision, /^[0-9a-f]{16}$/);
  assert.equal(get_workflow(home, NOVEL.id).revision, created.revision);
  // Someone else adds a sub-workflow; the page still holds the version without it.
  const stale = created.revision;
  const newer = save_workflow(home, { ...NOVEL, sub_workflows: [rehearsal] }, validate_preset, { base_revision: stale });
  assert.notEqual(newer.revision, stale, 'the revision follows every change, a sub-workflow included');
  const folder = join(home, 'workflows', NOVEL.id);
  const files = () => list_files(folder);
  const before = files();
  // The stale page saves its copy, which lacks that sub-workflow: refused, nothing written, the sub-workflow kept.
  assert.throws(() => save_workflow(home, { ...NOVEL, skill: '旧页面的改动', sub_workflows: [] }, validate_preset, { base_revision: stale }),
    error => error.code === 'workflow_changed' && /已被修改/.test(error.message));
  assert.deepEqual(files(), before);
  assert.ok(existsSync(join(folder, 'workflows', 'rehearsal', 'SKILL.md')));
  // A save naming no revision may not replace a saved workflow either; only an explicit overwrite does.
  assert.throws(() => save_workflow(home, { ...NOVEL, sub_workflows: [] }, validate_preset), error => error.code === 'workflow_exists');
  assert.deepEqual(files(), before);
  // With the current revision the save goes through, and the revision changes again.
  const edited = save_workflow(home, { ...NOVEL, skill: '新的主线', sub_workflows: [rehearsal] }, validate_preset, { base_revision: newer.revision });
  assert.notEqual(edited.revision, newer.revision);
  assert.equal(get_workflow(home, NOVEL.id).skill, '新的主线');
  // Any file counts, not only SKILL.md: a template edited on disk changes the revision.
  writeFileSync(join(folder, 'notes.md'), '手改的文件');
  assert.notEqual(get_workflow(home, NOVEL.id).revision, edited.revision);
  // A workflow deleted since it was read is refused too, not recreated from the stale copy.
  delete_workflow(home, NOVEL.id);
  assert.throws(() => save_workflow(home, NOVEL, validate_preset, { base_revision: edited.revision }), error => error.code === 'workflow_changed');
  assert.equal(existsSync(folder), false);
});

test('every save entry states its intent: the page names its revision or chooses to overwrite, the command line likewise', t => {
  const home = home_fixture(t);
  // The page: a new workflow saves as it is; editing a saved one names the revision it loaded.
  const resources = { 'templates/example.md': '范例' };
  const created = workflows_command(home, { action: 'save', workflow: { ...NOVEL, resources } }, true);
  assert.equal(created.resources, undefined);
  const loaded = workflows_command(home, { action: 'get', id: NOVEL.id });
  assert.equal(loaded.revision, created.revision);
  assert.equal(workflows_command(home, { action: 'get', id: NOVEL.id }, true).resources, undefined);
  const edited = workflows_command(home, { action: 'save', workflow: { ...NOVEL, skill: '页面改的' }, base_revision: loaded.revision });
  assert.deepEqual(edited.resources, resources);
  assert.throws(() => workflows_command(home, { action: 'save', workflow: { ...NOVEL, skill: '旧页面' }, base_revision: loaded.revision }),
    error => error.code === 'workflow_changed' && error.error_text?.template.includes('已被修改'));
  // An import with a taken ID is refused until the user chooses to overwrite.
  assert.throws(() => workflows_command(home, { action: 'save', workflow: { ...NOVEL, skill: '导入的' }, resources: {} }), error => error.code === 'workflow_exists');
  workflows_command(home, { action: 'save', workflow: { ...NOVEL, skill: '导入的' }, overwrite: true });
  assert.equal(get_workflow(home, NOVEL.id).skill, '导入的');
  // The command line: workflow-save into a taken ID needs --revision (checked) or --overwrite.
  const folder = join(home, 'source');
  mkdirSync(join(folder, 'experts'), { recursive: true });
  writeFileSync(join(folder, 'SKILL.md'), `---
name: ${NOVEL.id}
description: 命令行版本
---
命令行写的主线。
`);
  assert.throws(() => check_or_save_workflow(home, { dir: folder }, true), error => error.code === 'workflow_exists');
  assert.throws(() => check_or_save_workflow(home, { dir: folder, revision: edited.revision }, true), error => error.code === 'workflow_changed');
  const current = get_workflow(home, NOVEL.id).revision;
  assert.equal(check_or_save_workflow(home, { dir: folder, revision: current }, true).skill, '命令行写的主线。');
  assert.equal(check_or_save_workflow(home, { dir: folder, overwrite: true }, true).description, '命令行版本');
  // Checking never writes and needs neither.
  assert.equal(check_or_save_workflow(home, { dir: folder }, false).id, NOVEL.id);
});

test('a refused stale save reaches the page with its code, through the local website command and the relay alike', async t => {
  const home = home_fixture(t);
  const saved = save_workflow(home, NOVEL, validate_preset);
  save_workflow(home, { ...NOVEL, skill: '别处改过' }, validate_preset, { base_revision: saved.revision });
  const input = { action: 'save', workflow: { ...NOVEL, skill: '旧页面' }, base_revision: saved.revision };
  const env = { ...process.env, DISCUSS_SERVICE_HOME: home };
  // The local website runs the entrypoint as `node discussion_launch.mjs workflows --stdin` and answers with its stderr JSON.
  const local = spawnSync(process.execPath, [resolve('runner/discussion_launch.mjs'), 'workflows', '--stdin'],
    { input: JSON.stringify(input), encoding: 'utf8', env, windowsHide: true });
  assert.equal(local.status, 1);
  const body = JSON.parse(local.stderr.trim());
  assert.equal(body.code, 'workflow_changed');
  assert.match(body.error_text.template, /已被修改/);
  // The relay runs the same entrypoint with --remote and hands its parsed stderr to the page as the body.
  const previous = process.env.DISCUSS_SERVICE_HOME;
  process.env.DISCUSS_SERVICE_HOME = home;
  t.after(() => { if (previous === undefined) delete process.env.DISCUSS_SERVICE_HOME; else process.env.DISCUSS_SERVICE_HOME = previous; });
  const relayed = await run_launch_command({ command: 'workflows', input });
  assert.equal(relayed.status, 400);
  assert.equal(relayed.body.code, 'workflow_changed');
  assert.equal(get_workflow(home, NOVEL.id).skill, '别处改过', 'nothing was written');
});

// A folder card's skills (user 2026-11-22): `{path below skills/: text}`.
const COLD = { 'cold/SKILL.md': '---\nname: cold\ndescription: 寒区\n---\n入口\n', 'cold/references/fire.md': '初始\n' };
const LUKE = { card: 'luke', name: 'Claude-luke', label: '卢克', description: '寒区顾问', system_prompt: '你是顾问。', knowledge: COLD };
const ADVISOR = { id: 'advisor', label: '顾问', description: '领域顾问', skill: '请顾问。',
  agents: [{ card: 'kit', name: 'Claude-kit', knowledge: { 'sea/SKILL.md': '---\nname: sea\ndescription: 航海\n---\n入口\n', 'sea/references/a.md': '海\n' } }] };

/** A library with a folder card in the main flow (luke) and one in a sub-workflow (kit). */
function advisor_library(home) {
  return save_workflow(home, { ...NOVEL, agents: [...NOVEL.agents, LUKE], sub_workflows: [ADVISOR] }, validate_preset);
}

test('a card may be a folder with its skills, in the main flow and in a sub-workflow; one card ID is a file or a folder', t => {
  const home = home_fixture(t);
  const saved = advisor_library(home);
  const directory = saved.directory;
  assert.equal(readFileSync(join(directory, 'experts', 'luke', 'luke.md'), 'utf8').includes('你是顾问。'), true);
  assert.equal(readFileSync(join(directory, 'experts', 'luke', 'skills', 'cold', 'references', 'fire.md'), 'utf8'), '初始\n');
  assert.ok(existsSync(join(directory, 'workflows', 'advisor', 'experts', 'kit', 'skills', 'sea', 'SKILL.md')));
  assert.ok(existsSync(join(directory, 'experts', 'writer.md')), 'a card without skills stays a file');
  // Read back, a folder card is a card naming its skills; their text stays on disk, out of what the page edits.
  const read = get_workflow(home, NOVEL.id);
  const luke = read.agents.find(agent => agent.card === 'luke');
  assert.deepEqual(luke.skills, ['cold']);
  assert.equal(luke.knowledge, undefined);
  assert.equal(luke.system_prompt, '你是顾问。');
  assert.deepEqual(read.sub_workflows[0].agents[0].skills, ['sea']);
  assert.equal(read.agents.find(agent => agent.card === 'writer').skills, undefined);
  assert.deepEqual(Object.keys(read.resources), [], 'skills are not resources');
  // A card ID that is both a file and a folder is refused, in the main flow and in a sub-workflow alike.
  const files = { 'SKILL.md': '---\nname: twice\n---\n正文\n', 'agents/luke.md': '---\nname: luke\nplatform: Claude\n---\n',
    'agents/luke/luke.md': '---\nname: luke\nplatform: Claude\n---\n' };
  assert.throws(() => workflows_command(home, { action: 'preview', files }), /agents\/luke\.md 与 agents\/luke\/ 不能同时存在/);
  const sub_files = { 'SKILL.md': '---\nname: twice\n---\n正文\n', 'workflows/part/SKILL.md': '---\nname: part\ndescription: 一部分\n---\n做\n',
    'workflows/part/agents/kit/kit.md': '---\nname: kit\nplatform: Claude\n---\n', 'workflows/part/agents/kit.md': '---\nname: kit\nplatform: Claude\n---\n' };
  assert.throws(() => workflows_command(home, { action: 'preview', files: sub_files }), /workflows\/part\/agents\/kit\.md 与 workflows\/part\/agents\/kit\/ 不能同时存在/);
  // An import reads a folder card from files, its skills included; what is not a card's file is named back as ignored.
  const preview = workflows_command(home, { action: 'preview', files: { 'SKILL.md': '---\nname: imported\n---\n正文\n',
    'agents/luke/luke.md': '---\nname: luke\nplatform: Claude\n---\n顾问\n', 'agents/luke/skills/cold/SKILL.md': COLD['cold/SKILL.md'],
    'agents/luke/notes.txt': '别处', 'agents/luke/skills/cold/references/photo.png': null } });
  assert.deepEqual(preview.agents[0].knowledge, { 'cold/SKILL.md': COLD['cold/SKILL.md'] });
  assert.deepEqual(preview.ignored, ['agents/luke/notes.txt', 'agents/luke/skills/cold/references/photo.png']);
});

test('a folder card member keeps its knowledge in the workflow; a panel expert in the service home; a card file has none', t => {
  const home = home_fixture(t);
  const { directory } = advisor_library(home);
  mkdirSync(join(home, 'experts', 'jack', 'skills', 'sail'), { recursive: true });
  writeFileSync(join(home, 'experts', 'jack', 'skills', 'sail', 'SKILL.md'), '---\nname: sail\ndescription: 帆\n---\n');
  mkdirSync(join(home, 'experts', 'writer', 'skills', 'x'), { recursive: true });
  writeFileSync(join(home, 'experts', 'writer', 'skills', 'x', 'SKILL.md'), '---\nname: x\ndescription: x\n---\n');
  const workflow = load_room_workflow({ api_home: home, workflow: { id: NOVEL.id, enabled: true,
    members: { luke: 'Claude-luke', kit: 'Claude-kit', writer: 'Antigravity-writer' } } });
  assert.equal(member_knowledge(home, 'Claude-luke', workflow), join(directory, 'experts', 'luke', 'skills'));
  assert.equal(member_knowledge(home, 'Claude-kit', workflow), join(directory, 'workflows', 'advisor', 'experts', 'kit', 'skills'));
  assert.equal(member_knowledge(home, 'Antigravity-writer', workflow), '', 'a card file has no knowledge, whatever the service home holds');
  assert.equal(member_knowledge(home, 'Claude-jack', workflow), join(home, 'experts', 'jack', 'skills'), 'a panel expert by its name');
  assert.equal(member_knowledge(home, 'Claude-jack2', null), join(home, 'experts', 'jack', 'skills'));
  assert.equal(member_knowledge(home, 'Claude-luke', null), '', 'the workflow\'s luke and a panel luke share nothing');
  // The host is told which cards keep skills.
  const field = workflow_task_field(workflow, [{ name: 'Claude-luke', status: 'active' }, { name: 'Claude-kit', status: 'active' }], {});
  assert.deepEqual(field.members.find(item => item.card === 'luke').skills, ['cold']);
  assert.deepEqual(field.sub_workflows[0].cards[0].skills, ['sea']);
  assert.equal(field.members.find(item => item.card === 'kit').skills.length, 1);
  // The task hands the folder only to the member playing the card, with a line saying how to use it.
  const runtime = join(home, 'runtime');
  mkdirSync(runtime);
  const run_config = { api_home: home, mode: 'free', site: 'https://discussion.test', room: 'room', token: 'o'.repeat(32), directory: runtime, project: resolve('.'),
    workflow: { id: NOVEL.id, enabled: true, members: { luke: 'Claude-luke' } },
    members: { 'Claude-luke': { token: 'l'.repeat(32) }, Codex: { token: 'c'.repeat(32) } },
    participants: { 'Claude-luke': { adapter: 'claude', project_access: 'read' }, Codex: { adapter: 'codex_cli' } } };
  const task = name => free_task_files(run_config, { name, role: 'member' }, { id: name.length, read_until: 0, requests: [{ id: 1, message_id: 9, purpose: 'ask' }] }, {},
    { workflow, room_members: [{ name: 'Claude-luke', status: 'active' }, { name: 'Codex', status: 'active' }] });
  assert.equal(task('Claude-luke').knowledge_directory, join(directory, 'experts', 'luke', 'skills'));
  const file = JSON.parse(readFileSync(runtime_file(runtime, `free-${'Claude-luke'.length}.task.json`), 'utf8'));
  assert.match(file.instructions, /knowledge_directory[\s\S]*SKILL\.md[\s\S]*references/);
  assert.equal(task('Codex').knowledge_directory, undefined);
});

test('skills a member writes leave the revision alone and survive every ordinary save; only an import or an explicit overwrite replaces them', t => {
  const home = home_fixture(t);
  const { directory, revision } = advisor_library(home);
  const fire = join(directory, 'experts', 'luke', 'skills', 'cold', 'references', 'fire.md');
  const sea = join(directory, 'workflows', 'advisor', 'experts', 'kit', 'skills', 'sea', 'references', 'a.md');
  writeFileSync(fire, '顾问补的\n');
  writeFileSync(sea, '航海补的\n');
  mkdirSync(join(directory, 'experts', 'luke', 'skills', 'ice'));
  writeFileSync(join(directory, 'experts', 'luke', 'skills', 'ice', 'SKILL.md'), '---\nname: ice\ndescription: 冰\n---\n');
  assert.equal(get_workflow(home, NOVEL.id).revision, revision, 'writing skills does not change the revision');
  // The page saves what it read (cards naming their skills, no skill text), with the revision it read.
  const { resources: none, commands, directory: ignored_directory, revision: base, ...page } = get_workflow(home, NOVEL.id);
  const edited = workflows_command(home, { action: 'save', workflow: { ...page, skill: '页面改过' }, base_revision: base });
  assert.equal(readFileSync(fire, 'utf8'), '顾问补的\n');
  assert.equal(readFileSync(sea, 'utf8'), '航海补的\n', 'a sub-workflow\'s agents/ is rewritten, its skills come back');
  assert.ok(existsSync(join(directory, 'experts', 'luke', 'skills', 'ice', 'SKILL.md')));
  // The page's explicit overwrite carries no skill text either, so it keeps them too; so does a host draft.
  workflows_command(home, { action: 'save', workflow: { ...page, skill: '覆盖' }, overwrite: true });
  save_workflow(home, parse_workflow_draft(['<!-- workflow-part: 1/1 id: novel-serial -->\n<!-- workflow-file: SKILL.md -->\n---\nname: novel-serial\n---\n草稿\n'
    + '<!-- workflow-file: agents/luke.md -->\n---\nname: luke\nplatform: Claude\n---\n草稿里的卢克\n']), validate_preset, REPLACE);
  assert.equal(readFileSync(fire, 'utf8'), '顾问补的\n');
  assert.equal(readFileSync(join(directory, 'experts', 'luke', 'luke.md'), 'utf8').includes('草稿里的卢克'), true, 'the draft\'s card file lands in the folder');
  assert.ok(!existsSync(join(directory, 'experts', 'luke.md')));
  // A folder copy saved from the command line with the revision it read keeps the live skills over its stale ones...
  const copy = join(home, 'copy');
  cpSync(directory, copy, { recursive: true });
  writeFileSync(join(copy, 'experts', 'luke', 'skills', 'cold', 'references', 'fire.md'), '旧副本\n');
  check_or_save_workflow(home, { dir: copy, revision: get_workflow(home, NOVEL.id).revision }, true);
  assert.equal(readFileSync(fire, 'utf8'), '顾问补的\n');
  // ...while an explicit overwrite, like an import into an empty library, takes the folder's skills as they are.
  check_or_save_workflow(home, { dir: copy, overwrite: true }, true);
  assert.equal(readFileSync(fire, 'utf8'), '旧副本\n');
});

test('a workflow with folder cards saves, reads back, exports and imports whole, and its experts travel as the same folders', t => {
  const home = home_fixture(t), other = home_fixture(t);
  const { directory } = advisor_library(home);
  writeFileSync(join(directory, 'experts', 'luke', 'skills', 'cold', 'references', 'fire.md'), '积累\n');
  // The workflow folder, copied elsewhere and imported, arrives with every file.
  check_or_save_workflow(other, { dir: directory }, true);
  assert.deepEqual(list_files(join(other, 'workflows', NOVEL.id)), list_files(directory));
  // An expert exported from the workflow is its card folder as it is, the workflow's skills included.
  const out = join(home, 'out');
  const exported = export_expert(home, { workflow: NOVEL.id, card: 'luke', dir: out });
  assert.deepEqual(list_files(exported.path), list_files(join(directory, 'experts', 'luke')));
  // Imported into another workflow's sub-workflow, it becomes a folder card there; the same card ID is refused.
  save_workflow(other, { ...NOVEL, id: 'second', agents: [], sub_workflows: [{ ...ADVISOR, agents: [] }] }, validate_preset);
  const imported = import_expert_to_workflow(other, { ...read_expert_source(exported.path), workflow: 'second', sub: 'advisor' });
  assert.deepEqual(imported.skills, ['cold']);
  const target = join(other, 'workflows', 'second', 'workflows', 'advisor', 'experts', 'luke');
  assert.equal(readFileSync(join(target, 'skills', 'cold', 'references', 'fire.md'), 'utf8'), '积累\n');
  assert.equal(imported.requested_access, undefined);
  assert.throws(() => import_expert_to_workflow(other, { ...read_expert_source(exported.path), workflow: 'second' }), error => error.code === 'expert_card_exists');
  // A bare definition imports as a card file; writing access starts read-only.
  const plain = export_expert(home, { workflow: NOVEL.id, card: 'writer', dir: out });
  const bare = import_expert_to_workflow(other, { ...read_expert_source(plain.path), workflow: 'second' });
  assert.equal(bare.requested_access, 'write');
  assert.ok(existsSync(join(other, 'workflows', 'second', 'experts', 'writer.md')));
  assert.equal(get_workflow(other, 'second').agents.find(agent => agent.card === 'writer').project_access, 'read');
});

test('a panel expert exports and imports its own knowledge; saving a folder card as a preset copies its skills, never silently over others', t => {
  const home = home_fixture(t), other = home_fixture(t);
  advisor_library(home);
  // Saved as a panel preset: the definition becomes the preset, the workflow's skills are copied to the service home.
  const first = workflows_command(home, { action: 'save-preset', id: NOVEL.id, card: 'luke' });
  assert.deepEqual(first.preset, { name: 'Claude-luke', label: '卢克', description: '寒区顾问', system_prompt: '你是顾问。' });
  assert.equal(first.knowledge, 'added');
  const panel = join(home, 'experts', 'luke', 'skills', 'cold', 'references', 'fire.md');
  assert.equal(readFileSync(panel, 'utf8'), '初始\n');
  // From then on the two are separate: the panel's copy is kept unless the user chooses to replace it (backed up).
  writeFileSync(panel, '面板的\n');
  assert.throws(() => workflows_command(home, { action: 'save-preset', id: NOVEL.id, card: 'luke' }), error => error.code === 'preset_exists');
  assert.equal(workflows_command(home, { action: 'save-preset', id: NOVEL.id, card: 'luke', overwrite: true }).knowledge, 'kept');
  assert.equal(readFileSync(panel, 'utf8'), '面板的\n');
  const replaced = workflows_command(home, { action: 'save-preset', id: NOVEL.id, card: 'luke', overwrite: true, replace_knowledge: true });
  assert.equal(replaced.knowledge, 'replaced');
  assert.equal(readFileSync(join(replaced.backup, 'skills', 'cold', 'references', 'fire.md'), 'utf8'), '面板的\n');
  assert.equal(readFileSync(panel, 'utf8'), '初始\n');
  // A preset exports its own (the service home's) knowledge; the workflow card exports the workflow's.
  writeFileSync(panel, '面板积累\n');
  const out = join(home, 'out');
  const from_preset = export_expert(home, { preset: 'Claude-luke', dir: join(out, 'preset') });
  assert.equal(readFileSync(join(from_preset.path, 'skills', 'cold', 'references', 'fire.md'), 'utf8'), '面板积累\n');
  const from_card = export_expert(home, { workflow: NOVEL.id, card: 'luke', dir: join(out, 'card') });
  assert.equal(readFileSync(join(from_card.path, 'skills', 'cold', 'references', 'fire.md'), 'utf8'), '初始\n');
  // Imported to another computer's panel; the same conflicts as before.
  assert.equal(import_expert(other, read_expert_source(from_preset.path)).knowledge, 'added');
  assert.throws(() => import_expert(other, read_expert_source(from_preset.path)), error => error.code === 'expert_preset_exists');
  assert.equal(import_expert(other, { ...read_expert_source(from_preset.path), overwrite_preset: true }).knowledge, 'kept');
  // A bare card: one md; writing access starts read-only.
  const plain = export_expert(home, { workflow: NOVEL.id, card: 'writer', dir: out });
  assert.ok(plain.path.endsWith('writer.md') && plain.skills.length === 0);
  assert.throws(() => export_expert(home, { workflow: NOVEL.id, card: 'writer', dir: out }), error => error.code === 'expert_target_exists');
  const back = import_expert(other, read_expert_source(plain.path));
  assert.deepEqual(back.preset, { name: 'Antigravity-writer', label: '执笔', description: '按骨架写正文', project_access: 'read', system_prompt: '克制、具体。' });
  assert.equal(back.requested_access, 'write');
  // What an import cannot take is ignored and listed, never written elsewhere.
  const third = home_fixture(t);
  const hostile = { 'luke.md': readFileSync(join(from_preset.path, 'luke.md'), 'utf8'), 'skills/cold/SKILL.md': '---\nname: cold\ndescription: x\n---\n',
    'skills/cold/../../escape.md': '逃出', 'skills/Bad_Name/SKILL.md': 'x', 'notes.txt': '别处' };
  const result = import_expert(third, { files: hostile, ignored: ['skills/cold/references/picture.png'] });
  assert.deepEqual(result.ignored, ['notes.txt', 'skills/Bad_Name/SKILL.md', 'skills/cold/../../escape.md', 'skills/cold/references/picture.png']);
  assert.equal(existsSync(join(third, 'escape.md')) || existsSync(join(third, 'experts', 'escape.md')), false);
  assert.throws(() => import_expert(third, { files: { 'a.md': '---\nplatform: Claude\n---\n', 'b.md': '---\nplatform: Codex\n---\n' } }), error => error.code === 'expert_definition');
});

test('the page exports an expert as the command line does, zips it so the page reads it back, and imports it with the same conflicts', async t => {
  const { zip_store, zip_entries } = await import('../frontend/workflow-files.js');
  const home = home_fixture(t), other = home_fixture(t);
  advisor_library(home);
  // The page's export gives the same files the command line writes.
  const given = workflows_command(home, { action: 'export-expert', workflow: NOVEL.id, card: 'luke' });
  assert.deepEqual(given.skills, ['cold']);
  const written = export_expert(home, { workflow: NOVEL.id, card: 'luke', dir: join(home, 'out') });
  assert.deepEqual(read_expert_source(written.path).files, given.files);
  // Zipped in the page with stored entries, the page's own zip reader reads every file back as it was.
  const entries = zip_entries(zip_store(given.files, given.id));
  const read = Object.fromEntries(await Promise.all(entries.map(async entry => [entry.path, new TextDecoder().decode(await entry.read())])));
  assert.deepEqual(read, Object.fromEntries(Object.entries(given.files).map(([path, text]) => [`${given.id}/${path}`, text])));
  // Imported through the page's action: a preset of that name, then knowledge already here, each stops for the user.
  const files = Object.fromEntries(Object.entries(read).map(([path, text]) => [path.slice(given.id.length + 1), text]));
  assert.equal(workflows_command(other, { action: 'import-expert', files }).knowledge, 'added');
  assert.throws(() => workflows_command(other, { action: 'import-expert', files }), error => error.code === 'expert_preset_exists');
  assert.equal(workflows_command(other, { action: 'import-expert', files, overwrite_preset: true }).knowledge, 'kept');
  const replaced = workflows_command(other, { action: 'import-expert', files, overwrite_preset: true, replace_knowledge: true });
  assert.equal(replaced.knowledge, 'replaced');
  assert.ok(existsSync(join(replaced.backup, 'skills', 'cold', 'SKILL.md')));
  // A file the page could not read as text arrives as null and is listed as ignored.
  assert.deepEqual(workflows_command(home_fixture(t), { action: 'import-expert', files: { ...files, 'skills/cold/references/photo.png': null } }).ignored,
    ['skills/cold/references/photo.png']);
});

test('the page edits an expert\'s skills file by file, only inside its skills, and never over a change it has not seen', t => {
  const home = home_fixture(t);
  const { directory, revision } = advisor_library(home);
  const luke = { workflow: NOVEL.id, card: 'luke' };
  const listed = workflows_command(home, { action: 'skills', ...luke });
  assert.deepEqual(listed.skills.map(skill => [skill.name, skill.description, skill.files.map(file => file.path)]),
    [['cold', '寒区', ['cold/SKILL.md', 'cold/references/fire.md']]]);
  const fire = listed.skills[0].files[1];
  assert.equal(fire.text, '初始\n');
  // A write names the digest it read; the file changes on disk, the workflow's revision does not.
  const written = workflows_command(home, { action: 'skill-write', ...luke, path: fire.path, text: '页面改的\n', digest: fire.digest });
  assert.equal(readFileSync(join(directory, 'experts', 'luke', 'skills', 'cold', 'references', 'fire.md'), 'utf8'), '页面改的\n');
  // The expert writes meanwhile: a write naming the old digest is refused and the expert's text stays.
  writeFileSync(join(directory, 'experts', 'luke', 'skills', 'cold', 'references', 'fire.md'), '专家刚写的\n');
  assert.throws(() => workflows_command(home, { action: 'skill-write', ...luke, path: fire.path, text: '旧页面\n', digest: written.digest }), error => error.code === 'skill_changed');
  assert.throws(() => workflows_command(home, { action: 'skill-delete', ...luke, path: fire.path, digest: written.digest }), error => error.code === 'skill_changed');
  assert.equal(readFileSync(join(directory, 'experts', 'luke', 'skills', 'cold', 'references', 'fire.md'), 'utf8'), '专家刚写的\n');
  // A new skill or file is created only where none is (digest ''); the sub-workflow's expert is reached the same way.
  workflows_command(home, { action: 'skill-write', ...luke, path: 'ice/SKILL.md', text: '---\nname: ice\ndescription: 冰\n---\n', digest: '' });
  assert.throws(() => workflows_command(home, { action: 'skill-write', ...luke, path: 'ice/SKILL.md', text: '再建\n', digest: '' }), error => error.code === 'skill_changed');
  workflows_command(home, { action: 'skill-write', workflow: NOVEL.id, card: 'kit', path: 'sea/references/b.md', text: '海图\n', digest: '' });
  assert.ok(existsSync(join(directory, 'workflows', 'advisor', 'experts', 'kit', 'skills', 'sea', 'references', 'b.md')));
  // Nothing outside the expert's skills: not its definition, not another expert, not a path that climbs out.
  for (const path of ['../luke.md', 'cold/../../luke.md', '../../writer.md', 'cold', 'Bad_Name/SKILL.md', '/abs/x.md', 'cold//x.md', 'cold/.hidden']) {
    assert.throws(() => workflows_command(home, { action: 'skill-write', ...luke, path, text: 'x', digest: '' }), /技能路径不合法/, path);
  }
  assert.throws(() => workflows_command(home, { action: 'skills', workflow: NOVEL.id, card: 'writer' }), /没有技能/);
  assert.equal(readFileSync(join(directory, 'experts', 'luke', 'luke.md'), 'utf8').includes('你是顾问。'), true);
  assert.equal(get_workflow(home, NOVEL.id).revision, revision, 'reading and writing skills leaves the revision alone');
  // Removing a whole skill moves it into backups first.
  const removed = workflows_command(home, { action: 'skill-remove', ...luke, skill: 'cold' });
  assert.ok(!existsSync(join(directory, 'experts', 'luke', 'skills', 'cold')));
  assert.equal(readFileSync(join(home, 'backups', removed.backup, 'references', 'fire.md'), 'utf8'), '专家刚写的\n');
  // A panel preset's skills are its own, in the service home.
  workflows_command(home, { action: 'save-preset', id: NOVEL.id, card: 'kit' });
  workflows_command(home, { action: 'skill-write', preset: 'Claude-kit', path: 'sea/references/c.md', text: '面板的\n', digest: '' });
  assert.equal(readFileSync(join(home, 'experts', 'kit', 'skills', 'sea', 'references', 'c.md'), 'utf8'), '面板的\n');
  assert.ok(!existsSync(join(directory, 'workflows', 'advisor', 'experts', 'kit', 'skills', 'sea', 'references', 'c.md')));
  assert.deepEqual(workflows_command(home, { action: 'skills', preset: 'Claude-kit' }).skills.map(skill => skill.name), ['sea']);
});

test('a first skill turns a card file into a folder through a checked save, keeping its definition', t => {
  const home = home_fixture(t);
  const sub = { id: 'advisor', label: '顾问', description: '领域顾问', skill: '请顾问。', agents: [{ card: 'kit', name: 'Claude-kit', system_prompt: '航海。' }] };
  const saved = save_workflow(home, { ...NOVEL, sub_workflows: [sub] }, validate_preset);
  const { resources: none, commands, directory: ignored, revision, ...page } = get_workflow(home, NOVEL.id);
  const first = { 'notes/SKILL.md': '---\nname: notes\ndescription: 笔记\n---\n' };
  const with_skill = agent => ({ ...agent, skills: ['notes'], knowledge: first });
  workflows_command(home, { action: 'save', base_revision: revision, workflow: { ...page,
    agents: page.agents.map(agent => agent.card === 'writer' ? with_skill(agent) : agent),
    sub_workflows: page.sub_workflows.map(item => ({ ...item, agents: item.agents.map(with_skill) })) } });
  const { directory } = saved;
  assert.ok(!existsSync(join(directory, 'experts', 'writer.md')) && existsSync(join(directory, 'experts', 'writer', 'skills', 'notes', 'SKILL.md')));
  assert.ok(existsSync(join(directory, 'workflows', 'advisor', 'experts', 'kit', 'skills', 'notes', 'SKILL.md')));
  const read = get_workflow(home, NOVEL.id);
  const writer = read.agents.find(agent => agent.card === 'writer');
  assert.deepEqual({ ...writer, skills: undefined }, { ...NOVEL.agents[0], skills: undefined }, 'the definition is kept');
  assert.deepEqual(writer.skills, ['notes']);
  assert.equal(read.sub_workflows[0].agents[0].system_prompt, '航海。');
});

test('a folder card dropped by a save, skills replaced by an overwrite, or a workflow deleted is backed up first', t => {
  const home = home_fixture(t);
  const { directory } = advisor_library(home);
  writeFileSync(join(directory, 'experts', 'luke', 'skills', 'cold', 'references', 'fire.md'), '积累\n');
  const backed = name => readFileSync(join(home, 'backups', name, 'skills', 'cold', 'references', 'fire.md'), 'utf8');
  // The page drops luke from the main flow: its folder goes to backups before the save replaces the workflow.
  const { resources: none, commands, directory: ignored, revision, ...page } = get_workflow(home, NOVEL.id);
  const dropped = workflows_command(home, { action: 'save', base_revision: revision, workflow: { ...page, agents: page.agents.filter(agent => agent.card !== 'luke') } });
  assert.equal(dropped.backups.length, 1);
  assert.equal(backed(dropped.backups[0]), '积累\n');
  assert.ok(!existsSync(join(directory, 'experts', 'luke')));
  // An explicit overwrite carrying skills replaces the saved ones after backing them up.
  save_workflow(home, { ...NOVEL, agents: [...NOVEL.agents, LUKE], sub_workflows: [ADVISOR] }, validate_preset, REPLACE);
  writeFileSync(join(directory, 'experts', 'luke', 'skills', 'cold', 'references', 'fire.md'), '又积累\n');
  const replaced = save_workflow(home, { ...NOVEL, agents: [...NOVEL.agents, LUKE], sub_workflows: [ADVISOR] }, validate_preset, REPLACE);
  assert.ok(replaced.backups.some(name => name.includes('-luke-') && backed(name) === '又积累\n'));
  assert.equal(readFileSync(join(directory, 'experts', 'luke', 'skills', 'cold', 'references', 'fire.md'), 'utf8'), '初始\n');
  // An ordinary save backs up nothing.
  assert.equal(workflows_command(home, { action: 'save', base_revision: replaced.revision, workflow: { ...page, agents: get_workflow(home, NOVEL.id).agents } }).backups, undefined);
  // Deleting the workflow backs up every folder card first.
  writeFileSync(join(directory, 'experts', 'luke', 'skills', 'cold', 'references', 'fire.md'), '最后\n');
  const deleted = workflows_command(home, { action: 'delete', id: NOVEL.id });
  assert.equal(deleted.backups.length, 2);
  assert.ok(deleted.backups.some(name => name.includes('-luke-') && backed(name) === '最后\n'));
});

test('an expert whose software or model cannot run here is imported with a notice, and refused at launch until its model is changed', async t => {
  const home = home_fixture(t);
  // This computer has Codex set up, and its model list (as the page reads it) offers gpt-a only.
  const codex = { adapter: 'codex_cli', executable: process.execPath };
  writeFileSync(join(home, 'launch-settings.json'), JSON.stringify({ participants: { Codex: codex } }));
  await cached_software_models(home, codex, { query: async () => ({ adapter: 'codex_cli', models: [{ id: 'gpt-a', label: 'A' }] }),
    query_effort: async () => ({ levels: [] }), query_defaults: async () => ({ model: '', effort: '' }) });
  const definition = (platform, model) => ({ 'luke.md': `---\nname: luke\nplatform: ${platform}\n${model ? `model: ${model}\n` : ''}---\n顾问\n` });
  // Imports go ahead and say why the expert cannot run yet: its software is not set up, or that software lacks its model.
  assert.equal(import_expert(home, { files: definition('Antigravity', 'gemini-x') }).needs_platform, true);
  const missing = import_expert(home, { files: definition('Codex', 'gpt-zz') });
  assert.equal(missing.unknown_model, 'gpt-zz');
  assert.ok(expert_presets(home).presets.some(preset => preset.name === 'Codex-luke'));
  assert.equal(import_expert(home, { files: definition('Codex', 'gpt-a'), overwrite_preset: true }).unknown_model, undefined);
  save_workflow(home, { ...NOVEL, agents: [] }, validate_preset);
  assert.equal(import_expert_to_workflow(home, { files: definition('Codex', 'gpt-zz'), workflow: NOVEL.id }).unknown_model, 'gpt-zz');
  // Starting such a member is refused, naming the model; a listed model, or none (the software's default), starts.
  const launch = (model, at = home) => launch_discussion(at, { site: 'http://127.0.0.1:9', entry: 'web', cwd: home,
    participants: { 'Codex-luke': { ...codex, ...(model ? { model } : {}) } },
    room: { mode: 'free', title: '模型检查', members: [{ name: 'Codex-luke', access: 'runner' }], submission_id: randomUUID() } }, { dry_run: true });
  await assert.rejects(launch('gpt-zz'), error => error.code === 'model_unavailable' && /gpt-zz/.test(error.message));
  assert.equal((await launch('gpt-a')).participants['Codex-luke'].model, 'gpt-a');
  assert.equal((await launch('')).participants['Codex-luke'].model, undefined);
  // Without a model list for this software on this computer, nothing is refused.
  const fresh = home_fixture(t);
  writeFileSync(join(fresh, 'launch-settings.json'), JSON.stringify({ participants: { Codex: codex } }));
  assert.equal((await launch('gpt-zz', fresh)).participants['Codex-luke'].model, 'gpt-zz');
  assert.equal(import_expert(fresh, { files: definition('Codex', 'gpt-zz') }).unknown_model, undefined);
});

test('the canvas names its steps and a sub-workflow says where it attaches: soft, warned about but never refused, and told to the host', t => {
  const home = home_fixture(t);
  const nodes = [{ id: 'start', type: 'start' }, { id: 'w', type: 'card', card: 'writer' }, { id: 's', type: 'sub', sub: 'rehearsal' }];
  const rehearsal = { id: 'rehearsal', label: '剧情试演', description: '请主角视角试演一场戏', skill: '试演。', attach: ['brief'],
    agents: [{ card: 'hero', name: 'Claude-hero', label: '角色', system_prompt: '你就是这个人物。' }] };
  // An older canvas without steps still saves and reads back unchanged.
  const { attach: none, ...standalone } = rehearsal;
  save_workflow(home, { ...NOVEL, flow: { nodes, edges: [] }, sub_workflows: [standalone] }, validate_preset, REPLACE);
  assert.equal(get_workflow(home, 'novel-serial').flow.stages, undefined);
  // A standalone sub-workflow, like the main SKILL.md, writes no attach line at all.
  const folder = join(home, 'workflows', 'novel-serial');
  assert.doesNotMatch(readFileSync(join(folder, 'workflows', 'rehearsal', 'SKILL.md'), 'utf8'), /attach/);
  assert.doesNotMatch(readFileSync(join(folder, 'SKILL.md'), 'utf8'), /attach/);
  // A step naming a node the canvas lacks, or a node in two steps, is refused.
  assert.throws(() => save_workflow(home, { ...NOVEL, flow: { nodes, edges: [], stages: [{ id: 'brief', nodes: ['ghost'] }] } }, validate_preset, REPLACE), /不存在的节点：ghost/);
  assert.throws(() => save_workflow(home, { ...NOVEL, flow: { nodes, edges: [], stages: [{ id: 'a', nodes: ['w'] }, { id: 'b', nodes: ['w'] }] } }, validate_preset, REPLACE), /只能属于一个步骤/);
  // Steps and attach points round-trip; attach is written under metadata in the sub-workflow's SKILL.md.
  const stages = [{ id: 'brief', label: '出任务书', nodes: ['w', 's'] }, { id: 'accept', label: '验收', nodes: [] }];
  const saved = save_workflow(home, { ...NOVEL, flow: { nodes, edges: [], stages }, sub_workflows: [rehearsal] }, validate_preset, REPLACE);
  assert.equal(saved.warnings, undefined);
  assert.deepEqual(saved.flow.stages, stages);
  assert.match(readFileSync(join(home, 'workflows', 'novel-serial', 'workflows', 'rehearsal', 'SKILL.md'), 'utf8'), /\n {2}attach: brief\n/);
  assert.deepEqual(get_workflow(home, 'novel-serial').sub_workflows[0].attach, ['brief']);
  // An attach point the canvas lacks, or a sub-workflow node in a step it does not attach to, saves with warnings.
  const odd = save_workflow(home, { ...NOVEL, flow: { nodes, edges: [], stages }, sub_workflows: [{ ...rehearsal, attach: ['nowhere'] }] }, validate_preset, REPLACE);
  assert.equal(odd.warnings.length, 2);
  assert.match(odd.warnings.join('\n'), /没有的步骤：nowhere[\s\S]*步骤 brief/);
  assert.deepEqual(get_workflow(home, 'novel-serial').sub_workflows[0].attach, ['nowhere'], 'the save went through');
  save_workflow(home, { ...NOVEL, flow: { nodes, edges: [], stages }, sub_workflows: [rehearsal] }, validate_preset, REPLACE);
  // The host is told the steps and each sub-workflow's attach points; a card's further member plays it with its prompt.
  const workflow = load_room_workflow({ api_home: home, workflow: { id: 'novel-serial', enabled: true, members: { hero: 'Claude-hero' },
    extra_members: { 'Claude-hero-2': 'hero' } } });
  const room_members = [{ name: 'Claude', role: 'host', status: 'active' }, { name: 'Claude-hero', label: '角色·小满', status: 'active' },
    { name: 'Claude-hero-2', label: '角色·她', status: 'away' }];
  const field = workflow_task_field(workflow, room_members, {});
  assert.deepEqual(field.stages, [{ id: 'brief', label: '出任务书' }, { id: 'accept', label: '验收' }]);
  assert.deepEqual(field.sub_workflows[0].attach, ['brief']);
  assert.deepEqual(field.members.map(member => [member.card, member.member, member.status]), [['hero', '角色·小满', 'active'], ['hero', '角色·她', 'away']]);
  assert.equal(effective_profile({ adapter: 'claude' }, 'Claude-hero-2', workflow).system_prompt, '你就是这个人物。');
  assert.equal(workflow_in_use(workflow, room_members), true);
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
  const saved = save_workflow(home, { ...NOVEL, resources }, validate_preset, REPLACE);
  assert.deepEqual(saved.commands.map(item => [item.id, item.access, item.timeout_seconds]), [['check', 'read', 120], ['fail', 'read', 120], ['slow', 'read', 1], ['fix', 'write', 120]]);
  // An import shows its commands for the user to allow; a host draft carries no files, so it can neither add nor drop them.
  assert.equal(preview_workflow({ folder: saved.directory }, validate_preset, () => true).commands.length, 4);
  save_workflow(home, { ...NOVEL, skill: '新版' }, validate_preset, REPLACE);
  assert.equal(get_workflow(home, NOVEL.id).commands.length, 4);
  for (const [commands, message] of [
    [[{ id: 'x', description: 'd', run: ['a', '{path}'], access: 'read' }], /须用 path 说明/],
    [[{ id: 'x', description: 'd', run: ['a'], access: 'all' }], /access 须为/],
    [[{ id: 'x', description: 'd', run: 'a b', access: 'read' }], /run 须为/],
    [[{ id: 'x', description: 'd', run: ['a'], access: 'read', shell: true }], /不支持的字段/]]) {
    assert.throws(() => save_workflow(home, { ...NOVEL, resources: { 'commands.json': JSON.stringify({ commands }) } }, validate_preset, REPLACE), message);
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
  assert.throws(() => save_workflow(home, { ...NOVEL, flow: canvas([['start', 'writer'], ['writer', 'ghost']]) }, validate_preset, REPLACE), /不存在的卡片：ghost/);
  assert.throws(() => save_workflow(home, { ...NOVEL, flow: { nodes: 'x', edges: [] } }, validate_preset, REPLACE), /flow 须为/);
  save_workflow(home, { ...NOVEL, flow }, validate_preset, REPLACE);
  assert.deepEqual(JSON.parse(readFileSync(join(home, 'workflows', 'novel-serial', 'flow.json'), 'utf8')), flow);
  assert.deepEqual(get_workflow(home, 'novel-serial').flow, flow);
  assert.equal(get_workflow(home, 'novel-serial').resources['flow.json'], undefined, 'the canvas is its own field, not a resource');
  // A save without a flow (a host draft) keeps the canvas; null removes it.
  save_workflow(home, { ...NOVEL, skill: '改了说明' }, validate_preset, REPLACE);
  assert.deepEqual(get_workflow(home, 'novel-serial').flow, flow);
  task('Claude', 'host');
  // The host works from SKILL.md alone.
  assert.equal(JSON.parse(readFileSync(runtime_file(config.directory, 'free-1.task.json'), 'utf8')).workflow.flow, undefined);
  save_workflow(home, { ...NOVEL, flow: null }, validate_preset, REPLACE);
  assert.equal(get_workflow(home, 'novel-serial').flow, undefined);
});

test('a disabled workflow stays in the library but no room may enable or keep using it; renaming changes only its name', t => {
  const home = home_fixture(t);
  save_workflow(home, NOVEL, validate_preset, REPLACE);
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
  save_workflow(home, NOVEL, validate_preset, REPLACE);
  assert.equal(list_workflows(home)[0].disabled, undefined);
});

test('a host draft may carry the canvas and never clears the folder\'s other files', t => {
  const home = home_fixture(t);
  save_workflow(home, { ...NOVEL, resources: { 'templates/outline.md': '提纲模板', 'commands.json': '{ "commands": [] }' },
    flow: canvas([['start', 'writer']]) }, validate_preset, REPLACE);
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
  save_workflow(home, parse_workflow_draft(draft()), validate_preset, REPLACE);
  let saved = get_workflow(home, 'novel-serial');
  assert.deepEqual([saved.skill, saved.resources['templates/outline.md'], saved.flow.edges.length], ['改过的说明', '提纲模板', 1]);
  // With a canvas written without positions: it replaces the saved one; the templates still stay.
  const flow = { nodes: [{ id: 'start', type: 'start' }, { id: 'w', type: 'card', card: 'writer' }, { id: 'h', type: 'host' }],
    edges: [{ source: 'start', target: 'w' }, { source: 'w', target: 'h' }, { source: 'h', target: 'w' }] };
  save_workflow(home, parse_workflow_draft(draft(flow)), validate_preset, REPLACE);
  saved = get_workflow(home, 'novel-serial');
  assert.deepEqual([saved.flow.edges.length, saved.flow.nodes[1], saved.resources['templates/outline.md']], [3, { id: 'w', type: 'card', card: 'writer', x: 0, y: 0 }, '提纲模板']);
  assert.throws(() => parse_workflow_draft([draft().join('').replace('agents/writer.md', 'notes.md')]), /只能包含 SKILL.md、flow.json/);
});

test('the canvas keeps short notes on host nodes and arrows, and refuses long or multi-line ones', t => {
  const home = home_fixture(t);
  const flow = { nodes: [{ id: 'start', type: 'start', x: 0, y: 0 }, { id: 'w', type: 'card', card: 'writer', x: 1, y: 0 }, { id: 'h', type: 'host', label: ' 验收 ', x: 2, y: 0 }],
    edges: [{ source: 'start', target: 'w' }, { source: 'w', target: 'h', label: '' }, { source: 'h', target: 'w', label: '返工' }] };
  save_workflow(home, { ...NOVEL, flow }, validate_preset, REPLACE);
  const saved = get_workflow(home, 'novel-serial').flow;
  assert.deepEqual([saved.nodes[2].label, saved.edges.map(edge => edge.label)], ['验收', [undefined, undefined, '返工']]);
  assert.throws(() => save_workflow(home, { ...NOVEL, flow: { ...flow, edges: [{ source: 'start', target: 'w', label: 'x'.repeat(17) }] } }, validate_preset, REPLACE), /最多 16 字/);
  assert.throws(() => save_workflow(home, { ...NOVEL, flow: { ...flow, edges: [{ source: 'start', target: 'w', label: '两\n行' }] } }, validate_preset, REPLACE), /不换行/);
});

test('the canvas supports user nodes and conditional branch nodes with N branches, validating branch references and loops', async t => {
  const { flow_shape, edge_key } = await import('../runner/workflow_flow.mjs');
  const home = home_fixture(t);
  const flow = {
    nodes: [
      { id: 'start', type: 'start', x: 0, y: 0 },
      { id: 'u1', type: 'user', label: ' 确认大纲 ', x: 1, y: 0 },
      { id: 'b1', type: 'branch', label: ' 判断路线 ', branches: [
        { id: 'normal', label: ' 日常集 ' },
        { id: 'key', label: '关键集' },
        { id: 'rework', label: '返工' },
      ], x: 2, y: 0 },
      { id: 'w', type: 'card', card: 'writer', x: 3, y: 0 },
      { id: 's', type: 'card', card: 'science', x: 3, y: 1 },
    ],
    edges: [
      { source: 'start', target: 'u1' },
      { source: 'u1', target: 'b1' },
      { source: 'b1', branch: 'normal', target: 'w' },
      // Two distinct branches may target the same node, and one branch may fan out to multiple nodes.
      { source: 'b1', branch: 'key', target: 'w', label: '主执笔' },
      { source: 'b1', branch: 'key', target: 's', label: '并行核对' },
      { source: 'b1', branch: 'rework', target: 'u1', label: '退回用户' },
    ],
  };
  save_workflow(home, { ...NOVEL, flow }, validate_preset, REPLACE);
  const saved = get_workflow(home, 'novel-serial').flow;
  assert.equal(saved.nodes[1].label, '确认大纲');
  assert.equal(saved.nodes[2].label, '判断路线');
  assert.deepEqual(saved.nodes[2].branches, [{ id: 'normal', label: '日常集' }, { id: 'key', label: '关键集' }, { id: 'rework', label: '返工' }]);
  assert.equal(saved.edges.length, 6);
  const shape = flow_shape(saved);
  assert.equal(shape.loops.has(edge_key({ source: 'b1', branch: 'rework', target: 'u1' })), true);
  assert.equal(shape.layers.get('u1'), 1);
  assert.equal(shape.layers.get('b1'), 2);
  assert.equal(shape.layers.get('w'), 3);
  assert.equal(shape.layers.get('s'), 3);
  // Validation rejects missing branches, unknown branch IDs, branch on non-branch sources, and duplicate branch-to-target edges.
  for (const [bad, pattern] of [
    [{ ...flow, nodes: flow.nodes.map(n => n.id === 'b1' ? { ...n, branches: [] } : n) }, /须包含 1—20 个分支/],
    [{ ...flow, nodes: flow.nodes.map(n => n.id === 'b1' ? { ...n, branches: [{ id: 'a' }, { id: 'a' }] } : n) }, /不重复的 id/],
    [{ ...flow, nodes: flow.nodes.map(n => n.id === 'b1' ? { ...n, branches: [{ id: null }] } : n) }, /不重复的 id/],
    [{ ...flow, nodes: flow.nodes.map(n => n.id === 'b1' ? { ...n, branches: [{ id: 123 }] } : n) }, /不重复的 id/],
    [{ ...flow, nodes: [...flow.nodes, { id: 123, type: 'user' }] }, /不重复的 id/],
    [{ ...flow, edges: [{ source: 'start', target: 'u1' }, { source: 'b1', target: 'w' }] }, /须指明 branch/],
    [{ ...flow, edges: [{ source: 'start', target: 'u1' }, { source: 'b1', branch: 'nope', target: 'w' }] }, /不存在的分支：b1\.nope/],
    [{ ...flow, edges: [{ source: 'u1', branch: 'normal', target: 'w' }] }, /只能用于条件分支节点/],
    [{ ...flow, edges: [{ source: 'b1', branch: 'normal', target: 'w' }, { source: 'b1', branch: 'normal', target: 'w' }] }, /同一分支到同一节点只能有一条连线/],
  ]) assert.throws(() => save_workflow(home, { ...NOVEL, flow: bad }, validate_preset, REPLACE), pattern);
});

test('workflow display metadata (author, source) round-trips, survives rename, clears cleanly, validates limits, and stays out of host routing', t => {
  const home = home_fixture(t);
  const meta = { author: '数字生命卡兹克', source: '小红书《给三个顶流 AI 分完岗，爽飞了》' };
  const saved = save_workflow(home, { ...NOVEL, ...meta }, validate_preset, REPLACE);
  assert.deepEqual([saved.author, saved.source], [meta.author, meta.source]);
  const skill_text = readFileSync(join(home, 'workflows', NOVEL.id, 'SKILL.md'), 'utf8');
  assert.match(skill_text, /\nmetadata:\n {2}label: 连载小说\n {2}author: 数字生命卡兹克\n {2}source: 小红书《给三个顶流 AI 分完岗，爽飞了》\n/);
  const listed = list_workflows(home)[0];
  assert.deepEqual([listed.author, listed.source], [meta.author, meta.source]);
  const previewed = preview_workflow({ folder: join(home, 'workflows', NOVEL.id) }, validate_preset, () => true);
  assert.deepEqual([previewed.author, previewed.source], [meta.author, meta.source]);
  // Renaming preserves display metadata.
  rename_workflow(home, NOVEL.id, '新名字');
  const renamed = get_workflow(home, NOVEL.id);
  assert.deepEqual([renamed.label, renamed.author, renamed.source], ['新名字', meta.author, meta.source]);
  // Display metadata never enters host routing context (neither CLI task file nor API host system prompt).
  const directory = join(home, 'runtime');
  mkdirSync(directory);
  const config = { mode: 'free', site: 'https://discussion.test', room: 'room', token: 'o'.repeat(32), directory, project: resolve('.'),
    api_home: home, members: { Claude: { token: 'c'.repeat(32) } }, participants: { Claude: { adapter: 'claude', project_access: 'write' } },
    workflow: { id: NOVEL.id, enabled: true, members: {} } };
  const loaded = load_room_workflow(config);
  assert.equal(loaded.author, undefined);
  assert.equal(loaded.source, undefined);
  const task_field = workflow_task_field(loaded, [{ name: 'Claude', label: 'Claude', status: 'active' }], config.participants);
  assert.equal(task_field.author, undefined);
  assert.equal(task_field.source, undefined);
  free_task_files(config, { name: 'Claude', role: 'host' }, { id: 1, read_until: 0, requests: [{ id: 1, message_id: 9, purpose: 'route' }] },
    {}, { workflow: loaded, room_members: [{ name: 'Claude', label: 'Claude', status: 'active' }] });
  const host_task = readFileSync(runtime_file(directory, 'free-1.task.json'), 'utf8');
  assert.doesNotMatch(host_task, /数字生命卡兹克|给三个顶流/);
  const api_prompt = system_prompt({ participant: 'DeepSeek', role: 'host', mode: 'free', workflow: { ...loaded, members: [] } });
  assert.doesNotMatch(api_prompt, /数字生命卡兹克|给三个顶流/);
  // Clearing author/source omits them from SKILL.md.
  const cleared = save_workflow(home, { ...NOVEL, author: '', source: '' }, validate_preset, REPLACE);
  assert.equal(cleared.author, undefined);
  assert.equal(cleared.source, undefined);
  assert.doesNotMatch(readFileSync(join(home, 'workflows', NOVEL.id, 'SKILL.md'), 'utf8'), /\b(author|source):/);
  // Validation rejects oversized or multi-line display metadata.
  for (const [change, pattern] of [
    [{ author: 'a'.repeat(65) }, /工作流作者最多 64 字/],
    [{ author: '两\n行' }, /工作流作者最多 64 字，且不能换行/],
    [{ source: 's'.repeat(201) }, /工作流出处最多 200 字/],
    [{ source: '两\n行' }, /工作流出处最多 200 字，且不能换行/],
  ]) assert.throws(() => save_workflow(home, { ...NOVEL, ...change }, validate_preset, REPLACE), pattern);
});


test('project and global workflow IDs are independent and project approvals expire after edits', t => {
  const home = home_fixture(t), cwd = home_fixture(t);
  const local = { cwd, scope: 'project' }, id = NOVEL.id;
  workflows_command(home, { action: 'save', workflow: NOVEL });
  workflows_command(home, { ...local, action: 'save', workflow: { ...NOVEL, label: 'Project' } });
  const listed = workflows_command(home, { action: 'list', cwd });
  assert.equal(listed.project_workflows[0].label, 'Project');
  assert.equal(listed.workflows[0].label, NOVEL.label);
  assert.deepEqual(readdirSync(join(cwd, '.codiscuss')), ['workflows']);
  const card = join(cwd, '.codiscuss', 'workflows', id, 'experts', 'writer.md');
  // Editing a prompt keeps the approval; raising a card's access asks again.
  writeFileSync(card, readFileSync(card, 'utf8') + 'edited');
  assert.equal(workflows_command(home, { ...local, action: 'get', id }).needs_trust, false);
  writeFileSync(card, readFileSync(card, 'utf8').replace('project_access: write', 'project_access: full'));
  assert.equal(workflows_command(home, { ...local, action: 'get', id }).needs_trust, true);
  assert.throws(() => workflows_command(home, { ...local, action: 'move', id, target_scope: 'global' }), { code: 'workflow_untrusted' });
  workflows_command(home, { ...local, action: 'trust', id });
  assert.throws(() => workflows_command(home, { ...local, action: 'move', id, target_scope: 'global' }), { code: 'workflow_exists' });
  assert.throws(() => workflows_command(home, { ...local, action: 'delete', id }, true));
  workflows_command(home, { action: 'delete', id });
  workflows_command(home, { ...local, action: 'move', id, target_scope: 'global' });
  assert.equal(get_workflow(home, id).label, 'Project');
  assert.equal(existsSync(card), false);
});

test('one workflow list includes all saved projects through the same paired-device operation', async t => {
  const home = home_fixture(t), first = home_fixture(t), second = home_fixture(t), empty = home_fixture(t);
  const unsaved = home_fixture(t), missing = join(home, 'missing-project');
  const projects = [{ name: '项目甲', path: first }, { name: '项目乙', path: second }, { name: '空项目', path: empty }, { name: '不在了', path: missing }];
  writeFileSync(join(home, 'launch-projects.json'), JSON.stringify({ projects }));
  const other_sub = { id: 'review', label: '复核', description: '复核正文', skill: '复核。',
    agents: [{ card: 'second_review', name: 'Antigravity-second_review' }] };
  const workflow = { ...NOVEL, sub_workflows: [ADVISOR, other_sub] };
  const platforms = ['DeepSeek', 'Antigravity', 'Claude', 'Antigravity'];
  workflows_command(home, { action: 'save', workflow });
  for (const [cwd, label] of [[first, '甲的工作流'], [second, '乙的工作流'], [unsaved, '未保存项目的工作流']]) {
    workflows_command(home, { action: 'save', scope: 'project', cwd, workflow: { ...workflow, label } });
  }
  const scoped = workflows_command(home, { action: 'list', cwd: first });
  assert.deepEqual(scoped.workflows.map(item => item.card_platforms), [platforms]);
  assert.deepEqual(scoped.project_workflows.map(item => item.card_platforms), [platforms]);
  const input = { action: 'list', all_projects: true };
  const listed = workflows_command(home, input);
  const [root] = listed.project_roots;
  assert.deepEqual(listed.project_roots.map(item => item.name), ['项目甲', '项目乙', '空项目']);
  assert.deepEqual(listed.workflows.map(item => [item.scope, item.id, item.card_platforms]), [['global', NOVEL.id, platforms]]);
  assert.deepEqual(listed.project_workflows.map(item => [item.project_name, item.label, item.total_cards, item.sub_workflow_count, item.card_platforms]),
    [['项目甲', '甲的工作流', 4, 2, platforms], ['项目乙', '乙的工作流', 4, 2, platforms]]);
  assert.equal(Object.hasOwn(root, 'path'), false);
  assert.equal(Object.hasOwn(listed.project_workflows[0], 'directory'), false);
  assert.equal(workflows_command(home, { action: 'get', scope: 'project', project_id: root.id, id: NOVEL.id }, true).label, '甲的工作流');

  const previous = process.env.DISCUSS_SERVICE_HOME;
  process.env.DISCUSS_SERVICE_HOME = home;
  t.after(() => { if (previous === undefined) delete process.env.DISCUSS_SERVICE_HOME; else process.env.DISCUSS_SERVICE_HOME = previous; });
  const relayed = await run_launch_command(relayed_command('http://localhost:8765', 'workflows', input));
  assert.equal(relayed.status, 200);
  assert.deepEqual(relayed.body.project_roots, listed.project_roots);
  assert.deepEqual(relayed.body.project_workflows, listed.project_workflows);
});

test('external project presets start at read access and readonly roots refuse saves', t => {
  const home = home_fixture(t), cwd = home_fixture(t), extra = home_fixture(t);
  const local = { scope: 'project', cwd }, preset = { name: 'Codex-writer', project_access: 'write' };
  const saved = presets_command(home, { ...local, action: 'save', preset });
  assert.equal(saved.project_presets[0].trusted, true);
  const file = join(cwd, '.codiscuss', 'experts', 'writer.md');
  writeFileSync(file, readFileSync(file, 'utf8') + 'edited');
  const list = presets_command(home, { cwd: extra, extra_directories: [{ path: cwd, access: 'read' }] });
  const [expert] = list.project_presets;
  assert.equal(expert.project_access, 'read');
  assert.equal(expert.requested_access, 'write');
  assert.throws(() => presets_command(home, { action: 'delete', scope: 'project', cwd: extra,
    extra_directories: [{ path: cwd, access: 'read' }], project_id: expert.project_id, id: expert.id }));
});

test('global preset migration archives the source and preserves distinct identities sharing a skill directory', t => {
  const home = home_fixture(t);
  const presets = [{ name: 'Codex-luke', label: '评审', project_access: 'read' }, { name: 'Antigravity-luke', label: '主笔' },
    { name: 'Claude-助手' }];
  const original = JSON.stringify({ presets, hidden_builtins: ['Codex-review'], description_templates: { Codex: '复核' } });
  writeFileSync(join(home, 'expert-presets.json'), original);
  writeFileSync(join(home, 'launch-settings.json'), JSON.stringify({ participants: {}, create_preferences: { theme: 'dark' } }));
  const skills = join(home, 'experts', 'luke', 'skills', 'notes');
  mkdirSync(skills, { recursive: true });
  writeFileSync(join(skills, 'SKILL.md'), 'original');
  const first = expert_presets(home);
  assert.deepEqual(first.presets.map(item => item.name).sort(), ['Antigravity-docs', 'Antigravity-luke', 'Claude-preset1', 'Codex-luke']);
  assert.equal(first.presets.find(item => item.name === 'Claude-preset1').label, 'Claude-助手');
  assert.deepEqual(first.builtin_presets, []);
  assert.deepEqual(first.description_templates, { Codex: '复核' });
  assert.equal(JSON.parse(readFileSync(join(home, 'launch-settings.json'))).create_preferences.theme, 'dark');
  assert.equal(readFileSync(join(home, 'expert-presets.json.migrated'), 'utf8'), original);
  assert.equal(readFileSync(join(home, 'backups', 'expert-presets-migration-v1.json'), 'utf8'), original);
  assert.ok(existsSync(join(home, 'experts-migrated-v1')));
  assert.equal(existsSync(join(home, 'expert-presets.json')), false);
  const copy = member_knowledge(home, 'Antigravity-luke', null);
  assert.equal(copy, join(home, 'experts', 'antigravity-luke', 'skills'));
  assert.equal(readFileSync(join(copy, 'notes', 'SKILL.md'), 'utf8'), 'original');
  writeFileSync(join(copy, 'notes', 'SKILL.md'), 'edited');
  assert.equal(readFileSync(join(member_knowledge(home, 'Codex-luke', null), 'notes', 'SKILL.md'), 'utf8'), 'original');
  assert.deepEqual(expert_presets(home), first);
  assert.equal(readFileSync(join(copy, 'notes', 'SKILL.md'), 'utf8'), 'edited');
  presets_command(home, { action: 'delete', name: 'Antigravity-docs' });
  assert.ok(!expert_presets(home).presets.some(item => item.name === 'Antigravity-docs'));
});

test('platform-prefixed project experts keep their public name across writes and deletes', t => {
  const home = home_fixture(t), cwd = home_fixture(t), selection = { cwd, scope: 'project' };
  for (const platform of ['Codex', 'Claude']) presets_command(home, {
    ...selection, action: 'save', preset: { name: platform + '-review', label: platform },
  });
  const list = presets_command(home, { ...selection, action: 'list' });
  assert.deepEqual(list.project_presets.map(item => item.name).sort(), ['Claude-review', 'Codex-review']);
  const folder = join(cwd, '.codiscuss', 'experts');
  assert.match(readFileSync(join(folder, 'claude-review.md'), 'utf8'), /name: review/);
  assert.throws(() => presets_command(home, { ...selection, action: 'delete', id: 'review' }));
  presets_command(home, { ...selection, action: 'delete', name: 'Claude-review' });
  assert.ok(existsSync(join(folder, 'review.md')));
  assert.ok(!existsSync(join(folder, 'claude-review.md')));
});


test('workflow menu selections distinguish the current binding from a same-name workflow', () => {
  const global = { id: 'novel', scope: 'global' };
  const project = { ...global, scope: 'project', project_id: 'abc' };
  for (const [current, other] of [[global, project], [project, global]]) {
    const message = [current, other].map(item => slash_insertion(item.id, item)).join('');
    assert.deepEqual(named_workflows([message], { current, in_library: () => true }),
      { workflows: ['novel'], workflow_targets: [other] });
  }
});

test('project preset skill commands identify their source and same-name knowledge stays distinct', t => {
  const home = home_fixture(t), cwd = home_fixture(t), preset = 'Codex-scopecheck';
  for (const scope of ['global', 'project']) {
    presets_command(home, { cwd, scope, action: 'save', preset: { name: preset } });
    const command = (action, options = {}) => workflows_command(home, { cwd, scope, preset, action, ...options });
    const put = (path, text) => command('skill-write', { path, text, digest: '' });
    const skill = put('notes/SKILL.md', scope);
    const file = put('notes/example.md', scope);
    for (const result of [skill, command('skills'), command('skill-delete', { path: file.path, digest: file.digest })]) {
      assert.equal(result.scope, scope);
      assert.equal(result.project_id, skill.project_id);
    }
    const read = selected => readFileSync(join(member_knowledge(home, preset, null, [cwd], selected), 'notes', 'SKILL.md'), 'utf8');
    assert.equal(read({ preset_scope: 'global' }), 'global');
    if (scope === 'project') {
      assert.ok(skill.project_id);
      assert.equal(read({ preset_scope: scope, preset_project_id: skill.project_id }), scope);
      const removed = command('skill-remove', { skill: 'notes' });
      assert.deepEqual([removed.scope, removed.project_id], [scope, skill.project_id]);
    }
  }
});

test('interrupted publication and failed atomic writes leave no temporary entries', t => {
  const home = home_fixture(t), preset = 'Codex-scopecheck';
  save_workflow(home, NOVEL, validate_preset, REPLACE);
  const root = join(home, 'workflows');
  const abandoned = join(root, '.tmp-' + NOVEL.id + '-' + randomUUID());
  mkdirSync(abandoned);
  list_workflows(home);
  assert.equal(existsSync(abandoned), false);
  const save = label => presets_command(home, { action: 'save', overwrite: true, preset: { name: preset, label } });
  save('before');
  const skill = (text, digest) => workflows_command(home, { action: 'skill-write', preset, path: 'notes/SKILL.md', text, digest });
  const first = skill('old', '');
  const rename = fs.renameSync;
  const fault = t.mock.method(fs, 'renameSync', (from, to) => {
    if (String(from).endsWith('.tmp') || String(from).includes('.tmp-' + NOVEL.id)) throw new Error('publication failed');
    return rename(from, to);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => save('after'), /publication failed/);
    assert.throws(() => skill('new', first.digest), /publication failed/);
    assert.throws(() => save_workflow(home, NOVEL, validate_preset, REPLACE), /publication failed/);
  } finally {
    fault.mock.restore();
    syncBuiltinESMExports();
  }
  assert.deepEqual(readdirSync(home, { recursive: true }).filter(name => name.endsWith('.tmp') || name.includes('.tmp-' + NOVEL.id)), []);
  assert.equal(get_workflow(home, NOVEL.id).id, NOVEL.id);
  assert.equal(expert_presets(home).presets.find(item => item.name === preset).label, 'before');
  assert.ok(skill('new', first.digest).digest);
});

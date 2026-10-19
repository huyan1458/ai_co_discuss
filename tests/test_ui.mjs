import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../web/app.js", import.meta.url), "utf8").replace(/\nrestore_theme\(\);[\s\S]*$/, "");
const discussion_source = readFileSync(new URL("../frontend/ChannelDiscussion.vue", import.meta.url), "utf8");

/** Exercise theme persistence and renderer selection without touching discussion data. */
function theme_fixture(saved_theme = null, shared_storage = null) {
  const nodes = new Map([['legacy-style', {}], ['modern-style', {}], ['settings-dialog', { close() {} }]]);
  const classes = new Set();
  const storage = shared_storage || new Map([['ai-codiscuss-theme', saved_theme]]);
  const loaded = [];
  const buttons = ['channel', 'channel-light', 'millennium'].map((theme) => ({
    dataset: { themeOption: theme }, setAttribute(key, value) { this[key] = value; },
  }));
  const document = {
    documentElement: { dataset: {}, classList: { toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); } } },
    getElementById: (id) => nodes.get(id), querySelectorAll: () => buttons,
    createElement: () => ({}), head: { append(node) { nodes.set(node.id, node); loaded.push(node); } },
  };
  const context = vm.createContext({ window: {}, document, crypto: globalThis.crypto, localStorage: {
    getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value),
    removeItem: key => storage.delete(key), key: index => [...storage.keys()][index], get length() { return storage.size; },
  } });
  vm.runInContext(`${source}\nglobalThis.test_state = state;`, context);
  context.publish_view = () => {};
  return { context, nodes, classes, storage, loaded, buttons, root: document.documentElement };
}

test("recent conversation order is local, reversible and preserves manual placement and drafts", () => {
  const fixture = theme_fixture();
  const state = fixture.context.test_state;
  const rooms = [{ id: 'a', latest_id: 1 }, { id: 'b', latest_id: 10 }, { id: 'c', latest_id: 4 }];
  Object.assign(state, { rooms, room: rooms[0], query: '保留筛选' });
  fixture.context.render_rooms = () => {};
  fixture.nodes.set('message-input', { value: '未发送草稿' });
  fixture.context.sort_directory('recent');
  assert.deepEqual(Array.from(fixture.context.visible_rooms(), room => room.id), ['b', 'c', 'a']);
  assert.equal(state.rooms, rooms);
  assert.equal(state.room, rooms[0]);
  assert.equal(state.query, '保留筛选');
  assert.equal(fixture.nodes.get('message-input').value, '未发送草稿');
  state.directory_sort = 'manual';
  fixture.context.restore_directory_sort();
  assert.equal(state.directory_sort, 'recent');
  fixture.context.sort_directory('manual');
  assert.deepEqual(Array.from(fixture.context.visible_rooms(), room => room.id), ['a', 'b', 'c']);
});

test("retrying a lost mode response preserves the owner credential and reconciles runtime", async () => {
  const fixture = theme_fixture();
  const key = 'discuss-access:room-a';
  fixture.context.test_state.room = { id: 'room-a', runtime: { revision: 0, protected: false } };
  let runtime = { revision: 0, protected: false, mode: 'manual', status: 'ready' };
  let accepted_token;
  let sequence = 0;
  let writes = 0;
  Object.assign(fixture.context, {
    crypto: { randomUUID: () => `credential-${++sequence}` }, refresh_room: async () => {}, show_toast() {},
    request_json: async (path, payload) => {
      assert.equal(path, '/api/rooms/room-a/runtime');
      if (!payload) return runtime;
      writes++;
      if (runtime.protected) assert.equal(fixture.storage.get(key), accepted_token);
      assert.equal(payload.revision, runtime.revision);
      accepted_token = fixture.storage.get(key);
      runtime = { revision: 1, protected: true, mode: 'automatic', status: 'ready' };
      throw new Error('response lost');
    },
  });
  await assert.rejects(fixture.context.choose_runtime('automatic'), /response lost/);
  await fixture.context.choose_runtime('automatic');
  assert.equal(fixture.storage.get(key), accepted_token);
  assert.equal(writes, 1);
});

test("mode selection retains its target when the user changes rooms during refresh", async () => {
  const fixture = theme_fixture();
  fixture.context.test_state.room = { id: 'room-a' };
  const paths = [];
  Object.assign(fixture.context, {
    crypto: { randomUUID: () => 'credential-a' }, refresh_room: async () => {}, show_toast() {},
    request_json: async (path, payload) => {
      paths.push(path);
      fixture.context.test_state.room = { id: 'room-b' };
      return { revision: 0, protected: false, mode: 'manual', status: 'ready' };
    },
  });
  await fixture.context.choose_runtime('automatic');
  assert.deepEqual(paths, ['/api/rooms/room-a/runtime', '/api/rooms/room-a/runtime']);
  assert.equal(fixture.storage.get('discuss-access:room-a'), 'credential-a');
  assert.equal(fixture.storage.get('discuss-access:room-b'), undefined);
});

test("finished discussions show their conclusion instead of a live timer or a later deadline warning", () => {
  const fixture = theme_fixture();
  fixture.context.test_state.room = { phase: 'concluded' };
  const label = fixture.context.limits_label({ started_at: 1, reached: true, elapsed_seconds: 3600, remaining_seconds: 0 });
  assert.match(label, /讨论已收束/);
  assert.doesNotMatch(label, /已用|剩余|已达上限/);
});

test("classic scheduling disables new work and explains a reached limit", () => {
  const fixture = theme_fixture();
  for (const id of ['floor-status', 'take-floor', 'return-floor', 'turn-status', 'turn-note', 'turn-expert', 'turn-question', 'copy-turn', 'confirm-notified', 'forward-turn', 'cancel-turn', 'view-turn-answer', 'schedule-turn', 'schedule-note']) fixture.nodes.set(id, {});
  fixture.context.test_state.room = { phase: 'discussing', host: 'Codex', experts: { Codex: 'cli' },
    floor: { holder: 'Codex' }, limits: { reached: true } };
  fixture.context.render_current_turn();
  assert.equal(fixture.nodes.get('schedule-turn').disabled, true);
  assert.match(fixture.nodes.get('schedule-note').textContent, /已达到讨论上限/);
});

test("folder creation target is submitted atomically and changes the retry identifier", async () => {
  const fixture = theme_fixture();
  const requests = [];
  for (const id of ['title', 'goal', 'host', 'user_request', 'background', 'boundaries', 'mode']) fixture.nodes.set(`new-room-${id}`, { value: id === 'mode' ? 'manual' : '内容' });
  fixture.nodes.set('room-dialog', { close() {} });
  fixture.nodes.set('room-form', { reset() {} });
  fixture.root.dataset.theme = 'channel';
  let sequence = 0;
  Object.assign(fixture.context, {
    crypto: { randomUUID: () => `token-${++sequence}` }, new_submission_id: () => `submission-${++sequence}`,
    read_expert_inputs: () => ({}), read_limits: () => ({}), default_experts: () => ({}), render_expert_inputs() {},
    select_room: async () => {}, select_tab() {}, show_toast() {}, render_rooms() {}, render_room() {},
    request_json: async (path, payload) => { requests.push(payload); throw new Error('retry'); },
  });
  const submit = folder => fixture.context.submit_room({ preventDefault() {} }, folder);
  await assert.rejects(submit('one'), /retry/);
  await assert.rejects(submit('one'), /retry/);
  await assert.rejects(submit('two'), /retry/);
  assert.equal(requests[0].folder_id, 'one');
  assert.equal(requests[0].user_request, '内容');
  assert.equal(requests[0].submission_id, requests[1].submission_id);
  assert.notEqual(requests[1].submission_id, requests[2].submission_id);
  fixture.context.request_json = async (path, payload) => { requests.push(payload); return { id: 'created', folder_id: payload.folder_id }; };
  fixture.context.test_state.archive_view = true;
  await submit();
  assert.equal(requests.at(-1).folder_id, null);
  assert.equal(fixture.context.test_state.archive_view, false);
});

test("light channel survives reload and selects the Vue renderer without dark mode", () => {
  const fixture = theme_fixture('channel-light');
  fixture.context.restore_theme();
  assert.equal(fixture.root.dataset.theme, 'channel-light');
  assert.equal(fixture.classes.has('dark'), false);
  assert.equal(fixture.nodes.get('legacy-style').disabled, true);
  assert.equal(fixture.nodes.get('modern-style').disabled, false);
  assert.equal(fixture.buttons.find((button) => button.dataset.themeOption === 'channel-light')['aria-pressed'], 'true');
  assert.equal(fixture.loaded.length, 1);
});

for (const recovery of [false, true]) test(`local defaults exclude session bindings and launch drafts are consumed after ${recovery ? 'saved-request recovery' : 'successful creation'}`, async () => {
  const fixture = theme_fixture();
  const state = fixture.context.test_state;
  const requests = [];
  let sequence = 0;
  let fail = true;
  let dialog_closes = 0;
  fixture.nodes.set('room-dialog', { close() { dialog_closes++; } });
  fixture.nodes.set('room-form', { reset() {} });
  Object.assign(state.launch, { available: true, create: true,
    profiles: { Codex: { adapter: 'codex_cli', executable: 'C:\\codex.exe', session_id: 'one-room-session' } },
    workspace: { cwd: 'C:\\project', discussion_project: '本次项目' } });
  Object.assign(fixture.context, {
    crypto: { randomUUID: () => `token-${++sequence}` }, new_submission_id: () => `submission-${++sequence}`,
    room_creation_payload: () => ({ title: '网页发起', runtime_mode: 'automatic' }),
    render_launch_settings() {}, render_expert_inputs() {}, default_experts: () => ({}), select_room: async () => {},
    update_directory: async ({ save, commit }) => { const result = await save(); commit(result); return result; },
    local_launch_request: async (action, payload) => {
      requests.push({ action, payload });
      if (action === 'settings') return {};
      if (fail) throw new Error('lost receipt');
      return { room: { id: 'created' } };
    },
  });
  await fixture.context.save_launch_defaults();
  assert.equal(requests[0].payload.participants.Codex.session_id, undefined);
  assert.equal(state.launch.profiles.Codex.session_id, 'one-room-session');
  await assert.rejects(fixture.context.submit_room({ preventDefault() {} }), /lost receipt/);
  assert.equal(dialog_closes, 0, 'failed startup must leave configuration open for correction or retry');
  assert.match(state.launch.error, /结果尚未确认.*lost receipt/);
  assert.equal(state.launch.profiles.Codex.session_id, 'one-room-session');
  fail = false;
  if (recovery) await fixture.context.resume_launch(state.pending_room.id);
  else await fixture.context.submit_room({ preventDefault() {} });
  assert.equal(requests[1].payload.room.submission_id, requests[2].payload.room.submission_id);
  assert.equal(requests[1].payload.token, requests[2].payload.token);
  assert.equal(fixture.storage.get('discuss-access:created'), requests[2].payload.token);
  assert.equal(state.launch.profiles.Codex.session_id, undefined);
  assert.equal(state.launch.profiles.Codex.executable, 'C:\\codex.exe');
  assert.deepEqual(Object.keys(state.launch.workspace), []);
  assert.equal(state.launch.create, false);
  assert.equal(dialog_closes, 1);
  assert.equal(state.launch.error, '');
});

test("an existing-room launch keeps its target and preserves newer configuration edits", async () => {
  const fixture = theme_fixture();
  const state = fixture.context.test_state;
  state.room = { id: 'room-a', runtime: { protected: false } };
  state.launch.profiles = { Codex: { session_id: 'old-session' } };
  state.launch.workspace = { cwd: 'C:\\old' };
  let request;
  let refreshed = false;
  Object.assign(fixture.context, {
    crypto: { randomUUID: () => 'owner-token' }, render_launch_settings() {}, refresh_room: async () => { refreshed = true; },
    local_launch_request: async (action, payload) => {
      request = payload;
      state.room = { id: 'room-b' };
      state.launch.profiles.Codex.session_id = 'new-session';
      state.launch.workspace.cwd = 'C:\\new';
      return { status: 'running', room: { id: payload.room_id } };
    },
  });
  await fixture.context.launch_current_room();
  assert.equal(request.room_id, 'room-a');
  assert.equal(request.participants.Codex.session_id, 'old-session');
  assert.equal(fixture.storage.get('discuss-access:room-a'), 'owner-token');
  assert.equal(state.launch.profiles.Codex.session_id, 'new-session');
  assert.equal(state.launch.workspace.cwd, 'C:\\new');
  assert.equal(refreshed, false);
});

test("launch drafts retain explicit clears so saved participant defaults cannot override this discussion", () => {
  const fixture = theme_fixture();
  Object.assign(fixture.context.test_state.launch, { profiles: { Codex: { adapter: 'codex_cli',
    cwd: '', project_name: '', project_id: '', session_id: '' } }, workspace: { cwd: 'C:\\this-discussion' } });
  const draft = fixture.context.launch_options();
  assert.equal(draft.participants.Codex.cwd, '');
  assert.equal(draft.participants.Codex.project_name, '');
  assert.equal(draft.participants.Codex.project_id, '');
  assert.equal(draft.cwd, 'C:\\this-discussion');
});

test("automatic creation uses configured local clients and preserves independent mode choices", () => {
  const f = theme_fixture();
  const state = f.context.test_state;
  const mode = { value: 'manual' };
  const host = { value: '用户' };
  f.nodes.set('new-room-mode', mode); f.nodes.set('new-room-host', host);
  let experts = { Codex: 'cli', Claude: 'online', DeepSeek: 'online' };
  f.context.read_expert_inputs = () => experts;
  f.context.render_expert_inputs = (_id, value) => { experts = value; };
  state.launch.profiles = { Codex: { adapter: 'codex_cli', executable: 'C:\\codex.exe' },
    Claude: { adapter: 'claude', executable: 'C:\\claude.exe' }, Gemini: { adapter: 'antigravity_cli' } };
  mode.value = 'automatic'; f.context.update_creation_mode();
  assert.equal(host.value, 'Codex');
  assert.deepEqual(Object.entries(experts), [['Codex', 'cli'], ['Claude', 'cli']]);
  host.value = 'Claude'; experts = { Claude: 'cli' };
  mode.value = 'manual'; f.context.update_creation_mode();
  assert.equal(host.value, '用户'); assert.equal(experts.DeepSeek, 'online');
  mode.value = 'automatic'; f.context.update_creation_mode();
  assert.equal(host.value, 'Claude'); assert.deepEqual(Object.entries(experts), [['Claude', 'cli']]);
});

test("room path correction keeps defaults separate, reports acknowledgement and ignores another room's late result", async () => {
  const f = theme_fixture(); const state = f.context.test_state;
  state.room = { id: 'one' }; state.launch.profiles = { Codex: { executable: 'machine-default' } };
  f.storage.set('discuss-access:one', 'owner');
  Object.assign(f.context, { render_room_configuration() {}, refresh_room: async () => {},
    local_launch_request: async () => ({ room_id: 'one', version: 'v1', runtime_revision: 3,
      participants: { Codex: { adapter: 'codex_cli', executable: 'old-path' } } }) });
  await f.context.load_room_configuration();
  f.context.write_room_connection('Codex', 'fixed-path');
  assert.equal(state.launch.profiles.Codex.executable, 'machine-default');
  f.context.local_launch_request = async (_action, input) => {
    assert.equal(input.token, 'owner'); assert.equal(input.version, 'v1');
    assert.deepEqual(Object.keys(input.participants.Codex), ['executable']);
    return { ...input, applied: false };
  };
  await f.context.save_room_configuration();
  assert.match(state.launch.repair.notice, /尚未确认采用/);
  f.context.local_launch_request = async () => { state.room = { id: 'two' }; return { room_id: 'one' }; };
  await f.context.load_room_configuration();
  assert.equal(state.launch.repair.participants.Codex.executable, 'fixed-path');
});

test("empty automatic discussions describe their actual state instead of requiring another message", () => {
  const message = theme_fixture().context.empty_discussion_message;
  for (const [status, pattern] of [['ready', /尚未启动/], ['running', /等待 AI 执行/], ['paused', /已暂停/], ['stopped', /已停止/]]) {
    assert.match(message({ phase: 'preparing', runtime: { mode: 'automatic', status } }), pattern);
  }
  assert.match(message({ phase: 'concluded' }), /已结束/);
});

test("a reloaded browser explicitly resumes the original submitted launch and retains ownership", async () => {
  const first = theme_fixture();
  const input = { room: { submission_id: 'original-request', title: '原议题' }, token: 'owner-token',
    participants: { Codex: { adapter: 'codex_cli', cwd: 'original-directory' } } };
  let sends = 0;
  first.context.local_launch_request = async (_action, payload) => {
    sends++;
    assert.equal(JSON.parse(first.storage.get('discuss-launch:original-request')).input.token, payload.token);
    throw Object.assign(new Error('service unavailable'), { launch: { stage: 'created', room_id: 'original-room' } });
  };
  await assert.rejects(first.context.submit_local_launch(input, '原议题'), /房间已创建/);
  assert.equal(first.storage.get('discuss-access:original-room'), input.token);
  const reloaded = theme_fixture(null, first.storage);
  const state = reloaded.context.test_state;
  state.launch.profiles = { Codex: { cwd: 'changed-default' } };
  let selected;
  Object.assign(reloaded.context, { render_launch_settings() {}, select_room: async id => { selected = id; },
    local_launch_request: async (_action, payload) => {
      sends++;
      assert.deepEqual(JSON.parse(JSON.stringify(payload)), input);
      return { room: { id: 'original-room' }, status: 'running' };
    } });
  reloaded.context.refresh_launch_recoveries();
  assert.equal(sends, 1, 'loading the page must not restart a discussion');
  assert.equal(state.launch.recoveries[0].room_id, 'original-room');
  assert.doesNotMatch(JSON.stringify(state.launch), /owner-token|original-directory/);
  await reloaded.context.resume_launch('original-request');
  assert.equal(sends, 2);
  assert.equal(selected, 'original-room');
  assert.equal(state.launch.profiles.Codex.cwd, 'changed-default');
  assert.equal(first.storage.get('discuss-launch:original-request'), undefined);
  assert.equal(first.storage.get('discuss-access:original-room'), input.token);
});

test("a lost response is retained across reload while changed input cannot replace the original request", async () => {
  const fixture = theme_fixture();
  const input = { room: { submission_id: 'lost', title: '原议题' }, token: 'original-owner' };
  fixture.context.local_launch_request = async () => { throw new Error('response lost'); };
  await assert.rejects(fixture.context.submit_local_launch(input, '原议题'), /结果尚未确认/);
  const reloaded = theme_fixture(null, fixture.storage);
  reloaded.context.refresh_launch_recoveries();
  assert.equal(reloaded.context.test_state.launch.recoveries.length, 1);
  await assert.rejects(reloaded.context.submit_local_launch({ ...input, token: 'changed-owner' }, '原议题'), /未完成的原启动请求/);
  assert.equal(JSON.parse(fixture.storage.get('discuss-launch:lost')).input.token, 'original-owner');
});

test("preflight rejection permits correction while storage failure prevents any launch request", async () => {
  const fixture = theme_fixture();
  const input = { room: { submission_id: 'preflight' }, token: 'owner' };
  let sends = 0;
  fixture.context.local_launch_request = async () => { sends++; throw Object.assign(new Error('bad executable'), { launch: { stage: 'not_started' } }); };
  await assert.rejects(fixture.context.submit_local_launch(input, '校验'), /bad executable/);
  assert.equal(fixture.storage.get('discuss-launch:preflight'), undefined);
  fixture.context.localStorage.setItem = () => { throw new Error('storage blocked'); };
  await assert.rejects(fixture.context.submit_local_launch(input, '校验'), /尚未发送/);
  assert.equal(sends, 1);
});

test("a delayed failure in another tab cannot resurrect a completed launch", async () => {
  const first = theme_fixture();
  const second = theme_fixture(null, first.storage);
  const input = { room: { submission_id: 'shared-request' }, token: 'owner' };
  let reject_second;
  second.context.local_launch_request = () => new Promise((_resolve, reject) => { reject_second = reject; });
  const pending = second.context.submit_local_launch(input, '同一请求');
  first.context.local_launch_request = async () => ({ room: { id: 'one-room' }, status: 'running' });
  await first.context.submit_local_launch(input, '同一请求');
  reject_second(new Error('late response loss'));
  await assert.rejects(pending, /late response loss/);
  assert.equal(first.storage.get('discuss-launch:shared-request'), undefined);
  assert.equal(first.storage.get('discuss-access:one-room'), 'owner');
});

test("a late preflight rejection cannot delete the newer attempt another tab still needs to recover", async () => {
  const first = theme_fixture();
  const second = theme_fixture(null, first.storage);
  const input = { room: { submission_id: 'same-input' }, token: 'owner' };
  let reject_first;
  first.context.local_launch_request = () => new Promise((_resolve, reject) => { reject_first = reject; });
  const earlier = first.context.submit_local_launch(input, '原请求');
  second.context.local_launch_request = async () => { throw Object.assign(new Error('created then failed'), { launch: { stage: 'created', room_id: 'created-room' } }); };
  await assert.rejects(second.context.submit_local_launch(input, '原请求'), /created then failed/);
  const newer_record = first.storage.get('discuss-launch:same-input');
  reject_first(Object.assign(new Error('earlier validation failed'), { launch: { stage: 'not_started' } }));
  await assert.rejects(earlier, /earlier validation failed/);
  assert.equal(first.storage.get('discuss-launch:same-input'), newer_record);
  assert.equal(first.storage.get('discuss-access:created-room'), 'owner');
});

test("a retry preflight rejection preserves an earlier in-flight request when its response is lost", async () => {
  const first = theme_fixture();
  const second = theme_fixture(null, first.storage);
  const input = { room: { submission_id: 'in-flight' }, token: 'owner' };
  let reject_first;
  first.context.local_launch_request = () => new Promise((_resolve, reject) => { reject_first = reject; });
  const earlier = first.context.submit_local_launch(input, '原请求');
  second.context.local_launch_request = async () => { throw Object.assign(new Error('retry validation failed'), { launch: { stage: 'not_started' } }); };
  await assert.rejects(second.context.submit_local_launch(input, '原请求'), /原启动结果仍待确认/);
  reject_first(new Error('started but response lost'));
  await assert.rejects(earlier, /started but response lost/);
  const reloaded = theme_fixture(null, first.storage);
  reloaded.context.refresh_launch_recoveries();
  assert.equal(reloaded.context.test_state.launch.recoveries.length, 1);
  reloaded.context.local_launch_request = async (_action, payload) => {
    assert.deepEqual(JSON.parse(JSON.stringify(payload)), input);
    return { room: { id: 'original-room' }, status: 'running' };
  };
  await reloaded.context.submit_local_launch(input, '原请求');
  assert.equal(first.storage.get('discuss-launch:in-flight'), undefined);
  assert.equal(first.storage.get('discuss-access:original-room'), 'owner');
});

test("missing existing-room credentials remain visible in the default theme without sending a request", async () => {
  const fixture = theme_fixture();
  fixture.root.dataset.theme = 'channel';
  fixture.context.test_state.room = { id: 'protected', runtime: { protected: true } };
  let sends = 0;
  Object.assign(fixture.context, { render_launch_settings() {}, local_launch_request: async () => { sends++; } });
  await fixture.context.launch_current_room();
  assert.match(fixture.context.test_state.launch.error, /缺少房间凭据/);
  assert.equal(sends, 0);
});

test("launch readback distinguishes effective directories, project metadata and existing App bindings", () => {
  const fixture = theme_fixture();
  Object.assign(fixture.context.test_state.launch, { profiles: { Codex: { adapter: 'codex_cli', cwd: 'C:\\specific' },
    Claude: { adapter: 'claude' }, Gemini: { adapter: 'antigravity_cli', project_id: 'project-id' } },
    workspace: { cwd: 'C:\\common', discussion_project: '任务项目' } });
  assert.equal(fixture.context.launch_summary('Codex').cwd, 'C:\\specific');
  assert.equal(fixture.context.launch_summary('Claude').cwd, 'C:\\common');
  assert.match(fixture.context.launch_summary('Codex').project, /任务说明，不切换软件项目/);
  assert.equal(fixture.context.launch_summary('Gemini').project, 'project-id');
  fixture.context.write_launch_field('Codex', 'cwd', '');
  assert.equal(fixture.context.launch_summary('Codex').cwd, 'C:\\common');
  Object.assign(fixture.context.test_state.launch.profiles.Codex, { adapter: 'codex', session_id: 'existing' });
  assert.equal(fixture.context.launch_summary('Codex').session, '复用指定会话');
  assert.equal(fixture.context.launch_summary('Codex').project, '沿用指定会话的项目');
  fixture.context.test_state.launch.workspace = {};
  assert.equal(fixture.context.launch_summary('Claude').cwd, '本次讨论的私有目录');
});

test("switching all three themes preserves the room, filter, reply and draft", () => {
  const fixture = theme_fixture();
  const room = { id: 'welcome' };
  Object.assign(fixture.context.test_state, { room, query: '原文', reply_to: 42, tab: 'discussion' });
  fixture.nodes.set('message-input', { value: '尚未发送的草稿' });
  for (const theme of ['channel', 'channel-light', 'millennium', 'channel-light', 'channel']) {
    fixture.context.change_view_theme(theme);
    assert.equal(fixture.storage.get('ai-codiscuss-theme'), theme);
    assert.equal(fixture.classes.has('dark'), theme === 'channel');
    assert.equal(fixture.nodes.get('modern-style').disabled, theme === 'millennium');
    assert.equal(fixture.context.test_state.room, room);
    assert.equal(fixture.context.test_state.query, '原文');
    assert.equal(fixture.context.test_state.reply_to, 42);
    assert.equal(fixture.context.test_state.tab, 'discussion');
    assert.equal(fixture.nodes.get('message-input').value, '尚未发送的草稿');
  }
  assert.equal(fixture.loaded.length, 1);
});

/** Exercise the real navigation pointer handlers with a deterministic hold clock. */
function navigation_touch_fixture() {
  let now = 0;
  let sequence = 0;
  const timers = new Map();
  const previews = [];
  const jumps = [];
  const context = vm.createContext({
    navigation_keyboard: { value: false }, preview_entry: { value: null }, preview_open: { value: false },
    setTimeout(callback, delay) { const id = ++sequence; timers.set(id, { callback, time: now + delay }); return id; },
    clearTimeout: (id) => timers.delete(id), jump_to: (id) => jumps.push(id),
    show_preview(item) { previews.push(item.key); context.preview_open.value = true; context.preview_entry.value = item.key; },
    close_preview() { context.cancel_navigation_press(); context.preview_open.value = false; },
  });
  const constants = discussion_source.slice(discussion_source.indexOf("const NAV_LONG_PRESS_MS"), discussion_source.indexOf("const preview_y"));
  const handlers = discussion_source.slice(discussion_source.indexOf("/** Begin a touch preview"), discussion_source.indexOf("/** Native wheel scrolling"));
  vm.runInContext(constants + handlers, context);
  const item = { key: "message-12", message: { id: 12 } };
  const event = (extra = {}) => ({ pointerType: "touch", pointerId: 1, clientX: 40, clientY: 80, currentTarget: {}, type: "pointerdown", detail: 1, preventDefault() {}, ...extra });
  return { context, previews, jumps, item, event,
    start: (extra) => context.start_navigation_press(item, event(extra)),
    advance(ms) { now += ms; for (const [id, timer] of timers) if (timer.time <= now) { timers.delete(id); timer.callback(); } },
  };
}

test("touch navigation previews only after a hold and release never jumps", () => {
  const fixture = navigation_touch_fixture();
  fixture.context.hover_preview(fixture.item, fixture.event({ type: "pointerenter" }));
  assert.deepEqual(fixture.previews, []);
  fixture.start();
  fixture.advance(449);
  assert.deepEqual(fixture.previews, []);
  fixture.advance(1);
  assert.deepEqual(fixture.previews, ["message-12"]);
  let menu_prevented = false;
  fixture.context.navigation_context_menu({ preventDefault() { menu_prevented = true; } });
  assert.equal(menu_prevented, true);
  fixture.context.finish_navigation_press(fixture.event({ type: "pointerup" }));
  assert.equal(fixture.context.preview_open.value, false);
  fixture.context.activate_navigation(fixture.item, fixture.event());
  assert.deepEqual(fixture.jumps, []);
});

test("touch scrolling, cancellation and view cleanup cancel delayed previews", () => {
  for (const cancellation of ["movement", "pointercancel", "view"]) {
    const fixture = navigation_touch_fixture();
    fixture.start();
    if (cancellation === "movement") fixture.context.hover_preview(fixture.item, fixture.event({ type: "pointermove", clientY: 100 }));
    else if (cancellation === "pointercancel") fixture.context.finish_navigation_press(fixture.event({ type: "pointercancel" }));
    else fixture.context.cancel_navigation_press();
    fixture.advance(1000);
    assert.deepEqual(fixture.previews, []);
    assert.deepEqual(fixture.jumps, []);
  }
});

test("short taps, later taps, mouse hover and keyboard activation retain their behavior", () => {
  const fixture = navigation_touch_fixture();
  fixture.start();
  fixture.advance(450);
  fixture.context.finish_navigation_press(fixture.event({ type: "pointerup" }));
  fixture.context.activate_navigation(fixture.item, fixture.event({ detail: 0 }));
  assert.deepEqual(fixture.jumps, [12]);
  fixture.start();
  fixture.advance(100);
  fixture.context.finish_navigation_press(fixture.event({ type: "pointerup" }));
  fixture.context.activate_navigation(fixture.item, fixture.event());
  assert.deepEqual(fixture.jumps, [12, 12]);
  fixture.context.hover_preview(fixture.item, fixture.event({ pointerType: "mouse", type: "pointerenter" }));
  assert.deepEqual(fixture.previews, ["message-12", "message-12"]);
});

/** Run the actual history controller with an isolated cursor API and no browser. */
function history_fixture(records) {
  const requests = [];
  const context = vm.createContext({ URLSearchParams, window: {}, document: { getElementById: () => ({ value: "Codex" }) } });
  vm.runInContext(`${source}\nglobalThis.test_state = state;`, context);
  context.request_json = async (path) => {
    requests.push(path);
    const url = new URL(path, "http://test.local");
    const room = url.pathname.split("/")[3];
    const params = url.searchParams;
    const matching = records.filter((message) => message.room === room && message.id > Number(params.get("after"))
      && (!params.get("q") || message.text.includes(params.get("q")))
      && (!params.get("mention") || message.text.includes(`@${params.get("mention")}`)));
    const messages = matching.slice(0, 20);
    return { messages, has_more: matching.length > 20, next_after: messages.at(-1)?.id || Number(params.get("after")) };
  };
  return { context, state: context.test_state, requests, load: () => context.load_message_history("scale50", context.test_state.refresh_version) };
}

/** Run the actual directory move controller with isolated room management requests. */
function move_fixture(rooms) {
  const requests = [];
  const context = vm.createContext({ URLSearchParams, window: {}, document: { getElementById: () => ({ value: "Codex" }) } });
  vm.runInContext(`${source}\nglobalThis.test_state = state; globalThis.test_move_channel = move_channel;`, context);
  context.test_state.rooms = rooms;
  context.test_state.room = null;
  context.request_json = async (path, payload) => {
    requests.push({ path, payload });
    if (path === "/api/rooms") return { rooms, folders: [] };
    return {};
  };
  context.refresh_room = async () => {};
  context.render_rooms = () => {};
  context.render_room = () => {};
  context.publish_view = () => {};
  context.show_toast = () => {};
  return { requests, move: context.test_move_channel };
}

/** Hold real controller requests so UI state can be inspected before server replies. */
function folder_fixture() {
  const requests = [];
  const notices = [];
  const frames = [];
  const draft = { value: "保留当前草稿" };
  const context = vm.createContext({ URLSearchParams, window: {}, document: { getElementById: () => draft } });
  vm.runInContext(`${source}\nglobalThis.test_state = state;`, context);
  const state = context.test_state;
  state.rooms = [{ id: "a", title: "话题 A", folder_id: "one" }, { id: "b", folder_id: "one" }];
  state.room = { ...state.rooms[0], goal: "原议题" };
  state.messages = [{ id: 10, text: "原发言" }];
  context.request_json = (path, payload) => new Promise((resolve, reject) => requests.push({ path, payload, resolve, reject }));
  context.render_rooms = () => {};
  context.render_room = () => {};
  context.set_connection = () => {};
  context.publish_view = () => frames.push(state.rooms.map((room) => ({ ...room })));
  context.show_toast = (message) => notices.push(message);
  return { context, state, requests, notices, frames, draft,
    move: (id = "a", folder_id = "two") => context.manage_channel({ id, action: "folder", folder_id }) };
}

test("folder moves render before the write resolves and use only the write receipt", async () => {
  const fixture = folder_fixture();
  const messages = fixture.state.messages;
  const saving = fixture.move();
  assert.equal(fixture.state.rooms[0].folder_id, "two");
  assert.equal(fixture.state.room.folder_id, "two");
  assert.equal(fixture.frames[0][0].folder_id, "two");
  assert.deepEqual(fixture.notices, []);
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.requests[0].path, "/api/rooms/a/folder");
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.requests[0].payload)), { actor: "用户", folder_id: "two" });
  fixture.requests[0].resolve({ id: "a", folder_id: "two" });
  await saving;
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.state.folder_moves.size, 0);
  assert.equal(fixture.state.messages, messages);
  assert.equal(fixture.draft.value, "保留当前草稿");
  assert.deepEqual(fixture.notices, ["话题归类已更新"]);
});

test("failed folder writes restore placement without rolling back newer room data", async () => {
  const fixture = folder_fixture();
  const saving = fixture.move("a", null);
  assert.equal(fixture.state.rooms[0].folder_id, null);
  fixture.state.rooms[0].title = "其他操作更新的标题";
  fixture.state.room = { id: "b", goal: "切换后的议题" };
  fixture.requests[0].reject(new Error("保存失败"));
  await assert.rejects(saving, /保存失败/);
  assert.equal(fixture.state.rooms[0].folder_id, "one");
  assert.equal(fixture.state.rooms[0].title, "其他操作更新的标题");
  assert.equal(fixture.state.room.id, "b");
  assert.equal(fixture.state.folder_moves.size, 0);
  assert.deepEqual(fixture.notices, []);
  const retry = fixture.move("a", null);
  fixture.requests[1].resolve({ id: "a", folder_id: null });
  await retry;
  assert.equal(fixture.state.rooms[0].folder_id, null);
});

test("background refresh preserves newer folder moves while still updating conversation data", async () => {
  const fixture = folder_fixture();
  const saving = fixture.move();
  const refreshing = fixture.context.refresh_room();
  fixture.requests[1].resolve({ rooms: [{ id: "a", folder_id: "one" }], folders: [] });
  await new Promise(setImmediate);
  assert.equal(fixture.state.rooms[0].folder_id, "two");
  fixture.requests[2].resolve({ id: "a", folder_id: "one", goal: "最新议题" });
  await refreshing;
  assert.equal(fixture.state.room.folder_id, "two");
  assert.equal(fixture.state.room.goal, "最新议题");
  const stale_refresh = fixture.context.refresh_room();
  fixture.requests[0].resolve({ id: "a", folder_id: "two" });
  await saving;
  fixture.requests[3].resolve({ rooms: [{ id: "a", folder_id: "one" }], folders: [] });
  await new Promise(setImmediate);
  fixture.requests[4].resolve({ id: "a", folder_id: "one", goal: "保存期间读取的新议题" });
  await stale_refresh;
  assert.equal(fixture.state.rooms[0].folder_id, "two");
  assert.equal(fixture.state.room.folder_id, "two");
  assert.equal(fixture.state.room.goal, "保存期间读取的新议题");
});

test("duplicate folder writes are held while other rooms can save independently", async () => {
  const fixture = folder_fixture();
  const first = fixture.move();
  await fixture.move("a", null);
  assert.equal(fixture.requests.length, 1);
  const second = fixture.move("b", null);
  assert.equal(fixture.requests.length, 2);
  fixture.requests[1].resolve({ id: "b", folder_id: null });
  await second;
  fixture.requests[0].reject(new Error("首个保存失败"));
  await assert.rejects(first, /首个保存失败/);
  assert.deepEqual(Array.from(fixture.state.rooms, (room) => room.folder_id), ["one", null]);
});

test("archiving updates the directory immediately and keeps the current conversation and draft", async () => {
  const fixture = folder_fixture();
  fixture.state.room.phase = "discussing";
  const messages = fixture.state.messages;
  const saving = fixture.context.manage_channel({ id: "a", action: "archive" });
  assert.deepEqual(Array.from(fixture.context.visible_rooms(), room => room.id), ["b"]);
  assert.equal(fixture.state.room.id, "a");
  assert.equal(fixture.state.room.archived, true);
  assert.equal(fixture.state.room.phase, "paused");
  assert.equal(fixture.frames[0][0].archived, true);
  assert.equal(fixture.requests[0].path, "/api/rooms/a/archive");
  fixture.state.room.goal = "等待期间更新的议题";
  fixture.requests[0].resolve({ id: "a", archived: 1, phase: "paused", goal: "旧议题" });
  await saving;
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.state.archive_changes.size, 0);
  assert.equal(fixture.state.room.goal, "等待期间更新的议题");
  assert.equal(fixture.state.messages, messages);
  assert.equal(fixture.draft.value, "保留当前草稿");
});

test("failed archives restore only the target while preserving later navigation and edits", async () => {
  const fixture = folder_fixture();
  fixture.state.room.phase = "discussing";
  const saving = fixture.context.manage_channel({ id: "a", action: "archive" });
  Object.assign(fixture.state.rooms[0], { title: "新标题", folder_id: "two", phase: "concluded" });
  fixture.state.room = { id: "b", phase: "discussing" };
  fixture.state.archive_view = true;
  fixture.draft.value = "新页面的草稿";
  fixture.requests[0].reject(new Error("网络断开"));
  await assert.rejects(saving, /网络断开/);
  assert.equal(fixture.state.rooms[0].archived, false);
  assert.equal(fixture.state.rooms[0].phase, "concluded");
  assert.equal(fixture.state.rooms[0].title, "新标题");
  assert.equal(fixture.state.rooms[0].folder_id, "two");
  assert.equal(fixture.state.room.id, "b");
  assert.equal(fixture.state.archive_view, true);
  assert.equal(fixture.draft.value, "新页面的草稿");
  assert.match(fixture.state.directory_error, /话题 A.*存档失败.*网络断开/);
  assert.equal(fixture.state.archive_changes.size, 0);
});

test("pending and completed archives survive stale refreshes while other room data stays fresh", async () => {
  for (const fails of [false, true]) {
    const fixture = folder_fixture();
    fixture.state.room.phase = "discussing";
    const saving = fixture.context.manage_channel({ id: "a", action: "archive" });
    const settled = fails ? assert.rejects(saving, /失败/) : saving;
    const refreshing = fixture.context.refresh_room();
    fixture.requests[1].resolve({ rooms: [{ id: "a", archived: false, folder_id: "one" }], folders: [] });
    await new Promise(setImmediate);
    fixture.requests[2].resolve({ id: "a", archived: false, phase: "discussing", goal: "最新议题" });
    await refreshing;
    assert.equal(fixture.state.room.archived, true);
    assert.equal(fixture.state.room.phase, "paused");
    const stale_refresh = fixture.context.refresh_room();
    if (fails) fixture.requests[0].reject(new Error("失败"));
    else fixture.requests[0].resolve({ id: "a", archived: true, phase: "paused" });
    await settled;
    fixture.requests[3].resolve({ rooms: [{ id: "a", archived: fails, folder_id: "one" }], folders: [] });
    await new Promise(setImmediate);
    fixture.requests[4].resolve({ id: "a", archived: fails, phase: fails ? "paused" : "discussing", goal: "更晚的议题" });
    await stale_refresh;
    assert.equal(fixture.state.rooms[0].archived, !fails);
    assert.equal(fixture.state.room.archived, !fails);
    assert.equal(fixture.state.room.phase, fails ? "discussing" : "paused");
    assert.equal(fixture.state.room.goal, "更晚的议题");
  }
});

test("only duplicate archive writes are held and restoring a concluded room never restarts it", async () => {
  const fixture = folder_fixture();
  fixture.state.room.phase = "concluded";
  const first = fixture.context.manage_channel({ id: "a", action: "archive" });
  await fixture.context.manage_channel({ id: "a", action: "restore" });
  assert.equal(fixture.requests.length, 1);
  const second = fixture.context.manage_channel({ id: "b", action: "archive" });
  assert.equal(fixture.requests.length, 2);
  fixture.requests[1].resolve({ id: "b", archived: true, phase: "paused" });
  await second;
  fixture.requests[0].resolve({ id: "a", archived: true, phase: "concluded" });
  await first;
  const restoring = fixture.context.manage_channel({ id: "a", action: "restore" });
  assert.equal(fixture.state.room.archived, false);
  assert.equal(fixture.state.room.phase, "concluded");
  fixture.requests[2].resolve({ id: "a", archived: false, phase: "concluded" });
  await restoring;
  assert.equal(fixture.state.rooms[1].archived, true);
});

test("directory requests do not take or release the global action lock", async () => {
  const pending_requests = [];
  const bridge = { snapshot: () => ({}), execute: (name) => new Promise(resolve => pending_requests.push({ name, resolve })) };
  const context = vm.createContext({ window: { discuss_view: bridge }, document: { addEventListener() {}, removeEventListener() {} },
    ref: value => ({ value }), shallowRef: value => ({ value }), onBeforeUnmount() {} });
  const adapter = readFileSync(new URL("../frontend/use-discussion.js", import.meta.url), "utf8").replace(/^import .*\n/, "").replace("export function", "function");
  vm.runInContext(adapter, context);
  const discussion = context.use_discussion();
  const archiving = discussion.act("manage_channel", { id: "a", action: "archive" });
  assert.equal(discussion.pending.value, "");
  const navigating = discussion.act("room", "b");
  assert.equal(pending_requests.length, 2);
  assert.equal(discussion.pending.value, "room");
  pending_requests[0].resolve(true);
  await archiving;
  assert.equal(discussion.pending.value, "room");
  pending_requests[1].resolve(true);
  await navigating;
  assert.equal(discussion.pending.value, "");
  for (const name of ["move_channel", "create_folder", "rename_folder", "delete_folder", "move_folder", "create"]) {
    const saving = discussion.act(name, {});
    assert.equal(discussion.pending.value, "");
    pending_requests.at(-1).resolve(true);
    await saving;
  }
});

test("archive dialogs close before the response and never close a later dialog", async () => {
  let finish;
  const context = vm.createContext({ mode: { value: "archive" }, props: { targetRoom: { id: "a" } },
    management_title: { value: "" }, act: () => new Promise(resolve => { finish = resolve; }) });
  const dialog = readFileSync(new URL("../frontend/WorkspaceDialogs.vue", import.meta.url), "utf8");
  vm.runInContext(dialog.match(/async function save_management\(\) \{[\s\S]*?\n\}/)[0], context);
  const saving = context.save_management();
  assert.equal(context.mode.value, "");
  context.mode.value = "create";
  finish(true);
  await saving;
  assert.equal(context.mode.value, "create");
});

test("archive manager opening preserves the selected channel and draft", () => {
  const room = { id: "current" };
  const draft = { value: "保留未发送内容" };
  const context = vm.createContext({ modal: { value: "" }, nav_open: { value: true }, room, draft,
    act() { assert.fail("opening archive management must not navigate or fetch"); } });
  const workspace = readFileSync(new URL("../frontend/ChannelWorkspace.vue", import.meta.url), "utf8");
  vm.runInContext(workspace.match(/function open_archives\(\) \{[^\n]+/)[0], context);
  context.open_archives();
  assert.equal(context.modal.value, "archives");
  assert.equal(context.nav_open.value, false);
  assert.equal(context.room, room);
  assert.equal(draft.value, "保留未发送内容");
});

test("archive search uses one newest-first list regardless of folder membership", () => {
  const context = vm.createContext({});
  const dialog = readFileSync(new URL("../frontend/WorkspaceDialogs.vue", import.meta.url), "utf8");
  vm.runInContext(dialog.match(/function filter_archived_channels\(rooms, filters\) \{[\s\S]*?\n\}/)[0], context);
  const rooms = [
    { id: "old", title: "Codex 旧方案", archived: true, folder_id: "work", message_count: 0, created_at: "2026-10-15" },
    { id: "active", title: "Codex 进行中", archived: false, folder_id: "work", message_count: 6, created_at: "2026-10-17" },
    { id: "loose", title: "未分类记录", archived: true, folder_id: null, message_count: 0, created_at: "2026-10-16" },
    { id: "new", title: "CODEX 新方案", archived: true, folder_id: "work", message_count: 12, created_at: "2026-10-17" },
    { id: "orphan", title: "历史记录", archived: true, folder_id: "removed", message_count: 3, created_at: "2026-10-14" },
  ];
  const initial = JSON.stringify(rooms);
  const matching = filters => Array.from(context.filter_archived_channels(rooms,
    { query: "", content: "all", ...filters }), room => room.id);
  assert.deepEqual(matching({}), ["new", "loose", "old", "orphan"]);
  assert.deepEqual(matching({ query: " codex ", content: "messages" }), ["new"]);
  assert.deepEqual(matching({ content: "empty" }), ["loose", "old"]);
  assert.deepEqual(matching({ query: "不存在" }), []);
  assert.equal(JSON.stringify(rooms), initial);
});

test("folder removal preserves channels and drafts through stale reads and failure", async () => {
  for (const fails of [false, true]) {
    const fixture = folder_fixture();
    fixture.state.folders = [{ id: "one", name: "待移除" }, { id: "two", name: "保留" }];
    fixture.state.uncategorized_position = 1;
    fixture.state.rooms[1].archived = true;
    const saving = fixture.context.delete_folder("one");
    assert.equal(fixture.requests[0].path, "/api/folders/one/delete");
    assert.deepEqual(Array.from(fixture.state.rooms, room => room.folder_id), [null, null]);
    assert.equal(fixture.state.room.folder_id, null);
    assert.equal(fixture.state.uncategorized_position, 0);
    assert.equal(fixture.context.merge_room_folder({ id: "a", folder_id: "one" }, fixture.state.folder_version).folder_id, null);
    await fixture.context.delete_folder("two");
    await fixture.move("a", "two");
    assert.equal(fixture.requests.length, 1);
    fixture.context.patch_directory_room("a", { title: "后来修改的标题" });
    fixture.state.folders[0].name = "后来修改的分组";
    const during = fixture.state.folder_version;
    if (fails) {
      fixture.requests[0].reject(new Error("保存失败"));
      await assert.rejects(saving, /保存失败/);
    } else { fixture.requests[0].resolve({ deleted: true, id: "one" }); await saving; }
    assert.deepEqual(Array.from(fixture.state.folders, folder => folder.id), fails ? ["one", "two"] : ["two"]);
    assert.equal(fixture.state.folders.at(-1).name, "后来修改的分组");
    assert.equal(fixture.state.uncategorized_position, fails ? 1 : 0);
    assert.equal(fixture.state.rooms[0].title, "后来修改的标题");
    assert.equal(fixture.state.rooms[1].archived, true);
    assert.equal(fixture.state.room.id, "a");
    assert.equal(fixture.draft.value, "保留当前草稿");
    assert.equal(fixture.state.messages[0].text, "原发言");
    assert.equal(fixture.context.merge_room_folder({ id: "a", folder_id: fails ? null : "one" }, during).folder_id, fails ? "one" : null);
    assert.equal(fixture.state.folder_moves.size, 0);
  }
});

test("reading an archived channel keeps modern directory movement in the active list", async () => {
  const fixture = theme_fixture();
  const moves = [];
  fixture.root.dataset.theme = "channel-light";
  Object.assign(fixture.context.test_state, { archive_view: true,
    rooms: [{ id: "a", archived: false }, { id: "b", archived: false }, { id: "old", archived: true }] });
  fixture.context.manage_channel = async request => moves.push(request);
  await fixture.context.move_channel({ id: "b", direction: -1, folder_id: null });
  assert.equal(moves.length, 1);
  assert.equal(moves[0].id, "b");
  assert.equal(moves[0].before_id, "a");
  fixture.root.dataset.theme = "millennium";
  assert.deepEqual(Array.from(fixture.context.visible_rooms(), room => room.id), ["old"]);
});

test("archive deletion needs one confirmation click and cannot close a later dialog", async () => {
  let finish;
  const requests = [];
  const context = vm.createContext({ mode: { value: "archives" },
    view: { value: { archive_pending: [], directory_pending: [] } },
    archive_delete_room: { value: { id: "archived", title: "存档频道" } },
    archive_delete_id: { value: "archived" },
    act: (name, value) => { requests.push({ name, ...value }); return new Promise(resolve => { finish = resolve; }); } });
  const dialog = readFileSync(new URL("../frontend/WorkspaceDialogs.vue", import.meta.url), "utf8");
  vm.runInContext(dialog.match(/function archive_busy\(room\) \{[\s\S]*?\n\}/)[0], context);
  vm.runInContext(dialog.match(/async function delete_archive\(\) \{[\s\S]*?\n\}/)[0], context);
  context.view.value.archive_pending = ["archived"];
  await context.delete_archive();
  assert.equal(requests.length, 0);
  context.view.value.archive_pending = [];
  const saving = context.delete_archive();
  assert.deepEqual(requests, [{ name: "manage_channel", id: "archived", action: "delete" }]);
  assert.equal(context.archive_delete_id.value, null);
  assert.equal(context.mode.value, "archives");
  context.mode.value = "settings";
  finish(false);
  await saving;
  assert.equal(context.mode.value, "settings");
});

test("renaming and archiving reconcile independently without replacing newer room details", async () => {
  const fixture = folder_fixture();
  const renaming = fixture.context.manage_channel({ id: "a", action: "rename", title: "新名称" });
  assert.equal(fixture.state.room.title, "新名称");
  const archiving = fixture.context.manage_channel({ id: "a", action: "archive" });
  const refreshing = fixture.context.refresh_room();
  fixture.requests[2].resolve({ rooms: [{ id: "a", title: "旧名称", archived: false }], folders: [] });
  await new Promise(setImmediate);
  fixture.requests[3].resolve({ id: "a", title: "旧名称", archived: false, phase: "preparing", goal: "最新内容" });
  await refreshing;
  assert.equal(fixture.state.room.title, "新名称");
  assert.equal(fixture.state.room.archived, true);
  assert.equal(fixture.state.room.goal, "最新内容");
  const stale = fixture.context.refresh_room();
  fixture.requests[0].resolve({ id: "a", title: "新名称", goal: "旧内容" });
  fixture.requests[1].resolve({ id: "a", archived: true, phase: "paused" });
  await Promise.all([renaming, archiving]);
  fixture.requests[4].resolve({ rooms: [{ id: "a", title: "旧名称" }], folders: [] });
  await new Promise(setImmediate);
  fixture.requests[5].resolve({ id: "a", title: "旧名称", archived: false, goal: "再次更新" });
  await stale;
  assert.equal(fixture.state.room.title, "新名称");
  assert.equal(fixture.state.room.archived, true);
  assert.equal(fixture.state.room.goal, "再次更新");
});

test("room sorting responds before saving and rollback retains other successful edits", async () => {
  const fixture = folder_fixture();
  const moving = fixture.context.manage_channel({ id: "b", action: "move", before_id: "a" });
  assert.deepEqual(Array.from(fixture.state.rooms, room => room.id), ["b", "a"]);
  const renaming = fixture.context.manage_channel({ id: "a", action: "rename", title: "独立修改" });
  fixture.requests[1].resolve({ id: "a", title: "独立修改" });
  await renaming;
  fixture.requests[0].reject(new Error("排序未保存"));
  await assert.rejects(moving, /排序未保存/);
  assert.deepEqual(Array.from(fixture.state.rooms, room => room.id), ["a", "b"]);
  assert.equal(fixture.state.rooms[0].title, "独立修改");
  assert.equal(fixture.state.room.id, "a");
  assert.equal(fixture.requests.length, 2);
});

test("folder creation shows a provisional entry and does not roll back other folder edits", async () => {
  const fixture = folder_fixture();
  fixture.context.new_submission_id = () => "temp-one";
  fixture.state.folders = [{ id: "one", name: "原文件夹" }];
  const creating = fixture.context.create_folder("新文件夹");
  assert.equal(fixture.state.folders[1].name, "新文件夹");
  assert.equal(fixture.state.folders[1].pending, true);
  await fixture.move("a", fixture.state.folders[1].id);
  assert.equal(fixture.requests.length, 1);
  const renaming = fixture.context.rename_folder({ id: "one", name: "更新名称" });
  assert.equal(fixture.state.folders[0].name, "更新名称");
  fixture.requests[1].resolve({ id: "one", name: "更新名称" });
  await renaming;
  fixture.requests[0].reject(new Error("创建失败"));
  await assert.rejects(creating, /创建失败/);
  assert.equal(fixture.state.folders.length, 1);
  assert.equal(fixture.state.folders[0].name, "更新名称");
  const retry = fixture.context.create_folder("新文件夹");
  fixture.requests[2].resolve({ id: "two", name: "新文件夹", position: 2 });
  await retry;
  assert.equal(fixture.state.folders[1].id, "two");
  assert.equal(fixture.state.folders[1].pending, undefined);
});

test("confirmed deletion responds immediately and failure restores only the removed entry", async () => {
  const fixture = folder_fixture();
  fixture.state.room = fixture.state.rooms[1];
  const deleting = fixture.context.manage_channel({ id: "a", action: "delete" });
  assert.deepEqual(Array.from(fixture.state.rooms, room => room.id), ["b"]);
  fixture.state.rooms[0].title = "等待期间的修改";
  fixture.draft.value = "仍在编辑";
  fixture.requests[0].reject(new Error("删除失败"));
  await assert.rejects(deleting, /删除失败/);
  assert.deepEqual(Array.from(fixture.state.rooms, room => room.id), ["a", "b"]);
  assert.equal(fixture.state.rooms[1].title, "等待期间的修改");
  assert.equal(fixture.state.room.id, "b");
  assert.equal(fixture.draft.value, "仍在编辑");
});

for (const interaction of ["navigation", "classic draft input"]) test(`room creation shows immediate progress and preserves later ${interaction}`, async () => {
  const fixture = folder_fixture();
  let resolve;
  let selections = 0;
  let closes = 0;
  let resets = 0;
  let input;
  fixture.context.document.addEventListener = (type, listener) => { if (type === "input") input = listener; };
  fixture.context.element = id => ({ addEventListener() {}, closest: () => ({ setAttribute() {} }),
    ...(id === "room-dialog" ? { close: () => { closes++; } } : { reset: () => { resets++; } }) });
  fixture.context.bind_controls();
  Object.assign(fixture.context, {
    room_creation_payload: () => ({ title: "新讨论", runtime_mode: "manual", folder_id: null }),
    new_submission_id: () => "create-test-id", crypto: { randomUUID: () => "local-token" },
    request_json: () => new Promise(done => { resolve = done; }), render_expert_inputs() {}, default_experts: () => ({}),
    select_room: async () => { selections++; },
  });
  const creating = fixture.context.submit_room({ preventDefault() {} });
  assert.equal(closes, 1);
  assert.equal(fixture.state.creating_room.title, "新讨论");
  if (interaction === "navigation") {
    fixture.state.navigation_version++;
    fixture.state.room = fixture.state.rooms[1];
  } else { fixture.draft.value = "创建期间继续编辑"; input(); }
  resolve({ id: "created", title: "新讨论" });
  await creating;
  assert.equal(fixture.state.rooms.at(-1).id, "created");
  assert.equal(fixture.state.creating_room, null);
  assert.equal(fixture.state.room.id, interaction === "navigation" ? "b" : "a");
  if (interaction === "classic draft input") assert.equal(fixture.draft.value, "创建期间继续编辑");
  assert.equal(selections, 0);
  assert.equal(resets, 1);
});

/** Provide only the DOM operations exercised by the real pointer controller. */
function drag_node(attributes = {}, parent = null, top = 0) {
  const classes = new Set();
  const children = [];
  const listeners = new Map();
  const node = { attributes, parent, children, listeners, classes, style: {}, offsetWidth: 160, offsetHeight: 30,
    dataset: Object.fromEntries(Object.entries(attributes).map(([key, value]) => [key.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), value])),
    hasAttribute: (key) => Object.hasOwn(attributes, key),
    closest(selector) { return selector.split(",").some((part) => this.hasAttribute(part.trim().slice(1, -1))) ? this : parent?.closest(selector); },
    contains(target) { return target === this || children.some((child) => child.contains(target)); },
    querySelectorAll(selector) { return children.flatMap((child) => [...(child.hasAttribute(selector.slice(1, -1)) ? [child] : []), ...child.querySelectorAll(selector)]); },
    querySelector(selector) { return this.querySelectorAll(selector)[0]; },
    getBoundingClientRect: () => ({ top, height: 20 }),
    classList: { add: (...names) => names.forEach((name) => classes.add(name)), remove: (...names) => names.forEach((name) => classes.delete(name)) },
    addEventListener: (type, handler) => listeners.set(type, handler), removeEventListener: (type) => listeners.delete(type),
    setPointerCapture() { this.captured = true; }, hasPointerCapture() { return this.captured; }, releasePointerCapture() { this.captured = false; },
    setAttribute: (key, value) => { attributes[key] = value; }, append: (child) => children.push(child), remove() { this.removed = true; },
  };
  parent?.append(node);
  return node;
}

/** Exercise title and folder drops with deterministic hit testing and captured writes. */
function drag_fixture() {
  const writes = [];
  const list = drag_node({ "data-room-directory": "" });
  const one = drag_node({ "data-room-folder": "one", "data-drag-folder": "one" }, list);
  const two = drag_node({ "data-room-folder": "two", "data-drag-folder": "two" }, list, 80);
  const none = drag_node({ "data-room-folder": "", "data-drag-folder": "__uncategorized__" }, list, 120);
  const headings = [one, two, none].map((folder) => drag_node({ "data-drop-folder": "", "data-drag-handle": "" }, folder));
  const row = drag_node({ "data-drag-room": "a" }, one);
  const neighbor = drag_node({ "data-drag-room": "b" }, one, 60);
  const title = drag_node({ "data-drag-title": "" }, row);
  const grip = drag_node({ "data-drag-handle": "" }, row);
  const body = drag_node();
  let hit = title;
  const document = { body, documentElement: { dataset: { theme: "channel" } }, createElement: () => drag_node(),
    elementFromPoint: () => hit, addEventListener() {}, removeEventListener() {} };
  const context = vm.createContext({ URLSearchParams, window: { innerWidth: 1440, innerHeight: 900 }, document });
  vm.runInContext(`${source}\nglobalThis.test_state = state;`, context);
  context.test_state.rooms = [{ id: "a", title: "原话题", folder_id: "one" }, { id: "b", folder_id: "one" }];
  context.test_state.folders = [{ id: "one", name: "第一组" }, { id: "two", name: "第二组" }];
  context.run_action = (action) => action();
  context.manage_channel = async (payload) => writes.push(JSON.parse(JSON.stringify(payload)));
  context.move_folder = async (payload) => writes.push(JSON.parse(JSON.stringify(payload)));
  const event = (extra = {}) => ({ target: title, currentTarget: title, pointerId: 1, button: 0, pointerType: "mouse", clientX: 20, clientY: 20, preventDefault() {}, stopPropagation() {}, ...extra });
  return { context, writes, list, row, title, grip, neighbor, headings, body, event,
    start: (extra) => context.start_directory_drag(event(extra)),
    move(target, extra = {}) { hit = target; context.update_directory_drag(event({ clientY: 70, ...extra })); },
    finish: (extra) => context.finish_directory_drag(event({ type: "pointerup", clientY: 70, ...extra })),
  };
}

test("folder dragging moves the whole group on release and never changes membership", async () => {
  const fixture = drag_fixture();
  fixture.start({ target: fixture.headings[0] });
  fixture.move(fixture.headings[1], { clientY: 99 });
  assert.equal(fixture.body.children[0].textContent, "第一组");
  assert.equal(fixture.headings[1].parent.classes.has("drop-after"), true);
  assert.deepEqual(fixture.writes, []);
  await fixture.finish({ clientY: 99 });
  assert.deepEqual(fixture.writes, [{ id: "one", before_id: "__uncategorized__" }]);
  assert.equal(fixture.headings[1].parent.classes.has("drop-after"), false);
  assert.equal(fixture.context.test_state.rooms[0].folder_id, "one");
});

test("folder drags can end on either side of uncategorized and Escape never saves", async () => {
  const fixture = drag_fixture();
  fixture.start({ target: fixture.headings[0], pointerType: "touch" });
  fixture.move(fixture.headings[2], { clientY: 121 });
  assert.equal(fixture.headings[2].parent.classes.has("drop-before"), true);
  fixture.context.cancel_directory_drag(fixture.event({ key: "Escape" }));
  assert.deepEqual(fixture.writes, []);
  fixture.start({ target: fixture.headings[0] });
  fixture.move(fixture.headings[2], { clientY: 121 });
  await fixture.finish({ clientY: 121 });
  assert.deepEqual(fixture.writes, [{ id: "one", before_id: "__uncategorized__" }]);
  fixture.writes.length = 0;
  fixture.start({ target: fixture.headings[0] });
  fixture.move(fixture.headings[2], { clientY: 139 });
  assert.equal(fixture.headings[2].parent.classes.has("drop-after"), true);
  await fixture.finish({ clientY: 139 });
  assert.deepEqual(fixture.writes, [{ id: "one", before_id: null }]);
});

test("uncategorized itself can be dragged above the only custom folder", async () => {
  const fixture = drag_fixture();
  fixture.context.test_state.folders = [{ id: "one", name: "test" }];
  fixture.start({ target: fixture.headings[2], clientY: 130 });
  fixture.move(fixture.headings[0], { clientY: 1 });
  assert.equal(fixture.body.children[0].textContent, "未归类");
  await fixture.finish({ clientY: 1 });
  assert.deepEqual(fixture.writes, [{ id: "__uncategorized__", before_id: "one" }]);
  assert.equal(fixture.context.test_state.rooms[0].folder_id, "one");
});

test("one custom folder and uncategorized can exchange places with keyboard movement", async () => {
  const fixture = folder_fixture();
  const folders = [{ id: "one", name: "test" }];
  fixture.state.folders = folders;
  const moving = fixture.context.move_folder({ id: "one", direction: 1 });
  assert.equal(fixture.requests[0].payload.before_id, null);
  fixture.requests[0].resolve({ folders, uncategorized_position: 0 });
  await moving;
  assert.deepEqual(Array.from(fixture.context.ordered_folders(), group => group.id), ["", "one"]);
  const returning = fixture.context.move_folder({ id: "__uncategorized__", direction: 1 });
  assert.equal(fixture.requests[1].path, "/api/folders/__uncategorized__/move");
  fixture.requests[1].resolve({ folders, uncategorized_position: null });
  await returning;
  assert.deepEqual(Array.from(fixture.context.ordered_folders(), group => group.id), ["one", ""]);
  assert.equal(fixture.draft.value, "保留当前草稿");
});

test("folder ordering saves once, preserves drafts and recovers after a failed write", async () => {
  const fixture = folder_fixture();
  const original = [{ id: "one" }, { id: "two" }, { id: "three" }];
  fixture.state.folders = original;
  const saving = fixture.context.move_folder({ id: "one", direction: 1 });
  assert.equal(fixture.requests[0].path, "/api/folders/one/move");
  assert.equal(fixture.requests[0].payload.before_id, "three");
  assert.deepEqual(Array.from(fixture.state.folders, folder => folder.id), ["two", "one", "three"]);
  await fixture.context.move_folder({ id: "two", direction: 1 });
  const refreshing = fixture.context.refresh_room();
  fixture.requests[1].resolve({ rooms: fixture.state.rooms, folders: original });
  await new Promise(setImmediate);
  fixture.requests[2].resolve({ id: "a", goal: "更新后的议题" });
  await refreshing;
  assert.deepEqual(Array.from(fixture.state.folders, folder => folder.id), ["two", "one", "three"]);
  fixture.requests[0].reject(new Error("排序失败"));
  await assert.rejects(saving, /排序失败/);
  assert.deepEqual(Array.from(fixture.state.folders, folder => folder.id), ["one", "two", "three"]);
  assert.equal(fixture.state.folder_order_pending, false);
  const retry = fixture.context.move_folder({ id: "one", before_id: null });
  const ordered = [original[1], original[2], original[0]];
  fixture.requests[3].resolve({ folders: ordered });
  await retry;
  assert.deepEqual(Array.from(fixture.state.folders, folder => folder.id), ["two", "three", "one"]);
  assert.equal(fixture.state.room.id, "a");
  assert.equal(fixture.draft.value, "保留当前草稿");
});

test("dragging a title assigns an empty or collapsed folder only on release", async () => {
  const fixture = drag_fixture();
  fixture.start();
  fixture.move(fixture.headings[1]);
  assert.equal(fixture.headings[1].classes.has("drop-folder"), true);
  assert.equal(fixture.body.children[0].textContent, "原话题");
  assert.deepEqual(fixture.writes, []);
  await fixture.finish();
  assert.deepEqual(fixture.writes, [{ id: "a", action: "folder", folder_id: "two" }]);
  assert.equal(fixture.headings[1].classes.has("drop-folder"), false);
  assert.equal(fixture.body.children[0].removed, true);
});

test("a drop on uncategorized removes the folder assignment", async () => {
  const fixture = drag_fixture();
  fixture.start();
  fixture.move(fixture.headings[2]);
  await fixture.finish();
  assert.deepEqual(fixture.writes, [{ id: "a", action: "folder", folder_id: null }]);
});

test("leaving a folder target or cancelling the pointer never saves its stale target", async () => {
  for (const cancel of [false, true]) {
    const fixture = drag_fixture();
    fixture.start();
    fixture.move(fixture.headings[1]);
    if (!cancel) fixture.move(null);
    await fixture.finish(cancel ? { type: "pointercancel" } : {});
    assert.deepEqual(fixture.writes, []);
    assert.equal(fixture.context.test_state.dragged_room, null);
    assert.equal(fixture.headings[1].classes.has("drop-folder"), false);
  }
});

test("same-folder title dragging still reorders and Escape cancels", async () => {
  const fixture = drag_fixture();
  fixture.start();
  fixture.move(fixture.neighbor, { clientY: 79 });
  await fixture.finish({ clientY: 79 });
  assert.deepEqual(fixture.writes, [{ id: "a", action: "move", before_id: null }]);
  fixture.writes.length = 0;
  fixture.start();
  fixture.move(fixture.headings[1]);
  fixture.context.cancel_directory_drag(fixture.event({ key: "Escape" }));
  assert.deepEqual(fixture.writes, []);
  assert.equal(fixture.context.test_state.dragged_room, null);
});

test("title clicks remain clicks, drag clicks are consumed, and touch titles remain scrollable", async () => {
  const fixture = drag_fixture();
  let prevented = false;
  const click = fixture.event({ detail: 1, preventDefault() { prevented = true; }, stopImmediatePropagation() {} });
  fixture.start();
  await fixture.finish({ clientY: 20 });
  fixture.context.suppress_directory_drag_click(click);
  assert.equal(prevented, false);
  fixture.start();
  fixture.move(fixture.headings[1], { clientX: 40, clientY: 20 });
  await fixture.finish({ clientX: 40, clientY: 20 });
  fixture.context.suppress_directory_drag_click(click);
  assert.equal(prevented, true);
  fixture.start({ pointerType: "touch" });
  assert.equal(fixture.context.test_state.dragged_room, null);
  fixture.start({ target: fixture.grip, pointerType: "touch" });
  assert.equal(fixture.context.test_state.dragged_room.handle, fixture.grip);
  await fixture.finish({ type: "pointercancel" });
});

test("folder-scoped channel moves stay within the folder and preserve its neighboring order", async () => {
  const fixture = move_fixture([
    { id: "a", folder_id: "one" }, { id: "b", folder_id: "two" },
    { id: "c", folder_id: "one" }, { id: "d", folder_id: "one" }, { id: "e", folder_id: "two" },
  ]);
  await fixture.move({ id: "d", direction: -1, folder_id: "one" });
  assert.equal(fixture.requests[0].path, "/api/rooms/d/move");
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.requests[0].payload)), { actor: "用户", before_id: "c" });
  fixture.requests.length = 0;
  await fixture.move({ id: "d", direction: 1, folder_id: "one" });
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.requests[0].payload)), { actor: "用户", before_id: "e" });
  fixture.requests.length = 0;
  await fixture.move({ id: "a", direction: 1, folder_id: "one" });
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.requests[0].payload)), { actor: "用户", before_id: "d" });
});

test("channel moves without folder_id retain the original flat ordering", async () => {
  const fixture = move_fixture([
    { id: "a", folder_id: "one" }, { id: "b", folder_id: "two" }, { id: "c", folder_id: "one" },
  ]);
  await fixture.move({ id: "a", direction: 1 });
  assert.equal(fixture.requests[0].path, "/api/rooms/a/move");
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.requests[0].payload)), { actor: "用户", before_id: "c" });
});

test("folder-scoped moves at either boundary issue no write", async () => {
  const fixture = move_fixture([
    { id: "a", folder_id: "one" }, { id: "b", folder_id: "two" }, { id: "c", folder_id: "one" },
  ]);
  await fixture.move({ id: "a", direction: -1, folder_id: "one" });
  await fixture.move({ id: "c", direction: 1, folder_id: "one" });
  assert.deepEqual(fixture.requests, []);
});

test("continuous history joins 200 records exactly once and refreshes from its cursor", async () => {
  const records = Array.from({ length: 200 }, (_, index) => ({ id: index + 1, room: "scale50", text: `第 ${Math.floor(index / 4) + 1} 轮` }));
  const fixture = history_fixture(records);
  const first = await fixture.load();
  assert.deepEqual(Array.from(first.messages, (message) => message.id), records.map((message) => message.id));
  assert.equal(fixture.requests.length, 10);
  records.push({ id: 201, room: "scale50", text: "新发言" });
  const refreshed = await fixture.load();
  assert.equal(refreshed.total, 201);
  assert.equal(refreshed.pages, 1);
  assert.match(fixture.requests.at(-1), /after=200$/);
  assert.equal(new Set(refreshed.messages.map((message) => message.id)).size, 201);
});

test("search, mention and room changes never reuse another history cursor", async () => {
  const records = Array.from({ length: 50 }, (_, index) => ({ id: index + 1, room: "scale50", text: index % 2 ? "原文" : "重点 @Codex" }));
  const fixture = history_fixture(records);
  await fixture.load();
  fixture.state.query = "重点";
  const filtered = await fixture.load();
  assert.equal(filtered.total, 25);
  assert.match(fixture.requests[3], /after=0$/);
  fixture.state.query = "";
  fixture.state.mention_only = true;
  assert.equal((await fixture.load()).total, 25);
  assert.match(fixture.requests.at(-1), /mention=Codex/);
  assert.equal((await fixture.context.load_message_history("empty-room", 0)).total, 0);
  assert.match(fixture.requests.at(-1), /empty-room\/messages\?.*after=0$/);
});

test("an obsolete request cannot replace history after a room or filter change", async () => {
  const fixture = history_fixture([{ id: 1, room: "scale50", text: "已读取" }]);
  await fixture.load();
  const saved = fixture.state.message_history;
  fixture.context.request_json = async () => {
    fixture.state.refresh_version++;
    return { messages: [{ id: 2 }], has_more: false };
  };
  assert.equal(await fixture.load(), null);
  assert.equal(fixture.state.message_history, saved);
});

test("a failed later batch keeps the previous complete history available for retry", async () => {
  const fixture = history_fixture([{ id: 1, room: "scale50", text: "已读取" }]);
  await fixture.load();
  const saved = fixture.state.message_history;
  let batch = 0;
  fixture.context.request_json = async () => {
    if (batch++) throw new Error("连接中断");
    return { messages: [{ id: 2 }], has_more: true };
  };
  await assert.rejects(fixture.load, /连接中断/);
  assert.equal(fixture.state.message_history, saved);
  assert.equal(saved.messages.length, 1);
});

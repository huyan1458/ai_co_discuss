import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { computed, nextTick, reactive, ref, watch } from "vue";
import { API_PROVIDERS } from "../runner/discussion_api.mjs";
import { member_actions } from "../frontend/member-actions.js";
import { access_label, access_options } from "../runner/expert_prompts.mjs";
import { axis_ticks, execution_log, execution_stages, format_duration, handoff_lines, notes_between, pan_window, row_status, snapshot_at, timeline_axis, timeline_rows, timeline_runs, timeline_summary, view_axis, zoom_window } from "../frontend/timeline-model.js";

const source = readFileSync(new URL("../web/app.js", import.meta.url), "utf8").replace(/\nrestore_theme\(\);[\s\S]*$/, "");
const discussion_source = readFileSync(new URL("../frontend/ChannelDiscussion.vue", import.meta.url), "utf8");

test('all providers expose API without installed software and keys never enter drafts or storage', async () => {
  const f = theme_fixture(), state = f.context.test_state, calls = [];
  Object.assign(f.context, { render_launch_settings() {}, render_launch_summaries() {}, local_launch_request: async (route, input) => {
    calls.push({ route, input });
    return route === 'api-key' ? { api_key_ref: 'opaque-key-ref' } : { adapter: 'api', source: 'api', models: [{ id: 'vendor/model.1', label: 'Vendor Model' }] };
  } });
  state.launch.api_providers = API_PROVIDERS;
  state.launch.available = true;
  for (const name of Object.keys(API_PROVIDERS)) {
    assert.ok(f.context.window.discuss_view.launch_clients[name].some(item => item.value === 'api'));
    f.context.write_launch_field(name, 'adapter', 'api');
    assert.equal(state.launch.profiles[name].base_url, API_PROVIDERS[name].base_url);
    assert.equal(state.launch.profiles[name].executable, undefined);
  }
  f.context.write_launch_field('Grok', 'base_url', 'https://openrouter.ai/api/v1');
  f.context.write_launch_field('Grok', 'api_protocol', 'chat');
  f.context.write_launch_field('Grok', 'model', 'vendor/model.1');
  await f.context.save_launch_api_key('Grok', 'temporary-test-secret');
  assert.ok(!JSON.stringify(state).includes('temporary-test-secret'));
  assert.ok(!JSON.stringify(f.context.launch_options()).includes('temporary-test-secret'));
  assert.ok(!JSON.stringify([...f.storage]).includes('temporary-test-secret'));
  assert.equal(state.launch.profiles.Grok.api_key_ref, 'opaque-key-ref');
  await f.context.load_launch_models('Grok');
  assert.equal(calls.length, 1, 'API discovery is explicit, never automatic');
  await f.context.load_launch_models('Grok', true);
  assert.equal(f.context.launch_model_state('Grok').items[0].value, 'vendor/model.1');
  assert.equal(f.context.launch_model_state('Grok').items[0].label, 'Vendor Model · vendor/model.1');
  f.context.write_launch_field('Grok', 'base_url', 'https://api.x.ai/v1');
  assert.equal(state.launch.profiles.Grok.api_key_ref, undefined);
});

test('API project access stays read-only after switching from CLI, restoring old drafts and invitations', async () => {
  const f = theme_fixture(), state = f.context.test_state, calls = [];
  Object.assign(f.context, { render_launch_settings() {}, render_launch_summaries() {}, refresh_room: async () => {},
    local_launch_request: async (route, payload) => { calls.push(payload); return { free: { members: [] } }; } });
  state.launch.workspace = { cwd: 'C:\\project', project_access: 'write' };
  state.launch.profiles.Codex = { adapter: 'codex_cli', project_access: 'write' };
  assert.equal(f.context.launch_can_set_access('Codex'), true);
  f.context.write_launch_field('Codex', 'adapter', 'api');
  assert.equal(f.context.launch_can_set_access('Codex'), false);
  assert.equal(state.launch.profiles.Codex.project_access, 'read');
  f.context.write_launch_field('Codex', 'project_access', 'write');
  assert.equal(state.launch.profiles.Codex.project_access, 'read');
  state.launch.profiles.Codex.project_access = 'write';
  assert.equal(f.context.launch_access('Codex'), 'read');
  assert.equal(f.context.launch_summary('Codex').access, '项目只读');
  assert.equal(f.context.launch_options().participants.Codex.project_access, 'read');
  state.room = { id: 'one', mode: 'free', free: { members: [] } };
  f.storage.set('discuss-access:one', 'owner-secret');
  await f.context.invite_member({ name: 'Codex', access: 'runner', project_access: 'write' });
  assert.equal(calls[0].participants.Codex.project_access, 'read');
  f.context.write_launch_field('Codex', 'adapter', 'codex_cli');
  f.context.write_launch_field('Codex', 'project_access', 'write');
  assert.equal(f.context.launch_access('Codex'), 'write');
});

/** Exercise the real autocomplete against a native-editor stub and reactive room membership. */
function mention_fixture() {
  const text = ref("");
  const room = ref({ id: "test", host: "用户", experts: { Codex: "cli", Claude: "online" } });
  const free = ref(true);
  const free_members = ref([{ name: "Codex" }, { name: "Claude-评审" }]);
  const editor = { value: "", selectionStart: 0, selectionEnd: 0, focus() {}, setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; } };
  const context = vm.createContext({ computed, ref, watch, nextTick, text, room, free, free_members,
    view: ref({ tab: "messages" }), prompt: ref({ textareaRef: editor }), bridge: { display_name: name => name } });
  const start = discussion_source.indexOf("const mention_context =");
  const end = discussion_source.indexOf("/** End a structured excerpt", start);
  vm.runInContext(discussion_source.slice(start, end) + "\nglobalThis.mention_state = { context: mention_context, members: mention_members, active: mention_active };", context);
  const target = context.prompt.value.textareaRef;
  return { context, room, free, free_members, text, editor: target, state: context.mention_state,
    type(value, caret = value.length, end = caret) {
      text.value = value; target.value = value; target.selectionStart = caret; target.selectionEnd = end;
      context.update_mention({ type: "input", target });
    },
    key(key, options = {}) {
      const event = { key, target, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...options };
      context.mention_keydown(event);
      return event;
    } };
}

test("mention autocomplete excludes email, selected text, code and quotes, and filters current members", () => {
  const fixture = mention_fixture();
  for (const value of ["mail@Co", "`@Co", "```js\n@Co", "> @Co"]) {
    fixture.type(value);
    assert.equal(fixture.state.context.value, null, value);
  }
  fixture.type("@Co", 1, 3);
  assert.equal(fixture.state.context.value, null);
  fixture.type("请查看，@cO");
  assert.deepEqual([...fixture.state.members.value], ["Codex"]);
  fixture.type("@不存在");
  assert.equal(fixture.state.members.value.length, 0);
  fixture.type("@评审");
  assert.deepEqual([...fixture.state.members.value], ["Claude-评审"]);
  fixture.free_members.value = [{ name: "Codex" }];
  assert.equal(fixture.state.members.value.length, 0, "departed members disappear from an open menu");
  fixture.free.value = false;
  fixture.type("@");
  assert.deepEqual([...fixture.state.members.value], ["Codex"], "discussion suggestions still come from the current room roster");
});

test("mention selection replaces the caret token without dropping surrounding draft and supports multiple mentions", async () => {
  const fixture = mention_fixture();
  fixture.type("前文 @Claude 后文", 7);
  await fixture.context.select_mention("Claude-评审");
  assert.equal(fixture.text.value, "前文 @Claude-评审 后文");
  assert.equal(fixture.editor.selectionStart, "前文 @Claude-评审 ".length);
  assert.equal(fixture.state.context.value, null);
  fixture.type("@Codex 请看 @Cl");
  const event = fixture.key("Tab");
  await nextTick();
  assert.equal(event.prevented, true);
  assert.equal(fixture.text.value, "@Codex 请看 @Claude-评审 ");
});

test("mention arrows wrap, Enter selects, Escape dismisses and send modifiers remain available", async () => {
  const fixture = mention_fixture();
  fixture.type("@");
  assert.deepEqual([...fixture.state.members.value], ["全体成员", "Codex", "Claude-评审"], "several free members offer one @全体成员 first");
  fixture.key("ArrowUp");
  assert.equal(fixture.state.active.value, "Claude-评审");
  fixture.key("ArrowDown");
  fixture.key("ArrowDown");
  assert.equal(fixture.state.active.value, "Codex");
  for (const options of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { isComposing: true }, { keyCode: 229 }]) {
    assert.equal(fixture.key("Enter", options).prevented, false);
    assert.equal(fixture.text.value, "@");
  }
  assert.equal(fixture.key("Enter").stopped, true);
  await nextTick();
  assert.equal(fixture.text.value, "@Codex ");
  fixture.type("@");
  assert.equal(fixture.key("Escape").prevented, true);
  fixture.context.update_mention({ type: "keyup", key: "Escape", target: fixture.editor });
  assert.equal(fixture.state.context.value, null, "Escape keyup must not reopen the menu");
  assert.equal(fixture.text.value, "@");
});

test("mention composition and room changes close stale suggestions", async () => {
  const fixture = mention_fixture();
  fixture.type("@");
  fixture.context.mention_composition({ type: "compositionstart", target: fixture.editor });
  fixture.type("@评");
  assert.equal(fixture.state.context.value, null);
  fixture.context.mention_composition({ type: "compositionend", target: fixture.editor });
  assert.equal(fixture.state.active.value, "Claude-评审");
  fixture.room.value.id = "another";
  await nextTick();
  assert.equal(fixture.state.context.value, null);
});

test('message cache keeps rendered prose for messages it already has', () => {
  const message = { id: 7, text: '已保存正文', rendered_text: 'cached-markdown' };
  const state = { messages: [message], room: { free: { requests: [] } } };
  const container = { querySelectorAll: () => [], scrollTop: 0, scrollHeight: 100, clientHeight: 100 };
  const context = vm.createContext({ state, element: () => container, SCROLL_BOTTOM_THRESHOLD: 70, message_markup: () => '',
    window: { discuss_markdown: { render_markdown: () => { throw new Error('Unchanged prose must stay cached'); } } } });
  vm.runInContext(source.match(/function render_messages\(result\) \{[\s\S]*?\n\}/)[0], context);
  context.render_messages({ messages: [message], total: 1, pages: 1 });
  assert.equal(state.messages[0], message);
  assert.equal(state.messages[0].rendered_text, 'cached-markdown');
});

test('free-room answers replace their working card in place instead of jumping ahead of slower members', async () => {
  const messages = [
    { id: 259, author: '用户', created_at: '2026-10-25T15:22:00Z' },
    { id: 260, author: 'DeepSeek', created_at: '2026-10-25T15:23:00Z', execution_id: 3, request_message_id: 259 },
    { id: 261, author: '用户', created_at: '2026-10-25T15:24:00Z' },
  ];
  const members = [execution_member(1), execution_member(2, 'Claude'), execution_member(9, 'Gemini')];
  for (const member of members) member.execution.created_at = 1;
  const executions = [1, 2, 3, 9].map(id => ({ id, member_id: id, status: id === 3 ? 'completed' : 'started',
    request_message_id: id === 9 ? 999 : 259, answer_id: id === 3 ? 260 : null, created_at: 1 }));
  const f = free_card_fixture({ messages, members, executions });
  assert.deepEqual([...f.state.layout.value].map(item => item.id), [259, 'free-1', 'free-2', 260, 261, 'free-9'],
    'the first answer keeps the third slot; work for an unshown request stays at the end');
  for (const member of f.room.free.members) member.execution.status = 'completed';
  await nextTick();
  assert.deepEqual([...f.state.layout.value].map(item => item.id), [259, 260, 261], 'answers settle without moving');
  f.room.free.executions.push(
    { id: 4, member_id: 4, member: 'Gemini', status: 'failed', request_message_id: 259, created_at: 1, finished_at: 9, result: '会话已结束' },
    { id: 5, member_id: 4, member: 'Gemini', status: 'failed', request_message_id: 999, created_at: 1, finished_at: 9 });
  await nextTick();
  assert.deepEqual([...f.state.layout.value].map(item => item.id), [259, 260, 'failed-4', 261],
    'a failure keeps its slot under the request; one whose request is not shown is dropped');
});

test('a fork keeps history up to its message and lists the executions each member branches before', () => {
  const context = vm.createContext({});
  vm.runInContext(source.match(/function fork_snapshot\([\s\S]*?\n\}/)[0], context);
  const snapshot = { format: 'ai-codiscuss-room-backup', version: 1, tables: {
    rooms: [{ id: 'old', title: '原房间', goal: 'g', created_at: 'then', state_text: '覆盖到 #6', state_until: 6 }],
    room_directory: [{ room_id: 'old', archived: 1 }],
    room_members: [{ id: 1, name: 'Claude', read_until: 6 }, { id: 2, name: 'Codex', read_until: 2 }],
    messages: [1, 2, 3, 4, 5, 6].map(id => ({ id, author: id % 2 ? '用户' : 'Claude', text: `#${id}` })),
    message_withdrawals: [{ message_id: 3, kind: 'retracted' }],
    message_details: [{ message_id: 2 }, { message_id: 6 }],
    room_briefs: [{ until: 2 }],
    member_requests: [
      { id: 1, member_id: 1, message_id: 1, execution_id: 10, answer_id: 2, status: 'completed' },
      { id: 2, member_id: 1, message_id: 4, execution_id: 11, answer_id: 6, status: 'completed' },
      { id: 3, member_id: 2, message_id: 4, execution_id: 12, answer_id: null, status: 'delivering' },
      { id: 4, member_id: 2, message_id: 5, execution_id: 13, answer_id: null, status: 'failed' }] } };
  const { body, executions } = context.fork_snapshot(snapshot, 4, 'new', 'now');
  const tables = body.tables;
  assert.deepEqual([...tables.messages].map(row => row.id), [1, 2, 4]);
  assert.deepEqual([tables.rooms[0].id, tables.rooms[0].title, tables.rooms[0].state_text, tables.room_directory[0].archived], ['new', '原房间（分支）', '', 0]);
  assert.deepEqual([...tables.member_requests].map(row => [row.id, row.status, row.answer_id]), [[1, 'completed', 2], [2, 'cancelled', null], [3, 'delivering', null]]);
  assert.deepEqual([...tables.message_details].map(row => row.message_id), [2]);
  assert.equal(tables.room_briefs.length, 1);
  assert.deepEqual([...tables.room_members].map(row => row.read_until), [4, 2]);
  assert.deepEqual(JSON.parse(JSON.stringify(executions)), { Claude: [11], Codex: [12, 13] });
});

test("a session fork keeps system provenance but truncates future plans, answers and state", () => {
  const context = vm.createContext({});
  vm.runInContext(source.match(/function fork_snapshot\([\s\S]*?\n\}/)[0], context);
  const snapshot = { format: "ai-codiscuss-room-backup", version: 2, tables: {
    rooms: [{ id: "old", title: "原房间", goal: "目标", state_text: "未来状态", state_until: 4, created_at: "then" }],
    room_directory: [{ room_id: "old", archived: 0 }], room_members: [{ id: 1, name: "Codex", read_until: 8 }],
    messages: [
      { id: 1, author: "用户", text: "问题", created_at: "2026-10-16T10:00:00Z" },
      { id: 2, author: "用户", text: "系统任务", created_at: "2026-10-16T10:01:00Z" },
      { id: 3, author: "用户", text: "另一系统任务", created_at: "2026-10-16T10:02:00Z" },
      { id: 4, author: "Codex", text: "未来回答", created_at: "2026-10-16T10:03:00Z" },
      { id: 5, author: "用户", text: "后续消息", created_at: "2026-10-16T10:04:00Z" },
    ],
    message_withdrawals: [], message_details: [], message_summaries: [], message_timings: [], attachments: [],
    room_briefs: [{ until: 3, text: "未来简报", updated_at: "2026-10-16T10:03:00Z" }],
    member_requests: [
      { id: 201, member_id: 1, message_id: 2, answer_id: null, execution_id: 901, status: "delivering" },
      { id: 202, member_id: 1, message_id: 3, answer_id: 4, execution_id: 902, status: "completed" },
      { id: 203, member_id: 1, message_id: 5, answer_id: null, execution_id: 903, status: "pending" },
    ],
    discussion_turns: [], discussion_sessions: [
      { id: 10, room_id: "old", goal: "本次目标", status: "active", started_message_id: 1, ended_message_id: 0, created_at: "2026-10-16T10:00:00Z" },
      { id: 11, room_id: "old", goal: "未来目标", status: "concluded", started_message_id: 4, ended_message_id: 4, created_at: "2026-10-16T10:03:00Z" },
    ],
    discussion_conclusions: [{ session_id: 10, room_id: "old", state: "未来状态", state_until: 3, brief: "未来简报", concluded_at: "2026-10-16T10:03:00Z" }],
    session_requests: [
      { id: 100, session_id: 10, member_id: 1, member_request_id: 201, purpose: "discuss", round: 1, position: 1,
        status: "open", submission_id: "open", question: "已发出的安排", created_at: "2026-10-16T10:01:00Z" },
      { id: 101, session_id: 10, member_id: 1, member_request_id: 202, purpose: "discuss", round: 1, position: 2,
        status: "answered", submission_id: "answered-later", question: "未来回答安排", created_at: "2026-10-16T10:02:00Z" },
      { id: 102, session_id: 10, member_id: 1, member_request_id: null, purpose: "discuss", round: 2, position: 1,
        status: "queued", submission_id: "future-queued", question: "未来排队安排", created_at: "2026-10-16T10:03:00Z" },
    ],
    task_message_sources: [{ message_id: 2, session_id: 10, session_request_id: 100, cause_kind: "user_message",
      cause_message_id: 5, cause_request_id: 203 },
    { message_id: 3, session_id: 10, session_request_id: 101, cause_kind: "speaker_answered", cause_message_id: 1, cause_request_id: 201 }],
    session_state: [{ session_id: 10, phase: "initial", revision: 5, read_until: 8, held_since: 99 }],
    session_limits: [{ session_id: 10, max_rounds: 4, max_minutes: 60, execution_minutes: 0, started_at: 1 }],
    session_round_budgets: [{ session_id: 10, base: 2, cap: 4, extra: 1 }],
    session_options: [{ session_id: 10, named_followup: 1 }],
    session_pauses: [{ session_id: 10, paused_at: 99, paused_seconds: 10 }],
  } };
  const { body, executions } = context.fork_snapshot(snapshot, 3, "new", "2026-10-16T11:00:00Z");
  const tables = body.tables;
  assert.deepEqual(tables.messages.map(row => row.id), [1, 2, 3], "system messages remain in history with their source rows");
  assert.deepEqual(tables.task_message_sources.map(row => [row.message_id, row.session_request_id, row.cause_message_id, row.cause_request_id]),
    [[2, 100, null, null], [3, 101, 1, 201]], "out-of-range cause references are cleared and in-range references survive");
  assert.deepEqual(tables.discussion_sessions.map(row => [row.id, row.status, row.ended_message_id]), [[10, "concluded", 3]]);
  assert.deepEqual(tables.session_requests.map(row => [row.id, row.status, row.member_request_id]),
    [[100, "cancelled", 201], [101, "cancelled", 202]], "open/queued work stops, and an answer after the fork is not carried over");
  assert.deepEqual(tables.member_requests.map(row => [row.id, row.status, row.answer_id]),
    [[201, "cancelled", null], [202, "cancelled", null]], "active requests stop and future answers are removed");
  assert.deepEqual(tables.discussion_conclusions.map(row => [row.session_id, row.state, row.state_until, row.brief]), [[10, "", 0, ""]],
    "future conclusion state is not copied into the fork");
  assert.deepEqual(tables.session_state.map(row => [row.read_until, row.held_since]), [[3, 0]]);
  assert.deepEqual(tables.session_pauses.map(row => [row.paused_at, row.paused_seconds]), [[0, 10]]);
  assert.deepEqual(tables.room_briefs, []);
  assert.deepEqual(JSON.parse(JSON.stringify(executions)), { Codex: [901, 902, 903] });
});

test('rewound messages fold into their first line until expanded, and work on them leaves the transcript', () => {
  const messages = [
    { id: 1, author: '用户', created_at: '2026-10-28T10:00:00Z' },
    { id: 2, author: '用户', created_at: '2026-10-28T10:01:00Z', withdrawn: 'rewound' },
    { id: 3, author: 'Claude', created_at: '2026-10-28T10:02:00Z', withdrawn: 'rewound', execution_id: 5, request_message_id: 2 },
    { id: 4, author: '用户', created_at: '2026-10-28T10:03:00Z', withdrawn: 'retracted' },
    { id: 5, author: '用户', created_at: '2026-10-28T10:04:00Z' },
  ];
  const f = free_card_fixture({ messages, executions: [
    { id: 6, member_id: 1, member: 'Claude', status: 'failed', request_message_id: 2, created_at: 1, finished_at: 2 }] });
  assert.deepEqual([...f.state.layout.value].map(item => item.id), [1, 2, 4, 5], 'the run folds into #2 and its failed work is not shown');
  assert.equal(f.state.rewinds.value.runs.get(2), 2);
  f.state.toggle(2);
  assert.deepEqual([...f.state.layout.value].map(item => item.id), [1, 2, 3, 4, 5], 'expanding lists every rewound line in place');
});

test('the rail shows the newest unanswered user request as the current task and hides it once all are answered', () => {
  const board_source = readFileSync(new URL("../frontend/FreeBoard.vue", import.meta.url), "utf8");
  const requests = [
    { message_id: 1, created_by: 'user', status: 'completed' },
    { message_id: 2, created_by: 'user', status: 'pending' },
    { message_id: 3, created_by: 'host', status: 'delivering' },
  ];
  const free = ref({ requests });
  const view = ref({ messages: [{ id: 1, text: '有人在吗' }, { id: 2, text: '改一下按钮' }] });
  const context = vm.createContext({ computed, ref, free, view, room: ref({ withdrawals: [] }) });
  const start = board_source.indexOf('const live_requests = computed(');
  const end = board_source.indexOf('const task_expanded =', start);
  vm.runInContext(board_source.slice(start, end).replace(/const meters = computed\([\s\S]*?\n\}\);\n/, '') + '\nglobalThis.task = task;', context);
  assert.equal(context.task.value, '改一下按钮', 'a request the host passed on is not the user\'s task');
  requests[1].status = 'completed';
  free.value = { requests: [...requests] };
  assert.equal(context.task.value, '', 'nothing is shown once every user request is answered');
});

test('execution reports bind answers and failed requests and distinguish unknown file changes', () => {
  const room = ref({ free: { executions: [
    { id: 1, status: 'completed', answer_id: 8, request_message_id: 4, request_ids: [1, 2], created_at: 10, finished_at: 22, changes_recorded: true, changes: ['index.html'] },
    { id: 2, status: 'failed', answer_id: null, request_message_id: 9, request_ids: [3], created_at: 10, finished_at: 30, changes_recorded: false, changes: [] },
    { id: 3, status: 'completed', answer_id: 11, request_message_id: 10, request_ids: [4], created_at: 10, finished_at: 30, changes_recorded: true, changes: [] },
    { id: 4, status: 'started', request_message_id: 12 },
  ] } });
  const context = vm.createContext({ computed, ref, room, free: ref(true) });
  const start = discussion_source.indexOf('const execution_reports = computed(');
  const end = discussion_source.indexOf("/** A user's message is waiting for the host", start);
  vm.runInContext(discussion_source.slice(start, end) + '\nglobalThis.reports = execution_reports;', context);
  const reports = context.reports.value;
  // Only observed file changes earn a report under the answer; a clean completion adds nothing.
  assert.deepEqual([...reports.get(8)[0].changes], ['index.html']);
  assert.equal(reports.get(8)[0].label, '已完成');
  assert.equal(reports.has(11), false);
  // A failed free-room execution keeps its own failure card in place, so it is not repeated as a report.
  assert.equal(reports.has(9), false);
  assert.equal(reports.has(12), false);
  assert.match(discussion_source, /v-for="report in execution_reports.get\(message.id\)/);
  assert.match(discussion_source, /文件变化：\{\{ report.changes.join/);
});

/** Drive page subscriptions and timers without polling a live discussion. */
function update_fixture() {
  const fixture = theme_fixture(), { context } = fixture;
  const timers = new Map(), sources = [], reads = [], connections = [];
  let timer_id = 0;
  context.document.hidden = false;
  context.EventSource = class {
    constructor(url) { this.url = url; this.listeners = new Map(); sources.push(this); }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    emit(name) { this.listeners.get(name)?.(); }
    close() { this.closed = true; }
  };
  context.setTimeout = (callback, delay) => { timers.set(++timer_id, { callback, delay }); return timer_id; };
  context.clearTimeout = id => timers.delete(id);
  context.refresh_room = async () => { reads.push(context.test_state.room?.id); };
  context.set_connection = value => connections.push(value);
  return { ...fixture, timers, sources, reads, connections, async run(delay) {
    const timer = [...timers].find(([, item]) => item.delay === delay);
    assert.ok(timer, `missing ${delay}ms timer`);
    timers.delete(timer[0]);
    await timer[1].callback();
  } };
}

test("push batches bursts, keeps an in-flight invalidation and polls healthy streams only every minute", async () => {
  const f = update_fixture();
  f.context.start_live_updates();
  assert.equal(f.sources[0].url, "/api/updates");
  f.sources[0].emit("open");
  f.sources[0].emit("ready");
  for (let count = 0; count < 10; count++) f.sources[0].emit("change");
  assert.deepEqual([...f.timers.values()].map(item => item.delay).sort((left, right) => left - right), [100, 60000]);
  let finish;
  f.context.refresh_room = () => new Promise(resolve => { finish = resolve; });
  const reading = f.run(100);
  f.sources[0].emit("change");
  f.sources[0].emit("change");
  finish();
  await reading;
  f.context.refresh_room = async () => { f.reads.push("latest"); };
  await f.run(100);
  assert.equal(f.reads.length, 1);
  await f.run(60000);
  await f.run(100);
  assert.equal(f.reads.length, 2);
});

test("hidden pages close streams and catch up on return without accepting the previous stream", async () => {
  const f = update_fixture();
  f.context.start_live_updates();
  const first = f.sources[0];
  f.context.document.hidden = true;
  f.context.stop_live_updates();
  assert.equal(first.closed, true);
  assert.equal(f.timers.size, 0);
  first.emit("change");
  assert.equal(f.timers.size, 0);
  f.context.document.hidden = false;
  f.context.test_state.room = { id: "new-room" };
  f.context.start_live_updates();
  f.sources[1].emit("ready");
  await f.run(100);
  assert.deepEqual(f.reads, ["new-room"]);
  first.emit("open");
  assert.ok([...f.timers.values()].some(item => item.delay === 12000), "an obsolete connection cannot mark the new one healthy");
});

test("unavailable or broken push retains polling and reconnect fetches missed changes", async () => {
  for (const supported of [false, true]) {
    const f = update_fixture();
    if (!supported) f.context.EventSource = undefined;
    f.context.start_live_updates();
    if (supported) {
      f.sources[0].emit("open");
      f.sources[0].emit("error");
      const scheduled = [...f.timers.keys()];
      for (let count = 0; count < 4; count++) f.sources[0].emit("error");
      assert.deepEqual([...f.timers.keys()], scheduled, "reconnection failures cannot postpone fallback polling forever");
    }
    await f.run(100);
    await f.run(12000);
    await f.run(100);
    assert.equal(f.reads.length, 2);
    if (supported) {
      f.sources[0].emit("open");
      f.sources[0].emit("ready");
      await f.run(100);
      assert.equal(f.reads.length, 3);
    }
  }
});

test("push defers during a directory drag and failed refreshes can recover", async () => {
  const f = update_fixture();
  f.context.test_state.dragged_room = "dragging";
  f.context.start_live_updates();
  await f.run(100);
  assert.equal(f.reads.length, 0);
  f.context.test_state.dragged_room = null;
  f.context.refresh_room = async () => { throw new Error("offline"); };
  await f.run(500);
  assert.deepEqual(f.connections, [false]);
  f.context.refresh_room = async () => f.reads.push("recovered");
  f.sources[0].emit("change");
  await f.run(100);
  assert.deepEqual(f.reads, ["recovered"]);
});

/** Exercise shared attachment submission and draft lifetime without a live service. */
function attachment_fixture() {
  const nodes = new Map(), posts = [], uploads = [], revoked = [];
  const element = id => {
    if (!nodes.has(id)) nodes.set(id, { value: "", setAttribute() {} });
    return nodes.get(id);
  };
  element("message-kind").value = "opinion";
  element("author-select").value = "用户";
  const state = { room: { id: "one", host: "Codex" }, attachment_drafts: [] };
  let identifier = 0, fail = true;
  const context = vm.createContext({ state, element, MAX_MESSAGE_LENGTH: 30000, MAX_SUMMARY_LENGTH: 1000,
    MAX_MESSAGE_ATTACHMENTS: 10, MAX_ATTACHMENT_BYTES: 20 * 1024 * 1024, URLSearchParams,
    is_web_member: member => member?.manual_source === "web" || member?.access === "online",
    new_submission_id: () => String(++identifier), escape_html: text => text,
    URL: { createObjectURL: () => "blob:test", revokeObjectURL: url => revoked.push(url) },
    localStorage: { getItem: () => null }, admin_headers: () => ({}), publish_view() {}, show_toast() {}, cancel_reply() {}, cancel_turn_reply() {},
    refresh_room: async () => {},
    fetch: async (url, options) => { uploads.push([url, options]); return { ok: true, json: async () => ({ attachment: { id: "a".repeat(32) } }) }; },
    request_json: async (url, payload) => {
      posts.push([url, payload]);
      if (fail) throw new Error("连接中断");
      return { message: { id: 1 } };
    } });
  vm.runInContext(source.slice(source.indexOf("function message_payload("), source.indexOf("/** Render immutable file cards")), context);
  return { context, state, element, posts, uploads, revoked, succeed() { fail = false; } };
}

test("attachment rendering separates images from files and keeps preview capability tied to content type", () => {
  const { context } = theme_fixture();
  const file = { id: "one", room_id: "room", file_name: '设计"<图>.png', size: 1024, content_type: "image/png" };
  const image = context.attachment_markup([file]);
  assert.match(image, /class="attachment-image"/);
  assert.match(image, /data-preview-attachment="one"/);
  assert.match(image, /alt="设计&quot;&lt;图&gt;\.png"/);
  assert.doesNotMatch(image, /attachment-file|attachment-name|<small>/);
  const pdf = context.attachment_markup([{ ...file, file_name: "方案.pdf", content_type: "application/pdf" }]);
  assert.match(pdf, /class="attachment-file"/);
  assert.match(pdf, /data-preview-attachment="one"/);
  assert.match(pdf, /href="\/api\/rooms\/room\/attachments\/one\/content\?download=1"/);
  const binary = context.attachment_markup([{ ...file, content_type: "application/octet-stream" }]);
  assert.match(binary, /class="attachment-file-main" href=/);
  assert.doesNotMatch(binary, /data-preview-attachment|<img/);
  assert.match(binary, /title="设计&quot;&lt;图&gt;\.png"/);
});

test("a free-room draft names everyone with @全体成员 for smart scheduling to order, and one after another with @全体依次", () => {
  const { context, state, element } = attachment_fixture();
  state.room.mode = "free";
  state.room.free = { members: [{ name: "Claude", status: "active" }, { name: "Codex", status: "active" }] };
  element("message-input").value = "@全体成员 打个招呼";
  assert.deepEqual([Array.from(context.message_payload().to), context.message_payload().sequential, context.message_payload().order], [["Claude", "Codex"], undefined, "auto"]);
  element("message-input").value = "@全体依次 轮流说说";
  assert.deepEqual([Array.from(context.message_payload().to), context.message_payload().sequential, context.message_payload().order], [["Claude", "Codex"], true, undefined]);
  element("message-input").value = "@all-seq go";
  assert.equal(context.message_payload().sequential, true);
});

test("a discussion draft names active members it @mentions outside code as direct questions", () => {
  const { context, state, element } = attachment_fixture();
  state.room.members = [{ name: "Claude", status: "active" }, { name: "Gemini", status: "away" }, { name: "Codex", status: "active" }];
  element("message-input").value = "@Claude 你怎么看？ @Gemini 在吗";
  assert.deepEqual(Array.from(context.message_payload().to), ["Claude"]);
  element("message-input").value = "没有点名，`@Codex` 只是引用";
  assert.equal(context.message_payload().to, undefined);
});

test("a live free-room discussion disables group @ routing but keeps personal questions", () => {
  const { context, state, element } = attachment_fixture();
  state.room.mode = "free";
  state.room.session = { id: 8, status: "active" };
  state.room.free = { members: [{ name: "Claude", status: "active", access: "manual", manual_source: "web" },
    { name: "Codex", status: "active", access: "runner" }] };
  element("message-input").value = "@全体成员 请依次回答";
  assert.equal(context.message_payload().to, undefined);
  element("message-input").value = "@Claude 请补充一下";
  assert.deepEqual(Array.from(context.message_payload().to), ["Claude"]);
});

test("web-member answers bind one pending discussion request before an ordinary ask", () => {
  const { context, state, element } = attachment_fixture();
  state.room.mode = "free";
  state.room.free = { members: [{ name: "Claude", status: "active", access: "manual", manual_source: "web" }], requests: [
    { id: 12, member: "Claude", purpose: "discuss_host", status: "pending" },
    { id: 13, member: "Claude", purpose: "ask", status: "pending" },
    { id: 14, member: "Claude", purpose: "discuss", status: "pending" },
    { id: 15, member: "Claude", purpose: "all", status: "pending" },
    { id: 16, member: "Claude", purpose: "ask", status: "completed" },
    { id: 17, member: "Gemini", purpose: "all", status: "pending" },
  ] };
  context.state.free_proxy = "Claude";
  element("message-input").value = "真实回答";
  assert.deepEqual(Array.from(context.message_payload().request_ids), [14]);
  state.room.free.requests = state.room.free.requests.filter(request => request.id !== 14);
  assert.deepEqual(Array.from(context.message_payload().request_ids), [13, 15]);
  state.room.free.requests = [{ id: 15, member: "Claude", purpose: "all", status: "pending" }];
  assert.deepEqual(Array.from(context.message_payload().request_ids), [15]);
  state.room.free.requests = [{ id: 15, member: "Claude", purpose: "discuss_host", status: "pending" }];
  assert.throws(() => context.message_payload(), /没有可代发的待处理请求/);
});

test("the relay identity menu excludes registered local manual members", () => {
  const room = ref({ free: { members: [
    { name: "Claude", status: "active", access: "manual", registered_at: 123 },
    { name: "Gemini", status: "active", access: "manual", manual_source: "web" },
    { name: "DeepSeek", status: "active", access: "online" },
    { name: "Qwen", status: "away", access: "manual", manual_source: "web" },
    { name: "Codex", status: "active", access: "runner" },
  ] } });
  const context = vm.createContext({ room, computed });
  const start = discussion_source.indexOf("const free_members = computed(");
  const end = discussion_source.indexOf("/** In a discussion, an @mention", start);
  vm.runInContext(`${discussion_source.slice(start, end)}\nglobalThis.proxy_members = proxy_members;`, context);
  assert.deepEqual(Array.from(context.proxy_members.value, member => member.name), ["Gemini", "DeepSeek"]);
});

test("web relay preserves the answer summary and its actual author", () => {
  const { context, state, element } = attachment_fixture();
  state.room.mode = "free";
  state.room.free = { members: [{ name: "Gemini", status: "active", access: "manual", manual_source: "web" }],
    requests: [{ id: 18, member: "Gemini", purpose: "ask", status: "pending" }] };
  state.free_proxy = "Gemini";
  element("message-input").value = "完整回答和依据";
  element("message-summary").value = "  原回答的摘要  ";
  element("message-summary-source").value = "author";
  let payload = context.message_payload();
  assert.deepEqual([payload.author, payload.submitted_by, payload.text, payload.summary, payload.summary_by],
    ["Gemini", "用户", "完整回答和依据", "原回答的摘要", "Gemini"]);
  element("message-summary-source").value = "submitter";
  payload = context.message_payload();
  assert.equal(payload.summary_by, "用户");
  element("message-summary").value = "长".repeat(1001);
  assert.throws(() => context.message_payload(), /回答摘要最多 1000 字/);
});

test("an invalid relay selection cannot silently publish the answer as the user", async () => {
  const fixture = attachment_fixture(), { context, state, element } = fixture;
  state.room.mode = "free";
  state.room.free = { members: [{ name: "Claude", status: "active", access: "manual", registered_at: 123 }], requests: [] };
  state.free_proxy = "Claude";
  element("message-input").value = "本地成员的回答草稿";
  await assert.rejects(context.send_message({ preventDefault() {} }), /网页成员/);
  assert.equal(fixture.posts.length, 0);
  assert.equal(element("message-input").value, "本地成员的回答草稿");
  state.room.free.members = [{ name: "Claude", status: "away", access: "manual", manual_source: "web" }];
  assert.throws(() => context.message_payload(), /网页成员/);
});

test("attachment retries retain files and reuse both upload and message receipts", async () => {
  const fixture = attachment_fixture(), { context, state, uploads, posts } = fixture;
  context.add_attachments([{ name: "截图.png", size: 10, type: "image/png" }]);
  await assert.rejects(context.send_message({ preventDefault() {} }), /连接中断/);
  assert.equal(state.attachment_drafts.length, 1);
  assert.match(state.composer_error, /草稿已保留/);
  const first_id = posts[0][1].submission_id;
  fixture.succeed();
  await context.send_message({ preventDefault() {} });
  assert.equal(uploads.length, 1);
  assert.equal(posts[1][1].submission_id, first_id);
  assert.equal(posts[1][1].text, "", "files-only messages are submitted");
  assert.equal(state.attachment_drafts.length, 0);
  assert.deepEqual(fixture.revoked, ["blob:test"]);
});

test("saved old drafts cannot clear a new composer after navigating away and back", async () => {
  const fixture = attachment_fixture(), { context, state, element } = fixture;
  context.add_attachments([{ name: "旧.txt", size: 10, type: "text/plain" }]);
  let finish;
  context.request_json = () => new Promise(resolve => { finish = resolve; });
  const pending = context.send_message({ preventDefault() {} });
  while (!finish) await Promise.resolve();
  context.clear_attachment_drafts();
  state.attachment_drafts.push({ id: "new", file: { name: "新.txt", size: 1 } });
  element("message-input").value = "新的正文";
  finish({ message: { id: 1 } });
  await pending;
  assert.equal(element("message-input").value, "新的正文");
  assert.equal(state.attachment_drafts[0].id, "new");
});

test("attachment selection enforces count and size without consuming ordinary clipboard text", () => {
  const { context, state } = attachment_fixture();
  context.add_attachments([{ name: "大文件", size: 20 * 1024 * 1024 + 1 }]);
  assert.equal(state.attachment_drafts.length, 0);
  assert.match(state.composer_error, /20 MiB/);
  context.add_attachments(Array.from({ length: 11 }, () => ({ name: "文件", size: 1 })));
  assert.equal(state.attachment_drafts.length, 0);
  let prevented = 0;
  context.paste_attachments({ clipboardData: { files: [] }, preventDefault() { prevented++; } });
  assert.equal(prevented, 0);
  context.paste_attachments({ clipboardData: { files: [{ name: "截图", size: 1, type: "image/png" }] }, preventDefault() { prevented++; } });
  assert.equal(prevented, 1);
  assert.equal(state.attachment_drafts.length, 1);
});

test("changing the uploader never reuses an earlier actor's receipt after upload failure", async () => {
  const { context, state, uploads } = attachment_fixture();
  context.add_attachments([{ name: "文件", size: 1 }]);
  await context.upload_message_attachments("one", "用户", state.attachment_drafts);
  const original_fetch = context.fetch;
  context.fetch = async () => { throw new Error("断线"); };
  await assert.rejects(context.upload_message_attachments("one", "Codex", state.attachment_drafts), /断线/);
  assert.equal(state.attachment_drafts[0].uploaded, null);
  const submission = state.attachment_drafts[0].upload_submission;
  context.fetch = original_fetch;
  await context.upload_message_attachments("one", "Codex", state.attachment_drafts);
  assert.equal(uploads.length, 2);
  assert.equal(state.attachment_drafts[0].upload_submission, submission);
});

/** Run card face/focus transitions independently of the spring's browser clock. */
function expert_card_fixture() {
  const props = reactive({ name: "Codex", mode: "cli", choices: [], status: {} });
  const view = ref({ launch: { profiles: { Codex: { adapter: "codex_cli", model: "saved-model", effort: "high" } } } });
  const reduced = ref(false), calls = [], cleanups = [], listeners = new Set(), document = { activeElement: null, addEventListener() {}, removeEventListener() {} };
  const angle = { set: (target) => calls.push(["set", target]), jump(target) { calls.push(["jump", target]); this.advance(target); },
    on: (event, callback) => { const listener = { event, callback }; listeners.add(listener); return () => listeners.delete(listener); },
    advance: (position) => listeners.forEach(({ event, callback }) => event === "change" && callback(position)),
    complete: () => listeners.forEach(({ event, callback }) => event === "animationComplete" && callback()),
    stop: () => calls.push(["stop"]) };
  const reads = [];
  const bridge = { launch_clients: { Codex: [{ value: "codex_cli", label: "Codex CLI" }, { value: "codex", label: "Codex App" }] },
    launch_can_set_access: (name, launch) => ['codex_cli', 'claude', 'antigravity_cli'].includes(launch.profiles[name]?.adapter),
    launch_model_state: (name, launch) => ({ supported: launch.profiles[name]?.adapter === "codex_cli", efforts: ["low", "high"] }),
    load_launch_models: name => reads.push(name),
    write_launch: (name, field, value) => { view.value.launch.profiles[name][field] = value; },
    restore_launch_profile: (name, profile) => { view.value.launch.profiles[name] = profile; },
    description_draft: () => "" };
  const context = vm.createContext({ computed, ref, nextTick, defineProps: () => props, defineEmits: () => () => {}, access_label, access_options,
    inject: () => ({ view, bridge }), useSpring: () => angle, useReducedMotion: () => reduced, document,
    watch: (...args) => { const stop = watch(...args); cleanups.push(stop); return stop; },
    onBeforeUnmount: (callback) => cleanups.push(callback) });
  const component = readFileSync(new URL("../frontend/ExpertCard.vue", import.meta.url), "utf8");
  vm.runInContext(component.match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import .*;$/gm, "")
    + "\nglobalThis.card_refs = { card, front_button, back_button, back, visible_back };", context);
  const refs = context.card_refs;
  for (const name of ["card", "front_button", "back_button"]) {
    refs[name].value = { focus() { document.activeElement = refs[name].value; } };
  }
  return { context, props, view, reduced, angle, refs, document, calls, listeners, reads,
    cleanup: () => cleanups.forEach((callback) => callback()) };
}

test('every CLI lines up the same four access levels, with agy 自动 shown but disabled', () => {
  const shown = adapter => access_options(adapter).map(option => `${option.label}${option.disabled ? '×' : ''}`);
  assert.deepEqual(shown('claude'), ['只读', '可写', '自动', '全放开']);
  assert.deepEqual(shown('antigravity_cli'), ['只读', '可写', '自动×', '全放开']);
  assert.match(access_options('antigravity_cli')[2].hint, /后台运行（-p）不支持/);
});

test('expert card offers project permissions only for CLI and shows that API and web experts never see project files', () => {
  const f = expert_card_fixture();
  const project = () => vm.runInContext('facts.value.find(fact => fact.label === "项目")?.value', f.context);
  f.view.value.launch.workspace = { project_access: 'write' };
  assert.equal(vm.runInContext('sets_access.value', f.context), true);
  f.view.value.launch.profiles.Codex = { adapter: 'api', project_access: 'write' };
  assert.equal(vm.runInContext('sets_access.value', f.context), false);
  assert.equal(project(), '不访问');
  f.view.value.launch.profiles.Codex.adapter = 'codex';
  assert.equal(vm.runInContext('sets_access.value', f.context), false);
  assert.equal(project(), undefined, 'an App keeps its own file permissions, so the front shows no placeholder');
  assert.ok(vm.runInContext('connection.value.length', f.context) > 0, 'App connection fields remain available');
  f.props.mode = 'online';
  assert.equal(project(), '不访问');
  f.cleanup();
});

test("expert card exposes one face and hands focus over only after crossing the edge", async () => {
  const fixture = expert_card_fixture();
  const { context, refs, angle, document, calls } = fixture;
  context.flip(true);
  await nextTick();
  assert.deepEqual(calls, [["set", 180]]);
  angle.advance(89);
  assert.equal(refs.visible_back.value, false);
  angle.advance(91);
  await nextTick();
  assert.equal(refs.visible_back.value, true);
  assert.equal(document.activeElement, refs.back_button.value);
  let stopped = 0;
  context.escape({ stopPropagation() { stopped++; }, preventDefault() {} });
  await nextTick();
  assert.equal(stopped, 1);
  assert.deepEqual(calls.at(-1), ["set", 0], "reversal retargets the same spring without jumping");
  angle.advance(89);
  await nextTick();
  assert.equal(document.activeElement, refs.front_button.value);
  context.escape({ stopPropagation() { stopped++; } });
  assert.equal(stopped, 1, "Escape on the front remains available to the enclosing dialog");
  context.flip(true);
  await nextTick();
  angle.advance(30);
  context.flip(false);
  await nextTick();
  angle.advance(0);
  angle.complete();
  await nextTick();
  assert.equal(document.activeElement, refs.front_button.value, "a reversal before halfway still restores focus");
  fixture.cleanup();
  assert.equal(fixture.listeners.size, 0);
});

test("expert card still flips under reduced motion and keeps manual and online faces accessible without exposing launch overrides", async () => {
  const fixture = expert_card_fixture();
  fixture.reduced.value = true;
  fixture.context.flip(true);
  await nextTick();
  assert.deepEqual(fixture.calls.at(-1), ["set", 180], "the flip plays even when the system asks for reduced motion");
  fixture.angle.advance(180);
  await nextTick();
  assert.equal(fixture.refs.visible_back.value, true);
  fixture.props.mode = "manual";
  await nextTick();
  assert.equal(fixture.refs.back.value, true);
  assert.equal(fixture.refs.visible_back.value, true);
  assert.equal(vm.runInContext("configurable.value", fixture.context), false);
  fixture.props.mode = "online";
  assert.equal(vm.runInContext("can_flip.value", fixture.context), false, "manual and web cards have nothing to configure on a back face");
  fixture.props.mode = "cli";
  fixture.props.mode = "cli";
  fixture.view.value.launch.profiles.Codex.adapter = "codex";
  assert.equal(vm.runInContext("configurable.value", fixture.context), false);
  assert.match(vm.runInContext("configuration_note.value", fixture.context), /App 原聊天/);
  assert.equal(fixture.view.value.launch.profiles.Codex.model, "saved-model");
  assert.equal(fixture.view.value.launch.profiles.Codex.effort, "high");
  fixture.cleanup();
});

test("card defaults reset only the current instance and Escape returns directly to its front", async () => {
  const fixture = expert_card_fixture(), { context, view } = fixture;
  view.value.launch.profiles.Claude = { model: "other-model", effort: "low" };
  context.flip(true);
  context.escape({ stopPropagation() {}, preventDefault() {} });
  assert.equal(fixture.refs.back.value, false);
  context.reset_model();
  assert.equal(view.value.launch.profiles.Codex.model, "");
  assert.equal(view.value.launch.profiles.Codex.effort, "");
  assert.equal(view.value.launch.profiles.Claude.model, "other-model");
  assert.equal(view.value.launch.profiles.Claude.effort, "low");
  await nextTick();
  fixture.cleanup();
});

test("card Cancel restores the settings from when the back opened while Done keeps edits", async () => {
  const fixture = expert_card_fixture(), { context, view, refs } = fixture;
  context.flip(true);
  view.value.launch.profiles.Codex.model = "other-model";
  view.value.launch.profiles.Codex.project_access = "write";
  context.cancel();
  assert.equal(refs.back.value, false);
  assert.equal(view.value.launch.profiles.Codex.model, "saved-model");
  assert.equal("project_access" in view.value.launch.profiles.Codex, false, "a field that was never set stays unset");
  context.flip(true);
  view.value.launch.profiles.Codex.effort = "low";
  context.escape({ stopPropagation() {}, preventDefault() {} });
  assert.equal(view.value.launch.profiles.Codex.effort, "high", "Escape cancels like the Cancel button");
  context.flip(true);
  view.value.launch.profiles.Codex.model = "kept-model";
  context.flip(false);
  assert.equal(view.value.launch.profiles.Codex.model, "kept-model");
  await nextTick();
  fixture.cleanup();
});

test("each automatic CLI card sets its own project access and asks only for a missing connection", async () => {
  const fixture = expert_card_fixture(), { context, view, props } = fixture;
  const fact = label => vm.runInContext("facts.value", context).find(item => item.label === label)?.value;
  assert.equal(fact("项目"), "只读");
  view.value.launch.profiles.Codex.project_access = "write";
  assert.equal(fact("项目"), "可写");
  props.mode = "online";
  assert.equal(fact("项目"), "不访问", "web members never see project files");
  props.mode = "cli";
  props.mode = "manual";
  assert.equal(fact("项目"), undefined, "manual sessions keep the permissions of their own software, so no placeholder row");
  props.mode = "cli";
  assert.match(fact("启动"), /^程序启动/);
  props.mode = "manual";
  assert.match(fact("启动"), /^你来启动/);
  props.mode = "online";
  assert.match(fact("启动"), /^你转发回答/);
  assert.equal(fact("主持"), undefined, "a card outside a host choice says nothing about hosting");
  props.hosting = true;
  assert.match(fact("主持"), /不可（网页只读）/);
  props.mode = "manual";
  assert.match(fact("主持"), /不可（须本机唤醒）/);
  props.hostable = true;
  assert.equal(fact("主持"), undefined, "the crown already offers hosting, so only a refusal gets a row");
  props.host = true;
  assert.equal(fact("主持"), undefined, "the badge already names the host");
  props.host = false; props.hostable = false; props.hosting = false;
  props.mode = "cli";
  assert.deepEqual(Array.from(vm.runInContext("connection.value", context), item => item.field), ["executable"]);
  context.flip(true);
  view.value.launch.profiles.Codex.executable = "C";
  assert.deepEqual(Array.from(vm.runInContext("connection.value", context), item => item.field), ["executable"], "the field stays while typing");
  context.flip(false);
  assert.equal(vm.runInContext("connection.value", context).length, 0);
  fixture.cleanup();
});

test("cards read model catalogs only for automatic CLI and pure web participants cannot flip", async () => {
  const fixture = expert_card_fixture();
  fixture.view.value.launch.available = true;
  fixture.props.mode = "manual";
  fixture.context.flip(true);
  await nextTick();
  assert.deepEqual(fixture.reads, []);
  fixture.props.mode = "cli";
  await nextTick();
  assert.deepEqual(fixture.reads, ["Codex"]);
  fixture.view.value.launch.profiles.Codex.adapter = "codex";
  await nextTick();
  assert.equal(fixture.reads.length, 1);
  fixture.context.flip(false);
  fixture.props.name = "DeepSeek";
  fixture.props.mode = "online";
  await nextTick();
  fixture.context.flip(true);
  assert.equal(fixture.refs.back.value, false);
  assert.equal(vm.runInContext("can_flip.value", fixture.context), false);
  assert.equal(vm.runInContext("configurable.value", fixture.context), false);
  fixture.cleanup();
});

/** Use actual create-form handlers with isolated drafts; no AI or website is started. */
function create_form_fixture() {
  const view = ref({ fields: { "new-room-kind": "free", "new-room-host": "用户" },
    experts: { "new-expert-modes": {} }, launch: { profiles: {}, workspace: {}, available: false, create: false } });
  const events = [], cleanups = [], submissions = [];
  const pending = ref("");
  const bridge = { identities: { 用户: {}, Codex: {}, Claude: {}, DeepSeek: {} },
    launch_clients: { Codex: [{ value: "codex_cli" }, { value: "api" }], Claude: [{ value: "claude" }, { value: "api" }], DeepSeek: [{ value: "api" }] },
    platform_of: name => name.split("-")[0], display_name: name => name,
    write_launch: (name, field, value) => { (view.value.launch.profiles[name] ||= {})[field] = value; },
    default_launch_entry: name => { if (!bridge.launch_clients[name]?.some(item => item.value !== "api") && !view.value.launch.profiles[name]?.adapter) bridge.write_launch(name, "adapter", "api"); },
    write_field: (id, value) => { events.push([id, value]); view.value.fields[id] = value; },
    write_create_discussion: value => { view.value.create_discussion = Boolean(value); },
    write_expert: (id, name, mode) => { if (mode) view.value.experts[id][name] = mode; else delete view.value.experts[id][name]; },
    add_instance: (id, name, mode) => {
      let number = 2;
      while (view.value.experts[id][`${name}-${number}`]) number++;
      view.value.experts[id][`${name}-${number}`] = mode;
    } };
  const context = vm.createContext({ computed, ref, nextTick, defineProps: () => ({}), defineEmits: () => event => submissions.push(event),
    inject: () => ({ view, bridge, pending, act: () => {} }), onMounted: callback => callback(), onBeforeUnmount: () => {},
    window: { setInterval: () => 0, clearInterval: () => {} }, document: { hidden: false },
    watch: (...args) => { const stop = watch(...args); cleanups.push(stop); return stop; } });
  const component = readFileSync(new URL("../frontend/CreateDiscussion.vue", import.meta.url), "utf8");
  vm.runInContext(component.match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import .*;$/gm, ""), context);
  return { context, view, events, pending, submissions, cleanup: () => cleanups.forEach(stop => stop()) };
}

test("create form blocks empty rosters and applies button readiness to form submissions", async () => {
  const f = create_form_fixture(), { context, view, pending, submissions } = f;
  const submit = (expected) => {
    assert.equal(vm.runInContext("submit_disabled.value", context), expected);
    const count = submissions.length;
    context.submit();
    assert.equal(submissions.length, count + (expected ? 0 : 1));
  };
  view.value.fields["new-room-title"] = "闲聊";
  submit(true);
  view.value.launch.available = true;
  view.value.launch.scheduler = { enabled: true, provider: "typesafe", model: "jev-latest", api_key_ref: "test-key" };
  submit(true); // A configured decision model is not a participant.
  context.add_expert("Codex");
  submit(true); // The selected member still needs its software configuration.
  view.value.launch.profiles.Codex = { adapter: "codex_cli", executable: "codex" };
  submit(false);
  pending.value = "create";
  submit(true);
  pending.value = "";
  context.remove_expert("Codex");
  submit(true);
  view.value.launch.scheduler.enabled = false;
  view.value.launch.available = false;
  context.set_expert_mode("Codex", "manual");
  submit(false); // A manual member still needs no local service.
  context.toggle_discussion(true);
  await nextTick();
  submit(true); // Enter cannot bypass the discussion host requirement either.
  f.cleanup();
});

test("create form shares a role library, keeps independent instances and makes the first AI host a free room", async () => {
  const f = create_form_fixture(), { context, view } = f;
  context.add_expert("Codex");
  context.add_expert("Codex");
  context.add_expert("DeepSeek");
  const modes = view.value.experts["new-expert-modes"];
  assert.deepEqual(Object.entries(modes), [["Codex", "cli"], ["Codex-2", "cli"], ["DeepSeek", "cli"]], "every member starts woken by the local service");
  assert.equal(view.value.launch.profiles.DeepSeek.adapter, "api", "an API-only platform is woken through its API");
  assert.equal(view.value.fields["new-room-host"], "Codex", "the user is the client of a free room, never its host");
  assert.deepEqual(Array.from(vm.runInContext('access_choices("Codex")', context)), ["cli", "manual"], "a web AI is a manual member, not a third kind");
  assert.deepEqual(Array.from(vm.runInContext('access_choices("DeepSeek")', context)), ["cli", "manual"], "manual needs no local software, so any platform may be pasted into the AI the user runs by hand");
  context.set_expert_mode("Codex", "manual");
  context.set_expert_mode("Codex-2", "manual");
  context.set_expert_mode("DeepSeek", "online");
  assert.equal(vm.runInContext("room_ready.value", context), true, "rooms without woken members need no launcher");
  view.value.fields["new-room-host"] = "Codex-2";
  context.remove_expert("Codex");
  assert.equal(view.value.fields["new-room-host"], "Codex-2", "a manual member can host");
  context.set_expert_mode("Codex-2", "online");
  assert.equal(view.value.fields["new-room-host"], "", "an online instance cannot host, and the user never does");
  // A discussion is only an optional way to push the room: opening one needs a host the local service wakes.
  context.set_expert_mode("Codex-2", "manual");
  view.value.fields["new-room-host"] = "Codex-2";
  context.toggle_discussion(true);
  await nextTick();
  assert.equal(view.value.fields["new-room-host"], "");
  assert.ok(vm.runInContext("blocker.value", context), "a discussion without a woken host cannot be created");
  assert.deepEqual(Array.from(vm.runInContext('access_choices("Codex-2")', context)), ["cli", "manual"], "a discussion expert is woken or manual");
  context.set_expert_mode("Codex-2", "cli");
  assert.equal(view.value.fields["new-room-host"], "Codex-2");
  assert.deepEqual(Array.from(vm.runInContext('access_choices("Codex-2")', context)), [], "the host of a discussion is always woken by the local service");
  await nextTick();
  f.cleanup();
});

test("free member delivery never offers writable credentials to online or unavailable identities", async () => {
  const view = { access: { can_manage: true, members: [{ name: "Codex", access: "manual", available: false }] }, launch: { available: false }, room: {} };
  const calls = [];
  const menu_for = member => member_actions(member, { view, act: (...args) => calls.push(args), describe: () => {} });
  const manual = { name: "Codex", access: "manual", status: "away" };
  let menu = menu_for(manual).flat();
  assert.ok(menu.some(item => item.label === "复制启动指令（含凭证）"));
  assert.ok(menu.some(item => item.label === "复制凭证文本"));
  assert.equal(menu.find(item => item.label === "下载私有配置").disabled, true);
  assert.equal(menu.find(item => item.label === "请回").disabled, false, "manual rejoin needs no launcher");
  view.access.members[0].available = true;
  menu = menu_for(manual).flat();
  await menu.find(item => item.label === "下载私有配置").onSelect();
  assert.deepEqual(calls, [["download_member_access", "Codex"]]);
  const web = menu_for({ ...manual, access: "manual", manual_source: "web", pending: 1, status: "active" }).flat();
  assert.ok(web.some(item => item.label === "复制阅读通知"), "web manual members receive the reading notice");
  assert.ok(!web.some(item => ["复制启动指令（含凭证）", "复制凭证文本", "下载私有配置", "设为主持人"].includes(item.label)));
  assert.ok(!menu_for({ ...manual, access: "online", pending: 1 }).flat().some(item => item.label === "下载私有配置"), "legacy online members keep web permissions");
  view.access.can_manage = false;
  assert.equal(menu_for(manual)[0][0].disabled, true);
  assert.equal(web.find(item => item.label === "复制阅读通知").disabled, false, "menu snapshots should be rebuilt after permission changes");
  assert.equal(menu_for({ ...manual, access: "manual", manual_source: "web", pending: 1 })[1][0].disabled, true);
});

/** Drive the real slider with a deterministic clock and no live client. */
function effort_fixture(reduced = false) {
  const props = reactive({ modelValue: "", items: [
    { value: "", label: "默认强度" }, { value: "low", label: "Low" }, { value: "high", label: "High" },
  ] });
  const frames = new Map(), cleanups = [], events = [];
  let now = 0, frame_id = 0;
  const context = vm.createContext({ computed, ref, reactive, defineProps: () => props,
    defineEmits: () => (_name, value) => { events.push(value); props.modelValue = value; },
    useReducedMotion: () => ref(reduced), onBeforeUnmount: callback => cleanups.push(callback),
    watch: (...args) => cleanups.push(watch(...args)), performance: { now: () => now },
    requestAnimationFrame: callback => { frames.set(++frame_id, callback); return frame_id; },
    cancelAnimationFrame: id => frames.delete(id) });
  const component = readFileSync(new URL("../frontend/EffortSlider.vue", import.meta.url), "utf8");
  vm.runInContext(component.match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import .*;$/gm, "")
    + "\nglobalThis.slider_refs = { body, track };", context);
  const { body, track } = context.slider_refs;
  track.value = { focus() {}, setPointerCapture() {}, getBoundingClientRect: () => ({ left: 0, width: 220 }) };
  const pointer = (clientX, thumb = false) => ({ clientX, pointerId: 1, isPrimary: true, button: 0,
    target: { closest: () => thumb }, preventDefault() {} });
  const tick = async (count = 1) => {
    for (let index = 0; index < count; index++) {
      now += 1000 / 60;
      const pending = [...frames.values()]; frames.clear();
      pending.forEach(callback => callback(now));
      await nextTick();
    }
  };
  const finish = async () => {
    for (let count = 0; frames.size && count < 300; count++) await tick();
    assert.equal(frames.size, 0);
  };
  return { context, body, props, frames, events, pointer, tick, finish,
    cleanup: () => cleanups.forEach(callback => callback()) };
}

test("effort slider supports exact taps, every keyboard stop and explicit default", async () => {
  const fixture = effort_fixture(), { context, pointer, props } = fixture;
  context.grab(pointer(110));
  context.release(pointer(110));
  await fixture.finish();
  assert.equal(props.modelValue, "low");
  for (const [key, expected] of [["End", "high"], ["ArrowLeft", "low"], ["Home", ""], ["ArrowRight", "low"]]) {
    context.keydown({ key, preventDefault() {} });
    await fixture.finish();
    assert.equal(props.modelValue, expected);
  }
  fixture.cleanup();
});

test("effort caption previews the stop under a drag before the value is committed", async () => {
  const fixture = effort_fixture(), { context, pointer, props } = fixture;
  context.grab(pointer(10, true));
  context.move(pointer(210));
  await fixture.tick(30);
  assert.equal(vm.runInContext("live.value", context), 2);
  assert.equal(props.modelValue, "", "the saved value changes only on release");
  context.cancel(pointer(210));
  await fixture.finish();
  assert.equal(vm.runInContext("live.value", context), 0);
  fixture.cleanup();
});

test("effort drag keeps velocity on release and mid-flight grab; cancellation restores the saved stop", async () => {
  const fixture = effort_fixture(), { context, body, pointer } = fixture;
  context.grab(pointer(10, true));
  context.move(pointer(210));
  await fixture.tick(3);
  assert.ok(body.x > 0 && body.x < 2, "the hand pulls without teleporting");
  const velocity = body.v;
  context.release(pointer(210));
  assert.equal(body.v, velocity);
  const position = body.x;
  context.grab(pointer(10 + position * 100, true));
  assert.equal(body.x, position);
  assert.equal(body.v, velocity);
  context.move(pointer(10));
  context.cancel(pointer(10));
  await fixture.finish();
  assert.equal(body.x, 2);
  assert.deepEqual(fixture.events, ["high"], "a cancelled drag cannot write another effort");
  fixture.cleanup();
});

test("effort slider handles touch cancellation, boundaries and reduced motion without leftover frames", async () => {
  const fixture = effort_fixture(true), { context, body, pointer } = fixture;
  context.grab(pointer(210));
  context.cancel(pointer(210));
  assert.equal(body.x, 0);
  assert.equal(fixture.events.length, 0);
  context.grab(pointer(500));
  context.release(pointer(500));
  await nextTick();
  assert.equal(body.x, 2);
  assert.equal(body.v, 0);
  assert.equal(fixture.frames.size, 0);
  fixture.cleanup();
});

/** Mount the real picker logic with Vue reactivity and a deterministic animation clock. */
function picker_fixture(initial = {}, reduced_motion = false) {
  const props = reactive({ rounds: 3, minutes: 60, ...initial });
  const frames = new Map(), events = [], mounts = [], cleanups = [], watchers = [];
  let now = 0, frame_number = 0;
  const context = vm.createContext({
    computed, reactive, defineProps: () => props, defineExpose() {},
    defineEmits: () => (name, next) => { events.push({ name, next }); props[name.slice(7)] = next; },
    watch: (...args) => { const stop = watch(...args); watchers.push(stop); return stop; },
    onMounted: (callback) => mounts.push(callback), onBeforeUnmount: (callback) => cleanups.push(callback),
    performance: { now: () => now },
    requestAnimationFrame: (callback) => { frames.set(++frame_number, callback); return frame_number; },
    cancelAnimationFrame: (id) => frames.delete(id),
    window: { matchMedia: () => ({ matches: reduced_motion, addEventListener() {}, removeEventListener() {} }) },
  });
  const component = readFileSync(new URL("../frontend/LimitPicker.vue", import.meta.url), "utf8");
  const formatter = component.match(/<script>([\s\S]*?)<\/script>/)[1].replace("export function", "function");
  const picker_source = component.match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import .*;$/gm, "");
  vm.runInContext(`${formatter}\n${picker_source}\nglobalThis.test_wheels = wheels; globalThis.test_fields = fields;`, context);
  mounts.forEach((callback) => callback());
  const tick = async (count = 1) => {
    for (let index = 0; index < count; index++) {
      now += 1000 / 60;
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((callback) => callback(now));
      await nextTick();
    }
  };
  const finish = async () => {
    for (let index = 0; frames.size && index < 600; index++) await tick();
    assert.equal(frames.size, 0, "picker must stop requesting frames after settling");
  };
  const target = { querySelector: () => ({ focus() {} }), setPointerCapture() {}, getBoundingClientRect: () => ({ top: 0, height: 144 }) };
  const pointer = (extra = {}) => ({ pointerId: 1, isPrimary: true, button: 0, clientY: 72,
    target: { tagName: "DIV" }, currentTarget: target, preventDefault() {}, ...extra });
  return { context, props, events, wheels: context.test_wheels, fields: context.test_fields, tick, finish, frames, pointer,
    cleanup: () => { cleanups.forEach((callback) => callback()); watchers.forEach((stop) => stop()); },
  };
}

test("picker splits exact duration into hours and minutes and enforces 1–1440 minutes", async () => {
  const fixture = picker_fixture({ minutes: 1439 });
  const { context, wheels, props } = fixture;
  assert.deepEqual(Array.from(wheels, (wheel) => wheel.selected), [3, 23, 59]);
  context.choose(wheels[1], 24);
  await fixture.finish();
  assert.equal(props.minutes, 1440);
  assert.equal(wheels[2].selected, 0);
  assert.equal(wheels[2].max, 0);
  assert.ok(fixture.events.filter((event) => event.name === "update:minutes").every((event) => event.next <= 1440));
  context.choose(wheels[1], 1);
  await fixture.finish();
  context.begin_edit(wheels[2], { target: { select() {} } });
  wheels[2].draft = "7";
  context.finish_edit(wheels[2]);
  await fixture.finish();
  assert.equal(props.minutes, 67);
  assert.deepEqual(Array.from(context.rows(wheels[2]), (row) => row.text), [4, 5, 6, 7, 8, 9, 10]);
  context.choose(wheels[1], 0);
  await fixture.finish();
  context.choose(wheels[2], 0);
  await fixture.finish();
  assert.equal(props.minutes, 1);
  assert.equal(props.rounds, 3);
  fixture.cleanup();
});

test("picker unlimited settings independently restore exact duration and round count", async () => {
  const fixture = picker_fixture({ rounds: 4, minutes: 67 });
  const { context, fields, props } = fixture;
  context.set_unlimited(fields[0], true);
  assert.equal(props.rounds, 0);
  assert.equal(props.minutes, 67);
  context.set_unlimited(fields[1], true);
  await fixture.finish();
  context.settle();
  assert.equal(props.rounds, 0);
  assert.equal(props.minutes, 0);
  context.set_unlimited(fields[1], false);
  assert.equal(props.minutes, 67);
  assert.equal(props.rounds, 0);
  context.set_unlimited(fields[0], false);
  assert.equal(props.rounds, 4);
  fixture.cleanup();
});

test("picker keyboard reaches finite boundaries and accumulates quick commands", async () => {
  const fixture = picker_fixture(), { context, wheels, props } = fixture;
  const key = (wheel, name) => context.keydown(wheel, { key: name, preventDefault() {} });
  key(wheels[0], "Home");
  key(wheels[1], "Home");
  await fixture.finish();
  assert.equal(props.rounds, 1);
  assert.equal(props.minutes, 1);
  for (let index = 0; index < 10; index++) key(wheels[2], "ArrowDown");
  await fixture.finish();
  assert.equal(props.minutes, 11);
  key(wheels[0], "End");
  key(wheels[1], "End");
  await fixture.finish();
  assert.equal(props.rounds, 100);
  assert.equal(props.minutes, 1440);
  fixture.cleanup();
});

for (const pointerType of ["mouse", "touch"]) test(`picker ${pointerType} drag preserves release velocity and grabbing a moving wheel does not jump`, async () => {
  const fixture = picker_fixture({ minutes: 90 });
  const { context, wheels } = fixture, wheel = wheels[2], initial_position = wheel.x;
  const pointer = (extra = {}) => fixture.pointer({ pointerType, ...extra });
  context.grab(wheel, pointer());
  context.drag(wheel, pointer({ clientY: -60 }));
  await fixture.tick(6);
  assert.ok(wheel.x > initial_position && wheel.v > 0);
  const velocity = wheel.v, released_at = wheel.x;
  context.release(wheel, pointer({ type: "pointerup", clientY: -60 }));
  assert.equal(wheel.v, velocity);
  await fixture.tick(2);
  assert.ok(wheel.x > released_at);
  const position = wheel.x, speed = wheel.v;
  context.grab(wheel, pointer());
  assert.equal(wheel.x, position);
  assert.equal(wheel.v, speed);
  context.drag(wheel, pointer({ clientY: 220 }));
  await fixture.tick(8);
  context.release(wheel, pointer({ type: "pointerup", clientY: 220 }));
  await fixture.finish();
  assert.equal(wheel.x, wheel.selected);
  fixture.cleanup();
});

test("picker mouse-wheel steps stop immediately, including after editing or interrupting a drag", async () => {
  for (const reduced_motion of [false, true]) {
    const fixture = picker_fixture({ minutes: 75 }, reduced_motion);
    const { context, wheels, props, pointer } = fixture, wheel = wheels[2];
    const input = { currentTarget: pointer().currentTarget, deltaY: 64, deltaMode: 0 };
    for (const deltaMode of [0, 1, 2]) context.scroll(wheel, { ...input, deltaMode });
    assert.equal(props.minutes, 78);
    assert.equal(wheel.x, 18);
    assert.equal(wheel.v, 0);
    assert.equal(fixture.frames.size, 0);
    await fixture.tick(30);
    assert.equal(props.minutes, 78, "no input means no further movement");
    context.begin_edit(wheel, { target: { select() {} } });
    wheel.draft = "7";
    context.scroll(wheel, { ...input, deltaY: -64 });
    assert.equal(props.minutes, 66);
    assert.equal(wheel.editing, false);
    context.grab(wheel, pointer());
    context.drag(wheel, pointer({ clientY: -60 }));
    await fixture.tick(6);
    context.release(wheel, pointer({ type: "pointerup", clientY: -60 }));
    assert.ok(wheel.v > 0);
    const stop = Math.round(wheel.x) - 1;
    context.scroll(wheel, { ...input, deltaY: -64 });
    assert.equal(wheel.x, stop);
    assert.equal(wheel.v, 0);
    await fixture.finish();
    assert.equal(wheel.x, stop, "wheel input must stop an unfinished drag trajectory");
    fixture.cleanup();
  }
});

test("picker drag retains perceptible release inertia with reduced motion enabled", async () => {
  const fixture = picker_fixture({ minutes: 75 }, true);
  const { context, wheels, pointer } = fixture, wheel = wheels[2];
  context.grab(wheel, pointer({ pointerType: "touch" }));
  context.drag(wheel, pointer({ pointerType: "touch", clientY: -60 }));
  await fixture.tick(6);
  context.release(wheel, pointer({ type: "pointerup", pointerType: "touch", clientY: -60 }));
  await fixture.tick(6);
  const moving_at = wheel.x;
  assert.ok(wheel.v > 0 && fixture.frames.size > 0);
  await fixture.tick(6);
  assert.ok(wheel.x - moving_at > 0.25, "a released drag continues visibly between 100 and 200 ms");
  await fixture.finish();
  fixture.cleanup();
});

test("picker distinguishes a central tap from dragging and preserves native text editing", () => {
  const fixture = picker_fixture(), { context, wheels, pointer } = fixture, wheel = wheels[2];
  let focused = 0;
  const point = pointer();
  point.currentTarget.querySelector = (selector) => ({ focus() { if (selector === "input") focused++; } });
  context.grab(wheel, point);
  context.release(wheel, { ...point, type: "pointerup" });
  assert.equal(focused, 1, "a central tap opens exact input");
  context.grab(wheel, point);
  context.drag(wheel, { ...point, clientY: 40 });
  context.release(wheel, { ...point, type: "pointerup", clientY: 40 });
  assert.equal(focused, 1, "dragging across the center never enters text input");
  context.begin_edit(wheel, { target: { select() {} } });
  context.grab(wheel, { ...point, target: { tagName: "INPUT" },
    preventDefault() { assert.fail("native text selection must remain available"); } });
  assert.equal(wheel.pointer, null);
  fixture.cleanup();
});

test("picker catches flicks at boundaries and halfway releases settle to an integer", async () => {
  for (const [position, speed] of [[0, -60], [59, 60], [30.5, 0]]) {
    const fixture = picker_fixture();
    const wheel = fixture.wheels[2];
    wheel.x = position;
    wheel.v = speed;
    fixture.context.wake();
    await fixture.finish();
    assert.ok(wheel.selected >= 0 && wheel.selected <= 59);
    assert.equal(wheel.x, wheel.selected);
    fixture.cleanup();
  }
});

test("picker external drafts and submission retain both time columns and explicit selections", async () => {
  const fixture = picker_fixture(), { context, props, wheels } = fixture;
  props.rounds = 12;
  props.minutes = 125;
  await nextTick();
  assert.deepEqual(Array.from(wheels, (wheel) => wheel.selected), [12, 2, 5]);
  context.choose(wheels[1], 3);
  context.choose(wheels[2], 20);
  await fixture.tick(5);
  context.settle();
  assert.equal(props.minutes, 200);
  assert.equal(fixture.frames.size, 0);
  props.minutes = 1;
  await nextTick();
  assert.deepEqual(Array.from(wheels, (wheel) => wheel.selected), [12, 0, 1]);
  fixture.cleanup();
});

test("unmounting a moving picker cancels its scheduled animation", () => {
  const fixture = picker_fixture();
  fixture.context.choose(fixture.wheels[0], 20);
  assert.equal(fixture.frames.size, 1);
  fixture.cleanup();
  assert.equal(fixture.frames.size, 0);
});

test("a zero-length first animation frame cannot discard a keyboard selection", async () => {
  const fixture = picker_fixture();
  fixture.context.choose(fixture.wheels[2], 15);
  const callback = [...fixture.frames.values()][0];
  fixture.frames.clear();
  callback(0);
  assert.equal(fixture.frames.size, 1);
  await fixture.finish();
  assert.equal(fixture.props.minutes, 75);
  fixture.cleanup();
});

test("tapping a curved outer row selects that row rather than its flat projection", async () => {
  const fixture = picker_fixture({ minutes: 90 });
  const wheel = fixture.wheels[2];
  const point = fixture.pointer({ clientY: 141 });
  fixture.context.grab(wheel, point);
  fixture.context.release(wheel, { ...point, type: "pointerup" });
  await fixture.finish();
  assert.equal(fixture.props.minutes, 93);
  fixture.cleanup();
});

test("closing or switching popovers commits edits and stops both hidden time columns", async () => {
  const fixture = picker_fixture(), { context, fields, wheels, props } = fixture;
  context.set_open(fields[1], true);
  context.begin_edit(wheels[2], { target: { select() {} } });
  wheels[2].draft = "7";
  context.set_open(fields[0], true);
  assert.equal(fields[1].open, false);
  assert.equal(fields[0].open, true);
  assert.equal(props.minutes, 67);
  context.choose(wheels[0], 30);
  await fixture.tick(3);
  context.set_open(fields[0], false);
  await fixture.finish();
  assert.equal(props.rounds, 30);
  context.set_open(fields[0], true);
  context.keydown(wheels[0], { key: "ArrowDown", preventDefault() {} });
  context.set_open(fields[0], false);
  assert.equal(props.rounds, 31, "immediate dismissal must not discard keyboard selection");
  context.set_open(fields[1], true);
  context.begin_edit(wheels[1], { target: { select() {} } });
  wheels[1].draft = "9000";
  context.settle();
  assert.equal(props.minutes, 1440);
  context.begin_edit(wheels[2], { target: { select() {} } });
  wheels[2].draft = "";
  context.settle();
  assert.equal(props.minutes, 1440);
  fixture.cleanup();
});

test("duration labels use hours and retain exact remaining minutes", () => {
  const fixture = picker_fixture();
  const format = fixture.context.format_duration;
  assert.deepEqual([1, 59, 60, 67, 75, 120, 1439, 1440].map(format),
    ["1 分钟", "59 分钟", "1 小时", "1 小时 7 分钟", "1 小时 15 分钟", "2 小时", "23 小时 59 分钟", "24 小时"]);
  fixture.cleanup();
});

/** Exercise theme persistence and renderer selection without touching discussion data. */
function theme_fixture(saved_theme = null, shared_storage = null) {
  const nodes = new Map([['modern-style', { disabled: false }]]);
  const classes = new Set();
  const storage = shared_storage || new Map([['ai-codiscuss-theme', saved_theme]]);
  const loaded = [];
  const buttons = ['channel', 'channel-light'].map((theme) => ({
    dataset: { themeOption: theme }, setAttribute(key, value) { this[key] = value; },
  }));
  const document = {
    documentElement: { dataset: {}, classList: { toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); } } },
    getElementById: (id) => nodes.get(id), querySelectorAll: () => buttons,
    createElement: () => ({}), head: { append(node) { nodes.set(node.id, node); loaded.push(node); } },
  };
  const context = vm.createContext({ window: {}, document, crypto: globalThis.crypto, URL, URLSearchParams, AbortSignal, setTimeout: () => 0, clearTimeout: () => {}, localStorage: {
    getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value),
    removeItem: key => storage.delete(key), key: index => [...storage.keys()][index], get length() { return storage.size; },
  } });
  vm.runInContext(`${source}\nglobalThis.test_state = state;`, context);
  context.publish_view = () => {};
  return { context, nodes, classes, storage, loaded, buttons, root: document.documentElement };
}

test('empty execution limits submit as unlimited and remain clear in the progress label', () => {
  const { context, nodes } = theme_fixture();
  for (const [key, value] of Object.entries({ max_rounds: '3', max_minutes: '0', execution_minutes: '' })) {
    nodes.set(`new-room-limit-${key}`, { value });
  }
  const limits = context.read_limits('new-room');
  assert.equal(limits.execution_minutes, 0);
  assert.match(context.limits_label(limits), /单次自动执行 不限时长/);
  nodes.get('new-room-limit-execution_minutes').value = '10';
  assert.equal(context.read_limits('new-room').execution_minutes, 10);
  assert.match(context.limits_label(context.read_limits('new-room')), /单次自动执行 10 分钟/);
});

test('topic editing saves details without changing the discussion phase or a live session limit', async () => {
  const { context, nodes } = theme_fixture(), calls = [];
  const experts = { Codex: 'cli', Claude: 'online' };
  nodes.set('topic-host-select', { value: 'Codex' });
  nodes.set('topic-phase-select', { value: 'paused' });
  for (const key of ['title', 'goal', 'focus', 'user_request', 'background', 'boundaries']) {
    nodes.set(`topic-${key}-input`, { value: `${key} edited` });
  }
  for (const [key, value] of Object.entries({ max_rounds: '7', max_minutes: '30', execution_minutes: '0' })) {
    nodes.set(`topic-limit-${key}-input`, { value });
  }
  Object.assign(context, { read_expert_inputs: () => experts, topic_member_requests: () => [],
    save_room_credentials() {}, refresh_room: async () => {}, show_toast() {},
    request_json: async (path, payload) => { calls.push({ path, payload }); return {}; } });
  for (const status of [null, 'active', 'paused', 'concluded']) {
    context.test_state.room = { id: 'topic-room', mode: 'free', host: 'Codex', experts,
      session: status ? { id: 1, status } : null };
    await context.save_topic({ preventDefault() {} });
    const { path, payload } = calls.at(-1);
    assert.equal(path, '/api/rooms/topic-room/topic');
    assert.equal(payload.title, 'title edited');
    assert.equal(payload.background, 'background edited');
    assert.equal('phase' in payload, false);
    assert.equal('limits' in payload, !['active', 'paused'].includes(status));
    if (payload.limits) assert.equal(payload.limits.max_rounds, 7);
  }
});

/** Model a public page and its private browser storage without using a real local credential. */
function connection_fixture(connection, shared_storage) {
  const fixture = theme_fixture(null, shared_storage);
  const location = new URL('https://discussion.example/?room=keep');
  if (connection) location.hash = `codiscuss-connect=${encodeURIComponent(JSON.stringify(connection))}`;
  const requests = [];
  Object.assign(fixture.context, { location, render_launch_settings() {},
    history: { replaceState(_state, _title, url) { assert.equal(url, '/?room=keep'); location.hash = ''; } },
    fetch: async (url, options) => {
      assert.equal(location.hash, '', 'connection secret must leave the address bar before network requests');
      requests.push({ url, options });
      return { ok: true, json: async () => ({ participants: { Claude: { adapter: 'claude', executable: '/local/claude' } } }) };
    },
  });
  return { ...fixture, requests, location };
}

test('online connection removes its URL secret, survives reload and sends private settings only to loopback', async () => {
  const connection = { site: 'https://discussion.example', endpoint: 'http://127.0.0.1:8765', token: 'a'.repeat(64) };
  const fixture = connection_fixture(connection);
  await fixture.context.load_launch_settings();
  assert.equal(fixture.context.test_state.launch.available, true);
  assert.equal(fixture.context.test_state.launch.remote, true);
  assert.equal(fixture.requests[0].url, `${connection.endpoint}/api/local/settings`);
  assert.equal(fixture.requests[0].options.headers['X-CoDiscuss-Connection'], connection.token);
  assert.equal(fixture.requests[0].options.credentials, 'omit');
  assert.equal(fixture.requests[0].options.redirect, 'error');
  assert.equal(JSON.stringify(fixture.context.test_state.launch).includes(connection.token), false);
  const reloaded = connection_fixture(null, fixture.storage);
  await reloaded.context.load_launch_settings();
  await reloaded.context.local_launch_request('launch', { token: 'room-credential', room: { title: '新讨论' } });
  assert.equal(reloaded.requests.length, 2);
  assert.equal(reloaded.requests[1].url, `${connection.endpoint}/api/local/launch`);
  assert.equal(JSON.parse(reloaded.requests[1].options.body).room.title, '新讨论');
});

test('unconnected public page shows the connection command without probing arbitrary local ports', async () => {
  const fixture = connection_fixture();
  await fixture.context.load_launch_settings();
  assert.equal(fixture.context.test_state.launch.available, false);
  assert.match(fixture.context.test_state.launch.connect_command, /codiscuss local connect "https:\/\/discussion.example"/);
  assert.equal(fixture.requests.length, 0);
});

test('browser rejects connection links for another site, remote endpoints, URL credentials or malformed tokens', async () => {
  const connection = { site: 'https://discussion.example', endpoint: 'http://127.0.0.1:8765', token: 'b'.repeat(64) };
  for (const override of [{ site: 'https://unrelated.example' }, { endpoint: 'https://unrelated.example' },
    { endpoint: 'http://127.0.0.1:8765/path' }, { endpoint: 'http://name:secret@127.0.0.1:8765' }, { token: 'invalid' }]) {
    const fixture = connection_fixture({ ...connection, ...override });
    await fixture.context.load_launch_settings();
    assert.equal(fixture.location.hash, '');
    assert.equal(fixture.requests.length, 0);
    assert.equal(fixture.context.test_state.launch.available, false);
    assert.match(fixture.context.test_state.launch.error, /连接链接无效/);
    assert.equal(fixture.storage.get('discuss-local-connection'), undefined);
  }
});

test('connection failure remains visible and an explicit retry restores availability without creating a room', async () => {
  const fixture = connection_fixture({ site: 'https://discussion.example', endpoint: 'http://127.0.0.1:8765', token: 'c'.repeat(64) });
  const fetch = fixture.context.fetch;
  fixture.context.fetch = async () => { throw new TypeError('Failed to fetch'); };
  await fixture.context.load_launch_settings();
  assert.equal(fixture.context.test_state.launch.available, false);
  assert.match(fixture.context.test_state.launch.error, /允许浏览器访问本机网络/);
  fixture.context.fetch = fetch;
  await fixture.context.load_launch_settings();
  assert.equal(fixture.context.test_state.launch.available, true);
  assert.equal(fixture.context.test_state.launch.error, '');
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.requests[0].options.method, 'GET');
});

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

test("discussion control reads and writes the original room revision despite navigation", async () => {
  const fixture = theme_fixture();
  fixture.storage.set('discuss-access:room-a', 'credential-a');
  fixture.context.test_state.room = { id: 'room-a', session: { id: 4, status: 'paused' } };
  const calls = [];
  Object.assign(fixture.context, {
    refresh_room: async () => {}, show_toast() {},
    request_json: async (path, payload) => {
      calls.push({ path, payload });
      if (!payload) { fixture.context.test_state.room = { id: 'room-b' }; return { revision: 'rev-a', session: { id: 4, status: 'paused' } }; }
      return {};
    },
  });
  await fixture.context.restart_discussion();
  assert.deepEqual(calls.map(call => call.path), ['/api/rooms/room-a/discussion', '/api/rooms/room-a/discussion']);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[1].payload)), { action: 'resume', revision: 'rev-a' });
  assert.equal(fixture.storage.get('discuss-access:room-a'), 'credential-a');
  assert.equal(fixture.storage.get('discuss-access:room-b'), undefined);
});

test("discussion resume refuses a replaced session after reading the current revision", async () => {
  const fixture = theme_fixture();
  fixture.storage.set('discuss-access:room-a', 'credential-a');
  fixture.context.test_state.room = { id: 'room-a', session: { id: 4, status: 'paused' } };
  const calls = [];
  Object.assign(fixture.context, {
    request_json: async (path, payload) => { calls.push({ path, payload }); return { revision: 'rev-b', session: { id: 5, status: 'paused' } }; },
  });
  await assert.rejects(fixture.context.restart_discussion(), /讨论会话已变化/);
  assert.equal(calls.length, 1, 'a revision for a different session is never used');
});

const skip_room = id => ({ id, session: { id: 3, status: 'active' }, current_turn: { id: 7, expert: 'Gemini', status: 'pending' } });

test("skip cancels the selected session plan by its plan id", async () => {
  const { context, storage } = theme_fixture(), requests = [];
  storage.set('discuss-access:skip-room', 'owner-token');
  context.test_state.room = skip_room("skip-room");
  Object.assign(context, { request_json: async (path, payload) => requests.push({ path, payload }), refresh_room: async () => {}, show_toast() {} });
  await context.skip_turn();
  assert.deepEqual(JSON.parse(JSON.stringify(requests)), [{ path: '/api/rooms/skip-room/turns/7', payload: { actor: '用户', status: 'cancelled' } }]);
});

test("skip stays bound to its original room and session during navigation", async () => {
  const { context, storage } = theme_fixture(), paths = [];
  storage.set('discuss-access:one', 'owner-token');
  context.test_state.room = skip_room("one");
  Object.assign(context, { request_json: async path => { paths.push(path); context.test_state.room = { id: "two" }; },
    refresh_room: async () => assert.fail("must not refresh the next room"), show_toast: () => assert.fail("must not toast on the next room") });
  await context.skip_turn();
  assert.deepEqual(paths, ["/api/rooms/one/turns/7"]);
});

test("failed cards survive fresh snapshots and stay beside their request without becoming answers", async () => {
  const request = { discussion_session_id: 4, after_message_id: 1, source_message_id: 1 };
  const f = free_card_fixture({ messages: [
    { id: 1, author: "用户", text: "请独立分析", created_at: 1000 },
    { id: 2, author: "用户", text: "后续消息", created_at: 1001 },
  ], executions: [{ id: 9, member_id: 8, member: "Claude", role: "member", status: "failed", request_message_id: 900,
    created_at: 1002, finished_at: 1012, result: "工具调用失败", requests: [request] }] });
  const start = discussion_source.indexOf("function request_message(report)");
  const end = discussion_source.indexOf("/** Put the original text back", start);
  vm.runInContext(`${discussion_source.slice(start, end)}\nglobalThis.original_message = request_message; globalThis.failed_message = failed_request_message;`, f.context);
  assert.equal(f.state.failures.value[0].author, "Claude", "the execution keeps its author even after the member leaves");
  assert.deepEqual([...f.state.layout.value].map(item => item.id), [1, "failed-9", 2]);
  assert.equal(f.context.failed_message(f.state.failures.value[0].failure).id, 1, "only a visible source message can be offered for resend");
  assert.equal(f.view.messages.some(message => message.id === 900), false, "internal task messages never enter history");
  f.view.room = JSON.parse(JSON.stringify(f.view.room));
  await nextTick();
  assert.equal(f.state.failures.value[0].failure.result, "工具调用失败", "the service snapshot keeps the failure reason");
  assert.deepEqual([...f.state.layout.value].map(item => item.id), [1, "failed-9", 2]);
  f.view.query = "筛选";
  await nextTick();
  assert.equal(f.state.failures.value.length, 0);
  f.view.query = "";
  f.view.mention_only = true;
  await nextTick();
  assert.equal(f.state.failures.value.length, 0);
  f.view.mention_only = false;
  f.view.access.can_manage = false;
  assert.equal(f.context.failed_message(f.state.failures.value[0].failure), null, "resend requires owner access");
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
  for (const id of ['turn-status', 'turn-note', 'turn-expert', 'turn-question', 'copy-turn', 'confirm-notified', 'forward-turn', 'cancel-turn', 'view-turn-answer', 'schedule-turn', 'schedule-note']) fixture.nodes.set(id, {});
  fixture.context.test_state.room = { phase: 'discussing', host: 'Codex', experts: { Codex: 'cli' },
    limits: { reached: true } };
  fixture.context.render_current_turn();
  assert.equal(fixture.nodes.get('schedule-turn').disabled, true);
  assert.match(fixture.nodes.get('schedule-note').textContent, /已达到讨论上限/);
});

test("folder creation target is submitted atomically and changes the retry identifier", async () => {
  const fixture = theme_fixture();
  const requests = [];
  for (const id of ['title', 'goal', 'host', 'user_request', 'background', 'boundaries', 'mode']) fixture.nodes.set(`new-room-${id}`, { value: id === 'mode' ? 'manual' : '内容' });
  fixture.nodes.set('new-room-kind', { value: 'brainstorm' });
  fixture.nodes.set('room-dialog', { close() {} });
  fixture.nodes.set('room-form', { reset() {} });
  fixture.root.dataset.theme = 'channel';
  let sequence = 0;
  Object.assign(fixture.context, {
    crypto: { randomUUID: () => `token-${++sequence}` }, new_submission_id: () => `submission-${++sequence}`,
    read_expert_inputs: () => ({}), read_limits: () => ({}), default_experts: () => ({}), render_expert_inputs() {},
    select_room: async () => {}, select_tab() {}, show_toast() {}, render_rooms() {}, render_room() {},
    request_json: async (path, payload) => { requests.push(payload); throw Object.assign(new Error('retry'), { preflight: true }); },
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
  assert.equal(fixture.nodes.get('modern-style').disabled, false);
  assert.equal(fixture.loaded.length, 1);
});

test("manual creation retains distinct member credentials across reload and a lost receipt", async () => {
  const f = theme_fixture(), requests = [];
  const payload = { title: "手动协作", mode: "free", host: "用户", experts: { Codex: "manual", "Codex-2": "manual", DeepSeek: "online" } };
  f.nodes.set('room-dialog', { close() {} });
  Object.assign(f.context, { room_creation_payload: () => payload, render_rooms() {}, render_room() {}, show_toast() {},
    request_json: async (_path, input, token) => { requests.push({ input, token }); throw new Error('lost manual receipt'); } });
  await assert.rejects(f.context.submit_room({ preventDefault() {} }), /lost manual receipt/);
  const record = f.context.stored_launches()[0];
  assert.equal(record.direct, true);
  assert.equal(record.input.room.runtime_mode, undefined, "free room creation cannot send automatic discussion runtime");
  assert.deepEqual(Array.from(record.input.room.members, member => member.access), ['manual', 'manual', 'manual']);
  assert.equal(record.input.room.members[2].manual_source, 'web');
  const tokens = record.input.room.members.map(member => member.token);
  assert.equal(new Set([record.input.token, ...tokens]).size, 4);
  assert.equal(JSON.stringify(f.context.test_state.launch).includes(tokens[0]), false);
  assert.equal(JSON.stringify(f.context.test_state.creating_room).includes(tokens[0]), false);
  const reloaded = theme_fixture(null, f.storage);
  let recovered;
  Object.assign(reloaded.context, { select_room: async () => {}, render_launch_settings() {},
    request_json: async (_path, input, token) => { recovered = { input, token }; return { id: 'manual-room', members: input.members.map((member, id) => ({ name: member.name, id })) }; } });
  await reloaded.context.resume_launch(record.id);
  assert.equal(JSON.stringify(recovered), JSON.stringify(requests[0]));
  assert.equal(reloaded.storage.get('discuss-access:manual-room'), record.input.token);
  const saved = reloaded.context.member_credentials('manual-room');
  assert.equal(saved['Codex-2'].token, tokens[1]);
  assert.equal(reloaded.context.stored_launches().length, 0);
});

test("member downloads contain only their credential and copied instructions contain no secrets", async () => {
  const f = theme_fixture();
  const room = { id: 'one', host: 'Codex', members: [
    { id: 1, name: 'Codex', access: 'manual', status: 'active' },
    { id: 2, name: 'Codex-2', access: 'manual', status: 'active' },
    { id: 3, name: 'DeepSeek', access: 'online', status: 'active' }] };
  f.context.test_state.room = room;
  f.context.save_room_credentials(room, 'owner-secret', room.members.map(member => ({ ...member, token: `${member.name}-secret` })));
  let downloaded, copied;
  Object.assign(f.context, { location: new URL('https://discussion.example'),
    download_private_json: value => { downloaded = value; }, copy_text: async value => { copied = value; }, workspace_instruction: () => '' });
  assert.equal(JSON.stringify(f.context.access_snapshot()).includes('secret'), false);
  f.context.download_member_access('Codex-2');
  assert.deepEqual(JSON.parse(JSON.stringify(downloaded)), { site: 'https://discussion.example', room: 'one', token: 'Codex-2-secret' });
  assert.throws(() => f.context.download_member_access('DeepSeek'), /没有此成员/);
  await f.context.copy_member_access_text('Codex-2');
  assert.deepEqual(JSON.parse(copied), { site: 'https://discussion.example', room: 'one', token: 'Codex-2-secret' });
  await assert.rejects(() => f.context.copy_member_access_text('DeepSeek'), /没有此成员/);
  await f.context.copy_member_join('Codex-2', true);
  assert.match(copied, /DISCUSS_ACCESS/);
  assert.equal(JSON.parse(copied.slice(copied.indexOf('{"site"'))).token, 'Codex-2-secret', 'only the launch text carries the credential');
  await assert.rejects(() => f.context.copy_member_join('DeepSeek', true), /没有此成员|没有此成员可复制/);
  await f.context.copy_member_join('Codex');
  assert.match(copied, /discuss-host/);
  assert.match(copied, /--as Codex --access-file/);
  assert.doesNotMatch(copied, /owner-secret|Codex-secret|Codex-2-secret|DeepSeek-secret/);
  room.members[0].id = 99;
  assert.equal(f.context.access_snapshot().members[0].available, false, 'replaced identities cannot download an old private file');
  f.storage.delete('discuss-access:one');
  assert.throws(() => f.context.download_member_access('Codex-2'), /没有此成员/);
});

test("member instructions separate manual credentials, runner executions and online relay", async () => {
  const f = theme_fixture(), room = { id: "one", mode: "free", host: "Codex", runtime: { protected: false }, members: [
    { id: 1, name: "Codex", access: "manual", status: "active" }, { id: 2, name: "DeepSeek", access: "online", status: "active" }] };
  f.context.test_state.room = room;
  f.context.save_room_credentials(room, "owner-secret", [{ name: "Codex", token: "member-secret", access: "manual" }]);
  let copied;
  Object.assign(f.context, { location: new URL("https://discussion.example"), copy_text: async value => { copied = value; }, workspace_instruction: () => "" });
  await f.context.copy_member_join("Codex");
  assert.match(copied, /discuss-participant 和 discuss-host/);
  assert.match(copied, /--as Codex --access-file/);
  assert.match(copied, /人工或软件原生定时触发/);
  room.members[0].access = "runner";
  await f.context.copy_member_join("Codex");
  assert.match(copied, /task 中的 access_file 和 execution/);
  assert.match(copied, /有效 execution_id/);
  assert.match(copied, /持久成员私有文件不能替代自动执行凭据/);
  assert.doesNotMatch(copied, /--access-file|人工或软件原生定时触发|模型与思考强度在原软件/);
  room.mode = "brainstorm";
  await f.context.copy_member_join("Codex");
  assert.match(copied, /只处理本次有效执行/);
  assert.doesNotMatch(copied, /execution_id/);
  await f.context.copy_member_join("DeepSeek");
  assert.match(copied, /由用户或授权主持人代发/);
  assert.doesNotMatch(copied, /定时|自行提交|access_file|私有文件|owner-secret|member-secret/);
});

test("legacy copy actions delegate to member instructions without selecting local identities in the composer", async () => {
  const f = theme_fixture(), room = { id: "one", host: "Codex", members: [
    { id: 1, name: "Codex", access: "manual", status: "active" }, { id: 2, name: "DeepSeek", access: "online", status: "active" }] };
  f.context.test_state.room = room;
  f.context.save_room_credentials(room, "owner", []);
  f.nodes.set("author-select", { value: "用户" });
  const copied = [], tabs = [];
  Object.assign(f.context, { copy_member_join: async name => copied.push(name), select_tab: tab => tabs.push(tab), show_toast() {} });
  await f.context.copy_background();
  await f.context.copy_context("online");
  assert.deepEqual(copied, ["Codex", "DeepSeek"]);
  room.members.push({ id: 3, name: "Claude", access: "manual", status: "active" });
  await f.context.copy_context("cli");
  assert.deepEqual(tabs, ["access"]);
  assert.equal(copied.length, 2);
  const actions = {};
  f.context.element = id => ({ addEventListener: (_event, action) => { actions[id] = action; } });
  f.context.bind_host_controls();
  await actions["copy-host"]();
  assert.equal(copied.at(-1), "Codex");
});

test("manual invitations and rejoin reuse the original token after ambiguous responses", async () => {
  const f = theme_fixture(), inputs = [];
  const members = [{ id: 1, name: 'Codex', access: 'manual', status: 'active' }];
  f.context.test_state.room = { id: 'one', mode: 'free', free: { members } };
  f.storage.set('discuss-access:one', 'owner-secret');
  let lose = true;
  Object.assign(f.context, { refresh_room: async () => {},
    local_launch_request: async () => { throw new Error('manual must not invoke a launcher'); },
    request_json: async (path, payload) => {
      inputs.push({ path, payload: { ...payload } });
      if (path.endsWith('/members') && !members.some(item => item.name === payload.name)) members.push({ id: 2, ...payload, status: 'active' });
      if (lose) throw new Error('receipt lost');
      return { members };
    } });
  await f.context.invite_member({ name: 'Codex', access: 'manual' });
  lose = false;
  await f.context.invite_member({ name: 'Codex', access: 'manual' });
  assert.equal(inputs[0].payload.name, 'Codex-2');
  assert.deepEqual(inputs[1], inputs[0]);
  assert.equal(f.context.member_credentials('one')['Codex-2'].token, inputs[0].payload.token);
  lose = true;
  await f.context.change_member({ member_id: 2, name: 'Codex-2', action: 'rejoin' });
  lose = false;
  await f.context.change_member({ member_id: 2, name: 'Codex-2', action: 'rejoin' });
  assert.deepEqual(inputs[3], inputs[2]);
  assert.notEqual(inputs[2].payload.token, inputs[0].payload.token);
  assert.equal(f.context.member_credentials('one')['Codex-2'].token, inputs[2].payload.token);
});

test("automatic invitations keep explicit project permissions across an uncertain retry", async () => {
  const f = theme_fixture(), inputs = [], members = [];
  f.context.test_state.room = { id: 'one', mode: 'free', free: { members } };
  f.storage.set('discuss-access:one', 'owner-secret');
  let lose = true;
  Object.assign(f.context, { refresh_room: async () => {},
    launch_options: () => ({ participants: { Claude: { model: 'sonnet' } } }),
    local_launch_request: async (operation, payload) => {
      inputs.push({ operation, payload });
      if (lose) throw new Error('receipt lost');
      return { free: { members: [{ name: payload.name, status: 'active', access: 'runner' }] } };
    } });
  await f.context.invite_member({ name: 'Claude', access: 'runner', project_access: 'write' });
  lose = false;
  await f.context.invite_member({ name: 'Claude', access: 'runner', project_access: 'read' });
  assert.deepEqual(inputs[1], inputs[0]);
  assert.equal(inputs[0].payload.participants.Claude.project_access, 'write');
  assert.equal(inputs[0].payload.participants.Claude.model, 'sonnet');
  await f.context.invite_member({ name: 'Codex', access: 'runner' });
  assert.equal(inputs[2].payload.participants.Codex.project_access, 'read');
  assert.equal(inputs[2].payload.participants.Codex.session_id, undefined, 'a blank session field starts a new conversation');
  f.context.test_state.room.mode = 'brainstorm';
  await f.context.invite_member({ name: 'Codex', access: 'runner', session_id: ' thread-from-history ' });
  assert.equal(inputs[3].payload.participants[inputs[3].payload.name].session_id, 'thread-from-history', 'the runner resumes the existing conversation');
  assert.match(f.context.test_state.free_notice, /原会话/);
});

test("topic retry retains a pending credential after live refresh has already revealed the new member", () => {
  const f = theme_fixture();
  const room = { id: 'topic', runtime: { mode: 'manual' }, members: [{ name: 'Codex', status: 'active', access: 'manual' }] };
  const experts = { Codex: 'cli', 'Codex-2': 'cli' };
  const original = f.context.topic_member_requests(room, experts);
  assert.equal(original.length, 1);
  room.members.push({ name: 'Codex-2', status: 'active', access: 'manual' });
  const reloaded = theme_fixture(null, f.storage);
  const retry = reloaded.context.topic_member_requests(room, experts);
  assert.equal(retry.length, 1);
  assert.equal(retry[0].member.token, original[0].member.token);
  assert.equal(retry[0].member.name, 'Codex-2');
  f.storage.delete(original[0].key);
  assert.equal(f.context.topic_member_requests(room, experts).length, 0);
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
  assert.equal(state.launch.create, true, "the next form starts with immediate launch on again");
  assert.equal(dialog_closes, 1);
  assert.equal(state.launch.error, '');
});

test("a new room that asks for a discussion is created as a collaboration room, then opened and started", async () => {
  const fixture = theme_fixture();
  const state = fixture.context.test_state;
  const calls = [];
  fixture.nodes.set('room-dialog', { close() {} });
  fixture.nodes.set('room-form', { reset() {} });
  Object.assign(state.launch, { available: true, create: true, profiles: { Codex: { adapter: 'codex_cli', executable: 'C:\\codex.exe' } }, workspace: {} });
  state.create_discussion = true;
  state.named_followup = true;
  Object.assign(fixture.context, {
    crypto: { randomUUID: () => 'token' }, new_submission_id: () => 'submission-1',
    room_creation_payload: () => ({ title: '讨论', goal: ' 选方案 ', mode: 'free', host: 'Codex', experts: { Codex: 'cli' } }),
    read_limits: () => ({ max_rounds: 2, max_minutes: 30, execution_minutes: 0 }),
    render_launch_settings() {}, render_expert_inputs() {}, default_experts: () => ({}), select_room: async () => {}, show_toast() {},
    update_directory: async ({ save, commit }) => { const result = await save(); commit(result); return result; },
    local_launch_request: async () => ({ room: { id: 'created' } }),
    request_json: async (path, body) => { calls.push([path, body]); return path.endsWith('/discussion') && !body ? { revision: 'created-revision', session: null } : {}; },
  });
  await fixture.context.submit_room({ preventDefault() {} });
  assert.deepEqual(calls.map(call => call[0]), ['/api/rooms/created/discussion', '/api/rooms/created/discussion']);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[1][1])), { action: 'start', revision: 'created-revision', goal: '选方案', named_followup: true,
    limits: { max_rounds: 2, max_minutes: 30, execution_minutes: 0 } });
});

test("an existing-room launch keeps its target and preserves newer configuration edits", async () => {
  const fixture = theme_fixture();
  fixture.storage.set('discuss-access:room-a', 'owner-token');
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

test("opening a new form restores every choice to defaults, including per-instance software overrides", () => {
  const f = theme_fixture();
  const state = f.context.test_state;
  let resets = 0, experts = { Codex: 'cli', Claude: 'cli' };
  f.nodes.set('room-form', { reset() { resets++; } });
  Object.assign(f.context, { render_expert_inputs: (_id, value) => { experts = value; }, render_host_options() {}, render_launch_settings() {} });
  Object.assign(state.launch, { create: false, workspace: { cwd: 'D:\上次项目' }, saved_profiles: { Codex: { adapter: 'codex_cli', executable: 'C:\codex.exe' } },
    profiles: { Codex: { adapter: 'codex_cli', executable: 'C:\codex.exe', model: 'gpt-x', project_access: 'write' }, 'Codex-2': { adapter: 'codex_cli' } } });
  state.creation_mode = 'brainstorm';
  state.create_parent = 'free-room';
  state.create_discussion = true;
  f.context.reset_create_form();
  assert.equal(resets, 1);
  assert.deepEqual(Object.keys(experts), []);
  assert.equal(state.creation_mode, 'free', 'every new room starts as a collaboration room');
  assert.equal(state.create_discussion, false);
  assert.equal(state.create_parent, null);
  assert.equal(state.launch.create, true);
  assert.deepEqual(Object.keys(state.launch.workspace), []);
  assert.deepEqual(JSON.parse(JSON.stringify(state.launch.profiles)), { Codex: { adapter: 'codex_cli', executable: 'C:\codex.exe' } });
  state.launch.profiles.Codex.model = 'changed';
  assert.equal(state.launch.saved_profiles.Codex.model, undefined, "drafts never write back into the saved defaults");
});

test("discussions keep only woken members while free rooms keep each member's delivery", () => {
  const f = theme_fixture();
  const state = f.context.test_state;
  const kind = { value: 'brainstorm' };
  const host = { value: '用户' };
  state.creation_mode = 'free';
  f.nodes.set('new-room-kind', kind); f.nodes.set('new-room-host', host);
  let experts = {};
  f.context.read_expert_inputs = () => experts;
  f.context.render_expert_inputs = (_id, value) => { experts = value; };
  state.launch.profiles = { Codex: { adapter: 'codex_cli', executable: 'C:\\codex.exe' },
    Claude: { adapter: 'claude', executable: 'C:\\claude.exe' }, Gemini: { adapter: 'antigravity_cli' } };
  f.context.update_creation_mode();
  assert.equal(host.value, '');
  assert.deepEqual(Object.entries(experts), [], "configured software never fills the roster by itself");
  kind.value = 'free'; f.context.update_creation_mode();
  assert.deepEqual(Object.entries(experts), []);
  experts = { Codex: 'cli', Claude: 'manual', DeepSeek: 'online' }; host.value = 'Codex';
  state.creation_drafts = {};
  kind.value = 'brainstorm'; f.context.update_creation_mode();
  assert.deepEqual(Object.entries(experts), [['Codex', 'cli']], "a first visit carries over only woken members");
  assert.equal(host.value, 'Codex');
  experts = {};
  kind.value = 'free'; f.context.update_creation_mode();
  assert.deepEqual(Object.entries(experts), [['Codex', 'cli'], ['Claude', 'manual'], ['DeepSeek', 'online']], "each use keeps its own draft");
  assert.equal(host.value, 'Codex');
});

/** Invite dialog fixture for the shared member board. */
function participant_connection_fixture() {
  const view = ref({ room: { id: "one", members: [] }, launch: { available: true, profiles: {}, workspace: {} } });
  const pending = ref(""), calls = [];
  const controls = { fail_invite_at: 0 };
  const invites = [];
  const act = async (name, payload) => {
    calls.push(name);
    if (name === "invite_member") invites.push(payload.name);
    if (name === "invite_member" && calls.filter((item) => item === "invite_member").length === controls.fail_invite_at) {
      view.value.free_error = "邀请失败";
      return false;
    }
    return true;
  };
  const dialog = vm.createContext({ computed, ref, watch, defineProps: () => ({}), defineModel: () => ref(false),
    inject: () => ({ view, bridge: { launch_clients: {}, platform_of: (name) => name.split("-")[0],
      unique_instance: (base, taken) => { let name = base; for (let number = 2; taken.has(name); number++) name = `${base}-${number}`; return name; } }, pending, act }) });
  const invite_dialog = readFileSync(new URL("../frontend/InviteDialog.vue", import.meta.url), "utf8");
  vm.runInContext(invite_dialog.match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import .*;$/gm, ""), dialog);
  return { dialog, view, calls, invites, controls };
}

test("session progress board keeps skip available only for the current turn and preserves owner controls", () => {
  const source = readFileSync(new URL("../frontend/ProgressBoard.vue", import.meta.url), "utf8");
  assert.match(source, /const can_control = computed\(\(\) => Boolean\(view\.value\.access\?\.can_manage\) && !room\.value\.archived\)/);
  assert.match(source, /v-if="turn && !paused"[^\n]*:disabled="!can_control \|\| !!pending"/);
  assert.match(source, /v-if="paused"[^\n]*label="继续"[^\n]*:disabled="!can_control \|\| !!pending"/);
  assert.match(source, /v-else[^\n]*label="暂停"[^\n]*:disabled="!can_control \|\| !!pending"/);
});

test("batch invitation admits woken members before manual ones and lists the manual members for copying", async () => {
  const { dialog: context, invites } = participant_connection_fixture();
  vm.runInContext("inviting.value = true", context);
  await Promise.resolve();
  vm.runInContext('invite_picks.value = [["Codex", "manual"], ["Claude", "cli"], ["Gemini", "manual"], ["DeepSeek", "cli"]].map(([name, mode]) => ({ name, mode }));', context);
  await context.invite();
  assert.equal(invites.join(), "Claude,DeepSeek,Codex,Gemini");
  assert.equal(vm.runInContext("invited_manual.value.join()", context), "Codex,Gemini");
  assert.equal(vm.runInContext("invite_picks.value.length", context), 0);
  assert.equal(vm.runInContext("inviting.value", context), true, "the dialog stays for the copy step");
});

test("batch invitation stops at the first failure and keeps the remaining picks for a retry", async () => {
  const { dialog: context, calls, controls, view } = participant_connection_fixture();
  controls.fail_invite_at = 2;
  vm.runInContext("inviting.value = true", context);
  await Promise.resolve();
  vm.runInContext('invite_picks.value = ["Codex", "Claude", "Gemini"].map((name) => ({ name, mode: "manual" }));', context);
  await context.invite();
  assert.deepEqual(calls, ["invite_member", "invite_member"]);
  assert.equal(vm.runInContext("invite_picks.value.map((pick) => pick.name).join()", context), "Claude,Gemini");
  assert.equal(vm.runInContext("invited_manual.value.join()", context), "Codex");
  assert.equal(view.value.free_error, "邀请失败");
});

test("shared member menu retains away and rejoin, but protects the current discussion host", async () => {
  const calls = [];
  const view = { access: { can_manage: true, members: [] }, launch: { available: true }, room: { session: { status: "active" } } };
  const menu_for = member => member_actions(member, { view, act: (...args) => calls.push(args), describe: () => {} });
  const labels = member => menu_for(member).flat().map(item => item.label);
  const host = { id: 1, name: "Claude", role: "host", access: "runner", status: "active" };
  assert.ok(!labels(host).includes("离开") && !labels(host).includes("移除"));
  const expert = { id: 2, name: "Codex", access: "manual", status: "active" };
  assert.deepEqual(labels(expert), ["复制启动指令（含凭证）", "编辑描述", "复制参与说明", "下载私有配置", "复制凭证文本", "设为主持人", "离开", "移除"]);
  const away = { id: 3, name: "Gemini", access: "manual", status: "away" };
  assert.ok(labels(away).includes("请回") && labels(away).includes("移除"));
  await menu_for(away).flat().find(item => item.label === "请回").onSelect();
  assert.deepEqual(calls[0], ["change_member", { member_id: 3, name: "Gemini", action: "rejoin" }]);
  view.room.session.status = "paused";
  assert.ok(!labels(host).includes("离开") && !labels(host).includes("移除"), "paused sessions protect the current host too");
  view.room.session.status = "ended";
  assert.ok(labels(host).includes("离开") && labels(host).includes("移除"), "host protection ends with the session");
  view.access.can_manage = false;
  assert.ok(menu_for(expert).flat().every(item => item.disabled), "every shared action stays disabled without manage permission");
});

test("shared member menus are owned by FreeBoard while ProgressBoard only owns session controls", () => {
  const free_board = readFileSync(new URL("../frontend/FreeBoard.vue", import.meta.url), "utf8");
  const progress_board = readFileSync(new URL("../frontend/ProgressBoard.vue", import.meta.url), "utf8");
  assert.match(free_board, /import \{ busy, member_actions \} from "\.\/member-actions\.js"/);
  assert.match(free_board, /member_actions\(member, \{ view: view\.value, act, describe:/);
  assert.doesNotMatch(progress_board, /member_menu|member_actions|member_status/);
  assert.match(progress_board, /aria-label="讨论状态"/);
});

test("room overview does not mark web manual members as waiting for registration", () => {
  const component = readFileSync(new URL("../frontend/RoomOverview.vue", import.meta.url), "utf8");
  const declaration = component.match(/const unregistered = \(member\) => [^;]+;/)?.[0];
  assert.ok(declaration, "the member registration rule is explicit");
  const context = vm.createContext({});
  vm.runInContext(`${declaration}\nglobalThis.is_unregistered = unregistered;`, context);
  assert.equal(context.is_unregistered({ access: "manual", manual_source: "web" }), false);
  assert.equal(context.is_unregistered({ access: "manual" }), true, "local manual members still require registration");
  assert.equal(context.is_unregistered({ access: "manual", registered_at: "now" }), false);
  assert.match(component, /unregistered\(member\) \? '待注册'/);
});

test("room overview keeps the original-session adapter switch, while connection repair waits for a paused session", () => {
  const overview = readFileSync(new URL("../frontend/RoomOverview.vue", import.meta.url), "utf8");
  const topic_panel = readFileSync(new URL("../frontend/TopicPanel.vue", import.meta.url), "utf8");
  assert.match(overview, /editable: free\.value && idle && view\.value\.access\?\.can_manage && view\.value\.launch\.available/);
  assert.match(overview, /切换后沿用原会话/);
  assert.match(overview, /await bridge\.set_member_adapter\(\{ name: member\.name, adapter \}\)/);
  assert.match(topic_panel, /const paused = computed\(\(\) => room\.value\?\.session\?\.status === "paused"\)/);
  assert.match(topic_panel, /v-if="paused && view\.launch\.available && !room\.archived && !view\.launch\.remote"[\s\S]*?@click="act\('load_room_configuration'\)"/);
  assert.match(topic_panel, /保存本场接入设置[\s\S]*?@click="act\('save_room_configuration'\)"/);
});

test("host arrangements remain in history after the session concludes", () => {
  const start = discussion_source.indexOf("const host_arrangements = computed(");
  const end = discussion_source.indexOf("/** Clicking the current verdict", start);
  const view = ref({ query: "", mention_only: false, room: { session: { status: "concluded" }, host_arrangements: [
    { key: "session-2", id: 2, after_message_id: 0, turns: [{ expert: "Codex" }] },
  ] } });
  const room = computed(() => view.value.room);
  const context = vm.createContext({ computed, view, room, bridge: { display_name: name => name } });
  vm.runInContext(`${discussion_source.slice(start, end)}\nglobalThis.arrangements = host_arrangements;`, context);
  assert.deepEqual([...context.arrangements.value.get(0)].map(item => item.key), ["session-2"]);
  assert.equal(context.arrangements.value.get(0)[0].label, "Codex");
});

test("round navigation separates sessions with the same round number and leaves post-session messages ungrouped", () => {
  const start = discussion_source.indexOf("const navigation_groups = computed(");
  const end = discussion_source.indexOf("const active_round = computed", start);
  const view = ref({ messages: [1, 2, 3, 4, 5].map(id => ({ id, author: "Codex" })) });
  const room = computed(() => ({ experts: { Codex: "cli" }, round_groups: [
    { key: "legacy-round-1", number: 1, start_id: 1, participants: 1, opinions: 1, completed: true, speakers: ["Codex"] },
    { key: "session-1-round-1", number: 1, start_id: 2, end_id: 2, participants: 1, opinions: 1, completed: true, speakers: ["Codex"] },
    { key: "session-2-round-1", number: 1, start_id: 3, end_id: 4, participants: 1, opinions: 1, completed: true, speakers: ["Codex"] },
  ] }));
  const transcript_messages = computed(() => view.value.messages);
  const bridge = { round_groups: value => value.round_groups, display_name: name => name };
  const context = vm.createContext({ computed, view, room, transcript_messages, bridge });
  vm.runInContext(`${discussion_source.slice(start, end)}\nglobalThis.groups = navigation_groups;`, context);
  assert.deepEqual(JSON.parse(JSON.stringify([...context.groups.value].map(group => [group.key, group.number, group.messages.map(message => message.id)]))), [
    ["legacy-round-1", 1, [1]], ["session-1-round-1", 1, [2]], ["session-2-round-1", 1, [3, 4]], ["ungrouped", 0, [5]],
  ]);
});

test("a concluded session still protects messages at or before its start from ordinary message actions", () => {
  const start = discussion_source.indexOf("const can_branch =");
  const end = discussion_source.indexOf("const can_retract =", start);
  const free = ref(true), view = ref({ access: { can_manage: true } });
  const room = ref({ archived: false, session: { status: "concluded", started_message_id: 10 }, discussions: [] });
  const context = vm.createContext({ free, view, room });
  vm.runInContext(`${discussion_source.slice(start, end)}\nglobalThis.actions = { can_branch, can_take_back };`, context);
  assert.equal(context.actions.can_branch({ id: 10, author: "Codex" }), false);
  assert.equal(context.actions.can_take_back({ id: 10, author: "用户" }), false);
  assert.equal(context.actions.can_branch({ id: 11, author: "Codex" }), true, "later free-room history remains branchable");
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
  f.context.write_room_adapter('Codex', 'codex');
  f.context.write_room_adapter('Codex', 'claude');
  assert.equal(state.launch.profiles.Codex.executable, 'machine-default');
  f.context.local_launch_request = async (_action, input) => {
    assert.equal(input.token, 'owner'); assert.equal(input.version, 'v1');
    assert.deepEqual(Object.keys(input.participants.Codex), ['executable', 'adapter']);
    assert.equal(input.participants.Codex.adapter, 'codex');
    return { ...input, applied: false };
  };
  await f.context.save_room_configuration();
  assert.match(state.launch.repair.notice, /尚未确认采用/);
  f.context.local_launch_request = async () => { state.room = { id: 'two' }; return { room_id: 'one' }; };
  await f.context.load_room_configuration();
  assert.equal(state.launch.repair.participants.Codex.executable, 'fixed-path');
});

test("model discovery shares executable catalogs without leaking a late response into another software draft", async () => {
  const f = theme_fixture(), state = f.context.test_state, requests = [];
  Object.assign(f.context, { render_launch_settings() {} });
  Object.assign(state.launch, { available: true, profiles: { Codex: { adapter: "codex_cli", executable: "first.exe" }, "Codex-2": { adapter: "codex_cli", executable: "first.exe" } } });
  let release;
  f.context.local_launch_request = (action, input) => { requests.push({ action, input }); return new Promise(resolve => { release = resolve; }); };
  const pending = f.context.load_launch_models("Codex");
  await f.context.load_launch_models("Codex-2");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].action, "models");
  assert.deepEqual(JSON.parse(JSON.stringify(requests[0].input)), { adapter: "codex_cli", executable: "first.exe" });
  state.launch.profiles.Codex.adapter = "claude";
  release({ adapter: "codex_cli", models: [{ id: "codex-model", label: "Codex Model", efforts: ["high"] }], source: "codex-app-server" });
  await pending;
  assert.equal(f.context.launch_model_state("Codex").items.length, 1);
  assert.equal(f.context.launch_model_state("Codex-2").items[1].value, "codex-model");
  state.launch.profiles["Codex-2"].executable = "second.exe";
  assert.equal(f.context.launch_model_state("Codex-2").items.length, 1);
  f.context.local_launch_request = async () => ({ adapter: "codex_cli", models: [{ id: "second-model" }] });
  await f.context.load_launch_models("Codex-2");
  assert.equal(f.context.launch_model_state("Codex-2").items[1].value, "second-model");
});

test("model discovery failure keeps only software defaults and saved values until an explicit retry succeeds", async () => {
  const f = theme_fixture(), state = f.context.test_state;
  f.context.render_launch_settings = () => {};
  Object.assign(state.launch, { available: true, profiles: { Claude: { adapter: "claude", model: "previous-model" } } });
  let count = 0;
  f.context.local_launch_request = async () => { count++; throw new Error("软件无法读取模型目录"); };
  await f.context.load_launch_models("Claude");
  await f.context.load_launch_models("Claude");
  const failed = f.context.launch_model_state("Claude");
  assert.equal(count, 1);
  assert.match(failed.error, /无法读取/);
  assert.equal(failed.items.length, 2);
  assert.equal(failed.items[0].value, "__default__");
  assert.equal(failed.items[1].value, "previous-model");
  assert.equal(failed.items[1].disabled, true);
  f.context.local_launch_request = async () => ({ adapter: "claude", models: [{ id: "available-model", label: "Available Model", efforts: [] }], source: "claude-cli" });
  await f.context.load_launch_models("Claude", true);
  assert.equal(f.context.launch_model_state("Claude").error, "");
  assert.equal(f.context.launch_model_state("Claude").items[1].value, "available-model");
  assert.equal(state.launch.profiles.Claude.model, "previous-model");
});

test("agy effort choices follow the selected native model without overriding software defaults", async () => {
  const f = theme_fixture(), state = f.context.test_state, requests = [];
  Object.assign(f.context, { render_launch_settings() {}, render_launch_summaries() {} });
  Object.assign(state.launch, { available: true, profiles: { Gemini: { adapter: "antigravity_cli", executable: "agy.exe" } } });
  f.context.local_launch_request = async (_action, input) => {
    requests.push(input);
    return { adapter: "antigravity_cli", models: [{ id: "native-model" }],
      efforts: input.model ? ["low", "high"] : ["low", "medium", "high"] };
  };
  await f.context.load_launch_models("Gemini");
  assert.equal(state.launch.profiles.Gemini.model, undefined);
  assert.equal(state.launch.profiles.Gemini.effort, undefined);
  assert.deepEqual(Array.from(f.context.launch_model_state("Gemini").efforts), ["low", "medium", "high"]);
  f.context.write_launch_field("Gemini", "effort", "medium");
  f.context.write_launch_model("Gemini", "native-model");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests[1].model, "native-model");
  assert.equal(state.launch.profiles.Gemini.effort, "");
  assert.deepEqual(Array.from(f.context.launch_model_state("Gemini").efforts), ["low", "high"]);
  f.context.write_launch_field("Gemini", "effort", "low");
  const room = { id: "room", runtime: { mode: "automatic" }, members: [{ name: "Gemini", access: "runner" }] };
  assert.match(f.context.participant_model("Gemini", room, { room_id: "room", participants: { Gemini: state.launch.profiles.Gemini } }), /low/);
  f.context.write_launch_model("Gemini", "__default__");
  assert.equal(requests.length, 2, "returning to the default model reuses its native capability query");
  assert.deepEqual(Array.from(f.context.launch_model_state("Gemini").efforts), ["low", "medium", "high"]);
});

test("choosing a discovered model applies its effort choices only to the selected instance", async () => {
  const f = theme_fixture(), state = f.context.test_state;
  Object.assign(f.context, { render_launch_settings() {}, render_launch_summaries() {} });
  Object.assign(state.launch, { available: true, profiles: { Codex: { adapter: "codex_cli", effort: "ultra" }, "Codex-2": { adapter: "codex_cli", model: "other-model", effort: "ultra" } } });
  f.context.local_launch_request = async () => ({ adapter: "codex_cli", models: [{ id: "limited", efforts: ["low", "high"] }, { id: "no-effort", efforts: [] }] });
  await f.context.load_launch_models("Codex");
  f.context.write_launch_model("Codex", "limited");
  assert.equal(state.launch.profiles.Codex.model, "limited");
  assert.equal(state.launch.profiles.Codex.effort, "");
  assert.deepEqual(Array.from(f.context.launch_model_state("Codex").efforts), ["low", "high"]);
  f.context.write_launch_field("Codex", "effort", "high");
  f.context.write_launch_model("Codex", "no-effort");
  assert.equal(state.launch.profiles.Codex.effort, "");
  assert.equal(f.context.launch_model_state("Codex").efforts.length, 0);
  assert.equal(state.launch.profiles["Codex-2"].model, "other-model");
  assert.equal(state.launch.profiles["Codex-2"].effort, "ultra");
  f.context.write_launch_model("Codex", "__default__");
  assert.equal(state.launch.profiles.Codex.model, "");
  assert.equal(f.context.launch_model_state("Codex").efforts, undefined);
  assert.match(f.context.launch_model_state("Codex").effort_note, /默认值由软件决定/);
});

test("room model readback stays separate from drafts, reloads on revision and discards a different room's late response", async () => {
  const f = theme_fixture(), state = f.context.test_state;
  state.launch.available = true;
  state.launch.profiles = { Codex: { model: 'new-discussion-draft', effort: 'low' } };
  state.room = { id: 'one', runtime: { mode: 'automatic', revision: 1 } };
  const requests = [];
  f.context.local_launch_request = async (action, input) => {
    requests.push({ action, input });
    return { room_id: input.room_id, participants: { Codex: { adapter: 'codex_cli', model: 'saved-model', effort: 'high' } } };
  };
  await f.context.load_room_models();
  assert.equal(state.launch.room_models.participants.Codex.model, 'saved-model');
  assert.equal(state.launch.profiles.Codex.model, 'new-discussion-draft');
  assert.equal(JSON.stringify(requests[0].input), JSON.stringify({ room_id: 'one', quick: true }));
  await f.context.load_room_models();
  assert.equal(requests.length, 1);
  state.room.runtime.revision++;
  await f.context.load_room_models();
  assert.equal(requests.length, 2);
  let release;
  state.room.runtime.revision++;
  f.context.local_launch_request = () => new Promise(resolve => { release = resolve; });
  const pending = f.context.load_room_models();
  state.room = { id: 'two', runtime: { mode: 'automatic', revision: 1 } };
  f.context.local_launch_request = async () => ({ room_id: 'two', participants: {} });
  await f.context.load_room_models();
  release({ room_id: 'one', participants: { Codex: { model: 'late' } } });
  await pending;
  assert.equal(state.launch.room_models.room_id, 'two');
  assert.equal(state.launch.room_models.participants.Codex, undefined);
  state.room.runtime.revision++;
  f.context.local_launch_request = async () => { throw new Error('old bridge'); };
  await f.context.load_room_models();
  assert.equal(state.launch.room_models.loading, false);
  assert.equal(state.launch.room_models.participants, null);
  // agy's slow default model follows in a second, full read; the rest is shown first.
  state.room = { id: 'three', runtime: { mode: 'automatic', revision: 1 } };
  const quick_reads = [];
  f.context.local_launch_request = async (action, input) => {
    quick_reads.push(input.quick === true);
    return { room_id: 'three', participants: { Gemini: input.quick
      ? { adapter: 'antigravity_cli', model: '', defaults_pending: true } : { adapter: 'antigravity_cli', model: '', default_model: 'gemini-x' } } };
  };
  await f.context.load_room_models();
  assert.equal(quick_reads.join(), 'true,false');
  assert.equal(state.launch.room_models.participants.Gemini.default_model, 'gemini-x');
});

test("participant model labels distinguish explicit choices, software defaults and unavailable room data", () => {
  const label = theme_fixture().context.participant_model;
  const room = { id: 'one', runtime: { mode: 'automatic' } };
  const saved = { room_id: 'one', participants: {
    Codex: { adapter: 'codex_cli', model: 'gpt-6-astra', effort: 'xhigh' },
    Claude: { adapter: 'claude', model: '', effort: '' },
    Gemini: { adapter: 'antigravity_cli', model: 'gemini-4-argon-high', effort: '' },
    Reviewer: { adapter: 'codex_cli', model: '', effort: '', default_model: 'gpt-6-astra', default_effort: 'xhigh' },
    Agy: { adapter: 'antigravity_cli', model: '', effort: '', default_model: 'gemini-4-argon-medium', default_effort: 'medium' },
    AgyPicked: { adapter: 'antigravity_cli', model: 'gemini-4-argon-high', effort: '', default_model: 'gemini-4-argon-medium', default_effort: 'medium' },
  } };
  assert.equal(label('Agy', room, saved), 'gemini-4-argon-medium · medium');
  assert.equal(label('AgyPicked', room, saved), 'gemini-4-argon-high · 默认', 'a chosen agy model does not borrow the default model effort');
  assert.equal(label('Codex', room, saved), 'gpt-6-astra · xhigh');
  assert.equal(label('Claude', room, saved), '默认');
  assert.equal(label('Reviewer', room, saved), 'gpt-6-astra · xhigh', 'an empty choice shows what the software settings select');
  assert.equal(label('Gemini', room, saved), 'gemini-4-argon-high · 默认');
  assert.equal(label('Codex', { ...room, id: 'two' }, saved), '', 'unread settings are not guessed or shown as a placeholder');
  assert.equal(label('Codex', room, null), '');
  saved.participants.Codex.adapter = 'codex';
  assert.equal(label('Codex', room, saved), '默认');
  saved.participants.Codex.actual_model = 'gpt-6-sol';
  saved.participants.Codex.actual_effort = 'low';
  assert.equal(label('Codex', room, saved), 'gpt-6-sol · low', 'an App member shows what its session last ran with');
  saved.participants.Claude = { adapter: 'claude', model: 'opus', effort: '', actual_model: 'claude-opus-5-5', actual_effort: 'high', default_effort: 'low' };
  assert.equal(label('Claude', room, saved), 'opus · high', 'the card choice wins; an empty one shows the session before the settings file');
  saved.participants.Agy = { adapter: 'antigravity_cli', model: '', effort: '', defaults_pending: true, actual_model: 'gemini-4-argon-low' };
  assert.equal(label('Agy', room, saved), 'gemini-4-argon-low · 默认', 'a known session model needs no slow default read');
  assert.equal(label('Codex', { ...room, runtime: { mode: 'manual' } }, saved), '');
  assert.equal(label('Codex', { ...room, members: [{ name: 'Codex', access: 'manual' }] }, saved), '', 'a manual member sets its model in its own session');
  saved.participants.Codex.adapter = 'codex_cli';
  assert.equal(label('Codex', { ...room, runtime: { mode: 'manual' }, members: [{ name: 'Codex', access: 'runner' }] }, saved), 'gpt-6-astra · xhigh',
    'a free room runs no discussion yet its woken members still show their model');
});

test("participant files show 只读 / 可写 only where the site decides them", () => {
  const files = theme_fixture().context.participant_files;
  const room = { id: 'one', members: [{ name: 'Codex', access: 'runner' }, { name: 'Claude', access: 'runner' }, { name: 'App', access: 'runner' },
    { name: 'Api', access: 'runner' }, { name: 'Web', access: 'online' }, { name: 'Manual', access: 'manual' }] };
  const saved = { room_id: 'one', participants: { Codex: { adapter: 'codex_cli', project_access: 'write' }, Claude: { adapter: 'claude' },
    App: { adapter: 'codex' }, Api: { adapter: 'api', project_access: 'write' } } };
  assert.deepEqual(['Codex', 'Claude', 'App', 'Api', 'Web', 'Manual'].map((name) => files(name, room, saved)), ['可写', '只读', '', '只读', '只读', '']);
  assert.equal(files('Codex', room, null), '', 'unread settings are not guessed');
});

test("a borrowed session's hover says whether its original window shows the room's tasks", () => {
  const hint = theme_fixture().context.participant_session_hint;
  const room = { id: 'one', members: [{ name: 'Claude', access: 'runner', session_mode: 'borrowed', adapter: 'claude' },
    { name: 'Claude-2', access: 'runner', session_mode: 'borrowed', adapter: 'claude' }, { name: 'Codex', access: 'runner', session_mode: 'borrowed', adapter: 'codex' },
    { name: 'Gemini', access: 'runner', session_mode: 'borrowed', adapter: 'antigravity_cli' }, { name: 'New', access: 'runner', session_mode: 'new', adapter: 'claude' }] };
  const saved = { room_id: 'one', participants: { Claude: { adapter: 'claude', project_access: 'own' }, 'Claude-2': { adapter: 'claude', project_access: 'read' } } };
  assert.match(hint('Claude', room, saved), /原窗口开着时任务直接送进该窗口/, 'a taken-over Claude member works in its open window');
  assert.match(hint('Codex', room, saved), /App 里的这个会话/);
  for (const name of ['Claude-2', 'Gemini']) assert.match(hint(name, room, saved), /不要在原窗口继续操作/, `${name} resumes in the background`);
  assert.equal(hint('New', room, saved), undefined);
});

test("empty automatic discussions describe their actual state instead of requiring another message", () => {
  const message = theme_fixture().context.empty_discussion_message;
  for (const [status, pattern] of [['ready', /尚未启动/], ['running', /等待 AI 执行/], ['paused', /已暂停/], ['stopped', /已停止/]]) {
    assert.match(message({ phase: 'preparing', runtime: { mode: 'automatic', status } }), pattern);
  }
  assert.match(message({ phase: 'concluded' }), /已结束/);
});

/** Evaluate the unified execution card and transcript slot calculations with reactive room snapshots. */
function free_card_fixture({ messages = [], members = [], executions = [], query = "", mention_only = false, now = 1000 } = {}) {
  const timers = new Map();
  let timer_id = 0, current_time = now;
  class TestDate extends Date { static now() { return current_time * 1000; } }
  const view = reactive({ value: { query, mention_only, messages, access: { can_manage: true }, room: {
    id: "room", mode: "free", archived: false, members: [], free: { members, executions, requests: [] }, session: null,
  } } });
  const context = vm.createContext({ computed, ref, watch, view, room: computed(() => view.value.room), Date: TestDate,
    setInterval: callback => { timers.set(++timer_id, callback); return timer_id; }, clearInterval: id => timers.delete(id),
    bridge: { request: async () => ({ notes: [] }) } });
  const busy_start = discussion_source.indexOf("const free = computed(");
  const busy_end = discussion_source.indexOf("/** Progress notes per execution id", busy_start);
  vm.runInContext(`${discussion_source.slice(busy_start, busy_end)}\nglobalThis.cards = { busy: free_busy, working: free_working, now: free_now };`, context);
  const layout_start = discussion_source.indexOf("const free_failures = computed(");
  const layout_end = discussion_source.indexOf("/** Split continuous history", layout_start);
  vm.runInContext(`${discussion_source.slice(layout_start, layout_end)}\nglobalThis.layout_state = { failures: free_failures, layout: free_layout, rewinds: rewound_runs, toggle: toggle_rewound };`, context);
  return { context, view: view.value, room: view.value.room, cards: context.cards, state: context.layout_state, timers,
    advance(seconds) { current_time += seconds; for (const callback of timers.values()) callback(); } };
}

function execution_member(id, name = "Codex", status = "dispatched", extra = {}) {
  return { id, name, access: "runner", status: "active", adapter: "claude_code", pending: 0,
    execution: { id, status, stale: false, created_at: 1000, activity_at: 1000, ...extra } };
}

test("free execution cards show live member work and hide inactive executions", async () => {
  const member = execution_member(9), execution = { id: 9, member_id: 9, member: "Codex", status: "dispatched", request_message_id: 1, created_at: 1000 };
  const f = free_card_fixture({ messages: [{ id: 1, author: "用户", created_at: 1000 }], members: [member], executions: [execution] });
  assert.deepEqual(f.cards.working.value.map(item => [item.id, item.author, item.text, item.working]), [["free-9", "Codex", "正在处理", true]]);
  assert.deepEqual([...f.state.layout.value].map(item => item.id), [1, "free-9"]);
  for (const status of ["pending", "completed", "cancelled"]) {
    f.room.free.members[0].execution.status = status;
    await nextTick();
    assert.equal(f.cards.busy.value.length, 0, status);
  }
  f.room.free.members[0].execution.status = "failed";
  f.room.free.executions[0].status = "failed";
  await nextTick();
  assert.equal(f.cards.busy.value.length, 0, "a failed attempt leaves the working-card state");
  assert.equal(f.state.failures.value.length, 1, "a failed execution remains as its own failure card");
});

test("execution cards obey transcript filters and disappear when the room is archived", async () => {
  const member = execution_member(9), f = free_card_fixture({ members: [member] });
  assert.equal(f.cards.working.value.length, 1);
  f.view.query = "历史";
  await nextTick();
  assert.equal(f.cards.working.value.length, 0);
  assert.equal(f.cards.busy.value.length, 1, "filtering hides the card without changing execution state");
  f.view.query = "";
  f.view.mention_only = true;
  await nextTick();
  assert.equal(f.cards.working.value.length, 0);
  f.view.mention_only = false;
  f.room.archived = true;
  await nextTick();
  assert.equal(f.cards.busy.value.length, 0);
  assert.equal(f.cards.working.value.length, 0);
});

test("a manual request with no execution stays out of the middle transcript", () => {
  const message = { id: 1, author: "用户", created_at: 1000 };
  const f = free_card_fixture({ messages: [message], members: [{ id: 2, name: "Claude", access: "manual", status: "active", pending: 1 }],
    executions: [], query: "" });
  f.room.free.requests.push({ id: 3, member_id: 2, message_id: 1, status: "pending" });
  assert.equal(f.cards.busy.value.length, 0);
  assert.equal(f.cards.working.value.length, 0);
  assert.deepEqual([...f.state.layout.value].map(item => item.id), [1]);
  assert.equal(f.room.free.requests[0].status, "pending", "the request remains available to the right-side progress board");
});

test("cancelled session work replaces its slot, supports anchor zero and stays out of filtered views", async () => {
  const member = execution_member(7, "Codex", "started");
  const execution = { id: 7, member_id: 7, member: "Codex", status: "started", request_message_id: 900, created_at: 1002,
    requests: [{ discussion_session_id: 3, after_message_id: 10 }] };
  const f = free_card_fixture({ messages: [{ id: 10, author: "用户", created_at: 1000 }, { id: 11, author: "用户", created_at: 1001 }], members: [member], executions: [execution] });
  f.room.cancelled_turns = [{ key: "session-2-before-history", id: 8, expert: "Claude", execution_id: 8, after_message_id: 0, created_at: "2026-10-29T10:00:00Z" }];
  const ids = () => [...f.state.layout.value].map(item => item.id);
  assert.deepEqual(ids(), ["cancelled-session-2-before-history", 10, "free-7", 11]);
  f.room.free.members[0].execution.status = "cancelled";
  f.room.free.executions[0].status = "cancelled";
  f.room.cancelled_turns.push({ key: "session-3-work-7", id: 7, expert: "Codex", execution_id: 7, after_message_id: 10, created_at: "2026-10-29T10:00:02Z" });
  await nextTick();
  assert.deepEqual(ids(), ["cancelled-session-2-before-history", 10, "cancelled-session-3-work-7", 11], "cancelled work stays at the execution's original anchor");
  f.view.query = "历史";
  await nextTick();
  assert.deepEqual(ids(), [10, 11], "search filtering suppresses cancelled cards");
  f.view.query = "";
  f.view.mention_only = true;
  await nextTick();
  assert.deepEqual(ids(), [10, 11], "mention filtering suppresses cancelled cards");
});

test("stopped host executions replace their work at the same anchor and avoid missed-card duplicates", async () => {
  const host = execution_member(1, "Claude", "started");
  host.role = "host";
  const expert = execution_member(2, "Codex", "started");
  const missed = execution_member(3, "Gemini", "cancelled");
  const executions = [
    { id: 1, member_id: 1, member: "Claude", role: "host", status: "started", request_message_id: 901, created_at: 1001,
      requests: [{ discussion_session_id: 9, purpose: "discuss_host", after_message_id: 0 }] },
    { id: 2, member_id: 2, member: "Codex", role: "member", status: "started", request_message_id: 902, created_at: 1002,
      requests: [{ discussion_session_id: 9, purpose: "discuss", after_message_id: 10 }] },
    { id: 3, member_id: 3, member: "Gemini", role: "member", status: "cancelled", request_message_id: 903, created_at: 1003,
      requests: [{ discussion_session_id: 9, purpose: "discuss", after_message_id: 10 }] },
  ];
  const f = free_card_fixture({ messages: [{ id: 10, author: "用户", created_at: 1000 }, { id: 11, author: "用户", created_at: 1004 }],
    members: [host, expert, missed], executions });
  f.room.cancelled_turns = [{ key: "session-9-request-3", id: 3, expert: "Gemini", execution_id: 3,
    after_message_id: 10, created_at: "2026-10-29T10:00:03Z" }];
  const ids = () => [...f.state.layout.value].map(item => item.id);
  assert.deepEqual(ids(), ["free-1", 10, "free-2", "cancelled-session-9-request-3", 11]);
  f.room.free.members[0].execution.status = "cancelled";
  f.room.free.members[1].execution.status = "cancelled";
  f.room.free.executions[0].status = "cancelled";
  f.room.free.executions[1].status = "cancelled";
  await nextTick();
  assert.deepEqual(ids(), ["stopped-1", 10, "stopped-2", "cancelled-session-9-request-3", 11],
    "the host stop stays at anchor zero, the expert stop stays after its source, and a missed execution is not duplicated");
  assert.equal(f.state.layout.value.filter(item => item.execution_id === 3).length, 1);
  assert.equal(f.state.layout.value[0].cancelled_execution.status, "cancelled");
  f.view.query = "历史";
  await nextTick();
  assert.deepEqual(ids(), [10, 11], "search hides stopped and missed cards");
  f.view.query = "";
  f.view.mention_only = true;
  await nextTick();
  assert.deepEqual(ids(), [10, 11], "mention filtering hides stopped and missed cards");
  assert.match(discussion_source, /v-else-if="message\.cancelled_turn \|\| message\.cancelled_execution"/);
  assert.match(discussion_source, /已停止 · 执行 #\{\{ message\.execution_id \}\}/);
});

test("host arrangements share anchor-zero ordering with working and stopped cards", async () => {
  const host = execution_member(1, "Claude", "started");
  host.role = "host";
  const stopped_host = execution_member(2, "Claude", "cancelled");
  stopped_host.role = "host";
  const f = free_card_fixture({ messages: [{ id: 10, author: "用户", created_at: 1000 }], members: [host, stopped_host], executions: [
    { id: 1, member_id: 1, member: "Claude", role: "host", status: "started", request_message_id: 901, created_at: 1001,
      requests: [{ discussion_session_id: 9, purpose: "discuss_host", after_message_id: 0 }] },
    { id: 2, member_id: 2, member: "Claude", role: "host", status: "cancelled", request_message_id: 902, created_at: 1003,
      requests: [{ discussion_session_id: 9, purpose: "discuss_host", after_message_id: 0 }] },
  ] });
  f.room.host_arrangements = [
    { id: 1, key: "plan-1", after_message_id: 0, created_at: new Date(1000 * 1000).toISOString(), turns: [{ expert: "Codex" }] },
    { id: 2, key: "plan-2", after_message_id: 0, created_at: new Date(1002 * 1000).toISOString(), turns: [{ expert: "Gemini" }] },
  ];
  const ids = () => [...f.state.layout.value].map(item => item.id);
  assert.deepEqual(ids(), ["plan-1", "free-1", "plan-2", "stopped-2", 10],
    "arrangements and host executions at anchor zero follow their original creation times");
  f.view.query = "历史";
  await nextTick();
  assert.deepEqual(ids(), [10], "search hides anchor-zero arrangements and execution cards");
  f.view.query = "";
  f.view.mention_only = true;
  await nextTick();
  assert.deepEqual(ids(), [10], "mention filtering hides anchor-zero arrangements and execution cards");
});

test("execution clocks tick locally and manual delivery retries keep their countdown and controls", async () => {
  const member = execution_member(9, "Claude", "started", { retry: { retry_at: 1010, stopped: false, reason: "会话未响应", attempt: 2 } });
  const f = free_card_fixture({ members: [member] });
  const status_start = discussion_source.indexOf("function working_status(");
  const status_end = discussion_source.indexOf("/** Says in the note line", status_start);
  vm.runInContext(`${discussion_source.slice(status_start, status_end)}\nglobalThis.get_status = working_status;`, f.context);
  const card = f.cards.working.value[0];
  assert.equal(card.working, false);
  assert.equal(card.retry.reason, "会话未响应");
  assert.equal(f.context.get_status(card).text, "会话异常，等待自动重试");
  assert.equal(card.retry.retry_at - f.cards.now.value, 10);
  f.advance(7);
  await nextTick();
  assert.equal(card.retry.retry_at - f.cards.now.value, 3);
  f.advance(3);
  await nextTick();
  assert.equal(card.retry.retry_at - f.cards.now.value, 0);
  assert.match(discussion_source, /message\.retry\.retry_at > free_now \? `\$\{message\.retry\.retry_at - free_now\} 秒后自动重试` : '正在重试'/);
  assert.match(discussion_source, /label="立即重试"/);
  assert.match(discussion_source, /label="停止"/);
});

test("discussion execution cards keep one visible-message anchor through work, failure and answer", async () => {
  const source = { discussion_session_id: 4, after_message_id: 10, source_message_id: 10 };
  const member = execution_member(12, "DeepSeek");
  const execution = { id: 12, member_id: 12, member: "DeepSeek", status: "started", request_message_id: 900,
    created_at: 1002, requests: [source] };
  member.execution.created_at = 1002;
  const messages = [{ id: 10, author: "用户", created_at: 1000 }, { id: 11, author: "用户", created_at: 1001 }];
  const f = free_card_fixture({ messages, members: [member], executions: [execution] });
  const working_ids = () => [...f.state.layout.value].map(item => item.id);
  assert.deepEqual(working_ids(), [10, "free-12", 11]);
  assert.equal(f.view.messages.some(message => message.id === 900), false, "the internal discussion request is not a visible message");
  f.room.free.executions[0].status = "failed";
  f.room.free.members[0].execution.status = "failed";
  f.room.free.executions[0].finished_at = 1010;
  f.room.free.executions[0].result = "模型暂时不可用";
  await nextTick();
  assert.deepEqual(working_ids(), [10, "failed-12", 11]);
  assert.equal(f.state.failures.value[0].failure.result, "模型暂时不可用");
  f.room.free.executions[0].status = "completed";
  f.room.free.executions[0].answer_id = 13;
  f.room.free.members[0].execution.status = "completed";
  f.view.messages.push({ id: 13, author: "DeepSeek", created_at: 1011, execution_id: 12, request_message_id: 900 });
  await nextTick();
  assert.deepEqual(working_ids(), [10, 13, 11]);
  assert.equal(f.state.failures.value.length, 0);
});

test("message duration formatting distinguishes zero from missing data and handles hours", () => {
  const start = discussion_source.indexOf("function format_elapsed");
  const end = discussion_source.indexOf("/** A scheduler call's milliseconds", start);
  const context = vm.createContext({});
  vm.runInContext(discussion_source.slice(start, end), context);
  for (const [seconds, label] of [[null, "—"], [undefined, "—"], [0, "0秒"], [59, "59秒"],
    [60, "1分00秒"], [3599, "59分59秒"], [3661, "1小时1分01秒"]]) {
    assert.equal(context.format_elapsed(seconds), label);
  }
});

test("a free-room answer shows the duration of the execution that delivered it", () => {
  const start = discussion_source.indexOf("function message_elapsed");
  const end = discussion_source.indexOf("const identities =", start);
  const room = ref({ free: { executions: [
    { id: 1, answer_id: 8, created_at: 100, finished_at: 151 },
    { id: 2, answer_id: 9, created_at: 100, finished_at: 0 }] } });
  const context = vm.createContext({ free: ref(true), room });
  vm.runInContext(discussion_source.slice(start, end), context);
  assert.equal(context.message_elapsed({ id: 8 }), 51);
  assert.equal(context.message_elapsed({ id: 9 }), null, "an unfinished execution has no duration yet");
  assert.equal(context.message_elapsed({ id: 10 }), null);
  assert.equal(context.message_elapsed({ id: 8, elapsed_seconds: 7 }), 7, "a recorded turn timing wins");
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

test("launch readback shows project access, per-AI overrides and never saves write access as a default", async () => {
  const fixture = theme_fixture();
  Object.assign(fixture.context.test_state.launch, { profiles: { Codex: { adapter: 'codex_cli' }, Claude: { adapter: 'claude', project_access: 'read' },
    Gemini: { adapter: 'antigravity' } }, workspace: {} });
  assert.equal(fixture.context.launch_summary('Codex').access, '无项目目录');
  fixture.context.write_launch_field('workspace', 'cwd', 'C:\\project');
  assert.equal(fixture.context.launch_summary('Codex').access, '项目只读');
  fixture.context.write_launch_field('workspace', 'project_access', 'write');
  assert.equal(fixture.context.launch_summary('Codex').access, '项目可写');
  assert.equal(fixture.context.launch_summary('Claude').access, '项目只读');
  assert.equal(fixture.context.launch_summary('Gemini').access, '按 App 权限');
  let saved;
  Object.assign(fixture.context, { render_launch_settings() {}, local_launch_request: async (_, body) => { saved = body; } });
  await fixture.context.save_launch_defaults();
  assert.equal(saved.participants.Claude.project_access, undefined);
});

test("switching channel colors preserves the room, filter, reply and draft", () => {
  const fixture = theme_fixture();
  const room = { id: 'welcome' };
  Object.assign(fixture.context.test_state, { room, query: '原文', reply_to: 42, tab: 'discussion' });
  fixture.nodes.set('message-input', { value: '尚未发送的草稿' });
  for (const theme of ['channel', 'channel-light', 'channel']) {
    fixture.context.change_view_theme(theme);
    assert.equal(fixture.storage.get('ai-codiscuss-theme'), theme);
    assert.equal(fixture.classes.has('dark'), theme === 'channel');
    assert.equal(fixture.nodes.get('modern-style').disabled, false);
    assert.equal(fixture.context.test_state.room, room);
    assert.equal(fixture.context.test_state.query, '原文');
    assert.equal(fixture.context.test_state.reply_to, 42);
    assert.equal(fixture.context.test_state.tab, 'discussion');
    assert.equal(fixture.nodes.get('message-input').value, '尚未发送的草稿');
  }
  assert.equal(fixture.loaded.length, 1);
});

test("removed and unknown theme preferences fall back to the channel workspace", () => {
  for (const saved of ["millennium", "retro", "unknown"]) {
    const fixture = theme_fixture(saved);
    fixture.context.restore_theme();
    assert.equal(fixture.root.dataset.theme, "channel");
    assert.equal(fixture.storage.get("ai-codiscuss-theme"), "channel");
    assert.equal(fixture.loaded.length, 1);
    assert.equal(fixture.classes.has("dark"), true);
  }
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
  const storage = new Map();
  const context = vm.createContext({ URLSearchParams, window: {}, localStorage: {
    getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value),
    removeItem: key => storage.delete(key), key: index => [...storage.keys()][index], get length() { return storage.size; },
  }, document: { getElementById: () => draft } });
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

test("channel menus keep copy and export bound to the clicked room without navigating", () => {
  const calls = [];
  const events = [];
  const current = { id: "current" };
  const target = { id: "other room" };
  const context = vm.createContext({
    view: { value: { room: current, directory_pending: [], archive_pending: [], folders: [], backup_pending: false } },
    pending: { value: "" }, manual_order: { value: true }, location: { origin: "https://discussion.example" },
    act: (...args) => calls.push(args), emit: (...args) => events.push(args),
  });
  const directory = readFileSync(new URL("../frontend/ChannelDirectory.vue", import.meta.url), "utf8");
  vm.runInContext(directory.match(/function actions\(room, index, folder_id, folder_room_count\) \{[\s\S]*?\n\}/)[0], context);
  const items = context.actions(target, 0, null, 2).flat();
  assert.equal(items.some(item => item.label === "编辑议题" || item.label === "刷新消息"), false);
  items.find(item => item.label === "复制阅读入口").onSelect();
  items.find(item => item.label === "导出对话").onSelect();
  items.find(item => item.label === "重命名").onSelect();
  assert.deepEqual(calls, [["copy", "https://discussion.example/r/other%20room"], ["backup", target.id]]);
  assert.equal(events[0][0], "manage");
  assert.equal(events[0][1].room, target);
  assert.equal(context.view.value.room, current);
  const current_items = context.actions(current, 1, null, 2).flat();
  current_items.find(item => item.label === "编辑议题").onSelect();
  current_items.find(item => item.label === "刷新消息").onSelect();
  assert.equal(events[1][1].room, current);
  assert.equal(events[1][1].action, "edit");
  assert.deepEqual(calls.at(-1), ["refresh"]);
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
  assert.deepEqual(Array.from(fixture.context.visible_rooms(), room => room.id), ["a", "b"]);
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
  fixture.context.element = id => ({ addEventListener() {}, closest: () => ({ setAttribute() {}, removeAttribute() {} }),
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

/** A theme fixture whose network answers come from a route table. */
function admin_fixture(routes) {
  const fixture = theme_fixture(), requests = [];
  fixture.context.fetch = async (url, options = {}) => {
    requests.push({ url, options, body: options.body && JSON.parse(options.body) });
    const answer = routes[url];
    const result = typeof answer === "function" ? answer(requests.at(-1)) : answer;
    return { ok: !result.error, status: result.status || (result.error ? 400 : 200), json: async () => result };
  };
  // Signing in rereads the launch settings in the background; that needs a page location and is covered elsewhere.
  fixture.context.load_launch_settings = async () => {};
  return { ...fixture, requests, admin: fixture.context.test_state.admin };
}

test("admin state applies the owner's name and avatar to every visitor and drops a rejected session", async () => {
  const profile = { username: "Ada", avatar: "data:image/png;base64,AAAA" };
  const { context, storage, requests, admin } = admin_fixture({ "/api/admin": { registered: true, setup_available: false, logged_in: false, profile } });
  assert.equal(context.display_name("用户"), "User");
  assert.equal(context.window.discuss_view.identities["用户"].icon, "/icons/user.svg");
  storage.set("discuss-admin-session", "stale-token");
  await context.load_admin_state();
  assert.equal(requests[0].options.headers["X-Discussion-Admin"], "stale-token");
  assert.equal(storage.has("discuss-admin-session"), false, "a session the server rejects is cleared");
  assert.equal(admin.logged_in, false);
  assert.equal(context.display_name("用户"), "Ada", "visitors see the owner's name");
  assert.equal(context.window.discuss_view.identities["用户"].icon, profile.avatar);
  assert.equal(context.display_name("Claude"), "Claude", "AI identities are untouched");
  context.apply_admin_state({ registered: false, setup_available: true, logged_in: false, profile: null });
  assert.equal(context.display_name("用户"), "User");
  assert.equal(context.window.discuss_view.identities["用户"].icon, "/icons/user.svg");
});

test("admin login stores the session, sends it on later writes, and logout clears it", async () => {
  const profile = { username: "Ada", avatar: "" };
  const { context, storage, requests, admin } = admin_fixture({
    "/api/admin/login": ({ body }) => body.password === "right-password" ? { token: "t".repeat(64), profile } : { error: "用户名或密码错误", status: 401 },
    "/api/rooms/one/archive": {}, "/api/admin/logout": { ok: true },
  });
  await assert.rejects(context.login_admin({ username: "Ada", password: "wrong-password" }), /用户名或密码错误/);
  assert.equal(storage.has("discuss-admin-session"), false);
  await context.login_admin({ username: " Ada ", password: "right-password" });
  assert.equal(requests.at(-1).body.username, "Ada");
  assert.equal(storage.get("discuss-admin-session"), "t".repeat(64));
  assert.equal(admin.logged_in, true);
  assert.equal(context.display_name("用户"), "Ada");
  await context.request_json("/api/rooms/one/archive", { actor: "用户" });
  assert.equal(requests.at(-1).options.headers["X-Discussion-Admin"], "t".repeat(64));
  await context.logout_admin();
  assert.deepEqual(requests.at(-1).body, {});
  assert.equal(storage.has("discuss-admin-session"), false);
  assert.equal(admin.logged_in, false);
  assert.equal(context.display_name("用户"), "Ada", "the public name stays after signing out");
});

test("admin forms follow the server limits and show the lock delay", async () => {
  const { context } = admin_fixture({ "/api/admin/login": { error: "登录已锁定", status: 429 }, "/api/admin/register": { error: "x" } });
  const check = context.validate_admin_form;
  assert.match(check({ username: "", password: "12345678", confirm: "12345678" }), /用户名/);
  assert.match(check({ username: "a".repeat(31), password: "12345678" }), /用户名/);
  assert.match(check({ username: "Ada", password: "1234567" }), /密码/);
  assert.match(check({ username: "Ada", password: "12345678", confirm: "other" }), /不一致/);
  assert.equal(check({ username: "Ada", password: "12345678", confirm: "12345678" }), "");
  await assert.rejects(context.register_admin({ username: "Ada", password: "12345678", confirm: "12345678", setup_key: " " }), /注册令牌/);
  await assert.rejects(context.login_admin({ username: "Ada", password: "12345678" }), /登录已锁定，请稍后再试/);
});

test("without a room credential a management failure says how to get permission", async () => {
  const { context, storage, admin } = admin_fixture({});
  const denied = Object.assign(new Error("需要房主或本成员的有效凭据；没有凭据只能阅读"), { status: 403 });
  assert.match(context.management_error_message("one", denied), /登录管理员账号或使用创建该房间的浏览器/);
  storage.set("discuss-access:one", "owner");
  assert.equal(context.management_error_message("one", denied), denied.message);
  storage.delete("discuss-access:one");
  admin.logged_in = true;
  assert.equal(context.management_error_message("one", denied), denied.message);
});

test("a local site applies the owner's profile without a login, session token or login guidance", async () => {
  const profile = { username: "本机", avatar: "" };
  const { context, storage, requests, admin } = admin_fixture({
    "/api/admin": { local: true, registered: true, setup_available: false, logged_in: true, profile },
    "/api/admin/profile": ({ body }) => ({ profile: { username: body.username, avatar: "" } }),
  });
  storage.set("discuss-admin-session", "old-token");
  await context.load_admin_state();
  assert.equal(admin.local, true);
  assert.equal(storage.has("discuss-admin-session"), false, "no session token is kept on a local site");
  assert.equal(context.display_name("用户"), "本机");
  assert.equal(context.window.discuss_view.identities["用户"].icon, "/icons/user.svg");
  await context.update_admin_profile({ username: "新名字" });
  assert.equal(requests.at(-1).options.headers["X-Discussion-Admin"], undefined);
  assert.equal(admin.local, true, "profile updates keep the local state");
  assert.equal(context.display_name("用户"), "新名字");
  assert.equal(context.admin_snapshot().local, true);
  const denied = Object.assign(new Error("拒绝"), { status: 403 });
  assert.equal(context.management_error_message("one", denied), "拒绝");
});

test("the execution timeline nests dispatched work, places phases after delivery and folds long idle stretches", () => {
  const second = 1_700_000_000;
  const free = (id, parent_id, queued, dispatched, finished, segments = [], state = "done") => ({ source: "free", id, member: `M${id}`, role: parent_id ? "member" : "host",
    status: state === "done" ? "completed" : state, state, queued_at: queued, dispatched_at: dispatched, started_at: 0, finished_at: finished, reason: "", parent_id, segments });
  const timeline = { execution_limit: 100, segment_limit: 400, executions: [
    free(2, 1, second + 10, second + 12, second + 40, [{ phase: "command", tool: "Bash", start_ms: 3000, end_ms: 9000 }]),
    free(1, null, second, second + 1, second + 20, [{ phase: "thinking", tool: "", start_ms: 2000, end_ms: 5000 }]),
    free(3, 99, second + 3600, second + 3601, 0, [], "running"),
    { source: "discussion", id: 1, member: "Codex", role: "expert", status: "started", state: "running", queued_at: second + 3600, dispatched_at: second + 3602,
      started_at: second + 3605, finished_at: 0, reason: "", parent_id: null, segments: [] },
  ] };
  const now = (second + 3610) * 1000;
  const rows = timeline_rows(timeline, now);
  assert.deepEqual(rows.map((row) => [row.key, row.depth]), [["free:1", 0], ["free:2", 1], ["discussion:1", 0], ["free:3", 0]]);
  const first = rows[0];
  assert.deepEqual(first.wake, [(second + 1) * 1000, (second + 3) * 1000], "without an enter, the first segment ends the wake, approximately");
  assert.equal(first.wake_approx, true);
  assert.deepEqual(rows[2].wake, [(second + 3602) * 1000, (second + 3605) * 1000]);
  assert.equal(rows[3].end, now, "a running execution grows to now");
  assert.equal(rows[3].wake, null, "no sign of work: the time after delivery is all work");
  const axis = timeline_axis(rows);
  assert.equal(axis.folds.length, 1, "the idle hour folds into one band");
  assert.ok(axis.x((second + 40) * 1000) < axis.folds[0].from + 1e-9 && axis.x((second + 3600) * 1000) >= axis.folds[0].from + axis.folds[0].width - 1e-9);
  assert.equal(axis.x(axis.end), 1);
  const summary = timeline_summary(rows);
  assert.deepEqual([summary.executions, summary.running, summary.tool_segments, summary.slowest.tool], [4, 2, 1, "Bash"]);
  assert.deepEqual([format_duration(820), format_duration(6900), format_duration(185_000), format_duration(7_500_000)], ["820ms", "6.9s", "3m 05s", "2h 05m"]);
});

test("a host continuing its own round sits beside it, so a long chain stays two levels deep", () => {
  const run = (id, member, parent_id, start) => ({ source: "free", id, member, role: member === "Claude" ? "host" : "member", status: "completed", state: "done",
    queued_at: start, dispatched_at: start, started_at: 0, finished_at: start + 30, reason: "", parent_id, segments: [] });
  const timeline = { execution_limit: 100, segment_limit: 400, executions: [
    run(1, "Claude", null, 0), run(2, "Codex", 1, 40), run(3, "Claude", 1, 80), run(4, "Codex", 3, 120), run(5, "Claude", 3, 160), run(6, "Claude", 6, 200),
  ] };
  assert.deepEqual(timeline_rows(timeline, 1e6).map((row) => [row.key, row.depth]),
    [["free:1", 0], ["free:2", 1], ["free:3", 0], ["free:4", 1], ["free:5", 0], ["free:6", 0]]);
});

test("a running execution's last phase grows to now, and hovering a moment finds the notes written around it", () => {
  const item = { source: "free", id: 1, member: "Codex", role: "member", status: "dispatched", state: "running", queued_at: 100, dispatched_at: 100,
    started_at: 0, finished_at: 0, reason: "", parent_id: null, notes: [104, 112, 99999],
    segments: [{ phase: "thinking", tool: "", start_ms: 1000, end_ms: 5000 }, { phase: "command", tool: "", start_ms: 5000, end_ms: 6000 }] };
  const stages = execution_stages(item, 120_000);
  assert.deepEqual(stages.segments.map((segment) => [segment.end, segment.live]), [[105_000, false], [120_000, true]]);
  assert.deepEqual(stages.notes.map((note) => note.at), [104_000, 112_000, 120_000], "a note is kept within the execution");
  assert.deepEqual(notes_between(stages.notes, 101_000, 105_000), { notes: [stages.notes[0]], earlier: false });
  assert.deepEqual(notes_between(stages.notes, 113_000, 115_000), { notes: [stages.notes[1]], earlier: true });
  assert.deepEqual(notes_between(stages.notes, 50_000, 60_000), { notes: [], earlier: false });
  assert.equal(execution_stages({ ...item, state: "done", finished_at: 110 }, 120_000).segments[1].end, 106_000, "a finished execution keeps its recorded ends");
});

test("each row says what it is doing, that it may be stuck, why it failed or what it answered", () => {
  const base = { source: "free", id: 1, member: "Codex", role: "member", queued_at: 100, dispatched_at: 100, started_at: 0, finished_at: 0,
    reason: "", parent_id: null, notes: [], segments: [], activity_at: 0, last_note: null, result: null, changes: null };
  const status = (item, now_s) => row_status({ item, ...execution_stages(item, now_s * 1000) }, now_s * 1000);
  const running = { ...base, status: "dispatched", state: "running" };
  assert.deepEqual(status(running, 110), { tone: "live", text: "处理中" });
  assert.deepEqual(status({ ...running, activity_at: 105, last_note: "先跑测试" }, 110), { tone: "live", text: "先跑测试" });
  assert.deepEqual(status({ ...running, activity_at: 105, segments: [{ phase: "tool", tool: "Read", start_ms: 1000, end_ms: 5000 }] }, 110), { tone: "live", text: "工具 · Read中" });
  assert.deepEqual(status({ ...running, activity_at: 105 }, 105 + 181), { tone: "warn", text: "已 3m 01s 无输出，可能卡住" });
  assert.deepEqual(status({ ...running, segments: [{ phase: "command", tool: "", start_ms: 0, end_ms: 5000 }] }, 105 + 200).text, "命令已运行 3m 20s", "a long command is not called stuck");
  assert.equal(status(running, 100 + 3600).tone, "live", "with no output ever seen, silence says nothing");
  assert.deepEqual(status({ ...base, status: "failed", state: "failed", finished_at: 120, reason: "额度用完" }, 130), { tone: "failed", text: "额度用完" });
  assert.deepEqual(status({ ...base, status: "completed", state: "done", finished_at: 120, result: "已改完", changes: 2 }, 130), { tone: "done", text: "已改完 · 改动 2 个文件" });
  const stuck = { ...running, activity_at: 105, segments: [{ phase: "editing", tool: "Edit", start_ms: 1000, end_ms: 5000 }] };
  const rows = timeline_rows({ execution_limit: 100, segment_limit: 400, executions: [stuck] }, 2_000_000);
  assert.equal(timeline_summary(rows, 2_000_000).slowest.end - timeline_summary(rows, 2_000_000).slowest.start, 4000, "an assumed tail is not a slow step");
  assert.equal(timeline_summary(rows, 2_000_000).stalled, 1);
  const log = execution_log({ segments: rows[0].segments, notes: [{ index: 0, at: 103_000 }] }, ["开始改"]);
  assert.deepEqual(log.map((entry) => entry.kind === "note" ? entry.text : entry.phase), ["editing", "开始改"], "phases and notes interleave by time");
});

test("axis ticks fall on round clock times inside shown stretches and never crowd", () => {
  const minute = 60_000;
  const rows = [{ start: 0, end: 10 * minute }, { start: 3 * 3600_000, end: 3 * 3600_000 + 2 * minute }];
  const axis = timeline_axis(rows);
  const ticks = axis_ticks(axis);
  assert.ok(ticks.length >= 3 && ticks.length <= 8, `${ticks.length} ticks`);
  assert.ok(ticks.every((tick) => tick.at % minute === 0), "a busy stretch of minutes ticks on whole minutes");
  assert.ok(ticks.every((tick) => axis.spans.some((span) => tick.at >= span.start && tick.at <= span.end)), "no tick inside a folded band");
  assert.ok(ticks.every((tick, index) => !index || tick.x - ticks[index - 1].x >= 0.12), "labels keep their distance");
  assert.equal(axis_ticks(timeline_axis([])).length, 0);
  assert.equal(axis_ticks(timeline_axis([{ start: 0, end: 20_000 }]))[0].seconds, true, "a short run labels seconds");
});

test("a trace shows one run: a user's message with every hand-off it led to, or one discussion", () => {
  const run = (id, member, parent_id, task_id, start, extra = {}) => ({ source: "free", id, member, role: member === "Claude" ? "host" : "member", status: "completed",
    state: "done", queued_at: start, dispatched_at: start, started_at: 0, finished_at: start + 20, reason: "", parent_id, task_id, task: `任务 ${task_id}`, segments: [], notes: [], ...extra });
  const timeline = { execution_limit: 100, segment_limit: 400, executions: [
    run(1, "Claude", null, 10, 0), run(2, "Codex", 1, 11, 30), run(3, "Claude", 1, 11, 60),
    run(4, "Codex", null, 20, 1000), run(5, "Gemini", null, 20, 1001, { state: "failed", status: "failed" }),
    { ...run(9, "Codex", null, null, 2000), source: "discussion", run_id: "r1", task: "第一个问题" },
    { ...run(10, "Gemini", null, null, 2030), source: "discussion", run_id: "r1", task: null },
  ] };
  const runs = timeline_runs(timeline, 5_000_000);
  assert.deepEqual(runs.list.map((item) => [item.key, item.count, item.failed]), [["run:r1", 2, false], ["task:20", 2, true], ["task:10", 3, false]]);
  assert.equal(runs.list.find((item) => item.key === "task:10").task, "任务 10", "a run is named by its opening request");
  assert.equal(runs.of.get("free:3"), "task:10", "the host's summary belongs to the run it sums up");
});

test("hand-off lines run from the dispatch moment on the dispatcher's bar down to the dispatched row", () => {
  const item = (id, member, parent_id, start) => ({ source: "free", id, member, role: "member", status: "completed", state: "done", queued_at: start, dispatched_at: start + 1,
    started_at: 0, finished_at: start + 20, reason: "", parent_id, segments: [], notes: [] });
  const rows = timeline_rows({ execution_limit: 100, segment_limit: 400, executions: [item(1, "Claude", null, 0), item(2, "Codex", 1, 10), item(3, "Gemini", 1, 12)] }, 1e6);
  const axis = timeline_axis(rows);
  const lines = handoff_lines(rows, axis);
  assert.deepEqual(lines.get("free:1").map((line) => line.part), ["start", "start"]);
  assert.deepEqual(lines.get("free:2").map((line) => line.part), ["end", "through"], "Gemini's line passes Codex's row");
  assert.deepEqual(lines.get("free:3").map((line) => line.part), ["end"]);
  assert.equal(lines.get("free:2")[0].x, axis.x(10_000), "the line drops at the moment the request was made");
});

test("a live axis leaves room ahead of now and rescales in round steps", () => {
  const rows = [{ start: 0, end: 7_000 }];
  const live = timeline_axis(rows, true);
  assert.equal(live.total_ms, 10_000, "7 s of work shows on a 10 s axis");
  assert.equal(live.busy_ms, 7_000, "the time worked is still 7 s");
  assert.ok(Math.abs(live.x(7_000) - 0.7) < 1e-9);
  assert.equal(timeline_axis([{ start: 0, end: 8_000 }], true).total_ms, 15_000);
  assert.equal(timeline_axis(rows).total_ms, 7_000, "a finished run fills the axis");
});

test("a replay snapshot shows the run as it stood: later work gone, unfinished work running and cut at that moment", () => {
  const item = { source: "free", id: 1, member: "Codex", role: "member", status: "completed", state: "done", queued_at: 100, dispatched_at: 101, started_at: 0,
    finished_at: 130, reason: "", parent_id: null, task: "改登录页", result: "已改完", answer_id: 9, changes: 2, activity_at: 129, last_note: "改完了",
    notes: [105, 120], segments: [{ phase: "thinking", tool: "", start_ms: 1000, end_ms: 6000 }, { phase: "editing", tool: "Edit", start_ms: 6000, end_ms: 25000 }] };
  const later = { ...item, id: 2, queued_at: 200, dispatched_at: 201, finished_at: 220 };
  const snapshot = snapshot_at({ execution_limit: 100, segment_limit: 400, executions: [item, later] }, 110_000, new Map([[1, ["先读代码", "改完了"]]]));
  assert.deepEqual(snapshot.executions.map((entry) => entry.id), [1], "work not yet requested is not there");
  const [cut] = snapshot.executions;
  assert.deepEqual([cut.state, cut.finished_at, cut.result, cut.answer_id, cut.changes], ["running", 0, null, null, null], "the outcome is not known yet");
  assert.deepEqual(cut.segments.map((segment) => [segment.phase, segment.end_ms]), [["thinking", 6000], ["editing", 9000]]);
  assert.deepEqual([cut.notes, cut.last_note, cut.activity_at], [[105], "先读代码", 0], "it says what it had said by then");
  assert.equal(snapshot_at({ execution_limit: 100, segment_limit: 400, executions: [item] }, 140_000).executions[0], item, "finished work is shown as it was");
});

test("the timeline zooms around the pointer, pans within its ends and ticks finer when zoomed in", () => {
  const axis = timeline_axis([{ start: 0, end: 100_000 }]);
  const zoomed = zoom_window({ from: 0, span: 1 }, 0.5, 0.25, axis.total_ms);
  assert.deepEqual(zoomed, { from: 0.375, span: 0.25 }, "the time under the pointer stays under it");
  assert.equal(zoom_window(zoomed, 0, 10, axis.total_ms).span, 1, "zooming out stops at the whole axis");
  assert.equal(zoom_window({ from: 0, span: 1 }, 0.5, 1e-6, axis.total_ms).span, 0.02, "never less than two seconds");
  assert.deepEqual(pan_window(zoomed, 10), { from: 0.75, span: 0.25 }, "panning stops at the end");
  assert.deepEqual(pan_window(zoomed, -10), { from: 0, span: 0.25 });
  const view = view_axis(axis, zoomed);
  assert.ok(Math.abs(view.x(37_500) - 0) < 1e-9 && Math.abs(view.x(62_500) - 1) < 1e-9, "the window fills the width");
  assert.ok(view.x(90_000) > 1, "what lies past the view falls outside it, for the track to clip");
  const whole = axis_ticks(axis, 5), close = axis_ticks(axis, 5, zoomed);
  assert.ok(close.every((tick) => tick.x >= 0.375 && tick.x <= 0.625), "only ticks in view are made");
  assert.ok(close[1].at - close[0].at < whole[1].at - whole[0].at, "zoomed in, ticks fall at finer steps");
});

test('importing rooms reports each room as it goes and one short line per restored member', async () => {
  const f = theme_fixture(), state = f.context.test_state, seen = [];
  state.launch.available = true;
  const snapshot = (title, local) => ({ snapshot: { tables: { rooms: [{ title }] }, ...(local ? { local_members: { mode: 'free', participants: {} } } : {}) }, files: new Map() });
  Object.assign(f.context, {
    publish_view: () => seen.push(structuredClone(state.import_progress)),
    refresh_room: async () => {}, save_room_credentials() {},
    request_json: async (path, body) => path === '/api/rooms/import'
      ? body.tables.rooms[0].title === '旧房间' ? { skipped: true, title: '旧房间' } : { id: 'new', title: body.tables.rooms[0].title, attachments: {} } : {},
    local_launch_request: async () => ({ members: [{ name: 'Codex', status: 'resumed' }, { name: 'Claude', status: 'manual', session_id: 'abc', cwd: 'D:/p' },
      { name: 'Gemini', status: 'failed', error: '找不到会话' }] }),
  });
  f.context.window.discuss_backup = { read_room_archives: async file => file.name === 'bad.zip' ? Promise.reject(new Error('格式无效')) : [snapshot('剧本', true), snapshot('旧房间')] };
  await f.context.import_rooms({ files: [{ name: 'a.zip' }, { name: 'bad.zip' }] });
  assert.equal(seen[0].done, false);
  assert.ok(seen.some(item => item.rooms[0]?.status === 'importing'));
  const result = JSON.parse(JSON.stringify(state.import_progress));
  assert.equal(result.done, true);
  assert.deepEqual(result.rooms.map(room => [room.title, room.status]), [['剧本', 'imported'], ['旧房间', 'skipped']]);
  assert.deepEqual(result.rooms[0].members.map(member => [member.name, member.text, member.resume?.command || '']), [
    ['Codex', '请回后接续原会话', ''], ['Claude', '已改为手动接入，请回后在原窗口重新注册', 'claude --resume abc'], ['Gemini', '未恢复：找不到会话', '']]);
  assert.deepEqual(result.errors, ['bad.zip：格式无效']);
  assert.equal(state.directory_notice, '');
});

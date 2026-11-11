import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { computed, nextTick, reactive, ref, watch } from "vue";
import { API_PROVIDERS } from "../runner/discussion_api.mjs";
import { member_actions } from "../frontend/member-actions.js";
import { access_label, access_options, EXPERT_PROMPT_PRESETS } from "../runner/expert_prompts.mjs";
import { adapter_profile } from "../runner/adapters/profiles.mjs";
import { format_duration, snapshot_at, timeline_axis, timeline_rows, timeline_segments, timeline_summary } from "../frontend/timeline-model.js";

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

test('API project access is chosen like a CLI, and switching software drops a level the new one may lack', async () => {
  const f = theme_fixture(), state = f.context.test_state, calls = [];
  Object.assign(f.context, { render_launch_settings() {}, render_launch_summaries() {}, refresh_room: async () => {},
    local_launch_request: async (route, payload) => { calls.push(payload); return { free: { members: [] } }; } });
  state.launch.workspace = { cwd: 'C:\\project', project_access: 'read' };
  state.launch.profiles.Codex = { adapter: 'codex_cli', project_access: 'full', cwd: 'C:\\project' };
  f.context.write_launch_field('Codex', 'adapter', 'api');
  assert.equal(f.context.launch_can_set_access('Codex'), true);
  assert.equal(state.launch.profiles.Codex.project_access, undefined, 'a CLI-only level does not carry over to the API');
  assert.equal(state.launch.profiles.Codex.cwd, 'C:\\project');
  assert.equal(f.context.launch_access('Codex'), 'read');
  f.context.write_launch_field('Codex', 'project_access', 'write');
  assert.equal(f.context.launch_summary('Codex').access, '项目可写（文件工具，无命令行）');
  assert.equal(f.context.launch_options().participants.Codex.project_access, 'write');
  state.room = { id: 'one', mode: 'free', free: { members: [] } };
  f.storage.set('discuss-access:one', 'owner-secret');
  await f.context.invite_member({ name: 'Codex', access: 'runner', project_access: 'write' });
  assert.equal(calls[0].participants.Codex.project_access, 'write');
  assert.doesNotMatch(f.context.access_options('', '沿用本次设置', 'api'), /value="(write|read)"\s+disabled/);
  assert.match(f.context.access_options('', '沿用本次设置', 'api'), /value="full"\s+disabled/);
});

/** Exercise the real autocomplete against a native-editor stub and reactive room membership. */
function mention_fixture() {
  const text = ref("");
  const room = ref({ id: "test", host: "用户", experts: { Codex: "cli", Claude: "cli" } });
  const free = ref(true);
  const free_members = ref([{ name: "Codex" }, { name: "Claude-review" }]);
  const editor = { value: "", selectionStart: 0, selectionEnd: 0, focus() {}, setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; } };
  const context = vm.createContext({ computed, ref, watch, nextTick, text, room, free, free_members, ENTER_SENDS: true,
    view: ref({ tab: "messages" }), prompt: ref({ textareaRef: editor }), bridge: { display_name: name => name },
    // No browser editing command here: replacing a draft falls back to writing the text directly.
    document: { execCommand: () => false } });
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
  fixture.type("@rev");
  assert.deepEqual([...fixture.state.members.value], ["Claude-review"]);
  fixture.free_members.value = [{ name: "Codex" }];
  assert.equal(fixture.state.members.value.length, 0, "departed members disappear from an open menu");
  fixture.free.value = false;
  fixture.type("@");
  assert.deepEqual([...fixture.state.members.value], ["Codex"], "discussion suggestions still come from the current room roster");
});

test("a slash offers only whitelisted platform skills, and picking one prefills a request to the host", async () => {
  const fixture = mention_fixture();
  fixture.type("/");
  assert.equal(fixture.state.context.value, null, "without a host there is no one to ask");
  fixture.free_members.value = [{ name: "Codex", role: "host" }];
  fixture.type("/工作流");
  assert.equal(fixture.state.active.value.skill.id, "workflow-creator");
  fixture.key("Enter");
  await nextTick();
  assert.equal(fixture.text.value, "$workflow-creator ");
  fixture.type("/discuss-host");
  assert.equal(fixture.state.active.value, undefined, "operating notes the AIs load by themselves are not offered");
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

/** Drive page subscriptions and timers without polling a live discussion. */
function update_fixture() {
  const fixture = theme_fixture(), { context } = fixture;
  const timers = new Map(), sources = [], reads = [], connections = [];
  let timer_id = 0;
  context.document.hidden = false;
  context.test_state.connected = true;
  context.EventSource = class {
    static CLOSED = 2;
    constructor(url) { this.url = url; this.listeners = new Map(); sources.push(this); }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    emit(name, data) { this.listeners.get(name)?.({ data: JSON.stringify(data || {}) }); }
    close() { this.closed = true; }
  };
  context.setTimeout = (callback, delay) => { timers.set(++timer_id, { callback, delay }); return timer_id; };
  context.clearTimeout = id => timers.delete(id);
  context.refresh_room = async () => { reads.push(context.test_state.room?.id); };
  context.set_connection = value => { connections.push(value); context.test_state.connected = value; };
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

/** Exercise shared attachment submission and draft lifetime without a live service. */
function attachment_fixture() {
  const nodes = new Map(), posts = [], uploads = [], revoked = [], notified = [];
  const element = id => {
    if (!nodes.has(id)) nodes.set(id, { value: "", setAttribute() {} });
    return nodes.get(id);
  };
  element("author-select").value = "用户";
  const state = { room: { id: "one", host: "Codex" }, attachment_drafts: [], messages: [], message_total: 0 };
  let identifier = 0, fail = true;
  const context = vm.createContext({ state, element, MAX_MESSAGE_LENGTH: 30000, MAX_SUMMARY_LENGTH: 1000,
    MAX_MESSAGE_ATTACHMENTS: 10, MAX_ATTACHMENT_BYTES: 20 * 1024 * 1024, URLSearchParams,
    new_submission_id: () => String(++identifier), escape_html: text => text,
    URL: { createObjectURL: () => "blob:test", revokeObjectURL: url => revoked.push(url) },
    localStorage: { getItem: () => null }, admin_headers: () => ({}), publish_view() {}, show_toast() {}, cancel_reply() {},
    notify: (level, message) => notified.push([level, message]),
    notify_failure: (error, message) => { notified.push(["error", message]); error.notified = true; },
    refresh_room: async () => {}, run_action: action => action(),
    render_messages: result => { state.messages = result.messages; },
    fetch: async (url, options) => { uploads.push([url, options]); return { ok: true, json: async () => ({ attachment: { id: "a".repeat(32) } }) }; },
    request_json: async (url, payload) => {
      posts.push([url, payload]);
      if (fail) throw new Error("连接中断");
      return { message: { id: 1 } };
    } });
  vm.runInContext(source.slice(source.indexOf("function message_payload("), source.indexOf("/** Render immutable file cards")), context);
  vm.runInContext(source.slice(source.indexOf("async function post_room_file("), source.indexOf("/** Read the bytes of a room file")), context);
  return { context, state, element, posts, uploads, revoked, notified, succeed() { fail = false; } };
}

test("attachment retries retain files and reuse both upload and message receipts", async () => {
  const fixture = attachment_fixture(), { context, state, uploads, posts } = fixture;
  context.add_attachments([{ name: "截图.png", size: 10, type: "image/png" }]);
  await assert.rejects(context.send_message({ preventDefault() {} }), /连接中断/);
  assert.equal(state.attachment_drafts.length, 1);
  assert.equal(state.sending_preview.failed, "连接中断", "a failed send stays in the transcript as a failed card");
  assert.equal(fixture.notified.length, 0, "the failed card is the only signal of the failure");
  const first_id = posts[0][1].submission_id;
  fixture.succeed();
  await context.send_message({ preventDefault() {} });
  assert.equal(uploads.length, 1);
  assert.equal(posts[1][1].submission_id, first_id);
  assert.equal(posts[1][1].text, "", "files-only messages are submitted");
  assert.deepEqual(Array.from(state.messages, message => message.id), [1], "the saved message shows before the room is read again");
  assert.equal(state.sending_preview, null, "the retry replaces the failed card with the saved message");
  assert.equal(state.attachment_drafts.length, 0);
  assert.deepEqual(fixture.revoked, ["blob:test"]);
});

/** The page's stop wording, read from what each execution's adapter reported. */
function stop_source() {
  return source.slice(source.indexOf("function stop_label("), source.indexOf("/** Stop the whole free room"));
}

test("retracting the latest message members started on stops that work and rewinds, but nothing wider", async () => {
  const posts = [], notified = [];
  const input = { value: "" };
  const refusal = Object.assign(new Error("已有成员开始处理这条消息，不能撤回；可以编辑这条消息回退到它之前"), { status: 409 });
  let plan, room;
  const state = { room: { id: "one" }, messages: [{ id: 5, text: "原问题" }] };
  const context = vm.createContext({ state, element: () => input, notify: (level, text) => notified.push([level, text]),
    display_name: name => name, refresh_room: async () => {}, rewind_plan: async () => plan,
    request_json: async (url, payload) => {
      if (url.endsWith("/retract")) throw refusal;
      if (payload === undefined) return room;
      posts.push([url, payload]);
      return {};
    } });
  vm.runInContext(stop_source(), context);
  vm.runInContext(source.slice(source.indexOf("async function retract_message("), source.indexOf("/** What editing a message would take back")), context);
  plan = { messages: 1, revision: "r1", members: [{ name: "Codex", session: "cut", executions: [9] }, { name: "Claude", session: "kept", executions: [10] }] };
  room = { free: { members: [{ name: "Codex", adapter: "codex_cli" }, { name: "Claude", adapter: "claude" }],
    requests: [{ message_id: 5, execution_id: 9 }, { message_id: 5, execution_id: 10 }],
    executions: [{ id: 9, member: "Codex", status: "started", capabilities: { stoppable: true, progress: true } },
      { id: 10, member: "Claude", status: "started", capabilities: { stoppable: false, progress: false } }] } };
  await context.retract_message(5);
  assert.equal(JSON.stringify(posts), JSON.stringify([["/api/rooms/one/rewind", { message_id: 5, revision: "r1" }]]), "the rewind carries the plan's revision");
  assert.equal(input.value, "原问题");
  assert.match(notified[0][1], /^已撤回；正在停止 Codex；Claude 在自己的窗口或 App 里本机无法停止.*Claude 的会话未回退.*文件改动不会恢复$/,
    "a window the runner cannot stop is not called stopped");
  posts.length = 0;
  plan = { ...plan, members: [{ name: "Codex", session: "cut", executions: [9, 3] }] };
  await assert.rejects(context.retract_message(5), /不能撤回/, "work on other messages is left to editing");
  plan = { ...plan, messages: 2, members: [{ name: "Codex", session: "cut", executions: [9] }] };
  await assert.rejects(context.retract_message(5), /不能撤回/, "a message with later records is left to editing");
  assert.deepEqual(posts, []);
});

test("attachment selection enforces count and size without consuming ordinary clipboard text", () => {
  const { context, state, notified } = attachment_fixture();
  context.add_attachments([{ name: "大文件", size: 20 * 1024 * 1024 + 1 }]);
  assert.equal(state.attachment_drafts.length, 0);
  assert.deepEqual(notified.at(-1), ["warning", "单个附件最多 20 MiB"]);
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
function expert_card_fixture(initial_preset = null) {
  const props = reactive({ name: "Codex", mode: "cli", choices: [], status: {} });
  const preset = ref(initial_preset);
  const view = ref({ launch: { profiles: { Codex: { adapter: "codex_cli", model: "saved-model", effort: "high" } } } });
  const reduced = ref(false), calls = [], cleanups = [], listeners = new Set(), document = { activeElement: null, addEventListener() {}, removeEventListener() {} };
  const angle = { set: (target) => calls.push(["set", target]), jump(target) { calls.push(["jump", target]); this.advance(target); },
    on: (event, callback) => { const listener = { event, callback }; listeners.add(listener); return () => listeners.delete(listener); },
    advance: (position) => listeners.forEach(({ event, callback }) => event === "change" && callback(position)),
    complete: () => listeners.forEach(({ event, callback }) => event === "animationComplete" && callback()),
    stop: () => calls.push(["stop"]) };
  const reads = [];
  const bridge = { launch_clients: { Codex: [{ value: "codex_cli", label: "Codex CLI" }, { value: "codex", label: "Codex App" }] },
    launch_can_set_access: (name, launch) => ['codex_cli', 'claude', 'antigravity_cli', 'api'].includes(launch.profiles[name]?.adapter),
    launch_model_state: (name, launch, profile = launch.profiles[name]) => ({ supported: profile?.adapter === "codex_cli", efforts: ["low", "high"] }),
    load_launch_models: name => reads.push(name),
    write_launch: (name, field, value) => { view.value.launch.profiles[name][field] = value; },
    restore_launch_profile: (name, profile) => { view.value.launch.profiles[name] = profile; },
    description_draft: () => "", platform_of: name => name.split('-')[0], default_name: name => name };
  const context = vm.createContext({ computed, ref, nextTick, defineProps: () => props, defineEmits: () => () => {}, access_label, access_options,
    defineModel: () => preset, adapter_profile, EXPERT_PROMPT_PRESETS,
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
  return { context, props, preset, view, reduced, angle, refs, document, calls, listeners, reads,
    cleanup: () => cleanups.forEach((callback) => callback()) };
}

test('expert card offers project permissions for CLI and API members', () => {
  const f = expert_card_fixture();
  const project = () => vm.runInContext('facts.value.find(fact => fact.label === "项目")?.value', f.context);
  f.view.value.launch.workspace = { project_access: 'write' };
  assert.equal(vm.runInContext('sets_access.value', f.context), true);
  f.view.value.launch.profiles.Codex = { adapter: 'api', project_access: 'write' };
  assert.equal(vm.runInContext('sets_access.value', f.context), true);
  assert.equal(project(), '可写');
  f.view.value.launch.profiles.Codex.adapter = 'codex';
  assert.equal(vm.runInContext('sets_access.value', f.context), false);
  assert.equal(project(), undefined, 'an App keeps its own file permissions, so the front shows no placeholder');
  assert.ok(vm.runInContext('connection.value.length', f.context) > 0, 'App connection fields remain available');
  f.cleanup();
});

test('editing and cancelling a workflow card never changes the same member in a room or copies its connection fields', () => {
  const original = { card: 'role', name: 'Codex', label: '作者', description: '原描述', system_prompt: '原提示词', project_access: 'read' };
  const f = expert_card_fixture({ ...original });
  try {
    const room_profile = JSON.stringify(f.view.value.launch.profiles);
    f.context.flip(true);
    f.context.write_model('new-model');
    f.context.write_setting('project_access', 'write');
    f.context.save_description({ text: '新描述', label: '执笔', as_template: true });
    vm.runInContext('prompt_draft.value = "新提示词"', f.context);
    f.context.save_prompt();
    assert.equal(f.preset.value.system_prompt, '新提示词');
    assert.equal(f.preset.value.label, '执笔');
    assert.equal(f.preset.value.model, 'new-model');
    assert.equal(JSON.stringify(f.view.value.launch.profiles), room_profile);
    assert.equal(f.preset.value.adapter, undefined, 'software details stay out of the portable card');
    f.context.cancel();
    assert.deepEqual(JSON.parse(JSON.stringify(f.preset.value)), original);
    assert.equal(JSON.stringify(f.view.value.launch.profiles), room_profile);
    f.context.write_setting('system_prompt', '');
    assert.equal(vm.runInContext('prompt_text.value', f.context), (EXPERT_PROMPT_PRESETS.codex_cli || '').trim());
  } finally { f.cleanup(); }
});

/** Use actual create-form handlers with isolated drafts; no AI or website is started. */
function create_form_fixture() {
  const view = ref({ fields: { "new-room-host": "用户" },
    experts: { "new-expert-modes": {} }, launch: { profiles: {}, workspace: {}, available: false } });
  const events = [], cleanups = [], submissions = [];
  const pending = ref("");
  const bridge = { identities: { 用户: {}, Codex: {}, Claude: {}, DeepSeek: {} },
    launch_clients: { Codex: [{ value: "codex_cli" }, { value: "api" }], Claude: [{ value: "claude" }, { value: "api" }], DeepSeek: [{ value: "api" }] },
    platform_of: name => name.split("-")[0], display_name: name => name,
    write_launch: (name, field, value) => { (view.value.launch.profiles[name] ||= {})[field] = value; },
    default_launch_entry: name => { if (!bridge.launch_clients[name]?.some(item => item.value !== "api") && !view.value.launch.profiles[name]?.adapter) bridge.write_launch(name, "adapter", "api"); },
    write_field: (id, value) => { events.push([id, value]); view.value.fields[id] = value; },
    write_create_discussion: value => { view.value.create_discussion = Boolean(value); if (value) view.value.create_goal = null; },
    write_create_goal: patch => { view.value.create_goal = patch === null ? null : { objective: '', max_continues: 0, max_minutes: 0, ...(view.value.create_goal || {}), ...patch }; if (patch) view.value.create_discussion = false; },
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
  context.choose_drive("discussion");
  await nextTick();
  submit(true); // Enter cannot bypass the discussion host requirement either.
  context.choose_drive("goal");
  await nextTick();
  submit(true); // A goal needs a woken host as well, and an objective.
  context.choose_drive("free");
  await nextTick();
  submit(false);
  f.cleanup();
});

test("free member delivery never offers writable credentials to unavailable identities", async () => {
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
  view.access.can_manage = false;
  assert.equal(menu_for(manual)[0][0].disabled, true);
});

/** Drive the real slider with a deterministic clock and no live client. */
function effort_fixture() {
  const props = reactive({ modelValue: "", items: [
    { value: "", label: "默认强度" }, { value: "low", label: "Low" }, { value: "high", label: "High" },
  ] });
  const frames = new Map(), cleanups = [], events = [];
  let now = 0, frame_id = 0;
  const context = vm.createContext({ computed, ref, reactive, defineProps: () => props,
    defineEmits: () => (_name, value) => { events.push(value); props.modelValue = value; },
    onBeforeUnmount: callback => cleanups.push(callback),
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
  const notified = [];
  context.notify = (level, message) => notified.push([level, message]);
  return { context, nodes, classes, storage, loaded, buttons, notified, root: document.documentElement };
}

test('attachment button metadata reaches preview without a metadata or relay read first', async () => {
  const { context } = theme_fixture(), opened = [];
  Object.assign(context, {
    request_json: () => assert.fail('button metadata already identifies the attachment'),
    attachment_url: () => assert.fail('the opened viewer resolves its own content address'),
  });
  context.test_state.remote_rooms = true;
  context.test_state.text_preview = file => opened.push(file);
  context.test_state.image_viewer = file => opened.push(file);
  for (const [fileName, contentType] of [['table.xlsx', 'application/octet-stream'], ['image.png', 'image/png']]) {
    const opening = context.preview_attachment({ room_id: 'one', id: 'attachment', fileName, contentType, fileSize: '42', createdAt: '2026-11-10' });
    assert.equal(opened.at(-1).file_name, fileName);
    assert.equal(opened.at(-1).size, 42);
    assert.equal(opened.at(-1).created_at, '2026-11-10');
    await opening;
  }
});

test('topic editing saves details without changing the discussion phase or a live session limit', async () => {
  const { context, nodes } = theme_fixture(), calls = [];
  const experts = { Codex: 'cli', Claude: 'cli' };
  nodes.set('topic-host-select', { value: 'Codex' });
  for (const key of ['title', 'goal', 'focus', 'user_request', 'background', 'boundaries']) {
    nodes.set(`topic-${key}-input`, { value: `${key} edited` });
  }
  for (const [key, value] of Object.entries({ max_rounds: '7', max_minutes: '30' })) {
    nodes.set(`topic-limit-${key}-input`, { value });
  }
  Object.assign(context, { refresh_room: async () => {}, show_toast() {},
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

const skip_room = id => ({ id, session: { id: 3, status: 'active' }, current_turn: { id: 7, expert: 'Antigravity', status: 'pending' } });

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
  f.view.access.can_manage = false;
  assert.equal(f.context.failed_message(f.state.failures.value[0].failure), null, "resend requires owner access");
});

test("manual creation retains distinct member credentials across reload and a lost receipt", async () => {
  const f = theme_fixture(), requests = [];
  const payload = { title: "手动协作", mode: "free", host: "用户", experts: { Codex: "manual", "Codex-2": "manual", DeepSeek: "manual" } };
  f.nodes.set('room-dialog', { close() {} });
  Object.assign(f.context, { room_creation_payload: () => payload, render_rooms() {}, render_room() {}, show_toast() {},
    request_json: async (_path, input, token) => { requests.push({ input, token }); throw new Error('lost manual receipt'); } });
  await assert.rejects(f.context.submit_room({ preventDefault() {} }), /lost manual receipt/);
  const record = f.context.stored_launches()[0];
  assert.equal(record.direct, true);
  assert.equal(record.input.room.runtime_mode, undefined, "free room creation cannot send automatic discussion runtime");
  assert.deepEqual(Array.from(record.input.room.members, member => member.access), ['manual', 'manual', 'manual']);
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
    { id: 3, name: 'DeepSeek', access: 'manual', status: 'away' }] };
  f.context.test_state.room = room;
  f.context.save_room_credentials(room, 'owner-secret', room.members.map(member => ({ ...member, token: `${member.name}-secret` })));
  let downloaded, copied;
  Object.assign(f.context, { location: new URL('https://discussion.example'),
    download_private_json: value => { downloaded = value; }, copy_text: async value => { copied = value; }, workspace_instruction: () => '' });
  assert.equal(JSON.stringify(f.context.access_snapshot()).includes('secret'), false);
  f.context.download_member_access('Codex-2');
  assert.deepEqual(JSON.parse(JSON.stringify(downloaded)), { site: 'https://discussion.example', room: 'one', member: 'Codex-2', token: 'Codex-2-secret' });
  assert.throws(() => f.context.download_member_access('DeepSeek'), /没有此成员/);
  await f.context.copy_member_access_text('Codex-2');
  assert.deepEqual(JSON.parse(copied), { site: 'https://discussion.example', room: 'one', member: 'Codex-2', token: 'Codex-2-secret' });
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
  await assert.rejects(f.context.invite_member({ name: 'Codex', access: 'manual' }), /receipt lost/);
  lose = false;
  await f.context.invite_member({ name: 'Codex', access: 'manual' });
  assert.equal(inputs[0].payload.name, 'Codex-2');
  assert.deepEqual(inputs[1], inputs[0]);
  assert.equal(f.context.member_credentials('one')['Codex-2'].token, inputs[0].payload.token);
  lose = true;
  await assert.rejects(f.context.change_member({ member_id: 2, name: 'Codex-2', action: 'rejoin' }), /receipt lost/);
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
  await assert.rejects(f.context.invite_member({ name: 'Claude', access: 'runner', project_access: 'write' }), /receipt lost/);
  lose = false;
  await f.context.invite_member({ name: 'Claude', access: 'runner', project_access: 'read' });
  assert.deepEqual(inputs[1], inputs[0]);
  assert.equal(inputs[0].payload.participants.Claude.project_access, 'write');
  assert.equal(inputs[0].payload.participants.Claude.model, 'sonnet');
  await f.context.invite_member({ name: 'Codex', access: 'runner' });
  assert.equal(inputs[2].payload.participants.Codex.project_access, 'read');
  assert.equal(inputs[2].payload.participants.Codex.session_id, undefined, 'a blank session field starts a new conversation');
  await f.context.invite_member({ name: 'Codex', access: 'runner', session_id: ' thread-from-history ' });
  assert.equal(inputs[3].payload.participants[inputs[3].payload.name].session_id, 'thread-from-history', 'the runner resumes the existing conversation');
  assert.match(f.notified.at(-1)[1], /原会话/);
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
  Object.assign(state.launch, { available: true,
    profiles: { Codex: { adapter: 'codex_cli', executable: 'C:\\codex.exe', session_id: 'one-room-session' } },
    workspace: { cwd: 'C:\\project', discussion_project: '本次项目' } });
  Object.assign(fixture.context, {
    crypto: { randomUUID: () => `token-${++sequence}` }, new_submission_id: () => `submission-${++sequence}`,
    room_creation_payload: () => ({ title: '网页发起', mode: 'free', host: 'Codex', experts: { Codex: 'cli' } }),
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
  await assert.rejects(fixture.context.submit_room({ preventDefault() {} }), /结果尚未确认.*lost receipt/);
  assert.equal(dialog_closes, 0, 'failed startup must leave configuration open for correction or retry');
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
  assert.equal(dialog_closes, 1);
  assert.equal(state.launch.error, '');
});

test("a new room that asks for a discussion is created as a collaboration room, then opened and started", async () => {
  const fixture = theme_fixture();
  const state = fixture.context.test_state;
  const calls = [];
  fixture.nodes.set('room-dialog', { close() {} });
  fixture.nodes.set('room-form', { reset() {} });
  Object.assign(state.launch, { available: true, profiles: { Codex: { adapter: 'codex_cli', executable: 'C:\\codex.exe' } }, workspace: {} });
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

/** Two browser instances can share the same preference store without sharing their room drafts. */
function create_preferences_fixture(store) {
  const f = theme_fixture(), state = f.context.test_state, roster = {};
  const defaults = { 'new-room-title': '', 'new-room-goal': '', 'new-room-host': '', 'new-room-limit-max_rounds': '3', 'new-room-limit-max_minutes': '0' };
  for (const [id, value] of Object.entries(defaults)) f.nodes.set(id, { value, matches: () => true, dispatchEvent() {} });
  f.nodes.set('room-form', { reset() { for (const [id, value] of Object.entries(defaults)) f.nodes.get(id).value = value; } });
  Object.assign(state.launch, { available: true, scheduler_providers: { jev: { base_url: 'https://jev.test', models: ['jev-latest'] } },
    api_keys: { 'https://jev.test': 'saved-key-ref' }, saved_profiles: { Codex: { adapter: 'codex_cli' } }, scheduler_default_mode: 'guided' });
  Object.assign(f.context, { Event: class {}, render_launch_settings() {},
    render_expert_inputs: (id, experts) => { roster[id] = experts; }, render_host_options: id => { f.nodes.get(id).value = ''; },
    local_launch_request: async (route, input) => {
      assert.equal(route, 'settings');
      if (input) store.saved = { ...store.saved, ...JSON.parse(JSON.stringify(input.create_preferences)) };
      return { create_preferences: JSON.parse(JSON.stringify(store.saved)) };
    } });
  return { ...f, state, roster };
}

test('new-room choices survive cancellation and reload while room text, project and roster are reset', async () => {
  const store = { saved: {} }, f = create_preferences_fixture(store), { context, state, nodes } = f;
  await context.reset_create_form();
  assert.equal(state.launch.scheduler.enabled, true, 'first use still offers the configured scheduler');
  context.write_scheduler('enabled', false);
  context.write_scheduler('mode', 'stable');
  context.write_create_host_workflows(true);
  context.write_named_followup(true);
  context.write_create_chain_rounds(7);
  context.write_view_field('new-room-limit-max_rounds', '6');
  context.write_view_field('new-room-limit-max_minutes', '40');
  context.write_create_goal({ objective: 'Only this room', max_continues: 9, max_minutes: 120 });
  context.write_create_preferences({ workflow_id: 'writing', advanced_open: true });
  nodes.get('new-room-title').value = 'Only this room';
  state.launch.workspace = { cwd: 'C:\\only-this-project' };
  f.roster['new-expert-modes'] = { Codex: 'cli' };
  await context.flush_create_preferences();
  assert.doesNotMatch(JSON.stringify(store.saved), /Only this room|only-this-project|api_key|Codex|participants|objective/);
  await context.reset_create_form(); // Cancelling and opening again never submits or starts a room.
  assert.equal(nodes.get('new-room-title').value, '');
  assert.equal(nodes.get('new-room-host').value, '');
  assert.deepEqual(Object.keys(f.roster['new-expert-modes']), []);
  assert.deepEqual(Object.keys(state.launch.workspace), []);
  assert.equal(state.create_goal.objective, '');
  const reloaded = create_preferences_fixture(store);
  await reloaded.context.reset_create_form();
  assert.equal(reloaded.state.launch.scheduler.enabled, false);
  assert.equal(reloaded.state.launch.scheduler.api_key_ref, 'saved-key-ref');
  assert.equal(reloaded.state.launch.scheduler.mode, 'stable');
  assert.equal(reloaded.state.create_host_workflows, true);
  assert.equal(reloaded.state.create_chain_rounds, 7);
  assert.equal(reloaded.state.named_followup, true);
  assert.equal(reloaded.nodes.get('new-room-limit-max_rounds').value, '6');
  assert.equal(reloaded.nodes.get('new-room-limit-max_minutes').value, '40');
  assert.equal(reloaded.state.create_goal.max_continues, 9);
  assert.equal(reloaded.state.create_goal.max_minutes, 120);
  assert.equal(reloaded.state.launch.create_preferences.workflow_id, 'writing');
  reloaded.context.write_create_discussion(true);
  reloaded.context.write_create_goal({});
  assert.equal(reloaded.state.create_goal.max_continues, 9, 'switching modes keeps the last Goal budget');
  await reloaded.context.flush_create_preferences();
});

/** Invite dialog fixture for the shared member board. */
function participant_connection_fixture(props = {}) {
  const view = ref({ room: { id: "one", members: [] }, launch: { available: true, profiles: {}, workspace: {} } });
  const pending = ref(""), calls = [];
  const controls = { fail_invite_at: 0 };
  const invites = [];
  const act = async (name, payload) => {
    calls.push(name);
    if (name === "invite_member") invites.push(payload.name);
    if (name === "invite_member" && calls.filter((item) => item === "invite_member").length === controls.fail_invite_at) return false;
    if (controls.on_action) return controls.on_action(name, payload);
    return true;
  };
  const dialog = vm.createContext({ computed, ref, watch, onBeforeUnmount() {}, defineProps: () => props, defineModel: () => ref(false),
    inject: () => ({ view, bridge: { launch_clients: {}, platform_of: (name) => name.split("-")[0],
      unique_instance: (base, taken) => { let name = base; for (let number = 2; taken.has(name); number++) name = `${base}-${number}`; return name; } }, pending, act }) });
  const invite_dialog = readFileSync(new URL("../frontend/InviteDialog.vue", import.meta.url), "utf8");
  vm.runInContext(invite_dialog.match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import .*;$/gm, ""), dialog);
  return { dialog, view, calls, invites, controls };
}

test("batch invitation stops at the first failure and keeps the remaining picks for a retry", async () => {
  const { dialog: context, calls, controls } = participant_connection_fixture();
  controls.fail_invite_at = 2;
  vm.runInContext("inviting.value = true", context);
  await Promise.resolve();
  vm.runInContext('invite_picks.value = ["Codex", "Claude", "Antigravity"].map((name) => ({ name, mode: "manual" }));', context);
  await context.invite();
  assert.deepEqual(calls, ["invite_member", "invite_member", "refresh"]);
  assert.equal(vm.runInContext("invite_picks.value.map((pick) => pick.name).join()", context), "Claude,Antigravity");
  assert.equal(vm.runInContext("invited_manual.value.join()", context), "Codex");
});

test('workflow invitations isolate partial admissions, retain them on retry and never enable a removed set of cards', async () => {
  const f = participant_connection_fixture(), enabled = [];
  const bridge = vm.runInContext('bridge', f.dialog);
  const workflow = { id: 'writing', agents: [{ card: 'writer', name: 'Codex-writer' }, { card: 'editor', name: 'Claude-editor' }] };
  Object.assign(bridge, { local_request: async () => workflow, workflow_preset: ({ card, ...preset }) => preset,
    apply_expert_preset(name) { f.view.value.launch.profiles[name] = { adapter: 'claude', executable: 'fixture' }; } });
  f.controls.on_action = async (action, payload) => {
    if (action === 'invite_member') payload.workflow_members[payload.card] = `${payload.name}-joined`;
    if (action === 'enable_room_workflow') enabled.push(JSON.parse(JSON.stringify(payload)));
    return true;
  };
  vm.runInContext('inviting.value = true', f.dialog); await nextTick();
  await f.dialog.choose_workflow('writing'); await f.dialog.choose_workflow(''); await f.dialog.choose_workflow('writing');
  assert.equal(vm.runInContext('invite_picks.value.length', f.dialog), 2, 'deselecting never leaves duplicate cards');
  f.controls.fail_invite_at = 2;
  await f.dialog.invite();
  assert.equal(enabled.length, 0);
  await f.dialog.invite();
  assert.deepEqual(enabled, [{ id: 'writing', members: { writer: 'Codex-writer-joined', editor: 'Claude-editor-joined' } }]);
  await nextTick();
  vm.runInContext('inviting.value = true', f.dialog); await nextTick();
  await f.dialog.choose_workflow('writing');
  vm.runInContext('invite_picks.value = []', f.dialog);
  await f.dialog.invite();
  assert.equal(enabled.length, 1, 'a new invitation cannot reuse another draft admission or enable empty cards');
  await f.dialog.choose_workflow('writing');
  const before = f.invites.length, on_action = f.controls.on_action;
  let late_failure = true;
  f.controls.on_action = async (action, payload) => {
    await on_action(action, payload);
    if (action === 'invite_member' && late_failure) { late_failure = false; return false; }
    return true;
  };
  await f.dialog.invite(); await f.dialog.invite();
  assert.equal(f.invites.length - before, 2, 'a durable admission followed by metadata failure is not invited again');
  assert.equal(enabled.length, 2);
});

test('a slash workflow request previews cards, recalls members only on confirmation and keeps their original names', async () => {
  const f = participant_connection_fixture({ workflowId: 'writing' }), enabled = [];
  f.view.value.room.members = [{ id: 5, name: 'Claude-old', status: 'away' }];
  f.view.value.launch.room_models = { workflow: { id: 'writing', enabled: false, members: { writer: 'Claude-old' } } };
  const bridge = vm.runInContext('bridge', f.dialog);
  Object.assign(bridge, { local_request: async () => ({ id: 'writing', agents: [
    { card: 'writer', name: 'Claude-writer' }, { card: 'editor', name: 'Codex-editor' }] }),
  workflow_preset: ({ card, ...preset }) => preset,
  apply_expert_preset(name) { f.view.value.launch.profiles[name] = { adapter: 'claude', executable: 'fixture' }; } });
  f.controls.on_action = async (action, payload) => {
    if (action === 'change_member') f.view.value.room.members[0].status = 'active';
    if (action === 'invite_member') payload.workflow_members[payload.card] = payload.name;
    if (action === 'enable_room_workflow') enabled.push(JSON.parse(JSON.stringify(payload)));
    return true;
  };
  vm.runInContext('inviting.value = true', f.dialog);
  await new Promise(setImmediate);
  assert.equal(f.calls.length, 0, 'selection does not recall or invite anyone');
  assert.equal(vm.runInContext('invite_picks.value.map(pick => pick.name).join()', f.dialog), 'Codex-editor');
  await f.dialog.invite();
  assert.deepEqual(f.calls, ['change_member', 'invite_member', 'enable_room_workflow', 'refresh']);
  assert.deepEqual(enabled, [{ id: 'writing', members: { writer: 'Claude-old', editor: 'Codex-editor' } }]);
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

/** Evaluate the unified execution card and transcript slot calculations with reactive room snapshots. */
function free_card_fixture({ messages = [], members = [], executions = [], query = "", source_filter = false, now = 1000 } = {}) {
  const timers = new Map();
  let timer_id = 0, current_time = now;
  class TestDate extends Date { static now() { return current_time * 1000; } }
  const view = reactive({ value: { query, source_filter, authors: [], messages, access: { can_manage: true }, room: {
    id: "room", mode: "free", archived: false, members: [], free: { members, executions, requests: [] }, session: null,
  } } });
  const context = vm.createContext({ computed, stable_computed: computed, ref, watch, view,  room: computed(() => view.value.room), Date: TestDate,
    setInterval: callback => { timers.set(++timer_id, callback); return timer_id; }, clearInterval: id => timers.delete(id),
    bridge: { request: async () => ({ notes: [] }) } });
  const busy_start = discussion_source.indexOf("const free = computed(");
  const busy_end = discussion_source.indexOf("/** Progress notes per execution id", busy_start);
  vm.runInContext(`${discussion_source.slice(busy_start, busy_end)}\nglobalThis.cards = { busy: free_busy, working: free_working, now: free_now };`, context);
  const layout_start = discussion_source.indexOf("const failure_wakes = computed(");
  const layout_end = discussion_source.indexOf("/** Id of the top-level message at or before", layout_start);
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

test("launch readback shows project access, per-AI overrides and never saves write access as a default", async () => {
  const fixture = theme_fixture();
  Object.assign(fixture.context.test_state.launch, { profiles: { Codex: { adapter: 'codex_cli' }, Claude: { adapter: 'claude', project_access: 'read' },
    Antigravity: { adapter: 'antigravity' } }, workspace: {} });
  assert.equal(fixture.context.launch_summary('Codex').access, '无项目目录');
  fixture.context.write_launch_field('workspace', 'cwd', 'C:\\project');
  assert.equal(fixture.context.launch_summary('Codex').access, '项目只读');
  fixture.context.write_launch_field('workspace', 'project_access', 'write');
  assert.equal(fixture.context.launch_summary('Codex').access, '项目可写');
  assert.equal(fixture.context.launch_summary('Claude').access, '项目只读');
  assert.equal(fixture.context.launch_summary('Antigravity').access, '按 App 权限');
  let saved;
  Object.assign(fixture.context, { render_launch_settings() {}, local_launch_request: async (_, body) => { saved = body; } });
  await fixture.context.save_launch_defaults();
  assert.equal(saved.participants.Claude.project_access, undefined);
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
  // Off the transcript tab a refresh reads only the room, so each test resolves the room reads it expects.
  state.tab = "overview";
  state.rooms = [{ id: "a", title: "话题 A", folder_id: "one" }, { id: "b", folder_id: "one" }];
  state.room = { ...state.rooms[0], goal: "原议题" };
  state.messages = [{ id: 10, text: "原发言" }];
  context.request_json = (path, payload) => new Promise((resolve, reject) => requests.push({ path, payload, resolve, reject }));
  context.render_rooms = () => {};
  context.render_room = () => {};
  context.set_connection = () => {};
  context.publish_view = () => frames.push(state.rooms.map((room) => ({ ...room })));
  context.show_toast = (message) => notices.push(message);
  const errors = [];
  context.notify = (_level, message) => errors.push(message);
  return { context, state, requests, notices, errors, frames, draft,
    move: (id = "a", folder_id = "two") => context.manage_channel({ id, action: "folder", folder_id }) };
}

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
  assert.match(fixture.errors.at(-1), /话题 A.*存档失败.*网络断开/);
  assert.equal(fixture.state.archive_changes.size, 0);
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
    room_creation_payload: () => ({ title: "新讨论", mode: "free", host: "用户", experts: {}, folder_id: null }),
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

test("admin login stays in the website's cookie: the page never stores or sends the token, and logout ends it", async () => {
  const profile = { username: "Ada", avatar: "" };
  const { context, storage, requests, admin } = admin_fixture({
    "/api/admin/login": ({ body }) => body.password === "right-password" ? { profile } : { error: "用户名或密码错误", status: 401 },
    "/api/rooms/one/archive": {}, "/api/admin/logout": { ok: true },
  });
  await assert.rejects(context.login_admin({ username: "Ada", password: "wrong-password" }), /用户名或密码错误/);
  await context.login_admin({ username: " Ada ", password: "right-password" });
  assert.equal(requests.at(-1).body.username, "Ada");
  assert.equal(storage.has("discuss-admin-session"), false, "no login token is kept where scripts can read it");
  assert.equal(admin.logged_in, true);
  assert.equal(context.display_name("用户"), "Ada");
  await context.request_json("/api/rooms/one/archive", { actor: "用户" });
  assert.equal(requests.at(-1).options.headers["X-Discussion-Admin"], undefined, "the browser sends the cookie itself");
  await context.logout_admin();
  assert.deepEqual(requests.at(-1).body, {});
  assert.equal(admin.logged_in, false);
  assert.equal(context.display_name("用户"), "Ada", "the public name stays after signing out");
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
  assert.deepEqual([summary.executions, summary.running, summary.slowest.tool], [4, 2, "Bash"]);
  assert.deepEqual([format_duration(820), format_duration(6900), format_duration(185_000), format_duration(7_500_000)], ["820ms", "6.9s", "3m 05s", "2h 05m"]);
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

test('late reply text is fetched only for the owner and discarded when access or room changes', async () => {
  let finish;
  const calls = [], room = ref({ id: 'one' }), view = ref({ access: { can_manage: false } });
  const context = vm.createContext({ room, view, ref, watch, bridge: {
    request: path => { calls.push(path); return new Promise(resolve => { finish = resolve; }); },
    notify() { throw new Error('unexpected read failure'); },
  } });
  const start = discussion_source.indexOf('const late_answers =');
  const end = discussion_source.indexOf('async function load_notes(', start);
  vm.runInContext(discussion_source.slice(start, end) + '\nglobalThis.cache = late_answers;', context);
  const event = { target: { open: true } };
  await context.load_late_answer(9, event);
  assert.equal(calls.length, 0);
  view.value.access.can_manage = true;
  await nextTick();
  const loading = context.load_late_answer(9, event);
  assert.deepEqual(calls, ['/api/rooms/one/executions/9/late-answer']);
  view.value.access.can_manage = false;
  await nextTick();
  finish({ text: 'private' });
  await loading;
  assert.equal(context.cache.value.size, 0);
  view.value.access.can_manage = true;
  await nextTick();
  const second = context.load_late_answer(9, event);
  finish({ text: 'private' });
  await second;
  assert.equal(context.cache.value.get(9).text, 'private');
  room.value.id = 'two';
  await nextTick();
  assert.equal(context.cache.value.size, 0);
});

test("a task begins only at the owner's new message while the room is idle; interjections, follow-ups and retries join it", () => {
  const run = (id, queued, finished, task_id, task_author) => ({ source: "free", id, member: "M", role: "host", status: "completed", state: "done",
    queued_at: queued, dispatched_at: queued, started_at: 0, finished_at: finished, reason: "", parent_id: null, segments: [], task_id, task_author, task: `#${task_id}` });
  const segments = timeline_segments([
    run(1, 100, 200, 10, "用户"),       // opens a task
    run(2, 150, 260, 11, "用户"),       // the owner interjects while it runs
    run(3, 210, 300, 12, "Claude"),     // the host dispatches
    run(4, 400, 420, 10, "用户"),       // a retry of the first message, after the room fell idle
    run(5, 500, 520, 13, "系统"),       // a program wake while idle
    run(6, 600, 640, 14, "用户"),       // a new request while idle
  ], 1_000_000);
  assert.deepEqual(segments.map((segment) => [...segment.keys]), [["free:1", "free:2", "free:3", "free:4", "free:5"], ["free:6"]]);
  assert.deepEqual(segments[0].interjections.map((item) => item.key), ["free:2"]);
});

test('backup import applies the adapter restore policy without interpreting the adapter name', () => {
  const f = theme_fixture();
  f.context.window.discuss_backup = { adapter_profile: id => ({ restore_manual: id === 'future_adapter' }) };
  const result = f.context.import_body({ local_members: { mode: 'free', participants: {
    Future: { adapter: 'future_adapter' }, Claude: { adapter: 'claude' },
  } }, tables: { room_members: [
    { name: 'Future', status: 'active', access: 'runner' }, { name: 'Claude', status: 'active', access: 'runner' },
  ] } });
  assert.equal(result.tables.room_members[0].access, 'manual');
  assert.equal(result.tables.room_members[1].access, 'runner');
  assert.equal(result.local_members, undefined);
});


test("relayed reads are asked again after a lost answer, writes never; a dropped connection reconnects by itself", async () => {
  const f = update_fixture();
  const sent = [];
  f.context.setTimeout = (callback) => { callback(); return 0; };
  f.context.relay_exchange = async (action, payload) => {
    sent.push(payload.method);
    if (sent.length < 3) throw Object.assign(new Error("结果待确认"), { unconfirmed: true });
    return { status: 200, body: { ok: true } };
  };
  assert.equal(JSON.stringify((await f.context.relay_room_request("/api/rooms/r1")).body), JSON.stringify({ ok: true }));
  assert.equal(sent.join(), "GET,GET,GET");
  sent.length = 0;
  await assert.rejects(f.context.relay_room_request("/api/rooms/r1/messages", { text: "x" }), /结果待确认/);
  assert.equal(sent.join(), "POST", "an unconfirmed write is not sent twice");

  // A lost connection schedules a quiet reconnect, backing off, and stops once connected.
  const g = theme_fixture(), timers = [];
  g.context.document.hidden = false;
  g.context.setTimeout = (callback, delay) => { timers.push({ callback, delay }); return timers.length; };
  g.context.clearTimeout = () => {};
  g.context.element = () => ({ className: "", textContent: "" });
  const reconnects = [];
  g.context.reconnect_live_updates = (options) => { reconnects.push(options); };
  g.context.set_connection(false);
  assert.equal(timers.at(-1).delay, 2000);
  timers.at(-1).callback();
  assert.equal(JSON.stringify(reconnects), JSON.stringify([{ automatic: true }]));
  g.context.set_connection(false);
  assert.equal(timers.at(-1).delay, 4000);
  g.context.set_connection(true);
  g.context.set_connection(false);
  assert.equal(timers.at(-1).delay, 2000, "a success resets the back-off");
});

test("@ names a member by its on-screen nickname or its member name, longest first, never by an ambiguous nickname", () => {
  const f = theme_fixture(), state = f.context.test_state;
  const names = ["Claude", "Claude-1", "Antigravity", "Codex"];
  const named = (text) => [...f.context.mentioned_members(text, names)].sort().join();
  state.room = { labels: { "Claude-1": "Claude评审" } };
  assert.equal(named("@Gemini 看看这一版"), "Antigravity", "Gemini is the nickname shown for Antigravity");
  assert.equal(named("@Antigravity 看看"), "Antigravity");
  assert.equal(named("@Claude评审 你来"), "Claude-1", "the longer nickname does not also name Claude");
  assert.equal(named("@Claude 和 @Claude评审"), "Claude,Claude-1");
  assert.equal(named("`@Codex` 只是引用"), "");
  state.room = { labels: { Codex: "Gemini" } };
  assert.equal(named("@Gemini 你在吗"), "", "a nickname two members share names neither");
  assert.equal(named("@Codex @Antigravity"), "Antigravity,Codex");
});

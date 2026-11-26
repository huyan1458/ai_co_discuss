import { SHARE_DAYS, SHARE_DEFAULT_DAYS, SHARE_SITE_FILES_MAX_BYTES } from '../runner/share_shared.mjs';
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import * as vue_runtime from "vue";
import { compile } from "@vue/compiler-dom";
import { computed, nextTick, reactive, ref, watch } from "vue";
import { API_PROVIDERS } from "../runner/discussion_api.mjs";
import { member_actions } from "../frontend/member-actions.js";
import { access_label, access_options, EXPERT_PROMPT_PRESETS } from "../runner/expert_prompts.mjs";
import { adapter_profile } from "../runner/adapters/profiles.mjs";
import { slash_insertion } from "../runner/slash_names.mjs";
import { format_duration, replay_follow_window, snapshot_at, step_follow_window, timeline_axis, timeline_rows, timeline_segments, timeline_summary } from "../frontend/timeline-model.js";
import { t } from "../frontend/i18n.js";
import { build_default_share_copy, encode_cover, resolve_share_copy, share_card_diagnostic } from "../frontend/share-card.js";
import { VISUAL_RESULT_LIMIT, inline_visual_collapsed, inline_visual_document, inline_visual_height, remember_visual_height, remembered_visual_height, send_visual_theme, start_visual_tab, visual_result } from "../frontend/inline-visual.js";
import { excerpts_markdown, file_preview, put_visual_result } from "../frontend/file-preview.js";
import { declined, external_of, external_tag, invited_items, remaining_label, take_join_fragment } from "../frontend/external-members.js";

// Sliced component code calls t() for interface text; every sandbox gets the translator (Chinese here).
const create_context = vm.createContext;
vm.createContext = (sandbox = {}, ...rest) => {
  if (!("t" in sandbox)) sandbox.t = t;
  return create_context(sandbox, ...rest);
};

const source = readFileSync(new URL("../web/app.js", import.meta.url), "utf8").replace(/\nrestore_theme\(\);[\s\S]*$/, "");
const discussion_source = readFileSync(new URL("../frontend/ChannelDiscussion.vue", import.meta.url), "utf8");

function send_scroll_fixture() {
  const view = { value: { sending_preview: { id: "send" }, messages: [] } };
  const context = vm.createContext({
    view, sent_position: { id: "send" }, CSS: { escape: String }, rising_id: 7,
    send_y: { get: () => 24 }, reading_top: () => 80, READING_OFFSET: 20,
    close_preview() {}, toggle_hold: null, reader: { state: {} }, follow_tail: {},
    jump_target: {}, pending_jump: null, awaiting_jump: null, send_clipped: {},
    follow_messages() { element.scrollTop = context.follow_destination(element); },
  });
  for (const name of ["follow_destination", "return_to_latest"]) {
    const start = discussion_source.indexOf(`function ${name}(`);
    vm.runInContext(discussion_source.slice(start, discussion_source.indexOf("\n}", start) + 2), context);
  }
  const element = {
    clientHeight: 800, scrollHeight: 1800, scrollTop: 1000,
    querySelector(selector) {
      const expected = view.value.sending_preview ? '[data-sending-id="send"]' : '[data-message-id="7"]';
      if (selector === expected) return { getBoundingClientRect: () => ({ top: 1724 - this.scrollTop }) };
    },
  };
  return { context, element, save() { view.value = { messages: [{ id: 7, submission_id: "send" }] }; } };
}

test("short send follows the new bottom after its execution mounts", () => {
  const { context, element, save } = send_scroll_fixture();
  assert.equal(context.follow_destination(element), 1000);
  save();
  element.scrollHeight += 150;
  assert.equal(context.follow_destination(element), 1150);
});

test("tall send keeps its heading until the reader returns to latest", () => {
  const { context, element, save } = send_scroll_fixture();
  element.scrollHeight = 3000;
  assert.equal(context.follow_destination(element), 1600);
  save();
  assert.equal(context.follow_destination(element), 1600);
  context.return_to_latest();
  assert.equal(element.scrollTop, 2200);
});

test("annotation diagnostics record composition and geometry without collecting draft text", () => {
  const records = [];
  const context = vm.createContext({ debug_log: (event, data) => records.push({ event, ...data }) });
  const start = discussion_source.indexOf("function record_annotation(");
  vm.runInContext(discussion_source.slice(start, discussion_source.indexOf("\n}", start) + 2), context);
  const form = { classList: new Set(["file-comment", "excerpt-edit", "is-docked"]),
    getBoundingClientRect: () => ({ width: 320, height: 80 }) };
  form.classList.contains = name => form.classList.has(name);
  const target = { value: "private annotation text", closest: () => form };
  context.record_annotation({ type: "keydown", key: "x", target });
  context.record_annotation({ type: "keydown", key: "Enter", isComposing: true, target });
  assert.deepEqual(records, [{ event: "annotation", phase: "keydown", action: "Enter", composing: true,
    source: "file", entry: "mark", docked: true, width: 320, height: 80 }]);
});

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
  assert.equal(f.context.launch_model_state('Grok').items[0].label, 'vendor/model.1');
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
  const controller = theme_fixture();
  controller.context.test_state.room = room.value;
  const editor = { value: "", selectionStart: 0, selectionEnd: 0, focus() {}, setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; } };
  const context = vm.createContext({ computed, ref, watch, nextTick, text, room, free, free_members, ENTER_SENDS: true, slash_insertion,
    view: ref({ tab: "messages" }), prompt: ref({ textareaRef: editor }), bridge: controller.context.window.discuss_view,
    // No browser editing command here: replacing a draft falls back to writing the text directly.
    document: { execCommand: () => false } });
  const start = discussion_source.indexOf("const mention_context =");
  const end = discussion_source.indexOf("function clip_text(", start);
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
  const diagnostics = [];
  const element = id => {
    if (!nodes.has(id)) nodes.set(id, { value: "", setAttribute() {} });
    return nodes.get(id);
  };
  element("author-select").value = "用户";
  const state = { room: { id: "one", host: "Codex" }, attachment_drafts: [], failed_sends: [], messages: [], message_total: 0 };
  let identifier = 0, fail = true;
  const context = vm.createContext({ state, element, room_timing_mark() {}, SEND_RETRY_MS: [2000, 5000, 10000], setTimeout: (callback) => callback(), MAX_MESSAGE_LENGTH: 30000, MAX_SUMMARY_LENGTH: 1000,
    CustomEvent, document: { getElementById: () => null, dispatchEvent: event => diagnostics.push(event.detail) },
    MAX_MESSAGE_ATTACHMENTS: 10, MAX_ATTACHMENT_BYTES: 20 * 1024 * 1024, URLSearchParams,
    new_submission_id: () => String(++identifier), escape_html: text => text, relay_files: new Map(), prefetched: new Map(),
    URL: { createObjectURL: () => "blob:test", revokeObjectURL: url => revoked.push(url) },
    localStorage: { getItem: () => null }, admin_headers: () => ({}), publish_view() {}, show_toast() {}, cancel_reply() {},
    notify: (level, message) => notified.push([level, message]),
    notify_failure: (error, message) => { notified.push(["error", message]); error.notified = true; },
    refresh_room: async () => {}, run_action: action => action(),
    render_messages: result => { state.messages = result.messages; },
    fetch: async (url, options) => { uploads.push([url, options]); return { ok: true, json: async () => ({ attachment: { id: "a".repeat(32) } }) }; },
    request_json: async (url, payload) => {
      posts.push([url, payload]);
      if (typeof fail === "number" && fail-- > 0) throw new TypeError("Failed to fetch");
      if (fail === true) throw new Error("连接中断");
      return { message: { id: 1 } };
    } });
  vm.runInContext(source.slice(source.indexOf("function message_payload("), source.indexOf("/** Render immutable file cards")), context);
  vm.runInContext(source.slice(source.indexOf("function browser_debug("), source.indexOf("/** Read current form drafts")), context);
  vm.runInContext(source.slice(source.indexOf("async function post_room_file("), source.indexOf("/** Read the bytes of a room file")), context);
  // Markdown rendering lives in markdown.js; a stand-in keeps receipts drawable here.
  context.render_room_markdown = text => text ? `<p>${text}</p>` : "";
  context.link_attachment_placeholders = html => html;
  return { context, state, element, posts, uploads, revoked, notified, diagnostics, succeed() { fail = false; }, drop(times) { fail = times; } };
}

test("browser diagnostics link an optimistic send to its receipt without capturing message text", async () => {
  const fixture = attachment_fixture();
  fixture.succeed();
  const send = async () => {
    fixture.element("message-input").value = "private message text";
    await fixture.context.send_message({ preventDefault() {} });
  };
  await send();
  assert.equal(fixture.diagnostics.length, 0);
  fixture.context.document.getElementById = id => id === "scrolldebug" ? {} : null;
  await send();
  const [preview, receipt] = fixture.diagnostics.map(entry => entry.data);
  assert.equal(preview.phase, "optimistic");
  assert.equal(receipt.phase, "receipt");
  assert.equal(preview.operation, receipt.operation);
  assert.equal(receipt.send, fixture.posts.at(-1)[1].submission_id);
  assert.equal(receipt.message, 1);
  assert.doesNotMatch(JSON.stringify(fixture.diagnostics), /private message text/);
});

test("attachment retries retain files and reuse both upload and message receipts", async () => {
  const fixture = attachment_fixture(), { context, state, uploads, posts } = fixture;
  context.add_attachments([{ name: "截图.png", size: 10, type: "image/png" }]);
  await assert.rejects(context.send_message({ preventDefault() {} }), /连接中断/);
  assert.equal(state.attachment_drafts.length, 0, "a failed send does not fill the composer back");
  assert.equal(state.failed_sends[0].drafts.length, 1, "the failed card keeps its files");
  assert.equal(state.failed_sends[0].preview.failed, "连接中断", "a failed send stays in the transcript as a failed card");
  assert.equal(fixture.notified.length, 0, "the failed card is the only signal of the failure");
  const first_id = posts[0][1].submission_id;
  fixture.succeed();
  await context.retry_sending(state.failed_sends[0].id);
  assert.equal(uploads.length, 1);
  assert.equal(posts[1][1].submission_id, first_id);
  assert.equal(posts[1][1].text, "[图片 #1]", "a files-only message carries the placeholder the file put in the text");
  assert.deepEqual(Array.from(state.messages, message => message.id), [1], "the saved message shows before the room is read again");
  assert.equal(context.room_sending_previews().length, 0, "the retry replaces the failed card with the saved message");
  assert.equal(state.failed_sends.length, 0);
  assert.equal(state.attachment_drafts.length, 0);
  assert.deepEqual(fixture.revoked, ["blob:test"]);
});

test("consecutive sends survive a room switch and retry in order without changing the next draft", async () => {
  const { context, state, element, notified } = attachment_fixture();
  const room = { ...state.room, title: "原房间" };
  state.room = room;
  const saved_notices = [];
  context.show_toast = message => saved_notices.push(message);
  const started = Promise.withResolvers(), reply = Promise.withResolvers(), requests = [];
  context.request_json = async (path, payload) => {
    requests.push({ path, text: payload.text, id: payload.submission_id });
    if (requests.length === 1) { started.resolve(); return reply.promise; }
    if (requests.length === 2) throw new Error("拒绝");
    return { message: { id: requests.length } };
  };
  const send = text => {
    element("message-input").value = text;
    return context.send_message({ preventDefault() {} });
  };
  const first = send("甲"), second = send("甲");
  await started.promise;
  assert.deepEqual(Array.from(context.room_sending_previews(), card => card.text), ["甲", "甲"]);
  assert.equal(requests.length, 1);
  state.room = { id: "two" };
  assert.equal(context.room_sending_previews().length, 0);
  const third = send("乙");
  reply.reject(new TypeError("Failed to fetch"));
  await assert.rejects(first, /拒绝/);
  await Promise.all([second, third]);
  assert.deepEqual(requests.map(item => item.path), ["/api/rooms/one/messages", "/api/rooms/one/messages", "/api/rooms/one/messages", "/api/rooms/two/messages"]);
  assert.equal(requests[0].id, requests[1].id);
  assert.notEqual(requests[0].id, requests[2].id);
  assert.match(notified[0][1], /原房间/);
  assert.match(saved_notices[0], /原房间.*#3/);
  assert.equal(state.failed_sends[0].room_id, room.id);
  state.room = room;
  const fourth = send("丙");
  element("message-input").value = "草稿";
  const retry = context.retry_sending(state.failed_sends[0].id);
  assert.deepEqual(Array.from(context.room_sending_previews(), card => card.text), ["丙", "甲"]);
  await Promise.all([fourth, retry]);
  assert.equal(requests.at(-1).id, requests[0].id);
  assert.equal(element("message-input").value, "草稿");
  assert.equal(state.failed_sends.length, 0);
});

test("two members leave or are removed immediately while acknowledgements arrive out of order", async () => {
  const { context } = theme_fixture();
  const state = context.test_state;
  const members = [1, 2].map(id => ({ id, name: "Member" + id, status: "active" }));
  state.room = { id: "one", members, free: { members } };
  const writes = [];
  context.refresh_room = async () => {};
  context.request_json = (path, body) => {
    const deferred = Promise.withResolvers();
    writes.push({ path, body, ...deferred });
    return deferred.promise;
  };
  for (const action of ["away", "remove"]) {
    const start = writes.length;
    const saving = members.map(member => context.change_member({ action, name: member.name, member_id: member.id }));
    assert.equal(writes.length, start + 2);
    const shown = () => Array.from(context.shown_room().members, member => member.status);
    const expected = action === "away" ? ["away", "away"] : [];
    assert.deepEqual(shown(), expected);
    writes[start + 1].resolve({ members: action === "away" ? [{ ...members[1], status: "away" }] : [members[0]] });
    await saving[1];
    assert.deepEqual(shown(), expected);
    writes[start].resolve({ members: action === "away" ? [{ ...members[0], status: "away" }] : [] });
    await saving[0];
    assert.deepEqual(shown(), expected);
  }
});

test("newer member settings survive stale reads and superseded failures", async () => {
  const { context } = theme_fixture();
  const state = context.test_state;
  context.structuredClone = structuredClone;
  const profile = { adapter: "codex_cli", project_access: "read", model: "m", actual_model: "m", actual_effort: "low" };
  state.room = { id: "one", members: [{ name: "Codex", access: "runner" }] };
  state.launch.room_models = { room_id: "one", participants: { Codex: profile } };
  const writes = [];
  context.local_launch_request = () => {
    const deferred = Promise.withResolvers();
    writes.push(deferred);
    return deferred.promise;
  };
  const shown = () => context.shown_launch().room_models;
  const access = value => context.set_member_access({ name: "Codex", project_access: value });
  const model = (model, effort) => context.set_member_model({ name: "Codex", model, effort });
  const first = access("write"), last = access("full");
  assert.equal(shown().participants.Codex.project_access, "full");
  writes[0].reject(new Error("first request failed"));
  assert.equal(await first, false);
  writes[1].resolve({ project_access: "full" });
  await last;
  const changed = model("m", "high");
  assert.match(context.participant_model("Codex", state.room, shown()), /high/);
  const reset = model("", "");
  const stale = { ...state.launch.room_models, participants: { Codex: { ...profile, project_access: "full" } } };
  state.launch.room_models = stale;
  assert.equal(shown().participants.Codex.model, "");
  assert.equal(shown().participants.Codex.model_pending, "next");
  writes[2].resolve({ model: "m", effort: "high" });
  await changed;
  writes[3].resolve({ model: "", effort: "", model_pending: "next" });
  await reset;
  assert.equal(shown().participants.Codex.model, "");
  assert.equal(shown().participants.Codex.project_access, "full");
});

test("late profile reads and a failed access change preserve the acknowledged model", async () => {
  const { context } = theme_fixture();
  context.structuredClone = structuredClone;
  const state = context.test_state;
  const profile = { model: "old", adapter: "codex_cli", project_access: "read" };
  state.room = { id: "one", members: [{ name: "Codex", access: "runner" }] };
  state.launch.available = true;
  state.launch.room_models = { room_id: "one", participants: { Codex: profile } };
  const read = Promise.withResolvers(), latest = Promise.withResolvers();
  context.local_launch_request = (command, body) => {
    if (command === "room-models") return read.promise;
    if (command === "room-member-access") return latest.promise;
    return Promise.resolve({ model: body.model, effort: body.effort, model_pending: "window" });
  };
  const reading = context.load_room_models(true);
  await context.set_member_model({ name: "Codex", model: "new", effort: "high" });
  const changing = context.set_member_access({ name: "Codex", project_access: "write" });
  read.resolve({ room_id: "one", participants: { Codex: profile } });
  await reading;
  const shown = () => context.shown_launch().room_models.participants.Codex;
  assert.equal(shown().project_access, "write");
  assert.equal(shown().model_pending, "window");
  latest.reject(new Error("refused"));
  await assert.rejects(changing, /refused/);
  assert.equal(shown().project_access, "read");
  assert.equal(shown().model, "new");
});

test("saving host permissions keeps the settings rows, member model and expanded details during reload", async () => {
  const read = Promise.withResolvers();
  const room = { id: "one" };
  const saved = { room_id: room.id, registered: true, participants: { Codex: { model: "m1" } }, host_permissions: { items: [], room_limit: 8 } };
  const state = { room, launch: { available: true, room_models: saved } };
  const context = vm.createContext({ state, preloaded_room_models: new Map(), members_seen: null,
    localStorage: { getItem: () => "" }, publish_view() {}, shallowReactive: reactive,
    local_launch_request: async (action, payload) => action === "room-workflow"
      ? { host_permissions: payload.permissions, host_workflows: true } : read.promise });
  for (const [from, to] of [["function room_models_fields(", "/** Read a directory or file"], ["function update_room_models(", "/** What the new room"], ["async function set_room_host_workflows(", "// Workflows:"]]) {
    vm.runInContext(source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from))), context);
  }
  const component = name => readFileSync(new URL(`../frontend/${name}.vue`, import.meta.url), "utf8");
  const host = component("HostWorkflowSwitch");
  vm.runInContext(host.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/^import .*;$/gm, ""), context);
  const open_rooms = vm.runInContext("open_rooms", context);
  const render = template => new Function("Vue", compile(template, { prefixIdentifiers: true, isCustomElement: () => true }).code)(vue_runtime);
  const settings = render(component("RoomOverview").match(/<dl class="overview-settings">[\s\S]*?<\/dl>/)[0]);
  const details = render(host.match(/<details [\s\S]*?<\/details>/)[0]);
  const props = { roomId: room.id, current: saved.host_permissions, HOST_ITEMS: [], open_rooms, t };
  details(props, []).props.onToggle({ target: { open: true } });
  const rows = () => settings({ room, saved: state.launch.room_models, free: true, view: { launch: {}, access: {} }, t }, []).children.filter(row => row.type === "div").length;
  const count = rows();
  const verify = () => {
    assert.equal(rows(), count);
    assert.equal(details({ ...props }, []).props.open, true);
    assert.equal(state.launch.room_models.participants.Codex.model, "m1");
  };
  const permissions = { items: [], room_limit: 9 };
  const writing = context.set_room_host_workflows({ room_id: room.id, permissions });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.launch.room_models.loading, true);
  verify();
  read.resolve({ ...saved, host_permissions: permissions });
  await writing;
  verify();
});

test("a concurrent push lets the receipt read replace the member card before reading again", async () => {
  const { context, state, element } = attachment_fixture();
  const member = { id: 3, name: "Codex", access: "runner", status: "active" };
  state.room.free = { members: [member], requests: [] };
  state.refresh_version = 1;
  const message = { id: 8, created_at: new Date().toISOString() };
  const room_read = Promise.withResolvers(), started = Promise.withResolvers();
  Object.assign(context, { ROOM_TIMING_ENABLED: false, display_name: name => name, room_views: new Map(),
    message_history_key: room_id => room_id,
    patch_directory_room() {}, cache_room_entry() {}, merge_room_folder: room => room, render_room() {}, load_room_models() {},
    request_json: async (_url, payload) => {
      if (payload) return { message };
      started.resolve();
      return room_read.promise;
    },
    computed: getter => ({ get value() { return getter(); } }), line_marks: () => ({}),
    room: { get value() { return state.room; } },
    view: { get value() { return { recipient_previews: vm.runInContext("[...recipient_previews.values()]", context) }; } }
  });
  vm.runInContext(source.slice(source.indexOf("async function refresh_room_content("), source.indexOf("/** Refresh a room with version")), context);
  let reads = 0;
  context.refresh_room = ({ room }) => {
    assert.equal(room, true);
    reads++;
    return context.refresh_room_content("one", ++state.refresh_version, {});
  };
  let scheduled;
  context.UPDATE_BATCH_MS = 1;
  context.setTimeout = callback => { scheduled = callback; return 1; };
  vm.runInContext(source.slice(source.indexOf("function queue_live_refresh("), source.indexOf("/** Keep a low-frequency safety read")), context);
  Object.assign(context, { live_updates: { enabled: true, full: true }, document: { hidden: false }, end_resuming() {} });
  vm.runInContext(discussion_source.slice(discussion_source.indexOf("const QUEUED_PURPOSES"), discussion_source.indexOf("const free_now")), context);
  const cards = () => vm.runInContext("free_queued.value", context);
  element("message-input").value = "@Codex 请处理";
  const sending = context.send_message({ preventDefault() {} });
  assert.equal(cards().length, 0);
  await started.promise;
  const push = context.flush_live_refresh();
  assert.equal(reads, 1);
  assert.equal(context.receipt_messages()[0].id, message.id);
  // The receipt has no text (only text_chars); the card that replaces the sending card keeps what was sent.
  assert.equal(context.receipt_messages()[0].text, "@Codex 请处理");
  assert.equal(context.receipt_messages()[0].rendered_text, "<p>@Codex 请处理</p>", "the card draws rendered_text, so the receipt carries it too");
  assert.deepEqual(Array.from(cards(), card => [card.author, card.text]), [["Codex", "等待开始…"]]);
  room_read.resolve({ ...state.room, free: { members: [member], requests: [
    { id: 12, status: "pending", purpose: "ask", message_id: message.id, member_id: member.id }
  ] } });
  await Promise.all([sending, push]);
  assert.deepEqual(Array.from(cards(), card => [card.author, card.id, card.layout_after]), [["Codex", "queued-12", message.id]]);
  assert.equal(context.view.value.recipient_previews.length, 0);
  assert.equal(reads, 1);
  await scheduled();
  assert.equal(reads, 2);
});

test("a busy room previews consecutive sends in the queue and reconciles push and POST receipts", async () => {
  const { context, state, element } = attachment_fixture();
  const queue = { busy: true, items: [] };
  state.room.free = { queued_messages: queue };
  const first_reply = Promise.withResolvers(), second_reply = Promise.withResolvers();
  const first_started = Promise.withResolvers(), second_started = Promise.withResolvers();
  context.request_json = async (_url, data) => {
    if (data.text === "甲") { first_started.resolve(); return first_reply.promise; }
    second_started.resolve();
    return second_reply.promise;
  };
  const send = text => {
    element("message-input").value = text;
    return context.send_message({ preventDefault() {} });
  };
  const previews = () => Array.from(context.room_queueing_previews(), card => card.text);
  const first = send("甲"), second = send("乙");
  assert.deepEqual(previews(), ["甲", "乙"]);
  assert.equal(context.room_sending_previews().length, 0);
  await first_started.promise;
  queue.items.push({ id: 7 });
  assert.deepEqual(previews(), ["乙"]);
  first_reply.resolve({ queued: true, queue });
  await first;
  await second_started.promise;
  assert.deepEqual(previews(), ["乙"]);
  const refreshing = Promise.withResolvers(), refresh_started = Promise.withResolvers();
  context.refresh_room = () => { refresh_started.resolve(); return refreshing.promise; };
  second_reply.resolve({ message: { id: 8 } });
  await refresh_started.promise;
  assert.deepEqual(previews(), []);
  assert.equal(context.room_sending_previews()[0].saved_id, 8);
  const third_started = Promise.withResolvers();
  context.request_json = async () => { third_started.resolve(); return { queued: true, queue }; };
  const third = send("丙");
  await third_started.promise;
  await third;
  refreshing.resolve();
  await second;
  assert.equal(context.room_sending_previews().length, 0);
});

test("a send the network drops goes again by itself with the same submission before it becomes a failed card", async () => {
  const fixture = attachment_fixture(), { context, state, uploads, posts } = fixture;
  fixture.drop(2);
  context.add_attachments([{ name: "截图.png", size: 10, type: "image/png" }]);
  await context.send_message({ preventDefault() {} });
  assert.equal(posts.length, 3);
  assert.equal(new Set(posts.map(([, payload]) => payload.submission_id)).size, 1, "every attempt is the same submission");
  assert.equal(uploads.length, 1, "a file already uploaded is not sent again");
  assert.equal(state.failed_sends.length, 0);
  fixture.drop(9);
  fixture.element("message-input").value = "再发一条";
  await assert.rejects(context.send_message({ preventDefault() {} }), /Failed to fetch/);
  assert.equal(posts.length, 3 + 4, "three retries, then it stops");
  assert.equal(state.failed_sends.length, 1, "only then does it stay as a failed card");
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
  const state = { room: { id: "one" }, messages: [{ id: 5, text: "原问题" }], attachment_drafts: [] };
  const context = vm.createContext({ state, element: () => input, room_timing_mark() {}, notify: (level, text) => notified.push([level, text]),
    display_name: name => name, refresh_room: async () => {}, rewind_plan: async () => plan,
    fill_composer: (text) => { input.value = text; }, renumber_placeholders() {}, preupload_drafts() {}, publish_view() {},
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
  assert.match(notified[0][1], /^已撤回；正在停止 Codex；Claude 在自己的窗口或 App 里，本机停不了.*手动停止.*Claude 的会话未回退.*文件改动不会恢复$/,
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
    full_only_hint: () => '',
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

test('editing a workflow card never changes the same member in a room or copies its connection fields', () => {
  const original = { card: 'role', name: 'Codex', label: '作者', description: '原描述', system_prompt: '原提示词', project_access: 'read' };
  const f = expert_card_fixture({ ...original });
  try {
    const room_profile = JSON.stringify(f.view.value.launch.profiles);
    assert.equal(vm.runInContext('can_flip.value', f.context), false, 'a workflow card is set up in 专家配置, not on its back');
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
    clear_card_drafts: () => {},
    add_instance: (id, name, mode) => {
      let number = 2;
      while (view.value.experts[id][`${name}-${number}`]) number++;
      view.value.experts[id][`${name}-${number}`] = mode;
    } };
  const context = vm.createContext({ computed, ref, nextTick, defineProps: () => ({}), defineEmits: () => event => submissions.push(event),
    invite_after_creation: ref(null),
    inject: () => ({ view, bridge, is_running: name => pending.value === name, act: () => {} }), onMounted: callback => callback(), onBeforeUnmount: () => {},
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
  const formatter = component.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/^import .*;$/gm, "").replace("export function", "function");
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

test('a video goes up compressed when that helps, and is never lost when compression fails', async () => {
  const MIB = 1024 * 1024;
  const { context, notified } = theme_fixture();
  const uploaded = [];
  let compress = async () => null, loads = 0;
  context.document.dispatchEvent = () => {};
  Object.assign(context, { console, AbortController, CustomEvent: class { constructor(type, options) { Object.assign(this, { type }, options); } }, VideoEncoder: function () {}, VideoDecoder: function () {},
    render_attachment_drafts() {}, load_video_compressor: async () => { loads += 1; return { compress_video: (...input) => compress(...input) }; },
    post_room_file: async (path, file) => { uploaded.push(file); return { attachment: { id: `saved-${uploaded.length}` } }; } });
  context.test_state.remote_rooms = true;
  const draft = (size, type = 'video/mp4') => ({ id: `draft-${size}-${loads}-${uploaded.length}`, file: { name: 'clip.mov', size, type } });
  const smaller = { name: 'clip.mp4', size: MIB, type: 'video/mp4' };

  const shrunk = draft(12 * MIB);
  compress = async () => smaller;
  await context.upload_draft('room', '用户', shrunk);
  assert.equal(uploaded.at(-1), smaller, 'the smaller copy is what goes up');
  await context.upload_draft('room', '其他成员', shrunk);
  assert.equal(loads, 1, 'a video is compressed once, however often it is uploaded');

  for (const failing of [async () => null, async () => { throw new Error('encoder gave up'); }]) {
    const kept = draft(12 * MIB);
    compress = failing;
    await context.upload_draft('room', '用户', kept);
    assert.equal(uploaded.at(-1), kept.file, 'a video the site can take goes up as it is');
  }

  const count = uploaded.length, oversized = draft(40 * MIB);
  compress = async () => null;
  await assert.rejects(context.upload_draft('room', '用户', oversized), (error) => error.video_too_large === true);
  assert.equal(uploaded.length, count, 'a video the site would refuse is not sent');
  compress = async () => smaller;
  await context.upload_draft('room', '用户', oversized);
  assert.equal(uploaded.at(-1), smaller, 'sending again tries the compression again');

  const sent_before = uploaded.length, removed = draft(12 * MIB);
  compress = async () => { context.discard_draft_upload(removed); return null; };
  await context.upload_draft('room', '用户', removed);
  assert.equal(uploaded.length, sent_before, 'a video taken out while it compresses is not uploaded');

  const before = loads;
  await context.upload_draft('room', '用户', draft(2 * MIB));
  await context.upload_draft('room', '用户', draft(12 * MIB, 'application/pdf'));
  context.test_state.remote_rooms = false;
  await context.upload_draft('room', '用户', draft(12 * MIB));
  assert.equal(loads, before, 'small videos, other files and uploads that skip the relay stay as they are');
  assert.deepEqual(notified, []);
});

test('video compression plans a readable copy that fits the site, or declines', async () => {
  const { plan_compression } = await import('../frontend/video-compress.js');
  const MIB = 1024 * 1024, limit = 20 * MIB;
  const recording = { width: 1206, height: 2622, duration: 7.4, size: 12.3 * MIB, audio_bitrate: 128000, packet_rate: 60 };
  assert.deepEqual(plan_compression(recording, limit), { width: 588, height: 1280, bitrate: 1200000, frame_rate: 30 });
  assert.equal(plan_compression({ ...recording, width: 592, height: 1280, size: MIB, packet_rate: 30 }, limit), null, 'already small');
  const long = plan_compression({ ...recording, duration: 240, size: 400 * MIB }, limit);
  assert.ok(long.bitrate < 1200000 && (long.bitrate + 128000) * 240 / 8 <= limit, 'a long video is planned to fit');
  assert.equal(plan_compression({ ...recording, duration: 3600, size: 900 * MIB }, limit), null, 'too long to stay readable');
});

test('a relayed upload resends only lost parts, and a try after a failure carries on where it stopped', async () => {
  const { context } = theme_fixture();
  Object.assign(context, { Blob, btoa, atob, setTimeout: (resolve) => { resolve(); return 0; } });
  // The computer keeps parts by upload id and number, answers which it lacks, and keeps a finished file's answer.
  const computer = { parts: new Map(), finished: new Map() }, sent = [];
  let lose = () => false;
  context.relay_exchange = async (action, payload) => {
    assert.equal(action, 'room-upload');
    sent.push(payload.index);
    if (lose(payload)) throw Object.assign(new Error('lost on the way'), { unconfirmed: true });
    if (computer.finished.has(payload.id)) return computer.finished.get(payload.id);
    const parts = computer.parts.get(payload.id) || new Map();
    computer.parts.set(payload.id, parts.set(payload.index, payload.data));
    const missing = [...Array(payload.total).keys()].filter((index) => !parts.has(index));
    if (missing.length) return { status: 200, body: { received: payload.total - missing.length, missing } };
    const answer = { status: 201, body: { attachment: { id: payload.id } } };
    computer.finished.set(payload.id, answer);
    return answer;
  };
  const whole = (id) => Buffer.concat([...computer.parts.get(id)].sort(([a], [b]) => a - b).map(([, data]) => Buffer.from(data, 'base64')));
  const file = (fill) => new Uint8Array(3 * 128 * 1024 + 10).fill(fill);

  // A part lost once is sent again; every other part goes once, and the file arrives whole.
  const first = file(1);
  lose = (payload) => payload.index === 1 && sent.filter((index) => index === 1).length === 1;
  const shares = [];
  const done = await context.relay_upload('/api/rooms/r/attachments?submission_id=a', first, (share) => shares.push(share));
  assert.deepEqual([...sent].sort(), [0, 1, 1, 2, 3]);
  assert.deepEqual(shares, [0, 0.25, 0.5, 0.75, 1], 'progress counts the parts the computer confirmed');
  assert.ok(whole(done.attachment.id).equals(Buffer.from(first)));

  // A part that keeps getting lost fails the try; the next try of the same file sends only what the computer lacks.
  const second = file(2);
  sent.length = 0;
  lose = (payload) => payload.index === 2;
  await assert.rejects(context.relay_upload('/api/rooms/r/attachments?submission_id=b', second));
  lose = () => false;
  sent.length = 0;
  const resumed_shares = [];
  const resumed = await context.relay_upload('/api/rooms/r/attachments?submission_id=b', second, (share) => resumed_shares.push(share));
  assert.ok(!sent.includes(0) && !sent.includes(1) && sent.includes(2), `resent ${sent}`);
  assert.ok(resumed_shares[0] >= 0.5, `a resumed try starts from what the computer has, not ${resumed_shares[0]}`);
  assert.ok(whole(resumed.attachment.id).equals(Buffer.from(second)));
  assert.equal([...computer.parts.keys()].length, 2, 'the resumed try kept its upload id');

  // A computer that restarted and lost parts says which; those are sent again.
  const third = file(3);
  sent.length = 0;
  lose = (payload) => {
    if (payload.index === 3 && !computer.restarted) { computer.restarted = true; computer.parts.get(payload.id)?.delete(0); }
    return false;
  };
  const restarted = await context.relay_upload('/api/rooms/r/attachments?submission_id=c', third);
  assert.deepEqual([...sent].sort(), [0, 0, 1, 2, 3]);
  assert.ok(whole(restarted.attachment.id).equals(Buffer.from(third)));
});

test('ZIP preview lists once and reads only a clicked entry, preserving old-service fallback', async () => {
  const { context } = theme_fixture(), calls = [];
  const entry = { path: '资料/notes..txt', size: 3 };
  context.request_json = async path => { calls.push(path); return { entries: [entry] }; };
  context.read_room_file = async path => { calls.push(path); return Uint8Array.of(1, 2, 3); };
  const attachment = { id: 'a', room_id: 'r' };
  const rows = await context.read_zip_directory('r', 'test.zip', 0, attachment);
  assert.deepEqual(calls, ['/api/rooms/r/attachments/a/zip']);
  assert.deepEqual(Array.from(await rows[0].read()), [1, 2, 3]);
  assert.equal(new URL(calls[1], 'https://local.test').searchParams.get('entry'), entry.path);
  context.request_json = async () => { throw Object.assign(new Error('old'), { status: 404 }); };
  assert.equal(await context.read_zip_directory('r', 'test.zip', 0, attachment), null);
  context.request_json = async () => { throw Object.assign(new Error('invalid'), { status: 400 }); };
  await assert.rejects(context.read_zip_directory('r', 'test.zip', 0, attachment), /invalid/);
  const offsets = [];
  context.atob = atob;
  context.manage_room_files = async (_, input) => {
    if (input.op === 'zip-list') return { entries: [entry] };
    offsets.push(input.offset);
    return { total: 3, offset: input.offset, version: 'one', data: input.offset ? 'Aw==' : 'AQI=' };
  };
  const listed = await context.read_zip_directory('r', 'project.zip', 1);
  assert.deepEqual(offsets, []);
  assert.deepEqual(Array.from(await listed[0].read()), [1, 2, 3]);
  assert.deepEqual(offsets, [0, 2]);
  context.manage_room_files = async () => { throw new Error('文件操作只能为 roots/read/save'); };
  assert.equal(await context.read_zip_directory('r', 'project.zip', 1), null);

});

test('attachment button metadata reaches preview without a metadata or relay read first', async () => {
  const { context } = theme_fixture(), opened = [];
  Object.assign(context, {
    request_json: () => assert.fail('button metadata already identifies the attachment'),
    attachment_url: () => assert.fail('the opened viewer resolves its own content address'),
  });
  context.test_state.remote_rooms = true;
  context.test_state.text_preview = file => opened.push(file);
  context.test_state.image_viewer = (files, index) => opened.push(files[index]);
  for (const [fileName, contentType] of [['table.xlsx', 'application/octet-stream'], ['image.png', 'image/png'], ['moon.html', 'application/octet-stream']]) {
    const opening = context.preview_attachment({ room_id: 'one', id: 'attachment', fileName, contentType, fileSize: '42', createdAt: '2026-11-10' });
    assert.equal(opened.at(-1).file_name, fileName);
    assert.equal(opened.at(-1).size, 42);
    assert.equal(opened.at(-1).created_at, '2026-11-10');
    await opening;
  }
});

test("a height report changes only its own visual and the last height is reused", () => {
  const window_target = {};
  const report = { codiscuss_visual_height: 300.25 };
  assert.equal(inline_visual_height({ source: {}, data: report }, window_target), null);
  assert.equal(inline_visual_height({ source: window_target, data: { codiscuss_visual_height: Infinity } }, window_target), null);
  assert.equal(inline_visual_height({ source: window_target, data: { codiscuss_visual_height: "300" } }, window_target), null);
  const height = inline_visual_height({ source: window_target, data: report }, window_target);
  assert.equal(height, 301);
  remember_visual_height({ id: "measure-test" }, height);
  assert.equal(remembered_visual_height({ id: "measure-test" }), height);
});

test("an HTML attachment opened in a new tab updates the same sandbox when the room theme changes", () => {
  const dark = { "--codiscuss-color-scheme": "dark", "--codiscuss-card": "#303236" };
  const light = { "--codiscuss-color-scheme": "light", "--codiscuss-card": "#ffffff" };
  const source = { isConnected: true, ownerDocument: { defaultView: {} } };
  const received = [], document_root = { style: {} };
  const frame = { contentWindow: { postMessage: (data, target) => received.push([data.codiscuss_visual_theme, target]) },
    addEventListener(event, callback) { this[event] = callback; } };
  const view = {
    opener: { document: { documentElement: source } },
    document: { querySelector: () => frame, documentElement: document_root },
    addEventListener(event, callback) { this[event] = callback; },
  };
  let room_theme = dark, change_theme, disconnected = false;
  start_visual_tab(dark, () => room_theme, (callback, observed_root) => {
    assert.equal(observed_root, source);
    change_theme = callback;
    return () => { disconnected = true; };
  }, send_visual_theme, view);

  frame.load();
  assert.deepEqual(received.at(-1), [dark, "*"]);
  assert.equal(document_root.style.backgroundColor, "#303236");
  room_theme = light;
  change_theme();
  assert.deepEqual(received.at(-1), [light, "*"]);
  assert.equal(document_root.style.colorScheme, "light");
  assert.equal(document_root.style.backgroundColor, "#ffffff");
  view.pagehide();
  assert.equal(disconnected, true);
});

test("a collapsed visual stays collapsed on remount and reopening clears the saved preference", (context) => {
  const values = new Map(), original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key),
  } });
  context.after(() => {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else delete globalThis.localStorage;
  });
  const file = { id: "demo", room_id: "room" };
  assert.equal(inline_visual_collapsed(file), false);
  inline_visual_collapsed(file, true);
  assert.equal(inline_visual_collapsed({ ...file }), true);
  assert.equal(inline_visual_collapsed({ ...file, room_id: "other" }), false);
  inline_visual_collapsed(file, false);
  assert.equal(inline_visual_collapsed({ ...file }), false);
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
      const body = { participants: { Claude: { adapter: 'claude', executable: '/local/claude' } } };
      return { ok: true, json: async () => body, text: async () => JSON.stringify(body) };
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
  ], executions: [{ id: 9, member_id: 8, member: "Claude", role: "member", status: "failed", request_message_id: 900, layout_after: 1, layout_at: 1002,
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
  f.context.window.discuss_backup = { adapter_profile: () => null };
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
    api_keys: { 'https://jev.test': 'saved-key-ref' }, saved_profiles: { Codex: { adapter: 'codex_cli' } } });
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
function free_card_fixture({ messages = [], members = [], executions = [], requests = [], failure_wakes = [], routing_messages = new Set(), scheduler_decisions = new Map(), query = "", source_filter = false, now = 1000 } = {}) {
  const timers = new Map();
  let timer_id = 0, current_time = now;
  class TestDate extends Date { static now() { return current_time * 1000; } }
  const view = reactive({ value: { query, source_filter, authors: [], messages, access: { can_manage: true }, room: {
    id: "room", mode: "free", archived: false, members: [], free: { members, executions, requests, failure_wakes }, session: null,
  } } });
  const context = vm.createContext({ computed, stable_computed: computed, ref, watch, view,  room: computed(() => view.value.room), Date: TestDate,
    routing_messages: ref(routing_messages), scheduler_decisions: ref(scheduler_decisions),
    setInterval: callback => { timers.set(++timer_id, callback); return timer_id; }, clearInterval: id => timers.delete(id),
    bridge: { request: async () => ({ notes: [] }) }, line_marks: () => ({ badges: [], edge: "" }) });
  const busy_start = discussion_source.indexOf("const free = computed(");
  const busy_end = discussion_source.indexOf("/** Late text is owner-only", busy_start);
  vm.runInContext(`${discussion_source.slice(busy_start, busy_end)}\nglobalThis.cards = { busy: free_busy, working: free_working, now: free_now };`, context);
  const layout_start = discussion_source.indexOf("const failure_wakes = computed(");
  const layout_end = discussion_source.indexOf("\n});", discussion_source.indexOf("const free_layout = computed(", layout_start)) + 4;
  vm.runInContext(`${discussion_source.slice(layout_start, layout_end)}\nglobalThis.layout_state = { failures: free_failures, layout: free_layout, rewinds: rewound_runs, toggle: toggle_rewound };`, context);
  return { context, view: view.value, room: view.value.room, cards: context.cards, state: context.layout_state, timers,
    advance(seconds) { current_time += seconds; for (const callback of timers.values()) callback(); } };
}

function execution_member(id, name = "Codex", status = "dispatched", extra = {}) {
  return { id, name, access: "runner", status: "active", adapter: "claude_code", pending: 0,
    execution: { id, status, stale: false, created_at: 1000, activity_at: 1000, ...extra } };
}

test("free execution cards show live member work and hide inactive executions", async () => {
  const member = execution_member(9), execution = { id: 9, member_id: 9, member: "Codex", status: "dispatched", request_message_id: 1, layout_after: 1, created_at: 1000 };
  const f = free_card_fixture({ messages: [{ id: 1, author: "用户", created_at: 1000 }], members: [member], executions: [execution] });
  const diagnostics = [];
  f.context.debug_log = (event, data) => diagnostics.push([event, data]);
  assert.deepEqual(f.cards.working.value.map(item => [item.id, item.author, item.text, item.working]), [["free-9", "Codex", "正在处理", true]]);
  assert.deepEqual([...f.state.layout.value].map(item => item.id), [1, "free-9"]);
  assert.deepEqual(diagnostics.map(([event, data]) => [event, data.execution, data.after, data.anchor, data.reason]),
    [["card-layout", 9, 1, 1, "attached"]]);
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

test("retried pending and active cards stay below the failed execution card", async () => {
  const member = { id: 9, name: "Gemini", access: "runner", status: "active", adapter: "antigravity_cli", pending: 1, execution: null };
  const failed = { id: 5721, member_id: 9, member: "Gemini", status: "failed", request_message_id: 1, layout_after: 1, layout_at: 1003,
    created_at: 1003, finished_at: 1200, result: "network error", retried: true, requests: [] };
  const pending = { id: 6206, member_id: 9, message_id: 1, status: "pending", execution_id: null, purpose: "ask",
    created_at: 1000, layout_after: 1, layout_at: 1003 };
  const f = free_card_fixture({ messages: [{ id: 1, author: "用户", created_at: 1000 }], members: [member], executions: [failed], requests: [pending] });
  assert.deepEqual([...f.state.layout.value].map(item => item.id), [1, "failed-5721", "queued-6206"],
    "pending retry card sits below the failed card even when retried in the same second");
  f.room.free.requests = [];
  f.room.free.members[0].execution = { id: 5722, status: "dispatched", stale: false, created_at: 1500, activity_at: 1500 };
  f.room.free.executions = [{ id: 5722, member_id: 9, member: "Gemini", status: "dispatched", request_message_id: 1, layout_after: 1, layout_at: 1500, created_at: 1500 }, failed];
  await nextTick();
  assert.deepEqual([...f.state.layout.value].map(item => item.id), [1, "failed-5721", "free-5722"],
    "active retry card stays below the failed card");
});

test("an interrupted requeued request hides its ghost waking card only behind a newer visible card in the same next batch", async () => {
  const member = { id: 9, name: "Gemini", access: "runner", status: "active", adapter: "antigravity_cli", pending: 2, execution: null };
  const stopped = { id: 5746, member_id: 9, member: "Gemini", status: "cancelled", request_message_id: 1, layout_after: 1, layout_at: 1000,
    created_at: 1000, finished_at: 1200, result: "已打断：你立即发送了新消息，它会连同这条一起处理", capabilities: { stoppable: true }, requests: [] };
  const requeued = { id: 6230, member_id: 9, message_id: 1, status: "pending", execution_id: null, purpose: "ask",
    created_at: 1000, layout_after: 1, layout_at: 1200, retried: true, next_batch: true };
  const interrupting = { id: 6231, member_id: 9, message_id: 2, status: "pending", execution_id: null, purpose: "ask",
    created_at: 1200, layout_after: 2, layout_at: 1200, retried: false, next_batch: true };
  const f = free_card_fixture({
    messages: [{ id: 1, author: "用户", created_at: 1000 }, { id: 2, author: "用户", created_at: 1200 }],
    members: [member], executions: [stopped], requests: [requeued, interrupting],
  });
  assert.deepEqual([...f.state.layout.value].map(item => item.id), [1, "stopped-5746", 2, "queued-6231"],
    "only the interrupting message gets a waking card when both are in the same next_batch");
  assert.equal(f.state.layout.value.find(item => item.id === "queued-6231").text, "正在唤醒");
  // Separate delivery lane (`next_batch: false`): both cards show, and the second says waiting for previous turn, not bundled.
  f.room.free.requests = [requeued, { ...interrupting, next_batch: false }];
  await nextTick();
  assert.deepEqual([...f.state.layout.value].map(item => item.id), [1, "stopped-5746", "queued-6230", 2, "queued-6231"]);
  assert.equal(f.state.layout.value.find(item => item.id === "queued-6230").text, "正在唤醒");
  assert.equal(f.state.layout.value.find(item => item.id === "queued-6231").text, "排队中：等上一轮结束");
  // While smart scheduling is still analysing a newer route message, the older retried card stays visible instead of vanishing.
  const f_route = free_card_fixture({
    messages: [{ id: 1, author: "用户", created_at: 1000 }, { id: 2, author: "用户", created_at: 1200 }],
    members: [member], executions: [stopped], routing_messages: new Set([2]),
    requests: [requeued, { id: 6232, member_id: 9, message_id: 2, status: "pending", execution_id: null, purpose: "route",
      created_at: 1200, layout_after: 2, layout_at: 1200, retried: false, next_batch: true }],
  });
  assert.deepEqual([...f_route.state.layout.value].map(item => item.id), [1, "stopped-5746", "queued-6230", 2]);
  assert.equal(f_route.state.layout.value.find(item => item.id === "queued-6230").text, "正在唤醒");
});

test("undeliverable requests share next_batch dedupe and layout_at ordering, quiet checkins require their notice, and host failure wakes keep the failed card visible", async () => {
  const blocked = { id: 9, name: "Gemini", access: "runner", status: "active", adapter: "antigravity_cli", adopt_error: "无法接管", pending: 2, execution: null };
  const failed = { id: 10, member_id: 9, member: "Gemini", status: "failed", request_message_id: 1, layout_after: 1, layout_at: 1005,
    created_at: 1005, finished_at: 1005, result: "fail", retried: true, requests: [] };
  const retried_req = { id: 20, member_id: 9, message_id: 1, status: "pending", execution_id: null, purpose: "ask",
    created_at: 1000, layout_after: 1, layout_at: 1005, retried: true, next_batch: true };
  const newer_req = { id: 21, member_id: 9, message_id: 2, status: "pending", execution_id: null, purpose: "ask",
    created_at: 1010, layout_after: 2, layout_at: 1010, retried: false, next_batch: true };
  const f = free_card_fixture({
    messages: [{ id: 1, author: "用户", created_at: 1000 }, { id: 2, author: "用户", created_at: 1010 },
      { id: 30, author: "Gemini", source: "cli", text: "一切正常", created_at: 1020 }],
    members: [blocked], executions: [failed], requests: [retried_req, newer_req],
  });
  f.room.free.quiet_checkins = [{ message_id: 29, answer_id: 30 }];
  await nextTick();
  assert.deepEqual([...f.state.layout.value].map(item => item.id), [1, "failed-10", 2, "undeliverable-21", 30],
    "bundled retried undeliverable request is hidden behind newer pending request, and checkin answer stays visible when its notice is not loaded");
  f.room.free.requests = [retried_req];
  await nextTick();
  assert.deepEqual([...f.state.layout.value].map(item => item.id), [1, "failed-10", "undeliverable-20", 2, 30],
    "single retried undeliverable request sits below its failed execution even in the same second");
  // Host failure wake-up keeps the failed card visible (preserving duration & notes) while marking it followed and ordering the wake-up below it.
  const active = execution_member(9, "Gemini", "dispatched", { id: 77, created_at: 1020 });
  const replaced = { id: 70, member_id: 9, member: "Gemini", status: "failed", request_message_id: 1, layout_after: 1, layout_at: 1000, created_at: 1000, finished_at: 1005, result: "timeout", requests: [] };
  const merged = { id: 77, member_id: 9, member: "Gemini", status: "dispatched", request_message_id: 1, replaces_execution_id: 70, layout_after: 2, layout_at: 1020,
    created_at: 1020, requests: [{ id: 20, message_id: 1 }, { id: 21, message_id: 2 }] };
  const f2 = free_card_fixture({ messages: [{ id: 1, author: "用户", created_at: 1000 }, { id: 2, author: "用户", created_at: 1010 }],
    members: [active], executions: [merged, replaced] });
  assert.equal(f2.cards.working.value[0].work_message_id, 2);
  assert.equal(f2.cards.working.value[0].replaced?.id, 70);
  assert.equal(f2.cards.working.value[0].replaced?.result, "timeout");
  assert.equal(f2.state.failures.value.find(item => item.execution_id === 70)?.failure.followed, true);
  assert.deepEqual([...f2.state.layout.value].map(item => item.id), [1, "failed-70", 2, "free-77"]);
  // A host wake-up matched only via failure_wakes keeps the failed card above it under the same anchor message.
  const wake_only = { ...merged, replaces_execution_id: null, request_message_id: 99, layout_after: 1, layout_at: 1020 };
  const f3 = free_card_fixture({ messages: [{ id: 1, author: "用户", created_at: 1000 }],
    members: [active], executions: [wake_only, replaced], failure_wakes: [{ message_id: 99, execution_id: 70 }] });
  assert.equal(f3.cards.working.value[0].replaced?.id, 70);
  assert.equal(f3.state.failures.value.find(item => item.execution_id === 70)?.failure.followed, true);
  assert.deepEqual([...f3.state.layout.value].map(item => item.id), [1, "failed-70", "free-77"]);
});

test("send_queued avoids duplicate sending previews both for visible messages and during refresh handoff", async () => {
  const f = theme_fixture();
  let preview_during_send = "unset";
  f.context.test_state.room = { id: "r1", free: { queued_messages: { items: [{ id: 5, message_id: 101, text: "已发出", attachments: [] }] } } };
  f.context.test_state.messages = [{ id: 101, author: "用户", text: "已发出" }];
  f.context.queue_request = async () => { preview_during_send = f.context.test_state.sending_preview; };
  f.context.publish_view = () => {};
  await f.context.send_queued(5);
  assert.equal(preview_during_send, null);
  // Unpublished queued row gets its new message_id from the queue response so the preview drops as soon as messages include it.
  const f2 = theme_fixture();
  let previews_after_refresh = null;
  f2.context.test_state.room = { id: "r1", free: { queued_messages: { items: [{ id: 6, text: "刚发出", attachments: [] }] } } };
  f2.context.test_state.messages = [];
  f2.context.publish_view = () => {};
  f2.context.request_json = async () => ({ items: [], paused: false, busy: false, host_busy: false, busy_members: [], message_id: 202 });
  f2.context.refresh_room = async () => {
    f2.context.test_state.messages = [{ id: 202, author: "用户", text: "刚发出" }];
    previews_after_refresh = f2.context.room_sending_previews();
  };
  await f2.context.send_queued(6);
  assert.deepEqual([...previews_after_refresh], []);
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
  const state = context.test_state;
  state.room = { id: "scale50" };
  context.publish_view = () => {};
  context.request_json = async (path) => {
    requests.push(path);
    const url = new URL(path, "http://test.local");
    const room = url.pathname.split("/")[3];
    const params = url.searchParams;
    if (!params.size) return { id: room };
    const limit = Number(params.get("limit"));
    if (params.has("before")) {
      const before = Number(params.get("before"));
      const earlier = records.filter(message => message.room === room && (!before || message.id < before));
      return { messages: earlier.slice(-limit), has_earlier: earlier.length > limit };
    }
    const matching = records.filter((message) => message.room === room && message.id > Number(params.get("after"))
      && (!params.get("q") || message.text.includes(params.get("q")))
      && (!params.get("mention") || message.text.includes(`@${params.get("mention")}`)));
    const messages = matching.slice(0, limit);
    return { messages, has_more: matching.length > limit, next_after: messages.at(-1)?.id || Number(params.get("after")) };
  };
  const load = async () => {
    const version = state.refresh_version;
    const history = await context.read_message_history("scale50", state.query, () => version === state.refresh_version);
    if (history) context.render_messages(history);
    return history;
  };
  return { context, state, requests, load };
}

test("rooms not on screen stay cached while working or after they change", async () => {
  const records = [{ id: 1, room: "working", text: "进行中" }, { id: 2, room: "idle", text: "旧消息" }, { id: 3, room: "open", text: "当前房间" }];
  const fixture = history_fixture(records);
  fixture.state.room = { id: "open" };
  const cached = id => {
    const history = fixture.context.cached_message_history(id);
    return history ? Array.from(history.messages, message => message.id) : undefined;
  };
  const directory = (idle_latest) => [{ id: "working", latest_id: 1, running: true }, { id: "idle", latest_id: idle_latest, running: false }, { id: "open", latest_id: 3, running: true }];

  await fixture.context.sync_background_rooms(directory(2));
  assert.deepEqual(cached("working"), [1]);
  assert.equal(vm.runInContext("room_views.has('working')", fixture.context), true);
  assert.equal(cached("idle"), undefined, "a room idle since the page opened is not read");
  assert.equal(cached("open"), undefined, "the open room is read by the page itself");

  records.push({ id: 4, room: "idle", text: "新消息" });
  await fixture.context.sync_background_rooms(directory(4));
  assert.deepEqual(cached("idle"), [2, 4]);
});

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

test("history reads one latest page, prepends on demand and reaches a jump target", async () => {
  const records = Array.from({ length: 250 }, (_, index) => ({ id: index + 1, room: "scale50", text: "发言" }));
  const fixture = history_fixture(records);
  const first = await fixture.load();
  assert.deepEqual(Array.from(first.messages, message => message.id), records.slice(-40).map(message => message.id));
  assert.equal(first.has_earlier, true);
  assert.equal(fixture.requests.length, 1);
  assert.match(fixture.requests[0], /limit=40.*before=0$/);
  const earlier = fixture.context.load_earlier_messages();
  assert.equal(earlier, fixture.context.load_earlier_messages(), "the same page already in flight is not requested twice");
  assert.equal(await earlier, true);
  assert.equal(fixture.state.messages[0].id, 11);
  assert.match(fixture.requests.at(-1), /before=211$/);
  assert.equal(await fixture.context.load_messages_until(3), true);
  assert.equal(fixture.state.message_history.has_earlier, false);
  assert.match(fixture.requests.at(-1), /before=11$/);
  records.push({ id: 251, room: "scale50", text: "新发言" });
  const refreshed = await fixture.load();
  assert.match(fixture.requests.at(-1), /after=250$/);
  assert.deepEqual(Array.from(refreshed.messages, message => message.id), records.map(message => message.id));
});

test("an obsolete request cannot replace history after a room or filter change", async () => {
  const records = Array.from({ length: 50 }, (_, index) => ({ id: index + 1, room: "scale50", text: index ? "已读取" : "关键词" }));
  const { context, state, load } = history_fixture(records);
  await load();
  const request = context.request_json;
  let finish;
  context.request_json = path => path.endsWith("before=11") ? new Promise(resolve => { finish = resolve; }) : request(path);
  const earlier = context.load_earlier_messages();
  context.set_message_query("关键词");
  const search = await load();
  vm.runInContext("message_histories.delete(message_history_key('scale50'));", context);
  finish({ messages: records.slice(0, 10), has_earlier: false });
  assert.equal(await earlier, false);
  assert.equal(state.message_history, search);
  assert.deepEqual(Array.from(state.messages, message => message.id), [1]);
});

test("concurrent cold history reads retain the newer overlapping page without duplicate records", async () => {
  const { context, load } = history_fixture([]);
  const responses = [];
  context.request_json = path => {
    assert.match(path, /before=0$/);
    return new Promise(resolve => responses.push(resolve));
  };
  const preload = context.read_message_history("scale50", "", () => true);
  const opening = load();
  const records = Array.from({ length: 60 }, (_, index) => ({ id: index + 1 }));
  responses[0]({ messages: records.slice(10, 50), has_earlier: true });
  await preload;
  responses[1]({ messages: records.slice(20), has_earlier: true });
  assert.deepEqual(Array.from((await opening).messages, message => message.id), records.slice(10).map(message => message.id));
});

test("concurrent disjoint cold history pages fill the gap from the cached cursor", async () => {
  const records = Array.from({ length: 100 }, (_, index) => ({ id: index + 1, room: "scale50" }));
  const { context, load, requests } = history_fixture(records);
  const read = context.request_json, cold = [];
  context.request_json = path => path.endsWith("before=0") ? new Promise(resolve => cold.push(resolve)) : read(path);
  const preload = context.read_message_history("scale50", "", () => true);
  const opening = load();
  cold[0]({ messages: records.slice(0, 40), has_earlier: false });
  await preload;
  cold[1]({ messages: records.slice(60), has_earlier: true });
  const history = await opening;
  assert.match(requests.at(-1), /after=40$/);
  assert.deepEqual(Array.from(history.messages, message => message.id), records.map(message => message.id));
});

test("an earlier history request reports errors to its caller and can be retried", async () => {
  const records = Array.from({ length: 50 }, (_, index) => ({ id: index + 1, room: "scale50" }));
  const { context, load, state } = history_fixture(records);
  await load();
  const read = context.request_json;
  context.request_json = async () => { throw new Error("request failed"); };
  context.notify = () => assert.fail("the history bridge must not show a notice");
  await assert.rejects(context.load_earlier_messages(), /request failed/);
  context.request_json = read;
  assert.equal(await context.load_earlier_messages(), true);
  assert.equal(state.messages[0].id, 1);
});

test("retract availability does not mistake a filtered tail or missing historical requests for an untouched message", () => {
  const { context } = history_fixture([]);
  const requests = Array.from({ length: 100 }, (_, index) => ({ message_id: 200 - index, status: "pending", created_at: 200 - index }));
  requests[0].status = "completed";
  const room = { latest_id: 205, free: { requests } };
  const message = (id, seconds) => ({ id, created_at: new Date(seconds * 1000).toISOString() });
  assert.equal(context.can_retract_message(message(100, 100), room), false);
  assert.equal(context.can_retract_message(message(101, 101), room), false);
  assert.equal(context.can_retract_message(message(102, 102), room), true);
  assert.equal(context.can_retract_message(message(200, 200), room), false);
  assert.equal(context.can_retract_message(message(205, 205), room), true);
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

test("replay auto-follow dynamically zooms to elapsed active work, widens with progress or idle gaps and eases smoothly", () => {
  const min = 60_000;
  const spans = [
    { start: 0, end: 2 * min },            // short 2m run
    { start: 10 * min, end: 32 * min },    // long 22m run
    { start: 82 * min, end: 85 * min },    // 3m run after a 50m idle gap
    { start: 100 * min, end: 110 * min },  // later run so 83m is well inside the axis
  ];
  const total = 110 * min;
  const x = (time) => time / total;
  const on_long_early = replay_follow_window(spans, x, 11 * min, total);
  const on_long_late = replay_follow_window(spans, x, 31 * min, total);
  const on_idle = replay_follow_window(spans, x, 72 * min, total);
  const after_idle = replay_follow_window(spans, x, 83 * min, total);
  assert.ok(on_long_early.span < on_long_late.span, "the same long run starts tightly framed and widens as it progresses");
  assert.ok(on_long_early.span < 0.05, "1 minute into a 22-minute run stays focused instead of jumping to the full run width");
  assert.ok(on_long_late.span < on_idle.span, "a long idle stretch widens beyond the preceding run");
  assert.ok(after_idle.span < on_idle.span, "resuming work after an idle gap zooms back in");
  assert.ok(Math.abs((x(83 * min) - after_idle.from) / after_idle.span - 0.8) < 1e-6, "playback line stays at 80% of view");
  const stepped = step_follow_window(on_long_early, on_long_late, x(20 * min), 100);
  assert.ok(stepped.span > on_long_early.span && stepped.span < on_long_late.span, "step eases smoothly toward target span");
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

test("relayed room files are read two at a time, a file the user opens at once, and each only once", async () => {
  const f = update_fixture(), started = [], finish = new Map();
  f.context.URL = { createObjectURL: (blob) => `blob:${blob}` };
  f.context.relay_room_bytes = (path, { parallel }) => { started.push(`${path}:${parallel}`); return new Promise((resolve) => finish.set(path, () => resolve(path))); };
  const reads = ["a", "b", "c", "d"].map((name) => f.context.relay_file_url(`/files/${name}`));
  assert.equal(started.join(), "/files/a:1,/files/b:1", "a room full of images does not read them all at once");
  const opened = f.context.relay_file_url("/files/opened", { urgent: true });
  assert.equal(started.at(-1), "/files/opened:3", "the file the user opened does not wait for the images");
  f.context.relay_file_url("/files/d", { urgent: true });
  assert.equal(started.at(-1), "/files/d:3", "opening an image still waiting in line starts its read now");
  f.context.relay_file_url("/files/a");
  for (const path of ["/files/a", "/files/b", "/files/opened", "/files/d"]) finish.get(path)();
  await opened;
  await new Promise((resolve) => setImmediate(resolve));
  finish.get("/files/c")();
  assert.equal(JSON.stringify(await Promise.all(reads)), JSON.stringify(["a", "b", "c", "d"].map((name) => `blob:/files/${name}`)));
  assert.equal(started.length, 5, "a file already read is not read again");
});

test("relay attachments survive reload, skip network slots, isolate computers and clear on unpair", async () => {
  const indexedDB = new IDBFactory(), path = "/api/rooms/r/attachments/a/content";
  let reads = 0;
  function device(machine) {
    const { context } = update_fixture();
    Object.assign(context, { indexedDB, IDBKeyRange, Blob });
    context.test_state.remote_rooms = true;
    context.localStorage.setItem("codiscuss-paired", JSON.stringify({ machine_id: machine }));
    context.set_relay_machine({ id: machine });
    context.relay_room_bytes = async () => new Blob([machine + ++reads]);
    return context;
  }
  const first = device("A");
  await first.relay_file_url(path);
  const scope = first.attachment_cache_scope();
  assert.equal(await (await first.cached_attachment(scope, path)).blob.text(), "A1");
  const reopened = device("A");
  reopened.queue_relay_file = () => assert.fail("a hit must not queue or use the relay");
  const url = await reopened.relay_file_url(path);
  assert.equal(await (await fetch(url)).text(), "A1");
  reopened.relay_file_part = () => assert.fail("a range of a cached attachment must stay local");
  assert.equal(Buffer.from(await reopened.relay_room_range(path, 1, 2)).toString(), "1");
  const second = device("B");
  await second.relay_file_url(path);
  assert.equal(await (await second.cached_attachment(second.attachment_cache_scope(), path)).blob.text(), "B2");
  await reopened.forget_pairing();
  assert.equal((await first.cached_attachment(scope, path)).blob, undefined);
  assert.equal(await (await second.cached_attachment(second.attachment_cache_scope(), path)).blob.text(), "B2");
  assert.equal(reads, 2);
});

test("relay attachment reads still display without IndexedDB and removed files stay out of storage", async () => {
  const { context } = update_fixture();
  context.test_state.remote_rooms = true;
  context.localStorage.setItem("codiscuss-paired", JSON.stringify({ machine_id: "A" }));
  context.set_relay_machine({ id: "A" });
  const base = "/api/rooms/r/attachments/a/", path = base + "thumbnail";
  context.relay_room_bytes = async () => new Blob(["local fallback"]);
  assert.equal(await (await fetch(await context.relay_file_url(path))).text(), "local fallback");
  context.remove_room_cache(base);
  assert.equal(context.removed_attachment_path(path), true);
  assert.equal(context.removed_attachment_path("/api/rooms/r/attachments/ab/thumbnail"), false);
});

function paired_attachment_fixture() {
  const fixture = update_fixture(), { context } = fixture;
  Object.assign(context, { indexedDB: new IDBFactory(), IDBKeyRange, Blob });
  context.test_state.remote_rooms = true;
  context.localStorage.setItem("codiscuss-paired", JSON.stringify({ machine_id: "A" }));
  context.set_relay_machine({ id: "A" });
  return fixture;
}

test("stalled attachment lookup falls back once and its late result cannot replace the displayed file", async () => {
  const f = paired_attachment_fixture(), path = "/api/rooms/r/attachments/a/content";
  let finish, reads = 0;
  f.context.cached_attachment = () => new Promise(resolve => { finish = resolve; });
  f.context.relay_room_bytes = async () => { reads++; return new Blob(["network"]); };
  const display = f.context.relay_file_url(path);
  await f.run(300);
  const url = await display;
  finish({ blob: new Blob(["late"]) });
  assert.equal(await f.context.relay_file_url(path), url);
  assert.equal(await (await fetch(url)).text(), "network");
  assert.equal(reads, 1);
});

test("offline and reconnect preserve displayed attachment URLs until the computer changes", async () => {
  const { context } = paired_attachment_fixture(), path = "/api/rooms/r/attachments/a/content";
  context.relay_room_bytes = async () => new Blob(["A"]);
  const url = await context.relay_file_url(path);
  context.set_relay_machine(null);
  assert.equal(await (await fetch(url)).text(), "A");
  context.set_relay_machine({ id: "A" });
  assert.equal(await context.relay_file_url(path), url);
  context.set_relay_machine(null);
  context.set_relay_machine({ id: "B" });
  await assert.rejects(fetch(url));
});

test("document byte reads retain no object URL and repair missing stored bytes on the next read", async () => {
  const { context } = paired_attachment_fixture(), path = "/api/rooms/r/attachments/a/content";
  const scope = context.attachment_cache_scope();
  let reads = 0;
  context.URL = { createObjectURL() { assert.fail("byte-only reads must not pin an object URL"); } };
  context.relay_room_bytes = async () => new Blob([reads++ ? "new" : "original"]);
  assert.equal(Buffer.from(await context.read_room_file(path)).toString(), "original");
  assert.equal(Buffer.from(await context.read_room_file(path)).toString(), "original");
  await context.attachment_transaction(async bodies => { bodies.delete([scope, path]); });
  assert.equal(Buffer.from(await context.read_room_file(path)).toString(), "new");
  assert.equal(await (await context.cached_attachment(scope, path)).blob.text(), "new");
  const bytes = await vm.runInContext('attachment_transaction(async (_bodies, _usage, state) => cache_result(state.get("bytes")))', context);
  assert.equal(bytes, 3);
  assert.equal(reads, 2);
});

test("an attachment pairing error forgets the pairing only in device authentication mode", async () => {
  for (const devices of [false, true]) {
    const { context, storage } = paired_attachment_fixture();
    context.test_state.admin.devices = devices;
    context.relay_exchange = async () => { throw Object.assign(new Error("pair"), { need: "pairing" }); };
    await assert.rejects(context.relay_file_part("/file", 0), /pair/);
    assert.equal(storage.has("codiscuss-paired"), !devices);
  }
});

test("relay attachment LRU evicts by access across computers and rejects stale post-purge writes", async () => {
  const { context } = update_fixture();
  Object.assign(context, { indexedDB: new IDBFactory(), IDBKeyRange });
  const body = new Blob([new Uint8Array(20 * 1024 * 1024)]);
  for (let i = 0; i < 10; i++) await context.keep_cached_attachment("A", String(i), body, undefined);
  assert.equal((await context.cached_attachment("A", "0")).blob.size, body.size);
  await context.keep_cached_attachment("B", "new", body, undefined);
  assert.equal((await context.cached_attachment("A", "1")).blob, undefined);
  assert.equal((await context.cached_attachment("A", "0")).blob.size, body.size);
  const miss = await context.cached_attachment("B", "late");
  await context.purge_cached_attachments("B");
  await context.keep_cached_attachment("B", "late", body, miss.epoch);
  assert.equal((await context.cached_attachment("B", "late")).blob, undefined);
  await context.keep_cached_attachment("A", "huge", new Blob([body, "x"]), undefined);
  assert.equal((await context.cached_attachment("A", "huge")).blob, undefined);
});

test("thumbnail slots are independent, queued boxes yield to the viewport and can re-enter", async () => {
  const f = update_fixture(), started = [], finish = new Map();
  f.context.window.innerHeight = 900;
  f.context.URL = { createObjectURL: path => "blob:" + path };
  f.context.relay_room_bytes = path => {
    started.push(path);
    return new Promise(resolve => finish.set(path, () => resolve(path)));
  };
  const box = top => ({ closest: () => null, getBoundingClientRect: () => ({ top, bottom: top + 20 }) });
  const read = (id, owner) => f.context.relay_file_url("/" + id + "/thumbnail", { box: owner });
  const background = Array.from({ length: 6 }, (_, i) => read(i, box(0)));
  const leaves = box(1300), near = box(950), visible = box(50);
  const removed = read(6, leaves), queued = [read(7, near), read(8, visible)];
  const original = f.context.relay_file_url("/original");
  assert.equal(started.length, 7);
  f.context.release_relay_box(leaves, "/6/thumbnail");
  assert.equal(await removed, "");
  finish.get("/0/thumbnail")();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(started.at(-1), "/8/thumbnail");
  queued.push(read(6, leaves));
  for (const id of [1, 2, 3, 4, 5, 8]) finish.get("/" + id + "/thumbnail")();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started.slice(-2), ["/7/thumbnail", "/6/thumbnail"]);
  for (const path of ["/7/thumbnail", "/6/thumbnail", "/original"]) finish.get(path)();
  await Promise.all([...background, ...queued, original]);
});

test("urgent known-size reads start four offsets immediately and follow the actual runner part size", async () => {
  const step = 700 * 1024, size = 3 * step + 12;
  for (const actual of [step, step / 2]) {
    const f = update_fixture(), offsets = [], data = Buffer.alloc(size);
    for (let i = 0; i < size; i++) data[i] = i % 251;
    Object.assign(f.context, { atob, Blob });
    f.context.relay_file_part = async (_, offset) => {
      offsets.push(offset);
      await new Promise(resolve => setImmediate(resolve));
      return { status: 206, total: size, content_type: "image/png",
        body_base64: data.subarray(offset, offset + actual).toString("base64") };
    };
    const pending = f.context.relay_room_bytes("/image", { size, parallel: 3 });
    assert.deepEqual(offsets, [0, step, 2 * step, 3 * step]);
    assert.deepEqual(Buffer.from(await (await pending).arrayBuffer()), data);
    if (actual === step) assert.equal(offsets.length, 4);
  }
});

test("a relayed file is put together from parts asked several at a time", async () => {
  const f = update_fixture(), asked = [], data = "abcdefghij";
  Object.assign(f.context, { atob, Blob });
  f.context.relay_file_part = async (path, offset) => {
    asked.push(offset);
    await new Promise((resolve) => setImmediate(resolve));
    return { status: 200, total: data.length, content_type: "image/png", body_base64: Buffer.from(data.slice(offset, offset + 3)).toString("base64") };
  };
  const blob = await f.context.relay_room_bytes("/files/a", { parallel: 3 });
  assert.equal(Buffer.from(await blob.arrayBuffer()).toString(), data);
  assert.equal(blob.type, "image/png");
  assert.equal(asked.join(), "0,3,6,9");
  asked.length = 0;
  const range = await f.context.relay_room_range("/files/a", 2, 7);
  assert.equal(Buffer.from(range).toString(), "cdefg", "a PDF piece is read from where it starts to where it ends");
  assert.equal(asked.join(), "2,5");
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

// External members (子Task1 CONTRACT §1): the rail reads `free.members[].external`; requests the invited computer turned
// down carry `external_outcome`.
test("external members read the room view's external field, and only declined or timed-out requests show as not accepted", () => {
  const now = Date.parse("2026-11-16T10:00:00");
  const member = { id: 7, name: "Claude-ext", access: "external", status: "active",
    external: { scope: "read", expires_at: Math.floor(now / 1000) + 2 * 3600 + 60, machine_label: "A 的笔记本", directories: [{ root: 0, name: "app" }] } };
  assert.deepEqual(external_of(member), { level: "read", expires_at: (Math.floor(now / 1000) + 2 * 3600 + 60) * 1000, directories: ["app"], computer: "A 的笔记本", pending: false, ended: false });
  assert.equal(external_tag(member, now), "外部 · 只读文件 · 剩 2 小时", "short enough for the rail at 1440 wide");
  assert.equal(external_tag(member, now, { full: true }), "外部 · 消息和项目 · 剩余 2 小时", "the full wording for its hover text");
  assert.equal(external_tag({ ...member, adapter: "api", external: { ...member.external, platform: "DeepSeek", model: "deepseek-flash" } }, now, { full: true }),
    "外部 · DeepSeek · deepseek-flash · 消息和项目 · 剩余 2 小时", "hover names the vendor the other computer reports");
  assert.equal(external_tag({ ...member, status: "removed" }, now), "外部 · 已结束");
  assert.equal(external_of({ id: 1, name: "Codex", access: "runner" }), null, "an ordinary member is not external");
  assert.equal(remaining_label(now - 1, now), "已到期");
  assert.ok(declined({ status: "cancelled", cancel_reason: "no_reply", external_outcome: "declined" }));
  assert.ok(declined({ status: "cancelled", cancel_reason: "no_reply", external_outcome: "timeout" }));
  assert.ok(!declined({ status: "cancelled", cancel_reason: "no_reply" }), "an ordinary unanswered request is not the other side's refusal");
});

test("an external member's menu offers its read log and revoking, never credentials, launch or hosting", () => {
  const member = { id: 7, name: "Claude-ext", access: "external", status: "active", external: { scope: "read", expires_at: 0 } };
  const opened = [];
  const groups = member_actions(member, { view: { access: { can_manage: true }, launch: {} }, act: () => {}, describe: () => {}, external: () => opened.push("open"), revoke: () => opened.push("revoke") });
  const labels = groups.flat().map((item) => item.label);
  assert.deepEqual(labels, ["读取记录与权限", "名称与描述", "撤销授权"]);
  groups.flat().find((item) => item.label === "撤销授权").onSelect();
  groups.flat()[0].onSelect();
  assert.deepEqual(opened, ["revoke", "open"]);
});

// The online explanation page (子Task2 CONTRACT §2.1): the payload stays in the fragment, the page shows no path, and
// joining hands the whole link to this computer's own site in a fragment too.
test("the join page reads the invitation from the fragment and hands the whole link to the local site", () => {
  const html = readFileSync(new URL("../web/join.html", import.meta.url), "utf8");
  const script = html.split("<script>")[1].split("</script>")[0];
  const payload = { v: 1, site: "https://b.pages.dev", machine: "a".repeat(32), machine_name: "B-PC", fp: "b".repeat(32), code: "ABCD1234EFGH", room_name: "评审室", level: "read", expires_at: Date.now() + 600000 };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const nodes = [];
  const make = (tag) => {
    const node = { tag, attributes: {}, children: [], textContent: "", listeners: {},
      setAttribute(key, value) { this.attributes[key] = value; }, addEventListener(type, handler) { this.listeners[type] = handler; },
      append(...items) { this.children.push(...items); }, replaceChildren() { this.children = []; } };
    nodes.push(node);
    return node;
  };
  const root = make("main");
  const href = `https://b.pages.dev/join#${encoded}`;
  const context = vm.createContext({ location: { hash: `#${encoded}`, href }, navigator: { languages: ["zh-CN"], language: "zh-CN" },
    localStorage: { getItem: () => "" }, atob: (text) => Buffer.from(text, "base64").toString("binary"), TextDecoder,
    document: { documentElement: {}, title: "", getElementById: () => root, createElement: make }, window: { addEventListener() {} } });
  vm.runInContext(script, context);
  const texts = nodes.map((node) => node.textContent).join("\n");
  assert.match(texts, /B-PC/);
  assert.match(texts, /评审室/);
  assert.doesNotMatch(texts, /ABCD1234EFGH/, "the code itself is not shown on the page");
  const join = nodes.find((node) => node.tag === "a");
  assert.equal(join.attributes.href, `http://127.0.0.1:8765/#join=${encodeURIComponent(href)}`);
});

// A's middle page (子Task4 CONTRACT §1.1 records, `invited-room` messages): one card per run, the AI's answer under the
// request it answers, and an ended record keeps its history.
test("an invited room shows each run once, with this AI's answer under its request, and keeps the history after it ended", () => {
  const record = { member: "Claude-ext", status: "ended", end_reason: "revoked", approvals: [], running: null, history: [
    { at: 1000, request_ids: [1], message_ids: [1], outcome: "woken", execution_id: 5 },
    { at: 2000, execution_id: 5, outcome: "failed", reason: "进程退出码 1" },
    { at: 3000, request_ids: [3], message_ids: [3], outcome: "refused" },
    { at: 4000, outcome: "ended", reason: "revoked" },
  ] };
  const messages = [{ id: 1, author: "用户", text: "看看 README" }, { id: 2, author: "Claude-ext", text: "读完了", request_message_id: 1 },
    { id: 3, author: "用户", text: "再看看" }];
  const items = invited_items(record, messages);
  assert.deepEqual(items.map((item) => [item.key, item.outcome, item.answers.map((answer) => answer.id)]),
    [["end", "ended", []], ["h0", "refused", []], ["e5", "answered", [2]]]);
  assert.equal(items[0].reason, "已结束：被对方撤销");
  assert.equal(items[2].reason, "", "an answer that arrived settles the request whatever the exit code said");
  assert.deepEqual(items[2].requests.map((message) => message.id), [1]);
});

// V17: web/app.js rewrites the address to /?room=… when it opens the last room, before the workspace mounts; the
// invitation handed over as #join=… must still open the join dialog, once.
test("an invitation handed over in the fragment survives the page opening a room first, and is taken only once", () => {
  const link = "https://b.pages.dev/join#eyJ2IjoxfQ";
  const saved = { location: globalThis.location, history: globalThis.history };
  const rewrites = [];
  globalThis.location = { hash: "", pathname: "/", search: "?room=r1" };
  globalThis.history = { replaceState: (state, title, url) => rewrites.push(url) };
  globalThis.codiscuss_initial_hash = `#join=${encodeURIComponent(link)}`;
  try {
    assert.equal(take_join_fragment(), link, "read from the address as the page loaded");
    assert.equal(take_join_fragment(), "", "a second mount does not ask again");
    assert.deepEqual(rewrites, [], "an address already rewritten is left alone");
    globalThis.location = { hash: `#join=${encodeURIComponent(link)}&x=1`, pathname: "/", search: "" };
    assert.equal(take_join_fragment(), link, "without the early copy the live fragment still works");
    assert.deepEqual(rewrites, ["/#x=1"], "and the join part leaves the address");
  } finally { Object.assign(globalThis, saved); }
});

// V18: after leaving, the other room cannot be read; `invited-room` returns the texts this computer kept (子Task4
// `kept_messages`: `request_texts` and `answer` of history entries, at the top level with `kept: true`). An answered run
// shows them, never its process note, and says so when none were kept.
test("an answered run shows kept texts, never its process note, and says when the texts cannot be read", () => {
  const base = { member: "Claude-ext", status: "left", approvals: [], running: null };
  const lost = invited_items({ ...base, history: [{ at: 1, execution_id: 9, message_ids: [4], outcome: "woken" },
    { at: 2, execution_id: 9, outcome: "answered", reason: "进程退出码 1：C:\Users\a\run.log" }] }, []);
  const run = lost.find((item) => item.key === "e9");
  assert.equal(run.outcome, "answered");
  assert.equal(run.reason, "");
  assert.equal(run.missing_text, true);
  // Reopening a left record: the reply as `invited-room` gives it while the other room is unreachable.
  const reopened = { record: { ...base, history: [{ at: 1, execution_id: 9, message_ids: [4], outcome: "woken" },
    { at: 2, execution_id: 9, outcome: "answered", reason: "进程退出码 1",
      request_texts: [{ id: 4, author: "用户", text: "问题" }], answer: { id: 5, author: "Claude-ext", text: "回答" } }] },
    room: null, messages: [{ id: 4, author: "用户", text: "问题", kept: true }, { id: 5, author: "Claude-ext", text: "回答", execution_id: 9, kept: true }],
    error: "对方电脑不在线" };
  const kept = invited_items(reopened.record, reopened.messages);
  const item = kept.find((entry) => entry.key === "e9");
  assert.deepEqual([item.requests.map((message) => message.text), item.answers.map((message) => message.text), item.missing_text], [["问题"], ["回答"], false]);
});

test("a share page carries none of what only this computer and its owner should see", () => {
  const { context } = theme_fixture();
  const history = "/api/rooms/r1/messages?q=&withdrawn=include&limit=200&cards=1&after=0";
  const raw = {
    "/api/rooms": { rooms: [{ id: "r1", title: "Room", folder_id: "f1" }, { id: "r2", title: "OTHER-ROOM-MARK" }], folders: [{ id: "f1", name: "FOLDER-MARK" }] },
    "/api/rooms/r1": { id: "r1", title: "Room", background: "BACKGROUND-MARK", boundaries: "BOUNDARY-MARK", descriptions: { Codex: "DESCRIPTION-MARK" },
      members: [{ name: "Codex", status: "active", quota_until: 1234567, held_until: 7654321, reported_session: "SESSION-MARK", external: { machine_label: "MACHINE-MARK", directories: ["DIRECTORY-MARK"] } }],
      free: { queued_messages: { items: [{ text: "QUEUED-MARK" }] }, recommendations: [{ provider: "RECOMMEND-MARK" }], scheduler_decisions: [{ note: "DECISION-MARK" }],
        ended_externals: [{ machine_label: "ENDED-MARK" }],
        executions: [{ id: 1, status: "failed", failure_class: "quota", result: "QUOTA-MARK", cwd: "D:/Work/Secret-Project", session_id: "SESSION-MARK",
          lease_until: 1, changes: ["d:/work/secret-project/src/a.txt"], edited: ["d:/work/secret-project/src/a.txt"], denials: [{ detail: "DENIAL-MARK" }],
          retry: { reason: "RETRY-MARK" }, background: true }] } },
    [history]: { has_more: false, cards: { executions: [{ id: 7, request_message_id: 2, result: "CARD-ANSWER-MARK" }] }, messages: [
      { id: 1, text: "see D:\\Work\\Secret-Project\\src\\b.txt, /d/Work/Secret-Project/c.txt, /mnt/d/work/secret-project/e.txt and D:\\Work\\Secret-Project-wt\\d.txt; notes in C:\\Users\\HOME-MARK\\x.md, /c/Users/HOME-MARK/y.md and /home/HOME-MARK/z.md",
        attachments: [{ name: "ATTACHMENT-MARK", submission_id: "FILE-SUBMISSION-MARK" }], submission_id: "SUBMISSION-MARK" },
      { id: 2, text: "REWOUND-MARK", withdrawn: "rewound", attachments: [{ name: "WITHDRAWN-FILE-MARK" }] },
      { id: 3, text: "RETRACTED-MARK", withdrawn: "retracted" },
      { id: 6, source: "room_relay_sent", kind: "notice", text: "**sent**", relay_sent_title: "Child", relay_sent_message_id: 23 },
      { id: 4, text: "run failed: NOTICE-MARK", texts: { text: { template: "run failed: {reason}", params: { reason: "NOTICE-MARK" } } } },
      { id: 5, text: "quota used up, resets RESETS-MARK", texts: { text: { template: "quota used up, resets {resets}", params: { resets: "RESETS-MARK" } } } }] },
    // The runs that asked or answered a message taken back carry its text in the timeline and in their notes.
    "/api/rooms/r1/timeline": { now: 1, executions: [
      { id: 7, task_id: 2, task: "TIMELINE-TASK-MARK", answer_id: 8, result: "TIMELINE-ANSWER-MARK", last_note: { text: "TIMELINE-NOTE-MARK" } },
      { id: 9, task_id: 3, task: "RETRACTED-TASK-MARK" },
      { id: 10, task_id: 1, task: "kept task", answer_id: 11 }] },
    "/api/rooms/r1/executions/7/notes": { notes: [{ text: "NOTES-MARK" }] },
    "/api/rooms/r1/executions/10/notes": { notes: [{ text: "kept note" }] },
  };
  const responses = context.share_payload(raw, "r1");
  const outgoing = responses[history].messages.find(message => message.source === "room_relay_sent");
  assert.deepEqual([outgoing.text, outgoing.relay_sent_title, outgoing.relay_sent_message_id], ["**sent**", "Child", 23]);
  const text = JSON.stringify(responses);
  for (const mark of ["OTHER-ROOM-MARK", "FOLDER-MARK", "BACKGROUND-MARK", "BOUNDARY-MARK", "DESCRIPTION-MARK", "SESSION-MARK", "MACHINE-MARK", "DIRECTORY-MARK",
    "QUEUED-MARK", "RECOMMEND-MARK", "DECISION-MARK", "ENDED-MARK", "QUOTA-MARK", "DENIAL-MARK", "RETRY-MARK", "ATTACHMENT-MARK", "SUBMISSION-MARK",
    "REWOUND-MARK", "RETRACTED-MARK", "NOTICE-MARK", "RESETS-MARK", "CARD-ANSWER-MARK", "TIMELINE-TASK-MARK", "TIMELINE-ANSWER-MARK", "TIMELINE-NOTE-MARK",
    "RETRACTED-TASK-MARK", "NOTES-MARK", "lease_until", "1234567", "7654321"]) assert.ok(!text.includes(mark), mark);
  assert.ok(!/secret-project[\\/]/i.test(text), "the project folder never appears, in any spelling");
  const run = responses["/api/rooms/r1"].free.executions[0];
  assert.deepEqual([run.changes, run.edited, run.background, responses["/api/rooms/r1"].members[0].external], [["src/a.txt"], ["src/a.txt"], true, true]);
  // A sibling folder that only starts with the project's name is left as written.
  assert.deepEqual(responses[history].messages.map((message) => [message.id, message.text]), [
    [1, "see src\\b.txt, c.txt, e.txt and D:\\Work\\Secret-Project-wt\\d.txt; notes in ~\\x.md, ~/y.md and ~/z.md"], [6, "**sent**"], [4, "run failed: 执行失败"], [5, "quota used up, resets 未公开"]]);
  assert.deepEqual(responses["/api/rooms/r1/timeline"].executions.map((item) => item.id), [10]);
  assert.deepEqual(Object.keys(responses).filter((path) => path.endsWith("/notes")), ["/api/rooms/r1/executions/10/notes"]);
  // With attachments included, only the kept messages' files come along, still without their submission.
  const with_files = JSON.stringify(context.share_payload(raw, "r1", undefined, { attachments: true }));
  assert.ok(with_files.includes("ATTACHMENT-MARK"));
  for (const mark of ["WITHDRAWN-FILE-MARK", "FILE-SUBMISSION-MARK", "SUBMISSION-MARK"]) assert.ok(!with_files.includes(mark), mark);
});

test("share job actions update immediately, serialize per job, and survive older polls", async () => {
  const { context, notified } = theme_fixture();
  context.test_state.launch.available = true;
  const initial = { id: "j", room_id: "r", room_title: "Room", phase: "ready", adjustable: true, progress: { step: "preparing" }, updated_at: "1" };
  const calls = [];
  context.share_job_request = op => {
    const gate = Promise.withResolvers();
    calls.push({ op, ...gate });
    return gate.promise;
  };
  context.remember_share_job(initial, false);
  vm.runInContext('share_draft = {room_id:"r",managed_id:"j",phase:"ready"}; share_tasks.set("r",share_draft)', context);
  const draft = () => vm.runInContext("share_draft", context);
  const shown = () => context.shown_share_jobs()[0];
  const act = op => context.share_job_action({ op, job: shown() });
  const poll = context.share_job_refresh();
  const cancel = act("cancel");
  assert.equal(shown().phase, "cancelled");
  assert.equal(draft(), null);
  calls[0].resolve({ enabled: true, jobs: [initial] });
  await poll;
  assert.equal(shown().phase, "cancelled");
  calls[1].reject(new Error("cancel refused"));
  await cancel;
  assert.equal(shown().phase, "ready");
  assert.equal(draft().managed_id, "j");
  const failed = { ...initial, phase: "failed", error: "upload failed", progress: { step: "upload" }, updated_at: "2" };
  context.remember_share_job(failed, false);
  const retry = act("retry");
  assert.equal(shown().phase, "publishing");
  assert.equal(shown().error, "");
  calls[2].reject(new Error("retry refused"));
  await retry;
  assert.equal(shown().error, "upload failed");
  const again = act("retry"), stop = act("cancel");
  assert.equal(shown().phase, "cancelled");
  assert.equal(calls.at(-1).op, "retry");
  calls[3].resolve({ job: { ...failed, phase: "publishing", updated_at: "3" } });
  await again;
  assert.equal(calls[4].op, "cancel");
  calls[4].resolve({ job: { ...failed, phase: "cancelled", updated_at: "4" } });
  await stop;
  const refused = act("dismiss");
  assert.equal(shown(), undefined);
  calls[5].reject(new Error("dismiss refused"));
  await refused;
  assert.equal(shown().phase, "cancelled");
  const old = context.share_job_refresh(), dismiss = act("dismiss");
  calls[7].resolve({ id: "j" });
  await dismiss;
  calls[6].resolve({ enabled: true, jobs: [failed] });
  await old;
  assert.equal(shown(), undefined);
  assert.equal(notified.filter(([level, message]) => level === "error" && message.includes("refused")).length, 3);
});

test("opening a share job shows its title before reads finish and leaves a closed dialog closed", async () => {
  const { context, notified } = theme_fixture();
  const job = { id: "j", room_id: "r", room_title: "Room", phase: "ready", summary: { title: "Prepared room" },
    selection: { days: 3, include_files: false, left_files: [] } };
  const draft = () => vm.runInContext("share_draft", context);
  const reads = [];
  context.share_job_request = () => { const read = Promise.withResolvers(); reads.push(read); return read.promise; };
  const open = () => context.share_job_action({ op: "open", job });
  const opening = open();
  assert.equal(draft().title, "Room");
  assert.equal(draft().phase, "preparing");
  await new Promise(resolve => setImmediate(resolve));
  reads[0].resolve({ job });
  await opening;
  assert.equal(draft().phase, "ready");
  assert.equal(draft().title, "Prepared room");
  const closed = open();
  await new Promise(resolve => setImmediate(resolve));
  context.share_cancel();
  reads[1].resolve({ job });
  await closed;
  assert.equal(draft(), null);
  const lost = open();
  await new Promise(resolve => setImmediate(resolve));
  reads[2].reject(new Error("read refused"));
  await lost;
  assert.equal(draft(), null);
  assert.ok(notified.some(([level, message]) => level === "error" && message === "read refused"));
});

test("two delayed revocations hide both links during a directory refresh and roll back only the refused room", async () => {
  const { context, notified } = theme_fixture();
  const state = context.test_state;
  const rooms = ["a", "b"].map(id => ({ id, share_link: { url: "https://share.example/" + id, expires_at: "2099-01-01T00:00:00Z" } }));
  state.rooms = rooms;
  state.backup_pending = true;
  const gates = new Map();
  context.share_link_record = async id => ({ ...rooms.find(room => room.id === id).share_link, share_id: id, manage_token: "test" });
  context.share_site_request = (method, path) => {
    const gate = Promise.withResolvers();
    gates.set(path, gate);
    return gate.promise;
  };
  context.request_json = async (path, payload) => ({ link: payload.link });
  const first = context.share_revoke("a"), second = context.share_revoke("b");
  assert.deepEqual(Object.keys(context.share_links()), []);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(gates.size, 2);
  state.rooms = structuredClone(rooms);
  assert.equal(context.share_link("a"), null);
  gates.get("/api/shares/a").resolve({});
  gates.get("/api/shares/b").reject(new Error("offline"));
  await Promise.all([first, second]);
  state.rooms = structuredClone(rooms);
  assert.deepEqual(Object.keys(context.share_links()), ["b"]);
  assert.equal(context.share_link("b").url, rooms[1].share_link.url);
  assert.ok(notified.some(([level, text]) => level === "error" && text.includes("offline")));
  assert.equal(state.backup_pending, true);
});

test("renewal previews expiry, keeps the server expiry across a stale directory, and queues a revocation behind it", async () => {
  const { context } = theme_fixture();
  const state = context.test_state;
  const old = { url: "https://share.example/a", expires_at: "2099-01-01T00:00:00Z" };
  const room = { id: "a", share_link: old };
  state.rooms = [room];
  context.share_link_record = async () => ({ ...old, share_id: "a", manage_token: "test" });
  context.request_json = async (path, payload) => ({ link: payload.link });
  const calls = [];
  context.share_site_request = method => {
    const gate = Promise.withResolvers();
    calls.push({ method, ...gate });
    return gate.promise;
  };
  const writing = context.share_renew({ room_id: "a", days: 3 });
  assert.ok(Math.abs(Date.parse(context.share_link("a").expires_at) - Date.now() - 3 * 86400000) < 2000);
  await new Promise(resolve => setImmediate(resolve));
  const expires_at = "2098-12-31T00:00:00Z";
  calls[0].resolve({ expires_at });
  await writing;
  state.rooms = [room];
  assert.equal(context.share_link("a").expires_at, expires_at);
  const renewal = context.share_renew({ room_id: "a", days: 1 });
  const revoke = context.share_revoke("a");
  assert.equal(context.share_link("a"), null);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.map(item => item.method), ["POST", "POST"]);
  calls[1].reject(new Error("renewal refused"));
  await renewal;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(context.share_link("a"), null);
  assert.equal(calls[2].method, "DELETE");
  calls[2].resolve({});
  await revoke;
});

test("a share link is kept with the room, published once, updated, renewed and revoked with its own manage token only", async () => {
  const { context, storage, notified } = theme_fixture();
  const calls = [];
  let status = 200, kept = null;
  Object.assign(context, { Blob, navigator: { clipboard: { writeText: async () => {} } },
    fetch: async (url, options = {}) => {
      // The room keeps the link on the computer, so the owner's other devices can manage it too.
      if (url === "/api/rooms/r1/share-link") {
        if (options.method === "POST") kept = JSON.parse(options.body).link;
        return { ok: true, status: 200, json: async () => ({ link: kept }) };
      }
      calls.push({ url, method: options.method, auth: options.headers.Authorization || "", body: options.body ? JSON.parse(options.body) : null });
      const answer = url.endsWith("/renew") ? { expires_at: "2099-01-03T00:00:00Z" } : options.method === "POST" ? { id: "abc", url: "https://share.example/s/abc", manage_token: "TOKEN", expires_at: "2099-01-01T00:00:00Z" }
        : { expires_at: "2099-01-02T00:00:00Z" };
      const code = options.method === "PUT" ? status : 200;
      return { ok: code < 400, status: code, json: async () => code < 400 ? answer : { error: "gone" } };
    } });
  const draft = () => vm.runInContext(`share_draft = { room_id: "r1", title: "Room", description: "d", exported_at: "2026-11-21T00:00:00Z", responses: { "/api/rooms/r1": { id: "r1" } }, spots: [] };`, context);
  // A link an earlier version kept in this browser moves to the room the first time it is needed.
  storage.set("codiscuss-share:r1", JSON.stringify({ id: "old", url: "https://share.example/s/old", manage_token: "OLD", expires_at: "2099-01-01T00:00:00Z" }));
  draft();
  await context.share_publish(3);
  assert.deepEqual([calls[0].method, calls[0].url.endsWith("/api/shares/old"), calls[0].auth, calls[0].body.ttl_days, calls[0].body.format], ["PUT", true, "Bearer OLD", 3, 1]);
  assert.equal(storage.has("codiscuss-share:r1"), false, "the browser no longer holds it");
  assert.equal(kept.manage_token, "OLD");
  kept = null;
  draft();
  await context.share_publish(99);
  assert.deepEqual([calls[1].method, calls[1].url.endsWith("/api/shares"), calls[1].auth, calls[1].body.ttl_days], ["POST", true, "", 7], "an unknown lifetime falls back to the default");
  assert.deepEqual([kept.share_id, kept.manage_token], ["abc", "TOKEN"]);
  // A link the site no longer has is published anew instead of failing.
  status = 410;
  draft();
  await context.share_publish(7);
  assert.deepEqual(calls.slice(-2).map((call) => call.method), ["PUT", "POST"]);
  status = 200;
  await context.share_renew({ room_id: "r1", days: 1 });
  assert.deepEqual([calls.at(-1).url.endsWith("/api/shares/abc/renew"), calls.at(-1).auth, calls.at(-1).body.ttl_days, kept.expires_at], [true, "Bearer TOKEN", 1, "2099-01-03T00:00:00Z"]);
  await context.share_revoke("r1");
  assert.deepEqual([calls.at(-1).method, calls.at(-1).auth, kept], ["DELETE", "Bearer TOKEN", null]);
  assert.ok(!notified.some(([level]) => level === "error"), JSON.stringify(notified));
});

test("a background share survives closing its progress and keeps concurrent notes bound to its room", async () => {
  const { context } = theme_fixture(), notices = [], releases = [];
  let peak = 0, active = 0;
  context.test_state.rooms = [{ id: 'one', title: 'First room' }];
  context.request_json = async (path, payload, token, trace, recording) => {
    if (path.includes('/notes')) {
      peak = Math.max(peak, ++active);
      await new Promise(resolve => setImmediate(resolve));
      active--;
    }
    const body = path === '/api/rooms' ? { rooms: context.test_state.rooms } : path.endsWith('/timeline')
      ? { executions: Array.from({ length: 10 }, (_, id) => ({ id, last_note: 'note' })) }
      : path.includes('/messages?') ? { messages: [], has_more: false } : { id: 'one', title: 'First room', members: [] };
    recording.set(path, body);
    return body;
  };
  const recorded = await context.record_share_reads('one');
  assert.equal(peak, 6);
  assert.equal(Object.keys(recorded.responses).filter(key => key.endsWith('/notes')).length, 10);
  context.record_share_reads = () => new Promise(resolve => releases.push(resolve));
  context.notify = (level, message, options) => notices.push(options);
  context.structuredClone = structuredClone;
  const work = context.share_prepare('one');
  assert.equal(vm.runInContext('share_draft', context), null);
  assert.ok(!context.test_state.backup_pending);
  await context.share_prepare('one');
  assert.equal(vm.runInContext('share_draft.phase', context), 'preparing');
  context.share_cancel();
  releases[0](recorded);
  await work;
  assert.equal(vm.runInContext('share_draft', context), null);
  notices.at(-1).actions[0].onClick();
  assert.equal(vm.runInContext('share_draft.phase', context), 'ready');
});

test("share preparation batches delivered file locations and sorts attachments by their source messages", async () => {
  const { context } = theme_fixture(), calls = [];
  const messages = [1, 2].map(id => ({ id, author_label: 'Editor', created_at: '2026-11-23', execution_id: 1,
    text: '`report.pdf`', attachments: [{ room_id: 'one', id: 'file' + id, file_name: 'photo.png', size: 9 - id }] }));
  const responses = { '/api/rooms/one': { free: { executions: [{ id: 1, created_at: 1 }] } }, '/api/rooms/one/messages?after=0': { messages } };
  context.manage_room_files = async (room, request) => {
    calls.push(request); return { items: [null, { kind: 'file', modified_at: '2026-11-23', size: 120 }] };
  };
  const delivered = await context.share_delivered_files(responses, 'one', ['main','extra']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].items.length, 2);
  assert.equal(delivered.size, 2);
  const photos = context.share_file_kinds({ files: context.share_files(responses, 'one') }).find(kind => kind.kind === 'image');
  assert.deepEqual(Array.from(photos.files, item => [item.message_id, item.author, item.created_at]), [[2,'Editor','2026-11-23'],[1,'Editor','2026-11-23']]);
});

test("text scans and older runners use up to six reads and retain each file's association", async () => {
  const { context } = theme_fixture();
  const names = Array.from({ length: 9 }, (_, index) => "report-" + index + ".md");
  const files = names.map((file_name, id) => ({ message_id: id + 1, file_name, content_type: "text/markdown", size: 4 }));
  let peak = 0, active = 0;
  const read = async () => {
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setImmediate(resolve));
    active--;
  };
  context.TextDecoder = TextDecoder;
  context.share_file_bytes = async file => {
    await read();
    if (file.message_id === 5) throw new Error("missing");
    return new TextEncoder().encode("text");
  };
  const spots = await context.share_file_spots(files);
  assert.equal(peak, 6);
  assert.equal(spots.length, 1);
  assert.ok(spots[0].where.includes("report-4.md"));
  peak = 0;
  let batches = 0;
  context.manage_room_files = async () => { batches++; throw new Error("unknown operation"); };
  context.read_room_files = async () => { await read(); return { kind: "file", modified_at: "2026-11-23", size: 4 }; };
  const messages = names.map((file_name, id) => ({ id: id + 1, text: "`" + file_name + "`", execution_id: 1 }));
  const responses = { "/api/rooms/one": { free: { executions: [{ id: 1, created_at: 1 }] } }, "/api/rooms/one/messages?after=0": { messages } };
  const delivered = await context.share_delivered_files(responses, "one", ["main"]);
  assert.equal(batches, 1);
  assert.equal(peak, 6);
  assert.equal(delivered.size, names.length);
});

test("sharing without a connected computer uses six browser uploads and reports a failed publication for retry", async () => {
  const { context } = theme_fixture(), notices = [];
  const files = Array.from({ length: 8 }, (_, index) => ({ route: "/api/rooms/r/attachments/" + index + "/content", site_type: "text/plain", size: 1 }));
  let peak = 0, active = 0;
  context.share_carried_files = () => files;
  context.share_file_bytes = async () => new Uint8Array(1);
  context.fetch = async () => {
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    return { ok: true };
  };
  const draft = { room_id: "r" };
  await context.share_upload_files(draft, { share_id: "share", manage_token: "token" }, "revision");
  assert.equal(peak, 6);
  assert.equal(draft.upload.done, files.length);
  context.Blob = Blob;
  context.share_contents = async () => ({});
  context.share_link_record = async () => null;
  context.share_site_request = async () => { throw new Error("offline"); };
  context.notify = (level, message, options) => notices.push({ level, message, options });
  vm.runInContext('share_draft = { room_id: "r", phase: "ready" }; share_tasks.set("r", share_draft);', context);
  await context.share_publish(7);
  assert.equal(vm.runInContext('share_draft', context), null);
  assert.equal(notices.at(-1).level, "error");
  assert.match(notices.at(-1).message, /offline/);
  notices.at(-1).options.actions[0].onClick();
  assert.equal(vm.runInContext('share_draft.phase', context), "ready");
});

test("a share card cover encoded by a PNG-only canvas fits a signed paired-device relay write", async () => {
  const canvas = { getContext: () => ({ drawImage() {} }), toDataURL() {
    return "data:image/png;base64," + "A".repeat(this.width * 1024);
  } };
  const previous = globalThis.document;
  let cover;
  try {
    globalThis.document = { createElement: () => canvas };
    cover = encode_cover({ width: 450, height: 700 });
  } finally {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
  const { context } = theme_fixture();
  const machine = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const device = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  Object.assign(context, { TextEncoder, btoa, device_identity: () => ({ id: "device", private_key: device.privateKey }) });
  const payload = { method: "POST", path: "/api/rooms/example/share-card", body: { share_id: "live", edits: { cover } } };
  const id = crypto.randomUUID();
  const { envelope } = await context.seal_relay_request({ id: "machine", public_key: await crypto.subtle.exportKey("jwk", machine.publicKey) },
    id, { action: "room-api", target: "computer", payload });
  assert.match(cover, /^data:image\/png;base64,/);
  assert.ok(Buffer.byteLength(JSON.stringify({ id, envelope })) <= 512 * 1024);
});

test("share card text previews immediately and closing saves the latest edit once", async () => {
  const { context } = theme_fixture();
  vm.runInContext('share_draft = { room_id: "r", phase: "published", link: { share_id: "s", card: { question: "" } } }', context);
  const saved = [], writes = [];
  context.request_json = async (_path, payload) => { saved.push(payload.edits.question); };
  for (const value of ["a", "ab", "abc"]) {
    writes.push(context.edit_share_card({ room_id: "r", share_id: "s", field: "question", value }));
    await new Promise(setImmediate);
    assert.equal(vm.runInContext("share_draft.link.card.question", context), value);
  }
  assert.deepEqual(saved, []);
  context.share_cancel();
  await Promise.all(writes);
  assert.deepEqual(saved, ["abc"]);
});

test("the share card skips question receipts when choosing the owner's question", () => {
  const { context } = theme_fixture();
  const texts = ["回答问题 #9：A", "请主持人先讨论并给推荐（问题 #10）\n\n说明", "交给主持人决定（问题 #11）",
    "Answer to question #12", "Leaving it to the host to decide (question #13)", "要解决的问题是什么？"];
  const draft = { room_id: "r", responses: { "/api/rooms/r/messages?after=0": {
    messages: texts.map((text, id) => ({ id, author: "用户", text })) } } };
  assert.equal(context.share_card(draft, { expires_at: "2030-01-01" }).question, texts.at(-1));
  const multi = { room_id: "r", responses: { "/api/rooms/r/messages?after=0": {
    messages: [{ id: 1, author: "用户", text: "我们要为品牌做一款点单 App。\n\n- 清单 A\n- 清单 B" }] } } };
  assert.equal(context.share_card(multi, { expires_at: "2030-01-01" }).question, "我们要为品牌做一款点单 App。");
  assert.equal(context.share_card(multi, { expires_at: "2030-01-01" }).card_version, 2);
});

test("default share copy includes deployed sites and live share link, and companion copy resolves placeholders", () => {
  const url = "https://share.codiscuss.com/s/FEyQ_JE1_Pn5emRPvotRnA";
  const base = build_default_share_copy({
    title: "拾光咖啡",
    question: "打造一款街区咖啡点单 App。",
    outcome: "品牌视觉与官网已上线。",
    stats: "3 位 AI · 41 条消息 · 36 次执行",
    url,
    sites: [{ title: "拾光咖啡官网", url: "https://demo.bimcanvas.com" }],
  });
  assert.match(base, /【拾光咖啡】/);
  assert.match(base, /拾光咖啡官网：https:\/\/demo\.bimcanvas\.com/);
  assert.match(base, /完整协作记录：https:\/\/share\.codiscuss\.com\/s\/FEyQ_JE1_Pn5emRPvotRnA/);
  assert.equal(
    resolve_share_copy("标题\n\n完整协作记录：{{share_url}}", url),
    `标题\n\n完整协作记录：${url}`,
  );
  assert.match(resolve_share_copy("没有链接的文案", url), new RegExp(url));
});

test("share card diagnostics distinguish eligible materials, preview source and incomplete uploads", () => {
  const { context } = theme_fixture();
  const draft = { room_id: "r", phase: "published", responses: {
    "/api/rooms/r/messages?after=0": { messages: [{ id: 1, author: "用户", text: "private question" },
      { id: 5, author: "AI", text: "private answer" }, { id: 7, kind: "system", text: "private event" }] },
  } };
  const card = context.share_card(draft, { url: "https://secret.test", expires_at: "2029-01-01" });
  draft.link = { card, manage_token: "secret-token" };
  const preview = { stage: "drawn", rendered: "default", width: 1000, height: 850, extra: "private render data" };
  const initial = share_card_diagnostic(draft, preview);
  assert.equal(initial.materials.count, 2);
  assert.equal(initial.materials.through, 5);
  assert.equal(initial.preview.selected, "default");
  assert.equal(initial.preview.width, 1000);
  assert.equal(initial.attachments, undefined);
  card.cover = "private image";
  card.publication = { revision: "r".repeat(22), done: 1, total: 3 };
  draft.phase = "publishing";
  draft.upload = { done: 1, total: 3 };
  const uploading = share_card_diagnostic(draft, { stage: "decoding-cover" });
  assert.deepEqual(uploading.preview, { selected: "custom", stage: "decoding-cover" });
  assert.deepEqual(uploading.attachments, { total: 3, done: 1, state: "uploading" });
  draft.phase = "published";
  const failed = share_card_diagnostic(draft, { stage: "drawn", rendered: "custom", width: 1000, height: 900 });
  assert.deepEqual(failed.attachments, { total: 3, done: 1, state: "incomplete" });
  assert.equal(failed.publication.revision, "r".repeat(22));
  assert.doesNotMatch(JSON.stringify([initial, uploading, failed]), /private|secret/);
});

test("publishing checks the exact snapshot and attachment limits before closing the dialog or sending anything", async () => {
  const { context, notified } = theme_fixture();
  context.Blob = Blob;
  let files = [], description = "";
  context.share_carried_files = () => files;
  context.share_contents = async () => ({ description });
  context.share_link_record = () => assert.fail("preflight must finish before network access");
  vm.runInContext('share_draft = { room_id: "one", phase: "ready" };', context);
  const mb = 1024 * 1024;
  for (const [sizes, text, limit] of [[[101 * mb], "", "100 MB"], [Array(4).fill(76 * mb), "", "300 MB"], [[], "x".repeat(5 * mb), "5 MB"]]) {
    files = sizes.map(size => ({ size, site_name: "example.pdf" }));
    description = text;
    await context.share_publish(7);
    assert.equal(vm.runInContext("share_draft.phase", context), "ready");
    assert.equal(notified.at(-1)[0], "error");
    assert.ok(notified.at(-1)[1].includes(limit));
  }
});

test("share attachment filters open above the cap, sort without changing selections, and use each file's viewer", () => {
  const opened = [], watches = [];
  const view = { value: { share_draft: { room_id: "one", files: { included: true, bytes: 300 * 1024 * 1024 } } } };
  const context = vm.createContext({
    inject: () => ({ view, act: (...args) => opened.push(args) }), ref: value => ({ value }),
    computed: getter => ({ get value() { return getter(); } }), watch: (source, run) => watches.push([source, run]),
    SHARE_DAYS, SHARE_DEFAULT_DAYS, SHARE_SITE_FILES_MAX_BYTES,
    file_preview: { open: (...args) => opened.push(args) },
  });
  const component = readFileSync(new URL("../frontend/ShareDialog.vue", import.meta.url), "utf8");
  vm.runInContext(component.match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import .*;$/gm, ""), context);
  const [included, update] = watches.find(([source]) => typeof source === "function" && source() === true);
  update(included());
  assert.equal(vm.runInContext("filters_open.value", context), false);
  view.value.share_draft.files.bytes++;
  update(included());
  assert.equal(vm.runInContext("filters_open.value", context), true);
  const files = [{ message_id: 2, size: 5, selected: true }, { message_id: 1, size: 12, selected: false, project: { path: "report.md", root: 1 } }];
  context.files = files;
  vm.runInContext("files.forEach(preview)", context);
  assert.equal(opened[0][0], "preview_attachment");
  assert.equal(opened[0][1].from_share, true);
  assert.deepEqual(opened[1], ["report.md", "", 1, files[1]]);
});

test("a visual panel's result is accepted only from its own frame and within the limit", () => {
  const own = {}, result = (data, source = own) => visual_result({ source, data: { codiscuss_visual_result: data } }, own);
  assert.equal(result({ format: 1, text: "选 A" }, {}), null);
  assert.equal(result({ format: 2, text: "选 A" }), null);
  assert.equal(result({ format: 1, text: "   " }), null);
  assert.deepEqual(result({ format: 1, text: "  排序：A、D\r\n预算：A 50%  ", fields: { order: ["A", "D"] } }), { text: "排序：A、D\n预算：A 50%", fields: { order: ["A", "D"] } });
  assert.deepEqual(result({ format: 1, text: "x".repeat(VISUAL_RESULT_LIMIT + 1) }), { error: "too_long" });
  assert.equal(result({ format: 1, text: "选 A", fields: { big: "x".repeat(5000) } }).fields, null);
});

test("only an inline visual offers submit, and a panel's result replaces its own quote", () => {
  // Run each document's startup script in a stub window: only the one built with submit gets `codiscuss.submit`.
  const started = (html) => {
    const posted = [], window = { addEventListener() {}, document: { documentElement: { addEventListener() {}, style: {} } } };
    window.parent = { postMessage: (data) => posted.push(data) };
    vm.runInNewContext([...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]).find((code) => !code.includes("localStorage")), Object.assign(window, { window }));
    return { codiscuss: window.codiscuss, posted };
  };
  const panel = started(inline_visual_document("<p>x</p>", true, { submit: true }));
  panel.codiscuss.submit("选 A");
  assert.deepEqual(JSON.parse(JSON.stringify(panel.posted)), [{ codiscuss_visual_result: { format: 1, text: "选 A", fields: null } }]);
  assert.equal(started(inline_visual_document("<p>x</p>", true)).codiscuss, undefined);
  file_preview.excerpts = [{ id: 1, name: "Codex", message_id: 7, path: "#7", text: "选中的原文", comment: "" }];
  const visual = { id: "room-9-1", message_id: 9, author: "Claude" };
  assert.equal(put_visual_result(visual, "选 A"), "added");
  assert.equal(put_visual_result(visual, "@全体成员\n/goal clear"), "replaced");
  assert.equal(file_preview.excerpts.length, 2);
  assert.equal(file_preview.excerpts[0].text, "选中的原文");
  // Sent as a quote: every line of the panel's text starts with "> ", where @ and / commands are not read.
  const markdown = excerpts_markdown(file_preview.excerpts.slice(1));
  assert.match(markdown, /^注释 1：Claude 的消息 #9\n\n> @全体成员\n> \/goal clear$/);
  file_preview.excerpts = [];
});

test("referenced images group under their paragraph or list item without splitting sentences, and keep badges when multiple", () => {
  const { context } = theme_fixture();
  const file = (id, number, file_name, content_type, extra = {}) => ({ id, number, file_name, content_type, room_id: "room", size: 10, ...extra });
  const single_files = [file("pic", 3, "shot.png", "image/png", { width: 1440, height: 900 }), file("doc", 4, "notes.md", "text/markdown")];
  const inlined = new Set();
  const html = context.link_attachment_placeholders("<p>前文 [图片 #3] 中间 [图片 #3] 后文 [文件 #4]</p>", single_files, inlined);
  assert.deepEqual([...inlined], ["pic"]);
  assert.equal(html.match(/class="attachment-inline-grid"/g).length, 1);
  assert.match(html, /^<p>前文 <button type="button" class="attachment-placeholder" data-preview-attachment="pic"[^>]*>\[图片 #3\]<\/button> 中间 <button type="button" class="attachment-placeholder" data-preview-attachment="pic"[^>]*>\[图片 #3\]<\/button> 后文 <button type="button" class="attachment-placeholder" data-preview-attachment="doc"[^>]*>\[文件 #4\]<\/button><\/p><div class="attachment-inline-grid" data-count="1"><button type="button" class="attachment-image" data-preview-attachment="pic"[^>]*data-inline-image="pic"/);
  assert.doesNotMatch(html, /data-image-badge=/, "a single-image message omits the corner badge");
  // Multi-image list items keep sentence punctuation intact, place pairs side by side with badges, and flush before nested lists.
  const multi_files = [file("p11", 11, "a.png", "image/png"), file("p12", 12, "b.png", "image/png"), file("p7", 7, "c.png", "image/png")];
  const multi_inlined = new Set();
  const list_html = context.link_attachment_placeholders(
    "<ol><li>新建面板 [图片 #11]，邀请弹窗 [图片 #12]。<ul><li>子项 [图片 #7]</li></ul></li></ol><p>[图片 #11]</p>",
    multi_files, multi_inlined);
  assert.deepEqual([...multi_inlined], ["p11", "p12", "p7"]);
  assert.match(list_html, /新建面板 <span class="attachment-reference-end"><button[^>]*>\[图片 #11\]<\/button>，<\/span>邀请弹窗 <span class="attachment-reference-end"><button[^>]*>\[图片 #12\]<\/button>。<\/span><div class="attachment-inline-grid" data-count="2">.*data-inline-image="p11" data-image-badge="#11".*data-inline-image="p12" data-image-badge="#12".*<\/div><ul><li>子项 <button[^>]*>\[图片 #7\]<\/button><div class="attachment-inline-grid" data-count="1">.*data-inline-image="p7" data-image-badge="#7".*<\/div><\/li><\/ul>/s);
  // A paragraph containing only newly inlined image placeholders becomes the grid itself, with no redundant label line.
  const bare_inlined = new Set();
  const bare_html = context.link_attachment_placeholders("<p>[图片 #11] [图片 #12]</p>", multi_files, bare_inlined);
  assert.match(bare_html, /^<div class="attachment-inline-grid" data-count="2">/);
  assert.doesNotMatch(bare_html, /<p>|attachment-placeholder/);
  // Without a collector the references stay links, as in places that keep their own attachment list.
  assert.doesNotMatch(context.link_attachment_placeholders("<p>[图片 #3]</p>", single_files), /attachment-inline-grid/);
});

test("working card shows private-chat entry when progress is reported and hides it when degraded to progress=false", () => {
  const context = vm.createContext({});
  for (const name of ["capabilities", "shows_progress"]) {
    const start = discussion_source.indexOf(`const ${name} =`);
    const end = discussion_source.indexOf("\n", start);
    vm.runInContext(discussion_source.slice(start, end), context);
  }
  const shows_progress = vm.runInContext("shows_progress", context);
  const readable = { execution_id: 6186, capabilities: { stoppable: false, progress: true } };
  const degraded = { execution_id: 6186, capabilities: { stoppable: false, progress: false } };
  const unreported = { execution_id: 6186, capabilities: null };
  assert.equal(shows_progress(readable), true, "Codex App delivery with progress=true exposes the working-card private chat button");
  assert.equal(shows_progress(unreported), true, "until capabilities arrive, the page assumes progress is visible");
  assert.equal(shows_progress(degraded), false, "when the session could not be read before delivery, progress=false hides the private chat button");
  assert.equal(discussion_source.match(/can_manage && shows_progress\(message\) && message\.execution_id/g)?.length, 2,
    "both touch corner and hover toolbar private-chat buttons on the working card follow shows_progress(message)");
});

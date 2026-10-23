import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { computed, nextTick, reactive, ref, watch } from "vue";
import { API_PROVIDERS } from "../runner/discussion_api.mjs";

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
  assert.deepEqual([...fixture.state.members.value], ["Codex", "Claude"]);
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
  fixture.key("ArrowUp");
  assert.equal(fixture.state.active.value, "Claude-评审");
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

test('response suggestions track live conversion membership ownership and pending state', () => {
  const room = ref({ mode: 'free', free: { members: [{ id: 2, name: 'Codex', status: 'active' }], requests: [] } });
  const view = ref({ access: { can_manage: false }, messages: [{ id: 7, suggestions: [{ member_id: 2, member: 'Codex', request_id: null }] }] });
  const pending = ref('');
  const context = vm.createContext({ computed, room, view, pending, free: ref(true) });
  const start = discussion_source.indexOf('const response_suggestions = computed(');
  const end = discussion_source.indexOf('/** A draft @mentions a member', start);
  vm.runInContext(discussion_source.slice(start, end) + '\nglobalThis.suggestions = response_suggestions;', context);
  const suggestion = () => context.suggestions.value.get(7)[0];
  assert.equal(Boolean(suggestion().can_convert), false);
  view.value.access.can_manage = true;
  assert.equal(suggestion().can_convert, true);
  pending.value = 'convert_suggestion';
  assert.equal(suggestion().can_convert, false);
  pending.value = '';
  room.value.archived = true;
  assert.equal(suggestion().can_convert, false);
  room.value.archived = false;
  room.value.free.members[0].status = 'away';
  assert.equal(suggestion().status, 'away');
  assert.equal(suggestion().can_convert, false);
  room.value.free.members[0].status = 'active';
  room.value.free.requests.push({ id: 9, message_id: 7, member_id: 2, status: 'completed' });
  assert.equal(suggestion().request_id, 9);
  assert.equal(suggestion().can_convert, false);
  assert.match(discussion_source, /act\('convert_suggestion', \{ message_id: message.id, member_id: suggestion.member_id \}\)/);
  assert.match(discussion_source, /已转请求 #/);
});

test('conversion controller preserves source and target across retries and ignores another room', async () => {
  const calls = [], state = { room: { id: 'source-room' }, messages: [{ id: 7, suggestions: [{ member_id: 2, request_id: null }] }] };
  let refreshes = 0;
  const context = vm.createContext({ state, request_json: async (...args) => { calls.push(args); return { request: { id: 9 } }; }, refresh_room: async () => refreshes++ });
  vm.runInContext(source.match(/async function convert_suggestion\([\s\S]*?\n\}/)[0], context);
  await context.convert_suggestion({ message_id: 7, member_id: 2 });
  await context.convert_suggestion({ message_id: 7, member_id: 2 });
  assert.equal(JSON.stringify(calls[0]), JSON.stringify(calls[1]));
  assert.equal(calls[0][0], '/api/rooms/source-room/suggestions');
  assert.equal(refreshes, 2);
  assert.equal(state.messages[0].suggestions[0].request_id, 9);
  context.request_json = async () => { state.room = { id: 'another-room' }; };
  await context.convert_suggestion({ message_id: 7, member_id: 2 });
  assert.equal(refreshes, 2);
});

test('message cache retains confirmed suggestions after recent requests age out without rerendering prose', () => {
  const message = { id: 7, text: '已保存正文', suggestions: [{ member_id: 2, request_id: null }], rendered_text: 'cached-markdown' };
  const state = { messages: [message], room: { free: { requests: [{ id: 9, message_id: 7, member_id: 2 }] } } };
  const container = { querySelectorAll: () => [], scrollTop: 0, scrollHeight: 100, clientHeight: 100 };
  const context = vm.createContext({ state, element: () => container, SCROLL_BOTTOM_THRESHOLD: 70, message_markup: () => '',
    window: { discuss_markdown: { render_markdown: () => { throw new Error('Unchanged prose must stay cached'); } } } });
  vm.runInContext(source.match(/function render_messages\(result\) \{[\s\S]*?\n\}/)[0], context);
  context.render_messages({ messages: [message], total: 1, pages: 1 });
  assert.equal(state.messages[0].suggestions[0].request_id, 9);
  assert.equal(state.messages[0].rendered_text, 'cached-markdown');
  const saved = state.messages[0];
  state.room.free.requests = [];
  context.render_messages({ messages: [message], total: 1, pages: 1 });
  assert.equal(state.messages[0], saved);
  assert.equal(state.messages[0].suggestions[0].request_id, 9);
});

test('execution reports bind answers and failed requests and distinguish unknown file changes', () => {
  const room = ref({ free: { executions: [
    { id: 1, status: 'completed', answer_id: 8, request_message_id: 4, request_ids: [1, 2], created_at: 10, finished_at: 22, changes_recorded: true, changes: ['index.html'] },
    { id: 2, status: 'failed', answer_id: null, request_message_id: 9, request_ids: [3], created_at: 10, finished_at: 30, changes_recorded: false, changes: [] },
    { id: 3, status: 'completed', answer_id: 11, request_message_id: 10, request_ids: [4], created_at: 10, finished_at: 30, changes_recorded: true, changes: [] },
    { id: 4, status: 'started', request_message_id: 12 },
  ] } });
  const context = vm.createContext({ computed, room, free: ref(true) });
  const start = discussion_source.indexOf('const execution_reports = computed(');
  const end = discussion_source.indexOf('/** Show only a live automatic execution', start);
  vm.runInContext(discussion_source.slice(start, end) + '\nglobalThis.reports = execution_reports;', context);
  const reports = context.reports.value;
  assert.equal(reports.get(8)[0].files_text, 'index.html');
  assert.equal(reports.get(8)[0].seconds, 12);
  assert.match(reports.get(9)[0].files_text, /未提供自动改动检测/);
  assert.equal(reports.get(11)[0].files_text, '未观察到文件变化');
  assert.equal(reports.has(12), false);
  assert.match(discussion_source, /v-for="report in execution_reports.get\(message.id\)/);
  assert.match(discussion_source, /report.request_ids.map/);
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
    new_submission_id: () => String(++identifier), escape_html: text => text,
    URL: { createObjectURL: () => "blob:test", revokeObjectURL: url => revoked.push(url) },
    localStorage: { getItem: () => null }, publish_view() {}, show_toast() {}, cancel_reply() {}, cancel_turn_reply() {},
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
  const reduced = ref(false), calls = [], cleanups = [], listeners = new Set(), document = { activeElement: null };
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
    restore_launch_profile: (name, profile) => { view.value.launch.profiles[name] = profile; } };
  const context = vm.createContext({ computed, ref, nextTick, defineProps: () => props, defineEmits: () => () => {},
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

test('expert card offers project permissions only for CLI and shows that API and web experts never see project files', () => {
  const f = expert_card_fixture();
  const project = () => vm.runInContext('facts.value.find(fact => fact.label === "项目").value', f.context);
  f.view.value.launch.workspace = { project_access: 'write' };
  assert.equal(vm.runInContext('sets_access.value', f.context), true);
  f.view.value.launch.profiles.Codex = { adapter: 'api', project_access: 'write' };
  assert.equal(vm.runInContext('sets_access.value', f.context), false);
  assert.equal(project(), '不访问');
  f.view.value.launch.profiles.Codex.adapter = 'codex';
  assert.equal(vm.runInContext('sets_access.value', f.context), false);
  assert.equal(project(), '由软件设置', 'an App keeps its own file permissions');
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

test("expert card reduced motion keeps manual and online faces accessible without exposing launch overrides", async () => {
  const fixture = expert_card_fixture();
  fixture.reduced.value = true;
  fixture.context.flip(true);
  await nextTick();
  assert.deepEqual(fixture.calls.at(-1), ["jump", 180]);
  assert.equal(fixture.refs.visible_back.value, true);
  fixture.props.mode = "manual";
  await nextTick();
  assert.equal(fixture.refs.back.value, true);
  assert.equal(fixture.refs.visible_back.value, true);
  assert.equal(vm.runInContext("configurable.value", fixture.context), false);
  assert.match(vm.runInContext("configuration_note.value", fixture.context), /已有 App 或 CLI/);
  fixture.props.mode = "online";
  assert.match(vm.runInContext("configuration_note.value", fixture.context), /原网页/);
  assert.equal(vm.runInContext("entry_label.value", fixture.context), "网页聊天");
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
  assert.equal(fact("项目"), "由软件设置", "manual sessions keep the permissions of their own software");
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
    experts: { "new-expert-modes": {} }, launch: { profiles: {}, available: false, create: false } });
  const events = [], cleanups = [];
  const bridge = { identities: { 用户: {}, Codex: {}, Claude: {}, DeepSeek: {} },
    launch_clients: { Codex: [{ value: "codex_cli" }, { value: "api" }], Claude: [{ value: "claude" }, { value: "api" }], DeepSeek: [{ value: "api" }] },
    platform_of: name => name.split("-")[0], display_name: name => name,
    write_launch: (name, field, value) => { (view.value.launch.profiles[name] ||= {})[field] = value; },
    write_field: (id, value) => { events.push([id, value]); view.value.fields[id] = value; },
    write_expert: (id, name, mode) => { if (mode) view.value.experts[id][name] = mode; else delete view.value.experts[id][name]; },
    add_instance: (id, name, mode) => {
      let number = 2;
      while (view.value.experts[id][`${name}-${number}`]) number++;
      view.value.experts[id][`${name}-${number}`] = mode;
    } };
  const context = vm.createContext({ computed, ref, nextTick, defineProps: () => ({}), defineEmits: () => () => {},
    inject: () => ({ view, bridge, pending: ref(""), act: () => {} }), onMounted: callback => callback(), onBeforeUnmount: () => {},
    window: { setInterval: () => 0, clearInterval: () => {} }, document: { hidden: false },
    watch: (...args) => { const stop = watch(...args); cleanups.push(stop); return stop; } });
  const component = readFileSync(new URL("../frontend/CreateDiscussion.vue", import.meta.url), "utf8");
  vm.runInContext(component.match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import .*;$/gm, ""), context);
  return { context, view, events, cleanup: () => cleanups.forEach(stop => stop()) };
}

test("create form shares a role library, keeps independent instances and makes the first AI host a free room", async () => {
  const f = create_form_fixture(), { context, view } = f;
  context.add_expert("Codex");
  context.add_expert("Codex");
  context.add_expert("DeepSeek");
  const modes = view.value.experts["new-expert-modes"];
  assert.deepEqual(Object.entries(modes), [["Codex", "cli"], ["Codex-2", "cli"], ["DeepSeek", "cli"]], "every member starts woken by the local service");
  assert.equal(view.value.launch.profiles.DeepSeek.adapter, "api", "an API-only platform is woken through its API");
  assert.equal(view.value.fields["new-room-host"], "Codex", "the user is the client of a free room, never its host");
  assert.deepEqual(Array.from(vm.runInContext('access_choices("Codex")', context)), ["cli", "manual", "online"]);
  assert.deepEqual(Array.from(vm.runInContext('access_choices("DeepSeek")', context)), ["cli", "online"], "an API-only platform has no software to join by hand");
  context.set_expert_mode("Codex", "manual");
  context.set_expert_mode("Codex-2", "manual");
  context.set_expert_mode("DeepSeek", "online");
  assert.equal(vm.runInContext("free_ready.value", context), true, "free rooms without woken members need no launcher");
  view.value.fields["new-room-host"] = "Codex-2";
  context.remove_expert("Codex");
  assert.equal(view.value.fields["new-room-host"], "Codex-2", "a manual member can host");
  context.set_expert_mode("Codex-2", "online");
  assert.equal(view.value.fields["new-room-host"], "", "an online instance cannot host, and the user never does");
  context.choose_kind("brainstorm");
  assert.equal(view.value.fields["new-room-host"], "");
  assert.equal(vm.runInContext('access_choices("Codex-2")', context).length, 0, "discussions offer no delivery choice");
  context.set_expert_mode("Codex-2", "cli");
  assert.equal(view.value.fields["new-room-host"], "Codex-2");
  await nextTick();
  f.cleanup();
});

test("free member delivery never offers writable credentials to online or unavailable identities", async () => {
  const view = ref({ access: { can_manage: true, members: [{ name: "Codex", access: "manual", available: false }] }, launch: { available: false } });
  const calls = [];
  const context = vm.createContext({ view, busy: () => false, act: (...args) => calls.push(args) });
  const component = readFileSync(new URL("../frontend/FreeBoard.vue", import.meta.url), "utf8");
  vm.runInContext(component.match(/function member_menu\(member\) \{[\s\S]*?\n\}/)[0], context);
  const manual = { name: "Codex", access: "manual", status: "away" };
  let menu = context.member_menu(manual).flat();
  assert.equal(menu.find(item => item.label === "下载私有配置").disabled, true);
  assert.equal(menu.find(item => item.label === "请回").disabled, false, "manual rejoin needs no launcher");
  view.value.access.members[0].available = true;
  menu = context.member_menu(manual).flat();
  await menu.find(item => item.label === "下载私有配置").onSelect();
  assert.deepEqual(calls, [["download_member_access", "Codex"]]);
  const online = context.member_menu({ ...manual, access: "online" }).flat();
  assert.equal(online.some(item => item.label === "下载私有配置"), false);
  view.value.access.can_manage = false;
  assert.equal(context.member_menu(manual)[0][0].disabled, true);
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
  const context = vm.createContext({ window: {}, document, crypto: globalThis.crypto, URL, URLSearchParams, AbortSignal, localStorage: {
    getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value),
    removeItem: key => storage.delete(key), key: index => [...storage.keys()][index], get length() { return storage.size; },
  } });
  vm.runInContext(`${source}\nglobalThis.test_state = state;`, context);
  context.publish_view = () => {};
  return { context, nodes, classes, storage, loaded, buttons, root: document.documentElement };
}

test('empty execution limits submit as unlimited and remain clear in the progress label', () => {
  const { context, nodes } = theme_fixture();
  for (const [key, value] of Object.entries({ max_rounds: '3', max_minutes: '0', execution_minutes: '', on_limit: 'pause', summary_minutes: '5' })) {
    nodes.set(`new-room-limit-${key}`, { value });
  }
  const limits = context.read_limits('new-room');
  assert.equal(limits.execution_minutes, 0);
  assert.match(context.limits_label(limits), /单次自动执行 不限时长/);
  nodes.get('new-room-limit-execution_minutes').value = '10';
  assert.equal(context.read_limits('new-room').execution_minutes, 10);
  assert.match(context.limits_label(context.read_limits('new-room')), /单次自动执行 10 分钟/);
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

test("retrying a lost mode response preserves the owner credential and reconciles runtime", async () => {
  const fixture = theme_fixture();
  const key = 'discuss-access:room-a';
  fixture.storage.set(key, 'existing-owner');
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
  fixture.storage.set('discuss-access:room-a', 'credential-a');
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

test("web restart delegates duration to the topic without adding a hidden time limit", async () => {
  const fixture = theme_fixture();
  const posts = [];
  let deadline = 0;
  fixture.context.test_state.room = { id: 'unlimited', limits: { max_minutes: 0 } };
  Object.assign(fixture.context, {
    request_json: async (path, payload) => payload ? posts.push(payload) : { revision: 4, deadline },
    refresh_room: async () => {}, show_toast() {},
  });
  await fixture.context.restart_discussion();
  assert.equal(posts[0].deadline, 0);
  deadline = Math.floor(Date.now() / 1000) - 60;
  await fixture.context.restart_discussion();
  assert.equal(posts[1].deadline, 0, 'an old run deadline must not override the current unlimited choice');
  deadline = 0;
  fixture.context.test_state.room.limits.max_minutes = 60;
  await fixture.context.restart_discussion();
  assert.equal(posts[2].deadline, 0, 'the backend applies the configured topic deadline, including summary time');
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
  assert.deepEqual(Array.from(record.input.room.members, member => member.access), ['manual', 'manual', 'online']);
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
  state.creation_mode = 'free';
  state.create_parent = 'free-room';
  f.context.reset_create_form();
  assert.equal(resets, 1);
  assert.deepEqual(Object.keys(experts), []);
  assert.equal(state.creation_mode, 'brainstorm');
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

/** Exercise the participant menu's pause boundary with the shared controller actions. */
function participant_connection_fixture(status = "running") {
  const view = ref({ room: { id: "one", phase: "discussing", runtime: { mode: "automatic", status } },
    launch: { available: true, remote: false, repair: null, repair_error: "" } });
  const pending = ref(""), calls = [];
  const controls = { pause_allowed: true, changed_room: false };
  const act = async (name) => {
    calls.push(name);
    if (name === "pause_runtime") {
      if (!controls.pause_allowed) return false;
      view.value.room.runtime.status = "paused";
    }
    if (name === "load_room_configuration") {
      view.value.launch.repair = { room_id: "one", participants: { Codex: { adapter: "codex_cli" } } };
      if (controls.changed_room) view.value.room.id = "two";
    }
    return true;
  };
  const context = vm.createContext({ computed, ref, watch, defineProps: () => ({}),
    inject: () => ({ view, bridge: { launch_clients: {} }, pending, act }) });
  const component = readFileSync(new URL("../frontend/ProgressBoard.vue", import.meta.url), "utf8");
  vm.runInContext(component.match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import .*;$/gm, "")
    + "\nglobalThis.connection_refs = { connection_open, connection_profile };", context);
  return { context, view, calls, controls, refs: context.connection_refs };
}

test("discussion experts can leave, return or be removed from the board, but the host stays", async () => {
  const { context, view, calls } = participant_connection_fixture();
  Object.assign(view.value.room, { host: "Claude", experts: { Claude: "cli", Codex: "cli" },
    members: [{ id: 1, name: "Claude", status: "active" }, { id: 2, name: "Codex", status: "active" }, { id: 3, name: "Gemini", status: "away" }] });
  assert.equal(context.member_menu({ name: "Claude", is_host: true }).length, 0, "the host cannot leave");
  const labels = menu => Array.from(menu.flat(), item => item.label);
  assert.deepEqual(labels(context.member_menu({ name: "Codex" })), ["暂离", "移除"]);
  const away = context.member_menu({ name: "Gemini" });
  assert.deepEqual(labels(away), ["请回", "移除"]);
  await away[0][0].onSelect();
  assert.deepEqual(calls, ["change_member"]);
  view.value.room.rounds = [{ number: 1, speakers: ["Codex"], completed: false }];
  assert.ok(!labels(context.member_menu({ name: "Codex" })).includes("作废本轮发言"), "voiding needs a pause");
  view.value.room.phase = "paused";
  assert.ok(labels(context.member_menu({ name: "Codex" })).includes("作废本轮发言"));
  assert.ok(!labels(context.member_menu({ name: "Gemini" })).includes("作废本轮发言"), "only experts counted in the round");
  view.value.room.phase = "concluded";
  assert.equal(context.member_menu({ name: "Codex" }).length, 0, "a concluded discussion keeps its roster");
});

test("participant menu opens an inline switch and waits for explicit pause before reading configuration", async () => {
  const { context, view, calls, refs } = participant_connection_fixture();
  const menu = context.member_menu({ name: "Codex", session: "original" })[0];
  assert.deepEqual(Array.from(menu, item => item.label), ["复制会话 ID", "切换 App / CLI"]);
  await menu[1].onSelect();
  assert.equal(refs.connection_open.value, true);
  assert.deepEqual(calls, [], "opening a menu must not pause a live discussion");
  await context.read_connection();
  assert.deepEqual(calls, ["pause_runtime", "load_room_configuration"]);
  assert.equal(refs.connection_profile.value.adapter, "codex_cli");
  assert.equal(context.member_menu({ name: "Claude", session: "other" })[0].length, 1);
  view.value.launch.remote = true;
  assert.equal(context.member_menu({ name: "Codex", session: "original" })[0].length, 1);
});

test("every Codex instance can switch, a borrowed one before its first execution, and an App writer conflict offers the App directly", async () => {
  const { context, view, calls, refs } = participant_connection_fixture();
  vm.runInContext("bridge", context).write_room_adapter = (name, adapter) => { view.value.launch.repair.participants[name].adapter = adapter; };
  view.value.room.members = [{ id: 4, name: "Codex-2", status: "active", session_mode: "borrowed" }];
  const labels = menu => Array.from(menu.flat(), item => item.label);
  assert.ok(labels(context.member_menu({ name: "Codex-2" })).includes("切换 App / CLI"), "the borrowed ID is already known");
  view.value.room.members[0].session_mode = "new";
  assert.ok(!labels(context.member_menu({ name: "Codex-2" })).includes("切换 App / CLI"), "a new session has nothing to switch yet");
  await context.open_connection({ name: "Codex" }, "codex");
  await context.read_connection();
  assert.deepEqual(calls, ["pause_runtime", "load_room_configuration"]);
  assert.equal(refs.connection_profile.value.adapter, "codex", "the conflict path preselects the App without saving");
});

test("participant switch stops on pause failure and discards a configuration after navigating rooms", async () => {
  const { context, view, calls, controls, refs } = participant_connection_fixture();
  await context.open_connection({ name: "Codex" });
  controls.pause_allowed = false;
  await context.read_connection();
  assert.deepEqual(calls, ["pause_runtime"]);
  assert.equal(refs.connection_profile.value, null);
  view.value.room.runtime.status = "paused";
  controls.changed_room = true;
  await context.read_connection();
  assert.equal(refs.connection_open.value, false);
  assert.equal(refs.connection_profile.value, null);
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
  assert.deepEqual(Object.keys(requests[0].input), ['room_id']);
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
});

test("participant model labels distinguish explicit choices, software defaults and unavailable room data", () => {
  const label = theme_fixture().context.participant_model;
  const room = { id: 'one', runtime: { mode: 'automatic' } };
  const saved = { room_id: 'one', participants: {
    Codex: { adapter: 'codex_cli', model: 'gpt-6-astra', effort: 'xhigh' },
    Claude: { adapter: 'claude', model: '', effort: '' },
    Gemini: { adapter: 'antigravity_cli', model: 'gemini-4-argon-high', effort: '' },
  } };
  assert.equal(label('Codex', room, saved), 'gpt-6-astra · xhigh');
  assert.equal(label('Claude', room, saved), '默认模型 · 默认强度');
  assert.equal(label('Gemini', room, saved), 'gemini-4-argon-high · 强度随模型');
  assert.equal(label('Codex', { ...room, id: 'two' }, saved), '模型与强度未获取');
  assert.equal(label('Codex', room, null), '模型与强度未获取');
  saved.participants.Codex.adapter = 'codex';
  assert.equal(label('Codex', room, saved), '模型与强度由 App 设置');
  assert.equal(label('Codex', { ...room, runtime: { mode: 'manual' } }, saved), '模型与强度在原聊天设置');
});

test("empty automatic discussions describe their actual state instead of requiring another message", () => {
  const message = theme_fixture().context.empty_discussion_message;
  for (const [status, pattern] of [['ready', /尚未启动/], ['running', /等待 AI 执行/], ['paused', /已暂停/], ['stopped', /已停止/]]) {
    assert.match(message({ phase: 'preparing', runtime: { mode: 'automatic', status } }), pattern);
  }
  assert.match(message({ phase: 'concluded' }), /已结束/);
});

/** Run the actual glow lifecycle with a controlled animation frame clock. */
function reply_glow_fixture() {
  const reduced_motion = ref(false), frames = new Map(), styles = new Map(), classes = new Set();
  let now = 0, next_frame = 0, stop;
  const context = vm.createContext({ ref, reduced_motion, performance: { now: () => now },
    requestAnimationFrame: (callback) => { frames.set(++next_frame, callback); return next_frame; },
    cancelAnimationFrame: (frame) => frames.delete(frame),
    watch: (...args) => { stop = watch(...args); return stop; } });
  const start = discussion_source.indexOf("const reply_glow =");
  const end = discussion_source.indexOf("const speaking_turn =", start);
  vm.runInContext(`${discussion_source.slice(start, end)}\nglobalThis.element = reply_glow;`, context);
  const element = { classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name) },
    style: { setProperty: (name, value) => styles.set(name, value), removeProperty: (name) => styles.delete(name) } };
  return { reduced_motion, frames, styles, classes, element, target: context.element, stop: () => stop(),
    advance(seconds) {
      now += seconds * 1000;
      for (const [id, callback] of [...frames]) { frames.delete(id); callback(now); }
    } };
}

test("reply glow moves without duplicate loops and stops on reduced motion or card removal", async (t) => {
  const glow = reply_glow_fixture();
  t.after(glow.stop);
  assert.equal(glow.frames.size, 0);
  glow.target.value = glow.element;
  await nextTick();
  assert.equal(glow.frames.size, 1);
  glow.advance(0.1);
  const first = parseFloat(glow.styles.get("--reply-glow-position"));
  glow.advance(0.1);
  assert.ok(parseFloat(glow.styles.get("--reply-glow-position")) < first, "the highlight travels left to right");
  assert.equal(glow.frames.size, 1);
  glow.reduced_motion.value = true;
  await nextTick();
  assert.equal(glow.frames.size, 0);
  assert.equal(glow.styles.size, 0);
  assert.equal(glow.classes.size, 0, "ordinary text is restored");
  glow.reduced_motion.value = false;
  await nextTick();
  assert.equal(glow.frames.size, 1);
  glow.advance(3600);
  const resumed = parseFloat(glow.styles.get("--reply-glow-position"));
  assert.ok(resumed >= 0 && resumed <= 100, "a suspended tab resumes within the text sweep");
  glow.target.value = null;
  await nextTick();
  assert.equal(glow.frames.size, 0);
  assert.equal(glow.styles.size, 0);
});

/** Evaluate the actual pending-card state with reactive room snapshots. */
function pending_message_fixture() {
  const execution = { id: 9, participant: "Codex", role: "expert", turn_id: 7, status: "dispatched", stale: false };
  const view = reactive({ value: { query: "", mention_only: false, room: {
    host: "Claude", phase: "discussing", current_turn: { id: 7, expert: "Codex", status: "notified" },
    rounds: [{ number: 2, completed: false }], completed_rounds: 1,
    runtime: { mode: "automatic", status: "running", expired: false, participants: [execution] },
  } } });
  const context = vm.createContext({ computed, view, room: computed(() => view.value.room) });
  const start = discussion_source.indexOf("const speaking_turn =");
  const end = discussion_source.indexOf("/** A user's message", start);
  vm.runInContext(`${discussion_source.slice(start, end)}\nglobalThis.card = pending_message;`, context);
  return { view: view.value, room: view.value.room, execution: view.value.room.runtime.participants[0], card: context.card };
}

test("pending reply cards follow real expert and host execution without counting queued assignments as typing", () => {
  const { room, execution, card } = pending_message_fixture();
  assert.equal(card.value.author, "Codex");
  assert.equal(card.value.text, "正在唤醒…");
  assert.equal(card.value.round, "第 2 轮");
  execution.status = "started";
  assert.equal(card.value.text, "正在准备回复…");
  for (const status of ["pending", "completed", "failed", "cancelled"]) {
    execution.status = status;
    assert.equal(card.value, null, status);
  }
  execution.status = "started";
  execution.turn_id = 6;
  assert.equal(card.value, null, "an old assignment cannot appear to be replying");
  execution.turn_id = 7;
  room.current_turn.status = "answered";
  assert.equal(card.value, null);
  room.current_turn = null;
  execution.role = "host";
  execution.participant = "Claude";
  execution.turn_id = null;
  assert.equal(card.value.author, "Claude");
  assert.equal(card.value.is_host, true);
  assert.equal(card.value.text, "正在安排下一步…");
  execution.status = "dispatched";
  assert.equal(card.value.text, "正在唤醒主持人…");
  execution.status = "started";
  room.rounds = [];
  room.phase = "preparing";
  assert.equal(card.value.round, "", "a host can start before the first round exists");
  assert.equal(card.value.text, "正在安排下一步…");
  execution.status = "completed";
  assert.equal(card.value, null, "completing an arrangement removes the host work card");
  execution.role = "expert";
  execution.status = "pending";
  execution.turn_id = 8;
  room.current_turn = { id: 8, expert: "Claude", status: "pending" };
  assert.equal(card.value, null, "an arrangement alone does not show the next expert as working");
  execution.status = "started";
  assert.equal(card.value.is_host, false, "the host acting as an expert uses a reply card");
  assert.equal(card.value.text, "正在准备回复…");
});

test("pending reply cards disappear when execution is invalid or the transcript is filtered", () => {
  const { view, room, execution, card } = pending_message_fixture();
  for (const [object, key, next] of [[execution, "stale", true], [room, "archived", true],
    [room, "phase", "paused"], [room, "phase", "concluded"],
    [room.runtime, "mode", "manual"], [room.runtime, "status", "paused"],
    [room.runtime, "status", "stopped"], [room.runtime, "expired", true],
    [view, "query", "历史"], [view, "mention_only", true]]) {
    const previous = object[key];
    object[key] = next;
    assert.equal(card.value, null, `${key}=${next}`);
    object[key] = previous;
    assert.ok(card.value);
  }
  view.room = { phase: "preparing" };
  assert.equal(card.value, null, "switching to an unstarted room clears the previous card");
});

test("pending reply elapsed time includes wake and work, ticks locally, resyncs and stops with the execution", async () => {
  const { room, execution, card } = pending_message_fixture();
  const timers = new Map();
  let now = 0, next_timer = 0, stop;
  const context = vm.createContext({ computed, ref, pending_message: card, performance: { now: () => now },
    setInterval: (callback) => { timers.set(++next_timer, callback); return next_timer; },
    clearInterval: (timer) => timers.delete(timer),
    watch: (...args) => { stop = watch(...args); return stop; } });
  const start = discussion_source.indexOf("const ELAPSED_TICK_MS");
  const end = discussion_source.indexOf("const identities =", start);
  vm.runInContext(`${discussion_source.slice(start, end)}\nglobalThis.duration = pending_duration;`, context);
  assert.equal(context.duration.value, "—");
  assert.equal(timers.size, 0, "legacy executions without timings do not invent a duration");
  room.runtime.timings = { items: [{ id: 9, queue_seconds: 200, wake_seconds: 59, work_seconds: null }] };
  await nextTick();
  assert.equal(context.duration.value, "59秒");
  now = 1000;
  timers.forEach((callback) => callback());
  assert.equal(context.duration.value, "1分00秒");
  room.runtime = { ...room.runtime };
  await nextTick();
  assert.equal(context.duration.value, "1分00秒", "unrelated snapshots cannot rewind the elapsed clock");
  assert.equal(next_timer, 1);
  execution.status = "started";
  room.runtime.timings.items[0].work_seconds = 24;
  await nextTick();
  assert.equal(context.duration.value, "1分23秒", "entering does not reset the wake duration");
  assert.equal(timers.size, 1, "server refreshes replace the previous clock");
  room.runtime.timings.items[0].work_seconds = 3542;
  await nextTick();
  assert.equal(context.duration.value, "1小时0分01秒");
  execution.status = "completed";
  await nextTick();
  assert.equal(context.duration.value, "—");
  assert.equal(timers.size, 0);
  stop();
});

test("message duration formatting distinguishes zero from missing data and handles hours", () => {
  const start = discussion_source.indexOf("function format_elapsed");
  const end = discussion_source.indexOf("const pending_duration", start);
  const context = vm.createContext({});
  vm.runInContext(discussion_source.slice(start, end), context);
  for (const [seconds, label] of [[null, "—"], [undefined, "—"], [0, "0秒"], [59, "59秒"],
    [60, "1分00秒"], [3599, "59分59秒"], [3661, "1小时1分01秒"]]) {
    assert.equal(context.format_elapsed(seconds), label);
  }
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

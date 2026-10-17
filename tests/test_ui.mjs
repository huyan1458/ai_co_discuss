import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../web/app.js", import.meta.url), "utf8").replace(/\nrestore_theme\(\);[\s\S]*$/, "");
const discussion_source = readFileSync(new URL("../web/modern/ChannelDiscussion.vue", import.meta.url), "utf8");

/** Exercise theme persistence and renderer selection without touching discussion data. */
function theme_fixture(saved_theme = null) {
  const nodes = new Map([['legacy-style', {}], ['modern-style', {}], ['settings-dialog', { close() {} }]]);
  const classes = new Set();
  const storage = new Map([['ai-codiscuss-theme', saved_theme]]);
  const loaded = [];
  const buttons = ['channel', 'channel-light', 'millennium'].map((theme) => ({
    dataset: { themeOption: theme }, setAttribute(key, value) { this[key] = value; },
  }));
  const document = {
    documentElement: { dataset: {}, classList: { toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); } } },
    getElementById: (id) => nodes.get(id), querySelectorAll: () => buttons,
    createElement: () => ({}), head: { append(node) { nodes.set(node.id, node); loaded.push(node); } },
  };
  const context = vm.createContext({ window: {}, document, localStorage: {
    getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value),
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
  for (const id of ['title', 'goal', 'host', 'background', 'boundaries', 'mode']) fixture.nodes.set(`new-room-${id}`, { value: id === 'mode' ? 'manual' : '内容' });
  fixture.nodes.set('room-dialog', { close() {} });
  fixture.nodes.set('room-form', { reset() {} });
  fixture.root.dataset.theme = 'channel';
  let sequence = 0;
  Object.assign(fixture.context, {
    crypto: { randomUUID: () => `token-${++sequence}` }, new_submission_id: () => `submission-${++sequence}`,
    read_expert_inputs: () => ({}), read_limits: () => ({}), default_experts: () => ({}), render_expert_inputs() {},
    select_room: async () => {}, select_tab() {}, show_toast() {},
    request_json: async (path, payload) => { requests.push(payload); throw new Error('retry'); },
  });
  const submit = folder => fixture.context.submit_room({ preventDefault() {} }, folder);
  await assert.rejects(submit('one'), /retry/);
  await assert.rejects(submit('one'), /retry/);
  await assert.rejects(submit('two'), /retry/);
  assert.equal(requests[0].folder_id, 'one');
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
  await fixture.context.move_folder({ id: "two", direction: 1 });
  await fixture.context.refresh_room();
  assert.equal(fixture.requests.length, 1);
  fixture.requests[0].reject(new Error("排序失败"));
  await assert.rejects(saving, /排序失败/);
  assert.equal(fixture.state.folders, original);
  assert.equal(fixture.state.folder_order_pending, false);
  const retry = fixture.context.move_folder({ id: "one", before_id: null });
  const ordered = [original[1], original[2], original[0]];
  fixture.requests[1].resolve({ folders: ordered });
  await retry;
  assert.equal(fixture.state.folders, ordered);
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
  await fixture.move({ id: "c", direction: 1, folder_id: "one" });
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

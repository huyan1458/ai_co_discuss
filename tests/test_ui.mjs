import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../web/app.js", import.meta.url), "utf8").replace(/\nrestore_theme\(\);[\s\S]*$/, "");
const discussion_source = readFileSync(new URL("../web/modern/ChannelDiscussion.vue", import.meta.url), "utf8");

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
  const one = drag_node({ "data-room-folder": "one" }, list);
  const two = drag_node({ "data-room-folder": "two" }, list);
  const none = drag_node({ "data-room-folder": "" }, list);
  const headings = [one, two, none].map((folder) => drag_node({ "data-drop-folder": "" }, folder));
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
  context.run_action = (action) => action();
  context.manage_channel = async (payload) => writes.push(JSON.parse(JSON.stringify(payload)));
  const event = (extra = {}) => ({ target: title, currentTarget: title, pointerId: 1, button: 0, pointerType: "mouse", clientX: 20, clientY: 20, preventDefault() {}, stopPropagation() {}, ...extra });
  return { context, writes, list, row, title, grip, neighbor, headings, body, event,
    start: (extra) => context.start_directory_drag(event(extra)),
    move(target, extra = {}) { hit = target; context.update_directory_drag(event({ clientY: 70, ...extra })); },
    finish: (extra) => context.finish_directory_drag(event({ type: "pointerup", clientY: 70, ...extra })),
  };
}

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

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { unzipSync } from "fflate";

import { create_room_archive, create_rooms_archive, read_room_archives, room_markdown } from "../frontend/backup.mjs";

test("backups include original binary attachments and safe relative Markdown links", async () => {
  const snapshot = backup_fixture(), bytes = new Uint8Array([0, 255, 10, 13]);
  snapshot.tables.attachments = [{ id: "a".repeat(32), room_id: "one", message_id: 1,
    file_name: "资料(#1).bin", size: bytes.length, sha256: "hash" }];
  const archive = unzipSync(await create_room_archive(snapshot, async file => {
    assert.equal(file.id, "a".repeat(32));
    return bytes;
  }));
  const path = `附件/${"a".repeat(32)}_资料(#1).bin`;
  assert.deepEqual(archive[path], bytes);
  assert.match(new TextDecoder().decode(archive["讨论记录.md"]), /%28%231%29/);
  await assert.rejects(create_room_archive(snapshot, async () => { throw new Error("原文件缺失"); }), /原文件缺失/);
});

test("single and batch archives read back every room with its original files for import", async () => {
  const first = backup_fixture(), second = backup_fixture(), bytes = new Uint8Array([1, 2, 3]);
  second.tables.rooms[0] = { ...second.tables.rooms[0], id: "two", title: "第二个" };
  first.tables.attachments = [{ id: "b".repeat(32), room_id: "one", message_id: 1, file_name: "图.png", size: 3, sha256: "hash" }];
  const as_file = (data, name) => ({ name, arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) });
  const batch = await create_rooms_archive([first, second], async () => bytes);
  const rooms = await read_room_archives(as_file(batch, "批量.zip"));
  assert.deepEqual(rooms.map(room => room.snapshot.tables.rooms[0].id).sort(), ["one", "two"]);
  assert.deepEqual(rooms.find(room => room.snapshot.tables.rooms[0].id === "one").files.get("b".repeat(32)), bytes);
  assert.ok(new TextDecoder().decode(unzipSync(batch)["备份说明.txt"]).includes("批量备份"));
  const single = await read_room_archives(as_file(await create_room_archive(first, async () => bytes), "单个.zip"));
  assert.deepEqual([single.length, single[0].files.get("b".repeat(32))], [1, bytes]);
  await assert.rejects(read_room_archives(as_file(new TextEncoder().encode("not zip"), "坏.zip")), /不是有效的 ZIP/);
});

/** Build a multi-page Unicode record that crosses the async compressor threshold. */
function backup_fixture() {
  const timestamp = "2026-10-16T10:00:00Z";
  return { format: "ai-codiscuss-room-backup", version: 1, exported_at: timestamp, source_url: "https://example.test/r/one",
    tables: {
      rooms: [{ id: "one", title: "备份 / 中文", goal: "目标", state_text: "分歧", state_until: 46, created_at: timestamp }],
      room_directory: [{ room_id: "one", archived: 1 }], room_floor: [{ room_id: "one", holder: null, next_speaker: "用户", revision: 9 }],
      topic_settings: [], topic_folders: [], room_folder_assignments: [], room_creations: [], room_briefs: [],
      messages: Array.from({ length: 46 }, (_, index) => ({ id: index + 1, room_id: "one", author: "Gemini",
        text: `# 原文 ${index}\n${"完整中文🙂".repeat(500)}\n\`\`\`\n<script>不会执行</script>\n`,
        source: "host_proxy", reply_to: index ? 1 : null, submission_id: `message-${index}`, created_at: timestamp })),
      message_details: [{ message_id: 46, kind: "opinion", submitted_by: "Codex", turn_id: 7 }],
      message_summaries: [{ message_id: 46, text: "保留摘要", author: "Gemini" }],
      discussion_turns: [{ id: 7, room_id: "one", expert: "Gemini", question: "条件？", status: "answered", answer_id: 46, created_at: timestamp, notified_at: "" }],
    } };
}

test("readable backups separate stored and explicitly marked legacy user requests", () => {
  const snapshot = backup_fixture();
  const settings = { host: '用户', experts: '{}', phase: 'preparing', background: '补充背景' };
  snapshot.tables.topic_settings = [settings];
  snapshot.tables.room_user_requests = [{ room_id: 'one', text: '原始要求\n第二行' }];
  assert.match(room_markdown(snapshot), /## 用户原文\n\n```text\n原始要求\n第二行\n```\n\n## 背景\n\n```text\n补充背景/);
  delete snapshot.tables.room_user_requests;
  settings.background = '用户原文：\n原始要求\n第二行\n\n项目背景与入口：\n补充背景';
  assert.match(room_markdown(snapshot), /## 用户原文\n\n```text\n原始要求\n第二行\n```\n\n## 背景\n\n```text\n项目背景与入口：\n补充背景/);
});

test("standard ZIP reader recovers complete Unicode JSON, transcript and references", async () => {
  const snapshot = backup_fixture();
  const archive = await create_room_archive(snapshot);
  const decoded = JSON.parse(execFileSync("python", ["-c", [
    "import io,json,sys,zipfile", "archive=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()))",
    "assert archive.testzip() is None", "print(json.dumps({name:archive.read(name).decode('utf-8') for name in archive.namelist()}))",
  ].join("\n")], { input: archive, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" }));
  assert.deepEqual(Object.keys(decoded).sort(), ["完整数据.json", "讨论记录.md", "备份说明.txt"].sort());
  assert.deepEqual(JSON.parse(decoded["完整数据.json"]), snapshot);
  const markdown = decoded["讨论记录.md"];
  for (const message of snapshot.tables.messages) assert.ok(markdown.includes(message.text));
  for (const reference of ["代发/提交者：Codex", "简述（作者：Gemini）", "#message-1", "#turn-7", "#message-46"])
    assert.ok(markdown.includes(reference), reference);
  assert.ok(markdown.includes("````text"));
  assert.ok(decoded["备份说明.txt"].includes("导入频道"));
});

/** Exercise the real shared download action without relying on either UI theme. */
function controller_fixture(request) {
  const source = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  const start = source.indexOf("async function backup_room(");
  const end = source.indexOf("/** Execute a named view command", start);
  const button = {};
  const downloaded = [];
  const notifications = [];
  const context = vm.createContext({ state: { room: { id: "one" }, query: "filter", page: 3 },
    element: () => button, publish_view() {}, location: { origin: "https://example.test" },
    request_json: request, window: { discuss_backup: { async download_room_backup(snapshot) { downloaded.push(snapshot); } } },
    show_toast: (text) => notifications.push(text) });
  vm.runInContext(source.slice(start, end), context);
  return { context, button, downloaded, notifications };
}

test("backup captures the chosen room before navigation and ignores repeated clicks", async () => {
  let finish;
  const requests = [];
  const fixture = controller_fixture((path) => { requests.push(path); return new Promise((resolve) => { finish = resolve; }); });
  const pending = fixture.context.backup_room();
  await fixture.context.backup_room();
  assert.equal(fixture.button.disabled, true);
  fixture.context.state.room = { id: "two" };
  finish(backup_fixture());
  await pending;
  assert.deepEqual(requests, ["/api/rooms/one/backup"]);
  assert.equal(fixture.downloaded[0].source_url, "https://example.test/r/one");
  assert.equal(fixture.downloaded.length, 1);
  assert.equal(fixture.button.disabled, false);
});

test("sidebar export targets the selected menu room without switching the current draft", async () => {
  const requests = [];
  const fixture = controller_fixture(async (path) => { requests.push(path); return backup_fixture(); });
  fixture.context.state.draft = "保留草稿";
  await fixture.context.backup_room("archived-room");
  assert.deepEqual(requests, ["/api/rooms/archived-room/backup"]);
  assert.equal(fixture.context.state.room.id, "one");
  assert.equal(fixture.context.state.draft, "保留草稿");
  assert.equal(fixture.context.state.query, "filter");
  assert.equal(fixture.downloaded[0].source_url, "https://example.test/r/archived-room");
});

test("a failed backup permits retry without claiming a completed download", async () => {
  const fixture = controller_fixture(async () => { throw new Error("离线"); });
  await assert.rejects(fixture.context.backup_room(), /离线/);
  assert.equal(fixture.context.state.backup_pending, false);
  assert.equal(fixture.button.disabled, false);
  assert.deepEqual(fixture.downloaded, []);
  assert.deepEqual(fixture.notifications, []);
});

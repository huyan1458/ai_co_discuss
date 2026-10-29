"""Test CLI writes, read-only online instructions, and context provenance."""

import hashlib
import json
import os
import sqlite3
import tempfile
import threading
import time
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlencode, urlsplit
from urllib.request import Request, urlopen
from urllib.robotparser import RobotFileParser

from backend.server import (DiscussionHandler, DiscussionServer, connect_db, create_room,
                            get_message, init_database, require_room)
from backend.runtime import runtime_view


class DiscussionTests(unittest.TestCase):
    """Verify the observable POC workflow using isolated SQLite databases."""

    def setUp(self):
        """Use an explicit test Worker URL, or start isolated local storage."""
        self.owner = uuid.uuid4().hex
        self.member_tokens = {name: uuid.uuid4().hex for name in ("Codex", "Claude", "Gemini", "DeepSeek", "Qwen")}
        self.base = os.getenv("DISCUSS_TEST_URL", "").rstrip("/")
        self.external = bool(self.base)
        if not self.external:
            self.directory = tempfile.TemporaryDirectory()
            self.database = Path(self.directory.name) / "test.sqlite3"
            init_database(self.database, seed=False)
            self.server = DiscussionServer(("127.0.0.1", 0), self.database)
            self.server.local_site = False  # these tests exercise room credential rules, not the account-free local site
            self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
            self.thread.start()
            self.base = f"http://127.0.0.1:{self.server.server_port}"
        self.room = self.request("/api/rooms", {"title": "测试议题", "goal": "保持完整记录"})[1]

    def tearDown(self):
        """Release the server and all temporary files."""
        if self.external:
            return
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.directory.cleanup()

    def test_browser_update_stream_reports_only_successful_committed_writes(self):
        """Independent subscribers see committed changes and can reconnect without a cursor."""
        if self.external:
            self.skipTest("The optional cloud push binding is covered by Worker tests")
        with urlopen(self.base + "/api/updates", timeout=3) as first, urlopen(
                self.base + "/api/updates", timeout=3) as second:
            self.assertIn("text/event-stream", first.headers["Content-Type"])
            for stream in (first, second):
                self.assertEqual(stream.readline(), b"retry: 3000\n")
                self.assertEqual(stream.readline(), b"event: ready\n")
                self.assertEqual(stream.readline(), b"data: {}\n")
                self.assertEqual(stream.readline(), b"\n")
            version = self.server.update_version
            self.assertEqual(self.request(f"/api/rooms/{self.room['id']}/messages",
                                         {"author": "用户", "text": ""})[0], 400)
            self.assertEqual(self.server.update_version, version)
            saved = self.request(f"/api/rooms/{self.room['id']}/messages",
                                 {"author": "用户", "text": "立即出现", "submission_id": "stream-write"})[1]
            for stream in (first, second):
                self.assertEqual(stream.readline(), b"event: change\n")
                self.assertEqual(stream.readline(), b"data: {}\n")
                self.assertEqual(stream.readline(), b"\n")
            self.assertEqual(self.request(f"/api/rooms/{self.room['id']}/messages/{saved['message']['id']}")[1]["text"],
                             "立即出现")
        with urlopen(self.base + "/api/updates", timeout=3) as reconnected:
            self.assertEqual(reconnected.readline(), b"retry: 3000\n")
            self.assertEqual(reconnected.readline(), b"event: ready\n")

    def test_locked_session_update_blocks_a_concurrent_resume(self):
        """A queued resume cannot pass a locked update or reuse the pre-update control revision."""
        if self.external:
            self.skipTest("The database writer lock is covered by the Worker batch tests")
        from backend.session_room import discussion_action, session_room, update_session_limits
        self.configure_host()
        self.session_action("pause")
        room_id = self.room["id"]
        with closing(connect_db(self.database)) as connection:
            paused = session_room(connection, room_id)
        entered, proceed, restarting = threading.Event(), threading.Event(), threading.Event()
        def update_limits():
            with closing(connect_db(self.database)) as connection, connection:
                update_session_limits(connection, room_id, self.owner, {"revision": paused["revision"], "max_minutes": 5})
                entered.set()
                self.assertTrue(proceed.wait(3))
        def resume():
            restarting.set()
            with closing(connect_db(self.database)) as connection, connection:
                return discussion_action(connection, room_id, self.owner, {"action": "resume", "revision": paused["revision"]}, require_room(connection, room_id))
        with ThreadPoolExecutor(max_workers=2) as pool:
            saving = pool.submit(update_limits)
            self.assertTrue(entered.wait(3))
            resuming = pool.submit(resume)
            try:
                self.assertTrue(restarting.wait(3))
                with self.assertRaises(TimeoutError):
                    resuming.result(0.2)
            finally:
                proceed.set()
            saving.result(3)
            with self.assertRaises(FileExistsError):
                resuming.result(3)
        self.assertEqual(self.request(f"/api/rooms/{room_id}/discussion")[1]["session"]["status"], "paused")

    def request(self, path, payload=None, method=None, token=None):
        """Send a request and decode JSON or UTF-8 text, including error bodies."""
        payload = dict(payload) if payload is not None else None
        if payload is not None and (path == "/api/rooms" or (path.endswith("/topic") and "experts" in payload)):
            experts = payload.get("experts", {name: "cli" if name == "Codex" else "online" for name in self.member_tokens})
            if isinstance(experts, dict):
                current = self.request(path.removesuffix("/topic"))[1].get("experts", {}) if path.endswith("/topic") else {}
                for name, mode in experts.items():
                    if name in current and current[name] != mode:
                        self.member_tokens[name] = uuid.uuid4().hex
                payload.setdefault("members", [{"name": name, "token": self.member_tokens.setdefault(name, uuid.uuid4().hex),
                    "access": "online" if mode == "online" else "runner"} for name, mode in experts.items()])
        if payload is not None and path.endswith("/messages") and "source" not in payload and "submitted_by" not in payload:
            mode = self.request(path.removesuffix("/messages"))[1].get("experts", {}).get(payload.get("author"))
            if mode == "cli":
                payload["source"] = "cli"
            elif mode == "online":
                payload["submitted_by"] = "用户"
        actor = (payload or {}).get("actor", (payload or {}).get("submitted_by", (payload or {}).get("author", "用户")))
        if token is None:
            token = self.owner if actor == "用户" or path == "/api/rooms" else self.member_tokens.get(actor, "")
        data = json.dumps(payload).encode() if payload is not None else None
        request = Request(self.base + path, data=data, method=method)
        request.add_header("X-Discussion-Token", token)
        if data:
            request.add_header("Content-Type", "application/json")
        try:
            response = urlopen(request, timeout=5)
        except HTTPError as error:
            response = error
        with response:
            body = response.read().decode()
            value = json.loads(body) if "application/json" in response.headers.get("Content-Type", "") else body
            return response.status, value

    def post(self, text, submission_id, reply_to=None):
        """Publish an unrestricted user record for storage and reading fixtures."""
        return self.request(f"/api/rooms/{self.room['id']}/messages", {
            "author": "用户", "text": text, "submission_id": submission_id, "reply_to": reply_to,
        })

    def attachment_request(self, path, data=None, headers=None):
        """Read raw bytes so content headers and binary round trips are verified."""
        actor = parse_qs(urlsplit(path).query).get("actor", ["用户"])[0]
        request = Request(self.base + path, data=data, headers={"Content-Type": "application/octet-stream",
            "X-Discussion-Token": self.owner if actor == "用户" else self.member_tokens.get(actor, ""), **(headers or {})})
        try:
            response = urlopen(request, timeout=10)
        except HTTPError as error:
            response = error
        with response:
            return response.status, response.headers, response.read()

    def test_attachments_round_trip_link_replay_and_room_delete(self):
        """Published files retain exact bytes, provenance, readable links, and backup metadata."""
        base = f"/api/rooms/{self.room['id']}"
        data = b"\x89PNG\r\n\x1a\noriginal-image"
        params = urlencode({"actor": "用户", "file_name": "中文 截图.png", "submission_id": "upload-original"})
        status, _, body = self.attachment_request(base + "/attachments?" + params, data, {"Content-Type": "text/html"})
        self.assertEqual(status, 201, body)
        file = json.loads(body)["attachment"]
        self.assertEqual((file["content_type"], file["size"], file["sha256"]), ("image/png", len(data), hashlib.sha256(data).hexdigest()))
        self.assertEqual(self.request(base + "/attachments")[1]["total"], 0)
        self.assertEqual(self.request(base + "/attachments?submission_id=upload-original")[1]["attachments"][0]["id"], file["id"])
        replay = self.attachment_request(base + "/attachments?" + params, data)
        self.assertEqual(replay[0], 200)
        self.assertEqual(json.loads(replay[2])["attachment"]["id"], file["id"])
        self.assertEqual(self.attachment_request(base + "/attachments?" + params, b"changed")[0], 409)
        payload = {"author": "用户", "text": "", "attachment_ids": [file["id"]], "submission_id": "attached-message"}
        status, result = self.request(base + "/messages", payload)
        self.assertEqual(status, 201, result)
        message = result["message"]
        self.assertEqual(self.request(base + "/messages", payload)[1]["message"], message)
        self.assertEqual(self.request(base + f"/messages/{message['id']}")[1]["attachments"], message["attachments"])
        self.assertEqual(self.request(base + "/messages")[1]["messages"][0]["attachments"], message["attachments"])
        self.assertEqual(self.request(base + "/attachments")[1]["total"], 1)
        self.assertIn(file["download_url"], self.request(f"/r/{self.room['id']}/messages/{message['id']}")[1])
        status, headers, content = self.attachment_request(file["url"])
        self.assertEqual((status, content), (200, data))
        self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
        self.assertTrue(headers["Content-Disposition"].startswith("inline"))
        self.assertTrue(self.attachment_request(file["download_url"])[1]["Content-Disposition"].startswith("attachment"))
        self.assertEqual(self.request(base + "/backup")[1]["tables"]["attachments"][0]["sha256"], file["sha256"])
        self.assertEqual(self.request(base + "/messages", {**payload, "submission_id": "reuse-message"})[0], 409)
        self.assertEqual(self.request(base + "/messages", {**payload, "text": "changed", "attachment_ids": []})[0], 409)
        if not self.external:
            init_database(self.database, seed=False)
            self.assertEqual(self.attachment_request(file["url"])[2], data)
        self.assertEqual(self.request(base + "/delete", {"actor": "用户", "confirm_title": self.room["title"]})[0], 200)
        self.assertEqual(self.attachment_request(file["url"])[0], 404)
        if not self.external:
            self.assertEqual(list(Path(str(self.database) + ".attachments").iterdir()), [])

    def test_attachments_reject_cross_room_owner_path_and_size(self):
        """Untrusted MIME and filenames cannot create executable or cross-room file access."""
        base = f"/api/rooms/{self.room['id']}"
        params = {"actor": "用户", "file_name": "页面.html", "submission_id": "upload-security"}
        status, _, body = self.attachment_request(base + "/attachments?" + urlencode(params), b"<script>bad()</script>")
        self.assertEqual(status, 201, body)
        file = json.loads(body)["attachment"]
        headers = self.attachment_request(file["url"])[1]
        self.assertEqual(headers["Content-Type"], "application/octet-stream")
        self.assertTrue(headers["Content-Disposition"].startswith("attachment"))
        other = self.request("/api/rooms", {"title": "另一房间"})[1]["id"]
        self.assertEqual(self.request(f"/api/rooms/{other}/attachments/{file['id']}")[0], 404)
        self.assertEqual(self.request(f"/api/rooms/{other}/messages", {"author": "用户", "text": "", "attachment_ids": [file["id"]], "submission_id": "cross-room"})[0], 404)
        params.update(actor="Codex", submission_id="other-uploader")
        foreign = json.loads(self.attachment_request(base + "/attachments?" + urlencode(params), b"other")[2])["attachment"]
        self.assertEqual(self.request(base + "/messages", {"author": "用户", "text": "", "attachment_ids": [foreign["id"]], "submission_id": "wrong-owner"})[0], 409)
        for name in ("../escape", "folder\\file", "bad\nname", "x" * 256):
            self.assertEqual(self.attachment_request(base + "/attachments?" + urlencode({**params, "file_name": name}), b"x")[0], 400)
        self.assertEqual(self.attachment_request(base + "/attachments?" + urlencode(params), b"x", {"Content-Length": str(20 * 1024 * 1024 + 1)})[0], 413)
        invalid = {"author": "用户", "text": "资料", "submission_id": "invalid-files"}
        for identifiers in ([file["id"]] * 2, ["invalid"], [f"{index:032x}" for index in range(11)], "not-an-array"):
            self.assertEqual(self.request(base + "/messages", {**invalid, "attachment_ids": identifiers})[0], 400)
        self.assertEqual(self.request(base + "/messages")[1]["total"], 0)

    def test_room_backup_includes_every_page_and_original_relationships(self):
        """Export complete, unchanged records rather than the current history page."""
        self.configure_host(start=False)
        base = f"/api/rooms/{self.room['id']}"
        originals = [self.post(f"原文 {index} 🙂\n保留换行", f"backup-{index}")[1]["message"] for index in range(45)]
        payload = {"author": "Gemini", "submitted_by": "Codex", "source": "cli", "text": "完整专家意见",
                   "summary": "摘要", "summary_by": "Gemini", "submission_id": "backup-answer", "reply_to": originals[0]["id"]}
        status, answer = self.request(base + "/messages", payload)
        self.assertEqual(status, 201)
        answer = answer["message"]
        self.assertEqual(self.request(base + "/state", {"actor": "Codex", "text": "保留分歧", "brief": "主持简报", "until": answer["id"]})[0], 200)
        before = self.request(base)[1]
        status, snapshot = self.request(base + "/backup?page=2&q=missing&author=Claude")
        self.assertEqual(status, 200)
        self.assertEqual((snapshot["format"], snapshot["version"]), ("ai-codiscuss-room-backup", 2))
        self.assertTrue(snapshot["exported_at"])
        tables = snapshot["tables"]
        self.assertEqual(set(tables), {"rooms", "room_directory", "room_folder_assignments", "topic_folders", "room_creations",
                                      "room_briefs", "room_user_requests", "topic_settings", "discussion_limits", "messages", "message_withdrawals", "message_details", "message_summaries", "message_timings", "discussion_turns", "attachments", "room_modes", "room_members", "member_requests", "member_suggestions", "member_recommendations",
                                      "discussion_options", "round_budgets", "scheduler_decisions",
                                      "discussion_sessions", "discussion_conclusions", "session_requests",
                                      "task_message_sources", "session_state", "session_limits",
                                      "session_round_budgets", "session_options", "session_pauses"})
        self.assertEqual([row["id"] for row in tables["messages"]], [row["id"] for row in originals] + [answer["id"]])
        for original, row in zip(originals + [answer], tables["messages"]):
            self.assertEqual(row, {key: original[key] for key in row})
        details = next(row for row in tables["message_details"] if row["message_id"] == answer["id"])
        summary = next(row for row in tables["message_summaries"] if row["message_id"] == answer["id"])
        self.assertEqual((details["submitted_by"], details["turn_id"]), ("Codex", None))
        self.assertEqual((summary["text"], summary["author"]), ("摘要", "Gemini"))
        self.assertEqual(tables["discussion_turns"], [])
        self.assertEqual(tables["rooms"][0]["state_text"], "保留分歧")
        self.assertEqual(tables["room_briefs"][0]["text"], "主持简报")
        self.assertEqual(tables["topic_settings"][0]["host"], "Codex")
        after = self.request(base)[1]
        before["limits"]["elapsed_seconds"] = after["limits"]["elapsed_seconds"]
        self.assertEqual(after, before)

    def test_room_backup_excludes_other_rooms_and_retains_archived_data(self):
        """Folder membership must not pull another room's messages or configuration."""
        base = f"/api/rooms/{self.room['id']}"
        folder = self.request("/api/folders", {"name": "共同文件夹"})[1]
        self.request(base + "/folder", {"actor": "用户", "folder_id": folder["id"]})
        other = self.request("/api/rooms", {"title": "禁止混入的房间", "submission_id": "other-creation"})[1]
        self.request(f"/api/rooms/{other['id']}/folder", {"actor": "用户", "folder_id": folder["id"]})
        self.request(f"/api/rooms/{other['id']}/messages", {"author": "用户", "text": "OTHER_SECRET", "submission_id": "other-secret"})
        self.post("本房间原文", "own-record")
        self.assertEqual(self.request(base + "/archive", {"actor": "用户"})[0], 200)
        status, snapshot = self.request(base + "/backup")
        self.assertEqual(status, 200)
        tables = snapshot["tables"]
        self.assertEqual(tables["room_directory"][0]["archived"], 1)
        self.assertEqual(tables["topic_folders"], [folder])
        self.assertEqual(len(tables["room_folder_assignments"]), 1)
        self.assertEqual([row["text"] for row in tables["messages"]], ["本房间原文"])
        self.assertNotIn(other["id"], json.dumps(snapshot))
        self.assertNotIn("OTHER_SECRET", json.dumps(snapshot))
        self.assertEqual(self.request(base + "/backup", {}, method="POST")[0], 400)

    def test_room_import_renumbers_history_and_skips_a_repeat(self):
        """An imported backup keeps its relationships and references under fresh IDs and the importer's credential."""
        self.configure_host(start=False)
        base = f"/api/rooms/{self.room['id']}"
        first = self.post("原始问题", "import-first")[1]["message"]
        data = b"\x89PNG\r\n\x1a\nimported-image"
        upload = urlencode({"actor": "用户", "file_name": "图.png", "submission_id": "import-file"})
        file = json.loads(self.attachment_request(base + "/attachments?" + upload, data)[2])["attachment"]
        self.request(base + "/messages", {"author": "用户", "text": f"补充 #{first['id']}", "attachment_ids": [file["id"]],
                                          "submission_id": "import-second", "reply_to": first["id"]})
        payload = {"author": "Gemini", "submitted_by": "Codex", "source": "cli", "text": f"回应 #{first['id']}",
                   "summary": f"摘要 #{first['id']}", "summary_by": "Gemini", "submission_id": "import-answer"}
        answer = self.request(base + "/messages", payload)[1]["message"]
        backup = json.loads(json.dumps(self.request(base + "/backup")[1]).replace(self.room["id"], "importedroom"))
        backup["tables"]["scheduler_decisions"] = [{"id": 1, "after_message_id": first["id"], "kind": "interjection", "label": "交给主持人 Codex", "confidence": 0.66,
                                                    "applied": 0, "provider": "jev", "created_at": "2026-10-25T00:00:00Z", "feedback": "bad", "should_be": "Gemini",
                                                    "note": "该问 Gemini", "context": "{\"prompt\": 2}"}]
        backup["tables"]["topic_folders"] = [{"id": "sourcefolder", "name": "来源文件夹", "position": 1}]
        self.post("占用新编号", "import-later")
        status, result = self.request("/api/rooms/import", backup)
        self.assertEqual(status, 201, result)
        self.assertEqual((result["id"], list(result["attachments"])), ("importedroom", [file["id"]]))
        self.assertEqual(self.request("/api/rooms/import", backup)[1]["skipped"], True)
        room = self.request("/api/rooms/importedroom")[1]
        self.assertEqual((room["host"], room["phase"], room["title"]), ("Codex", "discussing", self.room["title"]))
        self.assertIsNone(room["folder_id"])
        self.assertEqual(self.request("/api/rooms")[1]["folders"], [])
        self.assertEqual([(item["feedback"], item["should_be"], item["note"], item["context"]) for item in room["scheduler_decisions"]],
                         [("bad", "Gemini", "该问 Gemini", "{\"prompt\": 2}")])
        messages = self.request("/api/rooms/importedroom/messages")[1]["messages"]
        new_first, second, new_answer = sorted(messages, key=lambda message: message["id"])
        self.assertGreater(new_first["id"], answer["id"] + 1)
        self.assertEqual((second["text"], second["reply_to"]), (f"补充 #{new_first['id']}", new_first["id"]))
        self.assertEqual((new_answer["text"], new_answer["summary"], new_answer["submitted_by"]),
                         (f"回应 #{new_first['id']}", f"摘要 #{new_first['id']}", "Codex"))
        self.assertIsNone(new_answer["turn_id"])
        self.assertIsNone(room["current_turn"])
        path = f"/api/rooms/importedroom/attachments/{result['attachments'][file['id']]}"
        self.assertEqual(self.attachment_request(path + "/content")[0], 404)
        request = Request(self.base + path + "/import", data=data, headers={"X-Discussion-Token": self.owner})
        with urlopen(request, timeout=10) as response:
            self.assertEqual(response.status, 200)
        self.assertEqual(self.attachment_request(path + "/content")[2], data)

    def test_room_backup_v2_imports_sessions_as_read_only_history(self):
        """Session history and task provenance are remapped without importing executable work."""
        self.configure_host(experts={"Codex": "cli", "Gemini": "cli"})
        base = f"/api/rooms/{self.room['id']}"
        before = self.post("讨论前的问题 #17", "session-backup-before")[1]["message"]
        host_execution = self.reserve_member("Codex")["execution_id"]
        self.assertEqual(self.request(base + "/state", {"actor": "Codex", "text": "旧结论状态"})[0], 200)
        conclusion = self.request(base + "/conclusion")[1]
        status, result = self.request(base + "/limits", {"actor": "Codex", "action": "done",
                                                              "conclusion": conclusion["revision"]})
        self.assertEqual(status, 200, result)
        self.assertEqual(self.request(base)[1]["session"]["status"], "concluded")
        self.assertEqual(self.post("讨论间的自由消息", "session-backup-between")[0], 201)
        self.session_action("start", goal="活动会话")
        active_session = self.request(base + "/discussion")[1]["session"]
        status, result = self.schedule("session-backup-plan")
        self.assertEqual(status, 201, result)
        plan = result["turn"]
        execution = self.reserve_member("Gemini")["execution_id"]
        self.assertNotEqual(host_execution, execution)
        with closing(connect_db(self.database)) as connection, connection:
            host_request = connection.execute("SELECT id FROM member_requests WHERE purpose='discuss_host' ORDER BY id LIMIT 1").fetchone()[0]
            connection.execute("UPDATE task_message_sources SET cause_message_id=?,cause_request_id=? WHERE session_request_id=?",
                               (before["id"], host_request, plan["id"]))
            connection.execute("UPDATE session_requests SET read_until=? WHERE id=?", (before["id"], plan["id"]))
            connection.execute("UPDATE session_state SET read_until=?,held_since=? WHERE session_id=?",
                               (before["id"], before["id"], active_session["id"]))
            connection.execute("UPDATE session_limits SET max_rounds=3,max_minutes=9,execution_minutes=4,started_at=1700000000,stop_reason='limit-test' WHERE session_id=?",
                               (active_session["id"],))
            connection.execute("UPDATE session_round_budgets SET base=2,cap=3,extra=1 WHERE session_id=?", (active_session["id"],))
            connection.execute("UPDATE session_options SET named_followup=1 WHERE session_id=?", (active_session["id"],))
            connection.execute("UPDATE session_pauses SET paused_at=1700000001,paused_seconds=8 WHERE session_id=?",
                               (active_session["id"],))
        backup = json.loads(json.dumps(self.request(base + "/backup")[1]).replace(self.room["id"], "sessionimport"))
        self.assertEqual(backup["version"], 2)
        self.assertNotIn("session_start_submissions", backup["tables"])
        self.assertNotIn("discussion_runtime", backup["tables"])
        self.assertNotIn("execution_retries", backup["tables"])
        self.assertIn("execution_id", backup["tables"]["member_requests"][0])
        self.assertTrue(any(row["execution_id"] is not None for row in backup["tables"]["member_requests"]))
        incomplete = json.loads(json.dumps(backup))
        incomplete["tables"].pop("task_message_sources")
        self.assertEqual(self.request("/api/rooms/import", incomplete)[0], 400)
        status, imported = self.request("/api/rooms/import", backup)
        self.assertEqual(status, 201, imported)
        with closing(connect_db(self.database)) as connection:
            source_room = connection.execute("SELECT id FROM rooms WHERE id='sessionimport'").fetchone()[0]
            imported_sessions = list(connection.execute("SELECT * FROM discussion_sessions WHERE room_id=? ORDER BY id",
                                                        (source_room,)))
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM member_requests WHERE room_id=? AND execution_id IS NOT NULL",
                                                (source_room,)).fetchone()[0], 0)
            self.assertEqual(len(imported_sessions), 2)
            prior = next(row for row in imported_sessions if row["goal"] == "保持完整记录")
            active = next(row for row in imported_sessions if row["goal"] == "活动会话")
            self.assertEqual(prior["status"], "concluded")
            self.assertEqual(active["status"], "concluded")
            self.assertEqual(active["ended_message_id"], connection.execute(
                "SELECT MAX(id) FROM messages WHERE room_id=? AND NOT EXISTS "
                "(SELECT 1 FROM task_message_sources WHERE message_id=messages.id)", (source_room,)).fetchone()[0])
            imported_conclusion = connection.execute("SELECT * FROM discussion_conclusions WHERE session_id=?",
                                                      (prior["id"],)).fetchone()
            original_conclusion = backup["tables"]["discussion_conclusions"][0]
            self.assertEqual(imported_conclusion["stop_reason"], original_conclusion["stop_reason"])
            imported_plan = connection.execute("SELECT * FROM session_requests WHERE session_id=? AND submission_id=?",
                                                (active["id"], plan["submission_id"])).fetchone()
            self.assertEqual(imported_plan["status"], "cancelled", dict(imported_plan))
            self.assertNotEqual(imported_plan["id"], plan["id"])
            self.assertNotEqual(imported_plan["member_request_id"], plan["member_request_id"])
            imported_request = connection.execute("SELECT * FROM member_requests WHERE id=?",
                                                    (imported_plan["member_request_id"],)).fetchone()
            self.assertEqual((imported_request["status"], imported_request["execution_id"]), ("cancelled", None))
            source = connection.execute("SELECT * FROM task_message_sources WHERE session_request_id=?",
                                        (imported_plan["id"],)).fetchone()
            self.assertNotEqual(source["message_id"], next(row["message_id"] for row in backup["tables"]["task_message_sources"]
                                                            if row["session_request_id"] == plan["id"]))
            self.assertEqual(imported_request["chain_id"], source["message_id"])
            self.assertEqual(source["cause_message_id"], connection.execute(
                "SELECT id FROM messages WHERE room_id=? AND submission_id='session-backup-before'", (source_room,)).fetchone()[0])
            self.assertEqual(source["cause_request_id"], connection.execute(
                "SELECT id FROM member_requests WHERE room_id=? AND purpose='discuss_host' ORDER BY id LIMIT 1", (source_room,)).fetchone()[0])
            imported_state = connection.execute("SELECT * FROM session_state WHERE session_id=?", (active["id"],)).fetchone()
            imported_boundary = connection.execute("SELECT id FROM messages WHERE room_id=? AND submission_id='session-backup-before'",
                                                    (source_room,)).fetchone()[0]
            self.assertEqual((imported_state["read_until"], imported_state["held_since"]),
                             (imported_boundary, imported_boundary))
            imported_plan = connection.execute("SELECT * FROM session_requests WHERE session_id=? AND submission_id=?",
                                                (active["id"], plan["submission_id"])).fetchone()
            self.assertEqual(imported_plan["read_until"], imported_boundary)
            imported_limits = connection.execute("SELECT * FROM session_limits WHERE session_id=?", (active["id"],)).fetchone()
            self.assertEqual((imported_limits["max_rounds"], imported_limits["max_minutes"],
                              imported_limits["execution_minutes"], imported_limits["started_at"],
                              imported_limits["stop_reason"]), (3, 9, 4, 1700000000, "limit-test"))
            self.assertEqual(tuple(connection.execute("SELECT base,cap,extra FROM session_round_budgets WHERE session_id=?",
                                                      (active["id"],)).fetchone()), (2, 3, 1))
            self.assertEqual(connection.execute("SELECT named_followup FROM session_options WHERE session_id=?",
                                                (active["id"],)).fetchone()[0], 1)
            self.assertEqual(tuple(connection.execute("SELECT paused_at,paused_seconds FROM session_pauses WHERE session_id=?",
                                                      (active["id"],)).fetchone()), (1700000001, 8))
            self.assertEqual(connection.execute("PRAGMA foreign_key_check").fetchall(), [])
        imported_messages = self.request("/api/rooms/sessionimport/messages")[1]["messages"]
        self.assertNotIn("系统任务", [row["author"] for row in imported_messages])

    def test_room_backup_handles_empty_and_missing_rooms(self):
        """A new room is exportable; missing rooms never produce an empty success."""
        status, snapshot = self.request(f"/api/rooms/{self.room['id']}/backup")
        self.assertEqual(status, 200)
        self.assertEqual(snapshot["tables"]["messages"], [])
        self.assertEqual(snapshot["tables"]["discussion_turns"], [])
        self.assertEqual(self.request("/api/rooms/missing/backup"), (404, {"error": "房间不存在"}))

    def test_channel_order_and_rename_survive_reload(self):
        """Moves persist without losing new rooms; rename retains IDs and content."""
        original = self.post("原文保留", "rename-original")[1]["message"]
        second = self.request("/api/rooms", {"title": "频道乙"})[1]
        third = self.request("/api/rooms", {"title": "频道丙"})[1]
        path = f"/api/rooms/{third['id']}/move"
        # Ordering needs no room credential; the declared actor rule still applies.
        self.assertEqual(self.request(path, {"actor": "Claude", "before_id": self.room["id"]})[0], 400)
        self.assertEqual(self.request(path, {"actor": "用户", "before_id": "missing"})[0], 400)
        self.assertEqual(self.request(path, {"actor": "用户", "before_id": self.room["id"]})[0], 200)
        base = f"/api/rooms/{self.room['id']}"
        self.assertEqual(self.request(base + "/rename", {"actor": "用户", "title": "  "})[0], 400)
        self.assertEqual(self.request(base + "/rename", {"actor": "用户", "title": "重命名 <& 中文"})[0], 200)
        if not self.external:
            init_database(self.database)
        ids = [item["id"] for item in self.request("/api/rooms")[1]["rooms"]]
        self.assertLess(ids.index(third["id"]), ids.index(self.room["id"]))
        self.assertLess(ids.index(self.room["id"]), ids.index(second["id"]))
        self.assertEqual(self.request(base)[1]["title"], "重命名 <& 中文")
        self.assertEqual(self.request(base + f"/messages/{original['id']}")[1]["text"], original["text"])
        self.assertEqual(self.request(path, {"actor": "用户", "before_id": None})[0], 200)
        self.assertEqual(self.request("/api/rooms")[1]["rooms"][-1]["id"], third["id"])

    def test_second_server_cannot_reuse_active_port(self):
        """Reject duplicate listeners instead of mixing separate discussion databases."""
        if self.external:
            self.skipTest("Socket binding belongs to the Python deployment")
        with self.assertRaises(OSError):
            with DiscussionServer(self.server.server_address, self.database):
                pass
        self.assertEqual(self.request("/api/health"), (200, {"ok": True}))

    def test_discussion_session_is_explicit_and_survives_schema_reinitialization(self):
        """Session controls update only the active session and survive repeated schema application."""
        self.configure_host()
        base = f"/api/rooms/{self.room['id']}"
        original = self.request(base + "/discussion")[1]["session"]
        self.assertEqual(original["status"], "active")
        self.session_action("pause")
        self.assertEqual(self.request(base)[1]["session"]["status"], "paused")
        if not self.external:
            init_database(self.database)
            init_database(self.database)
        paused = self.request(base + "/discussion")[1]["session"]
        self.assertEqual((paused["id"], paused["status"]), (original["id"], "paused"))
        self.session_action("resume")
        self.assertEqual(self.request(base)[1]["session"]["id"], original["id"])

    def test_user_can_message_while_paused(self):
        """Pausing a session still permits ordinary user messages and direct questions."""
        self.configure_host()
        self.session_action("pause")
        self.assertEqual(self.post("@主持人 讨论结束了吗", "paused-user-question")[0], 201)

    def test_archive_preserves_history_and_requires_explicit_resume(self):
        """Archive cancels active work, retains evidence and never resumes work during restoration."""
        self.configure_host()
        original = self.post("存档原文", "archive-original")[1]["message"]
        plan = self.schedule()[1]["turn"]
        base = f"/api/rooms/{self.room['id']}"
        status, archived = self.request(base + "/archive", {"actor": "用户"})
        self.assertEqual((status, archived["archived"], archived["session"]["status"]), (200, True, "paused"))
        self.assertEqual(self.request(base + f"/turns/{plan['id']}")[1]["status"], "cancelled")
        self.assertEqual(self.post("拒绝新观点", "archived-new-001")[0], 400)
        self.assertEqual(self.request(base + "/messages", {"author": "用户", "kind": "receipt", "text": "旧回执", "submission_id": "archive-receipt"})[0], 400)
        self.assertEqual(self.request(base + f"/messages/{original['id']}")[1]["text"], "存档原文")
        if not self.external:
            init_database(self.database)
        restored = self.request(base + "/restore", {"actor": "用户"})[1]
        self.assertEqual((restored["archived"], restored["session"]["status"]), (False, "paused"))
        self.session_action("resume")
        self.assertEqual(self.post("显式恢复后发言", "restored-new-001")[0], 201)

    def test_topic_folder_assignment_persists_and_survives_archive_restore(self):
        """Folders categorize existing rooms without changing their archive state."""
        for invalid_name in (None, 42, ["标题"], {}, "   ", "😀" * 41):
            self.assertEqual(self.request("/api/folders", {"name": invalid_name})[0], 400)
        self.assertEqual(self.request("/api/folders", {"name": "😀" * 40})[0], 201)
        folder = self.request("/api/folders", {"name": "产品讨论"})
        self.assertEqual(folder[0], 201)
        folder_id = folder[1]["id"]
        room_path = f"/api/rooms/{self.room['id']}"
        self.assertEqual(self.request(room_path + "/folder", {"actor": "用户", "folder_id": "missing"})[0], 400)
        self.assertEqual(self.request(room_path + "/folder", {"actor": "用户", "folder_id": 42})[0], 400)
        assigned = self.request(room_path + "/folder", {"actor": "用户", "folder_id": folder_id})[1]
        self.assertEqual(assigned["folder_id"], folder_id)
        self.assertEqual(self.request(room_path + "/archive", {"actor": "用户"})[1]["folder_id"], folder_id)
        restored = self.request(room_path + "/restore", {"actor": "用户"})[1]
        self.assertEqual(restored["folder_id"], folder_id)
        if not self.external:
            init_database(self.database)
        directory = self.request("/api/rooms")[1]
        self.assertIn(folder_id, [item["id"] for item in directory["folders"]])
        self.assertEqual(next(item for item in directory["folders"] if item["id"] == folder_id)["name"], "产品讨论")
        self.assertEqual(next(item for item in directory["rooms"] if item["id"] == self.room["id"])["folder_id"], folder_id)
        self.assertEqual(self.request(room_path + "/folder", {"actor": "用户", "folder_id": None})[1]["folder_id"], None)

    def test_folder_rename_preserves_order_and_archived_membership(self):
        """Editing a folder name retains its contents and rejects invalid names."""
        folder = self.request("/api/folders", {"name": "原名"})[1]
        room_path = f"/api/rooms/{self.room['id']}"
        self.request(room_path + "/folder", {"actor": "用户", "folder_id": folder["id"]})
        self.request(room_path + "/archive", {"actor": "用户"})
        before = self.request(room_path)[1]
        path = f"/api/folders/{folder['id']}/rename"
        status, renamed = self.request(path, {"name": "  新名称  "})
        self.assertEqual(status, 200)
        self.assertEqual(renamed, {**folder, "name": "新名称"})
        self.assertEqual(self.request(room_path)[1], before)
        for invalid in ("", " ", "字" * 41, None, 42, [], {}):
            self.assertEqual(self.request(path, {"name": invalid})[0], 400)
        self.assertEqual(self.request("/api/folders/missing/rename", {"name": "不存在"})[0], 404)
        self.assertIn(renamed, self.request("/api/rooms")[1]["folders"])

    def test_folder_removal_preserves_active_and_archived_rooms(self):
        """Removing a group clears assignments without deleting any room records."""
        folder = self.request("/api/folders", {"name": "待移除"})[1]["id"]
        active_path = f"/api/rooms/{self.room['id']}"
        self.post("移除分组后保留原文", "remove-folder-message")
        self.request(active_path + "/folder", {"actor": "用户", "folder_id": folder})
        archived = self.request("/api/rooms", {"title": "已存档", "folder_id": folder})[1]
        archived_path = f"/api/rooms/{archived['id']}"
        self.request(archived_path + "/archive", {"actor": "用户"})
        before = [self.request(path)[1] for path in (active_path, archived_path)]
        directory = self.request("/api/rooms")[1]
        status, removed = self.request(f"/api/folders/{folder}/delete", {})
        self.assertEqual((status, removed), (200, {"deleted": True, "id": folder}))
        for path, original in zip((active_path, archived_path), before):
            current = self.request(path)[1]
            original["limits"]["elapsed_seconds"] = current["limits"]["elapsed_seconds"]
            self.assertEqual(current, {**original, "folder_id": None})
        after = self.request("/api/rooms")[1]
        self.assertEqual([room["id"] for room in after["rooms"]], [room["id"] for room in directory["rooms"]])
        self.assertEqual(after["folders"], [item for item in directory["folders"] if item["id"] != folder])
        self.assertEqual(self.request(f"/api/folders/{folder}/delete", {})[0], 404)
        self.assertEqual(self.request("/api/folders/__uncategorized__/delete", {})[0], 404)
        self.assertEqual(self.request("/api/rooms")[1], after)

    def test_folder_removal_keeps_uncategorized_between_remaining_groups(self):
        """Remove empty groups before and after the virtual group without moving it."""
        folders = [self.request("/api/folders", {"name": name})[1]["id"] for name in ("甲", "乙", "丙")]
        moved = self.request("/api/folders/__uncategorized__/move", {"before_id": folders[1]})[1]
        self.request(f"/api/folders/{folders[0]}/delete", {})
        directory = self.request("/api/rooms")[1]
        self.assertEqual(directory["uncategorized_position"], moved["uncategorized_position"] - 1)
        self.assertEqual(directory["folders"], [item for item in moved["folders"] if item["id"] != folders[0]])
        self.request("/api/folders/__uncategorized__/move", {"before_id": folders[2]})
        self.request(f"/api/folders/{folders[2]}/delete", {})
        self.assertIsNone(self.request("/api/rooms")[1]["uncategorized_position"])

    def test_create_room_in_folder_is_atomic_and_replayable(self):
        """Creation includes placement; retries never duplicate or move an existing room."""
        folder = self.request("/api/folders", {"name": "目标文件夹"})[1]["id"]
        payload = {"title": "在文件夹中新建", "folder_id": folder, "submission_id": str(uuid.uuid4())}
        status, room = self.request("/api/rooms", payload)
        self.assertEqual((status, room["folder_id"]), (201, folder))
        status, replay = self.request("/api/rooms", payload)
        self.assertEqual((status, replay["id"], replay["duplicate"]), (200, room["id"], True))
        self.assertEqual(self.request("/api/rooms", {**payload, "folder_id": None})[0], 409)
        self.request(f"/api/rooms/{room['id']}/folder", {"actor": "用户", "folder_id": None})
        self.assertIsNone(self.request("/api/rooms", payload)[1]["folder_id"])
        before_ids = [item["id"] for item in self.request("/api/rooms")[1]["rooms"]]
        for invalid in ("missing", "", 42, [], {}):
            self.assertEqual(self.request("/api/rooms", {**payload, "folder_id": invalid, "submission_id": str(uuid.uuid4())})[0], 400)
        self.assertEqual([item["id"] for item in self.request("/api/rooms")[1]["rooms"]], before_ids)
        ungrouped = {"title": "未归类", "submission_id": str(uuid.uuid4())}
        created = self.request("/api/rooms", ungrouped)[1]
        self.assertIsNone(created["folder_id"])
        self.assertEqual(self.request("/api/rooms", {**ungrouped, "folder_id": None})[1]["id"], created["id"])

    def test_revisions_change_only_with_the_room_or_the_directory(self):
        """A room's revision moves with its own writes; the site revision moves with any room or directory change."""
        other = self.request("/api/rooms", {"title": "另一议题", "goal": "保持完整记录"})[1]
        ids = f"{self.room['id']},{other['id']},missing"

        def revisions():
            status, result = self.request(f"/api/revisions?rooms={ids}")
            self.assertEqual(status, 200)
            return result

        before = revisions()
        self.assertEqual(set(before["rooms"]), {self.room["id"], other["id"]}, "a missing room is left out")
        self.assertEqual(revisions(), before, "reading changes nothing")
        self.post("新消息", uuid.uuid4().hex)
        after = revisions()
        self.assertGreater(after["rooms"][self.room["id"]], before["rooms"][self.room["id"]])
        self.assertEqual(after["rooms"][other["id"]], before["rooms"][other["id"]])
        self.assertGreater(after["site"], before["site"])
        self.request("/api/folders", {"name": "甲组"})
        moved = revisions()
        self.assertGreater(moved["site"], after["site"], "a directory change raises only the site revision")
        self.assertEqual(moved["rooms"], after["rooms"])
        if not self.external:
            # An outer INSERT OR IGNORE must not turn the trigger's own write into a skipped one.
            with closing(sqlite3.connect(self.database)) as connection, connection:
                connection.execute("INSERT OR IGNORE INTO room_briefs (room_id,text,until,updated_at) VALUES (?,?,?,?)",
                                   (other["id"], "简报", 0, "2026-10-29T00:00:00Z"))
            self.assertGreater(revisions()["rooms"][other["id"]], moved["rooms"][other["id"]])

    def test_folder_order_persists_without_changing_room_membership(self):
        """Moves preserve contents, survive reload and reject invalid destinations."""
        folders = [self.request("/api/folders", {"name": name})[1]["id"] for name in ("甲组", "乙组", "丙组")]
        room_path = f"/api/rooms/{self.room['id']}"
        self.request(room_path + "/folder", {"actor": "用户", "folder_id": folders[0]})
        self.request(room_path + "/archive", {"actor": "用户"})
        before_room = self.request(room_path)[1]
        path = f"/api/folders/{folders[2]}/move"
        for _ in range(2):
            status, result = self.request(path, {"before_id": folders[0]})
            self.assertEqual(status, 200)
            self.assertEqual([item["id"] for item in result["folders"] if item["id"] in folders],
                             [folders[2], folders[0], folders[1]])
        result = self.request(path, {"before_id": None})[1]
        self.assertEqual([item["id"] for item in result["folders"] if item["id"] in folders], folders)
        self.assertEqual([item["position"] for item in result["folders"]], list(range(1, len(result["folders"]) + 1)))
        for invalid in (folders[2], "missing", 42, [], {}):
            self.assertEqual(self.request(path, {"before_id": invalid})[0], 400)
        self.assertEqual(self.request("/api/folders/missing/move", {"before_id": None})[0], 404)
        if not self.external:
            init_database(self.database)
        self.assertEqual(self.request("/api/rooms")[1]["folders"], result["folders"])
        self.assertEqual(self.request(room_path)[1], before_room)

    def test_uncategorized_order_with_one_folder_and_legacy_migration(self):
        """The virtual group moves both ways, persists and never becomes an assignment."""
        folder = self.request("/api/folders", {"name": "test"})[1]
        virtual_path = "/api/folders/__uncategorized__/move"
        folder_path = f"/api/folders/{folder['id']}/move"
        if not self.external:
            with closing(sqlite3.connect(self.database)) as connection:
                connection.execute("DROP TABLE directory_settings")
                connection.commit()
            init_database(self.database, seed=False)
            self.assertIsNone(self.request("/api/rooms")[1]["uncategorized_position"])
        self.assertEqual(self.request(virtual_path, {"before_id": None})[0], 200)
        status, moved = self.request(virtual_path, {"before_id": folder["id"]})
        self.assertEqual(status, 200)
        self.assertEqual(moved["uncategorized_position"], len(moved["folders"]) - 1)
        self.assertEqual(self.request(folder_path, {"before_id": "__uncategorized__"})[1]["uncategorized_position"], None)
        moved = self.request(folder_path, {"before_id": None})[1]
        self.assertEqual(moved["uncategorized_position"], len(moved["folders"]) - 1)
        if not self.external:
            init_database(self.database, seed=False)
            init_database(self.database, seed=False)
        directory = self.request("/api/rooms")[1]
        self.assertEqual(directory["uncategorized_position"], moved["uncategorized_position"])
        self.assertEqual(directory["folders"], moved["folders"])
        self.assertIsNone(self.request(f"/api/rooms/{self.room['id']}")[1]["folder_id"])
        self.assertEqual(self.request(f"/api/rooms/{self.room['id']}/folder",
                                      {"actor": "用户", "folder_id": "__uncategorized__"})[0], 400)
        self.assertEqual(self.request(virtual_path, {"before_id": "__uncategorized__"})[0], 400)
        self.request("/api/folders", {"name": "新增组"})
        self.assertEqual(self.request("/api/rooms")[1]["uncategorized_position"], moved["uncategorized_position"])
        self.request(virtual_path, {"before_id": None})
        self.request("/api/folders", {"name": "末尾组"})
        self.assertIsNone(self.request("/api/rooms")[1]["uncategorized_position"])

    def test_delete_removes_related_records_and_leaves_other_channels(self):
        """Wrong confirmations preserve content; deletion removes linked data atomically."""
        self.configure_host()
        original = self.post("删除测试原文", "delete-original")[1]["message"]
        self.post("引用原文", "delete-reply-001", original["id"])
        turn = self.schedule()[1]["turn"]
        base = f"/api/rooms/{self.room['id']}"
        answer = {"author": "Gemini", "text": "回答", "summary": "回答摘要", "submission_id": "delete-answer-001", "request_ids": [turn["member_request_id"]]}
        self.assertEqual(self.request(base + "/messages", answer)[0], 201)
        self.assertEqual(self.request(base + "/state", {"actor": "Codex", "text": "状态", "brief": "主持简报"})[0], 200)
        other = self.request("/api/rooms", {"title": "保留频道"})[1]
        self.assertEqual(self.request(base + "/delete", {"actor": "用户", "confirm_title": "错误"})[0], 400)
        self.assertEqual(self.request(base + "/delete", {"actor": "Gemini", "confirm_title": self.room["title"]})[0], 403)
        self.assertEqual(self.request(base)[1]["message_count"], 3)
        self.assertEqual(self.request(base + "/delete", {"actor": "用户", "confirm_title": self.room["title"]})[0], 200)
        for suffix in ("", "/messages", f"/messages/{original['id']}", "/turns"):
            self.assertEqual(self.request(base + suffix)[0], 404)
        self.assertEqual(self.request(f"/r/{self.room['id']}")[0], 404)
        self.assertEqual(self.request(f"/api/rooms/{other['id']}")[0], 200)
        if not self.external:
            with closing(sqlite3.connect(self.database)) as connection:
                for table in ("messages", "discussion_turns", "topic_settings", "room_directory", "room_folder_assignments", "room_briefs", "room_floor"):
                    self.assertEqual(connection.execute(f"SELECT COUNT(*) FROM {table} WHERE room_id=?", (self.room["id"],)).fetchone()[0], 0)
                self.assertEqual(connection.execute("PRAGMA foreign_key_check").fetchall(), [])

    def test_manual_message_search_and_exact_history(self):
        """Unicode text, mentions, and reply links survive storage and retrieval."""
        status, result = self.post("@Codex 成本 = 100 & 条件 < 3\n原文", "manual-001")
        self.assertEqual(status, 201)
        message = result["message"]
        self.assertEqual(message["source"], "user")
        self.assertEqual(self.post("补充依据", "manual-002", message["id"])[0], 201)
        query = urlencode({"q": "成本", "mention": "Codex"})
        found = self.request(f"/api/rooms/{self.room['id']}/messages?{query}")[1]
        self.assertEqual(found["total"], 1)
        original = self.request(f"/r/{self.room['id']}/messages/{message['id']}")[1]
        self.assertIn("成本 = 100 & 条件 < 3\n原文", original)

    def test_answer_summary_preserves_body_provenance_and_retry(self):
        """Summaries retain their own author and cannot silently change on a retry."""
        self.configure_host()
        base = f"/api/rooms/{self.room['id']}"
        payload = {"author": "Gemini", "submitted_by": "Codex", "source": "cli", "text": "完整正文\n条件与反例保留。",
                   "summary": "仅建议有条件试用。", "summary_by": "Gemini", "submission_id": "summary-original"}
        payload.update(self.prepare_speech("Gemini"))
        status, result = self.request(base + "/messages", payload)
        self.assertEqual(status, 201)
        message = result["message"]
        self.assertEqual((message["summary"], message["summary_by"]), (payload["summary"], "Gemini"))
        self.assertEqual(self.request(base + "/messages", payload)[1]["message"], message)
        for change in ({"summary": "改变摘要"}, {"summary_by": "Codex"}):
            self.assertEqual(self.request(base + "/messages", {**payload, **change})[0], 409)
        saved = self.request(base + f"/messages/{message['id']}")[1]
        self.assertEqual(saved["text"], payload["text"])
        self.assertEqual(self.request(base + "/messages?author=Gemini")[1]["messages"], [saved])
        reading = self.request(f"/r/{self.room['id']}/messages/{message['id']}")[1]
        self.assertIn("回答摘要（Gemini）", reading)
        self.assertTrue(reading.endswith(payload["text"]))

    def test_invalid_summary_does_not_finish_assignment(self):
        """Summary limits and attribution are checked before storing or completing an answer."""
        self.configure_host()
        turn = self.schedule()[1]["turn"]
        base = f"/api/rooms/{self.room['id']}"
        payload = {"author": "Gemini", "submitted_by": "Codex", "text": "完整回答", "request_ids": [turn["member_request_id"]],
                   "summary": "🙂" * 1000, "submission_id": "summary-validation"}
        for change in ({"summary": "🙂" * 1001}, {"summary_by": "Claude"}, {"kind": "receipt", "turn_id": None}):
            self.assertEqual(self.request(base + "/messages", {**payload, **change})[0], 400)
        self.assertEqual(self.request(base + f"/turns/{turn['id']}")[1]["status"], "open")
        self.assertEqual(self.request(base)[1]["message_count"], 0)
        status, result = self.request(base + "/messages", payload)
        self.assertEqual(status, 201)
        self.assertEqual((result["message"]["summary"], result["message"]["summary_by"]), (payload["summary"], "Codex"))

    def test_host_brief_survives_legacy_updates_without_leaking_into_entry(self):
        """A saved brief retains its own cutoff when old clients update detailed state."""
        self.configure_host()
        message = self.post("作为依据的原文", "brief-evidence")[1]["message"]
        base = f"/api/rooms/{self.room['id']}"
        payload = {"actor": "Codex", "text": "详细共识", "brief": "结论待验证；歧义未消除；主持人将追问条件。", "until": message["id"]}
        status, saved = self.request(base + "/state", payload)
        self.assertEqual(status, 200)
        brief = saved["host_brief"]
        self.assertEqual((brief["text"], brief["until"]), (payload["brief"], message["id"]))
        self.assertTrue(brief["updated_at"])
        self.request(base + "/state", {"actor": "Codex", "text": "旧客户端的新状态", "until": 0})
        self.assertEqual(self.request(base)[1]["host_brief"], brief)
        for change in ({"brief": "🙂" * 1601}, {"until": message["id"] + 100}, {"actor": "Gemini"}):
            self.assertEqual(self.request(base + "/state", {**payload, **change})[0], 403 if "actor" in change else 400)
        self.assertEqual(self.request(base)[1]["state_text"], "旧客户端的新状态")
        self.assertEqual(self.request(base)[1]["host_brief"], brief)
        self.assertNotIn(payload["brief"], self.request(f"/r/{self.room['id']}?mode=cli")[1])
        self.assertIn(payload["brief"], self.request(f"/r/{self.room['id']}/state")[1])

    def test_answered_assignment_count_excludes_other_records(self):
        """Only answered discuss requests count; cancelled plans and ordinary/host replies never inflate progress."""
        self.configure_host()
        base = f"/api/rooms/{self.room['id']}"
        cancelled = self.schedule("round-cancelled")[1]["turn"]
        self.request(base + f"/turns/{cancelled['id']}", {"actor": "用户", "status": "cancelled"})
        self.post("没有关联安排的观点", "round-free")
        host_binding = self.reserve_member("Codex")
        self.assertEqual(self.request(base + "/messages", {**host_binding, "author": "Codex", "kind": "chat", "text": "主持说明", "submission_id": "round-moderation"})[0], 201)
        plan = self.schedule("round-answered")[1]["turn"]
        self.assertEqual(self.request(base + "/discussion")[1]["session"]["answered"], 0)
        status, saved = self.request(base + "/messages", {"author": "Gemini", "text": "本轮回答", "summary": "简短摘要", "request_ids": [plan["member_request_id"]], "submission_id": "round-answer"})
        self.assertEqual(status, 201, saved)
        self.assertEqual(self.request(base + "/discussion")[1]["session"]["answered"], 1)
        pending = self.schedule("round-pending")[1]["turn"]
        self.assertEqual(self.request(base + f"/turns/{pending['id']}")[1]["status"], "open")
        self.assertEqual(self.request(base + "/discussion")[1]["session"]["answered"], 1)

    def test_concurrent_summary_conflicts_keep_one_unchanged_answer(self):
        """Concurrent same-body submissions with different summaries cannot overwrite the winner."""
        base = f"/api/rooms/{self.room['id']}/messages"
        payload = {"author": "Claude", "text": "同一完整正文", "submission_id": "summary-race"}
        payload.update(self.prepare_speech("Claude"))
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(lambda summary: self.request(base, {**payload, "summary": summary}), ["摘要甲", "摘要乙"]))
        self.assertEqual(sorted(status for status, _ in results), [201, 409])
        winner = next(result["message"] for status, result in results if status == 201)
        self.assertEqual(self.request(base)[1]["messages"], [winner])

    def test_frontend_assets_have_browser_compatible_content_types(self):
        """The channel workspace loads compiled assets through the static routes."""
        assets = {"/": "text/html", "/app.js": "text/javascript",
                  "/modern.js": "text/javascript", "/modern.css": "text/css",
                  "/markdown.js": "text/javascript", "/markdown.css": "text/css",
                  "/icons/LICENSE.txt": "text/plain", "/icons/typesafe.png": "image/png"}
        assets.update({f"/icons/{name}.svg": "image/svg+xml"
                       for name in ("openai", "claude", "gemini", "deepseek", "qwen", "user")})
        for path, content_type in assets.items():
            with self.subTest(path=path), urlopen(self.base + path, timeout=5) as response:
                self.assertEqual(response.status, 200)
                accepted_types = ("text/javascript", "application/javascript") if content_type == "text/javascript" else (content_type,)
                self.assertIn(response.headers["Content-Type"].split(";")[0].strip(), accepted_types)
                self.assertTrue(response.read())

    def test_public_reading_allows_crawlers_and_indexing(self):
        """Public pages and reading endpoints permit crawlers to fetch and index."""
        status, robots_text = self.request("/robots.txt")
        self.assertEqual(status, 200)
        policy = RobotFileParser()
        policy.parse(robots_text.splitlines())
        paths = ("/", "/api/rooms", f"/r/{self.room['id']}", f"/r/{self.room['id']}/brief")
        for path in paths:
            with self.subTest(path=path):
                for user_agent in ("*", "DeepSeekBot", "Googlebot"):
                    self.assertTrue(policy.can_fetch(user_agent, self.base + path))
                with urlopen(self.base + path, timeout=5) as response:
                    self.assertEqual(response.status, 200)
                    directives = response.headers.get("X-Robots-Tag", "").lower()
                    self.assertNotIn("noindex", directives)
                    self.assertNotIn("nofollow", directives)
                    self.assertNotIn("none", directives)

    def test_cli_publish_is_idempotent_and_rejects_changed_payload(self):
        """An execution's exact retries retain one original CLI record, even after completion."""
        self.configure_host(experts={"Codex": "cli", "Gemini": "cli"})
        payload = {"author": "Gemini", "text": "CLI 原文 & #测试", "submission_id": "cli-once-001", "source": "cli", "kind": "chat"}
        payload.update(self.prepare_speech("Gemini"))
        path = f"/api/rooms/{self.room['id']}/messages"
        status, first = self.request(path, payload)
        self.assertEqual(status, 201, first)
        self.assertEqual(first["message"]["source"], "cli")
        status, repeated = self.request(path, payload)
        self.assertEqual(status, 200)
        self.assertTrue(repeated["duplicate"])
        self.assertEqual(first["message"], repeated["message"])
        self.assertEqual(self.request(f"/api/rooms/{self.room['id']}")[1]["message_count"], 1)
        self.assertEqual(self.request(path, {**payload,"text":"另一条发言"})[0],409)

    def test_concurrent_creation_replays_and_preserves_updated_topic(self):
        """Concurrent retries create one room; later topic edits do not affect replay."""
        identifier = str(uuid.uuid4())
        payload = {"title": "幂等建房", "goal": "首次目标", "submission_id": identifier}
        before = len(self.request("/api/rooms")[1]["rooms"])
        with ThreadPoolExecutor(max_workers=5) as executor:
            results = list(executor.map(lambda _: self.request("/api/rooms", payload), range(5)))
        self.assertEqual(sorted(status for status, _ in results), [200, 200, 200, 200, 201])
        self.assertEqual(len({room["id"] for _, room in results}), 1)
        room = results[0][1]
        self.request(f"/api/rooms/{room['id']}/topic", {"actor": "用户", "title": "后来修改"})
        replay = self.request("/api/rooms", payload)
        self.assertEqual((replay[0], replay[1]["title"], replay[1]["phase"]), (200, "后来修改", "discussing"))
        self.assertEqual(self.request("/api/rooms", {**payload, "goal": "另一个目标"})[0], 409)
        self.assertEqual(len(self.request("/api/rooms")[1]["rooms"]), before + 1)
        found = self.request("/api/rooms?" + urlencode({"submission_id": identifier}))[1]["rooms"]
        self.assertEqual([item["id"] for item in found], [room["id"]])
        self.assertEqual(self.request("/api/rooms?submission_id=unknown-request")[1]["rooms"], [])
        self.assertEqual(self.request("/api/rooms?submission_id=bad")[0], 400)

    def test_conflicting_room_creations_leave_no_orphan_rooms(self):
        """A losing concurrent payload rolls back its room and topic settings."""
        identifier = str(uuid.uuid4())
        before = len(self.request("/api/rooms")[1]["rooms"])
        with ThreadPoolExecutor(max_workers=5) as executor:
            results = list(executor.map(lambda index: self.request("/api/rooms", {
                "title": f"并发请求 {index}", "submission_id": identifier,
            }), range(5)))
        self.assertEqual(sorted(status for status, _ in results), [201, 409, 409, 409, 409])
        winner = next(room for status, room in results if status == 201)
        self.assertEqual(len(self.request("/api/rooms")[1]["rooms"]), before + 1)
        found = self.request("/api/rooms?" + urlencode({"submission_id": identifier}))[1]["rooms"]
        self.assertEqual(found[0]["id"], winner["id"])

    def test_long_answer_limit_does_not_expand_summary_or_finish_rejected_turn(self):
        """Full Unicode answers are atomic; oversized answers and summaries are rejected."""
        self.configure_host()
        turn = self.schedule()[1]["turn"]
        base = f"/api/rooms/{self.room['id']}"
        payload = {"author": "Gemini", "submitted_by": "Codex", "text": "🙂" * 32001,
                   "request_ids": [turn["member_request_id"]], "submission_id": "unicode-long-answer"}
        self.assertEqual(self.request(base + "/messages", payload)[0], 400)
        self.assertEqual(self.request(base + f"/turns/{turn['id']}")[1]["status"], "open")
        payload["text"] = "🙂" * 32000
        status, result = self.request(base + "/messages", payload)
        self.assertEqual(status, 201)
        self.assertEqual(self.request(base + f"/messages/{result['message']['id']}")[1]["text"], payload["text"])
        saved_request = next(item for item in self.request(base)[1]["free"]["requests"] if item["id"] == turn["member_request_id"])
        self.assertEqual(saved_request["answer_id"], result["message"]["id"])
        self.assertEqual(self.request(base + "/state", {"actor": "Codex", "text": "摘要" * 2001})[0], 400)
        for query in ("after=-1", "after=0&page=2", "kind=unknown", "submission_id=bad"):
            self.assertEqual(self.request(base + "/messages?" + query)[0], 400)

    def test_simultaneous_cli_retries_create_one_record(self):
        """Concurrent replays cannot bypass the submission ID uniqueness rule."""
        payload = {"author": "Codex", "text": "并发重试", "submission_id": "parallel-001", "source": "cli"}
        payload.update(self.prepare_speech("Codex"))
        path = f"/api/rooms/{self.room['id']}/messages"
        with ThreadPoolExecutor(max_workers=5) as executor:
            results = list(executor.map(lambda _: self.request(path, payload), range(5)))
        self.assertEqual(sorted(status for status, _ in results), [200, 200, 200, 200, 201])
        self.assertTrue(all(result["message"]["source"] == "cli" for _, result in results))
        self.assertEqual(self.request(f"/api/rooms/{self.room['id']}")[1]["message_count"], 1)

    def test_retired_url_and_invalid_post_do_not_write(self):
        """Old publishing URLs, HEAD, and invalid POST requests cannot publish."""
        query = urlencode({"author": "Codex", "text": "不能误写", "submission_id": "head-test-001"})
        self.assertEqual(self.request(f"/r/{self.room['id']}/publish?{query}")[0], 410)
        self.assertEqual(self.request(f"/r/{self.room['id']}/publish?{query}", method="HEAD")[0], 501)
        self.assertEqual(self.request(f"/api/rooms/{self.room['id']}/messages", {
            "author": "Codex", "text": "缺少提交编号", "source": "cli",
        })[0], 400)
        self.assertEqual(self.request(f"/api/rooms/{self.room['id']}")[1]["message_count"], 0)

    def test_participation_mode_is_independent_of_model_name(self):
        """Default and unknown modes get the web guide; local AIs are pointed to the skills, not raw writes."""
        path = f"/r/{self.room['id']}"
        for suffix in ("", "?mode=online&participant=Codex", "?mode=unknown&participant=Gemini"):
            plain = self.request(path + suffix)[1]
            self.assertIn("在线 AI · 只读参与", plain)
            self.assertNotIn("POST /api/", plain)
            self.assertNotIn("/publish?", plain)
            self.assertIn("引用原文编号", plain)
            self.assertNotIn("不调用模型服务 API", plain)
        plain = self.request(path + "?mode=cli&participant=Gemini")[1]
        self.assertIn("discuss-participant", plain)
        self.assertNotIn("POST /api/", plain)
        self.assertNotIn("在线 AI · 只读参与", plain)

    def test_simultaneous_conflicting_retries_preserve_original(self):
        """One payload wins; concurrent changed payloads cannot overwrite it."""
        with ThreadPoolExecutor(max_workers=5) as executor:
            results = list(executor.map(lambda index: self.post(f"不同原文 {index}", "conflict-001"), range(5)))
        self.assertEqual(sorted(status for status, _ in results), [201, 409, 409, 409, 409])
        winner = next(result["message"] for status, result in results if status == 201)
        stored = self.request(f"/api/rooms/{self.room['id']}/messages")[1]
        self.assertEqual(stored["total"], 1)
        self.assertEqual(stored["messages"][0]["text"], winner["text"])

    def test_cross_room_references_are_rejected(self):
        """Message reads and reply references stay within their room."""
        message_id = self.post("第一间房间", "room-one-001")[1]["message"]["id"]
        other = self.request("/api/rooms", {"title": "另一间"})[1]
        self.assertEqual(self.request(f"/r/{other['id']}/messages/{message_id}")[0], 404)
        self.room = other
        self.assertEqual(self.post("错误引用", "room-two-001", message_id)[0], 400)

    def test_history_pagination_preserves_all_records(self):
        """Readers can retrieve the entire history without one unbounded response."""
        for index in range(23):
            self.post(f"历史消息 {index}", f"history-{index:03}")
        first = self.request(f"/api/rooms/{self.room['id']}/messages?page=1")[1]
        second = self.request(f"/api/rooms/{self.room['id']}/messages?page=2")[1]
        self.assertEqual((len(first["messages"]), len(second["messages"])), (20, 3))
        self.assertEqual(len({row["id"] for row in first["messages"] + second["messages"]}), 23)

    def test_state_keeps_its_snapshot_and_storage_survives_reinitialization(self):
        """Saving a summary never marks later, unseen messages as summarized."""
        first_id = self.post("初始证据", "snapshot-001")[1]["message"]["id"]
        self.post("稍后抵达的分歧", "snapshot-002")
        self.request(f"/api/rooms/{self.room['id']}/state", {"text": f"依据 #{first_id}", "until": first_id})
        if not self.external:
            init_database(self.database)
        room = self.request(f"/api/rooms/{self.room['id']}")[1]
        self.assertEqual(room["state_until"], first_id)
        self.assertEqual(room["message_count"], 2)
        self.assertGreater(room["latest_id"], room["state_until"])
        plain = self.request(f"/r/{self.room['id']}")[1]
        self.assertIn(f"整理至 #{first_id}", plain)

    def test_run_receipts_are_no_longer_written_and_the_view_has_no_receipt_list(self):
        """The receipt message kind is retired: it is refused, and the room view and state text carry no receipt references."""
        self.configure_host()
        base = f"/api/rooms/{self.room['id']}"
        self.assertNotIn("latest_receipts", self.request(base)[1])
        for author in ("Codex", "用户"):
            self.assertEqual(self.request(base + "/messages", {"author": author, "kind": "receipt", "text": "旧运行已启动", "submission_id": f"receipt-{author}"})[0], 400)
        self.assertNotIn("回执", self.request(f"/r/{self.room['id']}/state")[1])

    def test_open_requests_never_claim_execution_has_started(self):
        """Creating and reading an assignment issues a request without claiming successful delivery."""
        self.configure_host()
        base = f"/api/rooms/{self.room['id']}"
        for expert in ("Codex", "Gemini"):
            plan = self.schedule(f"label-{expert}", expert=expert)[1]["turn"]
            self.assertEqual(plan["status"], "open")
            self.assertIsNotNone(plan["member_request_id"])
            stored = self.request(base + f"/turns/{plan['id']}")[1]
            self.assertEqual(stored["status"], "open")
            request = next(item for item in self.request(base)[1]["free"]["requests"] if item["id"] == plan["member_request_id"])
            self.assertEqual(request["status"], "pending")
            self.assertIsNone(request["execution_id"])
            self.request(base + f"/turns/{plan['id']}", {"actor": "用户", "status": "cancelled"})

    def prepare_speech(self, author, kind="opinion"):
        """Arrange a session request and return the actual execution or manual request binding."""
        if author == "用户":
            return {}
        base = f"/api/rooms/{self.room['id']}"
        session = self.request(base + "/discussion")[1]["session"]
        if not session:
            self.session_action("start", goal="验证请求发言")
        room = self.request(base)[1]
        if kind != "opinion" and author == room["host"]:
            return self.reserve_member(author)
        plans = self.request(base + "/turns")[1]["turns"]
        for turn in plans:
            if turn["purpose"] == "discuss" and turn["status"] == "open":
                self.assertEqual(self.request(base + f"/turns/{turn['id']}", {"actor": "用户", "status": "cancelled"})[0], 200)
        status, result = self.schedule(str(uuid.uuid4()), expert=author)
        self.assertEqual(status, 201, result)
        member = next(item for item in room["members"] if item["name"] == author)
        if member["access"] == "manual":
            return {"request_ids": [result["turn"]["member_request_id"]]}
        return self.reserve_member(author)

    def reserve_member(self, name):
        """Reserve one member execution using the room owner's capability."""
        base = f"/api/rooms/{self.room['id']}"
        member = next(item for item in self.request(base)[1]["members"] if item["name"] == name)
        status, execution = self.request(base + "/executions", {"member_id": member["id"], "client_id": uuid.uuid4().hex})
        self.assertEqual(status, 200, execution)
        return {"execution_id": execution["id"]}

    def session_action(self, action, **values):
        """Read the current control revision before applying a discussion action."""
        base = f"/api/rooms/{self.room['id']}/discussion"
        view = self.request(base)[1]
        status, result = self.request(base, {"action": action, "revision": view["revision"], **values})
        self.assertEqual(status, 200, result)
        return result

    def test_answers_need_no_speaking_floor(self):
        """Answers bind to their issued request; ordinary messages do not finish the discussion plan."""
        self.configure_host()
        base = f"/api/rooms/{self.room['id']}"
        self.assertNotIn("floor", self.request(base)[1])
        self.assertEqual(self.request(base + "/floor")[0], 404)
        plan = self.schedule()[1]["turn"]
        answer = {"author": "Gemini", "submitted_by": "用户", "kind": "chat", "request_ids": [plan["member_request_id"]],
                  "text": "被点名者的真实回答", "submission_id": "floor-answer"}
        self.assertIn(self.request(base + "/messages", {**answer, "author": "Qwen", "submission_id": "floor-wrong"})[0], (400, 403))
        self.assertEqual(self.post("补充约束", "floor-user")[0], 201)
        host_binding = self.reserve_member("Codex")
        self.assertEqual(self.request(base + "/messages", {**host_binding, "author": "Codex", "kind": "chat", "text": "插入主持说明", "submission_id": "floor-host"})[0], 201)
        self.assertEqual(self.request(base + f"/turns/{plan['id']}")[1]["status"], "open")
        status, saved = self.request(base + "/messages", answer)
        self.assertEqual(status, 201, saved)
        self.assertIsNone(saved["message"]["turn_id"])
        self.assertEqual(self.request(base + f"/turns/{plan['id']}")[1]["status"], "answered")
        self.assertTrue(self.request(base + "/messages", answer)[1]["duplicate"])
        self.assertEqual(self.request(base + "/messages", {**answer, "text": "改过的回答"})[0], 409)
        self.assertEqual(self.request(base + "/messages", {**answer, "submission_id": "floor-late"})[0], 409)

    def test_failed_answers_leave_the_arrangement_open_and_the_host_may_cancel_it_any_time(self):
        """Invalid proxy attribution leaves the request open, and only the owner or host may cancel it."""
        self.configure_host()
        base = f"/api/rooms/{self.room['id']}"
        plan = self.schedule("floor-attribution")[1]["turn"]
        bad = {"author": "Gemini", "submitted_by": "Claude", "text": "错误代发", "request_ids": [plan["member_request_id"]], "submission_id": "floor-bad-proxy"}
        self.assertEqual(self.request(base + "/messages", bad)[0], 403)
        self.assertEqual(self.request(base + f"/turns/{plan['id']}")[1]["status"], "open")
        self.assertEqual(self.request(base + f"/turns/{plan['id']}", {"actor": "Codex", "status": "cancelled"})[0], 200)
        self.assertEqual(self.request(base + f"/turns/{plan['id']}")[1]["status"], "cancelled")
        self.assertEqual(self.schedule("floor-after-cancel")[0], 201)

    def configure_host(self, start=True, experts=None):
        """Create a free room with an automatic host and explicit participant capabilities."""
        status, self.room = self.request("/api/rooms", {"title": "讨论请求回归", "host": "Codex",
            "experts": experts or {"Codex": "cli", "Gemini": "online"}})
        self.assertEqual(status, 201, self.room)
        if start:
            self.session_action("start", goal="保持完整记录")
        return self.request(f"/api/rooms/{self.room['id']}")[1]

    def test_topic_details_save_in_free_active_and_paused_rooms_without_mutating_session_controls(self):
        """Owner topic edits retain discussion controls and reject legacy phase/limit mutations."""
        self.configure_host(start=False)
        base = f"/api/rooms/{self.room['id']}"
        status, saved = self.request(base + "/topic", {"actor": "用户", "title": "自由协作资料", "background": "自由背景"})
        self.assertEqual(status, 200, saved)
        self.assertEqual((saved["title"], saved["background"]), ("自由协作资料", "自由背景"))
        self.assertEqual(self.request(base + "/topic", {"actor": "用户", "phase": "paused"})[0], 400)
        self.session_action("start", goal="保持完整记录", limits={"max_rounds": 3, "max_minutes": 0})
        for state in ("active", "paused"):
            if state == "paused":
                self.session_action("pause")
            before = self.request(base)[1]
            status, saved = self.request(base + "/topic", {"actor": "用户", "title": f"{state}资料", "background": "只更新背景"})
            self.assertEqual(status, 200, saved)
            self.assertEqual((saved["title"], saved["background"]), (f"{state}资料", "只更新背景"))
            self.assertEqual((saved["session"]["id"], saved["session"]["status"]), (before["session"]["id"], state))
            self.assertEqual(saved["limits"]["max_rounds"], 3)
            self.assertEqual(saved["phase"], before["phase"])
            for change in ({"phase": "discussing"}, {"limits": {"max_rounds": 7}}, {"host": "用户"}, {"experts": {"Codex": "cli"}}):
                self.assertEqual(self.request(base + "/topic", {"actor": "用户", **change})[0], 400, change)

    def schedule(self, submission_id="schedule-001", **changes):
        """Read the session roster and submit the host's versioned plan."""
        base = f"/api/rooms/{self.room['id']}"
        roster = self.request(base + "/turns/roster")[1]
        payload = {"actor": "Codex", "expert": "Gemini", "question": "请检查尚未解决的分歧", "submission_id": submission_id}
        return self.request(base + "/turns", {**payload, "roster": roster.get("revision"), **changes})

    def test_user_request_is_preserved_separately_through_writes_and_backup(self):
        """Keep original whitespace, enforce bounds, and include it in replay checks."""
        original = "  用户原文🙂\n保留换行与空白  \n"
        payload = {"title": "原文与背景", "user_request": original, "background": "项目补充背景",
                   "submission_id": str(uuid.uuid4())}
        status, room = self.request("/api/rooms", payload)
        self.assertEqual(status, 201)
        self.assertEqual((room["user_request"], room["background"]), (original, "项目补充背景"))
        base = f"/api/rooms/{room['id']}"
        self.assertTrue(self.request("/api/rooms", payload)[1]["duplicate"])
        self.assertEqual(self.request("/api/rooms", {**payload, "user_request": "另一请求"})[0], 409)
        self.assertEqual(self.request(base + "/topic", {"actor": "用户", "background": "更新背景"})[1]["user_request"], original)
        text = self.request(f"/r/{room['id']}/brief")[1]
        self.assertIn(f"用户原文：\n{original}\n\n背景：\n更新背景", text)
        self.assertNotIn(original, self.request(f"/r/{room['id']}")[1])
        tables = self.request(base + "/backup")[1]["tables"]
        self.assertEqual(tables["room_user_requests"], [{"room_id": room["id"], "text": original}])
        self.assertEqual(self.request(base + "/topic", {"actor": "用户", "user_request": "🙂" * 4000})[0], 200)
        self.assertEqual(self.request(base + "/topic", {"actor": "用户", "user_request": "🙂" * 4001})[0], 400)
        self.assertEqual(self.request(base)[1]["user_request"], "🙂" * 4000)
        cleared = self.request(base + "/topic", {"actor": "用户", "user_request": ""})[1]
        self.assertEqual((cleared["user_request"], cleared["background"]), ("", "更新背景"))
        self.assertEqual(self.request(base + "/delete", {"actor": "用户", "confirm_title": room["title"]})[0], 200)

    def test_legacy_user_request_has_read_only_compatibility_until_saved(self):
        """Split only explicit legacy sections and preserve unmarked backgrounds."""
        if self.external:
            self.skipTest("Legacy storage setup is local to SQLite")
        room_id = self.room["id"]
        background = "用户原文：\n原始要求\n第二行\n\n项目背景与入口：\n补充材料"
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute("DELETE FROM room_user_requests WHERE room_id=?", (room_id,))
            connection.execute("UPDATE topic_settings SET background=? WHERE room_id=?", (background, room_id))
        init_database(self.database, seed=False)
        base = f"/api/rooms/{room_id}"
        room = self.request(base)[1]
        self.assertEqual((room["user_request"], room["background"]), ("原始要求\n第二行", "项目背景与入口：\n补充材料"))
        with closing(sqlite3.connect(self.database)) as connection, connection:
            self.assertEqual(connection.execute("SELECT background FROM topic_settings WHERE room_id=?", (room_id,)).fetchone()[0], background)
            self.assertIsNone(connection.execute("SELECT text FROM room_user_requests WHERE room_id=?", (room_id,)).fetchone())
        saved = self.request(base + "/topic", {"actor": "用户", "goal": "更新目标"})[1]
        self.assertEqual(saved["user_request"], room["user_request"])
        with closing(sqlite3.connect(self.database)) as connection, connection:
            self.assertEqual(connection.execute("SELECT text FROM room_user_requests WHERE room_id=?", (room_id,)).fetchone()[0], room["user_request"])
        plain = "用户原文：\n没有明确背景分隔的整段文字\n背景：\n仍属于原文"
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute("DELETE FROM room_user_requests WHERE room_id=?", (room_id,))
            connection.execute("UPDATE topic_settings SET background=? WHERE room_id=?", (plain, room_id))
        self.assertEqual((self.request(base)[1]["user_request"], self.request(base)[1]["background"]), ("", plain))

    def test_topic_host_requires_write_capability_and_preserves_metadata(self):
        """Topic hosting is a role independent of the model name."""
        path = f"/api/rooms/{self.room['id']}/topic"
        self.assertEqual(self.request(path, {"actor": "用户", "host": "Gemini"})[0], 400)
        room = self.configure_host()
        path = f"/api/rooms/{self.room['id']}/topic"
        self.assertEqual(room["host"], "Codex")
        self.assertEqual(room["experts"]["Codex"], "cli")
        self.assertEqual(self.request(path, {"actor": "Gemini", "focus": "错误操作"})[0], 403)
        updated = self.request(path, {"actor": "Codex", "background": "问题背景", "boundaries": "不更换产品", "focus": "成本分歧"})[1]
        self.assertEqual((updated["background"], updated["boundaries"], updated["focus"]), ("问题背景", "不更换产品", "成本分歧"))
        status, created = self.request("/api/rooms", {"title": "主持人创建", "host": "Gemini", "experts": {"Gemini": "cli"}})
        self.assertEqual(status, 201)
        self.assertEqual(created["host"], "Gemini")

    def test_overview_discloses_context_only_through_explicit_pages(self):
        """Entry pages never inline background, state text, or mentioned messages."""
        self.configure_host()
        self.request(f"/api/rooms/{self.room['id']}/topic", {"actor": "Codex", "background": "BACKGROUND_ONLY", "boundaries": "BOUNDARIES_ONLY"})
        self.post("@Gemini MESSAGE_ONLY", "progressive-001")
        self.request(f"/api/rooms/{self.room['id']}/state", {"actor": "Codex", "text": "STATE_ONLY"})
        base = f"/r/{self.room['id']}"
        for mode in ("online", "cli"):
            overview = self.request(base + f"?mode={mode}&participant=Gemini")[1]
            for marker in ("BACKGROUND_ONLY", "BOUNDARIES_ONLY", "STATE_ONLY", "MESSAGE_ONLY"):
                self.assertNotIn(marker, overview)
            for route in ("/brief", "/state", "/search?mention=Gemini", "/messages?page=1"):
                self.assertIn(route, overview)
        self.assertIn("BACKGROUND_ONLY", self.request(base + "/brief")[1])
        self.assertIn("STATE_ONLY", self.request(base + "/state")[1])
        self.assertIn("MESSAGE_ONLY", self.request(base + "/search?mention=Gemini")[1])
        protocol = self.request(base + "/protocol")[1]
        self.assertIn("当前主持人：Codex", protocol)
        self.assertIn("--kind chat --execution", protocol)

    def test_host_speech_and_forwarded_authorship_remain_distinct(self):
        """The host's own answer and a web member's relayed answer preserve different authors and sources."""
        self.configure_host()
        path = f"/api/rooms/{self.room['id']}/messages"
        payload = {"author": "Codex", "text": "个人观点", "source": "cli", "kind": "chat", "submission_id": "host-opinion-001"}
        payload.update(self.prepare_speech("Codex"))
        opinion = self.request(path, payload)[1]["message"]
        self.assertEqual((opinion["kind"], opinion["source"], opinion["submitted_by"]), ("chat", "cli", "Codex"))
        binding = self.prepare_speech("Codex", "moderation")
        moderation = self.request(path, {**binding, "author": "Codex", "text": "请回到议题", "kind": "chat", "submission_id": "host-control-001"})[1]["message"]
        self.assertEqual(moderation["author"], "Codex")
        forwarded = {"author": "Gemini", "submitted_by": "Codex", "text": "在线专家原文 & 引用", "reply_to": opinion["id"], "submission_id": "host-forward-001"}
        forwarded.update(self.prepare_speech("Gemini"))
        status, result = self.request(path, forwarded)
        self.assertEqual(status, 201, result)
        message = result["message"]
        self.assertEqual((message["author"], message["submitted_by"], message["source"]), ("Gemini", "Codex", "host_proxy"))
        self.assertEqual(self.request(path, {**forwarded, "submitted_by": "Claude", "submission_id": "bad-forward-001"})[0], 403)
        self.assertEqual(self.request(path, {**forwarded, "submitted_by": "Gemini", "source": "cli", "submission_id": "bad-online-001"})[0], 403)
        self.assertEqual(self.request(path, {**forwarded, "kind": "moderation", "submission_id": "bad-role-001"})[0], 400)
        original = self.request(f"/r/{self.room['id']}/messages/{message['id']}")[1]
        self.assertIn("提交者：Codex", original)
        self.assertIn("在线专家原文 & 引用", original)

    def test_session_rounds_count_answer_volume_and_ignore_other_requests(self):
        """Only discuss answers consume the non-host expert budget, including repeated speakers."""
        self.configure_host(experts={"Codex":"cli", "Gemini":"online", "DeepSeek":"online"})
        base=f"/api/rooms/{self.room['id']}"
        binding=self.reserve_member("Codex")
        self.assertEqual(self.request(base+"/messages",{**binding,"author":"Codex","text":"主持说明","submission_id":"round-host-note"})[0],201)
        self.post("不计轮次的用户消息","round-user-note")
        for index in range(2):
            binding=self.prepare_speech("Gemini")
            self.assertEqual(self.request(base+"/messages",{**binding,"author":"Gemini","text":"同一专家的回答","submission_id":f"round-volume-{index}"})[0],201)
            self.assertEqual(self.request(base)[1]["limits"]["completed_rounds"],(index+1)//2)
        self.assertEqual(self.request(base+"/discussion")[1]["session"]["answered"],2)
        self.assertEqual(self.request(base)[1]["message_count"],4)

    def test_session_progress_survives_pagination_and_filters(self):
        """Progress comes from the session's complete requests, independently of message list filters."""
        self.configure_host()
        base=f"/api/rooms/{self.room['id']}"
        messages=[]
        for index in range(23):
            binding=self.prepare_speech("Gemini")
            status,saved=self.request(base+"/messages",{**binding,"author":"Gemini","text":f"分页回答 {index}","submission_id":f"round-page-{index:03d}"})
            self.assertEqual(status,201,saved)
            messages.append(saved["message"])
        for query in ("page=1","page=2","author=Gemini","kind=chat","q=no-matching-round-record"):
            self.assertEqual(self.request(base+"/messages?"+query)[0],200)
            self.assertEqual(self.request(base)[1]["limits"]["completed_rounds"],23)
        self.assertEqual(self.request(base+"/messages?page=2")[1]["messages"][0]["id"],messages[20]["id"])
        self.assertEqual(self.request(base)[1]["message_count"],23)

    def test_host_conclusion_requires_current_state_and_keeps_the_room_writable(self):
        """A host concludes with the latest snapshot while its task is stopped and history remains."""
        self.configure_host()
        base = f"/api/rooms/{self.room['id']}"
        execution = self.reserve_member("Codex")["execution_id"]
        self.assertEqual(self.request(base + "/limits", {"actor": "Codex", "action": "done"})[0], 400)
        stale = self.request(base + "/conclusion")[1]["revision"]
        self.post("补充结论要求", "conclude-extra-requirement")
        self.assertEqual(self.request(base + "/limits", {"actor": "Codex", "action": "done", "conclusion": stale})[0], 409)
        self.assertEqual(self.request(base + "/state", {"actor": "Codex", "text": "最终共识"})[0], 200)
        conclusion = self.request(base + "/conclusion")[1]
        status, result = self.request(base + "/limits", {"actor": "Codex", "action": "done", "conclusion": conclusion["revision"]})
        self.assertEqual(status, 200, result)
        room = self.request(base)[1]
        self.assertEqual(room["mode"], "free")
        self.assertEqual(room["session"]["status"], "concluded")
        self.assertEqual(room["discussions"][-1]["stop_reason"], "goal_done")
        self.assertEqual(next(item for item in room["free"]["executions"] if item["id"] == execution)["status"], "cancelled")
        self.assertEqual(self.post("讨论结束后继续协作", "conclude-followup")[0], 201)
        self.assertEqual(self.request(base + "/limits", {"actor": "用户", "action": "reopen"})[0], 400)
        self.assertEqual(self.session_action("start", goal="再次讨论")["session"]["status"], "active")

    def test_session_request_answer_and_retry_lifecycle(self):
        """Reading never claims delivery; one bound answer completes its plan and exact retries remain safe."""
        self.configure_host()
        status, created = self.schedule()
        self.assertEqual(status, 201, created)
        plan = created["turn"]
        base = f"/api/rooms/{self.room['id']}"
        path = base + f"/turns/{plan['id']}"
        self.assertEqual(plan["status"], "open")
        self.assertTrue(self.schedule()[1]["duplicate"])
        self.assertEqual(self.schedule(question="另一问题")[0], 409)
        self.assertEqual(self.request(path)[1]["status"], "open")
        self.assertEqual(self.request(path, {"actor": "Codex", "status": "notified"})[0], 400)
        payload = {"author": "Gemini", "submitted_by": "Codex", "text": "专家的回答", "request_ids": [plan["member_request_id"]], "submission_id": "turn-answer-001"}
        status, result = self.request(base + "/messages", payload)
        self.assertEqual(status, 201, result)
        self.assertEqual(self.request(path)[1]["status"], "answered")
        member_request = next(item for item in self.request(base)[1]["free"]["requests"] if item["id"] == plan["member_request_id"])
        self.assertEqual(member_request["answer_id"], result["message"]["id"])
        self.assertTrue(self.request(base + "/messages", payload)[1]["duplicate"])
        self.assertEqual(self.schedule("schedule-next-001")[0], 201)

    def test_turn_cancellation_phase_and_cross_room_constraints(self):
        """Cancelled requests reject late answers and remain isolated from other rooms."""
        self.configure_host()
        plan = self.schedule()[1]["turn"]
        base = f"/api/rooms/{self.room['id']}"
        self.assertEqual(self.request(base + "/topic", {"actor": "用户", "phase": "concluded"})[0], 400)
        other = self.request("/api/rooms", {"title": "另一个话题"})[1]
        self.assertEqual(self.request(f"/api/rooms/{other['id']}/turns/{plan['id']}")[0], 404)
        wrong = {"author": "Codex", "source": "cli", "text": "错误专家", "request_ids": [plan["member_request_id"]], "submission_id": "wrong-expert-001"}
        self.assertEqual(self.request(base + "/messages", wrong)[0], 400)
        self.request(base + f"/turns/{plan['id']}", {"actor": "用户", "status": "cancelled"})
        late = {"author": "Gemini", "text": "迟到回答", "request_ids": [plan["member_request_id"]], "submission_id": "late-answer-001"}
        self.assertEqual(self.request(base + "/messages", late)[0], 409)
        self.session_action("end")
        self.assertIn(self.schedule("closed-topic-001")[0], (400,409))

    def test_independent_pause_and_resume_lifecycle(self):
        """Pause cancels old work, resume requires a fresh plan, and conclusion leaves ordinary collaboration available."""
        self.configure_host()
        base = f"/api/rooms/{self.room['id']}"
        self.assertEqual(self.request(base + "/discussion")[1]["session"]["phase"], "initial")
        plan = self.schedule()[1]["turn"]
        answer = {"author": "Gemini", "text": "独立结论及依据", "request_ids": [plan["member_request_id"]], "submission_id": "initial-answer-001"}
        self.session_action("pause")
        self.assertEqual(self.request(base + "/messages", answer)[0], 409)
        self.assertEqual(self.schedule("paused-turn-001")[0], 400)
        self.assertEqual(self.request(base + f"/turns/{plan['id']}")[1]["status"], "cancelled")
        self.assertEqual(self.request(base + "/messages", {"author": "Gemini", "kind": "receipt", "text": "旧回执", "submission_id": "stop-receipt-001"})[0], 400)
        self.session_action("resume")
        answer.update(self.prepare_speech("Gemini"))
        self.assertEqual(self.request(base + "/messages", answer)[0], 201)
        self.assertEqual(self.request(base + "/discussion")[1]["session"]["phase"], "discussing")
        self.assertEqual(self.request(base + "/topic", {"actor": "Codex", "phase": "reviewing"})[0], 400)
        self.session_action("end")
        self.assertTrue(self.request(base + "/messages", answer)[1]["duplicate"])
        ordinary = {"author": "Gemini", "text": "自由协作原文", "submission_id": "late-chat-001"}
        status, saved = self.request(base + "/messages", ordinary)
        self.assertEqual((status, saved["message"]["kind"]), (201, "chat"))

    def test_concurrent_scheduling_accepts_only_one_plan_for_a_roster_revision(self):
        """Parallel host actions sharing a revision cannot both apply different plans."""
        self.configure_host()
        base=f"/api/rooms/{self.room['id']}"
        revision=self.request(base+"/turns/roster")[1]["revision"]
        def schedule(index):
            return self.request(base+"/turns",{"actor":"Codex","expert":"Gemini","question":"并发安排","submission_id":f"schedule-race-{index}","roster":revision})
        with ThreadPoolExecutor(max_workers=5) as executor:
            results=list(executor.map(schedule,range(5)))
        self.assertEqual(sorted(status for status,_ in results),[201,409,409,409,409])
        plans=[plan for plan in self.request(base+"/turns")[1]["turns"] if plan["purpose"]=="discuss"]
        self.assertEqual(len(plans),1)
        self.assertEqual(plans[0]["status"],"open")

    def test_concurrent_answers_preserve_one_attributed_original(self):
        """One assignment accepts only one answer even with different submissions."""
        self.configure_host()
        turn = self.schedule()[1]["turn"]
        payload = {"author": "Gemini", "submitted_by": "Codex", "text": "并发回答", "request_ids": [turn["member_request_id"]]}
        path = f"/api/rooms/{self.room['id']}/messages"
        with ThreadPoolExecutor(max_workers=5) as executor:
            results = list(executor.map(lambda index: self.request(path, {**payload, "submission_id": f"answer-race-{index}"}), range(5)))
        self.assertEqual(sorted(status for status, _ in results), [201, 409, 409, 409, 409])
        self.assertEqual(self.request(f"/api/rooms/{self.room['id']}")[1]["message_count"], 1)

    def test_cancellation_racing_an_answer_keeps_consistent_state(self):
        """The request ends once: cancellation and a linked answer cannot both change it."""
        self.configure_host()
        plan=self.schedule()[1]["turn"]
        base=f"/api/rooms/{self.room['id']}"
        barrier=threading.Barrier(2)
        def cancel_or_answer(cancel):
            barrier.wait()
            if cancel:
                return self.request(base+f"/turns/{plan['id']}",{"actor":"用户","status":"cancelled"})
            return self.request(base+"/messages",{"author":"Gemini","text":"正在提交的回答","submitted_by":"Codex","request_ids":[plan["member_request_id"]],"submission_id":"cancel-race-001"})
        with ThreadPoolExecutor(max_workers=2) as executor:
            results=list(executor.map(cancel_or_answer,[True,False]))
        stored=self.request(base+f"/turns/{plan['id']}")[1]
        if stored["status"]=="cancelled":
            self.assertEqual([status for status,_ in results],[200,409])
            self.assertEqual(self.request(base)[1]["message_count"],0)
        else:
            self.assertEqual(stored["status"],"answered")
            self.assertIn(results[0][0],(200,409))
            self.assertEqual(results[1][0],201)
            self.assertEqual(self.request(base)[1]["message_count"],1)


class LegacyStorageTests(unittest.TestCase):
    """Verify additive migration from the actual pre-host schema."""

    def legacy_fixture(self):
        """Create isolated storage for direct, read-only history fixtures."""
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        database = Path(directory.name) / "history.sqlite3"
        init_database(database, seed=False)
        connection = connect_db(database)
        self.addCleanup(connection.close)
        room = create_room(connection, {"title": "历史讨论", "host": "Codex", "members": [
            {"name": "Codex", "access": "runner", "token": uuid.uuid4().hex},
            {"name": "Gemini", "access": "online", "token": uuid.uuid4().hex}]}, uuid.uuid4().hex)
        connection.execute("INSERT INTO round_budgets(room_id,base,cap,extra) VALUES (?,0,0,0)", (room["id"],))
        connection.commit()
        return connection, room

    def seed_legacy_messages(self, connection, room, records):
        """Insert an old transcript directly, without calling retired write endpoints."""
        messages = []
        for index, (author, kind) in enumerate(records):
            turn_id = None
            if author != "用户" and kind == "opinion":
                turn_id = connection.execute("""INSERT INTO discussion_turns
                    (room_id,expert,question,status,submission_id,created_at) VALUES (?,?,?,'pending',?,'test')""",
                    (room["id"], author, "历史问题", f"history-turn-{index}")).lastrowid
            message_id = connection.execute("""INSERT INTO messages
                (room_id,author,text,source,submission_id,created_at) VALUES (?,?,?,?,?,'test')""",
                (room["id"], author, f"历史原文 {index}", "host_proxy" if author == "Gemini" else "cli", f"history-message-{index}")).lastrowid
            connection.execute("INSERT INTO message_details(message_id,kind,submitted_by,turn_id) VALUES(?,?,?,?)",
                               (message_id, kind, "Codex" if author == "Gemini" else author, turn_id))
            if turn_id:
                connection.execute("UPDATE discussion_turns SET status='answered',answer_id=? WHERE id=?", (message_id, turn_id))
            messages.append(get_message(connection, room["id"], message_id))
        connection.execute("""INSERT INTO discussion_sessions
            (room_id,goal,status,started_message_id,ended_message_id,created_at) VALUES (?,'旧讨论','concluded',0,?,'test')""",
            (room["id"], messages[-1]["id"]))
        connection.commit()
        return messages

    def test_legacy_round_boundaries_and_backup_links_remain_readable(self):
        """Historical roster rounds, budget groups, proxy authors and turn links survive filtering and import."""
        from backend.room_import import import_room
        from backend.server import query_messages, room_backup
        connection, room = self.legacy_fixture()
        records = [("Codex", "opinion")] * 18 + [("Gemini", "opinion"),
            ("用户", "moderation"), ("Codex", "opinion"), ("Gemini", "opinion"), ("用户", "moderation")]
        messages = self.seed_legacy_messages(connection, room, records)
        expected = [{"number": 1, "start_id": messages[0]["id"], "speakers": ["Codex", "Gemini"], "completed": True},
                    {"number": 2, "start_id": messages[19]["id"], "speakers": ["Codex", "Gemini"], "completed": True}]
        for params in ({"page": 1}, {"page": 2}, {"author": "Gemini"}, {"q": "missing"}):
            query_messages(connection, room["id"], params)
            self.assertEqual(require_room(connection, room["id"])["rounds"], expected)
        stored = require_room(connection, room["id"])
        self.assertEqual(stored["completed_rounds"], 2)
        self.assertEqual([item["completed"] for item in stored["round_groups"]], [True] * 10 + [False])
        connection.execute("UPDATE room_modes SET mode='brainstorm' WHERE room_id=?", (room["id"],))
        connection.commit()
        snapshot = room_backup(connection, room["id"])
        self.assertEqual(connection.execute("SELECT mode FROM room_modes WHERE room_id=?", (room["id"],)).fetchone()[0], "brainstorm")
        old_answer = messages[21]
        old_turn = next(row for row in snapshot["tables"]["discussion_turns"] if row["id"] == old_answer["turn_id"])
        self.assertEqual(old_turn["answer_id"], old_answer["id"])
        backup = json.loads(json.dumps(snapshot).replace(room["id"], "legacyimport"))
        backup["version"] = 1
        for table in ("discussion_sessions", "discussion_conclusions", "session_requests", "task_message_sources",
                      "session_state", "session_limits", "session_round_budgets", "session_options", "session_pauses"):
            backup["tables"].pop(table)
        import_room(connection, backup, uuid.uuid4().hex, int(time.time()))
        connection.commit()
        self.assertEqual(connection.execute("SELECT mode FROM room_modes WHERE room_id='legacyimport'").fetchone()[0], "free")
        imported = query_messages(connection, "legacyimport", {"page": 2})["messages"][1]
        linked = connection.execute("SELECT answer_id FROM discussion_turns WHERE id=?", (imported["turn_id"],)).fetchone()
        self.assertEqual((imported["submitted_by"], linked[0]), ("Codex", imported["id"]))
        self.assertGreater(imported["id"], old_answer["id"])
        self.assertEqual(connection.execute("PRAGMA foreign_key_check").fetchall(), [])

    def test_a_database_with_the_retired_floor_keeps_its_data_and_loses_the_floor_rules(self):
        """Old floor rows stay untouched, and an old trigger can no longer block an answer."""
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "floor-migration.sqlite3"
            schema = (Path(__file__).resolve().parent.parent / "backend" / "schema.sql").read_text(encoding="utf-8")
            with closing(sqlite3.connect(database)) as connection, connection:
                connection.executescript(schema)
                connection.execute("INSERT INTO rooms(id,title,goal,created_at) VALUES ('old','旧房间','保留历史','test')")
                connection.execute("INSERT INTO topic_settings(room_id,host,experts) VALUES ('old','Codex',?)", ('{"Codex":"cli","Gemini":"online"}',))
                connection.execute("INSERT INTO room_floor(room_id,holder,next_speaker,revision) VALUES ('old','Codex','Gemini',3) ON CONFLICT(room_id) DO UPDATE SET revision=3")
                connection.execute("INSERT INTO discussion_turns(room_id,expert,question,submission_id,created_at) VALUES ('old','Gemini','原问题','old-turn','test')")
                connection.execute("CREATE TRIGGER runtime_generation AFTER UPDATE OF status ON discussion_runtime BEGIN SELECT 1; END")
                connection.execute("CREATE TRIGGER relay_plan_concluded AFTER UPDATE OF phase ON topic_settings BEGIN SELECT 1; END")
                connection.execute("CREATE TRIGGER session_follows_phase AFTER UPDATE OF phase ON topic_settings BEGIN SELECT 1; END")
                connection.execute("CREATE TRIGGER conclusion_snapshot AFTER UPDATE OF phase ON topic_settings BEGIN SELECT 1; END")
                connection.execute("CREATE TRIGGER limits_phase_started AFTER UPDATE OF phase ON topic_settings BEGIN SELECT 1; END")
                connection.execute("""CREATE TRIGGER require_message_floor BEFORE INSERT ON messages WHEN NEW.author<>'用户'
                    BEGIN SELECT RAISE(ABORT, 'floor_required'); END""")
            init_database(database, seed=False)
            with closing(sqlite3.connect(database)) as connection, connection:
                connection.row_factory = sqlite3.Row
                room = require_room(connection, "old")
                self.assertNotIn("floor", room)
                self.assertEqual(room["current_turn"]["question"], "原问题")
                self.assertEqual(connection.execute("SELECT revision FROM room_floor WHERE room_id='old'").fetchone()[0], 3)
                names = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='trigger'")}
                self.assertFalse({"require_message_floor", "return_message_floor", "require_host_floor", "nominate_expert_floor", "cancel_turn_floor"} & names)
                self.assertFalse({"runtime_generation", "relay_plan_concluded", "session_follows_phase",
                                  "conclusion_snapshot", "limits_phase_started"} & names)

    def test_session_guards_reject_stale_controls_and_two_open_discuss_requests(self):
        """The new state machine validates the read revision and database-level single-open invariant."""
        from backend.session_room import create_plan, discussion_action, roster_view, session_room
        with tempfile.TemporaryDirectory() as directory:
            database=Path(directory)/"session-guards.sqlite3"
            init_database(database,seed=False)
            with closing(connect_db(database)) as connection,connection:
                owner=uuid.uuid4().hex
                room=create_room(connection,{"title":"并发会话校验","host":"Codex","members":[
                    {"name":"Codex","access":"runner","token":uuid.uuid4().hex},
                    {"name":"Gemini","access":"runner","token":uuid.uuid4().hex}]},owner)
                initial=session_room(connection,room["id"])
                discussion_action(connection,room["id"],owner,{"action":"start","revision":initial["revision"],"goal":"守住事务"},room)
                roster=roster_view(connection,room["id"])
                payload={"actor":"Codex","expert":"Gemini","question":"问题","roster":roster["revision"],"submission_id":"guard-plan-001"}
                plan=create_plan(connection,room["id"],payload,room)["turn"]
                connection.commit()
                with self.assertRaises(FileExistsError),connection:
                    create_plan(connection,room["id"],{**payload,"submission_id":"guard-plan-002"},room)
                with self.assertRaises(sqlite3.IntegrityError),connection:
                    connection.execute("INSERT INTO session_requests(session_id,round,position,member_id,purpose,question,status,submission_id,created_at) VALUES(?,1,2,?,'discuss','重复open','open','guard-duplicate','test')",(plan["session_id"],plan["member_id"]))
                self.assertEqual(connection.execute("SELECT COUNT(*) FROM session_requests WHERE purpose='discuss' AND status='open'").fetchone()[0],1)
                current=session_room(connection,room["id"])
                discussion_action(connection,room["id"],owner,{"action":"pause","revision":current["revision"]},room)
                connection.commit()
                with self.assertRaises(ValueError),connection:
                    create_plan(connection,room["id"],{**payload,"submission_id":"paused-plan-001","roster":roster_view(connection,room["id"])["revision"]},room)

    def test_legacy_database_and_url_history_survive_reinitialization(self):
        """Schema upgrades preserve old room and message content verbatim."""
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "legacy.sqlite3"
            with closing(sqlite3.connect(database)) as connection, connection:
                connection.executescript("""
                    CREATE TABLE rooms (id TEXT PRIMARY KEY,title TEXT NOT NULL,goal TEXT NOT NULL,
                        state_text TEXT NOT NULL DEFAULT '',state_until INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
                    CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT,room_id TEXT NOT NULL,
                        author TEXT NOT NULL,text TEXT NOT NULL,reply_to INTEGER,source TEXT NOT NULL,
                        submission_id TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(room_id,submission_id));
                    INSERT INTO rooms VALUES ('legacy','历史话题','保留原文','旧状态',1,'2026-10-14');
                    INSERT INTO messages VALUES (1,'legacy','Gemini','历史 URL 原文 & 中文',NULL,'url','legacy-001','2026-10-14');
                """)
            init_database(database)
            init_database(database)
            with closing(sqlite3.connect(database)) as connection:
                connection.row_factory = sqlite3.Row
                room = require_room(connection, "legacy")
                message = get_message(connection, "legacy", 1)
                self.assertEqual((room["host"], room["message_count"], room["state_text"]), ("用户", 1, "旧状态"))
                self.assertEqual((message["source"], message["text"]), ("url", "历史 URL 原文 & 中文"))
                self.assertEqual((message["summary"], message["summary_by"]), ("", ""))
                self.assertIsNone(room["host_brief"])


if __name__ == "__main__":
    unittest.main(verbosity=2)

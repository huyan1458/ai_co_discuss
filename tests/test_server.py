"""Test CLI writes, read-only online instructions, and context provenance."""

import hashlib
import io
import json
import mimetypes
import os
import sqlite3
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import uuid
import zipfile
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlencode, urlsplit
from urllib.request import Request, urlopen

from backend.server import DiscussionServer, attachment_path, connect_db, create_room, expired_rooms, image_size, init_database, require_room, sweep_attachments
from backend.texts import Text, incoming_text, load_texts, save_text


# shutdown() waits for the server loop to notice; the default 0.5 s poll made every test end half a second late.
SERVER_POLL_SECONDS = 0.02


def png_header(width, height):
    """The signature and IHDR chunk of a PNG of this size; nothing after it is read."""
    return b"\x89PNG\r\n\x1a\n" + struct.pack(">I", 13) + b"IHDR" + struct.pack(">II", width, height) + bytes(9)


def jpeg_header(width, height, exif=b""):
    """A JPEG start, a JFIF segment, an optional EXIF segment and a baseline frame header of this size."""
    app1 = b"\xff\xe1" + struct.pack(">H", len(exif) + 2) + exif if exif else b""
    return (b"\xff\xd8\xff\xe0" + struct.pack(">H", 16) + b"JFIF\x00" + bytes(9) + app1
            + b"\xff\xc0" + struct.pack(">HBHHB", 11, 8, height, width, 1) + bytes(3) + b"\xff\xd9")

class DiscussionTests(unittest.TestCase):
    """Verify the observable POC workflow using isolated SQLite databases."""

    def setUp(self):
        """Use an explicit test Worker URL, or start isolated local storage."""
        self.owner = uuid.uuid4().hex
        self.member_tokens = {name: uuid.uuid4().hex for name in ("Codex", "Claude", "Antigravity", "DeepSeek", "Qwen")}
        # Members the local service wakes; the others answer as registered manual members.
        self.runner_members = {"Codex"}
        self.base = os.getenv("DISCUSS_TEST_URL", "").rstrip("/")
        self.external = bool(self.base)
        if not self.external:
            self.directory = tempfile.TemporaryDirectory()
            self.database = Path(self.directory.name) / "test.sqlite3"
            init_database(self.database, seed=False)
            self.server = DiscussionServer(("127.0.0.1", 0), self.database)
            self.server.local_site = False  # these tests exercise room credential rules, not the account-free local site
            self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": SERVER_POLL_SECONDS}, daemon=True)
            self.thread.start()
            self.base = f"http://127.0.0.1:{self.server.server_port}"
        self.room = self.request("/api/rooms", {"title": "测试议题", "goal": "保持完整记录"})[1]

    def test_reading_pages_and_retired_publish_follow_accept_language(self):
        """Fixed reader labels localize while an author's original message stays intact."""
        original = "用户原文保持中文 Original text"
        message = self.post(original, "language-reader")[1]["message"]
        for language, label, error in (("zh-CN", "职责", "URL 发布入口"), ("en-US", "Role", "URL publishing")):
            for suffix, status, expected in ((f"messages/{message['id']}", 200, label), ("publish", 410, error)):
                with self.subTest(language=language, route=suffix):
                    request = Request(f"{self.base}/r/{self.room['id']}/{suffix}", headers={
                        "Accept-Language": language, "X-Discussion-Token": self.owner})
                    try:
                        response = urlopen(request, timeout=5)
                    except HTTPError as failure:
                        response = failure
                    with response:
                        self.assertEqual(response.status, status)
                        self.assertIn("text/plain", response.headers["Content-Type"])
                        body = response.read().decode("utf-8")
                    self.assertIn(expected, body)
                    if status == 200:
                        self.assertIn(original, body)
        self.assertIn("职责", self.request(f"/r/{self.room['id']}/messages/{message['id']}")[1])
        for language, expected in (("zh-CN", "房间不存在"), ("en-US", "Room not found")):
            with self.subTest(language=language, route="missing room"), self.assertRaises(HTTPError) as caught:
                urlopen(Request(f"{self.base}/r/missing-room", headers={"Accept-Language": language}), timeout=5)
            with caught.exception as response:
                self.assertEqual(response.status, 404)
                self.assertEqual(response.read().decode("utf-8"), expected)

    def test_seed_templates_and_custom_default_labels_preserve_originals(self):
        """Only marked sample content and an unchanged default nickname receive display templates."""
        from backend.identity import default_label, default_label_text
        from backend.server import read_text, list_rooms
        database = Path(self.directory.name) / "seed-translations.sqlite3"
        init_database(database)
        with closing(connect_db(database)) as connection, connection:
            room = require_room(connection, "welcome")
            self.assertEqual(room["title"], "AI 留言板 · 设计讨论")
            self.assertEqual(list_rooms(connection)["rooms"][0]["texts"], room["texts"])
            for field in ("title", "goal", "state_text"):
                payload = room["texts"][field]
                self.assertNotEqual(read_text(Text(payload["template"], **payload["params"]), "en"), room[field])
            messages = connection.execute("SELECT id,text FROM messages WHERE room_id='welcome' ORDER BY id").fetchall()
            self.assertEqual(len(messages), 6)
            for message in messages:
                payload = load_texts(connection, "message", message["id"])["text"]
                self.assertEqual(str(Text(payload["template"], **payload["params"])), message["text"])
                self.assertNotEqual(read_text(Text(payload["template"], **payload["params"]), "en"), message["text"])
            connection.execute("UPDATE rooms SET title='用户重新命名' WHERE id='welcome'")
            self.assertNotIn("title", require_room(connection, "welcome")["texts"])
            connection.execute("DELETE FROM stored_texts")
            self.assertEqual(require_room(connection, "welcome")["texts"], {})
        self.assertEqual(default_label("Custom-2"), "自定义 API-2")
        payload = default_label_text("Custom-2", "自定义 API-2")
        self.assertEqual(read_text(Text(payload["template"], **payload["params"]), "en"), "Custom API-2")
        self.assertIsNone(default_label_text("Custom-2", "我的助手"))

    def test_hidden_execution_fields_also_hide_their_templates(self):
        """Display metadata must not reveal fields removed by an independent-reader boundary."""
        from backend.server import _hide_execution_after_boundary
        execution = {"request_message_id": 20, "result": "secret", "texts": {
            "result": {"template": "{value}", "params": {"value": "secret"}}},
            "requests": [{"discussion_session_id": 1, "source_question": "question", "texts": {
                "source_question": {"template": "question", "params": {}}}}]}
        _hide_execution_after_boundary(execution, 10)
        self.assertEqual(execution["result"], "")
        self.assertEqual(execution["texts"], {})
        self.assertEqual(execution["requests"][0]["source_question"], "")
        self.assertEqual(execution["requests"][0]["texts"], {})
        self.assertEqual(execution["requests"][0]["field_notes"]["source_question"]["reason"], "reading_boundary")
        # The reader's own question stays: hiding one's own task would leave nothing to answer.
        from backend.server import _hide_question
        own = {"discussion_session_id": 1, "member": "Claude", "source_question": "my question"}
        _hide_question(own, 10, "Claude")
        self.assertEqual(own["source_question"], "my question")

    def test_incoming_text_rejects_invalid_metadata(self):
        invalid = (("x", {"template": "{x.__class__}", "params": {"x": "x"}}),
                   ("nan", {"template": "{x}", "params": {"x": float("nan")}}),
                   ("bad", {"template": "{x}", "params": {"x": "ok"}}))
        for value, payload in invalid:
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                incoming_text(value, payload)

    def test_text_schema_upgrades_legacy_database(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "legacy.sqlite3"
            with closing(sqlite3.connect(database)) as connection:
                connection.execute("CREATE TABLE legacy_marker(id INTEGER PRIMARY KEY)")
            init_database(database, seed=False)
            connection = connect_db(database)
            try:
                save_text(connection, "room", 1, "notice", Text("通知 {name}", name="Codex"))
                self.assertEqual(load_texts(connection, "room", 1),
                                 {"notice": {"template": "通知 {name}", "params": {"name": "Codex"}}})
                save_text(connection, "room", 1, "notice", "普通文本")
                self.assertEqual(load_texts(connection, "room", 1), {})
            finally:
                connection.close()

    def test_stored_text_import_remaps_message_and_keeps_room_isolation(self):
        self.configure_host(start=False)
        original = self.post("消息 3", "stored-template")[1]["message"]
        with closing(connect_db(self.database)) as connection, connection:
            save_text(connection, "message", original["id"], "text", Text("消息 {count}", count=3))
            save_text(connection, "message", 987654, "text", Text("另一房间私密内容"))
            save_text(connection, "execution", 987654, "result", Text("不随备份导出的执行模板"))
            save_text(connection, "queued_message", 987654, "payload", Text("不随备份导出的排队模板"))
            save_text(connection, "private_chat", 987654, "reply", Text("不随备份导出的私聊模板"))
        backup = self.request(f"/api/rooms/{self.room['id']}/backup")[1]
        self.assertEqual({row["owner"] for row in backup["tables"]["stored_texts"]}, {"message"})
        imported = json.loads(json.dumps(backup).replace(self.room["id"], "textimport"))
        status, result = self.request("/api/rooms/import", imported)
        self.assertEqual(status, 201, result)
        imported_message = self.request("/api/rooms/textimport/messages")[1]["messages"][0]
        with closing(connect_db(self.database)) as connection:
            self.assertEqual(load_texts(connection, "message", imported_message["id"]),
                             {"text": {"template": "消息 {count}", "params": {"count": 3}}})
            self.assertEqual(load_texts(connection, "message", 987654)["text"]["template"], "另一房间私密内容")

    def test_runner_text_metadata_http_storage_and_rejection_are_atomic(self):
        """Runner templates persist on their records, and invalid templates leave no partial writes."""
        base = f"/api/rooms/{self.room['id']}"
        decision_payload = {"kind": "round", "label": "Assigned to Codex", "label_text": {
            "template": "Assigned to {name}", "params": {"name": "Codex"}}, "confidence": 0.8,
            "applied": True, "provider": "jev"}
        status, decision = self.request(base + "/scheduler-decisions", decision_payload)
        self.assertEqual(status, 200, decision)
        decision_id = decision["id"]
        self.assertEqual(decision["texts"]["label"], decision_payload["label_text"])
        self.assertEqual(self.request(base + f"/scheduler-decisions/{decision_id}")[1]["texts"]["label"],
                         decision_payload["label_text"])
        backup = self.request(base + "/backup")[1]
        backup = json.loads(json.dumps(backup).replace(self.room["id"], "decisionimport"))
        status, imported = self.request("/api/rooms/import", backup)
        self.assertEqual(status, 201, imported)
        imported_decision = self.request("/api/rooms/decisionimport")[1]["scheduler_decisions"][0]
        self.assertNotEqual(imported_decision["id"], decision_id)
        self.assertEqual(imported_decision["texts"]["label"], decision_payload["label_text"])
        invalid_decision = {**decision_payload, "label_text": {"template": "Assigned to {name}", "params": {"name": "Claude"}}}
        self.assertEqual(self.request(base + "/scheduler-decisions", invalid_decision)[0], 400)

        with closing(connect_db(self.database)) as connection:
            member_id = connection.execute("SELECT id FROM room_members WHERE room_id=? AND name='Codex'", (self.room["id"],)).fetchone()[0]
        chat_url = base + f"/members/{member_id}/chat"
        status, chat = self.request(chat_url, {"text": "Question", "submission_id": "translated-chat-1"})
        self.assertEqual(status, 200, chat)
        reason_text = {"template": "Runner {state}", "params": {"state": "stopped"}}
        status, answered = self.request(base + f"/chats/{chat['id']}", {
            "action": "fail", "reason": "Runner stopped", "reason_text": reason_text})
        self.assertEqual(status, 200, answered)
        self.assertEqual(answered["texts"]["reason"], reason_text)
        status, pending = self.request(chat_url, {"text": "Second", "submission_id": "translated-chat-2"})
        self.assertEqual(status, 200, pending)
        self.assertEqual(self.request(base + f"/chats/{pending['id']}", {
            "action": "fail", "reason": "Runner stopped", "reason_text": {
                "template": "Runner {state}", "params": {"state": "working"}}})[0], 400)

        machine_id, machine_token, launch_id = uuid.uuid4().hex, uuid.uuid4().hex * 2, "launch-" + uuid.uuid4().hex
        with closing(connect_db(self.database)) as connection, connection:
            now = int(time.time())
            connection.execute("INSERT INTO local_machines(id,name,token_hash,created_at) VALUES(?,?,?,?)",
                               (machine_id, "test machine", hashlib.sha256(machine_token.encode()).hexdigest(), now))
            connection.execute("INSERT INTO remote_launches(id,machine_id,created_at,updated_at) VALUES(?,?,?,?)",
                               (launch_id, machine_id, now, now))

        def machine_launch(payload, target_launch=launch_id):
            request = Request(self.base + f"/api/machines/{machine_id}/launches/{target_launch}",
                              data=json.dumps(payload).encode(), method="POST",
                              headers={"Content-Type": "application/json", "X-Machine-Token": machine_token})
            try:
                response = urlopen(request, timeout=5)
            except HTTPError as error:
                response = error
            with response:
                return response.status, json.loads(response.read().decode())

        launch_error_text = {"template": "Launch {stage} failed", "params": {"stage": "creation"}}
        status, failed = machine_launch({"action": "fail", "error": "Launch creation failed", "error_text": launch_error_text})
        self.assertEqual(status, 200, failed)
        self.assertEqual(failed["texts"]["error"], launch_error_text)
        with closing(connect_db(self.database)) as connection:
            stored = connection.execute("SELECT status,error FROM remote_launches WHERE id=?", (launch_id,)).fetchone()
            self.assertEqual(tuple(stored), ("failed", "Launch creation failed"))

        bad_launch_id = "launch-" + uuid.uuid4().hex
        with closing(connect_db(self.database)) as connection, connection:
            connection.execute("INSERT INTO remote_launches(id,machine_id,created_at,updated_at) VALUES(?,?,?,?)",
                               (bad_launch_id, machine_id, now, now))
        request = Request(self.base + f"/api/machines/{machine_id}/launches/{bad_launch_id}",
                          data=json.dumps({"action": "fail", "error": "Launch creation failed",
                              "error_text": {"template": "Launch {stage} failed", "params": {"stage": "other"}}}).encode(),
                          method="POST", headers={"Content-Type": "application/json", "X-Machine-Token": machine_token})
        try:
            response = urlopen(request, timeout=5)
        except HTTPError as error:
            response = error
        with response:
            self.assertEqual(response.status, 400)
        with closing(connect_db(self.database)) as connection:
            row = connection.execute("SELECT status,error FROM remote_launches WHERE id=?", (bad_launch_id,)).fetchone()
            self.assertEqual(tuple(row), ("pending", ""))
            self.assertEqual(load_texts(connection, "launch", connection.execute(
                "SELECT rowid FROM remote_launches WHERE id=?", (bad_launch_id,)).fetchone()[0]), {})

        long_launch_id = "launch-" + uuid.uuid4().hex
        with closing(connect_db(self.database)) as connection, connection:
            connection.execute("INSERT INTO remote_launches(id,machine_id,created_at,updated_at) VALUES(?,?,?,?)",
                               (long_launch_id, machine_id, now, now))
        long_error = "x" * 2001
        status, _ = machine_launch({"action": "fail", "error": long_error,
                                   "error_text": {"template": "{message}", "params": {"message": long_error}}}, long_launch_id)
        self.assertEqual(status, 200)
        with closing(connect_db(self.database)) as connection:
            row = connection.execute("SELECT error FROM remote_launches WHERE id=?", (long_launch_id,)).fetchone()
            self.assertEqual(len(row["error"]), 2000)
            owner_id = connection.execute("SELECT rowid FROM remote_launches WHERE id=?", (long_launch_id,)).fetchone()[0]
            self.assertEqual(load_texts(connection, "launch", owner_id), {})

        with closing(connect_db(self.database)) as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM scheduler_decisions WHERE room_id=?", (self.room["id"],)).fetchone()[0], 1)
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM private_chats WHERE room_id=? AND status='pending'", (self.room["id"],)).fetchone()[0], 1)
            untouched_chat = connection.execute("SELECT id,reason FROM private_chats WHERE submission_id='translated-chat-2'").fetchone()
            self.assertEqual(untouched_chat["reason"], "")
            self.assertEqual(load_texts(connection, "private_chat", untouched_chat["id"]), {})

    def test_interjected_private_chat_reads_execution_reason_template(self):
        """A failed runner interjection supplies its saved execution template to the private-chat card."""
        base = f"/api/rooms/{self.room['id']}"
        with closing(connect_db(self.database)) as connection, connection:
            member_id = connection.execute("SELECT id FROM room_members WHERE room_id=? AND name='Codex'",
                                           (self.room["id"],)).fetchone()[0]
            now = int(time.time())
            cursor = connection.execute("INSERT INTO member_executions(room_id,member_id,client_id,status,created_at) VALUES(?,?,?,'started',?)",
                                        (self.room["id"], member_id, uuid.uuid4().hex, now))
            execution_id = cursor.lastrowid
            connection.execute("INSERT INTO execution_capabilities(execution_id,room_id,stoppable,progress,steer,resume) VALUES(?,?,1,1,1,0)",
                               (execution_id, self.room["id"]))
        chat_url = base + f"/members/{member_id}/chat"
        status, chat = self.request(chat_url, {"text": "Interrupt the current task", "submission_id": "interjected-chat"})
        self.assertEqual(status, 200, chat)
        self.assertEqual(chat["status"], "interjected")
        with closing(connect_db(self.database)) as connection:
            interjection_id = connection.execute("SELECT id FROM execution_interjections WHERE submission_id=?",
                                                 ("chat-interjected-chat",)).fetchone()[0]
        reason_text = {"template": "Runner {state}", "params": {"state": "could not deliver"}}
        status, _ = self.request(base + f"/executions/{execution_id}", {
            "action": "interjection", "interjection_id": interjection_id, "status": "failed",
            "reason": "Runner could not deliver", "reason_text": reason_text})
        self.assertEqual(status, 200)
        chats = self.request(chat_url)[1]["chats"]
        saved = next(item for item in chats if item["id"] == chat["id"])
        self.assertEqual(saved["reason"], "Runner could not deliver")
        self.assertEqual(saved["texts"]["reason"], reason_text)

    def test_event_redaction_and_truncation_templates_never_capture_secret_values(self):
        """Audit templates use the redacted preview, and nested secret values never enter template parameters."""
        secret = "private-token-" + uuid.uuid4().hex
        status, _ = self.request(f"/api/rooms/{self.room['id']}/state", {
            "text": "", "brief": "", "until": 0, "extra": {"api_key": secret},
            "chunks": ["x" * 2001 for _ in range(6)]})
        self.assertEqual(status, 200)
        events = self.request(f"/api/rooms/{self.room['id']}/events")[1]["events"]
        event = next(item for item in events if item["kind"] == "api.write" and item["data"].get("path") == "/state")
        self.assertIn("payload.extra.api_key", event["texts"])
        self.assertEqual(event["texts"]["payload.extra.api_key"], {"template": "[已隐去]", "params": {}})
        self.assertIn("payload.chunks[0]", event["texts"])
        self.assertIn("payload", event["texts"])
        self.assertNotIn(secret, json.dumps(event["texts"], ensure_ascii=False))
        self.assertNotIn(secret, event["data"]["payload"])

    def tearDown(self):
        """Release the server and all temporary files."""
        if self.external:
            return
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.directory.cleanup()

    def create_group_room(self):
        """Create an isolated group request without starting a runner or model, also usable against a test Worker."""
        names = ["Claude", "Codex", "Antigravity"]
        status, room = self.request("/api/rooms", {"title": "全体安排校验", "mode": "free", "host": "Claude",
            "members": [{"name": name, "access": "runner", "token": self.member_tokens[name]} for name in names]})
        self.assertEqual(status, 201, room)
        path = f"/api/rooms/{room['id']}"
        message = self.request(path + "/messages", {"author": "用户", "text": "全体处理原问题", "to": names,
            "order": "auto", "submission_id": uuid.uuid4().hex})[1]["message"]["id"]
        return path, message

    def test_group_host_fallback_is_durable_idempotent_and_keeps_original_request(self):
        """A single pending group becomes a deliverable route, with the original source and a durable routing marker."""
        path, message = self.create_group_room()
        url = f"{path}/recommendations/{message}"
        plan = self.request(url)[1]
        before = self.request(path)[1]["free"]["requests"][0]
        self.assertEqual(self.request(url, {"action": "host"}, token=self.member_tokens["Claude"])[0], 403)
        status, result = self.request(url, {"action": "host"})
        self.assertEqual(status, 200, result)
        after = self.request(path)[1]["free"]["requests"][0]
        self.assertEqual([after[key] for key in ("id", "message_id", "chain_id", "created_by")],
                         [before[key] for key in ("id", "message_id", "chain_id", "created_by")])
        self.assertEqual(after["purpose"], "route")
        inbox = self.request(path + "/inbox")[1]
        host = next(member for member in inbox["members"] if member["role"] == "host")
        self.assertEqual(host["pending"][0]["group_action"], "host")
        status, execution = self.request(path + "/executions", {"member_id": host["id"], "client_id": uuid.uuid4().hex})
        self.assertEqual(status, 200, execution)
        self.assertEqual(execution["requests"][0]["id"], plan["request"]["id"])
        self.assertEqual(self.request(url, {"action": "host"}), (200, result))
        self.assertEqual(self.request(url)[1]["result"], result)
        self.assertEqual(self.request(url, {"action": "all", "revision": plan["revision"]})[0], 409)

    def test_group_writes_require_the_judged_members_order_and_messages(self):
        """No revision is 400; changed members, order or messages are 409 and never create everyone's requests."""
        for change in ("members", "order", "message"):
            with self.subTest(change=change):
                path, message = self.create_group_room()
                url = f"{path}/recommendations/{message}"
                plan = self.request(url)[1]
                self.assertEqual(self.request(url, {"action": "all"})[0], 400)
                self.assertEqual(self.request(url, {"action": "sequential"})[0], 400)
                if change == "members":
                    target = next(member for member in plan["members"] if member["name"] == "Antigravity")
                    self.assertEqual(self.request(f"{path}/members/{target['id']}", {"action": "away"})[0], 200)
                elif change == "order":
                    order = self.request(path + "/speaking-order")[1]
                    self.assertEqual(self.request(path + "/speaking-order", {"revision": order["revision"], "order": list(reversed(order["movable"]))})[0], 200)
                else:
                    self.assertEqual(self.request(path + "/messages", {"author": "用户", "text": "先等一下，要求有变", "submission_id": uuid.uuid4().hex})[0], 201)
                for action in ("all", "sequential"):
                    self.assertEqual(self.request(url, {"action": action, "revision": plan["revision"]})[0], 409)
                current = self.request(path)[1]["free"]["requests"]
                self.assertEqual([(item["purpose"], item["status"]) for item in current if item["message_id"] == message], [("group", "pending")])
                self.assertEqual(self.request(url, {"action": "host"})[0], 200)

    def test_execution_diagnostics_over_http(self):
        """Record diagnostic evidence through the normal execution route and enforce its read boundaries."""
        members = [{"name": name, "access": "runner", "token": self.member_tokens[name]}
                   for name in ("Claude", "Codex", "Qwen")]
        status, room = self.request("/api/rooms", {"title": "执行诊断", "mode": "free", "host": "Claude", "members": members})
        self.assertEqual(status, 201, room)
        path = f"/api/rooms/{room['id']}"
        self.request(path + "/messages", {"author": "用户", "text": "安排执行", "to": ["Codex"], "submission_id": uuid.uuid4().hex})
        codex = next(item for item in self.request(path + "/inbox")[1]["members"] if item["name"] == "Codex")
        execution = self.request(path + "/executions", {"member_id": codex["id"], "client_id": uuid.uuid4().hex})[1]
        url = f"{path}/executions/{execution['id']}"
        self.assert_legacy_execution_diagnostics(url)
        self.assertEqual(self.request(url, {"action": "report", "changes": ["old.txt"], "provisional": True})[0], 200)
        self.assertIsNone(self.request(url)[1]["diagnostics"]["file_attribution"]["recorded_writes"])

        workflow = {"id": "script", "revision": "0123456789abcdef", "card": "reviewer", "sub_workflow": "checks",
                    "sub_revision": "0123456789ab", "skills": ["review", "C:/private/skill"], "prompt": "omit-this-prompt"}
        delivery = {"action": "delivery", "progress": True, "stoppable": True, "steer": True,
                    "diagnostics": {"workflow": workflow}}
        for _ in range(2):
            self.assertEqual(self.request(url, delivery)[0], 200)
        now = time.time_ns() // 1_000_000
        retry = {"layer": "model", "state": "started", "attempt": 1, "at": now - 50}
        restart = {"layer": "adapter", "state": "started", "attempt": 1, "at": now - 25}
        for at in (now - 100, now - 200):
            progress = {"last_activity_at": at, "timeout_limits": {"total_ms": 2700000, "idle_ms": 900000}, "retries": [retry, restart]}
            self.assertEqual(self.request(url, {"action": "renew", "diagnostics": progress})[0], 200)
        retry_wait = {"action": "retry_wait", "attempt": 1, "retry_at": int(time.time()) + 10, "reason": "retry",
                      "diagnostics": {"retry": {"layer": "runner", "state": "waiting", "attempt": 1, "mode": "resume"}}}
        status, result = self.request(url, retry_wait)
        self.assertEqual(status, 200, result)
        self.assertEqual(self.request(url, {"action": "retry_start", "diagnostics": {
            "retry": {"layer": "runner", "state": "started", "attempt": 1, "mode": "resume"}}})[0], 200)

        status, result = self.request(url, {"action": "interject", "text": "private interjection", "submission_id": uuid.uuid4().hex})
        self.assertEqual(status, 200, result)
        interjection_id = result["interjection"]["id"]
        self.assertEqual(self.request(url, {"action": "fail", "reason": "timeout", "diagnostics": {"timeout_kind": "idle"}})[0], 200)
        # The adapter proves delivery after the execution ends; a late retry of the original report still has no receipt.
        for confirmed_at in (now, None, now + 100):
            receipt = {"action": "interjection", "interjection_id": interjection_id, "status": "delivered",
                       "diagnostics": {"transport": "steer", "confirmed_at": confirmed_at}}
            self.assertEqual(self.request(url, receipt)[0], 200)
        final = {"action": "report", "changes": ["observed.txt", "written.txt"], "edited": ["written.txt"],
                 "diagnostics": {"file_attribution": {"omitted": 2}}}
        self.assertEqual(self.request(url, final)[0], 200)
        self.assertEqual(self.request(url, {"action": "renew"})[0], 409)

        self.assert_diagnostic_detail(url, now, workflow, interjection_id)
        self.assert_diagnostic_visibility(url, path, room["id"])
        self.assert_execution_view_cli(room["id"], execution["id"], self.request(url)[1]["diagnostics"])

    def assert_legacy_execution_diagnostics(self, url):
        """Upgrade storage shaped like a pre-diagnostics database with an existing execution."""
        if not self.external:
            with closing(sqlite3.connect(self.database)) as connection, connection:
                connection.execute("DROP TABLE execution_diagnostics")
            init_database(self.database, seed=False)
        self.assertEqual(self.request(url)[1]["diagnostics"], {})

    def assert_execution_view_cli(self, room, execution, diagnostics):
        """Run the source CLI against the same temporary service and compare its returned metadata."""
        cli = Path(__file__).resolve().parents[1] / "runner" / "discuss.py"
        with tempfile.TemporaryDirectory() as directory:
            credential = Path(directory) / "access.json"
            credential.write_text(json.dumps({"site": self.base, "room": room, "token": self.owner}), encoding="utf-8")
            result = subprocess.run([sys.executable, str(cli), "execution", "view", room, str(execution), "--access-file", str(credential)],
                                    capture_output=True, encoding="utf-8", timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["data"]["diagnostics"], diagnostics)

    def assert_diagnostic_detail(self, url, now, workflow, interjection_id):
        """Verify that one detail read preserves the source and timing of each recorded fact."""
        owner = self.request(url)[1]["diagnostics"]
        self.assertGreaterEqual(owner["last_heartbeat_at"], now)
        self.assertEqual(owner["last_activity_at"], now - 100)
        self.assertEqual(owner["timeout_kind"], "idle")
        self.assertEqual(owner["timeout_limits"]["idle_ms"], 900000)
        self.assertEqual([(item["layer"], item["state"]) for item in owner["retries"]],
                         [("model", "started"), ("adapter", "started"), ("runner", "waiting"), ("runner", "started")])
        self.assertEqual(owner["interjections"][str(interjection_id)]["confirmed_at"], now)
        self.assertEqual(len(owner["workflow_bindings"]), 1)
        self.assertEqual(owner["workflow_bindings"][0]["skills"], ["review"])
        self.assertEqual(owner["workflow_bindings"][0]["revision"], workflow["revision"])
        self.assertEqual(owner["file_attribution"], {"observed": 2, "recorded_writes": 1, "provisional": False, "omitted": 2,
            "paths": [{"path": "observed.txt", "recorded_write": False}, {"path": "written.txt", "recorded_write": True}]})

    def assert_diagnostic_visibility(self, url, path, room_id):
        """Check authorized metadata, owner file names, and exclusion from public and event reads."""
        owner = self.request(url)[1]["diagnostics"]
        for reader in ("Claude", "Codex"):
            detail = self.request(url, token=self.member_tokens[reader])[1]["diagnostics"]
            self.assertEqual(detail["last_heartbeat_at"], owner["last_heartbeat_at"])
            self.assertNotIn("paths", detail["file_attribution"])
        for token in (self.member_tokens["Qwen"], "anonymous"):
            self.assertEqual(self.request(url, token=token)[0], 403)
            self.assertEqual(self.request(url, {"action": "report", "changes": []}, token=token)[0], 403)
        self.assertNotIn("omit-this-prompt", json.dumps(self.request(path + "/events")[1]))
        self.assertNotIn("diagnostics", json.dumps(self.request(path + "/timeline")[1]))
        self.assertNotIn("last_heartbeat_at", json.dumps(self.request(f"/r/{room_id}", token="anonymous")[1]))

    def test_runner_reports_delivery_and_how_a_voided_execution_stopped(self):
        """The page learns how each execution reached its software and whether a stop really ended it."""
        names = ["Claude", "Codex"]
        status, room = self.request("/api/rooms", {"title": "投递方式", "mode": "free", "host": "Claude",
            "members": [{"name": name, "access": "runner", "token": self.member_tokens[name]} for name in names]})
        self.assertEqual(status, 201, room)
        path = f"/api/rooms/{room['id']}"
        self.request(path + "/messages", {"author": "用户", "text": "先做这个", "to": ["Codex"], "submission_id": uuid.uuid4().hex})
        codex = next(item for item in self.request(path + "/inbox")[1]["members"] if item["name"] == "Codex")
        execution = self.request(path + "/executions", {"member_id": codex["id"], "client_id": uuid.uuid4().hex})[1]
        url = f"{path}/executions/{execution['id']}"
        self.assertEqual(self.request(url, {"action": "delivery", "stoppable": "no", "progress": False})[0], 400)
        self.assertEqual(self.request(url, {"action": "stopped", "result": "stopped"})[0], 409, "a live execution has no stop result")
        self.assertEqual(self.request(url, {"action": "delivery", "stoppable": False, "progress": False})[0], 200)
        member = next(item for item in self.request(path)[1]["free"]["members"] if item["name"] == "Codex")
        self.assertEqual([member["execution"]["capabilities"], member["execution"]["stop_result"]], [{"stoppable": False, "progress": False, "steer": False, "resume": False}, ""])
        self.assertEqual(self.request(f"{path}/members/{codex['id']}/interrupt", {})[0], 200)
        self.assertEqual(self.request(url, {"action": "delivery", "stoppable": False, "progress": False})[0], 200)
        self.assertEqual(self.request(url, {"action": "stopped", "result": "unstoppable"})[0], 200)
        self.assertTrue(self.request(url, {"action": "stopped", "result": "unstoppable"})[1]["duplicate"])
        self.assertEqual(self.request(url, {"action": "stopped", "result": "unconfirmed"})[0], 409, "recorded once")
        report = next(item for item in self.request(path)[1]["free"]["executions"] if item["id"] == execution["id"])
        self.assertEqual([report["status"], report["capabilities"], report["stop_result"]], ["cancelled", {"stoppable": False, "progress": False, "steer": False, "resume": False}, "unstoppable"])
        # The window may still be on the voided turn: the member's next message waits instead of arriving mid-turn.
        self.request(path + "/messages", {"author": "用户", "text": "补充一句", "to": ["Codex"], "submission_id": uuid.uuid4().hex})
        self.assertEqual(self.request(path + "/executions", {"member_id": codex["id"], "client_id": uuid.uuid4().hex})[0], 409)
        self.assertGreater(next(item for item in self.request(path + "/inbox")[1]["members"] if item["name"] == "Codex")["held_until"], 0)
        # Its late answer is refused as an answer, kept apart for the page, and ends the wait.
        status, refused = self.request(path + "/messages", {"author": "Codex", "text": "迟到的回答", "kind": "chat",
            "execution_id": execution["id"], "submission_id": uuid.uuid4().hex}, token=self.member_tokens["Codex"])
        self.assertEqual(status, 409, refused)
        report = next(item for item in self.request(path)[1]["free"]["executions"] if item["id"] == execution["id"])
        self.assertEqual(set(report["late_answer"]), {"created_at"})
        for token in (self.member_tokens["Codex"], "anonymous"):
            self.assertNotIn("迟到的回答", json.dumps(self.request(path, token=token)[1], ensure_ascii=False))
            self.assertEqual(self.request(url + "/late-answer", token=token)[0], 403)
        self.assertEqual(self.request(url + "/late-answer")[1]["text"], "迟到的回答")
        self.assertNotIn("迟到的回答", [item["text"] for item in self.request(path + "/messages")[1]["messages"]])
        self.assertEqual(self.request(path + "/executions", {"member_id": codex["id"], "client_id": uuid.uuid4().hex})[0], 200)

    def test_owner_stop_all_ends_live_and_queued_work(self):
        """Stopping the room voids running work and everything still owed; members are not woken again by it."""
        names = ["Claude", "Codex"]
        status, room = self.request("/api/rooms", {"title": "全部停止", "mode": "free", "host": "Claude",
            "members": [{"name": name, "access": "runner", "token": self.member_tokens[name]} for name in names]})
        self.assertEqual(status, 201, room)
        path = f"/api/rooms/{room['id']}"
        for text in ("先做这个", "再补充一句"):
            self.request(path + "/messages", {"author": "用户", "text": text, "to": ["Codex"], "submission_id": uuid.uuid4().hex})
            if text == "先做这个":
                codex = next(item for item in self.request(path + "/inbox")[1]["members"] if item["name"] == "Codex")
                execution = self.request(path + "/executions", {"member_id": codex["id"], "client_id": uuid.uuid4().hex})[1]
        self.assertEqual(self.request(path + "/stop", {}, token=self.member_tokens["Codex"])[0], 403)
        self.assertEqual(self.request(path + "/stop", {})[0], 200)
        view = self.request(path)[1]["free"]
        self.assertEqual({(item["status"], item["cancel_reason"]) for item in view["requests"]}, {("cancelled", "user_stop")})
        self.assertEqual(next(item for item in view["executions"] if item["id"] == execution["id"])["status"], "cancelled")

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
                self.assertEqual(stream.readline(), f'data: {{"rooms": ["{self.room["id"]}"]}}\n'.encode())
                self.assertEqual(stream.readline(), b"\n")
            self.assertEqual(self.request("/api/rooms", {"title": "另一议题"})[0], 201)
            for stream in (first, second):
                self.assertEqual(stream.readline(), b"event: change\n")
                self.assertEqual(stream.readline(), b"data: {}\n", "a write outside one room names no room")
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
                with self.assertRaises(FutureTimeoutError):
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
            experts = payload.get("experts", {name: "cli" for name in self.member_tokens})
            if isinstance(experts, dict):
                current = self.request(path.removesuffix("/topic"))[1].get("experts", {}) if path.endswith("/topic") else {}
                for name, mode in experts.items():
                    if name in current and current[name] != mode:
                        self.member_tokens[name] = uuid.uuid4().hex
                payload.setdefault("members", [{"name": name, "token": self.member_tokens.setdefault(name, uuid.uuid4().hex),
                    "access": "runner" if name in self.runner_members else "manual"} for name, mode in experts.items()])
        if payload is not None and path.endswith("/messages") and "source" not in payload and "submitted_by" not in payload:
            mode = self.request(path.removesuffix("/messages"))[1].get("experts", {}).get(payload.get("author"))
            if mode == "cli":
                payload["source"] = "cli"
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

    def test_zip_attachment_directory_and_bounded_entry_reads(self):
        """Listing skips hidden paths and single-entry downloads retain ordinary attachment isolation."""
        raw = io.BytesIO()
        with zipfile.ZipFile(raw, "w") as archive:
            archive.writestr("ABCD.md", b"preview text", compress_type=zipfile.ZIP_DEFLATED)
            archive.writestr("目录/说明.txt", "这是说明")
            archive.writestr("__MACOSX/noise", "noise")
            archive.writestr("a/.DS_Store", "noise")
            archive.writestr("../outside.txt", "noise")
        base = f"/api/rooms/{self.room['id']}/attachments"
        def upload(name, data):
            params = urlencode({"actor": "用户", "file_name": name, "submission_id": "preview-" + uuid.uuid4().hex})
            status, _, answer = self.attachment_request(base + "?" + params, data)
            self.assertEqual(status, 201, answer)
            return base + "/" + json.loads(answer)["attachment"]["id"] + "/zip"
        route = upload("test.zip", raw.getvalue().replace(b"ABCD.md", "中文.md".encode("gbk")))
        status, _, response = self.attachment_request(route)
        self.assertEqual(status, 200)
        entries = json.loads(response)["entries"]
        self.assertEqual([e["path"] for e in entries], ["中文.md", "目录/说明.txt"])
        entry = route + "?" + urlencode({"entry": "中文.md"})
        status, headers, data = self.attachment_request(entry, headers={"Range": "bytes=2-5"})
        self.assertEqual((status, data, headers["Content-Range"]), (206, b"evie", "bytes 2-5/12"))
        self.assertIn("sandbox", headers["Content-Security-Policy"])
        self.assertTrue(headers["Content-Disposition"].startswith("attachment"))
        self.assertEqual(self.attachment_request(route + "?" + urlencode({"entry": "../outside.txt"}))[0], 400)
        self.assertEqual(self.attachment_request(route + "?entry=")[0], 400)
        self.assertEqual(self.attachment_request(route.replace(self.room["id"], "other-room"))[0], 404)
        self.assertEqual(self.attachment_request(upload("bad.zip", b"invalid"))[0], 400)
        if not self.external:
            from unittest.mock import patch
            with patch("backend.server.ZIP_ENTRY_LIMIT", 4):
                self.assertEqual(self.attachment_request(route + "?" + urlencode({"entry": "目录/说明.txt"}))[0], 400)

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
            orphan = attachment_path(self.database, {"id": "old-orphan"})
            orphan.touch()
            os.utime(orphan, (1, 1))
        self.assertEqual(self.request(base + "/delete", {"actor": "用户", "confirm_title": self.room["title"]})[0], 200)
        self.assertEqual(self.attachment_request(file["url"])[0], 404)
        if not self.external:
            self.assertEqual(list(Path(str(self.database) + ".attachments").iterdir()), [])

    def test_image_thumbnail_is_kept_once_with_the_original_shape_and_goes_with_it(self):
        """A page's smaller copy of an image is checked, kept once, served beside the original and removed with it."""
        base = f"/api/rooms/{self.room['id']}"
        original = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR" + struct.pack(">II", 1000, 2000) + bytes(300 * 1024)
        params = urlencode({"actor": "用户", "file_name": "shot.png", "submission_id": "thumbnail-original"})
        file = json.loads(self.attachment_request(base + "/attachments?" + params, original)[2])["attachment"]

        def webp(width, height):
            return b"RIFF" + struct.pack("<I", 1000) + b"WEBPVP8X" + struct.pack("<I", 10) + bytes(4) + (width - 1).to_bytes(3, "little") + (height - 1).to_bytes(3, "little") + bytes(1000)
        route = base + f"/attachments/{file['id']}/thumbnail"
        anonymous = Request(self.base + route, data=webp(360, 720), headers={"Content-Type": "application/octet-stream"})
        with self.assertRaises(HTTPError) as refused:
            urlopen(anonymous, timeout=10)
        self.assertEqual(refused.exception.code, 403)
        refused.exception.close()
        self.assertEqual(self.attachment_request(route, webp(360, 360))[0], 400, "another shape is refused")
        self.assertEqual(self.attachment_request(route, b"\x89PNG\r\n\x1a\n" + bytes(100))[0], 400, "only WebP or JPEG")
        self.assertEqual(self.attachment_request(route)[0], 404)
        status, _, body = self.attachment_request(route, webp(360, 720))
        self.assertEqual(status, 200, body)
        kept = json.loads(body)["attachment"]
        self.assertEqual((kept["thumbnail_type"], kept["thumbnail_url"]), ("image/webp", route))
        self.assertTrue(json.loads(self.attachment_request(route, webp(720, 1440))[2])["duplicate"], "the first copy stays")
        status, headers, content = self.attachment_request(route)
        self.assertEqual((status, content, headers["Content-Type"]), (200, webp(360, 720), "image/webp"))
        status, headers, content = self.attachment_request(file["url"], headers={"Range": "bytes=0-7"})
        self.assertEqual((status, content, headers["Content-Range"]), (206, original[:8], f"bytes 0-7/{len(original)}"))
        if not self.external:
            sweep_attachments(self.database)
            self.assertEqual(self.attachment_request(route)[0], 200, "the sweep keeps a registered original's copy")
        self.assertEqual(self.request(base + f"/attachments/{file['id']}/discard", {"actor": "用户"})[0], 200)
        if not self.external:
            self.assertEqual(list(Path(str(self.database) + ".attachments").iterdir()), [])

    def test_page_ticket_serves_its_folder_sandboxed_and_nothing_outside(self):
        """A project page opened in a tab reads the files beside it, as an opaque origin; no path leaves the folder."""
        if self.external:
            self.skipTest("page tickets belong to the local site")
        root = Path(str(self.database) + ".page")
        (root / "img").mkdir(parents=True)
        (root / "index.html").write_text('<img src="img/a.png">', encoding="utf-8")
        (root / "img" / "a.png").write_bytes(b"\x89PNG")
        Path(str(self.database) + ".secret").write_text("secret", encoding="utf-8")
        self.server.page_tickets["good"] = (root.resolve(), time.time() + 60)
        self.server.page_tickets["old"] = (root.resolve(), time.time() - 1)
        status, headers, body = self.attachment_request("/api/local/page/good/index.html")
        self.assertEqual((status, body), (200, b'<img src="img/a.png">'))
        self.assertTrue(headers["Content-Type"].startswith("text/html"))
        self.assertIn("sandbox allow-scripts", headers["Content-Security-Policy"])
        self.assertNotIn("allow-same-origin", headers["Content-Security-Policy"])
        self.assertEqual(self.attachment_request("/api/local/page/good/img/a.png")[2], b"\x89PNG")
        name = Path(str(self.database) + ".secret").name
        for path in (f"/api/local/page/good/%2E%2E/{name}", f"/api/local/page/good/..%5C{name}", "/api/local/page/old/index.html", "/api/local/page/none/index.html"):
            self.assertEqual(self.attachment_request(path)[0], 404, path)

    def test_media_ticket_streams_only_its_checked_file_until_it_expires_or_changes(self):
        """A local page plays a project file by a random ticket; an unknown, expired or outdated ticket reads nothing."""
        if self.external:
            self.skipTest("media tickets belong to the local site")
        path = Path(str(self.database) + ".media.mp3")
        path.write_bytes(b"ID3" + bytes(1000))
        info = path.stat()
        self.server.media_tickets["good"] = (path, info.st_size, info.st_mtime_ns, "audio/mpeg", path.name, time.time() + 60, "inline")
        self.server.media_tickets["old"] = (path, info.st_size, info.st_mtime_ns, "audio/mpeg", path.name, time.time() - 1, "inline")
        status, headers, body = self.attachment_request("/api/local/media/good", headers={"Range": "bytes=0-2"})
        self.assertEqual((status, body, headers["Content-Type"]), (206, b"ID3", "audio/mpeg"))
        self.assertIn("sandbox", headers["Content-Security-Policy"])
        self.assertEqual(self.attachment_request("/api/local/media/unknown")[0], 404)
        self.assertEqual(self.attachment_request("/api/local/media/old")[0], 404)
        path.write_bytes(b"ID3" + bytes(10))
        self.assertEqual(self.attachment_request("/api/local/media/good")[0], 409)

    def test_attachment_numbers_run_across_the_room(self):
        """`[图片 #n]` names one file room-wide: a sender's own numbering is moved to the numbers its files took."""
        base = f"/api/rooms/{self.room['id']}"

        def upload(name):
            params = urlencode({"actor": "用户", "file_name": f"{name}.png", "submission_id": f"upload-{name}"})
            return json.loads(self.attachment_request(base + "/attachments?" + params, b"\x89PNG\r\n\x1a\n" + name.encode())[2])["attachment"]["id"]

        start = self.request(base)[1]["next_attachment_number"]
        first = {"author": "用户", "text": "看 [图片 #1]", "attachment_ids": [upload("a")], "submission_id": "numbered-1"}
        saved = self.request(base + "/messages", first)[1]["message"]
        self.assertEqual((saved["text"], saved["attachments"][0]["number"]), (f"看 [图片 #{start}]", start))
        # Numbered within its own message (a CLI member), and retried with the same submission: one message, same text.
        second = {"author": "用户", "text": "[图片 #1] 和 [图片 #2]，不是 [图片 #7]", "attachment_ids": [upload("b"), upload("c")], "submission_id": "numbered-2"}
        saved = self.request(base + "/messages", second)[1]["message"]
        self.assertEqual(saved["text"], f"[图片 #{start + 1}] 和 [图片 #{start + 2}]，不是 [图片 #7]")
        self.assertEqual([item["number"] for item in saved["attachments"]], [start + 1, start + 2])
        replay = self.request(base + "/messages", second)[1]
        self.assertEqual((replay["duplicate"], replay["message"]["id"]), (True, saved["id"]))
        # The page already shows the room's next number and says so: nothing to move.
        third = {"author": "用户", "text": f"[图片 #{start + 3}]", "attachment_ids": [upload("d")], "attachment_start": start + 3, "submission_id": "numbered-3"}
        self.assertEqual(self.request(base + "/messages", third)[1]["message"]["text"], f"[图片 #{start + 3}]")
        self.assertEqual(self.request(base)[1]["next_attachment_number"], start + 4)

    def test_image_size_reads_each_format_header(self):
        """Sizes come from headers alone; a quarter-turn EXIF orientation swaps them as browsers show the picture."""
        exif = b"Exif\x00\x00MM\x00\x2a" + struct.pack(">IH", 8, 1) + struct.pack(">HHIHH", 0x0112, 3, 1, 6, 0) + bytes(4)
        cases = {
            "png": (png_header(640, 480), (640, 480)),
            "gif": (b"GIF89a" + struct.pack("<HH", 32, 16) + bytes(8), (32, 16)),
            "webp lossy": (b"RIFF\0\0\0\0WEBPVP8 \0\0\0\0\0\0\0\x9d\x01\x2a" + struct.pack("<HH", 300, 200), (300, 200)),
            "webp lossless": (b"RIFF\0\0\0\0WEBPVP8L\0\0\0\0\x2f" + struct.pack("<I", 299 | 199 << 14) + bytes(8), (300, 200)),
            "webp extended": (b"RIFF\0\0\0\0WEBPVP8X\0\0\0\0" + bytes(4) + (299).to_bytes(3, "little") + (199).to_bytes(3, "little"), (300, 200)),
            "jpeg rotated": (jpeg_header(400, 300, exif), (300, 400)),
            "jpeg upright": (jpeg_header(400, 300), (400, 300)),
            "truncated png": (b"\x89PNG\r\n\x1a\n", (0, 0)),
            "not an image": (b"plain text", (0, 0)),
        }
        for name, (data, size) in cases.items():
            with self.subTest(name):
                self.assertEqual(image_size(io.BytesIO(data)), size)

    def test_image_sizes_reach_messages_and_older_images_are_measured_once(self):
        """Uploads record the size; images stored before the columns existed are measured on first read and kept."""
        base = f"/api/rooms/{self.room['id']}"
        params = urlencode({"actor": "用户", "file_name": "photo.jpg", "submission_id": "sized-photo"})
        file = json.loads(self.attachment_request(base + "/attachments?" + params, jpeg_header(400, 300))[2])["attachment"]
        self.assertEqual((file["width"], file["height"]), (400, 300))
        payload = {"author": "用户", "text": "[图片 #1]", "attachment_ids": [file["id"]], "submission_id": "sized-message"}
        message = self.request(base + "/messages", payload)[1]["message"]
        self.assertEqual((message["attachments"][0]["width"], message["attachments"][0]["height"]), (400, 300))
        if self.external:
            return
        # Back to the attachments table as released before sizes were recorded, then upgrade it the way startup does.
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute("ALTER TABLE attachments DROP COLUMN width")
            connection.execute("ALTER TABLE attachments DROP COLUMN height")
        init_database(self.database, seed=False)
        stored = "SELECT width,height FROM attachments WHERE id=?"
        with closing(sqlite3.connect(self.database)) as connection:
            self.assertEqual(connection.execute(stored, (file["id"],)).fetchone(), (None, None))
        shown = self.request(base + "/messages")[1]["messages"][0]["attachments"][0]
        self.assertEqual((shown["width"], shown["height"]), (400, 300))
        with closing(sqlite3.connect(self.database)) as connection:
            self.assertEqual(connection.execute(stored, (file["id"],)).fetchone(), (400, 300))
        self.assertEqual(self.request(base + "/messages", payload)[1]["message"]["attachments"], [shown])

    def test_unsent_uploads_can_be_taken_back_but_sent_files_stay(self):
        """Files uploaded ahead of sending: the uploader may take one back; a sent file never goes; stale ones are cleared."""
        base = f"/api/rooms/{self.room['id']}"

        def upload(name):
            params = urlencode({"actor": "用户", "file_name": f"{name}.png", "submission_id": f"early-{name}"})
            return json.loads(self.attachment_request(base + "/attachments?" + params, b"\x89PNG\r\n\x1a\n" + name.encode())[2])["attachment"]["id"]

        removed, sent = upload("removed"), upload("sent")
        self.assertEqual(self.request(f"{base}/attachments/{removed}/discard", {})[0], 200)
        self.assertEqual(self.request(f"{base}/attachments/{removed}")[0], 404)
        self.request(base + "/messages", {"author": "用户", "text": "[图片 #1]", "attachment_ids": [sent], "submission_id": "early-message"})
        self.assertEqual(self.request(f"{base}/attachments/{sent}/discard", {})[0], 409)
        if getattr(self, "database", None):
            stale = upload("stale")
            with closing(sqlite3.connect(self.database)) as connection, connection:
                connection.execute("UPDATE attachments SET created_at='2000-01-01T00:00:00+00:00' WHERE id IN (?,?)", (stale, sent))
            upload("fresh")
            self.assertEqual(self.request(f"{base}/attachments/{stale}")[0], 404)
            self.assertEqual(self.request(f"{base}/attachments/{sent}")[0], 200)

    def test_attachment_sweep_preserves_sent_queued_and_recent_files(self):
        """Maintenance expires unclaimed uploads and old orphan files without a further upload."""
        if self.external:
            self.skipTest("Requires isolated SQLite and attachment storage")
        base = f"/api/rooms/{self.room['id']}"
        def upload(name):
            query = urlencode({"actor": "用户", "file_name": name + ".png", "submission_id": "sweep-" + name})
            result = self.attachment_request(base + "/attachments?" + query, b"\x89PNG\r\n\x1a\n" + name.encode())
            self.assertEqual(result[0], 201, result[2])
            return json.loads(result[2])["attachment"]["id"]

        stale, queued, sent, fresh = map(upload, ("stale", "queued", "sent", "fresh"))
        self.assertLess(self.request(base + "/messages", {"author": "用户", "text": "sent", "attachment_ids": [sent],
                                                          "submission_id": "sweep-message"})[0], 300)
        with closing(connect_db(self.database)) as connection, connection:
            connection.execute("UPDATE attachments SET created_at='2000-01-01T00:00:00+00:00' WHERE id<>?", (fresh,))
            connection.execute("""INSERT INTO queued_messages(room_id,position,submission_id,payload,created_at)
                               VALUES (?,1,'sweep-queued',?,1)""", (self.room['id'], json.dumps({"attachment_ids": [queued]})))
        root = attachment_path(self.database, {"id": ""})
        old, recent = root / "old-orphan", root / "recent-orphan"
        old.touch()
        recent.touch()
        past = time.time() - 7200
        for path in (old, root / queued, root / sent, root / fresh):
            os.utime(path, (past, past))
        sweep_attachments(self.database)
        self.assertEqual({path.name for path in root.iterdir()}, {queued, sent, fresh, recent.name})
        with closing(connect_db(self.database)) as connection:
            self.assertEqual({row[0] for row in connection.execute("SELECT id FROM attachments")}, {queued, sent, fresh})

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
        # An SVG shows inline as an image; opened directly, the sandboxing policy still keeps its scripts from running.
        svg = b'<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"><script>bad()</script></svg>'
        svg_params = {**params, "file_name": "图.svg", "submission_id": "upload-svg"}
        svg_file = json.loads(self.attachment_request(base + "/attachments?" + urlencode(svg_params), svg)[2])["attachment"]
        self.assertEqual(svg_file["content_type"], "image/svg+xml")
        svg_headers = self.attachment_request(svg_file["url"])[1]
        self.assertTrue(svg_headers["Content-Disposition"].startswith("inline"))
        self.assertIn("sandbox", svg_headers["Content-Security-Policy"])
        # A video is recognized for the page's player and served in the byte ranges a player seeks with.
        video = b"\x00\x00\x00\x18ftypisom" + bytes(range(256)) * 4
        video_params = {**params, "file_name": "片段.mp4", "submission_id": "upload-video"}
        video_file = json.loads(self.attachment_request(base + "/attachments?" + urlencode(video_params), video)[2])["attachment"]
        self.assertEqual(video_file["content_type"], "video/mp4")
        status, video_headers, body = self.attachment_request(video_file["url"], headers={"Range": "bytes=10-19"})
        self.assertEqual((status, body, video_headers["Content-Range"]), (206, video[10:20], f"bytes 10-19/{len(video)}"))
        self.assertEqual(self.attachment_request(video_file["url"], headers={"Range": "bytes=-5"})[2], video[-5:])
        self.assertEqual(self.attachment_request(video_file["url"], headers={"Range": f"bytes={len(video)}-"})[0], 416)
        self.assertEqual(self.attachment_request(video_file["url"])[2], video)
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
        payload = {"author": "Antigravity", "source": "cli", "text": "完整专家意见",
                   "summary": "摘要", "summary_by": "Antigravity", "submission_id": "backup-answer", "reply_to": originals[0]["id"]}
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
                                      "room_briefs", "room_user_requests", "topic_settings", "discussion_limits", "member_labels", "member_descriptions", "messages", "message_withdrawals", "message_details", "message_summaries", "message_timings", "attachments", "room_modes", "room_members", "member_requests", "member_suggestions", "member_recommendations",
                                      "scheduler_decisions", "review_plans", "private_chats",
                                      "discussion_sessions", "discussion_conclusions", "session_requests",
                                      "task_message_sources", "session_state", "session_limits", "stored_texts",
                                      "session_round_budgets", "session_options", "session_pauses"})
        self.assertEqual([row["id"] for row in tables["messages"]], [row["id"] for row in originals] + [answer["id"]])
        for original, row in zip(originals + [answer], tables["messages"]):
            self.assertEqual(row, {key: original[key] for key in row})
        details = next(row for row in tables["message_details"] if row["message_id"] == answer["id"])
        summary = next(row for row in tables["message_summaries"] if row["message_id"] == answer["id"])
        self.assertEqual(details, {"message_id": answer["id"], "kind": "chat", "submitted_by": "Antigravity"})
        self.assertEqual((summary["text"], summary["author"]), ("摘要", "Antigravity"))
        self.assertEqual(tables["rooms"][0]["state_text"], "保留分歧")
        self.assertEqual(tables["room_briefs"][0]["text"], "主持简报")
        self.assertEqual(tables["topic_settings"][0]["host"], "Codex")
        after = self.request(base)[1]
        before["limits"]["elapsed_seconds"] = after["limits"]["elapsed_seconds"]
        self.assertEqual(after, before)

    def test_room_share_link_keeps_its_token_out_of_the_directory_and_the_backup(self):
        """The manage token of a published link is for the owner's own reads only; the directory shows just the link."""
        base = f"/api/rooms/{self.room['id']}"
        link = {"share_id": "A" * 22, "url": "https://share.codiscuss.com/s/" + "A" * 22, "manage_token": "T" * 43, "expires_at": "2999-01-01T00:00:00.000Z"}
        self.assertEqual(self.request(base + "/share-link", {"link": {**link, "url": "http://share.example/s/x"}})[0], 400)
        self.assertEqual(self.request(base + "/share-link", {"link": {**link, "url": "https://evil.example/s/" + "A" * 22}})[0], 400, "only the official share site")
        member = next(iter(self.member_tokens.values()))
        self.assertEqual(self.request(base + "/share-link", token=member)[0], 403, "a member's own credential cannot read the manage token")
        self.assertEqual(self.request(base + "/share-link", {"link": link})[1]["link"]["manage_token"], link["manage_token"])
        listed = next(room for room in self.request("/api/rooms")[1]["rooms"] if room["id"] == self.room["id"])
        self.assertEqual(listed["share_link"], {"url": link["url"], "expires_at": link["expires_at"]})
        self.assertNotIn(link["manage_token"], json.dumps(self.request("/api/rooms")[1]))
        self.assertNotIn(link["manage_token"], json.dumps(self.request(base + "/backup")[1]))
        card_path = base + "/share-card"
        change = {"share_id": link["share_id"], "edits": {"question": "Edited on phone"}}
        self.assertEqual(self.request(card_path, token=member)[0], 403)
        self.assertEqual(self.request(card_path, change, token=member)[0], 403)
        self.assertEqual(self.request(card_path, change)[0], 200)
        self.request(base + "/share-link", {"link": {**link, "card": {"title": "Published title", "question": "Initial question"}}})
        self.request(base + "/share-link", {"link": link})
        self.assertEqual(self.request(card_path)[1]["card"], {"question": "Edited on phone", "title": "Published title"})
        replacement = {**link, "share_id": "B" * 22, "url": link["url"].replace("A" * 22, "B" * 22)}
        self.request(base + "/share-link", {"link": replacement})
        self.assertEqual(self.request(card_path, change)[0], 409)
        self.assertEqual(self.request(card_path)[1]["card"], {})
        self.request(base + "/share-link", {"link": {**link, "expires_at": "2000-01-01T00:00:00.000Z"}})
        self.assertIsNone(self.request(base + "/share-link")[1]["link"], "an expired link is not offered")
        self.assertEqual(self.request(base + "/share-link", {"link": None})[1], {"link": None})

    def test_share_card_upload_counts_belong_to_the_current_revision(self):
        base = f"/api/rooms/{self.room['id']}"
        card_path = base + "/share-card"
        link = {"share_id": "A" * 22, "url": "https://share.codiscuss.com/s/" + "A" * 22,
                "manage_token": "T" * 43, "expires_at": "2999-01-01T00:00:00.000Z"}
        def save(revision, total):
            return self.request(base + "/share-link", {"link": {**link, "card": {
                "publication": {"revision": revision, "total": total}}}})[0]

        old, new = "A" * 22, "B" * 22
        self.assertEqual(save(old, 3), 200)
        status = {"share_id": link["share_id"], "publication": {"revision": old, "done": 2}}
        self.assertEqual(self.request(card_path, status, token=next(iter(self.member_tokens.values())))[0], 403)
        self.assertTrue(self.request(card_path, status)[1]["recorded"])
        self.assertEqual(self.request(card_path)[1]["card"]["publication"]["done"], 2)
        self.assertEqual(save(new, 1), 200)
        status["publication"]["done"] = 1
        self.assertFalse(self.request(card_path, status)[1]["recorded"])
        self.assertNotIn("done", self.request(card_path)[1]["card"]["publication"])
        status["publication"]["revision"] = new
        self.assertTrue(self.request(card_path, status)[1]["recorded"])
        status["publication"]["done"] = 0
        self.assertFalse(self.request(card_path, status)[1]["recorded"])
        self.assertEqual(self.request(card_path)[1]["card"]["publication"], {"revision": new, "done": 1, "total": 1})

    def test_share_card_upgrades_stale_receipt_extracts_copy_and_lists_active_sites(self):
        base = f"/api/rooms/{self.room['id']}"
        card_path = base + "/share-card"
        self.assertEqual(self.post("我们要做一个街区咖啡点单 App，到店即取。\n\n- 材料1\n- 材料2", "open-question-1")[0], 201)
        self.assertEqual(self.post("回答问题 9：会员月费和折扣定哪一档：A", "receipt-question-9")[0], 201)
        member_name = list(self.member_tokens)[-1]
        member_token = self.member_tokens[member_name]
        png = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02\x00\x00\x00\x90wS\xde\x00\x00\x00\x0cIDATx\x9cc```\x00\x00\x00\x04\x00\x01\xf6\x178U\x00\x00\x00\x00IEND\xaeB`\x82"
        params = urlencode({"file_name": "cover.png", "content_type": "image/png", "actor": member_name, "submission_id": "att-cover"})
        att_status, _, att_body = self.attachment_request(base + "/attachments?" + params, png)
        self.assertEqual(att_status, 201)
        att = json.loads(att_body)["attachment"]
        msg_status, _ = self.request(base + "/messages", {
            "author": member_name,
            "text": "封面已做好。\n```share-copy\n3 个 AI 联手做完咖啡品牌官网\n\n完整协作记录：{{share_url}}\n```",
            "summary": "整套材料已完成，官网已上线。另外三个压缩包附在这条消息里，11 月 30 日到期。",
            "attachment_ids": [att["id"]],
            "proactive": True,
            "submission_id": "ai-cover-msg",
        }, token=member_token)
        self.assertIn(msg_status, (200, 201))
        site_status, _ = self.request(base + "/sites", {
            "action": "upsert",
            "site_id": "abcdefghij", "title": "拾光咖啡官网",
            "url": "https://abcdefghij.bimcanvas.com", "status": "active",
            "expires_at": "2999-01-01T00:00:00.000Z",
        })
        self.assertEqual(site_status, 200)
        link = {"share_id": "C" * 22, "url": "https://share.codiscuss.com/s/" + "C" * 22,
                "manage_token": "U" * 43, "expires_at": "2999-01-01T00:00:00.000Z"}
        # Save an old pre-v2 snapshot whose question wrongly captured the question receipt.
        self.request(base + "/share-link", {"link": {**link, "card": {
            "title": "拾光咖啡",
            "question": "回答问题 9：会员月费和折扣定哪一档：A",
            "outcome": "整套材料已完成，官网已上线。另外三个压缩包附在这条消息里，11 月 30 日到期。",
        }}})
        status, body = self.request(card_path)
        self.assertEqual(status, 200)
        self.assertEqual(body["card"]["question"], "我们要做一个街区咖啡点单 App，到店即取。")
        self.assertEqual(body["card"]["outcome"], "整套材料已完成，官网已上线。")
        self.assertEqual(len(body["sites"]), 1)
        self.assertEqual(body["sites"][0]["url"], "https://abcdefghij.bimcanvas.com")
        self.assertIn("3 个 AI 联手做完咖啡品牌官网", body["images"][0]["share_copy"])
        # Saving and resetting share copy via edits works cleanly.
        self.assertEqual(self.request(card_path, {"share_id": link["share_id"], "edits": {"copy": "自定义文案"}})[0], 200)
        self.assertEqual(self.request(card_path)[1]["card"]["copy"], "自定义文案")
        self.assertEqual(self.request(card_path, {"share_id": link["share_id"], "edits": {"copy": None}})[0], 200)
        self.assertNotIn("copy", self.request(card_path)[1]["card"])

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
        # The backup keeps raw rows, so the folder's project paths stay JSON text there.
        self.assertEqual(tables["topic_folders"], [{**folder, "directories": "[]"}])
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
        payload = {"author": "Antigravity", "source": "cli", "text": f"回应 #{first['id']}",
                   "summary": f"摘要 #{first['id']}", "summary_by": "Antigravity", "submission_id": "import-answer"}
        answer = self.request(base + "/messages", payload)[1]["message"]
        backup = json.loads(json.dumps(self.request(base + "/backup")[1]).replace(self.room["id"], "importedroom"))
        backup["tables"]["scheduler_decisions"] = [{"id": 1, "after_message_id": first["id"], "kind": "interjection", "label": "交给主持人 Codex", "confidence": 0.66,
                                                    "applied": 0, "provider": "jev", "created_at": "2026-10-25T00:00:00Z", "feedback": "bad", "should_be": "Antigravity",
                                                    "note": "该问 Antigravity", "context": "{\"prompt\": 2}"}]
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
                         [("bad", "Antigravity", "该问 Antigravity", "{\"prompt\": 2}")])
        messages = self.request("/api/rooms/importedroom/messages")[1]["messages"]
        new_first, second, new_answer = sorted(messages, key=lambda message: message["id"])
        self.assertGreater(new_first["id"], answer["id"] + 1)
        self.assertEqual((second["text"], second["reply_to"]), (f"补充 #{new_first['id']}", new_first["id"]))
        self.assertEqual((new_answer["text"], new_answer["summary"], new_answer["submitted_by"]),
                         (f"回应 #{new_first['id']}", f"摘要 #{new_first['id']}", "Antigravity"))
        self.assertNotIn("turn_id", new_answer)
        self.assertIsNone(room["current_turn"])
        path = f"/api/rooms/importedroom/attachments/{result['attachments'][file['id']]}"
        self.assertEqual(self.attachment_request(path + "/content")[0], 404)
        request = Request(self.base + path + "/import", data=data, headers={"X-Discussion-Token": self.owner})
        with urlopen(request, timeout=10) as response:
            self.assertEqual(response.status, 200)
        self.assertEqual(self.attachment_request(path + "/content")[2], data)

    def test_room_backup_v2_imports_sessions_as_read_only_history(self):
        """Session history and task provenance are remapped without importing executable work."""
        self.runner_members.add("Antigravity")
        self.configure_host(experts={"Codex": "cli", "Antigravity": "cli"})
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
        execution = self.reserve_member("Antigravity")["execution_id"]
        self.assertNotEqual(host_execution, execution)
        with closing(connect_db(self.database)) as connection, connection:
            host_request = connection.execute("SELECT id FROM member_requests WHERE purpose='discuss_host' ORDER BY id LIMIT 1").fetchone()[0]
            connection.execute("UPDATE task_message_sources SET cause_message_id=?,cause_request_id=? WHERE session_request_id=?",
                               (before["id"], host_request, plan["id"]))
            connection.execute("UPDATE session_requests SET read_until=? WHERE id=?", (before["id"], plan["id"]))
            question = Text("请回应 #{message_id} 的问题", message_id=before["id"])
            connection.execute("UPDATE session_requests SET question=? WHERE id=?", (question, plan["id"]))
            save_text(connection, "session_request", plan["id"], "question", question)
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
            question_text = load_texts(connection, "session_request", imported_plan["id"])["question"]
            self.assertEqual(question_text["template"].format(**question_text["params"]), imported_plan["question"])
            self.assertNotEqual(question_text["params"]["message_id"], before["id"])
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

    def test_child_directory_migration_and_deleted_parent(self):
        """Legacy children inherit once and keep their own directory after a parent is deleted."""
        if self.external:
            self.skipTest("Requires a local migration")
        parent = self.room["id"]
        folder = self.request("/api/folders", {"name": "项目"})[1]["id"]
        self.request(f"/api/rooms/{parent}/folder", {"actor": "用户", "folder_id": folder})
        child = self.request("/api/rooms", {"title": "子房间"})[1]["id"]
        base = f"/api/rooms/{child}"
        self.request(base + "/room-link", {"relation": "parent", "room_id": parent, "host": "Codex"})
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute("DELETE FROM site_preferences WHERE key='child_folders_migrated'")
        init_database(self.database)
        self.assertEqual(self.request(base)[1]["folder_id"], folder)
        self.assertEqual(self.request(base)[1]["parent_room_id"], parent)
        directory = self.request("/api/rooms")[1]["rooms"]
        self.assertEqual(next(room["parent_room_id"] for room in directory if room["id"] == child), parent)
        self.request(base + "/folder", {"actor": "用户", "folder_id": None})
        init_database(self.database)
        self.assertIsNone(self.request(base)[1]["folder_id"])
        self.request(f"/api/rooms/{parent}/delete", {"actor": "用户", "confirm_title": self.room["title"]})
        self.assertIsNone(self.request(base)[1]["parent_room_id"])
        self.assertIsNone(next(room["parent_room_id"] for room in self.request("/api/rooms")[1]["rooms"] if room["id"] == child))

    def test_detached_child_keeps_parent_link(self):
        """Showing a child room as standalone only changes the directory flag, never the parent link."""
        parent = self.room["id"]
        child = self.request("/api/rooms", {"title": "子房间"})[1]["id"]
        base = f"/api/rooms/{child}"
        self.assertEqual(self.request(f"/api/rooms/{parent}/detach", {"actor": "用户", "detached": True})[0], 400)
        self.request(base + "/room-link", {"relation": "parent", "room_id": parent, "host": "Codex"})
        self.assertEqual(self.request(base + "/detach", {"actor": "用户", "detached": "yes"})[0], 400)
        saved = self.request(base + "/detach", {"actor": "用户", "detached": True})[1]
        self.assertEqual((saved["detached"], saved["parent_room_id"]), (True, parent))
        ids = [room["id"] for room in self.request("/api/rooms")[1]["rooms"]]
        self.assertEqual(ids[ids.index(parent) + 1], child)
        self.assertFalse(self.request(base + "/detach", {"actor": "用户", "detached": False})[1]["detached"])

    def test_pinned_room_cannot_be_archived_or_destroyed(self):
        """A pinned room refuses archive, destroy and auto-destroy until it is unpinned; its place is unchanged."""
        base = f"/api/rooms/{self.room['id']}"
        ids = [room["id"] for room in self.request("/api/rooms")[1]["rooms"]]
        self.assertEqual(self.request(base + "/pin", {"actor": "用户", "pinned": "yes"})[0], 400)
        self.assertTrue(self.request(base + "/pin", {"actor": "用户", "pinned": True})[1]["pinned"])
        listed = self.request("/api/rooms")[1]["rooms"]
        self.assertEqual([room["id"] for room in listed], ids)
        self.assertTrue(next(room["pinned"] for room in listed if room["id"] == self.room["id"]))
        self.assertEqual(self.request(base + "/archive", {"actor": "用户"})[0], 409)
        self.assertEqual(self.request(base + "/delete", {"actor": "用户", "confirm_title": self.room["title"]})[0], 409)
        self.request(base + "/auto-destroy", {"actor": "用户", "days": 1})
        if not self.external:
            with closing(connect_db(self.database)) as connection:
                self.assertEqual(expired_rooms(connection, datetime.now(timezone.utc) + timedelta(days=2)), [])
        self.assertFalse(self.request(base + "/pin", {"actor": "用户", "pinned": False})[1]["pinned"])
        self.assertTrue(self.request(base + "/archive", {"actor": "用户"})[1]["archived"])

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

    def test_folder_project_paths_validate_and_persist(self):
        """A folder keeps its project paths for new rooms; renaming without paths leaves them unchanged."""
        for invalid in ("D:/a", ["relative/path"], [""], [42], ["D:/a", "d:\\A\\"], ["D:/x"] * 10):
            self.assertEqual(self.request("/api/folders", {"name": "路径", "directories": invalid})[0], 400, invalid)
        status, folder = self.request("/api/folders", {"name": "项目", "directories": [" D:/work/main ", "/srv/other"]})
        self.assertEqual(status, 201)
        self.assertEqual(folder["directories"], ["D:/work/main", "/srv/other"])
        path = f"/api/folders/{folder['id']}/rename"
        self.assertEqual(self.request(path, {"name": "改名"})[1]["directories"], ["D:/work/main", "/srv/other"])
        self.assertEqual(self.request(path, {"name": "改名", "directories": ["E:\\code"]})[1]["directories"], ["E:\\code"])
        if not self.external:
            init_database(self.database)
        saved = next(item for item in self.request("/api/rooms")[1]["folders"] if item["id"] == folder["id"])
        self.assertEqual((saved["name"], saved["directories"]), ("改名", ["E:\\code"]))

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

    def test_room_list_latest_speech_follows_the_owner_and_members(self):
        """The recent-activity order moves on the owner's messages and on a member's reply."""
        def latest_speech():
            rooms = self.request("/api/rooms")[1]["rooms"]
            return next(room for room in rooms if room["id"] == self.room["id"])["latest_speech_at"]

        self.configure_host(experts={"Codex": "cli", "Antigravity": "cli"})
        status, sent = self.post("用户追问", uuid.uuid4().hex)
        self.assertEqual(status, 201, sent)
        self.assertEqual(latest_speech(), sent["message"]["created_at"])
        payload = {"author": "Antigravity", "text": "专家答复", "source": "cli", "submission_id": uuid.uuid4().hex}
        payload.update(self.prepare_speech("Antigravity"))
        status, saved = self.request(f"/api/rooms/{self.room['id']}/messages", payload)
        self.assertEqual(status, 201, saved)
        self.assertEqual(latest_speech(), saved["message"]["created_at"])

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

    def test_delete_removes_related_records_and_leaves_other_channels(self):
        """Wrong confirmations preserve content; deletion removes linked data atomically."""
        self.configure_host()
        original = self.post("删除测试原文", "delete-original")[1]["message"]
        self.post("引用原文", "delete-reply-001", original["id"])
        turn = self.schedule()[1]["turn"]
        base = f"/api/rooms/{self.room['id']}"
        answer = {"author": "Antigravity", "text": "回答", "summary": "回答摘要", "submission_id": "delete-answer-001", "request_ids": [turn["member_request_id"]]}
        self.assertEqual(self.request(base + "/messages", answer)[0], 201)
        self.assertEqual(self.request(base + "/state", {"actor": "Codex", "text": "状态", "brief": "主持简报"})[0], 200)
        other = self.request("/api/rooms", {"title": "保留频道"})[1]
        self.assertEqual(self.request(base + "/delete", {"actor": "用户", "confirm_title": "错误"})[0], 400)
        self.assertEqual(self.request(base + "/delete", {"actor": "Antigravity", "confirm_title": self.room["title"]})[0], 403)
        self.assertEqual(self.request(base)[1]["message_count"], 3)
        self.assertEqual(self.request(base + "/delete", {"actor": "用户", "confirm_title": self.room["title"]})[0], 200)
        for suffix in ("", "/messages", f"/messages/{original['id']}", "/turns"):
            self.assertEqual(self.request(base + suffix)[0], 404)
        # The runner polls its inbox with the owner credential and tells a deleted room by the 404.
        self.assertEqual(self.request(base + "/inbox", token=self.owner)[0], 404)
        self.assertEqual(self.request(f"/r/{self.room['id']}")[0], 404)
        self.assertEqual(self.request(f"/api/rooms/{other['id']}")[0], 200)
        if not self.external:
            with closing(sqlite3.connect(self.database)) as connection:
                for table in ("messages", "topic_settings", "room_directory", "room_folder_assignments", "room_briefs", "discussion_limits"):
                    self.assertEqual(connection.execute(f"SELECT COUNT(*) FROM {table} WHERE room_id=?", (self.room["id"],)).fetchone()[0], 0)
                self.assertEqual(connection.execute("PRAGMA foreign_key_check").fetchall(), [])
                # Texts and feedback cases name their room without a foreign key; none of the destroyed room's may remain.
                self.assertEqual(connection.execute("SELECT COUNT(*) FROM stored_texts WHERE template LIKE '%删除测试原文%' OR params LIKE '%删除测试原文%'").fetchone()[0], 0)
                self.assertEqual(connection.execute("SELECT COUNT(*) FROM scheduler_feedback_cases WHERE room_id=?", (self.room["id"],)).fetchone()[0], 0)
        # A room a runner served waits for that runner's report, accepted only under the room's old owner credential.
        destruction = self.request(base + "/destruction")[1]
        self.assertEqual(destruction["status"], "cleaning")
        self.assertEqual({item["kind"]: item["state"] for item in destruction["items"]}["messages"], "deleted")
        report = {"items": [{"kind": "sessions", "state": "deleted", "count": 1, "adapter": "codex_cli"},
                            {"kind": "runtime_files", "state": "deleted"}]}
        self.assertEqual(self.request(base + "/destruction", report, token=self.member_tokens["Codex"])[0], 403)
        self.assertIn("sessions", self.request(base + "/destruction", token=self.owner)[1])
        self.assertNotIn("sessions", self.request(base + "/destruction", token=self.member_tokens["Codex"])[1])
        finished = self.request(base + "/destruction", report, token=self.owner)[1]
        self.assertEqual((finished["status"], finished["title"]), ("done", ""))
        self.assertIn("destructions", self.request("/api/rooms")[1])

    def test_destroy_reclaims_sqlite_free_pages_for_new_and_legacy_databases(self):
        """Destroying a room shrinks the SQLite file incrementally, and legacy auto_vacuum=0 DBs upgrade once."""
        if self.external:
            self.skipTest("reads the website's own database")
        with closing(sqlite3.connect(self.database)) as connection:
            self.assertEqual(connection.execute("PRAGMA auto_vacuum").fetchone()[0], 2)
        room = self.request("/api/rooms", {"title": "大消息测试房"})[1]
        base = f"/api/rooms/{room['id']}"
        chunk = "x" * 15000
        for index in range(80):
            status, body = self.request(base + "/messages", {"author": "用户", "text": f"{index}:{chunk}", "submission_id": f"reclaim-msg-{index}"})
            self.assertEqual(status, 201, body)
        with closing(sqlite3.connect(self.database)) as connection:
            connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        before = os.path.getsize(self.database)
        self.assertEqual(self.request(base + "/delete", {"actor": "用户", "confirm_title": room["title"]})[0], 200)
        after = os.path.getsize(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            self.assertEqual(connection.execute("PRAGMA freelist_count").fetchone()[0], 0)
        self.assertLess(after, before - 500_000)

        with tempfile.TemporaryDirectory() as folder:
            legacy = Path(folder) / "legacy.sqlite3"
            with closing(sqlite3.connect(legacy)) as connection:
                connection.execute("CREATE TABLE blob_pad (id INTEGER PRIMARY KEY, body TEXT)")
                connection.executemany("INSERT INTO blob_pad (body) VALUES (?)", [("y" * 20000,) for _ in range(200)])
                connection.commit()
                connection.execute("DELETE FROM blob_pad")
                connection.commit()
                self.assertEqual(connection.execute("PRAGMA auto_vacuum").fetchone()[0], 0)
                self.assertGreater(connection.execute("PRAGMA freelist_count").fetchone()[0], 256)
            legacy_before = os.path.getsize(legacy)
            init_database(legacy, seed=False)
            with closing(sqlite3.connect(legacy)) as connection:
                self.assertEqual(connection.execute("PRAGMA auto_vacuum").fetchone()[0], 2)
                self.assertEqual(connection.execute("PRAGMA freelist_count").fetchone()[0], 0)
            self.assertLess(os.path.getsize(legacy), legacy_before - 1_000_000)

    def test_auto_destroy_takes_only_rooms_idle_past_their_limit(self):
        """A room set to destroy itself goes once it has had no message for that many days; other rooms stay."""
        if self.external:
            self.skipTest("reads the website's own database")
        base = f"/api/rooms/{self.room['id']}"
        self.assertEqual(self.request(base + "/auto-destroy", {"actor": "用户", "days": 3})[0], 400)
        self.assertEqual(self.request(base + "/auto-destroy", {"actor": "用户", "days": 1})[0], 200)
        kept = self.request("/api/rooms", {"title": "长期保留"})[1]
        listed = {room["id"]: room["destroy_after_days"] for room in self.request("/api/rooms")[1]["rooms"]}
        self.assertEqual((listed[self.room["id"]], listed[kept["id"]]), (1, 0))
        with closing(connect_db(self.database)) as connection:
            self.assertEqual(expired_rooms(connection), [])
            later = datetime.now(timezone.utc) + timedelta(days=2)
            self.assertEqual(expired_rooms(connection, later), [self.room["id"]])
            # A room set long after its last message still gets the whole limit, counted from the setting.
            connection.execute("UPDATE rooms SET created_at='2020-01-01T00:00:00+00:00' WHERE id=?", (self.room["id"],))
            connection.commit()
            self.assertEqual(expired_rooms(connection), [])
            # A published share page can only be taken down by the owner's page, so such a room is neither destroyed nor expired.
            connection.execute("INSERT INTO room_share_links (room_id,share_id,url,manage_token,expires_at,updated_at) VALUES (?,?,?,?,?,?)",
                               (self.room["id"], "s" * 22, "https://x/s/1", "t" * 20, "2099-01-01T00:00:00Z", "2026-01-01T00:00:00Z"))
            connection.commit()
            self.assertEqual(expired_rooms(connection, later), [])
        self.assertEqual(self.request(base + "/delete", {"actor": "用户"})[0], 409)

    def test_frontend_assets_have_browser_compatible_content_types(self):
        """Compiled assets and every bundled brand icon load through the static routes."""
        assets = {"/": "text/html", "/app.js": "text/javascript",
                  "/modern.js": "text/javascript", "/modern.css": "text/css",
                  "/markdown.js": "text/javascript", "/markdown.css": "text/css",
                  "/icons/LICENSE.txt": "text/plain"}
        icons = Path(__file__).resolve().parent.parent / "web" / "icons"
        for icon in icons.iterdir():
            if not icon.is_file() or icon.name.startswith(".") or icon.name == "LICENSE.txt":
                continue
            content_type = mimetypes.guess_type(icon.name)[0] or ""
            self.assertTrue(content_type.startswith("image/"), f"Unknown icon type: {icon.name}")
            assets[f"/icons/{icon.name}"] = content_type
        for path, content_type in assets.items():
            with self.subTest(path=path), urlopen(self.base + path, timeout=5) as response:
                self.assertEqual(response.status, 200)
                accepted_types = ("text/javascript", "application/javascript") if content_type == "text/javascript" else (content_type,)
                self.assertIn(response.headers["Content-Type"].split(";")[0].strip(), accepted_types)
                content = response.read()
                self.assertTrue(content)
                if path.startswith("/icons/"):
                    self.assertEqual(content, (icons / path.removeprefix("/icons/")).read_bytes())

    def test_room_reads_answer_304_until_their_content_changes(self):
        """The room list and a room's view carry an ETag; a matching If-None-Match gets 304, a change gets the new body."""
        if self.external:
            self.skipTest("ETags are served by the Python site")
        def read(path, etag=None):
            request = Request(self.base + path, headers={"X-Discussion-Token": self.owner, **({"If-None-Match": etag} if etag else {})})
            try:
                response = urlopen(request, timeout=5)
            except HTTPError as error:
                response = error
            with response:
                return response.status, response.headers.get("ETag"), response.read()
        for path in ("/api/rooms", f"/api/rooms/{self.room['id']}"):
            with self.subTest(path=path):
                status, etag, body = read(path)
                self.assertEqual(status, 200)
                self.assertTrue(etag)
                self.assertEqual(read(path, etag)[:2], (304, etag))
                self.assertEqual(read(path, etag)[2], b"")
                self.assertEqual(read(path, '"stale"')[0], 200)
        before = {path: read(path)[1] for path in ("/api/rooms", f"/api/rooms/{self.room['id']}")}
        self.assertEqual(self.request(f"/api/rooms/{self.room['id']}/rename", {"actor": "用户", "title": "再次改名"})[0], 200)
        for path, etag in before.items():
            with self.subTest(after_change=path):
                status, changed, body = read(path, etag)
                self.assertEqual(status, 200)
                self.assertNotEqual(changed, etag)
                self.assertIn("再次改名", body.decode())

    def test_cli_publish_is_idempotent_and_rejects_changed_payload(self):
        """An execution's exact retries retain one original CLI record, even after completion."""
        self.configure_host(experts={"Codex": "cli", "Antigravity": "cli"})
        payload = {"author": "Antigravity", "text": "CLI 原文 & #测试", "submission_id": "cli-once-001", "source": "cli", "kind": "chat"}
        payload.update(self.prepare_speech("Antigravity"))
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

    def test_answers_bind_to_their_request_and_other_messages_leave_the_plan_open(self):
        """Answers bind to their issued request; ordinary messages do not finish the discussion plan."""
        self.configure_host()
        base = f"/api/rooms/{self.room['id']}"
        plan = self.schedule()[1]["turn"]
        answer = {"author": "Antigravity", "kind": "chat", "request_ids": [plan["member_request_id"]],
                  "text": "被点名者的真实回答", "submission_id": "floor-answer"}
        self.assertIn(self.request(base + "/messages", {**answer, "author": "Qwen", "submission_id": "floor-wrong"})[0], (400, 403))
        self.assertEqual(self.post("补充约束", "floor-user")[0], 201)
        host_binding = self.reserve_member("Codex")
        self.assertEqual(self.request(base + "/messages", {**host_binding, "author": "Codex", "kind": "chat", "text": "插入主持说明", "submission_id": "floor-host"})[0], 201)
        self.assertEqual(self.request(base + f"/turns/{plan['id']}")[1]["status"], "open")
        status, saved = self.request(base + "/messages", answer)
        self.assertEqual(status, 201, saved)
        self.assertNotIn("turn_id", saved["message"])
        self.assertEqual(self.request(base + f"/turns/{plan['id']}")[1]["status"], "answered")
        self.assertTrue(self.request(base + "/messages", answer)[1]["duplicate"])
        self.assertEqual(self.request(base + "/messages", {**answer, "text": "改过的回答"})[0], 409)
        self.assertEqual(self.request(base + "/messages", {**answer, "submission_id": "floor-late"})[0], 409)

    def configure_host(self, start=True, experts=None):
        """Create a free room with an automatic host and explicit participant capabilities."""
        status, self.room = self.request("/api/rooms", {"title": "讨论请求回归", "host": "Codex",
            "experts": experts or {"Codex": "cli", "Antigravity": "cli"}})
        self.assertEqual(status, 201, self.room)
        for name in self.room["experts"]:
            if name not in self.runner_members:
                self.assertEqual(self.request(f"/api/rooms/{self.room['id']}/register", {}, token=self.member_tokens[name])[0], 200)
        if start:
            self.session_action("start", goal="保持完整记录")
        return self.request(f"/api/rooms/{self.room['id']}")[1]

    def schedule(self, submission_id="schedule-001", **changes):
        """Read the session roster and submit the host's versioned plan."""
        base = f"/api/rooms/{self.room['id']}"
        roster = self.request(base + "/turns/roster")[1]
        payload = {"actor": "Codex", "expert": "Antigravity", "question": "请检查尚未解决的分歧", "submission_id": submission_id}
        return self.request(base + "/turns", {**payload, "roster": roster.get("revision"), **changes})

    def test_interjection_ask_keeps_queue_and_other_host_requests(self):
        """Versioned conversion closes only one source, even when a host execution contains two."""
        self.configure_host(experts={"Codex": "cli", "Antigravity": "cli", "Claude": "cli"})
        base = f"/api/rooms/{self.room['id']}"
        self.schedule("ask-queue-plan", turns=[{"expert": name, "question": "请分析"} for name in ("Antigravity", "Claude")])
        first = self.post("请解释第一处风险", "ask-source-one")[1]["message"]["id"]
        stale = self.request(base + "/turns/roster")[1]
        second = self.post("请解释第二处风险", "ask-source-two")[1]["message"]["id"]
        binding = self.reserve_member("Codex")
        roster = self.request(base + "/turns/roster")[1]
        source = next(item for item in roster["host_requests"] if item["message_id"] == first)
        payload = {"actor": "Codex", "request_id": source["id"], "expert": "Antigravity", "submission_id": "ask-convert-one"}
        self.assertEqual(self.request(base + "/turns/ask", payload)[0], 400)
        self.assertEqual(self.request(base + "/turns/ask", {**payload, "revision": stale["revision"]})[0], 409)
        payload["revision"] = roster["revision"]
        self.assertEqual(self.request(base + "/turns/ask", {**payload, "actor": "Claude"})[0], 403)
        status, result = self.request(base + "/turns/ask", payload)
        self.assertEqual(status, 201, result)
        self.assertEqual((result["request"]["purpose"], result["request"]["message_id"]), ("ask", first))
        self.assertFalse(result["execution_completed"])
        latest = self.request(base + "/turns/roster")[1]
        self.assertEqual((latest["queue"], latest["waiting"]), (roster["queue"], roster["waiting"]))
        self.assertEqual([item["message_id"] for item in latest["host_requests"]], [second])
        self.assertEqual(latest["held_since"], second)
        self.assertTrue(self.request(base + "/turns/ask", payload)[1]["duplicate"])
        self.assertEqual(self.request(base + "/turns/ask", {**payload, "expert": "Codex"})[0], 409)
        second_payload = {**payload, "request_id": latest["host_requests"][0]["id"], "expert": "Codex",
                          "revision": latest["revision"], "submission_id": "ask-convert-two"}
        status, result = self.request(base + "/turns/ask", second_payload)
        self.assertEqual(status, 201, result)
        self.assertTrue(result["execution_completed"])
        self.assertTrue(self.request(base + "/turns/ask", second_payload)[1]["execution_completed"])
        self.assertEqual(self.request(base + "/turns/roster")[1]["held_since"], 0)
        self.assertEqual(self.request(base + f"/executions/{binding['execution_id']}")[1]["status"], "completed")

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

    def test_overview_discloses_context_only_through_explicit_pages(self):
        """Entry pages never inline background, state text, or mentioned messages."""
        self.configure_host()
        self.request(f"/api/rooms/{self.room['id']}/topic", {"actor": "Codex", "background": "BACKGROUND_ONLY", "boundaries": "BOUNDARIES_ONLY"})
        self.post("@Antigravity MESSAGE_ONLY", "progressive-001")
        self.request(f"/api/rooms/{self.room['id']}/state", {"actor": "Codex", "text": "STATE_ONLY"})
        base = f"/r/{self.room['id']}"
        overview = self.request(base + "?participant=Antigravity")[1]
        for marker in ("BACKGROUND_ONLY", "BOUNDARIES_ONLY", "STATE_ONLY", "MESSAGE_ONLY"):
            self.assertNotIn(marker, overview)
        for route in ("/brief", "/state", "/search?mention=Antigravity", "/messages?page=1"):
            self.assertIn(route, overview)
        self.assertIn("BACKGROUND_ONLY", self.request(base + "/brief")[1])
        self.assertIn("STATE_ONLY", self.request(base + "/state")[1])
        self.assertIn("MESSAGE_ONLY", self.request(base + "/search?mention=Antigravity")[1])
        protocol = self.request(base + "/protocol")[1]
        self.assertIn("当前主持人：Codex", protocol)
        self.assertIn("--kind chat --execution", protocol)

    def test_host_speech_keeps_its_authorship_and_cannot_answer_for_others(self):
        """The host's own answer keeps its author and source; it cannot submit another member's answer."""
        self.configure_host()
        path = f"/api/rooms/{self.room['id']}/messages"
        payload = {"author": "Codex", "text": "个人观点", "source": "cli", "kind": "chat", "submission_id": "host-opinion-001"}
        payload.update(self.prepare_speech("Codex"))
        opinion = self.request(path, payload)[1]["message"]
        self.assertEqual((opinion["kind"], opinion["source"], opinion["submitted_by"]), ("chat", "cli", "Codex"))
        binding = self.prepare_speech("Codex", "moderation")
        moderation = self.request(path, {**binding, "author": "Codex", "text": "请回到议题", "kind": "chat", "submission_id": "host-control-001"})[1]["message"]
        self.assertEqual(moderation["author"], "Codex")
        forwarded = {"author": "Antigravity", "submitted_by": "Codex", "text": "替他人回答", "reply_to": opinion["id"], "submission_id": "host-forward-001"}
        self.assertEqual(self.request(path, forwarded, token=self.member_tokens["Codex"])[0], 403)
        original = self.request(f"/r/{self.room['id']}/messages/{opinion['id']}")[1]
        self.assertIn("提交者：Codex", original)

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
        # The host's own turn ends as done, not as a user stop that would make the runner kill the software.
        self.assertEqual(next(item for item in room["free"]["executions"] if item["id"] == execution)["status"], "completed")
        self.assertEqual(self.post("讨论结束后继续协作", "conclude-followup")[0], 201)
        self.assertEqual(self.request(base + "/limits", {"actor": "用户", "action": "reopen"})[0], 400)
        self.assertEqual(self.session_action("start", goal="再次讨论")["session"]["status"], "active")

    def test_host_conclusion_continue_wakes_host_for_work_left_after_the_discussion(self):
        """Work the user left for after the discussion reaches the host once the discussion has ended."""
        self.configure_host()
        base = f"/api/rooms/{self.room['id']}"
        self.reserve_member("Codex")
        self.assertEqual(self.request(base + "/state", {"actor": "Codex", "text": "最终共识"})[0], 200)
        conclusion = self.request(base + "/conclusion")[1]
        status, _ = self.request(base + "/limits", {"actor": "Codex", "action": "done", "conclusion": conclusion["revision"], "continue": " "})
        self.assertEqual(status, 400)
        status, result = self.request(base + "/limits", {"actor": "Codex", "action": "done", "conclusion": conclusion["revision"],
                                                         "continue": "按用户要求派人做部署测试"})
        self.assertEqual(status, 200, result)
        room = self.request(base)[1]
        self.assertEqual(room["session"]["status"], "concluded")
        notice = next(item for item in room["free"]["requests"] if item["member"] == "Codex" and item["status"] == "pending")
        self.assertEqual(notice["purpose"], "notice")
        message = self.request(f"{base}/messages/{notice['message_id']}")[1]
        self.assertIn("按用户要求派人做部署测试", message["text"])

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
        payload = {"author": "Antigravity", "text": "专家的回答", "request_ids": [plan["member_request_id"]], "submission_id": "turn-answer-001"}
        status, result = self.request(base + "/messages", payload)
        self.assertEqual(status, 201, result)
        self.assertEqual(self.request(path)[1]["status"], "answered")
        member_request = next(item for item in self.request(base)[1]["free"]["requests"] if item["id"] == plan["member_request_id"])
        self.assertEqual(member_request["answer_id"], result["message"]["id"])
        self.assertTrue(self.request(base + "/messages", payload)[1]["duplicate"])
        self.assertEqual(self.schedule("schedule-next-001")[0], 201)

    def test_independent_pause_and_resume_lifecycle(self):
        """Pause cancels old work, resume requires a fresh plan, and conclusion leaves ordinary collaboration available."""
        self.configure_host()
        base = f"/api/rooms/{self.room['id']}"
        self.assertEqual(self.request(base + "/discussion")[1]["session"]["phase"], "initial")
        plan = self.schedule()[1]["turn"]
        answer = {"author": "Antigravity", "text": "独立结论及依据", "request_ids": [plan["member_request_id"]], "submission_id": "initial-answer-001"}
        self.session_action("pause")
        self.assertEqual(self.request(base + "/messages", answer)[0], 409)
        self.assertEqual(self.schedule("paused-turn-001")[0], 400)
        self.assertEqual(self.request(base + f"/turns/{plan['id']}")[1]["status"], "cancelled")
        self.assertEqual(self.request(base + "/messages", {"author": "Antigravity", "kind": "receipt", "text": "旧回执", "submission_id": "stop-receipt-001"})[0], 400)
        self.session_action("resume")
        answer.update(self.prepare_speech("Antigravity"))
        self.assertEqual(self.request(base + "/messages", answer)[0], 201)
        self.assertEqual(self.request(base + "/discussion")[1]["session"]["phase"], "discussing")
        self.assertEqual(self.request(base + "/topic", {"actor": "Codex", "phase": "reviewing"})[0], 400)
        self.session_action("end")
        self.assertTrue(self.request(base + "/messages", answer)[1]["duplicate"])
        ordinary = {"author": "Antigravity", "text": "自由协作原文", "submission_id": "late-chat-001"}
        status, saved = self.request(base + "/messages", ordinary)
        self.assertEqual((status, saved["message"]["kind"]), (201, "chat"))

    def test_concurrent_scheduling_accepts_only_one_plan_for_a_roster_revision(self):
        """Parallel host actions sharing a revision cannot both apply different plans."""
        self.configure_host()
        base=f"/api/rooms/{self.room['id']}"
        revision=self.request(base+"/turns/roster")[1]["revision"]
        def schedule(index):
            return self.request(base+"/turns",{"actor":"Codex","expert":"Antigravity","question":"并发安排","submission_id":f"schedule-race-{index}","roster":revision})
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
        payload = {"author": "Antigravity", "text": "并发回答", "request_ids": [turn["member_request_id"]]}
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
            return self.request(base+"/messages",{"author":"Antigravity","text":"正在提交的回答","request_ids":[plan["member_request_id"]],"submission_id":"cancel-race-001"})
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


class SessionGuardTests(unittest.TestCase):
    """Verify the discussion session state machine directly against isolated storage."""

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
                    {"name":"Antigravity","access":"runner","token":uuid.uuid4().hex}]},owner)
                initial=session_room(connection,room["id"])
                discussion_action(connection,room["id"],owner,{"action":"start","revision":initial["revision"],"goal":"守住事务"},room)
                roster=roster_view(connection,room["id"])
                payload={"actor":"Codex","expert":"Antigravity","question":"问题","roster":roster["revision"],"submission_id":"guard-plan-001"}
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


if __name__ == "__main__":
    unittest.main(verbosity=2)

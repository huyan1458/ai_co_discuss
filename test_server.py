"""Test CLI writes, read-only online instructions, and context provenance."""

import json
import os
import sqlite3
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from server import DiscussionServer, create_room, get_message, init_database, require_room


class DiscussionTests(unittest.TestCase):
    """Verify the observable POC workflow using isolated SQLite databases."""

    def setUp(self):
        """Use an explicit test Worker URL, or start isolated local storage."""
        self.base = os.getenv("DISCUSS_TEST_URL", "").rstrip("/")
        self.external = bool(self.base)
        if not self.external:
            self.directory = tempfile.TemporaryDirectory()
            self.database = Path(self.directory.name) / "test.sqlite3"
            init_database(self.database, seed=False)
            self.server = DiscussionServer(("127.0.0.1", 0), self.database)
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

    def request(self, path, payload=None, method=None):
        """Send a request and decode JSON or UTF-8 text, including error bodies."""
        data = json.dumps(payload).encode() if payload is not None else None
        request = Request(self.base + path, data=data, method=method)
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
        """Publish a user-assisted Claude message in the current test room."""
        return self.request(f"/api/rooms/{self.room['id']}/messages", {
            "author": "Claude", "text": text, "submission_id": submission_id, "reply_to": reply_to,
        })

    def test_manual_message_search_and_exact_history(self):
        """Unicode text, mentions, and reply links survive storage and retrieval."""
        status, result = self.post("@Codex 成本 = 100 & 条件 < 3\n原文", "manual-001")
        self.assertEqual(status, 201)
        message = result["message"]
        self.assertEqual(message["source"], "proxy")
        self.assertEqual(self.post("补充依据", "manual-002", message["id"])[0], 201)
        query = urlencode({"q": "成本", "mention": "Codex"})
        found = self.request(f"/api/rooms/{self.room['id']}/messages?{query}")[1]
        self.assertEqual(found["total"], 1)
        original = self.request(f"/r/{self.room['id']}/messages/{message['id']}")[1]
        self.assertIn("成本 = 100 & 条件 < 3\n原文", original)

    def test_frontend_assets_have_browser_compatible_content_types(self):
        """Both renderers load their compiled assets through the static routes."""
        assets = {"/": "text/html", "/app.js": "text/javascript", "/style.css": "text/css",
                  "/modern.js": "text/javascript", "/modern.css": "text/css"}
        for path, content_type in assets.items():
            with self.subTest(path=path), urlopen(self.base + path, timeout=5) as response:
                self.assertEqual(response.status, 200)
                self.assertTrue(response.headers["Content-Type"].startswith(content_type))
                self.assertTrue(response.read())

    def test_cli_publish_is_idempotent_and_rejects_changed_payload(self):
        """CLI POST retries preserve one record and its declared provenance."""
        self.request(f"/api/rooms/{self.room['id']}/topic", {
            "actor": "用户", "experts": {"Gemini": "cli"},
        })
        payload = {"author": "Gemini", "text": "CLI 原文 & #测试", "submission_id": "cli-once-001", "source": "cli"}
        path = f"/api/rooms/{self.room['id']}/messages"
        status, first = self.request(path, payload)
        self.assertEqual(status, 201)
        self.assertEqual(first["message"]["source"], "cli")
        status, repeated = self.request(path, payload)
        self.assertEqual(status, 200)
        self.assertTrue(repeated["duplicate"])
        self.assertEqual(first["message"], repeated["message"])
        self.assertEqual(self.request(f"/api/rooms/{self.room['id']}")[1]["message_count"], 1)
        payload["text"] = "另一条发言"
        self.assertEqual(self.request(path, payload)[0], 409)

    def test_simultaneous_cli_retries_create_one_record(self):
        """Concurrent replays cannot bypass the submission ID uniqueness rule."""
        payload = {"author": "Codex", "text": "并发重试", "submission_id": "parallel-001", "source": "cli"}
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
        """Default and unknown modes are read-only; CLI mode documents POST."""
        path = f"/r/{self.room['id']}"
        for suffix in ("", "?mode=online&participant=Codex", "?mode=unknown&participant=Gemini"):
            plain = self.request(path + suffix)[1]
            self.assertIn("在线 AI · 只读参与", plain)
            self.assertNotIn("POST /api/", plain)
            self.assertNotIn("/publish?", plain)
        plain = self.request(path + "?mode=cli&participant=Gemini")[1]
        self.assertIn("本地 CLI AI · 可读可写", plain)
        self.assertIn(f"POST /api/rooms/{self.room['id']}/messages", plain)
        self.assertIn('source（填写 "cli"）', plain)
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

    def configure_host(self):
        """Set Codex as both host and CLI expert, leaving Gemini read-only."""
        status, room = self.request(f"/api/rooms/{self.room['id']}/topic", {
            "actor": "用户", "host": "Codex", "phase": "discussing",
            "experts": {"Codex": "cli", "Gemini": "online"},
        })
        self.assertEqual(status, 200)
        return room

    def schedule(self, submission_id="schedule-001", **changes):
        """Schedule a read-only expert using the declared host identity."""
        payload = {"actor": "Codex", "expert": "Gemini", "question": "请检查尚未解决的分歧", "submission_id": submission_id}
        return self.request(f"/api/rooms/{self.room['id']}/turns", {**payload, **changes})

    def test_topic_host_requires_write_capability_and_preserves_metadata(self):
        """Topic hosting is a role independent of the model name."""
        path = f"/api/rooms/{self.room['id']}/topic"
        self.assertEqual(self.request(path, {"actor": "用户", "host": "Gemini"})[0], 400)
        room = self.configure_host()
        self.assertEqual(room["host"], "Codex")
        self.assertEqual(room["experts"]["Codex"], "cli")
        self.assertEqual(self.request(path, {"actor": "Gemini", "focus": "错误操作"})[0], 400)
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
        self.assertIn("submitted_by=Codex", self.request(base + "/protocol")[1])

    def test_host_opinion_moderation_and_forwarded_authorship_are_distinct(self):
        """Host duties do not replace expert attribution or imply consensus."""
        self.configure_host()
        path = f"/api/rooms/{self.room['id']}/messages"
        payload = {"author": "Codex", "text": "个人观点", "source": "cli", "submission_id": "host-opinion-001"}
        opinion = self.request(path, payload)[1]["message"]
        self.assertEqual((opinion["kind"], opinion["source"]), ("opinion", "cli"))
        moderation = self.request(path, {**payload, "text": "请回到议题", "kind": "moderation", "submission_id": "host-control-001"})[1]["message"]
        self.assertEqual(moderation["kind"], "moderation")
        forwarded = {"author": "Gemini", "submitted_by": "Codex", "text": "在线专家原文 & 引用", "reply_to": opinion["id"], "submission_id": "host-forward-001"}
        status, result = self.request(path, forwarded)
        self.assertEqual(status, 201)
        message = result["message"]
        self.assertEqual((message["author"], message["submitted_by"], message["source"]), ("Gemini", "Codex", "host_proxy"))
        self.assertEqual(self.request(path, {**forwarded, "submitted_by": "Claude", "submission_id": "bad-forward-001"})[0], 400)
        self.assertEqual(self.request(path, {**forwarded, "submitted_by": "Gemini", "source": "cli", "submission_id": "bad-online-001"})[0], 400)
        self.assertEqual(self.request(path, {**forwarded, "kind": "moderation", "submission_id": "bad-role-001"})[0], 400)
        original = self.request(f"/r/{self.room['id']}/messages/{message['id']}")[1]
        self.assertIn("提交者：Codex", original)
        self.assertIn("在线专家原文 & 引用", original)

    def test_turn_notification_answer_and_retry_lifecycle(self):
        """Reading is not notification; a linked expert answer completes a turn."""
        self.configure_host()
        status, created = self.schedule()
        self.assertEqual(status, 201)
        turn = created["turn"]
        path = f"/api/rooms/{self.room['id']}/turns/{turn['id']}"
        self.assertEqual(turn["status"], "pending")
        self.assertTrue(self.schedule()[1]["duplicate"])
        self.assertEqual(self.schedule(question="另一问题")[0], 409)
        self.assertEqual(self.schedule("schedule-next-001")[0], 409)
        self.request(f"/r/{self.room['id']}/turns/{turn['id']}")
        self.assertEqual(self.request(path)[1]["status"], "pending")
        self.assertEqual(self.request(path, {"actor": "Codex", "status": "notified"})[1]["status"], "notified")
        payload = {"author": "Gemini", "submitted_by": "Codex", "text": "专家的回答", "turn_id": turn["id"], "submission_id": "turn-answer-001"}
        message_path = f"/api/rooms/{self.room['id']}/messages"
        result = self.request(message_path, payload)[1]
        self.assertEqual(self.request(path)[1]["answer_id"], result["message"]["id"])
        self.assertEqual(self.request(path)[1]["status"], "answered")
        self.assertTrue(self.request(message_path, payload)[1]["duplicate"])
        self.assertEqual(self.request(path, {"actor": "Codex", "status": "cancelled"})[0], 409)
        self.assertEqual(self.schedule("schedule-next-001")[0], 201)

    def test_turn_cancellation_phase_and_cross_room_constraints(self):
        """Cancelled assignments cannot receive answers or cross room boundaries."""
        self.configure_host()
        turn = self.schedule()[1]["turn"]
        topic_path = f"/api/rooms/{self.room['id']}/topic"
        self.assertEqual(self.request(topic_path, {"actor": "Codex", "phase": "concluded"})[0], 400)
        other = self.request("/api/rooms", {"title": "另一个话题"})[1]
        self.assertEqual(self.request(f"/api/rooms/{other['id']}/turns/{turn['id']}")[0], 404)
        path = f"/api/rooms/{self.room['id']}/messages"
        self.assertEqual(self.request(path, {"author": "Codex", "source": "cli", "text": "错误专家", "turn_id": turn["id"], "submission_id": "wrong-expert-001"})[0], 400)
        self.request(f"/api/rooms/{self.room['id']}/turns/{turn['id']}", {"actor": "Codex", "status": "cancelled"})
        self.assertEqual(self.request(path, {"author": "Gemini", "text": "迟到回答", "turn_id": turn["id"], "submission_id": "late-answer-001"})[0], 409)
        self.assertEqual(self.request(topic_path, {"actor": "Codex", "phase": "concluded"})[0], 200)
        self.assertEqual(self.schedule("closed-topic-001")[0], 400)

    def test_independent_pause_review_and_receipt_lifecycle(self):
        """Pausing retains the assignment; receipts never answer it or reopen discussion."""
        self.configure_host()
        base = f"/api/rooms/{self.room['id']}"
        self.assertEqual(self.request(base + "/topic", {"actor": "Codex", "phase": "initial"})[0], 200)
        self.assertIn("先独立形成详细观点", self.request(f"/r/{self.room['id']}")[1])
        turn = self.schedule()[1]["turn"]
        answer = {"author": "Gemini", "text": "独立结论及依据", "turn_id": turn["id"], "submission_id": "initial-answer-001"}
        self.request(base + "/topic", {"actor": "Codex", "phase": "paused"})
        self.assertEqual(self.request(base + "/messages", answer)[0], 400)
        self.assertEqual(self.schedule("paused-turn-001")[0], 400)
        self.assertEqual(self.request(base + f"/turns/{turn['id']}", {"actor": "Codex", "status": "notified"})[0], 400)
        receipt = {"author": "Gemini", "kind": "receipt", "text": "run=test；任务 task-1 已停止，工具结果 confirmed", "submission_id": "stop-receipt-001"}
        self.assertEqual(self.request(base + "/messages", {**receipt, "turn_id": turn["id"]})[0], 400)
        result = self.request(base + "/messages", receipt)
        self.assertEqual(result[0], 201)
        self.assertEqual(self.request(base)[1]["current_turn"]["status"], "pending")
        self.assertIn("运行回执", self.request(f"/r/{self.room['id']}/messages/{result[1]['message']['id']}")[1])
        self.request(base + "/topic", {"actor": "Codex", "phase": "initial"})
        self.assertEqual(self.request(base + "/messages", answer)[0], 201)
        self.assertEqual(self.request(base + "/topic", {"actor": "Codex", "phase": "reviewing"})[0], 200)
        self.assertEqual(self.request(base + "/topic", {"actor": "Codex", "phase": "concluded"})[0], 200)
        self.assertTrue(self.request(base + "/messages", answer)[1]["duplicate"])
        self.assertEqual(self.request(base + "/messages", {**answer, "turn_id": None, "submission_id": "late-opinion-001"})[0], 400)
        self.assertEqual(self.request(base + "/messages", {**receipt, "submission_id": "final-receipt-001"})[0], 201)
        self.assertEqual(self.request(base + "/messages", {"author": "Codex", "kind": "moderation", "text": "结论及清理缺项", "submission_id": "final-summary-001"})[0], 201)

    def test_concurrent_scheduling_creates_only_one_open_turn(self):
        """Parallel host actions cannot create conflicting active assignments."""
        self.configure_host()
        with ThreadPoolExecutor(max_workers=5) as executor:
            results = list(executor.map(lambda index: self.schedule(f"schedule-race-{index}"), range(5)))
        self.assertEqual(sorted(status for status, _ in results), [201, 409, 409, 409, 409])
        self.assertEqual(self.request(f"/api/rooms/{self.room['id']}/turns")[1]["total"], 1)

    def test_concurrent_answers_preserve_one_attributed_original(self):
        """One assignment accepts only one answer even with different submissions."""
        self.configure_host()
        turn = self.schedule()[1]["turn"]
        payload = {"author": "Gemini", "submitted_by": "Codex", "text": "并发回答", "turn_id": turn["id"]}
        path = f"/api/rooms/{self.room['id']}/messages"
        with ThreadPoolExecutor(max_workers=5) as executor:
            results = list(executor.map(lambda index: self.request(path, {**payload, "submission_id": f"answer-race-{index}"}), range(5)))
        self.assertEqual(sorted(status for status, _ in results), [201, 409, 409, 409, 409])
        self.assertEqual(self.request(f"/api/rooms/{self.room['id']}")[1]["message_count"], 1)

    def test_cancellation_racing_an_answer_keeps_consistent_state(self):
        """A cancellation and answer cannot both win for the same assignment."""
        self.configure_host()
        turn = self.schedule()[1]["turn"]
        barrier = threading.Barrier(2)

        def cancel_or_answer(cancel):
            barrier.wait()
            if cancel:
                return self.request(f"/api/rooms/{self.room['id']}/turns/{turn['id']}", {"actor": "Codex", "status": "cancelled"})
            return self.request(f"/api/rooms/{self.room['id']}/messages", {
                "author": "Gemini", "text": "正在提交的回答", "submitted_by": "Codex", "turn_id": turn["id"], "submission_id": "cancel-race-001",
            })

        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(cancel_or_answer, [True, False]))
        room = self.request(f"/api/rooms/{self.room['id']}")[1]
        if room["current_turn"]["status"] == "cancelled":
            self.assertEqual([status for status, _ in results], [200, 409])
            self.assertEqual(room["message_count"], 0)
        else:
            self.assertEqual([status for status, _ in results], [409, 201])
            self.assertEqual(room["message_count"], 1)


class LegacyStorageTests(unittest.TestCase):
    """Verify additive migration from the actual pre-host schema."""

    def test_database_guards_cover_phase_changes_after_a_client_read(self):
        """Atomic writes reject stale actions even if the adapter read an older phase."""
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "phase.sqlite3"
            init_database(database, seed=False)
            with closing(sqlite3.connect(database)) as connection:
                connection.row_factory = sqlite3.Row
                room = create_room(connection, {"title": "并发阶段校验", "phase": "paused"})
                connection.commit()
                with self.assertRaisesRegex(sqlite3.IntegrityError, "topic_inactive"), connection:
                    message = connection.execute("INSERT INTO messages(room_id,author,text,source,submission_id,created_at) VALUES (?,'Codex','迟到观点','cli','late-opinion-001','test')", (room["id"],))
                    connection.execute("INSERT INTO message_details(message_id,kind,submitted_by) VALUES (?,'opinion','Codex')", (message.lastrowid,))
                self.assertEqual(connection.execute("SELECT COUNT(*) FROM messages").fetchone()[0], 0)
                turn_sql = "INSERT INTO discussion_turns(room_id,expert,question,submission_id,created_at) VALUES (?,'Codex','问题','late-turn-001','test')"
                with self.assertRaisesRegex(sqlite3.IntegrityError, "topic_inactive"), connection:
                    connection.execute(turn_sql, (room["id"],))
                with connection:
                    connection.execute("UPDATE topic_settings SET phase='discussing' WHERE room_id=?", (room["id"],))
                    connection.execute(turn_sql, (room["id"],))
                with self.assertRaisesRegex(sqlite3.IntegrityError, "open_turn"), connection:
                    connection.execute("UPDATE topic_settings SET phase='concluded' WHERE room_id=?", (room["id"],))
                self.assertEqual(require_room(connection, room["id"])["phase"], "discussing")

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


if __name__ == "__main__":
    unittest.main(verbosity=2)

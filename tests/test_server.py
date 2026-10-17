"""Test CLI writes, read-only online instructions, and context provenance."""

import json
import os
import sqlite3
import tempfile
import threading
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from urllib.robotparser import RobotFileParser

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
        """Publish an unrestricted user record for storage and reading fixtures."""
        return self.request(f"/api/rooms/{self.room['id']}/messages", {
            "author": "用户", "text": text, "submission_id": submission_id, "reply_to": reply_to,
        })

    def test_channel_order_and_rename_survive_reload(self):
        """Moves persist without losing new rooms; rename retains IDs and content."""
        original = self.post("原文保留", "rename-original")[1]["message"]
        second = self.request("/api/rooms", {"title": "频道乙"})[1]
        third = self.request("/api/rooms", {"title": "频道丙"})[1]
        path = f"/api/rooms/{third['id']}/move"
        self.assertEqual(self.request(path, {"actor": "Claude", "before_id": self.room["id"]})[0], 400)
        self.assertEqual(self.request(path, {"actor": "用户", "before_id": "missing"})[0], 400)
        self.assertEqual(self.request(path, {"actor": "用户", "before_id": self.room["id"]})[0], 200)
        base = f"/api/rooms/{self.room['id']}"
        self.assertEqual(self.request(base + "/topic", {"actor": "用户", "title": "重命名 <& 中文"})[0], 200)
        if not self.external:
            init_database(self.database)
        ids = [item["id"] for item in self.request("/api/rooms")[1]["rooms"]]
        self.assertLess(ids.index(third["id"]), ids.index(self.room["id"]))
        self.assertLess(ids.index(self.room["id"]), ids.index(second["id"]))
        self.assertEqual(self.request(base)[1]["title"], "重命名 <& 中文")
        self.assertEqual(self.request(base + f"/messages/{original['id']}")[1]["text"], original["text"])
        self.assertEqual(self.request(path, {"actor": "用户", "before_id": None})[0], 200)
        self.assertEqual(self.request("/api/rooms")[1]["rooms"][-1]["id"], third["id"])

    def test_archive_preserves_pending_turn_and_requires_explicit_resume(self):
        """Archive pauses writes, retains evidence, and restoration never resumes work."""
        self.configure_host()
        original = self.post("存档原文", "archive-original")[1]["message"]
        turn = self.schedule()[1]["turn"]
        base = f"/api/rooms/{self.room['id']}"
        status, archived = self.request(base + "/archive", {"actor": "用户"})
        self.assertEqual((status, bool(archived["archived"]), archived["phase"]), (200, True, "paused"))
        self.assertEqual(archived["current_turn"]["id"], turn["id"])
        self.assertEqual(self.post("拒绝新观点", "archived-new-001")[0], 400)
        self.assertEqual(self.request(base + "/topic", {"actor": "用户", "phase": "discussing"})[0], 400)
        self.assertEqual(self.request(base + "/messages", {"author": "用户", "kind": "receipt", "text": "已停止任务", "submission_id": "archive-receipt"})[0], 201)
        self.assertEqual(self.request(base + f"/messages/{original['id']}")[1]["text"], "存档原文")
        if not self.external:
            init_database(self.database)
        self.assertTrue(self.request(base)[1]["archived"])
        restored = self.request(base + "/restore", {"actor": "用户"})[1]
        self.assertEqual((bool(restored["archived"]), restored["phase"]), (False, "paused"))
        self.assertEqual(self.request(base + "/topic", {"actor": "用户", "phase": "discussing"})[0], 200)
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

    def test_delete_removes_related_records_and_leaves_other_channels(self):
        """Wrong confirmations preserve content; deletion removes linked data atomically."""
        self.configure_host()
        original = self.post("删除测试原文", "delete-original")[1]["message"]
        self.post("引用原文", "delete-reply-001", original["id"])
        turn = self.schedule()[1]["turn"]
        base = f"/api/rooms/{self.room['id']}"
        answer = {"author": "Gemini", "text": "回答", "summary": "回答摘要", "submission_id": "delete-answer-001", "turn_id": turn["id"]}
        self.floor("take", "Gemini", "Codex")
        self.assertEqual(self.request(base + "/messages", answer)[0], 201)
        self.assertEqual(self.request(base + "/state", {"actor": "Codex", "text": "状态", "brief": "主持简报"})[0], 200)
        other = self.request("/api/rooms", {"title": "保留频道"})[1]
        self.assertEqual(self.request(base + "/delete", {"actor": "用户", "confirm_title": "错误"})[0], 400)
        self.assertEqual(self.request(base + "/delete", {"actor": "Gemini", "confirm_title": self.room["title"]})[0], 400)
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
        payload = {"author": "Gemini", "submitted_by": "Codex", "text": "完整回答", "turn_id": turn["id"],
                   "summary": "🙂" * 1000, "submission_id": "summary-validation"}
        for change in ({"summary": "🙂" * 1001}, {"summary_by": "Claude"}, {"kind": "receipt", "turn_id": None}):
            self.assertEqual(self.request(base + "/messages", {**payload, **change})[0], 400)
        self.assertEqual(self.request(base)[1]["current_turn"]["status"], "pending")
        self.assertEqual(self.request(base)[1]["message_count"], 0)
        self.assertEqual(self.floor("take", "Gemini", "Codex")[0], 200)
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
            self.assertEqual(self.request(base + "/state", {**payload, **change})[0], 400)
        self.assertEqual(self.request(base)[1]["state_text"], "旧客户端的新状态")
        self.assertEqual(self.request(base)[1]["host_brief"], brief)
        self.assertNotIn(payload["brief"], self.request(f"/r/{self.room['id']}?mode=cli")[1])
        self.assertIn(payload["brief"], self.request(f"/r/{self.room['id']}/state")[1])

    def test_answered_assignment_count_excludes_other_records(self):
        """Cancelled assignments, receipts and free opinions do not inflate the answered tally."""
        self.configure_host()
        base = f"/api/rooms/{self.room['id']}"
        cancelled = self.schedule("round-cancelled")[1]["turn"]
        self.request(base + f"/turns/{cancelled['id']}", {"actor": "用户", "status": "cancelled"})
        self.post("没有关联安排的观点", "round-free")
        self.floor("take")
        self.request(base + "/messages", {"author": "Codex", "kind": "receipt", "text": "运行回执", "submission_id": "round-receipt"})
        self.floor("take")
        turn = self.schedule("round-answered")[1]["turn"]
        self.assertEqual(self.request(base)[1]["answered_turns"], 0)
        self.floor("take", "Gemini", "Codex")
        self.request(base + "/messages", {"author": "Gemini", "text": "本轮回答", "summary": "简短摘要", "turn_id": turn["id"], "submission_id": "round-answer"})
        self.assertEqual(self.request(base)[1]["answered_turns"], 1)
        self.floor("take")
        pending = self.schedule("round-pending")[1]["turn"]
        room = self.request(base)[1]
        self.assertEqual((room["answered_turns"], room["current_turn"]["id"]), (1, pending["id"]))

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
        """Both renderers load their compiled assets through the static routes."""
        assets = {"/": "text/html", "/app.js": "text/javascript", "/style.css": "text/css",
                  "/modern.js": "text/javascript", "/modern.css": "text/css",
                  "/markdown.js": "text/javascript", "/markdown.css": "text/css",
                  "/icons/LICENSE.txt": "text/plain"}
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
        """CLI POST retries preserve one record and its declared provenance."""
        self.request(f"/api/rooms/{self.room['id']}/topic", {
            "actor": "用户", "experts": {"Gemini": "cli"},
        })
        payload = {"author": "Gemini", "text": "CLI 原文 & #测试", "submission_id": "cli-once-001", "source": "cli"}
        payload.update(self.prepare_speech("Gemini"))
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
        self.request(f"/api/rooms/{room['id']}/topic", {"actor": "用户", "title": "后来修改", "phase": "paused"})
        replay = self.request("/api/rooms", payload)
        self.assertEqual((replay[0], replay[1]["title"], replay[1]["phase"]), (200, "后来修改", "paused"))
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
                   "turn_id": turn["id"], "submission_id": "unicode-long-answer"}
        self.assertEqual(self.request(base + "/messages", payload)[0], 400)
        self.assertEqual(self.request(base)[1]["current_turn"]["status"], "pending")
        payload["text"] = "🙂" * 32000
        self.floor("take", "Gemini", "Codex")
        status, result = self.request(base + "/messages", payload)
        self.assertEqual(status, 201)
        self.assertEqual(self.request(base + f"/messages/{result['message']['id']}")[1]["text"], payload["text"])
        self.assertEqual(self.request(base)[1]["current_turn"]["answer_id"], result["message"]["id"])
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

    def test_latest_receipts_survive_late_arrival_and_history_pagination(self):
        """Late reports remain discoverable without silently changing an older summary."""
        self.configure_host()
        base = f"/api/rooms/{self.room['id']}"
        self.assertEqual(self.request(base)[1]["latest_receipts"], [])
        first = self.request(base + "/messages", {"author": "Codex", "kind": "receipt", "text": "旧运行已启动", "submission_id": "old-start"})[1]["message"]
        self.request(base + "/state", {"text": "本次清理待确认", "until": first["id"]})
        for index in range(21):
            self.post(f"历史观点 {index}", f"receipt-history-{index}")
        self.request(base + "/topic", {"actor": "用户", "phase": "concluded"})
        self.floor("take")
        late = self.request(base + "/messages", {"author": "Codex", "kind": "receipt", "text": "本次运行已停止，任务 task-2", "submission_id": "late-stop"})[1]["message"]
        other = self.request(base + "/messages", {"author": "用户", "kind": "receipt", "text": "运行结果仍待核验", "submission_id": "other-stop"})[1]["message"]
        foreign = self.request("/api/rooms", {"title": "另一房间", "host": "Codex"})[1]
        self.request(f"/api/rooms/{foreign['id']}/messages", {"author": "Codex", "kind": "receipt", "text": "不应出现在目标房间", "submission_id": "foreign-stop"})
        room = self.request(base)[1]
        self.assertEqual((room["state_text"], room["state_until"], room["phase"]), ("本次清理待确认", first["id"], "concluded"))
        self.assertEqual([row["id"] for row in room["latest_receipts"]], [late["id"], other["id"]])
        self.assertTrue(all(set(row) == {"id", "author", "created_at", "submitted_by"} for row in room["latest_receipts"]))
        self.assertNotIn(late["id"], [row["id"] for row in self.request(base + "/messages?page=1")[1]["messages"]])
        plain = self.request(f"/r/{self.room['id']}/state")[1]
        self.assertIn("晚于摘要", plain)
        self.assertIn(f"/messages/{late['id']}", plain)
        self.assertNotIn(late["text"], plain)
        self.assertEqual(self.request(base + f"/messages/{late['id']}")[1]["text"], late["text"])

    def test_pending_labels_follow_participation_without_claiming_delivery(self):
        """Local discovery and external contact share pending without inventing notification."""
        self.configure_host()
        base = f"/api/rooms/{self.room['id']}"
        for expert, expected in (("Codex", "待处理（本地 CLI）"), ("Gemini", "待联系（在线专家）")):
            if self.floor()["holder"] is None:
                self.floor("take")
            turn = self.schedule(f"label-{expert}", expert=expert)[1]["turn"]
            current = self.request(base)[1]["current_turn"]
            self.assertEqual((current["status"], current["notified_at"], current["status_label"]), ("pending", "", expected))
            self.assertIn(expected, self.request(f"/r/{self.room['id']}/turns/{turn['id']}")[1])
            self.request(base + f"/turns/{turn['id']}", {"actor": "用户", "status": "cancelled"})

    def floor(self, action=None, speaker="Codex", actor=None, revision=None):
        """Inspect or explicitly operate the current test room's floor."""
        path = f"/api/rooms/{self.room['id']}/floor"
        current = self.request(path)[1]
        if action is None:
            return current
        return self.request(path, {"action": action, "speaker": speaker, "actor": actor or speaker,
                                   "revision": current["revision"] if revision is None else revision})

    def prepare_speech(self, author, kind="opinion"):
        """Arrange and claim a valid speech explicitly for non-floor regression cases."""
        if author == "用户":
            return {}
        base = f"/api/rooms/{self.room['id']}"
        room = self.request(base)[1]
        turn = room["current_turn"]
        if turn and turn["status"] in ("pending", "notified"):
            self.assertEqual(self.request(base + f"/turns/{turn['id']}", {"actor": "用户", "status": "cancelled"})[0], 200)
        floor = self.floor()
        if floor["holder"] and floor["holder"] != room["host"]:
            self.assertEqual(self.floor("return", floor["holder"], "用户")[0], 200)
        if self.floor()["holder"] is None:
            self.assertEqual(self.floor("take", room["host"], "用户")[0], 200)
        if kind != "opinion" and author == room["host"]:
            return {}
        status, result = self.request(base + "/turns", {"actor": room["host"], "expert": author,
            "question": "为回归测试准备有效发言", "submission_id": str(uuid.uuid4())})
        self.assertEqual(status, 201, result)
        self.assertEqual(self.floor("take", author, "用户")[0], 200)
        return {"turn_id": result["turn"]["id"]} if kind == "opinion" else {}

    def test_floor_serial_handoff_proxy_and_user_interjection(self):
        """Only the nominated expert speaks; proxy and user identities stay distinct."""
        self.configure_host()
        base = f"/api/rooms/{self.room['id']}"
        self.assertEqual(self.floor()["holder"], "Codex")
        turn = self.schedule()[1]["turn"]
        self.assertEqual(self.floor()["next_speaker"], turn["expert"])
        self.assertIsNone(self.floor()["holder"])
        self.assertEqual(self.floor("take", "Qwen")[0], 409)
        answer = {"author": turn["expert"], "submitted_by": "用户", "kind": "opinion",
                  "text": "被点名者的真实回答", "submission_id": "floor-answer", "turn_id": turn["id"]}
        self.assertEqual(self.request(base + "/messages", answer)[0], 409)
        self.assertEqual(self.floor("take", turn["expert"], "Codex")[0], 200)
        held = self.floor()
        self.assertEqual(self.request(base + "/messages", {"author": "用户", "text": "补充约束", "submission_id": "floor-user"})[0], 201)
        self.assertEqual(self.floor(), held)
        self.assertEqual(self.request(base + "/messages", {"author": "Codex", "kind": "moderation", "text": "越序主持", "submission_id": "floor-host"})[0], 409)
        self.assertEqual(self.request(base + "/messages", answer)[0], 201)
        self.assertEqual((self.floor()["holder"], self.floor()["next_speaker"]), (None, "Codex"))
        self.assertEqual(self.floor("take")[0], 200)
        held = self.floor()
        self.assertTrue(self.request(base + "/messages", answer)[1]["duplicate"])
        self.assertEqual(self.floor(), held)

    def test_floor_race_failed_write_and_stale_return(self):
        """Competing claims and stale returns never steal a subsequent lease."""
        self.configure_host()
        self.assertEqual(self.floor("return")[0], 200)
        revision = self.floor()["revision"]
        with ThreadPoolExecutor(max_workers=2) as pool:
            statuses = list(pool.map(lambda _: self.floor("take", revision=revision)[0], range(2)))
        self.assertEqual(sorted(statuses), [200, 409])
        held = self.floor()
        self.assertEqual(self.floor("return", revision=revision)[0], 409)
        self.assertEqual(self.floor(), held)
        base = f"/api/rooms/{self.room['id']}"
        invalid = {"author": "Codex", "kind": "opinion", "text": "没有安排", "submission_id": "floor-invalid"}
        self.assertEqual(self.request(base + "/messages", invalid)[0], 400)
        self.assertEqual(self.floor(), held)
        self.assertEqual(self.request(base + "/messages", {**invalid, "kind": "moderation"})[0], 201)
        self.assertIsNone(self.floor()["holder"])
        self.assertEqual(self.schedule("floor-no-holder")[0], 409)

    def test_floor_host_expert_and_arrangement_retry(self):
        """A host speaking as expert takes the nominated floor like every expert."""
        self.configure_host()
        turn = self.schedule("floor-self", expert="Codex")[1]["turn"]
        nominated = self.floor()
        self.assertTrue(self.schedule("floor-self", expert="Codex")[1]["duplicate"])
        self.assertEqual(self.floor(), nominated)
        self.assertEqual(self.floor("take")[0], 200)
        held = self.floor()
        self.assertTrue(self.schedule("floor-self", expert="Codex")[1]["duplicate"])
        self.assertEqual(self.floor(), held)
        answer = {"author": "Codex", "source": "cli", "kind": "opinion", "text": "独立观点",
                  "turn_id": turn["id"], "submission_id": "floor-self-answer"}
        self.assertEqual(self.request(f"/api/rooms/{self.room['id']}/messages", answer)[0], 201)
        self.assertIsNone(self.floor()["holder"])

    def test_floor_host_cannot_take_local_expert_or_cancel_while_held(self):
        """A host cannot take a local expert's floor or revoke it through cancellation."""
        base = f"/api/rooms/{self.room['id']}"
        self.request(base + "/topic", {"actor": "用户", "host": "Codex", "experts": {"Codex": "cli", "Gemini": "cli"}})
        turn = self.schedule("floor-local")[1]["turn"]
        self.assertEqual(self.floor("take", "Gemini", "Codex")[0], 400)
        self.assertEqual(self.floor("take", "Gemini")[0], 200)
        held = self.floor()
        self.assertEqual(self.floor("return", "Gemini", "Codex")[0], 400)
        self.assertEqual(self.request(base + f"/turns/{turn['id']}", {"actor": "Codex", "status": "cancelled"})[0], 409)
        self.assertEqual(self.floor(), held)
        self.assertEqual(self.floor("return", "Gemini")[0], 200)
        self.assertEqual(self.floor("take")[0], 200)
        self.assertEqual(self.request(base + f"/turns/{turn['id']}", {"actor": "Codex", "status": "cancelled"})[0], 200)
        self.assertIsNone(self.floor()["holder"])

    def test_floor_failed_answer_does_not_release_or_allow_unauthorized_proxy(self):
        """Attribution failures retain the lease; a competing expert cannot use it."""
        self.configure_host()
        turn = self.schedule("floor-attribution")[1]["turn"]
        self.floor("take", "Gemini", "Codex")
        held = self.floor()
        payload = {"author": "Gemini", "submitted_by": "Claude", "text": "错误代发",
                   "turn_id": turn["id"], "submission_id": "floor-bad-proxy"}
        self.assertEqual(self.request(f"/api/rooms/{self.room['id']}/messages", payload)[0], 400)
        self.assertEqual(self.floor(), held)
        self.assertEqual(self.floor("take", "Qwen")[0], 409)

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
        payload.update(self.prepare_speech("Codex"))
        opinion = self.request(path, payload)[1]["message"]
        self.assertEqual((opinion["kind"], opinion["source"]), ("opinion", "cli"))
        self.prepare_speech("Codex", "moderation")
        moderation = self.request(path, {**payload, "turn_id": None, "text": "请回到议题", "kind": "moderation", "submission_id": "host-control-001"})[1]["message"]
        self.assertEqual(moderation["kind"], "moderation")
        forwarded = {"author": "Gemini", "submitted_by": "Codex", "text": "在线专家原文 & 引用", "reply_to": opinion["id"], "submission_id": "host-forward-001"}
        forwarded.update(self.prepare_speech("Gemini"))
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

    def test_rounds_require_all_experts_and_ignore_other_roles(self):
        """Repeats, receipts and moderation cannot replace a missing expert."""
        base = f"/api/rooms/{self.room['id']}"
        experts = {"Codex": "cli", "Gemini": "online", "DeepSeek": "online"}
        self.request(base + "/topic", {"actor": "用户", "host": "Codex", "experts": experts})
        records = [("Codex", "moderation"), ("用户", "opinion"), ("用户", "opinion"),
                   ("Gemini", "receipt"), ("Codex", "opinion"), ("Codex", "opinion"),
                   ("Gemini", "opinion"), ("DeepSeek", "opinion")]
        messages = []
        for index, (author, kind) in enumerate(records):
            association = self.prepare_speech(author, kind)
            status, result = self.request(base + "/messages", {
                **association,
                "author": author, "kind": kind, "text": f"完整观点或记录 {index}",
                "submission_id": f"round-record-{index:03d}"})
            self.assertEqual(status, 201)
            messages.append(result["message"])
            room = self.request(base)[1]
            self.assertEqual(room["completed_rounds"], int(index == len(records) - 1))
            if index < 4:
                self.assertEqual(room["rounds"], [])
        self.assertEqual(room["rounds"], [{"number": 1, "start_id": messages[0]["id"],
                                         "speakers": list(experts), "completed": True}])
        self.assertEqual(room["answered_turns"], 4)
        self.prepare_speech("Gemini", "receipt")
        receipt = self.request(base + "/messages", {"author": "Gemini", "kind": "receipt",
            "text": "停止回执", "submission_id": "round-final-receipt"})[1]["message"]
        self.assertEqual(self.request(base)[1]["rounds"], room["rounds"])
        association = self.prepare_speech("Gemini")
        self.request(base + "/messages", {**association, "author": "Gemini", "text": "下一轮完整观点",
            "submission_id": "round-next-opinion"})
        latest = self.request(base)[1]
        self.assertEqual(latest["completed_rounds"], 1)
        self.assertEqual(latest["rounds"][-1], {"number": 2, "start_id": receipt["id"],
                                               "speakers": ["Gemini"], "completed": False})
        self.assertIn("已完成 1 轮讨论", self.request(f"/r/{self.room['id']}")[1])

    def test_round_boundaries_survive_pagination_and_filters(self):
        """Navigation uses full history even if a round crosses a result page."""
        base = f"/api/rooms/{self.room['id']}"
        self.request(base + "/topic", {"actor": "用户", "experts": {"Codex": "cli", "Gemini": "online"}})
        records = [("Codex", "opinion")] * 18 + [("Gemini", "opinion"),
            ("用户", "moderation"), ("Codex", "opinion"), ("Gemini", "opinion"), ("Codex", "receipt")]
        messages = []
        for index, (author, kind) in enumerate(records):
            association = self.prepare_speech(author, kind)
            status, result = self.request(base + "/messages", {**association, "author": author, "kind": kind,
                "text": f"分页轮次记录 {index}", "submission_id": f"round-page-{index:03d}"})
            self.assertEqual(status, 201)
            messages.append(result["message"])
        expected = [{"number": 1, "start_id": messages[0]["id"], "speakers": ["Codex", "Gemini"], "completed": True},
                    {"number": 2, "start_id": messages[19]["id"], "speakers": ["Codex", "Gemini"], "completed": True}]
        for query in ("page=1", "page=2", "author=Gemini", "kind=receipt", "q=no-matching-round-record"):
            self.assertEqual(self.request(base + "/messages?" + query)[0], 200)
            self.assertEqual(self.request(base)[1]["rounds"], expected)
        room = self.request(base)[1]
        self.assertEqual(room["completed_rounds"], 2)
        self.assertEqual(self.request(base + "/messages?page=2")[1]["messages"][0]["id"], messages[20]["id"])
        pending = room["current_turn"]
        self.request(base + f"/turns/{pending['id']}", {"actor": "用户", "status": "cancelled"})
        self.request(base + "/topic", {"actor": "用户", "experts": {}})
        room = self.request(base)[1]
        self.assertEqual((room["rounds"], room["completed_rounds"]), ([], 0))

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
        self.floor("take", "Gemini", "Codex")
        message_path = f"/api/rooms/{self.room['id']}/messages"
        result = self.request(message_path, payload)[1]
        self.assertEqual(self.request(path)[1]["answer_id"], result["message"]["id"])
        self.assertEqual(self.request(path)[1]["status"], "answered")
        self.assertTrue(self.request(message_path, payload)[1]["duplicate"])
        self.assertEqual(self.request(path, {"actor": "Codex", "status": "cancelled"})[0], 409)
        self.floor("take")
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
        self.request(f"/api/rooms/{self.room['id']}/turns/{turn['id']}", {"actor": "用户", "status": "cancelled"})
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
        self.floor("take", "Gemini", "Codex")
        self.assertEqual(self.request(base + "/messages", {**receipt, "turn_id": turn["id"]})[0], 400)
        result = self.request(base + "/messages", receipt)
        self.assertEqual(result[0], 201)
        self.assertEqual(self.request(base)[1]["current_turn"]["status"], "pending")
        self.assertIn("运行回执", self.request(f"/r/{self.room['id']}/messages/{result[1]['message']['id']}")[1])
        self.request(base + "/topic", {"actor": "Codex", "phase": "initial"})
        answer.update(self.prepare_speech("Gemini"))
        self.assertEqual(self.request(base + "/messages", answer)[0], 201)
        self.assertEqual(self.request(base + "/topic", {"actor": "Codex", "phase": "reviewing"})[0], 200)
        self.assertEqual(self.request(base + "/topic", {"actor": "Codex", "phase": "concluded"})[0], 200)
        self.assertTrue(self.request(base + "/messages", answer)[1]["duplicate"])
        self.assertEqual(self.request(base + "/messages", {**answer, "turn_id": None, "submission_id": "late-opinion-001"})[0], 400)
        self.assertEqual(self.request(base + "/messages", {**receipt, "submission_id": "final-receipt-001"})[0], 409)
        self.floor("take")
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
        self.floor("take", "Gemini", "Codex")
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
        self.floor("take", "Gemini", "Codex")

        def cancel_or_answer(cancel):
            barrier.wait()
            if cancel:
                return self.request(f"/api/rooms/{self.room['id']}/turns/{turn['id']}", {"actor": "用户", "status": "cancelled"})
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

    def test_floor_migration_preserves_pending_turn_and_claim_on_reapply(self):
        """An existing pending expert becomes eligible without changing historical data."""
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "floor-migration.sqlite3"
            schema = (Path(__file__).resolve().parent.parent / "schema.sql").read_text(encoding="utf-8")
            with closing(sqlite3.connect(database)) as connection, connection:
                connection.executescript(schema.split("CREATE TABLE IF NOT EXISTS room_floor")[0])
                connection.execute("INSERT INTO rooms(id,title,goal,created_at) VALUES ('old','旧房间','保留历史','test')")
                connection.execute("INSERT INTO topic_settings(room_id,host,experts) VALUES ('old','Codex',?)", ('{"Codex":"cli","Gemini":"online"}',))
                connection.execute("INSERT INTO discussion_turns(room_id,expert,question,submission_id,created_at) VALUES ('old','Gemini','原问题','old-turn','test')")
                connection.execute("INSERT INTO messages(room_id,author,text,source,submission_id,created_at) VALUES ('old','用户','旧原文','user','old-text','test')")
            init_database(database, seed=False)
            with closing(sqlite3.connect(database)) as connection, connection:
                connection.row_factory = sqlite3.Row
                room = require_room(connection, "old")
                self.assertEqual(room["floor"], {"holder": None, "next_speaker": "Gemini", "revision": 0})
                self.assertEqual(room["current_turn"]["question"], "原问题")
                self.assertEqual(get_message(connection, "old", 1)["text"], "旧原文")
                connection.execute("UPDATE room_floor SET holder='Gemini',revision=1 WHERE room_id='old'")
            init_database(database, seed=False)
            with closing(sqlite3.connect(database)) as connection:
                connection.row_factory = sqlite3.Row
                self.assertEqual(require_room(connection, "old")["floor"], {"holder": "Gemini", "next_speaker": "Gemini", "revision": 1})

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
                    message = connection.execute("INSERT INTO messages(room_id,author,text,source,submission_id,created_at) VALUES (?,'用户','迟到观点','user','late-opinion-001','test')", (room["id"],))
                    connection.execute("INSERT INTO message_details(message_id,kind,submitted_by) VALUES (?,'opinion','用户')", (message.lastrowid,))
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
                self.assertEqual((message["summary"], message["summary_by"]), ("", ""))
                self.assertIsNone(room["host_brief"])
                self.assertEqual(room["floor"], {"holder": "用户", "next_speaker": "用户", "revision": 0})


if __name__ == "__main__":
    unittest.main(verbosity=2)

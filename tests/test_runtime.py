"""Regression coverage for discussion sessions and member executions."""

import json
import hashlib
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
from urllib.request import Request, urlopen

from backend.server import DiscussionServer, init_database


class RuntimeTests(unittest.TestCase):
    """Exercise session lifecycle through the current request/execution API."""

    def setUp(self):
        self.base = os.getenv("DISCUSS_TEST_URL", "").rstrip("/")
        if self.base and not self.base.startswith(("http://127.0.0.1:", "http://localhost:")):
            raise ValueError("运行写入测试只能指向隔离的本机服务")
        self.directory = tempfile.TemporaryDirectory()
        if not self.base:
            self.database = Path(self.directory.name) / "runtime.db"
            init_database(self.database, seed=False)
            self.server = DiscussionServer(("127.0.0.1", 0), self.database)
            self.server.local_site = False
            self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
            self.thread.start()
            self.base = f"http://127.0.0.1:{self.server.server_port}"
        self.owner = uuid.uuid4().hex
        self.tokens = {name: uuid.uuid4().hex for name in ("Codex", "Claude", "Gemini")}
        status, room = self.request("/api/rooms", {
            "title": "会话运行验证", "goal": "验证讨论会话生命周期", "mode": "free", "host": "Codex",
            "members": [
                {"name": "Codex", "adapter": "codex_cli", "role": "host", "access": "runner", "token": self.tokens["Codex"]},
            ], "submission_id": uuid.uuid4().hex,
        }, self.owner)
        self.assertEqual(status, 201, room)
        self.room = room["id"]
        self.path = f"/api/rooms/{self.room}"

    def tearDown(self):
        if hasattr(self, "server"):
            self.server.shutdown()
            self.server.server_close()
            self.thread.join()
        self.directory.cleanup()

    def request(self, path, payload=None, token=None):
        headers = {"Content-Type": "application/json"}
        if token:
            headers["X-Discussion-Token"] = token
        request = Request(self.base + path, headers=headers,
                          data=json.dumps(payload).encode() if payload is not None else None)
        try:
            response = urlopen(request, timeout=10)
        except HTTPError as error:
            response = error
        with response:
            return response.status, json.load(response)

    def start_session(self, limits=None):
        current = self.request(self.path + "/discussion")[1]
        status, result = self.request(self.path + "/discussion", {
            "action": "start", "goal": "验证讨论会话生命周期", "limits": limits or {},
            "revision": current["revision"],
        }, self.owner)
        self.assertEqual(status, 200, result)
        return result

    def member_id(self, name="Codex"):
        room = self.request(self.path)[1]
        return next(item["id"] for item in room["free"]["members"] if item["name"] == name)

    def reserve(self, name="Codex", client_id=None):
        return self.request(self.path + "/executions", {
            "member_id": self.member_id(name), "client_id": client_id or uuid.uuid4().hex,
        }, self.owner)

    def invite(self, name):
        token = self.tokens.setdefault(name, uuid.uuid4().hex)
        status, room = self.request(self.path + "/members", {
            "name": name, "adapter": "codex_cli", "access": "runner", "token": token,
        }, self.owner)
        self.assertEqual(status, 200, room)
        return token

    def roster(self):
        return self.request(self.path + "/turns/roster", token=self.tokens["Codex"])[1]

    def arrange(self, turns, roster=None):
        roster = roster or self.roster()
        return self.request(self.path + "/turns", {
            "actor": "Codex", "turns": turns, "roster": roster["revision"],
            "submission_id": uuid.uuid4().hex,
        }, self.tokens["Codex"])

    def execution_action(self, execution, payload, token=None):
        return self.request(f"{self.path}/executions/{execution['id']}", payload, token or self.owner)

    def test_active_session_rejects_legacy_runtime_and_event_writes(self):
        """The retired run-generation interface is read-only while a new session is active."""
        session = self.start_session()["session"]
        self.assertEqual(self.request(self.path + "/runtime", {"action": "pause", "revision": 0}, self.owner)[0], 400)
        self.assertEqual(self.request(self.path + "/events/1", {"action": "enter", "session_id": "legacy"}, self.owner)[0], 400)
        self.assertEqual(self.request(self.path + "/events", token=self.owner)[0], 400)
        self.assertEqual(self.request(self.path + "/runtime", token=self.owner)[0], 400)
        self.assertEqual(self.request(self.path + "/discussion")[1]["session"]["id"], session["id"])

    def test_concluded_session_keeps_legacy_history_reads_and_rejects_mutations(self):
        """Ended request-model sessions retain old reads but reject runtime writes and segment reports."""
        self.start_session()
        discussion = self.request(self.path + "/discussion")[1]
        status, result = self.request(self.path + "/discussion", {
            "action": "end", "revision": discussion["revision"],
        }, self.owner)
        self.assertEqual(status, 200, result)
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute("""INSERT INTO discussion_runtime
                (room_id,mode,run_id,generation,status,control_hash,updated_at)
                VALUES(?,?,?,?,?,?,?)""", (self.room, "automatic", "legacy-run", 1, "stopped",
                                               hashlib.sha256(self.owner.encode()).hexdigest(), "2026-01-01T00:00:00Z"))
            event_id = connection.execute("""INSERT INTO discussion_events
                (room_id,run_id,generation,cause,participant,role,status,created_at)
                VALUES(?,?,?,?,?,?,?,?)""", (self.room, "legacy-run", 1, "legacy-seed", "Codex", "host",
                                                "completed", "2026-01-01T00:00:00Z")).lastrowid
        self.assertEqual(self.request(self.path + "/runtime", token=self.owner)[0], 200)
        self.assertEqual(self.request(self.path + "/events", token=self.owner)[0], 200)
        self.assertEqual(self.request(f"{self.path}/events/{event_id}", {"action": "view"}, self.owner)[0], 200)
        self.assertEqual(self.request(self.path + "/runtime", {"action": "stop"}, self.owner)[0], 409)
        self.assertEqual(self.request(f"{self.path}/events/{event_id}", {"action": "fail"}, self.owner)[0], 409)
        self.assertEqual(self.request(f"{self.path}/events/{event_id}", {"action": "segments", "segments": []}, self.owner)[0], 409)
        self.assertEqual(self.request(self.path + "/timeline")[0], 200)

    def test_unmodeled_free_room_rejects_legacy_segments(self):
        """A free room without request-model session history cannot mutate the legacy execution timeline."""
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute("""INSERT INTO discussion_runtime
                (room_id,mode,run_id,generation,status,control_hash,updated_at)
                VALUES(?,?,?,?,?,?,?)""", (self.room, "automatic", "legacy-run", 1, "stopped",
                                               hashlib.sha256(self.owner.encode()).hexdigest(), "2026-01-01T00:00:00Z"))
            event_id = connection.execute("""INSERT INTO discussion_events
                (room_id,run_id,generation,cause,participant,role,status,created_at)
                VALUES(?,?,?,?,?,?,?,?)""", (self.room, "legacy-run", 1, "legacy-seed", "Codex", "host",
                                                "completed", "2026-01-01T00:00:00Z")).lastrowid
        self.assertEqual(self.request(self.path + f"/events/{event_id}", {"action": "segments", "segments": []}, self.owner)[0], 400)

    def test_legacy_event_history_remains_readable_after_schema_reinitialization(self):
        """Old event rows remain readable and startup does not recreate legacy work."""
        if not hasattr(self, "database"):
            self.skipTest("历史 seed 与 schema 重新初始化需要隔离 SQLite")
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute("INSERT INTO discussion_runtime(room_id,mode,run_id,generation,status,control_hash,updated_at) VALUES(?,?,?,?,?,?,?)",
                (self.room, "automatic", "legacy-run", 7, "stopped", hashlib.sha256(self.owner.encode()).hexdigest(), "2026-01-01T00:00:00Z"))
            connection.execute("INSERT INTO discussion_events(room_id,run_id,generation,cause,participant,role,status,created_at) VALUES(?,?,?,?,?,?,?,?)",
                (self.room, "legacy-run", 7, "legacy-seed", "Codex", "host", "completed", "2026-01-01T00:00:00Z"))
        status, before = self.request(self.path + "/events", token=self.owner)
        self.assertEqual(status, 200, before)
        self.assertEqual(len(before["events"]), 1)
        init_database(self.database, seed=False)
        status, after = self.request(self.path + "/events", token=self.owner)
        self.assertEqual(status, 200, after)
        self.assertEqual(after, before)
        self.assertEqual(self.request(self.path + "/runtime", token=self.owner)[1]["generation"], 7)
        self.assertEqual(self.request(self.path + "/runtime", {"action": "start", "revision": 1}, self.owner)[0], 400)
        self.assertEqual(self.request(f"{self.path}/events/{before['events'][0]['id']}",
                                      {"action": "enter", "session_id": "legacy"}, self.owner)[0], 400)
        self.assertEqual(self.request(f"{self.path}/events/{before['events'][0]['id']}",
                                      {"action": "view"}, self.owner)[0], 200)
        self.assertEqual(self.request(f"{self.path}/events/{before['events'][0]['id']}",
                                      {"action": "segments", "segments": []}, self.owner)[0], 400)

    def test_schema_reinitialization_preserves_session_and_member_execution(self):
        """Reinitializing the current schema preserves active session requests and execution leases."""
        if not hasattr(self, "database"):
            self.skipTest("schema 重新初始化需要隔离 SQLite")
        session = self.start_session()["session"]
        execution = self.reserve()[1]
        self.assertEqual(execution["requests"][0]["purpose"], "discuss_host")
        before_view = self.request(self.path + "/discussion")[1]
        before_execution = self.request(f"{self.path}/executions/{execution['id']}", token=self.owner)[1]
        init_database(self.database, seed=False)
        self.assertEqual(self.request(self.path + "/discussion")[1], before_view)
        self.assertEqual(self.request(f"{self.path}/executions/{execution['id']}", token=self.owner)[1], before_execution)
        self.assertEqual(before_view["session"]["id"], session["id"])

    def test_member_can_fail_only_its_own_active_execution(self):
        """An executing member may report its failure, while other lifecycle actions stay owner-only."""
        member_token = self.invite("Claude")
        other_token = self.invite("Gemini")
        self.request(self.path + "/messages", {
            "author": "用户", "text": "请 Claude 处理", "to": ["Claude"],
            "submission_id": uuid.uuid4().hex,
        }, self.owner)
        execution = self.reserve("Claude")[1]
        path = f"{self.path}/executions/{execution['id']}"
        self.assertEqual(self.request(path, {"action": "renew"}, member_token)[0], 403)
        self.assertEqual(self.request(path, {"action": "fail", "reason": "成员进程退出"}, other_token)[0], 403)
        self.assertEqual(self.request(path, {"action": "fail", "reason": "凭据无效"}, "invalid-token")[0], 403)
        status, failed = self.request(path, {"action": "fail", "reason": "成员进程退出"}, member_token)
        self.assertEqual(status, 200, failed)
        self.assertEqual(failed["status"], "failed")
        self.assertEqual(self.request(path, {"action": "fail", "reason": "重复失败"}, member_token)[0], 409)

    def test_pausing_session_revokes_execution_and_rejects_late_answer(self):
        """A pause cancels the linked request and execution before a delayed member write."""
        self.start_session()
        execution = self.reserve()[1]
        view = self.request(self.path + "/discussion")[1]
        status, paused = self.request(self.path + "/discussion", {"action": "pause", "revision": view["revision"]}, self.owner)
        self.assertEqual(status, 200, paused)
        answer = {"author": "Codex", "source": "cli", "kind": "moderation", "text": "迟到回答", "execution_id": execution["id"], "submission_id": uuid.uuid4().hex}
        self.assertIn(self.request(self.path + "/messages", answer, self.tokens["Codex"])[0], (400, 409))
        report = self.request(f"{self.path}/executions/{execution['id']}", token=self.owner)[1]
        self.assertEqual(report["status"], "cancelled")

    def test_direct_question_remains_available_while_a_session_is_paused(self):
        """A direct question has its own member request and does not resume or consume a discussion turn."""
        self.invite("Claude")
        started = self.start_session()["session"]
        view = self.request(self.path + "/discussion")[1]
        paused = self.request(self.path + "/discussion", {"action": "pause", "revision": view["revision"]}, self.owner)
        self.assertEqual(paused[0], 200, paused[1])
        message = self.request(self.path + "/messages", {
            "author": "用户", "text": "@Claude 一个直接问题", "to": ["Claude"],
            "submission_id": uuid.uuid4().hex,
        }, self.owner)
        self.assertEqual(message[0], 201, message[1])
        request = next(item for item in self.request(self.path, token=self.owner)[1]["free"]["requests"]
                       if item["message_id"] == message[1]["message"]["id"])
        self.assertEqual((request["purpose"], request["status"]), ("ask", "pending"))
        self.assertEqual(self.request(self.path + "/discussion")[1]["session"]["id"], started["id"])
        self.assertEqual(self.request(self.path + "/discussion")[1]["session"]["status"], "paused")

    def test_concurrent_reservation_creates_only_one_member_execution(self):
        """Concurrent dispatch attempts cannot create two executions for one member session."""
        self.start_session()
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: self.reserve(client_id=uuid.uuid4().hex)[0], range(2)))
        self.assertEqual(results.count(200), 1)
        self.assertIn(409, results)

    def test_invited_expert_is_queued_after_the_current_plan(self):
        """An expert invited during a live plan joins its tail without changing the current speaker."""
        self.start_session()
        self.invite("Claude")
        status, plan = self.arrange([{"expert": "Claude", "question": "当前发言"}])
        self.assertEqual(status, 201, plan)
        stale_roster = self.roster()
        self.invite("Gemini")
        stale = self.request(self.path + "/turns", {
            "actor": "Codex", "turns": [{"expert": "Gemini", "question": "旧队列"}],
            "roster": stale_roster["revision"], "submission_id": uuid.uuid4().hex,
        }, self.tokens["Codex"])
        self.assertEqual(stale[0], 409)
        turns = self.request(self.path + "/turns")[1]["turns"]
        self.assertEqual([(item["expert"], item["status"]) for item in turns if item["purpose"] == "discuss"],
                         [("Claude", "open"), ("Gemini", "queued")])
        self.assertEqual(self.request(self.path + "/discussion")[1]["session"]["status"], "active")

    def test_member_away_recall_and_removal_update_the_active_session_roster(self):
        """Away, recall with a fresh credential, and removal keep the session active and update who can be planned."""
        self.start_session()
        claude = self.invite("Claude")
        self.invite("Gemini")
        status, plan = self.arrange([
            {"expert": "Claude", "question": "Claude 发言"},
            {"expert": "Gemini", "question": "Gemini 发言"},
        ])
        self.assertEqual(status, 201, plan)
        claude_id = self.member_id("Claude")
        away = self.request(f"{self.path}/members/{claude_id}", {"action": "away"}, self.owner)
        self.assertEqual(away[0], 200, away[1])
        self.assertEqual(self.request(self.path + "/discussion")[1]["session"]["status"], "active")
        self.assertNotIn("Claude", self.roster()["waiting"])
        renewed = uuid.uuid4().hex
        self.assertEqual(self.request(f"{self.path}/members/{claude_id}", {"action": "active", "token": renewed}, self.owner)[0], 200)
        self.assertIn("Claude", self.roster()["waiting"])
        gemini_id = self.member_id("Gemini")
        self.assertEqual(self.request(f"{self.path}/members/{gemini_id}", {"action": "remove"}, self.owner)[0], 200)
        self.assertNotIn("Gemini", self.roster()["waiting"])
        turns = self.request(self.path + "/turns")[1]["turns"]
        self.assertFalse(any(item["expert"] == "Gemini" and item["status"] in ("open", "queued") for item in turns))

    def test_host_can_skip_a_failed_expert_and_resume_the_queued_plan(self):
        """A failed request remains historical; a revision-bound host continuation opens the next queued expert."""
        self.start_session()
        self.invite("Claude")
        self.invite("Gemini")
        status, plan = self.arrange([
            {"expert": "Claude", "question": "失败的发言"},
            {"expert": "Gemini", "question": "等待中的发言"},
        ])
        self.assertEqual(status, 201, plan)
        execution = self.reserve("Claude")[1]
        self.assertEqual(self.execution_action(execution, {"action": "fail", "reason": "成员暂不可用"})[0], 200)
        roster = self.roster()
        continued = self.request(self.path + "/turns/continue", {
            "actor": "Codex", "revision": roster["revision"],
        }, self.tokens["Codex"])
        self.assertEqual(continued[0], 200, continued[1])
        turns = self.request(self.path + "/turns")[1]["turns"]
        self.assertEqual([(item["expert"], item["status"]) for item in turns if item["purpose"] == "discuss"],
                         [("Claude", "failed"), ("Gemini", "open")])

    def test_session_roster_revision_expires_after_direct_question_and_answer(self):
        """Visible interjections and their answers invalidate a previously read roster."""
        self.start_session()
        self.invite("Claude")
        roster = self.roster()
        question = self.request(self.path + "/messages", {
            "author": "用户", "text": "@Claude 一个直接问题", "to": ["Claude"],
            "submission_id": uuid.uuid4().hex,
        }, self.owner)
        self.assertEqual(question[0], 201, question[1])
        stale = self.arrange([{"expert": "Claude", "question": "旧名单安排"}], roster)
        self.assertEqual(stale[0], 409, stale[1])

        roster = self.roster()
        execution = self.reserve("Claude")[1]
        answer = self.request(self.path + "/messages", {
            "author": "Claude", "source": "cli", "kind": "chat", "text": "直接回答",
            "execution_id": execution["id"], "submission_id": uuid.uuid4().hex,
        }, self.tokens["Claude"])
        self.assertEqual(answer[0], 201, answer[1])
        stale = self.arrange([{"expert": "Claude", "question": "仍旧的名单"}], roster)
        self.assertEqual(stale[0], 409, stale[1])

    def test_session_plan_preserves_host_order_and_completed_history(self):
        """The host's order controls dispatch, and answered requests remain in their original order."""
        self.start_session()
        self.invite("Claude")
        self.invite("Gemini")
        status, plan = self.arrange([
            {"expert": "Gemini", "question": "先由 Gemini"},
            {"expert": "Claude", "question": "再由 Claude"},
        ])
        self.assertEqual(status, 201, plan)
        gemini = self.reserve("Gemini")[1]
        answer = {"author": "Gemini", "source": "cli", "kind": "chat", "text": "Gemini 的观点",
                  "execution_id": gemini["id"], "submission_id": uuid.uuid4().hex}
        self.assertEqual(self.request(self.path + "/messages", answer, self.tokens["Gemini"])[0], 201)
        turns = self.request(self.path + "/turns")[1]["turns"]
        discussion_turns = [item for item in turns if item["purpose"] == "discuss"]
        self.assertEqual([(item["expert"], item["status"]) for item in discussion_turns],
                         [("Gemini", "answered"), ("Claude", "open")])

    def test_room_view_keeps_legacy_and_each_session_round_and_stable_plan_slots(self):
        """Round and assignment metadata stays distinct across legacy history and reopened sessions."""
        if not hasattr(self, "database"):
            self.skipTest("历史 round fixture 需要隔离 SQLite")
        self.invite("Claude")
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute("UPDATE topic_settings SET host=?,experts=?,phase=? WHERE room_id=?",
                               ("Codex", json.dumps({"Claude": "cli"}), "discussing", self.room))
            turn = connection.execute("""INSERT INTO discussion_turns(room_id,expert,question,status,submission_id,created_at,notified_at)
                VALUES(?,'Claude','旧安排','notified','legacy-round-turn','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')""",
                                      (self.room,)).lastrowid
            cursor = connection.execute("INSERT INTO messages(room_id,author,text,source,submission_id,created_at) VALUES(?,?,?,?,?,?)",
                                        (self.room, "Claude", "旧观点", "cli", "legacy-opinion", "2026-01-01T00:01:00Z"))
            connection.execute("INSERT INTO message_details(message_id,kind,submitted_by,turn_id) VALUES(?,?,?,?)",
                               (cursor.lastrowid, "opinion", "Claude", turn))
            connection.execute("UPDATE discussion_turns SET status='answered',answer_id=? WHERE id=?", (cursor.lastrowid, turn))

        session_ids = []
        for index in range(2):
            session = self.start_session()["session"]
            session_ids.append(session["id"])
            roster = self.roster()
            status, plan = self.request(self.path + "/turns", {
                "actor": "Codex", "expert": "Claude", "question": f"第 {index + 1} 次安排",
                "roster": roster["revision"], "submission_id": uuid.uuid4().hex,
            }, self.tokens["Codex"])
            self.assertEqual(status, 201, plan)
            view = self.request(self.path)[1]
            arrangement = next(item for item in view["host_arrangements"] if item["id"].startswith(f"session-{session['id']}-"))
            anchor = arrangement["after_message_id"]
            self.request(self.path + "/messages", {"author": "用户", "text": f"后来消息 {index}",
                "submission_id": uuid.uuid4().hex}, self.owner)
            refreshed = self.request(self.path)[1]
            self.assertEqual(next(item for item in refreshed["host_arrangements"] if item["id"] == arrangement["id"])["after_message_id"], anchor)
            execution = self.reserve("Claude")[1]
            answer = self.request(self.path + "/messages", {"author": "Claude", "source": "cli", "kind": "chat",
                "text": f"第 {index + 1} 轮", "execution_id": execution["id"], "submission_id": uuid.uuid4().hex}, self.tokens["Claude"])
            self.assertEqual(answer[0], 201, answer[1])
            current = self.request(self.path + "/discussion")[1]
            ended = self.request(self.path + "/discussion", {"action": "end", "revision": current["revision"]}, self.owner)
            self.assertEqual(ended[0], 200, ended[1])

        ordinary = self.request(self.path + "/messages", {"author": "用户", "text": "讨论外留言",
            "submission_id": uuid.uuid4().hex}, self.owner)[1]["message"]["id"]
        groups = self.request(self.path)[1]["round_groups"]
        self.assertEqual([group["key"] for group in groups], [
            "legacy-round-1", f"session-{session_ids[0]}-round-1", f"session-{session_ids[1]}-round-1",
        ])
        self.assertEqual([group["session_id"] for group in groups[1:]], session_ids)
        self.assertEqual([group["participants"] for group in groups[1:]], [1, 1])
        self.assertLess(groups[1]["end_id"], ordinary)
        self.assertLess(groups[2]["end_id"], ordinary)

    def test_cancelled_turn_cards_only_include_dispatched_nonfailed_requests(self):
        """Queued rows stay hidden; dispatched cancellations remain until their execution failed."""
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute("""INSERT INTO discussion_turns(room_id,expert,question,status,submission_id,created_at,notified_at)
                VALUES(?,'Claude','旧已发送','cancelled','legacy-cancelled-sent','2026-01-01T00:00:00Z','2026-01-01T00:00:01Z')""", (self.room,))
            connection.execute("""INSERT INTO discussion_turns(room_id,expert,question,status,submission_id,created_at)
                VALUES(?,'Gemini','旧未发送','cancelled','legacy-cancelled-queued','2026-01-01T00:00:02Z')""", (self.room,))
        self.start_session()
        self.invite("Claude")
        self.invite("Gemini")
        roster = self.roster()
        status, plan = self.request(self.path + "/turns", {
            "actor": "Codex", "turns": [
                {"expert": "Claude", "question": "已派发"},
                {"expert": "Gemini", "question": "仍在队列"},
            ], "roster": roster["revision"], "submission_id": uuid.uuid4().hex,
        }, self.tokens["Codex"])
        self.assertEqual(status, 201, plan)
        execution = self.reserve("Claude")[1]
        discussion = self.request(self.path + "/discussion")[1]
        paused = self.request(self.path + "/discussion", {"action": "pause", "revision": discussion["revision"]}, self.owner)
        self.assertEqual(paused[0], 200, paused[1])
        cards = self.request(self.path)[1]["cancelled_turns"]
        self.assertEqual([(item["key"], item.get("execution_id")) for item in cards],
                         [("legacy-turn-1", None), (f"session-{self.request(self.path + '/discussion')[1]['session']['id']}-request-{plan['turn']['id']}", execution["id"])])
        self.assertTrue(all(item["created_at"] for item in cards))
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute("UPDATE member_executions SET status='failed' WHERE id=?", (execution["id"],))
        self.assertEqual([item["key"] for item in self.request(self.path)[1]["cancelled_turns"]], ["legacy-turn-1"])

    def test_session_plan_retry_keeps_its_original_ids_after_roster_changes(self):
        """An exact plan retry is idempotent even after the first plan advances the roster revision."""
        self.start_session()
        self.invite("Claude")
        roster = self.roster()
        payload = {"actor": "Codex", "turns": [{"expert": "Claude", "question": "唯一安排"}],
                   "roster": roster["revision"], "submission_id": uuid.uuid4().hex}
        first = self.request(self.path + "/turns", payload, self.tokens["Codex"])
        self.assertEqual(first[0], 201, first[1])
        retry = self.request(self.path + "/turns", payload, self.tokens["Codex"])
        self.assertEqual(retry[0], 200, retry[1])
        self.assertTrue(retry[1]["duplicate"])
        self.assertEqual(retry[1]["turn"]["id"], first[1]["turn"]["id"])
        self.assertEqual([item["id"] for item in self.request(self.path + "/turns")[1]["turns"]],
                         [first[1]["turn"]["id"]])

    def test_session_round_limit_counts_distinct_speakers_and_only_scheduled_host(self):
        """The session limit counts actual speakers, includes a scheduled host, and cancels a repeated queued expert."""
        session = self.start_session({"max_rounds": 1})["session"]
        self.invite("Claude")
        self.invite("Gemini")
        roster = self.roster()
        payload = {"actor": "Codex", "turns": [
            {"expert": "Codex", "question": "主持人首轮发言"},
            {"expert": "Claude", "question": "Claude 首轮发言"},
            {"expert": "Gemini", "question": "Gemini 首轮发言"},
            {"expert": "Claude", "question": "Claude 下一轮排队"},
        ], "roster": roster["revision"], "submission_id": uuid.uuid4().hex}
        status, plan = self.request(self.path + "/turns", payload, self.tokens["Codex"])
        self.assertEqual(status, 201, plan)

        last_answer = None
        for name in ("Codex", "Claude", "Gemini"):
            execution = self.reserve(name)[1]
            last_answer = {"author": name, "source": "cli", "kind": "chat",
                           "text": f"{name} 的首轮观点", "execution_id": execution["id"],
                           "submission_id": uuid.uuid4().hex}
            answer_status, answer = self.request(self.path + "/messages", last_answer, self.tokens[name])
            self.assertEqual(answer_status, 201, answer)
            if name != "Gemini":
                self.assertEqual(self.request(self.path + "/discussion")[1]["session"]["status"], "active")

        self.assertIsNone(self.request(self.path + "/discussion")[1]["session"])
        with closing(sqlite3.connect(self.database)) as connection:
            rows = connection.execute("""SELECT m.name,sr.status FROM session_requests sr
                JOIN room_members m ON m.id=sr.member_id WHERE sr.session_id=? AND sr.purpose='discuss'
                ORDER BY sr.round,sr.position""", (session["id"],)).fetchall()
            host_pending = connection.execute("SELECT COUNT(*) FROM session_requests WHERE session_id=? AND purpose='discuss_host' AND status='open'", (session["id"],)).fetchone()[0]
            stop_reason = connection.execute("SELECT stop_reason FROM session_limits WHERE session_id=?", (session["id"],)).fetchone()[0]
        self.assertEqual([(row[0], row[1]) for row in rows], [
            ("Codex", "answered"), ("Claude", "answered"), ("Gemini", "answered"), ("Claude", "cancelled"),
        ])
        self.assertEqual((host_pending, stop_reason), (0, "round_limit"))
        self.assertEqual(self.request(self.path + "/messages", last_answer, self.tokens["Gemini"])[0], 200)

    def test_host_plan_completes_only_its_bound_request(self):
        """A user message arriving during host work remains pending after that host's plan is saved."""
        self.start_session()
        self.invite("Claude")
        host_execution = self.reserve("Codex")[1]
        note = self.request(self.path + "/messages", {
            "author": "用户", "text": "主持任务执行期间的新消息", "submission_id": uuid.uuid4().hex,
        }, self.owner)
        self.assertEqual(note[0], 201, note[1])
        roster = self.roster()
        status, plan = self.request(self.path + "/turns", {
            "actor": "Codex", "expert": "Claude", "question": "根据已开始任务安排",
            "roster": roster["revision"], "execution_id": host_execution["id"],
            "submission_id": uuid.uuid4().hex,
        }, self.tokens["Codex"])
        self.assertEqual(status, 201, plan)
        with closing(sqlite3.connect(self.database)) as connection:
            pending = connection.execute("""SELECT COUNT(*) FROM session_requests sr JOIN task_message_sources t
                ON t.session_request_id=sr.id WHERE sr.session_id=? AND sr.purpose='discuss_host'
                AND sr.status IN ('open','queued') AND t.cause_message_id=?""",
                (self.request(self.path + "/discussion")[1]["session"]["id"], note[1]["message"]["id"])).fetchone()[0]
        self.assertEqual(pending, 1)

    def test_reordering_queued_session_requests_preserves_speaker_questions_and_retry_identity(self):
        """Reordering only the queued suffix changes dispatch order without changing plan contents or IDs."""
        self.start_session()
        for name in ("Claude", "Gemini", "Qwen"):
            self.invite(name)
        status, plan = self.arrange([
            {"expert": "Claude", "question": "当前发言"},
            {"expert": "Gemini", "question": "Gemini 的问题"},
            {"expert": "Qwen", "question": "Qwen 的问题"},
        ])
        self.assertEqual(status, 201, plan)
        order = self.request(self.path + "/speaking-order")[1]
        status, _ = self.request(self.path + "/speaking-order", {
            "revision": order["revision"], "order": ["Qwen", "Gemini"],
        }, self.owner)
        self.assertEqual(status, 200)
        turns = [item for item in self.request(self.path + "/turns")[1]["turns"] if item["purpose"] == "discuss"]
        self.assertEqual([(item["expert"], item["question"]) for item in turns], [
            ("Claude", "当前发言"), ("Qwen", "Qwen 的问题"), ("Gemini", "Gemini 的问题"),
        ])

    def test_stored_execution_minutes_no_longer_end_a_running_execution(self):
        """execution_minutes is still accepted from older clients, but one execution has no time limit."""
        if not hasattr(self, "database"):
            self.skipTest("execution 时钟边界需要隔离 SQLite")
        session = self.start_session({"execution_minutes": 1})["session"]
        execution = self.reserve()[1]
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute("UPDATE member_executions SET created_at=?,lease_until=? WHERE id=?",
                               (int(time.time()) - 61, int(time.time()) + 60, execution["id"]))
        result = self.execution_action(execution, {"action": "renew"})
        self.assertEqual(result[0], 200, result)
        self.assertEqual(self.request(self.path + "/discussion")[1]["session"]["id"], session["id"])

    def test_session_deadline_concludes_and_records_its_reason(self):
        """The total session time limit concludes the session and records a stable stop reason."""
        if not hasattr(self, "database"):
            self.skipTest("讨论限时时钟边界需要隔离 SQLite")
        session = self.start_session({"max_minutes": 1})["session"]
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute("UPDATE session_limits SET started_at=? WHERE session_id=?",
                               (int(time.time()) - 61, session["id"]))
        self.assertIsNone(self.request(self.path + "/discussion")[1]["session"])
        with closing(sqlite3.connect(self.database)) as connection:
            state = connection.execute("SELECT status FROM discussion_sessions WHERE id=?", (session["id"],)).fetchone()[0]
            reason = connection.execute("SELECT stop_reason FROM session_limits WHERE session_id=?", (session["id"],)).fetchone()[0]
        self.assertEqual((state, reason), ("concluded", "time_limit"))

    def test_session_limit_values_reject_out_of_range_types_and_bounds(self):
        """Session creation accepts only bounded integer round, duration, and execution limits."""
        current = self.request(self.path + "/discussion")[1]
        for limits in (
            {"max_rounds": -1}, {"max_rounds": 101}, {"max_rounds": True},
            {"max_minutes": 1441}, {"max_minutes": "1"},
            {"execution_minutes": 61}, {"execution_minutes": 1.5},
        ):
            status, result = self.request(self.path + "/discussion", {
                "action": "start", "revision": current["revision"], "limits": limits,
            }, self.owner)
            self.assertEqual(status, 400, (limits, result))
        self.assertIsNone(self.request(self.path + "/discussion")[1]["session"])
        session = self.start_session({"max_rounds": 2})["session"]
        active_view = self.request(self.path + "/discussion")[1]
        original_revision = active_view["revision"]
        active_edit = self.request(self.path + "/limits", {
            "action": "configure", "max_rounds": 3, "revision": original_revision,
        }, self.owner)
        self.assertEqual(active_edit[0], 400, active_edit[1])
        paused = self.request(self.path + "/discussion", {
            "action": "pause", "revision": original_revision,
        }, self.owner)
        self.assertEqual(paused[0], 200, paused[1])
        original_revision = paused[1]["revision"]
        changed = self.request(self.path + "/limits", {
            "action": "configure", "max_rounds": 3, "revision": original_revision,
        }, self.owner)
        self.assertEqual(changed[0], 200, changed[1])
        self.assertEqual(changed[1]["session"]["limits"]["max_rounds"], 3)
        stale = self.request(self.path + "/limits", {
            "action": "configure", "max_rounds": 4, "revision": original_revision,
        }, self.owner)
        self.assertEqual(stale[0], 409, stale[1])
        latest = self.request(self.path + "/discussion")[1]
        invalid = self.request(self.path + "/limits", {
            "action": "configure", "max_rounds": 101, "revision": latest["revision"],
        }, self.owner)
        self.assertEqual(invalid[0], 400, invalid[1])
        self.assertEqual(self.request(self.path + "/discussion")[1]["session"]["id"], session["id"])

    def test_paused_time_does_not_consume_the_session_deadline(self):
        """A long pause is added back to the deadline before the session resumes."""
        if not hasattr(self, "database"):
            self.skipTest("暂停时钟边界需要隔离 SQLite")
        session = self.start_session({"max_minutes": 1})["session"]
        view = self.request(self.path + "/discussion")[1]
        paused = self.request(self.path + "/discussion", {"action": "pause", "revision": view["revision"]}, self.owner)
        self.assertEqual(paused[0], 200, paused[1])
        paused_at = int(time.time()) - 120
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute("UPDATE session_limits SET started_at=? WHERE session_id=?",
                               (paused_at, session["id"]))
            connection.execute("UPDATE session_pauses SET paused_at=? WHERE session_id=?",
                               (paused_at, session["id"]))
        latest = self.request(self.path + "/discussion")[1]
        resumed = self.request(self.path + "/discussion", {"action": "resume", "revision": latest["revision"]}, self.owner)
        self.assertEqual(resumed[0], 200, resumed[1])
        self.assertEqual(resumed[1]["session"]["status"], "active")
        self.assertGreaterEqual(resumed[1]["session"]["pause"]["paused_seconds"], 120)

    def test_unlimited_session_can_run_long_execution_until_lease_expires(self):
        """A zero total limit does not remove the member execution lease or its renewal check."""
        if not hasattr(self, "database"):
            self.skipTest("租约时钟边界需要隔离 SQLite")
        session = self.start_session({"execution_minutes": 60})["session"]
        execution = self.reserve()[1]
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute("UPDATE member_executions SET created_at=? WHERE id=?", (int(time.time()) - 50 * 60, execution["id"]))
        self.assertEqual(self.request(self.path + "/discussion")[1]["session"]["id"], session["id"])
        renewed = self.execution_action(execution, {"action": "renew"})
        self.assertEqual(renewed[0], 200, renewed)
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute("UPDATE member_executions SET lease_until=0 WHERE id=?", (execution["id"],))
        self.assertIn(self.execution_action(execution, {"action": "renew"})[0], (403, 409))

    def test_concluded_session_can_start_a_fresh_session_after_schema_upgrade(self):
        """A concluded session stays in history while a later session receives a new identity."""
        if not hasattr(self, "database"):
            self.skipTest("升级回归需要隔离 SQLite")
        first = self.start_session()["session"]
        view = self.request(self.path + "/discussion")[1]
        ended = self.request(self.path + "/discussion", {"action": "end", "revision": view["revision"]}, self.owner)
        self.assertEqual(ended[0], 200, ended[1])
        init_database(self.database, seed=False)
        latest = self.request(self.path + "/discussion")[1]
        second = self.request(self.path + "/discussion", {
            "action": "start", "goal": "升级后的新会话", "revision": latest["revision"],
        }, self.owner)
        self.assertEqual(second[0], 200, second[1])
        self.assertNotEqual(second[1]["session"]["id"], first["id"])
        self.assertEqual(second[1]["session"]["goal"], "升级后的新会话")

    def test_host_moderation_keeps_host_execution_live_and_does_not_count_as_a_turn(self):
        """A host may save notes repeatedly while keeping its host task available for state and scheduling."""
        session = self.start_session()["session"]
        self.invite("Claude")
        execution = self.reserve()[1]
        payload = {"author": "Codex", "kind": "moderation", "text": "开场说明", "execution_id": execution["id"],
                   "source": "api", "submission_id": "host-moderation-runtime-01"}
        status, saved = self.request(self.path + "/messages", payload, self.tokens["Codex"])
        self.assertEqual(status, 201, saved)
        self.assertEqual(saved["message"]["kind"], "moderation")
        self.assertEqual(self.request(self.path + "/messages", payload, self.tokens["Codex"])[1]["duplicate"], True)
        collision = self.request(self.path + "/messages", {**payload, "summary": "禁止摘要"}, self.tokens["Codex"])
        self.assertEqual(collision[0], 400)
        self.assertEqual(self.request(self.path + f"/executions/{execution['id']}", token=self.owner)[1]["status"], "dispatched")
        with closing(sqlite3.connect(self.database)) as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM session_requests WHERE session_id=? AND purpose='discuss'", (session["id"],)).fetchone()[0], 0)
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM member_requests WHERE execution_id=? AND purpose='discuss_host'", (execution["id"],)).fetchone()[0], 1)
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM member_requests WHERE message_id=?", (saved["message"]["id"],)).fetchone()[0], 0)
        state_status, _ = self.request(self.path + "/state", {"actor": "Codex", "text": "已整理", "until": saved["message"]["id"]}, self.tokens["Codex"])
        self.assertEqual(state_status, 200)
        plan = self.arrange([{"expert": "Claude", "question": "继续讨论"}])
        self.assertEqual(plan[0], 201, plan[1])
        stale = self.request(self.path + "/messages", {**payload, "submission_id": "host-moderation-runtime-02"}, self.tokens["Claude"])
        self.assertEqual(stale[0], 403)
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute("UPDATE member_executions SET lease_until=0 WHERE id=?", (execution["id"],))
        late = self.request(self.path + "/messages", {**payload, "text": "迟到", "submission_id": "host-moderation-runtime-03"}, self.tokens["Codex"])
        self.assertIn(late[0], (403, 409))

    def test_room_view_exposes_visible_anchors_for_session_execution_cards(self):
        """Session execution cards can attach to visible history while keeping their hidden task provenance."""
        visible = self.request(self.path + "/messages", {"author": "用户", "text": "讨论前的问题", "submission_id": "session-card-anchor-01"}, self.owner)[1]["message"]
        self.start_session()
        self.invite("Claude")
        plan = self.arrange([{"expert": "Claude", "question": "请核对原问题"}])
        self.assertEqual(plan[0], 201, plan[1])
        execution = self.reserve("Claude")[1]
        view = self.request(self.path, token=self.tokens["Codex"])[1]
        request = next(item for item in view["free"]["requests"] if item["id"] == execution["requests"][0]["id"])
        self.assertEqual((request["session_request_id"], request["discussion_session_id"], request["purpose"], request["round"]),
                         (plan[1]["turn"]["id"], self.request(self.path + "/discussion")[1]["session"]["id"], "discuss", 1))
        self.assertEqual(request["source_question"], "请核对原问题")
        self.assertEqual(request["after_message_id"], visible["id"])
        self.assertGreater(request["message_id"], request["after_message_id"])
        report = next(item for item in view["free"]["executions"] if item["id"] == execution["id"])
        self.assertEqual(report["member"], "Claude")
        self.assertEqual(report["requests"][0]["source_question"], "请核对原问题")
        self.assertEqual(report["requests"][0]["after_message_id"], visible["id"])
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute("UPDATE room_members SET status='removed' WHERE name='Claude' AND room_id=?", (self.room,))
        removed_view = self.request(self.path)[1]
        removed_report = next(item for item in removed_view["free"]["executions"] if item["id"] == execution["id"])
        self.assertEqual(removed_report["member"], "Claude")


if __name__ == "__main__":
    unittest.main()

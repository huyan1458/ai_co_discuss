"""Regression coverage for discussion sessions and member executions."""

import json
import os
import re
import sqlite3
import tempfile
import threading
import time
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from backend import server as server_module
from backend.server import DiscussionServer, init_database

LEGACY_MIGRATION_TABLES = ("session_state", "discussion_sessions", "room_modes", "member_manual_sources", "attachments", "execution_segments", "room_members")


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
        self.tokens = {name: uuid.uuid4().hex for name in ("Codex", "Claude", "Antigravity")}
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

    def add_legacy_records(self):
        """Add retired foreign keys and a session with no request-model state to the private database."""
        if not hasattr(self, "database"):
            self.skipTest("旧库迁移需要隔离 SQLite")
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.executescript("""
                CREATE TABLE room_floor(room_id TEXT PRIMARY KEY REFERENCES rooms(id));
                CREATE TABLE discussion_turns(id INTEGER PRIMARY KEY,room_id TEXT REFERENCES rooms(id));
                ALTER TABLE message_details ADD COLUMN turn_id INTEGER REFERENCES discussion_turns(id);
            """)
            connection.execute("INSERT INTO room_floor VALUES (?)", (self.room,))
            connection.execute("INSERT INTO discussion_turns VALUES (1,?)", (self.room,))
            message = connection.execute("""INSERT INTO messages(room_id,author,text,source,submission_id,created_at)
                VALUES (?,'用户','迁移原文','cli','legacy-message','2026-01-01')""", (self.room,)).lastrowid
            connection.execute("INSERT INTO message_details VALUES (?,'chat','用户',1)", (message,))
            connection.execute("""INSERT INTO discussion_sessions(room_id,goal,status,created_at)
                VALUES (?,'旧讨论','paused','2026-01-01')""", (self.room,))
        return message

    def test_legacy_startup_migration_preserves_messages_and_allows_deletion(self):
        """Old room foreign keys disappear, orphan sessions conclude and a second startup stays safe."""
        message = self.add_legacy_records()
        init_database(self.database, seed=False)
        init_database(self.database, seed=False)
        with closing(sqlite3.connect(self.database)) as connection, connection:
            self.assertEqual(connection.execute("SELECT name FROM sqlite_master WHERE name IN ('room_floor','discussion_turns')").fetchall(), [])
            self.assertEqual(connection.execute("SELECT kind,submitted_by FROM message_details WHERE message_id=?", (message,)).fetchone(), ("chat", "用户"))
            self.assertEqual(connection.execute("SELECT status,ended_message_id FROM discussion_sessions WHERE room_id=?", (self.room,)).fetchone(), ("concluded", message))
            self.assertEqual(connection.execute("PRAGMA foreign_key_check").fetchall(), [])
            connection.executescript("BEGIN;\n" + server_module.LEGACY_DISCUSSION_SQL + "\nCOMMIT;")
        self.assertEqual(self.request(f"{self.path}/messages/{message}")[1]["text"], "迁移原文")
        self.start_session()
        status, deleted = self.request(self.path + "/delete", {"actor": "用户", "confirm_title": "会话运行验证"}, self.owner)
        self.assertEqual(status, 200, deleted)
        self.assertEqual(self.request(self.path)[0], 404)

    def test_legacy_startup_migration_runs_before_newer_tables_exist(self):
        """A database older than the tables the script writes to still migrates and keeps its records."""
        message = self.add_legacy_records()
        with closing(sqlite3.connect(self.database)) as connection, connection:
            member = connection.execute("SELECT id FROM room_members WHERE room_id=?", (self.room,)).fetchone()[0]
            connection.execute("UPDATE room_members SET access='online' WHERE id=?", (member,))
            # Triggers and views may read the dropped tables; schema.sql re-creates them.
            for kind, name in connection.execute("SELECT type,name FROM sqlite_master WHERE type IN ('trigger','view')").fetchall():
                connection.execute(f"DROP {kind} {name}")
            for table in LEGACY_MIGRATION_TABLES:
                if table != "room_members":
                    connection.execute(f"DROP TABLE {table}")
        init_database(self.database, seed=False)
        init_database(self.database, seed=False)
        with closing(sqlite3.connect(self.database)) as connection, connection:
            self.assertEqual(connection.execute("SELECT name FROM sqlite_master WHERE name IN ('room_floor','discussion_turns')").fetchall(), [])
            self.assertEqual(connection.execute("SELECT kind,submitted_by FROM message_details WHERE message_id=?", (message,)).fetchone(), ("chat", "用户"))
            self.assertEqual(connection.execute("SELECT access FROM room_members WHERE id=?", (member,)).fetchone(), ("manual",))
            self.assertEqual(connection.execute("SELECT source FROM member_manual_sources WHERE member_id=?", (member,)).fetchone(), ("web",))
            self.assertEqual(connection.execute("SELECT status FROM room_members WHERE id=?", (member,)).fetchone(), ("removed",))
            self.assertEqual(connection.execute("SELECT mode FROM room_modes WHERE room_id=?", (self.room,)).fetchone(), ("free",))
            self.assertEqual(connection.execute("PRAGMA foreign_key_check").fetchall(), [])

    def test_legacy_migration_tables_match_schema(self):
        """Tables the one-off script creates for old databases keep the current schema's definition."""
        for table in LEGACY_MIGRATION_TABLES:
            pattern = rf"^CREATE TABLE IF NOT EXISTS {table} \(.*?^\);$"
            created = re.search(pattern, server_module.LEGACY_DISCUSSION_SQL, flags=re.S | re.M)
            self.assertIsNotNone(created, table)
            self.assertEqual(created[0], re.search(pattern, server_module.SCHEMA, flags=re.S | re.M)[0])

    def test_legacy_migration_failure_rolls_back_rebuilt_table(self):
        """Failure after dropping message_details restores its data, foreign key and the orphan session."""
        message = self.add_legacy_records()
        failing = server_module.LEGACY_DISCUSSION_SQL.replace("DROP TABLE message_details;", "DROP TABLE message_details; SELECT * FROM missing_migration_table;")
        with patch.object(server_module, "LEGACY_DISCUSSION_SQL", failing):
            with self.assertRaises(sqlite3.OperationalError):
                init_database(self.database, seed=False)
        with closing(sqlite3.connect(self.database)) as connection, connection:
            self.assertEqual(connection.execute("SELECT turn_id FROM message_details WHERE message_id=?", (message,)).fetchone(), (1,))
            self.assertEqual(connection.execute("SELECT room_id FROM room_floor").fetchone(), (self.room,))
            self.assertEqual(connection.execute("SELECT status FROM discussion_sessions WHERE room_id=?", (self.room,)).fetchone(), ("paused",))
            self.assertEqual(connection.execute("SELECT name FROM sqlite_master WHERE name='message_details_rebuilt'").fetchall(), [])

    def test_member_can_fail_only_its_own_active_execution(self):
        """An executing member may report its failure, while other lifecycle actions stay owner-only."""
        member_token = self.invite("Claude")
        other_token = self.invite("Antigravity")
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
        self.invite("Antigravity")
        stale = self.request(self.path + "/turns", {
            "actor": "Codex", "turns": [{"expert": "Antigravity", "question": "旧队列"}],
            "roster": stale_roster["revision"], "submission_id": uuid.uuid4().hex,
        }, self.tokens["Codex"])
        self.assertEqual(stale[0], 409)
        turns = self.request(self.path + "/turns")[1]["turns"]
        self.assertEqual([(item["expert"], item["status"]) for item in turns if item["purpose"] == "discuss"],
                         [("Claude", "open"), ("Antigravity", "queued")])
        self.assertEqual(self.request(self.path + "/discussion")[1]["session"]["status"], "active")

    def test_member_away_recall_and_removal_update_the_active_session_roster(self):
        """Away, recall with a fresh credential, and removal keep the session active and update who can be planned."""
        self.start_session()
        claude = self.invite("Claude")
        self.invite("Antigravity")
        status, plan = self.arrange([
            {"expert": "Claude", "question": "Claude 发言"},
            {"expert": "Antigravity", "question": "Antigravity 发言"},
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
        gemini_id = self.member_id("Antigravity")
        self.assertEqual(self.request(f"{self.path}/members/{gemini_id}", {"action": "remove"}, self.owner)[0], 200)
        self.assertNotIn("Antigravity", self.roster()["waiting"])
        turns = self.request(self.path + "/turns")[1]["turns"]
        self.assertFalse(any(item["expert"] == "Antigravity" and item["status"] in ("open", "queued") for item in turns))

    def test_host_can_skip_a_failed_expert_and_resume_the_queued_plan(self):
        """A failed request remains historical; a revision-bound host continuation opens the next queued expert."""
        self.start_session()
        self.invite("Claude")
        self.invite("Antigravity")
        status, plan = self.arrange([
            {"expert": "Claude", "question": "失败的发言"},
            {"expert": "Antigravity", "question": "等待中的发言"},
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
                         [("Claude", "failed"), ("Antigravity", "open")])

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

    def test_session_round_limit_counts_distinct_speakers_and_only_scheduled_host(self):
        """The session limit counts actual speakers, includes a scheduled host, and cancels a repeated queued expert."""
        session = self.start_session({"max_rounds": 1})["session"]
        self.invite("Claude")
        self.invite("Antigravity")
        roster = self.roster()
        payload = {"actor": "Codex", "turns": [
            {"expert": "Codex", "question": "主持人首轮发言"},
            {"expert": "Claude", "question": "Claude 首轮发言"},
            {"expert": "Antigravity", "question": "Antigravity 首轮发言"},
            {"expert": "Claude", "question": "Claude 下一轮排队"},
        ], "roster": roster["revision"], "submission_id": uuid.uuid4().hex}
        status, plan = self.request(self.path + "/turns", payload, self.tokens["Codex"])
        self.assertEqual(status, 201, plan)

        last_answer = None
        for name in ("Codex", "Claude", "Antigravity"):
            execution = self.reserve(name)[1]
            last_answer = {"author": name, "source": "cli", "kind": "chat",
                           "text": f"{name} 的首轮观点", "execution_id": execution["id"],
                           "submission_id": uuid.uuid4().hex}
            answer_status, answer = self.request(self.path + "/messages", last_answer, self.tokens[name])
            self.assertEqual(answer_status, 201, answer)
            if name != "Antigravity":
                self.assertEqual(self.request(self.path + "/discussion")[1]["session"]["status"], "active")

        self.assertIsNone(self.request(self.path + "/discussion")[1]["session"])
        with closing(sqlite3.connect(self.database)) as connection:
            rows = connection.execute("""SELECT m.name,sr.status FROM session_requests sr
                JOIN room_members m ON m.id=sr.member_id WHERE sr.session_id=? AND sr.purpose='discuss'
                ORDER BY sr.round,sr.position""", (session["id"],)).fetchall()
            host_pending = connection.execute("SELECT COUNT(*) FROM session_requests WHERE session_id=? AND purpose='discuss_host' AND status='open'", (session["id"],)).fetchone()[0]
            stop_reason = connection.execute("SELECT stop_reason FROM session_limits WHERE session_id=?", (session["id"],)).fetchone()[0]
        self.assertEqual([(row[0], row[1]) for row in rows], [
            ("Codex", "answered"), ("Claude", "answered"), ("Antigravity", "answered"), ("Claude", "cancelled"),
        ])
        self.assertEqual((host_pending, stop_reason), (0, "round_limit"))
        self.assertEqual(self.request(self.path + "/messages", last_answer, self.tokens["Antigravity"])[0], 200)

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
        hosted = self.request(self.path + "/messages?host=1", token=self.owner)[1]["messages"]
        self.assertIn(saved["message"]["id"], [message["id"] for message in hosted])
        self.assertTrue(all(message["kind"] == "moderation" or message["author"] == "Codex" for message in hosted))
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

if __name__ == "__main__":
    unittest.main()

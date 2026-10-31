"""Free collaboration rooms: owner credential, member credentials, requests and executions."""

import json
import sqlite3
import tempfile
import threading
import time
import unittest
import uuid
from contextlib import closing
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen

from backend.server import DiscussionServer, init_database


class FreeRoomTests(unittest.TestCase):
    """Exercise the Python backend only; the Worker rejects free rooms in P1."""

    def setUp(self):
        """Start an isolated server and create one free room with a single Claude member."""
        self.directory = tempfile.TemporaryDirectory()
        self.database = Path(self.directory.name) / "free.db"
        init_database(self.database, seed=False)
        self.server = DiscussionServer(("127.0.0.1", 0), self.database)
        self.server.local_site = False  # these tests exercise room credential rules, not the account-free local site
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"
        self.owner = uuid.uuid4().hex
        self.member = uuid.uuid4().hex
        status, room = self.request("/api/rooms", {"title": "自由单聊", "goal": "遥控一个本地 CLI", "mode": "free",
                                                   "members": [{"name": "Claude", "adapter": "claude", "token": self.member}],
                                                   "submission_id": "free-room-1"}, self.owner)
        self.assertEqual(status, 201, room)
        self.room = room
        self.path = f"/api/rooms/{room['id']}"

    def test_room_without_members_can_be_created(self):
        """A room may start empty; members are invited later."""
        status, room = self.request("/api/rooms", {"title": "空房间", "goal": "x", "mode": "free", "host": "用户", "members": [],
                                                   "submission_id": "free-room-empty"}, uuid.uuid4().hex)
        self.assertEqual(status, 201, room)
        self.assertEqual(room["experts"], {})

    def test_stop_before_delivery_holds_until_confirmed_or_original_deadline(self):
        """Late capability reports and uncertain stops retain the original bounded wait."""
        member_id = self.request(self.path)[1]["free"]["members"][0]["id"]
        for result in ("unstoppable", "unconfirmed"):
            self.say("开始", to=["Claude"])
            execution = self.reserve()[1]
            url = f"{self.path}/executions/{execution['id']}"
            self.request(f"{self.path}/members/{member_id}/interrupt", {}, self.owner)
            payload = {"action": "stopped", "result": result}
            self.assertEqual(self.request(url, payload, self.owner)[0], 200)
            self.assertTrue(self.request(url, payload, self.owner)[1]["duplicate"])
            held = lambda: self.request(self.path + "/inbox", token=self.owner)[1]["members"][0]["held_until"]
            deadline = held()
            self.assertGreater(deadline, 0, "a stop result holds even before delivery is reported")
            self.assertEqual(self.request(url, {"action": "delivery", "stoppable": True, "progress": True}, self.owner)[0], 200)
            self.say("主动重发", to=["Claude"])
            self.assertEqual(held(), deadline)
            self.assertEqual(self.reserve()[0], 409)
            if result == "unconfirmed":
                self.assertEqual(self.request(url, {"action": "stopped", "result": "stopped"}, self.owner)[0], 200)
            else:
                with closing(sqlite3.connect(self.database)) as connection, connection:
                    connection.execute("UPDATE member_executions SET finished_at=? WHERE id=?", (int(time.time()) - 601, execution["id"]))
            self.assertEqual(held(), 0)
            next_execution = self.reserve()[1]
            self.assertEqual(self.answer(next_execution["id"])[0], 201)

    def test_capability_schema_upgrade_preserves_existing_records(self):
        """An early capability CHECK gains unconfirmed without losing recorded capabilities."""
        self.say("开始", to=["Claude"])
        execution = self.reserve()[1]
        with closing(sqlite3.connect(self.database)) as connection, connection:
            definition = connection.execute("SELECT sql FROM sqlite_master WHERE name='execution_capabilities'").fetchone()[0]
            connection.execute("DROP TABLE execution_capabilities")
            connection.execute(definition.replace(",'unconfirmed'", ""))
            connection.execute("INSERT INTO execution_capabilities VALUES (?,?,0,0,'unstoppable')", (execution["id"], self.room["id"]))
        for _ in range(2):
            init_database(self.database, seed=False)
        with closing(sqlite3.connect(self.database)) as connection, connection:
            saved = connection.execute("SELECT stoppable,progress,stop_result FROM execution_capabilities WHERE execution_id=?", (execution["id"],)).fetchone()
            self.assertEqual(saved, (0, 0, "unstoppable"))
            connection.execute("UPDATE execution_capabilities SET stop_result='unconfirmed' WHERE execution_id=?", (execution["id"],))

    def test_review_capability_owner_revision_and_invalidation(self):
        """Only owner attestations expose candidates; leaving and returning cannot resurrect old authority."""
        member_id = self.review_member_id()
        path = f"{self.path}/members/{member_id}/review-capability"
        status, state = self.request(path, token=self.owner)
        self.assertEqual(status, 200, state)
        payload = {"revision": state["revision"], "read_only": True, "config_version": "a" * 64}
        self.assertEqual(self.request(path, payload, self.member)[0], 403)
        self.assertEqual(self.request(path, {"read_only": True}, self.owner)[0], 400)
        self.assertEqual(self.request(path, {**payload, "revision": "stale"}, self.owner)[0], 409)
        self.assertEqual(self.request(path, payload, self.owner)[0], 200)
        status, roster = self.request(f"{self.path}/reviews/roster", token=self.owner)
        self.assertEqual(status, 200, roster)
        self.assertEqual(roster["members"][0]["name"], "Codex-评审")
        self.assertNotIn("token_hash", json.dumps(roster))
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute("UPDATE room_members SET status='away' WHERE id=?", (member_id,))
            connection.execute("UPDATE room_members SET status='active' WHERE id=?", (member_id,))
        self.assertEqual(self.request(f"{self.path}/reviews/roster", token=self.owner)[1]["members"], [])
        self.assertEqual(self.request(path, payload, self.owner)[0], 409)
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute("UPDATE room_members SET session_mode='borrowed' WHERE id=?", (member_id,))
        latest = self.request(path, token=self.owner)[1]
        self.assertEqual(self.request(path, {**payload, "revision": latest["revision"]}, self.owner)[0], 409)

    def test_review_capability_is_runtime_only_and_revocable(self):
        """Revoking local facts removes a candidate, and backup never restores an attestation."""
        member_id = self.review_member_id()
        path = f"{self.path}/members/{member_id}/review-capability"
        state = self.request(path, token=self.owner)[1]
        payload = {"revision": state["revision"], "read_only": True, "config_version": "b" * 64}
        self.assertEqual(self.request(path, payload, self.owner)[0], 200)
        backup = self.request(f"{self.path}/backup", token=self.owner)[1]
        self.assertNotIn("member_review_capabilities", backup["tables"])
        inbox = self.request(f"{self.path}/inbox", token=self.owner)[1]
        reviewer = next(member for member in inbox["members"] if member["id"] == member_id)
        self.assertEqual(reviewer["review_capability"]["capability"]["config_version"], "b" * 64)
        self.assertEqual(self.request(path, {"revision": state["revision"], "read_only": False}, self.owner)[0], 200)
        self.assertEqual(self.request(f"{self.path}/reviews/roster", token=self.owner)[1]["members"], [])

    def review_member_id(self):
        """Invite one test reviewer using the adapter with enforced filesystem permissions."""
        self.review_token = uuid.uuid4().hex
        status, view = self.request(f"{self.path}/members", {"name": "Codex-评审", "adapter": "codex_cli",
                                                            "token": self.review_token}, self.owner)
        self.assertEqual(status, 200, view)
        return next(member["id"] for member in view["members"] if member["name"] == "Codex-评审")

    def completed_review_batch(self):
        """Create a real implementation handoff for review endpoint integration tests."""
        reviewer = self.review_member_id()
        host_id = next(member["id"] for member in self.request(self.path)[1]["free"]["members"] if member["name"] == "Claude")
        self.request(f"{self.path}/members/{host_id}", {"action": "role", "role": "host"}, self.owner)
        path = f"{self.path}/members/{reviewer}/review-capability"
        state = self.request(path, token=self.owner)[1]
        self.request(path, {"revision": state["revision"], "read_only": True, "config_version": "a" * 64}, self.owner)
        implementer_token = uuid.uuid4().hex
        status, members = self.request(f"{self.path}/members", {"name": "Codex-实现", "adapter": "codex_cli", "token": implementer_token}, self.owner)
        implementer = next(item["id"] for item in members["members"] if item["name"] == "Codex-实现")
        self.say("实现", to=["Claude"])
        execution = self.reserve()[1]
        roster = self.request(f"{self.path}/reviews/roster", token=self.member)[1]
        status, result = self.answer(execution["id"], to=["Codex-实现"], next_review="Codex-评审", review_scope="验证实现",
                                    review_roster=roster["revision"])
        self.assertEqual(status, 201, result)
        work = self.request(f"{self.path}/executions", {"member_id": implementer, "client_id": uuid.uuid4().hex}, self.owner)[1]
        self.assertEqual(self.answer(work["id"], token=implementer_token, author="Codex-实现", text="已完成实现与验证")[0], 201)
        return result["message"]["id"], reviewer

    def test_review_advance_preserves_other_host_work_and_is_idempotent(self):
        """Only the matching handoff closes; task provenance stays hidden from the transcript."""
        batch_id, reviewer = self.completed_review_batch()
        self.say("还有另一个问题", to=["Claude"])
        host_execution = self.reserve()[1]
        path = f"{self.path}/reviews/{batch_id}/ready"
        status, ready = self.request(path, token=self.member)
        self.assertEqual(status, 200, ready)
        self.assertTrue(ready["ready"], ready)
        base = {"actor": "Claude", "batch_id": batch_id, "submission_id": "review-advance-test"}
        advance = f"{self.path}/reviews/advance"
        self.assertEqual(self.request(advance, base, self.member)[0], 400)
        self.assertEqual(self.request(advance, {**base, "revision": "stale"}, self.member)[0], 409)
        payload = {**base, "revision": ready["revision"]}
        status, result = self.request(advance, payload, self.member)
        self.assertEqual(status, 200, result)
        self.assertFalse(result["execution_completed"])
        repeated = self.request(advance, payload, self.member)[1]
        self.assertTrue(repeated["duplicate"])
        self.assertFalse(repeated["execution_completed"])
        self.assertEqual(self.request(advance, {**payload, "submission_id": "different-review-submit"}, self.member)[0], 409)
        self.assertEqual(self.request(f"{self.path}/messages/{result['review_batch_id']}")[0], 404)
        execution = self.request(f"{self.path}/executions", {"member_id": reviewer, "client_id": uuid.uuid4().hex}, self.owner)[1]
        self.assertEqual(execution["requests"][0]["review"]["batch_id"], batch_id)
        self.assertIn("只读评审", execution["requests"][0]["source_question"])
        state = self.request(f"{self.path}/executions/{host_execution['id']}", token=self.owner)[1]
        self.assertEqual([item["status"] for item in state["requests"]], ["completed", "delivering"])

    def test_review_advance_retry_reports_completed_host_execution(self):
        """An API host may stop after the same successful advance response is replayed."""
        batch_id, reviewer = self.completed_review_batch()
        self.reserve()
        ready = self.request(f"{self.path}/reviews/{batch_id}/ready", token=self.member)[1]
        payload = {"actor": "Claude", "batch_id": batch_id, "revision": ready["revision"], "submission_id": "review-terminal-test"}
        for attempt in range(2):
            status, result = self.request(f"{self.path}/reviews/advance", payload, self.member)
            self.assertEqual(status, 200, result)
            self.assertTrue(result["execution_completed"])
            self.assertEqual(result["duplicate"], bool(attempt))

    def test_review_ready_rejects_missing_delivery_budget_and_stale_new_message(self):
        """Hard preconditions hold without asking any decision model to interpret them."""
        batch_id, reviewer = self.completed_review_batch()
        path = f"{self.path}/reviews/{batch_id}/ready"
        ready = self.request(path, token=self.member)[1]
        self.say("补充约束", to=["Claude"])
        payload = {"actor": "Claude", "batch_id": batch_id, "revision": ready["revision"], "submission_id": "review-stale-new-message"}
        self.assertEqual(self.request(f"{self.path}/reviews/advance", payload, self.member)[0], 409)
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute("INSERT INTO free_round_limits(room_id,max_rounds) VALUES(?,1) ON CONFLICT(room_id) DO UPDATE SET max_rounds=1", (self.room["id"],))
        self.assertIn("额度不足", self.request(path, token=self.member)[1]["reason"])
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute("UPDATE free_round_limits SET max_rounds=3 WHERE room_id=?", (self.room["id"],))
            connection.execute("UPDATE member_requests SET status='failed' WHERE room_id=? AND batch_id=?", (self.room["id"], batch_id))
        self.assertIn("尚未全部成功", self.request(path, token=self.member)[1]["reason"])

    def test_review_rejection_returns_reason_without_cancelling_other_requests(self):
        """A local permission mismatch cancels only the isolated review and reaches its host."""
        batch_id, reviewer = self.completed_review_batch()
        ready = self.request(f"{self.path}/reviews/{batch_id}/ready", token=self.member)[1]
        self.request(f"{self.path}/reviews/advance", {"actor": "Claude", "batch_id": batch_id,
                     "revision": ready["revision"], "submission_id": "review-rejection-test"}, self.member)
        self.say("另一个问题", to=["Codex-评审"])
        execution = self.request(f"{self.path}/executions", {"member_id": reviewer, "client_id": uuid.uuid4().hex}, self.owner)[1]
        self.assertEqual(len(execution["requests"]), 1)
        path = f"{self.path}/executions/{execution['id']}"
        payload = {"action": "reject_review", "reason": "只读权限已改变"}
        self.assertEqual(self.request(path, payload, self.review_token)[0], 403)
        status, result = self.request(path, payload, self.owner)
        self.assertEqual(status, 200, result)
        self.assertEqual(result["status"], "cancelled")
        inbox = self.request(f"{self.path}/inbox", token=self.owner)[1]
        host = next(item for item in inbox["members"] if item["name"] == "Claude")
        self.assertIn("只读权限已改变", host["pending"][0]["review"]["reason"])
        member = next(item for item in inbox["members"] if item["id"] == reviewer)
        self.assertEqual(len(member["pending"]), 1)

    def test_review_preauthorization_is_atomic_and_history_only_on_import(self):
        """Bind a distinct reviewer to a real dispatch; stale or replayed changes cannot alter it."""
        member_id = self.review_member_id()
        host_id = next(member["id"] for member in self.request(self.path)[1]["free"]["members"] if member["name"] == "Claude")
        self.request(f"{self.path}/members/{host_id}", {"action": "role", "role": "host"}, self.owner)
        path = f"{self.path}/members/{member_id}/review-capability"
        capability = self.request(path, token=self.owner)[1]
        self.request(path, {"revision": capability["revision"], "read_only": True, "config_version": "a" * 64}, self.owner)
        self.request(f"{self.path}/members", {"name": "Gemini", "adapter": "gemini", "token": uuid.uuid4().hex}, self.owner)
        self.say("实现功能后交评审", to=["Claude"])
        execution = self.reserve()[1]
        roster = self.request(f"{self.path}/reviews/roster", token=self.member)[1]
        base = {"to": ["Gemini"], "next_review": "Codex-评审", "review_scope": "核对功能", "submission_id": "review-implementation-1"}
        self.assertEqual(self.answer(execution["id"], **base)[0], 400)
        self.assertEqual(self.answer(execution["id"], **base, review_roster="stale")[0], 409)
        status, refused = self.answer(execution["id"], **{**base, "to": ["Codex-评审"]}, review_roster=roster["revision"])
        self.assertEqual(status, 400, refused)
        self.assertIn("实现者", refused["error"])
        status, saved = self.answer(execution["id"], **base, review_roster=roster["revision"])
        self.assertEqual(status, 201, saved)
        self.assertEqual(self.answer(execution["id"], **base, review_roster=roster["revision"])[1]["duplicate"], True)
        self.assertEqual(self.answer(execution["id"], **{**base, "review_scope": "改范围"}, review_roster=roster["revision"])[0], 409)
        batch_id = saved["message"]["id"]
        with closing(sqlite3.connect(self.database)) as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM review_plans WHERE batch_id=?", (batch_id,)).fetchone()[0], 1)
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM free_handoffs WHERE batch_id=?", (batch_id,)).fetchone()[0], 1)
        backup = self.request(f"{self.path}/backup", token=self.owner)[1]
        self.assertEqual(backup["tables"]["review_plans"][0]["scope"], "核对功能")
        copied = json.loads(json.dumps(backup).replace(self.room["id"], "reviewcopy"))
        status, imported = self.request("/api/rooms/import", copied, uuid.uuid4().hex)
        self.assertEqual(status, 201, imported)
        with closing(sqlite3.connect(self.database)) as connection:
            self.assertEqual(connection.execute("SELECT status,config_version,member_revision FROM review_plans WHERE room_id=?", (imported["id"],)).fetchone(), ("imported", "", ""))

    def tearDown(self):
        """Release the server and temporary files."""
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.directory.cleanup()

    def request(self, path, payload=None, token=None):
        """Return status and JSON for successes and rejected writes alike."""
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
            return response.status, json.loads(response.read())

    def read_text(self, path):
        """Read one plain-text room view from the public reader endpoint."""
        with urlopen(Request(self.base + path), timeout=10) as response:
            return response.read().decode("utf-8")

    def say(self, text, token=None, **extra):
        """Post one owner message with a fresh submission id."""
        return self.request(f"{self.path}/messages", {"author": "用户", "text": text,
                                                       "submission_id": uuid.uuid4().hex, **extra}, token or self.owner)

    def answer(self, execution_id, text="已处理", token=None, **extra):
        """Post one member answer bound to an execution."""
        payload = {"author": "Claude", "text": text, "source": "cli", "submission_id": uuid.uuid4().hex, **extra}
        if execution_id is not None:
            payload["execution_id"] = execution_id
        return self.request(f"{self.path}/messages", payload, token or self.member)

    def reserve(self, client_id=None):
        """Bundle the member's open requests as one execution."""
        member_id = self.request(self.path)[1]["free"]["members"][0]["id"]
        return self.request(f"{self.path}/executions", {"member_id": member_id, "client_id": client_id or uuid.uuid4().hex}, self.owner)

    def test_scheduler_routing_marker_is_owner_only_and_clears(self):
        """The local service marks a message while it is analysed; the room view lists it until cleared."""
        path = f"{self.path}/scheduler-routing"
        self.assertEqual(self.request(path, {"message_id": 1, "active": True}, self.member)[0], 403)
        self.assertEqual(self.request(path, {"message_id": 0, "active": True}, self.owner)[0], 400)
        self.assertEqual(self.request(path, {"message_id": 7, "active": True}, self.owner)[0], 200)
        self.assertEqual(self.request(self.path)[1]["scheduler_routing"], [7])
        self.assertEqual(self.request(path, {"message_id": 7, "active": False}, self.owner)[0], 200)
        self.assertEqual(self.request(self.path)[1]["scheduler_routing"], [])

    def test_room_view_reports_free_mode_and_members_without_secrets(self):
        """The public view lists members and states but never any credential hash."""
        room = self.request(self.path)[1]
        self.assertEqual(room["mode"], "free")
        # The user is the client; the only member that answers by itself hosts.
        self.assertEqual(room["host"], getattr(self, "expected_host", "Claude"))
        self.assertEqual(room["free"]["members"][0]["name"], "Claude")
        self.assertNotIn("token_hash", json.dumps(room))
        self.assertNotIn("control_hash", json.dumps(room))
        backup = self.request(f"{self.path}/backup")[1]
        self.assertNotIn("token_hash", json.dumps(backup))
        self.assertNotIn("control_hash", json.dumps(backup))

    def test_imported_free_room_keeps_requests_and_invites_members_back(self):
        """Requests follow renumbered members and messages; members return only with new credentials."""
        self.assertEqual(self.say("请看看")[0], 201)
        execution = self.reserve()[1]
        self.assertEqual(self.answer(execution["id"], "看完了")[0], 201)
        self.assertEqual(self.say("再看一处")[0], 201)
        backup = json.loads(json.dumps(self.request(f"{self.path}/backup")[1]).replace(self.room["id"], "freecopy"))
        importer = uuid.uuid4().hex
        status, result = self.request("/api/rooms/import", backup, importer)
        self.assertEqual(status, 201, result)
        room = self.request("/api/rooms/freecopy")[1]
        self.assertEqual((room["mode"], room["phase"]), ("free", "discussing"))
        member = room["free"]["members"][0]
        self.assertEqual((member["name"], member["status"]), ("Claude", "away"))
        requests = sorted(room["free"]["requests"], key=lambda item: item["id"])
        self.assertEqual([item["status"] for item in requests], ["completed", "cancelled"])
        self.assertEqual(self.request("/api/rooms/freecopy/messages", {"author": "用户", "text": "旧凭据", "submission_id": "old-credential"}, self.owner)[0], 403)
        renewed = uuid.uuid4().hex
        self.assertEqual(self.request(f"/api/rooms/freecopy/members/{member['id']}", {"action": "active", "token": renewed}, importer)[0], 200)
        self.assertEqual(self.request("/api/rooms/freecopy/messages", {"author": "用户", "text": "继续", "submission_id": "continue-after-import", "to": ["Claude"]}, importer)[0], 201)

    def test_creation_requires_owner_credential_and_retries_idempotently(self):
        """A free room needs a control credential; the same submission returns the original room."""
        payload = {"title": "无凭据", "goal": "x", "mode": "free",
                   "members": [{"name": "Claude", "adapter": "claude", "token": self.member}]}
        self.assertEqual(self.request("/api/rooms", payload)[0], 400)
        status, again = self.request("/api/rooms", {"title": "自由单聊", "goal": "遥控一个本地 CLI", "mode": "free",
                                                     "members": [{"name": "Claude", "adapter": "claude", "token": self.member}],
                                                     "submission_id": "free-room-1"}, self.owner)
        self.assertEqual((status, again["id"], again["duplicate"]), (200, self.room["id"], True))

    def test_only_the_owner_credential_can_speak_as_user(self):
        """Missing, wrong, member and other-room credentials cannot write or create requests."""
        other_owner = uuid.uuid4().hex
        other = self.request("/api/rooms", {"title": "另一房间", "goal": "x", "mode": "free",
                                            "members": [{"name": "Codex", "token": uuid.uuid4().hex}]}, other_owner)[1]
        for token in (None, uuid.uuid4().hex, self.member, other_owner):
            status, _ = self.request(f"{self.path}/messages", {"author": "用户", "text": "冒充",
                                                               "submission_id": uuid.uuid4().hex, "source": "user"}, token)
            self.assertEqual(status, 403, token)
        status, _ = self.request(f"{self.path}/messages", {"author": "Claude", "text": "主人冒充成员",
                                                           "submission_id": uuid.uuid4().hex}, self.owner)
        self.assertEqual(status, 403)
        self.assertEqual(self.request(self.path)[1]["free"]["requests"], [])
        self.assertEqual(self.request(f"/api/rooms/{other['id']}")[1]["message_count"], 0)

    def test_single_member_is_named_by_default_and_answer_completes_requests(self):
        """Two messages queue two requests; one execution carries both and one answer closes them."""
        first = self.say("请改首页标题")[1]["message"]
        self.say("另外先别动 footer")
        requests = self.request(self.path)[1]["free"]["requests"]
        self.assertEqual([item["status"] for item in requests], ["pending", "pending"])
        status, execution = self.reserve()
        self.assertEqual(status, 200, execution)
        self.assertEqual([item["message_id"] for item in execution["requests"]], [first["id"], first["id"] + 1])
        self.assertEqual(execution["read_until"], 0)
        self.assertEqual(self.reserve()[0], 409)
        status, saved = self.answer(execution["id"])
        self.assertEqual(status, 201, saved)
        self.assertEqual(saved["message"]["kind"], "chat")
        room = self.request(self.path)[1]["free"]
        self.assertEqual([item["status"] for item in room["requests"]], ["completed", "completed"])
        self.assertEqual(room["members"][0]["execution"]["status"], "completed")
        self.assertEqual(room["members"][0]["read_until"], saved["message"]["id"])

    def test_rename_during_execution_changes_only_the_title(self):
        """Renaming is display-only, so a running execution and its answer are unaffected."""
        self.say("任务")
        execution = self.reserve()[1]
        self.assertEqual(self.request(self.path + "/rename", {"actor": "用户", "title": "新名称"}, self.member)[0], 403)
        status, renamed = self.request(self.path + "/rename", {"actor": "用户", "title": "新名称"}, self.owner)
        self.assertEqual(status, 200, renamed)
        self.assertEqual(renamed["title"], "新名称")
        self.assertEqual(self.answer(execution["id"])[0], 201)

    def test_retried_reservation_returns_the_same_execution(self):
        """A lost reserve response is recovered with the same local client id."""
        self.say("任务")
        client_id = uuid.uuid4().hex
        first = self.reserve(client_id)[1]
        again = self.reserve(client_id)[1]
        self.assertEqual(first["id"], again["id"])

    def test_a_waiting_delivery_retry_is_shown_and_the_owner_can_retry_now_or_stop_it(self):
        """The runner records a manual member's refused delivery; the owner answers it while the execution stays live."""
        self.say("任务")
        execution = self.reserve()[1]
        path = f"{self.path}/executions/{execution['id']}"
        wait = {"action": "retry_wait", "attempt": 1, "retry_at": int(time.time()) + 60, "reason": "投递失败：原窗口拒绝"}
        self.assertEqual(self.request(path, {**wait, "attempt": 4}, self.owner)[0], 400)
        self.assertEqual(self.request(path, {"action": "retry_now"}, self.owner)[0], 409)
        self.assertEqual(self.request(path, wait, self.owner)[0], 200)
        member = self.request(self.path)[1]["free"]["members"][0]
        self.assertEqual(member["execution"]["retry"], {"attempt": 1, "retry_at": wait["retry_at"], "reason": wait["reason"], "stopped": 0})
        self.assertEqual(self.request(path, {"action": "retry_now"}, self.owner)[0], 200)
        self.assertLessEqual(self.request(path, None, self.owner)[1]["retry"]["retry_at"], int(time.time()))
        self.assertEqual(self.request(path, {"action": "retry_stop"}, self.owner)[0], 200)
        self.assertEqual(self.request(path, {"action": "retry_stop"}, self.owner)[0], 409)
        self.assertEqual(self.request(f"{self.path}/inbox", None, self.owner)[1]["executions"][0]["retry"]["stopped"], 1)
        self.assertEqual(self.request(path, {"action": "retry_stop"}, "not-the-owner")[0], 403)

    def test_recent_execution_reports_include_associations_and_detection_state(self):
        """Reports distinguish an empty Git observation from missing detection and cap history."""
        message = self.say("只读检查")[1]["message"]
        execution = self.reserve()[1]
        saved = self.answer(execution["id"])[1]["message"]
        report_path = f"{self.path}/executions/{execution['id']}"
        report = self.request(self.path)[1]["free"]["executions"][0]
        self.assertFalse(report["changes_recorded"])
        self.assertEqual(self.request(report_path, {"action": "report", "changes": []}, self.owner)[0], 200)
        report = self.request(self.path)[1]["free"]["executions"][0]
        self.assertEqual((report["changes"], report["changes_recorded"]), ([], True))
        self.assertEqual((report["answer_id"], report["request_message_id"]), (saved["id"], message["id"]))
        # Refused operations arrive once after the process ends, even though the answer already completed the execution.
        self.assertEqual(report["denials"], [])
        denial = {"tool": "PowerShell", "detail": "lark-cli docs get x", "rule": "PowerShell(lark-cli *)"}
        self.assertEqual(self.request(report_path, {"action": "denials", "denials": [denial]}, self.owner)[0], 200)
        self.assertEqual(self.request(report_path, {"action": "denials", "denials": [denial]}, self.owner)[0], 409)
        self.assertEqual(self.request(report_path, {"action": "denials", "denials": [{"detail": "no tool"}]}, self.owner)[0], 400)
        self.assertEqual(self.request(self.path)[1]["free"]["executions"][0]["denials"], [denial])
        # The answer itself names its execution, so the page can keep it in the working card's slot after reports age out.
        listed = next(item for item in self.request(f"{self.path}/messages")[1]["messages"] if item["id"] == saved["id"])
        self.assertEqual((listed["execution_id"], listed["request_message_id"]), (execution["id"], message["id"]))
        self.assertEqual(len(report["request_ids"]), 1)
        self.assertGreaterEqual(report["finished_at"], report["created_at"])
        with closing(sqlite3.connect(self.database)) as connection, connection:
            for index in range(101):
                connection.execute("""INSERT INTO member_executions (room_id,member_id,client_id,status,created_at,changes)
                    VALUES (?,?,?,'failed',1,'["index.html"]')""", (self.room["id"], execution["member_id"], f"history-{index}"))
        reports = self.request(self.path)[1]["free"]["executions"]
        self.assertEqual(len(reports), 100)
        self.assertEqual(reports[0]["changes"], ["index.html"])
        self.assertFalse({"token_hash", "client_id", "control_hash"} & set(reports[0]))

    def test_late_and_unbound_answers_are_rejected(self):
        """Interrupted executions refuse late answers, and an answer cannot be reposted as plain chat."""
        self.say("开始")
        execution = self.reserve()[1]
        self.assertEqual(self.answer(None)[0], 400)
        member_id = self.request(self.path)[1]["free"]["members"][0]["id"]
        self.assertEqual(self.request(f"{self.path}/members/{member_id}/interrupt", {}, None)[0], 403)
        view = self.request(f"{self.path}/members/{member_id}/interrupt", {}, self.owner)[1]
        self.assertEqual(view["members"][0]["execution"]["status"], "cancelled")
        self.assertEqual(self.answer(execution["id"])[0], 409)
        self.assertEqual(self.answer(None)[0], 400)
        self.assertEqual([item["status"] for item in view["requests"]], ["cancelled"])
        self.assertEqual(self.request(self.path)[1]["message_count"], 1)

    def messages(self, include=False):
        """Ids and texts of the room's messages as AI readers see them, or as the page sees them with withdrawn ones."""
        query = "?after=0" + ("&withdrawn=include" if include else "")
        return [(item["id"], item["text"], item["withdrawn"]) for item in self.request(f"{self.path}/messages{query}")[1]["messages"]]

    def test_retract_takes_back_a_message_only_until_a_member_starts_it(self):
        """A queued message leaves AI reads and its request ends; once a member starts one, retracting is refused."""
        first = self.say("先别做这个")[1]["message"]["id"]
        retract = f"{self.path}/messages/{first}/retract"
        self.assertEqual(self.request(retract, {}, self.member)[0], 403)
        status, result = self.request(retract, {}, self.owner)
        self.assertEqual((status, result["text"], result["duplicate"]), (200, "先别做这个", False))
        self.assertTrue(self.request(retract, {}, self.owner)[1]["duplicate"])
        self.assertEqual(self.messages(), [])
        self.assertEqual(self.messages(include=True), [(first, "", "retracted")])
        room = self.request(self.path)[1]
        self.assertEqual(room["withdrawals"], [{"message_id": first, "kind": "retracted"}])
        self.assertEqual([item["status"] for item in room["free"]["requests"]], ["cancelled"])
        second = self.say("做这个")[1]["message"]["id"]
        execution = self.reserve()[1]
        self.assertEqual(self.request(f"{self.path}/messages/{second}/retract", {}, self.owner)[0], 409)
        answer = self.answer(execution["id"])[1]["message"]["id"]
        self.assertEqual(self.request(f"{self.path}/messages/{answer}/retract", {}, self.owner)[0], 400)

    def test_rewind_takes_back_history_and_tells_the_runner_what_to_cut(self):
        """Editing a message hides it and everything after, ends open work and lists the member's taken-back executions."""
        first = self.say("一")[1]["message"]["id"]
        kept = self.reserve()[1]
        first_answer = self.answer(kept["id"], "一好了")[1]["message"]["id"]
        second = self.say("二")[1]["message"]["id"]
        taken = self.reserve()[1]
        self.answer(taken["id"], "二好了")
        self.say("三")
        claude_id = next(item["id"] for item in self.request(self.path)[1]["free"]["members"] if item["name"] == "Claude")
        # The plan shows what the runner reported its adapter does to the session; without a report the session is kept.
        unreported = self.request(f"{self.path}/rewind?message_id={second}", None, self.owner)[1]
        self.assertEqual(next(item for item in unreported["members"] if item["name"] == "Claude")["session"], "kept")
        self.assertEqual(self.request(f"{self.path}/members/{claude_id}/capabilities", {"rewind": "shred"}, self.owner)[0], 400)
        self.assertEqual(self.request(f"{self.path}/members/{claude_id}/capabilities", {"rewind": "cut"}, self.owner)[0], 200)
        status, plan = self.request(f"{self.path}/rewind?message_id={second}", None, self.owner)
        self.assertEqual(status, 200, plan)
        self.assertEqual(plan["messages"], 3)
        claude = next(item for item in plan["members"] if item["name"] == "Claude")
        self.assertEqual((claude["executions"], claude["session"]), ([taken["id"]], "cut"))
        self.assertEqual(self.request(f"{self.path}/rewind?message_id={second}", None, None)[0], 403)
        self.assertEqual(self.request(f"{self.path}/rewind", {"message_id": second}, self.owner)[0], 400)
        self.assertEqual(self.request(f"{self.path}/rewind", {"message_id": second, "revision": "stale"}, self.owner)[0], 409)
        status, result = self.request(f"{self.path}/rewind", {"message_id": second, "revision": plan["revision"]}, self.owner)
        self.assertEqual(status, 200, result)
        self.assertEqual(self.messages(), [(first, "一", ""), (first_answer, "一好了", "")])
        self.assertEqual([kind for _, _, kind in self.messages(include=True)], ["", "", "rewound", "rewound", "rewound"])
        room = self.request(self.path)[1]
        self.assertEqual(room["free"]["members"][0]["read_until"], second - 1)
        self.assertEqual(room["free"]["requests"][-1]["status"], "cancelled")
        self.assertEqual(self.request(f"{self.path}/rewind?message_id={second}", None, self.owner)[0], 409)
        self.say("改过的二")
        self.assertEqual(self.reserve()[1]["rewound_executions"], [taken["id"]])
        self.assertEqual(self.request(f"{self.path}/rewind?message_id={first_answer}", None, self.owner)[0], 400)

    def test_interrupt_voids_the_running_turn_and_keeps_what_arrived_meanwhile(self):
        """Stopping a member voids its running turn; a message sent meanwhile waits for its next turn, with any new one."""
        self.say("一")
        self.reserve()
        self.say("二")
        member_id = self.request(self.path)[1]["free"]["members"][0]["id"]
        view = self.request(f"{self.path}/members/{member_id}/interrupt", {}, self.owner)[1]
        self.assertEqual([item["status"] for item in view["requests"]], ["cancelled", "pending"])
        self.say("三")
        execution = self.reserve()[1]
        self.assertEqual(len(execution["requests"]), 2)

    def test_failure_affects_only_its_requests_and_release_requeues(self):
        """A failed execution keeps the room usable; a proven non-delivery returns requests to the queue."""
        self.say("一")
        first = self.reserve()[1]
        status, failed = self.request(f"{self.path}/executions/{first['id']}", {"action": "fail", "reason": "CLI 退出"}, self.owner)
        self.assertEqual((status, failed["status"]), (200, "failed"))
        room = self.request(self.path)[1]
        self.assertEqual(room["phase"], "discussing")
        self.assertEqual(room["free"]["requests"][0]["status"], "failed")
        self.say("二")
        second = self.reserve()[1]
        released = self.request(f"{self.path}/executions/{second['id']}", {"action": "release", "reason": "未送达"}, self.owner)[1]
        self.assertEqual(released["status"], "cancelled")
        third = self.reserve()[1]
        self.assertEqual([item["message_id"] for item in third["requests"]], [item["message_id"] for item in second["requests"]])

    def test_expired_lease_fails_the_execution_and_rejects_its_answer(self):
        """A runner that stopped renewing cannot leave a stale writer behind."""
        self.say("一")
        execution = self.reserve()[1]
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute("UPDATE member_executions SET created_at=unixepoch()-3600,lease_until=unixepoch()-3480 WHERE id=?", (execution["id"],))
        self.assertEqual(self.answer(execution["id"])[0], 409)
        inbox = self.request(f"{self.path}/inbox", token=self.owner)[1]
        self.assertEqual(inbox["executions"], [])
        self.assertEqual(self.request(self.path)[1]["free"]["requests"][0]["status"], "failed")
        self.assertEqual(self.request(self.path)[1]["free"]["members"][0]["execution"]["result"], "执行租约到期，接入程序未续租")

    def test_long_execution_keeps_renewing_without_a_time_limit(self):
        """One execution has no time limit, even with a legacy stored value: renewing keeps it alive."""
        self.say("长任务")
        execution = self.reserve()[1]
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute("UPDATE discussion_limits SET execution_minutes=1 WHERE room_id=?", (self.room["id"],))
            connection.execute("UPDATE member_executions SET created_at=unixepoch()-3600 WHERE id=?", (execution["id"],))
        renewed = self.request(f"{self.path}/executions/{execution['id']}", {"action": "renew"}, self.owner)
        self.assertEqual(renewed[0], 200, renewed)
        self.assertGreater(renewed[1]["lease_until"], int(time.time()) + 60)
        self.assertNotIn("execution_minutes", self.request(f"{self.path}/inbox", token=self.owner)[1])

    def test_renewal_reports_what_the_software_is_doing(self):
        """The runner's phase and output time reach the member card; older renewals keep the last report."""
        self.say("一")
        execution = self.reserve()[1]
        path = f"{self.path}/executions/{execution['id']}"
        future = int(time.time()) + 600
        self.assertEqual(self.request(path, {"action": "renew", "activity": "command", "activity_at": future}, self.owner)[0], 200)
        reported = self.request(self.path)[1]["free"]["members"][0]["execution"]
        self.assertEqual(reported["activity"], "command")
        self.assertLessEqual(reported["activity_at"], int(time.time()))
        self.assertEqual(self.request(path, {"action": "renew"}, self.owner)[0], 200)
        self.assertEqual(self.request(self.path)[1]["free"]["members"][0]["execution"]["activity"], "command")
        for payload in ({"activity": "sleeping", "activity_at": future}, {"activity": "tool", "activity_at": "now"}, {"activity": "tool"}):
            self.assertEqual(self.request(path, {"action": "renew", **payload}, self.owner)[0], 400, payload)

    def test_progress_notes_are_kept_once_and_read_apart_from_the_room_view(self):
        """Notes carried by renewals are stored once per number; the room view only counts them."""
        self.say("一")
        execution = self.reserve()[1]
        path = f"{self.path}/executions/{execution['id']}"
        notes = [{"seq": 1, "text": "读完材料"}, {"seq": 2, "text": "开始验证"}]
        for _ in range(2):
            self.assertEqual(self.request(path, {"action": "renew", "notes": notes}, self.owner)[0], 200)
        self.assertEqual(self.request(self.path)[1]["free"]["members"][0]["execution"]["notes"], 2)
        status, body = self.request(f"{path}/notes")
        self.assertEqual(status, 200, body)
        self.assertEqual([note["text"] for note in body["notes"]], ["读完材料", "开始验证"])
        for bad in ([{"seq": 51, "text": "x"}], [{"seq": 3, "text": "x" * 501}], [{"seq": 3, "text": ""}], "x"):
            self.assertEqual(self.request(path, {"action": "renew", "notes": bad}, self.owner)[0], 400, bad)
        self.assertEqual(self.answer(execution["id"])[0], 201)
        self.assertEqual(self.request(self.path)[1]["free"]["executions"][0]["notes"], 2)
        self.assertEqual(self.request(f"{self.path}/executions/999/notes")[0], 404)

    def test_phase_segments_reach_the_timeline_within_the_execution(self):
        """Segments are kept once per number with the later end, bounded by the execution, also just after it ends."""
        self.say("一")
        execution = self.reserve()[1]
        path = f"{self.path}/executions/{execution['id']}"
        segments = [{"seq": 1, "phase": "thinking", "start_ms": -50, "end_ms": 400},
                    {"seq": 2, "phase": "command", "tool": "Bash", "start_ms": 400, "end_ms": 900}]
        self.assertEqual(self.request(path, {"action": "segments", "segments": segments}, self.owner)[0], 200)
        self.assertEqual(self.request(path, {"action": "segments", "segments": segments}, self.member)[0], 403)
        later = {"seq": 2, "phase": "command", "tool": "Bash", "start_ms": 400, "end_ms": 10 ** 9}
        self.assertEqual(self.request(path, {"action": "segments", "segments": [later]}, self.owner)[0], 200)
        for bad in ([], [{"seq": 401, "phase": "tool", "start_ms": 0, "end_ms": 1}], [{"seq": 3, "phase": "sleeping", "start_ms": 0, "end_ms": 1}],
                    [{"seq": 3, "phase": "tool", "tool": "x" * 61, "start_ms": 0, "end_ms": 1}], [{"seq": 3, "phase": "tool", "start_ms": 0}], "x"):
            self.assertEqual(self.request(path, {"action": "segments", "segments": bad}, self.owner)[0], 400, bad)
        self.assertEqual(self.answer(execution["id"])[0], 201)
        self.assertEqual(self.request(path, {"action": "segments", "segments": [{"seq": 3, "phase": "writing", "start_ms": 900, "end_ms": 950}]}, self.owner)[0], 200)
        status, body = self.request(f"{self.path}/timeline")
        self.assertEqual(status, 200, body)
        item = body["executions"][0]
        self.assertEqual((item["source"], item["member"], item["state"]), ("free", "Claude", "done"))
        self.assertIsNone(item["run_id"])
        span = (item["finished_at"] - item["dispatched_at"] + 1) * 1000
        self.assertEqual([(s["phase"], s["tool"], s["start_ms"]) for s in item["segments"]], [("thinking", "", 0), ("command", "Bash", 400), ("writing", "", 900)])
        self.assertTrue(900 < item["segments"][1]["end_ms"] <= span, "a later end is kept but never past the execution")
        self.assertEqual(self.request(f"{self.path.rsplit('/', 1)[0]}/missing-room/timeline")[0], 404)

    def test_notes_ride_with_segments_and_the_timeline_reads_what_changed(self):
        """A report may carry only notes; the timeline gives their times, and `after` leaves out executions ended before it."""
        self.say("一")
        first = self.reserve()[1]
        self.assertEqual(self.answer(first["id"])[0], 201)
        self.say("二")
        execution = self.reserve()[1]
        path = f"{self.path}/executions/{execution['id']}"
        notes = [{"seq": 1, "text": "读完材料"}, {"seq": 2, "text": "开始验证"}]
        self.assertEqual(self.request(path, {"action": "segments", "segments": [], "notes": notes}, self.owner)[0], 200)
        self.assertEqual(self.request(path, {"action": "segments", "segments": []}, self.owner)[0], 400, "a report needs segments or notes")
        self.assertEqual([note["text"] for note in self.request(f"{path}/notes")[1]["notes"]], ["读完材料", "开始验证"])
        body = self.request(f"{self.path}/timeline")[1]
        live = next(item for item in body["executions"] if item["id"] == execution["id"])
        self.assertEqual(len(live["notes"]), 2)
        self.assertEqual((live["task"], live["last_note"], live["result"], live["changes"]), ("二", "开始验证", None, None))
        done = next(item for item in body["executions"] if item["id"] == first["id"])
        self.assertEqual((done["task"], done["result"], done["state"]), ("一", "已处理", "done"), "the result is the answer's opening without a summary")
        self.assertEqual(len(body["executions"]), 2)
        later = self.request(f"{self.path}/timeline?after={body['now'] + 60}")[1]
        self.assertEqual([item["id"] for item in later["executions"]], [execution["id"]], "only the running execution is read again")

    def test_owner_describes_members_for_everyone_to_read(self):
        """Descriptions are set by name with the owner credential, read in the room view, and cleared by empty text."""
        path = f"{self.path}/descriptions"
        self.assertEqual(self.request(path, {"descriptions": {"Claude": "审美好"}}, self.member)[0], 403)
        status, body = self.request(path, {"descriptions": {"Claude": "  审美好，UI 写得好  "}}, self.owner)
        self.assertEqual(status, 200, body)
        self.assertEqual(self.request(self.path)[1]["descriptions"], {"Claude": "审美好，UI 写得好"})
        for bad in ({}, {"Claude": "x" * 501}, {"": "x"}, {"Claude": 1}):
            self.assertEqual(self.request(path, {"descriptions": bad}, self.owner)[0], 400, bad)
        self.assertEqual(self.request(path, {"descriptions": {"Claude": ""}}, self.owner)[1]["descriptions"], {})

    def test_owner_labels_members_for_display(self):
        """Display labels are set by name with the owner credential, read in the room view, and cleared by empty text."""
        path = f"{self.path}/labels"
        self.assertEqual(self.request(path, {"labels": {"Claude": "评审官"}}, self.member)[0], 403)
        status, body = self.request(path, {"labels": {"Claude": "  评审官  "}}, self.owner)
        self.assertEqual(status, 200, body)
        self.assertEqual(self.request(self.path)[1]["labels"], {"Claude": "评审官"})
        for bad in ({}, {"Claude": "x" * 33}, {"": "x"}, {"Claude": 1}):
            self.assertEqual(self.request(path, {"labels": bad}, self.owner)[0], 400, bad)
        self.assertEqual(self.request(path, {"labels": {"Claude": ""}}, self.owner)[1]["labels"], {})

    def test_runner_endpoints_need_the_owner_credential(self):
        """Inbox, reservation and lifecycle actions refuse member and missing credentials."""
        self.say("一")
        for token in (None, self.member):
            self.assertEqual(self.request(f"{self.path}/inbox", token=token)[0], 403)
            self.assertEqual(self.request(f"{self.path}/executions", {"member_id": 1, "client_id": "client-0001"}, token)[0], 403)
        execution = self.reserve()[1]
        self.assertEqual(self.request(f"{self.path}/executions/{execution['id']}", token=self.member)[0], 200)
        self.assertEqual(self.request(f"{self.path}/executions/{execution['id']}", {"action": "renew"}, self.member)[0], 403)

    def test_discussion_controls_are_rejected_in_free_rooms(self):
        """Floor, turns, topic phases and runtime controls do not apply to free rooms."""
        for tail, payload in (("/turns", {"actor": "用户", "expert": "Claude", "question": "q", "submission_id": "turn-0001"}),
                              ("/floor", {"actor": "用户", "action": "take", "revision": 0}),
                              ("/topic", {"actor": "用户", "phase": "paused"}),
                              ("/runtime", {"action": "start", "revision": 0})):
            self.assertEqual(self.request(self.path + tail, payload, self.owner)[0], 400, tail)

    def test_archived_room_stops_messages_and_delivery(self):
        """Archiving keeps history readable but ends new requests and executions."""
        self.say("一")
        self.assertEqual(self.request(f"{self.path}/archive", {"actor": "用户"}, self.owner)[0], 200)
        self.assertEqual(self.say("二")[0], 400)
        self.assertEqual(self.reserve()[0], 409)

    def test_room_deletion_removes_free_records(self):
        """Deleting a free room leaves no member, request or execution rows."""
        self.say("一")
        execution = self.reserve()[1]
        self.answer(execution["id"])
        self.assertEqual(self.request(f"{self.path}/delete", {"actor": "用户", "confirm_title": "自由单聊"}, self.owner)[0], 200)
        with closing(sqlite3.connect(self.database)) as connection:
            for table in ("room_modes", "room_members", "member_requests", "member_executions"):
                self.assertEqual(connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0], 0, table)


class MultiMemberTests(FreeRoomTests):
    """Several members: structured recipients, parallel work, membership changes and manual members."""

    expected_host = "Codex"

    def setUp(self):
        """Reuse the single-member room and add Codex as a second runner member."""
        super().setUp()
        self.codex = uuid.uuid4().hex
        status, view = self.request(f"{self.path}/members", {"name": "Codex", "adapter": "codex_cli", "token": self.codex}, self.owner)
        self.assertEqual(status, 200, view)
        # Codex hosts so that Claude's mentions stay suggestions.
        status, view = self.request(f"{self.path}/members/{self.member_id('Codex')}", {"action": "role", "role": "host"}, self.owner)
        self.assertEqual(status, 200, view)

    def member_id(self, name):
        """Resolve a member's stable id from the public view."""
        return next(member["id"] for member in self.request(self.path)[1]["free"]["members"] if member["name"] == name)

    def reserve_for(self, name):
        """Reserve one member's open requests."""
        return self.request(f"{self.path}/executions", {"member_id": self.member_id(name), "client_id": uuid.uuid4().hex,
                                                        "cwd": "d:/project"}, self.owner)

    def start_session(self, goal="讨论目标", named_followup=False):
        """Start a revision-bound discussion session and return its view."""
        discussion = f"{self.path}/discussion"
        current = self.request(discussion)[1]
        status, result = self.request(discussion, {"action": "start", "goal": goal, "revision": current["revision"],
                                                   "named_followup": named_followup}, self.owner)
        self.assertEqual(status, 200, result)
        return result

    def session_roster(self):
        """Read the latest session roster using the current host's member credential."""
        return self.request(f"{self.path}/turns/roster", token=self.codex)[1]

    def arrange_session(self, turns, roster=None, submission_id=None):
        """Submit a host plan against the roster revision it was read from."""
        roster = roster or self.session_roster()
        payload = {"actor": "Codex", "turns": turns, "roster": roster["revision"],
                   "submission_id": submission_id or uuid.uuid4().hex}
        return self.request(f"{self.path}/turns", payload, self.codex)

    def say(self, text, token=None, **extra):
        """Single-member defaults do not apply here: name Claude unless told otherwise."""
        return super().say(text, token, **({"to": ["Claude"]} | extra))

    def test_discussion_start_submission_recovers_only_its_original_session(self):
        """A lost response replays the original start, even after a later session has started."""
        path = f"{self.path}/discussion"
        payload = {"action": "start", "goal": "原始目标", "submission_id": "launch-original",
                   "revision": self.request(path)[1]["revision"]}
        status, first = self.request(path, payload, self.owner)
        self.assertEqual(status, 200, first)
        self.assertFalse(first["duplicate"])
        self.assertEqual(first["session"]["start_submission_id"], payload["submission_id"])
        status, retry = self.request(path, payload, self.owner)
        self.assertEqual(status, 200, retry)
        self.assertTrue(retry["duplicate"])
        self.assertEqual(retry["session"]["id"], first["session"]["id"])
        self.assertEqual(self.request(path, payload, self.codex)[0], 403)
        self.assertEqual(self.request(path, {**payload, "goal": "改写目标"}, self.owner)[0], 409)
        self.assertEqual(self.request(path, {"action": "end", "revision": retry["revision"]}, self.owner)[0], 200)
        second = self.start_session("用户后来开启的新目标")
        status, old = self.request(path, payload, self.owner)
        self.assertEqual(status, 200, old)
        self.assertEqual((old["session"]["id"], old["session"]["status"]), (first["session"]["id"], "concluded"))
        self.assertEqual(self.request(path)[1]["session"]["id"], second["session"]["id"])
        with closing(sqlite3.connect(self.database)) as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM discussion_sessions WHERE room_id=?", (self.room["id"],)).fetchone()[0], 2)

    def test_concurrent_discussion_starts_keep_separate_submission_identities(self):
        """Only one competing start succeeds; replaying the loser cannot adopt the winning session."""
        path = f"{self.path}/discussion"
        revision = self.request(path)[1]["revision"]
        barrier = threading.Barrier(2)
        results = {}

        def start(submission_id):
            barrier.wait()
            results[submission_id] = self.request(path, {"action": "start", "goal": "并发启动",
                                                         "revision": revision, "submission_id": submission_id}, self.owner)

        threads = [threading.Thread(target=start, args=(name,)) for name in ("launch-first", "launch-second")]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(sorted(result[0] for result in results.values()), [200, 409])
        winner = next(name for name, result in results.items() if result[0] == 200)
        current = self.request(path)[1]["session"]
        self.assertEqual(current["start_submission_id"], winner)
        loser = next(name for name in results if name != winner)
        self.assertEqual(self.request(path, {"action": "start", "goal": "并发启动", "revision": revision,
                                             "submission_id": loser}, self.owner)[0], 409)

    def test_a_free_room_starts_and_ends_a_discussion_and_stays_one_room(self):
        """A discussion session uses revisioned controls and leaves the room in free collaboration."""
        discussion = f"{self.path}/discussion"
        self.request(f"{self.path}/members", {"name": "Gemini", "token": uuid.uuid4().hex, "access": "manual"}, self.owner)
        first = self.say("先聊几句")[1]["message"]["id"]
        self.assertEqual(self.request(discussion, {"action": "start"}, self.member)[0], 403)
        initial = self.request(discussion)[1]
        self.assertIsNone(initial["session"])
        self.assertEqual(self.request(discussion, {"action": "start"}, self.owner)[0], 400)
        self.assertEqual(self.request(discussion, {"action": "end"}, self.owner)[0], 400)
        status, started = self.request(discussion, {"action": "start", "revision": initial["revision"],
                                                    "goal": "选方案", "limits": {"max_rounds": 2, "max_minutes": 30}}, self.owner)
        self.assertEqual(status, 200, started)
        self.assertEqual((started["session"]["status"], started["session"]["goal"], started["session"]["limits"]["max_rounds"]),
                         ("active", "选方案", 2))
        self.assertEqual(started["session"]["started_message_id"], first)
        self.assertEqual(self.request(discussion, {"action": "start", "revision": started["revision"]}, self.owner)[0], 409)
        self.assertEqual(self.request(f"{self.path}/messages/{first}")[1]["text"], "先聊几句")
        self.assertEqual(self.request(f"{self.path}/messages")[1]["total"], 1)
        self.assertEqual(self.request(f"{self.path}/messages?withdrawn=include")[1]["total"], 1)
        # A direct question remains a free-room request and does not alter the discussion session.
        direct_message = self.request(f"{self.path}/messages", {"author": "用户", "text": "@Claude 现在怎么样", "to": ["Claude"], "submission_id": uuid.uuid4().hex}, self.owner)[1]["message"]
        direct = self.request(self.path, token=self.owner)[1]["free"]["requests"]
        self.assertEqual([(item["purpose"], item["status"]) for item in direct if item["message_id"] == direct_message["id"]],
                         [("ask", "pending")])
        self.assertEqual(self.request(discussion, {"action": "end", "revision": "stale"}, self.owner)[0], 409)
        current = self.request(discussion)[1]
        status, ended = self.request(discussion, {"action": "end", "revision": current["revision"]}, self.owner)
        self.assertEqual(status, 200, ended)
        self.assertEqual(ended["session"], None)
        # The room remains free; its ordinary direct question stays pending and can be handled normally.
        requests = self.request(self.path)[1]["free"]["requests"]
        self.assertEqual([(item["member"], item["purpose"], item["status"]) for item in requests if item["message_id"] == direct_message["id"]],
                         [("Claude", "ask", "pending")])
        # The room can open a new session after the previous one concludes.
        self.assertEqual(super().say("没有点名")[0], 201)
        latest = self.request(discussion)[1]
        status, again = self.request(discussion, {"action": "start", "revision": latest["revision"], "goal": "第二轮"}, self.owner)
        self.assertEqual(status, 200, again)
        self.assertEqual((again["session"]["goal"], again["session"]["status"]), ("第二轮", "active"))

    def test_paused_discussion_routes_unnamed_owner_message_through_free_collaboration(self):
        """An unnamed message during a paused session uses ordinary host routing without setting held_since."""
        started = self.start_session()
        self.assertEqual(self.request(f"{self.path}/discussion", {
            "action": "pause", "revision": started["revision"],
        }, self.owner)[0], 200)
        status, posted = self.request(f"{self.path}/messages", {
            "author": "用户", "text": "暂停期间的普通路由", "submission_id": uuid.uuid4().hex,
        }, self.owner)
        self.assertEqual(status, 201, posted)
        message_id = posted["message"]["id"]
        requests = [item for item in self.request(self.path, token=self.owner)[1]["free"]["requests"]
                    if item["after_message_id"] == message_id]
        self.assertEqual([(item["member"], item["purpose"]) for item in requests], [("Codex", "route")])
        self.assertEqual(self.request(f"{self.path}/discussion")[1]["session"]["held_since"], 0)

    def test_session_plans_require_fresh_roster_and_cover_all_waiting_experts(self):
        """Single and multi-speaker plans require a current roster, and a whole round must cover its waiting members."""
        gemini_token = uuid.uuid4().hex
        self.request(f"{self.path}/members", {"name": "Gemini", "token": gemini_token}, self.owner)
        self.request(f"{self.path}/members", {"name": "Claude-评审", "token": uuid.uuid4().hex}, self.owner)
        self.start_session(named_followup=True)
        self.assertTrue(self.request(self.path)[1]["named_followup"])
        self.assertTrue(self.request(f"{self.path}/discussion")[1]["session"]["named_followup"])
        roster = self.session_roster()
        self.assertEqual(set(roster["waiting"]), {"Claude", "Gemini", "Claude-评审"})
        turns = self.request(f"{self.path}/turns")[1]
        self.assertEqual(turns["total"], 0, "host system tasks are not public discussion turns")
        with closing(sqlite3.connect(self.database)) as connection:
            host_task_id = connection.execute("SELECT id FROM session_requests WHERE purpose='discuss_host' ORDER BY id DESC LIMIT 1").fetchone()[0]
        self.assertEqual(self.request(f"{self.path}/turns/{host_task_id}")[0], 404)
        single = {"actor": "Codex", "expert": "Claude", "question": "单人安排", "submission_id": uuid.uuid4().hex}
        self.assertEqual(self.request(f"{self.path}/turns", single, self.codex)[0], 400)
        self.assertEqual(self.request(f"{self.path}/turns", {**single, "roster": "stale"}, self.codex)[0], 409)
        full_round = [{"expert": name, "question": f"请回答 {name}"} for name in ("Claude", "Gemini", "Claude-评审")]
        multi = {"actor": "Codex", "turns": full_round[:2], "submission_id": uuid.uuid4().hex}
        self.assertEqual(self.request(f"{self.path}/turns", multi, self.codex)[0], 400)
        self.assertEqual(self.request(f"{self.path}/turns", {**multi, "roster": "stale"}, self.codex)[0], 409)
        status, missing = self.arrange_session(full_round[:2], roster)
        self.assertEqual(status, 400, missing)
        self.assertIn("Claude-评审", missing["error"])
        status, plan = self.arrange_session(full_round, roster)
        self.assertEqual(status, 201, plan)
        self.assertEqual((plan["turn"]["status"], plan["queued"][0]["status"]), ("open", "queued"))

    def test_session_relay_opens_one_request_and_does_not_merge_a_direct_question(self):
        """A direct ask and the next discussion request never share a live execution."""
        gemini_token = uuid.uuid4().hex
        self.request(f"{self.path}/members", {"name": "Gemini", "token": gemini_token}, self.owner)
        self.start_session()
        status, plan = self.arrange_session([{"expert": "Claude", "question": "先发言"},
                                             {"expert": "Gemini", "question": "再发言"}])
        self.assertEqual(status, 201, plan)
        inbox = self.request(f"{self.path}/inbox", token=self.owner)[1]
        pending = next(item for member in inbox["members"] if member["name"] == "Claude" for item in member["pending"]
                       if item["purpose"] == "discuss")
        self.assertEqual((pending["session_request_id"], pending["session_id"], pending["round"], pending["position"],
                          pending["source_question"], pending["cause_kind"]),
                         (plan["turn"]["id"], plan["turn"]["session_id"], plan["turn"]["round"], plan["turn"]["position"],
                          "先发言", "scheduled_speaker"))
        self.assertEqual(self.say("请 Gemini 另答一个问题", to=["Gemini"])[0], 201)
        ask_execution = self.reserve_for("Gemini")[1]
        self.assertEqual([request["purpose"] for request in ask_execution["requests"]], ["ask"])
        execution = self.reserve_for("Claude")[1]
        self.assertEqual([request["purpose"] for request in execution["requests"]], ["discuss"])
        discuss_request = execution["requests"][0]
        self.assertEqual((discuss_request["session_request_id"], discuss_request["session_id"], discuss_request["round"],
                          discuss_request["position"], discuss_request["read_until"], discuss_request["source_question"],
                          discuss_request["cause_kind"], discuss_request["source_message_id"], discuss_request["cause_request_id"]),
                         (plan["turn"]["id"], plan["turn"]["session_id"], plan["turn"]["round"], plan["turn"]["position"],
                          plan["turn"]["read_until"], "先发言", "scheduled_speaker", None, None))
        open_plans = [item for item in self.request(f"{self.path}/turns")[1]["turns"] if item["purpose"] == "discuss" and item["status"] == "open"]
        self.assertEqual([item["expert"] for item in open_plans], ["Claude"])
        self.assertEqual(self.answer(execution["id"], token=self.member)[0], 201)
        turns = self.request(f"{self.path}/turns")[1]["turns"]
        self.assertEqual([(item["expert"], item["status"]) for item in turns if item["purpose"] == "discuss"],
                         [("Claude", "answered"), ("Gemini", "open")])
        self.assertEqual(self.reserve_for("Gemini")[0], 409, "the ask execution still owns Gemini's session")
        ask_answer = {"author": "Gemini", "text": "普通提问答复", "source": "cli", "execution_id": ask_execution["id"],
                      "submission_id": uuid.uuid4().hex}
        self.assertEqual(self.request(f"{self.path}/messages", ask_answer, gemini_token)[0], 201)
        asks = [item for item in self.request(self.path)[1]["free"]["requests"] if item["purpose"] == "ask"]
        self.assertEqual([(item["member"], item["status"]) for item in asks], [("Gemini", "completed")])
        next_execution = self.reserve_for("Gemini")[1]
        self.assertEqual([request["purpose"] for request in next_execution["requests"]], ["discuss"])

    def test_failed_session_request_returns_to_host_without_ending_session(self):
        """A failed speaker request is handed to the host while the session remains active."""
        self.start_session()
        status, plan = self.arrange_session([{"expert": "Claude", "question": "失败测试"}])
        self.assertEqual(status, 201, plan)
        execution = self.reserve_for("Claude")[1]
        self.assertEqual(self.request(f"{self.path}/executions/{execution['id']}",
                                      {"action": "fail", "reason": "测试投递失败"}, self.owner)[0], 200)
        session = self.request(f"{self.path}/discussion")[1]["session"]
        self.assertEqual(session["status"], "active")
        turns = self.request(f"{self.path}/turns")[1]["turns"]
        self.assertEqual([item["status"] for item in turns if item["purpose"] == "discuss"], ["failed"])
        with closing(sqlite3.connect(self.database)) as connection:
            host_questions = [row[0] for row in connection.execute("""SELECT m.text FROM member_requests r
                JOIN messages m ON m.id=r.message_id WHERE r.room_id=? AND r.purpose='discuss_host'""", (self.room["id"],))]
        self.assertTrue(any("测试投递失败" in text for text in host_questions))

    def test_interrupting_open_discussion_speaker_cancels_plan_and_advances_queue(self):
        """Stopping a speaker ends its session row before the next queued speaker is opened."""
        gemini_token = uuid.uuid4().hex
        self.request(f"{self.path}/members", {"name": "Gemini", "token": gemini_token}, self.owner)
        self.start_session()
        status, plan = self.arrange_session([
            {"expert": "Claude", "question": "先发言"},
            {"expert": "Gemini", "question": "接着发言"},
        ])
        self.assertEqual(status, 201, plan)
        execution = self.reserve_for("Claude")[1]

        interrupted = self.request(f"{self.path}/members/{self.member_id('Claude')}/interrupt", {}, self.owner)

        self.assertEqual(interrupted[0], 200, interrupted[1])
        turns = [item for item in self.request(f"{self.path}/turns")[1]["turns"] if item["purpose"] == "discuss"]
        self.assertEqual([(item["expert"], item["status"]) for item in turns],
                         [("Claude", "cancelled"), ("Gemini", "open")])
        self.assertEqual(self.request(f"{self.path}/executions/{execution['id']}", token=self.owner)[1]["status"], "cancelled")
        self.assertEqual(self.reserve_for("Gemini")[0], 200)

    def test_interrupting_last_open_discussion_speaker_hands_control_to_host_once(self):
        """With no queued speaker left, interruption cancels its plan and creates one host follow-up."""
        self.start_session()
        status, plan = self.arrange_session([{"expert": "Claude", "question": "单人安排"}])
        self.assertEqual(status, 201, plan)
        execution = self.reserve_for("Claude")[1]
        path = f"{self.path}/members/{self.member_id('Claude')}/interrupt"
        self.assertEqual(self.request(path, {}, self.owner)[0], 200)
        self.assertEqual(self.request(f"{self.path}/executions/{execution['id']}", token=self.owner)[1]["status"], "cancelled")
        with closing(sqlite3.connect(self.database)) as connection:
            host_requests = connection.execute("SELECT COUNT(*) FROM session_requests WHERE purpose='discuss_host'").fetchone()[0]
            plan_status = connection.execute("SELECT status FROM session_requests WHERE id=?", (plan["turn"]["id"],)).fetchone()[0]
        self.assertEqual(plan_status, "cancelled")
        self.assertGreater(host_requests, 1)
        self.assertEqual(self.request(path, {}, self.owner)[0], 200)
        with closing(sqlite3.connect(self.database)) as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM session_requests WHERE purpose='discuss_host'").fetchone()[0],
                             host_requests)

    def test_failed_session_speaker_does_not_freeze_round_progress(self):
        """A failed speaker can be retried, after which the next complete plan advances to round two."""
        gemini_token = uuid.uuid4().hex
        self.request(f"{self.path}/members", {"name": "Gemini", "token": gemini_token}, self.owner)
        self.start_session()
        status, plan = self.arrange_session([
            {"expert": "Claude", "question": "第一轮 Claude"},
            {"expert": "Gemini", "question": "第一轮 Gemini"},
        ])
        self.assertEqual(status, 201, plan)
        failed = self.reserve_for("Claude")[1]
        self.assertEqual(self.request(f"{self.path}/executions/{failed['id']}",
                                      {"action": "fail", "reason": "CLI 退出"}, self.owner)[0], 200)
        roster = self.session_roster()
        self.assertEqual(roster["round"], 1)
        self.assertEqual(self.request(f"{self.path}/turns/continue", {
            "actor": "Codex", "revision": roster["revision"],
        }, self.codex)[0], 200)
        gemini = self.reserve_for("Gemini")[1]
        self.assertEqual(self.answer(gemini["id"], token=gemini_token, author="Gemini")[0], 201)
        roster = self.session_roster()
        self.assertEqual(roster["waiting"], ["Claude"])
        status, retry = self.arrange_session([{"expert": "Claude", "question": "重试第一轮 Claude"}], roster)
        self.assertEqual(status, 201, retry)
        claude = self.reserve_for("Claude")[1]
        self.assertEqual(self.answer(claude["id"], token=self.member)[0], 201)

        roster = self.session_roster()
        self.assertEqual(roster["round"], 1)
        status, second_round = self.arrange_session([
            {"expert": "Claude", "question": "第二轮 Claude"},
            {"expert": "Gemini", "question": "第二轮 Gemini"},
        ], roster)
        self.assertEqual(status, 201, second_round)
        self.assertEqual([second_round["turn"]["round"], second_round["queued"][0]["round"]], [2, 2])

    def test_initial_session_execution_reads_no_messages_when_cutoff_is_zero(self):
        """An initial independent opinion has a real empty read boundary and cannot read later user text."""
        self.request(f"{self.path}/members", {"name": "Gemini", "token": uuid.uuid4().hex}, self.owner)
        self.start_session()
        status, plan = self.arrange_session([{"expert": "Claude", "question": "独立观点"}])
        self.assertEqual(status, 201, plan)
        execution = self.reserve_for("Claude")[1]
        later = self.say("后续私有用户消息")[1]["message"]["id"]
        query = f"?execution_id={execution['id']}"
        result = self.request(f"{self.path}/messages{query}", token=self.member)
        self.assertEqual(result[0], 200, result)
        self.assertEqual(result[1]["total"], 0)
        self.assertEqual(self.request(f"{self.path}/messages/{later}{query}", token=self.member)[0], 404)
        self.say("Gemini 也请回答", to=["Gemini"])
        other = self.reserve_for("Gemini")[1]
        self.assertEqual(self.request(f"{self.path}/messages?execution_id={other['id']}", token=self.member)[0], 403)

    def test_initial_session_anonymous_message_reads_keep_the_server_cutoff(self):
        """Omitting a member credential cannot bypass initial-stage message restrictions through API or /r."""
        self.start_session()
        status, posted = self.request(f"{self.path}/messages", {
            "author": "用户", "text": "匿名不可见的后续原文", "to": ["Claude"],
            "submission_id": uuid.uuid4().hex,
        }, self.owner)
        self.assertEqual(status, 201, posted)
        later = posted["message"]["id"]

        self.assertEqual(self.request(f"{self.path}/messages")[1]["total"], 0)
        self.assertEqual(self.request(f"{self.path}/messages/{later}")[0], 404)
        self.assertEqual(self.request(f"{self.path}/messages", token=self.member)[1]["total"], 0)
        self.assertNotIn("匿名不可见的后续原文", self.read_text(f"/r/{self.room['id']}/messages"))
        self.assertNotIn("匿名不可见的后续原文", self.read_text(
            f"/r/{self.room['id']}/search?q={quote('匿名不可见')}"))

    def test_explicit_direct_ask_execution_can_read_its_own_message_during_initial_phase(self):
        """A valid ask binding keeps access to its own post-start source while bare member reads remain bounded."""
        gemini_token = uuid.uuid4().hex
        self.request(f"{self.path}/members", {"name": "Gemini", "token": gemini_token}, self.owner)
        self.start_session()
        status, posted = self.say("直接提问的私有原文", to=["Gemini"])
        self.assertEqual(status, 201, posted)
        message_id = posted["message"]["id"]
        execution = self.reserve_for("Gemini")[1]
        ask_request_id = next(item["id"] for item in self.request(self.path, token=self.owner)[1]["free"]["requests"]
                              if item["message_id"] == message_id)

        bare_read = self.request(f"{self.path}/messages", token=gemini_token)[1]
        bound_read = self.request(f"{self.path}/messages?execution_id={execution['id']}", token=gemini_token)[1]
        request_read = self.request(f"{self.path}/messages?request_id={ask_request_id}", token=gemini_token)[1]
        self.assertEqual(bare_read["total"], 0)
        self.assertEqual([item["id"] for item in bound_read["messages"]], [message_id])
        self.assertEqual([item["id"] for item in request_read["messages"]], [message_id])
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute("UPDATE member_executions SET lease_until=0 WHERE id=?", (execution["id"],))
        self.assertEqual(self.request(f"{self.path}/messages?request_id={ask_request_id}", token=gemini_token)[0], 409)
        self.assertEqual(self.request(f"{self.path}/messages?execution_id={execution['id']}", token=gemini_token)[0], 409)

    def test_initial_session_hides_room_state_execution_details_timeline_and_backup(self):
        """Anonymous initial readers cannot reach later answers through summary and activity endpoints."""
        gemini_token = uuid.uuid4().hex
        self.request(f"{self.path}/members", {"name": "Gemini", "token": gemini_token}, self.owner)
        self.assertEqual(self.say("边界前普通任务")[0], 201)
        prior_execution = self.reserve_for("Claude")[1]
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute("UPDATE member_executions SET status='failed',result=? WHERE id=?",
                               ("普通执行失败原因", prior_execution["id"]))
        self.start_session()
        self.assertEqual(self.say("边界后私有失败任务", to=["Gemini"])[0], 201)
        private_execution = self.reserve_for("Gemini")[1]
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute("UPDATE member_executions SET status='failed',result=? WHERE id=?",
                               ("边界后私有失败原因", private_execution["id"]))
        status, plan = self.arrange_session([{"expert": "Claude", "question": "不可公开的安排问题"}])
        self.assertEqual(status, 201, plan)
        execution = self.reserve_for("Claude")[1]
        execution_path = f"{self.path}/executions/{execution['id']}"
        self.assertEqual(self.request(execution_path, {"action": "renew", "notes": [
            {"seq": 1, "text": "不可公开的执行过程"},
        ]}, self.owner)[0], 200)
        status, answer = self.answer(execution["id"], "不可公开的独立观点答复")
        self.assertEqual(status, 201, answer)
        self.assertEqual(self.request(f"{self.path}/state", {
            "actor": "Codex", "text": "不可公开的状态摘要", "brief": "不可公开的主持简报",
            "until": answer["message"]["id"],
        }, self.codex)[0], 200)

        anonymous_room = self.request(self.path)[1]
        hidden_free_failure = next(item for item in anonymous_room["free"]["executions"]
                                   if item["id"] == private_execution["id"])
        hidden_member_failure = next(item for item in anonymous_room["free"]["members"]
                                     if item["name"] == "Gemini")["execution"]
        self.assertEqual((hidden_free_failure["result"], hidden_member_failure["result"]), ("", ""))
        member_room = self.request(self.path, token=gemini_token)[1]
        self.assertEqual(next(item for item in member_room["free"]["executions"]
                              if item["id"] == private_execution["id"])["result"], "")
        owner_room = self.request(self.path, token=self.owner)[1]
        owner_free_failure = next(item for item in owner_room["free"]["executions"]
                                  if item["id"] == private_execution["id"])
        owner_member_failure = next(item for item in owner_room["free"]["members"]
                                    if item["name"] == "Gemini")["execution"]
        self.assertEqual((owner_free_failure["result"], owner_member_failure["result"]),
                         ("边界后私有失败原因", "边界后私有失败原因"))
        self.assertIsNone(next(item for item in anonymous_room["free"]["executions"]
                               if item["id"] == execution["id"])["answer_id"])
        self.assertNotIn("不可公开的独立观点答复", json.dumps(anonymous_room, ensure_ascii=False))
        self.assertEqual(anonymous_room["state_text"], "")
        self.assertIsNone(anonymous_room["host_brief"])
        self.assertNotIn("不可公开的状态摘要", self.read_text(f"/r/{self.room['id']}/state"))
        self.assertIn("不可公开的状态摘要", self.request(self.path, token=self.codex)[1]["state_text"])
        self.assertEqual(self.request(f"{execution_path}/notes")[1]["notes"], [])
        self.assertEqual(self.request(execution_path)[0], 403)
        timeline = self.request(f"{self.path}/timeline")[1]["executions"]
        hidden = next(item for item in timeline if item["id"] == execution["id"])
        self.assertEqual((hidden["task"], hidden["result"], hidden["last_note"], hidden["reason"]), ("", "", "", ""))
        self.assertIsNone(hidden["answer_id"])
        prior = next(item for item in timeline if item["id"] == prior_execution["id"])
        self.assertEqual((prior["task"], prior["reason"]), ("边界前普通任务", "普通执行失败原因"))
        backup_status, backup = self.request(f"{self.path}/backup")
        self.assertEqual(backup_status, 403)
        self.assertIn("独立观点阶段需房主凭据导出", backup["error"])
        self.assertEqual(self.request(f"{self.path}/backup", token=self.owner)[0], 200)
        self.assertEqual(self.request(f"{self.path}/backup", token=self.codex)[0], 200)
        host_timeline = self.request(f"{self.path}/timeline", token=self.codex)[1]["executions"]
        visible = next(item for item in host_timeline if item["id"] == execution["id"])
        self.assertEqual(visible["result"], "不可公开的独立观点答复")
        self.assertEqual(visible["last_note"], "不可公开的执行过程")

    def test_invited_initial_expert_keeps_the_session_read_cutoff(self):
        """A newly invited first-round speaker cannot read opinions posted after the session opened."""
        self.start_session()
        status, plan = self.arrange_session([{"expert": "Claude", "question": "先给开场观点"}])
        self.assertEqual(status, 201, plan)
        gemini_token = uuid.uuid4().hex
        status, member = self.request(f"{self.path}/members", {"name": "Gemini", "token": gemini_token}, self.owner)
        self.assertEqual(status, 200, member)
        first = self.reserve_for("Claude")[1]
        self.assertEqual(self.answer(first["id"], "前位专家观点")[0], 201)
        next_execution = self.reserve_for("Gemini")[1]
        self.assertEqual([item["purpose"] for item in next_execution["requests"]], ["discuss"])
        result = self.request(f"{self.path}/messages?execution_id={next_execution['id']}", token=gemini_token)
        self.assertEqual(result[0], 200, result[1])
        self.assertEqual(result[1]["total"], 0)

    def test_text_turn_history_survives_end_and_legacy_view_is_explicit(self):
        """The read-only turns page stays on the latest session after end unless legacy=1 is requested."""
        self.start_session()
        status, plan = self.arrange_session([{"expert": "Claude", "question": "新会话安排"}])
        self.assertEqual(status, 201, plan)
        turn_id = plan["turn"]["id"]
        with closing(sqlite3.connect(self.database)) as connection:
            connection.execute("""INSERT INTO discussion_turns(id,room_id,expert,question,status,submission_id,created_at)
                VALUES(?,?,?,'旧历史安排','pending',?,?)""",
                (turn_id, self.room["id"], "Claude", f"legacy-{turn_id}", "2026-10-29T00:00:00Z"))
            connection.commit()
        view = self.request(f"{self.path}/discussion")[1]
        self.assertEqual(self.request(f"{self.path}/discussion", {"action": "end", "revision": view["revision"]}, self.owner)[0], 200)
        current = self.read_text(f"/r/{self.room['id']}/turns/{turn_id}")
        self.assertIn("新会话安排", current)
        self.assertNotIn("旧历史安排", current)
        legacy = self.read_text(f"/r/{self.room['id']}/turns/{turn_id}?legacy=1")
        self.assertIn("旧历史安排", legacy)

    def test_discussion_task_messages_are_hidden_from_ordinary_reads_and_counts(self):
        """Internal task anchors stay out of room messages, search, incremental reads and public message counts."""
        before = self.request(self.path)[1]
        self.start_session("隐藏任务锚点唯一词")
        after = self.request(self.path)[1]
        self.assertEqual((after["message_count"], after["latest_id"]), (before["message_count"], before["latest_id"]))
        with closing(sqlite3.connect(self.database)) as connection:
            task_ids = [row[0] for row in connection.execute("SELECT message_id FROM task_message_sources WHERE session_id=(SELECT MAX(id) FROM discussion_sessions WHERE room_id=?)", (self.room["id"],))]
            self.assertTrue(task_ids)
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM scheduler_decisions WHERE room_id=?", (self.room["id"],)).fetchone()[0], 0)
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM member_requests WHERE room_id=? AND purpose='route'", (self.room["id"],)).fetchone()[0], 0)
        search_term = quote("隐藏任务锚点唯一词")
        for query in ("", "?after=0", "?withdrawn=include", f"?q={search_term}"):
            status, result = self.request(f"{self.path}/messages{query}")
            self.assertEqual(status, 200, result)
            self.assertTrue(set(task_ids).isdisjoint(item["id"] for item in result["messages"]))
        self.assertEqual(self.request(f"{self.path}/messages/{task_ids[0]}")[0], 404)
        self.assertNotIn("隐藏任务锚点唯一词", self.read_text(f"/r/{self.room['id']}/search?q={search_term}"))
        self.assertNotEqual(self.request(f"{self.path}/messages/{task_ids[0]}/retract", {}, self.owner)[0], 200)

    def test_rewind_invalidates_task_sources_and_never_reactivates_their_requests(self):
        """Rewinding a user trigger invalidates its hidden task anchor and linked request without relaying work."""
        self.start_session()
        status, saved = super().say("回退后不应继续主持任务")
        self.assertEqual(status, 201, saved)
        trigger = saved["message"]["id"]
        view = self.request(f"{self.path}/discussion")[1]
        self.assertEqual(self.request(f"{self.path}/discussion", {"action": "end", "revision": view["revision"]}, self.owner)[0], 200)
        status, plan = self.request(f"{self.path}/rewind?message_id={trigger}", token=self.owner)
        self.assertEqual(status, 200, plan)
        result = self.request(f"{self.path}/rewind", {"message_id": trigger, "revision": plan["revision"]}, self.owner)
        self.assertEqual(result[0], 200, result[1])
        with closing(sqlite3.connect(self.database)) as connection:
            rows = connection.execute("""SELECT q.status,r.status FROM task_message_sources t
                JOIN session_requests q ON q.id=t.session_request_id
                JOIN member_requests r ON r.id=q.member_request_id
                WHERE t.cause_message_id=?""", (trigger,)).fetchall()
            self.assertTrue(rows)
            self.assertTrue(all(plan_status == "cancelled" and request_status == "cancelled" for plan_status, request_status in rows))
            self.assertEqual(connection.execute("""SELECT COUNT(*) FROM session_requests
                WHERE session_id=(SELECT MAX(id) FROM discussion_sessions WHERE room_id=?) AND status IN ('open','queued')""",
                (self.room["id"],)).fetchone()[0], 0)

    def test_session_pause_cancel_and_end_revoke_executions_and_reject_late_answers(self):
        """Pausing, cancelling a plan and ending a session invalidate its execution before a late answer arrives."""
        self.start_session()
        status, plan = self.arrange_session([{"expert": "Claude", "question": "暂停测试"}])
        self.assertEqual(status, 201, plan)
        first = self.reserve_for("Claude")[1]
        view = self.request(f"{self.path}/discussion")[1]
        paused = self.request(f"{self.path}/discussion", {"action": "pause", "revision": view["revision"]}, self.owner)
        self.assertEqual(paused[0], 200, paused[1])
        self.assertEqual(self.answer(first["id"], token=self.member)[0], 409)
        view = self.request(f"{self.path}/discussion")[1]
        self.assertEqual(self.request(f"{self.path}/discussion", {"action": "resume", "revision": view["revision"]}, self.owner)[0], 200)
        status, plan = self.arrange_session([{"expert": "Claude", "question": "取消测试"}])
        self.assertEqual(status, 201, plan)
        second = self.reserve_for("Claude")[1]
        cancelled = self.request(f"{self.path}/turns/{plan['turn']['id']}", {"status": "cancelled", "actor": "Codex"}, self.codex)
        self.assertEqual(cancelled[0], 200, cancelled[1])
        self.assertEqual(self.answer(second["id"], token=self.member)[0], 409)
        with closing(sqlite3.connect(self.database)) as connection:
            host_requests = connection.execute("SELECT COUNT(*) FROM session_requests WHERE purpose='discuss_host'").fetchone()[0]
        self.assertEqual(self.request(f"{self.path}/turns/{plan['turn']['id']}",
                                      {"status": "cancelled", "actor": "Codex"}, self.codex)[0], 409)
        with closing(sqlite3.connect(self.database)) as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM session_requests WHERE purpose='discuss_host'").fetchone()[0],
                             host_requests)
        status, plan = self.arrange_session([{"expert": "Claude", "question": "结束测试"}])
        self.assertEqual(status, 201, plan)
        third = self.reserve_for("Claude")[1]
        view = self.request(f"{self.path}/discussion")[1]
        ended = self.request(f"{self.path}/discussion", {"action": "end", "revision": view["revision"]}, self.owner)
        self.assertEqual(ended[0], 200, ended[1])
        self.assertEqual(self.answer(third["id"], token=self.member)[0], 409)

    def test_cancelling_terminal_session_plans_conflicts_without_duplicate_host_tasks(self):
        """Answered, failed and already-cancelled plans all reject cancellation without waking the host again."""
        self.start_session()
        status, answered = self.arrange_session([{"expert": "Claude", "question": "已回答"}])
        self.assertEqual(status, 201, answered)
        first = self.reserve_for("Claude")[1]
        self.assertEqual(self.answer(first["id"], token=self.member)[0], 201)
        with closing(sqlite3.connect(self.database)) as connection:
            before_answered_cancel = connection.execute("SELECT COUNT(*) FROM session_requests WHERE purpose='discuss_host'").fetchone()[0]
        self.assertEqual(self.request(f"{self.path}/turns/{answered['turn']['id']}",
                                      {"status": "cancelled", "actor": "Codex"}, self.codex)[0], 409)
        with closing(sqlite3.connect(self.database)) as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM session_requests WHERE purpose='discuss_host'").fetchone()[0],
                             before_answered_cancel)

        status, failed = self.arrange_session([{"expert": "Claude", "question": "已失败"}])
        self.assertEqual(status, 201, failed)
        second = self.reserve_for("Claude")[1]
        self.assertEqual(self.request(f"{self.path}/executions/{second['id']}",
                                      {"action": "fail", "reason": "投递失败"}, self.owner)[0], 200)
        with closing(sqlite3.connect(self.database)) as connection:
            before_failed_cancel = connection.execute("SELECT COUNT(*) FROM session_requests WHERE purpose='discuss_host'").fetchone()[0]
        self.assertEqual(self.request(f"{self.path}/turns/{failed['turn']['id']}",
                                      {"status": "cancelled", "actor": "Codex"}, self.codex)[0], 409)
        with closing(sqlite3.connect(self.database)) as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM session_requests WHERE purpose='discuss_host'").fetchone()[0],
                             before_failed_cancel)

    def test_unnamed_message_with_several_members_goes_only_to_the_host(self):
        """With two members an unnamed message is routed by the host; nothing is broadcast."""
        self.assertEqual(super().say("没有点名")[0], 201)
        self.assertEqual([(item["member"], item["purpose"]) for item in self.request(self.path)[1]["free"]["requests"]], [("Codex", "route")])

    def test_naming_two_members_creates_two_requests_that_run_in_parallel(self):
        """One message to both members queues one request each; both can execute at once."""
        self.assertEqual(self.say("一起看看", to=["Claude", "Codex", "Claude"])[0], 201)
        self.assertEqual(self.say("不在场", to=["Gemini"])[0], 400)
        requests = self.request(self.path)[1]["free"]["requests"]
        self.assertEqual(sorted(item["member"] for item in requests), ["Claude", "Codex"])
        self.assertEqual(self.reserve_for("Claude")[0], 200)
        self.assertEqual(self.reserve_for("Codex")[0], 200)
        self.assertEqual(self.request(self.path)[1]["experts"], {"Claude": "cli", "Codex": "cli"})

    def test_adding_a_member_does_not_interrupt_another_members_work(self):
        """Claude keeps its live execution while Gemini joins."""
        self.say("开始")
        execution = self.reserve_for("Claude")[1]
        self.assertEqual(self.request(f"{self.path}/members", {"name": "Gemini", "token": uuid.uuid4().hex}, self.owner)[0], 200)
        self.assertEqual(self.request(f"{self.path}/members", {"name": "Codex", "token": uuid.uuid4().hex}, self.owner)[0], 409)
        self.assertEqual(self.request(f"{self.path}/members", {"name": "Qwen", "token": uuid.uuid4().hex}, self.member)[0], 403)
        self.assertEqual(self.answer(execution["id"])[0], 201)

    def test_member_suggestion_requires_owner_and_converts_once_with_fresh_chain(self):
        """A suggestion stays inert, then one owner confirmation creates a deliverable request."""
        original = self.say("先请 Claude 看看")[1]["message"]
        execution = self.reserve_for("Claude")[1]
        status, saved = self.answer(execution["id"], "建议 @Codex 检查边界。", to=["Codex", "Codex"])
        self.assertEqual(status, 201, saved)
        source = saved["message"]
        self.assertEqual([item["member"] for item in source["suggestions"]], ["Codex"])
        self.assertEqual(len(self.request(self.path)[1]["free"]["requests"]), 1)
        payload = {"message_id": source["id"], "member_id": self.member_id("Codex")}
        for token in (None, "wrong-token", self.member, self.codex):
            self.assertEqual(self.request(f"{self.path}/suggestions", payload, token)[0], 403)
        status, converted = self.request(f"{self.path}/suggestions", payload, self.owner)
        self.assertEqual(status, 200, converted)
        request = converted["request"]
        self.assertFalse(converted["duplicate"])
        self.assertEqual((request["message_id"], request["created_by"]), (source["id"], "user"))
        self.assertNotIn(request["chain_id"], (source["id"], original["id"]))
        confirmation = self.request(f"{self.path}/messages/{request['chain_id']}")[1]
        self.assertEqual((confirmation["author"], confirmation["reply_to"]), ("用户", source["id"]))
        for _ in range(2):
            retry = self.request(f"{self.path}/suggestions", payload, self.owner)[1]
            self.assertTrue(retry["duplicate"])
            self.assertEqual(retry["request"]["id"], request["id"])
        delivered = self.reserve_for("Codex")[1]
        self.assertEqual([item["message_id"] for item in delivered["requests"]], [source["id"]])
        self.assertEqual(self.answer(delivered["id"], author="Codex", token=self.codex)[0], 201)
        retry = self.request(f"{self.path}/suggestions", payload, self.owner)[1]
        self.assertEqual(retry["request"]["status"], "completed")
        source = self.request(f"{self.path}/messages/{source['id']}")[1]
        self.assertEqual(source["suggestions"][0]["request_id"], request["id"])
        self.assertEqual(len(self.request(self.path)[1]["free"]["requests"]), 2)

    def test_suggestions_ignore_code_quotes_partial_names_and_self(self):
        """Only prose mentions or structured targets become response suggestions."""
        samples = ["`@Codex`", "`` @Codex ` nested ``", "```txt\n@Codex\n```", "~~~\n@Codex\n~~~",
                   "    @Codex", "  > quote\n@Codex", "> @Codex", "@Codex-评审", "@Claude", "```\n@Codex"]
        for text in samples:
            self.say("查看")
            execution = self.reserve_for("Claude")[1]
            status, saved = self.answer(execution["id"], text)
            self.assertEqual(status, 201, saved)
            self.assertEqual(saved["message"]["suggestions"], [], text)
        self.say("查看")
        source = self.answer(self.reserve_for("Claude")[1]["id"], "> 引用 @Claude\n\n请 @Codex 看看。 @Codex 再核对。 \n@不在场")[1]["message"]
        self.assertEqual([item["member"] for item in source["suggestions"]], ["Codex"])

    def test_suggestion_conversion_rejects_absent_targets_and_wrong_sources(self):
        """A stale button, archived room or unrelated message cannot dispatch work."""
        original = self.say("查看")[1]["message"]
        source = self.answer(self.reserve_for("Claude")[1]["id"], "请 @Codex 看看")[1]["message"]
        target = self.member_id("Codex")
        payload = {"message_id": source["id"], "member_id": target}
        self.assertEqual(self.request(f"{self.path}/suggestions", {**payload, "message_id": original["id"]}, self.owner)[0], 404)
        self.assertEqual(self.request(f"{self.path}/suggestions", {**payload, "member_id": True}, self.owner)[0], 400)
        self.request(f"{self.path}/archive", {"actor": "用户"}, self.owner)
        self.assertEqual(self.request(f"{self.path}/suggestions", payload, self.owner)[0], 400)
        self.request(f"{self.path}/restore", {"actor": "用户"}, self.owner)
        self.request(f"{self.path}/members/{target}", {"action": "away"}, self.owner)
        self.assertEqual(self.request(f"{self.path}/suggestions", payload, self.owner)[0], 409)

    def test_away_voids_work_and_return_needs_a_new_credential(self):
        """Leaving cancels only that member's work; old credential copies never revive."""
        self.say("两人", to=["Claude", "Codex"])
        claude = self.reserve_for("Claude")[1]
        codex = self.reserve_for("Codex")[1]
        codex_id = self.member_id("Codex")
        view = self.request(f"{self.path}/members/{codex_id}", {"action": "away"}, self.owner)[1]
        statuses = {member["name"]: (member["status"], member["execution"]["status"]) for member in view["members"]}
        self.assertEqual(statuses, {"Claude": ("active", "dispatched"), "Codex": ("away", "cancelled")})
        self.assertEqual(self.say("只给离开的人", to=["Codex"])[0], 400)
        late = {"author": "Codex", "text": "迟到", "submission_id": uuid.uuid4().hex, "execution_id": codex["id"]}
        self.assertEqual(self.request(f"{self.path}/messages", late, self.codex)[0], 403)
        self.assertEqual(self.request(f"{self.path}/members/{codex_id}", {"action": "active", "token": self.codex}, self.owner)[0], 400)
        renewed = uuid.uuid4().hex
        self.assertEqual(self.request(f"{self.path}/members/{codex_id}", {"action": "active", "token": renewed}, self.owner)[0], 200)
        self.assertEqual(self.request(f"{self.path}/messages", {**late, "submission_id": uuid.uuid4().hex}, self.codex)[0], 403)
        self.assertEqual(self.request(f"{self.path}/messages", {**late, "submission_id": uuid.uuid4().hex}, renewed)[0], 409)
        self.assertEqual(self.answer(claude["id"])[0], 201)

    def test_removed_host_hands_unnamed_message_to_the_new_host(self):
        """An unnamed message waiting on the host must still reach its successor, and the cancelled request says why."""
        message = FreeRoomTests.say(self, "没点名的问题")[1]["message"]
        codex_id = self.member_id("Codex")
        self.assertEqual(self.request(f"{self.path}/members/{codex_id}", {"action": "remove"}, self.owner)[0], 200)
        room = self.request(self.path)[1]
        mine = [(item["member"], item["status"], item["purpose"], item["cancel_reason"]) for item in room["free"]["requests"]
                if item["message_id"] == message["id"]]
        self.assertEqual(room["host"], "Claude")
        self.assertEqual(sorted(mine), [("Claude", "pending", "route", None), ("Codex", "cancelled", "route", "member_removed")])

    def test_switching_host_moves_unstarted_routes_and_stop_records_its_reason(self):
        """A host change moves pending unnamed messages; stopping a member records user_stop."""
        message = FreeRoomTests.say(self, "没点名的问题")[1]["message"]
        claude_id = self.member_id("Claude")
        self.assertEqual(self.request(f"{self.path}/members/{claude_id}", {"action": "role", "role": "host"}, self.owner)[0], 200)
        room = self.request(self.path)[1]
        mine = sorted((item["member"], item["status"], item["cancel_reason"]) for item in room["free"]["requests"] if item["message_id"] == message["id"])
        self.assertEqual(mine, [("Claude", "pending", None), ("Codex", "cancelled", "rerouted")])
        self.reserve_for("Claude")
        self.assertEqual(self.request(f"{self.path}/members/{claude_id}/interrupt", {}, self.owner)[0], 200)
        room = self.request(self.path)[1]
        self.assertEqual([item["cancel_reason"] for item in room["free"]["requests"] if item["member"] == "Claude"], ["user_stop"])

    def test_archive_voids_open_work(self):
        """Archiving a free room cancels delivering and pending requests so nothing is answered or delivered later."""
        self.say("给 Claude", to=["Claude"])
        execution = self.reserve_for("Claude")[1]
        self.say("再来一条", to=["Claude"])
        self.assertEqual(self.request(f"{self.path}/archive", {"actor": "用户"}, self.owner)[0], 200)
        room = self.request(self.path)[1]
        self.assertEqual({(item["status"], item["cancel_reason"]) for item in room["free"]["requests"]}, {("cancelled", "archived")})
        self.assertEqual(next(item for item in room["free"]["executions"] if item["id"] == execution["id"])["status"], "cancelled")

    def test_removed_member_leaves_history_and_participants(self):
        """Removal keeps past messages but drops the member from the participant list."""
        codex_id = self.member_id("Codex")
        self.assertEqual(self.request(f"{self.path}/members/{codex_id}", {"action": "remove"}, self.owner)[0], 200)
        room = self.request(self.path)[1]
        self.assertEqual([member["name"] for member in room["free"]["members"]], ["Claude"])
        self.assertEqual(room["experts"], {"Claude": "cli"})
        self.assertEqual(self.request(f"{self.path}/members/{codex_id}", {"action": "active", "token": uuid.uuid4().hex}, self.owner)[0], 404)

    def test_smart_scheduling_may_recommend_a_manual_member(self):
        """A manual member is a valid recommendation target, and adopting asks it like any other member."""
        self.assertIsNone(self.request(self.path)[1]["session"], "a free room has no discussion session")
        gemini = uuid.uuid4().hex
        self.request(f"{self.path}/members", {"name": "Gemini", "token": gemini, "access": "manual"}, self.owner)
        self.assertEqual(self.request(f"{self.path}/register", {}, gemini)[0], 200)
        route = self.request(f"{self.path}/messages", {"author": "用户", "text": "没点名的问题", "submission_id": uuid.uuid4().hex}, self.owner)[1]["message"]["id"]
        gemini_id = self.member_id("Gemini")
        self.assertEqual(self.request(f"{self.path}/recommendations", {"message_id": route, "member_id": gemini_id, "provider": "jev",
                                                                         "confidence": 0.8}, self.owner)[0], 200)
        self.assertEqual(self.request(f"{self.path}/recommendations/{route}", {"action": "adopt", "mode": "interrupt"}, self.owner)[0], 200)
        observers = self.request(f"{self.path}/inbox", token=self.owner)[1]["observers"]
        self.assertEqual([item["message_id"] for item in observers[0]["pending"]], [route])

    def test_registered_manual_member_can_be_adopted_in_a_free_room(self):
        """Once registered and its CLI reported a session, the owner's service takes the member over like a woken one."""
        gemini = uuid.uuid4().hex
        self.request(f"{self.path}/members", {"name": "Gemini", "token": gemini, "access": "manual"}, self.owner)
        gemini_id = self.member_id("Gemini")
        renewed = uuid.uuid4().hex + uuid.uuid4().hex
        adopt = {"action": "adopt", "adapter": "antigravity_cli", "session_id": "session-1", "token": renewed}
        self.assertEqual(self.request(f"{self.path}/members/{gemini_id}", adopt, self.owner)[0], 400)
        self.assertEqual(self.request(f"{self.path}/register", {}, gemini)[0], 200)
        self.assertEqual(self.request(f"{self.path}/members/{gemini_id}", adopt, self.owner)[0], 400, "no session reported yet")
        # The CLI reports its session in headers on any call; reading the room is enough.
        urlopen(Request(self.base + self.path, headers={"X-Discussion-Token": gemini, "X-Discussion-Session": adopt["session_id"],
                                                         "X-Discussion-Session-Client": "antigravity"}), timeout=10).close()
        self.assertEqual(self.request(f"{self.path}/members/{gemini_id}", {**adopt, "token": self.member}, self.owner)[0], 400, "a credential already in use")
        status, adopted = self.request(f"{self.path}/members/{gemini_id}", adopt, self.owner)
        self.assertEqual(status, 200, adopted)
        member = next(item for item in adopted["members"] if item["name"] == "Gemini")
        self.assertEqual((member["access"], member["session_mode"]), ("runner", "borrowed"))
        # The service now answers with the credential it generated; the browser-made one no longer works.
        self.assertEqual(self.request(f"{self.path}/register", {}, gemini)[0], 403)
        inbox = self.request(f"{self.path}/inbox", token=self.owner)[1]
        self.assertIn("Gemini", [item["name"] for item in inbox["members"]])

    def test_manual_member_answers_by_request_and_is_never_delivered(self):
        """A manual member is skipped by the runner and closes only its own open requests."""
        gemini = uuid.uuid4().hex
        self.request(f"{self.path}/members", {"name": "Gemini", "token": gemini, "access": "manual"}, self.owner)
        self.assertEqual(self.say("先别点 Gemini", to=["Gemini"])[0], 400, "an unregistered manual member does not exist yet")
        self.assertEqual(self.request(f"{self.path}/inbox", token=self.owner)[1]["observers"], [])
        self.assertEqual(self.request(f"{self.path}/register", {}, gemini)[0], 200)
        self.say("请 Gemini 看看", to=["Gemini", "Claude"])
        inbox = self.request(f"{self.path}/inbox", token=self.owner)[1]
        self.assertEqual([member["name"] for member in inbox["members"]], ["Claude", "Codex"])
        self.assertEqual([member["name"] for member in inbox["observers"]], ["Gemini"])
        self.assertEqual(self.reserve_for("Gemini")[0], 404)
        requests = {item["member"]: item["id"] for item in self.request(self.path)[1]["free"]["requests"]}

        def post(**extra):
            return self.request(f"{self.path}/messages", {"author": "Gemini", "text": "我的看法", "source": "cli",
                                                          "submission_id": uuid.uuid4().hex, **extra}, gemini)
        self.assertEqual(post(request_ids=[requests["Claude"]])[0], 409)
        self.assertEqual(post(execution_id=1)[0], 400)
        self.assertEqual(post(request_ids=[requests["Gemini"]])[0], 201)
        self.assertEqual(post()[0], 201)
        states = {item["member"]: item["status"] for item in self.request(self.path)[1]["free"]["requests"]}
        self.assertEqual(states, {"Gemini": "completed", "Claude": "pending"})

    def test_overlapping_changes_to_the_same_file_are_reported_as_possible_conflicts(self):
        """Two members changing one file in overlapping windows are flagged; the report is recorded once."""
        self.say("改首页", to=["Claude", "Codex"])
        claude, codex = self.reserve_for("Claude")[1], self.reserve_for("Codex")[1]

        def report(execution, files):
            return self.request(f"{self.path}/executions/{execution['id']}", {"action": "report", "changes": files}, self.owner)
        self.assertEqual(report(claude, ["index.html", "a.css"])[0], 200)
        self.assertEqual(report(claude, ["b.css"])[0], 409)
        self.assertEqual(report(codex, "x")[0], 400)
        self.assertEqual(report(codex, ["index.html"])[0], 200)
        conflicts = self.request(self.path)[1]["free"]["conflicts"]
        self.assertEqual(conflicts, [{"members": ["Claude", "Codex"], "executions": [claude["id"], codex["id"]], "files": ["index.html"]}])


class HostTests(FreeRoomTests):
    """An AI host routes unnamed messages, dispatches members, and is woken once per finished batch."""

    expected_host = "Claude"
    member_id = MultiMemberTests.member_id
    reserve_for = MultiMemberTests.reserve_for
    def say(self, text, token=None, **extra):
        """Name Claude unless told otherwise, as in the multi-member cases."""
        return FreeRoomTests.say(self, text, token, **({"to": ["Claude"]} | extra))

    def setUp(self):
        """Claude hosts; Codex and a third runner member, Gemini, work."""
        super().setUp()
        self.codex, self.gemini = uuid.uuid4().hex, uuid.uuid4().hex
        self.request(f"{self.path}/members", {"name": "Codex", "token": self.codex}, self.owner)
        self.request(f"{self.path}/members", {"name": "Gemini", "token": self.gemini}, self.owner)
        status, view = self.request(f"{self.path}/members/{self.member_id('Claude')}", {"action": "role", "role": "host"}, self.owner)
        self.assertEqual(status, 200, view)
        self.tokens = {"Claude": self.member, "Codex": self.codex, "Gemini": self.gemini}

    def requests(self):
        """Current requests as (member, purpose, status) triples."""
        return [(item["member"], item["purpose"], item["status"]) for item in self.request(self.path)[1]["free"]["requests"]]

    def work(self, name, **extra):
        """Reserve a member's requests and answer them, optionally naming members as the host."""
        execution = self.reserve_for(name)[1]
        status, saved = self.request(f"{self.path}/messages", {"author": name, "text": f"{name} 完成", "source": "cli",
                                                               "submission_id": uuid.uuid4().hex, "execution_id": execution["id"], **extra}, self.tokens[name])
        self.assertEqual(status, 201, saved)
        return execution

    def test_unnamed_message_with_several_members_is_only_a_note(self):
        """With a host, an unnamed message is routed to the host instead of staying a note."""
        FreeRoomTests.say(self, "没有点名")
        self.assertEqual(self.requests(), [("Claude", "route", "pending")])

    def test_host_dispatch_hands_back_once_after_every_member_finished(self):
        """Two dispatched members produce exactly one hand-off, after the last of them finishes."""
        FreeRoomTests.say(self, "请安排")
        self.work("Claude", to=["Codex", "Gemini"])
        self.assertEqual(self.requests()[1:], [("Codex", "ask", "pending"), ("Gemini", "ask", "pending")])
        self.work("Codex")
        self.assertNotIn(("Claude", "handoff", "pending"), self.requests())
        self.work("Gemini")
        self.assertEqual(self.requests().count(("Claude", "handoff", "pending")), 1)

    def test_sequential_mention_asks_the_host_first_and_each_next_member_after_the_previous_ends(self):
        """@全体依次 asks one member at a time: the host, then by joining order; a failed or departed member is passed over."""
        FreeRoomTests.say(self, "依次说说", to=["Gemini", "Codex", "Claude"], sequential=True)
        self.assertEqual(self.requests(), [("Claude", "ask", "pending")])
        self.work("Claude")
        self.assertEqual(self.requests()[1:], [("Codex", "ask", "pending")])
        failing = self.reserve_for("Codex")[1]
        self.request(f"{self.path}/executions/{failing['id']}", {"action": "fail", "reason": "CLI 退出"}, self.owner)
        self.assertEqual(self.requests()[1:], [("Codex", "ask", "failed"), ("Gemini", "ask", "pending")])
        self.work("Gemini")
        FreeRoomTests.say(self, "再来一次", to=["Gemini", "Codex"], sequential=True)
        self.assertEqual(self.requests()[3:], [("Codex", "ask", "pending")])
        self.request(f"{self.path}/members/{self.member_id('Codex')}", {"action": "away"}, self.owner)
        self.assertEqual(self.requests()[3:], [("Codex", "ask", "cancelled"), ("Gemini", "ask", "pending")])
        order = self.request(self.path)[1]["speaking_order"]
        self.assertEqual((order["kind"], [(item["name"], item["state"]) for item in order["items"]]),
                         ("queue", [("Gemini", "speaking"), ("Claude", "idle")]))

    def test_owner_reorders_who_has_not_spoken_against_the_latest_revision(self):
        """Read the order, then send its revision: spoken and speaking members stay, the rest follow the new order at once."""
        FreeRoomTests.say(self, "依次说说", to=["Claude", "Codex", "Gemini"], sequential=True)
        order = self.request(f"{self.path}/speaking-order")[1]
        self.assertEqual(([(item["name"], item["state"]) for item in order["items"]], order["movable"]),
                         ([("Claude", "speaking"), ("Codex", "queued"), ("Gemini", "queued")], ["Codex", "Gemini"]))
        url = f"{self.path}/speaking-order"
        self.assertEqual(self.request(url, {"order": ["Gemini", "Codex"]}, self.owner)[0], 400)
        self.assertEqual(self.request(url, {"revision": order["revision"], "order": ["Gemini", "Codex"]}, self.member)[0], 403)
        status, refused = self.request(url, {"revision": order["revision"], "order": ["Gemini", "Claude"]}, self.owner)
        self.assertEqual(status, 400)
        self.assertIn("缺少：Codex", refused["error"])
        self.assertIn("多出：Claude", refused["error"])
        self.assertEqual(self.request(url, {"revision": "stale", "order": ["Gemini", "Codex"]}, self.owner)[0], 409)
        status, room = self.request(url, {"revision": order["revision"], "order": ["Gemini", "Codex"]}, self.owner)
        self.assertEqual(status, 200, room)
        self.assertEqual([item["name"] for item in room["speaking_order"]["items"]], ["Claude", "Gemini", "Codex"])
        self.work("Claude")
        self.assertEqual(self.requests()[1:], [("Gemini", "ask", "pending")])

    def test_idle_reorder_sets_the_default_order_for_later_queues(self):
        """With nothing queued, dragging sets the room's default order, which the next one-after-another message follows."""
        order = self.request(self.path)[1]["speaking_order"]
        self.assertEqual((order["kind"], order["movable"]), ("default", ["Claude", "Codex", "Gemini"]))
        status, room = self.request(f"{self.path}/speaking-order", {"revision": order["revision"], "order": ["Gemini", "Claude", "Codex"]}, self.owner)
        self.assertEqual(status, 200, room)
        self.assertEqual(room["speaking_order"]["movable"], ["Gemini", "Claude", "Codex"])
        FreeRoomTests.say(self, "依次说说", to=["Claude", "Codex", "Gemini"], sequential=True)
        self.assertEqual(self.requests(), [("Gemini", "ask", "pending")])

    def test_partial_failure_still_hands_back_but_all_failed_halts(self):
        """One completed member is enough to hand back; a batch where all fail halts the chain."""
        FreeRoomTests.say(self, "第一链")
        self.work("Claude", to=["Codex", "Gemini"])
        failing = self.reserve_for("Gemini")[1]
        self.request(f"{self.path}/executions/{failing['id']}", {"action": "fail", "reason": "CLI 退出"}, self.owner)
        self.work("Codex")
        self.assertEqual(self.requests().count(("Claude", "handoff", "pending")), 1)
        self.work("Claude", to=["Codex"])
        failing = self.reserve_for("Codex")[1]
        self.request(f"{self.path}/executions/{failing['id']}", {"action": "fail", "reason": "再次失败"}, self.owner)
        free = self.request(self.path)[1]["free"]
        self.assertEqual([item["reason"] for item in free["halted_chains"]], ["all_failed"])
        self.assertEqual(self.requests().count(("Claude", "handoff", "pending")), 0)

    def test_round_limit_holds_the_next_dispatch_until_the_owner_continues(self):
        """A round is a host dispatch: its hand-back always comes, the next dispatch past the limit is held, and continuing sends it."""
        from backend import free_room
        original = free_room.CHAIN_ROUNDS
        free_room.CHAIN_ROUNDS = 1
        try:
            FreeRoomTests.say(self, "轮数")
            self.work("Claude", to=["Codex", "Gemini"])
            self.work("Codex")
            self.work("Gemini")
            self.assertEqual(self.requests()[-1], ("Claude", "handoff", "pending"), "the last round still gets its summary")
            self.work("Claude", to=["Gemini"])
            free = self.request(self.path)[1]["free"]
            self.assertEqual([item["reason"] for item in free["halted_chains"]], ["budget"])
            self.assertEqual(self.requests()[-1], ("Claude", "handoff", "completed"), "the dispatch past the limit is held")
            chain = free["halted_chains"][0]["chain_id"]
            self.assertEqual(free["chain_rounds"][0], {"chain_id": chain, "used": 1, "allowed": 1})
            url = f"{self.path}/chains/{chain}"
            self.assertEqual(self.request(url, {"action": "continue", "rounds": 1}, self.tokens["Codex"])[0], 403)
            for bad in (0, 21, "1"):
                self.assertEqual(self.request(url, {"action": "continue", "rounds": bad}, self.owner)[0], 400, bad)
            status, view = self.request(url, {"action": "continue", "rounds": 1}, self.owner)
            self.assertEqual(status, 200, view)
            self.assertEqual(self.requests()[-1], ("Gemini", "ask", "pending"), "continuing sends the held dispatch")
            self.assertEqual((view["halted_chains"], view["chain_rounds"][0]["allowed"]), ([], 2))
            self.assertEqual(self.request(url, {"action": "continue", "rounds": 1}, self.owner)[0], 409, "a running chain needs no continuing")
            FreeRoomTests.say(self, "新的一链", to=["Claude"])
            self.work("Claude", to=["Codex"])
            self.assertEqual(self.requests()[-1], ("Codex", "ask", "pending"), "a new owner message starts with a fresh limit")
        finally:
            free_room.CHAIN_ROUNDS = original

    def test_single_member_dispatch_hands_back_only_when_the_host_asks(self):
        """One member's answer goes straight to the user unless the host dispatched it with handoff, e.g. to pass it to a reviewer."""
        FreeRoomTests.say(self, "单人派活")
        self.work("Claude", to=["Codex"])
        self.work("Codex")
        self.assertEqual(self.requests().count(("Claude", "handoff", "pending")), 0)
        FreeRoomTests.say(self, "做完交回我", to=["Claude"])
        self.work("Claude", to=["Codex"], handoff=True)
        self.work("Codex")
        self.assertEqual(self.requests().count(("Claude", "handoff", "pending")), 1)

    def test_handoff_needs_a_host_dispatch(self):
        """handoff is true only beside the host's to; a member or a host naming no one is refused."""
        FreeRoomTests.say(self, "检查")
        host = self.reserve_for("Claude")[1]
        base = {"author": "Claude", "text": "x", "source": "cli", "execution_id": host["id"]}
        for extra in ({"handoff": True}, {"to": ["Codex"], "handoff": "yes"}):
            status, refused = self.request(f"{self.path}/messages", {**base, **extra, "submission_id": uuid.uuid4().hex}, self.tokens["Claude"])
            self.assertEqual(status, 400, refused)
            self.assertIn("handoff", refused["error"])

    def test_owner_sets_the_room_round_limit(self):
        """Only the owner changes the limit, within its range; running chains follow the new value."""
        url = f"{self.path}/budget"
        self.assertEqual(self.request(self.path)[1]["free"]["max_rounds"], 3)
        self.assertEqual(self.request(url, {"max_rounds": 2}, self.member)[0], 403)
        for bad in (0, 21, "3", 2.5):
            self.assertEqual(self.request(url, {"max_rounds": bad}, self.owner)[0], 400)
        FreeRoomTests.say(self, "轮数")
        self.work("Claude", to=["Codex", "Gemini"])
        status, saved = self.request(url, {"max_rounds": 1}, self.owner)
        self.assertEqual((status, saved), (200, {"max_rounds": 1}))
        self.work("Codex")
        self.work("Gemini")
        self.work("Claude", to=["Codex"])
        free = self.request(self.path)[1]["free"]
        self.assertEqual((free["max_rounds"], [item["reason"] for item in free["halted_chains"]]), (1, ["budget"]))

    def test_smart_scheduling_asks_everyone_or_no_one(self):
        """Everyone answers once without a hand-off and the host may not dispatch; no one cancels the host's request."""
        everyone = FreeRoomTests.say(self, "都出来打个招呼")[1]["message"]["id"]
        status, result = self.request(f"{self.path}/recommendations/{everyone}", {"action": "all"}, self.owner)
        self.assertEqual(status, 200, result)
        self.assertEqual(self.requests(), [("Claude", "all", "pending"), ("Codex", "all", "pending"), ("Gemini", "all", "pending")])
        host = self.reserve_for("Claude")[1]
        payload = {"author": "Claude", "text": "派活", "source": "cli", "submission_id": uuid.uuid4().hex, "execution_id": host["id"], "to": ["Codex"]}
        self.assertEqual(self.request(f"{self.path}/messages", payload, self.member)[0], 400)
        del payload["to"]
        self.assertEqual(self.request(f"{self.path}/messages", {**payload, "submission_id": uuid.uuid4().hex}, self.member)[0], 201)
        self.work("Codex")
        self.work("Gemini")
        self.assertNotIn("handoff", [purpose for _, purpose, _ in self.requests()])
        thanks = FreeRoomTests.say(self, "好的，谢谢")[1]["message"]["id"]
        self.assertEqual(self.request(f"{self.path}/recommendations/{thanks}", {"action": "none"}, self.owner)[0], 200)
        self.assertEqual(self.requests()[-1], ("Claude", "route", "cancelled"))
        started = FreeRoomTests.say(self, "已经开始处理的消息")[1]["message"]["id"]
        self.reserve_for("Claude")
        self.assertEqual(self.request(f"{self.path}/recommendations/{started}", {"action": "all"}, self.owner)[0], 409)

    def test_naming_everyone_waits_for_the_runner_to_choose_at_once_or_in_turn(self):
        """@全体成员 leaves the host an undeliverable group request; all asks everyone at once, sequential queues them."""
        everyone = ["Claude", "Codex", "Gemini"]
        first = FreeRoomTests.say(self, "大家打个招呼", to=everyone, order="auto")[1]["message"]["id"]
        self.assertEqual(self.requests(), [("Claude", "group", "pending")])
        self.assertEqual(self.reserve_for("Claude")[0], 409)
        self.assertEqual(self.request(f"{self.path}/recommendations/{first}", {"action": "none"}, self.owner)[0], 400)
        revision = self.request(f"{self.path}/recommendations/{first}", token=self.owner)[1]["revision"]
        self.assertEqual(self.request(f"{self.path}/recommendations/{first}", {"action": "all", "revision": revision}, self.owner)[0], 200)
        self.assertEqual(self.requests(), [("Claude", "all", "pending"), ("Codex", "all", "pending"), ("Gemini", "all", "pending")])
        self.assertEqual(self.request(f"{self.path}/recommendations/{first}", {"action": "sequential"}, self.owner)[0], 409)
        for name in everyone:
            self.work(name)
        second = FreeRoomTests.say(self, "接龙，每人接上一句", to=everyone, order="auto")[1]["message"]["id"]
        revision = self.request(f"{self.path}/recommendations/{second}", token=self.owner)[1]["revision"]
        self.assertEqual(self.request(f"{self.path}/recommendations/{second}", {"action": "sequential", "revision": revision}, self.owner)[0], 200)
        self.assertEqual(self.requests()[3:], [("Claude", "ask", "pending")])
        self.work("Claude")
        self.assertEqual(self.requests()[4:], [("Codex", "ask", "pending")])
        self.assertEqual(self.request(f"{self.path}/recommendations/{second}", {"action": "all"}, self.owner)[0], 409)

    def test_only_the_host_dispatches_and_never_itself(self):
        """Members suggest without dispatching; the host cannot name itself."""
        FreeRoomTests.say(self, "派活检查", to=["Codex", "Claude"])
        codex = self.reserve_for("Codex")[1]
        payload = {"author": "Codex", "text": "越权", "source": "cli", "submission_id": uuid.uuid4().hex, "execution_id": codex["id"], "to": ["Gemini"]}
        self.assertEqual(self.request(f"{self.path}/messages", payload, self.codex)[0], 201)
        self.assertFalse(any(item["member"] == "Gemini" for item in self.request(self.path)[1]["free"]["requests"]))
        host = self.reserve_for("Claude")[1]
        payload = {"author": "Claude", "text": "点名自己", "source": "cli", "submission_id": uuid.uuid4().hex, "execution_id": host["id"], "to": ["Claude"]}
        self.assertEqual(self.request(f"{self.path}/messages", payload, self.member)[0], 400)

    def test_one_host_at_a_time(self):
        """Making Codex host demotes Claude; the host cannot step down, and when it leaves another member takes over."""
        self.request(f"{self.path}/members/{self.member_id('Codex')}", {"action": "role", "role": "host"}, self.owner)
        roles = {member["name"]: member["role"] for member in self.request(self.path)[1]["free"]["members"]}
        self.assertEqual(roles, {"Claude": "member", "Codex": "host", "Gemini": "member"})
        self.assertEqual(self.request(self.path)[1]["host"], "Codex")
        self.assertEqual(self.request(f"{self.path}/members/{self.member_id('Codex')}", {"action": "role", "role": "member"}, self.owner)[0], 400)
        self.request(f"{self.path}/members/{self.member_id('Codex')}", {"action": "away"}, self.owner)
        self.assertEqual(self.request(self.path)[1]["host"], "Claude")
        self.request(f"{self.path}/members/{self.member_id('Codex')}", {"action": "active", "token": uuid.uuid4().hex}, self.owner)
        roles = {member["name"]: member["role"] for member in self.request(self.path)[1]["free"]["members"]}
        self.assertEqual(roles, {"Claude": "host", "Codex": "member", "Gemini": "member"})

    def test_a_room_left_without_a_host_gets_one_on_the_next_message(self):
        """Rooms the user used to host route the next unnamed message through a newly assigned AI host."""
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute("UPDATE room_members SET role='member'")
        self.assertEqual(FreeRoomTests.say(self, "没有点名")[0], 201)
        self.assertEqual(self.request(self.path)[1]["host"], "Claude")
        self.assertEqual(self.requests(), [("Claude", "route", "pending")])


class OnlineAndLinkTests(FreeRoomTests):
    """Online members are forwarded by the owner; brainstorm rooms remember the free room they came from."""

    def test_web_member_is_read_only_and_the_owner_forwards_its_answer(self):
        """Legacy online input becomes a web-sourced manual member; only the owner can forward its answer."""
        deepseek = uuid.uuid4().hex
        self.request(f"{self.path}/members", {"name": "DeepSeek", "token": deepseek, "access": "online"}, self.owner)
        member = next(item for item in self.request(self.path)[1]["free"]["members"] if item["name"] == "DeepSeek")
        self.assertEqual((member["access"], member["manual_source"]), ("manual", "web"))
        self.assertEqual(self.request(f"{self.path}/members/{member['id']}", {"action": "role", "role": "host"}, self.owner)[0], 400)
        self.say("请 DeepSeek 看看", to=["DeepSeek"])
        request_id = self.request(self.path)[1]["free"]["requests"][0]["id"]
        self.assertEqual(self.reserve()[0], 409)
        own = {"author": "DeepSeek", "text": "自己发", "source": "cli", "submission_id": uuid.uuid4().hex}
        self.assertEqual(self.request(f"{self.path}/messages", own, deepseek)[0], 403)
        self.assertEqual(self.request(f"{self.path}/members/{member['id']}", {"action": "adopt", "adapter": "claude", "session_id": "web-session"}, deepseek)[0], 403)
        forward = {"author": "DeepSeek", "text": "在线回答原文", "submission_id": uuid.uuid4().hex, "request_ids": [request_id]}
        self.assertEqual(self.request(f"{self.path}/messages", {**forward, "author": "Qwen"}, self.owner)[0], 403)
        status, saved = self.request(f"{self.path}/messages", forward, self.owner)
        self.assertEqual(status, 201, saved)
        self.assertEqual((saved["message"]["author"], saved["message"]["submitted_by"], saved["message"]["source"]), ("DeepSeek", "用户", "proxy"))
        self.assertEqual(self.request(self.path)[1]["free"]["requests"][0]["status"], "completed")

    def test_web_proxy_completes_pending_asks_and_all_requests_with_summary(self):
        """One relayed answer covers all ordinary asks, including a smart-scheduled all request, with its summary."""
        deepseek = uuid.uuid4().hex
        self.request(f"{self.path}/members", {"name": "DeepSeek", "token": deepseek, "access": "online"}, self.owner)
        self.request(f"{self.path}/members", {"name": "Codex", "token": uuid.uuid4().hex}, self.owner)

        ask_message = self.say("请 DeepSeek 单独回答", to=["DeepSeek"])[1]["message"]["id"]
        all_message = self.say("请 DeepSeek 和 Codex 一起回答", to=["DeepSeek", "Codex"], order="auto")[1]["message"]["id"]
        group_plan = self.request(f"{self.path}/recommendations/{all_message}", token=self.owner)[1]
        status, routed = self.request(f"{self.path}/recommendations/{all_message}",
                                      {"action": "all", "revision": group_plan["revision"]}, self.owner)
        self.assertEqual(status, 200, routed)

        requests = self.request(self.path)[1]["free"]["requests"]
        pending = [item for item in requests if item["member"] == "DeepSeek" and item["status"] == "pending"]
        self.assertEqual({(item["message_id"], item["purpose"]) for item in pending},
                         {(ask_message, "ask"), (all_message, "all")})
        ids = [item["id"] for item in pending]
        payload = {"author": "DeepSeek", "text": "在线回答原文", "submission_id": uuid.uuid4().hex,
                   "request_ids": ids, "summary": "结论与关键依据", "summary_by": "DeepSeek"}
        status, saved = self.request(f"{self.path}/messages", payload, self.owner)
        self.assertEqual(status, 201, saved)
        self.assertEqual((saved["message"]["author"], saved["message"]["submitted_by"], saved["message"]["source"]),
                         ("DeepSeek", "用户", "proxy"))
        self.assertEqual((saved["message"]["summary"], saved["message"]["summary_by"]), ("结论与关键依据", "DeepSeek"))
        completed = [item for item in self.request(self.path)[1]["free"]["requests"] if item["id"] in ids]
        self.assertEqual({(item["status"], item["answer_id"]) for item in completed},
                         {("completed", saved["message"]["id"])})

    def test_web_member_can_be_scheduled_without_local_registration(self):
        """A web-source expert joins the discussion roster without registering a local session."""
        self.request(f"{self.path}/members", {"name": "DeepSeek", "token": uuid.uuid4().hex, "access": "online"}, self.owner)
        discussion = f"{self.path}/discussion"
        current = self.request(discussion)[1]
        self.assertEqual(self.request(discussion, {"action": "start", "revision": current["revision"]}, self.owner)[0], 200)
        roster = self.request(f"{self.path}/turns/roster", token=self.member)[1]
        self.assertIn("DeepSeek", roster["waiting"])
        self.assertNotIn("DeepSeek", roster["unregistered"])
        status, plan = self.request(f"{self.path}/turns", {"actor": "Claude", "turns": [{"expert": "DeepSeek", "question": "请给出独立意见"}],
            "roster": roster["revision"], "submission_id": uuid.uuid4().hex}, self.member)
        self.assertEqual(status, 201, plan)
        self.assertEqual(plan["turn"]["status"], "open")

        ask_status, ask_post = self.say("请 DeepSeek 直接回答", to=["DeepSeek"])
        self.assertEqual(ask_status, 201, ask_post)
        current = self.request(self.path)[1]["free"]["requests"]
        discuss_request = next(item for item in current if item["member"] == "DeepSeek" and item["purpose"] == "discuss")
        ask_request = next((item for item in current if item["member"] == "DeepSeek" and item["purpose"] == "ask"), None)
        self.assertIsNotNone(ask_request, current)
        message_count = self.request(f"{self.path}/messages?after=0")[1]["total"]
        mixed = {"author": "DeepSeek", "text": "错误合并", "submission_id": uuid.uuid4().hex,
                 "request_ids": [discuss_request["id"], ask_request["id"]]}
        self.assertEqual(self.request(f"{self.path}/messages", mixed, self.owner)[0], 400)
        unchanged = self.request(self.path)[1]["free"]["requests"]
        self.assertEqual({item["id"]: item["status"] for item in unchanged if item["id"] in mixed["request_ids"]},
                         {discuss_request["id"]: "pending", ask_request["id"]: "pending"})
        self.assertEqual(self.request(f"{self.path}/messages?after=0")[1]["total"], message_count)

        forward = {"author": "DeepSeek", "text": "讨论安排回答", "submission_id": uuid.uuid4().hex,
                   "request_ids": [discuss_request["id"]], "summary": "仅完成这一条安排", "summary_by": "用户"}
        status, saved = self.request(f"{self.path}/messages", forward, self.owner)
        self.assertEqual(status, 201, saved)
        self.assertEqual((saved["message"]["summary"], saved["message"]["summary_by"]), ("仅完成这一条安排", "用户"))
        completed = {item["id"]: item["status"] for item in self.request(self.path)[1]["free"]["requests"]
                     if item["id"] in mixed["request_ids"]}
        self.assertEqual(completed, {discuss_request["id"]: "completed", ask_request["id"]: "pending"})
        self.assertEqual(self.request(f"{self.path}/turns/{plan['turn']['id']}")[1]["status"], "answered")

    def test_room_creation_rejects_linked_brainstorm_children(self):
        """A discussion stays in its room; creating a linked child room is no longer supported."""
        with closing(sqlite3.connect(self.database)) as connection:
            room_count = connection.execute("SELECT COUNT(*) FROM rooms").fetchone()[0]
        status, result = self.request("/api/rooms", {"title": "方案头脑风暴", "goal": "x",
            "experts": {}, "parent_room_id": self.room["id"]}, uuid.uuid4().hex)
        self.assertEqual(status, 400, result)
        with closing(sqlite3.connect(self.database)) as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM rooms").fetchone()[0], room_count)
        self.assertEqual(self.request(self.path)[1]["linked_rooms"], [])


class InstanceTests(FreeRoomTests):
    """Two instances of one platform are separate members with their own credentials and requests."""

    def test_two_claude_instances_are_distinct_members(self):
        """Claude and Claude-评审 receive separate requests and answer only with their own credential."""
        reviewer = uuid.uuid4().hex
        self.assertEqual(self.request(f"{self.path}/members", {"name": "Claude-评审", "adapter": "claude", "token": reviewer}, self.owner)[0], 200)
        for name in ("Claudex", "Claude-", "Foo-1", "Claude-a b"):
            self.assertEqual(self.request(f"{self.path}/members", {"name": name, "token": uuid.uuid4().hex}, self.owner)[0], 400, name)
        self.say("请评审", to=["Claude-评审"])
        requests = self.request(self.path)[1]["free"]["requests"]
        self.assertEqual([item["member"] for item in requests], ["Claude-评审"])
        member_id = next(member["id"] for member in self.request(self.path)[1]["free"]["members"] if member["name"] == "Claude-评审")
        execution = self.request(f"{self.path}/executions", {"member_id": member_id, "client_id": uuid.uuid4().hex}, self.owner)[1]
        self.assertEqual(self.answer(execution["id"], token=reviewer)[0], 403)
        payload = {"author": "Claude-评审", "text": "评审意见", "source": "cli", "submission_id": uuid.uuid4().hex, "execution_id": execution["id"]}
        self.assertEqual(self.request(f"{self.path}/messages", payload, self.member)[0], 403)
        status, saved = self.request(f"{self.path}/messages", payload, reviewer)
        self.assertEqual((status, saved["message"]["author"]), (201, "Claude-评审"))

    def test_discussion_rooms_accept_instances_as_experts_and_host(self):
        """A brainstorm room may hold two Claude instances, one of them hosting."""
        status, room = self.request("/api/rooms", {"title": "双 Claude", "goal": "x", "host": "Claude-主持",
            "experts": {"Claude-主持": "cli", "Claude": "cli", "Codex": "online"},
            "members": [{"name": name, "token": uuid.uuid4().hex, "access": "online" if name == "Codex" else "manual"}
                        for name in ("Claude-主持", "Claude", "Codex")]}, uuid.uuid4().hex)
        self.assertEqual(status, 201, room)
        self.assertEqual(room["host"], "Claude-主持")
        web_member = next(item for item in room["members"] if item["name"] == "Codex")
        self.assertEqual((web_member["access"], web_member["manual_source"]), ("manual", "web"))
        self.assertEqual(self.request("/api/rooms", {"title": "无效", "goal": "x", "experts": {"Claudex": "cli"}})[0], 400)
        many = {f"Claude-{number}": "cli" for number in range(13)}
        self.assertEqual(self.request("/api/rooms", {"title": "过多", "goal": "x", "experts": many})[0], 400)


class MigrationTests(unittest.TestCase):
    """The retired floor trigger is dropped on existing databases, and legacy rooms stay brainstorm rooms."""

    def test_existing_floor_trigger_is_dropped_and_rerun_is_harmless(self):
        """An old trigger definition disappears; repeating initialization changes nothing."""
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "old.db"
            init_database(database, seed=True)
            with closing(sqlite3.connect(database)) as connection, connection:
                connection.execute("""CREATE TRIGGER require_message_floor BEFORE INSERT ON messages
                    WHEN NEW.author<>'用户' AND NOT EXISTS (SELECT 1 FROM room_floor WHERE room_id=NEW.room_id AND holder=NEW.author)
                    BEGIN SELECT RAISE(ABORT, 'floor_required'); END""")
            init_database(database)
            init_database(database)
            with closing(sqlite3.connect(database)) as connection, connection:
                self.assertIsNone(connection.execute("SELECT sql FROM sqlite_master WHERE name='require_message_floor'").fetchone())
                self.assertEqual(connection.execute("SELECT COUNT(*) FROM room_modes").fetchone()[0], 0)
                connection.execute("INSERT INTO messages (room_id,author,text,source,submission_id,created_at) VALUES ('welcome','Codex','x','cli','late-0001','now')")

    def test_early_free_tables_gain_later_columns(self):
        """A database created before the member columns existed is upgraded in place."""
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "early.db"
            with closing(sqlite3.connect(database)) as connection, connection:
                connection.execute("CREATE TABLE room_members (id INTEGER PRIMARY KEY, room_id TEXT, name TEXT, adapter TEXT, "
                                   "role TEXT, status TEXT, token_hash TEXT, read_until INTEGER, created_at TEXT)")
                connection.execute("CREATE TABLE member_executions (id INTEGER PRIMARY KEY, room_id TEXT, member_id INTEGER, "
                                   "client_id TEXT, status TEXT, session_id TEXT, lease_until INTEGER, created_at INTEGER, "
                                   "finished_at INTEGER, result TEXT)")
            init_database(database, seed=False)
            init_database(database, seed=False)
            with closing(sqlite3.connect(database)) as connection:
                members = {row[1] for row in connection.execute("PRAGMA table_info(room_members)")}
                executions = {row[1] for row in connection.execute("PRAGMA table_info(member_executions)")}
            self.assertTrue({"access", "session_mode"} <= members)
            self.assertTrue({"changes", "cwd"} <= executions)


if __name__ == "__main__":
    unittest.main()

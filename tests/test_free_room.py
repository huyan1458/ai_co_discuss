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

    def review_member_id(self):
        """Invite one test reviewer using the adapter with enforced filesystem permissions."""
        self.review_token = uuid.uuid4().hex
        status, view = self.request(f"{self.path}/members", {"name": "Codex-review", "adapter": "codex_cli",
                                                            "token": self.review_token}, self.owner)
        self.assertEqual(status, 200, view)
        return next(member["id"] for member in view["members"] if member["name"] == "Codex-review")

    def completed_review_batch(self):
        """Create a real implementation handoff for review endpoint integration tests."""
        reviewer = self.review_member_id()
        host_id = next(member["id"] for member in self.request(self.path)[1]["free"]["members"] if member["name"] == "Claude")
        self.request(f"{self.path}/members/{host_id}", {"action": "role", "role": "host"}, self.owner)
        path = f"{self.path}/members/{reviewer}/review-capability"
        state = self.request(path, token=self.owner)[1]
        self.request(path, {"revision": state["revision"], "read_only": True, "config_version": "a" * 64}, self.owner)
        implementer_token = uuid.uuid4().hex
        status, members = self.request(f"{self.path}/members", {"name": "Codex-impl", "adapter": "codex_cli", "token": implementer_token}, self.owner)
        implementer = next(item["id"] for item in members["members"] if item["name"] == "Codex-impl")
        self.say("实现", to=["Claude"])
        execution = self.reserve()[1]
        roster = self.request(f"{self.path}/reviews/roster", token=self.member)[1]
        status, result = self.answer(execution["id"], to=["Codex-impl"], next_review="Codex-review", review_scope="验证实现",
                                    review_roster=roster["revision"])
        self.assertEqual(status, 201, result)
        work = self.request(f"{self.path}/executions", {"member_id": implementer, "client_id": uuid.uuid4().hex}, self.owner)[1]
        self.assertEqual(self.answer(work["id"], token=implementer_token, author="Codex-impl", text="已完成实现与验证")[0], 201)
        return result["message"]["id"], reviewer

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

    def messages(self, include=False):
        """Ids and texts of the room's messages as AI readers see them, or as the page sees them with withdrawn ones."""
        query = "?after=0" + ("&withdrawn=include" if include else "")
        return [(item["id"], item["text"], item["withdrawn"]) for item in self.request(f"{self.path}/messages{query}")[1]["messages"]]


class SingleMemberTests(FreeRoomTests):
    """Single-member rooms; subclasses of FreeRoomTests reuse its fixture without re-running these."""

    def test_work_started_through_the_remote_entry_is_marked_for_read_only_runs(self):
        """The remote entry has no device signature, so the runner must know which work came through it."""
        remote = DiscussionServer(("127.0.0.1", 0), self.database, hub=self.server)
        thread = threading.Thread(target=remote.serve_forever, daemon=True)
        thread.start()
        try:
            # A client cannot clear the mark on the remote entry, nor set it on this computer's own site.
            local = self.say("本机发起", remote_entry=True)
            self.assertEqual(local[0], 201, local)
            self.assertEqual([bool(item["remote_entry"]) for item in self.reserve()[1]["requests"]], [False])
            request = Request(f"http://127.0.0.1:{remote.server_port}{self.path}/messages", method="POST",
                              headers={"Content-Type": "application/json", "X-Discussion-Token": self.owner},
                              data=json.dumps({"author": "用户", "text": "外出发起", "submission_id": uuid.uuid4().hex, "remote_entry": False}).encode())
            with urlopen(request, timeout=10) as response:
                self.assertEqual(response.status, 201)
            with closing(sqlite3.connect(self.database)) as connection:
                connection.execute("UPDATE member_executions SET status='completed'")
                connection.execute("UPDATE member_requests SET status='completed' WHERE status='delivering'")
                connection.commit()
            self.assertEqual([bool(item["remote_entry"]) for item in self.reserve()[1]["requests"]], [True])
        finally:
            remote.shutdown()
            remote.server_close()
            thread.join()


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
        self.assertEqual(roster["members"][0]["name"], "Codex-review")
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

    def test_review_preauthorization_is_atomic_and_history_only_on_import(self):
        """Bind a distinct reviewer to a real dispatch; stale or replayed changes cannot alter it."""
        member_id = self.review_member_id()
        host_id = next(member["id"] for member in self.request(self.path)[1]["free"]["members"] if member["name"] == "Claude")
        self.request(f"{self.path}/members/{host_id}", {"action": "role", "role": "host"}, self.owner)
        path = f"{self.path}/members/{member_id}/review-capability"
        capability = self.request(path, token=self.owner)[1]
        self.request(path, {"revision": capability["revision"], "read_only": True, "config_version": "a" * 64}, self.owner)
        self.request(f"{self.path}/members", {"name": "Antigravity", "adapter": "gemini", "token": uuid.uuid4().hex}, self.owner)
        self.say("实现功能后交评审", to=["Claude"])
        execution = self.reserve()[1]
        roster = self.request(f"{self.path}/reviews/roster", token=self.member)[1]
        base = {"to": ["Antigravity"], "next_review": "Codex-review", "review_scope": "核对功能", "submission_id": "review-implementation-1"}
        self.assertEqual(self.answer(execution["id"], **base)[0], 400)
        self.assertEqual(self.answer(execution["id"], **base, review_roster="stale")[0], 409)
        status, refused = self.answer(execution["id"], **{**base, "to": ["Codex-review"]}, review_roster=roster["revision"])
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

    def test_event_log_records_request_lifecycle_for_the_owner_only(self):
        """Triggers log a message, its request and execution in order; members cannot read the log."""
        message = self.say("请改首页标题")[1]["message"]
        execution = self.reserve()[1]
        self.answer(execution["id"])
        self.assertEqual(self.request(f"{self.path}/events", token=self.member)[0], 403)
        log = self.request(f"{self.path}/events", token=self.owner)[1]
        kinds = [event["kind"] for event in log["events"]]
        created = next(event for event in log["events"] if event["kind"] == "request.created")
        self.assertEqual(created["data"]["message_id"], message["id"])
        self.assertEqual(log["members"][str(created["data"]["member_id"])], "Claude")
        self.assertLess(kinds.index("message.posted"), kinds.index("request.created"))
        self.assertLess(kinds.index("request.created"), kinds.index("execution.created"))
        statuses = [event["data"]["status"] for event in log["events"] if event["kind"] == "request.changed"]
        self.assertEqual(statuses[-1], "completed")
        later = self.request(f"{self.path}/events?after={log['last_id']}", token=self.owner)[1]
        self.assertEqual(later["events"], [])

    def test_event_log_records_each_write_with_its_sender_even_when_rejected(self):
        """Writes are logged before their effects with who sent them; a rolled-back rejection stays; credentials never do."""
        self.say("请改首页标题")
        self.assertGreaterEqual(self.answer(999)[0], 400)  # an answer bound to no execution is rejected
        log = self.request(f"{self.path}/events", token=self.owner)[1]["events"]
        writes = [event for event in log if event["kind"].startswith("api.")]
        said = next(event for event in writes if event["data"]["path"] == "/messages" and event["data"]["actor"] == "owner")
        self.assertLess(log.index(said), next(index for index, event in enumerate(log) if event["kind"] == "message.posted"))
        self.assertIn("请改首页标题", said["data"]["payload"])
        rejected = [event for event in writes if event["kind"] == "api.rejected"]
        self.assertTrue(rejected and rejected[-1]["data"]["actor"] == "member:Claude" and rejected[-1]["data"]["error"])
        created = next(event for event in writes if event["data"]["path"] == "/")
        self.assertNotIn(self.member, created["data"]["payload"])
        self.assertNotIn(self.owner, json.dumps(log, ensure_ascii=False))

    def test_retried_reservation_returns_the_same_execution(self):
        """A lost reserve response is recovered with the same local client id."""
        self.say("任务")
        client_id = uuid.uuid4().hex
        first = self.reserve(client_id)[1]
        again = self.reserve(client_id)[1]
        self.assertEqual(first["id"], again["id"])

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

    def test_queued_messages_wait_for_idle_room_pause_on_stop_and_send_now(self):
        """Owner messages sent while a member works wait in order; the stop pauses them; send-now and resume post them once."""
        texts = lambda: [text for _, text, _ in self.messages()]
        self.assertEqual(self.say("一", queue=True)[0], 201)
        self.assertEqual(texts(), ["一"])
        execution = self.reserve()[1]
        status, second = self.say("二", queue=True)
        self.assertEqual((status, len(second["queue"]["items"])), (201, 1))
        third_id = self.say("三", queue=True)[1]["queued"]
        self.assertEqual(texts(), ["一"])
        self.assertEqual(self.answer(execution["id"], "答一")[0], 201)
        self.assertEqual(texts(), ["一", "答一", "二"])
        member_id = self.request(self.path)[1]["free"]["members"][0]["id"]
        self.reserve()
        queue = self.request(f"{self.path}/members/{member_id}/interrupt", {}, self.owner)[1]["queued_messages"]
        self.assertEqual((queue["paused"], [item["text"] for item in queue["items"]]), (True, ["三"]))
        self.assertEqual(texts(), ["一", "答一", "二"])
        self.assertEqual(self.request(f"{self.path}/queue", {"action": "reorder", "ids": [third_id, 0]}, self.owner)[0], 409)
        self.assertEqual(self.request(f"{self.path}/queue", {"action": "resume"}, self.owner)[0], 200)
        self.assertEqual(texts(), ["一", "答一", "二", "三"])
        self.reserve()
        fourth_id = self.say("四", queue=True)[1]["queued"]
        queue = self.request(f"{self.path}/queue", {"action": "send", "id": fourth_id}, self.owner)[1]
        self.assertEqual((queue["items"], texts()), ([], ["一", "答一", "二", "三", "四"]))

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

    def test_runner_endpoints_need_the_owner_credential(self):
        """Inbox, reservation and lifecycle actions refuse member and missing credentials."""
        self.say("一")
        for token in (None, self.member):
            self.assertEqual(self.request(f"{self.path}/inbox", token=token)[0], 403)
            self.assertEqual(self.request(f"{self.path}/executions", {"member_id": 1, "client_id": "client-0001"}, token)[0], 403)
        execution = self.reserve()[1]
        self.assertEqual(self.request(f"{self.path}/executions/{execution['id']}", token=self.member)[0], 200)
        self.assertEqual(self.request(f"{self.path}/executions/{execution['id']}", {"action": "renew"}, self.member)[0], 403)

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
        self.request(f"{self.path}/members", {"name": "Antigravity", "token": uuid.uuid4().hex, "access": "manual"}, self.owner)
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

    def test_session_plans_require_fresh_roster_and_cover_all_waiting_experts(self):
        """Single and multi-speaker plans require a current roster, and a whole round must cover its waiting members."""
        gemini_token = uuid.uuid4().hex
        self.request(f"{self.path}/members", {"name": "Antigravity", "token": gemini_token}, self.owner)
        self.request(f"{self.path}/members", {"name": "Claude-review", "token": uuid.uuid4().hex}, self.owner)
        self.start_session(named_followup=True)
        self.assertTrue(self.request(self.path)[1]["named_followup"])
        self.assertTrue(self.request(f"{self.path}/discussion")[1]["session"]["named_followup"])
        roster = self.session_roster()
        self.assertEqual(set(roster["waiting"]), {"Claude", "Antigravity", "Claude-review"})
        turns = self.request(f"{self.path}/turns")[1]
        self.assertEqual(turns["total"], 0, "host system tasks are not public discussion turns")
        with closing(sqlite3.connect(self.database)) as connection:
            host_task_id = connection.execute("SELECT id FROM session_requests WHERE purpose='discuss_host' ORDER BY id DESC LIMIT 1").fetchone()[0]
        self.assertEqual(self.request(f"{self.path}/turns/{host_task_id}")[0], 404)
        single = {"actor": "Codex", "expert": "Claude", "question": "单人安排", "submission_id": uuid.uuid4().hex}
        self.assertEqual(self.request(f"{self.path}/turns", single, self.codex)[0], 400)
        self.assertEqual(self.request(f"{self.path}/turns", {**single, "roster": "stale"}, self.codex)[0], 409)
        full_round = [{"expert": name, "question": f"请回答 {name}"} for name in ("Claude", "Antigravity", "Claude-review")]
        multi = {"actor": "Codex", "turns": full_round[:2], "submission_id": uuid.uuid4().hex}
        self.assertEqual(self.request(f"{self.path}/turns", multi, self.codex)[0], 400)
        self.assertEqual(self.request(f"{self.path}/turns", {**multi, "roster": "stale"}, self.codex)[0], 409)
        status, missing = self.arrange_session(full_round[:2], roster)
        self.assertEqual(status, 400, missing)
        self.assertIn("Claude-review", missing["error"])
        status, plan = self.arrange_session(full_round, roster)
        self.assertEqual(status, 201, plan)
        self.assertEqual((plan["turn"]["status"], plan["queued"][0]["status"]), ("open", "queued"))

    def test_session_relay_opens_one_request_and_does_not_merge_a_direct_question(self):
        """A direct ask and the next discussion request never share a live execution."""
        gemini_token = uuid.uuid4().hex
        self.request(f"{self.path}/members", {"name": "Antigravity", "token": gemini_token}, self.owner)
        self.start_session()
        status, plan = self.arrange_session([{"expert": "Claude", "question": "先发言"},
                                             {"expert": "Antigravity", "question": "再发言"}])
        self.assertEqual(status, 201, plan)
        inbox = self.request(f"{self.path}/inbox", token=self.owner)[1]
        pending = next(item for member in inbox["members"] if member["name"] == "Claude" for item in member["pending"]
                       if item["purpose"] == "discuss")
        self.assertEqual((pending["session_request_id"], pending["session_id"], pending["round"], pending["position"],
                          pending["source_question"], pending["cause_kind"]),
                         (plan["turn"]["id"], plan["turn"]["session_id"], plan["turn"]["round"], plan["turn"]["position"],
                          "先发言", "scheduled_speaker"))
        self.assertEqual(self.say("请 Antigravity 另答一个问题", to=["Antigravity"])[0], 201)
        ask_execution = self.reserve_for("Antigravity")[1]
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
                         [("Claude", "answered"), ("Antigravity", "open")])
        self.assertEqual(self.reserve_for("Antigravity")[0], 409, "the ask execution still owns Antigravity's session")
        ask_answer = {"author": "Antigravity", "text": "普通提问答复", "source": "cli", "execution_id": ask_execution["id"],
                      "submission_id": uuid.uuid4().hex}
        self.assertEqual(self.request(f"{self.path}/messages", ask_answer, gemini_token)[0], 201)
        asks = [item for item in self.request(self.path)[1]["free"]["requests"] if item["purpose"] == "ask"]
        self.assertEqual([(item["member"], item["status"]) for item in asks], [("Antigravity", "completed")])
        next_execution = self.reserve_for("Antigravity")[1]
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
        self.request(f"{self.path}/members", {"name": "Antigravity", "token": gemini_token}, self.owner)
        self.start_session()
        status, plan = self.arrange_session([
            {"expert": "Claude", "question": "先发言"},
            {"expert": "Antigravity", "question": "接着发言"},
        ])
        self.assertEqual(status, 201, plan)
        execution = self.reserve_for("Claude")[1]

        interrupted = self.request(f"{self.path}/members/{self.member_id('Claude')}/interrupt", {}, self.owner)

        self.assertEqual(interrupted[0], 200, interrupted[1])
        turns = [item for item in self.request(f"{self.path}/turns")[1]["turns"] if item["purpose"] == "discuss"]
        self.assertEqual([(item["expert"], item["status"]) for item in turns],
                         [("Claude", "cancelled"), ("Antigravity", "open")])
        self.assertEqual(self.request(f"{self.path}/executions/{execution['id']}", token=self.owner)[1]["status"], "cancelled")
        self.assertEqual(self.reserve_for("Antigravity")[0], 200)

    def test_failed_session_speaker_does_not_freeze_round_progress(self):
        """A failed speaker can be retried, after which the next complete plan advances to round two."""
        gemini_token = uuid.uuid4().hex
        self.request(f"{self.path}/members", {"name": "Antigravity", "token": gemini_token}, self.owner)
        self.start_session()
        status, plan = self.arrange_session([
            {"expert": "Claude", "question": "第一轮 Claude"},
            {"expert": "Antigravity", "question": "第一轮 Antigravity"},
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
        gemini = self.reserve_for("Antigravity")[1]
        self.assertEqual(self.answer(gemini["id"], token=gemini_token, author="Antigravity")[0], 201)
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
            {"expert": "Antigravity", "question": "第二轮 Antigravity"},
        ], roster)
        self.assertEqual(status, 201, second_round)
        self.assertEqual([second_round["turn"]["round"], second_round["queued"][0]["round"]], [2, 2])

    def test_initial_session_execution_reads_no_messages_when_cutoff_is_zero(self):
        """An initial independent opinion has a real empty read boundary and cannot read later user text."""
        self.request(f"{self.path}/members", {"name": "Antigravity", "token": uuid.uuid4().hex}, self.owner)
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
        self.say("Antigravity 也请回答", to=["Antigravity"])
        other = self.reserve_for("Antigravity")[1]
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

    def test_initial_session_hides_room_state_execution_details_timeline_and_backup(self):
        """Anonymous initial readers cannot reach later answers through summary and activity endpoints."""
        gemini_token = uuid.uuid4().hex
        self.request(f"{self.path}/members", {"name": "Antigravity", "token": gemini_token}, self.owner)
        self.assertEqual(self.say("边界前普通任务")[0], 201)
        prior_execution = self.reserve_for("Claude")[1]
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute("UPDATE member_executions SET status='failed',result=? WHERE id=?",
                               ("普通执行失败原因", prior_execution["id"]))
        self.start_session()
        self.assertEqual(self.say("边界后私有失败任务", to=["Antigravity"])[0], 201)
        private_execution = self.reserve_for("Antigravity")[1]
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
                                     if item["name"] == "Antigravity")["execution"]
        self.assertEqual((hidden_free_failure["result"], hidden_member_failure["result"]), ("", ""))
        member_room = self.request(self.path, token=gemini_token)[1]
        self.assertEqual(next(item for item in member_room["free"]["executions"]
                              if item["id"] == private_execution["id"])["result"], "")
        owner_room = self.request(self.path, token=self.owner)[1]
        owner_free_failure = next(item for item in owner_room["free"]["executions"]
                                  if item["id"] == private_execution["id"])
        owner_member_failure = next(item for item in owner_room["free"]["members"]
                                    if item["name"] == "Antigravity")["execution"]
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

    def test_unnamed_message_with_several_members_goes_only_to_the_host(self):
        """With two members an unnamed message is routed by the host; nothing is broadcast."""
        self.assertEqual(super().say("没有点名")[0], 201)
        self.assertEqual([(item["member"], item["purpose"]) for item in self.request(self.path)[1]["free"]["requests"]], [("Codex", "route")])

    def test_naming_two_members_creates_two_requests_that_run_in_parallel(self):
        """One message to both members queues one request each; both can execute at once."""
        self.assertEqual(self.say("一起看看", to=["Claude", "Codex", "Claude"])[0], 201)
        self.assertEqual(self.say("不在场", to=["Antigravity"])[0], 400)
        requests = self.request(self.path)[1]["free"]["requests"]
        self.assertEqual(sorted(item["member"] for item in requests), ["Claude", "Codex"])
        self.assertEqual(self.reserve_for("Claude")[0], 200)
        self.assertEqual(self.reserve_for("Codex")[0], 200)
        self.assertEqual(self.request(self.path)[1]["experts"], {"Claude": "cli", "Codex": "cli"})

    def test_members_are_named_by_display_name_and_the_id_still_works(self):
        """The host dispatches @Gemini to the Antigravity member; a member's prose @Gemini is a suggestion for it."""
        self.request(f"{self.path}/members", {"name": "Antigravity", "adapter": "antigravity_cli", "token": uuid.uuid4().hex}, self.owner)
        labels = {member["name"]: member["label"] for member in self.request(self.path)[1]["members"]}
        self.assertEqual(labels, {"Claude": "Claude", "Codex": "Codex", "Antigravity": "Gemini"})
        self.say("请安排续写", to=["Codex"])
        host_work = self.reserve_for("Codex")[1]
        status, saved = self.answer(host_work["id"], "@Gemini 请续写第二章", token=self.codex, author="Codex", to=["Gemini"])
        self.assertEqual(status, 201, saved)
        dispatched = [item["member"] for item in self.request(self.path)[1]["free"]["requests"] if item["message_id"] == saved["message"]["id"]]
        self.assertEqual(dispatched, ["Antigravity"])
        self.say("请 Claude 看看")
        work = self.reserve_for("Claude")[1]
        status, saved = self.answer(work["id"], "建议 @Gemini 核对连续性。")
        self.assertEqual(status, 201, saved)
        self.assertEqual([item["member"] for item in saved["message"]["suggestions"]], ["Antigravity"])

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

    def test_registered_manual_member_can_be_adopted_in_a_free_room(self):
        """Once registered and its CLI reported a session, the owner's service takes the member over like a woken one."""
        gemini = uuid.uuid4().hex
        self.request(f"{self.path}/members", {"name": "Antigravity", "token": gemini, "access": "manual"}, self.owner)
        gemini_id = self.member_id("Antigravity")
        renewed = uuid.uuid4().hex + uuid.uuid4().hex
        adopt = {"action": "adopt", "adapter": "antigravity_cli", "session_id": "session-1", "token": renewed}
        self.assertEqual(self.request(f"{self.path}/members/{gemini_id}", adopt, self.owner)[0], 400)
        self.assertEqual(self.request(f"{self.path}/register", {}, gemini)[0], 200)
        self.assertEqual(self.request(f"{self.path}/members/{gemini_id}", adopt, self.owner)[0], 400, "no session reported yet")
        # The CLI reports its session in headers on any call; reading the room is enough.
        urlopen(Request(self.base + self.path, headers={"X-Discussion-Token": gemini, "X-Discussion-Session": adopt["session_id"],
                                                         "X-Discussion-Session-Client": "antigravity"}), timeout=10).close()
        self.assertEqual(self.request(f"{self.path}/members/{gemini_id}", {**adopt, "token": self.member}, self.owner)[0], 400, "a credential already in use")
        # A refused takeover is kept for the reported session, so the page can say why requests stay undelivered.
        failed = {"action": "adopt_failed", "session_id": "session-1", "reason": "会话属于其他目录"}
        self.assertEqual(self.request(f"{self.path}/members/{gemini_id}", {**failed, "session_id": "other"}, self.owner)[0], 400)
        status, view = self.request(f"{self.path}/members/{gemini_id}", failed, self.owner)
        self.assertEqual(status, 200, view)
        self.assertEqual(next(item for item in view["members"] if item["name"] == "Antigravity")["adopt_error"], "会话属于其他目录")
        status, adopted = self.request(f"{self.path}/members/{gemini_id}", adopt, self.owner)
        self.assertEqual(status, 200, adopted)
        member = next(item for item in adopted["members"] if item["name"] == "Antigravity")
        self.assertEqual((member["access"], member["session_mode"], member["adopt_error"]), ("runner", "borrowed", ""))
        # The service now answers with the credential it generated; the browser-made one no longer works.
        self.assertEqual(self.request(f"{self.path}/register", {}, gemini)[0], 403)
        inbox = self.request(f"{self.path}/inbox", token=self.owner)[1]
        self.assertIn("Antigravity", [item["name"] for item in inbox["members"]])

    def test_manual_member_answers_by_request_and_is_never_delivered(self):
        """A manual member is skipped by the runner and closes only its own open requests."""
        gemini = uuid.uuid4().hex
        self.request(f"{self.path}/members", {"name": "Antigravity", "token": gemini, "access": "manual"}, self.owner)
        self.assertEqual(self.say("先别点 Antigravity", to=["Antigravity"])[0], 400, "an unregistered manual member does not exist yet")
        self.assertEqual(self.request(f"{self.path}/inbox", token=self.owner)[1]["observers"], [])
        self.assertEqual(self.request(f"{self.path}/register", {}, gemini)[0], 200)
        self.say("请 Antigravity 看看", to=["Antigravity", "Claude"])
        inbox = self.request(f"{self.path}/inbox", token=self.owner)[1]
        self.assertEqual([member["name"] for member in inbox["members"]], ["Claude", "Codex"])
        self.assertEqual([member["name"] for member in inbox["observers"]], ["Antigravity"])
        self.assertEqual(self.reserve_for("Antigravity")[0], 404)
        requests = {item["member"]: item["id"] for item in self.request(self.path)[1]["free"]["requests"]}

        def post(**extra):
            return self.request(f"{self.path}/messages", {"author": "Antigravity", "text": "我的看法", "source": "cli",
                                                          "submission_id": uuid.uuid4().hex, **extra}, gemini)
        self.assertEqual(post(request_ids=[requests["Claude"]])[0], 409)
        self.assertEqual(post(execution_id=1)[0], 400)
        self.assertEqual(post(request_ids=[requests["Antigravity"]])[0], 201)
        self.assertEqual(post()[0], 201)
        states = {item["member"]: item["status"] for item in self.request(self.path)[1]["free"]["requests"]}
        self.assertEqual(states, {"Antigravity": "completed", "Claude": "pending"})

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


class HostRoomTests(FreeRoomTests):
    """A room hosted by Claude with Codex and Antigravity as runner members; shared by host and goal tests."""

    expected_host = "Claude"
    member_id = MultiMemberTests.member_id
    reserve_for = MultiMemberTests.reserve_for
    def say(self, text, token=None, **extra):
        """Name Claude unless told otherwise, as in the multi-member cases."""
        return FreeRoomTests.say(self, text, token, **({"to": ["Claude"]} | extra))

    def setUp(self):
        """Claude hosts; Codex and a third runner member, Antigravity, work."""
        super().setUp()
        self.codex, self.gemini = uuid.uuid4().hex, uuid.uuid4().hex
        self.request(f"{self.path}/members", {"name": "Codex", "token": self.codex}, self.owner)
        self.request(f"{self.path}/members", {"name": "Antigravity", "token": self.gemini}, self.owner)
        status, view = self.request(f"{self.path}/members/{self.member_id('Claude')}", {"action": "role", "role": "host"}, self.owner)
        self.assertEqual(status, 200, view)
        self.tokens = {"Claude": self.member, "Codex": self.codex, "Antigravity": self.gemini}

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


class HostTests(HostRoomTests):
    """An AI host routes unnamed messages, dispatches members, and is woken once per finished batch."""

    def test_host_dispatch_hands_back_once_after_every_member_finished(self):
        """Two dispatched members produce exactly one hand-off, after the last of them finishes."""
        FreeRoomTests.say(self, "请安排")
        self.work("Claude", to=["Codex", "Antigravity"])
        self.assertEqual(self.requests()[1:], [("Codex", "ask", "pending"), ("Antigravity", "ask", "pending")])
        self.work("Codex")
        self.assertNotIn(("Claude", "handoff", "pending"), self.requests())
        self.work("Antigravity")
        self.assertEqual(self.requests().count(("Claude", "handoff", "pending")), 1)

    def test_sequential_mention_asks_the_host_first_and_each_next_member_after_the_previous_ends(self):
        """@全体依次 asks one member at a time: the host, then by joining order; a failed or departed member is passed over."""
        FreeRoomTests.say(self, "依次说说", to=["Antigravity", "Codex", "Claude"], sequential=True)
        self.assertEqual(self.requests(), [("Claude", "ask", "pending")])
        self.work("Claude")
        self.assertEqual(self.requests()[1:], [("Codex", "ask", "pending")])
        failing = self.reserve_for("Codex")[1]
        self.request(f"{self.path}/executions/{failing['id']}", {"action": "fail", "reason": "CLI 退出"}, self.owner)
        self.assertEqual(self.requests()[1:], [("Codex", "ask", "failed"), ("Antigravity", "ask", "pending")])
        self.work("Antigravity")
        FreeRoomTests.say(self, "再来一次", to=["Antigravity", "Codex"], sequential=True)
        self.assertEqual(self.requests()[3:], [("Codex", "ask", "pending")])
        self.request(f"{self.path}/members/{self.member_id('Codex')}", {"action": "away"}, self.owner)
        self.assertEqual(self.requests()[3:], [("Codex", "ask", "cancelled"), ("Antigravity", "ask", "pending")])
        order = self.request(self.path)[1]["speaking_order"]
        self.assertEqual((order["kind"], [(item["name"], item["state"]) for item in order["items"]]),
                         ("queue", [("Antigravity", "speaking"), ("Claude", "idle")]))

    def test_owner_reorders_who_has_not_spoken_against_the_latest_revision(self):
        """Read the order, then send its revision: spoken and speaking members stay, the rest follow the new order at once."""
        FreeRoomTests.say(self, "依次说说", to=["Claude", "Codex", "Antigravity"], sequential=True)
        order = self.request(f"{self.path}/speaking-order")[1]
        self.assertEqual(([(item["name"], item["state"]) for item in order["items"]], order["movable"]),
                         ([("Claude", "speaking"), ("Codex", "queued"), ("Antigravity", "queued")], ["Codex", "Antigravity"]))
        url = f"{self.path}/speaking-order"
        self.assertEqual(self.request(url, {"order": ["Antigravity", "Codex"]}, self.owner)[0], 400)
        self.assertEqual(self.request(url, {"revision": order["revision"], "order": ["Antigravity", "Codex"]}, self.member)[0], 403)
        status, refused = self.request(url, {"revision": order["revision"], "order": ["Antigravity", "Claude"]}, self.owner)
        self.assertEqual(status, 400)
        self.assertIn("缺少：Codex", refused["error"])
        self.assertIn("多出：Claude", refused["error"])
        self.assertEqual(self.request(url, {"revision": "stale", "order": ["Antigravity", "Codex"]}, self.owner)[0], 409)
        status, room = self.request(url, {"revision": order["revision"], "order": ["Antigravity", "Codex"]}, self.owner)
        self.assertEqual(status, 200, room)
        self.assertEqual([item["name"] for item in room["speaking_order"]["items"]], ["Claude", "Antigravity", "Codex"])
        self.work("Claude")
        self.assertEqual(self.requests()[1:], [("Antigravity", "ask", "pending")])

    def test_partial_failure_still_hands_back_but_all_failed_halts(self):
        """One completed member is enough to hand back; a batch where all fail halts the chain."""
        FreeRoomTests.say(self, "第一链")
        self.work("Claude", to=["Codex", "Antigravity"])
        failing = self.reserve_for("Antigravity")[1]
        self.request(f"{self.path}/executions/{failing['id']}", {"action": "fail", "reason": "CLI 退出"}, self.owner)
        self.work("Codex")
        self.assertEqual(self.requests().count(("Claude", "handoff", "pending")), 1)
        self.work("Claude", to=["Codex"])
        failing = self.reserve_for("Codex")[1]
        self.request(f"{self.path}/executions/{failing['id']}", {"action": "fail", "reason": "再次失败"}, self.owner)
        free = self.request(self.path)[1]["free"]
        self.assertEqual([item["reason"] for item in free["halted_chains"]], ["all_failed"])
        self.assertEqual(self.requests().count(("Claude", "handoff", "pending")), 0)

    def test_owner_retries_a_failed_execution_once(self):
        """Retry puts the failed request back for the same member; the halted chain resumes and the host still gets the answer."""
        FreeRoomTests.say(self, "重试")
        self.work("Claude", to=["Codex", "Antigravity"])
        for name in ("Codex", "Antigravity"):
            failing = self.reserve_for(name)[1]
            self.request(f"{self.path}/executions/{failing['id']}", {"action": "fail", "reason": "投递失败"}, self.owner)
        url = f"{self.path}/executions/{failing['id']}"
        self.assertEqual(self.request(url, {"action": "retry"}, self.member)[0], 403)
        status, retried = self.request(url, {"action": "retry"}, self.owner)
        self.assertEqual((status, retried["status"], retried["requests"]), (200, "failed", []))
        self.assertEqual(self.request(url, {"action": "retry"}, self.owner)[0], 409)
        self.assertEqual(self.request(self.path)[1]["free"]["halted_chains"], [])
        self.assertIn(("Antigravity", "ask", "pending"), self.requests())
        self.work("Antigravity")
        self.assertEqual(self.requests().count(("Claude", "handoff", "pending")), 1)

    def test_round_limit_holds_the_next_dispatch_until_the_owner_continues(self):
        """A round is a host dispatch: its hand-back always comes, the next dispatch past the limit is held, and continuing sends it."""
        from backend import free_room
        original = free_room.CHAIN_ROUNDS
        free_room.CHAIN_ROUNDS = 1
        try:
            FreeRoomTests.say(self, "轮数")
            self.work("Claude", to=["Codex", "Antigravity"])
            self.work("Codex")
            self.work("Antigravity")
            self.assertEqual(self.requests()[-1], ("Claude", "handoff", "pending"), "the last round still gets its summary")
            self.work("Claude", to=["Antigravity"])
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
            self.assertEqual(self.requests()[-1], ("Antigravity", "ask", "pending"), "continuing sends the held dispatch")
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

    def test_handoff_sits_under_the_answer_that_completed_its_batch(self):
        """A user question asked during a dispatch stays above the host's handoff card and its answer (screenshot bug)."""
        FreeRoomTests.say(self, "写骨架")
        self.work("Claude", to=["Codex"], handoff=True)
        dispatch = max(item[0] for item in FreeRoomTests.messages(self))
        FreeRoomTests.say(self, "插问一句", to=["Claude"])
        self.work("Claude")
        self.work("Codex")
        returned = max(item[0] for item in FreeRoomTests.messages(self))
        handoff = self.reserve_for("Claude")[1]
        report = next(item for item in self.request(self.path)[1]["free"]["executions"] if item["id"] == handoff["id"])
        self.assertEqual((report["request_message_id"], report["anchor_message_id"]), (dispatch, returned))
        status, saved = self.request(f"{self.path}/messages", {"author": "Claude", "text": "汇总", "source": "cli",
                                                               "submission_id": uuid.uuid4().hex, "execution_id": handoff["id"]}, self.tokens["Claude"])
        self.assertEqual(status, 201, saved)
        answer = next(item for item in self.request(f"{self.path}/messages?after=0&withdrawn=include")[1]["messages"] if item["id"] == saved["message"]["id"])
        self.assertEqual(answer["anchor_message_id"], returned)

    def test_handoff_needs_a_host_dispatch(self):
        """handoff is true only beside the host's to; a member or a host naming no one is refused."""
        FreeRoomTests.say(self, "检查")
        host = self.reserve_for("Claude")[1]
        base = {"author": "Claude", "text": "x", "source": "cli", "execution_id": host["id"]}
        for extra in ({"handoff": True}, {"to": ["Codex"], "handoff": "yes"}):
            status, refused = self.request(f"{self.path}/messages", {**base, **extra, "submission_id": uuid.uuid4().hex}, self.tokens["Claude"])
            self.assertEqual(status, 400, refused)
            self.assertIn("handoff", refused["error"])

    def test_smart_scheduling_asks_everyone_or_no_one(self):
        """Everyone answers once without a hand-off and the host may not dispatch; no one cancels the host's request."""
        everyone = FreeRoomTests.say(self, "都出来打个招呼")[1]["message"]["id"]
        status, result = self.request(f"{self.path}/recommendations/{everyone}", {"action": "all"}, self.owner)
        self.assertEqual(status, 200, result)
        self.assertEqual(self.requests(), [("Claude", "all", "pending"), ("Codex", "all", "pending"), ("Antigravity", "all", "pending")])
        host = self.reserve_for("Claude")[1]
        payload = {"author": "Claude", "text": "派活", "source": "cli", "submission_id": uuid.uuid4().hex, "execution_id": host["id"], "to": ["Codex"]}
        self.assertEqual(self.request(f"{self.path}/messages", payload, self.member)[0], 400)
        del payload["to"]
        self.assertEqual(self.request(f"{self.path}/messages", {**payload, "submission_id": uuid.uuid4().hex}, self.member)[0], 201)
        self.work("Codex")
        self.work("Antigravity")
        self.assertNotIn("handoff", [purpose for _, purpose, _ in self.requests()])
        thanks = FreeRoomTests.say(self, "好的，谢谢")[1]["message"]["id"]
        self.assertEqual(self.request(f"{self.path}/recommendations/{thanks}", {"action": "none"}, self.owner)[0], 200)
        self.assertEqual(self.requests()[-1], ("Claude", "route", "cancelled"))
        started = FreeRoomTests.say(self, "已经开始处理的消息")[1]["message"]["id"]
        self.reserve_for("Claude")
        self.assertEqual(self.request(f"{self.path}/recommendations/{started}", {"action": "all"}, self.owner)[0], 409)

    def test_naming_everyone_waits_for_the_runner_to_choose_at_once_or_in_turn(self):
        """@全体成员 leaves the host an undeliverable group request; all asks everyone at once, sequential queues them."""
        everyone = ["Claude", "Codex", "Antigravity"]
        first = FreeRoomTests.say(self, "大家打个招呼", to=everyone, order="auto")[1]["message"]["id"]
        self.assertEqual(self.requests(), [("Claude", "group", "pending")])
        self.assertEqual(self.reserve_for("Claude")[0], 409)
        self.assertEqual(self.request(f"{self.path}/recommendations/{first}", {"action": "none"}, self.owner)[0], 400)
        revision = self.request(f"{self.path}/recommendations/{first}", token=self.owner)[1]["revision"]
        self.assertEqual(self.request(f"{self.path}/recommendations/{first}", {"action": "all", "revision": revision}, self.owner)[0], 200)
        self.assertEqual(self.requests(), [("Claude", "all", "pending"), ("Codex", "all", "pending"), ("Antigravity", "all", "pending")])
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
        payload = {"author": "Codex", "text": "越权", "source": "cli", "submission_id": uuid.uuid4().hex, "execution_id": codex["id"], "to": ["Antigravity"]}
        self.assertEqual(self.request(f"{self.path}/messages", payload, self.codex)[0], 201)
        self.assertFalse(any(item["member"] == "Antigravity" for item in self.request(self.path)[1]["free"]["requests"]))
        host = self.reserve_for("Claude")[1]
        payload = {"author": "Claude", "text": "点名自己", "source": "cli", "submission_id": uuid.uuid4().hex, "execution_id": host["id"], "to": ["Claude"]}
        self.assertEqual(self.request(f"{self.path}/messages", payload, self.member)[0], 400)

    def test_one_host_at_a_time(self):
        """Making Codex host demotes Claude; the host cannot step down, and when it leaves another member takes over."""
        self.request(f"{self.path}/members/{self.member_id('Codex')}", {"action": "role", "role": "host"}, self.owner)
        roles = {member["name"]: member["role"] for member in self.request(self.path)[1]["free"]["members"]}
        self.assertEqual(roles, {"Claude": "member", "Codex": "host", "Antigravity": "member"})
        self.assertEqual(self.request(self.path)[1]["host"], "Codex")
        self.assertEqual(self.request(f"{self.path}/members/{self.member_id('Codex')}", {"action": "role", "role": "member"}, self.owner)[0], 400)
        self.request(f"{self.path}/members/{self.member_id('Codex')}", {"action": "away"}, self.owner)
        self.assertEqual(self.request(self.path)[1]["host"], "Claude")
        self.request(f"{self.path}/members/{self.member_id('Codex')}", {"action": "active", "token": uuid.uuid4().hex}, self.owner)
        roles = {member["name"]: member["role"] for member in self.request(self.path)[1]["free"]["members"]}
        self.assertEqual(roles, {"Claude": "host", "Codex": "member", "Antigravity": "member"})

class GoalTests(HostRoomTests):
    """Goal mode: only the owner opens it, the host fills it in, and an idle room wakes the host once per new work."""

    def goal(self):
        """The room's latest goal and the revision its writes must carry."""
        return self.request(f"{self.path}/goal")[1]

    def goal_write(self, action, token=None, **extra):
        """Post one goal action with the current revision unless one is given."""
        payload = {"action": action, "revision": self.goal()["revision"], **extra}
        return self.request(f"{self.path}/goal", payload, token or self.owner)

    def open_from_page(self, **budget):
        """The owner opens a goal from the page; the host gets its first wake-up right away."""
        status, view = self.goal_write("start", objective="修完登录页并通过复核", **budget)
        self.assertEqual(status, 200, view)
        self.assertEqual(self.requests()[-1], ("Claude", "goal_continue", "pending"))
        return view

    def test_only_the_owner_command_opens_a_goal_and_the_host_fills_it_in(self):
        """`/goal` asks the host to fill in the objective; nobody else can open one, and declining leaves no goal."""
        command = FreeRoomTests.say(self, "/goal")[1]["message"]["id"]
        self.assertEqual(self.requests(), [("Claude", "goal_start", "pending")])
        request_id = self.request(self.path)[1]["free"]["requests"][-1]["id"]
        self.assertEqual(self.request(f"{self.path}/goal", {"action": "start", "request_id": request_id, "objective": "x"}, self.codex)[0], 403)
        self.assertEqual(self.request(f"{self.path}/goal", {"action": "start", "objective": "x"}, self.tokens["Claude"])[0], 403)
        self.reserve_for("Claude")
        status, view = self.request(f"{self.path}/goal", {"action": "start", "request_id": request_id, "objective": "修完登录页"}, self.tokens["Claude"])
        self.assertEqual((status, view["goal"]["status"], view["goal"]["objective"]), (200, "active", "修完登录页"), view)
        again = self.request(f"{self.path}/goal", {"action": "start", "request_id": request_id, "objective": "修完登录页"}, self.tokens["Claude"])[1]
        self.assertTrue(again["duplicate"])
        self.assertEqual(FreeRoomTests.say(self, "/goal 另一个目标")[0], 409)
        self.assertEqual(view["goal"]["started_message_id"], command)

    def test_idle_room_wakes_the_host_once_until_new_work(self):
        """A wake-up needs the revision; after one the room stays quiet until the host dispatches or the owner speaks."""
        self.open_from_page()
        self.work("Claude")
        self.assertFalse(self.goal()["goal"]["idle"])  # the host did not hand out work: wait for the owner
        FreeRoomTests.say(self, "继续，把测试也补上")
        self.work("Claude", to=["Codex"])
        self.assertFalse(self.goal()["goal"]["idle"])
        self.work("Codex")
        self.assertTrue(self.goal()["goal"]["idle"])
        self.assertEqual(self.request(f"{self.path}/goal", {"action": "continue"}, self.owner)[0], 400)
        self.assertEqual(self.request(f"{self.path}/goal", {"action": "continue", "revision": "stale"}, self.owner)[0], 409)
        self.assertEqual(self.goal_write("continue", token=self.tokens["Claude"])[0], 403)
        status, view = self.goal_write("continue")
        self.assertEqual((status, view["goal"]["continues"], view["goal"]["idle"]), (200, 1, False), view)
        self.assertEqual(self.requests()[-1], ("Claude", "goal_continue", "pending"))
        self.assertEqual(self.goal_write("continue")[0], 409)
        self.work("Claude")
        self.assertFalse(self.goal()["goal"]["idle"])

    def test_waiting_for_the_user_stands_down_until_new_work(self):
        """The runner's model may judge an idle room as waiting for the user: it needs the revision and an armed goal."""
        self.open_from_page()
        self.work("Claude", to=["Codex"])
        self.work("Codex")
        self.assertEqual(self.request(f"{self.path}/goal", {"action": "wait"}, self.owner)[0], 400)
        self.assertEqual(self.goal_write("wait", token=self.tokens["Claude"])[0], 403)
        status, view = self.goal_write("wait")
        self.assertEqual((status, view["goal"]["idle"], view["goal"]["continues"]), (200, False, 0), view)
        self.assertEqual(self.goal_write("wait")[0], 409)
        FreeRoomTests.say(self, "你们的意见我看了，继续")
        self.work("Claude")
        self.assertTrue(self.goal()["goal"]["idle"])

    def test_host_declares_done_only_after_other_work_ends(self):
        """Completion carries the revision and waits for members still working; it leaves an end notice."""
        self.open_from_page()
        self.work("Claude", to=["Codex"])
        status, refused = self.goal_write("done", token=self.tokens["Claude"], note="完成")
        self.assertEqual(status, 400, refused)
        self.assertIn("Codex", refused["error"])
        self.assertEqual(self.goal_write("block", token=self.tokens["Claude"])[0], 400)  # a block names its obstacle
        self.work("Codex")
        status, view = self.goal_write("done", token=self.tokens["Claude"], note="测试全部通过")
        self.assertEqual((status, view["goal"]["status"]), (200, "complete"), view)
        self.assertEqual(self.messages()[-1][1], "Goal 已完成：测试全部通过")

    def test_repeated_failures_and_budget_end_the_goal(self):
        """Three failed wake-ups in a row block the goal; a spent budget gets one wrap-up request and ends it."""
        self.open_from_page()
        for _ in range(3):
            execution = self.reserve_for("Claude")[1]
            self.assertEqual(self.request(f"{self.path}/executions/{execution['id']}", {"action": "fail", "reason": "模型不可用"}, self.owner)[0], 200)
            if self.goal()["goal"]["status"] == "active" and len([r for r in self.requests() if r[1] == "goal_continue"]) < 3:
                self.assertEqual(self.goal_write("continue")[0], 200)
        status, view = self.goal_write("continue")
        self.assertEqual((status, view["goal"]["status"]), (200, "blocked"), view)
        self.assertEqual(FreeRoomTests.say(self, "/goal 再来一次")[0], 201)  # a blocked goal is over; a new one may start
        request_id = self.request(self.path)[1]["free"]["requests"][-1]["id"]
        execution = self.reserve_for("Claude")[1]
        self.request(f"{self.path}/goal", {"action": "start", "request_id": request_id, "objective": "再来一次"}, self.tokens["Claude"])
        self.assertEqual(self.goal_write("update", max_continues=1)[0], 200)
        self.assertEqual(self.answer(execution["id"], token=self.tokens["Claude"], to=["Codex"])[0], 201)
        self.work("Codex")
        self.assertEqual(self.goal_write("continue")[1]["goal"]["continues"], 1)
        self.work("Claude", to=["Codex"])
        self.work("Codex")
        status, view = self.goal_write("continue")
        self.assertEqual((status, view["goal"]["status"]), (200, "budget_limited"), view)
        self.assertEqual(self.requests()[-1], ("Claude", "goal_continue", "pending"))  # the host still wraps up once

    def test_owner_controls_and_exclusion_with_discussion(self):
        """Pause, resume and clear are the owner's; stopping everything pauses; a goal and a discussion never overlap."""
        self.open_from_page()
        discussion = self.request(f"{self.path}/discussion")[1]
        status, refused = self.request(f"{self.path}/discussion", {"action": "start", "goal": "讨论", "revision": discussion["revision"]}, self.owner)
        self.assertEqual(status, 409, refused)
        self.assertEqual(self.request(f"{self.path}/goal", {"action": "pause"}, self.tokens["Claude"])[0], 403)
        FreeRoomTests.say(self, "/goal pause")
        self.assertEqual(self.goal()["goal"]["status"], "paused")
        self.assertEqual(FreeRoomTests.say(self, "/goal pause")[0], 409)
        self.assertEqual(self.request(f"{self.path}/goal", {"action": "resume"}, self.owner)[1]["goal"]["status"], "active")
        self.assertEqual(self.request(f"{self.path}/stop", {}, self.owner)[0], 200)
        self.assertEqual(self.goal()["goal"]["status"], "paused")
        FreeRoomTests.say(self, "/goal edit 改成只修登录按钮")
        self.assertEqual(self.goal()["goal"]["objective"], "改成只修登录按钮")
        FreeRoomTests.say(self, "/goal clear")
        self.assertEqual(self.goal()["goal"]["status"], "cleared")


class ModeCommandTests(HostRoomTests):
    """`/discuss` follows `/goal`: the owner's command authorizes, the host fills in the goal; `mode` reads and completes either."""

    def host_request(self, purpose):
        """The newest request of the given purpose."""
        return [item for item in self.request(self.path)[1]["free"]["requests"] if item["purpose"] == purpose][-1]

    def test_discuss_command_lets_the_host_open_a_discussion_with_room_limits(self):
        """Only the owner's `/discuss` opens one; the host's start carries the goal, never limits, and retries return it."""
        FreeRoomTests.say(self, "/discuss 比较方案 A 和 B 的上线成本")
        request = self.host_request("discuss_start")
        self.assertEqual((request["member"], request["status"]), ("Claude", "pending"))
        start = {"action": "start", "request_id": request["id"], "goal": "比较方案 A 和 B 的上线成本", "limits": {"max_rounds": 99}}
        self.assertEqual(self.request(f"{self.path}/discussion", start, self.codex)[0], 403)
        self.reserve_for("Claude")
        status, view = self.request(f"{self.path}/discussion", start, self.tokens["Claude"])
        self.assertEqual((status, view["session"]["status"], view["session"]["goal"]), (200, "active", "比较方案 A 和 B 的上线成本"), view)
        self.assertNotEqual(view["session"]["limits"]["max_rounds"], 99)
        self.assertTrue(self.request(f"{self.path}/discussion", start, self.tokens["Claude"])[1]["duplicate"])
        self.assertEqual(FreeRoomTests.say(self, "/goal 另起一个目标")[0], 409)
        self.assertEqual(FreeRoomTests.say(self, "/discuss 再开一场")[0], 409)
        FreeRoomTests.say(self, "/discuss pause")
        self.assertEqual(self.request(f"{self.path}/discussion")[1]["session"]["status"], "paused")
        FreeRoomTests.say(self, "/discuss resume")
        self.assertEqual(self.request(f"{self.path}/discussion")[1]["session"]["status"], "active")
        FreeRoomTests.say(self, "/discuss stop")
        self.assertIsNone(self.request(f"{self.path}/discussion")[1]["session"])
        self.assertEqual(FreeRoomTests.say(self, "/discuss stop")[0], 409)

    def test_mode_view_and_done_follow_the_open_mode(self):
        """`mode` reports the open mode with its completion revision; done is the host's and needs that revision."""
        self.assertEqual(self.request(f"{self.path}/mode")[1]["mode"], None)
        self.assertEqual(self.request(f"{self.path}/mode", {"action": "done", "revision": "x"}, self.tokens["Claude"])[0], 409)
        revision = self.request(f"{self.path}/goal")[1]["revision"]
        self.request(f"{self.path}/goal", {"action": "start", "revision": revision, "objective": "补上 CSV 导出"}, self.owner)
        self.work("Claude")
        view = self.request(f"{self.path}/mode")[1]
        self.assertEqual((view["mode"], view["goal"]["objective"]), ("goal", "补上 CSV 导出"))
        self.assertEqual(self.request(f"{self.path}/mode", {"action": "done", "revision": view["revision"]}, self.codex)[0], 403)
        status, done = self.request(f"{self.path}/mode", {"action": "done", "revision": view["revision"], "note": "已实现"}, self.tokens["Claude"])
        self.assertEqual((status, done["goal"]["status"]), (200, "complete"), done)
        current = self.request(f"{self.path}/discussion")[1]
        self.request(f"{self.path}/discussion", {"action": "start", "goal": "讨论", "revision": current["revision"]}, self.owner)
        view = self.request(f"{self.path}/mode")[1]
        self.assertEqual(view["mode"], "discussion")
        self.assertEqual(self.request(f"{self.path}/mode", {"action": "done", "revision": "stale"}, self.tokens["Claude"])[0], 409)


class RetiredWebMemberTests(FreeRoomTests):
    """Web chatbots no longer join; nobody answers on a member's behalf."""

    def test_online_members_and_relayed_answers_are_rejected(self):
        """The legacy online access is refused, and the owner credential speaks only as the user."""
        status, body = self.request(f"{self.path}/members", {"name": "DeepSeek", "token": uuid.uuid4().hex, "access": "online"}, self.owner)
        self.assertEqual(status, 400, body)
        self.request(f"{self.path}/members", {"name": "Codex", "token": uuid.uuid4().hex, "access": "manual"}, self.owner)
        relayed = {"author": "Codex", "text": "替成员回答", "submission_id": uuid.uuid4().hex}
        self.assertEqual(self.request(f"{self.path}/messages", relayed, self.owner)[0], 403)

class InstanceTests(FreeRoomTests):
    """Two instances of one platform are separate members with their own credentials and requests."""

    def test_two_claude_instances_are_distinct_members(self):
        """Claude and Claude-review receive separate requests and answer only with their own credential."""
        reviewer = uuid.uuid4().hex
        self.assertEqual(self.request(f"{self.path}/members", {"name": "Claude-review", "adapter": "claude", "token": reviewer}, self.owner)[0], 200)
        for name in ("Claudex", "Claude-", "Foo-1", "Claude-a b"):
            self.assertEqual(self.request(f"{self.path}/members", {"name": name, "token": uuid.uuid4().hex}, self.owner)[0], 400, name)
        self.say("请评审", to=["Claude-review"])
        requests = self.request(self.path)[1]["free"]["requests"]
        self.assertEqual([item["member"] for item in requests], ["Claude-review"])
        member_id = next(member["id"] for member in self.request(self.path)[1]["free"]["members"] if member["name"] == "Claude-review")
        execution = self.request(f"{self.path}/executions", {"member_id": member_id, "client_id": uuid.uuid4().hex}, self.owner)[1]
        self.assertEqual(self.answer(execution["id"], token=reviewer)[0], 403)
        payload = {"author": "Claude-review", "text": "评审意见", "source": "cli", "submission_id": uuid.uuid4().hex, "execution_id": execution["id"]}
        self.assertEqual(self.request(f"{self.path}/messages", payload, self.member)[0], 403)
        status, saved = self.request(f"{self.path}/messages", payload, reviewer)
        self.assertEqual((status, saved["message"]["author"]), (201, "Claude-review"))

class MigrationTests(unittest.TestCase):
    """Databases from earlier builds are upgraded in place."""

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

"""Free collaboration rooms: owner credential, member credentials, requests and executions."""

import json
import sqlite3
import tempfile
import threading
import unittest
import uuid
from contextlib import closing
from pathlib import Path
from urllib.error import HTTPError
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

    def test_room_view_reports_free_mode_and_members_without_secrets(self):
        """The public view lists members and states but never any credential hash."""
        room = self.request(self.path)[1]
        self.assertEqual(room["mode"], "free")
        self.assertEqual(room["host"], "用户")
        self.assertEqual([member["name"] for member in room["free"]["members"]], ["Claude"])
        self.assertNotIn("token_hash", json.dumps(room))
        self.assertNotIn("control_hash", json.dumps(room))
        backup = self.request(f"{self.path}/backup")[1]
        self.assertNotIn("token_hash", json.dumps(backup))
        self.assertNotIn("control_hash", json.dumps(backup))

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

    def test_interrupt_also_cancels_queued_requests_so_nothing_restarts(self):
        """Stopping a member voids work queued behind it; a new message starts fresh."""
        self.say("一")
        self.reserve()
        self.say("二")
        member_id = self.request(self.path)[1]["free"]["members"][0]["id"]
        view = self.request(f"{self.path}/members/{member_id}/interrupt", {}, self.owner)[1]
        self.assertEqual([item["status"] for item in view["requests"]], ["cancelled", "cancelled"])
        self.say("三")
        execution = self.reserve()[1]
        self.assertEqual(len(execution["requests"]), 1)

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
            connection.execute("UPDATE member_executions SET lease_until=1 WHERE id=?", (execution["id"],))
        self.assertEqual(self.answer(execution["id"])[0], 409)
        inbox = self.request(f"{self.path}/inbox", token=self.owner)[1]
        self.assertEqual(inbox["executions"], [])
        self.assertEqual(self.request(self.path)[1]["free"]["requests"][0]["status"], "failed")

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


class MigrationTests(unittest.TestCase):
    """The floor trigger is replaced on existing databases, and legacy rooms stay brainstorm rooms."""

    def test_existing_floor_trigger_is_replaced_and_rerun_is_harmless(self):
        """An old trigger definition is upgraded; repeating initialization changes nothing."""
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "old.db"
            init_database(database, seed=True)
            with closing(sqlite3.connect(database)) as connection, connection:
                connection.execute("DROP TRIGGER require_message_floor")
                connection.execute("""CREATE TRIGGER require_message_floor BEFORE INSERT ON messages
                    WHEN NEW.author<>'用户' AND NOT EXISTS (SELECT 1 FROM room_floor WHERE room_id=NEW.room_id AND holder=NEW.author)
                    BEGIN SELECT RAISE(ABORT, 'floor_required'); END""")
            init_database(database)
            init_database(database)
            with closing(sqlite3.connect(database)) as connection:
                sql = connection.execute("SELECT sql FROM sqlite_master WHERE name='require_message_floor'").fetchone()[0]
                self.assertIn("room_modes", sql)
                self.assertEqual(connection.execute("SELECT COUNT(*) FROM room_modes").fetchone()[0], 0)
                with self.assertRaises(sqlite3.IntegrityError):
                    connection.execute("INSERT INTO messages (room_id,author,text,source,submission_id,created_at) VALUES ('welcome','Codex','x','cli','late-0001','now')")


if __name__ == "__main__":
    unittest.main()

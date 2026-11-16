"""External members: owner grant and revocation, member-scope routes only, read audit and quota."""

import json
import re
import sqlite3
import time
import unittest
import uuid
from contextlib import closing
from pathlib import Path
from urllib.error import HTTPError
from unittest import mock
from urllib.request import Request, urlopen

from backend.external_members import EXTERNAL_HEADER, usage_of
from backend.server import ADMIN_OPERATIONS, DIRECTORY_OPERATIONS, INVITE_COMMANDS, INVITED_COMMANDS, DiscussionHandler
from tests.test_free_room import FreeRoomTests

SERVER_SOURCE = Path(__file__).resolve().parent.parent / "backend" / "server.py"
EXTERNAL = "Claude-ext1"


class ExternalMemberTests(FreeRoomTests):
    """One free room with a local Claude member, plus an external member added the way the gateway does on redemption."""

    def setUp(self):
        super().setUp()
        self.room_id = self.room["id"]
        self.external = uuid.uuid4().hex
        self.ext_path = f"/api/external/rooms/{self.room_id}"
        self.owner_path = f"{self.path}/external-members"

    def call(self, path, payload=None, token=None, external=False, headers=None):
        """Send one request, optionally marked as coming through the gateway; returns status and JSON."""
        sent = {"Content-Type": "application/json", **(headers or {})}
        if token:
            sent["X-Discussion-Token"] = token
        if external:
            sent[EXTERNAL_HEADER] = "1"
        request = Request(self.base + path, headers=sent, data=json.dumps(payload).encode() if payload is not None else None,
                          method="POST" if payload is not None else "GET")
        try:
            response = urlopen(request, timeout=10)
        except HTTPError as error:
            response = error
        with response:
            body = response.read()
        try:
            return response.status, json.loads(body)
        except ValueError:
            return response.status, {}

    def ext(self, route, payload=None, token=None):
        """Call a member-scope route as the external member."""
        return self.call(f"{self.ext_path}/{route}", payload, token or self.external, external=True)

    def create(self, **extra):
        """Add the external member with the owner credential after reading the roster revision."""
        revision = self.request(self.owner_path, token=self.owner)[1]["revision"]
        payload = {"revision": revision, "name": EXTERNAL, "adapter": "claude", "token": self.external, "machine": "fp:test",
                   "machine_label": "A", "scope": "read", "directories": ["D:/work/app"], "expires_at": int(time.time()) + 3600, **extra}
        status, body = self.request(self.owner_path, payload, self.owner)
        self.assertEqual(status, 201, body)
        return body["member"]

    def db(self):
        """Open the room database directly."""
        connection = sqlite3.connect(self.database)
        connection.row_factory = sqlite3.Row
        return connection


class OwnerGrantTests(ExternalMemberTests):
    def test_pending_seat_binding_is_versioned_and_activation_is_required(self):
        seat = self.create(pending=True)
        path = f"{self.owner_path}/{seat['member_id']}"
        self.assertEqual(seat["claimed_at"], 0)
        self.assertEqual(self.ext("view")[0], 403)
        first = self.request(path, {"action": "invite"}, self.owner)[1]
        second = self.request(path, {"action": "invite"}, self.owner)[1]
        binding = {"action": "bind", "invite_version": first["invite_version"], "token": self.external,
                   "machine": "ext:test", "expires_at": int(time.time()) + 3600}
        self.assertEqual(self.request(path, binding, self.owner)[0], 409)
        binding["invite_version"] = second["invite_version"]
        self.assertEqual(self.request(path, binding, self.owner)[0], 200)
        self.assertEqual(self.request(path, binding, self.owner)[0], 200)
        self.assertEqual(self.ext("view")[0], 403)
        self.assertEqual(self.request(path, {**binding, "machine": "ext:other"}, self.owner)[0], 409)
        self.assertEqual(self.request(path, {**binding, "action": "activate"}, self.owner)[0], 200)
        self.assertEqual(self.ext("view")[0], 200)
        self.assertEqual(self.request(path, {**binding, "action": "activate"}, self.owner)[0], 200)
        self.request(path, {"action": "revoke"}, self.owner)
        self.assertEqual(self.request(path, binding, self.owner)[0], 409)

    def test_pending_seats_are_excluded_from_dispatch_and_expire_in_seven_days(self):
        from backend.free_room import active_members, recipients
        ready = self.create()
        pending = self.create(pending=True, name="Custom-ext")
        self.create(pending=True, name="Custom-ext2")
        view = self.request(self.path, token=self.owner)[1]
        self.assertIn("Custom-ext", [item["name"] for item in view["speaking_order"]["items"]])
        with closing(self.db()) as connection, connection:
            self.assertIn(EXTERNAL, active_members(connection, self.room_id))
            self.assertNotIn("Custom-ext", active_members(connection, self.room_id, registered_only=False))
            with self.assertRaises(ValueError):
                recipients(connection, self.room_id, {"to": ["Custom-ext"]})
        for action in ("all", "sequential"):
            message = self.say("test routing")[1]["message"]["id"]
            plan = self.request(f"{self.path}/recommendations/{message}", token=self.owner)[1]
            self.assertNotIn("Custom-ext", json.dumps(plan))
            status, body = self.request(f"{self.path}/recommendations/{message}", {"action": action}, self.owner)
            self.assertEqual(status, 200, body)
        self.assertEqual(self.request(f"{self.path}/members/{pending['member_id']}", {"action": "role", "role": "host"}, self.owner)[0], 400)
        current = self.request(f"{self.path}/discussion")[1]
        status, body = self.request(f"{self.path}/discussion", {"action": "start", "goal": "seat eligibility", "revision": current["revision"]}, self.owner)
        self.assertEqual(status, 200, body)
        with closing(self.db()) as connection, connection:
            from backend.session_room import roster_view
            roster = roster_view(connection, self.room_id)
            self.assertNotIn("Custom-ext", json.dumps(roster))
            from backend.server import merge_round_groups
            from backend.private_chat import chat_member
            with self.assertRaises(FileExistsError):
                chat_member(connection, self.room_id, pending["member_id"])
            request = connection.execute("SELECT id,message_id FROM member_requests WHERE member_id=? ORDER BY id DESC LIMIT 1", (ready["member_id"],)).fetchone()
            connection.execute("UPDATE member_requests SET answer_id=message_id,status='completed' WHERE id=?", (request["id"],))
            session_id = connection.execute("SELECT MAX(id) FROM discussion_sessions WHERE room_id=?", (self.room_id,)).fetchone()[0]
            connection.execute("""INSERT INTO session_requests(session_id,round,member_id,purpose,member_request_id,submission_id,created_at)
                VALUES (?,1,?,'discuss',?,'seat-round-check','now')""", (session_id, ready["member_id"], request["id"]))
            groups = merge_round_groups(connection, self.room_id)
            self.assertEqual(groups[0]["speakers"], [EXTERNAL])
            self.assertTrue(groups[0]["completed"])
            connection.execute("UPDATE external_members SET created_at=? WHERE member_id=?", (int(time.time()) - 7 * 86400 - 1, pending["member_id"]))
        expired = self.request(f"{self.owner_path}/{pending['member_id']}", token=self.owner)[1]
        self.assertEqual((expired["status"], expired["end_reason"]), ("removed", "expired"))

    def test_old_external_rows_migrate_as_claimed(self):
        from backend.server import init_database
        member = self.create()
        with closing(self.db()) as connection, connection:
            for column in ("claimed_at", "invite_version", "invite_duration"):
                connection.execute(f"ALTER TABLE external_members DROP COLUMN {column}")
        init_database(self.database, seed=False)
        row = self.request(f"{self.owner_path}/{member['member_id']}", token=self.owner)[1]
        self.assertGreater(row["claimed_at"], 0)
        self.assertEqual(self.ext("view")[0], 200)

    def test_create_requires_fresh_revision_and_is_idempotent(self):
        payload = {"name": EXTERNAL, "adapter": "claude", "token": self.external, "machine": "fp:test", "scope": "read",
                   "directories": ["D:/work/app"], "expires_at": int(time.time()) + 3600}
        status, body = self.request(self.owner_path, payload, self.owner)
        self.assertEqual(status, 400, body)
        status, body = self.request(self.owner_path, {**payload, "revision": "0" * 64}, self.owner)
        self.assertEqual((status, body.get("code")), (409, "stale_revision"), body)
        self.assertEqual(self.request(self.owner_path, {**payload, "revision": "x"}, self.member)[0], 403)
        member = self.create()
        self.assertEqual((member["scope"], member["quota"]["hourly_reads"], member["status"]), ("read", 600, "active"))
        status, again = self.request(self.owner_path, {**payload, "revision": "stale"}, self.owner)
        self.assertEqual((status, again["member"]["member_id"]), (200, member["member_id"]))
        # Visible in the room view without its local path; delivered by nobody on this computer.
        listed = next(item for item in self.request(self.path)[1]["free"]["members"] if item["name"] == EXTERNAL)
        self.assertEqual(listed["access"], "external")
        self.assertEqual(listed["external"]["directories"], [{"root": 0, "name": "app"}])
        self.assertNotIn("D:/work", json.dumps(listed))
        inbox = self.request(f"{self.path}/inbox", token=self.owner)[1]
        self.assertNotIn(EXTERNAL, [item["name"] for item in inbox["members"]])
        self.assertIn(EXTERNAL, [item["name"] for item in inbox["observers"]])
        status, _ = self.request(f"{self.path}/executions", {"member_id": member["member_id"], "client_id": uuid.uuid4().hex}, self.owner)
        self.assertEqual(status, 404)

    def test_create_rejects_bad_grants(self):
        revision = self.request(self.owner_path, token=self.owner)[1]["revision"]
        base = {"revision": revision, "name": EXTERNAL, "token": self.external, "machine": "fp:test", "scope": "read",
                "directories": ["D:/work/app"], "expires_at": int(time.time()) + 3600}
        for change in ({"scope": "write"}, {"directories": []}, {"scope": "discuss"}, {"expires_at": int(time.time()) - 1},
                       {"quota": {"hourly_bytes": 0}}, {"name": "Claude"}, {"token": self.member}, {"name": "Someone"}):
            status, body = self.request(self.owner_path, {**base, **change}, self.owner)
            self.assertIn(status, (400, 409), (change, body))

    def test_update_and_revoke_void_live_work(self):
        member = self.create()
        member_url = f"{self.owner_path}/{member['member_id']}"
        status, updated = self.request(member_url, {"action": "update", "quota": {"hourly_reads": 5}, "expires_at": int(time.time()) + 7200}, self.owner)
        self.assertEqual((status, updated["quota"]["hourly_reads"], updated["quota"]["hourly_bytes"]), (200, 5, 4 * 1024 * 1024), updated)
        status, narrowed = self.request(member_url, {"action": "update", "scope": "discuss"}, self.owner)
        self.assertEqual((status, narrowed["directories"]), (200, []), narrowed)
        self.assertEqual(self.request(f"{self.path}/members/{member['member_id']}", {"action": "role", "role": "host"}, self.owner)[0], 400)
        self.say("请看一下", to=[EXTERNAL])
        execution = self.ext("claim", {"client_id": uuid.uuid4().hex})[1]
        status, revoked = self.request(member_url, {"action": "revoke"}, self.owner)
        self.assertEqual((status, revoked["status"], revoked["end_reason"]), (200, "removed", "revoked"), revoked)
        with closing(self.db()) as connection:
            self.assertEqual(connection.execute("SELECT status FROM member_executions WHERE id=?", (execution["id"],)).fetchone()[0], "cancelled")
        status, body = self.ext("inbox")
        self.assertEqual((status, body.get("code"), body.get("reason")), (403, "external_ended", "revoked"), body)
        self.assertEqual(self.request(member_url, {"action": "update", "scope": "discuss"}, self.owner)[0], 409)

    def test_expired_member_is_refused_and_its_work_voided(self):
        member = self.create()
        self.say("请看一下", to=[EXTERNAL])
        execution = self.ext("claim", {"client_id": uuid.uuid4().hex})[1]
        with closing(self.db()) as connection, connection:
            connection.execute("UPDATE external_members SET expires_at=? WHERE member_id=?", (int(time.time()) - 1, member["member_id"]))
        status, body = self.ext("view")
        self.assertEqual((status, body.get("code"), body.get("reason")), (403, "external_ended", "expired"), body)
        with closing(self.db()) as connection:
            self.assertEqual(connection.execute("SELECT status FROM member_executions WHERE id=?", (execution["id"],)).fetchone()[0], "cancelled")
            self.assertEqual(connection.execute("SELECT status FROM room_members WHERE id=?", (member["member_id"],)).fetchone()[0], "removed")


class MemberScopeTests(ExternalMemberTests):
    def test_request_claim_progress_and_answer(self):
        self.create()
        sent = self.say("请帮忙看 app.py", to=[EXTERNAL])[1]
        status, inbox = self.ext("inbox")
        self.assertEqual(status, 200, inbox)
        self.assertEqual([item["message_id"] for item in inbox["pending"]], [sent["message"]["id"]])
        status, view = self.ext("view")
        self.assertEqual((status, view["me"]["directories"]), (200, [{"root": 0, "name": "app"}]), view)
        self.assertNotIn("D:/work", json.dumps(view))
        self.assertNotIn("token", json.dumps(view))
        messages = self.ext("messages?after=0")[1]["messages"]
        self.assertIn("请帮忙看 app.py", [item["text"] for item in messages])
        self.assertEqual(self.ext(f"messages/{sent['message']['id']}")[1]["text"], "请帮忙看 app.py")
        client_id = uuid.uuid4().hex
        status, execution = self.ext("claim", {"client_id": client_id})
        self.assertEqual(status, 200, execution)
        self.assertEqual(self.ext("claim", {"client_id": client_id})[1]["id"], execution["id"])
        self.assertEqual(self.ext("claim", {"client_id": uuid.uuid4().hex})[0], 409)
        status, renewed = self.ext(f"executions/{execution['id']}", {"action": "renew"})
        self.assertEqual(status, 200, renewed)
        self.assertEqual(self.ext(f"executions/{execution['id']}", {"action": "retry"})[0], 400)
        self.assertEqual(self.ext("answer", {"text": "派活", "execution_id": execution["id"], "submission_id": uuid.uuid4().hex,
                                             "to": ["Claude"]})[0], 400)
        self.assertEqual(self.ext("answer", {"text": "冒充", "author": "Claude", "execution_id": execution["id"],
                                             "submission_id": uuid.uuid4().hex})[0], 403)
        status, answered = self.ext("answer", {"text": "看过了，问题在第 3 行", "execution_id": execution["id"], "submission_id": uuid.uuid4().hex})
        self.assertEqual(status, 201, answered)
        self.assertEqual(answered["message"]["author"], EXTERNAL)
        with closing(self.db()) as connection:
            self.assertEqual(connection.execute("SELECT status FROM member_executions WHERE id=?", (execution["id"],)).fetchone()[0], "completed")

    def test_claim_only_the_requests_agreed_to(self):
        self.create()
        self.say("第一件", to=[EXTERNAL])
        self.say("第二件", to=[EXTERNAL])
        first, second = [item["id"] for item in self.ext("inbox")[1]["pending"]]
        self.assertEqual(self.ext("claim", {"client_id": uuid.uuid4().hex, "request_ids": "x"})[0], 400)
        self.assertEqual(self.ext("claim", {"client_id": uuid.uuid4().hex, "request_ids": [second + 100]})[0], 409)
        status, execution = self.ext("claim", {"client_id": uuid.uuid4().hex, "request_ids": [second]})
        self.assertEqual(status, 200, execution)
        self.assertEqual([item["id"] for item in execution["requests"]], [second])
        self.assertEqual([item["id"] for item in self.ext("inbox")[1]["pending"]], [first])

    def test_cannot_touch_local_member_execution(self):
        self.create()
        self.say("本机先做", to=["Claude"])
        local = self.reserve()[1]
        self.assertEqual(self.ext(f"executions/{local['id']}", {"action": "fail", "reason": "x"})[0], 403)
        self.assertEqual(self.ext("answer", {"text": "抢答", "execution_id": local["id"], "submission_id": uuid.uuid4().hex})[0], 403)

    def test_decline_and_timeout_show_as_not_agreed(self):
        self.create()
        self.say("第一件", to=[EXTERNAL])
        first = self.ext("inbox")[1]["pending"][0]["id"]
        status, body = self.ext("decline", {"request_ids": [first], "outcome": "declined"})
        self.assertEqual((status, body["declined"]), (200, [first]), body)
        self.assertEqual(self.ext("decline", {"request_ids": [first], "outcome": "declined"})[0], 409)
        self.say("第二件", to=[EXTERNAL])
        second = self.ext("inbox")[1]["pending"][0]["id"]
        self.assertEqual(self.ext("decline", {"request_ids": [second], "outcome": "timeout"})[0], 200)
        requests = {item["id"]: item for item in self.request(self.path)[1]["free"]["requests"]}
        self.assertEqual((requests[first]["status"], requests[first]["external_outcome"]), ("cancelled", "declined"))
        self.assertEqual(requests[second]["external_outcome"], "timeout")

    def test_wrong_credentials_and_rooms(self):
        member = self.create()
        self.assertEqual(self.call(f"{self.ext_path}/view", token=self.owner, external=True)[1].get("code"), "external_credential_required")
        self.assertEqual(self.call(f"{self.ext_path}/view", token=self.member, external=True)[1].get("code"), "external_credential_required")
        other = self.request("/api/rooms", {"title": "另一个", "goal": "g", "mode": "free", "submission_id": "other-room",
                                            "members": [{"name": "Codex", "adapter": "codex_cli", "token": uuid.uuid4().hex}]}, uuid.uuid4().hex)[1]
        self.assertEqual(self.call(f"/api/external/rooms/{other['id']}/view", token=self.external, external=True)[0], 403)
        self.assertEqual(self.ext("leave", {})[1], {"left": True})
        listed = self.request(f"{self.owner_path}/{member['member_id']}", token=self.owner)[1]
        self.assertEqual(listed["end_reason"], "left")
        self.assertEqual(self.ext("view")[1].get("reason"), "left")


class LocalEntryTests(ExternalMemberTests):
    """The computer's own page reaches the invite commands and the invited records through `/api/local/<command>`."""

    def local(self, command, payload):
        """POST one local entry command as this computer's own page would."""
        headers = {"Content-Type": "application/json", "X-CoDiscuss-Local": "1", "Host": f"127.0.0.1:{self.server.server_port}"}
        request = Request(f"{self.base}/api/local/{command}", headers=headers, data=json.dumps(payload).encode(), method="POST")
        try:
            response = urlopen(request, timeout=10)
        except HTTPError as error:
            response = error
        with response:
            return response.status, json.loads(response.read())

    def test_invite_and_invited_commands_are_routed(self):
        self.server.local_launch = True
        self.server.local_site = True
        calls = []

        def fake(handler, command, payload, configuration_locked=False, remote=False):
            calls.append((command, dict(payload or {})))
            return 200, {"ok": True}
        with mock.patch.object(DiscussionHandler, "local_command_result", fake):
            for command in INVITE_COMMANDS + INVITED_COMMANDS:
                self.assertEqual(self.local(command, {"room_id": self.room_id}), (200, {"ok": True}), command)
            self.assertEqual(self.local("invited-unknown", {})[0], 404)
        sent = dict(calls)
        # Without a credential the computer's own page acts as the room's owner for invites; invited records get none.
        self.assertTrue(sent["room-invite"]["token"])
        self.assertTrue(sent["room-invite-revoke"]["token"])
        self.assertNotIn("token", sent["invited-list"])
        self.assertEqual([command for command, _ in calls], list(INVITE_COMMANDS + INVITED_COMMANDS))


class ReadAuditTests(ExternalMemberTests):
    def read(self, member_id, **payload):
        return self.request(f"{self.owner_path}/{member_id}/reads", {"op": "read", "root": 0, "path": "a.py", "bytes": 10, "outcome": "ok", **payload},
                            self.owner)

    def test_audit_then_quota_persisted(self):
        member = self.create(quota={"hourly_bytes": 100, "total_bytes": 150, "hourly_reads": 2})
        member_id = member["member_id"]
        self.assertEqual(self.read(member_id, bytes=60)[1]["allowed"], True)
        status, refused = self.read(member_id, bytes=50)
        self.assertEqual((status, refused["allowed"], refused["code"], refused["recorded"]), (200, False, "quota_hour_bytes", True), refused)
        self.assertEqual(self.read(member_id, outcome="denied", reason="敏感文件", path=".env")[1]["code"], "engine_denied")
        self.assertEqual(self.read(member_id, root=3)[1]["code"], "bad_root")
        self.assertEqual(self.read(member_id, bytes=10)[1]["allowed"], True)
        self.assertEqual(self.read(member_id, bytes=1)[1]["code"], "quota_hour_reads")
        self.assertEqual(self.request(f"{self.owner_path}/{member_id}/reads", {"op": "read", "root": 0, "path": "a", "bytes": 1, "outcome": "ok"},
                                      self.member)[0], 403)
        reads = self.request(f"{self.owner_path}/{member_id}/reads?after=0", token=self.owner)[1]
        self.assertEqual([(item["code"], item["directory"]) for item in reads["reads"]][:2], [("ok", "D:/work/app"), ("quota_hour_bytes", "D:/work/app")])
        self.assertEqual(len(reads["reads"]), 6)
        # Counts come from the stored audit, so a new process sees the same usage; each read is in the room's event log.
        with closing(self.db()) as connection:
            self.assertEqual(usage_of(connection, member_id)["total_bytes"], 70)
            events = [json.loads(row[0]) for row in connection.execute("SELECT data FROM room_events WHERE kind='external.read' ORDER BY id")]
        self.assertEqual([event["allowed"] for event in events], [True, False, False, False, True, False])
        self.assertEqual(events[0]["path"], "a.py")

    def test_discussion_only_member_cannot_read(self):
        member = self.create(scope="discuss", directories=[])
        self.assertEqual(self.read(member["member_id"])[1]["code"], "not_readable")

    def test_audit_failure_is_an_error(self):
        member = self.create()
        with closing(self.db()) as connection, connection:
            connection.execute("DROP TABLE external_reads")
        status, body = self.read(member["member_id"])
        self.assertGreaterEqual(status, 500, body)
        self.assertNotIn("allowed", body)


def server_routes():
    """Every path the server routes, rebuilt from the literal path segments in backend/server.py's route branches."""
    room = "ROOM"
    segments = set()
    for line in SERVER_SOURCE.read_text(encoding="utf-8").splitlines():
        if "parts" in line or "parsed.path" in line:
            segments.update(re.findall(r'"([a-z][a-z0-9_-]*)"', line))
    segments.update(DIRECTORY_OPERATIONS + ADMIN_OPERATIONS)
    paths = {"/", "/api/rooms", "/api/folders", "/api/revisions", "/api/updates", "/api/health", f"/r/{room}", f"/api/rooms/{room}"}
    for segment in segments:
        paths.update({f"/api/{segment}", f"/api/{segment}/1", f"/api/{segment}/1/{segment}", f"/api/rooms/{room}/{segment}",
                      f"/api/rooms/{room}/{segment}/1", f"/api/rooms/{room}/messages/1/{segment}", f"/api/rooms/{room}/members/1/{segment}",
                      f"/api/rooms/{room}/executions/1/{segment}", f"/api/rooms/{room}/external-members/1/{segment}",
                      f"/api/local/{segment}", f"/api/admin/{segment}", f"/api/machines/1/{segment}", f"/r/{room}/{segment}"})
    return sorted(paths)


class RouteTraversalTests(ExternalMemberTests):
    def test_every_other_route_refuses_external_requests(self):
        member = self.create()
        routes = [path.replace("ROOM", self.room_id).replace("/1", f"/{member['member_id']}", 1) if "external-members" in path
                  else path.replace("ROOM", self.room_id) for path in server_routes()]
        self.assertGreater(len(routes), 300)
        with closing(self.db()) as connection:
            before = connection.execute("SELECT COUNT(*) FROM messages").fetchone()[0], connection.execute("SELECT COUNT(*) FROM room_members").fetchone()[0]
        # The credential alone, the gateway's marker with it, and the marker alone on the local site, where a request
        # without any credential would otherwise act as the administrator.
        cases = ((False, self.external, False), (False, self.external, True), (True, None, True))
        for local_site, token, marked in cases:
            self.server.local_site = local_site
            for path in routes:
                for payload in (None, {"author": EXTERNAL, "text": "x", "submission_id": uuid.uuid4().hex}):
                    status, body = self.call(path, payload, token, external=marked)
                    self.assertEqual((status, body.get("code")), (403, "external_route_forbidden"), (path, local_site, token is not None, marked, payload is not None))
        with closing(self.db()) as connection:
            after = connection.execute("SELECT COUNT(*) FROM messages").fetchone()[0], connection.execute("SELECT COUNT(*) FROM room_members").fetchone()[0]
        self.assertEqual(before, after)

    def test_device_bridge_cannot_carry_external_requests(self):
        self.create()
        status, body = self.call(f"{self.ext_path}/view", token=self.external, external=True, headers={"X-CoDiscuss-Bridge": "a" * 64})
        self.assertEqual((status, body.get("code")), (403, "external_route_forbidden"))

    def test_unknown_member_route_is_not_found(self):
        self.create()
        self.assertEqual(self.ext("members")[0], 404)
        self.assertEqual(self.ext("stop", {})[0], 404)


if __name__ == "__main__":
    unittest.main()

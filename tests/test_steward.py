"""Exercise the Python site's platform steward room contract."""
import hashlib
import json
import tempfile
import threading
import unittest
import uuid
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from backend.server import DiscussionServer, connect_db, expired_rooms, init_database


class StewardRoomTests(unittest.TestCase):
    """Use only a fresh local database and never connect a runner."""

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.database = Path(directory.name) / "steward.sqlite3"
        init_database(self.database, seed=False)
        server = DiscussionServer(("127.0.0.1", 0), self.database)
        self.server = server
        self.addCleanup(server.server_close)
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        thread.start()
        self.addCleanup(thread.join)
        self.addCleanup(server.shutdown)
        self.base = f"http://127.0.0.1:{server.server_port}"
        self.owner = uuid.uuid4().hex
        self.member = uuid.uuid4().hex

    def request(self, path, body=None, token="", *, method=None, headers=None):
        """Return HTTP status and the decoded JSON response, including error responses."""
        data = json.dumps(body).encode() if body is not None else None
        headers = dict(headers or {})
        if data is not None:
            headers.setdefault("Content-Type", "application/json")
        if token:
            headers["X-Discussion-Token"] = token
        try:
            response = urlopen(Request(self.base + path, data=data, method=method, headers=headers), timeout=5)
        except HTTPError as error:
            response = error
        with response:
            return response.status, json.load(response)

    def test_steward_rejects_member_additions_but_project_room_allows_them(self):
        steward_id = self.create("steward")[1]["id"]
        project_id = self.create()[1]["id"]
        message = "平台主理人房间只能有一名成员，不能新增或邀请成员"
        new_member = {"name": "Claude", "token": uuid.uuid4().hex, "access": "manual"}
        for action in ("members", "external-members", "guest/invite"):
            with self.subTest(action=action):
                status, result = self.request(f"/api/rooms/{steward_id}/{action}", new_member, self.owner)
                self.assertEqual(status, 403, result)
                self.assertEqual(result["error_text"]["template"], message)
        status, result = self.request(f"/api/rooms/{project_id}/members", new_member, self.owner)
        self.assertEqual(status, 200, result)
        self.assertEqual({member["name"] for member in result["members"]}, {"Codex", "Claude"})

    def test_steward_creation_rejects_multiple_members(self):
        status, result = self.request("/api/rooms", {
            "title": "Steward",
            "system_kind": "steward",
            "members": [
                {"name": "Codex", "token": uuid.uuid4().hex},
                {"name": "Claude", "token": uuid.uuid4().hex},
            ],
            "host": "Codex",
            "submission_id": uuid.uuid4().hex,
        }, self.owner)
        self.assertEqual(status, 400, result)

    def test_local_steward_actions_forward_payload_and_allow_options(self):
        self.server.local_launch = True
        self.server.connections_file = self.database.with_name("connections.json")
        origin = "https://example.test"
        connection_token = uuid.uuid4().hex + uuid.uuid4().hex
        self.server.connections_file.write_text(json.dumps({"sites": {
            origin: {"token_hash": hashlib.sha256(connection_token.encode()).hexdigest()}
        }}), encoding="utf-8")
        payloads = {"steward": {"open": True}, "steward-settings": {"adapter": "codex"},
                    "steward-request": {"skill": "share-card", "context": {"room_id": "room-1"}},
                    "steward-history": {}, "steward-delete": {"room_id": "room-1"}}
        for route, body in payloads.items():
            with self.subTest(route=route), patch.object(self.server.RequestHandlerClass, "local_command_result", return_value=(200, {"ok": True})) as command:
                path = f"/api/local/{route}"
                headers = {"Origin": origin, "X-CoDiscuss-Local": "1"}
                self.assertEqual(self.request(path, body, headers=headers)[0], 403)
                command.assert_not_called()
                status, result = self.request(path, body, headers={**headers, "X-CoDiscuss-Connection": connection_token})
                self.assertEqual((status, result), (200, {"ok": True}))
                command.assert_called_once_with(route, body, False, True)
                status, result = self.request(path, method="OPTIONS", headers={
                    "Origin": origin, "Access-Control-Request-Method": "POST",
                    "Access-Control-Request-Headers": "content-type, x-codiscuss-local, x-codiscuss-connection",
                })
                self.assertEqual((status, result), (200, {"ok": True}))

    def create(self, kind="", submission_id=None, member_token=None, owner_token=None):
        """Submit one valid room creation using the new room's control credential."""
        return self.request("/api/rooms", {
            "title": "Steward" if kind else "Project",
            "members": [{"name": "Codex", "token": member_token or self.member}],
            "host": "Codex",
            "system_kind": kind,
            "submission_id": submission_id or uuid.uuid4().hex,
        }, owner_token or self.owner)

    def test_active_steward_can_read_dispatch_chains_but_room_credentials_cannot(self):
        project_token, steward_token = uuid.uuid4().hex, uuid.uuid4().hex
        project_owner, steward_owner = uuid.uuid4().hex, uuid.uuid4().hex
        project_id = self.create(member_token=project_token, owner_token=project_owner)[1]["id"]
        steward = self.create("steward", member_token=steward_token, owner_token=steward_owner)[1]
        status, _ = self.request(f"/api/rooms/{project_id}/messages", {
            "author": "用户", "text": "检查派活", "submission_id": uuid.uuid4().hex,
        }, project_owner)
        self.assertEqual(status, 201)

        status, admin_result = self.request("/api/dispatches?view=chains")
        self.assertEqual(status, 200, admin_result)
        status, steward_result = self.request("/api/dispatches?view=chains", token=steward_token)
        self.assertEqual((status, steward_result), (200, admin_result))
        self.assertEqual([record["room_id"] for record in admin_result["records"]], [project_id])
        for token in (project_token, project_owner, steward_owner):
            with self.subTest():
                self.assertEqual(self.request("/api/dispatches?view=chains", token=token)[0], 403)
        self.assertEqual(self.request("/api/analytics/dispatches", token=steward_token)[0], 401)

        status, denied = self.request(f"/api/rooms/{project_id}/topic", {
            "actor": "用户", "background": "unauthorized",
        }, steward_token)
        self.assertEqual(status, 403, denied)

        self.assertEqual(self.request(f"/api/rooms/{steward['id']}/archive", {"actor": "用户"}, steward_owner)[0], 200)
        self.assertEqual(self.request("/api/dispatches?view=chains", token=steward_token)[0], 403)

    def test_steward_creation_requires_site_management_authority(self):
        project_token = uuid.uuid4().hex
        self.assertEqual(self.create(member_token=project_token)[0], 201)
        self.assertEqual(self.create("steward", owner_token=project_token)[0], 403)
        self.server.local_site = False
        self.assertEqual(self.create("steward", owner_token=uuid.uuid4().hex)[0], 403)
        self.assertTrue(all(not room["system_kind"] for room in self.request("/api/rooms")[1]["rooms"]))

    def test_creation_retry_list_and_restore(self):
        status, room = self.create("steward")
        self.assertEqual(status, 201, room)
        room_id = room["id"]
        path = f"/api/rooms/{room_id}"
        self.assertEqual(room["system_kind"], "steward")
        self.assertEqual(self.request(path)[1]["system_kind"], "steward")
        status, replay = self.create("steward", room["submission_id"])
        self.assertEqual((status, replay["id"]), (200, room_id))
        status, conflict = self.create("steward")
        self.assertEqual((status, conflict["room_id"]), (409, room_id))
        self.assertEqual(self.create("unknown")[0], 400)
        self.assertEqual(self.request("/api/rooms", {
            "title": "No owner", "members": [{"name": "Codex", "token": self.member}], "system_kind": "steward",
        })[0], 400)

        normal_id = self.create()[1]["id"]
        listed = {item["id"]: item["system_kind"] for item in self.request("/api/rooms")[1]["rooms"]}
        self.assertEqual(listed, {normal_id: "", room_id: "steward"})
        self.assertEqual(self.request(path + "/archive", {"actor": "用户"}, self.owner)[0], 200)
        status, replacement = self.create("steward")
        self.assertEqual(status, 201, replacement)
        status, conflict = self.request(path + "/restore", {"actor": "用户"}, self.owner)
        self.assertEqual((status, conflict["room_id"]), (409, replacement["id"]))

    def test_last_room_and_expiry_only_include_project_rooms(self):
        normal_id = self.create()[1]["id"]
        steward_id = self.create("steward")[1]["id"]
        for room_id in (normal_id, steward_id):
            status, result = self.request("/api/rooms/last", {"room_id": room_id})
            self.assertEqual((status, result["last_room"]), (200, normal_id))
        self.assertEqual(self.request("/api/rooms")[1]["last_room"], normal_id)
        with closing(connect_db(self.database)) as connection, connection:
            connection.execute("UPDATE site_preferences SET value=? WHERE key='last_room'", (steward_id,))
            connection.execute("UPDATE room_directory SET destroy_after_days=1")
            now = datetime(2099, 1, 1, tzinfo=timezone.utc)
            self.assertEqual(expired_rooms(connection, now), [normal_id])
        self.assertEqual(self.request("/api/rooms")[1]["last_room"], "")

    def test_project_statistics_and_dispatch_chains_exclude_steward(self):
        normal_id = self.create()[1]["id"]
        steward_id = self.create("steward")[1]["id"]
        for room_id in (normal_id, steward_id):
            status, message = self.request(f"/api/rooms/{room_id}/messages", {
                "author": "用户", "text": "请处理此事", "submission_id": uuid.uuid4().hex,
            }, self.owner)
            self.assertEqual(status, 201, message)
        status, report = self.request("/api/analytics?range=today")
        self.assertEqual(status, 200, report)
        self.assertEqual(report["scope"]["rooms"], 1)
        self.assertEqual(report["overview"]["initiated"], 1)
        status, chains = self.request("/api/analytics/dispatches")
        self.assertEqual(status, 200, chains)
        self.assertEqual([chain["room_id"] for chain in chains["records"]], [normal_id])
        status, deletion = self.request(f"/api/rooms/{steward_id}/delete", {"actor": "用户"}, self.owner)
        self.assertEqual(status, 200, deletion)
        self.assertEqual(self.request("/api/analytics?range=today")[1]["scope"]["sealed_rooms"], 0)

    def test_legacy_directory_gains_empty_system_kind(self):
        ordinary = self.create()[1]["id"]
        with closing(connect_db(self.database)) as connection, connection:
            connection.execute("ALTER TABLE room_directory DROP COLUMN system_kind")
            connection.execute("DELETE FROM room_directory WHERE room_id=?", (ordinary,))
        init_database(self.database, seed=False)
        self.assertEqual(self.request(f"/api/rooms/{ordinary}")[1]["system_kind"], "")

    def test_steward_backup_cannot_be_imported_as_a_project_room(self):
        steward_id = self.create("steward")[1]["id"]
        status, snapshot = self.request(f"/api/rooms/{steward_id}/backup", token=self.owner)
        self.assertEqual(status, 200, snapshot)
        directory, = snapshot["tables"]["room_directory"]
        self.assertEqual(directory["system_kind"], "steward")
        # A copied backup has a new ID, so the existing-room idempotency path cannot mask a downgrade.
        copy_id = uuid.uuid4().hex[:12]
        snapshot["tables"]["rooms"][0]["id"] = directory["room_id"] = copy_id
        status, result = self.request("/api/rooms/import", snapshot, self.owner)
        self.assertEqual(status, 400, result)
        self.assertEqual(result["error_text"]["template"], "不能导入系统房间的备份")
        listed = self.request("/api/rooms")[1]["rooms"]
        self.assertEqual([(room["id"], room["system_kind"]) for room in listed], [(steward_id, "steward")])

    def test_steward_archive_read_only_then_destroy(self):
        owner_token, member_token = uuid.uuid4().hex, uuid.uuid4().hex
        status, room = self.create("steward", owner_token=owner_token, member_token=member_token)
        self.assertEqual(status, 201, room)
        room_id = room["id"]
        base = f"/api/rooms/{room_id}"
        deletion = {"actor": "用户", "archived_steward_only": True}
        self.assertEqual(self.request(base + "/delete", deletion, owner_token)[0], 409)
        project_id = self.create()[1]["id"]
        self.assertEqual(self.request(f"/api/rooms/{project_id}/delete", deletion, self.owner)[0], 409)
        status, posted = self.request(base + "/messages", {
            "author": "用户", "text": "保留的历史对话", "submission_id": uuid.uuid4().hex,
        }, owner_token)
        self.assertEqual(status, 201, posted)

        status, archived = self.request(base + "/archive", {"actor": "用户"}, owner_token)
        self.assertEqual((status, archived["archived"]), (200, True))
        status, view = self.request(base)
        self.assertEqual(status, 200, view)
        self.assertEqual((view["archived"], view["system_kind"]), (True, "steward"))
        self.assertTrue(view["archived_at"].endswith("Z"), view)
        history = self.request(base + "/messages")[1]["messages"]
        self.assertIn("保留的历史对话", [message["text"] for message in history])
        status, rejected = self.request(base + "/messages", {
            "author": "用户", "text": "归档后不应接收", "submission_id": uuid.uuid4().hex,
        }, owner_token)
        self.assertEqual(status, 400, rejected)
        self.assertEqual(self.request(base + "/state", {"text": "不能覆盖存档"}, owner_token)[0], 400)
        self.assertEqual(self.request(base + "/delete", deletion, member_token)[0], 403)

        status, destroyed = self.request(base + "/delete", deletion)
        self.assertEqual(status, 200, destroyed)
        room_ids = {item["id"] for item in self.request("/api/rooms")[1]["rooms"]}
        self.assertNotIn(room_id, room_ids)
        self.assertIn(project_id, room_ids)
        self.assertEqual(self.request(base)[0], 404)


if __name__ == "__main__":
    unittest.main()

"""Verify the site administrator account: registration, sessions, lockout and room takeover."""

import hashlib
import json
import os
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

SETUP_KEY = "install-token-for-tests"
PASSWORD = "correct horse battery"


class AdminTests(unittest.TestCase):
    """Run against an isolated Python instance with a fixed install token."""

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.database = Path(self.directory.name) / "admin.db"
        init_database(self.database, seed=False)
        self.server = DiscussionServer(("127.0.0.1", 0), self.database)
        self.server.local_site = False
        self.server.admin_setup_key = SETUP_KEY
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.directory.cleanup()

    def request(self, path, payload=None, admin="", token="", machine=""):
        """Return status and JSON for successes and rejections alike."""
        headers = {"Content-Type": "application/json"}
        if machine:
            headers["X-Machine-Token"] = machine
        if admin:
            headers["X-Discussion-Admin"] = admin
        if token:
            headers["X-Discussion-Token"] = token
        request = Request(self.base + path, headers=headers, data=json.dumps(payload).encode() if payload is not None else None)
        try:
            response = urlopen(request, timeout=10)
        except HTTPError as error:
            response = error
        with response:
            return response.status, json.load(response)

    def register(self):
        status, result = self.request("/api/admin/register", {"username": "老板", "password": PASSWORD, "setup_key": SETUP_KEY})
        self.assertEqual(status, 201, result)
        return result["token"]

    def sql(self, statement, values=()):
        with closing(sqlite3.connect(self.database)) as connection, connection:
            return connection.execute(statement, values).fetchall()

    def new_room(self, owner):
        payload = {"title": "管理员验证", "host": "Codex", "phase": "initial", "experts": {"Codex": "cli"},
                   "members": [{"name": "Codex", "token": uuid.uuid4().hex, "access": "manual"}],
                   "submission_id": uuid.uuid4().hex}
        status, room = self.request("/api/rooms", payload, token=owner)
        self.assertEqual(status, 201, room)
        return room["id"]

    def test_registration_needs_the_install_token_and_happens_once(self):
        self.assertEqual(self.request("/api/admin")[1], {"registered": False, "setup_available": True, "logged_in": False, "profile": None})
        self.assertEqual(self.request("/api/admin/register", {"username": "a", "password": PASSWORD, "setup_key": "wrong"})[0], 403)
        self.assertEqual(self.request("/api/admin/register", {"username": "a", "password": "short", "setup_key": SETUP_KEY})[0], 400)
        token = self.register()
        status, state = self.request("/api/admin", admin=token)
        self.assertEqual((status, state["registered"], state["logged_in"], state["profile"]["username"]), (200, True, True, "老板"))
        self.assertFalse(self.request("/api/admin")[1]["setup_available"])
        self.assertEqual(self.request("/api/admin/register", {"username": "b", "password": PASSWORD, "setup_key": SETUP_KEY})[0], 409)
        self.assertEqual(self.sql("SELECT COUNT(*) FROM site_admin WHERE password_hash LIKE ?", ("%" + PASSWORD + "%",))[0][0], 0)

    def test_cli_token_registers_once(self):
        token = uuid.uuid4().hex * 2
        self.sql("INSERT INTO admin_setup (id,token_hash,created_at) VALUES (1,?,0)", (hashlib.sha256(token.encode()).hexdigest(),))
        self.assertEqual(self.request("/api/admin/register", {"username": "a", "password": PASSWORD, "setup_key": "wrong"})[0], 403)
        status, result = self.request("/api/admin/register", {"username": "Admin", "password": PASSWORD, "setup_key": f" {token} "})
        self.assertEqual(status, 201, result)
        self.assertEqual(self.sql("SELECT COUNT(*) FROM admin_setup")[0][0], 0)

    def test_login_failures_lock_the_account_and_success_resets_them(self):
        self.register()
        for _ in range(4):
            self.assertEqual(self.request("/api/admin/login", {"username": "老板", "password": "wrong-password"})[0], 401)
        self.assertEqual(self.request("/api/admin/login", {"username": "没有此人", "password": PASSWORD})[0], 401)
        status, locked = self.request("/api/admin/login", {"username": "老板", "password": PASSWORD})
        self.assertEqual(status, 429, locked)
        self.assertEqual(self.sql("SELECT failed_attempts FROM site_admin")[0][0], 0)
        self.sql("UPDATE site_admin SET locked_until=0")
        status, result = self.request("/api/admin/login", {"username": "老板", "password": PASSWORD})
        self.assertEqual(status, 200, result)
        self.assertEqual(self.sql("SELECT failed_attempts FROM site_admin")[0][0], 0)

    def test_sessions_last_until_logout(self):
        first = self.register()
        second = self.request("/api/admin/login", {"username": "老板", "password": PASSWORD})[1]["token"]
        self.sql("UPDATE admin_sessions SET created_at=1")
        self.assertTrue(self.request("/api/admin", admin=first)[1]["logged_in"])
        self.assertEqual(self.request("/api/admin/logout", {}, admin=first)[0], 200)
        self.assertFalse(self.request("/api/admin", admin=first)[1]["logged_in"])
        self.assertTrue(self.request("/api/admin", admin=second)[1]["logged_in"])
        self.assertEqual(self.request("/api/admin/logout", {})[0], 200)

    def test_profile_is_public_and_needs_a_session(self):
        admin = self.register()
        avatar = "data:image/png;base64,AAAA"
        status, result = self.request("/api/admin/profile", {"username": "船长", "avatar": avatar}, admin=admin)
        self.assertEqual((status, result["profile"]), (200, {"username": "船长", "avatar": avatar}))
        self.assertEqual(self.request("/api/admin/profile", {"avatar": "http://x/y.png"}, admin=admin)[0], 400)
        self.assertEqual(self.request("/api/admin/profile", {"username": "x"})[0], 401)
        self.assertEqual(self.request("/api/admin")[1]["profile"], {"username": "船长", "avatar": avatar})

    def test_session_manages_rooms_without_credential(self):
        admin = self.register()
        owner = uuid.uuid4().hex
        room = self.new_room(owner)
        path = f"/api/rooms/{room}"
        self.assertEqual(self.request(path + "/archive", {"actor": "用户"})[0], 403)
        self.assertEqual(self.request(path + "/archive", {"actor": "用户"}, admin="0" * 64)[0], 403)
        self.assertEqual(self.request(path + "/archive", {"actor": "用户"}, admin=admin)[0], 200)
        self.assertEqual(self.request(path + "/restore", {"actor": "用户"}, admin=admin)[0], 200)
        self.assertEqual(self.request(path + "/delete", {"actor": "用户", "confirm_title": "错误"}, admin=admin)[0], 400)
        self.assertEqual(self.request(path + "/delete", {"actor": "Antigravity", "confirm_title": "管理员验证"}, admin=admin)[0], 400)
        self.assertEqual(self.request(path + "/delete", {"actor": "用户", "confirm_title": "管理员验证"}, admin=admin)[0], 200)
        self.assertEqual(self.request(path)[0], 404)

    def test_session_writes_as_room_owner_without_credential(self):
        admin = self.register()
        room = self.new_room(uuid.uuid4().hex)
        message = {"author": "用户", "text": "平板上的发言", "submission_id": uuid.uuid4().hex}
        path = f"/api/rooms/{room}/messages"
        self.assertEqual(self.request(path, message)[0], 403)
        self.assertEqual(self.request(path, message, admin="0" * 64)[0], 403)
        status, result = self.request(path, message, admin=admin)
        self.assertEqual(status, 201, result)
        # A supplied credential is never replaced, so a member cannot borrow the session to speak as the owner.
        self.assertEqual(self.request(path, {**message, "submission_id": uuid.uuid4().hex}, admin=admin, token=uuid.uuid4().hex)[0], 403)

    def test_local_site_needs_no_account_and_keeps_a_profile(self):
        self.server.local_site = True
        self.assertEqual(self.request("/api/admin")[1], {"local": True, "registered": True, "setup_available": False,
                                                          "logged_in": True, "profile": None})
        self.assertEqual(self.request("/api/admin/register", {"username": "a", "password": PASSWORD, "setup_key": SETUP_KEY})[0], 400)
        self.assertEqual(self.request("/api/admin/login", {"username": "User", "password": "!"})[0], 400)
        self.assertEqual(self.request("/api/admin/profile", {"username": "船长"})[1]["profile"]["username"], "船长")
        self.assertEqual(self.request("/api/admin")[1]["profile"]["username"], "船长")
        room = self.new_room(uuid.uuid4().hex)
        # A visitor of the local site speaks as the owner without the room credential, as an administrator does.
        message = {"author": "用户", "text": "本机网页的发言", "submission_id": uuid.uuid4().hex}
        self.assertEqual(self.request(f"/api/rooms/{room}/messages", message)[0], 201)
        self.assertEqual(self.request(f"/api/rooms/{room}/messages", {**message, "submission_id": uuid.uuid4().hex}, token=uuid.uuid4().hex)[0], 403)
        # The room last opened is kept by the site, so another device opens it next; a missing room is refused.
        self.assertEqual(self.request("/api/rooms")[1]["last_room"], "")
        self.assertEqual(self.request("/api/rooms/last", {"room_id": room})[0], 200)
        self.assertEqual(self.request("/api/rooms")[1]["last_room"], room)
        self.assertEqual(self.request("/api/rooms/last", {"room_id": "missing"})[0], 404)
        self.server.local_site = False
        self.assertEqual(self.request("/api/rooms/last", {"room_id": room})[0], 403, "a visitor who is not the manager cannot move it")
        self.server.local_site = True
        self.assertEqual(self.request(f"/api/rooms/{room}/archive", {"actor": "用户"})[0], 200)
        self.assertEqual(self.request(f"/api/rooms/{room}/delete", {"actor": "用户", "confirm_title": "管理员验证"})[0], 200)


    def test_remote_launch_reaches_only_the_paired_computer(self):
        machine_id, machine_token = uuid.uuid4().hex, uuid.uuid4().hex * 2
        pairing = {"id": machine_id, "name": "工作站", "token": machine_token}
        self.assertEqual(self.request("/api/machines")[0], 401)
        self.assertEqual(self.request("/api/machines", pairing)[0], 401)
        admin = self.register()
        self.assertEqual(self.request("/api/machines", pairing, admin=admin)[0], 200)
        sync = f"/api/machines/{machine_id}/sync"
        state = {"projects": [{"id": "abcdef12", "name": "演示"}], "clients": {"Claude": "claude"}}
        self.assertEqual(self.request(sync, state, machine="0" * 64)[0], 401)
        self.assertEqual(self.request(sync, state, machine=machine_token), (200, {"launches": []}))
        machines = self.request("/api/machines", admin=admin)[1]["machines"]
        self.assertEqual((machines[0]["projects"], machines[0]["clients"], machines[0]["online"]), (state["projects"], state["clients"], True))
        self.assertNotIn("token_hash", machines[0])

        request = {"site": "https://example.test", "entry": "web", "token": "room-credential", "local_project": "abcdef12",
                   "room": {"title": "远程建房", "mode": "free", "members": [], "submission_id": "launch-1"}}
        submit = lambda body: self.request("/api/remote-launches", {"id": "launch-1", "machine_id": machine_id, "request": body}, admin=admin)
        self.assertEqual(self.request("/api/remote-launches", {"id": "launch-1", "machine_id": machine_id, "request": request})[0], 401)
        self.assertEqual(submit({**request, "cwd": "D:\project"})[0], 400)
        self.assertEqual(submit({**request, "local_project": "deadbeef"})[0], 409)
        self.assertEqual(submit(request)[1]["status"], "pending")
        launches = self.request(sync, state, machine=machine_token)[1]["launches"]
        self.assertEqual(launches, [{"id": "launch-1", "request": request}])
        action = f"/api/machines/{machine_id}/launches/launch-1"
        self.assertEqual(self.request(action, {"action": "claim"}, machine=machine_token)[1]["status"], "claimed")
        self.assertEqual(submit(request)[1]["status"], "claimed")
        done = self.request(action, {"action": "finish", "room_id": "room-1", "status": "free"}, machine=machine_token)[1]
        self.assertEqual((done["status"], done["result"]), ("done", {"room_id": "room-1", "status": "free"}))
        self.assertEqual(self.request(action, {"action": "fail", "error": "late"}, machine=machine_token)[0], 409)
        self.assertEqual(self.request("/api/remote-launches/launch-1", admin=admin)[1]["status"], "done")
        self.assertEqual(self.sql("SELECT request FROM remote_launches WHERE id='launch-1'"), [("{}",)])

        failing = {**request, "room": {**request["room"], "submission_id": "launch-2"}}
        self.request("/api/remote-launches", {"id": "launch-2", "machine_id": machine_id, "request": failing}, admin=admin)
        failure = self.request(f"/api/machines/{machine_id}/launches/launch-2", {"action": "fail", "error": "Claude 未配置", "stage": "not_started"},
                               machine=machine_token)[1]
        self.assertEqual((failure["status"], failure["error"], failure["result"]), ("failed", "Claude 未配置", {"stage": "not_started"}))
        retried = self.request("/api/remote-launches", {"id": "launch-2", "machine_id": machine_id, "request": failing}, admin=admin)[1]
        self.assertEqual((retried["status"], retried["error"]), ("pending", ""))

    def test_machine_commands_carry_only_ciphertext_to_the_paired_computer(self):
        machine_id, machine_token = uuid.uuid4().hex, uuid.uuid4().hex * 2
        admin = self.register()
        self.request("/api/machines", {"id": machine_id, "name": "工作站", "token": machine_token}, admin=admin)
        commands = f"/api/machines/{machine_id}/commands"
        key = {"kty": "EC", "crv": "P-256", "x": "A" * 43, "y": "B" * 43}
        envelope = {"key": key, "iv": "C" * 16, "data": "ZGF0YQ=="}
        command = {"id": "command-0000000001", "envelope": envelope}
        self.assertEqual(self.request(commands, command)[0], 401)
        self.assertEqual(self.request(commands, command, admin=admin)[0], 409, "a computer without a published key cannot take commands")
        state = {"projects": [], "clients": {}}
        self.assertEqual(self.request(f"/api/machines/{machine_id}/sync", {**state, "public_key": {**key, "x": "short"}}, machine=machine_token)[0], 400)
        self.request(f"/api/machines/{machine_id}/sync", {**state, "public_key": key}, machine=machine_token)
        self.assertEqual(self.request("/api/machines", admin=admin)[1]["machines"][0]["public_key"], key)
        self.assertEqual(self.request(commands, {**command, "envelope": {**envelope, "data": "not base64!"}}, admin=admin)[0], 400)
        self.assertEqual(self.request(commands, command, admin=admin), (200, {"id": "command-0000000001", "status": "pending"}))
        self.assertEqual(self.request(commands, command, admin=admin)[0], 409)

        claim = f"{commands}/claim"
        self.assertEqual(self.request(claim, {"wait": 0}, machine="0" * 64)[0], 401)
        self.assertEqual(self.request(claim, {"wait": 0}, machine=machine_token)[1], {"commands": [{"id": "command-0000000001", "envelope": envelope}]})
        self.assertEqual(self.sql("SELECT request FROM machine_commands"), [("{}",)])
        self.assertEqual(self.request(claim, {"wait": 0}, machine=machine_token)[1], {"commands": []})
        self.assertEqual(self.request(f"{commands}/command-0000000001", admin=admin)[1]["status"], "claimed")
        answer = {"envelope": {"iv": "D" * 16, "data": "YW5zd2Vy"}}
        self.assertEqual(self.request(f"{commands}/command-0000000001", answer, machine=machine_token)[1]["status"], "done")
        self.assertEqual(self.request(f"{commands}/command-0000000001", answer, machine=machine_token)[0], 409)
        self.assertEqual(self.request(f"{commands}/command-0000000001", admin=admin)[1], {"id": "command-0000000001", "status": "done", "response": answer["envelope"]})
        self.assertEqual(self.request(f"{commands}/command-0000000001", admin=admin)[0], 404, "a response is handed over once")

        self.request(commands, {**command, "id": "command-0000000002"}, admin=admin)
        self.sql("UPDATE machine_commands SET created_at=0")
        self.assertEqual(self.request(claim, {"wait": 0}, machine=machine_token)[1], {"commands": []}, "an expired command is never run")


class RemoteEntryTests(unittest.TestCase):
    """A tunnel reaches the remote entry from this computer, so loopback must not make its visitors the administrator."""

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.database = Path(self.directory.name) / "remote.db"
        init_database(self.database, seed=False)
        self.local = DiscussionServer(("127.0.0.1", 0), self.database, local_launch=True)
        self.remote = DiscussionServer(("127.0.0.1", 0), self.database, hub=self.local)
        self.remote.admin_setup_key = SETUP_KEY
        self.threads = [threading.Thread(target=server.serve_forever, daemon=True) for server in (self.local, self.remote)]
        for thread in self.threads:
            thread.start()

    def tearDown(self):
        for server in (self.remote, self.local):
            server.shutdown()
            server.server_close()
        for thread in self.threads:
            thread.join()
        self.directory.cleanup()

    def request(self, server, path, payload=None, admin=""):
        """Return status and JSON from one entry."""
        headers = {"Content-Type": "application/json", **({"X-Discussion-Admin": admin} if admin else {})}
        request = Request(f"http://127.0.0.1:{server.server_port}{path}", headers=headers,
                          data=json.dumps(payload).encode() if payload is not None else None)
        try:
            response = urlopen(request, timeout=10)
        except HTTPError as error:
            response = error
        with response:
            return response.status, json.load(response)

    def test_remote_entry_needs_login_and_never_offers_local_launch(self):
        self.assertTrue(self.request(self.local, "/api/admin")[1]["local"])
        self.assertNotIn("local", self.request(self.remote, "/api/admin")[1])
        self.assertEqual(self.request(self.local, "/api/machines")[0], 200)
        self.assertEqual(self.request(self.remote, "/api/machines")[0], 401)
        self.assertEqual(self.request(self.remote, "/api/local/settings")[0], 404)
        status, result = self.request(self.remote, "/api/admin/register",
                                      {"username": "老板", "password": PASSWORD, "setup_key": SETUP_KEY})
        self.assertEqual(status, 201, result)
        self.assertEqual(self.request(self.remote, "/api/machines", admin=result["token"])[0], 200)

    def test_remote_entry_streams_changes_written_on_the_local_entry(self):
        with urlopen(f"http://127.0.0.1:{self.remote.server_port}/api/updates", timeout=3) as stream:
            for line in (b"retry: 3000\n", b"event: ready\n", b"data: {}\n", b"\n"):
                self.assertEqual(stream.readline(), line)
            self.assertEqual(self.request(self.local, "/api/folders", {"name": "外出"})[0], 201)
            self.assertEqual(stream.readline(), b"event: change\n")


class RelayBridgeTests(unittest.TestCase):
    """The runner relays a paired device as the administrator only with this site's bridge credential, on room routes."""

    SITE = "https://site.test"
    BRIDGE = "be" * 32

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        home = Path(self.directory.name)
        (home / "site-connections.json").write_text(json.dumps({"sites": {self.SITE: {
            "token_hash": "a" * 64, "bridge_hash": hashlib.sha256(self.BRIDGE.encode()).hexdigest()}}}), encoding="utf-8")
        self.database = home / "bridge.db"
        init_database(self.database, seed=False)
        previous = os.environ.get("DISCUSS_SERVICE_HOME")
        os.environ["DISCUSS_SERVICE_HOME"] = str(home)
        try:
            self.server = DiscussionServer(("127.0.0.1", 0), self.database)
        finally:
            os.environ.pop("DISCUSS_SERVICE_HOME") if previous is None else os.environ.__setitem__("DISCUSS_SERVICE_HOME", previous)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.directory.cleanup()

    def request(self, path, payload=None, bridge=None, site=SITE, token=""):
        headers = {"Content-Type": "application/json"}
        if bridge is not None:
            headers.update({"X-CoDiscuss-Bridge": bridge, "X-CoDiscuss-Bridge-Site": site})
        if token:
            headers["X-Discussion-Token"] = token
        request = Request(self.base + path, headers=headers, data=json.dumps(payload).encode() if payload is not None else None)
        try:
            response = urlopen(request, timeout=10)
        except HTTPError as error:
            response = error
        with response:
            return response.status, json.load(response)

    def test_bridge_writes_as_owner_only_with_a_valid_credential_on_room_routes(self):
        owner = "owner-credential" * 3
        status, room = self.request("/api/rooms", {"title": "外出", "goal": "x", "mode": "free", "submission_id": "bridge-room",
                                                   "members": [{"name": "Codex", "token": uuid.uuid4().hex, "access": "manual"}]}, token=owner)
        self.assertEqual(status, 201, room)
        message = {"author": "用户", "text": "手机上发的", "submission_id": "bridge-message"}
        path = f"/api/rooms/{room['id']}/messages"
        local = {**message, "submission_id": "local-message"}
        self.assertEqual(self.request(path, local)[0], 201, "a visitor of the local site writes as the owner")
        self.assertEqual(self.request(path, message, bridge="ef" * 32)[0], 403)
        self.assertEqual(self.request(path, message, bridge=self.BRIDGE, site="https://other.test")[0], 403)
        self.assertEqual(self.request(path, message, bridge="not-hex")[0], 403)
        status, saved = self.request(path, message, bridge=self.BRIDGE)
        self.assertEqual(status, 201, saved)
        self.assertEqual(self.request(path, message, bridge=self.BRIDGE)[0], 200, "a retry with the same submission is deduplicated")
        self.assertEqual(self.request("/api/local/settings", bridge=self.BRIDGE)[0], 403, "the bridge never reaches local launch")
        self.assertEqual(self.request("/api/machines", bridge=self.BRIDGE)[0], 403)
        self.assertEqual(self.request("/api/revisions", bridge=self.BRIDGE)[0], 200)
        # A file relayed from a device arrives as raw bytes, as a browser upload would.
        upload = Request(f"{self.base}/api/rooms/{room['id']}/attachments?file_name=a.txt&actor=%E7%94%A8%E6%88%B7&submission_id=bridge-file",
                         data=b"from phone", headers={"Content-Type": "application/octet-stream", "X-CoDiscuss-Bridge": self.BRIDGE,
                                                    "X-CoDiscuss-Bridge-Site": self.SITE})
        with urlopen(upload, timeout=10) as response:
            self.assertEqual(json.load(response)["attachment"]["size"], 10)


if __name__ == "__main__":
    unittest.main()

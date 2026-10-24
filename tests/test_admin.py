"""Verify the site administrator account: registration, sessions, lockout and room takeover."""

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

    def request(self, path, payload=None, admin="", token=""):
        """Return status and JSON for successes and rejections alike."""
        headers = {"Content-Type": "application/json"}
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
        self.assertEqual(self.request(path + "/delete", {"actor": "Gemini", "confirm_title": "管理员验证"}, admin=admin)[0], 400)
        self.assertEqual(self.request(path + "/delete", {"actor": "用户", "confirm_title": "管理员验证"}, admin=admin)[0], 200)
        self.assertEqual(self.request(path)[0], 404)

    def test_local_site_needs_no_account_and_keeps_a_profile(self):
        self.server.local_site = True
        self.assertEqual(self.request("/api/admin")[1], {"local": True, "registered": True, "setup_available": False,
                                                          "logged_in": True, "profile": None})
        self.assertEqual(self.request("/api/admin/register", {"username": "a", "password": PASSWORD, "setup_key": SETUP_KEY})[0], 400)
        self.assertEqual(self.request("/api/admin/login", {"username": "User", "password": "!"})[0], 400)
        self.assertEqual(self.request("/api/admin/profile", {"username": "船长"})[1]["profile"]["username"], "船长")
        self.assertEqual(self.request("/api/admin")[1]["profile"]["username"], "船长")
        room = self.new_room(uuid.uuid4().hex)
        self.assertEqual(self.request(f"/api/rooms/{room}/archive", {"actor": "用户"})[0], 200)
        self.assertEqual(self.request(f"/api/rooms/{room}/delete", {"actor": "用户", "confirm_title": "管理员验证"})[0], 200)


if __name__ == "__main__":
    unittest.main()

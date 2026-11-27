"""Exercise browser guest access against an isolated Python room server."""
import json
import tempfile
import threading
import unittest
from contextlib import closing
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from backend.entry_guard import EntryPolicy
from backend.runtime import token_hash
from backend.server import DiscussionServer, connect_db, init_database
from test_external_members import server_routes


class GuestBackendTests(unittest.TestCase):
    """Test the guest contract through HTTP with no real room or runner."""

    owner = "owner-test-credential-0000000000000000"
    guest = "guest-test-credential-0000000000000000"
    member = "member-test-credential-0000000000000000"

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.database = Path(directory.name) / "room.sqlite3"
        init_database(self.database, seed=False)
        self.server = DiscussionServer(("127.0.0.1", 0), self.database)
        self.server.local_site = True
        self.server.entry_policy = EntryPolicy("")
        self.addCleanup(self.server.server_close)
        worker = threading.Thread(target=self.server.serve_forever, daemon=True)
        worker.start()
        self.addCleanup(worker.join)
        self.addCleanup(self.server.shutdown)
        self.base = f"http://127.0.0.1:{self.server.server_port}"
        self.room = "guest-test-room"
        self.owner_route = f"/api/rooms/{self.room}/guest"
        self.guest_route = f"/api/external/rooms/{self.room}/guest"
        with closing(connect_db(self.database)) as db, db:
            db.execute("INSERT INTO rooms(id,title,goal,created_at) VALUES (?,'Guest room','Testing','2026-01-01')",
                       (self.room,))
            db.execute("INSERT INTO room_modes(room_id,mode,control_hash) VALUES (?,'free',?) "
                       "ON CONFLICT(room_id) DO UPDATE SET control_hash=excluded.control_hash", (self.room, token_hash(self.owner)))
            self.member_id = db.execute("""INSERT INTO room_members(room_id,name,role,token_hash,created_at)
                VALUES (?,'Codex','host',?,'2026-01-01')""", (self.room, token_hash(self.member))).lastrowid

    def request(self, path, body=None, token=None, method=None):
        """Return the HTTP status and decoded JSON, including errors."""
        headers = {"Content-Type": "application/json"}
        if token is not None:
            headers["X-Discussion-Token"] = token
        request = Request(self.base + path, data=json.dumps(body).encode() if body is not None else None,
                          headers=headers, method=method)
        try:
            response = urlopen(request, timeout=5)
        except HTTPError as failure:
            response = failure
        with response:
            content = response.read()
            return response.status, json.loads(content) if content else {}

    def invite(self, **settings):
        """Register and redeem one link, leaving the visit waiting."""
        revision = self.request(self.owner_route, token=self.owner)[1]["data"]["revision"]
        invite_id, guest_id = "invite-test-01", "guest-test-01"
        status, body = self.request(self.owner_route + "/invite",
                                    {"revision": revision, "invite_id": invite_id, **settings}, self.owner)
        self.assertEqual(status, 200, body)
        status, body = self.request(self.owner_route + "/redeem", {
            "invite_id": invite_id, "guest_id": guest_id, "key_id": "key-test-01", "token_hash": token_hash(self.guest),
        }, self.owner)
        self.assertEqual(status, 200, body)
        self.assertTrue(body["data"]["state"]["hold_dispatch"])
        return guest_id

    def activate(self, guest_id):
        """Ask the local backend to enter after the runner's confirmation."""
        status, body = self.request(self.owner_route + "/activate", {"guest_id": guest_id}, self.owner)
        self.assertEqual(status, 200, body)
        return body["data"]["state"]

    def test_visit_authorization_and_lifecycle(self):
        """Exercise the allowlist, origin, cancellations and expired credentials."""
        guest_id = self.invite()
        self.assertEqual(self.request(self.guest_route + "/session", token=self.guest)[1]["data"]["phase"], "waiting")
        self.assertEqual(self.request(self.guest_route + "/messages", token=self.guest)[0], 409)
        held = {"member_id": self.member_id, "client_id": "held-request"}
        self.assertEqual(self.request(f"/api/rooms/{self.room}/executions", held, self.owner)[1]["code"], "guest_waiting")
        state = self.activate(guest_id)
        self.assertEqual(state["mode"], "conservative")

        for path in ("/", "/robots.txt", "/api/health", "/api/rooms", "/api/updates", "/api/local/guest-invite",
                     "/api/admin", self.owner_route, f"/r/{self.room}", f"/api/rooms/{self.room}/messages",
                     f"/api/rooms/{self.room}/events", f"/api/external/rooms/{self.room}/view",
                     "/api/external/rooms/other/guest/session", self.guest_route + "/session/extra",
                     self.guest_route + "/private", self.guest_route + "/files/content"):
            for method in ("GET", "POST", "HEAD", "OPTIONS", "PUT", "DELETE", "PATCH"):
                with self.subTest(path=path, method=method):
                    self.assertEqual(self.request(path, token=self.guest, method=method)[0], 403)

        for route in ("/session", "/room", "/executions", "/messages"):
            with self.subTest(route=route):
                self.assertEqual(self.request(self.guest_route + route, token=self.guest)[0], 200)
        for route in ("/api/rooms", "/api/rooms/other/messages", "/r/other"):
            self.assertEqual(self.request(route, token=self.member)[0], 403)

        text = {"text": "Deployment question", "mentions": ["Codex"], "submission_id": "guest-message-1"}
        path = self.guest_route + "/messages"
        status, body = self.request(path, text, self.guest)
        self.assertEqual(status, 200, body)
        message = body["data"]["message"]
        self.assertEqual(message["origin"]["guest_id"], guest_id)
        self.assertEqual(self.request(path, text, self.guest)[1]["data"]["message"]["id"], message["id"])
        self.assertEqual(self.request(path, {**text, "text": "different"}, self.guest)[0], 409)
        status, execution = self.request(f"/api/rooms/{self.room}/executions", held, self.owner)
        self.assertEqual(status, 200, execution)
        self.assertEqual(execution["requests"][0]["origin"]["root_message_id"], message["id"])
        self.assertEqual(self.request(f"{path}/{message['id']}/withdraw", {}, self.guest)[0], 409)
        self.request(path, {**text, "submission_id": "guest-message-2"}, self.guest)
        disconnected = self.request(self.owner_route + "/disconnect", {"guest_id": guest_id}, self.member)
        self.assertEqual(disconnected[0], 200, disconnected)
        self.assertEqual(disconnected[1]["data"]["stopped_execution_ids"], [])
        running = self.request(f"/api/rooms/{self.room}/executions/{execution['id']}", token=self.owner)[1]
        self.assertEqual(running["status"], "dispatched")
        ended_status, ended = self.request(self.guest_route + "/session", token=self.guest)
        self.assertEqual((ended_status, ended["reason"], ended["disconnected_by"]), (403, "disconnected_by_host", "host"))
        self.assertEqual(self.request("/api/health", token=self.guest)[0], 403)

    def test_owner_controls_and_project_grant(self):
        """Exercise explicit write revisions and runner-only audited file grants."""
        guest_id = self.invite(scope="project")
        state = self.activate(guest_id)
        payload = {"revision": state["revision"], "mode": "trust"}
        self.assertEqual(self.request(self.owner_route + "/protection", payload, self.member)[0], 403)
        result = self.request(self.owner_route + "/protection", payload, self.owner)
        self.assertEqual(result[1]["data"]["state"]["mode"], "trust")
        self.assertEqual(self.request(self.owner_route + "/protection", payload, self.owner)[1]["code"], "stale_revision")
        updated = result[1]["data"]["state"]
        extension = {"revision": updated["revision"], "duration_seconds": 1200}
        result = self.request(self.owner_route + "/extend", extension, self.owner)
        self.assertEqual(result[1]["data"]["state"]["guest"]["expires_at"], updated["guest"]["joined_at"] + 1_200_000)
        payload = {"guest_id": guest_id, "root": None, "path": "", "action": "roots", "outcome": "check"}
        self.assertEqual(self.request(self.owner_route + "/file-read", payload, self.member)[0], 403)
        self.assertEqual(self.request(self.owner_route + "/file-read", payload, self.owner)[0], 200)
        self.assertEqual(self.request(self.owner_route + "/file-read", {**payload, "outcome": "served"}, self.owner)[0], 200)

    def test_guest_credential_is_rejected_across_server_route_inventory(self):
        """Verify every existing route outside the guest API is denied before dispatch."""
        self.activate(self.invite())
        routes = {path.replace("ROOM", self.room) for path in server_routes()}
        self.assertGreater(len(routes), 300)
        for path in sorted(routes):
            self.assertEqual(self.request(path, token=self.guest)[0], 403, path)
            self.assertEqual(self.request(path, {}, self.guest)[0], 403, path)

    def test_expiry_preserves_live_execution(self):
        """Expired credentials are denied before a runner can notify the relay."""
        guest_id = self.invite(private_chat=True)
        self.activate(guest_id)
        text = {"text": "Please review", "mentions": ["Codex"], "submission_id": "guest-message-1"}
        self.assertEqual(self.request(self.guest_route + "/messages", text, self.guest)[0], 200)
        execution = self.request(f"/api/rooms/{self.room}/executions",
                                 {"member_id": self.member_id, "client_id": "expiry-request"}, self.owner)[1]
        self.assertEqual(self.request(self.guest_route + "/private", token=self.guest)[0], 200)
        with closing(connect_db(self.database)) as db, db:
            db.execute("UPDATE room_guest_visits SET expires_at=1 WHERE guest_id=?", (guest_id,))
        response = self.request(self.guest_route + "/session", token=self.guest)
        self.assertEqual((response[0], response[1]["reason"]), (403, "expired"))
        with closing(connect_db(self.database)) as db, db:
            self.assertEqual(db.execute("SELECT status FROM member_executions WHERE id=?", (execution["id"],)).fetchone()[0],
                             "dispatched")


if __name__ == "__main__":
    unittest.main()


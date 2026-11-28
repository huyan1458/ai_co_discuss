"""Exercise share management, anonymous redemption and its local audit records."""

import hashlib
import json
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from datetime import datetime, timedelta
from http.client import HTTPConnection
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from backend.admin import verify_password
from backend.runtime import token_hash
from backend.server import DiscussionServer, connect_db, init_database


class CloudShareTests(unittest.TestCase):
    """Run a real local room backend with isolated SQLite state and a storage stub."""

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.database = Path(directory.name) / "rooms.sqlite"
        init_database(self.database, seed=False)
        self.server = DiscussionServer(("127.0.0.1", 0), self.database)
        self.server.daemon_threads = False
        self.server.connections_file = Path(directory.name) / "site-connections.json"
        self.server.connections_file.write_text(json.dumps({
            "sites": {"https://pages.test": {"machine_id": "a" * 32}},
        }), encoding="utf-8")
        thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": .02}, daemon=True)
        thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(thread.join)
        self.addCleanup(self.server.shutdown)
        self.owner = "d" * 32
        self.member = "e" * 32
        self.room = "share-test"
        with closing(connect_db(self.database)) as connection, connection:
            connection.execute("INSERT INTO rooms(id,title,goal,created_at) VALUES (?,'Cloud shares','Tests','2026-01-01')", (self.room,))
            connection.execute("INSERT INTO room_modes(room_id,mode,control_hash) VALUES (?,'free',?) "
                               "ON CONFLICT(room_id) DO UPDATE SET control_hash=excluded.control_hash",
                               (self.room, token_hash(self.owner)))
            connection.execute("INSERT INTO room_members(room_id,name,token_hash,created_at) VALUES (?,'Codex',?,'2026-01-01')",
                               (self.room, token_hash(self.member)))
            self.file_id = "b" * 32
            connection.execute("""INSERT INTO cloud_files (id,room_id,source_kind,source_ref,file_name,content_type,size,
                object_name,submission_id,actor,created_at,stored_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                               (self.file_id, self.room, "project_file", "0:file.txt", "file.txt", "text/plain", 7,
                                "codiscuss/cloud/file/file.txt", "sample", "user", "created", "stored"))
        self.path = f"/api/rooms/cloud-attachments/{self.file_id}/shares"

    def request(self, path, body=None, headers=None):
        """Make a request without following an anonymous redirect to the storage."""
        with closing(HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)) as connection:
            request_headers = {"Content-Type": "application/json", **(headers or {})}
            connection.request("GET" if body is None else "POST", path,
                               None if body is None else json.dumps(body), request_headers)
            with connection.getresponse() as response:
                data = response.read()
                content_type = response.headers.get("Content-Type", "")
                value = json.loads(data) if data and content_type.startswith("application/json") else data.decode("utf-8")
                return response.status, dict(response.headers), value

    def share(self, protected=False):
        status, _, response = self.request(self.path, {"code": True} if protected else {})
        self.assertEqual(status, 201, response)
        return response["share"]

    @staticmethod
    def redeem_path(share):
        return "/_cloud-share/" + share["url"].rsplit("/", 1)[1]

    def test_owner_scope_and_expiration_rules(self):
        self.server.local_site = False
        self.assertEqual(self.request(self.path, {})[0], 403)
        path = f"{self.path}?room={self.room}"
        headers = {"X-Discussion-Token": self.owner}
        self.assertEqual(self.request(path, {}, {"X-Discussion-Token": self.member})[0], 403)
        for days in (0, 31, "7", True):
            self.assertEqual(self.request(path, {"days": days}, headers)[0], 400)
        status, _, result = self.request(path, {"days": 30}, headers)
        self.assertEqual(status, 201, result)
        share = result["share"]
        self.assertEqual(datetime.fromisoformat(share["expires_at"]) - datetime.fromisoformat(share["created_at"]),
                         timedelta(days=30))
        with closing(connect_db(self.database)) as connection, connection:
            connection.execute("UPDATE cloud_files SET purpose='inbound'")
        self.assertEqual(self.request(path, {}, headers)[0], 409)
        self.assertEqual(self.request(path, headers=headers)[2]["shares"][0]["status"], "unavailable")

    def test_only_creation_reveals_token_and_public_redeem_is_audited(self):
        share = self.share()
        token = share["url"].rsplit("/", 1)[1]
        self.assertEqual(share["url"], f"https://pages.test/api/cloud-share/{'a' * 32}/{token}")
        self.assertEqual(datetime.fromisoformat(share["expires_at"]) - datetime.fromisoformat(share["created_at"]),
                         timedelta(days=7))
        listed = self.request(self.path)[2]["shares"]
        self.assertEqual(listed, [{key: value for key, value in share.items() if key != "url"}])
        path = self.redeem_path(share)
        with patch("backend.server.stored_object_download", return_value={"url": "https://cos.test/new"}) as signer:
            status, headers, _ = self.request(path)
            self.assertEqual(status, 302)
            self.assertEqual(headers["Location"], "https://cos.test/new")
            self.assertEqual(headers["Referrer-Policy"], "no-referrer")
            self.assertEqual(headers["Cache-Control"], "no-store")
            endpoint = f"{self.path}/{share['id']}/revoke"
            revoked = self.request(endpoint, {})[2]["share"]
            self.assertEqual(self.request(endpoint, {})[2]["share"], revoked)
            self.assertEqual(revoked["status"], "revoked")
            self.assertEqual(self.request(path)[0], 404)
            signer.assert_called_once()
        with closing(connect_db(self.database)) as connection:
            digest = connection.execute("SELECT token_hash FROM cloud_shares").fetchone()[0]
            self.assertEqual(digest, hashlib.sha256(token.encode()).hexdigest())
            audit = connection.execute("SELECT share_id, status FROM cloud_share_events ORDER BY id").fetchall()
            self.assertEqual([tuple(row) for row in audit], [(share["id"], 302), (share["id"], 404)])

    def test_unknown_token_does_not_wait_for_writer_or_create_audit_row(self):
        self.share()
        with closing(connect_db(self.database)) as writer, writer:
            writer.execute("BEGIN IMMEDIATE")
            status, _, _ = self.request("/_cloud-share/" + "0" * 64)
            self.assertEqual(status, 404)
            self.assertEqual(writer.execute("SELECT COUNT(*) FROM cloud_share_events").fetchone()[0], 0)

    def test_access_code_is_shown_once_and_correct_code_resets_attempts(self):
        self.assertEqual(self.request(self.path, {"code": "true"})[0], 400)
        share = self.share(protected=True)
        code, path = share["code"], self.redeem_path(share)
        self.assertRegex(code, r"^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$")
        self.assertNotIn("code", self.request(self.path)[2]["shares"][0])
        with closing(connect_db(self.database)) as connection:
            stored = connection.execute("SELECT code_hash FROM cloud_shares").fetchone()[0]
            self.assertNotEqual(stored, code)
            self.assertTrue(verify_password(code, stored))
        with patch("backend.server.stored_object_download", return_value={"url": "https://cos.test/download"}) as signer:
            status, headers, page = self.request(path, headers={"Accept-Language": "en-US"})
            self.assertEqual(status, 200)
            self.assertIn("Enter the access code", page)
            self.assertIn("no-store", headers["Cache-Control"])
            self.assertIn("form-action 'none'", headers["Content-Security-Policy"])
            self.assertEqual(self.request(path + "/0000")[0], 403)
            signer.assert_not_called()
            self.assertEqual(self.request(path + "/" + code.lower())[0], 302)
            signer.assert_called_once()
        with closing(connect_db(self.database)) as connection:
            state = connection.execute("SELECT failed_attempts, locked_until FROM cloud_shares").fetchone()
            self.assertEqual(tuple(state), (0, None))
            events = connection.execute("SELECT status FROM cloud_share_events ORDER BY id").fetchall()
            self.assertEqual([event[0] for event in events], [200, 403, 302])

    def test_five_incorrect_codes_lock_only_that_share_for_ten_minutes(self):
        clock = [1730000000]
        with patch("backend.cloud_shares.time", new=SimpleNamespace(time=lambda: clock[0])), \
                patch("backend.server.stored_object_download", return_value={"url": "https://cos.test/download"}) as signer:
            share = self.share(protected=True)
            path = self.redeem_path(share)
            with ThreadPoolExecutor(max_workers=5) as attempts:
                responses = [attempts.submit(self.request, path + "/0000") for _ in range(5)]
                self.assertEqual(sorted(response.result()[0] for response in responses), [403, 403, 403, 403, 429])
            status, _, page = self.request(path)
            self.assertEqual(status, 429)
            self.assertIn("分享已暂时锁定", page)
            self.assertNotIn("<form", page)
            other = self.share(protected=True)
            self.assertEqual(self.request(self.redeem_path(other) + "/" + other["code"])[0], 302)
            clock[0] += 599
            self.assertEqual(self.request(path + "/" + share["code"])[0], 429)
            clock[0] += 1
            self.assertEqual(self.request(path + "/" + share["code"])[0], 302)
            self.assertEqual(signer.call_count, 2)

    def test_older_share_schema_keeps_plain_links_and_upgrades_on_creation(self):
        old_share = self.share()
        with closing(connect_db(self.database)) as connection, connection:
            for column in ("code_hash", "failed_attempts", "locked_until"):
                connection.execute(f"ALTER TABLE cloud_shares DROP COLUMN {column}")
        with patch("backend.server.stored_object_download", return_value={"url": "https://cos.test/download"}):
            self.assertEqual(self.request(self.redeem_path(old_share))[0], 302)
            share = self.share(protected=True)
            self.assertEqual(self.request(self.redeem_path(old_share))[0], 302)
            self.assertEqual(self.request(self.redeem_path(share) + "/" + share["code"])[0], 302)

    def test_trashed_file_links_are_unavailable_until_restored(self):
        share = self.share(protected=True)
        with closing(connect_db(self.database)) as connection, connection:
            columns = {item[1] for item in connection.execute("PRAGMA table_info(cloud_files)")}
            if "trashed_at" not in columns:
                connection.execute("ALTER TABLE cloud_files ADD COLUMN trashed_at TEXT")
            connection.execute("UPDATE cloud_files SET trashed_at='trashed'")
        self.assertEqual(self.request(self.path, {"code": True})[0], 409)
        self.assertEqual(self.request(self.path)[2]["shares"][0]["status"], "unavailable")
        path = self.redeem_path(share) + "/" + share["code"]
        with patch("backend.server.stored_object_download", return_value={"url": "https://cos.test/download"}) as signer:
            self.assertEqual(self.request(path)[0], 404)
            signer.assert_not_called()
            with closing(connect_db(self.database)) as connection, connection:
                connection.execute("UPDATE cloud_files SET trashed_at=NULL")
            self.assertEqual(self.request(path)[0], 302)

    def test_public_redirect_rechecks_deletion_and_honors_expiration(self):
        expired, deleted = self.share(), self.share()
        with closing(connect_db(self.database)) as connection, connection:
            connection.execute("UPDATE cloud_shares SET expires_at=0 WHERE id=?", (expired["id"],))

        def delete_while_signing(*_):
            with closing(connect_db(self.database)) as connection, connection:
                connection.execute("UPDATE cloud_files SET cleared_at='cleared'")
            return {"url": "https://cos.test/never-returned"}

        with patch("backend.server.stored_object_download", side_effect=delete_while_signing) as signer:
            self.assertEqual(self.request(self.redeem_path(expired))[0], 404)
            status, headers, _ = self.request(self.redeem_path(deleted))
            self.assertEqual(status, 404)
            self.assertNotIn("Location", headers)
            signer.assert_called_once()

    def test_object_attachment_is_shareable_but_local_attachment_is_not(self):
        cloud, local = "c" * 32, "f" * 32
        with closing(connect_db(self.database)) as connection, connection:
            for identifier, storage in ((cloud, "object"), (local, None)):
                connection.execute("""INSERT INTO attachments (id,room_id,file_name,content_type,size,sha256,
                    actor,submission_id,created_at,storage,object_name,stored_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                                   (identifier, self.room, "note.txt", "text/plain", 7, "hash",
                                    "user", identifier, "created", storage, "codiscuss/room/c/note.txt", "stored"))
        base = "/api/rooms/cloud-attachments/"
        self.assertEqual(self.request(base + local + "/shares", {})[0], 409)
        status, _, created = self.request(base + cloud + "/shares", {})
        self.assertEqual(status, 201, created)
        with patch("backend.server.stored_object_download", return_value={"url": "https://cos.test/note"}) as signer:
            self.assertEqual(self.request(self.redeem_path(created["share"]))[0], 302)
            self.assertEqual(signer.call_args.args[1]["id"], cloud)

"""Test CLI writes, read-only online instructions, and context provenance."""

import hashlib
import json
import mimetypes
import os
import sqlite3
import tempfile
import threading
import time
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError
from contextlib import closing
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlencode, urlsplit
from urllib.request import Request, urlopen

from backend.server import DiscussionServer, connect_db, create_room, init_database, require_room


# shutdown() waits for the server loop to notice; the default 0.5 s poll made every test end half a second late.
SERVER_POLL_SECONDS = 0.02

class DiscussionTests(unittest.TestCase):
    """Verify the observable POC workflow using isolated SQLite databases."""

    def setUp(self):
        """Use an explicit test Worker URL, or start isolated local storage."""
        self.owner = uuid.uuid4().hex
        self.member_tokens = {name: uuid.uuid4().hex for name in ("Codex", "Claude", "Antigravity", "DeepSeek", "Qwen")}
        # Members the local service wakes; the others answer as registered manual members.
        self.runner_members = {"Codex"}
        self.base = os.getenv("DISCUSS_TEST_URL", "").rstrip("/")
        self.external = bool(self.base)
        if not self.external:
            self.directory = tempfile.TemporaryDirectory()
            self.database = Path(self.directory.name) / "test.sqlite3"
            init_database(self.database, seed=False)
            self.server = DiscussionServer(("127.0.0.1", 0), self.database)
            self.server.local_site = False  # these tests exercise room credential rules, not the account-free local site
            self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": SERVER_POLL_SECONDS}, daemon=True)
            self.thread.start()
            self.base = f"http://127.0.0.1:{self.server.server_port}"
        self.room = self.request("/api/rooms", {"title": "测试议题", "goal": "保持完整记录"})[1]

    def tearDown(self):
        """Release the server and all temporary files."""
        if self.external:
            return
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.directory.cleanup()

    def create_group_room(self):
        """Create an isolated group request without starting a runner or model, also usable against a test Worker."""
        names = ["Claude", "Codex", "Antigravity"]
        status, room = self.request("/api/rooms", {"title": "全体安排校验", "mode": "free", "host": "Claude",
            "members": [{"name": name, "access": "runner", "token": self.member_tokens[name]} for name in names]})
        self.assertEqual(status, 201, room)
        path = f"/api/rooms/{room['id']}"
        message = self.request(path + "/messages", {"author": "用户", "text": "全体处理原问题", "to": names,
            "order": "auto", "submission_id": uuid.uuid4().hex})[1]["message"]["id"]
        return path, message

    def test_group_host_fallback_is_durable_idempotent_and_keeps_original_request(self):
        """A single pending group becomes a deliverable route, with the original source and a durable routing marker."""
        path, message = self.create_group_room()
        url = f"{path}/recommendations/{message}"
        plan = self.request(url)[1]
        before = self.request(path)[1]["free"]["requests"][0]
        self.assertEqual(self.request(url, {"action": "host"}, token=self.member_tokens["Claude"])[0], 403)
        status, result = self.request(url, {"action": "host"})
        self.assertEqual(status, 200, result)
        after = self.request(path)[1]["free"]["requests"][0]
        self.assertEqual([after[key] for key in ("id", "message_id", "chain_id", "created_by")],
                         [before[key] for key in ("id", "message_id", "chain_id", "created_by")])
        self.assertEqual(after["purpose"], "route")
        inbox = self.request(path + "/inbox")[1]
        host = next(member for member in inbox["members"] if member["role"] == "host")
        self.assertEqual(host["pending"][0]["group_action"], "host")
        status, execution = self.request(path + "/executions", {"member_id": host["id"], "client_id": uuid.uuid4().hex})
        self.assertEqual(status, 200, execution)
        self.assertEqual(execution["requests"][0]["id"], plan["request"]["id"])
        self.assertEqual(self.request(url, {"action": "host"}), (200, result))
        self.assertEqual(self.request(url)[1]["result"], result)
        self.assertEqual(self.request(url, {"action": "all", "revision": plan["revision"]})[0], 409)

    def test_group_writes_require_the_judged_members_order_and_messages(self):
        """No revision is 400; changed members, order or messages are 409 and never create everyone's requests."""
        for change in ("members", "order", "message"):
            with self.subTest(change=change):
                path, message = self.create_group_room()
                url = f"{path}/recommendations/{message}"
                plan = self.request(url)[1]
                self.assertEqual(self.request(url, {"action": "all"})[0], 400)
                self.assertEqual(self.request(url, {"action": "sequential"})[0], 400)
                if change == "members":
                    target = next(member for member in plan["members"] if member["name"] == "Antigravity")
                    self.assertEqual(self.request(f"{path}/members/{target['id']}", {"action": "away"})[0], 200)
                elif change == "order":
                    order = self.request(path + "/speaking-order")[1]
                    self.assertEqual(self.request(path + "/speaking-order", {"revision": order["revision"], "order": list(reversed(order["movable"]))})[0], 200)
                else:
                    self.assertEqual(self.request(path + "/messages", {"author": "用户", "text": "先等一下，要求有变", "submission_id": uuid.uuid4().hex})[0], 201)
                for action in ("all", "sequential"):
                    self.assertEqual(self.request(url, {"action": action, "revision": plan["revision"]})[0], 409)
                current = self.request(path)[1]["free"]["requests"]
                self.assertEqual([(item["purpose"], item["status"]) for item in current if item["message_id"] == message], [("group", "pending")])
                self.assertEqual(self.request(url, {"action": "host"})[0], 200)

    def test_runner_reports_delivery_and_how_a_voided_execution_stopped(self):
        """The page learns how each execution reached its software and whether a stop really ended it."""
        names = ["Claude", "Codex"]
        status, room = self.request("/api/rooms", {"title": "投递方式", "mode": "free", "host": "Claude",
            "members": [{"name": name, "access": "runner", "token": self.member_tokens[name]} for name in names]})
        self.assertEqual(status, 201, room)
        path = f"/api/rooms/{room['id']}"
        self.request(path + "/messages", {"author": "用户", "text": "先做这个", "to": ["Codex"], "submission_id": uuid.uuid4().hex})
        codex = next(item for item in self.request(path + "/inbox")[1]["members"] if item["name"] == "Codex")
        execution = self.request(path + "/executions", {"member_id": codex["id"], "client_id": uuid.uuid4().hex})[1]
        url = f"{path}/executions/{execution['id']}"
        self.assertEqual(self.request(url, {"action": "delivery", "stoppable": "no", "progress": False})[0], 400)
        self.assertEqual(self.request(url, {"action": "stopped", "result": "stopped"})[0], 409, "a live execution has no stop result")
        self.assertEqual(self.request(url, {"action": "delivery", "stoppable": False, "progress": False})[0], 200)
        member = next(item for item in self.request(path)[1]["free"]["members"] if item["name"] == "Codex")
        self.assertEqual([member["execution"]["capabilities"], member["execution"]["stop_result"]], [{"stoppable": False, "progress": False, "steer": False, "resume": False}, ""])
        self.assertEqual(self.request(f"{path}/members/{codex['id']}/interrupt", {})[0], 200)
        self.assertEqual(self.request(url, {"action": "delivery", "stoppable": False, "progress": False})[0], 200)
        self.assertEqual(self.request(url, {"action": "stopped", "result": "unstoppable"})[0], 200)
        self.assertTrue(self.request(url, {"action": "stopped", "result": "unstoppable"})[1]["duplicate"])
        self.assertEqual(self.request(url, {"action": "stopped", "result": "stopped"})[0], 409, "recorded once")
        report = next(item for item in self.request(path)[1]["free"]["executions"] if item["id"] == execution["id"])
        self.assertEqual([report["status"], report["capabilities"], report["stop_result"]], ["cancelled", {"stoppable": False, "progress": False, "steer": False, "resume": False}, "unstoppable"])
        # The window may still be on the voided turn: the member's next message waits instead of arriving mid-turn.
        self.request(path + "/messages", {"author": "用户", "text": "补充一句", "to": ["Codex"], "submission_id": uuid.uuid4().hex})
        self.assertEqual(self.request(path + "/executions", {"member_id": codex["id"], "client_id": uuid.uuid4().hex})[0], 409)
        self.assertGreater(next(item for item in self.request(path + "/inbox")[1]["members"] if item["name"] == "Codex")["held_until"], 0)
        # Its late answer is refused as an answer, kept apart for the page, and ends the wait.
        status, refused = self.request(path + "/messages", {"author": "Codex", "text": "迟到的回答", "kind": "chat",
            "execution_id": execution["id"], "submission_id": uuid.uuid4().hex}, token=self.member_tokens["Codex"])
        self.assertEqual(status, 409, refused)
        report = next(item for item in self.request(path)[1]["free"]["executions"] if item["id"] == execution["id"])
        self.assertEqual(set(report["late_answer"]), {"created_at"})
        for token in (self.member_tokens["Codex"], "anonymous"):
            self.assertNotIn("迟到的回答", json.dumps(self.request(path, token=token)[1], ensure_ascii=False))
            self.assertEqual(self.request(url + "/late-answer", token=token)[0], 403)
        self.assertEqual(self.request(url + "/late-answer")[1]["text"], "迟到的回答")
        self.assertNotIn("迟到的回答", [item["text"] for item in self.request(path + "/messages")[1]["messages"]])
        self.assertEqual(self.request(path + "/executions", {"member_id": codex["id"], "client_id": uuid.uuid4().hex})[0], 200)

    def test_owner_stop_all_ends_live_and_queued_work(self):
        """Stopping the room voids running work and everything still owed; members are not woken again by it."""
        names = ["Claude", "Codex"]
        status, room = self.request("/api/rooms", {"title": "全部停止", "mode": "free", "host": "Claude",
            "members": [{"name": name, "access": "runner", "token": self.member_tokens[name]} for name in names]})
        self.assertEqual(status, 201, room)
        path = f"/api/rooms/{room['id']}"
        for text in ("先做这个", "再补充一句"):
            self.request(path + "/messages", {"author": "用户", "text": text, "to": ["Codex"], "submission_id": uuid.uuid4().hex})
            if text == "先做这个":
                codex = next(item for item in self.request(path + "/inbox")[1]["members"] if item["name"] == "Codex")
                execution = self.request(path + "/executions", {"member_id": codex["id"], "client_id": uuid.uuid4().hex})[1]
        self.assertEqual(self.request(path + "/stop", {}, token=self.member_tokens["Codex"])[0], 403)
        self.assertEqual(self.request(path + "/stop", {})[0], 200)
        view = self.request(path)[1]["free"]
        self.assertEqual({(item["status"], item["cancel_reason"]) for item in view["requests"]}, {("cancelled", "user_stop")})
        self.assertEqual(next(item for item in view["executions"] if item["id"] == execution["id"])["status"], "cancelled")

    def test_browser_update_stream_reports_only_successful_committed_writes(self):
        """Independent subscribers see committed changes and can reconnect without a cursor."""
        if self.external:
            self.skipTest("The optional cloud push binding is covered by Worker tests")
        with urlopen(self.base + "/api/updates", timeout=3) as first, urlopen(
                self.base + "/api/updates", timeout=3) as second:
            self.assertIn("text/event-stream", first.headers["Content-Type"])
            for stream in (first, second):
                self.assertEqual(stream.readline(), b"retry: 3000\n")
                self.assertEqual(stream.readline(), b"event: ready\n")
                self.assertEqual(stream.readline(), b"data: {}\n")
                self.assertEqual(stream.readline(), b"\n")
            version = self.server.update_version
            self.assertEqual(self.request(f"/api/rooms/{self.room['id']}/messages",
                                         {"author": "用户", "text": ""})[0], 400)
            self.assertEqual(self.server.update_version, version)
            saved = self.request(f"/api/rooms/{self.room['id']}/messages",
                                 {"author": "用户", "text": "立即出现", "submission_id": "stream-write"})[1]
            for stream in (first, second):
                self.assertEqual(stream.readline(), b"event: change\n")
                self.assertEqual(stream.readline(), f'data: {{"rooms": ["{self.room["id"]}"]}}\n'.encode())
                self.assertEqual(stream.readline(), b"\n")
            self.assertEqual(self.request("/api/rooms", {"title": "另一议题"})[0], 201)
            for stream in (first, second):
                self.assertEqual(stream.readline(), b"event: change\n")
                self.assertEqual(stream.readline(), b"data: {}\n", "a write outside one room names no room")
                self.assertEqual(stream.readline(), b"\n")
            self.assertEqual(self.request(f"/api/rooms/{self.room['id']}/messages/{saved['message']['id']}")[1]["text"],
                             "立即出现")
        with urlopen(self.base + "/api/updates", timeout=3) as reconnected:
            self.assertEqual(reconnected.readline(), b"retry: 3000\n")
            self.assertEqual(reconnected.readline(), b"event: ready\n")

    def test_locked_session_update_blocks_a_concurrent_resume(self):
        """A queued resume cannot pass a locked update or reuse the pre-update control revision."""
        if self.external:
            self.skipTest("The database writer lock is covered by the Worker batch tests")
        from backend.session_room import discussion_action, session_room, update_session_limits
        self.configure_host()
        self.session_action("pause")
        room_id = self.room["id"]
        with closing(connect_db(self.database)) as connection:
            paused = session_room(connection, room_id)
        entered, proceed, restarting = threading.Event(), threading.Event(), threading.Event()
        def update_limits():
            with closing(connect_db(self.database)) as connection, connection:
                update_session_limits(connection, room_id, self.owner, {"revision": paused["revision"], "max_minutes": 5})
                entered.set()
                self.assertTrue(proceed.wait(3))
        def resume():
            restarting.set()
            with closing(connect_db(self.database)) as connection, connection:
                return discussion_action(connection, room_id, self.owner, {"action": "resume", "revision": paused["revision"]}, require_room(connection, room_id))
        with ThreadPoolExecutor(max_workers=2) as pool:
            saving = pool.submit(update_limits)
            self.assertTrue(entered.wait(3))
            resuming = pool.submit(resume)
            try:
                self.assertTrue(restarting.wait(3))
                with self.assertRaises(FutureTimeoutError):
                    resuming.result(0.2)
            finally:
                proceed.set()
            saving.result(3)
            with self.assertRaises(FileExistsError):
                resuming.result(3)
        self.assertEqual(self.request(f"/api/rooms/{room_id}/discussion")[1]["session"]["status"], "paused")

    def request(self, path, payload=None, method=None, token=None):
        """Send a request and decode JSON or UTF-8 text, including error bodies."""
        payload = dict(payload) if payload is not None else None
        if payload is not None and (path == "/api/rooms" or (path.endswith("/topic") and "experts" in payload)):
            experts = payload.get("experts", {name: "cli" for name in self.member_tokens})
            if isinstance(experts, dict):
                current = self.request(path.removesuffix("/topic"))[1].get("experts", {}) if path.endswith("/topic") else {}
                for name, mode in experts.items():
                    if name in current and current[name] != mode:
                        self.member_tokens[name] = uuid.uuid4().hex
                payload.setdefault("members", [{"name": name, "token": self.member_tokens.setdefault(name, uuid.uuid4().hex),
                    "access": "runner" if name in self.runner_members else "manual"} for name, mode in experts.items()])
        if payload is not None and path.endswith("/messages") and "source" not in payload and "submitted_by" not in payload:
            mode = self.request(path.removesuffix("/messages"))[1].get("experts", {}).get(payload.get("author"))
            if mode == "cli":
                payload["source"] = "cli"
        actor = (payload or {}).get("actor", (payload or {}).get("submitted_by", (payload or {}).get("author", "用户")))
        if token is None:
            token = self.owner if actor == "用户" or path == "/api/rooms" else self.member_tokens.get(actor, "")
        data = json.dumps(payload).encode() if payload is not None else None
        request = Request(self.base + path, data=data, method=method)
        request.add_header("X-Discussion-Token", token)
        if data:
            request.add_header("Content-Type", "application/json")
        try:
            response = urlopen(request, timeout=5)
        except HTTPError as error:
            response = error
        with response:
            body = response.read().decode()
            value = json.loads(body) if "application/json" in response.headers.get("Content-Type", "") else body
            return response.status, value

    def post(self, text, submission_id, reply_to=None):
        """Publish an unrestricted user record for storage and reading fixtures."""
        return self.request(f"/api/rooms/{self.room['id']}/messages", {
            "author": "用户", "text": text, "submission_id": submission_id, "reply_to": reply_to,
        })

    def attachment_request(self, path, data=None, headers=None):
        """Read raw bytes so content headers and binary round trips are verified."""
        actor = parse_qs(urlsplit(path).query).get("actor", ["用户"])[0]
        request = Request(self.base + path, data=data, headers={"Content-Type": "application/octet-stream",
            "X-Discussion-Token": self.owner if actor == "用户" else self.member_tokens.get(actor, ""), **(headers or {})})
        try:
            response = urlopen(request, timeout=10)
        except HTTPError as error:
            response = error
        with response:
            return response.status, response.headers, response.read()

    def test_attachments_round_trip_link_replay_and_room_delete(self):
        """Published files retain exact bytes, provenance, readable links, and backup metadata."""
        base = f"/api/rooms/{self.room['id']}"
        data = b"\x89PNG\r\n\x1a\noriginal-image"
        params = urlencode({"actor": "用户", "file_name": "中文 截图.png", "submission_id": "upload-original"})
        status, _, body = self.attachment_request(base + "/attachments?" + params, data, {"Content-Type": "text/html"})
        self.assertEqual(status, 201, body)
        file = json.loads(body)["attachment"]
        self.assertEqual((file["content_type"], file["size"], file["sha256"]), ("image/png", len(data), hashlib.sha256(data).hexdigest()))
        self.assertEqual(self.request(base + "/attachments")[1]["total"], 0)
        self.assertEqual(self.request(base + "/attachments?submission_id=upload-original")[1]["attachments"][0]["id"], file["id"])
        replay = self.attachment_request(base + "/attachments?" + params, data)
        self.assertEqual(replay[0], 200)
        self.assertEqual(json.loads(replay[2])["attachment"]["id"], file["id"])
        self.assertEqual(self.attachment_request(base + "/attachments?" + params, b"changed")[0], 409)
        payload = {"author": "用户", "text": "", "attachment_ids": [file["id"]], "submission_id": "attached-message"}
        status, result = self.request(base + "/messages", payload)
        self.assertEqual(status, 201, result)
        message = result["message"]
        self.assertEqual(self.request(base + "/messages", payload)[1]["message"], message)
        self.assertEqual(self.request(base + f"/messages/{message['id']}")[1]["attachments"], message["attachments"])
        self.assertEqual(self.request(base + "/messages")[1]["messages"][0]["attachments"], message["attachments"])
        self.assertEqual(self.request(base + "/attachments")[1]["total"], 1)
        self.assertIn(file["download_url"], self.request(f"/r/{self.room['id']}/messages/{message['id']}")[1])
        status, headers, content = self.attachment_request(file["url"])
        self.assertEqual((status, content), (200, data))
        self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
        self.assertTrue(headers["Content-Disposition"].startswith("inline"))
        self.assertTrue(self.attachment_request(file["download_url"])[1]["Content-Disposition"].startswith("attachment"))
        self.assertEqual(self.request(base + "/backup")[1]["tables"]["attachments"][0]["sha256"], file["sha256"])
        self.assertEqual(self.request(base + "/messages", {**payload, "submission_id": "reuse-message"})[0], 409)
        self.assertEqual(self.request(base + "/messages", {**payload, "text": "changed", "attachment_ids": []})[0], 409)
        if not self.external:
            init_database(self.database, seed=False)
            self.assertEqual(self.attachment_request(file["url"])[2], data)
        self.assertEqual(self.request(base + "/delete", {"actor": "用户", "confirm_title": self.room["title"]})[0], 200)
        self.assertEqual(self.attachment_request(file["url"])[0], 404)
        if not self.external:
            self.assertEqual(list(Path(str(self.database) + ".attachments").iterdir()), [])

    def test_media_ticket_streams_only_its_checked_file_until_it_expires_or_changes(self):
        """A local page plays a project file by a random ticket; an unknown, expired or outdated ticket reads nothing."""
        if self.external:
            self.skipTest("media tickets belong to the local site")
        path = Path(str(self.database) + ".media.mp3")
        path.write_bytes(b"ID3" + bytes(1000))
        info = path.stat()
        self.server.media_tickets["good"] = (path, info.st_size, info.st_mtime_ns, "audio/mpeg", path.name, time.time() + 60)
        self.server.media_tickets["old"] = (path, info.st_size, info.st_mtime_ns, "audio/mpeg", path.name, time.time() - 1)
        status, headers, body = self.attachment_request("/api/local/media/good", headers={"Range": "bytes=0-2"})
        self.assertEqual((status, body, headers["Content-Type"]), (206, b"ID3", "audio/mpeg"))
        self.assertIn("sandbox", headers["Content-Security-Policy"])
        self.assertEqual(self.attachment_request("/api/local/media/unknown")[0], 404)
        self.assertEqual(self.attachment_request("/api/local/media/old")[0], 404)
        path.write_bytes(b"ID3" + bytes(10))
        self.assertEqual(self.attachment_request("/api/local/media/good")[0], 409)

    def test_attachments_reject_cross_room_owner_path_and_size(self):
        """Untrusted MIME and filenames cannot create executable or cross-room file access."""
        base = f"/api/rooms/{self.room['id']}"
        params = {"actor": "用户", "file_name": "页面.html", "submission_id": "upload-security"}
        status, _, body = self.attachment_request(base + "/attachments?" + urlencode(params), b"<script>bad()</script>")
        self.assertEqual(status, 201, body)
        file = json.loads(body)["attachment"]
        headers = self.attachment_request(file["url"])[1]
        self.assertEqual(headers["Content-Type"], "application/octet-stream")
        self.assertTrue(headers["Content-Disposition"].startswith("attachment"))
        # An SVG shows inline as an image; opened directly, the sandboxing policy still keeps its scripts from running.
        svg = b'<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"><script>bad()</script></svg>'
        svg_params = {**params, "file_name": "图.svg", "submission_id": "upload-svg"}
        svg_file = json.loads(self.attachment_request(base + "/attachments?" + urlencode(svg_params), svg)[2])["attachment"]
        self.assertEqual(svg_file["content_type"], "image/svg+xml")
        svg_headers = self.attachment_request(svg_file["url"])[1]
        self.assertTrue(svg_headers["Content-Disposition"].startswith("inline"))
        self.assertIn("sandbox", svg_headers["Content-Security-Policy"])
        # A video is recognized for the page's player and served in the byte ranges a player seeks with.
        video = b"\x00\x00\x00\x18ftypisom" + bytes(range(256)) * 4
        video_params = {**params, "file_name": "片段.mp4", "submission_id": "upload-video"}
        video_file = json.loads(self.attachment_request(base + "/attachments?" + urlencode(video_params), video)[2])["attachment"]
        self.assertEqual(video_file["content_type"], "video/mp4")
        status, video_headers, body = self.attachment_request(video_file["url"], headers={"Range": "bytes=10-19"})
        self.assertEqual((status, body, video_headers["Content-Range"]), (206, video[10:20], f"bytes 10-19/{len(video)}"))
        self.assertEqual(self.attachment_request(video_file["url"], headers={"Range": "bytes=-5"})[2], video[-5:])
        self.assertEqual(self.attachment_request(video_file["url"], headers={"Range": f"bytes={len(video)}-"})[0], 416)
        self.assertEqual(self.attachment_request(video_file["url"])[2], video)
        other = self.request("/api/rooms", {"title": "另一房间"})[1]["id"]
        self.assertEqual(self.request(f"/api/rooms/{other}/attachments/{file['id']}")[0], 404)
        self.assertEqual(self.request(f"/api/rooms/{other}/messages", {"author": "用户", "text": "", "attachment_ids": [file["id"]], "submission_id": "cross-room"})[0], 404)
        params.update(actor="Codex", submission_id="other-uploader")
        foreign = json.loads(self.attachment_request(base + "/attachments?" + urlencode(params), b"other")[2])["attachment"]
        self.assertEqual(self.request(base + "/messages", {"author": "用户", "text": "", "attachment_ids": [foreign["id"]], "submission_id": "wrong-owner"})[0], 409)
        for name in ("../escape", "folder\\file", "bad\nname", "x" * 256):
            self.assertEqual(self.attachment_request(base + "/attachments?" + urlencode({**params, "file_name": name}), b"x")[0], 400)
        self.assertEqual(self.attachment_request(base + "/attachments?" + urlencode(params), b"x", {"Content-Length": str(20 * 1024 * 1024 + 1)})[0], 413)
        invalid = {"author": "用户", "text": "资料", "submission_id": "invalid-files"}
        for identifiers in ([file["id"]] * 2, ["invalid"], [f"{index:032x}" for index in range(11)], "not-an-array"):
            self.assertEqual(self.request(base + "/messages", {**invalid, "attachment_ids": identifiers})[0], 400)
        self.assertEqual(self.request(base + "/messages")[1]["total"], 0)

    def test_room_backup_includes_every_page_and_original_relationships(self):
        """Export complete, unchanged records rather than the current history page."""
        self.configure_host(start=False)
        base = f"/api/rooms/{self.room['id']}"
        originals = [self.post(f"原文 {index} 🙂\n保留换行", f"backup-{index}")[1]["message"] for index in range(45)]
        payload = {"author": "Antigravity", "source": "cli", "text": "完整专家意见",
                   "summary": "摘要", "summary_by": "Antigravity", "submission_id": "backup-answer", "reply_to": originals[0]["id"]}
        status, answer = self.request(base + "/messages", payload)
        self.assertEqual(status, 201)
        answer = answer["message"]
        self.assertEqual(self.request(base + "/state", {"actor": "Codex", "text": "保留分歧", "brief": "主持简报", "until": answer["id"]})[0], 200)
        before = self.request(base)[1]
        status, snapshot = self.request(base + "/backup?page=2&q=missing&author=Claude")
        self.assertEqual(status, 200)
        self.assertEqual((snapshot["format"], snapshot["version"]), ("ai-codiscuss-room-backup", 2))
        self.assertTrue(snapshot["exported_at"])
        tables = snapshot["tables"]
        self.assertEqual(set(tables), {"rooms", "room_directory", "room_folder_assignments", "topic_folders", "room_creations",
                                      "room_briefs", "room_user_requests", "topic_settings", "discussion_limits", "messages", "message_withdrawals", "message_details", "message_summaries", "message_timings", "attachments", "room_modes", "room_members", "member_requests", "member_suggestions", "member_recommendations",
                                      "scheduler_decisions", "review_plans",
                                      "discussion_sessions", "discussion_conclusions", "session_requests",
                                      "task_message_sources", "session_state", "session_limits",
                                      "session_round_budgets", "session_options", "session_pauses"})
        self.assertEqual([row["id"] for row in tables["messages"]], [row["id"] for row in originals] + [answer["id"]])
        for original, row in zip(originals + [answer], tables["messages"]):
            self.assertEqual(row, {key: original[key] for key in row})
        details = next(row for row in tables["message_details"] if row["message_id"] == answer["id"])
        summary = next(row for row in tables["message_summaries"] if row["message_id"] == answer["id"])
        self.assertEqual(details, {"message_id": answer["id"], "kind": "chat", "submitted_by": "Antigravity"})
        self.assertEqual((summary["text"], summary["author"]), ("摘要", "Antigravity"))
        self.assertEqual(tables["rooms"][0]["state_text"], "保留分歧")
        self.assertEqual(tables["room_briefs"][0]["text"], "主持简报")
        self.assertEqual(tables["topic_settings"][0]["host"], "Codex")
        after = self.request(base)[1]
        before["limits"]["elapsed_seconds"] = after["limits"]["elapsed_seconds"]
        self.assertEqual(after, before)

    def test_room_backup_excludes_other_rooms_and_retains_archived_data(self):
        """Folder membership must not pull another room's messages or configuration."""
        base = f"/api/rooms/{self.room['id']}"
        folder = self.request("/api/folders", {"name": "共同文件夹"})[1]
        self.request(base + "/folder", {"actor": "用户", "folder_id": folder["id"]})
        other = self.request("/api/rooms", {"title": "禁止混入的房间", "submission_id": "other-creation"})[1]
        self.request(f"/api/rooms/{other['id']}/folder", {"actor": "用户", "folder_id": folder["id"]})
        self.request(f"/api/rooms/{other['id']}/messages", {"author": "用户", "text": "OTHER_SECRET", "submission_id": "other-secret"})
        self.post("本房间原文", "own-record")
        self.assertEqual(self.request(base + "/archive", {"actor": "用户"})[0], 200)
        status, snapshot = self.request(base + "/backup")
        self.assertEqual(status, 200)
        tables = snapshot["tables"]
        self.assertEqual(tables["room_directory"][0]["archived"], 1)
        # The backup keeps raw rows, so the folder's project paths stay JSON text there.
        self.assertEqual(tables["topic_folders"], [{**folder, "directories": "[]"}])
        self.assertEqual(len(tables["room_folder_assignments"]), 1)
        self.assertEqual([row["text"] for row in tables["messages"]], ["本房间原文"])
        self.assertNotIn(other["id"], json.dumps(snapshot))
        self.assertNotIn("OTHER_SECRET", json.dumps(snapshot))
        self.assertEqual(self.request(base + "/backup", {}, method="POST")[0], 400)

    def test_room_import_renumbers_history_and_skips_a_repeat(self):
        """An imported backup keeps its relationships and references under fresh IDs and the importer's credential."""
        self.configure_host(start=False)
        base = f"/api/rooms/{self.room['id']}"
        first = self.post("原始问题", "import-first")[1]["message"]
        data = b"\x89PNG\r\n\x1a\nimported-image"
        upload = urlencode({"actor": "用户", "file_name": "图.png", "submission_id": "import-file"})
        file = json.loads(self.attachment_request(base + "/attachments?" + upload, data)[2])["attachment"]
        self.request(base + "/messages", {"author": "用户", "text": f"补充 #{first['id']}", "attachment_ids": [file["id"]],
                                          "submission_id": "import-second", "reply_to": first["id"]})
        payload = {"author": "Antigravity", "source": "cli", "text": f"回应 #{first['id']}",
                   "summary": f"摘要 #{first['id']}", "summary_by": "Antigravity", "submission_id": "import-answer"}
        answer = self.request(base + "/messages", payload)[1]["message"]
        backup = json.loads(json.dumps(self.request(base + "/backup")[1]).replace(self.room["id"], "importedroom"))
        backup["tables"]["scheduler_decisions"] = [{"id": 1, "after_message_id": first["id"], "kind": "interjection", "label": "交给主持人 Codex", "confidence": 0.66,
                                                    "applied": 0, "provider": "jev", "created_at": "2026-10-25T00:00:00Z", "feedback": "bad", "should_be": "Antigravity",
                                                    "note": "该问 Antigravity", "context": "{\"prompt\": 2}"}]
        backup["tables"]["topic_folders"] = [{"id": "sourcefolder", "name": "来源文件夹", "position": 1}]
        self.post("占用新编号", "import-later")
        status, result = self.request("/api/rooms/import", backup)
        self.assertEqual(status, 201, result)
        self.assertEqual((result["id"], list(result["attachments"])), ("importedroom", [file["id"]]))
        self.assertEqual(self.request("/api/rooms/import", backup)[1]["skipped"], True)
        room = self.request("/api/rooms/importedroom")[1]
        self.assertEqual((room["host"], room["phase"], room["title"]), ("Codex", "discussing", self.room["title"]))
        self.assertIsNone(room["folder_id"])
        self.assertEqual(self.request("/api/rooms")[1]["folders"], [])
        self.assertEqual([(item["feedback"], item["should_be"], item["note"], item["context"]) for item in room["scheduler_decisions"]],
                         [("bad", "Antigravity", "该问 Antigravity", "{\"prompt\": 2}")])
        messages = self.request("/api/rooms/importedroom/messages")[1]["messages"]
        new_first, second, new_answer = sorted(messages, key=lambda message: message["id"])
        self.assertGreater(new_first["id"], answer["id"] + 1)
        self.assertEqual((second["text"], second["reply_to"]), (f"补充 #{new_first['id']}", new_first["id"]))
        self.assertEqual((new_answer["text"], new_answer["summary"], new_answer["submitted_by"]),
                         (f"回应 #{new_first['id']}", f"摘要 #{new_first['id']}", "Antigravity"))
        self.assertNotIn("turn_id", new_answer)
        self.assertIsNone(room["current_turn"])
        path = f"/api/rooms/importedroom/attachments/{result['attachments'][file['id']]}"
        self.assertEqual(self.attachment_request(path + "/content")[0], 404)
        request = Request(self.base + path + "/import", data=data, headers={"X-Discussion-Token": self.owner})
        with urlopen(request, timeout=10) as response:
            self.assertEqual(response.status, 200)
        self.assertEqual(self.attachment_request(path + "/content")[2], data)

    def test_room_backup_v2_imports_sessions_as_read_only_history(self):
        """Session history and task provenance are remapped without importing executable work."""
        self.runner_members.add("Antigravity")
        self.configure_host(experts={"Codex": "cli", "Antigravity": "cli"})
        base = f"/api/rooms/{self.room['id']}"
        before = self.post("讨论前的问题 #17", "session-backup-before")[1]["message"]
        host_execution = self.reserve_member("Codex")["execution_id"]
        self.assertEqual(self.request(base + "/state", {"actor": "Codex", "text": "旧结论状态"})[0], 200)
        conclusion = self.request(base + "/conclusion")[1]
        status, result = self.request(base + "/limits", {"actor": "Codex", "action": "done",
                                                              "conclusion": conclusion["revision"]})
        self.assertEqual(status, 200, result)
        self.assertEqual(self.request(base)[1]["session"]["status"], "concluded")
        self.assertEqual(self.post("讨论间的自由消息", "session-backup-between")[0], 201)
        self.session_action("start", goal="活动会话")
        active_session = self.request(base + "/discussion")[1]["session"]
        status, result = self.schedule("session-backup-plan")
        self.assertEqual(status, 201, result)
        plan = result["turn"]
        execution = self.reserve_member("Antigravity")["execution_id"]
        self.assertNotEqual(host_execution, execution)
        with closing(connect_db(self.database)) as connection, connection:
            host_request = connection.execute("SELECT id FROM member_requests WHERE purpose='discuss_host' ORDER BY id LIMIT 1").fetchone()[0]
            connection.execute("UPDATE task_message_sources SET cause_message_id=?,cause_request_id=? WHERE session_request_id=?",
                               (before["id"], host_request, plan["id"]))
            connection.execute("UPDATE session_requests SET read_until=? WHERE id=?", (before["id"], plan["id"]))
            connection.execute("UPDATE session_state SET read_until=?,held_since=? WHERE session_id=?",
                               (before["id"], before["id"], active_session["id"]))
            connection.execute("UPDATE session_limits SET max_rounds=3,max_minutes=9,execution_minutes=4,started_at=1700000000,stop_reason='limit-test' WHERE session_id=?",
                               (active_session["id"],))
            connection.execute("UPDATE session_round_budgets SET base=2,cap=3,extra=1 WHERE session_id=?", (active_session["id"],))
            connection.execute("UPDATE session_options SET named_followup=1 WHERE session_id=?", (active_session["id"],))
            connection.execute("UPDATE session_pauses SET paused_at=1700000001,paused_seconds=8 WHERE session_id=?",
                               (active_session["id"],))
        backup = json.loads(json.dumps(self.request(base + "/backup")[1]).replace(self.room["id"], "sessionimport"))
        self.assertEqual(backup["version"], 2)
        self.assertNotIn("session_start_submissions", backup["tables"])
        self.assertNotIn("discussion_runtime", backup["tables"])
        self.assertNotIn("execution_retries", backup["tables"])
        self.assertIn("execution_id", backup["tables"]["member_requests"][0])
        self.assertTrue(any(row["execution_id"] is not None for row in backup["tables"]["member_requests"]))
        incomplete = json.loads(json.dumps(backup))
        incomplete["tables"].pop("task_message_sources")
        self.assertEqual(self.request("/api/rooms/import", incomplete)[0], 400)
        status, imported = self.request("/api/rooms/import", backup)
        self.assertEqual(status, 201, imported)
        with closing(connect_db(self.database)) as connection:
            source_room = connection.execute("SELECT id FROM rooms WHERE id='sessionimport'").fetchone()[0]
            imported_sessions = list(connection.execute("SELECT * FROM discussion_sessions WHERE room_id=? ORDER BY id",
                                                        (source_room,)))
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM member_requests WHERE room_id=? AND execution_id IS NOT NULL",
                                                (source_room,)).fetchone()[0], 0)
            self.assertEqual(len(imported_sessions), 2)
            prior = next(row for row in imported_sessions if row["goal"] == "保持完整记录")
            active = next(row for row in imported_sessions if row["goal"] == "活动会话")
            self.assertEqual(prior["status"], "concluded")
            self.assertEqual(active["status"], "concluded")
            self.assertEqual(active["ended_message_id"], connection.execute(
                "SELECT MAX(id) FROM messages WHERE room_id=? AND NOT EXISTS "
                "(SELECT 1 FROM task_message_sources WHERE message_id=messages.id)", (source_room,)).fetchone()[0])
            imported_conclusion = connection.execute("SELECT * FROM discussion_conclusions WHERE session_id=?",
                                                      (prior["id"],)).fetchone()
            original_conclusion = backup["tables"]["discussion_conclusions"][0]
            self.assertEqual(imported_conclusion["stop_reason"], original_conclusion["stop_reason"])
            imported_plan = connection.execute("SELECT * FROM session_requests WHERE session_id=? AND submission_id=?",
                                                (active["id"], plan["submission_id"])).fetchone()
            self.assertEqual(imported_plan["status"], "cancelled", dict(imported_plan))
            self.assertNotEqual(imported_plan["id"], plan["id"])
            self.assertNotEqual(imported_plan["member_request_id"], plan["member_request_id"])
            imported_request = connection.execute("SELECT * FROM member_requests WHERE id=?",
                                                    (imported_plan["member_request_id"],)).fetchone()
            self.assertEqual((imported_request["status"], imported_request["execution_id"]), ("cancelled", None))
            source = connection.execute("SELECT * FROM task_message_sources WHERE session_request_id=?",
                                        (imported_plan["id"],)).fetchone()
            self.assertNotEqual(source["message_id"], next(row["message_id"] for row in backup["tables"]["task_message_sources"]
                                                            if row["session_request_id"] == plan["id"]))
            self.assertEqual(imported_request["chain_id"], source["message_id"])
            self.assertEqual(source["cause_message_id"], connection.execute(
                "SELECT id FROM messages WHERE room_id=? AND submission_id='session-backup-before'", (source_room,)).fetchone()[0])
            self.assertEqual(source["cause_request_id"], connection.execute(
                "SELECT id FROM member_requests WHERE room_id=? AND purpose='discuss_host' ORDER BY id LIMIT 1", (source_room,)).fetchone()[0])
            imported_state = connection.execute("SELECT * FROM session_state WHERE session_id=?", (active["id"],)).fetchone()
            imported_boundary = connection.execute("SELECT id FROM messages WHERE room_id=? AND submission_id='session-backup-before'",
                                                    (source_room,)).fetchone()[0]
            self.assertEqual((imported_state["read_until"], imported_state["held_since"]),
                             (imported_boundary, imported_boundary))
            imported_plan = connection.execute("SELECT * FROM session_requests WHERE session_id=? AND submission_id=?",
                                                (active["id"], plan["submission_id"])).fetchone()
            self.assertEqual(imported_plan["read_until"], imported_boundary)
            imported_limits = connection.execute("SELECT * FROM session_limits WHERE session_id=?", (active["id"],)).fetchone()
            self.assertEqual((imported_limits["max_rounds"], imported_limits["max_minutes"],
                              imported_limits["execution_minutes"], imported_limits["started_at"],
                              imported_limits["stop_reason"]), (3, 9, 4, 1700000000, "limit-test"))
            self.assertEqual(tuple(connection.execute("SELECT base,cap,extra FROM session_round_budgets WHERE session_id=?",
                                                      (active["id"],)).fetchone()), (2, 3, 1))
            self.assertEqual(connection.execute("SELECT named_followup FROM session_options WHERE session_id=?",
                                                (active["id"],)).fetchone()[0], 1)
            self.assertEqual(tuple(connection.execute("SELECT paused_at,paused_seconds FROM session_pauses WHERE session_id=?",
                                                      (active["id"],)).fetchone()), (1700000001, 8))
            self.assertEqual(connection.execute("PRAGMA foreign_key_check").fetchall(), [])
        imported_messages = self.request("/api/rooms/sessionimport/messages")[1]["messages"]
        self.assertNotIn("系统任务", [row["author"] for row in imported_messages])

    def test_channel_order_and_rename_survive_reload(self):
        """Moves persist without losing new rooms; rename retains IDs and content."""
        original = self.post("原文保留", "rename-original")[1]["message"]
        second = self.request("/api/rooms", {"title": "频道乙"})[1]
        third = self.request("/api/rooms", {"title": "频道丙"})[1]
        path = f"/api/rooms/{third['id']}/move"
        # Ordering needs no room credential; the declared actor rule still applies.
        self.assertEqual(self.request(path, {"actor": "Claude", "before_id": self.room["id"]})[0], 400)
        self.assertEqual(self.request(path, {"actor": "用户", "before_id": "missing"})[0], 400)
        self.assertEqual(self.request(path, {"actor": "用户", "before_id": self.room["id"]})[0], 200)
        base = f"/api/rooms/{self.room['id']}"
        self.assertEqual(self.request(base + "/rename", {"actor": "用户", "title": "  "})[0], 400)
        self.assertEqual(self.request(base + "/rename", {"actor": "用户", "title": "重命名 <& 中文"})[0], 200)
        if not self.external:
            init_database(self.database)
        ids = [item["id"] for item in self.request("/api/rooms")[1]["rooms"]]
        self.assertLess(ids.index(third["id"]), ids.index(self.room["id"]))
        self.assertLess(ids.index(self.room["id"]), ids.index(second["id"]))
        self.assertEqual(self.request(base)[1]["title"], "重命名 <& 中文")
        self.assertEqual(self.request(base + f"/messages/{original['id']}")[1]["text"], original["text"])
        self.assertEqual(self.request(path, {"actor": "用户", "before_id": None})[0], 200)
        self.assertEqual(self.request("/api/rooms")[1]["rooms"][-1]["id"], third["id"])

    def test_second_server_cannot_reuse_active_port(self):
        """Reject duplicate listeners instead of mixing separate discussion databases."""
        if self.external:
            self.skipTest("Socket binding belongs to the Python deployment")
        with self.assertRaises(OSError):
            with DiscussionServer(self.server.server_address, self.database):
                pass
        self.assertEqual(self.request("/api/health"), (200, {"ok": True}))

    def test_discussion_session_is_explicit_and_survives_schema_reinitialization(self):
        """Session controls update only the active session and survive repeated schema application."""
        self.configure_host()
        base = f"/api/rooms/{self.room['id']}"
        original = self.request(base + "/discussion")[1]["session"]
        self.assertEqual(original["status"], "active")
        self.session_action("pause")
        self.assertEqual(self.request(base)[1]["session"]["status"], "paused")
        if not self.external:
            init_database(self.database)
            init_database(self.database)
        paused = self.request(base + "/discussion")[1]["session"]
        self.assertEqual((paused["id"], paused["status"]), (original["id"], "paused"))
        self.session_action("resume")
        self.assertEqual(self.request(base)[1]["session"]["id"], original["id"])

    def test_archive_preserves_history_and_requires_explicit_resume(self):
        """Archive cancels active work, retains evidence and never resumes work during restoration."""
        self.configure_host()
        original = self.post("存档原文", "archive-original")[1]["message"]
        plan = self.schedule()[1]["turn"]
        base = f"/api/rooms/{self.room['id']}"
        status, archived = self.request(base + "/archive", {"actor": "用户"})
        self.assertEqual((status, archived["archived"], archived["session"]["status"]), (200, True, "paused"))
        self.assertEqual(self.request(base + f"/turns/{plan['id']}")[1]["status"], "cancelled")
        self.assertEqual(self.post("拒绝新观点", "archived-new-001")[0], 400)
        self.assertEqual(self.request(base + "/messages", {"author": "用户", "kind": "receipt", "text": "旧回执", "submission_id": "archive-receipt"})[0], 400)
        self.assertEqual(self.request(base + f"/messages/{original['id']}")[1]["text"], "存档原文")
        if not self.external:
            init_database(self.database)
        restored = self.request(base + "/restore", {"actor": "用户"})[1]
        self.assertEqual((restored["archived"], restored["session"]["status"]), (False, "paused"))
        self.session_action("resume")
        self.assertEqual(self.post("显式恢复后发言", "restored-new-001")[0], 201)

    def test_topic_folder_assignment_persists_and_survives_archive_restore(self):
        """Folders categorize existing rooms without changing their archive state."""
        for invalid_name in (None, 42, ["标题"], {}, "   ", "😀" * 41):
            self.assertEqual(self.request("/api/folders", {"name": invalid_name})[0], 400)
        self.assertEqual(self.request("/api/folders", {"name": "😀" * 40})[0], 201)
        folder = self.request("/api/folders", {"name": "产品讨论"})
        self.assertEqual(folder[0], 201)
        folder_id = folder[1]["id"]
        room_path = f"/api/rooms/{self.room['id']}"
        self.assertEqual(self.request(room_path + "/folder", {"actor": "用户", "folder_id": "missing"})[0], 400)
        self.assertEqual(self.request(room_path + "/folder", {"actor": "用户", "folder_id": 42})[0], 400)
        assigned = self.request(room_path + "/folder", {"actor": "用户", "folder_id": folder_id})[1]
        self.assertEqual(assigned["folder_id"], folder_id)
        self.assertEqual(self.request(room_path + "/archive", {"actor": "用户"})[1]["folder_id"], folder_id)
        restored = self.request(room_path + "/restore", {"actor": "用户"})[1]
        self.assertEqual(restored["folder_id"], folder_id)
        if not self.external:
            init_database(self.database)
        directory = self.request("/api/rooms")[1]
        self.assertIn(folder_id, [item["id"] for item in directory["folders"]])
        self.assertEqual(next(item for item in directory["folders"] if item["id"] == folder_id)["name"], "产品讨论")
        self.assertEqual(next(item for item in directory["rooms"] if item["id"] == self.room["id"])["folder_id"], folder_id)
        self.assertEqual(self.request(room_path + "/folder", {"actor": "用户", "folder_id": None})[1]["folder_id"], None)

    def test_folder_project_paths_validate_and_persist(self):
        """A folder keeps its project paths for new rooms; renaming without paths leaves them unchanged."""
        for invalid in ("D:/a", ["relative/path"], [""], [42], ["D:/a", "d:\\A\\"], ["D:/x"] * 10):
            self.assertEqual(self.request("/api/folders", {"name": "路径", "directories": invalid})[0], 400, invalid)
        status, folder = self.request("/api/folders", {"name": "项目", "directories": [" D:/work/main ", "/srv/other"]})
        self.assertEqual(status, 201)
        self.assertEqual(folder["directories"], ["D:/work/main", "/srv/other"])
        path = f"/api/folders/{folder['id']}/rename"
        self.assertEqual(self.request(path, {"name": "改名"})[1]["directories"], ["D:/work/main", "/srv/other"])
        self.assertEqual(self.request(path, {"name": "改名", "directories": ["E:\\code"]})[1]["directories"], ["E:\\code"])
        if not self.external:
            init_database(self.database)
        saved = next(item for item in self.request("/api/rooms")[1]["folders"] if item["id"] == folder["id"])
        self.assertEqual((saved["name"], saved["directories"]), ("改名", ["E:\\code"]))

    def test_folder_removal_preserves_active_and_archived_rooms(self):
        """Removing a group clears assignments without deleting any room records."""
        folder = self.request("/api/folders", {"name": "待移除"})[1]["id"]
        active_path = f"/api/rooms/{self.room['id']}"
        self.post("移除分组后保留原文", "remove-folder-message")
        self.request(active_path + "/folder", {"actor": "用户", "folder_id": folder})
        archived = self.request("/api/rooms", {"title": "已存档", "folder_id": folder})[1]
        archived_path = f"/api/rooms/{archived['id']}"
        self.request(archived_path + "/archive", {"actor": "用户"})
        before = [self.request(path)[1] for path in (active_path, archived_path)]
        directory = self.request("/api/rooms")[1]
        status, removed = self.request(f"/api/folders/{folder}/delete", {})
        self.assertEqual((status, removed), (200, {"deleted": True, "id": folder}))
        for path, original in zip((active_path, archived_path), before):
            current = self.request(path)[1]
            original["limits"]["elapsed_seconds"] = current["limits"]["elapsed_seconds"]
            self.assertEqual(current, {**original, "folder_id": None})
        after = self.request("/api/rooms")[1]
        self.assertEqual([room["id"] for room in after["rooms"]], [room["id"] for room in directory["rooms"]])
        self.assertEqual(after["folders"], [item for item in directory["folders"] if item["id"] != folder])
        self.assertEqual(self.request(f"/api/folders/{folder}/delete", {})[0], 404)
        self.assertEqual(self.request("/api/folders/__uncategorized__/delete", {})[0], 404)
        self.assertEqual(self.request("/api/rooms")[1], after)

    def test_create_room_in_folder_is_atomic_and_replayable(self):
        """Creation includes placement; retries never duplicate or move an existing room."""
        folder = self.request("/api/folders", {"name": "目标文件夹"})[1]["id"]
        payload = {"title": "在文件夹中新建", "folder_id": folder, "submission_id": str(uuid.uuid4())}
        status, room = self.request("/api/rooms", payload)
        self.assertEqual((status, room["folder_id"]), (201, folder))
        status, replay = self.request("/api/rooms", payload)
        self.assertEqual((status, replay["id"], replay["duplicate"]), (200, room["id"], True))
        self.assertEqual(self.request("/api/rooms", {**payload, "folder_id": None})[0], 409)
        self.request(f"/api/rooms/{room['id']}/folder", {"actor": "用户", "folder_id": None})
        self.assertIsNone(self.request("/api/rooms", payload)[1]["folder_id"])
        before_ids = [item["id"] for item in self.request("/api/rooms")[1]["rooms"]]
        for invalid in ("missing", "", 42, [], {}):
            self.assertEqual(self.request("/api/rooms", {**payload, "folder_id": invalid, "submission_id": str(uuid.uuid4())})[0], 400)
        self.assertEqual([item["id"] for item in self.request("/api/rooms")[1]["rooms"]], before_ids)
        ungrouped = {"title": "未归类", "submission_id": str(uuid.uuid4())}
        created = self.request("/api/rooms", ungrouped)[1]
        self.assertIsNone(created["folder_id"])
        self.assertEqual(self.request("/api/rooms", {**ungrouped, "folder_id": None})[1]["id"], created["id"])

    def test_revisions_change_only_with_the_room_or_the_directory(self):
        """A room's revision moves with its own writes; the site revision moves with any room or directory change."""
        other = self.request("/api/rooms", {"title": "另一议题", "goal": "保持完整记录"})[1]
        ids = f"{self.room['id']},{other['id']},missing"

        def revisions():
            status, result = self.request(f"/api/revisions?rooms={ids}")
            self.assertEqual(status, 200)
            return result

        before = revisions()
        self.assertEqual(set(before["rooms"]), {self.room["id"], other["id"]}, "a missing room is left out")
        self.assertEqual(revisions(), before, "reading changes nothing")
        self.post("新消息", uuid.uuid4().hex)
        after = revisions()
        self.assertGreater(after["rooms"][self.room["id"]], before["rooms"][self.room["id"]])
        self.assertEqual(after["rooms"][other["id"]], before["rooms"][other["id"]])
        self.assertGreater(after["site"], before["site"])
        self.request("/api/folders", {"name": "甲组"})
        moved = revisions()
        self.assertGreater(moved["site"], after["site"], "a directory change raises only the site revision")
        self.assertEqual(moved["rooms"], after["rooms"])
        if not self.external:
            # An outer INSERT OR IGNORE must not turn the trigger's own write into a skipped one.
            with closing(sqlite3.connect(self.database)) as connection, connection:
                connection.execute("INSERT OR IGNORE INTO room_briefs (room_id,text,until,updated_at) VALUES (?,?,?,?)",
                                   (other["id"], "简报", 0, "2026-10-29T00:00:00Z"))
            self.assertGreater(revisions()["rooms"][other["id"]], moved["rooms"][other["id"]])

    def test_delete_removes_related_records_and_leaves_other_channels(self):
        """Wrong confirmations preserve content; deletion removes linked data atomically."""
        self.configure_host()
        original = self.post("删除测试原文", "delete-original")[1]["message"]
        self.post("引用原文", "delete-reply-001", original["id"])
        turn = self.schedule()[1]["turn"]
        base = f"/api/rooms/{self.room['id']}"
        answer = {"author": "Antigravity", "text": "回答", "summary": "回答摘要", "submission_id": "delete-answer-001", "request_ids": [turn["member_request_id"]]}
        self.assertEqual(self.request(base + "/messages", answer)[0], 201)
        self.assertEqual(self.request(base + "/state", {"actor": "Codex", "text": "状态", "brief": "主持简报"})[0], 200)
        other = self.request("/api/rooms", {"title": "保留频道"})[1]
        self.assertEqual(self.request(base + "/delete", {"actor": "用户", "confirm_title": "错误"})[0], 400)
        self.assertEqual(self.request(base + "/delete", {"actor": "Antigravity", "confirm_title": self.room["title"]})[0], 403)
        self.assertEqual(self.request(base)[1]["message_count"], 3)
        self.assertEqual(self.request(base + "/delete", {"actor": "用户", "confirm_title": self.room["title"]})[0], 200)
        for suffix in ("", "/messages", f"/messages/{original['id']}", "/turns"):
            self.assertEqual(self.request(base + suffix)[0], 404)
        self.assertEqual(self.request(f"/r/{self.room['id']}")[0], 404)
        self.assertEqual(self.request(f"/api/rooms/{other['id']}")[0], 200)
        if not self.external:
            with closing(sqlite3.connect(self.database)) as connection:
                for table in ("messages", "topic_settings", "room_directory", "room_folder_assignments", "room_briefs", "discussion_limits"):
                    self.assertEqual(connection.execute(f"SELECT COUNT(*) FROM {table} WHERE room_id=?", (self.room["id"],)).fetchone()[0], 0)
                self.assertEqual(connection.execute("PRAGMA foreign_key_check").fetchall(), [])

    def test_frontend_assets_have_browser_compatible_content_types(self):
        """Compiled assets and every bundled brand icon load through the static routes."""
        assets = {"/": "text/html", "/app.js": "text/javascript",
                  "/modern.js": "text/javascript", "/modern.css": "text/css",
                  "/markdown.js": "text/javascript", "/markdown.css": "text/css",
                  "/icons/LICENSE.txt": "text/plain"}
        icons = Path(__file__).resolve().parent.parent / "web" / "icons"
        for icon in icons.iterdir():
            if not icon.is_file() or icon.name.startswith(".") or icon.name == "LICENSE.txt":
                continue
            content_type = mimetypes.guess_type(icon.name)[0] or ""
            self.assertTrue(content_type.startswith("image/"), f"Unknown icon type: {icon.name}")
            assets[f"/icons/{icon.name}"] = content_type
        for path, content_type in assets.items():
            with self.subTest(path=path), urlopen(self.base + path, timeout=5) as response:
                self.assertEqual(response.status, 200)
                accepted_types = ("text/javascript", "application/javascript") if content_type == "text/javascript" else (content_type,)
                self.assertIn(response.headers["Content-Type"].split(";")[0].strip(), accepted_types)
                content = response.read()
                self.assertTrue(content)
                if path.startswith("/icons/"):
                    self.assertEqual(content, (icons / path.removeprefix("/icons/")).read_bytes())

    def test_room_reads_answer_304_until_their_content_changes(self):
        """The room list and a room's view carry an ETag; a matching If-None-Match gets 304, a change gets the new body."""
        if self.external:
            self.skipTest("ETags are served by the Python site")
        def read(path, etag=None):
            request = Request(self.base + path, headers={"X-Discussion-Token": self.owner, **({"If-None-Match": etag} if etag else {})})
            try:
                response = urlopen(request, timeout=5)
            except HTTPError as error:
                response = error
            with response:
                return response.status, response.headers.get("ETag"), response.read()
        for path in ("/api/rooms", f"/api/rooms/{self.room['id']}"):
            with self.subTest(path=path):
                status, etag, body = read(path)
                self.assertEqual(status, 200)
                self.assertTrue(etag)
                self.assertEqual(read(path, etag)[:2], (304, etag))
                self.assertEqual(read(path, etag)[2], b"")
                self.assertEqual(read(path, '"stale"')[0], 200)
        before = {path: read(path)[1] for path in ("/api/rooms", f"/api/rooms/{self.room['id']}")}
        self.assertEqual(self.request(f"/api/rooms/{self.room['id']}/rename", {"actor": "用户", "title": "再次改名"})[0], 200)
        for path, etag in before.items():
            with self.subTest(after_change=path):
                status, changed, body = read(path, etag)
                self.assertEqual(status, 200)
                self.assertNotEqual(changed, etag)
                self.assertIn("再次改名", body.decode())

    def test_cli_publish_is_idempotent_and_rejects_changed_payload(self):
        """An execution's exact retries retain one original CLI record, even after completion."""
        self.configure_host(experts={"Codex": "cli", "Antigravity": "cli"})
        payload = {"author": "Antigravity", "text": "CLI 原文 & #测试", "submission_id": "cli-once-001", "source": "cli", "kind": "chat"}
        payload.update(self.prepare_speech("Antigravity"))
        path = f"/api/rooms/{self.room['id']}/messages"
        status, first = self.request(path, payload)
        self.assertEqual(status, 201, first)
        self.assertEqual(first["message"]["source"], "cli")
        status, repeated = self.request(path, payload)
        self.assertEqual(status, 200)
        self.assertTrue(repeated["duplicate"])
        self.assertEqual(first["message"], repeated["message"])
        self.assertEqual(self.request(f"/api/rooms/{self.room['id']}")[1]["message_count"], 1)
        self.assertEqual(self.request(path, {**payload,"text":"另一条发言"})[0],409)

    def test_concurrent_creation_replays_and_preserves_updated_topic(self):
        """Concurrent retries create one room; later topic edits do not affect replay."""
        identifier = str(uuid.uuid4())
        payload = {"title": "幂等建房", "goal": "首次目标", "submission_id": identifier}
        before = len(self.request("/api/rooms")[1]["rooms"])
        with ThreadPoolExecutor(max_workers=5) as executor:
            results = list(executor.map(lambda _: self.request("/api/rooms", payload), range(5)))
        self.assertEqual(sorted(status for status, _ in results), [200, 200, 200, 200, 201])
        self.assertEqual(len({room["id"] for _, room in results}), 1)
        room = results[0][1]
        self.request(f"/api/rooms/{room['id']}/topic", {"actor": "用户", "title": "后来修改"})
        replay = self.request("/api/rooms", payload)
        self.assertEqual((replay[0], replay[1]["title"], replay[1]["phase"]), (200, "后来修改", "discussing"))
        self.assertEqual(self.request("/api/rooms", {**payload, "goal": "另一个目标"})[0], 409)
        self.assertEqual(len(self.request("/api/rooms")[1]["rooms"]), before + 1)
        found = self.request("/api/rooms?" + urlencode({"submission_id": identifier}))[1]["rooms"]
        self.assertEqual([item["id"] for item in found], [room["id"]])
        self.assertEqual(self.request("/api/rooms?submission_id=unknown-request")[1]["rooms"], [])
        self.assertEqual(self.request("/api/rooms?submission_id=bad")[0], 400)

    def test_conflicting_room_creations_leave_no_orphan_rooms(self):
        """A losing concurrent payload rolls back its room and topic settings."""
        identifier = str(uuid.uuid4())
        before = len(self.request("/api/rooms")[1]["rooms"])
        with ThreadPoolExecutor(max_workers=5) as executor:
            results = list(executor.map(lambda index: self.request("/api/rooms", {
                "title": f"并发请求 {index}", "submission_id": identifier,
            }), range(5)))
        self.assertEqual(sorted(status for status, _ in results), [201, 409, 409, 409, 409])
        winner = next(room for status, room in results if status == 201)
        self.assertEqual(len(self.request("/api/rooms")[1]["rooms"]), before + 1)
        found = self.request("/api/rooms?" + urlencode({"submission_id": identifier}))[1]["rooms"]
        self.assertEqual(found[0]["id"], winner["id"])

    def test_simultaneous_cli_retries_create_one_record(self):
        """Concurrent replays cannot bypass the submission ID uniqueness rule."""
        payload = {"author": "Codex", "text": "并发重试", "submission_id": "parallel-001", "source": "cli"}
        payload.update(self.prepare_speech("Codex"))
        path = f"/api/rooms/{self.room['id']}/messages"
        with ThreadPoolExecutor(max_workers=5) as executor:
            results = list(executor.map(lambda _: self.request(path, payload), range(5)))
        self.assertEqual(sorted(status for status, _ in results), [200, 200, 200, 200, 201])
        self.assertTrue(all(result["message"]["source"] == "cli" for _, result in results))
        self.assertEqual(self.request(f"/api/rooms/{self.room['id']}")[1]["message_count"], 1)

    def test_retired_url_and_invalid_post_do_not_write(self):
        """Old publishing URLs, HEAD, and invalid POST requests cannot publish."""
        query = urlencode({"author": "Codex", "text": "不能误写", "submission_id": "head-test-001"})
        self.assertEqual(self.request(f"/r/{self.room['id']}/publish?{query}")[0], 410)
        self.assertEqual(self.request(f"/r/{self.room['id']}/publish?{query}", method="HEAD")[0], 501)
        self.assertEqual(self.request(f"/api/rooms/{self.room['id']}/messages", {
            "author": "Codex", "text": "缺少提交编号", "source": "cli",
        })[0], 400)
        self.assertEqual(self.request(f"/api/rooms/{self.room['id']}")[1]["message_count"], 0)

    def test_simultaneous_conflicting_retries_preserve_original(self):
        """One payload wins; concurrent changed payloads cannot overwrite it."""
        with ThreadPoolExecutor(max_workers=5) as executor:
            results = list(executor.map(lambda index: self.post(f"不同原文 {index}", "conflict-001"), range(5)))
        self.assertEqual(sorted(status for status, _ in results), [201, 409, 409, 409, 409])
        winner = next(result["message"] for status, result in results if status == 201)
        stored = self.request(f"/api/rooms/{self.room['id']}/messages")[1]
        self.assertEqual(stored["total"], 1)
        self.assertEqual(stored["messages"][0]["text"], winner["text"])

    def test_cross_room_references_are_rejected(self):
        """Message reads and reply references stay within their room."""
        message_id = self.post("第一间房间", "room-one-001")[1]["message"]["id"]
        other = self.request("/api/rooms", {"title": "另一间"})[1]
        self.assertEqual(self.request(f"/r/{other['id']}/messages/{message_id}")[0], 404)
        self.room = other
        self.assertEqual(self.post("错误引用", "room-two-001", message_id)[0], 400)

    def test_history_pagination_preserves_all_records(self):
        """Readers can retrieve the entire history without one unbounded response."""
        for index in range(23):
            self.post(f"历史消息 {index}", f"history-{index:03}")
        first = self.request(f"/api/rooms/{self.room['id']}/messages?page=1")[1]
        second = self.request(f"/api/rooms/{self.room['id']}/messages?page=2")[1]
        self.assertEqual((len(first["messages"]), len(second["messages"])), (20, 3))
        self.assertEqual(len({row["id"] for row in first["messages"] + second["messages"]}), 23)

    def prepare_speech(self, author, kind="opinion"):
        """Arrange a session request and return the actual execution or manual request binding."""
        if author == "用户":
            return {}
        base = f"/api/rooms/{self.room['id']}"
        session = self.request(base + "/discussion")[1]["session"]
        if not session:
            self.session_action("start", goal="验证请求发言")
        room = self.request(base)[1]
        if kind != "opinion" and author == room["host"]:
            return self.reserve_member(author)
        plans = self.request(base + "/turns")[1]["turns"]
        for turn in plans:
            if turn["purpose"] == "discuss" and turn["status"] == "open":
                self.assertEqual(self.request(base + f"/turns/{turn['id']}", {"actor": "用户", "status": "cancelled"})[0], 200)
        status, result = self.schedule(str(uuid.uuid4()), expert=author)
        self.assertEqual(status, 201, result)
        member = next(item for item in room["members"] if item["name"] == author)
        if member["access"] == "manual":
            return {"request_ids": [result["turn"]["member_request_id"]]}
        return self.reserve_member(author)

    def reserve_member(self, name):
        """Reserve one member execution using the room owner's capability."""
        base = f"/api/rooms/{self.room['id']}"
        member = next(item for item in self.request(base)[1]["members"] if item["name"] == name)
        status, execution = self.request(base + "/executions", {"member_id": member["id"], "client_id": uuid.uuid4().hex})
        self.assertEqual(status, 200, execution)
        return {"execution_id": execution["id"]}

    def session_action(self, action, **values):
        """Read the current control revision before applying a discussion action."""
        base = f"/api/rooms/{self.room['id']}/discussion"
        view = self.request(base)[1]
        status, result = self.request(base, {"action": action, "revision": view["revision"], **values})
        self.assertEqual(status, 200, result)
        return result

    def test_answers_bind_to_their_request_and_other_messages_leave_the_plan_open(self):
        """Answers bind to their issued request; ordinary messages do not finish the discussion plan."""
        self.configure_host()
        base = f"/api/rooms/{self.room['id']}"
        plan = self.schedule()[1]["turn"]
        answer = {"author": "Antigravity", "kind": "chat", "request_ids": [plan["member_request_id"]],
                  "text": "被点名者的真实回答", "submission_id": "floor-answer"}
        self.assertIn(self.request(base + "/messages", {**answer, "author": "Qwen", "submission_id": "floor-wrong"})[0], (400, 403))
        self.assertEqual(self.post("补充约束", "floor-user")[0], 201)
        host_binding = self.reserve_member("Codex")
        self.assertEqual(self.request(base + "/messages", {**host_binding, "author": "Codex", "kind": "chat", "text": "插入主持说明", "submission_id": "floor-host"})[0], 201)
        self.assertEqual(self.request(base + f"/turns/{plan['id']}")[1]["status"], "open")
        status, saved = self.request(base + "/messages", answer)
        self.assertEqual(status, 201, saved)
        self.assertNotIn("turn_id", saved["message"])
        self.assertEqual(self.request(base + f"/turns/{plan['id']}")[1]["status"], "answered")
        self.assertTrue(self.request(base + "/messages", answer)[1]["duplicate"])
        self.assertEqual(self.request(base + "/messages", {**answer, "text": "改过的回答"})[0], 409)
        self.assertEqual(self.request(base + "/messages", {**answer, "submission_id": "floor-late"})[0], 409)

    def configure_host(self, start=True, experts=None):
        """Create a free room with an automatic host and explicit participant capabilities."""
        status, self.room = self.request("/api/rooms", {"title": "讨论请求回归", "host": "Codex",
            "experts": experts or {"Codex": "cli", "Antigravity": "cli"}})
        self.assertEqual(status, 201, self.room)
        for name in self.room["experts"]:
            if name not in self.runner_members:
                self.assertEqual(self.request(f"/api/rooms/{self.room['id']}/register", {}, token=self.member_tokens[name])[0], 200)
        if start:
            self.session_action("start", goal="保持完整记录")
        return self.request(f"/api/rooms/{self.room['id']}")[1]

    def schedule(self, submission_id="schedule-001", **changes):
        """Read the session roster and submit the host's versioned plan."""
        base = f"/api/rooms/{self.room['id']}"
        roster = self.request(base + "/turns/roster")[1]
        payload = {"actor": "Codex", "expert": "Antigravity", "question": "请检查尚未解决的分歧", "submission_id": submission_id}
        return self.request(base + "/turns", {**payload, "roster": roster.get("revision"), **changes})

    def test_interjection_ask_keeps_queue_and_other_host_requests(self):
        """Versioned conversion closes only one source, even when a host execution contains two."""
        self.configure_host(experts={"Codex": "cli", "Antigravity": "cli", "Claude": "cli"})
        base = f"/api/rooms/{self.room['id']}"
        self.schedule("ask-queue-plan", turns=[{"expert": name, "question": "请分析"} for name in ("Antigravity", "Claude")])
        first = self.post("请解释第一处风险", "ask-source-one")[1]["message"]["id"]
        stale = self.request(base + "/turns/roster")[1]
        second = self.post("请解释第二处风险", "ask-source-two")[1]["message"]["id"]
        binding = self.reserve_member("Codex")
        roster = self.request(base + "/turns/roster")[1]
        source = next(item for item in roster["host_requests"] if item["message_id"] == first)
        payload = {"actor": "Codex", "request_id": source["id"], "expert": "Antigravity", "submission_id": "ask-convert-one"}
        self.assertEqual(self.request(base + "/turns/ask", payload)[0], 400)
        self.assertEqual(self.request(base + "/turns/ask", {**payload, "revision": stale["revision"]})[0], 409)
        payload["revision"] = roster["revision"]
        self.assertEqual(self.request(base + "/turns/ask", {**payload, "actor": "Claude"})[0], 403)
        status, result = self.request(base + "/turns/ask", payload)
        self.assertEqual(status, 201, result)
        self.assertEqual((result["request"]["purpose"], result["request"]["message_id"]), ("ask", first))
        self.assertFalse(result["execution_completed"])
        latest = self.request(base + "/turns/roster")[1]
        self.assertEqual((latest["queue"], latest["waiting"]), (roster["queue"], roster["waiting"]))
        self.assertEqual([item["message_id"] for item in latest["host_requests"]], [second])
        self.assertEqual(latest["held_since"], second)
        self.assertTrue(self.request(base + "/turns/ask", payload)[1]["duplicate"])
        self.assertEqual(self.request(base + "/turns/ask", {**payload, "expert": "Codex"})[0], 409)
        second_payload = {**payload, "request_id": latest["host_requests"][0]["id"], "expert": "Codex",
                          "revision": latest["revision"], "submission_id": "ask-convert-two"}
        status, result = self.request(base + "/turns/ask", second_payload)
        self.assertEqual(status, 201, result)
        self.assertTrue(result["execution_completed"])
        self.assertTrue(self.request(base + "/turns/ask", second_payload)[1]["execution_completed"])
        self.assertEqual(self.request(base + "/turns/roster")[1]["held_since"], 0)
        self.assertEqual(self.request(base + f"/executions/{binding['execution_id']}")[1]["status"], "completed")

    def test_user_request_is_preserved_separately_through_writes_and_backup(self):
        """Keep original whitespace, enforce bounds, and include it in replay checks."""
        original = "  用户原文🙂\n保留换行与空白  \n"
        payload = {"title": "原文与背景", "user_request": original, "background": "项目补充背景",
                   "submission_id": str(uuid.uuid4())}
        status, room = self.request("/api/rooms", payload)
        self.assertEqual(status, 201)
        self.assertEqual((room["user_request"], room["background"]), (original, "项目补充背景"))
        base = f"/api/rooms/{room['id']}"
        self.assertTrue(self.request("/api/rooms", payload)[1]["duplicate"])
        self.assertEqual(self.request("/api/rooms", {**payload, "user_request": "另一请求"})[0], 409)
        self.assertEqual(self.request(base + "/topic", {"actor": "用户", "background": "更新背景"})[1]["user_request"], original)
        text = self.request(f"/r/{room['id']}/brief")[1]
        self.assertIn(f"用户原文：\n{original}\n\n背景：\n更新背景", text)
        self.assertNotIn(original, self.request(f"/r/{room['id']}")[1])
        tables = self.request(base + "/backup")[1]["tables"]
        self.assertEqual(tables["room_user_requests"], [{"room_id": room["id"], "text": original}])
        self.assertEqual(self.request(base + "/topic", {"actor": "用户", "user_request": "🙂" * 4000})[0], 200)
        self.assertEqual(self.request(base + "/topic", {"actor": "用户", "user_request": "🙂" * 4001})[0], 400)
        self.assertEqual(self.request(base)[1]["user_request"], "🙂" * 4000)
        cleared = self.request(base + "/topic", {"actor": "用户", "user_request": ""})[1]
        self.assertEqual((cleared["user_request"], cleared["background"]), ("", "更新背景"))
        self.assertEqual(self.request(base + "/delete", {"actor": "用户", "confirm_title": room["title"]})[0], 200)

    def test_overview_discloses_context_only_through_explicit_pages(self):
        """Entry pages never inline background, state text, or mentioned messages."""
        self.configure_host()
        self.request(f"/api/rooms/{self.room['id']}/topic", {"actor": "Codex", "background": "BACKGROUND_ONLY", "boundaries": "BOUNDARIES_ONLY"})
        self.post("@Antigravity MESSAGE_ONLY", "progressive-001")
        self.request(f"/api/rooms/{self.room['id']}/state", {"actor": "Codex", "text": "STATE_ONLY"})
        base = f"/r/{self.room['id']}"
        overview = self.request(base + "?participant=Antigravity")[1]
        for marker in ("BACKGROUND_ONLY", "BOUNDARIES_ONLY", "STATE_ONLY", "MESSAGE_ONLY"):
            self.assertNotIn(marker, overview)
        for route in ("/brief", "/state", "/search?mention=Antigravity", "/messages?page=1"):
            self.assertIn(route, overview)
        self.assertIn("BACKGROUND_ONLY", self.request(base + "/brief")[1])
        self.assertIn("STATE_ONLY", self.request(base + "/state")[1])
        self.assertIn("MESSAGE_ONLY", self.request(base + "/search?mention=Antigravity")[1])
        protocol = self.request(base + "/protocol")[1]
        self.assertIn("当前主持人：Codex", protocol)
        self.assertIn("--kind chat --execution", protocol)

    def test_host_speech_keeps_its_authorship_and_cannot_answer_for_others(self):
        """The host's own answer keeps its author and source; it cannot submit another member's answer."""
        self.configure_host()
        path = f"/api/rooms/{self.room['id']}/messages"
        payload = {"author": "Codex", "text": "个人观点", "source": "cli", "kind": "chat", "submission_id": "host-opinion-001"}
        payload.update(self.prepare_speech("Codex"))
        opinion = self.request(path, payload)[1]["message"]
        self.assertEqual((opinion["kind"], opinion["source"], opinion["submitted_by"]), ("chat", "cli", "Codex"))
        binding = self.prepare_speech("Codex", "moderation")
        moderation = self.request(path, {**binding, "author": "Codex", "text": "请回到议题", "kind": "chat", "submission_id": "host-control-001"})[1]["message"]
        self.assertEqual(moderation["author"], "Codex")
        forwarded = {"author": "Antigravity", "submitted_by": "Codex", "text": "替他人回答", "reply_to": opinion["id"], "submission_id": "host-forward-001"}
        self.assertEqual(self.request(path, forwarded, token=self.member_tokens["Codex"])[0], 403)
        original = self.request(f"/r/{self.room['id']}/messages/{opinion['id']}")[1]
        self.assertIn("提交者：Codex", original)

    def test_host_conclusion_requires_current_state_and_keeps_the_room_writable(self):
        """A host concludes with the latest snapshot while its task is stopped and history remains."""
        self.configure_host()
        base = f"/api/rooms/{self.room['id']}"
        execution = self.reserve_member("Codex")["execution_id"]
        self.assertEqual(self.request(base + "/limits", {"actor": "Codex", "action": "done"})[0], 400)
        stale = self.request(base + "/conclusion")[1]["revision"]
        self.post("补充结论要求", "conclude-extra-requirement")
        self.assertEqual(self.request(base + "/limits", {"actor": "Codex", "action": "done", "conclusion": stale})[0], 409)
        self.assertEqual(self.request(base + "/state", {"actor": "Codex", "text": "最终共识"})[0], 200)
        conclusion = self.request(base + "/conclusion")[1]
        status, result = self.request(base + "/limits", {"actor": "Codex", "action": "done", "conclusion": conclusion["revision"]})
        self.assertEqual(status, 200, result)
        room = self.request(base)[1]
        self.assertEqual(room["mode"], "free")
        self.assertEqual(room["session"]["status"], "concluded")
        self.assertEqual(room["discussions"][-1]["stop_reason"], "goal_done")
        self.assertEqual(next(item for item in room["free"]["executions"] if item["id"] == execution)["status"], "cancelled")
        self.assertEqual(self.post("讨论结束后继续协作", "conclude-followup")[0], 201)
        self.assertEqual(self.request(base + "/limits", {"actor": "用户", "action": "reopen"})[0], 400)
        self.assertEqual(self.session_action("start", goal="再次讨论")["session"]["status"], "active")

    def test_session_request_answer_and_retry_lifecycle(self):
        """Reading never claims delivery; one bound answer completes its plan and exact retries remain safe."""
        self.configure_host()
        status, created = self.schedule()
        self.assertEqual(status, 201, created)
        plan = created["turn"]
        base = f"/api/rooms/{self.room['id']}"
        path = base + f"/turns/{plan['id']}"
        self.assertEqual(plan["status"], "open")
        self.assertTrue(self.schedule()[1]["duplicate"])
        self.assertEqual(self.schedule(question="另一问题")[0], 409)
        self.assertEqual(self.request(path)[1]["status"], "open")
        self.assertEqual(self.request(path, {"actor": "Codex", "status": "notified"})[0], 400)
        payload = {"author": "Antigravity", "text": "专家的回答", "request_ids": [plan["member_request_id"]], "submission_id": "turn-answer-001"}
        status, result = self.request(base + "/messages", payload)
        self.assertEqual(status, 201, result)
        self.assertEqual(self.request(path)[1]["status"], "answered")
        member_request = next(item for item in self.request(base)[1]["free"]["requests"] if item["id"] == plan["member_request_id"])
        self.assertEqual(member_request["answer_id"], result["message"]["id"])
        self.assertTrue(self.request(base + "/messages", payload)[1]["duplicate"])
        self.assertEqual(self.schedule("schedule-next-001")[0], 201)

    def test_independent_pause_and_resume_lifecycle(self):
        """Pause cancels old work, resume requires a fresh plan, and conclusion leaves ordinary collaboration available."""
        self.configure_host()
        base = f"/api/rooms/{self.room['id']}"
        self.assertEqual(self.request(base + "/discussion")[1]["session"]["phase"], "initial")
        plan = self.schedule()[1]["turn"]
        answer = {"author": "Antigravity", "text": "独立结论及依据", "request_ids": [plan["member_request_id"]], "submission_id": "initial-answer-001"}
        self.session_action("pause")
        self.assertEqual(self.request(base + "/messages", answer)[0], 409)
        self.assertEqual(self.schedule("paused-turn-001")[0], 400)
        self.assertEqual(self.request(base + f"/turns/{plan['id']}")[1]["status"], "cancelled")
        self.assertEqual(self.request(base + "/messages", {"author": "Antigravity", "kind": "receipt", "text": "旧回执", "submission_id": "stop-receipt-001"})[0], 400)
        self.session_action("resume")
        answer.update(self.prepare_speech("Antigravity"))
        self.assertEqual(self.request(base + "/messages", answer)[0], 201)
        self.assertEqual(self.request(base + "/discussion")[1]["session"]["phase"], "discussing")
        self.assertEqual(self.request(base + "/topic", {"actor": "Codex", "phase": "reviewing"})[0], 400)
        self.session_action("end")
        self.assertTrue(self.request(base + "/messages", answer)[1]["duplicate"])
        ordinary = {"author": "Antigravity", "text": "自由协作原文", "submission_id": "late-chat-001"}
        status, saved = self.request(base + "/messages", ordinary)
        self.assertEqual((status, saved["message"]["kind"]), (201, "chat"))

    def test_concurrent_scheduling_accepts_only_one_plan_for_a_roster_revision(self):
        """Parallel host actions sharing a revision cannot both apply different plans."""
        self.configure_host()
        base=f"/api/rooms/{self.room['id']}"
        revision=self.request(base+"/turns/roster")[1]["revision"]
        def schedule(index):
            return self.request(base+"/turns",{"actor":"Codex","expert":"Antigravity","question":"并发安排","submission_id":f"schedule-race-{index}","roster":revision})
        with ThreadPoolExecutor(max_workers=5) as executor:
            results=list(executor.map(schedule,range(5)))
        self.assertEqual(sorted(status for status,_ in results),[201,409,409,409,409])
        plans=[plan for plan in self.request(base+"/turns")[1]["turns"] if plan["purpose"]=="discuss"]
        self.assertEqual(len(plans),1)
        self.assertEqual(plans[0]["status"],"open")

    def test_concurrent_answers_preserve_one_attributed_original(self):
        """One assignment accepts only one answer even with different submissions."""
        self.configure_host()
        turn = self.schedule()[1]["turn"]
        payload = {"author": "Antigravity", "text": "并发回答", "request_ids": [turn["member_request_id"]]}
        path = f"/api/rooms/{self.room['id']}/messages"
        with ThreadPoolExecutor(max_workers=5) as executor:
            results = list(executor.map(lambda index: self.request(path, {**payload, "submission_id": f"answer-race-{index}"}), range(5)))
        self.assertEqual(sorted(status for status, _ in results), [201, 409, 409, 409, 409])
        self.assertEqual(self.request(f"/api/rooms/{self.room['id']}")[1]["message_count"], 1)

    def test_cancellation_racing_an_answer_keeps_consistent_state(self):
        """The request ends once: cancellation and a linked answer cannot both change it."""
        self.configure_host()
        plan=self.schedule()[1]["turn"]
        base=f"/api/rooms/{self.room['id']}"
        barrier=threading.Barrier(2)
        def cancel_or_answer(cancel):
            barrier.wait()
            if cancel:
                return self.request(base+f"/turns/{plan['id']}",{"actor":"用户","status":"cancelled"})
            return self.request(base+"/messages",{"author":"Antigravity","text":"正在提交的回答","request_ids":[plan["member_request_id"]],"submission_id":"cancel-race-001"})
        with ThreadPoolExecutor(max_workers=2) as executor:
            results=list(executor.map(cancel_or_answer,[True,False]))
        stored=self.request(base+f"/turns/{plan['id']}")[1]
        if stored["status"]=="cancelled":
            self.assertEqual([status for status,_ in results],[200,409])
            self.assertEqual(self.request(base)[1]["message_count"],0)
        else:
            self.assertEqual(stored["status"],"answered")
            self.assertIn(results[0][0],(200,409))
            self.assertEqual(results[1][0],201)
            self.assertEqual(self.request(base)[1]["message_count"],1)


class SessionGuardTests(unittest.TestCase):
    """Verify the discussion session state machine directly against isolated storage."""

    def test_session_guards_reject_stale_controls_and_two_open_discuss_requests(self):
        """The new state machine validates the read revision and database-level single-open invariant."""
        from backend.session_room import create_plan, discussion_action, roster_view, session_room
        with tempfile.TemporaryDirectory() as directory:
            database=Path(directory)/"session-guards.sqlite3"
            init_database(database,seed=False)
            with closing(connect_db(database)) as connection,connection:
                owner=uuid.uuid4().hex
                room=create_room(connection,{"title":"并发会话校验","host":"Codex","members":[
                    {"name":"Codex","access":"runner","token":uuid.uuid4().hex},
                    {"name":"Antigravity","access":"runner","token":uuid.uuid4().hex}]},owner)
                initial=session_room(connection,room["id"])
                discussion_action(connection,room["id"],owner,{"action":"start","revision":initial["revision"],"goal":"守住事务"},room)
                roster=roster_view(connection,room["id"])
                payload={"actor":"Codex","expert":"Antigravity","question":"问题","roster":roster["revision"],"submission_id":"guard-plan-001"}
                plan=create_plan(connection,room["id"],payload,room)["turn"]
                connection.commit()
                with self.assertRaises(FileExistsError),connection:
                    create_plan(connection,room["id"],{**payload,"submission_id":"guard-plan-002"},room)
                with self.assertRaises(sqlite3.IntegrityError),connection:
                    connection.execute("INSERT INTO session_requests(session_id,round,position,member_id,purpose,question,status,submission_id,created_at) VALUES(?,1,2,?,'discuss','重复open','open','guard-duplicate','test')",(plan["session_id"],plan["member_id"]))
                self.assertEqual(connection.execute("SELECT COUNT(*) FROM session_requests WHERE purpose='discuss' AND status='open'").fetchone()[0],1)
                current=session_room(connection,room["id"])
                discussion_action(connection,room["id"],owner,{"action":"pause","revision":current["revision"]},room)
                connection.commit()
                with self.assertRaises(ValueError),connection:
                    create_plan(connection,room["id"],{**payload,"submission_id":"paused-plan-001","roster":roster_view(connection,room["id"])["revision"]},room)


if __name__ == "__main__":
    unittest.main(verbosity=2)

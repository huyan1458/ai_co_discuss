"""Backend boundary tests for group sourced MOSS task rooms."""

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
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from backend.server import DiscussionServer, init_database


class MossWindowDelegationTests(unittest.TestCase):
    """Exercise the HTTP credentials and source-room limits for group delegation."""

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        self.service_home = root / "service"
        self.service_home.mkdir()
        self.workspace = root / "workspace"
        self.workspace.mkdir()
        (self.service_home / "local-settings.json").write_text(
            json.dumps({"workspace": str(self.workspace)}), encoding="utf-8")
        self.database = root / "rooms.sqlite3"
        init_database(self.database, seed=False)
        with patch.dict(os.environ, {"DISCUSS_SERVICE_HOME": str(self.service_home)}):
            server = DiscussionServer(("127.0.0.1", 0), self.database)
        server.daemon_threads = False
        self.addCleanup(server.server_close)
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        thread.start()
        self.addCleanup(thread.join)
        self.addCleanup(server.shutdown)
        self.base = f"http://127.0.0.1:{server.server_port}"

    def request(self, path, body=None, token="", *, headers=None):
        data = json.dumps(body).encode() if body is not None else None
        request_headers = dict(headers or {})
        if data is not None:
            request_headers.setdefault("Content-Type", "application/json")
        if token:
            request_headers["X-Discussion-Token"] = token
        try:
            response = urlopen(Request(self.base + path, data=data, headers=request_headers), timeout=5)
        except HTTPError as error:
            response = error
        with response:
            return response.status, json.load(response)

    def create_group(self, channel="telegram", chat_id="delegation-group"):
        owner_token, member_token = uuid.uuid4().hex, uuid.uuid4().hex
        payload = {
            "title": "群聊窗口", "host": "Codex", "system_kind": "steward_group",
            "window": {"channel": channel, "chat_id": chat_id},
            "members": [{"name": "Codex", "adapter": "codex_cli", "token": member_token,
                         "access": "runner", "session_mode": "new"}],
            "submission_id": uuid.uuid4().hex,
        }
        status, room = self.request("/api/rooms", payload, owner_token)
        self.assertEqual(status, 201, room)
        return room["id"], owner_token, member_token, channel, chat_id

    def start_group_execution(self, group_id, owner_token):
        message_id = self.request(f"/api/rooms/{group_id}/messages", {
            "author": "用户", "text": "请委托完成一项工作",
            "external": {"sender_id": "sender-1", "sender_name": "访客",
                         "message_id": uuid.uuid4().hex, "mentioned": True, "owner": False},
            "submission_id": uuid.uuid4().hex,
        }, owner_token)[1]["message"]["id"]
        self.request(f"/api/rooms/{group_id}/window-wake", {"message_id": message_id}, owner_token)
        member = self.request(f"/api/rooms/{group_id}")[1]["free"]["members"][0]
        status, execution = self.request(f"/api/rooms/{group_id}/executions", {
            "member_id": member["id"], "client_id": uuid.uuid4().hex,
        }, owner_token)
        self.assertEqual(status, 200, execution)
        return message_id, execution["id"]

    def task_payload(self, group_id, channel, chat_id, source_message_id, execution_id, *,
                     submission_id=None, cwd=None, project_access="write", preset="task"):
        submission_id = submission_id or uuid.uuid4().hex
        group_key = hashlib.sha256(f"{channel}:{chat_id}".encode()).hexdigest()
        expected_cwd = self.workspace / "steward-windows" / group_key / "work" / submission_id
        return {
            "title": "群委托任务", "host": "Codex", "preset": preset,
            "source_window_id": group_id, "execution_id": execution_id,
            "source_message_id": source_message_id, "project_access": project_access,
            "cwd": str(cwd if cwd is not None else expected_cwd), "submission_id": submission_id,
            "members": [{"name": "Codex", "adapter": "codex_cli", "token": uuid.uuid4().hex,
                         "access": "runner", "session_mode": "new"}],
        }

    def create_delegated_task(self, group_id, owner_token, member_token, payload):
        headers = {"X-Acting-Member-Token": member_token,
                   "X-Discussion-Window-Token": owner_token}
        task_owner_token = uuid.uuid4().hex
        status, room = self.request("/api/rooms", payload, task_owner_token, headers=headers)
        return status, room, task_owner_token

    def test_private_and_main_steward_rooms_keep_messages_and_credentials_separate(self):
        rooms = {}
        for kind in ("steward", "steward_private"):
            owner_token, member_token = uuid.uuid4().hex, uuid.uuid4().hex
            status, room = self.request("/api/rooms", {
                "title": kind, "host": "Codex", "system_kind": kind,
                "members": [{"name": "Codex", "adapter": "codex_cli", "token": member_token,
                             "access": "runner", "session_mode": "new"}],
                "submission_id": uuid.uuid4().hex,
            }, owner_token)
            self.assertEqual(status, 201, room)
            rooms[kind] = (room["id"], owner_token)
        messages = {}
        for kind, (room_id, token) in rooms.items():
            status, result = self.request(f"/api/rooms/{room_id}/messages", {
                "author": "用户", "text": f"{kind} 的独立请求", "submission_id": uuid.uuid4().hex,
            }, token)
            self.assertEqual(status, 201, result)
            messages[kind] = result["message"]["id"]
        for kind, (room_id, token) in rooms.items():
            other_kind = "steward_private" if kind == "steward" else "steward"
            remote_headers = {"Sec-Fetch-Site": "cross-site"}
            view = self.request(f"/api/rooms/{room_id}/messages", token=token, headers=remote_headers)[1]
            stored_ids = {message["id"] for message in view["messages"]}
            self.assertIn(messages[kind], stored_ids)
            self.assertNotIn(messages[other_kind], stored_ids)
            other_room = rooms[other_kind][0]
            self.assertEqual(self.request(f"/api/rooms/{other_room}/messages", token=token)[0], 403)
        executions = {}
        for kind, (room_id, token) in rooms.items():
            member = self.request(f"/api/rooms/{room_id}", token=token)[1]["free"]["members"][0]
            status, run = self.request(f"/api/rooms/{room_id}/executions", {
                "member_id": member["id"], "client_id": uuid.uuid4().hex,
            }, token)
            self.assertEqual(status, 200, run)
            executions[kind] = run["id"]
        self.assertNotEqual(executions["steward"], executions["steward_private"])
        site = "https://paired.example"
        bridge = uuid.uuid4().hex + uuid.uuid4().hex
        (self.service_home / "site-connections.json").write_text(json.dumps({
            "sites": {site: {"bridge_hash": hashlib.sha256(bridge.encode()).hexdigest()}},
        }), encoding="utf-8")
        private_id = rooms["steward_private"][0]
        self.assertEqual(self.request(f"/api/rooms/{private_id}", headers={
            "Origin": site, "X-CoDiscuss-Bridge": bridge, "X-CoDiscuss-Bridge-Site": site,
        })[0], 200)

    def test_group_can_create_only_task_rooms_inside_its_workspace(self):
        group_id, owner_token, member_token, channel, chat_id = self.create_group()
        source_message_id, execution_id = self.start_group_execution(group_id, owner_token)
        bad_cwds = (self.workspace / "outside", self.workspace / "steward-windows" / "other" / "work" / "x")
        for cwd in bad_cwds:
            with self.subTest(cwd=cwd):
                payload = self.task_payload(group_id, channel, chat_id, source_message_id, execution_id, cwd=cwd)
                self.assertEqual(self.create_delegated_task(group_id, owner_token, member_token, payload)[0], 403)
        for field, value in (("preset", ""), ("project_access", "read")):
            with self.subTest(field=field):
                payload = self.task_payload(group_id, channel, chat_id, source_message_id, execution_id)
                payload[field] = value
                self.assertEqual(self.create_delegated_task(group_id, owner_token, member_token, payload)[0], 400)

        payload = self.task_payload(group_id, channel, chat_id, source_message_id, execution_id)
        status, task, _ = self.create_delegated_task(group_id, owner_token, member_token, payload)
        self.assertEqual(status, 201, task)
        self.assertEqual((task["preset"], task["source_window_id"], task["source_message_id"]),
                         ("task", group_id, source_message_id))
        self.assertEqual(self.request(f"/api/rooms/{task['id']}")[1]["source_window_id"], group_id)

    def test_group_creation_requires_both_source_credentials_and_active_host_execution(self):
        group_id, owner_token, member_token, channel, chat_id = self.create_group()
        source_message_id, execution_id = self.start_group_execution(group_id, owner_token)
        payload = self.task_payload(group_id, channel, chat_id, source_message_id, execution_id)
        headers = {"X-Acting-Member-Token": member_token,
                   "X-Discussion-Window-Token": uuid.uuid4().hex}
        self.assertEqual(self.request("/api/rooms", payload, uuid.uuid4().hex, headers=headers)[0], 403)
        headers["X-Discussion-Window-Token"] = owner_token
        headers["X-Acting-Member-Token"] = uuid.uuid4().hex
        self.assertEqual(self.request("/api/rooms", payload, uuid.uuid4().hex, headers=headers)[0], 403)
        payload["execution_id"] = uuid.uuid4().hex
        headers["X-Acting-Member-Token"] = member_token
        self.assertEqual(self.request("/api/rooms", payload, uuid.uuid4().hex, headers=headers)[0], 400)
        payload["execution_id"] = execution_id + 1
        self.assertEqual(self.request("/api/rooms", payload, uuid.uuid4().hex, headers=headers)[0], 403)

    def test_legacy_task_marker_survives_source_window_migration(self):
        status, task = self.request("/api/rooms", {
            "title": "原有任务房间", "host": "Codex", "preset": "task", "submission_id": uuid.uuid4().hex,
            "members": [{"name": "Codex", "token": uuid.uuid4().hex}],
        }, uuid.uuid4().hex)
        self.assertEqual(status, 201, task)
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute("DROP TABLE moss_task_rooms")
            connection.execute("CREATE TABLE moss_task_rooms(room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE)")
            connection.execute("INSERT INTO moss_task_rooms VALUES(?)", (task["id"],))
        init_database(self.database, seed=False)
        view = self.request(f"/api/rooms/{task['id']}")[1]
        self.assertEqual(view["preset"], "task")
        self.assertNotIn("source_window_id", view)

    def test_group_host_can_post_only_to_its_own_delegated_task(self):
        group_id, owner_token, member_token, channel, chat_id = self.create_group()
        source_message_id, execution_id = self.start_group_execution(group_id, owner_token)
        payload = self.task_payload(group_id, channel, chat_id, source_message_id, execution_id)
        status, task, task_owner_token = self.create_delegated_task(group_id, owner_token, member_token, payload)
        self.assertEqual(status, 201, task)
        task_id = task["id"]
        host_headers = {"X-Acting-Member-Token": member_token}
        relay = {"target_room_id": task_id, "text": "开始处理", "execution_id": execution_id,
                 "submission_id": uuid.uuid4().hex}
        status, sent = self.request(f"/api/rooms/{group_id}/host-room-post", relay, owner_token,
                                    headers=host_headers)
        self.assertEqual(status, 200, sent)
        self.assertTrue(sent.get("message") or sent.get("queued"))

        task_view = self.request(f"/api/rooms/{task_id}", token=task_owner_token)[1]
        task_member = task_view["free"]["members"][0]
        status, run = self.request(f"/api/rooms/{task_id}/executions", {
            "member_id": task_member["id"], "client_id": uuid.uuid4().hex,
        }, task_owner_token)
        self.assertEqual(status, 200, run)
        status, answer = self.request(f"/api/rooms/{task_id}/messages", {
            "author": task_member["name"], "text": "委托结果已完成", "execution_id": run["id"],
            "submission_id": uuid.uuid4().hex,
        }, payload["members"][0]["token"])
        self.assertEqual(status, 201, answer)
        group_requests = self.request(f"/api/rooms/{group_id}", token=owner_token)[1]["free"]["requests"]
        review = [item for item in group_requests if item["purpose"] == "notice"
                  and item["chain_id"] == source_message_id]
        self.assertEqual(len(review), 1)

        ordinary_owner = uuid.uuid4().hex
        status, ordinary = self.request("/api/rooms", {
            "title": "普通房间", "host": "Codex", "submission_id": uuid.uuid4().hex,
            "members": [{"name": "Codex", "adapter": "codex_cli", "token": uuid.uuid4().hex,
                         "access": "runner", "session_mode": "new"}],
        }, ordinary_owner)
        self.assertEqual(status, 201, ordinary)
        relay["target_room_id"] = ordinary["id"]
        relay["submission_id"] = uuid.uuid4().hex
        self.assertEqual(self.request(f"/api/rooms/{group_id}/host-room-post", relay, owner_token,
                                      headers=host_headers)[0], 403)


if __name__ == "__main__":
    unittest.main()

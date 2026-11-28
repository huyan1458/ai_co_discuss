"""HTTP contract tests for MOSS group-window rooms."""

import unittest
import uuid
import json
import tempfile
import threading
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from backend.server import DiscussionServer, init_database


class GroupWindowTests(unittest.TestCase):
    """Use the steward test server harness without inheriting its test cases."""

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        database = Path(directory.name) / "group-windows.sqlite3"
        init_database(database, seed=False)
        server = DiscussionServer(("127.0.0.1", 0), database)
        server.daemon_threads = False
        self.addCleanup(server.server_close)
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        thread.start()
        self.addCleanup(thread.join)
        self.addCleanup(server.shutdown)
        self.base = f"http://127.0.0.1:{server.server_port}"
        self.owner = uuid.uuid4().hex
        self.member = uuid.uuid4().hex

    def request(self, path, body=None, token="", *, headers=None):
        data = json.dumps(body).encode() if body is not None else None
        headers = dict(headers or {})
        if data is not None:
            headers.setdefault("Content-Type", "application/json")
        if token:
            headers["X-Discussion-Token"] = token
        try:
            response = urlopen(Request(self.base + path, data=data, headers=headers), timeout=5)
        except HTTPError as error:
            response = error
        with response:
            return response.status, json.load(response)

    def create(self):
        return self.request("/api/rooms", {
            "title": "普通房间", "host": "Codex", "members": [{"name": "Codex", "token": self.member}],
            "submission_id": uuid.uuid4().hex,
        }, self.owner)

    def create_group(self, *, channel="telegram", chat_id="group-1", owner_token=None, member_token=None):
        owner_token = owner_token or uuid.uuid4().hex
        member_token = member_token or uuid.uuid4().hex
        payload = {
            "title": "群聊窗口", "host": "Codex", "system_kind": "steward_group",
            "window": {"channel": channel, "chat_id": chat_id},
            "members": [{"name": "Codex", "token": member_token}],
            "submission_id": uuid.uuid4().hex,
        }
        status, room = self.request("/api/rooms", payload, owner_token)
        self.assertEqual(status, 201, room)
        return room["id"], owner_token, member_token, payload

    def create_external_message(self, room_id, owner_token, *, message_id="external-1", text="请处理"):
        source = {"sender_id": "sender-1", "sender_name": "小林", "message_id": message_id,
                  "mentioned": True, "owner": False}
        status, result = self.request(f"/api/rooms/{room_id}/messages", {
            "author": "用户", "text": text, "external": source, "submission_id": uuid.uuid4().hex,
        }, owner_token)
        self.assertEqual(status, 201, result)
        return result["message"], source

    def test_room_identity_reuses_only_the_same_channel_chat_pair(self):
        room_id, owner_token, _, payload = self.create_group(chat_id="chat-1")
        status, duplicate = self.request("/api/rooms", {**payload, "submission_id": uuid.uuid4().hex}, owner_token)
        self.assertEqual(status, 200, duplicate)
        self.assertEqual(duplicate["id"], room_id)
        other_payload = {**payload, "window": {"channel": "telegram", "chat_id": "chat-2"},
                         "submission_id": uuid.uuid4().hex}
        status, other = self.request("/api/rooms", other_payload, owner_token)
        self.assertEqual(status, 201, other)
        self.assertNotEqual(other["id"], room_id)
        invalid = {**payload, "members": payload["members"] + [{"name": "Claude", "token": uuid.uuid4().hex}],
                   "submission_id": uuid.uuid4().hex}
        self.assertEqual(self.request("/api/rooms", invalid, owner_token)[0], 400)

    def test_external_sources_require_owner_credential_and_deduplicate_platform_messages(self):
        room_id, owner_token, member_token, _ = self.create_group()
        base = f"/api/rooms/{room_id}/messages"
        source = {"sender_id": "sender-1", "sender_name": "小林", "message_id": "platform-1",
                  "mentioned": True, "owner": False}
        payload = {"author": "用户", "text": "查一下", "external": source,
                   "submission_id": uuid.uuid4().hex}
        status, result = self.request(base, payload, owner_token)
        self.assertEqual(status, 201, result)
        message = result["message"]
        self.assertEqual((message["author"], message["author_label"]), ("external:sender-1", "小林"))
        self.assertEqual(message["external"], source)
        status, duplicate = self.request(base, {**payload, "text": "重放时的不同文本",
            "submission_id": uuid.uuid4().hex}, owner_token)
        self.assertEqual(status, 200, duplicate)
        self.assertEqual(duplicate["message"]["id"], message["id"])
        self.assertTrue(duplicate["duplicate"])
        self.assertEqual(duplicate["message"]["text"], "查一下")
        self.assertEqual(self.request(base, {"author": "用户", "text": "无来源",
            "submission_id": uuid.uuid4().hex}, owner_token)[0], 400)
        self.assertEqual(self.request(base, payload, member_token)[0], 403)
        self.assertEqual(self.request(base, payload)[0], 403)
        ordinary_id = self.create()[1]["id"]
        self.assertEqual(self.request(f"/api/rooms/{ordinary_id}/messages", payload, self.owner)[0], 400)

    def test_same_platform_message_id_is_independent_across_group_rooms(self):
        first_id, first_owner, _, _ = self.create_group(chat_id="chat-a")
        second_id, second_owner, _, _ = self.create_group(chat_id="chat-b")
        first, _ = self.create_external_message(first_id, first_owner, message_id="reused-platform-id")
        second, _ = self.create_external_message(second_id, second_owner, message_id="reused-platform-id")
        self.assertNotEqual(first["id"], second["id"])

    def test_external_message_is_not_dispatched_until_owner_wakes_it_once(self):
        room_id, owner_token, member_token, _ = self.create_group()
        base = f"/api/rooms/{room_id}"
        message, _ = self.create_external_message(room_id, owner_token)
        self.assertEqual(self.request(base)[1]["free"]["requests"], [])
        path = base + "/window-wake"
        self.assertEqual(self.request(path, {"message_id": message["id"]}, member_token)[0], 403)
        status, wake = self.request(path, {"message_id": message["id"]}, owner_token)
        self.assertEqual(status, 200, wake)
        self.assertEqual(wake["message_id"], message["id"])
        status, replay = self.request(path, {"message_id": message["id"]}, owner_token)
        self.assertEqual(status, 200, replay)
        self.assertTrue(replay["duplicate"])
        self.assertEqual(replay["request_id"], wake["request_id"])
        requests = self.request(base)[1]["free"]["requests"]
        self.assertEqual([item["message_id"] for item in requests], [message["id"]])

    def test_group_credentials_are_scoped_to_their_room_and_cannot_read_global_stats(self):
        group_id, _, member_token, _ = self.create_group()
        other_id = self.create()[1]["id"]
        self.assertEqual(self.request(f"/api/rooms/{group_id}", token=member_token)[0], 200)
        for path in (f"/api/rooms/{other_id}/messages", f"/api/rooms/{other_id}/events"):
            with self.subTest(path=path):
                self.assertEqual(self.request(path, token=member_token)[0], 403)
                self.assertEqual(self.request(path, token=member_token,
                    headers={"X-Discussion-Read-Only": "1"})[0], 403)
                group_read = self.request(f"/api/rooms/{group_id}", headers={"X-Discussion-Read-Only": "1"})
                self.assertEqual(group_read[0], 403)
        self.assertEqual(self.request("/api/analytics/moss", token=member_token)[0], 403)
        self.assertEqual(self.request("/api/rooms")[0], 200)
        self.assertIn(group_id, [room["id"] for room in self.request("/api/rooms")[1]["rooms"]])
        lookup_headers = {"X-Discussion-Read-Only": "1"}
        self.assertEqual(self.request("/api/rooms", token=member_token, headers=lookup_headers)[0], 403)
        task_directory = self.request("/api/rooms", token=self.member, headers=lookup_headers)
        self.assertEqual(task_directory[0], 200)
        self.assertNotIn(group_id, [room["id"] for room in task_directory[1]["rooms"]])
        other_owner, other_member = uuid.uuid4().hex, uuid.uuid4().hex
        status, ordinary = self.request("/api/rooms", {"title": "另一主窗口", "host": "Codex",
            "system_kind": "steward", "members": [{"name": "Codex", "token": other_member}],
            "submission_id": uuid.uuid4().hex}, other_owner)
        self.assertEqual(status, 201, ordinary)
        for token in (other_owner, other_member):
            self.assertEqual(self.request(f"/api/rooms/{group_id}", token=token)[0], 403)
        cross_read = self.request(f"/api/rooms/{ordinary['id']}/messages", token=self.member, headers=lookup_headers)
        self.assertEqual(cross_read[0], 200)

    def test_group_member_may_answer_silently_but_cannot_post_proactively(self):
        room_id, owner_token, member_token, _ = self.create_group()
        base = f"/api/rooms/{room_id}"
        message, _ = self.create_external_message(room_id, owner_token)
        self.request(base + "/window-wake", {"message_id": message["id"]}, owner_token)
        member_id = self.request(base)[1]["free"]["members"][0]["id"]
        execution = self.request(base + "/executions", {
            "member_id": member_id, "client_id": uuid.uuid4().hex,
        }, owner_token)[1]
        status, answer = self.request(base + "/messages", {
            "author": "Codex", "text": "已完成", "execution_id": execution["id"],
            "silent": True, "submission_id": uuid.uuid4().hex,
        }, member_token)
        self.assertEqual(status, 201, answer)
        self.assertTrue(answer["message"]["silent"])
        self.assertEqual(answer["message"]["execution_id"], execution["id"])
        reread = self.request(base + f"/messages/{answer['message']['id']}", token=member_token)
        self.assertEqual(reread[0], 200)
        self.assertTrue(reread[1]["silent"])
        self.assertEqual(self.request(base + "/messages", {
            "author": "Codex", "text": "主动发言", "proactive": True,
            "submission_id": uuid.uuid4().hex,
        }, member_token)[0], 403)

        # A normal steward room may receive an ordinary owner request but cannot store a silent answer.
        owner_token, ordinary_member = uuid.uuid4().hex, uuid.uuid4().hex
        ordinary_room = self.request("/api/rooms", {"title": "普通房间", "host": "Codex", "system_kind": "steward",
            "members": [{"name": "Codex", "token": ordinary_member}],
            "submission_id": uuid.uuid4().hex}, owner_token)[1]["id"]
        user_message = self.request(f"/api/rooms/{ordinary_room}/messages", {"author": "用户", "text": "回答",
            "submission_id": uuid.uuid4().hex}, owner_token)[1]["message"]
        ordinary_member_id = self.request(f"/api/rooms/{ordinary_room}")[1]["free"]["members"][0]["id"]
        ordinary_run = self.request(f"/api/rooms/{ordinary_room}/executions", {
            "member_id": ordinary_member_id, "client_id": uuid.uuid4().hex,
        }, owner_token)[1]
        self.assertEqual(self.request(f"/api/rooms/{ordinary_room}/messages", {
            "author": "Codex", "text": "不应静默", "execution_id": ordinary_run["id"], "silent": True,
            "submission_id": uuid.uuid4().hex,
        }, ordinary_member)[0], 400)

    def test_ordinary_steward_message_still_creates_a_request_without_manual_wake(self):
        owner_token = uuid.uuid4().hex
        status, room = self.request("/api/rooms", {
            "title": "普通主理人房间", "host": "Codex", "system_kind": "steward",
            "members": [{"name": "Codex", "token": uuid.uuid4().hex}],
            "submission_id": uuid.uuid4().hex,
        }, owner_token)
        self.assertEqual(status, 201, room)
        room_id = room["id"]
        status, posted = self.request(f"/api/rooms/{room_id}/messages", {
            "author": "用户", "text": "普通单成员房间请求", "submission_id": uuid.uuid4().hex,
        }, owner_token)
        self.assertEqual(status, 201, posted)
        requests = self.request(f"/api/rooms/{room_id}")[1]["free"]["requests"]
        self.assertEqual([item["message_id"] for item in requests], [posted["message"]["id"]])


if __name__ == "__main__":
    unittest.main()

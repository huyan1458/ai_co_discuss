"""Exercise the Python site's platform steward room contract."""
import hashlib
import json
import tempfile
import threading
import time
import unittest
import uuid
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from backend.server import DiscussionServer, connect_db, expired_rooms, init_database, list_rooms, reading_field


class StewardRoomTests(unittest.TestCase):
    """Use only a fresh local database and never connect a runner."""

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.database = Path(directory.name) / "steward.sqlite3"
        init_database(self.database, seed=False)
        server = DiscussionServer(("127.0.0.1", 0), self.database)
        server.daemon_threads = False
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

    def test_steward_member_replacement_keeps_history_and_revokes_old_member(self):
        old_token, owner_token = uuid.uuid4().hex, uuid.uuid4().hex
        status, room = self.create("steward", member_token=old_token, owner_token=owner_token)
        self.assertEqual(status, 201, room)
        room_id = room["id"]
        base = f"/api/rooms/{room_id}"
        status, posted = self.request(base + "/messages", {
            "author": "用户", "text": "换软件前的对话", "submission_id": uuid.uuid4().hex,
        }, owner_token)
        self.assertEqual(status, 201, posted)
        old_id = self.request(base)[1]["free"]["members"][0]["id"]
        status, old_run = self.request(base + "/executions", {"member_id": old_id, "client_id": uuid.uuid4().hex}, owner_token)
        self.assertEqual(status, 200, old_run)

        new_token = uuid.uuid4().hex
        replacement = {
            "name": "Claude", "token": new_token, "adapter": "claude_code",
            "access": "runner", "session_mode": "new",
        }
        status, busy = self.request(base + "/steward-member", replacement, owner_token)
        self.assertEqual(status, 200, busy)
        self.assertIs(busy["busy"], True)
        self.assertEqual(busy["members"][0]["id"], old_id)
        status, answer = self.request(base + "/messages", {
            "author": "Codex", "text": "原任务已完成", "execution_id": old_run["id"], "submission_id": uuid.uuid4().hex,
        }, old_token)
        self.assertEqual(status, 201, answer)
        status, queued = self.request(base + "/messages", {
            "author": "用户", "text": "下一条任务", "submission_id": uuid.uuid4().hex,
        }, owner_token)
        self.assertEqual(status, 201, queued)
        status, view = self.request(base + "/steward-member", replacement, owner_token)
        self.assertEqual(status, 200, view)
        self.assertEqual(len(view["members"]), 1)
        new_member = view["members"][0]
        self.assertEqual((new_member["name"], new_member["role"], new_member["adapter"],
                          new_member["access"], new_member["session_mode"]), ("Claude", "host", "claude_code", "runner", "new"))
        self.assertEqual(self.request(base + "/steward-member", replacement, owner_token)[1]["members"][0]["id"], new_member["id"])
        self.assertIn((old_run["id"], "completed"), [(run["id"], run["status"]) for run in view["executions"]])
        requests = [(request["message_id"], request["member_id"], request["status"]) for request in view["requests"]]
        self.assertIn((posted["message"]["id"], old_id, "completed"), requests)
        self.assertIn((queued["message"]["id"], new_member["id"], "pending"), requests)
        self.assertEqual(self.request(base)[1]["labels"]["Claude"], "MOSS")

        history = self.request(base + "/messages")[1]["messages"]
        self.assertIn("换软件前的对话", [message["text"] for message in history])
        with closing(connect_db(self.database)) as connection:
            old_member = connection.execute("SELECT status,role FROM room_members WHERE room_id=? AND name='Codex'", (room_id,)).fetchone()
        self.assertEqual(old_member["status"], "removed")
        self.assertEqual(old_member["role"], "member")
        status, reply = self.request(base + "/messages", {
            "author": "Codex", "text": "旧凭据检查", "proactive": True, "submission_id": uuid.uuid4().hex,
        }, old_token)
        self.assertEqual(status, 403, reply)
        status, next_run = self.request(base + "/executions", {"member_id": new_member["id"], "client_id": uuid.uuid4().hex}, owner_token)
        self.assertEqual(status, 200, next_run)
        status, reply = self.request(base + "/messages", {
            "author": "Claude", "text": "交付下一条任务", "execution_id": next_run["id"], "submission_id": uuid.uuid4().hex,
        }, new_token)
        self.assertEqual(status, 201, reply)

    def test_steward_session_renew_and_software_switch_write_one_quiet_divider(self):
        owner_token, old_token = uuid.uuid4().hex, uuid.uuid4().hex
        room_id = self.create("steward", owner_token=owner_token, member_token=old_token)[1]["id"]
        base = f"/api/rooms/{room_id}"
        original = {"name": "Codex", "token": uuid.uuid4().hex, "adapter": "codex_cli",
                    "access": "runner", "session_mode": "new", "software_label": "Codex CLI"}
        switched = {"name": "Claude", "token": uuid.uuid4().hex, "adapter": "claude_code",
                    "access": "runner", "session_mode": "new", "software_label": "Claude Code"}

        for replacement, software in ((original, "Codex CLI"), (switched, "Claude Code")):
            before = self.request(base + "/messages")[1]["messages"]
            request_count = len(self.request(base)[1]["free"]["requests"])
            status, result = self.request(base + "/steward-member", replacement, owner_token)
            self.assertEqual(status, 200, result)
            after = self.request(base + "/messages")[1]["messages"]
            self.assertEqual(len(after), len(before) + 1)
            divider = after[-1]
            self.assertEqual((divider["author"], divider["source"], divider["kind"]),
                             ("系统", "system", "notice"))
            self.assertEqual(divider["texts"]["template"], "steward_session")
            self.assertEqual(divider["texts"]["text"], {
                "template": "MOSS 从这里开始新会话（{software}）", "params": {"software": software},
            })
            self.assertEqual(reading_field(divider, "text", "en"), f"MOSS starts a new session here ({software})")
            self.assertEqual(len(self.request(base)[1]["free"]["requests"]), request_count)
            self.assertEqual(self.request(base + "/steward-member", replacement, owner_token)[0], 200)
            self.assertEqual(len(self.request(base + "/messages")[1]["messages"]), len(after))

    def test_steward_session_renew_defers_divider_until_current_execution_ends(self):
        owner_token, old_token = uuid.uuid4().hex, uuid.uuid4().hex
        room_id = self.create("steward", owner_token=owner_token, member_token=old_token)[1]["id"]
        base = f"/api/rooms/{room_id}"
        member_id = self.request(base)[1]["free"]["members"][0]["id"]
        self.assertEqual(self.request(base + "/messages", {"author": "用户", "text": "正在处理",
            "to": ["Codex"], "submission_id": uuid.uuid4().hex}, owner_token)[0], 201)
        run = self.request(base + "/executions", {"member_id": member_id, "client_id": uuid.uuid4().hex}, owner_token)[1]
        replacement = {"name": "Codex", "token": uuid.uuid4().hex, "adapter": "codex_cli",
                       "access": "runner", "session_mode": "new", "software_label": "Codex CLI"}
        before = self.request(base + "/messages")[1]["messages"]
        status, busy = self.request(base + "/steward-member", replacement, owner_token)
        self.assertEqual((status, busy["busy"]), (200, True))
        self.assertEqual(len(self.request(base + "/messages")[1]["messages"]), len(before))
        status, answer = self.request(base + "/messages", {"author": "Codex", "text": "任务完成",
            "execution_id": run["id"], "submission_id": uuid.uuid4().hex}, old_token)
        self.assertEqual(status, 201, answer)
        self.assertEqual(len(self.request(base + "/messages")[1]["messages"]), len(before) + 1)
        status, result = self.request(base + "/steward-member", replacement, owner_token)
        self.assertEqual(status, 200, result)
        messages = self.request(base + "/messages")[1]["messages"]
        self.assertEqual(len(messages), len(before) + 2)
        self.assertEqual(messages[-1]["texts"]["template"], "steward_session")
        self.assertEqual(messages[-1]["texts"]["text"]["params"]["software"], "Codex CLI")

    def test_steward_session_divider_does_not_route_or_wake_member(self):
        owner_token, old_token = uuid.uuid4().hex, uuid.uuid4().hex
        room_id = self.create("steward", owner_token=owner_token, member_token=old_token)[1]["id"]
        base = f"/api/rooms/{room_id}"
        status, result = self.request(base + "/steward-member", {
            "name": "Codex", "token": uuid.uuid4().hex, "adapter": "codex_cli",
            "access": "runner", "session_mode": "new",
        }, owner_token)
        self.assertEqual(status, 200, result)
        divider_id = self.request(base + "/messages")[1]["messages"][-1]["id"]
        room = self.request(base)[1]
        self.assertFalse(any(request["message_id"] == divider_id for request in room["free"]["requests"]))
        self.assertIsNone(room["free"]["members"][0]["execution"])

    def test_steward_member_replacement_rejects_member_ordinary_and_archived_rooms(self):
        owner_token, member_token = uuid.uuid4().hex, uuid.uuid4().hex
        steward = self.create("steward", owner_token=owner_token, member_token=member_token)[1]
        base = f"/api/rooms/{steward['id']}/steward-member"
        payload = {"name": "Claude", "token": uuid.uuid4().hex, "adapter": "claude_code",
                   "access": "runner", "session_mode": "new"}
        self.assertEqual(self.request(base, payload, member_token)[0], 403)
        self.assertEqual(self.request(base, payload, owner_token, headers={"X-Acting-Member-Token": member_token})[0], 403)

        ordinary_id = self.create()[1]["id"]
        self.assertEqual(self.request(f"/api/rooms/{ordinary_id}/steward-member", payload, self.owner)[0], 409)

        self.assertEqual(self.request(f"/api/rooms/{steward['id']}/archive", {"actor": "用户"}, owner_token)[0], 200)
        self.assertEqual(self.request(base, payload, owner_token)[0], 409)

    def test_steward_member_replacement_via_trusted_local_entry(self):
        room_id = self.create("steward")[1]["id"]
        status, view = self.request(f"/api/rooms/{room_id}/steward-member", {"name": "Codex", "token": uuid.uuid4().hex})
        self.assertEqual(status, 200, view)
        self.assertEqual([(member["name"], member["role"]) for member in view["members"]], [("Codex", "host")])

    def test_steward_proactive_trigger_displays_events_and_preserves_marker(self):
        room_id = self.create("steward")[1]["id"]
        base = f"/api/rooms/{room_id}/messages"
        events = "waiting_user http://127.0.0.1/?room=project-a #12\nfailed http://127.0.0.1/?room=project-b #34"
        payload = {"author": "用户", "text": events, "steward_proactive": True, "submission_id": uuid.uuid4().hex}
        status, sent = self.request(base, payload, self.owner)
        self.assertEqual(status, 201, sent)
        message_id = sent["message"]["id"]
        status, message = self.request(f"{base}/{message_id}")
        self.assertEqual(status, 200, message)
        self.assertEqual(message["text"], f"主动汇报触发：{events}")
        self.assertEqual(reading_field(message, "text", "en"), f"Proactive update triggered by: {events}")
        self.assertEqual(message["texts"]["template"], "steward_proactive")
        status, retried = self.request(base, payload, self.owner)
        self.assertEqual(status, 200, retried)
        self.assertTrue(retried["duplicate"])
        self.assertEqual(retried["message"]["id"], message_id)
        self.assertEqual(self.request(base, {**payload, "text": "different events"}, self.owner)[0], 409)

    def attention(self, room_id):
        """Read the public summary, not the room's inner state."""
        return next(room["attention"] for room in self.request("/api/rooms")[1]["rooms"] if room["id"] == room_id)

    def reserve_named_request(self, base, name):
        """Give a named member actual work and reserve it through the runner API."""
        member_id = next(member["id"] for member in self.request(base)[1]["free"]["members"] if member["name"] == name)
        status, message = self.request(base + "/messages", {
            "author": "用户", "text": "核对房间状态", "to": [name], "submission_id": uuid.uuid4().hex,
        }, self.owner)
        self.assertEqual(status, 201, message)
        status, run = self.request(base + "/executions", {"member_id": member_id, "client_id": uuid.uuid4().hex}, self.owner)
        self.assertEqual(status, 200, run)
        return run["id"]

    def test_room_attention_orders_waiting_failure_running_and_clears_on_retry(self):
        room_id = self.create()[1]["id"]
        base = f"/api/rooms/{room_id}"
        claude_token = uuid.uuid4().hex
        self.assertEqual(self.request(base + "/members", {"name": "Claude", "token": claude_token}, self.owner)[0], 200)
        self.assertEqual(self.attention(room_id), "")
        failed_id = self.reserve_named_request(base, "Codex")
        self.assertEqual(self.attention(room_id), "running")
        failure = f"{base}/executions/{failed_id}"
        running_id = self.reserve_named_request(base, "Claude")
        self.assertEqual(self.request(failure, {"action": "fail", "reason": "测试失败"}, self.owner)[0], 200)
        self.assertEqual(self.attention(room_id), "failed")

        with closing(connect_db(self.database)) as connection, connection:
            goal_id = connection.execute("INSERT INTO room_goals(room_id,objective,started_at,phase) VALUES (?, '测试', 1, 'pending')",
                                         (room_id,)).lastrowid
        self.assertEqual(self.attention(room_id), "waiting_user")
        with closing(connect_db(self.database)) as connection, connection:
            connection.execute("UPDATE room_goals SET status='complete' WHERE id=?", (goal_id,))
        self.assertEqual(self.attention(room_id), "failed")

        status, question = self.request(base + "/questions", {
            "actor": "Claude", "execution_id": running_id, "submission_id": uuid.uuid4().hex,
            "contract": "handoff", "blocking": True, "explanation": "需要你确认。",
            "questions": [{"id": "pick", "prompt": "选哪一个？", "options": [{"id": "A", "label": "甲"}, {"id": "B", "label": "乙"}]}],
        }, claude_token)
        self.assertEqual(status, 201, question)
        self.assertEqual(self.attention(room_id), "waiting_user")
        self.assertEqual(self.request(failure, {"action": "retry"}, self.owner)[0], 200)
        self.assertEqual(self.attention(room_id), "waiting_user")
        status, answer = self.request(f"{base}/questions/{question['question_id']}/answer", {
            "version": 1, "choices": {"pick": ["A"]}, "submission_id": uuid.uuid4().hex,
        }, self.owner)
        self.assertEqual(status, 201, answer)
        self.assertEqual(self.attention(room_id), "")

    def test_channel_message_waits_in_moss_queue_until_the_question_is_answered(self):
        base = f"/api/rooms/{self.create('steward')[1]['id']}"
        run = self.reserve_named_request(base, "Codex")
        status, question = self.request(base + "/questions", {
            "actor": "Codex", "execution_id": run, "submission_id": uuid.uuid4().hex,
            "contract": "handoff", "blocking": True, "explanation": "请在网页确认。",
            "questions": [{"id": "pick", "prompt": "继续吗？", "options": [{"id": "A", "label": "继续"}, {"id": "B", "label": "停止"}]}],
        }, self.member)
        self.assertEqual(status, 201, question)
        submission = uuid.uuid4().hex
        status, queued = self.request(base + "/messages", {
            "author": "用户", "text": "来源渠道：微信\n\n新的请求", "queue": True, "submission_id": submission,
        }, self.owner)
        self.assertEqual(status, 201, queued)
        self.assertIn("queued", queued)
        view = lambda: self.request(base)[1]["free"]
        read = lambda: self.request(f"{base}/messages?submission_id={submission}")[1]["messages"]
        self.assertEqual(self.request(base + "/inbox", token=self.owner)[0], 200)
        self.assertEqual([item["id"] for item in view()["queued_messages"]["items"]], [queued["queued"]])
        self.assertEqual(read(), [])
        status, answer = self.request(f"{base}/questions/{question['question_id']}/answer", {
            "version": 1, "choices": {"pick": ["A"]}, "submission_id": uuid.uuid4().hex,
        }, self.owner)
        self.assertEqual(status, 201, answer)
        member_id = view()["members"][0]["id"]
        status, continuation = self.request(base + "/executions", {"member_id": member_id, "client_id": uuid.uuid4().hex}, self.owner)
        self.assertEqual(status, 200, continuation)
        status, reply = self.request(base + "/messages", {
            "author": "Codex", "text": "已处理网页回答", "execution_id": continuation["id"], "submission_id": uuid.uuid4().hex,
        }, self.member)
        self.assertEqual(status, 201, reply)
        self.assertEqual(view()["queued_messages"]["items"], [])
        self.assertEqual([item["text"] for item in read()], ["来源渠道：微信\n\n新的请求"])

    def test_expired_blocking_question_releases_moss_queue_on_inbox_poll(self):
        room_id = self.create("steward")[1]["id"]
        base = f"/api/rooms/{room_id}"
        run = self.reserve_named_request(base, "Codex")
        expires_at = int(time.time()) + 60
        status, question = self.request(base + "/questions", {
            "actor": "Codex", "execution_id": run, "submission_id": uuid.uuid4().hex,
            "contract": "handoff", "blocking": True, "expires_at": expires_at, "explanation": "请在时限内确认。",
            "questions": [{"id": "pick", "prompt": "是否继续？", "options": [{"id": "A", "label": "继续"}]}],
        }, self.member)
        self.assertEqual(status, 201, question)
        submission = uuid.uuid4().hex
        status, queued = self.request(base + "/messages", {
            "author": "用户", "text": "提问后发来的消息", "queue": True, "submission_id": submission,
        }, self.owner)
        self.assertEqual(status, 201, queued)
        self.assertIn("queued", queued)
        messages = f"{base}/messages?submission_id={submission}"
        with patch("backend.message_queue.time.time", return_value=expires_at - 1):
            self.assertEqual(self.request(base + "/inbox", token=self.owner)[0], 200)
            self.assertEqual(self.request(messages)[1]["messages"], [])
        with patch("backend.message_queue.time.time", return_value=expires_at):
            self.assertEqual(self.request(base + "/inbox", token=self.owner)[0], 200)
        free = self.request(base)[1]["free"]
        posted = self.request(messages)[1]["messages"]
        self.assertEqual(free["queued_messages"]["items"], [])
        self.assertEqual([item["text"] for item in posted], ["提问后发来的消息"])
        self.assertEqual([r["status"] for r in free["requests"] if r["message_id"] == posted[0]["id"]], ["pending"])

    def test_room_attention_clears_a_handled_failure(self):
        room_id = self.create()[1]["id"]
        base = f"/api/rooms/{room_id}"
        failed_id = self.reserve_named_request(base, "Codex")
        self.assertEqual(self.request(f"{base}/executions/{failed_id}", {"action": "fail", "reason": "测试失败"}, self.owner)[0], 200)
        self.assertEqual(self.attention(room_id), "failed")
        member_id = self.request(base)[1]["free"]["members"][0]["id"]
        status, wake = self.request(base + "/executions", {"member_id": member_id, "client_id": uuid.uuid4().hex}, self.owner)
        self.assertEqual(status, 200, wake)
        self.assertEqual(self.attention(room_id), "running")
        status, handled = self.request(base + "/messages", {
            "author": "Codex", "text": "已处理此前的失败", "execution_id": wake["id"], "submission_id": uuid.uuid4().hex,
        }, self.member)
        self.assertEqual(status, 201, handled)
        self.assertEqual(self.attention(room_id), "")

    def test_room_attention_clears_failure_when_user_posts_new_message(self):
        room_id = self.create()[1]["id"]
        base = f"/api/rooms/{room_id}"
        failed_id = self.reserve_named_request(base, "Codex")
        self.assertEqual(self.request(f"{base}/executions/{failed_id}", {"action": "fail", "reason": "测试失败"}, self.owner)[0], 200)
        self.assertEqual(self.attention(room_id), "failed")

        status, message = self.request(base + "/messages", {
            "author": "用户", "text": "请继续处理", "to": ["Codex"], "submission_id": uuid.uuid4().hex,
        }, self.owner)
        self.assertEqual(status, 201, message)
        # Both timestamps have second precision. Force a tie to verify chronological event ordering without sleeping.
        with closing(connect_db(self.database)) as connection, connection:
            connection.execute("""UPDATE messages SET created_at=strftime('%Y-%m-%dT%H:%M:%SZ',
                (SELECT finished_at FROM member_executions WHERE id=?), 'unixepoch') WHERE id=?""",
                               (failed_id, message["message"]["id"]))
        self.assertEqual(self.attention(room_id), "", "a newer user message should clear stale failure attention before execution starts")

        member_id = self.request(base)[1]["free"]["members"][0]["id"]
        status, run = self.request(base + "/executions", {"member_id": member_id, "client_id": uuid.uuid4().hex}, self.owner)
        self.assertEqual(status, 200, run)
        self.assertEqual(self.attention(room_id), "running")
        status, answer = self.request(base + "/messages", {
            "author": "Codex", "text": "已完成", "execution_id": run["id"], "submission_id": uuid.uuid4().hex,
        }, self.member)
        self.assertEqual(status, 201, answer)
        self.assertEqual(self.attention(room_id), "")

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

    def test_private_window_is_unique_hidden_from_room_directories_and_not_cross_readable(self):
        owner_token, member_token = uuid.uuid4().hex, uuid.uuid4().hex
        status, room = self.create("steward_private", owner_token=owner_token, member_token=member_token)
        self.assertEqual(status, 201, room)
        self.assertEqual(room["system_kind"], "steward_private")
        self.assertEqual(self.request(f"/api/rooms/{room['id']}", token=owner_token)[1]["system_kind"], "steward_private")

        with closing(connect_db(self.database)) as connection:
            self.assertNotIn(room["id"], {item["id"] for item in list_rooms(connection)["rooms"]})
            managed = list_rooms(connection, include_group_windows=True)["rooms"]
            self.assertIn(room["id"], {item["id"] for item in managed})

        duplicate = self.create("steward_private", owner_token=uuid.uuid4().hex, member_token=uuid.uuid4().hex)
        self.assertEqual(duplicate[0], 409, duplicate[1])
        self.assertEqual(duplicate[1]["error_text"]["template"], "私聊窗口已存在")
        self.assertNotEqual(self.request("/api/dispatches?view=chains", token=member_token)[0], 200)

        other_owner = uuid.uuid4().hex
        self.create(owner_token=other_owner, member_token=uuid.uuid4().hex)
        status, denied = self.request(f"/api/rooms/{room['id']}/messages", token=other_owner,
                                      headers={"X-Discussion-Read-Only": "1"})
        self.assertEqual(status, 403, denied)

        main_owner, main_member = uuid.uuid4().hex, uuid.uuid4().hex
        main = self.create("steward", owner_token=main_owner, member_token=main_member)[1]
        status, denied = self.request(f"/api/rooms/{main['id']}/messages", token=member_token,
                                      headers={"X-Discussion-Read-Only": "1"})
        self.assertEqual(status, 403, denied)
        self.assertEqual(self.request(f"/api/rooms/{main['id']}/messages", token=member_token)[0], 403)

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

    def link_child(self, parent_id, parent_token, child_id, child_token):
        """Record the same parent link a successful host-control room creation leaves behind."""
        for source_id, target_id, relation in ((parent_id, child_id, "child"), (child_id, parent_id, "parent")):
            status, _ = self.request(f"/api/rooms/{source_id}/room-link", {
                "room_id": target_id, "relation": relation, "host": "Codex",
            }, parent_token if source_id == parent_id else child_token)
            self.assertEqual(status, 200)

    def archive_as_steward(self, child_id, member_token):
        """Act directly as the MOSS member and name its child room."""
        return self.request(f"/api/rooms/{child_id}/archive", {"actor": "Codex"}, member_token)

    def moss_relay_card(self, source_base, target_room_id, target_message_id):
        """Find the source room's receipt card for one delivered cross-room message."""
        return next(message for message in self.request(source_base + "/messages")[1]["messages"]
                    if (message.get("relay_sent_room"), message.get("relay_sent_message_id")) == (target_room_id, target_message_id))

    def start_moss_delegation(self, *, project=False):
        """Return room IDs, the original child message ID and both host credentials."""
        moss_token, child_token = uuid.uuid4().hex, uuid.uuid4().hex
        moss = self.create("steward", member_token=moss_token)[1]["id"]
        payload = {"title": "执行", "host": "Codex", "submission_id": uuid.uuid4().hex,
                   "members": [{"name": "Codex", "token": child_token, "adapter": "codex_cli", "access": "runner", "session_mode": "new"}]}
        if project:
            payload["members"].append({"name": "Claude", "token": self.member})
        else:
            payload["preset"] = "task"
        status, result = self.request("/api/rooms", payload, self.owner)
        self.assertEqual(status, 201, result)
        child = result["id"]
        self.link_child(moss, self.owner, child, self.owner)
        sent = self.host_relay(moss, child, moss_token, "完成这项工作", submission_id=payload["submission_id"] + "-first")
        return moss, child, sent["message"]["id"], moss_token, child_token

    def host_relay(self, source, target, token, text, **other):
        """Send a room relay acting as the source's host."""
        payload = {"submission_id": uuid.uuid4().hex, "text": text, "target_room_id": target, **other}
        status, result = self.request(f"/api/rooms/{source}/host-room-post", payload, self.owner,
                                      headers={"X-Acting-Member-Token": token})
        self.assertEqual(status, 200, result)
        return result

    def reserve_moss_work(self, room, name="Codex"):
        """Reserve the work already sent to this room member."""
        base = f"/api/rooms/{room}"
        member = next(member for member in self.request(base)[1]["free"]["members"] if member["name"] == name)
        status, result = self.request(base + "/executions", {"member_id": member["id"], "client_id": uuid.uuid4().hex}, self.owner)
        self.assertEqual(status, 200, result)
        return result["id"]

    def moss_review_requests(self, moss, child, root):
        """Find the dedicated review anchored on the original sender's card."""
        base = f"/api/rooms/{moss}"
        card = self.moss_relay_card(base, child, root)
        return card, [r for r in self.request(base)[1]["free"]["requests"] if r["purpose"] == "notice" and r["message_id"] == card["id"]]

    def test_steward_member_can_archive_only_its_child_rooms(self):
        member_token = uuid.uuid4().hex
        steward_owner, child_owner = uuid.uuid4().hex, uuid.uuid4().hex
        steward_id = self.create("steward", owner_token=steward_owner, member_token=member_token)[1]["id"]
        child_id = self.create(owner_token=child_owner, member_token=uuid.uuid4().hex)[1]["id"]
        sibling_id = self.create(owner_token=uuid.uuid4().hex, member_token=uuid.uuid4().hex)[1]["id"]
        self.link_child(steward_id, steward_owner, child_id, child_owner)

        status, archived = self.archive_as_steward(child_id, member_token)
        self.assertEqual(status, 200, archived)
        self.assertTrue(self.request(f"/api/rooms/{child_id}")[1]["archived"])
        self.assertEqual(self.request(f"/api/rooms/{steward_id}/room-link", {
            "room_id": sibling_id, "relation": "child", "host": "Codex",
        }, steward_owner, headers={"X-Acting-Member-Token": member_token})[0], 200)
        self.assertEqual(self.archive_as_steward(sibling_id, member_token)[0], 403,
                         "a sender-side card alone does not make a room its child")

        for room_id, action, body in ((sibling_id, "archive", {"actor": "用户"}),
                                      (child_id, "restore", {"actor": "用户"}),
                                      (child_id, "delete", {"actor": "用户"})):
            with self.subTest(room_id=room_id, action=action):
                status, result = self.request(f"/api/rooms/{room_id}/{action}", body, self.owner,
                                              headers={"X-Acting-Member-Token": member_token})
                self.assertEqual(status, 403, result)

    def test_steward_member_cannot_use_owner_proxy_for_other_room_writes(self):
        member_token = uuid.uuid4().hex
        self.assertEqual(self.create("steward", member_token=member_token)[0], 201)
        target_id = self.create(member_token=uuid.uuid4().hex)[1]["id"]
        target = f"/api/rooms/{target_id}"
        execution_id = self.reserve_named_request(target, "Codex")
        target_view = self.request(target)[1]["free"]
        member_id = target_view["members"][0]["id"]
        message_id = target_view["requests"][-1]["message_id"]
        attempts = (
            ("stop", {}),
            (f"executions/{execution_id}", {"action": "interject", "text": "插话", "submission_id": uuid.uuid4().hex}),
            (f"members/{member_id}/interrupt", {}),
            ("members", {"name": "Claude", "token": uuid.uuid4().hex}),
            (f"members/{member_id}", {"action": "remove"}),
            (f"members/{member_id}/review-capability", {"read_only": True}),
            (f"messages/{message_id}/retract", {}),
            ("rewind", {"message_id": message_id}),
        )
        for path, body in attempts:
            with self.subTest(path=path):
                self.assertEqual(self.request(f"{target}/{path}", body, member_token)[0], 403)
                status, result = self.request(f"{target}/{path}", body, self.owner,
                                              headers={"X-Acting-Member-Token": member_token})
                self.assertEqual(status, 403, result)
        self.assertEqual(self.request(target, token=member_token)[0], 200)
        self.assertEqual(self.request(f"{target}/executions/{execution_id}")[1]["status"], "dispatched")

    def test_steward_relay_queues_to_project_host_and_can_receive_reply(self):
        steward_token, project_token = uuid.uuid4().hex, uuid.uuid4().hex
        steward_id = self.create("steward", member_token=steward_token)[1]["id"]
        project_id = self.create(member_token=project_token)[1]["id"]
        source, target = f"/api/rooms/{steward_id}", f"/api/rooms/{project_id}"
        self.assertEqual(self.request(target + "/members", {"name": "Claude", "token": uuid.uuid4().hex}, self.owner)[0], 200)
        self.link_child(steward_id, self.owner, project_id, self.owner)
        payload = {"target_room_id": project_id, "text": "@Claude 请主持人回报", "expect": "reply", "submission_id": uuid.uuid4().hex}
        acting = {"X-Acting-Member-Token": steward_token}
        self.assertEqual(self.request(source + "/host-room-post", {**payload, "interrupt": True}, self.owner, headers=acting)[0], 403)
        status, sent = self.request(source + "/host-room-post", payload, self.owner, headers=acting)
        self.assertEqual(status, 200, sent)
        message_id = sent["message"]["id"]
        free = self.request(target)[1]["free"]
        hosts = [member["id"] for member in free["members"] if member["role"] == "host"]
        self.assertEqual([r["member_id"] for r in free["requests"] if r["message_id"] == message_id], hosts)

        status, run = self.request(target + "/executions", {"member_id": hosts[0], "client_id": uuid.uuid4().hex}, self.owner)
        self.assertEqual(status, 200, run)
        status, reply = self.request(target + "/host-room-post", {
            "target_room_id": steward_id, "text": "回报完成", "reply_to": message_id, "execution_id": run["id"],
            "submission_id": uuid.uuid4().hex,
        }, self.owner, headers={"X-Acting-Member-Token": project_token})
        self.assertEqual(status, 200, reply)
        card, reviews = self.moss_review_requests(steward_id, project_id, message_id)
        self.assertEqual((card["relay_report_state"], card["relay_report_summary"], card["relay_report_message_id"], len(reviews)),
                         ("completed", "回报完成", reply["answer_id"], 1))

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

    def test_moss_task_child_result_projects_once_to_original_relay_card(self):
        moss_token, task_token = uuid.uuid4().hex, uuid.uuid4().hex
        moss = self.create("steward", member_token=moss_token)[1]
        task = self.create(member_token=task_token)[1]
        moss_base, task_base = f"/api/rooms/{moss['id']}", f"/api/rooms/{task['id']}"
        self.link_child(moss["id"], self.owner, task["id"], self.owner)

        delegation_id = task["submission_id"] + "-first"
        send = {"target_room_id": task["id"], "text": "完成这个单项任务", "expect": "reply",
                "submission_id": delegation_id}
        acting = {"X-Acting-Member-Token": moss_token}
        status, sent = self.request(moss_base + "/host-room-post", send, self.owner, headers=acting)
        self.assertEqual(status, 200, sent)
        card_id = sent["message"]["id"]
        task_host = self.request(task_base)[1]["free"]["members"][0]
        status, run = self.request(task_base + "/executions", {
            "member_id": task_host["id"], "client_id": uuid.uuid4().hex,
        }, self.owner)
        self.assertEqual(status, 200, run)

        version = self.server.update_version
        status, answer = self.request(task_base + "/messages", {
            "author": task_host["name"], "text": "单项任务已完成", "execution_id": run["id"],
            "submission_id": uuid.uuid4().hex,
        }, task_token)
        self.assertEqual(status, 201, answer)
        card = self.moss_relay_card(moss_base, task["id"], card_id)
        parent_card_id = card["id"]
        self.assertEqual(card["relay_report_state"], "completed")
        self.assertEqual(card["relay_report_summary"], "单项任务已完成")
        self.assertEqual(card["relay_report_message_id"], answer["message"]["id"])
        self.assertEqual(card["relay_review_message_id"], parent_card_id)
        with self.server.updates:
            self.assertTrue(self.server.updates.wait_for(lambda: moss["id"] in self.server.changed_rooms(version), timeout=1))
        notices = [request for request in self.request(moss_base)[1]["free"]["requests"]
                   if request["purpose"] == "notice" and request["message_id"] == parent_card_id]
        self.assertEqual(len(notices), 1)

        signature = json.dumps([task["id"], send["submission_id"]], separators=(",", ":"), ensure_ascii=False)
        receipt = {"target_room_id": task["id"], "host": "Codex", "member": "Codex", "text": send["text"],
                   "submission_id": "sent-" + hashlib.sha256(signature.encode()).hexdigest(),
                   "target_message_id": card_id}
        status, duplicate_receipt = self.request(moss_base + "/room-relay-sent", receipt, self.owner)
        self.assertEqual(status, 200, duplicate_receipt)
        self.assertEqual(duplicate_receipt["message_id"], parent_card_id)

        # Replaying the same MOSS relay is idempotent, including the review wake-up.
        status, replay = self.request(moss_base + "/host-room-post", send, self.owner, headers=acting)
        self.assertIn(status, (200, 201), replay)
        self.assertEqual(replay["message"]["id"], card_id)
        self.assertEqual(len([request for request in self.request(moss_base)[1]["free"]["requests"]
                              if request["purpose"] == "notice" and request["message_id"] == parent_card_id]), 1)

    def test_moss_project_dispatch_is_not_result_until_host_answers(self):
        moss_token, project_token, claude_token = uuid.uuid4().hex, uuid.uuid4().hex, uuid.uuid4().hex
        moss = self.create("steward", member_token=moss_token)[1]
        project = self.create(member_token=project_token)[1]
        moss_base, project_base = f"/api/rooms/{moss['id']}", f"/api/rooms/{project['id']}"
        self.assertEqual(self.request(project_base + "/members", {"name": "Claude", "token": claude_token}, self.owner)[0], 200)
        self.link_child(moss["id"], self.owner, project["id"], self.owner)

        send = {"target_room_id": project["id"], "text": "请处理项目并回报", "expect": "reply",
                "submission_id": project["submission_id"] + "-first"}
        status, sent = self.request(moss_base + "/host-room-post", send, self.owner,
                                    headers={"X-Acting-Member-Token": moss_token})
        self.assertEqual(status, 200, sent)
        card_id = sent["message"]["id"]
        host = next(member for member in self.request(project_base)[1]["free"]["members"]
                    if member["role"] == "host")
        status, host_run = self.request(project_base + "/executions", {
            "member_id": host["id"], "client_id": uuid.uuid4().hex,
        }, self.owner)
        self.assertEqual(status, 200, host_run)
        status, dispatch = self.request(project_base + "/messages", {
            "author": host["name"], "text": "已派给 Claude 执行", "to": ["Claude"],
            "execution_id": host_run["id"], "submission_id": uuid.uuid4().hex,
        }, project_token)
        self.assertEqual(status, 201, dispatch)
        card = self.moss_relay_card(moss_base, project["id"], card_id)
        parent_card_id = card["id"]
        self.assertEqual(card["relay_report_state"], "")
        self.assertEqual([request for request in self.request(moss_base)[1]["free"]["requests"]
                          if request["purpose"] == "notice" and request["message_id"] == parent_card_id], [])

        claude = next(member for member in self.request(project_base)[1]["free"]["members"]
                      if member["name"] == "Claude")
        status, claude_run = self.request(project_base + "/executions", {
            "member_id": claude["id"], "client_id": uuid.uuid4().hex,
        }, self.owner)
        self.assertEqual(status, 200, claude_run)
        status, claude_answer = self.request(project_base + "/messages", {
            "author": "Claude", "text": "项目实现完成", "execution_id": claude_run["id"],
            "submission_id": uuid.uuid4().hex,
        }, claude_token)
        self.assertEqual(status, 201, claude_answer)

        # The host's result is the project report; implementation member output is not.
        host = next(member for member in self.request(project_base)[1]["free"]["members"]
                    if member["role"] == "host")
        status, host_run = self.request(project_base + "/executions", {
            "member_id": host["id"], "client_id": uuid.uuid4().hex,
        }, self.owner)
        self.assertEqual(status, 200, host_run)
        status, final = self.request(project_base + "/messages", {
            "author": host["name"], "text": "项目已经完成", "execution_id": host_run["id"],
            "submission_id": uuid.uuid4().hex,
        }, project_token)
        self.assertEqual(status, 201, final)
        card = self.moss_relay_card(moss_base, project["id"], card_id)
        self.assertEqual(card["relay_report_state"], "completed")
        self.assertEqual(card["relay_report_summary"], "项目已经完成")
        self.assertEqual(card["relay_report_message_id"], final["message"]["id"])
        self.assertEqual(card["relay_review_message_id"], parent_card_id)
        self.assertEqual(len([request for request in self.request(moss_base)[1]["free"]["requests"]
                              if request["purpose"] == "notice" and request["message_id"] == parent_card_id]), 1)


    def test_moss_explicit_project_result_reuses_original_card_and_execution_reply(self):
        moss, child, root, _, host_token = self.start_moss_delegation(project=True)
        messages = f"/api/rooms/{moss}/messages"
        before = [message["id"] for message in self.request(messages)[1]["messages"]]
        run = self.reserve_moss_work(child)
        submission = uuid.uuid4().hex
        result = self.host_relay(child, moss, host_token, "实现及验证已完成", reply_to=root, execution_id=run, submission_id=submission)
        card, reviews = self.moss_review_requests(moss, child, root)
        self.assertEqual((card["relay_report_state"], card["relay_report_summary"]), ("completed", "实现及验证已完成"))
        self.assertEqual((card["relay_report_message_id"], result["message"]["id"], len(reviews)), (result["answer_id"], card["id"], 1))
        replay = self.host_relay(child, moss, host_token, "实现及验证已完成", reply_to=root, execution_id=run, submission_id=submission)
        self.assertEqual(replay, result)
        self.assertEqual([message["id"] for message in self.request(messages)[1]["messages"]], before)
        self.assertEqual(len(self.moss_review_requests(moss, child, root)[1]), 1)

    def test_moss_decision_pauses_report_then_resumes_original_chain(self):
        moss, child, root, moss_token, host_token = self.start_moss_delegation()
        child_run = self.reserve_moss_work(child)
        question = self.host_relay(child, moss, host_token, "请决定范围", expect="reply", execution_id=child_run)
        question_id = question["message"]["id"]
        card, reviews = self.moss_review_requests(moss, child, root)
        self.assertEqual((card["relay_report_state"], card["relay_report_summary"], reviews), ("waiting", "请决定范围", []))
        base = f"/api/rooms/{child}"
        status, result = self.request(base + "/messages", {"author": "Codex", "text": "等决定再继续", "execution_id": child_run,
                                                            "submission_id": uuid.uuid4().hex}, host_token)
        self.assertEqual(status, 201, result)
        self.assertEqual(self.moss_review_requests(moss, child, root)[0]["relay_report_state"], "waiting")
        self.host_relay(moss, child, moss_token, "保持原有范围", reply_to=question_id, execution_id=self.reserve_moss_work(moss))
        self.assertEqual(self.moss_review_requests(moss, child, root)[0]["relay_report_state"], "")
        status, result = self.request(base + "/messages", {"author": "Codex", "text": "已按决定完成",
            "execution_id": self.reserve_moss_work(child), "submission_id": uuid.uuid4().hex}, host_token)
        self.assertEqual(status, 201, result)
        card, reviews = self.moss_review_requests(moss, child, root)
        self.assertEqual((card["relay_report_state"], card["relay_report_message_id"], len(reviews)), ("completed", result["message"]["id"], 1))

    def test_moss_delegation_reports_failed_execution(self):
        moss, child, root, _, _ = self.start_moss_delegation()
        run = self.reserve_moss_work(child)
        status, result = self.request(f"/api/rooms/{child}/executions/{run}", {"action": "fail", "reason": "余额用完",
                                      "failure_class": "quota"}, self.owner)
        self.assertEqual(status, 200, result)
        card, reviews = self.moss_review_requests(moss, child, root)
        self.assertEqual((card["relay_report_state"], card["relay_report_summary"], len(reviews)), ("failed", "余额用完", 1))

    def test_moss_delegation_reports_cancelled_execution(self):
        moss, child, root, _, _ = self.start_moss_delegation()
        self.reserve_moss_work(child)
        self.assertEqual(self.request(f"/api/rooms/{child}/stop", {}, self.owner)[0], 200)
        card, reviews = self.moss_review_requests(moss, child, root)
        self.assertEqual((card["relay_report_state"], len(reviews)), ("cancelled", 1))

    def test_moss_missing_result_reminds_child_once_before_review(self):
        moss, child, root, _, host_token = self.start_moss_delegation(project=True)
        base = f"/api/rooms/{child}"
        status, dispatch = self.request(base + "/messages", {"author": "Codex", "text": "安排一次直接交付", "to": ["Claude"],
            "no_handoff": True, "execution_id": self.reserve_moss_work(child), "submission_id": uuid.uuid4().hex}, host_token)
        self.assertEqual(status, 201, dispatch)
        status, answer = self.request(base + "/messages", {"author": "Claude", "text": "成员的结果",
            "execution_id": self.reserve_moss_work(child, "Claude"), "submission_id": uuid.uuid4().hex}, self.member)
        self.assertEqual(status, 201, answer)
        for _ in range(2):
            self.assertEqual(self.request(base + "/inbox", token=self.owner)[0], 200)
        requests = self.request(base)[1]["free"]["requests"]
        reminders = [r for r in requests if r["purpose"] == "notice" and r["chain_id"] == root]
        self.assertEqual(len(reminders), 1)
        self.assertEqual(self.moss_review_requests(moss, child, root)[1], [])
        run = self.reserve_moss_work(child)
        self.assertEqual(self.request(f"{base}/executions/{run}", {"action": "quiet"}, self.owner)[0], 200)
        card, reviews = self.moss_review_requests(moss, child, root)
        self.assertEqual((card["relay_report_state"], card["relay_report_message_id"], len(reviews)), ("unreported", reminders[0]["message_id"], 1))

    def test_moss_task_preset_is_published_in_room_and_directory(self):
        _, child, _, _, _ = self.start_moss_delegation()
        self.assertEqual(self.request(f"/api/rooms/{child}")[1]["preset"], "task")
        directory = self.request("/api/rooms")[1]["rooms"]
        self.assertEqual(next(room["preset"] for room in directory if room["id"] == child), "task")

    def test_moss_delegation_waiting_for_user_question_is_not_unreported(self):
        moss, child, root, _, child_token = self.start_moss_delegation()
        run = self.reserve_moss_work(child)
        status, question = self.request(f"/api/rooms/{child}/questions", {
            "actor": "Codex", "execution_id": run, "submission_id": uuid.uuid4().hex,
            "contract": "handoff", "blocking": True, "explanation": "已完成分析，需要用户选一个方案。",
            "questions": [{"id": "choice", "prompt": "选哪种？", "options": [
                {"id": "a", "label": "方案 A"}, {"id": "b", "label": "方案 B"},
            ]}],
        }, child_token)
        self.assertEqual(status, 201, question)
        card, reviews = self.moss_review_requests(moss, child, root)
        self.assertEqual((card["relay_report_state"], len(reviews)), ("waiting_user", 0))
        self.assertEqual(self.request(f"/api/rooms/{child}/inbox", token=self.owner)[0], 200)
        requests = self.request(f"/api/rooms/{child}")[1]["free"]["requests"]
        self.assertEqual([r for r in requests if r["purpose"] == "notice" and r["chain_id"] == root], [])
        self.assertEqual(self.moss_review_requests(moss, child, root)[0]["relay_report_state"], "waiting_user")

        base = f"/api/rooms/{child}"
        status, decision = self.request(f"{base}/questions/{question['question_id']}/answer", {
            "version": 1, "submission_id": uuid.uuid4().hex, "choices": {"choice": ["a"]},
        }, self.owner)
        self.assertEqual(status, 201, decision)
        self.assertEqual(self.moss_review_requests(moss, child, root)[0]["relay_report_state"], "")
        status, result = self.request(base + "/messages", {"author": "Codex", "text": "已按方案 A 完成",
            "execution_id": self.reserve_moss_work(child), "submission_id": uuid.uuid4().hex}, child_token)
        self.assertEqual(status, 201, result)
        card, reviews = self.moss_review_requests(moss, child, root)
        self.assertEqual((card["relay_report_state"], card["relay_report_message_id"], len(reviews)), ("completed", result["message"]["id"], 1))

    def test_moss_decision_wait_does_not_hold_another_delegation_in_same_child(self):
        moss, child, root, moss_token, child_token = self.start_moss_delegation()
        run = self.reserve_moss_work(child)
        self.host_relay(child, moss, child_token, "第一件事需要决定", expect="reply", execution_id=run)
        base = f"/api/rooms/{child}/messages"
        status, answer = self.request(base, {"author": "Codex", "text": "等决定", "execution_id": run,
            "submission_id": uuid.uuid4().hex}, child_token)
        self.assertEqual(status, 201, answer)
        other_root = self.host_relay(moss, child, moss_token, "独立的第二件事", expect="reply")["message"]["id"]
        status, answer = self.request(base, {"author": "Codex", "text": "第二件已完成", "execution_id": self.reserve_moss_work(child),
            "submission_id": uuid.uuid4().hex}, child_token)
        self.assertEqual(status, 201, answer)
        first, reviews = self.moss_review_requests(moss, child, root)
        second, second_reviews = self.moss_review_requests(moss, child, other_root)
        self.assertEqual((first["relay_report_state"], len(reviews)), ("waiting", 0))
        self.assertEqual((second["relay_report_state"], len(second_reviews)), ("completed", 1))

    def test_moss_rework_result_updates_original_card_and_gets_a_second_review(self):
        moss, child, first_root, moss_token, child_token = self.start_moss_delegation()
        self.request(f"/api/rooms/{child}/messages", {"author": "Codex", "text": "首轮结果",
            "execution_id": self.reserve_moss_work(child), "submission_id": uuid.uuid4().hex}, child_token)
        first_card, first_reviews = self.moss_review_requests(moss, child, first_root)
        self.assertEqual((first_card["relay_report_state"], len(first_reviews)), ("completed", 1))

        review_run = self.reserve_moss_work(moss)
        status, review_answer = self.request(f"/api/rooms/{moss}/messages", {"author": "Codex", "text": "需要修正后再验收",
            "execution_id": review_run, "submission_id": uuid.uuid4().hex}, moss_token)
        self.assertEqual(status, 201, review_answer)
        rework_id = uuid.uuid4().hex
        rework = self.host_relay(moss, child, moss_token, "请修正这处问题并复核", expect="reply", execution_id=review_run, submission_id=rework_id)
        rework_root = rework["message"]["id"]
        self.assertNotEqual(rework_root, first_root)
        self.assertEqual(self.moss_review_requests(moss, child, first_root)[0]["relay_report_state"], "")
        rework_run = self.reserve_moss_work(child)
        status, result = self.request(f"/api/rooms/{child}/messages", {"author": "Codex", "text": "已修正并通过复核",
            "execution_id": rework_run, "submission_id": uuid.uuid4().hex}, child_token)
        self.assertEqual(status, 201, result)

        first_card, first_reviews = self.moss_review_requests(moss, child, first_root)
        rework_card, rework_reviews = self.moss_review_requests(moss, child, rework_root)
        self.assertEqual((first_card["relay_report_state"], first_card["relay_report_summary"],
                          first_card["relay_report_message_id"]), ("completed", "已修正并通过复核", result["message"]["id"]))
        self.assertEqual((rework_card["relay_report_state"], rework_card["relay_report_summary"], len(rework_reviews)),
                         ("completed", "已修正并通过复核", 1))
        self.assertEqual(len(first_reviews), 1)
        retry = self.host_relay(moss, child, moss_token, "请修正这处问题并复核", expect="reply", execution_id=review_run, submission_id=rework_id)
        self.assertEqual(retry["message"]["id"], rework_root)
        self.assertEqual(len(self.moss_review_requests(moss, child, rework_root)[1]), 1)

    def test_steward_work_is_owner_scoped_and_returns_latest_child_dispatch(self):
        moss, child, first_root, moss_token, child_token = self.start_moss_delegation(project=True)
        first_card = self.moss_relay_card(f"/api/rooms/{moss}", child, first_root)
        endpoint = f"/api/rooms/{moss}/steward-work"

        status, owner_view = self.request(endpoint, token=self.owner)
        self.assertEqual(status, 200, owner_view)
        initial_item = next(item for item in owner_view["items"] if item["room_id"] == child)
        self.assertEqual(initial_item["delegation_message_id"], first_card["id"])
        self.assertEqual(self.request(endpoint)[0], 200)
        status, denied = self.request(endpoint, token=moss_token)
        self.assertEqual(status, 403, denied)
        status, denied = self.request(endpoint, token=self.owner,
                                      headers={"X-Acting-Member-Token": moss_token})
        self.assertEqual(status, 403, denied)
        ordinary = self.create()[1]["id"]
        self.assertEqual(self.request(f"/api/rooms/{ordinary}/steward-work", token=self.owner)[0], 404)

        result = self.request(f"/api/rooms/{child}/messages", {
            "author": "Codex", "text": "首轮完成", "execution_id": self.reserve_moss_work(child),
            "submission_id": uuid.uuid4().hex,
        }, child_token)[1]
        review_run = self.reserve_moss_work(moss)
        status, _ = self.request(f"/api/rooms/{moss}/messages", {
            "author": "Codex", "text": "返工", "execution_id": review_run,
            "submission_id": uuid.uuid4().hex,
        }, moss_token)
        self.assertEqual(status, 201)
        rework_root = self.host_relay(moss, child, moss_token, "请返工", expect="reply",
                                      execution_id=review_run)["message"]["id"]
        rework_card = self.moss_relay_card(f"/api/rooms/{moss}", child, rework_root)
        rework = self.request(f"/api/rooms/{child}/messages", {
            "author": "Codex", "text": "返工已完成", "execution_id": self.reserve_moss_work(child),
            "submission_id": uuid.uuid4().hex,
        }, child_token)[1]
        self.assertEqual(result["message"]["text"], "首轮完成")

        # An ordinary receipt on the same child must not become the latest delegated work.
        self.host_relay(moss, child, moss_token, "仅通知", expect="none")
        status, view = self.request(endpoint, token=self.owner)
        self.assertEqual(status, 200, view)
        item = next(item for item in view["items"] if item["room_id"] == child)
        self.assertEqual((item["delegation_message_id"], item["state"], item["summary"], item["result_message_id"]),
                         (rework_card["id"], "completed", "返工已完成", rework["message"]["id"]))
        self.assertIn("updated_at", item)

        status, archived = self.request(f"/api/rooms/{child}/archive", {"actor": "用户"}, self.owner)
        self.assertEqual((status, archived["archived"]), (200, True))
        status, view = self.request(endpoint, token=self.owner)
        self.assertEqual(status, 200, view)
        self.assertTrue(next(item for item in view["items"] if item["room_id"] == child)["archived"])

    def test_steward_work_includes_existing_project_delegations_but_not_notices(self):
        moss_token, project_token = uuid.uuid4().hex, uuid.uuid4().hex
        moss = self.create("steward", member_token=moss_token)[1]["id"]
        project = self.create(member_token=project_token)[1]["id"]
        notice_room, idle_child = (self.create()[1]["id"] for _ in range(2))
        self.link_child(moss, self.owner, idle_child, self.owner)
        base = f"/api/rooms/{moss}"

        for target, expect in ((project, "reply"), (notice_room, "none")):
            submission = uuid.uuid4().hex
            sent = self.host_relay(moss, target, moss_token, "检查项目", expect=expect, submission_id=submission)
            root = sent["message"]["id"]
            status, receipt = self.request(base + "/room-relay-sent", {"target_room_id": target, "target_message_id": root,
                "target_submission_id": submission, "submission_id": uuid.uuid4().hex, "host": "Codex", "text": "检查项目"}, self.owner)
            self.assertEqual(status, 200, receipt)
            if expect == "reply":
                project_card = receipt["message_id"]

        endpoint = base + "/steward-work"
        items = {row["room_id"]: row for row in self.request(endpoint, token=self.owner)[1]["items"]}
        self.assertEqual(set(items), {project, idle_child})
        self.assertEqual((items[project]["delegation_message_id"], items[project]["state"]), (project_card, ""))
        self.assertIsNone(items[idle_child]["delegation_message_id"])
        status, result = self.request(f"/api/rooms/{project}/messages", {"author": "Codex", "text": "项目检查完成",
            "execution_id": self.reserve_moss_work(project), "submission_id": uuid.uuid4().hex}, project_token)
        self.assertEqual(status, 201, result)
        items = {row["room_id"]: row for row in self.request(endpoint, token=self.owner)[1]["items"]}
        self.assertEqual((items[project]["state"], items[project]["summary"], items[project]["result_message_id"]),
                         ("completed", "项目检查完成", result["message"]["id"]))
        self.assertTrue(items[project]["updated_at"])
        self.assertEqual(self.request(base)[1]["free"]["requests"], [])

    def test_moss_rework_without_result_reminds_child_and_reports_unreported(self):
        moss, child, first_root, moss_token, child_token = self.start_moss_delegation(project=True)
        first_run = self.reserve_moss_work(child)
        first_result = self.host_relay(child, moss, child_token, "首轮结果", reply_to=first_root, execution_id=first_run)
        self.assertIn("answer_id", first_result)
        self.assertEqual(self.moss_review_requests(moss, child, first_root)[0]["relay_report_state"], "completed")

        review_run = self.reserve_moss_work(moss)
        self.assertEqual(self.request(f"/api/rooms/{moss}/messages", {"author": "Codex", "text": "请返工",
            "execution_id": review_run, "submission_id": uuid.uuid4().hex}, moss_token)[0], 201)
        rework = self.host_relay(moss, child, moss_token, "请补上缺失的验证", expect="reply", execution_id=review_run)
        rework_root = rework["message"]["id"]
        child_base = f"/api/rooms/{child}"
        status, dispatch = self.request(child_base + "/messages", {"author": "Codex", "text": "直接安排实现成员",
            "to": ["Claude"], "no_handoff": True, "execution_id": self.reserve_moss_work(child),
            "submission_id": uuid.uuid4().hex}, child_token)
        self.assertEqual(status, 201, dispatch)
        status, member_result = self.request(child_base + "/messages", {"author": "Claude", "text": "成员实现已结束",
            "execution_id": self.reserve_moss_work(child, "Claude"), "submission_id": uuid.uuid4().hex}, self.member)
        self.assertEqual(status, 201, member_result)
        requests = self.request(child_base)[1]["free"]["requests"]
        reminders = [request for request in requests if request["purpose"] == "notice" and request["chain_id"] == rework_root]
        self.assertEqual(len(reminders), 1)
        self.assertEqual(self.moss_review_requests(moss, child, rework_root)[1], [])
        run = self.reserve_moss_work(child)
        self.assertEqual(self.request(f"{child_base}/executions/{run}", {"action": "quiet"}, self.owner)[0], 200)

        first_card, first_reviews = self.moss_review_requests(moss, child, first_root)
        rework_card, rework_reviews = self.moss_review_requests(moss, child, rework_root)
        self.assertEqual((first_card["relay_report_state"], len(first_reviews)), ("unreported", 1))
        self.assertEqual((rework_card["relay_report_state"], rework_card["relay_report_message_id"], len(rework_reviews)),
                         ("unreported", reminders[0]["message_id"], 1))


if __name__ == "__main__":
    unittest.main()

"""Free collaboration rooms: owner credential, member credentials, requests and executions."""

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


class FreeRoomTests(unittest.TestCase):
    """Exercise the Python backend only; the Worker rejects free rooms in P1."""

    def setUp(self):
        """Start an isolated server and create one free room with a single Claude member."""
        self.directory = tempfile.TemporaryDirectory()
        self.database = Path(self.directory.name) / "free.db"
        init_database(self.database, seed=False)
        self.server = DiscussionServer(("127.0.0.1", 0), self.database)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"
        self.owner = uuid.uuid4().hex
        self.member = uuid.uuid4().hex
        status, room = self.request("/api/rooms", {"title": "自由单聊", "goal": "遥控一个本地 CLI", "mode": "free",
                                                   "members": [{"name": "Claude", "adapter": "claude", "token": self.member}],
                                                   "submission_id": "free-room-1"}, self.owner)
        self.assertEqual(status, 201, room)
        self.room = room
        self.path = f"/api/rooms/{room['id']}"

    def tearDown(self):
        """Release the server and temporary files."""
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.directory.cleanup()

    def request(self, path, payload=None, token=None):
        """Return status and JSON for successes and rejected writes alike."""
        headers = {"Content-Type": "application/json"}
        if token:
            headers["X-Discussion-Token"] = token
        request = Request(self.base + path, headers=headers,
                          data=json.dumps(payload).encode() if payload is not None else None)
        try:
            response = urlopen(request, timeout=10)
        except HTTPError as error:
            response = error
        with response:
            return response.status, json.loads(response.read())

    def say(self, text, token=None, **extra):
        """Post one owner message with a fresh submission id."""
        return self.request(f"{self.path}/messages", {"author": "用户", "text": text,
                                                       "submission_id": uuid.uuid4().hex, **extra}, token or self.owner)

    def answer(self, execution_id, text="已处理", token=None, **extra):
        """Post one member answer bound to an execution."""
        payload = {"author": "Claude", "text": text, "source": "cli", "submission_id": uuid.uuid4().hex, **extra}
        if execution_id is not None:
            payload["execution_id"] = execution_id
        return self.request(f"{self.path}/messages", payload, token or self.member)

    def reserve(self, client_id=None):
        """Bundle the member's open requests as one execution."""
        member_id = self.request(self.path)[1]["free"]["members"][0]["id"]
        return self.request(f"{self.path}/executions", {"member_id": member_id, "client_id": client_id or uuid.uuid4().hex}, self.owner)

    def test_room_view_reports_free_mode_and_members_without_secrets(self):
        """The public view lists members and states but never any credential hash."""
        room = self.request(self.path)[1]
        self.assertEqual(room["mode"], "free")
        self.assertEqual(room["host"], "用户")
        self.assertEqual(room["free"]["members"][0]["name"], "Claude")
        self.assertNotIn("token_hash", json.dumps(room))
        self.assertNotIn("control_hash", json.dumps(room))
        backup = self.request(f"{self.path}/backup")[1]
        self.assertNotIn("token_hash", json.dumps(backup))
        self.assertNotIn("control_hash", json.dumps(backup))

    def test_creation_requires_owner_credential_and_retries_idempotently(self):
        """A free room needs a control credential; the same submission returns the original room."""
        payload = {"title": "无凭据", "goal": "x", "mode": "free",
                   "members": [{"name": "Claude", "adapter": "claude", "token": self.member}]}
        self.assertEqual(self.request("/api/rooms", payload)[0], 400)
        status, again = self.request("/api/rooms", {"title": "自由单聊", "goal": "遥控一个本地 CLI", "mode": "free",
                                                     "members": [{"name": "Claude", "adapter": "claude", "token": self.member}],
                                                     "submission_id": "free-room-1"}, self.owner)
        self.assertEqual((status, again["id"], again["duplicate"]), (200, self.room["id"], True))

    def test_only_the_owner_credential_can_speak_as_user(self):
        """Missing, wrong, member and other-room credentials cannot write or create requests."""
        other_owner = uuid.uuid4().hex
        other = self.request("/api/rooms", {"title": "另一房间", "goal": "x", "mode": "free",
                                            "members": [{"name": "Codex", "token": uuid.uuid4().hex}]}, other_owner)[1]
        for token in (None, uuid.uuid4().hex, self.member, other_owner):
            status, _ = self.request(f"{self.path}/messages", {"author": "用户", "text": "冒充",
                                                               "submission_id": uuid.uuid4().hex, "source": "user"}, token)
            self.assertEqual(status, 403, token)
        status, _ = self.request(f"{self.path}/messages", {"author": "Claude", "text": "主人冒充成员",
                                                           "submission_id": uuid.uuid4().hex}, self.owner)
        self.assertEqual(status, 403)
        self.assertEqual(self.request(self.path)[1]["free"]["requests"], [])
        self.assertEqual(self.request(f"/api/rooms/{other['id']}")[1]["message_count"], 0)

    def test_single_member_is_named_by_default_and_answer_completes_requests(self):
        """Two messages queue two requests; one execution carries both and one answer closes them."""
        first = self.say("请改首页标题")[1]["message"]
        self.say("另外先别动 footer")
        requests = self.request(self.path)[1]["free"]["requests"]
        self.assertEqual([item["status"] for item in requests], ["pending", "pending"])
        status, execution = self.reserve()
        self.assertEqual(status, 200, execution)
        self.assertEqual([item["message_id"] for item in execution["requests"]], [first["id"], first["id"] + 1])
        self.assertEqual(execution["read_until"], 0)
        self.assertEqual(self.reserve()[0], 409)
        status, saved = self.answer(execution["id"])
        self.assertEqual(status, 201, saved)
        self.assertEqual(saved["message"]["kind"], "chat")
        room = self.request(self.path)[1]["free"]
        self.assertEqual([item["status"] for item in room["requests"]], ["completed", "completed"])
        self.assertEqual(room["members"][0]["execution"]["status"], "completed")
        self.assertEqual(room["members"][0]["read_until"], saved["message"]["id"])

    def test_retried_reservation_returns_the_same_execution(self):
        """A lost reserve response is recovered with the same local client id."""
        self.say("任务")
        client_id = uuid.uuid4().hex
        first = self.reserve(client_id)[1]
        again = self.reserve(client_id)[1]
        self.assertEqual(first["id"], again["id"])

    def test_late_and_unbound_answers_are_rejected(self):
        """Interrupted executions refuse late answers, and an answer cannot be reposted as plain chat."""
        self.say("开始")
        execution = self.reserve()[1]
        self.assertEqual(self.answer(None)[0], 400)
        member_id = self.request(self.path)[1]["free"]["members"][0]["id"]
        self.assertEqual(self.request(f"{self.path}/members/{member_id}/interrupt", {}, None)[0], 403)
        view = self.request(f"{self.path}/members/{member_id}/interrupt", {}, self.owner)[1]
        self.assertEqual(view["members"][0]["execution"]["status"], "cancelled")
        self.assertEqual(self.answer(execution["id"])[0], 409)
        self.assertEqual(self.answer(None)[0], 400)
        self.assertEqual([item["status"] for item in view["requests"]], ["cancelled"])
        self.assertEqual(self.request(self.path)[1]["message_count"], 1)

    def test_interrupt_also_cancels_queued_requests_so_nothing_restarts(self):
        """Stopping a member voids work queued behind it; a new message starts fresh."""
        self.say("一")
        self.reserve()
        self.say("二")
        member_id = self.request(self.path)[1]["free"]["members"][0]["id"]
        view = self.request(f"{self.path}/members/{member_id}/interrupt", {}, self.owner)[1]
        self.assertEqual([item["status"] for item in view["requests"]], ["cancelled", "cancelled"])
        self.say("三")
        execution = self.reserve()[1]
        self.assertEqual(len(execution["requests"]), 1)

    def test_failure_affects_only_its_requests_and_release_requeues(self):
        """A failed execution keeps the room usable; a proven non-delivery returns requests to the queue."""
        self.say("一")
        first = self.reserve()[1]
        status, failed = self.request(f"{self.path}/executions/{first['id']}", {"action": "fail", "reason": "CLI 退出"}, self.owner)
        self.assertEqual((status, failed["status"]), (200, "failed"))
        room = self.request(self.path)[1]
        self.assertEqual(room["phase"], "discussing")
        self.assertEqual(room["free"]["requests"][0]["status"], "failed")
        self.say("二")
        second = self.reserve()[1]
        released = self.request(f"{self.path}/executions/{second['id']}", {"action": "release", "reason": "未送达"}, self.owner)[1]
        self.assertEqual(released["status"], "cancelled")
        third = self.reserve()[1]
        self.assertEqual([item["message_id"] for item in third["requests"]], [item["message_id"] for item in second["requests"]])

    def test_expired_lease_fails_the_execution_and_rejects_its_answer(self):
        """A runner that stopped renewing cannot leave a stale writer behind."""
        self.say("一")
        execution = self.reserve()[1]
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute("UPDATE member_executions SET lease_until=1 WHERE id=?", (execution["id"],))
        self.assertEqual(self.answer(execution["id"])[0], 409)
        inbox = self.request(f"{self.path}/inbox", token=self.owner)[1]
        self.assertEqual(inbox["executions"], [])
        self.assertEqual(self.request(self.path)[1]["free"]["requests"][0]["status"], "failed")

    def test_runner_endpoints_need_the_owner_credential(self):
        """Inbox, reservation and lifecycle actions refuse member and missing credentials."""
        self.say("一")
        for token in (None, self.member):
            self.assertEqual(self.request(f"{self.path}/inbox", token=token)[0], 403)
            self.assertEqual(self.request(f"{self.path}/executions", {"member_id": 1, "client_id": "client-0001"}, token)[0], 403)
        execution = self.reserve()[1]
        self.assertEqual(self.request(f"{self.path}/executions/{execution['id']}", token=self.member)[0], 200)
        self.assertEqual(self.request(f"{self.path}/executions/{execution['id']}", {"action": "renew"}, self.member)[0], 403)

    def test_discussion_controls_are_rejected_in_free_rooms(self):
        """Floor, turns, topic phases and runtime controls do not apply to free rooms."""
        for tail, payload in (("/turns", {"actor": "用户", "expert": "Claude", "question": "q", "submission_id": "turn-0001"}),
                              ("/floor", {"actor": "用户", "action": "take", "revision": 0}),
                              ("/topic", {"actor": "用户", "phase": "paused"}),
                              ("/runtime", {"action": "start", "revision": 0})):
            self.assertEqual(self.request(self.path + tail, payload, self.owner)[0], 400, tail)

    def test_archived_room_stops_messages_and_delivery(self):
        """Archiving keeps history readable but ends new requests and executions."""
        self.say("一")
        self.assertEqual(self.request(f"{self.path}/archive", {"actor": "用户"}, self.owner)[0], 200)
        self.assertEqual(self.say("二")[0], 400)
        self.assertEqual(self.reserve()[0], 409)

    def test_room_deletion_removes_free_records(self):
        """Deleting a free room leaves no member, request or execution rows."""
        self.say("一")
        execution = self.reserve()[1]
        self.answer(execution["id"])
        self.assertEqual(self.request(f"{self.path}/delete", {"actor": "用户", "confirm_title": "自由单聊"}, self.owner)[0], 200)
        with closing(sqlite3.connect(self.database)) as connection:
            for table in ("room_modes", "room_members", "member_requests", "member_executions"):
                self.assertEqual(connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0], 0, table)


class MultiMemberTests(FreeRoomTests):
    """Several members: structured recipients, parallel work, membership changes and manual members."""

    def setUp(self):
        """Reuse the single-member room and add Codex as a second runner member."""
        super().setUp()
        self.codex = uuid.uuid4().hex
        status, view = self.request(f"{self.path}/members", {"name": "Codex", "adapter": "codex_cli", "token": self.codex}, self.owner)
        self.assertEqual(status, 200, view)

    def member_id(self, name):
        """Resolve a member's stable id from the public view."""
        return next(member["id"] for member in self.request(self.path)[1]["free"]["members"] if member["name"] == name)

    def reserve_for(self, name):
        """Reserve one member's open requests."""
        return self.request(f"{self.path}/executions", {"member_id": self.member_id(name), "client_id": uuid.uuid4().hex,
                                                        "cwd": "d:/project"}, self.owner)

    def say(self, text, token=None, **extra):
        """Single-member defaults do not apply here: name Claude unless told otherwise."""
        return super().say(text, token, **({"to": ["Claude"]} | extra))

    def test_unnamed_message_with_several_members_is_only_a_note(self):
        """With two members an unnamed message creates no request; nothing is broadcast."""
        self.assertEqual(super().say("没有点名")[0], 201)
        self.assertEqual(self.request(self.path)[1]["free"]["requests"], [])

    def test_naming_two_members_creates_two_requests_that_run_in_parallel(self):
        """One message to both members queues one request each; both can execute at once."""
        self.assertEqual(self.say("一起看看", to=["Claude", "Codex", "Claude"])[0], 201)
        self.assertEqual(self.say("不在场", to=["Gemini"])[0], 400)
        requests = self.request(self.path)[1]["free"]["requests"]
        self.assertEqual(sorted(item["member"] for item in requests), ["Claude", "Codex"])
        self.assertEqual(self.reserve_for("Claude")[0], 200)
        self.assertEqual(self.reserve_for("Codex")[0], 200)
        self.assertEqual(self.request(self.path)[1]["experts"], {"Claude": "cli", "Codex": "cli"})

    def test_adding_a_member_does_not_interrupt_another_members_work(self):
        """Claude keeps its live execution while Gemini joins."""
        self.say("开始")
        execution = self.reserve_for("Claude")[1]
        self.assertEqual(self.request(f"{self.path}/members", {"name": "Gemini", "token": uuid.uuid4().hex}, self.owner)[0], 200)
        self.assertEqual(self.request(f"{self.path}/members", {"name": "Codex", "token": uuid.uuid4().hex}, self.owner)[0], 409)
        self.assertEqual(self.request(f"{self.path}/members", {"name": "Qwen", "token": uuid.uuid4().hex}, self.member)[0], 403)
        self.assertEqual(self.answer(execution["id"])[0], 201)

    def test_away_voids_work_and_return_needs_a_new_credential(self):
        """Leaving cancels only that member's work; old credential copies never revive."""
        self.say("两人", to=["Claude", "Codex"])
        claude = self.reserve_for("Claude")[1]
        codex = self.reserve_for("Codex")[1]
        codex_id = self.member_id("Codex")
        view = self.request(f"{self.path}/members/{codex_id}", {"action": "away"}, self.owner)[1]
        statuses = {member["name"]: (member["status"], member["execution"]["status"]) for member in view["members"]}
        self.assertEqual(statuses, {"Claude": ("active", "dispatched"), "Codex": ("away", "cancelled")})
        self.assertEqual(self.say("只给离开的人", to=["Codex"])[0], 400)
        late = {"author": "Codex", "text": "迟到", "submission_id": uuid.uuid4().hex, "execution_id": codex["id"]}
        self.assertEqual(self.request(f"{self.path}/messages", late, self.codex)[0], 403)
        self.assertEqual(self.request(f"{self.path}/members/{codex_id}", {"action": "active", "token": self.codex}, self.owner)[0], 400)
        renewed = uuid.uuid4().hex
        self.assertEqual(self.request(f"{self.path}/members/{codex_id}", {"action": "active", "token": renewed}, self.owner)[0], 200)
        self.assertEqual(self.request(f"{self.path}/messages", {**late, "submission_id": uuid.uuid4().hex}, self.codex)[0], 403)
        self.assertEqual(self.request(f"{self.path}/messages", {**late, "submission_id": uuid.uuid4().hex}, renewed)[0], 409)
        self.assertEqual(self.answer(claude["id"])[0], 201)

    def test_removed_member_leaves_history_and_participants(self):
        """Removal keeps past messages but drops the member from the participant list."""
        codex_id = self.member_id("Codex")
        self.assertEqual(self.request(f"{self.path}/members/{codex_id}", {"action": "remove"}, self.owner)[0], 200)
        room = self.request(self.path)[1]
        self.assertEqual([member["name"] for member in room["free"]["members"]], ["Claude"])
        self.assertEqual(room["experts"], {"Claude": "cli"})
        self.assertEqual(self.request(f"{self.path}/members/{codex_id}", {"action": "active", "token": uuid.uuid4().hex}, self.owner)[0], 404)

    def test_manual_member_answers_by_request_and_is_never_delivered(self):
        """A manual member is skipped by the runner and closes only its own open requests."""
        gemini = uuid.uuid4().hex
        self.request(f"{self.path}/members", {"name": "Gemini", "token": gemini, "access": "manual"}, self.owner)
        self.say("请 Gemini 看看", to=["Gemini", "Claude"])
        inbox = self.request(f"{self.path}/inbox", token=self.owner)[1]
        self.assertEqual([member["name"] for member in inbox["members"]], ["Claude", "Codex"])
        self.assertEqual(self.reserve_for("Gemini")[0], 404)
        requests = {item["member"]: item["id"] for item in self.request(self.path)[1]["free"]["requests"]}

        def post(**extra):
            return self.request(f"{self.path}/messages", {"author": "Gemini", "text": "我的看法", "source": "cli",
                                                          "submission_id": uuid.uuid4().hex, **extra}, gemini)
        self.assertEqual(post(request_ids=[requests["Claude"]])[0], 409)
        self.assertEqual(post(execution_id=1)[0], 400)
        self.assertEqual(post(request_ids=[requests["Gemini"]])[0], 201)
        self.assertEqual(post()[0], 201)
        states = {item["member"]: item["status"] for item in self.request(self.path)[1]["free"]["requests"]}
        self.assertEqual(states, {"Gemini": "completed", "Claude": "pending"})

    def test_overlapping_changes_to_the_same_file_are_reported_as_possible_conflicts(self):
        """Two members changing one file in overlapping windows are flagged; the report is recorded once."""
        self.say("改首页", to=["Claude", "Codex"])
        claude, codex = self.reserve_for("Claude")[1], self.reserve_for("Codex")[1]

        def report(execution, files):
            return self.request(f"{self.path}/executions/{execution['id']}", {"action": "report", "changes": files}, self.owner)
        self.assertEqual(report(claude, ["index.html", "a.css"])[0], 200)
        self.assertEqual(report(claude, ["b.css"])[0], 409)
        self.assertEqual(report(codex, "x")[0], 400)
        self.assertEqual(report(codex, ["index.html"])[0], 200)
        conflicts = self.request(self.path)[1]["free"]["conflicts"]
        self.assertEqual(conflicts, [{"members": ["Claude", "Codex"], "executions": [claude["id"], codex["id"]], "files": ["index.html"]}])


class HostTests(FreeRoomTests):
    """An AI host routes unnamed messages, dispatches members, and is woken once per finished batch."""

    member_id = MultiMemberTests.member_id
    reserve_for = MultiMemberTests.reserve_for
    def say(self, text, token=None, **extra):
        """Name Claude unless told otherwise, as in the multi-member cases."""
        return FreeRoomTests.say(self, text, token, **({"to": ["Claude"]} | extra))

    def setUp(self):
        """Claude hosts; Codex and a third runner member, Gemini, work."""
        super().setUp()
        self.codex, self.gemini = uuid.uuid4().hex, uuid.uuid4().hex
        self.request(f"{self.path}/members", {"name": "Codex", "token": self.codex}, self.owner)
        self.request(f"{self.path}/members", {"name": "Gemini", "token": self.gemini}, self.owner)
        status, view = self.request(f"{self.path}/members/{self.member_id('Claude')}", {"action": "role", "role": "host"}, self.owner)
        self.assertEqual(status, 200, view)
        self.tokens = {"Claude": self.member, "Codex": self.codex, "Gemini": self.gemini}

    def requests(self):
        """Current requests as (member, purpose, status) triples."""
        return [(item["member"], item["purpose"], item["status"]) for item in self.request(self.path)[1]["free"]["requests"]]

    def work(self, name, **extra):
        """Reserve a member's requests and answer them, optionally naming members as the host."""
        execution = self.reserve_for(name)[1]
        status, saved = self.request(f"{self.path}/messages", {"author": name, "text": f"{name} 完成", "source": "cli",
                                                               "submission_id": uuid.uuid4().hex, "execution_id": execution["id"], **extra}, self.tokens[name])
        self.assertEqual(status, 201, saved)
        return execution

    def test_unnamed_message_with_several_members_is_only_a_note(self):
        """With a host, an unnamed message is routed to the host instead of staying a note."""
        FreeRoomTests.say(self, "没有点名")
        self.assertEqual(self.requests(), [("Claude", "route", "pending")])

    def test_host_dispatch_hands_back_once_after_every_member_finished(self):
        """Two dispatched members produce exactly one hand-off, after the last of them finishes."""
        FreeRoomTests.say(self, "请安排")
        self.work("Claude", to=["Codex", "Gemini"])
        self.assertEqual(self.requests()[1:], [("Codex", "ask", "pending"), ("Gemini", "ask", "pending")])
        self.work("Codex")
        self.assertNotIn(("Claude", "handoff", "pending"), self.requests())
        self.work("Gemini")
        self.assertEqual(self.requests().count(("Claude", "handoff", "pending")), 1)

    def test_partial_failure_still_hands_back_but_all_failed_halts(self):
        """One completed member is enough to hand back; a batch where all fail halts the chain."""
        FreeRoomTests.say(self, "第一链")
        self.work("Claude", to=["Codex", "Gemini"])
        failing = self.reserve_for("Gemini")[1]
        self.request(f"{self.path}/executions/{failing['id']}", {"action": "fail", "reason": "CLI 退出"}, self.owner)
        self.work("Codex")
        self.assertEqual(self.requests().count(("Claude", "handoff", "pending")), 1)
        self.work("Claude", to=["Codex"])
        failing = self.reserve_for("Codex")[1]
        self.request(f"{self.path}/executions/{failing['id']}", {"action": "fail", "reason": "再次失败"}, self.owner)
        free = self.request(self.path)[1]["free"]
        self.assertEqual([item["reason"] for item in free["halted_chains"]], ["all_failed"])
        self.assertEqual(self.requests().count(("Claude", "handoff", "pending")), 0)

    def test_chain_budget_stops_automatic_progress_until_the_user_speaks(self):
        """AI-created requests beyond the budget halt the chain; a new owner message starts fresh."""
        from backend import free_room
        original = free_room.MAX_AUTO_HOPS
        free_room.MAX_AUTO_HOPS = 2
        try:
            FreeRoomTests.say(self, "预算")
            self.work("Claude", to=["Codex"])
            self.work("Codex")
            self.work("Claude", to=["Gemini"])
            free = self.request(self.path)[1]["free"]
            self.assertEqual([item["reason"] for item in free["halted_chains"]], ["budget"])
            self.assertEqual(self.requests()[-1], ("Claude", "handoff", "completed"))
            FreeRoomTests.say(self, "新的一链", to=["Claude"])
            self.work("Claude", to=["Gemini"])
            self.assertEqual(self.requests()[-1], ("Gemini", "ask", "pending"))
        finally:
            free_room.MAX_AUTO_HOPS = original

    def test_only_the_host_may_name_members_and_never_itself(self):
        """A member naming others or the host naming itself is rejected before anything is saved."""
        FreeRoomTests.say(self, "派活检查", to=["Codex", "Claude"])
        codex = self.reserve_for("Codex")[1]
        payload = {"author": "Codex", "text": "越权", "source": "cli", "submission_id": uuid.uuid4().hex, "execution_id": codex["id"], "to": ["Gemini"]}
        self.assertEqual(self.request(f"{self.path}/messages", payload, self.codex)[0], 403)
        host = self.reserve_for("Claude")[1]
        payload = {"author": "Claude", "text": "点名自己", "source": "cli", "submission_id": uuid.uuid4().hex, "execution_id": host["id"], "to": ["Claude"]}
        self.assertEqual(self.request(f"{self.path}/messages", payload, self.member)[0], 400)

    def test_one_host_at_a_time(self):
        """Making Codex host demotes Claude."""
        self.request(f"{self.path}/members/{self.member_id('Codex')}", {"action": "role", "role": "host"}, self.owner)
        roles = {member["name"]: member["role"] for member in self.request(self.path)[1]["free"]["members"]}
        self.assertEqual(roles, {"Claude": "member", "Codex": "host", "Gemini": "member"})


class OnlineAndLinkTests(FreeRoomTests):
    """Online members are forwarded by the owner; brainstorm rooms remember the free room they came from."""

    def test_owner_forwards_an_online_members_answer(self):
        """The online member never posts itself; the owner's forward keeps it as author and closes its request."""
        deepseek = uuid.uuid4().hex
        self.request(f"{self.path}/members", {"name": "DeepSeek", "token": deepseek, "access": "online"}, self.owner)
        self.assertEqual(self.request(f"{self.path}/members/{self.request(self.path)[1]['free']['members'][1]['id']}",
                                      {"action": "role", "role": "host"}, self.owner)[0], 400)
        self.say("请 DeepSeek 看看", to=["DeepSeek"])
        request_id = self.request(self.path)[1]["free"]["requests"][0]["id"]
        self.assertEqual(self.reserve()[0], 409)
        own = {"author": "DeepSeek", "text": "自己发", "source": "cli", "submission_id": uuid.uuid4().hex}
        self.assertEqual(self.request(f"{self.path}/messages", own, deepseek)[0], 403)
        forward = {"author": "DeepSeek", "text": "在线回答原文", "submission_id": uuid.uuid4().hex, "request_ids": [request_id]}
        self.assertEqual(self.request(f"{self.path}/messages", {**forward, "author": "Qwen"}, self.owner)[0], 403)
        status, saved = self.request(f"{self.path}/messages", forward, self.owner)
        self.assertEqual(status, 201, saved)
        self.assertEqual((saved["message"]["author"], saved["message"]["submitted_by"], saved["message"]["source"]), ("DeepSeek", "用户", "proxy"))
        self.assertEqual(self.request(self.path)[1]["free"]["requests"][0]["status"], "completed")

    def test_brainstorm_room_links_back_to_its_free_room(self):
        """A discussion started from a free room records its origin; free rooms cannot be linked children."""
        status, child = self.request("/api/rooms", {"title": "方案头脑风暴", "goal": "x", "parent_room_id": self.room["id"]})
        self.assertEqual(status, 201, child)
        self.assertEqual(child["parent_room"], {"id": self.room["id"], "title": "自由单聊"})
        self.assertEqual(self.request(self.path)[1]["linked_rooms"], [{"id": child["id"], "title": "方案头脑风暴", "phase": "preparing"}])
        self.assertEqual(self.request("/api/rooms", {"title": "无效", "goal": "x", "parent_room_id": child["id"]})[0], 400)
        self.assertEqual(self.request("/api/rooms", {"title": "无效", "goal": "x", "mode": "free", "parent_room_id": self.room["id"],
                                                     "members": [{"name": "Claude", "token": uuid.uuid4().hex}]}, uuid.uuid4().hex)[0], 400)


class InstanceTests(FreeRoomTests):
    """Two instances of one platform are separate members with their own credentials and requests."""

    def test_two_claude_instances_are_distinct_members(self):
        """Claude and Claude-评审 receive separate requests and answer only with their own credential."""
        reviewer = uuid.uuid4().hex
        self.assertEqual(self.request(f"{self.path}/members", {"name": "Claude-评审", "adapter": "claude", "token": reviewer}, self.owner)[0], 200)
        for name in ("Claudex", "Claude-", "Foo-1", "Claude-a b"):
            self.assertEqual(self.request(f"{self.path}/members", {"name": name, "token": uuid.uuid4().hex}, self.owner)[0], 400, name)
        self.say("请评审", to=["Claude-评审"])
        requests = self.request(self.path)[1]["free"]["requests"]
        self.assertEqual([item["member"] for item in requests], ["Claude-评审"])
        member_id = next(member["id"] for member in self.request(self.path)[1]["free"]["members"] if member["name"] == "Claude-评审")
        execution = self.request(f"{self.path}/executions", {"member_id": member_id, "client_id": uuid.uuid4().hex}, self.owner)[1]
        self.assertEqual(self.answer(execution["id"], token=reviewer)[0], 403)
        payload = {"author": "Claude-评审", "text": "评审意见", "source": "cli", "submission_id": uuid.uuid4().hex, "execution_id": execution["id"]}
        self.assertEqual(self.request(f"{self.path}/messages", payload, self.member)[0], 403)
        status, saved = self.request(f"{self.path}/messages", payload, reviewer)
        self.assertEqual((status, saved["message"]["author"]), (201, "Claude-评审"))

    def test_discussion_rooms_accept_instances_as_experts_and_host(self):
        """A brainstorm room may hold two Claude instances, one of them hosting."""
        status, room = self.request("/api/rooms", {"title": "双 Claude", "goal": "x", "host": "Claude-主持",
                                                   "experts": {"Claude-主持": "cli", "Claude": "cli", "Codex": "online"}})
        self.assertEqual(status, 201, room)
        self.assertEqual(room["floor"]["holder"], "Claude-主持")
        self.assertEqual(self.request("/api/rooms", {"title": "无效", "goal": "x", "experts": {"Claudex": "cli"}})[0], 400)
        many = {f"Claude-{number}": "cli" for number in range(13)}
        self.assertEqual(self.request("/api/rooms", {"title": "过多", "goal": "x", "experts": many})[0], 400)


class MigrationTests(unittest.TestCase):
    """The floor trigger is replaced on existing databases, and legacy rooms stay brainstorm rooms."""

    def test_existing_floor_trigger_is_replaced_and_rerun_is_harmless(self):
        """An old trigger definition is upgraded; repeating initialization changes nothing."""
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "old.db"
            init_database(database, seed=True)
            with closing(sqlite3.connect(database)) as connection, connection:
                connection.execute("DROP TRIGGER require_message_floor")
                connection.execute("""CREATE TRIGGER require_message_floor BEFORE INSERT ON messages
                    WHEN NEW.author<>'用户' AND NOT EXISTS (SELECT 1 FROM room_floor WHERE room_id=NEW.room_id AND holder=NEW.author)
                    BEGIN SELECT RAISE(ABORT, 'floor_required'); END""")
            init_database(database)
            init_database(database)
            with closing(sqlite3.connect(database)) as connection:
                sql = connection.execute("SELECT sql FROM sqlite_master WHERE name='require_message_floor'").fetchone()[0]
                self.assertIn("room_modes", sql)
                self.assertEqual(connection.execute("SELECT COUNT(*) FROM room_modes").fetchone()[0], 0)
                with self.assertRaises(sqlite3.IntegrityError):
                    connection.execute("INSERT INTO messages (room_id,author,text,source,submission_id,created_at) VALUES ('welcome','Codex','x','cli','late-0001','now')")

    def test_early_free_tables_gain_later_columns(self):
        """A database created before the member columns existed is upgraded in place."""
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "early.db"
            with closing(sqlite3.connect(database)) as connection, connection:
                connection.execute("CREATE TABLE room_members (id INTEGER PRIMARY KEY, room_id TEXT, name TEXT, adapter TEXT, "
                                   "role TEXT, status TEXT, token_hash TEXT, read_until INTEGER, created_at TEXT)")
                connection.execute("CREATE TABLE member_executions (id INTEGER PRIMARY KEY, room_id TEXT, member_id INTEGER, "
                                   "client_id TEXT, status TEXT, session_id TEXT, lease_until INTEGER, created_at INTEGER, "
                                   "finished_at INTEGER, result TEXT)")
            init_database(database, seed=False)
            init_database(database, seed=False)
            with closing(sqlite3.connect(database)) as connection:
                members = {row[1] for row in connection.execute("PRAGMA table_info(room_members)")}
                executions = {row[1] for row in connection.execute("PRAGMA table_info(member_executions)")}
            self.assertTrue({"access", "session_mode"} <= members)
            self.assertTrue({"changes", "cwd"} <= executions)


if __name__ == "__main__":
    unittest.main()

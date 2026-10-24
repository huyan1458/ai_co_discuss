"""Exercise durable execution through both HTTP backends, never real AI apps."""

import json
import os
import sqlite3
import tempfile
import threading
import time
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from backend.server import DiscussionServer, init_database


class RuntimeTests(unittest.TestCase):
    """Verify user controls, atomic business events and stale execution rejection."""

    def setUp(self):
        """Start an isolated Python instance unless a local Worker was selected."""
        self.base = os.getenv("DISCUSS_TEST_URL", "").rstrip("/")
        if self.base and not self.base.startswith(("http://127.0.0.1:", "http://localhost:")):
            raise ValueError("运行写入测试只能指向隔离的本机服务")
        self.directory = tempfile.TemporaryDirectory()
        if not self.base:
            self.database = Path(self.directory.name) / "runtime.db"
            init_database(self.database, seed=False)
            self.server = DiscussionServer(("127.0.0.1", 0), self.database)
            self.server.local_site = False  # these tests exercise room credential rules, not the account-free local site
            self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
            self.thread.start()
            self.base = f"http://127.0.0.1:{self.server.server_port}"
        self.owner = uuid.uuid4().hex
        self.member_tokens = {name: uuid.uuid4().hex for name in ("Codex", "Claude", "Gemini", "DeepSeek", "Qwen")}
        room = self.request("/api/rooms", {"title": "隔离运行验证", "host": "Codex", "phase": "initial",
            "experts": {"Codex": "cli", "Claude": "cli", "Gemini": "cli"}})[1]
        self.room = room["id"]
        self.path = f"/api/rooms/{self.room}"

    def tearDown(self):
        """Close only the test server and its temporary directory."""
        if hasattr(self, "server"):
            self.server.shutdown()
            self.server.server_close()
            self.thread.join()
        self.directory.cleanup()

    def request(self, path, payload=None, token=None, extra_headers=None):
        """Return JSON and status for successes and rejected writes alike."""
        headers = {"Content-Type": "application/json"}
        if payload is not None and path == "/api/rooms":
            payload = dict(payload)
            experts = payload.get("experts", {name: "cli" if name == "Codex" else "online" for name in self.member_tokens})
            payload.setdefault("members", [{"name": name, "token": self.member_tokens[name],
                "access": "online" if mode == "online" else "runner" if payload.get("runtime_mode") == "automatic" else "manual"} for name, mode in experts.items()])
        if token is None:
            actor = (payload or {}).get("actor", (payload or {}).get("submitted_by", (payload or {}).get("author", "用户")))
            token = self.owner if actor == "用户" or path == "/api/rooms" else self.member_tokens.get(actor, "")
        if token:
            headers["X-Discussion-Token"] = token
        headers.update(extra_headers or {})
        request = Request(self.base + path, headers=headers,
                          data=json.dumps(payload).encode() if payload is not None else None)
        try:
            response = urlopen(request, timeout=10)
        except HTTPError as error:
            response = error
        with response:
            return response.status, json.load(response)

    def start(self, deadline=None):
        """Opt into one run with an owner capability and an optional time limit."""
        status, value = self.request(self.path + "/runtime", {"action": "start", "mode": "automatic",
            "revision": 0, "deadline": int(time.time()) + 600 if deadline is None else deadline}, self.owner)
        self.assertEqual(status, 200, value)
        return value

    def test_manual_room_requires_distinct_owner_and_member_capabilities(self):
        """Manual delivery grants scoped member access, never implicit owner authority."""
        message = {"author": "用户", "text": "要求", "submission_id": "manual-user-note"}
        for token in ("", uuid.uuid4().hex, self.member_tokens["Codex"]):
            self.assertEqual(self.request(self.path + "/messages", message, token)[0], 403)
        self.assertEqual(self.request(self.path + "/messages", message, self.owner)[0], 201)
        host = {"actor": "Codex", "text": "主持摘要"}
        self.assertEqual(self.request(self.path + "/state", host, self.member_tokens["Codex"])[0], 200)
        self.assertEqual(self.request(self.path + "/state", host, self.member_tokens["Claude"])[0], 403)
        self.assertEqual(self.request(self.path + "/state", {**host, "actor": "Claude"}, self.member_tokens["Claude"])[0], 403)
        self.assertEqual(self.request(self.path + "/topic", {"actor": "Codex", "experts": {"Codex": "cli"}}, self.member_tokens["Codex"])[0], 403)
        self.assertEqual(self.request(self.path + "/runtime", {"revision": 0, "mode": "automatic"}, self.member_tokens["Codex"])[0], 403)
        own = {"author": "Codex", "source": "cli", "kind": "moderation", "text": "主持原文", "submission_id": "manual-host-note"}
        self.assertEqual(self.request(self.path + "/messages", own, self.owner)[0], 403)
        self.assertEqual(self.request(self.path + "/messages", own, self.member_tokens["Codex"])[0], 201)
        self.assertEqual(self.request(self.path + "/topic", {"actor": "用户", "experts": {"Codex": "cli"}}, self.owner)[0], 200)
        self.assertEqual(self.request(self.path + "/messages", {**own, "author": "Claude", "submission_id": "removed-member"}, self.member_tokens["Claude"])[0], 403)
        public = json.dumps([self.request(self.path, token="")[1], self.request(self.path + "/backup", token="")[1]])
        for secret in (self.owner, *self.member_tokens.values()):
            self.assertNotIn(secret, public)
        self.assertNotIn("token_hash", public)
        self.assertNotIn("control_hash", public)

    def test_manual_online_members_need_an_authenticated_proxy(self):
        """Online identities cannot write, while the owner can forward their real answer."""
        token = uuid.uuid4().hex
        payload = {"actor": "用户", "experts": {"Codex": "cli", "Qwen": "online"},
                   "members": [{"name": "Qwen", "access": "online", "token": token}]}
        self.assertEqual(self.request(self.path + "/topic", payload, self.owner)[0], 200)
        turn = self.request(self.path + "/turns", {"actor": "用户", "expert": "Qwen", "question": "问题", "submission_id": "manual-online-turn"})[1]["turn"]
        floor = self.request(self.path + "/floor")[1]
        self.assertEqual(self.request(self.path + "/floor", {"actor": "用户", "speaker": "Qwen", "action": "take", "revision": floor["revision"]})[0], 200)
        answer = {"author": "Qwen", "submitted_by": "Qwen", "source": "cli", "text": "原文", "turn_id": turn["id"], "submission_id": "online-answer"}
        self.assertEqual(self.request(self.path + "/messages", answer, token)[0], 403)
        answer.update(submitted_by="用户", source="proxy")
        status, saved = self.request(self.path + "/messages", answer, self.owner)
        self.assertEqual(status, 201, saved)
        self.assertEqual(saved["message"]["source"], "proxy")

    def test_member_credential_never_replaces_automatic_execution(self):
        """A persistent identity only writes manually; automatic work needs its live lease."""
        run = self.start()
        payload = {"actor": "Codex", "text": "主持摘要"}
        self.assertEqual(self.request(self.path + "/state", payload, self.member_tokens["Codex"])[0], 403)
        execution = self.enter(self.events()[0])
        self.assertEqual(self.request(self.path + "/state", payload, execution)[0], 200)
        paused = self.request(self.path + "/runtime", {"action": "pause", "revision": run["revision"]}, self.owner)[1]
        self.assertEqual(self.request(self.path + "/state", payload, execution)[0], 403)
        self.assertEqual(self.request(self.path + "/runtime", {"mode": "manual", "revision": paused["revision"]}, self.owner)[0], 200)
        self.assertEqual(self.request(self.path + "/state", payload, execution)[0], 403)
        self.assertEqual(self.request(self.path + "/state", payload, self.member_tokens["Codex"])[0], 200)

    def test_browser_updates_follow_execution_changes_not_lease_heartbeats(self):
        """Entering execution notifies readers while a renewal keeps the stream quiet."""
        if not hasattr(self, "server"):
            self.skipTest("Worker notification behavior has its own namespace fixture")
        previous = self.server.update_version
        self.start()
        self.assertGreater(self.server.update_version, previous)
        event = self.events()[0]
        previous = self.server.update_version
        self.enter(event)
        self.assertEqual(self.server.update_version, previous + 2)
        previous = self.server.update_version
        self.assertEqual(self.request(self.path + f"/events/{event['id']}", {"action": "renew"}, self.owner)[0], 200)
        self.assertEqual(self.server.update_version, previous)

    def events(self):
        """Read the durable inbox using its room owner capability."""
        return self.request(self.path + "/events", token=self.owner)[1]["events"]

    def enter(self, event):
        """Reserve and enter with separate owner and execution capabilities."""
        token = uuid.uuid4().hex
        path = self.path + f"/events/{event['id']}"
        self.assertEqual(self.request(path, {"action": "reserve", "execution_token": token}, self.owner)[0], 200)
        self.assertEqual(self.request(path, {"action": "enter", "session_id": str(uuid.uuid4())}, token)[0], 200)
        return token

    def limited_room(self, **limits):
        """Use a single real expert identity to exercise full-round boundaries."""
        status, room = self.request("/api/rooms", {"title": "上限隔离验证", "host": "Codex",
            "experts": {"Codex": "cli"}, "limits": limits})
        self.assertEqual(status, 201, room)
        self.room, self.path = room["id"], f"/api/rooms/{room['id']}"
        return room

    def complete_round(self):
        """Save one formally assigned answer through the public workflow."""
        status, result = self.request(self.path + "/turns", {"actor": "用户", "expert": "Codex",
            "question": "测试观点", "submission_id": "limited-turn"}, self.owner)
        self.assertEqual(status, 201, result)
        runtime = self.request(self.path + "/runtime")[1]
        token = self.enter(self.events()[-1]) if runtime["mode"] == "automatic" else self.member_tokens["Codex"]
        floor = self.request(self.path + "/floor")[1]
        self.assertEqual(self.request(self.path + "/floor", {"actor": "Codex", "action": "take",
            "revision": floor["revision"]}, token)[0], 200)
        answer = {"author": "Codex", "kind": "opinion", "source": "cli", "text": "测试原文",
                  "submission_id": "limited-answer", "turn_id": result["turn"]["id"]}
        self.assertEqual(self.request(self.path + "/messages", answer, token)[0], 201)
        return answer

    def test_round_limit_blocks_new_work_but_preserves_exact_retry(self):
        """A completed round prevents further work while retries stay idempotent."""
        self.limited_room(max_rounds=1)
        answer = self.complete_round()
        self.assertEqual(self.request(self.path + "/messages", answer, self.member_tokens["Codex"])[0], 200)
        self.assertEqual(self.request(self.path)[1]["limits"]["reason"], "round_limit")
        status, _ = self.request(self.path + "/turns", {"actor": "用户", "expert": "Codex",
            "question": "不得新增", "submission_id": "limited-next"})
        self.assertEqual(status, 409)
        self.assertEqual(self.request(self.path + "/messages", {"author": "用户", "text": "补充要求",
            "submission_id": "limit-user-note"})[0], 201)
        status, room = self.request(self.path + "/limits", {"actor": "用户"})
        self.assertEqual(status, 200, room)
        self.assertEqual(room["phase"], "paused")

    def test_summary_replaces_old_execution_and_does_not_fake_conclusion(self):
        """Round exhaustion hands a bounded closing task to the actual host."""
        self.limited_room(max_rounds=1, max_minutes=60, on_limit="summarize", summary_minutes=2)
        self.start()
        self.complete_round()
        old_token = self.enter(self.events()[-1])
        status, room = self.request(self.path + "/limits", {"actor": "用户"}, self.owner)
        self.assertEqual(status, 200, room)
        self.assertTrue(room["limits"]["closing"])
        self.assertNotEqual(room["phase"], "concluded")
        self.assertLessEqual(room["runtime"]["deadline"], int(time.time()) + 120)
        self.assertEqual(self.request(self.path + "/state", {"actor": "Codex", "text": "旧执行"}, old_token)[0], 403)
        token = self.enter(self.events()[-1])
        revision = room["runtime"]["revision"]
        self.assertEqual(self.request(self.path + "/limits", {"actor": "用户"}, self.owner)[1]["runtime"]["revision"], revision)
        self.assertEqual(self.request(self.path + "/topic", {"actor": "Codex", "phase": "concluded"}, token)[0], 200)

    def test_forced_close_hands_summary_to_host_before_limits(self):
        """A user can end early; the expert is cancelled and the host gets the closing reserve."""
        self.limited_room(max_rounds=3, summary_minutes=2)
        self.request(self.path + "/turns", {"actor": "用户", "expert": "Codex", "question": "待打断",
            "submission_id": "forced-turn"})
        self.start()
        expert_token = self.enter(self.events()[-1])
        status, room = self.request(self.path + "/limits", {"actor": "用户", "force": True}, self.owner)
        self.assertEqual(status, 200, room)
        self.assertTrue(room["limits"]["closing"])
        self.assertEqual(room["limits"]["stop_reason"], "user_stop")
        self.assertEqual(room["current_turn"]["status"], "cancelled")
        self.assertLessEqual(room["runtime"]["deadline"], int(time.time()) + 120)
        self.assertEqual(self.request(self.path + "/state", {"actor": "Codex", "text": "旧执行"}, expert_token)[0], 403)
        self.assertEqual(self.events()[-1]["role"], "host")
        status, _ = self.request(self.path + "/limits", {"actor": "用户", "force": True}, self.owner)
        self.assertEqual(status, 200)
        self.request(self.path + "/runtime", {"action": "pause", "revision": room["runtime"]["revision"]}, self.owner)
        self.assertEqual(self.request(self.path + "/limits", {"actor": "用户", "force": True}, self.owner)[0], 400)

    def test_runtime_reports_latest_execution_per_participant(self):
        """The progress panel sees each participant's latest execution and failure count."""
        self.request(self.path + "/turns", {"actor": "用户", "expert": "Claude", "question": "执行状态",
            "submission_id": "participant-turn"})
        run = self.start()
        event = self.events()[-1]
        self.enter(event)
        self.request(self.path + f"/events/{event['id']}", {"action": "fail", "reason": "软件未响应"}, self.owner)
        participants = self.request(self.path)[1]["runtime"]["participants"]
        claude = next(item for item in participants if item["participant"] == "Claude")
        self.assertEqual((claude["status"], claude["failures"], claude["result"], claude["stale"]),
                         ("failed", 1, "软件未响应", False))
        self.assertNotIn("lease_until", claude)
        self.assertEqual(len(claude["session_id"]), 36)
        self.assertNotIn("token_hash", claude)
        self.assertEqual(run["participants"][0]["participant"], "Claude")

    def test_failed_attempts_survive_retry_and_remain_separate_from_messages(self):
        """Retry creates another execution while preserving public failure history and its timing."""
        turn = self.request(self.path + "/turns", {"actor": "用户", "expert": "Claude", "question": "失败重试",
            "submission_id": "failed-turn"})[1]["turn"]
        self.start()
        failures = []
        for reason in ("模型未调用房间工具保存结果", "第二次执行失败"):
            event = self.events()[-1]
            self.enter(event)
            self.assertEqual(self.request(self.path + f"/events/{event['id']}",
                {"action": "fail", "reason": reason}, self.owner)[0], 200)
            room = self.request(self.path)[1]
            failure = room["runtime"]["failures"][-1]
            self.assertEqual(set(failure), {"id", "participant", "role", "turn_id", "result", "created_at", "elapsed_seconds"})
            self.assertEqual((failure["id"], failure["turn_id"], failure["result"]), (event["id"], turn["id"], reason))
            self.assertGreaterEqual(failure["elapsed_seconds"], 0)
            failures.append(failure)
            self.assertEqual(room["runtime"]["failures"], failures)
            self.assertEqual(room["message_count"], 0)
            status, restarted = self.request(self.path + "/runtime", {"action": "start",
                "revision": room["runtime"]["revision"], "deadline": 0}, self.owner)
            self.assertEqual(status, 200, restarted)
            self.assertNotEqual(restarted["latest_execution"]["id"], event["id"])
            self.assertEqual(restarted["failures"], failures)
            self.assertEqual(self.request(self.path)[1]["current_turn"]["id"], turn["id"])
        token = self.enter(self.events()[-1])
        floor = self.request(self.path + "/floor")[1]
        self.request(self.path + "/floor", {"actor": "Claude", "action": "take", "revision": floor["revision"]}, token)
        status, answer = self.request(self.path + "/messages", {"author": "Claude", "source": "cli", "kind": "opinion",
            "text": "重试后的回答", "summary": "回答已保存", "turn_id": turn["id"], "submission_id": "retried-answer"}, token)
        self.assertEqual(status, 201, answer)
        self.assertEqual(self.request(self.path)[1]["runtime"]["failures"], failures)

    def test_runtime_reports_stage_timings_of_current_run(self):
        """Each dispatched execution exposes queue, wake and work durations."""
        self.request(self.path + "/turns", {"actor": "用户", "expert": "Claude", "question": "耗时记录",
            "submission_id": "timing-turn"})
        self.start()
        event = self.events()[-1]
        timings = self.request(self.path)[1]["runtime"]["timings"]
        self.assertEqual((timings["count"], timings["items"][0]["status"], timings["items"][0]["wake_seconds"]),
                         (1, "pending", None))
        self.enter(event)
        self.request(self.path + f"/events/{event['id']}", {"action": "fail", "reason": "计时验证"}, self.owner)
        timings = self.request(self.path)[1]["runtime"]["timings"]
        item = timings["items"][0]
        self.assertEqual((item["id"], item["participant"], item["status"]), (event["id"], "Claude", "failed"))
        for stage in ("queue_seconds", "wake_seconds", "work_seconds"):
            self.assertGreaterEqual(item[stage], 0)
            self.assertEqual(timings["totals"][stage], item[stage])
        self.assertNotIn("token_hash", item)

    def test_message_elapsed_time_is_frozen_for_host_and_expert_only(self):
        """Save execution time with original messages, including zero and exact retries."""
        self.start()
        host_token = self.enter(self.events()[-1])
        host = {"author": "Codex", "source": "cli", "kind": "moderation", "text": "主持发言",
                "submission_id": "timed-host", "elapsed_seconds": 999999}
        status, saved = self.request(self.path + "/messages", host, host_token)
        self.assertEqual(status, 201, saved)
        self.assertGreaterEqual(saved["message"]["elapsed_seconds"], 0)
        self.assertLess(saved["message"]["elapsed_seconds"], 60)
        user = self.request(self.path + "/messages", {"author": "用户", "text": "用户留言",
                            "submission_id": "timed-user", "elapsed_seconds": 999999})[1]["message"]
        self.assertIsNone(user["elapsed_seconds"])
        self.take_floor("Codex", host_token)
        turn = self.request(self.path + "/turns", {"actor": "Codex", "expert": "Claude",
            "question": "给出回答", "submission_id": "timed-turn"}, host_token)[1]["turn"]
        expert_token = self.enter(self.events()[-1])
        self.take_floor("Claude", expert_token)
        answer = {"author": "Claude", "source": "cli", "text": "专家回答",
                  "turn_id": turn["id"], "submission_id": "timed-answer"}
        status, saved = self.request(self.path + "/messages", answer, expert_token)
        self.assertEqual(status, 201, saved)
        message = saved["message"]
        self.assertGreaterEqual(message["elapsed_seconds"], 0)
        status, retry = self.request(self.path + "/messages", answer, self.owner)
        self.assertEqual(status, 403, retry)
        self.assertEqual(self.request(self.path + f"/messages/{message['id']}")[1], message)
        self.assertEqual(self.request(self.path + "/messages")[1]["messages"][-1], message)
        timings = self.request(self.path + "/backup")[1]["tables"]["message_timings"]
        self.assertEqual(len(timings), 2)
        self.assertEqual(timings[-1], {"message_id": message["id"], "elapsed_seconds": message["elapsed_seconds"]})

    def test_paused_time_is_excluded_from_elapsed_time_and_deadline(self):
        """Idle time while paused neither counts as elapsed nor consumes the total duration."""
        if not hasattr(self, "database"):
            self.skipTest("需要直接调整本地数据库中的暂停起点")
        self.limited_room(max_minutes=60)
        run = self.start()
        started = self.request(self.path)[1]["limits"]
        self.request(self.path + "/runtime", {"action": "pause", "revision": run["revision"]}, self.owner)
        connection = sqlite3.connect(self.database)
        try:
            with connection:
                connection.execute("UPDATE discussion_pauses SET paused_at=paused_at-600 WHERE room_id=?", (self.room,))
        finally:
            connection.close()
        paused = self.request(self.path)[1]
        self.assertLess(paused["limits"]["elapsed_seconds"], 60)
        self.assertGreaterEqual(paused["limits"]["deadline"], started["deadline"] + 600)
        self.assertFalse(paused["limits"]["reached"])
        status, resumed = self.request(self.path + "/runtime", {"action": "start", "revision": paused["runtime"]["revision"]}, self.owner)
        self.assertEqual(status, 200, resumed)
        room = self.request(self.path)[1]
        self.assertLess(room["limits"]["elapsed_seconds"], 60)
        self.assertGreaterEqual(room["limits"]["idle_seconds"], 600)

    def test_limits_validation_and_active_edit_protection(self):
        """Bad settings fail; limits are editable only before start or while paused."""
        for limits in ({"max_rounds": -1}, {"max_minutes": 1441}, {"max_rounds": True},
                       {"execution_minutes": -1}, {"execution_minutes": 61}, {"on_limit": "ignore"},
                       {"max_minutes": 5, "on_limit": "summarize", "summary_minutes": 5}, {"started_at": 0}):
            self.assertEqual(self.request("/api/rooms", {"title": "invalid", "limits": limits})[0], 400)
        room = self.limited_room(max_minutes=60, execution_minutes=1)
        self.assertEqual(room["limits"]["started_at"], 0)
        run = self.request(self.path + "/runtime", {"action": "start", "revision": 0}, self.owner)[1]
        self.assertEqual(run["status"], "running")
        self.assertEqual(self.request(self.path + "/topic", {"actor": "用户", "limits": {"max_rounds": 2}}, self.owner)[0], 400)
        event = self.events()[0]
        self.enter(event)
        entered = self.events()[0]
        self.assertLessEqual(entered["lease_until"], int(time.time()) + 60)
        started = self.request(self.path)[1]["limits"]["started_at"]
        self.request(self.path + "/runtime", {"action": "pause", "revision": run["revision"]}, self.owner)
        status, updated = self.request(self.path + "/topic", {"actor": "用户", "limits": {"max_rounds": 2}}, self.owner)
        self.assertEqual(status, 200, updated)
        self.assertEqual(updated["limits"]["started_at"], started)

    def test_reserved_time_cancels_expert_and_hard_deadline_pauses(self):
        """Summary time is inside the total deadline and never extends the run."""
        self.limited_room(max_minutes=10, on_limit="summarize", summary_minutes=1)
        self.request(self.path + "/turns", {"actor": "用户", "expert": "Codex", "question": "待回答",
            "submission_id": "reserve-timing"})
        deadline = int(time.time()) + 3
        self.assertEqual(self.request(self.path + "/runtime", {"action": "start", "revision": 0, "deadline": deadline}, self.owner)[0], 200)
        status, room = self.request(self.path + "/limits", {"actor": "用户"}, self.owner)
        self.assertEqual(status, 200, room)
        self.assertTrue(room["limits"]["closing"])
        self.assertEqual(room["current_turn"]["status"], "cancelled")
        self.assertEqual(room["runtime"]["deadline"], deadline)
        time.sleep(3)
        room = self.request(self.path + "/limits", {"actor": "用户"}, self.owner)[1]
        self.assertEqual(room["phase"], "paused")
        self.assertEqual(room["limits"]["stop_reason"], "time_limit")
        self.assertEqual(room["limits"]["deadline"], deadline)
        self.assertFalse(room["limits"]["closing"])
        self.assertEqual(room["limits"]["remaining_seconds"], 0)

    def test_manual_is_default_and_does_not_create_events(self):
        """Legacy manual rooms remain writable with no runtime setup."""
        room = self.request(self.path)[1]
        self.assertEqual(room["runtime"]["mode"], "manual")
        self.assertFalse(room["runtime"]["protected"])
        self.assertEqual(self.request(self.path + "/messages", {"author": "用户", "text": "手动",
            "submission_id": "manual-test"})[0], 201)

    def test_pending_run_requires_pause_before_reconfigure_or_restart(self):
        """Pending work is still a running discussion, even before delivery."""
        run = self.start()
        events = self.events()
        for action in ("configure", "start"):
            status, result = self.request(self.path + "/runtime", {"action": action,
                "mode": "manual" if action == "configure" else "automatic",
                "revision": run["revision"], "deadline": int(time.time()) + 600}, self.owner)
            self.assertEqual(status, 409, result)
            self.assertEqual(self.events(), events)
            current = self.request(self.path)[1]["runtime"]
            self.assertEqual({k: v for k, v in current.items() if k != "timings"}, {k: v for k, v in run.items() if k != "timings"})

    def test_resuming_summary_preserves_deadline_and_rejects_expired_start(self):
        """Pausing a closing task does not grant another summary budget."""
        self.limited_room(max_minutes=10, on_limit="summarize", summary_minutes=1)
        deadline = int(time.time()) + 4
        run = self.request(self.path + "/runtime", {"action": "start", "revision": 0,
            "deadline": deadline}, self.owner)[1]
        room = self.request(self.path + "/limits", {"actor": "用户"}, self.owner)[1]
        self.assertTrue(room["limits"]["closing"])
        paused = self.request(self.path + "/runtime", {"action": "pause",
            "revision": room["runtime"]["revision"]}, self.owner)[1]
        updated = self.request(self.path + "/topic", {"actor": "用户",
            "limits": {"execution_minutes": 2}}, self.owner)[1]
        self.assertEqual(updated["limits"]["closing_at"], room["limits"]["closing_at"])
        self.assertEqual(updated["limits"]["deadline"], deadline)
        status, resumed = self.request(self.path + "/runtime", {"action": "start",
            "revision": paused["revision"], "deadline": int(time.time()) + 600}, self.owner)
        self.assertEqual(status, 200, resumed)
        self.assertEqual(resumed["deadline"], deadline)
        paused = self.request(self.path + "/runtime", {"action": "pause",
            "revision": resumed["revision"]}, self.owner)[1]
        time.sleep(max(0, deadline - time.time()) + 0.1)
        status, result = self.request(self.path + "/runtime", {"action": "start",
            "revision": paused["revision"], "deadline": int(time.time()) + 600}, self.owner)
        self.assertEqual(status, 400, result)
        self.assertEqual(self.request(self.path)[1]["runtime"]["status"], "paused")

    def test_answer_transaction_drives_host_without_duplicate_events(self):
        """A real formal answer completes its execution and wakes the host once."""
        self.start()
        host_token = self.enter(self.events()[0])
        payload = {"actor": "Codex", "expert": "Claude", "question": "给出判断", "submission_id": "runtime-turn"}
        status, created = self.request(self.path + "/turns", payload, host_token)
        self.assertEqual(status, 201, created)
        turn = created["turn"]
        self.assertEqual(self.events()[0]["status"], "completed")
        self.assertEqual(len(self.events()), 2)
        # The owner cannot impersonate a completed host execution, even on replay.
        self.assertEqual(self.request(self.path + "/turns", payload, self.owner)[0], 403)
        token = self.enter(self.events()[-1])
        floor = self.request(self.path + "/floor")[1]
        self.assertEqual(self.request(self.path + "/floor", {"actor": "Claude", "action": "take", "revision": floor["revision"]}, token)[0], 200)
        answer = {"author": "Claude", "submitted_by": "Claude", "source": "cli", "kind": "opinion",
            "turn_id": turn["id"], "text": "实际回答", "summary": "摘要", "submission_id": "runtime-answer"}
        status, saved = self.request(self.path + "/messages", answer, token)
        self.assertEqual(status, 201, saved)
        self.assertEqual(self.request(self.path + "/messages", answer, self.owner)[0], 403)
        events = self.events()
        self.assertEqual(len(events), 3)
        self.assertEqual(events[1]["status"], "completed")
        self.assertEqual(events[2]["participant"], "Codex")
        self.assertNotIn("token_hash", json.dumps(events))

    def take_floor(self, actor, token):
        """Claim the floor that the last handoff nominated."""
        floor = self.request(self.path + "/floor")[1]
        self.assertEqual(self.request(self.path + "/floor", {"actor": actor, "action": "take",
            "revision": floor["revision"]}, token)[0], 200)

    def answer(self, expert, turn_id, token, submission_id):
        """Take the floor and save one formal answer with the expert's execution token."""
        self.take_floor(expert, token)
        status, saved = self.request(self.path + "/messages", {"author": expert, "source": "cli", "kind": "opinion",
            "turn_id": turn_id, "text": "实际回答", "summary": "摘要", "submission_id": submission_id}, token)
        self.assertEqual(status, 201, saved)

    def cancel_turn(self, turn_id):
        """Close an open assignment directly so its expert no longer counts as speaking."""
        connection = sqlite3.connect(self.database)
        try:
            with connection:
                connection.execute("UPDATE discussion_turns SET status='cancelled' WHERE id=?", (turn_id,))
        finally:
            connection.close()

    def set_phase(self, phase):
        """Move the topic phase directly so member actions can be exercised while paused."""
        connection = sqlite3.connect(self.database)
        try:
            with connection:
                connection.execute("UPDATE topic_settings SET phase=? WHERE room_id=?", (phase, self.room))
        finally:
            connection.close()

    def test_paused_discussion_voids_an_experts_latest_opinion(self):
        """Redo deletes the expert's latest opinion so the round no longer counts it, and only while paused."""
        created, _ = self.plan_round("redo-plan")
        self.answer("Claude", created["turn"]["id"], self.enter(self.events()[-1]), "redo-answer")
        members = {member["name"]: member for member in self.request(self.path)[1]["members"]}
        redo = self.path + f"/members/{members['Claude']['id']}"
        self.assertEqual(self.request(redo, {"action": "redo"}, self.owner)[0], 400, "redo needs a paused discussion")
        self.set_phase("paused")
        room = self.request(self.path)[1]
        self.assertEqual(room["rounds"][-1]["speakers"], ["Claude"])
        status, voided = self.request(redo, {"action": "redo"}, self.owner)
        self.assertEqual(status, 200, voided)
        room = self.request(self.path)[1]
        self.assertEqual(room["rounds"], [])
        self.assertEqual(self.request(self.path + f"/messages?author=Claude")[1]["messages"], [])
        self.assertEqual(self.request(redo, {"action": "redo"}, self.owner)[0], 404, "nothing left to void")

    def plan_round(self, submission_id="round-plan-1"):
        """Let the host arrange Claude then Gemini in one execution."""
        self.start()
        host_token = self.enter(self.events()[0])
        status, created = self.request(self.path + "/turns", {"actor": "Codex", "submission_id": submission_id,
            "turns": [{"expert": "Claude", "question": "先答"}, {"expert": "Gemini", "question": "再答"}]}, host_token)
        self.assertEqual(status, 201, created)
        return created, host_token

    def test_round_plan_relays_between_experts_without_waking_host(self):
        """Only the last answer of an undisturbed plan returns to the host."""
        created, _ = self.plan_round()
        self.assertEqual([item["expert"] for item in created["queued"]], ["Gemini"])
        room = self.request(self.path)[1]
        self.assertEqual((room["current_turn"]["expert"], [item["expert"] for item in room["queued_turns"]]), ("Claude", ["Gemini"]))
        self.assertEqual(self.events()[-1]["participant"], "Claude")
        self.answer("Claude", created["turn"]["id"], self.enter(self.events()[-1]), "plan-answer-1")
        events = self.events()
        self.assertEqual((events[-1]["participant"], events[-1]["role"]), ("Gemini", "expert"))
        room = self.request(self.path)[1]
        self.assertEqual((room["current_turn"]["expert"], room["queued_turns"], room["floor"]["next_speaker"]), ("Gemini", [], "Gemini"))
        self.answer("Gemini", created["queued"][0]["id"], self.enter(events[-1]), "plan-answer-2")
        self.assertEqual((self.events()[-1]["participant"], self.events()[-1]["role"]), ("Codex", "host"))

    def test_invited_experts_append_to_the_round_without_reordering_or_restarting(self):
        """Automatic and manual invitees follow the existing plan; retries never duplicate their turns."""
        created, _ = self.plan_round("invite-tail-plan")
        before = self.request(self.path)[1]
        current_token = self.enter(self.events()[-1])
        for name, access in (("DeepSeek", "runner"), ("Qwen", "manual")):
            payload = {"name": name, "token": self.member_tokens[name], "access": access, "adapter": "api" if access == "runner" else ""}
            status, room = self.request(self.path + "/members", payload, self.owner)
            self.assertEqual(status, 200, room)
            retry = self.request(self.path + "/members", payload, self.owner)[1]
            self.assertEqual(retry["queued_turns"], room["queued_turns"])
        self.assertEqual(room["current_turn"]["id"], created["turn"]["id"])
        self.assertEqual(room["runtime"]["generation"], before["runtime"]["generation"])
        self.assertEqual([turn["expert"] for turn in room["queued_turns"]], ["Gemini", "DeepSeek", "Qwen"])
        self.assertEqual(room["queued_turns"][0], before["queued_turns"][0])
        self.assertEqual(self.events()[-1]["participant"], "Claude", "joining does not wake anyone early")
        self.answer("Claude", created["turn"]["id"], current_token, "invite-tail-Claude")
        for turn in room["queued_turns"]:
            event = self.events()[-1]
            self.assertEqual((event["participant"], event["role"]), (turn["expert"], "expert"))
            token = self.member_tokens["Qwen"] if turn["expert"] == "Qwen" else self.enter(event)
            self.answer(turn["expert"], turn["id"], token, f"invite-tail-{turn['expert']}")
        self.assertEqual((self.events()[-1]["participant"], self.events()[-1]["role"]), ("Codex", "host"))

    def test_host_plans_after_an_answer_are_listed_for_the_transcript(self):
        """A plan made after answers follows the latest answer; the opening plan has nothing to follow."""
        created, _ = self.plan_round("arrangement-plan")
        token = self.enter(self.events()[-1])
        self.answer("Claude", created["turn"]["id"], token, "arrangement-Claude")
        room = self.request(self.path)[1]
        self.assertEqual(room["host_arrangements"], [])
        token = self.enter(self.events()[-1])
        self.answer("Gemini", room["current_turn"]["id"], token, "arrangement-Gemini")
        host_token = self.enter(self.events()[-1])
        self.take_floor("Codex", host_token)
        time.sleep(1.1)  # plans are grouped by creation second, as real experts always take longer than this
        status, plan = self.request(self.path + "/turns", {"actor": "Codex", "submission_id": "arrangement-next",
            "turns": [{"expert": "Gemini", "question": "补充"}, {"expert": "Claude", "question": "回应"}]}, host_token)
        self.assertEqual(status, 201, plan)
        arrangements = self.request(self.path)[1]["host_arrangements"]
        self.assertEqual([[(turn["expert"], turn["question"]) for turn in item["turns"]] for item in arrangements], [[("Gemini", "补充"), ("Claude", "回应")]])
        self.assertGreater(arrangements[0]["after_message_id"], 0)

    def test_invited_expert_completes_the_current_round_before_a_repeat_pass(self):
        """A plan that loops through the experts twice places the newcomer where this round completes."""
        self.start()
        host_token = self.enter(self.events()[0])
        names = ["Claude", "Gemini", "Claude", "Gemini"]
        status, created = self.request(self.path + "/turns", {"actor": "Codex", "submission_id": "invite-slot-plan",
            "turns": [{"expert": name, "question": f"第 {index} 句"} for index, name in enumerate(names)]}, host_token)
        self.assertEqual(status, 201, created)
        payload = {"name": "DeepSeek", "token": self.member_tokens["DeepSeek"], "access": "runner", "adapter": "api"}
        status, room = self.request(self.path + "/members", payload, self.owner)
        self.assertEqual(status, 200, room)
        self.assertEqual([(turn["expert"], turn["question"]) for turn in room["queued_turns"]],
                         [("Gemini", "第 1 句"), ("DeepSeek", "欢迎加入：请先读取议题，独立给出你的开场观点。"), ("Claude", "第 2 句"), ("Gemini", "第 3 句")])
        # The invitation is not a plan, and a plan with nothing answered before it has no message to follow.
        self.assertEqual(room["host_arrangements"], [])

    def test_invitation_preserves_user_hold_and_does_not_schedule_while_paused(self):
        """An invitation cannot clear pending user input or resume a paused discussion."""
        created, _ = self.plan_round("invite-held-plan")
        current_token = self.enter(self.events()[-1])
        self.request(self.path + "/messages", {"author": "用户", "text": "先处理这条补充", "submission_id": "invite-held-note"})
        held = self.request(self.path)[1]["held_since"]
        status, joined = self.request(self.path + "/members", {"name": "DeepSeek", "access": "runner",
            "adapter": "api", "token": self.member_tokens["DeepSeek"]}, self.owner)
        self.assertEqual((status, joined["held_since"]), (200, held))
        self.answer("Claude", created["turn"]["id"], current_token, "invite-held-answer")
        room = self.request(self.path)[1]
        self.assertEqual([turn["expert"] for turn in room["queued_turns"]], ["Gemini", "DeepSeek"])
        self.assertEqual((room["current_turn"]["status"], self.events()[-1]["role"]), ("answered", "host"))
        self.set_phase("paused")
        status, joined = self.request(self.path + "/members", {"name": "Qwen", "access": "manual",
            "token": self.member_tokens["Qwen"]}, self.owner)
        self.assertEqual((status, joined["phase"], joined["runtime"]["status"]), (200, "paused", "paused"))
        self.assertEqual(joined["queued_turns"], room["queued_turns"])

    def test_running_discussion_admits_and_releases_experts_without_pausing(self):
        """Leaving cancels only that expert's work and wakes the host; inviting and rejoining keep the run going."""
        created, _ = self.plan_round("members-plan")
        members = {member["name"]: member for member in self.request(self.path)[1]["members"]}
        host = self.request(self.path + f"/members/{members['Codex']['id']}", {"action": "away"}, self.owner)
        self.assertEqual(host[0], 400, host[1])
        speaker = self.path + f"/members/{members['Claude']['id']}"
        status, refused = self.request(speaker, {"action": "away"}, self.owner)
        self.assertEqual((status, "正在发言" in refused["error"]), (400, True), refused)
        self.cancel_turn(created["turn"]["id"])
        status, room = self.request(speaker, {"action": "away"}, self.owner)
        self.assertEqual(status, 200, room)
        self.assertEqual((room["runtime"]["status"], sorted(room["experts"]), room["queued_turns"]), ("running", ["Codex", "Gemini"], []))
        self.assertEqual(room["current_turn"]["status"], "cancelled")
        self.assertEqual(next(member for member in room["members"] if member["name"] == "Claude")["status"], "away")
        events = self.events()
        self.assertEqual(next(event for event in events if event["participant"] == "Claude")["status"], "cancelled")
        self.assertEqual((events[-1]["participant"], events[-1]["role"], events[-1]["status"]), ("Codex", "host", "pending"))
        self.assertEqual(self.request(self.path + "/topic", {"actor": "用户", "experts": {"Codex": "cli"}}, self.owner)[0], 400)
        invited = {"name": "DeepSeek", "token": uuid.uuid4().hex, "access": "runner", "adapter": "api"}
        status, room = self.request(self.path + "/members", invited, self.owner)
        self.assertEqual((status, room["runtime"]["status"], "DeepSeek" in room["experts"]), (200, "running", True), room)
        self.assertEqual(self.request(self.path + "/members", invited, self.owner)[0], 200, "an identical retry returns the same member")
        rejoin = self.path + f"/members/{members['Claude']['id']}"
        self.assertEqual(self.request(rejoin, {"action": "active", "token": self.member_tokens["Claude"]}, self.owner)[0], 400)
        status, room = self.request(rejoin, {"action": "active", "token": uuid.uuid4().hex}, self.owner)
        self.assertEqual((status, room["experts"].get("Claude"), room["runtime"]["status"]), (200, "cli", "running"), room)

    def test_manual_expert_answers_a_woken_discussion_with_its_own_credential(self):
        """A manual expert joins a running automatic discussion; its answer drives the host and mode switches keep it manual."""
        run = self.start()
        manual = {"name": "Qwen", "token": self.member_tokens["Qwen"], "access": "manual", "adapter": ""}
        status, room = self.request(self.path + "/members", manual, self.owner)
        self.assertEqual(status, 200, room)
        self.assertEqual(next(m for m in room["members"] if m["name"] == "Qwen")["access"], "manual")
        host_token = self.enter(self.events()[0])
        status, created = self.request(self.path + "/turns", {"actor": "Codex", "expert": "Qwen", "question": "给出判断",
                                                              "submission_id": "manual-expert-turn"}, host_token)
        self.assertEqual(status, 201, created)
        turn = created["turn"]
        self.assertEqual(self.request(self.path + "/state", {"actor": "Codex", "text": "x"}, self.member_tokens["Codex"])[0], 403)
        self.answer("Qwen", turn["id"], self.member_tokens["Qwen"], "manual-expert-answer")
        events = self.events()
        self.assertEqual((events[1]["participant"], events[1]["status"]), ("Qwen", "completed"))
        self.assertEqual((events[2]["participant"], events[2]["role"], events[2]["status"]), ("Codex", "host", "pending"))
        paused = self.request(self.path + "/runtime", {"action": "pause", "revision": self.request(self.path)[1]["runtime"]["revision"]}, self.owner)[1]
        manual_mode = self.request(self.path + "/runtime", {"mode": "manual", "revision": paused["revision"]}, self.owner)[1]
        self.assertEqual(self.request(self.path + "/runtime", {"mode": "automatic", "revision": manual_mode["revision"]}, self.owner)[0], 200)
        access = {m["name"]: m["access"] for m in self.request(self.path)[1]["members"]}
        self.assertEqual((access["Qwen"], access["Claude"]), ("manual", "runner"))

    def test_skip_failed_expert_resumes_with_host_instead_of_retrying_failed_turn(self):
        """A paused failed assignment can be cancelled before restart, preserving queued speakers."""
        created, _ = self.plan_round()
        event = self.events()[-1]
        old_token = self.enter(event)
        self.assertEqual(self.request(self.path + f"/events/{event['id']}",
            {"action": "fail", "reason": "模型未保存结果"}, old_token)[0], 200)
        paused = self.request(self.path)[1]
        self.assertEqual((paused["phase"], paused["runtime"]["status"]), ("paused", "paused"))
        self.assertEqual(self.request(self.path + f"/turns/{created['turn']['id']}",
            {"actor": "用户", "status": "cancelled"})[0], 200)
        self.assertEqual(self.request(self.path + "/runtime", {"action": "start", "mode": "automatic",
            "revision": paused["runtime"]["revision"], "deadline": 0})[0], 200)
        room = self.request(self.path)[1]
        self.assertEqual((room["current_turn"]["status"], room["runtime"]["status"]), ("cancelled", "running"))
        self.assertEqual([turn["expert"] for turn in room["queued_turns"]], ["Gemini"])
        self.assertEqual((self.events()[-1]["participant"], self.events()[-1]["role"]), ("Codex", "host"))
        self.assertEqual(self.request(self.path + "/state", {"actor": "Claude", "text": "迟到"}, old_token)[0], 403)
        host = self.enter(self.events()[-1])
        self.take_floor("Codex", host)
        self.assertEqual(self.request(self.path + "/turns/continue", {"actor": "Codex"}, host)[0], 200)
        self.assertEqual(self.request(self.path)[1]["current_turn"]["expert"], "Gemini")

    def test_skip_manual_expert_returns_to_host_and_continues_the_queue(self):
        """Skipping revokes the current manual answer without pausing or discarding the remaining plan."""
        self.start()
        self.assertEqual(self.request(self.path + "/members", {"name": "Qwen", "token": self.member_tokens["Qwen"],
            "access": "manual", "adapter": ""}, self.owner)[0], 200)
        host = self.enter(self.events()[0])
        status, created = self.request(self.path + "/turns", {"actor": "Codex", "submission_id": "skip-manual-plan",
            "turns": [{"expert": "Qwen", "question": "手动发言"}, {"expert": "Gemini", "question": "下一位"}]}, host)
        self.assertEqual(status, 201, created)
        turn_id = created["turn"]["id"]
        self.take_floor("Qwen", self.member_tokens["Qwen"])
        self.assertEqual(self.request(self.path + f"/turns/{turn_id}", {"actor": "用户", "status": "cancelled"})[0], 200)
        room = self.request(self.path)[1]
        self.assertEqual((room["current_turn"]["status"], room["runtime"]["status"]), ("cancelled", "running"))
        self.assertEqual([item["expert"] for item in room["queued_turns"]], ["Gemini"])
        self.assertEqual(self.events()[-2]["status"], "cancelled")
        self.assertEqual((self.events()[-1]["role"], self.events()[-1]["status"]), ("host", "pending"))
        late = self.request(self.path + "/messages", {"author": "Qwen", "source": "cli", "kind": "opinion",
            "turn_id": turn_id, "text": "迟到回答", "summary": "迟到", "submission_id": "skipped-late-answer"}, self.member_tokens["Qwen"])
        self.assertIn(late[0], (400, 403, 409))
        host = self.enter(self.events()[-1])
        self.take_floor("Codex", host)
        self.assertEqual(self.request(self.path + "/turns/continue", {"actor": "Codex"}, host)[0], 200)
        room = self.request(self.path)[1]
        self.assertEqual((room["current_turn"]["expert"], room["current_turn"]["status"]), ("Gemini", "pending"))
        self.answer("Gemini", room["current_turn"]["id"], self.enter(self.events()[-1]), "after-manual-skip")

    def test_manual_expert_reports_its_session_and_the_owner_adopts_it_once(self):
        """The session a manual expert posts from is kept for the local service; only a matching report allows hosting it."""
        self.start()
        manual = {"name": "Qwen", "token": self.member_tokens["Qwen"], "access": "manual", "adapter": ""}
        room = self.request(self.path + "/members", manual, self.owner)[1]
        member_id = next(m for m in room["members"] if m["name"] == "Qwen")["id"]
        member_path = f"{self.path}/members/{member_id}"
        adopt = {"action": "adopt", "adapter": "codex", "session_id": "5f0d2c1e-1111-2222-3333-444455556666"}
        self.assertEqual(self.request(member_path, adopt, self.owner)[0], 400)
        host_token = self.enter(self.events()[0])
        turn = self.request(self.path + "/turns", {"actor": "Codex", "expert": "Qwen", "question": "给出判断",
                                                   "submission_id": "adopt-turn"}, host_token)[1]["turn"]
        self.take_floor("Qwen", self.member_tokens["Qwen"])
        status, saved = self.request(self.path + "/messages", {"author": "Qwen", "source": "cli", "kind": "opinion", "turn_id": turn["id"],
            "text": "实际回答", "summary": "摘要", "submission_id": "adopt-answer", "session_id": adopt["session_id"], "session_client": "codex"},
            self.member_tokens["Qwen"])
        self.assertEqual(status, 201, saved)
        reported = next(m for m in self.request(self.path)[1]["members"] if m["name"] == "Qwen")
        self.assertEqual((reported["reported_session"], reported["reported_client"]), (adopt["session_id"], "codex"))
        self.assertEqual(self.request(member_path, {**adopt, "adapter": "antigravity_cli"}, self.owner)[0], 400)
        self.assertEqual(self.request(member_path, {**adopt, "session_id": "other-session-0000"}, self.owner)[0], 400)
        self.assertNotEqual(self.request(member_path, adopt, self.member_tokens["Qwen"])[0], 200)
        self.assertEqual(self.request(member_path, adopt, self.owner)[0], 400, "未注册的成员不能转为托管")
        self.assertEqual(self.request(self.path + "/register", {}, self.member_tokens["Qwen"])[0], 200)
        status, adopted = self.request(member_path, adopt, self.owner)
        self.assertEqual(status, 200, adopted)
        member = next(m for m in adopted["members"] if m["name"] == "Qwen")
        self.assertEqual((member["access"], member["adapter"], member["session_mode"], member["reported_session"]), ("runner", "codex", "borrowed", ""))
        self.assertEqual(self.request(member_path, adopt, self.owner)[0], 400)

    def test_manual_expert_reports_its_session_on_a_read_before_it_ever_speaks(self):
        """Reading the room with the member credential is enough to be taken over; only that member's own credential counts."""
        self.start()
        manual = {"name": "Qwen", "token": self.member_tokens["Qwen"], "access": "manual", "adapter": ""}
        self.request(self.path + "/members", manual, self.owner)
        session = {"X-Discussion-Session": "01a1694f-764d-7141-b2b8-47c433be027c", "X-Discussion-Session-Client": "codex"}
        self.request(self.path, token=self.owner, extra_headers=session)
        self.assertEqual(next(m for m in self.request(self.path)[1]["members"] if m["name"] == "Qwen")["reported_session"], "")
        self.request(self.path, token=self.member_tokens["Qwen"], extra_headers=session)
        member = next(m for m in self.request(self.path)[1]["members"] if m["name"] == "Qwen")
        self.assertEqual((member["reported_session"], member["reported_client"]), (session["X-Discussion-Session"], "codex"))

    def test_manual_expert_registers_with_its_own_credential_and_must_register_again_after_rejoining(self):
        """Registration is the expert's own call, keeps its first time, and belongs to the credential it used."""
        self.start()
        manual = {"name": "Qwen", "token": self.member_tokens["Qwen"], "access": "manual", "adapter": ""}
        room = self.request(self.path + "/members", manual, self.owner)[1]
        qwen = next(m for m in room["members"] if m["name"] == "Qwen")
        self.assertEqual(qwen["registered_at"], "")
        self.assertEqual(self.request(self.path + "/register", {}, self.owner)[0], 403)
        session = {"X-Discussion-Session": "01a1694f-764d-7141-b2b8-47c433be027c", "X-Discussion-Session-Client": "codex"}
        status, first = self.request(self.path + "/register", {}, self.member_tokens["Qwen"], extra_headers=session)
        self.assertEqual((status, first["member"], first["session_client"]), (200, "Qwen", "codex"), first)
        self.assertEqual(self.request(self.path + "/register", {}, self.member_tokens["Qwen"])[1]["registered_at"], first["registered_at"])
        qwen = next(m for m in self.request(self.path)[1]["members"] if m["name"] == "Qwen")
        self.assertEqual(qwen["registered_at"], first["registered_at"])
        member_path = f"{self.path}/members/{qwen['id']}"
        self.assertEqual(self.request(member_path, {"action": "away"}, self.owner)[0], 200)
        new_token = uuid.uuid4().hex
        self.assertEqual(self.request(member_path, {"action": "active", "token": new_token}, self.owner)[0], 200)
        qwen = next(m for m in self.request(self.path)[1]["members"] if m["name"] == "Qwen")
        self.assertEqual(qwen["registered_at"], "", "换发新凭证后须重新注册")
        self.assertEqual(self.request(self.path + "/register", {}, new_token)[0], 200)

    def test_manual_host_is_rejected_in_a_woken_discussion(self):
        """The host is continued by the local service, so only experts may be manual."""
        members = [{"name": "Codex", "token": uuid.uuid4().hex, "access": "manual"},
                   {"name": "Claude", "token": uuid.uuid4().hex, "access": "runner"}]
        status, refused = self.request("/api/rooms", {"title": "手动主持", "host": "Codex", "phase": "initial", "runtime_mode": "automatic",
                                                       "experts": {"Codex": "cli", "Claude": "cli"}, "members": members})
        self.assertEqual(status, 400, refused)

    def test_message_during_host_execution_survives_plan_creation(self):
        """A user message that arrives after the host began is not cleared by the plan the host then creates."""
        self.start()
        host_token = self.enter(self.events()[0])
        time.sleep(1.1)
        self.assertEqual(self.request(self.path + "/messages", {"author": "用户", "text": "主持执行中的留言",
            "submission_id": "late-user-note"})[0], 201)
        status, created = self.request(self.path + "/turns", {"actor": "Codex", "submission_id": "late-plan",
            "turns": [{"expert": "Claude", "question": "先答"}, {"expert": "Gemini", "question": "再答"}]}, host_token)
        self.assertEqual(status, 201, created)
        self.assertGreater(self.request(self.path)[1]["held_since"], 0)
        self.answer("Claude", created["turn"]["id"], self.enter(self.events()[-1]), "late-answer")
        room = self.request(self.path)[1]
        self.assertEqual(([item["expert"] for item in room["queued_turns"]], self.events()[-1]["role"]), (["Gemini"], "host"))

    def test_user_action_returns_round_to_host_who_may_continue(self):
        """A user message waits for the speaking expert, then the host resumes or replaces the plan."""
        created, _ = self.plan_round()
        claude = self.enter(self.events()[-1])
        self.assertEqual(self.request(self.path + "/messages", {"author": "用户", "text": "补充材料",
            "submission_id": "plan-user-note"})[0], 201)
        held = self.request(self.path)[1]["held_since"]
        self.assertGreater(held, 0)
        self.assertEqual(self.events()[-1]["participant"], "Codex")
        self.answer("Claude", created["turn"]["id"], claude, "plan-answer-held")
        room = self.request(self.path)[1]
        self.assertEqual((room["current_turn"]["status"], [item["expert"] for item in room["queued_turns"]]), ("answered", ["Gemini"]))
        host = self.enter(self.events()[-1])
        self.take_floor("Codex", host)
        status, resumed = self.request(self.path + "/turns/continue", {"actor": "Codex"}, host)
        self.assertEqual(status, 200, resumed)
        room = self.request(self.path)[1]
        self.assertEqual((room["current_turn"]["expert"], room["queued_turns"], room["held_since"]), ("Gemini", [], 0))
        self.assertEqual(self.events()[-1]["participant"], "Gemini")

    def test_new_arrangement_replaces_remaining_plan_and_stop_keeps_it(self):
        """Stopping returns to the host with the plan intact; a new arrangement skips it."""
        created, _ = self.plan_round()
        self.assertEqual(self.request(self.path + f"/turns/{created['turn']['id']}", {"actor": "用户", "status": "cancelled"})[0], 200)
        room = self.request(self.path)[1]
        self.assertEqual(([item["expert"] for item in room["queued_turns"]], self.events()[-1]["role"]), (["Gemini"], "host"))
        host = self.enter(self.events()[-1])
        self.take_floor("Codex", host)
        status, _ = self.request(self.path + "/turns", {"actor": "Codex", "expert": "Codex", "question": "重排",
            "submission_id": "plan-replaced"}, host)
        self.assertEqual(status, 201)
        turns = self.request(self.path + "/turns")[1]["turns"]
        self.assertEqual([turn["status"] for turn in turns], ["cancelled", "skipped", "pending"])

    def test_user_writes_need_owner_credential_and_ai_identities_need_execution(self):
        """Declared names alone never authorize a user or AI write."""
        self.start()
        self.assertEqual(self.request(self.path + "/events", token="")[0], 403)
        self.assertEqual(self.request(self.path + "/state", {"actor": "Codex", "text": "无执行"})[0], 403)
        token = self.enter(self.events()[0])
        self.assertEqual(self.request(self.path + "/state", {"actor": "Claude", "text": "冒充"}, token)[0], 403)
        payload = {"author": "用户", "text": "用户补充", "submission_id": "user-note"}
        self.assertEqual(self.request(self.path + "/messages", payload, "")[0], 403)
        self.assertEqual(self.request(self.path + "/messages", payload)[0], 201)

    def test_pause_revokes_late_writes_and_requires_explicit_resume(self):
        """A delayed queued message cannot write after pause or mode change."""
        run = self.start()
        token = self.enter(self.events()[0])
        status, paused = self.request(self.path + "/runtime", {"action": "pause", "revision": run["revision"]}, self.owner)
        self.assertEqual(status, 200)
        self.assertEqual(paused["status"], "paused")
        self.assertEqual(self.request(self.path + "/state", {"actor": "Codex", "text": "迟到"}, token)[0], 403)
        self.assertEqual(self.events()[0]["status"], "cancelled")
        status, mode = self.request(self.path + "/runtime", {"action": "configure", "mode": "manual", "revision": paused["revision"]}, self.owner)
        self.assertEqual(status, 200, mode)
        self.assertEqual(mode["mode"], "manual")

    def test_concurrent_enter_only_accepts_one_execution(self):
        """Repeated delivery cannot create two active consumers for one event."""
        self.start()
        event = self.events()[0]
        token = uuid.uuid4().hex
        path = self.path + f"/events/{event['id']}"
        self.assertEqual(self.request(path, {"action": "reserve", "execution_token": token}, self.owner)[0], 200)
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: self.request(path, {"action": "enter", "session_id": "test-session"}, token)[0], range(2)))
        self.assertEqual(results.count(200), 1)
        self.assertTrue(any(code in (403, 409) for code in results))

    def test_schema_reinitialization_preserves_runtime_and_floor(self):
        """Repeated startup never resets active work or creates new wakeups."""
        if not hasattr(self, "database"):
            self.skipTest("SQLite initialization is covered locally; Worker migration uses separate smoke checks")
        self.start()
        before = self.request(self.path)[1]
        events = self.events()
        init_database(self.database, seed=False)
        self.assertEqual(self.request(self.path)[1], before)
        self.assertEqual(self.events(), events)

    def test_stop_and_resume_reject_old_generation(self):
        """Explicit stop remains stopped; resumed work has a new one-use capability."""
        run = self.start()
        old_token = self.enter(self.events()[0])
        status, stopped = self.request(self.path + "/runtime", {"action": "stop", "revision": run["revision"]}, self.owner)
        self.assertEqual(status, 200)
        self.assertEqual(stopped["status"], "stopped")
        status, resumed = self.request(self.path + "/runtime", {"action": "start", "revision": stopped["revision"], "deadline": int(time.time()) + 600}, self.owner)
        self.assertEqual(status, 200, resumed)
        self.assertGreater(resumed["generation"], run["generation"])
        self.assertEqual(self.request(self.path + "/state", {"actor": "Codex", "text": "迟到"}, old_token)[0], 403)
        self.assertEqual(len(self.events()), 2)

    def test_user_changes_wake_host_but_state_does_not(self):
        """Only discussion causes enqueue work; technical state updates stay quiet."""
        self.start()
        count = len(self.events())
        self.assertEqual(self.request(self.path + "/state", {"actor": "用户", "text": "状态"}, self.owner)[0], 200)
        self.assertEqual(len(self.events()), count)
        self.assertEqual(self.request(self.path + "/topic", {"actor": "用户", "goal": "新目标"}, self.owner)[0], 200)
        self.assertEqual(len(self.events()), count + 1)
        self.assertEqual(self.request(self.path + "/topic", {"actor": "用户", "boundaries": "新约束"}, self.owner)[0], 200)
        self.assertEqual(len(self.events()), count + 2)

    def test_automatic_creation_is_protected_atomically_and_idempotent(self):
        """Creating an automatic room never exposes an unprotected write window."""
        payload = {"title": "自动创建验证", "runtime_mode": "automatic", "submission_id": uuid.uuid4().hex}
        self.assertEqual(self.request("/api/rooms", payload, "")[0], 400)
        status, room = self.request("/api/rooms", payload, self.owner)
        self.assertEqual(status, 201, room)
        self.assertEqual(room["runtime"]["mode"], "automatic")
        self.assertEqual(room["runtime"]["status"], "ready")
        path = f"/api/rooms/{room['id']}"
        self.assertEqual(self.request(path + "/state", {"actor": "Codex", "text": "不能写"})[0], 403)
        retry = self.request("/api/rooms", payload, self.owner)
        self.assertEqual(retry[0], 200)
        self.assertEqual(retry[1]["id"], room["id"])
        self.assertEqual(self.request(path + "/events", token=self.owner)[1]["events"], [])

    def test_directory_arrangement_needs_no_room_credential(self):
        """Ordering and filing a protected room only rearrange the directory; archiving still needs control."""
        payload = {"title": "目录整理验证", "runtime_mode": "automatic", "submission_id": uuid.uuid4().hex}
        room = self.request("/api/rooms", payload, self.owner)[1]
        path = f"/api/rooms/{room['id']}"
        folder = self.request("/api/folders", {"name": "整理"}, "")[1]
        status, filed = self.request(path + "/folder", {"actor": "用户", "folder_id": folder["id"]}, "")
        self.assertEqual(status, 200, filed)
        self.assertEqual(filed["folder_id"], folder["id"])
        self.assertEqual(self.request(path + "/move", {"actor": "用户", "before_id": self.room}, "")[0], 200)
        status, rejected = self.request(path + "/archive", {"actor": "用户"}, "")
        self.assertEqual(status, 403)
        self.assertIn("没有凭据只能阅读", rejected["error"])

    def test_failed_business_write_rolls_back_messages_and_events(self):
        """A rejected formal answer cannot leave a partial message or wakeup."""
        self.start()
        token = self.enter(self.events()[0])
        before = self.request(self.path)[1]
        events = self.events()
        status, _ = self.request(self.path + "/messages", {"author": "Codex", "source": "cli",
            "kind": "opinion", "turn_id": 2147483647, "text": "无效安排", "submission_id": "invalid-answer"}, token)
        self.assertIn(status, (400, 404, 409))
        self.assertEqual(self.request(self.path)[1]["message_count"], before["message_count"])
        self.assertEqual(self.events(), events)

    def test_mode_change_cannot_replace_in_flight_work(self):
        """Switching modes requires first revoking the active execution."""
        run = self.start()
        self.enter(self.events()[0])
        status, _ = self.request(self.path + "/runtime", {"action": "configure", "mode": "manual",
            "revision": run["revision"]}, self.owner)
        self.assertIn(status, (403, 409))
        self.assertEqual(self.request(self.path)[1]["runtime"]["mode"], "automatic")

    def test_conclusion_completes_host_and_rejects_old_capability(self):
        """A host's final action completes its execution instead of cancelling it."""
        self.start()
        token = self.enter(self.events()[0])
        self.assertEqual(self.request(self.path + "/topic", {"actor": "Codex", "phase": "concluded"}, token)[0], 200)
        self.assertEqual(self.events()[0]["status"], "completed")
        self.assertEqual(self.events()[0]["result"], "concluded")
        self.assertEqual(self.request(self.path + "/state", {"actor": "Codex", "text": "迟到"}, token)[0], 403)

    def test_resume_preserves_phase_and_archive_revokes_execution(self):
        """Reviewing is not reset to initial when resuming; archive stops the run."""
        run = self.start()
        self.request(self.path + "/topic", {"actor": "用户", "phase": "reviewing"}, self.owner)
        _, paused = self.request(self.path + "/runtime", {"action": "pause", "revision": run["revision"]}, self.owner)
        status, _ = self.request(self.path + "/runtime", {"action": "start", "revision": paused["revision"],
            "deadline": int(time.time()) + 600}, self.owner)
        self.assertEqual(status, 200)
        self.assertEqual(self.request(self.path)[1]["phase"], "reviewing")
        token = self.enter(self.events()[-1])
        self.assertEqual(self.request(self.path + "/archive", {"actor": "用户"}, self.owner)[0], 200)
        self.assertEqual(self.request(self.path)[1]["runtime"]["status"], "stopped")
        self.assertEqual(self.request(self.path + "/state", {"actor": "Codex", "text": "迟到"}, token)[0], 403)

    def test_web_user_controls_require_owner_key(self):
        """Only the owner can control a room; stale AI tokens stay rejected."""
        run = self.start()
        token = self.enter(self.events()[-1])
        for key in ("", uuid.uuid4().hex, self.member_tokens["Codex"]):
            self.assertEqual(self.request(self.path + "/archive", {"actor": "用户"}, key)[0], 403)
            self.assertEqual(self.request(self.path + "/runtime", {"action": "pause", "revision": run["revision"]}, key)[0], 403)
        status, paused = self.request(self.path + "/runtime", {"action": "pause", "revision": run["revision"]})
        self.assertEqual(status, 200, paused)
        self.assertEqual(paused["status"], "paused")
        before = self.request(self.path)[1]
        status, archived = self.request(self.path + "/archive", {"actor": "用户"})
        self.assertEqual(status, 200, archived)
        self.assertTrue(archived["archived"])
        self.assertEqual(archived["message_count"], before["message_count"])
        self.assertEqual(archived["runtime"]["status"], "stopped")
        self.assertEqual(self.request(self.path + "/state", {"actor": "Codex", "text": "迟到"}, token)[0], 403)
        status, restored = self.request(self.path + "/restore", {"actor": "用户"})
        self.assertEqual(status, 200, restored)
        self.assertFalse(restored["archived"])
        status, deleted = self.request(self.path + "/delete", {"actor": "用户", "confirm_title": before["title"]})
        self.assertEqual(status, 200, deleted)
        self.assertEqual(self.request(self.path)[0], 404)

    def test_unlimited_run_keeps_leases_and_resumes_without_a_deadline(self):
        """No total duration still requires a valid execution and explicit resume."""
        self.limited_room(execution_minutes=1)
        status, run = self.request(self.path + "/runtime", {"action": "start", "revision": 0}, self.owner)
        self.assertEqual(status, 200, run)
        self.assertEqual((run["deadline"], run["expired"]), (0, False))
        self.assertIsNone(self.request(self.path)[1]["limits"]["remaining_seconds"])
        event = self.events()[-1]
        token = self.enter(event)
        renewed = self.request(self.path + f"/events/{event['id']}", {"action": "renew"}, self.owner)
        self.assertEqual(renewed[0], 200, renewed)
        self.assertTrue(int(time.time()) < renewed[1]["lease_until"] <= int(time.time()) + 60)
        self.assertEqual(self.request(self.path + "/state", {"actor": "Codex", "text": "有效执行"}, token)[0], 200)
        paused = self.request(self.path + "/runtime", {"action": "pause", "revision": run["revision"]}, self.owner)[1]
        self.assertEqual(self.request(self.path + "/state", {"actor": "Codex", "text": "已撤销"}, token)[0], 403)
        status, resumed = self.request(self.path + "/runtime", {"action": "start", "revision": paused["revision"]}, self.owner)
        self.assertEqual(status, 200, resumed)
        self.assertEqual((resumed["deadline"], resumed["expired"]), (0, False))
        self.assertEqual(self.request(self.path + "/runtime", {"action": "stop", "revision": resumed["revision"]}, self.owner)[1]["status"], "stopped")

    def test_unlimited_run_still_stops_or_summarizes_at_round_limit(self):
        """Round limits stop unlimited runs and summaries get a finite reserve."""
        for action in ("pause", "summarize"):
            with self.subTest(action=action):
                self.limited_room(max_rounds=1, on_limit=action, summary_minutes=1)
                self.start(0)
                self.complete_round()
                old_token = self.enter(self.events()[-1])
                status, room = self.request(self.path + "/limits", {"actor": "用户"}, self.owner)
                self.assertEqual(status, 200, room)
                self.assertEqual(room["limits"]["reason"], "round_limit")
                self.assertEqual(self.request(self.path + "/state", {"actor": "Codex", "text": "旧执行"}, old_token)[0], 403)
                if action == "pause":
                    self.assertEqual(room["runtime"]["status"], "paused")
                else:
                    deadline = room["runtime"]["deadline"]
                    self.assertTrue(int(time.time()) < deadline <= int(time.time()) + 60)
                    paused = self.request(self.path + "/runtime", {"action": "pause", "revision": room["runtime"]["revision"]}, self.owner)[1]
                    resumed = self.request(self.path + "/runtime", {"action": "start", "revision": paused["revision"], "deadline": 0}, self.owner)[1]
                    self.assertEqual(resumed["deadline"], deadline)
                    token = self.enter(self.events()[-1])
                    self.assertEqual(self.request(self.path + "/topic", {"actor": "Codex", "phase": "concluded"}, token)[0], 200)

    def test_zero_deadline_cannot_bypass_configured_duration(self):
        """Zero inherits a configured topic cutoff; invalid deadlines still fail."""
        for deadline in (-1, True, "0", int(time.time()) - 1, int(time.time()) + 90000):
            status, result = self.request(self.path + "/runtime", {"action": "start", "revision": 0, "deadline": deadline}, self.owner)
            self.assertEqual(status, 400, result)
        self.limited_room(max_minutes=1)
        run = self.start(0)
        self.assertTrue(int(time.time()) < run["deadline"] <= int(time.time()) + 60)

    def test_unlimited_run_still_rejects_execution_timeout(self):
        """Unlimited total duration never disables the per-execution timeout."""
        if not hasattr(self, "database"):
            self.skipTest("需要隔离 SQLite 时钟")
        self.limited_room(execution_minutes=1)
        self.start(0)
        event = self.events()[-1]
        token = self.enter(event)
        with sqlite3.connect(self.database) as connection:
            connection.execute("UPDATE discussion_events SET started_at=started_at-61 WHERE id=?", (event["id"],))
        connection.close()
        self.assertFalse(self.request(self.path)[1]["runtime"]["expired"])
        self.assertEqual(self.request(self.path + "/state", {"actor": "Codex", "text": "超时"}, token)[0], 403)
        self.assertIn(self.request(self.path + f"/events/{event['id']}", {"action": "renew"}, self.owner)[0], (403, 409))

    def test_default_execution_has_no_time_limit_but_requires_a_live_lease(self):
        """Long executions can renew and write until their lease or run is revoked."""
        if not hasattr(self, "database"):
            self.skipTest("需要隔离 SQLite 时钟")
        self.assertEqual(self.request(self.path)[1]["limits"]["execution_minutes"], 0)
        self.start(0)
        event = self.events()[-1]
        token = self.enter(event)
        with sqlite3.connect(self.database) as connection:
            connection.execute("UPDATE discussion_events SET started_at=started_at-7200 WHERE id=?", (event["id"],))
        connection.close()
        renewed = self.request(self.path + f"/events/{event['id']}", {"action": "renew"}, self.owner)
        self.assertEqual(renewed[0], 200, renewed)
        self.assertTrue(int(time.time()) < renewed[1]["lease_until"] <= int(time.time()) + 120)
        self.assertEqual(self.request(self.path + "/state", {"actor": "Codex", "text": "两小时后仍有效"}, token)[0], 200)
        with sqlite3.connect(self.database) as connection:
            connection.execute("UPDATE discussion_events SET lease_until=0 WHERE id=?", (event["id"],))
        connection.close()
        self.assertEqual(self.request(self.path + "/state", {"actor": "Codex", "text": "失去租约"}, token)[0], 403)
        self.assertIn(self.request(self.path + f"/events/{event['id']}", {"action": "renew"}, self.owner)[0], (403, 409))

    def test_old_schema_keeps_saved_execution_limits_and_defaults_new_rooms_to_unlimited(self):
        """Upgrading an old table's trigger changes only future room defaults."""
        schema = (Path(__file__).resolve().parents[1] / "backend" / "schema.sql").read_text(encoding="utf-8")
        legacy = schema.replace("execution_minutes INTEGER NOT NULL DEFAULT 0", "execution_minutes INTEGER NOT NULL DEFAULT 20")
        legacy = legacy.replace("INSERT INTO discussion_limits(room_id,execution_minutes) VALUES (NEW.id,0);",
                                "INSERT INTO discussion_limits(room_id) VALUES (NEW.id);")
        connection = sqlite3.connect(":memory:")
        try:
            connection.executescript(legacy)
            connection.execute("INSERT INTO rooms(id,title,goal,created_at) VALUES ('existing','旧房间','',datetime('now'))")
            connection.executescript(schema)
            connection.execute("INSERT INTO rooms(id,title,goal,created_at) VALUES ('new','新房间','',datetime('now'))")
            self.assertEqual(connection.execute("SELECT execution_minutes FROM discussion_limits WHERE room_id='existing'").fetchone()[0], 20)
            self.assertEqual(connection.execute("SELECT execution_minutes FROM discussion_limits WHERE room_id='new'").fetchone()[0], 0)
        finally:
            connection.close()

    def test_expired_run_cannot_enter_or_write(self):
        """The deadline is enforced by the website even with no runner alive."""
        status, _ = self.request(self.path + "/runtime", {"action": "start", "revision": 0,
            "deadline": int(time.time()) + 2}, self.owner)
        self.assertEqual(status, 200)
        token = self.enter(self.events()[0])
        time.sleep(2)
        self.assertEqual(self.request(self.path + "/state", {"actor": "Codex", "text": "迟到"}, token)[0], 403)
        event = self.events()[0]
        status, _ = self.request(self.path + f"/events/{event['id']}", {"action": "renew"}, self.owner)
        self.assertIn(status, (403, 409))


if __name__ == "__main__":
    unittest.main()

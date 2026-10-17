"""Exercise durable execution through both HTTP backends, never real AI apps."""

import json
import os
import tempfile
import threading
import time
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from server import DiscussionServer, init_database


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
            self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
            self.thread.start()
            self.base = f"http://127.0.0.1:{self.server.server_port}"
        self.owner = uuid.uuid4().hex
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

    def request(self, path, payload=None, token=None):
        """Return JSON and status for successes and rejected writes alike."""
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
            return response.status, json.load(response)

    def start(self):
        """Opt into one finite run with an owner capability."""
        status, value = self.request(self.path + "/runtime", {"action": "start", "mode": "automatic",
            "revision": 0, "deadline": int(time.time()) + 600}, self.owner)
        self.assertEqual(status, 200, value)
        return value

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
        floor = self.request(self.path + "/floor")[1]
        self.assertEqual(self.request(self.path + "/floor", {"actor": "Codex", "action": "take",
            "revision": floor["revision"]}, self.owner)[0], 200)
        answer = {"author": "Codex", "kind": "opinion", "source": "cli", "text": "测试原文",
                  "submission_id": "limited-answer", "turn_id": result["turn"]["id"]}
        self.assertEqual(self.request(self.path + "/messages", answer, self.owner)[0], 201)
        return answer

    def test_round_limit_blocks_new_work_but_preserves_exact_retry(self):
        """A completed round prevents further work while retries stay idempotent."""
        self.limited_room(max_rounds=1)
        answer = self.complete_round()
        self.assertEqual(self.request(self.path + "/messages", answer, self.owner)[0], 200)
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

    def test_limits_validation_and_active_edit_protection(self):
        """Bad settings fail; limits are editable only before start or while paused."""
        for limits in ({"max_rounds": -1}, {"max_minutes": 1441}, {"max_rounds": True},
                       {"execution_minutes": 0}, {"on_limit": "ignore"},
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
            self.assertEqual(self.request(self.path)[1]["runtime"], run)

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
        # Exact replay with owner capability must not generate another event.
        self.assertEqual(self.request(self.path + "/turns", payload, self.owner)[0], 200)
        token = self.enter(self.events()[-1])
        floor = self.request(self.path + "/floor")[1]
        self.assertEqual(self.request(self.path + "/floor", {"actor": "Claude", "action": "take", "revision": floor["revision"]}, token)[0], 200)
        answer = {"author": "Claude", "submitted_by": "Claude", "source": "cli", "kind": "opinion",
            "turn_id": turn["id"], "text": "实际回答", "summary": "摘要", "submission_id": "runtime-answer"}
        status, saved = self.request(self.path + "/messages", answer, token)
        self.assertEqual(status, 201, saved)
        self.assertEqual(self.request(self.path + "/messages", answer, self.owner)[0], 200)
        events = self.events()
        self.assertEqual(len(events), 3)
        self.assertEqual(events[1]["status"], "completed")
        self.assertEqual(events[2]["participant"], "Codex")
        self.assertNotIn("token_hash", json.dumps(events))

    def test_unauthorized_and_wrong_identity_writes_are_rejected(self):
        """Anonymous writers and spoofed participant names cannot trigger work."""
        self.start()
        self.assertEqual(self.request(self.path + "/events")[0], 403)
        payload = {"author": "用户", "text": "不能触发", "submission_id": "unauthorized"}
        self.assertEqual(self.request(self.path + "/messages", payload)[0], 403)
        token = self.enter(self.events()[0])
        self.assertEqual(self.request(self.path + "/state", {"actor": "Claude", "text": "冒充"}, token)[0], 403)
        self.assertEqual(len(self.events()), 1)

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
        self.assertEqual(self.request("/api/rooms", payload)[0], 400)
        status, room = self.request("/api/rooms", payload, self.owner)
        self.assertEqual(status, 201, room)
        self.assertEqual(room["runtime"]["mode"], "automatic")
        self.assertEqual(room["runtime"]["status"], "ready")
        path = f"/api/rooms/{room['id']}"
        self.assertEqual(self.request(path + "/state", {"actor": "用户", "text": "不能写"})[0], 403)
        retry = self.request("/api/rooms", payload, self.owner)
        self.assertEqual(retry[0], 200)
        self.assertEqual(retry[1]["id"], room["id"])
        self.assertEqual(self.request(path + "/events", token=self.owner)[1]["events"], [])

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

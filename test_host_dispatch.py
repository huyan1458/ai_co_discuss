"""Verify queue dispatch without sending test prompts to a real Codex session."""

import copy
import json
import os
import subprocess
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path
from unittest.mock import patch
from urllib.error import URLError
from urllib.request import Request, urlopen

from host_dispatch import (
    DeliveryUncertain, binding_key, build_event, check_codex, deliver_event,
    dispatch_once, main, open_store, parse_options, queue_message, watch_room,
)
from server import DiscussionServer, init_database

THREAD_ID = "11111111-2222-4333-8444-555555555555"


class HostDispatchTests(unittest.TestCase):
    """Exercise persistent deduplication, real HTTP transitions and native arguments."""

    def setUp(self):
        """Use isolated dispatch records and a room with context that must stay out."""
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.options = parse_options([
            "--url", "https://example.test", "--room", "room123", "--thread", THREAD_ID,
            "--state", str(Path(self.directory.name) / "dispatch.sqlite3"), "--once", "--events", "all",
        ])
        self.options.codex = "native-codex.exe"
        self.room = {"id": "room123", "host": "Codex", "experts": {"Codex": "cli"},
                     "phase": "discussing", "current_turn": None, "background": "BG_SECRET",
                     "state": "STATE_SECRET", "messages": ["HISTORY_SECRET"], "latest_id": 7}
        self.connection = open_store(self.options.state)
        self.addCleanup(self.connection.close)

    def event(self, status, turn_id=1):
        """Build a turn event while retaining irrelevant context in the fixture."""
        self.room["current_turn"] = {"id": turn_id, "status": status, "expert": "Gemini",
                                     "question": '请评估 "中文" & $() `符号`\n第二行', "answer_id": 9}
        return build_event(self.room, self.options.url, self.options.events)

    def test_events_are_actionable_and_progressive(self):
        """Only actionable states emit notices and no context body is copied."""
        self.assertEqual(build_event(self.room, self.options.url, "all")[0], "start")
        for status in ("pending", "answered", "cancelled"):
            event_id, message = self.event(status)
            self.assertIn(status, event_id)
            self.assertIn("https://example.test/r/room123", message)
            for secret in ("BG_SECRET", "STATE_SECRET", "HISTORY_SECRET"):
                self.assertNotIn(secret, message)
        self.assertIsNone(self.event("notified"))
        self.room["phase"] = "concluded"
        self.assertIsNone(self.event("answered"))

    def test_success_is_deduplicated_after_restart(self):
        """Repeat polls and a new SQLite connection cannot resend a queued event."""
        event = self.event("answered")
        with patch("host_dispatch.queue_message") as queue:
            self.assertTrue(deliver_event(self.options, self.connection, event))
            self.assertFalse(deliver_event(self.options, self.connection, event))
            with closing(open_store(self.options.state)) as restarted:
                self.assertFalse(deliver_event(self.options, restarted, event))
            self.assertEqual(queue.call_count, 1)

    def test_default_policy_only_wakes_for_another_experts_answer(self):
        """Host actions and receipts do not wake the host that just produced them."""
        defaults = parse_options(["--url", self.options.url, "--room", "room123", "--thread", THREAD_ID])
        self.assertEqual(defaults.events, "answers")
        self.options.events = defaults.events
        with patch("host_dispatch.read_room", return_value=self.room), patch("host_dispatch.queue_message") as queue:
            self.assertEqual(dispatch_once(self.options, self.connection), "waiting")
            for status in ("pending", "notified", "cancelled"):
                self.event(status)
                self.assertEqual(dispatch_once(self.options, self.connection), "waiting")
            self.event("answered")
            self.room["current_turn"]["expert"] = "Codex"
            self.assertEqual(dispatch_once(self.options, self.connection), "waiting")
            self.room["current_turn"]["expert"] = "Gemini"
            self.assertEqual(dispatch_once(self.options, self.connection), "queued")
            self.room["latest_id"] += 1
            self.assertEqual(dispatch_once(self.options, self.connection), "unchanged")
            self.assertEqual(queue.call_count, 1)

    def test_pause_stops_without_consuming_answer_and_resume_delivers_it_once(self):
        """A paused room retains its pending result for an explicitly resumed monitor."""
        self.event("answered")
        self.options.once = False
        self.room["phase"] = "paused"
        with patch("host_dispatch.read_room", return_value=self.room), patch("host_dispatch.queue_message") as queue:
            with patch("host_dispatch.wait_for_poll") as wait:
                watch_room(self.options, self.connection)
            wait.assert_not_called()
            queue.assert_not_called()
            self.assertEqual(self.connection.execute("SELECT COUNT(*) FROM deliveries").fetchone()[0], 0)
            self.room["phase"] = "reviewing"
            self.assertEqual(dispatch_once(self.options, self.connection), "queued")
            self.assertEqual(dispatch_once(self.options, self.connection), "unchanged")

    def test_each_new_turn_transition_is_independent(self):
        """Pending and answered events deliver independently, as do later turns."""
        with patch("host_dispatch.queue_message") as queue:
            for status, turn_id in (("pending", 1), ("answered", 1), ("pending", 2), ("cancelled", 2)):
                self.assertTrue(deliver_event(self.options, self.connection, self.event(status, turn_id)))
            self.assertEqual(queue.call_count, 4)

    def concurrent_delivery(self, event):
        """Open the same persistent store from an independent poller."""
        with closing(open_store(self.options.state)) as connection:
            try:
                return deliver_event(self.options, connection, event)
            except DeliveryUncertain:
                return False

    def test_concurrent_pollers_send_only_once(self):
        """A committed unique claim prevents parallel processes from double sending."""
        event = self.event("pending")
        with patch("host_dispatch.queue_message") as queue, ThreadPoolExecutor(max_workers=4) as pool:
            outcomes = list(pool.map(self.concurrent_delivery, [event] * 4))
        self.assertEqual(outcomes.count(True), 1)
        self.assertEqual(queue.call_count, 1)

    def test_timeout_survives_restart_without_automatic_replay(self):
        """A lost queue receipt must remain uncertain even after a restart."""
        event = self.event("answered")
        with patch("host_dispatch.queue_message", side_effect=subprocess.TimeoutExpired("codex", 30)) as queue:
            with self.assertRaises(DeliveryUncertain):
                deliver_event(self.options, self.connection, event)
            with closing(open_store(self.options.state)) as restarted:
                with self.assertRaises(DeliveryUncertain):
                    deliver_event(self.options, restarted, event)
            self.assertEqual(queue.call_count, 1)
        row = self.connection.execute("SELECT status,error FROM deliveries").fetchone()
        self.assertEqual(row[0], "uncertain")
        self.assertIn("timed out", row[1])

    def test_operator_can_retry_current_uncertain_event(self):
        """A checked, explicit retry can resend just the current uncertain event."""
        event = self.event("pending")
        with patch("host_dispatch.queue_message", side_effect=DeliveryUncertain("receipt missing")):
            with self.assertRaises(DeliveryUncertain):
                deliver_event(self.options, self.connection, event)
        self.options.retry_event = event[0]
        with patch("host_dispatch.read_room", return_value=self.room), patch("host_dispatch.queue_message") as queue:
            self.assertEqual(dispatch_once(self.options, self.connection), "queued")
            self.assertEqual(queue.call_count, 1)
            with self.assertRaises(ValueError):
                dispatch_once(self.options, self.connection)
            self.options.retry_event = "turn-999-pending"
            with self.assertRaises(ValueError):
                dispatch_once(self.options, self.connection)
            self.assertEqual(queue.call_count, 1)

    def test_native_command_preserves_unicode_as_one_argument(self):
        """Shell metacharacters and line breaks stay inside the message argument."""
        message = self.event("pending")[1]
        self.options.remote = "ws://localhost:4567"
        with patch("host_dispatch.subprocess.run", return_value=subprocess.CompletedProcess([], 0)) as run:
            queue_message(self.options, message)
        self.assertEqual(run.call_args.args[0], ["native-codex.exe", "queue", "--thread", THREAD_ID,
                                               "--message", message, "--remote", "ws://localhost:4567"])
        self.assertFalse(run.call_args.kwargs.get("shell", False))

    def test_queue_failure_is_not_success(self):
        """A nonzero native exit code leaves no false acceptance receipt."""
        failure = subprocess.CompletedProcess([], 1, "", "thread not found")
        with patch("host_dispatch.subprocess.run", return_value=failure):
            with self.assertRaisesRegex(DeliveryUncertain, "thread not found"):
                queue_message(self.options, "测试通知")

    def test_old_cli_is_rejected_before_sending(self):
        """Generic help from an older CLI must not be mistaken for queue support."""
        with patch("host_dispatch.shutil.which", return_value="codex.exe"):
            with patch("host_dispatch.subprocess.run", return_value=subprocess.CompletedProcess([], 0, "Codex CLI", "")):
                with self.assertRaises(ValueError):
                    check_codex("codex")
            with patch("host_dispatch.subprocess.run", return_value=subprocess.CompletedProcess([], 0, "--thread --message", "")):
                self.assertEqual(check_codex("codex"), "codex.exe")

    @unittest.skipUnless(os.name == "nt", "Windows native executable constraint")
    def test_windows_shell_wrappers_are_rejected(self):
        """Do not route discussion text through cmd.exe or a PowerShell wrapper."""
        with patch("host_dispatch.shutil.which", return_value="C:/npm/codex.cmd"):
            with self.assertRaises(ValueError):
                check_codex("codex")

    def test_dry_run_does_not_queue_or_create_state(self):
        """Preview is useful before a destination is activated and never consumes an event."""
        unused = Path(self.directory.name) / "unused.sqlite3"
        with patch("host_dispatch.read_room", return_value=self.room), patch("host_dispatch.queue_message") as queue:
            with patch("host_dispatch.check_codex") as check:
                result = main(["--url", self.options.url, "--room", "room123", "--thread", THREAD_ID,
                               "--state", str(unused), "--dry-run"])
        self.assertEqual(result, 0)
        self.assertFalse(unused.exists())
        queue.assert_not_called()
        check.assert_not_called()

    def test_host_posts_do_not_create_feedback_loop(self):
        """Host moderation, message counters and focus edits do not retrigger a turn."""
        self.event("answered")
        with patch("host_dispatch.read_room", return_value=self.room), patch("host_dispatch.queue_message") as queue:
            self.assertEqual(dispatch_once(self.options, self.connection), "queued")
            self.room.update(latest_id=100, focus="主持人更新焦点")
            self.assertEqual(dispatch_once(self.options, self.connection), "unchanged")
            self.assertEqual(queue.call_count, 1)

    def test_concluded_stops_and_network_failure_does_not_queue(self):
        """A temporary HTTP failure retries reads only; a concluded room stops polling."""
        self.options.once = False
        self.room["phase"] = "concluded"
        with patch("host_dispatch.read_room", side_effect=[URLError("offline"), self.room]):
            with patch("host_dispatch.wait_for_poll") as sleep, patch("host_dispatch.queue_message") as queue:
                watch_room(self.options, self.connection)
        self.assertEqual(sleep.call_count, 1)
        queue.assert_not_called()

    def test_stop_signal_prevents_reads_and_new_queue_calls(self):
        """An owned stop signal exits without reading or notifying any session."""
        self.options.stop_file = Path(self.directory.name) / "owned.stop"
        self.options.stop_file.touch()
        with patch("host_dispatch.read_room") as read, patch("host_dispatch.queue_message") as queue:
            self.assertEqual(dispatch_once(self.options, self.connection), "stopped")
        read.assert_not_called()
        queue.assert_not_called()

    def test_stop_arriving_during_http_read_prevents_queue(self):
        """A stop received while fetching a room must not enqueue a later notice."""
        self.options.stop_file = Path(self.directory.name) / "owned.stop"
        with patch("host_dispatch.read_room", side_effect=self.stop_during_read):
            with patch("host_dispatch.queue_message") as queue:
                self.assertEqual(dispatch_once(self.options, self.connection), "stopped")
        queue.assert_not_called()

    def stop_during_read(self, options):
        """Simulate an operator stopping this monitor during the HTTP request."""
        options.stop_file.touch()
        return self.room

    def test_bindings_do_not_share_delivery_receipts(self):
        """The same room and event in another target session remains independent."""
        other = copy.copy(self.options)
        other.thread = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
        self.assertNotEqual(binding_key(self.options), binding_key(other))
        other.thread = self.options.thread
        other.remote = "ws://localhost:4567"
        self.assertNotEqual(binding_key(self.options), binding_key(other))

    def post(self, path, payload):
        """Write only to the isolated integration-test HTTP server."""
        request = Request(self.options.url + path, data=json.dumps(payload).encode(),
                          headers={"Content-Type": "application/json"})
        with urlopen(request, timeout=5) as response:
            return json.load(response)

    def test_real_http_lifecycle_keeps_expert_notification_separate(self):
        """Real room state drives queue calls without falsely notifying online experts."""
        database = Path(self.directory.name) / "room.sqlite3"
        init_database(database, seed=False)
        server = DiscussionServer(("127.0.0.1", 0), database)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(thread.join)
        self.addCleanup(server.shutdown)
        self.options.url = f"http://127.0.0.1:{server.server_port}"
        room = self.post("/api/rooms", {"title": "隔离调度测试", "host": "Codex",
                                     "experts": {"Codex": "cli", "Gemini": "online"}})
        self.options.room = room["id"]
        base = f"/api/rooms/{room['id']}"
        with patch("host_dispatch.queue_message") as queue:
            self.assertEqual(dispatch_once(self.options, self.connection), "queued")
            turn = self.post(base + "/turns", {"actor": "Codex", "expert": "Gemini",
                                             "question": "测试问题", "submission_id": "test-dispatch-turn"})["turn"]
            self.assertEqual(dispatch_once(self.options, self.connection), "queued")
            with urlopen(self.options.url + base, timeout=5) as response:
                self.assertEqual(json.load(response)["current_turn"]["status"], "pending")
            self.post(base + f"/turns/{turn['id']}", {"actor": "Codex", "status": "notified"})
            self.assertEqual(dispatch_once(self.options, self.connection), "waiting")
            self.post(base + "/messages", {"author": "Gemini", "submitted_by": "Codex", "source": "cli",
                                          "text": "模拟回答", "turn_id": turn["id"], "submission_id": "dispatch-answer"})
            self.assertEqual(dispatch_once(self.options, self.connection), "queued")
            self.assertEqual(queue.call_count, 3)
            self.post(base + "/topic", {"actor": "Codex", "phase": "concluded"})
            self.assertEqual(dispatch_once(self.options, self.connection), "concluded")
            self.post(base + "/topic", {"actor": "用户", "host": "用户"})
            with self.assertRaises(ValueError):
                dispatch_once(self.options, self.connection)


if __name__ == "__main__":
    unittest.main()

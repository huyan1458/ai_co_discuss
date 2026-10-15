"""Verify CLI contracts against isolated real HTTP storage and failure transports."""

import io
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError, URLError

import discuss
from server import DiscussionServer, init_database

ROOT = Path(__file__).resolve().parent


class CliTests(unittest.TestCase):
    """Use real CLI processes and a private database, or a loopback test Worker."""

    @classmethod
    def setUpClass(cls):
        """Start one isolated service for the suite without touching real rooms."""
        cls.directory = tempfile.TemporaryDirectory()
        cls.base = os.getenv("DISCUSS_CLI_TEST_URL", "")
        cls.external = bool(cls.base)
        if cls.external:
            if not cls.base.startswith(("http://127.0.0.1:", "http://localhost:")):
                raise ValueError("CLI 写入测试只能指向隔离的本机服务")
            return
        database = Path(cls.directory.name) / "cli.sqlite3"
        init_database(database, seed=False)
        cls.server = DiscussionServer(("127.0.0.1", 0), database)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        """Close only the private test process and temporary storage."""
        if not cls.external:
            cls.server.shutdown()
            cls.server.server_close()
            cls.thread.join()
        cls.directory.cleanup()

    def setUp(self):
        """Create a fresh room through the CLI for each case."""
        result = self.cli("room", "create", "--title", "CLI 测试", "--goal", "验证真实行为",
                          "--background", "按需背景正文", "--boundaries", "按需边界正文", "--as", "Codex")
        self.room = result["id"]

    def invoke(self, arguments, stdin=None, environment=None):
        """Run the actual entrypoint with UTF-8 streams and no inherited target."""
        env = {**os.environ, "DISCUSS_URL": "", **(environment or {})}
        return subprocess.run([sys.executable, str(ROOT / "discuss.py"), *map(str, arguments)],
                              input=stdin, capture_output=True, text=True, encoding="utf-8",
                              env=env, timeout=10)

    def cli(self, *arguments, stdin=None):
        """Require a successful, clean machine-readable result."""
        result = self.invoke(["--site", self.base, *arguments], stdin)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, "")
        payload = json.loads(result.stdout)
        self.assertTrue(payload["ok"])
        return payload["data"]

    def rejected(self, arguments, code=2):
        """Require structured errors on stderr and no success data on stdout."""
        result = self.invoke(["--site", self.base, *arguments])
        self.assertEqual(result.returncode, code, result.stderr)
        self.assertEqual(result.stdout, "")
        payload = json.loads(result.stderr)
        self.assertFalse(payload["ok"])
        return payload["error"]

    def test_progressive_reads_do_not_expand_materials(self):
        """Overview/list omit briefing, state, and message bodies."""
        self.cli("state", "set", self.room, "--body", "未主动读取的摘要", "--until", "0", "--as", "Codex")
        view = self.cli("room", "view", self.room)
        self.assertNotIn("background", view)
        self.assertNotIn("state_text", view)
        self.assertEqual(self.cli("room", "brief", self.room)["background"], "按需背景正文")
        self.assertEqual(self.cli("state", "view", self.room)["state_text"], "未主动读取的摘要")
        listing = self.cli("room", "list")
        self.assertTrue(all("state_text" not in room for room in listing["rooms"]))
        self.assertIn("POST", self.cli("room", "protocol", self.room))

    def test_complete_speaking_and_conclusion_workflow(self):
        """A scheduled, notified answer completes once and permits a real conclusion."""
        turn = self.cli("turn", "create", self.room, "--expert", "Codex", "--question", "如何验证？",
                        "--submission-id", "workflow-turn", "--as", "Codex")["turn"]
        prompt = self.cli("turn", "prompt", self.room, turn["id"])
        self.assertIn("如何验证？", prompt["prompt"])
        self.assertNotIn("按需背景正文", prompt["prompt"])
        self.assertNotIn("mode=cli", prompt["prompt"])
        self.assertEqual(self.cli("turn", "view", self.room, turn["id"])["status"], "pending")
        self.cli("turn", "mark-notified", self.room, turn["id"], "--as", "Codex")
        message = self.cli("message", "post", self.room, "--body", "原文依据", "--turn", turn["id"],
                           "--submission-id", "workflow-answer", "--as", "Codex")["message"]
        current = self.cli("turn", "current", self.room)["current_turn"]
        self.assertEqual((current["status"], current["answer_id"]), ("answered", message["id"]))
        self.cli("state", "set", self.room, "--body", f"结论依据 #{message['id']}",
                 "--until", message["id"], "--as", "Codex")
        self.cli("room", "update", self.room, "--phase", "concluded", "--as", "Codex")
        self.assertEqual(self.cli("room", "view", self.room)["phase"], "concluded")

    def test_message_retry_conflict_and_exact_original(self):
        """Same identifier replays, changed content conflicts, and reads remain exact."""
        args = ["message", "post", self.room, "--body", "@Gemini 成本 &= #1\n原文", "--as", "Codex",
                "--submission-id", "retry-original"]
        first = self.cli(*args)
        repeated = self.cli(*args)
        self.assertTrue(repeated["duplicate"])
        self.assertEqual(first["message"], repeated["message"])
        original = self.cli("message", "view", self.room, first["message"]["id"])
        self.assertEqual(original["text"], "@Gemini 成本 &= #1\n原文")
        args[4] = "换了内容"
        self.assertEqual(self.rejected(args, 1)["http_status"], 409)

    def test_turn_replay_cancel_and_conclude_guard(self):
        """Creating a turn is idempotent and uncompleted work cannot be concluded."""
        args = ["turn", "create", self.room, "--expert", "Codex", "--question", "一次任务",
                "--submission-id", "retry-turn-001", "--as", "Codex"]
        turn = self.cli(*args)["turn"]
        self.assertTrue(self.cli(*args)["duplicate"])
        self.rejected(["room", "update", self.room, "--phase", "concluded", "--as", "Codex"], 1)
        self.cli("turn", "cancel", self.room, turn["id"], "--as", "Codex")
        self.assertEqual(self.cli("turn", "list", self.room)["turns"][0]["status"], "cancelled")
        self.cli("room", "update", self.room, "--phase", "concluded", "--as", "Codex")

    def test_forwarded_author_and_online_write_boundary(self):
        """Forwarding preserves the expert; online experts cannot submit as CLI selves."""
        self.rejected(["message", "post", self.room, "--body", "在线自行写入", "--as", "Claude",
                       "--submission-id", "online-reject"], 1)
        forwarded = self.cli("message", "post", self.room, "--body", "真实取得的在线原文",
                             "--as", "Codex", "--author", "Claude", "--submission-id", "online-forward")["message"]
        self.assertEqual((forwarded["author"], forwarded["submitted_by"], forwarded["source"]),
                         ("Claude", "Codex", "host_proxy"))
        note = self.cli("message", "post", self.room, "--body", "主持说明", "--kind", "moderation",
                        "--as", "Codex", "--submission-id", "moderator-note")["message"]
        self.assertEqual(note["kind"], "moderation")

    def test_pause_blocks_opinions_but_accepts_independent_receipts(self):
        """Paused state guards stay on the server and receipts never answer a turn."""
        self.cli("room", "update", self.room, "--phase", "paused", "--as", "Codex")
        self.rejected(["message", "post", self.room, "--body", "迟到观点", "--as", "Codex",
                       "--submission-id", "late-opinion"], 1)
        self.rejected(["turn", "create", self.room, "--expert", "Codex", "--question", "迟到安排",
                       "--as", "Codex", "--submission-id", "late-turn-01"], 1)
        receipt = self.cli("message", "post", self.room, "--body", "已核对退出结果", "--kind", "receipt",
                           "--as", "Codex", "--submission-id", "exit-receipt")["message"]
        self.assertIsNone(receipt["turn_id"])
        self.rejected(["message", "post", self.room, "--body", "伪回答", "--kind", "receipt", "--turn", "1",
                       "--as", "Codex", "--submission-id", "invalid-receipt"])

    def test_files_stdin_unicode_and_quote_roundtrip(self):
        """BOM files and stdin preserve interior whitespace, quotes, and Unicode."""
        original = '中文 "引号" & <tag> $() `特殊字符`\n第二行🙂'
        file = Path(self.directory.name) / "正文 文件.txt"
        file.write_text(original, encoding="utf-8-sig")
        message = self.cli("message", "post", self.room, "--body-file", file, "--as", "Codex",
                           "--submission-id", "utf8-file-01")["message"]
        self.assertEqual(message["text"], original)
        reply = self.cli("message", "post", self.room, "--body-file", "-", "--as", "Codex",
                         "--reply-to", message["id"], "--submission-id", "utf8-stdin-01", stdin=original)["message"]
        self.assertEqual((reply["text"], reply["reply_to"]), (original, message["id"]))

    def test_search_and_pagination_are_bounded(self):
        """One page stays at twenty and encoded filters retain exact semantics."""
        for index in range(21):
            self.cli("message", "post", self.room, "--body", f"@Gemini 成本 &= {index}", "--as", "Codex",
                     "--submission-id", f"pagination-{index:03}")
        first = self.cli("message", "list", self.room, "--query", "成本 &=", "--mention", "Gemini",
                         "--author", "Codex")
        self.assertEqual((len(first["messages"]), first["total"], first["pages"]), (20, 21, 2))
        self.assertEqual(len(self.cli("message", "list", self.room, "--page", "2")["messages"]), 1)

    def test_explicit_site_overrides_environment_and_room_is_required(self):
        """No global current room or environment identity can redirect a write."""
        env = {"DISCUSS_URL": "http://127.0.0.1:1"}
        result = self.invoke(["room", "view", self.room, "--site", self.base], environment=env)
        self.assertEqual(result.returncode, 0, result.stderr)
        result = self.invoke(["health"], environment={"DISCUSS_URL": self.base})
        self.assertEqual(result.returncode, 0, result.stderr)
        missing = self.invoke(["room", "view"])
        self.assertEqual(missing.returncode, 2)
        self.rejected(["message", "post", self.room, "--body", "不能猜身份", "--submission-id", "no-actor-01"])
        self.assertEqual(self.invoke(["health"]).returncode, 2)

    def test_cross_room_references_and_wrong_host_are_rejected(self):
        """The CLI retains server room and role checks rather than bypassing them."""
        message = self.cli("message", "post", self.room, "--body", "房间甲", "--as", "Codex",
                           "--submission-id", "room-a-message")["message"]
        other = self.cli("room", "create", "--title", "房间乙", "--as", "Codex")["id"]
        self.rejected(["message", "view", other, message["id"]], 1)
        self.rejected(["message", "post", other, "--body", "跨房间引用", "--reply-to", message["id"],
                       "--as", "Codex", "--submission-id", "bad-reference"], 1)
        self.rejected(["room", "update", self.room, "--focus", "错误操作者", "--as", "Gemini"], 1)

    def test_experts_full_map_and_partial_topic_update(self):
        """Changing one topic field preserves others; experts use an explicit full map."""
        experts = Path(self.directory.name) / "experts.json"
        experts.write_text('{"Codex":"cli","Gemini":"cli"}', encoding="utf-8")
        self.cli("room", "update", self.room, "--experts-file", experts, "--focus", "新焦点", "--as", "Codex")
        self.assertEqual(self.cli("room", "brief", self.room)["experts"], {"Codex": "cli", "Gemini": "cli"})
        self.assertEqual(self.cli("room", "brief", self.room)["background"], "按需背景正文")
        message = self.cli("message", "post", self.room, "--body", "本地专家", "--as", "Gemini",
                           "--submission-id", "gemini-cli-01")["message"]
        self.assertEqual(message["source"], "cli")

    def test_raw_api_file_and_text_output(self):
        """Raw requests use the same transport, and readable output is opt-in."""
        body = {"actor": "Codex", "focus": "原始接口维护"}
        self.cli("api", f"/api/rooms/{self.room}/topic", "--method", "POST", "--input", "-",
                 stdin=json.dumps(body))
        room = self.cli("api", f"/api/rooms/{self.room}")
        self.assertEqual(room["focus"], "原始接口维护")
        result = self.invoke(["room", "view", self.room, "--site", self.base, "-o", "text"])
        self.assertEqual(result.returncode, 0)
        self.assertIn("focus: 原始接口维护", result.stdout)
        self.assertNotIn("background", result.stdout)


class CliContractTests(unittest.TestCase):
    """Prove offline behavior, no implicit retries, and deterministic failure output."""

    def parse(self, arguments):
        """Return parsed arguments and the live command registry."""
        parser, registry = discuss.build_parser()
        return parser.parse_args(arguments), registry

    def test_help_and_schema_work_without_network(self):
        """Schema is generated from real flags, including required operator and body alternatives."""
        args, registry = self.parse(["schema", "message", "post"])
        with patch("discuss.build_opener") as opener:
            schema = discuss.run(args, registry)["data"]
        opener.assert_not_called()
        self.assertTrue(next(item for item in schema["arguments"] if item["name"] == "actor")["required"])
        self.assertEqual(schema["exclusive_groups"][0]["one_of"], ["body", "body_file"])

    def test_dry_run_never_requests_even_for_unknown_rooms(self):
        """Previews are entirely offline and make no claim of server validation."""
        args, registry = self.parse(["message", "post", "unknown", "--as", "Codex", "--body", "预览",
                                     "--submission-id", "preview-001", "--site", "https://example.org", "--dry-run"])
        with patch("discuss.build_opener") as opener:
            result = discuss.run(args, registry)
        opener.assert_not_called()
        self.assertTrue(result["meta"]["dry_run"])
        self.assertEqual(result["data"]["body"]["submission_id"], "preview-001")

    def test_write_network_failure_does_not_retry_and_keeps_replay_id(self):
        """Ambiguous failures report the original request ID and exactly one attempt."""
        args, registry = self.parse(["message", "post", "room", "--as", "Codex", "--body", "原文",
                                     "--submission-id", "uncertain-001", "--site", "https://example.org"])
        with patch("discuss.build_opener") as opener:
            opener.return_value.open.side_effect = URLError("connection dropped")
            with self.assertRaises(discuss.CliError) as failure:
                discuss.run(args, registry)
        opener.return_value.open.assert_called_once()
        self.assertEqual(failure.exception.code, 3)
        self.assertEqual(failure.exception.details["outcome"], "unknown")
        self.assertEqual(failure.exception.details["submission_id"], "uncertain-001")

    def test_http_server_failure_is_uncertain_and_not_replayed(self):
        """A server error after POST cannot be advertised as definitely not saved."""
        plan = discuss.RequestPlan("/api/rooms/x/messages", "POST", {"submission_id": "server-001"})
        error = HTTPError("https://example.org/api", 502, "bad gateway", {}, io.BytesIO(b"bad gateway"))
        with patch("discuss.build_opener") as opener:
            opener.return_value.open.side_effect = error
            with self.assertRaises(discuss.CliError) as failure:
                discuss.send_request(plan, error.url, 1)
        opener.return_value.open.assert_called_once()
        self.assertEqual(failure.exception.details["outcome"], "unknown")

    def test_redirects_are_not_followed(self):
        """A redirect must not send the body elsewhere or downgrade POST to GET."""
        self.assertIsNone(discuss.NoRedirect().redirect_request(None, None, 302, "", {}, "https://other.org"))

    def test_malformed_success_response_is_not_success(self):
        """HTML challenge pages and unexpected JSON are not treated as accepted writes."""
        for body in (b"<html>challenge</html>", b"[]"):
            response = io.BytesIO(body)
            with self.assertRaises(discuss.CliError) as failure:
                discuss.decode_response(response, discuss.RequestPlan("/api/rooms", "POST", {}))
            self.assertEqual(failure.exception.details["outcome"], "unknown")

    def test_invalid_inputs_fail_before_network(self):
        """Invalid targets, ambiguous stdin, raw GET bodies, and empty updates fail locally."""
        commands = [
            ["api", "https://other.org/api/rooms"], ["api", "/api/../private"],
            ["api", "/api/rooms", "--input", "-"], ["api", "/api/rooms", "--method", "POST"],
            ["room", "update", "room", "--as", "Codex"],
            ["room", "create", "--title-file", "-", "--goal-file", "-", "--as", "Codex"],
            ["health", "--dry-run"], ["health", "--timeout", "nan"],
        ]
        with patch("discuss.build_opener") as opener:
            for command in commands:
                with self.subTest(command=command), self.assertRaises(discuss.CliError):
                    args, registry = self.parse(["--site", "https://example.org", *command])
                    discuss.run(args, registry)
        opener.assert_not_called()


if __name__ == "__main__":
    unittest.main()

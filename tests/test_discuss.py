"""Verify CLI contracts against isolated real HTTP storage and failure transports."""

import io
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError, URLError

from backend.server import DiscussionServer, init_database
from runner import discuss

ROOT = Path(__file__).resolve().parent.parent


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
                          "--background", "按需背景正文", "--boundaries", "按需边界正文", "--as", "Codex",
                          "--submission-id", str(uuid.uuid4()))
        self.room = result["id"]

    def test_limit_configuration_and_check_are_discoverable(self):
        """Typed options survive create/read/update and a non-triggered check."""
        room = self.cli("room", "create", "--title", "参数", "--as", "Codex",
                        "--submission-id", str(uuid.uuid4()), "--max-rounds", "3", "--max-minutes", "60",
                        "--execution-minutes", "10", "--on-limit", "summarize", "--summary-minutes", "5")
        self.assertEqual(room["limits"]["max_rounds"], 3)
        self.assertEqual(self.cli("room", "limits", room["id"])["max_minutes"], 60)
        self.assertEqual(self.cli("room", "limits", room["id"], "--check", "--as", "Codex")["phase"], "preparing")
        self.assertEqual(self.cli("room", "update", room["id"], "--as", "Codex", "--max-rounds", "0")["limits"]["max_rounds"], 0)

    def test_folder_creation_option_is_forwarded_in_one_request(self):
        """Expose folder placement in the CLI's documented creation payload."""
        result = self.cli("room", "create", "--title", "文件夹内", "--as", "Codex", "--folder-id", "folder-id",
                          "--submission-id", str(uuid.uuid4()), "--dry-run")
        self.assertEqual(result["body"]["folder_id"], "folder-id")

    def invoke(self, arguments, stdin=None, environment=None):
        """Run the actual entrypoint with UTF-8 streams and no inherited target."""
        env = {**os.environ, "DISCUSS_URL": "", **(environment or {})}
        return subprocess.run([sys.executable, str(ROOT / "runner" / "discuss.py"), *map(str, arguments)],
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

    def take_floor(self, speaker="Codex", actor=None):
        """Claim the actual nominated floor using the public CLI and latest revision."""
        floor = self.cli("floor", "view", self.room)
        return self.cli("floor", "take", self.room, "--as", actor or speaker,
                        "--speaker", speaker, "--revision", floor["revision"])

    def test_access_file_is_room_scoped_and_not_printed_in_preview(self):
        """A private capability is usable only for its configured site and room."""
        path = Path(self.directory.name) / "runtime-access.json"
        secret = uuid.uuid4().hex
        path.write_text(json.dumps({"site": self.base, "room": self.room, "token": secret}), encoding="utf-8")
        configured = self.cli("run", "configure", self.room, "--mode", "automatic", "--revision", 0, "--access-file", path)
        self.assertEqual(configured["mode"], "automatic")
        preview = self.invoke(["--site", self.base, "run", "pause", self.room, "--revision", configured["revision"],
                               "--access-file", path, "--dry-run"])
        self.assertEqual(preview.returncode, 0, preview.stderr)
        self.assertNotIn(secret, preview.stdout + preview.stderr)
        error = self.rejected(["run", "view", "other-room", "--access-file", path])
        self.assertIn("凭据文件不属于", str(error))
        path.write_text(json.dumps({"site": "http://localhost:1", "room": self.room, "token": secret}), encoding="utf-8")
        self.assertIn("凭据文件不属于", str(self.rejected(["run", "view", self.room, "--access-file", path])))

    def plan_speech(self, speaker="Codex", actor=None):
        """Create and claim a valid assignment for a content-focused CLI regression."""
        if self.cli("floor", "view", self.room)["holder"] is None:
            self.take_floor()
        turn = self.cli("turn", "create", self.room, "--expert", speaker,
                        "--question", "测试安排", "--as", "Codex", "--submission-id", str(uuid.uuid4()))["turn"]
        self.take_floor(speaker, actor)
        return turn["id"]

    def test_round_plan_from_stdin_relays_and_continue_needs_host_turn(self):
        """A plan file queues later experts; an answer relays without returning to the host."""
        if self.cli("floor", "view", self.room)["holder"] is None:
            self.take_floor()
        plan = json.dumps([{"expert": "Codex", "question": "先答"}, {"expert": "Gemini", "question": "再答"}], ensure_ascii=False)
        created = self.cli("turn", "create", self.room, "--plan-file", "-", "--as", "Codex",
                           "--submission-id", str(uuid.uuid4()), stdin=plan)
        current = self.cli("turn", "current", self.room)
        self.assertEqual((current["current_turn"]["expert"], [item["expert"] for item in current["queued_turns"]]), ("Codex", ["Gemini"]))
        self.assertEqual(self.rejected(["turn", "continue", self.room, "--as", "Codex"], 1)["http_status"], 409)
        self.take_floor("Codex")
        self.cli("message", "post", self.room, "--body", "回答", "--as", "Codex", "--turn", created["turn"]["id"],
                 "--summary", "摘要", "--submission-id", str(uuid.uuid4()))
        current = self.cli("turn", "current", self.room)
        self.assertEqual((current["current_turn"]["expert"], current["queued_turns"], current["floor"]["next_speaker"]), ("Gemini", [], "Gemini"))
        self.rejected(["turn", "create", self.room, "--plan-file", "-", "--expert", "Codex", "--as", "Codex",
                       "--submission-id", str(uuid.uuid4())])

    def test_user_request_file_round_trip_is_separate_from_background(self):
        """Expose original requests through explicit brief reads and UTF-8 file inputs."""
        original = "  原始请求🙂\n保留缩进  \n"
        path = Path(self.directory.name) / "user-request.txt"
        path.write_bytes(original.encode("utf-8"))
        self.cli("room", "update", self.room, "--as", "Codex", "--user-request-file", path)
        brief = self.cli("room", "brief", self.room)
        self.assertEqual((brief["user_request"], brief["background"]), (original, "按需背景正文"))
        self.assertNotIn("user_request", self.cli("room", "view", self.room))
        self.cli("room", "update", self.room, "--as", "Codex", "--background", "背景更新")
        self.assertEqual(self.cli("room", "brief", self.room)["user_request"], original)
        self.cli("room", "update", self.room, "--as", "Codex", "--user-request", "更新的原文")
        self.assertEqual(self.cli("room", "brief", self.room)["user_request"], "更新的原文")

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
        self.take_floor()
        message = self.cli("message", "post", self.room, "--body", "原文依据", "--turn", turn["id"],
                           "--submission-id", "workflow-answer", "--as", "Codex")["message"]
        current = self.cli("turn", "current", self.room)["current_turn"]
        self.assertEqual((current["status"], current["answer_id"]), ("answered", message["id"]))
        self.cli("state", "set", self.room, "--body", f"结论依据 #{message['id']}",
                 "--until", message["id"], "--as", "Codex")
        self.cli("room", "update", self.room, "--phase", "concluded", "--as", "Codex")
        self.assertEqual(self.cli("room", "view", self.room)["phase"], "concluded")

    def test_resume_recovers_completed_action_and_preserves_citations(self):
        """Separate CLI processes recover a stale plan without duplicating its created turn."""
        pending = "下一步：创建 Codex 复核安排，未执行；争点：试用条件与上线标准，待当事人确认。"
        self.cli("state", "set", self.room, "--body", pending, "--until", 0, "--as", "Codex")
        args = ["turn", "create", self.room, "--expert", "Codex", "--question", "请澄清原意及条件",
                "--submission-id", "recover-turn", "--as", "Codex"]
        turn = self.cli(*args)["turn"]
        self.assertEqual(self.cli("state", "view", self.room)["state_text"], pending)
        self.assertEqual(self.cli("turn", "current", self.room)["current_turn"]["id"], turn["id"])
        self.assertTrue(self.cli(*args)["duplicate"])
        self.assertEqual(len(self.cli("turn", "list", self.room)["turns"]), 1)
        original = "只建议试用，不代表上线验收。\n条件：小范围验证；反例：已有合规问答工具。[6]\n\n主持人从原回答提取的引用：\n[6] https://example.org/source#conditions\n未核验的 43% 仅为候选条件。"
        self.take_floor()
        answer = self.cli("message", "post", self.room, "--body", original, "--as", "Codex", "--turn", turn["id"],
                          "--submission-id", "recover-answer")["message"]
        self.assertEqual(self.cli("message", "view", self.room, answer["id"])["text"], original)
        final_state = f"已处理 #{answer['id']}；试用与上线有别。43% 未核验；下一步待验证。任务清理待确认。"
        self.cli("state", "set", self.room, "--body", final_state, "--until", answer["id"], "--as", "Codex")
        self.cli("room", "update", self.room, "--phase", "concluded", "--as", "Codex")
        self.take_floor()
        receipt = self.cli("message", "post", self.room, "--kind", "receipt", "--body", "run=recover；task-1 已停止",
                           "--as", "Codex", "--submission-id", "recover-stop")["message"]
        for view in (self.cli("room", "view", self.room), self.cli("state", "view", self.room)):
            self.assertEqual(view["latest_receipts"][0]["id"], receipt["id"])
            self.assertEqual(view["state_until"], answer["id"])
            self.assertNotIn("text", view["latest_receipts"][0])
        self.assertEqual(self.cli("state", "view", self.room)["state_text"], final_state)

    def test_message_retry_conflict_and_exact_original(self):
        """Same identifier replays, changed content conflicts, and reads remain exact."""
        args = ["message", "post", self.room, "--body", "@Gemini 成本 &= #1\n原文", "--as", "Codex",
                "--submission-id", "retry-original", "--turn", self.plan_speech()]
        first = self.cli(*args)
        repeated = self.cli(*args)
        self.assertTrue(repeated["duplicate"])
        self.assertEqual(first["message"], repeated["message"])
        original = self.cli("message", "view", self.room, first["message"]["id"])
        self.assertEqual(original["text"], "@Gemini 成本 &= #1\n原文")
        found = self.cli("message", "list", self.room, "--submission-id", "retry-original")
        self.assertEqual(found["messages"], [original])
        self.assertEqual(self.cli("message", "list", self.room, "--submission-id", "unknown-result")["messages"], [])
        args[4] = "换了内容"
        self.assertEqual(self.rejected(args, 1)["http_status"], 409)

    def test_answer_summary_and_host_brief_files_round_trip(self):
        """CLI file inputs preserve separate human summaries, provenance and material boundaries."""
        summary_file = Path(self.directory.name) / "answer-summary.txt"
        brief_file = Path(self.directory.name) / "host-brief.txt"
        summary_file.write_text("建议先验证；权限缺口仍未解决。", encoding="utf-8")
        brief_file.write_text("已有候选方案；共识是先验证，歧义是成本；下一步追问权限。", encoding="utf-8")
        turn_id = self.plan_speech("Gemini", "Codex")
        answer = self.cli("message", "post", self.room, "--body", "完整正文\n必须保留条件与反例。",
                          "--summary-file", summary_file, "--summary-by", "Gemini", "--author", "Gemini",
                          "--submission-id", "summary-file", "--as", "Codex", "--turn", turn_id)["message"]
        self.assertEqual((answer["summary"], answer["summary_by"]), (summary_file.read_text(encoding="utf-8"), "Gemini"))
        self.assertEqual(self.cli("message", "view", self.room, answer["id"])["text"], "完整正文\n必须保留条件与反例。")
        saved = self.cli("state", "set", self.room, "--body", "详细进度", "--brief-file", brief_file,
                         "--until", answer["id"], "--as", "Codex")
        self.assertEqual(saved["host_brief"]["text"], brief_file.read_text(encoding="utf-8"))
        self.assertEqual(self.cli("state", "view", self.room)["host_brief"], saved["host_brief"])
        self.assertNotIn("host_brief", self.cli("room", "view", self.room))
        rejected = self.rejected(["message", "post", self.room, "--body", "正文", "--summary", "🙂" * 1001,
                                  "--submission-id", "summary-over-limit", "--as", "Codex"])
        self.assertIn("1000", rejected["message"])

    def test_turn_replay_cancel_and_conclude_guard(self):
        """Creating a turn is idempotent and uncompleted work cannot be concluded."""
        args = ["turn", "create", self.room, "--expert", "Codex", "--question", "一次任务",
                "--submission-id", "retry-turn-001", "--as", "Codex"]
        turn = self.cli(*args)["turn"]
        self.assertTrue(self.cli(*args)["duplicate"])
        self.assertEqual(self.cli("turn", "list", self.room, "--submission-id", "retry-turn-001")["turns"], [turn])
        self.rejected(["room", "update", self.room, "--phase", "concluded", "--as", "Codex"], 1)
        self.cli("turn", "cancel", self.room, turn["id"], "--as", "用户")
        self.assertEqual(self.cli("turn", "list", self.room)["turns"][0]["status"], "cancelled")
        self.cli("room", "update", self.room, "--phase", "concluded", "--as", "Codex")

    def test_forwarded_author_and_online_write_boundary(self):
        """Forwarding preserves the expert; online experts cannot submit as CLI selves."""
        self.rejected(["message", "post", self.room, "--body", "在线自行写入", "--as", "Claude",
                       "--submission-id", "online-reject"], 1)
        turn_id = self.plan_speech("Claude", "Codex")
        forwarded = self.cli("message", "post", self.room, "--body", "真实取得的在线原文",
                             "--as", "Codex", "--author", "Claude", "--submission-id", "online-forward", "--turn", turn_id)["message"]
        self.assertEqual((forwarded["author"], forwarded["submitted_by"], forwarded["source"]),
                         ("Claude", "Codex", "host_proxy"))
        self.take_floor()
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
        message = self.cli("message", "post", self.room, "--body-file", file, "--as", "用户",
                           "--submission-id", "utf8-file-01")["message"]
        self.assertEqual(message["text"], original)
        reply = self.cli("message", "post", self.room, "--body-file", "-", "--as", "用户",
                         "--reply-to", message["id"], "--submission-id", "utf8-stdin-01", stdin=original)["message"]
        self.assertEqual((reply["text"], reply["reply_to"]), (original, message["id"]))

    def test_search_and_pagination_are_bounded(self):
        """One page stays at twenty and encoded filters retain exact semantics."""
        for index in range(21):
            self.cli("message", "post", self.room, "--body", f"@Gemini 成本 &= {index}", "--as", "用户",
                     "--submission-id", f"pagination-{index:03}")
        first = self.cli("message", "list", self.room, "--query", "成本 &=", "--mention", "Gemini",
                         "--author", "用户")
        self.assertEqual((len(first["messages"]), first["total"], first["pages"]), (20, 21, 2))
        self.assertEqual(len(self.cli("message", "list", self.room, "--page", "2")["messages"]), 1)
        incremental = self.cli("message", "list", self.room, "--after", "0", "--kind", "opinion")
        self.assertEqual(incremental["messages"], first["messages"])
        self.assertTrue(incremental["has_more"])
        receipt = self.cli("message", "post", self.room, "--body", "运行记录", "--kind", "receipt",
                           "--as", "Codex", "--submission-id", "paging-receipt")["message"]
        latest = self.cli("message", "post", self.room, "--body", "新到观点", "--as", "用户",
                          "--submission-id", "paging-new-opinion")["message"]
        following = self.cli("message", "list", self.room, "--after", incremental["next_after"], "--kind", "opinion")
        self.assertEqual([row["text"] for row in following["messages"]], ["@Gemini 成本 &= 20", "新到观点"])
        self.assertEqual(following["next_after"], latest["id"])
        self.assertFalse(following["has_more"])
        empty = self.cli("message", "list", self.room, "--after", latest["id"])
        self.assertEqual((empty["messages"], empty["next_after"], empty["has_more"]), ([], latest["id"], False))
        self.assertEqual(self.cli("message", "list", self.room, "--kind", "receipt")["messages"], [receipt])
        self.rejected(["message", "list", self.room, "--after", "0", "--page", "2"])

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
        message = self.cli("message", "post", self.room, "--body", "房间甲", "--as", "用户",
                           "--submission-id", "room-a-message")["message"]
        other = self.cli("room", "create", "--title", "房间乙", "--as", "Codex",
                         "--submission-id", str(uuid.uuid4()))["id"]
        self.rejected(["message", "view", other, message["id"]], 1)
        self.assertEqual(self.cli("message", "list", other, "--submission-id", "room-a-message")["messages"], [])
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
        turn_id = self.plan_speech("Gemini")
        message = self.cli("message", "post", self.room, "--body", "本地专家", "--as", "Gemini",
                           "--submission-id", "gemini-cli-01", "--turn", turn_id)["message"]
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


    def test_creation_response_loss_recovers_without_overwriting_later_edits(self):
        """A committed but unacknowledged creation is found and replayed exactly once."""
        identifier = str(uuid.uuid4())
        arguments = ["room", "create", "--title", "首次建房", "--as", "Codex", "--submission-id", identifier]
        parser, registry = discuss.build_parser()
        args = parser.parse_args(["--site", self.base, *arguments])
        original_send = discuss.send_request

        def lose_acknowledgement(plan, url, timeout):
            original_send(plan, url, timeout)
            raise discuss.CliError("响应丢失", 3, outcome="unknown")

        with patch.object(discuss, "send_request", side_effect=lose_acknowledgement) as sender:
            with self.assertRaises(discuss.CliError) as failure:
                discuss.run(args, registry)
        sender.assert_called_once()
        self.assertEqual(failure.exception.details["submission_id"], identifier)
        found = self.cli("room", "list", "--submission-id", identifier)["rooms"]
        self.assertEqual(len(found), 1)
        room = found[0]["id"]
        self.cli("room", "update", room, "--title", "后来修改", "--phase", "paused", "--as", "Codex")
        replay = self.cli(*arguments)
        self.assertEqual((replay["id"], replay["title"], replay["phase"], replay["duplicate"]),
                         (room, "后来修改", "paused", True))
        self.assertEqual(self.rejected([*arguments, "--goal", "不同建房请求"], 1)["http_status"], 409)
        self.assertEqual(self.cli("room", "list", "--submission-id", "unknown-room-request")["rooms"], [])

    def test_complete_long_answer_is_preserved_and_finishes_only_once(self):
        """Unicode length, not UTF-16 units, bounds one complete forwarded answer."""
        turn = self.cli("turn", "create", self.room, "--expert", "Gemini", "--question", "完整论证",
                        "--submission-id", "long-answer-turn", "--as", "Codex")["turn"]
        arguments = ["message", "post", self.room, "--body-file", "-", "--author", "Gemini", "--as", "Codex",
                     "--turn", turn["id"], "--submission-id", "long-answer-message"]
        oversized = self.invoke(["--site", self.base, *arguments], stdin="🙂" * 32001)
        self.assertEqual(oversized.returncode, 2)
        self.assertEqual(self.cli("turn", "current", self.room)["current_turn"]["status"], "pending")
        original = "🙂" * 32000
        self.take_floor("Gemini", "Codex")
        message = self.cli(*arguments, stdin=original)["message"]
        self.assertEqual(self.cli("message", "view", self.room, message["id"])["text"], original)
        self.assertTrue(self.cli(*arguments, stdin=original)["duplicate"])
        self.assertEqual(self.cli("room", "view", self.room)["message_count"], 1)
        self.assertEqual(self.cli("turn", "current", self.room)["current_turn"]["answer_id"], message["id"])


class CliContractTests(unittest.TestCase):
    """Prove offline behavior, no implicit retries, and deterministic failure output."""

    def parse(self, arguments):
        """Return parsed arguments and the live command registry."""
        parser, registry = discuss.build_parser()
        return parser.parse_args(arguments), registry

    def test_help_and_schema_work_without_network(self):
        """Schema is generated from real flags, including required operator and body alternatives."""
        args, registry = self.parse(["schema", "message", "post"])
        with patch.object(discuss, "build_opener") as opener:
            schema = discuss.run(args, registry)["data"]
        opener.assert_not_called()
        self.assertTrue(next(item for item in schema["arguments"] if item["name"] == "actor")["required"])
        self.assertEqual(schema["exclusive_groups"][0]["one_of"], ["body", "body_file"])

    def test_dry_run_never_requests_even_for_unknown_rooms(self):
        """Previews are entirely offline and make no claim of server validation."""
        args, registry = self.parse(["message", "post", "unknown", "--as", "Codex", "--body", "预览",
                                     "--submission-id", "preview-001", "--site", "https://example.org", "--dry-run"])
        with patch.object(discuss, "build_opener") as opener:
            result = discuss.run(args, registry)
        opener.assert_not_called()
        self.assertTrue(result["meta"]["dry_run"])
        self.assertEqual(result["data"]["body"]["submission_id"], "preview-001")

    def test_write_network_failure_does_not_retry_and_keeps_replay_id(self):
        """Ambiguous failures report the original request ID and exactly one attempt."""
        args, registry = self.parse(["message", "post", "room", "--as", "Codex", "--body", "原文",
                                     "--submission-id", "uncertain-001", "--site", "https://example.org"])
        with patch.object(discuss, "build_opener") as opener:
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
        with patch.object(discuss, "build_opener") as opener:
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
            ["room", "create", "--title-file", "-", "--goal-file", "-", "--as", "Codex", "--submission-id", "invalid-stdin"],
            ["room", "create", "--title", "缺少提交编号", "--as", "Codex"],
            ["health", "--dry-run"], ["health", "--timeout", "nan"],
        ]
        with patch.object(discuss, "build_opener") as opener:
            for command in commands:
                with self.subTest(command=command), self.assertRaises(discuss.CliError):
                    args, registry = self.parse(["--site", "https://example.org", *command])
                    discuss.run(args, registry)
        opener.assert_not_called()


if __name__ == "__main__":
    unittest.main()

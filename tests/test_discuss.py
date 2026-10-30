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
from urllib.request import Request, urlopen

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
        self.room_access = {}
        self.session_room = None
        result = self.cli("room", "create", "--title", "CLI 测试", "--goal", "验证真实行为",
                          "--background", "按需背景正文", "--boundaries", "按需边界正文", "--as", "Codex",
                          "--submission-id", str(uuid.uuid4()))
        self.room = result["id"]

    def create_discussion_room(self, online=()):
        """Create a free room with a runner host and member credentials, then open a real session."""
        names = ("Codex", "Claude", "Gemini", "DeepSeek", "Qwen", "Grok")
        owner = uuid.uuid4().hex
        tokens = {name: uuid.uuid4().hex for name in names}
        adapters = {"Codex": "codex_cli", "Claude": "claude", "Gemini": "antigravity_cli",
                    "DeepSeek": "api", "Qwen": "api", "Grok": "api"}
        members = [{"name": name, "token": tokens[name], "adapter": adapters[name],
                    "access": "manual" if name in online else "runner",
                    **({"manual_source": "web"} if name in online else {})} for name in names]
        payload = {"title": "CLI 讨论会话", "goal": "验证讨论回答绑定", "mode": "free", "host": "Codex",
                   "members": members, "submission_id": uuid.uuid4().hex}
        request = Request(self.base + "/api/rooms", data=json.dumps(payload).encode(),
                          headers={"Content-Type": "application/json", "X-Discussion-Token": owner})
        with urlopen(request, timeout=10) as response:
            room = json.loads(response.read())
        self.room = room["id"]
        owner_file = Path(self.directory.name) / f"{self.room}.owner.json"
        owner_file.write_text(json.dumps({"site": self.base, "room": self.room, "token": owner}), encoding="utf-8")
        access_files = {"用户": owner_file}
        for name, token in tokens.items():
            access = Path(self.directory.name) / f"{self.room}.{name}.json"
            access.write_text(json.dumps({"site": self.base, "room": self.room, "token": token}), encoding="utf-8")
            access_files[name] = access
        self.room_access[self.room] = access_files
        state = self.api_call(f"/api/rooms/{self.room}/discussion", token=owner)
        self.cli("run", "start", self.room, "--revision", state["revision"], "--goal", "CLI 讨论会话目标")
        self.session_room = self.room
        return self.room

    def api_call(self, path, payload=None, token=None):
        """Call one test-only endpoint with the selected room credential."""
        headers = {"Content-Type": "application/json"}
        if token:
            headers["X-Discussion-Token"] = token
        request = Request(self.base + path, data=json.dumps(payload).encode() if payload is not None else None,
                          headers=headers)
        with urlopen(request, timeout=10) as response:
            return json.loads(response.read())

    def test_limit_configuration_and_check_are_discoverable(self):
        """Typed options survive create/read/update and a non-triggered check."""
        room = self.cli("room", "create", "--title", "参数", "--as", "Codex",
                        "--submission-id", str(uuid.uuid4()), "--max-rounds", "3", "--max-minutes", "60",
                        "--execution-minutes", "10")
        self.assertEqual(room["limits"]["max_rounds"], 3)
        self.assertEqual(self.cli("room", "limits", room["id"])["max_minutes"], 60)

    def test_attachment_upload_recovery_files_only_message_and_verified_download(self):
        """Round-trip binary files with receipt recovery and no local overwrite."""
        source = Path(self.directory.name) / f"资料({uuid.uuid4().hex}).pdf"
        data = b"%PDF-1.7\n\x00\xff test bytes"
        source.write_bytes(data)
        upload_id = str(uuid.uuid4())
        args = ("attachment", "upload", self.room, "--as", "用户", "--file", source, "--submission-id", upload_id)
        preview = self.cli(*args, "--dry-run")
        self.assertEqual(preview["method"], "POST")
        self.assertEqual(self.cli("attachment", "list", self.room, "--submission-id", upload_id)["total"], 0)
        upload = self.cli(*args)
        attachment = upload["attachment"]
        self.assertTrue(self.cli(*args)["duplicate"])
        self.assertEqual(self.cli("attachment", "list", self.room)["total"], 0)
        self.assertEqual(self.cli("attachment", "view", self.room, attachment["id"])["file_name"], source.name)
        self.assertEqual(self.cli("attachment", "list", self.room, "--submission-id", upload_id)["attachments"][0]["id"], attachment["id"])
        message = self.cli("message", "post", self.room, "--as", "用户", "--attachment", attachment["id"],
                           "--submission-id", str(uuid.uuid4()))["message"]
        self.assertEqual(message["text"], "")
        self.assertEqual(self.cli("attachment", "list", self.room, "--message", message["id"])["total"], 1)
        destination = source.with_suffix(".download")
        self.cli("attachment", "download", self.room, attachment["id"], "--dest", destination, "--dry-run")
        self.assertFalse(destination.exists())
        saved = self.cli("attachment", "download", self.room, attachment["id"], "--dest", destination)
        self.assertEqual(saved["sha256"], attachment["sha256"])
        self.assertEqual(destination.read_bytes(), data)
        self.rejected(["attachment", "download", self.room, attachment["id"], "--dest", destination])
        self.assertEqual(destination.read_bytes(), data)

    def test_folder_creation_option_is_forwarded_in_one_request(self):
        """Expose folder placement in the CLI's documented creation payload."""
        result = self.cli("room", "create", "--title", "文件夹内", "--as", "Codex", "--folder-id", "folder-id",
                          "--submission-id", str(uuid.uuid4()), "--dry-run")
        self.assertEqual(result["body"]["folder_id"], "folder-id")

    def invoke(self, arguments, stdin=None, environment=None):
        """Run the actual entrypoint with UTF-8 streams and no inherited target."""
        env = {**os.environ, "DISCUSS_URL": "", "DISCUSS_ACCESS_FILE": "", "DISCUSS_ACCESS": "", **(environment or {})}
        return subprocess.run([sys.executable, str(ROOT / "runner" / "discuss.py"), *map(str, arguments)],
                              input=stdin, capture_output=True, text=True, encoding="utf-8",
                              env=env, timeout=10)

    def cli(self, *arguments, stdin=None):
        """Require a successful, clean machine-readable result."""
        arguments = self.credential_arguments(arguments, stdin)
        result = self.invoke(["--site", self.base, *arguments], stdin)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, "")
        payload = json.loads(result.stdout)
        self.assertTrue(payload["ok"])
        if isinstance(payload["data"], dict) and "owner_access_file" in payload["data"]:
            self.room_access[payload["data"]["id"]] = {"用户": payload["data"]["owner_access_file"], **payload["data"]["member_access_files"]}
        return payload["data"]

    def credential_arguments(self, arguments, stdin=None):
        """Use explicit per-room fixture files; never mask an explicitly supplied credential."""
        args = list(arguments)
        if "--access-file" in args or "--dry-run" in args:
            return args
        if args[:2] == ["room", "create"] and "--submission-id" in args:
            identifier = args[args.index("--submission-id") + 1]
            return [*args, "--access-file", Path(self.directory.name) / f"{identifier}.access.json"]
        room = str(args[2]) if len(args) > 2 else ""
        actor = args[args.index("--as") + 1] if "--as" in args else "用户"
        if args[0] == "api" and args[1].startswith("/api/rooms/"):
            room = args[1].split("/")[3]
            if stdin:
                body = json.loads(stdin)
                actor = body.get("actor", body.get("submitted_by", "用户"))
        access = self.room_access.get(room, {}).get(actor)
        return [*args, "--access-file", access] if access else args

    def rejected(self, arguments, code=2):
        """Require structured errors on stderr and no success data on stdout."""
        result = self.invoke(["--site", self.base, *self.credential_arguments(arguments)])
        self.assertEqual(result.returncode, code, result.stderr)
        self.assertEqual(result.stdout, "")
        payload = json.loads(result.stderr)
        self.assertFalse(payload["ok"])
        return payload["error"]

    def test_free_room_member_answers_through_its_execution(self):
        """A member credential file and execution id are enough; reposting without them is refused."""
        if self.external:
            self.skipTest("Free rooms exist only on the Python backend in P1")
        owner, member = uuid.uuid4().hex, uuid.uuid4().hex
        def call(path, payload, token):
            request = Request(self.base + path, data=json.dumps(payload).encode(),
                              headers={"Content-Type": "application/json", "X-Discussion-Token": token})
            with urlopen(request, timeout=10) as response:
                return json.loads(response.read())
        room = call("/api/rooms", {"title": "自由", "goal": "x", "mode": "free",
                                   "members": [{"name": "Claude", "token": member}]}, owner)
        call(f"/api/rooms/{room['id']}/messages", {"author": "用户", "text": "请处理", "submission_id": uuid.uuid4().hex}, owner)
        execution = call(f"/api/rooms/{room['id']}/executions",
                         {"member_id": room["free"]["members"][0]["id"], "client_id": uuid.uuid4().hex}, owner)
        access = Path(self.directory.name) / f"member-{uuid.uuid4().hex}.json"
        access.write_text(json.dumps({"site": self.base, "room": room["id"], "token": member}), encoding="utf-8")
        args = ["message", "post", room["id"], "--as", "Claude", "--kind", "chat", "--body", "已完成",
                "--access-file", access]
        missing_execution = self.rejected(args + ["--submission-id", str(uuid.uuid4())], code=1)
        self.assertIn("execution_id", str(missing_execution))
        saved = self.cli(*args, "--execution", execution["id"], "--submission-id", str(uuid.uuid4()))
        self.assertEqual(saved["message"]["kind"], "chat")
        self.rejected(args + ["--submission-id", str(uuid.uuid4())], code=1)
        self.rejected(args + ["--execution", execution["id"], "--submission-id", str(uuid.uuid4())], code=1)
        self.rejected(args + ["--execution", 1, "--request", 1, "--submission-id", str(uuid.uuid4())])
        preview = self.cli(*args, "--request", 3, "--request", 3, "--submission-id", str(uuid.uuid4()), "--dry-run")
        self.assertEqual(preview["body"]["request_ids"], [3])
        preview = self.cli(*args, "--execution", 4, "--to", "Codex", "--to", "Codex", "--submission-id", str(uuid.uuid4()), "--dry-run")
        self.assertEqual(preview["body"]["to"], ["Codex"])
        preview = self.cli("message", "post", room["id"], "--as", "Claude-评审", "--kind", "chat", "--body", "x", "--to", "Codex-2",
                           "--execution", 4, "--submission-id", str(uuid.uuid4()), "--dry-run")
        self.assertEqual((preview["body"]["author"], preview["body"]["to"]), ("Claude-评审", ["Codex-2"]))
        self.assertIn("平台名-后缀", str(self.rejected(["message", "post", room["id"], "--as", "Claudex", "--body", "x",
                                                    "--submission-id", str(uuid.uuid4()), "--dry-run"])))

    def test_manual_member_registers_through_the_cli_with_its_own_credential(self):
        """`member register` needs the member's credential file; automatic members are refused."""
        if self.external:
            self.skipTest("Free rooms exist only on the Python backend in P1")
        owner, manual, automatic = uuid.uuid4().hex, uuid.uuid4().hex, uuid.uuid4().hex
        def call(path, payload, token):
            request = Request(self.base + path, data=json.dumps(payload).encode(),
                              headers={"Content-Type": "application/json", "X-Discussion-Token": token})
            with urlopen(request, timeout=10) as response:
                return json.loads(response.read())
        room = call("/api/rooms", {"title": "注册", "goal": "x", "mode": "free",
                                   "members": [{"name": "Claude", "token": manual, "access": "manual"},
                                               {"name": "Codex", "token": automatic}]}, owner)
        def access_file(token):
            path = Path(self.directory.name) / f"member-{uuid.uuid4().hex}.json"
            path.write_text(json.dumps({"site": self.base, "room": room["id"], "token": token}), encoding="utf-8")
            return path
        self.rejected(["member", "register", room["id"]], code=2)
        registered = self.cli("member", "register", room["id"], "--as", "Claude", "--access-file", access_file(manual))
        self.assertEqual(registered["member"], "Claude")
        self.assertEqual(self.cli("member", "register", room["id"], "--access-file", access_file(manual))["registered_at"], registered["registered_at"])
        self.rejected(["member", "register", room["id"], "--access-file", access_file(automatic)], code=1)

    def test_message_post_reports_the_hosting_claude_session(self):
        """A Claude Code session's own ID rides along on posts so the local service can take a manual member over."""
        args = ["--site", self.base, "message", "post", self.room, "--as", "用户", "--body", "x", "--submission-id", str(uuid.uuid4()), "--dry-run"]
        plain = self.invoke(args, environment={"CLAUDE_CODE_SESSION_ID": "", "CODEX_THREAD_ID": ""})
        self.assertNotIn("session_id", json.loads(plain.stdout)["data"]["body"])
        reported = self.invoke(args, environment={"CLAUDE_CODE_SESSION_ID": "5f0d2c1e-1111-2222-3333-444455556666", "CODEX_THREAD_ID": ""})
        body = json.loads(reported.stdout)["data"]["body"]
        self.assertEqual((body["session_id"], body["session_client"]), ("5f0d2c1e-1111-2222-3333-444455556666", "claude"))
        codex = self.invoke(args, environment={"CLAUDE_CODE_SESSION_ID": "", "CODEX_THREAD_ID": "01a1694f-764d-7141-b2b8-47c433be027c"})
        self.assertEqual(json.loads(codex.stdout)["data"]["body"]["session_client"], "codex")

    def test_access_file_is_room_scoped_and_not_printed_in_preview(self):
        """A private capability is usable only for its configured site and room."""
        path = Path(self.directory.name) / "runtime-access.json"
        secret = json.loads(Path(self.room_access[self.room]["用户"]).read_text(encoding="utf-8"))["token"]
        path.write_text(json.dumps({"site": self.base, "room": self.room, "token": secret}), encoding="utf-8")
        current = self.cli("run", "view", self.room, "--access-file", path)
        preview = self.invoke(["--site", self.base, "run", "pause", self.room, "--revision", current["revision"],
                               "--access-file", path, "--dry-run"])
        self.assertEqual(preview.returncode, 0, preview.stderr)
        self.assertNotIn(secret, preview.stdout + preview.stderr)
        error = self.rejected(["run", "view", "other-room", "--access-file", path])
        self.assertIn("凭据文件不属于", str(error))
        path.write_text(json.dumps({"site": "http://localhost:1", "room": self.room, "token": secret}), encoding="utf-8")
        self.assertIn("凭据文件不属于", str(self.rejected(["run", "view", self.room, "--access-file", path])))

    def test_process_bound_access_file_preserves_explicit_override_and_room_scope(self):
        """A spawned CLI reads its current credential file without exposing or copying the token."""
        path = self.room_access[self.room]["用户"]
        text = Path(path).read_text(encoding="utf-8")
        env = {"DISCUSS_ACCESS_FILE": path, "DISCUSS_ACCESS": "{invalid"}
        posted = self.invoke(["message", "post", self.room, "--as", "用户", "--body", "环境绑定",
                              "--submission-id", str(uuid.uuid4())], environment=env)
        self.assertEqual(posted.returncode, 0, posted.stderr)
        self.assertEqual(json.loads(posted.stdout)["data"]["message"]["text"], "环境绑定")
        preview = self.invoke(["run", "pause", self.room, "--revision", "idle", "--dry-run"], environment=env)
        self.assertNotIn(json.loads(text)["token"], preview.stdout + preview.stderr)
        wrong_room = self.invoke(["run", "view", "other-room"], environment=env)
        self.assertNotEqual(wrong_room.returncode, 0)
        self.assertIn("凭据文件不属于", wrong_room.stderr)
        override = self.invoke(["room", "view", self.room, "--access-file", path],
                               environment={"DISCUSS_ACCESS_FILE": "missing-file"})
        self.assertEqual(override.returncode, 0, override.stderr)
        missing = self.invoke(["room", "view", self.room],
                              environment={"DISCUSS_ACCESS_FILE": "missing-file", "DISCUSS_ACCESS": text})
        self.assertNotEqual(missing.returncode, 0, "a broken binding must not fall back to a different credential")

    def test_access_text_in_environment_replaces_the_file_and_stays_room_scoped(self):
        """DISCUSS_ACCESS carries the same JSON as a file: it supplies the site, is hidden in previews and room-scoped."""
        secret = json.loads(Path(self.room_access[self.room]["用户"]).read_text(encoding="utf-8"))["token"]
        text = json.dumps({"site": self.base, "room": self.room, "token": secret})
        view = self.invoke(["run", "view", self.room], environment={"DISCUSS_ACCESS": text})
        self.assertEqual(view.returncode, 0, view.stderr)
        preview = self.invoke(["run", "pause", self.room, "--revision", "idle", "--dry-run"], environment={"DISCUSS_ACCESS": text})
        self.assertEqual(preview.returncode, 0, preview.stderr)
        self.assertNotIn(secret, preview.stdout + preview.stderr)
        other = self.invoke(["run", "view", "other-room"], environment={"DISCUSS_ACCESS": text})
        self.assertIn("凭据文件不属于", other.stderr)
        broken = self.invoke(["run", "view", self.room], environment={"DISCUSS_ACCESS": "{bad"})
        self.assertIn("DISCUSS_ACCESS", broken.stderr)

    def plan_speech(self, speaker="Codex", online=()):
        """Read the current roster and create a real session request for one member."""
        if self.session_room is None or set(online):
            self.create_discussion_room(online)
        roster = self.cli("turn", "roster", self.room)
        return self.cli("turn", "create", self.room, "--expert", speaker,
                        "--question", "测试安排", "--as", "Codex", "--roster", roster["revision"],
                        "--submission-id", str(uuid.uuid4()))["turn"]

    def reserve_execution(self, turn):
        """Reserve the scheduled member's live request with the room control credential."""
        room = self.api_call(f"/api/rooms/{self.room}", token=json.loads(
            Path(self.room_access[self.room]["用户"]).read_text(encoding="utf-8"))["token"])
        member = next(item for item in room["free"]["members"] if item["id"] == turn["member_id"])
        owner = json.loads(Path(self.room_access[self.room]["用户"]).read_text(encoding="utf-8"))["token"]
        execution = self.api_call(f"/api/rooms/{self.room}/executions", {
            "member_id": member["id"], "client_id": uuid.uuid4().hex}, owner)
        return execution["id"]

    def test_interjection_ask_cli_reads_roster_and_binds_original_request(self):
        """The host can convert one local follow-up without a scheduler or fabricated source ID."""
        self.create_discussion_room()
        self.cli("message", "post", self.room, "--as", "用户", "--body", "请补充依据", "--submission-id", str(uuid.uuid4()))
        roster = self.cli("turn", "roster", self.room)
        source = roster["host_requests"][0]
        args = ["turn", "ask", self.room, "--as", "Codex", "--request", source["id"], "--expert", "Gemini",
                "--roster", roster["revision"], "--submission-id", str(uuid.uuid4())]
        result = self.cli(*args)
        self.assertEqual((result["request"]["purpose"], result["request"]["message_id"]), ("ask", source["message_id"]))
        self.assertTrue(self.cli(*args)["duplicate"])

    def test_round_plan_from_stdin_relays_and_continue_needs_host_turn(self):
        """A plan file queues later experts; an answer relays without returning to the host."""
        self.create_discussion_room()
        plan = json.dumps([{"expert": name, "question": "先答" if name == "Codex" else "再答"}
                           for name in ("Codex", "Gemini", "Claude", "DeepSeek", "Qwen", "Grok")], ensure_ascii=False)
        roster = self.cli("turn", "roster", self.room)
        self.assertEqual(sorted(roster["waiting"]), ["Claude", "DeepSeek", "Gemini", "Grok", "Qwen"])
        created = self.cli("turn", "create", self.room, "--plan-file", "-", "--as", "Codex", "--roster", roster["revision"],
                           "--submission-id", str(uuid.uuid4()), stdin=plan)
        current = self.cli("turn", "current", self.room)
        self.assertEqual((current["current_turn"]["expert"], [item["expert"] for item in current["queued_turns"]]), ("Codex", ["Gemini", "Claude", "DeepSeek", "Qwen", "Grok"]))
        # The owner reads the speaking order, then moves Grok to the front of the queue against that revision.
        order = self.cli("turn", "order", self.room)
        self.assertEqual(order["movable"], ["Gemini", "Claude", "DeepSeek", "Qwen", "Grok"])
        self.assertEqual(self.rejected(["turn", "reorder", self.room, "--revision", "stale", *[part for name in order["movable"] for part in ("--member", name)]], 1)["http_status"], 409)
        moved = ["Grok", "Gemini", "Claude", "DeepSeek", "Qwen"]
        self.cli("turn", "reorder", self.room, "--revision", order["revision"], *[part for name in moved for part in ("--member", name)])
        self.assertEqual([item["expert"] for item in self.cli("turn", "current", self.room)["queued_turns"]], moved)
        self.assertEqual(self.rejected(["turn", "continue", self.room, "--as", "Codex", "--roster", "stale"], 1)["http_status"], 409)
        execution = self.reserve_execution(created["turn"])
        self.cli("message", "post", self.room, "--body", "回答", "--as", "Codex", "--execution", execution,
                 "--summary", "摘要", "--submission-id", str(uuid.uuid4()))
        current = self.cli("turn", "current", self.room)
        self.assertEqual((current["current_turn"]["expert"], [item["expert"] for item in current["queued_turns"]]),
                         ("Grok", ["Gemini", "Claude", "DeepSeek", "Qwen"]))
        self.rejected(["turn", "create", self.room, "--plan-file", "-", "--expert", "Codex", "--as", "Codex",
                       "--roster", "stale", "--submission-id", str(uuid.uuid4())])

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
        """A roster-bound plan opens one member request, answered with its execution."""
        self.create_discussion_room()
        roster = self.cli("turn", "roster", self.room)
        turn = self.cli("turn", "create", self.room, "--expert", "Codex", "--question", "如何验证？",
                        "--submission-id", "workflow-turn", "--as", "Codex", "--roster", roster["revision"])["turn"]
        self.assertEqual(self.cli("turn", "view", self.room, turn["id"])["status"], "open")
        execution = self.reserve_execution(turn)
        message = self.cli("message", "post", self.room, "--body", "原文依据", "--execution", execution,
                           "--submission-id", "workflow-answer", "--as", "Codex")["message"]
        current = self.cli("turn", "view", self.room, turn["id"])
        self.assertEqual(current["status"], "answered")
        self.cli("state", "set", self.room, "--body", f"结论依据 #{message['id']}",
                 "--until", message["id"], "--as", "Codex")
        current = self.cli("run", "view", self.room)
        self.cli("run", "stop", self.room, "--revision", current["revision"])
        self.assertIsNone(self.cli("run", "view", self.room)["session"])
        self.assertEqual(self.cli("room", "view", self.room)["phase"], "concluded")

    def test_resume_recovers_completed_action_and_preserves_citations(self):
        """Separate CLI processes recover a stale plan without duplicating its created turn."""
        pending = "下一步：创建 Codex 复核安排，未执行；争点：试用条件与上线标准，待当事人确认。"
        self.create_discussion_room()
        self.cli("state", "set", self.room, "--body", pending, "--until", 0, "--as", "Codex")
        roster = self.cli("turn", "roster", self.room)
        args = ["turn", "create", self.room, "--expert", "Codex", "--question", "请澄清原意及条件",
                "--submission-id", "recover-turn", "--as", "Codex", "--roster", roster["revision"]]
        turn = self.cli(*args)["turn"]
        self.assertEqual(self.cli("state", "view", self.room)["state_text"], pending)
        self.assertEqual(self.cli("turn", "current", self.room)["current_turn"]["id"], turn["id"])
        self.assertTrue(self.cli(*args)["duplicate"])
        self.assertEqual(len(self.cli("turn", "list", self.room)["turns"]), 1)
        original = "只建议试用，不代表上线验收。\n条件：小范围验证；反例：已有合规问答工具。[6]\n\n主持人从原回答提取的引用：\n[6] https://example.org/source#conditions\n未核验的 43% 仅为候选条件。"
        execution = self.reserve_execution(turn)
        answer = self.cli("message", "post", self.room, "--body", original, "--as", "Codex", "--execution", execution,
                          "--submission-id", "recover-answer")["message"]
        self.assertEqual(self.cli("message", "view", self.room, answer["id"])["text"], original)
        final_state = f"已处理 #{answer['id']}；试用与上线有别。43% 未核验；下一步待验证。任务清理待确认。"
        self.cli("state", "set", self.room, "--body", final_state, "--until", answer["id"], "--as", "Codex")
        current = self.cli("run", "view", self.room)
        self.cli("run", "stop", self.room, "--revision", current["revision"])
        self.rejected(["message", "post", self.room, "--kind", "receipt", "--body", "run=recover；task-1 已停止",
                       "--as", "Codex", "--submission-id", "recover-stop"])
        for view in (self.cli("room", "view", self.room), self.cli("state", "view", self.room)):
            self.assertNotIn("latest_receipts", view)
            self.assertEqual(view["state_until"], answer["id"])
        self.assertEqual(self.cli("state", "view", self.room)["state_text"], final_state)

    def test_message_retry_conflict_and_exact_original(self):
        """Same identifier replays, changed content conflicts, and reads remain exact."""
        turn = self.plan_speech()
        execution = self.reserve_execution(turn)
        args = ["message", "post", self.room, "--body", "@Gemini 成本 &= #1\n原文", "--as", "Codex",
                "--submission-id", "retry-original", "--execution", str(execution)]
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
        turn = self.plan_speech("Gemini")
        execution = self.reserve_execution(turn)
        answer = self.cli("message", "post", self.room, "--body", "完整正文\n必须保留条件与反例。",
                          "--summary-file", summary_file, "--summary-by", "Gemini", "--author", "Gemini",
                          "--submission-id", "summary-file", "--as", "Gemini", "--execution", execution)["message"]
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
        """Creating a plan is idempotent, cancellation is explicit, and the old phase write is rejected."""
        self.create_discussion_room()
        roster = self.cli("turn", "roster", self.room)
        args = ["turn", "create", self.room, "--expert", "Codex", "--question", "一次任务",
                "--submission-id", "retry-turn-001", "--as", "Codex", "--roster", roster["revision"]]
        turn = self.cli(*args)["turn"]
        self.assertTrue(self.cli(*args)["duplicate"])
        saved = self.cli("turn", "list", self.room, "--submission-id", "retry-turn-001")["turns"][0]
        self.assertEqual({key: saved[key] for key in turn}, turn)
        self.rejected(["room", "update", self.room, "--phase", "concluded", "--as", "Codex"], 1)
        self.cli("turn", "cancel", self.room, turn["id"], "--as", "用户")
        self.assertEqual(self.cli("turn", "list", self.room)["turns"][0]["status"], "cancelled")
        state = self.cli("run", "view", self.room)
        self.cli("run", "stop", self.room, "--revision", state["revision"])

    def test_forwarded_author_and_online_write_boundary(self):
        """Forwarding preserves the expert; online experts cannot submit as CLI selves."""
        self.create_discussion_room(online=("Claude",))
        self.rejected(["message", "post", self.room, "--body", "在线自行写入", "--as", "Claude",
                       "--submission-id", "online-reject"], 1)
        turn = self.plan_speech("Claude")
        forwarded = self.cli("message", "post", self.room, "--body", "真实取得的在线原文",
                             "--as", "用户", "--author", "Claude", "--request", turn["member_request_id"],
                             "--submission-id", "online-forward")["message"]
        self.assertEqual((forwarded["author"], forwarded["submitted_by"], forwarded["source"]),
                         ("Claude", "用户", "proxy"))
        note = self.cli("message", "post", self.room, "--body", "主持说明", "--kind", "moderation",
                        "--execution", 1, "--as", "Codex", "--submission-id", "moderator-note", "--dry-run")
        self.assertEqual((note["body"]["kind"], note["body"]["execution_id"]), ("moderation", 1))

    def test_pause_blocks_opinions_and_run_receipts_are_gone(self):
        """Paused sessions reject late answers; retired opinion and receipt writes are unavailable."""
        self.create_discussion_room()
        roster = self.cli("turn", "roster", self.room)
        state = self.cli("run", "view", self.room)
        self.cli("run", "pause", self.room, "--revision", state["revision"])
        self.rejected(["message", "post", self.room, "--body", "迟到回答", "--as", "Codex",
                       "--submission-id", "late-opinion"], 1)
        self.rejected(["turn", "create", self.room, "--expert", "Codex", "--question", "迟到安排",
                       "--as", "Codex", "--roster", roster["revision"], "--submission-id", "late-turn-01"], 1)
        self.rejected(["message", "post", self.room, "--body", "已核对退出结果", "--kind", "receipt",
                       "--as", "Codex", "--submission-id", "exit-receipt"])

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
        pagination_room = self.room
        for index in range(21):
            self.cli("message", "post", self.room, "--body", f"@Gemini 成本 &= {index}", "--as", "用户",
                     "--submission-id", f"pagination-{index:03}")
        first = self.cli("message", "list", self.room, "--query", "成本 &=", "--mention", "Gemini",
                         "--author", "用户")
        self.assertEqual((len(first["messages"]), first["total"], first["pages"]), (20, 21, 2))
        self.assertEqual(len(self.cli("message", "list", self.room, "--page", "2")["messages"]), 1)
        incremental = self.cli("message", "list", self.room, "--after", "0", "--kind", "chat")
        self.assertEqual(incremental["messages"], first["messages"])
        self.assertTrue(incremental["has_more"])
        self.create_discussion_room()
        owner_token = json.loads(Path(self.room_access[self.room]["用户"]).read_text(encoding="utf-8"))["token"]
        room = self.api_call(f"/api/rooms/{self.room}", token=owner_token)
        host = next(item for item in room["free"]["members"] if item["name"] == "Codex")
        execution = self.api_call(f"/api/rooms/{self.room}/executions", {
            "member_id": host["id"], "client_id": uuid.uuid4().hex}, owner_token)
        note = self.cli("message", "post", self.room, "--body", "主持记录", "--kind", "moderation",
                        "--execution", execution["id"], "--as", "Codex", "--submission-id", "paging-moderation")["message"]
        discussion_room = self.room
        self.assertEqual(self.cli("message", "list", discussion_room, "--kind", "moderation")["messages"], [note])
        self.room = pagination_room
        latest = self.cli("message", "post", self.room, "--body", "新到观点", "--as", "用户",
                          "--submission-id", "paging-new-opinion")["message"]
        following = self.cli("message", "list", self.room, "--after", incremental["next_after"], "--kind", "chat")
        self.assertEqual([row["text"] for row in following["messages"]], ["@Gemini 成本 &= 20", "新到观点"])
        self.assertEqual(following["next_after"], latest["id"])
        self.assertFalse(following["has_more"])
        empty = self.cli("message", "list", self.room, "--after", latest["id"])
        self.assertEqual((empty["messages"], empty["next_after"], empty["has_more"]), ([], latest["id"], False))
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

    def test_access_file_supplies_its_own_site(self):
        """A delivered task's access file is enough to reach its site, so the AI need not guess --site."""
        access = self.room_access[self.room]["用户"]
        result = self.invoke(["room", "view", self.room, "--access-file", access])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["meta"]["site"], self.base)

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
        self.assertEqual(self.rejected(["room", "update", self.room, "--experts-file", experts, "--focus", "新焦点", "--as", "Codex"], 1)["http_status"], 400)
        self.cli("room", "update", self.room, "--focus", "新焦点", "--as", "用户")
        self.assertEqual(self.cli("room", "view", self.room)["focus"], "新焦点")
        self.assertEqual(self.cli("room", "brief", self.room)["background"], "按需背景正文")

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
        arguments = ["room", "create", "--title", "首次建房", "--as", "Codex", "--submission-id", identifier,
                     "--access-file", str(Path(self.directory.name) / f"{identifier}.access.json")]
        parser, registry = discuss.build_parser()
        args = parser.parse_args(["--site", self.base, *arguments])
        original_send = discuss.send_request

        def lose_acknowledgement(plan, url, timeout, headers=None):
            original_send(plan, url, timeout, headers)
            raise discuss.CliError("响应丢失", 3, outcome="unknown")

        with patch.object(discuss, "send_request", side_effect=lose_acknowledgement) as sender:
            with self.assertRaises(discuss.CliError) as failure:
                discuss.run(args, registry)
        sender.assert_called_once()
        self.assertEqual(failure.exception.details["submission_id"], identifier)
        found = self.cli("room", "list", "--submission-id", identifier)["rooms"]
        self.assertEqual(len(found), 1)
        room = found[0]["id"]
        # Retry confirms the room and materializes member files before normal member operations.
        self.cli(*arguments)
        self.cli("room", "update", room, "--title", "后来修改", "--as", "Codex")
        replay = self.cli(*arguments)
        self.assertEqual((replay["id"], replay["title"], replay["duplicate"]),
                         (room, "后来修改", True))
        self.assertEqual(self.rejected([*arguments, "--goal", "不同建房请求"], 1)["http_status"], 409)
        self.assertEqual(self.cli("room", "list", "--submission-id", "unknown-room-request")["rooms"], [])

    def test_complete_long_answer_is_preserved_and_finishes_only_once(self):
        """Unicode length, not UTF-16 units, bounds one complete forwarded answer."""
        self.create_discussion_room()
        roster = self.cli("turn", "roster", self.room)
        turn = self.cli("turn", "create", self.room, "--expert", "Gemini", "--question", "完整论证",
                        "--submission-id", "long-answer-turn", "--as", "Codex", "--roster", roster["revision"])["turn"]
        execution = self.reserve_execution(turn)
        arguments = ["message", "post", self.room, "--body-file", "-", "--author", "Gemini", "--as", "Gemini",
                     "--execution", str(execution), "--submission-id", "long-answer-message"]
        oversized = self.invoke(["--site", self.base, *arguments], stdin="🙂" * 32001)
        self.assertEqual(oversized.returncode, 2)
        self.assertEqual(self.cli("turn", "view", self.room, turn["id"])["status"], "open")
        original = "🙂" * 32000
        message = self.cli(*arguments, stdin=original)["message"]
        self.assertEqual(self.cli("message", "view", self.room, message["id"])["text"], original)
        self.assertTrue(self.cli(*arguments, stdin=original)["duplicate"])
        self.assertEqual(self.cli("room", "view", self.room)["message_count"], 1)
        self.assertEqual(self.cli("turn", "view", self.room, turn["id"])["status"], "answered")


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
        args, _ = self.parse(["message", "group-plan", "room", "12"])
        plan = discuss.plan_message(args)
        self.assertEqual(plan.path, "/api/rooms/room/recommendations/12")
        args, _ = self.parse(["state", "decision", "room", "15"])
        self.assertEqual(discuss.plan_state(args).path, "/api/rooms/room/scheduler-decisions/15")
        args, _ = self.parse(["review", "roster", "room"])
        self.assertEqual(discuss.plan_review(args).path, "/api/rooms/room/reviews/roster")
        args, _ = self.parse(["message", "post", "room", "--as", "Claude", "--body", "实现", "--submission-id", "review-test-123",
                              "--to", "Gemini", "--next-review", "Codex", "--review-scope", "功能", "--review-roster", "revision"])
        plan = discuss.plan_message(args)
        self.assertEqual((plan.body["next_review"], plan.body["review_scope"], plan.body["review_roster"]), ("Codex", "功能", "revision"))
        args, _ = self.parse(["member", "review-capability", "room", "7"])
        self.assertEqual(discuss.plan_member(args).path, "/api/rooms/room/members/7/review-capability")

    def test_dry_run_never_requests_even_for_unknown_rooms(self):
        """Previews are entirely offline and make no claim of server validation."""
        args, registry = self.parse(["message", "post", "unknown", "--as", "Codex", "--body", "预览",
                                     "--submission-id", "preview-001", "--site", "https://example.org", "--dry-run"])
        with patch.object(discuss, "build_opener") as opener:
            result = discuss.run(args, registry)
        opener.assert_not_called()
        self.assertTrue(result["meta"]["dry_run"])
        self.assertEqual(result["data"]["body"]["submission_id"], "preview-001")

    def test_unlimited_session_preview_preserves_zero_without_network(self):
        """The CLI passes an unlimited duration in a revision-bound session start."""
        args, registry = self.parse(["run", "start", "unknown", "--revision", "r0", "--goal", "不限时",
                                     "--max-minutes", "0", "--site", "https://example.org", "--dry-run"])
        with patch.object(discuss, "build_opener") as opener:
            result = discuss.run(args, registry)
        opener.assert_not_called()
        self.assertEqual(result["data"]["body"]["limits"]["max_minutes"], 0)

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

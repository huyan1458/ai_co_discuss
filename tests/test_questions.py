"""Questions to the owner (backend/questions.py, spec #3329 + #3332): atomic create, recovery, answers, relay gates."""

import json
import unittest
import uuid
from unittest import mock
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from tests import test_free_room as base


class QuestionTests(base.HostRoomTests):
    """Claude hosts; Codex and Antigravity work and ask."""

    def ask(self, name, execution_id, submission_id=None, **extra):
        """Post one question group bound to an execution, with a one-item default."""
        payload = {"actor": name, "execution_id": execution_id, "submission_id": submission_id or uuid.uuid4().hex,
                   "contract": "handoff", "blocking": True, "explanation": "已完成 A/B/C 三个候选。\n\n## A\n甲\n\n## B\n乙",
                   "questions": [{"id": "pick", "prompt": "选哪一个？", "options": [{"id": "A", "label": "甲", "anchor": "A"},
                                                                                   {"id": "B", "label": "乙", "anchor": "B"}]}], **extra}
        return self.request(f"{self.path}/questions", payload, self.tokens[name])

    def answer_question(self, question_id, version, token=None, **extra):
        """The owner answers one question with a fresh submission id."""
        payload = {"version": version, "submission_id": uuid.uuid4().hex, **extra}
        return self.request(f"{self.path}/questions/{question_id}/answer", payload, token or self.owner)

    def pending_of(self, name):
        """A member's pending requests as the runner's inbox shows them."""
        return next(item for item in self.request(f"{self.path}/inbox", token=self.owner)[1]["members"] if item["name"] == name)["pending"]

    def gated_relay(self):
        """Antigravity then Codex, with a user gate after Codex that reruns from Antigravity."""
        self.request(f"{self.path}/budget", {"max_rounds": 6}, self.owner)
        self.say("跑团")
        self.work("Claude", to=["Antigravity", "Codex"], sequential=True, gates=[{"after": "Codex", "repeat_from": "Antigravity", "user": True}])
        self.work("Antigravity")
        return self.reserve_for("Codex")[1]["id"]

    def test_a_relay_gate_moves_only_on_its_answer_and_counts_one_pass(self):
        execution = self.gated_relay()
        status, receipt = self.ask("Codex", execution)
        self.assertEqual(status, 201, receipt)
        self.assertEqual((receipt["request_completed"], receipt["execution_completed"], receipt["task_waiting"]), (True, True, True))
        self.assertEqual((receipt["gate"]["sequence_id"] > 0, receipt["gate"]["after"]), (True, 2), receipt)
        self.assertIn("note", receipt, "a handoff receipt says the request is closed")
        self.assertNotIn(("Claude", "handoff", "pending"), self.requests(), "a user gate hands nothing back to the host")
        # Plain chat does not move the gate: it goes to the host as usual.
        self.request(f"{self.path}/messages", {"author": "用户", "text": "我不确定，你们讨论下", "submission_id": uuid.uuid4().hex}, self.owner)
        self.assertEqual(self.requests()[-1], ("Claude", "route", "pending"))
        self.assertEqual(self.request(self.path)[1]["speaking_order"]["sequence"]["pass"], 1)
        question = self.request(f"{self.path}/questions/{receipt['question_id']}", token=self.owner)[1]
        self.assertEqual(self.request(f"{self.path}/questions/{question['id']}/answer", {"submission_id": uuid.uuid4().hex, "choices": {"pick": ["B"]}},
                                      self.owner)[0], 400, "an answer must carry the version it read")
        self.assertEqual(self.answer_question(question["id"], 9, choices={"pick": ["B"]})[0], 409)
        self.assertEqual(self.answer_question(question["id"], 1, choices={"pick": ["A", "B"]})[0], 400, "single choice")
        submission = uuid.uuid4().hex
        status, result = self.request(f"{self.path}/questions/{question['id']}/answer",
                                      {"version": 1, "submission_id": submission, "choices": {"pick": ["B"]}, "text": "就它"}, self.owner)
        self.assertEqual(status, 201, result)
        self.assertEqual(self.request(self.path)[1]["speaking_order"]["sequence"]["pass"], 2, "repeat_from starts the next pass")
        step = next(item for item in self.pending_of("Antigravity") if item["purpose"] == "ask")
        self.assertEqual(step["message_id"], result["message_id"], "the next step reads the owner's answer")
        self.assertEqual(step["sequence"]["previous"]["kind"], "user", "the step can tell the user spoke before it")
        self.assertEqual(self.request(f"{self.path}/sequences/{step['sequence']['id']}", token=self.gemini)[0], 200, "members read the relay")
        self.assertEqual(step["question"]["user_decision"], {"action": "answer", "choices": {"pick": ["B"]}, "answers": [{"id": "pick", "selected": ["B"]}],
                                                             "text": "就它", "by": "用户", "version": 1})
        again = self.request(f"{self.path}/questions/{question['id']}/answer",
                             {"version": 1, "submission_id": submission, "choices": {"pick": ["B"]}, "text": "就它"}, self.owner)
        self.assertEqual((again[0], again[1]["duplicate"]), (200, True))
        self.assertEqual(self.request(self.path)[1]["speaking_order"]["sequence"]["pass"], 2, "a retried answer adds no pass")
        self.assertEqual(self.answer_question(question["id"], 1, choices={"pick": ["A"]})[0], 409, "answered once")

    def test_an_answer_with_nobody_left_for_the_next_step_goes_to_the_host(self):
        """The relay stops, and the present host is told with the answer, when no member can take the next step (P5, REVIEW M5)."""
        execution = self.gated_relay()
        receipt = self.ask("Codex", execution)[1]
        self.request(f"{self.path}/members/{self.member_id('Antigravity')}", {"action": "away"}, self.owner)
        self.request(f"{self.path}/members/{self.member_id('Codex')}", {"action": "away"}, self.owner)
        status, answered = self.answer_question(receipt["question_id"], 1, choices={"pick": ["A"]})
        self.assertEqual(status, 201, answered)
        notices = [item for item in self.pending_of("Claude") if item["purpose"] == "notice"]
        self.assertEqual(len(notices), 1, "the host is told once")
        notice = self.request(f"{self.path}/messages/{notices[0]['message_id']}")[1]["text"]
        self.assertIn(f"#{answered['message_id']}", notice, "with the answer's message number")

    def test_create_is_atomic_and_recoverable_by_submission_id(self):
        execution = self.gated_relay()
        before = len(self.request(f"{self.path}/messages?after=0")[1]["messages"])
        submission = uuid.uuid4().hex
        with mock.patch("backend.questions.receipt", side_effect=RuntimeError("boom")):
            status, _ = self.ask("Codex", execution, submission)
        self.assertEqual(status, 500)
        self.assertEqual(len(self.request(f"{self.path}/messages?after=0")[1]["messages"]), before, "the explanation rolled back")
        self.assertEqual(self.request(f"{self.path}/questions?submission_id={submission}", token=self.codex)[1]["questions"], [])
        self.assertIn(("Codex", "ask", "delivering"), self.requests(), "the request is still open")
        status, first = self.ask("Codex", execution, submission)
        self.assertEqual(status, 201, first)
        status, second = self.ask("Codex", execution, submission)
        self.assertEqual((status, second["duplicate"], second["question_id"], second["message_id"]),
                         (200, True, first["question_id"], first["message_id"]), "the same submission returns the same question")
        self.assertEqual(self.ask("Codex", execution, submission, explanation="别的")[0], 409)
        found = self.request(f"{self.path}/questions?submission_id={submission}", token=self.codex)[1]
        self.assertEqual([item["id"] for item in found["questions"]], [first["question_id"]])
        self.assertEqual(found["last_ask"]["question_id"], first["question_id"])

    def test_a_cited_message_must_be_readable_and_a_failed_create_leaves_it(self):
        execution = self.gated_relay()
        self.assertEqual(self.ask("Codex", execution, refs=[999999])[0], 404)
        self.assertIn(("Codex", "ask", "delivering"), self.requests())
        first = self.request(f"{self.path}/messages?after=0")[1]["messages"][0]["id"]
        self.assertEqual(self.ask("Codex", execution, refs=[first])[0], 201)

    def test_questions_take_deepseek_harness_shapes(self):
        """Items as DeepSeek Harness writes them: question/header/detail/multiSelect, options by label with a
        "(Recommended)" suffix and no id; answers as [{id, selected, custom}] (docs: DSH提问工具对照.md)."""
        self.say("帮我挑方案", to=["Codex"])
        status, receipt = self.ask("Codex", self.reserve_for("Codex")[1]["id"], questions=[
            {"id": "tone", "question": "用哪种基调？", "header": "基调", "detail": "影响开场三段",
             "options": [{"label": "温情"}, {"label": "悬疑 (Recommended)", "description": "节奏最快"}]},
            {"id": "extras", "question": "加哪些元素？", "multiSelect": True, "options": [{"label": "配乐"}, {"label": "地图"}]}])
        self.assertEqual(status, 201, receipt)
        items = self.request(f"{self.path}/questions/{receipt['question_id']}", token=self.owner)[1]["questions"]
        self.assertEqual(items[0]["options"][0], {"id": "B", "label": "悬疑", "description": "节奏最快", "recommended": True},
                         "the suffix becomes a flag, the recommended option comes first, ids follow position")
        self.assertEqual((items[0]["header"], items[0]["detail"], items[1]["multiSelect"]), ("基调", "影响开场三段", True))
        bad = self.answer_question(receipt["question_id"], 1, answers=[{"id": "tone", "selected": ["悬疑"], "custom": "都不要"}])
        self.assertEqual(bad[0], 400, "a single-choice question takes a choice or a free answer, not both")
        status, answered = self.answer_question(receipt["question_id"], 1, answers=[
            {"id": "tone", "selected": [], "custom": "轻喜剧"}, {"id": "extras", "selected": ["配乐", "B"]}])
        self.assertEqual(status, 201, answered)
        back = next(item for item in self.pending_of("Codex") if item["message_id"] == answered["message_id"])
        self.assertEqual(back["question"]["user_decision"]["answers"],
                         [{"id": "tone", "selected": [], "custom": "轻喜剧"}, {"id": "extras", "selected": ["A", "B"]}])
        self.assertIn("轻喜剧", self.request(f"{self.path}/messages/{answered['message_id']}")[1]["text"])

    def test_contract_must_match_blocking(self):
        execution = self.gated_relay()
        self.assertEqual(self.ask("Codex", execution, contract="supplement")[0], 400)
        self.assertEqual(self.ask("Codex", execution, contract="nope", blocking=False)[0], 400)

    def ask_owner_question(self):
        """Codex asks a blocking question on the owner's direct request; returns the receipt."""
        self.say("帮我挑方案", to=["Codex"])
        status, receipt = self.ask("Codex", self.reserve_for("Codex")[1]["id"])
        self.assertEqual(status, 201, receipt)
        self.assertEqual(receipt["gate"], None)
        return receipt

    def test_a_recommendation_makes_a_new_version_the_owner_confirms(self):
        receipt = self.ask_owner_question()
        status, asked = self.answer_question(receipt["question_id"], 1, action="recommend")
        self.assertEqual(status, 201, asked)
        host = next(item for item in self.pending_of("Claude") if item["message_id"] == asked["message_id"])
        self.assertEqual(host["question"]["task"], "recommend")
        execution = self.reserve_for("Claude")[1]["id"]
        url = f"{self.path}/questions/{receipt['question_id']}/recommend"
        payload = {"actor": "Claude", "execution_id": execution, "version": 1, "submission_id": uuid.uuid4().hex,
                   "choices": {"pick": ["A"]}, "text": "推荐 A：改动最小"}
        status, recommended = self.request(url, payload, self.member)
        self.assertEqual((status, recommended["question"]["version"], recommended["question"]["status"]), (201, 2, "waiting_user"), recommended)
        self.assertEqual(self.request(url, payload, self.member)[1]["duplicate"], True)
        self.assertEqual(self.answer_question(receipt["question_id"], 1, choices={"pick": ["A"]})[0], 409, "the old version is stale")
        status, answered = self.answer_question(receipt["question_id"], 2, choices={"pick": ["A"]})
        self.assertEqual(status, 201, answered)
        back = next(item for item in self.pending_of("Codex") if item["message_id"] == answered["message_id"])
        self.assertEqual(back["question"]["user_decision"]["version"], 2)

    def test_a_delegated_question_is_answered_by_the_hosts_decision(self):
        receipt = self.ask_owner_question()
        self.answer_question(receipt["question_id"], 1, action="delegate", text="你定，别超预算")
        execution = self.reserve_for("Claude")[1]["id"]
        status, decided = self.request(f"{self.path}/questions/{receipt['question_id']}/decide",
                                       {"actor": "Claude", "execution_id": execution, "version": 1, "submission_id": uuid.uuid4().hex,
                                        "choices": {"pick": ["B"]}, "text": "选 B"}, self.member)
        self.assertEqual((status, decided["question"]["status"]), (201, "answered"), decided)
        back = next(item for item in self.pending_of("Codex") if item["message_id"] == decided["message_id"])
        self.assertEqual((back["question"]["user_decision"]["action"], back["question"]["user_decision"]["delegation"]), ("decided", "你定，别超预算"))

    def test_an_old_gate_without_a_question_asks_the_host_once_to_bind_one(self):
        execution = self.gated_relay()
        self.request(f"{self.path}/messages", {"author": "Codex", "text": "候选 A/B", "source": "cli",
                                               "submission_id": uuid.uuid4().hex, "execution_id": execution}, self.codex)
        notices = [item for item in self.pending_of("Claude") if item["purpose"] == "notice"]
        self.assertEqual(len(notices), 1)
        needed = notices[0]["question_needed"]
        self.request(f"{self.path}/messages", {"author": "用户", "text": "选 A", "submission_id": uuid.uuid4().hex}, self.owner)
        self.assertEqual(self.request(self.path)[1]["speaking_order"]["sequence"]["pass"], 1, "chat does not move the gate")
        self.assertEqual(len([item for item in self.pending_of("Claude") if item["purpose"] == "notice"]), 1, "asked once per gate")
        host_execution = self.reserve_for("Claude")[1]["id"]
        self.assertEqual(self.ask("Claude", host_execution, gate={"sequence_id": needed["sequence_id"], "revision": "stale"})[0], 409)
        submission = uuid.uuid4().hex
        status, bound = self.ask("Claude", host_execution, submission, gate={"sequence_id": needed["sequence_id"], "revision": needed["revision"]})
        self.assertEqual(status, 201, bound)
        self.assertEqual(bound["gate"]["sequence_id"], needed["sequence_id"])
        again = self.ask("Claude", host_execution, submission, gate={"sequence_id": needed["sequence_id"], "revision": needed["revision"]})
        self.assertEqual((again[0], again[1]["question_id"]), (200, bound["question_id"]))
        self.assertEqual(self.answer_question(bound["question_id"], 1, choices={"pick": ["A"]})[0], 201)
        self.assertEqual(self.request(self.path)[1]["speaking_order"]["sequence"]["pass"], 2)

    def test_a_refused_late_answer_still_closes_the_question(self):
        """An expired question, or one whose explanation was withdrawn, ends for good when an answer is refused (REVIEW H2)."""
        self.say("帮我挑方案", to=["Codex"])
        expired = self.ask("Codex", self.reserve_for("Codex")[1]["id"], expires_at=1)[1]
        self.assertEqual(self.answer_question(expired["question_id"], 1, choices={"pick": ["A"]})[0], 409)
        self.assertEqual(self.request(f"{self.path}/questions/{expired['question_id']}", token=self.owner)[1]["status"], "expired")
        self.assertEqual(self.request(f"{self.path}/questions", token=self.owner)[1]["questions"], [], "it no longer blocks the queue")
        gated = self.ask("Codex", self.gated_relay())[1]
        relay = self.request(self.path)[1]["speaking_order"]["message_id"]
        self.assertEqual(self.request(f"{self.path}/dispatches/{relay}/withdraw", {}, self.owner)[0], 200, "the relay is withdrawn")
        self.assertEqual(self.answer_question(gated["question_id"], 1, choices={"pick": ["A"]})[0], 409)
        self.assertEqual(self.request(f"{self.path}/questions/{gated['question_id']}", token=self.owner)[1]["status"], "cancelled")

    def test_a_late_answer_after_stop_restarts_nothing(self):
        execution = self.gated_relay()
        receipt = self.ask("Codex", execution)[1]
        self.assertEqual(self.request(f"{self.path}/stop", {}, self.owner)[0], 200)
        self.assertEqual(self.answer_question(receipt["question_id"], 1, choices={"pick": ["A"]})[0], 409)
        self.assertNotIn(("Antigravity", "ask", "pending"), self.requests())

    def test_a_supplement_keeps_the_execution_and_the_answer_comes_back_later(self):
        self.say("帮我挑方案", to=["Codex"])
        execution = self.reserve_for("Codex")[1]["id"]
        status, receipt = self.ask("Codex", execution, contract="supplement", blocking=False)
        self.assertEqual((status, receipt["request_completed"], receipt["execution_completed"], receipt["task_waiting"]),
                         (201, False, False, False), receipt)
        self.assertIn(("Codex", "ask", "delivering"), self.requests())
        status, answered = self.answer_question(receipt["question_id"], 1, choices={"pick": ["A"]})
        self.assertEqual(status, 201, answered)
        self.assertEqual(self.requests()[-1], ("Codex", "ask", "pending"), "queued behind the running execution")

    def test_a_goal_waiting_only_on_a_question_does_not_idle_wake_the_host(self):
        receipt = self.ask_owner_question()
        status, view = self.request(f"{self.path}/goal", {"action": "start", "objective": "挑完方案",
                                                          "revision": self.request(f"{self.path}/goal")[1]["revision"]}, self.owner)
        self.assertEqual(status, 200, view)
        for _ in range(3):
            pending = [item for item in self.requests() if item[2] in ("pending", "delivering")]
            if not pending:
                break
            self.work(pending[0][0])
        goal = self.request(f"{self.path}/goal")[1]["goal"]
        self.assertEqual((goal["idle"], goal["waiting_questions"]), (False, [receipt["question_id"]]))

    def test_the_room_view_lists_open_questions_in_order(self):
        first = self.ask_owner_question()
        self.say("再来一个", to=["Antigravity"])
        second = self.ask("Antigravity", self.reserve_for("Antigravity")[1]["id"])[1]
        listed = self.request(f"{self.path}/questions", token=self.owner)[1]
        self.assertEqual([item["id"] for item in listed["questions"]], [first["question_id"], second["question_id"]])
        self.assertEqual(listed["current"], first["question_id"])
        self.assertEqual([item["id"] for item in self.request(self.path)[1]["free"]["questions"]], [first["question_id"], second["question_id"]])
        self.request(f"{self.path}/questions/{first['question_id']}/cancel", {"version": 1}, self.owner)
        self.assertEqual(self.request(f"{self.path}/questions", token=self.owner)[1]["current"], second["question_id"])


class InterventionSourceTests(base.HostRoomTests):
    """What the host does to a member through host-control is labelled as the host's, not the owner's (应 14)."""

    def as_host(self, path, payload, acting=True):
        """Write with the owner's credential the way `launch host-control` does: the User-Agent names the host, and the
        host's own credential (unless `acting` is False) proves it."""
        headers = {"Content-Type": "application/json", "X-Discussion-Token": self.owner, "User-Agent": "AI-CoDiscuss-host:Claude"}
        if acting:
            headers["X-Acting-Member-Token"] = self.member
        request = Request(self.base + path, data=json.dumps(payload).encode(), headers=headers)
        try:
            with urlopen(request, timeout=10) as response:
                return response.status, json.loads(response.read())
        except HTTPError as error:
            return error.code, json.loads(error.read())

    def test_host_interjection_and_interrupt_name_the_host(self):
        self.say("查一下", to=["Codex"])
        execution = self.reserve_for("Codex")[1]["id"]
        url = f"{self.path}/executions/{execution}"
        self.request(url, {"action": "delivery", "stoppable": True, "progress": True, "steer": True, "resume": False}, self.owner)
        self.assertEqual(self.as_host(url, {"action": "interject", "text": "顺便看下日志", "submission_id": uuid.uuid4().hex})[0], 200)
        self.request(url, {"action": "interject", "text": "我也补一句", "submission_id": uuid.uuid4().hex}, self.owner)
        self.as_host(url, {"action": "interject", "text": "只写请求头", "submission_id": uuid.uuid4().hex}, acting=False)
        self.assertEqual(self.request(f"{self.path}/labels", {"labels": {"Claude": "主持小克"}}, self.owner)[0], 200)
        self.as_host(url, {"action": "interject", "text": "改名之后", "submission_id": uuid.uuid4().hex})
        live = next(item for item in self.request(f"{self.path}/inbox", token=self.owner)[1]["executions"] if item["id"] == execution)
        self.assertEqual([(item["text"], item["author"]) for item in live["interjections"]],
                         [("顺便看下日志", "Claude"), ("我也补一句", ""), ("只写请求头", ""), ("改名之后", "主持小克")],
                         "the host's credential, not the User-Agent, labels it, by the name the room shows")
        self.assertEqual(self.as_host(f"{self.path}/members/{self.member_id('Codex')}/interrupt", {})[0], 200)
        stopped = self.request(url, token=self.owner)[1]
        self.assertEqual(stopped["result"], "主持人 主持小克 打断")


class QueuedRequestTests(base.HostRoomTests):
    """A request that queues while its member works is listed on the execution and may be delivered by the same answer (应 2)."""

    pending_of = QuestionTests.pending_of

    def test_one_answer_closes_the_related_queued_request(self):
        self.say("先列清单", to=["Codex"])
        execution = self.reserve_for("Codex")[1]["id"]
        self.say("再补一条引用", to=["Codex"])
        detail = self.request(f"{self.path}/executions/{execution}", token=self.codex)[1]
        queued = [item["id"] for item in detail["queued_requests"]]
        self.assertEqual(len(queued), 1, detail.get("queued_requests"))
        bad = self.request(f"{self.path}/messages", {"author": "Codex", "text": "都好了", "source": "cli", "submission_id": uuid.uuid4().hex,
                                                     "execution_id": execution, "also_request_ids": [queued[0] + 999]}, self.codex)
        self.assertEqual(bad[0], 409, "a request that is not the member's queued one refuses the whole answer")
        status, saved = self.request(f"{self.path}/messages", {"author": "Codex", "text": "都好了", "source": "cli", "submission_id": uuid.uuid4().hex,
                                                               "execution_id": execution, "also_request_ids": queued}, self.codex)
        self.assertEqual(status, 201, saved)
        self.assertEqual(len(saved["receipt"]["request_ids"]), 2, "the receipt lists both closed requests")
        self.assertNotIn(("Codex", "ask", "pending"), self.requests(), "nothing left to wake Codex again")

    def test_relay_steps_and_proactive_posts_cannot_close_queued_requests(self):
        """Only the member's own independent requests may be closed this way; a relay step is not one (REVIEW L3)."""
        self.say("先列清单", to=["Codex"])
        execution = self.reserve_for("Codex")[1]["id"]
        self.say("接力", to=["Claude"])
        self.work("Claude", to=["Codex", "Antigravity"], sequential=True)
        step = next(item for item in self.pending_of("Codex") if item["purpose"] == "ask")
        detail = self.request(f"{self.path}/executions/{execution}", token=self.codex)[1]
        self.assertEqual(detail["queued_requests"], [], "a relay step is not offered")
        refused = self.request(f"{self.path}/messages", {"author": "Codex", "text": "顺便做了", "source": "cli", "submission_id": uuid.uuid4().hex,
                                                         "execution_id": execution, "also_request_ids": [step["id"]]}, self.codex)
        self.assertEqual(refused[0], 409, refused)
        proactive = self.request(f"{self.path}/messages", {"author": "Codex", "text": "主动说一句", "source": "cli", "submission_id": uuid.uuid4().hex,
                                                           "proactive": True, "also_request_ids": [step["id"]]}, self.codex)
        self.assertEqual(proactive[0], 409, "with a live execution the answer goes through it, not a proactive post")


class OneExitTests(base.HostRoomTests):
    """A member that is not the host reads each budget fact once (可 1)."""

    def test_a_member_reads_limits_reached_and_chain_rounds_only(self):
        member = self.request(self.path, token=self.codex)[1]
        self.assertEqual(set(member["limits"]), {"reached", "stop_reason"})
        self.assertNotIn("max_rounds", member["free"])
        self.assertIn("chain_rounds", member["free"])
        host = self.request(self.path, token=self.member)[1]
        self.assertIn("max_rounds", host["limits"])
        self.assertIn("max_rounds", host["free"])


class RelayHandoverTests(base.HostRoomTests):
    """A loop's next pass carries the host's note and points at what the pass before said (应 13)."""

    def test_continue_with_a_note_and_the_previous_pass(self):
        self.request(f"{self.path}/budget", {"max_rounds": 6}, self.owner)
        self.say("写审循环")
        self.work("Claude", to=["Antigravity", "Codex"], sequential=True, loop=True)
        self.work("Antigravity")
        self.work("Codex")
        host = next(item for item in self.request(f"{self.path}/inbox", token=self.owner)[1]["members"] if item["name"] == "Claude")
        checkpoint = next(item for item in host["pending"] if item["purpose"] == "handoff")
        url = f"{self.path}/sequences/continue"
        self.assertEqual(self.request(url, {"actor": "Claude", "request_id": checkpoint["id"], "note": ""}, self.member)[0], 400)
        status, result = self.request(url, {"actor": "Claude", "request_id": checkpoint["id"], "note": "豁免卡片第 1 条，全文写进回答"}, self.member)
        self.assertEqual((status, result["pass"]), (200, 2), result)
        step = next(item for item in self.request(f"{self.path}/inbox", token=self.owner)[1]["members"] if item["name"] == "Antigravity")["pending"][0]
        note = self.request(f"{self.path}/messages/{step['message_id']}")[1]
        self.assertEqual((note["author"], note["text"]), ("Claude", "豁免卡片第 1 条，全文写进回答"), "the next step reads the host's note first")
        self.assertEqual((step["sequence"]["previous"]["kind"], step["sequence"]["pass"]), ("host", 2))
        self.assertEqual(len(step["sequence"]["previous_pass"]["answer_ids"]), 2, step["sequence"].get("previous_pass"))


class DiscussionHintTests(base.FreeRoomTests):
    """Discussion mode says what it hides (应 11): the reading boundary, later speakers' questions, the initial stage."""

    expected_host = "Codex"

    def setUp(self):
        """The multi-member room: Claude and Codex, Codex hosting."""
        base.FreeRoomTests.setUp(self)
        self.codex = uuid.uuid4().hex
        self.request(f"{self.path}/members", {"name": "Codex", "adapter": "codex_cli", "token": self.codex}, self.owner)
        self.request(f"{self.path}/members/{self.member_id('Codex')}", {"action": "role", "role": "host"}, self.owner)

    member_id = base.MultiMemberTests.member_id
    reserve_for = base.MultiMemberTests.reserve_for
    start_session = base.MultiMemberTests.start_session
    session_roster = base.MultiMemberTests.session_roster
    arrange_session = base.MultiMemberTests.arrange_session

    def say(self, text, token=None, **extra):
        """Name Claude unless told otherwise."""
        return base.FreeRoomTests.say(self, text, token, **({"to": ["Claude"]} | extra))

    def test_initial_stage_reading_is_explained_and_queued_questions_stay_private(self):
        self.request(f"{self.path}/members", {"name": "Antigravity", "token": (gemini := uuid.uuid4().hex)}, self.owner)
        self.start_session()
        roster = self.session_roster()
        self.assertEqual(roster["reading"]["phase"], "initial", roster)
        self.assertIn("note", roster["reading"])
        status, plan = self.arrange_session([{"expert": "Claude", "question": "甲的题"}, {"expert": "Antigravity", "question": "乙的题"}], roster)
        self.assertEqual(status, 201, plan)
        view = self.request(self.path, token=self.member)[1]
        self.assertEqual([(item["expert"], item["question"]) for item in view["queued_turns"]], [("Antigravity", "")])
        self.assertEqual(self.request(self.path, token=gemini)[1]["queued_turns"][0]["question"], "乙的题", "one's own question stays")
        self.assertEqual(self.request(self.path, token=self.codex)[1]["queued_turns"][0]["question"], "乙的题", "the host sees the plan")
        execution = self.reserve_for("Claude")[1]
        self.say("之后的消息")
        read = self.request(f"{self.path}/messages?execution_id={execution['id']}", token=self.member)[1]
        scope = read["read_scope"]
        self.assertEqual((scope["room_latest_id"] > scope["read_until"], "note" in scope, "beyond" in scope), (True, True, False), scope)


    def test_questions_respect_the_independent_reading_boundary(self):
        """An expert in the initial stage reads questions as far as its boundary: the answer given later stays hidden (REVIEW H3)."""
        self.say("帮我挑方案")
        execution = self.reserve_for("Claude")[1]["id"]
        asked = self.request(f"{self.path}/questions", {"actor": "Claude", "execution_id": execution, "submission_id": uuid.uuid4().hex,
                                                        "contract": "handoff", "blocking": True, "explanation": "A 或 B",
                                                        "questions": [{"id": "pick", "prompt": "选哪个？", "options": [{"id": "A", "label": "甲"}]}]},
                             self.member)[1]
        self.start_session()
        status, plan = self.arrange_session([{"expert": "Claude", "question": "独立观点"}])
        self.assertEqual(status, 201, plan)
        answered = self.request(f"{self.path}/questions/{asked['question_id']}/answer",
                                {"version": 1, "submission_id": uuid.uuid4().hex, "choices": {"pick": ["A"]}}, self.owner)
        self.assertEqual(answered[0], 201, answered)
        seen = self.request(f"{self.path}/questions/{asked['question_id']}", token=self.member)[1]
        self.assertEqual((seen["answer"], seen["answer_message_id"], seen["field_notes"]["answer"]["reason"]), (None, None, "reading_boundary"))
        self.assertIsNotNone(self.request(f"{self.path}/questions/{asked['question_id']}", token=self.owner)[1]["answer"], "the owner reads it all")
        listed = self.request(f"{self.path}/questions?status=all", token=self.member)[1]["questions"]
        self.assertEqual([item["answer"] for item in listed], [None])

    def test_a_question_past_the_boundary_is_left_out(self):
        from backend import questions
        views = [{"message_id": 5, "refs": [3, 9], "answer_message_id": 8, "recommendation_message_id": None, "events": [{}]},
                 {"message_id": 12, "refs": [], "answer_message_id": None, "recommendation_message_id": None}]
        kept = questions.bounded(views, 6)
        self.assertEqual([item["message_id"] for item in kept], [5])
        self.assertEqual((kept[0]["refs"], kept[0]["answer_message_id"], kept[0]["events"], sorted(kept[0]["field_notes"])),
                         ([3], None, [], ["answer", "events", "refs"]))
        self.assertEqual(questions.bounded(views, None), views)


    def test_a_whole_round_plan_does_not_count_the_speaker_now_as_not_yet_spoken(self):
        """Re-planning the rest of a round while one expert is speaking does not demand that expert again (R5)."""
        for name in ("Antigravity", "Antigravity-2"):
            self.request(f"{self.path}/members", {"name": name, "token": uuid.uuid4().hex}, self.owner)
        self.start_session()
        status, plan = self.arrange_session([{"expert": "Claude", "question": "甲"}, {"expert": "Antigravity", "question": "乙"},
                                             {"expert": "Antigravity-2", "question": "丙"}])
        self.assertEqual(status, 201, plan)
        self.request(f"{self.path}/members/{self.member_id('Antigravity')}", {"action": "away"}, self.owner)
        status, replanned = self.arrange_session([{"expert": "Antigravity-2", "question": "丙"}, {"expert": "Claude", "question": "下一轮追问"}])
        self.assertEqual(status, 201, replanned)


if __name__ == "__main__":
    unittest.main()

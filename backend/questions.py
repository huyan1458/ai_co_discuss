"""Questions a member asks the owner in a free room (spec #3329 + rulings #3332, #3355).

A question group is one durable object: its items (prompt, options, single or multiple choice, free input), the
explanation message carrying the candidates in full, whether it blocks the asker's task (`handoff`: the explanation
answers and closes the current request, the task waits on the owner) or not (`supplement`: the execution goes on), and,
for a relay's user gate, the gate it is bound to. Writes are bound to the object's `version`: answering, recommending,
deciding and cancelling read the question first and send its version back (missing 400, stale 409). Creating one is a
single transaction: the question, its explanation message, the request it closes and the gate binding are saved
together or not at all, and the same `submission_id` returns the same question.

The owner answers on the page (or with the CLI); the answer is saved once as an owner message plus the structured
`answer`, from which the task's `user_decision` is built. A plain answer goes back to the asker as a new request; a
relay gate's answer moves the relay on (or starts the loop's next pass) instead. The owner may instead ask the host for
a recommendation (the question gets the host's recommendation as version+1 and waits for the owner again) or leave the
decision to the host (the host's decision then counts as the answer).
"""

import hashlib
import json
import re
import time

from .runtime import begin_write, require_owner
from .texts import Text

OPEN = ("waiting_user", "waiting_recommendation", "delegated")
CONTRACTS = {"handoff": True, "supplement": False}
ACTIONS = ("answer", "other", "recommend", "delegate")
MAX_ITEMS = 5
MAX_OPTIONS = 8
MAX_PROMPT = 500
MAX_LABEL = 200
MAX_ANSWER_TEXT = 4000
MAX_REFS = 20
OPTION_ID = re.compile(r"[A-Za-z0-9_-]{1,20}")
SUBMISSION_ID = re.compile(r"[A-Za-z0-9_-]{8,100}")
# The fixed explanation a handoff's receipt carries (ruling #3332 P1, as refined by #3355).
HANDOFF_NOTE = Text("原请求已以交接方式结案，本次执行已结束、不能再补交；用户回答后会以新请求交给你（接力则交给下一棒）")


class QuestionClosed(FileExistsError):
    """A write refused because the question had to end first (expired, explanation withdrawn, relay gone).

    The closing is kept although the write fails: the caller commits it before answering 409, else the rollback would
    leave the question open for ever, blocking the owner's queue and the goal (REVIEW H2).
    """


def free():
    """The free-room module, imported late: it imports this one for the relay's user gate."""
    from . import free_room
    return free_room


def stamp():
    """The message timestamp format the room uses."""
    return time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime())


def checked_items(items):
    """Validate the question group's items: 1–5 prompts, each with options and/or free input."""
    if not isinstance(items, list) or not 1 <= len(items) <= MAX_ITEMS:
        raise ValueError(Text("questions 须为 1–{limit} 道题的列表", limit=MAX_ITEMS))
    checked, ids = [], set()
    for index, item in enumerate(items, 1):
        if not isinstance(item, dict):
            raise ValueError(Text("questions 的每一项须为对象"))
        item_id = str(item.get("id") or f"q{index}")
        prompt = item.get("prompt")
        options = item.get("options") or []
        multiple, free_text = item.get("multiple", False), item.get("free_text", True)
        if not OPTION_ID.fullmatch(item_id) or item_id in ids:
            raise ValueError(Text("题目 id 须为 1–20 位字母、数字、下划线或连字符，且不重复"))
        if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > MAX_PROMPT:
            raise ValueError(Text("题干须为 1–{limit} 字的简短说明，候选正文写在说明消息里", limit=MAX_PROMPT))
        if type(multiple) is not bool or type(free_text) is not bool:
            raise ValueError(Text("multiple 与 free_text 须为布尔值"))
        if not isinstance(options, list) or len(options) > MAX_OPTIONS or not options and not free_text:
            raise ValueError(Text("每道题须有 1–{limit} 个选项，或允许自由输入", limit=MAX_OPTIONS))
        seen, kept = set(), []
        for option in options:
            option_id = option.get("id") if isinstance(option, dict) else None
            label = option.get("label") if isinstance(option, dict) else None
            if not isinstance(option_id, str) or not OPTION_ID.fullmatch(option_id) or option_id in seen:
                raise ValueError(Text("选项 id 须为 1–20 位字母、数字、下划线或连字符，且同题内不重复"))
            if not isinstance(label, str) or not label.strip() or len(label) > MAX_LABEL:
                raise ValueError(Text("选项标签须为 1–{limit} 字", limit=MAX_LABEL))
            anchor = option.get("anchor")
            if anchor is not None and (not isinstance(anchor, str) or len(anchor) > MAX_LABEL):
                raise ValueError(Text("选项 anchor 须为说明消息里候选所在的小标题，最多 {limit} 字", limit=MAX_LABEL))
            seen.add(option_id)
            kept.append({"id": option_id, "label": label.strip(), **({"anchor": anchor} if anchor else {})})
        ids.add(item_id)
        checked.append({"id": item_id, "prompt": prompt.strip(), "options": kept, "multiple": multiple, "free_text": free_text})
    return checked


def checked_refs(connection, room_id, refs, read_message, token):
    """Earlier messages the question cites: they must exist and be readable by the asker now; only their numbers are kept."""
    if refs is None:
        return []
    if not isinstance(refs, list) or len(refs) > MAX_REFS or any(type(item) is not int or item <= 0 for item in refs):
        raise ValueError(Text("refs 须为最多 {limit} 个消息编号", limit=MAX_REFS))
    for message_id in refs:
        read_message(connection, room_id, message_id, {}, token)
    return list(dict.fromkeys(refs))


def fingerprint(payload):
    """What makes a resent create the same: everything the asker wrote, not who sent it or how."""
    keys = ("contract", "blocking", "explanation", "questions", "refs", "gate", "expires_at")
    material = json.dumps({key: payload.get(key) for key in keys}, ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


def source_requests(connection, room_id, member, payload):
    """The requests the question is asked from: the asker's live execution, or a manual member's own open requests."""
    if member["access"] == "manual":
        ids = payload.get("request_ids")
        if not isinstance(ids, list) or not ids or any(type(item) is not int for item in ids):
            raise ValueError(Text("手动接入成员提问须用 request_ids 关联自己的请求"))
        rows = [connection.execute("SELECT * FROM member_requests WHERE room_id=? AND id=?", (room_id, item)).fetchone() for item in ids]
        if any(not row or row["member_id"] != member["id"] or row["status"] != "pending" for row in rows):
            raise FileExistsError(Text("请求不属于本成员或已处理"))
        return [dict(row) for row in rows], 0
    execution_id = payload.get("execution_id")
    if type(execution_id) is not int:
        raise ValueError(Text("提问须关联本次执行编号 execution_id（凭据可补齐）"))
    row = connection.execute("SELECT * FROM member_executions WHERE room_id=? AND id=?", (room_id, execution_id)).fetchone()
    if not row or row["member_id"] != member["id"]:
        raise PermissionError(Text("执行编号不属于本成员"))
    if row["status"] not in ("dispatched", "started") or row["lease_until"] <= int(time.time()):
        raise FileExistsError(Text("本次执行已结束、被停止或已被重试，不能再提问；handoff 结案的执行不能补交"))
    rows = connection.execute("SELECT * FROM member_requests WHERE execution_id=? AND status='delivering'", (execution_id,)).fetchall()
    return [dict(item) for item in rows], execution_id


def relay_gate_after(connection, room_id, requests):
    """The relay whose user gate follows the step these requests answer, or None."""
    room = free()
    for request in requests:
        if request["purpose"] != "ask" or not request["batch_id"]:
            continue
        sequence = connection.execute("SELECT * FROM free_sequences WHERE room_id=? AND batch_id=? AND status='running'",
                                      (room_id, request["batch_id"])).fetchone()
        gate = sequence and room.current_gate(sequence)
        if gate and gate.get("user") and gate["after"] == sequence["position"]:
            return sequence
    return None


def relay_step_of(connection, room_id, requests):
    """Whether these requests are a running relay's step (a blocking question there must be followed by a user gate)."""
    return any(request["purpose"] == "ask" and request["batch_id"] and connection.execute(
        "SELECT 1 FROM free_sequences WHERE room_id=? AND batch_id=? AND status='running'", (room_id, request["batch_id"])).fetchone()
        for request in requests)


def gate_revision(sequence):
    """The version of the gate a relay waits at: it changes with the relay's pass, position and status."""
    material = json.dumps([sequence["id"], sequence["pass"], sequence["position"], sequence["status"], sequence["chain_id"]])
    return hashlib.sha256(material.encode()).hexdigest()[:12]


def waiting_gate(connection, room_id, sequence_id):
    """A relay waiting at a user gate, or None."""
    return connection.execute("""SELECT * FROM free_sequences WHERE room_id=? AND id=? AND status='checkpoint' AND handoff_request=0""",
                              (room_id, sequence_id)).fetchone()


def gate_question(connection, sequence):
    """The open question bound to the gate the relay waits at, if any."""
    return connection.execute("""SELECT * FROM room_questions WHERE sequence_id=? AND gate_pass=? AND gate_after=? AND status IN
        ('waiting_user','waiting_recommendation','delegated') ORDER BY id DESC""", (sequence["id"], sequence["pass"], sequence["position"])).fetchone()


def checked_gate(connection, room_id, member, gate):
    """An explicit binding to a relay's user gate (the host re-asking an old gate): read its revision first, then bind."""
    if gate is None:
        return None
    if member["role"] != "host":
        raise PermissionError(Text("只有当前主持人可以为等待用户的检查点补题"))
    if not isinstance(gate, dict) or type(gate.get("sequence_id")) is not int:
        raise ValueError(Text("gate 须为 {sequence_id, revision}"))
    if not gate.get("revision"):
        raise ValueError(Text("为检查点补题前须先 sequence view 读取 gate.revision，并带上它"))
    sequence = waiting_gate(connection, room_id, gate["sequence_id"])
    if not sequence or gate_revision(sequence) != gate["revision"]:
        raise FileExistsError(Text("检查点已变化或不在等用户，请重新读取后再补题"))
    if gate_question(connection, sequence):
        raise FileExistsError(Text("这个检查点已有待答问题"))
    return sequence


def insert_message(connection, room_id, author, text, source, submission_id, summary=""):
    """Save one plain room message without routing it; the caller decides what it answers or starts."""
    message_id = connection.execute("INSERT INTO messages (room_id,author,text,reply_to,source,submission_id,created_at) VALUES (?,?,?,?,?,?,?)",
                                    (room_id, author, text, None, source, submission_id, stamp())).lastrowid
    connection.execute("INSERT INTO message_details (message_id,kind,submitted_by) VALUES (?,?,?)", (message_id, "chat", author))
    connection.execute("INSERT INTO message_summaries (message_id,text,author) VALUES (?,?,?)", (message_id, summary, author if summary else ""))
    return message_id


def ask_question(connection, room, token, payload, append_answer, read_message):
    """Create a question group with its explanation message in one transaction (see the module doc).

    `append_answer(connection, room, payload, member)` saves a member's answer the normal way (closing its requests);
    `read_message` is the room's permission-checked single-message read, used to validate cited messages.
    """
    room_id = room["id"]
    begin_write(connection)
    member = free().require_member(connection, room_id, token, payload.get("actor"))
    submission = payload.get("submission_id")
    if not isinstance(submission, str) or not SUBMISSION_ID.fullmatch(submission):
        raise ValueError(Text("提问须带 8–100 位提交编号 submission_id；结果不明时用同一编号查询或重试"))
    previous = connection.execute("SELECT * FROM room_questions WHERE room_id=? AND submission_id=?", (room_id, submission)).fetchone()
    if previous:
        if previous["fingerprint"] != fingerprint(payload) or previous["asker_id"] != member["id"]:
            raise FileExistsError(Text("这个提交编号已被另一个问题使用，请为新问题生成新编号"))
        return {**receipt(connection, previous), "duplicate": True}
    if room.get("archived"):
        raise ValueError(Text("房间已存档；恢复后才能继续协作"))
    contract, blocking = payload.get("contract"), payload.get("blocking")
    if contract not in CONTRACTS or type(blocking) is not bool:
        raise ValueError(Text("contract 须为 handoff 或 supplement，blocking 须为布尔值"))
    if CONTRACTS[contract] != blocking:
        raise ValueError(Text("阻塞提问须用 handoff（说明消息交付并结束本次请求），非阻塞提问须用 supplement（执行继续）"))
    explanation = payload.get("explanation")
    if not isinstance(explanation, str) or not explanation.strip():
        raise ValueError(Text("提问须带说明正文 explanation：已完成的部分、各候选的完整说明与需要用户提供的信息"))
    items = checked_items(payload.get("questions"))
    refs = checked_refs(connection, room_id, payload.get("refs"), read_message, token)
    expires_at = payload.get("expires_at", 0)
    if type(expires_at) is not int or expires_at < 0:
        raise ValueError(Text("expires_at 须为 Unix 秒数，0 表示不过期"))
    requests, execution_id = source_requests(connection, room_id, member, payload)
    bound = checked_gate(connection, room_id, member, payload.get("gate"))
    if blocking and not bound and relay_step_of(connection, room_id, requests) and not relay_gate_after(connection, room_id, requests):
        raise ValueError(Text("这一棒之后没有等用户的检查点：接力中途需要用户信息时，用 supplement 提问并照常交棒，或在回答里交回主持人"))
    now = int(time.time())
    question_id = connection.execute("""INSERT INTO room_questions (room_id,asker_id,asker,execution_id,request_ids,contract,blocking,
        items,refs,status,submission_id,fingerprint,created_at,waiting_since,expires_at) VALUES (?,?,?,?,?,?,?,?,?,'waiting_user',?,?,?,?,?)""",
        (room_id, member["id"], member["name"], execution_id, json.dumps([item["id"] for item in requests]), contract, int(blocking),
         json.dumps(items, ensure_ascii=False), json.dumps(refs), submission, fingerprint(payload), now, now, expires_at)).lastrowid
    message = {"author": member["name"], "text": explanation, "submission_id": submission, "kind": "chat",
               **({"summary": payload["summary"]} if isinstance(payload.get("summary"), str) else {})}
    if blocking:
        # The explanation is the delivery of the current request: it closes it like any answer, and a relay step's
        # completion reaches its user gate, which binds this question (see `gate_reached`).
        message.update({"execution_id": execution_id} if execution_id else {"request_ids": [item["id"] for item in requests]})
        message_id = append_answer(connection, room, message, member)["message"]["id"]
    else:
        message_id = insert_message(connection, room_id, member["name"], explanation, payload.get("source") if payload.get("source") == "api" else "cli",
                                    submission, payload.get("summary") or "")
    connection.execute("UPDATE room_questions SET message_id=? WHERE id=?", (message_id, question_id))
    if bound:
        bind_gate(connection, question_id, bound)
    row = connection.execute("SELECT * FROM room_questions WHERE id=?", (question_id,)).fetchone()
    return {**receipt(connection, row), "duplicate": False}


def bind_gate(connection, question_id, sequence):
    """Tie a question to the user gate its relay waits at, so its answer, not plain chat, carries the relay on."""
    connection.execute("UPDATE room_questions SET sequence_id=?,gate_pass=?,gate_after=? WHERE id=?",
                       (sequence["id"], sequence["pass"], sequence["position"], question_id))
    connection.execute("INSERT INTO question_events (question_id,kind,detail,created_at) VALUES (?,?,?,?)",
                       (question_id, "gate_bound", json.dumps({"sequence_id": sequence["id"], "pass": sequence["pass"],
                                                               "after": sequence["position"]}), int(time.time())))


def gate_reached(connection, room_id, sequence):
    """A relay just stopped at a user gate: bind the question its last step asked, else ask the host once to supply one.

    The host is asked once per gate and version (ruling #3332 P3); until a question is bound, the owner's chat does
    not move the relay on, and the owner may stop it.
    """
    sequence = connection.execute("SELECT * FROM free_sequences WHERE id=?", (sequence["id"],)).fetchone()
    if gate_question(connection, sequence):
        return
    step_requests = {row[0] for row in connection.execute("SELECT id FROM member_requests WHERE room_id=? AND batch_id=?",
                                                          (room_id, sequence["batch_id"]))}
    for row in connection.execute("""SELECT * FROM room_questions WHERE room_id=? AND sequence_id=0 AND blocking=1 AND status='waiting_user'
            ORDER BY id DESC""", (room_id,)):
        if step_requests.intersection(json.loads(row["request_ids"])):
            bind_gate(connection, row["id"], sequence)
            return
    free().wake_host(connection, room_id, sequence["chain_id"], Text(
        "依次派活 #{message_id} 停在等用户的检查点（第 {position} 棒之后），但上一棒没有提出问题，用户无从作答。请主持人先 sequence view {sequence_id} 读取 gate.revision，再用 question ask --file 补题（JSON 里写 gate: {{sequence_id, revision}}，contract=handoff）。",
        message_id=sequence["message_id"], position=sequence["position"] + 1, sequence_id=sequence["id"]),
        f"gate-question:{sequence['id']}:{sequence['pass']}:{sequence['position']}:{sequence['chain_id']}")


def question_needed(connection, request):
    """For the host's notice asking it to supply a gate's question: the gate and its revision, so it can bind at once."""
    row = connection.execute("SELECT key FROM free_host_wakes WHERE message_id=? AND key LIKE 'gate-question:%'", (request["message_id"],)).fetchone()
    if not row:
        return {}
    sequence = connection.execute("SELECT * FROM free_sequences WHERE id=?", (int(row[0].split(":")[1]),)).fetchone()
    if not sequence or sequence["status"] != "checkpoint" or sequence["handoff_request"]:
        return {}
    return {"question_needed": {"sequence_id": sequence["id"], "revision": gate_revision(sequence),
                                "bound": bool(gate_question(connection, sequence))}}


def receipt(connection, row):
    """The create receipt (spec #3329 item 8): what was saved, what it closed and what now waits."""
    execution = connection.execute("SELECT status FROM member_executions WHERE id=?", (row["execution_id"],)).fetchone() if row["execution_id"] else None
    requests = json.loads(row["request_ids"])
    closed = bool(requests) and all(item[0] == "completed" for item in connection.execute(
        "SELECT status FROM member_requests WHERE id IN (%s)" % ",".join("?" * len(requests)), requests))
    result = {"outcome": "accepted", "question_id": row["id"], "message_id": row["message_id"], "version": row["version"],
              "status": row["status"], "contract": row["contract"], "blocking": bool(row["blocking"]),
              "request_ids": requests, "request_completed": closed,
              "execution_completed": bool(execution and execution[0] == "completed"),
              "task_waiting": bool(row["blocking"]) and row["status"] in OPEN,
              "submission_id": row["submission_id"],
              "gate": {"sequence_id": row["sequence_id"], "pass": row["gate_pass"], "after": row["gate_after"] + 1} if row["sequence_id"] else None}
    if row["contract"] == "handoff":
        result["note"] = HANDOFF_NOTE
    return result


def withdrawn(connection, message_id):
    """Whether a message was taken back (retracted or rewound)."""
    return bool(message_id and connection.execute("SELECT 1 FROM message_withdrawals WHERE message_id=?", (message_id,)).fetchone())


def public(connection, row, detail=False):
    """A question as readers see it: items, status, version and links by message number; explanations are not copied."""
    view = {"id": row["id"], "asker": row["asker"], "status": row["status"], "version": row["version"],
            "contract": row["contract"], "blocking": bool(row["blocking"]), "questions": json.loads(row["items"]),
            "message_id": row["message_id"], "refs": json.loads(row["refs"]),
            "recommendation_message_id": row["recommendation_message_id"] or None,
            "created_at": row["created_at"], "waiting_since": row["waiting_since"],
            "answered_at": row["answered_at"] or None, "answer_message_id": row["answer_message_id"] or None,
            "expires_at": row["expires_at"] or None, "submission_id": row["submission_id"],
            "answer": json.loads(row["answer"]) if row["answer"] else None,
            "gate": {"sequence_id": row["sequence_id"], "pass": row["gate_pass"], "after": row["gate_after"] + 1} if row["sequence_id"] else None,
            "visibility": "room"}
    if row["sequence_id"]:
        sequence = connection.execute("SELECT * FROM free_sequences WHERE id=?", (row["sequence_id"],)).fetchone()
        if sequence:
            gate = free().current_gate(sequence)
            # After the answer: the loop's stretch runs again from `repeat_from`, or the relay goes on to the next step.
            view["gate"].update(route="repeat" if gate and gate["repeat_from"] is not None else "next",
                                relay_status=sequence["status"])
    if detail:
        view["events"] = [dict(item) for item in connection.execute(
            "SELECT kind,detail,created_at FROM question_events WHERE question_id=? ORDER BY id", (row["id"],))]
    return view


def list_questions(connection, room_id, token, params, boundary=None):
    """Questions in the order the owner is shown them: the open ones by when they (last) started waiting, then by id.

    `current` is the one card the page opens; the rest show as a queue. A member also gets `last_ask`, its own latest
    question, so a create whose result was unknown can be looked up (or `submission_id` finds one exactly).
    """
    member = None
    try:
        require_owner(connection, room_id, token)
    except PermissionError:
        member = free().require_member(connection, room_id, token)
    where, values = "room_id=?", [room_id]
    if params.get("submission_id"):
        where, values = where + " AND submission_id=?", values + [params["submission_id"]]
    elif params.get("status", "open") == "open":
        where += " AND status IN ('waiting_user','waiting_recommendation','delegated')"
    rows = connection.execute(f"SELECT * FROM room_questions WHERE {where} ORDER BY waiting_since,id LIMIT 100", values).fetchall()
    items = bounded([public(connection, row) for row in rows], boundary)
    current = next((item["id"] for item in items if item["status"] == "waiting_user"), None)
    result = {"questions": items, "current": current}
    if member:
        last = connection.execute("SELECT * FROM room_questions WHERE asker_id=? ORDER BY id DESC LIMIT 1", (member["id"],)).fetchone()
        result["last_ask"] = {**receipt(connection, last), "asked_at": last["created_at"], "answered_at": last["answered_at"] or None,
                              "answer_message_id": last["answer_message_id"] or None, "expires_at": last["expires_at"] or None} if last else None
    return result


def view_question(connection, room_id, question_id, token, boundary=None):
    """One question with its history; anyone who may read the room may read it."""
    try:
        require_owner(connection, room_id, token)
    except PermissionError:
        free().require_member(connection, room_id, token)
    row = load(connection, room_id, question_id)
    shown = bounded([public(connection, row, detail=True)], boundary)
    if not shown:
        # Asked past the reader's boundary: the same answer as a question that does not exist, so nothing can be probed.
        raise LookupError(Text("问题不存在"))
    return shown[0]


def bounded(views, boundary):
    """Questions as a reader inside a reading boundary (independent opinions) may see them (#3329 item 6, spec #3187).

    A question asked past the boundary is left out; of one asked before it, the answer, recommendation, history and
    cited messages past the boundary are emptied, each named in `field_notes` with the reason. None: no boundary.
    """
    if boundary is None:
        return views
    note = {"reason": "reading_boundary", "request_read_until": boundary}
    kept = []
    for view in views:
        if view["message_id"] > boundary:
            continue
        view, notes = dict(view), {}
        if (view.get("answer_message_id") or 0) > boundary:
            view.update(answer=None, answer_message_id=None, answered_at=None)
            notes["answer"] = note
        if (view.get("recommendation_message_id") or 0) > boundary:
            view["recommendation_message_id"] = None
            notes["recommendation_message_id"] = note
        if any(ref > boundary for ref in view["refs"]):
            view["refs"] = [ref for ref in view["refs"] if ref <= boundary]
            notes["refs"] = note
        if view.get("events") and notes:
            view["events"] = []
            notes["events"] = note
        if notes:
            view["field_notes"] = notes
        kept.append(view)
    return kept


def load(connection, room_id, question_id):
    """The question row, or LookupError."""
    row = connection.execute("SELECT * FROM room_questions WHERE room_id=? AND id=?", (room_id, question_id)).fetchone()
    if not row:
        raise LookupError(Text("问题不存在"))
    return row


def checked_version(row, payload):
    """Bind a write to the version the writer read: missing is 400, changed is 409."""
    version = payload.get("version")
    if type(version) is not int:
        raise ValueError(Text("请先读取问题（question view），再带上它的 version 提交"))
    if version != row["version"]:
        raise FileExistsError(Text("问题已更新到第 {version} 版（例如主持人给了推荐），请重新读取后再作答", version=row["version"]))


def checked_choices(row, choices, text, required):
    """The chosen option ids per item: each must exist, a single-choice item takes one; free text where allowed."""
    items = {item["id"]: item for item in json.loads(row["items"])}
    choices = choices or {}
    if not isinstance(choices, dict) or any(key not in items for key in choices):
        raise ValueError(Text("choices 须按题目 id 给出选项 id 列表"))
    checked = {}
    for key, picked in choices.items():
        picked = picked if isinstance(picked, list) else [picked]
        options = {option["id"] for option in items[key]["options"]}
        if any(option not in options for option in picked) or len(set(picked)) != len(picked):
            raise ValueError(Text("选项不存在：{item}", item=key))
        if len(picked) > 1 and not items[key]["multiple"]:
            raise ValueError(Text("第 {item} 题是单选", item=key))
        if picked:
            checked[key] = picked
    if text is not None and (not isinstance(text, str) or len(text) > MAX_ANSWER_TEXT):
        raise ValueError(Text("补充说明最多 {limit} 字", limit=MAX_ANSWER_TEXT))
    if required and not checked and not (text or "").strip():
        raise ValueError(Text("请至少选择一个选项或填写回答"))
    return checked


def answer_text(row, action, choices, text):
    """The owner message an answer is saved as: readable in the transcript, with the question number."""
    items = {item["id"]: item for item in json.loads(row["items"])}
    if action == "recommend":
        head = Text("请主持人先讨论并给推荐（问题 #{id}）", id=row["id"])
    elif action == "delegate":
        head = Text("交给主持人决定（问题 #{id}）", id=row["id"])
    else:
        picked = "；".join(f"{items[key]['prompt'].rstrip('？?：:')}：" + "、".join(
            f"{option['id']}（{option['label']}）" for option in items[key]["options"] if option["id"] in value)
            for key, value in choices.items())
        head = Text("回答问题 #{id}：{picked}", id=row["id"], picked=picked) if picked else Text("回答问题 #{id}", id=row["id"])
    return f"{head}\n\n{text.strip()}" if (text or "").strip() else str(head)


def answer_question(connection, room_id, question_id, token, payload):
    """The owner answers (or asks for a recommendation, or leaves it to the host); one owner message, once.

    The same `submission_id` returns the first result; a stopped relay, a withdrawn explanation or an expired question
    refuses a late answer instead of restarting anything.
    """
    begin_write(connection)
    require_owner(connection, room_id, token)
    row = load(connection, room_id, question_id)
    submission = payload.get("submission_id")
    if not isinstance(submission, str) or not SUBMISSION_ID.fullmatch(submission):
        raise ValueError(Text("作答须带 8–100 位提交编号 submission_id；同一编号重试得到同一结果"))
    if row["answer_submission_id"] == submission:
        return {"question": public(connection, row), "message_id": row["answer_message_id"] or row["request_message_id"], "duplicate": True}
    action = payload.get("action", "answer")
    if action not in ACTIONS:
        raise ValueError(Text("action 须为 answer、other、recommend 或 delegate"))
    checked_version(row, payload)
    if row["status"] not in OPEN:
        raise FileExistsError(Text("问题已回答、取消或过期"))
    if action in ("recommend", "delegate") and row["status"] != "waiting_user":
        raise FileExistsError(Text("已在等主持人处理这个问题"))
    if row["expires_at"] and int(time.time()) >= row["expires_at"]:
        close(connection, row, "expired")
        raise QuestionClosed(Text("问题已过期"))
    live_check(connection, row)
    choices = checked_choices(row, payload.get("choices"), payload.get("text"), action in ("answer", "other"))
    text = answer_text(row, action, choices, payload.get("text"))
    message_id = insert_message(connection, room_id, "用户", text, "user", submission)
    connection.execute("UPDATE room_questions SET answer_submission_id=?,request_message_id=? WHERE id=?", (submission, message_id, row["id"]))
    record = {"action": action, "choices": choices, "text": (payload.get("text") or "").strip(), "by": "用户",
              "version": row["version"], "at": int(time.time()), "message_id": message_id}
    if action in ("recommend", "delegate"):
        status = "waiting_recommendation" if action == "recommend" else "delegated"
        connection.execute("UPDATE room_questions SET status=?,pending=? WHERE id=?", (status, json.dumps(record, ensure_ascii=False), row["id"]))
        event(connection, row["id"], action, record)
        to_host(connection, room_id, message_id)
    else:
        settle_answer(connection, row, record, message_id)
    return {"question": public(connection, load(connection, room_id, question_id)), "message_id": message_id, "duplicate": False}


def live_check(connection, row):
    """Refuse an answer that would restart stopped work: a withdrawn explanation, or a relay no longer at its gate."""
    if withdrawn(connection, row["message_id"]):
        close(connection, row, "cancelled")
        raise QuestionClosed(Text("提问的说明消息已撤回，问题随之取消"))
    if row["sequence_id"]:
        sequence = waiting_gate(connection, row["room_id"], row["sequence_id"])
        if not sequence or sequence["pass"] != row["gate_pass"] or sequence["position"] != row["gate_after"]:
            close(connection, row, "cancelled")
            raise QuestionClosed(Text("接力已停止或已离开这个检查点，迟到的回答不会重启它"))


def to_host(connection, room_id, message_id):
    """Hand the owner's request for a recommendation or a decision to the present host, on the owner's message."""
    host = connection.execute("SELECT id FROM room_members WHERE room_id=? AND role='host' AND status='active'", (room_id,)).fetchone()
    if not host:
        raise FileExistsError(Text("房间当前没有主持人，无法请主持人推荐或决定"))
    free().insert_request(connection, room_id, host["id"], message_id, message_id, "ask", "user")


def settle_answer(connection, row, record, message_id):
    """Save the answer and route it once: the relay goes on from its gate, else the asker gets a new request."""
    now = int(time.time())
    connection.execute("""UPDATE room_questions SET status='answered',answer=?,answer_message_id=?,answered_at=?,pending='' WHERE id=?""",
                       (json.dumps(record, ensure_ascii=False), message_id, now, row["id"]))
    event(connection, row["id"], "answered", record)
    room_id = row["room_id"]
    # Owner input lets an active goal wake the host again once the room falls idle, as any owner message does.
    connection.execute("UPDATE room_goals SET armed=1,phase='doing',phase_note='',phase_until=0 WHERE room_id=? AND status='active'", (room_id,))
    room = free()
    if row["sequence_id"]:
        sequence = waiting_gate(connection, room_id, row["sequence_id"])
        if not room.pass_user_gate(connection, room_id, sequence, message_id):
            # No member left to take the next step, or the relay's host changed: the relay stops and the present host
            # is told, with the answer, so the owner's decision is not lost (ruling #3332 P5).
            event(connection, row["id"], "relay_stopped", {})
            room.wake_host(connection, room_id, message_id, Text(
                "用户已回答问题 #{question_id}（消息 #{message_id}），但依次派活 #{relay} 后面没有可接手的在场成员（或主持人已更换），接力已停下。请主持人决定接下来怎么做。",
                question_id=row["id"], message_id=message_id, relay=sequence["message_id"] if sequence else 0),
                f"relay-stopped:{row['sequence_id']}:{row['id']}")
        return
    asker = connection.execute("SELECT id,status FROM room_members WHERE id=?", (row["asker_id"],)).fetchone()
    if asker and asker["status"] == "active":
        room.insert_request(connection, room_id, asker["id"], message_id, message_id, "ask", "user")
        return
    # The asker left: the answer stays, and the host decides what follows.
    host = connection.execute("SELECT id FROM room_members WHERE room_id=? AND role='host' AND status='active'", (room_id,)).fetchone()
    if host:
        room.insert_request(connection, room_id, host["id"], message_id, message_id, "ask", "user")


def event(connection, question_id, kind, detail):
    """Append to the question's own history."""
    connection.execute("INSERT INTO question_events (question_id,kind,detail,created_at) VALUES (?,?,?,?)",
                       (question_id, kind, json.dumps(detail, ensure_ascii=False), int(time.time())))


def close(connection, row, status):
    """End an open question without an answer (cancelled or expired)."""
    connection.execute("UPDATE room_questions SET status=?,pending='' WHERE id=? AND status IN ('waiting_user','waiting_recommendation','delegated')",
                       (status, row["id"]))
    event(connection, row["id"], status, {})


def host_reply(connection, room, token, question_id, payload, append_answer, decide):
    """The host's recommendation (a new version, waiting for the owner again) or its delegated decision (the answer).

    Its text answers the host's current execution, saved the normal way in the same transaction.
    """
    room_id = room["id"]
    begin_write(connection)
    host = free().require_member(connection, room_id, token, payload.get("actor"))
    if host["role"] != "host":
        raise PermissionError(Text("只有当前主持人可以给推荐或代为决定"))
    row = load(connection, room_id, question_id)
    submission = payload.get("submission_id")
    if not isinstance(submission, str) or not SUBMISSION_ID.fullmatch(submission):
        raise ValueError(Text("须带 8–100 位提交编号 submission_id"))
    done = connection.execute("SELECT 1 FROM question_events WHERE question_id=? AND kind IN ('recommended','decided') AND detail LIKE ?",
                              (row["id"], f'%"submission_id": "{submission}"%')).fetchone()
    if done:
        return {"question": public(connection, row), "duplicate": True}
    checked_version(row, payload)
    if decide and row["status"] != "delegated":
        raise FileExistsError(Text("用户没有把这个问题交给主持人决定"))
    if not decide and row["status"] not in ("waiting_user", "waiting_recommendation"):
        raise FileExistsError(Text("问题已回答、取消或过期"))
    text = payload.get("text")
    if not isinstance(text, str) or not text.strip():
        raise ValueError(Text("须写明推荐或决定的理由 text"))
    live_check(connection, row)
    choices = checked_choices(row, payload.get("choices"), None, decide)
    message = {"author": host["name"], "text": text, "submission_id": submission, "kind": "chat"}
    if type(payload.get("execution_id")) is int:
        message["execution_id"] = payload["execution_id"]
    elif payload.get("request_ids"):
        message["request_ids"] = payload["request_ids"]
    message_id = append_answer(connection, room, message, host)["message"]["id"]
    record = {"choices": choices, "message_id": message_id, "submission_id": submission, "at": int(time.time())}
    if decide:
        pending = json.loads(row["pending"] or "{}")
        settle_answer(connection, row, {**record, "action": "decided", "by": host["name"], "version": row["version"],
                                        "delegation": pending.get("text", "")}, message_id)
        event(connection, row["id"], "decided", record)
    else:
        connection.execute("""UPDATE room_questions SET version=version+1,status='waiting_user',waiting_since=?,
            recommendation_message_id=?,recommendation=?,pending='' WHERE id=?""",
                           (int(time.time()), message_id, json.dumps(choices), row["id"]))
        event(connection, row["id"], "recommended", record)
    return {"question": public(connection, load(connection, room_id, question_id)), "message_id": message_id, "duplicate": False}


def cancel_question(connection, room_id, question_id, token, payload):
    """The owner or the asker withdraws an open question; a relay waiting on it stops, since nothing else may carry it on."""
    begin_write(connection)
    row = load(connection, room_id, question_id)
    try:
        require_owner(connection, room_id, token)
    except PermissionError:
        member = free().require_member(connection, room_id, token)
        if member["id"] != row["asker_id"]:
            raise PermissionError(Text("只有房主或提问者可以取消问题")) from None
    if row["status"] not in OPEN:
        if row["status"] == "cancelled":
            return {"question": public(connection, row), "duplicate": True}
        raise FileExistsError(Text("问题已回答、取消或过期"))
    checked_version(row, payload)
    close(connection, row, "cancelled")
    if row["sequence_id"]:
        connection.execute("UPDATE free_sequences SET status='stopped' WHERE id=? AND status='checkpoint' AND handoff_request=0", (row["sequence_id"],))
    return {"question": public(connection, load(connection, room_id, question_id)), "duplicate": False}


def cancel_open(connection, room_id):
    """The owner stopped the whole room: open questions end with it, so a late answer restarts nothing."""
    for row in connection.execute("SELECT * FROM room_questions WHERE room_id=? AND status IN ('waiting_user','waiting_recommendation','delegated')",
                                  (room_id,)).fetchall():
        close(connection, row, "cancelled")


def waiting_on_user(connection, room_id):
    """Open blocking questions the owner has to answer: an active goal does not idle-wake the host over them."""
    return [row[0] for row in connection.execute(
        "SELECT id FROM room_questions WHERE room_id=? AND blocking=1 AND status='waiting_user' ORDER BY waiting_since,id", (room_id,))]


def request_context(connection, request):
    """What a member's request has to do with a question: the owner's structured decision, or a recommendation to give.

    `user_decision` is built from the stored answer, the same record the owner's message was written from.
    """
    message_id = request.get("message_id")
    if not message_id:
        return {}
    row = connection.execute("""SELECT * FROM room_questions WHERE answer_message_id=? OR request_message_id=? ORDER BY id DESC""",
                             (message_id, message_id)).fetchone()
    if not row:
        return question_needed(connection, request)
    items = json.loads(row["items"])
    context = {"id": row["id"], "version": row["version"], "asker": row["asker"], "status": row["status"],
               "questions": items, "explanation_message_id": row["message_id"],
               **({"recommendation_message_id": row["recommendation_message_id"]} if row["recommendation_message_id"] else {})}
    if row["answer_message_id"] == message_id and row["answer"]:
        answer = json.loads(row["answer"])
        context["user_decision"] = {key: answer.get(key) for key in ("action", "choices", "text", "by", "version", "delegation") if answer.get(key) not in (None, "")}
    elif row["status"] == "waiting_recommendation":
        context["task"] = "recommend"
    elif row["status"] == "delegated":
        context["task"] = "decide"
        pending = json.loads(row["pending"] or "{}")
        if pending.get("text"):
            context["delegation"] = pending["text"]
    return {"question": context}


def room_questions_view(connection, room_id):
    """Open questions for the room view, in presentation order (the page opens the first waiting card)."""
    return [public(connection, row) for row in connection.execute(
        "SELECT * FROM room_questions WHERE room_id=? AND status IN ('waiting_user','waiting_recommendation','delegated') ORDER BY waiting_since,id",
        (room_id,))]

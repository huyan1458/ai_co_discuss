"""Request-backed discussion session state and plan operations."""

import hashlib
import json
import re
import time

from .free_room import (MAX_CONTINUE_REASON, active_members, finish_execution, member_display_names, remember_continue, require_member,
                        require_owner, resume_host, wake_host)
from .texts import Text, load_texts, save_text, text_payload
from .runtime import begin_write, enforce_session_limits, limit_values, room_limits_view, token_hash

MAX_PLAN_TURNS = 10
MAX_QUESTION_LENGTH = 1000


def current_session(connection, room_id, active_only=False):
    """Return the latest request-model session, optionally only while it is open."""
    status_filter = "AND status IN ('active','paused')" if active_only else ""
    row = connection.execute(f"SELECT * FROM discussion_sessions WHERE room_id=? {status_filter} ORDER BY id DESC LIMIT 1", (room_id,)).fetchone()
    if not row or not connection.execute("SELECT 1 FROM session_state WHERE session_id=?", (row['id'],)).fetchone():
        return None
    return dict(row)


def session_room(connection, room_id):
    """Read discussion control state and its revision without exposing credentials."""
    if enforce_session_limits(connection, room_id):
        connection.commit()
    session = current_session(connection, room_id, active_only=True)
    if not session:
        return {"session": None, "revision": _idle_session_revision(connection, room_id)}
    state = dict(connection.execute("SELECT * FROM session_state WHERE session_id=?", (session['id'],)).fetchone())
    limits = dict(connection.execute("SELECT * FROM session_limits WHERE session_id=?", (session['id'],)).fetchone())
    pause = dict(connection.execute("SELECT * FROM session_pauses WHERE session_id=?", (session['id'],)).fetchone())
    option = connection.execute("SELECT named_followup FROM session_options WHERE session_id=?", (session['id'],)).fetchone()
    counts = connection.execute("SELECT COUNT(*) FROM session_requests WHERE session_id=? AND purpose='discuss' AND status='answered'", (session['id'],)).fetchone()[0]
    session.update(state)
    submission = connection.execute("SELECT submission_id FROM session_start_submissions WHERE session_id=?", (session['id'],)).fetchone()
    session["start_submission_id"] = submission[0] if submission else None
    session["named_followup"] = bool(option[0]) if option else True
    session["limits"] = limits
    session["pause"] = pause
    session["answered"] = counts
    revision = _session_revision(connection, session)
    session["revision"] = revision
    return {"session": session, "revision": revision}


def _idle_session_revision(connection, room_id):
    """Bind a start token to the prior session, roster, defaults and visible history."""
    latest_session = connection.execute("SELECT id,status FROM discussion_sessions WHERE room_id=? ORDER BY id DESC LIMIT 1",
                                        (room_id,)).fetchone()
    members = [list(row) for row in connection.execute("""SELECT m.id,m.name,m.role,m.access,m.status,
        CASE WHEN r.token_hash=m.token_hash THEN 1 ELSE 0 END AS registered
        FROM room_members m LEFT JOIN member_registrations r ON r.member_id=m.id
        WHERE m.room_id=? ORDER BY m.id""", (room_id,))]
    latest_message = connection.execute("""SELECT COALESCE(MAX(id),0) FROM messages WHERE room_id=?
        AND NOT EXISTS(SELECT 1 FROM internal_task_messages WHERE message_id=messages.id)""", (room_id,)).fetchone()[0]
    mode = connection.execute("SELECT mode FROM room_modes WHERE room_id=?", (room_id,)).fetchone()
    options = connection.execute("SELECT named_followup FROM session_options WHERE session_id=?",
                                 (latest_session["id"],)).fetchone() if latest_session else None
    limits = room_limits_view(connection, room_id)
    return _hash_revision([room_id, list(latest_session) if latest_session else None, members,
                           mode[0] if mode else "", list(options) if options else None, latest_message,
                           [limits[key] for key in ("max_rounds", "max_minutes", "execution_minutes")]])


def _hash_revision(value):
    """Create a compact version token from the complete state a write depends on."""
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode()).hexdigest()[:16]


def _session_revision(connection, session):
    """Bind a control revision to this session, its roster, queue, phase and limits."""
    session_id = session["id"]
    state = connection.execute("SELECT phase,read_until,held_since FROM session_state WHERE session_id=?", (session_id,)).fetchone()
    limits = connection.execute("SELECT max_rounds,max_minutes,execution_minutes,started_at,stop_reason FROM session_limits WHERE session_id=?", (session_id,)).fetchone()
    members = [list(row) for row in connection.execute("""SELECT m.id,m.name,m.role,m.access,m.status,
        CASE WHEN r.token_hash=m.token_hash THEN 1 ELSE 0 END AS registered
        FROM room_members m LEFT JOIN member_registrations r ON r.member_id=m.id
        WHERE m.room_id=? ORDER BY m.id""", (session["room_id"],))]
    queue = [list(row) for row in connection.execute("""SELECT id,round,position,member_id,purpose,status,submission_id,question
        FROM session_requests WHERE session_id=? ORDER BY round,position,id""", (session_id,))]
    options = list(connection.execute("SELECT named_followup FROM session_options WHERE session_id=?", (session_id,)).fetchone())
    latest = connection.execute("""SELECT COALESCE(MAX(m.id),0) FROM messages m WHERE m.room_id=?
        AND NOT EXISTS (SELECT 1 FROM internal_task_messages t WHERE t.message_id=m.id)""", (session["room_id"],)).fetchone()[0]
    return _hash_revision([session_id, session["status"], list(state), list(limits), options, members, queue, latest])


def require_revision(view, payload, message):
    """Require the exact revision read before a state-dependent session write."""
    if payload.get("revision") is None:
        messages = {
            "开启讨论": Text("开启讨论前须先读取最新讨论状态并带上 revision"),
            "结束讨论": Text("结束讨论前须先读取最新讨论状态并带上 revision"),
            "修改讨论限制": Text("修改讨论限制前须先读取最新讨论状态并带上 revision"),
            "转交追问": Text("转交追问前须先读取最新讨论状态并带上 revision"),
            "讨论控制": Text("讨论控制前须先读取最新讨论状态并带上 revision"),
        }
        raise ValueError(messages.get(message, Text("{action}前须先读取最新讨论状态并带上 revision", action=message)))
    if str(payload["revision"]) != str(view["revision"]):
        raise FileExistsError(Text("讨论状态已变化，请重新读取后再提交"))


def _task_message(connection, session_id, request_id, cause):
    """Create a hidden, uniquely sourced message used only as a member request anchor."""
    task = connection.execute("SELECT * FROM session_requests WHERE id=? AND session_id=?", (request_id, session_id)).fetchone()
    existing = connection.execute("SELECT message_id FROM task_message_sources WHERE session_request_id=?", (request_id,)).fetchone()
    if existing:
        return existing["message_id"]
    room_id = connection.execute("SELECT room_id FROM discussion_sessions WHERE id=?", (session_id,)).fetchone()[0]
    submission_id = f"session-task-{request_id}"
    created_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    question = task["question"]
    stored = load_texts(connection, "session_request", request_id).get("question")
    if stored:
        question = Text(stored["template"], **stored["params"])
    cursor = connection.execute("INSERT INTO messages(room_id,author,text,source,submission_id,created_at) VALUES(?,?,?,?,?,?)",
                                (room_id, "系统任务", str(question), "system", submission_id, created_at))
    message_id = cursor.lastrowid
    save_text(connection, "message", message_id, "text", question)
    connection.execute("INSERT INTO task_message_sources(message_id,session_id,session_request_id,cause_kind,cause_message_id,cause_request_id) VALUES(?,?,?,?,?,?)",
                       (message_id, session_id, request_id, cause["kind"], cause.get("message_id"), cause.get("request_id")))
    return message_id


def _open_request(connection, session_request, cause):
    """Anchor a session plan to one internal task message and create its normal member request."""
    request_id = session_request["id"]
    message_id = _task_message(connection, session_request["session_id"], request_id, cause)
    existing = connection.execute("SELECT id FROM member_requests WHERE message_id=? AND member_id=?", (message_id, session_request["member_id"])).fetchone()
    if existing:
        member_request_id = existing["id"]
    else:
        session = connection.execute("SELECT room_id FROM discussion_sessions WHERE id=?", (session_request["session_id"],)).fetchone()
        cursor = connection.execute("""INSERT INTO member_requests
            (room_id,member_id,message_id,chain_id,purpose,created_by,created_at)
            VALUES(?,?,?,?,?,?,?)""", (session["room_id"], session_request["member_id"],
            message_id, message_id, session_request["purpose"], "host", int(time.time())))
        member_request_id = cursor.lastrowid
    connection.execute("UPDATE session_requests SET status='open',member_request_id=? WHERE id=?", (member_request_id, request_id))
    return member_request_id


def create_host_request(connection, session_id, question, cause):
    """Create one idempotent host request for a session event."""
    state = connection.execute("SELECT phase FROM session_state WHERE session_id=?", (session_id,)).fetchone()
    if not state:
        raise LookupError(Text("讨论会话不存在"))
    session = connection.execute("SELECT room_id FROM discussion_sessions WHERE id=?", (session_id,)).fetchone()
    host = connection.execute("SELECT id FROM room_members WHERE room_id=? AND role='host' AND status='active'", (session["room_id"],)).fetchone()
    if not host:
        raise ValueError(Text("当前讨论没有在场的 AI 主持人"))
    cause_kind = cause["kind"]
    key = str(cause.get("key") or cause.get("message_id") or cause.get("request_id") or cause_kind)
    submission_id = f"host-{session_id}-{cause_kind}-{key}"[:100]
    row = connection.execute("SELECT * FROM session_requests WHERE session_id=? AND submission_id=?", (session_id, submission_id)).fetchone()
    if row:
        return dict(row)
    position = connection.execute("SELECT COALESCE(MAX(position),0)+1 FROM session_requests WHERE session_id=? AND purpose='discuss_host'", (session_id,)).fetchone()[0]
    cursor = connection.execute("INSERT INTO session_requests(session_id,round,position,member_id,purpose,question,status,submission_id,read_until,created_at) VALUES(?,0,?,?,'discuss_host',?,'open',?,NULL,?)",
        (session_id, position, host["id"], question, submission_id, time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())))
    save_text(connection, "session_request", cursor.lastrowid, "question", question)
    row = connection.execute("SELECT * FROM session_requests WHERE id=?", (cursor.lastrowid,)).fetchone()
    _open_request(connection, row, cause)
    return dict(connection.execute("SELECT * FROM session_requests WHERE id=?", (cursor.lastrowid,)).fetchone())


def advance_session(connection, session_id):
    """Promote the next queued discussion plan; execution reservation enforces session exclusivity."""
    session = connection.execute("SELECT status FROM discussion_sessions WHERE id=?", (session_id,)).fetchone()
    if not session or session["status"] != "active":
        return None
    active = connection.execute("SELECT id FROM session_requests WHERE session_id=? AND purpose='discuss' AND status='open'", (session_id,)).fetchone()
    if active:
        return dict(connection.execute("SELECT * FROM session_requests WHERE id=?", (active["id"],)).fetchone())
    queued = connection.execute("SELECT * FROM session_requests WHERE session_id=? AND purpose='discuss' AND status='queued' ORDER BY round,position,id LIMIT 1", (session_id,)).fetchone()
    if not queued:
        return None
    request = dict(queued)
    _open_request(connection, request, {"kind": "scheduled_speaker"})
    connection.execute("UPDATE session_state SET revision=revision+1 WHERE session_id=?", (session_id,))
    return dict(connection.execute("SELECT * FROM session_requests WHERE id=?", (queued["id"],)).fetchone())


def _start_submission(connection, room_id, payload):
    """Bind an optional launch replay id to the exact original start request."""
    submission_id = payload.get("submission_id")
    if submission_id is None:
        return None
    if not isinstance(submission_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{8,100}", submission_id):
        raise ValueError(Text("submission_id 须为 8–100 位字母、数字、下划线或短横线"))
    request_json = json.dumps({key: payload[key] for key in ("revision", "goal", "limits", "named_followup") if key in payload},
                              ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    row = connection.execute("SELECT * FROM session_start_submissions WHERE room_id=? AND submission_id=?",
                             (room_id, submission_id)).fetchone()
    if row and row["request_json"] != request_json:
        raise FileExistsError(Text("这个 submission_id 已用于不同的开启请求；请核对原提交"))
    session = dict(connection.execute("SELECT * FROM discussion_sessions WHERE id=?", (row["session_id"],)).fetchone()) if row else None
    return {"submission_id": submission_id, "request_json": request_json, "session": session}


def start_request(connection, room_id, token, payload):
    """Check the host's `discuss_start` request from an owner's `/discuss`; it stands in for the owner's revision."""
    member = require_member(connection, room_id, token)
    if member["role"] != "host":
        raise PermissionError(Text("只有主持人能补全并开启讨论"))
    request = connection.execute("SELECT * FROM member_requests WHERE room_id=? AND id=?", (room_id, payload["request_id"])).fetchone()
    if (not request or request["purpose"] != "discuss_start" or request["member_id"] != member["id"]
            or request["status"] not in ("pending", "delivering")):
        raise FileExistsError(Text("讨论启动请求不存在、不属于你或已处理；只有用户的 /discuss 命令能由主持人开启讨论"))
    # The request is the one launch: a retry returns the same session, other content is refused.
    payload["submission_id"] = f"discuss-start-{request['id']}"


def start_session(connection, room_id, token, payload, room):
    """Start an in-room discussion session without changing the room's free-collaboration mode.

    The owner starts with the revision just read; the host may instead start one bound to its `discuss_start` request.
    """
    begin_write(connection)
    by_host = payload.get("request_id") is not None
    if by_host:
        start_request(connection, room_id, token, payload)
    else:
        require_owner(connection, room_id, token)
    current = session_room(connection, room_id)
    submission = _start_submission(connection, room_id, payload)
    if submission and submission["session"]:
        original = submission["session"]
        session = current["session"] if current["session"] and current["session"]["id"] == original["id"] else original
        return {"session": {**session, "start_submission_id": submission["submission_id"]},
                "revision": current["revision"], "duplicate": True}
    if room["archived"]:
        raise ValueError(Text("房间已存档；恢复后才能开启讨论"))
    if not by_host:
        require_revision(current, payload, "开启讨论")
    if current["session"]:
        raise FileExistsError(Text("房间已有进行中的讨论会话"))
    if connection.execute("SELECT 1 FROM room_goals WHERE room_id=? AND status IN ('active','paused')", (room_id,)).fetchone():
        raise FileExistsError(Text("Goal 进行中；结束 Goal 后才能开启讨论"))
    members = active_members(connection, room_id, registered_only=False)
    host = next((member for member in members.values() if member["role"] == "host" and member["access"] == "runner"), None)
    if not host:
        raise ValueError(Text("开启讨论需要一位由本机托管的 AI 主持人"))
    goal = str(payload.get("goal", room["goal"])).strip()
    if not goal or len(goal) > 1000:
        raise ValueError(Text("讨论目标须为 1–1000 字"))
    # The host fills in only the goal: limits are the owner's, so a host start takes the room's defaults.
    limits = limit_values({} if by_host else payload.get("limits", {}), room_limits_view(connection, room_id))
    named_followup = payload.get("named_followup", False)
    if type(named_followup) is not bool:
        raise ValueError(Text("named_followup 须为布尔值"))
    latest = connection.execute("SELECT COALESCE(MAX(m.id),0) FROM messages m WHERE m.room_id=? AND NOT EXISTS (SELECT 1 FROM internal_task_messages t WHERE t.message_id=m.id)", (room_id,)).fetchone()[0]
    created_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    cursor = connection.execute("INSERT INTO discussion_sessions(room_id,goal,status,started_message_id,created_at) VALUES(?,?,'active',?,?)", (room_id, goal, latest, created_at))
    session_id = cursor.lastrowid
    if submission:
        connection.execute("INSERT INTO session_start_submissions VALUES(?,?,?,?)",
                           (room_id, submission["submission_id"], session_id, submission["request_json"]))
    connection.execute("INSERT INTO session_state(session_id,phase,revision,read_until) VALUES(?,'initial',0,?)", (session_id, latest))
    connection.execute("INSERT INTO session_limits(session_id,max_rounds,max_minutes,execution_minutes,started_at) VALUES(?,?,?,?,?)",
        (session_id, limits["max_rounds"], limits["max_minutes"], limits["execution_minutes"], int(time.time())))
    connection.execute("INSERT INTO session_round_budgets(session_id) VALUES(?)", (session_id,))
    connection.execute("INSERT INTO session_pauses(session_id) VALUES(?)", (session_id,))
    connection.execute("INSERT INTO session_options(session_id,named_followup) VALUES(?,?)", (session_id, int(named_followup)))
    connection.execute("UPDATE rooms SET goal=? WHERE id=?", (goal, room_id))
    create_host_request(connection, session_id, f"请主持讨论：{goal}。先确认目标与限制，再安排第一位专家发言。",
                        {"kind": "session_started", "key": "start"})
    return {**session_room(connection, room_id), "duplicate": False}


def cancel_session_work(connection, session_id, reason):
    """Cancel queued and open session plans together with their linked requests and executions."""
    rows = connection.execute("SELECT sr.id,sr.member_request_id FROM session_requests sr WHERE sr.session_id=? AND sr.status IN ('queued','open')", (session_id,)).fetchall()
    for row in rows:
        if row["member_request_id"]:
            request = connection.execute("SELECT execution_id,status FROM member_requests WHERE id=?", (row["member_request_id"],)).fetchone()
            if request and request["status"] in ('pending','delivering'):
                if request["execution_id"]:
                    finish_execution(connection, request["execution_id"], "cancelled", reason, "cancelled", "user_stop")
                else:
                    connection.execute("UPDATE member_requests SET status='cancelled' WHERE id=?", (row["member_request_id"],))
        connection.execute("UPDATE session_requests SET status='cancelled' WHERE id=?", (row["id"],))


def session_member_change(connection, room_id, member, action):
    """Invalidate queued discussion work after a roster change and ask the host to re-plan."""
    session = current_session(connection, room_id, active_only=True)
    if not session:
        return
    member_rows = connection.execute("SELECT * FROM session_requests WHERE session_id=? AND member_id=? AND purpose='discuss' AND status IN ('open','queued','failed')",
                                    (session["id"], member["id"])).fetchall() if action in ("away", "remove") else []
    rows = connection.execute("SELECT * FROM session_requests WHERE session_id=? AND purpose='discuss' AND status='queued'",
                              (session["id"],)).fetchall()
    for row in rows:
        if row["member_request_id"]:
            request = connection.execute("SELECT execution_id,status FROM member_requests WHERE id=?", (row["member_request_id"],)).fetchone()
            if request and request["status"] == "pending":
                connection.execute("UPDATE member_requests SET status='cancelled' WHERE id=?", (row["member_request_id"],))
        connection.execute("UPDATE session_requests SET status='skipped' WHERE id=?", (row["id"],))
    for row in member_rows:
        if row["member_request_id"]:
            request = connection.execute("SELECT execution_id,status FROM member_requests WHERE id=?", (row["member_request_id"],)).fetchone()
            if request and request["status"] in ("pending", "delivering"):
                if request["execution_id"]:
                    finish_execution(connection, request["execution_id"], "cancelled", Text("成员已离开"), "cancelled", "member_away")
                else:
                    connection.execute("UPDATE member_requests SET status='cancelled' WHERE id=?", (row["member_request_id"],))
        connection.execute("UPDATE session_requests SET status='cancelled' WHERE id=? AND status='open'", (row["id"],))
        connection.execute("UPDATE session_requests SET status='skipped' WHERE id=? AND status='queued'", (row["id"],))
    connection.execute("UPDATE session_state SET revision=revision+1 WHERE session_id=?", (session["id"],))
    state_revision = connection.execute("SELECT revision FROM session_state WHERE session_id=?", (session["id"],)).fetchone()[0]
    if session["status"] == "active":
        detail = ("暂离" if action == "away" else "移除" if action == "remove" else "请回")
        create_host_request(connection, session["id"],
            f"专家 {member['name']} 已{detail}；剩余排队安排已作废，请检查当前发言并重新安排。",
            {"kind": "member_change", "key": f"member-{member['id']}-{action}-{state_revision}"})


def pause_session_for_host_change(connection, room_id):
    """Pause an active discussion and cancel its assignments before its host changes."""
    session = current_session(connection, room_id, active_only=True)
    if not session or session["status"] != "active":
        return
    cancel_session_work(connection, session["id"], Text("主持人已更换"))
    connection.execute("UPDATE discussion_sessions SET status='paused' WHERE id=?", (session["id"],))
    connection.execute("UPDATE session_pauses SET paused_at=? WHERE session_id=?", (int(time.time()), session["id"]))
    connection.execute("UPDATE session_state SET revision=revision+1 WHERE session_id=?", (session["id"],))


def end_session(connection, room_id, token, payload, reason="user_stop"):
    """Conclude the active session, snapshot its state and leave the room available for free collaboration."""
    require_owner(connection, room_id, token)
    begin_write(connection)
    current = session_room(connection, room_id)
    require_revision(current, payload, "结束讨论")
    session = current["session"]
    if not session:
        raise FileExistsError(Text("房间没有进行中的讨论"))
    return _conclude_session(connection, session, reason)


def _conclude_session(connection, session, reason):
    """Cancel session work, persist the conclusion snapshot and stop the session."""
    room_id = session["room_id"]
    session_id = session["id"]
    cancel_session_work(connection, session_id, Text("讨论已结束"))
    now = int(time.time())
    latest = connection.execute("SELECT COALESCE(MAX(m.id),0) FROM messages m WHERE m.room_id=? AND NOT EXISTS (SELECT 1 FROM internal_task_messages t WHERE t.message_id=m.id)", (room_id,)).fetchone()[0]
    connection.execute("UPDATE discussion_sessions SET status='concluded',ended_message_id=? WHERE id=?", (latest, session_id))
    connection.execute("UPDATE session_limits SET stop_reason=?,revision=revision+1 WHERE session_id=?", (reason, session_id))
    state = connection.execute("SELECT state_text,state_until FROM rooms WHERE id=?", (room_id,)).fetchone()
    brief = connection.execute("SELECT text,until FROM room_briefs WHERE room_id=?", (room_id,)).fetchone()
    started = session["started_message_id"]
    limits = connection.execute("SELECT max_rounds,max_minutes FROM session_limits WHERE session_id=?", (session_id,)).fetchone()
    connection.execute("INSERT OR REPLACE INTO discussion_conclusions(session_id,room_id,stop_reason,max_rounds,max_minutes,brief,state,state_until,concluded_at) VALUES(?,?,?,?,?,?,?,?,?)",
        (session_id, room_id, reason, limits["max_rounds"], limits["max_minutes"],
         brief["text"] if brief and brief["until"] > started else "", state["state_text"] if state["state_until"] > started else "",
         state["state_until"] if state["state_until"] > started else 0,
         time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now))))
    if reason in LIMIT_TEXTS:
        # Nobody is scheduled once a discussion hits its limit, so the host is woken once to wrap up or decide what's next.
        wake_host(connection, room_id, started or latest, LIMIT_TEXTS[reason](session_id), f"discussion_end:{session_id}")
    return session_room(connection, room_id)


LIMIT_TEXTS = {
    "round_limit": lambda session_id: Text("讨论 {session_id} 已到轮数上限并结束。请主持人决定：总结结论、告知用户，或请用户批准后再开一次讨论。", session_id=session_id),
    "time_limit": lambda session_id: Text("讨论 {session_id} 已到时长上限并结束。请主持人决定：总结结论、告知用户，或请用户批准后再开一次讨论。", session_id=session_id),
}


def discussion_action(connection, room_id, token, payload, room):
    """Start, pause, resume or end a session using the revision returned by GET /discussion."""
    action = payload.get("action")
    if action == "start":
        return start_session(connection, room_id, token, payload, room)
    require_owner(connection, room_id, token)
    begin_write(connection)
    current = session_room(connection, room_id)
    require_revision(current, payload, action or "讨论控制")
    session = current["session"]
    if not session:
        raise FileExistsError(Text("房间没有进行中的讨论"))
    if action == "end":
        return end_session(connection, room_id, token, payload)
    if action not in ("pause", "resume"):
        raise ValueError(Text("action 须为 start、pause、resume 或 end"))
    control_session(connection, session, action)
    return session_room(connection, room_id)


def control_session(connection, session, action):
    """Pause, resume or stop an open session; the owner's revision or `/discuss` command was checked by the caller."""
    if action == "stop":
        return _conclude_session(connection, session, "user_stop")
    if action == "pause":
        if session["status"] != "active":
            raise FileExistsError(Text("讨论已经暂停"))
        cancel_session_work(connection, session["id"], Text("用户暂停讨论"))
        connection.execute("UPDATE discussion_sessions SET status='paused' WHERE id=?", (session["id"],))
        connection.execute("UPDATE session_pauses SET paused_at=? WHERE session_id=?", (int(time.time()), session["id"]))
        connection.execute("UPDATE session_state SET revision=revision+1 WHERE session_id=?", (session["id"],))
    elif action == "resume":
        if session["status"] != "paused":
            raise FileExistsError(Text("讨论当前没有暂停"))
        pause = connection.execute("SELECT paused_at FROM session_pauses WHERE session_id=?", (session["id"],)).fetchone()[0]
        connection.execute("UPDATE discussion_sessions SET status='active' WHERE id=?", (session["id"],))
        connection.execute("UPDATE session_pauses SET paused_seconds=paused_seconds+MAX(0,?-paused_at),paused_at=0 WHERE session_id=?", (int(time.time()), session["id"]))
        connection.execute("UPDATE session_state SET revision=revision+1 WHERE session_id=?", (session["id"],))
        if pause:
            create_host_request(connection, session["id"], "讨论已恢复，请检查队列并继续。",
                                {"kind": "member_change", "key": f"resume-{session['id']}-{session['revision']}"})
    return None


def update_session_limits(connection, room_id, token, payload):
    """Update active-session limits using the state revision returned by GET /discussion."""
    require_owner(connection, room_id, token)
    begin_write(connection)
    current = session_room(connection, room_id)
    require_revision(current, payload, "修改讨论限制")
    session = current["session"]
    if not session:
        raise FileExistsError(Text("房间没有进行中的讨论会话"))
    if session["status"] != "paused":
        raise ValueError(Text("请先暂停讨论，再修改上限参数"))
    values = {key: value for key, value in payload.items() if key not in ("revision", "action", "actor")}
    if not values:
        raise ValueError(Text("至少提供一项讨论上限字段"))
    current_limits = {key: session["limits"][key] for key in ("max_rounds", "max_minutes", "execution_minutes")}
    limits = limit_values(values, current_limits)
    connection.execute("""UPDATE session_limits SET max_rounds=?,max_minutes=?,execution_minutes=?,revision=revision+1
        WHERE session_id=?""", (limits["max_rounds"], limits["max_minutes"],
        limits["execution_minutes"], session["id"]))
    connection.execute("UPDATE session_state SET revision=revision+1 WHERE session_id=?", (session["id"],))
    enforce_session_limits(connection, room_id)
    return session_room(connection, room_id)


def session_conclusion_view(connection, room_id):
    """Return conclusion blockers and a revision bound to the latest request-backed session state."""
    session = current_session(connection, room_id)
    if not session:
        return None
    held_since = connection.execute("SELECT held_since FROM session_state WHERE session_id=?", (session["id"],)).fetchone()[0]
    state_until = connection.execute("SELECT state_until FROM rooms WHERE id=?", (room_id,)).fetchone()[0]
    last_answer = connection.execute("""SELECT COALESCE(MAX(r.answer_id),0) FROM session_requests sr
        JOIN member_requests r ON r.id=sr.member_request_id
        WHERE sr.session_id=? AND sr.purpose='discuss' AND sr.status='answered'""", (session["id"],)).fetchone()[0]
    active = [list(row) for row in connection.execute("""SELECT id,round,position,member_id,status FROM session_requests
        WHERE session_id=? AND purpose='discuss' AND status='open' ORDER BY round,position,id""", (session["id"],))]
    queued = [list(row) for row in connection.execute("""SELECT id,round,position,member_id,status FROM session_requests
        WHERE session_id=? AND purpose='discuss' AND status='queued' ORDER BY round,position,id""", (session["id"],))]
    latest = connection.execute("""SELECT COALESCE(MAX(id),0) FROM messages WHERE room_id=?
        AND NOT EXISTS(SELECT 1 FROM internal_task_messages WHERE message_id=messages.id)""", (room_id,)).fetchone()[0]
    blockers = []
    blocker_codes = []
    if held_since:
        blocker_codes.append("pending_input")
        blockers.append(Text("有未处理的用户留言或设置变更"))
    if state_until < last_answer:
        blocker_codes.append("state_outdated")
        blockers.append(Text("状态整理至 #{state_until}，未覆盖最新发言 #{last_answer}；先更新 state 与简报", state_until=state_until, last_answer=last_answer))
    if active:
        blocker_codes.append("active_speakers")
        blockers.append(Text("仍有专家正在发言"))
    if queued:
        blocker_codes.append("queued_speakers")
        blockers.append(Text("仍有排队的发言安排"))
    revision = _hash_revision([_session_revision(connection, session), latest, state_until, last_answer,
                               held_since, active, queued])
    return {"latest_id": latest, "last_opinion_id": last_answer, "state_until": state_until,
            "held_since": held_since, "queued": len(queued), "active": len(active),
            "blockers": blockers, "blocker_codes": blocker_codes, "blockers_text": [text_payload(item) for item in blockers],
            "ready": not blockers, "revision": revision}


def conclude_session_by_host(connection, room_id, payload):
    """Let the host finish a ready discussion after reading its conclusion revision."""
    begin_write(connection)
    session = current_session(connection, room_id, active_only=True)
    if not session or session["status"] != "active":
        raise FileExistsError(Text("只有进行中的讨论可以由主持人收束"))
    view = session_conclusion_view(connection, room_id)
    if payload.get("conclusion") is None:
        raise ValueError(Text("收束前须先读取收束状态（room conclusion），并带上其 revision"))
    if str(payload["conclusion"]) != view["revision"]:
        raise FileExistsError(Text("讨论状态已变化，请重新读取 room conclusion 后再收束"))
    blockers = tuple(code for code in view["blocker_codes"] if code != "queued_speakers")
    if blockers:
        state_until, last_answer = view["state_until"], view["last_opinion_id"]
        errors = {
            ("pending_input",): Text("暂不能收束：有未处理的用户留言或设置变更"),
            ("state_outdated",): Text("暂不能收束：状态整理至 #{state_until}，未覆盖最新发言 #{last_answer}；先更新 state 与简报", state_until=state_until, last_answer=last_answer),
            ("active_speakers",): Text("暂不能收束：仍有专家正在发言"),
            ("pending_input", "state_outdated"): Text("暂不能收束：有未处理的用户留言或设置变更；状态整理至 #{state_until}，未覆盖最新发言 #{last_answer}；先更新 state 与简报", state_until=state_until, last_answer=last_answer),
            ("pending_input", "active_speakers"): Text("暂不能收束：有未处理的用户留言或设置变更；仍有专家正在发言"),
            ("state_outdated", "active_speakers"): Text("暂不能收束：状态整理至 #{state_until}，未覆盖最新发言 #{last_answer}；先更新 state 与简报；仍有专家正在发言", state_until=state_until, last_answer=last_answer),
            ("pending_input", "state_outdated", "active_speakers"): Text("暂不能收束：有未处理的用户留言或设置变更；状态整理至 #{state_until}，未覆盖最新发言 #{last_answer}；先更新 state 与简报；仍有专家正在发言", state_until=state_until, last_answer=last_answer),
        }
        raise ValueError(errors[blockers])
    reason = payload.get("continue")
    if reason is not None and (not isinstance(reason, str) or not reason.strip() or len(reason) > MAX_CONTINUE_REASON):
        raise ValueError(Text("continue 写明讨论结束后继续做什么，最多 {max_continue_reason} 字", max_continue_reason=MAX_CONTINUE_REASON))
    host = connection.execute("SELECT * FROM room_members WHERE room_id=? AND role='host' AND status='active'", (room_id,)).fetchone()
    turn = connection.execute("""SELECT r.message_id,r.chain_id FROM session_requests sr JOIN member_requests r ON r.id=sr.member_request_id
        WHERE sr.session_id=? AND sr.purpose='discuss_host' AND sr.member_id=? AND sr.status='open' AND r.status='delivering'
        ORDER BY r.id DESC LIMIT 1""", (session["id"], host["id"])).fetchone() if host else None
    # The host ending the discussion is its own turn's result, not work the ending cancels: the turn completes, so the
    # runner lets the software finish instead of stopping it as if the user had.
    if host:
        _complete_host_work(connection, session["id"], host["id"], Text("主持人已收束讨论"))
    result = _conclude_session(connection, session, "goal_done")
    if host and reason:
        # Work the user left for after the discussion wakes the host once the room is idle, like a free-room `continue`.
        message_id, chain_id = (turn["message_id"], turn["chain_id"]) if turn else (session["started_message_id"],) * 2
        remember_continue(connection, room_id, host, message_id, chain_id, {"continue": reason})
        resume_host(connection, room_id)
    return result


def _host_interjections(connection, session_id):
    """Read pending user interjections with their original source and execution."""
    return [dict(row) for row in connection.execute("""SELECT r.id,r.status,r.execution_id,
        q.id AS session_request_id,t.cause_message_id AS message_id
        FROM session_requests q JOIN member_requests r ON r.id=q.member_request_id
        JOIN task_message_sources t ON t.session_request_id=q.id
        JOIN messages m ON m.id=t.cause_message_id
        WHERE q.session_id=? AND q.purpose='discuss_host' AND q.status='open'
        AND r.status IN ('pending','delivering') AND t.cause_kind='user_message' AND m.author='用户'
        AND NOT EXISTS(SELECT 1 FROM message_withdrawals w WHERE w.message_id=m.id)
        ORDER BY r.id""", (session_id,))]


def _session_roster(connection, session_id):
    """Build active experts and their answered state for this session's current round."""
    session = connection.execute("SELECT room_id,status FROM discussion_sessions WHERE id=?", (session_id,)).fetchone()
    session_state = connection.execute("SELECT phase,revision,read_until,held_since FROM session_state WHERE session_id=?", (session_id,)).fetchone()
    max_round = connection.execute("""SELECT MIN(round) FROM session_requests
        WHERE session_id=? AND purpose='discuss' AND status IN ('queued','open')""", (session_id,)).fetchone()[0]
    if max_round is None:
        max_round = connection.execute("SELECT COALESCE(MAX(round),1) FROM session_requests WHERE session_id=? AND purpose='discuss'", (session_id,)).fetchone()[0]
    answered = {row[0] for row in connection.execute("SELECT member_id FROM session_requests WHERE session_id=? AND purpose='discuss' AND round=? AND status='answered'", (session_id, max_round))}
    members = [dict(row) for row in connection.execute("""SELECT m.id,m.name,m.role,m.access,m.status,m.token_hash,
        COALESCE(r.token_hash,'') AS registration_hash
        FROM room_members m LEFT JOIN member_registrations r ON r.member_id=m.id
        WHERE m.room_id=? AND m.status='active' ORDER BY m.id""", (session["room_id"],))]
    experts = []
    shown = member_display_names(connection, session["room_id"])
    for member in members:
        if member["access"] == "external" and member["name"] not in active_members(connection, session["room_id"]):
            continue
        registered = member["access"] != "manual" or member["registration_hash"] == member["token_hash"]
        experts.append({"id": member["id"],"name":member["name"],"label":shown.get(member["name"], member["name"]),
                        "host":member["role"] == "host", "mode":member["access"],
                        "spoken":member["id"] in answered, "registered":registered})
    experts.sort(key=lambda item: (item["host"], next(member["id"] for member in members if member["name"]==item["name"])))
    waiting = [item["name"] for item in experts if not item["host"] and not item["spoken"] and item["registered"]]
    unregistered = [item["name"] for item in experts if not item["registered"]]
    queue = [list(row) for row in connection.execute("""SELECT id,round,position,member_id,status,submission_id
        FROM session_requests WHERE session_id=? AND purpose='discuss' ORDER BY id""", (session_id,))]
    limits = list(connection.execute("SELECT max_rounds,max_minutes,execution_minutes FROM session_limits WHERE session_id=?", (session_id,)).fetchone())
    latest_visible = connection.execute("""SELECT COALESCE(MAX(m.id),0) FROM messages m WHERE m.room_id=?
        AND NOT EXISTS (SELECT 1 FROM internal_task_messages t WHERE t.message_id=m.id)""", (session["room_id"],)).fetchone()[0]
    host_requests = _host_interjections(connection, session_id)
    state = [session_id, session["status"], list(session_state), latest_visible, max_round, host_requests,
             [[item['id'], item['name'], item['host'], item['spoken'], item['registered']] for item in experts], queue, limits]
    return {"experts":experts,"waiting":waiting,"unregistered":unregistered,"round":max_round,
            "revision":_hash_revision(state), "host_requests":host_requests,
            "status":session["status"], "held_since":session_state["held_since"], "queue":queue}


def roster_view(connection, room_id):
    """Expose the current session roster and revision required by a multi-speaker plan."""
    session = current_session(connection, room_id)
    if not session:
        raise FileExistsError(Text("房间没有进行中的讨论会话"))
    roster = {**_session_roster(connection, session["id"]),"session_id":session["id"]}
    read_until = _discussion_read_cutoff(connection, session["id"])
    if read_until is not None:
        # Said before the host writes questions (D1): an instruction to read past the boundary cannot be followed.
        roster["reading"] = {"phase": "initial", "read_until": read_until, "note": Text(
            "独立观点阶段：本轮专家只能读到 #{until} 及之前的消息；题干里“先读最新回答”之类读取之后内容的要求无法执行，请把需要的材料写进题干或改到交叉讨论阶段",
            until=read_until)}
    return roster


def query_session_requests(connection, room_id, params=None):
    """Read request plans for the current session with fields compatible with the legacy turns view."""
    session = current_session(connection, room_id)
    if not session:
        return {"turns":[],"page":1,"pages":1,"total":0}
    params = params or {}
    page = max(1,int(params.get("page",1)))
    where = "session_id=? AND purpose='discuss'"
    values = [session["id"]]
    if "submission_id" in params:
        where += " AND submission_id=?"
        values.append(str(params["submission_id"]))
    total = connection.execute(f"SELECT COUNT(*) FROM session_requests WHERE {where}",values).fetchone()[0]
    rows = connection.execute(f"SELECT * FROM session_requests WHERE {where} ORDER BY round,position,id LIMIT 20 OFFSET ?",[*values,(page-1)*20]).fetchall()
    members = {row["id"]:row["name"] for row in connection.execute("SELECT id,name FROM room_members WHERE room_id=?",(room_id,))}
    turns = []
    for row in rows:
        item = dict(row)
        item.update(expert=members.get(item["member_id"],""),status_label=item["status"])
        turns.append(item)
    return {"turns":turns,"page":page,"pages":max(1,(total+19)//20),"total":total}


def get_session_request(connection, room_id, plan_id):
    """Read one session plan by its durable identifier, including its member name."""
    row = connection.execute("""SELECT sr.*,m.name AS expert,s.room_id FROM session_requests sr
        JOIN discussion_sessions s ON s.id=sr.session_id JOIN room_members m ON m.id=sr.member_id
        WHERE s.room_id=? AND sr.id=? AND sr.purpose='discuss'""", (room_id, int(plan_id))).fetchone()
    if not row:
        raise LookupError(Text("讨论安排不存在"))
    return dict(row)


def create_plan(connection, room_id, payload, room):
    """Store one speaker or an ordered round, opening only its first deliverable request."""
    begin_write(connection)
    session = current_session(connection, room_id, active_only=True)
    if not session:
        raise FileExistsError(Text("房间没有进行中的讨论会话"))
    if room["archived"] or session["status"] != "active":
        raise ValueError(Text("讨论已暂停或房间已存档"))
    actor = payload.get("actor")
    host = connection.execute("SELECT id FROM room_members WHERE room_id=? AND name=? AND role='host' AND status='active'",(room_id,actor)).fetchone()
    if not host:
        raise ValueError(Text("请使用当前 AI 主持人身份安排发言"))
    if payload.get("roster") is None:
        raise ValueError(Text("安排发言前须先获取 turn roster 并带上 revision"))
    base_id, plan = _validated_plan(payload)
    existing = _existing_plan(connection, session["id"], base_id)
    if existing:
        return _check_duplicate_plan(connection, existing, plan)
    roster = _session_roster(connection, session["id"])
    if payload["roster"] != roster["revision"]:
        raise FileExistsError(Text("专家状态已变化，请重新获取 turn roster 后再安排"))
    _validate_plan_members(connection, room_id, plan)
    entries = _number_plan_entries(connection, session["id"], plan, roster)
    if len(plan) > 1:
        first_round_names = {item[1] for item in entries if item[3] == roster["round"]}
        # The expert speaking now has its turn this round already; re-planning the rest must not demand it again (R5).
        speaking = {row[0] for row in connection.execute("""SELECT m.name FROM session_requests sr JOIN room_members m ON m.id=sr.member_id
            WHERE sr.session_id=? AND sr.purpose='discuss' AND sr.round=? AND sr.status='open'""", (session["id"], roster["round"]))}
        missing = [name for name in roster["waiting"] if name not in first_round_names and name not in speaking]
        if missing:
            raise ValueError(Text("整轮安排缺少本轮尚未发言的专家：{value1}", value1='、'.join(missing)))
    read_until = _discussion_read_cutoff(connection, session["id"])
    inserted = _insert_plan_rows(connection, session["id"], entries, read_until)
    # Planning is the host's completed response; close its current host request in this transaction.
    _complete_host_work(connection,session['id'],host['id'],"主持人已提交发言安排")
    advance_session(connection,session['id'])
    connection.execute("UPDATE session_state SET revision=revision+1 WHERE session_id=?", (session['id'],))
    return {"turn":dict(connection.execute("SELECT * FROM session_requests WHERE id=?",(inserted[0],)).fetchone()),
            "queued":[dict(connection.execute("SELECT * FROM session_requests WHERE id=?",(item,)).fetchone()) for item in inserted[1:]],"duplicate":False}


def _validated_plan(payload):
    """Validate the host's one-speaker or ordered multi-speaker plan payload."""
    items = payload.get("turns")
    if items is None:
        items = [{"expert": payload.get("expert", ""), "question": payload.get("question", "")}]
    if not isinstance(items, list) or not 1 <= len(items) <= MAX_PLAN_TURNS:
        raise ValueError(Text("整轮安排需要 1–{max_plan_turns} 项", max_plan_turns=MAX_PLAN_TURNS))
    base_id = str(payload.get("submission_id", "")).strip()
    if not 8 <= len(base_id) <= 100:
        raise ValueError(Text("submission_id 须为 8–100 字符"))
    plan = []
    for index, item in enumerate(items):
        if not isinstance(item, dict):
            raise ValueError(Text("每项安排需要 expert 和 question"))
        name = str(item.get("expert", "")).strip()
        question = str(item.get("question", "")).strip()
        if not name or not question or len(question) > MAX_QUESTION_LENGTH:
            raise ValueError(Text("请选择专家并提供不超过 1000 字的问题"))
        submission_id = base_id if index == 0 else f"{base_id}-q{index + 1}"
        plan.append((name, question, submission_id))
    return base_id, plan


def _validate_plan_members(connection, room_id, plan):
    """Require each scheduled participant to be active and any manual member registered."""
    for name, _, _ in plan:
        member = connection.execute("""SELECT * FROM room_members m
            WHERE m.room_id=? AND m.name=? AND m.status='active'""",
                                    (room_id, name)).fetchone()
        if not member or (member["access"] == "external" and name not in active_members(connection, room_id)):
            raise ValueError(Text("安排对象 {name} 不是在场专家", name=name))
        if member["access"] == "manual" and not connection.execute(
                "SELECT 1 FROM member_registrations WHERE member_id=? AND token_hash=?",
                (member["id"], member["token_hash"])).fetchone():
            raise ValueError(Text("手动专家 {name} 尚未注册", name=name))


def _discussion_read_cutoff(connection, session_id):
    """Freeze the current boundary for independent opinions; NULL allows later discussion reads."""
    state = connection.execute("SELECT phase,read_until FROM session_state WHERE session_id=?", (session_id,)).fetchone()
    return state["read_until"] if state["phase"] == "initial" else None


def _number_plan_entries(connection, session_id, plan, roster):
    """Split a plan into rounds when a member repeats in the current queue."""
    round_number = roster["round"]
    answered = {item["id"] for item in roster["experts"] if item["spoken"]}
    if not connection.execute("SELECT 1 FROM session_requests WHERE session_id=? AND purpose='discuss'", (session_id,)).fetchone():
        round_number = 1
        answered = set()
    positions = {row[0]: row[1] for row in connection.execute("""SELECT round,MAX(position)
        FROM session_requests WHERE session_id=? AND purpose='discuss' GROUP BY round""", (session_id,))}
    members = {row["name"]: row["id"] for row in connection.execute("""SELECT id,name FROM room_members
        WHERE room_id=(SELECT room_id FROM discussion_sessions WHERE id=?)""", (session_id,))}
    entries = []
    for name, question, submission_id in plan:
        member_id = members[name]
        if member_id in answered:
            round_number += 1
            answered = set()
        positions[round_number] = positions.get(round_number, 0) + 1
        entries.append((member_id, name, question, round_number, positions[round_number], submission_id))
        answered.add(member_id)
    return entries


def _insert_plan_rows(connection, session_id, entries, read_until):
    """Persist all plan entries atomically in queue order."""
    inserted = []
    for member_id, _, question, round_number, position, submission_id in entries:
        entry_cutoff = read_until if round_number == 1 else None
        cursor = connection.execute("""INSERT INTO session_requests
            (session_id,round,position,member_id,purpose,question,status,submission_id,read_until,created_at)
            VALUES(?,?,?,?,'discuss',?,'queued',?,?,?)""",
            (session_id, round_number, position, member_id, question, submission_id, entry_cutoff,
             time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())))
        inserted.append(cursor.lastrowid)
    return inserted


def _existing_plan(connection, session_id, base_id):
    """Find all stored entries for one base submission, including queued suffixes."""
    pattern = f"{base_id}-q[0-9]*"
    return [dict(row) for row in connection.execute("""SELECT * FROM session_requests
        WHERE session_id=? AND (submission_id=? OR submission_id GLOB ?)
        ORDER BY id""", (session_id, base_id, pattern))]


def _check_duplicate_plan(connection, existing, plan):
    """Return an exact replay and reject any reuse of the base id with changed entries."""
    expected_ids = [item[2] for item in plan]
    actual_ids = [item["submission_id"] for item in existing]
    room_id = connection.execute("SELECT room_id FROM discussion_sessions WHERE id=?", (existing[0]["session_id"],)).fetchone()[0]
    members = {row["name"]: row["id"] for row in connection.execute("SELECT id,name FROM room_members WHERE room_id=?", (room_id,))}
    exact = actual_ids == expected_ids
    for row, (name, question, _) in zip(existing, plan):
        exact = exact and row["member_id"] == members.get(name)
        exact = exact and row["question"] == question
    if not exact:
        raise FileExistsError(Text("这个 submission_id 已用于不同的安排内容；请核对原提交后再使用新编号"))
    return {"turn": existing[0], "queued": existing[1:], "duplicate": True}


def _complete_host_work(connection, session_id, host_id, result):
    """Treat host planning as completion of the host's assigned request and execution."""
    rows = connection.execute("""SELECT DISTINCT r.id AS request_id,r.execution_id,r.status AS request_status,e.status AS execution_status
        FROM session_requests sr JOIN member_requests r ON r.id=sr.member_request_id
        LEFT JOIN member_executions e ON e.id=r.execution_id WHERE sr.session_id=? AND sr.purpose='discuss_host' AND sr.member_id=?
        AND sr.status='open' AND r.status IN ('pending','delivering')""", (session_id, host_id)).fetchall()
    executions = {row["execution_id"] for row in rows
                  if row["request_status"] == "delivering" and row["execution_status"] in ("dispatched", "started")}
    selected = ([row for row in rows if row["execution_id"] in executions]
                if executions else [row for row in rows if row["request_status"] == "pending"])
    request_ids = [row["request_id"] for row in selected]
    for execution_id in executions:
        finish_execution(connection, execution_id, "completed", result, "completed")
    if request_ids:
        placeholders = ",".join("?" for _ in request_ids)
        connection.execute(f"UPDATE member_requests SET status='completed' WHERE id IN ({placeholders}) AND status='pending'",
                           request_ids)
        connection.execute(f"UPDATE session_requests SET status='answered' WHERE member_request_id IN ({placeholders})",
                           request_ids)


def complete_session_requests(connection, room_id, payload, actor, message_id):
    """Mark session requests covered by one free-room answer and continue the discussion plan."""
    if actor == "用户" or actor is None:
        return
    request_ids = payload.get("request_ids", [])
    if type(payload.get("execution_id")) is int:
        rows = connection.execute("SELECT id FROM member_requests WHERE execution_id=?", (payload["execution_id"],)).fetchall()
        request_ids = [row["id"] for row in rows]
    if not request_ids:
        return
    placeholders = ",".join("?" for _ in request_ids)
    rows = connection.execute(f"""SELECT sr.id,sr.session_id,sr.purpose,sr.member_id,sr.member_request_id,m.name
        FROM member_requests r JOIN session_requests sr ON sr.member_request_id=r.id
        JOIN room_members m ON m.id=sr.member_id WHERE r.id IN ({placeholders}) AND sr.status='open'""",
        request_ids).fetchall()
    for row in rows:
        if row["purpose"] == "discuss":
            connection.execute("UPDATE session_requests SET status='answered' WHERE id=?", (row["id"],))
            _advance_after_answer(connection, dict(row), message_id)
        else:
            connection.execute("UPDATE session_requests SET status='answered' WHERE id=?", (row["id"],))
            connection.execute("UPDATE session_state SET revision=revision+1 WHERE session_id=?", (row["session_id"],))


def _advance_after_answer(connection, request, answer_id):
    """Promote the next queued speaker or ask the host to choose what comes next."""
    session_id = request["session_id"]
    session_row = connection.execute("SELECT * FROM discussion_sessions WHERE id=?", (session_id,)).fetchone()
    roster = _session_roster(connection, session_id)
    _advance_initial_phase(connection, session_id)
    if enforce_session_limits(connection, session_row["room_id"]):
        return
    if advance_session(connection, session_id):
        return
    if connection.execute("SELECT 1 FROM session_requests WHERE session_id=? AND purpose='discuss' AND status='queued' LIMIT 1",
                           (session_id,)).fetchone():
        return
    cause_kind = "round_complete" if not roster["waiting"] else "speaker_answered"
    question = (Text("专家 {name} 已回答 #{answer_id}，请继续安排本轮尚未发言的专家。", name=request["name"], answer_id=answer_id)
                if roster["waiting"] else Text("第 {round} 轮已完成，请判断是否开始下一轮或收束讨论。", round=roster["round"]))
    create_host_request(connection, session_id, question,
                        {"kind": cause_kind, "message_id": answer_id, "request_id": request["member_request_id"],
                         "key": f"answer-{request['member_request_id']}"})
    connection.execute("UPDATE session_state SET revision=revision+1 WHERE session_id=?", (session_id,))


def _advance_initial_phase(connection, session_id):
    """Switch out of independent opinions after all scheduled first-round experts answer."""
    state = connection.execute("SELECT phase FROM session_state WHERE session_id=?", (session_id,)).fetchone()
    if not state or state["phase"] != "initial":
        return
    denominator = _expert_denominator(connection, session_id, 1)
    answered = connection.execute("SELECT COUNT(*) FROM session_requests WHERE session_id=? AND purpose='discuss' AND round=1 AND status='answered'", (session_id,)).fetchone()[0]
    if denominator and answered >= denominator:
        connection.execute("UPDATE session_state SET phase='discussing',revision=revision+1 WHERE session_id=?", (session_id,))


def _expert_denominator(connection, session_id, round_number=None):
    """Count registered active experts, plus the host only if that round explicitly schedules them."""
    room_id = connection.execute("SELECT room_id FROM discussion_sessions WHERE id=?", (session_id,)).fetchone()[0]
    from .free_room import REGISTERED_MEMBER
    count = connection.execute(f"""SELECT COUNT(*) FROM room_members
        WHERE room_id=? AND status='active' AND role<>'host' AND {REGISTERED_MEMBER}""", (room_id,)).fetchone()[0]
    host_sql = "SELECT 1 FROM session_requests WHERE session_id=? AND purpose='discuss' AND member_id IN (SELECT id FROM room_members WHERE room_id=? AND role='host')"
    values = [session_id, room_id]
    if round_number is not None:
        host_sql += " AND round=?"
        values.append(round_number)
    if connection.execute(host_sql, values).fetchone():
        count += 1
    return count


def _at_round_limit(connection, session_id):
    """Check answered-opinion rounds and active-time limits without waiting for full roster coverage."""
    limits = connection.execute("SELECT max_rounds,max_minutes,started_at FROM session_limits WHERE session_id=?", (session_id,)).fetchone()
    pause = connection.execute("SELECT paused_seconds FROM session_pauses WHERE session_id=?", (session_id,)).fetchone()[0]
    denominator = _expert_denominator(connection, session_id)
    answered = connection.execute("SELECT COUNT(*) FROM session_requests WHERE session_id=? AND purpose='discuss' AND status='answered'", (session_id,)).fetchone()[0]
    rounds_done = denominator and limits["max_rounds"] > 0 and answered // denominator >= limits["max_rounds"]
    elapsed = max(0, int(time.time()) - limits["started_at"] - pause)
    time_done = limits["max_minutes"] > 0 and elapsed >= limits["max_minutes"] * 60
    return rounds_done or time_done


def fail_session_request(connection, request_id, reason):
    """Fail one discussion speaker request and hand its recovery decision to the host."""
    row = connection.execute("""SELECT sr.id,sr.session_id,sr.member_id,m.name,s.room_id
        FROM session_requests sr JOIN discussion_sessions s ON s.id=sr.session_id
        JOIN room_members m ON m.id=sr.member_id WHERE sr.member_request_id=? AND sr.purpose='discuss'""",
        (request_id,)).fetchone()
    if not row:
        return
    connection.execute("UPDATE session_requests SET status='failed' WHERE id=? AND status='open'", (row["id"],))
    create_host_request(connection, row["session_id"],
        Text("专家 {name} 的讨论请求失败：{reason}。请决定跳过、重排或暂停。", name=row["name"], reason=str(reason)),
        {"kind": "request_failed", "request_id": request_id, "key": f"failed-{request_id}"})
    connection.execute("UPDATE session_state SET revision=revision+1 WHERE session_id=?", (row["session_id"],))


def _live_continuation(connection, execution_id):
    """The live execution a completed one continues in after the host's keep_working, or None."""
    seen = set()
    while execution_id and execution_id not in seen:
        seen.add(execution_id)
        link = connection.execute("SELECT next_id FROM execution_continuations WHERE execution_id=?", (execution_id,)).fetchone()
        if not link:
            return None
        row = connection.execute("SELECT id,member_id,status,lease_until FROM member_executions WHERE id=?", (link[0],)).fetchone()
        if row and row["status"] in ("dispatched", "started"):
            return row
        execution_id = row["id"] if row and row["status"] == "completed" else None
    return None


def session_message_access(connection, room_id, params, token=""):
    """Resolve a member's read boundary while validating any request or execution binding."""
    execution_id = _optional_identifier(params, "execution_id")
    request_id = _optional_identifier(params, "request_id")
    if execution_id and request_id:
        raise ValueError(Text("execution_id 与 request_id 不能同时使用"))
    member = None
    if execution_id or request_id or token:
        try:
            member = require_member(connection, room_id, token) if token else None
        except PermissionError:
            if execution_id or request_id:
                raise
    if (execution_id or request_id) and not member:
        raise PermissionError(Text("读取执行上下文须使用该成员的凭证"))
    rows = []
    if execution_id:
        execution = connection.execute("SELECT member_id,status,lease_until FROM member_executions WHERE room_id=? AND id=?",
                                       (room_id, execution_id)).fetchone()
        if not execution or execution["member_id"] != member["id"]:
            raise PermissionError(Text("执行编号不属于该成员"))
        if execution["status"] == "completed":
            # A host that dispatched with keep_working goes on in the execution its answer moved onto (K21); its
            # credential still names the answered one, as answers already follow the same link.
            live = _live_continuation(connection, execution_id)
            if live:
                execution, execution_id = live, live["id"]
        if execution["status"] not in ("dispatched", "started") or execution["lease_until"] <= int(time.time()):
            raise FileExistsError(Text("执行已结束或过期，不能继续读取其上下文"))
        rows = connection.execute("""SELECT sr.* FROM member_requests r JOIN session_requests sr
            ON sr.member_request_id=r.id WHERE r.execution_id=?""", (execution_id,)).fetchall()
        _require_live_session_rows(connection, rows, execution["status"], "delivering")
    elif request_id:
        request = connection.execute("SELECT * FROM member_requests WHERE room_id=? AND id=?", (room_id, request_id)).fetchone()
        if not request or request["member_id"] != member["id"]:
            raise PermissionError(Text("请求编号不属于该成员"))
        if request["status"] not in ("pending", "delivering"):
            raise FileExistsError(Text("请求已结束，不能继续读取其上下文"))
        if request["status"] == "delivering":
            execution = connection.execute("SELECT status,lease_until FROM member_executions WHERE id=? AND member_id=?",
                                           (request["execution_id"], member["id"])).fetchone() if request["execution_id"] else None
            if not execution or execution["status"] not in ("dispatched", "started") or execution["lease_until"] <= int(time.time()):
                raise FileExistsError(Text("请求对应的执行已结束或过期，不能继续读取其上下文"))
        rows = connection.execute("SELECT * FROM session_requests WHERE member_request_id=?", (request_id,)).fetchall()
        _require_live_session_rows(connection, rows, "", request["status"])
    cutoffs = [row["read_until"] for row in rows
               if row["purpose"] == "discuss" and row["read_until"] is not None]
    cutoff = min(cutoffs) if cutoffs else None
    if not rows and member and not execution_id and not request_id:
        current = connection.execute("""SELECT sr.read_until FROM member_requests r
            JOIN session_requests sr ON sr.member_request_id=r.id
            JOIN discussion_sessions s ON s.id=sr.session_id
            WHERE s.room_id=? AND s.status='active' AND sr.status='open' AND sr.purpose='discuss'
            AND r.member_id=? AND r.status IN ('pending','delivering') ORDER BY sr.id LIMIT 1""",
            (room_id, member["id"])).fetchone()
        if current:
            cutoff = current["read_until"]
    if not execution_id and not request_id:
        session = current_session(connection, room_id, active_only=True)
        if session and connection.execute("SELECT phase FROM session_state WHERE session_id=?", (session["id"],)).fetchone()[0] == "initial":
            owner_hash = connection.execute("SELECT control_hash FROM room_modes WHERE room_id=?", (room_id,)).fetchone()
            is_owner = bool(token and owner_hash and token_hash(token) == owner_hash[0])
            is_host = bool(member and member["role"] == "host")
            if not is_owner and not is_host and cutoff is None:
                cutoff = connection.execute("SELECT read_until FROM session_state WHERE session_id=?", (session["id"],)).fetchone()[0]
    return cutoff


def _require_live_session_rows(connection, rows, execution_status, request_status):
    """Permit session context only while its request and session are still open."""
    if not rows:
        return
    if execution_status and execution_status not in ("dispatched", "started"):
        raise FileExistsError(Text("讨论执行已结束，不能继续读取其上下文"))
    if request_status not in ("pending", "delivering"):
        raise FileExistsError(Text("讨论请求已失效，不能继续读取其上下文"))
    for row in rows:
        session = connection.execute("SELECT status FROM discussion_sessions WHERE id=?", (row["session_id"],)).fetchone()
        if not session or session["status"] != "active" or row["status"] != "open":
            raise FileExistsError(Text("讨论请求已暂停、结束或取消，不能继续读取其上下文"))


def _optional_identifier(params, field):
    """Parse an optional positive identifier from request query parameters."""
    value = params.get(field)
    if value is None or value == "":
        return None
    try:
        identifier = int(value)
    except (TypeError, ValueError) as error:
        raise ValueError(Text("{field} 须为正整数", field=field)) from error
    if identifier <= 0:
        raise ValueError(Text("{field} 须为正整数", field=field))
    return identifier


def _ask_receipt(connection, room_id, payload):
    """Return a durable matching conversion, rejecting reuse for another request or member."""
    receipt = connection.execute("""SELECT s.source_request_id,r.*,m.name AS expert,e.status AS source_execution_status
        FROM session_ask_submissions s JOIN member_requests r ON r.id=s.request_id
        JOIN room_members m ON m.id=r.member_id JOIN member_requests original ON original.id=s.source_request_id
        LEFT JOIN member_executions e ON e.id=original.execution_id WHERE s.room_id=? AND s.submission_id=?""",
        (room_id, payload["submission_id"])).fetchone()
    if not receipt:
        return None
    if receipt["source_request_id"] != payload.get("request_id") or receipt["expert"] != payload.get("expert"):
        raise FileExistsError(Text("提交编号已用于其他追问"))
    request = dict(receipt)
    completed = request.pop("source_execution_status") == "completed"
    return {"request": request, "duplicate": True, "execution_completed": completed}


def _finish_interjection(connection, session_id, source):
    """Close only this source request and finish its execution only when no work remains."""
    connection.execute("UPDATE member_requests SET status='completed' WHERE id=?", (source["id"],))
    connection.execute("UPDATE session_requests SET status='answered' WHERE id=?", (source["session_request_id"],))
    execution_id = source["execution_id"]
    completed = bool(execution_id) and not connection.execute(
        "SELECT 1 FROM member_requests WHERE execution_id=? AND status='delivering'", (execution_id,)).fetchone()
    if completed:
        connection.execute("""UPDATE member_executions SET status='completed',finished_at=?,result='interjection_asked'
            WHERE id=? AND status IN ('dispatched','started')""", (int(time.time()), execution_id))
    remaining = _host_interjections(connection, session_id)
    held_since = min((item["message_id"] for item in remaining), default=0)
    connection.execute("UPDATE session_state SET held_since=?,revision=revision+1 WHERE session_id=?", (held_since, session_id))
    return completed


def ask_interjection(connection, room_id, payload, room):
    """Convert one versioned host interjection into a normal ask without changing discussion turns."""
    begin_write(connection)
    if not re.fullmatch(r"[A-Za-z0-9_-]{8,100}", str(payload.get("submission_id", ""))):
        raise ValueError(Text("submission_id 须为 8–100 位字母、数字、下划线或短横线"))
    if payload.get("revision") is None:
        raise ValueError(Text("转交追问前须先读取 turn roster 并提交 revision"))
    duplicate = _ask_receipt(connection, room_id, payload)
    if duplicate:
        return duplicate
    session = current_session(connection, room_id, active_only=True)
    if not session or session["status"] != "active" or room["archived"]:
        raise FileExistsError(Text("讨论未处于进行状态"))
    roster = _session_roster(connection, session["id"])
    require_revision(roster, payload, "转交追问")
    source = next((item for item in roster["host_requests"] if item["id"] == payload.get("request_id")), None)
    if not source:
        raise FileExistsError(Text("原用户留言请求已不可转交"))
    member = next((item for item in roster["experts"] if item["name"] == payload.get("expert") and item["registered"]), None)
    if not member:
        raise ValueError(Text("请选择在场且已注册的成员"))
    connection.execute("""INSERT OR IGNORE INTO member_requests
        (room_id,member_id,message_id,chain_id,purpose,created_by,created_at) VALUES(?,?,?,?,'ask','user',?)""",
        (room_id, member["id"], source["message_id"], source["message_id"], int(time.time())))
    request = dict(connection.execute("SELECT * FROM member_requests WHERE member_id=? AND message_id=?",
                                     (member["id"], source["message_id"])).fetchone())
    connection.execute("INSERT INTO session_ask_submissions VALUES(?,?,?,?)",
                       (room_id, payload["submission_id"], source["id"], request["id"]))
    completed = _finish_interjection(connection, session["id"], source)
    return {"request": request, "duplicate": False, "execution_completed": completed}


def continue_plan(connection, room_id, payload, room):
    """Resume the next queued speaker after the host has reviewed the current queue."""
    begin_write(connection)
    session=current_session(connection,room_id,active_only=True)
    if not session:
        raise FileExistsError(Text("房间没有进行中的讨论会话"))
    roster=_session_roster(connection,session['id'])
    if payload.get("revision") is None:
        raise ValueError(Text("继续安排前须读取最新 turn roster 并带上 revision"))
    if payload['revision']!=roster['revision']:
        raise FileExistsError(Text("讨论队列已变化，请重新读取 turn roster"))
    host=connection.execute("SELECT id FROM room_members WHERE room_id=? AND name=? AND role='host' AND status='active'",(room_id,payload.get('actor'))).fetchone()
    if not host:
        raise ValueError(Text("请使用当前 AI 主持人身份继续"))
    _complete_host_work(connection,session['id'],host['id'],"主持人已继续发言队列")
    return advance_session(connection,session['id'])


def cancel_plan(connection, room_id, plan_id, payload):
    """Cancel one known session plan and its linked member request/execution."""
    begin_write(connection)
    row=connection.execute("SELECT sr.* FROM session_requests sr JOIN discussion_sessions s ON s.id=sr.session_id WHERE s.room_id=? AND sr.id=?",(room_id,int(plan_id))).fetchone()
    if not row:
        raise LookupError(Text("讨论安排不存在"))
    if row['status'] not in ('queued','open'):
        raise FileExistsError(Text("该讨论安排已结束，不能重复取消"))
    if row['member_request_id']:
        request=connection.execute("SELECT execution_id,status FROM member_requests WHERE id=?",(row['member_request_id'],)).fetchone()
        if request and request['status'] in ('pending','delivering'):
            if request['execution_id']:
                finish_execution(connection,request['execution_id'],'cancelled',Text("用户取消讨论安排"),'cancelled','user_stop')
            else:
                connection.execute("UPDATE member_requests SET status='cancelled' WHERE id=?",(row['member_request_id'],))
    connection.execute("UPDATE session_requests SET status='cancelled' WHERE id=?",(plan_id,))
    session_id=row['session_id']
    create_host_request(connection, session_id, f"主持人：发言安排 #{plan_id} 已取消，请决定是否重排。",
                        {"kind": "member_change", "request_id": row["member_request_id"], "key": f"cancel-{plan_id}"})
    connection.execute("UPDATE session_state SET revision=revision+1 WHERE session_id=?",(session_id,))
    return dict(connection.execute("SELECT * FROM session_requests WHERE id=?",(plan_id,)).fetchone())


def update_session_state(connection, session_id, phase=None, held_since=None):
    """Persist session phase or held message boundary and advance its revision."""
    fields=[]; values=[]
    if phase is not None:
        if phase not in ('initial','discussing'):
            raise ValueError(Text("会话阶段须为 initial 或 discussing"))
        fields.append("phase=?"); values.append(phase)
    if held_since is not None:
        fields.append("held_since=?"); values.append(held_since)
    fields.append("revision=revision+1"); values.append(session_id)
    connection.execute(f"UPDATE session_state SET {','.join(fields)} WHERE session_id=?",values)


# Hooks the free room calls at its own decision points; each leaves the free room alone when no discussion is open.

def hold_user_message(connection, room_id, message_id, payload):
    """Hand an unnamed user message to the running discussion's host; True when the discussion took it."""
    session = current_session(connection, room_id, active_only=True)
    if not session or session["status"] != "active" or payload.get("to") is not None:
        return False
    create_host_request(connection, session["id"],
                        f"用户留言 #{message_id}：请处理并决定是否安排专家。",
                        {"kind": "user_message", "message_id": message_id, "key": f"message-{message_id}"})
    connection.execute("UPDATE session_state SET held_since=?,revision=revision+1 WHERE session_id=?",
                       (message_id, session["id"]))
    return True


def validate_session_request_answer(connection, room_id, requests):
    """Keep a discussion speaker request separate and live when answering it."""
    discussions = [request for request in requests if request["purpose"] == "discuss"]
    if not discussions:
        return
    if len(requests) != 1 or len(discussions) != 1:
        raise ValueError(Text("讨论安排须单独回答，不能与普通请求合并"))
    request_id = discussions[0]["id"]
    plan = connection.execute("""SELECT sr.status,s.status AS session_status FROM session_requests sr
        JOIN discussion_sessions s ON s.id=sr.session_id JOIN member_requests r ON r.id=sr.member_request_id
        WHERE s.room_id=? AND r.id=? AND sr.purpose='discuss'""", (room_id, request_id)).fetchone()
    if not plan or plan["session_status"] != "active" or plan["status"] != "open":
        raise FileExistsError(Text("讨论安排已暂停、结束或取消，不能继续回答"))


def open_discussion_requests(connection, execution_id):
    """Member requests of an execution that carry an open discussion turn; read before the execution ends."""
    return connection.execute("""SELECT r.id FROM member_requests r JOIN session_requests sr
        ON sr.member_request_id=r.id WHERE r.execution_id=? AND sr.purpose='discuss' AND sr.status='open'""",
        (execution_id,)).fetchall()


def after_member_stopped(connection, member_id):
    """Cancel the discussion turns a stopped member's cancelled requests carried, then relay or ask the host to re-plan."""
    member = connection.execute("SELECT room_id,name FROM room_members WHERE id=?", (member_id,)).fetchone()
    session = current_session(connection, member["room_id"], active_only=True) if member else None
    if not session:
        return
    plans = connection.execute("""SELECT id,member_request_id FROM session_requests
        WHERE session_id=? AND member_id=? AND purpose='discuss' AND status='open'
          AND member_request_id IN (SELECT id FROM member_requests WHERE status='cancelled')""",
        (session["id"], member_id)).fetchall()
    for plan in plans:
        connection.execute("UPDATE session_requests SET status='cancelled' WHERE id=?", (plan["id"],))
    if not plans:
        return
    connection.execute("UPDATE session_state SET revision=revision+1 WHERE session_id=?", (session["id"],))
    if advance_session(connection, session["id"]):
        return
    request_id = plans[0]["member_request_id"]
    create_host_request(connection, session["id"],
        f"专家 {member['name']} 的讨论发言已被打断，请检查余下安排并决定如何继续。",
        {"kind": "request_failed", "request_id": request_id, "key": f"interrupted-{request_id or plans[0]['id']}"})


def session_speaking_order(connection, session):
    """The open round's speakers so far, current turn and queued turns, later rounds apart, and the plan state for the revision."""
    items = []
    plan_state = [list(row) for row in connection.execute("""SELECT id,round,position,member_id,question,status,submission_id
        FROM session_requests WHERE session_id=? AND purpose='discuss' ORDER BY round,position,id""", (session["id"],))]
    active_round = connection.execute("SELECT MIN(round) FROM session_requests WHERE session_id=? AND purpose='discuss' AND status IN ('open','queued')",
                                      (session["id"],)).fetchone()[0]
    if active_round is None:
        active_round = connection.execute("SELECT COALESCE(MAX(round),1) FROM session_requests WHERE session_id=? AND purpose='discuss'",
                                          (session["id"],)).fetchone()[0]
    answered = [row["name"] for row in connection.execute("""SELECT m.name FROM session_requests sr JOIN room_members m ON m.id=sr.member_id
        WHERE sr.session_id=? AND sr.purpose='discuss' AND sr.round=? AND sr.status='answered' ORDER BY sr.position,sr.id""",
        (session["id"], active_round))]
    items.extend({"name": name, "state": "done"} for name in answered)
    open_turn = connection.execute("""SELECT m.name FROM session_requests sr JOIN room_members m ON m.id=sr.member_id
        WHERE sr.session_id=? AND sr.purpose='discuss' AND sr.round=? AND sr.status='open'
        ORDER BY sr.position,sr.id LIMIT 1""", (session["id"], active_round)).fetchone()
    if open_turn:
        items.append({"name": open_turn["name"], "state": "speaking"})
    queued = connection.execute("""SELECT sr.round,m.name FROM session_requests sr JOIN room_members m ON m.id=sr.member_id
        WHERE sr.session_id=? AND sr.purpose='discuss' AND sr.status='queued' ORDER BY sr.round,sr.position,sr.id""",
        (session["id"],)).fetchall()
    for row in queued:
        if row["round"] == active_round:
            items.append({"name": row["name"], "state": "queued"})
    later = [[row["name"] for row in queued if row["round"] == round_number]
             for round_number in sorted({row["round"] for row in queued if row["round"] > active_round})]
    return items, later, plan_state


def reorder_session_turns(connection, session, order, names):
    """Renumber the open round's queued turns in the owner's order, after those already answered or speaking."""
    active_round = connection.execute("SELECT MIN(round) FROM session_requests WHERE session_id=? AND purpose='discuss' AND status IN ('open','queued')",
                                      (session["id"],)).fetchone()[0]
    active_round = active_round or 1
    open_position = connection.execute("SELECT COALESCE(MAX(position),0) FROM session_requests WHERE session_id=? AND purpose='discuss' AND round=? AND status IN ('answered','open')",
                                        (session["id"], active_round)).fetchone()[0]
    rows = connection.execute("SELECT id FROM session_requests WHERE session_id=? AND purpose='discuss' AND round=? AND status='queued'",
                              (session["id"], active_round)).fetchall()
    connection.execute("UPDATE session_requests SET position=-id WHERE id IN (%s)" % ",".join("?" for _ in rows),
                       [row["id"] for row in rows]) if rows else None
    for offset, name in enumerate(order, 1):
        connection.execute("UPDATE session_requests SET position=? WHERE session_id=? AND purpose='discuss' AND round=? AND status='queued' AND member_id=?",
                           (open_position + offset, session["id"], active_round, names[name]))
    connection.execute("UPDATE session_state SET revision=revision+1 WHERE session_id=?", (session["id"],))


def queue_session_invite(connection, session, member):
    """Queue a newly invited member at the tail of the session's open round, once per invitation; with no live plan it waits."""
    planned = connection.execute("SELECT 1 FROM session_requests WHERE session_id=? AND purpose='discuss' AND status IN ('open','queued') LIMIT 1",
                                 (session["id"],)).fetchone()
    if not planned:
        return
    round_number = connection.execute("SELECT MIN(round) FROM session_requests WHERE session_id=? AND purpose='discuss' AND status IN ('open','queued')",
                                      (session["id"],)).fetchone()[0]
    if round_number is None:
        round_number = 1
    position = connection.execute("SELECT COALESCE(MAX(position),0)+1 FROM session_requests WHERE session_id=? AND purpose='discuss' AND round=?",
                                 (session["id"], round_number)).fetchone()[0]
    invitation = connection.execute("SELECT COUNT(*) FROM session_requests WHERE session_id=? AND member_id=? AND submission_id LIKE 'invite:%'",
                                    (session["id"], member["id"])).fetchone()[0] + 1
    state = connection.execute("SELECT phase,read_until FROM session_state WHERE session_id=?", (session["id"],)).fetchone()
    question = ("欢迎加入：请先读取议题，独立给出你的开场观点。" if state and state["phase"] == "initial"
                else "欢迎加入：请先读取议题和已有回答，给出你的观点。")
    read_until = state["read_until"] if state and state["phase"] == "initial" and round_number == 1 else None
    connection.execute("""INSERT OR IGNORE INTO session_requests
        (session_id,round,position,member_id,purpose,question,status,submission_id,read_until,created_at)
        VALUES(?,?,?,?,'discuss',?,'queued',?,?,?)""",
        (session["id"], round_number, position, member["id"], question,
         f"invite:{member['id']}:{invitation}", read_until,
         time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())))


def blocks_message_change(connection, room_id, message_id):
    """True while a discussion is open, or once one started after the message: its host reads user messages without a request."""
    return bool(connection.execute("SELECT 1 FROM discussion_sessions WHERE room_id=? AND (status IN ('active','paused') OR started_message_id>=?)",
                                   (room_id, message_id)).fetchone())


def session_request_origin(connection, member_request_id):
    """The discussion turn a member request carries, with a visible transcript anchor; None outside a discussion."""
    row = connection.execute("""SELECT q.id AS session_request_id,q.session_id AS discussion_session_id,q.round,
        q.question AS source_question,t.cause_kind,t.cause_message_id AS source_message_id,t.cause_request_id,
        CASE WHEN q.id IS NULL THEN r.message_id ELSE COALESCE((SELECT MAX(m.id) FROM messages m
            WHERE m.room_id=r.room_id AND m.id<r.message_id
            AND NOT EXISTS(SELECT 1 FROM internal_task_messages hidden WHERE hidden.message_id=m.id)),0) END AS session_anchor
        FROM member_requests r LEFT JOIN session_requests q ON q.member_request_id=r.id
        LEFT JOIN task_message_sources t ON t.session_request_id=q.id WHERE r.id=?""", (member_request_id,)).fetchone()
    if not row or row["session_request_id"] is None:
        return None
    return {"session_request_id": row["session_request_id"], "discussion_session_id": row["discussion_session_id"],
            "round": row["round"], "source_question": row["source_question"],
            "source_message_id": row["source_message_id"], "cause_kind": row["cause_kind"],
            "cause_request_id": row["cause_request_id"], "after_message_id": row["session_anchor"]}

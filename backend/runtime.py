"""Opt-in discussion execution; no app launching or model calls live here."""

import hashlib
import secrets
import time
from collections import Counter
from fractions import Fraction

LEASE_SECONDS = 120
# Never leaves this process; a client cannot guess it to pose as a stored hash.
OWNER_PROXY_PREFIX = secrets.token_hex(16) + ":"
LIMIT_DEFAULTS = {"max_rounds": 0, "max_minutes": 0, "execution_minutes": 0}
# Older clients may still send these; reaching a limit always pauses, so only the pause value is accepted and the reserve is ignored.
LEGACY_LIMIT_FIELDS = ("on_limit", "summary_minutes")
PUBLIC_EVENT_FIELDS = ("id", "room_id", "run_id", "generation", "cause", "participant",
                       "role", "turn_id", "status", "session_id", "lease_until", "result", "created_at")
LIMITS_SQL = """SELECT limits.*,COALESCE(pauses.paused_seconds,0)+CASE WHEN COALESCE(pauses.paused_at,0)>0
    THEN MAX(0,CAST(strftime('%s','now') AS INTEGER)-pauses.paused_at) ELSE 0 END AS idle_seconds
    FROM discussion_limits AS limits LEFT JOIN discussion_pauses AS pauses USING(room_id) WHERE limits.room_id=?"""
TIMING_ITEMS = 20
# Phase segments the runner reports for the execution timeline: the phases, how many one execution keeps and one report
# carries, a tool name's length, and how long after its end an execution still takes its last report.
SEGMENT_PHASES = ("thinking", "command", "tool", "editing", "writing")
MAX_EXECUTION_SEGMENTS = 400
MAX_SEGMENTS_PER_REPORT = 40
MAX_SEGMENT_TOOL = 60
SEGMENT_GRACE_SECONDS = 600
# Queue: created -> dispatched; wake: dispatched -> entered; work: entered -> finished. Open stages run to now.
TIMING_SQL = """SELECT e.id,e.participant,e.role,e.cause,e.status,
    MAX(0,CASE WHEN t.dispatched_at>0 THEN t.dispatched_at ELSE ? END-CAST(strftime('%s',e.created_at) AS INTEGER)) AS queue_seconds,
    CASE WHEN t.dispatched_at>0 THEN MAX(0,COALESCE(NULLIF(e.started_at,0),NULLIF(t.finished_at,0),?)-t.dispatched_at) END AS wake_seconds,
    CASE WHEN e.started_at>0 THEN MAX(0,COALESCE(NULLIF(t.finished_at,0),?)-e.started_at) END AS work_seconds
    FROM discussion_events AS e LEFT JOIN event_timings AS t ON t.event_id=e.id
    WHERE e.room_id=? AND e.run_id=? AND (t.dispatched_at>0 OR e.status='pending') ORDER BY e.id DESC"""


def owner_proxy_token(control_hash):
    """An in-process stand-in for a room's control credential, so an administrator session writes as its owner."""
    return OWNER_PROXY_PREFIX + control_hash


def token_hash(token):
    """Hash a bounded opaque capability without storing its original value."""
    if isinstance(token, str) and token.startswith(OWNER_PROXY_PREFIX):
        return token[len(OWNER_PROXY_PREFIX):]
    if not isinstance(token, str) or not 32 <= len(token) <= 256:
        return ""
    return hashlib.sha256(token.encode()).hexdigest()


def save_segments(connection, source, room_id, execution_id, anchor, finished, payload, optional=False):
    """Record an execution's phase segments as millisecond offsets from its delivery at `anchor`.

    The runner measures them on its own clock, so they are kept within the execution's own span; `finished` is 0 while
    it runs. A resent segment keeps the later end, so the open segment can be reported again as it runs on. `optional`
    allows a report with no segments, when it carries progress notes instead.
    """
    now = int(time.time())
    if finished and finished + SEGMENT_GRACE_SECONDS < now:
        raise FileExistsError("执行已结束较久，不再接收阶段记录")
    segments = payload.get("segments", [])
    if (not isinstance(segments, list) or len(segments) > MAX_SEGMENTS_PER_REPORT or (not segments and not optional) or any(
            not isinstance(item, dict) or type(item.get("seq")) is not int or not 1 <= item["seq"] <= MAX_EXECUTION_SEGMENTS
            or item.get("phase") not in SEGMENT_PHASES or not isinstance(item.get("tool", ""), str)
            or len(item.get("tool", "")) > MAX_SEGMENT_TOOL or type(item.get("start_ms")) is not int
            or type(item.get("end_ms")) is not int for item in segments)):
        raise ValueError(f"segments 须为 1–{MAX_SEGMENTS_PER_REPORT} 段 {{seq: 1–{MAX_EXECUTION_SEGMENTS}, "
                         f"phase: {'、'.join(SEGMENT_PHASES)}, tool: 最多 {MAX_SEGMENT_TOOL} 字, start_ms, end_ms}}")
    limit = max(0, (finished or now) - anchor + 1) * 1000
    rows = []
    for item in segments:
        start = min(max(item["start_ms"], 0), limit)
        rows.append((source, execution_id, item["seq"], room_id, item["phase"], item.get("tool", ""), start,
                     min(max(item["end_ms"], start), limit)))
    connection.executemany("""INSERT INTO execution_segments (source,execution_id,seq,room_id,phase,tool,start_ms,end_ms)
        VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(source,execution_id,seq) DO UPDATE SET end_ms=MAX(end_ms,excluded.end_ms)""", rows)


def begin_write(connection):
    """Acquire the writer lock once, including when routing already acquired it."""
    if not connection.in_transaction:
        connection.execute("BEGIN IMMEDIATE")


def limit_values(payload, current=None):
    """Validate bounded discussion settings; zero means no round/time preset."""
    if not isinstance(payload, dict) or set(payload) - set(LIMIT_DEFAULTS) - set(LEGACY_LIMIT_FIELDS):
        raise ValueError("limits 仅接受讨论上限配置字段")
    if payload.get("on_limit", "pause") != "pause":
        raise ValueError("到限后只会暂停；需要总结时请主持人在暂停后按你的要求写出")
    result = {key: (current or {}).get(key, value) for key, value in LIMIT_DEFAULTS.items()}
    result.update({key: value for key, value in payload.items() if key in LIMIT_DEFAULTS})
    for key, minimum, maximum in (("max_rounds", 0, 100), ("max_minutes", 0, 1440), ("execution_minutes", 0, 60)):
        if type(result[key]) is not int or not minimum <= result[key] <= maximum:
            raise ValueError(f"{key} 须为 {minimum}–{maximum} 的整数")
    return result


def limits_view(row, room):
    """Derive progress without changing state during reads."""
    result = dict(row)
    now = int(time.time())
    idle = result.get("idle_seconds") or 0
    deadline = result["started_at"] + result["max_minutes"] * 60 + idle if result["started_at"] and result["max_minutes"] else 0
    if room.get("runtime", {}).get("deadline") and (room["runtime"]["status"] == "running" or result["stop_reason"]):
        runtime_deadline = room["runtime"]["deadline"]
        deadline = min(deadline or runtime_deadline, runtime_deadline)
    reason = ""
    budget = room.get("round_budget")
    experts = len(room.get("experts") or {})
    # A budgeted room counts rounds from the budget base; a legacy room counts whole-roster rounds from the start.
    if budget:
        segment_rounds = max(0, room["opinion_count"] - budget["base"]) // experts if experts else 0
    else:
        segment_rounds = room["completed_rounds"]
    round_cap = (budget["cap"] or result["max_rounds"]) if budget else result["max_rounds"]
    if deadline and now >= deadline:
        reason = "time_limit"
    elif round_cap and segment_rounds >= round_cap:
        reason = "round_limit"
    result.update(deadline=deadline, reached=bool(reason), reason=reason, completed_rounds=room["completed_rounds"],
                  segment_rounds=segment_rounds, round_cap=round_cap, extra_rounds=budget["extra"] if budget else 0,
                  remaining_seconds=max(0, deadline - now) if deadline else None,
                  elapsed_seconds=max(0, now - result["started_at"] - idle) if result["started_at"] else 0)
    return result


def require_within_limits(room):
    """Stop new expert work at the configured boundary, preserving user notes."""
    if room["limits"]["reached"]:
        raise FileExistsError("已达到讨论上限；请检查上限，讨论随之结束并回到自由协作")


def session_limits_view(connection, room_id):
    """Read request-model session progress, excluding paused time and ordinary collaboration replies."""
    from .session_room import current_session

    session = current_session(connection, room_id)
    if not session:
        return None
    result = dict(connection.execute("SELECT * FROM session_limits WHERE session_id=?", (session["id"],)).fetchone())
    pause = connection.execute("SELECT * FROM session_pauses WHERE session_id=?", (session["id"],)).fetchone()
    budget = dict(connection.execute("SELECT base,cap,extra FROM session_round_budgets WHERE session_id=?", (session["id"],)).fetchone())
    answered = connection.execute("""SELECT COUNT(*) FROM session_requests
        WHERE session_id=? AND purpose='discuss' AND status='answered'""", (session["id"],)).fetchone()[0]
    now = int(time.time())
    if session["status"] == "concluded":
        finished = connection.execute("SELECT CAST(strftime('%s',concluded_at) AS INTEGER) FROM discussion_conclusions WHERE session_id=?",
                                      (session["id"],)).fetchone()
        now = finished[0] if finished and finished[0] else now
    idle = pause["paused_seconds"] + (max(0, now - pause["paused_at"]) if pause["paused_at"] else 0)
    deadline = result["started_at"] + result["max_minutes"] * 60 + idle if result["started_at"] and result["max_minutes"] else 0
    completed = _session_answer_rounds(connection, session["id"])
    segment_rounds = _session_answer_rounds(connection, session["id"], budget["base"])
    round_cap = budget["cap"] or result["max_rounds"]
    reason = result["stop_reason"] if result["stop_reason"] in ("time_limit", "round_limit") else ""
    if not reason and deadline and now >= deadline:
        reason = "time_limit"
    elif not reason and round_cap and segment_rounds >= round_cap:
        reason = "round_limit"
    result.update(deadline=deadline, reached=bool(reason), reason=reason, completed_rounds=completed,
                  segment_rounds=segment_rounds, round_cap=round_cap, extra_rounds=budget["extra"],
                  remaining_seconds=max(0, deadline - now) if deadline else None,
                  elapsed_seconds=max(0, now - result["started_at"] - idle), answered=answered)
    return result


def _session_answer_rounds(connection, session_id, base=0):
    """Count answer volume across rounds, adding the host only to rounds where the host is scheduled."""
    from .session_room import _expert_denominator

    rounds = Counter(row[0] for row in connection.execute("""SELECT round FROM session_requests
        WHERE session_id=? AND purpose='discuss' AND status='answered' ORDER BY id LIMIT -1 OFFSET ?""",
        (session_id, base)))
    progress = Fraction(0)
    for round_number, answered in rounds.items():
        denominator = _expert_denominator(connection, session_id, round_number)
        if denominator:
            progress += Fraction(answered, denominator)
    return int(progress)


def enforce_session_limits(connection, room_id):
    """End an active request-model session at its configured limit under the caller's write transaction."""
    from .session_room import _conclude_session, current_session

    begin_write(connection)
    session = current_session(connection, room_id, active_only=True)
    if not session or session["status"] != "active":
        return False
    limits = session_limits_view(connection, room_id)
    if not limits["reached"]:
        return False
    _conclude_session(connection, session, limits["reason"])
    return True


def runtime_view(connection, room_id):
    """Return public execution state, never capability hashes."""
    row = connection.execute("SELECT * FROM discussion_runtime WHERE room_id=?", (room_id,)).fetchone()
    if not row:
        return {"mode": "manual", "status": "ready", "revision": 0, "protected": False}
    result = {key: row[key] for key in row.keys() if key != "control_hash"}
    result["protected"] = True
    result["expired"] = row["status"] == "running" and 0 < row["deadline"] <= int(time.time())
    event = connection.execute("SELECT id,participant,role,status,result FROM discussion_events WHERE room_id=? ORDER BY id DESC LIMIT 1", (room_id,)).fetchone()
    result["latest_execution"] = dict(event) if event else None
    result["participants"] = participant_executions(connection, room_id)
    result["failures"] = failed_executions(connection, room_id)
    result["timings"] = execution_timings(connection, room_id, row["run_id"])
    return result


def has_session_request_model(connection, room_id):
    """Return whether this room has request-model session history, including concluded sessions."""
    return bool(connection.execute("""SELECT 1 FROM discussion_sessions AS s
        JOIN session_state AS state ON state.session_id=s.id WHERE s.room_id=? LIMIT 1""", (room_id,)).fetchone())


def failed_executions(connection, room_id):
    """Keep failed attempts readable after a retry, without exposing execution credentials."""
    return [dict(row) for row in connection.execute("""SELECT e.id,e.participant,e.role,e.turn_id,
        e.result,e.created_at,CASE WHEN t.dispatched_at>0 AND t.finished_at>0
        THEN MAX(0,t.finished_at-t.dispatched_at) END AS elapsed_seconds
        FROM discussion_events AS e LEFT JOIN event_timings AS t ON t.event_id=e.id
        WHERE e.room_id=? AND e.status='failed' ORDER BY e.id""", (room_id,))]


def execution_timings(connection, room_id, run_id):
    """Summarize stage durations of the current run so slow stages are visible."""
    now = int(time.time())
    rows = [dict(row) for row in connection.execute(TIMING_SQL, (now, now, now, room_id, run_id))]
    stages = ("queue_seconds", "wake_seconds", "work_seconds")
    totals = {stage: sum(row[stage] or 0 for row in rows) for stage in stages}
    return {"items": rows[:TIMING_ITEMS], "totals": totals, "count": len(rows)}


def participant_executions(connection, room_id):
    """Summarize each participant's latest execution and failure count for the progress panel."""
    rows = connection.execute("""SELECT latest.id,latest.participant,latest.role,latest.status,latest.result,
        latest.turn_id,latest.lease_until,COALESCE((SELECT bound.session_id FROM discussion_events AS bound
            WHERE bound.room_id=latest.room_id AND bound.participant=latest.participant AND bound.session_id<>''
            ORDER BY bound.id DESC LIMIT 1),'') AS session_id,(SELECT COUNT(*) FROM discussion_events AS failed
            WHERE failed.room_id=latest.room_id AND failed.participant=latest.participant
            AND failed.status='failed') AS failures
        FROM discussion_events AS latest WHERE latest.room_id=? AND latest.id=(SELECT MAX(id)
            FROM discussion_events AS other WHERE other.room_id=latest.room_id
            AND other.participant=latest.participant) ORDER BY latest.id""", (room_id,)).fetchall()
    now = int(time.time())
    return [{key: row[key] for key in row.keys() if key != "lease_until"}
            | {"stale": row["status"] == "started" and row["lease_until"] <= now} for row in rows]


def require_control(connection, room_id, token):
    """Validate the room owner capability for control and dispatcher operations."""
    row = connection.execute("SELECT * FROM discussion_runtime WHERE room_id=? AND control_hash=?",
                             (room_id, token_hash(token))).fetchone()
    if not row:
        raise PermissionError("需要本房间的运行控制凭据")
    return row


def require_owner(connection, room_id, token):
    """Require the persistent room owner credential, independent of execution mode."""
    hashed = token_hash(token)
    row = connection.execute("SELECT * FROM room_modes WHERE room_id=? AND control_hash=?",
                             (room_id, hashed)).fetchone() if hashed else None
    if not row:
        raise PermissionError("需要本房间的控制凭据；没有凭据只能阅读")
    return row


def write_actor(operation, payload):
    """Use the same message attribution defaults as persisted message details."""
    if operation == "messages":
        return payload.get("submitted_by", payload.get("author") if payload.get("source") in ("cli", "api") else "用户")
    return payload.get("actor", "用户")


def authorize_participant(connection, room_id, identity, operation, payload):
    """Limit authenticated participants to their identity and assigned host duties."""
    actor = write_actor(operation, payload)
    if actor != identity["name"]:
        raise PermissionError("凭据与实际参与身份不符")
    if operation == "messages":
        author = payload.get("author")
        online = connection.execute("SELECT 1 FROM room_members WHERE room_id=? AND name=? AND access='online' AND status='active'",
                                    (room_id, author)).fetchone()
        if author != actor and not (online and identity["role"] in ("owner", "host")):
            raise PermissionError("只能提交本人观点，或由房主、主持人代发在线成员原文")
    elif operation != "attachments" and identity["role"] != "owner":
        if identity["role"] != "host" or operation not in ("topic", "state", "turns", "limits"):
            raise PermissionError("本成员没有此管理权限")
        if operation == "topic":
            if any(field in payload for field in ("host", "experts", "members")):
                raise PermissionError("只有房主可以修改成员和主持人")


def authorize_write(connection, room_id, token, operation, payload):
    """Check a capability under the same writer lock as the following mutation."""
    begin_write(connection)
    run = connection.execute("SELECT mode FROM discussion_runtime WHERE room_id=?", (room_id,)).fetchone()
    hashed = token_hash(token)
    owner = connection.execute("SELECT 1 FROM room_modes WHERE room_id=? AND control_hash=?", (room_id, hashed)).fetchone() if hashed else None
    if owner:
        authorize_participant(connection, room_id, {"name": "用户", "role": "owner"}, operation, payload)
        return
    member = connection.execute("SELECT * FROM room_members WHERE room_id=? AND token_hash=? AND status='active' AND access<>'online'",
                                (room_id, hashed)).fetchone() if hashed else None
    if member and (not run or run["mode"] == "manual" or member["access"] == "manual"):
        authorize_participant(connection, room_id, member, operation, payload)
        return
    raise PermissionError("需要房主或本成员的有效凭据；旧讨论执行凭据已停用")


def list_events(connection, room_id, token, after=0):
    """Read a bounded durable inbox after an explicit cursor."""
    require_control(connection, room_id, token)
    rows = connection.execute("SELECT * FROM discussion_events WHERE room_id=? AND id>? ORDER BY id LIMIT 100",
                              (room_id, max(0, int(after)))).fetchall()
    events = [{key: row[key] for key in PUBLIC_EVENT_FIELDS} for row in rows]
    return {"events": events, "next_after": events[-1]["id"] if events else int(after)}


def event_view(connection, room_id, event_id, token, payload):
    """Read one legacy event without allowing it to resume the retired runtime."""
    if payload.get("action") != "view":
        raise ValueError("旧讨论执行仅保留历史读取")
    event = connection.execute("SELECT * FROM discussion_events WHERE room_id=? AND id=?",
                               (room_id, event_id)).fetchone()
    if not event:
        raise LookupError("执行不存在")
    run = connection.execute("SELECT control_hash FROM discussion_runtime WHERE room_id=?", (room_id,)).fetchone()
    hashed = token_hash(token)
    controller = bool(run and hashed and hashed == run["control_hash"])
    if not controller and (not hashed or hashed != event["token_hash"]):
        raise PermissionError("执行凭据无效")
    return {key: event[key] for key in PUBLIC_EVENT_FIELDS}

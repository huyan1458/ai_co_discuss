"""Room credentials, write locking and discussion limits; no app launching or model calls live here."""

import hashlib
import secrets
import time
from collections import Counter
from fractions import Fraction

LEASE_SECONDS = 120
# Never leaves this process; a client cannot guess it to pose as a stored hash.
OWNER_PROXY_PREFIX = secrets.token_hex(16) + ":"
LIMIT_DEFAULTS = {"max_rounds": 0, "max_minutes": 0, "execution_minutes": 0}
# Phase segments the runner reports for the execution timeline: the phases, how many one execution keeps and one report
# carries, a tool name's length, and how long after its end an execution still takes its last report.
SEGMENT_PHASES = ("thinking", "command", "tool", "editing", "writing")
MAX_EXECUTION_SEGMENTS = 400
MAX_SEGMENTS_PER_REPORT = 40
MAX_SEGMENT_TOOL = 60
SEGMENT_GRACE_SECONDS = 600


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
    if not isinstance(payload, dict) or set(payload) - set(LIMIT_DEFAULTS):
        raise ValueError("limits 仅接受讨论上限配置字段")
    result = {key: (current or {}).get(key, value) for key, value in LIMIT_DEFAULTS.items()}
    result.update({key: value for key, value in payload.items() if key in LIMIT_DEFAULTS})
    for key, minimum, maximum in (("max_rounds", 0, 100), ("max_minutes", 0, 1440), ("execution_minutes", 0, 60)):
        if type(result[key]) is not int or not minimum <= result[key] <= maximum:
            raise ValueError(f"{key} 须为 {minimum}–{maximum} 的整数")
    return result


def room_limits_view(connection, room_id):
    """Return the next discussion's default limits without any past session's progress."""
    row = connection.execute("SELECT max_rounds,max_minutes,execution_minutes FROM discussion_limits WHERE room_id=?",
                             (room_id,)).fetchone()
    limits = {**LIMIT_DEFAULTS, **(dict(row) if row else {})}
    return {**limits, "started_at": 0, "stop_reason": "", "deadline": 0, "reached": False, "reason": "",
            "completed_rounds": 0, "segment_rounds": 0, "round_cap": limits["max_rounds"], "extra_rounds": 0,
            "remaining_seconds": None, "elapsed_seconds": 0, "answered": 0}


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


def require_owner(connection, room_id, token):
    """Require the persistent room owner credential, independent of execution mode."""
    hashed = token_hash(token)
    row = connection.execute("SELECT * FROM room_modes WHERE room_id=? AND control_hash=?",
                             (room_id, hashed)).fetchone() if hashed else None
    if not row:
        raise PermissionError("需要本房间的控制凭据；没有凭据只能阅读")
    return row

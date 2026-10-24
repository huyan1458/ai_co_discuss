"""Opt-in discussion execution; no app launching or model calls live here."""

import hashlib
import json
import time
import uuid

LEASE_SECONDS = 120
MAX_RUN_SECONDS = 86400
LIMIT_DEFAULTS = {"max_rounds": 0, "max_minutes": 0, "execution_minutes": 0,
                  "on_limit": "pause", "summary_minutes": 5}
PUBLIC_EVENT_FIELDS = ("id", "room_id", "run_id", "generation", "cause", "participant",
                       "role", "turn_id", "status", "session_id", "lease_until", "result", "created_at")
LIMITS_SQL = """SELECT limits.*,COALESCE(pauses.paused_seconds,0)+CASE WHEN COALESCE(pauses.paused_at,0)>0
    THEN MAX(0,CAST(strftime('%s','now') AS INTEGER)-pauses.paused_at) ELSE 0 END AS idle_seconds
    FROM discussion_limits AS limits LEFT JOIN discussion_pauses AS pauses USING(room_id) WHERE limits.room_id=?"""
TIMING_ITEMS = 20
# Queue: created -> dispatched; wake: dispatched -> entered; work: entered -> finished. Open stages run to now.
TIMING_SQL = """SELECT e.id,e.participant,e.role,e.cause,e.status,
    MAX(0,CASE WHEN t.dispatched_at>0 THEN t.dispatched_at ELSE ? END-CAST(strftime('%s',e.created_at) AS INTEGER)) AS queue_seconds,
    CASE WHEN t.dispatched_at>0 THEN MAX(0,COALESCE(NULLIF(e.started_at,0),NULLIF(t.finished_at,0),?)-t.dispatched_at) END AS wake_seconds,
    CASE WHEN e.started_at>0 THEN MAX(0,COALESCE(NULLIF(t.finished_at,0),?)-e.started_at) END AS work_seconds
    FROM discussion_events AS e LEFT JOIN event_timings AS t ON t.event_id=e.id
    WHERE e.room_id=? AND e.run_id=? AND (t.dispatched_at>0 OR e.status='pending') ORDER BY e.id DESC"""


def token_hash(token):
    """Hash a bounded opaque capability without storing its original value."""
    if not isinstance(token, str) or not 32 <= len(token) <= 256:
        return ""
    return hashlib.sha256(token.encode()).hexdigest()


def begin_write(connection):
    """Acquire the writer lock once, including when routing already acquired it."""
    if not connection.in_transaction:
        connection.execute("BEGIN IMMEDIATE")


def limit_values(payload, current=None):
    """Validate bounded discussion settings; zero means no round/time preset."""
    if not isinstance(payload, dict) or set(payload) - set(LIMIT_DEFAULTS):
        raise ValueError("limits 仅接受讨论上限配置字段")
    result = {key: (current or {}).get(key, value) for key, value in LIMIT_DEFAULTS.items()}
    result.update(payload)
    for key, minimum, maximum in (("max_rounds", 0, 100), ("max_minutes", 0, 1440),
                                  ("execution_minutes", 0, 60), ("summary_minutes", 1, 60)):
        if type(result[key]) is not int or not minimum <= result[key] <= maximum:
            raise ValueError(f"{key} 须为 {minimum}–{maximum} 的整数")
    if result["on_limit"] not in ("pause", "summarize"):
        raise ValueError("on_limit 须为 pause 或 summarize")
    if result["on_limit"] == "summarize" and result["max_minutes"] and result["summary_minutes"] >= result["max_minutes"]:
        raise ValueError("收束预留时间必须小于讨论总时长")
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
    if result["closing_at"]:
        closing_deadline = result["closing_at"] + result["summary_minutes"] * 60
        deadline = min(deadline or closing_deadline, closing_deadline)
    cutoff = deadline - result["summary_minutes"] * 60 if deadline and result["on_limit"] == "summarize" and not result["closing_at"] else deadline
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
    elif result["closing_at"]:
        reason = result["stop_reason"]
    elif round_cap and segment_rounds >= round_cap:
        reason = "round_limit"
    elif cutoff and now >= cutoff:
        reason = "summary_reserved" if result["on_limit"] == "summarize" else "time_limit"
    result.update(deadline=deadline, cutoff=cutoff, reached=bool(reason), reason=reason,
                  closing=bool(result["closing_at"]) and room["phase"] not in ("paused", "concluded"), completed_rounds=room["completed_rounds"],
                  segment_rounds=segment_rounds, round_cap=round_cap, extra_rounds=budget["extra"] if budget else 0,
                  remaining_seconds=max(0, deadline - now) if deadline else None,
                  elapsed_seconds=max(0, now - result["started_at"] - idle) if result["started_at"] else 0)
    return result


def require_within_limits(room):
    """Stop new expert work at the configured boundary, preserving user notes."""
    if room["limits"]["reached"]:
        raise FileExistsError("已达到讨论上限；请检查上限并暂停或由主持人总结")


def execution_seconds(connection, room_id):
    """Read the per-execution budget shared by entry, renewal and writes."""
    row = connection.execute("SELECT execution_minutes FROM discussion_limits WHERE room_id=?", (room_id,)).fetchone()
    return (row[0] if row else LIMIT_DEFAULTS["execution_minutes"]) * 60


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
    elif operation == "floor":
        speaker = payload.get("speaker", actor)
        online = connection.execute("SELECT 1 FROM room_members WHERE room_id=? AND name=? AND access='online' AND status='active'",
                                    (room_id, speaker)).fetchone()
        if identity["role"] != "owner" and speaker != actor and not (identity["role"] == "host" and online):
            raise PermissionError("只能操作本人发言权")
    elif operation != "attachments" and identity["role"] != "owner":
        if identity["role"] != "host" or operation not in ("topic", "state", "turns", "limits"):
            raise PermissionError("本成员没有此管理权限")
        if operation == "topic":
            if any(field in payload for field in ("host", "experts", "members")):
                raise PermissionError("只有房主可以修改成员和主持人")


def authorize_write(connection, room_id, token, operation, payload):
    """Check a capability under the same writer lock as the following mutation."""
    begin_write(connection)
    run = connection.execute("SELECT * FROM discussion_runtime WHERE room_id=?", (room_id,)).fetchone()
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
    if not run or not hashed:
        raise PermissionError("需要房主或本成员的有效凭据；没有凭据只能阅读")
    actor = write_actor(operation, payload)
    work_seconds = execution_seconds(connection, room_id)
    event = connection.execute("""SELECT * FROM discussion_events WHERE room_id=? AND token_hash=?
        AND run_id=? AND generation=? AND status='started' AND lease_until>?
        AND (?=0 OR started_at+?>?)""", (room_id, hashed, run["run_id"], run["generation"],
                                       int(time.time()), work_seconds, work_seconds, int(time.time()))).fetchone()
    if not hashed or not event or run["status"] != "running" or 0 < run["deadline"] <= int(time.time()):
        raise PermissionError("执行资格无效、已结束或已到期；请重新读取运行状态")
    if actor != event["participant"]:
        raise PermissionError("执行凭据与实际参与身份不符")
    authorize_participant(connection, room_id, {"name": event["participant"], "role": event["role"]}, operation, payload)
    if operation == "messages":
        if payload.get("author") != actor:
            raise PermissionError("自动执行不能代发其他参与者")
        if event["role"] == "expert" and payload.get("turn_id") != event["turn_id"]:
            raise PermissionError("回答必须关联本次安排")
    elif operation == "floor":
        if payload.get("speaker", actor) != actor:
            raise PermissionError("自动执行只能操作本人发言权")
    elif operation == "attachments":
        pass
    elif event["role"] != "host" or operation not in ("topic", "state", "turns", "limits"):
        raise PermissionError("本次执行不能进行此操作")


def configure_runtime(connection, room_id, token, payload):
    """Apply one versioned, explicit mode or lifecycle action."""
    begin_write(connection)
    require_owner(connection, room_id, token)
    current = runtime_view(connection, room_id)
    if payload.get("revision") != current["revision"]:
        raise FileExistsError("运行状态已变化，请重新读取 revision")
    hashed = token_hash(token)
    if not current["protected"] and not hashed:
        raise ValueError("运行凭据须为 32–256 字符的随机值")
    action = payload.get("action", "configure")
    mode = payload.get("mode", "automatic" if action == "start" else current["mode"])
    if mode not in ("manual", "automatic") or action not in ("configure", "start", "pause", "stop"):
        raise ValueError("请选择 manual/automatic 和 configure/start/pause/stop")
    if action == "start" and mode != "automatic":
        raise ValueError("start 只用于全自动运行；手动方式无需运行启动")
    if action in ("configure", "start") and current["status"] == "running":
        raise FileExistsError("讨论仍在运行；请先暂停，再切换模式或继续")
    if action in ("configure", "start") and connection.execute(
            "SELECT 1 FROM discussion_events WHERE room_id=? AND status IN ('dispatched','started')", (room_id,)).fetchone():
        raise FileExistsError("存在在途执行；先暂停并核对原会话已停止，再切换或继续")
    status = {"configure": "ready", "start": "running", "pause": "paused", "stop": "stopped"}[action]
    start_payload = {"phase": current.get("resume_phase", "initial"), **payload}
    deadline = validate_start(connection, room_id, start_payload) if action == "start" else current.get("deadline", 0)
    connection.execute("""INSERT INTO discussion_runtime
        (room_id,mode,run_id,status,control_hash,deadline,updated_at) VALUES (?,?,?,?,?,?,datetime('now'))
        ON CONFLICT(room_id) DO UPDATE SET mode=excluded.mode,status=excluded.status,
        generation=generation+1,revision=revision+1,deadline=excluded.deadline,updated_at=excluded.updated_at""",
                       (room_id, mode, str(uuid.uuid4()), "ready", hashed, deadline))
    if action in ("pause", "stop"):
        connection.execute("UPDATE topic_settings SET phase='paused' WHERE room_id=? AND phase<>'concluded'", (room_id,))
    connection.execute("UPDATE discussion_runtime SET status=? WHERE room_id=?", (status, room_id))
    # Only a real mode change converts members; a manual expert of a woken discussion (adapter 'manual') stays manual.
    if mode != current["mode"]:
        connection.execute("UPDATE room_members SET access='manual' WHERE room_id=? AND access='runner'" if mode == "manual" else
                           "UPDATE room_members SET access='runner' WHERE room_id=? AND access='manual' AND adapter<>'manual'", (room_id,))
    return runtime_view(connection, room_id)


def validate_start(connection, room_id, payload):
    """Validate an AI-hosted run; zero deadline leaves only the configured limits."""
    row = connection.execute("SELECT * FROM topic_settings JOIN room_directory USING(room_id) WHERE room_id=?",
                             (room_id,)).fetchone()
    limits = connection.execute(LIMITS_SQL, (room_id,)).fetchone()
    configured = ((limits["started_at"] or int(time.time())) + limits["max_minutes"] * 60 + limits["idle_seconds"]
                  if limits["max_minutes"] else 0)
    if limits["closing_at"]:
        closing_deadline = limits["closing_at"] + limits["summary_minutes"] * 60
        previous_deadline = runtime_view(connection, room_id).get("deadline", 0)
        configured = min(value for value in (configured, closing_deadline, previous_deadline) if value)
    deadline = payload.get("deadline", configured)
    if type(deadline) is int and configured:
        deadline = min(deadline or configured, configured)
    if type(deadline) is not int or (deadline != 0 and not int(time.time()) < deadline <= int(time.time()) + MAX_RUN_SECONDS):
        raise ValueError("deadline 须为 0（不限时长）或未来 24 小时内的 Unix 秒数")
    experts = json.loads(row["experts"])
    if row["archived"] or row["phase"] == "concluded" or row["host"] == "用户":
        raise ValueError("自动运行需要未归档、未收束的话题及 AI 主持人")
    if not experts or any(mode != "cli" for mode in experts.values()):
        raise ValueError("自动运行的参与者须均具有本地 CLI 读写能力")
    phase = payload.get("phase", "initial" if row["phase"] == "preparing" else "discussing")
    if phase not in ("initial", "discussing", "reviewing"):
        raise ValueError("恢复阶段必须为 initial/discussing/reviewing")
    if row["phase"] in ("preparing", "paused"):
        connection.execute("UPDATE topic_settings SET phase=? WHERE room_id=?", (phase, room_id))
    connection.execute("UPDATE discussion_limits SET started_at=? WHERE room_id=? AND started_at=0",
                       (int(time.time()), room_id))
    return deadline


def list_events(connection, room_id, token, after=0):
    """Read a bounded durable inbox after an explicit cursor."""
    require_control(connection, room_id, token)
    rows = connection.execute("SELECT * FROM discussion_events WHERE room_id=? AND id>? ORDER BY id LIMIT 100",
                              (room_id, max(0, int(after)))).fetchall()
    events = [{key: row[key] for key in PUBLIC_EVENT_FIELDS} for row in rows]
    return {"events": events, "next_after": events[-1]["id"] if events else int(after)}


def event_action(connection, room_id, event_id, token, payload):
    """Reserve, enter or renew one persisted execution, with no implicit replay."""
    begin_write(connection)
    event = connection.execute("SELECT * FROM discussion_events WHERE room_id=? AND id=?",
                               (room_id, event_id)).fetchone()
    if not event:
        raise LookupError("执行不存在")
    run = connection.execute("SELECT * FROM discussion_runtime WHERE room_id=?", (room_id,)).fetchone()
    now = int(time.time())
    work_seconds = execution_seconds(connection, room_id)
    action = payload.get("action")
    work_deadline = (now if action == "enter" else event["started_at"]) + work_seconds if work_seconds else 0
    lease_until = min(now + LEASE_SECONDS, work_deadline or now + LEASE_SECONDS, run["deadline"] or now + LEASE_SECONDS)
    controller = token_hash(token) == run["control_hash"]
    if not controller and (not token_hash(token) or token_hash(token) != event["token_hash"]):
        raise PermissionError("执行凭据无效")
    if action == "view":
        return {key: event[key] for key in PUBLIC_EVENT_FIELDS}
    if run["status"] != "running" or 0 < run["deadline"] <= now or event["generation"] != run["generation"]:
        raise FileExistsError("本次运行已停止或执行已过期")
    if action == "reserve" and controller:
        reserve_event(connection, event, payload)
    elif action == "enter" and not controller:
        if event["status"] != "dispatched" or not payload.get("session_id"):
            raise FileExistsError("本次任务已进入或不可进入；不要重复执行")
        connection.execute("UPDATE discussion_events SET status='started',session_id=?,started_at=?,lease_until=? WHERE id=?",
                           (str(payload["session_id"])[:200], now, lease_until, event_id))
    elif action == "renew" and controller and event["status"] == "started":
        if event["lease_until"] <= now or 0 < work_deadline <= now:
            raise FileExistsError("执行租约已到期，不能自动重新激活")
        connection.execute("UPDATE discussion_events SET lease_until=? WHERE id=?",
                           (lease_until, event_id))
    elif action == "fail" and event["status"] in ("dispatched", "started"):
        connection.execute("UPDATE discussion_events SET status='failed',result=? WHERE id=?",
                           (str(payload.get("reason", "需要用户处理"))[:500], event_id))
        connection.execute("UPDATE topic_settings SET phase='paused' WHERE room_id=?", (room_id,))
    else:
        raise FileExistsError("执行状态不允许此操作")
    result = connection.execute("SELECT * FROM discussion_events WHERE id=?", (event_id,)).fetchone()
    return {key: result[key] for key in PUBLIC_EVENT_FIELDS}


def reserve_event(connection, event, payload):
    """Reserve only current work and merge pending host wakeups before dispatch."""
    hashed = token_hash(payload.get("execution_token"))
    if event["status"] != "pending" or not hashed:
        raise FileExistsError("执行已被领取或缺少有效的执行凭据")
    turn = connection.execute("SELECT * FROM discussion_turns WHERE room_id=? AND status IN ('pending','notified')",
                              (event["room_id"],)).fetchone()
    if (event["role"] == "host" and turn) or (event["role"] == "expert" and (not turn or turn["id"] != event["turn_id"])):
        raise FileExistsError("当前安排与执行不符，请重新读取")
    if connection.execute("SELECT 1 FROM discussion_events WHERE room_id=? AND status IN ('dispatched','started')",
                          (event["room_id"],)).fetchone():
        raise FileExistsError("已有在途执行")
    connection.execute("UPDATE discussion_events SET status='dispatched',token_hash=? WHERE id=?", (hashed, event["id"]))
    if event["role"] == "host":
        connection.execute("UPDATE discussion_events SET status='completed',result=? WHERE room_id=? AND role='host' AND status='pending' AND id<?",
                           (f"merged:{event['id']}", event["room_id"], event["id"]))

"""Goal mode: a user-set objective the host keeps pursuing; when the room goes idle the runner wakes the host again."""

import hashlib
import json
import time

from .free_room import insert_request, record_cancel_reasons, require_member
from .runtime import begin_write, require_owner

OPEN_STATUSES = ("active", "paused")
MAX_OBJECTIVE_LENGTH = 2000
MAX_NOTE_LENGTH = 1000
MAX_CONTINUES = 1000
MAX_MINUTES = 7 * 24 * 60
# The same wake-up failing this many times in a row stops the goal instead of retrying forever.
FAILED_CONTINUATIONS = 3
GOAL_AUTHOR = "系统"
# How long the room stays idle before the host is woken while the goal is being worked on; the owner sets it per room.
DEFAULT_IDLE_SECONDS = 120
MIN_IDLE_SECONDS = 30
MAX_IDLE_SECONDS = 1800
# Phases the host may declare on an active goal. Waiting and pending stop idle wake-ups; each has one fallback wake-up.
PHASES = ("doing", "waiting", "pending")
PHASE_DEFAULT_MINUTES = {"waiting": 30, "pending": 60}
MAX_PHASE_MINUTES = 24 * 60
END_LABELS = {"complete": "Goal 已完成", "blocked": "Goal 已停止：卡住", "budget_limited": "Goal 预算已用完：请主持人收尾，总结进展、剩余工作和下一步",
              "cleared": "Goal 已结束"}


def open_goal(connection, room_id):
    """The room's goal while it is active or paused."""
    row = connection.execute("SELECT * FROM room_goals WHERE room_id=? AND status IN ('active','paused') ORDER BY id DESC LIMIT 1",
                             (room_id,)).fetchone()
    return dict(row) if row else None


def goal_host(connection, room_id):
    """The host the runner can wake; a goal has no meaning without one."""
    row = connection.execute("SELECT * FROM room_members WHERE room_id=? AND role='host' AND status='active' AND access='runner'",
                             (room_id,)).fetchone()
    if not row:
        raise ValueError("Goal 需要一位由本机唤醒的 AI 主持人")
    return dict(row)


def check_exclusive(connection, room_id):
    """Goal and discussion never run at the same time."""
    if connection.execute("SELECT 1 FROM discussion_sessions WHERE room_id=? AND status IN ('active','paused')", (room_id,)).fetchone():
        raise FileExistsError("讨论进行中；结束讨论后才能开启 Goal")
    if open_goal(connection, room_id):
        raise FileExistsError("Goal 已在进行；可用 /goal pause、/goal resume、/goal clear 或 /goal edit 新目标")


def clean_objective(value):
    """An objective is required, single text of bounded length."""
    objective = str(value or "").strip()
    if not objective or len(objective) > MAX_OBJECTIVE_LENGTH:
        raise ValueError(f"Goal 目标须为 1–{MAX_OBJECTIVE_LENGTH} 字")
    return objective


def clean_budget(payload, current=None):
    """Optional budgets set by the owner: whole numbers, 0 meaning no limit."""
    result = {}
    for field, limit in (("max_continues", MAX_CONTINUES), ("max_minutes", MAX_MINUTES)):
        value = payload.get(field, (current or {}).get(field, 0))
        if type(value) is not int or not 0 <= value <= limit:
            raise ValueError(f"{field} 须为 0–{limit} 的整数，0 表示不限")
        result[field] = value
    value = payload.get("idle_seconds", (current or {}).get("idle_seconds", DEFAULT_IDLE_SECONDS))
    if type(value) is not int or not MIN_IDLE_SECONDS <= value <= MAX_IDLE_SECONDS:
        raise ValueError(f"idle_seconds 须为 {MIN_IDLE_SECONDS}–{MAX_IDLE_SECONDS} 的整数（秒）")
    result["idle_seconds"] = value
    return result


def last_idle_seconds(connection, room_id):
    """A new goal keeps the idle wait the owner chose for this room's previous goal."""
    row = connection.execute("SELECT idle_seconds FROM room_goals WHERE room_id=? ORDER BY id DESC LIMIT 1", (room_id,)).fetchone()
    return {"idle_seconds": row[0]} if row else None


def elapsed_seconds(goal, now=None):
    """Time spent pursuing the goal, excluding pauses."""
    now = now or int(time.time())
    end = goal["ended_at"] or now
    paused = goal["paused_seconds"] + (max(0, end - goal["paused_at"]) if goal["paused_at"] else 0)
    return max(0, end - goal["started_at"] - paused)


def continuation_statuses(connection, goal_id, limit=FAILED_CONTINUATIONS):
    """Statuses of the goal's latest wake-up requests, newest first."""
    return [row[0] for row in connection.execute("""SELECT r.status FROM goal_continuations c JOIN member_requests r ON r.id=c.request_id
        WHERE c.goal_id=? ORDER BY c.id DESC LIMIT ?""", (goal_id, limit))]


def room_idle(connection, room_id, goal):
    """Whether an active goal should wake the host: nothing runs, waits or is held, and the owner did not speak last."""
    if not goal or goal["status"] != "active":
        return False
    busy = connection.execute("""SELECT
        EXISTS(SELECT 1 FROM member_requests WHERE room_id=?1 AND status IN ('pending','delivering'))
        OR EXISTS(SELECT 1 FROM member_executions WHERE room_id=?1 AND status IN ('dispatched','started'))
        OR EXISTS(SELECT 1 FROM free_chain_holds WHERE room_id=?1 AND message_id>0)
        OR EXISTS(SELECT 1 FROM free_queue_waiting WHERE room_id=?1)
        OR EXISTS(SELECT 1 FROM queued_messages WHERE room_id=?1)""", (room_id,)).fetchone()[0]
    if busy:
        return False
    last = connection.execute("""SELECT author FROM messages m WHERE room_id=? AND NOT EXISTS(
        SELECT 1 FROM internal_task_messages t WHERE t.message_id=m.id) ORDER BY id DESC LIMIT 1""", (room_id,)).fetchone()
    if last and last[0] == "用户":
        return False
    if goal["phase"] != "doing":
        # The host said it is waiting on background work or on the user: only its fallback deadline wakes it.
        return bool(goal["phase_until"]) and int(time.time()) >= goal["phase_until"]
    # A wake-up that failed did no work, so the next idle moment may try again until the failure limit stops the goal.
    return bool(goal["armed"]) or continuation_statuses(connection, goal["id"], 1) == ["failed"]


def goal_revision(connection, room_id, goal):
    """Bind state-dependent goal writes to the goal row, the newest message and the room's open work."""
    latest = connection.execute("SELECT COALESCE(MAX(id),0) FROM messages WHERE room_id=?", (room_id,)).fetchone()[0]
    work = [list(row) for row in connection.execute(
        "SELECT id,status FROM member_requests WHERE room_id=? AND status IN ('pending','delivering') ORDER BY id", (room_id,))]
    session = connection.execute("SELECT id,status FROM discussion_sessions WHERE room_id=? ORDER BY id DESC LIMIT 1", (room_id,)).fetchone()
    row = [goal[key] for key in ("id", "status", "objective", "armed", "continues", "max_continues", "max_minutes",
                                 "idle_seconds", "phase", "phase_until")] if goal else None
    encoded = json.dumps([room_id, row, latest, work, list(session) if session else None], ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(encoded.encode()).hexdigest()[:16]


def goal_view(connection, room_id):
    """The room's latest goal (open or ended) with usage, idle state and the revision its writes must carry."""
    row = connection.execute("SELECT * FROM room_goals WHERE room_id=? ORDER BY id DESC LIMIT 1", (room_id,)).fetchone()
    goal = dict(row) if row else None
    open_row = goal if goal and goal["status"] in OPEN_STATUSES else None
    if goal:
        goal["elapsed_seconds"] = elapsed_seconds(goal)
        goal["idle"] = room_idle(connection, room_id, goal)
    return {"goal": goal, "revision": goal_revision(connection, room_id, open_row)}


def require_revision(connection, room_id, payload, action):
    """State-dependent writes carry the revision read from GET goal."""
    if payload.get("revision") is None:
        raise ValueError(f"{action}前须先读取 Goal 状态（GET goal）并带上 revision")
    if str(payload["revision"]) != goal_view(connection, room_id)["revision"]:
        raise FileExistsError("Goal 或房间状态已变化，请重新读取后再提交")


def system_message(connection, room_id, text, key):
    """A visible goal notice in the transcript; requests created by the goal hang on it."""
    created_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    cursor = connection.execute("INSERT INTO messages(room_id,author,text,source,submission_id,created_at) VALUES(?,?,?,?,?,?)",
                                (room_id, GOAL_AUTHOR, text, "goal", key, created_at))
    connection.execute("INSERT INTO message_details (message_id,kind,submitted_by) VALUES (?,?,?)", (cursor.lastrowid, "goal", GOAL_AUTHOR))
    return cursor.lastrowid


def create_goal(connection, room_id, objective, budget, start_request_id=None):
    """Open a goal; callers have checked exclusivity and the host.

    A goal opened from the page gets a start notice. One opened from a `/goal` command starts at that message instead:
    the host's reply sits right under the command, so a separate notice would land after the reply.
    """
    now = int(time.time())
    cursor = connection.execute("""INSERT INTO room_goals (room_id,objective,max_continues,max_minutes,idle_seconds,start_request_id,started_at)
        VALUES (?,?,?,?,?,?,?)""", (room_id, objective, budget["max_continues"], budget["max_minutes"], budget["idle_seconds"],
                                     start_request_id, now))
    goal_id = cursor.lastrowid
    if start_request_id is not None:
        message_id = connection.execute("SELECT message_id FROM member_requests WHERE id=?", (start_request_id,)).fetchone()[0]
    else:
        message_id = system_message(connection, room_id, f"Goal 已开启：{objective}", f"goal-{goal_id}-start")
    connection.execute("UPDATE room_goals SET started_message_id=? WHERE id=?", (message_id, goal_id))
    return goal_id


def end_goal(connection, goal, status, note=""):
    """Close the goal with its reason and leave an end notice; the owner clearing it also cancels wake-ups not yet started.

    A spent budget keeps its wrap-up request, and the host ending the goal is itself answering one.
    """
    now = int(time.time())
    paused = max(0, now - goal["paused_at"]) if goal["paused_at"] else 0
    label = END_LABELS[status] + (f"：{note}" if note else "")
    message_id = system_message(connection, goal["room_id"], label, f"goal-{goal['id']}-end")
    connection.execute("""UPDATE room_goals SET status=?,ended_at=?,end_note=?,ended_message_id=?,paused_at=0,paused_seconds=paused_seconds+?
        WHERE id=?""", (status, now, note, message_id, paused, goal["id"]))
    if status == "cleared":
        where = "status='pending' AND id IN (SELECT request_id FROM goal_continuations WHERE goal_id=?)"
        record_cancel_reasons(connection, where, (goal["id"],), "user_stop")
        connection.execute(f"UPDATE member_requests SET status='cancelled' WHERE {where}", (goal["id"],))


def check_goal_command(connection, room_id, command, argument):
    """Validate an owner's `/goal` command before its message is saved, so a refused command leaves no message behind."""
    goal = open_goal(connection, room_id)
    if command == "start":
        check_exclusive(connection, room_id)
        goal_host(connection, room_id)
        if len(argument) > MAX_OBJECTIVE_LENGTH:
            raise ValueError(f"Goal 目标最多 {MAX_OBJECTIVE_LENGTH} 字")
    elif not goal:
        raise FileExistsError("房间没有进行中的 Goal")
    elif command == "pause" and goal["status"] != "active":
        raise FileExistsError("Goal 已经暂停")
    elif command == "resume" and goal["status"] != "paused":
        raise FileExistsError("Goal 当前没有暂停")
    elif command == "edit":
        clean_objective(argument)


def apply_goal_command(connection, room_id, message_id, command, argument):
    """Run a saved `/goal` message: a start asks the host to fill in the objective, the rest act on the open goal."""
    if command == "start":
        host = goal_host(connection, room_id)
        insert_request(connection, room_id, host["id"], message_id, message_id, "goal_start", "user")
        return
    goal = open_goal(connection, room_id)
    if command == "edit":
        update_goal(connection, goal, {"objective": argument})
    else:
        control_goal(connection, goal, command)


def control_goal(connection, goal, action):
    """Owner controls on the open goal: pause, resume or clear."""
    now = int(time.time())
    if action == "pause":
        if goal["status"] != "active":
            raise FileExistsError("Goal 已经暂停")
        connection.execute("UPDATE room_goals SET status='paused',paused_at=? WHERE id=?", (now, goal["id"]))
    elif action == "resume":
        if goal["status"] != "paused":
            raise FileExistsError("Goal 当前没有暂停")
        connection.execute("""UPDATE room_goals SET status='active',armed=1,paused_seconds=paused_seconds+MAX(0,?-paused_at),paused_at=0
            WHERE id=?""", (now, goal["id"]))
    elif action == "clear":
        end_goal(connection, goal, "cleared", "用户结束")
    else:
        raise ValueError("action 须为 start、continue、wait、state、done、block、pause、resume、clear 或 update")


def update_goal(connection, goal, payload):
    """Owner edits of the open goal's objective or budgets."""
    objective = clean_objective(payload["objective"]) if "objective" in payload else goal["objective"]
    budget = clean_budget(payload, goal)
    connection.execute("UPDATE room_goals SET objective=?,max_continues=?,max_minutes=?,idle_seconds=? WHERE id=?",
                       (objective, budget["max_continues"], budget["max_minutes"], budget["idle_seconds"], goal["id"]))


def start_goal(connection, room_id, token, payload):
    """Open a goal: the host completing a `/goal` start request, or the owner from the page with the revision it read."""
    begin_write(connection)
    objective = clean_objective(payload.get("objective"))
    request_id = payload.get("request_id")
    if request_id is not None:
        member = require_member(connection, room_id, token)
        if member["role"] != "host":
            raise PermissionError("只有主持人能补全并开启 Goal")
        existing = connection.execute("SELECT id FROM room_goals WHERE start_request_id=?", (request_id,)).fetchone()
        if existing:
            return {**goal_view(connection, room_id), "duplicate": True}
        request = connection.execute("SELECT * FROM member_requests WHERE room_id=? AND id=?", (room_id, request_id)).fetchone()
        if (not request or request["purpose"] != "goal_start" or request["member_id"] != member["id"]
                or request["status"] not in ("pending", "delivering")):
            raise FileExistsError("Goal 启动请求不存在、不属于你或已处理；只有用户的 /goal 命令能开启 Goal")
        budget = clean_budget({}, last_idle_seconds(connection, room_id))
    else:
        require_owner(connection, room_id, token)
        require_revision(connection, room_id, payload, "开启 Goal")
        budget = clean_budget(payload, last_idle_seconds(connection, room_id))
    check_exclusive(connection, room_id)
    host = goal_host(connection, room_id)
    goal_id = create_goal(connection, room_id, objective, budget, request_id)
    if request_id is None:
        # Started from the page, nobody is working on it yet: hand it to the host right away instead of waiting for idle.
        message_id = connection.execute("SELECT started_message_id FROM room_goals WHERE id=?", (goal_id,)).fetchone()[0]
        insert_request(connection, room_id, host["id"], message_id, message_id, "goal_continue", "user")
        request = connection.execute("SELECT id FROM member_requests WHERE message_id=? AND member_id=?", (message_id, host["id"])).fetchone()[0]
        connection.execute("INSERT INTO goal_continuations (goal_id,room_id,message_id,request_id) VALUES (?,?,?,?)",
                           (goal_id, room_id, message_id, request))
        connection.execute("UPDATE room_goals SET armed=0 WHERE id=?", (goal_id,))
    return {**goal_view(connection, room_id), "duplicate": False}


def continue_goal(connection, room_id, token, payload):
    """The runner wakes the host once for an idle room; budget and repeated failures end the goal instead."""
    require_owner(connection, room_id, token)
    begin_write(connection)
    require_revision(connection, room_id, payload, "Goal 续跑")
    goal = open_goal(connection, room_id)
    if not goal or not room_idle(connection, room_id, goal):
        raise FileExistsError("Goal 当前不需要续跑")
    host = goal_host(connection, room_id)
    if continuation_statuses(connection, goal["id"]) == ["failed"] * FAILED_CONTINUATIONS:
        end_goal(connection, goal, "blocked", f"连续 {FAILED_CONTINUATIONS} 次续跑执行失败")
        return goal_view(connection, room_id)
    over = (goal["max_continues"] and goal["continues"] >= goal["max_continues"]
            or goal["max_minutes"] and elapsed_seconds(goal) >= goal["max_minutes"] * 60)
    number = goal["continues"] + 1
    if over:
        # The end notice is also where the host's one wrap-up request hangs, so the transcript shows a single card.
        end_goal(connection, goal, "budget_limited", "")
        message_id = connection.execute("SELECT ended_message_id FROM room_goals WHERE id=?", (goal["id"],)).fetchone()[0]
    else:
        message_id = system_message(connection, room_id, f"Goal 续跑 #{number}：{continue_reason(goal)}",
                                    f"goal-{goal['id']}-continue-{number}")
    insert_request(connection, room_id, host["id"], message_id, message_id, "goal_continue", "user")
    request_id = connection.execute("SELECT id FROM member_requests WHERE message_id=? AND member_id=?", (message_id, host["id"])).fetchone()[0]
    connection.execute("INSERT INTO goal_continuations (goal_id,room_id,message_id,request_id,wrapup) VALUES (?,?,?,?,?)",
                       (goal["id"], room_id, message_id, request_id, int(bool(over))))
    if not over:
        # The host is awake again and decides afresh; a pending fallback is spent until the user next speaks.
        connection.execute("""UPDATE room_goals SET continues=?,armed=0,phase='doing',phase_note='',phase_until=0,
            pending_fallback=pending_fallback OR ? WHERE id=?""", (number, int(goal["phase"] == "pending"), goal["id"]))
    return goal_view(connection, room_id)


def continue_reason(goal):
    """Why the host is woken, so it can tell a plain idle room from an expired wait."""
    minutes = max(1, (goal["phase_until"] - goal["phase_since"]) // 60) if goal["phase_until"] else 0
    if goal["phase"] == "waiting":
        return f"等待已超过 {minutes} 分钟，请主持人检查后台工作是否完成，完成就接着推进，未完成可再次声明等待。"
    if goal["phase"] == "pending":
        return (f"用户 {minutes} 分钟未回复，请主持人评估这项决定能否不等用户自行做出：能就说明依据后继续推进；"
                "不能就再次声明待确认，此后一直等到用户回复。")
    return "房间已空闲，请主持人继续推进目标。"


def set_goal_phase(connection, room_id, token, payload):
    """The host declares whether the goal is being worked on, waits on background work, or waits on the user."""
    begin_write(connection)
    member = require_member(connection, room_id, token)
    if member["role"] != "host":
        raise PermissionError("只有主持人能声明 Goal 状态")
    require_revision(connection, room_id, payload, "声明 Goal 状态")
    goal = open_goal(connection, room_id)
    if not goal or goal["status"] != "active":
        raise FileExistsError("房间没有推进中的 Goal")
    phase = payload.get("state")
    if phase not in PHASES:
        raise ValueError("state 须为 doing、waiting 或 pending；完成与卡住用 goal done / goal block")
    note = str(payload.get("note") or "").strip()
    if len(note) > MAX_NOTE_LENGTH:
        raise ValueError(f"说明最多 {MAX_NOTE_LENGTH} 字")
    minutes = payload.get("minutes", PHASE_DEFAULT_MINUTES.get(phase, 0))
    if phase != "doing" and (type(minutes) is not int or not 1 <= minutes <= MAX_PHASE_MINUTES):
        raise ValueError(f"minutes 须为 1–{MAX_PHASE_MINUTES} 的整数")
    now = int(time.time())
    # After its one fallback the pending goal waits for the user with no further deadline.
    until = 0 if phase == "doing" or phase == "pending" and goal["pending_fallback"] else now + minutes * 60
    connection.execute("""UPDATE room_goals SET phase=?,phase_note=?,phase_since=?,phase_until=?,armed=CASE WHEN ?='doing' THEN 1 ELSE armed END
        WHERE id=?""", (phase, note if phase != "doing" else "", now, until, phase, goal["id"]))
    return goal_view(connection, room_id)


def wait_goal(connection, room_id, token, payload):
    """The runner's decision model judged the idle room to be waiting for the user: mark the goal pending.

    This is what the host would declare itself on being woken, so the decision model only saves that wake-up: the same
    fallback wake-up and Weixin notice follow, and a room without the model ends in the same state one execution later.
    Only an armed goal stands down; an idle moment after a failed wake-up keeps retrying toward the failure limit.
    """
    require_owner(connection, room_id, token)
    begin_write(connection)
    require_revision(connection, room_id, payload, "Goal 等待用户")
    goal = open_goal(connection, room_id)
    if not goal or goal["phase"] != "doing" or not goal["armed"] or not room_idle(connection, room_id, goal):
        raise FileExistsError("Goal 当前不在等待唤醒")
    now = int(time.time())
    until = 0 if goal["pending_fallback"] else now + PHASE_DEFAULT_MINUTES["pending"] * 60
    connection.execute("""UPDATE room_goals SET armed=0,phase='pending',phase_note='',phase_since=?,phase_until=? WHERE id=?""",
                       (now, until, goal["id"]))
    return goal_view(connection, room_id)


def finish_goal(connection, room_id, token, payload, status):
    """The host declares the goal complete (verified against the current state) or blocked."""
    begin_write(connection)
    member = require_member(connection, room_id, token)
    if member["role"] != "host":
        raise PermissionError("只有主持人能宣告 Goal 完成或卡住")
    require_revision(connection, room_id, payload, "宣告 Goal 完成" if status == "complete" else "宣告 Goal 卡住")
    goal = open_goal(connection, room_id)
    if not goal:
        raise FileExistsError("房间没有进行中的 Goal")
    note = str(payload.get("note") or "").strip()
    if len(note) > MAX_NOTE_LENGTH or status == "blocked" and not note:
        raise ValueError(f"说明须为 {'1' if status == 'blocked' else '0'}–{MAX_NOTE_LENGTH} 字；宣告卡住须写明阻碍")
    if status == "complete":
        others = [row[0] for row in connection.execute("""SELECT DISTINCT m.name FROM member_requests r JOIN room_members m ON m.id=r.member_id
            WHERE r.room_id=? AND r.status IN ('pending','delivering') AND r.member_id<>? ORDER BY m.name""", (room_id, member["id"]))]
        if others:
            raise ValueError(f"仍有成员的请求未结束：{'、'.join(others)}；等它们完成或取消后再宣告完成")
    end_goal(connection, goal, status, note)
    return goal_view(connection, room_id)


def goal_action(connection, room_id, token, payload):
    """Dispatch POST /goal by action; owner controls need the room credential, the host's declarations its own."""
    action = payload.get("action")
    if action == "start":
        return start_goal(connection, room_id, token, payload)
    if action == "continue":
        return continue_goal(connection, room_id, token, payload)
    if action == "wait":
        return wait_goal(connection, room_id, token, payload)
    if action == "state":
        return set_goal_phase(connection, room_id, token, payload)
    if action in ("done", "block"):
        return finish_goal(connection, room_id, token, payload, "complete" if action == "done" else "blocked")
    require_owner(connection, room_id, token)
    begin_write(connection)
    goal = open_goal(connection, room_id)
    if not goal:
        raise FileExistsError("房间没有进行中的 Goal")
    if action == "update":
        update_goal(connection, goal, payload)
    else:
        control_goal(connection, goal, action)
    return goal_view(connection, room_id)


def arm_goal(connection, room_id):
    """New work (an owner message or a host dispatch) lets the next idle moment wake the host again."""
    connection.execute("UPDATE room_goals SET armed=1 WHERE room_id=? AND status='active'", (room_id,))

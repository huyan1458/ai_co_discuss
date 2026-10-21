"""Free collaboration rooms: member credentials, durable requests and per-member executions.

A free room has no floor, turns or rounds. The user (holding the room control credential)
names members; each named member gets one durable request per message. The local runner
delivers a member's open requests as one execution, and the member's answer completes them.
No software is launched here.
"""

import hmac
import time

from .runtime import LEASE_SECONDS, begin_write, token_hash

FREE_EXECUTION_MINUTES = 20
MAX_FREE_MEMBERS = 1  # P1 serves one AI member; the tables already allow more.
RECENT_REQUESTS = 100
ACTIVE = ("dispatched", "started")
FREE_OPERATIONS = ("messages", "attachments", "move", "folder", "archive", "restore", "delete")
MEMBER_FIELDS = ("id", "name", "adapter", "role", "status", "read_until")
EXECUTION_FIELDS = ("id", "member_id", "status", "session_id", "lease_until", "created_at", "finished_at", "result")


def room_mode(connection, room_id):
    """Return 'free' for free rooms; every legacy room is a brainstorm room."""
    row = connection.execute("SELECT mode FROM room_modes WHERE room_id=?", (room_id,)).fetchone()
    return row[0] if row else "brainstorm"


def member_values(members, participants):
    """Validate the initial members and their client-generated credentials."""
    if not isinstance(members, list) or not 1 <= len(members) <= MAX_FREE_MEMBERS:
        raise ValueError(f"自由房间目前须有 1–{MAX_FREE_MEMBERS} 位 AI 成员")
    result = []
    for member in members:
        if not isinstance(member, dict) or member.get("name") not in participants[1:]:
            raise ValueError("成员须为有效 AI 身份")
        if not token_hash(member.get("token")):
            raise ValueError("每位成员须提供 32–256 字符的成员凭证")
        adapter = member.get("adapter", "")
        if not isinstance(adapter, str) or len(adapter) > 40:
            raise ValueError("成员适配器名称无效")
        result.append({"name": member["name"], "adapter": adapter, "token": member["token"]})
    if len({member["name"] for member in result}) != len(result):
        raise ValueError("成员名称不能重复")
    return result


def save_free_room(connection, room_id, control_token, members, now):
    """Persist the mode, the owner's control hash and the members in the creating transaction."""
    control = token_hash(control_token)
    if not control:
        raise ValueError("自由房间须提供 32–256 字符的房间控制凭据")
    connection.execute("INSERT INTO room_modes (room_id,mode,control_hash) VALUES (?,?,?)", (room_id, "free", control))
    for member in members:
        connection.execute("INSERT INTO room_members (room_id,name,adapter,token_hash,created_at) VALUES (?,?,?,?,?)",
                           (room_id, member["name"], member["adapter"], token_hash(member["token"]), now))


def execution_minutes(connection, room_id):
    """Free rooms always bound one execution; zero in the shared limits means the default."""
    row = connection.execute("SELECT execution_minutes FROM discussion_limits WHERE room_id=?", (room_id,)).fetchone()
    return (row[0] if row and row[0] else FREE_EXECUTION_MINUTES)


def public_execution(row):
    """Return execution state without any credential material."""
    return {key: row[key] for key in EXECUTION_FIELDS} if row else None


def free_view(connection, room_id):
    """Summarize members, their live execution and recent request states for the page and CLI."""
    now = int(time.time())
    members = []
    for row in connection.execute("SELECT * FROM room_members WHERE room_id=? AND status<>'removed' ORDER BY id", (room_id,)):
        member = {key: row[key] for key in MEMBER_FIELDS}
        latest = connection.execute("SELECT * FROM member_executions WHERE member_id=? ORDER BY id DESC LIMIT 1",
                                    (row["id"],)).fetchone()
        member["execution"] = public_execution(latest)
        if latest and latest["status"] in ACTIVE:
            member["execution"]["stale"] = latest["lease_until"] <= now
        member["pending"] = connection.execute("SELECT COUNT(*) FROM member_requests WHERE member_id=? AND status='pending'",
                                               (row["id"],)).fetchone()[0]
        members.append(member)
    names = {member["id"]: member["name"] for member in members}
    requests = [{**dict(row), "member": names.get(row["member_id"], "")} for row in connection.execute(
        """SELECT id,member_id,message_id,status,execution_id,answer_id FROM member_requests
        WHERE room_id=? ORDER BY id DESC LIMIT ?""", (room_id, RECENT_REQUESTS))]
    return {"members": members, "requests": requests[::-1], "execution_minutes": execution_minutes(connection, room_id)}


def require_owner(connection, room_id, token):
    """Accept only the room control credential; declared names never grant ownership."""
    row = connection.execute("SELECT control_hash FROM room_modes WHERE room_id=? AND mode='free'", (room_id,)).fetchone()
    hashed = token_hash(token)
    if not row or not hashed or not hmac.compare_digest(hashed, row[0]):
        raise PermissionError("需要本房间的控制凭据；没有凭据只能阅读")


def require_member(connection, room_id, token, name=None):
    """Resolve an active member strictly from its own credential."""
    hashed = token_hash(token)
    row = connection.execute("SELECT * FROM room_members WHERE room_id=? AND token_hash=? AND status='active'",
                             (room_id, hashed)).fetchone() if hashed else None
    if not row or (name is not None and row["name"] != name):
        raise PermissionError("成员凭证无效、已停用或与发言身份不符")
    return row


def authorize_free_write(connection, room_id, token, operation, payload):
    """Decide who is writing: the owner, or one member posting its own answer.

    Returns:
        "用户" for the owner, or the member row for a member credential.
    """
    begin_write(connection)
    if operation not in FREE_OPERATIONS:
        raise ValueError("自由房间不使用发言权、安排、阶段或轮次")
    try:
        require_owner(connection, room_id, token)
        return "用户"
    except PermissionError:
        if operation not in ("messages", "attachments"):
            raise
    author = payload.get("author")
    if author == "用户" or payload.get("submitted_by", author) != author:
        raise PermissionError("需要本房间的控制凭据；成员不能以用户身份或代他人发言")
    return require_member(connection, room_id, token, author)


def recipients(connection, room_id, payload):
    """Resolve structured recipients; a single active member is named by default."""
    active = {row["name"]: row["id"] for row in connection.execute(
        "SELECT id,name FROM room_members WHERE room_id=? AND status='active'", (room_id,))}
    names = payload.get("to")
    if names is None:
        return list(active.values()) if len(active) == 1 else []
    if not isinstance(names, list) or any(name not in active for name in names):
        raise ValueError("点名对象须为本房间在场成员")
    return [active[name] for name in dict.fromkeys(names)]


def check_answer(connection, room_id, member, payload):
    """Require a member's answer to complete a live execution of its own."""
    execution_id = payload.get("execution_id")
    if type(execution_id) is not int:
        raise ValueError("成员回答须关联本次执行编号 execution_id")
    row = connection.execute("SELECT * FROM member_executions WHERE room_id=? AND id=?", (room_id, execution_id)).fetchone()
    if not row or row["member_id"] != member["id"]:
        raise PermissionError("执行编号不属于本成员")
    if row["status"] not in ACTIVE or row["lease_until"] <= int(time.time()):
        raise FileExistsError("本次执行已结束、被打断或已过期；回答不能改作普通发言，请保留草稿")
    return row


def after_free_message(connection, room_id, message_id, actor, payload):
    """Create requests for the owner's message, or complete the member's execution."""
    now = int(time.time())
    if actor == "用户":
        for member_id in recipients(connection, room_id, payload):
            connection.execute("INSERT INTO member_requests (room_id,member_id,message_id,created_at) VALUES (?,?,?,?)",
                               (room_id, member_id, message_id, now))
        return
    execution_id = payload["execution_id"]
    connection.execute("UPDATE member_executions SET status='completed',finished_at=?,result=? WHERE id=?",
                       (now, f"message:{message_id}", execution_id))
    connection.execute("UPDATE member_requests SET status='completed',answer_id=? WHERE execution_id=? AND status='delivering'",
                       (message_id, execution_id))
    connection.execute("UPDATE room_members SET read_until=MAX(read_until,?) WHERE id=?", (message_id, actor["id"]))


def expire_executions(connection, room_id):
    """Fail executions whose lease lapsed; their requests stay visible as failed, never silently retried."""
    now = int(time.time())
    stale = [row["id"] for row in connection.execute(
        "SELECT id FROM member_executions WHERE room_id=? AND status IN ('dispatched','started') AND lease_until<=?", (room_id, now))]
    for execution_id in stale:
        finish_execution(connection, execution_id, "failed", "执行租约到期，接入程序未续租", "failed")


def finish_execution(connection, execution_id, status, result, request_status):
    """End one execution and move its delivered requests in the same transaction."""
    connection.execute("UPDATE member_executions SET status=?,finished_at=?,result=? WHERE id=? AND status IN ('dispatched','started')",
                       (status, int(time.time()), result[:500], execution_id))
    connection.execute("UPDATE member_requests SET status=?,execution_id=CASE WHEN ?='pending' THEN NULL ELSE execution_id END WHERE execution_id=? AND status='delivering'",
                       (request_status, request_status, execution_id))


def inbox(connection, room_id, token):
    """List what the runner should deliver or reconcile; owner credential only."""
    require_owner(connection, room_id, token)
    begin_write(connection)
    expire_executions(connection, room_id)
    archived = connection.execute("SELECT archived FROM room_directory WHERE room_id=?", (room_id,)).fetchone()[0]
    members = []
    for row in connection.execute("SELECT * FROM room_members WHERE room_id=? AND status='active' ORDER BY id", (room_id,)):
        pending = [dict(item) for item in connection.execute(
            "SELECT id,message_id FROM member_requests WHERE member_id=? AND status='pending' ORDER BY id", (row["id"],))]
        members.append({**{key: row[key] for key in MEMBER_FIELDS}, "pending": pending})
    executions = [public_execution(row) for row in connection.execute(
        "SELECT * FROM member_executions WHERE room_id=? AND status IN ('dispatched','started') ORDER BY id", (room_id,))]
    return {"room_id": room_id, "archived": bool(archived), "members": members, "executions": executions,
            "execution_minutes": execution_minutes(connection, room_id)}


def reserve_execution(connection, room_id, token, payload):
    """Bundle a member's open requests into one execution; a retried client_id returns the same one."""
    require_owner(connection, room_id, token)
    begin_write(connection)
    client_id = str(payload.get("client_id", ""))
    if not 8 <= len(client_id) <= 100:
        raise ValueError("client_id 须为 8–100 字符的本地投递编号")
    previous = connection.execute("SELECT * FROM member_executions WHERE room_id=? AND client_id=?", (room_id, client_id)).fetchone()
    if previous:
        return execution_detail(connection, previous)
    expire_executions(connection, room_id)
    if connection.execute("SELECT archived FROM room_directory WHERE room_id=?", (room_id,)).fetchone()[0]:
        raise FileExistsError("频道已存档，不再投递")
    member = connection.execute("SELECT * FROM room_members WHERE room_id=? AND id=? AND status='active'",
                                (room_id, payload.get("member_id"))).fetchone()
    if not member:
        raise LookupError("成员不存在或已离开")
    if connection.execute("SELECT 1 FROM member_executions WHERE member_id=? AND status IN ('dispatched','started')",
                          (member["id"],)).fetchone():
        raise FileExistsError("该成员已有进行中的执行；同一会话不并发续接")
    if not connection.execute("SELECT 1 FROM member_requests WHERE member_id=? AND status='pending'", (member["id"],)).fetchone():
        raise FileExistsError("该成员没有待投递的请求")
    now = int(time.time())
    cursor = connection.execute("""INSERT INTO member_executions (room_id,member_id,client_id,lease_until,created_at)
        VALUES (?,?,?,?,?)""", (room_id, member["id"], client_id, now + LEASE_SECONDS, now))
    connection.execute("UPDATE member_requests SET status='delivering',execution_id=? WHERE member_id=? AND status='pending'",
                       (cursor.lastrowid, member["id"]))
    return execution_detail(connection, connection.execute("SELECT * FROM member_executions WHERE id=?", (cursor.lastrowid,)).fetchone())


def execution_detail(connection, row):
    """Describe one execution with the requests it carries and the member's read cursor."""
    member = connection.execute("SELECT * FROM room_members WHERE id=?", (row["member_id"],)).fetchone()
    requests = [dict(item) for item in connection.execute(
        "SELECT id,message_id,status FROM member_requests WHERE execution_id=? ORDER BY id", (row["id"],))]
    return {**public_execution(row), "member": member["name"], "read_until": member["read_until"], "requests": requests}


def view_execution(connection, room_id, execution_id, token):
    """Let the owner or the executing member read one execution."""
    row = connection.execute("SELECT * FROM member_executions WHERE room_id=? AND id=?", (room_id, execution_id)).fetchone()
    if not row:
        raise LookupError("执行不存在")
    try:
        require_owner(connection, room_id, token)
    except PermissionError:
        member = require_member(connection, room_id, token)
        if member["id"] != row["member_id"]:
            raise
    return execution_detail(connection, row)


def execution_action(connection, room_id, execution_id, token, payload):
    """Runner-side lifecycle: renew the lease, report failure, or release undelivered work."""
    require_owner(connection, room_id, token)
    begin_write(connection)
    row = connection.execute("SELECT * FROM member_executions WHERE room_id=? AND id=?", (room_id, execution_id)).fetchone()
    if not row:
        raise LookupError("执行不存在")
    action = payload.get("action")
    now = int(time.time())
    if row["status"] not in ACTIVE:
        raise FileExistsError("执行已结束")
    if action == "renew":
        limit = row["created_at"] + execution_minutes(connection, room_id) * 60
        if row["lease_until"] <= now or limit <= now:
            raise FileExistsError("执行租约或单次时限已到，不能续租")
        connection.execute("UPDATE member_executions SET lease_until=? WHERE id=?", (min(now + LEASE_SECONDS, limit), execution_id))
    elif action == "fail":
        finish_execution(connection, execution_id, "failed", str(payload.get("reason") or "执行失败"), "failed")
    elif action == "release":
        # Only for proven non-delivery: the requests return to the queue unchanged.
        finish_execution(connection, execution_id, "cancelled", str(payload.get("reason") or "未送达"), "pending")
    else:
        raise ValueError("action 须为 renew、fail 或 release")
    return execution_detail(connection, connection.execute("SELECT * FROM member_executions WHERE id=?", (execution_id,)).fetchone())


def interrupt_member(connection, room_id, member_id, token):
    """Owner stop: void the live execution and every open request, so nothing restarts by itself."""
    require_owner(connection, room_id, token)
    begin_write(connection)
    member = connection.execute("SELECT * FROM room_members WHERE room_id=? AND id=?", (room_id, member_id)).fetchone()
    if not member:
        raise LookupError("成员不存在")
    for row in connection.execute("SELECT id FROM member_executions WHERE member_id=? AND status IN ('dispatched','started')",
                                  (member_id,)).fetchall():
        finish_execution(connection, row["id"], "cancelled", "用户打断", "cancelled")
    connection.execute("UPDATE member_requests SET status='cancelled' WHERE member_id=? AND status='pending'", (member_id,))
    return free_view(connection, room_id)

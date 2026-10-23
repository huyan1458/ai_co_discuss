"""Free collaboration rooms: member credentials, durable requests and per-member executions.

A free room has no floor, turns or rounds. The user (holding the room control credential)
names members; each named member gets one durable request per message. The local runner
delivers a runner member's open requests as one execution, and the member's answer completes
them. A manual member finds its own requests and answers by request id; an online member's
answer is forwarded by the owner. The user is the client, never the host: one member that
answers by itself always hosts, routes unnamed messages, names members in its answers, and is
woken once when everything it dispatched has finished. No software is launched here.
"""

import hmac
import json
import re
import time
import uuid

from .identity import MAX_ROOM_AGENTS, is_ai
from .runtime import LEASE_SECONDS, begin_write, require_owner, token_hash

FREE_EXECUTION_MINUTES = 20
RECENT_REQUESTS = 100
RECENT_EXECUTIONS = 100
RECENT_CHANGES = 50
MAX_CHANGED_FILES = 200
MAX_PATH_LENGTH = 500
ACTIVE = ("dispatched", "started")
ACCESS_MODES = ("runner", "manual", "online")
# AI-created requests (host dispatches and hand-offs) allowed per chain; each owner message starts a chain.
MAX_AUTO_HOPS = 8
# A host that left gives up the role; the first active runner member (else manual) then takes it.
RELEASE_HOST = "UPDATE room_members SET role='member' WHERE room_id=? AND role='host' AND status<>'active'"
ASSIGN_HOST = """UPDATE room_members SET role='host' WHERE id=(SELECT id FROM room_members WHERE room_id=? AND status='active'
    AND access<>'online' ORDER BY access='runner' DESC, id LIMIT 1)
    AND NOT EXISTS (SELECT 1 FROM room_members WHERE room_id=? AND role='host' AND status='active')"""
TERMINAL = ("completed", "cancelled", "failed")
SESSION_MODES = ("new", "borrowed")
FREE_OPERATIONS = ("messages", "attachments", "move", "folder", "archive", "restore", "delete")
MEMBER_FIELDS = ("id", "name", "adapter", "role", "status", "access", "session_mode", "read_until")
EXECUTION_FIELDS = ("id", "member_id", "status", "session_id", "lease_until", "created_at", "finished_at", "result")
# Columns added after the first free-room tables; Python databases created by that build gain them here.
LATER_COLUMNS = {"room_members": {"access": "TEXT NOT NULL DEFAULT 'runner'", "session_mode": "TEXT NOT NULL DEFAULT 'new'"},
                 "member_executions": {"changes": "TEXT NOT NULL DEFAULT ''", "cwd": "TEXT NOT NULL DEFAULT ''"},
                 "member_requests": {"chain_id": "INTEGER NOT NULL DEFAULT 0", "batch_id": "INTEGER NOT NULL DEFAULT 0",
                                     "purpose": "TEXT NOT NULL DEFAULT 'ask'", "created_by": "TEXT NOT NULL DEFAULT 'user'"}}


def migrate_free_tables(connection):
    """Add columns that early free-room databases lack; repeated runs change nothing."""
    for table, columns in LATER_COLUMNS.items():
        present = {row[1] for row in connection.execute(f"PRAGMA table_info({table})")}
        for name, definition in columns.items():
            if name not in present:
                connection.execute(f"ALTER TABLE {table} ADD COLUMN {name} {definition}")


def room_mode(connection, room_id):
    """Return 'free' for free rooms; every legacy room is a brainstorm room."""
    row = connection.execute("SELECT mode FROM room_modes WHERE room_id=?", (room_id,)).fetchone()
    return row[0] if row else "brainstorm"


def member_value(member):
    """Validate one member and its client-generated credential."""
    if not isinstance(member, dict) or not is_ai(member.get("name")):
        raise ValueError("成员须为有效 AI 身份")
    if not token_hash(member.get("token")):
        raise ValueError("每位成员须提供 32–256 字符的成员凭证")
    adapter = member.get("adapter", "")
    if not isinstance(adapter, str) or len(adapter) > 40:
        raise ValueError("成员适配器名称无效")
    access, session_mode = member.get("access", "runner"), member.get("session_mode", "new")
    if access not in ACCESS_MODES or session_mode not in SESSION_MODES:
        raise ValueError("成员接入方式须为 runner/manual/online，会话方式须为 new/borrowed")
    return {"name": member["name"], "adapter": adapter, "token": member["token"], "access": access, "session_mode": session_mode}


def member_values(members):
    """Validate independent member credentials for a room."""
    if not isinstance(members, list) or not 1 <= len(members) <= MAX_ROOM_AGENTS:
        raise ValueError("房间须有至少 1 位 AI 成员，且不超过成员上限")
    result = [member_value(member) for member in members]
    if len({member["name"] for member in result}) != len(result):
        raise ValueError("成员名称不能重复")
    if len({member["token"] for member in result}) != len(result):
        raise ValueError("每位成员须使用独立凭证")
    return result


def insert_member(connection, room_id, member, now):
    """Store one member with only its credential hash."""
    connection.execute("""INSERT INTO room_members (room_id,name,adapter,token_hash,access,session_mode,created_at)
        VALUES (?,?,?,?,?,?,?)""", (room_id, member["name"], member["adapter"], token_hash(member["token"]),
                                     member["access"], member["session_mode"], now))


def save_room_access(connection, room_id, control_token, members, settings):
    """Persist the mode, the owner's control hash and the members in the creating transaction."""
    control = token_hash(control_token)
    if not control:
        raise ValueError("建房须提供 32–256 字符的房间控制凭据")
    if any(token_hash(member["token"]) == control for member in members):
        raise ValueError("成员凭证不能与房主控制凭据相同")
    connection.execute("INSERT INTO room_modes (room_id,mode,control_hash) VALUES (?,?,?)", (room_id, settings["mode"], control))
    for member in members:
        insert_member(connection, room_id, member, settings["created_at"])
    connection.execute("UPDATE room_members SET role='host' WHERE room_id=? AND name=?", (room_id, settings["host"]))


def discussion_members(payload, settings):
    """Validate credentials against the room's declared participants and delivery mode."""
    members = member_values(payload.get("members")) if settings["experts"] else []
    if {member["name"] for member in members} != set(settings["experts"]):
        raise ValueError("成员凭证名单须与参与者名单一致")
    for member in members:
        expected = "online" if settings["experts"][member["name"]] == "online" else (
            "runner" if payload.get("runtime_mode") == "automatic" else "manual")
        if member["access"] != expected:
            raise ValueError("成员接入方式与房间参与能力、任务交付方式不符")
    return members


def sync_discussion_members(connection, room_id, payload, settings):
    """Keep existing credentials; require fresh credentials for added or changed members."""
    current = {row["name"]: row for row in connection.execute("SELECT * FROM room_members WHERE room_id=? AND status='active'", (room_id,))}
    supplied = {member["name"]: member_value(member) for member in payload.get("members", [])}
    run = connection.execute("SELECT mode FROM discussion_runtime WHERE room_id=?", (room_id,)).fetchone()
    for name, capability in settings["experts"].items():
        access = "online" if capability == "online" else ("runner" if run and run[0] == "automatic" else "manual")
        old = current.get(name)
        if old and (old["access"] == "online") == (access == "online"):
            if name in supplied and token_hash(supplied[name]["token"]) != old["token_hash"]:
                raise FileExistsError("成员凭证与已登记身份不符；请核对原接入文件")
            continue
        if name not in supplied or supplied[name]["access"] != access:
            raise ValueError(f"新增或改变接入方式的成员 {name} 须提供独立的新凭证")
        member = supplied[name]
        hashed = token_hash(member["token"])
        if connection.execute("SELECT 1 FROM room_members WHERE room_id=? AND token_hash=? UNION ALL SELECT 1 FROM room_modes WHERE room_id=? AND control_hash=?", (room_id, hashed, room_id, hashed)).fetchone():
            raise ValueError("新成员凭证不能复用已有凭证")
        connection.execute("UPDATE room_members SET status='removed' WHERE room_id=? AND name=?", (room_id, name))
        insert_member(connection, room_id, member, int(time.time()))
    for name in current.keys() - settings["experts"].keys():
        connection.execute("UPDATE room_members SET status='removed' WHERE room_id=? AND name=?", (room_id, name))
    connection.execute("UPDATE room_members SET role=CASE WHEN name=? THEN 'host' ELSE 'member' END WHERE room_id=?", (settings["host"], room_id))


def sync_participants(connection, room_id):
    """Keep one active AI host, then mirror member capabilities and the host into shared room metadata."""
    connection.execute(RELEASE_HOST, (room_id,))
    connection.execute(ASSIGN_HOST, (room_id, room_id))
    members = connection.execute("SELECT name,access,role,status FROM room_members WHERE room_id=? AND status<>'removed' ORDER BY id", (room_id,)).fetchall()
    experts = {row["name"]: "online" if row["access"] == "online" else "cli" for row in members}
    host = next((row["name"] for row in members if row["role"] == "host" and row["status"] == "active"), "用户")
    connection.execute("UPDATE topic_settings SET experts=?,host=? WHERE room_id=?",
                       (json.dumps(experts, ensure_ascii=False), host, room_id))


def execution_minutes(connection, room_id):
    """Free rooms always bound one execution; zero in the shared limits means the default."""
    row = connection.execute("SELECT execution_minutes FROM discussion_limits WHERE room_id=?", (room_id,)).fetchone()
    return (row[0] if row and row[0] else FREE_EXECUTION_MINUTES)


def public_execution(row):
    """Return execution state without any credential material."""
    return {key: row[key] for key in EXECUTION_FIELDS} if row else None


def recent_executions(connection, room_id):
    """Return bounded public reports, including requests no longer in the recent request list."""
    rows = connection.execute("""SELECT e.*,
        (SELECT json_group_array(id) FROM member_requests WHERE execution_id=e.id) AS request_ids,
        (SELECT MAX(answer_id) FROM member_requests WHERE execution_id=e.id) AS answer_id,
        (SELECT MIN(message_id) FROM member_requests WHERE execution_id=e.id) AS request_message_id
        FROM member_executions e WHERE room_id=? ORDER BY id DESC LIMIT ?""", (room_id, RECENT_EXECUTIONS))
    return [{**public_execution(row), "cwd": row["cwd"], "changes": json.loads(row["changes"] or "[]"),
             "changes_recorded": bool(row["changes"]), "request_ids": json.loads(row["request_ids"]),
             "answer_id": row["answer_id"], "request_message_id": row["request_message_id"]} for row in rows]


def possible_conflicts(connection, room_id, names):
    """Report files changed by executions of different members whose time windows overlapped.

    This is an observation, not attribution: it cannot tell who wrote which part or catch
    writes outside the scanned working directory.
    """
    now = int(time.time())
    rows = [dict(row) for row in connection.execute(
        """SELECT id,member_id,created_at,finished_at,changes,cwd FROM member_executions
        WHERE room_id=? AND changes<>'' ORDER BY id DESC LIMIT ?""", (room_id, RECENT_CHANGES))]
    for row in rows:
        row["files"] = set(json.loads(row["changes"]))
        row["end"] = row["finished_at"] or now
    conflicts = []
    for index, first in enumerate(rows):
        for second in rows[index + 1:]:
            if first["member_id"] == second["member_id"] or first["cwd"] != second["cwd"]:
                continue
            if first["created_at"] > second["end"] or second["created_at"] > first["end"]:
                continue
            files = sorted(first["files"] & second["files"])
            if files:
                conflicts.append({"members": [names.get(second["member_id"], ""), names.get(first["member_id"], "")],
                                  "executions": [second["id"], first["id"]], "files": files})
    return conflicts


def free_view(connection, room_id):
    """Summarize members, their live execution, recent requests and possible file conflicts."""
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
    names = {row["id"]: row["name"] for row in connection.execute("SELECT id,name FROM room_members WHERE room_id=?", (room_id,))}
    requests = [{**dict(row), "member": names.get(row["member_id"], "")} for row in connection.execute(
        """SELECT id,member_id,message_id,status,execution_id,answer_id,chain_id,batch_id,purpose,created_by FROM member_requests
        WHERE room_id=? ORDER BY id DESC LIMIT ?""", (room_id, RECENT_REQUESTS))]
    chains = [dict(row) for row in connection.execute(
        "SELECT chain_id,reason FROM free_chains WHERE room_id=? ORDER BY chain_id DESC LIMIT 10", (room_id,))]
    return {"members": members, "requests": requests[::-1], "executions": recent_executions(connection, room_id), "execution_minutes": execution_minutes(connection, room_id),
            "conflicts": possible_conflicts(connection, room_id, names), "halted_chains": chains, "max_auto_hops": MAX_AUTO_HOPS}


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


def active_members(connection, room_id):
    """Map active member names to their rows."""
    return {row["name"]: row for row in connection.execute("SELECT * FROM room_members WHERE room_id=? AND status='active'", (room_id,))}


def named_members(active, names, exclude=None):
    """Validate a structured recipient list against the active members."""
    if not isinstance(names, list) or any(name not in active or name == exclude for name in names):
        raise ValueError("点名对象须为本房间在场成员" + ("，且不能点名自己" if exclude else ""))
    return [active[name]["id"] for name in dict.fromkeys(names)]


def recipients(connection, room_id, payload):
    """Resolve an owner message's recipients as (member id, purpose) pairs.

    A single active member is named by default. With several, an unnamed message goes to the
    AI host for routing; only a room of online members has none, and then it stays a plain note.
    """
    # Rooms created while the user could host get their AI host on the next message.
    sync_participants(connection, room_id)
    active = active_members(connection, room_id)
    if payload.get("to") is not None:
        return [(member_id, "ask") for member_id in named_members(active, payload["to"])]
    if len(active) == 1:
        return [(next(iter(active.values()))["id"], "ask")]
    host = next((row for row in active.values() if row["role"] == "host"), None)
    return [(host["id"], "route")] if host else []


def proxy_member(connection, room_id, author):
    """Return the active online member the owner may forward an answer for."""
    row = connection.execute("SELECT * FROM room_members WHERE room_id=? AND name=? AND status='active' AND access='online'",
                             (room_id, author)).fetchone()
    if not row:
        raise PermissionError("房间控制凭据只能以用户身份发言，或代发在线成员的回答")
    return row


def check_answer(connection, room_id, member, payload):
    """A runner member completes a live execution; a manual member may close its own open requests.

    Only the AI host dispatches work; other members' targets remain suggestions.
    """
    if payload.get("to") is not None:
        named_members(active_members(connection, room_id), payload["to"], exclude=member["name"])
    if member["access"] == "online":
        raise PermissionError("在线成员只读，回答由用户代发")
    if member["access"] == "manual":
        request_ids = payload.get("request_ids", [])
        if payload.get("execution_id") is not None or not isinstance(request_ids, list) or any(type(item) is not int for item in request_ids):
            raise ValueError("手动接入成员用 request_ids 关联请求，不使用执行编号")
        for request_id in request_ids:
            row = connection.execute("SELECT * FROM member_requests WHERE room_id=? AND id=?", (room_id, request_id)).fetchone()
            if not row or row["member_id"] != member["id"] or row["status"] != "pending":
                raise FileExistsError(f"请求 {request_id} 不属于本成员或已处理")
        return None
    execution_id = payload.get("execution_id")
    if type(execution_id) is not int:
        raise ValueError("成员回答须关联本次执行编号 execution_id")
    row = connection.execute("SELECT * FROM member_executions WHERE room_id=? AND id=?", (room_id, execution_id)).fetchone()
    if not row or row["member_id"] != member["id"]:
        raise PermissionError("执行编号不属于本成员")
    if row["status"] not in ACTIVE or row["lease_until"] <= int(time.time()):
        raise FileExistsError("本次执行已结束、被打断或已过期；回答不能改作普通发言，请保留草稿")
    return row


def check_proxy(connection, room_id, member, payload):
    """The owner forwards an online member's answer and may close that member's open requests."""
    request_ids = payload.get("request_ids", [])
    if not isinstance(request_ids, list) or any(type(item) is not int for item in request_ids):
        raise ValueError("request_ids 须为请求编号列表")
    for request_id in request_ids:
        row = connection.execute("SELECT * FROM member_requests WHERE room_id=? AND id=?", (room_id, request_id)).fetchone()
        if not row or row["member_id"] != member["id"] or row["status"] != "pending":
            raise FileExistsError(f"请求 {request_id} 不属于该在线成员或已处理")


def insert_request(connection, room_id, member_id, message_id, chain_id, purpose, created_by, batch_id=0):
    """Queue one request; every request belongs to the chain its owner message started."""
    connection.execute("""INSERT INTO member_requests (room_id,member_id,message_id,chain_id,batch_id,purpose,created_by,created_at)
        VALUES (?,?,?,?,?,?,?,?)""", (room_id, member_id, message_id, chain_id, batch_id, purpose, created_by, int(time.time())))


def mention_prose(text):
    """Remove Markdown code and quote blocks before interpreting response suggestions."""
    lines, fence, quoted = [], "", False
    for line in text.splitlines():
        marker = re.match(r"^ {0,3}(`{3,}|~{3,})", line)
        if marker:
            value = marker[1]
            if not fence:
                fence = value
            elif value[0] == fence[0] and len(value) >= len(fence):
                fence = ""
            continue
        if fence or re.match(r"^( {4}|\t)", line):
            continue
        if re.match(r"^ {0,3}>", line):
            quoted = True
            continue
        if not line.strip():
            quoted = False
        if not quoted:
            lines.append(line)
    return re.sub(r"(`+)[\s\S]*?\1(?!`)", "", "\n".join(lines))


def save_suggestions(connection, room_id, message_id, member, payload):
    """Save ordinary members' explicit targets and prose mentions without waking anyone."""
    if member == "用户" or member["role"] == "host":
        return
    active = active_members(connection, room_id)
    targets = set(named_members(active, payload["to"] if payload.get("to") is not None else [], exclude=member["name"]))
    prose = mention_prose(str(payload.get("text", "")))
    for name, target in active.items():
        if name != member["name"] and re.search(r"(^|[\s(（，,。；;：:])@" + re.escape(name) + r"(?![A-Za-z0-9_\-\u4e00-\u9fff])", prose):
            targets.add(target["id"])
    for target_id in targets:
        connection.execute("INSERT INTO member_suggestions (message_id,member_id) VALUES (?,?)", (message_id, target_id))


def message_suggestions(connection, message_id):
    """Expose suggested members and the durable request, including terminal conversions."""
    return [dict(row) for row in connection.execute("""SELECT s.member_id,m.name AS member,m.status,
        r.id AS request_id,r.status AS request_status FROM member_suggestions s
        JOIN room_members m ON m.id=s.member_id
        LEFT JOIN member_requests r ON r.message_id=s.message_id AND r.member_id=s.member_id
        WHERE s.message_id=? ORDER BY s.member_id""", (message_id,))]


def convert_suggestion(connection, room_id, token, payload):
    """Let the owner turn a saved suggestion into one request and a fresh user chain."""
    begin_write(connection)
    require_owner(connection, room_id, token)
    message_id, member_id = payload.get("message_id"), payload.get("member_id")
    if type(message_id) is not int or type(member_id) is not int:
        raise ValueError("须提供原消息编号 message_id 与成员编号 member_id")
    target = connection.execute("""SELECT m.name,m.status FROM member_suggestions s
        JOIN messages source ON source.id=s.message_id JOIN room_members m ON m.id=s.member_id
        WHERE source.room_id=? AND m.room_id=? AND s.message_id=? AND s.member_id=?""",
        (room_id, room_id, message_id, member_id)).fetchone()
    if not target:
        raise LookupError("这条消息没有该成员的回应建议")
    if target["status"] != "active":
        raise FileExistsError("该成员已离开，不能转为请求")
    if connection.execute("SELECT 1 FROM room_directory WHERE room_id=? AND archived=1", (room_id,)).fetchone():
        raise ValueError("房间已存档；恢复后才能继续协作")
    previous = connection.execute("SELECT * FROM member_requests WHERE message_id=? AND member_id=?", (message_id, member_id)).fetchone()
    if previous:
        return {"request": dict(previous), "duplicate": True}
    confirmation = connection.execute("""INSERT INTO messages (room_id,author,text,reply_to,source,submission_id,created_at)
        VALUES (?,'用户',?,?,'user',?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))""",
        (room_id, f"请 @{target['name']} 回应 #{message_id} 的建议。", message_id, uuid.uuid4().hex))
    connection.execute("INSERT INTO message_details (message_id,kind,submitted_by) VALUES (?,'chat','用户')", (confirmation.lastrowid,))
    insert_request(connection, room_id, member_id, message_id, confirmation.lastrowid, "ask", "user")
    request = connection.execute("SELECT * FROM member_requests WHERE message_id=? AND member_id=?", (message_id, member_id)).fetchone()
    return {"request": dict(request), "duplicate": False}


def halt_chain(connection, room_id, chain_id, reason):
    """Stop automatic progress on a chain; the user's next message starts a new one."""
    connection.execute("INSERT OR IGNORE INTO free_chains (room_id,chain_id,reason) VALUES (?,?,?)", (room_id, chain_id, reason))


def chain_budget(connection, room_id, chain_id):
    """AI-created requests left in a chain, or zero once it is halted."""
    if connection.execute("SELECT 1 FROM free_chains WHERE room_id=? AND chain_id=?", (room_id, chain_id)).fetchone():
        return 0
    used = connection.execute("SELECT COUNT(*) FROM member_requests WHERE room_id=? AND chain_id=? AND created_by='host'",
                              (room_id, chain_id)).fetchone()[0]
    return MAX_AUTO_HOPS - used


def dispatch(connection, room_id, host, message_id, names, chain_id):
    """Queue the host's named members as one batch that hands back to the host when it ends."""
    member_ids = named_members(active_members(connection, room_id), names, exclude=host["name"])
    if not member_ids or not chain_id:
        return
    if chain_budget(connection, room_id, chain_id) < len(member_ids):
        halt_chain(connection, room_id, chain_id, "budget")
        return
    for member_id in member_ids:
        insert_request(connection, room_id, member_id, message_id, chain_id, "ask", "host", batch_id=message_id)
    connection.execute("INSERT INTO free_batches (room_id,batch_id,chain_id,host_id) VALUES (?,?,?,?)",
                       (room_id, message_id, chain_id, host["id"]))


def settle_batches(connection, room_id):
    """Hand each finished batch back to its host once; an all-failed batch halts its chain instead."""
    for batch in connection.execute("SELECT * FROM free_batches WHERE room_id=? AND settled=0", (room_id,)).fetchall():
        statuses = [row[0] for row in connection.execute("SELECT status FROM member_requests WHERE room_id=? AND batch_id=?",
                                                          (room_id, batch["batch_id"]))]
        if any(status not in TERMINAL for status in statuses):
            continue
        connection.execute("UPDATE free_batches SET settled=1 WHERE room_id=? AND batch_id=?", (room_id, batch["batch_id"]))
        host = connection.execute("SELECT * FROM room_members WHERE id=? AND status='active' AND role='host'", (batch["host_id"],)).fetchone()
        if "completed" not in statuses:
            halt_chain(connection, room_id, batch["chain_id"], "all_failed")
        elif not host:
            continue
        elif chain_budget(connection, room_id, batch["chain_id"]) < 1:
            halt_chain(connection, room_id, batch["chain_id"], "budget")
        else:
            insert_request(connection, room_id, host["id"], batch["batch_id"], batch["chain_id"], "handoff", "host")


def answered_chain(connection, payload, actor):
    """The chain an answer continues: the newest chain among the requests it completes."""
    if actor["access"] == "manual":
        ids = payload.get("request_ids") or [0]
        marks = ",".join("?" * len(ids))
        row = connection.execute(f"SELECT MAX(chain_id) FROM member_requests WHERE id IN ({marks})", ids).fetchone()
    else:
        row = connection.execute("SELECT MAX(chain_id) FROM member_requests WHERE execution_id=?", (payload["execution_id"],)).fetchone()
    return row[0] or 0


def after_free_message(connection, room_id, message_id, actor, payload):
    """Create requests for the owner's message, or close what the member's answer covers."""
    now = int(time.time())
    if actor == "用户":
        for member_id, purpose in recipients(connection, room_id, payload):
            insert_request(connection, room_id, member_id, message_id, message_id, purpose, "user")
        return
    if actor["access"] == "online":
        for request_id in payload.get("request_ids", []):
            connection.execute("UPDATE member_requests SET status='completed',answer_id=? WHERE id=?", (message_id, request_id))
        settle_batches(connection, room_id)
        return
    chain_id = answered_chain(connection, payload, actor)
    if actor["access"] == "manual":
        for request_id in payload.get("request_ids", []):
            connection.execute("UPDATE member_requests SET status='completed',answer_id=? WHERE id=?", (message_id, request_id))
    else:
        execution_id = payload["execution_id"]
        connection.execute("UPDATE member_executions SET status='completed',finished_at=?,result=? WHERE id=?",
                           (now, f"message:{message_id}", execution_id))
        connection.execute("UPDATE member_requests SET status='completed',answer_id=? WHERE execution_id=? AND status='delivering'",
                           (message_id, execution_id))
    connection.execute("UPDATE room_members SET read_until=MAX(read_until,?) WHERE id=?", (message_id, actor["id"]))
    if actor["role"] == "host" and payload.get("to"):
        dispatch(connection, room_id, actor, message_id, payload["to"], chain_id)
    settle_batches(connection, room_id)


def expire_executions(connection, room_id):
    """Fail executions whose lease lapsed; their requests stay visible as failed, never silently retried."""
    now = int(time.time())
    limit_seconds = execution_minutes(connection, room_id) * 60
    stale = connection.execute(
        "SELECT id,created_at,lease_until FROM member_executions WHERE room_id=? AND status IN ('dispatched','started') AND lease_until<=?", (room_id, now)).fetchall()
    for row in stale:
        reason = "已达到单次执行时限" if row["lease_until"] >= row["created_at"] + limit_seconds else "执行租约到期，接入程序未续租"
        finish_execution(connection, row["id"], "failed", reason, "failed")
    if stale:
        settle_batches(connection, room_id)


def finish_execution(connection, execution_id, status, result, request_status):
    """End one execution and move its delivered requests in the same transaction."""
    connection.execute("UPDATE member_executions SET status=?,finished_at=?,result=? WHERE id=? AND status IN ('dispatched','started')",
                       (status, int(time.time()), result[:500], execution_id))
    connection.execute("UPDATE member_requests SET status=?,execution_id=CASE WHEN ?='pending' THEN NULL ELSE execution_id END WHERE execution_id=? AND status='delivering'",
                       (request_status, request_status, execution_id))


def stop_member_work(connection, member_id, reason):
    """Void a member's live execution and every open request, so nothing restarts by itself."""
    for row in connection.execute("SELECT id FROM member_executions WHERE member_id=? AND status IN ('dispatched','started')",
                                  (member_id,)).fetchall():
        finish_execution(connection, row["id"], "cancelled", reason, "cancelled")
    connection.execute("UPDATE member_requests SET status='cancelled' WHERE member_id=? AND status='pending'", (member_id,))


def inbox(connection, room_id, token):
    """List what the runner should deliver or reconcile; owner credential only."""
    require_owner(connection, room_id, token)
    begin_write(connection)
    expire_executions(connection, room_id)
    archived = connection.execute("SELECT archived FROM room_directory WHERE room_id=?", (room_id,)).fetchone()[0]
    members = []
    for row in connection.execute("SELECT * FROM room_members WHERE room_id=? AND status='active' AND access='runner' ORDER BY id", (room_id,)):
        pending = [dict(item) for item in connection.execute(
            "SELECT id,message_id FROM member_requests WHERE member_id=? AND status='pending' ORDER BY id", (row["id"],))]
        members.append({**{key: row[key] for key in MEMBER_FIELDS}, "pending": pending})
    executions = [{**public_execution(row), "member": row["name"]} for row in connection.execute(
        """SELECT member_executions.*,room_members.name FROM member_executions JOIN room_members ON room_members.id=member_id
        WHERE member_executions.room_id=? AND member_executions.status IN ('dispatched','started') ORDER BY member_executions.id""", (room_id,))]
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
        raise FileExistsError("房间已存档，不再投递")
    member = connection.execute("SELECT * FROM room_members WHERE room_id=? AND id=? AND status='active' AND access='runner'",
                                (room_id, payload.get("member_id"))).fetchone()
    if not member:
        raise LookupError("成员不存在、已离开或为手动接入")
    if connection.execute("SELECT 1 FROM member_executions WHERE member_id=? AND status IN ('dispatched','started')",
                          (member["id"],)).fetchone():
        raise FileExistsError("该成员已有进行中的执行；同一会话不并发续接")
    if not connection.execute("SELECT 1 FROM member_requests WHERE member_id=? AND status='pending'", (member["id"],)).fetchone():
        raise FileExistsError("该成员没有待投递的请求")
    now = int(time.time())
    cursor = connection.execute("""INSERT INTO member_executions (room_id,member_id,client_id,lease_until,created_at,cwd)
        VALUES (?,?,?,?,?,?)""", (room_id, member["id"], client_id, now + LEASE_SECONDS, now, str(payload.get("cwd") or "")[:MAX_PATH_LENGTH]))
    connection.execute("UPDATE member_requests SET status='delivering',execution_id=? WHERE member_id=? AND status='pending'",
                       (cursor.lastrowid, member["id"]))
    return execution_detail(connection, connection.execute("SELECT * FROM member_executions WHERE id=?", (cursor.lastrowid,)).fetchone())


def execution_detail(connection, row):
    """Describe one execution with the requests it carries and the member's read cursor."""
    member = connection.execute("SELECT * FROM room_members WHERE id=?", (row["member_id"],)).fetchone()
    requests = [dict(item) for item in connection.execute(
        "SELECT id,message_id,status,purpose FROM member_requests WHERE execution_id=? ORDER BY id", (row["id"],))]
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


def changed_files(payload):
    """Validate the runner's observed file list; paths are relative to the execution's cwd."""
    files = payload.get("changes")
    if (not isinstance(files, list) or len(files) > MAX_CHANGED_FILES
            or any(not isinstance(item, str) or not item or len(item) > MAX_PATH_LENGTH for item in files)):
        raise ValueError(f"changes 须为最多 {MAX_CHANGED_FILES} 个相对路径")
    return sorted(set(files))


def execution_action(connection, room_id, execution_id, token, payload):
    """Runner-side lifecycle: renew, fail, release undelivered work, or report observed file changes."""
    require_owner(connection, room_id, token)
    begin_write(connection)
    row = connection.execute("SELECT * FROM member_executions WHERE room_id=? AND id=?", (room_id, execution_id)).fetchone()
    if not row:
        raise LookupError("执行不存在")
    action = payload.get("action")
    now = int(time.time())
    if action == "report":
        # Observed after the process ends, so the execution may already be complete; recorded once.
        if row["changes"]:
            raise FileExistsError("本次执行的改动已记录")
        connection.execute("UPDATE member_executions SET changes=? WHERE id=?", (json.dumps(changed_files(payload), ensure_ascii=False), execution_id))
    elif row["status"] not in ACTIVE:
        raise FileExistsError("执行已结束")
    elif action == "renew":
        limit = row["created_at"] + execution_minutes(connection, room_id) * 60
        if row["lease_until"] <= now or limit <= now:
            raise FileExistsError("执行租约或单次时限已到，不能续租")
        connection.execute("UPDATE member_executions SET lease_until=? WHERE id=?", (min(now + LEASE_SECONDS, limit), execution_id))
    elif action == "fail":
        finish_execution(connection, execution_id, "failed", str(payload.get("reason") or "执行失败"), "failed")
        settle_batches(connection, room_id)
    elif action == "release":
        # Only for proven non-delivery: the requests return to the queue unchanged.
        finish_execution(connection, execution_id, "cancelled", str(payload.get("reason") or "未送达"), "pending")
    else:
        raise ValueError("action 须为 renew、fail、release 或 report")
    return execution_detail(connection, connection.execute("SELECT * FROM member_executions WHERE id=?", (execution_id,)).fetchone())


def owned_member(connection, room_id, member_id, token):
    """Read one member after proving the owner's credential."""
    require_owner(connection, room_id, token)
    begin_write(connection)
    member = connection.execute("SELECT * FROM room_members WHERE room_id=? AND id=?", (room_id, member_id)).fetchone()
    if not member or member["status"] == "removed":
        raise LookupError("成员不存在")
    return member


def interrupt_member(connection, room_id, member_id, token):
    """Owner stop: void the live execution and every open request."""
    owned_member(connection, room_id, member_id, token)
    stop_member_work(connection, member_id, "用户打断")
    settle_batches(connection, room_id)
    return free_view(connection, room_id)


def add_member(connection, room_id, token, payload, now):
    """Owner adds a member while the room keeps running; other members are not interrupted."""
    require_owner(connection, room_id, token)
    begin_write(connection)
    member = member_value(payload)
    existing = connection.execute("SELECT * FROM room_members WHERE room_id=? AND name=? AND status<>'removed'", (room_id, member["name"])).fetchone()
    if existing and existing["status"] == "active" and existing["token_hash"] == token_hash(member["token"]) and all(
            existing[key] == member[key] for key in ("adapter", "access", "session_mode")):
        return free_view(connection, room_id)
    if existing:
        raise FileExistsError(f"{member['name']} 已是本房间成员；离开的成员请用请回")
    require_fresh_member_token(connection, room_id, member["token"])
    insert_member(connection, room_id, member, now)
    sync_participants(connection, room_id)
    return free_view(connection, room_id)


def discussion_roster(connection, room_id):
    """Return a discussion's host, active experts and phase; away experts keep only their member row."""
    row = connection.execute("SELECT host,experts,phase FROM topic_settings WHERE room_id=?", (room_id,)).fetchone()
    return row["host"], json.loads(row["experts"]), row["phase"]


def save_discussion_experts(connection, room_id, experts):
    """Write the active roster; a running discussion keeps going and its host is asked to re-plan."""
    connection.execute("UPDATE topic_settings SET experts=? WHERE room_id=?", (json.dumps(experts, ensure_ascii=False), room_id))


def add_discussion_member(connection, room_id, token, payload, now):
    """Owner invites one expert into a discussion using the room's delivery method."""
    require_owner(connection, room_id, token)
    begin_write(connection)
    member = member_value(payload)
    _, experts, phase = discussion_roster(connection, room_id)
    run = connection.execute("SELECT mode FROM discussion_runtime WHERE room_id=?", (room_id,)).fetchone()
    if member["access"] != ("runner" if run and run["mode"] == "automatic" else "manual"):
        raise ValueError("新专家的接入方式须与讨论的推进方式一致")
    existing = connection.execute("SELECT * FROM room_members WHERE room_id=? AND name=? AND status<>'removed'", (room_id, member["name"])).fetchone()
    if existing and existing["status"] == "active" and existing["token_hash"] == token_hash(member["token"]):
        return
    if existing:
        raise FileExistsError(f"{member['name']} 已是本房间成员；离开的成员请用请回")
    if phase == "concluded":
        raise ValueError("讨论已收束，不能再邀请专家")
    if len(experts) >= MAX_ROOM_AGENTS:
        raise ValueError("房间成员已达上限")
    require_fresh_member_token(connection, room_id, member["token"])
    insert_member(connection, room_id, member, now)
    save_discussion_experts(connection, room_id, {**experts, member["name"]: "cli"})


def discussion_member_action(connection, room_id, member_id, token, payload):
    """Owner sends an expert away (keeping its seat), brings it back with a new credential, or removes it.

    Leaving cancels the expert's open assignments; the host keeps its role and cannot leave, and an
    expert with an open assignment can only leave while the discussion is paused. While paused,
    `redo` voids the expert's latest opinion by deleting it so the expert counts as not yet having spoken.
    """
    member = owned_member(connection, room_id, member_id, token)
    host, experts, phase = discussion_roster(connection, room_id)
    action = payload.get("action")
    if action == "redo":
        void_latest_opinion(connection, room_id, member["name"], phase)
        return
    if action in ("away", "remove"):
        if member["name"] == host:
            raise ValueError("主持人不能离开或移除；请先更换主持人")
        speaking = connection.execute("SELECT 1 FROM discussion_turns WHERE room_id=? AND expert=? AND status IN ('pending','notified')",
                                      (room_id, member["name"])).fetchone()
        if speaking and phase != "paused":
            raise ValueError("该专家正在发言；请先暂停讨论再离开或移除")
        connection.execute("UPDATE discussion_turns SET status='cancelled' WHERE room_id=? AND expert=? AND status IN ('pending','notified')",
                           (room_id, member["name"]))
        connection.execute("UPDATE discussion_turns SET status='skipped' WHERE room_id=? AND expert=? AND status='queued'", (room_id, member["name"]))
        connection.execute("UPDATE room_members SET status=? WHERE id=?", ("away" if action == "away" else "removed", member_id))
        experts.pop(member["name"], None)
    elif action == "active":
        hashed = token_hash(payload.get("token"))
        if member["status"] == "active" and hashed and hmac.compare_digest(hashed, member["token_hash"]):
            return
        if member["status"] != "away" or not hashed or hmac.compare_digest(hashed, member["token_hash"]):
            raise ValueError("只有离开的成员可以请回，且须提供新的成员凭证")
        require_fresh_member_token(connection, room_id, payload.get("token"))
        connection.execute("UPDATE room_members SET status='active',token_hash=? WHERE id=?", (hashed, member_id))
        experts[member["name"]] = "online" if member["access"] == "online" else "cli"
    else:
        raise ValueError("action 须为 away、active、remove 或 redo")
    save_discussion_experts(connection, room_id, experts)


def void_latest_opinion(connection, room_id, name, phase):
    """Delete an expert's latest opinion while paused; its assignment is cancelled and the round no longer counts it."""
    if phase != "paused":
        raise ValueError("请先暂停讨论，再作废专家的发言")
    row = connection.execute("""SELECT messages.id,details.turn_id FROM messages JOIN message_details AS details ON details.message_id=messages.id
        WHERE messages.room_id=? AND messages.author=? AND details.kind='opinion' ORDER BY messages.id DESC LIMIT 1""",
                             (room_id, name)).fetchone()
    if not row:
        raise LookupError(f"{name} 还没有可作废的发言")
    message_id = row["id"]
    connection.execute("UPDATE discussion_turns SET status='cancelled',answer_id=NULL WHERE answer_id=?", (message_id,))
    connection.execute("UPDATE messages SET reply_to=NULL WHERE reply_to=?", (message_id,))
    for table in ("message_timings", "message_summaries", "message_details"):
        connection.execute(f"DELETE FROM {table} WHERE message_id=?", (message_id,))
    connection.execute("DELETE FROM messages WHERE id=?", (message_id,))


def require_fresh_member_token(connection, room_id, token):
    """Prevent owner or another member's credential from being reused for a new identity."""
    hashed = token_hash(token)
    if not hashed or connection.execute("SELECT 1 FROM room_members WHERE room_id=? AND token_hash=? UNION ALL SELECT 1 FROM room_modes WHERE room_id=? AND control_hash=?",
                                        (room_id, hashed, room_id, hashed)).fetchone():
        raise ValueError("须提供独立的新成员凭证")


def member_action(connection, room_id, member_id, token, payload):
    """Owner sends a member away, brings it back with a new credential, or removes it.

    Leaving voids live work at once. Coming back requires a fresh credential, so copies of the
    old one never revive; the software session is kept by the local runner, not here. The
    `role` action makes one runner or manual member the AI host, replacing any previous host.
    """
    member = owned_member(connection, room_id, member_id, token)
    action = payload.get("action")
    if action in ("away", "remove"):
        stop_member_work(connection, member_id, "成员已离开" if action == "away" else "成员已移除")
        connection.execute("UPDATE room_members SET status=? WHERE id=?", ("away" if action == "away" else "removed", member_id))
    elif action == "active":
        hashed = token_hash(payload.get("token"))
        if member["status"] == "active" and hashed and hmac.compare_digest(hashed, member["token_hash"]):
            return free_view(connection, room_id)
        if member["status"] != "away" or not hashed or hmac.compare_digest(hashed, member["token_hash"]):
            raise ValueError("只有离开的成员可以请回，且须提供新的成员凭证")
        require_fresh_member_token(connection, room_id, payload.get("token"))
        connection.execute("UPDATE room_members SET status='active',token_hash=? WHERE id=?", (hashed, member_id))
    elif action == "role":
        role = payload.get("role")
        if role not in ("host", "member") or (role == "host" and member["access"] == "online"):
            raise ValueError("role 须为 host 或 member；在线成员不能担任主持人")
        if role == "member" and member["role"] == "host":
            raise ValueError("自由房间须由一位 AI 主持；请指定另一位成员担任主持人")
        if role == "host":
            connection.execute("UPDATE room_members SET role='member' WHERE room_id=? AND role='host'", (room_id,))
        connection.execute("UPDATE room_members SET role=? WHERE id=?", (role, member_id))
    else:
        raise ValueError("action 须为 away、active、remove 或 role")
    settle_batches(connection, room_id)
    sync_participants(connection, room_id)
    return free_view(connection, room_id)

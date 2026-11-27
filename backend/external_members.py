"""External members: AIs that run on another computer and reach this room only through the runner's gateway.

An external member is a `room_members` row with `access='external'` plus one `external_members` row holding where it
runs, what it may read and until when. This module is the room-side authority (DESIGN D4): it decides validity,
expiry and revocation, keeps the read audit, and serves the only routes an external
credential may use (`/api/external/rooms/{room}/...`). Every other route refuses an external credential or a request
the gateway marked as external; see `guard_route`. Contract: .dev/plans/远程协作与多人房间/子Task1_B侧后端/CONTRACT.md.
"""

import hashlib
import json
import posixpath
import re
import time
from datetime import datetime, timezone

from . import free_room
from .identity import AI_PLATFORMS, JOINED_NICKNAMES, MAX_ROOM_AGENTS, PLATFORM_NICKNAMES, is_ai
from .runtime import begin_write, require_owner, token_hash
from .texts import Text, save_text, text_payload

EXTERNAL_HEADER = "X-CoDiscuss-External"
BRIDGE_HEADER = "X-CoDiscuss-Bridge"
EXTERNAL_PREFIX = ["api", "external", "rooms"]
SCOPES = ("discuss", "read")
# How many ended external members the roster still lists.
MAX_ENDED_SHOWN = 10
# Reads are no longer limited (user 2026-11-19); the old quota columns stay in the table, written as 0 and never read.
MAX_EXTERNAL_SECONDS = 365 * 86400
PENDING_SEAT_SECONDS = 7 * 86400
MAX_DIRECTORIES = 20
MAX_DIRECTORY_LENGTH = 500
MAX_MACHINE = 200
MAX_MACHINE_LABEL = 80
MAX_ADAPTER = 40
MAX_MODEL = 120
READ_OPS = ("ls", "read", "grep")
READ_OUTCOMES = ("ok", "denied")
MAX_READ_PATH = 1000
MAX_READ_BYTES = 64 * 1024 * 1024
MAX_READ_REASON = 300
READ_PAGE = 100
MAX_READ_PAGE = 500
END_REASONS = ("revoked", "expired", "left")
DECLINE_OUTCOMES = ("declined", "timeout")
MAX_DECLINES = 100
EXECUTION_ACTIONS = ("renew", "segments", "delivery", "fail", "release", "quiet")
MESSAGE_PARAMS = ("after", "limit", "page", "q", "author", "mention", "execution_id", "request_id", "max_output_chars")
ANSWER_FIELDS = ("text", "text_text", "execution_id", "submission_id", "reply_to")
ENDED_TEXTS = {"revoked": Text("外部成员已被撤销"), "expired": Text("外部成员已到期"), "left": Text("外部成员已退出")}
EXTERNAL_SQL = """SELECT m.id,m.room_id,m.name,m.adapter,m.role,m.status,m.access,m.session_mode,m.read_until,m.token_hash,
    x.machine,x.machine_label,x.platform,x.model,x.scope,x.directories,x.expires_at,x.hourly_bytes,x.total_bytes,x.hourly_reads,
    x.created_at,x.updated_at,x.ended_at,x.end_reason,x.claimed_at,x.invite_version,x.invite_duration,x.token_hash AS binding_hash
    FROM external_members x JOIN room_members m ON m.id=x.member_id"""


def classified(error_class, message, code, **details):
    """Build an error whose response body carries a machine-readable `code` beside the message."""
    error = error_class(message)
    error.details = {"code": code, **details}
    return error


def is_external_path(parts):
    """Whether a split URL path is one of the member-scope routes for external members."""
    return parts[:3] == EXTERNAL_PREFIX and len(parts) >= 5


def guard_route(connect, headers, parts):
    """Refuse every route outside `/api/external/` for a request marked external or carrying an external credential.

    Runs before the device bridge and all routing, because the local site treats a credential-less loopback request as
    the administrator: the gateway's marker header, not the credential alone, is what keeps such a request out.
    """
    marked = headers.get(EXTERNAL_HEADER) is not None
    if marked and headers.get(BRIDGE_HEADER) is not None:
        raise classified(PermissionError, Text("外部成员请求不能经设备中转"), "external_route_forbidden")
    if parts[:3] == EXTERNAL_PREFIX:
        return
    hashed = token_hash(headers.get("X-Discussion-Token", ""))
    if not marked and hashed:
        connection = connect()
        try:
            marked = connection.execute("SELECT 1 FROM external_members WHERE token_hash=?", (hashed,)).fetchone() is not None
        finally:
            connection.close()
    if marked:
        raise classified(PermissionError, Text("外部成员只能使用成员范围接口"), "external_route_forbidden")


def directory_names(directories):
    """Directory roots by number with only their last segment, for views that must not show local paths."""
    return [{"root": index, "name": posixpath.basename(path.replace("\\", "/").rstrip("/")) or path}
            for index, path in enumerate(directories)]


def owner_view(connection, row):
    """Describe one external member for the owner, with full directory paths."""
    labels = free_room.member_display_names(connection, row["room_id"])
    return {"member_id": row["id"], "name": row["name"], "label": labels.get(row["name"], row["name"]), "adapter": row["adapter"],
            "status": row["status"], "machine": row["machine"], "machine_label": row["machine_label"], "platform": row["platform"],
            "model": row["model"], "scope": row["scope"], "directories": json.loads(row["directories"]), "expires_at": row["expires_at"],
            "created_at": row["created_at"], "updated_at": row["updated_at"],
            "ended_at": row["ended_at"], "end_reason": row["end_reason"],
            "claimed_at": row["claimed_at"], "invite_version": row["invite_version"], "duration": row["invite_duration"]}


def room_view_field(connection, member_id):
    """The `external` field of a member in the room view, or None for a local member; no local paths."""
    row = connection.execute("""SELECT scope,expires_at,machine_label,platform,model,directories,claimed_at,invite_version,ended_at,end_reason
        FROM external_members WHERE member_id=?""", (member_id,)).fetchone()
    if not row:
        return None
    return {"scope": row["scope"], "expires_at": row["expires_at"], "machine_label": row["machine_label"],
            "platform": row["platform"], "model": row["model"],
            "directories": directory_names(json.loads(row["directories"])), "claimed_at": row["claimed_at"],
            "invite_version": row["invite_version"], "ended_at": row["ended_at"], "end_reason": row["end_reason"]}


def ended_view(connection, room_id):
    """External members that checked in and have since ended (expired, left or revoked), newest first, so the roster
    can still show who was here and why they went; they take no requests."""
    rows = connection.execute("""SELECT m.id,m.name,m.adapter,m.role,m.status,m.access,m.session_mode,m.read_until
        FROM room_members m JOIN external_members x ON x.member_id=m.id
        WHERE m.room_id=? AND m.status='removed' AND x.claimed_at>0 AND x.ended_at>0 ORDER BY x.ended_at DESC LIMIT ?""",
                              (room_id, MAX_ENDED_SHOWN)).fetchall()
    return [{**dict(row), "external": room_view_field(connection, row["id"])} for row in rows]


def external_row(connection, room_id, member_id):
    """One external member of a room, or LookupError."""
    row = connection.execute(f"{EXTERNAL_SQL} WHERE x.room_id=? AND x.member_id=?", (room_id, member_id)).fetchone()
    if not row:
        raise LookupError(Text("外部成员不存在"))
    return row


def end_member(connection, row, reason):
    """End an external member: void its live work, cancel its open requests, and refuse its credential from now on."""
    now = int(time.time())
    free_room.discussion.session_member_change(connection, row["room_id"], row, "remove")
    free_room.stop_member_work(connection, row["id"], ENDED_TEXTS[reason], "member_removed")
    connection.execute("UPDATE room_members SET status='removed',role='member' WHERE id=?", (row["id"],))
    connection.execute("UPDATE external_members SET ended_at=?,end_reason=?,updated_at=? WHERE member_id=? AND ended_at=0",
                       (now, reason, now, row["id"]))
    free_room.settle_batches(connection, row["room_id"])
    free_room.sync_participants(connection, row["room_id"])


def expire_room(connection, room_id):
    """End every external member of the room whose time is up; returns whether any ended."""
    rows = connection.execute(f"{EXTERNAL_SQL} WHERE x.room_id=? AND m.status='active' AND x.ended_at=0 AND (CASE WHEN x.claimed_at=0 THEN x.created_at+{PENDING_SEAT_SECONDS} ELSE x.expires_at END)<=?",
                              (room_id, int(time.time()))).fetchall()
    for row in rows:
        end_member(connection, row, "expired")
    return bool(rows)


def roster_revision(connection, room_id):
    """Version of the room's roster and external settings that a new external member is checked against (red line 1)."""
    members = connection.execute("SELECT id,name,status,access FROM room_members WHERE room_id=? ORDER BY id", (room_id,)).fetchall()
    externals = connection.execute("""SELECT member_id,scope,directories,expires_at,hourly_bytes,total_bytes,hourly_reads,ended_at,claimed_at
        FROM external_members WHERE room_id=? ORDER BY member_id""", (room_id,)).fetchall()
    state = json.dumps([[list(row) for row in members], [list(row) for row in externals]], ensure_ascii=False)
    return hashlib.sha256(state.encode()).hexdigest()


def checked_scope(scope, directories):
    """Validate the opening level and directories together; reading needs at least one directory, discussion none."""
    if scope not in SCOPES:
        raise ValueError(Text("scope 须为 discuss 或 read"))
    if not isinstance(directories, list) or len(directories) > MAX_DIRECTORIES or any(
            not isinstance(item, str) or not item.strip() or len(item) > MAX_DIRECTORY_LENGTH for item in directories):
        raise ValueError(Text("directories 须为最多 {count} 个目录，每个不超过 {length} 字", count=MAX_DIRECTORIES, length=MAX_DIRECTORY_LENGTH))
    if len(set(directories)) != len(directories):
        raise ValueError(Text("开放目录不能重复"))
    if scope == "read" and not directories:
        raise ValueError(Text("只读项目须至少开放一个目录"))
    if scope == "discuss" and directories:
        raise ValueError(Text("只讨论时不开放目录"))
    return directories


def checked_expiry(value, now):
    """Validate an expiry in epoch seconds: later than now and within the longest allowed span."""
    if type(value) is not int or not now < value <= now + MAX_EXTERNAL_SECONDS:
        raise ValueError(Text("expires_at 须为晚于现在、不超过 {days} 天的秒级时间", days=MAX_EXTERNAL_SECONDS // 86400))
    return value


def checked_text(value, limit, field, required=False):
    """Validate a bounded single-line text field."""
    if value is None and not required:
        return ""
    if not isinstance(value, str) or (required and not value.strip()) or len(value) > limit:
        raise ValueError(Text("{field} 须为不超过 {limit} 字的文本", field=field, limit=limit))
    return value


def save_ai(connection, member_id, payload, now):
    """Keep the AI the other computer reports, for display only; an unknown platform reads as none."""
    adapter = checked_text(payload.get("adapter", ""), MAX_ADAPTER, "adapter")
    model = " ".join(checked_text(payload.get("model", ""), MAX_MODEL, "model").split())
    platform = payload.get("platform") if payload.get("platform") in AI_PLATFORMS else ""
    connection.execute("UPDATE room_members SET adapter=? WHERE id=?", (adapter, member_id))
    connection.execute("UPDATE external_members SET platform=?,model=?,updated_at=? WHERE member_id=?", (platform, model, now, member_id))


def list_external(connection, room_id, token):
    """The owner's read entry before adding an external member: every external member and the roster revision."""
    require_owner(connection, room_id, token)
    begin_write(connection)
    expire_room(connection, room_id)
    rows = connection.execute(f"{EXTERNAL_SQL} WHERE x.room_id=? ORDER BY m.id", (room_id,)).fetchall()
    return {"revision": roster_revision(connection, room_id), "members": [owner_view(connection, row) for row in rows]}


def get_external(connection, room_id, member_id, token):
    """One external member for the owner or the gateway, expired ones ended first."""
    require_owner(connection, room_id, token)
    begin_write(connection)
    expire_room(connection, room_id)
    return owner_view(connection, external_row(connection, room_id, member_id))


def create_external(connection, room_id, token, payload, now):
    """Add an external member on redemption; the owner credential and a fresh roster revision are required.

    Returns:
        (body, status): 201 for a new member, 200 when the same redemption is repeated.
    """
    require_owner(connection, room_id, token)
    begin_write(connection)
    expire_room(connection, room_id)
    pending = payload.get("pending") is True
    name, member_token = payload.get("name"), payload.get("token")
    machine = checked_text(payload.get("machine"), MAX_MACHINE, "machine", required=not pending)
    hashed = token_hash(member_token)
    repeated = connection.execute(f"{EXTERNAL_SQL} WHERE x.room_id=? AND m.name=? AND x.token_hash=? AND x.machine=? AND m.status='active'",
                                  (room_id, name, hashed, machine)).fetchone() if hashed else None
    if repeated:
        return {"member": owner_view(connection, repeated), "revision": roster_revision(connection, room_id)}, 200
    if not isinstance(payload.get("revision"), str) or not payload["revision"]:
        raise ValueError(Text("建立外部成员须先读取外部成员名单，并带上其中的 revision"))
    if payload["revision"] != roster_revision(connection, room_id):
        raise classified(FileExistsError, Text("房间成员已变化，请重新读取外部成员名单后再提交"), "stale_revision")
    if not is_ai(name):
        raise ValueError(Text("成员须为有效 AI 身份"))
    if not hashed and not pending:
        raise ValueError(Text("每位成员须提供 32–256 字符的成员凭证"))
    if pending:
        hashed, machine = "", ""
    adapter = checked_text(payload.get("adapter", ""), MAX_ADAPTER, "adapter")
    label = checked_text(payload.get("machine_label"), MAX_MACHINE_LABEL, "machine_label")
    directories = checked_scope(payload.get("scope"), payload.get("directories", []))
    expires_at = now + PENDING_SEAT_SECONDS if pending else checked_expiry(payload.get("expires_at"), now)
    if connection.execute("SELECT 1 FROM room_members WHERE room_id=? AND name=? AND status<>'removed'", (room_id, name)).fetchone():
        raise FileExistsError(Text("{name} 已是本房间成员", name=name))
    if connection.execute("SELECT COUNT(*) FROM room_members WHERE room_id=? AND status<>'removed'", (room_id,)).fetchone()[0] >= MAX_ROOM_AGENTS:
        raise FileExistsError(Text("房间成员已满"))
    if not pending:
        free_room.require_fresh_member_token(connection, room_id, member_token)
    cursor = connection.execute("""INSERT INTO room_members (room_id,name,adapter,token_hash,access,session_mode,created_at)
        VALUES (?,?,?,?,'external','new',?)""", (room_id, name, adapter, hashed, free_room_now()))
    connection.execute("""INSERT INTO external_members (member_id,room_id,token_hash,machine,machine_label,scope,directories,expires_at,
        hourly_bytes,total_bytes,hourly_reads,created_at,updated_at,claimed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                       (cursor.lastrowid, room_id, hashed, machine, label, payload["scope"], json.dumps(directories, ensure_ascii=False),
                        expires_at, 0, 0, 0, now, now, 0 if pending else now))
    if pending:
        duration = payload.get("duration", "1h")
        if duration not in ("1h", "today", "3d", "7d", "30d"):
            raise ValueError(Text("外部成员不存在"))
        connection.execute("UPDATE external_members SET claimed_at=0,invite_duration=? WHERE member_id=?", (duration, cursor.lastrowid))
        save_label(connection, room_id, name, pending_label(name, cursor.lastrowid), now)
    free_room.queue_invited_expert(connection, room_id, name, now)
    free_room.sync_participants(connection, room_id)
    row = external_row(connection, room_id, cursor.lastrowid)
    return {"member": owner_view(connection, row), "revision": roster_revision(connection, room_id)}, 201


def free_room_now():
    """The member creation time in the same ISO form other members use (server.utc_now)."""
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def update_external(connection, room_id, member_id, token, payload, now):
    """The owner adjusts or revokes one external member; bound to that member, so no roster revision (red line 1 exception)."""
    require_owner(connection, room_id, token)
    begin_write(connection)
    expire_room(connection, room_id)
    row = external_row(connection, room_id, member_id)
    action = payload.get("action")
    if action in ("invite", "bind", "activate"):
        return seat_action(connection, row, payload, now)
    if action == "reopen":
        return reopen_member(connection, row, now)
    if action == "revoke":
        if row["status"] == "active":
            end_member(connection, row, "revoked")
        return owner_view(connection, external_row(connection, room_id, member_id))
    if action != "update":
        raise ValueError(Text("action 须为 update、revoke 或 reopen"))
    if row["status"] != "active":
        raise classified(FileExistsError, Text("外部成员已结束，不能再调整；需要时重新邀请"), "external_ended", reason=row["end_reason"])
    scope = payload.get("scope", row["scope"])
    directories = payload.get("directories", [] if scope == "discuss" and "directories" not in payload else json.loads(row["directories"]))
    directories = checked_scope(scope, directories)
    expires_at = checked_expiry(payload["expires_at"], now) if "expires_at" in payload else row["expires_at"]
    label = checked_text(payload["machine_label"], MAX_MACHINE_LABEL, "machine_label") if "machine_label" in payload else row["machine_label"]
    connection.execute("""UPDATE external_members SET scope=?,directories=?,expires_at=?,machine_label=?,updated_at=? WHERE member_id=?""",
                       (scope, json.dumps(directories, ensure_ascii=False), expires_at, label, now, member_id))
    return owner_view(connection, external_row(connection, room_id, member_id))


def reopen_member(connection, row, now):
    """Turn an ended external member back into a seat awaiting check-in, so a new link brings the same member back: its
    name, label and history in the room stay. The old credential and binding are cleared; a seat already waiting is left."""
    if row["status"] == "active":
        return owner_view(connection, row)
    if not row["ended_at"]:
        raise FileExistsError(Text("外部成员不存在"))
    if connection.execute("SELECT 1 FROM room_members WHERE room_id=? AND name=? AND status<>'removed' AND id<>?",
                          (row["room_id"], row["name"], row["id"])).fetchone():
        raise FileExistsError(Text("{name} 已是本房间成员", name=row["name"]))
    if connection.execute("SELECT COUNT(*) FROM room_members WHERE room_id=? AND status<>'removed'", (row["room_id"],)).fetchone()[0] >= MAX_ROOM_AGENTS:
        raise FileExistsError(Text("房间成员已满"))
    connection.execute("UPDATE room_members SET status='active',role='member',token_hash='' WHERE id=?", (row["id"],))
    connection.execute("""UPDATE external_members SET ended_at=0,end_reason='',claimed_at=0,machine='',token_hash='',
        expires_at=?,created_at=?,updated_at=? WHERE member_id=?""", (now + PENDING_SEAT_SECONDS, now, now, row["id"]))
    free_room.sync_participants(connection, row["room_id"])
    return owner_view(connection, external_row(connection, row["room_id"], row["id"]))


def seat_action(connection, row, payload, now):
    """Version an invitation or bind and activate its fixed seat under the owner transaction."""
    if row["status"] != "active":
        raise FileExistsError(Text("外部成员已结束，不能再调整；需要时重新邀请"))
    action = payload["action"]
    if action == "invite":
        if row["claimed_at"] or row["machine"]:
            raise FileExistsError(Text("房间成员已变化，请重新读取外部成员名单后再提交"))
        connection.execute("UPDATE external_members SET invite_version=invite_version+1 WHERE member_id=?", (row["id"],))
    else:
        if payload.get("invite_version") != row["invite_version"]:
            raise FileExistsError(Text("房间成员已变化，请重新读取外部成员名单后再提交"))
        machine = checked_text(payload.get("machine"), MAX_MACHINE, "machine", required=True)
        hashed = token_hash(payload.get("token"))
        if not hashed:
            raise ValueError(Text("每位成员须提供 32–256 字符的成员凭证"))
        if row["machine"] and (row["machine"] != machine or row["binding_hash"] != hashed):
            raise FileExistsError(Text("房间成员已变化，请重新读取外部成员名单后再提交"))
        if action == "bind" and not row["machine"]:
            expiry = checked_expiry(payload.get("expires_at"), now)
            label = checked_text(payload.get("machine_label"), MAX_MACHINE_LABEL, "machine_label")
            save_ai(connection, row["id"], payload, now)
            connection.execute("UPDATE external_members SET machine=?,machine_label=?,token_hash=?,expires_at=? WHERE member_id=?",
                               (machine, label, hashed, expiry, row["id"]))
            name_joined(connection, row, now)
        elif action == "activate":
            if not row["machine"]:
                raise FileExistsError(Text("外部成员不存在"))
            if not row["claimed_at"]:
                connection.execute("UPDATE external_members SET claimed_at=?,updated_at=? WHERE member_id=?", (now, now, row["id"]))
                connection.execute("UPDATE room_members SET token_hash=? WHERE id=?", (hashed, row["id"]))
                free_room.queue_invited_expert(connection, row["room_id"], row["name"], now)
                free_room.sync_participants(connection, row["room_id"])
    return owner_view(connection, external_row(connection, row["room_id"], row["id"]))


def pending_label(name, member_id):
    """The name a seat goes by until someone joins it: 外部专家, 外部专家2 … (the suffix of Custom-ext, Custom-ext2 …)."""
    suffix = name.removeprefix("Custom-ext") if name.startswith("Custom-ext") else f"-{member_id}"
    return str(Text("外部专家{suffix}", suffix=suffix))


def save_label(connection, room_id, name, label, now):
    """Set one member's display label; its member name (ID) stays as it is."""
    connection.execute("""INSERT INTO member_labels(room_id,name,label,updated_at) VALUES(?,?,?,?)
        ON CONFLICT(room_id,name) DO UPDATE SET label=excluded.label,updated_at=excluded.updated_at""", (room_id, name, label, now))


# A name this module gave after the AI (外部 Claude, 外部 Gemini2 …): the owner or host has not renamed it.
AUTO_LABEL = re.compile(rf"外部 ({'|'.join(map(re.escape, sorted(JOINED_NICKNAMES, key=len, reverse=True)))})\d*")


def name_joined(connection, row, now):
    """Name an external member after its AI (外部 Claude, 外部 Claude2 …), on joining and whenever its AI changes.

    A seat still under its pending name takes the AI's, and so does a name given earlier after another AI: the other
    computer switched AI, or the member was invited back and sent a different one (user 2026-11-19, #5835). A name the
    owner or host gave is kept, and so is the current one when the AI is unknown or a custom API, which has no name of
    its own. Only the label changes; the member name that requests and records use stays.
    """
    platform = connection.execute("SELECT platform FROM external_members WHERE member_id=?", (row["id"],)).fetchone()[0]
    current = free_room.member_labels(connection, row["room_id"]).get(row["name"])
    legacy = "另一台电脑" + row["name"].removeprefix("Custom-ext")
    automatic = AUTO_LABEL.fullmatch(current or "")
    if platform in ("", "Custom") or (current not in (pending_label(row["name"], row["id"]), legacy) and not automatic):
        return
    nickname = PLATFORM_NICKNAMES.get(platform, platform)
    if automatic and automatic.group(1) == nickname:
        return
    taken = set(free_room.member_display_names(connection, row["room_id"]).values()) - {current}
    label = next(candidate for number in range(1, MAX_ROOM_AGENTS + 2)
                 if (candidate := f"外部 {nickname}{number if number > 1 else ''}") not in taken)
    save_label(connection, row["room_id"], row["name"], label, now)


def list_reads(connection, room_id, member_id, token, params):
    """The owner reads one external member's read records in order."""
    require_owner(connection, room_id, token)
    external_row(connection, room_id, member_id)
    after = int(params.get("after", 0) or 0)
    limit = min(MAX_READ_PAGE, max(1, int(params.get("limit", READ_PAGE) or READ_PAGE)))
    rows = connection.execute("""SELECT id,at,op,root,directory,path,bytes,allowed,code,reason FROM external_reads
        WHERE member_id=? AND id>? ORDER BY id LIMIT ?""", (member_id, after, limit + 1)).fetchall()
    reads = [{**dict(row), "allowed": bool(row["allowed"])} for row in rows[:limit]]
    return {"reads": reads, "next_after": reads[-1]["id"] if reads else after, "has_more": len(rows) > limit}


def checked_read(payload):
    """Validate one read report from the gateway."""
    op, root, path, size = payload.get("op"), payload.get("root"), payload.get("path", ""), payload.get("bytes")
    outcome, reason = payload.get("outcome"), payload.get("reason", "")
    if op not in READ_OPS or outcome not in READ_OUTCOMES:
        raise ValueError(Text("op 须为 ls、read 或 grep，outcome 须为 ok 或 denied"))
    if type(root) is not int or root < 0 or not isinstance(path, str) or len(path) > MAX_READ_PATH:
        raise ValueError(Text("root 须为非负整数，path 不超过 {limit} 字", limit=MAX_READ_PATH))
    if type(size) is not int or not 0 <= size <= MAX_READ_BYTES:
        raise ValueError(Text("bytes 须为 0–{limit} 的整数", limit=MAX_READ_BYTES))
    if not isinstance(reason, str) or len(reason) > MAX_READ_REASON or (outcome == "denied" and not reason.strip()):
        raise ValueError(Text("reason 不超过 {limit} 字，outcome 为 denied 时必填", limit=MAX_READ_REASON))
    return op, root, path, size, outcome, reason


def read_decision(row, root, outcome, reason):
    """Decide one read: (allowed, code, reason)."""
    if row["status"] != "active":
        return False, "member_ended", ENDED_TEXTS.get(row["end_reason"], ENDED_TEXTS["revoked"])
    if outcome == "denied":
        return False, "engine_denied", reason
    if row["scope"] != "read":
        return False, "not_readable", Text("该外部成员只讨论，未开放读取项目")
    if root >= len(json.loads(row["directories"])):
        return False, "bad_root", Text("该目录未对外部成员开放")
    return True, "ok", ""


def record_read(connection, room_id, member_id, token, payload):
    """Audit one read, then judge it, and commit before the gateway may return content.

    The audit row and the room event are written first (as not allowed), the decision updates them in the same
    transaction, and the transaction commits here: a failure anywhere raises, so the gateway returns nothing.
    """
    require_owner(connection, room_id, token)
    begin_write(connection)
    op, root, path, size, outcome, reason = checked_read(payload)
    expire_room(connection, room_id)
    row = external_row(connection, room_id, member_id)
    directories = json.loads(row["directories"])
    directory = directories[root] if root < len(directories) else ""
    at = int(time.time() * 1000)
    cursor = connection.execute("""INSERT INTO external_reads (member_id,room_id,at,op,root,directory,path,bytes,allowed,code,reason)
        VALUES (?,?,?,?,?,?,?,?,0,'pending','')""", (member_id, room_id, at, op, root, directory, path, size))
    read_id = cursor.lastrowid
    event = connection.execute("INSERT INTO room_events (room_id,at,kind,data) VALUES (?,?,'external.read',?)",
                               (room_id, at, json.dumps({"member_id": member_id, "read_id": read_id}))).lastrowid
    allowed, code, why = read_decision(row, root, outcome, reason)
    connection.execute("UPDATE external_reads SET allowed=?,code=?,reason=? WHERE id=?", (int(allowed), code, str(why), read_id))
    data = {"member_id": member_id, "member": row["name"], "read_id": read_id, "op": op, "root": root, "directory": directory,
            "path": path, "bytes": size, "allowed": allowed, "code": code, "reason": str(why)}
    connection.execute("UPDATE room_events SET data=? WHERE id=?", (json.dumps(data, ensure_ascii=False), event))
    connection.commit()
    return {"allowed": allowed, "code": code, "reason": why, "reason_text": text_payload(why), "read_id": read_id, "recorded": True}


def require_external(connection, room_id, token):
    """Resolve the external member of this room from its own credential; an ended one is refused with its reason."""
    begin_write(connection)
    hashed = token_hash(token)
    row = connection.execute(f"{EXTERNAL_SQL} WHERE x.room_id=? AND x.token_hash=?", (room_id, hashed)).fetchone() if hashed else None
    if not row or not row["claimed_at"]:
        raise classified(PermissionError, Text("需要本房间外部成员的凭证"), "external_credential_required")
    if row["status"] == "active" and row["expires_at"] <= int(time.time()):
        end_member(connection, row, "expired")
        # Kept although the request is refused: the error rolls the request back otherwise.
        connection.commit()
        begin_write(connection)
        row = external_row(connection, room_id, row["id"])
    if row["status"] != "active":
        raise classified(PermissionError, ENDED_TEXTS.get(row["end_reason"], ENDED_TEXTS["revoked"]), "external_ended",
                         reason=row["end_reason"] or "revoked")
    return dict(row)


def member_room_view(connection, room_id, member):
    """What an external member sees of the room: title and goal, the roster by name, its own grant; no paths or credentials."""
    room = connection.execute("SELECT r.id,r.title,r.goal,d.archived FROM rooms r JOIN room_directory d ON d.room_id=r.id WHERE r.id=?",
                              (room_id,)).fetchone()
    labels = free_room.member_display_names(connection, room_id)
    # An external member carries the vendor its computer reported (`platform`, display only), so the other computer's page
    # can show it as this room does; local members are known by their platform names.
    members = [{"name": row["name"], "label": labels.get(row["name"], row["name"]), "role": row["role"], "status": row["status"],
                "external": row["access"] == "external", **({"platform": row["platform"] or ""} if row["access"] == "external" else {})}
               for row in connection.execute(f"""SELECT room_members.name,room_members.role,room_members.status,room_members.access,ext.platform
                   FROM room_members LEFT JOIN external_members ext ON ext.member_id=room_members.id
                   WHERE room_members.room_id=? AND room_members.status<>'removed' AND {free_room.REGISTERED_MEMBER} ORDER BY room_members.id""",
                                             (room_id,))]
    latest = connection.execute("""SELECT COALESCE(MAX(id),0) FROM messages m WHERE room_id=?
        AND NOT EXISTS (SELECT 1 FROM internal_task_messages t WHERE t.message_id=m.id)""", (room_id,)).fetchone()[0]
    me = {"member_id": member["id"], "name": member["name"], "label": labels.get(member["name"], member["name"]), "scope": member["scope"],
          "expires_at": member["expires_at"], "directories": directory_names(json.loads(member["directories"]))}
    return {"room": {"id": room["id"], "title": room["title"], "goal": room["goal"], "archived": bool(room["archived"])},
            "me": me, "members": members, "latest_message_id": latest}


def member_inbox(connection, room_id, member):
    """The external member's own open requests, with the same context fields the runner's inbox gives, and its live execution."""
    pending = free_room.pending_requests(connection, member["id"])
    executions = [free_room.public_execution(row) for row in connection.execute(
        "SELECT * FROM member_executions WHERE member_id=? AND status IN ('dispatched','started') ORDER BY id", (member["id"],))]
    return {"member": {"member_id": member["id"], "name": member["name"], "status": member["status"], "expires_at": member["expires_at"]},
            "pending": pending, "executions": executions}


def decline_requests(connection, room_id, member, payload):
    """A declines or lets time out its own pending requests; B then shows them as not agreed to."""
    request_ids, outcome = payload.get("request_ids"), payload.get("outcome")
    if outcome not in DECLINE_OUTCOMES:
        raise ValueError(Text("outcome 须为 declined 或 timeout"))
    if (not isinstance(request_ids, list) or not 0 < len(request_ids) <= MAX_DECLINES
            or any(type(item) is not int for item in request_ids) or len(set(request_ids)) != len(request_ids)):
        raise ValueError(Text("request_ids 须为 1–{limit} 个不重复的请求编号", limit=MAX_DECLINES))
    for request_id in request_ids:
        row = connection.execute("SELECT member_id,status FROM member_requests WHERE room_id=? AND id=?", (room_id, request_id)).fetchone()
        if not row or row["member_id"] != member["id"] or row["status"] != "pending":
            raise FileExistsError(Text("请求 {request_id} 不属于本成员或已处理", request_id=request_id))
    now = int(time.time())
    marks = ",".join("?" * len(request_ids))
    for request_id in request_ids:
        connection.execute("INSERT OR REPLACE INTO external_declines (request_id,member_id,outcome,at) VALUES (?,?,?,?)",
                           (request_id, member["id"], outcome, now))
    free_room.record_cancel_reasons(connection, f"id IN ({marks})", tuple(request_ids), "no_reply")
    connection.execute(f"UPDATE member_requests SET status='cancelled' WHERE id IN ({marks})", tuple(request_ids))
    free_room.discussion.after_member_stopped(connection, member["id"])
    free_room.settle_batches(connection, room_id)
    return {"declined": request_ids, "outcome": outcome}


def answer_payload(member, payload):
    """Keep only what an external answer may carry; the author is always the member itself and an execution is required."""
    extra = set(payload) - set(ANSWER_FIELDS) - {"author"}
    if extra:
        raise ValueError(Text("外部成员的回答不能带这些字段：{fields}", fields="、".join(sorted(extra))))
    if payload.get("author", member["name"]) != member["name"]:
        raise PermissionError(Text("成员只能以本人身份发言"))
    if type(payload.get("execution_id")) is not int:
        raise ValueError(Text("成员回答须关联本次执行编号 execution_id"))
    return {**{key: payload[key] for key in ANSWER_FIELDS if key in payload}, "author": member["name"], "source": "cli"}


def report_ai(connection, member, payload):
    """The member's computer switched its AI: only what the room displays changes, never what the member may do."""
    checked_text(payload.get("adapter"), MAX_ADAPTER, "adapter", required=True)
    now = int(time.time())
    save_ai(connection, member["id"], payload, now)
    name_joined(connection, member, now)
    return {"reported": True}


def lend_until(connection, room_id, token, payload):
    """The member's computer sets how long it lends its AI; only its own end changes, never what it may read (red line 1 exception).

    A member whose time ran out comes back at once with the new end (user 2026-11-19): how long it is lent was its own
    choice, so letting it lapse is not a decision of the owner's. One the owner revoked, or that left, stays ended.
    """
    begin_write(connection)
    now = int(time.time())
    expires_at = checked_expiry(payload.get("expires_at"), now)
    hashed = token_hash(token)
    row = connection.execute(f"{EXTERNAL_SQL} WHERE x.room_id=? AND x.token_hash=?", (room_id, hashed)).fetchone() if hashed else None
    if not row or not row["claimed_at"]:
        raise classified(PermissionError, Text("需要本房间外部成员的凭证"), "external_credential_required")
    revived = row["status"] != "active"
    if revived:
        if row["end_reason"] != "expired":
            raise classified(PermissionError, ENDED_TEXTS.get(row["end_reason"], ENDED_TEXTS["revoked"]), "external_ended",
                             reason=row["end_reason"] or "revoked")
        if connection.execute("SELECT 1 FROM room_members WHERE room_id=? AND name=? AND status<>'removed' AND id<>?",
                              (room_id, row["name"], row["id"])).fetchone():
            raise FileExistsError(Text("{name} 已是本房间成员", name=row["name"]))
        if connection.execute("SELECT COUNT(*) FROM room_members WHERE room_id=? AND status<>'removed'", (room_id,)).fetchone()[0] >= MAX_ROOM_AGENTS:
            raise FileExistsError(Text("房间成员已满"))
        connection.execute("UPDATE room_members SET status='active' WHERE id=?", (row["id"],))
        connection.execute("UPDATE external_members SET ended_at=0,end_reason='' WHERE member_id=?", (row["id"],))
    connection.execute("UPDATE external_members SET expires_at=?,updated_at=? WHERE member_id=?", (expires_at, now, row["id"]))
    if revived:
        free_room.sync_participants(connection, room_id)
    return {"expires_at": expires_at, "revived": revived}


def leave_room(connection, member):
    """The external member leaves on its own; its credential stops working at once."""
    end_member(connection, member, "left")
    return {"left": True}


def external_api(connection, parts, params, method, token, read_payload, hooks):
    """Serve one member-scope route for an external member.

    Args:
        parts: The split path, starting `api/external/rooms/{room}`.
        read_payload: Callable returning the JSON body of a POST.
        hooks: Server functions this module cannot import: `messages(connection, room_id, params, token)`,
            `message(connection, room_id, message_id, params, token)` and `answer(connection, room_id, payload, member)`.

    Returns:
        (body, status)
    """
    room_id, route = parts[3], parts[4:]
    # Renewing is the one route a member whose time ran out may still use: it brings the member back.
    if method == "POST" and route == ["expiry"]:
        return lend_until(connection, room_id, token, read_payload()), 200
    member = require_external(connection, room_id, token)
    reading = {key: params[key] for key in MESSAGE_PARAMS if key in params}
    if method == "GET" and route == ["view"]:
        return member_room_view(connection, room_id, member), 200
    if method == "GET" and route == ["messages"]:
        # "Requests naming me" follows the room's records: the text says the name the owner gave it, not its member ID.
        if reading.get("mention") == member["name"]:
            reading = {**{key: value for key, value in reading.items() if key != "mention"}, "requested_of": member["id"]}
        return hooks["messages"](connection, room_id, reading, token), 200
    if method == "GET" and len(route) == 2 and route[0] == "messages" and route[1].isdigit():
        return hooks["message"](connection, room_id, int(route[1]), reading, token), 200
    if method == "GET" and route == ["inbox"]:
        return member_inbox(connection, room_id, member), 200
    if method != "POST":
        raise LookupError(Text("地址不存在"))
    payload = read_payload()
    if route == ["claim"]:
        return free_room.claim_execution(connection, room_id, member, payload), 200
    if route == ["decline"]:
        return decline_requests(connection, room_id, member, payload), 200
    if len(route) == 2 and route[0] == "executions" and route[1].isdigit():
        if payload.get("action") not in EXECUTION_ACTIONS:
            raise ValueError(Text("外部成员的执行只能 renew、segments、delivery、fail、release 或 quiet"))
        return free_room.execution_action(connection, room_id, int(route[1]), token, payload, member=member), 200
    if route == ["answer"]:
        return hooks["answer"](connection, room_id, answer_payload(member, payload), member), 201
    if route == ["ai"]:
        return report_ai(connection, member, payload), 200
    if route == ["leave"]:
        return leave_room(connection, member), 200
    raise LookupError(Text("地址不存在"))


def owner_api(connection, room_id, route, params, method, token, read_payload):
    """Serve the owner's `/api/rooms/{room}/external-members...` routes; returns (body, status)."""
    now = int(time.time())
    if route == [] and method == "GET":
        return list_external(connection, room_id, token), 200
    if route == [] and method == "POST":
        return create_external(connection, room_id, token, read_payload(), now)
    if len(route) >= 1 and route[0].isdigit():
        member_id = int(route[0])
        if route[1:] == [] and method == "GET":
            return get_external(connection, room_id, member_id, token), 200
        if route[1:] == [] and method == "POST":
            return update_external(connection, room_id, member_id, token, read_payload(), now), 200
        if route[1:] == ["reads"] and method == "GET":
            return list_reads(connection, room_id, member_id, token, params), 200
        if route[1:] == ["reads"] and method == "POST":
            return record_read(connection, room_id, member_id, token, read_payload()), 200
    raise LookupError(Text("地址不存在"))

# Browser guest visits share the external entry point, with a separate credential and route allowlist.
GUEST_GET = frozenset((("session",), ("messages",), ("executions",), ("room",), ("private",),
                       ("files",), ("files", "content")))
GUEST_INVITE_MS = 15 * 60 * 1000
GUEST_MAX_SECONDS = 24 * 60 * 60
GUEST_DEFAULT_SECONDS = 15 * 60
GUEST_MAX_MESSAGE = 32_000
GUEST_MODES = ("conservative", "trust")
GUEST_SERVICE_ACTIONS = frozenset(("redeem", "activate", "expire", "file-read"))
GUEST_DISCONNECT_REASONS = {"owner": "disconnected", "host": "disconnected_by_host"}


def guest_disconnected_by(reason):
    """Recognize both current and previously stored disconnect reasons."""
    return next((actor for actor, value in GUEST_DISCONNECT_REASONS.items() if value == reason), None)


def guest_now():
    """Return the server clock in the guest protocol's milliseconds."""
    return time.time_ns() // 1_000_000


def guest_error(kind=PermissionError, code="guest_forbidden", **details):
    """Provide a stable error code independently of the display language."""
    return classified(kind, Text("访客操作不可用"), code, **details)


def guest_path(parts):
    """Recognize only the external guest namespace."""
    return parts[:3] == EXTERNAL_PREFIX and parts[4:5] == ["guest"]


def guest_route_allowed(method, route):
    """Return whether this exact verb and route are exposed to guests."""
    if method == "GET":
        return tuple(route) in GUEST_GET
    return method == "POST" and (route == ["messages"] or (
        len(route) == 3 and route[0] == "messages" and route[2] == "withdraw"
        and re.fullmatch(r"[0-9]{1,18}", route[1]) is not None))


def guest_guard(connection, headers, parts, method):
    """Apply guest and in-room member boundaries before routing or implicit local ownership."""
    hashed = token_hash(headers.get("X-Discussion-Token", ""))
    visit = connection.execute("SELECT * FROM room_guest_visits WHERE token_hash=?", (hashed,)).fetchone() if hashed else None
    if visit or guest_path(parts):
        if (not visit or not guest_path(parts) or parts[3] != visit["room_id"]
                or headers.get(BRIDGE_HEADER) is not None or not guest_route_allowed(method, parts[5:])):
            raise guest_error()
        return
    if not hashed:
        return
    sources = connection.execute("""SELECT v.room_id FROM room_guest_visits v JOIN room_members m ON m.room_id=v.room_id
        WHERE m.token_hash=? AND v.ended_at IS NULL AND v.expires_at>?""", (hashed, guest_now())).fetchall()
    if not sources:
        return
    target = parts[2] if parts[:2] == ["api", "rooms"] and len(parts) >= 3 else None
    if parts[:3] == EXTERNAL_PREFIX and len(parts) > 4:
        target = parts[3]
    if parts[:1] == ["r"] and len(parts) > 1:
        target = parts[1]
    if any(row["room_id"] != target for row in sources):
        raise guest_error()


def guest_token_hash(token):
    """Hash a browser bearer literally, without the internal owner-proxy convention."""
    return hashlib.sha256(token.encode()).hexdigest() if isinstance(token, str) and 32 <= len(token) <= 128 else ""


def guest_current(connection, room_id):
    """Return the authoritative visit, including the last ended record when idle."""
    return connection.execute("""SELECT * FROM room_guest_visits WHERE room_id=?
        ORDER BY ended_at IS NULL DESC, created_at DESC, rowid DESC LIMIT 1""", (room_id,)).fetchone()


def guest_phase(row, now):
    """Compute effective phase even if cleanup has not run yet."""
    if row is None:
        return "none"
    end = row["expires_at"] if row["joined_at"] is not None else row["invite_expires_at"]
    if row["ended_at"] is not None or end <= now:
        return "ended"
    if row["joined_at"] is not None:
        return "active"
    return "waiting" if row["guest_id"] else "invited"


def guest_mode_active(connection, room_id):
    """Return whether a guest currently has access to the room."""
    return guest_phase(guest_current(connection, room_id), guest_now()) == "active"


def guest_dispatch_held(connection, room_id):
    """Return whether admission currently blocks local execution claims."""
    return guest_phase(guest_current(connection, room_id), guest_now()) == "waiting"


def guest_view(row, now):
    """Project the room's current invitation and effective protection mode."""
    phase = guest_phase(row, now)
    guest = None
    if row and row["guest_id"]:
        guest = {key: row[key] for key in ("key_id", "label", "scope", "requested_mode", "duration_seconds",
                                           "joined_at", "expires_at", "ended_at", "reason")}
        guest.update(id=row["guest_id"], private_chat=bool(row["private_chat"]))
        guest["disconnected_by"] = guest_disconnected_by(row["reason"])
    return {"revision": f'{row["invite_id"]}:{row["revision"]}' if row else "0",
            "server_time": now, "phase": phase, "mode": row["requested_mode"] if phase == "active" else "none",
            "invite_id": row["invite_id"] if row else None, "invite_expires_at": row["invite_expires_at"] if row else None,
            "hold_dispatch": phase == "waiting", "stop_for_admission": phase == "waiting" and bool(row["stop_for_admission"]),
            "guest": guest}


def guest_cancel_pending(connection, room_id, guest_id, reason):
    """Cancel undelivered requests rooted in this guest's messages."""
    where = """room_id=? AND status='pending' AND (chain_id IN (SELECT message_id FROM guest_message_sources WHERE guest_id=?)
        OR message_id IN (SELECT message_id FROM guest_message_sources WHERE guest_id=?))"""
    values = (room_id, guest_id, guest_id)
    free_room.record_cancel_reasons(connection, where, values, reason)
    connection.execute(f"UPDATE member_requests SET status='cancelled' WHERE {where}", values)


def guest_end(connection, row, now, reason):
    """Invalidate the visit and cancel its pending work within the same transaction."""
    connection.execute("""UPDATE room_guest_visits SET ended_at=?,reason=?,revision=revision+1
        WHERE invite_id=? AND ended_at IS NULL""", (now, reason, row["invite_id"]))
    if row["guest_id"]:
        guest_cancel_pending(connection, row["room_id"], row["guest_id"],
                             "guest_disconnected" if guest_disconnected_by(reason) else "no_reply")


def guest_refresh(connection, room_id, now):
    """Persist lazy expiry and return the latest visit."""
    row = guest_current(connection, room_id)
    if row and row["ended_at"] is None and guest_phase(row, now) == "ended":
        guest_end(connection, row, now, "expired" if row["joined_at"] is not None else "invite_expired")
        return guest_current(connection, room_id)
    return row


def guest_revision(row, now, payload):
    """Check that an owner mutation observed the current invitation first."""
    if not isinstance(payload.get("revision"), str) or not payload["revision"]:
        raise guest_error(ValueError, "invalid_input")
    state = guest_view(row, now)
    if payload["revision"] != state["revision"]:
        raise guest_error(FileExistsError, "stale_revision", state=state)


def guest_identifier(value):
    """Validate a bounded opaque protocol identifier."""
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{8,128}", value):
        raise guest_error(ValueError, "invalid_input")
    return value


def guest_duration(value):
    """Validate the total visit duration in seconds."""
    if type(value) is not int or not 1 <= value <= GUEST_MAX_SECONDS:
        raise guest_error(ValueError, "invalid_input")
    return value


def guest_invite(connection, room_id, row, now, payload):
    """Replace only an unclaimed invite, using the revision the owner read."""
    invite = guest_identifier(payload.get("invite_id"))
    mode, scope = payload.get("mode", "conservative"), payload.get("scope", "chat")
    private = payload.get("private_chat", False)
    label = checked_text(payload.get("label", ""), 80, "label").strip()
    duration = guest_duration(payload.get("duration_seconds", GUEST_DEFAULT_SECONDS))
    if mode not in GUEST_MODES or scope not in ("chat", "project") or type(private) is not bool:
        raise guest_error(ValueError, "invalid_input")
    if row and row["invite_id"] == invite and guest_phase(row, now) == "invited":
        if (label, scope, private, mode, duration) != tuple(row[field] for field in
                ("label", "scope", "private_chat", "requested_mode", "duration_seconds")):
            raise guest_error(FileExistsError, "submission_conflict")
        return
    guest_revision(row, now, payload)
    if guest_phase(row, now) in ("waiting", "active"):
        raise guest_error(FileExistsError, "guest_occupied")
    if guest_phase(row, now) == "invited":
        guest_end(connection, row, now, "invite_replaced")
    if connection.execute("SELECT 1 FROM room_guest_visits WHERE invite_id=?", (invite,)).fetchone():
        raise guest_error(FileExistsError, "submission_conflict")
    connection.execute("""INSERT INTO room_guest_visits
        (invite_id,room_id,label,scope,private_chat,requested_mode,duration_seconds,created_at,invite_expires_at)
        VALUES (?,?,?,?,?,?,?,?,?)""", (invite, room_id, label, scope, private, mode, duration, now, now + GUEST_INVITE_MS))


def guest_redeem(connection, row, now, payload):
    """Bind the invite to one browser, allowing retries of the same claim."""
    if not row or row["invite_id"] != payload.get("invite_id") or guest_phase(row, now) == "ended":
        raise guest_error()
    guest_id = guest_identifier(payload.get("guest_id"))
    key_id = guest_identifier(payload.get("key_id"))
    hashed = payload.get("token_hash")
    if not isinstance(hashed, str) or not re.fullmatch(r"[a-f0-9]{64}", hashed):
        raise guest_error(ValueError, "invalid_input")
    if row["guest_id"]:
        if (row["guest_id"], row["key_id"], row["token_hash"]) != (guest_id, key_id, hashed):
            raise guest_error(FileExistsError, "guest_occupied")
        return
    if connection.execute("SELECT 1 FROM room_guest_visits WHERE token_hash=? OR guest_id=?", (hashed, guest_id)).fetchone():
        raise guest_error(FileExistsError, "guest_occupied")
    label = checked_text(payload.get("label", row["label"]), 80, "label").strip() or row["label"] or "Guest"
    connection.execute("""UPDATE room_guest_visits SET guest_id=?,key_id=?,token_hash=?,label=?,revision=revision+1
        WHERE invite_id=?""", (guest_id, key_id, hashed, label, row["invite_id"]))


def guest_live_executions(connection, room_id, *, local_only=False):
    """List in-flight room executions, including reservations before the process starts."""
    return [row[0] for row in connection.execute("""SELECT e.id FROM member_executions e JOIN room_members m ON m.id=e.member_id
        WHERE e.room_id=? AND e.status IN ('dispatched','started') AND (?=0 OR m.access<>'external') ORDER BY e.id""",
        (room_id, int(local_only)))]


def guest_stop_executions(connection, room_id, *, admission=False, keep_execution=None):
    """Stop live execution cards without dropping independent pending work."""
    stopped = [item for item in guest_live_executions(connection, room_id, local_only=admission)
               if item != keep_execution]
    for execution_id in stopped:
        free_room.finish_execution(connection, execution_id, "cancelled", Text("用户停止全部"),
                                   "pending" if admission else "cancelled", "user_stop" if admission else "guest_disconnected")
    connection.execute("""UPDATE private_chats SET status='stopped',updated_at=? WHERE room_id=? AND status='running'""",
                       (int(time.time()), room_id))
    if not admission:
        free_room.settle_batches(connection, room_id)
    return stopped


def guest_change(connection, room_id, row, now, action, payload):
    """Apply one mutation after route-level authentication."""
    phase = guest_phase(row, now)
    if action == "invite":
        return guest_invite(connection, room_id, row, now, payload)
    if action == "redeem":
        return guest_redeem(connection, row, now, payload)
    if action in ("protection", "extend"):
        guest_revision(row, now, payload)
        if phase != "active":
            raise guest_error()
        return guest_change_active(connection, row, action, payload)
    if not row or not row["guest_id"] or row["guest_id"] != payload.get("guest_id"):
        raise guest_error()
    if action == "expire":
        if phase != "ended":
            raise guest_error(FileExistsError, "guest_waiting")
        return None
    if phase == "active" and (action == "activate" or action == "admit" and row["stop_for_admission"]):
        return None
    if phase != "waiting":
        raise guest_error()
    if action == "admit":
        if not row["stop_for_admission"]:
            guest_stop_executions(connection, room_id, admission=True)
            connection.execute("UPDATE room_guest_visits SET stop_for_admission=1,revision=revision+1 WHERE invite_id=?",
                               (row["invite_id"],))
    elif guest_live_executions(connection, room_id, local_only=True) or connection.execute(
            "SELECT 1 FROM private_chats WHERE room_id=? AND status='running'", (room_id,)).fetchone():
        raise guest_error(FileExistsError, "guest_waiting")
    else:
        connection.execute("""UPDATE room_guest_visits SET joined_at=?,expires_at=?,revision=revision+1 WHERE invite_id=?""",
                           (now, now + row["duration_seconds"] * 1000, row["invite_id"]))
    return None


def guest_change_active(connection, row, action, payload):
    """Write a protection change or extend the running visit from its original start."""
    if action == "protection":
        mode = payload.get("mode")
        if mode not in GUEST_MODES:
            raise guest_error(ValueError, "invalid_input")
        if mode != row["requested_mode"]:
            connection.execute("UPDATE room_guest_visits SET requested_mode=?,revision=revision+1 WHERE invite_id=?",
                               (mode, row["invite_id"]))
    else:
        duration = guest_duration(payload.get("duration_seconds"))
        if duration < row["duration_seconds"]:
            raise guest_error(ValueError, "invalid_input")
        if duration > row["duration_seconds"]:
            connection.execute("""UPDATE room_guest_visits SET duration_seconds=?,expires_at=?,revision=revision+1
                WHERE invite_id=?""", (duration, row["joined_at"] + duration * 1000, row["invite_id"]))


def guest_disconnect_host(connection, room_id, token, acting_token):
    """Identify the current host for direct and owner-proxied host controls."""
    member = free_room.require_owner_or_host(connection, room_id, token)
    if member is None and acting_token:
        member = free_room.require_member(connection, room_id, acting_token)
        if member["role"] != "host":
            raise guest_error()
    return member


def guest_disconnect(connection, row, now, payload, host):
    """Revoke the addressed visit and stop other live executions atomically."""
    if not row or not row["guest_id"] or row["guest_id"] != payload.get("guest_id"):
        raise guest_error()
    room_id, guest_id = row["room_id"], row["guest_id"]
    stopped = []
    if guest_phase(row, now) != "ended":
        actor = "host" if host else "owner"
        keep_execution = None
        if host:
            active = connection.execute("""SELECT id FROM member_executions
                WHERE room_id=? AND member_id=? AND status IN ('dispatched','started') ORDER BY id DESC LIMIT 1""",
                (room_id, host["id"])).fetchone()
            keep_execution = active[0] if active else None
            if "execution_id" in payload and payload["execution_id"] != keep_execution:
                raise guest_error(FileExistsError, "stale_execution")
        guest_end(connection, row, now, GUEST_DISCONNECT_REASONS[actor])
        stopped = guest_stop_executions(connection, room_id, keep_execution=keep_execution)
        guest_cancel_pending(connection, room_id, guest_id, "guest_disconnected")
        guest_event(connection, room_id, "guest.disconnected", {"guest_id": guest_id, "actor": actor})
        guest_disconnect_notice(connection, row, host)
    state = guest_view(guest_current(connection, room_id), now)
    return {"state": state, "ended_guest_id": guest_id, "stopped_execution_ids": stopped,
            "disconnected_by": state["guest"]["disconnected_by"]}


def guest_disconnect_notice(connection, row, host):
    """Append exactly one visible notice in the same transaction as the disconnect."""
    room_id = row["room_id"]
    if host:
        label = free_room.member_display_names(connection, room_id).get(host["name"], host["name"])
        text = Text("主持人 {host} 断开了外部用户 {guest}。", host=label, guest=row["label"])
    else:
        text = Text("房主断开了外部用户 {guest}。", guest=row["label"])
    message_id = connection.execute("""INSERT INTO messages(room_id,author,text,source,submission_id,created_at)
        VALUES (?,?,?,?,?,?)""", (room_id, free_room.NOTICE_AUTHOR, text, "host_action" if host else "system",
        f'guest-disconnect-{row["guest_id"]}', datetime.now(timezone.utc).isoformat(timespec="seconds"))).lastrowid
    save_text(connection, "message", message_id, "text", text)
    connection.execute("INSERT INTO message_details(message_id,kind,submitted_by) VALUES (?,'notice',?)",
                       (message_id, free_room.NOTICE_AUTHOR))


def guest_revoke_invite(connection, row, now, payload):
    """Invalidate a single unredeemed invite by ID, without touching room work."""
    if not row or row["invite_id"] != payload.get("invite_id") or row["guest_id"]:
        raise guest_error()
    if guest_phase(row, now) == "invited":
        guest_end(connection, row, now, "invite_revoked")
        row = guest_current(connection, row["room_id"])
    return {"state": guest_view(row, now), "invite_id": row["invite_id"]}


def guest_owner_api(connection, room_id, route, method, token, *, payload=None, service=False, acting_token=""):
    """Dispatch only the owner, host or local service guest operations."""
    if not route and method == "GET":
        free_room.require_owner_or_host(connection, room_id, token)
        now = guest_now()
        row = guest_current(connection, room_id)
        if row is None or row["ended_at"] is not None or guest_phase(row, now) != "ended":
            return guest_view(row, now)
    elif method != "POST" or len(route) != 1:
        raise guest_error()
    elif route == ["disconnect"]:
        # Recheck the role after the writer lock, before deciding whose execution to preserve.
        begin_write(connection)
        host = guest_disconnect_host(connection, room_id, token, acting_token)
    elif route[0] in GUEST_SERVICE_ACTIONS:
        if not service:
            raise guest_error()
        require_owner(connection, room_id, token)
    elif route[0] in ("invite", "protection", "extend", "admit", "revoke"):
        require_owner(connection, room_id, token)
    else:
        raise guest_error()
    begin_write(connection)
    now = guest_now()
    row = guest_refresh(connection, room_id, now)
    if not route:
        return guest_view(row, now)
    action = route[0]
    if action == "file-read":
        return guest_file_grant(connection, room_id, row, now, payload)
    if action == "disconnect":
        return guest_disconnect(connection, row, now, payload, host)
    if action == "revoke":
        return guest_revoke_invite(connection, row, now, payload)
    guest_change(connection, room_id, row, now, action, payload)
    state = guest_view(guest_current(connection, room_id), now)
    data = {"state": state}
    if action == "invite":
        data.update(invite_id=state["invite_id"], invite_expires_at=state["invite_expires_at"])
    return data


def guest_event(connection, room_id, kind, data):
    """Record guest operations for the room's audit log."""
    connection.execute("INSERT INTO room_events(room_id,at,kind,data) VALUES (?,?,?,?)",
                       (room_id, guest_now(), kind, json.dumps(data, ensure_ascii=False)))


def guest_file_grant(connection, room_id, row, now, payload):
    """Authorize and audit a live visit's file reads. The gateway alone resolves its own roots."""
    if (guest_phase(row, now) != "active" or row["guest_id"] != payload.get("guest_id")
            or row["scope"] != "project"):
        raise guest_error()
    action, outcome = payload.get("action"), payload.get("outcome")
    root, path, size = payload.get("root"), payload.get("path"), payload.get("bytes", 0)
    if (action not in ("roots", "list", "read") or outcome not in ("check", "served", "denied")
            or not isinstance(path, str) or len(path) > 4096 or type(size) is not int or size < 0
            or (root is not None and (type(root) is not int or root < 0))
            or (root is None) != (action == "roots")):
        raise guest_error(ValueError, "invalid_input")
    if outcome == "check":
        return {"expires_at": row["expires_at"]}
    guest_event(connection, room_id, "guest.file", {"guest_id": row["guest_id"], "root": root, "path": path,
                                                   "action": action, "outcome": outcome, "bytes": size})
    return {"recorded": True}


def guest_origin(connection, message_id, chain_id=0):
    """Resolve inherited guest provenance by the message or its dispatch chain."""
    row = connection.execute("""SELECT g.guest_id,g.label,s.message_id FROM guest_message_sources s
        JOIN room_guest_visits g ON g.guest_id=s.guest_id WHERE s.message_id IN (?,?)
        ORDER BY s.message_id=? DESC LIMIT 1""", (message_id, chain_id, message_id)).fetchone()
    return {"kind": "guest", "guest_id": row["guest_id"], "label": row["label"],
            "root_message_id": row["message_id"]} if row else None


def guest_display_names(connection, room_id):
    """Return display labels for the room's persistent historical guest authors."""
    return {f'guest:{row["guest_id"]}': row["label"] for row in connection.execute(
        "SELECT guest_id,label FROM room_guest_visits WHERE room_id=? AND guest_id IS NOT NULL", (room_id,))}


def add_guest_question_origin(connection, room_id, question):
    """Identify the guest source of a question by its persisted request bindings."""
    row = connection.execute("""SELECT s.message_id FROM room_questions q
        JOIN json_each(q.request_ids) wanted JOIN member_requests r ON r.id=wanted.value AND r.room_id=q.room_id
        JOIN guest_message_sources s ON s.message_id IN (r.chain_id,r.message_id)
        WHERE q.room_id=? AND q.id=? ORDER BY r.id,s.message_id LIMIT 1""",
        (room_id, question.get("id", question.get("question_id")))).fetchone()
    if row:
        question["origin"] = guest_origin(connection, row["message_id"])
    return question


def guest_page(connection, sql, room_id, params, *, limit_default=50):
    """Read a bounded ID page with stable output ordering in both directions."""
    if "after" in params and "before" in params:
        raise guest_error(ValueError, "invalid_input")
    limit = int(params.get("limit", limit_default))
    cursor = int(params.get("after", params.get("before", 0)))
    if not 1 <= limit <= 100 or not 0 <= cursor < 2**63:
        raise guest_error(ValueError, "invalid_input")
    ascending = "after" in params
    cursor_program = "AND item.id>?" if ascending else "AND item.id<?" if "before" in params else ""
    values = (room_id, cursor, limit + 1) if cursor_program else (room_id, limit + 1)
    rows = connection.execute(f"{sql} {cursor_program} ORDER BY item.id {'ASC' if ascending else 'DESC'} LIMIT ?", values).fetchall()
    return (rows[:limit] if ascending else list(reversed(rows[:limit]))), len(rows) > limit


GUEST_MESSAGE_SQL = """SELECT item.id,item.author,item.text,item.created_at,item.source,
    (w.message_id IS NOT NULL) AS withdrawn FROM messages item LEFT JOIN message_withdrawals w ON w.message_id=item.id
    WHERE item.room_id=? AND NOT EXISTS(SELECT 1 FROM internal_task_messages t WHERE t.message_id=item.id)"""


def guest_withdrawable(connection, message_id):
    """A guest cannot withdraw a message after an associated request has been handled."""
    return not connection.execute("""SELECT 1 FROM member_requests r WHERE message_id=?
        AND (execution_id IS NOT NULL OR status NOT IN ('pending','cancelled')
            OR EXISTS(SELECT 1 FROM retried_requests previous WHERE previous.request_id=r.id)) LIMIT 1""",
        (message_id,)).fetchone()


def guest_message_view(connection, room_id, row, visit):
    """Project one public message, including server-computed withdrawal rights."""
    origin = guest_origin(connection, row["id"])
    author = origin["label"] if origin else free_room.member_display_names(connection, room_id).get(row["author"], row["author"])
    kind = "guest" if origin else "owner" if row["author"] == "用户" else "system" if row["source"] == "system" else "member"
    withdrawn = bool(row["withdrawn"])
    return {"id": row["id"], "author_label": author, "author_kind": kind, "text": "" if withdrawn else row["text"],
            "created_at": int(datetime.fromisoformat(row["created_at"]).timestamp() * 1000), "withdrawn": withdrawn,
            "can_withdraw": bool(origin and origin["guest_id"] == visit["guest_id"] and not withdrawn
                                 and guest_withdrawable(connection, row["id"])), "origin": origin}


def guest_message_by_id(connection, room_id, message_id, visit):
    """Return one guest-visible message."""
    row = connection.execute(GUEST_MESSAGE_SQL + " AND item.id=?", (room_id, message_id)).fetchone()
    if not row:
        raise guest_error(LookupError, "not_found")
    return guest_message_view(connection, room_id, row, visit)


def guest_post(connection, room_id, visit, payload):
    """Append one guest message and its requests without granting owner authority."""
    text, mentions = payload.get("text"), payload.get("mentions", [])
    if (set(payload) - {"text", "mentions", "submission_id"} or not isinstance(text, str)
            or not 0 < len(text.strip()) <= GUEST_MAX_MESSAGE or text.lstrip().startswith("/")
            or not isinstance(mentions, list) or any(not isinstance(name, str) for name in mentions)):
        raise guest_error(ValueError, "invalid_input")
    text = text.strip()
    submission = guest_identifier(payload.get("submission_id"))
    key = "guest-" + hashlib.sha256(f'{visit["guest_id"]}:{submission}'.encode()).hexdigest()
    targets = json.dumps(sorted(set(mentions)), ensure_ascii=False)
    earlier = connection.execute("""SELECT m.id,m.text,s.mentions FROM messages m
        JOIN guest_message_sources s ON s.message_id=m.id WHERE m.room_id=? AND m.submission_id=?""",
        (room_id, key)).fetchone()
    if earlier:
        if earlier["text"] != text or earlier["mentions"] != targets:
            raise guest_error(FileExistsError, "submission_conflict")
        return earlier["id"]
    archived = connection.execute("SELECT archived FROM room_directory WHERE room_id=?", (room_id,)).fetchone()
    if archived and archived[0]:
        raise guest_error()
    pairs = free_room.recipients(connection, room_id, {"to": mentions} if mentions else {})
    now = datetime.now(timezone.utc).isoformat()
    author = f'guest:{visit["guest_id"]}'
    message_id = connection.execute("""INSERT INTO messages(room_id,author,text,source,submission_id,created_at)
        VALUES (?,?,?,'guest',?,?)""", (room_id, author, text, key, now)).lastrowid
    connection.execute("INSERT INTO guest_message_sources(message_id,guest_id,mentions) VALUES (?,?,?)",
                       (message_id, visit["guest_id"], targets))
    connection.execute("INSERT INTO message_details(message_id,kind,submitted_by) VALUES (?,'chat',?)",
                       (message_id, visit["label"]))
    for member_id, purpose in pairs:
        free_room.insert_request(connection, room_id, member_id, message_id, message_id, purpose, "guest")
    return message_id


def guest_withdraw(connection, room_id, visit, message_id, payload):
    """Withdraw only the presenting visit's own untouched message, atomically."""
    if payload:
        raise guest_error(ValueError, "invalid_input")
    message = guest_message_by_id(connection, room_id, message_id, visit)
    if (message["origin"] or {}).get("guest_id") != visit["guest_id"]:
        raise guest_error()
    if message["withdrawn"]:
        return
    if not message["can_withdraw"]:
        raise guest_error(FileExistsError, "guest_not_withdrawable")
    connection.execute("INSERT INTO message_withdrawals(message_id,kind,created_at) VALUES (?,'retracted',?)",
                       (message_id, int(time.time())))
    where = "room_id=? AND message_id=? AND status='pending'"
    free_room.record_cancel_reasons(connection, where, (room_id, message_id), "guest_withdrawn")
    connection.execute(f"UPDATE member_requests SET status='cancelled' WHERE {where}", (room_id, message_id))


def guest_members(connection, room_id):
    """Expose public member handles needed for display and mentions."""
    labels = free_room.member_display_names(connection, room_id)
    return [{"id": row["name"], "label": labels[row["name"]], "role": row["role"], "status": row["status"]}
            for row in connection.execute("SELECT name,role,status FROM room_members WHERE room_id=? AND status<>'removed' ORDER BY id",
                                          (room_id,))]


def guest_executions(connection, room_id, params):
    """Expose execution status, excluding logs, paths and command output."""
    rows, more = guest_page(connection, """SELECT item.id,item.status,item.created_at,item.finished_at,
        m.name,(SELECT MIN(r.message_id) FROM member_requests r WHERE r.execution_id=item.id
        AND NOT EXISTS(SELECT 1 FROM internal_task_messages t WHERE t.message_id=r.message_id)) AS request_message_id
        FROM member_executions item JOIN room_members m ON m.id=item.member_id WHERE item.room_id=?""", room_id, params)
    labels = free_room.member_display_names(connection, room_id)
    return {"items": [{"id": row["id"], "status": row["status"], "member_id": row["name"],
                       "member_label": labels.get(row["name"], row["name"]),
                       "started_at": row["created_at"] * 1000,
                       "ended_at": row["finished_at"] * 1000 if row["finished_at"] else None,
                       "request_message_id": row["request_message_id"]} for row in rows], "has_more": more}


def guest_private(connection, room_id, params):
    """Expose only owner and member text for an explicitly shared private chat."""
    rows, more = guest_page(connection, """SELECT item.id,item.text,item.reply,item.created_at,item.updated_at,m.name
        FROM private_chats item JOIN room_members m ON m.id=item.member_id WHERE item.room_id=?""", room_id, params)
    labels = free_room.member_display_names(connection, room_id)
    items = []
    for row in rows:
        label = labels.get(row["name"], row["name"])
        items.append({"id": row["id"], "member_label": label, "author_label": "用户",
                      "text": row["text"], "created_at": row["created_at"] * 1000})
        if row["reply"]:
            items.append({"id": row["id"], "member_label": label, "author_label": label,
                          "text": row["reply"], "created_at": row["updated_at"] * 1000})
    return {"items": items, "has_more": more}


def guest_projection(connection, parts, method, token, params, read_payload):
    """Authenticate and serve the browser's narrowly projected data."""
    room_id, route = parts[3], parts[5:]
    payload = read_payload() if method == "POST" else None
    begin_write(connection)
    now = guest_now()
    guest_refresh(connection, room_id, now)
    visit = connection.execute("SELECT * FROM room_guest_visits WHERE room_id=? AND token_hash=?",
                               (room_id, guest_token_hash(token))).fetchone()
    if not visit or not guest_route_allowed(method, route):
        raise guest_error()
    phase = guest_phase(visit, now)
    if phase == "ended":
        connection.commit()
        raise guest_error(code="guest_ended", reason=visit["reason"] or "expired",
                          disconnected_by=guest_disconnected_by(visit["reason"]))
    room = connection.execute("SELECT title FROM rooms WHERE id=?", (room_id,)).fetchone()
    if route == ["session"]:
        state = guest_view(visit, now)
        guest = {key: state["guest"][key] for key in ("id", "label", "scope", "private_chat", "duration_seconds", "joined_at", "expires_at")}
        return {"phase": phase, "server_time": now, "guest": {**guest, "mode": state["mode"]}, "room_title": room["title"]}
    if phase != "active":
        raise guest_error(FileExistsError, "guest_waiting")
    if method == "POST":
        message_id = guest_post(connection, room_id, visit, payload) if route == ["messages"] else int(route[1])
        if route != ["messages"]:
            guest_withdraw(connection, room_id, visit, message_id, payload)
        return {"message": guest_message_by_id(connection, room_id, message_id, visit)}
    return guest_read(connection, room_id, route, params, visit, room)


def guest_read(connection, room_id, route, params, visit, room):
    """Read one active guest projection; file data is served by the audited gateway."""
    if route == ["room"]:
        return {"id": room_id, "title": room["title"], "members": guest_members(connection, room_id)}
    if route == ["messages"]:
        rows, more = guest_page(connection, GUEST_MESSAGE_SQL, room_id, params)
        return {"items": [guest_message_view(connection, room_id, row, visit) for row in rows], "has_more": more}
    if route == ["executions"]:
        return guest_executions(connection, room_id, params)
    if route == ["private"] and visit["private_chat"]:
        return guest_private(connection, room_id, params)
    raise guest_error()

"""External members: AIs that run on another computer and reach this room only through the runner's gateway.

An external member is a `room_members` row with `access='external'` plus one `external_members` row holding where it
runs, what it may read, until when, and its read quota. This module is the room-side authority (DESIGN D4): it decides
validity, expiry and revocation, keeps the read audit and quota counts, and serves the only routes an external
credential may use (`/api/external/rooms/{room}/...`). Every other route refuses an external credential or a request
the gateway marked as external; see `guard_route`. Contract: .dev/plans/远程协作与多人房间/子Task1_B侧后端/CONTRACT.md.
"""

import hashlib
import json
import posixpath
import time
from datetime import datetime, timezone

from . import free_room
from .identity import AI_PLATFORMS, MAX_ROOM_AGENTS, PLATFORM_NICKNAMES, is_ai
from .runtime import begin_write, require_owner, token_hash
from .texts import Text, text_payload

EXTERNAL_HEADER = "X-CoDiscuss-External"
BRIDGE_HEADER = "X-CoDiscuss-Bridge"
EXTERNAL_PREFIX = ["api", "external", "rooms"]
SCOPES = ("discuss", "read")
# How many ended external members the roster still lists.
MAX_ENDED_SHOWN = 10
QUOTA_KEYS = ("hourly_bytes", "total_bytes", "hourly_reads")
DEFAULT_QUOTA = {"hourly_bytes": 4 * 1024 * 1024, "total_bytes": 64 * 1024 * 1024, "hourly_reads": 600}
MAX_QUOTA = {"hourly_bytes": 1024 ** 3, "total_bytes": 100 * 1024 ** 3, "hourly_reads": 100000}
MAX_EXTERNAL_SECONDS = 365 * 86400
PENDING_SEAT_SECONDS = 7 * 86400
MAX_DIRECTORIES = 20
MAX_DIRECTORY_LENGTH = 500
MAX_MACHINE = 200
MAX_MACHINE_LABEL = 80
MAX_ADAPTER = 40
MAX_MODEL = 120
HOUR_SECONDS = 3600
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


def quota_of(row):
    """The member's three quota limits."""
    return {key: row[key] for key in QUOTA_KEYS}


def usage_of(connection, member_id, now=None):
    """Read counts from the persisted audit: allowed bytes and reads in the last hour, allowed bytes in total, denials."""
    since = ((now or int(time.time())) - HOUR_SECONDS) * 1000
    row = connection.execute("""SELECT COALESCE(SUM(CASE WHEN allowed=1 AND at>? THEN bytes END),0),
        COALESCE(SUM(CASE WHEN allowed=1 AND at>? THEN 1 END),0),COALESCE(SUM(CASE WHEN allowed=1 THEN bytes END),0),
        COALESCE(SUM(CASE WHEN allowed=0 THEN 1 END),0) FROM external_reads WHERE member_id=?""", (since, since, member_id)).fetchone()
    return {"hour_bytes": row[0], "hour_reads": row[1], "total_bytes": row[2], "denied": row[3]}


def directory_names(directories):
    """Directory roots by number with only their last segment, for views that must not show local paths."""
    return [{"root": index, "name": posixpath.basename(path.replace("\\", "/").rstrip("/")) or path}
            for index, path in enumerate(directories)]


def owner_view(connection, row):
    """Describe one external member for the owner, with full directory paths and current usage."""
    labels = free_room.member_display_names(connection, row["room_id"])
    return {"member_id": row["id"], "name": row["name"], "label": labels.get(row["name"], row["name"]), "adapter": row["adapter"],
            "status": row["status"], "machine": row["machine"], "machine_label": row["machine_label"], "platform": row["platform"],
            "model": row["model"], "scope": row["scope"], "directories": json.loads(row["directories"]), "expires_at": row["expires_at"], "quota": quota_of(row),
            "usage": usage_of(connection, row["id"]), "created_at": row["created_at"], "updated_at": row["updated_at"],
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


def checked_quota(value, current):
    """Merge given quota limits over `current`; each is a positive integer within its maximum."""
    if value is None:
        return dict(current)
    if not isinstance(value, dict) or set(value) - set(QUOTA_KEYS):
        raise ValueError(Text("quota 只能包含 hourly_bytes、total_bytes、hourly_reads"))
    merged = dict(current)
    for key, item in value.items():
        if type(item) is not int or not 0 < item <= MAX_QUOTA[key]:
            raise ValueError(Text("配额 {key} 须为 1–{limit} 的整数", key=key, limit=MAX_QUOTA[key]))
        merged[key] = item
    return merged


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
    quota = checked_quota(payload.get("quota"), DEFAULT_QUOTA)
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
                        expires_at, quota["hourly_bytes"], quota["total_bytes"], quota["hourly_reads"], now, now, 0 if pending else now))
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
    quota = checked_quota(payload.get("quota"), quota_of(row))
    label = checked_text(payload["machine_label"], MAX_MACHINE_LABEL, "machine_label") if "machine_label" in payload else row["machine_label"]
    connection.execute("""UPDATE external_members SET scope=?,directories=?,expires_at=?,hourly_bytes=?,total_bytes=?,hourly_reads=?,
        machine_label=?,updated_at=? WHERE member_id=?""", (scope, json.dumps(directories, ensure_ascii=False), expires_at,
                                                          quota["hourly_bytes"], quota["total_bytes"], quota["hourly_reads"], label, now, member_id))
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


def name_joined(connection, row, now):
    """On first joining, a seat still under its pending name takes its AI's (外部 Claude, 外部 Claude2 …).

    A name the owner gave is kept, and so is the pending one when the AI is unknown or a custom API, which has no
    name of its own. Only the label changes; the member name that requests and records use stays.
    """
    platform = connection.execute("SELECT platform FROM external_members WHERE member_id=?", (row["id"],)).fetchone()[0]
    current = free_room.member_labels(connection, row["room_id"]).get(row["name"])
    legacy = "另一台电脑" + row["name"].removeprefix("Custom-ext")
    if platform in ("", "Custom") or current not in (pending_label(row["name"], row["id"]), legacy):
        return
    nickname = PLATFORM_NICKNAMES.get(platform, platform)
    taken = set(free_room.member_display_names(connection, row["room_id"]).values())
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


def read_decision(row, root, size, outcome, reason, usage):
    """Decide one read: (allowed, code, reason). Only reads the engine served count toward the quota."""
    if row["status"] != "active":
        return False, "member_ended", ENDED_TEXTS.get(row["end_reason"], ENDED_TEXTS["revoked"])
    if outcome == "denied":
        return False, "engine_denied", reason
    if row["scope"] != "read":
        return False, "not_readable", Text("该外部成员只讨论，未开放读取项目")
    if root >= len(json.loads(row["directories"])):
        return False, "bad_root", Text("该目录未对外部成员开放")
    if usage["hour_reads"] + 1 > row["hourly_reads"]:
        return False, "quota_hour_reads", Text("本小时读取次数已达上限")
    if usage["hour_bytes"] + size > row["hourly_bytes"]:
        return False, "quota_hour_bytes", Text("本小时读取量已达上限")
    if usage["total_bytes"] + size > row["total_bytes"]:
        return False, "quota_total_bytes", Text("读取总量已达上限")
    return True, "ok", ""


def record_read(connection, room_id, member_id, token, payload):
    """Audit one read, then judge it against the persisted quota, and commit before the gateway may return content.

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
    allowed, code, why = read_decision(row, root, size, outcome, reason, usage_of(connection, member_id))
    connection.execute("UPDATE external_reads SET allowed=?,code=?,reason=? WHERE id=?", (int(allowed), code, str(why), read_id))
    data = {"member_id": member_id, "member": row["name"], "read_id": read_id, "op": op, "root": root, "directory": directory,
            "path": path, "bytes": size, "allowed": allowed, "code": code, "reason": str(why)}
    connection.execute("UPDATE room_events SET data=? WHERE id=?", (json.dumps(data, ensure_ascii=False), event))
    connection.commit()
    return {"allowed": allowed, "code": code, "reason": why, "reason_text": text_payload(why), "read_id": read_id, "recorded": True,
            "usage": usage_of(connection, member_id)}


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
    members = [{"name": row["name"], "label": labels.get(row["name"], row["name"]), "role": row["role"], "status": row["status"],
                "external": row["access"] == "external"}
               for row in connection.execute(f"SELECT name,role,status,access FROM room_members WHERE room_id=? AND status<>'removed' AND {free_room.REGISTERED_MEMBER} ORDER BY id",
                                             (room_id,))]
    latest = connection.execute("""SELECT COALESCE(MAX(id),0) FROM messages m WHERE room_id=?
        AND NOT EXISTS (SELECT 1 FROM internal_task_messages t WHERE t.message_id=m.id)""", (room_id,)).fetchone()[0]
    me = {"member_id": member["id"], "name": member["name"], "label": labels.get(member["name"], member["name"]), "scope": member["scope"],
          "expires_at": member["expires_at"], "directories": directory_names(json.loads(member["directories"])),
          "quota": quota_of(member), "usage": usage_of(connection, member["id"])}
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
    save_ai(connection, member["id"], payload, int(time.time()))
    return {"reported": True}


def lend_until(connection, member, payload):
    """The member's computer sets how long it lends its AI; only its own end changes, never what it may read (red line 1 exception)."""
    expires_at = checked_expiry(payload.get("expires_at"), int(time.time()))
    connection.execute("UPDATE external_members SET expires_at=?,updated_at=? WHERE member_id=?", (expires_at, int(time.time()), member["id"]))
    return {"expires_at": expires_at}


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
    if route == ["expiry"]:
        return lend_until(connection, member, payload), 200
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

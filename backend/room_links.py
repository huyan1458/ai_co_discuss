"""Owner-managed peer rooms and host requests to link existing rooms."""

import re
import uuid

from .free_room import linked_room_values, member_display_names, relay_count, require_owner_or_host, wake_host
from .message_queue import host_busy
from .runtime import begin_write, require_owner
from .texts import Text, save_text


def request_view(db, room, message_id):
    """Read one application within its source room."""
    row = db.execute("""SELECT q.message_id AS id,q.target_room_id AS room_id,r.title,q.reason,q.state
        FROM room_link_requests q JOIN messages m ON m.id=q.message_id
        LEFT JOIN rooms r ON r.id=q.target_room_id WHERE m.room_id=? AND m.id=?""", (room, message_id)).fetchone()
    if not row:
        raise LookupError(Text("找不到关联申请"))
    return dict(row)


def card(db, room, source, text, key):
    """Append a system card without routing it to members."""
    mid = db.execute("""INSERT INTO messages(room_id,author,text,source,submission_id,created_at)
        VALUES (?,'系统',?,?,?,strftime('%Y-%m-%dT%H:%M:%SZ','now'))""", (room, text, source, key)).lastrowid
    db.execute("INSERT INTO message_details(message_id,kind,submitted_by) VALUES (?,'notice','系统')", (mid,))
    save_text(db, "message", mid, "text", text)
    return mid


def change_peer(db, room, other, remove):
    """Write both sides together while holding the transaction's writer lock."""
    linked_room_values(db, room, other, "peer")
    for source, dest in ((room, other), (other, room)):
        row = db.execute("SELECT relation FROM room_links WHERE room_id=? AND other_room_id=?", (source, dest)).fetchone()
        if remove and (not row or row[0] != "peer"):
            raise ValueError(Text("只能解除已有的平级关联"))
        if not remove and row:
            raise FileExistsError(Text("两个房间已经关联"))
        title = db.execute("SELECT title FROM rooms WHERE id=?", (dest,)).fetchone()[0]
        text = Text("已解除与房间「{title}」的关联。", title=title) if remove else Text("已关联房间「{title}」。", title=title)
        mid = card(db, source, "room_link", text, uuid.uuid4().hex)
        if remove:
            db.execute("DELETE FROM room_links WHERE room_id=? AND other_room_id=?", (source, dest))
        else:
            db.execute("INSERT INTO room_links VALUES (?,?,?,'peer','')", (mid, source, dest))
    return {"ok": True}


def list_links(db, room, limit=0):
    """Return current targets, host availability and sender receipts."""
    result = []
    for row in db.execute("""SELECT r.id AS room_id,r.title,l.relation,
        (SELECT name FROM room_members WHERE room_id=r.id AND role='host' AND status='active') AS host,
        (SELECT COALESCE(MAX(id),0) FROM messages WHERE room_id=r.id) AS latest_id
        FROM room_links l JOIN rooms r ON r.id=l.other_room_id WHERE l.room_id=? ORDER BY r.title,r.id""", (room,)):
        dest = row["room_id"]
        receipts = db.execute("""SELECT message_id,target_message_id,queued_id,state FROM room_relay_sends
            WHERE room_id=? AND target_room_id=? ORDER BY message_id""", (room, dest))
        used = relay_count(db, room, dest)
        result.append(dict(row) | {"host": member_display_names(db, dest).get(row["host"]), "busy": bool(host_busy(db, dest)), "outbound": list(map(dict, receipts)),
                                   "relay_used": used, "relay_remaining": max(0, limit - used) if limit else None})
    return {"links": result}


def apply_link(db, room, token, body):
    """Record a host's idempotent request without granting access."""
    if not require_owner_or_host(db, room, token):
        raise PermissionError(Text("只有当前主持人可以申请关联"))
    other, reason, key = body.get("room_id"), body.get("reason"), body.get("submission_id")
    linked_room_values(db, room, other, "peer")
    if not isinstance(reason, str) or not reason.strip() or len(reason) > 32000 or not isinstance(key, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{8,100}", key):
        raise ValueError(Text("需要有效的申请理由和提交编号"))
    old = db.execute("SELECT id FROM messages WHERE room_id=? AND submission_id=?", (room, key)).fetchone()
    if old:
        view = request_view(db, room, old[0])
        if (view["room_id"], view["reason"]) != (other, reason):
            raise FileExistsError(Text("这个提交编号已被另一条内容使用，请为新发言生成新编号"))
        return view
    if db.execute("SELECT 1 FROM room_links WHERE room_id=? AND other_room_id=?", (room, other)).fetchone():
        raise FileExistsError(Text("两个房间已经关联"))
    mid = card(db, room, "room_link_request", reason, key)
    db.execute("INSERT INTO room_link_requests VALUES (?,?,?,'pending')", (mid, other, reason))
    return request_view(db, room, mid)


def handle_links(db, room, token, path, method, body, site_owner, target_token, limit=0):
    """Dispatch link management with source and destination ownership checks."""
    if path == ["room-links"] and method == "GET":
        require_owner_or_host(db, room, token)
        if not 0 <= limit <= 100:
            raise ValueError(Text("relay.limit 须为 0–100 的整数，0 表示不限"))
        return list_links(db, room, limit)
    begin_write(db)
    if path == ["room-link-requests"] and method == "POST":
        return apply_link(db, room, token, body)
    require_owner(db, room, token)
    decision = len(path) == 3 and path[0] == "room-link-requests" and path[2] == "decide" and method == "POST"
    if decision:
        req = request_view(db, room, int(path[1]))
        other = req["room_id"]
        if type(body.get("approve")) is not bool:
            raise ValueError(Text("approve 须为布尔值"))
    elif path == ["room-links"] and method == "POST":
        other = body.get("room_id")
    elif len(path) == 2 and path[0] == "room-links" and method == "DELETE":
        other = path[1]
    else:
        raise LookupError(Text("接口不存在"))
    if not site_owner and (not decision or body["approve"]):
        require_owner(db, other, target_token)
    if not decision:
        return change_peer(db, room, other, method == "DELETE" or body.get("action") == "delete")
    state = "approved" if body["approve"] else "declined"
    if req["state"] == state:
        return req
    if req["state"] != "pending":
        raise FileExistsError(Text("申请已经处理"))
    if body["approve"]:
        change_peer(db, room, other, False)
    db.execute("UPDATE room_link_requests SET state=? WHERE message_id=?", (state, req["id"]))
    notice = (Text("与房间 {room} 的关联已批准，可以发送消息。", room=other) if body["approve"]
              else Text("与房间 {room} 的关联申请已拒绝。", room=other))
    wake_host(db, room, req["id"], notice, f"peer-link-{req['id']}")
    return request_view(db, room, req["id"])

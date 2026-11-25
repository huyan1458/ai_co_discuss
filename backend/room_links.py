"""Parent and child rooms visible to their host or owner."""

from .free_room import member_display_names, relay_count
from .message_queue import host_busy


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

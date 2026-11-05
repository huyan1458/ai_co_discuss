"""Owner messages queued while members work, posted one by one once the room is idle.

The owner's composer sends with `queue: true`; when the room is busy (or earlier messages still wait) the message is kept
here instead of being posted. Each idle moment posts the head through the normal message path with its own submission_id,
so a repeated drain finds the posted message and only removes the row. A failed post keeps the row with its reason and holds
the queue; the owner's stop pauses it. The owner may send one at once, edit, delete, reorder or resume the queue.
"""

import json
import time

from .runtime import begin_write, require_owner

QUEUED_FIELDS = ("author", "text", "reply_to", "kind", "submitted_by", "to", "sequential", "order", "attachment_ids", "submission_id")
QUEUE_ACTIONS = ("send", "edit", "delete", "reorder", "resume", "queueing")
QUEUE_ERRORS = (ValueError, TypeError, LookupError, PermissionError, FileExistsError)


def queueing_enabled(connection):
    """Whether the site queues owner messages sent while members work; on unless the owner turned it off."""
    row = connection.execute("SELECT queueing FROM composer_settings WHERE id=1").fetchone()
    return row is None or bool(row[0])


def room_busy(connection, room_id):
    """A member still has an open request, a one-after-another turn waits, or a discussion runs."""
    return connection.execute("""SELECT 1 FROM member_requests WHERE room_id=? AND status IN ('pending','delivering')
        UNION ALL SELECT 1 FROM free_queue_waiting WHERE room_id=?
        UNION ALL SELECT 1 FROM discussion_sessions WHERE room_id=? AND status='active' LIMIT 1""",
                              (room_id, room_id, room_id)).fetchone() is not None


def queue_view(connection, room_id):
    """The room's queued owner messages in order, whether the queue is paused, and the site's queueing switch."""
    items = []
    for row in connection.execute("SELECT * FROM queued_messages WHERE room_id=? ORDER BY position,id", (room_id,)):
        payload = json.loads(row["payload"])
        files = [dict(item) for item in connection.execute(
            "SELECT id,file_name,content_type FROM attachments WHERE room_id=? AND id IN (SELECT value FROM json_each(?))",
            (room_id, json.dumps(payload.get("attachment_ids", []))))]
        items.append({"id": row["id"], "text": payload.get("text", ""), "attachments": files, "failure": row["failure"],
                      "created_at": row["created_at"]})
    paused = connection.execute("SELECT 1 FROM queued_message_pauses WHERE room_id=?", (room_id,)).fetchone() is not None
    return {"items": items, "paused": paused and bool(items), "busy": room_busy(connection, room_id),
            "queueing": queueing_enabled(connection)}


def should_queue(connection, room_id, payload):
    """Queue an owner message that asked for it while the room is busy or earlier messages still wait."""
    if payload.get("queue") is not True:
        return False
    return room_busy(connection, room_id) or connection.execute(
        "SELECT 1 FROM queued_messages WHERE room_id=? LIMIT 1", (room_id,)).fetchone() is not None


def enqueue(connection, room_id, payload):
    """Keep a validated owner message at the end of the queue; a retry with the same submission_id returns the same row."""
    stored = {key: payload[key] for key in QUEUED_FIELDS if key in payload}
    previous = connection.execute("SELECT * FROM queued_messages WHERE room_id=? AND submission_id=?",
                                  (room_id, stored["submission_id"])).fetchone()
    if previous:
        if json.loads(previous["payload"]) != stored:
            raise FileExistsError("这个提交编号已被另一条内容使用，请为新发言生成新编号")
        return {"queued": previous["id"], "duplicate": True}
    position = connection.execute("SELECT COALESCE(MAX(position),0)+1 FROM queued_messages WHERE room_id=?", (room_id,)).fetchone()[0]
    if position == 1:
        # A pause belongs to the messages that were queued when the owner stopped; a new queue starts unpaused.
        connection.execute("DELETE FROM queued_message_pauses WHERE room_id=?", (room_id,))
    cursor = connection.execute("INSERT INTO queued_messages (room_id,position,submission_id,payload,created_at) VALUES (?,?,?,?,?)",
                                (room_id, position, stored["submission_id"], json.dumps(stored, ensure_ascii=False), int(time.time())))
    return {"queued": cursor.lastrowid, "duplicate": False}


def post_item(connection, room_id, row, post):
    """Post one queued message through the normal path and drop its row; a refused post keeps the row with the reason.

    Returns:
        The post's result (with the saved `message`), or None when it was refused.
    """
    connection.execute("SAVEPOINT queued_post")
    try:
        result = post(connection, room_id, json.loads(row["payload"]), "用户")
    except QUEUE_ERRORS as error:
        connection.execute("ROLLBACK TO queued_post")
        connection.execute("RELEASE queued_post")
        connection.execute("UPDATE queued_messages SET failure=? WHERE id=?", (str(error)[:500] or "发送失败", row["id"]))
        return None
    connection.execute("RELEASE queued_post")
    connection.execute("DELETE FROM queued_messages WHERE id=?", (row["id"],))
    return result


def drain(connection, room_id, post):
    """Post the head while the room is idle, unpaused and the head has not failed; stops at the first message that keeps it busy."""
    if not connection.execute("SELECT 1 FROM queued_messages WHERE room_id=? LIMIT 1", (room_id,)).fetchone():
        return
    begin_write(connection)
    archived = connection.execute("SELECT archived FROM room_directory WHERE room_id=?", (room_id,)).fetchone()
    if archived is None or archived[0] or connection.execute("SELECT 1 FROM queued_message_pauses WHERE room_id=?", (room_id,)).fetchone():
        return
    while not room_busy(connection, room_id):
        head = connection.execute("SELECT * FROM queued_messages WHERE room_id=? ORDER BY position,id LIMIT 1", (room_id,)).fetchone()
        if head is None or head["failure"] or not post_item(connection, room_id, head, post):
            return


def pause(connection, room_id):
    """The owner stopped members: hold what is queued until resumed, as interrupting a turn holds Codex's queue."""
    if connection.execute("SELECT 1 FROM queued_messages WHERE room_id=? LIMIT 1", (room_id,)).fetchone():
        connection.execute("INSERT OR IGNORE INTO queued_message_pauses (room_id) VALUES (?)", (room_id,))


def queued_row(connection, room_id, item_id):
    """One queued message of this room."""
    row = connection.execute("SELECT * FROM queued_messages WHERE room_id=? AND id=?", (room_id, item_id)).fetchone()
    if row is None:
        raise LookupError("这条排队消息已发出或已删除")
    return row


def edit_item(connection, row, text, check):
    """Replace a queued message's text; `check` validates the edited payload as a message would be."""
    payload = json.loads(row["payload"])
    payload["text"] = str(text if text is not None else "").strip()
    check(payload)
    connection.execute("UPDATE queued_messages SET payload=?,failure='' WHERE id=?", (json.dumps(payload, ensure_ascii=False), row["id"]))


def reorder(connection, room_id, ids):
    """Put the queue in the given order; the list must name exactly the messages still queued."""
    current = [row[0] for row in connection.execute("SELECT id FROM queued_messages WHERE room_id=? ORDER BY position,id", (room_id,))]
    if not isinstance(ids, list) or sorted(ids) != sorted(current):
        raise FileExistsError("排队消息已变化，请刷新后再调整顺序")
    for position, item_id in enumerate(ids, 1):
        connection.execute("UPDATE queued_messages SET position=? WHERE id=?", (position, item_id))


def queue_action(connection, room_id, token, payload, post, check, interrupt):
    """The owner acts on the queue: send one now, edit, delete, reorder, resume, or switch queueing for the site.

    `post(connection, room_id, payload, actor)` posts a message; `check(payload)` validates an edited one;
    `interrupt(connection, room_id, message_id)` stops the busy members a message sent now was given to, so it does not
    wait behind their current turn, and raises when one cannot be stopped, which leaves the whole write undone.
    """
    require_owner(connection, room_id, token)
    begin_write(connection)
    action = payload.get("action")
    if action not in QUEUE_ACTIONS:
        raise ValueError(f"action 须为 {'、'.join(QUEUE_ACTIONS)} 之一")
    if action == "send":
        row = queued_row(connection, room_id, payload.get("id"))
        connection.execute("UPDATE queued_messages SET failure='' WHERE id=?", (row["id"],))
        result = post_item(connection, room_id, row, post)
        if not result:
            raise ValueError(connection.execute("SELECT failure FROM queued_messages WHERE id=?", (row["id"],)).fetchone()[0])
        if result.get("message"):
            interrupt(connection, room_id, result["message"]["id"])
    elif action == "edit":
        edit_item(connection, queued_row(connection, room_id, payload.get("id")), payload.get("text"), check)
    elif action == "delete":
        connection.execute("DELETE FROM queued_messages WHERE id=?", (queued_row(connection, room_id, payload.get("id"))["id"],))
    elif action == "reorder":
        reorder(connection, room_id, payload.get("ids"))
    elif action == "resume":
        connection.execute("DELETE FROM queued_message_pauses WHERE room_id=?", (room_id,))
    else:
        if not isinstance(payload.get("enabled"), bool):
            raise ValueError("enabled 须为 true 或 false")
        connection.execute("INSERT INTO composer_settings (id,queueing) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET queueing=excluded.queueing",
                           (int(payload["enabled"]),))
    drain(connection, room_id, post)
    return queue_view(connection, room_id)

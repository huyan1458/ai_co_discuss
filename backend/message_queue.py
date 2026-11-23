"""Owner messages queued while members work, released as their recipients come free.

The owner's composer sends with `queue: true`. A message that names members (`@成员`, not everyone and not in turn) is a
side question: it takes no place in the speaking order and goes to each named member as soon as that member has no open
request and nothing queued for it earlier. A named member still busy keeps its share here, so a message naming a free and a
busy member goes to the free one at once and to the busy one once it is free (the share of the posted message: its
`message_id`, `to` the members still waited for). Any other message (unnamed, everyone, everyone in turn) waits for the
whole room: no open request, turn waiting or running discussion. Each release of a new message goes through the normal
message path with its own submission_id, so a repeated drain finds the posted message and only moves on. A failed post
keeps the row with its reason and holds the queue; the owner's stop pauses it. The owner may send one at once, edit,
delete, reorder or resume the queue.
"""

import json
import time

from .runtime import begin_write, require_owner
from .texts import Text, load_texts, save_text

QUEUED_FIELDS = ("author", "text", "reply_to", "kind", "submitted_by", "to", "sequential", "order", "attachment_ids", "attachment_start",
                 "submission_id", "message_id", "relay")
# Queueing is always on (user 2026-11-21, #7060): the old site switch only left messages waiting on a busy member with
# nothing left to edit, and once off it could not be found again; `composer_settings.queueing` is no longer read.
QUEUE_ACTIONS = ("send", "edit", "delete", "reorder", "resume")
QUEUE_ERRORS = (ValueError, TypeError, LookupError, PermissionError, FileExistsError)


def room_busy(connection, room_id):
    """A member still has an open request, a one-after-another turn waits, or a discussion runs.

    Work the host left running in the background (sent without a handoff, or kept working beside it, as in
    free_room.BACKGROUND_SQL) does not hold the owner's messages: the room goes on without waiting for it."""
    return connection.execute("""SELECT 1 FROM member_requests r WHERE r.room_id=? AND r.status IN ('pending','delivering')
          AND NOT (r.purpose='ask' AND r.created_by='host' AND (r.batch_id=0 OR EXISTS(
            SELECT 1 FROM member_requests k WHERE k.message_id=r.message_id AND k.purpose='keep_working')))
        UNION ALL SELECT 1 FROM free_queue_waiting WHERE room_id=?
        UNION ALL SELECT 1 FROM discussion_sessions WHERE room_id=? AND status='active' LIMIT 1""",
                              (room_id, room_id, room_id)).fetchone() is not None


def queue_view(connection, room_id):
    """The room's queued owner messages in order and whether the queue is paused.

    The share of a message already posted carries `message_id` and `waiting_for` (the members it still waits for); its
    files went out with that message, so it lists none."""
    items = []
    for row in connection.execute("SELECT * FROM queued_messages WHERE room_id=? ORDER BY position,id", (room_id,)):
        payload = json.loads(row["payload"])
        files = [dict(item) for item in connection.execute(
            "SELECT id,file_name,content_type FROM attachments WHERE room_id=? AND id IN (SELECT value FROM json_each(?))",
            (room_id, json.dumps(payload.get("attachment_ids", []))))]
        item = {"id": row["id"], "text": payload.get("text", ""), "attachments": files, "failure": row["failure"],
                "texts": load_texts(connection, "queued_message", row["id"]), "created_at": row["created_at"]}
        if named_members(connection, room_id, payload) is not None:
            item["to"] = payload["to"]
        if payload.get("message_id"):
            item.update(message_id=payload["message_id"], waiting_for=payload.get("to", []))
        item["send_mode"] = send_mode(connection, room_id, payload)
        items.append(item)
    paused = connection.execute("SELECT 1 FROM queued_message_pauses WHERE room_id=?", (room_id,)).fetchone() is not None
    busy_members = [row["name"] for row in connection.execute("SELECT id,name FROM room_members WHERE room_id=? AND status='active'", (room_id,))
                    if member_busy(connection, row["id"])]
    return {"items": items, "paused": paused and bool(items), "busy": room_busy(connection, room_id),
            "host_busy": host_busy(connection, room_id), "busy_members": busy_members}


def send_mode(connection, room_id, payload):
    """What "send now" would do with a queued message, so its button says so before it is clicked (user 2026-11-23):
    `send` (its recipients are free), `steer` (every busy recipient takes an interjection), `interrupt` (a busy one is
    stopped first) or `wait` (a busy one can do neither; the message stays queued).

    Recipients are the named members, or the host for a message the room as a whole waits for."""
    named = named_members(connection, room_id, payload)
    if named is None and payload.get("message_id"):
        return "send"
    ids = list(named.values()) if named else [row[0] for row in connection.execute(
        "SELECT id FROM room_members WHERE room_id=? AND role='host' AND status='active'", (room_id,))]
    modes = set()
    for member_id in ids:
        live = connection.execute("""SELECT c.stoppable,c.steer,c.resume FROM member_executions e
            LEFT JOIN execution_capabilities c ON c.execution_id=e.id
            WHERE e.member_id=? AND e.status IN ('dispatched','started')""", (member_id,)).fetchone()
        if live:
            modes.add("steer" if live["steer"] or live["resume"] else "wait" if live["stoppable"] == 0 else "interrupt")
    return "wait" if "wait" in modes else "interrupt" if "interrupt" in modes else "steer" if modes else "send"


def named_members(connection, room_id, payload):
    """The present members a side question names, as {name: id}; None for a message the whole room waits for."""
    named = payload.get("to")
    if not isinstance(named, list) or not named or payload.get("sequential") is True or payload.get("order") == "auto":
        return None
    present = {row["name"]: row["id"] for row in connection.execute(
        "SELECT id,name FROM room_members WHERE room_id=? AND status='active'", (room_id,))}
    found = {name: present[name] for name in named if name in present}
    return found or None


def addressed(payload):
    """The message names members one by one (not everyone, not in turn), present or not."""
    named = payload.get("to")
    return isinstance(named, list) and bool(named) and payload.get("sequential") is not True and payload.get("order") != "auto"


def drop_taken_back(connection, room_id):
    """Drop the shares of messages since retracted or rewound: nothing is left for their members to answer."""
    for row in connection.execute("SELECT id,payload FROM queued_messages WHERE room_id=?", (room_id,)).fetchall():
        message_id = json.loads(row["payload"]).get("message_id")
        if message_id and connection.execute("SELECT 1 FROM message_withdrawals WHERE message_id=?", (message_id,)).fetchone():
            connection.execute("DELETE FROM queued_messages WHERE id=?", (row["id"],))


def member_busy(connection, member_id):
    """The member has a request waiting or being worked on, or a turn still running."""
    return connection.execute("""SELECT 1 FROM member_requests WHERE member_id=? AND status IN ('pending','delivering')
        UNION ALL SELECT 1 FROM member_executions WHERE member_id=? AND status IN ('dispatched','started') LIMIT 1""",
                              (member_id, member_id)).fetchone() is not None


def waiting_names(connection, room_id, named, before=None):
    """Named members that cannot take a side question now: busy, or a message queued earlier still waits for them.

    `before` is the queued row being released, so only the rows ahead of it count; None counts the whole queue."""
    earlier = set()
    for row in connection.execute("SELECT id,payload FROM queued_messages WHERE room_id=? ORDER BY position,id", (room_id,)):
        if row["id"] == before:
            break
        queued = json.loads(row["payload"])
        if named_members(connection, room_id, queued) is not None:
            earlier.update(queued.get("to") or [])
    return [name for name, member_id in named.items() if name in earlier or member_busy(connection, member_id)]


def queue_split(connection, room_id, payload):
    """What of an owner message that asked for queueing must wait.

    Returns:
        None to post it whole now; "all" to queue it whole; otherwise the names of the named members whose share waits,
        the message going now to the others.
    """
    if payload.get("queue") is not True:
        return None
    named = named_members(connection, room_id, payload)
    if named is None:
        waits = room_busy(connection, room_id) or connection.execute(
            "SELECT 1 FROM queued_messages WHERE room_id=? LIMIT 1", (room_id,)).fetchone() is not None
        return "all" if waits else None
    waiting = waiting_names(connection, room_id, named)
    if not waiting:
        return None
    return "all" if len(waiting) == len(named) else waiting


def host_busy(connection, room_id):
    """The active host still has a request waiting or being worked on."""
    return connection.execute("""SELECT 1 FROM member_requests r JOIN room_members m ON m.id=r.member_id
        WHERE r.room_id=? AND r.status IN ('pending','delivering') AND m.role='host' AND m.status='active' LIMIT 1""",
                              (room_id,)).fetchone() is not None


def enqueue(connection, room_id, payload):
    """Keep a validated owner message at the end of the queue; a retry with the same submission_id returns the same row."""
    stored = {key: payload[key] for key in QUEUED_FIELDS if key in payload}
    previous = connection.execute("SELECT * FROM queued_messages WHERE room_id=? AND submission_id=?",
                                  (room_id, stored["submission_id"])).fetchone()
    if previous:
        if json.loads(previous["payload"]) != stored:
            raise FileExistsError(Text('这个提交编号已被另一条内容使用，请为新发言生成新编号'))
        return {"queued": previous["id"], "duplicate": True}
    position = connection.execute("SELECT COALESCE(MAX(position),0)+1 FROM queued_messages WHERE room_id=?", (room_id,)).fetchone()[0]
    if position == 1:
        # A pause belongs to the messages that were queued when the owner stopped; a new queue starts unpaused.
        connection.execute("DELETE FROM queued_message_pauses WHERE room_id=?", (room_id,))
    cursor = connection.execute("INSERT INTO queued_messages (room_id,position,submission_id,payload,created_at) VALUES (?,?,?,?,?)",
                                (room_id, position, stored["submission_id"], json.dumps(stored, ensure_ascii=False), int(time.time())))
    return {"queued": cursor.lastrowid, "duplicate": False}


def share_payload(payload, waiting, message_id):
    """The part of a posted message the busy named members still wait for; its files went out with the message."""
    return {**payload, "to": list(waiting), "message_id": message_id, "attachment_ids": []}


def enqueue_share(connection, room_id, payload, message_id, waiting):
    """Queue the share of a just-posted message that its busy named members wait for."""
    share = share_payload(payload, waiting, message_id)
    share["submission_id"] = f"{payload['submission_id']}:later"
    return enqueue(connection, room_id, share)


def give_share(connection, room_id, payload, names):
    """Ask the named members to answer a message already posted.

    Returns:
        The message's id, or None when it is gone or taken back (the share is then dropped).
    """
    message_id = payload["message_id"]
    if not connection.execute("SELECT 1 FROM messages WHERE room_id=? AND id=?", (room_id, message_id)).fetchone() or \
            connection.execute("SELECT 1 FROM message_withdrawals WHERE message_id=?", (message_id,)).fetchone():
        return None
    for member_id in (named_members(connection, room_id, {"to": names}) or {}).values():
        connection.execute("""INSERT OR IGNORE INTO member_requests (room_id,member_id,message_id,chain_id,batch_id,purpose,created_by,created_at)
            VALUES (?,?,?,?,0,'ask','user',?)""", (room_id, member_id, message_id, message_id, int(time.time())))
    return message_id


def keep_rest(connection, row, payload, waiting, message_id):
    """Release done: drop the row, or keep it as the share the members still busy wait for."""
    if waiting and message_id:
        connection.execute("UPDATE queued_messages SET payload=? WHERE id=?",
                           (json.dumps(share_payload(payload, waiting, message_id), ensure_ascii=False), row["id"]))
    else:
        connection.execute("DELETE FROM queued_messages WHERE id=?", (row["id"],))


def post_item(connection, room_id, row, post, names=None):
    """Release one queued row to `names` (everyone it waits for by default); the members left keep their share queued.

    A row not yet posted goes through the normal path; the share of a posted message asks its members for it. A refused
    post keeps the row with the reason.

    Returns:
        The post's result (with the saved `message`; `message_id` for a share), or None when it was refused.
    """
    payload = json.loads(row["payload"])
    present = list(named_members(connection, room_id, payload) or {})
    names = list(payload.get("to") or []) if names is None else names
    waiting = [name for name in present if name not in names]
    if payload.get("message_id"):
        message_id = give_share(connection, room_id, payload, names)
        keep_rest(connection, row, payload, waiting, message_id)
        return {"message_id": message_id}
    connection.execute("SAVEPOINT queued_post")
    try:
        result = post(connection, room_id, {**payload, "to": names} if waiting else payload, "用户")
    except QUEUE_ERRORS as error:
        connection.execute("ROLLBACK TO queued_post")
        connection.execute("RELEASE queued_post")
        failure = Text("发送失败：{reason}", reason=str(error)[:500])
        connection.execute("UPDATE queued_messages SET failure=? WHERE id=?", (str(failure)[:500], row["id"]))
        save_text(connection, "queued_message", row["id"], "failure", failure)
        return None
    connection.execute("RELEASE queued_post")
    keep_rest(connection, row, payload, waiting, result["message"]["id"])
    return result


def next_queued(connection, room_id):
    """The first queued row, in queue order, that may go now, and to whom.

    A side question goes to its named members that are free (no open request, nothing queued for them earlier); any
    other message goes only in an idle room.

    Returns:
        (row, names): the members to release it to, None for the whole message; (None, None) when nothing may go.
    """
    idle = not room_busy(connection, room_id)
    for row in connection.execute("SELECT * FROM queued_messages WHERE room_id=? ORDER BY position,id", (room_id,)).fetchall():
        payload = json.loads(row["payload"])
        named = named_members(connection, room_id, payload)
        if named is None:
            if payload.get("message_id"):
                # Its members have all left: drop the share.
                return row, []
            if idle and not addressed(payload):
                return row, None
            if addressed(payload) and not row["failure"]:
                # Its members have all left: it stays, marked, for the owner to edit or delete, without holding the rest.
                failure = Text("点名的成员已不在房间")
                connection.execute("UPDATE queued_messages SET failure=? WHERE id=?", (str(failure), row["id"]))
                save_text(connection, "queued_message", row["id"], "failure", failure)
            continue
        waiting = waiting_names(connection, room_id, named, before=row["id"])
        free = [name for name in named if name not in waiting]
        if free:
            return row, free if waiting or payload.get("message_id") else None
    return None, None


def drain(connection, room_id, post):
    """Release what may go now, one row at a time, unless the queue is paused; stops at a failed message or when nothing may go."""
    if not connection.execute("SELECT 1 FROM queued_messages WHERE room_id=? LIMIT 1", (room_id,)).fetchone():
        return
    begin_write(connection)
    drop_taken_back(connection, room_id)
    archived = connection.execute("SELECT archived FROM room_directory WHERE room_id=?", (room_id,)).fetchone()
    if archived is None or archived[0] or connection.execute("SELECT 1 FROM queued_message_pauses WHERE room_id=?", (room_id,)).fetchone():
        return
    while True:
        row, names = next_queued(connection, room_id)
        if row is None or row["failure"] or post_item(connection, room_id, row, post, names) is None:
            return


def pause(connection, room_id):
    """The owner stopped members: hold what is queued until resumed, as interrupting a turn holds Codex's queue."""
    if connection.execute("SELECT 1 FROM queued_messages WHERE room_id=? LIMIT 1", (room_id,)).fetchone():
        connection.execute("INSERT OR IGNORE INTO queued_message_pauses (room_id) VALUES (?)", (room_id,))


def queued_row(connection, room_id, item_id):
    """One queued message of this room."""
    row = connection.execute("SELECT * FROM queued_messages WHERE room_id=? AND id=?", (room_id, item_id)).fetchone()
    if row is None:
        raise LookupError(Text('这条排队消息已发出或已删除'))
    return row


def edit_item(connection, row, text, check):
    """Replace a queued message's text; `check` validates the edited payload as a message would be."""
    payload = json.loads(row["payload"])
    if payload.get("message_id"):
        raise FileExistsError(Text('这条消息已发出，只是还在等忙碌的成员；可以删除后重新发送'))
    payload["text"] = str(text if text is not None else "").strip()
    check(payload)
    connection.execute("UPDATE queued_messages SET payload=?,failure='' WHERE id=?", (json.dumps(payload, ensure_ascii=False), row["id"]))


def reorder(connection, room_id, ids):
    """Put the queue in the given order; the list must name exactly the messages still queued."""
    current = [row[0] for row in connection.execute("SELECT id FROM queued_messages WHERE room_id=? ORDER BY position,id", (room_id,))]
    if not isinstance(ids, list) or sorted(ids) != sorted(current):
        raise FileExistsError(Text('排队消息已变化，请刷新后再调整顺序'))
    for position, item_id in enumerate(ids, 1):
        connection.execute("UPDATE queued_messages SET position=? WHERE id=?", (position, item_id))


def queue_action(connection, room_id, token, payload, post, check, interrupt):
    """The owner acts on the queue: send one now, edit, delete, reorder or resume it.

    `post(connection, room_id, payload, actor)` posts a message; `check(payload)` validates an edited one;
    `interrupt(connection, room_id, message_id)` stops the busy members a message sent now was given to, so it does not
    wait behind their current turn, and raises when one cannot be stopped, which leaves the whole write undone.
    """
    require_owner(connection, room_id, token)
    begin_write(connection)
    action = payload.get("action")
    if action not in QUEUE_ACTIONS:
        raise ValueError(Text('action 须为 {value1} 之一', value1='、'.join(QUEUE_ACTIONS)))
    if action == "send":
        row = queued_row(connection, room_id, payload.get("id"))
        connection.execute("UPDATE queued_messages SET failure='' WHERE id=?", (row["id"],))
        result = post_item(connection, room_id, row, post)
        if not result:
            raise ValueError(connection.execute("SELECT failure FROM queued_messages WHERE id=?", (row["id"],)).fetchone()[0])
        message_id = result["message"]["id"] if result.get("message") else result.get("message_id")
        if message_id:
            interrupt(connection, room_id, message_id)
    elif action == "edit":
        edit_item(connection, queued_row(connection, room_id, payload.get("id")), payload.get("text"), check)
    elif action == "delete":
        connection.execute("DELETE FROM queued_messages WHERE id=?", (queued_row(connection, room_id, payload.get("id"))["id"],))
    elif action == "reorder":
        reorder(connection, room_id, payload.get("ids"))
    else:
        connection.execute("DELETE FROM queued_message_pauses WHERE room_id=?", (room_id,))
    drain(connection, room_id, post)
    return queue_view(connection, room_id)

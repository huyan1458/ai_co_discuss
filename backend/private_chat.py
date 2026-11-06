"""
Private chat: the owner talks to one room member directly, in the member's own session, outside the room's messages.

Each row of `private_chats` is one thing the owner said and the member's reply. While the member works on a room
execution that takes interjections, a new line goes in as an interjection of that execution; otherwise it waits until
the member is idle and the runner runs it as a turn of its own, taking the reply from the software's output. Only the
owner reads or writes chats; the runner, which holds the owner credential, reports their progress.
"""
import time

from .free_room import ACTIVE, add_interjection
from .runtime import begin_write, require_owner

MAX_CHAT_LENGTH = 4000
MAX_REPLY_LENGTH = 20000
MAX_REASON_LENGTH = 500
SHOWN_CHATS = 200
# Interjections made from a chat line carry its submission id under this prefix, so the two are found together.
INTERJECTION_PREFIX = "chat-"
# Runner reports and the owner's stop, each with the states it may leave.
TRANSITIONS = {"start": ("pending", "running"), "steered": ("pending", "interjected"), "reply": ("running", "answered"),
               "fail": (("pending", "running"), "failed"), "stop": (("pending", "running"), "stopped")}


def chat_member(connection, room_id, member_id):
    """The active member the runner wakes; a manual member is reached only in its own window."""
    member = connection.execute("SELECT * FROM room_members WHERE room_id=? AND id=? AND status='active'", (room_id, member_id)).fetchone()
    if not member:
        raise LookupError("成员不存在或已离开")
    if member["access"] != "runner":
        raise FileExistsError("这位成员是手动接入的，只能在它自己的窗口里对话")
    return member


def public_chat(connection, row):
    """One chat line as the page shows it; a line passed in as an interjection shows how that went."""
    chat = {key: row[key] for key in ("id", "member_id", "text", "status", "reply", "reason", "execution_id", "created_at", "updated_at")}
    if row["status"] == "interjected":
        interjection = connection.execute("""SELECT i.status,i.reason,e.status AS execution_status FROM execution_interjections i
            JOIN member_executions e ON e.id=i.execution_id WHERE i.room_id=? AND i.submission_id=?""",
                                          (row["room_id"], INTERJECTION_PREFIX + row["submission_id"])).fetchone()
        if interjection:
            ended = interjection["status"] == "pending" and interjection["execution_status"] not in ACTIVE
            chat["interjection"] = "failed" if ended else interjection["status"]
            chat["reason"] = "送达前那次执行已结束" if ended else interjection["reason"]
    return chat


def member_chat(connection, room_id, member_id, token, payload=None):
    """Read one member's private chat, or add the owner's next line to it."""
    require_owner(connection, room_id, token)
    if payload is None:
        chat_member(connection, room_id, member_id)
        rows = connection.execute("SELECT * FROM (SELECT * FROM private_chats WHERE room_id=? AND member_id=? ORDER BY id DESC LIMIT ?) ORDER BY id",
                                  (room_id, member_id, SHOWN_CHATS)).fetchall()
        return {"member_id": member_id, "chats": [public_chat(connection, row) for row in rows]}
    begin_write(connection)
    member = chat_member(connection, room_id, member_id)
    text, submission_id = payload.get("text"), payload.get("submission_id")
    if not isinstance(text, str) or not 0 < len(text.strip()) <= MAX_CHAT_LENGTH:
        raise ValueError(f"私聊内容须为 1–{MAX_CHAT_LENGTH} 字")
    if not isinstance(submission_id, str) or not 0 < len(submission_id) <= 100:
        raise ValueError("私聊须带 submission_id；重试沿用原编号")
    earlier = connection.execute("SELECT * FROM private_chats WHERE room_id=? AND submission_id=?", (room_id, submission_id)).fetchone()
    if earlier:
        if earlier["member_id"] != member_id or earlier["text"] != text:
            raise FileExistsError("submission_id 已用于另一句私聊")
        return public_chat(connection, earlier)
    now = int(time.time())
    # A room execution that takes interjections hears it now; one that cannot waits, like a turn already running.
    execution = connection.execute("""SELECT e.* FROM member_executions e JOIN execution_capabilities c ON c.execution_id=e.id
        WHERE e.member_id=? AND e.status IN ('dispatched','started') AND c.steer=1 ORDER BY e.id DESC LIMIT 1""", (member["id"],)).fetchone()
    status, execution_id = "pending", None
    if execution:
        add_interjection(connection, room_id, execution, {"text": text, "submission_id": INTERJECTION_PREFIX + submission_id}, now)
        status, execution_id = "interjected", execution["id"]
    cursor = connection.execute("""INSERT INTO private_chats (room_id,member_id,submission_id,text,status,execution_id,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?)""", (room_id, member_id, submission_id, text, status, execution_id, now, now))
    return public_chat(connection, connection.execute("SELECT * FROM private_chats WHERE id=?", (cursor.lastrowid,)).fetchone())


def chat_action(connection, room_id, chat_id, token, payload):
    """The runner's progress on one chat line (start, steered, reply, fail), or the owner's stop."""
    require_owner(connection, room_id, token)
    begin_write(connection)
    action = payload.get("action")
    if action not in TRANSITIONS:
        raise ValueError(f"action 须为 {'、'.join(TRANSITIONS)}")
    row = connection.execute("SELECT * FROM private_chats WHERE room_id=? AND id=?", (room_id, chat_id)).fetchone()
    if not row:
        raise LookupError("私聊不存在")
    allowed, target = TRANSITIONS[action]
    if row["status"] == target:
        return public_chat(connection, row)
    if row["status"] not in (allowed if isinstance(allowed, tuple) else (allowed,)):
        raise FileExistsError(f"这句私聊当前为 {row['status']}，不能 {action}")
    reply, reason = payload.get("text", ""), payload.get("reason", "")
    if not isinstance(reply, str) or len(reply) > MAX_REPLY_LENGTH or not isinstance(reason, str) or len(reason) > MAX_REASON_LENGTH:
        raise ValueError(f"text 最多 {MAX_REPLY_LENGTH} 字，reason 最多 {MAX_REASON_LENGTH} 字")
    connection.execute("UPDATE private_chats SET status=?,reply=?,reason=?,updated_at=? WHERE id=?",
                       (target, reply if action == "reply" else row["reply"], reason, int(time.time()), chat_id))
    return public_chat(connection, connection.execute("SELECT * FROM private_chats WHERE id=?", (chat_id,)).fetchone())


def open_chats(connection, member_id):
    """The lines the runner still has to run or is running for one member, in order."""
    return [dict(row) for row in connection.execute(
        "SELECT id,text,status FROM private_chats WHERE member_id=? AND status IN ('pending','running') ORDER BY id", (member_id,))]

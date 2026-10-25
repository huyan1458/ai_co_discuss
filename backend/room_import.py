"""Import one room backup as a new, owner-controlled room on this site.

The room keeps its ID, so importing the same backup twice is skipped. Message, turn, member and
request IDs are renumbered after this database's current maximum, and `#ID` references in texts
follow the messages. Rows are written in an order that keeps the floor, turn and runtime triggers
from treating history as new activity; the room arrives without a run, its brainstorm phase paused
and its members away, so the owner invites them back with new credentials.
"""

import hashlib
import json
import re
import sqlite3
import uuid

from .runtime import begin_write, require_owner, token_hash

BACKUP_FORMAT = "ai-codiscuss-room-backup"
ROOM_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
REFERENCE = re.compile(r"#(\d+)")
# "reviewing" only appears in backups made before that phase was retired; it imports like discussing.
ACTIVE_PHASES = ("initial", "discussing", "reviewing")
OPEN_REQUESTS = ("pending", "delivering")
LIMIT_FIELDS = ("max_rounds", "max_minutes", "execution_minutes", "on_limit", "summary_minutes",
                "started_at", "closing_at", "stop_reason", "revision")
# Tables whose integer IDs are renumbered, with the backup table that holds their rows.
RENUMBERED = {"messages": "messages", "discussion_turns": "discussion_turns",
              "room_members": "room_members", "member_requests": "member_requests"}


def backup_tables(backup):
    """Validate the backup envelope and return its tables and the single room row."""
    if not isinstance(backup, dict) or backup.get("format") != BACKUP_FORMAT or backup.get("version") != 1:
        raise ValueError("不是可导入的房间备份（需要 ai-codiscuss-room-backup 第 1 版）")
    tables = backup.get("tables")
    if not isinstance(tables, dict) or not isinstance(tables.get("rooms"), list) or len(tables["rooms"]) != 1:
        raise ValueError("备份须恰好包含一个房间")
    for name, rows in tables.items():
        if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
            raise ValueError(f"备份表 {name} 格式无效")
    room = tables["rooms"][0]
    if not isinstance(room.get("id"), str) or not ROOM_ID_PATTERN.match(room["id"]):
        raise ValueError("备份中的房间编号无效")
    return tables, room


def id_maps(tables, bases):
    """Number each renumbered table's rows after the target's current maximum, in backup order; files get new IDs."""
    maps = {table: {row["id"]: bases[table] + index for index, row in enumerate(tables.get(source, []), 1)}
            for table, source in RENUMBERED.items()}
    maps["attachments"] = {row["id"]: uuid.uuid4().hex for row in tables.get("attachments", [])}
    return maps


def remap_text(value, messages):
    """Point `#ID` references at the renumbered messages; other numbers stay as written."""
    return REFERENCE.sub(lambda match: f"#{messages[int(match[1])]}" if int(match[1]) in messages else match[0], value or "")


def remap_until(value, messages):
    """Map a "covers messages up to ID" mark to the last renumbered message it covered."""
    return max((new for old, new in messages.items() if old <= (value or 0)), default=0)


def room_statements(tables, room, maps, control_hash):
    """Room, directory, folder and a temporary free mode so history needs no speaking floor."""
    messages, room_id = maps["messages"], room["id"]
    directory = (tables.get("room_directory") or [{}])[0]
    statements = [("INSERT INTO rooms (id,title,goal,state_text,state_until,created_at) VALUES (?,?,?,?,?,?)",
                   (room_id, room["title"], remap_text(room["goal"], messages), remap_text(room.get("state_text"), messages),
                    remap_until(room.get("state_until"), messages), room["created_at"])),
                  ("UPDATE room_directory SET archived=? WHERE room_id=?", (int(bool(directory.get("archived"))), room_id)),
                  ("INSERT INTO room_modes (room_id,mode,control_hash) VALUES (?,'free',?)", (room_id, control_hash))]
    for folder in tables.get("topic_folders", [])[:1]:
        statements += [("""INSERT INTO topic_folders (id,name,position) SELECT ?,?,COALESCE(MAX(position),0)+1 FROM topic_folders
                           WHERE NOT EXISTS (SELECT 1 FROM topic_folders WHERE id=?)""", (folder["id"], folder["name"], folder["id"])),
                       ("UPDATE room_folder_assignments SET folder_id=? WHERE room_id=?", (folder["id"], room_id))]
    return statements


def member_statements(tables, room_id, maps):
    """Members arrive away with unusable credential hashes; removed members stay removed."""
    experts = json.loads((tables.get("topic_settings") or [{"experts": "{}"}])[0]["experts"])
    statements = []
    for member in tables.get("room_members", []):
        access = member.get("access") or ("online" if experts.get(member["name"]) == "online" else "manual")
        statements.append(("""INSERT INTO room_members (id,room_id,name,adapter,role,status,token_hash,read_until,created_at,access,session_mode)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)""", (maps["room_members"][member["id"]], room_id, member["name"], member.get("adapter", ""),
                                                member.get("role", "member"), "removed" if member.get("status") == "removed" else "away",
                                                uuid.uuid4().hex * 2, remap_until(member.get("read_until"), maps["messages"]),
                                                member["created_at"], access, member.get("session_mode") or "new")))
    return statements


def history_statements(tables, room_id, maps):
    """Messages and turns as queued placeholders, then their real kinds, links and statuses."""
    messages, turns = maps["messages"], maps["discussion_turns"]
    details = {row["message_id"]: row for row in tables.get("message_details", [])}
    statements = [("INSERT INTO messages (id,room_id,author,text,reply_to,source,submission_id,created_at) VALUES (?,?,?,?,?,?,?,?)",
                   (messages[row["id"]], room_id, row["author"], remap_text(row["text"], messages), messages.get(row.get("reply_to")),
                    row["source"], row["submission_id"], row["created_at"])) for row in tables.get("messages", [])]
    statements += [("""INSERT INTO discussion_turns (id,room_id,expert,question,status,submission_id,created_at,notified_at,answer_id)
                       VALUES (?,?,?,?,'queued',?,?,?,?)""", (turns[row["id"]], room_id, row["expert"], remap_text(row["question"], messages),
                                                             row["submission_id"], row["created_at"], row.get("notified_at", ""),
                                                             messages.get(row.get("answer_id")))) for row in tables.get("discussion_turns", [])]
    for old, row in details.items():
        statements += [("INSERT INTO message_details (message_id,kind,submitted_by) VALUES (?,'import',?)", (messages[old], row["submitted_by"])),
                       ("UPDATE message_details SET kind=?,turn_id=? WHERE message_id=?", (row["kind"], turns.get(row.get("turn_id")), messages[old]))]
    # A held relay stops an answered turn from promoting the next queued one; open turns are restored last.
    statements.append(("INSERT INTO turn_relay (room_id,held_since) VALUES (?,1) ON CONFLICT(room_id) DO UPDATE SET held_since=1", (room_id,)))
    order = {"notified": 1, "pending": 2}
    for row in sorted(tables.get("discussion_turns", []), key=lambda turn: order.get(turn["status"], 0)):
        if row["status"] != "queued":
            statements.append(("UPDATE discussion_turns SET status=? WHERE id=?", (row["status"], turns[row["id"]])))
    return statements


def settings_statements(tables, room, maps, now):
    """Topic, limits and idle clock (a backup's retired speaking floor is ignored); an active brainstorm arrives paused because it has no run."""
    room_id, messages, statements = room["id"], maps["messages"], []
    free = any(row.get("mode") == "free" for row in tables.get("room_modes", []))
    for row in tables.get("topic_settings", [])[:1]:
        phase = "paused" if not free and row["phase"] in ACTIVE_PHASES else row["phase"]
        statements += [("INSERT INTO topic_settings (room_id,host,background,boundaries,experts,phase,focus) VALUES (?,?,?,?,?,?,?)",
                        (room_id, row["host"], remap_text(row.get("background"), messages), remap_text(row.get("boundaries"), messages),
                         row["experts"], phase, remap_text(row.get("focus"), messages))),
                       ("INSERT INTO discussion_pauses (room_id,paused_at) VALUES (?,?)",
                        (room_id, 0 if phase in ACTIVE_PHASES else now))]
    for row in tables.get("discussion_limits", [])[:1]:
        statements.append((f"UPDATE discussion_limits SET {','.join(f'{field}=?' for field in LIMIT_FIELDS)} WHERE room_id=?",
                           (*(row[field] for field in LIMIT_FIELDS), room_id)))
    for row in tables.get("room_user_requests", [])[:1]:
        statements.append(("INSERT INTO room_user_requests (room_id,text) VALUES (?,?)", (room_id, remap_text(row["text"], messages))))
    for row in tables.get("room_briefs", [])[:1]:
        statements.append(("INSERT INTO room_briefs (room_id,text,until,updated_at) VALUES (?,?,?,?)",
                           (room_id, remap_text(row["text"], messages), remap_until(row["until"], messages), row["updated_at"])))
    for row in tables.get("discussion_options", [])[:1]:
        statements.append(("INSERT INTO discussion_options (room_id,named_followup) VALUES (?,?)", (room_id, row["named_followup"])))
    for row in tables.get("round_budgets", [])[:1]:
        statements.append(("INSERT INTO round_budgets (room_id,base,cap,extra) VALUES (?,?,?,?)", (room_id, row["base"], row["cap"], row["extra"])))
    for row in tables.get("scheduler_decisions", []):
        statements.append(("""INSERT INTO scheduler_decisions (room_id,after_message_id,kind,label,confidence,applied,provider,created_at)
                       VALUES (?,?,?,?,?,?,?,?)""", (room_id, messages.get(row["after_message_id"], 0), row["kind"], row["label"],
                                                     row.get("confidence"), row["applied"], row["provider"], row["created_at"])))
        if row.get("feedback"):
            statements.append(("""INSERT INTO scheduler_feedback (decision_id,rating,should_be,note,created_at) VALUES (last_insert_rowid(),?,?,?,?)""",
                               (row["feedback"], row.get("should_be", ""), row.get("note", ""), row["created_at"])))
        if row.get("context"):
            statements.append(("INSERT INTO scheduler_decision_context (decision_id,context) SELECT id,? FROM scheduler_decisions WHERE room_id=? ORDER BY id DESC LIMIT 1",
                               (row["context"], room_id)))
    return statements


def record_statements(tables, room_id, maps):
    """Summaries, timings, attachment records and free-room requests attached to renumbered rows."""
    messages, members, requests = maps["messages"], maps["room_members"], maps["member_requests"]
    statements = [("INSERT INTO message_summaries (message_id,text,author) VALUES (?,?,?)",
                   (messages[row["message_id"]], remap_text(row["text"], messages), row["author"])) for row in tables.get("message_summaries", [])]
    statements += [("INSERT INTO message_timings (message_id,elapsed_seconds) VALUES (?,?)", (messages[row["message_id"]], row["elapsed_seconds"]))
                   for row in tables.get("message_timings", [])]
    statements += [("""INSERT INTO attachments (id,room_id,message_id,position,file_name,content_type,size,sha256,actor,submission_id,created_at)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?)""", (maps["attachments"][row["id"]], room_id, messages[row["message_id"]], row["position"], row["file_name"],
                                                           row["content_type"], row["size"], row["sha256"], row["actor"], row["submission_id"],
                                                           row["created_at"])) for row in tables.get("attachments", [])]
    statements += [("""INSERT INTO member_requests (id,room_id,member_id,message_id,status,answer_id,created_at,chain_id,batch_id,purpose,created_by)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?)""", (requests[row["id"]], room_id, members[row["member_id"]], messages[row["message_id"]],
                                                           "cancelled" if row["status"] in OPEN_REQUESTS else row["status"],
                                                           messages.get(row.get("answer_id")), row["created_at"], row.get("chain_id", 0),
                                                           row.get("batch_id", 0), row.get("purpose", "ask"), row.get("created_by", "user")))
                   for row in tables.get("member_requests", [])]
    statements += [("INSERT INTO member_suggestions (message_id,member_id) VALUES (?,?)", (messages[row["message_id"]], members[row["member_id"]]))
                   for row in tables.get("member_suggestions", [])]
    # Imported recommendations are history only: an open or waiting one no longer acts.
    statements += [("""INSERT INTO member_recommendations (message_id,room_id,member_id,provider,confidence,created_at,expires_at,status,mode)
                       VALUES (?,?,?,?,?,?,?,?,?)""", (messages[row["message_id"]], room_id, members[row["member_id"]], row["provider"], row["confidence"],
                                                       row["created_at"], row["expires_at"], "adopted" if row["status"] == "adopted" else "open", row.get("mode", "")))
                   for row in tables.get("member_recommendations", [])]
    return statements


def import_statements(tables, room, maps, control_hash, now):
    """Build the ordered writes that recreate one backup; the D1 adapter builds the same sequence."""
    mode = next((row["mode"] for row in tables.get("room_modes", [])), "brainstorm")
    return [*room_statements(tables, room, maps, control_hash), *member_statements(tables, room["id"], maps),
            *history_statements(tables, room["id"], maps), *settings_statements(tables, room, maps, now),
            *record_statements(tables, room["id"], maps),
            ("UPDATE room_modes SET mode=? WHERE room_id=?", (mode, room["id"])),
            ("DELETE FROM turn_relay WHERE room_id=?", (room["id"],))]


def import_room(connection, backup, control_token, now):
    """Recreate a backup under the importer's control credential, or skip a room that already exists.

    Args:
        connection: SQLite connection; the caller commits.
        backup: The `完整数据.json` object of one room backup.
        control_token: The importer's new room control credential.
        now: Current Unix seconds, used to start the idle clock of a paused room.

    Returns:
        `{"id", "title", "imported": True, "attachments": {backup ID: new ID}}`, or `{"id", "title", "skipped": True}` when the room exists.
    """
    control_hash = token_hash(control_token)
    if not control_hash:
        raise ValueError("导入须提供 32–256 字符的房间控制凭据")
    tables, room = backup_tables(backup)
    begin_write(connection)
    if connection.execute("SELECT 1 FROM rooms WHERE id=?", (room["id"],)).fetchone():
        return {"id": room["id"], "title": room["title"], "skipped": True}
    bases = {table: connection.execute(f"SELECT COALESCE(MAX(id),0) FROM {table}").fetchone()[0] for table in RENUMBERED}
    maps = id_maps(tables, bases)
    try:
        for sql, params in import_statements(tables, room, maps, control_hash, now):
            connection.execute(sql, params)
    except (KeyError, sqlite3.Error) as error:
        raise ValueError(f"备份内容不完整或与本站数据冲突，未导入：{error}") from error
    return {"id": room["id"], "title": room["title"], "imported": True,
            "attachments": maps["attachments"]}


def imported_attachment(connection, room_id, attachment_id, token, data):
    """Return an imported attachment record once the owner's uploaded bytes match it exactly."""
    require_owner(connection, room_id, token)
    row = connection.execute("SELECT * FROM attachments WHERE room_id=? AND id=?", (room_id, attachment_id)).fetchone()
    if row is None:
        raise LookupError("附件不存在")
    if len(data) != row["size"] or hashlib.sha256(data).hexdigest() != row["sha256"]:
        raise ValueError("附件内容与备份记录不一致")
    return dict(row)

"""Import one room backup as a new, owner-controlled room on this site.

The room keeps its ID, so importing the same backup twice is skipped. Message, turn, member,
request, session and session-request IDs are renumbered after this database's current maximum.
Imported discussions are historical, concluded sessions; active work and credentials are never
restored.
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
VERSION_2_TABLES = ("discussion_sessions", "discussion_conclusions", "session_requests", "task_message_sources",
                    "session_state", "session_limits", "session_round_budgets", "session_options", "session_pauses")
# Tables whose integer IDs are renumbered, with the backup table that holds their rows.
RENUMBERED = {"messages": "messages", "discussion_turns": "discussion_turns",
              "room_members": "room_members", "member_requests": "member_requests",
              "discussion_sessions": "discussion_sessions", "session_requests": "session_requests"}


def backup_tables(backup):
    """Validate the backup envelope and return its tables and the single room row."""
    if (not isinstance(backup, dict) or backup.get("format") != BACKUP_FORMAT
            or backup.get("version") not in (1, 2)):
        raise ValueError("不是可导入的房间备份（需要 ai-codiscuss-room-backup 第 1 或第 2 版）")
    tables = backup.get("tables")
    if not isinstance(tables, dict) or not isinstance(tables.get("rooms"), list) or len(tables["rooms"]) != 1:
        raise ValueError("备份须恰好包含一个房间")
    if backup["version"] == 2 and any(name not in tables for name in VERSION_2_TABLES):
        raise ValueError("第 2 版备份缺少讨论会话历史表，拒绝静默丢弃新字段")
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
    """Room, directory and a temporary free mode so history needs no speaking floor; the room arrives unfiled."""
    messages, room_id = maps["messages"], room["id"]
    directory = (tables.get("room_directory") or [{}])[0]
    statements = [("INSERT INTO rooms (id,title,goal,state_text,state_until,created_at) VALUES (?,?,?,?,?,?)",
                   (room_id, room["title"], remap_text(room["goal"], messages), remap_text(room.get("state_text"), messages),
                    remap_until(room.get("state_until"), messages), room["created_at"])),
                  ("UPDATE room_directory SET archived=? WHERE room_id=?", (int(bool(directory.get("archived"))), room_id)),
                  ("INSERT INTO room_modes (room_id,mode,control_hash) VALUES (?,'free',?)", (room_id, control_hash))]
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
    # Keep active rows queued until the other active row is restored, preserving the legacy unique index.
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
                                                           messages.get(row.get("answer_id")), row["created_at"],
                                                           messages.get(row.get("chain_id"), 0), messages.get(row.get("batch_id"), 0),
                                                           row.get("purpose", "ask"), row.get("created_by", "user")))
                   for row in tables.get("member_requests", [])]
    statements += [("INSERT INTO member_suggestions (message_id,member_id) VALUES (?,?)", (messages[row["message_id"]], members[row["member_id"]]))
                   for row in tables.get("member_suggestions", [])]
    statements += [("INSERT INTO message_withdrawals (message_id,kind,created_at) VALUES (?,?,?)", (messages[row["message_id"]], row["kind"], row["created_at"]))
                   for row in tables.get("message_withdrawals", [])]
    # Imported recommendations are history only: an open or waiting one no longer acts.
    statements += [("""INSERT INTO member_recommendations (message_id,room_id,member_id,provider,confidence,created_at,expires_at,status,mode)
                       VALUES (?,?,?,?,?,?,?,?,?)""", (messages[row["message_id"]], room_id, members[row["member_id"]], row["provider"], row["confidence"],
                                                       row["created_at"], row["expires_at"], "adopted" if row["status"] == "adopted" else "open", row.get("mode", "")))
                   for row in tables.get("member_recommendations", [])]
    statements += [("""INSERT INTO review_plans(room_id,batch_id,chain_id,host_id,reviewer_id,reviewer_name,
        config_version,member_revision,scope,implementers,status,review_batch_id) VALUES(?,?,?,?,?,?,'','',?,?,'imported',?)""",
        (room_id, messages[row["batch_id"]], messages.get(row["chain_id"], 0), members[row["host_id"]],
         members[row["reviewer_id"]], row["reviewer_name"], row["scope"], row["implementers"], messages.get(row.get("review_batch_id"))))
        for row in tables.get("review_plans", [])]
    return statements


def session_statements(tables, room_id, maps):
    """Restore session history and its provenance without restoring active work."""
    messages = maps["messages"]
    sessions = maps["discussion_sessions"]
    requests = maps["session_requests"]
    members = maps["room_members"]
    member_requests = maps["member_requests"]
    task_messages = {row["message_id"] for row in tables.get("task_message_sources", [])}
    task_messages.update(row["review_batch_id"] for row in tables.get("review_plans", []) if row.get("review_batch_id"))
    latest_visible_message = max((new for old, new in messages.items() if old not in task_messages), default=0)
    statements = []
    for row in tables.get("discussion_sessions", []):
        active = row["status"] in ("active", "paused")
        statements.append(("""INSERT INTO discussion_sessions
            (id,room_id,goal,status,started_message_id,ended_message_id,created_at)
            VALUES (?,?,?,?,?,?,?)""", (sessions[row["id"]], room_id, remap_text(row["goal"], messages),
                                          "concluded" if active else row["status"],
                                          remap_until(row.get("started_message_id"), messages),
                                          latest_visible_message if active else remap_until(row.get("ended_message_id"), messages),
                                          row["created_at"])))
    statements += [("""INSERT INTO discussion_conclusions
        (session_id,room_id,stop_reason,max_rounds,max_minutes,brief,state,state_until,concluded_at)
        VALUES (?,?,?,?,?,?,?,?,?)""", (sessions[row["session_id"]], room_id, row["stop_reason"],
                                           row["max_rounds"], row["max_minutes"], remap_text(row["brief"], messages),
                                           remap_text(row["state"], messages), remap_until(row["state_until"], messages),
                                           row["concluded_at"])) for row in tables.get("discussion_conclusions", [])]
    for name, fields in (("session_state", ("phase", "revision")),
                         ("session_limits", ("max_rounds", "max_minutes", "execution_minutes", "started_at", "stop_reason", "revision")),
                         ("session_round_budgets", ("base", "cap", "extra")),
                         ("session_pauses", ("paused_at", "paused_seconds")),
                         ("session_options", ("named_followup",))):
        columns = ("session_id", *fields)
        statements += [(f"INSERT INTO {name} ({','.join(columns)}) VALUES ({','.join('?' for _ in columns)})",
                        (sessions[row["session_id"]], *(row[field] for field in fields)))
                       for row in tables.get(name, [])]
    for row in tables.get("session_state", []):
        statements.append(("UPDATE session_state SET read_until=?,held_since=? WHERE session_id=?",
                           (remap_until(row["read_until"], messages), remap_until(row["held_since"], messages),
                            sessions[row["session_id"]])))
    statements += [("""INSERT INTO session_requests
        (id,session_id,round,position,member_id,purpose,question,status,member_request_id,submission_id,read_until,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""", (requests[row["id"]], sessions[row["session_id"]], row["round"], row["position"],
                                                members[row["member_id"]], row["purpose"], remap_text(row["question"], messages),
                                                "cancelled" if row["status"] in ("queued", "open") else row["status"],
                                                member_requests.get(row.get("member_request_id")), row["submission_id"],
                                                None if row.get("read_until") is None else remap_until(row["read_until"], messages),
                                                row["created_at"])) for row in tables.get("session_requests", [])]
    statements += [("""INSERT INTO task_message_sources
        (message_id,session_id,session_request_id,cause_kind,cause_message_id,cause_request_id)
        VALUES (?,?,?,?,?,?)""", (messages[row["message_id"]], sessions[row["session_id"]],
                                   requests[row["session_request_id"]], row["cause_kind"],
                                   messages.get(row.get("cause_message_id")),
                                   member_requests.get(row.get("cause_request_id"))))
                   for row in tables.get("task_message_sources", [])]
    return statements


def import_statements(tables, room, maps, control_hash, now):
    """Build the ordered writes that recreate one backup; the D1 adapter builds the same sequence."""
    return [*room_statements(tables, room, maps, control_hash), *member_statements(tables, room["id"], maps),
            *history_statements(tables, room["id"], maps), *settings_statements(tables, room, maps, now),
            *record_statements(tables, room["id"], maps),
            *session_statements(tables, room["id"], maps),
            ]


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

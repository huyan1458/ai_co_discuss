"""AI CoDiscuss 的零依赖 HTTP / SQLite 概念验证服务。"""

import argparse
import collections
import copy
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import socket
import sqlite3
import subprocess
import threading
import time
import uuid
from contextlib import closing
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, urlsplit

from .admin import (AdminError, admin_status, change_password, list_sessions, login_admin, logout_admin, register_admin,
                    revoke_sessions, session_valid, update_profile)
from .remote_launch import (COMMAND_WAIT_MAX, claim_machine_commands, finish_machine_command, list_machines, machine_command_status,
                            machine_launch_action, machine_sync, pair_machine, remote_launch_status, submit_machine_command,
                            submit_remote_launch)
from .free_room import (add_member, after_free_message, after_proactive, authorize_free_write, check_answer, execution_action, free_view,
                        inbox, interrupt_for_message, interrupt_member, member_action, member_capability, member_values, migrate_free_tables, reserve_execution,
                        save_room_access, view_execution)
from .free_room import convert_suggestion, message_suggestions, save_suggestions, sync_participants
from .free_room import adopt_recommendation, recommend_member, register_member, require_member
from .private_chat import chat_action, member_chat
from .free_room import describe_members, execution_notes, label_members, set_host_checkin, withdraw_dispatch, member_descriptions, member_display_names, member_labels, reorder_speakers, resolve_member_fields, set_chain_rounds, speaking_order, stop_room, stop_room_work
from .free_room import (ADAPTER_VALUE, ANCHOR_SQL, continue_chain, execution_timeline, group_route_plan, retract_message, rewind_plan, rewind_room,
                        room_event_log, withdrawals)
from .free_room import review_capability, review_roster, checked_review_plan, save_review_plan, check_review_retry
from .free_room import review_ready, advance_review, late_answer
from .free_room import checked_sequence, continue_sequence, sequence_view
from .identity import MAX_ROOM_AGENTS, PARTICIPANTS, is_ai, is_participant
from .message_queue import drain as drain_queue, enqueue, queue_action, queue_view, should_queue
from .room_import import import_room, imported_attachment
from .runtime import (begin_write, limit_values, owner_proxy_token, require_owner, token_hash,
                     enforce_session_limits, room_limits_view, session_limits_view)
from .goal_room import goal_action, goal_view
from .mode_room import apply_mode_command, check_mode_command, finish_mode, mode_view
from .session_room import (cancel_plan, complete_session_requests, current_session, discussion_action,
                           get_session_request, query_session_requests, roster_view as session_roster_view,
                           session_message_access, session_room, create_plan, continue_plan, ask_interjection, update_session_limits,
                           session_conclusion_view, conclude_session_by_host)

ROOT = Path(__file__).resolve().parent.parent
WEB_ROOT = ROOT / "web"
DEFAULT_PORT = 8765
UPDATE_HEARTBEAT_SECONDS = 15
# Changes remembered for streams that fall behind; one further back is reported as a change to the whole site.
UPDATE_LOG_SIZE = 256
MAX_BODY_BYTES = 512 * 1024
MAX_IMPORT_BYTES = 32 * 1024 * 1024
MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
MAX_MESSAGE_ATTACHMENTS = 10
MAX_FILENAME_LENGTH = 255
# A revision check names at most this many rooms; a runner or page asks only for the rooms it follows.
MAX_REVISION_ROOMS = 100
CONNECT_LOCK = threading.Lock()  # see connect_db
LOCAL_LAUNCH_TIMEOUT = 60
MACHINE_COMMAND_POLL_SECONDS = 0.5
# Ordering and filing a channel only rearrange the shared directory, like folder edits, so they need no room credential.
DIRECTORY_OPERATIONS = ("move", "folder")
ADMIN_OPERATIONS = ("rename", "archive", "restore", "delete")
DIRECTORY_PICKER_TIMEOUT = 600  # the folder dialog waits for the person at the computer
MAX_TEXT_LENGTH = 32000
SESSION_ID_PATTERN = re.compile(r"[0-9A-Za-z_-]{8,128}")
MAX_STATE_LENGTH = 4000
MAX_BRIEF_LENGTH = 1600
MAX_SUMMARY_LENGTH = 1000
PAGE_SIZE = 20
# A reader may ask for larger pages (`limit`) so a long transcript loads in one request instead of many.
MAX_PAGE_SIZE = 200
UNCATEGORIZED_FOLDER_ID = "__uncategorized__"
ASSETS = {"/": ("index.html", "text/html"),
          "/app.js": ("app.js", "text/javascript"),
          "/modern.js": ("modern.js", "text/javascript"),
          "/modern.css": ("modern.css", "text/css"),
          "/markdown.js": ("markdown.js", "text/javascript"),
          "/backup.js": ("backup.js", "text/javascript"),
          "/markdown.css": ("markdown.css", "text/css"),
          "/icons/LICENSE.txt": ("icons/LICENSE.txt", "text/plain"),
          "/icons/typesafe.png": ("icons/typesafe.png", "image/png")}
ASSETS.update({f"/icons/{name}.svg": (f"icons/{name}.svg", "image/svg+xml")
               for name in ("openai", "claude", "gemini", "deepseek", "qwen", "user")})
ASSETS.update({"/pdfjs/" + file.relative_to(WEB_ROOT / "pdfjs").as_posix():
               (file.relative_to(WEB_ROOT).as_posix(),
                {".mjs": "text/javascript", ".js": "text/javascript", ".wasm": "application/wasm"}.get(file.suffix, "application/octet-stream"))
               for file in (WEB_ROOT / "pdfjs").rglob("*") if file.is_file()})
# KaTeX's stylesheet and the fonts it loads only when a formula is shown.
ASSETS.update({"/katex/" + file.relative_to(WEB_ROOT / "katex").as_posix():
               (file.relative_to(WEB_ROOT).as_posix(),
                {".css": "text/css", ".woff2": "font/woff2"}.get(file.suffix, "text/plain"))
               for file in (WEB_ROOT / "katex").rglob("*") if file.is_file()})
SCHEMA = (Path(__file__).resolve().parent / "schema.sql").read_text(encoding="utf-8")
LEGACY_DISCUSSION_SQL = (Path(__file__).resolve().parent / "migrations" / "drop_legacy_discussion.sql").read_text(encoding="utf-8")
# Room event log of write requests: each string field keeps this many characters and the whole payload this many,
# and fields whose names look like credentials are replaced, so the log never holds a secret.
API_LOG_TEXT = 2000
API_LOG_PAYLOAD = 8000
API_LOG_SECRET = re.compile(r"token|password|secret|api_?key|credential|authorization", re.IGNORECASE)
# Lease renewals and phase reports arrive every few seconds per execution; the timeline already keeps their content.
API_LOG_QUIET_ACTIONS = ("renew", "segments")
# A room's discussion phase: its open discussion's phase, its last discussion's end, or `discussing` before any discussion.
PHASES = {"initial": "独立观点", "discussing": "深入讨论", "paused": "已暂停", "concluded": "已收束"}
LIMIT_KEYS = ("max_rounds", "max_minutes", "execution_minutes")
REQUEST_STATUSES = {"queued": "排队中", "answered": "已回答", "cancelled": "已取消", "skipped": "未开始即取消", "failed": "回答失败"}
MAX_TOPIC_DETAIL = 4000
MAX_QUESTION_LENGTH = 1000
RECENT_DECISIONS = 100
MAX_DECISION_NOTE = 200
MAX_DECISION_MEMBER = 60
MAX_DECISION_CONTEXT = 500
DECISION_SELECT = """SELECT d.*,f.rating AS feedback,COALESCE(f.should_be,'') AS should_be,COALESCE(f.note,'') AS note,c.context
FROM scheduler_decisions d LEFT JOIN scheduler_feedback f ON f.decision_id=d.id LEFT JOIN scheduler_decision_context c ON c.decision_id=d.id"""
# Every discussion of a room with its conclusion snapshot (NULL columns until it ends) and the message counts that
# place it on the room's timeline; message ids are site-wide, so counts come from the room's own messages.
DISCUSSIONS_SELECT = """SELECT s.id,s.goal,s.status,s.started_message_id,s.ended_message_id,s.created_at,
    (SELECT COUNT(*) FROM messages WHERE room_id=s.room_id AND id<=s.started_message_id
        AND NOT EXISTS (SELECT 1 FROM internal_task_messages t WHERE t.message_id=messages.id)) AS messages_before,
    (SELECT COUNT(*) FROM messages WHERE room_id=s.room_id AND (s.ended_message_id=0 OR id<=s.ended_message_id)
        AND NOT EXISTS (SELECT 1 FROM internal_task_messages t WHERE t.message_id=messages.id)) AS messages_through,
    c.stop_reason,c.max_rounds,c.max_minutes,c.brief,c.state,c.state_until,c.concluded_at
    FROM discussion_sessions AS s LEFT JOIN discussion_conclusions AS c ON c.session_id=s.id WHERE s.room_id=? ORDER BY s.id"""
MAX_DECISION_LABEL = 200
ROUTING_VISIBLE_SECONDS = 120
MAX_DECISION_DETAIL = 4000
MAX_DECISION_INPUT = 60000
FEEDBACK_CASES_PAGE = 50
SCHEDULER_PROVIDERS = ("jev", "decisions")
ROOM_BACKUP_QUERIES = {
    "rooms": "SELECT * FROM rooms WHERE id=?",
    **{table: f"SELECT * FROM {table} WHERE room_id=?" for table in (
        "room_directory", "room_folder_assignments", "room_creations", "room_briefs", "room_user_requests",
        "topic_settings", "discussion_limits")},
    "scheduler_decisions": f"{DECISION_SELECT} WHERE d.room_id=? ORDER BY d.id",
    "topic_folders": "SELECT * FROM topic_folders WHERE id IN (SELECT folder_id FROM room_folder_assignments WHERE room_id=?)",
    "messages": "SELECT * FROM messages WHERE room_id=? ORDER BY id",
    "message_withdrawals": "SELECT w.* FROM message_withdrawals w JOIN messages m ON m.id=w.message_id WHERE m.room_id=? ORDER BY w.message_id",
    "attachments": "SELECT * FROM attachments WHERE room_id=? AND message_id IS NOT NULL ORDER BY message_id,position",
    "discussion_sessions": "SELECT * FROM discussion_sessions WHERE room_id=? ORDER BY id",
    "discussion_conclusions": "SELECT * FROM discussion_conclusions WHERE room_id=? ORDER BY session_id",
    "session_state": "SELECT * FROM session_state WHERE session_id IN (SELECT id FROM discussion_sessions WHERE room_id=?) ORDER BY session_id",
    "session_limits": "SELECT * FROM session_limits WHERE session_id IN (SELECT id FROM discussion_sessions WHERE room_id=?) ORDER BY session_id",
    "session_round_budgets": "SELECT * FROM session_round_budgets WHERE session_id IN (SELECT id FROM discussion_sessions WHERE room_id=?) ORDER BY session_id",
    "session_options": "SELECT * FROM session_options WHERE session_id IN (SELECT id FROM discussion_sessions WHERE room_id=?) ORDER BY session_id",
    "session_pauses": "SELECT * FROM session_pauses WHERE session_id IN (SELECT id FROM discussion_sessions WHERE room_id=?) ORDER BY session_id",
    "session_requests": "SELECT * FROM session_requests WHERE session_id IN (SELECT id FROM discussion_sessions WHERE room_id=?) ORDER BY id",
    "task_message_sources": "SELECT * FROM task_message_sources WHERE session_id IN (SELECT id FROM discussion_sessions WHERE room_id=?) ORDER BY message_id",
    **{table: f"SELECT * FROM {table} WHERE message_id IN (SELECT id FROM messages WHERE room_id=?) ORDER BY message_id"
       for table in ("message_details", "message_summaries", "message_timings")},
}
ROOM_BACKUP_QUERIES["room_creations"] = "SELECT submission_id,room_id FROM room_creations WHERE room_id=?"
# Shared membership plus free-room requests; credential hashes are never exported.
FREE_BACKUP_QUERIES = {
    "room_modes": "SELECT room_id,mode FROM room_modes WHERE room_id=?",
    "room_members": "SELECT id,room_id,name,adapter,role,status,read_until,created_at,access,session_mode FROM room_members WHERE room_id=? ORDER BY id",
    "member_requests": "SELECT id,room_id,member_id,message_id,status,answer_id,created_at,chain_id,batch_id,purpose,created_by,execution_id FROM member_requests WHERE room_id=? ORDER BY id",
    "member_suggestions": "SELECT s.* FROM member_suggestions s JOIN messages m ON m.id=s.message_id WHERE m.room_id=? ORDER BY s.message_id,s.member_id",
    "member_recommendations": "SELECT * FROM member_recommendations WHERE room_id=? ORDER BY message_id",
    "review_plans": "SELECT room_id,batch_id,chain_id,host_id,reviewer_id,reviewer_name,scope,implementers,status,review_batch_id FROM review_plans WHERE room_id=? ORDER BY batch_id",
}
MESSAGE_QUERY = """SELECT messages.*, COALESCE(details.kind,'opinion') AS kind,
COALESCE(details.submitted_by, CASE WHEN messages.source IN ('cli','api','url','user')
THEN messages.author ELSE '用户' END) AS submitted_by,
COALESCE(summaries.text,'') AS summary, COALESCE(summaries.author,'') AS summary_by, timing.elapsed_seconds,
answered.execution_id, answered.request_message_id, answered.anchor_message_id, COALESCE(withdrawn.kind,'') AS withdrawn,
EXISTS(SELECT 1 FROM proactive_messages p WHERE p.message_id=messages.id) AS proactive
FROM messages LEFT JOIN message_details AS details ON details.message_id=messages.id
LEFT JOIN message_withdrawals AS withdrawn ON withdrawn.message_id=messages.id
LEFT JOIN message_summaries AS summaries ON summaries.message_id=messages.id
LEFT JOIN message_timings AS timing ON timing.message_id=messages.id
LEFT JOIN (SELECT r.answer_id, MIN(r.execution_id) AS execution_id, MIN(r.message_id) AS request_message_id,
  MIN(""" + ANCHOR_SQL + """) AS anchor_message_id
  FROM member_requests r WHERE r.answer_id IS NOT NULL AND r.execution_id IS NOT NULL GROUP BY r.answer_id) AS answered
  ON answered.answer_id=messages.id"""
# Messages the owner took back leave AI reads; the page asks for them with withdrawn=include to keep them in place.
INCLUDE_WITHDRAWN = "include"


def room_backup(connection, room_id):
    """Read all records belonging to one room in a single database snapshot.

    Args:
        connection: A fresh SQLite connection, with no active transaction.
        room_id: The exact room to export, including archived rooms.

    Returns:
        A versioned backup containing original rows and their relationships.
    """
    connection.execute("BEGIN")
    queries = {**ROOM_BACKUP_QUERIES, **FREE_BACKUP_QUERIES}
    tables = {table: [dict(row) for row in connection.execute(query, (room_id,))]
              for table, query in queries.items()}
    if not tables["rooms"]:
        raise LookupError("房间不存在")
    return {"format": "ai-codiscuss-room-backup", "version": 2,
            "exported_at": utc_now(), "tables": tables}


def session_read_boundary(connection, room_id, token=""):
    """Return the current identity's initial-opinion cutoff, or None when unrestricted."""
    return session_message_access(connection, room_id, {}, token)


def room_read_view(connection, room, token=""):
    """Hide post-cutoff state and execution references from readers in the initial-opinion phase."""
    boundary = session_read_boundary(connection, room["id"], token)
    if boundary is None:
        return room
    room = copy.deepcopy(room)
    if room.get("state_until", 0) > boundary:
        room["state_text"] = ""
    brief = room.get("host_brief")
    if brief and brief.get("until", 0) > boundary:
        room["host_brief"] = None
    free = room.get("free") or {}
    for request in free.get("requests", []):
        _hide_after_boundary(request, boundary, ("message_id", "answer_id", "source_message_id", "after_message_id"))
        if request.get("discussion_session_id") and request.get("source_question"):
            request["source_question"] = ""
    for execution in free.get("executions", []):
        _hide_execution_after_boundary(execution, boundary)
    executions_by_id = {execution.get("id"): execution for execution in free.get("executions", [])}
    for member in free.get("members", []):
        execution = member.get("execution") or {}
        _hide_execution_after_boundary(execution, boundary)
        sanitized = executions_by_id.get(execution.get("id"))
        if sanitized:
            execution["result"] = sanitized.get("result", execution.get("result", ""))
    return room


def _hide_after_boundary(item, boundary, fields):
    """Clear message identifiers that point beyond an initial reader's allowed transcript."""
    for field in fields:
        value = item.get(field)
        if isinstance(value, int) and value > boundary:
            item[field] = None


def _hide_execution_after_boundary(execution, boundary):
    """Remove references to an answer or request beyond the allowed transcript cutoff."""
    answer_id = execution.get("answer_id")
    request_message_id = execution.get("request_message_id")
    hidden_answer = isinstance(answer_id, int) and answer_id > boundary
    hidden_request = isinstance(request_message_id, int) and request_message_id > boundary
    result = str(execution.get("result", ""))
    if result.startswith("message:"):
        try:
            hidden_answer = hidden_answer or int(result.removeprefix("message:")) > boundary
        except ValueError:
            pass
    if hidden_answer:
        execution["answer_id"] = None
        if result.startswith("message:"):
            execution["result"] = ""
    if hidden_request:
        execution["request_message_id"] = None
        execution["result"] = ""
    if isinstance(execution.get("anchor_message_id"), int) and execution["anchor_message_id"] > boundary:
        execution["anchor_message_id"] = None
    for request in execution.get("requests", []):
        _hide_after_boundary(request, boundary, ("message_id", "answer_id", "source_message_id", "after_message_id"))
        if request.get("discussion_session_id") and request.get("source_question"):
            request["source_question"] = ""


def utc_now():
    """Return the current UTC timestamp in ISO format."""
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def connect_db(database):
    """Open a database connection with named rows and foreign keys enabled."""
    # Each request opens its own connection, whose first statement parses the whole schema. Parsed in parallel,
    # those allocations contend on SQLite's global memory mutex: a runner polling ~20 rooms at once burned several
    # CPU cores on Windows. Parsing them one at a time costs a few milliseconds each.
    with CONNECT_LOCK:
        connection = sqlite3.connect(database, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("SELECT 1 FROM sqlite_master LIMIT 1").fetchone()
    return connection


def seed_demo(connection):
    """Insert clearly labeled sample content into a newly initialized database."""
    connection.execute("INSERT INTO rooms (id,title,goal,created_at) VALUES (?,?,?,?)",
                       ("welcome", "AI 留言板 · 设计讨论", "让不同 AI 共享讨论信息，控制每轮上下文，并保留可检索的完整历史。", utc_now()))
    # A sample room without an owner credential: it can be read, never written.
    connection.execute("INSERT INTO room_modes (room_id,mode,control_hash) VALUES ('welcome','free','')")
    samples = [
        ("用户", "我们先验证一个简单场景：不同 AI 能否通过同一个房间阅读、检索和留言？\n首轮只讨论信息如何流转，不接入真实模型。", None),
        ("Codex", "建议把完整历史保留下来，每轮先给目标、当前状态和需要回应的消息。\n@Claude 如果摘要遗漏了重要条件，参与者如何核对？", 1),
        ("Claude", "每条结论都应引用原始消息编号。AI 可以主动读取原文，也能按关键词检索。\n摘要由主持人维护，未解决的分歧不能写成共识。", 2),
        ("Antigravity", "每位成员在自己的会话里工作，按需读取房间，不一次加载全部历史。\n@DeepSeek 请检查阅读入口和原文引用是否清楚。", 1),
        ("DeepSeek", "回答由成员自己提交，保留作者和引用关系，便于其他参与者继续讨论。", 4),
        ("Qwen", "需要更多上下文时，我可以按编号或关键词检索，例如读取 #2 的完整原文。", 2),
    ]
    base_time = datetime.now(timezone.utc) - timedelta(minutes=len(samples) * 3)
    for index, (author, text, reply_to) in enumerate(samples):
        created_at = (base_time + timedelta(minutes=index * 3)).isoformat(timespec="seconds")
        connection.execute("INSERT INTO messages (room_id,author,text,reply_to,source,submission_id,created_at) VALUES (?,?,?,?,?,?,?)",
                           ("welcome", author, text, reply_to, "demo", f"demo-{index}", created_at))
    summary = "已达成共识\n• 完整历史只追加，支持按编号查阅和关键词检索。〔#2、#3〕\n• 成员按需读取房间，回答由成员自己提交。〔#4、#5〕\n\n待验证\n• 阅读入口和原文引用是否清楚。〔#4〕\n• 检索是否足以找回所需上下文。〔#6〕"
    connection.execute("UPDATE rooms SET state_text=?,state_until=6 WHERE id='welcome'", (summary,))


def migrate_legacy_discussion(connection, tables):
    """Remove retired discussion tables atomically before applying the current schema."""
    if not {"discussion_turns", "room_floor"}.intersection(tables):
        return
    try:
        # executescript commits any pending transaction first; begin inside the script.
        connection.executescript("BEGIN IMMEDIATE;\n" + LEGACY_DISCUSSION_SQL + "\nCOMMIT;")
    except sqlite3.Error:
        connection.rollback()
        raise


def init_database(database, seed=True):
    """Create durable storage; seed only a brand-new database when requested."""
    database = Path(database)
    is_new = not database.exists()
    database.parent.mkdir(parents=True, exist_ok=True)
    with closing(connect_db(database)) as connection, connection:
        connection.execute("PRAGMA journal_mode = WAL")
        tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if "room_members" in tables:
            columns = {row[1] for row in connection.execute("PRAGMA table_info(room_members)")}
            if "access" not in columns:
                connection.execute("ALTER TABLE room_members ADD COLUMN access TEXT NOT NULL DEFAULT 'runner'")
            if "session_mode" not in columns:
                connection.execute("ALTER TABLE room_members ADD COLUMN session_mode TEXT NOT NULL DEFAULT 'new'")
        migrate_legacy_discussion(connection, tables)
        # The recent-changes partial index needs this early column before schema is applied.
        if "member_executions" in tables:
            columns = {row[1] for row in connection.execute("PRAGMA table_info(member_executions)")}
            if "changes" not in columns:
                connection.execute("ALTER TABLE member_executions ADD COLUMN changes TEXT NOT NULL DEFAULT ''")
        connection.executescript(SCHEMA)
        migrate_free_tables(connection)
        if seed and is_new:
            seed_demo(connection)


def require_room(connection, room_id):
    """Return a room and its current message count, or raise a lookup error."""
    row = connection.execute("""SELECT rooms.*,
        COALESCE(stats.message_count,0) AS message_count,COALESCE(stats.latest_id,0) AS latest_id
        FROM rooms LEFT JOIN room_message_stats stats ON stats.room_id=rooms.id WHERE rooms.id=? GROUP BY rooms.id""", (room_id,)).fetchone()
    if row is None:
        raise LookupError("房间不存在")
    if enforce_session_limits(connection, room_id):
        connection.commit()
        row = connection.execute("""SELECT rooms.*,
            COALESCE(stats.message_count,0) AS message_count,COALESCE(stats.latest_id,0) AS latest_id
            FROM rooms LEFT JOIN room_message_stats stats ON stats.room_id=rooms.id WHERE rooms.id=? GROUP BY rooms.id""", (room_id,)).fetchone()
    room = dict(row)
    room["archived"] = bool(connection.execute("SELECT archived FROM room_directory WHERE room_id=?", (room_id,)).fetchone()[0])
    room["folder_id"] = connection.execute("SELECT folder_id FROM room_folder_assignments WHERE room_id=?", (room_id,)).fetchone()[0]
    settings = connection.execute("SELECT host,background,boundaries,experts,focus FROM topic_settings WHERE room_id=?",
                                  (room_id,)).fetchone()
    room.update(dict(settings) if settings else topic_defaults())
    original = connection.execute("SELECT text FROM room_user_requests WHERE room_id=?", (room_id,)).fetchone()
    room.update(topic_context(room["background"], original["text"] if original else None))
    if settings:
        room["experts"] = json.loads(room["experts"])
    brief = connection.execute("SELECT text,until,updated_at FROM room_briefs WHERE room_id=?", (room_id,)).fetchone()
    room["host_brief"] = dict(brief) if brief else None
    room["mode"] = "free"
    session = connection.execute("SELECT id,goal,status,started_message_id,ended_message_id,created_at FROM discussion_sessions WHERE room_id=? ORDER BY id DESC LIMIT 1", (room_id,)).fetchone()
    room["session"] = dict(session) if session else None
    room["discussions"] = [dict(row) for row in connection.execute(DISCUSSIONS_SELECT, (room_id,))]
    room.update(discussion_progress(connection, room))
    room["round_groups"] = merge_round_groups(connection, room_id)
    room["members"] = [dict(row) for row in connection.execute(
        """SELECT m.id,m.name,m.adapter,m.role,m.status,m.access,m.session_mode,COALESCE(s.session_id,'') AS reported_session,COALESCE(s.client,'') AS reported_client,
        COALESCE(r.registered_at,'') AS registered_at
        FROM room_members AS m LEFT JOIN member_sessions AS s ON s.member_id=m.id
        LEFT JOIN member_registrations AS r ON r.member_id=m.id AND r.token_hash=m.token_hash
        WHERE m.room_id=? AND m.status<>'removed' ORDER BY m.id""", (room_id,))]
    # Members are called by label in text and in @; the ID (name) is part of the full record, like the description.
    shown = member_display_names(connection, room_id)
    room["members"] = [{"label": shown.get(member["name"], member["name"]), **member} for member in room["members"]]
    option = connection.execute("SELECT named_followup FROM session_options WHERE session_id=?", (session["id"],)).fetchone() if session else None
    # Before any discussion the host keeps its named follow-ups.
    room["named_followup"] = bool(option[0]) if option else True
    room["scheduler_decisions"] = [dict(row) for row in connection.execute(
        f"{DECISION_SELECT} WHERE d.room_id=? ORDER BY d.id DESC LIMIT ?", (room_id, RECENT_DECISIONS))][::-1]
    details = {row[0]: json.loads(row[1]) for row in connection.execute(
        "SELECT decision_id,detail FROM scheduler_decision_details WHERE decision_id IN (SELECT id FROM scheduler_decisions WHERE room_id=? ORDER BY id DESC LIMIT ?)", (room_id, RECENT_DECISIONS))}
    for decision in room["scheduler_decisions"]:
        decision["detail"] = details.get(decision["id"])
    room["scheduler_routing"] = [row[0] for row in connection.execute(
        "SELECT message_id FROM scheduler_routing WHERE room_id=? AND created_at>? ORDER BY message_id", (room_id, int(time.time()) - ROUTING_VISIBLE_SECONDS))]
    room["host_arrangements"] = host_arrangements(connection, room_id, room["scheduler_decisions"])
    room["cancelled_turns"] = cancelled_turns(connection, room_id)
    room["free"] = free_view(connection, room_id)
    room["goal_state"] = goal_view(connection, room_id)
    room["descriptions"] = member_descriptions(connection, room_id)
    room["labels"] = member_labels(connection, room_id)
    room["withdrawals"] = withdrawals(connection, room_id)
    room["speaking_order"] = speaking_order(connection, room)
    return room


def discussion_progress(connection, room):
    """Phase, limits, rounds and the current speaker, all from the room's discussions; a room that never held one has none.

    The room-level `held_since` stays 0: user messages go straight to their named members, and a discussion keeps its own
    hold in its session state.
    """
    room_id = room["id"]
    progress = {"phase": "discussing", "held_since": 0, "current_turn": None, "queued_turns": [], "completed_rounds": 0,
                "answered_turns": 0}
    limits = session_limits_view(connection, room_id)
    if not limits:
        return {**progress, "limits": room_limits_view(connection, room_id)}
    session = current_session(connection, room_id)
    state = connection.execute("SELECT phase FROM session_state WHERE session_id=?", (session["id"],)).fetchone()
    progress.update(phase="paused" if session["status"] == "paused" else "concluded" if session["status"] == "concluded" else state["phase"],
                    limits=room_limits_view(connection, room_id) if session["status"] == "concluded" else limits,
                    completed_rounds=limits["completed_rounds"], answered_turns=limits["answered"])
    if session["status"] == "concluded":
        return progress
    current = connection.execute("""SELECT sr.*,m.name AS expert FROM session_requests sr
        JOIN room_members m ON m.id=sr.member_id WHERE sr.session_id=? AND sr.purpose='discuss' AND sr.status='open'
        ORDER BY sr.round,sr.position,sr.id LIMIT 1""", (session["id"],)).fetchone()
    progress["current_turn"] = ({**dict(current), "status": "pending", "status_label": pending_label(room, current["expert"])}
                                if current else None)
    progress["queued_turns"] = [dict(row) for row in connection.execute("""SELECT sr.id,sr.question,m.name AS expert
        FROM session_requests sr JOIN room_members m ON m.id=sr.member_id
        WHERE sr.session_id=? AND sr.purpose='discuss' AND sr.status='queued' ORDER BY sr.round,sr.position,sr.id""",
        (session["id"],))]
    return progress


def host_arrangements(connection, room_id, decisions):
    """Each plan the host created in the room's discussions, anchored where its task appeared.

    Invitations are not plans, and a plan the smart scheduler applied is already shown by its own decision.
    """
    plans = session_host_arrangements(connection, room_id)
    applied = {item["after_message_id"] for item in decisions if item["applied"]}
    plans = [plan for plan in plans if plan["after_message_id"] not in applied]
    plans.sort(key=lambda plan: (plan["created_at"], plan["after_message_id"], str(plan["id"])))
    return plans[-RECENT_DECISIONS:]


def visible_anchor_before(connection, room_id, message_id):
    """Return the last ordinary transcript message before a hidden task message."""
    if not message_id:
        return 0
    return connection.execute("""SELECT COALESCE(MAX(m.id),0) FROM messages m WHERE m.room_id=? AND m.id<?
        AND NOT EXISTS(SELECT 1 FROM internal_task_messages t WHERE t.message_id=m.id)""", (room_id, message_id)).fetchone()[0]


def session_host_arrangements(connection, room_id):
    """Expose discussion plans as arrangement cards, grouped by submission batch."""
    rows = connection.execute("""SELECT q.id,q.session_id,q.round,q.question,q.created_at,q.submission_id,
        m.name AS expert,r.message_id AS task_message_id FROM discussion_sessions s JOIN session_requests q ON q.session_id=s.id
        JOIN room_members m ON m.id=q.member_id LEFT JOIN member_requests r ON r.id=q.member_request_id
        WHERE s.room_id=? AND q.purpose='discuss' AND q.submission_id NOT LIKE 'invite:%'
        ORDER BY s.id,q.created_at,q.id""", (room_id,)).fetchall()
    submission_ids = {(row["session_id"], row["submission_id"]) for row in rows}
    batches = {}
    for row in rows:
        base_id = row["submission_id"]
        match = re.match(r"^(.*)-q\d+$", base_id)
        if match and (row["session_id"], match.group(1)) in submission_ids:
            base_id = match.group(1)
        batches.setdefault((row["session_id"], base_id, row["created_at"]), []).append(row)
    if not batches:
        return []
    anchors = arrangement_anchors(connection, room_id, [batch[0] for batch in batches.values()])
    return [{"id": f"session-{session_id}-plan-{batch[0]['id']}", "key": f"session-{session_id}-plan-{batch[0]['id']}",
        "display_id": batch[0]["id"], "after_message_id": anchors[batch[0]["id"]], "created_at": created_at,
        "turns": [{"expert": row["expert"], "question": row["question"], "round": row["round"]} for row in batch]}
        for (session_id, base_id, created_at), batch in batches.items()]


def arrangement_anchors(connection, room_id, plans):
    """Find historical plan slots in one query, restricting host-task lookup to its indexed session."""
    values = [[row["id"], row["session_id"], row["task_message_id"] or 2 ** 63 - 1, row["task_message_id"] or 0] for row in plans]
    rows = connection.execute("""WITH plans AS (
        SELECT json_extract(value,'$[0]') AS id,json_extract(value,'$[1]') AS session_id,
            json_extract(value,'$[2]') AS before_id,json_extract(value,'$[3]') AS task_message_id FROM json_each(?))
        SELECT p.id,(SELECT COALESCE(MAX(m.id),0) FROM messages m WHERE m.room_id=? AND m.id<COALESCE(
            (SELECT t.message_id FROM task_message_sources t JOIN session_requests h ON h.id=t.session_request_id
                WHERE t.session_id=p.session_id AND h.purpose='discuss_host' AND t.message_id<p.before_id
                ORDER BY t.message_id DESC LIMIT 1),p.task_message_id)
            AND NOT EXISTS(SELECT 1 FROM internal_task_messages t WHERE t.message_id=m.id)) AS anchor
        FROM plans p""", (json.dumps(values), room_id))
    return {row["id"]: row["anchor"] for row in rows}


def cancelled_turns(connection, room_id):
    """Discussion assignments that ended without an answer, anchored where their task appeared."""
    result = []
    for row in connection.execute("""SELECT q.id,q.session_id,q.question,q.status,q.created_at,m.name AS expert,r.execution_id,
        'session-'||q.session_id||'-request-'||q.id AS key,
        (SELECT COALESCE(MAX(a.id),0) FROM messages a WHERE a.room_id=? AND a.id<r.message_id
            AND NOT EXISTS(SELECT 1 FROM internal_task_messages t WHERE t.message_id=a.id)) AS after_message_id
        FROM session_requests q JOIN room_members m ON m.id=q.member_id
        JOIN member_requests r ON r.id=q.member_request_id
        WHERE q.session_id IN (SELECT id FROM discussion_sessions WHERE room_id=?) AND q.purpose='discuss'
          AND q.status IN ('cancelled','skipped') AND q.member_request_id IS NOT NULL AND r.answer_id IS NULL
          AND NOT EXISTS(SELECT 1 FROM member_executions e WHERE e.id=r.execution_id AND e.status='failed')
        ORDER BY q.created_at DESC,after_message_id DESC,key DESC LIMIT ?""", (room_id, room_id, RECENT_DECISIONS)):
        result.append({"id": row["key"], "key": row["key"], "display_id": row["id"],
            "expert": row["expert"], "question": row["question"], "status": row["status"],
            "execution_id": row["execution_id"],
            "after_message_id": row["after_message_id"],
            "created_at": row["created_at"]})
    return result[::-1]


def merge_round_groups(connection, room_id):
    """The rounds of every discussion the room held, in transcript order."""
    rows = connection.execute("""SELECT q.session_id,q.round,m.name AS expert,m.role,r.answer_id,s.started_message_id,s.ended_message_id
        FROM discussion_sessions s JOIN session_requests q ON q.session_id=s.id
        JOIN room_members m ON m.id=q.member_id JOIN member_requests r ON r.id=q.member_request_id
        WHERE s.room_id=? AND q.purpose='discuss' AND r.answer_id IS NOT NULL
        ORDER BY s.id,q.round,q.position,q.id""", (room_id,)).fetchall()
    by_round = {}
    for row in rows:
        group = by_round.setdefault((row["session_id"], row["round"]), {"number": row["round"], "speakers": [], "opinions": 0,
            "session_id": row["session_id"], "start_id": row["started_message_id"] or 0,
            "end_id": row["ended_message_id"] or None, "last_answer": 0, "host_scheduled": False})
        if row["answer_id"]:
            group["opinions"] += 1
            if row["expert"] not in group["speakers"]:
                group["speakers"].append(row["expert"])
        group["last_answer"] = max(group["last_answer"], row["answer_id"])
        group["host_scheduled"] = group["host_scheduled"] or row["role"] == "host"
    if not by_round:
        return []
    active_experts = connection.execute("""SELECT COUNT(*) FROM room_members m
        WHERE m.room_id=? AND m.status='active' AND m.role<>'host'
        AND (m.access<>'manual' OR EXISTS(SELECT 1 FROM member_registrations reg
            WHERE reg.member_id=m.id AND reg.token_hash=m.token_hash))""", (room_id,)).fetchone()[0]
    previous_answers = {}
    result = []
    for (session_id, number), group in sorted(by_round.items()):
        denominator = active_experts + int(group.pop("host_scheduled"))
        group["completed"] = denominator > 0 and group["opinions"] >= denominator
        group["start_id"] = max(group["start_id"], previous_answers.get(session_id, 0)) + 1
        previous_answers[session_id] = group.pop("last_answer")
        result.append({**group, "key": f"session-{session_id}-round-{number}", "participants": denominator})
    return sorted(result, key=lambda group: (group["start_id"], group["key"]))


def pending_label(room, expert):
    """Describe a speaker's open request by how the member takes part, without claiming its app is generating."""
    return "待处理（本地 CLI）" if room["experts"].get(expert) == "cli" else "待处理"


def topic_context(background, user_request=None):
    """Separate explicitly marked legacy requests without guessing unmarked text."""
    if user_request is None:
        match = re.match(r"^用户原文[：:][ \t]*(?:\r?\n)?([\s\S]*?)(?:\r?\n){2,}((?:项目背景与入口|背景)[：:][\s\S]*)$", background)
        if match:
            user_request, background = match.group(1), match.group(2)
    return {"user_request": user_request or "", "background": background}


def topic_defaults():
    """Topic fields of a room created without topic settings (the sample room)."""
    return {"host": "用户", "background": "", "boundaries": "", "focus": "", "experts": {}}


def topic_values(payload, current=None):
    """Validate topic fields and require an AI host to have CLI capability."""
    result = {**topic_defaults(), **(current or {})}
    limits = {"title": 80, "goal": 1000, "user_request": MAX_TOPIC_DETAIL, "background": MAX_TOPIC_DETAIL,
              "boundaries": MAX_TOPIC_DETAIL, "focus": MAX_QUESTION_LENGTH}
    for field, limit in limits.items():
        value = str(payload.get(field, result.get(field, "")))
        result[field] = value if field == "user_request" else value.strip()
        if len(result[field]) > limit or (field == "title" and not result[field]):
            raise ValueError(f"{field} 内容为空或超过 {limit} 字")
    result["host"] = payload.get("host", result["host"])
    result["experts"] = payload.get("experts", result["experts"])
    experts = result["experts"]
    if (not isinstance(experts, dict) or len(experts) > MAX_ROOM_AGENTS
            or any(not is_ai(name) or mode != "cli" for name, mode in experts.items())):
        raise ValueError("专家需为有效 AI 身份，参与方式为 cli")
    if result["host"] != "用户" and experts.get(result["host"]) != "cli":
        raise ValueError("AI 主持人必须是可读可写的本地 CLI 参与者")
    return result


def save_topic_settings(connection, room_id, settings):
    """Persist topic settings without modifying any original messages."""
    connection.execute("""INSERT INTO topic_settings (room_id,host,background,boundaries,experts,focus) VALUES (?,?,?,?,?,?)
        ON CONFLICT(room_id) DO UPDATE SET host=excluded.host,background=excluded.background,boundaries=excluded.boundaries,
        experts=excluded.experts,focus=excluded.focus""",
                       (room_id, settings["host"], settings["background"], settings["boundaries"],
                        json.dumps(settings["experts"], ensure_ascii=False), settings["focus"]))
    connection.execute("INSERT INTO room_user_requests (room_id,text) VALUES (?,?) ON CONFLICT(room_id) DO UPDATE SET text=excluded.text",
                       (room_id, settings.get("user_request", "")))


def save_room_limits(connection, room_id, limits):
    """Keep the limits the room's next discussion starts from."""
    connection.execute("UPDATE discussion_limits SET max_rounds=?,max_minutes=?,execution_minutes=? WHERE room_id=?",
                       (*(limits[key] for key in LIMIT_KEYS), room_id))


def require_host(room, payload):
    """Check the declared operator; this is a workflow rule, not authentication."""
    if payload.get("actor") not in (room["host"], "用户"):
        raise ValueError("请使用当前主持人或用户身份管理话题")


def update_topic(connection, room_id, payload):
    """Update the title, goal and topic material through a declared host action; members change through member management."""
    begin_write(connection)
    room = require_room(connection, room_id)
    require_host(room, payload)
    if "phase" in payload:
        raise ValueError("自由协作房间的讨论阶段由 discussion 会话控制")
    if room["archived"]:
        raise ValueError("房间已存档；恢复后才能修改话题资料")
    settings = topic_values(payload, room)
    if settings["host"] != room["host"] or settings["experts"] != room["experts"] or payload.get("members"):
        raise ValueError("主持人与成员请通过成员管理操作调整")
    if "limits" in payload:
        if current_session(connection, room_id, active_only=True):
            raise ValueError("新讨论的上限请通过 limits 接口修改")
        save_room_limits(connection, room_id, limit_values(payload["limits"], room["limits"]))
    connection.execute("UPDATE rooms SET title=?,goal=? WHERE id=?", (settings["title"], settings["goal"], room_id))
    connection.execute("UPDATE topic_settings SET background=?,boundaries=?,focus=? WHERE room_id=?",
                       (settings["background"], settings["boundaries"], settings["focus"], room_id))
    connection.execute("INSERT INTO room_user_requests (room_id,text) VALUES (?,?) ON CONFLICT(room_id) DO UPDATE SET text=excluded.text",
                       (room_id, settings.get("user_request", "")))
    return require_room(connection, room_id)


def submission_value(value):
    """Validate a replay identifier for writes or exact result lookup."""
    identifier = str(value or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]{8,100}", identifier):
        raise ValueError("submission_id 必须是 8–100 位字母、数字、下划线或连字符")
    return identifier


def room_revisions(connection, params):
    """Return the site revision and each named room's revision, so an idle room is read in full only after it changed.

    Args:
        connection: Database connection.
        params: Query parameters; ``rooms`` is a comma-separated list of room ids.

    Returns:
        ``{"site": int, "rooms": {room_id: int}}``; a room that does not exist is left out.
    """
    ids = [item for item in str(params.get("rooms", "")).split(",") if item][:MAX_REVISION_ROOMS]
    site = connection.execute("SELECT COALESCE(MAX(revision),0) AS revision FROM room_revisions").fetchone()["revision"]
    marks = ",".join("?" * len(ids))
    rows = connection.execute(f"""SELECT rooms.id,COALESCE(room_revisions.revision,0) AS revision FROM rooms
        LEFT JOIN room_revisions ON room_revisions.room_id=rooms.id WHERE rooms.id IN ({marks})""", ids).fetchall() if ids else []
    return {"site": site, "rooms": {row["id"]: row["revision"] for row in rows}}


def room_progress(connection, room_id):
    """Read live execution progress and its room revision in one snapshot, without history or credentials."""
    row = connection.execute("""SELECT COALESCE(v.revision,0) AS revision,
        (SELECT json_group_array(json_object('id',e.id,'member_id',e.member_id,'status',e.status,
            'lease_until',e.lease_until,'activity',e.activity,'activity_at',e.activity_at,
            'notes',(SELECT COUNT(*) FROM execution_notes WHERE execution_id=e.id)))
            FROM member_executions e WHERE e.room_id=rooms.id AND e.status IN ('dispatched','started')) AS executions
        FROM rooms LEFT JOIN room_revisions v ON v.room_id=rooms.id WHERE rooms.id=?""", (room_id,)).fetchone()
    if row is None:
        raise LookupError("房间不存在")
    now = int(time.time())
    return {"revision": row["revision"], "executions": [
        {**execution, "stale": execution["lease_until"] <= now} for execution in json.loads(row["executions"])]}


def list_rooms(connection, params=None):
    """Return rooms, optionally locating a single persisted creation request."""
    params = params or {}
    identifier = submission_value(params["submission_id"]) if "submission_id" in params else None
    where = "WHERE EXISTS (SELECT 1 FROM room_creations WHERE room_id=rooms.id AND submission_id=?)" if identifier else ""
    rows = connection.execute(f"""SELECT rooms.*,
        COALESCE(stats.message_count,0) AS message_count,COALESCE(stats.latest_id,0) AS latest_id,
        (SELECT created_at FROM messages WHERE id=stats.latest_id) AS latest_at
        FROM rooms LEFT JOIN room_message_stats stats ON stats.room_id=rooms.id {where}
        GROUP BY rooms.id ORDER BY rooms.created_at, rooms.id""", (identifier,) if identifier else ())
    directory = {row["room_id"]: dict(row) for row in connection.execute("SELECT * FROM room_directory")}
    assignments = {row["room_id"]: row["folder_id"] for row in connection.execute("SELECT room_id,folder_id FROM room_folder_assignments")}
    rooms = [{**dict(row), "archived": bool(directory[row["id"]]["archived"]), "folder_id": assignments[row["id"]]} for row in rows]
    return {"rooms": sorted(rooms, key=lambda room: directory[room["id"]]["position"]),
            **folder_directory(connection)}


def last_room(connection):
    """The room last opened by the site's manager on any device, or '' when none or it no longer exists."""
    row = connection.execute("""SELECT p.value FROM site_preferences p JOIN rooms r ON r.id=p.value
        WHERE p.key='last_room'""").fetchone()
    return row[0] if row else ""


def remember_last_room(connection, payload):
    """Remember the room the manager opened, so the next visit from any device reopens it."""
    room_id = payload.get("room_id")
    if not isinstance(room_id, str) or not connection.execute("SELECT 1 FROM rooms WHERE id=?", (room_id,)).fetchone():
        raise LookupError("房间不存在")
    connection.execute("INSERT INTO site_preferences (key,value) VALUES ('last_room',?) "
                       "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (room_id,))
    return {"last_room": room_id}


def folder_directory(connection):
    """Return real folders and the virtual group's index (null keeps it last)."""
    settings = connection.execute("SELECT uncategorized_position FROM directory_settings WHERE id=1").fetchone()
    return {"folders": [dict(row) for row in connection.execute("SELECT id,name,position FROM topic_folders ORDER BY position,name,id")],
            "uncategorized_position": settings[0] if settings else None}


def folder_name_value(payload):
    """Validate a shared folder name for creation and renaming."""
    raw_name = payload.get("name")
    if not isinstance(raw_name, str):
        raise ValueError("文件夹名称必须是文本")
    name = raw_name.strip()
    if not name or len(name) > 40:
        raise ValueError("文件夹名称须为 1–40 个字符")
    return name


def rename_folder(connection, folder_id, payload):
    """Rename one folder, retaining its position and all room assignments."""
    begin_write(connection)
    name = folder_name_value(payload)
    if connection.execute("UPDATE topic_folders SET name=? WHERE id=?", (name, folder_id)).rowcount == 0:
        raise LookupError("文件夹不存在")
    return dict(connection.execute("SELECT id,name,position FROM topic_folders WHERE id=?", (folder_id,)).fetchone())


def delete_folder(connection, folder_id):
    """Remove a group while retaining its rooms and the virtual group's position."""
    begin_write(connection)
    directory = folder_directory(connection)
    identifiers = [folder["id"] for folder in directory["folders"]]
    if folder_id not in identifiers:
        raise LookupError("文件夹不存在")
    position = directory["uncategorized_position"]
    if position is not None:
        position -= int(identifiers.index(folder_id) < position)
        if position >= len(identifiers) - 1:
            position = None
    connection.execute("DELETE FROM topic_folders WHERE id=?", (folder_id,))
    connection.execute("UPDATE directory_settings SET uncategorized_position=? WHERE id=1", (position,))
    return {"deleted": True, "id": folder_id}


def move_folder(connection, folder_id, payload):
    """Persist a folder before another folder, or last when before_id is null.

    Args:
        connection: Writable SQLite connection.
        folder_id: Existing folder or the reserved uncategorized group ID.
        payload: Optional before_id identifying an existing destination folder.

    Returns:
        The complete folder list in its saved order.
    """
    begin_write(connection)
    directory = folder_directory(connection)
    folders = directory["folders"]
    position = directory["uncategorized_position"]
    folders.insert(min(position, len(folders)) if position is not None else len(folders), {"id": UNCATEGORIZED_FOLDER_ID})
    moving = next((folder for folder in folders if folder["id"] == folder_id), None)
    if moving is None:
        raise LookupError("文件夹不存在")
    remaining = [folder for folder in folders if folder["id"] != folder_id]
    before = payload.get("before_id")
    identifiers = [folder["id"] for folder in remaining]
    if before is not None and before not in identifiers:
        raise ValueError("目标文件夹不存在或与当前文件夹相同")
    remaining.insert(identifiers.index(before) if before is not None else len(remaining), moving)
    uncategorized_position = next(index for index, folder in enumerate(remaining) if folder["id"] == UNCATEGORIZED_FOLDER_ID)
    ordered = [folder for folder in remaining if folder["id"] != UNCATEGORIZED_FOLDER_ID]
    uncategorized_position = None if uncategorized_position == len(ordered) else uncategorized_position
    for position, folder in enumerate(ordered, 1):
        folder["position"] = position
    connection.executemany("UPDATE topic_folders SET position=? WHERE id=?",
                           [(folder["position"], folder["id"]) for folder in ordered])
    connection.execute("INSERT INTO directory_settings (id,uncategorized_position) VALUES (1,?) "
                       "ON CONFLICT(id) DO UPDATE SET uncategorized_position=excluded.uncategorized_position",
                       (uncategorized_position,))
    return {"folders": ordered, "uncategorized_position": uncategorized_position}


def manage_room(connection, room_id, action, payload):
    """Move, rename, archive, restore or permanently delete one declared host's room."""
    begin_write(connection)
    room = require_room(connection, room_id)
    require_host(room, payload)
    if action == "move":
        rooms = [item["id"] for item in list_rooms(connection)["rooms"] if item["id"] != room_id]
        before = payload.get("before_id")
        if before is not None and before not in rooms:
            raise ValueError("目标房间不存在或与当前房间相同")
        rooms.insert(rooms.index(before) if before else len(rooms), room_id)
        connection.executemany("UPDATE room_directory SET position=? WHERE room_id=?", enumerate(rooms, 1))
    elif action == "folder":
        folder_id = payload.get("folder_id")
        if folder_id is not None and not isinstance(folder_id, str):
            raise ValueError("文件夹编号格式无效")
        if folder_id is not None and connection.execute("SELECT 1 FROM topic_folders WHERE id=?", (folder_id,)).fetchone() is None:
            raise ValueError("文件夹不存在")
        connection.execute("UPDATE room_folder_assignments SET folder_id=? WHERE room_id=?", (folder_id, room_id))
    elif action == "rename":
        # The title is display-only, so renaming never touches phase, turns or members.
        title = str(payload.get("title", "")).strip()
        if not title or len(title) > 80:
            raise ValueError("title 内容为空或超过 80 字")
        connection.execute("UPDATE rooms SET title=? WHERE id=?", (title, room_id))
    elif action in ("archive", "restore"):
        if action == "archive":
            session = current_session(connection, room_id, active_only=True)
            if session and session["status"] == "active":
                from .session_room import cancel_session_work
                cancel_session_work(connection, session["id"], "房间已归档")
                connection.execute("UPDATE discussion_sessions SET status='paused' WHERE id=?", (session["id"],))
                connection.execute("UPDATE session_pauses SET paused_at=? WHERE session_id=?", (int(time.time()), session["id"]))
                connection.execute("UPDATE session_state SET revision=revision+1 WHERE session_id=?", (session["id"],))
            # An archived room is read-only: nothing it still owes may be delivered or answered later.
            stop_room_work(connection, room_id, "房间已归档", "archived")
        connection.execute("UPDATE room_directory SET archived=? WHERE room_id=?", (int(action == "archive"), room_id))
    elif action == "delete":
        if payload.get("confirm_title") != room["title"]:
            raise ValueError("请输入完整房间名称确认删除")
        delete_room_records(connection, room_id)
        return {"deleted": True, "id": room_id}
    else:
        raise LookupError("地址不存在")
    return require_room(connection, room_id)


def delete_room_records(connection, room_id):
    """Remove a room's dependent records in the caller's transaction."""
    connection.execute("DELETE FROM task_message_sources WHERE session_id IN (SELECT id FROM discussion_sessions WHERE room_id=?)", (room_id,))
    connection.execute("DELETE FROM goal_continuations WHERE room_id=?", (room_id,))
    connection.execute("DELETE FROM room_goals WHERE room_id=?", (room_id,))
    connection.execute("DELETE FROM discussion_sessions WHERE room_id=?", (room_id,))
    for table in ("member_recommendations", "free_queue", "queued_messages", "queued_message_pauses", "speaking_orders", "member_requests", "member_descriptions", "member_labels", "execution_notes", "execution_segments", "execution_capabilities", "late_answers", "member_executions", "member_capabilities", "member_sessions", "member_adopt_failures", "member_registrations", "room_members", "room_modes", "free_batches", "free_chains", "free_handoffs", "free_round_limits", "free_chain_holds", "free_relay_steps",
                  "scheduler_decisions", "scheduler_routing", "discussion_conclusions", "discussion_sessions"):
        if table == "scheduler_decisions":
            for child in ("scheduler_feedback", "scheduler_decision_context", "scheduler_decision_inputs"):
                connection.execute(f"DELETE FROM {child} WHERE decision_id IN (SELECT id FROM scheduler_decisions WHERE room_id=?)", (room_id,))
            connection.execute("DELETE FROM scheduler_decision_details WHERE decision_id IN (SELECT id FROM scheduler_decisions WHERE room_id=?)", (room_id,))
        connection.execute(f"DELETE FROM {table} WHERE room_id=?", (room_id,))
    connection.execute("DELETE FROM message_withdrawals WHERE message_id IN (SELECT id FROM messages WHERE room_id=?)", (room_id,))
    connection.execute("DELETE FROM room_rewinds WHERE room_id=?", (room_id,))
    connection.execute("DELETE FROM message_timings WHERE message_id IN (SELECT id FROM messages WHERE room_id=?)", (room_id,))
    connection.execute("DELETE FROM message_summaries WHERE message_id IN (SELECT id FROM messages WHERE room_id=?)", (room_id,))
    connection.execute("DELETE FROM message_details WHERE message_id IN (SELECT id FROM messages WHERE room_id=?)", (room_id,))
    connection.execute("UPDATE messages SET reply_to=NULL WHERE room_id=?", (room_id,))
    connection.execute("DELETE FROM messages WHERE room_id=?", (room_id,))
    for table in ("discussion_limits", "topic_settings", "room_creations", "room_directory", "room_folder_assignments", "room_briefs", "room_user_requests"):
        connection.execute(f"DELETE FROM {table} WHERE room_id=?", (room_id,))
    # Last, since deleting the rows above fires the event triggers.
    connection.execute("DELETE FROM room_events WHERE room_id=?", (room_id,))
    connection.execute("DELETE FROM rooms WHERE id=?", (room_id,))


def redact_payload(value):
    """Copy a request payload for the event log: credentials replaced, long strings cut with their full length noted."""
    if isinstance(value, dict):
        return {key: "[已隐去]" if API_LOG_SECRET.search(str(key)) else redact_payload(item) for key, item in value.items()}
    if isinstance(value, list):
        return [redact_payload(item) for item in value]
    if isinstance(value, str) and len(value) > API_LOG_TEXT:
        return f"{value[:API_LOG_TEXT]}…（共 {len(value)} 字）"
    return value


def api_actor(connection, room_id, token):
    """Name who sent a write: `owner`, `member:NAME`, or `none` / `unknown` when the credential matches nobody."""
    hashed = token_hash(token)
    if not hashed:
        return "none"
    if connection.execute("SELECT 1 FROM room_modes WHERE room_id=? AND control_hash=?", (room_id, hashed)).fetchone():
        return "owner"
    member = connection.execute("SELECT name FROM room_members WHERE room_id=? AND token_hash=?", (room_id, hashed)).fetchone()
    return f"member:{member[0]}" if member else "unknown"


def record_api_event(database, record):
    """Append one write request, accepted or rejected, to its room's event log in a connection of its own.

    Runs after the request's own connection is closed, so a rejected write that rolled back is still recorded and the
    log never holds the request's transaction open. Failures are logged and swallowed: the record must not break a write.
    """
    try:
        with closing(connect_db(database)) as connection, connection:
            data = {key: record[key] for key in ("method", "path", "status", "client", "bridged")}
            data["elapsed_ms"] = max(0, int(time.time() * 1000) - record["at"])
            data["actor"] = api_actor(connection, record["room_id"], record["token"])
            if record.get("error"):
                data["error"] = record["error"]
            payload = json.dumps(redact_payload(record["payload"]), ensure_ascii=False)
            data["payload"] = payload if len(payload) <= API_LOG_PAYLOAD else f"{payload[:API_LOG_PAYLOAD]}…（共 {len(payload)} 字）"
            connection.execute("""INSERT INTO room_events (room_id,at,kind,data) SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM rooms WHERE id=?)""",
                               (record["room_id"], record["at"], "api.write" if record["status"] < 400 else "api.rejected",
                                json.dumps(data, ensure_ascii=False), record["room_id"]))
    except Exception:
        logging.exception("Recording a room write in the event log failed")


def creation_request(settings, limits):
    """Freeze normalized creation inputs independently of later topic edits."""
    fields = ("title", "goal", "host", "background", "boundaries", "focus")
    values = [settings[field] for field in fields] + [sorted(settings["experts"].items())]
    if limits:
        values.append([limits[key] for key in LIMIT_KEYS])
    request = json.dumps(values, ensure_ascii=False, separators=(",", ":"))
    return request + (":user_request:" + json.dumps(settings["user_request"], ensure_ascii=False)
                      if settings.get("user_request") else "")


def create_room(connection, payload, control_token=""):
    """Create a credential-protected collaboration room, binding retries to the original credentials."""
    if payload.get("mode", "free") != "free":
        raise ValueError("房间模式只能为 free")
    members = member_values(payload.get("members"))
    payload = {**payload, "experts": {member["name"]: "cli" for member in members}}
    settings = topic_values(payload)
    limits = limit_values(payload["limits"]) if "limits" in payload else None
    if not token_hash(control_token):
        raise ValueError("建房须提供房主控制凭据")
    identifier = submission_value(payload["submission_id"]) if "submission_id" in payload else None
    folder_id = payload.get("folder_id")
    if folder_id is not None and not isinstance(folder_id, str):
        raise ValueError("文件夹编号必须是文本或 null")
    request_text = creation_request(settings, limits)
    request_text += ":access:" + token_hash(control_token) + ":" + json.dumps(
        [[member["name"], member["adapter"], member["access"], "",
          member["session_mode"], token_hash(member["token"])] for member in members], ensure_ascii=False)
    if folder_id is not None:
        request_text += ":folder:" + json.dumps(folder_id, ensure_ascii=False)
    begin_write(connection)
    if identifier:
        previous = connection.execute("SELECT * FROM room_creations WHERE submission_id=?", (identifier,)).fetchone()
        if previous:
            if previous["request_text"] != request_text:
                raise FileExistsError("该建房提交编号已被其他内容使用")
            return {**require_room(connection, previous["room_id"]), "duplicate": True, "submission_id": identifier}
    if folder_id is not None and connection.execute("SELECT 1 FROM topic_folders WHERE id=?", (folder_id,)).fetchone() is None:
        raise ValueError("文件夹不存在")
    room_id = uuid.uuid4().hex[:12]
    connection.execute("INSERT INTO rooms (id,title,goal,created_at) VALUES (?,?,?,?)", (room_id, settings["title"], settings["goal"], utc_now()))
    connection.execute("UPDATE room_folder_assignments SET folder_id=? WHERE room_id=?", (folder_id, room_id))
    if identifier:
        connection.execute("INSERT INTO room_creations (submission_id,room_id,request_text) VALUES (?,?,?)", (identifier, room_id, request_text))
    save_topic_settings(connection, room_id, settings)
    if limits:
        save_room_limits(connection, room_id, limits)
    save_room_access(connection, room_id, control_token, members, {"host": settings["host"], "created_at": utc_now()})
    sync_participants(connection, room_id)
    return {**require_room(connection, room_id), "duplicate": False, "submission_id": identifier}


def message_values(payload):
    """Validate a message and normalize its optional reply reference."""
    author = str(payload.get("author", "")).strip()
    text = str(payload.get("text", "")).strip()
    submission_id = submission_value(payload.get("submission_id"))
    if not is_participant(author):
        raise ValueError("请选择有效的发言者")
    if (not text and not attachment_ids(payload)) or len(text) > MAX_TEXT_LENGTH:
        raise ValueError(f"发言需包含正文或附件，正文最多 {MAX_TEXT_LENGTH} 字")
    reply_to = payload.get("reply_to")
    return author, text, submission_id, int(reply_to) if reply_to else None


def attachment_ids(payload):
    """Validate the ordered, unique attachment references of one message."""
    identifiers = payload.get("attachment_ids", [])
    if (not isinstance(identifiers, list) or len(identifiers) > MAX_MESSAGE_ATTACHMENTS
            or any(not isinstance(item, str) or not re.fullmatch(r"[a-f0-9]{32}", item) for item in identifiers)
            or len(set(identifiers)) != len(identifiers)):
        raise ValueError(f"附件编号无效；每条消息最多 {MAX_MESSAGE_ATTACHMENTS} 个，不能重复")
    return identifiers


def attachment_metadata(params):
    """Validate upload metadata independently of the untrusted MIME header."""
    name = params.get("file_name", "")
    actor = params.get("actor")
    if (not isinstance(name, str) or not name.strip() or len(name) > MAX_FILENAME_LENGTH
            or name in (".", "..") or re.search(r"[/\\\x00-\x1f\x7f]", name)):
        raise ValueError(f"文件名需为 1–{MAX_FILENAME_LENGTH} 字，不能包含路径或控制字符")
    if not is_participant(actor):
        raise ValueError("上传附件须声明有效的 actor")
    return {"file_name": name, "actor": actor, "submission_id": submission_value(params.get("submission_id"))}


def attachment_content_type(data):
    """Allow inline preview only for recognized raster images and PDF bytes."""
    signatures = ((b"\x89PNG\r\n\x1a\n", "image/png"), (b"\xff\xd8\xff", "image/jpeg"),
                  (b"GIF87a", "image/gif"), (b"GIF89a", "image/gif"), (b"%PDF-", "application/pdf"))
    for signature, content_type in signatures:
        if data.startswith(signature):
            return content_type
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return "image/webp"
    return "application/octet-stream"


def attachment_view(row):
    """Return attachment metadata and room-scoped content URLs."""
    result = dict(row)
    base = f"/api/rooms/{result['room_id']}/attachments/{result['id']}/content"
    result.update(url=base, download_url=base + "?download=1")
    return result


def message_with_attachments(connection, row):
    """Attach the published file list to an original message."""
    message = dict(row)
    if message["withdrawn"] == "retracted":
        # The owner retracted it before anyone handled it: only the page that retracted it keeps the text.
        return {**message, "text": "", "summary": "", "suggestions": [], "attachments": []}
    message["suggestions"] = message_suggestions(connection, message["id"])
    message["attachments"] = [attachment_view(item) for item in connection.execute(
        "SELECT * FROM attachments WHERE message_id=? ORDER BY position,id", (message["id"],))]
    return message


def query_attachments(connection, room_id, params):
    """List published files, or recover one upload by its exact submission ID."""
    require_room(connection, room_id)
    where, values = "room_id=?", [room_id]
    if "submission_id" in params:
        where += " AND submission_id=?"
        values.append(submission_value(params["submission_id"]))
    else:
        where += " AND message_id IS NOT NULL"
    if "message_id" in params:
        where += " AND message_id=?"
        values.append(int(params["message_id"]))
    page = max(1, int(params.get("page", 1)))
    total = connection.execute(f"SELECT COUNT(*) FROM attachments WHERE {where}", values).fetchone()[0]
    rows = connection.execute(f"SELECT * FROM attachments WHERE {where} ORDER BY created_at,id LIMIT ? OFFSET ?",
                              [*values, PAGE_SIZE, (page - 1) * PAGE_SIZE])
    return {"attachments": [attachment_view(row) for row in rows], "page": page, "total": total,
            "pages": max(1, (total + PAGE_SIZE - 1) // PAGE_SIZE)}


def get_attachment(connection, room_id, identifier):
    """Resolve a file only within the explicitly selected room."""
    row = connection.execute("SELECT * FROM attachments WHERE room_id=? AND id=?", (room_id, identifier)).fetchone()
    if not row:
        raise LookupError("附件不存在")
    return attachment_view(row)


def attachment_path(database, attachment):
    """Keep opaque file IDs in storage belonging to this exact SQLite database."""
    root = Path(str(Path(database).resolve()) + ".attachments")
    return root / attachment["id"]


def store_attachment(connection, database, room_id, metadata, data):
    """Persist one immutable upload; exact retries return the original file."""
    begin_write(connection)
    require_room(connection, room_id)
    expected = {**metadata, "size": len(data), "sha256": hashlib.sha256(data).hexdigest(),
                "content_type": attachment_content_type(data)}
    previous = connection.execute("SELECT * FROM attachments WHERE room_id=? AND submission_id=?",
                                  (room_id, metadata["submission_id"])).fetchone()
    if previous:
        if any(previous[key] != value for key, value in expected.items()):
            raise FileExistsError("这个附件提交编号已被其他文件使用")
        return {"attachment": attachment_view(previous), "duplicate": True}
    record = {"id": uuid.uuid4().hex, "room_id": room_id, **expected, "created_at": utc_now()}
    path = attachment_path(database, record)
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with path.open("xb") as target:
            target.write(data)
        connection.execute("""INSERT INTO attachments
            (id,room_id,file_name,actor,submission_id,size,sha256,content_type,created_at)
            VALUES (:id,:room_id,:file_name,:actor,:submission_id,:size,:sha256,:content_type,:created_at)""", record)
        connection.commit()
    except Exception:
        path.unlink(missing_ok=True)
        raise
    return {"attachment": get_attachment(connection, room_id, record["id"]), "duplicate": False}


def check_message_attachments(connection, room_id, actor, identifiers):
    """Reject references to another room, uploader, or already published message."""
    for identifier in identifiers:
        attachment = get_attachment(connection, room_id, identifier)
        if attachment["actor"] != actor or attachment["message_id"] is not None:
            raise FileExistsError("附件已用于其他消息，或不属于本次实际提交者")


def message_summary(payload, message):
    """Preserve a supplied summary and distinguish its writer from the answer's author."""
    summary = str(payload.get("summary", "")).strip()
    if len(summary) > MAX_SUMMARY_LENGTH:
        raise ValueError(f"回答摘要最多 {MAX_SUMMARY_LENGTH} 字")
    summary_by = payload.get("summary_by", message["submitted_by"]) if summary else ""
    if summary and (message["kind"] not in ("opinion", "chat") or summary_by not in (message["author"], message["submitted_by"])):
        raise ValueError("摘要仅用于观点，撰写者须为原作者或实际提交者")
    return {"summary": summary, "summary_by": summary_by}


def check_message_references(connection, room_id, message):
    """Keep replies within their declared topic."""
    if message["reply_to"] and not connection.execute("SELECT id FROM messages WHERE room_id=? AND id=?", (room_id, message["reply_to"])).fetchone():
        raise ValueError("回复的消息不在当前房间中")


def append_free_message(connection, room, payload, actor):
    """Append a free-room message: the owner's creates requests, a member's completes its execution."""
    if payload.get("kind") == "moderation":
        if any(payload.get(field) for field in ("next_review", "review_scope", "review_roster", "sequential", "loop", "parallel", "detach", "need_rounds")):
            raise ValueError("主持说明不能声明评审授权、依次接力或申请轮数；请在派活时提交")
        return append_free_moderation(connection, room, payload, actor)
    if payload.get("kind") not in (None, "chat"):
        raise ValueError("自由协作与新讨论使用 kind=chat，并以 execution_id 或 request_ids 关联请求")
    resolve_member_fields(connection, room["id"], payload)
    if payload.get("turn_id") is not None and current_session(connection, room["id"], active_only=True):
        raise ValueError("新讨论使用 kind=chat，并以 execution_id 或 request_ids 关联请求")
    author, text, submission_id, reply_to = message_values(payload)
    room_id = room["id"]
    if actor == "用户" and (author != "用户" or payload.get("submitted_by", "用户") != "用户"):
        raise PermissionError("房间控制凭据只能以用户身份发言")
    submitted_by = author
    expected = {"author": author, "text": text, "reply_to": reply_to, "kind": "chat", "submitted_by": submitted_by,
                "source": "user" if author == "用户" else "api" if payload.get("source") == "api" else "cli"}
    expected.update(message_summary(payload, expected))
    identifiers = attachment_ids(payload)
    previous = connection.execute(f"{MESSAGE_QUERY} WHERE room_id=? AND submission_id=?", (room_id, submission_id)).fetchone()
    if previous:
        previous = message_with_attachments(connection, previous)
        if (any(previous[key] != expected[key] for key in ("author", "text", "reply_to", "kind", "submitted_by", "summary", "summary_by"))
                or [item["id"] for item in previous["attachments"]] != identifiers):
            raise FileExistsError("这个提交编号已被另一条内容使用，请为新发言生成新编号")
        check_review_retry(connection, room_id, previous["id"], payload)
        return {"message": previous, "duplicate": True}
    if room["archived"]:
        raise ValueError("房间已存档；恢复后才能继续协作")
    check_message_references(connection, room_id, expected)
    check_message_attachments(connection, room_id, submitted_by, identifiers)
    # `/goal` and `/discuss` are commands: checked before saving, never queued, and not routed to members.
    mode_command = check_mode_command(connection, room_id, payload) if actor == "用户" else None
    if actor == "用户" and not mode_command and should_queue(connection, room_id, payload):
        return {**enqueue(connection, room_id, payload), "queue": queue_view(connection, room_id)}
    if actor != "用户":
        check_answer(connection, room_id, actor, payload)
    review_plan = checked_review_plan(connection, room_id, actor, payload)
    checked_sequence(actor, payload)
    cursor = connection.execute("INSERT INTO messages (room_id,author,text,reply_to,source,submission_id,created_at) VALUES (?,?,?,?,?,?,?)",
                                (room_id, author, text, reply_to, expected["source"], submission_id, utc_now()))
    connection.execute("INSERT INTO message_details (message_id,kind,submitted_by) VALUES (?,?,?)",
                       (cursor.lastrowid, "chat", submitted_by))
    connection.execute("INSERT INTO message_summaries (message_id,text,author) VALUES (?,?,?)",
                       (cursor.lastrowid, expected["summary"], expected["summary_by"]))
    for position, identifier in enumerate(identifiers):
        connection.execute("UPDATE attachments SET message_id=?,position=? WHERE id=?", (cursor.lastrowid, position, identifier))
    save_suggestions(connection, room_id, cursor.lastrowid, actor, payload)
    save_review_plan(connection, room_id, cursor.lastrowid, review_plan)
    if actor != "用户" and payload.get("proactive") is True:
        # Spoken on its own: it completes no request; only the host's may dispatch.
        after_proactive(connection, room_id, cursor.lastrowid, actor, payload)
    elif mode_command:
        apply_mode_command(connection, room_id, cursor.lastrowid, mode_command)
    else:
        after_free_message(connection, room_id, cursor.lastrowid, actor, payload)
    if payload.get("proactive") is not True:
        complete_session_requests(connection, room_id, payload, actor, cursor.lastrowid)
    saved_message = connection.execute(f"{MESSAGE_QUERY} WHERE messages.id=?", (cursor.lastrowid,)).fetchone()
    return {"message": message_with_attachments(connection, saved_message), "duplicate": False}


def append_free_moderation(connection, room, payload, actor):
    """Save a host note against its live host task without answering or routing it."""
    author, text, submission_id, reply_to = message_values(payload)
    if author != room["host"] or payload.get("submitted_by", author) != author:
        raise ValueError("主持说明须保留当前主持人署名")
    if not isinstance(actor, dict) or actor.get("role") != "host" or actor.get("name") != room["host"]:
        raise PermissionError("主持说明只能由当前主持成员提交")
    if payload.get("to") or payload.get("handoff") or payload.get("turn_id") is not None:
        raise ValueError("主持说明不能派活或关联发言轮次")
    if actor["access"] == "manual":
        ids = payload.get("request_ids")
        if payload.get("execution_id") is not None or not isinstance(ids, list) or not ids:
            raise ValueError("手动主持说明须关联有效的主持请求 request_ids")
        check_answer(connection, room["id"], actor, payload)
        rows = connection.execute("SELECT purpose FROM member_requests WHERE room_id=? AND id IN (%s)" % ",".join("?" for _ in ids),
                                  (room["id"], *ids)).fetchall()
        if len(rows) != len(set(ids)) or any(row["purpose"] != "discuss_host" for row in rows):
            raise ValueError("主持说明只能关联当前有效的主持请求")
    else:
        if payload.get("request_ids"):
            raise ValueError("自动主持说明须关联执行编号 execution_id")
        execution = check_answer(connection, room["id"], actor, payload)
        purposes = [row[0] for row in connection.execute(
            "SELECT purpose FROM member_requests WHERE execution_id=? AND status='delivering'", (execution["id"],))]
        if not purposes or any(purpose != "discuss_host" for purpose in purposes):
            raise ValueError("主持说明只能关联当前有效的主持执行")
    expected = {"author": author, "text": text, "reply_to": reply_to, "kind": "moderation",
                "submitted_by": author, "source": payload.get("source") if payload.get("source") in ("cli", "api") else "cli"}
    expected.update(message_summary(payload, expected))
    identifiers = attachment_ids(payload)
    previous = connection.execute(f"{MESSAGE_QUERY} WHERE room_id=? AND submission_id=?", (room["id"], submission_id)).fetchone()
    if previous:
        previous = message_with_attachments(connection, previous)
        if any(previous[key] != expected[key] for key in ("author", "text", "reply_to", "kind", "submitted_by", "summary", "summary_by")) or [item["id"] for item in previous["attachments"]] != identifiers:
            raise FileExistsError("这个提交编号已被另一条内容使用，请为新发言生成新编号")
        return {"message": previous, "duplicate": True}
    check_message_references(connection, room["id"], expected)
    check_message_attachments(connection, room["id"], author, identifiers)
    cursor = connection.execute("INSERT INTO messages (room_id,author,text,reply_to,source,submission_id,created_at) VALUES (?,?,?,?,?,?,?)",
                                (room["id"], author, text, reply_to, expected["source"], submission_id, utc_now()))
    connection.execute("INSERT INTO message_details (message_id,kind,submitted_by) VALUES (?,?,?)",
                       (cursor.lastrowid, "moderation", author))
    connection.execute("INSERT INTO message_summaries (message_id,text,author) VALUES (?,?,?)",
                       (cursor.lastrowid, "", ""))
    for position, identifier in enumerate(identifiers):
        connection.execute("UPDATE attachments SET message_id=?,position=? WHERE id=?", (cursor.lastrowid, position, identifier))
    saved_message = connection.execute(f"{MESSAGE_QUERY} WHERE messages.id=?", (cursor.lastrowid,)).fetchone()
    return {"message": message_with_attachments(connection, saved_message), "duplicate": False}


def record_reported_session(connection, room_id, token, payload):
    """Keep the software session a manual member posted from, so the local service can take the member over."""
    session_id, client = payload.get("session_id"), payload.get("session_client")
    if (not isinstance(client, str) or not ADAPTER_VALUE.fullmatch(client) or not isinstance(session_id, str)
            or not SESSION_ID_PATTERN.fullmatch(session_id) or not token):
        return
    member = connection.execute("SELECT id FROM room_members WHERE room_id=? AND token_hash=? AND status='active' AND access='manual' AND adapter IN ('manual','')",
                                (room_id, token_hash(token))).fetchone()
    if member:
        connection.execute("""INSERT INTO member_sessions (member_id,room_id,session_id,client) VALUES (?,?,?,?)
            ON CONFLICT(member_id) DO UPDATE SET session_id=excluded.session_id,client=excluded.client""", (member["id"], room_id, session_id, client))


def answers_direct_question(payload):
    """A discussion message that closes the user's direct question: it names an execution or the requests it answers."""
    return type(payload.get("execution_id")) is int or bool(payload.get("request_ids"))


def append_message(connection, room_id, payload, actor):
    """Atomically append an attributed message for the owner or one member, as authorized by `actor`."""
    message_values(payload)
    begin_write(connection)
    return append_free_message(connection, require_room(connection, room_id), payload, actor)


def post_queued(connection, room_id, payload, actor):
    """Post a queued owner message through the normal path; the queue already checked that the room is not archived."""
    message_values(payload)
    return append_free_message(connection, {"id": room_id, "archived": False}, payload, actor)


def check_queued(payload):
    """Validate an edited queued message as the composer's message would be."""
    message_values(payload)


def drain_room_queue(connection, room_id):
    """Post queued owner messages that may go now; called after writes that can leave the room idle."""
    drain_queue(connection, room_id, post_queued)


def rate_scheduler_decision(connection, room_id, decision_id, token, payload):
    """The owner marks a decision good or bad (a bad one may name who should have answered and why); rating null withdraws it."""
    begin_write(connection)
    require_owner(connection, room_id, token)
    rating, should_be, note = payload.get("rating"), payload.get("should_be", ""), payload.get("note", "")
    if rating not in ("good", "bad", None):
        raise ValueError("rating 须为 good、bad 或 null")
    if not isinstance(should_be, str) or not isinstance(note, str) or len(should_be) > MAX_DECISION_MEMBER or len(note.strip()) > MAX_DECISION_NOTE:
        raise ValueError(f"should_be 须为成员名，note 不超过 {MAX_DECISION_NOTE} 字")
    if not connection.execute("SELECT 1 FROM scheduler_decisions WHERE id=? AND room_id=?", (decision_id, room_id)).fetchone():
        raise LookupError("没有这条智能调度决策")
    if rating is None:
        connection.execute("DELETE FROM scheduler_feedback WHERE decision_id=?", (decision_id,))
    else:
        connection.execute("""INSERT INTO scheduler_feedback (decision_id,rating,should_be,note,created_at) VALUES (?,?,?,?,?)
            ON CONFLICT(decision_id) DO UPDATE SET rating=excluded.rating,should_be=excluded.should_be,note=excluded.note,created_at=excluded.created_at""",
                           (decision_id, rating, should_be.strip(), note.strip(), utc_now()))
    if rating == "bad":
        save_feedback_case(connection, room_id, decision_id, should_be.strip(), note.strip())
    else:
        connection.execute("DELETE FROM scheduler_feedback_cases WHERE decision_id=?", (decision_id,))
    return {"decision_id": decision_id, "feedback": rating, "should_be": should_be.strip(), "note": note.strip()}


def save_feedback_case(connection, room_id, decision_id, should_be, note):
    """Copy a bad-rated decision with everything the model saw, so it outlives its room for prompt review."""
    decision = dict(connection.execute(f"{DECISION_SELECT} WHERE d.id=?", (decision_id,)).fetchone())
    stored = {name: connection.execute(f"SELECT {column} FROM {table} WHERE decision_id=?", (decision_id,)).fetchone()
              for name, table, column in (("detail", "scheduler_decision_details", "detail"), ("input", "scheduler_decision_inputs", "input"))}
    snapshot = {key: decision[key] for key in ("kind", "after_message_id", "label", "confidence", "applied", "provider", "created_at")}
    snapshot["context"] = json.loads(decision["context"]) if decision["context"] else None
    snapshot.update({name: json.loads(row[0]) if row else None for name, row in stored.items()})
    title = connection.execute("SELECT title FROM rooms WHERE id=?", (room_id,)).fetchone()[0]
    connection.execute("""INSERT OR REPLACE INTO scheduler_feedback_cases (decision_id,room_id,room_title,snapshot,should_be,note,rated_at)
        VALUES (?,?,?,?,?,?,?)""", (decision_id, room_id, title, json.dumps(snapshot, ensure_ascii=False), should_be, note, utc_now()))


def list_feedback_cases(connection, after):
    """Bad-rated decision snapshots after a decision id, oldest first, for the administrator's prompt review."""
    rows = connection.execute("SELECT * FROM scheduler_feedback_cases WHERE decision_id>? ORDER BY decision_id LIMIT ?",
                              (after, FEEDBACK_CASES_PAGE)).fetchall()
    cases = [{**dict(row), "snapshot": json.loads(row["snapshot"])} for row in rows]
    return {"cases": cases, "next_after": cases[-1]["decision_id"] if len(cases) == FEEDBACK_CASES_PAGE else None}


def mark_scheduler_routing(connection, room_id, token, payload):
    """The local service marks a message while the decision model is analysing it, and clears the mark when done."""
    begin_write(connection)
    require_owner(connection, room_id, token)
    message_id, active = payload.get("message_id"), payload.get("active")
    if type(message_id) is not int or message_id <= 0 or type(active) is not bool:
        raise ValueError("须提供正整数 message_id 与布尔 active")
    if active:
        connection.execute("INSERT OR REPLACE INTO scheduler_routing (room_id,message_id,created_at) VALUES (?,?,?)", (room_id, message_id, int(time.time())))
    else:
        connection.execute("DELETE FROM scheduler_routing WHERE room_id=? AND message_id=?", (room_id, message_id))
    return {"message_id": message_id, "active": active}


def record_scheduler_decision(connection, room_id, token, payload):
    """The local service records one smart-scheduling decision, with the owner credential, so the transcript shows what it did and how sure it was."""
    begin_write(connection)
    require_owner(connection, room_id, token)
    kind, label, confidence = payload.get("kind"), payload.get("label"), payload.get("confidence")
    after = payload.get("after_message_id", 0)
    if kind not in ("interjection", "round") or not isinstance(label, str) or not 0 < len(label.strip()) <= MAX_DECISION_LABEL:
        raise ValueError(f"决策记录须有 kind（interjection/round）与 1–{MAX_DECISION_LABEL} 字的 label")
    if confidence is not None and (type(confidence) not in (int, float) or not 0 <= confidence <= 1):
        raise ValueError("confidence 须为 0–1 或 null")
    if payload.get("provider") not in SCHEDULER_PROVIDERS or type(payload.get("applied")) is not bool or type(after) is not int or after < 0:
        raise ValueError("须提供供应商 provider、是否执行 applied 与非负的 after_message_id")
    cursor = connection.execute("""INSERT INTO scheduler_decisions (room_id,after_message_id,kind,label,confidence,applied,provider,created_at)
        VALUES (?,?,?,?,?,?,?,?)""", (room_id, after, kind, label.strip(), confidence, int(payload["applied"]), payload["provider"], utc_now()))
    context = payload.get("context")
    if context is not None:
        text = json.dumps(context, ensure_ascii=False)
        if not isinstance(context, dict) or len(text) > MAX_DECISION_CONTEXT:
            raise ValueError(f"context 须为不超过 {MAX_DECISION_CONTEXT} 字的对象")
        connection.execute("INSERT INTO scheduler_decision_context (decision_id,context) VALUES (?,?)", (cursor.lastrowid, text))
    detail = payload.get("detail")
    if detail is not None:
        text = json.dumps(detail, ensure_ascii=False)
        if not isinstance(detail, list) or len(detail) > 4 or len(text) > MAX_DECISION_DETAIL:
            raise ValueError(f"detail 须为最多 4 项、不超过 {MAX_DECISION_DETAIL} 字的列表")
        connection.execute("INSERT INTO scheduler_decision_details (decision_id,detail) VALUES (?,?)", (cursor.lastrowid, text))
    model_input = payload.get("input")
    if model_input is not None:
        text = json.dumps(model_input, ensure_ascii=False)
        if not isinstance(model_input, dict) or len(text) > MAX_DECISION_INPUT:
            raise ValueError(f"input 须为不超过 {MAX_DECISION_INPUT} 字的对象")
        connection.execute("INSERT INTO scheduler_decision_inputs (decision_id,input) VALUES (?,?)", (cursor.lastrowid, text))
    return dict(connection.execute("SELECT * FROM scheduler_decisions WHERE id=?", (cursor.lastrowid,)).fetchone())


def scheduler_decision_view(connection, room_id, decision_id, token):
    """Read one room-bound decision and its full evidence, outside the recent-room window."""
    if session_read_boundary(connection, room_id, token) is not None:
        raise PermissionError("独立观点阶段不能读取智能调度判断")
    row = connection.execute(f"{DECISION_SELECT} WHERE d.room_id=? AND d.id=?", (room_id, decision_id)).fetchone()
    if not row:
        raise LookupError("决策记录不存在")
    result = dict(row)
    for field, table in (("detail", "scheduler_decision_details"), ("input", "scheduler_decision_inputs")):
        value = connection.execute(f"SELECT {field} FROM {table} WHERE decision_id=?", (decision_id,)).fetchone()
        result[field] = json.loads(value[0]) if value else None
    if result.get("context"):
        result["context"] = json.loads(result["context"])
    return result


def message_filters(room_id, params):
    """Build exact and incremental filters without expanding the read scope."""
    query = str(params.get("q", "")).strip()
    author = str(params.get("author", "")).strip()
    mention = str(params.get("mention", "")).strip()
    clauses = ["room_id=?"]
    values = [room_id]
    clauses.append("NOT EXISTS (SELECT 1 FROM internal_task_messages task WHERE task.message_id=messages.id)")
    if query:
        clauses.append("(instr(lower(messages.text), lower(?)) > 0 OR CAST(messages.id AS TEXT)=?)")
        values.extend([query, query.lstrip("#")])
    if author:
        clauses.append("messages.author=?")
        values.append(author)
    if mention:
        clauses.append("instr(messages.text, ?) > 0")
        values.append(f"@{mention}")
    if "kind" in params:
        if params["kind"] not in ("opinion", "moderation", "receipt", "chat"):
            raise ValueError("发言职责无效")
        clauses.append("COALESCE(details.kind,'opinion')=?")
        values.append(params["kind"])
    if params.get("host") == "1":
        # Host view: moderation notes plus whatever the current host said.
        clauses.append("(COALESCE(details.kind,'opinion')='moderation' OR messages.author=(SELECT host FROM topic_settings WHERE room_id=?))")
        values.append(room_id)
    if "submission_id" in params:
        clauses.append("submission_id=?")
        values.append(submission_value(params["submission_id"]))
    if "after" in params:
        after = int(params["after"])
        if after < 0 or int(params.get("page", 1)) != 1:
            raise ValueError("after 需为非负消息编号，不能与翻页同时使用")
        clauses.append("messages.id>?")
        values.append(after)
    if params.get("withdrawn") != INCLUDE_WITHDRAWN:
        clauses.append("withdrawn.message_id IS NULL")
    return " AND ".join(clauses), values


def query_messages(connection, room_id, params, token=""):
    """Read one bounded page; incremental cursors advance only through returned rows."""
    require_room(connection, room_id)
    page = max(1, int(params.get("page", 1)))
    size = min(MAX_PAGE_SIZE, max(1, int(params.get("limit", PAGE_SIZE))))
    cutoff = session_message_access(connection, room_id, params, token)
    where, values = message_filters(room_id, params)
    if cutoff is not None:
        where += " AND messages.id<=?"
        values.append(cutoff)
    total = connection.execute(f"SELECT COUNT(*) FROM ({MESSAGE_QUERY} WHERE {where})", values).fetchone()[0]
    rows = connection.execute(f"{MESSAGE_QUERY} WHERE {where} ORDER BY messages.id LIMIT ? OFFSET ?", [*values, size + 1, (page - 1) * size]).fetchall()
    messages = [message_with_attachments(connection, row) for row in rows[:size]]
    result = {"messages": messages, "page": page, "total": total,
              "pages": max(1, (total + size - 1) // size)}
    if "after" in params:
        result.update(next_after=messages[-1]["id"] if messages else int(params["after"]), has_more=len(rows) > size)
    return result


def get_message(connection, room_id, message_id, params=None, token=""):
    """Read an exact message, constrained to the specified room."""
    params = params or {}
    cutoff = session_message_access(connection, room_id, params, token)
    where, values = message_filters(room_id, params)
    if cutoff is not None:
        where += " AND messages.id<=?"
        values.append(cutoff)
    row = connection.execute(f"{MESSAGE_QUERY} WHERE {where} AND messages.id=?", [*values, message_id]).fetchone()
    if row is None:
        raise LookupError("消息不存在")
    return message_with_attachments(connection, row)


def update_state(connection, room_id, payload):
    """Save detailed state and an optional human-facing brief in one transaction."""
    text = str(payload.get("text", "")).strip()
    brief = str(payload.get("brief", "")).strip()
    if len(text) > MAX_STATE_LENGTH or len(brief) > MAX_BRIEF_LENGTH:
        raise ValueError(f"讨论状态最多 {MAX_STATE_LENGTH} 字，主持简报最多 {MAX_BRIEF_LENGTH} 字")
    room = require_room(connection, room_id)
    require_host(room, {"actor": payload.get("actor", "用户")})
    until = int(payload.get("until", room["latest_id"]))
    if until < 0 or until > room["latest_id"]:
        raise ValueError("讨论状态的截止编号无效")
    saved_brief = connection.execute("SELECT until FROM room_briefs WHERE room_id=?", (room_id,)).fetchone()
    if "brief" in payload and saved_brief and until < saved_brief["until"]:
        raise ValueError(f"简报已整理至 #{saved_brief['until']}，截止编号不能回退；请先读取最新状态")
    connection.execute("UPDATE rooms SET state_text=?,state_until=? WHERE id=?", (text, until, room_id))
    if "brief" in payload:
        connection.execute("""INSERT INTO room_briefs (room_id,text,until,updated_at) VALUES (?,?,?,?)
            ON CONFLICT(room_id) DO UPDATE SET text=excluded.text,until=excluded.until,updated_at=excluded.updated_at""",
                           (room_id, brief, until, utc_now()))
    session = current_session(connection, room_id, active_only=True)
    if session:
        held_since = connection.execute("SELECT held_since FROM session_state WHERE session_id=?", (session["id"],)).fetchone()[0]
        if held_since and until >= held_since:
            connection.execute("UPDATE session_state SET held_since=0,revision=revision+1 WHERE session_id=?", (session["id"],))
    return require_room(connection, room_id)


def state_reading_text(room):
    """Read the host's brief explicitly without adding it to independent-entry overviews."""
    brief = room.get("host_brief")
    overview = f"主持简报（整理至 #{brief['until']}，{brief['updated_at']}）\n{brief['text']}" if brief and brief["text"] else "主持简报：尚未更新"
    return f"{overview}\n\n主持人维护的状态（整理至 #{room['state_until']}）\n\n{room['state_text'] or '尚未整理'}"


def message_text(message):
    """Render an original message with its provenance and reply reference."""
    reply = f" · 回复 #{message['reply_to']}" if message["reply_to"] else ""
    role = {"moderation": "主持发言", "receipt": "运行回执", "chat": "协作消息"}.get(message.get("kind"), "专家观点")
    summary = f"\n回答摘要（{message['summary_by']}）：\n{message['summary']}\n\n完整正文：\n" if message.get("summary") else "\n"
    attachments = "".join(f"\n附件：{item['file_name']}（{item['size']} 字节；ID: {item['id']}）\n{item['download_url']}"
                          for item in message.get("attachments", []))
    return f"#{message['id']} · {message['author']} · {message['created_at']}{reply}\n职责：{role}；来源：{message['source']}；提交者：{message.get('submitted_by', '用户')}{summary}{message['text']}{attachments}"


def room_text(connection, room_id, params):
    """Expose only an overview; readers choose which supporting pages to open."""
    room = require_room(connection, room_id)
    base = f"/r/{room_id}"
    content = [f"# {room['title']}", f"目标：{room['goal']}",
               f"主持人：{room['host']}；阶段：{PHASES[room['phase']]}；当前焦点：{room['focus'] or '尚未填写'}",
               f"当前记录截止 #{room['latest_id']}；共 {room['message_count']} 条；已完成 {room['completed_rounds']} 轮讨论（所有参与专家各发言一次）。"]
    limits = room["limits"]
    content.append(f"讨论上限：{limits['max_rounds'] or '不限'} 轮；总时长 {limits['max_minutes'] or '不限'} 分钟；到限后讨论结束，房间回到自由协作。到限：{limits['reached']}。")
    participant = params.get("participant", params.get("for"))
    members = "；".join(f"{item['name']}（已读至 #{item['read_until']}，待投递 {item['pending']}）" for item in room["free"]["members"])
    if current_session(connection, room_id, active_only=True):
        current = room.get("current_turn")
        assignment = f"当前安排 #{current['id']}：{current['expert']}" if current else "当前没有专家安排"
        content.append(f"讨论会话处于{PHASES[room['phase']]}；{assignment}。其余成员安排按队列执行。成员：{members or '无'}。专家回答须关联本次执行或手动请求，已结束的执行或失效请求不能改作普通发言。")
    else:
        content.append(f"自由协作房间：无发言权、安排与轮次。成员：{members or '无'}。用户的消息点名成员后生成请求；成员回答须带本次执行编号，执行结束、被打断或过期后的回答会被拒绝，不能改作普通发言。")
    content.extend(["", "## 按需展开", f"背景、边界与参与专家：{base}/brief",
                    f"共识与分歧（整理至 #{room['state_until']}）：{base}/state",
                    "## 读取与检索", f"完整历史（分页）：{base}/messages?page=1",
                    f"单条原文：{base}/messages/消息编号", f"检索：{base}/search?q=关键词&page=1",
                    f"按作者检索：{base}/search?author=Claude", f"发言安排历史：{base}/turns?page=1"])
    if participant:
        content.append(f"与 @{participant} 相关的观点：{base}/search?mention={participant}&page=1")
    content.extend(participation_text())
    return "\n\n".join(content)


def participation_text():
    """Readers are local AIs; they follow the skills rather than a guide embedded here."""
    return ["", "## 本地 AI", "本地 AI 请调用 discuss-participant（主持人另调用 discuss-host），用 codiscuss 命令读写；"
            "字段与写入规则以 codiscuss room protocol 为准，不直接调用网站接口。",
            "主持人可以兼任专家；作者、职责与来源尚未认证。"]


def brief_text(room):
    """Render the detailed brief only when explicitly requested."""
    experts = "\n".join(f"- {name}" for name in room["experts"])
    return f"# {room['title']} · 话题资料\n\n目标：{room['goal']}\n\n用户原文：\n{room['user_request'] or '未填写'}\n\n背景：\n{room['background'] or '未填写'}\n\n边界：\n{room['boundaries'] or '未填写'}\n\n主持人：{room['host']}（可兼任专家）\n\n参与专家：\n{experts}"


def turn_text(turn, room):
    """Render a discussion assignment without embedding discussion context."""
    room_id = room["id"]
    answer_id = turn.get("answer_id")
    answer = f"\n回答原文：/r/{room_id}/messages/{answer_id}" if answer_id else ""
    label = turn.get("status_label") or (pending_label(room, turn["expert"]) if turn["status"] == "open"
                                         else REQUEST_STATUSES.get(turn["status"], turn["status"]))
    association = f"关联请求：{turn.get('member_request_id') or '尚未派发'}"
    return f"安排 #{turn['id']} · {turn['expert']} · {label}\n待回应问题：{turn['question']}\n话题入口：/r/{room_id}?participant={turn['expert']}\n{association}{answer}\n本地成员凭自己的请求或执行保存完整回答，较长回答可附摘要。"


def protocol_text(room):
    """Describe the unified request/execution protocol separately from discussion material."""
    base = f"/api/rooms/{room['id']}"
    paragraphs = [
        "# 协作房间参与协议",
        "当前主持人：HOST。讨论是房间内的会话；自由协作请求与讨论请求共用成员执行。",
        "先用 room view 读取成员、职责、free.requests、session 与阶段，再按需读取原文。任务中的 purpose=discuss 表示讨论发言，discuss_host 表示主持任务，ask 表示直接提问；内部任务来源不是普通发言。",
        "用户管理和讨论开关使用房主凭据；本地成员使用本人的 --access-file，不借用其他身份。凭据私下交付，不公开 token。API 参与者遵循相同请求与执行约束，source=api；本地 CLI 使用 source=cli。",
        "runner 成员等待本机接入程序交付任务，用 execution view 核对本次执行和请求，再以 message post --as 本人 --kind chat --execution 本次编号 --access-file FILE 回答。执行失效后保留草稿，不能去掉编号改作普通发言；认领、续租与后续投递由接入程序处理。",
        "manual 本地成员首次用 member register 注册，会话 ID 由 CLI 自动取得；回答用 --request 请求编号，不编造执行编号。讨论不使用原生定时；原会话不能托管时由用户触发。",
        "自由协作中的 host 可用 --to 点名成员，route 表示未点名的用户请求，handoff 表示派出任务已结束；链上 AI 派活受房间预算限制。--to 多位并加 --sequential 时按点名顺序依次接力，每棒一轮，最后交回主持人；--with 成员 与紧挨在前的 --to 同一棒同时做，这一组全部结束才交下一棒；--detach 成员 与这次派活同时开工但不等它（失败时通知主持人）；再加 --loop 则交回为检查点，用 sequence continue --request 交接请求编号 开始下一圈，不继续即直接验收。普通成员的 --to 或正文 @ 只保存回应建议，不直接唤醒；不点名自己、不扩大授权。",
        "讨论中的用户 @ 直接提问独立排队，不计讨论轮次、不与讨论发言合并。initial 阶段先独立判断；服务端按讨论请求的 read_until 限制读取。直接提问和主持任务不继承该阅读限制。",
        "主持安排前先 turn roster 读取在场专家、waiting、unregistered 和 revision，再 turn create --roster revision；单项和多项都要带凭据，多项计划须覆盖本轮 waiting。继续排队同样先读 roster，再 turn continue --roster revision。状态或新消息变化后旧凭据被拒绝，重新读取再判断；每个回答保存后由程序推进下一项。",
        "局部追问先 turn roster 读取 host_requests 的请求与原消息编号，再 turn ask --request ID --expert NAME --roster revision --submission-id UUID；普通提问不计轮次、不改讨论队列，可问已发言者和主持人，只结束指定请求。",
        "计划或收束成功即完成本次主持执行，无需再提交回答回执。主持说明使用 kind=moderation，不替代专家回答，也不会完成主持执行；主持人作为专家发言须回答自己的 discuss 请求。",
        "讨论状态读取 GET BASE/discussion；房主先读取 revision，再 POST 同路径提交 start、pause、resume 或 end。CLI 对应 run view/start/pause/resume/stop。开启可携带 submission_id，原编号与原内容重试返回原会话，已结束的会话不会因重试恢复。",
        "room limits 返回轮次、时长和进度；到限立即结束讨论并回到自由协作，不再唤醒主持人总结。暂停不计时，并作废讨论请求和执行；恢复生成新任务，旧执行不得继续写。",
        "原会话送达失败可等待 60 秒后自动重试，最多 3 次；重试用尽只失败该请求，并交回主持人判断跳过、重排或暂停，不自动暂停整场。结果不明的写入不作为新提交重发。",
        "保存 state 与主持简报时，until 只覆盖实际已读原文。主动收束前先保存有依据的总结与状态，再 room conclusion 获取 blockers 和 revision，无阻碍后用 room limits --done --conclusion revision；有未处理内容或状态变化时拒绝收束。",
        "message list --after 按 next_after/has_more 增量读取；message view 核对原文；历史可筛选 opinion/moderation/chat。内部任务不出现在普通消息列表、搜索和统计中，也没有普通发言的撤回或编辑入口。",
        "附件用 attachment upload/download，最多 10 个、单个 20 MiB；自动成员在完成执行前上传。回答正文最多 32000 个 Unicode 字符，摘要最多 1000 字，较长回答才附摘要，完整原文不截断。",
        "每次新内容使用新 submission_id，同次重试沿用编号、原文、凭据和执行/请求关联。按 submission_id 查询持久结果；读取失败不表示未写入，不能换身份或编号绕过拒绝。"
]
    return "\n\n".join(paragraphs).replace("HOST", room["host"]).replace("BASE", base)


def update_frame(rooms):
    """Encode a change event; `rooms` lists the changed rooms, and without it every room may have changed."""
    return f"event: change\ndata: {json.dumps({'rooms': rooms} if rooms else {})}\n\n".encode("utf-8")


class DiscussionServer(ThreadingHTTPServer):
    """HTTP server carrying the configured SQLite path."""

    daemon_threads = True
    # Every open page refreshes at once and the runner reads in bursts; Windows refuses connections beyond the backlog.
    request_queue_size = 128
    allow_reuse_address = os.name != "nt"
    allow_reuse_port = False

    def __init__(self, address, database, local_launch=False, hub=None):
        """Listen on one address; with `hub`, act as that site's remote entry, sharing its updates but requiring login.

        A remote entry is reached through a tunnel that connects from this computer, so its loopback address must not
        make every visitor the administrator, and it never offers local launch.
        """
        self.database = Path(database)
        # The server whose update stream this one shares; a site's local and remote entries see the same changes.
        self.hub = hub or self
        self.updates = threading.Condition()
        self.update_version = 0
        # Recent (version, room id or None) pairs, so a stream names the rooms that changed; None means the whole site.
        self.update_log = collections.deque(maxlen=UPDATE_LOG_SIZE)
        self.updates_closed = False
        if local_launch and (address[0] != "127.0.0.1" or hub):
            raise ValueError("本机启动入口须绑定 127.0.0.1")
        self.local_launch = local_launch
        self.local_site = not hub and address[0] in ("127.0.0.1", "::1", "localhost")
        self.admin_setup_key = os.getenv("DISCUSS_ADMIN_SETUP_KEY") or secrets.token_urlsafe(18)
        service_home = os.getenv("DISCUSS_SERVICE_HOME")
        self.connections_file = Path(service_home) / "site-connections.json" if service_home else None
        super().__init__(address, DiscussionHandler)

    def server_bind(self):
        """Keep each listening port exclusive while allowing normal Unix restarts."""
        if os.name == "nt":
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()

    def notify_update(self, room_id=None):
        """Wake subscribers after a committed business write to one room, or to the site when no room is given."""
        with self.updates:
            self.update_version += 1
            self.update_log.append((self.update_version, room_id))
            self.updates.notify_all()

    def changed_rooms(self, version):
        """Return the rooms changed after a version, or None when the site changed or the log no longer reaches it."""
        entries = [room for number, room in self.update_log if number > version]
        if len(entries) < self.update_version - version or None in entries:
            return None
        return sorted(set(entries))

    def server_close(self):
        """Release streaming clients when the HTTP server stops."""
        with self.hub.updates:
            self.updates_closed = True
            self.hub.updates.notify_all()
        super().server_close()


# The administrator login lives in an HttpOnly cookie (same name and lifetime as backend/worker.mjs).
ADMIN_COOKIE = "codiscuss_admin"
ADMIN_COOKIE_SECONDS = 30 * 86400


class DiscussionHandler(BaseHTTPRequestHandler):
    """Serve the browser UI and explicit plain-text discussion endpoints."""

    def log_message(self, message_format, *args):
        """Log request paths without message text stored in URL queries."""
        logging.info("%s %s", self.command, urlsplit(self.path).path)

    def respond(self, body, status=200, content_type="application/json"):
        """Send a UTF-8 response that browsers and proxies must not cache."""
        parts = urlsplit(self.path).path.strip("/").split("/")
        action = (getattr(self, "payload_cache", None) or {}).get("action")
        # Timeline segments are read by the timeline page on its own schedule, so they wake no other page.
        quiet_renewal = parts[3:4] == ["executions"] and action in ("renew", "segments")
        # Remembering the opened room changes nothing another page shows, so it wakes none of them.
        if (self.command == "POST" and 200 <= status < 300 and parts[:2] in (["api", "rooms"], ["api", "folders"])
                and not quiet_renewal and parts != ["api", "rooms", "last"]):
            self.server.hub.notify_update(parts[2] if parts[:2] == ["api", "rooms"] and len(parts) > 3 else None)
        # Every room write, accepted or rejected, goes to the room's event log once the request's connection is closed.
        created = parts == ["api", "rooms"] and status == 201 and isinstance(body, dict) and body.get("id")
        if self.command == "POST" and parts[:2] == ["api", "rooms"] and (len(parts) > 3 or created) and not quiet_renewal:
            self.api_record = {"room_id": parts[2] if len(parts) > 3 else body["id"], "at": getattr(self, "started_ms", int(time.time() * 1000)),
                               "method": self.command, "path": "/" + "/".join(parts[3:]), "status": status,
                               "client": self.headers.get("User-Agent", "").split(" ")[0][:60], "bridged": bool(getattr(self, "bridged", False)),
                               "token": self.headers.get("X-Discussion-Token", ""),
                               "payload": getattr(self, "payload_cache", None) or getattr(self, "request_params", {}),
                               "error": body.get("error", "") if status >= 400 and isinstance(body, dict) else ""}
        if content_type == "application/json":
            body = json.dumps(body, ensure_ascii=False)
        data = body.encode("utf-8") if isinstance(body, str) else body
        # The room list and a room's view carry a hash of their bytes; a page that already holds them gets 304 and no body.
        if self.command == "GET" and status == 200 and parts[:2] == ["api", "rooms"] and len(parts) in (2, 3):
            self.etag = f'"{hashlib.sha256(data).hexdigest()[:32]}"'
            if self.headers.get("If-None-Match") == self.etag:
                status, data = 304, b""
        if getattr(self, "api_record", None):
            # A logged write answers only after its record is stored, so a client that reads the log next sees it.
            self.deferred_response = (status, content_type, data)
            return
        self.send_payload(status, content_type, data)

    def send_payload(self, status, content_type, data):
        """Write the status line, headers and encoded body."""
        self.send_response(status)
        self.send_header("Content-Type", f"{content_type}; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        if getattr(self, "etag", None):
            self.send_header("ETag", self.etag)
            self.etag = None
        self.send_header("Referrer-Policy", "no-referrer")
        if getattr(self, "login_cookie", None) is not None:
            self.send_header("Set-Cookie", f"{ADMIN_COOKIE}={self.login_cookie}; Path=/; HttpOnly; Secure; SameSite=Strict; "
                                           f"Max-Age={ADMIN_COOKIE_SECONDS if self.login_cookie else 0}")
            self.login_cookie = None
        if getattr(self, "bridge_origin", None):
            self.send_header("Access-Control-Allow-Origin", self.bridge_origin)
            self.send_header("Vary", "Origin")
            if self.command == "OPTIONS":
                self.send_header("Access-Control-Allow-Methods", "GET, POST")
                self.send_header("Access-Control-Allow-Headers", "Content-Type, X-CoDiscuss-Local, X-CoDiscuss-Connection")
                if self.headers.get("Access-Control-Request-Private-Network") == "true":
                    self.send_header("Access-Control-Allow-Private-Network", "true")
        self.end_headers()
        self.wfile.write(data)

    def read_payload(self, limit=MAX_BODY_BYTES):
        """Read a bounded JSON object from an incoming form API request."""
        if getattr(self, "payload_cache", None) is not None:
            return self.payload_cache
        length = int(self.headers.get("Content-Length", "0"))
        if not 0 < length <= limit:
            raise ValueError("请求内容为空或过大")
        payload = json.loads(self.rfile.read(length))
        if not isinstance(payload, dict):
            raise ValueError("请求必须是 JSON 对象")
        self.payload_cache = payload
        return payload

    def dispatch(self, method):
        """Route a request and consistently report validation or lookup errors."""
        self.payload_cache = None
        self.bridge_origin = None
        self.api_record = None
        self.deferred_response = None
        self.started_ms = int(time.time() * 1000)
        parsed = urlsplit(self.path)
        params = {key: values[-1] for key, values in parse_qs(parsed.query).items()}
        self.request_params = params
        parts = parsed.path.strip("/").split("/")
        text_mode = parts[0] == "r"
        self.bridged = False
        try:
            return self.dispatch_routes(method, parsed, params, parts, text_mode)
        finally:
            if self.api_record:
                record_api_event(self.server.database, self.api_record)
                self.api_record = None
            if self.deferred_response:
                self.send_payload(*self.deferred_response)

    def dispatch_routes(self, method, parsed, params, parts, text_mode):
        """Route one request and map validation, permission and lookup errors to their status codes."""
        try:
            self.bridged = self.relay_bridge(parts)
            if parts[:2] == ["api", "local"]:
                return self.handle_local_launch(parts, method)
            if parts == ["api", "updates"] and method == "GET":
                return self.stream_updates()
            if method == "GET" and parsed.path in ASSETS:
                filename, content_type = ASSETS[parsed.path]
                return self.respond((WEB_ROOT / filename).read_bytes(), content_type=content_type)
            if method == "GET" and parsed.path == "/robots.txt":
                return self.respond("User-agent: *\nAllow: /\n", content_type="text/plain")
            with closing(connect_db(self.server.database)) as connection, connection:
                if text_mode and method == "GET":
                    return self.handle_text(connection, parts, params)
                return self.handle_api(connection, parts, params, method)
        except AdminError as error:
            return self.respond({"error": str(error)}, error.status)
        except PermissionError as error:
            return self.respond({"error": str(error)}, 403)
        except (ValueError, TypeError) as error:
            return self.respond(str(error) if text_mode else {"error": str(error)}, 400,
                                "text/plain" if text_mode else "application/json")
        except LookupError as error:
            return self.respond(str(error) if text_mode else {"error": str(error)}, 404,
                                "text/plain" if text_mode else "application/json")
        except FileExistsError as error:
            return self.respond(str(error) if text_mode else {"error": str(error)}, 409,
                                "text/plain" if text_mode else "application/json")
        except Exception:
            logging.exception("Request failed")
            return self.respond({"error": "服务器内部错误"}, 500)

    def do_GET(self):
        """Handle read-only GET requests."""
        self.dispatch("GET")

    def do_POST(self):
        """Handle JSON mutations and explicit binary attachment uploads."""
        self.dispatch("POST")

    def stream_updates(self):
        """Stream invalidations without holding a database connection or exposing records."""
        self.close_connection = True
        self.connection.settimeout(5)
        hub = self.server.hub
        with hub.updates:
            version = hub.update_version
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        try:
            self.wfile.write(b"retry: 3000\nevent: ready\ndata: {}\n\n")
            self.wfile.flush()
            while True:
                with hub.updates:
                    hub.updates.wait_for(
                        lambda: hub.update_version != version or hub.updates_closed or self.server.updates_closed,
                        timeout=UPDATE_HEARTBEAT_SECONDS)
                    if hub.updates_closed or self.server.updates_closed:
                        return
                    changed = hub.update_version != version
                    rooms = hub.changed_rooms(version) if changed else None
                    version = hub.update_version
                self.wfile.write(update_frame(rooms) if changed else b": keepalive\n\n")
                self.wfile.flush()
        except OSError:
            pass

    def do_OPTIONS(self):
        """Handle preflight only for explicitly connected websites on the local bridge."""
        if urlsplit(self.path).path.startswith("/api/local/"):
            return self.dispatch("OPTIONS")
        return self.respond({"error": "地址不存在"}, 404)

    def local_request_site(self, method):
        """Authenticate a local page or a site-bound browser connection before reading configuration."""
        if not self.server.local_launch:
            raise LookupError("本机启动未启用，请使用 python server.py --local-launch")
        allowed_hosts = {f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}"}
        host = self.headers.get("Host", "")
        origin = self.headers.get("Origin")
        if self.client_address[0] != "127.0.0.1" or host not in allowed_hosts:
            raise PermissionError("本机启动只接受本机同源请求")
        if origin and origin != f"http://{host}":
            return self.connected_request_site(origin, method)
        if (method == "OPTIONS" or self.headers.get("X-CoDiscuss-Local") != "1"
                or self.headers.get("Sec-Fetch-Site", "same-origin") not in ("same-origin", "none")):
            raise PermissionError("本机启动只接受本机同源请求")
        return f"http://{host}"

    def connected_request_site(self, origin, method):
        """Require both an explicitly registered origin and its private connection credential."""
        path = self.server.connections_file
        settings = json.loads(path.read_text(encoding="utf-8")) if path and path.exists() else {}
        connection = settings.get("sites", {}).get(origin, {})
        # A website the runner relays for reaches this computer only through paired, signed and unlocked devices; a
        # browser credential kept from before would skip all of that.
        if connection.get("bridge_hash"):
            raise PermissionError("此网站经已配对设备的中转访问这台电脑，不再接受本机连接；请在设置 → 账号中配对这台设备")
        expected = connection.get("token_hash")
        if not isinstance(expected, str) or not expected:
            raise PermissionError("此网站尚未连接本机；请运行 codiscuss local connect 站点地址")
        self.bridge_origin = origin
        if method == "OPTIONS":
            headers = {value.strip().lower() for value in self.headers.get("Access-Control-Request-Headers", "").split(",")}
            allowed = {"content-type", "x-codiscuss-local", "x-codiscuss-connection"}
            if (self.headers.get("Access-Control-Request-Method") not in ("GET", "POST")
                    or not {"x-codiscuss-local", "x-codiscuss-connection"}.issubset(headers) or headers - allowed):
                raise PermissionError("连接请求不受支持")
            return origin
        credential = self.headers.get("X-CoDiscuss-Connection", "")
        if (self.headers.get("X-CoDiscuss-Local") != "1" or not re.fullmatch(r"[a-f0-9]{64}", credential)
                or not hmac.compare_digest(token_hash(credential), expected)):
            raise PermissionError("本机连接已失效，请重新运行 codiscuss local connect 站点地址")
        return origin

    def handle_local_launch(self, parts, method):
        """Forward authenticated browser requests to the shared Node entrypoint and pin their website."""
        site = self.local_request_site(method)
        route = parts[2:]
        if method == "OPTIONS" and route in (["settings"], ["launch"], ["room-models"], ["room-files"], ["execution-details"], ["room-member"], ["room-member-access"], ["room-member-allow"], ["room-member-adapter"], ["room-member-model"], ["room-profiles"], ["room-restore"], ["room-fork"], ["models"], ["api-key"], ["api-check"],
                                             ["scheduler-check"], ["tts-settings"], ["tts"], ["stt"], ["pick-directory"], ["browse-directory"], ["projects"], ["presets"], ["workflows"], ["room-workflow"], ["room-settings"], ["machine-link"], ["device-pairing"], ["devices"]):
            return self.respond({"ok": True})
        if route == ["settings"] and method in ("GET", "POST"):
            command = "settings"
        elif route == ["launch"] and method == "POST":
            command = "start"
        elif route == ["room-config"] and method == "POST" and not self.bridge_origin:
            command = "room-config"
        elif route == ["room-models"] and method == "POST":
            command = "room-models"
        elif route == ["models"] and method == "POST":
            command = "models"
        elif route == ["api-key"] and method == "POST":
            command = "api-key"
        elif route == ["api-check"] and method == "POST":
            command = "api-check"
        elif route == ["scheduler-check"] and method == "POST":
            command = "scheduler-check"
        elif route in (["tts-settings"], ["tts"], ["stt"]) and method == "POST":
            command = route[0]
        elif route in (["room-member"], ["room-member-access"], ["room-member-allow"], ["room-member-adapter"], ["room-member-model"]) and method == "POST":
            command = route[0]
        elif route in (["room-profiles"], ["room-files"], ["execution-details"], ["room-restore"], ["room-fork"]) and method == "POST":
            command = route[0]
        elif route == ["pick-directory"] and method == "POST":
            command = "pick-directory"
        elif route == ["browse-directory"] and method == "POST":
            command = "browse-directory"
        elif route in (["device-pairing"], ["devices"]) and method == "POST":
            # Which devices this computer trusts is decided at its own screen; a connected website's page cannot.
            if self.bridge_origin:
                raise PermissionError("设备配对与撤销只能在这台电脑的本机网页上操作，或在已配对的设备上操作")
            command = route[0]
        elif route == ["projects"] and method == "POST":
            command = "projects"
        elif route == ["presets"] and method == "POST":
            command = "presets"
        elif route in (["workflows"], ["room-workflow"], ["room-settings"]) and method == "POST":
            command = route[0]
        elif route == ["machine-link"] and method == "POST":
            command = "machine-link"
        else:
            raise LookupError("本机入口不存在")
        payload = None
        if method == "POST":
            if self.headers.get_content_type() != "application/json":
                raise ValueError("本机操作须使用 application/json")
            payload = self.read_payload()
            if command in ("start", "room-config", "room-models", "room-files", "execution-details", "room-member", "room-member-access", "room-member-allow", "room-member-adapter", "room-member-model", "room-profiles", "room-restore", "room-fork", "room-workflow", "room-settings", "workflows"):
                payload.pop("access_file", None)
                payload.update(site=site, entry="web")
            if command in ("room-files", "execution-details", "room-workflow", "room-settings", "room-member", "room-member-access", "room-member-allow", "room-member-model", "room-member-adapter") and not payload.get("token") and not self.bridge_origin:
                with closing(connect_db(self.server.database)) as connection:
                    self.admin_as_owner(connection, payload.get("room_id", ""))
                    payload["token"] = self.headers.get("X-Discussion-Token", "")
            # A fork from a browser without the source room's credential acts as its owner, as the commands above do.
            if command == "room-fork" and not payload.get("source_token") and not self.bridge_origin:
                with closing(connect_db(self.server.database)) as connection:
                    self.admin_as_owner(connection, payload.get("source_room_id", ""))
                    payload["source_token"] = self.headers.get("X-Discussion-Token", "")
            if command == "machine-link":
                payload = {"site": site}
        if command == "room-config" and "participants" in payload:
            return self.save_local_room_configuration(command, payload)
        # A connected website's page is another device's entry: it gets the same limits as the relay.
        return self.run_local_command(command, payload, remote=bool(self.bridge_origin) and command != "machine-link")

    def save_local_room_configuration(self, command, payload):
        """Keep session pause/revision validation and local file replacement in one boundary."""
        with closing(connect_db(self.server.database)) as connection, connection:
            begin_write(connection)
            room = require_room(connection, payload.get("room_id", ""))
            require_owner(connection, room["id"], payload.get("token", ""))
            discussion = session_room(connection, room["id"])
            revision = payload.get("session_revision", payload.get("runtime_revision"))
            if (room["archived"] or not discussion["session"] or discussion["session"]["status"] != "paused"
                    or discussion["revision"] != revision):
                raise FileExistsError("房间状态已变化，请暂停后重新读取本场配置")
            return self.run_local_command(command, payload, configuration_locked=True)

    def run_local_command(self, command, payload, configuration_locked=False, remote=False):
        """Run the fixed local Node entrypoint after the same-origin request checks."""
        arguments = ["node", str(ROOT / "runner" / "discussion_launch.mjs"), command]
        if remote:
            arguments.append("--remote")
        if command in ("start", "room-config"):
            arguments.append("--browser")
        if configuration_locked:
            arguments.append("--configuration-locked")
        if payload is not None:
            arguments.append("--stdin")
        try:
            result = subprocess.run(arguments, input=json.dumps(payload) if payload is not None else None,
                                    capture_output=True, encoding="utf-8", timeout=DIRECTORY_PICKER_TIMEOUT if command == "pick-directory" else LOCAL_LAUNCH_TIMEOUT,
                                    creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        except FileNotFoundError as error:
            raise ValueError("本机启动需要 Node.js 24+，请安装并加入 PATH") from error
        except subprocess.TimeoutExpired as error:
            if command == "pick-directory":
                raise ValueError("目录选择窗口已超时，请重试或直接输入完整路径") from error
            raise ValueError("启动结果未确认，请核对房间状态后沿用原配置重试") from error
        if result.returncode:
            try:
                failure = json.loads(result.stderr.strip())
            except ValueError:
                raise ValueError(result.stderr.strip())
            return self.respond(failure, 400)
        return self.respond(json.loads(result.stdout))

    def admin_token(self):
        """The administrator login from its HttpOnly cookie, or from the header scripts and tests use."""
        for item in self.headers.get("Cookie", "").split(";"):
            name, _, value = item.strip().partition("=")
            if name == ADMIN_COOKIE:
                return value
        return self.headers.get("X-Discussion-Admin", "")

    def local_visitor(self):
        """Whether this request may act as the loopback-only site's implicit administrator.

        The Host must name this loopback port, which defeats DNS rebinding, and a browser request must come from the site
        itself rather than another page. Programs on this computer can still send these headers; this guards browsers only.
        """
        if not self.server.local_site:
            return False
        host = self.headers.get("Host", "")
        if host not in (f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}"):
            return False
        origin = self.headers.get("Origin")
        if origin and origin != f"http://{host}":
            return False
        return self.headers.get("Sec-Fetch-Site", "same-origin") in ("same-origin", "none")

    def admin_session(self, connection):
        """Whether the request is from the administrator: a visitor of the loopback-only site itself, else a valid session."""
        return self.local_visitor() or session_valid(connection, self.admin_token())

    def relay_bridge(self, parts):
        """Whether this request comes from the runner relaying a paired device; a bad or misplaced bridge credential fails.

        The runner holds one bridge token per paired website and this site keeps only its hash. A bridged request acts
        as the administrator, so it is accepted only from this computer's loopback, on a loopback-only site, and only
        for room, folder and revision routes.
        """
        credential = self.headers.get("X-CoDiscuss-Bridge")
        if credential is None:
            return False
        path = self.server.connections_file
        settings = json.loads(path.read_text(encoding="utf-8")) if path and path.exists() else {}
        expected = settings.get("sites", {}).get(self.headers.get("X-CoDiscuss-Bridge-Site", ""), {}).get("bridge_hash")
        if (not self.server.local_site or self.client_address[0] != "127.0.0.1" or not isinstance(expected, str)
                or not re.fullmatch(r"[a-f0-9]{64}", credential) or not hmac.compare_digest(token_hash(credential), expected)):
            raise PermissionError("本机中转凭据无效，请在电脑上重新连接网站")
        if parts[:1] != ["api"] or parts[1:2] not in (["rooms"], ["folders"], ["revisions"]):
            raise PermissionError("本机中转不允许访问该地址")
        return True

    def admin_as_owner(self, connection, room_id):
        """Let a logged-in administrator, a relayed device, or a visitor of the loopback-only local site write as owner without
        the room credential: the local site already treats its visitors as the administrator. The remote entry is never local."""
        if self.headers.get("X-Discussion-Token") or not (self.bridged or self.local_visitor() or session_valid(connection, self.admin_token())):
            return
        row = connection.execute("SELECT control_hash FROM room_modes WHERE room_id=?", (room_id,)).fetchone()
        if row and row[0]:
            self.headers["X-Discussion-Token"] = owner_proxy_token(row[0])

    def handle_admin_api(self, connection, parts, method):
        """Serve administrator registration, login sessions and profile."""
        token = self.admin_token()
        if parts == ["api", "admin"] and method == "GET":
            result = admin_status(connection, token, True, self.server.local_site)
            connection.commit()
            return self.respond(result)
        now = int(time.time())
        if parts == ["api", "admin", "sessions"] and method == "GET" and not self.server.local_site:
            return self.respond(list_sessions(connection, token, now))
        if len(parts) != 3 or method != "POST":
            raise LookupError("地址不存在")
        payload = self.read_payload()
        if self.server.local_site and parts[2] != "profile":
            raise ValueError("本地站点无需管理员账号")
        # The remote entry sits behind Cloudflare Tunnel, which names the client; without it every attempt shares one address.
        source = self.headers.get("CF-Connecting-IP") or self.client_address[0]
        label = self.headers.get("User-Agent", "")
        actions = {"register": lambda: register_admin(connection, payload, self.server.admin_setup_key, now, label),
                   "login": lambda: login_admin(connection, payload, now, source, label),
                   "logout": lambda: logout_admin(connection, token),
                   "revoke": lambda: revoke_sessions(connection, token, payload, now),
                   "password": lambda: change_password(connection, token, payload, now, source),
                   "profile": lambda: update_profile(connection, token, payload, self.server.local_site)}
        if parts[2] not in actions:
            raise LookupError("地址不存在")
        result = actions[parts[2]]()
        connection.commit()
        # A new login goes into an HttpOnly cookie only, so page scripts never see the token; logging out clears it.
        if parts[2] in ("register", "login") and "token" in result:
            self.login_cookie = result.pop("token")
        elif parts[2] == "logout":
            self.login_cookie = ""
        return self.respond(result, 201 if parts[2] == "register" else 200)

    def handle_remote_launch_api(self, connection, parts, method):
        """Pair computers and relay room launches; a computer authenticates with its own token, everything else as the administrator."""
        now = int(time.time())
        if len(parts) in (4, 5) and parts[1] == "machines" and method == "POST" and (len(parts) == 4 and parts[3] == "sync" or parts[3:4] == ["launches"]):
            token = self.headers.get("X-Machine-Token", "")
            result = (machine_sync(connection, parts[2], token, self.read_payload(), now) if len(parts) == 4
                      else machine_launch_action(connection, parts[2], parts[4], token, self.read_payload(), now))
            connection.commit()
            return self.respond(result)
        if len(parts) == 5 and parts[1] == "machines" and parts[3] == "commands" and method == "POST":
            token = self.headers.get("X-Machine-Token", "")
            if parts[4] == "claim":
                return self.respond(self.wait_machine_commands(connection, parts[2], token, self.read_payload()))
            result = finish_machine_command(connection, parts[2], parts[4], token, self.read_payload(), now)
            connection.commit()
            return self.respond(result)
        if not self.admin_session(connection):
            raise AdminError("需要登录管理员账号", 401)
        if parts[1] == "machines" and parts[3:4] == ["commands"]:
            if len(parts) == 4 and method == "POST":
                result = submit_machine_command(connection, parts[2], self.read_payload(), now)
            elif len(parts) == 5 and method == "GET":
                result = machine_command_status(connection, parts[2], parts[4])
            else:
                raise LookupError("地址不存在")
            connection.commit()
            return self.respond(result)
        if parts == ["api", "machines"] and method == "GET":
            return self.respond(list_machines(connection, now))
        if parts == ["api", "machines"] and method == "POST":
            result = pair_machine(connection, self.read_payload(), now)
        elif parts == ["api", "remote-launches"] and method == "POST":
            result = submit_remote_launch(connection, self.read_payload(), now)
        elif len(parts) == 3 and parts[1] == "remote-launches" and method == "GET":
            return self.respond(remote_launch_status(connection, parts[2]))
        else:
            raise LookupError("地址不存在")
        connection.commit()
        return self.respond(result)

    def wait_machine_commands(self, connection, machine_id, token, payload):
        """Long-poll for relayed commands so a waiting device gets its answer without the computer's sync delay."""
        wait = payload.get("wait", 0)
        deadline = time.monotonic() + (min(max(wait, 0), COMMAND_WAIT_MAX) if isinstance(wait, (int, float)) else 0)
        while True:
            result = claim_machine_commands(connection, machine_id, token, int(time.time()))
            connection.commit()
            if result["commands"] or time.monotonic() >= deadline:
                return result
            time.sleep(MACHINE_COMMAND_POLL_SECONDS)

    def handle_api(self, connection, parts, params, method):
        """Handle room, state, and message operations used by the web UI."""
        if parts == ["api", "health"] and method == "GET":
            return self.respond({"ok": True})
        if parts[:2] == ["api", "admin"]:
            return self.handle_admin_api(connection, parts, method)
        if parts == ["api", "scheduler-feedback"] and method == "GET":
            if not self.admin_session(connection):
                raise AdminError("需要登录管理员账号", 401)
            return self.respond(list_feedback_cases(connection, int(params.get("after", 0))))
        if parts[1:2] in (["machines"], ["remote-launches"]):
            return self.handle_remote_launch_api(connection, parts, method)
        if parts == ["api", "revisions"] and method == "GET":
            return self.respond(room_revisions(connection, params))
        if parts == ["api", "rooms"]:
            if method == "GET":
                return self.respond({**list_rooms(connection, params), "participants": PARTICIPANTS, "last_room": last_room(connection)})
            room = create_room(connection, self.read_payload(), self.headers.get("X-Discussion-Token", ""))
            connection.commit()
            return self.respond(room, 200 if room["duplicate"] else 201)
        if parts == ["api", "rooms", "last"] and method == "POST":
            # Only the manager (this computer's page, a relayed device or a signed-in administrator) moves it.
            if not (self.bridged or self.admin_session(connection)):
                raise PermissionError("需要管理员身份")
            result = remember_last_room(connection, self.read_payload())
            connection.commit()
            return self.respond(result)
        if parts == ["api", "rooms", "import"] and method == "POST":
            result = import_room(connection, self.read_payload(MAX_IMPORT_BYTES), self.headers.get("X-Discussion-Token", ""))
            connection.commit()
            return self.respond(result, 200 if result.get("skipped") else 201)
        if parts == ["api", "folders"] and method == "POST":
            name = folder_name_value(self.read_payload())
            folder_id = uuid.uuid4().hex
            position = connection.execute("SELECT COALESCE(MAX(position),0)+1 FROM topic_folders").fetchone()[0]
            connection.execute("INSERT INTO topic_folders (id,name,position) VALUES (?,?,?)", (folder_id, name, position))
            connection.commit()
            return self.respond({"id": folder_id, "name": name, "position": position}, 201)
        if len(parts) == 4 and parts[:2] == ["api", "folders"] and parts[3] == "move" and method == "POST":
            result = move_folder(connection, parts[2], self.read_payload())
            connection.commit()
            return self.respond(result)
        if len(parts) == 4 and parts[:2] == ["api", "folders"] and parts[3] == "rename" and method == "POST":
            result = rename_folder(connection, parts[2], self.read_payload())
            connection.commit()
            return self.respond(result)
        if len(parts) == 4 and parts[:2] == ["api", "folders"] and parts[3] == "delete" and method == "POST":
            result = delete_folder(connection, parts[2])
            connection.commit()
            return self.respond(result)
        if len(parts) < 3 or parts[:2] != ["api", "rooms"]:
            raise LookupError("地址不存在")
        room_id = parts[2]
        if parts[3:] == ["progress"] and method == "GET":
            return self.respond(room_progress(connection, room_id))
        self.admin_as_owner(connection, room_id)
        token = self.headers.get("X-Discussion-Token", "")
        if self.headers.get("X-Discussion-Session"):
            record_reported_session(connection, room_id, token, {"session_id": self.headers.get("X-Discussion-Session"),
                                                                 "session_client": self.headers.get("X-Discussion-Session-Client")})
            connection.commit()
        if parts[3:] == ["discussion"]:
            if method == "GET":
                return self.respond(session_room(connection, room_id))
            if method == "POST":
                result = discussion_action(connection, room_id, token, self.read_payload(), require_room(connection, room_id))
                drain_room_queue(connection, room_id)
                connection.commit()
                return self.respond(result)
            raise LookupError("地址不存在")
        if parts[3:] == ["mode"]:
            if method == "GET":
                return self.respond(mode_view(connection, room_id))
            if method == "POST":
                result = finish_mode(connection, room_id, token, self.read_payload())
                connection.commit()
                return self.respond(result)
            raise LookupError("地址不存在")
        if parts[3:] == ["goal"]:
            if method == "GET":
                return self.respond(goal_view(connection, room_id))
            if method == "POST":
                result = goal_action(connection, room_id, token, self.read_payload())
                connection.commit()
                return self.respond(result)
            raise LookupError("地址不存在")
        if parts[3:] == ["descriptions"] and method == "POST":
            result = describe_members(connection, room_id, token, self.read_payload())
            connection.commit()
            return self.respond(result)
        if parts[3:] == ["labels"] and method == "POST":
            result = label_members(connection, room_id, token, self.read_payload())
            connection.commit()
            return self.respond(result)
        if parts[3:] == ["budget"] and method == "POST":
            result = set_chain_rounds(connection, room_id, token, self.read_payload())
            connection.commit()
            return self.respond(result)
        if len(parts) == 5 and parts[3] == "chains" and method == "POST":
            result = continue_chain(connection, room_id, token, int(parts[4]), self.read_payload())
            connection.commit()
            return self.respond(result)
        if parts[3:] == ["timeline"] and method == "GET":
            timeline = execution_timeline(connection, room_id, int(params.get("after", 0)))
            boundary = session_read_boundary(connection, room_id, token)
            if boundary is not None:
                for execution in timeline["executions"]:
                    hidden_task = isinstance(execution.get("task_id"), int) and execution["task_id"] > boundary
                    if hidden_task:
                        execution["task"] = ""
                        execution["task_id"] = None
                        execution["reason"] = ""
                    execution["last_note"] = ""
                    execution["notes"] = []
                    hidden_answer = isinstance(execution.get("answer_id"), int) and execution["answer_id"] > boundary
                    if hidden_answer:
                        execution["answer_id"] = None
                        execution["result"] = ""
            return self.respond(timeline)
        if parts[3:] == ["events"] and method == "GET":
            return self.respond(room_event_log(connection, room_id, token, params.get("after", 0), params.get("before", 0)))
        if parts[3:] == ["register"] and method == "POST":
            result = register_member(connection, room_id, token, utc_now())
            connection.commit()
            return self.respond(result)
        if parts[3:] == ["speaking-order"]:
            if method == "GET":
                return self.respond(require_room(connection, room_id)["speaking_order"])
            payload = self.read_payload()
            begin_write(connection)
            reorder_speakers(connection, require_room(connection, room_id), token, payload)
            result = require_room(connection, room_id)
            connection.commit()
            return self.respond(result)
        if parts[3:4] in (["topic"], ["turns"]):
            return self.handle_host_api(connection, parts, params, method)
        if len(parts) == 6 and parts[3] == "messages" and parts[5] == "retract" and method == "POST":
            result = retract_message(connection, room_id, int(parts[4]), token)
            drain_room_queue(connection, room_id)
            connection.commit()
            return self.respond(result)
        if parts[3:] == ["rewind"]:
            if method == "GET":
                require_owner(connection, room_id, token)
                return self.respond(rewind_plan(connection, room_id, int(params.get("message_id", 0))))
            result = rewind_room(connection, room_id, token, self.read_payload())
            drain_room_queue(connection, room_id)
            connection.commit()
            return self.respond(result)
        if parts[3:] == ["reviews", "roster"] and method == "GET":
            return self.respond(review_roster(connection, room_id, token))
        if len(parts) == 6 and parts[3] == "members" and parts[5] == "review-capability" and method in ("GET", "POST"):
            result = review_capability(connection, room_id, int(parts[4]), token,
                                       self.read_payload() if method == "POST" else None)
            connection.commit()
            return self.respond(result)
        if len(parts) == 6 and parts[3] == "reviews" and parts[5] == "ready" and method == "GET":
            return self.respond(review_ready(connection, room_id, int(parts[4]), token))
        if parts[3:] == ["reviews", "advance"] and method == "POST":
            result = advance_review(connection, room_id, token, self.read_payload())
            connection.commit()
            return self.respond(result)
        if len(parts) == 5 and parts[3] == "sequences" and parts[4].isdigit() and method == "GET":
            return self.respond(sequence_view(connection, room_id, int(parts[4]), token))
        if parts[3:] == ["sequences", "continue"] and method == "POST":
            result = continue_sequence(connection, room_id, token, self.read_payload())
            connection.commit()
            return self.respond(result)
        if parts[3:] == ["queue"] and method == "POST":
            result = queue_action(connection, room_id, token, self.read_payload(), post_queued, check_queued, interrupt_for_message)
            connection.commit()
            return self.respond(result)
        if parts[3:4] in (["inbox"], ["executions"], ["members"], ["chats"], ["suggestions"], ["recommendations"], ["stop"], ["dispatches"], ["host-checkin"]):
            return self.handle_free_api(connection, parts, method)
        if parts[3:4] == ["attachments"]:
            return self.handle_attachments(connection, parts, params, method)
        if parts[3:4] in (["scheduler-decisions"], ["scheduler-routing"]):
            return self.handle_scheduler_api(connection, parts, method)
        free_actor = None
        if method == "POST" and len(parts) == 4 and (parts[3] in DIRECTORY_OPERATIONS
                                                      or parts[3] in ADMIN_OPERATIONS and self.admin_session(connection)):
            pass
        elif method == "POST" and parts[3:] == ["state"]:
            pass
        elif method == "POST" and parts[3:] == ["limits"] and current_session(connection, room_id, active_only=True):
            pass
        elif method == "POST":
            free_actor = authorize_free_write(connection, room_id, token, parts[3] if len(parts) > 3 else "", self.read_payload())
        if parts[3:] == ["backup"] and method == "GET":
            if session_read_boundary(connection, room_id, token) is not None:
                raise PermissionError("独立观点阶段需房主凭据导出")
            return self.respond(room_backup(connection, room_id))
        if len(parts) == 4 and parts[3] in ("move", "folder", "rename", "archive", "restore", "delete") and method == "POST":
            files = connection.execute("SELECT id FROM attachments WHERE room_id=?", (room_id,)).fetchall() if parts[3] == "delete" else []
            result = manage_room(connection, room_id, parts[3], self.read_payload())
            connection.commit()
            for attachment in files:
                try:
                    attachment_path(self.server.database, attachment).unlink(missing_ok=True)
                except OSError:
                    logging.exception("Attachment cleanup failed: %s", attachment["id"])
            return self.respond(result)
        if len(parts) == 3 and method == "GET":
            return self.respond(room_read_view(connection, require_room(connection, room_id), token))
        if parts[3:] == ["conclusion"] and method == "GET":
            require_room(connection, room_id)
            conclusion = session_conclusion_view(connection, room_id)
            if conclusion is None:
                raise FileExistsError("房间没有进行中的讨论会话")
            return self.respond(conclusion)
        if parts[3:] == ["limits"]:
            if method == "GET":
                active_session = current_session(connection, room_id, active_only=True)
                if active_session:
                    view = session_room(connection, room_id)["session"]
                    if view:
                        return self.respond({**view["limits"], "revision": view["revision"]})
                return self.respond(require_room(connection, room_id)["limits"])
            payload = self.read_payload()
            if not current_session(connection, room_id, active_only=True):
                raise FileExistsError("房间没有进行中的讨论会话")
            if payload.get("action") == "check":
                actor = payload.get("actor", "用户")
                if actor == "用户":
                    require_owner(connection, room_id, token)
                elif require_member(connection, room_id, token, actor)["role"] != "host":
                    raise PermissionError("只有房主或当前 AI 主持人可以检查讨论上限")
                enforce_session_limits(connection, room_id)
                result = require_room(connection, room_id)
            elif payload.get("action") == "done":
                actor = payload.get("actor")
                if not actor or require_member(connection, room_id, token, actor)["role"] != "host":
                    raise PermissionError("主持人收束讨论须使用当前 AI 主持人的成员凭据")
                conclude_session_by_host(connection, room_id, payload)
                result = require_room(connection, room_id)
            elif payload.get("action") == "reopen":
                raise ValueError("新讨论会话请通过 discussion 接口重新开启")
            else:
                result = update_session_limits(connection, room_id, token, payload)
            connection.commit()
            return self.respond(result)
        if parts[3:] == ["messages"]:
            if method == "GET":
                return self.respond(query_messages(connection, room_id, params, token))
            payload = self.read_payload()
            result = append_message(connection, room_id, payload, free_actor)
            drain_room_queue(connection, room_id)
            connection.commit()
            return self.respond(result, 200 if result["duplicate"] else 201)
        if len(parts) == 5 and parts[3] == "messages" and method == "GET":
            return self.respond(get_message(connection, room_id, int(parts[4]), params, token))
        if parts[3:] == ["state"] and method == "POST":
            payload = self.read_payload()
            actor = payload.get("actor", "用户")
            if actor == "用户":
                require_owner(connection, room_id, token)
            elif require_member(connection, room_id, token, actor)["role"] != "host":
                raise PermissionError("只有房主或当前 AI 主持人可以更新状态")
            result = update_state(connection, room_id, payload)
            connection.commit()
            return self.respond(result)
        raise LookupError("地址不存在")

    def handle_attachments(self, connection, parts, params, method):
        """Handle bounded upload, discovery, metadata, and binary download."""
        room_id = parts[2]
        if len(parts) == 4:
            if method == "GET":
                return self.respond(query_attachments(connection, room_id, params))
            metadata = attachment_metadata(params)
            token = self.headers.get("X-Discussion-Token", "")
            actor = authorize_free_write(connection, room_id, token, "attachments", {"author": metadata["actor"]})
            if (actor == "用户") != (metadata["actor"] == "用户"):
                raise PermissionError("附件上传者须与凭据身份一致")
            require_room(connection, room_id)
            length = int(self.headers.get("Content-Length", "-1"))
            if not 0 <= length <= MAX_ATTACHMENT_BYTES:
                return self.respond({"error": "单个附件最多 20 MiB，须提供 Content-Length"}, 413)
            data = self.rfile.read(length)
            if len(data) != length:
                raise ValueError("附件内容不完整")
            result = store_attachment(connection, self.server.database, room_id, metadata, data)
            return self.respond(result, 200 if result["duplicate"] else 201)
        if method == "POST" and len(parts) == 6 and parts[5] == "import":
            return self.import_attachment(connection, room_id, parts[4])
        if method == "GET" and len(parts) in (5, 6):
            attachment = get_attachment(connection, room_id, parts[4])
            if len(parts) == 5:
                return self.respond(attachment)
            if parts[5] == "content":
                return self.respond_attachment(attachment, params.get("download") == "1")
        raise LookupError("地址不存在")

    def import_attachment(self, connection, room_id, attachment_id):
        """Store the original bytes of an attachment recorded by an import; an existing file is kept."""
        length = int(self.headers.get("Content-Length", "-1"))
        if not 0 <= length <= MAX_ATTACHMENT_BYTES:
            return self.respond({"error": "单个附件最多 20 MiB，须提供 Content-Length"}, 413)
        data = self.rfile.read(length)
        attachment = imported_attachment(connection, room_id, attachment_id, self.headers.get("X-Discussion-Token", ""), data)
        path = attachment_path(self.server.database, attachment)
        if not path.is_file():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        return self.respond({"attachment": attachment_view(attachment)})

    def respond_attachment(self, attachment, download):
        """Serve stored bytes with a safe disposition, never as executable HTML."""
        path = attachment_path(self.server.database, attachment)
        if not path.is_file():
            raise LookupError("附件原文件缺失")
        data = path.read_bytes()
        disposition = "attachment" if download or attachment["content_type"] == "application/octet-stream" else "inline"
        self.send_response(200)
        self.send_header("Content-Type", attachment["content_type"])
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Content-Disposition", f"{disposition}; filename*=UTF-8''{quote(attachment['file_name'], safe='')}")
        self.send_header("X-Content-SHA256", attachment["sha256"])
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'none'; sandbox")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Referrer-Policy", "no-referrer")
        self.end_headers()
        self.wfile.write(data)

    def handle_scheduler_api(self, connection, parts, method):
        """Smart-scheduling decisions, their feedback and the routing marks of the local service."""
        room_id = parts[2]
        require_room(connection, room_id)
        token = self.headers.get("X-Discussion-Token", "")
        if parts[3:] == ["scheduler-decisions"] and method == "POST":
            result = record_scheduler_decision(connection, room_id, token, self.read_payload())
        elif len(parts) == 5 and parts[3] == "scheduler-decisions" and method == "GET":
            result = scheduler_decision_view(connection, room_id, int(parts[4]), token)
        elif parts[3:] == ["scheduler-routing"] and method == "POST":
            result = mark_scheduler_routing(connection, room_id, token, self.read_payload())
        elif len(parts) == 5 and parts[3] == "scheduler-decisions" and method == "POST":
            result = rate_scheduler_decision(connection, room_id, int(parts[4]), token, self.read_payload())
        else:
            raise LookupError("地址不存在")
        connection.commit()
        return self.respond(result)

    def handle_free_api(self, connection, parts, method):
        """Runner inbox, per-member executions and the owner's interrupt for free rooms."""
        room_id = parts[2]
        token = self.headers.get("X-Discussion-Token", "")
        if parts[3:] == ["inbox"] and method == "GET":
            result = inbox(connection, room_id, token)
        elif parts[3:] == ["suggestions"] and method == "POST":
            result = convert_suggestion(connection, room_id, token, self.read_payload())
        elif parts[3:] == ["executions"] and method == "POST":
            result = reserve_execution(connection, room_id, token, self.read_payload())
        elif parts[3:] == ["recommendations"] and method == "POST":
            result = recommend_member(connection, room_id, token, self.read_payload())
        elif len(parts) == 5 and parts[3] == "recommendations" and method == "GET":
            result = group_route_plan(connection, room_id, token, int(parts[4]))
        elif len(parts) == 5 and parts[3] == "recommendations" and method == "POST":
            result = adopt_recommendation(connection, room_id, token, int(parts[4]), self.read_payload())
        elif len(parts) == 6 and parts[3] == "executions" and parts[5] == "notes" and method == "GET":
            result = execution_notes(connection, room_id, int(parts[4]), token)
        elif len(parts) == 6 and parts[3] == "executions" and parts[5] == "late-answer" and method == "GET":
            result = late_answer(connection, room_id, int(parts[4]), token)
        elif len(parts) == 5 and parts[3] == "executions":
            execution_id = int(parts[4])
            result = (view_execution(connection, room_id, execution_id, token) if method == "GET"
                      else execution_action(connection, room_id, execution_id, token, self.read_payload()))
        elif parts[3:] == ["members"] and method == "POST":
            result = add_member(connection, room_id, token, self.read_payload(), utc_now())
        elif len(parts) == 5 and parts[3] == "members" and method == "POST":
            result = member_action(connection, room_id, int(parts[4]), token, self.read_payload())
        elif len(parts) == 6 and parts[3] == "members" and parts[5] == "interrupt" and method == "POST":
            result = interrupt_member(connection, room_id, int(parts[4]), token)
        elif len(parts) == 6 and parts[3] == "members" and parts[5] == "chat" and method in ("GET", "POST"):
            result = member_chat(connection, room_id, int(parts[4]), token, self.read_payload() if method == "POST" else None)
        elif len(parts) == 5 and parts[3] == "chats" and method == "POST":
            result = chat_action(connection, room_id, int(parts[4]), token, self.read_payload())
        elif len(parts) == 6 and parts[3] == "members" and parts[5] == "capabilities" and method == "POST":
            result = member_capability(connection, room_id, int(parts[4]), token, self.read_payload())
        elif parts[3:] == ["stop"] and method == "POST":
            result = stop_room(connection, room_id, token)
        elif len(parts) == 6 and parts[3] == "dispatches" and parts[4].isdigit() and parts[5] == "withdraw" and method == "POST":
            result = withdraw_dispatch(connection, room_id, token, int(parts[4]))
        elif parts[3:] == ["host-checkin"] and method == "POST":
            result = set_host_checkin(connection, room_id, token, self.read_payload())
        else:
            raise LookupError("地址不存在")
        drain_room_queue(connection, room_id)
        connection.commit()
        return self.respond(result)

    def handle_host_api(self, connection, parts, params, method):
        """Route topic maintenance and sequential speaking assignments."""
        room_id = parts[2]
        if parts[3:4] == ["turns"]:
            return self.handle_session_turn_api(connection, room_id, parts, params, method)
        if parts[3:] == ["topic"] and method == "POST":
            payload = self.read_payload()
            actor = payload.get("actor", "用户")
            token = self.headers.get("X-Discussion-Token", "")
            if actor == "用户":
                require_owner(connection, room_id, token)
            elif require_member(connection, room_id, token, actor)["role"] != "host":
                raise PermissionError("只有房主或当前 AI 主持人可以修改话题资料")
            result = update_topic(connection, room_id, payload)
            connection.commit()
            return self.respond(result)
        raise LookupError("地址不存在")

    def handle_session_turn_api(self, connection, room_id, parts, params, method):
        """Read and write the plans of the room's discussion through the turns URL family."""
        if method == "POST" and not current_session(connection, room_id):
            raise ValueError("房间没有讨论会话；请先开启讨论")
        if parts[3:] == ["turns"]:
            if method == "GET":
                require_room(connection, room_id)
                return self.respond(query_session_requests(connection, room_id, params))
            payload = self.read_payload()
            host = require_member(connection, room_id, self.headers.get("X-Discussion-Token", ""), payload.get("actor"))
            if host["role"] != "host":
                raise PermissionError("只有当前 AI 主持人可以安排讨论发言")
            result = create_plan(connection, room_id, resolve_member_fields(connection, room_id, payload), require_room(connection, room_id))
            connection.commit()
            return self.respond(result, 200 if result["duplicate"] else 201)
        if parts[3:] == ["turns", "roster"] and method == "GET":
            return self.respond(session_roster_view(connection, room_id))
        if parts[3:] == ["turns", "ask"] and method == "POST":
            payload = self.read_payload()
            begin_write(connection)
            host = require_member(connection, room_id, self.headers.get("X-Discussion-Token", ""), payload.get("actor"))
            if host["role"] != "host":
                raise PermissionError("只有当前 AI 主持人可以转交讨论追问")
            result = ask_interjection(connection, room_id, resolve_member_fields(connection, room_id, payload), require_room(connection, room_id))
            connection.commit()
            return self.respond(result, 200 if result["duplicate"] else 201)
        if parts[3:] == ["turns", "continue"] and method == "POST":
            payload = self.read_payload()
            host = require_member(connection, room_id, self.headers.get("X-Discussion-Token", ""), payload.get("actor"))
            if host["role"] != "host":
                raise PermissionError("只有当前 AI 主持人可以继续讨论安排")
            result = continue_plan(connection, room_id, payload, require_room(connection, room_id))
            connection.commit()
            return self.respond(result)
        if len(parts) == 5 and parts[3] == "turns":
            if method == "GET":
                return self.respond(get_session_request(connection, room_id, parts[4]))
            payload = self.read_payload()
            token = self.headers.get("X-Discussion-Token", "")
            try:
                require_owner(connection, room_id, token)
            except PermissionError:
                host = require_member(connection, room_id, token, payload.get("actor"))
                if host["role"] != "host":
                    raise PermissionError("只有房主或 AI 主持人可以取消安排")
            if payload.get("status") != "cancelled":
                raise ValueError("新讨论安排只支持专用取消操作")
            result = cancel_plan(connection, room_id, parts[4], payload)
            connection.commit()
            return self.respond(result)
        raise LookupError("地址不存在")

    def handle_text(self, connection, parts, params):
        """Expose read-only history and search without JavaScript or MCP."""
        if len(parts) < 2:
            raise LookupError("请指定房间")
        room_id = parts[1]
        token = self.headers.get("X-Discussion-Token", "")
        if len(parts) == 2:
            body = room_text(connection, room_id, params)
        elif parts[2:] in (["brief"], ["state"], ["protocol"]):
            room = room_read_view(connection, require_room(connection, room_id), self.headers.get("X-Discussion-Token", ""))
            body = brief_text(room) if parts[2] == "brief" else protocol_text(room)
            if parts[2] == "state":
                body = state_reading_text(room)
        elif parts[2:] == ["turns"]:
            result = query_session_requests(connection, room_id, params)
            room = require_room(connection, room_id)
            body = f"第 {result['page']} / {result['pages']} 页，共 {result['total']} 项。\n\n" + "\n\n".join(turn_text(turn, room) for turn in result["turns"])
        elif len(parts) == 4 and parts[2] == "turns":
            body = turn_text(get_session_request(connection, room_id, parts[3]), require_room(connection, room_id))
        elif parts[2:] in (["messages"], ["search"]):
            result = query_messages(connection, room_id, params, token)
            items = [message_text(message) for message in result["messages"]]
            next_page = f"第 {result['page']} / {result['pages']} 页，共 {result['total']} 条。翻页：保留查询条件，修改 page 参数。"
            body = next_page + "\n\n" + "\n\n---\n\n".join(items or ["没有匹配的消息。"])
        elif len(parts) == 4 and parts[2] == "messages":
            body = message_text(get_message(connection, room_id, int(parts[3]), params, token))
        elif parts[2:] == ["publish"]:
            return self.respond("URL 发布入口已停用；本地 CLI AI 请使用 POST 留言接口。", 410, "text/plain")
        else:
            raise LookupError("地址不存在")
        return self.respond(body, content_type="text/plain")


def main():
    """Start the configurable local or server-hosted POC service."""
    parser = argparse.ArgumentParser(description="AI CoDiscuss POC")
    parser.add_argument("--host", default=os.getenv("HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.getenv("PORT", DEFAULT_PORT)))
    parser.add_argument("--database", default=os.getenv("DATABASE_PATH", str(ROOT / "data" / "discuss.sqlite3")))
    parser.add_argument("--no-demo", action="store_true", help="Do not seed sample data in a new database")
    parser.add_argument("--local-launch", action="store_true", help="Enable local AI launch and configuration (127.0.0.1 only)")
    parser.add_argument("--reset-admin", action="store_true", help="Delete the administrator account and sessions, then exit")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    init_database(args.database, seed=not args.no_demo)
    if args.reset_admin:
        with closing(connect_db(args.database)) as connection, connection:
            connection.execute("DELETE FROM admin_logins")
            connection.execute("DELETE FROM admin_attempts")
            connection.execute("DELETE FROM site_admin")
        logging.info("管理员账号已清除；再次打开网站时可用安装令牌重新注册")
        return
    server = DiscussionServer((args.host, args.port), args.database, local_launch=args.local_launch)
    logging.info("AI CoDiscuss ready at http://%s:%s", args.host, args.port)
    with closing(connect_db(args.database)) as connection:
        login_site = server if not server.local_site else None
        if login_site and connection.execute("SELECT 1 FROM site_admin").fetchone() is None:
            logging.info("尚未注册管理员账号；注册所需安装令牌：%s",
                         "见环境变量 DISCUSS_ADMIN_SETUP_KEY" if os.getenv("DISCUSS_ADMIN_SETUP_KEY") else login_site.admin_setup_key)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logging.info("Server stopped")
    finally:
        if remote:
            remote.shutdown()
            remote.server_close()
        server.server_close()


if __name__ == "__main__":
    main()

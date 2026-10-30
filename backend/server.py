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

from .admin import AdminError, admin_status, login_admin, logout_admin, register_admin, session_valid, update_profile
from .remote_launch import (COMMAND_WAIT_MAX, claim_machine_commands, finish_machine_command, list_machines, machine_command_status,
                            machine_launch_action, machine_sync, pair_machine, remote_launch_status, submit_machine_command,
                            submit_remote_launch)
from .free_room import (add_member, after_free_message, authorize_free_write, check_answer, check_proxy, execution_action, free_view,
                        inbox, interrupt_member, member_action, member_values, migrate_free_tables, proxy_member, reserve_execution,
                        discussion_members, room_mode, save_room_access, sync_discussion_members, view_execution)
from .free_room import add_discussion_member, convert_suggestion, discussion_member_action, message_suggestions, save_suggestions, sync_participants
from .free_room import active_members, adopt_recommendation, ask_members, asks_view, checked_asks, recommend_member, register_member, route_held_messages, require_member
from .free_room import describe_members, execution_notes, label_members, member_descriptions, member_labels, reorder_speakers, set_chain_rounds, speaking_order, stop_room_work
from .free_room import continue_chain, execution_timeline, group_route_plan, retract_message, rewind_plan, rewind_room, withdrawals
from .free_room import review_capability, review_roster, checked_review_plan, save_review_plan, check_review_retry
from .free_room import review_ready, advance_review
from .identity import MAX_ROOM_AGENTS, PARTICIPANTS, is_ai, is_participant
from .room_import import import_room, imported_attachment
from .runtime import (authorize_write, begin_write, event_view,
                     LIMIT_DEFAULTS, LIMITS_SQL, limit_values, limits_view, require_within_limits,
                     list_events, owner_proxy_token, require_control, require_owner, runtime_view, token_hash,
                     enforce_session_limits, has_session_request_model, session_limits_view)
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
SCHEMA = (Path(__file__).resolve().parent / "schema.sql").read_text(encoding="utf-8")
PHASES = {"preparing": "准备中", "initial": "独立观点", "discussing": "深入讨论",
          "paused": "已暂停", "concluded": "已收束"}
TURN_STATUSES = {"pending": "待处理", "notified": "已通知，待回答", "answered": "已回答", "cancelled": "已取消",
                 "queued": "排队中", "skipped": "未开始即取消"}
MAX_TOPIC_DETAIL = 4000
MAX_QUESTION_LENGTH = 1000
MAX_PLAN_TURNS = 10
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
        "topic_settings", "discussion_limits", "discussion_options", "round_budgets")},
    "scheduler_decisions": f"{DECISION_SELECT} WHERE d.room_id=? ORDER BY d.id",
    "topic_folders": "SELECT * FROM topic_folders WHERE id IN (SELECT folder_id FROM room_folder_assignments WHERE room_id=?)",
    "messages": "SELECT * FROM messages WHERE room_id=? ORDER BY id",
    "message_withdrawals": "SELECT w.* FROM message_withdrawals w JOIN messages m ON m.id=w.message_id WHERE m.room_id=? ORDER BY w.message_id",
    "attachments": "SELECT * FROM attachments WHERE room_id=? AND message_id IS NOT NULL ORDER BY message_id,position",
    "discussion_turns": "SELECT * FROM discussion_turns WHERE room_id=? ORDER BY id",
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
THEN messages.author ELSE '用户' END) AS submitted_by, details.turn_id,
COALESCE(summaries.text,'') AS summary, COALESCE(summaries.author,'') AS summary_by, timing.elapsed_seconds,
answered.execution_id, answered.request_message_id, COALESCE(withdrawn.kind,'') AS withdrawn
FROM messages LEFT JOIN message_details AS details ON details.message_id=messages.id
LEFT JOIN message_withdrawals AS withdrawn ON withdrawn.message_id=messages.id
LEFT JOIN message_summaries AS summaries ON summaries.message_id=messages.id
LEFT JOIN message_timings AS timing ON timing.message_id=messages.id
LEFT JOIN (SELECT answer_id, MIN(execution_id) AS execution_id, MIN(message_id) AS request_message_id
  FROM member_requests WHERE answer_id IS NOT NULL AND execution_id IS NOT NULL GROUP BY answer_id) AS answered
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
    for request in execution.get("requests", []):
        _hide_after_boundary(request, boundary, ("message_id", "answer_id", "source_message_id", "after_message_id"))
        if request.get("discussion_session_id") and request.get("source_question"):
            request["source_question"] = ""


def utc_now():
    """Return the current UTC timestamp in ISO format."""
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def connect_db(database):
    """Open a database connection with named rows and foreign keys enabled."""
    connection = sqlite3.connect(database, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def seed_demo(connection):
    """Insert clearly labeled sample content into a newly initialized database."""
    connection.execute("INSERT INTO rooms (id,title,goal,created_at) VALUES (?,?,?,?)",
                       ("welcome", "AI 留言板 · 设计讨论", "让不同 AI 共享讨论信息，控制每轮上下文，并保留可检索的完整历史。", utc_now()))
    samples = [
        ("用户", "我们先验证一个简单场景：不同 AI 能否通过同一个房间阅读、检索和留言？\n首轮只讨论信息如何流转，不接入真实模型。", None),
        ("Codex", "建议把完整历史保留下来，每轮先给目标、当前状态和需要回应的消息。\n@Claude 如果摘要遗漏了重要条件，参与者如何核对？", 1),
        ("Claude", "每条结论都应引用原始消息编号。AI 可以主动读取原文，也能按关键词检索。\n摘要由主持人维护，未解决的分歧不能写成共识。", 2),
        ("Gemini", "在线 AI 只读取讨论记录，在自己的聊天窗口给出观点，由用户代发。\n@DeepSeek 请检查阅读入口和原文引用是否清楚。", 1),
        ("DeepSeek", "如果只能阅读，回复可以由用户代发。需要保留原作者、引用关系和代发方式，便于其他参与者继续讨论。", 4),
        ("Qwen", "无联网时，可以由用户传入本轮材料。我仍可提出检索请求，例如：请提供 #2 的完整原文。", 2),
    ]
    base_time = datetime.now(timezone.utc) - timedelta(minutes=len(samples) * 3)
    for index, (author, text, reply_to) in enumerate(samples):
        created_at = (base_time + timedelta(minutes=index * 3)).isoformat(timespec="seconds")
        connection.execute("INSERT INTO messages (room_id,author,text,reply_to,source,submission_id,created_at) VALUES (?,?,?,?,?,?,?)",
                           ("welcome", author, text, reply_to, "demo", f"demo-{index}", created_at))
    summary = "已达成共识\n• 完整历史只追加，支持按编号查阅和关键词检索。〔#2、#3〕\n• 本地 CLI AI 读写记录；在线 AI 只读，观点由用户代发。〔#4、#5〕\n\n待验证\n• 在线 AI 是否能直接读取和检索原文。〔#4〕\n• 复制材料与代发流程是否清楚。〔#5、#6〕"
    connection.execute("UPDATE rooms SET state_text=?,state_until=6 WHERE id='welcome'", (summary,))


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
        connection.executescript(SCHEMA)
        migrate_free_tables(connection)
        if seed and is_new:
            seed_demo(connection)


def require_room(connection, room_id):
    """Return a room and its current message count, or raise a lookup error."""
    row = connection.execute("""SELECT rooms.*,
        COUNT(CASE WHEN NOT EXISTS (SELECT 1 FROM internal_task_messages t WHERE t.message_id=messages.id) THEN messages.id END) AS message_count,
        COALESCE(MAX(CASE WHEN NOT EXISTS (SELECT 1 FROM internal_task_messages t WHERE t.message_id=messages.id) THEN messages.id END),0) AS latest_id
        FROM rooms LEFT JOIN messages ON rooms.id=messages.room_id WHERE rooms.id=? GROUP BY rooms.id""", (room_id,)).fetchone()
    if row is None:
        raise LookupError("房间不存在")
    if enforce_session_limits(connection, room_id):
        connection.commit()
        row = connection.execute("""SELECT rooms.*,
            COUNT(CASE WHEN NOT EXISTS (SELECT 1 FROM internal_task_messages t WHERE t.message_id=messages.id) THEN messages.id END) AS message_count,
            COALESCE(MAX(CASE WHEN NOT EXISTS (SELECT 1 FROM internal_task_messages t WHERE t.message_id=messages.id) THEN messages.id END),0) AS latest_id
            FROM rooms LEFT JOIN messages ON rooms.id=messages.room_id WHERE rooms.id=? GROUP BY rooms.id""", (room_id,)).fetchone()
    room = dict(row)
    room["archived"] = bool(connection.execute("SELECT archived FROM room_directory WHERE room_id=?", (room_id,)).fetchone()[0])
    room["folder_id"] = connection.execute("SELECT folder_id FROM room_folder_assignments WHERE room_id=?", (room_id,)).fetchone()[0]
    settings = connection.execute("SELECT * FROM topic_settings WHERE room_id=?", (room_id,)).fetchone()
    room.update(dict(settings) if settings else topic_defaults())
    original = connection.execute("SELECT text FROM room_user_requests WHERE room_id=?", (room_id,)).fetchone()
    room.update(topic_context(room["background"], original["text"] if original else None))
    if settings:
        room["experts"] = json.loads(room["experts"])
    turn = connection.execute("""SELECT *, (SELECT COUNT(*) FROM discussion_turns WHERE room_id=? AND status='answered') AS answered_turns
        FROM discussion_turns WHERE room_id=? AND status NOT IN ('queued','skipped')
        ORDER BY status IN ('pending','notified') DESC, id DESC LIMIT 1""", (room_id, room_id)).fetchone()
    room["current_turn"] = dict(turn) if turn else None
    room["answered_turns"] = room["current_turn"].pop("answered_turns") if turn else 0
    if turn:
        room["current_turn"]["status_label"] = turn_status_label(turn, room)
    room["queued_turns"] = [dict(row) for row in connection.execute(
        "SELECT id,expert,question FROM discussion_turns WHERE room_id=? AND status='queued' ORDER BY id", (room_id,))]
    held = connection.execute("SELECT held_since FROM turn_relay WHERE room_id=?", (room_id,)).fetchone()
    room["held_since"] = held[0] if held else 0
    brief = connection.execute("SELECT text,until,updated_at FROM room_briefs WHERE room_id=?", (room_id,)).fetchone()
    room["host_brief"] = dict(brief) if brief else None
    room["rounds"] = discussion_rounds(connection, room_id, room["experts"])
    room["completed_rounds"] = sum(item["completed"] for item in room["rounds"])
    budget = connection.execute("SELECT base,cap,extra FROM round_budgets WHERE room_id=?", (room_id,)).fetchone()
    room["round_budget"] = dict(budget) if budget else None
    if budget:
        room["opinion_count"] = opinion_count(connection, room_id, room["experts"])
    session = connection.execute("SELECT id,goal,status,started_message_id,ended_message_id,created_at FROM discussion_sessions WHERE room_id=? ORDER BY id DESC LIMIT 1", (room_id,)).fetchone()
    room["session"] = dict(session) if session else None
    room["discussions"] = [dict(row) for row in connection.execute(DISCUSSIONS_SELECT, (room_id,))]
    legacy_groups = budget_round_groups(connection, room_id, room["experts"], budget["base"], room["session"]) if budget else room["rounds"]
    room["round_groups"] = [{**group, "key": f"legacy-round-{group['number']}",
                             "speakers": group.get("speakers", []), "participants": len(room["experts"])}
                            for group in legacy_groups]
    room["runtime"] = runtime_view(connection, room_id)
    room["limits"] = limits_view(connection.execute(LIMITS_SQL, (room_id,)).fetchone(), room)
    room["mode"] = room_mode(connection, room_id)
    session_limits = session_limits_view(connection, room_id)
    if session_limits:
        room["limits"] = session_limits
        session = current_session(connection, room_id)
        if session:
            state = connection.execute("SELECT phase,held_since FROM session_state WHERE session_id=?", (session["id"],)).fetchone()
            room["phase"] = ("paused" if session["status"] == "paused" else "concluded" if session["status"] == "concluded"
                             else state["phase"] if state else room["phase"])
            room["held_since"] = state["held_since"] if state else room["held_since"]
            room["round_budget"] = dict(connection.execute(
                "SELECT base,cap,extra FROM session_round_budgets WHERE session_id=?", (session["id"],)).fetchone())
        room["opinion_count"] = session_limits["answered"]
        room["completed_rounds"] = session_limits["completed_rounds"]
        room["answered_turns"] = session_limits["answered"]
        active_session = current_session(connection, room_id, active_only=True)
        if active_session:
            current = connection.execute("""SELECT sr.*,m.name AS expert FROM session_requests sr
                JOIN room_members m ON m.id=sr.member_id WHERE sr.session_id=? AND sr.purpose='discuss' AND sr.status='open'
                ORDER BY sr.round,sr.position,sr.id LIMIT 1""", (active_session["id"],)).fetchone()
            room["current_turn"] = ({**dict(current), "status": "pending",
                                     "status_label": turn_status_label({"status": "pending", "expert": current["expert"]}, room)}
                                    if current else None)
            room["queued_turns"] = [dict(row) for row in connection.execute("""SELECT sr.id,sr.question,m.name AS expert
                FROM session_requests sr JOIN room_members m ON m.id=sr.member_id
                WHERE sr.session_id=? AND sr.purpose='discuss' AND sr.status='queued' ORDER BY sr.round,sr.position,sr.id""",
                (active_session["id"],))]
        else:
            room["current_turn"] = None
            room["queued_turns"] = []
    if room["mode"] == "free" and not session:
        room["round_groups"] = []
    else:
        room["round_groups"] = merge_round_groups(connection, room_id, room["round_groups"])
    room["members"] = [dict(row) for row in connection.execute(
        """SELECT m.id,m.name,m.adapter,m.role,m.status,m.access,m.session_mode,COALESCE(source.source,'') AS manual_source,COALESCE(s.session_id,'') AS reported_session,COALESCE(s.client,'') AS reported_client,
        COALESCE(r.registered_at,'') AS registered_at
        FROM room_members AS m LEFT JOIN member_sessions AS s ON s.member_id=m.id
        LEFT JOIN member_registrations AS r ON r.member_id=m.id AND r.token_hash=m.token_hash
        LEFT JOIN member_manual_sources AS source ON source.member_id=m.id WHERE m.room_id=? AND m.status<>'removed' ORDER BY m.id""", (room_id,))]
    option = connection.execute("SELECT named_followup FROM session_options WHERE session_id=?", (session["id"],)).fetchone() if session else None
    if not option:
        option = connection.execute("SELECT named_followup FROM discussion_options WHERE room_id=?", (room_id,)).fetchone()
    # Rooms created before the option keep the host's named follow-ups.
    room["named_followup"] = bool(option[0]) if option else True
    room["scheduler_decisions"] = [dict(row) for row in connection.execute(
        f"{DECISION_SELECT} WHERE d.room_id=? ORDER BY d.id DESC LIMIT ?", (room_id, RECENT_DECISIONS))][::-1]
    details = {row[0]: json.loads(row[1]) for row in connection.execute(
        "SELECT decision_id,detail FROM scheduler_decision_details WHERE decision_id IN (SELECT id FROM scheduler_decisions WHERE room_id=?)", (room_id,))}
    for decision in room["scheduler_decisions"]:
        decision["detail"] = details.get(decision["id"])
    room["scheduler_routing"] = [row[0] for row in connection.execute(
        "SELECT message_id FROM scheduler_routing WHERE room_id=? AND created_at>? ORDER BY message_id", (room_id, int(time.time()) - ROUTING_VISIBLE_SECONDS))]
    room["host_arrangements"] = host_arrangements(connection, room_id, room["scheduler_decisions"])
    room["cancelled_turns"] = cancelled_turns(connection, room_id)
    parent = connection.execute("""SELECT rooms.id,rooms.title FROM room_links JOIN rooms ON rooms.id=room_links.parent_id
        WHERE room_links.room_id=?""", (room_id,)).fetchone()
    room["parent_room"] = dict(parent) if parent else None
    if room["mode"] != "free":
        room["asks"] = asks_view(connection, room_id)
    if room["mode"] == "free":
        room["linked_rooms"] = [dict(row) for row in connection.execute("""SELECT rooms.id,rooms.title,COALESCE(topic_settings.phase,'preparing') AS phase
            FROM room_links JOIN rooms ON rooms.id=room_links.room_id LEFT JOIN topic_settings ON topic_settings.room_id=rooms.id
            WHERE room_links.parent_id=? ORDER BY room_links.created_at""", (room_id,))]
        # Free rooms have no host hand-off: user messages go straight to the named members.
        room["held_since"] = 0
        room["free"] = free_view(connection, room_id)
    room["descriptions"] = member_descriptions(connection, room_id)
    room["labels"] = member_labels(connection, room_id)
    room["withdrawals"] = withdrawals(connection, room_id)
    room["speaking_order"] = speaking_order(connection, room)
    return room


def host_arrangements(connection, room_id, decisions):
    """Each plan the host created (turns saved in one batch), anchored after the latest answer before it.

    The opening plan has no answer to follow and is anchored at 0. Invitation turns are not plans, and a plan the smart scheduler applied is already shown by its own decision.
    """
    plans, latest_answer = [], 0
    for row in connection.execute("SELECT id,expert,question,answer_id,created_at,submission_id FROM discussion_turns WHERE room_id=? ORDER BY id", (room_id,)):
        if not row["submission_id"].startswith("invite:"):
            if plans and plans[-1]["created_at"] == row["created_at"]:
                plans[-1]["turns"].append({"expert": row["expert"], "question": row["question"]})
            else:
                plans.append({"id": f"legacy-plan-{row['id']}", "key": f"legacy-plan-{row['id']}", "display_id": row["id"],
                              "after_message_id": latest_answer, "created_at": row["created_at"],
                              "turns": [{"expert": row["expert"], "question": row["question"]}]})
        latest_answer = max(latest_answer, row["answer_id"] or 0)
    plans.extend(session_host_arrangements(connection, room_id))
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
    """Expose request-based plans in the legacy card shape, grouped by submission batch."""
    result = []
    sessions = connection.execute("SELECT id FROM discussion_sessions WHERE room_id=? ORDER BY id", (room_id,))
    for session_row in sessions:
        session_id = session_row["id"]
        rows = [dict(row) for row in connection.execute("""SELECT q.id,q.session_id,q.round,q.position,q.member_id,q.question,
            q.created_at,q.submission_id,q.member_request_id,m.name AS expert,r.message_id AS task_message_id
            FROM session_requests q JOIN room_members m ON m.id=q.member_id
            LEFT JOIN member_requests r ON r.id=q.member_request_id
            WHERE q.session_id=? AND q.purpose='discuss' AND q.submission_id NOT LIKE 'invite:%'
            ORDER BY q.created_at,q.id""", (session_id,))]
        submission_ids = {row["submission_id"] for row in rows}
        batches = {}
        for row in rows:
            base_id = row["submission_id"]
            match = re.match(r"^(.*)-q\d+$", base_id)
            if match and match.group(1) in submission_ids:
                base_id = match.group(1)
            batches.setdefault((base_id, row["created_at"]), []).append(row)
        for (base_id, created_at), batch in batches.items():
            first = batch[0]
            task_message_id = first["task_message_id"]
            host_task = connection.execute("""SELECT t.message_id FROM task_message_sources t
                JOIN session_requests h ON h.id=t.session_request_id
                WHERE h.session_id=? AND h.purpose='discuss_host' AND t.message_id<?
                ORDER BY t.message_id DESC LIMIT 1""", (session_id, task_message_id or 2 ** 63 - 1)).fetchone()
            anchor_message_id = host_task["message_id"] if host_task else task_message_id
            anchor = visible_anchor_before(connection, room_id, anchor_message_id)
            result.append({"id": f"session-{session_id}-plan-{first['id']}", "key": f"session-{session_id}-plan-{first['id']}", "display_id": first["id"],
                "after_message_id": anchor, "created_at": created_at,
                "turns": [{"expert": row["expert"], "question": row["question"], "round": row["round"]} for row in batch]})
    return result


def cancelled_turns(connection, room_id):
    """Assignments that ended without an answer, anchored where their wake card first appeared.

    The anchor is the later of the previous turn's answer and the latest message at creation time, so the card keeps its place in the transcript.
    """
    rows, latest_answer = [], 0
    for row in connection.execute("""SELECT id,expert,question,status,answer_id,notified_at,created_at,
        (SELECT COALESCE(MAX(messages.id),0) FROM messages WHERE messages.room_id=discussion_turns.room_id AND messages.created_at<=discussion_turns.created_at) AS created_after
        FROM discussion_turns WHERE room_id=? ORDER BY id""", (room_id,)):
        if row["status"] == "cancelled" and row["notified_at"] and row["answer_id"] is None:
            rows.append({"id": f"legacy-turn-{row['id']}", "key": f"legacy-turn-{row['id']}", "created_at": row["created_at"],
                         "display_id": row["id"], "expert": row["expert"], "question": row["question"],
                         "status": row["status"], "after_message_id": max(latest_answer, row["created_after"])})
        latest_answer = max(latest_answer, row["answer_id"] or 0)
    rows.extend(session_cancelled_turns(connection, room_id))
    rows.sort(key=lambda item: (item.get("created_at", ""), item["after_message_id"], str(item["id"])))
    return rows[-RECENT_DECISIONS:]


def session_cancelled_turns(connection, room_id):
    """Return only canceled/skipped session assignments that were opened and lack an execution failure card."""
    result = []
    for row in connection.execute("""SELECT q.id,q.session_id,q.member_id,q.question,q.status,q.member_request_id,q.created_at,m.name AS expert,
        r.message_id AS task_message_id,r.execution_id FROM session_requests q JOIN room_members m ON m.id=q.member_id
        JOIN member_requests r ON r.id=q.member_request_id
        WHERE q.session_id IN (SELECT id FROM discussion_sessions WHERE room_id=?) AND q.purpose='discuss'
          AND q.status IN ('cancelled','skipped') AND q.member_request_id IS NOT NULL AND r.answer_id IS NULL
          AND NOT EXISTS(SELECT 1 FROM member_executions e WHERE e.id=r.execution_id AND e.status='failed')
        ORDER BY q.id""", (room_id,)):
        result.append({"id": f"session-{row['session_id']}-request-{row['id']}", "key": f"session-{row['session_id']}-request-{row['id']}", "display_id": row["id"],
            "expert": row["expert"], "question": row["question"], "status": row["status"],
            "execution_id": row["execution_id"],
            "after_message_id": visible_anchor_before(connection, room_id, row["task_message_id"]),
            "created_at": row["created_at"]})
    return result


def merge_round_groups(connection, room_id, legacy_groups):
    """Combine legacy and request-based rounds without losing prior session history."""
    groups = list(legacy_groups)
    sessions = connection.execute("SELECT id,started_message_id,ended_message_id FROM discussion_sessions WHERE room_id=? ORDER BY id", (room_id,))
    for session in sessions:
        groups.extend(session_round_groups(connection, room_id, session))
    return sorted(groups, key=lambda group: (group["start_id"], group["key"]))


def session_round_groups(connection, room_id, session):
    """Group request-based chat answers by their stored discussion round."""
    rows = connection.execute("""SELECT q.round,q.status,q.member_id,m.name AS expert,m.role,r.answer_id
        FROM session_requests q JOIN room_members m ON m.id=q.member_id
        LEFT JOIN member_requests r ON r.id=q.member_request_id
        WHERE q.session_id=? AND q.purpose='discuss' AND r.answer_id IS NOT NULL ORDER BY q.round,q.position,q.id""", (session["id"],)).fetchall()
    by_round = {}
    for row in rows:
        group = by_round.setdefault(row["round"], {"number": row["round"], "speakers": [], "opinions": 0,
            "completed": False, "host_scheduled": False})
        if row["answer_id"]:
            group["opinions"] += 1
            if row["expert"] not in group["speakers"]:
                group["speakers"].append(row["expert"])
        group["host_scheduled"] = group["host_scheduled"] or row["role"] == "host"
    if not by_round:
        return []
    active_experts = connection.execute("""SELECT COUNT(*) FROM room_members m LEFT JOIN member_manual_sources src ON src.member_id=m.id
        WHERE m.room_id=? AND m.status='active' AND m.role<>'host'
        AND (m.access<>'manual' OR src.source='web' OR EXISTS(SELECT 1 FROM member_registrations reg
            WHERE reg.member_id=m.id AND reg.token_hash=m.token_hash))""", (room_id,)).fetchone()[0]
    previous_answers = 0
    result = []
    for number, group in sorted(by_round.items()):
        denominator = active_experts + int(group.pop("host_scheduled"))
        group["completed"] = denominator > 0 and group["opinions"] >= denominator
        group["start_id"] = max(int(session["started_message_id"] or 0), previous_answers) + 1
        previous_answers = connection.execute("""SELECT COALESCE(MAX(r.answer_id),0) FROM session_requests q
            JOIN member_requests r ON r.id=q.member_request_id WHERE q.session_id=? AND q.purpose='discuss' AND q.round=?""",
            (session["id"], number)).fetchone()[0]
        result.append({**{key: group[key] for key in ("number", "speakers", "opinions", "completed", "start_id")},
                       "session_id": session["id"], "key": f"session-{session['id']}-round-{number}",
                       "end_id": session["ended_message_id"] or None, "participants": denominator})
    return result


def discussion_rounds(connection, room_id, experts):
    """Group complete history metadata until every configured expert has spoken.

    Repeated opinions count once per round; other roles retain their position
    without advancing the round. No message bodies are loaded or rewritten.
    """
    if not experts:
        return []
    rows = connection.execute("""SELECT messages.id,messages.author,
        COALESCE(details.kind,'opinion') AS kind FROM messages
        LEFT JOIN message_details AS details ON details.message_id=messages.id
        WHERE room_id=? ORDER BY messages.id""", (room_id,))
    rounds = []
    next_start = None
    for message in rows:
        if next_start is None:
            next_start = message["id"]
        if message["kind"] != "opinion" or message["author"] not in experts:
            continue
        if not rounds or rounds[-1]["completed"]:
            rounds.append({"number": len(rounds) + 1, "start_id": next_start,
                           "speakers": [], "completed": False})
        current = rounds[-1]
        if message["author"] not in current["speakers"]:
            current["speakers"].append(message["author"])
        current["completed"] = len(current["speakers"]) == len(experts)
        if current["completed"]:
            next_start = None
    return rounds


def budget_round_groups(connection, room_id, experts, base, session):
    """Group history by the round budget's rule: every len(experts) opinions form a round, and a new segment (base) starts a new one.

    Only messages of the latest discussion are grouped, numbered from 1; free collaboration before or after it has no rounds.
    `rounds` stays speaker-based because scheduling needs who still owes a turn; this view only labels history.
    """
    if not experts or not session:
        return []
    first, last = session["started_message_id"], session["ended_message_id"] or float("inf")
    rows = connection.execute("""SELECT messages.id,messages.author,
        COALESCE(details.kind,'opinion') AS kind FROM messages
        LEFT JOIN message_details AS details ON details.message_id=messages.id
        WHERE room_id=? ORDER BY messages.id""", (room_id,))
    groups, next_start, seen = [], None, 0
    for message in rows:
        opinion = message["kind"] == "opinion" and message["author"] in experts
        # base counts every opinion in the room, so opinions outside the discussion still advance seen.
        seen += opinion
        if not first < message["id"] <= last:
            continue
        if next_start is None:
            next_start = message["id"]
        if not opinion:
            continue
        if not groups or groups[-1]["completed"]:
            groups.append({"number": len(groups) + 1, "start_id": next_start, "opinions": 0, "completed": False})
        current = groups[-1]
        current["opinions"] += 1
        current["completed"] = current["opinions"] >= len(experts) or seen == base
        if current["completed"]:
            next_start = None
    return groups


def opinion_count(connection, room_id, experts):
    """Count formal expert opinions; the program-controlled round budget is measured in these."""
    if not experts:
        return 0
    marks = ",".join("?" * len(experts))
    return connection.execute(f"""SELECT COUNT(*) FROM messages LEFT JOIN message_details AS details ON details.message_id=messages.id
        WHERE room_id=? AND COALESCE(details.kind,'opinion')='opinion' AND author IN ({marks})""", (room_id, *experts)).fetchone()[0]


def turn_status_label(turn, room):
    """Describe pending work using the expert's configured participation mode."""
    if turn["status"] == "pending":
        mode = room["experts"].get(turn["expert"])
        return {"cli": "待处理（本地 CLI）", "online": "待联系（在线专家）"}.get(mode, "待处理")
    return TURN_STATUSES[turn["status"]]


def topic_context(background, user_request=None):
    """Separate explicitly marked legacy requests without guessing unmarked text."""
    if user_request is None:
        match = re.match(r"^用户原文[：:][ \t]*(?:\r?\n)?([\s\S]*?)(?:\r?\n){2,}((?:项目背景与入口|背景)[：:][\s\S]*)$", background)
        if match:
            user_request, background = match.group(1), match.group(2)
    return {"user_request": user_request or "", "background": background}


def topic_defaults():
    """Return independent participation defaults for existing rooms."""
    return {"host": "用户", "background": "", "boundaries": "", "phase": "preparing", "focus": "",
            "experts": {name: "cli" if name == "Codex" else "online" for name in PARTICIPANTS[1:] if name != "Grok"}}


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
    result["phase"] = payload.get("phase", result["phase"])
    result["experts"] = payload.get("experts", result["experts"])
    experts = result["experts"]
    if (not isinstance(experts, dict) or len(experts) > MAX_ROOM_AGENTS
            or any(not is_ai(name) or mode not in ("cli", "online") for name, mode in experts.items())):
        raise ValueError("专家需为有效 AI 身份，参与方式为 cli 或 online")
    if result["host"] != "用户" and experts.get(result["host"]) != "cli":
        raise ValueError("AI 主持人必须是可读可写的本地 CLI 参与者")
    if result["phase"] not in PHASES:
        raise ValueError("话题阶段无效")
    if "limits" in payload:
        result["limits"] = limit_values(payload["limits"], (current or {}).get("limits"))
        changed = any(result["limits"][key] != current["limits"][key] for key in LIMIT_DEFAULTS) if current else False
        if changed and current["phase"] not in ("preparing", "paused"):
            raise ValueError("请先暂停讨论，再修改上限参数")
        result["save_limits"] = not current or changed
        result["reset_stop"] = not current or any(result["limits"][key] != current["limits"][key]
                                                  for key in LIMIT_DEFAULTS if key != "execution_minutes")
    return result


def save_topic_settings(connection, room_id, settings):
    """Persist topic settings without modifying any original messages."""
    if settings.get("save_limits"):
        connection.execute("""UPDATE discussion_limits SET max_rounds=?,max_minutes=?,execution_minutes=?,
            stop_reason=CASE WHEN ? THEN '' ELSE stop_reason END,revision=revision+1 WHERE room_id=?""",
                           [*(settings["limits"][key] for key in LIMIT_DEFAULTS), settings["reset_stop"], room_id])
    values = [settings[key] for key in ("host", "background", "boundaries")]
    values.extend([json.dumps(settings["experts"], ensure_ascii=False), settings["phase"], settings["focus"]])
    connection.execute("INSERT INTO topic_settings (room_id,host,background,boundaries,experts,phase,focus) VALUES (?,?,?,?,?,?,?) ON CONFLICT(room_id) DO UPDATE SET host=excluded.host,background=excluded.background,boundaries=excluded.boundaries,experts=excluded.experts,phase=excluded.phase,focus=excluded.focus", [room_id, *values])
    connection.execute("INSERT INTO room_user_requests (room_id,text) VALUES (?,?) ON CONFLICT(room_id) DO UPDATE SET text=excluded.text",
                       (room_id, settings.get("user_request", "")))


def require_host(room, payload):
    """Check the declared operator; this is a workflow rule, not authentication."""
    if payload.get("actor") not in (room["host"], "用户"):
        raise ValueError("请使用当前主持人或用户身份管理话题")


def conclusion_view(connection, room):
    """What a host must clear before concluding: unhandled user input, a stale state, queued turns; revision changes with any of them."""
    marks = ",".join("?" * len(room["experts"]))
    last_opinion = connection.execute(f"""SELECT COALESCE(MAX(messages.id),0) FROM messages
        LEFT JOIN message_details AS details ON details.message_id=messages.id
        WHERE room_id=? AND COALESCE(details.kind,'opinion')='opinion' AND author IN ({marks})""", (room["id"], *room["experts"])).fetchone()[0] if room["experts"] else 0
    blockers = []
    if room["held_since"]:
        blockers.append("有未处理的用户留言或设置变更")
    if room["state_until"] < last_opinion:
        blockers.append(f"状态整理至 #{room['state_until']}，未覆盖最新发言 #{last_opinion}；先更新 state 与简报")
    if room["queued_turns"]:
        blockers.append(QUEUED_BLOCKER)
    state = json.dumps([room["latest_id"], room["state_until"], room["held_since"], len(room["queued_turns"])])
    return {"latest_id": room["latest_id"], "last_opinion_id": last_opinion, "state_until": room["state_until"], "held_since": room["held_since"],
            "queued": len(room["queued_turns"]), "blockers": blockers, "ready": not blockers,
            "revision": hashlib.sha256(state.encode("utf-8")).hexdigest()[:12]}


QUEUED_BLOCKER = "仍有排队的发言安排"


def require_conclusion_ready(connection, room, payload, allow_queued=False):
    """A host concludes only against the latest conclusion state with nothing blocking; the user is not bound by this.

    Declaring the goal done or forcing the wrap-up skips queued turns itself, so they do not block those.
    """
    if payload.get("actor") == "用户":
        return
    view = conclusion_view(connection, room)
    if allow_queued:
        view["blockers"] = [item for item in view["blockers"] if item != QUEUED_BLOCKER]
    if payload.get("conclusion") is None:
        raise ValueError("收束前须先读取收束状态（room conclusion），并带上其 revision")
    if payload["conclusion"] != view["revision"]:
        raise FileExistsError("房间状态已变化，请重新读取 room conclusion 后再收束")
    if view["blockers"]:
        raise ValueError(f"暂不能收束：{'；'.join(view['blockers'])}")


def update_topic(connection, room_id, payload):
    """Update topic direction and participants through a declared host action."""
    begin_write(connection)
    room = require_room(connection, room_id)
    if room["mode"] == "free" and "phase" in payload:
        raise ValueError("自由协作房间的讨论阶段由 discussion 会话控制")
    require_host(room, payload)
    settings = topic_values(payload, room)
    request_session = current_session(connection, room_id, active_only=True)
    if request_session:
        if "limits" in payload:
            raise ValueError("新讨论的上限请通过 limits 接口修改")
        if settings["host"] != room["host"] or settings["experts"] != room["experts"]:
            raise ValueError("新讨论中的主持人与成员请通过成员管理操作调整")
        connection.execute("UPDATE rooms SET title=?,goal=? WHERE id=?", (settings["title"], settings["goal"], room_id))
        connection.execute("UPDATE topic_settings SET background=?,boundaries=?,focus=? WHERE room_id=?",
                           (settings["background"], settings["boundaries"], settings["focus"], room_id))
        connection.execute("INSERT INTO room_user_requests (room_id,text) VALUES (?,?) ON CONFLICT(room_id) DO UPDATE SET text=excluded.text",
                           (room_id, settings.get("user_request", "")))
        return require_room(connection, room_id)
    if room["archived"] and settings["phase"] not in ("paused", "concluded"):
        raise ValueError("请先恢复已存档房间，再调整讨论阶段")
    turn = room["current_turn"]
    if turn and turn["status"] in ("pending", "notified"):
        if settings["phase"] == "concluded" or turn["expert"] not in settings["experts"]:
            raise ValueError("请先完成或取消当前发言安排")
    if settings["phase"] == "concluded" and room["phase"] != "concluded":
        require_conclusion_ready(connection, room, payload)
    if room["phase"] == "concluded" and settings["phase"] != "concluded" and payload.get("actor") != "用户":
        raise ValueError("已收束的讨论只有用户能重新开启")
    running = connection.execute("SELECT 1 FROM discussion_runtime WHERE room_id=? AND status='running'", (room_id,)).fetchone()
    if running and settings["experts"] != room["experts"]:
        raise ValueError("讨论运行中请在进度看板邀请、暂离或移除专家")
    connection.execute("UPDATE rooms SET title=?,goal=? WHERE id=?", (settings["title"], settings["goal"], room_id))
    sync_discussion_members(connection, room_id, payload, settings)
    save_topic_settings(connection, room_id, settings)
    if settings["phase"] == "concluded" and room["phase"] != "concluded" and room["mode"] != "free" and not room["archived"]:
        return_to_free(connection, {**room, "host": settings["host"]})
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


def list_rooms(connection, params=None):
    """Return rooms, optionally locating a single persisted creation request."""
    params = params or {}
    identifier = submission_value(params["submission_id"]) if "submission_id" in params else None
    where = "WHERE EXISTS (SELECT 1 FROM room_creations WHERE room_id=rooms.id AND submission_id=?)" if identifier else ""
    rows = connection.execute(f"""SELECT rooms.*,
        COUNT(CASE WHEN NOT EXISTS (SELECT 1 FROM internal_task_messages t WHERE t.message_id=messages.id) THEN messages.id END) AS message_count,
        COALESCE(MAX(CASE WHEN NOT EXISTS (SELECT 1 FROM internal_task_messages t WHERE t.message_id=messages.id) THEN messages.id END),0) AS latest_id
        FROM rooms LEFT JOIN messages ON rooms.id=messages.room_id {where}
        GROUP BY rooms.id ORDER BY rooms.created_at, rooms.id""", (identifier,) if identifier else ())
    directory = {row["room_id"]: dict(row) for row in connection.execute("SELECT * FROM room_directory")}
    assignments = {row["room_id"]: row["folder_id"] for row in connection.execute("SELECT room_id,folder_id FROM room_folder_assignments")}
    rooms = [{**dict(row), "archived": bool(directory[row["id"]]["archived"]), "folder_id": assignments[row["id"]]} for row in rows]
    return {"rooms": sorted(rooms, key=lambda room: directory[room["id"]]["position"]),
            **folder_directory(connection)}


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
        if action == "archive" and room["mode"] == "free":
            session = current_session(connection, room_id, active_only=True)
            if session and session["status"] == "active":
                from .session_room import cancel_session_work
                cancel_session_work(connection, session["id"], "房间已归档")
                connection.execute("UPDATE discussion_sessions SET status='paused' WHERE id=?", (session["id"],))
                connection.execute("UPDATE session_pauses SET paused_at=? WHERE session_id=?", (int(time.time()), session["id"]))
                connection.execute("UPDATE session_state SET revision=revision+1 WHERE session_id=?", (session["id"],))
        if action == "archive" and room["phase"] != "concluded":
            save_topic_settings(connection, room_id, {**room, "phase": "paused"})
        if action == "archive" and room["mode"] == "free":
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
    connection.execute("DELETE FROM discussion_sessions WHERE room_id=?", (room_id,))
    for table in ("member_recommendations", "free_queue", "speaking_orders", "member_requests", "member_descriptions", "member_labels", "execution_notes", "execution_segments", "member_executions", "member_sessions", "member_registrations", "room_members", "room_modes", "free_batches", "free_chains", "free_handoffs", "free_settings", "free_round_limits", "free_chain_holds", "room_links",
                  "discussion_options", "round_budgets", "scheduler_decisions", "scheduler_routing", "discussion_conclusions", "discussion_sessions"):
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
    connection.execute("DELETE FROM discussion_turns WHERE room_id=?", (room_id,))
    connection.execute("UPDATE messages SET reply_to=NULL WHERE room_id=?", (room_id,))
    connection.execute("DELETE FROM messages WHERE room_id=?", (room_id,))
    for table in ("room_floor", "topic_settings", "room_creations", "room_directory", "room_folder_assignments", "room_briefs", "room_user_requests"):
        connection.execute(f"DELETE FROM {table} WHERE room_id=?", (room_id,))
    connection.execute("DELETE FROM rooms WHERE id=?", (room_id,))


def creation_request(settings):
    """Freeze normalized creation inputs independently of later topic edits."""
    fields = ("title", "goal", "host", "background", "boundaries", "phase", "focus")
    values = [settings[field] for field in fields] + [sorted(settings["experts"].items())]
    if settings.get("save_limits"):
        values.append([settings["limits"][key] for key in LIMIT_DEFAULTS])
    request = json.dumps(values, ensure_ascii=False, separators=(",", ":"))
    return request + (":user_request:" + json.dumps(settings["user_request"], ensure_ascii=False)
                      if settings.get("user_request") else "")


def create_room(connection, payload, control_token=""):
    """Create a credential-protected room, binding retries to the original credentials."""
    if payload.get("mode", "free") not in ("free", "brainstorm"):
        raise ValueError("房间模式须为 free 或 brainstorm")
    free = True
    members = member_values(payload.get("members")) if free else []
    if free:
        payload = {**payload, "mode": "free", "phase": "discussing",
                   "experts": {member["name"]: "online" if member.get("manual_source") == "web" else "cli" for member in members}}
    settings = topic_values(payload)
    automatic = payload.get("runtime_mode") == "automatic"
    if payload.get("runtime_mode", "manual") not in ("manual", "automatic") or not token_hash(control_token):
        raise ValueError("建房须提供有效的运行模式和房主控制凭据")
    if free and (automatic or not token_hash(control_token)):
        raise ValueError("自由房间须提供房间控制凭据，且不使用讨论运行模式")
    named_followup = payload.get("named_followup", False)
    if type(named_followup) is not bool:
        raise ValueError("named_followup 须为布尔值")
    parent_id = payload.get("parent_room_id")
    if parent_id is not None and (free or not isinstance(parent_id, str) or room_mode(connection, parent_id) != "free"):
        raise ValueError("只有从自由协作房间发起的讨论房间可以关联来源房间")
    identifier = submission_value(payload["submission_id"]) if "submission_id" in payload else None
    folder_id = payload.get("folder_id")
    if folder_id is not None and not isinstance(folder_id, str):
        raise ValueError("文件夹编号必须是文本或 null")
    request_text = creation_request(settings) + (":automatic" if automatic else "")
    request_text += ":access:" + token_hash(control_token) + ":" + json.dumps(
        [[member["name"], member["adapter"], member["access"], member["manual_source"],
          member["session_mode"], token_hash(member["token"])] for member in members], ensure_ascii=False)
    if free:
        request_text += ":free"
    elif named_followup:
        request_text += ":named_followup"
    if parent_id is not None:
        request_text += ":parent:" + parent_id
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
    save_room_access(connection, room_id, control_token, members,
                     {"mode": "free" if free else "brainstorm", "host": settings["host"], "created_at": utc_now()})
    if free:
        sync_participants(connection, room_id)
    else:
        connection.execute("INSERT INTO discussion_options (room_id,named_followup) VALUES (?,?)", (room_id, int(named_followup)))
        connection.execute("INSERT INTO round_budgets (room_id) VALUES (?)", (room_id,))
    if parent_id is not None:
        connection.execute("INSERT INTO room_links (room_id,parent_id,created_at) VALUES (?,?,?)", (room_id, parent_id, utc_now()))
    return {**require_room(connection, room_id), "duplicate": False, "submission_id": identifier}


def return_to_free(connection, room):
    """End the discussion in place: stop its run and turns, switch back to free collaboration and route held user messages."""
    room_id = room["id"]
    connection.execute("""UPDATE discussion_runtime SET status='stopped',generation=generation+1,revision=revision+1
        WHERE room_id=? AND status IN ('running','ready','paused')""", (room_id,))
    connection.execute("UPDATE discussion_turns SET status='cancelled' WHERE room_id=? AND status IN ('pending','notified')", (room_id,))
    connection.execute("UPDATE discussion_turns SET status='skipped' WHERE room_id=? AND status='queued'", (room_id,))
    connection.execute("UPDATE topic_settings SET phase='concluded' WHERE room_id=?", (room_id,))
    connection.execute("UPDATE room_modes SET mode='free' WHERE room_id=?", (room_id,))
    route_held_messages(connection, room_id, room["host"])


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


def message_details(room, payload):
    """Validate declared author, moderator role, and forwarding attribution."""
    author = payload["author"]
    kind = payload.get("kind", "opinion")
    submitted_by = payload.get("submitted_by", author if payload.get("source") in ("cli", "api") else "用户")
    if kind not in ("opinion", "moderation") or not is_participant(submitted_by):
        raise ValueError("发言职责或提交者无效")
    if submitted_by not in ("用户", room["host"], author):
        raise ValueError("只有用户或主持人可以代发其他专家的观点")
    if kind == "moderation" and (author != room["host"] or submitted_by not in ("用户", room["host"])):
        raise ValueError("主持发言必须保留当前主持人署名")
    if submitted_by == author and payload.get("source") in ("cli", "api") and author != "用户" and room["experts"].get(author) != "cli":
        raise ValueError("当前专家配置为在线只读，请由用户或主持人代发")
    source = "host_proxy" if submitted_by == room["host"] != author and submitted_by != "用户" else (
        payload["source"] if payload.get("source") in ("cli", "api") and submitted_by == author else ("user" if author == "用户" else "proxy"))
    return {"kind": kind, "submitted_by": submitted_by, "turn_id": int(payload["turn_id"]) if payload.get("turn_id") else None, "source": source}


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
    """Keep replies and scheduled answers within their declared topic."""
    if message["reply_to"] and not connection.execute("SELECT id FROM messages WHERE room_id=? AND id=?", (room_id, message["reply_to"])).fetchone():
        raise ValueError("回复的消息不在当前房间中")
    if message["turn_id"]:
        turn = get_turn(connection, room_id, message["turn_id"])
        if turn["expert"] != message["author"] or message["kind"] != "opinion":
            raise ValueError("回答需使用被安排专家的身份和专家观点职责")
        if turn["status"] not in ("pending", "notified"):
            raise FileExistsError("该发言安排已完成或取消")


def record_message_timing(connection, message_id, token):
    """Freeze elapsed time only for the execution that actually authored this message."""
    if not token:
        return
    connection.execute("""INSERT INTO message_timings(message_id,elapsed_seconds)
        SELECT m.id,MAX(0,CAST(strftime('%s',m.created_at) AS INTEGER)-t.dispatched_at)
        FROM messages AS m JOIN message_details AS d ON d.message_id=m.id
        JOIN discussion_events AS e ON e.room_id=m.room_id AND e.participant=m.author
        JOIN event_timings AS t ON t.event_id=e.id
        WHERE m.id=? AND m.source IN ('cli','api') AND d.submitted_by=m.author
            AND e.status='started' AND e.token_hash=? AND t.dispatched_at>0
        ON CONFLICT(message_id) DO NOTHING""", (message_id, token_hash(token)))


def append_free_message(connection, room, payload, actor):
    """Append a free-room message: the owner's creates requests, a member's completes its execution.

    The owner may also forward an online member's answer; it keeps the member as author and the
    owner as submitter.
    """
    if payload.get("kind") == "moderation":
        if any(payload.get(field) for field in ("next_review", "review_scope", "review_roster")):
            raise ValueError("主持说明不能声明评审授权；请在派实现任务时提交")
        return append_free_moderation(connection, room, payload, actor)
    if payload.get("kind") not in (None, "chat"):
        raise ValueError("自由协作与新讨论使用 kind=chat，并以 execution_id 或 request_ids 关联请求")
    if payload.get("turn_id") is not None and current_session(connection, room["id"], active_only=True):
        raise ValueError("新讨论使用 kind=chat，并以 execution_id 或 request_ids 关联请求")
    author, text, submission_id, reply_to = message_values(payload)
    room_id = room["id"]
    proxy = actor if isinstance(actor, dict) and actor.get("proxy_by") else None
    if actor == "用户" and author != "用户":
        proxy = proxy_member(connection, room_id, author)
        if payload.get("submitted_by", "用户") != "用户":
            raise PermissionError("代发在线成员的回答须由用户提交")
    proxy_by = proxy.get("proxy_by") if proxy else None
    submitted_by = proxy_by or ("用户" if proxy else author)
    expected = {"author": author, "text": text, "reply_to": reply_to, "kind": "chat", "submitted_by": submitted_by,
                "turn_id": None, "source": ("host_proxy" if proxy_by else "proxy") if proxy else ("user" if author == "用户" else "api" if payload.get("source") == "api" else "cli")}
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
    if proxy:
        check_proxy(connection, room_id, proxy, payload)
    elif actor != "用户":
        check_answer(connection, room_id, actor, payload)
    review_plan = checked_review_plan(connection, room_id, actor, payload)
    cursor = connection.execute("INSERT INTO messages (room_id,author,text,reply_to,source,submission_id,created_at) VALUES (?,?,?,?,?,?,?)",
                                (room_id, author, text, reply_to, expected["source"], submission_id, utc_now()))
    connection.execute("INSERT INTO message_details (message_id,kind,submitted_by,turn_id) VALUES (?,?,?,NULL)",
                       (cursor.lastrowid, "chat", submitted_by))
    connection.execute("INSERT INTO message_summaries (message_id,text,author) VALUES (?,?,?)",
                       (cursor.lastrowid, expected["summary"], expected["summary_by"]))
    for position, identifier in enumerate(identifiers):
        connection.execute("UPDATE attachments SET message_id=?,position=? WHERE id=?", (cursor.lastrowid, position, identifier))
    save_suggestions(connection, room_id, cursor.lastrowid, proxy or actor, payload)
    save_review_plan(connection, room_id, cursor.lastrowid, review_plan)
    after_free_message(connection, room_id, cursor.lastrowid, proxy or actor, payload)
    complete_session_requests(connection, room_id, payload, proxy or actor, cursor.lastrowid)
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
                "submitted_by": author, "turn_id": None, "source": payload.get("source") if payload.get("source") in ("cli", "api") else "cli"}
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
    connection.execute("INSERT INTO message_details (message_id,kind,submitted_by,turn_id) VALUES (?,?,?,NULL)",
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
    if client not in ("claude", "codex", "antigravity") or not isinstance(session_id, str) or not SESSION_ID_PATTERN.fullmatch(session_id) or not token:
        return
    member = connection.execute("SELECT id FROM room_members WHERE room_id=? AND token_hash=? AND status='active' AND access='manual' AND adapter IN ('manual','')",
                                (room_id, token_hash(token))).fetchone()
    if member:
        connection.execute("""INSERT INTO member_sessions (member_id,room_id,session_id,client) VALUES (?,?,?,?)
            ON CONFLICT(member_id) DO UPDATE SET session_id=excluded.session_id,client=excluded.client""", (member["id"], room_id, session_id, client))


def answers_direct_question(payload):
    """A discussion message that closes the user's direct question: it names an execution or the requests it answers."""
    return type(payload.get("execution_id")) is int or bool(payload.get("request_ids"))


def append_message(connection, room_id, payload, token="", free_actor=None):
    """Atomically append an attributed message and complete its scheduled turn."""
    author, text, submission_id, reply_to = message_values(payload)
    begin_write(connection)
    room = require_room(connection, room_id)
    if room["mode"] == "free" or free_actor is not None:
        previous = connection.execute(f"{MESSAGE_QUERY} WHERE room_id=? AND submission_id=?", (room_id, submission_id)).fetchone()
        # An exact retry of a discussion message saved before the discussion ended keeps its original result.
        if previous and previous["kind"] not in ("chat", "moderation") and (previous["author"], previous["text"]) == (author, text):
            return {"message": message_with_attachments(connection, previous), "duplicate": True}
        return append_free_message(connection, room, payload, free_actor)
    details = message_details(room, {**payload, "author": author})
    # An expert's opinion answers the arrangement open for that expert; naming it with turn_id is optional.
    implied_turn = author != "用户" and details["kind"] == "opinion" and not details["turn_id"]
    expected = {"author": author, "text": text, "reply_to": reply_to, **details}
    expected.update(message_summary(payload, expected))
    identifiers = attachment_ids(payload)
    previous = connection.execute(f"{MESSAGE_QUERY} WHERE room_id=? AND submission_id=?", (room_id, submission_id)).fetchone()
    if previous:
        previous = message_with_attachments(connection, previous)
        same_turn = implied_turn or previous["turn_id"] == expected["turn_id"]
        if (any(previous[key] != expected[key] for key in ("author", "text", "reply_to", "kind", "submitted_by", "summary", "summary_by")) or not same_turn
                or [item["id"] for item in previous["attachments"]] != identifiers):
            raise FileExistsError("这个提交编号已被另一条内容使用，请为新发言生成新编号")
        return {"message": previous, "duplicate": True}
    if implied_turn:
        open_turn = connection.execute("SELECT id FROM discussion_turns WHERE room_id=? AND expert=? AND status IN ('pending','notified')", (room_id, author)).fetchone()
        if not open_turn:
            raise ValueError("专家观点只能回答为你安排的发言；当前没有轮到你的有效安排")
        details["turn_id"] = expected["turn_id"] = open_turn["id"]
    if author != "用户" and details["kind"] == "opinion":
        require_within_limits(room)
    if room["phase"] in ("paused", "concluded") and details["kind"] == "opinion" and (author != "用户" or room["archived"]):
        raise ValueError("话题已暂停或收束；恢复阶段后才能提交新观点")
    check_message_references(connection, room_id, expected)
    check_message_attachments(connection, room_id, details["submitted_by"], identifiers)
    asked = checked_asks(connection, room, payload) if author == "用户" else []
    cursor = connection.execute("INSERT INTO messages (room_id,author,text,reply_to,source,submission_id,created_at) VALUES (?,?,?,?,?,?,?)",
                                (room_id, author, text, reply_to, details["source"], submission_id, utc_now()))
    connection.execute("INSERT INTO message_details (message_id,kind,submitted_by,turn_id) VALUES (?,?,?,?)",
                       (cursor.lastrowid, details["kind"], details["submitted_by"], details["turn_id"]))
    connection.execute("INSERT INTO message_summaries (message_id,text,author) VALUES (?,?,?)",
                       (cursor.lastrowid, expected["summary"], expected["summary_by"]))
    for position, identifier in enumerate(identifiers):
        connection.execute("UPDATE attachments SET message_id=?,position=? WHERE id=?",
                           (cursor.lastrowid, position, identifier))
    record_message_timing(connection, cursor.lastrowid, token)
    record_reported_session(connection, room_id, token, payload)
    ask_members(connection, room, cursor.lastrowid, asked)
    if details["turn_id"]:
        connection.execute("UPDATE discussion_turns SET status='answered',answer_id=? WHERE id=?", (cursor.lastrowid, details["turn_id"]))
    saved_message = connection.execute(f"{MESSAGE_QUERY} WHERE messages.id=?", (cursor.lastrowid,)).fetchone()
    return {"message": message_with_attachments(connection, saved_message), "duplicate": False}


def get_turn(connection, room_id, turn_id):
    """Read a single speaking assignment inside its topic."""
    row = connection.execute("SELECT * FROM discussion_turns WHERE room_id=? AND id=?", (room_id, int(turn_id))).fetchone()
    if not row:
        raise LookupError("发言安排不存在")
    return dict(row)


def query_turns(connection, room_id, params):
    """Read speaking assignments in bounded chronological pages."""
    require_room(connection, room_id)
    page = max(1, int(params.get("page", 1)))
    where, values = "room_id=?", [room_id]
    if "submission_id" in params:
        where += " AND submission_id=?"
        values.append(submission_value(params["submission_id"]))
    total = connection.execute(f"SELECT COUNT(*) FROM discussion_turns WHERE {where}", values).fetchone()[0]
    rows = connection.execute(f"SELECT * FROM discussion_turns WHERE {where} ORDER BY id LIMIT ? OFFSET ?", [*values, PAGE_SIZE, (page - 1) * PAGE_SIZE])
    return {"turns": [dict(row) for row in rows], "page": page, "pages": max(1, (total + PAGE_SIZE - 1) // PAGE_SIZE), "total": total}


def plan_values(payload):
    """Normalize one arrangement or an ordered round plan into (expert, question, submission_id) items."""
    items = payload.get("turns")
    if items is None:
        items = [{"expert": payload.get("expert", ""), "question": payload.get("question", "")}]
    if not isinstance(items, list) or not 1 <= len(items) <= MAX_PLAN_TURNS:
        raise ValueError(f"整轮安排需要 1–{MAX_PLAN_TURNS} 项")
    submission_id = submission_value(payload.get("submission_id"))
    plan = []
    for index, item in enumerate(items):
        if not isinstance(item, dict):
            raise ValueError("整轮安排的每一项需要 expert 和 question")
        expert, question, _, _ = message_values({"author": item.get("expert", ""), "text": item.get("question", ""),
                                                 "submission_id": submission_id})
        plan.append((expert, question, submission_id if index == 0 else f"{submission_id}-q{index + 1}"))
    return plan


def roster_view(room):
    """Who is present and who still owes a turn in the open round; its revision changes whenever either changes."""
    last = room["rounds"][-1] if room["rounds"] else None
    spoken = set(last["speakers"]) if last and not last["completed"] else set()
    pending_registration = unregistered_experts(room)
    # Experts follow the room's speaking order, so a round plan can take the user's preferred order from the roster.
    rank = {item["name"]: index for index, item in enumerate(room["speaking_order"]["items"])}
    experts = [{"name": name, "mode": room["experts"][name], "host": name == room["host"], "spoken": name in spoken,
                "registered": name not in pending_registration} for name in sorted(room["experts"], key=lambda name: rank.get(name, len(rank)))]
    state = json.dumps([sorted(room["experts"]), sorted(spoken), sorted(pending_registration)], ensure_ascii=False)
    return {"experts": experts, "unregistered": pending_registration,
            "waiting": [item["name"] for item in experts if not item["spoken"] and not item["host"] and item["registered"]],
            "revision": hashlib.sha256(state.encode("utf-8")).hexdigest()[:12]}


def unregistered_experts(room):
    """Manual experts of a woken discussion (adapter 'manual') that have not registered from their own session; they cannot be scheduled until they do."""
    return [member["name"] for member in room["members"]
            if member["adapter"] == "manual" and member["status"] == "active" and not member["registered_at"] and member["name"] in room["experts"]]


def require_registered(room, names):
    """Reject scheduling an expert that has not registered yet; it joins the round queue by itself once it registers."""
    missing = [name for name in dict.fromkeys(names) if name in unregistered_experts(room)]
    if missing:
        raise ValueError(f"以下手动专家尚未注册，不能安排发言：{'、'.join(missing)}；它在自己的会话中注册后会自动加入本轮队列，也可先让其暂离")


def require_round_coverage(room, plan, payload):
    """A multi-turn plan is only accepted against the latest roster and must schedule everyone still waiting in the round."""
    if len(plan) < 2:
        return
    roster = roster_view(room)
    if payload.get("roster") is None:
        raise ValueError("整轮安排前须先获取最新专家状态（turn roster），并在计划中带上其 revision")
    if payload["roster"] != roster["revision"]:
        raise FileExistsError("专家状态已变化，请重新获取 turn roster 后再安排")
    missing = [name for name in roster["waiting"] if name not in {expert for expert, _, _ in plan}]
    if missing:
        raise ValueError(f"整轮安排缺少本轮尚未发言的专家：{'、'.join(missing)}；本轮不需要其发言时先让其暂离，再重新获取 turn roster")


def create_turn(connection, room_id, payload):
    """Schedule one expert, or a round whose later turns relay without waking the host."""
    begin_write(connection)
    room = require_room(connection, room_id)
    require_host(room, payload)
    plan = plan_values(payload)
    previous = [connection.execute("SELECT * FROM discussion_turns WHERE room_id=? AND submission_id=?",
                                   (room_id, item[2])).fetchone() for item in plan]
    if previous[0]:
        if any(not row or (row["expert"], row["question"]) != item[:2] for row, item in zip(previous, plan)):
            raise FileExistsError("该安排编号已被其他内容使用")
        return {"turn": dict(previous[0]), "queued": [dict(row) for row in previous[1:]], "duplicate": True}
    require_within_limits(room)
    if any(expert not in room["experts"] or len(question) > MAX_QUESTION_LENGTH for expert, question, _ in plan):
        raise ValueError("请选择参与专家，待回应问题最多 1000 字")
    require_registered(room, [expert for expert, _, _ in plan])
    require_round_coverage(room, plan, payload)
    if room["phase"] in ("paused", "concluded"):
        raise ValueError("话题已暂停或收束，请先调整阶段")
    if room["current_turn"] and room["current_turn"]["status"] in ("pending", "notified"):
        raise FileExistsError("请先完成或取消当前发言安排")
    ids = []
    for index, (expert, question, submission_id) in enumerate(plan):
        cursor = connection.execute(
            "INSERT INTO discussion_turns (room_id,expert,question,status,submission_id,created_at) VALUES (?,?,?,?,?,?)",
            (room_id, expert, question, "pending" if index == 0 else "queued", submission_id, utc_now()))
        ids.append(cursor.lastrowid)
    return {"turn": get_turn(connection, room_id, ids[0]),
            "queued": [get_turn(connection, room_id, turn_id) for turn_id in ids[1:]], "duplicate": False}


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


def record_scheduler_decision(connection, room_id, token, payload, owner=False):
    """The dispatcher records one smart-scheduling decision so the transcript shows what it did and how sure it was.

    A free room has no run control: its local service records with the owner credential.
    """
    begin_write(connection)
    (require_owner if owner else require_control)(connection, room_id, token)
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


def continue_turns(connection, room_id, payload):
    """Resume the remaining round plan after the host has handled user actions or an interruption."""
    begin_write(connection)
    room = require_room(connection, room_id)
    require_host(room, payload)
    if room["phase"] in ("paused", "concluded"):
        raise ValueError("话题已暂停或收束，请先调整阶段")
    if room["current_turn"] and room["current_turn"]["status"] in ("pending", "notified"):
        raise FileExistsError("当前已有进行中的发言安排")
    if not room["queued_turns"]:
        raise FileExistsError("没有排队中的安排；请创建新的安排")
    require_within_limits(room)
    require_registered(room, [room["queued_turns"][0]["expert"]])
    turn_id = room["queued_turns"][0]["id"]
    connection.execute("UPDATE discussion_turns SET status='pending' WHERE id=? AND status='queued'", (turn_id,))
    return {"turn": get_turn(connection, room_id, turn_id), "queued": room["queued_turns"][1:]}

def reopen_limits(connection, room_id, payload):
    """User-only: reopen a concluded discussion that has not returned to free collaboration."""
    begin_write(connection)
    room = require_room(connection, room_id)
    if payload.get("actor") != "用户":
        raise ValueError("仅用户可以重启已收束的讨论")
    if room["archived"]:
        raise ValueError("请先恢复已存档房间")
    if room["mode"] == "free":
        raise ValueError("房间已回到自由协作；需要讨论时请重新开启讨论")
    if not room["round_budget"]:
        raise ValueError("该房间沿用旧轮次计数，不支持重启")
    if room["phase"] != "concluded":
        raise ValueError("仅已收束的讨论可以重启")
    rounds = payload.get("max_rounds", room["limits"]["max_rounds"])
    if type(rounds) is not int or not 0 <= rounds <= 100:
        raise ValueError("轮次须为 0–100 的整数，0 表示不限")
    count = opinion_count(connection, room_id, room["experts"])
    limits = limit_values({"max_rounds": rounds, "max_minutes": payload.get("max_minutes", room["limits"]["max_minutes"])}, room["limits"])
    connection.execute("UPDATE round_budgets SET base=?,cap=0,extra=0 WHERE room_id=?", (count, room_id))
    connection.execute("""UPDATE discussion_limits SET max_rounds=?,max_minutes=?,started_at=0,stop_reason='',revision=revision+1
        WHERE room_id=?""", (limits["max_rounds"], limits["max_minutes"], room_id))
    connection.execute("UPDATE discussion_pauses SET paused_seconds=0,paused_at=0 WHERE room_id=?", (room_id,))
    connection.execute("UPDATE topic_settings SET phase='paused' WHERE room_id=?", (room_id,))
    return require_room(connection, room_id)


def check_limits(connection, room_id, payload):
    """End the discussion at a reached boundary (or once the host declares the goal done); the room returns to free collaboration."""
    action = payload.get("action", "check")
    if action not in ("check", "done", "reopen"):
        raise ValueError("action 须为 check/done/reopen")
    if action == "reopen":
        return reopen_limits(connection, room_id, payload)
    begin_write(connection)
    if current_session(connection, room_id, active_only=True):
        if action == "done":
            raise ValueError("讨论会话须由房主通过 discussion 接口结束")
        enforce_session_limits(connection, room_id)
        return require_room(connection, room_id)
    room = require_room(connection, room_id)
    require_host(room, payload)
    limits = room["limits"]
    done = action == "done"
    inactive = (room["mode"] == "free" or room["phase"] in ("paused", "concluded") or room["archived"]
                or (done and room["phase"] == "preparing"))
    if (not limits["reached"] and not done) or inactive:
        return room
    if done:
        require_conclusion_ready(connection, room, payload, allow_queued=True)
    reason = "goal_done" if done else limits["reason"] or "user_stop"
    connection.execute("UPDATE discussion_limits SET stop_reason=?,revision=revision+1 WHERE room_id=?", (reason, room_id))
    # The run's generation moves on, so the old execution is superseded; unnamed messages now go to the host as usual.
    return_to_free(connection, room)
    return require_room(connection, room_id)


def update_turn(connection, room_id, turn_id, payload):
    """Record a host's explicit notification confirmation or cancellation."""
    begin_write(connection)
    room = require_room(connection, room_id)
    require_host(room, payload)
    turn = get_turn(connection, room_id, turn_id)
    status = payload.get("status")
    if status not in ("notified", "cancelled"):
        raise ValueError("安排状态仅可显式改为 notified 或 cancelled")
    if turn["status"] == status or (status == "cancelled" and turn["status"] == "skipped"):
        return turn
    if status == "notified" and room["phase"] in ("paused", "concluded"):
        raise ValueError("话题已暂停或收束，不能继续通知")
    if turn["status"] not in ("pending", "notified"):
        raise FileExistsError("该发言安排已结束")
    notified_at = utc_now() if status == "notified" else turn["notified_at"]
    connection.execute("UPDATE discussion_turns SET status=?,notified_at=? WHERE id=?", (status, notified_at, turn["id"]))
    return get_turn(connection, room_id, turn_id)


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
    cutoff = session_message_access(connection, room_id, params, token)
    where, values = message_filters(room_id, params)
    if cutoff is not None:
        where += " AND messages.id<=?"
        values.append(cutoff)
    total = connection.execute(f"SELECT COUNT(*) FROM ({MESSAGE_QUERY} WHERE {where})", values).fetchone()[0]
    rows = connection.execute(f"{MESSAGE_QUERY} WHERE {where} ORDER BY messages.id LIMIT ? OFFSET ?", [*values, PAGE_SIZE + 1, (page - 1) * PAGE_SIZE]).fetchall()
    messages = [message_with_attachments(connection, row) for row in rows[:PAGE_SIZE]]
    result = {"messages": messages, "page": page, "total": total,
              "pages": max(1, (total + PAGE_SIZE - 1) // PAGE_SIZE)}
    if "after" in params:
        result.update(next_after=messages[-1]["id"] if messages else int(params["after"]), has_more=len(rows) > PAGE_SIZE)
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
    turn_link = f" · 安排详情：/r/{message['room_id']}/turns/{message['turn_id']}?legacy=1" if message.get("turn_id") else ""
    return f"#{message['id']} · {message['author']} · {message['created_at']}{reply}\n职责：{role}；来源：{message['source']}；提交者：{message.get('submitted_by', '用户')}；安排：{message.get('turn_id') or '无'}{turn_link}{summary}{message['text']}{attachments}"


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
    if room["mode"] == "free":
        members = "；".join(f"{item['name']}（已读至 #{item['read_until']}，待投递 {item['pending']}）" for item in room["free"]["members"])
        request_session = current_session(connection, room_id, active_only=True)
        if request_session:
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
        content.extend(participation_text(params, free=True))
        return "\n\n".join(content)
    turn = room["current_turn"]
    content.append("没有发言权：被安排的专家直接回答自己的安排；用户本人和任何人的 @ 直接提问可随时发出。")
    if room["phase"] == "initial":
        content.append("本阶段先独立形成详细观点：仅阅读目标、背景、边界和自己的已有讨论；暂不阅读他人观点或主持总结。提交后再交叉阅读。这是参与约定，不是权限隔离。")
    if room["archived"]:
        content.append("房间已存档，记录仍可查阅；先恢复房间，再由用户明确恢复讨论阶段。")
    if room["phase"] in ("paused", "concluded"):
        content.append("停止处理发言安排，取消本讨论自己的后台任务并核对实际状态；不要因旧通知恢复讨论。")
    if turn:
        content.extend([f"当前安排 #{turn['id']}：{turn['expert']} · {turn_status_label(turn, room)}", f"待回应问题：{turn['question']}", f"安排详情：{base}/turns/{turn['id']}"])
    if room["queued_turns"]:
        content.append("本轮排队：" + " → ".join(f"#{item['id']} {item['expert']}" for item in room["queued_turns"]))
    if room["held_since"]:
        content.append(f"用户自 #{room['held_since']} 起有待主持人处理的操作；当前回答完成后交给主持人，不自动接力。")
    content.extend(["## 按需展开", "请自主选择需要的材料，不必读取全部历史。",
                    f"背景、边界与参与专家：{base}/brief",
                    f"共识与分歧（整理至 #{room['state_until']}）：{base}/state"])
    if participant:
        content.append(f"与 @{participant} 相关的观点：{base}/search?mention={participant}&page=1")
    content.extend(["", "## 读取与检索", f"完整历史（分页）：{base}/messages?page=1",
                    f"单条原文：{base}/messages/消息编号", f"检索：{base}/search?q=关键词&page=1",
                    f"按作者检索：{base}/search?author=Claude", f"发言安排历史：{base}/turns?page=1"])
    content.extend(participation_text(params))
    return "\n\n".join(content)


def participation_text(params, free=False):
    """Local AIs follow the skills; web AIs read this short guide in place of them."""
    footer = "参与方式按运行环境区分；主持人可以兼任专家；作者、职责与来源尚未认证。"
    if params.get("mode") == "cli":
        return ["", "## 本地 AI", "本地 AI 请调用 discuss-participant（主持人另调用 discuss-host），用 codiscuss 命令读写；"
                "字段与写入规则以 codiscuss room protocol 为准，不直接调用网站接口。", footer]
    return ["", "## 在线 AI · 只读参与",
            "你是只读成员：读取议题、状态和与你相关的原文，在自己的聊天窗口回答；回答由用户代发留档。",
            "先回答真正的问题，给出理由、证据、适用条件与不确定性；区分事实、推断和建议，引用原文编号，不编造他人的回答。"
            "讨论初始阶段先独立判断，暂不读他人观点；深入讨论先理解对方主张及其最有力的依据，再说明同意、分歧或需要补的证据。"
            "可以坚持有依据的少数意见，也可因新证据修改判断并说明变化。",
            "输出：完整正文；回答较长时先给 1–3 句摘要。",
            "不要操作网页表单、调用写入接口或生成发布链接。读取失败时如实报告，由用户提供复制的材料。",
            *(["自由协作：只回应点名给你的消息（编号见阅读通知），按时间顺序处理，后面的消息可以修正前面的。"] if free else []), footer]


def brief_text(room):
    """Render the detailed brief only when explicitly requested."""
    experts = "\n".join(f"- {name}：{'本地 CLI 读写' if mode == 'cli' else '在线只读'}" for name, mode in room["experts"].items())
    return f"# {room['title']} · 话题资料\n\n目标：{room['goal']}\n\n用户原文：\n{room['user_request'] or '未填写'}\n\n背景：\n{room['background'] or '未填写'}\n\n边界：\n{room['boundaries'] or '未填写'}\n\n主持人：{room['host']}（可兼任专家）\n\n参与专家：\n{experts}"


def turn_text(turn, room):
    """Render a speaking assignment without embedding discussion context."""
    room_id = room["id"]
    answer_id = turn.get("answer_id")
    answer = f"\n回答原文：/r/{room_id}/messages/{answer_id}" if answer_id else ""
    status = {"open": "pending"}.get(turn["status"], turn["status"])
    label = turn.get("status_label") or (turn_status_label({**turn, "status": status}, room)
        if status in TURN_STATUSES else {"failed": "回答失败", "active": "进行中"}.get(status, status))
    association = f"关联请求：{turn.get('member_request_id') or '尚未派发'}" if turn.get("session_id") else f"历史安排：{turn['id']}"
    return f"安排 #{turn['id']} · {turn['expert']} · {label}\n待回应问题：{turn['question']}\n话题入口：/r/{room_id}?participant={turn['expert']}\n{association}{answer}\n本地成员凭自己的请求或执行保存完整回答，较长回答可附摘要；旧安排仅供历史阅读。"


def protocol_text(room):
    """Describe the unified request/execution protocol separately from discussion material."""
    base = f"/api/rooms/{room['id']}"
    if room["mode"] != "free":
        return "# 旧讨论历史\n\n旧讨论已只读保留；如需继续，由用户在协作房间开启新讨论。"
    paragraphs = [
        "# 协作房间参与协议",
        "当前主持人：HOST。讨论是房间内的会话；自由协作请求与讨论请求共用成员执行。",
        "先用 room view 读取成员、职责、free.requests、session 与阶段，再按需读取原文。任务中的 purpose=discuss 表示讨论发言，discuss_host 表示主持任务，ask 表示直接提问；内部任务来源不是普通发言。",
        "用户管理和讨论开关使用房主凭据；本地成员使用本人的 --access-file，不借用其他身份。凭据私下交付，不公开 token。API 参与者遵循相同请求与执行约束，source=api；本地 CLI 使用 source=cli。",
        "runner 成员等待本机接入程序交付任务，用 execution view 核对本次执行和请求，再以 message post --as 本人 --kind chat --execution 本次编号 --access-file FILE 回答。执行失效后保留草稿，不能去掉编号改作普通发言；认领、续租与后续投递由接入程序处理。",
        "manual 本地成员首次用 member register 注册，会话 ID 由 CLI 自动取得；回答用 --request 请求编号，不编造执行编号。讨论不使用原生定时；原会话不能托管时由用户触发。网页成员只读，用户或当前主持人在核对真实回答后以本人身份、--author 原专家和 --request 关联请求代发。",
        "自由协作中的 host 可用 --to 点名成员，route 表示未点名的用户请求，handoff 表示派出任务已结束；链上 AI 派活受房间预算限制。普通成员的 --to 或正文 @ 只保存回应建议，不直接唤醒；不点名自己、不扩大授权。",
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

    def __init__(self, address, database, local_launch=False):
        self.database = Path(database)
        self.updates = threading.Condition()
        self.update_version = 0
        # Recent (version, room id or None) pairs, so a stream names the rooms that changed; None means the whole site.
        self.update_log = collections.deque(maxlen=UPDATE_LOG_SIZE)
        self.updates_closed = False
        if local_launch and address[0] != "127.0.0.1":
            raise ValueError("本机启动入口须绑定 127.0.0.1")
        self.local_launch = local_launch
        self.local_site = address[0] in ("127.0.0.1", "::1", "localhost")
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
        with self.updates:
            self.updates_closed = True
            self.updates.notify_all()
        super().server_close()


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
        quiet_renewal = (parts[3:4] == ["events"] and action == "renew") or (parts[3:4] in (["events"], ["executions"]) and action == "segments")
        if (self.command == "POST" and 200 <= status < 300 and parts[:2] in (["api", "rooms"], ["api", "folders"])
                and not quiet_renewal):
            self.server.notify_update(parts[2] if parts[:2] == ["api", "rooms"] and len(parts) > 3 else None)
        if content_type == "application/json":
            body = json.dumps(body, ensure_ascii=False)
        data = body.encode("utf-8") if isinstance(body, str) else body
        self.send_response(status)
        self.send_header("Content-Type", f"{content_type}; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Referrer-Policy", "no-referrer")
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
        parsed = urlsplit(self.path)
        params = {key: values[-1] for key, values in parse_qs(parsed.query).items()}
        parts = parsed.path.strip("/").split("/")
        text_mode = parts[0] == "r"
        try:
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
        with self.server.updates:
            version = self.server.update_version
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        try:
            self.wfile.write(b"retry: 3000\nevent: ready\ndata: {}\n\n")
            self.wfile.flush()
            while True:
                with self.server.updates:
                    self.server.updates.wait_for(
                        lambda: self.server.update_version != version or self.server.updates_closed,
                        timeout=UPDATE_HEARTBEAT_SECONDS)
                    if self.server.updates_closed:
                        return
                    changed = self.server.update_version != version
                    rooms = self.server.changed_rooms(version) if changed else None
                    version = self.server.update_version
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
        expected = settings.get("sites", {}).get(origin, {}).get("token_hash")
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
        if method == "OPTIONS" and route in (["settings"], ["launch"], ["room-models"], ["room-member"], ["room-member-access"], ["room-member-allow"], ["room-member-adapter"], ["room-profiles"], ["room-restore"], ["room-fork"], ["models"], ["api-key"], ["api-check"],
                                             ["scheduler-check"], ["pick-directory"], ["projects"], ["presets"], ["machine-link"], ["admin-account"]):
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
        elif route in (["room-member"], ["room-member-access"], ["room-member-allow"], ["room-member-adapter"]) and method == "POST":
            command = route[0]
        elif route in (["room-profiles"], ["room-restore"], ["room-fork"]) and method == "POST":
            command = route[0]
        elif route == ["pick-directory"] and method == "POST":
            command = "pick-directory"
        elif route == ["projects"] and method == "POST":
            command = "projects"
        elif route == ["presets"] and method == "POST":
            command = "presets"
        elif route == ["machine-link"] and method == "POST":
            command = "machine-link"
        elif route == ["admin-account"] and method == "POST":
            command = "admin-account"
        else:
            raise LookupError("本机入口不存在")
        payload = None
        if method == "POST":
            if self.headers.get_content_type() != "application/json":
                raise ValueError("本机操作须使用 application/json")
            payload = self.read_payload()
            if command in ("start", "room-config", "room-models", "room-member", "room-member-access", "room-member-allow", "room-member-adapter", "room-profiles", "room-restore", "room-fork"):
                payload.pop("access_file", None)
                payload.update(site=site, entry="web")
            if command == "machine-link":
                payload = {"site": site}
            if command == "admin-account":
                payload = {"site": site, "username": payload.get("username"), "password": payload.get("password")}
        if command == "room-config" and "participants" in payload:
            return self.save_local_room_configuration(command, payload)
        return self.run_local_command(command, payload)

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

    def run_local_command(self, command, payload, configuration_locked=False):
        """Run the fixed local Node entrypoint after the same-origin request checks."""
        arguments = ["node", str(ROOT / "runner" / "discussion_launch.mjs"), command]
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
        """The administrator session token supplied by the browser."""
        return self.headers.get("X-Discussion-Admin", "")

    def admin_session(self, connection):
        """Whether the request is from the administrator: any visitor of a loopback-only site, else a valid session."""
        return self.server.local_site or session_valid(connection, self.admin_token())

    def admin_as_owner(self, connection, room_id):
        """Let a logged-in administrator without this room's credential write as its owner; local visitors still need it."""
        if self.headers.get("X-Discussion-Token") or not session_valid(connection, self.admin_token()):
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
        if len(parts) != 3 or method != "POST":
            raise LookupError("地址不存在")
        payload = self.read_payload()
        now = int(time.time())
        if self.server.local_site and parts[2] != "profile":
            raise ValueError("本地站点无需管理员账号")
        actions = {"register": lambda: register_admin(connection, payload, self.server.admin_setup_key, now),
                   "login": lambda: login_admin(connection, payload, now),
                   "logout": lambda: logout_admin(connection, token),
                   "profile": lambda: update_profile(connection, token, payload, self.server.local_site)}
        if parts[2] not in actions:
            raise LookupError("地址不存在")
        result = actions[parts[2]]()
        connection.commit()
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
                return self.respond({**list_rooms(connection, params), "participants": PARTICIPANTS})
            room = create_room(connection, self.read_payload(), self.headers.get("X-Discussion-Token", ""))
            connection.commit()
            return self.respond(room, 200 if room["duplicate"] else 201)
        if parts == ["api", "rooms", "import"] and method == "POST":
            result = import_room(connection, self.read_payload(MAX_IMPORT_BYTES), self.headers.get("X-Discussion-Token", ""), int(time.time()))
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
                    hidden_task = execution.get("source") == "discussion" or (
                        isinstance(execution.get("task_id"), int) and execution["task_id"] > boundary)
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
        if (parts[3:4] in (["topic"], ["turns"])
                and (room_mode(connection, room_id) == "free" or current_session(connection, room_id, active_only=True))):
            return self.handle_host_api(connection, parts, params, method)
        if len(parts) == 6 and parts[3] == "messages" and parts[5] == "retract" and method == "POST":
            result = retract_message(connection, room_id, int(parts[4]), token)
            connection.commit()
            return self.respond(result)
        if parts[3:] == ["rewind"]:
            if method == "GET":
                require_owner(connection, room_id, token)
                return self.respond(rewind_plan(connection, room_id, int(params.get("message_id", 0))))
            result = rewind_room(connection, room_id, token, self.read_payload())
            connection.commit()
            return self.respond(result)
        free = room_mode(connection, room_id) == "free"
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
        # A discussion keeps the local service's inbox and per-member executions for the user's direct questions.
        if parts[3:4] in (["inbox"], ["executions"]) or (free and parts[3:4] in (["members"], ["suggestions"], ["recommendations"])):
            return self.handle_free_api(connection, parts, method)
        if parts[3:4] == ["members"] and method == "POST" and len(parts) in (4, 5):
            if len(parts) == 4:
                # Membership and its queued opening are committed together; the current plan stays in order.
                add_discussion_member(connection, room_id, token, self.read_payload(), utc_now())
            else:
                discussion_member_action(connection, room_id, int(parts[4]), token, self.read_payload())
            result = require_room(connection, room_id)
            connection.commit()
            return self.respond(result)
        if parts[3:4] == ["attachments"]:
            return self.handle_attachments(connection, parts, params, method)
        if parts[3:4] in (["runtime"], ["events"], ["scheduler-decisions"], ["scheduler-routing"]):
            if current_session(connection, room_id, active_only=True) and parts[3:4] in (["runtime"], ["events"]):
                raise ValueError("新讨论会话使用自由房间的执行接口；旧 runtime/events 接口只读历史")
            legacy_execution_api = parts[3:4] in (["runtime"], ["events"])
            payload = self.read_payload() if method == "POST" and legacy_execution_api else {}
            event_view = parts[3:4] == ["events"] and payload.get("action") == "view"
            if method == "POST" and legacy_execution_api and not event_view:
                if has_session_request_model(connection, room_id):
                    raise FileExistsError("该房间已使用讨论会话请求接口；旧讨论运行接口仅保留历史读取")
                raise ValueError("旧讨论运行接口仅保留历史读取")
            if (free and method == "POST" and parts[3:4] not in (["scheduler-decisions"], ["scheduler-routing"])
                    and not event_view):
                raise ValueError("自由房间不使用讨论运行控制")
            return self.handle_runtime_api(connection, parts, params, method)
        free_actor = None
        if method == "POST" and len(parts) == 4 and (parts[3] in DIRECTORY_OPERATIONS
                                                      or parts[3] in ADMIN_OPERATIONS and self.admin_session(connection)):
            pass
        elif method == "POST" and parts[3:] == ["state"] and free:
            pass
        elif method == "POST" and parts[3:] == ["limits"] and free and current_session(connection, room_id, active_only=True):
            pass
        elif method == "POST" and free:
            free_actor = authorize_free_write(connection, room_id, token, parts[3] if len(parts) > 3 else "", self.read_payload())
        elif method == "POST" and parts[3:] == ["messages"] and answers_direct_question(self.read_payload()):
            free_actor = authorize_free_write(connection, room_id, token, "messages", self.read_payload())
        elif method == "POST":
            authorize_write(connection, room_id, token, parts[3] if len(parts) > 3 else "", self.read_payload())
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
            room = require_room(connection, room_id)
            request_conclusion = session_conclusion_view(connection, room_id)
            return self.respond(request_conclusion or conclusion_view(connection, room))
        if parts[3:] == ["limits"]:
            if method == "GET":
                active_session = current_session(connection, room_id, active_only=True)
                if active_session:
                    view = session_room(connection, room_id)["session"]
                    if view:
                        return self.respond({**view["limits"], "revision": view["revision"]})
                return self.respond(require_room(connection, room_id)["limits"])
            payload = self.read_payload()
            if current_session(connection, room_id, active_only=True):
                if payload.get("action") == "check":
                    actor = payload.get("actor", "用户")
                    if actor == "用户":
                        require_owner(connection, room_id, token)
                    elif require_member(connection, room_id, token, actor)["role"] != "host":
                        raise PermissionError("只有房主或当前 AI 主持人可以检查讨论上限")
                    enforce_session_limits(connection, room_id)
                    result = session_room(connection, room_id)
                elif payload.get("action") == "done":
                    actor = payload.get("actor")
                    if not actor or require_member(connection, room_id, token, actor)["role"] != "host":
                        raise PermissionError("主持人收束讨论须使用当前 AI 主持人的成员凭据")
                    result = conclude_session_by_host(connection, room_id, payload)
                elif payload.get("action") == "reopen":
                    raise ValueError("新讨论会话请通过 discussion 接口重新开启")
                else:
                    result = update_session_limits(connection, room_id, token, payload)
            else:
                result = check_limits(connection, room_id, payload)
            connection.commit()
            return self.respond(result)
        if parts[3:4] in (["topic"], ["turns"]):
            return self.handle_host_api(connection, parts, params, method)
        if parts[3:] == ["messages"]:
            if method == "GET":
                return self.respond(query_messages(connection, room_id, params, token))
            payload = self.read_payload()
            result = append_message(connection, room_id, payload, self.headers.get("X-Discussion-Token", ""), free_actor)
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
            if room_mode(connection, room_id) == "free":
                actor = authorize_free_write(connection, room_id, token, "attachments", {"author": metadata["actor"]})
                if (actor == "用户") != (metadata["actor"] == "用户"):
                    raise PermissionError("附件上传者须与凭据身份一致")
            else:
                authorize_write(connection, room_id, token, "attachments", metadata)
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

    def handle_runtime_api(self, connection, parts, params, method):
        """Expose explicit run controls and durable, capability-scoped executions."""
        room_id = parts[2]
        require_room(connection, room_id)
        token = self.headers.get("X-Discussion-Token", "")
        if parts[3:] == ["runtime"]:
            if method != "GET":
                raise LookupError("地址不存在")
            result = runtime_view(connection, room_id)
        elif parts[3:] == ["events"] and method == "GET":
            result = list_events(connection, room_id, token, params.get("after", 0))
        elif len(parts) == 5 and parts[3] == "events" and method == "POST":
            result = event_view(connection, room_id, int(parts[4]), token, self.read_payload())
        elif parts[3:] == ["scheduler-decisions"] and method == "POST":
            result = record_scheduler_decision(connection, room_id, token, self.read_payload(), owner=room_mode(connection, room_id) == "free")
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
        else:
            raise LookupError("地址不存在")
        connection.commit()
        return self.respond(result)

    def handle_host_api(self, connection, parts, params, method):
        """Route topic maintenance and sequential speaking assignments."""
        room_id = parts[2]
        status = 200
        session = current_session(connection, room_id)
        if session and parts[3:4] == ["turns"]:
            return self.handle_session_turn_api(connection, room_id, parts, params, method)
        if parts[3:4] == ["turns"] and method == "POST":
            raise ValueError("旧讨论安排仅供读取；请先开启新的讨论会话")
        if parts[3:] == ["topic"] and method == "POST":
            payload = self.read_payload()
            actor = payload.get("actor", "用户")
            token = self.headers.get("X-Discussion-Token", "")
            if actor == "用户":
                require_owner(connection, room_id, token)
            elif require_member(connection, room_id, token, actor)["role"] != "host":
                raise PermissionError("只有房主或当前 AI 主持人可以修改话题资料")
            result = update_topic(connection, room_id, payload)
        elif parts[3:] == ["turns"]:
            if method == "GET":
                return self.respond(query_turns(connection, room_id, params))
            result = create_turn(connection, room_id, self.read_payload())
            status = 200 if result["duplicate"] else 201
        elif parts[3:] == ["turns", "roster"] and method == "GET":
            return self.respond(roster_view(require_room(connection, room_id)))
        elif parts[3:] == ["turns", "continue"] and method == "POST":
            result = continue_turns(connection, room_id, self.read_payload())
        elif len(parts) == 5 and parts[3] == "turns":
            result = get_turn(connection, room_id, parts[4]) if method == "GET" else update_turn(connection, room_id, parts[4], self.read_payload())
        else:
            raise LookupError("地址不存在")
        connection.commit()
        return self.respond(result, status)

    def handle_session_turn_api(self, connection, room_id, parts, params, method):
        """Read and write session plans through the legacy turns URL family."""
        if parts[3:] == ["turns"]:
            if method == "GET":
                return self.respond(query_session_requests(connection, room_id, params))
            payload = self.read_payload()
            host = require_member(connection, room_id, self.headers.get("X-Discussion-Token", ""), payload.get("actor"))
            if host["role"] != "host":
                raise PermissionError("只有当前 AI 主持人可以安排讨论发言")
            result = create_plan(connection, room_id, payload, require_room(connection, room_id))
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
            result = ask_interjection(connection, room_id, payload, require_room(connection, room_id))
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
            if current_session(connection, room_id) and params.get("legacy") != "1":
                result = query_session_requests(connection, room_id, params)
            else:
                result = query_turns(connection, room_id, params)
            room = require_room(connection, room_id)
            body = f"第 {result['page']} / {result['pages']} 页，共 {result['total']} 项。\n\n" + "\n\n".join(turn_text(turn, room) for turn in result["turns"])
        elif len(parts) == 4 and parts[2] == "turns":
            if current_session(connection, room_id) and params.get("legacy") != "1":
                turn = get_session_request(connection, room_id, parts[3])
            else:
                turn = get_turn(connection, room_id, parts[3])
            body = turn_text(turn, require_room(connection, room_id))
        elif parts[2:] in (["messages"], ["search"]):
            result = query_messages(connection, room_id, params, token)
            items = [message_text(message) for message in result["messages"]]
            next_page = f"第 {result['page']} / {result['pages']} 页，共 {result['total']} 条。翻页：保留查询条件，修改 page 参数。"
            body = next_page + "\n\n" + "\n\n---\n\n".join(items or ["没有匹配的消息。"])
        elif len(parts) == 4 and parts[2] == "messages":
            body = message_text(get_message(connection, room_id, int(parts[3]), params, token))
        elif parts[2:] == ["publish"]:
            return self.respond("URL 发布入口已停用。在线 AI 只读；本地 CLI AI 请使用 POST 留言接口。", 410, "text/plain")
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
            connection.execute("DELETE FROM admin_sessions")
            connection.execute("DELETE FROM site_admin")
        logging.info("管理员账号已清除；再次打开网站时可用安装令牌重新注册")
        return
    server = DiscussionServer((args.host, args.port), args.database, local_launch=args.local_launch)
    logging.info("AI CoDiscuss ready at http://%s:%s", args.host, args.port)
    with closing(connect_db(args.database)) as connection:
        if not server.local_site and connection.execute("SELECT 1 FROM site_admin").fetchone() is None:
            logging.info("尚未注册管理员账号；注册所需安装令牌：%s",
                         "见环境变量 DISCUSS_ADMIN_SETUP_KEY" if os.getenv("DISCUSS_ADMIN_SETUP_KEY") else server.admin_setup_key)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logging.info("Server stopped")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()

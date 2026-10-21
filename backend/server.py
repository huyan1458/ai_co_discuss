"""AI CoDiscuss 的零依赖 HTTP / SQLite 概念验证服务。"""

import argparse
import hashlib
import hmac
import json
import logging
import os
import re
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

from .free_room import (add_member, after_free_message, authorize_free_write, check_answer, check_proxy, execution_action, free_view,
                        inbox, interrupt_member, member_action, member_values, migrate_free_tables, proxy_member, reserve_execution,
                        discussion_members, room_mode, save_room_access, sync_discussion_members, view_execution)
from .free_room import convert_suggestion, message_suggestions, save_suggestions
from .identity import MAX_ROOM_AGENTS, PARTICIPANTS, is_ai, is_participant
from .runtime import (authorize_write, begin_write, configure_runtime, event_action,
                     LIMIT_DEFAULTS, LIMITS_SQL, limit_values, limits_view, require_within_limits,
                     list_events, require_control, runtime_view, token_hash)

ROOT = Path(__file__).resolve().parent.parent
WEB_ROOT = ROOT / "web"
DEFAULT_PORT = 8765
UPDATE_HEARTBEAT_SECONDS = 15
MAX_BODY_BYTES = 512 * 1024
MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
MAX_MESSAGE_ATTACHMENTS = 10
MAX_FILENAME_LENGTH = 255
LOCAL_LAUNCH_TIMEOUT = 60
# Ordering and filing a channel only rearrange the shared directory, like folder edits, so they need no room credential.
DIRECTORY_OPERATIONS = ("move", "folder")
DIRECTORY_PICKER_TIMEOUT = 600  # the folder dialog waits for the person at the computer
MAX_TEXT_LENGTH = 32000
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
          "/icons/LICENSE.txt": ("icons/LICENSE.txt", "text/plain")}
ASSETS.update({f"/icons/{name}.svg": (f"icons/{name}.svg", "image/svg+xml")
               for name in ("openai", "claude", "gemini", "deepseek", "qwen", "user")})
ASSETS.update({"/pdfjs/" + file.relative_to(WEB_ROOT / "pdfjs").as_posix():
               (file.relative_to(WEB_ROOT).as_posix(),
                {".mjs": "text/javascript", ".js": "text/javascript", ".wasm": "application/wasm"}.get(file.suffix, "application/octet-stream"))
               for file in (WEB_ROOT / "pdfjs").rglob("*") if file.is_file()})
SCHEMA = (Path(__file__).resolve().parent / "schema.sql").read_text(encoding="utf-8")
PHASES = {"preparing": "准备中", "initial": "独立观点", "discussing": "深入讨论",
          "reviewing": "结论复核", "paused": "已暂停", "concluded": "已收束"}
TURN_STATUSES = {"pending": "待处理", "notified": "已通知，待回答", "answered": "已回答", "cancelled": "已取消",
                 "queued": "排队中", "skipped": "未开始即取消"}
MAX_TOPIC_DETAIL = 4000
MAX_QUESTION_LENGTH = 1000
MAX_PLAN_TURNS = 10
ROOM_BACKUP_QUERIES = {
    "rooms": "SELECT * FROM rooms WHERE id=?",
    **{table: f"SELECT * FROM {table} WHERE room_id=?" for table in (
        "room_directory", "room_folder_assignments", "room_creations", "room_briefs", "room_user_requests",
        "topic_settings", "room_floor", "discussion_limits")},
    "topic_folders": "SELECT * FROM topic_folders WHERE id IN (SELECT folder_id FROM room_folder_assignments WHERE room_id=?)",
    "messages": "SELECT * FROM messages WHERE room_id=? ORDER BY id",
    "attachments": "SELECT * FROM attachments WHERE room_id=? AND message_id IS NOT NULL ORDER BY message_id,position",
    "discussion_turns": "SELECT * FROM discussion_turns WHERE room_id=? ORDER BY id",
    **{table: f"SELECT * FROM {table} WHERE message_id IN (SELECT id FROM messages WHERE room_id=?) ORDER BY message_id"
       for table in ("message_details", "message_summaries", "message_timings")},
}
ROOM_BACKUP_QUERIES["room_creations"] = "SELECT submission_id,room_id FROM room_creations WHERE room_id=?"
# Shared membership plus free-room requests; credential hashes are never exported.
FREE_BACKUP_QUERIES = {
    "room_modes": "SELECT room_id,mode FROM room_modes WHERE room_id=?",
    "room_members": "SELECT id,room_id,name,adapter,role,status,read_until,created_at FROM room_members WHERE room_id=? ORDER BY id",
    "member_requests": "SELECT * FROM member_requests WHERE room_id=? ORDER BY id",
    "member_suggestions": "SELECT s.* FROM member_suggestions s JOIN messages m ON m.id=s.message_id WHERE m.room_id=? ORDER BY s.message_id,s.member_id",
}
MESSAGE_QUERY = """SELECT messages.*, COALESCE(details.kind,'opinion') AS kind,
COALESCE(details.submitted_by, CASE WHEN messages.source IN ('cli','api','url','user')
THEN messages.author ELSE '用户' END) AS submitted_by, details.turn_id,
COALESCE(summaries.text,'') AS summary, COALESCE(summaries.author,'') AS summary_by, timing.elapsed_seconds
FROM messages LEFT JOIN message_details AS details ON details.message_id=messages.id
LEFT JOIN message_summaries AS summaries ON summaries.message_id=messages.id
LEFT JOIN message_timings AS timing ON timing.message_id=messages.id"""


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
    return {"format": "ai-codiscuss-room-backup", "version": 1,
            "exported_at": utc_now(), "tables": tables}


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
    connection.execute("INSERT INTO room_floor (room_id,holder,next_speaker) VALUES ('welcome','用户','用户')")
    for index, (author, text, reply_to) in enumerate(samples):
        connection.execute("UPDATE room_floor SET holder=? WHERE room_id='welcome'", (author,))
        created_at = (base_time + timedelta(minutes=index * 3)).isoformat(timespec="seconds")
        connection.execute("INSERT INTO messages (room_id,author,text,reply_to,source,submission_id,created_at) VALUES (?,?,?,?,?,?,?)",
                           ("welcome", author, text, reply_to, "demo", f"demo-{index}", created_at))
    summary = "已达成共识\n• 完整历史只追加，支持按编号查阅和关键词检索。〔#2、#3〕\n• 本地 CLI AI 读写记录；在线 AI 只读，观点由用户代发。〔#4、#5〕\n\n待验证\n• 在线 AI 是否能直接读取和检索原文。〔#4〕\n• 复制材料与代发流程是否清楚。〔#5、#6〕"
    connection.execute("UPDATE rooms SET state_text=?,state_until=6 WHERE id='welcome'", (summary,))
    connection.execute("UPDATE room_floor SET holder='用户' WHERE room_id='welcome'")


def init_database(database, seed=True):
    """Create durable storage; seed only a brand-new database when requested."""
    database = Path(database)
    is_new = not database.exists()
    database.parent.mkdir(parents=True, exist_ok=True)
    with closing(connect_db(database)) as connection, connection:
        connection.execute("PRAGMA journal_mode = WAL")
        connection.executescript(SCHEMA)
        migrate_free_tables(connection)
        if seed and is_new:
            seed_demo(connection)


def require_room(connection, room_id):
    """Return a room and its current message count, or raise a lookup error."""
    row = connection.execute("SELECT rooms.*, COUNT(messages.id) AS message_count, COALESCE(MAX(messages.id),0) AS latest_id FROM rooms LEFT JOIN messages ON rooms.id=messages.room_id WHERE rooms.id=? GROUP BY rooms.id", (room_id,)).fetchone()
    if row is None:
        raise LookupError("房间不存在")
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
    room["latest_receipts"] = latest_receipts(connection, room_id)
    brief = connection.execute("SELECT text,until,updated_at FROM room_briefs WHERE room_id=?", (room_id,)).fetchone()
    room["host_brief"] = dict(brief) if brief else None
    room["rounds"] = discussion_rounds(connection, room_id, room["experts"])
    room["completed_rounds"] = sum(item["completed"] for item in room["rounds"])
    room["floor"] = dict(connection.execute("SELECT holder,next_speaker,revision FROM room_floor WHERE room_id=?", (room_id,)).fetchone())
    room["runtime"] = runtime_view(connection, room_id)
    room["limits"] = limits_view(connection.execute(LIMITS_SQL, (room_id,)).fetchone(), room)
    room["mode"] = room_mode(connection, room_id)
    room["members"] = [dict(row) for row in connection.execute(
        "SELECT id,name,adapter,role,status,access,session_mode FROM room_members WHERE room_id=? AND status<>'removed' ORDER BY id", (room_id,))]
    parent = connection.execute("""SELECT rooms.id,rooms.title FROM room_links JOIN rooms ON rooms.id=room_links.parent_id
        WHERE room_links.room_id=?""", (room_id,)).fetchone()
    room["parent_room"] = dict(parent) if parent else None
    if room["mode"] == "free":
        room["linked_rooms"] = [dict(row) for row in connection.execute("""SELECT rooms.id,rooms.title,COALESCE(topic_settings.phase,'preparing') AS phase
            FROM room_links JOIN rooms ON rooms.id=room_links.room_id LEFT JOIN topic_settings ON topic_settings.room_id=rooms.id
            WHERE room_links.parent_id=? ORDER BY room_links.created_at""", (room_id,))]
        # Free rooms have no host hand-off: user messages go straight to the named members.
        room["held_since"] = 0
        room["free"] = free_view(connection, room_id)
    return room


def update_floor(connection, room_id, payload):
    """Claim or return the nominated speaker's floor using a checked revision."""
    begin_write(connection)
    room = require_room(connection, room_id)
    actor = payload.get("actor")
    speaker = payload.get("speaker", actor)
    action = payload.get("action")
    revision = payload.get("revision")
    proxy = actor == room["host"] and room["experts"].get(speaker) == "online"
    if not is_participant(speaker) or (actor not in (speaker, "用户") and not proxy):
        raise ValueError("请以本人、主持人或用户身份操作被点名者的发言权")
    if action not in ("take", "return") or type(revision) is not int or revision < 0:
        raise ValueError("请提供 take/return 和最新的发言权 revision")
    floor = room["floor"]
    if revision != floor["revision"]:
        raise FileExistsError("发言权已变化，请重新读取")
    if action == "take":
        if floor["holder"] is not None or floor["next_speaker"] != speaker:
            raise FileExistsError("仅被点名的下一位可在无人持有时领取发言权")
        connection.execute("UPDATE room_floor SET holder=?,revision=revision+1 WHERE room_id=?", (speaker, room_id))
    else:
        if floor["holder"] != speaker:
            raise FileExistsError("只能归还自己持有的发言权")
        connection.execute("UPDATE room_floor SET holder=NULL,next_speaker=?,revision=revision+1 WHERE room_id=?", (room["host"], room_id))
    return require_room(connection, room_id)["floor"]


def require_floor(room, speaker):
    """Reject a declared speaker who does not currently hold the floor."""
    if room["floor"]["holder"] != speaker:
        raise FileExistsError("请先领取本人发言权；他人持有或尚未被点名时不能发言或安排")


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


def latest_receipts(connection, room_id):
    """Return each author's latest receipt reference without loading its body."""
    rows = connection.execute("""SELECT messages.id,messages.author,messages.created_at,details.submitted_by
        FROM messages JOIN message_details AS details ON details.message_id=messages.id
        WHERE messages.id IN (SELECT MAX(messages.id) FROM messages
            JOIN message_details AS details ON details.message_id=messages.id
            WHERE room_id=? AND details.kind='receipt' GROUP BY author)
        ORDER BY messages.id""", (room_id,))
    return [dict(row) for row in rows]


def turn_status_label(turn, room):
    """Describe pending work using the expert's configured participation mode."""
    if turn["status"] == "pending":
        mode = room["experts"].get(turn["expert"])
        return {"cli": "待处理（本地 CLI）", "online": "待联系（在线专家）"}.get(mode, "待处理")
    return TURN_STATUSES[turn["status"]]


def receipt_references_text(room):
    """Link to current receipt reports independently of an older host summary."""
    lines = ["最新运行回执（每位参与者最近一条，运行结果以原文为准）："]
    for receipt in room["latest_receipts"]:
        suffix = " · 晚于摘要" if receipt["id"] > room["state_until"] else ""
        lines.append(f"{receipt['author']} · {receipt['created_at']}{suffix}：/r/{room['id']}/messages/{receipt['id']}")
    return "\n".join(lines) if room["latest_receipts"] else "尚无运行回执。"


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
        result["reset_closing"] = not current or any(result["limits"][key] != current["limits"][key]
                                                    for key in LIMIT_DEFAULTS if key != "execution_minutes")
    return result


def save_topic_settings(connection, room_id, settings):
    """Persist topic settings without modifying any original messages."""
    if settings.get("save_limits"):
        connection.execute("""UPDATE discussion_limits SET max_rounds=?,max_minutes=?,execution_minutes=?,on_limit=?,summary_minutes=?,
            closing_at=CASE WHEN ? THEN 0 ELSE closing_at END,stop_reason=CASE WHEN ? THEN '' ELSE stop_reason END,
            revision=revision+1 WHERE room_id=?""",
                           [*(settings["limits"][key] for key in LIMIT_DEFAULTS), settings["reset_closing"], settings["reset_closing"], room_id])
    values = [settings[key] for key in ("host", "background", "boundaries")]
    values.extend([json.dumps(settings["experts"], ensure_ascii=False), settings["phase"], settings["focus"]])
    connection.execute("INSERT INTO topic_settings (room_id,host,background,boundaries,experts,phase,focus) VALUES (?,?,?,?,?,?,?) ON CONFLICT(room_id) DO UPDATE SET host=excluded.host,background=excluded.background,boundaries=excluded.boundaries,experts=excluded.experts,phase=excluded.phase,focus=excluded.focus", [room_id, *values])
    connection.execute("INSERT INTO room_user_requests (room_id,text) VALUES (?,?) ON CONFLICT(room_id) DO UPDATE SET text=excluded.text",
                       (room_id, settings.get("user_request", "")))


def require_host(room, payload):
    """Check the declared operator; this is a workflow rule, not authentication."""
    if payload.get("actor") not in (room["host"], "用户"):
        raise ValueError("请使用当前主持人或用户身份管理话题")


def update_topic(connection, room_id, payload):
    """Update topic direction and participants through a declared host action."""
    begin_write(connection)
    room = require_room(connection, room_id)
    require_host(room, payload)
    settings = topic_values(payload, room)
    if room["archived"] and settings["phase"] not in ("paused", "concluded"):
        raise ValueError("请先恢复已存档频道，再调整讨论阶段")
    turn = room["current_turn"]
    if turn and turn["status"] in ("pending", "notified"):
        if settings["phase"] == "concluded" or turn["expert"] not in settings["experts"]:
            raise ValueError("请先完成或取消当前发言安排")
    connection.execute("UPDATE rooms SET title=?,goal=? WHERE id=?", (settings["title"], settings["goal"], room_id))
    sync_discussion_members(connection, room_id, payload, settings)
    save_topic_settings(connection, room_id, settings)
    return require_room(connection, room_id)


def submission_value(value):
    """Validate a replay identifier for writes or exact result lookup."""
    identifier = str(value or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]{8,100}", identifier):
        raise ValueError("submission_id 必须是 8–100 位字母、数字、下划线或连字符")
    return identifier


def list_rooms(connection, params=None):
    """Return rooms, optionally locating a single persisted creation request."""
    params = params or {}
    identifier = submission_value(params["submission_id"]) if "submission_id" in params else None
    where = "WHERE EXISTS (SELECT 1 FROM room_creations WHERE room_id=rooms.id AND submission_id=?)" if identifier else ""
    rows = connection.execute(f"SELECT rooms.*,COUNT(messages.id) AS message_count,COALESCE(MAX(messages.id),0) AS latest_id FROM rooms LEFT JOIN messages ON rooms.id=messages.room_id {where} GROUP BY rooms.id ORDER BY rooms.created_at, rooms.id", (identifier,) if identifier else ())
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
    """Move, archive, restore or permanently delete one declared host's room."""
    begin_write(connection)
    room = require_room(connection, room_id)
    require_host(room, payload)
    if action == "move":
        rooms = [item["id"] for item in list_rooms(connection)["rooms"] if item["id"] != room_id]
        before = payload.get("before_id")
        if before is not None and before not in rooms:
            raise ValueError("目标频道不存在或与当前频道相同")
        rooms.insert(rooms.index(before) if before else len(rooms), room_id)
        connection.executemany("UPDATE room_directory SET position=? WHERE room_id=?", enumerate(rooms, 1))
    elif action == "folder":
        folder_id = payload.get("folder_id")
        if folder_id is not None and not isinstance(folder_id, str):
            raise ValueError("文件夹编号格式无效")
        if folder_id is not None and connection.execute("SELECT 1 FROM topic_folders WHERE id=?", (folder_id,)).fetchone() is None:
            raise ValueError("文件夹不存在")
        connection.execute("UPDATE room_folder_assignments SET folder_id=? WHERE room_id=?", (folder_id, room_id))
    elif action in ("archive", "restore"):
        if action == "archive" and room["phase"] != "concluded":
            save_topic_settings(connection, room_id, {**room, "phase": "paused"})
        connection.execute("UPDATE room_directory SET archived=? WHERE room_id=?", (int(action == "archive"), room_id))
    elif action == "delete":
        if payload.get("confirm_title") != room["title"]:
            raise ValueError("请输入完整频道名称确认删除")
        delete_room_records(connection, room_id)
        return {"deleted": True, "id": room_id}
    else:
        raise LookupError("地址不存在")
    return require_room(connection, room_id)


def delete_room_records(connection, room_id):
    """Remove a room's dependent records in the caller's transaction."""
    for table in ("member_requests", "member_executions", "room_members", "room_modes", "free_batches", "free_chains", "room_links"):
        connection.execute(f"DELETE FROM {table} WHERE room_id=?", (room_id,))
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
    if payload.get("mode", "brainstorm") not in ("free", "brainstorm"):
        raise ValueError("房间模式须为 free 或 brainstorm")
    free = payload.get("mode") == "free"
    members = member_values(payload.get("members")) if free else []
    if free:
        payload = {**payload, "phase": "discussing", "experts": {member["name"]: "online" if member["access"] == "online" else "cli" for member in members}}
    settings = topic_values(payload)
    if not free:
        members = discussion_members(payload, settings)
    automatic = payload.get("runtime_mode") == "automatic"
    if payload.get("runtime_mode", "manual") not in ("manual", "automatic") or not token_hash(control_token):
        raise ValueError("建房须提供有效的运行模式和房主控制凭据")
    if free and (automatic or not token_hash(control_token)):
        raise ValueError("自由房间须提供房间控制凭据，且不使用讨论运行模式")
    parent_id = payload.get("parent_room_id")
    if parent_id is not None and (free or not isinstance(parent_id, str) or room_mode(connection, parent_id) != "free"):
        raise ValueError("只有从自由协作房间发起的讨论房间可以关联来源房间")
    identifier = submission_value(payload["submission_id"]) if "submission_id" in payload else None
    folder_id = payload.get("folder_id")
    if folder_id is not None and not isinstance(folder_id, str):
        raise ValueError("文件夹编号必须是文本或 null")
    request_text = creation_request(settings) + (":automatic" if automatic else "")
    request_text += ":access:" + token_hash(control_token) + ":" + json.dumps(
        [[member["name"], member["adapter"], member["access"], member["session_mode"], token_hash(member["token"])] for member in members], ensure_ascii=False)
    if free:
        request_text += ":free"
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
    if parent_id is not None:
        connection.execute("INSERT INTO room_links (room_id,parent_id,created_at) VALUES (?,?,?)", (room_id, parent_id, utc_now()))
    if automatic:
        configure_runtime(connection, room_id, control_token, {"revision": 0, "mode": "automatic"})
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
    if kind not in ("opinion", "moderation", "receipt") or not is_participant(submitted_by):
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
    author, text, submission_id, reply_to = message_values(payload)
    room_id = room["id"]
    proxy = None
    if actor == "用户" and author != "用户":
        proxy = proxy_member(connection, room_id, author)
        if payload.get("submitted_by", "用户") != "用户":
            raise PermissionError("代发在线成员的回答须由用户提交")
    submitted_by = "用户" if proxy else author
    expected = {"author": author, "text": text, "reply_to": reply_to, "kind": "chat", "submitted_by": submitted_by,
                "turn_id": None, "source": "proxy" if proxy else ("user" if author == "用户" else "api" if payload.get("source") == "api" else "cli")}
    expected.update(message_summary(payload, expected))
    identifiers = attachment_ids(payload)
    previous = connection.execute(f"{MESSAGE_QUERY} WHERE room_id=? AND submission_id=?", (room_id, submission_id)).fetchone()
    if previous:
        previous = message_with_attachments(connection, previous)
        if (any(previous[key] != expected[key] for key in ("author", "text", "reply_to", "kind", "submitted_by", "summary", "summary_by"))
                or [item["id"] for item in previous["attachments"]] != identifiers):
            raise FileExistsError("这个提交编号已被另一条内容使用，请为新发言生成新编号")
        return {"message": previous, "duplicate": True}
    if room["archived"]:
        raise ValueError("频道已存档；恢复后才能继续协作")
    check_message_references(connection, room_id, expected)
    check_message_attachments(connection, room_id, submitted_by, identifiers)
    if proxy:
        check_proxy(connection, room_id, proxy, payload)
    elif actor != "用户":
        check_answer(connection, room_id, actor, payload)
    cursor = connection.execute("INSERT INTO messages (room_id,author,text,reply_to,source,submission_id,created_at) VALUES (?,?,?,?,?,?,?)",
                                (room_id, author, text, reply_to, expected["source"], submission_id, utc_now()))
    connection.execute("INSERT INTO message_details (message_id,kind,submitted_by,turn_id) VALUES (?,?,?,NULL)",
                       (cursor.lastrowid, "chat", submitted_by))
    connection.execute("INSERT INTO message_summaries (message_id,text,author) VALUES (?,?,?)",
                       (cursor.lastrowid, expected["summary"], expected["summary_by"]))
    for position, identifier in enumerate(identifiers):
        connection.execute("UPDATE attachments SET message_id=?,position=? WHERE id=?", (cursor.lastrowid, position, identifier))
    save_suggestions(connection, room_id, cursor.lastrowid, proxy or actor, payload)
    after_free_message(connection, room_id, cursor.lastrowid, proxy or actor, payload)
    return {"message": get_message(connection, room_id, cursor.lastrowid), "duplicate": False}


def append_message(connection, room_id, payload, token="", free_actor=None):
    """Atomically append an attributed message and complete its scheduled turn."""
    author, text, submission_id, reply_to = message_values(payload)
    begin_write(connection)
    room = require_room(connection, room_id)
    if room["mode"] == "free":
        return append_free_message(connection, room, payload, free_actor)
    details = message_details(room, {**payload, "author": author})
    expected = {"author": author, "text": text, "reply_to": reply_to, **details}
    expected.update(message_summary(payload, expected))
    identifiers = attachment_ids(payload)
    previous = connection.execute(f"{MESSAGE_QUERY} WHERE room_id=? AND submission_id=?", (room_id, submission_id)).fetchone()
    if previous:
        previous = message_with_attachments(connection, previous)
        if (any(previous[key] != expected[key] for key in ("author", "text", "reply_to", "kind", "submitted_by", "turn_id", "summary", "summary_by"))
                or [item["id"] for item in previous["attachments"]] != identifiers):
            raise FileExistsError("这个提交编号已被另一条内容使用，请为新发言生成新编号")
        return {"message": previous, "duplicate": True}
    if author != "用户" and details["kind"] == "opinion":
        require_within_limits(room)
    if room["phase"] in ("paused", "concluded") and details["kind"] == "opinion":
        raise ValueError("话题已暂停或收束；恢复阶段后才能提交新观点，运行回执请用 receipt")
    check_message_references(connection, room_id, expected)
    check_message_attachments(connection, room_id, details["submitted_by"], identifiers)
    if author != "用户":
        if details["kind"] == "opinion" and not details["turn_id"]:
            raise ValueError("专家观点必须关联当前有效的 turn_id")
        require_floor(room, author)
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
    if details["turn_id"]:
        connection.execute("UPDATE discussion_turns SET status='answered',answer_id=? WHERE id=?", (cursor.lastrowid, details["turn_id"]))
    return {"message": get_message(connection, room_id, cursor.lastrowid), "duplicate": False}


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
    if room["phase"] in ("paused", "concluded"):
        raise ValueError("话题已暂停或收束，请先调整阶段")
    if room["current_turn"] and room["current_turn"]["status"] in ("pending", "notified"):
        raise FileExistsError("请先完成或取消当前发言安排")
    require_floor(room, room["host"])
    ids = []
    for index, (expert, question, submission_id) in enumerate(plan):
        cursor = connection.execute(
            "INSERT INTO discussion_turns (room_id,expert,question,status,submission_id,created_at) VALUES (?,?,?,?,?,?)",
            (room_id, expert, question, "pending" if index == 0 else "queued", submission_id, utc_now()))
        ids.append(cursor.lastrowid)
    return {"turn": get_turn(connection, room_id, ids[0]),
            "queued": [get_turn(connection, room_id, turn_id) for turn_id in ids[1:]], "duplicate": False}


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
    require_floor(room, room["host"])
    turn_id = room["queued_turns"][0]["id"]
    connection.execute("UPDATE discussion_turns SET status='pending' WHERE id=? AND status='queued'", (turn_id,))
    return {"turn": get_turn(connection, room_id, turn_id), "queued": room["queued_turns"][1:]}

def check_limits(connection, room_id, payload):
    """Apply a reached boundary once; the host must author the actual summary."""
    begin_write(connection)
    room = require_room(connection, room_id)
    require_host(room, payload)
    limits = room["limits"]
    force = payload.get("force") is True
    if force and (room["phase"] in ("preparing", "paused", "concluded") or room["archived"]):
        raise ValueError("仅进行中的讨论可以提前收尾")
    if (not limits["reached"] and not force) or room["phase"] in ("paused", "concluded") or room["archived"]:
        return room
    reason = limits["reason"] or "user_stop"
    closing = (force or limits["on_limit"] == "summarize") and reason != "time_limit"
    if closing and limits["closing"]:
        return room
    connection.execute("UPDATE discussion_limits SET closing_at=?,stop_reason=?,revision=revision+1 WHERE room_id=?",
                       (int(time.time()) if closing else limits["closing_at"], reason, room_id))
    connection.execute("UPDATE discussion_turns SET status='cancelled' WHERE room_id=? AND status IN ('pending','notified')", (room_id,))
    connection.execute("UPDATE discussion_turns SET status='skipped' WHERE room_id=? AND status='queued'", (room_id,))
    connection.execute("UPDATE room_floor SET holder=NULL,next_speaker=?,revision=revision+1 WHERE room_id=?", (room["host"], room_id))
    if closing:
        summary_deadline = int(time.time()) + limits["summary_minutes"] * 60
        connection.execute("UPDATE discussion_runtime SET generation=generation+1,revision=revision+1,deadline=CASE WHEN deadline=0 THEN ? ELSE MIN(deadline,?) END WHERE room_id=? AND status='running'",
                           (summary_deadline, summary_deadline, room_id))
    else:
        connection.execute("UPDATE topic_settings SET phase='paused' WHERE room_id=?", (room_id,))
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
    if turn["status"] == status:
        return turn
    if status == "notified" and room["phase"] in ("paused", "concluded"):
        raise ValueError("话题已暂停或收束，不能继续通知")
    if turn["status"] not in ("pending", "notified"):
        raise FileExistsError("该发言安排已结束")
    if status == "cancelled" and payload.get("actor") != "用户":
        require_floor(room, room["host"])
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
    return " AND ".join(clauses), values


def query_messages(connection, room_id, params):
    """Read one bounded page; incremental cursors advance only through returned rows."""
    require_room(connection, room_id)
    page = max(1, int(params.get("page", 1)))
    where, values = message_filters(room_id, params)
    total = connection.execute(f"SELECT COUNT(*) FROM ({MESSAGE_QUERY} WHERE {where})", values).fetchone()[0]
    rows = connection.execute(f"{MESSAGE_QUERY} WHERE {where} ORDER BY messages.id LIMIT ? OFFSET ?", [*values, PAGE_SIZE + 1, (page - 1) * PAGE_SIZE]).fetchall()
    messages = [message_with_attachments(connection, row) for row in rows[:PAGE_SIZE]]
    result = {"messages": messages, "page": page, "total": total,
              "pages": max(1, (total + PAGE_SIZE - 1) // PAGE_SIZE)}
    if "after" in params:
        result.update(next_after=messages[-1]["id"] if messages else int(params["after"]), has_more=len(rows) > PAGE_SIZE)
    return result


def get_message(connection, room_id, message_id):
    """Read an exact message, constrained to the specified room."""
    row = connection.execute(f"{MESSAGE_QUERY} WHERE room_id=? AND messages.id=?", (room_id, message_id)).fetchone()
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
    connection.execute("UPDATE rooms SET state_text=?,state_until=? WHERE id=?", (text, until, room_id))
    if "brief" in payload:
        connection.execute("""INSERT INTO room_briefs (room_id,text,until,updated_at) VALUES (?,?,?,?)
            ON CONFLICT(room_id) DO UPDATE SET text=excluded.text,until=excluded.until,updated_at=excluded.updated_at""",
                           (room_id, brief, until, utc_now()))
    return require_room(connection, room_id)


def state_reading_text(room):
    """Read the host's brief explicitly without adding it to independent-entry overviews."""
    brief = room.get("host_brief")
    overview = f"主持简报（整理至 #{brief['until']}，{brief['updated_at']}）\n{brief['text']}" if brief and brief["text"] else "主持简报：尚未更新"
    return f"{overview}\n\n主持人维护的状态（整理至 #{room['state_until']}）\n\n{room['state_text'] or '尚未整理'}\n\n{receipt_references_text(room)}"


def message_text(message):
    """Render an original message with its provenance and reply reference."""
    reply = f" · 回复 #{message['reply_to']}" if message["reply_to"] else ""
    role = {"moderation": "主持发言", "receipt": "运行回执", "chat": "协作消息"}.get(message.get("kind"), "专家观点")
    summary = f"\n回答摘要（{message['summary_by']}）：\n{message['summary']}\n\n完整正文：\n" if message.get("summary") else "\n"
    attachments = "".join(f"\n附件：{item['file_name']}（{item['size']} 字节；ID: {item['id']}）\n{item['download_url']}"
                          for item in message.get("attachments", []))
    return f"#{message['id']} · {message['author']} · {message['created_at']}{reply}\n职责：{role}；来源：{message['source']}；提交者：{message.get('submitted_by', '用户')}；安排：{message.get('turn_id') or '无'}{summary}{message['text']}{attachments}"


def room_text(connection, room_id, params):
    """Expose only an overview; readers choose which supporting pages to open."""
    room = require_room(connection, room_id)
    base = f"/r/{room_id}"
    content = [f"# {room['title']}", f"目标：{room['goal']}",
               f"主持人：{room['host']}；阶段：{PHASES[room['phase']]}；当前焦点：{room['focus'] or '尚未填写'}",
               f"当前记录截止 #{room['latest_id']}；共 {room['message_count']} 条；已完成 {room['completed_rounds']} 轮讨论（所有参与专家各发言一次）。"]
    limits = room["limits"]
    content.append(f"讨论上限：{limits['max_rounds'] or '不限'} 轮；总时长 {limits['max_minutes'] or '不限'} 分钟；单次自动执行 {str(limits['execution_minutes']) + ' 分钟' if limits['execution_minutes'] else '不限时长'}；到限 {limits['on_limit']}；收束预留 {limits['summary_minutes']} 分钟（计入总时长）。到限：{limits['reached']}；收束中：{limits['closing']}。")
    if room["mode"] == "free":
        members = "；".join(f"{item['name']}（已读至 #{item['read_until']}，待投递 {item['pending']}）" for item in room["free"]["members"])
        content.append(f"自由协作房间：无发言权、安排与轮次。成员：{members or '无'}。用户的消息点名成员后生成请求；成员回答须带本次执行编号，执行结束、被打断或过期后的回答会被拒绝，不能改作普通发言。")
        return "\n\n".join(content)
    turn = room["current_turn"]
    floor = room["floor"]
    content.append(f"发言权：{floor['holder'] + ' 持有' if floor['holder'] else '待 ' + floor['next_speaker'] + ' 领取'}；版本 {floor['revision']}。用户本人可随时留言，AI 发言前须领取。")
    if room["phase"] == "initial":
        content.append("本阶段先独立形成详细观点：仅阅读目标、背景、边界和自己的已有讨论；暂不阅读他人观点或主持总结。提交后再交叉阅读。这是参与约定，不是权限隔离。")
    if room["archived"]:
        content.append("频道已存档，记录仍可查阅；先恢复频道，再由用户明确恢复讨论阶段。")
    if room["phase"] in ("paused", "concluded"):
        content.append("停止处理发言安排，取消本讨论自己的后台任务并核对实际状态；非必要不生成回执，正常停止无需回执。不要因旧通知恢复讨论。")
    if turn:
        content.extend([f"当前安排 #{turn['id']}：{turn['expert']} · {turn_status_label(turn, room)}", f"待回应问题：{turn['question']}", f"安排详情：{base}/turns/{turn['id']}"])
    if room["queued_turns"]:
        content.append("本轮排队：" + " → ".join(f"#{item['id']} {item['expert']}" for item in room["queued_turns"]))
    if room["held_since"]:
        content.append(f"用户自 #{room['held_since']} 起有待主持人处理的操作；当前回答完成后交给主持人，不自动接力。")
    content.extend(["## 按需展开", "请自主选择需要的材料，不必读取全部历史。",
                    f"背景、边界与参与专家：{base}/brief",
                    f"共识与分歧（整理至 #{room['state_until']}）：{base}/state"])
    if params.get("participant"):
        content.append(f"与 @{params['participant']} 相关的观点：{base}/search?mention={params['participant']}&page=1")
    content.extend(["", "## 读取与检索", f"完整历史（分页）：{base}/messages?page=1",
                    f"单条原文：{base}/messages/消息编号", f"检索：{base}/search?q=关键词&page=1",
                    f"按作者检索：{base}/search?author=Claude", f"发言安排历史：{base}/turns?page=1"])
    if params.get("mode") == "cli":
        content.extend(["", "## 本地 CLI AI · 可读可写",
                        f"POST /api/rooms/{room_id}/messages", "Content-Type: application/json",
                        'JSON 字段：author、text、submission_id（新 UUID）、source（填写 "cli"）；可选 reply_to、turn_id。',
                        f"完整写入与主持协议：{base}/protocol",
                        "重试沿用编号和正文；收到回执后按 message.id 重新读取核对。"])
    else:
        content.extend(["", "## 在线 AI · 只读参与",
                        "请读取议题、状态和相关原文，在你自己的聊天窗口输出观点：先给通常 1–3 句的回答摘要，再给完整正文，保留关键条件、不确定性及引用编号；需要留档时由用户代发。",
                        "不要操作网页表单、调用写入接口或生成发布链接，不要求获取发布回执。读取失败时如实报告，由用户提供复制的材料。"])
    content.append("参与方式按运行环境区分；主持人可以兼任专家；作者、职责与来源尚未认证。不调用模型服务 API。")
    return "\n\n".join(content)


def brief_text(room):
    """Render the detailed brief only when explicitly requested."""
    experts = "\n".join(f"- {name}：{'本地 CLI 读写' if mode == 'cli' else '在线只读'}" for name, mode in room["experts"].items())
    return f"# {room['title']} · 话题资料\n\n目标：{room['goal']}\n\n用户原文：\n{room['user_request'] or '未填写'}\n\n背景：\n{room['background'] or '未填写'}\n\n边界：\n{room['boundaries'] or '未填写'}\n\n主持人：{room['host']}（可兼任专家）\n\n参与专家：\n{experts}"


def turn_text(turn, room):
    """Render a speaking assignment without embedding discussion context."""
    room_id = room["id"]
    answer = f"\n回答原文：/r/{room_id}/messages/{turn['answer_id']}" if turn["answer_id"] else ""
    return f"安排 #{turn['id']} · {turn['expert']} · {turn_status_label(turn, room)}\n待回应问题：{turn['question']}\n话题入口：/r/{room_id}?participant={turn['expert']}\n回答关联 turn_id：{turn['id']}{answer}\n回答附简短摘要及完整正文，保留关键条件和不确定性。\n已接入的本地 CLI 专家可自行检查安排；在线专家需联系。复制通知不代表已送达；仅实际通知后由主持人确认。"


def protocol_text(room):
    """Describe explicit CLI and host operations separately from topic content."""
    base = f"/api/rooms/{room['id']}"
    if room["mode"] == "free":
        return "\n\n".join([
            "# 自由协作参与协议", f"当前主持人：{room['host']}。没有讨论发言权、正式安排或轮次。",
            "先用 room view 读取成员、职责和 free.requests，再按需读取 message list / message view 原文；通知只给对象、问题和入口。",
            "用户写入和成员管理须房主控制凭据；本地成员写入须本人的 --access-file，不能借用用户或其他成员身份。凭据文件私下交付，不公开 token。",
            "runner 成员等待本机接入程序交付有效任务，不另建定时。用 message post --as 本人 --kind chat --execution 本次编号 --access-file FILE 回答；不执行 execution enter。执行失效后保留草稿，不能去掉编号改作普通发言。",
            "manual 成员可由人工或软件原生定时触发，用本人成员文件自行提交。回答带 --request 请求编号（可重复）关闭自己的请求，不带则为普通发言。不得编造 execution 编号。",
            "online 成员只读，在原聊天回答，由用户以房主凭据代发原文；作者仍是在线成员、提交者为用户，不能用成员凭证自行写入。复制说明不表示已送达或接入。",
            "获授 host 职责的本地成员可在回答中用 --to 点名其他成员，不能点名自己或扩大权限；route 表示分配任务，handoff 表示派出的成员已结束。链上 AI 请求受房间预算限制，到限等待用户。",
            "普通成员的 --to 或正文 @ 只保存为回应建议，不唤醒；代码与引用中的正文 @ 不算。房主在网页转为请求后建立关联原消息的新用户任务链，重复点击不重复派发。",
            f"附件使用 attachment upload/download；上传使用本人成员文件，消息带 attachment_ids。原始接口为 {base}/attachments 与 {base}/messages，自动成员在回答完成前上传。",
            "每次新内容用新 submission_id，同次重试沿用编号、原文、凭据和执行/请求关联；失败先核对服务端结果，不换身份或编号绕过。用户打断、成员离开或移除后停止本次工作。",
        ])
    return "\n\n".join([
        "# 本地 CLI 读写与主持协议", f"当前主持人：{room['host']}。以下为留言板接口，不是模型服务 API。",
        "API 参与者由本机 runner 使用相同房间授权和执行约束提交，消息 source=api；CLI 仍使用 source=cli。兼容字段 experts 中的 cli 表示可自行提交，实际接入方式见成员 adapter。",
        "写入使用 POST，通常为 Content-Type: application/json；附件上传使用 application/octet-stream 原始字节。主持操作填写 actor 为当前主持人或用户；这些是声明身份，不是认证凭据。",
        f"附件：POST {base}/attachments?actor=身份&file_name=文件名&submission_id=新编号，原文件最多 20 MiB；GET 同路径默认列已发送附件，加 submission_id 精确核对上传。GET {base}/attachments/ID 读元数据，/ID/content 下载原文件。消息可带 attachment_ids（最多 10 个有序编号）；只关联同房间、同提交者的未使用附件，可只有附件无正文。自动任务须在回答完成前上传；消息查询包含附件，按需下载后由当前软件读取，不自动解析。",
        "讨论上限：room.limits 返回轮次、总时长、单次执行、到限方式、收束预留和实际进度。准备/暂停时通过 topic 的 limits 对象修改；0 表示不预设轮次/总时长/单次执行时限。POST /api/rooms/ROOM/limits（actor）或 room limits ROOM --check 检查到限处理；附 force:true 可在进行中提前进入收束，由主持人在收束预留时间内总结。到限停止新专家安排与观点；总结由真实主持人完成，预留计入总时长；暂停期间不计时也不消耗总时长。",
        "运行方式：room.runtime 显示 manual/automatic、状态及真实执行回执。所有房间写入须带 X-Discussion-Token，CLI 用 --access-file 读取私有文件。用户及运行控制使用房主凭据，手动本地成员使用自己的成员凭证，不能相互冒充；在线成员只读，由房主或讨论主持人代发。自动讨论先 execution enter，创建安排或保存关联回答即完成本步，不创建原生定时任务；持久成员凭证不能替代自动执行，暂停、停止、换代、租约到期后的旧执行失效。run view/start/pause/stop/configure 字段查 CLI schema。",
        f"发言权：GET {base}/floor 返回 holder、next_speaker、revision；POST 同路径，字段 actor、speaker（默认 actor）、action=take/return、revision（刚读到的整数版本）。仅无人持有且 next_speaker 为本人时可领取；持有者可主动归还，下一位回到主持人。版本变化返回 409，先读回核对。主持人仅可代操作 online 专家，cli 专家自行操作；用户可协助。",
        "新房间由主持人持有发言权。创建安排须主持人持有，保存成功即归还并点名该专家；AI 的 opinion、moderation、receipt 都须实际作者持有，代发不豁免，opinion 必须关联有效 turn_id。消息保存成功自动归还，下一位为主持人。失败不归还，同编号重试不再次交接。用户本人发言不受发言权限制，也不改变发言权；@ 不改变顺序。维护状态、阶段及通知回执不占用发言权。取消安排须主持人持有，用户可直接取消失效安排；取消后归还给主持人领取。",
        '创建话题：POST /api/rooms，携带房主控制凭据；字段 title、goal、user_request、background、boundaries、host、experts、members、submission_id（新 UUID）。members 与 experts 名单一致，各项含 name、独立 token、access（手动本地 manual、自动 runner、在线 online）。AI 主持人必须为本地可写成员。CLI room create --access-file 私有房主文件 在请求前保存凭据，确认后返回各本地成员文件路径；同编号重试沿用原资料和全部凭据。名单、主持职责变更仅房主可做。',
        f"查询提交：GET /api/rooms?submission_id=编号 查建房结果；GET {base}/messages?submission_id=编号 或 {base}/turns?submission_id=编号 查消息或安排。查询成功且列表为空表示尚未查到，读取失败不表示未写入。",
        f"增量读取：GET {base}/messages?after=已读消息编号，每次最多 20 条，按 next_after 续读，has_more 表示还有一批；可加 kind=opinion/moderation/receipt、author、mention、q。after 不与翻页混用，过滤后的游标只代表该查询范围。",
        f"维护话题：POST {base}/topic；actor 加需要修改的上述字段，另可更新 phase（preparing/initial/discussing/reviewing/paused/concluded）、focus。收束前先完成或取消当前安排。暂停保留安排；恢复阶段后再继续。",
        f"安排发言：POST {base}/turns；字段 actor、expert、question、submission_id（新 UUID）。同一话题同时只有一个未完成安排；重试沿用同一编号和问题。整轮安排改传 turns=[{{expert,question}},…]（最多 {MAX_PLAN_TURNS} 项）：第一项立即生效，其余排队（queued）；每个回答保存后自动交给下一位，最后一位答完再交回主持人。用户留言或修改目标、背景、边界、焦点后（room.held_since 非 0），当前回答完成即交回主持人；主持人处理后用 POST {base}/turns/continue（actor）按原计划继续，或直接创建新安排替换剩余排队（原排队改为 skipped）。",
        f"通知：仅把对象、问题、话题入口交给对应专家，不附背景、摘要或历史。使用已有且获准的会话通道；没有通道时交由用户协助。实际送达后 POST {base}/turns/安排编号，字段 actor、status=notified；取消用 status=cancelled。复制不算送达。",
        f"专家观点：POST {base}/messages；author、text、submission_id、source=cli，kind=opinion；必须关联 turn_id（回答的安排编号），可选 reply_to（本话题原文编号）。每次回答同时提供 summary（最多 {MAX_SUMMARY_LENGTH} 字），通常 1–3 句结论先行，保留关键理由、条件和不确定性；summary_by 为原作者或提交者，默认提交者。text 保留完整正文，最多 {MAX_TEXT_LENGTH} 个 Unicode 字符，请求最多 {MAX_BODY_BYTES} 字节；不截断或用摘要完成安排。旧客户端缺少 summary 时不自动生成。",
        f"主持发言：同一消息接口，author={room['host']}、submitted_by={room['host']}、kind=moderation、source=cli；个人观点使用 kind=opinion，不能自动视为共识。",
        f"代发只读专家观点：author 保留原专家，submitted_by={room['host']}、kind=opinion、text 为原文；须关联 turn_id，可附 reply_to。服务保存代发来源；不要冒充专家直接提交。",
        f"整理状态：POST {base}/state；actor、text（详细状态，最多 {MAX_STATE_LENGTH} 字）、until（依据的消息截止编号）；brief（最多 {MAX_BRIEF_LENGTH} 字）为面向人的主持简报，说明结论、共识、歧义和下一步意图。进度或安排变化后更新；省略 brief 保留旧简报，空字符串清除。所有参与专家各保存一次完整观点才完成一轮；同轮重复发言只计该专家一次，主持说明、用户留言、回执及取消安排不推进轮次。房间 rounds 按当前配置专家和完整历史生成，completed_rounds 为完成轮数，answered_turns 仅为已回答安排数。状态不覆盖原文，也不代表全体一致同意。",
        "讨论方法：initial 先独立给出结论、依据、假设和风险，不回应他人；discussing 围绕具体分歧引用原文，说明维持或修正及原因；reviewing 检查拟定结论是否误述自己、遗漏条件或仍有阻碍。沉默不算同意。",
        f"运行回执：非必要不生成。正常启停、首次检查、无变化轮询和已提交回答不另发回执；仅用户明确要求、异常影响协作且需要处理或交接确需补充确认时使用。POST {base}/messages；author 使用实际身份、kind=receipt、source=cli、text 简述实际结果、影响和下一步，有任务时附本次运行标识与真实任务编号；已有状态或消息足够说明时不重复。submission_id 同次重试不变，不填 turn_id。回执不算专家观点或已回答。",
        "后台参与：先立即检查，再用本会话真实可用的原生任务按约定频率和自身运行上限检查。专家只答自己未完成的安排，无任务时等待；主持人仍需处理新回答、网页回复和下一安排。paused/concluded、用户叫停或达到自身上限时停止自己的任务并核验，实际结果保留在本地接续信息，是否发回执按上述规则判断；单个专家任务停止不等于整场讨论结束。失败时保留未提交原文，重新读取阶段后再决定是否重试。",
        "收束：结论须有原文依据，区分明确共识、未决分歧与主持人判断；完成约定复核或达到已说明的时间/轮次上限后收束。讨论完成与后台任务退出分别核验；不为追求全员确认无限续轮。",
        "房间、消息与安排都支持 submission_id 去重，同次重试沿用编号和原始内容，新内容使用新编号。写入后重新读取服务器返回的结果，核对身份、内容与引用。",
    ])


class DiscussionServer(ThreadingHTTPServer):
    """HTTP server carrying the configured SQLite path."""

    daemon_threads = True
    allow_reuse_address = os.name != "nt"
    allow_reuse_port = False

    def __init__(self, address, database, local_launch=False):
        self.database = Path(database)
        self.updates = threading.Condition()
        self.update_version = 0
        self.updates_closed = False
        if local_launch and address[0] != "127.0.0.1":
            raise ValueError("本机启动入口须绑定 127.0.0.1")
        self.local_launch = local_launch
        service_home = os.getenv("DISCUSS_SERVICE_HOME")
        self.connections_file = Path(service_home) / "site-connections.json" if service_home else None
        super().__init__(address, DiscussionHandler)

    def server_bind(self):
        """Keep each listening port exclusive while allowing normal Unix restarts."""
        if os.name == "nt":
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()

    def notify_update(self):
        """Wake browser subscribers after a committed business write."""
        with self.updates:
            self.update_version += 1
            self.updates.notify_all()

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
        quiet_renewal = parts[3:4] == ["events"] and (self.payload_cache or {}).get("action") == "renew"
        if (self.command == "POST" and 200 <= status < 300 and parts[:2] in (["api", "rooms"], ["api", "folders"])
                and not quiet_renewal):
            self.server.notify_update()
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

    def read_payload(self):
        """Read a bounded JSON object from an incoming form API request."""
        if getattr(self, "payload_cache", None) is not None:
            return self.payload_cache
        length = int(self.headers.get("Content-Length", "0"))
        if not 0 < length <= MAX_BODY_BYTES:
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
                    version = self.server.update_version
                self.wfile.write(b"event: change\ndata: {}\n\n" if changed else b": keepalive\n\n")
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
        if method == "OPTIONS" and route in (["settings"], ["launch"], ["room-models"], ["room-member"], ["models"], ["api-key"], ["pick-directory"]):
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
        elif route == ["room-member"] and method == "POST":
            command = "room-member"
        elif route == ["pick-directory"] and method == "POST":
            command = "pick-directory"
        else:
            raise LookupError("本机入口不存在")
        payload = None
        if method == "POST":
            if self.headers.get_content_type() != "application/json":
                raise ValueError("本机操作须使用 application/json")
            payload = self.read_payload()
            if command in ("start", "room-config", "room-models", "room-member"):
                payload.pop("access_file", None)
                payload.update(site=site, entry="web")
        if command == "room-config" and "participants" in payload:
            return self.save_local_room_configuration(command, payload)
        return self.run_local_command(command, payload)

    def save_local_room_configuration(self, command, payload):
        """Keep pause/revision validation and local file replacement ahead of any runtime write."""
        with closing(connect_db(self.server.database)) as connection, connection:
            begin_write(connection)
            room = require_room(connection, payload.get("room_id", ""))
            runtime = room["runtime"]
            if not runtime["protected"]:
                raise PermissionError("本场配置修正需要原控制凭据")
            require_control(connection, room["id"], payload.get("token", ""))
            if (room["archived"] or room["phase"] == "concluded" or runtime["mode"] != "automatic"
                    or runtime["status"] != "paused" or runtime["revision"] != payload.get("runtime_revision")):
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

    def handle_api(self, connection, parts, params, method):
        """Handle room, state, and message operations used by the web UI."""
        if parts == ["api", "health"] and method == "GET":
            return self.respond({"ok": True})
        if parts == ["api", "rooms"]:
            if method == "GET":
                return self.respond({**list_rooms(connection, params), "participants": PARTICIPANTS})
            room = create_room(connection, self.read_payload(), self.headers.get("X-Discussion-Token", ""))
            connection.commit()
            return self.respond(room, 200 if room["duplicate"] else 201)
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
        token = self.headers.get("X-Discussion-Token", "")
        free = room_mode(connection, room_id) == "free"
        if free and parts[3:4] in (["inbox"], ["executions"], ["members"], ["suggestions"]):
            return self.handle_free_api(connection, parts, method)
        if parts[3:4] == ["attachments"]:
            return self.handle_attachments(connection, parts, params, method)
        if parts[3:4] in (["runtime"], ["events"]):
            if free and method == "POST":
                raise ValueError("自由房间不使用讨论运行控制")
            return self.handle_runtime_api(connection, parts, params, method)
        free_actor = None
        if method == "POST" and len(parts) == 4 and parts[3] in DIRECTORY_OPERATIONS:
            pass
        elif method == "POST" and free:
            free_actor = authorize_free_write(connection, room_id, token, parts[3] if len(parts) > 3 else "", self.read_payload())
        elif method == "POST":
            authorize_write(connection, room_id, token, parts[3] if len(parts) > 3 else "", self.read_payload())
        if parts[3:] == ["backup"] and method == "GET":
            return self.respond(room_backup(connection, room_id))
        if len(parts) == 4 and parts[3] in ("move", "folder", "archive", "restore", "delete") and method == "POST":
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
            return self.respond(require_room(connection, room_id))
        if parts[3:] == ["limits"]:
            if method == "GET":
                return self.respond(require_room(connection, room_id)["limits"])
            result = check_limits(connection, room_id, self.read_payload())
            connection.commit()
            return self.respond(result)
        if parts[3:] == ["floor"]:
            if method == "GET":
                return self.respond(require_room(connection, room_id)["floor"])
            result = update_floor(connection, room_id, self.read_payload())
            connection.commit()
            return self.respond(result)
        if parts[3:4] in (["topic"], ["turns"]):
            return self.handle_host_api(connection, parts, params, method)
        if parts[3:] == ["messages"]:
            if method == "GET":
                return self.respond(query_messages(connection, room_id, params))
            payload = self.read_payload()
            result = append_message(connection, room_id, payload, self.headers.get("X-Discussion-Token", ""), free_actor)
            connection.commit()
            return self.respond(result, 200 if result["duplicate"] else 201)
        if len(parts) == 5 and parts[3] == "messages" and method == "GET":
            return self.respond(get_message(connection, room_id, int(parts[4])))
        if parts[3:] == ["state"] and method == "POST":
            result = update_state(connection, room_id, self.read_payload())
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
        if method == "GET" and len(parts) in (5, 6):
            attachment = get_attachment(connection, room_id, parts[4])
            if len(parts) == 5:
                return self.respond(attachment)
            if parts[5] == "content":
                return self.respond_attachment(attachment, params.get("download") == "1")
        raise LookupError("地址不存在")

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
            result = runtime_view(connection, room_id) if method == "GET" else configure_runtime(
                connection, room_id, token, self.read_payload())
        elif parts[3:] == ["events"] and method == "GET":
            result = list_events(connection, room_id, token, params.get("after", 0))
        elif len(parts) == 5 and parts[3] == "events" and method == "POST":
            result = event_action(connection, room_id, int(parts[4]), token, self.read_payload())
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
        if parts[3:] == ["topic"] and method == "POST":
            result = update_topic(connection, room_id, self.read_payload())
        elif parts[3:] == ["turns"]:
            if method == "GET":
                return self.respond(query_turns(connection, room_id, params))
            result = create_turn(connection, room_id, self.read_payload())
            status = 200 if result["duplicate"] else 201
        elif parts[3:] == ["turns", "continue"] and method == "POST":
            result = continue_turns(connection, room_id, self.read_payload())
        elif len(parts) == 5 and parts[3] == "turns":
            result = get_turn(connection, room_id, parts[4]) if method == "GET" else update_turn(connection, room_id, parts[4], self.read_payload())
        else:
            raise LookupError("地址不存在")
        connection.commit()
        return self.respond(result, status)

    def handle_text(self, connection, parts, params):
        """Expose read-only history and search without JavaScript or MCP."""
        if len(parts) < 2:
            raise LookupError("请指定房间")
        room_id = parts[1]
        if len(parts) == 2:
            body = room_text(connection, room_id, params)
        elif parts[2:] in (["brief"], ["state"], ["protocol"]):
            room = require_room(connection, room_id)
            body = brief_text(room) if parts[2] == "brief" else protocol_text(room)
            if parts[2] == "state":
                body = state_reading_text(room)
        elif parts[2:] == ["turns"]:
            result = query_turns(connection, room_id, params)
            room = require_room(connection, room_id)
            body = f"第 {result['page']} / {result['pages']} 页，共 {result['total']} 项。\n\n" + "\n\n".join(turn_text(turn, room) for turn in result["turns"])
        elif len(parts) == 4 and parts[2] == "turns":
            body = turn_text(get_turn(connection, room_id, parts[3]), require_room(connection, room_id))
        elif parts[2:] in (["messages"], ["search"]):
            result = query_messages(connection, room_id, params)
            items = [message_text(message) for message in result["messages"]]
            next_page = f"第 {result['page']} / {result['pages']} 页，共 {result['total']} 条。翻页：保留查询条件，修改 page 参数。"
            body = next_page + "\n\n" + "\n\n---\n\n".join(items or ["没有匹配的消息。"])
        elif len(parts) == 4 and parts[2] == "messages":
            body = message_text(get_message(connection, room_id, int(parts[3])))
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
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    init_database(args.database, seed=not args.no_demo)
    server = DiscussionServer((args.host, args.port), args.database, local_launch=args.local_launch)
    logging.info("AI CoDiscuss ready at http://%s:%s", args.host, args.port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logging.info("Server stopped")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()

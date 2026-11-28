"""AI CoDiscuss 的零依赖 HTTP / SQLite 概念验证服务。"""

import argparse
import collections
import copy
import hashlib
import hmac
import io
import json
import logging
import mimetypes
import os
import re
import secrets
import socket
import sqlite3
import stat
import struct
import subprocess
import threading
import time
import uuid
import zipfile
import zlib
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
from contextlib import closing
from datetime import datetime, timedelta, timezone
from http.client import HTTPException, HTTPSConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlsplit

from .entry_guard import (BROWSER_COOKIE_SECONDS, HELLO_PATH, OPEN_PATH, PUBLIC_PATHS, EntryPolicy, answer_hello, browser_admitted,
                          browser_cookie_name, open_link_key, proof, request_proven)
from .analytics import moss_snapshot, seal_room, snapshot as analytics_snapshot
from .texts import BoundaryError, ReadError, Text, error_body, incoming_text, load_texts, save_text, text_payload
from .admin import (AdminError, admin_status, change_password, list_sessions, login_admin, logout_admin, register_admin,
                    revoke_sessions, session_valid, update_profile)
from .remote_launch import (COMMAND_WAIT_MAX, claim_machine_commands, finish_machine_command, list_machines, machine_command_status,
                            machine_launch_action, machine_sync, pair_machine, remote_launch_status, submit_machine_command,
                            submit_remote_launch)
from .free_room import (active_members, add_member, after_free_message, after_proactive, authorize_free_write, check_answer, execution_action, free_view,
                        inbox, interrupt_for_message, interrupt_member, queue_request_action, member_action, member_capability, member_values, migrate_free_tables, reserve_execution,
                        room_failure_wakes, room_quiet_checkins, save_room_access, view_execution, recent_executions, MAX_MESSAGE_ID)
from .free_room import ROOM_ATTENTION_SQL, ROOM_WAITING_SINCE_SQL, STEWARD_SESSION_TEMPLATE, convert_suggestion, message_suggestions, replace_steward_member, save_suggestions, sync_participants
from .free_room import account_quotas, report_quota
from .free_room import HOST_WITHDRAW_RESULT, OWNER_INTERRUPT_RESULT, OWNER_REWIND_RESULT, OWNER_STOP_RESULT, observed_host_versions
from .free_room import adopt_recommendation, recommend_member, register_member, require_member
from .private_chat import chat_action, member_chat
from .external_members import external_api, guard_route as guard_external_route, is_external_path, owner_api as external_owner_api, require_external
from .external_members import (GUEST_SERVICE_ACTIONS, add_guest_question_origin, guest_dispatch_held,
                               guest_display_names, guest_error, guest_guard,
                               guest_mode_active, guest_origin, guest_owner_api, guest_path, guest_projection)
from .free_room import describe_members, execution_notes, label_members, check_relay, record_host_action, record_relay_send, record_room_link, save_message_relay, set_host_checkin, withdraw_dispatch, member_descriptions, member_display_names, member_handles, member_labels, reorder_speakers, resolve_member_fields, set_chain_rounds, speaking_order, stop_room, stop_room_work
from .free_room import (ADAPTER_VALUE, LAYOUT_AFTER_SQL, LAYOUT_AT_SQL, continue_chain, execution_segments, execution_timeline, group_route_plan, retract_message, rewind_plan, rewind_room,
                        host_event, host_hidden_event, room_event_log, withdrawals)
from .room_trace import message_trace
from .free_room import review_capability, review_roster, checked_review_plan, save_review_plan, check_review_retry
from .free_room import review_ready, advance_review, late_answer, execution_changes, execution_changes_batch, execution_diffs
from .free_room import checked_sequence, continue_sequence, sequence_view
from .windows_thumbnail import encode_preview
from . import cloud_drive, cloud_shares, moss_results, questions
from .visual_fences import fold_message_visuals
from .identity import MAX_ROOM_AGENTS, PARTICIPANTS, default_label, default_label_text, is_ai, is_participant
from .message_queue import drain as drain_queue, enqueue, enqueue_share, queue_action, queue_split, queue_view
from .room_import import import_room, imported_attachment
from .object_storage import (OBJECT_MAX_BYTES, ObjectMissing, StorageUnavailable, configured_storage,
                             object_storage_quota_mib, object_storage_retention_days, object_storage_threshold_mib,
                             storage_http_error)
from .free_room import save_relay_receipt
from .room_links import list_links
from .free_room import insert_request, require_owner_or_host
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
# The file page uploads to a project in parts of up to 3 MiB on the computer itself (base64 in JSON).
MAX_FILE_PART_BODY_BYTES = 5 * 1024 * 1024
MAX_IMPORT_BYTES = 32 * 1024 * 1024
ATTACHMENT_POLICY = json.loads(Path(__file__).with_name("attachment_policy.json").read_text(encoding="utf-8"))


def attachment_limit_mib(database):
    """Read the administrator's current upload policy for this instance."""
    path = Path(os.environ.get("DISCUSS_ATTACHMENT_POLICY_FILE") or Path(database).with_name("attachment-limit.json"))
    minimum, maximum = ATTACHMENT_POLICY["min_mib"], ATTACHMENT_POLICY["max_mib"]
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        if type(value) is not int or not minimum <= value <= maximum:
            raise ValueError
        return value
    except FileNotFoundError:
        pass
    except (OSError, ValueError):
        logging.warning("Invalid or unreadable attachment limit; expected an integer from %d to %d MiB", minimum, maximum)
    return ATTACHMENT_POLICY["default_mib"]

# A smaller copy of an image a page made (WebP or JPEG), shown in messages in place of the original: at most this many
# bytes and this many pixels on its longer side, and its shape within THUMBNAIL_RATIO_TOLERANCE of the original's.
MAX_THUMBNAIL_BYTES = 512 * 1024
MAX_THUMBNAIL_SIDE = 1600
THUMBNAIL_RATIO_TOLERANCE = 0.03
THUMBNAIL_TYPES = ("image/webp", "image/jpeg")
THUMBNAIL_SUFFIX = ".thumbnail"
# Files uploaded while the message is still being written are dropped if never sent within this time.
UNSENT_ATTACHMENT_TTL = timedelta(hours=24)
ATTACHMENT_SWEEP_SECONDS = 6 * 60 * 60
BYTES_PER_MIB = 1024 * 1024
ORPHAN_ATTACHMENT_GRACE_SECONDS = 60 * 60
CLOUD_COPY_CHUNK_BYTES = 1024 * 1024
CLOUD_COPY_TIMEOUT_SECONDS = 30
CLOUD_LAND_GRANT_SECONDS = 60
CLOUD_COPY_WORKERS = 4
CLOUD_COPY_FAILED_RESULTS = 128
MAX_CLOUD_SOURCE_REF = 4096
MAX_MESSAGE_ATTACHMENTS = 10
MAX_FILENAME_LENGTH = 255
# A revision check names at most this many rooms; a runner or page asks only for the rooms it follows.
MAX_REVISION_ROOMS = 100
CONNECT_LOCK = threading.Lock()  # see connect_db
LOCAL_LAUNCH_TIMEOUT = 60
MACHINE_COMMAND_POLL_SECONDS = 0.5
# Ordering and filing a channel only rearrange the shared directory, like folder edits, so they need no room credential.
DIRECTORY_OPERATIONS = ("move", "folder", "detach")
# Local entry commands for external members: the owner's invites (room credential) and this computer's invited records.
INVITE_COMMANDS = ("guest-invite", "room-invite", "room-invites", "room-invite-revoke")
STEWARD_COMMANDS = ("steward", "steward-settings", "steward-request", "steward-history", "steward-delete", "steward-duty", "steward-mute", "steward-renew")
STEWARD_PROACTIVE_TEMPLATE = "steward_proactive"
STEWARD_MEMBER_LIMIT = Text("平台主理人房间只能有一名成员，不能新增或邀请成员")
INVITED_COMMANDS = ("invited-list", "invited-join", "invited-trust", "invited-ai", "invited-pause", "invited-approve", "invited-refuse",
                    "invited-lend", "invited-leave", "invited-remove", "invited-room")
SITE_COMMANDS = ("site-stage", "site-publish", "site-list", "site-diagnose", "site-renew", "site-rollback", "site-revoke")
ADMIN_OPERATIONS = ("rename", "archive", "restore", "delete", "auto-destroy")
# A room may destroy itself after this many days without a message; 0 keeps it. How often the website checks.
AUTO_DESTROY_DAYS = (0, 1, 7, 30)
AUTO_DESTROY_CHECK_SECONDS = 600
DIRECTORY_PICKER_TIMEOUT = 600  # the folder dialog waits for the person at the computer
# Files are streamed to players in pieces of this size.
FILE_CHUNK_BYTES = 1024 * 1024
# A project media file the local page plays is served by a random ticket for this long after the runner checked access.
MEDIA_TICKET_SECONDS = 600
# A project page the computer's own browser opens in a tab keeps reading the files beside it (lazy images, scripts) for
# this long; its address is a random ticket naming the project folder, never a path.
PAGE_TICKET_SECONDS = 12 * 3600
# The most script the page may ask to put into the opened file (the preview's selection bridge).
MAX_PAGE_INJECT_BYTES = 8 * 1024
# A page is served on its own origin, `p<folder hash>.localhost:<port>` (browsers send *.localhost to this computer), so it
# runs as it would opened from disk, with its own storage (2026-11-26 user #12484: as a sandboxed opaque origin it could
# not use localStorage and its script stopped, leaving an empty page), yet shares nothing with this site's origin; on that
# host this server answers page files alone (`page_host_request`).
PAGE_HOST = re.compile(r"p([0-9a-f]{16})\.localhost:(\d+)")
MAX_MEDIA_TICKETS = 64
MAX_TEXT_LENGTH = 32000
SESSION_ID_PATTERN = re.compile(r"[0-9A-Za-z_-]{8,128}")
MAX_STATE_LENGTH = 4000
MAX_BRIEF_LENGTH = 1600
MAX_SUMMARY_LENGTH = 1000
PAGE_SIZE = 20
# A reader may ask for larger pages (`limit`) so a long transcript loads in one request instead of many.
MAX_PAGE_SIZE = 200
# A reader's overall output budget (`max_output_chars`, spec #3220 R3), in code points of compact JSON: the floor still fits one message's
# metadata and a useful preview; numbers a preview's fields may still grow by are kept in reserve.
MIN_OUTPUT_CHARS = 1000
MAX_OUTPUT_CHARS = 200000
PREVIEW_NUMBER_CHARS = 80
UNCATEGORIZED_FOLDER_ID = "__uncategorized__"
# A folder's project paths: one main directory plus MAX_EXTRA_DIRECTORIES (runner/discussion_runner.mjs) others.
MAX_FOLDER_DIRECTORIES = 9
MAX_DIRECTORY_PATH = 1000
ABSOLUTE_PATH_PATTERN = re.compile(r"(?:[A-Za-z]:[\\/]|/)")
ASSETS = {"/": ("index.html", "text/html"),
          "/app.js": ("app.js", "text/javascript"),
          "/modern.js": ("modern.js", "text/javascript"),
          "/modern.css": ("modern.css", "text/css"),
          "/markdown.js": ("markdown.js", "text/javascript"),
          "/backup.js": ("backup.js", "text/javascript"),
          "/i18n.js": ("i18n.js", "text/javascript"),
          "/video-compress.js": ("video-compress.js", "text/javascript"),
          "/markdown.css": ("markdown.css", "text/css"),
          "/icons/LICENSE.txt": ("icons/LICENSE.txt", "text/plain")}
# Serve bundled images without maintaining a second list of brand names.
for icon in (WEB_ROOT / "icons").iterdir():
    icon_type = mimetypes.guess_type(icon.name)[0] or ""
    if icon.is_file() and not icon.name.startswith(".") and icon_type.startswith("image/"):
        ASSETS[f"/icons/{icon.name}"] = (f"icons/{icon.name}", icon_type)
ASSETS.update({"/pdfjs/" + file.relative_to(WEB_ROOT / "pdfjs").as_posix():
               (file.relative_to(WEB_ROOT).as_posix(),
                {".mjs": "text/javascript", ".js": "text/javascript", ".wasm": "application/wasm"}.get(file.suffix, "application/octet-stream"))
               for file in (WEB_ROOT / "pdfjs").rglob("*") if file.is_file()})
# Office previews the page imports only when such a file is opened, with their WebAssembly and workers.
if (WEB_ROOT / "office").is_dir():
    ASSETS.update({"/office/" + file.relative_to(WEB_ROOT / "office").as_posix():
                   (file.relative_to(WEB_ROOT).as_posix(),
                    {".mjs": "text/javascript", ".js": "text/javascript", ".wasm": "application/wasm", ".css": "text/css"}.get(file.suffix, "application/octet-stream"))
                   for file in (WEB_ROOT / "office").rglob("*") if file.is_file()})
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
API_LOG_SECRET = re.compile(r"token|password|secret|api_?key|credential|authorization|^grant$", re.IGNORECASE)
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
DISPATCH_CASE_TEXT_LIMIT = 4000
DISPATCH_CONTEXT_LIMIT = 1500
DISPATCH_CONTEXT_BEFORE = 3
DISPATCH_CONTEXT_AFTER = 5
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
        "topic_settings", "discussion_limits", "member_labels", "member_descriptions")},
    "scheduler_decisions": f"{DECISION_SELECT} WHERE d.room_id=? ORDER BY d.id",
    "dispatch_feedback": """SELECT f.* FROM dispatch_feedback f JOIN messages m ON m.id=f.message_id
        WHERE m.room_id=? ORDER BY f.message_id""",
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
    # Destroying a room removes its private chats, so the copy taken beforehand must carry them.
    "private_chats": "SELECT id,room_id,member_id,text,reply,status,reason,created_at,updated_at FROM private_chats WHERE room_id=? ORDER BY id",
}
MESSAGE_QUERY = """SELECT messages.*, COALESCE(details.kind,'opinion') AS kind,
COALESCE(details.submitted_by, CASE WHEN messages.source IN ('cli','api','url','user')
THEN messages.author ELSE '用户' END) AS submitted_by,
COALESCE(summaries.text,'') AS summary, COALESCE(summaries.author,'') AS summary_by, timing.elapsed_seconds,
answered.execution_id, answered.request_message_id, answered.layout_after, answered.layout_at, COALESCE(withdrawn.kind,'') AS withdrawn,
CASE WHEN messages.author='用户' THEN (
  SELECT CASE WHEN COUNT(parent_id)=COUNT(*) AND MIN(parent_id)=MAX(parent_id) THEN MIN(parent_id) END
  FROM (SELECT (SELECT MIN(original.message_id) FROM member_requests original
      JOIN messages parent ON parent.id=original.message_id AND parent.author='用户'
      WHERE original.room_id=messages.room_id AND (original.execution_id=i.execution_id OR original.id IN
        (SELECT request_id FROM retried_requests WHERE execution_id=i.execution_id))
        AND original.message_id<messages.id AND c.steer=1 AND i.status!='failed') AS parent_id
    FROM member_requests target LEFT JOIN execution_interjections i ON i.room_id=messages.room_id
      AND i.submission_id='queue-' || messages.id || '-' || target.member_id
    LEFT JOIN execution_capabilities c ON c.execution_id=i.execution_id
    WHERE target.message_id=messages.id)
) END AS interjection_parent_id,
EXISTS(SELECT 1 FROM proactive_messages p WHERE p.message_id=messages.id) AS proactive,
(SELECT f.source_id FROM execution_followups f WHERE f.execution_id=answered.execution_id) AS followup_of,
EXISTS(SELECT 1 FROM execution_schedules s WHERE s.execution_id=answered.execution_id) AS scheduled,
sent.target_room_id AS relay_sent_room, sent.host AS relay_sent_host, sent.target_message_id AS relay_sent_message_id,
CASE WHEN report.message_id<>messages.id AND report.state IN ('','waiting','waiting_user') AND sent.state='replied'
     THEN 'delivered' ELSE sent.state END AS relay_sent_state, relay.expect AS relay_expect, relay.reply_to AS relay_reply_to,
 report.state AS relay_report_state, report.summary AS relay_report_summary, report.result_message_id AS relay_report_message_id,
 report.review_message_id AS relay_review_message_id,
sent.queued_id AS relay_sent_queued_id, sent.interrupted AS relay_sent_interrupted,
(SELECT r.title FROM rooms r WHERE r.id=sent.target_room_id) AS relay_sent_title,
(SELECT relation FROM room_links WHERE room_id=messages.room_id AND other_room_id=sent.target_room_id) AS relay_sent_relation,
relay.source_room_id AS relay_room, relay.host AS relay_host,
COALESCE(NULLIF(relay.member,''),(SELECT name FROM room_members WHERE room_id=relay.source_room_id AND role='host' AND status='active')) AS relay_member,
(SELECT relation FROM room_links WHERE room_id=messages.room_id AND other_room_id=relay.source_room_id) AS relay_relation,
(SELECT l.other_room_id FROM room_links l WHERE l.message_id=messages.id) AS link_room,
(SELECT l.relation FROM room_links l WHERE l.message_id=messages.id) AS link_relation,
(SELECT r.title FROM room_links l JOIN rooms r ON r.id=l.other_room_id WHERE l.message_id=messages.id) AS link_title,
(SELECT r.title FROM rooms r WHERE r.id=relay.source_room_id) AS relay_title,
CASE WHEN relay.message_id IS NOT NULL THEN (SELECT m.name FROM member_requests q JOIN room_members m ON m.id=q.member_id
    WHERE q.message_id=messages.id ORDER BY q.id LIMIT 1) END AS relay_to
FROM messages LEFT JOIN message_details AS details ON details.message_id=messages.id
LEFT JOIN (SELECT message_id,target_room_id,host,target_message_id,queued_id,interrupted,state FROM room_relay_sends) AS sent
    ON sent.message_id=messages.id
LEFT JOIN moss_delegations AS report ON report.message_id=COALESCE(
    (SELECT message_id FROM moss_reworks WHERE root_message_id=messages.id ORDER BY message_id DESC LIMIT 1),messages.id)
LEFT JOIN message_relays AS relay ON relay.message_id=messages.id
LEFT JOIN message_withdrawals AS withdrawn ON withdrawn.message_id=messages.id
LEFT JOIN message_summaries AS summaries ON summaries.message_id=messages.id
LEFT JOIN message_timings AS timing ON timing.message_id=messages.id
LEFT JOIN (SELECT r.answer_id, MIN(r.execution_id) AS execution_id, MIN(r.message_id) AS request_message_id,
  MAX(""" + LAYOUT_AFTER_SQL + """) AS layout_after, MIN(""" + LAYOUT_AT_SQL + """) AS layout_at
  FROM member_requests r WHERE r.room_id=? AND r.answer_id IS NOT NULL
  GROUP BY r.answer_id HAVING MIN(r.execution_id) IS NOT NULL) AS answered
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
    tables["stored_texts"] = [dict(row) for row in connection.execute(
        """SELECT st.* FROM stored_texts st WHERE
           (st.owner='message' AND st.owner_id IN (SELECT id FROM messages WHERE room_id=?)) OR
           (st.owner IN ('decision','scheduler_decision') AND st.owner_id IN (SELECT id FROM scheduler_decisions WHERE room_id=?)) OR
           (st.owner='member' AND st.owner_id IN (SELECT id FROM room_members WHERE room_id=?)) OR
           (st.owner='request' AND st.owner_id IN (SELECT id FROM member_requests WHERE room_id=?)) OR
           (st.owner='session' AND st.owner_id IN (SELECT id FROM discussion_sessions WHERE room_id=?)) OR
           (st.owner='session_request' AND st.owner_id IN (SELECT id FROM session_requests WHERE session_id IN (SELECT id FROM discussion_sessions WHERE room_id=?))) OR
           (st.owner='room' AND st.owner_id=?)""",
        (room_id, room_id, room_id, room_id, room_id, room_id, room_id))]
    for attachment in tables["attachments"]:
        attachment.pop("object_name", None)
    if not tables["rooms"]:
        raise LookupError(Text('房间不存在'))
    return {"format": "ai-codiscuss-room-backup", "version": 2,
            "exported_at": utc_now(), "tables": tables}


def session_read_boundary(connection, room_id, token=""):
    """Return the current identity's initial-opinion cutoff, or None when unrestricted."""
    return session_message_access(connection, room_id, {}, token)


def boundary_note(boundary):
    """Why a field is empty although it has a value: it lies past the reader's boundary (spec #3187 section 5)."""
    return {"reason": "reading_boundary", "request_read_until": boundary}


def room_read_view(connection, room, token=""):
    """Hide post-cutoff state and execution references from readers in the initial-opinion phase.

    What is hidden is named in `field_notes` with its reason, so a hidden value is never mistaken for an empty one;
    `state_until` is how far the notes cover, not a reading permission, and stays. The reader's own request keeps its
    question: hiding one's own task would leave nothing to answer."""
    room = member_limits(connection, hide_queued_questions(connection, room, token), token)
    boundary = session_read_boundary(connection, room["id"], token)
    if boundary is None:
        return room
    room = copy.deepcopy(room)
    notes = {}
    if room.get("state_until", 0) > boundary:
        room["state_text"] = ""
        room.get("texts", {}).pop("state_text", None)
        notes["state_text"] = boundary_note(boundary)
    brief = room.get("host_brief")
    if brief and brief.get("until", 0) > boundary:
        room["host_brief"] = None
        notes["host_brief"] = boundary_note(boundary)
    if notes:
        room["field_notes"] = notes
    try:
        reader = require_member(connection, room["id"], token)["name"] if token else None
    except PermissionError:
        reader = None
    free = room.get("free") or {}
    if free.get("questions"):
        free["questions"] = questions.bounded(free["questions"], boundary)
    if "waits" in free:
        free["waits"] = [wait for wait in free["waits"] if wait["message_id"] <= boundary]
    for request in free.get("requests", []):
        _hide_after_boundary(request, boundary, ("message_id", "answer_id", "source_message_id", "after_message_id", "layout_after"))
        _hide_question(request, boundary, reader)
    for execution in free.get("executions", []):
        if reader is None or execution.get("member") != reader:
            summary = execution.get("change_summary") or {}
            summary.pop("changes", None)
            summary.pop("diff_stats", None)
            if summary.get("count"):
                summary["unavailable"] = True
        _hide_execution_after_boundary(execution, boundary)
    executions_by_id = {execution.get("id"): execution for execution in free.get("executions", [])}
    for member in free.get("members", []):
        execution = member.get("execution") or {}
        _hide_execution_after_boundary(execution, boundary)
        sanitized = executions_by_id.get(execution.get("id"))
        if sanitized:
            execution["result"] = sanitized.get("result", execution.get("result", ""))
    return room


def hide_queued_questions(connection, room, token):
    """A discussion member reads its own queued question, not the questions later speakers will get (D2).

    The owner and the host see the whole plan; any other member sees who is queued, with the others' questions
    replaced by a note saying they are someone else's."""
    queued = room.get("queued_turns") or []
    if not queued or not token:
        return room
    try:
        reader = require_member(connection, room["id"], token)
    except PermissionError:
        return room
    if reader["role"] == "host":
        return room
    hidden = [{**turn, "question": "", "field_notes": {"question": Text('其他专家的题目，轮到其发言前不公开')}}
              if turn.get("expert") != reader["name"] else turn for turn in queued]
    return {**room, "queued_turns": hidden}


def member_limits(connection, room, token):
    """One exit per fact for a member that is not the host (可 1, ruling #402 C): of the discussion limits it keeps
    whether one was reached and why; the task chain's budget is read from `free.chain_rounds` alone.

    The owner and the host keep the full limits, which they set and plan by."""
    if not token or not isinstance(room.get("limits"), dict):
        return room
    try:
        reader = require_member(connection, room["id"], token)
    except PermissionError:
        return room
    if reader["role"] == "host":
        return room
    limits = room["limits"]
    room = {**room, "limits": {"reached": limits.get("reached", False), "stop_reason": limits.get("stop_reason", "")}}
    if isinstance(room.get("free"), dict):
        room["free"] = {key: value for key, value in room["free"].items() if key != "max_rounds"}
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
    if not execution.get("result"):
        execution.get("texts", {}).pop("result", None)
    for field in ("layout_after",):
        if isinstance(execution.get(field), int) and execution[field] > boundary:
            execution[field] = None
    for request in execution.get("requests", []):
        _hide_after_boundary(request, boundary, ("message_id", "answer_id", "source_message_id", "after_message_id", "layout_after"))
        _hide_question(request, boundary, None)


def _hide_question(request, boundary, reader):
    """Hide another member's discussion question from an initial reader, saying so; the reader's own stays."""
    if not (request.get("discussion_session_id") and request.get("source_question")):
        return
    if reader and request.get("member") == reader:
        return
    request["source_question"] = ""
    request.get("texts", {}).pop("source_question", None)
    request.setdefault("field_notes", {})["source_question"] = boundary_note(boundary)


def utc_now():
    """Return the current UTC timestamp in ISO format."""
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class RoomConnection(sqlite3.Connection):
    """Keep cross-room invalidations until the request's transaction commits."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.moss_updates = set()


def connect_db(database):
    """Open a database connection with named rows and foreign keys enabled."""
    # Each request opens its own connection, whose first statement parses the whole schema. Parsed in parallel,
    # those allocations contend on SQLite's global memory mutex: a runner polling ~20 rooms at once burned several
    # CPU cores on Windows. Parsing them one at a time costs a few milliseconds each.
    with CONNECT_LOCK:
        connection = sqlite3.connect(database, timeout=10, factory=RoomConnection)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        # Deleted rows are overwritten with zeros, so a destroyed room leaves no readable remains in free pages.
        connection.execute("PRAGMA secure_delete = ON")
        connection.execute("SELECT 1 FROM sqlite_master LIMIT 1").fetchone()
    return connection


def seed_demo(connection):
    """Insert clearly labeled sample content into a newly initialized database."""
    title = Text("AI 留言板 · 设计讨论")
    goal = Text("让不同 AI 共享讨论信息，控制每轮上下文，并保留可检索的完整历史。")
    connection.execute("INSERT INTO rooms (id,title,goal,created_at) VALUES (?,?,?,?)",
                       ("welcome", title, goal, utc_now()))
    save_text(connection, "room", "welcome", "title", title)
    save_text(connection, "room", "welcome", "goal", goal)
    # A sample room without an owner credential: it can be read, never written.
    connection.execute("INSERT INTO room_modes (room_id,mode,control_hash) VALUES ('welcome','free','')")
    samples = [
        ("用户", Text("我们先验证一个简单场景：不同 AI 能否通过同一个房间阅读、检索和留言？\n首轮只讨论信息如何流转，不接入真实模型。"), None),
        ("Codex", Text("建议把完整历史保留下来，每轮先给目标、当前状态和需要回应的消息。\n@Claude 如果摘要遗漏了重要条件，参与者如何核对？"), 1),
        ("Claude", Text("每条结论都应引用原始消息编号。AI 可以主动读取原文，也能按关键词检索。\n摘要由主持人维护，未解决的分歧不能写成共识。"), 2),
        ("Antigravity", Text("每位成员在自己的会话里工作，按需读取房间，不一次加载全部历史。\n@DeepSeek 请检查阅读入口和原文引用是否清楚。"), 1),
        ("DeepSeek", Text("回答由成员自己提交，保留作者和引用关系，便于其他参与者继续讨论。"), 4),
        ("Qwen", Text("需要更多上下文时，我可以按编号或关键词检索，例如读取 #{message_id} 的完整原文。", message_id=2), 2),
    ]
    base_time = datetime.now(timezone.utc) - timedelta(minutes=len(samples) * 3)
    for index, (author, text, reply_to) in enumerate(samples):
        created_at = (base_time + timedelta(minutes=index * 3)).isoformat(timespec="seconds")
        cursor = connection.execute("INSERT INTO messages (room_id,author,text,reply_to,source,submission_id,created_at) VALUES (?,?,?,?,?,?,?)",
                           ("welcome", author, text, reply_to, "demo", f"demo-{index}", created_at))
        save_text(connection, "message", cursor.lastrowid, "text", text)
    summary = Text("已达成共识\n• 完整历史只追加，支持按编号查阅和关键词检索。〔#{first}、#{second}〕\n• 成员按需读取房间，回答由成员自己提交。〔#{third}、#{fourth}〕\n\n待验证\n• 阅读入口和原文引用是否清楚。〔#{third}〕\n• 检索是否足以找回所需上下文。〔#{fifth}〕", first=2, second=3, third=4, fourth=5, fifth=6)
    connection.execute("UPDATE rooms SET state_text=?,state_until=6 WHERE id='welcome'", (summary,))
    save_text(connection, "room", "welcome", "state_text", summary)


GOAL_PHASE_COLUMNS = (("idle_seconds", "INTEGER NOT NULL DEFAULT 120"),
                      ("phase", "TEXT NOT NULL DEFAULT 'doing' CHECK(phase IN ('doing','waiting','pending'))"),
                      ("phase_note", "TEXT NOT NULL DEFAULT ''"), ("phase_since", "INTEGER NOT NULL DEFAULT 0"),
                      ("phase_until", "INTEGER NOT NULL DEFAULT 0"), ("pending_fallback", "INTEGER NOT NULL DEFAULT 0"))


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


def migrate_dispatch_withdrawals(connection):
    """One-time repair of legacy withdrawal records, using successful writes with cancellation evidence."""
    if not connection.execute("""INSERT OR IGNORE INTO site_preferences(key,value)
        VALUES('dispatch_withdrawals_v2','1')""").rowcount:
        return
    connection.execute("""DELETE FROM dispatch_withdrawals WHERE legacy=1 OR NOT EXISTS(
        SELECT 1 FROM dispatch_withdrawn_requests w JOIN member_requests r ON r.id=w.request_id
        WHERE r.message_id=dispatch_withdrawals.message_id OR r.batch_id IN (
            SELECT json_extract(step.value,'$[2]') FROM free_sequences s,json_each(s.steps) step
            WHERE s.message_id=dispatch_withdrawals.message_id))""")
    connection.execute("""INSERT OR IGNORE INTO dispatch_withdrawals(message_id,legacy)
        SELECT m.id,1 FROM room_events e JOIN messages m
          ON m.id=CAST(substr(json_extract(e.data,'$.path'),13) AS INTEGER) AND m.room_id=e.room_id
        WHERE e.kind='api.write' AND json_extract(e.data,'$.status')=200
          AND json_extract(e.data,'$.path')=('/dispatches/' || m.id || '/withdraw')
          AND EXISTS(SELECT 1 FROM room_events c JOIN member_requests r
              ON r.id=json_extract(c.data,'$.request_id') AND r.room_id=c.room_id
              WHERE c.room_id=e.room_id AND c.id<e.id AND c.kind='request.changed'
                AND c.at BETWEEN e.at-1 AND e.at+COALESCE(json_extract(e.data,'$.elapsed_ms'),0)+1
                AND json_extract(c.data,'$.status')='cancelled'
                AND (r.message_id=m.id OR r.batch_id IN (
                    SELECT json_extract(step.value,'$[2]') FROM free_sequences s,json_each(s.steps) step
                    WHERE s.message_id=m.id)))""")


def migrate_guest_cancel_reasons(connection):
    """Extend the cancellation constraint without discarding existing reasons or replaying their events."""
    definition = connection.execute("SELECT sql FROM sqlite_master WHERE name='request_cancel_reasons'").fetchone()[0]
    if "'guest_disconnected'" in definition:
        return
    trigger = connection.execute("SELECT sql FROM sqlite_master WHERE name='event_request_cancel_reason'").fetchone()[0]
    begin_write(connection)
    connection.execute("ALTER TABLE request_cancel_reasons RENAME TO previous_request_cancel_reasons")
    connection.execute(definition.replace("CHECK(reason IN (", "CHECK(reason IN ('guest_disconnected','guest_withdrawn',"))
    connection.execute("INSERT INTO request_cancel_reasons SELECT * FROM previous_request_cancel_reasons")
    connection.execute("DROP TABLE previous_request_cancel_reasons")
    connection.execute(trigger)


def migrate_room_waits(connection, tables):
    """Preserve existing waits and enforce one open wait per member before applying the schema."""
    if "room_waits" not in tables:
        return
    begin_write(connection)
    if "end_reason" in {row[1] for row in connection.execute("PRAGMA table_info(room_waits)")}:
        return
    connection.execute("ALTER TABLE room_waits ADD COLUMN end_reason TEXT NOT NULL DEFAULT '' "
                       "CHECK(end_reason IN ('','user','superseded','withdrawn','member_removed'))")
    connection.execute("UPDATE room_waits SET end_reason='user' WHERE ended_at>0 AND end_message_id>0")
    connection.execute("""UPDATE room_waits SET
        ended_at=(SELECT created_at FROM message_withdrawals WHERE message_id=room_waits.message_id),
        end_reason='withdrawn' WHERE ended_at=0 AND message_id IN (SELECT message_id FROM message_withdrawals)""")
    connection.execute("""UPDATE room_waits SET ended_at=MAX(created_at,CAST(strftime('%s','now') AS INTEGER)),end_reason='withdrawn'
        WHERE ended_at=0 AND message_id IN (SELECT message_id FROM dispatch_withdrawals)""")
    connection.execute("""UPDATE room_waits SET ended_at=MAX(created_at,CAST(strftime('%s','now') AS INTEGER)),end_reason='member_removed'
        WHERE ended_at=0 AND member_id IN (SELECT id FROM room_members WHERE status='removed')""")
    connection.execute("""WITH next_waits AS MATERIALIZED (
        SELECT id,LEAD(created_at) OVER (PARTITION BY member_id ORDER BY id) AS superseded_at
        FROM room_waits WHERE ended_at=0
    ) UPDATE room_waits SET ended_at=next_waits.superseded_at,end_reason='superseded'
        FROM next_waits WHERE room_waits.id=next_waits.id AND next_waits.superseded_at IS NOT NULL""")


def init_database(database, seed=True):
    """Create durable storage; seed only a brand-new database when requested."""
    database = Path(database)
    is_new = not database.exists()
    database.parent.mkdir(parents=True, exist_ok=True)
    with closing(connect_db(database)) as connection:
        with connection:
            if is_new:
                connection.execute("PRAGMA auto_vacuum = INCREMENTAL")
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
            # The goal-changed trigger in the schema reads these columns, so they must exist before it is created.
            if "room_goals" in tables:
                columns = {row[1] for row in connection.execute("PRAGMA table_info(room_goals)")}
                for name, kind in GOAL_PHASE_COLUMNS:
                    if name not in columns:
                        connection.execute(f"ALTER TABLE room_goals ADD COLUMN {name} {kind}")
            if "attachments" in tables:
                columns = {row[1] for row in connection.execute("PRAGMA table_info(attachments)")}
                for column in ("storage", "object_name", "stored_at"):
                    if column not in columns:
                        connection.execute(f"ALTER TABLE attachments ADD COLUMN {column} TEXT")
            if "cloud_files" in tables:
                columns = {row[1] for row in connection.execute("PRAGMA table_info(cloud_files)")}
                # The transfer deadline index needs these columns before the schema is applied.
                for name, declaration in (("purpose", "TEXT NOT NULL DEFAULT 'keep'"),
                                          ("expires_at", "TEXT"), ("source_version", "TEXT"), *cloud_drive.CLOUD_FILE_MIGRATIONS):
                    if name not in columns:
                        connection.execute(f"ALTER TABLE cloud_files ADD COLUMN {name} {declaration}")
            migrate_room_waits(connection, tables)
            moss_results.migrate_delegations(connection)
            connection.executescript(SCHEMA + cloud_shares.SCHEMA)
            migrate_guest_cancel_reasons(connection)
            if "redirect_message_id" not in {row[1] for row in connection.execute("PRAGMA table_info(dispatch_withdrawals)")}:
                connection.execute("ALTER TABLE dispatch_withdrawals ADD COLUMN redirect_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL")
            migrate_dispatch_withdrawals(connection)
            if 'member' not in {row[1] for row in connection.execute('PRAGMA table_info(message_relays)')}:
                connection.execute("ALTER TABLE message_relays ADD COLUMN member TEXT NOT NULL DEFAULT ''")
            connection.execute("DELETE FROM room_links WHERE relation='peer'")
            relay_columns = {row[1] for row in connection.execute("PRAGMA table_info(message_relays)")}
            if "expect" not in relay_columns:
                connection.execute("ALTER TABLE message_relays ADD COLUMN expect TEXT NOT NULL DEFAULT 'reply'")
            if "reply_to" not in relay_columns:
                connection.execute("ALTER TABLE message_relays ADD COLUMN reply_to INTEGER")
            if "state" not in {row[1] for row in connection.execute("PRAGMA table_info(room_relay_sends)")}:
                connection.execute("ALTER TABLE room_relay_sends ADD COLUMN state TEXT NOT NULL DEFAULT 'delivered'")
                connection.execute("UPDATE room_relay_sends SET state='queued' WHERE queued_id IS NOT NULL AND target_message_id IS NULL")
            share_columns = {row[1] for row in connection.execute("PRAGMA table_info(room_share_links)")}
            for name in ("card_json", "card_edits"):
                if name not in share_columns:
                    connection.execute(f"ALTER TABLE room_share_links ADD COLUMN {name} TEXT NOT NULL DEFAULT '{{}}'")
            directory_columns = {row[1] for row in connection.execute("PRAGMA table_info(room_directory)")}
            if "destroy_after_days" not in directory_columns:
                connection.execute("ALTER TABLE room_directory ADD COLUMN destroy_after_days INTEGER NOT NULL DEFAULT 0")
            if "destroy_set_at" not in directory_columns:
                connection.execute("ALTER TABLE room_directory ADD COLUMN destroy_set_at TEXT NOT NULL DEFAULT ''")
            # A child room the user lifted out of its parent in the directory; the parent link itself is kept.
            if "detached" not in directory_columns:
                connection.execute("ALTER TABLE room_directory ADD COLUMN detached INTEGER NOT NULL DEFAULT 0")
            # A pinned room keeps its place but can be neither archived nor destroyed, by hand or automatically.
            if "pinned" not in directory_columns:
                connection.execute("ALTER TABLE room_directory ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0")
            if "system_kind" not in directory_columns:
                connection.execute("ALTER TABLE room_directory ADD COLUMN system_kind TEXT NOT NULL DEFAULT ''")
            if "directories" not in {row[1] for row in connection.execute("PRAGMA table_info(topic_folders)")}:
                connection.execute("ALTER TABLE topic_folders ADD COLUMN directories TEXT NOT NULL DEFAULT '[]'")
            # Images stored before sizes were recorded keep NULL here and are measured when first read (with_image_sizes).
            attachment_columns = {row[1] for row in connection.execute("PRAGMA table_info(attachments)")}
            for name in ("width", "height"):
                if name not in attachment_columns:
                    connection.execute(f"ALTER TABLE attachments ADD COLUMN {name} INTEGER")
            if "thumbnail_type" not in attachment_columns:
                connection.execute("ALTER TABLE attachments ADD COLUMN thumbnail_type TEXT")
            if "cleared_at" not in attachment_columns:
                connection.execute("ALTER TABLE attachments ADD COLUMN cleared_at TEXT")
            if connection.execute("INSERT OR IGNORE INTO site_preferences (key,value) VALUES ('child_folders_migrated','1')").rowcount:
                connection.execute("""UPDATE room_folder_assignments AS child SET folder_id=parent.folder_id
                    FROM room_links l JOIN room_folder_assignments parent ON parent.room_id=l.other_room_id
                    WHERE l.relation='parent' AND child.room_id=l.room_id
                    AND child.folder_id IS NULL AND parent.folder_id IS NOT NULL""")
            migrate_free_tables(connection)
            if seed and is_new:
                seed_demo(connection)
        if not is_new:
            try:
                if reclaim_database_space(connection):
                    connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            except sqlite3.OperationalError:
                logging.warning("Database space reclamation skipped on startup", exc_info=True)


def room_display_texts(connection, room):
    """Expose seed templates only while their original fields remain unchanged."""
    return {field: payload for field, payload in load_texts(connection, "room", room["id"]).items()
            if field in room and str(Text(payload["template"], **payload["params"])) == room[field]}


PARENT_ROOM = """SELECT p.id FROM room_links l JOIN rooms p ON p.id=l.other_room_id
    WHERE l.relation='parent' AND l.room_id=rooms.id ORDER BY l.message_id LIMIT 1"""


def steward_archived_at(connection, room_id):
    """Read when the current archive period began, or null if no archive event was recorded."""
    row = connection.execute("""SELECT strftime('%Y-%m-%dT%H:%M:%fZ',at/1000.0,'unixepoch') FROM room_events
        WHERE room_id=:room_id AND kind='api.write' AND json_extract(data,'$.path')='/archive'
          AND id>COALESCE((SELECT MAX(id) FROM room_events WHERE room_id=:room_id
              AND kind='api.write' AND json_extract(data,'$.path')='/restore'),0)
        ORDER BY id LIMIT 1""", {"room_id": room_id}).fetchone()
    return row[0] if row else None


def require_room(connection, room_id):
    """Return a room and its current message count, or raise a lookup error."""
    row = connection.execute(f"""SELECT rooms.*, ({PARENT_ROOM}) AS parent_room_id,
        COALESCE(stats.message_count,0) AS message_count,COALESCE(stats.latest_id,0) AS latest_id
        FROM rooms LEFT JOIN room_message_stats stats ON stats.room_id=rooms.id WHERE rooms.id=? GROUP BY rooms.id""", (room_id,)).fetchone()
    if row is None:
        raise LookupError(Text('房间不存在'))
    if enforce_session_limits(connection, room_id):
        connection.commit()
        row = connection.execute(f"""SELECT rooms.*, ({PARENT_ROOM}) AS parent_room_id,
            COALESCE(stats.message_count,0) AS message_count,COALESCE(stats.latest_id,0) AS latest_id
            FROM rooms LEFT JOIN room_message_stats stats ON stats.room_id=rooms.id WHERE rooms.id=? GROUP BY rooms.id""", (room_id,)).fetchone()
    room = dict(row)
    room["texts"] = room_display_texts(connection, room)
    directory = connection.execute("SELECT archived,detached,pinned,system_kind FROM room_directory WHERE room_id=?", (room_id,)).fetchone()
    room["archived"], room["detached"], room["pinned"] = bool(directory[0]), bool(directory[1]), bool(directory[2])
    room["system_kind"] = directory["system_kind"]
    room["preset"] = "task" if connection.execute("SELECT 1 FROM moss_task_rooms WHERE room_id=?", (room_id,)).fetchone() else ""
    if room["system_kind"] == "steward" and room["archived"]:
        room["archived_at"] = steward_archived_at(connection, room_id)
    room["folder_id"] = connection.execute("SELECT folder_id FROM room_folder_assignments WHERE room_id=?", (room_id,)).fetchone()[0]
    # The number the next sent file takes, so the composer shows `[图片 #n]` as it will be saved. Queued messages post
    # first and take the numbers before it, so a new draft does not repeat a queued message's `[图片 #n]`.
    queued_files = sum(len(json.loads(row[0]).get("attachment_ids") or []) for row in
                       connection.execute("SELECT payload FROM queued_messages WHERE room_id=?", (room_id,)))
    room["next_attachment_number"] = attachment_number_before(connection, room_id, None) + queued_files
    # Bytes of this room's stored files (sent and not-yet-sent uploads), shown beside the draft meter on the room page.
    room["attachment_bytes"] = connection.execute(
        "SELECT COALESCE(SUM(size),0) FROM attachments WHERE room_id=? AND cleared_at IS NULL", (room_id,)).fetchone()[0]
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
        COALESCE(r.registered_at,'') AS registered_at,COALESCE(c.image_model,'') AS image_model
        FROM room_members AS m LEFT JOIN member_sessions AS s ON s.member_id=m.id
        LEFT JOIN member_registrations AS r ON r.member_id=m.id AND r.token_hash=m.token_hash
        LEFT JOIN member_capabilities AS c ON c.member_id=m.id
        WHERE m.room_id=? AND m.status<>'removed' ORDER BY m.id""", (room_id,))]
    # Members are called by label in text and in @; the ID (name) is part of the full record, like the description.
    shown = member_display_names(connection, room_id)
    room["members"] = [{"label": shown.get(member["name"], member["name"]), **member} for member in room["members"]]
    option = connection.execute("SELECT named_followup FROM session_options WHERE session_id=?", (session["id"],)).fetchone() if session else None
    # Before any discussion the host keeps its named follow-ups.
    room["named_followup"] = bool(option[0]) if option else True
    room["scheduler_decisions"] = scheduler_decisions(connection, room_id)
    room["scheduler_routing"] = [row[0] for row in connection.execute(
        "SELECT message_id FROM scheduler_routing WHERE room_id=? AND created_at>? ORDER BY message_id", (room_id, int(time.time()) - ROUTING_VISIBLE_SECONDS))]
    room["host_arrangements"] = host_arrangements(connection, room_id, room["scheduler_decisions"])
    room["cancelled_turns"] = cancelled_turns(connection, room_id)
    room["free"] = free_view(connection, room_id)
    external_fields = {member["id"]: member.get("external") for member in room["free"]["members"] if member["access"] == "external"}
    for member in room["members"]:
        if member["id"] in external_fields:
            member["external"] = external_fields[member["id"]]
    room["goal_state"] = goal_view(connection, room_id)
    # Where the room's own task starts when no goal was set: the owner's first message (COVERAGE 3③).
    first = connection.execute("SELECT MIN(id) FROM messages WHERE room_id=? AND author='用户'", (room_id,)).fetchone()[0]
    room["first_user_message_id"] = first
    room["descriptions"] = member_descriptions(connection, room_id)
    room["labels"] = {**member_labels(connection, room_id), **guest_display_names(connection, room_id)}
    for member in room["members"]:
        label_text = default_label_text(member["name"], member["label"])
        if label_text:
            member["texts"] = {"label": label_text}
    for name, label in room["labels"].items():
        label_text = default_label_text(name, label)
        if label_text:
            room["texts"][f"labels.{name}"] = label_text
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


def span_end(span):
    """The inclusive upper message id of a `history_cards` span; None means no end."""
    return MAX_MESSAGE_ID if span[1] is None else span[1]


def scheduler_decisions(connection, room_id, span=None):
    """The room's recent smart-scheduling decisions with their detail, oldest first; `span` as in `history_cards`."""
    if span:
        rows = connection.execute(f"{DECISION_SELECT} WHERE d.room_id=? AND d.after_message_id>? AND d.after_message_id<=? ORDER BY d.id",
                                  (room_id, span[0], span_end(span)))
    else:
        rows = connection.execute(f"{DECISION_SELECT} WHERE d.room_id=? ORDER BY d.id DESC LIMIT ?", (room_id, RECENT_DECISIONS))
    decisions = sorted((dict(row) for row in rows), key=lambda item: item["id"])
    details = {row[0]: json.loads(row[1]) for row in connection.execute(
        "SELECT decision_id,detail FROM scheduler_decision_details WHERE decision_id IN (SELECT value FROM json_each(?))",
        (json.dumps([item["id"] for item in decisions]),))}
    for decision in decisions:
        decision["detail"] = details.get(decision["id"])
        decision["texts"] = load_texts(connection, "decision", decision["id"])
    return decisions


def history_cards(connection, room_id, span):
    """The cards placed after messages in `span` (low, high]; high None runs to the end.

    The room view carries only the recent executions, plans, missed turns and decisions; the transcript reads the rest
    with each batch of messages, so older cards stay where they were instead of disappearing.
    """
    decisions = scheduler_decisions(connection, room_id, span)
    return {"executions": recent_executions(connection, room_id, span), "scheduler_decisions": decisions,
            "host_arrangements": host_arrangements(connection, room_id, decisions, span),
            "cancelled_turns": cancelled_turns(connection, room_id, span),
            "failure_wakes": room_failure_wakes(connection, room_id, span),
            "quiet_checkins": room_quiet_checkins(connection, room_id, span)}


def host_arrangements(connection, room_id, decisions, span=None):
    """Each plan the host created in the room's discussions, anchored where its task appeared; `span` as in `history_cards`.

    Invitations are not plans, and a plan the smart scheduler applied is already shown by its own decision.
    """
    plans = session_host_arrangements(connection, room_id)
    if span:
        plans = [plan for plan in plans if span[0] < plan["after_message_id"] <= span_end(span)]
    applied = {item["after_message_id"] for item in decisions if item["applied"]}
    plans = [plan for plan in plans if plan["after_message_id"] not in applied]
    plans.sort(key=lambda plan: (plan["created_at"], plan["after_message_id"], str(plan["id"])))
    return plans if span else plans[-RECENT_DECISIONS:]


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


def cancelled_turns(connection, room_id, span=None):
    """Discussion assignments that ended without an answer, anchored where their task appeared; `span` as in `history_cards`."""
    result = []
    query = """SELECT q.id,q.session_id,q.question,q.status,q.created_at,m.name AS expert,r.execution_id,
        (SELECT e.created_at FROM member_executions e WHERE e.id=r.execution_id) AS layout_at,
        'session-'||q.session_id||'-request-'||q.id AS key,
        (SELECT COALESCE(MAX(a.id),0) FROM messages a WHERE a.room_id=? AND a.id<r.message_id
            AND NOT EXISTS(SELECT 1 FROM internal_task_messages t WHERE t.message_id=a.id)) AS after_message_id
        FROM session_requests q JOIN room_members m ON m.id=q.member_id
        JOIN member_requests r ON r.id=q.member_request_id
        WHERE q.session_id IN (SELECT id FROM discussion_sessions WHERE room_id=?) AND q.purpose='discuss'
          AND q.status IN ('cancelled','skipped') AND q.member_request_id IS NOT NULL AND r.answer_id IS NULL
          AND NOT EXISTS(SELECT 1 FROM member_executions e WHERE e.id=r.execution_id AND e.status='failed')"""
    order = "ORDER BY created_at DESC,after_message_id DESC,key DESC"
    rows = (connection.execute(f"SELECT * FROM ({query}) WHERE after_message_id>? AND after_message_id<=? {order}",
                               (room_id, room_id, span[0], span_end(span))) if span
            else connection.execute(f"SELECT * FROM ({query}) {order} LIMIT ?", (room_id, room_id, RECENT_DECISIONS)))
    for row in rows:
        result.append({"id": row["key"], "key": row["key"], "display_id": row["id"],
            "expert": row["expert"], "question": row["question"], "status": row["status"],
            "execution_id": row["execution_id"], "layout_at": row["layout_at"],
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
    from .free_room import REGISTERED_MEMBER
    active_experts = connection.execute(f"""SELECT COUNT(*) FROM room_members
        WHERE room_id=? AND status='active' AND role<>'host' AND {REGISTERED_MEMBER}""", (room_id,)).fetchone()[0]
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
    return Text("待处理（本地 CLI）") if room["experts"].get(expert) == "cli" else Text("待处理")


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
            raise ValueError(Text('{value1} 内容为空或超过 {value2} 字', value1=field, value2=limit))
    result["host"] = payload.get("host", result["host"])
    result["experts"] = payload.get("experts", result["experts"])
    experts = result["experts"]
    if (not isinstance(experts, dict) or len(experts) > MAX_ROOM_AGENTS
            or any(not is_ai(name) or mode != "cli" for name, mode in experts.items())):
        raise ValueError(Text('专家需为有效 AI 身份，参与方式为 cli'))
    if result["host"] != "用户" and experts.get(result["host"]) != "cli":
        raise ValueError(Text('AI 主持人必须是可读可写的本地 CLI 参与者'))
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
        raise ValueError(Text('请使用当前主持人或用户身份管理话题'))


def update_topic(connection, room_id, payload):
    """Update the title, goal and topic material through a declared host action; members change through member management."""
    begin_write(connection)
    room = require_room(connection, room_id)
    require_host(room, payload)
    if "phase" in payload:
        raise ValueError(Text('房间的讨论阶段由 discussion 会话控制'))
    if room["archived"]:
        raise ValueError(Text('房间已存档；恢复后才能修改话题资料'))
    settings = topic_values(payload, room)
    if settings["host"] != room["host"] or settings["experts"] != room["experts"] or payload.get("members"):
        raise ValueError(Text('主持人与成员请通过成员管理操作调整'))
    if "limits" in payload:
        if current_session(connection, room_id, active_only=True):
            raise ValueError(Text('新讨论的上限请通过 limits 接口修改'))
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
        raise ValueError(Text('submission_id 必须是 8–100 位字母、数字、下划线或连字符'))
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
        raise LookupError(Text('房间不存在'))
    now = int(time.time())
    return {"revision": row["revision"], "executions": [
        {**execution, "stale": execution["lease_until"] <= now} for execution in json.loads(row["executions"])]}


def list_rooms(connection, params=None):
    """Return rooms, optionally locating a single persisted creation request."""
    params = params or {}
    identifier = submission_value(params["submission_id"]) if "submission_id" in params else None
    where = "WHERE EXISTS (SELECT 1 FROM room_creations WHERE room_id=rooms.id AND submission_id=:submission_id)" if identifier else ""
    rows = connection.execute(f"""SELECT rooms.*, ({PARENT_ROOM}) AS parent_room_id,
        COALESCE(stats.message_count,0) AS message_count,COALESCE(stats.latest_id,0) AS latest_id,
        (SELECT created_at FROM messages WHERE id=stats.latest_id) AS latest_at,
        (SELECT m.created_at FROM messages m WHERE m.room_id=rooms.id AND m.source<>'system'
            AND m.author NOT IN ('系统','系统任务')
            AND NOT EXISTS (SELECT 1 FROM message_withdrawals w WHERE w.message_id=m.id)
            ORDER BY m.id DESC LIMIT 1) AS latest_speech_at,
        EXISTS (SELECT 1 FROM member_executions e WHERE e.room_id=rooms.id
            AND e.status IN ('dispatched','started') AND e.lease_until>:now) AS running,
        {ROOM_ATTENTION_SQL} AS attention,
        CASE WHEN EXISTS(SELECT 1 FROM moss_task_rooms t WHERE t.room_id=rooms.id) THEN 'task' ELSE '' END AS preset,
        {ROOM_WAITING_SINCE_SQL} AS waiting_user_since
        FROM rooms LEFT JOIN room_message_stats stats ON stats.room_id=rooms.id {where}
        GROUP BY rooms.id ORDER BY rooms.created_at, rooms.id""", {"now": int(time.time()), "submission_id": identifier})
    directory = {row["room_id"]: dict(row) for row in connection.execute("SELECT * FROM room_directory")}
    assignments = {row["room_id"]: row["folder_id"] for row in connection.execute("SELECT room_id,folder_id FROM room_folder_assignments")}
    # Only the public part of a share link, expired ones too (the share site keeps them renewable until the operator
    # purges them); the manage token stays behind the owner-only share-link read.
    links = {row["room_id"]: {"url": row["url"], "expires_at": row["expires_at"]} for row in connection.execute(
        "SELECT room_id,url,expires_at FROM room_share_links")}
    rooms = [{**dict(row), "archived": bool(directory[row["id"]]["archived"]), "detached": bool(directory[row["id"]]["detached"]),
              "pinned": bool(directory[row["id"]]["pinned"]), "running": bool(row["running"]),
              "attention": "" if directory[row["id"]]["archived"] else row["attention"] or ("running" if row["running"] else ""),
              "system_kind": directory[row["id"]]["system_kind"],
              "destroy_after_days": directory[row["id"]]["destroy_after_days"], "destroy_from": destroy_from(connection, dict(row), directory[row["id"]]) if directory[row["id"]]["destroy_after_days"] else None,
              "destroy_blocked": destroy_blocked(connection, row["id"]) if directory[row["id"]]["destroy_after_days"] else False,
              "folder_id": assignments[row["id"]], "texts": room_display_texts(connection, dict(row)),
              "share_link": links.get(row["id"])} for row in rows]
    return {"rooms": sorted(rooms, key=lambda room: directory[room["id"]]["position"]),
            **folder_directory(connection)}


SHARE_ID = re.compile(r"[A-Za-z0-9_-]{22}")
SHARE_TOKEN = re.compile(r"[A-Za-z0-9_-]{20,200}")
SHARE_URL_MAX = 300
# The official share site (web/app.js SHARE_SITE); a link kept with a room must point there.
SHARE_SITE_HOST = "share.codiscuss.com"


def utc_iso_now():
    """Now as the share site writes times: ISO 8601 in UTC with milliseconds, so strings compare in time order."""
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def share_link_record(connection, room_id):
    """The room's share link with its manage token, expired ones too (renewable until purged), or None."""
    require_room(connection, room_id)
    row = connection.execute("SELECT share_id,url,manage_token,expires_at,updated_at FROM room_share_links "
                             "WHERE room_id=?", (room_id,)).fetchone()
    return {"link": dict(row) if row else None}


def save_share_link(connection, room_id, payload):
    """Keep the room's share link as the share site gave it, or forget it when `link` is null (revoked or gone)."""
    require_room(connection, room_id)
    link = payload.get("link")
    if link is None:
        connection.execute("DELETE FROM room_share_links WHERE room_id=?", (room_id,))
        return {"link": None}
    if not isinstance(link, dict):
        raise ValueError(Text('分享链接格式不正确'))
    share_id, url, token, expires = (link.get(key) for key in ("share_id", "url", "manage_token", "expires_at"))
    valid = (isinstance(share_id, str) and SHARE_ID.fullmatch(share_id) and isinstance(token, str) and SHARE_TOKEN.fullmatch(token)
             and isinstance(url, str) and len(url) <= SHARE_URL_MAX and url == f"https://{SHARE_SITE_HOST}/s/{share_id}"
             and isinstance(expires, str) and re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z", expires))
    if not valid:
        raise ValueError(Text('分享链接格式不正确'))
    card = link.get("card")
    if card is not None and not isinstance(card, dict):
        raise ValueError(Text('分享链接格式不正确'))
    connection.execute("""INSERT INTO room_share_links (room_id,share_id,url,manage_token,expires_at,updated_at,card_json) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(room_id) DO UPDATE SET share_id=excluded.share_id,url=excluded.url,manage_token=excluded.manage_token,
        expires_at=excluded.expires_at,updated_at=excluded.updated_at,
        card_edits=CASE WHEN share_id=excluded.share_id THEN card_edits ELSE '{}' END,
        card_json=CASE WHEN share_id=excluded.share_id AND excluded.card_json='{}' THEN card_json ELSE excluded.card_json END""",
                       (room_id, share_id, url, token, expires, utc_iso_now(), json.dumps(card or {})))
    return share_link_record(connection, room_id)


SHARE_CARD_RECEIPT = re.compile(
    r"^(?:(?:回答问题\s*#?\d+|Answer to question #\d+)(?:[：:]|$)"
    r"|(?:请主持人先讨论并给推荐|交给主持人决定)（问题 #\d+）$"
    r"|(?:Host, please discuss and recommend first|Leaving it to the host to decide) \(question #\d+\)$)",
    re.IGNORECASE,
)
SHARE_CARD_SHORT_ACK = re.compile(
    r"^/?(?:继续|好的?|行|ok|yes|收到|同意|开始|可以|确认|嗯|明白|go|continue)[。.!！,，\s]*$",
    re.IGNORECASE,
)
SHARE_CARD_SLASH = re.compile(r"^/(?:goal|discuss)\b", re.IGNORECASE)
SHARE_CARD_SENTENCE = re.compile(r"[^。！？.!?]+(?:[。！？]|[.!?](?=\s|$)|$)")
SHARE_CARD_COPY_FENCE = re.compile(r"```share-copy[ \t]*\r?\n([\s\S]*?)\r?\n```")
SHARE_CARD_SENSITIVE = re.compile(
    r"\bsk[-_](?:live_)?[A-Za-z0-9_-]{20,}|\bgh[pousr]_[A-Za-z0-9]{30,}|\bAIza[0-9A-Za-z_-]{30,}"
    r"|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/-]{20,}"
    r"|\b[\w.+-]+@[\w-]+\.[\w.-]+\b|(?<!\d)1[3-9]\d{9}(?!\d)"
)


def _is_share_question_receipt(text):
    """Identify question-card receipts that should not be used as the room's opening question."""
    heading = str(text or "").lstrip().split("\n", 1)[0].rstrip()
    return bool(SHARE_CARD_RECEIPT.match(heading))


def _share_card_lead(text, max_chars=160):
    """Extract one concise lead sentence (or two short ones) from the opening paragraph."""
    raw = str(text or "").replace("\r\n", "\n").strip()
    if not raw or SHARE_CARD_SENSITIVE.search(raw):
        return ""
    first_para = re.split(r"\n\s*\n|\n\s*(?:[-*•]|\d+[.)、])\s+", raw, maxsplit=1)[0]
    plain = re.sub(r"```[\s\S]*?```", " ", first_para)
    plain = re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", plain)
    plain = re.sub(r"[`*_>#|~-]+", " ", plain)
    plain = re.sub(r"\s+", " ", plain).strip()
    plain = re.sub(r"^(?:@\S+\s+)+", "", plain).strip()
    if not plain:
        return ""
    sentences = [match.group(0).strip() for match in SHARE_CARD_SENTENCE.finditer(plain) if match.group(0).strip()]
    if not sentences:
        return plain[:max_chars]
    first = sentences[0]
    if len(first) < 10 and len(sentences) > 1:
        joiner = " " if re.search(r"[a-zA-Z0-9.!?]$", first) else ""
        two = f"{first}{joiner}{sentences[1]}"
        if len(two) <= max_chars:
            return two
    return first[:max_chars]


def _extract_share_copy(text):
    """Return the companion ```share-copy``` block from a room message, or empty string."""
    match = SHARE_CARD_COPY_FENCE.search(str(text or ""))
    return match.group(1).strip() if match else ""


def _auto_share_card_defaults(connection, room_id):
    """Compute fresh, clean automatic share-card text from the room's non-withdrawn public messages."""
    room = connection.execute("SELECT title FROM rooms WHERE id=?", (room_id,)).fetchone()
    title = room["title"] if room else ""
    member_rows = connection.execute(
        "SELECT name FROM room_members WHERE room_id=? AND status!='removed' ORDER BY id",
        (room_id,),
    ).fetchall()
    members = [row["name"] for row in member_rows]
    msg_rows = connection.execute(
        """SELECT m.id, m.author, COALESCE(md.kind, 'chat') AS kind, m.text, COALESCE(ms.text, '') AS summary
           FROM messages m
           LEFT JOIN message_details md ON md.message_id=m.id
           LEFT JOIN message_summaries ms ON ms.message_id=m.id
           WHERE m.room_id=? AND COALESCE(md.kind, 'chat')!='system' AND COALESCE(m.text,'')!=''
             AND NOT EXISTS (SELECT 1 FROM message_withdrawals w WHERE w.message_id=m.id)
           ORDER BY m.id ASC""",
        (room_id,),
    ).fetchall()
    question_msg = None
    for msg in msg_rows:
        if msg["author"] != "用户":
            continue
        body = (msg["text"] or "").strip()
        if not body or _is_share_question_receipt(body) or SHARE_CARD_SLASH.match(body) or SHARE_CARD_SHORT_ACK.match(body):
            continue
        question_msg = msg
        break
    after_id = question_msg["id"] if question_msg else 0
    answers = [msg for msg in msg_rows if msg["author"] not in ("用户", "系统") and msg["id"] > after_id]
    outcome_msg = next((msg for msg in reversed(answers) if (msg["summary"] or "").strip()), None) or (answers[-1] if answers else None)
    runs_row = connection.execute("SELECT COUNT(*) FROM member_executions WHERE room_id=?", (room_id,)).fetchone()
    runs = int(runs_row[0]) if runs_row else 0
    return {
        "title": title,
        "members": members,
        "question": _share_card_lead(question_msg["text"], 160) if question_msg else "",
        "outcome": _share_card_lead(outcome_msg["summary"] or outcome_msg["text"], 200) if outcome_msg else "",
        "stats": f"{len(members)} 位 AI · {len(msg_rows)} 条消息 · {runs} 次执行",
        "card_version": 2,
    }


def read_share_card(connection, room_id):
    """Read the live link's cover, upgraded automatic defaults, active product sites and room images."""
    now_iso = utc_iso_now()
    row = connection.execute("""SELECT share_id,url,expires_at,card_json,card_edits FROM room_share_links
        WHERE room_id=? AND expires_at>?""", (room_id, now_iso)).fetchone()
    if not row:
        raise LookupError(Text("分享链接已失效"))
    saved_card = json.loads(row["card_json"]) if row["card_json"] else {}
    saved_edits = json.loads(row["card_edits"]) if row["card_edits"] else {}
    auto = _auto_share_card_defaults(connection, room_id)
    base_card = dict(saved_card)
    old_version = int(saved_card.get("card_version") or 0) < 2
    saved_question = str(saved_card.get("question") or "").strip()
    if auto["question"] and (old_version or not saved_question or _is_share_question_receipt(saved_question)):
        base_card["question"] = auto["question"]
    if auto["outcome"] and (old_version or not str(saved_card.get("outcome") or "").strip()):
        base_card["outcome"] = auto["outcome"]
    if auto["question"] or auto["outcome"]:
        if not base_card.get("title") and auto["title"]:
            base_card["title"] = auto["title"]
        if not base_card.get("members") and auto["members"]:
            base_card["members"] = auto["members"]
        if not base_card.get("stats") and auto["stats"]:
            base_card["stats"] = auto["stats"]
    images_rows = connection.execute("""SELECT a.id,a.file_name,a.message_id,a.room_id,m.text AS message_text
        FROM attachments a
        LEFT JOIN messages m ON m.id=a.message_id
        WHERE a.room_id=? AND a.message_id IS NOT NULL AND a.content_type IN ('image/png','image/jpeg','image/webp')
        AND NOT EXISTS (SELECT 1 FROM message_withdrawals w WHERE w.message_id=a.message_id)
        ORDER BY a.message_id DESC,a.position""", (room_id,))
    images = []
    for image in images_rows:
        item = {"id": image["id"], "file_name": image["file_name"],
                "message_id": image["message_id"], "room_id": image["room_id"]}
        copy_text = _extract_share_copy(image["message_text"])
        if copy_text:
            item["share_copy"] = copy_text
        images.append(item)
    site_rows = connection.execute(
        "SELECT * FROM room_sites WHERE room_id=? ORDER BY updated_at DESC", (room_id,)
    )
    sites = [
        {"site_id": s["site_id"], "title": s["title"], "url": s["url"], "expires_at": s["expires_at"]}
        for s in (_site_public_row(r, now_iso) for r in site_rows)
        if s["status"] == "active"
    ]
    return {"share_id": row["share_id"], "url": row["url"], "expires_at": row["expires_at"],
            "card": {**base_card, **saved_edits},
            "defaults": {"question": auto["question"], "outcome": auto["outcome"]},
            "sites": sites,
            "images": images}


def edit_share_card(connection, room_id, payload):
    """Patch only the edited fields of this share, including across concurrent owner devices."""
    if "publication" in payload:
        return finish_share_card_upload(connection, room_id, payload)
    edits = payload.get("edits")
    if not isinstance(edits, dict) or not edits or edits.keys() - {"question", "outcome", "cover", "copy"}:
        raise ValueError(Text("分享卡格式不正确"))
    for key, value in edits.items():
        if value is None and key in ("question", "outcome", "copy"):
            continue
        limit = 4000 if key == "copy" else 2000
        if not isinstance(value, str) or (key != "cover" and len(value) > limit):
            raise ValueError(Text("分享卡格式不正确"))
        if key == "cover" and value and not re.fullmatch(r"data:image/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+=*",
                                                         value):
            raise ValueError(Text("分享卡格式不正确"))
    updated = connection.execute("""UPDATE room_share_links SET card_edits=json_patch(card_edits,?)
        WHERE room_id=? AND share_id=? AND expires_at>?""",
                                 (json.dumps(edits, ensure_ascii=False), room_id, payload.get("share_id"), utc_iso_now()))
    if not updated.rowcount:
        raise FileExistsError(Text("分享链接已失效"))
    return {"ok": True}


def finish_share_card_upload(connection, room_id, payload):
    """Attach confirmed upload counts to the exact publication that started the work."""
    progress = payload["publication"]
    if not isinstance(progress, dict):
        raise ValueError(Text("分享卡格式不正确"))
    revision, done = progress.get("revision"), progress.get("done")
    if not isinstance(revision, str) or not SHARE_ID.fullmatch(revision) or type(done) is not int or done < 0:
        raise ValueError(Text("分享卡格式不正确"))
    updated = connection.execute("""UPDATE room_share_links
        SET card_json=json_set(card_json,'$.publication.done', ?)
        WHERE room_id=? AND share_id=? AND expires_at>?
          AND json_extract(card_json,'$.publication.revision')=?
          AND json_extract(card_json,'$.publication.total')>=?
          AND COALESCE(json_extract(card_json,'$.publication.done'), -1)<=?""",
        (done, room_id, payload.get("share_id"), utc_iso_now(), revision, done, done))
    return {"ok": True, "recorded": bool(updated.rowcount)}


SITE_ID_PATTERN = re.compile(r"[a-z2-7]{10}")
STAGE_ID_PATTERN = re.compile(r"[a-zA-Z0-9_-]{8,64}")
SITE_STATUSES = ("active", "expired", "taken_down", "revoked")


def _json_list(raw):
    try:
        parsed = json.loads(raw or "[]")
        return parsed if isinstance(parsed, list) else []
    except ValueError:
        return []


def _site_public_row(row, now_iso):
    status = row["status"]
    if status == "active" and row["expires_at"] and row["expires_at"] <= now_iso:
        status = "expired"
    result = {
        "site_id": row["site_id"], "room_id": row["room_id"], "message_id": row["message_id"],
        "execution_id": row["execution_id"], "member": row["member"], "title": row["title"],
        "url": row["url"], "directory": row["directory"],
        "current_version": row["current_version"], "previous_version": row["previous_version"],
        "file_count": row["file_count"], "bytes": row["bytes"], "status": status,
        "versions": _json_list(row["versions_json"]), "files": _json_list(row["files_json"]),
        "expires_at": row["expires_at"], "created_at": row["created_at"], "updated_at": row["updated_at"],
    }
    # Expired by time only: website hosting keeps its files until the operator purges them, so it can still be renewed.
    if status == "expired" and row["status"] == "active":
        result["renewable"] = True
    if "room_title" in row.keys():
        result["room_title"] = row["room_title"]
    return result


def _stage_public_row(row):
    return {
        "stage_id": row["id"], "room_id": row["room_id"], "execution_id": row["execution_id"],
        "message_id": row["message_id"], "member": row["member"], "title": row["title"],
        "directory": row["directory"], "kind": row["kind"], "file_count": row["file_count"],
        "bytes": row["bytes"], "ready": bool(row["ready"]), "site_id": row["site_id"] or None,
        "files": _json_list(row["files_json"]), "spots": _json_list(row["spots_json"]),
        "rejected_files": _json_list(row["rejected_json"]),
        "created_at": row["created_at"], "updated_at": row["updated_at"],
    }


def list_room_sites(connection, room_id):
    """Public metadata of deployed websites and staged directories in one room (never exposes device_token)."""
    require_room(connection, room_id)
    now_iso = utc_iso_now()
    sites = [_site_public_row(row, now_iso) for row in connection.execute(
        "SELECT * FROM room_sites WHERE room_id=? ORDER BY updated_at DESC", (room_id,))]
    stages = [_stage_public_row(row) for row in connection.execute(
        "SELECT * FROM room_site_stages WHERE room_id=? ORDER BY updated_at DESC LIMIT 50", (room_id,))]
    return {"room_id": room_id, "sites": sites, "stages": stages}


def list_all_sites(connection):
    """Public metadata of deployed websites across all rooms for the left sidebar published list."""
    now_iso = utc_iso_now()
    rows = connection.execute(
        """SELECT s.*, r.title AS room_title FROM room_sites s JOIN rooms r ON r.id=s.room_id
           ORDER BY s.updated_at DESC LIMIT 200""")
    return {"sites": [_site_public_row(row, now_iso) for row in rows]}


def save_room_site(connection, room_id, payload):
    """Persist public website or stage metadata written by local runner commands; never accepts device_token."""
    require_room(connection, room_id)
    if not isinstance(payload, dict) or "device_token" in payload:
        raise ValueError("Invalid site payload")
    action = payload.get("action")
    now_iso = utc_iso_now()
    if action == "stage":
        stage_id = str(payload.get("stage_id") or "")
        if not STAGE_ID_PATTERN.fullmatch(stage_id):
            raise ValueError("Invalid stage_id")
        kind = payload.get("kind") or "directory"
        if kind not in ("directory", "file"):
            raise ValueError("Invalid stage kind")
        connection.execute(
            """INSERT INTO room_site_stages
               (id,room_id,execution_id,message_id,member,title,directory,kind,file_count,bytes,files_json,spots_json,rejected_json,ready,site_id,created_at,updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(id) DO UPDATE SET
               execution_id=excluded.execution_id,message_id=excluded.message_id,member=excluded.member,
               title=excluded.title,directory=excluded.directory,kind=excluded.kind,file_count=excluded.file_count,
               bytes=excluded.bytes,files_json=excluded.files_json,spots_json=excluded.spots_json,
               rejected_json=excluded.rejected_json,ready=excluded.ready,site_id=excluded.site_id,updated_at=excluded.updated_at""",
            (stage_id, room_id, payload.get("execution_id"), payload.get("message_id"),
             str(payload.get("member") or "")[:120], str(payload.get("title") or "")[:200],
             str(payload.get("directory") or "")[:300], kind, int(payload.get("file_count") or 0),
             int(payload.get("bytes") or 0), json.dumps(payload.get("files") or [], ensure_ascii=False),
             json.dumps(payload.get("spots") or [], ensure_ascii=False),
             json.dumps(payload.get("rejected_files") or [], ensure_ascii=False),
             1 if payload.get("ready", True) else 0, str(payload.get("site_id") or "")[:32], now_iso, now_iso))
        row = connection.execute("SELECT * FROM room_site_stages WHERE id=?", (stage_id,)).fetchone()
        return {"stage": _stage_public_row(row)}
    if action == "upsert":
        site_id = str(payload.get("site_id") or "")
        url = str(payload.get("url") or "")
        status = str(payload.get("status") or "active")
        if not SITE_ID_PATTERN.fullmatch(site_id) or not url.startswith("https://") or len(url) > 300 or status not in SITE_STATUSES:
            raise ValueError("Invalid site metadata")
        connection.execute(
            """INSERT INTO room_sites
               (site_id,room_id,message_id,execution_id,member,title,url,directory,current_version,previous_version,file_count,bytes,status,versions_json,files_json,expires_at,created_at,updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(site_id) DO UPDATE SET
               message_id=COALESCE(excluded.message_id, room_sites.message_id),
               execution_id=COALESCE(excluded.execution_id, room_sites.execution_id),
               member=CASE WHEN excluded.member<>'' THEN excluded.member ELSE room_sites.member END,
               title=CASE WHEN excluded.title<>'' THEN excluded.title ELSE room_sites.title END,
               url=excluded.url,
               directory=CASE WHEN excluded.directory<>'' THEN excluded.directory ELSE room_sites.directory END,
               current_version=excluded.current_version,previous_version=excluded.previous_version,
               file_count=excluded.file_count,bytes=excluded.bytes,status=excluded.status,
               versions_json=excluded.versions_json,files_json=excluded.files_json,
               expires_at=excluded.expires_at,updated_at=excluded.updated_at""",
            (site_id, room_id, payload.get("message_id"), payload.get("execution_id"),
             str(payload.get("member") or "")[:120], str(payload.get("title") or "")[:200],
             url, str(payload.get("directory") or "")[:300], int(payload.get("current_version") or 1),
             int(payload.get("previous_version") or 0), int(payload.get("file_count") or 0),
             int(payload.get("bytes") or 0), status, json.dumps(payload.get("versions") or [], ensure_ascii=False),
             json.dumps(payload.get("files") or [], ensure_ascii=False), str(payload.get("expires_at") or ""),
             str(payload.get("created_at") or now_iso), now_iso))
        if payload.get("stage_id"):
            connection.execute("UPDATE room_site_stages SET site_id=?, updated_at=? WHERE id=? AND room_id=?",
                               (site_id, now_iso, str(payload["stage_id"]), room_id))
        row = connection.execute("SELECT * FROM room_sites WHERE site_id=?", (site_id,)).fetchone()
        return {"site": _site_public_row(row, now_iso)}
    if action == "update_status":
        site_id = str(payload.get("site_id") or "")
        status = str(payload.get("status") or "")
        if not SITE_ID_PATTERN.fullmatch(site_id) or status not in SITE_STATUSES:
            raise ValueError("Invalid site status")
        updates = ["status=?", "updated_at=?"]
        values = [status, now_iso]
        for col, key in (("expires_at", "expires_at"), ("current_version", "current_version"),
                         ("previous_version", "previous_version"), ("file_count", "file_count"), ("bytes", "bytes")):
            if key in payload and payload[key] is not None:
                updates.append(f"{col}=?")
                values.append(payload[key])
        if "versions" in payload and isinstance(payload["versions"], list):
            updates.append("versions_json=?")
            values.append(json.dumps(payload["versions"], ensure_ascii=False))
        values.extend([site_id, room_id])
        connection.execute(f"UPDATE room_sites SET {', '.join(updates)} WHERE site_id=? AND room_id=?", values)
        row = connection.execute("SELECT * FROM room_sites WHERE site_id=? AND room_id=?", (site_id, room_id)).fetchone()
        if not row:
            raise LookupError("Site record not found")
        return {"site": _site_public_row(row, now_iso)}
    raise ValueError("Unknown site write action")


def last_room(connection):
    """The room last opened by the site's manager on any device, or '' when none or it no longer exists."""
    row = connection.execute("""SELECT p.value FROM site_preferences p JOIN room_directory d ON d.room_id=p.value
        WHERE p.key='last_room' AND d.system_kind=''""").fetchone()
    return row[0] if row else ""


def remember_last_room(connection, payload):
    """Remember the room the manager opened, so the next visit from any device reopens it."""
    room_id = payload.get("room_id")
    directory = connection.execute("SELECT system_kind FROM room_directory WHERE room_id=?", (room_id,)).fetchone() if isinstance(room_id, str) else None
    if directory is None:
        raise LookupError(Text('房间不存在'))
    if directory["system_kind"]:
        return {"last_room": last_room(connection)}
    connection.execute("INSERT INTO site_preferences (key,value) VALUES ('last_room',?) "
                       "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (room_id,))
    return {"last_room": room_id}


def folder_record(row):
    """Return one folder with its project paths decoded."""
    return {**dict(row), "directories": json.loads(row["directories"])}


def folder_directory(connection):
    """Return real folders and the virtual group's index (null keeps it last)."""
    settings = connection.execute("SELECT uncategorized_position FROM directory_settings WHERE id=1").fetchone()
    rows = connection.execute("SELECT id,name,position,directories FROM topic_folders ORDER BY position,name,id")
    return {"folders": [folder_record(row) for row in rows], "uncategorized_position": settings[0] if settings else None}


def same_path_key(path):
    """Compare paths as Windows does: without case, separator style or a trailing separator."""
    return path.replace("\\", "/").rstrip("/").lower()


def folder_directories_value(payload):
    """Validate a folder's project paths: absolute, distinct, the first being the main directory.

    The paths are only checked for form here; the local service checks they exist when a room is created from them.
    """
    directories = payload.get("directories", [])
    if not isinstance(directories, list) or len(directories) > MAX_FOLDER_DIRECTORIES:
        raise ValueError(Text('项目路径须为最多 {value1} 项的列表', value1=MAX_FOLDER_DIRECTORIES))
    paths = []
    for item in directories:
        path = item.strip() if isinstance(item, str) else ""
        if not path or len(path) > MAX_DIRECTORY_PATH or not ABSOLUTE_PATH_PATTERN.match(path):
            raise ValueError(Text('项目路径须为完整的绝对路径'))
        if same_path_key(path) in [same_path_key(known) for known in paths]:
            raise ValueError(Text('项目路径重复：{value1}', value1=path))
        paths.append(path)
    return paths


def folder_name_value(payload):
    """Validate a shared folder name for creation and renaming."""
    raw_name = payload.get("name")
    if not isinstance(raw_name, str):
        raise ValueError(Text('文件夹名称必须是文本'))
    name = raw_name.strip()
    if not name or len(name) > 40:
        raise ValueError(Text('文件夹名称须为 1–40 个字符'))
    return name


def rename_folder(connection, folder_id, payload):
    """Rename one folder and, when given, replace its project paths; positions and room assignments stay."""
    begin_write(connection)
    name = folder_name_value(payload)
    changes = {"name": name}
    if "directories" in payload:
        changes["directories"] = json.dumps(folder_directories_value(payload), ensure_ascii=False)
    assignments = ",".join(f"{column}=?" for column in changes)
    if connection.execute(f"UPDATE topic_folders SET {assignments} WHERE id=?", (*changes.values(), folder_id)).rowcount == 0:
        raise LookupError(Text('文件夹不存在'))
    return folder_record(connection.execute("SELECT id,name,position,directories FROM topic_folders WHERE id=?", (folder_id,)).fetchone())


def delete_folder(connection, folder_id):
    """Remove a group while retaining its rooms and the virtual group's position."""
    begin_write(connection)
    directory = folder_directory(connection)
    identifiers = [folder["id"] for folder in directory["folders"]]
    if folder_id not in identifiers:
        raise LookupError(Text('文件夹不存在'))
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
        raise LookupError(Text('文件夹不存在'))
    remaining = [folder for folder in folders if folder["id"] != folder_id]
    before = payload.get("before_id")
    identifiers = [folder["id"] for folder in remaining]
    if before is not None and before not in identifiers:
        raise ValueError(Text('目标文件夹不存在或与当前文件夹相同'))
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
    """Move, rename, pin, archive, restore or permanently delete one declared host's room."""
    begin_write(connection)
    room = require_room(connection, room_id)
    require_host(room, payload)
    if room["system_kind"] and action in ("move", "folder", "detach", "auto-destroy"):
        raise ValueError(Text('系统房间不参与目录管理或自动销毁'))
    if action in ("archive", "delete") and room["pinned"]:
        raise FileExistsError(Text('已固定的房间不能存档或销毁，请先取消固定'))
    if action == "move":
        rooms = [item["id"] for item in list_rooms(connection)["rooms"] if item["id"] != room_id and not item["system_kind"]]
        before = payload.get("before_id")
        if before is not None and before not in rooms:
            raise ValueError(Text('目标房间不存在或与当前房间相同'))
        rooms.insert(rooms.index(before) if before else len(rooms), room_id)
        connection.executemany("UPDATE room_directory SET position=? WHERE room_id=?", enumerate(rooms, 1))
    elif action == "folder":
        folder_id = payload.get("folder_id")
        if folder_id is not None and not isinstance(folder_id, str):
            raise ValueError(Text('文件夹编号格式无效'))
        if folder_id is not None and connection.execute("SELECT 1 FROM topic_folders WHERE id=?", (folder_id,)).fetchone() is None:
            raise ValueError(Text('文件夹不存在'))
        connection.execute("UPDATE room_folder_assignments SET folder_id=? WHERE room_id=?", (folder_id, room_id))
    elif action == "detach":
        # Display only: the parent link stays, so relay cards and `parent_room_id` keep working either way.
        detached = payload.get("detached")
        if type(detached) is not bool:
            raise ValueError(Text('detached 须为 true 或 false'))
        if detached and not room["parent_room_id"]:
            raise ValueError(Text('这个房间没有父房间'))
        connection.execute("UPDATE room_directory SET detached=? WHERE room_id=?", (int(detached), room_id))
        if detached:
            # A lifted room lands right after its parent rather than at the end of the folder.
            rooms = [item["id"] for item in list_rooms(connection)["rooms"] if item["id"] != room_id and not item["system_kind"]]
            parent = room["parent_room_id"]
            rooms.insert(rooms.index(parent) + 1 if parent in rooms else len(rooms), room_id)
            connection.executemany("UPDATE room_directory SET position=? WHERE room_id=?", enumerate(rooms, 1))
    elif action == "pin":
        pinned = payload.get("pinned")
        if type(pinned) is not bool:
            raise ValueError(Text('pinned 须为 true 或 false'))
        connection.execute("UPDATE room_directory SET pinned=? WHERE room_id=?", (int(pinned), room_id))
    elif action == "rename":
        # The title is display-only, so renaming never touches phase, turns or members.
        title = str(payload.get("title", "")).strip()
        if not title or len(title) > 80:
            raise ValueError(Text('title 内容为空或超过 80 字'))
        connection.execute("UPDATE rooms SET title=? WHERE id=?", (title, room_id))
    elif action in ("archive", "restore"):
        if action == "restore" and room["archived"] and room["system_kind"] == "steward":
            require_no_active_steward(connection)
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
    elif action == "auto-destroy":
        days = payload.get("days")
        if type(days) is not int or days not in AUTO_DESTROY_DAYS:
            raise ValueError(Text('自动销毁只能设为 {choices} 天（0 为不自动销毁）', choices="/".join(map(str, AUTO_DESTROY_DAYS))))
        # Counted from the later of the last activity and this change, so choosing a limit never destroys a room at once.
        connection.execute("UPDATE room_directory SET destroy_after_days=?,destroy_set_at=? WHERE room_id=?", (days, utc_now(), room_id))
    elif action == "delete":
        if payload.get("archived_steward_only") is True and (room["system_kind"] != "steward" or not room["archived"]):
            raise FileExistsError(Text('只能删除已存档的平台主理人房间'))
        # The page confirms in its own dialog; a caller that names the title must name it right.
        if "confirm_title" in payload and payload.get("confirm_title") != room["title"]:
            raise ValueError(Text('请输入完整房间名称确认删除'))
        if connection.execute("SELECT 1 FROM room_share_links WHERE room_id=? AND expires_at>?", (room_id, utc_iso_now())).fetchone():
            raise FileExistsError(Text('这个房间发布过分享链接，请先撤销分享链接再销毁'))
        counts = destruction_counts(connection, room_id)
        control = connection.execute("SELECT control_hash FROM room_modes WHERE room_id=?", (room_id,)).fetchone()
        # Only a room some computer's runner served has AI sessions and local files to remove there.
        expect_runner = bool(control and control[0]) and connection.execute(
            "SELECT 1 FROM room_members WHERE room_id=? AND access='runner' LIMIT 1", (room_id,)).fetchone() is not None
        members = {}
        for row in connection.execute("""SELECT DISTINCT m.id,m.name,m.status,m.session_mode,e.session_id FROM member_executions e
                JOIN room_members m ON m.id=e.member_id WHERE e.room_id=? AND m.access='runner' AND e.session_id<>'' ORDER BY e.id""", (room_id,)):
            entry = members.setdefault(row["id"], {"name": row["name"], "ids": [], "borrowed": row["session_mode"] == "borrowed",
                                                   "removed": row["status"] == "removed"})
            entry["ids"].append(row["session_id"])
        sessions = list(members.values())
        # (a) Kept scheduling feedback serves tuning on the maintainer's own site; a hosted account's has no reader and goes.
        feedback = connection.execute("""SELECT
            (SELECT COUNT(*) FROM scheduler_feedback_cases WHERE room_id=?) +
            (SELECT COUNT(*) FROM dispatch_feedback_cases WHERE room_id=?)""", (room_id, room_id)).fetchone()[0]
        keep_feedback = not room["system_kind"] and not hosted_instance()
        if feedback and keep_feedback:
            counts.append({"kind": "feedback_cases", "state": "kept", "count": feedback})
        if not room["system_kind"]:
            seal_room(connection, room_id, int(time.time()))
        delete_room_records(connection, room_id, keep_feedback=keep_feedback)
        connection.execute("""INSERT OR REPLACE INTO room_destructions (room_id,title,control_hash,status,expect_runner,automatic,items,sessions,created_at)
            VALUES (?,?,?,'cleaning',?,?,?,?,?)""", (room_id, room["title"], control[0] if control else "", int(expect_runner),
                                                      int(payload.get("automatic") is True), json.dumps(counts), json.dumps(sessions), utc_now()))
        return {"deleted": True, "id": room_id, "destruction": destruction_view(connection, room_id)}
    else:
        raise LookupError(Text('地址不存在'))
    return require_room(connection, room_id)


def hosted_instance():
    """Whether this website serves a hosted account running as its own Windows user (runner/os_users.mjs sets the flag);
    the owner's instance is entry-protected too while hosting is on, so protection alone proves nothing."""
    return os.getenv("CODISCUSS_ISOLATED_ACCOUNT") == "1"


def delete_room_records(connection, room_id, keep_feedback=False):
    """Remove a room's dependent records in the caller's transaction; `keep_feedback` leaves its rated scheduling cases."""
    if keep_feedback:
        refresh_dispatch_cases(connection, room_id)
    # Stored texts and kept feedback cases name their owner without a foreign key, so they go first, while the
    # rows that identify them still exist.
    for owner, query in ROOM_TEXT_OWNERS:
        connection.execute(f"DELETE FROM stored_texts WHERE owner=? AND owner_id IN ({query})", (owner, room_id))
    connection.execute("DELETE FROM stored_texts WHERE owner='room' AND owner_id=?", (room_id,))
    if not keep_feedback:
        connection.execute("DELETE FROM scheduler_feedback_cases WHERE room_id=?", (room_id,))
        connection.execute("DELETE FROM dispatch_feedback_cases WHERE room_id=?", (room_id,))
    connection.execute("DELETE FROM task_message_sources WHERE session_id IN (SELECT id FROM discussion_sessions WHERE room_id=?)", (room_id,))
    connection.execute("DELETE FROM goal_continuations WHERE room_id=?", (room_id,))
    connection.execute("DELETE FROM question_events WHERE question_id IN (SELECT id FROM room_questions WHERE room_id=?)", (room_id,))
    connection.execute("DELETE FROM room_questions WHERE room_id=?", (room_id,))
    connection.execute("DELETE FROM room_goals WHERE room_id=?", (room_id,))
    connection.execute("DELETE FROM discussion_sessions WHERE room_id=?", (room_id,))
    for table in ("member_recommendations", "free_queue", "queued_messages", "queued_message_pauses", "speaking_orders", "member_requests", "member_descriptions", "member_labels", "execution_notes", "execution_segments", "execution_capabilities", "late_answers", "member_executions", "member_capabilities", "member_usage", "execution_usage", "member_sessions", "member_adopt_failures", "member_registrations", "room_members", "room_modes", "free_batches", "free_chains", "free_handoffs", "free_round_limits", "free_chain_holds", "free_relay_steps",
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


# Each stored-text owner kind that belongs to a room, and the query listing that room's owner IDs.
ROOM_TEXT_OWNERS = (
    ("message", "SELECT id FROM messages WHERE room_id=?"),
    ("decision", "SELECT id FROM scheduler_decisions WHERE room_id=?"),
    ("scheduler_decision", "SELECT id FROM scheduler_decisions WHERE room_id=?"),
    ("execution", "SELECT id FROM member_executions WHERE room_id=?"),
    ("private_chat", "SELECT id FROM private_chats WHERE room_id=?"),
    ("queued_message", "SELECT id FROM queued_messages WHERE room_id=?"),
    ("room_event", "SELECT id FROM room_events WHERE room_id=?"),
    ("member", "SELECT id FROM room_members WHERE room_id=?"),
    ("request", "SELECT id FROM member_requests WHERE room_id=?"),
    ("session", "SELECT id FROM discussion_sessions WHERE room_id=?"),
    ("session_request", "SELECT id FROM session_requests WHERE session_id IN (SELECT id FROM discussion_sessions WHERE room_id=?)"),
)
# Receipt item states: removed and checked gone, not on this computer, deliberately kept, failed (retried).
DESTRUCTION_STATES = ("deleted", "elsewhere", "kept", "failed")
# What a runner may report about its computer, beyond the website's own records and attachments.
RUNNER_DESTRUCTION_KINDS = ("sessions", "runtime_files", "kept_sessions", "software_stores", "draft_space")
DESTRUCTION_LIST_LIMIT = 20


def destruction_counts(connection, room_id):
    """The receipt items the website itself removes and checks: records and attachment files, plus what it keeps."""
    count = lambda query: connection.execute(query, (room_id,)).fetchone()[0]
    files = connection.execute("SELECT id,size,storage,object_name FROM attachments WHERE room_id=?", (room_id,)).fetchall()
    # The file IDs stay with the item until each file is checked gone, so a held file can be retried later.
    return [{"kind": "messages", "state": "pending", "count": count("SELECT COUNT(*) FROM messages WHERE room_id=?")},
            {"kind": "private_chats", "state": "pending", "count": count("SELECT COUNT(*) FROM private_chats WHERE room_id=?")},
            {"kind": "attachments", "state": "pending", "count": len(files), "bytes": sum(row["size"] for row in files),
             "ids": [row["id"] for row in files if row["storage"] != "object"],
             "objects": [{"id": row["id"], "room_id": room_id, "object_name": row["object_name"]}
                         for row in files if row["storage"] == "object" and row["object_name"]]},
            {"kind": "database", "state": "pending"},
            {"kind": "project_files", "state": "kept"},
            {"kind": "providers", "state": "elsewhere"}]


def destruction_view(connection, room_id):
    """One destruction as the page shows it, or None when the room was never destroyed here."""
    row = connection.execute("SELECT * FROM room_destructions WHERE room_id=?", (room_id,)).fetchone()
    if not row:
        return None
    items = [{key: value for key, value in item.items() if key not in ("ids", "objects")} for item in json.loads(row["items"])]
    return {"room_id": row["room_id"], "title": row["title"], "status": row["status"], "automatic": bool(row["automatic"]),
            "items": items, "created_at": row["created_at"], "finished_at": row["finished_at"]}


def list_destructions(connection):
    """Destructions still cleaning, then the latest receipts, for the room list."""
    rows = connection.execute("""SELECT room_id FROM room_destructions ORDER BY status='done', created_at DESC LIMIT ?""",
                              (DESTRUCTION_LIST_LIMIT,)).fetchall()
    return [destruction_view(connection, row["room_id"]) for row in rows]


def update_destruction(connection, room_id, updates, runner_reported=False):
    """Replace receipt items by kind and finish the destruction once nothing is pending or failed.

    Args:
        connection: An open connection; the caller commits.
        room_id: The destroyed room.
        updates: Items `{kind, state, count?, bytes?, detail?}` replacing those of the same kind (and adapter, for sessions).
        runner_reported: Whether this is the room's runner's report, which a room served by a runner waits for.
    """
    row = connection.execute("SELECT * FROM room_destructions WHERE room_id=?", (room_id,)).fetchone()
    if not row or row["status"] == "done":
        return
    key = lambda item: (item["kind"], item.get("adapter", ""))
    items = {key(item): item for item in json.loads(row["items"])}
    items.update({key(item): item for item in updates})
    expect_runner = row["expect_runner"] and not runner_reported
    items = list(items.values())
    done = not expect_runner and all(item["state"] in ("deleted", "elsewhere", "kept") for item in items)
    if done:
        # The receipt keeps counts only: neither the title nor the credential hash outlives the cleanup.
        connection.execute("""UPDATE room_destructions SET status='done',title='',control_hash='',sessions='{}',expect_runner=0,items=?,finished_at=?
            WHERE room_id=?""", (json.dumps(items), utc_now(), room_id))
    else:
        connection.execute("UPDATE room_destructions SET items=?,expect_runner=? WHERE room_id=?",
                           (json.dumps(items), int(expect_runner), room_id))


def destruction_sessions(connection, room_id, token):
    """`{sessions: {member: [session IDs]}}` for the holder of the destroyed room's owner credential while it is cleaning, else {}."""
    row = connection.execute("SELECT control_hash,sessions FROM room_destructions WHERE room_id=? AND status='cleaning'", (room_id,)).fetchone()
    hashed = token_hash(token)
    if not row or not hashed or not row["control_hash"] or not hmac.compare_digest(hashed, row["control_hash"]):
        return {}
    return {"sessions": json.loads(row["sessions"]) or []}


def report_destruction(connection, room_id, token, payload):
    """Accept a runner's report of what it removed on its computer for a destroyed room, under the room's old owner credential."""
    row = connection.execute("SELECT control_hash,status FROM room_destructions WHERE room_id=?", (room_id,)).fetchone()
    if not row:
        raise LookupError(Text('房间不存在'))
    if row["status"] == "done":
        return destruction_view(connection, room_id)
    hashed = token_hash(token)
    if not hashed or not row["control_hash"] or not hmac.compare_digest(hashed, row["control_hash"]):
        raise PermissionError(Text('需要本房间的控制凭据；没有凭据只能阅读'))
    items = payload.get("items")
    if not isinstance(items, list) or len(items) > 50:
        raise ValueError(Text('清理结果格式无效'))
    clean = []
    for item in items:
        if not isinstance(item, dict) or item.get("kind") not in RUNNER_DESTRUCTION_KINDS or item.get("state") not in DESTRUCTION_STATES:
            raise ValueError(Text('清理结果格式无效'))
        kept = {field: item[field] for field in ("count",) if type(item.get(field)) is int and item[field] >= 0}
        kept.update({field: str(item[field])[:200] for field in ("adapter", "detail") if isinstance(item.get(field), str)})
        clean.append({"kind": item["kind"], "state": item["state"], **kept})
    begin_write(connection)
    update_destruction(connection, room_id, clean, runner_reported=True)
    return destruction_view(connection, room_id)


RECLAIM_VACUUM_MIN_BYTES = 1024 * 1024


def reclaim_database_space(connection, min_vacuum_bytes=RECLAIM_VACUUM_MIN_BYTES):
    """Return freed SQLite pages to the OS: incrementally when enabled, or via a one-time VACUUM upgrade."""
    free_pages = connection.execute("PRAGMA freelist_count").fetchone()[0]
    if not free_pages:
        return False
    if connection.execute("PRAGMA auto_vacuum").fetchone()[0] == 2:
        # incremental_vacuum steps one page per row; exhausting the cursor reclaims every free page.
        connection.execute("PRAGMA incremental_vacuum").fetchall()
        return True
    page_size = connection.execute("PRAGMA page_size").fetchone()[0]
    if free_pages * page_size < min_vacuum_bytes:
        return False
    # Existing databases default to auto_vacuum=0; switching to INCREMENTAL takes effect on one VACUUM,
    # after which future room destructions reclaim pages incrementally without rewriting the whole file.
    connection.execute("PRAGMA auto_vacuum = INCREMENTAL")
    connection.execute("VACUUM")
    return True


def finish_destruction_files(database, room_id):
    """After the records commit: remove the attachment files, reclaim freed database pages, and truncate the WAL.

    A file still held or a log still in use leaves its item failed; the page shows it and the service retries it.
    """
    with closing(connect_db(database)) as connection:
        row = connection.execute("SELECT items FROM room_destructions WHERE room_id=? AND status='cleaning'", (room_id,)).fetchone()
        if not row:
            return
        items = {item["kind"]: item for item in json.loads(row["items"])}
        files = items["attachments"]
        failures = files.get("object_delete_failures", 0) + delete_remote_attachments(database, files.get("objects", []))
        left = []
        for file_id in files.get("ids", []):
            path = attachment_path(database, {"id": file_id})
            try:
                thumbnail_path(database, {"id": file_id}).unlink(missing_ok=True)
                path.unlink(missing_ok=True)
            except OSError:
                logging.exception("Attachment cleanup failed: %s", file_id)
            if path.exists():
                left.append(file_id)
        try:
            reclaim_database_space(connection)
        except sqlite3.OperationalError:
            logging.warning("Database space reclamation skipped: %s", room_id, exc_info=True)
        # Deleted pages are already zeroed (secure_delete); truncating the log drops its copies of the old rows.
        busy = connection.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()[0]
        with connection:
            begin_write(connection)
            updates = [{**items["messages"], "state": "deleted"}, {**items["private_chats"], "state": "deleted"},
                       {**files, "ids": left, "objects": [], "object_delete_failures": failures, "state": "failed" if left else "deleted"},
                       {"kind": "database", "state": "failed" if busy else "deleted"}]
            update_destruction(connection, room_id, updates)
    sweep_attachments(database, expire_objects=False)


def destroy_from(connection, room, directory):
    """When a room's auto-destroy count starts: the latest of its creation, last message, last private chat and the setting itself."""
    times = [room["created_at"], directory["destroy_set_at"],
             connection.execute("SELECT MAX(created_at) FROM messages WHERE room_id=?", (room["id"],)).fetchone()[0]]
    chat = connection.execute("SELECT MAX(updated_at) FROM private_chats WHERE room_id=?", (room["id"],)).fetchone()[0]
    moments = [datetime.fromisoformat(value) for value in times if value]
    moments = [moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc) for moment in moments]
    if chat:
        moments.append(datetime.fromtimestamp(chat, timezone.utc))
    return max(moments).isoformat(timespec="seconds")


# What keeps a room set to destroy itself from doing so: it still owes work, an answer, or a share page only its owner can take down.
DESTROY_BLOCKERS = """EXISTS (SELECT 1 FROM member_executions e WHERE e.room_id=:room AND e.status IN ('dispatched','started') AND e.lease_until>:now)
    OR EXISTS (SELECT 1 FROM member_requests q WHERE q.room_id=:room AND q.status IN ('pending','delivering'))
    OR EXISTS (SELECT 1 FROM queued_messages q WHERE q.room_id=:room)
    OR EXISTS (SELECT 1 FROM room_questions q WHERE q.room_id=:room AND q.status IN ('waiting_user','waiting_recommendation','delegated'))
    OR EXISTS (SELECT 1 FROM room_share_links s WHERE s.room_id=:room AND s.expires_at>:iso)"""


def destroy_blocked(connection, room_id, now=None):
    """Whether something in the room keeps it from destroying itself now (see DESTROY_BLOCKERS)."""
    now = now or datetime.now(timezone.utc)
    return bool(connection.execute(f"SELECT {DESTROY_BLOCKERS}", {"room": room_id, "now": int(now.timestamp()),
                                                                "iso": now.strftime("%Y-%m-%dT%H:%M:%SZ")}).fetchone()[0])


def expired_rooms(connection, now=None):
    """Rooms past their auto-destroy limit with nothing still owed: not archived or pinned, no work running or queued, no open
    question, no published share page (only the owner's page can take that down)."""
    now = now or datetime.now(timezone.utc)
    rows = connection.execute("""SELECT r.id,r.created_at,d.* FROM rooms r JOIN room_directory d ON d.room_id=r.id
        WHERE d.destroy_after_days>0 AND d.archived=0 AND d.pinned=0 AND d.system_kind=''""").fetchall()
    return [row["room_id"] for row in rows if not destroy_blocked(connection, row["room_id"], now)
            if now - datetime.fromisoformat(destroy_from(connection, {"id": row["room_id"], "created_at": row["created_at"]}, row))
            >= timedelta(days=row["destroy_after_days"])]


def destroy_expired_rooms(server):
    """Destroy every room past its inactivity limit, exactly as its owner's destroy would, and wake the open pages."""
    with closing(connect_db(server.database)) as connection:
        for room_id in expired_rooms(connection):
            try:
                manage_room(connection, room_id, "delete", {"actor": "用户", "automatic": True})
                connection.commit()
            except (LookupError, PermissionError, ValueError, FileExistsError, sqlite3.Error):
                connection.rollback()
                logging.exception("Automatic destruction failed: %s", room_id)
                continue
            finish_destruction_files(server.database, room_id)
            server.hub.notify_update(None)


def watch_expired_rooms(server):
    """Check for rooms to destroy automatically every few minutes, for as long as the website runs."""
    next_sweep = 0
    while True:
        if time.monotonic() >= next_sweep:
            for room_id in sweep_attachments(server.database):
                server.hub.notify_update(room_id)
            next_sweep = time.monotonic() + ATTACHMENT_SWEEP_SECONDS
        try:
            destroy_expired_rooms(server)
        except Exception:
            logging.exception("Checking rooms to destroy automatically failed")
        time.sleep(AUTO_DESTROY_CHECK_SECONDS)


def retry_destruction(database):
    """Retry the website's part of every unfinished destruction: attachment files left behind and an untruncated log."""
    with closing(connect_db(database)) as connection:
        rows = connection.execute("SELECT room_id FROM room_destructions WHERE status='cleaning'").fetchall()
    for row in rows:
        finish_destruction_files(database, row["room_id"])


def redact_payload(value, texts=None, path="payload"):
    """Copy an audit payload with secrets hidden and templates collected for hidden or shortened strings."""
    texts = texts if texts is not None else {}
    if isinstance(value, dict):
        result = {}
        for key, item in value.items():
            field = f"{path}.{key}"
            if API_LOG_SECRET.search(str(key)) or field in ("payload.edits.cover", "payload.link.card"):
                hidden = Text("[已隐去]")
                result[key] = str(hidden)
                texts[field] = hidden
            else:
                result[key] = redact_payload(item, texts, field)
        return result
    if isinstance(value, list):
        return [redact_payload(item, texts, f"{path}[{index}]") for index, item in enumerate(value)]
    if isinstance(value, str) and len(value) > API_LOG_TEXT:
        shortened = Text("{preview}…（共 {length} 字）", preview=value[:API_LOG_TEXT], length=len(value))
        texts[path] = shortened
        return str(shortened)
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
            if re.fullmatch(r"/(?:stop|rewind|messages/[0-9]+/retract|members/[0-9]+/interrupt)", record["path"]):
                data["dispatch_interventions_recorded"] = True
            data["elapsed_ms"] = max(0, int(time.time() * 1000) - record["at"])
            data["actor"] = record.get("actor") or api_actor(connection, record["room_id"], record["token"])
            if record.get("error"):
                data["error"] = record["error"]
            if record.get("error_text"):
                data.setdefault("texts", {})["error"] = record["error_text"]
            # The execution a write answered, kept whole beside the payload, which a long answer cuts (review L1).
            execution_id = record["payload"].get("execution_id") if isinstance(record["payload"], dict) else None
            if type(execution_id) is int:
                data["execution_id"] = execution_id
            redacted_texts = {}
            payload_to_log = record["payload"]
            if record["path"].startswith("/executions/") and isinstance(payload_to_log, dict):
                payload_to_log = {key: value for key, value in payload_to_log.items() if key != "diagnostics"}
            redacted_payload = redact_payload(payload_to_log, redacted_texts)
            data.setdefault("texts", {}).update({field: text_payload(value) for field, value in redacted_texts.items()})
            payload = json.dumps(redacted_payload, ensure_ascii=False)
            if len(payload) <= API_LOG_PAYLOAD:
                data["payload"] = payload
            else:
                data["payload"] = str(Text("{preview}…（共 {length} 字）", preview=payload[:API_LOG_PAYLOAD], length=len(payload)))
                data.setdefault("texts", {})["payload"] = {"template": "{preview}…（共 {length} 字）", "params": {"preview": payload[:API_LOG_PAYLOAD], "length": len(payload)}}
            cursor = connection.execute("""INSERT INTO room_events (room_id,at,kind,data) SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM rooms WHERE id=?)""",
                               (record["room_id"], record["at"], "api.write" if record["status"] < 400 else "api.rejected",
                                json.dumps(data, ensure_ascii=False), record["room_id"]))
            for field, text in data.get("texts", {}).items():
                save_text(connection, "room_event", cursor.lastrowid, field, Text(text["template"], **text["params"]))
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


def require_no_active_steward(connection):
    """Reject a second active steward and identify the existing room inside the write transaction."""
    row = connection.execute("SELECT room_id FROM room_directory WHERE system_kind='steward' AND archived=0").fetchone()
    if row:
        error = FileExistsError(Text('平台主理人房间已存在'))
        error.details = {"room_id": row["room_id"]}
        raise error


def steward_member(connection, token):
    """Recognize a MOSS credential, including a revoked one so it cannot go through the owner proxy."""
    hashed = token_hash(token)
    if not hashed:
        return None
    return connection.execute("""SELECT m.room_id,m.name,(d.archived=0 AND m.status='active' AND m.role='host') AS active
        FROM room_members m
        JOIN room_directory d ON d.room_id=m.room_id
        WHERE d.system_kind='steward' AND m.token_hash=? ORDER BY active DESC LIMIT 1""", (hashed,)).fetchone()


def is_active_steward_member(connection, token):
    """Recognize the current MOSS credential without granting it owner rights."""
    member = steward_member(connection, token)
    return bool(member and member["active"])


def create_room(connection, payload, control_token=""):
    """Create a credential-protected collaboration room, binding retries to the original credentials."""
    if payload.get("mode", "free") != "free":
        raise ValueError(Text('房间模式只能为 free'))
    system_kind = payload.get("system_kind", "")
    if system_kind not in ("", "steward"):
        raise ValueError(Text("system_kind 只能为空字符串或 steward"))
    members = member_values(payload.get("members"))
    if system_kind == "steward" and len(members) != 1:
        raise ValueError(STEWARD_MEMBER_LIMIT)
    preset = payload.get("preset", "")
    if preset not in ("", "task") or preset and (system_kind or len(members) != 1 or members[0]["access"] != "runner"
                                                   or members[0]["session_mode"] != "new"):
        raise ValueError(Text("任务房间必须是只有一位新会话托管成员的普通房间"))
    payload = {**payload, "experts": {member["name"]: "cli" for member in members}}
    settings = topic_values(payload)
    limits = limit_values(payload["limits"]) if "limits" in payload else None
    if not token_hash(control_token):
        raise ValueError(Text('建房须提供房主控制凭据'))
    identifier = submission_value(payload["submission_id"]) if "submission_id" in payload else None
    folder_id = payload.get("folder_id")
    if folder_id is not None and not isinstance(folder_id, str):
        raise ValueError(Text('文件夹编号必须是文本或 null'))
    if system_kind and folder_id is not None:
        raise ValueError(Text('系统房间不参与目录管理或自动销毁'))
    request_text = creation_request(settings, limits)
    request_text += ":access:" + token_hash(control_token) + ":" + json.dumps(
        [[member["name"], member["adapter"], member["access"], "",
          member["session_mode"], token_hash(member["token"])] for member in members], ensure_ascii=False)
    if folder_id is not None:
        request_text += ":folder:" + json.dumps(folder_id, ensure_ascii=False)
    if system_kind:
        request_text += ":system_kind:" + system_kind
    if preset:
        request_text += ":preset:" + preset
    begin_write(connection)
    if identifier:
        previous = connection.execute("SELECT * FROM room_creations WHERE submission_id=?", (identifier,)).fetchone()
        if previous:
            if previous["request_text"] != request_text:
                raise FileExistsError(Text('该建房提交编号已被其他内容使用'))
            return {**require_room(connection, previous["room_id"]), "duplicate": True, "submission_id": identifier}
    if system_kind == "steward":
        require_no_active_steward(connection)
    if folder_id is not None and connection.execute("SELECT 1 FROM topic_folders WHERE id=?", (folder_id,)).fetchone() is None:
        raise ValueError(Text('文件夹不存在'))
    room_id = uuid.uuid4().hex[:12]
    connection.execute("INSERT INTO rooms (id,title,goal,created_at) VALUES (?,?,?,?)", (room_id, settings["title"], settings["goal"], utc_now()))
    if system_kind:
        connection.execute("UPDATE room_directory SET system_kind=?,position=0 WHERE room_id=?", (system_kind, room_id))
    if preset:
        connection.execute("INSERT INTO moss_task_rooms(room_id) VALUES(?)", (room_id,))
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
        raise ValueError(Text('请选择有效的发言者'))
    if (not text and not attachment_ids(payload)) or len(text) > MAX_TEXT_LENGTH:
        raise ValueError(Text('发言需包含正文或附件，正文最多 {value1} 字', value1=MAX_TEXT_LENGTH))
    reply_to = payload.get("reply_to")
    return author, text, submission_id, int(reply_to) if reply_to else None


def attachment_ids(payload):
    """Validate the ordered, unique attachment references of one message."""
    identifiers = payload.get("attachment_ids", [])
    if (not isinstance(identifiers, list) or len(identifiers) > MAX_MESSAGE_ATTACHMENTS
            or any(not isinstance(item, str) or not re.fullmatch(r"[a-f0-9]{32}", item) for item in identifiers)
            or len(set(identifiers)) != len(identifiers)):
        raise ValueError(Text('附件编号无效；每条消息最多 {value1} 个，不能重复', value1=MAX_MESSAGE_ATTACHMENTS))
    return identifiers


def attachment_metadata(params):
    """Validate upload metadata independently of the untrusted MIME header."""
    name = params.get("file_name", "")
    actor = params.get("actor")
    if (not isinstance(name, str) or not name.strip() or len(name) > MAX_FILENAME_LENGTH
            or name in (".", "..") or re.search(r"[/\\\x00-\x1f\x7f]", name)):
        raise ValueError(Text('文件名需为 1–{value1} 字，不能包含路径或控制字符', value1=MAX_FILENAME_LENGTH))
    if not is_participant(actor):
        raise ValueError(Text('上传附件须声明有效的 actor'))
    return {"file_name": name, "actor": actor, "submission_id": submission_value(params.get("submission_id"))}


# An SVG document: optional BOM, XML declaration, comments and doctype, then the <svg> root element.
SVG_START = re.compile(rb"^(?:\xef\xbb\xbf)?\s*(?:<\?xml[^>]*>\s*)?(?:<!--.*?-->\s*)*(?:<!DOCTYPE\s+svg[^>]*>\s*)?(?:<!--.*?-->\s*)*<svg[\s>/]",
                       re.IGNORECASE | re.DOTALL)
SVG_SNIFF_BYTES = 4096


ZIP_ENTRY_LIMIT = 64 * 1024 * 1024


def zip_preview_path(info):
    """Decode the archive spelling and return a safe file path for display and lookup."""
    name = info.orig_filename
    if not info.flag_bits & 0x800:
        raw = name.encode("cp437")
        try:
            name = raw.decode("utf-8")
        except UnicodeDecodeError:
            name = raw.decode("gbk", errors="replace")
    name = name.replace("\\", "/")
    parts = name.split("/")
    if any(part in ("", ".", "..", "__MACOSX", ".DS_Store") for part in parts) or re.search(r"[\x00-\x1f\x7f:]", name):
        return None
    return name


def zip_preview(path, entry=None):
    """List central-directory metadata or read one bounded entry into memory."""
    try:
        with zipfile.ZipFile(path) as archive:
            files = {}
            for info in archive.infolist():
                name = zip_preview_path(info)
                if name:
                    files.setdefault(name, info)
            if entry is None:
                entries = []
                for name, info in files.items():
                    try:
                        modified = datetime(*info.date_time).astimezone(timezone.utc).isoformat()
                    except (ValueError, OverflowError, OSError):
                        modified = ""
                    entries.append({"path": name, "size": info.file_size, "modified_at": modified, "encrypted": bool(info.flag_bits & 1)})
                return {"entries": entries}
            info = files.get(entry)
            if not info or info.flag_bits & 1 or info.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
                raise ValueError(Text('无法读取这个压缩包条目'))
            if info.file_size > ZIP_ENTRY_LIMIT:
                raise ValueError(Text('压缩包内单个文件最多预览 64 MiB'))
            with archive.open(info) as source:
                data = source.read(ZIP_ENTRY_LIMIT + 1)
            if len(data) != info.file_size:
                raise ValueError(Text('无法读取这个压缩包条目'))
            return data
    except (zipfile.BadZipFile, UnicodeError, RuntimeError, EOFError, zlib.error, NotImplementedError, OSError) as error:
        raise ValueError(Text('无法读取 ZIP 压缩包')) from error


@lru_cache(maxsize=1)
def zip_entry_bytes(path, sha256, entry):
    """Reuse immutable attachment bytes across consecutive relay ranges after checking room access."""
    return zip_preview(path, entry)


def attachment_content_type(data):
    """Allow inline preview only for recognized images and PDF bytes.

    SVG is shown only as an <img>, where its scripts and external loads never run; opened directly it is still served
    with a sandboxing Content-Security-Policy (see respond_attachment).
    """
    signatures = ((b"\x89PNG\r\n\x1a\n", "image/png"), (b"\xff\xd8\xff", "image/jpeg"),
                  (b"GIF87a", "image/gif"), (b"GIF89a", "image/gif"), (b"%PDF-", "application/pdf"))
    for signature, content_type in signatures:
        if data.startswith(signature):
            return content_type
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return "image/webp"
    if SVG_START.match(data[:SVG_SNIFF_BYTES]):
        return "image/svg+xml"
    return media_content_type(data)


def media_content_type(data):
    """Audio and video by their container signature, for the page's players; unknown bytes stay a download."""
    if data[4:8] == b"ftyp":
        brand = data[8:12]
        return "audio/mp4" if brand in (b"M4A ", b"M4B ") else "video/quicktime" if brand == b"qt  " else "video/mp4"
    if data.startswith(b"\x1a\x45\xdf\xa3"):
        return "video/webm" if b"webm" in data[:64] else "video/x-matroska"
    if data.startswith(b"OggS"):
        return "video/ogg" if b"theora" in data[:128] else "audio/ogg"
    if data.startswith(b"RIFF") and data[8:12] == b"WAVE":
        return "audio/wav"
    if data.startswith(b"fLaC"):
        return "audio/flac"
    if data.startswith(b"ID3"):
        return "audio/mpeg"
    if len(data) > 1 and data[0] == 0xFF:
        # ADTS AAC frames have layer bits 00; MPEG audio frames (MP3) have a non-zero layer.
        if data[1] & 0xF6 == 0xF0:
            return "audio/aac"
        if data[1] & 0xE0 == 0xE0 and data[1] & 0x06:
            return "audio/mpeg"
    return "application/octet-stream"


# Images whose pixel size is read from their header, so the page can hold their place before the bytes arrive.
SIZED_IMAGE_TYPES = ("image/png", "image/jpeg", "image/gif", "image/webp")
# JPEG markers that start a frame header (SOF0–SOF15 except DHT, JPG and DAC), which holds the image size.
JPEG_FRAME_MARKERS = frozenset((0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF))
# JPEG markers without a length field.
JPEG_STANDALONE_MARKERS = frozenset((0x01, *range(0xD0, 0xD8)))
# EXIF orientations that turn the picture a quarter, so it shows with width and height swapped.
EXIF_QUARTER_TURNS = (5, 6, 7, 8)
EXIF_ORIENTATION_TAG = 0x0112


def image_size(stream):
    """Return the (width, height) a PNG/JPEG/GIF/WebP image shows at, read from its header without decoding it.

    Args:
        stream: A binary file object at the start of the image; only headers are read, a JPEG's segments skipped.

    Returns:
        Positive integers, or (0, 0) when the header is not one of those formats or gives no size.
    """
    try:
        head = stream.read(32)
        if head.startswith(b"\x89PNG\r\n\x1a\n") and head[12:16] == b"IHDR":
            size = struct.unpack(">II", head[16:24])
        elif head[:6] in (b"GIF87a", b"GIF89a"):
            size = struct.unpack("<HH", head[6:10])
        elif head.startswith(b"RIFF") and head[8:12] == b"WEBP":
            size = webp_size(head)
        elif head.startswith(b"\xff\xd8"):
            stream.seek(2)
            size = jpeg_size(stream)
        else:
            size = (0, 0)
    except struct.error:
        size = (0, 0)
    return size if min(size) > 0 else (0, 0)


def webp_size(head):
    """The canvas size in the first chunk of a WebP file: lossy (VP8), lossless (VP8L) or extended (VP8X)."""
    chunk = head[12:16]
    if chunk == b"VP8 " and head[23:26] == b"\x9d\x01\x2a":
        width, height = struct.unpack("<HH", head[26:30])
        return width & 0x3FFF, height & 0x3FFF
    if chunk == b"VP8L" and head[20] == 0x2F:
        bits = struct.unpack("<I", head[21:25])[0]
        return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
    if chunk == b"VP8X":
        return int.from_bytes(head[24:27], "little") + 1, int.from_bytes(head[27:30], "little") + 1
    return 0, 0


def jpeg_size(stream):
    """Walk JPEG segments to the frame header; a quarter-turn EXIF orientation swaps the size, as browsers show it."""
    orientation = 1
    while stream.read(1) == b"\xff":
        marker = stream.read(1)
        while marker == b"\xff":
            marker = stream.read(1)
        if not marker or marker[0] in (0xD9, 0xDA):
            break
        if marker[0] in JPEG_STANDALONE_MARKERS:
            continue
        length = struct.unpack(">H", stream.read(2))[0]
        if marker[0] in JPEG_FRAME_MARKERS:
            height, width = struct.unpack(">xHH", stream.read(5))
            return (height, width) if orientation in EXIF_QUARTER_TURNS else (width, height)
        if marker[0] == 0xE1 and orientation == 1:
            orientation = exif_orientation(stream.read(max(0, length - 2)))
        else:
            stream.seek(max(0, length - 2), io.SEEK_CUR)
    return 0, 0


def exif_orientation(segment):
    """The orientation tag of an APP1 segment's EXIF data; 1 (upright) when it has none."""
    if not segment.startswith(b"Exif\x00\x00"):
        return 1
    tiff = segment[6:]
    order = {b"II": "<", b"MM": ">"}.get(tiff[:2])
    try:
        offset = struct.unpack(order + "I", tiff[4:8])[0]
        for index in range(struct.unpack(order + "H", tiff[offset:offset + 2])[0]):
            entry = offset + 2 + index * 12
            if struct.unpack(order + "H", tiff[entry:entry + 2])[0] == EXIF_ORIENTATION_TAG:
                return struct.unpack(order + "H", tiff[entry + 8:entry + 10])[0]
    except (TypeError, struct.error):
        pass
    return 1


def with_image_sizes(connection, rows):
    """Return attachment rows as dicts, measuring once each image stored before sizes were recorded.

    The size is written back; a read request commits it at once, a write transaction keeps it with its own changes.
    An imported image whose bytes have not arrived yet stays unmeasured until they do.
    """
    files = [dict(row) for row in rows]
    missing = [item for item in files if item.get("width") is None and item["content_type"] in SIZED_IMAGE_TYPES and item.get("storage") != "object"]
    if not missing:
        return files
    began = connection.in_transaction
    database = connection.execute("PRAGMA database_list").fetchone()["file"]
    for item in missing:
        try:
            with attachment_path(database, item).open("rb") as stream:
                item["width"], item["height"] = image_size(stream)
        except OSError:
            continue
        connection.execute("UPDATE attachments SET width=?,height=? WHERE id=?", (item["width"], item["height"], item["id"]))
    if not began:
        connection.commit()
    return files


def attachment_view(connection, row):
    """Return attachment metadata and room-scoped content URLs."""
    result = dict(row)
    result.pop("object_name", None)
    stored_at = result.pop("stored_at", None)
    is_object = result.get("storage") == "object"
    result["stored"] = not is_object or stored_at is not None
    if is_object:
        result["expires_at"] = None
        if stored_at:
            database = connection.execute("PRAGMA database_list").fetchone()["file"]
            retention = object_storage_retention_days(database)
            if retention:
                result["expires_at"] = (datetime.fromisoformat(stored_at) + timedelta(days=retention)).isoformat()
    base = f"/api/rooms/{result['room_id']}/attachments/{result['id']}/content"
    result.update(url=base, download_url=base + "?download=1")
    if result.get("thumbnail_type"):
        result["thumbnail_url"] = f"/api/rooms/{result['room_id']}/attachments/{result['id']}/thumbnail"
    return result


ATTACHMENT_PLACEHOLDER = re.compile(r"\[(图片|文件) #(\d{1,4})\]")


def attachment_number_before(connection, room_id, message_id):
    """The room-wide number of the first file of message `message_id` (of the next file sent when None).

    Files are numbered across the whole room in message order, as Claude Code numbers pasted images across a
    conversation, so `[图片 #n]` names one file wherever it is quoted."""
    if message_id is None:
        query, params = "SELECT COUNT(*) FROM attachments WHERE room_id=? AND message_id IS NOT NULL", (room_id,)
    else:
        query, params = "SELECT COUNT(*) FROM attachments WHERE room_id=? AND message_id IS NOT NULL AND message_id<?", (room_id, message_id)
    return connection.execute(query, params).fetchone()[0] + 1


def renumber_placeholders(text, payload, count, start):
    """Turn the sender's `[图片 #n]` numbering into the numbers the files took.

    The sender numbered its `count` files from `attachment_start` (the page shows the room's next number; a CLI
    member, which sends none, numbers them from 1 within its message); placeholders outside that range are left."""
    assumed = payload.get("attachment_start")
    assumed = assumed if isinstance(assumed, int) and not isinstance(assumed, bool) and assumed >= 1 else 1
    if not count or assumed == start:
        return text
    def shift(match):
        number = int(match.group(2))
        return f"[{match.group(1)} #{number - assumed + start}]" if assumed <= number < assumed + count else match.group(0)
    return ATTACHMENT_PLACEHOLDER.sub(shift, text)


def link_message_attachments(connection, room_id, message_id, identifiers, text, payload):
    """Link the files to their new message and renumber its placeholders room-wide."""
    for position, identifier in enumerate(identifiers):
        connection.execute("UPDATE attachments SET message_id=?,position=? WHERE id=?", (message_id, position, identifier))
    numbered = renumber_placeholders(text, payload, len(identifiers), attachment_number_before(connection, room_id, message_id))
    if numbered != text:
        connection.execute("UPDATE messages SET text=? WHERE id=?", (numbered, message_id))


def renumbered_expected(expected, payload, previous):
    """A retried submission's fields as they were saved: its placeholders renumbered from the files' first number."""
    files = previous["attachments"]
    return {**expected, "text": renumber_placeholders(expected["text"], payload, len(files), files[0]["number"])} if files else expected


def message_with_attachments(connection, row):
    """Attach the published file list to an original message."""
    message = dict(row)
    if message["source"] == "guest":
        origin = guest_origin(connection, message["id"])
        if origin:
            message.update(origin=origin, author_label=origin["label"])
    if is_host_dispatch(connection, message["id"]):
        message["host_dispatch"] = True
        message["dispatch_feedback"] = dispatch_feedback(connection, message["id"])
    if message["withdrawn"] == "retracted":
        # The owner retracted it before anyone handled it: only the page that retracted it keeps the text.
        return {**message, "text": "", "summary": "", "suggestions": [], "attachments": []}
    message["texts"] = load_texts(connection, "message", message["id"])
    template = message["texts"].get("trigger", {}).get("template")
    if template in (STEWARD_PROACTIVE_TEMPLATE, STEWARD_SESSION_TEMPLATE):
        message["texts"]["template"] = template
    message["suggestions"] = message_suggestions(connection, message["id"])
    files = with_image_sizes(connection, connection.execute("SELECT * FROM attachments WHERE message_id=? ORDER BY position,id",
                                                            (message["id"],)))
    first =attachment_number_before(connection, message["room_id"], message["id"]) if files else 0
    message["attachments"] = [{**attachment_view(connection, item), "number": first + index} for index, item in enumerate(files)]
    return message


def attachment_cutoff(connection, room_id, params, token, content=False):
    """The reading boundary attachments are read under, as for messages (必 2, review M4); None when unbounded.

    Listing and metadata, the ways to learn an attachment's ID, are bounded for every caller, anonymous ones included,
    exactly as message reads are. The bytes of one attachment are bounded for a credentialed caller only: the page
    shows images with a plain `<img src>` that carries no token, and an attachment ID is a random 128-bit UUID that
    only a bounded read can hand out."""
    if content and not token and not params.get("execution_id") and not params.get("request_id"):
        return None
    return session_message_access(connection, room_id, params, token)


def query_attachments(connection, room_id, params, token=""):
    """List published files, or recover one upload by its exact submission ID; files of messages past the
    caller's reading boundary are left out."""
    require_room(connection, room_id)
    where, values = "room_id=?", [room_id]
    cutoff = attachment_cutoff(connection, room_id, params, token)
    if cutoff is not None:
        where += " AND (message_id IS NULL OR message_id<=?)"
        values.append(cutoff)
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
    rows = with_image_sizes(connection, connection.execute(f"SELECT * FROM attachments WHERE {where} ORDER BY created_at,id LIMIT ? OFFSET ?",
                                                           [*values, PAGE_SIZE, (page - 1) * PAGE_SIZE]))
    return {"attachments": [{**attachment_view(connection, row), **({"number": attachment_number_before(connection, room_id, row["message_id"]) + row["position"]}
                                                         if row["message_id"] is not None else {})} for row in rows], "page": page, "total": total,
            "pages": max(1, (total + PAGE_SIZE - 1) // PAGE_SIZE)}


def get_attachment(connection, room_id, identifier, params=None, token="", content=False):
    """Resolve a file only within the explicitly selected room, and within the caller's reading boundary."""
    row = connection.execute("SELECT * FROM attachments WHERE room_id=? AND id=?", (room_id, identifier)).fetchone()
    if not row:
        raise LookupError(Text('附件不存在'))
    cutoff = attachment_cutoff(connection, room_id, params or {}, token, content)
    if cutoff is not None and row["message_id"] is not None and row["message_id"] > cutoff:
        raise BoundaryError(Text('该附件所在的消息超出本请求读取上界 #{until}', until=cutoff),
                            code="reading_boundary", read_scope={"request_read_until": cutoff, "boundary_applied": True})
    return attachment_view(connection, with_image_sizes(connection, [row])[0])


def attachment_path(database, attachment):
    """Keep opaque file IDs in storage belonging to this exact SQLite database."""
    root = Path(str(Path(database).resolve()) + ".attachments")
    return root / attachment["id"]


def page_host(root, port):
    """The origin host a project folder's pages are served on: one per folder, so pages of a folder keep their storage."""
    return f"p{hashlib.sha256(str(root).lower().encode('utf-8')).hexdigest()[:16]}.localhost:{port}"


def thumbnail_path(database, attachment):
    """Where the smaller copy of an image attachment is kept, beside the original."""
    return attachment_path(database, {"id": attachment["id"] + THUMBNAIL_SUFFIX})


def store_attachment_thumbnail(connection, database, room_id, identifier, token, data):
    """Keep the smaller copy of an image attachment a room participant's page made; the first one stored stays.

    Validate a client-supplied preview using its headers: a WebP or JPEG no larger than
    MAX_THUMBNAIL_SIDE pixels, smaller than the original, with the original's shape.

    Returns:
        {"attachment": the attachment with its thumbnail_url, "duplicate": whether a thumbnail was already kept}.
    """
    begin_write(connection)
    try:
        require_owner(connection, room_id, token)
    except PermissionError:
        require_member(connection, room_id, token)
    attachment = get_attachment(connection, room_id, identifier)
    if attachment.get("thumbnail_type"):
        return {"attachment": attachment, "duplicate": True}
    content_type = attachment_content_type(data)
    width, height = image_size(io.BytesIO(data))
    original_width, original_height = attachment.get("width") or 0, attachment.get("height") or 0
    if (attachment["content_type"] not in SIZED_IMAGE_TYPES or content_type not in THUMBNAIL_TYPES or not width
            or max(width, height) > MAX_THUMBNAIL_SIDE or len(data) >= attachment["size"] or not original_width
            or abs(width / height - original_width / original_height) > THUMBNAIL_RATIO_TOLERANCE * original_width / original_height):
        raise ValueError(Text('缩略图不符合要求'))
    path = thumbnail_path(database, attachment)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    connection.execute("UPDATE attachments SET thumbnail_type=? WHERE id=?", (content_type, identifier))
    connection.commit()
    return {"attachment": get_attachment(connection, room_id, identifier), "duplicate": False}


def generate_attachment_thumbnail(connection, database, attachment):
    """Keep a smaller PNG attachment preview, if the local codec and original are available."""
    if (os.name != "nt" or attachment["content_type"] != "image/png"
            or attachment.get("thumbnail_type")):
        return False
    path = attachment_path(database, attachment)
    try:
        with path.open("rb") as source:
            width, height = image_size(source)
        data = encode_preview(path, width, height)
        if data and data.startswith(b"\x89PNG") and len(data) > MAX_THUMBNAIL_BYTES:
            data = encode_preview(path, width, height, max_width=360)
        if not data or len(data) > MAX_THUMBNAIL_BYTES or len(data) * 2 >= attachment["size"]:
            return False
        with connection:
            begin_write(connection)
            updated = connection.execute("UPDATE attachments SET thumbnail_type=? "
                                         "WHERE id=? AND thumbnail_type IS NULL", (attachment_content_type(data), attachment["id"]))
            if not updated.rowcount:
                return False
            thumbnail_path(database, attachment).write_bytes(data)
        return True
    except (OSError, ValueError, sqlite3.Error):
        logging.debug("Preview unavailable for %s", attachment["id"], exc_info=True)
        return False


def backfill_thumbnails(database, room_id):
    """Generate missing previews in one room, one file at a time outside the write lock."""
    with closing(connect_db(database)) as connection:
        require_room(connection, room_id)
        rows = connection.execute("SELECT id,content_type,size,thumbnail_type FROM attachments "
                                  "WHERE room_id=? AND content_type='image/png' AND thumbnail_type IS NULL "
                                  "AND message_id IS NOT NULL",
                                  (room_id,)).fetchall()
        generated = sum(generate_attachment_thumbnail(connection, database, dict(row)) for row in rows)
        logging.info("Generated %d of %d missing PNG previews", generated, len(rows))


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
            raise FileExistsError(Text('这个附件提交编号已被其他文件使用'))
        return {"attachment": attachment_view(connection, previous), "duplicate": True}
    prune_unsent_attachments(connection, database, room_id)
    # Kept out of `expected`: a retry of a file stored before sizes were recorded still matches it.
    width, height = image_size(io.BytesIO(data)) if expected["content_type"] in SIZED_IMAGE_TYPES else (None, None)
    record = {"id": uuid.uuid4().hex, "room_id": room_id, **expected, "width": width, "height": height, "created_at": utc_now()}
    path = attachment_path(database, record)
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with path.open("xb") as target:
            target.write(data)
        connection.execute("""INSERT INTO attachments
            (id,room_id,file_name,actor,submission_id,size,sha256,content_type,width,height,created_at)
            VALUES (:id,:room_id,:file_name,:actor,:submission_id,:size,:sha256,:content_type,:width,:height,:created_at)""", record)
        connection.commit()
    except Exception:
        path.unlink(missing_ok=True)
        raise
    generate_attachment_thumbnail(connection, database, record)
    return {"attachment": get_attachment(connection, room_id, record["id"]), "duplicate": False}


def object_upload_metadata(payload, actor):
    """Validate the metadata an uploader supplies before issuing a COS form."""
    metadata = attachment_metadata({**payload, "actor": actor})
    size, content_type = payload.get("size"), payload.get("content_type")
    if type(size) is not int or not 0 < size <= OBJECT_MAX_BYTES:
        raise ValueError(Text("对象存储附件大小须在 1 字节至 2 GiB 之间"))
    if (not isinstance(content_type, str) or len(content_type) > 127
            or not re.fullmatch(r"[a-zA-Z0-9!#$&^_.+-]+/[a-zA-Z0-9!#$&^_.+-]+", content_type)):
        raise ValueError(Text("附件的 Content-Type 无效"))
    return {**metadata, "size": size, "content_type": content_type}


# Imported records have no object in this account. Pending uploads already reserve their full declared size.
LIVE_CLOUD_ATTACHMENTS = "storage='object' AND object_name IS NOT NULL AND cleared_at IS NULL"


def object_storage_used_bytes(connection):
    """Count all live objects and upload reservations in this account's database."""
    return connection.execute(f"""SELECT
        (SELECT COALESCE(SUM(size),0) FROM attachments WHERE {LIVE_CLOUD_ATTACHMENTS}) +
        (SELECT COALESCE(SUM(size),0) FROM cloud_files WHERE cleared_at IS NULL)""").fetchone()[0]


def require_cloud_quota(connection, database, size):
    """Check the account budget under the caller's reservation transaction."""
    used, quota = object_storage_used_bytes(connection), object_storage_quota_mib(database)
    if used + size > quota * BYTES_PER_MIB:
        raise FileExistsError(Text("云空间已用 {used} MiB，上限 {quota} MiB。可以清空回收站后重试。",
                                   used=f"{used / BYTES_PER_MIB:.2f}", quota=quota))


def object_storage_limits(connection, database, attachment_limit):
    """Publish cloud-storage policy and usage without exposing the account's credential."""
    return {
        "object_storage_enabled": configured_storage(database) is not None,
        "object_storage_retention_days": object_storage_retention_days(database),
        "object_storage_threshold_mib": object_storage_threshold_mib(database, attachment_limit),
        "object_storage_quota_mib": object_storage_quota_mib(database),
        "object_storage_used_bytes": object_storage_used_bytes(connection),
    }


def reserve_object_attachment(connection, database, room_id, metadata):
    """Reserve a room-owned path; only the same submission can recover the reservation."""
    begin_write(connection)
    previous = connection.execute("SELECT * FROM attachments WHERE room_id=? AND submission_id=?",
                                  (room_id, metadata["submission_id"])).fetchone()
    if previous:
        if (previous["storage"] != "object" or not previous["object_name"] or previous["cleared_at"]
                or any(previous[key] != value for key, value in metadata.items())):
            raise FileExistsError(Text("这个附件提交编号已被其他文件使用"))
        return dict(previous)
    threshold = object_storage_threshold_mib(database, attachment_limit_mib(database))
    if metadata["size"] <= threshold * BYTES_PER_MIB:
        raise ValueError(Text("仅超过 {limit} MiB 的附件使用对象存储", limit=threshold))
    require_cloud_quota(connection, database, metadata["size"])
    identifier = uuid.uuid4().hex
    record = {**metadata, "id": identifier, "room_id": room_id, "storage": "object",
              "object_name": cloud_drive.object_key(f"codiscuss/{room_id}/{identifier}/", metadata["file_name"]), "stored_at": None, "created_at": utc_now()}
    connection.execute("""INSERT INTO attachments
        (id,room_id,file_name,actor,submission_id,size,sha256,content_type,created_at,storage,object_name)
        VALUES (:id,:room_id,:file_name,:actor,:submission_id,:size,'',:content_type,:created_at,:storage,:object_name)""", record)
    return dict(connection.execute("SELECT * FROM attachments WHERE id=?", (identifier,)).fetchone())


def cloud_file_metadata(payload):
    """Validate project provenance as display text, never as a path to open."""
    source_kind, source_ref = payload.get("source_kind"), payload.get("source_ref")
    purpose, source_version = payload.get("purpose", "keep"), payload.get("source_version")
    if (purpose not in ("keep", "inbound", "outbound") or source_version is not None
            and (not isinstance(source_version, str) or not source_version.strip() or len(source_version) > MAX_CLOUD_SOURCE_REF
                 or re.search(r"[\x00-\x1f\x7f]", source_version))):
        raise ValueError(Text("云空间文件来源无效"))
    if (source_kind not in ("project_file", "project_folder") or not isinstance(source_ref, str)
            or not source_ref.strip() or len(source_ref) > MAX_CLOUD_SOURCE_REF
            or re.search(r"[\x00-\x1f\x7f]", source_ref)):
        raise ValueError(Text("云空间文件来源无效"))
    metadata = object_upload_metadata(payload, "用户")
    if metadata["submission_id"].startswith(("cloud-copy-", "expired-outbound-")):
        raise ValueError(Text("云空间文件来源无效"))
    return {**metadata, "source_kind": source_kind, "source_ref": source_ref,
            "purpose": purpose, "source_version": source_version}


def get_cloud_file(connection, identifier, room_id=None):
    """Fetch a cloud file with a room constraint when one was specified."""
    if room_id is None:
        row = connection.execute("SELECT * FROM cloud_files WHERE id=?", (identifier,)).fetchone()
    else:
        row = connection.execute("SELECT * FROM cloud_files WHERE room_id=? AND id=?", (room_id, identifier)).fetchone()
    if row is None:
        raise LookupError(Text("附件不存在"))
    return row


def cloud_file_view(connection, row):
    """Expose provenance and download entry points without revealing the signed object path."""
    result = dict(row)
    result.pop("object_name")
    result["kind"] = "cloud_file"
    result["stored"] = result["stored_at"] is not None
    if result.get("thumbnail_type") and not result.get("trashed_at"):
        result["thumbnail_url"] = f"{cloud_drive.PREFIX}/{result['id']}/thumbnail"
    identifier, room_id = result["id"], result["room_id"]
    base = (f"/api/rooms/{room_id}/cloud-files/{identifier}" if room_id is not None
            else f"/api/rooms/cloud-attachments/{identifier}")
    result.update(url=base + "/content", download_url=base + "/content?download=1")
    result["message_id"] = None
    if room_id is not None and result["source_kind"] == "attachment":
        source = connection.execute("SELECT message_id FROM attachments WHERE room_id=? AND id=?",
                                    (room_id, result["source_ref"])).fetchone()
        if source:
            result["message_id"] = source["message_id"]
    return result


def reserve_cloud_file(connection, database, room_id, metadata):
    """Use the same account quota and write lock as ordinary object attachments."""
    begin_write(connection)
    metadata = {"purpose": "keep", "source_version": None, "folder_id": None, **metadata}
    previous = connection.execute("""SELECT * FROM cloud_files WHERE room_id IS ? AND submission_id=?
        AND (room_id IS NOT NULL OR source_kind='upload')""", (room_id, metadata["submission_id"])).fetchone()
    if previous is not None:
        # A relocation or rename of a direct upload does not change its original submission.
        mutable = {"folder_id"}
        if metadata["source_kind"] == "upload" or previous["stored_at"] and previous["purpose"] == "keep":
            mutable.add("file_name")
        if any(previous[key] != value for key, value in metadata.items() if key not in mutable):
            raise FileExistsError(Text("这个附件提交编号已被其他文件使用"))
        cleared = previous["cleared_at"] is not None
        expired_download = (metadata["purpose"] == "outbound" and
                            (cleared or previous["expires_at"] is not None and previous["expires_at"] <= utc_now()))
        if not expired_download and not (cleared and metadata["source_kind"] == "attachment"):
            if cleared:
                raise FileExistsError(Text("这个附件提交编号已被其他文件使用"))
            cloud_drive.require_available(previous)
            require_cloud_file_fresh(previous)
            return previous
    require_cloud_quota(connection, database, metadata["size"])
    if previous is not None:
        if previous["cleared_at"]:
            connection.execute("DELETE FROM cloud_files WHERE id=?", (previous["id"],))
        else:
            # Keep the expired object's quota until the remote deletion is confirmed by the sweep.
            connection.execute("UPDATE cloud_files SET submission_id=? WHERE id=?",
                               (f"expired-outbound-{previous['id']}", previous["id"]))
    identifier = uuid.uuid4().hex
    created = datetime.now(timezone.utc)
    expires_at = (created + UNSENT_ATTACHMENT_TTL).isoformat(timespec="seconds") if metadata["purpose"] != "keep" else None
    record = {**metadata, "id": identifier, "room_id": room_id, "created_at": created.isoformat(timespec="seconds"),
              "expires_at": expires_at, "object_name": cloud_drive.object_key(f"codiscuss/cloud/{identifier}/", metadata["file_name"])}
    connection.execute("""INSERT INTO cloud_files
        (id,room_id,source_kind,source_ref,file_name,content_type,size,object_name,submission_id,actor,created_at,
         purpose,expires_at,source_version,folder_id)
        VALUES (:id,:room_id,:source_kind,:source_ref,:file_name,:content_type,:size,:object_name,:submission_id,:actor,:created_at,
                :purpose,:expires_at,:source_version,:folder_id)""", record)
    return get_cloud_file(connection, identifier, room_id)


def verify_object_size(client, record):
    """Check the remote size rather than trusting the caller's completion signal."""
    try:
        size = client.file_size(record["object_name"])
    except ObjectMissing:
        raise FileExistsError(Text("对象存储尚未收到文件")) from None
    if size != record["size"]:
        raise FileExistsError(Text("对象存储中的文件大小与上传声明不一致"))


def require_cloud_file_fresh(record):
    """Do not issue new upload or download credentials once a transfer's deadline has passed."""
    if record["expires_at"] is not None and record["expires_at"] <= utc_now():
        raise AdminError(Text("文件已不在对象存储中"), 410)


def finish_cloud_file(connection, client, record):
    """Verify a cloud copy, then mark it stored if its reservation still exists."""
    if record["cleared_at"]:
        raise AdminError(Text("文件已不在对象存储中"), 410)
    cloud_drive.require_available(record)
    require_cloud_file_fresh(record)
    if record["stored_at"]:
        return record
    if not client:
        raise StorageUnavailable()
    verify_object_size(client, record)
    with connection:
        identifier = record["id"]
        now = utc_now()
        connection.execute("""UPDATE cloud_files SET stored_at=? WHERE id=? AND cleared_at IS NULL AND stored_at IS NULL
            AND trashed_at IS NULL AND (expires_at IS NULL OR expires_at>?)""", (now, identifier, now))
        result = get_cloud_file(connection, identifier)
        if result["cleared_at"]:
            raise AdminError(Text("文件已不在对象存储中"), 410)
        cloud_drive.require_available(result)
        require_cloud_file_fresh(result)
        return result


def stream_cloud_copy(source, record, upload, progress):
    """Post signed fields, then stream an exact number of original bytes as the last form part."""
    target = urlsplit(upload["url"])
    if target.scheme != "https" or not target.hostname or target.username is not None or target.fragment:
        raise StorageUnavailable()
    boundary = uuid.uuid4().hex
    fields = upload["fields"]
    prefix = bytearray()
    for name, value in fields.items():
        if not re.fullmatch(r"[A-Za-z0-9_-]+", name) or not isinstance(value, str):
            raise StorageUnavailable()
        prefix.extend(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode("utf-8"))
    prefix.extend((f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="file"\r\n'
                   f'Content-Type: {record["content_type"]}\r\n\r\n').encode("ascii"))
    suffix = f"\r\n--{boundary}--\r\n".encode("ascii")

    def parts():
        yield bytes(prefix)
        remaining = record["size"]
        while remaining:
            chunk = source.read(min(CLOUD_COPY_CHUNK_BYTES, remaining))
            if not chunk:
                raise StorageUnavailable()
            remaining -= len(chunk)
            yield chunk
            progress("uploading", 0.95 * (1 - remaining / record["size"]))
        yield suffix

    path = (target.path or "/") + ("?" + target.query if target.query else "")
    try:
        with closing(HTTPSConnection(target.hostname, target.port, timeout=CLOUD_COPY_TIMEOUT_SECONDS)) as connection:
            connection.request("POST", path, parts(), {
                "Content-Type": f"multipart/form-data; boundary={boundary}",
                "Content-Length": str(len(prefix) + record["size"] + len(suffix)),
            })
            with connection.getresponse() as response:
                if not 200 <= response.status < 300:
                    raise StorageUnavailable()
    except (HTTPException, OSError, ValueError):
        raise StorageUnavailable() from None


def get_object_attachment(connection, room_id, identifier):
    """Find an object-storage record in its original room."""
    row = connection.execute("SELECT * FROM attachments WHERE room_id=? AND id=? AND storage='object'",
                             (room_id, identifier)).fetchone()
    if row is None:
        raise LookupError(Text("附件不存在"))
    return row


def cloud_land_target(payload):
    """Validate a cross-room request's immutable permit binding."""
    room, source, attachment, cloud_file = (payload.get(key) for key in ("room", "attachment_room", "attachment_id", "cloud_file_id"))
    if not isinstance(room, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", room):
        raise ValueError(Text("房间编号无效"))
    if cloud_file is not None:
        if source is not None or attachment is not None:
            raise ValueError(Text("附件编号无效"))
        identifier = cloud_file
    else:
        if not isinstance(source, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", source) or room == source:
            raise ValueError(Text("房间编号无效"))
        identifier = attachment
    if not isinstance(identifier, str) or not re.fullmatch(r"[0-9a-f]{32}", identifier):
        raise ValueError(Text("附件编号无效"))
    return room, source, identifier


def cloud_land_source(connection, target):
    """Locate an available cloud file or a sent cloud attachment in this account."""
    _, source, identifier = target
    row = (get_cloud_file(connection, identifier) if source is None
           else get_object_attachment(connection, source, identifier))
    if (source is not None and not row["message_id"]) or not row["stored_at"] or not row["object_name"] or row["cleared_at"]:
        raise LookupError(Text("附件不存在"))
    if source is None:
        cloud_drive.require_available(row)
        if row["purpose"] != "keep":
            raise LookupError(Text("附件不存在"))
    return row


def object_download_result(connection, database, attachment):
    """Sign a stored object only after its attachment has passed room read permissions."""
    row = get_object_attachment(connection, attachment["room_id"], attachment["id"])
    return stored_object_download(database, row)


def stored_object_download(database, row):
    """Sign a stored object from either table using the configured cloud client."""
    cloud_drive.require_available(row)
    if "expires_at" in row.keys():
        require_cloud_file_fresh(row)
    if not row["object_name"] or row["cleared_at"]:
        raise AdminError(Text("文件已不在对象存储中"), 410)
    if row["stored_at"] is None:
        raise FileExistsError(Text("附件尚未完成上传"))
    client = configured_storage(database)
    if not client:
        raise AdminError(Text("对象存储暂不可用"), 503)
    try:
        link = client.download(row["object_name"])
    except ObjectMissing:
        raise AdminError(Text("文件已不在对象存储中"), 410) from None
    except StorageUnavailable as error:
        raise storage_http_error(error) from None
    return {**link, "size": row["size"], "file_name": row["file_name"]}


def queued_attachment_ids(connection, room_id):
    """Return the attachments that queued messages in this room will send."""
    return {identifier for row in connection.execute("SELECT payload FROM queued_messages WHERE room_id=?", (room_id,))
            for identifier in json.loads(row[0]).get("attachment_ids") or []}


def unsent_attachment_rows(connection, room_id):
    """Files uploaded in this room that no message took and no queued message is waiting to send."""
    queued = queued_attachment_ids(connection, room_id)
    return [row for row in connection.execute("SELECT * FROM attachments WHERE room_id=? AND message_id IS NULL", (room_id,))
            if row["id"] not in queued]


def record_object_attachment_delete_failure(connection, row):
    """Record a failed deletion if the room still exists."""
    connection.execute("""INSERT INTO room_events (room_id,at,kind,data)
        SELECT ?,?,'attachment.object_delete_failed',? WHERE EXISTS (SELECT 1 FROM rooms WHERE id=?)""",
        (row["room_id"], int(time.time() * 1000), json.dumps({"attachment_id": row["id"]}), row["room_id"]))


def delete_remote_attachment(database, row, client, *, connection=None, raise_failure=False):
    """Delete one COS file and log failure without recording credential details."""
    try:
        if not client:
            raise StorageUnavailable()
        client.delete(row["object_name"])
    except StorageUnavailable as error:
        logging.warning("Object attachment cleanup failed: room=%s attachment=%s", row["room_id"], row["id"])
        try:
            if connection is not None:
                record_object_attachment_delete_failure(connection, row)
            else:
                with closing(connect_db(database)) as events, events:
                    record_object_attachment_delete_failure(events, row)
        except sqlite3.Error:
            logging.warning("Could not record object attachment cleanup failure")
        if raise_failure:
            raise storage_http_error(error) from None
        return False
    return True


def delete_remote_attachments(database, rows):
    """Try to delete room-owned COS files and return the number of failures."""
    rows = list(rows)
    if not rows:
        return 0
    client = configured_storage(database)
    return sum(not delete_remote_attachment(database, row, client) for row in rows)


def remove_attachment_files(connection, database, rows):
    """Delete unsent uploads and their bytes; the caller commits."""
    for row in rows:
        connection.execute("DELETE FROM attachments WHERE id=? AND message_id IS NULL", (row["id"],))
        attachment_path(database, row).unlink(missing_ok=True)
        thumbnail_path(database, row).unlink(missing_ok=True)


def prune_unsent_attachments(connection, database, room_id):
    """Drop files uploaded ahead of sending but never sent, once they are older than a draft could still be waiting."""
    remove_attachment_files(connection, database, [row for row in expired_unsent_attachments(connection, room_id)
                                                  if row["storage"] != "object"])


def expired_unsent_attachments(connection, room_id):
    """Select expired uploads with no sent or queued message in the room."""
    cutoff = datetime.now(timezone.utc) - UNSENT_ATTACHMENT_TTL
    return [row for row in unsent_attachment_rows(connection, room_id)
            if datetime.fromisoformat(row["created_at"]) < cutoff]


def sweep_unsent_object_attachments(connection, database, identifiers):
    """Delete stale upload drafts only after confirming that each remote object is gone."""
    if not identifiers:
        return
    client = configured_storage(database)
    for identifier in identifiers:
        # Keep the draft from being attached to a message while its object is being deleted.
        with connection:
            begin_write(connection)
            row = connection.execute(f"""SELECT id,room_id,object_name FROM attachments
                WHERE id=? AND message_id IS NULL AND {LIVE_CLOUD_ATTACHMENTS}""", (identifier,)).fetchone()
            if not row or identifier in queued_attachment_ids(connection, row["room_id"]):
                continue
            if delete_remote_attachment(database, row, client, connection=connection):
                connection.execute("DELETE FROM attachments WHERE id=?", (identifier,))


def sweep_object_attachments(connection, database, expired_drafts):
    """Delete expired objects first, then mark only confirmed deletions as cleared."""
    retention = object_storage_retention_days(database)
    if not retention:
        return set()
    cutoff = datetime.now(timezone.utc) - timedelta(days=retention)
    rows = connection.execute(f"""SELECT id,room_id,object_name FROM attachments
        WHERE {LIVE_CLOUD_ATTACHMENTS} AND julianday(stored_at) <= julianday(?)""", (cutoff.isoformat(),)).fetchall()
    if not rows:
        return set()
    client = configured_storage(database)
    # The draft sweep already tried these objects. Retry failures on the next sweep.
    removed = [row for row in rows if row["id"] not in expired_drafts and delete_remote_attachment(database, row, client)]
    with connection:
        return {row["room_id"] for row in mark_cleared_object_attachments(connection, removed)}


def mark_cleared_object_attachments(connection, rows):
    """Record verified remote deletions and update the affected room revisions."""
    if not rows:
        return []
    cleared = []
    begin_write(connection)
    now = utc_iso_now()
    for row in rows:
        changed = connection.execute("UPDATE attachments SET cleared_at=? WHERE id=? AND cleared_at IS NULL",
                                     (now, row["id"]))
        if changed.rowcount:
            cleared.append(row)
    for room_id in {row["room_id"] for row in cleared}:
        connection.execute("UPDATE room_revisions SET revision=(SELECT MAX(revision)+1 FROM room_revisions) WHERE room_id=?",
                           (room_id,))
    return cleared


def sweep_cloud_file_drafts(connection, database):
    """Delete abandoned cloud-file uploads on confirmed removal, retaining failures for retry."""
    cutoff = (datetime.now(timezone.utc) - UNSENT_ATTACHMENT_TTL).isoformat()
    candidates = connection.execute("""SELECT id FROM cloud_files
        WHERE purpose='keep' AND stored_at IS NULL AND cleared_at IS NULL AND trashed_at IS NULL AND created_at<?""", (cutoff,)).fetchall()
    if not candidates:
        return
    client = configured_storage(database)
    for candidate in candidates:
        with connection:
            begin_write(connection)
            row = connection.execute("""SELECT * FROM cloud_files
                WHERE id=? AND purpose='keep' AND stored_at IS NULL AND cleared_at IS NULL AND trashed_at IS NULL AND created_at<?""",
                (candidate["id"], cutoff)).fetchone()
            if row and delete_remote_attachment(database, row, client, connection=connection):
                connection.execute("DELETE FROM cloud_files WHERE id=?", (row["id"],))


def sweep_cloud_transfers(connection, database):
    """Expire temporary objects only after confirming remote deletion."""
    now = utc_now()
    due = "purpose != 'keep' AND cleared_at IS NULL AND expires_at<=?"
    candidates = connection.execute(f"SELECT id,room_id,object_name FROM cloud_files WHERE {due}", (now,)).fetchall()
    if not candidates:
        return
    client = configured_storage(database)
    for row in candidates:
        # Expired reservations cannot be reissued or completed. No writer lock is needed during remote deletion.
        if delete_remote_attachment(database, row, client):
            with connection:
                connection.execute(f"UPDATE cloud_files SET cleared_at=? WHERE id=? AND {due}", (utc_now(), row["id"], now))


def sweep_attachments(database, *, expire_objects=True):
    """Clean local and remote attachment bytes; return rooms whose objects expired."""
    expired, cloud_drafts, rooms_changed = set(), set(), set()
    try:
        with closing(connect_db(database)) as connection:
            with connection:
                begin_write(connection)
                rooms = connection.execute("SELECT DISTINCT room_id FROM attachments WHERE message_id IS NULL").fetchall()
                for room in rooms:
                    for row in expired_unsent_attachments(connection, room[0]):
                        if row["storage"] == "object" and row["object_name"] and not row["cleared_at"]:
                            cloud_drafts.add(row["id"])
                        else:
                            expired.add(row["id"])
                connection.executemany("DELETE FROM attachments WHERE id=? AND message_id IS NULL", ((key,) for key in expired))
            sweep_unsent_object_attachments(connection, database, cloud_drafts)
            if expire_objects:
                sweep_cloud_file_drafts(connection, database)
                sweep_cloud_transfers(connection, database)
                cloud_drive.sweep_trash(connection, database)
                rooms_changed = sweep_object_attachments(connection, database, cloud_drafts)
            root = attachment_path(database, {"id": ""})
            if not root.exists() or root.resolve() != root:
                return rooms_changed
            # Uploads acquire this same write lock before creating their file. Hold it from the ID snapshot through unlink.
            with connection:
                begin_write(connection)
                registered = {os.path.normcase(row[0]) for row in connection.execute("SELECT id FROM attachments")}
                registered.update("cloud-" + row[0] for row in connection.execute(
                    "SELECT id FROM cloud_files WHERE thumbnail_type IS NOT NULL AND cleared_at IS NULL"))
                cutoff = time.time() - ORPHAN_ATTACHMENT_GRACE_SECONDS
                for path in root.iterdir():
                    # A thumbnail goes with its original.
                    name = path.name.removesuffix(THUMBNAIL_SUFFIX)
                    if os.path.normcase(name) in registered:
                        continue
                    try:
                        info = path.lstat()
                        if stat.S_ISREG(info.st_mode) and (name in expired or info.st_mtime < cutoff):
                            path.unlink()
                    except FileNotFoundError:
                        pass
                    except OSError:
                        logging.warning("Could not remove attachment %s", path.name, exc_info=True)
    except (OSError, sqlite3.Error, ValueError):
        logging.exception("Attachment sweep failed for %s", database)
    return rooms_changed


def discard_attachment(connection, database, room_id, identifier, token):
    """The uploader takes back a file it uploaded ahead of sending; a sent or queued file stays."""
    attachment = get_attachment(connection, room_id, identifier)
    actor = authorize_free_write(connection, room_id, token, "attachments", {"author": attachment["actor"]})
    if (actor if isinstance(actor, str) else actor["name"]) != attachment["actor"]:
        raise PermissionError(Text('只能撤下自己上传的附件'))
    row = next((item for item in unsent_attachment_rows(connection, room_id) if item["id"] == identifier), None)
    if row is None:
        raise FileExistsError(Text('附件已随消息发出或正在排队，不能撤下'))
    remove_attachment_files(connection, database, [row])
    connection.commit()
    if row["storage"] == "object" and row["object_name"]:
        delete_remote_attachments(database, [row])
    return {"discarded": identifier}


def attachment_usage(connection, room_id, token):
    """List every sent file of the room with its size and state, for the owner choosing what to clear."""
    require_room(connection, room_id)
    require_owner(connection, room_id, token)
    rows = connection.execute("""SELECT * FROM attachments WHERE room_id=? AND message_id IS NOT NULL
        ORDER BY message_id,position,id""", (room_id,)).fetchall()
    files = [{**attachment_view(connection, row), "number": index + 1} for index, row in enumerate(rows)]
    return {"attachments": files, "bytes": sum(item["size"] for item in files if not item["cleared_at"])}


def clear_attachments(connection, database, room_id, payload, token):
    """Delete the original bytes of chosen sent files to free space; records, numbers and thumbnails stay.

    Args:
        payload: ``{"ids": [attachment ID, ...]}``; IDs already cleared are skipped.

    Returns:
        ``{"cleared": [IDs cleared now], "freed_bytes": int}``.
    """
    begin_write(connection)
    require_room(connection, room_id)
    require_owner(connection, room_id, token)
    identifiers = payload.get("ids")
    if not isinstance(identifiers, list) or not identifiers or not all(isinstance(item, str) for item in identifiers):
        raise ValueError(Text('ids 须为非空的附件 ID 列表'))
    marks = ",".join("?" * len(set(identifiers)))
    rows = connection.execute(f"""SELECT * FROM attachments WHERE room_id=? AND message_id IS NOT NULL
        AND cleared_at IS NULL AND id IN ({marks})""", (room_id, *set(identifiers))).fetchall()
    known = {row[0] for row in connection.execute(f"SELECT id FROM attachments WHERE room_id=? AND message_id IS NOT NULL AND id IN ({marks})",
                                                  (room_id, *set(identifiers)))}
    missing = sorted(set(identifiers) - known)
    if missing:
        raise LookupError(Text('附件不存在：{ids}', ids="、".join(missing)))
    now = utc_iso_now()
    for row in rows:
        connection.execute("UPDATE attachments SET cleared_at=? WHERE id=?", (now, row["id"]))
    if rows:
        # Messages show the change, so the room's readers refresh as after an edited message.
        connection.execute("UPDATE room_revisions SET revision=(SELECT MAX(revision)+1 FROM room_revisions) WHERE room_id=?", (room_id,))
    connection.commit()
    for row in rows:
        try:
            attachment_path(database, row).unlink(missing_ok=True)
        except OSError:
            logging.warning("Could not remove cleared attachment %s", row["id"], exc_info=True)
    delete_remote_attachments(database, [row for row in rows if row["storage"] == "object" and row["object_name"]])
    return {"cleared": [row["id"] for row in rows], "freed_bytes": sum(row["size"] for row in rows)}


def check_message_attachments(connection, room_id, actor, identifiers):
    """Reject references to another room, uploader, or already published message."""
    for identifier in identifiers:
        attachment = get_attachment(connection, room_id, identifier)
        if attachment["actor"] != actor or attachment["message_id"] is not None:
            raise FileExistsError(Text('附件已用于其他消息，或不属于本次实际提交者'))
        if attachment.get("storage") == "object" and not attachment["stored"]:
            raise ValueError(Text("附件尚未完成上传"))


def message_summary(payload, message):
    """Preserve a supplied summary and distinguish its writer from the answer's author."""
    summary = str(payload.get("summary", "")).strip()
    if len(summary) > MAX_SUMMARY_LENGTH:
        raise ValueError(Text('回答摘要最多 {value1} 字', value1=MAX_SUMMARY_LENGTH))
    summary_by = payload.get("summary_by", message["submitted_by"]) if summary else ""
    if summary and (message["kind"] not in ("opinion", "chat") or summary_by not in (message["author"], message["submitted_by"])):
        raise ValueError(Text('摘要仅用于观点，撰写者须为原作者或实际提交者'))
    return {"summary": summary, "summary_by": summary_by}


def check_message_references(connection, room_id, message):
    """Keep replies within their declared topic."""
    if message["reply_to"] and not connection.execute("SELECT id FROM messages WHERE room_id=? AND id=?", (room_id, message["reply_to"])).fetchone():
        raise ValueError(Text('回复的消息不在当前房间中'))


CAPTURE_REFUSED_FIELDS = ("to", "handoff", "continue", "sequential", "loop", "parallel", "gates", "detach", "need_rounds",
                          "next_review", "review_scope", "proactive", "request_ids", "reply_to", "attachment_ids", "keep_working")


def check_captured_reply(payload):
    """A reply the local service captured after the software ended unsubmitted: it answers its execution and nothing more."""
    if type(payload.get("execution_id")) is not int or any(payload.get(field) for field in CAPTURE_REFUSED_FIELDS):
        raise ValueError(Text('自动收录的回答只能关联本次执行 execution_id，不能派活、续跑、引用或带附件'))


def awaiting_user_flag(payload, actor):
    """Validate the flag before writing, leaving normal execution/proactive checks in place."""
    awaiting_user = payload.get("awaiting_user", False)
    if type(awaiting_user) is not bool:
        raise ValueError(Text("awaiting_user 须为布尔值"))
    if awaiting_user and (actor == "用户" or payload.get("kind") not in (None, "chat")
                          or (type(payload.get("execution_id")) is not int and payload.get("proactive") is not True)):
        raise ValueError(Text("awaiting_user 只能用于绑定执行的回答或主动发言"))
    return awaiting_user


def update_room_waits(connection, room_id, message_id, actor, payload):
    """Close any replaced wait and store the optional new wait at the message timestamp."""
    message_time = connection.execute("SELECT CAST(strftime('%s',created_at) AS INTEGER) FROM messages WHERE id=?", (message_id,)).fetchone()[0]
    if actor == "用户":
        if not payload.get("relay"):
            connection.execute("""UPDATE room_waits SET ended_at=?,end_message_id=?,end_reason='user'
                WHERE room_id=? AND ended_at=0""", (message_time, message_id, room_id))
        return
    connection.execute("""UPDATE room_waits SET ended_at=?,end_reason='superseded'
        WHERE member_id=? AND ended_at=0""", (message_time, actor["id"]))
    if payload.get("awaiting_user"):
        connection.execute("INSERT INTO room_waits(room_id,message_id,member_id,created_at) VALUES (?,?,?,?)",
                           (room_id, message_id, actor["id"], message_time))


def append_free_message(connection, room, payload, actor):
    """Append a free-room message: the owner's creates requests, a member's completes its execution."""
    awaiting_user = awaiting_user_flag(payload, actor)
    if payload.get("kind") == "moderation":
        if any(payload.get(field) for field in ("next_review", "review_scope", "review_roster", "sequential", "loop", "parallel", "gates", "detach", "need_rounds", "keep_working")):
            raise ValueError(Text('主持说明不能声明评审授权、依次接力或申请轮数；请在派活时提交'))
        return append_free_moderation(connection, room, payload, actor)
    if payload.get("kind") not in (None, "chat"):
        raise ValueError(Text('房间请求与讨论的回答都使用 kind=chat，并以 execution_id 或 request_ids 关联请求'))
    resolve_member_fields(connection, room["id"], payload)
    if payload.get("turn_id") is not None and current_session(connection, room["id"], active_only=True):
        raise ValueError(Text('新讨论使用 kind=chat，并以 execution_id 或 request_ids 关联请求'))
    author, text, submission_id, reply_to = message_values(payload)
    room_id = room["id"]
    if actor == "用户" and (author != "用户" or payload.get("submitted_by", "用户") != "用户"):
        raise PermissionError(Text('房间控制凭据只能以用户身份发言'))
    if payload.get("relay") is not None and not isinstance(payload["relay"], dict):
        raise ValueError(Text("relay 须为含 room_id 与 host 的对象"))
    if payload.get("relay") is not None and actor != "用户":
        # Another room's host speaks here through `host-control room-post`, only with the owner credential.
        raise PermissionError(Text('只有房间控制凭据能代其他房间的主持人发言'))
    submitted_by = author
    source = payload.get("source") if payload.get("source") in ("api", "auto") else "cli"
    expected = {"author": author, "text": text, "reply_to": reply_to, "kind": "chat", "submitted_by": submitted_by,
                "source": "user" if author == "用户" else source}
    if expected["source"] == "auto":
        check_captured_reply(payload)
    expected.update(message_summary(payload, expected))
    identifiers = attachment_ids(payload)
    previous = connection.execute(f"{MESSAGE_QUERY} WHERE room_id=? AND submission_id=?", (room_id, room_id, submission_id)).fetchone()
    if previous:
        previous = message_with_attachments(connection, previous)
        if ((previous.get("relay_room") or None) != (payload.get("relay") or {}).get("room_id")
                or any(previous[key] != renumbered_expected(expected, payload, previous)[key] for key in ("author", "text", "reply_to", "kind", "submitted_by", "summary", "summary_by"))
                or [item["id"] for item in previous["attachments"]] != identifiers
                or awaiting_user != bool(connection.execute("SELECT 1 FROM room_waits WHERE message_id=?", (previous["id"],)).fetchone())):
            raise FileExistsError(Text('这个提交编号已被另一条内容使用，请为新发言生成新编号'))
        check_review_retry(connection, room_id, previous["id"], payload)
        return {"message": previous, "duplicate": True}
    if room["archived"]:
        raise ValueError(Text('房间已存档；恢复后才能继续协作'))
    if payload.get("relay") is not None:
        check_relay(connection, room_id, payload["relay"])
    check_message_references(connection, room_id, expected)
    check_message_attachments(connection, room_id, submitted_by, identifiers)
    # `/goal` and `/discuss` are commands: checked before saving, never queued, and not routed to members.
    mode_command = check_mode_command(connection, room_id, payload) if actor == "用户" and not payload.get("relay") else None
    waiting = queue_split(connection, room_id, payload) if actor == "用户" and not mode_command else None
    if waiting == "all":
        return {**enqueue(connection, room_id, payload), "queue": queue_view(connection, room_id)}
    if waiting:
        # A side question naming free and busy members: the free ones answer now, the busy ones' share waits in the queue.
        queued_share, payload = payload, {**payload, "to": [name for name in payload["to"] if name not in waiting]}
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
    link_message_attachments(connection, room_id, cursor.lastrowid, identifiers, text, payload)
    if payload.get("relay") is not None:
        save_message_relay(connection, room_id, cursor.lastrowid, payload["relay"])
    # A captured reply keeps its text, but its mentions wake nobody: only a submitted answer may ask for a host.
    if expected["source"] != "auto":
        save_suggestions(connection, room_id, cursor.lastrowid, actor, payload)
    save_review_plan(connection, room_id, cursor.lastrowid, review_plan)
    update_room_waits(connection, room_id, cursor.lastrowid, actor, payload)
    if actor != "用户" and payload.get("proactive") is True:
        # Spoken on its own: it completes no request; only the host's may dispatch.
        after_proactive(connection, room_id, cursor.lastrowid, actor, payload)
    elif mode_command:
        apply_mode_command(connection, room_id, cursor.lastrowid, mode_command)
    else:
        after_free_message(connection, room_id, cursor.lastrowid, actor, payload)
    if payload.get("proactive") is not True:
        complete_session_requests(connection, room_id, payload, actor, cursor.lastrowid)
    saved_message = connection.execute(f"{MESSAGE_QUERY} WHERE messages.id=?", (room_id, cursor.lastrowid)).fetchone()
    if waiting:
        enqueue_share(connection, room_id, queued_share, cursor.lastrowid, waiting)
        return {"message": message_with_attachments(connection, saved_message), "duplicate": False, "queue": queue_view(connection, room_id)}
    return {"message": message_with_attachments(connection, saved_message), "duplicate": False}


def append_free_moderation(connection, room, payload, actor):
    """Save a host note against its live host task without answering or routing it."""
    author, text, submission_id, reply_to = message_values(payload)
    if author != room["host"] or payload.get("submitted_by", author) != author:
        raise ValueError(Text('主持说明须保留当前主持人署名'))
    if not isinstance(actor, dict) or actor.get("role") != "host" or actor.get("name") != room["host"]:
        raise PermissionError(Text('主持说明只能由当前主持成员提交'))
    if payload.get("to") or payload.get("handoff") or payload.get("turn_id") is not None:
        raise ValueError(Text('主持说明不能派活或关联发言轮次'))
    if actor["access"] == "manual":
        ids = payload.get("request_ids")
        if payload.get("execution_id") is not None or not isinstance(ids, list) or not ids:
            raise ValueError(Text('手动主持说明须关联有效的主持请求 request_ids'))
        check_answer(connection, room["id"], actor, payload)
        rows = connection.execute("SELECT purpose FROM member_requests WHERE room_id=? AND id IN (%s)" % ",".join("?" for _ in ids),
                                  (room["id"], *ids)).fetchall()
        if len(rows) != len(set(ids)) or any(row["purpose"] != "discuss_host" for row in rows):
            raise ValueError(Text('主持说明只能关联当前有效的主持请求'))
    else:
        if payload.get("request_ids"):
            raise ValueError(Text('自动主持说明须关联执行编号 execution_id'))
        execution = check_answer(connection, room["id"], actor, payload)
        purposes = [row[0] for row in connection.execute(
            "SELECT purpose FROM member_requests WHERE execution_id=? AND status='delivering'", (execution["id"],))]
        if not purposes or any(purpose != "discuss_host" for purpose in purposes):
            raise ValueError(Text('主持说明只能关联当前有效的主持执行'))
    expected = {"author": author, "text": text, "reply_to": reply_to, "kind": "moderation",
                "submitted_by": author, "source": payload.get("source") if payload.get("source") in ("cli", "api") else "cli"}
    expected.update(message_summary(payload, expected))
    identifiers = attachment_ids(payload)
    previous = connection.execute(f"{MESSAGE_QUERY} WHERE room_id=? AND submission_id=?",
                                  (room["id"], room["id"], submission_id)).fetchone()
    if previous:
        previous = message_with_attachments(connection, previous)
        if any(previous[key] != renumbered_expected(expected, payload, previous)[key] for key in ("author", "text", "reply_to", "kind", "submitted_by", "summary", "summary_by")) or [item["id"] for item in previous["attachments"]] != identifiers:
            raise FileExistsError(Text('这个提交编号已被另一条内容使用，请为新发言生成新编号'))
        return {"message": previous, "duplicate": True}
    check_message_references(connection, room["id"], expected)
    check_message_attachments(connection, room["id"], author, identifiers)
    cursor = connection.execute("INSERT INTO messages (room_id,author,text,reply_to,source,submission_id,created_at) VALUES (?,?,?,?,?,?,?)",
                                (room["id"], author, text, reply_to, expected["source"], submission_id, utc_now()))
    connection.execute("INSERT INTO message_details (message_id,kind,submitted_by) VALUES (?,?,?)",
                       (cursor.lastrowid, "moderation", author))
    connection.execute("INSERT INTO message_summaries (message_id,text,author) VALUES (?,?,?)",
                       (cursor.lastrowid, "", ""))
    link_message_attachments(connection, room["id"], cursor.lastrowid, identifiers, text, payload)
    saved_message = connection.execute(f"{MESSAGE_QUERY} WHERE messages.id=?", (room["id"], cursor.lastrowid)).fetchone()
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


# The header `launch host-control` adds: the acting host's own member credential, beside the owner's it writes with.
ACTING_MEMBER_HEADER = "X-Acting-Member-Token"
READ_ONLY_HEADER = "X-Discussion-Read-Only"
# Reads that change the room: the runner's inbox fires timers and expiries, the external list ends expired members.
READ_ONLY_CLOSED = (["inbox"], ["external-members"], ["room-links"])

# How much of a summary a receipt keeps; the full summary stays one `message view` away.
RECEIPT_SUMMARY_CHARS = 200


def message_receipt(connection, room_id, result):
    """The one compact receipt CLI and API both show after a message write (spec #3262 item 4).

    `text_chars` counts Unicode code points of the stored text and `text_sha256` hashes its UTF-8 bytes, both after the
    summary front matter was split off; `request_ids` lists every request this message answered, and `completed` says
    whether it closed any request (a proactive message or a moderation note closes none)."""
    message = result.get("message")
    if not isinstance(message, dict):
        return None
    text = message.get("text") or ""
    requests = [row[0] for row in connection.execute(
        "SELECT id FROM member_requests WHERE room_id=? AND answer_id=? ORDER BY id", (room_id, message["id"]))]
    summary = message.get("summary") or ""
    receipt = {"duplicate": bool(result.get("duplicate")), "id": message["id"], "author": message["author"],
               "author_label": member_display_names(connection, room_id).get(message["author"], message["author"]),
               "kind": message.get("kind"), "execution_id": message.get("execution_id"), "request_ids": requests,
               "reply_to": message.get("reply_to"), "submission_id": message.get("submission_id"),
               "created_at": message.get("created_at"), "summary": summary[:RECEIPT_SUMMARY_CHARS],
               "text_chars": len(text), "text_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
               "attachments": len(message.get("attachments") or []), "proactive": bool(message.get("proactive")),
               "completed": bool(requests)}
    if len(summary) > RECEIPT_SUMMARY_CHARS:
        receipt["summary_truncated"] = True
    return {key: value for key, value in receipt.items() if value not in (None, "")}


def append_message(connection, room_id, payload, actor):
    """Atomically append an attributed message for the owner or one member, as authorized by `actor`."""
    message_values(payload)
    begin_write(connection)
    room = require_room(connection, room_id)
    if payload.get("steward_proactive") is True:
        if "awaiting_user" in payload:
            raise ValueError(Text("awaiting_user 只能用于绑定执行的回答或主动发言"))
        return append_steward_trigger(connection, room, payload, actor)
    return append_room_message(connection, room, payload, actor)


def append_steward_trigger(connection, room, payload, actor):
    """Write a narrator message and its single task, only for the idle MOSS room's owner."""
    if actor != "用户" or room["system_kind"] != "steward" or room["archived"]:
        raise PermissionError(Text("需要本房间的控制凭据"))
    room_id, submission = room["id"], payload["submission_id"]
    old = connection.execute(f"{MESSAGE_QUERY} WHERE room_id=? AND submission_id=?", (room_id, room_id, submission)).fetchone()
    if old:
        message = message_with_attachments(connection, old)
        events = message["texts"].get("text", {}).get("params", {}).get("events", message["text"])
        if message["texts"].get("template") != STEWARD_PROACTIVE_TEMPLATE or events != payload["text"]:
            raise FileExistsError(Text('这个提交编号已被另一条内容使用，请为新发言生成新编号'))
        return {"message": message, "duplicate": True}
    host = connection.execute("SELECT id FROM room_members WHERE room_id=? AND role='host' AND status='active'", (room_id,)).fetchone()
    if not host or connection.execute("SELECT 1 FROM member_requests WHERE member_id=? AND status IN ('pending','delivering')", (host["id"],)).fetchone() or connection.execute(
            "SELECT 1 FROM member_executions WHERE member_id=? AND status IN ('dispatched','started')", (host["id"],)).fetchone():
        return {"busy": True, "duplicate": True}
    display = Text("主动汇报触发：{events}", events=payload["text"])
    message_id = connection.execute("INSERT INTO messages(room_id,author,text,source,submission_id,created_at) VALUES(?, '系统',?,'system',?,?)",
                                     (room_id, str(display), submission, utc_now())).lastrowid
    connection.execute("INSERT INTO message_details(message_id,kind,submitted_by) VALUES(?,'notice','系统')", (message_id,))
    save_text(connection, "message", message_id, "trigger", Text(STEWARD_PROACTIVE_TEMPLATE))
    save_text(connection, "message", message_id, "text", display)
    insert_request(connection, room_id, host["id"], message_id, message_id, "notice", "system")
    return {"message": get_message(connection, room_id, message_id), "duplicate": False}


def post_host_relay(connection, host, target, payload, execution_id):
    """Send a cross-room message and bind its local receipt when it answers this host's request."""
    incoming = payload["relay"]
    room_id = incoming["room_id"]
    if execution_id is not None and type(execution_id) is not int:
        raise ValueError(Text("成员回答须关联本次执行编号 execution_id"))
    payload["text"] = message_values(payload)[1]
    begin_write(connection)
    room = require_room(connection, target)
    source = connection.execute("SELECT system_kind FROM room_directory WHERE room_id=?", (room_id,)).fetchone()
    if source["system_kind"] == "steward":
        if room["system_kind"] or payload.get("interrupt") is True:
            raise PermissionError(Text("MOSS 只能给项目房间的主持人留言，不能打断执行"))
        if not any(member["role"] == "host" for member in active_members(connection, target).values()):
            raise FileExistsError(Text("目标房间没有在场的主持人"))
    if delegation := moss_results.delegation_for_reply(connection, target, room_id, incoming.get("reply_to")):
        return post_moss_report(connection, host, payload, execution_id, delegation)
    request = connection.execute("""SELECT r.id,r.answer_id,m.submission_id,m.text,s.target_message_id,s.queued_id,s.interrupted FROM member_requests r
        JOIN message_relays relay ON relay.message_id=r.message_id
        LEFT JOIN messages m ON m.id=r.answer_id LEFT JOIN room_relay_sends s ON s.message_id=r.answer_id
        WHERE r.room_id=? AND r.member_id=? AND r.execution_id=? AND r.message_id=?
          AND relay.source_room_id=? AND relay.expect='reply'""",
        (room_id, host["id"], execution_id, incoming.get("reply_to"), target)).fetchone()
    if not request:
        return send_new_host_relay(connection, host, room, payload, execution_id)
    # Use the CLI's existing receipt key so a retry produces the same card.
    key = relay_submission_key(target, payload["submission_id"])
    answer = {"execution_id": execution_id, "text": payload["text"]}
    if request["answer_id"]:
        if request["submission_id"] != key:
            raise FileExistsError(Text("这个请求已回答"))
        if request["text"] != payload["text"]:
            raise FileExistsError(Text("这个提交编号已被另一条内容使用，请为新发言生成新编号"))
        delivery = ({"message": {"id": request["target_message_id"]}} if request["target_message_id"]
                    else {"queued": request["queued_id"]})
        return {**delivery, "answer_id": request["answer_id"], "interrupted": bool(request["interrupted"])}
    check_answer(connection, room_id, host, answer)
    incoming["expect"] = "none"
    result = append_room_message(connection, room, payload, "用户")
    sent = result.get("message") or {}
    if sent and sent.get("relay_reply_to") != incoming["reply_to"]:
        raise FileExistsError(Text("这个提交编号已被另一条内容使用，请为新发言生成新编号"))
    receipt = save_relay_receipt(connection, room_id, dict(target_room_id=target, host=incoming["host"],
        member=host["name"], text=payload["text"], submission_id=key, target_submission_id=payload["submission_id"],
        target_message_id=(result.get("message") or {}).get("id"), queued_id=result.get("queued"),
        interrupted=result.get("interrupted", False)))
    # Other questions bundled in this execution still need their own answer.
    connection.execute("""UPDATE member_requests SET status='pending',execution_id=NULL
        WHERE execution_id=? AND status='delivering' AND id<>?""", (execution_id, request["id"]))
    after_free_message(connection, room_id, receipt["message_id"], host, answer)
    drain_room_queue(connection, room_id)
    return {**result, "answer_id": receipt["message_id"]}


def relay_submission_key(target, submission):
    """Use the runner's sender-receipt key, including when the server writes the receipt first."""
    signature = json.dumps([target, submission], separators=(",", ":"), ensure_ascii=False)
    return "sent-" + hashlib.sha256(signature.encode()).hexdigest()


def send_new_host_relay(connection, host, room, payload, execution_id):
    """Track new MOSS delegations and their decision relays without altering ordinary room messages."""
    source, target = host["room_id"], room["id"]
    expects_reply = payload["relay"].get("expect", "reply") == "reply"
    if expects_reply and moss_results.is_child_delegation(connection, source, target):
        return send_moss_delegation(connection, host, room, payload, execution_id)
    result = append_room_message(connection, room, payload, "用户")
    if expects_reply and moss_results.is_child_delegation(connection, target, source):
        moss_results.register_decision(connection, host, target, payload["submission_id"], execution_id)
    return result


def send_moss_delegation(connection, host, room, payload, execution_id):
    """Bind the target delivery and its sender card in the same write, even if the runner loses the reply."""
    target, submission, incoming = room["id"], payload["submission_id"], payload["relay"]
    result = append_room_message(connection, room, payload, "用户")
    receipt = save_relay_receipt(connection, host["room_id"], dict(target_room_id=target, host=incoming["host"],
        member=host["name"], text=payload["text"], submission_id=relay_submission_key(target, submission),
        target_submission_id=submission, target_message_id=(result.get("message") or {}).get("id"), queued_id=result.get("queued")))
    if connection.execute("INSERT OR IGNORE INTO moss_delegations(message_id) VALUES(?)", (receipt["message_id"],)).rowcount:
        moss_results.register_rework(connection, receipt["message_id"], host["id"], target, execution_id)
    return result


def post_moss_report(connection, host, payload, execution_id, delegation):
    """Treat an explicit child reply as a bound child answer, not a second owner message in MOSS."""
    child = delegation["child"]
    key = relay_submission_key(delegation["parent"], payload["submission_id"])
    answer = {"execution_id": execution_id, "text": payload["text"], "reply_to": delegation["root"],
              "author": host["name"], "submission_id": key, "kind": "chat"}
    previous = connection.execute("SELECT 1 FROM messages WHERE room_id=? AND submission_id=?", (child, key)).fetchone()
    if not previous:
        if delegation["state"] in moss_results.TERMINAL_STATES:
            raise FileExistsError(Text("这个请求已回答"))
        if not connection.execute("""SELECT 1 FROM member_requests WHERE room_id=? AND member_id=? AND execution_id=?
            AND chain_id=? AND status='delivering'""", (child, host["id"], execution_id, delegation["root"])).fetchone():
            raise FileExistsError(Text("原执行没有关联的请求"))
        check_answer(connection, child, host, answer)
        connection.execute("""UPDATE member_requests SET status='pending',execution_id=NULL
            WHERE execution_id=? AND status='delivering' AND chain_id<>?""", (execution_id, delegation["root"]))
    result = append_free_message(connection, require_room(connection, child), answer, host)
    drain_room_queue(connection, child)
    review = connection.execute("SELECT review_message_id FROM moss_delegations WHERE message_id=?", (delegation["message_id"],)).fetchone()[0]
    return {"answer_id": result["message"]["id"], **({"message": {"id": review}} if review else {})}


def append_room_message(connection, room, payload, actor):
    """Append to a resolved room under the current write lock."""
    room_id = room["id"]
    if not payload.get("relay"):
        return append_free_message(connection, room, payload, actor)
    if room["archived"]:
        raise FileExistsError(Text("房间已存档，不再投递"))
    if payload.get("interrupt") is not True:
        return append_free_message(connection, room, {**payload, "queue": True}, actor)
    if "awaiting_user" in payload:
        raise ValueError(Text("awaiting_user 只能用于绑定执行的回答或主动发言"))
    relay = payload["relay"]
    if actor != "用户" or not isinstance(relay, dict) or not connection.execute(
            "SELECT 1 FROM room_links WHERE room_id=? AND other_room_id=? AND relation='parent'",
            (room_id, relay.get("room_id"))).fetchone():
        raise PermissionError(Text("仅父房间主持人可以打断子房间"))
    if connection.execute("SELECT 1 FROM queued_messages WHERE room_id=? AND submission_id=?",
                          (room_id, payload["submission_id"])).fetchone():
        return {**enqueue(connection, room_id, payload), "interrupted": False}
    connection.execute("SAVEPOINT relay_send")
    result = append_free_message(connection, room, {**payload, "queue": False}, actor)
    try:
        interrupted = not result.get("duplicate") and interrupt_for_message(connection, room_id, result["message"]["id"])
    except FileExistsError as error:
        connection.execute("ROLLBACK TO relay_send")
        result = {**enqueue(connection, room_id, payload), "reason": str(error)}
        interrupted = False
    connection.execute("RELEASE relay_send")
    return {**result, "interrupted": interrupted}


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
    moss_results.reconcile_delegations(connection, room_id)


def rate_scheduler_decision(connection, room_id, decision_id, token, payload):
    """The owner marks a decision good or bad (a bad one may name who should have answered and why); rating null withdraws it."""
    begin_write(connection)
    require_owner(connection, room_id, token)
    rating, should_be, note = payload.get("rating"), payload.get("should_be", ""), payload.get("note", "")
    if rating not in ("good", "bad", None):
        raise ValueError(Text('rating 须为 good、bad 或 null'))
    if not isinstance(should_be, str) or not isinstance(note, str) or len(should_be) > MAX_DECISION_MEMBER or len(note.strip()) > MAX_DECISION_NOTE:
        raise ValueError(Text('should_be 须为成员名，note 不超过 {value1} 字', value1=MAX_DECISION_NOTE))
    if not connection.execute("SELECT 1 FROM scheduler_decisions WHERE id=? AND room_id=?", (decision_id, room_id)).fetchone():
        raise LookupError(Text('没有这条智能调度决策'))
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


HOST_DISPATCH_SQL = """EXISTS(SELECT 1 FROM member_requests r WHERE r.message_id=m.id
        AND r.created_by='host' AND r.purpose='ask')
    AND NOT EXISTS(SELECT 1 FROM free_sequences s, json_each(s.steps) step
        WHERE s.room_id=m.room_id AND s.message_id<>m.id AND json_extract(step.value,'$[2]')=m.id)"""
DISPATCH_INVALIDATIONS = ("host_withdraw", "user_stop_or_retract", "user_rewind", "failed")
USER_STOP_RESULTS = (OWNER_INTERRUPT_RESULT, OWNER_STOP_RESULT)


def is_host_dispatch(connection, message_id):
    """Whether a message created a request as host, even if the request was later stopped."""
    return connection.execute(f"SELECT 1 FROM messages m WHERE m.id=? AND {HOST_DISPATCH_SQL}",
                              (message_id,)).fetchone() is not None


def dispatch_feedback(connection, message_id):
    """Return the current owner's rating, or None."""
    row = connection.execute("SELECT rating,should_be,note,created_at FROM dispatch_feedback WHERE message_id=?",
                             (message_id,)).fetchone()
    return dict(row) if row else None


def rate_dispatch(connection, room_id, message_id, token, payload):
    """Set or clear the rating for one explicitly identified dispatch."""
    begin_write(connection)
    require_owner(connection, room_id, token)
    rating, should_be, note = payload.get("rating"), payload.get("should_be", ""), payload.get("note", "")
    if "rating" not in payload or rating not in ("good", "bad", None):
        raise ValueError(Text('rating 须为 good、bad 或 null'))
    if not isinstance(should_be, str) or not isinstance(note, str) or len(should_be) > MAX_DECISION_MEMBER or len(note.strip()) > MAX_DECISION_NOTE:
        raise ValueError(Text('should_be 须为成员名，note 不超过 {value1} 字', value1=MAX_DECISION_NOTE))
    message = connection.execute("SELECT * FROM messages WHERE id=? AND room_id=?", (message_id, room_id)).fetchone()
    if not message or not is_host_dispatch(connection, message_id):
        raise LookupError(Text('没有这条主持人派活'))
    should_be = should_be.strip()
    if rating is not None and should_be:
        handles = member_handles(connection, room_id)
        if should_be not in handles:
            choices = ", ".join(f"{label} ({name})" if label != name else name
                                for name, label in member_display_names(connection, room_id).items())
            raise ValueError(Text('未找到建议成员，可选成员：{members}', members=choices))
        should_be = handles[should_be]
    if rating is None:
        connection.execute("DELETE FROM dispatch_feedback WHERE message_id=?", (message_id,))
        connection.execute("DELETE FROM dispatch_feedback_cases WHERE message_id=?", (message_id,))
    else:
        connection.execute("""INSERT INTO dispatch_feedback VALUES (?,?,?,?,?)
            ON CONFLICT(message_id) DO UPDATE SET rating=excluded.rating,should_be=excluded.should_be,
                note=excluded.note,created_at=excluded.created_at""",
                           (message_id, rating, should_be, note.strip(), utc_now()))
        snapshot = dispatch_case(connection, message)
        connection.execute("INSERT OR REPLACE INTO dispatch_feedback_cases (message_id,room_id,snapshot) VALUES (?,?,?)",
                           (message_id, room_id, json.dumps(snapshot, ensure_ascii=False)))
    return {"message_id": message_id, "dispatch_feedback": dispatch_feedback(connection, message_id)}


def dispatch_attempts(connection, request):
    """Read the current and replaced executions for one request, including their independent usage."""
    rows = connection.execute("""SELECT e.id AS execution_id,e.status,e.model,e.effort,e.result,
            CASE WHEN e.finished_at>0 THEN MAX(0,e.finished_at-e.created_at) END AS elapsed_seconds,
            u.input,u.cache_read,u.cache_write,u.output,rr.retried_at
        FROM member_executions e LEFT JOIN execution_usage u ON u.execution_id=e.id
        LEFT JOIN retried_requests rr ON rr.execution_id=e.id AND rr.request_id=?
        WHERE e.id=? OR e.id IN (SELECT execution_id FROM retried_requests WHERE request_id=?)
        ORDER BY e.id""", (request["request_id"], request["execution_id"], request["request_id"]))
    attempts = []
    for row in rows:
        attempt = dict(row)
        usage = {key: attempt.pop(key) for key in ("input", "cache_read", "cache_write", "output")}
        attempt["usage"] = usage if usage["input"] is not None else None
        attempt["retried"] = attempt.pop("retried_at") is not None
        result = attempt.pop("result")
        attempt["invalidation_reason"] = execution_invalidation(attempt["status"], result)
        attempts.append(attempt)
    return attempts


def execution_invalidation(status, result):
    """Classify historical executions from the explicit server-generated cancellation text."""
    if status == "failed":
        return "failed"
    if status != "cancelled":
        return None
    return {HOST_WITHDRAW_RESULT: "host_withdraw", OWNER_REWIND_RESULT: "user_rewind",
            **dict.fromkeys(USER_STOP_RESULTS, "user_stop_or_retract")}.get(result)


def request_invalidations(request, attempts, legacy_withdraw=False):
    """Combine retained request provenance, transcript withdrawals and execution outcomes."""
    reasons = {attempt["invalidation_reason"] for attempt in attempts if attempt["invalidation_reason"]}
    if request["withdrawal"] == "rewound":
        reasons.add("user_rewind")
    elif request["withdrawal"] == "retracted":
        reasons.add("user_stop_or_retract")
    if request["host_withdrawn"]:
        reasons.add("host_withdraw")
    elif (request["cancel_reason"] == "user_stop" and request["execution_id"] is None
          and not legacy_withdraw and not request["withdrawal"]):
        reasons.add("user_stop_or_retract")
    return [kind for kind in DISPATCH_INVALIDATIONS if kind in reasons]


def dispatch_record(connection, message):
    """Assemble a dispatch's source and the outcomes of the requests it created."""
    message_id = message["id"]
    host_withdrawal = connection.execute("SELECT legacy,redirect_message_id FROM dispatch_withdrawals WHERE message_id=?", (message_id,)).fetchone()
    withdrawal = connection.execute("SELECT kind FROM message_withdrawals WHERE message_id=?", (message_id,)).fetchone()
    requests = connection.execute("""WITH anchors(id) AS (
            SELECT ? UNION SELECT json_extract(step.value,'$[2]')
            FROM free_sequences s, json_each(s.steps) step WHERE s.message_id=?)
        SELECT r.id AS request_id,r.chain_id,r.message_id AS anchor_id,r.execution_id,
            r.status AS request_status,m.name,l.label,m.adapter,COALESCE(c.reason,'') AS cancel_reason,
            COALESCE(w.kind,aw.kind,'') AS withdrawal,h.request_id IS NOT NULL AS host_withdrawn
        FROM member_requests r JOIN room_members m ON m.id=r.member_id
        LEFT JOIN member_labels l ON l.room_id=m.room_id AND l.name=m.name
        LEFT JOIN request_cancel_reasons c ON c.request_id=r.id
        LEFT JOIN message_withdrawals w ON w.message_id=r.message_id
        LEFT JOIN message_withdrawals aw ON aw.message_id=r.answer_id
        LEFT JOIN dispatch_withdrawn_requests h ON h.request_id=r.id
        WHERE r.created_by='host' AND r.purpose='ask' AND r.message_id IN (SELECT id FROM anchors)
        ORDER BY r.id""", (message_id, message_id)).fetchall()
    members = []
    for row in requests:
        member = dict(row)
        member.pop("chain_id")
        member["member"] = member.pop("label") or default_label(member["name"])
        member["attempts"] = dispatch_attempts(connection, row)
        member["retried"] = any(attempt["retried"] for attempt in member["attempts"])
        member["invalidation_reasons"] = request_invalidations(row, member["attempts"], bool(host_withdrawal and host_withdrawal["legacy"]))
        member.pop("withdrawal")
        member.pop("host_withdrawn")
        members.append(member)
    sources = connection.execute("SELECT DISTINCT execution_id FROM member_requests WHERE answer_id=? AND execution_id IS NOT NULL",
                                 (message_id,))
    versions = observed_host_versions(connection, [row[0] for row in sources])
    reason = next((line.strip() for line in message["text"].splitlines()
                   if line.lstrip().startswith("分工理由：")), "")
    reasons = {reason for member in members for reason in member["invalidation_reasons"]}
    if host_withdrawal:
        reasons.add("host_withdraw")
    if withdrawal:
        reasons.add("user_rewind" if withdrawal["kind"] == "rewound" else "user_stop_or_retract")
    return {"room_id": message["room_id"], "message_id": message_id, "created_at": message["created_at"], "archived": False,
            "chain_id": requests[0]["chain_id"], "reason": reason,
            "host_version": version_fields(versions[0]) if versions else None, "host_run": versions[0] if versions else None,
            "members": members, "withdrawn": bool(host_withdrawal or withdrawal),
            "redirect_message_id": host_withdrawal["redirect_message_id"] if host_withdrawal else None,
            "invalidation_reasons": [kind for kind in DISPATCH_INVALIDATIONS if kind in reasons],
            "feedback": dispatch_feedback(connection, message_id)}


def list_dispatches(connection, after, room_id=None):
    """Page live dispatches and retained ratings together by global message ID."""
    if not connection.in_transaction:
        connection.execute("BEGIN")
    rows = connection.execute(f"""SELECT m.id,m.room_id,m.created_at,m.text,NULL AS snapshot FROM messages m
        WHERE m.id>? AND (? IS NULL OR m.room_id=?)
            AND NOT EXISTS(SELECT 1 FROM room_directory d WHERE d.room_id=m.room_id AND d.system_kind<>'')
            AND {HOST_DISPATCH_SQL}
        UNION ALL SELECT c.message_id,c.room_id,NULL,NULL,c.snapshot FROM dispatch_feedback_cases c
        WHERE c.message_id>? AND (? IS NULL OR c.room_id=?)
            AND NOT EXISTS(SELECT 1 FROM room_directory d WHERE d.room_id=c.room_id AND d.system_kind<>'')
            AND NOT EXISTS(SELECT 1 FROM messages m WHERE m.id=c.message_id)
        ORDER BY 1 LIMIT ?""", (after, room_id, room_id, after, room_id, room_id, FEEDBACK_CASES_PAGE + 1)).fetchall()
    records = [read_dispatch_case(row["snapshot"]) if row["snapshot"] is not None else dispatch_record(connection, row)
               for row in rows[:FEEDBACK_CASES_PAGE]]
    return {"records": records, "next_after": records[-1]["message_id"] if len(rows) > FEEDBACK_CASES_PAGE else None}


def dispatch_case_context(connection, room_id, message_id):
    """Capture nearby visible room messages in chronological order."""
    where = """room_id=? AND NOT EXISTS(SELECT 1 FROM internal_task_messages WHERE message_id=messages.id)
        AND NOT EXISTS(SELECT 1 FROM message_withdrawals WHERE message_id=messages.id)"""
    before = connection.execute(f"""SELECT id,author,substr(text,1,?) AS text FROM messages
        WHERE {where} AND id<? ORDER BY id DESC LIMIT ?""",
                                (DISPATCH_CONTEXT_LIMIT, room_id, message_id, DISPATCH_CONTEXT_BEFORE)).fetchall()
    after = connection.execute(f"""SELECT id,author,substr(text,1,?) AS text FROM messages
        WHERE {where} AND id>? ORDER BY id LIMIT ?""",
                               (DISPATCH_CONTEXT_LIMIT, room_id, message_id, DISPATCH_CONTEXT_AFTER))
    return {"before": [dict(row) for row in reversed(before)], "after": [dict(row) for row in after]}


def dispatch_case(connection, message):
    """Add a bounded copy of the dispatch and its initiating owner's words to the retained case."""
    record = dispatch_record(connection, message)
    source = connection.execute("""SELECT text FROM messages WHERE id=? AND room_id=? AND author='用户'
        AND NOT EXISTS(SELECT 1 FROM guest_message_sources WHERE message_id=messages.id)
        AND NOT EXISTS(SELECT 1 FROM message_relays WHERE message_id=messages.id)""",
                                (record["chain_id"], record["room_id"])).fetchone()
    texts = {"dispatch_text": message["text"], "source_user_text": source["text"] if source else None,
             "reason": record["reason"]}
    return {**record, "archived": True, "rating": record["feedback"]["rating"],
            "context": dispatch_case_context(connection, message["room_id"], message["id"]),
            **{key: value[:DISPATCH_CASE_TEXT_LIMIT] if value is not None else None for key, value in texts.items()},
            "truncated_fields": [key for key, value in texts.items() if value and len(value) > DISPATCH_CASE_TEXT_LIMIT]}


def refresh_dispatch_cases(connection, room_id):
    """Refresh existing snapshots against the room's final state before deleting its records."""
    messages = connection.execute(f"""SELECT m.* FROM dispatch_feedback_cases c
        JOIN messages m ON m.id=c.message_id JOIN dispatch_feedback f ON f.message_id=m.id
        WHERE c.room_id=? AND {HOST_DISPATCH_SQL}""", (room_id,)).fetchall()
    connection.executemany("UPDATE dispatch_feedback_cases SET snapshot=? WHERE message_id=?",
                           ((json.dumps(dispatch_case(connection, message), ensure_ascii=False), message["id"])
                            for message in messages))


def read_dispatch_case(snapshot):
    """Fill the archive fields a snapshot saved by an older server may lack."""
    record = json.loads(snapshot)
    return {"dispatch_text": None, "source_user_text": None, "truncated_fields": [], "context": {"before": [], "after": []},
            "redirect_message_id": None, "host_run": None, **record,
            "archived": True, "rating": record["feedback"]["rating"],
            "members": [{"name": None, **member} for member in record["members"]]}


def dispatch_chain_requests(connection, room_id, chain_id):
    """Read the canonical requests, including user-originated ones and host hand-backs."""
    return connection.execute("""SELECT r.id AS request_id,r.chain_id,r.message_id,r.answer_id,r.created_by,r.purpose,
            r.status AS request_status,r.execution_id,COALESCE(w.kind,aw.kind,'') AS withdrawal
        FROM member_requests r LEFT JOIN message_withdrawals w ON w.message_id=r.message_id
        LEFT JOIN message_withdrawals aw ON aw.message_id=r.answer_id
        WHERE r.room_id=? AND (r.chain_id=? OR r.chain_id=0 AND r.message_id=?) ORDER BY r.id""",
                              (room_id, chain_id, chain_id)).fetchall()


def dispatch_intervention_events(connection, room_id):
    """Index the room's intervention events once for the current result page."""
    rows = connection.execute("""SELECT id,at,kind,data FROM room_events WHERE room_id=? AND (
        kind='dispatch.user_intervention' OR kind='request.changed' AND json_extract(data,'$.status')='cancelled' OR
        kind='api.write' AND json_extract(data,'$.dispatch_interventions_recorded') IS NULL
            AND (json_extract(data,'$.path') IN ('/stop','/rewind')
            OR json_extract(data,'$.path') LIKE '/messages/%/retract'
            OR json_extract(data,'$.path') LIKE '/members/%/interrupt')) ORDER BY id""", (room_id,))
    by_chain, by_request = collections.defaultdict(list), collections.defaultdict(list)
    legacy_operations = []
    for row in rows:
        data = json.loads(row["data"])
        if row["kind"] == "request.changed":
            by_request[data["request_id"]].append((row["at"], row["id"], data))
        elif row["kind"] == "dispatch.user_intervention":
            by_chain[data["chain_id"]].append(data)
        else:
            legacy_operations.append((row, data))
    return by_chain, by_request, legacy_operations


def chain_user_interventions(connection, requests, events, dispatches):
    """Count successful owner operations and attribute redirect requests to the withdrawn chain."""
    by_chain, by_request, legacy_operations = events
    chain_id = requests[0]["chain_id"] or requests[0]["message_id"]
    redirects = [record for record in dispatches if record["redirect_message_id"] is not None]
    targeted = any(attempt["invalidation_reason"] == "host_withdraw" for record in redirects
                   for member in record["members"] for attempt in member["attempts"])
    counts = {"stop": 0, "retract": 0, "rewind": 0, "redirect": len({record["redirect_message_id"] for record in redirects}),
              "targeted_dispatch": targeted}
    for data in by_chain.get(chain_id, ()):
        counts[data["operation"]] += 1
        counts["targeted_dispatch"] |= bool(data["targeted_dispatch"])
    changes = [change for row in requests for change in by_request.get(row["request_id"], ())]
    if not changes and not any(row["withdrawal"] == "rewound" for row in requests):
        return counts
    for event, data in legacy_operations:
        kind, affected = chain_operation(connection, event, data, changes, requests)
        if affected:
            counts[kind] += 1
            counts["targeted_dispatch"] |= any(row["created_by"] == "host" and row["purpose"] == "ask"
                                               and row["execution_id"] is not None for row in affected)
    return counts


def chain_operation(connection, event, data, changes, requests):
    """Find the chain requests touched by one stop, retraction or rewind."""
    path = data["path"]
    end = event["at"] + data.get("elapsed_ms", 0) + 1
    changed = [change for stamp, identifier, change in changes
               if identifier < event["id"] and event["at"] - 1 <= stamp <= end]
    if path.endswith("/retract"):
        message_id = int(path.split("/")[2])
        # An idempotent repeat has no new request transition.
        ids = {change["request_id"] for change in changed}
        return "retract", [row for row in requests if row["message_id"] == message_id and row["request_id"] in ids]
    if path == "/rewind":
        payload = data.get("payload")
        message_id = payload.get("message_id") if isinstance(payload, dict) else None
        if type(message_id) is not int:
            return "rewind", []
        ids = {change["request_id"] for change in changed}
        return "rewind", [row for row in requests if row["request_id"] in ids
                          or max(row["message_id"], row["answer_id"] or 0) >= message_id
                          and row["withdrawal"] == "rewound"]
    member_id = int(path.split("/")[2]) if path.endswith("/interrupt") else None
    ids = set()
    for change in changed:
        if member_id is not None and change["member_id"] != member_id:
            continue
        execution = connection.execute("SELECT result FROM member_executions WHERE id=?",
                                       (change.get("execution_id"),)).fetchone()
        if (execution and execution["result"] in USER_STOP_RESULTS) or (execution is None and member_id is None):
            ids.add(change["request_id"])
    return "stop", [row for row in requests if row["request_id"] in ids]


def chain_execution_totals(connection, requests):
    """Deduplicate executions and total their known usage by final outcome."""
    attempts = {}
    for request in requests:
        for attempt in dispatch_attempts(connection, request):
            reason = attempt["invalidation_reason"]
            withdrawn = attempt["execution_id"] == request["execution_id"] and request["withdrawal"]
            dispatched = request["created_by"] == "host" and request["purpose"] == "ask"
            void = dispatched and (reason and reason != "failed" or withdrawn and attempt["status"] != "failed")
            segment = ("voided_dispatch" if void else "failed" if attempt["status"] == "failed"
                       else "other_cancelled" if attempt["status"] == "cancelled" else "normal")
            old = attempts.get(attempt["execution_id"])
            if old is None or segment == "voided_dispatch":
                attempts[attempt["execution_id"]] = (segment, attempt["usage"])
    totals = {kind: dict.fromkeys(("input", "cache_read", "cache_write", "output"), 0)
              for kind in ("voided_dispatch", "failed", "other_cancelled", "normal")}
    with_usage = 0
    for segment, usage in attempts.values():
        if usage is not None:
            with_usage += 1
            for key, value in usage.items():
                totals[segment][key] += value
    return {**totals, "with_usage": with_usage, "executions": len(attempts)}, attempts.keys()


def version_fields(run):
    """Project the fingerprint shared across different host executions."""
    return {key: run[key] for key in ("package_version", "prompt_hash", "skill_hash")}


def chain_host_versions(connection, execution_ids):
    """Read observed host versions and the models that ran with each one."""
    runs = observed_host_versions(connection, execution_ids)
    combinations = {tuple(version_fields(run).values()): version_fields(run) for run in runs}
    return {"mixed": len(combinations) > 1, "values": list(combinations.values()), "runs": runs}


def dispatch_chain_record(connection, source, events):
    """Summarize one task chain and its dispatches against one database snapshot."""
    room_id, chain_id = source["room_id"], source["id"]
    requests = dispatch_chain_requests(connection, room_id, chain_id)
    messages = connection.execute(f"""SELECT m.id,m.room_id,m.created_at,m.text FROM messages m
        WHERE m.id IN (SELECT value FROM json_each(?)) AND {HOST_DISPATCH_SQL} ORDER BY m.id""",
                                  (json.dumps(sorted({row["message_id"] for row in requests})),)).fetchall()
    dispatches = [dispatch_record(connection, message) for message in messages]
    invalidated = {reason: [record["message_id"] for record in dispatches if reason in record["invalidation_reasons"]]
                   for reason in DISPATCH_INVALIDATIONS}
    ended = all(row["request_status"] not in ("pending", "delivering") for row in requests)
    tokens, execution_ids = chain_execution_totals(connection, requests)
    return {"room_id": room_id, "chain_id": chain_id, "source_message_id": chain_id,
            "started_at": source["created_at"], "ended": ended,
            "dispatch_messages": len(dispatches), "dispatch_requests": sum(len(record["members"]) for record in dispatches),
            "invalidated_dispatches": {kind: {"count": len(ids), "message_ids": ids} for kind, ids in invalidated.items()},
            "user_interventions": chain_user_interventions(connection, requests, events, dispatches),
            "unhandled_failure": ended and any(row["request_status"] == "failed" for row in requests),
            "tokens": tokens, "host_versions": chain_host_versions(connection, execution_ids)}


def list_dispatch_chains(connection, after, room_id=None):
    """Page current task chains by the globally ordered initiating message ID."""
    if not connection.in_transaction:
        connection.execute("BEGIN")
    rows = connection.execute("""SELECT m.id,m.room_id,m.created_at FROM messages m
        WHERE m.id>? AND (? IS NULL OR m.room_id=?)
        AND NOT EXISTS(SELECT 1 FROM room_directory d WHERE d.room_id=m.room_id AND d.system_kind<>'') AND (
            EXISTS(SELECT 1 FROM member_requests r WHERE r.room_id=m.room_id AND r.chain_id=m.id) OR
            EXISTS(SELECT 1 FROM member_requests r WHERE r.message_id=m.id AND r.chain_id=0))
        ORDER BY m.id LIMIT ?""", (after, room_id, room_id, FEEDBACK_CASES_PAGE + 1)).fetchall()
    page = rows[:FEEDBACK_CASES_PAGE]
    events = {room: dispatch_intervention_events(connection, room) for room in {row["room_id"] for row in page}}
    records = [dispatch_chain_record(connection, row, events[row["room_id"]]) for row in page]
    return {"records": records, "next_after": records[-1]["chain_id"] if len(rows) > FEEDBACK_CASES_PAGE else None}


def mark_scheduler_routing(connection, room_id, token, payload):
    """The local service marks a message while the decision model is analysing it, and clears the mark when done."""
    begin_write(connection)
    require_owner(connection, room_id, token)
    message_id, active = payload.get("message_id"), payload.get("active")
    if type(message_id) is not int or message_id <= 0 or type(active) is not bool:
        raise ValueError(Text('须提供正整数 message_id 与布尔 active'))
    if active:
        connection.execute("INSERT OR REPLACE INTO scheduler_routing (room_id,message_id,created_at) VALUES (?,?,?)", (room_id, message_id, int(time.time())))
    else:
        connection.execute("DELETE FROM scheduler_routing WHERE room_id=? AND message_id=?", (room_id, message_id))
    return {"message_id": message_id, "active": active}


def record_scheduler_decision(connection, room_id, token, payload):
    """The local service records one smart-scheduling decision, with the owner credential, so the transcript shows what it did and how sure it was."""
    begin_write(connection)
    require_owner(connection, room_id, token)
    kind, label, confidence = payload.get("kind"), incoming_text(payload.get("label"), payload.get("label_text")), payload.get("confidence")
    after = payload.get("after_message_id", 0)
    if kind not in ("interjection", "round") or not isinstance(label, str) or not 0 < len(label.strip()) <= MAX_DECISION_LABEL:
        raise ValueError(Text('决策记录须有 kind（interjection/round）与 1–{value1} 字的 label', value1=MAX_DECISION_LABEL))
    if confidence is not None and (type(confidence) not in (int, float) or not 0 <= confidence <= 1):
        raise ValueError(Text('confidence 须为 0–1 或 null'))
    if payload.get("provider") not in SCHEDULER_PROVIDERS or type(payload.get("applied")) is not bool or type(after) is not int or after < 0:
        raise ValueError(Text('须提供供应商 provider、是否执行 applied 与非负的 after_message_id'))
    cursor = connection.execute("""INSERT INTO scheduler_decisions (room_id,after_message_id,kind,label,confidence,applied,provider,created_at)
        VALUES (?,?,?,?,?,?,?,?)""", (room_id, after, kind, label.strip(), confidence, int(payload["applied"]), payload["provider"], utc_now()))
    save_text(connection, "decision", cursor.lastrowid, "label", label)
    context = payload.get("context")
    if context is not None:
        text = json.dumps(context, ensure_ascii=False)
        if not isinstance(context, dict) or len(text) > MAX_DECISION_CONTEXT:
            raise ValueError(Text('context 须为不超过 {value1} 字的对象', value1=MAX_DECISION_CONTEXT))
        connection.execute("INSERT INTO scheduler_decision_context (decision_id,context) VALUES (?,?)", (cursor.lastrowid, text))
    detail = payload.get("detail")
    if detail is not None:
        text = json.dumps(detail, ensure_ascii=False)
        if not isinstance(detail, list) or len(detail) > 4 or len(text) > MAX_DECISION_DETAIL:
            raise ValueError(Text('detail 须为最多 4 项、不超过 {value1} 字的列表', value1=MAX_DECISION_DETAIL))
        connection.execute("INSERT INTO scheduler_decision_details (decision_id,detail) VALUES (?,?)", (cursor.lastrowid, text))
    model_input = payload.get("input")
    if model_input is not None:
        text = json.dumps(model_input, ensure_ascii=False)
        if not isinstance(model_input, dict) or len(text) > MAX_DECISION_INPUT:
            raise ValueError(Text('input 须为不超过 {value1} 字的对象', value1=MAX_DECISION_INPUT))
        connection.execute("INSERT INTO scheduler_decision_inputs (decision_id,input) VALUES (?,?)", (cursor.lastrowid, text))
    result = dict(connection.execute("SELECT * FROM scheduler_decisions WHERE id=?", (cursor.lastrowid,)).fetchone())
    result["texts"] = load_texts(connection, "decision", cursor.lastrowid)
    return result


def scheduler_decision_view(connection, room_id, decision_id, token):
    """Read one room-bound decision and its full evidence, outside the recent-room window."""
    if session_read_boundary(connection, room_id, token) is not None:
        raise PermissionError(Text('独立观点阶段不能读取智能调度判断'))
    row = connection.execute(f"{DECISION_SELECT} WHERE d.room_id=? AND d.id=?", (room_id, decision_id)).fetchone()
    if not row:
        raise LookupError(Text('决策记录不存在'))
    result = dict(row)
    for field, table in (("detail", "scheduler_decision_details"), ("input", "scheduler_decision_inputs")):
        value = connection.execute(f"SELECT {field} FROM {table} WHERE decision_id=?", (decision_id,)).fetchone()
        result[field] = json.loads(value[0]) if value else None
    if result.get("context"):
        result["context"] = json.loads(result["context"])
    result["texts"] = load_texts(connection, "decision", decision_id)
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
    if "requested_of" in params:
        # The requests the room recorded for this member, however the owner has renamed it in the text.
        clauses.append("messages.id IN (SELECT message_id FROM member_requests WHERE room_id=? AND member_id=?)")
        values.extend([room_id, int(params["requested_of"])])
    if "kind" in params:
        if params["kind"] not in ("opinion", "moderation", "receipt", "chat"):
            raise ValueError(Text('发言职责无效'))
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
            raise ValueError(Text('after 需为非负消息编号，不能与翻页同时使用'))
        clauses.append("messages.id>?")
        values.append(after)
    if params.get("withdrawn") != INCLUDE_WITHDRAWN:
        clauses.append("withdrawn.message_id IS NULL")
    return " AND ".join(clauses), values


def latest_messages(connection, room_id, params, where, values, size, bounded=False):
    """Read the room's transcript from the newest end: the `size` messages before `before` (0: the latest), oldest first.

    The page shows the latest messages first and reads the earlier ones after (#8131), so a long room opens without
    waiting for its whole history. `has_earlier` says whether older messages remain; with `cards=1` the batch also takes
    the cards placed after its messages, over a span that meets the next older batch's, so batches read back to the
    start cover every card once: (the message before this batch, this batch's last] and, for the latest, to the end. A reader held to a reading boundary (`bounded`) gets no cards.
    """
    before = int(params["before"])
    if before < 0 or "after" in params or int(params.get("page", 1)) != 1:
        raise ValueError(Text('before 需为非负消息编号，不能与 after 或翻页同时使用'))
    if before:
        where += " AND messages.id<?"
        values = [*values, before]
    rows = connection.execute(f"{MESSAGE_QUERY} WHERE {where} ORDER BY messages.id DESC LIMIT ?",
                              [room_id, *values, size + 1]).fetchall()
    has_earlier = len(rows) > size
    shown = member_display_names(connection, room_id)
    messages = [{**message, "author_label": message.get("author_label") or shown.get(message["author"], message["author"])}
                for message in (message_with_attachments(connection, row) for row in reversed(rows[:size]))]
    result = {"messages": messages, "has_earlier": has_earlier}
    unfiltered = not any(params.get(name) for name in ("q", "author", "mention", "kind", "host", "submission_id"))
    if params.get("cards") == "1" and not bounded and unfiltered and params.get("withdrawn") == INCLUDE_WITHDRAWN and messages:
        low = rows[size]["id"] if has_earlier else 0
        result["cards"] = history_cards(connection, room_id, (low, messages[-1]["id"] if before else None))
    return result


def query_messages(connection, room_id, params, token=""):
    """Read one bounded page; incremental cursors advance only through returned rows."""
    room = connection.execute("""SELECT EXISTS(
        SELECT 1 FROM discussion_sessions WHERE room_id=rooms.id AND status='active'
        ) AS active_session FROM rooms WHERE id=?""", (room_id,)).fetchone()
    if room is None:
        raise LookupError(Text('房间不存在'))
    # Expiring a discussion can invalidate the execution or request used to read its context.
    if room["active_session"] and enforce_session_limits(connection, room_id):
        connection.commit()
    page = max(1, int(params.get("page", 1)))
    size = min(MAX_PAGE_SIZE, max(1, int(params.get("limit", PAGE_SIZE))))
    cutoff = session_message_access(connection, room_id, params, token)
    if params.get("author"):
        # A member is named as the room shows it (display name) or by its ID; both find the same messages.
        params = {**params, "author": member_handles(connection, room_id).get(str(params["author"]).strip(), params["author"])}
    where, values = message_filters(room_id, params)
    if cutoff is not None:
        where += " AND messages.id<=?"
        values.append(cutoff)
    if "before" in params:
        return latest_messages(connection, room_id, params, where, values, size, bounded=cutoff is not None)
    total = connection.execute(f"""SELECT COUNT(*) FROM messages
        LEFT JOIN message_details AS details ON details.message_id=messages.id
        LEFT JOIN message_withdrawals AS withdrawn ON withdrawn.message_id=messages.id
        WHERE {where}""", values).fetchone()[0]
    rows = connection.execute(f"{MESSAGE_QUERY} WHERE {where} ORDER BY messages.id LIMIT ? OFFSET ?",
                              [room_id, *values, size + 1, (page - 1) * size]).fetchall()
    shown = member_display_names(connection, room_id)
    messages = [{**message, "author_label": message.get("author_label") or shown.get(message["author"], message["author"])}
                for message in (message_with_attachments(connection, row) for row in rows[:size])]
    if params.get("fold_visuals") in ("1", "en"):
        messages = [fold_message_visuals(message, params["fold_visuals"] == "en") for message in messages]
    has_more = len(rows) > size
    budget_stopped = False
    if params.get("max_chars") not in (None, ""):
        # The spec keeps `max_chars` for an optional text-only sub-budget, which is not offered yet.
        raise ValueError(Text('max_chars（正文子预算）暂不支持；整体输出预算请用 max_output_chars'))
    if params.get("max_output_chars") not in (None, ""):
        # Agent reads drop empty fields first: most of a message's metadata is unused relay and link fields, which would
        # otherwise take about half the budget and end a page after a few answers.
        messages = [without_empty_fields(message) for message in messages]
        fitted = fit_messages(messages, output_budget(params["max_output_chars"]))
        budget_stopped, has_more = len(fitted) < len(messages) or fitted[-1:] != messages[-1:], has_more or len(fitted) < len(messages)
        messages = fitted
    # `total`/`pages` count what matches the filters, cursor and reading boundary, so they shrink as `after` advances;
    # `remaining` is how many of those still come after this page.
    result = {"messages": messages, "page": page, "total": total,
              "pages": max(1, (total + size - 1) // size), "remaining": max(0, total - (page - 1) * size - len(messages))}
    if budget_stopped:
        result["budget_stopped"] = True
    if cutoff is not None:
        # Messages past this request's reading boundary are left out: say where the room has got to, so this page is not
        # taken for the latest (D3). Only the room's latest message number, as spec #3187 allows: no count of what lies past.
        latest = connection.execute("""SELECT COALESCE(MAX(id),0) FROM messages m WHERE room_id=?
            AND NOT EXISTS (SELECT 1 FROM internal_task_messages t WHERE t.message_id=m.id)""", (room_id,)).fetchone()[0]
        result["read_scope"] = {"read_until": cutoff, "room_latest_id": latest,
                                **({"note": Text('本请求只能读到 #{until}，房间最新消息为 #{latest}；之后的消息在独立观点阶段结束后才能读', until=cutoff, latest=latest)}
                                   if latest > cutoff else {})}
    if "after" in params or budget_stopped:
        after = int(params.get("after", 0))
        result.update(next_after=messages[-1]["id"] if messages else after, has_more=has_more)
        # The unfiltered transcript also takes the cards of its batch, for history older than the room view's recent cards.
        unfiltered = not any(params.get(name) for name in ("q", "author", "mention", "kind", "host", "submission_id"))
        if params.get("cards") == "1" and cutoff is None and unfiltered and params.get("withdrawn") == INCLUDE_WITHDRAWN:
            result["cards"] = history_cards(connection, room_id, (int(params["after"]), result["next_after"] if result["has_more"] else None))
    return result


def output_budget(value):
    """A reader's overall output budget, in Unicode code points of the compact JSON it gets back (spec #3220 R3)."""
    try:
        budget = int(value)
    except (TypeError, ValueError):
        raise ValueError(Text('max_output_chars 须为 {low}–{high} 的整数', low=MIN_OUTPUT_CHARS, high=MAX_OUTPUT_CHARS)) from None
    if not MIN_OUTPUT_CHARS <= budget <= MAX_OUTPUT_CHARS:
        raise ValueError(Text('max_output_chars 须为 {low}–{high} 的整数', low=MIN_OUTPUT_CHARS, high=MAX_OUTPUT_CHARS))
    return budget


def compact_chars(value):
    """Size of a value as the budget counts it: code points of its compact JSON."""
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":")))


def without_empty_fields(message):
    """A message without its null, empty-string and empty-collection fields; the text stays even when empty, and 0 stays."""
    return {key: value for key, value in message.items() if key == "text" or value not in (None, "", [], {})}


def fit_messages(messages, budget):
    """Keep whole messages while they fit the budget; a first message too long to fit becomes an honest preview."""
    kept, used = [], 0
    for message in messages:
        size = compact_chars(message)
        if used + size <= budget:
            kept.append(message)
            used += size
            continue
        if not kept:
            room = budget - compact_chars(slice_message_text({**message, "text": ""}, 0, 0)) - PREVIEW_NUMBER_CHARS
            if room <= 0:
                error = ValueError(Text('max_output_chars 太小，放不下一条消息的必要信息；请调大后重试'))
                error.details = {"code": "budget_too_small", "min_chars": budget - room + 1}
                raise error
            # Escapes make a code point cost more than one in JSON; shrink until the preview really fits.
            while room > 0 and compact_chars(slice_message_text(message, 0, room)) > budget:
                room = room * 9 // 10
            kept.append(slice_message_text(message, 0, max(1, room)))
        break
    return kept


def slice_message_text(message, offset, limit):
    """Return part of a message's text with what tells a reader whether it has it all and where to go on (spec #3187 4.5-4.6).

    Offsets and lengths count Unicode code points from 0; `text_sha256` names the text version the offsets belong to."""
    text = message.get("text") or ""
    if offset > len(text):
        raise ValueError(Text('offset 超出正文长度 {chars}', chars=len(text)))
    piece = text[offset:] if limit is None else text[offset:offset + limit]
    end = offset + len(piece)
    message = {**message, "text": piece, "text_chars": len(text), "text_offset": offset,
               "text_complete": offset == 0 and end == len(text), "next_offset": end if end < len(text) else None,
               "text_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest()}
    message.get("texts", {}).pop("text", None)
    return message


def read_message_part(message, params):
    """Apply `offset`/`limit` (and an expected `version`) to a single message read; without them the message is whole."""
    if not any(params.get(name) not in (None, "") for name in ("offset", "limit", "version")):
        return message
    try:
        offset = int(params.get("offset") or 0)
        limit = int(params["limit"]) if params.get("limit") not in (None, "") else None
    except ValueError:
        raise ValueError(Text('offset 与 limit 须为非负整数')) from None
    if offset < 0 or (limit is not None and limit < 1):
        raise ValueError(Text('offset 与 limit 须为非负整数'))
    version = hashlib.sha256((message.get("text") or "").encode("utf-8")).hexdigest()
    if params.get("version") and params["version"] != version:
        error = FileExistsError(Text('正文已变化，请从头重读，不要与先前读到的片段拼接'))
        error.details = {"code": "content_changed", "text_sha256": version}
        raise error
    return slice_message_text(message, offset, limit)


def get_message(connection, room_id, message_id, params=None, token=""):
    """Read an exact message, constrained to the specified room.

    A message the caller cannot read says why only where the caller may know it (spec #3187 sections 5 and 6): past
    its own reading boundary (`reading_boundary`, without looking up whether that ID exists), or the internal task
    anchor of one of its own requests (`internal_task_anchor`, pointing at where the task's text is). Anything else
    stays the generic `not_available`, so no error can be used to probe hidden messages."""
    params = params or {}
    cutoff = session_message_access(connection, room_id, params, token)
    # The caller's own task anchor is named first: it lies past an initial boundary by construction.
    anchor = own_task_anchor(connection, room_id, message_id, params)
    if anchor:
        raise ReadError(Text('#{id} 是你本次请求的内部任务锚点，不是房间消息；题目见任务的当前请求或 execution view', id=message_id),
                        code="internal_task_anchor", requested_message_id=message_id, **anchor)
    if cutoff is not None and message_id > cutoff:
        raise BoundaryError(Text('该编号超出本请求读取上界 #{until}；未查询该编号是否存在', until=cutoff),
                            code="reading_boundary", requested_message_id=message_id,
                            read_scope={"request_read_until": cutoff, "boundary_applied": True})
    where, values = message_filters(room_id, params)
    row = connection.execute(f"{MESSAGE_QUERY} WHERE {where} AND messages.id=?", [room_id, *values, message_id]).fetchone()
    if row is None:
        raise ReadError(Text('消息不存在'), code="not_available", requested_message_id=message_id)
    return message_with_attachments(connection, row)


def trace_message(connection, room_id, params, token):
    """Resolve a trace anchor under ordinary message permissions before reading its diagnostic history."""
    message_id, page = int(params.get("message_id", 0)), int(params.get("page", 1))
    if not 1 <= message_id <= MAX_MESSAGE_ID:
        raise ValueError(Text("{field} 须为正整数", field="message_id"))
    if page < 1:
        raise ValueError(Text("{field} 须为正整数", field="page"))
    if not connection.in_transaction:
        connection.execute("BEGIN")
    context = {field: params[field] for field in ("execution_id", "request_id") if field in params}
    read_until = session_message_access(connection, room_id, context, token)
    anchor = get_message(connection, room_id, message_id, context, token)
    return message_trace(connection, room_id, token, anchor, {"read_until": read_until, "page": page})


def own_task_anchor(connection, room_id, message_id, params):
    """The request of the caller's own execution that an internal task message anchors, if it is one."""
    execution_id = params.get("execution_id")
    if not str(execution_id or "").isdigit():
        return None
    row = connection.execute("""SELECT r.id FROM member_requests r
        JOIN internal_task_messages task ON task.message_id=r.message_id
        WHERE r.room_id=? AND r.execution_id=? AND r.message_id=?""", (room_id, int(execution_id), message_id)).fetchone()
    return {"request_id": row["id"], "execution_id": int(execution_id)} if row else None


def update_state(connection, room_id, payload):
    """Save detailed state and an optional human-facing brief in one transaction."""
    text = str(payload.get("text", "")).strip()
    brief = str(payload.get("brief", "")).strip()
    if len(text) > MAX_STATE_LENGTH or len(brief) > MAX_BRIEF_LENGTH:
        raise ValueError(Text('讨论状态最多 {value1} 字，主持简报最多 {value2} 字', value1=MAX_STATE_LENGTH, value2=MAX_BRIEF_LENGTH))
    room = require_room(connection, room_id)
    require_host(room, {"actor": payload.get("actor", "用户")})
    until = int(payload.get("until", room["latest_id"]))
    if until < 0 or until > room["latest_id"]:
        raise ValueError(Text('讨论状态的截止编号无效'))
    saved_brief = connection.execute("SELECT until FROM room_briefs WHERE room_id=?", (room_id,)).fetchone()
    if "brief" in payload and saved_brief and until < saved_brief["until"]:
        raise ValueError(Text('简报已整理至 #{value1}，截止编号不能回退；请先读取最新状态', value1=saved_brief['until']))
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


@lru_cache(maxsize=1)
def english_reading_dictionary():
    """Load the English strings used by the plain-text room reader."""
    directory = ROOT / "frontend" / "locales" / "en"
    dictionary = {}
    for path in sorted(directory.rglob("*.json")):
        values = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(values, dict):
            dictionary.update(values)
    return dictionary


def read_text(value, language):
    """Render a fixed `Text` template in the requested language; leave arbitrary source text unchanged."""
    if not isinstance(value, Text):
        return str(value)
    template = value.template
    if reading_language(language) == "en":
        template = english_reading_dictionary().get(template, template)
    return template.format(**value.params) if value.params else template


def reading_field(record, field, language):
    """Translate a record field only when it carries validated stored template metadata."""
    value = record.get(field)
    payload = record.get("texts", {}).get(field)
    if not payload:
        return value
    template = Text(payload["template"], **payload["params"])
    if str(template) != str(value):
        return value
    return read_text(template, language)


def reading_identity(value, language):
    """Translate only fixed default identities, leaving member names intact."""
    labels = {"用户": Text("用户"), "系统": Text("系统"), "系统任务": Text("系统任务")}
    return read_text(labels.get(value, value), language)


def reading_language(header):
    """Choose English or Chinese from Accept-Language preferences, defaulting to Chinese."""
    preferences = []
    for order, item in enumerate(str(header or "").split(",")):
        parts = item.strip().split(";")
        tag = parts[0].strip().lower()
        quality = 1.0
        for parameter in parts[1:]:
            name, separator, value = parameter.strip().partition("=")
            if separator and name.strip().lower() == "q":
                try:
                    quality = float(value)
                except ValueError:
                    quality = 0
        if quality > 0:
            preferences.append((-quality, order, tag))
    for _, _, tag in sorted(preferences):
        if tag.startswith("en"):
            return "en"
        if tag.startswith("zh"):
            return "zh"
    return "zh"


READING_PHASES = {"initial": Text("独立观点"), "discussing": Text("深入讨论"),
                  "paused": Text("已暂停"), "concluded": Text("已收束")}
READING_REQUEST_STATUSES = {"queued": Text("排队中"), "answered": Text("已回答"),
                            "cancelled": Text("已取消"), "skipped": Text("未开始即取消"),
                            "failed": Text("回答失败")}


def state_reading_text(room, language="zh"):
    """Read the host's brief explicitly without adding it to independent-entry overviews."""
    brief = room.get("host_brief")
    overview = (read_text(Text("主持简报（整理至 #{until}，{updated_at}）\n{text}", until=brief["until"],
                               updated_at=brief["updated_at"], text=brief["text"]), language)
                if brief and brief["text"] else read_text(Text("主持简报：尚未更新"), language))
    state_value = reading_field(room, "state_text", language)
    state = state_value or read_text(Text("尚未整理"), language)
    return f"{overview}\n\n{read_text(Text('主持人维护的状态（整理至 #{until}）', until=room['state_until']), language)}\n\n{state}"


def message_text(message, language="zh"):
    """Render an original message with its provenance and reply reference."""
    reply = read_text(Text(" · 回复 #{reply_to}", reply_to=message.get("reply_to")), language) if message.get("reply_to") else ""
    role = read_text({"moderation": Text("主持发言"), "receipt": Text("运行回执"), "chat": Text("协作消息")}.get(
        message.get("kind"), Text("专家观点")), language)
    summary = (read_text(Text("\n回答摘要（{summary_by}）：\n{summary}\n\n完整正文：\n",
                              summary_by=reading_identity(message.get("summary_by", ""), language),
                              summary=reading_field(message, "summary", language)), language)
               if message.get("summary") else "\n")
    attachments = "".join(read_text(Text("\n附件：{file_name}（{size} 字节；ID: {id}）\n{download_url}", **item), language)
                          for item in message.get("attachments", []))
    return read_text(Text("#{id} · {author} · {created_at}{reply}\n职责：{role}；来源：{source}；提交者：{submitted_by}{summary}{text}{attachments}",
                          id=message["id"], author=reading_identity(message["author"], language), created_at=message["created_at"], reply=reply,
                          role=role, source=message.get("source", ""), submitted_by=reading_identity(message.get("submitted_by", "用户"), language),
                          summary=summary, text=reading_field(message, "text", language), attachments=attachments), language)


def room_text(connection, room_id, params, language="zh"):
    """Expose only an overview; readers choose which supporting pages to open."""
    room = require_room(connection, room_id)
    base = f"/r/{room_id}"
    phase = read_text(READING_PHASES.get(room["phase"], PHASES.get(room["phase"], room["phase"])), language)
    focus = room["focus"] or read_text(Text("尚未填写"), language)
    title = reading_field(room, "title", language)
    goal = reading_field(room, "goal", language)
    content = [f"# {title}", read_text(Text("目标：{goal}", goal=goal), language),
               read_text(Text("主持人：{host}；阶段：{phase}；当前焦点：{focus}", host=reading_identity(room["host"], language), phase=phase, focus=focus), language),
               read_text(Text("当前记录截止 #{latest_id}；共 {message_count} 条；已完成 {completed_rounds} 轮讨论（所有参与专家各发言一次）。",
                              latest_id=room["latest_id"], message_count=room["message_count"],
                              completed_rounds=room["completed_rounds"]), language)]
    limits = room["limits"]
    unlimited = read_text(Text("不限"), language)
    content.append(read_text(Text("讨论上限：{max_rounds} 轮；总时长 {max_minutes} 分钟；到限后讨论结束，房间照常协作。到限：{reached}。",
                                 max_rounds=limits["max_rounds"] or unlimited,
                                 max_minutes=limits["max_minutes"] or unlimited, reached=limits["reached"]), language))
    participant = params.get("participant", params.get("for"))
    members = "；".join(read_text(Text("{name}（已读至 #{read_until}，待投递 {pending}）", name=item["name"],
                                        read_until=item["read_until"], pending=item["pending"]), language)
                       for item in room["free"]["members"])
    if current_session(connection, room_id, active_only=True):
        current = room.get("current_turn")
        assignment = (read_text(Text("当前安排 #{id}：{expert}", id=current["id"], expert=current["expert"]), language)
                      if current else read_text(Text("当前没有专家安排"), language))
        content.append(read_text(Text("讨论会话处于{phase}；{assignment}。其余成员安排按队列执行。成员：{members}。专家回答须关联本次执行或手动请求，已结束的执行或失效请求不能改作普通发言。",
                                     phase=phase, assignment=assignment, members=members or read_text(Text("无"), language)), language))
    else:
        content.append(read_text(Text("房间（未开讨论）：无发言权、安排与轮次。成员：{members}。用户的消息点名成员后生成请求；成员回答须带本次执行编号，执行结束、被打断或过期后的回答会被拒绝，不能改作普通发言；只被本机服务判失败、未被重试的执行仍收下回答。",
                                     members=members or read_text(Text("无"), language)), language))
    content.extend(["", read_text(Text("## 按需展开"), language),
                    read_text(Text("背景、边界与参与专家：{url}", url=f"{base}/brief"), language),
                    read_text(Text("共识与分歧（整理至 #{until}）：{url}", until=room["state_until"], url=f"{base}/state"), language),
                    read_text(Text("## 读取与检索"), language),
                    read_text(Text("完整历史（分页）：{url}", url=f"{base}/messages?page=1"), language),
                    read_text(Text("单条原文：{url}", url=f"{base}/messages/消息编号"), language),
                    read_text(Text("检索：{url}", url=f"{base}/search?q=关键词&page=1"), language),
                    read_text(Text("按作者检索：{url}", url=f"{base}/search?author=Claude"), language),
                    read_text(Text("发言安排历史：{url}", url=f"{base}/turns?page=1"), language)])
    if participant:
        content.append(read_text(Text("与 @{participant} 相关的观点：{url}", participant=participant,
                                      url=f"{base}/search?mention={participant}&page=1"), language))
    content.extend(participation_text(language))
    return "\n\n".join(content)


def participation_text(language="zh"):
    """Readers are local AIs; they follow the skills rather than a guide embedded here."""
    return ["", read_text(Text("## 本地 AI"), language),
            read_text(Text("本地 AI 请调用 discuss-participant（主持人另调用 discuss-host），用 codiscuss 命令读写；字段与写入规则以 codiscuss room protocol 为准，不直接调用网站接口。"), language),
            read_text(Text("主持人可以兼任专家；作者、职责与来源尚未认证。"), language)]


def brief_text(room, language="zh"):
    """Render the detailed brief only when explicitly requested."""
    experts = "\n".join(f"- {name}" for name in room["experts"])
    missing = read_text(Text("未填写"), language)
    return read_text(Text("# {title} · 话题资料\n\n目标：{goal}\n\n用户原文：\n{user_request}\n\n背景：\n{background}\n\n边界：\n{boundaries}\n\n主持人：{host}（可兼任专家）\n\n参与专家：\n{experts}",
                          title=reading_field(room, "title", language), goal=reading_field(room, "goal", language), user_request=room["user_request"] or missing,
                          background=room["background"] or missing, boundaries=room["boundaries"] or missing,
                          host=reading_identity(room["host"], language), experts=experts), language)


def turn_text(turn, room, language="zh"):
    """Render a discussion assignment without embedding discussion context."""
    room_id = room["id"]
    answer_id = turn.get("answer_id")
    answer = (read_text(Text("\n回答原文：{url}", url=f"/r/{room_id}/messages/{answer_id}"), language)
              if answer_id else "")
    status_label = turn.get("status_label")
    if turn["status"] == "open" or status_label == "open":
        label = read_text(pending_label(room, turn["expert"]), language)
    elif isinstance(status_label, Text):
        label = read_text(status_label, language)
    elif status_label in READING_REQUEST_STATUSES:
        label = read_text(READING_REQUEST_STATUSES[status_label], language)
    elif status_label:
        label = turn["status_label"]
    else:
        label = read_text(READING_REQUEST_STATUSES.get(turn["status"], Text(REQUEST_STATUSES.get(turn["status"], turn["status"]))), language)
    association_id = turn.get("member_request_id") or read_text(Text("尚未派发"), language)
    return read_text(Text("安排 #{id} · {expert} · {label}\n待回应问题：{question}\n话题入口：{url}\n关联请求：{association}{answer}\n本地成员凭自己的请求或执行保存完整回答，较长回答可附摘要。",
                          id=turn["id"], expert=turn["expert"], label=label, question=turn["question"],
                          url=f"/r/{room_id}?participant={turn['expert']}", association=association_id, answer=answer), language)


def protocol_text(room, language, limit):
    """Describe the unified request/execution protocol separately from discussion material."""
    paragraphs = [
        Text("# 协作房间参与协议"),
        Text("当前主持人：{host}。房间是底座，讨论与 Goal 是房间内临时开启的模式；房间请求与讨论请求共用成员执行。", host=reading_identity(room["host"], language)),
        Text("先用 room view 读取成员、职责、free.requests、session 与阶段，再按需读取原文。任务中的 purpose=discuss 表示讨论发言，discuss_host 表示主持任务，ask 表示直接提问；内部任务来源不是普通发言。"),
        Text("用户管理和讨论开关使用房主凭据；本地成员使用本人的 --access-file，不借用其他身份。凭据私下交付，不公开 token。API 参与者遵循相同请求与执行约束，source=api；本地 CLI 使用 source=cli。"),
        Text("runner 成员等待本机接入程序交付任务，用 execution view 核对本次执行和请求，再以 message post --as 本人 --kind chat --execution 本次编号 --access-file FILE 回答。执行失效后保留草稿，不能去掉编号改作普通发言；认领、续租与后续投递由接入程序处理。"),
        Text("manual 本地成员首次用 member register 注册，会话 ID 由 CLI 自动取得；回答用 --request 请求编号，不编造执行编号。讨论不使用原生定时；原会话不能托管时由用户触发。"),
        Text("房间里的 host 可用 --to 点名成员，route 表示未点名的用户请求，handoff 表示派出任务已结束；链上 AI 派活受房间预算限制。--to 多位并加 --sequential 时按点名顺序依次接力，每棒一轮，最后交回主持人；--with 成员与紧挨在前的 --to 同一棒同时做，这一组全部结束才交下一棒；--detach 成员在后台工作：不等它、不交回、也不占住房间，可单独用或随派活同时开工（失败时通知主持人）；--keep-working 派活后自己不结束这一轮、接着工作：这条回答收为派活卡，后续工作另起一张卡，做完照常回答（同一执行凭据即可），派出的工作结束时以通知交回；不能与 --continue、--sequential、--next-review 同用；再加 --loop 则交回为检查点，用 sequence continue --request 交接请求编号开始下一圈，不继续即直接验收。普通成员的 --to 或正文 @ 只保存回应建议，不直接唤醒；不点名自己、不扩大授权。"),
        Text("讨论中的用户 @ 直接提问独立排队，不计讨论轮次、不与讨论发言合并。initial 阶段先独立判断；服务端按讨论请求的 read_until 限制读取。直接提问和主持任务不继承该阅读限制。"),
        Text("主持安排前先 turn roster 读取在场专家、waiting、unregistered 和 revision，再 turn create --roster revision；单项和多项都要带凭据，多项计划须覆盖本轮 waiting。继续排队同样先读 roster，再 turn continue --roster revision。状态或新消息变化后旧凭据被拒绝，重新读取再判断；每个回答保存后由程序推进下一项。"),
        Text("局部追问先 turn roster 读取 host_requests 的请求与原消息编号，再 turn ask --request ID --expert NAME --roster revision --submission-id UUID；普通提问不计轮次、不改讨论队列，可问已发言者和主持人，只结束指定请求。"),
        Text("计划或收束成功即完成本次主持执行，无需再提交回答回执。主持说明使用 kind=moderation，不替代专家回答，也不会完成主持执行；主持人作为专家发言须回答自己的 discuss 请求。"),
        Text("讨论状态读取 GET {base}/discussion；房主先读取 revision，再 POST 同路径提交 start、pause、resume 或 end。CLI 对应 run view/start/pause/resume/stop。开启可携带 submission_id，原编号与原内容重试返回原会话，已结束的会话不会因重试恢复。", base=f"/api/rooms/{room['id']}"),
        Text("room limits 返回轮次、时长和进度；到限立即结束讨论，不再唤醒主持人总结。暂停不计时，并作废讨论请求和执行；恢复生成新任务，旧执行不得继续写。"),
        Text("原会话送达失败可等待 60 秒后自动重试，最多 3 次；重试用尽只失败该请求，并交回主持人判断跳过、重排或暂停，不自动暂停整场。结果不明的写入不作为新提交重发。"),
        Text("保存 state 与主持简报时，until 只覆盖实际已读原文。主动收束前先保存有依据的总结与状态，再 room conclusion 获取 blockers 和 revision，无阻碍后用 room limits --done --conclusion revision；有未处理内容或状态变化时拒绝收束。"),
        Text("message list --after 按 next_after/has_more 增量读取；message view 核对原文；历史可筛选 opinion/moderation/chat。内部任务不出现在普通消息列表、搜索和统计中，也没有普通发言的撤回或编辑入口。"),
        Text("附件用 attachment upload/download，最多 10 个、单个 {limit} MiB；自动成员在完成执行前上传。回答正文最多 32000 个 Unicode 字符，摘要最多 1000 字，较长回答才附摘要，完整原文不截断。", limit=limit),
        Text("每次新内容使用新 submission_id，同次重试沿用编号、原文、凭据和执行/请求关联。按 submission_id 查询持久结果；读取失败不表示未写入，不能换身份或编号绕过拒绝。")
]
    return "\n\n".join(read_text(paragraph, language) for paragraph in paragraphs)


def update_frame(rooms):
    """Encode a change event; `rooms` lists the changed rooms, and without it every room may have changed."""
    return f"event: change\ndata: {json.dumps({'rooms': rooms} if rooms else {})}\n\n".encode("utf-8")


class CloudCopyJobs:
    """Share asynchronous copy tasks between this site's local and remote entry points."""

    def __init__(self, database):
        self.database = database
        self.lock = threading.Lock()
        self.running = {}
        self.failed = collections.OrderedDict()
        self.workers = ThreadPoolExecutor(max_workers=CLOUD_COPY_WORKERS, thread_name_prefix="cloud-copy")

    def _state(self, connection, record):
        identifier = record["id"]
        if record["cleared_at"]:
            raise AdminError(Text("文件已不在对象存储中"), 410)
        if record["stored_at"]:
            return {"task_id": identifier, "status": "completed", "progress": 1,
                    "cloud_file": cloud_file_view(connection, record)}
        return self.running.get(identifier) or self.failed.get(identifier)

    def start(self, connection, identifier):
        """Schedule at most one worker for the reserved file, including concurrent retries."""
        with self.lock:
            state = self._state(connection, get_cloud_file(connection, identifier))
            if state and state["status"] != "failed":
                return state
            task = {"task_id": identifier, "status": "running", "stage": "queued", "progress": 0}
            self.failed.pop(identifier, None)
            self.running[identifier] = task
            try:
                self.workers.submit(self._run, identifier)
            except RuntimeError:
                self.running.pop(identifier, None)
                raise storage_http_error(StorageUnavailable()) from None
            return task

    def status(self, connection, identifier):
        """Read the saved result or the current process's progress; an interrupted copy is retryable."""
        with self.lock:
            state = self._state(connection, get_cloud_file(connection, identifier))
            return state or self._failure(identifier, ValueError(Text("电脑上的上传任务已中断，请重试")))

    def _progress(self, identifier, stage, progress):
        with self.lock:
            self.running[identifier] = {"task_id": identifier, "status": "running", "stage": stage, "progress": progress}

    @staticmethod
    def _failure(identifier, error):
        if isinstance(error, StorageUnavailable):
            error = storage_http_error(error)
        details = error_body(error)
        if details.get("error_text"):
            details["texts"] = {"error": details["error_text"]}
        return {"task_id": identifier, "status": "failed", "progress": 0, **details}

    def _copy(self, connection, record):
        client = configured_storage(self.database)
        if not client:
            raise FileExistsError(Text("对象存储未配置"))
        identifier = record["id"]
        path = attachment_path(self.database, {"id": record["source_ref"]})
        if path != path.resolve() or not path.is_file():
            raise LookupError(Text("附件原文件缺失"))
        with path.open("rb") as file:
            if os.fstat(file.fileno()).st_size != record["size"]:
                raise LookupError(Text("附件原文件缺失"))
            self._progress(identifier, "uploading", 0)
            upload = client.upload(record["object_name"], record["size"], record["content_type"])
            stream_cloud_copy(file, record, upload, lambda stage, fraction: self._progress(identifier, stage, fraction))
        self._progress(identifier, "verifying", 0.99)
        finish_cloud_file(connection, client, record)

    def _run(self, identifier):
        failure = None
        try:
            with closing(connect_db(self.database)) as connection:
                record = get_cloud_file(connection, identifier)
                if record["cleared_at"]:
                    raise AdminError(Text("文件已不在对象存储中"), 410)
                if not record["stored_at"]:
                    self._copy(connection, record)
        except (AdminError, FileExistsError, LookupError, StorageUnavailable) as error:
            failure = self._failure(identifier, error)
        except OSError:
            failure = self._failure(identifier, StorageUnavailable())
        except Exception:
            logging.exception("Cloud attachment copy failed: %s", identifier)
            failure = self._failure(identifier, StorageUnavailable())
        finally:
            with self.lock:
                self.running.pop(identifier, None)
                if failure is not None:
                    self.failed[identifier] = failure
                    if len(self.failed) > CLOUD_COPY_FAILED_RESULTS:
                        self.failed.popitem(last=False)


class CloudLandGrants:
    """Account-local, short-lived, single-use permits to land an exact source attachment."""

    def __init__(self):
        self.lock = threading.Lock()
        self.pending = {}

    def issue(self, target):
        """Bind a random permit to the destination room, source room and attachment."""
        secret = secrets.token_hex(32)
        now = time.monotonic()
        with self.lock:
            self.pending = {key: value for key, value in self.pending.items() if value[0] > now}
            self.pending[token_hash(secret)] = (now + CLOUD_LAND_GRANT_SECONDS, target)
        return secret

    def consume(self, secret, target):
        """Claim a matching permit before contacting storage; a second claim always fails."""
        if not isinstance(secret, str) or not re.fullmatch(r"[0-9a-f]{64}", secret):
            return False
        key = token_hash(secret)
        with self.lock:
            entry = self.pending.get(key)
            if entry is None or entry[0] <= time.monotonic() or entry[1] != target:
                return False
            del self.pending[key]
            return True


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
        self.analytics_cache = {}
        # The server whose update stream this one shares; a site's local and remote entries see the same changes.
        self.hub = hub or self
        self.cloud_copies = hub.cloud_copies if hub else CloudCopyJobs(self.database)
        self.cloud_land_grants = hub.cloud_land_grants if hub else CloudLandGrants()
        self.updates = threading.Condition()
        self.update_version = 0
        # Recent (version, room id or None) pairs, so a stream names the rooms that changed; None means the whole site.
        self.update_log = collections.deque(maxlen=UPDATE_LOG_SIZE)
        self.updates_closed = False
        if local_launch and (address[0] != "127.0.0.1" or hub):
            raise ValueError(Text('本机启动入口须绑定 127.0.0.1'))
        self.local_launch = local_launch
        # Project media the local page may play: ticket -> (path, size, mtime_ns, content_type, name, expires).
        self.media_tickets = {}
        # Project pages opened in a tab of the computer's own browser: ticket -> (project folder, expires).
        self.page_tickets = {}
        self.media_lock = threading.Lock()
        self.local_site = not hub and address[0] in ("127.0.0.1", "::1", "localhost")
        self.admin_setup_key = os.getenv("DISCUSS_ADMIN_SETUP_KEY") or secrets.token_urlsafe(18)
        service_home = os.getenv("DISCUSS_SERVICE_HOME")
        self.connections_file = Path(service_home) / "site-connections.json" if service_home else None
        # A hosted instance serves only callers that prove they hold its key (backend/entry_guard.py).
        self.entry_policy = EntryPolicy()
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
        if self.hub is self:
            self.cloud_copies.workers.shutdown(wait=False, cancel_futures=True)
        super().server_close()


# The administrator login lives in an HttpOnly cookie (same name and lifetime as backend/worker.mjs).
ADMIN_COOKIE = "codiscuss_admin"
ADMIN_COOKIE_SECONDS = 30 * 86400
RELAY_READ_ID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
RELAY_READ_HEADER = "X-CoDiscuss-Relay-Request-Id"
SLOW_RELAY_READ_MS = 500
# A request taking this long is logged with its duration, so a stalled site shows which requests it was stuck on.
SLOW_REQUEST_MS = 3000
FULL_RELAY_READ_TIMING = os.getenv("CODISCUSS_RELAY_READ_TIMING") == "1"


class DiscussionHandler(BaseHTTPRequestHandler):
    """Serve the browser UI and explicit plain-text discussion endpoints."""

    def log_message(self, message_format, *args):
        """Log request paths without message text stored in URL queries."""
        logging.info("%s %s", self.command, cloud_shares.audit_path(urlsplit(self.path).path))

    def respond(self, body, status=200, content_type="application/json"):
        """Send a UTF-8 response that browsers and proxies must not cache."""
        if isinstance(body, dict) and isinstance(body.get("error"), Text):
            body = {**body, **error_body(body["error"])}
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
        if self.command in ("POST", "DELETE") and parts[:2] == ["api", "rooms"] and (len(parts) > 3 or created) and not quiet_renewal:
            self.api_record = {"room_id": parts[2] if len(parts) > 3 else body["id"], "at": getattr(self, "started_ms", int(time.time() * 1000)),
                               "method": self.command, "path": "/" + "/".join(parts[3:]), "status": status,
                               "client": self.headers.get("User-Agent", "").split(" ")[0][:60], "bridged": bool(getattr(self, "bridged", False)),
                               "token": self.headers.get("X-Discussion-Token", ""),
                               "actor": getattr(self, "api_actor_override", None),
                               "payload": {} if parts[3:5] == ["guest", "redeem"] else
                               getattr(self, "payload_cache", None) or getattr(self, "request_params", {}),
                               "error": body.get("error", "") if status >= 400 and isinstance(body, dict) else "",
                               "error_text": body.get("error_text") if status >= 400 and isinstance(body, dict) else None}
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
        if getattr(self, "relay_read_started", None) is not None and self.bridged:
            self.log_relay_read(parts, status, len(data))
        self.send_payload(status, content_type, data)

    def log_relay_read(self, parts, status, body_bytes):
        """Log a bridged room read with its category and local elapsed time."""
        if parts == ["api", "rooms"]:
            route = "directory"
        elif parts[:2] == ["api", "rooms"] and len(parts) == 3:
            route = "room"
        elif parts[:2] == ["api", "rooms"] and parts[3:] == ["messages"]:
            route = "messages"
        else:
            return
        elapsed_ms = (time.perf_counter() - self.relay_read_started) * 1000
        if not FULL_RELAY_READ_TIMING and elapsed_ms <= SLOW_RELAY_READ_MS:
            return
        logging.info("relay-read %s", json.dumps({"request_id": self.headers[RELAY_READ_HEADER], "route": route,
                     "status": status, "elapsed_ms": round(elapsed_ms), "body_bytes": body_bytes}))

    def send_payload(self, status, content_type, data):
        """Write the status line, headers and encoded body."""
        self.send_response(status)
        # Binary assets (WebAssembly, fonts, images) carry no charset; `application/wasm` must stay exact for streaming compile.
        textual = content_type.startswith("text/") or content_type == "application/json"
        self.send_header("Content-Type", f"{content_type}; charset=utf-8" if textual else content_type)
        if self.command != "HEAD":
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
        if self.command != "HEAD":
            self.wfile.write(data)

    def read_payload(self, limit=MAX_BODY_BYTES):
        """Read a bounded JSON object from an incoming form API request."""
        if getattr(self, "payload_cache", None) is not None:
            return self.payload_cache
        length = int(self.headers.get("Content-Length", "0"))
        if not 0 < length <= limit:
            raise ValueError(Text('请求内容为空或过大'))
        payload = json.loads(self.rfile.read(length))
        if not isinstance(payload, dict):
            raise ValueError(Text('请求必须是 JSON 对象'))
        self.payload_cache = payload
        return payload

    def dispatch(self, method):
        """Route a request and consistently report validation or lookup errors."""
        trace_id = self.headers.get(RELAY_READ_HEADER, "") if method == "GET" else ""
        self.relay_read_started = time.perf_counter() if RELAY_READ_ID.fullmatch(trace_id) else None
        self.payload_cache = None
        self.has_explicit_room_token = bool(self.headers.get("X-Discussion-Token"))
        self.bridge_origin = None
        self.api_record = None
        self.api_actor_override = None
        self.deferred_response = None
        self.started_ms = int(time.time() * 1000)
        self.streaming = False
        started = time.perf_counter()
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
            elapsed_ms = int((time.perf_counter() - started) * 1000)
            if elapsed_ms >= SLOW_REQUEST_MS and not self.streaming:
                logging.warning("slow request %s %s %d ms", method, cloud_shares.audit_path(parsed.path), elapsed_ms)

    def entry_refused(self, method, parsed):
        """Under entry protection: answer a hello, or refuse a request that is neither public nor proven on its connection."""
        policy = self.server.entry_policy
        if not policy.enabled:
            return False
        if method == "GET" and parsed.path == HELLO_PATH:
            answer_hello(self, policy)
            return True
        self.entry_key = request_proven(self, policy)
        if self.entry_key:
            return False
        if method == "GET" and parsed.path == OPEN_PATH:
            return self.open_browser_session(policy, parsed)
        if browser_admitted(self, policy):
            return False
        if method == "GET" and (parsed.path in ASSETS or parsed.path in PUBLIC_PATHS):
            return False
        self.close_connection = True
        # Sent directly, not through respond(): a refused caller leaves nothing in any room's event log.
        message = Text("这个工作台只接受经入口的访问；本机管理员请从任务栏图标或桌面“共议”打开")
        self.send_payload(403, "application/json", json.dumps(error_body(message), ensure_ascii=False).encode("utf-8"))
        return True

    def open_browser_session(self, policy, parsed):
        """Turn a fresh signed opening link into the browser cookie and go to the site; refuse anything else."""
        params = {key: values[-1] for key, values in parse_qs(parsed.query).items()}
        key = open_link_key(policy, params.get("at"), params.get("sig"), int(time.time()))
        self.close_connection = True
        if not key:
            language = reading_language(self.headers.get("Accept-Language"))
            message = read_text(Text("链接已失效，请从任务栏图标或桌面“共议”重新打开。"), language)
            self.send_payload(403, "text/plain", message.encode("utf-8"))
            return True
        self.send_response(302)
        cookie = f"{browser_cookie_name(self.server.server_port)}={proof(key, 'browser', 'site')}"
        self.send_header("Set-Cookie", f"{cookie}; Max-Age={BROWSER_COOKIE_SECONDS}; Path=/; HttpOnly; SameSite=Strict")
        self.send_header("Location", "/")
        self.send_header("Content-Length", "0")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Referrer-Policy", "no-referrer")
        self.end_headers()
        return True

    def end_headers(self):
        """Say so when an HTTP/1.1 connection (one opened by an entry hello) closes after this response."""
        if self.request_version == "HTTP/1.1" and self.protocol_version == "HTTP/1.1" and self.close_connection:
            self.send_header("Connection", "close")
        super().end_headers()

    def dispatch_routes(self, method, parsed, params, parts, text_mode):
        """Route one request and map validation, permission and lookup errors to their status codes."""
        try:
            if self.headers.get("X-Discussion-Token") or guest_path(parts):
                with closing(connect_db(self.server.database)) as guard_connection:
                    guest_guard(guard_connection, self.headers, parts, method)
            if method == "HEAD" or (method == "OPTIONS" and parts[:2] != ["api", "local"]):
                return self.respond({"error": Text("地址不存在")}, 404)
            if self.page_host_request():
                if parts[:3] == ["api", "local", "page"] and len(parts) >= 5 and method == "GET":
                    return self.serve_page_ticket(parts[3], parts[4:])
                raise LookupError(Text('地址不存在'))
            if method == "GET" and (share := cloud_shares.PUBLIC_PATH.fullmatch(parsed.path)):
                return cloud_shares.redeem(self, share, connect_db, stored_object_download)
            if self.entry_refused(method, parsed):
                return None
            try:
                guard_external_route(lambda: connect_db(self.server.database), self.headers, parts)
            except PermissionError:
                # Read the unread body first, or the refusal can reach the gateway as a reset connection.
                self.rfile.read(min(int(self.headers.get("Content-Length") or 0), MAX_BODY_BYTES))
                self.close_connection = True
                raise
            self.bridged = self.relay_bridge(parts)
            if parts[:3] == ["api", "local", "media"] and len(parts) == 4 and method == "GET":
                return self.serve_media_ticket(parts[3])
            if parts[:2] == ["api", "local"]:
                return self.handle_local_launch(parts, method)
            if parts == ["api", "updates"] and method == "GET":
                return self.stream_updates()
            if method == "GET" and parsed.path in ASSETS:
                filename, content_type = ASSETS[parsed.path]
                return self.respond((WEB_ROOT / filename).read_bytes(), content_type=content_type)
            if method == "GET" and parsed.path == "/robots.txt":
                return self.respond("User-agent: *\nAllow: /\n", content_type="text/plain")
            with closing(connect_db(self.server.database)) as connection:
                with connection:
                    if guest_path(parts):
                        return self.handle_guest_projection(connection, parts, params, method)
                    if is_external_path(parts):
                        return self.handle_external_api(connection, parts, params, method)
                    if text_mode and method == "GET":
                        return self.handle_text(connection, parts, params)
                    response = self.handle_api(connection, parts, params, method)
                for room in connection.moss_updates:
                    self.server.hub.notify_update(room)
                return response
        except AdminError as error:
            return self.respond(error_body(error), error.status)
        except PermissionError as error:
            if getattr(error, "details", {}).get("code", "").startswith("guest_"):
                self.close_connection = True
            return self.respond(self.request_error(error, parts), 403)
        except (ValueError, TypeError) as error:
            return self.respond(self.plain_error(error) if text_mode else self.request_error(error, parts), 400,
                                "text/plain" if text_mode else "application/json")
        except (IndexError, KeyError):
            logging.exception("Request failed")
            return self.respond(error_body(Text("服务器内部错误")), 500)
        except LookupError as error:
            return self.respond(self.plain_error(error) if text_mode else self.request_error(error, parts), 404,
                                "text/plain" if text_mode else "application/json")
        except FileExistsError as error:
            return self.respond(self.plain_error(error) if text_mode else self.request_error(error, parts), 409,
                                "text/plain" if text_mode else "application/json")
        except Exception:
            logging.exception("Request failed")
            return self.respond(error_body(Text("服务器内部错误")), 500)

    def request_error(self, error, parts):
        """Use the guest envelope on guest routes and for authorization refusals."""
        body = error_body(error)
        if guest_path(parts) or parts[:2] == ["api", "rooms"] and parts[3:4] == ["guest"] or body.get("code") == "guest_forbidden":
            message = body["error"]
            if message == "访客操作不可用" and reading_language(self.headers.get("Accept-Language", "")) == "en":
                message = "The guest operation is unavailable."
            return {**body, "ok": False, "error": {"message": message},
                    "code": body.get("code", "guest_forbidden" if isinstance(error, PermissionError)
                                     else "not_found" if isinstance(error, LookupError) else "invalid_input")}
        return body

    def plain_error(self, error):
        """Render a `/r` reading error in the reader's Accept-Language; untemplated errors stay as raised."""
        value = error.args[0] if len(error.args) == 1 and isinstance(error.args[0], Text) else str(error)
        return read_text(value, self.headers.get("Accept-Language", ""))

    def do_GET(self):
        """Handle read-only GET requests."""
        self.dispatch("GET")

    def do_POST(self):
        """Handle JSON mutations and explicit binary attachment uploads."""
        self.dispatch("POST")

    def do_HEAD(self):
        """Apply the credential boundary to HEAD, which otherwise has no routes."""
        self.dispatch("HEAD")

    def send_error(self, code, message=None, explain=None):
        """Apply the guest boundary even when the HTTP verb has no handler."""
        if code == 501 and getattr(self, "headers", None) is not None and self.headers.get("X-Discussion-Token"):
            parts = urlsplit(self.path).path.strip("/").split("/")
            try:
                with closing(connect_db(self.server.database)) as connection:
                    guest_guard(connection, self.headers, parts, self.command)
            except PermissionError as error:
                self.close_connection = True
                self.send_payload(403, "application/json", json.dumps(self.request_error(error, parts), ensure_ascii=False).encode("utf-8"))
                return
        super().send_error(code, message, explain)

    def stream_updates(self):
        """Stream invalidations without holding a database connection or exposing records."""
        self.streaming = True
        self.close_connection = True
        self.connection.settimeout(5)
        hub = self.server.hub
        # Under entry protection a stream ends when the key changes or goes, even if nothing else happens meanwhile.
        policy = self.server.entry_policy
        opened_key = getattr(self, "entry_key", None) if policy.enabled else None
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
                if policy.enabled and policy.key() != opened_key:
                    return
                self.wfile.write(update_frame(rooms) if changed else b": keepalive\n\n")
                self.wfile.flush()
        except OSError:
            pass

    def do_OPTIONS(self):
        """Handle preflight only for explicitly connected websites on the local bridge."""
        return self.dispatch("OPTIONS")

    def local_request_site(self, method):
        """Authenticate a local page or a site-bound browser connection before reading configuration."""
        if not self.server.local_launch:
            raise LookupError(Text('本机启动未启用，请使用 python server.py --local-launch'))
        allowed_hosts = {f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}"}
        host = self.headers.get("Host", "")
        origin = self.headers.get("Origin")
        if self.client_address[0] != "127.0.0.1" or host not in allowed_hosts:
            raise PermissionError(Text('本机启动只接受本机同源请求'))
        if origin and origin != f"http://{host}":
            return self.connected_request_site(origin, method)
        if (method == "OPTIONS" or self.headers.get("X-CoDiscuss-Local") != "1"
                or self.headers.get("Sec-Fetch-Site", "same-origin") not in ("same-origin", "none")):
            raise PermissionError(Text('本机启动只接受本机同源请求'))
        return f"http://{host}"

    def connected_request_site(self, origin, method):
        """Require both an explicitly registered origin and its private connection credential."""
        path = self.server.connections_file
        settings = json.loads(path.read_text(encoding="utf-8")) if path and path.exists() else {}
        connection = settings.get("sites", {}).get(origin, {})
        # A website the runner relays for reaches this computer only through paired, signed and unlocked devices; a
        # browser credential kept from before would skip all of that.
        if connection.get("bridge_hash"):
            raise PermissionError(Text('此网站经已配对设备的中转访问这台电脑，不再接受本机连接；请在设置 → 账号中配对这台设备'))
        expected = connection.get("token_hash")
        if not isinstance(expected, str) or not expected:
            raise PermissionError(Text('此网站尚未连接本机；请运行 codiscuss local connect 站点地址'))
        self.bridge_origin = origin
        if method == "OPTIONS":
            headers = {value.strip().lower() for value in self.headers.get("Access-Control-Request-Headers", "").split(",")}
            allowed = {"content-type", "x-codiscuss-local", "x-codiscuss-connection"}
            if (self.headers.get("Access-Control-Request-Method") not in ("GET", "POST")
                    or not {"x-codiscuss-local", "x-codiscuss-connection"}.issubset(headers) or headers - allowed):
                raise PermissionError(Text('连接请求不受支持'))
            return origin
        credential = self.headers.get("X-CoDiscuss-Connection", "")
        if (self.headers.get("X-CoDiscuss-Local") != "1" or not re.fullmatch(r"[a-f0-9]{64}", credential)
                or not hmac.compare_digest(token_hash(credential), expected)):
            raise PermissionError(Text('本机连接已失效，请重新运行 codiscuss local connect 站点地址'))
        return origin

    def handle_local_launch(self, parts, method):
        """Forward authenticated browser requests to the shared Node entrypoint and pin their website."""
        route = parts[2:]
        if route[:2] == ["project-files", "cloud"]:
            return self.handle_local_project_cloud(route[2:], method)
        if route in (["project-files", "cloud-upload"], ["project-files", "cloud-land"]):
            return self.handle_local_project_cloud([], method, command="project-" + route[1])
        if route in (["project-cloud-upload"], ["project-cloud-land"]):
            return self.handle_local_project_cloud([], method, command=route[0])
        if route in (["project-cloud"], ["project-cloud-status"]):
            return self.handle_local_project_cloud([], method, status_alias=route[0] == "project-cloud-status")
        if route == ["share-job"] and method == "POST" and not self.server.local_launch:
            return self.respond({"enabled": False})
        site = self.local_request_site(method)
        if method == "OPTIONS" and route in (["settings"], ["object-storage-settings"], ["launch"], ["wipe-histories"], ["room-models"], ["room-skills"], ["room-files"], ["share-job"], ["room-page"], ["room-media"], ["execution-details"], ["room-member"], ["room-member-access"], ["room-member-allow"], ["room-member-adapter"], ["room-member-model"], ["room-profiles"], ["room-restore"], ["room-fork"], ["models"], ["sessions"], ["api-key"], ["api-check"],
                                             ["scheduler-check"], ["image-check"], ["image-settings"], ["tts-settings"], ["tts"], ["tts-release"], ["local-speech"], ["stt"], ["weixin"], ["notify"], ["pick-directory"], ["browse-directory"], ["projects"], ["presets"], ["workflows"], ["room-workflow"], ["room-settings"], ["machine-link"], ["device-pairing"], ["devices"]) or (method == "OPTIONS" and len(route) == 1 and route[0] in INVITE_COMMANDS + INVITED_COMMANDS + SITE_COMMANDS + STEWARD_COMMANDS):
            return self.respond({"ok": True})
        if route in (["settings"], ["object-storage-settings"]) and method in ("GET", "POST"):
            command = route[0]
        elif (route == ["storage"] and method in ("GET", "POST")) or (route == ["storage-clean"] and method == "POST"):
            with closing(connect_db(self.server.database)) as connection:
                if self.bridge_origin or self.entry_member_request() or not self.admin_session(connection):
                    raise PermissionError(Text('需要管理员登录'))
            command = route[0]
        elif route == ["launch"] and method == "POST":
            command = "start"
        elif route == ["room-config"] and method == "POST" and not self.bridge_origin:
            command = "room-config"
        elif route == ["room-models"] and method == "POST":
            command = "room-models"
        elif route == ["models"] and method == "POST":
            command = "models"
        elif route == ["sessions"] and method == "POST":
            command = "sessions"
        elif route == ["api-key"] and method == "POST":
            command = "api-key"
        elif route == ["api-check"] and method == "POST":
            command = "api-check"
        elif route == ["scheduler-check"] and method == "POST":
            command = "scheduler-check"
        elif route in (["image-check"], ["image-settings"], ["tts-settings"], ["tts"], ["tts-release"], ["local-speech"], ["stt"], ["weixin"], ["notify"]) and method == "POST":
            command = route[0]
        elif route in (["room-member"], ["room-member-access"], ["room-member-allow"], ["room-member-adapter"], ["room-member-model"]) and method == "POST":
            command = route[0]
        elif route in (["room-profiles"], ["room-skills"], ["room-files"], ["share-job"], ["room-page"], ["room-media"], ["execution-details"], ["room-restore"], ["room-fork"]) and method == "POST":
            command = route[0]
        elif route == ["pick-directory"] and method == "POST":
            command = "pick-directory"
        elif route == ["browse-directory"] and method == "POST":
            command = "browse-directory"
        elif route in (["device-pairing"], ["devices"]) and method == "POST":
            # Which devices this computer trusts is decided at its own screen; a connected website's page cannot.
            if self.bridge_origin:
                raise PermissionError(Text('设备配对与撤销只能在这台电脑的本机网页上操作，或在已配对的设备上操作'))
            command = route[0]
        elif route == ["projects"] and method == "POST":
            command = "projects"
        elif route == ["presets"] and method == "POST":
            command = "presets"
        elif route == ["wipe-histories"] and method == "POST":
            command = "wipe-histories"
        elif route in (["workflows"], ["room-workflow"], ["room-settings"]) and method == "POST":
            command = route[0]
        elif route == ["machine-link"] and method == "POST":
            command = "machine-link"
        elif len(route) == 1 and route[0] in STEWARD_COMMANDS and method == "POST":
            command = route[0]
        elif len(route) == 1 and route[0] in INVITE_COMMANDS + INVITED_COMMANDS + SITE_COMMANDS and method == "POST":
            # Invites for members on other computers (runner/external_gateway.mjs), invited rooms (runner/external_client.mjs),
            # and website publishing commands (runner/site_deploy.mjs).
            command = route[0]
        else:
            raise LookupError(Text('本机入口不存在'))
        payload = None
        if method == "POST":
            if self.headers.get_content_type() != "application/json":
                raise ValueError(Text('本机操作须使用 application/json'))
            payload = self.read_payload(MAX_FILE_PART_BODY_BYTES if command == "room-files" else MAX_BODY_BYTES)
            if command in ("start", "room-config", "room-models", "room-skills", "room-files", "share-job", "room-page", "room-media", "execution-details", "room-member", "room-member-access", "room-member-allow", "room-member-adapter", "room-member-model", "room-profiles", "room-restore", "room-fork", "room-workflow", "room-settings", "workflows") + SITE_COMMANDS:
                payload.pop("access_file", None)
                payload.update(site=site, entry="web")
            if command in ("room-skills", "room-files", "share-job", "room-page", "room-media", "execution-details", "room-workflow", "room-settings", "room-member", "room-member-access", "room-member-allow", "room-member-model", "room-member-adapter") + SITE_COMMANDS and payload.get("room_id") and not payload.get("token") and not self.bridge_origin:
                with closing(connect_db(self.server.database)) as connection:
                    self.admin_as_owner(connection, payload.get("room_id", ""))
                    payload["token"] = self.headers.get("X-Discussion-Token", "")
            # A fork from a browser without the source room's credential acts as its owner, as the commands above do.
            if command in INVITE_COMMANDS and not payload.get("token") and not self.bridge_origin:
                with closing(connect_db(self.server.database)) as connection:
                    self.admin_as_owner(connection, payload.get("room_id", ""))
                    payload["token"] = self.headers.get("X-Discussion-Token", "")
            if command == "room-fork" and not payload.get("source_token") and not self.bridge_origin:
                with closing(connect_db(self.server.database)) as connection:
                    self.admin_as_owner(connection, payload.get("source_room_id", ""))
                    payload["source_token"] = self.headers.get("X-Discussion-Token", "")
            if command == "share-job" and payload.get("op") == "list" and not self.bridge_origin:
                with closing(connect_db(self.server.database)) as connection:
                    if not self.admin_session(connection):
                        raise PermissionError(Text('需要管理员登录'))
            if command == "machine-link":
                payload = {"site": site}
        if command == "room-config" and "participants" in payload:
            return self.save_local_room_configuration(command, payload)
        # The computer's own page plays a project media file straight from disk by a ticket, with ranges for seeking;
        # a thumbnail comes back whole, as to another device.
        if command == "room-media" and not self.bridge_origin and payload.get("thumbnail") is not True:
            return self.issue_media_ticket(payload)
        # A connected website's page is another device's entry: it gets the same limits as the relay.
        return self.run_local_command(command, payload, remote=bool(self.bridge_origin) and command != "machine-link")

    def issue_media_ticket(self, payload):
        """Let the runner check the member's access to one project media file, then hand the page a ticket URL for it.

        The page never learns the file's path; the ticket names one file as it was checked and expires.
        """
        if payload.get("page") is True:
            return self.issue_page_ticket(payload)
        status, result = self.local_command_result("room-media", payload)
        if status != 200:
            return self.respond(result, status)
        result.pop("directory", None)
        path = Path(result.pop("file"))
        info = path.stat()
        ticket = secrets.token_urlsafe(32)
        now = time.time()
        with self.server.media_lock:
            tickets = self.server.media_tickets
            for key in [key for key, item in tickets.items() if item[5] <= now]:
                del tickets[key]
            while len(tickets) >= MAX_MEDIA_TICKETS:
                del tickets[next(iter(tickets))]
            # A download is saved by the browser instead of shown.
            disposition = "attachment" if payload.get("download") is True else "inline"
            tickets[ticket] = (path, info.st_size, info.st_mtime_ns, result["content_type"], path.name, now + MEDIA_TICKET_SECONDS, disposition)
        return self.respond({**result, "url": f"/api/local/media/{ticket}"})

    def issue_page_ticket(self, payload):
        """Open a project HTML file in a tab of this computer's browser straight from disk, with the files beside it.

        The runner checks the member's access to the file as for media; the ticket names the project folder, and the
        address mirrors the file's place in it, so relative references resolve inside the folder.
        """
        if not re.search(r"\.html?$", str(payload.get("path", "")), re.I):
            raise ValueError(Text('只能打开 HTML 文件'))
        inject = payload.get("inject") or ""
        if not isinstance(inject, str) or len(inject.encode("utf-8")) > MAX_PAGE_INJECT_BYTES:
            raise ValueError(Text('页面附加脚本无效'))
        status, result = self.local_command_result("room-media", {**{key: value for key, value in payload.items() if key not in ("page", "inject")}, "download": True})
        if status != 200:
            return self.respond(result, status)
        root, path = Path(result["directory"]).resolve(), Path(result["file"]).resolve()
        ticket = secrets.token_urlsafe(32)
        now = time.time()
        with self.server.media_lock:
            tickets = self.server.page_tickets
            for key in [key for key, item in tickets.items() if item[1] <= now]:
                del tickets[key]
            while len(tickets) >= MAX_MEDIA_TICKETS:
                del tickets[next(iter(tickets))]
            # `inject`: a script the computer's own page asked to put into this file alone, after its doctype (the
            # preview's selection bridge, so a passage chosen in the page can go into the conversation).
            tickets[ticket] = (root, now + PAGE_TICKET_SECONDS, path, inject)
        relative = "/".join(quote(part) for part in path.relative_to(root).parts)
        return self.respond({"url": f"http://{page_host(root, self.server.server_port)}/api/local/page/{ticket}/{relative}"})

    def page_host_request(self):
        """Whether a loopback request names a page origin; such a host reaches nothing of this site but page files."""
        match = PAGE_HOST.fullmatch(self.headers.get("Host", ""))
        if not match:
            return False
        if not self.server.local_site or self.client_address[0] != "127.0.0.1" or int(match[2]) != self.server.server_port:
            raise LookupError(Text('地址不存在'))
        return True

    def serve_page_ticket(self, ticket, parts):
        """Serve one file of the project folder a page ticket names, on that folder's own origin; nothing outside it."""
        with self.server.media_lock:
            item = self.server.page_tickets.get(ticket)
        if not item or item[1] <= time.time():
            raise LookupError(Text('页面地址已过期，请重新打开文件'))
        root = item[0]
        if self.headers.get("Host", "") != page_host(root, self.server.server_port):
            raise LookupError(Text('文件不存在'))
        names = [unquote(part) for part in parts]
        if any(name in ("", ".", "..") or ":" in name or "\\" in name for name in names):
            raise LookupError(Text('文件不存在'))
        path = root.joinpath(*names).resolve()
        if not path.is_relative_to(root) or not path.is_file():
            raise LookupError(Text('文件不存在'))
        content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        if content_type.startswith("text/") or content_type in ("application/javascript", "application/json"):
            content_type += "; charset=utf-8"
        if item[3] and path == item[2]:
            text = path.read_bytes().decode("utf-8", errors="replace")
            doctype = re.match(r"\ufeff?\s*<!doctype[^>]*>", text, re.I)
            at = doctype.end() if doctype else 0
            return self.send_file(None, content_type, path.name, "inline", data=(text[:at] + item[3] + text[at:]).encode("utf-8"), policy="")
        self.send_file(path, content_type, path.name, "inline", policy="")

    def serve_media_ticket(self, ticket):
        """Stream the project media file a ticket names, refusing it once expired or changed since it was checked."""
        with self.server.media_lock:
            item = self.server.media_tickets.get(ticket)
        if not item or item[5] <= time.time():
            raise LookupError(Text('播放地址已过期，请重新打开文件'))
        path, size, mtime_ns, content_type, name, _, disposition = item
        try:
            info = path.stat()
        except OSError:
            raise LookupError(Text('文件已不存在')) from None
        if (info.st_size, info.st_mtime_ns) != (size, mtime_ns):
            raise FileExistsError(Text('文件已变化，请重新打开'))
        self.send_file(path, content_type, name, disposition)

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
                raise FileExistsError(Text('房间状态已变化，请暂停后重新读取本场配置'))
            return self.run_local_command(command, payload, configuration_locked=True)

    def run_local_command(self, command, payload, configuration_locked=False, remote=False):
        """Run the fixed local Node entrypoint after the same-origin request checks, and answer with its result."""
        status, result = self.local_command_result(command, payload, configuration_locked, remote)
        return self.respond(result, status)

    def handle_local_project_cloud(self, route, method, *, status_alias=False, command="project-cloud"):
        """Start or read a private project upload using the same room proof as the file page."""
        site = self.local_request_site(method)
        if self.read_only_request() or self.headers.get(ACTING_MEMBER_HEADER):
            raise PermissionError(Text('需要管理员登录'))
        task_status = len(route) == 1 and re.fullmatch(r"[a-f0-9]{32}", route[0])
        if method == "OPTIONS" and (not route or task_status):
            return self.respond({"ok": True})
        if status_alias or method == "GET" and task_status:
            if status_alias:
                if method != "POST" or self.headers.get_content_type() != "application/json":
                    raise LookupError(Text('本机入口不存在'))
                task_id = self.read_payload().get("task_id")
            else:
                task_id = route[0]
            if self.headers.get("X-Discussion-Token"):
                raise PermissionError(Text('需要管理员登录'))
            return self.run_local_command("project-cloud-status", {"task_id": task_id})
        if method != "POST" or route:
            raise LookupError(Text('本机入口不存在'))
        if self.headers.get_content_type() != "application/json":
            raise ValueError(Text('本机操作须使用 application/json'))
        payload = self.read_payload()
        room = payload.get("room")
        if not isinstance(room, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", room):
            raise ValueError(Text('房间编号无效'))
        grant = None
        if command == "project-cloud-land" and (payload.get("cloud_file_id") is not None
                                                or payload.get("attachment_room") not in (None, room)):
            grant = self.authorize_cross_room_landing(payload)
        token = self.headers.get("X-Discussion-Token") or payload.get("token")
        if not token and not self.bridge_origin:
            with closing(connect_db(self.server.database)) as connection:
                self.admin_as_owner(connection, room)
            token = self.headers.get("X-Discussion-Token")
        fields = {
            "project-cloud": ("room", "path", "root", "kind", "purpose"),
            "project-cloud-upload": ("room", "root", "path", "name", "size", "content_type", "submission_id"),
            "project-cloud-land": ("room", "task_id", "attachment_id", "attachment_room", "cloud_file_id", "root", "path", "conflict"),
        }[command]
        request = {key: payload[key] for key in fields if key in payload}
        if grant is not None:
            request["attachment_grant"] = grant
        return self.run_local_command(command, {**request, "site": site, "token": token}, remote=bool(self.bridged or self.bridge_origin))

    def authorize_cross_room_landing(self, payload):
        """Use account authority to issue a permit; the supplied room token is for the target only."""
        target = cloud_land_target(payload)
        if payload.get("task_id") is not None:
            raise ValueError(Text("附件编号无效"))
        with closing(connect_db(self.server.database)) as connection:
            self.require_cloud_account(connection)
            if not connection.execute("SELECT 1 FROM rooms WHERE id=?", (target[0],)).fetchone():
                raise LookupError(Text('房间不存在'))
            cloud_land_source(connection, target)
        return self.server.cloud_land_grants.issue(target)

    def claim_local_cloud_landing(self, connection, room_id, method):
        """Redeem a permit from this computer and return only its authorized attachment and short link."""
        if method != "POST" or self.headers.get_content_type() != "application/json":
            raise LookupError(Text('地址不存在'))
        if (not self.server.local_launch or self.client_address[0] != "127.0.0.1" or not self.local_visitor()
                or self.bridged or self.read_only_request() or self.headers.get(ACTING_MEMBER_HEADER)
                or self.headers.get("X-Discussion-Token") is not None):
            raise PermissionError(Text('需要管理员登录'))
        payload = self.read_payload()
        target = cloud_land_target({**payload, "room": room_id})
        if not self.server.cloud_land_grants.consume(payload.get("grant"), target):
            raise PermissionError(Text('需要管理员登录'))
        row = cloud_land_source(connection, target)
        view = ({"cloud_file": cloud_file_view(connection, row)} if target[1] is None
                else {"attachment": attachment_view(connection, row)})
        return self.respond({**view, "link": stored_object_download(self.server.database, row)})

    def local_command_result(self, command, payload, configuration_locked=False, remote=False):
        """Run the fixed local Node entrypoint; returns `(status, result)`, 400 with its error when it fails."""
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
            raise ValueError(Text('本机启动需要 Node.js 24+，请安装并加入 PATH')) from error
        except subprocess.TimeoutExpired as error:
            if command == "pick-directory":
                raise ValueError(Text('目录选择窗口已超时，请重试或直接输入完整路径')) from error
            raise ValueError(Text('启动结果未确认，请核对房间状态后沿用原配置重试')) from error
        if result.returncode:
            try:
                failure = json.loads(result.stderr.strip())
            except ValueError:
                raise ValueError(result.stderr.strip())
            status_code = failure.pop("http_status", 400) if isinstance(failure, dict) else 400
            if not isinstance(status_code, int) or not 400 <= status_code <= 599:
                status_code = 400
            return status_code, failure
        return 200, json.loads(result.stdout)

    def admin_token(self):
        """The administrator login from its HttpOnly cookie, or from the header scripts and tests use."""
        for item in self.headers.get("Cookie", "").split(";"):
            name, _, value = item.strip().partition("=")
            if name == ADMIN_COOKIE:
                return value
        return self.headers.get("X-Discussion-Admin", "")

    def entry_member_request(self):
        """Under entry protection, whether the request names a room credential: it then acts only as that credential.

        Passing the entry proves access to this instance, not a role in a room: a member's credential must not be lifted
        to the owner's because the request also looks like the loopback page.
        """
        return self.server.entry_policy.enabled and bool(self.headers.get("X-Discussion-Token"))

    def require_entry_owner(self, connection, room_id, token):
        """Under entry protection, room management needs the owner's credential or the credential-less page itself."""
        if self.entry_member_request():
            require_owner(connection, room_id, token)
        elif self.server.entry_policy.enabled and not self.local_visitor():
            raise PermissionError(Text('需要本房间的控制凭据'))

    def local_visitor(self, *, creating_room=False):
        """Whether this request may act as the loopback-only site's implicit administrator.

        The Host must name this loopback port, which defeats DNS rebinding, and a browser request must come from the site
        itself rather than another page. Programs on this computer can still send these headers; this guards browsers only.
        During creation the caller supplies a new room capability; it is not an existing room credential.
        """
        if not self.server.local_site or (self.entry_member_request() and not creating_room):
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

    def require_steward_creator(self, connection, new_token):
        """Only a site manager can create a room whose member will see site-wide dispatches."""
        if (self.read_only_request() or self.headers.get(ACTING_MEMBER_HEADER)
                or not (self.bridged or self.local_visitor(creating_room=True) or session_valid(connection, self.admin_token()))):
            raise PermissionError(Text('需要管理员身份'))
        hashed = token_hash(new_token)
        if hashed and connection.execute("SELECT 1 FROM room_members WHERE token_hash=? LIMIT 1", (hashed,)).fetchone():
            raise PermissionError(Text('需要管理员身份'))

    def relay_bridge(self, parts):
        """Whether this request comes from the runner relaying a paired device; a bad or misplaced bridge credential fails.

        The runner holds one bridge token per paired website and this site keeps only its hash. A bridged request acts
        as the administrator, so it is accepted only from this computer's loopback, on a loopback-only site, and only
        for room, folder, revision and published-site routes.
        """
        credential = self.headers.get("X-CoDiscuss-Bridge")
        if credential is None:
            return False
        path = self.server.connections_file
        settings = json.loads(path.read_text(encoding="utf-8")) if path and path.exists() else {}
        expected = settings.get("sites", {}).get(self.headers.get("X-CoDiscuss-Bridge-Site", ""), {}).get("bridge_hash")
        if (not self.server.local_site or self.client_address[0] != "127.0.0.1" or not isinstance(expected, str)
                or not re.fullmatch(r"[a-f0-9]{64}", credential) or not hmac.compare_digest(token_hash(credential), expected)):
            raise PermissionError(Text('本机中转凭据无效，请在电脑上重新连接网站'))
        project_cloud = parts[:3] == ["api", "local", "project-files"] and (
            len(parts) == 4 and parts[3] in {"cloud", "cloud-upload", "cloud-land"}
            or len(parts) == 5 and parts[3] == "cloud" and re.fullmatch(r"[a-f0-9]{32}", parts[4]))
        if not project_cloud and (parts[:1] != ["api"] or parts[1:2] not in (["rooms"], ["folders"], ["revisions"], ["sites"], ["analytics"])):
            raise PermissionError(Text('本机中转不允许访问该地址'))
        return True

    def admin_as_owner(self, connection, room_id):
        """Let a logged-in administrator, a relayed device, or a visitor of the loopback-only local site write as owner without
        the room credential: the local site already treats its visitors as the administrator. The remote entry is never local."""
        if self.headers.get("X-Discussion-Token") or not (self.bridged or self.local_visitor() or session_valid(connection, self.admin_token())):
            return
        row = connection.execute("SELECT control_hash FROM room_modes WHERE room_id=?", (room_id,)).fetchone()
        if row and row[0]:
            self.headers["X-Discussion-Token"] = owner_proxy_token(row[0])

    def read_only_request(self):
        """Whether a task of another room is reading this one: it may read, and nothing it does may change the room."""
        return bool(self.headers.get(READ_ONLY_HEADER))

    def refuse_read_only(self, parts, method):
        """Keep a cross-room reader to plain reads: no writes, no reads that change state, no private chats."""
        if self.read_only_request() and (method != "GET" or parts[3:4] in READ_ONLY_CLOSED or parts[5:6] == ["chat"]):
            raise PermissionError(Text('需要本房间的控制凭据'))

    def check_steward_write(self, connection, room_id, route, token):
        """Keep an archived steward read-only without preventing its owner from managing its lifecycle."""
        steward = connection.execute("SELECT archived FROM room_directory WHERE room_id=? AND system_kind='steward'",
                                     (room_id,)).fetchone()
        if steward is None:
            return
        if route in (["archive"], ["restore"], ["delete"]):
            require_owner(connection, room_id, token)
            return
        if route in (["members"], ["external-members"], ["guest", "invite"]):
            require_owner(connection, room_id, token)
            raise PermissionError(STEWARD_MEMBER_LIMIT)
        # A published link must be revocable before the owner can destroy the room.
        if steward["archived"] and (route != ["share-link"] or self.read_payload().get("link") is not None):
            raise ValueError(Text('房间已存档；恢复后才能继续协作'))

    def steward_member_write(self, connection, parts):
        """Scope both a MOSS member credential and a runner request carrying it on behalf of that member."""
        route = parts[3:]
        target = parts[2] if len(parts) > 2 else None
        delegated = self.headers.get(ACTING_MEMBER_HEADER, "")
        token = self.headers.get("X-Discussion-Token", "")
        member = steward_member(connection, delegated)
        acting_token = delegated if member else token
        if member is None:
            member = steward_member(connection, token)
        if member is None:
            return None
        self.api_actor_override = f"member:{member['name']}"
        if target == member["room_id"] and acting_token == token and member["active"]:
            if not (len(route) == 1 and route[0] in (*DIRECTORY_OPERATIONS, *ADMIN_OPERATIONS)):
                return None  # Own-room member routes still enforce the normal member credential rules.
        if target == member["room_id"] and route in (["host-room-post"], ["room-link"], ["room-relay-sent"], ["host-actions"]):
            self.read_payload()
            begin_write(connection)
            current = steward_member(connection, acting_token)
            if current and current["active"] and current["room_id"] == target:
                return None  # Existing routes still require the source room owner's credential.
        if target != member["room_id"] and route == ["archive"] and not self.read_only_request():
            self.read_payload()
            begin_write(connection)
            member = steward_member(connection, acting_token)
            if member and member["active"] and connection.execute(f"""SELECT 1 FROM rooms JOIN room_directory d ON d.room_id=rooms.id
                    WHERE rooms.id=? AND d.system_kind='' AND ({PARENT_ROOM})=?""", (target, member["room_id"])).fetchone():
                result = manage_room(connection, target, "archive", {"actor": "用户"})
                moss_results.reconcile_delegations(connection, target)
                connection.commit()
                return result
        self.read_payload()
        raise PermissionError(Text('需要本房间的控制凭据'))

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
            raise LookupError(Text('地址不存在'))
        payload = self.read_payload()
        if self.server.local_site and parts[2] != "profile":
            raise ValueError(Text('本地站点无需管理员账号'))
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
            raise LookupError(Text('地址不存在'))
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
            raise AdminError(Text('需要登录管理员账号'), 401)
        if parts[1] == "machines" and parts[3:4] == ["commands"]:
            if len(parts) == 4 and method == "POST":
                result = submit_machine_command(connection, parts[2], self.read_payload(), now)
            elif len(parts) == 5 and method == "GET":
                result = machine_command_status(connection, parts[2], parts[4])
            else:
                raise LookupError(Text('地址不存在'))
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
            raise LookupError(Text('地址不存在'))
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
        if method == "POST" and parts[:2] == ["api", "rooms"]:
            result = self.steward_member_write(connection, parts)
            if result is not None:
                return self.respond(result)
        if len(parts) == 5 and parts[:2] == ["api", "rooms"] and parts[3:] == ["cloud-land", "redeem"]:
            # Interpret the permit before implicit local ownership can add a room credential.
            return self.claim_local_cloud_landing(connection, parts[2], method)
        if parts == ["api", "attachment-limit"] and method == "GET":
            limit = attachment_limit_mib(self.server.database)
            return self.respond({"limit_mib": limit, **object_storage_limits(connection, self.server.database, limit)})
        if parts == ["api", "health"] and method == "GET":
            return self.respond({"ok": True})
        if parts[:2] == ["api", "admin"]:
            return self.handle_admin_api(connection, parts, method)
        if parts in (["api", "analytics"], ["api", "analytics", "moss"]) and method == "GET":
            if self.headers.get("X-Discussion-Token") is not None or not (self.bridged or self.admin_session(connection)):
                raise PermissionError(Text('需要管理员身份'))
            if parts[2:] == ["moss"]:
                return self.respond(moss_snapshot(connection, params, int(time.time())))
            return self.respond(analytics_snapshot(connection, params, self.server.analytics_cache, int(time.time())))
        if parts == ["api", "scheduler-feedback"] and method == "GET":
            if not self.admin_session(connection):
                raise AdminError(Text('需要登录管理员账号'), 401)
            return self.respond(list_feedback_cases(connection, int(params.get("after", 0))))
        if parts in (["api", "dispatches"], ["api", "analytics", "dispatches"]) and method == "GET":
            analytics_view = parts[1] == "analytics"
            token = self.headers.get("X-Discussion-Token")
            if not analytics_view and token and not self.read_only_request():
                if not is_active_steward_member(connection, token):
                    raise PermissionError(Text('需要管理员身份'))
            elif (self.read_only_request() or token
                    or not (self.admin_session(connection) or analytics_view and self.bridged)):
                raise AdminError(Text('需要登录管理员账号'), 401)
            view = params.get("view", "chains" if analytics_view else "messages")
            after = int(params.get("after", 0))
            if view not in ("messages", "chains") or not 0 <= after < 2**63:
                raise ValueError(Text('派活记录的视图或游标无效'))
            listing = list_dispatch_chains if view == "chains" else list_dispatches
            return self.respond(listing(connection, after, params.get("room")))
        if parts[1:2] in (["machines"], ["remote-launches"]):
            return self.handle_remote_launch_api(connection, parts, method)
        if parts == ["api", "revisions"] and method == "GET":
            return self.respond(room_revisions(connection, params))
        if parts == ["api", "sites"] and method == "GET":
            return self.respond(list_all_sites(connection))
        if parts[1:3] == ["rooms", "cloud-attachments"]:
            if parts[4:5] == ["shares"]:
                return cloud_shares.manage(self, connection, parts[3:], method, require_owner)
            return cloud_drive.handle(self, connection, parts[3:], method)
        if parts == ["api", "rooms"]:
            if method == "GET":
                limit = attachment_limit_mib(self.server.database)
                return self.respond({**list_rooms(connection, params), "participants": PARTICIPANTS, "attachment_limit_mib": limit, "last_room": last_room(connection),
                                     # Balances and plan use are the owner's: only the manager's page lists them.
                                     "quotas": account_quotas(connection) if self.bridged or self.admin_session(connection) else {},
                                     "destructions": list_destructions(connection),
                                     **object_storage_limits(connection, self.server.database, limit)})
            payload = self.read_payload()
            token = self.headers.get("X-Discussion-Token", "")
            if payload.get("system_kind") == "steward" or payload.get("preset") == "task":
                self.require_steward_creator(connection, token)
            room = create_room(connection, payload, token)
            connection.commit()
            return self.respond(room, 200 if room["duplicate"] else 201)
        if parts == ["api", "rooms", "last"] and method == "POST":
            # Only the manager (this computer's page, a relayed device or a signed-in administrator) moves it.
            if not (self.bridged or self.admin_session(connection)):
                raise PermissionError(Text('需要管理员身份'))
            result = remember_last_room(connection, self.read_payload())
            connection.commit()
            return self.respond(result)
        if parts == ["api", "rooms", "import"] and method == "POST":
            result = import_room(connection, self.read_payload(MAX_IMPORT_BYTES), self.headers.get("X-Discussion-Token", ""))
            connection.commit()
            return self.respond(result, 200 if result.get("skipped") else 201)
        if parts == ["api", "folders"] and method == "POST":
            payload = self.read_payload()
            name = folder_name_value(payload)
            directories = folder_directories_value(payload)
            folder_id = uuid.uuid4().hex
            position = connection.execute("SELECT COALESCE(MAX(position),0)+1 FROM topic_folders").fetchone()[0]
            connection.execute("INSERT INTO topic_folders (id,name,position,directories) VALUES (?,?,?,?)",
                               (folder_id, name, position, json.dumps(directories, ensure_ascii=False)))
            connection.commit()
            return self.respond({"id": folder_id, "name": name, "position": position, "directories": directories}, 201)
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
            raise LookupError(Text('地址不存在'))
        room_id = parts[2]
        if parts[3:] == ["progress"] and method == "GET":
            return self.respond(room_progress(connection, room_id))
        if parts[3:] == ["destruction"]:
            # The room is gone: its runner reports under the old owner credential; the manager may retry the rest.
            if method == "GET":
                view = destruction_view(connection, room_id)
                if view is None:
                    raise LookupError(Text('房间不存在'))
                # The room's runner, under the old owner credential, also gets the sessions its members ran in.
                return self.respond({**view, **destruction_sessions(connection, room_id, self.headers.get("X-Discussion-Token", ""))})
            payload = self.read_payload()
            if payload.get("action") == "retry":
                if not (self.bridged or self.admin_session(connection)):
                    raise PermissionError(Text('需要管理员身份'))
                finish_destruction_files(self.server.database, room_id)
                return self.respond(destruction_view(connection, room_id) or {})
            result = report_destruction(connection, room_id, self.headers.get("X-Discussion-Token", ""), payload)
            connection.commit()
            return self.respond(result)
        self.refuse_read_only(parts, method)
        if parts[3:] == ["steward-work"] and method == "GET":
            return self.read_steward_work(connection, room_id)
        if parts[3:] == ["steward-member"] and method == "POST":
            payload = self.read_payload()
            if self.headers.get(ACTING_MEMBER_HEADER):
                raise PermissionError(Text('需要本房间的控制凭据'))
            if self.bridged or self.local_visitor():
                self.admin_as_owner(connection, room_id)
            token = self.headers.get("X-Discussion-Token", "")
            result = replace_steward_member(connection, room_id, token, payload, utc_now())
            drain_room_queue(connection, room_id)
            connection.commit()
            return self.respond(result)
        self.admin_as_owner(connection, room_id)
        token = self.headers.get("X-Discussion-Token", "")
        if method == "POST":
            self.check_steward_write(connection, room_id, parts[3:], token)
        if self.headers.get("X-Discussion-Session"):
            record_reported_session(connection, room_id, token, {"session_id": self.headers.get("X-Discussion-Session"),
                                                                 "session_client": self.headers.get("X-Discussion-Session-Client")})
            connection.commit()
        if parts[3:] == ["room-links"] and method == "GET":
            require_owner_or_host(connection, room_id, token)
            limit = int(params.get("limit", 0))
            if not 0 <= limit <= 100:
                raise ValueError(Text("relay.limit 须为 0–100 的整数，0 表示不限"))
            return self.respond(list_links(connection, room_id, limit))
        if parts[3:] == ["host-room-post"] and method == "POST":
            begin_write(connection)
            require_owner(connection, room_id, token)
            host = require_member(connection, room_id, self.headers.get(ACTING_MEMBER_HEADER))
            if host["role"] != "host":
                raise PermissionError(Text("只有房主或当前主持人可以读取"))
            if guest_mode_active(connection, room_id):
                raise guest_error()
            body = self.read_payload()
            target = body.get("target_room_id")
            relay = {key: body[key] for key in ("limit", "expect", "reply_to") if key in body}
            relay.update(room_id=room_id, member=host["name"], host=member_display_names(connection, room_id)[host["name"]])
            payload = dict(author="用户", text=body.get("text"), submission_id=body.get("submission_id"),
                           interrupt=body.get("interrupt", False), relay=relay)
            result = post_host_relay(connection, host, target, payload, body.get("execution_id"))
            drain_room_queue(connection, target)
            moss_results.reconcile_delegations(connection, room_id)
            connection.commit()
            self.server.hub.notify_update(target)
            if result.get("answer_id"):
                self.server.hub.notify_update(room_id)
            receipt = {key: result[key] for key in ("queued", "interrupted", "reason", "answer_id") if key in result}
            if result.get("message"):
                receipt["message"] = {"id": result["message"]["id"]}
            return self.respond(receipt)
        if parts[3:4] == ["external-members"]:
            result, status = external_owner_api(connection, room_id, parts[4:], params, method, token, self.read_payload)
            # Revoking (or finding expired) the member that held the room frees it: messages queued behind it go now.
            if method == "POST":
                drain_room_queue(connection, room_id)
            connection.commit()
            return self.respond(result, status)
        if parts[3:4] == ["guest"]:
            return self.handle_guest_owner(connection, parts, method, token)
        if parts[3:] == ["discussion"]:
            if method == "GET":
                return self.respond(session_room(connection, room_id))
            if method == "POST":
                result = discussion_action(connection, room_id, token, self.read_payload(), require_room(connection, room_id))
                drain_room_queue(connection, room_id)
                connection.commit()
                return self.respond(result)
            raise LookupError(Text('地址不存在'))
        if parts[3:] == ["mode"]:
            if method == "GET":
                return self.respond(mode_view(connection, room_id))
            if method == "POST":
                result = finish_mode(connection, room_id, token, self.read_payload())
                connection.commit()
                return self.respond(result)
            raise LookupError(Text('地址不存在'))
        if parts[3:] == ["goal"]:
            if method == "GET":
                return self.respond(goal_view(connection, room_id))
            if method == "POST":
                result = goal_action(connection, room_id, token, self.read_payload())
                connection.commit()
                return self.respond(result)
            raise LookupError(Text('地址不存在'))
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
        if parts[3:] == ["timeline", "segments"] and method == "GET":
            return self.respond(execution_segments(connection, room_id, str(params.get("ids", "")).split(",")))
        if parts[3:] == ["timeline"] and method == "GET":
            timeline = execution_timeline(connection, room_id, int(params.get("after", 0)), int(params.get("before", 0)), params.get("segments") != "0")
            boundary = session_read_boundary(connection, room_id, token)
            if boundary is not None:
                for execution in timeline["executions"]:
                    hidden_task = isinstance(execution.get("task_id"), int) and execution["task_id"] > boundary
                    if hidden_task:
                        execution["task"] = ""
                        execution["task_id"] = None
                        execution["reason"] = ""
                        execution["task_author"] = None
                    execution["last_note"] = ""
                    execution["notes"] = []
                    hidden_answer = isinstance(execution.get("answer_id"), int) and execution["answer_id"] > boundary
                    if hidden_answer:
                        execution["answer_id"] = None
                        execution["result"] = ""
            return self.respond(timeline)
        if parts[3:4] == ["questions"]:
            return self.handle_questions(connection, parts, params, method, token)
        if parts[3:] == ["events"] and method == "GET":
            log = room_event_log(connection, room_id, token, params.get("after", 0), params.get("before", 0))
            if self.read_only_request():
                log["events"] = [host_event(event) for event in log["events"] if not host_hidden_event(event)]
            return self.respond(log)
        if parts[3:] == ["trace"] and method == "GET":
            return self.respond(trace_message(connection, room_id, params, token))
        if parts[3:] == ["register"] and method == "POST":
            result = register_member(connection, room_id, token, utc_now())
            connection.commit()
            return self.respond(result)
        if parts[3:] == ["speaking-order"]:
            if method == "GET":
                return self.respond(require_room(connection, room_id)["speaking_order"])
            payload = self.read_payload()
            begin_write(connection)
            if isinstance(payload.get("order"), list):
                handles = member_handles(connection, room_id)
                payload["order"] = [handles.get(item.strip(), item) if isinstance(item, str) else item for item in payload["order"]]
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
            payload = self.read_payload()
            if payload.get("action") in ("request_send", "request_cancel"):
                result = queue_request_action(connection, room_id, token, payload)
                connection.commit()
                return self.respond(result)
            result = queue_action(connection, room_id, token, payload, post_queued, check_queued, interrupt_for_message)
            connection.commit()
            return self.respond(result)
        if parts[3:] == ["executions", "changes"] and method == "GET":
            return self.respond(execution_changes_batch(connection, room_id, params.get("ids", ""), token))
        if parts[3:4] in (["inbox"], ["executions"], ["members"], ["chats"], ["suggestions"], ["recommendations"], ["stop"], ["dispatches"], ["host-checkin"], ["quotas"], ["room-link"], ["room-relay-sent"], ["host-actions"]):
            return self.handle_free_api(connection, parts, method)
        if parts[3:4] == ["attachments"]:
            return self.handle_attachments(connection, parts, params, method)
        if parts[3:4] == ["cloud-files"]:
            return self.handle_room_cloud_files(connection, room_id, parts[4:], method)
        if parts[3:4] in (["scheduler-decisions"], ["scheduler-routing"], ["dispatch-feedback"]):
            return self.handle_scheduler_api(connection, parts, method)
        if parts[3:] in (["share-link"], ["share-card"]) and method in ("GET", "POST"):
            # The manage token can renew, revoke or replace a public page: owner only. A request carrying a credential must
            # carry the owner's, so a member AI using its own command line cannot read or rewrite it even on a local site.
            if token:
                require_owner(connection, room_id, token)
            else:
                self.require_entry_owner(connection, room_id, token)
            if parts[3] == "share-card":
                if method == "GET":
                    return self.respond(read_share_card(connection, room_id))
                result = edit_share_card(connection, room_id, self.read_payload())
                connection.commit()
                return self.respond(result)
            if method == "GET":
                return self.respond(share_link_record(connection, room_id))
            result = save_share_link(connection, room_id, self.read_payload())
            connection.commit()
            return self.respond(result)
        if parts[3:] == ["sites"] and method in ("GET", "POST"):
            if method == "GET":
                return self.respond(list_room_sites(connection, room_id))
            if token:
                require_owner(connection, room_id, token)
            else:
                self.require_entry_owner(connection, room_id, token)
            result = save_room_site(connection, room_id, self.read_payload())
            connection.commit()
            return self.respond(result)
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
        if (parts[3:] == ["backup"] and method == "GET") or (len(parts) == 4 and parts[3] in DIRECTORY_OPERATIONS and method == "POST"):
            self.require_entry_owner(connection, room_id, token)
        if parts[3:] == ["backup"] and method == "GET":
            if session_read_boundary(connection, room_id, token) is not None:
                raise PermissionError(Text('独立观点阶段需房主凭据导出'))
            return self.respond(room_backup(connection, room_id))
        if len(parts) == 4 and parts[3] in ("move", "folder", "detach", "pin", "rename", "archive", "restore", "delete", "auto-destroy") and method == "POST":
            result = manage_room(connection, room_id, parts[3], self.read_payload())
            if parts[3] in ("archive", "delete"):
                moss_results.reconcile_delegations(connection, room_id)
            connection.commit()
            if parts[3] == "delete":
                finish_destruction_files(self.server.database, room_id)
                result["destruction"] = destruction_view(connection, room_id)
            return self.respond(result)
        if len(parts) == 3 and method == "GET":
            return self.respond(room_read_view(connection, require_room(connection, room_id), token))
        if parts[3:] == ["conclusion"] and method == "GET":
            require_room(connection, room_id)
            conclusion = session_conclusion_view(connection, room_id)
            if conclusion is None:
                raise FileExistsError(Text('房间没有进行中的讨论会话'))
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
                raise FileExistsError(Text('房间没有进行中的讨论会话'))
            if payload.get("action") == "check":
                actor = payload.get("actor", "用户")
                if actor == "用户":
                    require_owner(connection, room_id, token)
                elif require_member(connection, room_id, token, actor)["role"] != "host":
                    raise PermissionError(Text('只有房主或当前 AI 主持人可以检查讨论上限'))
                enforce_session_limits(connection, room_id)
                result = require_room(connection, room_id)
            elif payload.get("action") == "done":
                actor = payload.get("actor")
                if not actor or require_member(connection, room_id, token, actor)["role"] != "host":
                    raise PermissionError(Text('主持人收束讨论须使用当前 AI 主持人的成员凭据'))
                conclude_session_by_host(connection, room_id, payload)
                result = require_room(connection, room_id)
            elif payload.get("action") == "reopen":
                raise ValueError(Text('新讨论会话请通过 discussion 接口重新开启'))
            else:
                result = update_session_limits(connection, room_id, token, payload)
            connection.commit()
            return self.respond(result)
        if parts[3:] == ["messages"]:
            if method == "GET":
                return self.respond(query_messages(connection, room_id, params, token))
            payload = self.read_payload()
            result = append_message(connection, room_id, payload, free_actor)
            receipt = message_receipt(connection, room_id, result)
            if receipt:
                result["receipt"] = receipt
            drain_room_queue(connection, room_id)
            connection.commit()
            return self.respond(result, 200 if result["duplicate"] else 201)
        if len(parts) == 5 and parts[3] == "messages" and method == "GET":
            message = get_message(connection, room_id, int(parts[4]), params, token)
            if not message.get("author_label"):
                message["author_label"] = member_display_names(connection, room_id).get(message["author"], message["author"])
            return self.respond(read_message_part(message, params))
        if parts[3:] == ["state"] and method == "POST":
            payload = self.read_payload()
            actor = payload.get("actor", "用户")
            if actor == "用户":
                require_owner(connection, room_id, token)
            elif require_member(connection, room_id, token, actor)["role"] != "host":
                raise PermissionError(Text('只有房主或当前 AI 主持人可以更新状态'))
            result = update_state(connection, room_id, payload)
            connection.commit()
            return self.respond(result)
        raise LookupError(Text('地址不存在'))

    def require_cloud_account(self, connection):
        """Use the same administrator check for account inventory and cross-room landing."""
        if (self.bridge_origin or self.read_only_request() or self.headers.get("X-Discussion-Token") is not None
                or self.headers.get(ACTING_MEMBER_HEADER) or not self.admin_session(connection)):
            raise PermissionError(Text('需要管理员登录'))

    def clear_cloud_file(self, connection, row):
        """Preserve the record and its quota if deleting its bytes fails."""
        if row["cleared_at"]:
            return []
        database = self.server.database
        delete_remote_attachment(database, row, configured_storage(database), raise_failure=True)
        with connection:
            updated = connection.execute("UPDATE cloud_files SET cleared_at=? WHERE id=? AND cleared_at IS NULL",
                                         (utc_now(), row["id"]))
            return [row] if updated.rowcount else []

    def authorize_cloud_write(self, connection, room_id):
        """Require this room's owner or a credential-free request from the account administrator."""
        token = self.headers.get("X-Discussion-Token", "")
        if self.headers.get(ACTING_MEMBER_HEADER):
            raise PermissionError(Text('需要本房间的控制凭据'))
        if self.has_explicit_room_token or not (self.bridged or self.admin_session(connection)):
            require_owner(connection, room_id, token)
        elif not connection.execute("SELECT 1 FROM rooms WHERE id=?", (room_id,)).fetchone():
            raise LookupError(Text('房间不存在'))

    def handle_room_cloud_files(self, connection, room_id, route, method):
        """Reserve or complete a project upload, or sign a room-scoped download."""
        database = self.server.database
        if method == "GET" and len(route) == 2 and route[1] == "content":
            row = get_cloud_file(connection, route[0], room_id)
            if row["purpose"] != "keep":
                self.authorize_cloud_write(connection, room_id)
                return self.respond_cloud_link(stored_object_download(database, row))
            token = self.headers.get("X-Discussion-Token", "")
            view = cloud_file_view(connection, row)
            cutoff = attachment_cutoff(connection, room_id, self.request_params, token, content=True)
            if cutoff is not None and view["message_id"] is not None and view["message_id"] > cutoff:
                raise BoundaryError(Text('该附件所在的消息超出本请求读取上界 #{until}', until=cutoff),
                                    code="reading_boundary", read_scope={"request_read_until": cutoff, "boundary_applied": True})
            return self.respond_cloud_link(stored_object_download(database, row))
        if method != "POST" or (route and (len(route) != 2 or route[1] not in {"complete", "release"})):
            raise LookupError(Text('地址不存在'))
        self.authorize_cloud_write(connection, room_id)
        if route:
            self.read_payload()
            row = get_cloud_file(connection, route[0], room_id)
            if route[1] == "release":
                if row["purpose"] == "keep":
                    raise LookupError(Text("附件不存在"))
                self.clear_cloud_file(connection, row)
                return self.respond({"released": True})
            return self.complete_cloud_file_upload(connection, row)
        return self.start_cloud_file_upload(connection, room_id, cloud_file_metadata(self.read_payload()))

    def complete_cloud_file_upload(self, connection, row):
        """Confirm remote bytes before making a cloud file available."""
        try:
            row = finish_cloud_file(connection, configured_storage(self.server.database), row)
        except StorageUnavailable as error:
            raise storage_http_error(error) from None
        return self.respond({"cloud_file": cloud_file_view(connection, row)})

    def start_cloud_file_upload(self, connection, room_id, metadata):
        """Reserve a file and return its signed upload form to the caller."""
        database = self.server.database
        client = configured_storage(database)
        if not client:
            raise FileExistsError(Text("对象存储未配置"))
        row = reserve_cloud_file(connection, database, room_id, metadata)
        connection.commit()
        try:
            upload = None if row["stored_at"] else client.upload(row["object_name"], row["size"], row["content_type"])
        except StorageUnavailable as error:
            raise storage_http_error(error) from None
        return self.respond({"cloud_file": cloud_file_view(connection, row), "upload": upload})

    def copy_attachment_to_cloud(self, connection, room_id, identifier):
        """Save the original room attachment to a separate cloud record."""
        self.authorize_cloud_write(connection, room_id)
        self.read_payload()
        copy_id = f"cloud-copy-{identifier}"
        existing = connection.execute("""SELECT * FROM cloud_files
            WHERE room_id=? AND submission_id=? AND cleared_at IS NULL""", (room_id, copy_id)).fetchone()
        if existing is not None:
            state = self.server.cloud_copies.status(connection, existing["id"])
            if state["status"] != "failed":
                return self.respond(state, 202 if state["status"] == "running" else 200)
        attachment = get_attachment(connection, room_id, identifier)
        if attachment["storage"] == "object":
            raise ValueError(Text("附件已在云空间"))
        if attachment["cleared_at"]:
            raise LookupError(Text('附件已被清理'))
        database = self.server.database
        client = configured_storage(database)
        if not client:
            raise FileExistsError(Text("对象存储未配置"))
        path = attachment_path(database, attachment)
        if path != path.resolve() or not path.is_file():
            raise LookupError(Text('附件原文件缺失'))
        metadata = object_upload_metadata({**attachment, "submission_id": copy_id}, "用户")
        metadata.update(source_kind="attachment", source_ref=identifier)
        row = reserve_cloud_file(connection, database, room_id, metadata)
        connection.commit()
        state = self.server.cloud_copies.start(connection, row["id"])
        return self.respond(state, 202 if state["status"] == "running" else 200)

    def read_cloud_copy_job(self, connection, room_id, source_id, task_id=None):
        """Read the task bound to this room and source, optionally pinned to a task ID."""
        self.authorize_cloud_write(connection, room_id)
        if task_id is None:
            record = connection.execute("""SELECT * FROM cloud_files
                WHERE room_id=? AND submission_id=? AND cleared_at IS NULL""", (room_id, f"cloud-copy-{source_id}")).fetchone()
        else:
            record = get_cloud_file(connection, task_id, room_id)
        if not record or record["source_kind"] != "attachment" or record["source_ref"] != source_id:
            raise LookupError(Text("附件不存在"))
        return self.respond(self.server.cloud_copies.status(connection, record["id"]))

    def handle_attachments(self, connection, parts, params, method):
        """Handle bounded upload, discovery, metadata, and binary download."""
        room_id = parts[2]
        if parts[4:] == ["usage"] and method == "GET":
            return self.respond(attachment_usage(connection, room_id, self.headers.get("X-Discussion-Token", "")))
        if parts[4:] == ["clear"] and method == "POST":
            result = clear_attachments(connection, self.server.database, room_id, self.read_payload(),
                                       self.headers.get("X-Discussion-Token", ""))
            self.server.hub.notify_update(room_id)
            return self.respond(result)
        if len(parts) == 4:
            if method == "GET":
                return self.respond(query_attachments(connection, room_id, params, self.headers.get("X-Discussion-Token", "")))
            metadata = attachment_metadata(params)
            token = self.headers.get("X-Discussion-Token", "")
            actor = authorize_free_write(connection, room_id, token, "attachments", {"author": metadata["actor"]})
            if (actor == "用户") != (metadata["actor"] == "用户"):
                raise PermissionError(Text('附件上传者须与凭据身份一致'))
            require_room(connection, room_id)
            length = int(self.headers.get("Content-Length", "-1"))
            limit = attachment_limit_mib(self.server.database)
            if not 0 <= length <= limit * 1024 * 1024:
                return self.respond({"error": Text('单个附件最多 {limit} MiB，须提供 Content-Length', limit=limit)}, 413)
            data = self.rfile.read(length)
            if len(data) != length:
                raise ValueError(Text('附件内容不完整'))
            result = store_attachment(connection, self.server.database, room_id, metadata, data)
            return self.respond(result, 200 if result["duplicate"] else 201)
        if method == "POST" and parts[4:] == ["object"]:
            return self.start_object_upload(connection, room_id)
        if method == "POST" and len(parts) == 6 and parts[5] == "cloud-copy":
            return self.copy_attachment_to_cloud(connection, room_id, parts[4])
        if method == "GET" and len(parts) in (6, 7) and parts[5] == "cloud-copy":
            return self.read_cloud_copy_job(connection, room_id, parts[4], parts[6] if len(parts) == 7 else None)
        if method == "POST" and len(parts) == 6 and parts[5] == "complete":
            return self.complete_object_upload(connection, room_id, parts[4])
        if method == "POST" and len(parts) == 6 and parts[5] == "discard":
            return self.respond(discard_attachment(connection, self.server.database, room_id, parts[4], self.headers.get("X-Discussion-Token", "")))
        if method == "POST" and len(parts) == 6 and parts[5] == "import":
            return self.import_attachment(connection, room_id, parts[4])
        if method == "POST" and len(parts) == 6 and parts[5] == "thumbnail":
            length = int(self.headers.get("Content-Length", "-1"))
            if not 0 < length <= MAX_THUMBNAIL_BYTES:
                return self.respond({"error": Text('缩略图不符合要求')}, 413)
            data = self.rfile.read(length)
            if len(data) != length:
                raise ValueError(Text('附件内容不完整'))
            return self.respond(store_attachment_thumbnail(connection, self.server.database, room_id, parts[4],
                                                         self.headers.get("X-Discussion-Token", ""), data))
        if method == "GET" and len(parts) in (5, 6):
            return self.read_room_attachment(connection, parts, params)
        raise LookupError(Text('地址不存在'))

    def read_room_attachment(self, connection, parts, params):
        """Return attachment metadata, local bytes or an authorized object-storage link."""
        room_id = parts[2]
        attachment = get_attachment(connection, room_id, parts[4], params, self.headers.get("X-Discussion-Token", ""),
                                    content=len(parts) == 6)
        if len(parts) == 5:
            return self.respond(attachment)
        if parts[5] == "content" and attachment.get("storage") == "object":
            return self.respond_cloud_link(object_download_result(connection, self.server.database, attachment))
        if parts[5] in ("content", "zip") and attachment.get("cleared_at"):
            raise LookupError(Text('附件已被清理'))
        if parts[5] == "content":
            return self.respond_attachment(attachment, params.get("download") == "1")
        if parts[5] == "thumbnail":
            path = thumbnail_path(self.server.database, attachment)
            if not attachment.get("thumbnail_type") or not path.is_file():
                raise LookupError(Text('附件不存在'))
            return self.send_file(path, attachment["thumbnail_type"], attachment["file_name"], "inline")
        if parts[5] == "zip":
            path = attachment_path(self.server.database, attachment)
            if not path.is_file():
                raise LookupError(Text('附件不存在'))
            entries = parse_qs(urlsplit(self.path).query, keep_blank_values=True).get("entry")
            if entries is None:
                return self.respond(zip_preview(path))
            entry = entries[-1]
            data = (zip_entry_bytes(path, attachment["sha256"], entry) if self.headers.get("Range")
                    else zip_preview(path, entry))
            return self.send_file(None, "application/octet-stream", entry.split("/")[-1], "attachment", data=data)
        raise LookupError(Text('地址不存在'))

    def respond_cloud_link(self, result):
        """Send a short-lived download link as JSON or redirect a regular browser download."""
        if self.request_params.get("link") == "1":
            return self.respond(result)
        self.send_response(302)
        self.send_header("Location", result["url"])
        self.send_header("Content-Length", "0")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Referrer-Policy", "no-referrer")
        self.end_headers()
        return None

    def start_object_upload(self, connection, room_id):
        """Authorize and reserve an upload before returning a COS credential."""
        payload = self.read_payload()
        token = self.headers.get("X-Discussion-Token", "")
        actor = payload.get("actor", self.request_params.get("actor"))
        if actor is None:
            try:
                require_owner(connection, room_id, token)
                actor = "用户"
            except PermissionError:
                actor = require_member(connection, room_id, token)["name"]
        metadata = object_upload_metadata(payload, actor)
        authorized = authorize_free_write(connection, room_id, token, "attachments", {"author": actor})
        if (authorized if isinstance(authorized, str) else authorized["name"]) != actor:
            raise PermissionError(Text("附件上传者须与凭据身份一致"))
        require_room(connection, room_id)
        client = configured_storage(self.server.database)
        if not client:
            raise FileExistsError(Text("对象存储未配置"))
        record = reserve_object_attachment(connection, self.server.database, room_id, metadata)
        connection.commit()
        try:
            upload = None if record["stored_at"] else client.upload(record["object_name"], record["size"], record["content_type"])
        except StorageUnavailable as error:
            raise storage_http_error(error) from None
        return self.respond({"attachment": attachment_view(connection, record), "upload": upload})

    def complete_object_upload(self, connection, room_id, identifier):
        """Verify size with the resource center and mark exactly the reserved row as stored."""
        token = self.headers.get("X-Discussion-Token", "")
        record = get_object_attachment(connection, room_id, identifier)
        actor = authorize_free_write(connection, room_id, token, "attachments", {"author": record["actor"]})
        if (actor if isinstance(actor, str) else actor["name"]) != record["actor"]:
            raise PermissionError(Text("只能确认自己上传的附件"))
        if record["cleared_at"] or not record["object_name"]:
            raise AdminError(Text("文件已不在对象存储中"), 410)
        if record["stored_at"]:
            return self.respond({"attachment": attachment_view(connection, record)})
        connection.commit()
        client = configured_storage(self.server.database)
        if not client:
            raise AdminError(Text("对象存储暂不可用"), 503)
        try:
            size = client.file_size(record["object_name"])
        except ObjectMissing:
            raise FileExistsError(Text("对象存储尚未收到文件")) from None
        except StorageUnavailable as error:
            raise storage_http_error(error) from None
        if size != record["size"]:
            raise FileExistsError(Text("对象存储中的文件大小与上传声明不一致"))
        authorize_free_write(connection, room_id, token, "attachments", {"author": record["actor"]})
        connection.execute("UPDATE attachments SET stored_at=? WHERE room_id=? AND id=? AND cleared_at IS NULL AND stored_at IS NULL",
                           (utc_now(), room_id, identifier))
        result = get_object_attachment(connection, room_id, identifier)
        connection.commit()
        return self.respond({"attachment": attachment_view(connection, result)})

    def import_attachment(self, connection, room_id, attachment_id):
        """Store the original bytes of an attachment recorded by an import; an existing file is kept."""
        length = int(self.headers.get("Content-Length", "-1"))
        limit = attachment_limit_mib(self.server.database)
        if not 0 <= length <= limit * 1024 * 1024:
            return self.respond({"error": Text('单个附件最多 {limit} MiB，须提供 Content-Length', limit=limit)}, 413)
        data = self.rfile.read(length)
        attachment = imported_attachment(connection, room_id, attachment_id, self.headers.get("X-Discussion-Token", ""), data)
        path = attachment_path(self.server.database, attachment)
        if not path.is_file():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        return self.respond({"attachment": attachment_view(connection, attachment)})

    def respond_attachment(self, attachment, download):
        """Serve stored bytes with a safe disposition, never as executable HTML."""
        path = attachment_path(self.server.database, attachment)
        if not path.is_file():
            raise LookupError(Text('附件原文件缺失'))
        disposition = "attachment" if download or attachment["content_type"] == "application/octet-stream" else "inline"
        self.send_file(path, attachment["content_type"], attachment["file_name"], disposition, {"X-Content-SHA256": attachment["sha256"]})

    def send_file(self, path, content_type, file_name, disposition, extra=None, data=None, policy="default-src 'none'; sandbox"):
        """Send one stored file, or the single byte range a player asks for, never as executable content.

        `policy` is the Content-Security-Policy; none for a project page served on its own origin (PAGE_HOST).
        """
        size = path.stat().st_size if data is None else len(data)
        start, end, status = 0, size - 1, 200
        match = re.fullmatch(r"bytes=(\d*)-(\d*)", self.headers.get("Range", "").strip())
        if match and (match[1] or match[2]) and (data is None or size > 0):
            if match[1]:
                start, end = int(match[1]), min(int(match[2]), size - 1) if match[2] else size - 1
            else:
                start = max(0, size - int(match[2]))
            if start > end or start >= size:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            status = 206
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(max(0, end - start + 1)))
        self.send_header("Accept-Ranges", "bytes")
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Disposition", f"{disposition}; filename*=UTF-8''{quote(file_name, safe='')}")
        for name, value in (extra or {}).items():
            self.send_header(name, value)
        self.send_header("X-Content-Type-Options", "nosniff")
        if policy:
            self.send_header("Content-Security-Policy", policy)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Referrer-Policy", "no-referrer")
        self.end_headers()
        if data is not None:
            self.wfile.write(memoryview(data)[start:end + 1])
            return
        with path.open("rb") as source:
            source.seek(start)
            left = end - start + 1
            while left > 0:
                chunk = source.read(min(FILE_CHUNK_BYTES, left))
                if not chunk:
                    break
                self.wfile.write(chunk)
                left -= len(chunk)

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
        elif len(parts) == 5 and parts[3] == "dispatch-feedback" and method == "POST":
            result = rate_dispatch(connection, room_id, int(parts[4]), token, self.read_payload())
        else:
            raise LookupError(Text('地址不存在'))
        connection.commit()
        return self.respond(result)

    def acting_host(self, connection, room_id):
        """The present host acting through `launch host-control`, by its display name, so what it does to a member is
        labelled as the host's, not the owner's; '' otherwise (REVIEW L4).

        host-control writes with the owner's credential and adds the host's own member credential; only a credential
        of this room's present host counts, so no client can claim the label by naming itself. A label only: the
        owner's credential decides whether the write is allowed."""
        token = self.headers.get(ACTING_MEMBER_HEADER, "")
        if not token:
            return ""
        try:
            member = require_member(connection, room_id, token)
        except PermissionError:
            return ""
        return member_display_names(connection, room_id).get(member["name"], member["name"]) if member["role"] == "host" else ""

    def handle_questions(self, connection, parts, params, method, token):
        """Questions to the owner (backend/questions.py): read first, then write with the version read."""
        room_id = parts[2]
        if len(parts) == 4 and method == "GET":
            result = questions.list_questions(connection, room_id, token, params, session_message_access(connection, room_id, params, token))
            for question in result["questions"]:
                add_guest_question_origin(connection, room_id, question)
            if isinstance(result.get("last_ask"), dict):
                add_guest_question_origin(connection, room_id, result["last_ask"])
            return self.respond(result)
        if len(parts) == 5 and parts[4].isdigit() and method == "GET":
            result = questions.view_question(connection, room_id, int(parts[4]), token, session_message_access(connection, room_id, params, token))
            return self.respond(add_guest_question_origin(connection, room_id, result))
        if method != "POST":
            raise LookupError(Text('地址不存在'))
        payload = self.read_payload()
        try:
            result = self.question_write(connection, parts, room_id, token, payload)
        except questions.QuestionClosed:
            # The question was ended on the way to refusing the write: keep that, then report the refusal.
            connection.commit()
            raise
        drain_room_queue(connection, room_id)
        connection.commit()
        return self.respond(result, 200 if result.get("duplicate") else 201)

    def question_write(self, connection, parts, room_id, token, payload):
        """Route one question write; the caller commits."""
        if len(parts) == 4:
            result = questions.ask_question(connection, require_room(connection, room_id), token, payload,
                                            append_free_message, get_message)
            add_guest_question_origin(connection, room_id, result)
        elif len(parts) == 6 and parts[4].isdigit() and parts[5] == "answer":
            result = questions.answer_question(connection, room_id, int(parts[4]), token, payload)
        elif len(parts) == 6 and parts[4].isdigit() and parts[5] in ("recommend", "decide"):
            result = questions.host_reply(connection, require_room(connection, room_id), token, int(parts[4]), payload,
                                          append_free_message, parts[5] == "decide")
        elif len(parts) == 6 and parts[4].isdigit() and parts[5] == "cancel":
            result = questions.cancel_question(connection, room_id, int(parts[4]), token, payload)
        else:
            raise LookupError(Text('地址不存在'))
        return result

    def handle_guest_owner(self, connection, parts, method, token):
        """Serve owner controls and authenticated loopback runner actions."""
        route = parts[4:]
        local_host = self.headers.get("Host") in (f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}")
        service = (self.has_explicit_room_token and self.server.local_site and self.client_address[0] == "127.0.0.1" and local_host
                   and not self.bridged and self.headers.get("Origin") is None
                   and self.headers.get("Sec-Fetch-Site") is None and self.headers.get(ACTING_MEMBER_HEADER) is None)
        payload = self.read_payload() if method == "POST" else None
        if service and len(route) == 1 and route[0] in GUEST_SERVICE_ACTIONS:
            require_owner(connection, parts[2], token)
            self.api_actor_override = "local_service"
        data = guest_owner_api(connection, parts[2], route, method, token, payload=payload, service=service,
                               acting_token=self.headers.get(ACTING_MEMBER_HEADER, ""))
        connection.commit()
        return self.respond({"ok": True, "data": data})

    def handle_guest_projection(self, connection, parts, params, method):
        """Commit a guest write before notifying room subscribers."""
        data = guest_projection(connection, parts, method, self.headers.get("X-Discussion-Token", ""), params, self.read_payload)
        connection.commit()
        if method == "POST":
            self.server.hub.notify_update(parts[3])
        return self.respond({"ok": True, "data": data})

    def handle_external_api(self, connection, parts, params, method):
        """Member-scope routes for an external member (backend/external_members.py); its only way into the room."""
        room_id, route = parts[3], parts[4:]
        token = self.headers.get("X-Discussion-Token", "")
        if route == ["attachments", "object"] and method == "POST":
            require_external(connection, room_id, token)
            raise PermissionError(Text("外部成员不能上传对象存储附件"))

        def answer(connection, room_id, payload, member):
            result = append_message(connection, room_id, payload, member)
            receipt = message_receipt(connection, room_id, result)
            return {**result, "receipt": receipt} if receipt else result
        hooks = {"messages": query_messages, "message": get_message, "answer": answer}
        result, status = external_api(connection, parts, params, method, self.headers.get("X-Discussion-Token", ""),
                                      self.read_payload, hooks)
        drain_room_queue(connection, parts[3])
        connection.commit()
        return self.respond(result, status)

    def read_steward_work(self, connection, room_id):
        """Show the steward's cross-room work only to its owner or a trusted local entry."""
        if self.read_only_request() or self.headers.get(ACTING_MEMBER_HEADER):
            raise PermissionError(Text('需要本房间的控制凭据'))
        if self.bridged or self.local_visitor():
            self.admin_as_owner(connection, room_id)
        require_owner(connection, room_id, self.headers.get("X-Discussion-Token", ""))
        if not connection.execute("SELECT 1 FROM room_directory WHERE room_id=? AND system_kind='steward'", (room_id,)).fetchone():
            raise LookupError(Text('房间不存在'))
        return self.respond(moss_results.steward_work(connection, room_id))

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
        elif len(parts) == 6 and parts[3] == "executions" and parts[5] == "changes" and method == "GET":
            result = execution_changes(connection, room_id, int(parts[4]), token)
        elif len(parts) == 6 and parts[3] == "executions" and parts[5] == "diff" and method == "GET":
            result = execution_diffs(connection, room_id, int(parts[4]), token)
        elif len(parts) == 6 and parts[3] == "executions" and parts[5] == "late-answer" and method == "GET":
            result = late_answer(connection, room_id, int(parts[4]), token)
        elif len(parts) == 5 and parts[3] == "executions":
            execution_id = int(parts[4])
            result = (view_execution(connection, room_id, execution_id, token) if method == "GET"
                      else execution_action(connection, room_id, execution_id, token, {**self.read_payload(), "by_host": self.acting_host(connection, room_id)}))
        elif parts[3:] == ["members"] and method == "POST":
            result = add_member(connection, room_id, token, self.read_payload(), utc_now())
        elif len(parts) == 5 and parts[3] == "members" and method == "POST":
            result = member_action(connection, room_id, int(parts[4]), token, {**self.read_payload(), "by_host": self.acting_host(connection, room_id)})
        elif len(parts) == 6 and parts[3] == "members" and parts[5] == "interrupt" and method == "POST":
            result = interrupt_member(connection, room_id, int(parts[4]), token, self.acting_host(connection, room_id))
        elif len(parts) == 6 and parts[3] == "members" and parts[5] == "chat" and method in ("GET", "POST"):
            result = member_chat(connection, room_id, int(parts[4]), token, self.read_payload() if method == "POST" else None)
        elif len(parts) == 5 and parts[3] == "chats" and method == "POST":
            payload = self.read_payload()
            begin_write(connection)
            if payload.get("action") == "start" and guest_dispatch_held(connection, room_id):
                raise guest_error(FileExistsError, "guest_waiting")
            result = chat_action(connection, room_id, int(parts[4]), token, payload)
        elif len(parts) == 6 and parts[3] == "members" and parts[5] == "capabilities" and method == "POST":
            result = member_capability(connection, room_id, int(parts[4]), token, self.read_payload())
        elif parts[3:] == ["quotas"] and method == "POST":
            result = report_quota(connection, room_id, token, self.read_payload())
        elif parts[3:] == ["stop"] and method == "POST":
            result = stop_room(connection, room_id, token)
        elif len(parts) == 6 and parts[3] == "dispatches" and parts[4].isdigit() and parts[5] == "withdraw" and method == "POST":
            result = withdraw_dispatch(connection, room_id, token, int(parts[4]), self.read_payload().get("execution_id"))
        elif parts[3:] == ["host-checkin"] and method == "POST":
            result = set_host_checkin(connection, room_id, token, self.read_payload())
        elif parts[3:] == ["room-relay-sent"] and method == "POST":
            result = record_relay_send(connection, room_id, token, self.read_payload())
        elif parts[3:] == ["room-link"] and method == "POST":
            result = record_room_link(connection, room_id, token, self.read_payload())
        elif parts[3:] == ["host-actions"] and method == "POST":
            result = record_host_action(connection, room_id, token, self.acting_host(connection, room_id), self.read_payload())
        else:
            raise LookupError(Text('地址不存在'))
        if not self.read_only_request():
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
                raise PermissionError(Text('只有房主或当前 AI 主持人可以修改话题资料'))
            result = update_topic(connection, room_id, payload)
            connection.commit()
            return self.respond(result)
        raise LookupError(Text('地址不存在'))

    def handle_session_turn_api(self, connection, room_id, parts, params, method):
        """Read and write the plans of the room's discussion through the turns URL family."""
        if method == "POST" and not current_session(connection, room_id):
            raise ValueError(Text('房间没有讨论会话；请先开启讨论'))
        if parts[3:] == ["turns"]:
            if method == "GET":
                require_room(connection, room_id)
                return self.respond(query_session_requests(connection, room_id, params))
            payload = self.read_payload()
            host = require_member(connection, room_id, self.headers.get("X-Discussion-Token", ""), payload.get("actor"))
            if host["role"] != "host":
                raise PermissionError(Text('只有当前 AI 主持人可以安排讨论发言'))
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
                raise PermissionError(Text('只有当前 AI 主持人可以转交讨论追问'))
            result = ask_interjection(connection, room_id, resolve_member_fields(connection, room_id, payload), require_room(connection, room_id))
            connection.commit()
            return self.respond(result, 200 if result["duplicate"] else 201)
        if parts[3:] == ["turns", "continue"] and method == "POST":
            payload = self.read_payload()
            host = require_member(connection, room_id, self.headers.get("X-Discussion-Token", ""), payload.get("actor"))
            if host["role"] != "host":
                raise PermissionError(Text('只有当前 AI 主持人可以继续讨论安排'))
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
                    raise PermissionError(Text('只有房主或 AI 主持人可以取消安排'))
            if payload.get("status") != "cancelled":
                raise ValueError(Text('新讨论安排只支持专用取消操作'))
            result = cancel_plan(connection, room_id, parts[4], payload)
            connection.commit()
            return self.respond(result)
        raise LookupError(Text('地址不存在'))

    def handle_text(self, connection, parts, params):
        """Expose read-only history and search without JavaScript or MCP."""
        if len(parts) < 2:
            raise LookupError(Text('请指定房间'))
        room_id = parts[1]
        language = reading_language(self.headers.get("Accept-Language", ""))
        token = self.headers.get("X-Discussion-Token", "")
        if len(parts) == 2:
            body = room_text(connection, room_id, params, language)
        elif parts[2:] in (["brief"], ["state"], ["protocol"]):
            room = room_read_view(connection, require_room(connection, room_id), self.headers.get("X-Discussion-Token", ""))
            body = brief_text(room, language) if parts[2] == "brief" else protocol_text(room, language, attachment_limit_mib(self.server.database))
            if parts[2] == "state":
                body = state_reading_text(room, language)
        elif parts[2:] == ["turns"]:
            result = query_session_requests(connection, room_id, params)
            room = require_room(connection, room_id)
            paging = read_text(Text("第 {page} / {pages} 页，共 {total} 项。", page=result["page"], pages=result["pages"], total=result["total"]), language)
            body = f"{paging}\n\n" + "\n\n".join(turn_text(turn, room, language) for turn in result["turns"])
        elif len(parts) == 4 and parts[2] == "turns":
            body = turn_text(get_session_request(connection, room_id, parts[3]), require_room(connection, room_id), language)
        elif parts[2:] in (["messages"], ["search"]):
            result = query_messages(connection, room_id, params, token)
            items = [message_text(message, language) for message in result["messages"]]
            next_page = read_text(Text("第 {page} / {pages} 页，共 {total} 条。翻页：保留查询条件，修改 page 参数。",
                                       page=result["page"], pages=result["pages"], total=result["total"]), language)
            no_messages = read_text(Text("没有匹配的消息。"), language)
            body = next_page + "\n\n" + "\n\n---\n\n".join(items or [no_messages])
        elif len(parts) == 4 and parts[2] == "messages":
            body = message_text(get_message(connection, room_id, int(parts[3]), params, token), language)
        elif parts[2:] == ["publish"]:
            return self.respond(read_text(Text("URL 发布入口已停用；本地 CLI AI 请使用 POST 留言接口。"), language), 410, "text/plain")
        else:
            raise LookupError(Text('地址不存在'))
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
    parser.add_argument("--backfill-thumbnails", metavar="ROOM", help="Generate missing PNG previews / 补齐房间 PNG 预览图")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    if args.backfill_thumbnails:
        backfill_thumbnails(args.database, args.backfill_thumbnails)
        return
    init_database(args.database, seed=not args.no_demo)
    retry_destruction(args.database)
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
    threading.Thread(target=watch_expired_rooms, args=(server,), daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logging.info("Server stopped")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()

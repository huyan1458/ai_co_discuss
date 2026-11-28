"""Validate the room, request, and workspace behind a MOSS group delegation."""

import hashlib
import json
from pathlib import Path

from .free_room import require_member
from .runtime import require_owner
from .texts import Text


WINDOW_TOKEN_HEADER = "X-Discussion-Window-Token"


def delegation_directory(home, window, submission, requested):
    """Rebuild the per-room sandbox using the runner account's own workspace setting."""
    if home is None:
        raise PermissionError(Text("该站点没有可校验的群委托工作区"))
    settings_file = home / "local-settings.json"
    settings = json.loads(settings_file.read_text(encoding="utf-8-sig")) if settings_file.exists() else {}
    configured = settings.get("workspace")
    workspace = Path(configured) if isinstance(configured, str) and Path(configured).is_absolute() else Path(f"{home.resolve()}-workspace")
    window_key = hashlib.sha256(f"{window['channel']}:{window['chat_id']}".encode()).hexdigest()
    root = workspace.resolve() / "steward-windows" / window_key / "work" / submission
    if requested is not None and (not isinstance(requested, str) or not Path(requested).is_absolute()):
        raise ValueError(Text("群委托工作目录须在本任务的专用目录内"))
    path = Path(requested) if requested is not None else root
    try:
        resolved = path.resolve()
        if root.resolve() == root and resolved.is_relative_to(root):
            return str(resolved)
    except (OSError, RuntimeError, ValueError):
        pass
    raise PermissionError(Text("群委托工作目录须在本任务的专用目录内"))


def delegation_source(connection, payload, owner, acting):
    """Bind the child to a group host and a real external message in its execution."""
    room_id, execution = payload.get("source_window_id"), payload.get("execution_id")
    message = payload.get("source_message_id")
    if not isinstance(room_id, str) or type(execution) is not int or not 0 < execution <= 2**63 - 1:
        raise ValueError(Text("群委托须指定来源窗口和执行编号"))
    if message is not None and (type(message) is not int or not 0 < message <= 2**63 - 1):
        raise ValueError(Text("群委托来源须为本次执行中的群消息"))
    require_owner(connection, room_id, owner)
    host = require_member(connection, room_id, acting)
    window = connection.execute("""SELECT w.channel,w.chat_id FROM moss_windows w JOIN room_directory d ON d.room_id=w.room_id
        WHERE w.room_id=? AND d.system_kind='steward_group' AND d.archived=0""", (room_id,)).fetchone()
    if not window or host["role"] != "host":
        raise PermissionError(Text("只有活动群窗口的主持人可以委托"))
    origin = connection.execute("""SELECT s.message_id FROM member_requests r
        JOIN external_message_sources s ON s.room_id=r.room_id AND s.message_id IN (r.message_id,r.chain_id)
        JOIN member_executions e ON e.id=r.execution_id AND e.member_id=r.member_id
        LEFT JOIN message_withdrawals w ON w.message_id=s.message_id
        WHERE r.room_id=? AND r.member_id=? AND r.execution_id=? AND r.status='delivering'
          AND e.status IN ('dispatched','started') AND w.message_id IS NULL
          AND (? IS NULL OR s.message_id=?) ORDER BY s.message_id DESC LIMIT 1""",
                                (room_id, host["id"], execution, message, message)).fetchone()
    if not origin:
        raise PermissionError(Text("群委托来源须为本次执行中的群消息"))
    return {"source_window_id": room_id, "source_message_id": origin["message_id"], **dict(window), "host": host["name"]}


def may_post_to(connection, source, target):
    """The immutable source binding, not an editable room link, confers relay permission."""
    if not isinstance(target, str):
        return False
    return connection.execute("""SELECT 1 FROM moss_task_rooms t JOIN room_directory d ON d.room_id=t.room_id
        WHERE t.room_id=? AND t.source_window_id=? AND d.system_kind='' AND d.archived=0""", (target, source)).fetchone() is not None

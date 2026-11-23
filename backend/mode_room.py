"""Room modes: the owner's `/goal` and `/discuss` commands, and one view and completion entry for whichever mode is open.

A mode is a built-in way to push the room forward (goal, discussion); at most one is open. Commands are owner
messages: a bare start asks the host to fill in the objective, subcommands act on the open mode directly.
"""

import re

from . import goal_room
from .free_room import insert_request, require_member
from .texts import Text
from .runtime import begin_write
from .session_room import (conclude_session_by_host, control_session, current_session, session_conclusion_view, session_room)

MODE_COMMAND = re.compile(r"^/(goal|discuss)(?:\s+([\s\S]*))?$")
SUBCOMMANDS = {"goal": ("pause", "resume", "clear", "edit"), "discuss": ("pause", "resume", "stop")}
MAX_DISCUSSION_GOAL_LENGTH = 1000


def parse_mode_command(text):
    """Split an owner's `/goal …` or `/discuss …` message into (mode, subcommand, argument); None for other text."""
    match = MODE_COMMAND.match(str(text or "").strip())
    if not match:
        return None
    mode, rest = match.group(1), (match.group(2) or "").strip()
    parts = rest.split(None, 1)
    if parts and parts[0] in SUBCOMMANDS[mode]:
        return mode, parts[0], parts[1].strip() if len(parts) > 1 else ""
    return mode, "start", rest


def check_discuss_command(connection, room_id, command, argument):
    """Validate a `/discuss` command before its message is saved."""
    session = current_session(connection, room_id, active_only=True)
    if command == "start":
        if session:
            raise FileExistsError(Text("讨论已在进行；可用 /discuss pause、/discuss resume 或 /discuss stop"))
        if goal_room.open_goal(connection, room_id):
            raise FileExistsError(Text("Goal 进行中；结束 Goal 后才能开启讨论"))
        goal_room.goal_host(connection, room_id)
        if len(argument) > MAX_DISCUSSION_GOAL_LENGTH:
            raise ValueError(Text("讨论目标最多 {max_discussion_goal_length} 字", max_discussion_goal_length=MAX_DISCUSSION_GOAL_LENGTH))
    elif not session:
        raise FileExistsError(Text("房间没有进行中的讨论"))
    elif command == "pause" and session["status"] != "active":
        raise FileExistsError(Text("讨论已经暂停"))
    elif command == "resume" and session["status"] != "paused":
        raise FileExistsError(Text("讨论当前没有暂停"))


def check_mode_command(connection, room_id, payload):
    """Parse and validate an owner message that is a mode command; None when it is ordinary text."""
    parsed = parse_mode_command(payload.get("text"))
    if not parsed:
        return None
    mode, command, argument = parsed
    # The host runs the goal or discussion, so naming it changes nothing; naming anyone else would wake nobody.
    host = connection.execute("SELECT name FROM room_members WHERE room_id=? AND role='host' AND status='active'", (room_id,)).fetchone()
    if any(name != (host["name"] if host else None) for name in payload.get("to") or []):
        raise ValueError(Text("/{mode} 命令只能 @ 主持人；要请其他成员参与，开启后由主持人安排", mode=mode))
    if mode == "goal":
        goal_room.check_goal_command(connection, room_id, command, argument)
    else:
        check_discuss_command(connection, room_id, command, argument)
    return parsed


def apply_mode_command(connection, room_id, message_id, parsed):
    """Run a saved mode command; the owner's message is itself the authority, so no revision is needed."""
    mode, command, argument = parsed
    if mode == "goal":
        goal_room.apply_goal_command(connection, room_id, message_id, command, argument)
    elif command == "start":
        host = goal_room.goal_host(connection, room_id)
        insert_request(connection, room_id, host["id"], message_id, message_id, "discuss_start", "user")
    else:
        # The full session view: resuming keys its host request by the session revision.
        control_session(connection, session_room(connection, room_id)["session"], command)


def mode_view(connection, room_id):
    """Which mode is open and the revision its completion needs: the goal's revision, or the discussion's conclusion."""
    goal = goal_room.goal_view(connection, room_id)
    if goal["goal"] and goal["goal"]["status"] in goal_room.OPEN_STATUSES:
        return {"mode": "goal", "status": goal["goal"]["status"], "revision": goal["revision"], "goal": goal["goal"]}
    session = current_session(connection, room_id, active_only=True)
    if session:
        conclusion = session_conclusion_view(connection, room_id)
        return {"mode": "discussion", "status": session["status"], "revision": conclusion["revision"],
                "discussion": {"id": session["id"], "goal": session["goal"], **conclusion}}
    return {"mode": None, "status": None, "revision": None}


def finish_mode(connection, room_id, token, payload):
    """The host completes whichever mode is open, with the revision `GET mode` returned."""
    action = payload.get("action")
    if action != "done":
        raise ValueError(Text("action 须为 done；宣告 Goal 卡住用 goal block"))
    begin_write(connection)
    mode = mode_view(connection, room_id)
    if mode["mode"] == "goal":
        return goal_room.finish_goal(connection, room_id, token, payload, "complete")
    if mode["mode"] == "discussion":
        if require_member(connection, room_id, token)["role"] != "host":
            raise PermissionError(Text("只有主持人能宣告讨论完成"))
        conclude_session_by_host(connection, room_id, {"conclusion": payload.get("revision"), "continue": payload.get("continue")})
        return mode_view(connection, room_id)
    raise FileExistsError(Text("房间没有进行中的 Goal 或讨论"))

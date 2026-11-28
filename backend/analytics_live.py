"""The statistics page's “实时” view: what the AI is doing now, what it did in the last hour, and what waits for the owner.

2026-11-27, #14994, reworked after #15198. Unlike the periods, nothing here is compared or cached: it is read fresh on
each refresh. Only what blocks work until the owner acts is listed (#15793): a marked answer, a Goal waiting for
confirmation, a member's question to the owner, and a chain held at its round limit. Failed runs and permission denials
are left to the period's issues: a run that ended is not a wait. A held chain stops waiting once the owner has written
in that room again (they moved on) or after a day, and repeats by one member in one room are one item with a count.
System rooms (the platform steward) and archived rooms are left out, as everywhere on the statistics page.
"""
import re
from collections import defaultdict

from .analytics_issues import concurrency_series, not_finished, unfinished_series

WINDOW = 3600
MINUTE = 60
STALE_WAIT = 86400
RECENT_LIMIT = 40
TASK_LIMIT = 80

ROOMS = "JOIN room_directory d ON d.room_id={0}.room_id AND d.system_kind='' AND d.archived=0"
# The owner wrote in the room after `{0}`: whatever was waiting there before has been looked at.
MOVED_ON = "EXISTS(SELECT 1 FROM messages later WHERE later.room_id={1} AND later.source='user' AND later.id>{0})"
FIRST_MESSAGE = "(SELECT min(q.message_id) FROM member_requests q WHERE q.execution_id=e.id)"

EXECUTION = f"""SELECT e.id,e.room_id,e.member_id,e.created_at,e.finished_at,e.status,e.result,e.paused_at,e.model,e.effort,
    m.name,m.adapter,coalesce(l.label,m.name) AS label,{FIRST_MESSAGE} AS message_id,
    (SELECT f.name FROM room_folder_assignments a JOIN topic_folders f ON f.id=a.folder_id WHERE a.room_id=e.room_id) AS folder
    FROM member_executions e {ROOMS.format('e')} JOIN room_members m ON m.id=e.member_id
    LEFT JOIN member_labels l ON l.room_id=e.room_id AND l.name=m.name"""
RUNNING = EXECUTION + " WHERE e.status IN ('dispatched','started') AND e.lease_until>? ORDER BY e.created_at"
RECENT = EXECUTION + """ WHERE e.created_at<=? AND (e.finished_at>=? OR e.finished_at=0 AND e.status IN ('dispatched','started'))"""


def task_text(connection, message_id):
    """The first line of the message a run works on, without Markdown marks: what the run is about at a glance."""
    row = connection.execute("SELECT text FROM messages WHERE id=?", (message_id,)).fetchone() if message_id else None
    for line in (row["text"] if row else "").splitlines():
        line = re.sub(r"^[#>*\-\s]+|[*`_]", "", line).strip()
        if line and not line.startswith("---"):
            return line[:TASK_LIMIT]
    return ""


def run_item(connection, row, now):
    """One run as the page lists it: who, which model, where, on what, and for how long."""
    end = row["finished_at"] or now
    return {"execution_id": row["id"], "room_id": row["room_id"], "folder": row["folder"], "member": row["name"],
            "label": row["label"], "adapter": row["adapter"], "model": row["model"], "effort": row["effort"],
            "message_id": row["message_id"], "task": task_text(connection, row["message_id"]), "status": row["status"],
            "started_at": row["created_at"], "finished_at": row["finished_at"], "seconds": max(0, end - row["created_at"]),
            "paused": bool(row["paused_at"]), "error": not_finished(row)}


def queue(connection):
    """Requests not yet picked up and user messages queued behind busy rooms."""
    pending = connection.execute(f"""SELECT count(*) FROM member_requests r {ROOMS.format('r')} WHERE r.status='pending'""").fetchone()[0]
    queued = connection.execute(f"""SELECT count(*) FROM queued_messages q {ROOMS.format('q')}""").fetchone()[0]
    return {"requests": pending, "messages": queued}


def merged(items):
    """One item per kind, room and member: the earliest wait, the latest message to jump to, and how many there were."""
    groups = {}
    for item in items:
        key = (item["kind"], item["room_id"], item.get("member"))
        if key not in groups:
            groups[key] = {**item, "count": 1}
            continue
        group = groups[key]
        group["count"] += 1
        group["since"] = min(filter(None, (group["since"], item["since"])), default=None)
        group["message_id"] = max(filter(None, (group["message_id"], item["message_id"])), default=None)
    return list(groups.values())


def waiting_for_owner(connection, now):
    """Everything that stalls until the owner acts, oldest first."""
    items = [{"kind": "goal", "room_id": r["room_id"], "since": r["phase_since"] or r["started_at"],
              "message_id": r["started_message_id"] or None}
             for r in connection.execute(f"""SELECT g.* FROM room_goals g {ROOMS.format('g')}
                 WHERE g.status='active' AND g.phase='pending'""")]
    items += [{"kind": "question", "room_id": r["room_id"], "since": r["waiting_since"], "message_id": r["message_id"] or None,
               "member": r["asker"]}
              for r in connection.execute(f"""SELECT q.* FROM room_questions q {ROOMS.format('q')} WHERE q.status='waiting_user'""")]
    items += [{"kind": "awaiting", "room_id": row["room_id"], "since": row["created_at"],
               "message_id": row["message_id"], "member": row["label"]}
              for row in connection.execute(f"""SELECT w.room_id,w.created_at,w.message_id,coalesce(l.label,m.name) AS label
                  FROM room_waits w {ROOMS.format('w')} JOIN room_members m ON m.id=w.member_id
                  LEFT JOIN member_labels l ON l.room_id=w.room_id AND l.name=m.name WHERE w.ended_at=0""")]
    items += [{"kind": "rounds", "room_id": r["room_id"], "since": r["since"], "message_id": r["message_id"] or r["chain_id"],
               "rounds": r["asked_rounds"]}
              for r in connection.execute(f"""SELECT h.*,CAST(strftime('%s',m.created_at) AS INTEGER) AS since
                  FROM free_chain_holds h {ROOMS.format('h')} JOIN messages m ON m.id=max(h.message_id,h.chain_id)
                  WHERE (h.message_id>0 OR h.asked_rounds>0) AND CAST(strftime('%s',m.created_at) AS INTEGER)>=?
                    AND NOT {MOVED_ON.format('max(h.message_id,h.chain_id)', 'h.room_id')}""", (now - STALE_WAIT,))]
    return sorted(merged(items), key=lambda item: (item["since"] is None, item["since"] or 0))


def live_snapshot(connection, now):
    """The live view: running members, the last hour's finished runs and timeline, the queue, and what waits."""
    connection.execute("BEGIN")
    start = now - WINDOW
    rows = connection.execute(RECENT, (now, start)).fetchall()
    spans = defaultdict(list)
    for row in rows:
        left, right = max(start, row["created_at"]), min(now, row["finished_at"] or now)
        if left < right:
            spans[(row["room_id"], row["name"])].append((left, right))
    timeline = concurrency_series(spans, start, now, MINUTE)
    timeline["unfinished"] = unfinished_series(rows, start, now, MINUTE)
    timeline["start"] = start
    finished = sorted((row for row in rows if row["finished_at"] and row["finished_at"] >= start),
                      key=lambda row: row["finished_at"], reverse=True)
    hour = {"completed": sum(1 for row in finished if row["status"] == "completed"),
            "errors": sum(1 for row in rows if not_finished(row) and row["created_at"] >= start),
            "runs": [run_item(connection, row, now) for row in finished[:RECENT_LIMIT]], "total": len(finished)}
    return {"live": {"at": now, "running": [run_item(connection, row, now) for row in connection.execute(RUNNING, (now,))],
                     "queue": queue(connection), "waiting": waiting_for_owner(connection, now), "hour": hour,
                     "errors": hour["errors"], "timeline": timeline}}

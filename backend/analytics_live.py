"""The statistics page's “实时” view: what the AI is doing right now and what waits for the owner (2026-11-27, #14994).

Unlike the periods, nothing here is compared or cached: it is read fresh on each refresh. Five kinds of things wait for
the owner, all of which stall work until handled (#15070): a Goal waiting for confirmation, a member's question to the
owner, a chain held at its round limit, a failed request not yet retried, and a run blocked by a permission denial.
System rooms (the platform steward) are left out, as everywhere on the statistics page.
"""
from collections import defaultdict

from .analytics_issues import concurrency_series, not_finished, unfinished_series

WINDOW = 3600
MINUTE = 60
RECENT_FAILURE = 86400

ROOMS = "JOIN room_directory d ON d.room_id={0}.room_id AND d.system_kind='' AND d.archived=0"

RUNNING = f"""SELECT e.id,e.room_id,e.created_at,e.paused_at,e.model,e.effort,m.name,m.adapter,
    coalesce(l.label,m.name) AS label,
    (SELECT min(r.message_id) FROM member_requests r WHERE r.execution_id=e.id) AS message_id
    FROM member_executions e {ROOMS.format('e')} JOIN room_members m ON m.id=e.member_id
    LEFT JOIN member_labels l ON l.room_id=e.room_id AND l.name=m.name
    WHERE e.status IN ('dispatched','started') AND e.lease_until>? ORDER BY e.created_at"""

RECENT = f"""SELECT e.id,e.room_id,e.member_id,e.created_at,e.finished_at,e.status,e.result,m.name
    FROM member_executions e {ROOMS.format('e')} JOIN room_members m ON m.id=e.member_id
    WHERE e.created_at<=? AND (e.finished_at>=? OR e.finished_at=0 AND e.status IN ('dispatched','started'))"""


def running(connection, now):
    """Executions holding a live lease, oldest first, with the message they work on."""
    rows = connection.execute(RUNNING, (now,)).fetchall()
    return [{"execution_id": r["id"], "room_id": r["room_id"], "member": r["name"], "label": r["label"],
             "adapter": r["adapter"], "model": r["model"], "effort": r["effort"], "message_id": r["message_id"],
             "started_at": r["created_at"], "seconds": max(0, now - r["created_at"]), "paused": bool(r["paused_at"])} for r in rows]


def queue(connection):
    """Requests not yet picked up and user messages queued behind busy rooms."""
    pending = connection.execute(f"""SELECT r.room_id,count(*) AS count,min(r.created_at) AS since FROM member_requests r
        {ROOMS.format('r')} WHERE r.status='pending' GROUP BY r.room_id""").fetchall()
    queued = connection.execute(f"""SELECT q.room_id,count(*) AS count,min(q.created_at) AS since FROM queued_messages q
        {ROOMS.format('q')} GROUP BY q.room_id""").fetchall()
    rooms = defaultdict(lambda: {"requests": 0, "messages": 0, "since": None})
    for rows, key in ((pending, "requests"), (queued, "messages")):
        for row in rows:
            room = rooms[row["room_id"]]
            room[key] = row["count"]
            room["since"] = min(filter(None, (room["since"], row["since"])))
    return {"requests": sum(r["requests"] for r in rooms.values()), "messages": sum(r["messages"] for r in rooms.values()),
            "rooms": [{"room_id": room_id, **values} for room_id, values in rooms.items()]}


def waiting_for_owner(connection, now):
    """Everything that stalls until the owner acts, oldest first."""
    items = [{"kind": "goal", "room_id": r["room_id"], "since": r["phase_since"] or r["started_at"],
              "message_id": r["started_message_id"] or None, "note": r["phase_note"]}
             for r in connection.execute(f"""SELECT g.* FROM room_goals g {ROOMS.format('g')}
                 WHERE g.status='active' AND g.phase='pending'""")]
    items += [{"kind": "question", "room_id": r["room_id"], "since": r["waiting_since"], "message_id": r["message_id"] or None,
               "member": r["asker"]}
              for r in connection.execute(f"""SELECT q.* FROM room_questions q {ROOMS.format('q')}
                  WHERE q.status='waiting_user'""")]
    # A held chain stops waiting once the owner has written in the room again: they moved on instead of continuing it.
    items += [{"kind": "rounds", "room_id": r["room_id"], "since": None, "message_id": r["message_id"] or r["chain_id"],
               "rounds": r["asked_rounds"]}
              for r in connection.execute(f"""SELECT h.* FROM free_chain_holds h {ROOMS.format('h')}
                  WHERE (h.message_id>0 OR h.asked_rounds>0) AND NOT EXISTS(SELECT 1 FROM messages later
                      WHERE later.room_id=h.room_id AND later.source='user' AND later.id>max(h.message_id,h.chain_id))""")]
    items += [{"kind": "failed", "room_id": r["room_id"], "since": r["created_at"], "message_id": r["message_id"],
               "member": r["name"]}
              for r in connection.execute(f"""SELECT r.room_id,r.message_id,r.created_at,m.name FROM member_requests r
                  {ROOMS.format('r')} JOIN room_members m ON m.id=r.member_id
                  WHERE r.status='failed' AND r.created_at>=?""", (now - RECENT_FAILURE,))]
    # A denial only waits while it is the member's latest run in the room: a later run means the owner already moved on.
    items += [{"kind": "permission", "room_id": r["room_id"], "since": r["created_at"], "message_id": r["message_id"],
               "member": r["name"]}
              for r in connection.execute(f"""SELECT e.room_id,e.created_at,m.name,
                  (SELECT min(q.message_id) FROM member_requests q WHERE q.execution_id=e.id) AS message_id
                  FROM member_executions e {ROOMS.format('e')} JOIN room_members m ON m.id=e.member_id
                  JOIN execution_denials x ON x.execution_id=e.id AND x.denials NOT IN ('','[]','{{}}')
                  WHERE e.created_at>=? AND NOT EXISTS(SELECT 1 FROM member_executions later
                      WHERE later.room_id=e.room_id AND later.member_id=e.member_id AND later.id>e.id)""",
                                            (now - RECENT_FAILURE,))]
    return sorted(items, key=lambda item: (item["since"] is None, item["since"] or 0))


def live_snapshot(connection, now):
    """The live view: running members, queue, what waits for the owner, and the last hour minute by minute."""
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
    errors = sum(1 for row in rows if not_finished(row) and row["created_at"] >= start)
    return {"live": {"at": now, "running": running(connection, now), "queue": queue(connection),
                     "waiting": waiting_for_owner(connection, now), "errors": errors, "timeline": timeline}}

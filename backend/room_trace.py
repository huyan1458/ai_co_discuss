"""Trace a public message through room work, without exposing private conversations."""

import json
from collections import defaultdict

from .free_room import LAYOUT_AFTER_SQL, layout_at_sql, member_events, require_member, require_owner_or_host


TRACE_PAGE = 50
TRACE_FIELDS = {
    "message.posted": ("message_id", "source"),
    "message.withdrawn": ("message_id", "kind"),
    "request.created": ("request_id", "message_id", "member_id", "purpose", "created_by", "batch_id", "status"),
    "request.changed": ("request_id", "message_id", "member_id", "execution_id", "answer_id", "status", "from_status"),
    "request.cancel_reason": ("request_id", "member_id", "reason"),
    "execution.created": ("execution_id", "member_id", "status"),
    "execution.changed": ("execution_id", "member_id", "status", "from_status", "result"),
    "execution.retry": ("execution_id", "attempt", "retry_at", "stopped", "reason"),
    "execution.late_answer": ("execution_id",),
    "batch.opened": ("batch_id", "host_id"),
    "batch.settled": ("batch_id", "settled"),
    "batch.handoff": ("batch_id",),
    "queue.added": ("queue_id", "message_id", "member_id"),
    "queue.removed": ("queue_id", "message_id", "member_id"),
}
EXECUTION_ACTIONS = frozenset(("delivery", "fail", "release", "retry", "retry_wait", "retry_start", "retry_now",
                               "retry_stop", "interjection"))


def selected_fields(data, fields):
    """Copy only the fields intended for the trace."""
    return {key: data[key] for key in fields if key in data}


def trace_history(connection, room_id, token, reader, messages):
    """Load structural events and apply the existing member event policy before following links."""
    kinds = ",".join("?" for _ in TRACE_FIELDS)
    actions = ",".join("?" for _ in EXECUTION_ACTIONS)
    rows = connection.execute(f"""SELECT id,at,kind,data FROM room_events WHERE room_id=?
        AND (kind IN ({kinds}) OR (kind='api.write' AND json_extract(data,'$.path') LIKE '/executions/%'
            AND CASE WHEN json_valid(json_extract(data,'$.payload'))
                THEN json_extract(json_extract(data,'$.payload'),'$.action') END IN ({actions})))
        ORDER BY at,id""", (room_id, *TRACE_FIELDS, *EXECUTION_ACTIONS))
    events = [{**dict(row), "data": json.loads(row["data"])} for row in rows]
    if reader:
        events = member_events(connection, room_id, token, reader, events)
    for event in events:
        kind, data = event["kind"], event["data"]
        if kind == "api.write":
            data = execution_action_event(data)
            if data is None:
                continue
        else:
            data = selected_fields(data, TRACE_FIELDS[kind])
        if any(data.get(field) and data[field] not in messages for field in ("message_id", "answer_id", "batch_id")):
            continue
        result_id = data.get("result", "").removeprefix("message:")
        if result_id != data.get("result", "") and result_id.isdigit() and int(result_id) not in messages:
            data.pop("result")
        yield {**selected_fields(event, ("id", "at", "kind")), "data": data, "source": "history"}


def execution_action_event(data):
    """Project execution audit writes without their payload, paths or prose."""
    parts = data.get("path", "").split("/")
    if len(parts) != 3 or not parts[-1].isdigit():
        return None
    try:
        payload = json.loads(data.get("payload", ""))
    except (ValueError, TypeError):
        return None
    if not isinstance(payload, dict) or payload.get("action") not in EXECUTION_ACTIONS:
        return None
    return {"execution_id": int(parts[-1]), "actor": data.get("actor"),
            **selected_fields(payload, ("action", "interjection_id", "status", "attempt", "retry_at"))}


def trace_requests(connection, room_id, reader, messages):
    """Read current requests under the same scope as their history."""
    rows = connection.execute(f"""SELECT r.id AS request_id,r.message_id,r.member_id,r.purpose,r.created_by,
        r.status,r.execution_id,r.answer_id,r.batch_id,{LAYOUT_AFTER_SQL} AS layout_after,m.author
        FROM member_requests r JOIN messages m ON m.id=r.message_id WHERE r.room_id=? ORDER BY r.id""", (room_id,))
    for row in rows:
        if row["message_id"] not in messages:
            continue
        data = dict(row)
        author = data.pop("author")
        if reader and row["member_id"] != reader["id"]:
            if author != reader["name"]:
                continue
            data = selected_fields(data, ("request_id", "message_id", "purpose", "status", "created_by"))
        if any(data.get(field) and data[field] not in messages for field in ("answer_id", "batch_id", "layout_after")):
            data = {key: value for key, value in data.items()
                    if key not in ("answer_id", "batch_id", "layout_after") or value in messages}
        yield current_record("request", data)


def current_record(kind, data):
    """Mark a current persisted value, separate from an event."""
    return {"source": "current", "kind": kind, "data": dict(data)}


def trace_related_rows(connection, room_id, reader, messages):
    """Read retry, public insertion and host-wake links from their persisted records."""
    member_id = reader["id"] if reader else None
    rows = connection.execute("""SELECT rr.execution_id,rr.request_id,rr.retried_at,r.message_id
        FROM retried_requests rr JOIN member_requests r ON r.id=rr.request_id
        WHERE r.room_id=? AND (? IS NULL OR r.member_id=?) ORDER BY rr.execution_id,rr.request_id""",
                              (room_id, member_id, member_id))
    for row in rows:
        if row["message_id"] in messages:
            yield current_record("retry.request", row)
    rows = connection.execute("""SELECT i.id AS interjection_id,i.execution_id,r.message_id,i.status,i.updated_at
        FROM member_requests r JOIN execution_interjections i
            ON i.room_id=r.room_id AND i.submission_id='queue-'||r.message_id||'-'||r.member_id
            AND (i.execution_id=r.execution_id OR EXISTS(SELECT 1 FROM retried_requests rr
                WHERE rr.request_id=r.id AND rr.execution_id=i.execution_id))
        WHERE r.room_id=? AND (? IS NULL OR r.member_id=?) ORDER BY i.id""", (room_id, member_id, member_id))
    for row in rows:
        if row["message_id"] in messages:
            yield current_record("interjection", row)
    rows = connection.execute("""SELECT w.message_id,e.id AS execution_id FROM free_host_wakes w
        JOIN member_executions e ON e.room_id=w.room_id AND e.id=CAST(substr(w.key,instr(w.key,':')+1) AS INTEGER)
        WHERE w.room_id=? AND w.key IN ('host_failed:'||e.id,'failed:'||e.id)
        AND (? IS NULL OR e.member_id=? AND EXISTS(
            SELECT 1 FROM member_requests r WHERE r.message_id=w.message_id AND r.member_id=e.member_id))
        ORDER BY w.message_id""",
                              (room_id, member_id, member_id))
    for row in rows:
        if row["message_id"] in messages:
            yield current_record("failure_wake", row)


def trace_executions(connection, room_id, reader, execution_ids, messages):
    """Look up current execution status, retry and card position for the selected executions."""
    member_id = reader["id"] if reader else None
    for execution_id in sorted(execution_ids):
        row = connection.execute(f"""SELECT e.id AS execution_id,e.member_id,e.status,e.created_at,
            (SELECT MAX({LAYOUT_AFTER_SQL}) FROM member_requests r WHERE r.execution_id=e.id
                OR r.id IN (SELECT request_id FROM retried_requests WHERE execution_id=e.id)) AS layout_after,
            (SELECT MIN({layout_at_sql("e.id")}) FROM member_requests r WHERE r.execution_id=e.id
                OR r.id IN (SELECT request_id FROM retried_requests WHERE execution_id=e.id)) AS layout_at,
            t.attempt,t.retry_at,t.stopped,f.failure_class
            FROM member_executions e LEFT JOIN execution_retries t ON t.execution_id=e.id
            LEFT JOIN execution_failures f ON f.execution_id=e.id
            WHERE e.room_id=? AND e.id=? AND (? IS NULL OR e.member_id=?)""",
                                 (room_id, execution_id, member_id, member_id)).fetchone()
        if row:
            data = dict(row)
            data["layout_at"] = row["layout_at"] or row["created_at"]
            if row["layout_after"] not in messages:
                data["layout_after"] = None
            yield current_record("execution", data)


def trace_nodes(data):
    """Use typed identifiers so a request ID cannot be mistaken for an execution ID."""
    for field, node_type in (("message_id", "message"), ("answer_id", "message"), ("batch_id", "message"),
                             ("request_id", "request"), ("execution_id", "execution")):
        if isinstance(data.get(field), int) and data[field] > 0:
            yield node_type, data[field]


def connected_records(records, message_id):
    """Follow shared message, request and execution links across all pages."""
    lookup = defaultdict(list)
    nodes_by_record = [set(trace_nodes(record["data"])) for record in records]
    for index, nodes in enumerate(nodes_by_record):
        for node in nodes:
            lookup[node].append(index)
    seen, pending, selected = set(), [("message", message_id)], set()
    while pending:
        node = pending.pop()
        if node not in seen:
            seen.add(node)
            for index in lookup[node]:
                if index not in selected:
                    selected.add(index)
                    pending.extend(nodes_by_record[index] - seen)
    return [records[index] for index in sorted(selected)], {value for kind, value in seen if kind == "execution"}


def message_trace(connection, room_id, token, anchor, options):
    """Return a page of visible historical events and current card state for one message."""
    try:
        require_owner_or_host(connection, room_id, token)
        reader = None
    except PermissionError:
        reader = require_member(connection, room_id, token)
    cutoff, page = options["read_until"], options["page"]
    messages = {row[0] for row in connection.execute("""SELECT id FROM messages WHERE room_id=?
        AND (? IS NULL OR id<=?) AND NOT EXISTS (SELECT 1 FROM internal_task_messages t WHERE t.message_id=messages.id)""",
                                                     (room_id, cutoff, cutoff))}
    current = []
    if cutoff is None:
        current = [*trace_requests(connection, room_id, reader, messages),
                   *trace_related_rows(connection, room_id, reader, messages)]
    history = list(trace_history(connection, room_id, token, reader, messages))
    if cutoff is not None:
        # A current execution can reveal work after the cutoff, even if its original message is visible.
        boundary_time = connection.execute("SELECT strftime('%s',created_at) FROM messages WHERE room_id=? AND id=?",
                                           (room_id, cutoff)).fetchone()
        end = int(boundary_time[0]) * 1000 if boundary_time and boundary_time[0] else 0
        history = [record for record in history if record["at"] < end]
    public_insertions = {record["data"]["interjection_id"] for record in current if record["kind"] == "interjection"}
    history = [record for record in history if record["data"].get("action") != "interjection"
               or record["data"].get("interjection_id") in public_insertions]
    records, execution_ids = connected_records([*history, *current], anchor["id"])
    if cutoff is None:
        records.extend(trace_executions(connection, room_id, reader, execution_ids, messages))
    message = {"id": anchor["id"]}
    if cutoff is None:
        for field in ("layout_after", "interjection_parent_id"):
            message[field] = anchor[field] if anchor[field] in messages else None
        message["layout_at"] = anchor["layout_at"]
    offset = (page - 1) * TRACE_PAGE
    return {"message": message, "read_until": cutoff, "page": page,
            "records": records[offset:offset + TRACE_PAGE],
            "next_page": page + 1 if offset + TRACE_PAGE < len(records) else None}

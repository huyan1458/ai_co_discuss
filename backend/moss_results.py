"""Track MOSS child delegations by their send cards and keep replies on the exact task chain."""

import time

from .free_room import insert_request
from .runtime import begin_write
from .texts import Text, save_text

REPORT_LIMIT = 240
TERMINAL_STATES = ("completed", "failed", "cancelled", "unreported")
ACTIVE_STATES = "('','waiting','waiting_user')"
DELEGATION_QUERY = """SELECT d.*, s.room_id AS parent, s.target_room_id AS child, s.target_message_id AS root
    FROM moss_delegations d JOIN room_relay_sends s ON s.message_id=d.message_id"""
DELEGATED_SENDS = """SELECT s.message_id,s.room_id,s.target_room_id FROM room_relay_sends s
    JOIN room_directory moss ON moss.room_id=s.room_id AND moss.system_kind='steward'
    LEFT JOIN moss_delegations d ON d.message_id=s.message_id
    LEFT JOIN messages incoming ON incoming.id=s.target_message_id AND incoming.room_id=s.target_room_id
    LEFT JOIN message_relays relay ON relay.message_id=incoming.id AND relay.source_room_id=s.room_id
    LEFT JOIN queued_messages q ON q.id=s.queued_id AND q.room_id=s.target_room_id
    WHERE d.message_id IS NOT NULL OR relay.expect='reply' OR
        (json_extract(q.payload,'$.relay.room_id')=s.room_id AND json_extract(q.payload,'$.relay.expect')='reply')"""
WORK_QUERY = f"""WITH recent AS (
    SELECT target_room_id,MAX(message_id) AS card_id FROM ({DELEGATED_SENDS})
    WHERE room_id=:parent GROUP BY target_room_id
), targets AS (
    SELECT target_room_id AS room_id FROM recent
    UNION SELECT room_id FROM room_links WHERE other_room_id=:parent AND relation='parent'
)
SELECT r.id AS room_id,r.title,CASE WHEN task.room_id IS NULL THEN '' ELSE 'task' END AS preset,
       dir.archived,recent.card_id AS delegation_message_id,d.state,d.summary,d.result_message_id,
       s.target_message_id AS root,COALESCE(card.created_at,r.created_at) AS sent_at,received.created_at AS received_at,
       result.created_at AS result_at,d.updated_at
FROM targets JOIN rooms r ON r.id=targets.room_id
JOIN room_directory dir ON dir.room_id=r.id AND dir.system_kind=''
LEFT JOIN recent ON recent.target_room_id=r.id
LEFT JOIN room_relay_sends s ON s.message_id=recent.card_id
LEFT JOIN moss_delegations d ON d.message_id=recent.card_id
LEFT JOIN moss_task_rooms task ON task.room_id=r.id
LEFT JOIN messages card ON card.id=recent.card_id
LEFT JOIN messages received ON received.id=s.target_message_id AND received.room_id=r.id
LEFT JOIN messages result ON result.id=d.result_message_id AND result.room_id=r.id
ORDER BY recent.card_id DESC,r.created_at DESC,r.id"""


def migrate_delegations(connection):
    """Extend the existing delegation table without dropping reports."""
    row = connection.execute("SELECT sql FROM sqlite_master WHERE name='moss_delegations'").fetchone()
    if not row:
        return
    definition = row[0]
    if "'waiting_user'" not in definition:
        begin_write(connection)
        next_table = definition.replace("moss_delegations", "moss_delegations_next", 1)
        connection.execute(next_table.replace("'waiting'", "'waiting','waiting_user'", 1))
        connection.execute("INSERT INTO moss_delegations_next SELECT * FROM moss_delegations")
        connection.execute("DROP TABLE moss_delegations")
        connection.execute("ALTER TABLE moss_delegations_next RENAME TO moss_delegations")
    if "updated_at" not in definition:
        connection.execute("ALTER TABLE moss_delegations ADD COLUMN updated_at TEXT")


def is_child_delegation(connection, parent, child):
    """Track replies to delegated work in the active MOSS's own linked child rooms."""
    return connection.execute("""SELECT 1 FROM room_links l
        JOIN room_directory d ON d.room_id=l.other_room_id
        WHERE l.room_id=? AND l.other_room_id=? AND l.relation='parent'
        AND d.archived=0 AND (d.system_kind IN ('steward','steward_private') OR
          (d.system_kind='steward_group' AND EXISTS (SELECT 1 FROM moss_task_rooms t
            WHERE t.room_id=l.room_id AND t.source_window_id=l.other_room_id)))""", (child, parent)).fetchone() is not None


def delegation_for_reply(connection, parent, child, reply_to):
    """Find only replies to the exact delegated request."""
    if type(reply_to) is not int:
        return None
    return connection.execute(f"{DELEGATION_QUERY} WHERE s.room_id=? AND s.target_room_id=? AND s.target_message_id=?",
                              (parent, child, reply_to)).fetchone()


def register_rework(connection, card, host, child, execution_id):
    """A send made during a unique review for this child continues its original card."""
    if execution_id is None:
        return
    reviews = connection.execute("""SELECT COALESCE(w.root_message_id,r.message_id) FROM member_requests r
        JOIN moss_delegations d ON d.review_message_id=r.message_id
        JOIN room_relay_sends s ON s.message_id=d.message_id
        LEFT JOIN moss_reworks w ON w.message_id=d.message_id
        WHERE r.member_id=? AND r.execution_id=? AND r.status IN ('delivering','completed') AND r.purpose='notice'
        AND s.target_room_id=? LIMIT 2""", (host, execution_id, child)).fetchall()
    if len(reviews) == 1 and reviews[0][0] != card:
        connection.execute("INSERT OR IGNORE INTO moss_reworks VALUES(?,?)", (card, reviews[0][0]))


def register_decision(connection, host, parent, submission, execution_id):
    """Associate the child's question with the delegation being handled, not every task in the room."""
    where = f""" WHERE s.room_id=? AND s.target_room_id=? AND s.target_message_id IS NOT NULL AND d.state IN {ACTIVE_STATES}"""
    params = (parent, host["room_id"])
    if execution_id is not None:
        where += """ AND EXISTS (SELECT 1 FROM member_requests r WHERE r.member_id=? AND r.execution_id=?
            AND r.chain_id=s.target_message_id AND r.status='delivering')"""
        params += (host["id"], execution_id)
    rows = connection.execute(DELEGATION_QUERY + where + " LIMIT 2", params).fetchall()
    if len(rows) == 1:
        connection.execute("INSERT OR IGNORE INTO moss_decision_links VALUES(?,?,?)", (parent, submission, rows[0]["message_id"]))


def decision_pending(connection, delegation):
    """Find an unanswered decision request, including one still in MOSS's queue."""
    parent, child, identifier = (delegation[key] for key in ("parent", "child", "message_id"))
    delivered = connection.execute("""SELECT m.id, m.text,
        (SELECT message_id FROM room_relay_sends s WHERE s.room_id=? AND s.target_room_id=? AND s.target_message_id=m.id) AS child_message_id
        FROM moss_decision_links l JOIN messages m ON m.room_id=l.parent_room_id AND m.submission_id=l.submission_id
        WHERE l.delegation_id=?
        AND NOT EXISTS(SELECT 1 FROM message_withdrawals w WHERE w.message_id=m.id)
        AND NOT EXISTS(SELECT 1 FROM message_relays answer JOIN messages a ON a.id=answer.message_id
            WHERE answer.reply_to=m.id AND answer.source_room_id=m.room_id AND a.room_id=?
            AND NOT EXISTS(SELECT 1 FROM message_withdrawals w WHERE w.message_id=a.id))
        ORDER BY m.id DESC LIMIT 1""", (child, parent, identifier, child)).fetchone()
    return delivered or connection.execute("""SELECT json_extract(q.payload,'$.text') AS text, s.message_id AS child_message_id
        FROM moss_decision_links l JOIN queued_messages q ON q.room_id=l.parent_room_id AND q.submission_id=l.submission_id
        LEFT JOIN room_relay_sends s ON s.queued_id=q.id AND s.room_id=? AND s.target_room_id=q.room_id
        WHERE l.delegation_id=? AND q.failure='' ORDER BY q.position LIMIT 1""", (child, identifier)).fetchone()


def bind_decision_replies(connection, row):
    """Resume only the delegation that asked this question when a decision arrives."""
    parent, child, root, identifier = (row[key] for key in ("parent", "child", "root", "message_id"))
    connection.execute("""UPDATE member_requests SET chain_id=? WHERE room_id=? AND status='pending' AND chain_id=message_id
        AND message_id IN (SELECT answer.message_id FROM moss_decision_links l JOIN messages q
            ON q.room_id=l.parent_room_id AND q.submission_id=l.submission_id
            JOIN message_relays answer ON answer.reply_to=q.id AND answer.source_room_id=? WHERE l.delegation_id=?)""",
                       (root, child, parent, identifier))


def user_questions(connection, child, root):
    """Get questions and decisions tied to this chain's source requests."""
    return connection.execute("""SELECT q.* FROM room_questions q WHERE q.room_id=? AND EXISTS (
        SELECT 1 FROM json_each(q.request_ids) src JOIN member_requests r ON r.id=src.value
        WHERE r.room_id=q.room_id AND r.chain_id=?) ORDER BY q.id DESC""", (child, root)).fetchall()


def bind_user_decisions(connection, child, root, questions):
    """Question replies may create a new standalone request or wait in the owner's queue."""
    identifiers = {q[key] for q in questions for key in ("answer_message_id", "request_message_id") if q[key]}
    if not identifiers:
        return False
    connection.executemany("UPDATE member_requests SET chain_id=? WHERE room_id=? AND status='pending' AND chain_id=message_id AND message_id=?",
                           [(root, child, identifier) for identifier in identifiers])
    return any(row[0] in identifiers for row in connection.execute(
        """SELECT json_extract(payload,'$.message_id') FROM queued_messages WHERE room_id=? AND failure=''""", (child,)))


def final_answer(connection, row):
    """Choose a host answer in this settled chain, excluding dispatch and reminder text."""
    child, root = row["child"], row["root"]
    return connection.execute("""SELECT a.id, COALESCE(NULLIF(summary.text,''),a.text) AS summary
        FROM member_requests r JOIN messages a ON a.id=r.answer_id JOIN room_members m ON m.id=r.member_id
        LEFT JOIN message_summaries summary ON summary.message_id=a.id
        LEFT JOIN free_host_wakes wake ON wake.room_id=r.room_id AND wake.message_id=r.message_id
        WHERE r.room_id=? AND r.chain_id=? AND r.status='completed' AND m.role='host'
        AND (r.purpose IN ('ask','handoff','keep_working') OR a.reply_to=? OR wake.key LIKE 'handoff:%'
             OR wake.key LIKE 'continue:%' OR wake.key LIKE 'retried:%')
        AND NOT EXISTS(SELECT 1 FROM message_withdrawals w WHERE w.message_id=a.id)
        AND NOT EXISTS(SELECT 1 FROM free_batches b WHERE b.room_id=r.room_id AND b.batch_id=a.id)
        AND NOT EXISTS(SELECT 1 FROM room_waits w WHERE w.message_id=a.id)
        AND NOT EXISTS(SELECT 1 FROM room_questions q WHERE q.room_id=r.room_id AND q.message_id=a.id)
        AND NOT EXISTS(SELECT 1 FROM free_host_continues c WHERE c.room_id=r.room_id AND c.message_id=a.id)
        AND NOT EXISTS(SELECT 1 FROM member_requests downstream WHERE downstream.room_id=r.room_id
            AND downstream.chain_id=r.chain_id AND downstream.message_id=a.id AND downstream.created_by='host')
        AND NOT EXISTS(SELECT 1 FROM free_chain_holds h WHERE h.room_id=r.room_id AND h.chain_id=r.chain_id AND h.message_id=a.id)
        ORDER BY a.id DESC LIMIT 1""", (child, root, root)).fetchone()


def current_host(connection, room):
    """Return the host that can still take a review or reminder."""
    member = connection.execute("""SELECT m.id FROM room_members m JOIN room_directory d ON d.room_id=m.room_id
        WHERE m.room_id=? AND m.status='active' AND m.role='host' AND d.archived=0""", (room,)).fetchone()
    return member["id"] if member else None


def remind_child(connection, row, host):
    """Ask for the missing report once, tied to the same child chain."""
    child, root = row["child"], row["root"]
    notice = Text("MOSS 委派 #{request} 尚未收到结果。已有结果时请用 room-post 回复原委派；还不能交付时说明原因。", request=root)
    identifier = connection.execute("""INSERT INTO messages (room_id,author,text,source,submission_id,created_at)
        VALUES (?, '系统', ?, 'notice', ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))""",
                                    (child, str(notice), f"moss-report-reminder-{row['message_id']}")).lastrowid
    connection.execute("INSERT INTO message_details(message_id,kind,submitted_by) VALUES(?,'notice','系统')", (identifier,))
    save_text(connection, "message", identifier, "text", notice)
    insert_request(connection, child, host, identifier, root, "notice", "system")
    connection.execute("UPDATE moss_delegations SET reminder_message_id=? WHERE message_id=?", (identifier, row["message_id"]))
    connection.moss_updates.add(child)


def report(connection, row, outcome, message_id=None, summary=""):
    """Update the existing sender card and attach at most one MOSS review request to it."""
    review = row["review_message_id"]
    if outcome in TERMINAL_STATES and not review:
        host = current_host(connection, row["parent"])
        if host:
            review = row["message_id"]
            task = connection.execute("SELECT source_message_id FROM moss_task_rooms WHERE room_id=? AND source_window_id=?",
                                      (row["child"], row["parent"])).fetchone()
            chain = (task["source_message_id"] if task else None) or review
            insert_request(connection, row["parent"], host, review, chain, "notice", "system")
    if outcome == "completed":
        connection.execute("UPDATE room_relay_sends SET state='replied' WHERE message_id=? AND state<>'replied'", (row["message_id"],))
    summary = summary.strip()[:REPORT_LIMIT]
    if (row["state"], row["result_message_id"], row["summary"], row["review_message_id"]) != (outcome, message_id, summary, review):
        connection.execute("""UPDATE moss_delegations SET state=?,result_message_id=?,summary=?,review_message_id=?,
            updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE message_id=?""",
                           (outcome, message_id, summary, review, row["message_id"]))
        connection.moss_updates.add(row["parent"])


def evaluate(connection, row):
    """Settle only the delegated chain, never infer completion from room idleness or prose."""
    child, root = row["child"], row["root"]
    directory = connection.execute("SELECT archived FROM room_directory WHERE room_id=?", (child,)).fetchone()
    if directory is None or directory["archived"]:
        return report(connection, row, "cancelled")
    if not root:
        return
    bind_decision_replies(connection, row)
    if connection.execute("SELECT 1 FROM member_requests WHERE room_id=? AND chain_id=? AND message_id=? AND status='cancelled'",
                          (child, root, root)).fetchone():
        return report(connection, row, "cancelled", root)
    questions = user_questions(connection, child, root)
    now = int(time.time())
    if question := next((q for q in questions if q["status"] == "waiting_user" and (not q["expires_at"] or q["expires_at"] > now)), None):
        return report(connection, row, "waiting_user", question["message_id"])
    if decision := decision_pending(connection, row):
        return report(connection, row, "waiting", decision["child_message_id"], decision["text"])
    if row["state"] in ("waiting", "waiting_user"):
        report(connection, row, "")
    if bind_user_decisions(connection, child, root, questions):
        return
    requests = connection.execute("""SELECT r.status,r.message_id,e.result FROM member_requests r
        LEFT JOIN member_executions e ON e.id=r.execution_id WHERE r.room_id=? AND r.chain_id=? ORDER BY r.id DESC""",
                                  (child, root)).fetchall()
    if any(request["status"] in ("pending", "delivering") for request in requests):
        return
    if answer := final_answer(connection, row):
        return report(connection, row, "completed", answer["id"], answer["summary"])
    for request in requests:
        if request["message_id"] != row["reminder_message_id"] and request["status"] in ("failed", "cancelled"):
            return report(connection, row, request["status"], request["message_id"], request["result"] or "")
    if row["reminder_message_id"]:
        return report(connection, row, "unreported", row["reminder_message_id"])
    if host := current_host(connection, child):
        remind_child(connection, row, host)
    else:
        report(connection, row, "unreported")


def reconcile_delegations(connection, room):
    """Reconcile tracked outcomes on the existing room mutation and runner inbox paths."""
    where = f" WHERE (s.room_id=? OR s.target_room_id=?) AND d.state IN {ACTIVE_STATES}"
    if connection.execute(DELEGATION_QUERY + where + " LIMIT 1", (room, room)).fetchone() is None:
        return
    begin_write(connection)
    for row in connection.execute(DELEGATION_QUERY + where, (room, room)).fetchall():
        evaluate(connection, row)


def legacy_work_result(connection, child, root):
    """Read a pre-tracking or existing-room relay's own outcome without creating a review or reminder."""
    if not root:
        return "", "", None
    now = int(time.time())
    for question in user_questions(connection, child, root):
        if question["status"] == "waiting_user" and (not question["expires_at"] or question["expires_at"] > now):
            return "waiting_user", "", question["message_id"]
    if connection.execute("SELECT 1 FROM member_requests WHERE room_id=? AND chain_id=? AND status IN ('pending','delivering')",
                          (child, root)).fetchone():
        return "", "", None
    if answer := final_answer(connection, {"child": child, "root": root}):
        return "completed", answer["summary"].strip()[:REPORT_LIMIT], answer["id"]
    failure = connection.execute("""SELECT r.status,r.message_id,e.result FROM member_requests r LEFT JOIN member_executions e ON e.id=r.execution_id
        WHERE r.room_id=? AND r.chain_id=? AND r.status IN ('failed','cancelled') ORDER BY r.id DESC LIMIT 1""", (child, root)).fetchone()
    if failure:
        return failure["status"], (failure["result"] or "").strip()[:REPORT_LIMIT], failure["message_id"]
    return "", "", None


def work_item(connection, row):
    """Format a latest dispatch and use its message times, not unrelated room activity."""
    keys = ("room_id", "title", "preset", "delegation_message_id", "state", "summary", "result_message_id")
    item = {key: row[key] for key in keys}
    item["archived"] = bool(row["archived"])
    result_at = row["result_at"]
    if item["state"] is None:
        item["state"], item["summary"], item["result_message_id"] = legacy_work_result(connection, row["room_id"], row["root"])
        if item["result_message_id"]:
            result = connection.execute("SELECT created_at FROM messages WHERE room_id=? AND id=?",
                                        (row["room_id"], item["result_message_id"])).fetchone()
            result_at = result["created_at"] if result else None
    item["updated_at"] = row["updated_at"] or result_at or row["received_at"] or row["sent_at"]
    return item


def steward_work(connection, room):
    """List one row per live or archived destination without reading or modifying the message feed."""
    rows = connection.execute(WORK_QUERY, {"parent": room}).fetchall()
    return {"items": [work_item(connection, row) for row in rows]}

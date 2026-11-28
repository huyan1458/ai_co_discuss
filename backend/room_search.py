"""Search the searchable fields of the SQLite transcript, not private or internal messages."""

from bisect import bisect_right
from contextlib import closing
from heapq import nsmallest
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
from threading import BoundedSemaphore

from .free_room import LAYOUT_AFTER_SQL, member_display_names
from .texts import Text


ROOM_LIMIT = 1000
GROUP_LIMIT = 50
SNIPPET_LEAD = 50
SNIPPET_LENGTH = 160
REGEX_SECONDS = 4
REGEX_SLOTS = BoundedSemaphore(2)
WORD_CHAR = re.compile(r"\w")

# Resolve the same request anchors for failed/retried work as the transcript does. Restrict
# the layout lookup to executions that actually matched a progress note or a failure.
EXECUTION_HITS = f"""
WITH executions AS MATERIALIZED (
    SELECT e.* FROM member_executions e
    WHERE e.room_id=:room AND (:cutoff IS NULL OR e.member_id=:reader)
), hits AS (
    SELECT n.execution_id,n.seq,n.text,n.created_at FROM executions e JOIN execution_notes n ON n.execution_id=e.id
        WHERE n.text REGEXP 1
    UNION ALL
    SELECT id,NULL,result,finished_at FROM executions WHERE status='failed' AND result<>'' AND result REGEXP 1
), layouts AS (
    SELECT e.id,e.created_at,m.name AS author,
        (SELECT MIN(message_id) FROM member_requests r WHERE r.execution_id=e.id
            OR r.id IN (SELECT request_id FROM retried_requests WHERE execution_id=e.id)) AS request_message_id,
        (SELECT MAX(answer_id) FROM member_requests r WHERE r.execution_id=e.id) AS answer_id,
        (SELECT MAX({LAYOUT_AFTER_SQL}) FROM member_requests r WHERE r.execution_id=e.id
            OR r.id IN (SELECT request_id FROM retried_requests WHERE execution_id=e.id)) AS layout_after
    FROM (SELECT DISTINCT execution_id FROM hits) h JOIN member_executions e ON e.id=h.execution_id
    JOIN room_members m ON m.id=e.member_id
)
SELECT l.*,h.seq,h.text,strftime('%Y-%m-%dT%H:%M:%SZ',h.created_at,'unixepoch') AS hit_at
FROM layouts l JOIN hits h ON h.execution_id=l.id
"""


class SearchPattern:
    """Compile the user's search options once for SQL filtering and snippet highlighting."""

    def __init__(self, params):
        self.query = params.get("q", "")
        self.regex = params.get("regex") == "1"
        self.word = params.get("word") == "1"
        flags = 0 if params.get("case") == "1" else re.IGNORECASE
        try:
            self.pattern = re.compile(self.query if self.regex else re.escape(self.query), flags)
        except (re.error, OverflowError, RecursionError) as error:
            raise ValueError(Text("正则表达式无效：{reason}", reason=str(error))) from error

    def spans(self, value):
        """Yield matching Python spans without crossing a Unicode word boundary."""
        for match in self.pattern.finditer(value):
            start, end = match.span()
            if self.word and ((start and WORD_CHAR.match(value, start - 1))
                              or WORD_CHAR.match(value, end)):
                continue
            yield start, end

    def matches(self, _operator, value):
        """Implement the SQLite REGEXP function for this request's compiled pattern."""
        return next(self.spans(value), None) is not None

    def number_hit(self, number):
        """Match the displayed #number, with exact bare numbers also accepted."""
        if self.regex:
            return self.matches(1, number)
        return self.query in (number, number[1:])


def snippet_ranges(text, spans):
    """Keep context around the first hit and give clipped half-open ranges in the snippet."""
    first, end = next(spans)
    left = max(0, first - SNIPPET_LEAD)
    right = left + SNIPPET_LENGTH
    lead = "…" if left else ""
    body = text[left:right]
    offsets = [len(lead)]
    for character in body:
        offsets.append(offsets[-1] + (2 if ord(character) > 0xFFFF else 1))
    ranges = [[offsets[first - left], offsets[min(end, right) - left]]]
    for start, end in spans:
        if start >= left + len(body):
            break
        ranges.append([offsets[start - left], offsets[min(end, right) - left]])
    return lead + body + ("…" if right < len(text) else ""), ranges


def message_rows(connection, room, cutoff, message_query):
    """Get layout metadata for allowed rows and body text only when it matches."""
    return {row["id"]: row for row in connection.execute(f"""
        SELECT id,author,created_at,execution_id,request_message_id,layout_after,layout_at,interjection_parent_id,withdrawn,
            CASE WHEN withdrawn='' AND text REGEXP 1 THEN text END AS hit,
            (SELECT s.sender_name FROM external_message_sources s WHERE s.message_id=transcript.id) AS sender_name
        FROM ({message_query}) transcript WHERE room_id=? AND (? IS NULL OR id<=?)
          AND NOT EXISTS(SELECT 1 FROM internal_task_messages task WHERE task.message_id=transcript.id)
          AND NOT EXISTS(SELECT 1 FROM free_host_wakes w WHERE w.room_id=transcript.room_id
                         AND w.message_id=transcript.id AND w.key LIKE 'host_failed:%')
        ORDER BY id
    """, (room, room, cutoff, cutoff))}


def previous_root(roots, after):
    """Return the latest root at or before placement, or zero before the first root."""
    index = bisect_right(roots, after)
    return roots[index - 1] if index else 0


def timeline_positions(messages):
    """Map visible transcript messages to their display order and top-level anchor."""
    withdrawn = {key for key, row in messages.items() if row["withdrawn"]}
    roots = [key for key, row in messages.items()
             if key in withdrawn or row["layout_after"] is None or row["request_message_id"] in withdrawn]
    root_ids = set(roots)
    positions = {}
    for key, row in messages.items():
        if key in root_ids:
            parent = row["interjection_parent_id"]
            positions[key] = ((parent if parent in root_ids else key, int(parent in root_ids), 0, 0, key), key)
        else:
            anchor = previous_root(roots, row["layout_after"])
            target = anchor if anchor and anchor not in withdrawn else key
            positions[key] = ((anchor, 2, row["layout_at"] or 0, row["execution_id"] or 0, key), target)
    return roots, positions


def message_hits(connection, room, messages, positions, pattern):
    """Yield matched message/number and posted attachment fields in timeline order."""
    for key, row in messages.items():
        if row["withdrawn"]:
            continue
        number = f"#{key}"
        text = row["hit"]
        by_number = text is None and pattern.number_hit(number)
        if text is not None or by_number:
            order, anchor = positions[key]
            yield (*order, 0, key), text if not by_number else number, by_number, {
                "kind": "message", "message_id": key, "anchor_message_id": anchor,
                "author": row["sender_name"] or row["author"], "created_at": row["created_at"]}
    for row in connection.execute("""SELECT id,message_id,file_name,position FROM attachments
                                     WHERE room_id=? AND message_id IS NOT NULL AND file_name REGEXP 1""", (room,)):
        message = messages.get(row["message_id"])
        if message is None or message["withdrawn"]:
            continue
        order, anchor = positions[message["id"]]
        yield (*order, 1, row["position"], row["id"]), row["file_name"], False, {
            "kind": "attachment", "message_id": message["id"], "anchor_message_id": anchor, "attachment_id": row["id"],
            "author": message["sender_name"] or message["author"], "created_at": message["created_at"]}


def execution_hits(connection, scope, layout):
    """Yield posted progress notes and failure reasons without exposing hidden request messages."""
    messages, roots, positions = layout
    readable_roots = [key for key in roots if not messages[key]["withdrawn"]]
    for row in connection.execute(EXECUTION_HITS, scope):
        request = messages.get(row["request_message_id"])
        if (request and request["withdrawn"]) or row["layout_after"] is None:
            continue
        if scope["cutoff"] is not None and row["layout_after"] > scope["cutoff"]:
            continue
        anchor = previous_root(roots, row["layout_after"])
        readable_anchor = previous_root(readable_roots, row["layout_after"])
        answer = messages.get(row["answer_id"])
        key = request["id"] if request else readable_anchor
        if not key:
            continue
        field = {"kind": "execution", "message_id": key, "execution_id": row["id"],
                 "anchor_message_id": readable_anchor or key, "author": row["author"],
                 "created_at": row["hit_at"] or messages[key]["created_at"]}
        if row["seq"] is not None:
            field["note_seq"] = row["seq"]
        order = (anchor, 2, row["created_at"], row["id"], 0)
        if answer and not answer["withdrawn"] and row["seq"] is not None:
            order, field["anchor_message_id"] = positions[answer["id"]]
            field["message_id"] = answer["id"]
        yield (*order, 2, row["seq"] or 0), row["text"], False, field


def search_transcript(connection, scope, pattern, message_query, limit):
    """Search one room, count all matching fields and return only the earliest matches."""
    connection.create_function("regexp", 2, pattern.matches, deterministic=True)
    room = scope["room"]
    messages = message_rows(connection, room, scope["cutoff"], message_query)
    roots, positions = timeline_positions(messages)
    total = 0

    def counted_hits():
        nonlocal total
        for hits in (message_hits(connection, room, messages, positions, pattern),
                     execution_hits(connection, scope, (messages, roots, positions))):
            for hit in hits:
                total += 1
                yield hit

    earliest = nsmallest(limit, counted_hits(), key=lambda item: item[0])
    names = member_display_names(connection, room) if earliest else {}
    matches = []
    for _, text, by_number, field in earliest:
        spans = iter([(0, len(text))]) if by_number and not pattern.regex else pattern.spans(text)
        snippet, ranges = snippet_ranges(text, spans)
        matches.append({**field, "author": names.get(field["author"], field["author"]),
                        "snippet": snippet, "ranges": ranges})
    return {"matches": matches, "total": total, "truncated": total > limit}


def search(connection, scopes, params, message_query, grouped):
    """Apply the same search and caps to a single room or a directory of authorized rooms."""
    pattern = SearchPattern(params)
    if not grouped:
        return (search_transcript(connection, scopes[0][1], pattern, message_query, ROOM_LIMIT)
                if pattern.query else {"matches": [], "total": 0, "truncated": False})
    rooms, total, truncated = [], 0, False
    for summary, scope in scopes if pattern.query else ():
        result = search_transcript(connection, scope, pattern, message_query, GROUP_LIMIT)
        if result["total"]:
            rooms.append({**summary, "matches": result["matches"], "total": result["total"]})
            total += result["total"]
            truncated |= result["truncated"]
    return {"rooms": rooms, "total": total, "truncated": truncated}


def run_search(connection, database, scopes, options):
    """Run regular expressions outside the server process so a slow pattern can be stopped."""
    params, message_query, grouped = options
    if params.get("regex") != "1" or not params.get("q"):
        return search(connection, scopes, params, message_query, grouped)
    SearchPattern(params)  # Return syntax errors before starting a worker.
    if not REGEX_SLOTS.acquire(blocking=False):
        raise ValueError(Text("正则搜索正在处理其他请求，请稍后重试"))
    try:
        result = subprocess.run(
            [sys.executable, "-m", "backend.room_search"],
            input=json.dumps([str(Path(database).resolve()), scopes, params, message_query, grouped]),
            encoding="utf-8", capture_output=True, check=True, timeout=REGEX_SECONDS,
            cwd=Path(__file__).resolve().parent.parent,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        return json.loads(result.stdout)
    except subprocess.TimeoutExpired as error:
        raise ValueError(Text("正则搜索超时，请缩小范围或简化表达式")) from error
    finally:
        REGEX_SLOTS.release()


if __name__ == "__main__":
    database, scopes, params, message_query, grouped = json.load(sys.stdin)
    with closing(sqlite3.connect(Path(database).resolve().as_uri() + "?mode=ro", uri=True)) as db:
        db.row_factory = sqlite3.Row
        db.execute("BEGIN")
        print(json.dumps(search(db, scopes, params, message_query, grouped)))

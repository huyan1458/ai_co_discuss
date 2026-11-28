"""Rule-based “needs your attention” list for the analytics page, with the runs behind each item.

Every issue is a fact with its count, the same count for the previous period and the executions that make it up, so
the page can say what happened and let the owner open each run. Rules only describe what was observed; they never
recommend switching a model, since different models and efforts take on different work. No model is called.

Runs that did not finish are grouped by their reason, not by model (2026-11-27, Fable #14109): one runner fault that
hit several models is one issue, not one alert per model. Rarer, unchanged problems are left out, and only a high share
or a clear rise is marked as serious, so a page where 97% of the work went fine does not read as an emergency.
"""
import json
import os
import re
from collections import Counter, defaultdict
from itertools import islice
from pathlib import Path

USER_STOPS = ("用户打断", "用户停止全部")
HOST_STOP = "主持人"
REASON_CHARS = 60
MIN_COUNT = 3
UNKNOWN_MODEL_MIN = 10
RUNS_PER_ISSUE = 30
MEMBERS_PER_ISSUE = 4
# An issue is listed when it touches at least this share of the related runs, or clearly rose against last period.
LIST_SHARE = 0.05
# It is marked serious from this share, or when it at least doubled by a meaningful margin.
SERIOUS_SHARE = 0.10
RISE_FACTOR = 2
RISE_MIN = 5
# Ordering weight per occurrence: unfinished work costs more than a stop the owner chose; bookkeeping sinks.
WEIGHTS = {"not_finished": 3, "late_recovery": 2, "permission": 2, "interrupted": 2, "scheduler": 1, "unknown_model": 0.2}
LEVELS = {"high": 0, "normal": 1, "info": 2}
STALL_IDLE_SECONDS = 30 * 60
STALL_MAX_IDLE_SECONDS = 24 * 60 * 60
STALL_RESUME_SECONDS = 5 * 60
STALL_EXCERPT_CHARS = 120
STALL_EXCERPT_LINES = 3
# An ASCII question mark introducing a URL query is not sentence punctuation.
STALL_QUESTION = re.compile(r"？|\?(?![A-Za-z0-9_=/&%])")

# A user returning after a bounded gap. The preceding message must be a host answer and another dispatch must follow.
SUSPECTED_STALLS = """
    WITH replies AS (
        SELECT m.id,m.room_id,m.text,CAST(strftime('%s',m.created_at) AS INTEGER) AS stamp FROM messages m
        JOIN room_directory d ON d.room_id=m.room_id AND d.system_kind=''
        WHERE m.source='user' AND stamp>=? AND stamp<?
            AND NOT EXISTS (SELECT 1 FROM message_withdrawals w WHERE w.message_id=m.id)
            AND NOT EXISTS (SELECT 1 FROM message_relays relay WHERE relay.message_id=m.id)
    ), gaps AS (
        SELECT r.room_id,h.id AS message_id,r.id AS reply_message_id,h.text AS excerpt,r.text AS reply,'' AS end_reason,
               CAST(strftime('%s',h.created_at) AS INTEGER) AS start,r.stamp AS end
        FROM replies r JOIN messages h ON h.id=(SELECT max(p.id) FROM messages p WHERE p.room_id=r.room_id AND p.id<r.id)
        JOIN room_members host ON host.room_id=h.room_id AND host.name=h.author AND host.role='host'
        WHERE r.stamp-start>? AND r.stamp-start<=? AND start>=? AND start<?
          AND EXISTS (SELECT 1 FROM member_requests answered WHERE answered.answer_id=h.id AND answered.member_id=host.id)
          AND NOT EXISTS (SELECT 1 FROM message_withdrawals w WHERE w.message_id=h.id)
          AND EXISTS (SELECT 1 FROM member_requests q WHERE q.room_id=r.room_id AND q.created_by='host'
              AND q.purpose='ask' AND q.message_id>r.id AND q.created_at BETWEEN r.stamp AND r.stamp+?
              AND NOT EXISTS (SELECT 1 FROM message_withdrawals w WHERE w.message_id=q.message_id))
    )
    SELECT g.*,rooms.title,s.text AS summary FROM gaps g JOIN rooms ON rooms.id=g.room_id
    LEFT JOIN message_summaries s ON s.message_id=g.message_id
    WHERE NOT EXISTS (SELECT 1 FROM room_waits w
          WHERE w.room_id=g.room_id AND w.created_at<g.end AND (w.ended_at=0 OR w.ended_at>g.start))
      AND NOT EXISTS (
          SELECT 1 FROM member_requests q
          LEFT JOIN messages a ON a.id=q.answer_id
          LEFT JOIN member_executions e ON e.id=q.execution_id
          WHERE q.room_id=g.room_id AND q.created_at<g.end AND (
              q.created_at>g.start OR q.status IN ('pending','delivering') OR
              coalesce(CAST(strftime('%s',a.created_at) AS INTEGER),
                  (SELECT max(v.at)/1000 FROM room_events v WHERE v.room_id=q.room_id AND v.kind='request.changed'
                   AND json_extract(v.data,'$.request_id')=q.id AND json_extract(v.data,'$.status') IN
                       ('completed','failed','cancelled')),nullif(e.finished_at,0),g.end)>g.start))
"""


def stall_notification_times():
    """Index successful wait receipts by room and wait ID after validating the scoped key."""
    home = os.getenv("DISCUSS_SERVICE_HOME")
    if not home:
        return {}
    try:
        store = json.loads((Path(home) / "notify" / "notices.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    notices = store.get("notices", []) if isinstance(store, dict) else []
    if not isinstance(notices, list):
        return {}
    receipts = defaultdict(list)
    for row in notices:
        if not isinstance(row, dict) or not row.get("deliveries") or not isinstance(row.get("sent_at"), int):
            continue
        site, room, key = row.get("site"), row.get("room"), row.get("key")
        if not site or not room or not all(isinstance(value, str) for value in (site, room, key)):
            continue
        prefix = f"{site}/{room}/wait:"
        if key.startswith(prefix):
            receipts[room, key[len(prefix):]].append(row["sent_at"] // 1000)
    return receipts


def stall_excerpt(value, lines=1):
    """Return up to the given number of non-empty lines as a short excerpt."""
    nonempty = (line.strip() for line in (value or "").splitlines() if line.strip())
    return " ".join(islice(nonempty, lines))[:STALL_EXCERPT_CHARS]


def recorded_stall_events(connection, start, end):
    """Follow replacements within a member's wait; report the entire chain in its starting period."""
    if start >= end:
        return
    rows = connection.execute("""SELECT w.id AS wait_id,w.room_id,w.created_at AS start,w.ended_at AS end,w.message_id,
               w.end_reason,CASE WHEN w.end_reason='user' THEN w.end_message_id ELSE 0 END AS reply_message_id,
               h.text AS excerpt,s.text AS summary,r.text AS reply,rooms.title,
               CASE WHEN w.end_reason='superseded' THEN (
                   SELECT min(m.id) FROM messages m JOIN message_details d ON d.message_id=m.id AND d.kind='chat'
                   WHERE m.room_id=w.room_id AND m.author=h.author AND m.id>w.message_id
               ) END AS replaced_by
        FROM room_waits w JOIN room_directory d ON d.room_id=w.room_id AND d.system_kind=''
        JOIN rooms ON rooms.id=w.room_id JOIN messages h ON h.id=w.message_id
        LEFT JOIN message_summaries s ON s.message_id=w.message_id
        LEFT JOIN messages r ON r.id=w.end_message_id AND w.end_reason='user'
        ORDER BY w.room_id,w.member_id,w.id""")
    event, replaced_by = None, None
    for stored in rows:
        row = dict(stored)
        replacement = row.pop("replaced_by")
        window = (str(row.pop("wait_id")), row["start"], row["end"])
        if event and replaced_by == row["message_id"] and event["end"] == row["start"]:
            event.update({key: row[key] for key in ("end", "end_reason", "reply_message_id", "reply")})
            event["wait_windows"].append(window)
        else:
            if event and start <= event["start"] < end:
                yield event
            event = {**row, "wait_windows": [window]}
        replaced_by = replacement
    if event and start <= event["start"] < end:
        yield event


def stall_events(connection, start, end, now):
    """Yield recorded waits and historical gaps beginning in the selected period."""
    if start >= end:
        return
    for row in recorded_stall_events(connection, start, end):
        yield row, False
    # The reply can fall outside the selected period. Search from the beginning of the period so a cross-midnight
    # wait still shows its actual end and belongs to only the period in which it began.
    reply_before = min(now + 1, end + STALL_MAX_IDLE_SECONDS)
    params = (start, reply_before, STALL_IDLE_SECONDS, STALL_MAX_IDLE_SECONDS, start, end, STALL_RESUME_SECONDS)
    for row in connection.execute(SUSPECTED_STALLS, params):
        if STALL_QUESTION.search(row["excerpt"]):
            yield dict(row), True


def stall_issue(connection, bounds, now):
    """Summarize waits independently of the number of runs, including the 30 longest events."""
    previous, start, end = bounds
    receipts = stall_notification_times()
    events = []
    for row, suspected in stall_events(connection, start, end, now):
        windows = row.pop("wait_windows", ())
        summary = (row.pop("summary") or "").strip()
        until = row["end"] or now
        events.append({**row, "seconds": max(0, until - row["start"]), "suspected": suspected,
                       "notified": any(left <= sent_at <= (right or now) for wait_id, left, right in windows
                                       for sent_at in receipts.get((row["room_id"], wait_id), ())),
                       "excerpt": stall_excerpt(summary or row["excerpt"], STALL_EXCERPT_LINES),
                       "reply": stall_excerpt(row["reply"])})
    if not events:
        return None
    events.sort(key=lambda row: (-row["seconds"], -row["start"], -row["message_id"]))
    suspected_count = sum(row["suspected"] for row in events)
    # Keep confirmed waits selectable in the UI even if many longer suspected waits fill the list.
    displayed_ids = {row["message_id"] for row in sorted(events, key=lambda row: row["suspected"])[:RUNS_PER_ISSUE]}
    return {"rule": "stall", "params": {}, "level": "normal", "count": len(events) - suspected_count,
            "suspected_count": suspected_count,
            "previous": sum(1 for _ in recorded_stall_events(connection, previous, start)), "total": None,
            "score": len(events), "members": [], "runs": [], "first_at": min(row["start"] for row in events),
            "last_at": max(row["start"] for row in events), "events": [row for row in events if row["message_id"] in displayed_ids]}


def group_of(row):
    """Software, model and effort of a run: the unit the owner configures."""
    return row["adapter"], row["model"] or "", row["effort"] or ""


def user_stopped(row):
    return row["status"] == "cancelled" and row["result"] in USER_STOPS


def not_finished(row):
    """A run that ended without a result for reasons other than the owner or the host deciding to stop it."""
    if row["status"] == "failed":
        return True
    # A host stopping a member is the host's decision about the work, not something that went wrong with the member.
    return row["status"] == "cancelled" and not user_stopped(row) and not (row["result"] or "").startswith(HOST_STOP)


def reason_of(row):
    """The first sentence of a run's result, short enough to count alike failures together."""
    text = (row["result"] or "").strip()
    if not text or text.startswith("message:"):
        return ""
    for mark in ("。", "；", ". ", "\n"):
        text = text.split(mark)[0]
    return text[:REASON_CHARS]


def classify(row, revived):
    """Yield (rule, key, params) for every issue rule one execution row contributes to."""
    adapter, model, effort = group_of(row)
    member = {"adapter": adapter, "model": model, "effort": effort}
    if not_finished(row):
        failure = row["failure_class"] or ""
        reason = "" if failure else reason_of(row)
        yield "not_finished", ("not_finished", failure, reason), {"failure_class": failure, "reason": reason}
    if user_stopped(row):
        yield "interrupted", ("interrupted",) + group_of(row), member
    if row["denied"]:
        yield "permission", ("permission",) + group_of(row), member
    if row["id"] in revived and row["status"] == "completed":
        yield "late_recovery", ("late_recovery",) + group_of(row), member
    if not model:
        yield "unknown_model", ("unknown_model", adapter), {"adapter": adapter}


def collect(rows, revived):
    """Group execution rows by issue key: {key: (rule, params, [rows])}."""
    found = {}
    for row in rows:
        for rule, key, params in classify(row, revived):
            found.setdefault(key, (rule, params, []))[2].append(row)
    return found


def scheduler_counts(connection, start, end):
    """Negative smart-scheduling ratings per room in [start, end)."""
    return {room: bad for room, bad in connection.execute("""SELECT d.room_id,sum(f.rating='bad')
        FROM scheduler_feedback f JOIN scheduler_decisions d ON d.id=f.decision_id
        WHERE CAST(strftime('%s',f.created_at) AS INTEGER)>=? AND CAST(strftime('%s',f.created_at) AS INTEGER)<?
        GROUP BY d.room_id""", (start, end)) if bad}


def run_details(connection, rows):
    """The newest runs of one issue with their room title and the message that asked for them."""
    rows = sorted(rows, key=lambda row: row["created_at"], reverse=True)[:RUNS_PER_ISSUE]
    ids = [row["id"] for row in rows]
    asked, titles = {}, {}
    if ids:
        marks = ",".join("?" * len(ids))
        for execution_id, message_id in connection.execute(
                f"SELECT execution_id,min(message_id) FROM member_requests WHERE execution_id IN ({marks}) GROUP BY execution_id", ids):
            asked[execution_id] = message_id
        rooms = sorted({row["room_id"] for row in rows})
        marks = ",".join("?" * len(rooms))
        titles = dict(connection.execute(f"SELECT id,title FROM rooms WHERE id IN ({marks})", rooms))
    return [{"execution_id": row["id"], "room_id": row["room_id"], "title": titles.get(row["room_id"], ""),
             "member": row["name"], "label": row["label"], "created_at": row["created_at"], "status": row["status"],
             "result": (row["result"] or "")[:120], "failure_class": row["failure_class"] or "",
             "message_id": asked.get(row["id"])} for row in rows]


def judge(count, previous, total, rule):
    """(listed, level) for one issue: share of the related runs and the change against last period decide both."""
    share = count / total if total else 0
    rose = previous > 0 and count >= RISE_FACTOR * previous and count - previous >= RISE_MIN
    if rule == "unknown_model":
        return share >= LIST_SHARE, "info"
    if share < LIST_SHARE and not rose:
        return False, None
    return True, "high" if share >= SERIOUS_SHARE or rose else "normal"


def issues(connection, current, earlier, revived, timing):
    """Issues of the period, serious ones first, each with its previous-period count, affected members and runs.

    `current` and `earlier` are execution rows created in this period and in the previous one; `bounds` holds the
    timestamps (previous, start, end, now) used for scheduler ratings and room waits.
    """
    previous, start, end, now = timing
    now_found, before_found = collect(current, revived), collect(earlier, revived)
    by_group, by_adapter = Counter(group_of(row) for row in current), Counter(row["adapter"] for row in current)
    result = []
    for key, (rule, params, rows) in now_found.items():
        threshold = UNKNOWN_MODEL_MIN if rule == "unknown_model" else MIN_COUNT
        if len(rows) < threshold:
            continue
        before = len(before_found.get(key, (None, None, []))[2])
        groups = Counter(group_of(row) for row in rows)
        if rule == "not_finished":
            # Related runs are all runs of the members this reason touched, so a fault confined to one model is
            # measured against that model's work rather than the whole team's.
            total = sum(by_group[group] for group in groups)
        elif "model" in params:
            total = by_group[params["adapter"], params["model"], params["effort"]]
        else:
            total = by_adapter[params["adapter"]]
        listed, level = judge(len(rows), before, total, rule)
        if not listed:
            continue
        members = [{"adapter": adapter, "model": model, "effort": effort, "count": count}
                   for (adapter, model, effort), count in groups.most_common(MEMBERS_PER_ISSUE)]
        result.append({"rule": rule, "params": params, "level": level, "count": len(rows), "previous": before,
                       "total": total, "score": WEIGHTS[rule] * len(rows), "members": members,
                       "first_at": min(row["created_at"] for row in rows), "last_at": max(row["created_at"] for row in rows),
                       "runs": run_details(connection, rows)})
    earlier_bad = scheduler_counts(connection, previous, start)
    for room, bad in scheduler_counts(connection, start, end).items():
        if bad >= MIN_COUNT:
            title = connection.execute("SELECT title FROM rooms WHERE id=?", (room,)).fetchone()
            result.append({"rule": "scheduler", "params": {"room_id": room, "title": title[0] if title else ""},
                           "level": "normal", "count": bad, "previous": earlier_bad.get(room, 0), "total": None,
                           "score": WEIGHTS["scheduler"] * bad, "members": [], "first_at": None, "last_at": None,
                           "runs": []})
    stall = stall_issue(connection, (previous, start, end), now)
    if stall:
        result.append(stall)
    return sorted(result, key=lambda item: (LEVELS[item["level"]], -item["score"], item["rule"]))


def series_step(start, end):
    """Bucket length for the period's timelines: an hour up to eight days, six hours up to a month, then a day."""
    length = max(1, end - start)
    return 3600 if length <= 8 * 86400 else 6 * 3600 if length <= 32 * 86400 else 86400


def concurrency_series(spans, start, end, step=None):
    """Most experts running at once in each time step of [start, end), for the page's and share card's timeline.

    Each expert's overlapping runs are merged first, exactly like the peak figure, so the series' maximum equals
    `peak.members`. `step` overrides the period's bucket length (the live view counts per minute).
    """
    step = step or series_step(start, end)
    buckets = [0] * -(-max(1, end - start) // step)
    events = defaultdict(int)
    for intervals in spans.values():
        merged = []
        for left, right in sorted(intervals):
            if merged and left <= merged[-1][1]:
                merged[-1][1] = max(merged[-1][1], right)
            else:
                merged.append([left, right])
        for left, right in merged:
            events[left] += 1
            events[right] -= 1
    running, cursor = 0, start
    for stamp in sorted(events):
        # The count held from `cursor` to `stamp` lights every bucket it touches.
        if running and stamp > cursor:
            for index in range((cursor - start) // step, min(len(buckets), -(-(stamp - start) // step))):
                buckets[index] = max(buckets[index], running)
        running += events[stamp]
        cursor = stamp
    return {"step": step, "points": buckets}


BUCKET_ROOMS = 8


def bucket_rooms(spans, start, end, step):
    """Which rooms ran in each time step and with which members, for the timeline's hover panel (#15959).

    `spans` is keyed by (room_id, member) like the concurrency series; each step lists at most BUCKET_ROOMS rooms, the
    ones with the most members first, plus `more` when others were cut."""
    buckets = [defaultdict(set) for _ in range(-(-max(1, end - start) // step))]
    for (room_id, member), intervals in spans.items():
        for left, right in intervals:
            first, last = (max(start, left) - start) // step, (min(end, right) - 1 - start) // step
            for index in range(max(0, first), min(len(buckets) - 1, last) + 1):
                buckets[index][room_id].add(member)
    result = []
    for rooms in buckets:
        ordered = sorted(rooms.items(), key=lambda item: (-len(item[1]), item[0]))
        result.append({"rooms": [{"room_id": room_id, "members": sorted(members)} for room_id, members in ordered[:BUCKET_ROOMS]],
                       "more": max(0, len(ordered) - BUCKET_ROOMS)})
    return result


def unfinished_series(rows, start, end, step=None):
    """Runs that did not finish, per time step of [start, end) by when they started: the red marks on the timeline."""
    step = step or series_step(start, end)
    buckets = [0] * -(-max(1, end - start) // step)
    for row in rows:
        if not_finished(row) and start <= row["created_at"] < end:
            buckets[(row["created_at"] - start) // step] += 1
    return buckets

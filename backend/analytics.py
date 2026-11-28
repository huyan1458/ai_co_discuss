"""Owner-only weekly reports over the current rooms of one Python site."""
import hashlib
import json
import subprocess
from bisect import bisect_right
from collections import Counter, defaultdict
from datetime import date, datetime, time, timedelta, timezone
from functools import lru_cache
from math import floor
from time import monotonic
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .analytics_dispatch import dispatch_quality
from .analytics_live import live_snapshot
from .moss_results import DELEGATED_SENDS
from .analytics_issues import concurrency_series, issues as attention_issues, unfinished_series
from .texts import Text

CACHE_SECONDS = 60
CACHE_ENTRIES = 32


# A standard Windows Python installation may have no IANA database. Node ships ICU.
NODE_CALENDAR = """
const [zone, ...dates] = process.argv.slice(1);
const calendar = new Intl.DateTimeFormat('en-CA', {timeZone: zone, year:'numeric', month:'2-digit', day:'2-digit'});
process.env.TZ = calendar.resolvedOptions().timeZone;
const result = dates.length === 1 && !dates[0].includes("-", 1) ? calendar.format(new Date(Number(dates[0]) * 60000)) :
    dates.map(day => new Date(day + 'T00:00:00').getTime() / 1000);
process.stdout.write(JSON.stringify(result));
"""


@lru_cache(maxsize=128)
def node_calendar(zone, *dates):
    """Use bundled ICU when the host Python has no timezone files."""
    try:
        run = subprocess.run(["node", "-e", NODE_CALENDAR, "--", zone, *dates], capture_output=True,
                             text=True, timeout=5, check=True)
        return json.loads(run.stdout)
    except (OSError, subprocess.SubprocessError, ValueError):
        raise ValueError(Text("统计日期范围或时区无效")) from None


def report_zone(name):
    """Resolve the requested zone, falling back to ICU only when Python lacks a zone database."""
    if name == "UTC":
        return timezone.utc
    try:
        return ZoneInfo(name)
    except ZoneInfoNotFoundError:
        try:
            ZoneInfo("Etc/UTC")
        except ZoneInfoNotFoundError:
            return None
        raise


ROLLING_DAYS = {"today": 1, "7d": 7, "30d": 30}


def period(params, now, earliest=None):
    """Return local calendar boundaries and their UTC timestamps.

    `today`, `7d` and `30d` end tomorrow and compare with the same number of days before; `all` starts on the local
    date of `earliest` (the oldest recorded activity, Unix seconds) and has an empty previous period.
    """
    name = params.get("tz", "UTC")
    try:
        zone = report_zone(name)
        today = (datetime.fromtimestamp(now, zone).date() if zone is not None
                 else date.fromisoformat(node_calendar(name, str(int(now)//60))))
        mode = params.get("range", "7d")
        if mode not in ("week", "month", "all", *ROLLING_DAYS):
            raise ValueError
        if "from" in params or "to" in params:
            start, end = (date.fromisoformat(params[key]) for key in ("from", "to"))
            previous = start - (end - start)
            if start.day == end.day == 1 and (end - start).days <= 31:
                previous = (start - timedelta(days=1)).replace(day=1)
        elif mode in ROLLING_DAYS:
            end = today + timedelta(days=1)
            start = end - timedelta(days=ROLLING_DAYS[mode])
            previous = start - timedelta(days=ROLLING_DAYS[mode])
        elif mode == "all":
            end = today + timedelta(days=1)
            first = (datetime.fromtimestamp(earliest, zone).date() if zone is not None and earliest
                     else date.fromisoformat(node_calendar(name, str(int(earliest) // 60))) if earliest else today)
            start = previous = min(first, today)
        elif mode == "month":
            start = today.replace(day=1)
            end = (start + timedelta(days=32)).replace(day=1)
            previous = (start - timedelta(days=1)).replace(day=1)
        else:
            start = today - timedelta(days=today.weekday())
            end, previous = start + timedelta(days=7), start - timedelta(days=7)
        if end <= start:
            raise ValueError
        days = (previous, start, end)
        stamps = (tuple(int(datetime.combine(day, time.min, zone).timestamp()) for day in days)
                  if zone is not None else tuple(node_calendar(name, *map(str, days))))
        return {"tz": name, "from": str(start), "to": str(end), "previous_from": str(previous),
                "previous_to": str(start)}, stamps
    except (KeyError, OverflowError, ValueError, ZoneInfoNotFoundError):
        raise ValueError(Text("统计日期范围或时区无效")) from None


def distribution(values, histogram=None):
    """Combine exact observations with weighted anonymous bucket midpoints."""
    counts = Counter(values)
    for bucket, count in (histogram or {}).items():
        low = int(bucket)
        midpoint = (3 * low - 1) / 2 if low else 0
        counts[midpoint] += count
    ordered = sorted(counts.items())
    total = sum(counts.values())

    def sample(rank):
        for seconds, weight in ordered:
            if rank < weight:
                return seconds
            rank -= weight

    def quantile(fraction):
        if not total:
            return None
        index = (total - 1) * fraction
        low = floor(index)
        first = sample(low)
        return round(first + (sample(min(low + 1, total - 1)) - first) * (index - low), 2)

    return {"p50": quantile(.5), "p90": quantile(.9), "samples": total, "approximate": bool(histogram)}


REQUESTS = """
WITH prior AS (SELECT rr.request_id,min(e.created_at) AS dispatched
    FROM retried_requests rr JOIN member_executions e ON e.id=rr.execution_id GROUP BY rr.request_id)
SELECT r.room_id,r.message_id,r.chain_id,r.created_at,r.status,mbr.name,mbr.adapter,
       coalesce(l.label,mbr.name) AS label,coalesce(e.model,'') AS model,coalesce(e.effort,'') AS effort,
       (m.author='用户' AND NOT EXISTS(SELECT 1 FROM message_relays l WHERE l.message_id=m.id)
         AND NOT EXISTS(SELECT 1 FROM internal_task_messages i WHERE i.message_id=m.id)) AS initiated,
       CAST(strftime('%s',m.created_at) AS INTEGER) AS sent,CAST(strftime('%s',a.created_at) AS INTEGER) AS answered,
       coalesce(w.kind,aw.kind) AS withdrawal,e.result,c.reason,coalesce(prior.dispatched,e.created_at) AS dispatched,
       CASE WHEN c.reason='user_stop' AND e.id IS NULL THEN EXISTS(
         SELECT 1 FROM room_events stop JOIN room_events cancelled ON cancelled.room_id=stop.room_id
           AND cancelled.kind='request.cancel_reason'
           AND cancelled.at BETWEEN stop.at AND stop.at+json_extract(stop.data,'$.elapsed_ms')+1
         WHERE stop.room_id=r.room_id AND stop.kind='api.write' AND json_extract(stop.data,'$.path')='/stop'
           AND json_extract(cancelled.data,'$.request_id')=r.id) END AS stopped_pending
FROM member_requests r LEFT JOIN prior ON prior.request_id=r.id JOIN messages m ON m.id=r.message_id
JOIN room_directory d ON d.room_id=r.room_id AND d.system_kind=''
JOIN room_members mbr ON mbr.id=r.member_id LEFT JOIN member_labels l ON l.room_id=r.room_id AND l.name=mbr.name
LEFT JOIN messages a ON a.id=r.answer_id LEFT JOIN member_executions e ON e.id=r.execution_id
LEFT JOIN request_cancel_reasons c ON c.request_id=r.id
LEFT JOIN message_withdrawals w ON w.message_id=m.id LEFT JOIN message_withdrawals aw ON aw.message_id=a.id
"""


def user_stopped(row):
    """Separate owner interventions from host cancellations and send-now follow-ups."""
    return row["reason"] == "user_stop" and (row["stopped_pending"] or row["result"] in ("用户打断", "用户停止全部", "用户回退了对话"))


def overview_facts(rows):
    """Yield additive facts with their original message or chain cohort timestamp."""
    messages, chains = defaultdict(list), defaultdict(list)
    for row in rows:
        if row["initiated"]:
            messages[row["message_id"]].append(row)
        chains[row["room_id"], row["chain_id"] or row["message_id"]].append(row)
    for group in messages.values():
        sent = group[0]["sent"]
        yield sent, "initiated", 1
        if any(row["answered"] is not None for row in group):
            yield sent, "answered", 1
    for group in chains.values():
        if any(r["status"] in ("pending", "delivering") for r in group):
            continue
        first = min(row["created_at"] for row in group)
        yield first, "ended", 1
        if not any(r["withdrawal"] or user_stopped(r) for r in group):
            yield first, "unassisted", 1
        answers = [r["answered"] for r in group if r["answered"] is not None]
        if answers and all(r["status"] == "completed" for r in group):
            yield first, "delivery", max(0, max(answers) - first)


def overview(facts, start, end, sealed):
    counts, histograms = sealed
    result = {key: counts[key] for key in ("initiated", "answered", "ended", "unassisted")}
    durations = []
    for stamp, key, value in facts:
        if start <= stamp < end:
            if key == "delivery":
                durations.append(value)
            else:
                result[key] += value
    delivery = distribution(durations, histograms["delivery"])
    return {**result, "delivery": delivery, "coverage": {"numerator": delivery["samples"], "denominator": result["ended"]}}


def peak_concurrent(intervals):
    """Union each key's intervals, then return the most keys active at once and the first moment it happened."""
    events = Counter()
    for spans in intervals.values():
        merged = []
        for start, end in sorted(spans):
            if merged and start <= merged[-1][1]:
                merged[-1][1] = max(merged[-1][1], end)
            else:
                merged.append([start, end])
        for start, end in merged:
            events[start] += 1
            events[end] -= 1
    count = peak = 0
    at = None
    for stamp, change in sorted(events.items()):
        count += change
        if count > peak:
            peak, at = count, stamp
    return peak, at


EXECUTIONS = """
WITH attempts AS (
    SELECT request_id,execution_id FROM retried_requests
    UNION ALL SELECT id,execution_id FROM member_requests WHERE execution_id IS NOT NULL
), failed_attempts AS (
    SELECT rr.request_id,min(rr.execution_id) AS first_failed FROM retried_requests rr
    JOIN member_executions e ON e.id=rr.execution_id WHERE e.status='failed' GROUP BY rr.request_id
), rework AS (
    SELECT DISTINCT a.execution_id FROM attempts a JOIN failed_attempts f ON f.request_id=a.request_id
    WHERE a.execution_id>f.first_failed
)
SELECT e.id,e.room_id,e.created_at,e.finished_at,e.status,e.result,e.model,e.effort,m.name,m.adapter,
 coalesce(l.label,m.name) AS label,f.failure_class,
 EXISTS(SELECT 1 FROM execution_denials d WHERE d.execution_id=e.id AND d.denials NOT IN ('','[]','{}')) AS denied,
 (e.status='failed' AND EXISTS(SELECT 1 FROM retried_requests rr WHERE rr.execution_id=e.id)) AS retried,
 (rework.execution_id IS NOT NULL) AS rework
FROM member_executions e LEFT JOIN rework ON rework.execution_id=e.id JOIN room_members m ON m.id=e.member_id
JOIN room_directory d ON d.room_id=e.room_id AND d.system_kind=''
LEFT JOIN member_labels l ON l.room_id=e.room_id AND l.name=m.name
LEFT JOIN execution_failures f ON f.execution_id=e.id
WHERE e.created_at<? AND (e.created_at>=? OR e.finished_at>=? OR e.finished_at=0)
"""


def member_stats(rows, requests, revived, by_model=False):
    """Aggregate the underlying requests and executions, including pooled model duration samples."""
    groups = {}
    identity = ("adapter", "model", "effort") if by_model else ("room_id", "name", "adapter", "model", "effort")

    def bucket(row):
        key = tuple(row[field] for field in identity)
        if key not in groups:
            item = {field: row[field] for field in ("adapter", "model", "effort")}
            if not by_model:
                item.update(room_id=row["room_id"], member=row["name"], label=row["label"])
            item.update(accepted=0, executions=0, completed=0, failed=0, cancelled=0, interrupted=0,
                        retries=0, denied=0, revived=0, failures=Counter(), durations=[])
            groups[key] = item
        return groups[key]

    for row in requests:
        bucket(row)["accepted"] += 1
    for r in rows:
        item = bucket(r)
        item["executions"] += 1
        if r["status"] in ("completed", "failed", "cancelled"):
            item[r["status"]] += 1
        if r["failure_class"] and r["status"] == "failed":
            item["failures"][r["failure_class"]] += 1
        item["interrupted"] += r["status"] == "cancelled" and r["result"] in ("用户打断", "用户停止全部")
        item["retries"] += r["retried"]
        item["denied"] += r["denied"]
        item["revived"] += r["id"] in revived and r["status"] == "completed"
        if r["finished_at"] >= r["created_at"] and r["finished_at"]:
            item["durations"].append(r["finished_at"] - r["created_at"])
    for item in groups.values():
        item["duration"] = distribution(item.pop("durations"))
    return list(groups.values())


def workflow_stats(connection, rows):
    """Executions run under a room workflow, grouped by workflow ID (current rooms only).

    The runner reports each delivery's workflow binding into the execution's diagnostics; an execution that reported
    several keeps its last one. Card and sub-workflow counts say which parts of the workflow actually ran.
    """
    ids = [r["id"] for r in rows]
    bound = {}
    for offset in range(0, len(ids), 500):
        chunk = ids[offset:offset + 500]
        marks = ",".join("?" * len(chunk))
        for execution_id, details in connection.execute(
                f"SELECT execution_id,details FROM execution_diagnostics WHERE execution_id IN ({marks})", chunk):
            try:
                bindings = [item for item in json.loads(details).get("workflow_bindings") or [] if item]
            except (TypeError, ValueError, AttributeError):
                continue
            if bindings:
                bound[execution_id] = bindings[-1]
    groups = {}
    for r in rows:
        binding = bound.get(r["id"])
        if not binding:
            continue
        item = groups.setdefault(binding["id"], dict(id=binding["id"], executions=0, completed=0, failed=0, cancelled=0,
                                                     interrupted=0, rooms=set(), cards=Counter(), sub_workflows=Counter(),
                                                     durations=[]))
        item["executions"] += 1
        if r["status"] in ("completed", "failed", "cancelled"):
            item[r["status"]] += 1
        item["interrupted"] += r["status"] == "cancelled" and r["result"] in ("用户打断", "用户停止全部")
        item["rooms"].add(r["room_id"])
        if binding.get("card"):
            item["cards"][binding["card"]] += 1
        if binding.get("sub_workflow"):
            item["sub_workflows"][binding["sub_workflow"]] += 1
        if r["finished_at"] >= r["created_at"] and r["finished_at"]:
            item["durations"].append(r["finished_at"] - r["created_at"])
    result = []
    for item in groups.values():
        item["rooms"] = len(item["rooms"])
        item["cards"], item["sub_workflows"] = dict(item["cards"]), dict(item["sub_workflows"])
        item["duration"] = distribution(item.pop("durations"))
        result.append(item)
    return sorted(result, key=lambda item: (-item["executions"], item["id"]))


def insights(connection, members, start, end):
    """Return observed counts with denominators and drill-down keys."""
    result = []
    def add(rule, count, total, params, target):
        if count >= 3 and total >= 10:
            result.append(dict(rule=rule, numerator=count, denominator=total, params=params, target=target))
    for item in members:
        target = {k: item[k] for k in ("room_id", "member", "adapter", "model", "effort")}
        for kind, count in item["failures"].items():
            add("failure_cluster", count, item["executions"], {"failure_class": kind}, target)
        for rule, key in (("permission_denial", "denied"), ("late_recovery", "revived")):
            add(rule, item[key], item["executions"], {}, target)
    for room, bad, total in connection.execute("""SELECT d.room_id,sum(f.rating='bad'),count(*)
        FROM scheduler_feedback f JOIN scheduler_decisions d ON d.id=f.decision_id
        JOIN room_directory rd ON rd.room_id=d.room_id AND rd.system_kind=''
        WHERE CAST(strftime('%s',f.created_at) AS INTEGER)>=? AND CAST(strftime('%s',f.created_at) AS INTEGER)<? GROUP BY d.room_id""", (start, end)):
        add("scheduler_feedback", bad, total, {}, {"room_id": room})
    return result


def time_stats(connection, requests, executions, bounds, now, sealed):
    """Summarize folder activity, observed waiting and the current message queue."""
    start, end = bounds
    counts, histograms = sealed
    folders, room_folder, room_rows = {}, {}, {}
    for room, title, folder, name in connection.execute("""SELECT r.id,r.title,f.id,f.name FROM rooms r
        JOIN room_directory d ON d.room_id=r.id AND d.system_kind=''
        LEFT JOIN room_folder_assignments a ON a.room_id=r.id LEFT JOIN topic_folders f ON f.id=a.folder_id"""):
        room_folder[room] = folder
        folders.setdefault(folder, dict(folder_id=folder, name=name, initiated=0, execution_seconds=0))
        room_rows[room] = dict(room_id=room, title=title, folder_id=folder, initiated=0, execution_seconds=0)
    seen, waits = set(), []
    for r in requests:
        if r["initiated"] and start <= r["sent"] < end and r["message_id"] not in seen:
            folders[room_folder[r["room_id"]]]["initiated"] += 1
            room_rows[r["room_id"]]["initiated"] += 1
            seen.add(r["message_id"])
        if start <= r["created_at"] < end and r["dispatched"] is not None and r["dispatched"] >= r["created_at"]:
            waits.append(r["dispatched"] - r["created_at"])
    spans, member_spans = defaultdict(list), defaultdict(list)
    elapsed, rework = [], []
    for r in executions:
        left, right = max(start, r["created_at"]), min(end, r["finished_at"] or now, now)
        if left < right:
            spans[r["room_id"]].append((left, right))
            member_spans[(r["room_id"], r["name"])].append((left, right))
            folders[room_folder[r["room_id"]]]["execution_seconds"] += right-left
            room_rows[r["room_id"]]["execution_seconds"] += right-left
        if start <= r["created_at"] and r["finished_at"] >= r["created_at"] and r["finished_at"]:
            duration = r["finished_at"] - r["created_at"]
            elapsed.append(duration)
            if r["rework"]:
                rework.append(duration)
    count, oldest = connection.execute("""SELECT count(*),min(q.created_at) FROM queued_messages q
        JOIN room_directory d ON d.room_id=q.room_id AND d.system_kind=''""").fetchone()
    rooms, rooms_at = peak_concurrent(spans)
    members, members_at = peak_concurrent(member_spans)
    peak = {"rooms": rooms, "at": rooms_at, "members": members, "members_at": members_at}
    concurrency = concurrency_series(member_spans, start, end)
    active_rooms = [room for room in room_rows.values() if room["initiated"] or room["execution_seconds"]]
    return {"folders": list(folders.values()), "rooms": active_rooms, "peak": peak, "concurrency": concurrency, "sealed_execution_seconds": counts["execution_seconds"],
            "execution_seconds": sum(f["execution_seconds"] for f in folders.values()) + counts["execution_seconds"],
            "waiting": distribution(waits, histograms["waiting"]),
            "execution": distribution(elapsed, histograms["execution"]), "rework": distribution(rework, histograms["rework"]),
            "queue": {"count": count, "oldest_seconds": max(0, now-oldest) if count else None}}


def actions(connection, start, end):
    """Count corrections by operation and rewound requests separately."""
    def count(sql):
        return connection.execute(sql, (start, end)).fetchone()[0]
    rewind = count("""SELECT count(*) FROM room_rewinds r JOIN room_directory d ON d.room_id=r.room_id AND d.system_kind=''
        WHERE r.created_at>=? AND r.created_at<?""")
    affected = count("""WITH window(lo,hi) AS (VALUES(?,?))
        SELECT count(*) FROM member_requests r CROSS JOIN window
        JOIN room_directory d ON d.room_id=r.room_id AND d.system_kind=''
        LEFT JOIN member_executions e ON e.id=r.execution_id
        WHERE (e.result='用户回退了对话' AND e.status='cancelled' AND e.finished_at>=lo AND e.finished_at<hi)
          OR EXISTS(SELECT 1 FROM message_withdrawals w WHERE w.message_id IN (r.message_id,r.answer_id)
            AND w.kind='rewound' AND w.created_at>=lo AND w.created_at<hi)""")
    retract = count("""SELECT count(*) FROM message_withdrawals w JOIN messages m ON m.id=w.message_id
        JOIN room_directory d ON d.room_id=m.room_id AND d.system_kind=''
        WHERE w.kind='retracted' AND w.created_at>=? AND w.created_at<?""")
    stops = count("""SELECT count(*) FROM room_events e JOIN room_directory d ON d.room_id=e.room_id AND d.system_kind=''
        WHERE at>=?*1000 AND at<?*1000 AND kind='api.write'
        AND json_extract(data,'$.path')='/stop'""")
    stops += count("""SELECT count(*) FROM room_events e JOIN room_directory d ON d.room_id=e.room_id AND d.system_kind=''
        WHERE at>=?*1000 AND at<?*1000 AND kind='execution.changed'
        AND json_extract(data,'$.status')='cancelled' AND json_extract(data,'$.result')='用户打断'""")
    extra = count("""SELECT count(*) FROM execution_interjections i LEFT JOIN interjection_authors a ON a.interjection_id=i.id
        JOIN room_directory d ON d.room_id=i.room_id AND d.system_kind=''
        WHERE a.interjection_id IS NULL AND i.created_at>=? AND i.created_at<?""")
    return {"corrections": {"stops": stops, "withdrawals": retract, "rewinds": rewind, "affected_requests": affected},
            "additions": {"interjections": extra}}


DAY_SECONDS = 86400
SEALED_DISTRIBUTIONS = ("delivery", "waiting", "execution", "rework")
SEALED_COUNTS = ("initiated", "answered", "ended", "unassisted", "execution_seconds", "rewinds",
                 "withdrawals", "stops", "interjections")


def archive_key(room_id, secret):
    """Compute a private join key for idempotence and same-ID restores."""
    return hashlib.blake2b(room_id.encode(), key=bytes.fromhex(secret), digest_size=20).hexdigest()


def room_time_facts(connection, room_id, rows, now):
    for row in rows:
        sent, dispatched = row["created_at"], row["dispatched"]
        if dispatched is not None and dispatched >= sent:
            yield sent, "waiting", dispatched - sent
    query = EXECUTIONS + " AND e.room_id=?"
    for row in connection.execute(query, (now+1, 0, 0, room_id)):
        start, end = row["created_at"], row["finished_at"]
        if end and end >= start:
            yield start, "execution", end - start
            if row["rework"]:
                yield start, "rework", end - start
        limit = min(end or now, now)
        while start < limit:
            boundary = min((start // DAY_SECONDS + 1) * DAY_SECONDS, limit)
            yield start, "execution_seconds", boundary - start
            start = boundary


ARCHIVE_ACTIONS = """
SELECT created_at,'rewinds',1 FROM room_rewinds WHERE room_id=:room
UNION ALL SELECT w.created_at,'withdrawals',1 FROM message_withdrawals w JOIN messages m ON m.id=w.message_id
    WHERE m.room_id=:room AND w.kind='retracted'
UNION ALL SELECT i.created_at,'interjections',1 FROM execution_interjections i
    LEFT JOIN interjection_authors a ON a.interjection_id=i.id WHERE i.room_id=:room AND a.interjection_id IS NULL
UNION ALL SELECT at/1000,'stops',1 FROM room_events WHERE room_id=:room AND
    ((kind='api.write' AND json_extract(data,'$.path')='/stop') OR (kind='execution.changed'
    AND json_extract(data,'$.status')='cancelled' AND json_extract(data,'$.result')='用户打断'))
"""


def seal_room(connection, room_id, now):
    """Replace this room's anonymous daily contribution within the destruction transaction."""
    connection.execute("INSERT OR IGNORE INTO site_preferences VALUES ('analytics_salt',hex(randomblob(32)))")
    secret = connection.execute("SELECT value FROM site_preferences WHERE key='analytics_salt'").fetchone()[0]
    key = archive_key(room_id, secret)
    rows = connection.execute(REQUESTS + " WHERE r.room_id=?", (room_id,)).fetchall()
    days = defaultdict(lambda: (Counter(), defaultdict(Counter)))
    for facts in (overview_facts(rows), room_time_facts(connection, room_id, rows, now),
                  connection.execute(ARCHIVE_ACTIONS, {"room": room_id})):
        for stamp, metric, value in facts:
            if stamp is None:
                continue
            day = datetime.fromtimestamp(stamp, timezone.utc).date().isoformat()
            counts, histograms = days[day]
            if metric in SEALED_DISTRIBUTIONS:
                bucket = 1 << (int(value).bit_length() - 1) if value else 0
                histograms[metric][bucket] += 1
            else:
                counts[metric] += value
    # An empty room contributes only to the total number of retained rooms.
    if not days:
        days[datetime.fromtimestamp(now, timezone.utc).date().isoformat()]
    connection.execute("""INSERT INTO site_preferences VALUES ('analytics_revision','1')
        ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1""")
    connection.execute("DELETE FROM analytics_sealed_days WHERE archive_key=?", (key,))
    connection.executemany("INSERT INTO analytics_sealed_days VALUES (?,?,?,?)",
                           [(key, day, json.dumps(counts), json.dumps(hist)) for day, (counts, hist) in days.items()])


def sealed_periods(connection, mode, rooms, dates):
    periods = [(Counter(), defaultdict(Counter)) for _ in range(2)]
    daily = defaultdict(Counter)
    if mode == "current":
        return periods, 0, daily
    salt = connection.execute("SELECT value FROM site_preferences WHERE key='analytics_salt'").fetchone()
    if not salt:
        return periods, 0, daily
    live = {archive_key(room_id, salt[0]) for room_id in rooms}
    retained = {r[0] for r in connection.execute("SELECT DISTINCT archive_key FROM analytics_sealed_days")} - live
    for key, day, counts, hist in connection.execute("""SELECT archive_key,day,counts,histograms
            FROM analytics_sealed_days WHERE day>=? AND day<?""", (dates["previous_from"], dates["to"])):
        if key not in retained:
            continue
        totals, bins = periods[int(day >= dates["from"])]
        counts = json.loads(counts)
        totals.update(counts)
        if day >= dates["from"]:
            daily[day].update(counts)
        for name, weights in json.loads(hist).items():
            bins[name].update(weights)
    return periods, len(retained), daily


def daily_overview(dates, facts, executions, sealed_days, now):
    """Split running intervals at local midnight, including 23- and 25-hour days."""
    first, end = map(date.fromisoformat, (dates["from"], dates["to"]))
    days = [first + timedelta(days=i) for i in range((end-first).days + 1)]
    zone = report_zone(dates["tz"])
    if zone is not None:
        bounds = [int(datetime.combine(day, time.min, zone).timestamp()) for day in days]
    else:
        # Limit each ICU subprocess command line on Windows.
        bounds = []
        for offset in range(0, len(days), 100):
            bounds.extend(node_calendar(dates["tz"], *map(str, days[offset:offset+100])))
    rows = []
    for day in days[:-1]:
        label = str(day)
        counts = sealed_days.get(label, {})
        rows.append({"date": label, **{k: counts.get(k, 0) for k in ("initiated", "ended", "unassisted", "execution_seconds")}})
    for stamp, key, value in facts:
        if key in ("initiated", "ended", "unassisted") and bounds[0] <= stamp < bounds[-1]:
            rows[bisect_right(bounds, stamp)-1][key] += value
    for row in executions:
        left = max(bounds[0], row["created_at"])
        right = min(bounds[-1], row["finished_at"] or now, now)
        index = bisect_right(bounds, left)-1
        while left < right:
            boundary = min(right, bounds[index+1])
            rows[index]["execution_seconds"] += boundary-left
            left, index = boundary, index+1
    return rows


def previous_work(rows, start, end, now):
    """Execution time and peak concurrency of the previous period, so the page's figures can show a change.

    Same rules as the current period (clipped to the window, overlaps merged per room and per room + member), over
    existing rooms only.
    """
    seconds, rooms, members = 0, defaultdict(list), defaultdict(list)
    for r in rows:
        left, right = max(start, r["created_at"]), min(end, r["finished_at"] or now, now)
        if left < right:
            seconds += right - left
            rooms[r["room_id"]].append((left, right))
            members[(r["room_id"], r["name"])].append((left, right))
    return {"execution_seconds": seconds, "peak_rooms": peak_concurrent(rooms)[0], "peak_members": peak_concurrent(members)[0]}


MOSS_COUNTERS = ("task_rooms", "project_rooms", "delegations", "reworks", "unreported", "reclaimed")
MOSS_ACTIVITY = f"""WITH children AS (
    SELECT r.id,l.other_room_id AS parent,r.created_at,task.room_id IS NOT NULL AS task
    FROM room_links l JOIN rooms r ON r.id=l.room_id
    JOIN room_directory d ON d.room_id=l.other_room_id AND d.system_kind='steward'
    LEFT JOIN moss_task_rooms task ON task.room_id=r.id WHERE l.relation='parent' AND l.message_id=(
        SELECT MIN(message_id) FROM room_links p WHERE p.room_id=r.id AND p.relation='parent')
), sent AS ({DELEGATED_SENDS}), archive_history AS (
    SELECT e.room_id,e.at,c.parent,json_extract(e.data,'$.actor') AS actor,json_extract(e.data,'$.path') AS path,
           LAG(json_extract(e.data,'$.path'),1,'/restore') OVER (PARTITION BY e.room_id ORDER BY e.at,e.id) AS previous
    FROM children c JOIN room_events e ON e.room_id=c.id
    WHERE c.task AND e.kind='api.write' AND json_extract(e.data,'$.path') IN ('/archive','/restore')
), actions AS (
    SELECT CASE WHEN task THEN 'task_rooms' ELSE 'project_rooms' END AS kind,unixepoch(created_at) AS at FROM children
    UNION ALL SELECT 'delegations',unixepoch(m.created_at) FROM sent s
        JOIN messages m ON m.id=s.message_id
        JOIN room_directory target ON target.room_id=s.target_room_id AND target.system_kind=''
        WHERE NOT EXISTS (SELECT 1 FROM children c WHERE c.id=s.target_room_id AND c.parent=s.room_id)
        AND NOT EXISTS (SELECT 1 FROM moss_task_rooms t WHERE t.room_id=s.target_room_id)
    UNION ALL SELECT 'reworks',unixepoch(m.created_at) FROM sent s
        JOIN moss_reworks w ON w.message_id=s.message_id JOIN messages m ON m.id=s.message_id
    UNION ALL SELECT 'unreported',COALESCE(unixepoch(d.updated_at),(
            SELECT MAX(NULLIF(e.finished_at,0)) FROM member_requests r JOIN member_executions e ON e.id=r.execution_id
            WHERE r.message_id=d.reminder_message_id),unixepoch(a.created_at),unixepoch(m.created_at))
        FROM sent s JOIN moss_delegations d ON d.message_id=s.message_id AND d.state='unreported'
        JOIN messages m ON m.id=s.message_id LEFT JOIN messages a ON a.id=d.result_message_id
    UNION ALL SELECT 'reclaimed',h.at/1000 FROM archive_history h
        WHERE h.path='/archive' AND h.previous<>'/archive' AND EXISTS (
            SELECT 1 FROM room_members m WHERE m.room_id=h.parent AND h.actor='member:' || m.name)
)
SELECT kind,COUNT(*) FROM actions WHERE at>=:start AND at<:end GROUP BY kind"""


def moss_snapshot(connection, params, now):
    """Summarize MOSS's retained history without including it in other analytics."""
    connection.execute("BEGIN")
    earliest = connection.execute("""SELECT MIN(unixepoch(r.created_at)) FROM rooms r
        JOIN room_directory d ON d.room_id=r.id AND d.system_kind='steward'""").fetchone()[0]
    dates, (_, start, end) = period(params, now, earliest)
    counts = dict.fromkeys(MOSS_COUNTERS, 0)
    counts.update(dict(connection.execute(MOSS_ACTIVITY, {"start": start, "end": end}).fetchall()))
    executions = connection.execute("""SELECT e.created_at,e.finished_at FROM member_executions e
        JOIN room_directory d ON d.room_id=e.room_id AND d.system_kind='steward'
        WHERE e.created_at>=? AND e.created_at<?""", (start, end)).fetchall()
    durations = [finished - created for created, finished in executions if finished and finished >= created]
    return {"range": dates, **counts, "executions": {"count": len(executions), **distribution(durations)}}


def snapshot(connection, params, cache, now):
    """Build one SQLite read snapshot, caching only within the same server and room scope."""
    if params.get("range") == "live":
        return live_snapshot(connection, int(now))
    earliest = None
    if params.get("range") == "all" and "from" not in params and "to" not in params:
        first = connection.execute("""SELECT MIN(r.created_at) FROM member_requests r
            JOIN room_directory d ON d.room_id=r.room_id AND d.system_kind=''""").fetchone()[0]
        first_wait = connection.execute("""SELECT MIN(w.created_at) FROM room_waits w
            JOIN room_directory d ON d.room_id=w.room_id AND d.system_kind=''""").fetchone()[0]
        sealed_first = connection.execute("SELECT MIN(day) FROM analytics_sealed_days").fetchone()[0]
        candidates = [int(stamp) for stamp in (first, first_wait) if stamp]
        if sealed_first:
            candidates.append(int(datetime.combine(date.fromisoformat(sealed_first), time.min, timezone.utc).timestamp()))
        earliest = min(candidates) if candidates else None
    dates, (previous, start, end) = period(params, now, earliest)
    if params.get("dispatch") == "1":
        # The host dispatch section is computed only when the page opens it: chain records are costly.
        connection.execute("BEGIN")
        return {"range": dates, "dispatch_quality": dispatch_quality(connection, start, end)}
    mode = params.get("scope", "all")
    if mode not in ("all", "current"):
        raise ValueError("scope ∈ {all, current}")
    connection.execute("BEGIN")
    rooms = tuple(r[0] for r in connection.execute("SELECT room_id FROM room_directory WHERE system_kind='' ORDER BY room_id"))
    revision = connection.execute("SELECT value FROM site_preferences WHERE key='analytics_revision'").fetchone()
    key = (tuple(dates.values()), rooms, mode, revision[0] if revision else None)
    hit = cache.get(key)
    if hit and monotonic() < hit[0]:
        return hit[1]
    requests = connection.execute(REQUESTS).fetchall()
    executions = connection.execute(EXECUTIONS, (end, start, start)).fetchall()
    revived = {r[0] for r in connection.execute("""SELECT DISTINCT json_extract(data,'$.execution_id') FROM room_events
        WHERE kind='execution.changed' AND json_extract(data,'$.from_status')='failed' AND json_extract(data,'$.status')='started'""")}
    attempts = [r for r in executions if r["created_at"] >= start]
    earlier_attempts = [r for r in connection.execute(EXECUTIONS, (start, previous, previous)) if r["created_at"] >= previous]
    assigned = [r for r in requests if start <= r["created_at"] < end]
    members = member_stats(attempts, assigned, revived)
    models = member_stats(attempts, assigned, revived, by_model=True)
    (prior, sealed), retained, sealed_days = sealed_periods(connection, mode, rooms, dates)
    facts = list(overview_facts(requests))
    activity = actions(connection, start, end)
    for group in activity.values():
        for name in group:
            group[name] += sealed[0][name]
    scope = {"mode": mode, "rooms": len(rooms), "sealed_rooms": retained, "included_rooms": len(rooms) + retained,
             "includes_archived": True, "sealed_day_tz": "UTC", "sealed_counts": SEALED_COUNTS,
             "sealed_distributions": SEALED_DISTRIBUTIONS,
             "current_only": ["folders", "rooms", "peak", "concurrency", "issues", "queue", "affected_requests", "members", "models", "workflows", "insights"]}
    result = dict(range=dates, scope=scope,
                  overview=overview(facts, start, end, sealed), previous=overview(facts, previous, start, prior),
                  time={**time_stats(connection, requests, executions, (start, end), now, sealed), **activity},
                  members=members, models=models, workflows=workflow_stats(connection, attempts),
                  issues=attention_issues(connection, attempts, earlier_attempts, revived, (previous, start, end, now)),
                  insights=insights(connection, members, start, end))
    result["overview"]["daily"] = daily_overview(dates, facts, executions, sealed_days, now)
    result["time"]["concurrency"]["unfinished"] = unfinished_series(attempts, start, end)
    result["previous"].update(previous_work(earlier_attempts, previous, start, now))
    if len(cache) >= CACHE_ENTRIES:
        cache.clear()
    cache[key] = (monotonic() + CACHE_SECONDS, result)
    return result

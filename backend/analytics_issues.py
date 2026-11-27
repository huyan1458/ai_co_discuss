"""Rule-based “needs your attention” list for the analytics page, with the runs behind each item.

Every issue is a fact with its count, the same count for the previous period and the executions that make it up, so
the page can say what happened and let the owner open each run. Rules only describe what was observed; they never
recommend switching a model, since different models and efforts take on different work. No model is called.

Runs that did not finish are grouped by their reason, not by model (2026-11-27, Fable #14109): one runner fault that
hit several models is one issue, not one alert per model. Rarer, unchanged problems are left out, and only a high share
or a clear rise is marked as serious, so a page where 97% of the work went fine does not read as an emergency.
"""
from collections import Counter, defaultdict

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


def issues(connection, current, earlier, revived, bounds):
    """Issues of the period, serious ones first, each with its previous-period count, affected members and runs.

    `current` and `earlier` are execution rows created in this period and in the previous one; `bounds` holds the
    timestamps (previous, start, end) used for the scheduler ratings.
    """
    previous, start, end = bounds
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


def unfinished_series(rows, start, end, step=None):
    """Runs that did not finish, per time step of [start, end) by when they started: the red marks on the timeline."""
    step = step or series_step(start, end)
    buckets = [0] * -(-max(1, end - start) // step)
    for row in rows:
        if not_finished(row) and start <= row["created_at"] < end:
            buckets[(row["created_at"] - start) // step] += 1
    return buckets

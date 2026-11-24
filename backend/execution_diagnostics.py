"""Store bounded evidence reported by the runner and expose it only on authorized execution reads."""

import json
import re


IDENTIFIER = re.compile(r"[A-Za-z0-9_-]{1,128}\Z")
REVISION = re.compile(r"[0-9a-f]{7,64}\Z")
TIME_LIMITS = ("total_ms", "idle_ms")
MAX_LIMIT_MS = 7 * 24 * 60 * 60 * 1000
MAX_ITEMS = 50
ACTION_FIELDS = {"renew", "segments", "delivery", "fail", "report"}


def integer(value, maximum):
    """Accept only positive integers in the report's supported range."""
    return value if type(value) is int and 0 < value <= maximum else None


def selected(value, options):
    """Accept a known protocol value or None."""
    return value if isinstance(value, str) and value in options else None


def matching(value, pattern):
    """Accept a bounded identifier or revision, never a path or free text."""
    return value if isinstance(value, str) and pattern.fullmatch(value) else None


def binding(value):
    """Keep a delivery's selected workflow metadata, without prompts or paths."""
    if not isinstance(value, dict) or not matching(value.get("id"), IDENTIFIER):
        return None
    skills = value.get("skills")
    return {"id": value["id"], "revision": matching(value.get("revision"), REVISION),
            "card": matching(value.get("card"), IDENTIFIER),
            "sub_workflow": matching(value.get("sub_workflow"), IDENTIFIER),
            "sub_revision": matching(value.get("sub_revision"), REVISION),
            "skills": [skill for skill in skills[:MAX_ITEMS] if matching(skill, IDENTIFIER)] if isinstance(skills, list) else []}


def append_unique(data, key, item):
    """Retain recent distinct evidence when the same progress report is retried."""
    items = data.setdefault(key, [])
    if item not in items:
        items.append(item)
        del items[:-MAX_ITEMS]


def merge_retry(data, item, layers, now):
    """Distinguish model, adapter, and runner retries and omit unrecognized fields."""
    if not isinstance(item, dict):
        return
    layer = selected(item.get("layer"), layers)
    state = selected(item.get("state"), ("started", "ended", "succeeded", "failed", "waiting"))
    if not layer or not state:
        return
    attempt = integer(item.get("attempt"), 10_000)
    if layer == "runner":
        append_unique(data, "retries", {"layer": layer, "state": state, "attempt": attempt,
                                       "mode": selected(item.get("mode"), ("resume", "redeliver"))})
    elif (at := integer(item.get("at"), now + MAX_LIMIT_MS)) is not None:
        append_unique(data, "retries", {"layer": layer, "state": state, "attempt": attempt, "at": at})


def merge_progress(data, report, now):
    """Merge only consumed diagnostic fields, keeping latest confirmed activity."""
    if (at := integer(report.get("last_activity_at"), now + MAX_LIMIT_MS)) is not None:
        data["last_activity_at"] = max(at, data.get("last_activity_at", 0))
    if isinstance(report.get("timeout_limits"), dict):
        limits = {key: limit for key in TIME_LIMITS if (limit := integer(report["timeout_limits"].get(key), MAX_LIMIT_MS)) is not None}
        if limits:
            data["timeout_limits"] = limits
    if kind := selected(report.get("timeout_kind"), ("total", "idle")):
        data["timeout_kind"] = kind
    if isinstance(report.get("retries"), list):
        for item in report["retries"][-MAX_ITEMS:]:
            merge_retry(data, item, ("model", "adapter"), now)


def merge_interjection(data, report, payload, now):
    """A delayed empty transport report cannot erase a matching software receipt."""
    transport = selected(report.get("transport"), ("steer", "resumed_turn"))
    interjection_id = integer(payload.get("interjection_id"), 2**53 - 1)
    if not transport or not interjection_id:
        return
    reports = data.setdefault("interjections", {})
    receipt = reports.setdefault(str(interjection_id), {"transport": transport, "confirmed_at": None,
                                                        "status": selected(payload.get("status"), ("delivered", "failed"))})
    if payload.get("status") == "delivered" and receipt["confirmed_at"] is None:
        receipt["confirmed_at"] = integer(report.get("confirmed_at"), now + MAX_LIMIT_MS)
    while len(reports) > MAX_ITEMS:
        del reports[next(iter(reports))]


def stored_diagnostics(connection, execution_id):
    """Read one execution's private diagnostic metadata."""
    row = connection.execute("SELECT details FROM execution_diagnostics WHERE execution_id=?", (execution_id,)).fetchone()
    return json.loads(row[0]) if row else {}


def record_diagnostics(connection, execution_id, payload, now):
    """Persist authorized evidence inside the transaction of the original execution action."""
    action = payload.get("action")
    report = payload.get("diagnostics")
    if action not in ("renew", "report") and (not isinstance(report, dict) or not report):
        return
    report = report if isinstance(report, dict) else {}
    data = stored_diagnostics(connection, execution_id)
    if action == "renew":
        data["last_heartbeat_at"] = max(now, data.get("last_heartbeat_at", 0))
    if action in ACTION_FIELDS:
        merge_progress(data, report, now)
    if action in ACTION_FIELDS and "workflow" in report:
        workflow = binding(report["workflow"])
        if workflow is not None or report["workflow"] is None:
            append_unique(data, "workflow_bindings", workflow)
    if action in ("retry_wait", "retry_start"):
        merge_retry(data, report.get("retry"), ("runner",), now)
    if action == "interjection":
        merge_interjection(data, report, payload, now)
    if action == "report":
        attribution = report.get("file_attribution")
        omitted = attribution.get("omitted") if isinstance(attribution, dict) else None
        if type(omitted) is int and 0 <= omitted <= 2**53 - 1:
            data["omitted_files"] = omitted
        else:
            data.pop("omitted_files", None)
    if data:
        connection.execute("""INSERT INTO execution_diagnostics(execution_id,details) VALUES(?,?)
            ON CONFLICT(execution_id) DO UPDATE SET details=excluded.details""",
                           (execution_id, json.dumps(data, ensure_ascii=False, separators=(",", ":"))))
    elif action == "report":
        connection.execute("DELETE FROM execution_diagnostics WHERE execution_id=?", (execution_id,))


def diagnostic_detail(connection, row, owner=False):
    """Expose file counts to execution readers and paths only where file patches are already authorized."""
    data = stored_diagnostics(connection, row["id"])
    omitted = data.pop("omitted_files", None)
    if row["changes"]:
        changes = json.loads(row["changes"])
        edited = set(json.loads(row["edited"])) if row["edited"] else None
        files = {"observed": len(changes), "recorded_writes": len(edited) if edited is not None else None,
                 "provisional": bool(row["changes_provisional"]), "omitted": omitted}
        if owner:
            files["paths"] = [{"path": path, "recorded_write": path in edited if edited is not None else None} for path in changes]
        data["file_attribution"] = files
    return data

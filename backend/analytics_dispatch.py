"""“主持人调度得怎样”: three rule-based dispatch metrics, grouped by host model and version (2026-11-27, #14596).

Reads the dispatch chain records owned by the “主持人调度效果” work (`dispatch_chain_record` in server.py) instead of
re-deriving dispatches here, so the statistics page and the dispatch review share one definition. Only rules count:
voided dispatches (host withdrawal, owner stop or retract, owner rewind; failures are the runner's or member's, not the
host's), wasted tokens by rule category, and chains where the owner stepped in on the host's work. No model is called.

A chain record costs several queries, so records are cached per room revision: a room with no write since keeps its
chains, and only active rooms are recomputed. The section is computed only when the page asks for it (`dispatch=1`).
"""
from collections import defaultdict

VOID_REASONS = ("host_withdraw", "user_stop_or_retract", "user_rewind")
TOKEN_PARTS = ("input", "cache_read", "cache_write", "output")
WASTED_SEGMENTS = ("voided_dispatch", "failed", "other_cancelled")
EXAMPLES = 5
CACHE_LIMIT = 20000
_records = {}


def chain_sources(connection, start, end):
    """Task chains started in [start, end) in which the host dispatched at least once."""
    return connection.execute("""SELECT m.id,m.room_id,m.created_at FROM messages m
        WHERE CAST(strftime('%s',m.created_at) AS INTEGER)>=? AND CAST(strftime('%s',m.created_at) AS INTEGER)<?
          AND EXISTS(SELECT 1 FROM member_requests r WHERE r.room_id=m.room_id AND r.chain_id=m.id AND r.created_by='host')
          AND NOT EXISTS(SELECT 1 FROM room_directory rd WHERE rd.room_id=m.room_id AND rd.system_kind<>'')
        ORDER BY m.id""", (start, end)).fetchall()


def chain_records(connection, sources):
    """Chain records for the sources, reusing cached ones whose room has not changed since."""
    from .server import dispatch_chain_record, dispatch_intervention_events  # server imports analytics; resolve at call time
    revisions = dict(connection.execute("SELECT room_id,revision FROM room_revisions"))
    if len(_records) > CACHE_LIMIT:
        _records.clear()
    events, records = {}, []
    for source in sources:
        room_id = source["room_id"]
        key = (room_id, source["id"], revisions.get(room_id))
        record = _records.get(key)
        if record is None:
            if room_id not in events:
                events[room_id] = dispatch_intervention_events(connection, room_id)
            record = _records[key] = dispatch_chain_record(connection, source, events[room_id])
        records.append(record)
    return records


def token_sum(part):
    return sum(int(part.get(name) or 0) for name in TOKEN_PARTS)


def group_key(record):
    """Host model and version of a chain: a mixed chain and one without reported versions are their own groups.

    The skill digest covers a fixed set of skill directories (#14763), so a skill edit starts a new group.
    """
    versions = record["host_versions"]
    runs = versions.get("runs") or []
    models = sorted({run.get("model") or "" for run in runs})
    model = models[0] if len(models) == 1 else ("" if not models else "mixed")
    if versions.get("mixed"):
        return ("mixed", model, "", "", "")
    values = versions.get("values") or []
    if not values:
        return ("unknown", model, "", "", "")
    value = values[0]
    return ("known", model, value.get("package_version") or "", value.get("prompt_hash") or "", value.get("skill_hash") or "")


def summarize(records):
    """Per group: ended chains, dispatch messages, voided ones, tokens wasted by rule, chains the owner stepped into."""
    groups = defaultdict(lambda: {"chains": 0, "dispatch_messages": 0, "voided": 0, "voided_examples": [],
                                  "tokens_total": 0, "tokens_wasted": 0, "with_usage": 0, "executions": 0,
                                  "intervened": 0, "intervened_examples": []})
    for record in records:
        if not record["ended"] or not record["dispatch_messages"]:
            continue
        group = groups[group_key(record)]
        group["chains"] += 1
        group["dispatch_messages"] += record["dispatch_messages"]
        voided = sorted({message_id for reason in VOID_REASONS
                         for message_id in record["invalidated_dispatches"].get(reason, {}).get("message_ids", [])})
        group["voided"] += len(voided)
        for message_id in voided:
            if len(group["voided_examples"]) < EXAMPLES:
                group["voided_examples"].append({"room_id": record["room_id"], "message_id": message_id})
        tokens = record["tokens"]
        group["tokens_wasted"] += sum(token_sum(tokens.get(segment) or {}) for segment in WASTED_SEGMENTS)
        group["tokens_total"] += sum(token_sum(tokens.get(segment) or {}) for segment in WASTED_SEGMENTS + ("normal",))
        group["with_usage"] += int(tokens.get("with_usage") or 0)
        group["executions"] += int(tokens.get("executions") or 0)
        if record["user_interventions"].get("targeted_dispatch") or record["unhandled_failure"]:
            group["intervened"] += 1
            if len(group["intervened_examples"]) < EXAMPLES:
                group["intervened_examples"].append({"room_id": record["room_id"], "message_id": record["source_message_id"]})
    result = [{"kind": kind, "model": model, "package_version": package_version, "prompt_hash": prompt_hash,
               "skill_hash": skill_hash, **values}
              for (kind, model, package_version, prompt_hash, skill_hash), values in groups.items()]
    return sorted(result, key=lambda group: (group["kind"] != "known", -group["chains"]))


def dispatch_quality(connection, start, end):
    """The section's data for [start, end): groups plus how many chains were considered."""
    records = chain_records(connection, chain_sources(connection, start, end))
    groups = summarize(records)
    return {"groups": groups, "chains": len(records), "ended": sum(group["chains"] for group in groups)}

"""Free collaboration rooms: member credentials, durable requests and per-member executions.

A free room has no floor, turns or rounds. The user (holding the room control credential)
names members; each named member gets one durable request per message. The local runner
delivers a runner member's open requests as one execution, and the member's answer completes
them. A manual member finds its own requests and answers by request id. The user is the client, never the host: one member that
answers by itself always hosts, routes unnamed messages, names members in its answers, and is
woken once when everything it dispatched has finished. No software is launched here.
"""

import hashlib
import hmac
import json
import re
import time
import uuid

from .identity import MAX_ROOM_AGENTS, default_label, is_ai
from .message_queue import pause as pause_queue, queue_view
from .runtime import (LEASE_SECONDS, MAX_EXECUTION_SEGMENTS, begin_write, enforce_session_limits,
                      require_owner, save_segments, token_hash)

# Adapter and client values are named by the runner's adapter layer; the site only checks their shape (AGENTS.md red line 9).
ADAPTER_VALUE = re.compile(r"[a-z][a-z0-9_]{1,31}")
MAX_REVIEW_SCOPE = 2000
MAX_REVIEW_INPUT = 60000
REVIEW_STATE_SQL = """SELECT json_object(
 'room',json_array(id,title,goal,(SELECT archived FROM room_directory WHERE room_id=rooms.id)),
 'latest',(SELECT COALESCE(MAX(id),0) FROM messages WHERE room_id=rooms.id),
 'members',(SELECT json_group_array(json_array(id,name,role,status,access,session_mode,adapter,token_hash)) FROM (SELECT * FROM room_members WHERE room_id=rooms.id ORDER BY id)),
 'caps',(SELECT json_group_array(json_array(c.member_id,c.member_revision,c.config_version,c.generation)) FROM member_review_capabilities c JOIN room_members m ON m.id=c.member_id WHERE m.room_id=rooms.id),
 'requests',(SELECT json_group_array(json_array(id,member_id,message_id,status,execution_id,answer_id,chain_id,batch_id,purpose)) FROM (SELECT * FROM member_requests WHERE room_id=rooms.id ORDER BY id)),
 'executions',(SELECT json_group_array(json_array(id,status,result,changes)) FROM (SELECT * FROM member_executions WHERE room_id=rooms.id ORDER BY id)),
 'batches',(SELECT json_group_array(json_array(batch_id,settled,host_id,chain_id)) FROM free_batches WHERE room_id=rooms.id),
 'plans',(SELECT json_group_array(json_array(batch_id,status,reviewer_id,config_version,member_revision,scope,review_batch_id)) FROM review_plans WHERE room_id=rooms.id),
 'limit',COALESCE((SELECT max_rounds FROM free_round_limits WHERE room_id=rooms.id),10),
 'holds',(SELECT json_group_array(json_array(chain_id,extra_rounds,message_id)) FROM free_chain_holds WHERE room_id=rooms.id),
 'stopped',(SELECT json_group_array(json_array(chain_id,reason)) FROM free_chains WHERE room_id=rooms.id),
 'withdrawn',(SELECT json_group_array(message_id) FROM message_withdrawals WHERE message_id IN (SELECT id FROM messages WHERE room_id=rooms.id))
) AS state FROM rooms WHERE id=?"""
RECENT_REQUESTS = 100
ADOPT_REASON_LIMIT = 500
RECENT_EXECUTIONS = 100
# The timeline page reads this many recent executions of each kind; with `after` (?3) only those running or ended since.
# Parameters: ?1 room, ?2 limit, ?3 after (0 reads all). Shared verbatim with the Worker.
TIMELINE_EXECUTIONS = 100
# The event log page reads at most this many room events per call, newest first when paging back.
ROOM_EVENT_PAGE = 500
# The message a request's card sits under, for member_requests aliased `r`. A handoff request belongs to the dispatch
# message (`message_id`, which batch logic relies on) but happens because the batch's last answer arrived, so its card
# and answer sit under that answer; later messages (the user asking something meanwhile) then stay above it.
# The notice telling the host its own execution failed (`host_failed:<execution>`) sits where that failed execution was,
# so the page shows the wake-up in the failed card's place instead of a new notice and card.
ANCHOR_SQL = """CASE WHEN r.purpose='handoff' THEN COALESCE((SELECT MAX(a.answer_id) FROM member_requests a
    WHERE a.room_id=r.room_id AND a.batch_id=r.message_id AND a.purpose<>'handoff'), r.message_id)
    WHEN r.purpose='notice' THEN COALESCE((SELECT MIN(f.message_id) FROM free_host_wakes w JOIN member_requests f
    ON f.execution_id=CAST(substr(w.key,13) AS INTEGER) WHERE w.room_id=r.room_id AND w.message_id=r.message_id
    AND w.key LIKE 'host_failed:%'), r.message_id) ELSE r.message_id END"""
# The room's latest message when a request (aliased `r`) was made. A relay step dispatched from an answer that sits in an
# older message's slot, after the user posted meanwhile, goes under the latest top-level message rather than back up there.
DISPATCHED_AFTER_SQL = """(SELECT MAX(m.id) FROM messages m WHERE m.room_id=r.room_id AND m.id>=r.message_id
    AND m.id<=COALESCE(r.answer_id,m.id) AND CAST(strftime('%s',m.created_at) AS INTEGER)<=r.created_at)"""
# Rounds used and the owner's additions in the room's recent chains, for "第 2/3 轮"; parameter: the room.
# A round is a host dispatch (a batch) or a continue the host asked for (`free_host_wakes` with a `continue:` key); a
# relay's later steps in the same pass (`free_relay_steps`) ride on its first, so a whole pass is one round.
CHAIN_PROGRESS_SQL = """SELECT b.chain_id,COUNT(*) AS used,COALESCE((SELECT h.extra_rounds FROM free_chain_holds h
    WHERE h.room_id=b.room_id AND h.chain_id=b.chain_id),0) AS extra
    FROM (SELECT room_id,chain_id FROM free_batches f WHERE NOT EXISTS(SELECT 1 FROM free_relay_steps s
        WHERE s.room_id=f.room_id AND s.batch_id=f.batch_id)
        UNION ALL SELECT room_id,chain_id FROM free_host_wakes WHERE key LIKE 'continue:%') b
    WHERE b.room_id=?
    GROUP BY b.chain_id ORDER BY b.chain_id DESC LIMIT 10"""
CHAIN_USED_SQL = """SELECT (SELECT COUNT(*) FROM free_batches f WHERE f.room_id=?1 AND f.chain_id=?2 AND NOT EXISTS(
        SELECT 1 FROM free_relay_steps s WHERE s.room_id=f.room_id AND s.batch_id=f.batch_id))
    + (SELECT COUNT(*) FROM free_host_wakes WHERE room_id=?1 AND chain_id=?2 AND key LIKE 'continue:%')"""
TIMELINE_STATES = {"completed": "done", "failed": "failed", "cancelled": "cancelled"}
TIMELINE_FREE_IDS = "SELECT id FROM member_executions WHERE room_id=?1 AND (?3=0 OR finished_at=0 OR finished_at>=?3) ORDER BY id DESC LIMIT ?2"
# Besides times: the task an execution took on (its request message), its result (the answer's summary, else the
# answer's opening), its latest progress note, how many files it changed (NULL when unobserved) and its last output time.
TIMELINE_SQL = f"""SELECT x.*,(SELECT COALESCE(NULLIF(s.text,''),substr(a.text,1,200)) FROM messages a
        LEFT JOIN message_summaries s ON s.message_id=a.id WHERE a.id=x.answer_id) AS result FROM (
    SELECT 'free' AS source,e.id,m.name AS member,m.role,e.status,
        COALESCE((SELECT MIN(r.created_at) FROM member_requests r WHERE r.execution_id=e.id),e.created_at) AS queued_at,
        e.created_at AS dispatched_at,0 AS started_at,e.finished_at,
        CASE WHEN e.status='failed' THEN e.result ELSE '' END AS reason,
        (SELECT parent.execution_id FROM member_requests r JOIN member_requests parent ON parent.answer_id=r.message_id
            WHERE r.execution_id=e.id AND parent.execution_id IS NOT NULL ORDER BY r.id LIMIT 1) AS parent_id,
        e.activity_at,(SELECT MIN(r.message_id) FROM member_requests r WHERE r.execution_id=e.id) AS task_id,
        (SELECT substr(q.text,1,160) FROM messages q WHERE q.id=(SELECT MIN(r.message_id) FROM member_requests r WHERE r.execution_id=e.id)) AS task,
        (SELECT MAX(r.answer_id) FROM member_requests r WHERE r.execution_id=e.id) AS answer_id,
        (SELECT n.text FROM execution_notes n WHERE n.execution_id=e.id ORDER BY n.seq DESC LIMIT 1) AS last_note,
        CASE WHEN e.changes='' THEN NULL ELSE json_array_length(e.changes) END AS changes
    FROM member_executions e JOIN room_members m ON m.id=e.member_id WHERE e.id IN ({TIMELINE_FREE_IDS})) x"""
TIMELINE_SEGMENTS_SQL = f"""SELECT source,execution_id,phase,tool,start_ms,end_ms FROM execution_segments WHERE room_id=?1
    AND source='free' AND execution_id IN ({TIMELINE_FREE_IDS}) ORDER BY source,execution_id,seq"""
# Only the times of progress notes: the texts are read when the reader hovers one.
TIMELINE_NOTES_SQL = f"""SELECT execution_id,created_at FROM execution_notes
    WHERE room_id=?1 AND execution_id IN ({TIMELINE_FREE_IDS}) ORDER BY execution_id,seq"""
RECENT_CHANGES = 50
MAX_CHANGED_FILES = 200
# What a member's software last showed it doing, as reported by the runner with each renewal.
ACTIVITY_PHASES = ("", "thinking", "command", "tool", "editing", "writing")
# Progress notes per execution, their length, and how many one renewal may carry.
MAX_EXECUTION_NOTES = 50
MAX_NOTE_LENGTH = 500
MAX_NOTES_PER_RENEW = 10
# A member description is a short note for the scheduler and the host, keyed by the member's name.
MAX_MEMBER_DESCRIPTION = 500
# A display label replaces the member's name on screen only; the name stays the member's identity everywhere else.
MAX_MEMBER_LABEL = 32
MAX_MEMBER_NAME = 80
MAX_PATH_LENGTH = 500
# Refused operations one execution may report, and the length of each field.
MAX_DENIALS = 20
MAX_DENIAL_FIELD = 300
# A manual member's delivery is retried at most this often before the execution fails.
MAX_RETRIES = 3
MAX_RETRY_REASON = 500
# One interjection the owner adds to a running execution, and how many one execution keeps.
MAX_INTERJECTION_LENGTH = 2000
MAX_INTERJECTIONS = 20
INTERJECTION_ENDED = "送达前本次执行已结束"
ACTIVE = ("dispatched", "started")
ACCESS_MODES = ("runner", "manual")
SCHEDULER_PROVIDERS = ("jev", "decisions")
RECOMMEND_SECONDS = 60
# A click sent just before the hint disappears still counts.
RECOMMEND_GRACE_SECONDS = 5
# Rounds a host may run from one owner message by default (a round: one host dispatch, its members' answers and the
# hand-back); each owner message starts a chain. Counted in rounds, so a room with more members gets no fewer of them.
CHAIN_ROUNDS = 10
# The most rounds an owner may allow per chain, or add at once when continuing a stopped chain; a limit of 0 is unlimited.
MAX_CHAIN_ROUNDS = 100
UNLIMITED_ROUNDS = 0
# What the program notices for the host (a failure, a possible conflict, its own "continue when idle") hangs on a visible
# message from this author. Only the host's own continue costs a round of its chain; an event is free, once per event.
NOTICE_AUTHOR = "系统"
# A member's execution with no new output for this long is reported to the host once per quiet spell; nothing is stopped.
STALL_SECONDS = 600
# Bounds of the host's timed check-in interval, in minutes.
CHECKIN_MINUTES = (5, 120)
MAX_CONTINUE_REASON = 300
# A host that left gives up the role; the first active runner member (else manual) then takes it.
RELEASE_HOST = "UPDATE room_members SET role='member' WHERE room_id=? AND role='host' AND status<>'active'"
ASSIGN_HOST = """UPDATE room_members SET role='host' WHERE id=(SELECT id FROM room_members WHERE room_id=? AND status='active'
    ORDER BY access='runner' DESC, id LIMIT 1)
    AND NOT EXISTS (SELECT 1 FROM room_members WHERE room_id=? AND role='host' AND status='active')"""
TERMINAL = ("completed", "cancelled", "failed")
# A queued member has been asked once its request for that message exists.
QUEUE_ASKED = "EXISTS(SELECT 1 FROM member_requests r WHERE r.message_id={row}.message_id AND r.member_id={row}.member_id)"
SESSION_MODES = ("new", "borrowed")
FREE_OPERATIONS = ("messages", "attachments", "move", "folder", "rename", "archive", "restore", "delete")
MEMBER_FIELDS = ("id", "name", "adapter", "role", "status", "access", "session_mode", "read_until")
EXECUTION_FIELDS = ("id", "member_id", "status", "session_id", "lease_until", "created_at", "finished_at", "result",
                    "activity", "activity_at", "paused_at")
# What the runner found when a voided execution's software was to stop; '' until it reports.
STOP_RESULTS = ("stopped", "unstoppable", "unconfirmed")
# How long a member voided where the runner could not stop it gets no new delivery unless its late answer shows the turn ended.
HOLD_SECONDS = 600
# What a rewind does to a runner member's session, as its adapter reports.
REWIND_EFFECTS = ("cut", "fresh", "kept")
# The reported capabilities and stop result read alongside an execution aliased `e`.
CAPABILITY_COLUMNS = """(SELECT stoppable FROM execution_capabilities c WHERE c.execution_id=e.id) AS stoppable,
    (SELECT progress FROM execution_capabilities c WHERE c.execution_id=e.id) AS progress,
    (SELECT stop_result FROM execution_capabilities c WHERE c.execution_id=e.id) AS stop_result,
    (SELECT steer FROM execution_capabilities c WHERE c.execution_id=e.id) AS steer,
    (SELECT resume FROM execution_capabilities c WHERE c.execution_id=e.id) AS resume"""


def reported_capabilities(row):
    """`{stoppable, progress, steer, resume}` as the runner reported them for one execution, or None before it did (or an older runner).
    `steer`: the owner can add an interjection the running software takes without ending its turn. `resume`: the runner
    can stop the software's turn and continue the same session, so the owner may pause the execution without ending it."""
    if row["stoppable"] is None:
        return None
    return {"stoppable": bool(row["stoppable"]), "progress": bool(row["progress"]), "steer": bool(row["steer"]),
            "resume": bool(row["resume"])}
# Columns added after the first free-room tables; Python databases created by that build gain them here.
LATER_COLUMNS = {"room_members": {"access": "TEXT NOT NULL DEFAULT 'runner'", "session_mode": "TEXT NOT NULL DEFAULT 'new'"},
                 "member_executions": {"changes": "TEXT NOT NULL DEFAULT ''", "edited": "TEXT NOT NULL DEFAULT ''", "cwd": "TEXT NOT NULL DEFAULT ''",
                                       "activity": "TEXT NOT NULL DEFAULT ''", "activity_at": "INTEGER NOT NULL DEFAULT 0",
                                       "paused_at": "INTEGER NOT NULL DEFAULT 0"},
                 "member_requests": {"chain_id": "INTEGER NOT NULL DEFAULT 0", "batch_id": "INTEGER NOT NULL DEFAULT 0",
                                     "purpose": "TEXT NOT NULL DEFAULT 'ask'", "created_by": "TEXT NOT NULL DEFAULT 'user'"},
                 "free_chain_holds": {"asked_rounds": "INTEGER NOT NULL DEFAULT 0", "asked_reason": "TEXT NOT NULL DEFAULT ''"},
                 "free_sequences": {"gates": "TEXT NOT NULL DEFAULT '[]'"},
                 "execution_capabilities": {"steer": "INTEGER", "resume": "INTEGER"},
                 "member_capabilities": {"image_model": "TEXT NOT NULL DEFAULT ''"}}


def migrate_free_tables(connection):
    """Add columns that early free-room databases lack; repeated runs change nothing."""
    for table, columns in LATER_COLUMNS.items():
        present = {row[1] for row in connection.execute(f"PRAGMA table_info({table})")}
        for name, definition in columns.items():
            if name not in present:
                connection.execute(f"ALTER TABLE {table} ADD COLUMN {name} {definition}")
    migrate_stop_results(connection)


def migrate_stop_results(connection):
    """Keep development capability records while allowing the new unconfirmed stop result."""
    row = connection.execute("SELECT sql FROM sqlite_master WHERE name='execution_capabilities'").fetchone()
    if not row or "'unconfirmed'" in row[0]:
        return
    definition = row[0].replace("execution_capabilities", "execution_capabilities_next", 1)
    connection.execute(definition.replace("'unstoppable'", "'unstoppable','unconfirmed'"))
    connection.execute("INSERT INTO execution_capabilities_next SELECT * FROM execution_capabilities")
    connection.execute("DROP TABLE execution_capabilities")
    connection.execute("ALTER TABLE execution_capabilities_next RENAME TO execution_capabilities")


def review_member_revision(member, generation=0):
    """Bind an attestation to the exact member identity and access configuration without exposing credentials."""
    state = ":".join(str(member[key]) for key in ("id", "status", "adapter", "access", "session_mode", "token_hash")) + f":{generation}"
    return hashlib.sha256(state.encode("utf-8")).hexdigest()


def review_capability(connection, room_id, member_id, token, payload=None):
    """Read or replace one owner's local read-only attestation, guarded by the member revision."""
    require_owner(connection, room_id, token)
    if payload is not None:
        begin_write(connection)
    member = connection.execute("SELECT * FROM room_members WHERE room_id=? AND id=?", (room_id, member_id)).fetchone()
    if not member:
        raise LookupError("成员不存在")
    previous = connection.execute("SELECT generation FROM member_review_capabilities WHERE member_id=?", (member_id,)).fetchone()
    revision = review_member_revision(member, previous[0] if previous else 0)
    if payload is not None:
        if not payload.get("revision"):
            raise ValueError("请先读取成员 review-capability，再带 revision 提交能力事实")
        if payload["revision"] != revision:
            raise FileExistsError("成员状态已变化，请重新读取能力状态")
        if type(payload.get("read_only")) is not bool:
            raise ValueError("read_only 须为布尔值")
        if payload["read_only"]:
            version = payload.get("config_version", "")
            if not isinstance(version, str) or not re.fullmatch(r"[a-f0-9]{64}", version):
                raise ValueError("config_version 须为本机配置的 SHA-256 摘要")
            # Whether the software can enforce a read-only project is the runner's adapter to judge; it attests only then.
            if member["status"] != "active" or member["access"] != "runner" or member["session_mode"] != "new":
                raise FileExistsError("仅支持程序启动、可核验只读权限的本地 CLI 成员")
            connection.execute("""INSERT INTO member_review_capabilities(member_id,member_revision,config_version,adapter,recorded_at) VALUES (?,?,?,?,?)
                ON CONFLICT(member_id) DO UPDATE SET member_revision=excluded.member_revision,
                config_version=excluded.config_version,adapter=excluded.adapter,recorded_at=excluded.recorded_at""",
                               (member_id, revision, version, member["adapter"], int(time.time())))
        else:
            connection.execute("UPDATE member_review_capabilities SET config_version='',member_revision='' WHERE member_id=?", (member_id,))
    capability = connection.execute("SELECT config_version,adapter FROM member_review_capabilities WHERE member_id=? AND member_revision=?",
                                    (member_id, revision)).fetchone()
    return {"member_id": member_id, "member": member["name"], "revision": revision,
            "capability": dict(capability) if capability else None}


def review_roster(connection, room_id, token):
    """Return eligible local reviewers to the owner or current host; never publish member credentials."""
    try:
        require_owner(connection, room_id, token)
    except PermissionError:
        member = require_member(connection, room_id, token)
        if member["role"] != "host":
            raise PermissionError("只有房主或当前主持人可读取评审候选")
    rows = connection.execute("""SELECT m.*,c.config_version,c.member_revision,c.generation FROM room_members m
        JOIN member_review_capabilities c ON c.member_id=m.id WHERE m.room_id=? AND m.status='active'
        AND m.access='runner' AND m.session_mode='new' ORDER BY m.id""", (room_id,)).fetchall()
    members = [{"id": row["id"], "name": row["name"], "adapter": row["adapter"], "config_version": row["config_version"]}
               for row in rows if row["member_revision"] == review_member_revision(row, row["generation"])]
    state = connection.execute(REVIEW_STATE_SQL, (room_id,)).fetchone()["state"]
    return {"members": members, "revision": hashlib.sha256(state.encode("utf-8")).hexdigest(),
            "reason": "" if members else "没有可核验只读的评审成员"}


def checked_review_plan(connection, room_id, actor, payload):
    """Validate one preauthorized review before the host message and implementation dispatch commit."""
    if not payload.get("next_review"):
        if payload.get("review_scope") or payload.get("review_roster"):
            raise ValueError("review_scope / review_roster 须与 next_review 一起提交")
        return None
    if not isinstance(actor, dict) or actor["role"] != "host" or not payload.get("to") or payload.get("kind") == "moderation":
        raise PermissionError("只有主持人派实现任务时可以声明下一步评审")
    if not isinstance(payload["next_review"], str):
        raise ValueError("next_review 须为成员名称")
    if not payload.get("review_roster"):
        raise ValueError("请先读取 review roster，再带 review_roster 声明评审")
    state = connection.execute(REVIEW_STATE_SQL, (room_id,)).fetchone()["state"]
    if payload["review_roster"] != hashlib.sha256(state.encode("utf-8")).hexdigest():
        raise FileExistsError("评审候选或任务状态已变化，请重新读取 review roster")
    scope = payload.get("review_scope", "")
    if not isinstance(scope, str) or not 1 <= len(scope.strip()) <= MAX_REVIEW_SCOPE:
        raise ValueError(f"评审范围须为 1–{MAX_REVIEW_SCOPE} 字")
    if payload["next_review"] in payload["to"]:
        raise ValueError("评审者不能是该批次的实现者")
    reviewer = connection.execute("""SELECT m.*,c.config_version,c.member_revision,c.generation FROM room_members m
        JOIN member_review_capabilities c ON c.member_id=m.id WHERE m.room_id=? AND m.name=?""", (room_id, payload["next_review"])).fetchone()
    if not reviewer or reviewer["status"] != "active" or reviewer["member_revision"] != review_member_revision(reviewer, reviewer["generation"]) or not reviewer["config_version"]:
        raise FileExistsError("没有可核验只读的评审成员：指定成员未上报有效能力或已失效")
    chain_id = answered_chain(connection, payload, actor)
    if not chain_id or out_of_rounds(connection, room_id, chain_id):
        raise FileExistsError("任务链剩余额度不足，不能保存实现批次及评审授权")
    return {"chain_id": chain_id, "host_id": actor["id"], "reviewer_id": reviewer["id"], "reviewer_name": reviewer["name"],
            "config_version": reviewer["config_version"], "member_revision": reviewer["member_revision"], "scope": scope.strip(),
            "implementers": json.dumps(sorted(set(payload["to"])), ensure_ascii=False)}


def save_review_plan(connection, room_id, batch_id, plan):
    """Persist the next step only inside the implementation message transaction."""
    if plan:
        fields = ("chain_id", "host_id", "reviewer_id", "reviewer_name", "config_version", "member_revision", "scope", "implementers")
        connection.execute(f"INSERT INTO review_plans(room_id,batch_id,{','.join(fields)}) VALUES ({','.join('?' for _ in range(10))})",
                           (room_id, batch_id, *(plan[key] for key in fields)))


def check_review_retry(connection, room_id, message_id, payload):
    """A repeated host message cannot silently change or remove its preauthorized review."""
    plan = connection.execute("SELECT * FROM review_plans WHERE room_id=? AND batch_id=?", (room_id, message_id)).fetchone()
    if not plan and not payload.get("next_review"):
        return
    if not plan or (plan["reviewer_name"], plan["scope"], json.loads(plan["implementers"])) != (
            payload.get("next_review"), str(payload.get("review_scope", "")).strip(), sorted(set(payload.get("to", [])))):
        raise FileExistsError("这个提交编号已绑定不同的评审授权，请为新内容使用新编号")


def review_ready(connection, room_id, batch_id, token):
    """Read original delivery evidence and the exact reasons a preauthorized step cannot advance."""
    roster = review_roster(connection, room_id, token)
    plan = connection.execute("SELECT * FROM review_plans WHERE room_id=? AND batch_id=?", (room_id, batch_id)).fetchone()
    if not plan:
        raise LookupError("该批次没有预授权评审")
    plan = dict(plan)
    batch = connection.execute("SELECT * FROM free_batches WHERE room_id=? AND batch_id=?", (room_id, batch_id)).fetchone()
    requests = [dict(row) for row in connection.execute("""SELECT r.id,r.member_id,m.name AS member,r.status,r.answer_id,
        a.text AS answer,e.id AS execution_id,e.status AS execution_status,e.result,e.changes
        FROM member_requests r JOIN room_members m ON m.id=r.member_id LEFT JOIN messages a ON a.id=r.answer_id
        LEFT JOIN member_executions e ON e.id=r.execution_id WHERE r.room_id=? AND r.batch_id=? ORDER BY r.id""", (room_id, batch_id))]
    handoff = connection.execute("SELECT * FROM member_requests WHERE room_id=? AND message_id=? AND member_id=? AND purpose='handoff'",
                                 (room_id, batch_id, plan["host_id"])).fetchone()
    host = connection.execute("SELECT id FROM room_members WHERE room_id=? AND role='host' AND status='active'", (room_id,)).fetchone()
    candidate = next((member for member in roster["members"] if member["id"] == plan["reviewer_id"]), None)
    capability = connection.execute("SELECT member_revision FROM member_review_capabilities WHERE member_id=?", (plan["reviewer_id"],)).fetchone()
    remaining = rounds_left(connection, room_id, plan["chain_id"])
    reason = review_block_reason(plan, requests, {
        "batch": bool(batch and batch["settled"]), "handoff": bool(handoff and handoff["status"] in ("pending", "delivering")),
        "host": bool(host and host[0] == plan["host_id"]), "remaining": remaining,
        "capability": bool(candidate and candidate["config_version"] == plan["config_version"] and capability[0] == plan["member_revision"]),
        "archived": connection.execute("SELECT archived FROM room_directory WHERE room_id=?", (room_id,)).fetchone()[0]})
    original = connection.execute("SELECT id,author,text FROM messages WHERE room_id=? AND id=?", (room_id, batch_id)).fetchone()
    if not original:
        reason = reason or "缺少原委派，不能自动交评审"
    elif len(json.dumps([dict(original), requests], ensure_ascii=False, separators=(",", ":"))) > MAX_REVIEW_INPUT:
        reason = reason or "交付原文与执行报告超过 60000 字符，请主持人处理"
    return {"plan": plan, "original": dict(original) if original else None, "deliveries": requests, "handoff": dict(handoff) if handoff else None,
            "remaining_rounds": remaining, "revision": roster["revision"], "ready": not reason, "reason": reason}


def review_block_reason(plan, requests, facts):
    """Choose a concrete host-facing explanation without interpreting delivery prose."""
    if plan["status"] != "pending":
        return "评审授权已经消费或仅为导入历史"
    if facts["archived"] or not facts["host"]:
        return "房间已存档或主持人已改变，原评审授权不再有效"
    if not facts["batch"] or not requests or any(item["status"] != "completed" or not item["answer_id"] or item["answer"] is None for item in requests):
        return "实现批次尚未全部成功交付，或缺少交付原文"
    if any(item["member_id"] == plan["reviewer_id"] for item in requests):
        return "评审者不能是该批次的实现者"
    if not facts["handoff"]:
        return "该批次交回主持人的请求已处理或取消"
    if not facts["capability"]:
        return "没有可核验只读的评审成员：既定评审者离开或能力配置已变化"
    if facts["remaining"] is not None and facts["remaining"] < 1:
        return "任务链剩余额度不足，需用户续额或主持人另行处理"
    return ""


def advance_review(connection, room_id, token, payload):
    """Consume one exact review authorization and close only its handoff in one transaction."""
    begin_write(connection)
    host = require_member(connection, room_id, token, payload.get("actor"))
    if host["role"] != "host":
        raise PermissionError("只有当前主持人可以推进预授权评审")
    batch_id, submission = payload.get("batch_id"), payload.get("submission_id", "")
    if type(batch_id) is not int or not isinstance(submission, str) or not re.fullmatch(r"[A-Za-z0-9_-]{8,100}", submission):
        raise ValueError("须提供 batch_id 和有效 submission_id")
    saved = connection.execute("SELECT batch_id,review_batch_id FROM review_plans WHERE room_id=? AND advance_submission=?", (room_id, submission)).fetchone()
    if saved:
        if saved["batch_id"] != batch_id:
            raise FileExistsError("提交编号已用于其他评审批次")
        execution = connection.execute("""SELECT e.status FROM member_requests r JOIN member_executions e ON e.id=r.execution_id
            JOIN review_plans p ON p.room_id=r.room_id AND p.batch_id=r.message_id AND p.host_id=r.member_id
            WHERE r.room_id=? AND p.batch_id=? AND r.purpose='handoff'""", (room_id, batch_id)).fetchone()
        return {"batch_id": batch_id, "review_batch_id": saved["review_batch_id"], "duplicate": True,
                "execution_completed": bool(execution and execution[0] == "completed")}
    if not payload.get("revision"):
        raise ValueError("请先读取 review ready，再携带 revision 推进")
    state = review_ready(connection, room_id, batch_id, token)
    if payload["revision"] != state["revision"]:
        raise FileExistsError("评审状态已变化，请重新读取 review ready")
    if not state["ready"]:
        raise FileExistsError(state["reason"])
    plan, handoff = state["plan"], state["handoff"]
    if plan["host_id"] != host["id"]:
        raise PermissionError("本主持人没有该批次的评审授权")
    answer_ids = sorted({item["answer_id"] for item in state["deliveries"]})
    question = f"请只读评审实现批次 #{batch_id}。范围：{plan['scope']}。先读原委派 #{batch_id}，再读交付原文 " + "、".join(f"#{number}" for number in answer_ids) + "。不得修改项目；评审结束交回主持人。"
    cursor = connection.execute("INSERT INTO messages(room_id,author,text,source,submission_id,created_at) VALUES(?, '系统任务',?,'system',?,?)",
                                (room_id, question, f"review-task-{batch_id}", time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())))
    review_batch_id = cursor.lastrowid
    connection.execute("UPDATE review_plans SET status='advanced',review_batch_id=?,advance_submission=? WHERE room_id=? AND batch_id=?",
                       (review_batch_id, submission, room_id, batch_id))
    connection.execute("INSERT INTO free_batches(room_id,batch_id,chain_id,host_id) VALUES(?,?,?,?)", (room_id, review_batch_id, plan["chain_id"], host["id"]))
    connection.execute("INSERT INTO free_handoffs(room_id,batch_id) VALUES(?,?)", (room_id, review_batch_id))
    insert_request(connection, room_id, plan["reviewer_id"], review_batch_id, plan["chain_id"], "ask", "host", batch_id=review_batch_id)
    connection.execute("UPDATE member_requests SET status='completed' WHERE id=?", (handoff["id"],))
    completed = finish_review_handoff(connection, handoff)
    return {"batch_id": batch_id, "review_batch_id": review_batch_id, "execution_completed": completed, "duplicate": False}


def finish_review_handoff(connection, handoff, result="review_advanced"):
    """Finish the host execution only when its other requests have all been handled."""
    execution_id = handoff["execution_id"]
    if not execution_id or connection.execute("SELECT 1 FROM member_requests WHERE execution_id=? AND status='delivering'", (execution_id,)).fetchone():
        return False
    connection.execute("UPDATE member_executions SET status='completed',finished_at=?,result=? WHERE id=?",
                       (int(time.time()), result, execution_id))
    return True


def member_value(member):
    """Validate one member and its client-generated credential."""
    if not isinstance(member, dict) or not is_ai(member.get("name")):
        raise ValueError("成员须为有效 AI 身份")
    if not token_hash(member.get("token")):
        raise ValueError("每位成员须提供 32–256 字符的成员凭证")
    adapter = member.get("adapter", "")
    if not isinstance(adapter, str) or len(adapter) > 40:
        raise ValueError("成员适配器名称无效")
    access, session_mode = member.get("access", "runner"), member.get("session_mode", "new")
    if access not in ACCESS_MODES or session_mode not in SESSION_MODES:
        raise ValueError("成员接入方式须为 runner/manual，会话方式须为 new/borrowed")
    return {"name": member["name"], "adapter": adapter, "token": member["token"],
            "access": access, "session_mode": session_mode}


def review_request_context(connection, request):
    """Expose only the request's review provenance and local capability binding."""
    plan = connection.execute("SELECT * FROM review_plans WHERE batch_id=? OR review_batch_id=?",
                              (request["message_id"], request["message_id"])).fetchone()
    if not plan:
        return {}
    phase = "handoff" if request["message_id"] == plan["batch_id"] else "review" if request["purpose"] == "ask" else "result"
    if phase == "handoff" and request["purpose"] != "handoff":
        return {}
    review = {key: plan[key] for key in ("batch_id", "reviewer_id", "reviewer_name", "config_version", "member_revision", "scope")}
    review["phase"] = phase
    result = {"review": review}
    if phase != "handoff":
        result.update(source_question=connection.execute("SELECT text FROM messages WHERE id=?", (request["message_id"],)).fetchone()[0],
                      source_message_id=plan["batch_id"], after_message_id=plan["batch_id"], cause_kind="review")
    if phase == "result":
        failed = connection.execute("""SELECT e.result FROM member_requests r JOIN member_executions e ON e.id=r.execution_id
            WHERE r.batch_id=? AND r.status IN ('cancelled','failed') ORDER BY r.id""", (plan["review_batch_id"],)).fetchall()
        review["reason"] = "；".join(row[0] for row in failed)
    return result


def member_values(members):
    """Validate independent member credentials for a room."""
    if not isinstance(members, list) or not len(members) <= MAX_ROOM_AGENTS:
        raise ValueError("房间成员须为列表，且不超过成员上限")
    result = [member_value(member) for member in members]
    if len({member["name"] for member in result}) != len(result):
        raise ValueError("成员名称不能重复")
    if len({member["token"] for member in result}) != len(result):
        raise ValueError("每位成员须使用独立凭证")
    return result


def insert_member(connection, room_id, member, now):
    """Store one member with only its credential hash."""
    connection.execute("""INSERT INTO room_members (room_id,name,adapter,token_hash,access,session_mode,created_at)
        VALUES (?,?,?,?,?,?,?)""", (room_id, member["name"], member["adapter"], token_hash(member["token"]),
                                     member["access"], member["session_mode"], now))


def save_room_access(connection, room_id, control_token, members, settings):
    """Persist the mode, the owner's control hash and the members in the creating transaction."""
    control = token_hash(control_token)
    if not control:
        raise ValueError("建房须提供 32–256 字符的房间控制凭据")
    if any(token_hash(member["token"]) == control for member in members):
        raise ValueError("成员凭证不能与房主控制凭据相同")
    connection.execute("INSERT INTO room_modes (room_id,mode,control_hash) VALUES (?,'free',?)", (room_id, control))
    for member in members:
        insert_member(connection, room_id, member, settings["created_at"])
    connection.execute("UPDATE room_members SET role='host' WHERE room_id=? AND name=?", (room_id, settings["host"]))


def pin_host(connection, room_id, previous_id):
    """Put a newly appointed host first and the previous host second in the saved speaking order; the rest keep their order.

    Without a saved order the rest follow the joining order, as the host-first default showed them.
    """
    host = connection.execute("SELECT id FROM room_members WHERE room_id=? AND role='host' AND status='active'", (room_id,)).fetchone()
    if not host:
        return
    row = connection.execute("SELECT member_ids FROM speaking_orders WHERE room_id=?", (room_id,)).fetchone()
    ids = json.loads(row[0]) if row else [item[0] for item in connection.execute(
        "SELECT id FROM room_members WHERE room_id=? AND status<>'removed' ORDER BY id", (room_id,))]
    front = [host["id"], *([previous_id] if previous_id and previous_id != host["id"] else [])]
    connection.execute("INSERT OR REPLACE INTO speaking_orders (room_id,member_ids) VALUES (?,?)",
                       (room_id, json.dumps(front + [member_id for member_id in ids if member_id not in front])))


def sync_participants(connection, room_id):
    """Keep one active AI host, then mirror member capabilities and the host into shared room metadata."""
    leaving = connection.execute("SELECT id FROM room_members WHERE room_id=? AND role='host' AND status<>'active'", (room_id,)).fetchone()
    connection.execute(RELEASE_HOST, (room_id,))
    if connection.execute(ASSIGN_HOST, (room_id, room_id)).rowcount:
        pin_host(connection, room_id, leaving["id"] if leaving else None)
    members = connection.execute("""SELECT name,role,status FROM room_members
        WHERE room_id=? AND status<>'removed' ORDER BY id""", (room_id,)).fetchall()
    experts = {row["name"]: "cli" for row in members}
    host = next((row["name"] for row in members if row["role"] == "host" and row["status"] == "active"), "用户")
    connection.execute("UPDATE topic_settings SET experts=?,host=? WHERE room_id=?",
                       (json.dumps(experts, ensure_ascii=False), host, room_id))


def public_execution(row):
    """Return execution state without any credential material."""
    return {key: row[key] for key in EXECUTION_FIELDS} if row else None


def held_until(connection, member_id):
    """Until when a member's next delivery waits, or 0: its latest execution was voided where the runner reported it cannot
    stop the software (a window or App), which may still be on that turn and would take a new task mid-turn. Its late
    answer ends the wait."""
    row = connection.execute("""SELECT e.finished_at FROM member_executions e JOIN execution_capabilities c ON c.execution_id=e.id
        WHERE e.id=(SELECT MAX(id) FROM member_executions WHERE member_id=?) AND e.status='cancelled'
          AND c.stop_result<>'stopped' AND (c.stoppable=0 OR c.stop_result IN ('unstoppable','unconfirmed'))
          AND NOT EXISTS(SELECT 1 FROM late_answers l WHERE l.execution_id=e.id)""", (member_id,)).fetchone()
    until = row["finished_at"] + HOLD_SECONDS if row else 0
    return until if until > int(time.time()) else 0


def member_capability(connection, room_id, member_id, token, payload):
    """Record what one runner member can do, as the runner's adapter for it reports: what a rewind does to its session,
    and the image model it generates images with ('' for none; an older runner that omits it keeps the stored one).

    Bound to one known member and replaced whole, so it takes no revision. Returns `{member_id, rewind, image_model}`.
    """
    require_owner(connection, room_id, token)
    begin_write(connection)
    if not connection.execute("SELECT 1 FROM room_members WHERE room_id=? AND id=?", (room_id, member_id)).fetchone():
        raise LookupError("成员不存在")
    if payload.get("rewind") not in REWIND_EFFECTS:
        raise ValueError(f"rewind 须为 {'、'.join(REWIND_EFFECTS)}")
    previous = connection.execute("SELECT image_model FROM member_capabilities WHERE member_id=?", (member_id,)).fetchone()
    image_model = payload.get("image_model", previous[0] if previous else "")
    if not isinstance(image_model, str) or not re.fullmatch(r"(?:[A-Za-z0-9][A-Za-z0-9._:/@-]{0,79})?", image_model):
        raise ValueError("image_model 须为图片模型 ID（最多 80 字）或空")
    connection.execute("""INSERT INTO member_capabilities (member_id,room_id,rewind,image_model) VALUES (?,?,?,?)
        ON CONFLICT(member_id) DO UPDATE SET rewind=excluded.rewind,image_model=excluded.image_model""",
                       (member_id, room_id, payload["rewind"], image_model))
    return {"member_id": member_id, "rewind": payload["rewind"], "image_model": image_model}


def execution_retry(connection, execution_id):
    """What the runner reported about a waiting retry of one execution, or None."""
    row = connection.execute("SELECT attempt,retry_at,reason,stopped FROM execution_retries WHERE execution_id=?", (execution_id,)).fetchone()
    return dict(row) if row else None


def member_descriptions(connection, room_id):
    """The owner's descriptions of members by name; everyone who can read the room may read them."""
    return {row["name"]: row["description"] for row in connection.execute(
        "SELECT name,description FROM member_descriptions WHERE room_id=? ORDER BY name", (room_id,))}


def describe_members(connection, room_id, token, payload):
    """Owner sets members' descriptions by name; an empty text removes that member's description."""
    require_owner(connection, room_id, token)
    descriptions = payload.get("descriptions")
    if (not isinstance(descriptions, dict) or not descriptions or len(descriptions) > MAX_ROOM_AGENTS
            or any(not isinstance(name, str) or not 0 < len(name) <= MAX_MEMBER_NAME or not isinstance(text, str)
                   or len(text) > MAX_MEMBER_DESCRIPTION for name, text in descriptions.items())):
        raise ValueError(f"descriptions 须为 {{成员名: 描述}}，最多 {MAX_ROOM_AGENTS} 位，每段最多 {MAX_MEMBER_DESCRIPTION} 字")
    begin_write(connection)
    now = int(time.time())
    for name, text in descriptions.items():
        if text.strip():
            connection.execute("""INSERT INTO member_descriptions (room_id,name,description,updated_at) VALUES (?,?,?,?)
                ON CONFLICT(room_id,name) DO UPDATE SET description=excluded.description,updated_at=excluded.updated_at""",
                               (room_id, name, text.strip(), now))
        else:
            connection.execute("DELETE FROM member_descriptions WHERE room_id=? AND name=?", (room_id, name))
    return {"descriptions": member_descriptions(connection, room_id)}


def member_labels(connection, room_id):
    """The owner's display labels of members by name; screens show them and the page turns a user's @label into the member name, never credentials."""
    return {row["name"]: row["label"] for row in connection.execute(
        "SELECT name,label FROM member_labels WHERE room_id=? ORDER BY name", (room_id,))}


def member_display_names(connection, room_id):
    """What each present member is called in text: the owner's label, else its platform nickname, else its ID."""
    labels = member_labels(connection, room_id)
    return {row["name"]: labels.get(row["name"]) or default_label(row["name"]) for row in connection.execute(
        "SELECT name FROM room_members WHERE room_id=? AND status<>'removed' ORDER BY id", (room_id,))}


def member_handles(connection, room_id):
    """Every way to name a present member, mapped to its ID: the ID, and its display name unless another member shares it."""
    shown = member_display_names(connection, room_id)
    handles = {name: name for name in shown}
    taken = list(shown.values())
    for name, label in shown.items():
        if label not in handles and taken.count(label) == 1:
            handles[label] = name
    return handles


def resolve_member_fields(connection, room_id, payload):
    """Turn display names in a write's member fields into IDs, so members are named as they are seen; IDs still work."""
    handles = member_handles(connection, room_id)
    resolve = lambda value: handles.get(value.strip(), value) if isinstance(value, str) else value
    if isinstance(payload.get("to"), list):
        payload["to"] = [resolve(item) for item in payload["to"]]
    if isinstance(payload.get("detach"), list):
        payload["detach"] = [resolve(item) for item in payload["detach"]]
    if isinstance(payload.get("parallel"), list):
        payload["parallel"] = [[resolve(item) for item in group] if isinstance(group, list) else group for group in payload["parallel"]]
    if isinstance(payload.get("gates"), list):
        payload["gates"] = [{**gate, **{key: resolve(gate[key]) for key in ("after", "repeat_from") if key in gate}}
                            if isinstance(gate, dict) else gate for gate in payload["gates"]]
    for key in ("next_review", "expert"):
        if key in payload:
            payload[key] = resolve(payload[key])
    if isinstance(payload.get("turns"), list):
        payload["turns"] = [{**item, "expert": resolve(item.get("expert"))} if isinstance(item, dict) else item for item in payload["turns"]]
    return payload


def label_members(connection, room_id, token, payload):
    """Owner sets members' display labels by name; an empty text removes that member's label."""
    require_owner(connection, room_id, token)
    labels = payload.get("labels")
    if (not isinstance(labels, dict) or not labels or len(labels) > MAX_ROOM_AGENTS
            or any(not isinstance(name, str) or not 0 < len(name) <= MAX_MEMBER_NAME or not isinstance(text, str)
                   or len(text.strip()) > MAX_MEMBER_LABEL for name, text in labels.items())):
        raise ValueError(f"labels 须为 {{成员名: 显示名}}，最多 {MAX_ROOM_AGENTS} 位，每个最多 {MAX_MEMBER_LABEL} 字")
    begin_write(connection)
    now = int(time.time())
    for name, text in labels.items():
        if text.strip():
            connection.execute("""INSERT INTO member_labels (room_id,name,label,updated_at) VALUES (?,?,?,?)
                ON CONFLICT(room_id,name) DO UPDATE SET label=excluded.label,updated_at=excluded.updated_at""",
                               (room_id, name, text.strip(), now))
        else:
            connection.execute("DELETE FROM member_labels WHERE room_id=? AND name=?", (room_id, name))
    return {"labels": member_labels(connection, room_id)}

def note_count(connection, execution_id):
    """How many progress notes an execution has; the texts are read separately so room views stay small."""
    return connection.execute("SELECT COUNT(*) FROM execution_notes WHERE execution_id=?", (execution_id,)).fetchone()[0]


def execution_notes(connection, room_id, execution_id, token=""):
    """Read one execution's progress notes in order, with the same access as the room view."""
    execution = connection.execute("SELECT member_id FROM member_executions WHERE room_id=? AND id=?", (room_id, execution_id)).fetchone()
    if not execution:
        raise LookupError("执行不存在")
    boundary = discussion.session_message_access(connection, room_id, {}, token)
    if boundary is not None:
        try:
            member = require_member(connection, room_id, token)
        except PermissionError:
            return {"notes": []}
        if member["id"] != execution["member_id"]:
            return {"notes": []}
    return {"notes": [dict(row) for row in connection.execute(
        "SELECT seq,text,created_at FROM execution_notes WHERE execution_id=? ORDER BY seq", (execution_id,))]}


def execution_timeline(connection, room_id, after=0):
    """Read the room's recent executions with their phase segments and note times, for the timeline page.

    Times are epoch seconds and segments are millisecond offsets from `dispatched_at`. An execution's parent is the
    execution that wrote the message it answers. `state` is running, done, failed
    or cancelled, so the page never interprets execution statuses itself. A positive `after` reads only executions
    still running or ended since then, so a page following live work rereads little.
    """
    if not connection.execute("SELECT 1 FROM rooms WHERE id=?", (room_id,)).fetchone():
        raise LookupError("房间不存在")
    params = (room_id, TIMELINE_EXECUTIONS, max(0, int(after)))
    rows = [dict(row) for row in connection.execute(TIMELINE_SQL, params)]
    segments, notes = {}, {}
    for row in connection.execute(TIMELINE_SEGMENTS_SQL, params):
        segments.setdefault((row["source"], row["execution_id"]), []).append(
            {key: row[key] for key in ("phase", "tool", "start_ms", "end_ms")})
    for row in connection.execute(TIMELINE_NOTES_SQL, params):
        notes.setdefault(row["execution_id"], []).append(row["created_at"])
    for row in rows:
        row["state"] = TIMELINE_STATES.get(row["status"], "running")
        row["segments"] = segments.get((row["source"], row["id"]), [])
        row["notes"] = notes.get(row["id"], [])
    return {"now": int(time.time()), "after": params[2], "executions": rows, "execution_limit": TIMELINE_EXECUTIONS,
            "segment_limit": MAX_EXECUTION_SEGMENTS}


def room_event_log(connection, room_id, token, after=0, before=0):
    """Read the room's append-only event log written by the schema triggers; the owner or the present host.

    Args:
        after: return events with a larger id (live follow), oldest first.
        before: with no `after`, return the page of events just below this id (0 = the newest page), oldest first.

    Returns:
        `events` (id, at in epoch ms, kind, data) ordered by `at` then id, `members` id → name for resolving
        `member_id`/`host_id`, `first_id`/`last_id` as paging cursors, and `more` when older events remain.
        A write request (`api.*`) is stored after it finishes, so its id follows the changes it caused; its `at` is
        when it arrived, and ordering by `at` puts the input before its effects.
    """
    host = require_owner_or_host(connection, room_id, token)
    after, before = max(0, int(after)), max(0, int(before))
    if after:
        rows = connection.execute("SELECT id,at,kind,data FROM room_events WHERE room_id=? AND id>? ORDER BY id LIMIT ?",
                                  (room_id, after, ROOM_EVENT_PAGE)).fetchall()
    else:
        rows = connection.execute("""SELECT id,at,kind,data FROM room_events WHERE room_id=? AND (?=0 OR id<?)
            ORDER BY id DESC LIMIT ?""", (room_id, before, before, ROOM_EVENT_PAGE)).fetchall()
    first_id = min((row["id"] for row in rows), default=0)
    more = bool(rows) and not after and connection.execute(
        "SELECT 1 FROM room_events WHERE room_id=? AND id<? LIMIT 1", (room_id, first_id)).fetchone() is not None
    members = {str(row["id"]): row["name"] for row in connection.execute("SELECT id,name FROM room_members WHERE room_id=?", (room_id,))}
    events = sorted(({**dict(row), "data": json.loads(row["data"])} for row in rows), key=lambda event: (event["at"], event["id"]))
    if host:
        events = [host_event(event) for event in events if not host_hidden_event(event)]
    return {"events": events, "members": members, "more": more, "first_id": first_id,
            "last_id": max((row["id"] for row in rows), default=after)}


def host_hidden_event(event):
    """Private chats stay the owner's: the host's read of the event log leaves out their writes."""
    path = str(event["data"].get("path", "")) if event["kind"] == "api.write" else ""
    return "/chat" in path


def host_event(event):
    """The host's copy of an event without message text, so withdrawn messages stay unreadable; it reads text through message commands."""
    data = dict(event["data"])
    if event["kind"] == "message.posted":
        data.pop("text", None)
    if event["kind"] == "api.write" and "/messages" in str(data.get("path", "")):
        data.pop("payload", None)
    return {**event, "data": data}


def recent_executions(connection, room_id):
    """Return bounded public reports, including requests no longer in the recent request list."""
    rows = connection.execute(f"""SELECT e.*,m.name AS member,
        (SELECT json_group_array(id) FROM member_requests WHERE execution_id=e.id) AS request_ids,
        (SELECT MAX(answer_id) FROM member_requests WHERE execution_id=e.id) AS answer_id,
        (SELECT MIN(message_id) FROM member_requests WHERE execution_id=e.id) AS request_message_id,
        (SELECT MIN({ANCHOR_SQL}) FROM member_requests r WHERE r.execution_id=e.id) AS anchor_message_id,
        (SELECT MIN({DISPATCHED_AFTER_SQL}) FROM member_requests r WHERE r.execution_id=e.id) AS dispatched_after,
        (SELECT COUNT(*) FROM execution_notes WHERE execution_id=e.id) AS note_count,
        (SELECT denials FROM execution_denials WHERE execution_id=e.id) AS denials,{CAPABILITY_COLUMNS},
        (SELECT json_object('created_at',created_at) FROM late_answers WHERE execution_id=e.id) AS late_answer
        FROM member_executions e JOIN room_members m ON m.id=e.member_id WHERE e.room_id=? ORDER BY e.id DESC LIMIT ?""", (room_id, RECENT_EXECUTIONS))
    executions = []
    for row in rows:
        requests = []
        for request in connection.execute("SELECT id,message_id,purpose,status,answer_id FROM member_requests WHERE execution_id=? ORDER BY id", (row["id"],)):
            requests.append({**dict(request), **session_request_source(connection, request["id"], request["message_id"])})
        executions.append({**public_execution(row), "member": row["member"], "cwd": row["cwd"], "changes": json.loads(row["changes"] or "[]"),
            "changes_recorded": bool(row["changes"]), "request_ids": json.loads(row["request_ids"]),
            "answer_id": row["answer_id"], "request_message_id": row["request_message_id"],
            "anchor_message_id": row["anchor_message_id"], "dispatched_after": row["dispatched_after"], "requests": requests,
            "notes": row["note_count"], "denials": json.loads(row["denials"] or "[]"),
            "capabilities": reported_capabilities(row), "stop_result": row["stop_result"] or "",
            "late_answer": json.loads(row["late_answer"]) if row["late_answer"] else None,
            "interjections": execution_interjections(connection, row["id"], row["status"]),
            "retry": execution_retry(connection, row["id"])})
    return executions


def session_request_source(connection, member_request_id, message_id):
    """Expose session provenance and a visible transcript anchor for a member request."""
    origin = discussion.session_request_origin(connection, member_request_id)
    if origin:
        return origin
    request = connection.execute("SELECT message_id,purpose FROM member_requests WHERE id=?", (member_request_id,)).fetchone()
    return {"session_request_id": None, "discussion_session_id": None, "round": None, "source_question": "",
            "source_message_id": None, "cause_kind": None, "cause_request_id": None, "after_message_id": message_id,
            **review_request_context(connection, request)}


def possible_conflicts(connection, room_id, names):
    """Report files that executions of different members with overlapping time windows may both have written.

    A working-tree snapshot sees every change made while an execution ran, including another member's. Where the
    runner also reported `edited` (the files the agent's own edit tools wrote), a shared file counts only if every side
    that reported it named it, so concurrent work on separate files is not flagged. `confirmed` lists the files both
    sides' edit tools wrote. Writes made through commands are not in `edited`, and writes outside the scanned working
    directory are not seen at all.
    """
    now = int(time.time())
    rows = [dict(row) for row in connection.execute(
        """SELECT id,member_id,created_at,finished_at,changes,edited,cwd FROM member_executions
        WHERE room_id=? AND changes<>'' ORDER BY id DESC LIMIT ?""", (room_id, RECENT_CHANGES))]
    for row in rows:
        row["files"] = set(json.loads(row["changes"]))
        row["edited"] = set(json.loads(row["edited"])) if row["edited"] else None
        row["end"] = row["finished_at"] or now
    conflicts = []
    for index, first in enumerate(rows):
        for second in rows[index + 1:]:
            if first["member_id"] == second["member_id"] or first["cwd"] != second["cwd"]:
                continue
            if first["created_at"] > second["end"] or second["created_at"] > first["end"]:
                continue
            pair = (second, first)
            files = sorted(path for path in first["files"] & second["files"]
                           if all(row["edited"] is None or path in row["edited"] for row in pair))
            if files:
                confirmed = [path for path in files if all(row["edited"] is not None for row in pair)]
                conflicts.append({"members": [names.get(second["member_id"], ""), names.get(first["member_id"], "")],
                                  "executions": [second["id"], first["id"]], "files": files, "confirmed": confirmed})
    return conflicts


# An invited manual member that has not registered counts as absent: it receives no request and is never a target.
REGISTERED_MEMBER = """(room_members.access<>'manual' OR EXISTS(SELECT 1 FROM member_registrations r
    WHERE r.member_id=room_members.id AND r.token_hash=room_members.token_hash))"""

# One snapshot for group routing; the Worker uses the same SQL inside its atomic write assertion.
GROUP_STATE_SQL = f"""SELECT json_object(
    'latest_id',(SELECT COALESCE(MAX(id),0) FROM messages WHERE room_id=rooms.id),
    'title',rooms.title,'goal',rooms.goal,
    'archived',(SELECT archived FROM room_directory WHERE room_id=rooms.id),
    'order',COALESCE((SELECT member_ids FROM speaking_orders WHERE room_id=rooms.id),'[]'),
    'members',(SELECT json_group_array(json_object('id',id,'name',name,'role',role,'status',status,'access',access,
        'registered',{REGISTERED_MEMBER},'description',COALESCE((SELECT description FROM member_descriptions d
            WHERE d.room_id=room_members.room_id AND d.name=room_members.name),'')))
        FROM (SELECT * FROM room_members WHERE room_id=rooms.id ORDER BY id) AS room_members)) AS state
    FROM rooms WHERE id=?"""


def free_view(connection, room_id):
    """Summarize members, their live execution, recent requests and possible file conflicts."""
    now = int(time.time())
    members = []
    for row in connection.execute("SELECT * FROM room_members WHERE room_id=? AND status<>'removed' ORDER BY id", (room_id,)):
        member = {key: row[key] for key in MEMBER_FIELDS}
        member["registered_at"] = registered_at(connection, row)
        reported = connection.execute("SELECT session_id,client FROM member_sessions WHERE member_id=?", (row["id"],)).fetchone()
        member["reported_session"], member["reported_client"] = (reported["session_id"], reported["client"]) if reported else ("", "")
        failure = connection.execute("SELECT reason FROM member_adopt_failures WHERE member_id=? AND session_id=?",
                                     (row["id"], member["reported_session"])).fetchone() if reported else None
        member["adopt_error"] = failure["reason"] if failure else ""
        latest = connection.execute(f"SELECT e.*,{CAPABILITY_COLUMNS} FROM member_executions e WHERE member_id=? ORDER BY id DESC LIMIT 1",
                                    (row["id"],)).fetchone()
        member["execution"] = public_execution(latest)
        if latest:
            member["execution"].update(capabilities=reported_capabilities(latest), stop_result=latest["stop_result"] or "")
        if latest and latest["status"] in ACTIVE:
            member["execution"]["stale"] = latest["lease_until"] <= now
            member["execution"]["notes"] = note_count(connection, latest["id"])
            member["execution"]["retry"] = execution_retry(connection, latest["id"])
        member["pending"] = connection.execute("SELECT COUNT(*) FROM member_requests WHERE member_id=? AND status='pending'",
                                               (row["id"],)).fetchone()[0]
        member["held_until"] = held_until(connection, row["id"])
        members.append(member)
    names = {row["id"]: row["name"] for row in connection.execute("SELECT id,name FROM room_members WHERE room_id=?", (room_id,))}
    requests = [{**dict(row), "member": names.get(row["member_id"], ""),
                 **session_request_source(connection, row["id"], row["message_id"])} for row in connection.execute(
        """SELECT id,member_id,message_id,status,execution_id,answer_id,chain_id,batch_id,purpose,created_by,created_at,
        (SELECT reason FROM request_cancel_reasons c WHERE c.request_id=member_requests.id) AS cancel_reason FROM member_requests
        WHERE room_id=? ORDER BY id DESC LIMIT ?""", (room_id, RECENT_REQUESTS))]
    chains = [dict(row) for row in connection.execute(
        "SELECT chain_id,reason FROM free_chains WHERE room_id=? ORDER BY chain_id DESC LIMIT 10", (room_id,))]
    max_rounds = chain_rounds(connection, room_id)
    progress = [{"chain_id": row["chain_id"], "used": row["used"],
                 "allowed": None if max_rounds == UNLIMITED_ROUNDS else max_rounds + row["extra"]}
                for row in connection.execute(CHAIN_PROGRESS_SQL, (room_id,))]
    asks = {row["chain_id"]: {"asked_rounds": row["asked_rounds"], "asked_reason": row["asked_reason"]} for row in connection.execute(
        "SELECT chain_id,asked_rounds,asked_reason FROM free_chain_holds WHERE room_id=? AND asked_rounds>0", (room_id,))}
    chains = [{**chain, **asks.get(chain["chain_id"], {})} for chain in chains]
    checkin = connection.execute("SELECT interval_seconds,due_at FROM free_host_checkins WHERE room_id=?", (room_id,)).fetchone()
    failure_wakes = [{"message_id": row["message_id"], "execution_id": int(row["key"][len("host_failed:"):])} for row in connection.execute(
        "SELECT key,message_id FROM free_host_wakes WHERE room_id=? AND key LIKE 'host_failed:%' ORDER BY message_id DESC LIMIT ?",
        (room_id, RECENT_EXECUTIONS))]
    return {"failure_wakes": failure_wakes, "host_checkin": {"minutes": checkin["interval_seconds"] // 60, "due_at": checkin["due_at"]} if checkin else None,
            "members": members, "requests": requests[::-1], "executions": recent_executions(connection, room_id),
            "conflicts": possible_conflicts(connection, room_id, names), "halted_chains": chains, "max_rounds": max_rounds,
            "chain_rounds": progress, "recommendations": recent_recommendations(connection, room_id, now)[::-1],
            "queued_messages": queue_view(connection, room_id)}


def require_member(connection, room_id, token, name=None):
    """Resolve an active member strictly from its own credential."""
    hashed = token_hash(token)
    row = connection.execute("SELECT * FROM room_members WHERE room_id=? AND token_hash=? AND status='active'",
                             (room_id, hashed)).fetchone() if hashed else None
    if not row or (name is not None and row["name"] != name):
        # A borrowed session handed to the local service keeps writing only through the tasks it is given; say so,
        # since its old manual credential was replaced on purpose, not lost.
        claimed = connection.execute("SELECT session_mode,access FROM room_members WHERE room_id=? AND name=? AND status='active'",
                                     (room_id, name)).fetchone() if name and not row else None
        if claimed and claimed["access"] == "runner" and claimed["session_mode"] == "borrowed":
            raise PermissionError(f"{name} 已转为本机托管，原手动凭证已停用：请在收到的房间任务里，用任务给出的凭证回答")
        raise PermissionError("成员凭证无效、已停用或与发言身份不符")
    return dict(row)


def registered_at(connection, member):
    """Return when the member registered with its current credential, or '' while it has not."""
    row = connection.execute("SELECT registered_at FROM member_registrations WHERE member_id=? AND token_hash=?",
                             (member["id"], member["token_hash"])).fetchone()
    return row[0] if row else ""


def register_member(connection, room_id, token, now):
    """A manual member announces itself with its own credential; repeating it keeps the first time.

    The session ID is not part of the request: the CLI attaches it to every call and the room records it separately.
    """
    begin_write(connection)
    member = require_member(connection, room_id, token)
    if member["access"] != "manual":
        raise ValueError("只有手动接入的成员需要注册")
    previous = registered_at(connection, member)
    stamp = previous or now
    connection.execute("""INSERT INTO member_registrations (member_id,room_id,token_hash,registered_at) VALUES (?,?,?,?)
        ON CONFLICT(member_id) DO UPDATE SET token_hash=excluded.token_hash,registered_at=excluded.registered_at""",
                       (member["id"], room_id, member["token_hash"], stamp))
    if not previous:
        queue_invited_expert(connection, room_id, member["name"], now)
    reported = connection.execute("SELECT client FROM member_sessions WHERE member_id=?", (member["id"],)).fetchone()
    return {"member": member["name"], "registered_at": stamp, "session_client": reported[0] if reported else ""}


def require_owner_or_host(connection, room_id, token):
    """Allow the owner, or the room's present host reading to diagnose and steer the room; returns the host row or None."""
    try:
        require_owner(connection, room_id, token)
        return None
    except PermissionError:
        member = require_member(connection, room_id, token)
        if member["role"] != "host":
            raise PermissionError("只有房主或当前主持人可以读取") from None
        return member


def authorize_free_write(connection, room_id, token, operation, payload):
    """Decide who is writing: the owner, or one member posting its own answer.

    Returns:
        "用户" for the owner, or the member row for a member credential.
    """
    begin_write(connection)
    if operation not in FREE_OPERATIONS:
        raise ValueError("自由房间不使用发言权、安排、阶段或轮次")
    try:
        require_owner(connection, room_id, token)
        return "用户"
    except PermissionError:
        if operation not in ("messages", "attachments"):
            raise
    author = payload.get("author")
    try:
        member = require_member(connection, room_id, token)
    except PermissionError:
        if author in (None, "用户"):
            raise PermissionError("此浏览器没有本房间的房主凭据：请用创建房间的浏览器，或登录管理员后再发言") from None
        raise
    if author == member["name"] and payload.get("submitted_by", author) == author:
        return member
    raise PermissionError("成员只能以本人身份发言")


def active_members(connection, room_id, registered_only=True):
    """Map active member names to their rows; unregistered manual members are left out unless a discussion start needs them pending."""
    return {row["name"]: row for row in connection.execute(
        f"SELECT * FROM room_members WHERE room_id=? AND status='active' AND ({REGISTERED_MEMBER} OR ?=0)", (room_id, int(registered_only)))}


def named_members(active, names, exclude=None):
    """Validate a structured recipient list against the active members."""
    if not isinstance(names, list) or any(name not in active or name == exclude for name in names):
        raise ValueError("点名对象须为本房间在场成员" + ("，且不能点名自己" if exclude else ""))
    return [active[name]["id"] for name in dict.fromkeys(names)]


def recipients(connection, room_id, payload):
    """Resolve an owner message's recipients as (member id, purpose) pairs.

    A single active member is named by default. With several, an unnamed message goes to the
    AI host for routing; a room without one leaves it a plain note.
    Naming everyone with order auto leaves the host a group request: the runner has everyone answer
    at once or one after another; a host the runner does not wake has them all answer at once.
    """
    # Rooms created while the user could host get their AI host on the next message.
    sync_participants(connection, room_id)
    active = active_members(connection, room_id)
    if payload.get("to") is not None:
        named = named_members(active, payload["to"])
        host = next((row for row in active.values() if row["role"] == "host"), None)
        if payload.get("order") == "auto" and len(named) > 1 and host and host["access"] == "runner":
            return [(host["id"], "group")]
        return [(member_id, "ask") for member_id in named]
    if len(active) == 1:
        return [(next(iter(active.values()))["id"], "ask")]
    host = next((row for row in active.values() if row["role"] == "host"), None)
    return [(host["id"], "route")] if host else []


# What a proactive post may not carry: it answers no request. Only the host's may also dispatch, as an answer does.
PROACTIVE_EXCLUDED = ("execution_id", "request_ids", "next_review", "turn_id")
HOST_ONLY_PROACTIVE = ("to", "handoff", "no_handoff", "continue", "sequential", "loop", "parallel", "gates", "detach", "need_rounds", "rounds_reason")


def check_need_rounds(member, payload):
    """`need_rounds` + `rounds_reason`: the host says how many rounds the work it dispatches still needs, this one included.

    More than the chain has left stops the chain before this dispatch and asks the owner to approve the difference.
    """
    rounds, reason = payload.get("need_rounds"), payload.get("rounds_reason")
    if rounds is None and reason is None:
        return
    if member["role"] != "host" or not payload.get("to"):
        raise ValueError("need_rounds 只能由主持人与 to 一起使用")
    if type(rounds) is not int or not 1 <= rounds <= MAX_CHAIN_ROUNDS:
        raise ValueError(f"need_rounds 须为 1–{MAX_CHAIN_ROUNDS} 的整数（本任务从这次派活起还需要的轮数）")
    if not isinstance(reason, str) or not reason.strip() or len(reason) > MAX_CONTINUE_REASON:
        raise ValueError(f"need_rounds 须同时用 rounds_reason 写明为什么需要这些轮，最多 {MAX_CONTINUE_REASON} 字")


def need_plan(payload):
    """The host's round request as dispatch takes it, or None."""
    if payload.get("need_rounds") is None:
        return None
    return {"rounds": payload["need_rounds"], "reason": payload["rounds_reason"].strip()}


def check_no_handoff(member, payload):
    """`no_handoff`: the host sends one member's answer straight to the user; only a plain one-member dispatch takes it."""
    if payload.get("no_handoff") in (None, False):
        return
    if (payload["no_handoff"] is not True or member["role"] != "host" or len(payload.get("to") or []) != 1
            or any(payload.get(field) for field in ("handoff", "sequential", "next_review"))):
        raise ValueError("no_handoff 只能由主持人在只点名一位成员时使用，值为 true，不能与 handoff、sequential 或 next_review 同用")


def check_proactive(connection, room_id, member, payload):
    """A member speaking on its own, e.g. its user asked in its own window, bound to no request or execution.

    The host's may dispatch and ask to continue, starting a chain of its own; other members' only speak. Refused while
    the member has a live execution (it answers through that, so the round limit holds) or a discussion runs.
    """
    if payload["proactive"] is not True:
        raise ValueError("proactive 的值须为 true")
    excluded = PROACTIVE_EXCLUDED + (() if member["role"] == "host" else HOST_ONLY_PROACTIVE)
    carried = [field for field in excluded if payload.get(field) not in (None, False, [])]
    if carried:
        raise ValueError(f"主动发言不关联请求{'' if member['role'] == 'host' else '，普通成员也不能派活'}，不能带：{'、'.join(carried)}")
    if connection.execute("SELECT 1 FROM member_executions WHERE member_id=? AND status IN ('dispatched','started')", (member["id"],)).fetchone():
        raise FileExistsError("你有进行中的执行，请用本次执行回答，不能主动发言")
    pending = [row[0] for row in connection.execute("SELECT message_id FROM member_requests WHERE member_id=? AND status='pending' ORDER BY id",
                                                    (member["id"],))]
    if pending:
        # Otherwise the same question is answered here and again when the request is delivered.
        hint = "用 --request 关闭它们后回答" if member["access"] == "manual" else "本机服务会把它们交给你，届时一并回答"
        raise FileExistsError(f"你还有待处理的请求（{'、'.join(f'#{item}' for item in pending)}），不能主动发言；{hint}")
    if discussion.current_session(connection, room_id, active_only=True):
        raise FileExistsError("讨论进行中，不能主动发言；按主持人的安排发言")
    if payload.get("to"):
        named_members(active_members(connection, room_id), payload["to"], exclude=member["name"])
    check_no_handoff(member, payload)
    check_need_rounds(member, payload)
    reason = payload.get("continue")
    if reason is not None and (not isinstance(reason, str) or not reason.strip() or len(reason) > MAX_CONTINUE_REASON):
        raise ValueError(f"continue 写明房间空闲后继续做什么，最多 {MAX_CONTINUE_REASON} 字")


def after_proactive(connection, room_id, message_id, member, payload):
    """Record a proactive post; the host's dispatch or continue starts a new chain at it, under the usual round limit."""
    connection.execute("INSERT INTO proactive_messages (message_id) VALUES (?)", (message_id,))
    if member["role"] != "host":
        settle_batches(connection, room_id)
        return
    if payload.get("to") and payload.get("sequential") is True:
        start_sequence(connection, room_id, member, message_id, payload["to"], message_id, payload.get("loop") is True,
                       need_plan(payload), payload.get("parallel"), payload.get("detach"), payload.get("gates"))
    elif payload.get("to"):
        dispatch(connection, room_id, member, message_id, payload["to"], message_id, payload.get("handoff") is True,
                 payload.get("no_handoff") is True, {"need": need_plan(payload)}, payload.get("detach"))
    remember_continue(connection, room_id, member, message_id, message_id, payload)
    settle_batches(connection, room_id)


def check_answer(connection, room_id, member, payload):
    """A runner member completes a live execution; a manual member may close its own open requests.

    Only the AI host dispatches work; other members' targets remain suggestions. A proactive post is checked apart.
    """
    if payload.get("proactive") is not None:
        check_proactive(connection, room_id, member, payload)
        return None
    if payload.get("to") is not None:
        named_members(active_members(connection, room_id), payload["to"], exclude=member["name"])
    if payload.get("handoff") not in (None, False) and (payload["handoff"] is not True or member["role"] != "host" or not payload.get("to")):
        raise ValueError("handoff 只能由主持人与 to 一起使用，值为 true")
    check_no_handoff(member, payload)
    check_need_rounds(member, payload)
    reason = payload.get("continue")
    if reason is not None and (member["role"] != "host" or not isinstance(reason, str) or not reason.strip()
                               or len(reason) > MAX_CONTINUE_REASON):
        raise ValueError(f"continue 只能由主持人使用，写明房间空闲后继续做什么，最多 {MAX_CONTINUE_REASON} 字")
    if member["access"] == "manual" and not payload.get("request_ids") and payload.get("execution_id") is None:
        # Bound to nothing, it is a proactive post, so the same rules apply (a host's dispatch starts its own chain).
        payload["proactive"] = True
        check_proactive(connection, room_id, member, payload)
        return None
    if member["access"] == "manual":
        request_ids = payload.get("request_ids", [])
        if payload.get("execution_id") is not None or not isinstance(request_ids, list) or any(type(item) is not int for item in request_ids):
            raise ValueError("手动接入成员用 request_ids 关联请求，不使用执行编号")
        purposes = []
        requests = []
        for request_id in request_ids:
            row = connection.execute("SELECT * FROM member_requests WHERE room_id=? AND id=?", (room_id, request_id)).fetchone()
            if not row or row["member_id"] != member["id"] or row["status"] != "pending":
                raise FileExistsError(f"请求 {request_id} 不属于本成员或已处理")
            purposes.append(row["purpose"])
            requests.append(row)
        discussion.validate_session_request_answer(connection, room_id, requests)
        check_dispatch(member, payload, purposes)
        return None
    execution_id = payload.get("execution_id")
    if type(execution_id) is not int:
        raise ValueError("成员回答须关联本次执行编号 execution_id")
    row = connection.execute("SELECT * FROM member_executions WHERE room_id=? AND id=?", (room_id, execution_id)).fetchone()
    if not row or row["member_id"] != member["id"]:
        raise PermissionError("执行编号不属于本成员")
    revived = revive_failed(connection, room_id, row) if row["status"] == "failed" else None
    if revived:
        row = revived
    elif row["status"] not in ACTIVE or row["lease_until"] <= int(time.time()):
        if row["status"] == "cancelled":
            # Kept apart from the transcript: the page shows it folded, and it marks the end of a turn the runner could not stop.
            connection.execute("INSERT OR IGNORE INTO late_answers (execution_id,room_id,text,created_at) VALUES (?,?,?,?)",
                               (execution_id, room_id, str(payload.get("text") or ""), int(time.time())))
            connection.commit()
        hint = ("主持人可改用 --proactive 主动发言提交结果（不关联执行，可同时派活）" if member["role"] == "host"
                else "请保留草稿，告诉用户或主持人")
        raise FileExistsError(f"本次执行已结束、被停止或已被重试，回答不能再关联它；{hint}")
    requests = [dict(item) for item in connection.execute(
        "SELECT id,purpose FROM member_requests WHERE execution_id=? AND status='delivering'", (execution_id,))]
    discussion.validate_session_request_answer(connection, room_id, requests)
    check_dispatch(member, payload, [item["purpose"] for item in requests])
    return row


def check_dispatch(member, payload, purposes):
    """A host answering only its share of an everyone request answers as a member, so it may not dispatch others."""
    if member["role"] == "host" and payload.get("to") and purposes and all(purpose == "all" for purpose in purposes):
        raise ValueError("这次是请全体成员各自回应，其他成员已收到请求；主持人只回答自己的部分，不能用 --to 派活")


def insert_request(connection, room_id, member_id, message_id, chain_id, purpose, created_by, batch_id=0):
    """Queue one request; every request belongs to the chain its owner message started."""
    connection.execute("""INSERT INTO member_requests (room_id,member_id,message_id,chain_id,batch_id,purpose,created_by,created_at)
        VALUES (?,?,?,?,?,?,?,?)""", (room_id, member_id, message_id, chain_id, batch_id, purpose, created_by, int(time.time())))


def mention_prose(text):
    """Remove Markdown code and quote blocks before interpreting response suggestions."""
    lines, fence, quoted = [], "", False
    for line in text.splitlines():
        marker = re.match(r"^ {0,3}(`{3,}|~{3,})", line)
        if marker:
            value = marker[1]
            if not fence:
                fence = value
            elif value[0] == fence[0] and len(value) >= len(fence):
                fence = ""
            continue
        if fence or re.match(r"^( {4}|\t)", line):
            continue
        if re.match(r"^ {0,3}>", line):
            quoted = True
            continue
        if not line.strip():
            quoted = False
        if not quoted:
            lines.append(line)
    return re.sub(r"(`+)[\s\S]*?\1(?!`)", "", "\n".join(lines))


def save_suggestions(connection, room_id, message_id, member, payload):
    """Save ordinary members' explicit targets and prose mentions; only the host's is acted on, by wake_for_mentions."""
    if member == "用户" or member["role"] == "host":
        return
    active = active_members(connection, room_id)
    targets = set(named_members(active, payload["to"] if payload.get("to") is not None else [], exclude=member["name"]))
    prose = mention_prose(str(payload.get("text", "")))
    for handle, name in member_handles(connection, room_id).items():
        if name in active and name != member["name"] and re.search(
                r"(^|[\s(（，,。；;：:])@" + re.escape(handle) + r"(?![A-Za-z0-9_\-\u4e00-\u9fff])", prose):
            targets.add(active[name]["id"])
    for target_id in targets:
        connection.execute("INSERT INTO member_suggestions (message_id,member_id) VALUES (?,?)", (message_id, target_id))


def message_suggestions(connection, message_id):
    """Expose suggested members and the durable request, including terminal conversions."""
    return [dict(row) for row in connection.execute("""SELECT s.member_id,m.name AS member,m.status,
        r.id AS request_id,r.status AS request_status FROM member_suggestions s
        JOIN room_members m ON m.id=s.member_id
        LEFT JOIN member_requests r ON r.message_id=s.message_id AND r.member_id=s.member_id
        WHERE s.message_id=? ORDER BY s.member_id""", (message_id,))]


def convert_suggestion(connection, room_id, token, payload):
    """Let the owner turn a saved suggestion into one request and a fresh user chain."""
    begin_write(connection)
    require_owner(connection, room_id, token)
    message_id, member_id = payload.get("message_id"), payload.get("member_id")
    if type(message_id) is not int or type(member_id) is not int:
        raise ValueError("须提供原消息编号 message_id 与成员编号 member_id")
    target = connection.execute("""SELECT m.name,m.status FROM member_suggestions s
        JOIN messages source ON source.id=s.message_id JOIN room_members m ON m.id=s.member_id
        WHERE source.room_id=? AND m.room_id=? AND s.message_id=? AND s.member_id=?""",
        (room_id, room_id, message_id, member_id)).fetchone()
    if not target:
        raise LookupError("这条消息没有该成员的回应建议")
    if target["status"] != "active":
        raise FileExistsError("该成员已离开，不能转为请求")
    if connection.execute("SELECT 1 FROM room_directory WHERE room_id=? AND archived=1", (room_id,)).fetchone():
        raise ValueError("房间已存档；恢复后才能继续协作")
    previous = connection.execute("SELECT * FROM member_requests WHERE message_id=? AND member_id=?", (message_id, member_id)).fetchone()
    if previous:
        return {"request": dict(previous), "duplicate": True}
    confirmation = connection.execute("""INSERT INTO messages (room_id,author,text,reply_to,source,submission_id,created_at)
        VALUES (?,'用户',?,?,'user',?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))""",
        (room_id, f"请 @{target['name']} 回应 #{message_id} 的建议。", message_id, uuid.uuid4().hex))
    connection.execute("INSERT INTO message_details (message_id,kind,submitted_by) VALUES (?,'chat','用户')", (confirmation.lastrowid,))
    insert_request(connection, room_id, member_id, message_id, confirmation.lastrowid, "ask", "user")
    request = connection.execute("SELECT * FROM member_requests WHERE message_id=? AND member_id=?", (message_id, member_id)).fetchone()
    return {"request": dict(request), "duplicate": False}


def halt_chain(connection, room_id, chain_id, reason):
    """Stop automatic progress on a chain; the user's next message starts a new one."""
    connection.execute("INSERT OR IGNORE INTO free_chains (room_id,chain_id,reason) VALUES (?,?,?)", (room_id, chain_id, reason))


def rounds_left(connection, room_id, chain_id):
    """Rounds a chain may still start: the room's limit plus what the owner added, less the rounds used; none once halted.

    None when the room's limit is unlimited (and the chain was not halted).
    """
    if connection.execute("SELECT 1 FROM free_chains WHERE room_id=? AND chain_id=?", (room_id, chain_id)).fetchone():
        return 0
    limit = chain_rounds(connection, room_id)
    if limit == UNLIMITED_ROUNDS:
        return None
    used = connection.execute(CHAIN_USED_SQL, (room_id, chain_id)).fetchone()[0]
    extra = connection.execute("SELECT extra_rounds FROM free_chain_holds WHERE room_id=? AND chain_id=?", (room_id, chain_id)).fetchone()
    return limit + (extra[0] if extra else 0) - used


def out_of_rounds(connection, room_id, chain_id, needed=1):
    """Whether a chain has fewer than `needed` rounds left; an unlimited room never runs out."""
    remaining = rounds_left(connection, room_id, chain_id)
    return remaining is not None and remaining < needed


def chain_rounds(connection, room_id):
    """Rounds a host may run from one owner message in this room; UNLIMITED_ROUNDS (0) for no limit."""
    row = connection.execute("SELECT max_rounds FROM free_round_limits WHERE room_id=?", (room_id,)).fetchone()
    return row[0] if row else CHAIN_ROUNDS


def set_chain_rounds(connection, room_id, token, payload):
    """Owner sets the room's round limit (0 for unlimited); it applies to chains still running and to later ones."""
    require_owner(connection, room_id, token)
    value = payload.get("max_rounds")
    if type(value) is not int or not (value == UNLIMITED_ROUNDS or 1 <= value <= MAX_CHAIN_ROUNDS):
        raise ValueError(f"max_rounds 须为 1–{MAX_CHAIN_ROUNDS} 的整数，或 0 表示不限")
    begin_write(connection)
    connection.execute("""INSERT INTO free_round_limits (room_id,max_rounds) VALUES (?,?)
        ON CONFLICT(room_id) DO UPDATE SET max_rounds=excluded.max_rounds""", (room_id, value))
    return {"max_rounds": value}


def continue_chain(connection, room_id, token, chain_id, payload):
    """Owner lets a chain the round limit stopped run on: adds rounds and sends the dispatch the limit held back.

    Bound to one known chain, so it takes no revision; a chain that is not stopped by its limit is refused.
    """
    require_owner(connection, room_id, token)
    rounds = payload.get("rounds")
    if type(rounds) is not int or not 1 <= rounds <= MAX_CHAIN_ROUNDS:
        raise ValueError(f"rounds 须为 1–{MAX_CHAIN_ROUNDS} 的整数")
    begin_write(connection)
    halted = connection.execute("SELECT reason FROM free_chains WHERE room_id=? AND chain_id=?", (room_id, chain_id)).fetchone()
    if not halted or halted[0] != "budget":
        raise FileExistsError("这条任务链没有因轮数上限停下，无需继续")
    host = connection.execute("SELECT * FROM room_members WHERE room_id=? AND role='host' AND status='active'", (room_id,)).fetchone()
    if not host:
        raise ValueError("房间没有在场的主持人，无法继续")
    connection.execute("""INSERT INTO free_chain_holds (room_id,chain_id,extra_rounds) VALUES (?,?,?)
        ON CONFLICT(room_id,chain_id) DO UPDATE SET extra_rounds=extra_rounds+excluded.extra_rounds""", (room_id, chain_id, rounds))
    connection.execute("DELETE FROM free_chains WHERE room_id=? AND chain_id=?", (room_id, chain_id))
    held = connection.execute("SELECT message_id,names,handoff FROM free_chain_holds WHERE room_id=? AND chain_id=?", (room_id, chain_id)).fetchone()
    connection.execute("""UPDATE free_chain_holds SET message_id=0,host_id=0,names='[]',handoff=0,asked_rounds=0,asked_reason=''
        WHERE room_id=? AND chain_id=?""", (room_id, chain_id))
    if held["message_id"]:
        names = json.loads(held["names"])
        names, detach = (names["to"], names["detach"]) if isinstance(names, dict) else (names, None)
        dispatch(connection, room_id, host, held["message_id"], names, chain_id, bool(held["handoff"]), detach=detach)
    return free_view(connection, room_id)


def hold_dispatch(connection, room_id, host, message_id, names, chain_id, handoff, ask=None, detach=None):
    """Stop a chain at its round limit, keeping the dispatch it held back so the owner can send it by continuing.

    `ask` is the host's request for more rounds ({"rounds": the rounds to add, "reason"}), shown to the owner to approve.
    Members sent along without being waited for (`detach`) are held with it: `names` then keeps {"to", "detach"}.
    """
    halt_chain(connection, room_id, chain_id, "budget")
    asked, reason = (ask["rounds"], ask["reason"]) if ask else (0, "")
    connection.execute("""INSERT INTO free_chain_holds (room_id,chain_id,message_id,host_id,names,handoff,asked_rounds,asked_reason)
        VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(room_id,chain_id) DO UPDATE SET message_id=excluded.message_id,host_id=excluded.host_id,names=excluded.names,
        handoff=excluded.handoff,asked_rounds=excluded.asked_rounds,asked_reason=excluded.asked_reason""",
                       (room_id, chain_id, message_id, host["id"], json.dumps({"to": list(names), "detach": list(detach)} if detach else list(names),
                                                                              ensure_ascii=False), int(handoff), asked, reason))


def wake_host(connection, room_id, chain_id, text, key):
    """Hand something the program noticed to the host once: a visible notice with a host request (`notice`) on it.

    Nothing happens without a present host or for a key already handed over; a continue (key `continue:`) also needs a
    round left in its chain and costs one. When the host already has a request waiting to be delivered, the notice only
    joins the transcript: that delivery reads it as a new message, so the host is not woken twice. Returns whether a
    notice was written.
    """
    host = connection.execute("SELECT id FROM room_members WHERE room_id=? AND role='host' AND status='active'", (room_id,)).fetchone()
    if not host or not chain_id or key.startswith(("continue:", "mention:")) and out_of_rounds(connection, room_id, chain_id):
        return False
    if connection.execute("SELECT 1 FROM free_host_wakes WHERE room_id=? AND key=?", (room_id, key)).fetchone():
        return False
    created_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    message_id = connection.execute("INSERT INTO messages(room_id,author,text,source,submission_id,created_at) VALUES(?,?,?,?,?,?)",
                                    (room_id, NOTICE_AUTHOR, text, "notice", f"notice-{key}", created_at)).lastrowid
    connection.execute("INSERT INTO message_details (message_id,kind,submitted_by) VALUES (?,?,?)", (message_id, "notice", NOTICE_AUTHOR))
    connection.execute("INSERT INTO free_host_wakes (room_id,key,chain_id,message_id) VALUES (?,?,?,?)", (room_id, key, chain_id, message_id))
    if not connection.execute("SELECT 1 FROM member_requests WHERE member_id=? AND status='pending'", (host["id"],)).fetchone():
        insert_request(connection, room_id, host["id"], message_id, chain_id, "notice", "system")
    return True


def wake_after_failure(connection, execution_id, requests, reason):
    """A member's execution failed on requests outside a host batch (a user's direct question): tell the host.

    The host's own failure wakes it once too, so the room does not stall until the owner looks; a failure while handling
    that very notice wakes nobody, so a host that cannot run (e.g. out of quota) is not woken in a loop. Discussion turns
    are left out: they have their own hand-back. A batch's failure reaches the host through settle_batches.
    """
    requests = [item for item in requests if not item["batch_id"]
                and not connection.execute("SELECT 1 FROM session_requests WHERE member_request_id=?", (item["id"],)).fetchone()]
    if not requests:
        return
    member = connection.execute("SELECT * FROM room_members WHERE id=?", (requests[0]["member_id"],)).fetchone()
    if member["role"] == "host":
        wake_after_own_failure(connection, member, execution_id, requests, reason)
        return
    name = member_display_names(connection, member["room_id"]).get(member["name"], member["name"])
    messages = "、".join(f"#{item['message_id']}" for item in requests)
    wake_host(connection, member["room_id"], max(item["chain_id"] for item in requests),
              f"{name} 处理 {messages} 的执行失败（执行 #{execution_id}）：{reason[:200]}。请主持人决定重试、改派还是告知用户。",
              f"failed:{execution_id}")


def wake_after_own_failure(connection, host, execution_id, requests, reason):
    """Tell the host its own execution failed, unless it failed on such a notice: it retries, resubmits or tells the user.

    A failed Goal wake-up is left to the Goal, which wakes again and counts failures in a row on its own.
    """
    marks = ",".join("?" * len(requests))
    if connection.execute(f"SELECT 1 FROM member_requests WHERE id IN ({marks}) AND purpose='goal_continue'",
                          [item["id"] for item in requests]).fetchone():
        return
    if connection.execute(f"SELECT 1 FROM free_host_wakes WHERE room_id=? AND key LIKE 'host_failed:%' AND message_id IN ({marks})",
                          (host["room_id"], *[item["message_id"] for item in requests])).fetchone():
        return
    messages = "、".join(f"#{item['message_id']}" for item in requests)
    wake_host(connection, host["room_id"], max(item["chain_id"] for item in requests),
              f"主持人处理 {messages} 的执行失败（执行 #{execution_id}）：{reason[:200]}。主持人请核对自己的会话：已有结果就用 --execution {execution_id} 补交原回答，"
              f"未做完就接着做完再这样补交（或 host-control retry --execution {execution_id} 重试），做不了时告知用户；最后用本次执行简短回复这条提醒。", f"host_failed:{execution_id}")


def remember_continue(connection, room_id, host, message_id, chain_id, payload):
    """The host's latest answer decides whether it continues once the room is idle: `continue` keeps its reason, none clears it."""
    if not payload.get("continue"):
        connection.execute("DELETE FROM free_host_continues WHERE room_id=?", (room_id,))
        return
    newest = connection.execute("SELECT COALESCE(MAX(id),0) FROM member_requests WHERE room_id=?", (room_id,)).fetchone()[0]
    connection.execute("""INSERT INTO free_host_continues (room_id,host_id,message_id,chain_id,reason,after_request) VALUES (?,?,?,?,?,?)
        ON CONFLICT(room_id) DO UPDATE SET host_id=excluded.host_id,message_id=excluded.message_id,chain_id=excluded.chain_id,
        reason=excluded.reason,after_request=excluded.after_request""",
                       (room_id, host["id"], message_id, chain_id, payload["continue"].strip(), newest))


def resume_host(connection, room_id):
    """Wake the host that asked to continue once nothing else is open; a later request for it already woke it."""
    row = connection.execute("SELECT * FROM free_host_continues WHERE room_id=?", (room_id,)).fetchone()
    if not row:
        return
    if connection.execute("SELECT 1 FROM member_requests WHERE room_id=? AND member_id=? AND id>?",
                          (room_id, row["host_id"], row["after_request"])).fetchone():
        connection.execute("DELETE FROM free_host_continues WHERE room_id=?", (room_id,))
        return
    if connection.execute("SELECT 1 FROM member_requests WHERE room_id=? AND status IN ('pending','delivering')", (room_id,)).fetchone():
        return
    connection.execute("DELETE FROM free_host_continues WHERE room_id=?", (room_id,))
    wake_host(connection, room_id, row["chain_id"], f"主持人续跑（接 #{row['message_id']}）：{row['reason']}", f"continue:{row['message_id']}")


def wake_for_mentions(connection, room_id):
    """A member's @ of the host wakes it at low priority: only once nothing else is open in the room.

    Skipped when the host got any request since that message (a batch hand-back, a newer owner message, a notice): it
    reads the message then. The wake belongs to the chain the member was answering (a proactive post starts its own) and
    needs a round left in it, so a member cannot keep the host going past the owner's limit.
    """
    host = connection.execute("SELECT id FROM room_members WHERE room_id=? AND role='host' AND status='active'", (room_id,)).fetchone()
    if not host or connection.execute("SELECT 1 FROM member_requests WHERE room_id=? AND status IN ('pending','delivering')",
                                      (room_id,)).fetchone():
        return
    for row in connection.execute("""SELECT s.message_id,m.author,m.created_at,
        COALESCE((SELECT MAX(r.chain_id) FROM member_requests r WHERE r.answer_id=s.message_id),s.message_id) AS chain_id
        FROM member_suggestions s JOIN messages m ON m.id=s.message_id
        WHERE m.room_id=? AND s.member_id=? AND NOT EXISTS(
            SELECT 1 FROM free_host_wakes w WHERE w.room_id=m.room_id AND w.key='mention:'||s.message_id)
        ORDER BY s.message_id""", (room_id, host["id"])).fetchall():
        key = f"mention:{row['message_id']}"
        if connection.execute("""SELECT 1 FROM member_requests WHERE member_id=? AND created_at>=CAST(strftime('%s',?) AS INTEGER)""",
                              (host["id"], row["created_at"])).fetchone():
            connection.execute("INSERT INTO free_host_wakes (room_id,key,chain_id,message_id) VALUES (?,?,?,?)",
                               (room_id, key, row["chain_id"], row["message_id"]))
            continue
        name = member_display_names(connection, room_id).get(row["author"], row["author"])
        wake_host(connection, room_id, row["chain_id"], f"{name} 在 #{row['message_id']} 中 @ 了主持人，请查看并处理。", key)


def dispatch(connection, room_id, host, message_id, names, chain_id, handoff=False, direct=False, plan=None, detach=None):
    """Queue the host's named members as one batch, one round; it hands back to the host when it ends.

    `direct` (the host's `no_handoff`) lets a one-member batch that completed reach the user without coming back; a
    failure still comes back. `plan` carries either `relay` (a relay's later step in the same pass: free, never held)
    or `need` (the host's `need_rounds`: {"rounds", "reason"}); a need above the rounds left stops the chain right away
    and asks the owner for the difference. Members in `detach` start with the batch but stay outside it: nothing waits for
    them, and a failure of theirs reaches the host like any request outside a batch.
    """
    plan = plan or {}
    member_ids = named_members(active_members(connection, room_id), names, exclude=host["name"])
    if not member_ids or not chain_id:
        return
    need = plan.get("need")
    remaining = None if plan.get("relay") else rounds_left(connection, room_id, chain_id)
    if remaining is not None and (remaining < 1 or need and remaining < need["rounds"]):
        ask = {"rounds": need["rounds"] - max(remaining, 0), "reason": need["reason"]} if need else None
        hold_dispatch(connection, room_id, host, message_id, names, chain_id, handoff, ask, detach)
        return
    for member_id in member_ids:
        insert_request(connection, room_id, member_id, message_id, chain_id, "ask", "host", batch_id=message_id)
    for member_id in named_members(active_members(connection, room_id), detach or [], exclude=host["name"]):
        insert_request(connection, room_id, member_id, message_id, chain_id, "ask", "host")
    connection.execute("INSERT INTO free_batches (room_id,batch_id,chain_id,host_id) VALUES (?,?,?,?)",
                       (room_id, message_id, chain_id, host["id"]))
    if plan.get("relay"):
        connection.execute("INSERT OR IGNORE INTO free_relay_steps (room_id,batch_id) VALUES (?,?)", (room_id, message_id))
    # Work handed out under a goal: when it ends and the room is idle, the host is woken to carry on.
    connection.execute("UPDATE room_goals SET armed=1 WHERE room_id=? AND status='active'", (room_id,))
    if handoff:
        connection.execute("INSERT INTO free_handoffs (room_id,batch_id) VALUES (?,?)", (room_id, message_id))
    if direct:
        connection.execute("INSERT INTO free_direct_batches (room_id,batch_id) VALUES (?,?)", (room_id, message_id))


def settle_batches(connection, room_id):
    """Hand each finished batch back to its host once, a failed one included; a batch that was only stopped halts its chain.

    Ends by waking a host that asked to continue once the room is idle.
    """
    for batch in connection.execute("SELECT * FROM free_batches WHERE room_id=? AND settled=0", (room_id,)).fetchall():
        statuses = [row[0] for row in connection.execute("SELECT status FROM member_requests WHERE room_id=? AND batch_id=?",
                                                          (room_id, batch["batch_id"]))]
        if any(status not in TERMINAL for status in statuses):
            continue
        connection.execute("UPDATE free_batches SET settled=1 WHERE room_id=? AND batch_id=?", (room_id, batch["batch_id"]))
        host = connection.execute("SELECT * FROM room_members WHERE id=? AND status='active' AND role='host'", (batch["host_id"],)).fetchone()
        sequence = connection.execute("SELECT * FROM free_sequences WHERE room_id=? AND batch_id=? AND status='running'",
                                      (room_id, batch["batch_id"])).fetchone()
        if sequence:
            advance_sequence(connection, room_id, sequence, host, "completed" in statuses, "failed" in statuses)
            continue
        review =connection.execute("SELECT 1 FROM review_plans WHERE room_id=? AND (batch_id=? OR review_batch_id=?)", (room_id, batch["batch_id"], batch["batch_id"])).fetchone()
        if not host or "completed" not in statuses and "failed" not in statuses:
            # Without a host nobody carries on; a batch that was only stopped (or whose members left) respects that stop.
            if "completed" not in statuses:
                halt_chain(connection, room_id, batch["chain_id"], "all_failed")
                if review and host:
                    insert_request(connection, room_id, host["id"], batch["batch_id"], batch["chain_id"], "handoff", "host")
            continue
        if "failed" not in statuses and connection.execute(
                "SELECT 1 FROM free_direct_batches WHERE room_id=? AND batch_id=?", (room_id, batch["batch_id"])).fetchone():
            # The host said this answer goes straight to the user.
            continue
        # Every other answer and every failure comes back to the host, so it can carry on, retry, reassign or tell the user.
        # The hand-back closes the round it belongs to, so it is never held back: the last round still gets its summary.
        if not connection.execute("SELECT 1 FROM member_requests WHERE message_id=? AND member_id=?", (batch["batch_id"], host["id"])).fetchone():
            insert_request(connection, room_id, host["id"], batch["batch_id"], batch["chain_id"], "handoff", "host")
        else:
            # The batch already came back once (it had failed) and the owner retried it: its new answers reach the host as a notice.
            retried = connection.execute("SELECT MAX(id) FROM member_requests WHERE room_id=? AND batch_id=?", (room_id, batch["batch_id"])).fetchone()[0]
            wake_host(connection, room_id, batch["chain_id"], f"#{batch['batch_id']} 派出的工作重试后已结束，请主持人接着处理。",
                      f"retried:{batch['batch_id']}:{retried}")
    advance_queues(connection, room_id)
    resume_host(connection, room_id)
    wake_for_mentions(connection, room_id)


def queue_in_turn(connection, room_id, message_id, member_ids):
    """Line the named members up for one owner message in the room's speaking order; only the first is asked now."""
    chosen = set(member_ids)
    members = [dict(row) for row in connection.execute("SELECT id,name,role FROM room_members WHERE room_id=?", (room_id,))]
    for member in default_order(connection, room_id, [member for member in members if member["id"] in chosen]):
        connection.execute("INSERT INTO free_queue (room_id,message_id,member_id) VALUES (?,?,?)", (room_id, message_id, member["id"]))
    advance_queues(connection, room_id)


def advance_queues(connection, room_id):
    """Ask the next queued member of each message whose previous request ended; members no longer present are skipped.

    Asked rows stay, so the speaking order can still show who already answered.
    """
    connection.execute("""DELETE FROM free_queue WHERE id IN (SELECT q.id FROM free_queue_waiting q WHERE q.room_id=?
        AND NOT EXISTS(SELECT 1 FROM room_members m WHERE m.id=q.member_id AND m.status='active'))""", (room_id,))
    connection.execute("""INSERT OR IGNORE INTO member_requests (room_id,member_id,message_id,chain_id,batch_id,purpose,created_by,created_at)
        SELECT q.room_id,q.member_id,q.message_id,q.message_id,0,'ask','user',? FROM free_queue_waiting q
        WHERE q.id IN (SELECT MIN(id) FROM free_queue_waiting WHERE room_id=? GROUP BY message_id)
        AND NOT EXISTS(SELECT 1 FROM member_requests r WHERE r.message_id=q.message_id AND r.status IN ('pending','delivering'))""",
                       (int(time.time()), room_id))


def checked_sequence(actor, payload):
    """Validate a host's one-after-another dispatch (optionally a loop) before its message is saved."""
    checked_detach(actor, payload)
    sequential, loop = payload.get("sequential", False), payload.get("loop", False)
    if payload.get("parallel") is not None and sequential is not True:
        raise ValueError("parallel 只与 sequential 一起使用")
    if payload.get("gates") is not None and sequential is not True:
        raise ValueError("gates 只与 sequential 一起使用")
    if not isinstance(actor, dict) or (sequential is False and loop is False):
        return
    if sequential is not True or type(loop) is not bool:
        raise ValueError("sequential 须为 true；loop 须为布尔值，且只与 sequential 一起使用")
    if actor["role"] != "host" or payload.get("kind") == "moderation":
        raise PermissionError("只有主持人派活时可以安排依次接力")
    names = payload.get("to") or []
    if len(names) < 2 or len(set(names)) != len(names):
        raise ValueError("依次接力须用 to 按顺序点名至少两位不同成员，每位只出现一次")
    if payload.get("next_review"):
        raise ValueError("依次接力不能同时声明预授权评审；评审者直接排进顺序即可")
    relay_gates(relay_order(names, payload.get("parallel")), payload.get("gates"), loop)


def checked_detach(actor, payload):
    """`detach`: members the host sends along with a dispatch without waiting for them; they are not among those in `to`."""
    detach = payload.get("detach")
    if detach is None:
        return
    if not isinstance(actor, dict) or actor["role"] != "host":
        raise PermissionError("只有主持人派活时可以带上不等待的成员")
    names = payload.get("to") or []
    if (not isinstance(detach, list) or not detach or any(not isinstance(name, str) for name in detach)
            or len(set(detach)) != len(detach)):
        raise ValueError("detach 须为不重复的成员名列表")
    if not names or set(detach) & set(names):
        raise ValueError("detach 须与 to 同用，且不包含 to 中的成员")


def relay_order(names, parallel):
    """The relay's steps from `to` and `parallel`: each step a list of names; a group named in `parallel` is one step.

    Each group lists at least two members who stand next to each other in `to`; a member belongs to at most one group.
    """
    if parallel is None:
        return [[name] for name in names]
    groups = parallel if isinstance(parallel, list) else None
    if not groups or any(not isinstance(group, list) or len(group) < 2 or len(set(group)) != len(group)
                         or any(name not in names for name in group) for group in groups):
        raise ValueError("parallel 须为若干组成员名，每组至少两位不同成员，且都在 to 中")
    grouped = [name for group in groups for name in group]
    if len(set(grouped)) != len(grouped):
        raise ValueError("parallel 中每位成员只能属于一组")
    steps, index = [], 0
    while index < len(names):
        group = next((group for group in groups if names[index] in group), None)
        if group is None:
            steps.append([names[index]])
            index += 1
            continue
        if set(names[index:index + len(group)]) != set(group):
            raise ValueError("parallel 的同一组成员须在 to 中相邻")
        steps.append(names[index:index + len(group)])
        index += len(group)
    return steps


def relay_gates(order, gates, loop=False):
    """`gates` by member name turned into step indexes: [{after, repeat_from, user?}], sorted by `after`.

    A gate hands back to the host after the step holding `after`; with `repeat_from` it is a loop's checkpoint whose next
    pass starts at the step holding that member, which may not reach back past the gate before it. `loop` already is a
    gate after the last step, so a gate there is refused alongside it. A `user` gate waits for the owner instead of the
    host: the owner's next unaddressed message carries the relay on (see `resume_user_gate`), so it needs somewhere to go.
    """
    if gates is None:
        return []
    if not isinstance(gates, list) or not gates or any(not isinstance(gate, dict) for gate in gates):
        raise ValueError("gates 须为检查点列表，每项为 {after, repeat_from?, user?}")
    step_of = {name: index for index, step in enumerate(order) for name in step}
    checked = []
    for gate in gates:
        after, repeat_from, user = gate.get("after"), gate.get("repeat_from"), gate.get("user", False)
        if after not in step_of or repeat_from is not None and repeat_from not in step_of:
            raise ValueError("gates 的 after 与 repeat_from 须是 to 中的成员")
        if type(user) is not bool:
            raise ValueError("gates 的 user 须为布尔值")
        if user and repeat_from is None and step_of[after] == len(order) - 1:
            raise ValueError("等用户的检查点在最后一棒之后须带 repeat_from，否则用户发言后没有下一棒")
        checked.append({"after": step_of[after], "repeat_from": None if repeat_from is None else step_of[repeat_from],
                        **({"user": True} if user else {})})
    checked.sort(key=lambda gate: gate["after"])
    afters = [gate["after"] for gate in checked]
    if len(set(afters)) != len(afters):
        raise ValueError("同一棒之后只能有一个检查点")
    if loop and afters[-1] == len(order) - 1:
        raise ValueError("loop 已在最后一棒之后设了检查点，gates 不能再设在最后一棒")
    for index, gate in enumerate(checked):
        start = checked[index - 1]["after"] + 1 if index else 0
        if gate["repeat_from"] is not None and not start <= gate["repeat_from"] <= gate["after"]:
            raise ValueError("循环检查点的 repeat_from 须在本段内：不早于前一个检查点之后的第一棒，不晚于 after")
    return checked


def sequence_gates(sequence):
    """The relay's gates by step index, the loop's checkpoint after the last step included."""
    gates = json.loads(sequence["gates"] or "[]")
    last = len(relay_steps(sequence)) - 1
    if sequence["loop"] and not any(gate["after"] == last for gate in gates):
        gates = gates + [{"after": last, "repeat_from": 0}]
    return gates


def current_gate(sequence):
    """The gate the relay stands at or heads for: the first one at or after its current step."""
    return next((gate for gate in sequence_gates(sequence) if gate["after"] >= sequence["position"]), None)


def relay_steps(sequence):
    """The relay's steps as lists of member ids; a step stored as one id (single member) reads as a one-member list."""
    return [step if isinstance(step, list) else [step] for step in json.loads(sequence["member_ids"])]


def stored_step(member_ids):
    """How a step is kept in `member_ids` and `steps`: one member as its id, as before groups existed; a group as a list."""
    return member_ids[0] if len(member_ids) == 1 else member_ids


def start_sequence(connection, room_id, host, message_id, names, chain_id, loop, need=None, parallel=None, detach=None, gates=None):
    """Start a host's one-after-another dispatch with its first step; the rest follow as each step ends.

    A step named in `parallel` is a group: its members work at once and the relay goes on only after all of them end.
    `gates` hand back to the host after the steps they name (see `relay_gates`).
    """
    active = active_members(connection, room_id)
    named_members(active, names, exclude=host["name"])
    if not chain_id:
        return
    order = relay_order(names, parallel)
    steps = [stored_step([active[name]["id"] for name in step]) for step in order]
    connection.execute("""INSERT INTO free_sequences (room_id,message_id,chain_id,host_id,member_ids,loop,batch_id,steps,gates)
        VALUES (?,?,?,?,?,?,?,?,?)""", (room_id, message_id, chain_id, host["id"], json.dumps(steps), int(loop), message_id,
                                        json.dumps([[1, steps[0], message_id, 0]]), json.dumps(relay_gates(order, gates, loop))))
    dispatch(connection, room_id, host, message_id, order[0], chain_id, plan={"need": need}, detach=detach)


def sequence_step(connection, room_id, sequence, host, position, pass_number, message_id, new_round=None):
    """Ask the members still here of the step at `position`, hung on `message_id`; one step is one batch.

    A pass's first step, or the first after the host lets a gate go on (`new_round`), costs one round (or waits at the
    limit); later steps ride on it.
    """
    present = {row["id"]: name for name, row in active_members(connection, room_id).items()}
    member_ids = [member_id for member_id in relay_steps(sequence)[position] if member_id in present]
    steps = json.loads(sequence["steps"]) + [[pass_number, stored_step(member_ids), message_id, position]]
    connection.execute("UPDATE free_sequences SET status='running',pass=?,position=?,batch_id=?,steps=? WHERE id=?",
                       (pass_number, position, message_id, json.dumps(steps), sequence["id"]))
    dispatch(connection, room_id, host, message_id, [present[member_id] for member_id in member_ids], sequence["chain_id"],
             plan={"relay": not (pass_number != sequence["pass"] if new_round is None else new_round)})


def next_present(connection, room_id, sequence, start):
    """The first position from `start` with a member still here who can be asked; steps whose members all left are skipped."""
    present = {row["id"] for row in active_members(connection, room_id).values()}
    return next((index for index, step in enumerate(relay_steps(sequence)) if index >= start and present.intersection(step)), None)


def advance_sequence(connection, room_id, sequence, host, completed, failed=False):
    """Pass a finished step on to the next one; after the last one hand back to the host, as a checkpoint for a loop.

    A step nobody completed ends the sequence. A failed step, a group step with one member failed included, is told to
    the present host, which decides what follows (retrying the failure carries the relay on); a stopped one (or one whose
    members left) halts the chain like any stopped batch.
    """
    if not completed or failed or not host or host["id"] != sequence["host_id"]:
        if failed and host:
            wake_host(connection, room_id, sequence["chain_id"], f"依次派活 #{sequence['message_id']} 在第 {sequence['position'] + 1} 棒失败，"
                      "接力已停下。请主持人决定重试、改派还是告知用户。", f"sequence:{sequence['id']}:{sequence['batch_id']}")
        elif not completed:
            halt_chain(connection, room_id, sequence["chain_id"], "all_failed")
        connection.execute("UPDATE free_sequences SET status='stopped' WHERE id=?", (sequence["id"],))
        return
    answer_id = connection.execute("""SELECT answer_id FROM member_requests WHERE room_id=? AND batch_id=? AND purpose='ask'
        AND status='completed' ORDER BY id DESC""", (room_id, sequence["batch_id"])).fetchone()[0]
    position = next_present(connection, room_id, sequence, sequence["position"] + 1)
    end = len(relay_steps(sequence)) if position is None else position
    # A gate after this step, or after steps skipped because their members left, stops the relay there for the host.
    gate = next((gate for gate in sequence_gates(sequence) if sequence["position"] <= gate["after"] < end), None)
    if position is not None and not gate:
        sequence_step(connection, room_id, sequence, host, position, sequence["pass"], answer_id)
        return
    if gate and gate.get("user"):
        # Waiting for the owner: a checkpoint without a hand-back request. Their next unaddressed message carries it on.
        connection.execute("UPDATE free_sequences SET status='checkpoint',answer_id=?,handoff_request=0,position=? WHERE id=?",
                           (answer_id, gate["after"], sequence["id"]))
        return
    insert_request(connection, room_id, host["id"], sequence["batch_id"], sequence["chain_id"], "handoff", "host")
    request_id = connection.execute("SELECT last_insert_rowid()").fetchone()[0]
    connection.execute("UPDATE free_sequences SET status=?,answer_id=?,handoff_request=?,position=? WHERE id=?",
                       ("checkpoint" if gate else "done", answer_id, request_id, gate["after"] if gate else sequence["position"],
                        sequence["id"]))


def sequence_view(connection, room_id, sequence_id, token):
    """The loop's plan and this pass's answers in full, for the host or the owner deciding at a checkpoint; it dispatches nothing."""
    try:
        require_owner(connection, room_id, token)
    except PermissionError:
        if require_member(connection, room_id, token)["role"] != "host":
            raise PermissionError("只有房主或当前主持人可读取依次接力")
    row = connection.execute("SELECT * FROM free_sequences WHERE room_id=? AND id=?", (room_id, sequence_id)).fetchone()
    if not row:
        raise LookupError("依次接力不存在")
    names = {item["id"]: item["name"] for item in connection.execute("SELECT id,name FROM room_members WHERE room_id=?", (room_id,))}
    origin = connection.execute("SELECT id,author,text FROM messages WHERE id=?", (row["message_id"],)).fetchone()
    answers = []
    # This pass of the stretch the relay is in: steps after the gate before it; older rows lack the step's position.
    start = max((gate["after"] + 1 for gate in sequence_gates(row) if gate["after"] < row["position"]), default=0)
    steps_of_pass = [(entry[3] + 1 if len(entry) > 3 else None, entry[1], entry[2]) for entry in json.loads(row["steps"])
                     if entry[0] == row["pass"] and (len(entry) < 4 or entry[3] >= start)]
    for counted, (position, member_ids, batch_id) in enumerate(steps_of_pass, 1):
        step_number = position or counted
        for member_id in member_ids if isinstance(member_ids, list) else [member_ids]:
            answer = connection.execute("""SELECT r.status,m.id,m.text FROM member_requests r LEFT JOIN messages m ON m.id=r.answer_id
                WHERE r.room_id=? AND r.batch_id=? AND r.member_id=? AND r.purpose='ask'""", (room_id, batch_id, member_id)).fetchone()
            answers.append({"member": names.get(member_id), "step": step_number, "status": answer["status"] if answer else "waiting",
                            "message_id": answer["id"] if answer else None, "text": answer["text"] if answer else None})
    handoff = connection.execute("SELECT status FROM member_requests WHERE id=?", (row["handoff_request"],)).fetchone()
    return {"id": row["id"], "message_id": row["message_id"], "order": order_names(row, names),
            "loop": bool(row["loop"]), "pass": row["pass"], "position": row["position"], "status": row["status"],
            "gates": sequence_gates(row), "gate": gate_view(row) if row["status"] == "checkpoint" else None,
            "chain_id": row["chain_id"], "remaining_rounds": rounds_left(connection, room_id, row["chain_id"]),
            "handoff_request": row["handoff_request"] or None, "handoff_status": handoff[0] if handoff else None,
            "origin": dict(origin) if origin else None, "answers": answers}


def gate_view(sequence):
    """The gate the relay stands at, as the host decides on it: where another pass starts and whether it may go on."""
    gate = current_gate(sequence)
    if not gate:
        return None
    return {"after": gate["after"] + 1, "repeat_from": None if gate["repeat_from"] is None else gate["repeat_from"] + 1,
            "can_proceed": gate["after"] < len(relay_steps(sequence)) - 1, **({"user": True} if gate.get("user") else {})}


def order_names(sequence, names):
    """The relay's order by name: a one-member step as the name, a group step as the list of its members' names."""
    return [names.get(step[0]) if len(step) == 1 else [names.get(item) for item in step] for step in relay_steps(sequence)]


def continue_sequence(connection, room_id, token, payload):
    """Run a loop's next pass from its checkpoint, closing only that hand-back; bound to the one checkpoint request.

    The host calls it (smart scheduling with the host's credential when it judges the loop should go on); the first
    member present starts the pass on the last answer, and the round limit still holds it back like any dispatch.
    """
    begin_write(connection)
    host = require_member(connection, room_id, token, payload.get("actor"))
    if host["role"] != "host":
        raise PermissionError("只有当前主持人可以继续循环")
    request_id = payload.get("request_id")
    if type(request_id) is not int:
        raise ValueError("须提供检查点交接请求 request_id")
    proceed = payload.get("proceed", False)
    if type(proceed) is not bool:
        raise ValueError("proceed 须为布尔值")
    sequence = connection.execute("SELECT * FROM free_sequences WHERE room_id=? AND handoff_request=?", (room_id, request_id)).fetchone()
    if not sequence or sequence["status"] == "done" or not sequence_gates(sequence):
        raise LookupError("该请求不是依次接力的检查点")
    request = connection.execute("SELECT * FROM member_requests WHERE id=?", (request_id,)).fetchone()
    if sequence["status"] == "running" and request["status"] == "completed":
        execution = connection.execute("SELECT status FROM member_executions WHERE id=?", (request["execution_id"],)).fetchone()
        return {"sequence_id": sequence["id"], "pass": sequence["pass"], "duplicate": True,
                "execution_completed": bool(execution and execution[0] == "completed")}
    if sequence["status"] != "checkpoint" or request["status"] not in ("pending", "delivering") or request["member_id"] != host["id"]:
        raise FileExistsError("这个检查点已处理、循环已结束，或主持人已更换")
    gate = current_gate(sequence)
    repeat = gate["repeat_from"] is not None and not proceed
    if not repeat and gate["after"] >= len(relay_steps(sequence)) - 1:
        raise ValueError("这是最后一棒之后的检查点，没有下一棒；直接回答即结束接力")
    position = next_present(connection, room_id, sequence, gate["repeat_from"] if repeat else gate["after"] + 1)
    if position is None:
        raise FileExistsError("后面的成员都已离开，无法继续")
    connection.execute("UPDATE member_requests SET status='completed' WHERE id=?", (request_id,))
    completed = finish_review_handoff(connection, request, "sequence_continued")
    # Another pass counts on; going on past a gate starts the next stretch at its first pass. Either costs one round.
    pass_number = sequence["pass"] + 1 if repeat else 1
    sequence_step(connection, room_id, sequence, host, position, pass_number, sequence["answer_id"], new_round=True)
    return {"sequence_id": sequence["id"], "pass": pass_number, "proceeded": not repeat, "duplicate": False, "execution_completed": completed}


def resume_user_gate(connection, room_id, message_id, payload):
    """Carry on the relay waiting at a user gate with the owner's unaddressed message; True when it did.

    The message becomes the next step's message, so that member reads it first, and starts a new chain like any owner
    message: the step costs a round of it. A gate with `repeat_from` runs its stretch again, one without goes on. A relay
    whose host changed, or whose remaining members all left, stops, and the message is routed as usual.
    """
    if payload.get("to") is not None:
        return False
    sequence = connection.execute("SELECT * FROM free_sequences WHERE room_id=? AND status='checkpoint' AND handoff_request=0 ORDER BY id DESC", (room_id,)).fetchone()
    if not sequence:
        return False
    host = connection.execute("SELECT * FROM room_members WHERE id=? AND status='active' AND role='host'", (sequence["host_id"],)).fetchone()
    gate = current_gate(sequence)
    repeat = bool(gate) and gate["repeat_from"] is not None
    position = next_present(connection, room_id, sequence, gate["repeat_from"] if repeat else gate["after"] + 1) if gate and host else None
    if position is None:
        connection.execute("UPDATE free_sequences SET status='stopped' WHERE id=?", (sequence["id"],))
        return False
    connection.execute("UPDATE free_sequences SET chain_id=? WHERE id=?", (message_id, sequence["id"]))
    sequence = connection.execute("SELECT * FROM free_sequences WHERE id=?", (sequence["id"],)).fetchone()
    sequence_step(connection, room_id, sequence, host, position, sequence["pass"] + 1 if repeat else 1, message_id, new_round=True)
    return True


def sequence_request_context(connection, request):
    """Where a request sits in a host's one-after-another dispatch: a step, the hand-back after the last one, or a loop's checkpoint."""
    row = connection.execute("SELECT room_id,member_id,batch_id,purpose FROM member_requests WHERE id=?", (request["id"],)).fetchone()
    if not row:
        return {}
    if row["purpose"] == "handoff":
        sequence = connection.execute("SELECT * FROM free_sequences WHERE handoff_request=?", (request["id"],)).fetchone()
    elif row["purpose"] == "ask" and row["batch_id"]:
        sequence = connection.execute("SELECT * FROM free_sequences WHERE room_id=? AND batch_id=?", (row["room_id"], row["batch_id"])).fetchone()
    else:
        return {}
    if not sequence:
        return {}
    names = {item["id"]: item["name"] for item in connection.execute("SELECT id,name FROM room_members WHERE room_id=?", (row["room_id"],))}
    steps = relay_steps(sequence)
    order = order_names(sequence, names)
    gate = current_gate(sequence) if row["purpose"] == "handoff" and sequence["status"] == "checkpoint" else None
    phase = "step" if row["purpose"] == "ask" else "end" if not gate else "checkpoint" if gate["repeat_from"] is not None else "gate"
    position = next((index for index, step in enumerate(steps) if row["member_id"] in step), None) if phase == "step" \
        else gate["after"] if gate else len(order) - 1
    if position is None:
        return {}
    following = order[position + 1] if phase == "step" and position + 1 < len(order) else None
    together = [names.get(item) for item in steps[position] if item != row["member_id"]] if phase == "step" else []
    return {"sequence": {"id": sequence["id"], "message_id": sequence["message_id"], "order": order, "loop": bool(sequence["loop"]),
                         "pass": sequence["pass"], "position": position, "phase": phase, "next": following,
                         **({"together": together} if together else {}), "answer_id": sequence["answer_id"] or None,
                         **({"gate": gate_view(sequence)} if gate else {})}}


def default_order(connection, room_id, members):
    """Members in the room's saved speaking order; without one (or for members it lacks), the host first, then by joining order."""
    row = connection.execute("SELECT member_ids FROM speaking_orders WHERE room_id=?", (room_id,)).fetchone()
    rank = {member_id: index for index, member_id in enumerate(json.loads(row[0]) if row else [])}
    return sorted(members, key=lambda member: (member["id"] not in rank, rank.get(member["id"], 0), member["role"] != "host", member["id"]))


def speaking_order(connection, room):
    """Who spoke, who speaks now and who is next; only the not-yet-spoken part may be reordered.

    Without an open discussion the room shows its latest unfinished one-after-another queue, else every member in the room's
    default order; an open discussion shows its open round: speakers so far, the current speaker, then this round's queued
    speakers; a plan reaching into later rounds lists them apart in `later` (one name list per round), read-only. The
    revision changes with any of it.
    """
    active = [member for member in room["members"] if member["status"] == "active"]
    by_id = {member["id"]: member for member in active}
    ordered = [member["name"] for member in default_order(connection, room["id"], active)]
    items, kind, target, later = [], "default", 0, []
    session_plan_state = []
    session = discussion.current_session(connection, room["id"], active_only=True)
    if session:
        kind = "turns"
        target = session["id"]
        items, later, session_plan_state = discussion.session_speaking_order(connection, session)
    sequence = None if session else open_sequence(connection, room["id"])
    if sequence:
        # A host's one-after-another dispatch shows like a queue: this pass's members, done up to the one asked now.
        kind, target = "queue", sequence["message_id"]
        for index, step in enumerate(relay_steps(sequence)):
            at_gate = sequence["status"] == "checkpoint" and index == sequence["position"]
            state = "done" if at_gate or index < sequence["position"] else "speaking" if index == sequence["position"] else "queued"
            for member_id in step:
                if member_id in by_id:
                    # Members of a group step share its number: they work at once.
                    items.append({"name": by_id[member_id]["name"], "state": state, **({"step": index + 1} if len(step) > 1 else {})})
    elif not session:
        target = connection.execute("""SELECT MAX(message_id) FROM (
            SELECT MAX(message_id) AS message_id FROM free_queue_waiting WHERE room_id=?
            UNION ALL SELECT MAX(r.message_id) FROM member_requests r WHERE r.room_id=? AND r.status IN ('pending','delivering')
            AND EXISTS(SELECT 1 FROM free_queue q WHERE q.message_id=r.message_id AND q.member_id=r.member_id))""",
            (room["id"], room["id"])).fetchone()[0] or 0
        if target:
            kind = "queue"
            for row in connection.execute("""SELECT q.member_id,r.status FROM free_queue q LEFT JOIN member_requests r
                ON r.message_id=q.message_id AND r.member_id=q.member_id WHERE q.message_id=? ORDER BY q.id""", (target,)):
                if row["member_id"] in by_id:
                    state = "queued" if row["status"] is None else "speaking" if row["status"] in ("pending", "delivering") else "done"
                    items.append({"name": by_id[row["member_id"]]["name"], "state": state})
    listed = {item["name"] for item in items}
    items += [{"name": name, "state": "idle"} for name in dict.fromkeys(ordered) if name not in listed]
    # A relay with gates in it keeps its order: moving members would shift where the gates stand.
    movable = "none" if sequence and json.loads(sequence["gates"] or "[]") else "queued" if kind != "default" else "idle"
    relay = {"id": sequence["id"], "loop": any(gate["repeat_from"] is not None for gate in sequence_gates(sequence)),
             "pass": sequence["pass"], **({"waiting_user": True} if sequence["status"] == "checkpoint" and not sequence["handoff_request"] else {})} if sequence else None
    state = json.dumps([kind, target, [[item["name"], item["state"], item.get("step")] for item in items], later, session_plan_state, relay],
                       ensure_ascii=False)
    return {"kind": kind, "message_id": target, "items": items, "later": later, "movable": [item["name"] for item in items if item["state"] == movable],
            "default": [member["name"] for member in default_order(connection, room["id"], active)],
            **({"sequence": relay} if relay else {}),
            "revision": hashlib.sha256(state.encode("utf-8")).hexdigest()[:12]}


def open_sequence(connection, room_id):
    """The room's latest one-after-another dispatch still running, or waiting at its checkpoint for the host or the owner."""
    return connection.execute("""SELECT s.* FROM free_sequences s WHERE s.room_id=? AND (s.status='running' OR s.status='checkpoint' AND s.handoff_request=0
        OR s.status='checkpoint' AND EXISTS(SELECT 1 FROM member_requests r WHERE r.id=s.handoff_request AND r.status IN ('pending','delivering')))
        ORDER BY s.id DESC""", (room_id,)).fetchone()


def reorder_speakers(connection, room, token, payload):
    """Owner reorders the not-yet-spoken part of the speaking order; who already spoke or speaks now stays put.

    Read the speaking order first and send its revision: a missing revision is refused, a changed one conflicts,
    and the new order must list exactly the movable members.
    """
    require_owner(connection, room["id"], token)
    current = room["speaking_order"]
    if payload.get("revision") is None:
        raise ValueError("调整发言顺序前须先读取最新顺序（speaking-order），并带上其 revision")
    if payload["revision"] != current["revision"]:
        raise FileExistsError("发言顺序已变化，请重新读取后再调整")
    order = payload.get("order")
    movable = current["movable"]
    if not isinstance(order, list) or sorted(map(str, order)) != sorted(movable):
        given = [str(name) for name in order] if isinstance(order, list) else []
        missing = [name for name in dict.fromkeys(movable) if given.count(name) < movable.count(name)]
        extra = [name for name in dict.fromkeys(given) if movable.count(name) < given.count(name)]
        raise ValueError("新顺序须恰好包含尚未发言的成员" + (f"；缺少：{'、'.join(missing)}" if missing else "") + (f"；多出：{'、'.join(extra)}" if extra else ""))
    names = {member["name"]: member["id"] for member in room["members"] if member["status"] == "active"}
    if current.get("sequence"):
        # Later passes of a loop keep the new order too; a group moves as one step, placed where its first member is
        # named; steps whose members all left stay in place at the end.
        sequence = connection.execute("SELECT * FROM free_sequences WHERE id=?", (current["sequence"]["id"],)).fetchone()
        steps = relay_steps(sequence)
        kept, rest, moved = steps[:sequence["position"] + 1], steps[sequence["position"] + 1:], []
        for name in order:
            step = next(step for step in rest if names[name] in step)
            if step not in moved:
                moved.append(step)
        steps = kept + moved + [step for step in rest if step not in moved]
        connection.execute("UPDATE free_sequences SET member_ids=? WHERE id=?",
                           (json.dumps([stored_step(step) for step in steps]), sequence["id"]))
    elif current["kind"] == "queue":
        connection.execute(f"DELETE FROM free_queue WHERE message_id=? AND NOT {QUEUE_ASKED.format(row='free_queue')}", (current["message_id"],))
        for name in order:
            connection.execute("INSERT INTO free_queue (room_id,message_id,member_id) VALUES (?,?,?)", (room["id"], current["message_id"], names[name]))
    elif current["kind"] == "turns":
        discussion.reorder_session_turns(connection, discussion.current_session(connection, room["id"], active_only=True), order, names)
    else:
        connection.execute("INSERT OR REPLACE INTO speaking_orders (room_id,member_ids) VALUES (?,?)",
                           (room["id"], json.dumps([names[name] for name in order])))


# A request from an owner message that named the host alone: a side question, which must not move the chain of work it lands beside.
SIDE_QUESTION = """(member_requests.purpose='ask' AND member_requests.created_by='user'
    AND member_requests.member_id IN (SELECT id FROM room_members WHERE role='host')
    AND NOT EXISTS (SELECT 1 FROM member_requests other WHERE other.message_id=member_requests.message_id AND other.id<>member_requests.id))"""
ANSWERED_CHAIN = f"COALESCE(MAX(CASE WHEN NOT {SIDE_QUESTION} THEN chain_id END),MAX(chain_id))"


def answered_chain(connection, payload, actor):
    """The chain an answer continues: the newest chain among the requests it completes, side questions only when alone."""
    if actor["access"] == "manual":
        ids = payload.get("request_ids") or [0]
        marks = ",".join("?" * len(ids))
        row = connection.execute(f"SELECT {ANSWERED_CHAIN} FROM member_requests WHERE id IN ({marks})", ids).fetchone()
    else:
        row = connection.execute(f"SELECT {ANSWERED_CHAIN} FROM member_requests WHERE execution_id=?", (payload["execution_id"],)).fetchone()
    return row[0] or 0


def after_free_message(connection, room_id, message_id, actor, payload):
    """Create requests for the owner's message, or close what the member's answer covers."""
    now = int(time.time())
    if actor == "用户":
        # New owner input lets an active goal wake the host again once the room falls idle, and answers whatever the
        # host was waiting on: the goal is back to being worked on and a later pending gets its fallback again.
        connection.execute("""UPDATE room_goals SET armed=1,phase='doing',phase_note='',phase_until=0,pending_fallback=0
            WHERE room_id=? AND status='active'""", (room_id,))
        # It also replaces whatever the host meant to continue with.
        connection.execute("DELETE FROM free_host_continues WHERE room_id=?", (room_id,))
        if discussion.hold_user_message(connection, room_id, message_id, payload):
            return
        if resume_user_gate(connection, room_id, message_id, payload):
            return
        pairs = recipients(connection, room_id, payload)
        if payload.get("sequential") is True and payload.get("to") is not None:
            queue_in_turn(connection, room_id, message_id, [member_id for member_id, _ in pairs])
            return
        for member_id, purpose in pairs:
            insert_request(connection, room_id, member_id, message_id, message_id, purpose, "user")
        return
    chain_id = answered_chain(connection, payload, actor)
    if actor["access"] == "manual":
        for request_id in payload.get("request_ids", []):
            connection.execute("UPDATE member_requests SET status='completed',answer_id=? WHERE id=?", (message_id, request_id))
    else:
        execution_id = payload["execution_id"]
        connection.execute("UPDATE member_executions SET status='completed',finished_at=?,result=? WHERE id=?",
                           (now, f"message:{message_id}", execution_id))
        connection.execute("UPDATE member_requests SET status='completed',answer_id=? WHERE execution_id=? AND status='delivering'",
                           (message_id, execution_id))
    connection.execute("UPDATE room_members SET read_until=MAX(read_until,?) WHERE id=?", (message_id, actor["id"]))
    if actor["role"] == "host" and payload.get("to") and payload.get("sequential") is True:
        start_sequence(connection, room_id, actor, message_id, payload["to"], chain_id, payload.get("loop") is True, need_plan(payload),
                       payload.get("parallel"), payload.get("detach"), payload.get("gates"))
    elif actor["role"] == "host" and payload.get("to"):
        dispatch(connection, room_id, actor, message_id, payload["to"], chain_id, payload.get("handoff") is True or bool(payload.get("next_review")),
                 payload.get("no_handoff") is True, {"need": need_plan(payload)}, payload.get("detach"))
    if actor["role"] == "host":
        remember_continue(connection, room_id, actor, message_id, chain_id, payload)
    settle_batches(connection, room_id)


def expire_executions(connection, room_id):
    """Fail executions whose lease lapsed; their requests stay visible as failed, never silently retried."""
    now = int(time.time())
    stale = connection.execute(
        "SELECT id FROM member_executions WHERE room_id=? AND status IN ('dispatched','started') AND lease_until<=?", (room_id, now)).fetchall()
    for row in stale:
        finish_execution(connection, row["id"], "failed", "执行租约到期，接入程序未续租", "failed")
    if stale:
        settle_batches(connection, room_id)


def notice_stalled_executions(connection, room_id):
    """Tell the host about members whose software has shown no new output for STALL_SECONDS.

    Executions have no time limit and the runner keeps renewing a hung one, so nothing else would notice. The host
    decides whether to wait, steer, interrupt or replace; its own executions are left out, since it cannot read a notice
    while it runs. A later quiet spell after new output is reported again.
    """
    now = int(time.time())
    rows = connection.execute("""SELECT e.id,e.activity_at,e.created_at,m.name,
        (SELECT MAX(chain_id) FROM member_requests WHERE execution_id=e.id) AS chain_id
        FROM member_executions e JOIN room_members m ON m.id=e.member_id
        WHERE e.room_id=? AND e.status IN ('dispatched','started') AND m.role<>'host' AND MAX(e.activity_at,e.created_at)<=?""",
                              (room_id, now - STALL_SECONDS)).fetchall()
    for row in rows:
        quiet = max(row["activity_at"], row["created_at"])
        text = (f"{row['name']} 的执行 #{row['id']} 已 {(now - quiet) // 60} 分钟没有新输出，可能卡住。"
                f"先读这次执行的详情判断，再决定等待、插话、打断、重试或换人。")
        wake_host(connection, room_id, row["chain_id"], text, f"stall:{row['id']}:{quiet}")


def record_cancel_reasons(connection, where, params, reason):
    """Remember why requests are about to be cancelled; call before the status change selects them."""
    connection.execute(f"INSERT OR REPLACE INTO request_cancel_reasons (request_id,reason) SELECT id,? FROM member_requests WHERE {where}", (reason, *params))


def finish_execution(connection, execution_id, status, result, request_status, cancel_reason=""):
    """End one execution and move its delivered requests in the same transaction."""
    if request_status == "cancelled" and cancel_reason:
        record_cancel_reasons(connection, "execution_id=? AND status='delivering'", (execution_id,), cancel_reason)
    discussion_requests = discussion.open_discussion_requests(connection, execution_id)
    delivered = connection.execute("""SELECT id,member_id,message_id,chain_id,batch_id FROM member_requests
        WHERE execution_id=? AND status='delivering'""", (execution_id,)).fetchall() if request_status == "failed" else []
    connection.execute("UPDATE member_executions SET status=?,finished_at=?,result=? WHERE id=? AND status IN ('dispatched','started')",
                       (status, int(time.time()), result[:500], execution_id))
    connection.execute("UPDATE member_requests SET status=?,execution_id=CASE WHEN ?='pending' THEN NULL ELSE execution_id END WHERE execution_id=? AND status='delivering'",
                       (request_status, request_status, execution_id))
    if status == "failed" and request_status == "failed":
        for row in discussion_requests:
            discussion.fail_session_request(connection, row["id"], result)
    if delivered:
        wake_after_failure(connection, execution_id, delivered, result)


def open_route_messages(connection, member_id, pending_only=False):
    """(message, purpose) of host requests still open, in order; they need a new host if this one leaves."""
    states = "'pending'" if pending_only else "'pending','delivering'"
    return [(row[0], row[1]) for row in connection.execute(
        f"""SELECT message_id,purpose FROM member_requests WHERE member_id=? AND purpose IN ('route','group')
        AND status IN ({states}) ORDER BY message_id""", (member_id,))]


def hand_over_routes(connection, room_id, routes, departed_id):
    """Ask the current host to route messages left behind by the previous host."""
    host = connection.execute("SELECT id FROM room_members WHERE room_id=? AND role='host' AND status='active' AND id<>?",
                              (room_id, departed_id or 0)).fetchone()
    for message_id, purpose in routes if host else []:
        connection.execute("""INSERT OR IGNORE INTO member_requests (room_id,member_id,message_id,chain_id,purpose,created_by,created_at)
            VALUES (?,?,?,?,?,'user',?)""", (room_id, host["id"], message_id, message_id, purpose, int(time.time())))


def stop_member_work(connection, member_id, reason, cancel_reason, keep_pending=False):
    """Void a member's live execution and, unless `keep_pending`, every open request, so nothing restarts by itself.

    The owner's stop keeps the requests that arrived while the member worked: like interrupting a turn, the member then
    goes on to the messages sent after it, while a member that leaves drops them all.
    """
    for row in connection.execute("SELECT id FROM member_executions WHERE member_id=? AND status IN ('dispatched','started')",
                                  (member_id,)).fetchall():
        finish_execution(connection, row["id"], "cancelled", reason, "cancelled", cancel_reason)
    if not keep_pending:
        record_cancel_reasons(connection, "member_id=? AND status='pending'", (member_id,), cancel_reason)
        connection.execute("UPDATE member_requests SET status='cancelled' WHERE member_id=? AND status='pending'", (member_id,))
    discussion.after_member_stopped(connection, member_id)


def stop_room(connection, room_id, token):
    """Owner stops the whole free room: every live execution, open request and queued turn ends, so nothing restarts by itself.

    Bound to the room alone, so it takes no revision; a running discussion is refused, since pausing it is how it stops.
    """
    require_owner(connection, room_id, token)
    begin_write(connection)
    if discussion.current_session(connection, room_id, active_only=True):
        raise FileExistsError("讨论进行中，请用暂停或结束讨论")
    connection.execute("DELETE FROM free_queue WHERE room_id=?", (room_id,))
    pause_queue(connection, room_id)
    stop_room_work(connection, room_id, "用户停止全部", "user_stop")
    return free_view(connection, room_id)


def stop_room_work(connection, room_id, reason, cancel_reason):
    """Void every live execution and open request of a room, e.g. when it is archived."""
    for row in connection.execute("SELECT id FROM member_executions WHERE room_id=? AND status IN ('dispatched','started')",
                                  (room_id,)).fetchall():
        finish_execution(connection, row["id"], "cancelled", reason, "cancelled", cancel_reason)
    record_cancel_reasons(connection, "room_id=? AND status='pending'", (room_id,), cancel_reason)
    connection.execute("UPDATE member_requests SET status='cancelled' WHERE room_id=? AND status='pending'", (room_id,))
    # Stopping everything also stops a goal, the host's own "continue" or its timed check-in from waking the host again.
    connection.execute("DELETE FROM free_host_continues WHERE room_id=?", (room_id,))
    connection.execute("DELETE FROM free_host_checkins WHERE room_id=?", (room_id,))
    connection.execute("UPDATE room_goals SET status='paused',paused_at=? WHERE room_id=? AND status='active'", (int(time.time()), room_id))
    # A relay waiting for the owner has nothing running to cancel; stopping everything ends it too.
    connection.execute("UPDATE free_sequences SET status='stopped' WHERE room_id=? AND status='checkpoint' AND handoff_request=0", (room_id,))
    settle_batches(connection, room_id)


def withdraw_dispatch(connection, room_id, token, message_id):
    """Take back one of the present host's dispatches: its relay or loop stops, waiting steps are cancelled, running ones
    stopped, and nothing hands back. The runner calls this with the owner credential for a host granted full control.
    """
    require_owner(connection, room_id, token)
    begin_write(connection)
    message = connection.execute("SELECT author FROM messages WHERE room_id=? AND id=?", (room_id, message_id)).fetchone()
    if not message:
        raise LookupError("消息不存在")
    host = connection.execute("SELECT name FROM room_members WHERE room_id=? AND role='host' AND status='active'", (room_id,)).fetchone()
    if not host or message["author"] != host["name"]:
        raise ValueError("只能撤回当前主持人自己的派活消息；用户的消息由用户撤回")
    sequences = "room_id=? AND message_id=? AND status IN ('running','checkpoint')"
    batches = [message_id] + [row[0] for row in connection.execute(f"SELECT batch_id FROM free_sequences WHERE {sequences}", (room_id, message_id))]
    connection.execute(f"UPDATE free_sequences SET status='stopped' WHERE {sequences}", (room_id, message_id))
    marks = ",".join("?" * len(batches))
    # The dispatch's members sent along without being waited for (no batch) are taken back too.
    taken = f"(r.batch_id IN ({marks}) OR r.message_id=? AND r.batch_id=0 AND r.created_by='host' AND r.purpose='ask')"
    live = connection.execute(f"""SELECT DISTINCT e.member_id FROM member_requests r JOIN member_executions e ON e.id=r.execution_id
        WHERE r.room_id=? AND {taken} AND e.status IN ('dispatched','started')""", (room_id, *batches, message_id)).fetchall()
    for row in live:
        stop_member_work(connection, row[0], "主持人撤回派活", "user_stop", keep_pending=True)
    waiting = f"id IN (SELECT r.id FROM member_requests r WHERE r.room_id=? AND {taken} AND r.status='pending')"
    record_cancel_reasons(connection, waiting, (room_id, *batches, message_id), "user_stop")
    connection.execute(f"UPDATE member_requests SET status='cancelled' WHERE {waiting}", (room_id, *batches, message_id))
    connection.execute(f"UPDATE free_batches SET settled=1 WHERE room_id=? AND batch_id IN ({marks})", (room_id, *batches))
    return free_view(connection, room_id)


def set_host_checkin(connection, room_id, token, payload):
    """The host (through the runner, owner credential) asks to be checked in on every `minutes` while work is in flight,
    or turns it off. Bound to the chain of the host's running execution, so it must be set while the host works.
    """
    require_owner(connection, room_id, token)
    begin_write(connection)
    if payload.get("off") is True:
        connection.execute("DELETE FROM free_host_checkins WHERE room_id=?", (room_id,))
        return {"checkin": None}
    minutes = payload.get("minutes")
    low, high = CHECKIN_MINUTES
    if type(minutes) is not int or not low <= minutes <= high:
        raise ValueError(f"minutes 须为 {low}–{high} 的整数")
    row = connection.execute("""SELECT m.id AS host_id,(SELECT MAX(r.chain_id) FROM member_requests r JOIN member_executions e ON e.id=r.execution_id
        WHERE e.member_id=m.id AND e.status IN ('dispatched','started')) AS chain_id
        FROM room_members m WHERE m.room_id=? AND m.role='host' AND m.status='active'""", (room_id,)).fetchone()
    if not row or not row["chain_id"]:
        raise FileExistsError("主持人没有进行中的执行；请在处理任务时设置定时检查")
    due_at = int(time.time()) + minutes * 60
    connection.execute("""INSERT INTO free_host_checkins (room_id,host_id,chain_id,interval_seconds,due_at) VALUES (?,?,?,?,?)
        ON CONFLICT(room_id) DO UPDATE SET host_id=excluded.host_id,chain_id=excluded.chain_id,
        interval_seconds=excluded.interval_seconds,due_at=excluded.due_at""", (room_id, row["host_id"], row["chain_id"], minutes * 60, due_at))
    return {"checkin": {"minutes": minutes, "due_at": due_at}}


def fire_host_checkin(connection, room_id):
    """Hand the host its timed check-in when due and work is still in flight; an idle room or a changed host ends it."""
    row = connection.execute("SELECT * FROM free_host_checkins WHERE room_id=?", (room_id,)).fetchone()
    now = int(time.time())
    if not row or row["due_at"] > now:
        return
    host = connection.execute("SELECT id FROM room_members WHERE room_id=? AND role='host' AND status='active'", (room_id,)).fetchone()
    busy = connection.execute("""SELECT 1 FROM member_requests WHERE room_id=? AND status IN ('pending','delivering') AND member_id<>?
        UNION SELECT 1 FROM free_sequences WHERE room_id=? AND status='running'""", (room_id, row["host_id"], room_id)).fetchone()
    if not host or host["id"] != row["host_id"] or not busy:
        connection.execute("DELETE FROM free_host_checkins WHERE room_id=?", (room_id,))
        return
    connection.execute("UPDATE free_host_checkins SET due_at=? WHERE room_id=?", (now + row["interval_seconds"], room_id))
    host_working = connection.execute("SELECT 1 FROM member_executions WHERE member_id=? AND status IN ('dispatched','started')",
                                      (row["host_id"],)).fetchone()
    if not host_working:
        wake_host(connection, room_id, row["chain_id"], "定时检查：房间里还有进行中的工作。读一下 room view 与各成员的执行进展，"
                  "确认没有卡住、跑偏或失败未处理；一切正常就简短说明并结束本次执行。", f"checkin:{row['due_at']}")


def inbox(connection, room_id, token):
    """List what the runner should deliver or reconcile; owner credential only."""
    require_owner(connection, room_id, token)
    begin_write(connection)
    enforce_session_limits(connection, room_id)
    expire_executions(connection, room_id)
    notice_stalled_executions(connection, room_id)
    fire_host_checkin(connection, room_id)
    release_recommendations(connection, room_id)
    archived = connection.execute("SELECT archived FROM room_directory WHERE room_id=?", (room_id,)).fetchone()[0]
    members, observers = [], []
    shown = member_display_names(connection, room_id)
    # Manual members are never delivered to; the runner only reads them so smart scheduling can route to them too.
    for row in connection.execute(f"SELECT * FROM room_members WHERE room_id=? AND status='active' AND {REGISTERED_MEMBER} ORDER BY id", (room_id,)):
        pending = [dict(item) for item in connection.execute("""SELECT r.id,r.message_id,r.purpose,
            sr.id AS session_request_id,sr.session_id,sr.round,sr.position,sr.read_until,sr.question AS source_question,
            t.cause_kind,t.cause_message_id AS source_message_id,t.cause_request_id,
            (SELECT action FROM group_routes WHERE message_id=r.message_id) AS group_action
            FROM member_requests r LEFT JOIN session_requests sr ON sr.member_request_id=r.id
            LEFT JOIN task_message_sources t ON t.session_request_id=sr.id
            WHERE r.member_id=? AND r.status='pending' ORDER BY r.id""", (row["id"],))]
        member_view = {key: row[key] for key in MEMBER_FIELDS}
        member_view["label"] = shown.get(row["name"], row["name"])
        member_view["review_capability"] = review_capability(connection, room_id, row["id"], token)
        member_view["held_until"] = held_until(connection, row["id"])
        # The runner compares this with its adapter's effect and reports a change.
        reported = connection.execute("SELECT rewind,image_model FROM member_capabilities WHERE member_id=?", (row["id"],)).fetchone()
        member_view["rewind"], member_view["image_model"] = (reported[0], reported[1]) if reported else ("", "")
        # Private chat lines the runner still has to run in this member's session (backend/private_chat.py).
        member_view["chats"] = [dict(item) for item in connection.execute(
            "SELECT id,text,status FROM private_chats WHERE member_id=? AND status IN ('pending','running') ORDER BY id", (row["id"],))]
        pending = [{**request, **review_request_context(connection, request), **sequence_request_context(connection, request)} for request in pending]
        (members if row["access"] == "runner" else observers).append({**member_view, "pending": pending})
    # Pending interjections ride along so the runner hands them to the running software at its next check.
    executions = [{**public_execution(row), "member": row["name"], "retry": execution_retry(connection, row["id"]),
                   "interjections": [dict(item) for item in connection.execute(
                       "SELECT id,text FROM execution_interjections WHERE execution_id=? AND status='pending' ORDER BY id", (row["id"],))]}
                  for row in connection.execute(
        """SELECT member_executions.*,room_members.name FROM member_executions JOIN room_members ON room_members.id=member_id
        WHERE member_executions.room_id=? AND member_executions.status IN ('dispatched','started') ORDER BY member_executions.id""", (room_id,))]
    return {"room_id": room_id, "archived": bool(archived), "members": members, "observers": observers, "executions": executions}


def host_route_request(connection, message_id):
    """The host's request for one unnamed owner message, if the message was routed."""
    return connection.execute("SELECT * FROM member_requests WHERE message_id=? AND purpose='route'", (message_id,)).fetchone()


def recommend_member(connection, room_id, token, payload):
    """Smart scheduling suggests another member for an unnamed message; the host keeps it until the user adopts."""
    require_owner(connection, room_id, token)
    begin_write(connection)
    confidence = payload.get("confidence")
    if payload.get("provider") not in SCHEDULER_PROVIDERS or type(confidence) not in (int, float) or not 0 <= confidence <= 1:
        raise ValueError("须提供智能调度供应商 provider 与 0–1 的置信度 confidence")
    message_id = payload.get("message_id")
    route = host_route_request(connection, message_id) if type(message_id) is int else None
    if not route or route["room_id"] != room_id:
        raise LookupError("只能为交给主持人的未点名消息给出推荐")
    target = connection.execute(f"""SELECT * FROM room_members WHERE room_id=? AND id=? AND status='active'
        AND {REGISTERED_MEMBER} AND id<>?""", (room_id, payload.get("member_id"), route["member_id"])).fetchone()
    if not target:
        raise LookupError("推荐对象须为在场的其他成员")
    now = int(time.time())
    connection.execute("""INSERT OR IGNORE INTO member_recommendations (message_id,room_id,member_id,provider,confidence,created_at,expires_at)
        VALUES (?,?,?,?,?,?,?)""", (message_id, room_id, target["id"], payload["provider"], float(confidence), now, now + RECOMMEND_SECONDS))
    return dict(connection.execute("SELECT * FROM member_recommendations WHERE message_id=?", (message_id,)).fetchone())


def release_recommendations(connection, room_id):
    """Ask each adopted-later member once the host's request for that message has ended in any way."""
    for row in connection.execute("""SELECT rec.* FROM member_recommendations rec JOIN member_requests r ON r.message_id=rec.message_id AND r.purpose='route'
        WHERE rec.room_id=? AND rec.status='waiting' AND r.status IN ('completed','cancelled','failed')""", (room_id,)).fetchall():
        connection.execute("UPDATE member_recommendations SET status='adopted' WHERE message_id=?", (row["message_id"],))
        if connection.execute("SELECT 1 FROM room_members WHERE id=? AND status='active'", (row["member_id"],)).fetchone():
            connection.execute("""INSERT OR IGNORE INTO member_requests (room_id,member_id,message_id,chain_id,purpose,created_by,created_at)
                VALUES (?,?,?,?,'ask','user',?)""", (room_id, row["member_id"], row["message_id"], row["message_id"], int(time.time())))


def group_route_plan(connection, room_id, token, message_id):
    """Read the current group, eligible members, order and revision before arranging everyone's requests."""
    require_owner(connection, room_id, token)
    group = connection.execute("""SELECT id,message_id,status FROM member_requests
        WHERE room_id=? AND message_id=? AND purpose='group' ORDER BY id DESC LIMIT 1""", (room_id, message_id)).fetchone()
    previous = connection.execute("SELECT action,request_id,message_id FROM group_routes WHERE room_id=? AND message_id=?",
                                  (room_id, message_id)).fetchone()
    if not group and not previous:
        raise LookupError("这条消息没有全体待安排请求")
    state = connection.execute(GROUP_STATE_SQL, (room_id,)).fetchone()["state"]
    snapshot = json.loads(state)
    members = [member for member in snapshot["members"] if member["status"] == "active" and member["registered"]]
    rank = {member_id: index for index, member_id in enumerate(json.loads(snapshot["order"]))}
    members.sort(key=lambda member: (member["id"] not in rank, rank.get(member["id"], 0), member["role"] != "host", member["id"]))
    return {"message_id": message_id, "request": dict(group) if group else None, "members": members,
            "title": snapshot["title"], "goal": snapshot["goal"],
            "latest_id": snapshot["latest_id"], "revision": hashlib.sha256(state.encode("utf-8")).hexdigest(),
            "result": dict(previous) if previous else None}


def route_group(connection, room_id, group, payload):
    """Arrange a pending group atomically; only the single-object handback to its host needs no roster revision."""
    action = payload["action"]
    if action not in ("all", "sequential", "host"):
        raise ValueError("请全体成员回应的消息只能选 action=all、sequential 或 host")
    if group["status"] != "pending":
        raise FileExistsError("这条消息已不再等待安排")
    if action != "host":
        if not payload.get("revision"):
            raise ValueError("安排全体前须先读取 message group-plan，并带上其 revision")
        state = connection.execute(GROUP_STATE_SQL, (room_id,)).fetchone()["state"]
        if payload["revision"] != hashlib.sha256(state.encode("utf-8")).hexdigest():
            raise FileExistsError("成员、顺序或消息已变化，请重新读取全体安排状态")
    if action == "host":
        connection.execute("UPDATE member_requests SET purpose='route' WHERE id=?", (group["id"],))
    elif action == "sequential":
        connection.execute("DELETE FROM member_requests WHERE id=?", (group["id"],))
        members = connection.execute(f"SELECT id FROM room_members WHERE room_id=? AND status='active' AND {REGISTERED_MEMBER}", (room_id,))
        queue_in_turn(connection, room_id, group["message_id"], [row["id"] for row in members])
    else:
        connection.execute("UPDATE member_requests SET purpose='all' WHERE id=?", (group["id"],))
        connection.execute(f"""INSERT OR IGNORE INTO member_requests (room_id,member_id,message_id,chain_id,purpose,created_by,created_at)
            SELECT room_id,id,?,?,'all','user',? FROM room_members WHERE room_id=? AND status='active' AND {REGISTERED_MEMBER} ORDER BY id""",
                           (group["message_id"], group["chain_id"], int(time.time()), room_id))
    connection.execute("INSERT INTO group_routes (message_id,room_id,request_id,action) VALUES (?,?,?,?)",
                       (group["message_id"], room_id, group["id"], action))
    return {"action": action, "request_id": group["id"], "message_id": group["message_id"]}


def route_wide(connection, room_id, message_id, payload):
    """Smart scheduling answers an unnamed message with everyone (each member once, as if the user named them all, at once
    or one after another), the few members it names, or no one.

    A message naming everyone (a group request) is answered by all at once or, with action sequential, one after another.
    Only a host request that has not started changes; a started host already handles the message its own way.
    """
    action = payload["action"]
    previous = connection.execute("SELECT action,request_id,message_id FROM group_routes WHERE room_id=? AND message_id=?",
                                  (room_id, message_id)).fetchone()
    if previous:
        if previous["action"] != action:
            raise FileExistsError("这条全体消息已经安排，不能改用其他动作")
        return dict(previous)
    group = connection.execute("""SELECT * FROM member_requests WHERE room_id=? AND message_id=? AND purpose='group'
        ORDER BY id DESC LIMIT 1""", (room_id, message_id)).fetchone()
    if group:
        return route_group(connection, room_id, group, payload)
    if action == "host":
        raise ValueError("只有请全体成员回应的消息可以交回主持人")
    if action not in ("all", "sequential", "none", "some"):
        raise ValueError("未点名消息只能选 action=all、sequential、some 或 none")
    route = host_route_request(connection, message_id)
    if not route or route["room_id"] != room_id:
        raise LookupError("只能处理交给主持人的未点名消息")
    if route["status"] != "pending":
        raise FileExistsError("主持人已开始处理这条消息，不再改派")
    if action == "sequential":
        # Same as a group answered one after another: the host's request gives way to the queue, which includes the host.
        connection.execute("DELETE FROM member_requests WHERE id=?", (route["id"],))
        members = connection.execute(f"SELECT id FROM room_members WHERE room_id=? AND status='active' AND {REGISTERED_MEMBER}", (room_id,))
        queue_in_turn(connection, room_id, message_id, [row["id"] for row in members])
        connection.execute("INSERT INTO group_routes (message_id,room_id,request_id,action) VALUES (?,?,?,?)",
                           (message_id, room_id, route["id"], action))
    elif action == "none":
        record_cancel_reasons(connection, "id=?", (route["id"],), "no_reply")
        connection.execute("UPDATE member_requests SET status='cancelled' WHERE id=?", (route["id"],))
    elif action == "some":
        route_some(connection, room_id, route, payload.get("members"))
    else:
        # The host keeps its row (one request per message and member) and now answers its own share, without dispatching.
        connection.execute("UPDATE member_requests SET purpose='all' WHERE id=?", (route["id"],))
        connection.execute(f"""INSERT OR IGNORE INTO member_requests (room_id,member_id,message_id,chain_id,purpose,created_by,created_at)
            SELECT room_id,id,?,?,'all','user',? FROM room_members WHERE room_id=? AND status='active' AND {REGISTERED_MEMBER} ORDER BY id""",
                           (message_id, message_id, int(time.time()), room_id))
    requests = connection.execute("SELECT * FROM member_requests WHERE message_id=? ORDER BY id", (message_id,)).fetchall()
    return {"action": action, "requests": [dict(row) for row in requests]}


def route_some(connection, room_id, route, names):
    """Smart scheduling answers an unnamed message with the few members it names, each once, as if the user named them."""
    if not isinstance(names, list) or not all(isinstance(name, str) for name in names) or len(set(names)) < 2:
        raise ValueError("action=some 须带 members：至少两位不同的成员名")
    found = {row["name"]: row["id"] for row in connection.execute(
        f"SELECT id,name FROM room_members WHERE room_id=? AND status='active' AND {REGISTERED_MEMBER}", (room_id,))}
    missing = [name for name in dict.fromkeys(names) if name not in found]
    if missing:
        raise FileExistsError(f"这些成员不在场或未注册：{'、'.join(missing)}")
    ids = [found[name] for name in dict.fromkeys(names)]
    if route["member_id"] in ids:
        # The host is one of them: it keeps its row and answers its own share, without dispatching.
        connection.execute("UPDATE member_requests SET purpose='all' WHERE id=?", (route["id"],))
    else:
        record_cancel_reasons(connection, "id=?", (route["id"],), "rerouted")
        connection.execute("UPDATE member_requests SET status='cancelled' WHERE id=?", (route["id"],))
    for member_id in ids:
        if member_id != route["member_id"]:
            connection.execute("""INSERT OR IGNORE INTO member_requests (room_id,member_id,message_id,chain_id,purpose,created_by,created_at)
                VALUES (?,?,?,?,'all','user',?)""", (room_id, member_id, route["message_id"], route["message_id"], int(time.time())))


def adopt_recommendation(connection, room_id, token, message_id, payload):
    """The user adopts a recommendation before it expires: interrupt the host now, or ask the member after the host.

    Smart scheduling also sends action all or none here to have everyone or no one answer an unnamed message.
    """
    require_owner(connection, room_id, token)
    begin_write(connection)
    if payload.get("action") in ("all", "none", "sequential", "host", "some"):
        return route_wide(connection, room_id, message_id, payload)
    if payload.get("action") != "adopt" or payload.get("mode") not in ("interrupt", "after"):
        raise ValueError("采纳须为 action=adopt，mode 为 interrupt 或 after；全体、依次、指定几位或无需回应为 action=all、sequential、some 或 none")
    row = connection.execute("SELECT * FROM member_recommendations WHERE room_id=? AND message_id=?", (room_id, message_id)).fetchone()
    if not row:
        raise LookupError("这条消息没有智能调度推荐")
    if row["status"] != "open":
        return {"recommendation": dict(row), "duplicate": True}
    if int(time.time()) > row["expires_at"] + RECOMMEND_GRACE_SECONDS:
        raise FileExistsError("推荐已过期，可直接 @ 该成员")
    if not connection.execute("SELECT 1 FROM room_members WHERE id=? AND status='active'", (row["member_id"],)).fetchone():
        raise FileExistsError("推荐的成员已离开")
    route = host_route_request(connection, message_id)
    mode = payload["mode"]
    if mode == "interrupt" and route["status"] == "delivering":
        # The host's execution may carry other messages too; stopping it voids that whole execution.
        finish_execution(connection, route["execution_id"], "cancelled", "智能调度改派，改由其他成员回答", "cancelled", "rerouted")
    elif mode == "interrupt" and route["status"] == "pending":
        record_cancel_reasons(connection, "id=?", (route["id"],), "rerouted")
        connection.execute("UPDATE member_requests SET status='cancelled' WHERE id=?", (route["id"],))
    connection.execute("UPDATE member_recommendations SET status='waiting',mode=? WHERE message_id=?", (mode, message_id))
    release_recommendations(connection, room_id)
    settle_batches(connection, room_id)
    return {"recommendation": dict(connection.execute("SELECT * FROM member_recommendations WHERE message_id=?", (message_id,)).fetchone()),
            "duplicate": False}


def recent_recommendations(connection, room_id, now):
    """Recommendations shown beside their messages, with seconds left to adopt an open one."""
    return [{**dict(row), "expires_in": max(0, row["expires_at"] - now)} for row in connection.execute(
        """SELECT rec.*,m.name AS member FROM member_recommendations rec JOIN room_members m ON m.id=rec.member_id
        WHERE rec.room_id=? ORDER BY rec.message_id DESC LIMIT ?""", (room_id, RECENT_REQUESTS))]


def reserve_execution(connection, room_id, token, payload):
    """Bundle a member's open requests into one execution; a retried client_id returns the same one."""
    require_owner(connection, room_id, token)
    begin_write(connection)
    if enforce_session_limits(connection, room_id):
        connection.commit()
    client_id = str(payload.get("client_id", ""))
    if not 8 <= len(client_id) <= 100:
        raise ValueError("client_id 须为 8–100 字符的本地投递编号")
    previous = connection.execute("SELECT * FROM member_executions WHERE room_id=? AND client_id=?", (room_id, client_id)).fetchone()
    if previous:
        return execution_detail(connection, previous)
    expire_executions(connection, room_id)
    if connection.execute("SELECT archived FROM room_directory WHERE room_id=?", (room_id,)).fetchone()[0]:
        raise FileExistsError("房间已存档，不再投递")
    member = connection.execute("SELECT * FROM room_members WHERE room_id=? AND id=? AND status='active' AND access='runner'",
                                (room_id, payload.get("member_id"))).fetchone()
    if not member:
        raise LookupError("成员不存在、已离开或为手动接入")
    if connection.execute("SELECT 1 FROM member_executions WHERE member_id=? AND status IN ('dispatched','started')",
                          (member["id"],)).fetchone():
        raise FileExistsError("该成员已有进行中的执行；同一会话不并发续接")
    if held_until(connection, member["id"]):
        raise FileExistsError("该成员上一轮已作废但本机无法停止，可能仍在处理；等它结束或等待时限到后再投递")
    # A group request waits for the runner to choose how everyone answers; it is never delivered itself.
    pending = connection.execute("""SELECT id,purpose,EXISTS(SELECT 1 FROM review_plans WHERE review_batch_id=member_requests.message_id AND reviewer_id=member_requests.member_id) AS review FROM member_requests
        WHERE member_id=? AND status='pending' AND purpose<>'group' ORDER BY id""", (member["id"],)).fetchall()
    session_purpose = next((row["purpose"] for row in pending if row["purpose"] == "discuss"), None)
    if not pending:
        raise FileExistsError("该成员没有待投递的请求")
    if session_purpose:
        request_filter = "purpose=?"
        request_values = (session_purpose,)
    elif pending[0]["review"]:
        request_filter, request_values = "id=?", (pending[0]["id"],)
    else:
        request_filter = "purpose<>'group' AND NOT EXISTS(SELECT 1 FROM review_plans WHERE review_batch_id=member_requests.message_id AND reviewer_id=member_requests.member_id)"
        request_values = ()
    now = int(time.time())
    cursor = connection.execute("""INSERT INTO member_executions (room_id,member_id,client_id,lease_until,created_at,cwd)
        VALUES (?,?,?,?,?,?)""", (room_id, member["id"], client_id, now + LEASE_SECONDS, now, str(payload.get("cwd") or "")[:MAX_PATH_LENGTH]))
    connection.execute(f"UPDATE member_requests SET status='delivering',execution_id=? WHERE member_id=? AND status='pending' AND {request_filter}",
                       (cursor.lastrowid, member["id"], *request_values))
    return execution_detail(connection, connection.execute("SELECT * FROM member_executions WHERE id=?", (cursor.lastrowid,)).fetchone())


def execution_detail(connection, row):
    """Describe one execution with the requests it carries and the member's read cursor."""
    member = connection.execute("SELECT * FROM room_members WHERE id=?", (row["member_id"],)).fetchone()
    requests = [dict(item) for item in connection.execute("""SELECT r.id,r.message_id,r.status,r.purpose,
        sr.id AS session_request_id,sr.session_id,sr.round,sr.position,sr.read_until,sr.question AS source_question,
        t.cause_kind,t.cause_message_id AS source_message_id,t.cause_request_id
        FROM member_requests r LEFT JOIN session_requests sr ON sr.member_request_id=r.id
        LEFT JOIN task_message_sources t ON t.session_request_id=sr.id
        WHERE r.execution_id=? ORDER BY r.id""", (row["id"],))]
    requests = [{**request, **review_request_context(connection, request), **sequence_request_context(connection, request)} for request in requests]
    return {**public_execution(row), "member": member["name"], "read_until": member["read_until"], "requests": requests,
            "rewound_executions": member_rewinds(connection, member["id"]), "retry": execution_retry(connection, row["id"])}


def view_execution(connection, room_id, execution_id, token):
    """Let the owner, the present host (to diagnose a member's failure) or the executing member read one execution."""
    row = connection.execute("SELECT * FROM member_executions WHERE room_id=? AND id=?", (room_id, execution_id)).fetchone()
    if not row:
        raise LookupError("执行不存在")
    try:
        require_owner(connection, room_id, token)
    except PermissionError:
        member = require_member(connection, room_id, token)
        if member["id"] != row["member_id"] and member["role"] != "host":
            raise
    return execution_detail(connection, row)


def changed_files(payload):
    """Validate the runner's observed file list; paths are relative to the execution's cwd."""
    files = payload.get("changes")
    if (not isinstance(files, list) or len(files) > MAX_CHANGED_FILES
            or any(not isinstance(item, str) or not item or len(item) > MAX_PATH_LENGTH for item in files)):
        raise ValueError(f"changes 须为最多 {MAX_CHANGED_FILES} 个相对路径")
    return sorted(set(files))


def edited_files(payload, changes):
    """The reported files the member's own edit tools wrote, kept within `changes`; '' when the runner could not tell."""
    if "edited" not in payload:
        return ""
    files = payload["edited"]
    if (not isinstance(files, list) or len(files) > MAX_CHANGED_FILES
            or any(not isinstance(item, str) or not item or len(item) > MAX_PATH_LENGTH for item in files)):
        raise ValueError(f"edited 须为最多 {MAX_CHANGED_FILES} 个相对路径")
    return json.dumps(sorted(set(files) & set(changes)), ensure_ascii=False)


def denied_actions(payload):
    """Validate the operations a member's software refused: the tool, what it tried, and the rule that would allow it."""
    denials = payload.get("denials")
    def valid(item):
        return (isinstance(item, dict) and isinstance(item.get("tool"), str) and 0 < len(item["tool"]) <= 40
                and all(isinstance(item.get(key, ""), str) and len(item.get(key, "")) <= MAX_DENIAL_FIELD for key in ("detail", "rule")))
    if not isinstance(denials, list) or not 0 < len(denials) <= MAX_DENIALS or not all(map(valid, denials)):
        raise ValueError(f"denials 须为 1–{MAX_DENIALS} 条 {{tool, detail, rule}}")
    return [{key: item.get(key, "") for key in ("tool", "detail", "rule")} for item in denials]


def renewed_activity(payload, row, now):
    """Validate the runner's reported phase; its output time is kept within the execution, since the runner's clock may differ."""
    activity, activity_at = payload.get("activity"), payload.get("activity_at")
    if activity not in ACTIVITY_PHASES:
        raise ValueError(f"activity 须为 {'、'.join(item for item in ACTIVITY_PHASES if item)} 或空")
    if type(activity_at) is not int:
        raise ValueError("activity_at 须为秒级时间戳")
    return activity, min(max(activity_at, row["created_at"]), now)


def renewed_notes(payload):
    """Validate progress notes carried by a renewal; a repeated sequence number is the same note resent."""
    notes = payload.get("notes", [])
    if (not isinstance(notes, list) or len(notes) > MAX_NOTES_PER_RENEW or any(
            not isinstance(note, dict) or type(note.get("seq")) is not int or not 1 <= note["seq"] <= MAX_EXECUTION_NOTES
            or not isinstance(note.get("text"), str) or not 0 < len(note["text"]) <= MAX_NOTE_LENGTH for note in notes)):
        raise ValueError(f"notes 须为最多 {MAX_NOTES_PER_RENEW} 条 {{seq: 1–{MAX_EXECUTION_NOTES}, text: 1–{MAX_NOTE_LENGTH} 字}}")
    return notes


def late_answer(connection, room_id, execution_id, token):
    """Read one voided execution's late text after checking the room owner's credential."""
    require_owner(connection, room_id, token)
    row = connection.execute("SELECT text,created_at FROM late_answers WHERE room_id=? AND execution_id=?",
                             (room_id, execution_id)).fetchone()
    if not row:
        raise LookupError("本次执行没有迟到回答")
    return dict(row)


def record_stop_result(connection, room_id, execution_id, result):
    """Record a stop idempotently; an unconfirmed stop may later gain a confirmed outcome."""
    if result not in STOP_RESULTS:
        raise ValueError(f"result 须为 {'、'.join(STOP_RESULTS)}")
    saved = connection.execute("""INSERT INTO execution_capabilities (execution_id,room_id,stop_result) VALUES (?,?,?)
        ON CONFLICT(execution_id) DO UPDATE SET stop_result=excluded.stop_result
        WHERE stop_result IN ('','unconfirmed') AND stop_result<>excluded.stop_result""", (execution_id, room_id, result))
    if saved.rowcount:
        return False
    previous = connection.execute("SELECT stop_result FROM execution_capabilities WHERE execution_id=?", (execution_id,)).fetchone()[0]
    if previous != result:
        raise FileExistsError("本次执行已记录不同的停止结果")
    return True


def add_interjection(connection, room_id, row, payload, now):
    """The owner's interjection into one running execution, kept for the runner to deliver; the same submission_id returns the earlier one."""
    text, submission_id = payload.get("text"), payload.get("submission_id")
    if not isinstance(text, str) or not 0 < len(text.strip()) <= MAX_INTERJECTION_LENGTH:
        raise ValueError(f"插话须为 1–{MAX_INTERJECTION_LENGTH} 字")
    if not isinstance(submission_id, str) or not 0 < len(submission_id) <= 100:
        raise ValueError("插话须带 submission_id；重试沿用原编号")
    earlier = connection.execute("SELECT * FROM execution_interjections WHERE room_id=? AND submission_id=?", (room_id, submission_id)).fetchone()
    if earlier:
        if earlier["execution_id"] != row["id"] or earlier["text"] != text:
            raise FileExistsError("submission_id 已用于另一条插话")
        return public_interjection(earlier, row["status"])
    capability = connection.execute("SELECT steer,resume FROM execution_capabilities WHERE execution_id=?", (row["id"],)).fetchone()
    if not capability or not (capability["steer"] or capability["resume"]):
        raise FileExistsError("这位成员的软件不支持执行中插话，可停止后带上这句话重问")
    if connection.execute("SELECT COUNT(*) FROM execution_interjections WHERE execution_id=?", (row["id"],)).fetchone()[0] >= MAX_INTERJECTIONS:
        raise FileExistsError(f"一次执行最多插话 {MAX_INTERJECTIONS} 条")
    cursor = connection.execute("""INSERT INTO execution_interjections (execution_id,room_id,submission_id,text,created_at,updated_at)
        VALUES (?,?,?,?,?,?)""", (row["id"], room_id, submission_id, text, now, now))
    # Software that cannot take it mid-turn hears it by a pause: the runner stops the turn and resumes with it.
    if not capability["steer"] and not row["paused_at"]:
        connection.execute("UPDATE member_executions SET paused_at=? WHERE id=?", (now, row["id"]))
    return public_interjection(connection.execute("SELECT * FROM execution_interjections WHERE id=?", (cursor.lastrowid,)).fetchone(), row["status"])


def record_interjection_result(connection, room_id, execution_id, payload, now):
    """Mark one pending interjection delivered or failed, as the runner reports it."""
    status, reason = payload.get("status"), payload.get("reason", "")
    if status not in ("delivered", "failed") or not isinstance(reason, str) or len(reason) > MAX_RETRY_REASON:
        raise ValueError(f"interjection 须带 status（delivered 或 failed）与最多 {MAX_RETRY_REASON} 字的 reason")
    updated = connection.execute("""UPDATE execution_interjections SET status=?,reason=?,updated_at=?
        WHERE id=? AND room_id=? AND execution_id=? AND status='pending'""",
                                 (status, reason, now, payload.get("interjection_id"), room_id, execution_id))
    if not updated.rowcount and not connection.execute("SELECT 1 FROM execution_interjections WHERE id=? AND room_id=? AND execution_id=?",
                                                       (payload.get("interjection_id"), room_id, execution_id)).fetchone():
        raise LookupError("插话不存在")


def public_interjection(row, execution_status):
    """One interjection as the page shows it; one still pending when its execution ended never reached the software."""
    ended = row["status"] == "pending" and execution_status not in ACTIVE
    return {"id": row["id"], "text": row["text"], "status": "failed" if ended else row["status"],
            "reason": INTERJECTION_ENDED if ended else row["reason"], "created_at": row["created_at"]}


def execution_interjections(connection, execution_id, execution_status):
    """Every interjection of one execution in the order the owner sent them."""
    return [public_interjection(row, execution_status) for row in connection.execute(
        "SELECT * FROM execution_interjections WHERE execution_id=? ORDER BY id", (execution_id,))]


def execution_action(connection, room_id, execution_id, token, payload):
    """Runner-side lifecycle: renew, fail, release undelivered work, report how the software was reached, whether a voided one stopped, or observed file changes."""
    begin_write(connection)
    action = payload.get("action")
    duplicate = False
    member = None
    if action == "fail":
        try:
            require_owner(connection, room_id, token)
        except PermissionError:
            member = require_member(connection, room_id, token)
    else:
        require_owner(connection, room_id, token)
    if enforce_session_limits(connection, room_id):
        connection.commit()
    row = connection.execute("SELECT * FROM member_executions WHERE room_id=? AND id=?", (room_id, execution_id)).fetchone()
    if not row:
        raise LookupError("执行不存在")
    if member and member["id"] != row["member_id"]:
        raise PermissionError("只能报告自己执行的失败")
    now = int(time.time())
    if action == "report":
        # Observed after the process ends, so the execution may already be complete; recorded once.
        if row["changes"]:
            raise FileExistsError("本次执行的改动已记录")
        changes = changed_files(payload)
        connection.execute("UPDATE member_executions SET changes=?,edited=? WHERE id=?",
                           (json.dumps(changes, ensure_ascii=False), edited_files(payload, changes), execution_id))
    elif action == "denials":
        # Like file changes, read from the software's output once its process ends; recorded once.
        saved = connection.execute("INSERT OR IGNORE INTO execution_denials (execution_id,room_id,denials) VALUES (?,?,?)",
                                   (execution_id, room_id, json.dumps(denied_actions(payload), ensure_ascii=False)))
        if not saved.rowcount:
            raise FileExistsError("本次执行的拒绝记录已记录")
    elif action == "segments":
        # The last segments and notes arrive after the member's answer ended the execution; such notes are dated at its end.
        finished = 0 if row["status"] in ACTIVE else (row["finished_at"] or 1)
        notes = renewed_notes(payload)
        save_segments(connection, "free", room_id, execution_id, row["created_at"], finished, payload, optional=bool(notes))
        connection.executemany("INSERT OR IGNORE INTO execution_notes (execution_id,seq,room_id,text,created_at) VALUES (?,?,?,?,?)",
                               [(execution_id, note["seq"], room_id, note["text"], min(now, finished) if finished else now) for note in notes])
    elif action == "stopped":
        # After a voided execution: whether the runner ended its software, or could not because it works in a window or App.
        if row["status"] != "cancelled":
            raise FileExistsError("只有已作废的执行才报告停止结果")
        duplicate = record_stop_result(connection, room_id, execution_id, payload.get("result"))
    elif action == "delivery":
        if row["status"] not in (*ACTIVE, "cancelled"):
            raise FileExistsError("执行已结束")
        # What this delivery can do, as the runner's adapter reported; a retried delivery may differ, so the latest counts.
        if type(payload.get("stoppable")) is not bool or type(payload.get("progress")) is not bool:
            raise ValueError("delivery 须带布尔值 stoppable 与 progress")
        # Older runners report no `steer` or `resume`; their deliveries take no interjection and no pause.
        if type(payload.get("steer", False)) is not bool or type(payload.get("resume", False)) is not bool:
            raise ValueError("delivery 的 steer 与 resume 须为布尔值")
        connection.execute("""INSERT INTO execution_capabilities (execution_id,room_id,stoppable,progress,steer,resume) VALUES (?,?,?,?,?,?)
            ON CONFLICT(execution_id) DO UPDATE SET stoppable=excluded.stoppable,progress=excluded.progress,steer=excluded.steer,
            resume=excluded.resume""", (execution_id, room_id, int(payload["stoppable"]), int(payload["progress"]),
                                        int(payload.get("steer", False)), int(payload.get("resume", False))))
    elif action == "interjection":
        # The runner's report on one interjection: it reached the software, or why it could not; a repeated report changes nothing.
        record_interjection_result(connection, room_id, execution_id, payload, now)
    elif action == "retry":
        retry_failed(connection, room_id, row)
    elif row["status"] not in ACTIVE:
        raise FileExistsError("执行已结束")
    elif action == "renew":
        # No time limit on one execution: it runs while the runner keeps renewing.
        if row["lease_until"] <= now:
            raise FileExistsError("执行租约已到期，不能续租")
        # Older runners renew without activity; the last reported one is kept.
        activity, activity_at = renewed_activity(payload, row, now) if "activity" in payload else (row["activity"], row["activity_at"])
        notes = renewed_notes(payload)
        connection.execute("UPDATE member_executions SET lease_until=?,activity=?,activity_at=? WHERE id=?",
                           (now + LEASE_SECONDS, activity, activity_at, execution_id))
        connection.executemany("INSERT OR IGNORE INTO execution_notes (execution_id,seq,room_id,text,created_at) VALUES (?,?,?,?,?)",
                               [(execution_id, note["seq"], room_id, note["text"], now) for note in notes])
    elif action == "pause":
        # The owner's pause from the private chat: the runner stops the software's turn, the execution stays live and
        # resumes in the same session with the owner's next line. Ending the turn is the member's interrupt instead.
        capability = connection.execute("SELECT resume FROM execution_capabilities WHERE execution_id=?", (execution_id,)).fetchone()
        if not capability or not capability["resume"]:
            raise FileExistsError("这位成员的接入方式不能暂停后接着做；要结束这次执行请用停止")
        if not row["paused_at"]:
            connection.execute("UPDATE member_executions SET paused_at=? WHERE id=?", (now, execution_id))
    elif action == "resume":
        # The runner resumed the paused turn in the same session.
        connection.execute("UPDATE member_executions SET paused_at=0 WHERE id=?", (execution_id,))
    elif action == "interject":
        interjection = add_interjection(connection, room_id, row, payload, now)
        detail = execution_detail(connection, connection.execute("SELECT * FROM member_executions WHERE id=?", (execution_id,)).fetchone())
        return {**detail, "interjection": interjection}
    elif action == "retry_wait":
        # A manual member's session refused the delivery: the runner keeps the execution and delivers again at retry_at.
        attempt, retry_at, reason = payload.get("attempt"), payload.get("retry_at"), payload.get("reason")
        if (type(attempt) is not int or not 1 <= attempt <= MAX_RETRIES or type(retry_at) is not int or retry_at <= 0
                or not isinstance(reason, str) or not 0 < len(reason) <= MAX_RETRY_REASON):
            raise ValueError(f"retry_wait 须带 attempt（1–{MAX_RETRIES}）、秒级 retry_at 与 reason（最多 {MAX_RETRY_REASON} 字）")
        connection.execute("""INSERT INTO execution_retries (execution_id,room_id,attempt,retry_at,reason,stopped) VALUES (?,?,?,?,?,0)
            ON CONFLICT(execution_id) DO UPDATE SET attempt=excluded.attempt,retry_at=excluded.retry_at,reason=excluded.reason,stopped=0""",
                           (execution_id, room_id, attempt, retry_at, reason))
    elif action == "retry_start":
        connection.execute("UPDATE execution_retries SET retry_at=0 WHERE execution_id=?", (execution_id,))
    elif action in ("retry_now", "retry_stop"):
        # The owner's answer to a waiting retry: deliver now, or stop so the runner fails the execution.
        change = "retry_at=?" if action == "retry_now" else "stopped=1"
        updated = connection.execute(f"UPDATE execution_retries SET {change} WHERE execution_id=? AND retry_at>0 AND stopped=0",
                                     ((now, execution_id) if action == "retry_now" else (execution_id,)))
        if not updated.rowcount:
            raise FileExistsError("本次执行没有在等待自动重试")
    elif action == "reject_review":
        request = connection.execute("""SELECT r.id FROM member_requests r JOIN review_plans p ON p.review_batch_id=r.message_id AND p.reviewer_id=r.member_id
            WHERE r.execution_id=? AND r.status='delivering' AND r.purpose='ask'""", (execution_id,)).fetchall()
        count = connection.execute("SELECT COUNT(*) FROM member_requests WHERE execution_id=? AND status='delivering'", (execution_id,)).fetchone()[0]
        if len(request) != 1 or count != 1 or not isinstance(payload.get("reason"), str) or not payload["reason"].strip():
            raise ValueError("reject_review 只用于单个评审执行，须说明拒绝原因")
        finish_execution(connection, execution_id, "cancelled", "评审未投递：" + payload["reason"][:400], "cancelled")
        settle_batches(connection, room_id)
    elif action == "fail":
        finish_execution(connection, execution_id, "failed", str(payload.get("reason") or "执行失败"), "failed")
        settle_batches(connection, room_id)
    elif action == "release":
        # Only for proven non-delivery: the requests return to the queue unchanged.
        finish_execution(connection, execution_id, "cancelled", str(payload.get("reason") or "未送达"), "pending")
    else:
        raise ValueError("action 须为 renew、fail、release、report、segments、interject、interjection、retry_wait、retry_start、retry_now、retry_stop 或 retry")
    detail = execution_detail(connection, connection.execute("SELECT * FROM member_executions WHERE id=?", (execution_id,)).fetchone())
    return {**detail, "duplicate": duplicate} if action == "stopped" else detail


def retry_failed(connection, room_id, execution):
    """Owner retry of a failed execution: its requests go back to the same member's queue and the runner delivers them anew.

    The failed execution stays as history but no longer carries the requests, so a second retry is refused. A host batch
    that failed as a whole reopens and its chain resumes, so the host still gets the answer back; a relay stopped at that
    step runs again and passes the answer on.
    """
    if execution["status"] != "failed":
        raise FileExistsError("只有失败的执行可以重试")
    requests = connection.execute("""SELECT id,batch_id,chain_id FROM member_requests r WHERE execution_id=? AND status='failed'
        AND NOT EXISTS(SELECT 1 FROM session_requests s WHERE s.member_request_id=r.id)""", (execution["id"],)).fetchall()
    if not requests:
        raise FileExistsError("这次执行没有可重试的请求：已重试过，或是讨论发言（由主持人重新安排）")
    if not connection.execute("SELECT 1 FROM room_members WHERE id=? AND status='active'", (execution["member_id"],)).fetchone():
        raise FileExistsError("该成员已离开或暂离，无法重试")
    connection.execute(f"UPDATE member_requests SET status='pending',execution_id=NULL WHERE id IN ({','.join('?' * len(requests))})",
                       [request["id"] for request in requests])
    reopen_batches(connection, room_id, requests)


def revive_failed(connection, room_id, execution):
    """Take a late answer to an execution the runner failed, as long as nobody acted on that failure since.

    The runner fails an execution when it sees the software's turn end with no answer; an answer arriving afterwards
    shows that judgement was wrong (e.g. the turn waited on a background agent). Its requests still marked failed and
    not retried make the execution live again inside the caller's transaction, so the answer then completes it as usual.
    A stopped, withdrawn or rewound execution is cancelled, not failed, and is never revived.

    Returns:
        The live execution row, or None when the failure was already retried, was a discussion turn, or the member
        already has another live execution (one live execution per member).
    """
    if execution["status"] != "failed":
        return None
    if connection.execute("SELECT 1 FROM member_executions WHERE member_id=? AND id<>? AND status IN ('dispatched','started')",
                          (execution["member_id"], execution["id"])).fetchone():
        return None
    requests = connection.execute("""SELECT id,batch_id,chain_id FROM member_requests r WHERE execution_id=? AND status='failed'
        AND NOT EXISTS(SELECT 1 FROM session_requests s WHERE s.member_request_id=r.id)""", (execution["id"],)).fetchall()
    if not requests:
        return None
    connection.execute(f"UPDATE member_requests SET status='delivering' WHERE id IN ({','.join('?' * len(requests))})",
                       [request["id"] for request in requests])
    connection.execute("UPDATE member_executions SET status='started',lease_until=? WHERE id=?",
                       (int(time.time()) + LEASE_SECONDS, execution["id"]))
    reopen_batches(connection, room_id, requests)
    return connection.execute("SELECT * FROM member_executions WHERE id=?", (execution["id"],)).fetchone()


def reopen_batches(connection, room_id, requests):
    """Reopen what a failure closed for these requests: the batch, an all-failed chain, a relay stopped at that step."""
    for request in requests:
        batch_id, chain_id = request["batch_id"], request["chain_id"]
        # A relay step stopped by one failed member of its group resumes too: the others' answers wait for this one.
        if batch_id and (not connection.execute(
                "SELECT 1 FROM member_requests WHERE room_id=? AND batch_id=? AND status='completed'", (room_id, batch_id)).fetchone()
                or connection.execute("SELECT 1 FROM free_sequences WHERE room_id=? AND batch_id=? AND status='stopped'",
                                      (room_id, batch_id)).fetchone()):
            connection.execute("UPDATE free_batches SET settled=0 WHERE room_id=? AND batch_id=?", (room_id, batch_id))
            connection.execute("DELETE FROM free_chains WHERE room_id=? AND chain_id=? AND reason='all_failed'", (room_id, chain_id))
            connection.execute("UPDATE free_sequences SET status='running' WHERE room_id=? AND batch_id=? AND status='stopped'",
                               (room_id, batch_id))


def owned_member(connection, room_id, member_id, token):
    """Read one member after proving the owner's credential."""
    require_owner(connection, room_id, token)
    begin_write(connection)
    member = connection.execute("SELECT * FROM room_members WHERE room_id=? AND id=?", (room_id, member_id)).fetchone()
    if not member or member["status"] == "removed":
        raise LookupError("成员不存在")
    return member


def interrupt_member(connection, room_id, member_id, token):
    """Owner stop: void the live execution; requests that arrived meanwhile stay queued for the member's next turn."""
    owned_member(connection, room_id, member_id, token)
    pause_queue(connection, room_id)
    stop_member_work(connection, member_id, "用户打断", "user_stop", keep_pending=True)
    settle_batches(connection, room_id)
    return free_view(connection, room_id)


def interrupt_for_message(connection, room_id, message_id):
    """The owner's "send now" of a queued message: interrupt the busy members it was just given to, so they take it next.

    Members whose software reported it cannot stop are not interrupted: voiding their turn would only discard its answer
    while the next delivery still waits for it to end. Unlike the owner's stop, the rest of the queue is not paused.

    Raises:
        FileExistsError: a recipient is busy and cannot be stopped; the caller keeps the message queued.
    """
    busy = connection.execute("""SELECT DISTINCT r.member_id, m.name, c.stoppable FROM member_requests r
        JOIN room_members m ON m.id=r.member_id
        JOIN member_executions e ON e.member_id=r.member_id AND e.status IN ('dispatched','started')
        LEFT JOIN execution_capabilities c ON c.execution_id=e.id
        WHERE r.room_id=? AND r.message_id=? AND r.status='pending'""", (room_id, message_id)).fetchall()
    blocked = [row["name"] for row in busy if row["stoppable"] == 0]
    if blocked:
        raise FileExistsError(f"{'、'.join(blocked)} 正在执行且无法打断，这条消息继续排队，等它答完后发送")
    for row in busy:
        stop_member_work(connection, row["member_id"], "用户立即发送", "user_stop", keep_pending=True)
    if busy:
        settle_batches(connection, room_id)


def withdrawals(connection, room_id):
    """The room's taken-back messages by id, so the page keeps them in place while AI readers skip them."""
    return [dict(row) for row in connection.execute("""SELECT w.message_id,w.kind FROM message_withdrawal_rooms r
        JOIN message_withdrawals w ON w.message_id=r.message_id WHERE r.room_id=? ORDER BY r.message_id""", (room_id,))]


def owner_message(connection, room_id, message_id):
    """One visible message of the user in a free room without an open discussion, which a retract or rewind may take back."""
    row = connection.execute("SELECT * FROM messages WHERE room_id=? AND id=?", (room_id, message_id)).fetchone()
    if not row:
        raise LookupError("消息不存在")
    if row["author"] != "用户":
        raise ValueError("只能撤回或编辑用户自己的消息")
    if connection.execute("SELECT 1 FROM room_directory WHERE room_id=? AND archived=1", (room_id,)).fetchone():
        raise ValueError("房间已存档；恢复后才能撤回或编辑")
    if discussion.blocks_message_change(connection, room_id, message_id):
        raise FileExistsError("讨论进行中，或这条消息之后开启过讨论，不能撤回或编辑")
    return row


def retract_message(connection, room_id, message_id, token):
    """Owner takes back a message no member began to handle: its queued requests end and AI readers no longer see it.

    Bound to one known message, so it takes no revision; a message any member started, answered or failed is refused.
    A member working on an earlier message may still have read it, which the room cannot know.

    Returns:
        `{"message_id", "text", "duplicate"}`; the text lets the page put it back in the input for editing.
    """
    require_owner(connection, room_id, token)
    begin_write(connection)
    message = owner_message(connection, room_id, message_id)
    if connection.execute("SELECT 1 FROM message_withdrawals WHERE message_id=?", (message_id,)).fetchone():
        return {"message_id": message_id, "text": message["text"], "duplicate": True}
    if connection.execute("SELECT 1 FROM member_requests WHERE message_id=? AND status IN ('delivering','completed','failed')", (message_id,)).fetchone():
        raise FileExistsError("已有成员开始处理这条消息，不能撤回；可以编辑这条消息回退到它之前")
    connection.execute("UPDATE member_requests SET status='cancelled' WHERE message_id=? AND status='pending'", (message_id,))
    connection.execute("DELETE FROM free_queue WHERE message_id=?", (message_id,))
    connection.execute("INSERT INTO message_withdrawals (message_id,kind,created_at) VALUES (?,'retracted',?)", (message_id, int(time.time())))
    settle_batches(connection, room_id)
    return {"message_id": message_id, "text": message["text"], "duplicate": False}


# Executions a rewind takes back: any touching a message from the rewind point on, and any still running.
REWOUND_EXECUTIONS = """SELECT e.id,e.member_id FROM member_executions e WHERE e.room_id=? AND (e.status IN ('dispatched','started')
    OR EXISTS(SELECT 1 FROM member_requests r WHERE r.execution_id=e.id AND (r.message_id>=? OR r.answer_id>=?))) ORDER BY e.id"""


def rewind_plan(connection, room_id, message_id):
    """What rewinding to just before a message takes back, and a revision of the state it was read from.

    Each member reports what happens to its session: `cut` (the runner cuts it before the first taken-back execution),
    `fresh` (its context is rebuilt each time), `unchanged` (no taken-back execution) or `kept` (manual members,
    and software the runner reported it cannot cut, keep what they saw). The runner reports each member's effect from its
    adapter (`member_capabilities`); a member without a report is kept.
    """
    owner_message(connection, room_id, message_id)
    if connection.execute("SELECT 1 FROM message_withdrawals WHERE message_id=?", (message_id,)).fetchone():
        raise FileExistsError("这条消息已被撤回或回退")
    executions = {}
    for row in connection.execute(REWOUND_EXECUTIONS, (room_id, message_id, message_id)):
        executions.setdefault(row["member_id"], []).append(row["id"])
    members = []
    for row in connection.execute("""SELECT m.id,m.name,m.access,(SELECT rewind FROM member_capabilities c WHERE c.member_id=m.id) AS rewind
        FROM room_members m WHERE m.room_id=? AND m.status<>'removed' ORDER BY m.id""", (room_id,)):
        taken = executions.get(row["id"], [])
        effect = row["rewind"] if row["access"] == "runner" else "kept"
        session = "kept" if effect in (None, "kept") else "unchanged" if not taken else effect
        members.append({"id": row["id"], "name": row["name"], "executions": taken, "session": session})
    count = connection.execute("""SELECT COUNT(*) FROM messages m WHERE m.room_id=? AND m.id>=?
        AND NOT EXISTS(SELECT 1 FROM message_withdrawals w WHERE w.message_id=m.id)""", (room_id, message_id)).fetchone()[0]
    latest = connection.execute("SELECT COALESCE(MAX(id),0) FROM messages WHERE room_id=?", (room_id,)).fetchone()[0]
    state = json.dumps([message_id, latest, count, members])
    return {"message_id": message_id, "messages": count, "members": members,
            "revision": hashlib.sha256(state.encode("utf-8")).hexdigest()[:12]}


def rewind_room(connection, room_id, token, payload):
    """Owner returns the room to just before one of its messages, as editing that message does.

    Read the plan first (`GET rewind?message_id=`) and send its revision: a missing revision is refused and a changed
    one conflicts. The message and everything after it stay on the page but leave AI reads; running work stops, open
    requests on them end, members read again from before the message, and each runner member's session is cut before
    its first taken-back execution when it next works. Files the members changed are not restored.
    """
    require_owner(connection, room_id, token)
    begin_write(connection)
    message_id = payload.get("message_id")
    if type(message_id) is not int:
        raise ValueError("须提供要回退到其之前的消息编号 message_id")
    if payload.get("revision") is None:
        raise ValueError("回退前须先读取回退计划（GET rewind?message_id=），并带上其 revision")
    plan = rewind_plan(connection, room_id, message_id)
    if payload["revision"] != plan["revision"]:
        raise FileExistsError("房间已有新的消息或执行，请重新读取回退计划后再确认")
    now = int(time.time())
    for row in connection.execute("SELECT id FROM member_executions WHERE room_id=? AND status IN ('dispatched','started')", (room_id,)).fetchall():
        finish_execution(connection, row["id"], "cancelled", "用户回退了对话", "cancelled", "user_stop")
    record_cancel_reasons(connection, "room_id=? AND message_id>=? AND status='pending'", (room_id, message_id), "user_stop")
    connection.execute("UPDATE member_requests SET status='cancelled' WHERE room_id=? AND message_id>=? AND status='pending'", (room_id, message_id))
    connection.execute("DELETE FROM free_queue WHERE room_id=? AND message_id>=?", (room_id, message_id))
    # Batches of taken-back dispatches never hand back, and a dispatch the round limit held from them is never sent.
    connection.execute("UPDATE free_batches SET settled=1 WHERE room_id=? AND batch_id>=?", (room_id, message_id))
    connection.execute("""UPDATE free_sequences SET status='stopped' WHERE room_id=? AND status IN ('running','checkpoint')
        AND (batch_id>=? OR message_id>=?)""", (room_id, message_id, message_id))
    connection.execute("""UPDATE free_chain_holds SET message_id=0,host_id=0,names='[]',handoff=0,asked_rounds=0,asked_reason=''
        WHERE room_id=? AND message_id>=?""", (room_id, message_id))
    connection.execute("""INSERT INTO message_withdrawals (message_id,kind,created_at) SELECT id,'rewound',? FROM messages m
        WHERE m.room_id=? AND m.id>=? AND NOT EXISTS(SELECT 1 FROM message_withdrawals w WHERE w.message_id=m.id)""", (now, room_id, message_id))
    connection.execute("UPDATE room_members SET read_until=MIN(read_until,?) WHERE room_id=?", (message_id - 1, room_id))
    cuts = {str(member["id"]): member["executions"] for member in plan["members"] if member["session"] == "cut"}
    cursor = connection.execute("INSERT INTO room_rewinds (room_id,message_id,cuts,created_at) VALUES (?,?,?,?)",
                                (room_id, message_id, json.dumps(cuts), now))
    settle_batches(connection, room_id)
    return {"rewind_id": cursor.lastrowid, **plan}


# The runner checks this many of a member's latest rewinds before each execution.
RECENT_REWINDS = 50


def member_rewinds(connection, member_id):
    """Executions taken back from one member by recent rewinds, oldest first; the runner cuts before the earliest it finds."""
    taken = set()
    for row in connection.execute("SELECT cuts FROM room_rewinds WHERE room_id=(SELECT room_id FROM room_members WHERE id=?) ORDER BY id DESC LIMIT ?",
                                  (member_id, RECENT_REWINDS)):
        taken.update(json.loads(row["cuts"]).get(str(member_id), []))
    return sorted(taken)


def add_member(connection, room_id, token, payload, now):
    """Owner adds a member while the room keeps running; other members are not interrupted."""
    require_owner(connection, room_id, token)
    begin_write(connection)
    member = member_value(payload)
    existing = connection.execute("SELECT * FROM room_members WHERE room_id=? AND name=? AND status<>'removed'", (room_id, member["name"])).fetchone()
    if existing and existing["status"] == "active" and existing["token_hash"] == token_hash(member["token"]) and all(
            existing[key] == member[key] for key in ("adapter", "access", "session_mode")):
        return free_view(connection, room_id)
    if existing:
        raise FileExistsError(f"{member['name']} 已是本房间成员；离开的成员请用请回")
    require_fresh_member_token(connection, room_id, member["token"])
    insert_member(connection, room_id, member, now)
    queue_invited_expert(connection, room_id, member["name"], now)
    sync_participants(connection, room_id)
    return free_view(connection, room_id)


def queue_invited_expert(connection, room_id, name, now):
    """Queue a new expert at the tail of an existing live plan, without changing the current speaker or hold.

    A manual expert is queued only once it has registered (the invite alone does not), and only once per invitation.
    """
    member = connection.execute("SELECT * FROM room_members WHERE room_id=? AND name=? AND status='active'", (room_id, name)).fetchone()
    if not member or (member["adapter"] == "manual" and not registered_at(connection, member)):
        return
    session = discussion.current_session(connection, room_id)
    if session and session["status"] != "concluded":
        discussion.queue_session_invite(connection, session, member)


def adopt_manual_member(connection, room_id, member, payload):
    """Hand a manual expert to the local service once its CLI reported the session it runs in; the owner's service resumes that session."""
    reported = connection.execute("SELECT session_id FROM member_sessions WHERE member_id=?", (member["id"],)).fetchone()
    if not registered_at(connection, member):
        raise ValueError("成员尚未注册，不能转为托管")
    adapter = payload.get("adapter")
    if (not reported or reported["session_id"] != payload.get("session_id") or not isinstance(adapter, str)
            or not ADAPTER_VALUE.fullmatch(adapter) or adapter == "manual"):
        raise ValueError("成员尚未上报与之相符的会话，不能转为托管")
    if member["access"] != "manual" or member["status"] != "active":
        raise ValueError("只有在场的手动成员可以转为托管")
    connection.execute("UPDATE room_members SET access='runner',adapter=?,session_mode='borrowed' WHERE id=?", (payload["adapter"], member["id"]))
    connection.execute("DELETE FROM member_sessions WHERE member_id=?", (member["id"],))
    # A free room's service answers as the member, so it takes over with a credential the owner's side generated.
    if payload.get("token") is not None:
        require_fresh_member_token(connection, room_id, payload["token"])
        connection.execute("UPDATE room_members SET token_hash=? WHERE id=?", (token_hash(payload["token"]), member["id"]))


def record_adopt_failure(connection, room_id, member, payload):
    """Keep why the local service could not take over the reported session, so the page says why requests stay undelivered."""
    reason = payload.get("reason")
    if not isinstance(reason, str) or not reason.strip():
        raise ValueError("须提供 reason")
    reported = connection.execute("SELECT session_id FROM member_sessions WHERE member_id=?", (member["id"],)).fetchone()
    if not reported or reported["session_id"] != payload.get("session_id"):
        raise ValueError("成员尚未上报与之相符的会话")
    connection.execute("INSERT OR REPLACE INTO member_adopt_failures (member_id,room_id,session_id,reason) VALUES (?,?,?,?)",
                       (member["id"], room_id, reported["session_id"], reason.strip()[:ADOPT_REASON_LIMIT]))


def require_fresh_member_token(connection, room_id, token):
    """Prevent owner or another member's credential from being reused for a new identity."""
    hashed = token_hash(token)
    if not hashed or connection.execute("SELECT 1 FROM room_members WHERE room_id=? AND token_hash=? UNION ALL SELECT 1 FROM room_modes WHERE room_id=? AND control_hash=?",
                                        (room_id, hashed, room_id, hashed)).fetchone():
        raise ValueError("须提供独立的新成员凭证")


def member_action(connection, room_id, member_id, token, payload):
    """Owner sends a member away, brings it back with a new credential, or removes it.

    Leaving voids live work at once. Coming back requires a fresh credential, so copies of the
    old one never revive; the software session is kept by the local runner, not here. The
    `role` action makes one runner or manual member the AI host, replacing any previous host.
    """
    member = owned_member(connection, room_id, member_id, token)
    action = payload.get("action")
    routed = []
    if action in ("away", "remove"):
        if member["role"] == "host":
            discussion.pause_session_for_host_change(connection, room_id)
        else:
            discussion.session_member_change(connection, room_id, member, action)
        # Unnamed messages still waiting on a departing host move to its successor instead of being dropped.
        routed = open_route_messages(connection, member_id)
        stop_member_work(connection, member_id, "成员已离开" if action == "away" else "成员已移除",
                         "member_away" if action == "away" else "member_removed")
        connection.execute("UPDATE room_members SET status=? WHERE id=?", ("away" if action == "away" else "removed", member_id))
    elif action == "active":
        hashed = token_hash(payload.get("token"))
        if member["status"] == "active" and hashed and hmac.compare_digest(hashed, member["token_hash"]):
            return free_view(connection, room_id)
        if member["status"] != "away" or not hashed or hmac.compare_digest(hashed, member["token_hash"]):
            raise ValueError("只有离开的成员可以请回，且须提供新的成员凭证")
        require_fresh_member_token(connection, room_id, payload.get("token"))
        connection.execute("UPDATE room_members SET status='active',token_hash=? WHERE id=?", (hashed, member_id))
        if discussion.current_session(connection, room_id, active_only=True):
            discussion.session_member_change(connection, room_id, member, action)
        else:
            queue_invited_expert(connection, room_id, member["name"], int(time.time()))
    elif action == "adopt":
        adopt_manual_member(connection, room_id, member, payload)
        connection.execute("DELETE FROM member_adopt_failures WHERE member_id=?", (member_id,))
    elif action == "adopt_failed":
        record_adopt_failure(connection, room_id, member, payload)
        return free_view(connection, room_id)
    elif action == "role":
        role = payload.get("role")
        if role not in ("host", "member"):
            raise ValueError("role 须为 host 或 member")
        if role == "member" and member["role"] == "host":
            raise ValueError("自由房间须由一位 AI 主持；请指定另一位成员担任主持人")
        if role == "host":
            discussion.pause_session_for_host_change(connection, room_id)
            # Unnamed messages the old host has not started move to the new host, which carries the host rules.
            old_host = connection.execute("SELECT id FROM room_members WHERE room_id=? AND role='host' AND id<>?", (room_id, member_id)).fetchone()
            if old_host:
                routed = open_route_messages(connection, old_host["id"], pending_only=True)
                record_cancel_reasons(connection, "member_id=? AND purpose IN ('route','group') AND status='pending'", (old_host["id"],), "rerouted")
                connection.execute("UPDATE member_requests SET status='cancelled' WHERE member_id=? AND purpose IN ('route','group') AND status='pending'", (old_host["id"],))
            connection.execute("UPDATE room_members SET role='member' WHERE room_id=? AND role='host'", (room_id,))
        connection.execute("UPDATE room_members SET role=? WHERE id=?", (role, member_id))
        if role == "host":
            pin_host(connection, room_id, old_host["id"] if old_host else None)
    else:
        raise ValueError("action 须为 away、active、remove、role、adopt 或 adopt_failed")
    settle_batches(connection, room_id)
    sync_participants(connection, room_id)
    hand_over_routes(connection, room_id, routed, member_id if action in ("away", "remove") else None)
    return free_view(connection, room_id)


# Imported last: session_room imports helpers from this module, so both load in either order.
from . import session_room as discussion  # noqa: E402

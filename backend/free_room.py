"""Free collaboration rooms: member credentials, durable requests and per-member executions.

A free room has no floor, turns or rounds. The user (holding the room control credential)
names members; each named member gets one durable request per message. The local runner
delivers a runner member's open requests as one execution, and the member's answer completes
them. A manual member finds its own requests and answers by request id; an online member's
answer is forwarded by the owner. The user is the client, never the host: one member that
answers by itself always hosts, routes unnamed messages, names members in its answers, and is
woken once when everything it dispatched has finished. No software is launched here.
"""

import hashlib
import hmac
import json
import re
import time
import uuid

from .identity import MAX_ROOM_AGENTS, is_ai
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
 'limit',COALESCE((SELECT max_rounds FROM free_round_limits WHERE room_id=rooms.id),3),
 'holds',(SELECT json_group_array(json_array(chain_id,extra_rounds,message_id)) FROM free_chain_holds WHERE room_id=rooms.id),
 'stopped',(SELECT json_group_array(json_array(chain_id,reason)) FROM free_chains WHERE room_id=rooms.id),
 'withdrawn',(SELECT json_group_array(message_id) FROM message_withdrawals WHERE message_id IN (SELECT id FROM messages WHERE room_id=rooms.id))
) AS state FROM rooms WHERE id=?"""
RECENT_REQUESTS = 100
RECENT_EXECUTIONS = 100
# The timeline page reads this many recent executions of each kind; with `after` (?3) only those running or ended since.
# Parameters: ?1 room, ?2 limit, ?3 after (0 reads all). Shared verbatim with the Worker.
TIMELINE_EXECUTIONS = 100
# Rounds used and allowed in the room's recent chains, for "第 2/3 轮"; parameters: the room's limit, the room.
CHAIN_PROGRESS_SQL = """SELECT b.chain_id,COUNT(*) AS used,? + COALESCE((SELECT h.extra_rounds FROM free_chain_holds h
    WHERE h.room_id=b.room_id AND h.chain_id=b.chain_id),0) AS allowed FROM free_batches b WHERE b.room_id=?
    GROUP BY b.chain_id ORDER BY b.chain_id DESC LIMIT 10"""
TIMELINE_STATES = {"completed": "done", "failed": "failed", "cancelled": "cancelled"}
TIMELINE_FREE_IDS = "SELECT id FROM member_executions WHERE room_id=?1 AND (?3=0 OR finished_at=0 OR finished_at>=?3) ORDER BY id DESC LIMIT ?2"
TIMELINE_DISCUSSION_IDS = """SELECT e.id FROM discussion_events e LEFT JOIN event_timings t ON t.event_id=e.id
    WHERE e.room_id=?1 AND (t.dispatched_at>0 OR e.status='pending') AND (?3=0 OR COALESCE(t.finished_at,0)=0 OR t.finished_at>=?3)
    ORDER BY e.id DESC LIMIT ?2"""
# Besides times: the task an execution took on (its request message, or the discussion turn's question), its result
# (the answer's summary, else the answer's opening), its latest progress note, how many files it changed (NULL when
# unobserved), its last output time (free executions only) and the discussion run it belongs to (discussion only).
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
        CASE WHEN e.changes='' THEN NULL ELSE json_array_length(e.changes) END AS changes,NULL AS run_id
    FROM member_executions e JOIN room_members m ON m.id=e.member_id WHERE e.id IN ({TIMELINE_FREE_IDS})
    UNION ALL SELECT 'discussion',e.id,e.participant,e.role,e.status,CAST(strftime('%s',e.created_at) AS INTEGER),
        COALESCE(t.dispatched_at,0),e.started_at,COALESCE(t.finished_at,0),CASE WHEN e.status='failed' THEN e.result ELSE '' END,NULL,
        0,NULL,(SELECT substr(q.question,1,160) FROM discussion_turns q WHERE q.id=e.turn_id),
        CASE WHEN e.result LIKE 'message:%' THEN CAST(substr(e.result,9) AS INTEGER) END,NULL,NULL,e.run_id
    FROM discussion_events e LEFT JOIN event_timings t ON t.event_id=e.id WHERE e.id IN ({TIMELINE_DISCUSSION_IDS})) x"""
TIMELINE_SEGMENTS_SQL = f"""SELECT source,execution_id,phase,tool,start_ms,end_ms FROM execution_segments WHERE room_id=?1 AND (
    (source='free' AND execution_id IN ({TIMELINE_FREE_IDS})) OR (source='discussion' AND execution_id IN ({TIMELINE_DISCUSSION_IDS})))
    ORDER BY source,execution_id,seq"""
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
ACTIVE = ("dispatched", "started")
ACCESS_MODES = ("runner", "manual")
LEGACY_ACCESS_MODES = ("runner", "manual", "online")
SCHEDULER_PROVIDERS = ("jev", "decisions")
RECOMMEND_SECONDS = 60
# A click sent just before the hint disappears still counts.
RECOMMEND_GRACE_SECONDS = 5
# Rounds a host may run from one owner message by default (a round: one host dispatch, its members' answers and the
# hand-back); each owner message starts a chain. Counted in rounds, so a room with more members gets no fewer of them.
CHAIN_ROUNDS = 3
# The most rounds an owner may allow per chain, or add at once when continuing a stopped chain.
MAX_CHAIN_ROUNDS = 20
# A host that left gives up the role; the first active runner member (else manual) then takes it.
RELEASE_HOST = "UPDATE room_members SET role='member' WHERE room_id=? AND role='host' AND status<>'active'"
ASSIGN_HOST = """UPDATE room_members SET role='host' WHERE id=(SELECT id FROM room_members WHERE room_id=? AND status='active'
    AND NOT EXISTS(SELECT 1 FROM member_manual_sources source WHERE source.member_id=room_members.id AND source.source='web')
    ORDER BY access='runner' DESC, id LIMIT 1)
    AND NOT EXISTS (SELECT 1 FROM room_members WHERE room_id=? AND role='host' AND status='active')"""
TERMINAL = ("completed", "cancelled", "failed")
# A queued member has been asked once its request for that message exists.
QUEUE_ASKED = "EXISTS(SELECT 1 FROM member_requests r WHERE r.message_id={row}.message_id AND r.member_id={row}.member_id)"
SESSION_MODES = ("new", "borrowed")
FREE_OPERATIONS = ("messages", "attachments", "move", "folder", "rename", "archive", "restore", "delete")
MEMBER_FIELDS = ("id", "name", "adapter", "role", "status", "access", "session_mode", "read_until")
EXECUTION_FIELDS = ("id", "member_id", "status", "session_id", "lease_until", "created_at", "finished_at", "result",
                    "activity", "activity_at")
# What the runner found when a voided execution's software was to stop; '' until it reports.
STOP_RESULTS = ("stopped", "unstoppable", "unconfirmed")
# How long a member voided where the runner could not stop it gets no new delivery unless its late answer shows the turn ended.
HOLD_SECONDS = 600
# What a rewind does to a runner member's session, as its adapter reports.
REWIND_EFFECTS = ("cut", "fresh", "kept")
# The reported capabilities and stop result read alongside an execution aliased `e`.
CAPABILITY_COLUMNS = """(SELECT stoppable FROM execution_capabilities c WHERE c.execution_id=e.id) AS stoppable,
    (SELECT progress FROM execution_capabilities c WHERE c.execution_id=e.id) AS progress,
    (SELECT stop_result FROM execution_capabilities c WHERE c.execution_id=e.id) AS stop_result"""


def reported_capabilities(row):
    """`{stoppable, progress}` as the runner reported them for one execution, or None before it did (or an older runner)."""
    return None if row["stoppable"] is None else {"stoppable": bool(row["stoppable"]), "progress": bool(row["progress"])}
# Columns added after the first free-room tables; Python databases created by that build gain them here.
LATER_COLUMNS = {"room_members": {"access": "TEXT NOT NULL DEFAULT 'runner'", "session_mode": "TEXT NOT NULL DEFAULT 'new'"},
                 "member_executions": {"changes": "TEXT NOT NULL DEFAULT ''", "cwd": "TEXT NOT NULL DEFAULT ''",
                                       "activity": "TEXT NOT NULL DEFAULT ''", "activity_at": "INTEGER NOT NULL DEFAULT 0"},
                 "member_requests": {"chain_id": "INTEGER NOT NULL DEFAULT 0", "batch_id": "INTEGER NOT NULL DEFAULT 0",
                                     "purpose": "TEXT NOT NULL DEFAULT 'ask'", "created_by": "TEXT NOT NULL DEFAULT 'user'"}}


def migrate_free_tables(connection):
    """Add columns that early free-room databases lack; repeated runs change nothing."""
    for table, columns in LATER_COLUMNS.items():
        present = {row[1] for row in connection.execute(f"PRAGMA table_info({table})")}
        for name, definition in columns.items():
            if name not in present:
                connection.execute(f"ALTER TABLE {table} ADD COLUMN {name} {definition}")
    connection.execute("""CREATE TABLE IF NOT EXISTS member_manual_sources (
        member_id INTEGER PRIMARY KEY REFERENCES room_members(id) ON DELETE CASCADE,
        source TEXT NOT NULL CHECK(source='web'))""")
    connection.execute("""INSERT OR IGNORE INTO member_manual_sources(member_id,source)
        SELECT id,'web' FROM room_members WHERE access='online'""")
    connection.execute("UPDATE room_members SET access='manual' WHERE access='online'")
    connection.execute("UPDATE room_modes SET mode='free' WHERE mode='brainstorm'")
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


def room_mode(connection, room_id):
    """Return 'free' for free rooms; every legacy room is a brainstorm room."""
    row = connection.execute("SELECT mode FROM room_modes WHERE room_id=?", (room_id,)).fetchone()
    return row[0] if row else "brainstorm"


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
    if not chain_id or rounds_left(connection, room_id, chain_id) < 1:
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
    if facts["remaining"] < 1:
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


def finish_review_handoff(connection, handoff):
    """Finish the host execution only when its other requests have all been handled."""
    execution_id = handoff["execution_id"]
    if not execution_id or connection.execute("SELECT 1 FROM member_requests WHERE execution_id=? AND status='delivering'", (execution_id,)).fetchone():
        return False
    connection.execute("UPDATE member_executions SET status='completed',finished_at=?,result='review_advanced' WHERE id=?",
                       (int(time.time()), execution_id))
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
    if access not in LEGACY_ACCESS_MODES or session_mode not in SESSION_MODES:
        raise ValueError("成员接入方式须为 runner/manual/online，会话方式须为 new/borrowed")
    manual_source = member.get("manual_source", "")
    if access == "online":
        manual_source, access = "web", "manual"
    if manual_source not in ("", "web") or (manual_source == "web" and access != "manual"):
        raise ValueError("manual_source 只能为 manual 成员配置 web")
    return {"name": member["name"], "adapter": adapter, "token": member["token"],
            "access": access, "session_mode": session_mode, "manual_source": manual_source}


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
    if member.get("manual_source") == "web" or member.get("access") == "online":
        member_id = connection.execute("SELECT id FROM room_members WHERE room_id=? AND name=? AND token_hash=?",
                                       (room_id, member["name"], token_hash(member["token"]))).fetchone()[0]
        connection.execute("INSERT OR IGNORE INTO member_manual_sources(member_id,source) VALUES(?,'web')", (member_id,))


def save_room_access(connection, room_id, control_token, members, settings):
    """Persist the mode, the owner's control hash and the members in the creating transaction."""
    control = token_hash(control_token)
    if not control:
        raise ValueError("建房须提供 32–256 字符的房间控制凭据")
    if any(token_hash(member["token"]) == control for member in members):
        raise ValueError("成员凭证不能与房主控制凭据相同")
    connection.execute("INSERT INTO room_modes (room_id,mode,control_hash) VALUES (?,?,?)", (room_id, settings["mode"], control))
    for member in members:
        insert_member(connection, room_id, member, settings["created_at"])
    connection.execute("UPDATE room_members SET role='host' WHERE room_id=? AND name=?", (room_id, settings["host"]))


def discussion_access_ok(access, capability, automatic, is_host, manual_source=""):
    """Require web relays to stay read-only while local participants use runner or manual access."""
    if capability == "online":
        return access == "manual" and manual_source == "web" and not is_host
    if manual_source == "web":
        return False
    if not automatic:
        return access == "manual"
    return access == "runner" or (access == "manual" and not is_host)


def mark_manual(member, automatic):
    """A manual expert of a woken discussion carries adapter 'manual', so mode switches never turn it into a woken member."""
    return {**member, "adapter": "manual"} if automatic and member["access"] == "manual" else member


def discussion_members(payload, settings):
    """Validate credentials against the room's declared participants and delivery mode."""
    members = member_values(payload.get("members")) if settings["experts"] else []
    if {member["name"] for member in members} != set(settings["experts"]):
        raise ValueError("成员凭证名单须与参与者名单一致")
    for member in members:
        if not discussion_access_ok(member["access"], settings["experts"][member["name"]],
                                    payload.get("runtime_mode") == "automatic", member["name"] == settings["host"],
                                    member["manual_source"]):
            raise ValueError("成员接入方式与房间参与能力、任务交付方式不符")
    return [mark_manual(member, payload.get("runtime_mode") == "automatic") for member in members]


def sync_discussion_members(connection, room_id, payload, settings):
    """Keep existing credentials; require fresh credentials for added or changed members."""
    current = {row["name"]: row for row in connection.execute("""SELECT m.*,
        COALESCE(s.source,'') AS manual_source FROM room_members m
        LEFT JOIN member_manual_sources s ON s.member_id=m.id WHERE m.room_id=? AND m.status='active'""", (room_id,))}
    supplied = {member["name"]: member_value(member) for member in payload.get("members", [])}
    run = connection.execute("SELECT mode FROM discussion_runtime WHERE room_id=?", (room_id,)).fetchone()
    for name, capability in settings["experts"].items():
        automatic = bool(run and run[0] == "automatic")
        old = current.get(name)
        if old and (old["manual_source"] == "web") == (capability == "online"):
            if name in supplied and token_hash(supplied[name]["token"]) != old["token_hash"]:
                raise FileExistsError("成员凭证与已登记身份不符；请核对原接入文件")
            continue
        if name not in supplied or not discussion_access_ok(supplied[name]["access"], capability, automatic,
                                                              name == settings["host"], supplied[name]["manual_source"]):
            raise ValueError(f"新增或改变接入方式的成员 {name} 须提供独立的新凭证")
        member = mark_manual(supplied[name], automatic)
        hashed = token_hash(member["token"])
        if connection.execute("SELECT 1 FROM room_members WHERE room_id=? AND token_hash=? UNION ALL SELECT 1 FROM room_modes WHERE room_id=? AND control_hash=?", (room_id, hashed, room_id, hashed)).fetchone():
            raise ValueError("新成员凭证不能复用已有凭证")
        connection.execute("UPDATE room_members SET status='removed' WHERE room_id=? AND name=?", (room_id, name))
        insert_member(connection, room_id, member, int(time.time()))
    for name in current.keys() - settings["experts"].keys():
        connection.execute("UPDATE room_members SET status='removed' WHERE room_id=? AND name=?", (room_id, name))
    connection.execute("UPDATE room_members SET role=CASE WHEN name=? THEN 'host' ELSE 'member' END WHERE room_id=?", (settings["host"], room_id))


def sync_participants(connection, room_id):
    """Keep one active AI host, then mirror member capabilities and the host into shared room metadata."""
    connection.execute(RELEASE_HOST, (room_id,))
    connection.execute(ASSIGN_HOST, (room_id, room_id))
    members = connection.execute("""SELECT m.name,m.access,m.role,m.status,COALESCE(s.source,'') AS manual_source
        FROM room_members m LEFT JOIN member_manual_sources s ON s.member_id=m.id
        WHERE m.room_id=? AND m.status<>'removed' ORDER BY m.id""", (room_id,)).fetchall()
    experts = {row["name"]: "online" if row["manual_source"] == "web" else "cli" for row in members}
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
    """Record what a rewind does to one runner member's session, as the runner's adapter for it reports.

    Bound to one known member and replaced whole, so it takes no revision. Returns `{member_id, rewind}`.
    """
    require_owner(connection, room_id, token)
    begin_write(connection)
    if not connection.execute("SELECT 1 FROM room_members WHERE room_id=? AND id=?", (room_id, member_id)).fetchone():
        raise LookupError("成员不存在")
    if payload.get("rewind") not in REWIND_EFFECTS:
        raise ValueError(f"rewind 须为 {'、'.join(REWIND_EFFECTS)}")
    connection.execute("""INSERT INTO member_capabilities (member_id,room_id,rewind) VALUES (?,?,?)
        ON CONFLICT(member_id) DO UPDATE SET rewind=excluded.rewind""", (member_id, room_id, payload["rewind"]))
    return {"member_id": member_id, "rewind": payload["rewind"]}


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
    """The owner's display labels of members by name; only screens use them, never addressing or credentials."""
    return {row["name"]: row["label"] for row in connection.execute(
        "SELECT name,label FROM member_labels WHERE room_id=? ORDER BY name", (room_id,))}


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
    """Read the room's recent executions of both kinds with their phase segments and note times, for the timeline page.

    Times are epoch seconds and segments are millisecond offsets from `dispatched_at`. A free execution's parent is the
    execution that wrote the message it answers; discussion executions have none. `state` is running, done, failed
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
        row["notes"] = notes.get(row["id"], []) if row["source"] == "free" else []
    return {"now": int(time.time()), "after": params[2], "executions": rows, "execution_limit": TIMELINE_EXECUTIONS,
            "segment_limit": MAX_EXECUTION_SEGMENTS}


def recent_executions(connection, room_id):
    """Return bounded public reports, including requests no longer in the recent request list."""
    rows = connection.execute(f"""SELECT e.*,m.name AS member,
        (SELECT json_group_array(id) FROM member_requests WHERE execution_id=e.id) AS request_ids,
        (SELECT MAX(answer_id) FROM member_requests WHERE execution_id=e.id) AS answer_id,
        (SELECT MIN(message_id) FROM member_requests WHERE execution_id=e.id) AS request_message_id,
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
            "answer_id": row["answer_id"], "request_message_id": row["request_message_id"], "requests": requests,
            "notes": row["note_count"], "denials": json.loads(row["denials"] or "[]"),
            "capabilities": reported_capabilities(row), "stop_result": row["stop_result"] or "",
            "late_answer": json.loads(row["late_answer"]) if row["late_answer"] else None,
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
    """Report files changed by executions of different members whose time windows overlapped.

    This is an observation, not attribution: it cannot tell who wrote which part or catch
    writes outside the scanned working directory.
    """
    now = int(time.time())
    rows = [dict(row) for row in connection.execute(
        """SELECT id,member_id,created_at,finished_at,changes,cwd FROM member_executions
        WHERE room_id=? AND changes<>'' ORDER BY id DESC LIMIT ?""", (room_id, RECENT_CHANGES))]
    for row in rows:
        row["files"] = set(json.loads(row["changes"]))
        row["end"] = row["finished_at"] or now
    conflicts = []
    for index, first in enumerate(rows):
        for second in rows[index + 1:]:
            if first["member_id"] == second["member_id"] or first["cwd"] != second["cwd"]:
                continue
            if first["created_at"] > second["end"] or second["created_at"] > first["end"]:
                continue
            files = sorted(first["files"] & second["files"])
            if files:
                conflicts.append({"members": [names.get(second["member_id"], ""), names.get(first["member_id"], "")],
                                  "executions": [second["id"], first["id"]], "files": files})
    return conflicts


# An invited manual member that has not registered counts as absent: it receives no request and is never a target.
REGISTERED_MEMBER = """(room_members.access<>'manual' OR EXISTS(SELECT 1 FROM member_manual_sources source
    WHERE source.member_id=room_members.id AND source.source='web') OR EXISTS(SELECT 1 FROM member_registrations r
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
        source = connection.execute("SELECT source FROM member_manual_sources WHERE member_id=?", (row["id"],)).fetchone()
        member["manual_source"] = source[0] if source else ""
        member["registered_at"] = registered_at(connection, row)
        reported = connection.execute("SELECT session_id,client FROM member_sessions WHERE member_id=?", (row["id"],)).fetchone()
        member["reported_session"], member["reported_client"] = (reported["session_id"], reported["client"]) if reported else ("", "")
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
    progress = [dict(row) for row in connection.execute(CHAIN_PROGRESS_SQL, (max_rounds, room_id))]
    return {"members": members, "requests": requests[::-1], "executions": recent_executions(connection, room_id),
            "conflicts": possible_conflicts(connection, room_id, names), "halted_chains": chains, "max_rounds": max_rounds,
            "chain_rounds": progress, "recommendations": recent_recommendations(connection, room_id, now)[::-1]}


def require_member(connection, room_id, token, name=None):
    """Resolve an active member strictly from its own credential."""
    hashed = token_hash(token)
    row = connection.execute("SELECT * FROM room_members WHERE room_id=? AND token_hash=? AND status='active'",
                             (room_id, hashed)).fetchone() if hashed else None
    if not row or (name is not None and row["name"] != name):
        raise PermissionError("成员凭证无效、已停用或与发言身份不符")
    if connection.execute("SELECT 1 FROM member_manual_sources WHERE member_id=? AND source='web'", (row["id"],)).fetchone():
        raise PermissionError("网页成员只读；由房主凭据代发其回答")
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
    member = require_member(connection, room_id, token)
    if author == member["name"] and payload.get("submitted_by", author) == author:
        return member
    if member["role"] == "host" and author != member["name"] and payload.get("submitted_by") == member["name"]:
        proxy = proxy_member(connection, room_id, author)
        proxy["proxy_by"] = member["name"]
        return proxy
    raise PermissionError("成员只能以本人身份发言；只有主持人可以代发在线成员回答")


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
    AI host for routing; only a room of online members has none, and then it stays a plain note.
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


def route_held_messages(connection, room_id, host):
    """When a discussion ends, hand the user's messages its host never answered to the free room's recipients, as if just sent."""
    held = connection.execute("SELECT held_since FROM turn_relay WHERE room_id=?", (room_id,)).fetchone()
    if held and held[0]:
        rows = connection.execute("""SELECT id FROM messages m WHERE room_id=? AND author='用户' AND id>=?
            AND id>COALESCE((SELECT MAX(id) FROM messages WHERE room_id=? AND author=?),0)
            AND NOT EXISTS(SELECT 1 FROM member_requests r WHERE r.message_id=m.id) ORDER BY id""",
                                  (room_id, held[0], room_id, host)).fetchall()
        for row in rows:
            for member_id, purpose in recipients(connection, room_id, {}):
                insert_request(connection, room_id, member_id, row["id"], row["id"], purpose, "user")
    connection.execute("UPDATE turn_relay SET held_since=0 WHERE room_id=?", (room_id,))


def proxy_member(connection, room_id, author):
    """Return the active online member the owner may forward an answer for."""
    row = connection.execute("""SELECT m.*,s.source AS manual_source FROM room_members m
        JOIN member_manual_sources s ON s.member_id=m.id AND s.source='web'
        WHERE m.room_id=? AND m.name=? AND m.status='active' AND m.access='manual'""",
        (room_id, author)).fetchone()
    if not row:
        raise PermissionError("房间控制凭据只能以用户身份发言，或代发在线成员的回答")
    return dict(row)


def check_answer(connection, room_id, member, payload):
    """A runner member completes a live execution; a manual member may close its own open requests.

    Only the AI host dispatches work; other members' targets remain suggestions.
    """
    if payload.get("to") is not None:
        named_members(active_members(connection, room_id), payload["to"], exclude=member["name"])
    if payload.get("handoff") not in (None, False) and (payload["handoff"] is not True or member["role"] != "host" or not payload.get("to")):
        raise ValueError("handoff 只能由主持人与 to 一起使用，值为 true")
    if member["access"] == "online":
        raise PermissionError("在线成员只读，回答由用户代发")
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
    if row["status"] not in ACTIVE or row["lease_until"] <= int(time.time()):
        if row["status"] == "cancelled":
            # Kept apart from the transcript: the page shows it folded, and it marks the end of a turn the runner could not stop.
            connection.execute("INSERT OR IGNORE INTO late_answers (execution_id,room_id,text,created_at) VALUES (?,?,?,?)",
                               (execution_id, room_id, str(payload.get("text") or ""), int(time.time())))
            connection.commit()
        raise FileExistsError("本次执行已结束、被打断或已过期；回答不能改作普通发言，请保留草稿")
    requests = [dict(item) for item in connection.execute(
        "SELECT id,purpose FROM member_requests WHERE execution_id=? AND status='delivering'", (execution_id,))]
    discussion.validate_session_request_answer(connection, room_id, requests)
    check_dispatch(member, payload, [item["purpose"] for item in requests])
    return row


def check_dispatch(member, payload, purposes):
    """A host answering only its share of an everyone request answers as a member, so it may not dispatch others."""
    if member["role"] == "host" and payload.get("to") and purposes and all(purpose == "all" for purpose in purposes):
        raise ValueError("这次是请全体成员各自回应，其他成员已收到请求；主持人只回答自己的部分，不能用 --to 派活")


def check_proxy(connection, room_id, member, payload):
    """The owner forwards an online member's answer and may close that member's open requests."""
    request_ids = payload.get("request_ids", [])
    if not isinstance(request_ids, list) or any(type(item) is not int for item in request_ids):
        raise ValueError("request_ids 须为请求编号列表")
    requests = []
    for request_id in request_ids:
        row = connection.execute("SELECT * FROM member_requests WHERE room_id=? AND id=?", (room_id, request_id)).fetchone()
        if not row or row["member_id"] != member["id"] or row["status"] != "pending":
            raise FileExistsError(f"请求 {request_id} 不属于该在线成员或已处理")
        requests.append(row)
    discussion.validate_session_request_answer(connection, room_id, requests)


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
    """Save ordinary members' explicit targets and prose mentions without waking anyone."""
    if member == "用户" or member["role"] == "host":
        return
    active = active_members(connection, room_id)
    targets = set(named_members(active, payload["to"] if payload.get("to") is not None else [], exclude=member["name"]))
    prose = mention_prose(str(payload.get("text", "")))
    for name, target in active.items():
        if name != member["name"] and re.search(r"(^|[\s(（，,。；;：:])@" + re.escape(name) + r"(?![A-Za-z0-9_\-\u4e00-\u9fff])", prose):
            targets.add(target["id"])
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
    """Rounds a chain may still start: the room's limit plus what the owner added, less the dispatches made; none once halted."""
    if connection.execute("SELECT 1 FROM free_chains WHERE room_id=? AND chain_id=?", (room_id, chain_id)).fetchone():
        return 0
    used = connection.execute("SELECT COUNT(*) FROM free_batches WHERE room_id=? AND chain_id=?", (room_id, chain_id)).fetchone()[0]
    extra = connection.execute("SELECT extra_rounds FROM free_chain_holds WHERE room_id=? AND chain_id=?", (room_id, chain_id)).fetchone()
    return chain_rounds(connection, room_id) + (extra[0] if extra else 0) - used


def chain_rounds(connection, room_id):
    """Rounds a host may run from one owner message in this room."""
    row = connection.execute("SELECT max_rounds FROM free_round_limits WHERE room_id=?", (room_id,)).fetchone()
    return row[0] if row else CHAIN_ROUNDS


def set_chain_rounds(connection, room_id, token, payload):
    """Owner sets the room's round limit; it applies to chains still running and to later ones."""
    require_owner(connection, room_id, token)
    value = payload.get("max_rounds")
    if type(value) is not int or not 1 <= value <= MAX_CHAIN_ROUNDS:
        raise ValueError(f"max_rounds 须为 1–{MAX_CHAIN_ROUNDS} 的整数")
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
    connection.execute("UPDATE free_chain_holds SET message_id=0,host_id=0,names='[]',handoff=0 WHERE room_id=? AND chain_id=?", (room_id, chain_id))
    if held["message_id"]:
        dispatch(connection, room_id, host, held["message_id"], json.loads(held["names"]), chain_id, bool(held["handoff"]))
    return free_view(connection, room_id)


def hold_dispatch(connection, room_id, host, message_id, names, chain_id, handoff):
    """Stop a chain at its round limit, keeping the dispatch it held back so the owner can send it by continuing."""
    halt_chain(connection, room_id, chain_id, "budget")
    connection.execute("""INSERT INTO free_chain_holds (room_id,chain_id,message_id,host_id,names,handoff) VALUES (?,?,?,?,?,?)
        ON CONFLICT(room_id,chain_id) DO UPDATE SET message_id=excluded.message_id,host_id=excluded.host_id,names=excluded.names,
        handoff=excluded.handoff""", (room_id, chain_id, message_id, host["id"], json.dumps(list(names), ensure_ascii=False), int(handoff)))


def dispatch(connection, room_id, host, message_id, names, chain_id, handoff=False):
    """Queue the host's named members as one batch, one round; several members, or one the host asked back, hand back when it ends."""
    member_ids = named_members(active_members(connection, room_id), names, exclude=host["name"])
    if not member_ids or not chain_id:
        return
    if rounds_left(connection, room_id, chain_id) < 1:
        hold_dispatch(connection, room_id, host, message_id, names, chain_id, handoff)
        return
    for member_id in member_ids:
        insert_request(connection, room_id, member_id, message_id, chain_id, "ask", "host", batch_id=message_id)
    connection.execute("INSERT INTO free_batches (room_id,batch_id,chain_id,host_id) VALUES (?,?,?,?)",
                       (room_id, message_id, chain_id, host["id"]))
    if handoff:
        connection.execute("INSERT INTO free_handoffs (room_id,batch_id) VALUES (?,?)", (room_id, message_id))


def settle_batches(connection, room_id):
    """Hand each finished batch back to its host once; an all-failed batch halts its chain instead."""
    for batch in connection.execute("SELECT * FROM free_batches WHERE room_id=? AND settled=0", (room_id,)).fetchall():
        statuses = [row[0] for row in connection.execute("SELECT status FROM member_requests WHERE room_id=? AND batch_id=?",
                                                          (room_id, batch["batch_id"]))]
        if any(status not in TERMINAL for status in statuses):
            continue
        connection.execute("UPDATE free_batches SET settled=1 WHERE room_id=? AND batch_id=?", (room_id, batch["batch_id"]))
        host = connection.execute("SELECT * FROM room_members WHERE id=? AND status='active' AND role='host'", (batch["host_id"],)).fetchone()
        review = connection.execute("SELECT 1 FROM review_plans WHERE room_id=? AND (batch_id=? OR review_batch_id=?)", (room_id, batch["batch_id"], batch["batch_id"])).fetchone()
        if "completed" not in statuses:
            halt_chain(connection, room_id, batch["chain_id"], "all_failed")
            if review and host:
                insert_request(connection, room_id, host["id"], batch["batch_id"], batch["chain_id"], "handoff", "host")
        elif not host or len(statuses) < 2 and not connection.execute(
                "SELECT 1 FROM free_handoffs WHERE room_id=? AND batch_id=?", (room_id, batch["batch_id"])).fetchone():
            # One member's answer reaches the user directly unless the host asked for it back, e.g. to send it to a reviewer.
            continue
        else:
            # The hand-back closes the round it belongs to, so it is never held back: the last round still gets its summary.
            insert_request(connection, room_id, host["id"], batch["batch_id"], batch["chain_id"], "handoff", "host")
    advance_queues(connection, room_id)


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
    connection.execute(f"""DELETE FROM free_queue WHERE room_id=? AND NOT {QUEUE_ASKED.format(row="free_queue")}
        AND NOT EXISTS(SELECT 1 FROM room_members m WHERE m.id=free_queue.member_id AND m.status='active')""", (room_id,))
    connection.execute(f"""INSERT OR IGNORE INTO member_requests (room_id,member_id,message_id,chain_id,batch_id,purpose,created_by,created_at)
        SELECT q.room_id,q.member_id,q.message_id,q.message_id,0,'ask','user',? FROM free_queue q
        WHERE q.room_id=? AND q.id=(SELECT MIN(x.id) FROM free_queue x WHERE x.message_id=q.message_id AND NOT {QUEUE_ASKED.format(row="x")})
        AND NOT EXISTS(SELECT 1 FROM member_requests r WHERE r.message_id=q.message_id AND r.status IN ('pending','delivering'))""",
                       (int(time.time()), room_id))


def default_order(connection, room_id, members):
    """Members in the room's saved speaking order; without one (or for members it lacks), the host first, then by joining order."""
    row = connection.execute("SELECT member_ids FROM speaking_orders WHERE room_id=?", (room_id,)).fetchone()
    rank = {member_id: index for index, member_id in enumerate(json.loads(row[0]) if row else [])}
    return sorted(members, key=lambda member: (member["id"] not in rank, rank.get(member["id"], 0), member["role"] != "host", member["id"]))


def speaking_order(connection, room):
    """Who spoke, who speaks now and who is next, shared by free rooms and discussions; only the not-yet-spoken part may be reordered.

    A free room shows its latest unfinished one-after-another queue, else every member in the room's default order;
    a discussion shows the open round: speakers so far, the current turn, then this round's queued turns; a plan reaching into
    later rounds lists them apart in `later` (one name list per round), read-only. The revision changes with any of it.
    """
    active = [member for member in room["members"] if member["status"] == "active"]
    by_id = {member["id"]: member for member in active}
    ordered = [member["name"] for member in default_order(connection, room["id"], active)]
    items, kind, target, later = [], "default", 0, []
    session_plan_state = []
    if room["mode"] == "free":
        session = discussion.current_session(connection, room["id"], active_only=True)
        if session:
            kind = "turns"
            target = session["id"]
            items, later, session_plan_state = discussion.session_speaking_order(connection, session)
        else:
            target = connection.execute("""SELECT MAX(q.message_id) FROM free_queue q LEFT JOIN member_requests r ON r.message_id=q.message_id
                AND r.member_id=q.member_id WHERE q.room_id=? AND (r.id IS NULL OR r.status IN ('pending','delivering'))""", (room["id"],)).fetchone()[0] or 0
            if target:
                kind = "queue"
                for row in connection.execute("""SELECT q.member_id,r.status FROM free_queue q LEFT JOIN member_requests r
                    ON r.message_id=q.message_id AND r.member_id=q.member_id WHERE q.message_id=? ORDER BY q.id""", (target,)):
                    if row["member_id"] in by_id:
                        state = "queued" if row["status"] is None else "speaking" if row["status"] in ("pending", "delivering") else "done"
                        items.append({"name": by_id[row["member_id"]]["name"], "state": state})
    else:
        kind = "turns"
        last = room["rounds"][-1] if room["rounds"] else None
        turn = room["current_turn"]
        speaking = turn["expert"] if turn and turn["status"] in ("pending", "notified") else None
        items = [{"name": name, "state": "done"} for name in (last["speakers"] if last and not last["completed"] else []) if name != speaking]
        if speaking:
            items.append({"name": speaking, "state": "speaking"})
        rounds = split_rounds([item["expert"] for item in room["queued_turns"]], {item["name"] for item in items})
        items += [{"name": name, "state": "queued"} for name in rounds[0]]
        later = rounds[1:]
        # The user may still hold the host seat of an old discussion; only AI participants have a place.
        ordered = [name for name in [room["host"], *ordered, *room["experts"]] if (name in room["experts"] or name == room["host"]) and name != "用户"]
    listed = {item["name"] for item in items}
    items += [{"name": name, "state": "idle"} for name in dict.fromkeys(ordered) if name not in listed]
    movable = "queued" if kind != "default" else "idle"
    state = json.dumps([kind, target, [[item["name"], item["state"]] for item in items], later, session_plan_state], ensure_ascii=False)
    return {"kind": kind, "message_id": target, "items": items, "later": later, "movable": [item["name"] for item in items if item["state"] == movable],
            "default": [member["name"] for member in default_order(connection, room["id"], active)],
            "revision": hashlib.sha256(state.encode("utf-8")).hexdigest()[:12]}


def split_rounds(names, spoken):
    """Cut a turn queue into rounds: an expert who already spoke in the round being filled starts the next one."""
    rounds, seen = [[]], set(spoken)
    for name in names:
        if name in seen:
            rounds.append([])
            seen = set()
        rounds[-1].append(name)
        seen.add(name)
    return rounds


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
    if current["kind"] == "queue":
        connection.execute(f"DELETE FROM free_queue WHERE message_id=? AND NOT {QUEUE_ASKED.format(row='free_queue')}", (current["message_id"],))
        for name in order:
            connection.execute("INSERT INTO free_queue (room_id,message_id,member_id) VALUES (?,?,?)", (room["id"], current["message_id"], names[name]))
    elif current["kind"] == "turns":
        session = discussion.current_session(connection, room["id"], active_only=True)
        if session:
            discussion.reorder_session_turns(connection, session, order, names)
        else:
            reorder_turns(connection, room["id"], order)
    else:
        connection.execute("INSERT OR REPLACE INTO speaking_orders (room_id,member_ids) VALUES (?,?)",
                           (room["id"], json.dumps([names[name] for name in order])))


def reorder_turns(connection, room_id, order):
    """Move this round's queued turns into the new order; ids keep the relay order, so each turn's content moves to the id at its new place.

    This round's turns lead the queue, so they are its first rows; later rounds keep theirs.
    """
    rows = [dict(row) for row in connection.execute("SELECT * FROM discussion_turns WHERE room_id=? AND status='queued' ORDER BY id LIMIT ?",
                                                    (room_id, len(order)))]
    remaining, moved = list(rows), []
    for name in order:
        moved.append(remaining.pop(next(index for index, row in enumerate(remaining) if row["expert"] == name)))
    # Submission ids are unique, so free them before writing them to their new rows.
    for slot in rows:
        connection.execute("UPDATE discussion_turns SET submission_id=submission_id||':moving:'||id WHERE id=?", (slot["id"],))
    for slot, content in zip(rows, moved):
        connection.execute("UPDATE discussion_turns SET expert=?,question=?,submission_id=?,created_at=? WHERE id=?",
                           (content["expert"], content["question"], content["submission_id"], content["created_at"], slot["id"]))


def answered_chain(connection, payload, actor):
    """The chain an answer continues: the newest chain among the requests it completes."""
    if actor["access"] == "manual":
        ids = payload.get("request_ids") or [0]
        marks = ",".join("?" * len(ids))
        row = connection.execute(f"SELECT MAX(chain_id) FROM member_requests WHERE id IN ({marks})", ids).fetchone()
    else:
        row = connection.execute("SELECT MAX(chain_id) FROM member_requests WHERE execution_id=?", (payload["execution_id"],)).fetchone()
    return row[0] or 0


def after_free_message(connection, room_id, message_id, actor, payload):
    """Create requests for the owner's message, or close what the member's answer covers."""
    now = int(time.time())
    if actor == "用户":
        if discussion.hold_user_message(connection, room_id, message_id, payload):
            return
        pairs = recipients(connection, room_id, payload)
        if payload.get("sequential") is True and payload.get("to") is not None:
            queue_in_turn(connection, room_id, message_id, [member_id for member_id, _ in pairs])
            return
        for member_id, purpose in pairs:
            insert_request(connection, room_id, member_id, message_id, message_id, purpose, "user")
        return
    if actor.get("manual_source") == "web":
        for request_id in payload.get("request_ids", []):
            connection.execute("UPDATE member_requests SET status='completed',answer_id=? WHERE id=?", (message_id, request_id))
        settle_batches(connection, room_id)
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
    if actor["role"] == "host" and payload.get("to"):
        dispatch(connection, room_id, actor, message_id, payload["to"], chain_id, payload.get("handoff") is True or bool(payload.get("next_review")))
    settle_batches(connection, room_id)


def discussion_host_handles(connection, room):
    """A running discussion already wakes its host for every user message, so a question to the host needs no request of its own."""
    return room["phase"] not in ("paused", "concluded") and bool(connection.execute(
        "SELECT 1 FROM discussion_runtime WHERE room_id=? AND status='running'", (room["id"],)).fetchone())


def checked_asks(connection, room, payload):
    """Validate the user's direct questions to members of a discussion before the message is stored."""
    names = payload.get("to")
    if names is None:
        return []
    return named_members(active_members(connection, room["id"]), names)


def ask_members(connection, room, message_id, member_ids):
    """Queue one 'ask' request per named member, outside the discussion's turns, rounds and limits."""
    host_busy = discussion_host_handles(connection, room)
    for member_id in member_ids:
        row = connection.execute("SELECT name FROM room_members WHERE id=?", (member_id,)).fetchone()
        if host_busy and row["name"] == room["host"]:
            continue
        insert_request(connection, room["id"], member_id, message_id, message_id, "ask", "user")


def asks_view(connection, room_id):
    """Direct questions of a discussion room: recent requests with their member, for status badges beside messages."""
    names = {row["id"]: row["name"] for row in connection.execute("SELECT id,name FROM room_members WHERE room_id=?", (room_id,))}
    requests = [{**dict(row), "member": names.get(row["member_id"], "")} for row in connection.execute(
        """SELECT id,member_id,message_id,status,execution_id,answer_id,chain_id,batch_id,purpose,created_by,created_at,
        (SELECT reason FROM request_cancel_reasons c WHERE c.request_id=member_requests.id) AS cancel_reason FROM member_requests
        WHERE room_id=? ORDER BY id DESC LIMIT ?""", (room_id, RECENT_REQUESTS))]
    return {"requests": requests[::-1], "executions": recent_executions(connection, room_id)}


def expire_executions(connection, room_id):
    """Fail executions whose lease lapsed; their requests stay visible as failed, never silently retried."""
    now = int(time.time())
    stale = connection.execute(
        "SELECT id FROM member_executions WHERE room_id=? AND status IN ('dispatched','started') AND lease_until<=?", (room_id, now)).fetchall()
    for row in stale:
        finish_execution(connection, row["id"], "failed", "执行租约到期，接入程序未续租", "failed")
    if stale:
        settle_batches(connection, room_id)


def record_cancel_reasons(connection, where, params, reason):
    """Remember why requests are about to be cancelled; call before the status change selects them."""
    connection.execute(f"INSERT OR REPLACE INTO request_cancel_reasons (request_id,reason) SELECT id,? FROM member_requests WHERE {where}", (reason, *params))


def finish_execution(connection, execution_id, status, result, request_status, cancel_reason=""):
    """End one execution and move its delivered requests in the same transaction."""
    if request_status == "cancelled" and cancel_reason:
        record_cancel_reasons(connection, "execution_id=? AND status='delivering'", (execution_id,), cancel_reason)
    discussion_requests = discussion.open_discussion_requests(connection, execution_id)
    connection.execute("UPDATE member_executions SET status=?,finished_at=?,result=? WHERE id=? AND status IN ('dispatched','started')",
                       (status, int(time.time()), result[:500], execution_id))
    connection.execute("UPDATE member_requests SET status=?,execution_id=CASE WHEN ?='pending' THEN NULL ELSE execution_id END WHERE execution_id=? AND status='delivering'",
                       (request_status, request_status, execution_id))
    if status == "failed" and request_status == "failed":
        for row in discussion_requests:
            discussion.fail_session_request(connection, row["id"], result)


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
    stop_room_work(connection, room_id, "用户停止全部", "user_stop")
    return free_view(connection, room_id)


def stop_room_work(connection, room_id, reason, cancel_reason):
    """Void every live execution and open request of a room, e.g. when it is archived."""
    for row in connection.execute("SELECT id FROM member_executions WHERE room_id=? AND status IN ('dispatched','started')",
                                  (room_id,)).fetchall():
        finish_execution(connection, row["id"], "cancelled", reason, "cancelled", cancel_reason)
    record_cancel_reasons(connection, "room_id=? AND status='pending'", (room_id,), cancel_reason)
    connection.execute("UPDATE member_requests SET status='cancelled' WHERE room_id=? AND status='pending'", (room_id,))
    settle_batches(connection, room_id)


def inbox(connection, room_id, token):
    """List what the runner should deliver or reconcile; owner credential only."""
    require_owner(connection, room_id, token)
    begin_write(connection)
    enforce_session_limits(connection, room_id)
    expire_executions(connection, room_id)
    release_recommendations(connection, room_id)
    archived = connection.execute("SELECT archived FROM room_directory WHERE room_id=?", (room_id,)).fetchone()[0]
    members, observers = [], []
    # Manual and online members are never delivered to; the runner only reads them so smart scheduling can route to them too.
    for row in connection.execute(f"SELECT * FROM room_members WHERE room_id=? AND status='active' AND {REGISTERED_MEMBER} ORDER BY id", (room_id,)):
        pending = [dict(item) for item in connection.execute("""SELECT r.id,r.message_id,r.purpose,
            sr.id AS session_request_id,sr.session_id,sr.round,sr.position,sr.read_until,sr.question AS source_question,
            t.cause_kind,t.cause_message_id AS source_message_id,t.cause_request_id,
            (SELECT action FROM group_routes WHERE message_id=r.message_id) AS group_action
            FROM member_requests r LEFT JOIN session_requests sr ON sr.member_request_id=r.id
            LEFT JOIN task_message_sources t ON t.session_request_id=sr.id
            WHERE r.member_id=? AND r.status='pending' ORDER BY r.id""", (row["id"],))]
        manual_source = connection.execute("SELECT source FROM member_manual_sources WHERE member_id=?", (row["id"],)).fetchone()
        member_view = {key: row[key] for key in MEMBER_FIELDS}
        member_view["manual_source"] = manual_source[0] if manual_source else ""
        member_view["review_capability"] = review_capability(connection, room_id, row["id"], token)
        member_view["held_until"] = held_until(connection, row["id"])
        # The runner compares this with its adapter's effect and reports a change.
        reported = connection.execute("SELECT rewind FROM member_capabilities WHERE member_id=?", (row["id"],)).fetchone()
        member_view["rewind"] = reported[0] if reported else ""
        pending = [{**request, **review_request_context(connection, request)} for request in pending]
        (members if row["access"] == "runner" else observers).append({**member_view, "pending": pending})
    executions = [{**public_execution(row), "member": row["name"], "retry": execution_retry(connection, row["id"])} for row in connection.execute(
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
    requests = [{**request, **review_request_context(connection, request)} for request in requests]
    return {**public_execution(row), "member": member["name"], "read_until": member["read_until"], "requests": requests,
            "rewound_executions": member_rewinds(connection, member["id"]), "retry": execution_retry(connection, row["id"])}


def view_execution(connection, room_id, execution_id, token):
    """Let the owner or the executing member read one execution."""
    row = connection.execute("SELECT * FROM member_executions WHERE room_id=? AND id=?", (room_id, execution_id)).fetchone()
    if not row:
        raise LookupError("执行不存在")
    try:
        require_owner(connection, room_id, token)
    except PermissionError:
        member = require_member(connection, room_id, token)
        if member["id"] != row["member_id"]:
            raise
    return execution_detail(connection, row)


def changed_files(payload):
    """Validate the runner's observed file list; paths are relative to the execution's cwd."""
    files = payload.get("changes")
    if (not isinstance(files, list) or len(files) > MAX_CHANGED_FILES
            or any(not isinstance(item, str) or not item or len(item) > MAX_PATH_LENGTH for item in files)):
        raise ValueError(f"changes 须为最多 {MAX_CHANGED_FILES} 个相对路径")
    return sorted(set(files))


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
        connection.execute("UPDATE member_executions SET changes=? WHERE id=?", (json.dumps(changed_files(payload), ensure_ascii=False), execution_id))
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
        connection.execute("""INSERT INTO execution_capabilities (execution_id,room_id,stoppable,progress) VALUES (?,?,?,?)
            ON CONFLICT(execution_id) DO UPDATE SET stoppable=excluded.stoppable,progress=excluded.progress""",
                           (execution_id, room_id, int(payload["stoppable"]), int(payload["progress"])))
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
        raise ValueError("action 须为 renew、fail、release、report、segments、retry_wait、retry_start、retry_now 或 retry_stop")
    detail = execution_detail(connection, connection.execute("SELECT * FROM member_executions WHERE id=?", (execution_id,)).fetchone())
    return {**detail, "duplicate": duplicate} if action == "stopped" else detail


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
    stop_member_work(connection, member_id, "用户打断", "user_stop", keep_pending=True)
    settle_batches(connection, room_id)
    return free_view(connection, room_id)


def withdrawals(connection, room_id):
    """The room's taken-back messages by id, so the page keeps them in place while AI readers skip them."""
    return [dict(row) for row in connection.execute("""SELECT w.message_id,w.kind FROM message_withdrawals w
        JOIN messages m ON m.id=w.message_id WHERE m.room_id=? ORDER BY w.message_id""", (room_id,))]


def owner_message(connection, room_id, message_id):
    """One visible message of the user in a free room without an open discussion, which a retract or rewind may take back."""
    row = connection.execute("SELECT * FROM messages WHERE room_id=? AND id=?", (room_id, message_id)).fetchone()
    if not row:
        raise LookupError("消息不存在")
    if row["author"] != "用户":
        raise ValueError("只能撤回或编辑用户自己的消息")
    if room_mode(connection, room_id) != "free":
        raise ValueError("只有协作房间的消息可以撤回或编辑")
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
    `fresh` (its context is rebuilt each time), `unchanged` (no taken-back execution) or `kept` (manual and online members,
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
    connection.execute("UPDATE free_chain_holds SET message_id=0,host_id=0,names='[]',handoff=0 WHERE room_id=? AND message_id>=?", (room_id, message_id))
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


def discussion_roster(connection, room_id):
    """Return a discussion's host, active experts and phase; away experts keep only their member row."""
    row = connection.execute("SELECT host,experts,phase FROM topic_settings WHERE room_id=?", (room_id,)).fetchone()
    return row["host"], json.loads(row["experts"]), row["phase"]


def save_discussion_experts(connection, room_id, experts):
    """Write the active roster; additions preserve its plan, other changes ask the host to re-plan."""
    connection.execute("UPDATE topic_settings SET experts=? WHERE room_id=?", (json.dumps(experts, ensure_ascii=False), room_id))


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
        return
    connection.execute("""INSERT OR IGNORE INTO discussion_turns (room_id,expert,question,status,submission_id,created_at)
        SELECT settings.room_id,member.name,
            CASE WHEN settings.phase='initial' THEN '欢迎加入：请先读取议题，独立给出你的开场观点。'
                 ELSE '欢迎加入：请先读取议题和已有回答，给出你的观点。' END,
            'queued','invite:'||member.id,?
        FROM topic_settings AS settings JOIN room_members AS member ON member.room_id=settings.room_id
        WHERE settings.room_id=? AND member.name=? AND member.status='active'
        AND settings.phase NOT IN ('paused','concluded')
        AND EXISTS (SELECT 1 FROM discussion_turns WHERE room_id=settings.room_id AND status IN ('pending','notified','queued'))""",
        (now, room_id, name))


def add_discussion_member(connection, room_id, token, payload, now):
    """Owner invites one expert into a discussion using the room's delivery method."""
    require_owner(connection, room_id, token)
    begin_write(connection)
    member = member_value(payload)
    _, experts, phase = discussion_roster(connection, room_id)
    run = connection.execute("SELECT mode FROM discussion_runtime WHERE room_id=?", (room_id,)).fetchone()
    if not discussion_access_ok(member["access"], "cli", bool(run and run["mode"] == "automatic"), False):
        raise ValueError("新专家的接入方式须与讨论的推进方式一致")
    existing = connection.execute("SELECT * FROM room_members WHERE room_id=? AND name=? AND status<>'removed'", (room_id, member["name"])).fetchone()
    if existing and existing["status"] == "active" and existing["token_hash"] == token_hash(member["token"]):
        return
    if existing:
        raise FileExistsError(f"{member['name']} 已是本房间成员；离开的成员请用请回")
    if phase == "concluded":
        raise ValueError("讨论已收束，不能再邀请专家")
    if len(experts) >= MAX_ROOM_AGENTS:
        raise ValueError("房间成员已达上限")
    require_fresh_member_token(connection, room_id, member["token"])
    insert_member(connection, room_id, mark_manual(member, bool(run and run["mode"] == "automatic")), now)
    save_discussion_experts(connection, room_id, {**experts, member["name"]: "cli"})
    queue_invited_expert(connection, room_id, member["name"], now)


def discussion_member_action(connection, room_id, member_id, token, payload):
    """Owner sends an expert away (keeping its seat), brings it back with a new credential, or removes it.

    Leaving cancels the expert's open assignments; the host keeps its role and cannot leave, and an
    leaving cancels its active plan and asks the host to re-plan without pausing the discussion.
    """
    member = owned_member(connection, room_id, member_id, token)
    host, experts, phase = discussion_roster(connection, room_id)
    action = payload.get("action")
    if action in ("away", "remove"):
        if member["name"] == host:
            raise ValueError("主持人不能离开或移除；请先更换主持人")
        discussion.session_member_change(connection, room_id, member, action)
        connection.execute("UPDATE discussion_turns SET status='cancelled' WHERE room_id=? AND expert=? AND status IN ('pending','notified')",
                           (room_id, member["name"]))
        connection.execute("UPDATE discussion_turns SET status='skipped' WHERE room_id=? AND expert=? AND status='queued'", (room_id, member["name"]))
        connection.execute("UPDATE room_members SET status=? WHERE id=?", ("away" if action == "away" else "removed", member_id))
        experts.pop(member["name"], None)
    elif action == "active":
        hashed = token_hash(payload.get("token"))
        if member["status"] == "active" and hashed and hmac.compare_digest(hashed, member["token_hash"]):
            return
        if member["status"] != "away" or not hashed or hmac.compare_digest(hashed, member["token_hash"]):
            raise ValueError("只有离开的成员可以请回，且须提供新的成员凭证")
        require_fresh_member_token(connection, room_id, payload.get("token"))
        connection.execute("UPDATE room_members SET status='active',token_hash=? WHERE id=?", (hashed, member_id))
        experts[member["name"]] = "online" if member["access"] == "online" else "cli"
        if discussion.current_session(connection, room_id, active_only=True):
            discussion.session_member_change(connection, room_id, member, action)
        else:
            queue_invited_expert(connection, room_id, member["name"], int(time.time()))
    elif action == "adopt":
        adopt_manual_member(connection, room_id, member, payload)
        return
    else:
        raise ValueError("action 须为 away、active、remove 或 adopt")
    save_discussion_experts(connection, room_id, experts)


def adopt_manual_member(connection, room_id, member, payload):
    """Hand a manual expert to the local service once its CLI reported the session it runs in; the owner's service resumes that session."""
    reported = connection.execute("SELECT session_id FROM member_sessions WHERE member_id=?", (member["id"],)).fetchone()
    run = connection.execute("SELECT mode FROM discussion_runtime WHERE room_id=?", (room_id,)).fetchone()
    if not registered_at(connection, member):
        raise ValueError("成员尚未注册，不能转为托管")
    adapter = payload.get("adapter")
    if (not reported or reported["session_id"] != payload.get("session_id") or not isinstance(adapter, str)
            or not ADAPTER_VALUE.fullmatch(adapter) or adapter == "manual"):
        raise ValueError("成员尚未上报与之相符的会话，不能转为托管")
    if member["access"] != "manual" or member["status"] != "active" or not (room_mode(connection, room_id) == "free" or (run and run["mode"] == "automatic")):
        raise ValueError("只有自由协作或全自动讨论中在场的手动专家可以转为托管")
    connection.execute("UPDATE room_members SET access='runner',adapter=?,session_mode='borrowed' WHERE id=?", (payload["adapter"], member["id"]))
    connection.execute("DELETE FROM member_sessions WHERE member_id=?", (member["id"],))
    # A free room's service answers as the member, so it takes over with a credential the owner's side generated.
    if payload.get("token") is not None:
        require_fresh_member_token(connection, room_id, payload["token"])
        connection.execute("UPDATE room_members SET token_hash=? WHERE id=?", (token_hash(payload["token"]), member["id"]))


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
    manual_source = connection.execute("SELECT source FROM member_manual_sources WHERE member_id=?", (member_id,)).fetchone()
    is_web_member = bool(manual_source and manual_source["source"] == "web")
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
    elif action == "role":
        role = payload.get("role")
        if role not in ("host", "member") or (role == "host" and (member["access"] == "online" or is_web_member)):
            raise ValueError("role 须为 host 或 member；在线成员不能担任主持人")
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
    else:
        raise ValueError("action 须为 away、active、remove、role 或 adopt")
    settle_batches(connection, room_id)
    sync_participants(connection, room_id)
    hand_over_routes(connection, room_id, routed, member_id if action in ("away", "remove") else None)
    return free_view(connection, room_id)


# Imported last: session_room imports helpers from this module, so both load in either order.
from . import session_room as discussion  # noqa: E402

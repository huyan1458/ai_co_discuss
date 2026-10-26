"""Room launches relayed through the website to a paired computer running the local service.

A device without the local service (a phone, a tablet) submits the same launch request the
connected browser would send to the local bridge; the paired computer claims it on its next
sync, resolves the chosen project to its own directory and runs it. The Worker backend
implements the same contract in ``worker.mjs``; both operate on ``local_machines`` and
``remote_launches``.
"""

import hashlib
import hmac
import json
import re

from .admin import AdminError
from .runtime import begin_write

MACHINE_ONLINE_SECONDS = 30
MACHINE_NAME_MAX = 60
PROJECT_NAME_MAX = 80
PROJECTS_MAX = 100
CLIENTS_MAX = 40
CLIENT_FIELD_MAX = 40
ERROR_MAX = 2000
MACHINE_ID = re.compile(r"[0-9a-f]{32}")
MACHINE_TOKEN = re.compile(r"[0-9a-f]{64}")
LAUNCH_ID = re.compile(r"[A-Za-z0-9_-]{1,80}")
PROJECT_ID = re.compile(r"[0-9a-f]{8,32}")
LAUNCH_STAGES = ("not_started", "unconfirmed", "created", "started")


def token_digest(token):
    """Hash a machine token; malformed values hash to an empty string and never match."""
    return hashlib.sha256(token.encode()).hexdigest() if isinstance(token, str) and MACHINE_TOKEN.fullmatch(token) else ""


def machine_view(row, now):
    """Public machine fields: projects by name and id, and which platforms it can wake."""
    return {"id": row["id"], "name": row["name"], "projects": json.loads(row["projects"]), "clients": json.loads(row["clients"]),
            "seen_at": row["seen_at"], "online": now - row["seen_at"] <= MACHINE_ONLINE_SECONDS}


def launch_view(row):
    """Report a relayed launch without its request, which carries the room's credentials."""
    return {"id": row["id"], "machine_id": row["machine_id"], "status": row["status"],
            "result": json.loads(row["result"]), "error": row["error"]}


def list_machines(connection, now):
    """Paired computers, most recently seen first."""
    rows = connection.execute("SELECT * FROM local_machines ORDER BY seen_at DESC, created_at DESC").fetchall()
    return {"machines": [machine_view(row, now) for row in rows]}


def pair_machine(connection, payload, now):
    """Pair a computer or replace its token; called by the administrator's browser connected to that computer."""
    machine_id, token = payload.get("id"), payload.get("token")
    name = payload.get("name").strip() if isinstance(payload.get("name"), str) else ""
    if not isinstance(machine_id, str) or not MACHINE_ID.fullmatch(machine_id) or not token_digest(token):
        raise ValueError("电脑编号或凭据无效")
    if not 1 <= len(name) <= MACHINE_NAME_MAX:
        raise ValueError(f"电脑名称需为 1–{MACHINE_NAME_MAX} 个字符")
    begin_write(connection)
    connection.execute("INSERT INTO local_machines (id,name,token_hash,created_at) VALUES (?,?,?,?) "
                       "ON CONFLICT(id) DO UPDATE SET name=excluded.name, token_hash=excluded.token_hash",
                       (machine_id, name, token_digest(token), now))
    return machine_view(connection.execute("SELECT * FROM local_machines WHERE id=?", (machine_id,)).fetchone(), now)


def require_machine(connection, machine_id, token):
    """Authenticate the computer itself by its own token."""
    row = connection.execute("SELECT * FROM local_machines WHERE id=?", (machine_id,)).fetchone()
    hashed = token_digest(token)
    if not row or not hashed or not hmac.compare_digest(row["token_hash"], hashed):
        raise AdminError("电脑凭据无效，请在这台电脑上重新连接网站", 401)
    return row


def valid_projects(value):
    """Project names and ids only; directories never leave the computer."""
    if not isinstance(value, list) or len(value) > PROJECTS_MAX:
        raise ValueError(f"项目列表须为不超过 {PROJECTS_MAX} 项的列表")
    projects = []
    for item in value:
        project_id, name = (item.get("id"), item.get("name")) if isinstance(item, dict) else (None, None)
        if not isinstance(project_id, str) or not PROJECT_ID.fullmatch(project_id) or not isinstance(name, str) or not 1 <= len(name) <= PROJECT_NAME_MAX:
            raise ValueError("项目须包含有效编号与名称")
        projects.append({"id": project_id, "name": name})
    return projects


def valid_clients(value):
    """Map each platform the computer can wake to its configured client type."""
    if not isinstance(value, dict) or len(value) > CLIENTS_MAX or any(
            not isinstance(key, str) or not isinstance(item, str) or not 0 < len(key) <= CLIENT_FIELD_MAX or not 0 < len(item) <= CLIENT_FIELD_MAX
            for key, item in value.items()):
        raise ValueError("软件配置须为平台到客户端类型的对象")
    return value


def machine_sync(connection, machine_id, token, payload, now):
    """Record the computer's projects and clients, and hand it every launch it has not finished."""
    require_machine(connection, machine_id, token)
    projects, clients = valid_projects(payload.get("projects")), valid_clients(payload.get("clients"))
    begin_write(connection)
    connection.execute("UPDATE local_machines SET projects=?, clients=?, seen_at=? WHERE id=?",
                       (json.dumps(projects, ensure_ascii=False), json.dumps(clients, ensure_ascii=False), now, machine_id))
    rows = connection.execute("SELECT id,request FROM remote_launches WHERE machine_id=? AND status IN ('pending','claimed') ORDER BY created_at",
                              (machine_id,)).fetchall()
    return {"launches": [{"id": row["id"], "request": json.loads(row["request"])} for row in rows]}


def machine_launch_action(connection, machine_id, launch_id, token, payload, now):
    """Claim, finish or fail one launch; a finished or failed launch drops its request."""
    require_machine(connection, machine_id, token)
    begin_write(connection)
    row = connection.execute("SELECT * FROM remote_launches WHERE id=? AND machine_id=?", (launch_id, machine_id)).fetchone()
    if not row:
        raise LookupError("启动请求不存在")
    action = payload.get("action")
    if action not in ("claim", "finish", "fail"):
        raise ValueError("action 须为 claim、finish 或 fail")
    if row["status"] not in ("pending", "claimed"):
        raise FileExistsError("启动请求已结束")
    if action == "claim":
        connection.execute("UPDATE remote_launches SET status='claimed', updated_at=? WHERE id=?", (now, launch_id))
    elif action == "finish":
        room_id = payload.get("room_id")
        if not isinstance(room_id, str) or not room_id:
            raise ValueError("完成启动须提供 room_id")
        result = {"room_id": room_id, "status": str(payload.get("status") or "")}
        connection.execute("UPDATE remote_launches SET status='done', request='{}', result=?, error='', updated_at=? WHERE id=?",
                           (json.dumps(result), now, launch_id))
    else:
        stage = payload.get("stage") if payload.get("stage") in LAUNCH_STAGES else "unconfirmed"
        result = {"stage": stage, **({"room_id": payload["room_id"]} if isinstance(payload.get("room_id"), str) else {})}
        connection.execute("UPDATE remote_launches SET status='failed', request='{}', result=?, error=?, updated_at=? WHERE id=?",
                           (json.dumps(result), str(payload.get("error") or "启动失败")[:ERROR_MAX], now, launch_id))
    return launch_view(connection.execute("SELECT * FROM remote_launches WHERE id=?", (launch_id,)).fetchone())


def submit_remote_launch(connection, payload, now):
    """Queue a room creation for the paired computer; resubmitting the same id replays only a failed launch."""
    launch_id, machine_id, request = payload.get("id"), payload.get("machine_id"), payload.get("request")
    if not isinstance(launch_id, str) or not LAUNCH_ID.fullmatch(launch_id):
        raise ValueError("启动编号无效")
    if not isinstance(request, dict) or not isinstance(request.get("room"), dict) or request["room"].get("submission_id") != launch_id:
        raise ValueError("远程启动只用于新建房间，room.submission_id 须与启动编号一致")
    if request.get("cwd") or request.get("access_file"):
        raise ValueError("远程启动只能选择电脑上已配置的项目，不能指定路径")
    begin_write(connection)
    machine = connection.execute("SELECT * FROM local_machines WHERE id=?", (machine_id,)).fetchone()
    if not machine:
        raise LookupError("这台电脑尚未连接网站")
    project_id = request.get("local_project")
    if project_id and project_id not in {project["id"] for project in json.loads(machine["projects"])}:
        raise FileExistsError("所选项目已在电脑上移除或更改，请重新选择")
    row = connection.execute("SELECT * FROM remote_launches WHERE id=?", (launch_id,)).fetchone()
    if row and row["machine_id"] != machine_id:
        raise FileExistsError("启动编号已用于另一台电脑")
    if not row:
        connection.execute("INSERT INTO remote_launches (id,machine_id,request,created_at,updated_at) VALUES (?,?,?,?,?)",
                           (launch_id, machine_id, json.dumps(request, ensure_ascii=False), now, now))
    elif row["status"] == "failed":
        connection.execute("UPDATE remote_launches SET status='pending', request=?, result='{}', error='', updated_at=? WHERE id=?",
                           (json.dumps(request, ensure_ascii=False), now, launch_id))
    return launch_view(connection.execute("SELECT * FROM remote_launches WHERE id=?", (launch_id,)).fetchone())


def remote_launch_status(connection, launch_id):
    """Read a relayed launch's progress."""
    row = connection.execute("SELECT * FROM remote_launches WHERE id=?", (launch_id,)).fetchone()
    if not row:
        raise LookupError("启动请求不存在")
    return launch_view(row)

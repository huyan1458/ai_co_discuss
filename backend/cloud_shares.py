"""Revocable links to one stored object, with tokens and redirects handled on the computer."""

import hashlib
import json
import re
import secrets
import time
from contextlib import closing
from datetime import datetime, timezone
from urllib.parse import urlsplit

from .admin import AdminError, hash_password, verify_password
from .runtime import begin_write
from .texts import Text

PUBLIC_PREFIX = "/_cloud-share/"
PUBLIC_PATH = re.compile(PUBLIC_PREFIX + r"([0-9a-f]{64})(?:/([0-9A-Za-z]{4}))?")
ID_PATTERN = re.compile(r"[0-9a-f]{32}")
HOSTED_PATH = re.compile(r"/cloud-share/(?:[0-9a-f]{32}/)?[a-z0-9][a-z0-9_-]{1,31}")
DAY_SECONDS = 86400
DEFAULT_DAYS = 7
MAX_DAYS = 30
CODE_LENGTH = 4
CODE_CHARACTERS = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
CODE_MAX_FAILURES = 5
CODE_LOCK_SECONDS = 10 * 60
CODE_COLUMNS = {"code_hash": "TEXT", "failed_attempts": "INTEGER NOT NULL DEFAULT 0", "locked_until": "INTEGER"}
CODE_PAGE_STATUSES = (200, 403, 429)
CODE_SCRIPT = r"""
document.querySelector("form").addEventListener("submit", event => {
  event.preventDefault();
  const code = document.querySelector("input").value.trim().toUpperCase();
  if (/^[0-9A-Z]{4}$/.test(code)) location.replace(location.pathname.replace(/\/[0-9A-Za-z]{4}$/, "") + "/" + code);
});
"""

SCHEMA = """
CREATE TABLE IF NOT EXISTS cloud_shares (
    id TEXT PRIMARY KEY,
    file_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER,
    code_hash TEXT,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER
);
CREATE INDEX IF NOT EXISTS cloud_shares_file ON cloud_shares(file_id, created_at);
CREATE TABLE IF NOT EXISTS cloud_share_events (
    id INTEGER PRIMARY KEY,
    share_id TEXT,
    at INTEGER NOT NULL,
    status INTEGER NOT NULL
);
"""


def audit_path(path):
    """Leave public share tokens out of the HTTP access log."""
    return PUBLIC_PREFIX if path.startswith(PUBLIC_PREFIX) else path


def _iso(seconds):
    return datetime.fromtimestamp(seconds, timezone.utc).isoformat() if seconds is not None else None


def _object(connection, identifier, kind=None):
    if kind != "cloud_file":
        row = connection.execute(
            "SELECT * FROM attachments WHERE id=? AND storage='object'", (identifier,)
        ).fetchone()
        if row is not None or kind == "attachment":
            return row, "attachment"
    return connection.execute("SELECT * FROM cloud_files WHERE id=?", (identifier,)).fetchone(), "cloud_file"


def _available(row):
    return (row is not None and row["object_name"] and row["stored_at"] and row["cleared_at"] is None
            and ("purpose" not in row.keys() or row["purpose"] == "keep")
            and ("trashed_at" not in row.keys() or row["trashed_at"] is None))


def _view(share, row, now):
    status = ("revoked" if share["revoked_at"] is not None else "expired" if share["expires_at"] <= now
              else "active" if _available(row) else "unavailable")
    return {"id": share["id"], "created_at": _iso(share["created_at"]), "expires_at": _iso(share["expires_at"]),
            "revoked_at": _iso(share["revoked_at"]), "status": status}


def _https(value):
    if not isinstance(value, str):
        return None
    try:
        parsed = urlsplit(value)
        if (value.isascii() and not re.search(r"[\x00-\x20\x7f\\]", value) and parsed.scheme == "https"
                and parsed.hostname and parsed.username is None and not parsed.query and not parsed.fragment):
            return parsed
    except ValueError:
        pass
    return None


def _public_base(handler):
    hosted = handler.headers.get("X-CoDiscuss-Cloud-Base", "")
    target = _https(hosted)
    if handler.client_address[0] == "127.0.0.1" and target and HOSTED_PATH.fullmatch(target.path):
        return hosted
    path = handler.server.connections_file
    if path:
        try:
            sites = json.loads(path.read_text(encoding="utf-8")).get("sites", {})
        except (OSError, ValueError, AttributeError):
            sites = {}
        preferred = handler.headers.get("X-CoDiscuss-Bridge-Site", "")
        sites = sites if isinstance(sites, dict) else {}
        for site in dict.fromkeys([preferred, *sites]):
            parsed = _https(site)
            entry = sites.get(site)
            machine = entry.get("machine_id") if isinstance(entry, dict) else None
            if parsed and not parsed.path and isinstance(machine, str) and ID_PATTERN.fullmatch(machine):
                return f"{site}/api/cloud-share/{machine}"
    raise FileExistsError(Text("请先配置可公开访问的共议入口"))


def manage(handler, connection, route, method, require_owner):
    """Manage links using the existing account admin or the exact source room's owner credential."""
    identifier = route[0]
    if not ID_PATTERN.fullmatch(identifier):
        raise ValueError(Text("附件编号无效"))
    row, kind = _object(connection, identifier)
    if handler.read_only_request() or handler.bridge_origin or handler.headers.get("X-Acting-Member-Token"):
        raise PermissionError(Text("需要管理员登录"))
    if handler.has_explicit_room_token:
        room = handler.request_params.get("room", "")
        require_owner(connection, room, handler.headers.get("X-Discussion-Token", ""))
        if row is None or row["room_id"] != room:
            raise LookupError(Text("附件不存在"))
    elif not (handler.bridged or handler.admin_session(connection)):
        raise PermissionError(Text("需要管理员登录"))
    now = int(time.time())
    if route[1:] == ["shares"] and method == "GET":
        shares = connection.execute("SELECT * FROM cloud_shares WHERE file_id=? ORDER BY created_at DESC, id", (identifier,))
        return handler.respond({"shares": [_view(share, row, now) for share in shares]})
    if route[1:] == ["shares"] and method == "POST":
        payload = handler.read_payload()
        days, protected = payload.get("days", DEFAULT_DAYS), payload.get("code", False)
        if type(days) is not int or not 1 <= days <= MAX_DAYS:
            raise ValueError(Text("分享有效期须为 1 到 30 天"))
        if type(protected) is not bool:
            raise ValueError(Text("是否需要提取码须为布尔值"))
        return _create(handler, connection, identifier, kind, (now, days, protected))
    if method == "POST" and len(route) == 4 and route[-1] == "revoke" and ID_PATTERN.fullmatch(route[2]):
        return _revoke(handler, connection, identifier, route[2], now)
    raise LookupError(Text("地址不存在"))


def _create(handler, connection, identifier, kind, lifetime):
    now, days, protected = lifetime
    base = _public_base(handler)
    code = "".join(secrets.choice(CODE_CHARACTERS) for _ in range(CODE_LENGTH)) if protected else None
    code_hash = hash_password(code) if code else None
    begin_write(connection)
    row, _ = _object(connection, identifier, kind)
    if not _available(row):
        raise FileExistsError(Text("只有已上传且长期保留的云空间文件可以分享"))
    token, share_id = secrets.token_hex(32), secrets.token_hex(16)
    # An earlier development build may already have created shares without these fields.
    columns = {column[1] for column in connection.execute("PRAGMA table_info(cloud_shares)")}
    for name, definition in CODE_COLUMNS.items():
        if name not in columns:
            connection.execute(f"ALTER TABLE cloud_shares ADD COLUMN {name} {definition}")
    connection.execute("""INSERT INTO cloud_shares (id,file_id,kind,token_hash,created_at,expires_at,code_hash)
                       VALUES (?,?,?,?,?,?,?)""",
                       (share_id, identifier, kind, hashlib.sha256(token.encode()).hexdigest(),
                        now, now + days * DAY_SECONDS, code_hash))
    share = connection.execute("SELECT * FROM cloud_shares WHERE id=?", (share_id,)).fetchone()
    connection.commit()
    result = {**_view(share, row, now), "url": f"{base}/{token}"}
    if code:
        result["code"] = code
    return handler.respond({"share": result}, 201)


def _revoke(handler, connection, identifier, share_id, now):
    begin_write(connection)
    connection.execute("UPDATE cloud_shares SET revoked_at=COALESCE(revoked_at, ?) WHERE id=? AND file_id=?",
                       (now, share_id, identifier))
    share = connection.execute("SELECT * FROM cloud_shares WHERE id=? AND file_id=?", (share_id, identifier)).fetchone()
    if share is None:
        raise LookupError(Text("分享链接不存在或已失效"))
    row, _ = _object(connection, identifier, share["kind"])
    connection.commit()
    return handler.respond({"share": _view(share, row, now)})


def _active_object(connection, share):
    if share is None or share["revoked_at"] is not None or share["expires_at"] <= time.time():
        return None
    row, _ = _object(connection, share["file_id"], share["kind"])
    return row if _available(row) else None


def _locked(share, now):
    return ("locked_until" in share.keys() and share["locked_until"] is not None and share["locked_until"] > now)


def _check_code(connection, share, code):
    if _locked(share, time.time()):
        return 429
    if code is None:
        return 200
    correct = verify_password(code.upper(), share["code_hash"])
    begin_write(connection)
    share = connection.execute("SELECT * FROM cloud_shares WHERE id=?", (share["id"],)).fetchone()
    if _active_object(connection, share) is None:
        return 404
    now = int(time.time())
    if _locked(share, now):
        return 429
    attempts, locked_until = 0, None
    if not correct:
        attempts = 1 if share["locked_until"] is not None else share["failed_attempts"] + 1
        if attempts >= CODE_MAX_FAILURES:
            locked_until = now + CODE_LOCK_SECONDS
    connection.execute("UPDATE cloud_shares SET failed_attempts=?, locked_until=? WHERE id=?",
                       (attempts, locked_until, share["id"]))
    return 302 if correct else 429 if locked_until else 403


def _code_page(handler, status):
    chinese = bool(re.match(r"^zh\b", handler.headers.get("Accept-Language", "zh"), re.IGNORECASE))
    title = "输入提取码" if chinese else "Enter the access code"
    button = "下载" if chinese else "Download"
    messages = {
        403: ("提取码错误，请重试。", "Incorrect access code. Try again."),
        429: ("输错次数过多，分享已暂时锁定，请稍后再试。", "Too many incorrect attempts. Try again later."),
    }
    notice = f'<p role="alert">{messages[status][not chinese]}</p>' if status in messages else ""
    nonce = secrets.token_urlsafe(16)
    form = "" if status == 429 else (
        f'<form><label for="code">{title}</label> <input id="code" required minlength="4" maxlength="4" '
        'pattern="[0-9A-Za-z]{4}" autocomplete="off" autocapitalize="characters" spellcheck="false" autofocus> '
        f'<button type="submit">{button}</button></form><script nonce="{nonce}">{CODE_SCRIPT}</script>')
    language = "zh-CN" if chinese else "en"
    body = (f'<!doctype html><html lang="{language}"><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width,initial-scale=1">'
            f'<title>{title}</title><main><h1>{title}</h1>{notice}{form}</main></html>').encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "text/html; charset=utf-8")
    handler.send_header("Content-Security-Policy", f"default-src 'none'; script-src 'nonce-{nonce}'; "
                        "form-action 'none'; base-uri 'none'; frame-ancestors 'none'")
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("Referrer-Policy", "no-referrer")
    handler.send_header("X-Robots-Tag", "noindex, nofollow")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def redeem(handler, match, connect_db, sign_download):
    """Audit recognized shares and recheck the share after signing before disclosing the redirect."""
    database = handler.server.database
    digest = hashlib.sha256(match[1].encode()).hexdigest()
    query = "SELECT * FROM cloud_shares WHERE token_hash=?"
    missing = Text("分享链接不存在或已失效")
    if handler.headers.get("Content-Length", "0") != "0" or handler.headers.get("Transfer-Encoding") is not None:
        handler.close_connection = True
        return handler.respond({"error": missing}, 404)
    with closing(connect_db(database)) as connection, connection:
        share = connection.execute(query, (digest,)).fetchone()
        if share is None:
            return handler.respond({"error": missing}, 404)
        row = _active_object(connection, share)
        code = match[2]
        protected = "code_hash" in share.keys() and share["code_hash"] is not None
        status, url = 404, None
        if row is not None:
            if protected:
                status = _check_code(connection, share, code)
            elif code is None:
                status = 302
        if status == 302:
            connection.commit()
            try:
                url = sign_download(database, row)["url"]
                status = 302
            except AdminError as error:
                status = 404 if error.status == 410 else 503
        begin_write(connection)
        if status == 302:
            current = connection.execute(query, (digest,)).fetchone()
            if _active_object(connection, current) is None:
                status = 404
            elif protected and _locked(current, time.time()):
                status = 429
        connection.execute("INSERT INTO cloud_share_events (share_id,at,status) VALUES (?,?,?)",
                           (share["id"], int(time.time()), status))
    if status in CODE_PAGE_STATUSES:
        return _code_page(handler, status)
    if status != 302:
        message = missing if status == 404 else Text("对象存储暂不可用")
        return handler.respond({"error": message}, status)
    return _download_redirect(handler, url)


def _download_redirect(handler, url):
    handler.send_response(302)
    handler.send_header("Location", url)
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("Referrer-Policy", "no-referrer")
    handler.send_header("X-Robots-Tag", "noindex, nofollow")
    handler.send_header("Content-Length", "0")
    handler.end_headers()

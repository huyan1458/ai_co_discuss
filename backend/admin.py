"""Single site administrator account: registration, login sessions and profile.

Passwords and session tokens are stored only as hashes. The Worker backend implements
the same contract in ``worker.mjs``; both operate on ``site_admin``, ``admin_logins`` and ``admin_attempts``.
"""

import hashlib
import hmac
import secrets
import time

from .runtime import begin_write

PBKDF2_ITERATIONS = 100000
# A login ends after a week unused or a month in all; same rules as worker.mjs.
SESSION_IDLE_SECONDS = 7 * 86400
SESSION_MAX_SECONDS = 30 * 86400
SESSION_SEEN_SECONDS = 3600
SESSION_LABEL_LIMIT = 160
# Each run of five wrong passwords from one address locks it, twice as long each time, up to a day; all addresses
# together are capped per hour.
FAILURES_PER_LOCK = 5
LOCK_SECONDS = 300
LOCK_MAX_SECONDS = 86400
GLOBAL_FAILURES = 500
GLOBAL_WINDOW = 3600
USERNAME_MAX = 30
PASSWORD_MIN = 8
PASSWORD_MAX = 128
AVATAR_MAX = 60000


class AdminError(Exception):
    """A request failure that needs a specific HTTP status."""

    def __init__(self, message, status):
        super().__init__(message)
        self.status = status


def hash_password(password):
    """Return a salted PBKDF2 hash in the portable ``pbkdf2_sha256$n$salt$hash`` format."""
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, PBKDF2_ITERATIONS)
    return f"pbkdf2_sha256${PBKDF2_ITERATIONS}${salt.hex()}${digest.hex()}"


def verify_password(password, stored):
    """Compare a password with a stored hash in constant time."""
    try:
        _, iterations, salt, expected = stored.split("$")
        digest = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), int(iterations))
    except ValueError:
        return False
    return hmac.compare_digest(digest.hex(), expected)


def session_hash(token):
    """Hash a session token; malformed values hash to an empty string and never match."""
    return hashlib.sha256(token.encode()).hexdigest() if isinstance(token, str) and len(token) == 64 else ""


def same_secret(supplied, expected):
    """Compare two secrets through equal-length digests."""
    return hmac.compare_digest(hashlib.sha256(supplied.encode()).digest(), hashlib.sha256(expected.encode()).digest())


def valid_username(value):
    """Return a trimmed username, or raise when it is empty or too long."""
    name = value.strip() if isinstance(value, str) else ""
    if not 1 <= len(name) <= USERNAME_MAX:
        raise ValueError(f"用户名需为 1–{USERNAME_MAX} 个字符")
    return name


def valid_password(value):
    """Return a password within the accepted length."""
    if not isinstance(value, str) or not PASSWORD_MIN <= len(value) <= PASSWORD_MAX:
        raise ValueError(f"密码需为 {PASSWORD_MIN}–{PASSWORD_MAX} 个字符")
    return value


def valid_avatar(value):
    """Accept an empty default or a bounded image data URL."""
    if not isinstance(value, str) or len(value) > AVATAR_MAX or (value and not value.startswith("data:image/")):
        raise ValueError("头像需为不超过 60000 字符的图片数据")
    return value


def admin_row(connection):
    """Return the administrator row, or None before registration."""
    return connection.execute("SELECT * FROM site_admin WHERE id=1").fetchone()


def profile_of(row):
    """Public profile shown to every visitor."""
    return {"username": row["username"], "avatar": row["avatar"]} if row else None


def live_session(connection, token, now=None):
    """Return the login row for a token that is neither idle too long nor too old, or None."""
    hashed = session_hash(token)
    if not hashed:
        return None
    now = int(time.time()) if now is None else now
    return connection.execute("SELECT * FROM admin_logins WHERE token_hash=? AND last_seen>=? AND created_at>=?",
                              (hashed, now - SESSION_IDLE_SECONDS, now - SESSION_MAX_SECONDS)).fetchone()


def session_valid(connection, token):
    """Whether the token belongs to a live login; reading never writes, the status check marks last use."""
    return live_session(connection, token) is not None


def require_session(connection, token):
    """Require a valid administrator session."""
    if not session_valid(connection, token):
        raise AdminError("需要登录管理员账号", 401)


def admin_status(connection, token, setup_available, local=False):
    """Describe registration and login state; readable without logging in.

    A loopback-only local site has no account: the visitor is always the administrator.
    """
    row = admin_row(connection)
    if local:
        return {"local": True, "registered": True, "setup_available": False, "logged_in": True, "profile": profile_of(row)}
    now = int(time.time())
    session = live_session(connection, token, now) if row else None
    # Pages ask for this status when they open, which is when a login counts as used.
    if session and now - session["last_seen"] > SESSION_SEEN_SECONDS:
        connection.execute("UPDATE admin_logins SET last_seen=? WHERE token_hash=?", (now, session["token_hash"]))
    return {"registered": bool(row), "setup_available": bool(setup_available and not row),
            "logged_in": session is not None, "profile": profile_of(row)}


def open_session(connection, now, label=""):
    """Create a login labelled with the browser that asked for it and return its raw token, shown only once."""
    token = secrets.token_hex(32)
    connection.execute("DELETE FROM admin_logins WHERE last_seen<? OR created_at<?", (now - SESSION_IDLE_SECONDS, now - SESSION_MAX_SECONDS))
    connection.execute("INSERT INTO admin_logins (token_hash,label,created_at,last_seen) VALUES (?,?,?,?)",
                       (session_hash(token), str(label or "")[:SESSION_LABEL_LIMIT], now, now))
    return token


def register_admin(connection, payload, setup_key, now, label=""):
    """Create the administrator when the install token matches; only the first call succeeds."""
    begin_write(connection)
    if admin_row(connection):
        raise AdminError("管理员账号已存在", 409)
    username = valid_username(payload.get("username"))
    password = valid_password(payload.get("password"))
    supplied = payload.get("setup_key")
    setup = connection.execute("SELECT token_hash FROM admin_setup WHERE id=1").fetchone()
    # Either the install token or the one-time token written by `codiscuss token` registers.
    if not isinstance(supplied, str) or not (
            same_secret(supplied.strip(), setup_key)
            or setup and hmac.compare_digest(hashlib.sha256(supplied.strip().encode()).hexdigest(), setup["token_hash"])):
        raise AdminError("安装令牌不正确", 403)
    connection.execute("INSERT INTO site_admin (id,username,password_hash,created_at) VALUES (1,?,?,?)",
                       (username, hash_password(password), now))
    connection.execute("DELETE FROM admin_setup")
    return {"token": open_session(connection, now, label), "profile": {"username": username, "avatar": ""}}


def check_password(connection, row, password, source, now):
    """Verify a password with backoff per address and a cap across all addresses; failures are committed at once."""
    attempts = connection.execute("SELECT * FROM admin_attempts WHERE source=?", (source,)).fetchone()
    every = connection.execute("SELECT * FROM admin_attempts WHERE source='*'").fetchone()
    for limit in (attempts, every):
        if limit and limit["locked_until"] > now:
            raise AdminError(f"尝试次数过多，请 {limit['locked_until'] - now} 秒后再试", 429)
    if isinstance(password, str) and verify_password(password, row["password_hash"]):
        connection.execute("DELETE FROM admin_attempts WHERE source=?", (source,))
        return
    failed = (attempts["failed"] if attempts else 0) + 1
    lock = 0 if failed % FAILURES_PER_LOCK else min(LOCK_SECONDS * 2 ** (failed // FAILURES_PER_LOCK - 1), LOCK_MAX_SECONDS)
    total = every["failed"] + 1 if every and now - every["updated_at"] <= GLOBAL_WINDOW else 1
    connection.execute("INSERT OR REPLACE INTO admin_attempts (source,failed,locked_until,updated_at) VALUES (?,?,?,?)",
                       (source, failed, now + lock if lock else 0, now))
    connection.execute("INSERT OR REPLACE INTO admin_attempts (source,failed,locked_until,updated_at) VALUES ('*',?,?,?)",
                       (0 if total >= GLOBAL_FAILURES else total, now + GLOBAL_WINDOW if total >= GLOBAL_FAILURES else 0,
                        now if total == 1 else every["updated_at"]))
    connection.commit()
    raise AdminError("用户名或密码错误", 401)


def login_admin(connection, payload, now, source="unknown", label=""):
    """Verify the account and open a login; failures are generic and rate limited per address."""
    begin_write(connection)
    row = admin_row(connection)
    username, password = payload.get("username"), payload.get("password")
    if not row or not isinstance(username, str) or not isinstance(password, str):
        raise AdminError("用户名或密码错误", 401)
    # The username is checked after the lock so a wrong name and a wrong password are indistinguishable.
    check_password(connection, row, password if username.strip().lower() == row["username"].lower() else None, source, now)
    return {"token": open_session(connection, now, label), "profile": profile_of(row)}


def list_sessions(connection, token, now):
    """List live logins with their browser label; the id is a hash prefix, useless for signing in."""
    current = live_session(connection, token, now)
    if not current:
        raise AdminError("需要登录管理员账号", 401)
    rows = connection.execute("SELECT * FROM admin_logins WHERE last_seen>=? AND created_at>=? ORDER BY last_seen DESC",
                              (now - SESSION_IDLE_SECONDS, now - SESSION_MAX_SECONDS)).fetchall()
    return {"sessions": [{"id": row["token_hash"][:16], "label": row["label"], "created_at": row["created_at"], "last_seen": row["last_seen"],
                          "current": row["token_hash"] == current["token_hash"]} for row in rows]}


def revoke_sessions(connection, token, payload, now):
    """End one other login by id, or every login but this one."""
    current = live_session(connection, token, now)
    if not current:
        raise AdminError("需要登录管理员账号", 401)
    if payload.get("others") is True:
        connection.execute("DELETE FROM admin_logins WHERE token_hash<>?", (current["token_hash"],))
        return {"ok": True}
    target = payload.get("id")
    if not isinstance(target, str) or len(target) != 16 or any(char not in "0123456789abcdef" for char in target):
        raise ValueError("须提供要退出的登录 id，或 others: true")
    connection.execute("DELETE FROM admin_logins WHERE substr(token_hash,1,16)=? AND token_hash<>?", (target, current["token_hash"]))
    return {"ok": True}


def change_password(connection, token, payload, now, source="unknown"):
    """Change the password after proving the current one; every other login ends."""
    begin_write(connection)
    current = live_session(connection, token, now)
    if not current:
        raise AdminError("需要登录管理员账号", 401)
    password = valid_password(payload.get("password"))
    check_password(connection, admin_row(connection), payload.get("current_password"), source, now)
    connection.execute("UPDATE site_admin SET password_hash=? WHERE id=1", (hash_password(password),))
    connection.execute("DELETE FROM admin_logins WHERE token_hash<>?", (current["token_hash"],))
    return {"ok": True}


def logout_admin(connection, token):
    """Remove the current login; succeeds even without one."""
    connection.execute("DELETE FROM admin_logins WHERE token_hash=?", (session_hash(token),))
    return {"ok": True}


def update_profile(connection, token, payload, local=False):
    """Update the display name and avatar shown to all visitors.

    A local site stores the profile without a usable password, so no one can log in to it.
    """
    begin_write(connection)
    if not local:
        require_session(connection, token)
    elif not admin_row(connection):
        connection.execute("INSERT INTO site_admin (id,username,password_hash,created_at) VALUES (1,'User','!',?)", (int(time.time()),))
    if "username" in payload:
        connection.execute("UPDATE site_admin SET username=? WHERE id=1", (valid_username(payload["username"]),))
    if "avatar" in payload:
        connection.execute("UPDATE site_admin SET avatar=? WHERE id=1", (valid_avatar(payload["avatar"]),))
    return {"profile": profile_of(admin_row(connection))}

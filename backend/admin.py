"""Single site administrator account: registration, login sessions and profile.

Passwords and session tokens are stored only as hashes. The Worker backend implements
the same contract in ``worker.mjs``; both operate on ``site_admin`` and ``admin_sessions``.
"""

import hashlib
import hmac
import secrets
import time

from .runtime import begin_write

PBKDF2_ITERATIONS = 100000
LOCK_AFTER_FAILURES = 5
LOCK_SECONDS = 300
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


def session_valid(connection, token):
    """Whether the token belongs to a stored session; sessions last until logout."""
    hashed = session_hash(token)
    return bool(hashed and connection.execute("SELECT 1 FROM admin_sessions WHERE token_hash=?", (hashed,)).fetchone())


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
    return {"registered": bool(row), "setup_available": bool(setup_available and not row),
            "logged_in": session_valid(connection, token) if row else False, "profile": profile_of(row)}


def open_session(connection, now):
    """Create a session and return its raw token, which is shown only once."""
    token = secrets.token_hex(32)
    connection.execute("INSERT INTO admin_sessions (token_hash,created_at) VALUES (?,?)", (session_hash(token), now))
    return token


def register_admin(connection, payload, setup_key, now):
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
    return {"token": open_session(connection, now), "profile": {"username": username, "avatar": ""}}


def record_failure(connection, row):
    """Count a failed attempt durably; the fifth in a row locks login for a fixed time."""
    failures = row["failed_attempts"] + 1
    locked = failures >= LOCK_AFTER_FAILURES
    connection.execute("UPDATE site_admin SET failed_attempts=?, locked_until=? WHERE id=1",
                       (0 if locked else failures, int(time.time()) + LOCK_SECONDS if locked else 0))
    connection.commit()


def check_not_locked(row, now):
    """Reject attempts while the account is locked, even with a correct password."""
    if row["locked_until"] > now:
        raise AdminError(f"尝试次数过多，请 {row['locked_until'] - now} 秒后再试", 429)


def login_admin(connection, payload, now):
    """Verify the account and open a session; failures are generic and rate limited."""
    begin_write(connection)
    row = admin_row(connection)
    username, password = payload.get("username"), payload.get("password")
    if not row or not isinstance(username, str) or not isinstance(password, str):
        raise AdminError("用户名或密码错误", 401)
    check_not_locked(row, now)
    if username.strip().lower() != row["username"].lower() or not verify_password(password, row["password_hash"]):
        record_failure(connection, row)
        raise AdminError("用户名或密码错误", 401)
    connection.execute("UPDATE site_admin SET failed_attempts=0, locked_until=0 WHERE id=1")
    return {"token": open_session(connection, now), "profile": profile_of(row)}


def logout_admin(connection, token):
    """Remove the current session; succeeds even without one."""
    connection.execute("DELETE FROM admin_sessions WHERE token_hash=?", (session_hash(token),))
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

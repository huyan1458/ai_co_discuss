"""Entry protection for a hosted instance: only callers holding the instance's key reach it.

A hosted instance listens on loopback, where every account's processes can connect and any of them may take the port
of an instance that is down. So, when protection is on, nothing but public assets is served unless the caller proves
on the same connection that it holds the instance's key, and the caller only sends its request after the instance has
proved the same to it:

1. The caller sends ``GET /_instance/hello`` with ``X-CoDiscuss-Nonce: n1``.
2. The instance answers 204 with ``X-CoDiscuss-Proof: HMAC(K, "instance|" + n1)`` and its own ``X-CoDiscuss-Nonce: n2``,
   keeping the connection open.
3. The caller checks the proof, then sends one request on the same connection with
   ``X-CoDiscuss-Entry: HMAC(K, "entry|" + n2)``. The instance accepts it only on that connection and only for the key it
   used in step 2, and closes the connection after answering (a stream keeps it until the stream ends).

The key never travels. Protection is on when the environment names a key file (``DISCUSS_ENTRY_KEY_FILE``); a key file
that is then missing or unreadable refuses every protected request instead of falling back to no protection.
"""
import hashlib
import hmac
import json
import os
import re
import secrets
from pathlib import Path

KEY_FILE_VARIABLE = "DISCUSS_ENTRY_KEY_FILE"
HELLO_PATH = "/_instance/hello"
NONCE_HEADER = "X-CoDiscuss-Nonce"
PROOF_HEADER = "X-CoDiscuss-Proof"
ENTRY_HEADER = "X-CoDiscuss-Entry"
NONCE_PATTERN = re.compile(r"^[0-9a-f]{32}$")
KEY_PATTERN = re.compile(r"^[0-9a-f]{64}$")
# How long a connection that said hello may wait before its one request arrives.
HANDSHAKE_SECONDS = 10
# Paths any caller may read: the health check and the page's static files carry no data.
PUBLIC_PATHS = ("/api/health", "/robots.txt")


def proof(key, purpose, nonce):
    """HMAC-SHA256 of ``purpose|nonce`` under the hexadecimal key, as hexadecimal."""
    return hmac.new(bytes.fromhex(key), f"{purpose}|{nonce}".encode("ascii"), hashlib.sha256).hexdigest()


class EntryPolicy:
    """Whether protection is on, and the instance's current key, read from its file every time it is needed.

    The file is a few bytes, so it is not cached: a cache keyed on the modification time would keep honouring an old or
    broken key after a change that left the time as it was.
    """

    def __init__(self, key_file=None):
        configured = key_file if key_file is not None else os.getenv(KEY_FILE_VARIABLE)
        self.path = Path(configured) if configured else None

    @property
    def enabled(self):
        """Protection is on once a key file is named, whether or not it can be read."""
        return self.path is not None

    def key(self):
        """The current key, or None when the named file is missing or malformed (everything protected is refused)."""
        if not self.path:
            return None
        try:
            value = json.loads(self.path.read_text(encoding="utf-8")).get("key")
        except (OSError, ValueError, AttributeError):
            return None
        return value if isinstance(value, str) and KEY_PATTERN.match(value) else None


def answer_hello(handler, policy):
    """Prove this instance to a caller and open the connection's single authenticated request.

    Returns True when the hello was answered; a malformed hello or a missing key closes the connection unanswered.
    """
    nonce = handler.headers.get(NONCE_HEADER, "")
    key = policy.key()
    handler.close_connection = True
    # One hello per connection: a second one ends it instead of keeping the connection open indefinitely.
    if not key or not NONCE_PATTERN.match(nonce) or getattr(handler, "entry_challenge", None) is not None:
        return False
    challenge = secrets.token_hex(16)
    handler.entry_challenge = (challenge, key)
    # Only this answer keeps the connection: HTTP/1.1 with a zero-length body, and a deadline for the request to follow.
    handler.protocol_version = "HTTP/1.1"
    handler.close_connection = False
    handler.connection.settimeout(HANDSHAKE_SECONDS)
    handler.send_response(204)
    handler.send_header(PROOF_HEADER, proof(key, "instance", nonce))
    handler.send_header(NONCE_HEADER, challenge)
    handler.send_header("Content-Length", "0")
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    return True


def request_proven(handler, policy):
    """The key this request proved, or None.

    The proof must answer the challenge issued on this request's own connection, under the key that challenge was issued
    with, and that key must still be current. The challenge is used up either way, and the connection closes after this
    request. A stream opened by the request is bound to the returned key, not to whatever is current when it starts.
    """
    challenge = getattr(handler, "entry_challenge", None)
    handler.entry_challenge = None
    if challenge is None:
        return None
    handler.close_connection = True
    nonce, key = challenge
    given = handler.headers.get(ENTRY_HEADER, "")
    return key if key == policy.key() and hmac.compare_digest(given, proof(key, "entry", nonce)) else None

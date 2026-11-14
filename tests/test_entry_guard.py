"""Entry protection: a hosted instance serves only callers that prove its key on the same connection."""
import json
import os
import secrets
import socket
import tempfile
import threading
import time
import unittest
from pathlib import Path

from backend.entry_guard import KEY_FILE_VARIABLE, proof
from backend.server import DiscussionServer, init_database


def read_response(sock):
    """Read one HTTP response (status, lower-case headers, body) using its Content-Length; b'' status at EOF."""
    data = b""
    while b"\r\n\r\n" not in data:
        chunk = sock.recv(4096)
        if not chunk:
            return None, {}, data
        data += chunk
    head, body = data.split(b"\r\n\r\n", 1)
    lines = head.decode("latin-1").split("\r\n")
    status = int(lines[0].split(" ")[1])
    headers = {name.lower(): value.strip() for name, value in (line.split(":", 1) for line in lines[1:])}
    length = int(headers.get("content-length", "0"))
    while len(body) < length:
        chunk = sock.recv(4096)
        if not chunk:
            break
        body += chunk
    return status, headers, body


def send(sock, path, headers=None, method="GET", body=None):
    """Write one HTTP/1.1 request, with a JSON body when one is given; `headers` may replace the Host."""
    data = json.dumps(body).encode("utf-8") if body is not None else b""
    fields = {"Host": "127.0.0.1", "Content-Length": str(len(data)), **({"Content-Type": "application/json"} if body is not None else {}),
              **(headers or {})}
    lines = [f"{method} {path} HTTP/1.1"] + [f"{name}: {value}" for name, value in fields.items()]
    sock.sendall(("\r\n".join(lines) + "\r\n\r\n").encode("ascii") + data)


class ProtectedInstance(unittest.TestCase):
    """A protected instance on loopback with a key file in a temporary folder."""

    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        root = Path(self.folder.name)
        self.key_file = root / "entry-key.json"
        self.key = secrets.token_hex(32)
        self.key_file.write_text(json.dumps({"key": self.key}), encoding="utf-8")
        database = root / "discuss.sqlite3"
        init_database(database, seed=False)
        previous = os.environ.get(KEY_FILE_VARIABLE)
        os.environ[KEY_FILE_VARIABLE] = str(self.key_file)
        try:
            self.server = DiscussionServer(("127.0.0.1", 0), database, local_launch=True)
        finally:
            if previous is None:
                os.environ.pop(KEY_FILE_VARIABLE, None)
            else:
                os.environ[KEY_FILE_VARIABLE] = previous
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.folder.cleanup()

    def connect(self):
        sock = socket.create_connection(("127.0.0.1", self.port), timeout=5)
        self.addCleanup(sock.close)
        return sock

    def hello(self, sock, key=None):
        """Say hello, check the instance's proof with `key`, and return the challenge to answer."""
        nonce = secrets.token_hex(16)
        send(sock, "/_instance/hello", {"X-CoDiscuss-Nonce": nonce})
        status, headers, _ = read_response(sock)
        self.assertEqual(status, 204)
        self.assertEqual(headers["x-codiscuss-proof"], proof(key or self.key, "instance", nonce))
        return headers["x-codiscuss-nonce"]

class EntryGuardTest(ProtectedInstance):
    """The instance serves only requests proven on their own connection, under the current key."""

    def proven(self, path, method="GET", body=None, token=None):
        """One request on a fresh connection after a correct hello; returns (status, decoded JSON body)."""
        sock = self.connect()
        challenge = self.hello(sock)
        headers = {"X-CoDiscuss-Entry": proof(self.key, "entry", challenge), "Host": f"127.0.0.1:{self.port}"}
        if token:
            headers["X-Discussion-Token"] = token
        send(sock, path, headers, method, body)
        status, _, data = read_response(sock)
        return status, json.loads(data or b"null")

    def test_passing_the_entry_does_not_lift_a_member_to_the_room_owner(self):
        owner, member = secrets.token_hex(16), secrets.token_hex(16)
        status, room = self.proven("/api/rooms", "POST", {"title": "托管房间", "goal": "核对角色", "mode": "free",
                                                        "members": [{"name": "Codex", "adapter": "codex_cli", "token": member}],
                                                        "submission_id": "entry-roles"}, owner)
        self.assertEqual(status, 201, room)
        base = f"/api/rooms/{room['id']}"
        move = {"actor": "用户", "before_id": None}
        for path, method, body in ((base + "/move", "POST", move), (base + "/folder", "POST", {"actor": "用户", "folder_id": None}),
                                   (base + "/backup", "GET", None), (base + "/rename", "POST", {"actor": "用户", "title": "改名"})):
            self.assertEqual(self.proven(path, method, body, member)[0], 403, f"a member through the entry: {path}")
        self.assertEqual(self.proven(base + "/move", "POST", move, owner)[0], 200, "the owner's credential")
        self.assertEqual(self.proven(base + "/backup", "GET", None, owner)[0], 200)
        self.assertEqual(self.proven(base + "/move", "POST", move)[0], 200, "the page itself, which sends no room credential")

    def test_a_key_file_changed_without_a_new_modification_time_is_read_again(self):
        stamp = self.key_file.stat()
        self.assertEqual(self.proven("/api/rooms")[0], 200)
        old_key, self.key = self.key, secrets.token_hex(32)
        self.key_file.write_text(json.dumps({"key": self.key}), encoding="utf-8")
        os.utime(self.key_file, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
        sock = self.connect()
        nonce = secrets.token_hex(16)
        send(sock, "/_instance/hello", {"X-CoDiscuss-Nonce": nonce})
        self.assertNotEqual(read_response(sock)[1]["x-codiscuss-proof"], proof(old_key, "instance", nonce), "the old key is not used")
        self.key_file.write_text("{broken" + " " * 70, encoding="utf-8")
        os.utime(self.key_file, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
        sock = self.connect()
        send(sock, "/api/rooms")
        self.assertEqual(read_response(sock)[0], 403)
        sock = self.connect()
        send(sock, "/_instance/hello", {"X-CoDiscuss-Nonce": secrets.token_hex(16)})
        self.assertIsNone(read_response(sock)[0], "a broken file offers no proof even with its old modification time")

    def test_only_public_files_answer_without_proof(self):
        for path in ("/api/rooms", "/api/updates", "/r/missing", "/api/local/settings"):
            sock = self.connect()
            send(sock, path)
            self.assertEqual(read_response(sock)[0], 403, path)
        sock = self.connect()
        send(sock, "/api/health")
        self.assertEqual(read_response(sock)[0], 200)

    def test_a_proven_request_is_served_once_and_its_connection_closes(self):
        sock = self.connect()
        challenge = self.hello(sock)
        send(sock, "/api/rooms", {"X-CoDiscuss-Entry": proof(self.key, "entry", challenge)})
        status, headers, _ = read_response(sock)
        self.assertEqual(status, 200)
        self.assertEqual(headers.get("connection"), "close")
        self.assertEqual(sock.recv(1), b"", "the connection ends after its one request")

    def test_a_proof_is_good_only_on_its_own_connection_and_with_its_own_challenge(self):
        first = self.connect()
        challenge = self.hello(first)
        other = self.connect()
        send(other, "/api/rooms", {"X-CoDiscuss-Entry": proof(self.key, "entry", challenge)})
        self.assertEqual(read_response(other)[0], 403, "a proof replayed on another connection")
        send(first, "/api/rooms", {"X-CoDiscuss-Entry": proof(self.key, "entry", secrets.token_hex(16))})
        self.assertEqual(read_response(first)[0], 403, "a proof for another challenge")
        wrong = self.connect()
        self.hello(wrong)
        send(wrong, "/api/rooms", {"X-CoDiscuss-Entry": proof(secrets.token_hex(32), "entry", "0" * 32)})
        self.assertEqual(read_response(wrong)[0], 403, "a proof under another key")

    def test_a_missing_or_broken_key_file_refuses_everything_protected(self):
        self.key_file.write_text("not json", encoding="utf-8")
        sock = self.connect()
        send(sock, "/_instance/hello", {"X-CoDiscuss-Nonce": secrets.token_hex(16)})
        self.assertIsNone(read_response(sock)[0], "no proof is offered without a key")
        self.key_file.unlink()
        sock = self.connect()
        send(sock, "/api/rooms")
        self.assertEqual(read_response(sock)[0], 403)

    def test_a_challenge_issued_before_a_key_change_is_refused_after_it(self):
        sock = self.connect()
        challenge = self.hello(sock)
        new_key = secrets.token_hex(32)
        time.sleep(0.05)
        self.key_file.write_text(json.dumps({"key": new_key}), encoding="utf-8")
        send(sock, "/api/rooms", {"X-CoDiscuss-Entry": proof(self.key, "entry", challenge)})
        self.assertEqual(read_response(sock)[0], 403)

    def test_a_stream_whose_key_changes_between_its_proof_and_its_start_still_ends(self):
        import backend.server as server_module
        original = server_module.request_proven
        for change in ("rotate", "delete"):
            with self.subTest(change=change):
                self.key_file.write_text(json.dumps({"key": self.key}), encoding="utf-8")

                def proven_then_changed(handler, policy):
                    """Verify as usual, then change the key before the stream opens."""
                    verified = original(handler, policy)
                    if change == "rotate":
                        self.key_file.write_text(json.dumps({"key": secrets.token_hex(32)}), encoding="utf-8")
                    else:
                        self.key_file.unlink()
                    return verified

                server_module.request_proven = proven_then_changed
                try:
                    sock = self.connect()
                    challenge = self.hello(sock)
                    send(sock, "/api/updates", {"X-CoDiscuss-Entry": proof(self.key, "entry", challenge)})
                    sock.settimeout(30)
                    deadline, ended = time.time() + 25, False
                    while time.time() < deadline:
                        if sock.recv(4096) == b"":
                            ended = True
                            break
                    self.assertTrue(ended, "a stream proven with the old key ends once it sees the key changed")
                finally:
                    server_module.request_proven = original

    def test_an_open_update_stream_ends_when_the_key_changes(self):
        sock = self.connect()
        challenge = self.hello(sock)
        send(sock, "/api/updates", {"X-CoDiscuss-Entry": proof(self.key, "entry", challenge)})
        sock.settimeout(30)
        received = sock.recv(4096)
        self.assertIn(b"200", received.split(b"\r\n", 1)[0])
        time.sleep(0.05)
        self.key_file.write_text(json.dumps({"key": secrets.token_hex(32)}), encoding="utf-8")
        # The stream checks the key at least once per heartbeat and then ends without any new request arriving.
        deadline = time.time() + 25
        while time.time() < deadline:
            if sock.recv(4096) == b"":
                break
        else:
            self.fail("the stream stayed open after the key changed")



class CliHandshakeTest(ProtectedInstance):
    """The member CLI reaches a protected instance only through the handshake, never by falling back to a plain request."""

    def cli(self, path="/api/rooms", port=None):
        from runner import discuss
        previous = os.environ.get(KEY_FILE_VARIABLE)
        os.environ[KEY_FILE_VARIABLE] = str(self.key_file)
        try:
            return discuss.send_request(discuss.RequestPlan(path), f"http://127.0.0.1:{port or self.port}{path}", 5)
        finally:
            if previous is None:
                os.environ.pop(KEY_FILE_VARIABLE, None)
            else:
                os.environ[KEY_FILE_VARIABLE] = previous

    def fake_upstream(self, answer):
        """A listener that records every connection and what it received, answering each first chunk with `answer(chunk)`."""
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        self.addCleanup(listener.close)
        seen = []

        def serve():
            while True:
                try:
                    connection, _ = listener.accept()
                except OSError:
                    return
                with connection:
                    chunk = connection.recv(65536)
                    seen.append(chunk)
                    reply = answer(chunk)
                    if reply:
                        connection.sendall(reply)
                    try:
                        connection.settimeout(0.5)
                        more = connection.recv(65536)
                        if more:
                            seen.append(more)
                    except OSError:
                        pass

        threading.Thread(target=serve, daemon=True).start()
        return listener.getsockname()[1], seen

    def hello_answer(self, extra=""):
        def answer(chunk):
            nonce = chunk.split(b"X-CoDiscuss-Nonce: ")[1][:32].decode()
            return (f"HTTP/1.1 204 No Content\r\nX-CoDiscuss-Proof: {proof(self.key, 'instance', nonce)}\r\n"
                    f"X-CoDiscuss-Nonce: {'e' * 32}\r\nContent-Length: 0\r\n{extra}\r\n").encode()
        return answer

    def test_the_cli_is_served_through_the_handshake(self):
        self.assertIn("rooms", self.cli())

    def test_the_cli_sends_nothing_when_its_key_is_broken_or_the_upstream_is_not_the_instance(self):
        from runner import discuss
        port, seen = self.fake_upstream(lambda chunk: b"HTTP/1.1 204 No Content\r\nX-CoDiscuss-Proof: 00\r\nContent-Length: 0\r\n\r\n")
        with self.assertRaises(discuss.CliError):
            self.cli("/api/rooms/secret-room", port)
        time.sleep(0.6)
        self.assertEqual(len(seen), 1)
        self.assertNotIn(b"secret-room", b"".join(seen))
        self.key_file.write_text("{broken", encoding="utf-8")
        with self.assertRaises(discuss.CliError):
            self.cli()

    def test_the_cli_never_resends_on_a_new_connection_after_the_hello(self):
        from runner import discuss
        for extra in ("Connection: close\r\n", ""):
            with self.subTest(announced_close=bool(extra)):
                port, seen = self.fake_upstream(self.hello_answer(extra))
                with self.assertRaises(discuss.CliError):
                    self.cli("/api/rooms/secret-room", port)
                time.sleep(0.6)
                self.assertEqual(sum(chunk.startswith(b"GET /_instance/hello") for chunk in seen), 1, "one connection only")
                if extra:
                    self.assertNotIn(b"secret-room", b"".join(seen), "a hello that announces closing gets no request")


if __name__ == "__main__":
    unittest.main()

"""Room attachment credentials issued through the Resource Center COS proxy."""

import json
import os
import re
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

from .admin import AdminError
from .texts import Text

OBJECT_MAX_BYTES = 2 * 1024**3
REQUEST_TIMEOUT = 6
ADMIN_REQUEST_TIMEOUT = 7
DOWNLOAD_SECONDS = 600
MAX_RESPONSE_BYTES = 64 * 1024
KEY_REFERENCE = re.compile(r"[a-f0-9-]{36}", re.IGNORECASE)
SETTINGS_NAME = "object-storage-settings.json"
QUOTA_NAME = "object-storage-quota.json"
DEFAULT_RETENTION_DAYS = 0
MAX_RETENTION_DAYS = 30
DEFAULT_QUOTA_MIB = 10240
MAX_QUOTA_MIB = 1048576
DEFAULT_THRESHOLD_MIB = 20
UPLOAD_FIELDS = {"key": "key", "policy": "policy", "q-ak": "qAk", "q-key-time": "qKeyTime",
                 "q-signature": "qSignature", "q-sign-algorithm": "qSignAlgorithm"}


class StorageUnavailable(Exception):
    """The resource center could not perform the operation."""


class ObjectMissing(StorageUnavailable):
    """The resource center confirmed the object does not exist."""


class ManagedStorageOffline(StorageUnavailable):
    """The hosted instance could not reach its administrator's loopback service."""


class ManagedStorageQuota(StorageUnavailable):
    """The administrator's quota did not allow another object reservation."""

    def __init__(self, used, quota):
        super().__init__()
        self.used = used
        self.quota = quota


def storage_http_error(error):
    """Translate object storage failures for room HTTP routes."""
    if isinstance(error, ManagedStorageOffline):
        return AdminError(Text("云空间暂不可用（管理员服务未运行）"), 503)
    if isinstance(error, ManagedStorageQuota):
        return AdminError(Text("云空间已用 {used} 字节，上限 {quota} MiB，请先清理云空间",
                               used=error.used, quota=error.quota), 409)
    return AdminError(Text("对象存储暂不可用"), 503)


class NoRedirect(HTTPRedirectHandler):
    """Prevent forwarding the private API key to a redirected request."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def storage_url(value, https_only=False):
    """Accept an absolute HTTP URL without user info or header control characters."""
    if not isinstance(value, str) or not value.isascii() or any(ord(char) < 33 or ord(char) == 127 for char in value):
        return False
    try:
        parsed = urlsplit(value)
        return (parsed.scheme in (("https",) if https_only else ("http", "https")) and bool(parsed.hostname)
                and parsed.username is None and not parsed.fragment)
    except ValueError:
        return False


def storage_home(database):
    """Resolve object settings to this account, independently of the inherited attachment limit."""
    home = os.environ.get("DISCUSS_SERVICE_HOME")
    return Path(home) if home else Path(database).parent


def private_record(path):
    """Read an ordinary private JSON file rather than following a key symlink."""
    if path.is_symlink() or not path.is_file():
        raise FileNotFoundError()
    return json.loads(path.read_text(encoding="utf-8"))


def storage_credentials(record):
    """Validate the address and an HTTP-header-safe key without returning any user-visible details."""
    base_url = record["base_url"]
    api_key = record["api_key"]
    if (not storage_url(base_url) or urlsplit(base_url).query or not isinstance(api_key, str)
            or not api_key.strip() or any(not 32 <= ord(char) <= 126 for char in api_key.strip())):
        raise ValueError()
    return {"base_url": base_url.rstrip("/"), "api_key": api_key.strip()}


def object_storage_setting(database, name, default, bounds):
    """Read one integer policy field from the current account, defaulting on invalid input."""
    try:
        value = private_record(storage_home(database) / SETTINGS_NAME)[name]
    except (OSError, ValueError, TypeError, KeyError):
        return default
    minimum, maximum = bounds
    return value if type(value) is int and minimum <= value <= maximum else default


def object_storage_retention_days(database):
    """Return days to retain an object, or zero to keep it until manually cleared."""
    return object_storage_setting(database, "retention_days", DEFAULT_RETENTION_DAYS, (0, MAX_RETENTION_DAYS))


def object_storage_quota_mib(database):
    """Read the administrator's quota for this instance, defaulting to 10 GiB."""
    path = Path(os.environ.get("DISCUSS_OBJECT_STORAGE_QUOTA_FILE") or Path(database).with_name(QUOTA_NAME))
    try:
        value = private_record(path)
    except (OSError, ValueError):
        return DEFAULT_QUOTA_MIB
    return value if type(value) is int and 1 <= value <= MAX_QUOTA_MIB else DEFAULT_QUOTA_MIB


def object_storage_threshold_mib(database, attachment_limit):
    """Return the cloud threshold, capped by the site's direct attachment limit."""
    return object_storage_setting(database, "object_threshold_mib", min(DEFAULT_THRESHOLD_MIB, attachment_limit),
                                  (1, attachment_limit))


def configured_storage(database):
    """Resolve only a key stored for the configured address in this account's key directory."""
    home = storage_home(database)
    try:
        config = private_record(home / SETTINGS_NAME)
        if isinstance(config, dict) and config.get("mode") == "admin":
            return AdministratorStorage(os.environ.get("DISCUSS_OBJECT_STORAGE_ADMIN_FILE"))
        ref = config["api_key_ref"]
        directory = home / "api-keys"
        if not isinstance(ref, str) or not KEY_REFERENCE.fullmatch(ref) or directory.is_symlink():
            return None
        key = storage_credentials(private_record(directory / f"{ref}.json"))
        if key["base_url"] != config["base_url"]:
            return None
        return ResourceCenter(**key)
    except (OSError, ValueError, TypeError, KeyError):
        return None


class ResourceCenter:
    """Use the server-side Key for metadata, deletion and temporary COS credentials."""

    def __init__(self, base_url, api_key):
        self.base_url = base_url
        self.api_key = api_key

    def request(self, method, path, payload=None, **params):
        """Check HTTP transport and the Resource Center's business envelope independently."""
        url = self.base_url + path + ("?" + urlencode(params) if params else "")
        headers = {"X-Api-Key": self.api_key, "Accept": "application/json"}
        data = None
        if payload is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(payload).encode("utf-8")
        try:
            with build_opener(NoRedirect()).open(Request(url, data, headers, method=method), timeout=REQUEST_TIMEOUT) as response:
                body = response.read(MAX_RESPONSE_BYTES + 1)
                if len(body) > MAX_RESPONSE_BYTES or not 200 <= response.status < 300:
                    raise StorageUnavailable()
                result = json.loads(body)
        except HTTPError as error:
            with error:
                if error.code == 404 and path in ("/file-info", "/presigned-download-url", "/file"):
                    raise ObjectMissing() from None
            raise StorageUnavailable() from None
        except (URLError, OSError, ValueError) as error:
            raise StorageUnavailable() from None
        if not isinstance(result, dict) or result.get("succeed") is not True:
            if isinstance(result, dict) and result.get("code") in (404, "404"):
                raise ObjectMissing()
            raise StorageUnavailable()
        return result.get("data")

    def upload(self, name, size, content_type):
        """Return only the COS form fields the client needs for the reserved object."""
        data = self.request("POST", "/upload-credential", {"fileName": name, "maxSizeBytes": size, "contentType": content_type})
        if not isinstance(data, dict) or not storage_url(data.get("url"), https_only=True):
            raise StorageUnavailable()
        fields = {field: data.get(key) for field, key in UPLOAD_FIELDS.items()}
        if not all(isinstance(value, str) and value for value in fields.values()):
            raise StorageUnavailable()
        return {"url": data["url"], "fields": {**fields, "Content-Type": content_type}}

    def file_size(self, name):
        """Return the recorded size of an existing object."""
        data = self.request("GET", "/file-info", fileName=name)
        if not isinstance(data, dict) or type(data.get("size")) is not int or data.get("isDirectory"):
            raise StorageUnavailable()
        return data["size"]

    def download(self, name):
        """Request a short-lived URL for the stored object."""
        data = self.request("GET", "/presigned-download-url", fileName=name, expiresIn=DOWNLOAD_SECONDS)
        if (not isinstance(data, dict) or not storage_url(data.get("url"), https_only=True)
                or not isinstance(data.get("expiresAt"), str) or not data["expiresAt"]):
            raise StorageUnavailable()
        return {"url": data["url"], "expires_at": data["expiresAt"]}

    def delete(self, name):
        """Remove the object; a previously removed object is already clean."""
        try:
            self.request("DELETE", "/file", fileName=name)
        except ObjectMissing:
            pass


class AdministratorStorage(ResourceCenter):
    """Apply the same COS response rules to calls signed by the local administrator."""

    def __init__(self, credential_file):
        self.credential_file = credential_file

    def credentials(self):
        """Read the account-bound token by path, so server-side rotation takes effect on the next call."""
        try:
            record = private_record(Path(self.credential_file))
            account, port, token = record["account"], record["port"], record["token"]
            if (not re.fullmatch(r"[a-z0-9][a-z0-9_-]{1,31}", account) or type(port) is not int or
                    not 1 <= port <= 65535 or not re.fullmatch(r"[a-f0-9]{64}", token)):
                raise ValueError()
            return account, port, token
        except (OSError, ValueError, TypeError, KeyError):
            raise ManagedStorageOffline() from None

    def request(self, method, path, payload=None, **params):
        """Send an operation to the loopback signer without consulting the system HTTP proxy."""
        account, port, token = self.credentials()
        source = (payload or params)["fileName"]
        if not source.startswith("codiscuss/"):
            raise StorageUnavailable()
        name = f"codiscuss/{account}/{source.removeprefix('codiscuss/')}"
        data = {"account": account, "name": name}
        if path == "/upload-credential":
            data.update(size=payload["maxSizeBytes"], content_type=payload["contentType"])
        headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        request = Request(f"http://127.0.0.1:{port}/internal/object-storage{path}",
                          json.dumps(data).encode("utf-8"), headers, method="POST")
        try:
            with build_opener(ProxyHandler({}), NoRedirect()).open(request, timeout=ADMIN_REQUEST_TIMEOUT) as response:
                body = response.read(MAX_RESPONSE_BYTES + 1)
                if len(body) > MAX_RESPONSE_BYTES:
                    raise StorageUnavailable()
                result = json.loads(body)
        except HTTPError as error:
            with error:
                raise self.request_error(error) from None
        except (URLError, OSError):
            raise ManagedStorageOffline() from None
        except ValueError:
            raise StorageUnavailable() from None
        if not isinstance(result, dict) or result.get("succeed") is not True:
            raise StorageUnavailable()
        return result.get("data")

    @staticmethod
    def request_error(error):
        """Accept only recognized signer error statuses and validated quota counts."""
        try:
            result = json.loads(error.read(MAX_RESPONSE_BYTES + 1))
            if not isinstance(result, dict) or result.get("code") != error.code:
                return StorageUnavailable()
            if error.code == 404:
                return ObjectMissing()
            if error.code == 409:
                params = result.get("error_text", {}).get("params", {})
                used, quota = params.get("used"), params.get("quota")
                if type(used) is int and used >= 0 and type(quota) is int and 1 <= quota <= MAX_QUOTA_MIB:
                    return ManagedStorageQuota(used, quota)
        except (OSError, ValueError, AttributeError):
            pass
        return StorageUnavailable()

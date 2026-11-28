"""Account-wide cloud drive metadata and recycle bin, independent of room navigation."""

import base64
import binascii
import io
import logging
import re
import unicodedata
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

from .admin import AdminError
from .object_storage import AdministratorStorage
from .runtime import begin_write
from .texts import Text, error_body

PREFIX = "/api/rooms/cloud-attachments"
IDENTIFIER = re.compile(r"[0-9a-f]{32}")
MAX_DEPTH = 10
MAX_BATCH = 500
# One concurrent wave, so the 6–7 second upstream timeout does not add up within an 8-second relay request.
PURGE_BATCH = 4
# Tencent COS limits the entire ObjectKey to 850 UTF-8 bytes:
# https://cloud.tencent.com/document/api/436/13324
MAX_OBJECT_KEY_BYTES = 850
MANAGED_ACCOUNT_PREFIX_BYTES = 33  # Up to 32 ASCII account bytes and the separator inserted by the signer.
MAX_NAME = 255
TRASH_TTL = timedelta(days=30)
THUMBNAIL_MAX_BYTES = 64 * 1024
THUMBNAIL_MAX_SIDE = 480
THUMBNAIL_TYPES = {"image/webp", "image/jpeg"}
SYSTEM_FOLDERS = {"root": "云空间", "rooms": "房间附件", "transfers": "传输暂存", "trash": "回收站"}
CLOUD_FILE_MIGRATIONS = (
    ("folder_id", "TEXT REFERENCES cloud_folders(id) ON DELETE SET NULL"),
    ("trashed_at", "TEXT"),
    ("trash_root", "TEXT"),
    ("thumbnail_type", "TEXT"),
    ("purge_started", "INTEGER NOT NULL DEFAULT 0"),
)


def utc_now():
    """Return a UTC timestamp in the database format."""
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def unsafe_name_char(char):
    """Identify path separators, control characters and invalid Unicode surrogates."""
    return char in "/\\" or unicodedata.category(char) in {"Cc", "Cs"}


def object_key(prefix, name):
    """Fit one safe Unicode file name, including the extension, in the full COS key."""
    safe = "".join(char for char in name if not unsafe_name_char(char)).replace("%", "_")
    safe = safe.replace("$" + "{filename}", "filename")
    if safe in {"", ".", ".."}:
        safe = "file"
    budget = MAX_OBJECT_KEY_BYTES - len(prefix.encode("utf-8")) - MANAGED_ACCOUNT_PREFIX_BYTES
    encoded = safe.encode("utf-8")
    if len(encoded) > budget:
        stem, dot, ext = safe.rpartition(".")
        suffix = (dot + ext).encode("utf-8") if stem and ext else b""
        if len(suffix) >= budget:
            suffix = b""
        encoded = (stem.encode("utf-8") if suffix else encoded)[:budget - len(suffix)]
        safe = (encoded.decode("utf-8", "ignore") or "_") + suffix.decode("utf-8")
    return prefix + safe


def validate_name(name):
    """Reject names that cannot be one path segment."""
    if (not isinstance(name, str) or not 0 < len(name) <= MAX_NAME or not name.strip()
            or name in (".", "..") or any(map(unsafe_name_char, name))):
        raise ValueError(Text("文件名需为 1–{value1} 字，不能包含路径或控制字符", value1=MAX_NAME))
    return name


def require_available(row):
    """Prevent fresh access to a recycled file without revoking already issued URLs."""
    if "trashed_at" in row.keys() and row["trashed_at"] is not None:
        raise AdminError(Text("文件已不在对象存储中"), 410)


def record_id(value):
    """Validate a file or real folder ID."""
    if not isinstance(value, str) or not IDENTIFIER.fullmatch(value):
        raise ValueError(Text("附件编号无效"))
    return value


def selected_ids(payload, *, file_key="ids", singular=False):
    """Validate and deduplicate a bounded batch before performing any write."""
    files = payload.get(file_key, [payload["id"]] if singular and "id" in payload else [])
    folders = payload.get("folder_ids", [])
    if (not isinstance(files, list) or not isinstance(folders, list)
            or not 0 < len(files) + len(folders) <= MAX_BATCH):
        raise ValueError(Text("每次云盘操作须选择 1 至 {limit} 项", limit=MAX_BATCH))
    return (list(dict.fromkeys(map(record_id, values))) for values in (files, folders))


def folder_row(connection, identifier, trashed=False):
    """Look up one folder in the requested lifecycle state."""
    row = connection.execute("SELECT * FROM cloud_folders WHERE id=?", (record_id(identifier),)).fetchone()
    if row is None or (row["trashed_at"] is not None) != trashed:
        raise LookupError(Text("找不到云盘文件夹 {id}", id=identifier))
    return row


def live_file(connection, identifier, *, keep=False):
    """Look up a live cloud file, optionally restricting it to an editable drive entry."""
    row = connection.execute("""SELECT * FROM cloud_files
        WHERE id=? AND cleared_at IS NULL AND trashed_at IS NULL""", (record_id(identifier),)).fetchone()
    if row is None or keep and (row["purpose"] != "keep" or row["stored_at"] is None):
        raise LookupError(Text("找不到可操作的云盘文件 {id}", id=identifier))
    return row


def target_folder(connection, value):
    """Resolve a writable target, normalizing the root to None."""
    return None if value in (None, "", "root") else folder_row(connection, value)["id"]


def folder_chain(connection, identifier):
    """Return real ancestors then the folder itself, starting just below the root."""
    chain = []
    while identifier is not None:
        row = folder_row(connection, identifier)
        chain.append({"id": identifier, "name": row["name"]})
        identifier = row["parent_id"]
    return chain[::-1]


def folder_tree(connection, root):
    """Walk one live subtree with depth zero at its root."""
    return connection.execute("""WITH RECURSIVE tree(id, depth) AS (
        SELECT ?, 0 UNION ALL
        SELECT f.id, tree.depth+1 FROM cloud_folders f JOIN tree ON f.parent_id=tree.id
            WHERE f.trashed_at IS NULL
        ) SELECT id, depth FROM tree""", (root,)).fetchall()


def check_depth(depth):
    """Enforce the limit for both creation and moving an entire subtree."""
    if depth > MAX_DEPTH:
        raise ValueError(Text("云盘文件夹最多 {limit} 层", limit=MAX_DEPTH))


def same_named_folder(connection, parent, name):
    """Find an active sibling by exact name, including at the root."""
    return connection.execute("""SELECT id FROM cloud_folders
        WHERE parent_id IS ? AND name=? AND trashed_at IS NULL""", (parent, name)).fetchone()


def require_unique_folder(connection, parent, name, identifier=None):
    """Return a conflict for a sibling collision instead of relying on an SQL error."""
    duplicate = same_named_folder(connection, parent, name)
    if duplicate is not None and duplicate["id"] != identifier:
        raise FileExistsError(Text("此位置已有同名文件夹 {name}", name=name))


def insert_folder(connection, parent, name):
    """Create one folder under the caller's write lock."""
    identifier = uuid.uuid4().hex
    connection.execute("INSERT INTO cloud_folders(id,parent_id,name,created_at) VALUES (?,?,?,?)",
                       (identifier, parent, name, utc_now()))
    return identifier


def resolve_path(connection, parent, path):
    """Find or create each path component under one write lock."""
    if not isinstance(path, str):
        raise ValueError(Text("云盘相对目录无效"))
    parts = [validate_name(part) for part in path.split("/")] if path else []
    check_depth(len(folder_chain(connection, parent)) + len(parts))
    for name in parts:
        existing = same_named_folder(connection, parent, name)
        parent = existing["id"] if existing is not None else insert_folder(connection, parent, name)
    return parent


def folder_view(row):
    """Serialize the folder as a typed entry."""
    return {**dict(row), "kind": "folder"}


def create_folder(connection, payload):
    """Create a single folder or idempotently ensure an entire path."""
    parent = target_folder(connection, payload.get("parent_id"))
    if "path" in payload:
        identifier = resolve_path(connection, parent, payload["path"])
        if identifier is None:
            raise ValueError(Text("云盘相对目录无效"))
    else:
        name = validate_name(payload.get("name"))
        check_depth(len(folder_chain(connection, parent)) + 1)
        require_unique_folder(connection, parent, name)
        identifier = insert_folder(connection, parent, name)
    return {"folder": folder_view(folder_row(connection, identifier))}


def rename(connection, payload):
    """Rename an editable file or folder without changing its object path."""
    from .server import cloud_file_view

    kind, identifier, name = payload.get("kind"), payload.get("id"), validate_name(payload.get("name"))
    if kind == "folder":
        row = folder_row(connection, identifier)
        require_unique_folder(connection, row["parent_id"], name, identifier)
        connection.execute("UPDATE cloud_folders SET name=? WHERE id=?", (name, identifier))
        return {"folder": folder_view(folder_row(connection, identifier))}
    if kind != "file":
        raise ValueError(Text("云盘项目类型无效"))
    live_file(connection, identifier, keep=True)
    connection.execute("UPDATE cloud_files SET file_name=? WHERE id=?", (name, identifier))
    return {"file": cloud_file_view(connection, live_file(connection, identifier, keep=True))}


def selected_roots(connection, identifiers):
    """Validate all selected folders and avoid handling descendants twice."""
    selected = set(identifiers)
    roots = []
    for identifier in identifiers:
        row = folder_row(connection, identifier)
        if not selected.intersection(parent["id"] for parent in folder_chain(connection, row["parent_id"])):
            roots.append(row)
    return roots


def move(connection, payload):
    """Move a batch to one destination, rejecting invalid moves before any change."""
    file_ids, folder_ids = selected_ids(payload, file_key="file_ids")
    target = target_folder(connection, payload.get("target_id"))
    chain = folder_chain(connection, target)
    if set(folder_ids).intersection(folder["id"] for folder in chain):
        raise ValueError(Text("不能把文件夹移到自身或子文件夹中"))
    roots = selected_roots(connection, folder_ids)
    names = set()
    moving_trees = set()
    for row in roots:
        if row["name"] in names:
            raise FileExistsError(Text("此位置已有同名文件夹 {name}", name=row["name"]))
        names.add(row["name"])
        require_unique_folder(connection, target, row["name"], row["id"])
        tree = folder_tree(connection, row["id"])
        moving_trees.update(item["id"] for item in tree)
        check_depth(len(chain) + 1 + max(item["depth"] for item in tree))
    files = [live_file(connection, identifier, keep=True) for identifier in file_ids]
    connection.executemany("UPDATE cloud_folders SET parent_id=? WHERE id=?", ((target, row["id"]) for row in roots))
    connection.executemany("UPDATE cloud_files SET folder_id=? WHERE id=?",
                           ((target, row["id"]) for row in files if row["folder_id"] not in moving_trees))
    return {"moved": file_ids + [row["id"] for row in roots]}


def cloud_rows(connection, folder, search):
    """Select cloud and attachment rows for a legacy, scoped, or search view."""
    from .server import LIVE_CLOUD_ATTACHMENTS

    cloud_where = "c.cleared_at IS NULL"
    if folder == "trash":
        cloud_where += " AND c.trash_root=c.id AND c.trashed_at IS NOT NULL"
    else:
        cloud_where += " AND c.trashed_at IS NULL"
    if folder is not None and folder != "trash":
        cloud_where += " AND c.stored_at IS NOT NULL AND (c.expires_at IS NULL OR c.expires_at>?)"
        values = [utc_now()]
        if not search and folder != "rooms":
            if folder == "transfers":
                cloud_where += " AND c.purpose!='keep'"
            else:
                cloud_where += " AND c.purpose='keep' AND c.folder_id IS ?"
                values.append(None if folder == "root" else folder)
    else:
        values = []
    cloud = [] if folder == "rooms" and not search else connection.execute(f"""SELECT c.*,r.title AS room_title
        FROM cloud_files c LEFT JOIN rooms r ON r.id=c.room_id WHERE {cloud_where}""", values).fetchall()
    attachments = []
    if folder in (None, "rooms") or search and folder != "trash":
        sent = "" if folder is None else " AND a.message_id IS NOT NULL AND a.stored_at IS NOT NULL"
        attachments = connection.execute(f"""SELECT a.*,r.title AS room_title FROM attachments a
            JOIN rooms r ON r.id=a.room_id WHERE {LIVE_CLOUD_ATTACHMENTS}{sent}""").fetchall()
    return cloud, attachments


def listed_folders(connection, folder, search):
    """List live children or search results, or only recycled subtree roots."""
    if folder == "trash":
        where, params = "trashed_at IS NOT NULL AND trash_root=id", ()
    elif search:
        where, params = "trashed_at IS NULL", ()
    elif folder in ("rooms", "transfers"):
        return []
    else:
        where, params = "trashed_at IS NULL AND parent_id IS ?", (None if folder == "root" else folder,)
    result = [folder_view(row) for row in connection.execute(f"SELECT * FROM cloud_folders WHERE {where}", params)]
    if folder == "root" and not search:
        result = [{"id": key, "name": SYSTEM_FOLDERS[key], "kind": "folder", "readonly": True,
                   "parent_id": None} for key in ("rooms", "transfers")] + result
    return [item for item in result if search in item["name"].casefold()]


def usage(connection, database):
    """Return account usage, including pending objects and recycled files."""
    from .server import object_storage_quota_mib, object_storage_used_bytes

    return {"used_bytes": object_storage_used_bytes(connection), "quota_mib": object_storage_quota_mib(database)}


def list_entries(connection, database, params):
    """Keep the legacy flat API while offering folder views, global search and trash accounting."""
    from .server import attachment_view, cloud_file_view

    connection.execute("BEGIN")
    folder = params.get("folder")
    search = params.get("q", "").strip().casefold() if folder is not None else ""
    chain = [] if folder is None or folder in SYSTEM_FOLDERS else folder_chain(connection, folder)
    cloud, attachments = cloud_rows(connection, folder, search)
    files = [cloud_file_view(connection, row) for row in cloud if search in row["file_name"].casefold()]
    files += [{**attachment_view(connection, row), "kind": "attachment", "source_kind": "attachment",
               "source_ref": row["id"]} for row in attachments if search in row["file_name"].casefold()]
    files.sort(key=lambda item: item["id"])
    files.sort(key=lambda item: item["created_at"], reverse=True)
    stats = usage(connection, database)
    if folder is None:
        return {"attachments": files, **stats}
    root = {"id": "root", "name": SYSTEM_FOLDERS["root"]}
    path = [root] + (chain if chain or folder == "root" else [{"id": folder, "name": SYSTEM_FOLDERS[folder]}])
    trash_bytes = connection.execute("""SELECT COALESCE(SUM(size),0) FROM cloud_files
        WHERE cleared_at IS NULL AND trashed_at IS NOT NULL""").fetchone()[0]
    return {"folder": {**path[-1], "path": path}, "folders": listed_folders(connection, folder, search),
            "files": files, "trash_bytes": trash_bytes, **stats}


def files_and_folders_to_delete(connection, payload, permanent):
    """Validate the whole delete selection before any remote deletion or metadata change."""
    file_ids, folder_ids = selected_ids(payload, singular=True)
    groups = {}
    if permanent:
        for identifier in folder_ids:
            row = connection.execute("SELECT * FROM cloud_folders WHERE id=?", (identifier,)).fetchone()
            if row is None:
                continue  # A previous batch may have already purged this folder.
            if row["trashed_at"] is not None and row["trash_root"] != identifier:
                raise LookupError(Text("找不到云盘文件夹 {id}", id=identifier))
            if row["trashed_at"] is not None:
                groups[identifier] = None
        folder_ids = [identifier for identifier in folder_ids if identifier not in groups
                      and connection.execute("SELECT 1 FROM cloud_folders WHERE id=?", (identifier,)).fetchone()]
    groups.update({row["id"]: [item["id"] for item in folder_tree(connection, row["id"])]
                   for row in selected_roots(connection, folder_ids)})
    rows = {}
    for identifier in file_ids:
        row = connection.execute("""SELECT * FROM attachments
            WHERE id=? AND storage='object' AND object_name IS NOT NULL""", (identifier,)).fetchone()
        if row is None:
            row = connection.execute("SELECT * FROM cloud_files WHERE id=?", (identifier,)).fetchone()
            if row is None or row["trashed_at"] is not None and row["trash_root"] != identifier:
                raise LookupError(Text("找不到可操作的云盘文件 {id}", id=identifier))
        rows[identifier] = row
    return rows, groups


def trash_folders(connection, groups, now):
    """Give every member of an active subtree its selected root's recycle marker."""
    grouped_files = set()
    for root, folders in groups.items():
        for folder in folders:
            grouped_files.update(row["id"] for row in connection.execute("""UPDATE cloud_files
                SET trashed_at=?,trash_root=? WHERE folder_id=? AND cleared_at IS NULL AND trashed_at IS NULL
                AND purpose='keep' RETURNING id""", (now, root, folder)))
            connection.execute("UPDATE cloud_folders SET trashed_at=?,trash_root=? WHERE id=?", (now, root, folder))
    return grouped_files


def mark_purge_batch(connection, rows, limit):
    """Commit durable claims before contacting COS so an uncertain deletion cannot be undone."""
    batch = [row for row in rows.values() if row["cleared_at"] is None][:limit]
    connection.executemany("""UPDATE cloud_files SET purge_started=1
        WHERE id=? AND trashed_at IS NOT NULL AND cleared_at IS NULL AND purge_started=0""",
                           ((row["id"],) for row in rows.values()
                            if "purpose" in row.keys() and row["trashed_at"] is not None
                            and row["cleared_at"] is None and not row["purge_started"]))
    connection.commit()
    return batch


def confirm_purges(connection, database, confirmed):
    """Record confirmed objects in one short transaction, only for the same reservation."""
    from .server import mark_cleared_object_attachments

    cleared, attachments = [], []
    with connection:
        begin_write(connection)
        for row in confirmed:
            if "storage" in row.keys():
                attachments.append(row)
                continue
            changed = connection.execute("""UPDATE cloud_files SET cleared_at=?,thumbnail_type=NULL
                WHERE id=? AND object_name=? AND cleared_at IS NULL AND trash_root IS ? AND trashed_at IS ?
                AND (trashed_at IS NULL OR purge_started=1)""",
                (utc_now(), row["id"], row["object_name"], row["trash_root"], row["trashed_at"]))
            if changed.rowcount:
                cleared.append(row)
        changed = mark_cleared_object_attachments(connection, attachments)
    for row in cleared:
        try:
            thumbnail_path(database, row["id"]).unlink(missing_ok=True)
        except OSError:
            logging.warning("Could not remove cloud thumbnail %s", row["id"])
    return cleared + changed, {row["room_id"] for row in changed}


def purge_batch_limit(client):
    """Administrator signing serializes operations for one account."""
    return 1 if isinstance(client, AdministratorStorage) else PURGE_BATCH


def purge_rows(connection, database, rows, client=None):
    """Process one bounded wave, never holding the database write lock across a cloud call."""
    from .server import configured_storage, delete_remote_attachment

    client = configured_storage(database) if client is None else client
    batch = mark_purge_batch(connection, rows, purge_batch_limit(client))
    if not batch:
        return [], [], set()
    with ThreadPoolExecutor(max_workers=len(batch)) as pool:
        outcomes = list(pool.map(lambda row: delete_remote_attachment(database, row, client), batch))
    cleared, rooms = confirm_purges(connection, database, [row for row, ok in zip(batch, outcomes) if ok])
    return cleared, [row["id"] for row, ok in zip(batch, outcomes) if not ok], rooms


def recycled_files(connection, roots=None):
    """Collect live cloud objects in the specified recycled groups."""
    where = "WHERE cleared_at IS NULL AND trashed_at IS NOT NULL"
    if roots is not None:
        return {row["id"]: row for root in roots for row in connection.execute(
            f"SELECT * FROM cloud_files {where} AND trash_root=?", (root,))}
    return {row["id"]: row for row in connection.execute(f"SELECT * FROM cloud_files {where}")}


def remove_empty_trash_groups(connection, roots):
    """Remove only selected recycled folders whose last remote object has been cleared."""
    for root in roots:
        if not connection.execute("""SELECT 1 FROM cloud_files
                WHERE trash_root=? AND cleared_at IS NULL LIMIT 1""", (root,)).fetchone():
            connection.execute("DELETE FROM cloud_folders WHERE trash_root=?", (root,))


def delete_response(handler, connection, outcome, trashed=(), remaining=0):
    """Return confirmed purges, exposing the failed IDs without rolling back remote deletions."""
    database = handler.server.database
    cleared, failed, rooms = outcome
    result = {"trashed": list(trashed), "cleared": [row["id"] for row in cleared],
              "freed_bytes": sum(row["size"] for row in cleared), "remaining": remaining,
              **usage(connection, database)}
    connection.commit()
    for room in rooms:
        handler.server.hub.notify_update(room)
    if failed:
        result.update(error_body(Text("部分云盘文件未能删除，请重试")), failed=failed)
    return handler.respond(result, 503 if failed else 200)


def purge_groups(handler, connection, roots, rows):
    """Purge a bounded group and keep its folder metadata until its last object is gone."""
    outcome = purge_rows(connection, handler.server.database, rows)
    with connection:
        begin_write(connection)
        remove_empty_trash_groups(connection, roots)
    remaining = sum(row["cleared_at"] is None for row in rows.values()) - len(outcome[0])
    return delete_response(handler, connection, outcome, remaining=max(0, remaining))


def delete(handler, connection, payload):
    """Recycle drive entries and request immediate deletion for attachments and transfers."""
    permanent = payload.get("permanent", False)
    if type(permanent) is not bool:
        raise ValueError(Text("云盘项目类型无效"))
    rows, groups = files_and_folders_to_delete(connection, payload, permanent)
    now = utc_now()
    keep = {identifier for identifier, row in rows.items() if "purpose" in row.keys() and row["purpose"] == "keep"}
    grouped = trash_folders(connection, {root: tree for root, tree in groups.items() if tree is not None}, now)
    recycled = [key for key in rows if key in keep and key not in grouped
                and rows[key]["trash_root"] is None and rows[key]["cleared_at"] is None]
    connection.executemany("UPDATE cloud_files SET trashed_at=?,trash_root=id WHERE id=?",
                           ((now, identifier) for identifier in recycled))
    if permanent:
        rows.update(recycled_files(connection, [*groups, *recycled]))
        return purge_groups(handler, connection, groups, rows)
    immediate = {key: row for key, row in rows.items() if key not in keep}
    outcome = purge_rows(connection, handler.server.database, immediate)
    remaining = sum(row["cleared_at"] is None for row in immediate.values()) - len(outcome[0])
    return delete_response(handler, connection, outcome, list(groups) + recycled, remaining=max(0, remaining))


def original_target(connection, identifier):
    """Keep the original location if it is still active; otherwise use the root."""
    if identifier is None:
        return None
    row = connection.execute("SELECT trashed_at FROM cloud_folders WHERE id=?", (identifier,)).fetchone()
    return identifier if row and row["trashed_at"] is None else None


def restore_subtree(connection, row, target, depth, root):
    """Restore one recycled subtree, merging into the active folder with the same name."""
    check_depth(depth)
    identifier = row["id"]
    duplicate = same_named_folder(connection, target, row["name"])
    if duplicate is None:
        placed = identifier
        connection.execute("""UPDATE cloud_folders SET parent_id=?,trashed_at=NULL,trash_root=NULL WHERE id=?""",
                           (target, identifier))
    else:
        placed = duplicate["id"]
    connection.execute("""UPDATE cloud_files SET folder_id=?,trashed_at=NULL,trash_root=NULL
        WHERE folder_id=? AND trash_root=? AND cleared_at IS NULL""", (placed, identifier, root))
    children = connection.execute("SELECT * FROM cloud_folders WHERE parent_id=? AND trash_root=?",
                                  (identifier, root)).fetchall()
    for child in children:
        restore_subtree(connection, child, placed, depth + 1, root)
    if duplicate is not None:
        connection.execute("DELETE FROM cloud_folders WHERE id=?", (identifier,))


def restore(connection, payload):
    """Restore complete recycle groups and individually recycled files."""
    files, folders = selected_ids(payload)
    for identifier in files + folders:
        if connection.execute("""SELECT 1 FROM cloud_files WHERE trash_root=?
                AND purge_started=1 AND cleared_at IS NULL LIMIT 1""", (identifier,)).fetchone():
            raise FileExistsError(Text("该项目已开始彻底删除，无法还原"))
    for identifier in folders:
        row = folder_row(connection, identifier, trashed=True)
        if row["trash_root"] != identifier:
            raise LookupError(Text("找不到云盘文件夹 {id}", id=identifier))
        target = original_target(connection, row["parent_id"])
        restore_subtree(connection, row, target, len(folder_chain(connection, target)) + 1, identifier)
    for identifier in files:
        row = connection.execute("""SELECT * FROM cloud_files
            WHERE id=? AND trash_root=id AND cleared_at IS NULL""", (identifier,)).fetchone()
        if row is None:
            raise LookupError(Text("找不到可操作的云盘文件 {id}", id=identifier))
        target = original_target(connection, row["folder_id"])
        connection.execute("UPDATE cloud_files SET folder_id=?,trashed_at=NULL,trash_root=NULL WHERE id=?",
                           (target, identifier))
    return {"restored": files + folders}


def sweep_trash(connection, database):
    """Sweep expired and uncertain purges in bounded batches, retrying failures next time."""
    from .server import configured_storage

    client = configured_storage(database)
    limit = purge_batch_limit(client)
    cutoff = (datetime.now(timezone.utc) - TRASH_TTL).isoformat(timespec="seconds")
    roots = [row[0] for row in connection.execute("""SELECT id FROM cloud_folders
        WHERE trash_root=id AND trashed_at<=? UNION SELECT DISTINCT trash_root FROM cloud_files
        WHERE trashed_at IS NOT NULL AND cleared_at IS NULL AND (trashed_at<=? OR purge_started=1)""",
        (cutoff, cutoff))]
    for root in roots:
        candidates = list(recycled_files(connection, [root]))
        for offset in range(0, len(candidates), limit):
            begin_write(connection)
            rows = {}
            for key in candidates[offset:offset + limit]:
                row = connection.execute("""SELECT * FROM cloud_files WHERE id=? AND trash_root=?
                    AND cleared_at IS NULL AND (trashed_at<=? OR purge_started=1)""", (key, root, cutoff)).fetchone()
                if row is not None:
                    rows[key] = row
            purge_rows(connection, database, rows, client)
        with connection:
            begin_write(connection)
            remove_empty_trash_groups(connection, [root])


def thumbnail_path(database, identifier):
    """Keep previews beside room thumbnails but in a disjoint namespace."""
    from .server import attachment_path, THUMBNAIL_SUFFIX

    return attachment_path(database, {"id": f"cloud-{identifier}{THUMBNAIL_SUFFIX}"})


def thumbnail_data(handler):
    """Accept raw image bytes, or a bounded base64 envelope for the paired JSON transport."""
    invalid = Text("缩略图不符合要求")
    if handler.headers.get("Content-Type", "").split(";")[0] == "application/json":
        payload = handler.read_payload(limit=(THUMBNAIL_MAX_BYTES + 2) // 3 * 4 + 128)
        try:
            data = base64.b64decode(payload.get("data", ""), validate=True)
        except (binascii.Error, ValueError, TypeError) as error:
            raise ValueError(invalid) from error
    else:
        length = int(handler.headers.get("Content-Length", "0"))
        if not 0 < length <= THUMBNAIL_MAX_BYTES:
            raise ValueError(invalid)
        data = handler.rfile.read(length)
    if not 0 < len(data) <= THUMBNAIL_MAX_BYTES:
        raise ValueError(invalid)
    return data


def thumbnail(handler, connection, method, identifier):
    """Serve or accept a preview only for a completed direct upload."""
    from .server import attachment_content_type, cloud_file_view, image_size

    data = thumbnail_data(handler) if method == "POST" else None
    if data is not None:
        begin_write(connection)
    row = live_file(connection, identifier, keep=True)
    if row["source_kind"] != "upload":
        raise LookupError(Text("附件不存在"))
    path = thumbnail_path(handler.server.database, identifier)
    if data is None:
        if row["thumbnail_type"] is None:
            raise LookupError(Text("附件不存在"))
        try:
            data = path.read_bytes()
        except FileNotFoundError:
            raise LookupError(Text("附件不存在")) from None
        return handler.send_file(path, row["thumbnail_type"], row["file_name"], "inline", data=data)
    content_type = attachment_content_type(data)
    width, height = image_size(io.BytesIO(data))
    if content_type not in THUMBNAIL_TYPES or not 0 < min(width, height) <= max(width, height) <= THUMBNAIL_MAX_SIDE:
        raise ValueError(Text("缩略图不符合要求"))
    if not row["thumbnail_type"] or not path.is_file():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        connection.execute("UPDATE cloud_files SET thumbnail_type=? WHERE id=?", (content_type, identifier))
    return handler.respond({"cloud_file": cloud_file_view(connection, live_file(connection, identifier))})


def upload(handler, connection, route):
    """Reserve or confirm an account file, creating relative folders in the reservation transaction."""
    from .server import get_cloud_file, object_upload_metadata

    payload = handler.read_payload()
    if route != ["upload"]:
        row = get_cloud_file(connection, route[0])
        if row["room_id"] is not None or row["source_kind"] != "upload":
            raise LookupError(Text("附件不存在"))
        return handler.complete_cloud_file_upload(connection, row)
    metadata = object_upload_metadata(payload, "用户")
    metadata.update(source_kind="upload", source_ref=validate_name(metadata["file_name"]))
    begin_write(connection)
    existing = connection.execute("""SELECT folder_id FROM cloud_files WHERE room_id IS NULL
        AND source_kind='upload' AND submission_id=?""", (metadata["submission_id"],)).fetchone()
    metadata["folder_id"] = (resolve_path(connection, target_folder(connection, payload.get("folder_id")),
                                          payload.get("relative_dir", "")) if existing is None else existing["folder_id"])
    return handler.start_cloud_file_upload(connection, None, metadata)


def handle(handler, connection, route, method):
    """Dispatch the account-only drive routes while leaving shares on their existing handler."""
    from .server import get_cloud_file, stored_object_download

    handler.require_cloud_account(connection)
    database = handler.server.database
    if method == "GET" and not route:
        return handler.respond(list_entries(connection, database, handler.request_params))
    if len(route) == 2 and route[1] == "thumbnail" and method in ("GET", "POST"):
        return thumbnail(handler, connection, method, route[0])
    if method == "GET" and len(route) == 2 and route[1] == "content":
        identifier = record_id(route[0])
        row = connection.execute("SELECT * FROM attachments WHERE id=? AND storage='object' AND object_name IS NOT NULL",
                                 (identifier,)).fetchone()
        return handler.respond_cloud_link(stored_object_download(database, row if row is not None
                                                                 else get_cloud_file(connection, identifier)))
    if method != "POST":
        raise LookupError(Text("地址不存在"))
    if route == ["upload"] or len(route) == 2 and route[1] == "complete":
        return upload(handler, connection, route)
    payload = ({} if route == ["trash", "empty"] and not int(handler.headers.get("Content-Length", "0"))
               else handler.read_payload())
    begin_write(connection)
    if route == ["delete"]:
        return delete(handler, connection, payload)
    if route == ["trash", "empty"]:
        roots = [row[0] for row in connection.execute("SELECT id FROM cloud_folders WHERE trash_root=id")]
        return purge_groups(handler, connection, roots, recycled_files(connection))
    action = {"folders": create_folder, "rename": rename, "move": move, "restore": restore}
    if len(route) == 1 and route[0] in action:
        return handler.respond(action[route[0]](connection, payload))
    raise LookupError(Text("地址不存在"))

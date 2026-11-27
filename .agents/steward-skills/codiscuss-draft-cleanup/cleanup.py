"""Preview or remove an explicitly selected CoDiscuss storage candidate."""
import argparse
import hashlib
import os
import shutil
import stat
from pathlib import Path

from scan import active_root, add_root_arguments, runtime_log, service_home, unredirected, workflow_backup


def digest(stream):
    """Hash without loading a large archive into memory (Python 3.10+)."""
    result = hashlib.sha256()
    for block in iter(lambda: stream.read(1024 * 1024), b''):
        result.update(block)
    return result.digest()


def archive(root, value):
    """Resolve a relative archive path without traversing any redirected component."""
    rel = Path(value)
    if rel.anchor or '..' in rel.parts or ':' in value or len(rel.parts) < 3:
        raise ValueError("Expected a room/member-relative path under drafts")
    path = unredirected(root / rel)
    if not path.is_file() or path.suffix.lower() not in {'.tar', '.zip', '.tgz'}:
        raise ValueError("Expected a regular archive")
    return path


def signature(path):
    """Capture identity, length, timestamps and link count for a final consistency check."""
    info = path.stat()
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_nlink


def clean_archive(args):
    """Delete only after comparing the exact named files; return observed free-space delta."""
    root = active_root(args)
    keep, drop = [archive(root, name) for name in (args.keep, args.drop)]
    before = [signature(p) for p in (keep, drop)]
    if keep.samefile(drop) or before[0][2] != before[1][2] or before[1][-1] != 1:
        raise ValueError("Expected independent files of equal length with one link to the candidate")
    with keep.open('rb') as retained, drop.open('rb') as candidate:
        if digest(retained) != digest(candidate):
            raise ValueError("Different content")
    for index, name in enumerate((args.keep, args.drop)):
        if signature(archive(root, name)) != before[index]:
            raise ValueError("File changed during verification")
    print(f"keep={keep}\ndrop={drop}\nlogical_bytes={before[1][2]}")
    if args.apply:
        free = shutil.disk_usage(root).free
        drop.unlink()
        if drop.exists() or signature(keep) != before[0]:
            raise RuntimeError("Post-cleanup verification failed")
        print(f"removed=1 free_space_delta={shutil.disk_usage(root).free - free}")
    else:
        print("preview only")


def candidate_file(args):
    """Resolve one explicit log or workflow backup file under its fixed root."""
    home = service_home(args)
    value = args.log if args.log is not None else args.workflow_backup
    relative = Path(value)
    if relative.anchor or ".." in relative.parts or ":" in value:
        raise ValueError("Expected a relative path inside the selected root / 需要清理根目录内的相对路径")
    if args.log is not None and not runtime_log(relative):
        raise ValueError("Expected a launch runtime log / 只允许启动运行目录内的日志")
    if args.workflow_backup is not None and not workflow_backup(relative):
        raise ValueError("Expected a workflow backup file / 只允许工作流备份文件")
    root = home / ("launches" if args.log is not None else "backups")
    path = unredirected(root / relative)
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise ValueError("Expected a regular file with one link / 只允许无额外硬链接的普通文件")
    lock = root / relative.parts[0] / "runtime" / "runner.lock" if args.log is not None else None
    return path, lock


def ensure_inactive(lock):
    """Refuse live or uncertain launch ownership, including stale lock files."""
    if lock is None:
        return
    try:
        lock.lstat()
    except FileNotFoundError:
        return
    raise ValueError("Launch has a runner lock; keep its logs / 启动存在运行锁，保留日志")


def remove_candidate(path, before):
    """Unlink the exact file only if no component or file identity changed."""
    if signature(unredirected(path)) != before:
        raise ValueError("File changed during verification / 验证期间文件已变化")
    path.unlink()


def clean_candidate(args):
    """Preview by default; exclude a runner from the runtime while removing a log."""
    path, lock = candidate_file(args)
    ensure_inactive(lock)
    before = signature(path)
    print(f"drop={path}\nlogical_bytes={before[2]}")
    if not args.apply:
        print("preview only / 仅预览")
        return
    if lock is None:
        remove_candidate(path, before)
    else:
        with lock.open("x", encoding="ascii") as stream:
            stream.write(str(os.getpid()))
        try:
            remove_candidate(path, before)
        finally:
            lock.unlink()
    print("removed=1")


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    add_root_arguments(parser)
    choices = parser.add_mutually_exclusive_group(required=True)
    choices.add_argument('--drop', help='Duplicate archive path relative to drafts; requires --keep')
    choices.add_argument('--log', help='One log path relative to the launches directory')
    choices.add_argument('--workflow-backup', help='One file path relative to the backups directory')
    parser.add_argument('--keep', help='Retained archive path relative to drafts')
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    if (args.drop is not None) != (args.keep is not None):
        parser.error("Use --drop and --keep together / --drop 与 --keep 必须成对使用")
    try:
        if args.drop is not None:
            clean_archive(args)
        else:
            clean_candidate(args)
    except (OSError, ValueError, RuntimeError) as error:
        parser.error(str(error))

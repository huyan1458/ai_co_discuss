"""Inventory CoDiscuss storage without modifying files."""
import argparse
import json
import os
import stat
import sys
from collections import Counter
from pathlib import Path

REPARSE_POINT = 0x400
SPEECH_PROGRAMS = ("yovoice", "crispasr")


def add_root_arguments(parser):
    """Accept the account's service home and its optional exact drafts root."""
    parser.add_argument("--drafts-root", type=Path, help="Exact drafts_root from service status")
    parser.add_argument("--home", type=Path, help="Exact service home from service status")


def redirected(info):
    """Recognize symbolic links and Windows reparse points."""
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, "st_file_attributes", 0) & REPARSE_POINT)


def unredirected(path):
    """Reject redirected components from the filesystem root through this path."""
    for part in (*reversed(path.parents), path):
        if redirected(part.lstat()):
            raise ValueError(f"Redirected path / 重定向路径: {part}")
    return path


def service_home(args):
    """Resolve the explicitly selected account's home."""
    if args.home is None or not args.home.is_absolute() or ".." in args.home.parts:
        raise ValueError("Expected an absolute service home / 需要服务目录绝对路径")
    home = args.home.resolve(strict=True)
    if not home.is_dir():
        raise ValueError("Service home unavailable / 服务目录不可用")
    return home


def active_root(args):
    """Use the exact draft path, resolving the legacy layout if necessary."""
    root = args.drafts_root
    if root is None:
        home = service_home(args)
        settings = home / "local-settings.json"
        config = json.loads(settings.read_text(encoding="utf-8-sig")) if settings.is_file() else {}
        root = Path(config.get("project_data_root") or home) / "drafts"
    if not root.is_absolute() or root.name.lower() != "drafts" or ".." in root.parts:
        raise ValueError("Expected the absolute, unredirected drafts directory / 需要未重定向的草稿目录绝对路径")
    return root


def scan(root, group_file):
    """Return logical sizes by group and the number of unreadable entries."""
    sizes = Counter()
    pending = [root]
    errors = 0
    while pending:
        folder = pending.pop()
        try:
            with os.scandir(folder) as entries:
                for entry in entries:
                    try:
                        info = entry.stat(follow_symlinks=False)
                        if redirected(info):
                            continue
                        path = Path(entry.path)
                        if stat.S_ISDIR(info.st_mode):
                            pending.append(path)
                        elif stat.S_ISREG(info.st_mode):
                            group = group_file(path.relative_to(root))
                            if group is not None:
                                sizes[group] += info.st_size
                    except OSError:
                        errors += 1
        except OSError:
            errors += 1
    return sizes, errors


def draft_group(relative):
    """Group drafts by room and member, separating per-execution scratch."""
    parts = relative.parts
    group = parts[:4] if parts[2:3] == (".scratch",) else (*parts[:2], "legacy")
    return "/".join(group)


def runtime_log(relative):
    """Match a log inside one launch runtime; exclude task JSON and credentials."""
    return len(relative.parts) >= 3 and relative.parts[1] == "runtime" and relative.suffix.lower() == ".log"


def workflow_backup(relative):
    """Recognize files inside a workflow backup, not other backup types."""
    return len(relative.parts) >= 2 and relative.parts[0].startswith("workflow-")


def speech_roots(home):
    """Yield active and legacy speech directories, as the admin panel does."""
    for program in SPEECH_PROGRAMS:
        marker = home / f"{program}-root.txt"
        try:
            parent = unredirected(marker).read_text(encoding="utf-8-sig").strip()
        except FileNotFoundError:
            parent = ""
        except (OSError, ValueError) as error:
            print(error, file=sys.stderr)
            parent = ""
        if parent and (not Path(parent).is_absolute() or ".." in Path(parent).parts):
            print(f"Invalid model parent / 语音模型位置无效: {marker}", file=sys.stderr)
            parent = ""
        yield from dict.fromkeys([Path(parent or home) / program, home / program])


def storage_roots(home):
    """Yield the account's remaining CoDiscuss roots and grouping rules."""
    yield "logs", home / "launches", lambda rel: rel.parts[0] if runtime_log(rel) else None
    yield "workflow-backups", home / "backups", lambda rel: rel.parts[0] if workflow_backup(rel) else None
    yield "attachments", home / "local" / "discuss.sqlite3.attachments", lambda _: "."
    for root in speech_roots(home):
        yield "speech", root, lambda _: "."


def report(category, root, group_file):
    """Print one category's root, logical total and subdivisions."""
    print(category, root, sep="\t")
    try:
        unredirected(root)
    except FileNotFoundError:
        print("total_bytes=0")
        return 0
    except (OSError, ValueError) as error:
        print(error, file=sys.stderr)
        return 1
    sizes, errors = scan(root, group_file)
    print(f"total_bytes={sum(sizes.values())}")
    for group, total in sizes.most_common():
        print(total, group, sep="\t")
    return errors


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    add_root_arguments(parser)
    args = parser.parse_args()
    try:
        home = service_home(args) if args.home is not None else None
        errors = report("drafts", active_root(args), draft_group)
        if home is not None:
            errors += sum(report(*entry) for entry in storage_roots(home))
    except (OSError, ValueError) as error:
        parser.error(str(error))
    print("Unreadable entries / 不可读条目:", errors, file=sys.stderr)

"""Report per-member draft and per-execution scratch usage without modifying files."""
import argparse
import json
import os
import stat
import sys
from collections import Counter
from pathlib import Path


def add_root_arguments(parser):
    """Accept the reported drafts root or a legacy service home."""
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--drafts-root", type=Path, help="Exact drafts_root from service status")
    group.add_argument("--home", type=Path, help="Service home for older installations")


def active_root(args):
    """Resolve a legacy service home once and reject redirects in the chosen draft path."""
    root = args.drafts_root
    if root is None:
        if not args.home.is_absolute():
            raise ValueError("Expected an absolute service home")
        home = args.home.resolve(strict=True)
        settings = home / "local-settings.json"
        config = json.loads(settings.read_text(encoding="utf-8-sig")) if settings.is_file() else {}
        root = Path(config.get("project_data_root") or home) / "drafts"
    if not root.is_absolute() or root.name.lower() != "drafts" or root.resolve(strict=True) != root:
        raise ValueError("Expected the absolute, unredirected drafts directory")
    if not root.is_dir():
        raise ValueError("Draft directory unavailable")
    return root


def scan(root):
    """Return logical sizes by group and the number of inaccessible entries."""
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
                        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 1024:
                            continue
                        path = Path(entry.path)
                        if stat.S_ISDIR(info.st_mode):
                            pending.append(path)
                        elif stat.S_ISREG(info.st_mode):
                            parts = path.relative_to(root).parts
                            group = parts[:4] if parts[2:3] == (".scratch",) else (*parts[:2], "legacy")
                            sizes["/".join(group)] += info.st_size
                    except OSError:
                        errors += 1
        except OSError:
            errors += 1
    return sizes, errors


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    add_root_arguments(parser)
    root = active_root(parser.parse_args())
    sizes, errors = scan(root)
    for group, total in sizes.most_common():
        print(total, group, sep="\t")
    print("Unreadable entries:", errors, file=sys.stderr)

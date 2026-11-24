"""Preview or remove one verified duplicate archive under the current user's drafts."""
import argparse
import hashlib
import shutil
import stat
from pathlib import Path

from scan import active_root, add_root_arguments


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
    path = root / rel
    for part in (path, *path.parents):
        info = part.lstat()
        if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 1024:
            raise ValueError(f"Redirected path: {part}")
    if not path.is_file() or path.suffix.lower() not in {'.tar', '.zip', '.tgz'}:
        raise ValueError("Expected a regular archive")
    return path


def signature(path):
    """Capture identity, length, timestamps and link count for a final consistency check."""
    info = path.stat()
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_nlink


def clean(args):
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


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    add_root_arguments(parser)
    parser.add_argument('--keep', required=True)
    parser.add_argument('--drop', required=True)
    parser.add_argument('--apply', action='store_true')
    clean(parser.parse_args())

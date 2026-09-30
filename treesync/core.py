"""One-way synchronization of small file trees with journaled batches.

Fingerprint = sha256 + size + mtime_ns. Identical content (sha256+size) at a
different path is treated as a rename. Every batch of at most BATCH_SIZE ops
is written to a journal file before execution; each op is fsynced and marked
done individually so a crash can be resumed. Copies go through a temporary
file that is renamed into place; leftover temporaries are cleaned on startup.
"""
from __future__ import annotations

import hashlib
import json
import os
import signal
from collections import defaultdict

BATCH_SIZE = 64
TEMP_SUFFIX = ".treesync.tmp"
DEFAULT_STATE_NAME = ".treesync_state"
STATE_VERSION = 1


class SyncError(Exception):
    """Fatal sync error (bad arguments, unreadable trees, ...)."""


class ConflictError(Exception):
    """DST contains foreign entries that sync refuses to touch."""

    def __init__(self, conflicts):
        self.conflicts = sorted(conflicts)
        super().__init__(
            "conflict: %d foreign entr%s in destination"
            % (len(self.conflicts), "y" if len(self.conflicts) == 1 else "ies")
        )


def fingerprint_file(path):
    st = os.stat(path)
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 16), b""):
            digest.update(chunk)
    return {"sha256": digest.hexdigest(), "size": st.st_size, "mtime_ns": st.st_mtime_ns}


def _relpath(root, full):
    return os.path.relpath(full, root).replace(os.sep, "/")


def scan_tree(root, exclude=()):
    excluded = {os.path.abspath(p) for p in exclude}
    files = {}
    dirs = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        for name in sorted(filenames):
            full = os.path.join(dirpath, name)
            if os.path.islink(full) or name.endswith(TEMP_SUFFIX):
                continue
            if os.path.abspath(full) in excluded:
                continue
            files[_relpath(root, full)] = fingerprint_file(full)
        for name in dirnames:
            full = os.path.join(dirpath, name)
            if os.path.islink(full):
                continue
            dirs.append(_relpath(root, full))
    return files, sorted(dirs)


def _fsync_dir(path):
    fd = os.open(path or ".", os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _atomic_write_json(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, indent=1, sort_keys=True)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)
    _fsync_dir(os.path.dirname(os.path.abspath(path)))


def _load_state(state_path):
    if not os.path.exists(state_path):
        return {"version": STATE_VERSION, "files": {}, "dirs": []}
    with open(state_path, encoding="utf-8") as fh:
        return json.load(fh)


def _copy_file(src, dst, mtime_ns):
    tmp = dst + TEMP_SUFFIX
    with open(src, "rb") as fh:
        data = fh.read()
    if os.environ.get("TREESYNC_TEST_CRASH_IN_COPY"):
        with open(tmp, "wb") as fh:
            fh.write(data[: max(1, len(data) // 2)])
            fh.flush()
            os.fsync(fh.fileno())
        os.kill(os.getpid(), signal.SIGKILL)
    with open(tmp, "wb") as fh:
        fh.write(data)
        fh.flush()
        os.fsync(fh.fileno())
    os.utime(tmp, ns=(mtime_ns, mtime_ns))
    os.replace(tmp, dst)
    _fsync_dir(os.path.dirname(tmp))


def _execute_op(op, src_root, dst_root):
    kind = op["op"]
    if kind == "mkdir":
        os.makedirs(os.path.join(dst_root, op["path"]), exist_ok=True)
    elif kind == "copy":
        _copy_file(
            os.path.join(src_root, op["src"]),
            os.path.join(dst_root, op["dst"]),
            op["mtime_ns"],
        )
    elif kind == "rename":
        old = os.path.join(dst_root, op["old"])
        new = os.path.join(dst_root, op["new"])
        if os.path.lexists(old):
            os.rename(old, new)
        if os.path.lexists(new):
            os.utime(new, ns=(op["mtime_ns"], op["mtime_ns"]))
        _fsync_dir(os.path.dirname(old))
        if os.path.dirname(new) != os.path.dirname(old):
            _fsync_dir(os.path.dirname(new))
    elif kind == "delete":
        target = os.path.join(dst_root, op["path"])
        if os.path.lexists(target):
            os.remove(target)
        _fsync_dir(os.path.dirname(target))
    elif kind == "rmdir":
        target = os.path.join(dst_root, op["path"])
        try:
            os.rmdir(target)
        except FileNotFoundError:
            pass
        _fsync_dir(os.path.dirname(target))
    else:
        raise SyncError("unknown op: %r" % kind)


def _run_ops(ops, src_root, dst_root, journal_path):
    data = {
        "version": STATE_VERSION,
        "src": os.path.abspath(src_root),
        "dst": os.path.abspath(dst_root),
        "ops": [dict(op, done=False) for op in ops],
    }
    _atomic_write_json(journal_path, data)
    kill_after = os.environ.get("TREESYNC_TEST_KILL_AFTER_OP")
    executed = 0
    for op in data["ops"]:
        _execute_op(op, src_root, dst_root)
        if kill_after is not None and executed == int(kill_after):
            os.kill(os.getpid(), signal.SIGKILL)
        op["done"] = True
        _atomic_write_json(journal_path, data)
        executed += 1
    os.remove(journal_path)
    _fsync_dir(os.path.dirname(os.path.abspath(journal_path)))


def _resume_journal(journal_path):
    with open(journal_path, encoding="utf-8") as fh:
        data = json.load(fh)
    src_root, dst_root = data["src"], data["dst"]
    resumed = 0
    for op in data["ops"]:
        if op.get("done"):
            continue
        _execute_op(op, src_root, dst_root)
        op["done"] = True
        _atomic_write_json(journal_path, data)
        resumed += 1
    os.remove(journal_path)
    _fsync_dir(os.path.dirname(os.path.abspath(journal_path)))
    return resumed


def _clean_temp_files(dst_root):
    removed = []
    for dirpath, _dirnames, filenames in os.walk(dst_root):
        for name in sorted(filenames):
            if name.endswith(TEMP_SUFFIX):
                full = os.path.join(dirpath, name)
                os.remove(full)
                removed.append(_relpath(dst_root, full))
    return removed


def compute_plan(src_files, src_dirs, dst_files, dst_dirs, prev_state):
    prev_files = prev_state.get("files", {})
    prev_dirs = set(prev_state.get("dirs", []))
    src_dir_set = set(src_dirs)
    dst_dir_set = set(dst_dirs)

    conflicts = []
    for path in sorted(dst_files):
        if path in src_dir_set:
            if path not in prev_files:
                conflicts.append(path)
            continue
        if path not in src_files:
            if path not in prev_files:
                conflicts.append(path)
        elif path not in prev_files and dst_files[path] != src_files[path]:
            conflicts.append(path)
    for path in dst_dirs:
        if path in src_files and path not in prev_dirs:
            conflicts.append(path)
    if conflicts:
        return None, sorted(conflicts)

    blocking_files = [d for d in src_dirs if d in dst_files]
    blocking_dirs = [f for f in src_files if f in dst_dir_set]

    def under_blocking_dir(path):
        return any(path.startswith(b + "/") for b in blocking_dirs)

    early_deletes = sorted(
        set(blocking_files)
        | {p for p in dst_files if under_blocking_dir(p)}
    )

    delete_candidates = {
        p: dst_files[p]
        for p in dst_files
        if p not in src_files and p not in early_deletes and p not in src_dir_set
    }
    create_candidates = {p: src_files[p] for p in src_files if p not in dst_files}

    pool = defaultdict(list)
    for path in sorted(delete_candidates):
        fp = delete_candidates[path]
        pool[(fp["sha256"], fp["size"])].append(path)
    renames = []
    for path in sorted(create_candidates):
        fp = create_candidates[path]
        key = (fp["sha256"], fp["size"])
        if pool.get(key):
            renames.append((pool[key].pop(0), path))
    renamed_olds = {old for old, _ in renames}
    renamed_news = {new for _, new in renames}

    ops = []
    for path in early_deletes:
        ops.append({"op": "delete", "path": path})
    for path in sorted(blocking_dirs, key=lambda p: (-p.count("/"), p)):
        ops.append({"op": "rmdir", "path": path})
    new_dirs = [d for d in src_dirs if d not in dst_dir_set]
    for path in sorted(new_dirs, key=lambda p: (p.count("/"), p)):
        ops.append({"op": "mkdir", "path": path})
    for old, new in renames:
        ops.append(
            {
                "op": "rename",
                "src": new,
                "old": old,
                "new": new,
                "mtime_ns": src_files[new]["mtime_ns"],
            }
        )
    for path in sorted(create_candidates):
        if path in renamed_news:
            continue
        ops.append(
            {
                "op": "copy",
                "src": path,
                "dst": path,
                "mtime_ns": src_files[path]["mtime_ns"],
            }
        )
    for path in sorted(src_files):
        if path in dst_files and src_files[path] != dst_files[path]:
            ops.append(
                {
                    "op": "copy",
                    "src": path,
                    "dst": path,
                    "mtime_ns": src_files[path]["mtime_ns"],
                }
            )
    for path in sorted(delete_candidates):
        if path not in renamed_olds:
            ops.append({"op": "delete", "path": path})
    gone_dirs = [
        d
        for d in dst_dirs
        if d in prev_dirs and d not in src_dir_set and d not in blocking_dirs
    ]
    for path in sorted(gone_dirs, key=lambda p: (-p.count("/"), p)):
        ops.append({"op": "rmdir", "path": path})
    return ops, []


def sync(src_root, dst_root, state_path):
    src_root = os.path.abspath(src_root)
    dst_root = os.path.abspath(dst_root)
    state_path = os.path.abspath(state_path)
    if not os.path.isdir(src_root):
        raise SyncError("source tree does not exist: %s" % src_root)
    os.makedirs(dst_root, exist_ok=True)
    journal_path = state_path + ".journal"

    resumed = 0
    if os.path.exists(journal_path):
        resumed = _resume_journal(journal_path)
    cleaned = _clean_temp_files(dst_root)

    prev_state = _load_state(state_path)
    exclude = [state_path, journal_path, state_path + ".tmp", journal_path + ".tmp"]
    src_files, src_dirs = scan_tree(src_root)
    dst_files, dst_dirs = scan_tree(dst_root, exclude=exclude)

    ops, conflicts = compute_plan(src_files, src_dirs, dst_files, dst_dirs, prev_state)
    if conflicts:
        raise ConflictError(conflicts)

    batches = [ops[i : i + BATCH_SIZE] for i in range(0, len(ops), BATCH_SIZE)]
    for batch in batches:
        _run_ops(batch, src_root, dst_root, journal_path)

    _atomic_write_json(
        state_path,
        {"version": STATE_VERSION, "files": src_files, "dirs": src_dirs},
    )
    return {
        "resumed": resumed,
        "cleaned_temp": cleaned,
        "ops": ops,
        "batches": len(batches),
        "applied": len(ops),
    }

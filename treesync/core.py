"""treesync core: one-way sync of small file trees.

Durability model:
  * Operations are grouped into batches of at most BATCH_SIZE.
  * Before a batch runs, its plan is written to a journal file
    (``<state>.journal``) and fsynced.
  * After every single op the journal is rewritten with the op marked
    done and fsynced again.
  * File copies go to a temporary file inside ``<dst>/.treesync_tmp``
    and are atomically os.replace()d into place, then the parent
    directory is fsynced.
  * On startup any leftover journal is replayed (ops are idempotent)
    and half-finished temporary files are removed.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import time
from collections import defaultdict

STATE_DEFAULT_NAME = ".treesync_state"
TMP_DIR_NAME = ".treesync_tmp"
JOURNAL_SUFFIX = ".journal"
BATCH_SIZE = 64
STATE_VERSION = 1

COPY = "copy"
RENAME = "rename"
DELETE = "delete"
MKDIR = "mkdir"


class ConflictError(Exception):
    """DST holds entries that the previous state cannot prove came from SRC."""

    def __init__(self, conflicts):
        self.conflicts = sorted(conflicts)
        super().__init__(
            "conflict: %d foreign entr%s in destination: %s"
            % (
                len(self.conflicts),
                "y" if len(self.conflicts) == 1 else "ies",
                ", ".join(self.conflicts),
            )
        )


# ---------------------------------------------------------------------------
# low level helpers


def _op_delay() -> float:
    """Artificial per-op/per-chunk delay, used by crash-recovery tests."""
    try:
        return float(os.environ.get("TREESYNC_OP_DELAY", "0") or 0)
    except ValueError:
        return 0.0


def _hash_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _fsync_dir(path: str) -> None:
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _atomic_write_json(path: str, obj) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=2, sort_keys=True)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)
    _fsync_dir(os.path.dirname(path) or ".")


def _is_within(path: str, root: str) -> bool:
    try:
        return os.path.commonpath([path, root]) == root
    except ValueError:
        return False


# ---------------------------------------------------------------------------
# scanning / state


def scan_tree(root: str, exclude=()) -> dict:
    """Map relpath -> {"type", ...}; files carry sha256+size+mtime_ns."""
    root = os.path.abspath(root)
    excluded = {os.path.abspath(p) for p in exclude}
    entries: dict = {}
    if not os.path.isdir(root):
        return entries
    for dirpath, dirnames, filenames in os.walk(root):
        kept = []
        for name in dirnames:
            full = os.path.join(dirpath, name)
            if full in excluded:
                continue
            kept.append(name)
            entries[os.path.relpath(full, root).replace(os.sep, "/")] = {"type": "dir"}
        dirnames[:] = kept
        for name in filenames:
            full = os.path.join(dirpath, name)
            if full in excluded:
                continue
            st = os.stat(full)
            entries[os.path.relpath(full, root).replace(os.sep, "/")] = {
                "type": "file",
                "sha256": _hash_file(full),
                "size": st.st_size,
                "mtime_ns": st.st_mtime_ns,
            }
    return entries


def _load_state(state_path: str) -> dict:
    if not os.path.exists(state_path):
        return {"version": STATE_VERSION, "entries": {}}
    with open(state_path, "r", encoding="utf-8") as f:
        state = json.load(f)
    state.setdefault("entries", {})
    return state


# ---------------------------------------------------------------------------
# planning


def compute_plan(src_entries: dict, dst_entries: dict, state_entries: dict):
    """Return (ops, conflicts).

    Fingerprint = sha256 + size + mtime_ns.  A DST file whose content
    (sha256+size) matches a SRC file at a different path, and which the
    previous state proves came from SRC, is treated as a rename instead
    of a delete+add pair.
    """
    src_files = {p: e for p, e in src_entries.items() if e["type"] == "file"}
    dst_files = {p: e for p, e in dst_entries.items() if e["type"] == "file"}
    src_dirs = {p for p, e in src_entries.items() if e["type"] == "dir"}
    dst_dirs = {p for p, e in dst_entries.items() if e["type"] == "dir"}
    tracked = set(state_entries)

    conflicts: list = []
    file_deletes: list = []
    dir_deletes: list = []
    renames: list = []  # (old_path, new_path)
    copies: list = []
    mkdirs: list = []

    # Type clashes: SRC dir where DST has a file.
    for p in sorted(src_dirs):
        if p in dst_files:
            if p in tracked:
                file_deletes.append(p)
            else:
                conflicts.append(p)

    orphan_dst_files = {
        p: e for p, e in dst_files.items() if p not in src_files and p not in src_dirs
    }

    # Rename detection: match new SRC files against tracked orphan DST
    # files by content (sha256+size).
    new_src_files = {p: e for p, e in src_files.items() if p not in dst_files}
    by_content: dict = defaultdict(list)
    for p, e in orphan_dst_files.items():
        if p in tracked:
            by_content[(e["sha256"], e["size"])].append(p)
    for key in by_content:
        by_content[key].sort()
    renamed_src: set = set()
    renamed_dst: set = set()
    for p in sorted(new_src_files):
        e = new_src_files[p]
        candidates = by_content.get((e["sha256"], e["size"]))
        if candidates:
            old = candidates.pop(0)
            renames.append((old, p))
            renamed_src.add(p)
            renamed_dst.add(old)

    # Deletes / conflicts for DST entries missing from SRC.
    for p in sorted(orphan_dst_files):
        if p in renamed_dst:
            continue
        if p in tracked:
            file_deletes.append(p)
        else:
            conflicts.append(p)
    for p in sorted(dst_dirs - src_dirs):
        if p in tracked:
            dir_deletes.append(p)
        else:
            conflicts.append(p)

    # Copies: missing or fingerprint mismatch (sha256+size+mtime_ns).
    for p in sorted(src_files):
        if p in renamed_src:
            continue
        e = src_files[p]
        d = dst_files.get(p)
        if d is None or (d["sha256"], d["size"], d["mtime_ns"]) != (
            e["sha256"],
            e["size"],
            e["mtime_ns"],
        ):
            copies.append(p)

    for p in sorted(src_dirs):
        if p not in dst_dirs:
            mkdirs.append(p)

    # Order: file deletes -> mkdirs -> renames -> dir deletes -> copies.
    # Rename sources are orphan files, so they must be moved before their
    # parent directories are removed; dir deletes go deepest first.
    dir_deletes.sort(key=lambda p: (p.count("/"), p), reverse=True)
    ops: list = []
    for p in file_deletes:
        ops.append({"op": DELETE, "type": "file", "path": p})
    for p in mkdirs:
        ops.append({"op": MKDIR, "path": p})
    for old, new in renames:
        ops.append({"op": RENAME, "from": old, "to": new})
    for p in dir_deletes:
        ops.append({"op": DELETE, "type": "dir", "path": p})
    for p in copies:
        ops.append({"op": COPY, "src": p, "dst": p})
    for i, op in enumerate(ops):
        op["id"] = i
    return ops, conflicts


# ---------------------------------------------------------------------------
# execution


def _execute_op(op: dict, src_root: str, dst_root: str, tmp_dir: str) -> None:
    kind = op["op"]
    if kind == MKDIR:
        os.makedirs(os.path.join(dst_root, op["path"]), exist_ok=True)
    elif kind == DELETE:
        target = os.path.join(dst_root, op["path"])
        if op["type"] == "dir":
            if os.path.isdir(target):
                os.rmdir(target)
        elif os.path.lexists(target):
            os.remove(target)
        parent = os.path.dirname(target)
        if os.path.isdir(parent):
            _fsync_dir(parent)
    elif kind == RENAME:
        old = os.path.join(dst_root, op["from"])
        new = os.path.join(dst_root, op["to"])
        os.makedirs(os.path.dirname(new) or dst_root, exist_ok=True)
        if os.path.lexists(old):
            os.replace(old, new)
            parent = os.path.dirname(old)
            if os.path.isdir(parent):
                _fsync_dir(parent)
        src = os.path.join(src_root, op["to"])
        if os.path.exists(src) and os.path.exists(new):
            st = os.stat(src)
            os.utime(new, ns=(st.st_atime_ns, st.st_mtime_ns))
        _fsync_dir(os.path.dirname(new) or dst_root)
    elif kind == COPY:
        src = os.path.join(src_root, op["src"])
        dst = os.path.join(dst_root, op["dst"])
        os.makedirs(os.path.dirname(dst) or dst_root, exist_ok=True)
        os.makedirs(tmp_dir, exist_ok=True)
        tmp = os.path.join(tmp_dir, "%06d.tmp" % op["id"])
        if os.path.exists(tmp):
            os.remove(tmp)
        delay = _op_delay()
        with open(src, "rb") as fin, open(tmp, "wb") as fout:
            while True:
                chunk = fin.read(1024 * 1024)
                if not chunk:
                    break
                fout.write(chunk)
                if delay:
                    time.sleep(delay)
            fout.flush()
            os.fsync(fout.fileno())
        st = os.stat(src)
        os.utime(tmp, ns=(st.st_atime_ns, st.st_mtime_ns))
        os.replace(tmp, dst)
        _fsync_dir(os.path.dirname(dst) or dst_root)
    else:  # pragma: no cover - defensive
        raise ValueError("unknown op: %r" % kind)


def _run_batch(ops: list, src_root: str, dst_root: str, tmp_dir: str, journal_path: str) -> None:
    journal = {"ops": [dict(op, done=False) for op in ops]}
    _atomic_write_json(journal_path, journal)
    delay = _op_delay()
    for entry in journal["ops"]:
        if delay:
            time.sleep(delay)
        _execute_op(entry, src_root, dst_root, tmp_dir)
        entry["done"] = True
        _atomic_write_json(journal_path, journal)
    os.remove(journal_path)
    _fsync_dir(os.path.dirname(journal_path))


def recover(src_root: str, dst_root: str, state_path: str, journal_path: str, tmp_dir: str) -> int:
    """Replay an interrupted journal and remove half-finished artifacts."""
    recovered = 0
    if os.path.exists(journal_path):
        with open(journal_path, "r", encoding="utf-8") as f:
            journal = json.load(f)
        for entry in journal.get("ops", []):
            if entry.get("done"):
                continue
            if entry["op"] == COPY and not os.path.exists(
                os.path.join(src_root, entry["src"])
            ):
                pass  # stale op: source vanished since the plan was made
            else:
                _execute_op(entry, src_root, dst_root, tmp_dir)
                recovered += 1
            entry["done"] = True
            _atomic_write_json(journal_path, journal)
        os.remove(journal_path)
        _fsync_dir(os.path.dirname(journal_path))
    if os.path.isdir(tmp_dir):
        shutil.rmtree(tmp_dir, ignore_errors=True)
        _fsync_dir(dst_root)
    for stale in (state_path + ".tmp", journal_path + ".tmp"):
        if os.path.exists(stale):
            os.remove(stale)
    return recovered


# ---------------------------------------------------------------------------
# public entry point


def sync(src: str, dst: str, state_path: str | None = None) -> dict:
    src_root = os.path.abspath(src)
    dst_root = os.path.abspath(dst)
    if not os.path.isdir(src_root):
        raise FileNotFoundError("source tree not found: %s" % src)
    if src_root == dst_root or _is_within(src_root, dst_root) or _is_within(
        dst_root, src_root
    ):
        raise ValueError("source and destination must be disjoint trees")
    os.makedirs(dst_root, exist_ok=True)
    if state_path is None:
        state_path = os.path.join(dst_root, STATE_DEFAULT_NAME)
    state_path = os.path.abspath(state_path)
    journal_path = state_path + JOURNAL_SUFFIX
    tmp_dir = os.path.join(dst_root, TMP_DIR_NAME)

    started = time.monotonic()
    recovered = recover(src_root, dst_root, state_path, journal_path, tmp_dir)

    exclude = {
        state_path,
        journal_path,
        tmp_dir,
        state_path + ".tmp",
        journal_path + ".tmp",
    }
    src_entries = scan_tree(src_root)
    dst_entries = scan_tree(dst_root, exclude)
    state = _load_state(state_path)

    ops, conflicts = compute_plan(src_entries, dst_entries, state["entries"])
    if conflicts:
        raise ConflictError(conflicts)

    batches = [ops[i : i + BATCH_SIZE] for i in range(0, len(ops), BATCH_SIZE)]
    for batch in batches:
        _run_batch(batch, src_root, dst_root, tmp_dir, journal_path)

    _atomic_write_json(
        state_path, {"version": STATE_VERSION, "entries": src_entries}
    )
    if os.path.isdir(tmp_dir):
        shutil.rmtree(tmp_dir, ignore_errors=True)

    counts = {k: 0 for k in (COPY, RENAME, DELETE, MKDIR)}
    for op in ops:
        counts[op["op"]] += 1
    return {
        "status": "ok",
        "src": src_root,
        "dst": dst_root,
        "state": state_path,
        "recovered_ops": recovered,
        "plan": {
            "op_count": len(ops),
            "batch_size": BATCH_SIZE,
            "batches": [
                {"batch": i, "ops": batch} for i, batch in enumerate(batches)
            ],
        },
        "result": {
            "applied": len(ops),
            "copies": counts[COPY],
            "renames": counts[RENAME],
            "deletes": counts[DELETE],
            "mkdirs": counts[MKDIR],
            "duration_ms": int((time.monotonic() - started) * 1000),
        },
    }

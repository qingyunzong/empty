"""hierosync: hierarchical directory snapshot versioning.

A snapshot store (SNAP directory) lives directly inside the repository root.
Each snapshot records a full manifest of the repository tree (relative path ->
{type, hash}), a parent pointer, a wall-clock timestamp and a monotonic
sequence number giving a total order over commits.

``commit`` snapshots the working tree.  ``commit --undo N`` rolls back the
changes of the most recent N commits that fall inside the target subtree
ROOT; changes outside the subtree are preserved.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import tempfile
import time

EXIT_OK = 0
EXIT_ERROR = 2
EXIT_CORRUPT = 5

TYPE_FILE = "file"
TYPE_DIR = "dir"

_ID_RE = re.compile(r"^[0-9a-f]{32}$")


class HierosyncError(Exception):
    """Operational error (exit code 2)."""


class CorruptError(HierosyncError):
    """Snapshot store corruption: broken/cyclic parent pointers etc. (exit 5)."""


def hash_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def hash_dir_entries(entries) -> str:
    """Hash of a directory from sorted (name, type, hash) child entries."""
    h = hashlib.sha256()
    for name, typ, child_hash in sorted(entries):
        h.update(name.encode("utf-8"))
        h.update(b"\0")
        h.update(typ.encode("ascii"))
        h.update(b"\0")
        h.update(child_hash.encode("ascii"))
        h.update(b"\n")
    return h.hexdigest()


def empty_manifest() -> dict:
    return {"": {"type": TYPE_DIR, "hash": hash_dir_entries([])}}


def scan_manifest(root: str, exclude: str | None = None) -> dict:
    """Build a manifest of the tree at ``root`` (path -> {type, hash}).

    The root itself is keyed by "".  ``exclude`` is an absolute path skipped
    during traversal (the snapshot store directory).
    """
    root = os.path.abspath(root)
    if not os.path.isdir(root):
        raise HierosyncError(f"not a directory: {root}")
    manifest: dict = {}

    def walk(dir_path: str, rel: str) -> str:
        entries = []
        for name in sorted(os.listdir(dir_path)):
            full = os.path.join(dir_path, name)
            if exclude is not None and os.path.abspath(full) == exclude:
                continue
            child_rel = name if not rel else rel + "/" + name
            if os.path.isdir(full) and not os.path.islink(full):
                child_hash = walk(full, child_rel)
                manifest[child_rel] = {"type": TYPE_DIR, "hash": child_hash}
                entries.append((name, TYPE_DIR, child_hash))
            else:
                if os.path.islink(full):
                    data = os.readlink(full).encode("utf-8")
                else:
                    with open(full, "rb") as fh:
                        data = fh.read()
                child_hash = hash_bytes(data)
                manifest[child_rel] = {"type": TYPE_FILE, "hash": child_hash}
                entries.append((name, TYPE_FILE, child_hash))
        return hash_dir_entries(entries)

    manifest[""] = {"type": TYPE_DIR, "hash": walk(root, "")}
    return manifest


def _atomic_write(path: str, data: bytes) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path))
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


class Store:
    """On-disk snapshot store rooted at the SNAP directory."""

    def __init__(self, snap_dir: str):
        self.dir = os.path.abspath(snap_dir)
        self.repo_root = os.path.dirname(self.dir)
        self.snaps_dir = os.path.join(self.dir, "snapshots")
        self.objects_dir = os.path.join(self.dir, "objects")
        self.head_file = os.path.join(self.dir, "HEAD")
        self.seq_file = os.path.join(self.dir, "SEQUENCE")

    def snapshot_path(self, snap_id: str) -> str:
        if not _ID_RE.match(snap_id or ""):
            raise CorruptError(f"invalid snapshot id: {snap_id!r}")
        return os.path.join(self.snaps_dir, snap_id + ".json")

    def read_snapshot(self, snap_id: str) -> dict:
        path = self.snapshot_path(snap_id)
        if not os.path.isfile(path):
            raise CorruptError(f"missing snapshot file for id {snap_id}")
        try:
            with open(path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise CorruptError(f"unreadable snapshot {snap_id}: {exc}")
        self._validate_snapshot(data, snap_id)
        return data

    @staticmethod
    def _validate_snapshot(data, snap_id: str) -> None:
        if not isinstance(data, dict):
            raise CorruptError(f"snapshot {snap_id}: not a JSON object")
        if data.get("id") != snap_id:
            raise CorruptError(f"snapshot {snap_id}: id mismatch")
        parent = data.get("parent")
        if parent is not None and not _ID_RE.match(str(parent)):
            raise CorruptError(f"snapshot {snap_id}: invalid parent pointer {parent!r}")
        if not isinstance(data.get("seq"), int) or not isinstance(data.get("time_ns"), int):
            raise CorruptError(f"snapshot {snap_id}: missing ordering fields")
        manifest = data.get("manifest")
        if not isinstance(manifest, dict):
            raise CorruptError(f"snapshot {snap_id}: manifest missing")
        for path, entry in manifest.items():
            if (
                not isinstance(path, str)
                or not isinstance(entry, dict)
                or entry.get("type") not in (TYPE_FILE, TYPE_DIR)
                or not isinstance(entry.get("hash"), str)
            ):
                raise CorruptError(f"snapshot {snap_id}: bad manifest entry {path!r}")

    def head_id(self) -> str | None:
        if not os.path.isfile(self.head_file):
            return None
        try:
            with open(self.head_file, "r", encoding="utf-8") as fh:
                raw = fh.read().strip()
        except OSError as exc:
            raise CorruptError(f"unreadable HEAD: {exc}")
        if not _ID_RE.match(raw):
            raise CorruptError("corrupt HEAD pointer")
        return raw

    def load_chain(self) -> list:
        """Return snapshots newest-first, following parent pointers.

        Raises CorruptError on dangling parents or cycles (exit code 5).
        """
        chain = []
        seen = set()
        current = self.head_id()
        while current is not None:
            if current in seen:
                raise CorruptError(f"cyclic parent pointer detected at {current}")
            seen.add(current)
            snap = self.read_snapshot(current)
            chain.append(snap)
            current = snap["parent"]
        return chain

    def read_seq(self) -> int | None:
        if not os.path.isfile(self.seq_file):
            return None
        try:
            with open(self.seq_file, "r", encoding="utf-8") as fh:
                return int(fh.read().strip())
        except (OSError, ValueError) as exc:
            raise CorruptError(f"corrupt SEQUENCE file: {exc}")

    def object_path(self, content_hash: str) -> str:
        return os.path.join(self.objects_dir, content_hash)


def _rel_root(root_abs: str, repo_root: str) -> str:
    rel = os.path.relpath(root_abs, repo_root)
    if rel == ".":
        return ""
    if rel == ".." or rel.startswith(".." + os.sep) or os.path.isabs(rel):
        raise HierosyncError(f"root {root_abs} is outside repository {repo_root}")
    return rel.replace(os.sep, "/")


def in_subtree(path: str, rel_root: str) -> bool:
    return rel_root == "" or path == rel_root or path.startswith(rel_root + "/")


def _diff_paths(m1: dict, m2: dict):
    for path in set(m1) | set(m2):
        if m1.get(path) != m2.get(path):
            yield path


def _touches_subtree(parent_manifest: dict, manifest: dict, rel_root: str) -> bool:
    return any(in_subtree(p, rel_root) for p in _diff_paths(parent_manifest, manifest))


def _apply_manifest(store: Store, new_manifest: dict) -> None:
    """Make the working tree exactly match ``new_manifest``."""
    repo = store.repo_root
    current = scan_manifest(repo, exclude=store.dir)
    doomed = [p for p in current if p not in new_manifest and p != ""]
    for path in sorted(doomed, key=lambda s: s.count("/"), reverse=True):
        full = os.path.join(repo, path)
        if current[path]["type"] == TYPE_DIR:
            shutil.rmtree(full, ignore_errors=True)
        elif os.path.lexists(full):
            os.remove(full)
    for path in sorted(new_manifest, key=lambda s: s.count("/")):
        if path == "":
            continue
        entry = new_manifest[path]
        full = os.path.join(repo, path)
        if entry["type"] == TYPE_DIR:
            if os.path.lexists(full) and not os.path.isdir(full):
                os.remove(full)
            os.makedirs(full, exist_ok=True)
        else:
            if os.path.isdir(full) and not os.path.islink(full):
                shutil.rmtree(full)
            cur = current.get(path)
            if (
                cur
                and cur["type"] == TYPE_FILE
                and cur["hash"] == entry["hash"]
                and os.path.isfile(full)
            ):
                continue
            os.makedirs(os.path.dirname(full), exist_ok=True)
            shutil.copyfile(store.object_path(entry["hash"]), full)


def _store_objects(store: Store, manifest: dict) -> None:
    for path, entry in manifest.items():
        if entry["type"] != TYPE_FILE:
            continue
        obj = store.object_path(entry["hash"])
        if os.path.isfile(obj):
            continue
        full = os.path.join(store.repo_root, path)
        with open(full, "rb") as fh:
            data = fh.read()
        if hash_bytes(data) != entry["hash"]:
            raise HierosyncError(f"file changed while committing: {path}")
        _atomic_write(obj, data)


def _verify_applied(store: Store, new_manifest: dict) -> dict:
    """Rescan the tree and confirm it matches the intended manifest.

    Returns the freshly scanned manifest whose hashes are recomputed from
    disk, guaranteeing root-to-leaf paths exist and hashes are consistent.
    """
    scanned = scan_manifest(store.repo_root, exclude=store.dir)
    if set(scanned) != set(new_manifest):
        raise HierosyncError("post-undo verification failed: path set mismatch")
    for path, entry in scanned.items():
        want = new_manifest[path]
        if entry["type"] != want["type"]:
            raise HierosyncError(f"post-undo verification failed at {path!r}")
        if entry["type"] == TYPE_FILE and entry["hash"] != want["hash"]:
            raise HierosyncError(f"post-undo verification failed at {path!r}")
    return scanned


def commit(root: str, snap_dir: str, undo: int = 0) -> dict:
    """Commit the tree, optionally undoing the most recent ``undo`` commits
    inside the subtree ``root``.  Returns the JSON-able result dict."""
    store = Store(snap_dir)
    root_abs = os.path.abspath(root)
    rel_root = _rel_root(root_abs, store.repo_root)

    # Validate the existing chain (parent pointers, cycles) before any write.
    chain = store.load_chain()
    head = chain[0] if chain else None

    undone: list = []
    skipped: list = []

    if undo > 0 and head is not None:
        targets = chain[:undo]
        base_manifest = chain[undo]["manifest"] if len(chain) > undo else empty_manifest()
        for i, snap in enumerate(targets):
            parent_manifest = (
                chain[i + 1]["manifest"] if i + 1 < len(chain) else empty_manifest()
            )
            if _touches_subtree(parent_manifest, snap["manifest"], rel_root):
                undone.append(snap["id"])
            else:
                skipped.append(snap["id"])
        head_manifest = head["manifest"]
        new_manifest = {
            p: e for p, e in head_manifest.items() if not in_subtree(p, rel_root)
        }
        for p, e in base_manifest.items():
            if in_subtree(p, rel_root):
                new_manifest[p] = e
        # All objects referenced by the target state must already exist.
        missing = [
            e["hash"]
            for e in new_manifest.values()
            if e["type"] == TYPE_FILE and not os.path.isfile(store.object_path(e["hash"]))
        ]
        if missing:
            raise CorruptError(f"missing content objects: {sorted(set(missing))}")
        _apply_manifest(store, new_manifest)
        final_manifest = _verify_applied(store, new_manifest)
    else:
        if not os.path.isdir(root_abs):
            raise HierosyncError(f"root is not a directory: {root}")
        final_manifest = scan_manifest(store.repo_root, exclude=store.dir)
        _store_objects(store, final_manifest)

    last_seq = store.read_seq()
    seq = 0 if last_seq is None else last_seq + 1
    time_ns = time.time_ns()
    parent_id = head["id"] if head else None
    root_hash = final_manifest[""]["hash"]
    snap_id = hash_bytes(
        json.dumps([parent_id, time_ns, seq, root_hash]).encode("utf-8")
    )[:32]
    snapshot = {
        "id": snap_id,
        "parent": parent_id,
        "time_ns": time_ns,
        "seq": seq,
        "root_hash": root_hash,
        "manifest": final_manifest,
    }
    _atomic_write(
        store.snapshot_path(snap_id),
        (json.dumps(snapshot, indent=2, sort_keys=True) + "\n").encode("utf-8"),
    )
    _atomic_write(store.head_file, snap_id.encode("ascii"))
    _atomic_write(store.seq_file, str(seq).encode("ascii"))
    return {"committed": snap_id, "undone": undone, "skipped": skipped}

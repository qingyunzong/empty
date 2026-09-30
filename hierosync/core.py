"""Core logic for hierosync: hierarchical directory version snapshots.

A snapshot store (SNAP) keeps a totally ordered chain of commits.  Each
commit records a full content-hash snapshot of every node (files and
directories, including empty directories) under a root tree, plus a
parent pointer to the previous commit.

Layout of a store::

    SNAP/
        HEAD              # id of the current head commit
        commits/<id>.json # metadata: id, parent, timestamp, seq, root, tree_hash
        trees/<id>.json   # node table: relpath -> {type, hash}
        objects/<sha256>  # content addressed file blobs

Integrity failures (cyclic or dangling parent pointers, malformed
metadata, hash mismatches, broken timestamp ordering) raise
CorruptionError, which the CLI maps to exit code 5.  The whole chain is
validated before any new snapshot is written, so a corrupt store never
produces a new snapshot.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import time
from pathlib import Path

EXIT_OK = 0
EXIT_USAGE = 2
EXIT_CORRUPTION = 5

DIR = "dir"
FILE = "file"

_COMMIT_FIELDS = ("id", "parent", "timestamp", "seq", "root", "tree_hash")


class CorruptionError(Exception):
    """Snapshot store integrity failure (reported with exit code 5)."""


class UsageError(Exception):
    """Invalid invocation or environment (reported with exit code 2)."""


# ---------------------------------------------------------------------------
# hashing


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def hash_file(path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 16), b""):
            digest.update(chunk)
    return digest.hexdigest()


def hash_dir_entries(children) -> str:
    """Hash a directory from its sorted (name, type, child_hash) entries."""
    digest = hashlib.sha256()
    for name, kind, child_hash in sorted(children):
        digest.update(kind.encode("ascii"))
        digest.update(b"\x00")
        digest.update(name.encode("utf-8"))
        digest.update(b"\x00")
        digest.update(child_hash.encode("ascii"))
        digest.update(b"\x00")
    return digest.hexdigest()


EMPTY_TREE_HASH = hash_dir_entries([])


# ---------------------------------------------------------------------------
# tree scanning / verification


def scan_tree(root) -> tuple[dict, str]:
    """Scan *root* and return (nodes, tree_hash).

    nodes maps a POSIX-style relative path to [type, hash] for every
    file and directory below root (root itself is implicit).
    """
    root = Path(root)
    nodes: dict[str, list] = {}

    def rec(dir_path: Path, rel: str) -> str:
        children = []
        with os.scandir(dir_path) as it:
            entries = sorted(it, key=lambda e: e.name)
        for entry in entries:
            child_rel = f"{rel}/{entry.name}" if rel else entry.name
            full = dir_path / entry.name
            if entry.is_dir(follow_symlinks=False):
                child_hash = rec(full, child_rel)
                nodes[child_rel] = [DIR, child_hash]
                children.append((entry.name, DIR, child_hash))
            else:
                child_hash = hash_file(full)
                nodes[child_rel] = [FILE, child_hash]
                children.append((entry.name, FILE, child_hash))
        return hash_dir_entries(children)

    tree_hash = rec(root, "")
    return nodes, tree_hash


def verify_nodes(nodes: dict, tree_hash: str) -> None:
    """Recompute every directory hash from *nodes* and check *tree_hash*.

    Guarantees that every root-to-leaf path is well formed (each parent
    exists as a directory) and that all stored hashes are recomputable.
    """
    children_of: dict[str, list] = {}
    for path, (kind, _hash) in nodes.items():
        if kind not in (DIR, FILE):
            raise CorruptionError(f"unknown node type for {path!r}")
        parent, _, name = path.rpartition("/")
        if not name:
            raise CorruptionError(f"malformed node path: {path!r}")
        children_of.setdefault(parent, []).append((name, kind, _hash))
    for parent in children_of:
        if parent == "":
            continue
        node = nodes.get(parent)
        if node is None or node[0] != DIR:
            raise CorruptionError(f"missing directory ancestor: {parent!r}")
    for dir_rel, kids in children_of.items():
        expected = hash_dir_entries(kids)
        if dir_rel == "":
            actual = tree_hash
        else:
            actual = nodes[dir_rel][1]
        if actual != expected:
            raise CorruptionError(f"hash mismatch at directory {dir_rel!r}")
    if "" not in children_of and tree_hash != EMPTY_TREE_HASH:
        raise CorruptionError("tree hash mismatch for empty tree")


# ---------------------------------------------------------------------------
# store


class Store:
    def __init__(self, snap):
        self.snap = Path(snap)
        self.commits_dir = self.snap / "commits"
        self.trees_dir = self.snap / "trees"
        self.objects_dir = self.snap / "objects"
        self.head_file = self.snap / "HEAD"

    # -- low level helpers -------------------------------------------------

    def _read_json(self, path: Path, what: str):
        try:
            with open(path, "r", encoding="utf-8") as handle:
                return json.load(handle)
        except FileNotFoundError:
            raise CorruptionError(f"missing {what}: {path.name}") from None
        except (OSError, ValueError) as exc:
            raise CorruptionError(f"corrupt {what} {path.name}: {exc}") from None

    def _write_json(self, path: Path, payload) -> None:
        tmp = path.with_suffix(path.suffix + ".tmp")
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2, sort_keys=True)
            handle.write("\n")
        os.replace(tmp, path)

    def ensure_dirs(self) -> None:
        self.commits_dir.mkdir(parents=True, exist_ok=True)
        self.trees_dir.mkdir(parents=True, exist_ok=True)
        self.objects_dir.mkdir(parents=True, exist_ok=True)

    # -- commits / trees ----------------------------------------------------

    def read_commit(self, cid: str) -> dict:
        meta = self._read_json(self.commits_dir / f"{cid}.json", "commit")
        if not isinstance(meta, dict):
            raise CorruptionError(f"commit {cid} is not an object")
        for field in _COMMIT_FIELDS:
            if field not in meta:
                raise CorruptionError(f"commit {cid} lacks field {field!r}")
        if meta["id"] != cid:
            raise CorruptionError(f"commit id mismatch: {cid}")
        if meta["parent"] is not None and not isinstance(meta["parent"], str):
            raise CorruptionError(f"commit {cid} has a corrupt parent pointer")
        if not isinstance(meta["timestamp"], (int, float)):
            raise CorruptionError(f"commit {cid} has a corrupt timestamp")
        if not isinstance(meta["seq"], int):
            raise CorruptionError(f"commit {cid} has a corrupt sequence number")
        return meta

    def read_tree(self, cid: str) -> dict:
        raw = self._read_json(self.trees_dir / f"{cid}.json", "tree")
        if not isinstance(raw, dict) or not isinstance(raw.get("nodes"), dict):
            raise CorruptionError(f"tree {cid} is malformed")
        nodes = {}
        for path, entry in raw["nodes"].items():
            if (
                not isinstance(entry, list)
                or len(entry) != 2
                or entry[0] not in (DIR, FILE)
                or not isinstance(entry[1], str)
            ):
                raise CorruptionError(f"tree {cid} has a malformed node {path!r}")
            nodes[path] = (entry[0], entry[1])
        return nodes

    def write_tree(self, cid: str, nodes: dict) -> None:
        payload = {"nodes": {p: [k, h] for p, (k, h) in sorted(nodes.items())}}
        self._write_json(self.trees_dir / f"{cid}.json", payload)

    def write_commit(self, meta: dict) -> None:
        self._write_json(self.commits_dir / f"{meta['id']}.json", meta)

    def write_head(self, cid: str) -> None:
        tmp = self.head_file.with_suffix(".tmp")
        tmp.write_text(cid + "\n", encoding="utf-8")
        os.replace(tmp, self.head_file)

    # -- blobs ---------------------------------------------------------------

    def write_blob(self, content_hash: str, source: Path) -> None:
        dest = self.objects_dir / content_hash
        if dest.exists():
            return
        tmp = self.objects_dir / (content_hash + ".tmp")
        shutil.copyfile(source, tmp)
        os.replace(tmp, dest)

    def read_blob(self, content_hash: str) -> bytes:
        path = self.objects_dir / content_hash
        try:
            data = path.read_bytes()
        except OSError:
            raise CorruptionError(f"missing object {content_hash}") from None
        if _sha256_bytes(data) != content_hash:
            raise CorruptionError(f"object {content_hash} fails hash check")
        return data

    # -- chain loading / validation ------------------------------------------

    def load_chain(self) -> list:
        """Return commits ordered genesis..head, fully validated.

        Detects cyclic parent pointers, dangling parents, malformed
        metadata, broken total timestamp order and non-recomputable
        hashes.  Raises CorruptionError on any problem.
        """
        if not self.head_file.exists():
            if self.commits_dir.is_dir() and any(self.commits_dir.iterdir()):
                raise CorruptionError("HEAD is missing but commits exist")
            return []
        try:
            head_id = self.head_file.read_text(encoding="utf-8").strip()
        except OSError as exc:
            raise CorruptionError(f"cannot read HEAD: {exc}") from None
        if not head_id:
            raise CorruptionError("HEAD is empty")

        chain = []
        seen = set()
        cid = head_id
        while cid is not None:
            if cid in seen:
                raise CorruptionError(f"cyclic parent pointer at commit {cid}")
            seen.add(cid)
            meta = self.read_commit(cid)
            chain.append(meta)
            cid = meta["parent"]
        chain.reverse()

        for index, meta in enumerate(chain):
            expected_parent = chain[index - 1]["id"] if index else None
            if meta["parent"] != expected_parent:
                raise CorruptionError(
                    f"commit {meta['id']} has an inconsistent parent pointer"
                )
            if meta["seq"] != index:
                raise CorruptionError(f"commit {meta['id']} has a broken sequence")
            if index and not meta["timestamp"] > chain[index - 1]["timestamp"]:
                raise CorruptionError(
                    f"commit {meta['id']} violates the total timestamp order"
                )
            nodes = self.read_tree(meta["id"])
            verify_nodes(nodes, meta["tree_hash"])
        return chain


# ---------------------------------------------------------------------------
# materialisation


def _materialize(root: Path, nodes: dict, store: Store) -> None:
    """Rewrite the working tree at *root* to exactly match *nodes*."""
    desired_dirs = {p for p, (k, _h) in nodes.items() if k == DIR}
    desired_files = {p: h for p, (k, h) in nodes.items() if k == FILE}
    root.mkdir(parents=True, exist_ok=True)

    # Remove files that are not desired, then prune undesired directories
    # bottom-up so children disappear before their parents.
    for dirpath, _dirnames, filenames in os.walk(root, topdown=False):
        dir_path = Path(dirpath)
        for name in filenames:
            full = dir_path / name
            rel = full.relative_to(root).as_posix()
            if rel not in desired_files:
                full.unlink()
        if dir_path != root:
            rel = dir_path.relative_to(root).as_posix()
            if rel not in desired_dirs:
                try:
                    dir_path.rmdir()
                except OSError:
                    shutil.rmtree(dir_path)

    for rel in sorted(desired_dirs, key=lambda p: (p.count("/"), p)):
        root.joinpath(*rel.split("/")).mkdir(parents=True, exist_ok=True)

    for rel, content_hash in sorted(desired_files.items()):
        dest = root.joinpath(*rel.split("/"))
        if dest.is_file() and hash_file(dest) == content_hash:
            continue
        data = store.read_blob(content_hash)
        with open(dest, "wb") as handle:
            handle.write(data)


# ---------------------------------------------------------------------------
# commit / undo


def _new_commit_id(store: Store, parent_id, seq: int, timestamp: float, tree_hash: str) -> str:
    nonce = 0
    while True:
        raw = f"{parent_id}|{seq}|{timestamp!r}|{tree_hash}|{nonce}"
        cid = _sha256_bytes(raw.encode("utf-8"))[:16]
        if not (store.commits_dir / f"{cid}.json").exists():
            return cid
        nonce += 1


def _compute_undo(store: Store, chain: list, undo: int):
    """Return (base_nodes, base_hash, undone_ids, skipped_ids)."""
    n_eff = min(undo, len(chain))
    window = chain[len(chain) - n_eff :]
    base_index = len(chain) - n_eff - 1
    if base_index < 0:
        base_nodes, base_hash = {}, EMPTY_TREE_HASH
        prev_hash = EMPTY_TREE_HASH
    else:
        base = chain[base_index]
        base_nodes = store.read_tree(base["id"])
        base_hash = base["tree_hash"]
        prev_hash = base_hash

    undone, skipped = [], []
    for meta in window:
        if meta["tree_hash"] == prev_hash:
            skipped.append(meta["id"])
        else:
            undone.append(meta["id"])
        prev_hash = meta["tree_hash"]
    undone.reverse()
    skipped.reverse()
    return base_nodes, base_hash, undone, skipped


def commit(root, snap, undo: int = 0) -> dict:
    """Commit a snapshot of *root* into the store at *snap*.

    With ``undo >= 1`` the changes of the most recent ``undo`` commits
    that fall inside the target subtree are rolled back: the tree is
    restored to the state preceding those commits (commits outside the
    window are preserved), the result is materialised into *root* and
    recorded as a new commit on top of the existing chain.
    """
    root_abs = Path(os.path.abspath(root))
    store = Store(snap)
    snap_abs = Path(os.path.abspath(store.snap))
    if snap_abs == root_abs or snap_abs.is_relative_to(root_abs):
        raise UsageError("snapshot store must not be inside the root tree")

    # Full integrity validation happens before anything is written.
    chain = store.load_chain()
    if chain and chain[0]["root"] != str(root_abs):
        raise UsageError(f"store is bound to a different root: {chain[0]['root']}")

    if undo >= 1 and chain:
        nodes, tree_hash, undone, skipped = _compute_undo(store, chain, undo)
        _materialize(root_abs, nodes, store)
        # Post-condition: every root-to-leaf path exists and every hash
        # recomputes from the materialised tree.
        _check_nodes, check_hash = scan_tree(root_abs)
        if check_hash != tree_hash:
            raise CorruptionError(
                "post-undo verification failed: hashes do not recompute"
            )
    else:
        if not root_abs.is_dir():
            raise UsageError(f"root directory does not exist: {root}")
        nodes, tree_hash = scan_tree(root_abs)
        undone, skipped = [], []

    store.ensure_dirs()
    if undo >= 1 and chain:
        # Blobs for historical states must already exist; read_blob
        # verifies them above during materialisation.
        pass
    else:
        for rel, (kind, content_hash) in nodes.items():
            if kind == FILE:
                store.write_blob(content_hash, root_abs.joinpath(*rel.split("/")))

    parent_id = chain[-1]["id"] if chain else None
    seq = len(chain)
    timestamp = time.time()
    if chain:
        # Concurrent commits on the same subtree are totally ordered by
        # strictly increasing timestamps along the chain.
        timestamp = max(timestamp, chain[-1]["timestamp"] + 0.001)
    cid = _new_commit_id(store, parent_id, seq, timestamp, tree_hash)
    meta = {
        "id": cid,
        "parent": parent_id,
        "timestamp": timestamp,
        "seq": seq,
        "root": str(root_abs),
        "tree_hash": tree_hash,
    }
    store.write_tree(cid, nodes)
    store.write_commit(meta)
    store.write_head(cid)
    return {"committed": cid, "undone": undone, "skipped": skipped}

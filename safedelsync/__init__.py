"""safedelsync: state-based two-way directory sync with safe delete propagation.

Core idea: a state file records the last-synced triple (path, hash, exists).
A path missing on one side is a *deletion* only if the state says it existed;
otherwise a present file is an *addition* and is never treated as a delete.
"""
from __future__ import annotations

import hashlib
import json
import os
import tempfile

STATE_VERSION = 1
CONFLICT_SUFFIX = ".conflict"
_CRASH_ENV = "SAFEDELSYNC_CRASH_AFTER"


class StateCorruptError(Exception):
    """Raised when the state file exists but cannot be parsed/validated."""


def _hash_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _hash_bytes(data):
    return hashlib.sha256(data).hexdigest()


def _scan(root):
    """Map relative posix path -> sha256 hex for every regular file."""
    entries = {}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        for name in sorted(filenames):
            full = os.path.join(dirpath, name)
            if os.path.islink(full) or not os.path.isfile(full):
                continue
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            entries[rel] = _hash_file(full)
    return entries


def load_state(state_path):
    """Return {path: (hash, exists)}. Missing file -> empty state."""
    if not os.path.exists(state_path):
        return {}
    try:
        with open(state_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict) or data.get("version") != STATE_VERSION:
            raise ValueError("bad state version")
        entries = data["entries"]
        if not isinstance(entries, dict):
            raise ValueError("bad entries")
        result = {}
        for path, entry in entries.items():
            if not isinstance(path, str):
                raise ValueError("bad path key")
            result[path] = (str(entry["hash"]), bool(entry["exists"]))
        return result
    except (ValueError, KeyError, TypeError, json.JSONDecodeError, OSError) as exc:
        raise StateCorruptError(f"corrupt state file {state_path!r}: {exc}") from exc


def save_state(state_path, state):
    """Atomically write the state file (temp file + rename)."""
    directory = os.path.dirname(os.path.abspath(state_path))
    os.makedirs(directory, exist_ok=True)
    payload = {
        "version": STATE_VERSION,
        "entries": {
            path: {"hash": h, "exists": exists}
            for path, (h, exists) in sorted(state.items())
        },
    }
    fd, tmp = tempfile.mkstemp(prefix=".safedelsync-", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(payload, f, sort_keys=True)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, state_path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


class _Ops:
    """Filesystem mutations with an optional crash hook for kill-testing."""

    def __init__(self, crash_after=None):
        if crash_after is None:
            env = os.environ.get(_CRASH_ENV)
            crash_after = int(env) if env else None
        self._remaining = crash_after

    def _tick(self):
        if self._remaining is not None:
            self._remaining -= 1
            if self._remaining <= 0:
                # Simulate SIGKILL: die instantly, state file never written.
                os._exit(9)

    def copy(self, src_root, dst_root, rel):
        dst = os.path.join(dst_root, *rel.split("/"))
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        with open(os.path.join(src_root, *rel.split("/")), "rb") as f:
            data = f.read()
        with open(dst, "wb") as f:
            f.write(data)
        self._tick()

    def write(self, root, rel, data):
        path = os.path.join(root, *rel.split("/"))
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(data)
        self._tick()

    def read(self, root, rel):
        with open(os.path.join(root, *rel.split("/")), "rb") as f:
            return f.read()

    def delete(self, root, rel):
        path = os.path.join(root, *rel.split("/"))
        try:
            os.remove(path)
        except FileNotFoundError:
            return
        self._tick()
        # Prune now-empty parent directories (best effort, not counted).
        parent = os.path.dirname(path)
        root_abs = os.path.abspath(root)
        while parent.startswith(root_abs) and parent != root_abs:
            try:
                os.rmdir(parent)
            except OSError:
                break
            parent = os.path.dirname(parent)


def sync_dirs(left, right, state_path, crash_after=None):
    """Synchronize directories `left` and `right` using `state_path`.

    Returns {"copied": n, "deleted": n, "conflicts": n}.
    Raises StateCorruptError if the state file exists but is invalid.
    """
    state = load_state(state_path)
    left_files = _scan(left)
    right_files = _scan(right)
    ops = _Ops(crash_after)
    stats = {"copied": 0, "deleted": 0, "conflicts": 0}
    new_state = {}

    def record_conflict(path, official_hash, conflict_hash):
        new_state[path] = (official_hash, True)
        new_state[path + CONFLICT_SUFFIX] = (conflict_hash, True)
        stats["conflicts"] += 1

    def resolve_content_conflict(path, l_hash, r_hash):
        """Both sides changed with different content: lexicographically
        smaller content stays official, the other goes to path.conflict."""
        l_data = ops.read(left, path)
        r_data = ops.read(right, path)
        if l_data <= r_data:
            official, other = l_data, r_data
        else:
            official, other = r_data, l_data
        ops.write(left, path, official)
        ops.write(right, path, official)
        ops.write(left, path + CONFLICT_SUFFIX, other)
        ops.write(right, path + CONFLICT_SUFFIX, other)
        record_conflict(path, _hash_bytes(official), _hash_bytes(other))

    paths = sorted(set(left_files) | set(right_files) | set(state))
    for path in paths:
        entry = state.get(path)
        l_hash = left_files.get(path)
        r_hash = right_files.get(path)

        # Anti-resurrection: state says deleted; a file reappearing with the
        # exact last-known hash is a stale echo -> delete it, do not revive.
        if entry is not None and not entry[1]:
            tomb_hash = entry[0]
            if l_hash == tomb_hash and l_hash is not None:
                ops.delete(left, path)
                stats["deleted"] += 1
                l_hash = None
            if r_hash == tomb_hash and r_hash is not None:
                ops.delete(right, path)
                stats["deleted"] += 1
                r_hash = None

        if l_hash is None and r_hash is None:
            if entry is not None:
                # Deleted on both sides (or still a tombstone).
                new_state[path] = (entry[0], False)
            continue

        if entry is None or not entry[1]:
            # No live state: present file(s) are additions, never deletions.
            if l_hash is None:
                ops.copy(right, left, path)
                stats["copied"] += 1
                new_state[path] = (r_hash, True)
            elif r_hash is None:
                ops.copy(left, right, path)
                stats["copied"] += 1
                new_state[path] = (l_hash, True)
            elif l_hash != r_hash:
                resolve_content_conflict(path, l_hash, r_hash)
            else:
                new_state[path] = (l_hash, True)
            continue

        state_hash = entry[0]
        l_changed = l_hash != state_hash  # None (deleted) counts as changed
        r_changed = r_hash != state_hash

        if not l_changed and not r_changed:
            new_state[path] = entry
            continue

        if l_hash is None and r_hash is None:
            new_state[path] = (state_hash, False)
        elif l_hash is None:
            if not r_changed:
                # Deletion on left only -> propagate to right.
                ops.delete(right, path)
                stats["deleted"] += 1
                new_state[path] = (state_hash, False)
            else:
                # Delete vs modify: modify wins, keep a .conflict copy.
                data = ops.read(right, path)
                ops.write(left, path, data)
                ops.write(left, path + CONFLICT_SUFFIX, data)
                ops.write(right, path + CONFLICT_SUFFIX, data)
                record_conflict(path, r_hash, r_hash)
        elif r_hash is None:
            if not l_changed:
                ops.delete(left, path)
                stats["deleted"] += 1
                new_state[path] = (state_hash, False)
            else:
                data = ops.read(left, path)
                ops.write(right, path, data)
                ops.write(left, path + CONFLICT_SUFFIX, data)
                ops.write(right, path + CONFLICT_SUFFIX, data)
                record_conflict(path, l_hash, l_hash)
        else:
            if l_hash == r_hash:
                new_state[path] = (l_hash, True)
            elif not l_changed:
                ops.copy(right, left, path)
                stats["copied"] += 1
                new_state[path] = (r_hash, True)
            elif not r_changed:
                ops.copy(left, right, path)
                stats["copied"] += 1
                new_state[path] = (l_hash, True)
            else:
                resolve_content_conflict(path, l_hash, r_hash)

    save_state(state_path, new_state)
    return stats

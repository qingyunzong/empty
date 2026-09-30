"""Core two-way directory synchronization with safe delete propagation.

The synchronizer keeps a JSON state file recording, for every known path,
the triple (path, hash, exists) as of the last successful sync:

* ``exists=True``  - the file was present on both sides with ``hash``.
* ``exists=False`` - a tombstone: the file was deleted (and the deletion
  was propagated).  The recorded hash is the last known content hash.

Tombstones let us distinguish a *late arriving write of old content*
(must be discarded, not resurrected) from a genuinely new file.
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile

CONFLICT_SUFFIX = ".conflict"
STATE_VERSION = 1


class StateError(Exception):
    """Raised when the state file is corrupt or has an invalid layout."""


def _hash_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _hash_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 16), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _scan(root: str) -> dict:
    """Map every regular file under *root* to its content hash."""
    entries = {}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        filenames.sort()
        for name in filenames:
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            entries[rel] = _hash_file(full)
    return entries


def load_state(state_path: str) -> dict:
    """Load the state file, returning ``{path: (hash, exists)}``."""
    if not os.path.exists(state_path):
        return {}
    try:
        with open(state_path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise StateError(f"corrupt state file {state_path!r}: {exc}") from exc
    if not isinstance(data, dict) or not isinstance(data.get("files"), dict):
        raise StateError(f"corrupt state file {state_path!r}: bad layout")
    state = {}
    for path, entry in data["files"].items():
        if (
            not isinstance(path, str)
            or not isinstance(entry, dict)
            or not isinstance(entry.get("hash"), str)
            or not isinstance(entry.get("exists"), bool)
        ):
            raise StateError(
                f"corrupt state file {state_path!r}: bad entry for {path!r}"
            )
        state[path] = (entry["hash"], entry["exists"])
    return state


def save_state(state_path: str, state: dict) -> None:
    """Atomically persist the state (write temp file, fsync, rename)."""
    directory = os.path.dirname(os.path.abspath(state_path))
    fd, tmp_path = tempfile.mkstemp(
        dir=directory, prefix=".safedelsync-", suffix=".tmp"
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            payload = {
                "version": STATE_VERSION,
                "files": {
                    path: {"hash": file_hash, "exists": exists}
                    for path, (file_hash, exists) in sorted(state.items())
                },
            }
            json.dump(payload, handle, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_path, state_path)
    except BaseException:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def sync(left: str, right: str, state_path: str) -> dict:
    """Synchronize directories *left* and *right* using *state_path*.

    Returns a stats dict ``{"copied": n, "deleted": n, "conflicts": n}``.
    File operations are applied first and the state file is written
    atomically at the very end, so an interrupted run can simply be
    re-executed: every action is idempotent and re-derivable.
    """
    if not os.path.isdir(left):
        raise NotADirectoryError(f"not a directory: {left}")
    if not os.path.isdir(right):
        raise NotADirectoryError(f"not a directory: {right}")

    state = load_state(state_path)
    left_files = _scan(left)
    right_files = _scan(right)
    new_state: dict = {}
    stats = {"copied": 0, "deleted": 0, "conflicts": 0}
    handled: set = set()

    def _read(root: str, rel: str) -> bytes:
        with open(os.path.join(root, rel), "rb") as handle:
            return handle.read()

    def _write(root: str, rel: str, data: bytes) -> None:
        full = os.path.join(root, rel)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "wb") as handle:
            handle.write(data)

    def _remove(root: str, rel: str) -> None:
        full = os.path.join(root, rel)
        os.unlink(full)
        root_abs = os.path.abspath(root)
        parent = os.path.dirname(full)
        while parent != root_abs and parent.startswith(root_abs):
            try:
                os.rmdir(parent)
            except OSError:
                break
            parent = os.path.dirname(parent)

    def _copy(src_root: str, dst_root: str, rel: str) -> None:
        _write(dst_root, rel, _read(src_root, rel))
        stats["copied"] += 1

    def _resolve_content_conflict(rel: str) -> None:
        """Both sides changed: lexicographically smaller content wins."""
        left_data = _read(left, rel)
        right_data = _read(right, rel)
        official, loser = (
            (left_data, right_data)
            if left_data <= right_data
            else (right_data, left_data)
        )
        _write(left, rel, official)
        _write(right, rel, official)
        conflict_rel = rel + CONFLICT_SUFFIX
        _write(left, conflict_rel, loser)
        _write(right, conflict_rel, loser)
        stats["conflicts"] += 1
        new_state[rel] = (_hash_bytes(official), True)
        new_state[conflict_rel] = (_hash_bytes(loser), True)
        handled.add(conflict_rel)

    def _modify_beats_delete(rel: str, src_root: str, file_hash: str) -> None:
        """Delete on one side vs modify on the other: the modify wins."""
        data = _read(src_root, rel)
        _write(left, rel, data)
        _write(right, rel, data)
        conflict_rel = rel + CONFLICT_SUFFIX
        _write(left, conflict_rel, data)
        _write(right, conflict_rel, data)
        stats["copied"] += 1
        stats["conflicts"] += 1
        new_state[rel] = (file_hash, True)
        new_state[conflict_rel] = (file_hash, True)
        handled.add(conflict_rel)

    paths = sorted(set(left_files) | set(right_files) | set(state))
    for rel in paths:
        if rel in handled:
            continue
        left_hash = left_files.get(rel)
        right_hash = right_files.get(rel)
        record = state.get(rel)

        if record is None:
            # No state: anything present is brand new, never a deletion.
            if left_hash is not None and right_hash is not None:
                if left_hash == right_hash:
                    new_state[rel] = (left_hash, True)
                else:
                    _resolve_content_conflict(rel)
            elif left_hash is not None:
                _copy(left, right, rel)
                new_state[rel] = (left_hash, True)
            elif right_hash is not None:
                _copy(right, left, rel)
                new_state[rel] = (right_hash, True)
            continue

        state_hash, state_exists = record

        if state_exists:
            if left_hash is not None and right_hash is not None:
                if left_hash == right_hash:
                    new_state[rel] = (left_hash, True)
                elif left_hash == state_hash:
                    _copy(right, left, rel)
                    new_state[rel] = (right_hash, True)
                elif right_hash == state_hash:
                    _copy(left, right, rel)
                    new_state[rel] = (left_hash, True)
                else:
                    _resolve_content_conflict(rel)
            elif left_hash is not None:
                if left_hash == state_hash:
                    # Deleted on the right: propagate the deletion.
                    _remove(left, rel)
                    stats["deleted"] += 1
                    new_state[rel] = (state_hash, False)
                else:
                    _modify_beats_delete(rel, left, left_hash)
            elif right_hash is not None:
                if right_hash == state_hash:
                    # Deleted on the left: propagate the deletion.
                    _remove(right, rel)
                    stats["deleted"] += 1
                    new_state[rel] = (state_hash, False)
                else:
                    _modify_beats_delete(rel, right, right_hash)
            else:
                # Deleted on both sides: record a tombstone.
                new_state[rel] = (state_hash, False)
            continue

        # Tombstone: the path was deleted during a previous sync.
        if left_hash is None and right_hash is None:
            new_state[rel] = (state_hash, False)
            continue
        left_stale = left_hash is not None and left_hash == state_hash
        right_stale = right_hash is not None and right_hash == state_hash
        if (left_hash is None or left_stale) and (right_hash is None or right_stale):
            # Only stale late-arriving writes of the deleted content:
            # discard them instead of resurrecting the file.
            if left_hash is not None:
                _remove(left, rel)
                stats["deleted"] += 1
            if right_hash is not None:
                _remove(right, rel)
                stats["deleted"] += 1
            new_state[rel] = (state_hash, False)
        elif left_hash is not None and not left_stale and (
            right_hash is None or right_stale
        ):
            # Genuinely new content on the left only: treat as an add.
            _copy(left, right, rel)
            new_state[rel] = (left_hash, True)
        elif right_hash is not None and not right_stale and (
            left_hash is None or left_stale
        ):
            _copy(right, left, rel)
            new_state[rel] = (right_hash, True)
        elif left_hash == right_hash:
            new_state[rel] = (left_hash, True)
        else:
            _resolve_content_conflict(rel)

    save_state(state_path, new_state)
    return stats

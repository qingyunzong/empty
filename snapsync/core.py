"""snapsync core library.

Log entries are JSON objects: {"term": int, "seq": int, "op": str, "crc": int}.
Snapshots are JSON objects: {"last_term": int, "last_seq": int, "state_hash": str}.

The state machine is a deterministic hash chain: applying an entry folds
(term, seq, op) into the running SHA-256 state hash.  A snapshot stores the
state hash after its last included entry, so replaying the suffix of the log
on top of a valid snapshot yields exactly the same hash as a full replay.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import zlib

EXIT_OK = 0
EXIT_USAGE = 2
EXIT_LOG_CORRUPT = 3
EXIT_SNAPSHOT_CORRUPT = 8

GENESIS_HASH = hashlib.sha256(b"snapsync-genesis").hexdigest()
_HASH_RE = re.compile(r"^[0-9a-f]{64}$")


class SnapSyncError(Exception):
    """Base class for snapsync errors."""


class LogIntegrityError(SnapSyncError):
    """The operation log failed integrity checks."""


class SnapshotCorruptError(SnapSyncError):
    """The snapshot is missing, malformed, or inconsistent with the log."""


def compute_crc(term: int, seq: int, op: str) -> int:
    return zlib.crc32(f"{term}|{seq}|{op}".encode("utf-8"))


def make_entry(term: int, seq: int, op: str) -> dict:
    return {"term": term, "seq": seq, "op": op, "crc": compute_crc(term, seq, op)}


def apply_op(state_hash: str, entry: dict) -> str:
    payload = f"{state_hash}|{entry['term']}|{entry['seq']}|{entry['op']}"
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def replay(entries, state_hash: str = GENESIS_HASH) -> str:
    h = state_hash
    for entry in entries:
        h = apply_op(h, entry)
    return h


def genesis_snapshot() -> dict:
    return {"last_term": 0, "last_seq": 0, "state_hash": GENESIS_HASH}


def snapshot_for_prefix(entries, last_seq: int) -> dict:
    """Build the snapshot covering entries[:last_seq]."""
    if last_seq == 0:
        return genesis_snapshot()
    prefix = entries[:last_seq]
    last = prefix[-1]
    return {
        "last_term": last["term"],
        "last_seq": last["seq"],
        "state_hash": replay(prefix),
    }


def _is_int(value) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _validate_entry(obj, lineno: int) -> dict:
    if not isinstance(obj, dict):
        raise LogIntegrityError(f"log line {lineno}: not a JSON object")
    term, seq, op, crc = obj.get("term"), obj.get("seq"), obj.get("op"), obj.get("crc")
    if not (_is_int(term) and _is_int(seq) and isinstance(op, str) and _is_int(crc)):
        raise LogIntegrityError(f"log line {lineno}: missing or ill-typed fields")
    if compute_crc(term, seq, op) != crc:
        raise LogIntegrityError(f"log line {lineno}: crc mismatch")
    return {"term": term, "seq": seq, "op": op, "crc": crc}


def read_log(path) -> list:
    entries = []
    with open(path, "r", encoding="utf-8") as fh:
        for lineno, line in enumerate(fh, start=1):
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError as exc:
                raise LogIntegrityError(f"log line {lineno}: invalid JSON: {exc}") from exc
            entries.append(_validate_entry(obj, lineno))
    prev_term = 0
    prev_seq = None
    for index, entry in enumerate(entries):
        if prev_seq is not None and entry["seq"] != prev_seq + 1:
            raise LogIntegrityError(
                f"log line {index + 1}: seq {entry['seq']} breaks contiguity"
            )
        if entry["seq"] < 1:
            raise LogIntegrityError(f"log line {index + 1}: seq must be >= 1")
        if entry["term"] < prev_term:
            raise LogIntegrityError(
                f"log line {index + 1}: term {entry['term']} regresses"
            )
        prev_term = entry["term"]
        prev_seq = entry["seq"]
    return entries


def _atomic_write(path, text: str) -> None:
    directory = os.path.dirname(os.path.abspath(path))
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".snapsync-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(text)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def write_log(path, entries) -> None:
    text = "".join(json.dumps(e, sort_keys=True) + "\n" for e in entries)
    _atomic_write(path, text)


def _validate_snapshot(obj, path) -> dict:
    if not isinstance(obj, dict):
        raise SnapshotCorruptError(f"snapshot {path}: not a JSON object")
    last_term = obj.get("last_term")
    last_seq = obj.get("last_seq")
    state_hash = obj.get("state_hash")
    if not (_is_int(last_term) and _is_int(last_seq) and isinstance(state_hash, str)):
        raise SnapshotCorruptError(f"snapshot {path}: missing or ill-typed fields")
    if last_seq < 0 or last_term < 0:
        raise SnapshotCorruptError(f"snapshot {path}: negative term/seq")
    if not _HASH_RE.match(state_hash):
        raise SnapshotCorruptError(f"snapshot {path}: malformed state_hash")
    return {"last_term": last_term, "last_seq": last_seq, "state_hash": state_hash}


def read_snapshot(path) -> dict:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            text = fh.read()
    except FileNotFoundError as exc:
        raise SnapshotCorruptError(f"snapshot {path}: file not found") from exc
    try:
        obj = json.loads(text)
    except json.JSONDecodeError as exc:
        raise SnapshotCorruptError(f"snapshot {path}: invalid JSON: {exc}") from exc
    return _validate_snapshot(obj, path)


def write_snapshot(path, snap) -> None:
    """Write a new current snapshot, archiving the previous one by generation."""
    path = str(path)
    if os.path.exists(path):
        previous = read_snapshot(path)
        archive = f"{path}.{previous['last_seq']}"
        if os.path.abspath(archive) != os.path.abspath(path):
            _atomic_write(archive, json.dumps(previous, sort_keys=True) + "\n")
    _atomic_write(path, json.dumps(snap, sort_keys=True) + "\n")


def validate_snapshot_against_log(snap: dict, entries) -> None:
    """A snapshot may only truncate the log if (last_term, last_seq) matches a
    log prefix and replaying that prefix reproduces state_hash."""
    last_seq = snap["last_seq"]
    if last_seq == 0:
        if snap["last_term"] != 0 or snap["state_hash"] != GENESIS_HASH:
            raise SnapshotCorruptError(
                "snapshot claims empty prefix but does not match genesis"
            )
        return
    boundary = None
    for index, entry in enumerate(entries):
        if entry["seq"] == last_seq:
            boundary = index
            break
    if boundary is None:
        raise SnapshotCorruptError(
            f"snapshot last_seq {last_seq} is not a prefix boundary of the log"
        )
    entry = entries[boundary]
    if entry["term"] != snap["last_term"]:
        raise SnapshotCorruptError(
            f"snapshot (term={snap['last_term']}, seq={last_seq}) does not match "
            f"log entry (term={entry['term']}, seq={entry['seq']})"
        )
    if entries[0]["seq"] != 1:
        raise SnapshotCorruptError(
            "cannot verify snapshot state_hash: log no longer contains the "
            "full prefix from genesis"
        )
    actual = replay(entries[:boundary + 1])
    if actual != snap["state_hash"]:
        raise SnapshotCorruptError(
            "snapshot state_hash does not match replay of the log prefix"
        )


def list_generations(snap_path) -> list:
    """Archived snapshot generations next to snap_path, newest first."""
    snap_path = str(snap_path)
    directory = os.path.dirname(os.path.abspath(snap_path))
    base = os.path.basename(snap_path)
    pattern = re.compile(r"^" + re.escape(base) + r"\.(\d+)$")
    found = []
    for name in os.listdir(directory):
        match = pattern.match(name)
        if match:
            found.append((int(match.group(1)), os.path.join(directory, name)))
    found.sort(key=lambda item: item[0], reverse=True)
    return found


def enforce_retention(snap_path, keep: int) -> list:
    """Keep the `keep` most recent snapshots (the current one counts as one,
    minimum 1) and delete older generations.  The current snapshot file is
    never deleted."""
    keep = max(1, keep)
    budget = keep - 1
    kept = []
    for _seq, gen_path in list_generations(snap_path):
        if budget > 0:
            budget -= 1
            kept.append(gen_path)
        else:
            os.unlink(gen_path)
    return kept


def restore(snap: dict, entries_after) -> str:
    """State hash obtained by replaying the post-snapshot log on the snapshot."""
    return replay(entries_after, snap["state_hash"])


def compact(log_path, snap_path, keep: int = 3) -> dict:
    """Truncate LOG at the prefix covered by SNAP and prune old snapshots.

    Raises LogIntegrityError if the log is corrupt and SnapshotCorruptError
    if the snapshot cannot be trusted; in both cases LOG is left untouched.
    """
    entries = read_log(log_path)
    snap = read_snapshot(snap_path)
    validate_snapshot_against_log(snap, entries)

    cut = next(i for i, e in enumerate(entries) if e["seq"] == snap["last_seq"]) + 1 \
        if snap["last_seq"] else 0
    remaining = entries[cut:]
    write_log(log_path, remaining)
    snapshots_kept = enforce_retention(snap_path, keep)

    return {
        "kept": len(remaining),
        "truncated": snap["last_seq"],
        "restored_hash": restore(snap, remaining),
        "snapshots_kept": sorted(os.path.basename(p) for p in snapshots_kept),
    }

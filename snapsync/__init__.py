"""snapsync: compress an operation log into snapshots with restore support.

Formats
-------
Log: JSON Lines, one entry per line::

    {"term": 1, "seq": 1, "op": "set x=1", "crc": 3914851494}

``crc`` is ``zlib.crc32`` of the canonical JSON of ``{term, seq, op}``.
Sequences must be contiguous (``seq`` increases by 1) and terms must be
non-decreasing.

Snapshot: a single JSON object::

    {"version": 1, "last_term": 1, "last_seq": 3, "state_hash": "<64 hex>"}

``state_hash`` is a chain hash over the covered operations:
``H0 = sha256(b"snapsync:v0:genesis")`` and
``H(i+1) = sha256(H(i) || b"\\x00" || op(i))``.

Generations: the newest snapshot lives at ``SNAP``; older generations are
``SNAP.1``, ``SNAP.2``, ...  Compaction keeps the most recent ``K``
generations (``K`` is clamped to at least 1 so the current valid snapshot
is never deleted).

Consistency rules
-----------------
Truncation is allowed only when the snapshot's ``(last_term, last_seq)``
matches a prefix boundary of the log and every log entry's crc verifies.
When the log still contains the full history from seq 1, the snapshot's
``state_hash`` is additionally recomputed from genesis and compared, so a
tampered hash is detected.  A corrupt or mismatched snapshot is never
silently replaced by an older generation; the command fails with exit
code 8 and leaves the log untouched.

Exit codes: 0 success, 2 log/IO/usage error, 8 snapshot corrupt or
snapshot/log generation mismatch.
"""

from __future__ import annotations

import hashlib
import json
import os
import zlib
from dataclasses import dataclass

__all__ = [
    "GENESIS_HASH",
    "EXIT_OK",
    "EXIT_LOG_ERROR",
    "EXIT_SNAPSHOT_CORRUPT",
    "SnapSyncError",
    "LogError",
    "SnapshotError",
    "LogEntry",
    "Snapshot",
    "entry_crc",
    "apply_op",
    "replay_hash",
    "read_log",
    "write_log",
    "read_snapshot",
    "write_snapshot",
    "verify_snapshot",
    "generation_path",
    "count_generations",
    "compact",
    "restore",
]

EXIT_OK = 0
EXIT_LOG_ERROR = 2
EXIT_SNAPSHOT_CORRUPT = 8

GENESIS_HASH = hashlib.sha256(b"snapsync:v0:genesis").hexdigest()

_SNAPSHOT_VERSION = 1


class SnapSyncError(Exception):
    """Base class for snapsync errors."""


class LogError(SnapSyncError):
    """The operation log is corrupt or structurally invalid."""


class SnapshotError(SnapSyncError):
    """The snapshot is corrupt or inconsistent with the log."""


@dataclass
class LogEntry:
    term: int
    seq: int
    op: str
    crc: int


@dataclass
class Snapshot:
    last_term: int
    last_seq: int
    state_hash: str


def _canonical_entry(term: int, seq: int, op: str) -> bytes:
    return json.dumps(
        {"term": term, "seq": seq, "op": op},
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def entry_crc(term: int, seq: int, op: str) -> int:
    """Checksum covering exactly one log entry's content."""
    return zlib.crc32(_canonical_entry(term, seq, op)) & 0xFFFFFFFF


def apply_op(state_hash: str, op: str) -> str:
    """Fold one operation into a chain-hash state."""
    return hashlib.sha256(
        bytes.fromhex(state_hash) + b"\x00" + op.encode("utf-8")
    ).hexdigest()


def replay_hash(ops, initial: str = GENESIS_HASH) -> str:
    """Hash of the state produced by replaying ``ops`` onto ``initial``."""
    state = initial
    for op in ops:
        state = apply_op(state, op)
    return state


def _is_int(value) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def read_log(path) -> list[LogEntry]:
    """Read and fully validate a log file. Raises LogError on corruption."""
    entries: list[LogEntry] = []
    try:
        with open(path, "r", encoding="utf-8") as handle:
            lines = handle.read().splitlines()
    except FileNotFoundError:
        raise LogError(f"log not found: {path}")
    for lineno, line in enumerate(lines, start=1):
        if not line.strip():
            continue
        where = f"{path}:{lineno}"
        try:
            raw = json.loads(line)
        except json.JSONDecodeError as exc:
            raise LogError(f"{where}: invalid JSON: {exc}")
        if not isinstance(raw, dict) or set(raw) != {"term", "seq", "op", "crc"}:
            raise LogError(f"{where}: entry must have exactly term/seq/op/crc")
        term, seq, op, crc = raw["term"], raw["seq"], raw["op"], raw["crc"]
        if not _is_int(term) or term < 1:
            raise LogError(f"{where}: term must be an integer >= 1")
        if not _is_int(seq) or seq < 1:
            raise LogError(f"{where}: seq must be an integer >= 1")
        if not isinstance(op, str):
            raise LogError(f"{where}: op must be a string")
        if not _is_int(crc) or not 0 <= crc <= 0xFFFFFFFF:
            raise LogError(f"{where}: crc must be a uint32")
        if crc != entry_crc(term, seq, op):
            raise LogError(f"{where}: crc mismatch (log is corrupt)")
        if entries:
            prev = entries[-1]
            if seq != prev.seq + 1:
                raise LogError(f"{where}: non-contiguous seq {prev.seq} -> {seq}")
            if term < prev.term:
                raise LogError(f"{where}: term regressed {prev.term} -> {term}")
        entries.append(LogEntry(term=term, seq=seq, op=op, crc=crc))
    return entries


def write_log(path, entries) -> None:
    lines = [
        json.dumps(
            {"term": e.term, "seq": e.seq, "op": e.op, "crc": e.crc},
            sort_keys=True,
            separators=(",", ":"),
        )
        for e in entries
    ]
    data = "\n".join(lines) + ("\n" if lines else "")
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        handle.write(data)
    os.replace(tmp, path)


def read_snapshot(path) -> Snapshot | None:
    """Read a snapshot file. Returns None if it does not exist.

    Raises SnapshotError if the file exists but is malformed.
    """
    try:
        with open(path, "r", encoding="utf-8") as handle:
            text = handle.read()
    except FileNotFoundError:
        return None
    try:
        raw = json.loads(text)
    except json.JSONDecodeError as exc:
        raise SnapshotError(f"{path}: invalid JSON: {exc}")
    if not isinstance(raw, dict):
        raise SnapshotError(f"{path}: snapshot must be a JSON object")
    for field in ("last_term", "last_seq", "state_hash"):
        if field not in raw:
            raise SnapshotError(f"{path}: missing field {field!r}")
    last_term, last_seq, state_hash = (
        raw["last_term"],
        raw["last_seq"],
        raw["state_hash"],
    )
    if not _is_int(last_term) or last_term < 0:
        raise SnapshotError(f"{path}: last_term must be an integer >= 0")
    if not _is_int(last_seq) or last_seq < 0:
        raise SnapshotError(f"{path}: last_seq must be an integer >= 0")
    if not isinstance(state_hash, str) or len(state_hash) != 64:
        raise SnapshotError(f"{path}: state_hash must be 64 hex chars")
    try:
        int(state_hash, 16)
    except ValueError:
        raise SnapshotError(f"{path}: state_hash must be 64 hex chars")
    return Snapshot(
        last_term=last_term, last_seq=last_seq, state_hash=state_hash.lower()
    )


def write_snapshot(path, snapshot: Snapshot) -> None:
    data = json.dumps(
        {
            "version": _SNAPSHOT_VERSION,
            "last_term": snapshot.last_term,
            "last_seq": snapshot.last_seq,
            "state_hash": snapshot.state_hash,
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        handle.write(data + "\n")
    os.replace(tmp, path)


def verify_snapshot(snapshot: Snapshot, entries: list[LogEntry]) -> None:
    """Check that a snapshot is a valid generation for this log.

    The snapshot's (last_term, last_seq) must match a prefix boundary of
    the log.  When the log contains the full history from seq 1, the
    snapshot's state_hash is recomputed from genesis and compared, which
    detects any tampering with the hash.  Raises SnapshotError otherwise.
    """
    if snapshot.last_seq == 0 and snapshot.last_term != 0:
        raise SnapshotError("snapshot has last_seq=0 but non-zero last_term")

    prefix: list[LogEntry] = []
    for entry in entries:
        if entry.seq <= snapshot.last_seq:
            prefix.append(entry)
        else:
            break

    if prefix:
        boundary = prefix[-1]
        if boundary.seq != snapshot.last_seq or boundary.term != snapshot.last_term:
            raise SnapshotError(
                f"snapshot (term={snapshot.last_term}, seq={snapshot.last_seq}) "
                f"does not match any log prefix boundary"
            )
    elif snapshot.last_seq > 0 and entries:
        first = entries[0]
        if first.seq != snapshot.last_seq + 1:
            raise SnapshotError(
                f"gap between snapshot (seq={snapshot.last_seq}) "
                f"and log start (seq={first.seq})"
            )
        if first.term < snapshot.last_term:
            raise SnapshotError(
                f"snapshot term {snapshot.last_term} is newer than "
                f"log start term {first.term}"
            )

    if entries and entries[0].seq == 1:
        expected = replay_hash(entry.op for entry in prefix)
        if expected != snapshot.state_hash:
            raise SnapshotError(
                "snapshot state_hash does not match the log prefix it claims "
                "to cover (snapshot is corrupt or from another history)"
            )
    elif snapshot.last_seq == 0 and snapshot.state_hash != GENESIS_HASH:
        raise SnapshotError("genesis snapshot has a non-genesis state_hash")


def generation_path(snap_path, gen: int) -> str:
    """Path of snapshot generation ``gen`` (0 = newest)."""
    return str(snap_path) if gen == 0 else f"{snap_path}.{gen}"


def count_generations(snap_path) -> int:
    count = 0
    while os.path.exists(generation_path(snap_path, count)):
        count += 1
    return count


def _prune_generations(snap_path, keep: int) -> None:
    gen = keep
    while os.path.exists(generation_path(snap_path, gen)):
        os.remove(generation_path(snap_path, gen))
        gen += 1


def _rotate_and_write(snap_path, snapshot: Snapshot, keep: int) -> None:
    # Shift existing generations up by one (SNAP -> SNAP.1 -> SNAP.2 ...).
    gen = 1
    while os.path.exists(generation_path(snap_path, gen)):
        gen += 1
    for current in range(gen - 1, -1, -1):
        src = generation_path(snap_path, current)
        if os.path.exists(src):
            os.replace(src, generation_path(snap_path, current + 1))
    write_snapshot(snap_path, snapshot)
    _prune_generations(snap_path, keep)


def compact(log_path, snap_path, keep: int) -> dict:
    """Fold the whole log into a new snapshot generation and truncate it.

    Raises LogError if the log is corrupt and SnapshotError if the current
    snapshot is corrupt or inconsistent with the log; in both cases no
    file is modified.
    """
    keep = max(1, keep)
    entries = read_log(log_path)
    snapshot = read_snapshot(snap_path)
    if snapshot is None:
        if entries and entries[0].seq != 1:
            raise SnapshotError(
                "snapshot is missing and the log does not start at seq 1; "
                "refusing to fall back to genesis"
            )
        snapshot = Snapshot(last_term=0, last_seq=0, state_hash=GENESIS_HASH)
        have_snapshot = False
    else:
        have_snapshot = True
    verify_snapshot(snapshot, entries)

    suffix = [e for e in entries if e.seq > snapshot.last_seq]
    if not suffix and have_snapshot:
        # Nothing new to compact; still enforce the retention limit.
        _prune_generations(snap_path, keep)
        return {
            "kept": count_generations(snap_path),
            "truncated": 0,
            "restored_hash": snapshot.state_hash,
        }

    new_hash = replay_hash((e.op for e in suffix), snapshot.state_hash)
    if entries:
        new_snapshot = Snapshot(
            last_term=entries[-1].term,
            last_seq=entries[-1].seq,
            state_hash=new_hash,
        )
    else:
        new_snapshot = snapshot
    _rotate_and_write(snap_path, new_snapshot, keep)
    write_log(log_path, [])
    return {
        "kept": count_generations(snap_path),
        "truncated": len(entries),
        "restored_hash": new_snapshot.state_hash,
    }


def restore(log_path, snap_path) -> str:
    """Rebuild the state hash from the snapshot plus the log suffix."""
    entries = read_log(log_path)
    snapshot = read_snapshot(snap_path)
    if snapshot is None:
        if entries and entries[0].seq != 1:
            raise SnapshotError(
                "snapshot is missing and the log does not start at seq 1; "
                "refusing to fall back to genesis"
            )
        snapshot = Snapshot(last_term=0, last_seq=0, state_hash=GENESIS_HASH)
    verify_snapshot(snapshot, entries)
    suffix = [e.op for e in entries if e.seq > snapshot.last_seq]
    return replay_hash(suffix, snapshot.state_hash)

"""walwin: WAL-backed sliding-window sum processor.

Durability semantics
--------------------
Each input record ``{seq, key, ts, delta}`` is processed as:

1. append a ``data`` entry (with CRC32 and seq) to ``wal.log`` and fsync;
2. append a ``commit`` entry for that seq and fsync;
3. apply the record to the in-memory state.

A record is applied during recovery only if a valid commit entry exists.
Recovery truncates ``wal.log`` at the first CRC-corrupt or unparseable
line, and replays committed seqs idempotently (duplicates are skipped).

Snapshots contain only committed records and store the contiguous
committed seq prefix (``committed_upto``) plus the full committed seq
set, so a stale WAL that survived a crash after the snapshot rename
(P3) is replayed idempotently and can then be cleared.

Fault injection points (env var ``FAULT_AT``):
  P1 - after WAL data append, before fsync
  P2 - after fsync, before writing the commit entry
  P3 - after snapshot.tmp rename, before WAL deletion
  P4 - after state is durable, before writing output
"""

from __future__ import annotations

import json
import os
import zlib

WAL_NAME = "wal.log"
SNAPSHOT_NAME = "snapshot.json"
SNAPSHOT_TMP_NAME = "snapshot.tmp"

FAULT_ENV = "FAULT_AT"

__all__ = [
    "WAL_NAME",
    "SNAPSHOT_NAME",
    "SNAPSHOT_TMP_NAME",
    "FAULT_ENV",
    "State",
    "encode_data",
    "encode_commit",
    "recover",
    "write_snapshot",
    "maybe_fault",
]


def maybe_fault(point: str) -> None:
    """Simulate a crash (abnormal process exit) at a named fault point."""
    if os.environ.get(FAULT_ENV) == point:
        os._exit(1)


def _canonical(obj) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _crc(obj) -> str:
    return format(zlib.crc32(_canonical(obj)) & 0xFFFFFFFF, "08x")


def encode_data(record: dict) -> str:
    """Encode a WAL data entry (JSON line) with CRC covering seq+payload."""
    payload = {
        "type": "data",
        "seq": record["seq"],
        "key": record["key"],
        "ts": record["ts"],
        "delta": record["delta"],
    }
    payload["crc"] = _crc(payload)
    return json.dumps(payload, sort_keys=True)


def encode_commit(seq) -> str:
    """Encode a WAL commit entry (JSON line) for ``seq``."""
    payload = {"type": "commit", "seq": seq}
    payload["crc"] = _crc(payload)
    return json.dumps(payload, sort_keys=True)


def _decode(line: str):
    """Decode and CRC-verify a WAL line; return payload or None."""
    try:
        payload = json.loads(line)
    except ValueError:
        return None
    if not isinstance(payload, dict):
        return None
    crc = payload.pop("crc", None)
    if not isinstance(crc, str) or crc != _crc(payload):
        return None
    return payload


class State:
    """Committed window state: per-key events plus the committed seq set."""

    def __init__(self) -> None:
        self.events: dict[str, list[list[int]]] = {}
        self.committed: set[int] = set()
        self.committed_upto: int = 0  # contiguous committed seq prefix from 1

    def apply(self, seq, key, ts, delta) -> bool:
        """Apply a committed record; duplicate seqs are skipped (idempotent)."""
        if seq in self.committed:
            return False
        self.events.setdefault(key, []).append([ts, delta])
        self.committed.add(seq)
        while self.committed_upto + 1 in self.committed:
            self.committed_upto += 1
        return True

    def window_sums(self, win: int) -> dict:
        """Final window sum per key over the last ``win`` ms ending at the
        key's max committed ts, i.e. events with ``ts > window_end - win``."""
        result = {}
        for key, events in self.events.items():
            end = max(ts for ts, _ in events)
            total = sum(delta for ts, delta in events if ts > end - win)
            result[key] = {"window_end": end, "sum": total}
        return result


def recover(dirpath: str) -> State:
    """Rebuild state from snapshot.json (if any) plus committed WAL prefix."""
    state = State()
    snap = os.path.join(dirpath, SNAPSHOT_NAME)
    if os.path.exists(snap):
        with open(snap, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        for key, events in data.get("events", {}).items():
            state.events[key] = [list(e) for e in events]
        state.committed = set(data.get("committed_seqs", []))
        state.committed_upto = int(data.get("committed_upto", 0))
    wal = os.path.join(dirpath, WAL_NAME)
    if os.path.exists(wal):
        _replay_wal(wal, state)
    return state


def _replay_wal(wal_path: str, state: State) -> None:
    with open(wal_path, "rb") as fh:
        raw = fh.read()
    offset = 0
    corrupt_at = None
    pending: dict[int, dict] = {}
    for line in raw.splitlines(keepends=True):
        try:
            text = line.decode("utf-8")
        except UnicodeDecodeError:
            corrupt_at = offset
            break
        payload = _decode(text)
        if payload is None:
            corrupt_at = offset
            break
        ptype = payload.get("type")
        seq = payload.get("seq")
        if ptype == "data" and isinstance(seq, int):
            pending[seq] = payload
        elif ptype == "commit" and seq in pending:
            rec = pending.pop(seq)
            state.apply(rec["seq"], rec["key"], rec["ts"], rec["delta"])
        offset += len(line)
    if corrupt_at is not None:
        # CRC-bad or unparseable tail: truncate it physically.
        with open(wal_path, "r+b") as fh:
            fh.truncate(corrupt_at)


def _fsync_dir(dirpath: str) -> None:
    fd = os.open(dirpath, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def write_snapshot(dirpath: str, state: State) -> None:
    """Atomically snapshot committed state, then clear the WAL.

    Fault point P3 lives between the snapshot rename and the WAL
    deletion: a crash there leaves both files, and recovery replays
    the stale WAL idempotently against the snapshot's committed set.
    """
    tmp = os.path.join(dirpath, SNAPSHOT_TMP_NAME)
    final = os.path.join(dirpath, SNAPSHOT_NAME)
    data = {
        "committed_upto": state.committed_upto,
        "committed_seqs": sorted(state.committed),
        "events": state.events,
    }
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, sort_keys=True)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, final)
    _fsync_dir(dirpath)
    maybe_fault("P3")
    wal = os.path.join(dirpath, WAL_NAME)
    if os.path.exists(wal):
        os.remove(wal)
    _fsync_dir(dirpath)

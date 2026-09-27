"""Append-only audit log with SHA256 hash chain, snapshots, recovery, verify and replay.

On-disk layout under the log directory:

    HEAD                    "<seq> <hex-hash>" of the last committed record (atomic)
    records/00000001.rec    one record per file: "length|payload|prev_hash|hash\\n"
    snapshots/00000003.snap JSON snapshot {"seq","head","state","checksum"}
    .pending_record         temp record file (crash point 1: before rename)
    .pending_snapshot       temp snapshot file

Append order: write temp record -> fsync -> atomic rename -> update HEAD.
Crash points (the only ones modelled):
    1. before rename        -> temp record discarded on recovery
    2. after rename, HEAD stale -> recovery scans tail valid records, rebuilds HEAD
    3. half-written snapshot -> deleted on recovery, fall back to previous snapshot
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from pathlib import Path

GENESIS_HASH = "0" * 64
RECORDS_DIR = "records"
SNAPSHOTS_DIR = "snapshots"
HEAD_FILE = "HEAD"
TMP_RECORD = ".pending_record"
TMP_SNAPSHOT = ".pending_snapshot"
CRASH_ENV = "AUDITLOG_CRASH_AT"

_HEX64 = re.compile(r"[0-9a-f]{64}\Z")


class PolicyError(Exception):
    """Audit log policy violation. ``code`` is a stable machine-readable code."""

    def __init__(self, code: str, message: str):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


class SimulatedCrash(Exception):
    """Raised at a modelled crash point when AUDITLOG_CRASH_AT is set."""


def _maybe_crash(point: str) -> None:
    if os.environ.get(CRASH_ENV) == point:
        raise SimulatedCrash(f"simulated crash at {point}")


def _fsync_dir(path: Path) -> None:
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _atomic_write(path: Path, data: bytes) -> None:
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "wb") as fh:
        fh.write(data)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)
    _fsync_dir(path.parent)


# ---------------------------------------------------------------- records

def encode_record(payload: bytes, prev_hash: str) -> bytes:
    """Encode one record line: ``length|payload|prev_hash|hash\\n``."""
    prefix = str(len(payload)).encode("ascii") + b"|" + payload + b"|" + prev_hash.encode("ascii")
    digest = hashlib.sha256(prefix).hexdigest()
    return prefix + b"|" + digest.encode("ascii") + b"\n"


def decode_record(data: bytes) -> tuple[bytes, str, str]:
    """Decode and fully validate a record. Returns (payload, prev_hash, hash).

    Raises ValueError on any framing, length, hex or hash-chain-local error.
    """
    if not data.endswith(b"\n"):
        raise ValueError("missing newline terminator")
    body = data[:-1]
    sep = body.find(b"|")
    if sep < 0:
        raise ValueError("missing length separator")
    try:
        length = int(body[:sep])
    except ValueError:
        raise ValueError("invalid length field") from None
    if length < 0:
        raise ValueError("negative length field")
    rest = body[sep + 1:]
    if len(rest) != length + 1 + 64 + 1 + 64:
        raise ValueError("record framing length mismatch")
    payload = rest[:length]
    tail = rest[length:]
    if tail[0:1] != b"|" or tail[65:66] != b"|":
        raise ValueError("bad field separators")
    try:
        prev_hash = tail[1:65].decode("ascii")
        digest = tail[66:130].decode("ascii")
    except UnicodeDecodeError:
        raise ValueError("non-ascii hash field") from None
    if not _HEX64.match(prev_hash) or not _HEX64.match(digest):
        raise ValueError("malformed hash field")
    expect = hashlib.sha256(encode_record_prefix(payload, prev_hash)).hexdigest()
    if expect != digest:
        raise ValueError("hash mismatch")
    return payload, prev_hash, digest


def encode_record_prefix(payload: bytes, prev_hash: str) -> bytes:
    return str(len(payload)).encode("ascii") + b"|" + payload + b"|" + prev_hash.encode("ascii")


def _record_path(d: Path, seq: int) -> Path:
    return d / RECORDS_DIR / f"{seq:08d}.rec"


# ---------------------------------------------------------------- HEAD

def read_head(logdir) -> tuple[int, str]:
    p = Path(logdir) / HEAD_FILE
    if not p.exists():
        return 0, GENESIS_HASH
    seq_s, digest = p.read_text(encoding="ascii").split()
    return int(seq_s), digest


def _write_head(d: Path, seq: int, digest: str) -> None:
    _atomic_write(d / HEAD_FILE, f"{seq} {digest}\n".encode("ascii"))


# ---------------------------------------------------------------- recovery

def recover(logdir) -> Path:
    """Bring the log directory into a consistent state. Idempotent."""
    d = Path(logdir)
    (d / RECORDS_DIR).mkdir(parents=True, exist_ok=True)
    (d / SNAPSHOTS_DIR).mkdir(exist_ok=True)

    # Crash point 1: temp record never renamed -> discard it.
    for tmp in (d / TMP_RECORD, d / TMP_SNAPSHOT):
        if tmp.exists():
            tmp.unlink()

    # Crash point 3: half-written snapshot -> delete, keep previous complete ones.
    for snap in sorted((d / SNAPSHOTS_DIR).glob("*.snap")):
        try:
            _load_snapshot(snap)
        except ValueError:
            snap.unlink()

    # Crash point 2: HEAD stale -> scan tail valid records and rebuild HEAD.
    seq, digest = read_head(d)
    while True:
        nxt = _record_path(d, seq + 1)
        if not nxt.exists():
            break
        try:
            _, prev_hash, rec_hash = decode_record(nxt.read_bytes())
        except ValueError:
            break
        if prev_hash != digest:
            break
        seq, digest = seq + 1, rec_hash
    cur = read_head(d)
    if cur != (seq, digest):
        _write_head(d, seq, digest)
    return d


# ---------------------------------------------------------------- append

def append(logdir, payload) -> tuple[int, str]:
    """Append one record. Returns (seq, hash). Payload may be str or bytes."""
    d = recover(logdir)
    if isinstance(payload, str):
        payload = payload.encode("utf-8")
    seq, prev_hash = read_head(d)
    line = encode_record(payload, prev_hash)
    rec_hash = hashlib.sha256(encode_record_prefix(payload, prev_hash)).hexdigest()

    tmp = d / TMP_RECORD
    with open(tmp, "wb") as fh:
        fh.write(line)
        fh.flush()
        os.fsync(fh.fileno())
    _maybe_crash("before_rename")

    os.replace(tmp, _record_path(d, seq + 1))
    _fsync_dir(d / RECORDS_DIR)
    _maybe_crash("after_rename")

    _write_head(d, seq + 1, rec_hash)
    return seq + 1, rec_hash


# ---------------------------------------------------------------- verify

def verify(logdir) -> tuple[int, str]:
    """Validate the whole chain. Returns (count, head_hash).

    Raises PolicyError("E_CHAIN", ...) locating the first bad record by
    sequence number and logical byte offset; never guesses past it.
    """
    d = recover(logdir)
    head_seq, head_hash = read_head(d)
    prev = GENESIS_HASH
    offset = 0
    count = 0
    while True:
        path = _record_path(d, count + 1)
        if not path.exists():
            break
        data = path.read_bytes()
        try:
            _, prev_hash, rec_hash = decode_record(data)
        except ValueError as exc:
            raise PolicyError(
                "E_CHAIN", f"record {count + 1} at offset {offset}: {exc}"
            ) from None
        if prev_hash != prev:
            raise PolicyError(
                "E_CHAIN",
                f"record {count + 1} at offset {offset}: prev_hash does not match "
                f"previous record hash",
            )
        prev = rec_hash
        offset += len(data)
        count += 1
    if count != head_seq or prev != head_hash:
        raise PolicyError(
            "E_CHAIN",
            f"HEAD mismatch: HEAD says ({head_seq}, {head_hash}) but chain "
            f"computes ({count}, {prev})",
        )
    return count, prev


# ---------------------------------------------------------------- snapshots

def _snapshot_path(d: Path, seq: int) -> Path:
    return d / SNAPSHOTS_DIR / f"{seq:08d}.snap"


def _snapshot_doc(seq: int, head: str, state: dict) -> dict:
    content = {"seq": seq, "head": head, "state": state}
    canonical = json.dumps(content, sort_keys=True, separators=(",", ":"))
    return {**content, "checksum": hashlib.sha256(canonical.encode("utf-8")).hexdigest()}


def _load_snapshot(path: Path) -> dict:
    try:
        doc = json.loads(path.read_bytes())
        content = {"seq": doc["seq"], "head": doc["head"], "state": doc["state"]}
        checksum = doc["checksum"]
    except (ValueError, KeyError, TypeError, UnicodeDecodeError):
        raise ValueError("snapshot is truncated or malformed") from None
    canonical = json.dumps(content, sort_keys=True, separators=(",", ":"))
    if hashlib.sha256(canonical.encode("utf-8")).hexdigest() != checksum:
        raise ValueError("snapshot checksum mismatch")
    return content


def latest_snapshot(logdir) -> dict | None:
    d = Path(logdir) / SNAPSHOTS_DIR
    best = None
    if d.is_dir():
        for snap in sorted(d.glob("*.snap")):
            try:
                content = _load_snapshot(snap)
            except ValueError:
                continue
            if best is None or content["seq"] > best["seq"]:
                best = content
    return best


def snapshot(logdir) -> Path:
    """Write a snapshot of the replayed state at the current HEAD."""
    d = recover(logdir)
    seq, head = read_head(d)
    state = replay(d, use_snapshot=False)
    doc = _snapshot_doc(seq, head, state)
    data = json.dumps(doc, sort_keys=True).encode("utf-8")

    if os.environ.get(CRASH_ENV) == "mid_snapshot":
        # Crash point 3: a half-written snapshot becomes visible, then we die.
        tmp = d / TMP_SNAPSHOT
        with open(tmp, "wb") as fh:
            fh.write(data[: len(data) // 2])
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, _snapshot_path(d, seq))
        _fsync_dir(d / SNAPSHOTS_DIR)
        raise SimulatedCrash("simulated crash at mid_snapshot")

    tmp = d / TMP_SNAPSHOT
    with open(tmp, "wb") as fh:
        fh.write(data)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, _snapshot_path(d, seq))
    _fsync_dir(d / SNAPSHOTS_DIR)
    return _snapshot_path(d, seq)


# ---------------------------------------------------------------- replay

def _apply(data: dict, payload: bytes) -> None:
    try:
        text = payload.decode("utf-8")
    except UnicodeDecodeError:
        return
    parts = text.split(" ", 2)
    if parts[0] == "SET" and len(parts) == 3:
        data[parts[1]] = parts[2]
    elif parts[0] == "DEL" and len(parts) == 2:
        data.pop(parts[1], None)


def replay(logdir, use_snapshot: bool = True) -> dict:
    """Deterministically rebuild in-memory state up to HEAD.

    Returns {"count": n, "head": hash, "data": {...}}.
    """
    d = recover(logdir)
    head_seq, _ = read_head(d)
    state = {"count": 0, "head": GENESIS_HASH, "data": {}}
    start = 0
    if use_snapshot:
        snap = latest_snapshot(d)
        if snap is not None and snap["seq"] <= head_seq:
            state = {"count": snap["seq"], "head": snap["head"],
                     "data": dict(snap["state"]["data"])}
            start = snap["seq"]
    for seq in range(start + 1, head_seq + 1):
        data = _record_path(d, seq).read_bytes()
        try:
            payload, prev_hash, rec_hash = decode_record(data)
        except ValueError as exc:
            raise PolicyError("E_CHAIN", f"record {seq}: {exc}") from None
        if prev_hash != state["head"]:
            raise PolicyError("E_CHAIN", f"record {seq}: prev_hash mismatch")
        _apply(state["data"], payload)
        state["head"] = rec_hash
        state["count"] = seq
    return state

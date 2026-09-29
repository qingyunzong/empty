"""Append-only audit log with SHA256 hash chain, snapshots, verify and replay.

On-disk layout inside the log directory:

    audit.log            record lines: ``length|payload_b64|prev_hash|hash``
    audit.log.tmp        staged next generation of the log (crash point 1/2)
    HEAD                 ``"<count> <head_hash>"`` of the last committed record
    HEAD.tmp             staged HEAD update
    snapshot.json        latest complete snapshot (line1=checksum, line2=body)
    snapshot.json.tmp    staged snapshot (crash point 3)
    snapshot.json.bak    previous complete snapshot (fallback)

Append protocol: write temp record file, fsync, atomic rename, update HEAD.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
from dataclasses import dataclass
from pathlib import Path

ZERO_HASH = "0" * 64

LOG_NAME = "audit.log"
LOG_TMP_NAME = "audit.log.tmp"
HEAD_NAME = "HEAD"
HEAD_TMP_NAME = "HEAD.tmp"
SNAP_NAME = "snapshot.json"
SNAP_TMP_NAME = "snapshot.json.tmp"
SNAP_BAK_NAME = "snapshot.json.bak"

E_CHAIN = "E_CHAIN"
E_PAYLOAD = "E_PAYLOAD"


class PolicyError(Exception):
    """Policy violation. ``code`` is a stable machine-readable error code."""

    def __init__(self, code: str, message: str, offset: int | None = None,
                 index: int | None = None):
        super().__init__(message)
        self.code = code
        self.offset = offset
        self.index = index


@dataclass
class Record:
    index: int
    offset: int
    payload: bytes
    prev_hash: str
    hash: str


def compute_hash(payload: bytes, prev_hash: str) -> str:
    h = hashlib.sha256()
    h.update(str(len(payload)).encode("ascii"))
    h.update(b"|")
    h.update(payload)
    h.update(b"|")
    h.update(prev_hash.encode("ascii"))
    return h.hexdigest()


def encode_record(payload: bytes, prev_hash: str) -> bytes:
    body = base64.b64encode(payload).decode("ascii")
    digest = compute_hash(payload, prev_hash)
    return f"{len(payload)}|{body}|{prev_hash}|{digest}\n".encode("ascii")


def parse_records(data: bytes) -> list[Record]:
    """Parse and chain-validate records.

    Stops at the first bad record and raises PolicyError(E_CHAIN) locating
    it by byte offset and index; never guesses past a broken link.
    """
    records: list[Record] = []
    prev_hash = ZERO_HASH
    offset = 0
    for index, line in enumerate(data.splitlines(keepends=True)):
        if not line.endswith(b"\n"):
            raise PolicyError(E_CHAIN, f"record {index}: truncated line",
                              offset=offset, index=index)
        parts = line[:-1].split(b"|")
        if len(parts) != 4:
            raise PolicyError(E_CHAIN, f"record {index}: malformed fields",
                              offset=offset, index=index)
        try:
            length = int(parts[0])
            payload = base64.b64decode(parts[1], validate=True)
            prev_field = parts[2].decode("ascii")
            hash_field = parts[3].decode("ascii")
        except (ValueError, UnicodeDecodeError) as exc:
            raise PolicyError(E_CHAIN,
                              f"record {index}: undecodable fields",
                              offset=offset, index=index) from exc
        if len(payload) != length:
            raise PolicyError(E_CHAIN,
                              f"record {index}: length mismatch",
                              offset=offset, index=index)
        if prev_field != prev_hash:
            raise PolicyError(E_CHAIN,
                              f"record {index}: prev_hash chain break",
                              offset=offset, index=index)
        if compute_hash(payload, prev_field) != hash_field:
            raise PolicyError(E_CHAIN,
                              f"record {index}: hash mismatch",
                              offset=offset, index=index)
        records.append(Record(index=index, offset=offset, payload=payload,
                              prev_hash=prev_field, hash=hash_field))
        prev_hash = hash_field
        offset += len(line)
    return records


def apply_payload(state: dict, payload: bytes) -> None:
    try:
        text = payload.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise PolicyError(E_PAYLOAD, "payload is not valid UTF-8") from exc
    key, sep, value = text.partition("=")
    if not sep or not key:
        raise PolicyError(E_PAYLOAD, f"payload {text!r} is not key=value")
    state[key] = value


def _fsync_dir(path: Path) -> None:
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _write_atomic(tmp: Path, target: Path, data: bytes) -> None:
    with open(tmp, "wb") as fh:
        fh.write(data)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, target)
    _fsync_dir(target.parent)


def read_head(directory: Path) -> tuple[int, str]:
    head_file = directory / HEAD_NAME
    if not head_file.exists():
        return 0, ZERO_HASH
    try:
        count_s, hash_s = head_file.read_text("ascii").split()
        count = int(count_s)
    except (ValueError, UnicodeDecodeError):
        return 0, ZERO_HASH
    if count < 0 or len(hash_s) != 64:
        return 0, ZERO_HASH
    return count, hash_s


def write_head(directory: Path, count: int, head_hash: str) -> None:
    _write_atomic(directory / HEAD_TMP_NAME, directory / HEAD_NAME,
                  f"{count} {head_hash}\n".encode("ascii"))


def encode_snapshot(count: int, head_hash: str, state: dict) -> bytes:
    body = json.dumps({"count": count, "head": head_hash, "state": state},
                      sort_keys=True, separators=(",", ":"))
    checksum = hashlib.sha256(body.encode("utf-8")).hexdigest()
    return f"{checksum}\n{body}\n".encode("utf-8")


def decode_snapshot(data: bytes) -> dict | None:
    """Return {"count", "head", "state"} or None if incomplete/corrupt."""
    try:
        checksum, body = data.decode("utf-8").splitlines()[:2]
    except (ValueError, UnicodeDecodeError):
        return None
    if hashlib.sha256(body.encode("utf-8")).hexdigest() != checksum:
        return None
    try:
        parsed = json.loads(body)
    except json.JSONDecodeError:
        return None
    if (not isinstance(parsed, dict) or not isinstance(parsed.get("count"), int)
            or not isinstance(parsed.get("head"), str)
            or not isinstance(parsed.get("state"), dict)):
        return None
    return parsed


def load_snapshot(directory: Path) -> dict | None:
    snap = directory / SNAP_NAME
    if not snap.exists():
        return None
    return decode_snapshot(snap.read_bytes())


def write_snapshot(directory: Path, count: int, head_hash: str,
                   state: dict) -> None:
    snap = directory / SNAP_NAME
    if snap.exists():
        os.replace(snap, directory / SNAP_BAK_NAME)
    _write_atomic(directory / SNAP_TMP_NAME, snap,
                  encode_snapshot(count, head_hash, state))


def recover(directory: Path) -> None:
    """Startup recovery for the three defined crash points.

    1. crash before rename: a staged ``audit.log.tmp`` is discarded and the
       staged record is lost.
    2. crash after rename with stale HEAD: valid tail records are scanned and
       HEAD is rebuilt to cover them.
    3. half-written snapshot: staged/corrupt snapshot is removed and the
       previous complete snapshot is restored.
    """
    for tmp in (LOG_TMP_NAME, HEAD_TMP_NAME, SNAP_TMP_NAME):
        stale = directory / tmp
        if stale.exists():
            stale.unlink()

    snap = directory / SNAP_NAME
    if snap.exists() and decode_snapshot(snap.read_bytes()) is None:
        snap.unlink()
        bak = directory / SNAP_BAK_NAME
        if bak.exists():
            if decode_snapshot(bak.read_bytes()) is not None:
                os.replace(bak, snap)
            else:
                bak.unlink()

    log_file = directory / LOG_NAME
    data = log_file.read_bytes() if log_file.exists() else b""
    records = parse_records(data)
    count, head_hash = read_head(directory)
    if count > len(records):
        raise PolicyError(E_CHAIN,
                          f"HEAD references {count} records but log has "
                          f"{len(records)}")
    expected = records[count - 1].hash if count else ZERO_HASH
    if head_hash != expected:
        raise PolicyError(E_CHAIN, "HEAD does not match log prefix")
    if len(records) > count:
        write_head(directory, len(records), records[-1].hash)


class AuditLog:
    def __init__(self, directory: str | os.PathLike, snapshot_every: int = 10):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.snapshot_every = snapshot_every
        recover(self.directory)

    def _log_bytes(self) -> bytes:
        log_file = self.directory / LOG_NAME
        return log_file.read_bytes() if log_file.exists() else b""

    def records(self) -> list[Record]:
        return parse_records(self._log_bytes())

    def append(self, payload: bytes) -> Record:
        apply_payload({}, payload)  # only replayable payloads are admitted
        data = self._log_bytes()
        records = parse_records(data)
        prev_hash = records[-1].hash if records else ZERO_HASH
        new_data = data + encode_record(payload, prev_hash)
        _write_atomic(self.directory / LOG_TMP_NAME,
                      self.directory / LOG_NAME, new_data)
        count = len(records) + 1
        head_hash = compute_hash(payload, prev_hash)
        write_head(self.directory, count, head_hash)
        if self.snapshot_every and count % self.snapshot_every == 0:
            self.snapshot()
        return Record(index=count - 1, offset=len(data), payload=payload,
                      prev_hash=prev_hash, hash=head_hash)

    def verify(self) -> int:
        return len(self.records())

    def replay(self) -> dict:
        records = self.records()
        snap = load_snapshot(self.directory)
        state: dict = {}
        start = 0
        if snap is not None and 0 <= snap["count"] <= len(records):
            boundary = (records[snap["count"] - 1].hash
                        if snap["count"] else ZERO_HASH)
            if boundary == snap["head"]:
                state = dict(snap["state"])
                start = snap["count"]
        for record in records[start:]:
            apply_payload(state, record.payload)
        return state

    def snapshot(self) -> None:
        records = self.records()
        state: dict = {}
        for record in records:
            apply_payload(state, record.payload)
        head_hash = records[-1].hash if records else ZERO_HASH
        write_snapshot(self.directory, len(records), head_hash, state)

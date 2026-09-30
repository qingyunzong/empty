"""Core pull logic for winsync.

Segment log model
-----------------
SRC is a directory of ``.seg`` files. A file name is ``<seq>.seg`` or
``<seq>.<tag>.seg`` (a duplicate delivery of the same segment). The
leading decimal integer is the segment sequence number.

A segment file contains exactly one record::

    <8 lowercase hex chars of crc32(payload)> "\n" <payload bytes>

The payload must be valid UTF-8. A segment whose CRC does not match,
whose framing is malformed, or whose payload is not UTF-8 is *corrupt*.

Recovery model
--------------
The ACK file (JSON ``{"high_watermark": N}``) is the authoritative
commit watermark. DST is a JSONL file whose line i holds the record for
seq i. On startup DST is reconciled against the ACK watermark: extra
lines (crash after DST write, before ACK write) are truncated, so
already-committed records never re-enter DST.
"""

from __future__ import annotations

import json
import os
import re
import zlib
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

SEGMENT_RE = re.compile(r"^(\d+)(?:\.[0-9A-Za-z_-]+)*\.seg$")
CRC_HEX_LEN = 8
CRASH_ENV = "WINSYNC_CRASH_AFTER_DST"


class PullError(Exception):
    """Fatal pull error (maps to CLI exit code 1)."""


@dataclass
class PullResult:
    high_watermark: int
    quarantined: list[int]
    committed: int
    resumed_from: int
    dst: str
    ack: str


def parse_segment_name(name: str) -> int | None:
    """Return the sequence number encoded in a segment file name."""
    match = SEGMENT_RE.match(name)
    if match is None:
        return None
    return int(match.group(1), 10)


def format_segment(payload: bytes) -> bytes:
    """Build the on-disk bytes of a segment carrying ``payload``."""
    crc = zlib.crc32(payload) & 0xFFFFFFFF
    return b"%08x\n" % crc + payload


def load_payload(path: Path) -> bytes | None:
    """Read and validate a segment file.

    Returns the payload bytes, or ``None`` when the segment is corrupt
    (bad framing, CRC mismatch, non-UTF-8 payload, unreadable file).
    """
    try:
        data = Path(path).read_bytes()
    except OSError:
        return None
    if len(data) < CRC_HEX_LEN + 1:
        return None
    head = data[:CRC_HEX_LEN]
    sep = data[CRC_HEX_LEN:CRC_HEX_LEN + 1]
    payload = data[CRC_HEX_LEN + 1:]
    if sep != b"\n":
        return None
    try:
        expected = int(head.decode("ascii"), 16)
    except (ValueError, UnicodeDecodeError):
        return None
    if zlib.crc32(payload) & 0xFFFFFFFF != expected:
        return None
    try:
        payload.decode("utf-8")
    except UnicodeDecodeError:
        return None
    return payload


def discover_segments(src: Path) -> dict[int, Path]:
    """Map seq -> segment path. Duplicates resolve to the first name."""
    segments: dict[int, Path] = {}
    for entry in sorted(Path(src).iterdir()):
        if not entry.is_file():
            continue
        seq = parse_segment_name(entry.name)
        if seq is None:
            continue
        segments.setdefault(seq, entry)
    return segments


def read_ack(path: Path) -> int:
    """Read the ACK watermark; a missing file means 0."""
    path = Path(path)
    if not path.exists():
        return 0
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        watermark = int(data["high_watermark"])
    except (ValueError, KeyError, TypeError) as exc:
        raise PullError(f"invalid ack file {path}: {exc}") from exc
    if watermark < 0:
        raise PullError(f"invalid ack file {path}: negative watermark")
    return watermark


def write_ack(path: Path, watermark: int) -> None:
    """Atomically persist the ACK watermark (tmp file + rename)."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(json.dumps({"high_watermark": watermark}) + "\n")
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)


def _dst_lines(path: Path) -> list[str]:
    if not Path(path).exists():
        return []
    with open(path, encoding="utf-8") as fh:
        return [line for line in fh if line.strip()]


def _truncate_dst(path: Path, keep: int) -> None:
    lines = _dst_lines(path)[:keep]
    with open(path, "w", encoding="utf-8") as fh:
        for line in lines:
            fh.write(line if line.endswith("\n") else line + "\n")
        fh.flush()
        os.fsync(fh.fileno())


def _append_dst(path: Path, records: list[tuple[int, bytes]]) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a", encoding="utf-8") as fh:
        for seq, payload in records:
            line = json.dumps(
                {"seq": seq, "payload": payload.decode("utf-8")},
                ensure_ascii=False,
            )
            fh.write(line + "\n")
        fh.flush()
        os.fsync(fh.fileno())


def _validate_windowed(seqs, segments, window):
    """Validate segments in seq order with at most ``window`` in flight.

    The sliding window bounds concurrency; results are identical for any
    window size because every seq is validated exactly once and commit
    decisions are made afterwards in strict seq order.
    """
    results = {}
    if not seqs:
        return results
    with ThreadPoolExecutor(max_workers=window) as pool:
        pending = {}
        submitted = 0
        while submitted < len(seqs) and submitted < window:
            seq = seqs[submitted]
            pending[seq] = pool.submit(load_payload, segments[seq])
            submitted += 1
        for seq in seqs:
            results[seq] = pending.pop(seq).result()
            if submitted < len(seqs):
                nxt = seqs[submitted]
                pending[nxt] = pool.submit(load_payload, segments[nxt])
                submitted += 1
    return results


def pull(src, dst, ack, window: int = 1) -> PullResult:
    """Pull records from the segment log at ``src`` into ``dst``.

    Corrupt segments are reported in ``quarantined``; the commit
    watermark only advances across a contiguous run of present, valid
    segments starting at the resumed watermark, so it never regresses
    and never skips a segment.
    """
    if window < 1:
        raise PullError(f"window must be >= 1, got {window}")
    src, dst, ack = Path(src), Path(dst), Path(ack)
    if not src.is_dir():
        raise PullError(f"source is not a directory: {src}")

    watermark = read_ack(ack)

    # Reconcile DST with the authoritative ACK watermark. A crash between
    # the DST write and the ACK write leaves extra DST lines; truncating
    # them keeps recovery free of duplicates.
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst_lines = _dst_lines(dst)
    if len(dst_lines) > watermark:
        _truncate_dst(dst, watermark)
    elif len(dst_lines) < watermark:
        watermark = len(dst_lines)
    if not dst.exists():
        dst.touch()

    resumed_from = watermark
    segments = discover_segments(src)
    seqs = sorted(seq for seq in segments if seq >= watermark)
    results = _validate_windowed(seqs, segments, window)
    quarantined = sorted(seq for seq in seqs if results[seq] is None)

    new_records = []
    cursor = watermark
    while cursor in results and results[cursor] is not None:
        new_records.append((cursor, results[cursor]))
        cursor += 1

    if new_records:
        _append_dst(dst, new_records)
        if os.environ.get(CRASH_ENV):
            # Fault-injection hook: crash after the DST write but
            # before the ACK write, to exercise recovery.
            os._exit(1)
    write_ack(ack, cursor)

    return PullResult(
        high_watermark=cursor,
        quarantined=quarantined,
        committed=cursor - resumed_from,
        resumed_from=resumed_from,
        dst=str(dst),
        ack=str(ack),
    )

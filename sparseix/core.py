"""Core segment-index logic for sparseix.

Index file layout (little-endian)::

    magic   4s   b"SPIX"
    version u32  currently 1
    count   u32  number of segment records
    records count * (u64 start, u64 length, u32 crc32)

Records are stored sorted by ``start``, strictly ascending and
non-overlapping. ``crc32`` covers the segment's data bytes in the target
file. Holes (offsets not covered by any segment) read back as 0x00.
"""

from __future__ import annotations

import bisect
import os
import struct
import zlib

MAGIC = b"SPIX"
VERSION = 1

_HEADER = struct.Struct("<4sII")
_RECORD = struct.Struct("<QQI")


class IndexCorrupt(Exception):
    """Raised when an index file violates the format or its invariants."""


class Segment:
    __slots__ = ("start", "length", "crc32")

    def __init__(self, start: int, length: int, crc32: int = 0) -> None:
        self.start = start
        self.length = length
        self.crc32 = crc32

    @property
    def end(self) -> int:
        return self.start + self.length

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"Segment(start={self.start}, length={self.length}, crc32={self.crc32:#010x})"

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, Segment):
            return NotImplemented
        return (
            self.start == other.start
            and self.length == other.length
            and self.crc32 == other.crc32
        )


def index_path(target: str) -> str:
    """Return the sidecar index path for a target file."""
    return target + ".idx"


def load_index(path: str) -> list[Segment]:
    """Load and validate an index file.

    A missing index file yields an empty segment list. Any format
    violation raises :class:`IndexCorrupt`.
    """
    if not os.path.exists(path):
        return []
    with open(path, "rb") as fh:
        data = fh.read()
    if len(data) < _HEADER.size:
        raise IndexCorrupt(f"{path}: truncated header")
    magic, version, count = _HEADER.unpack_from(data, 0)
    if magic != MAGIC:
        raise IndexCorrupt(f"{path}: bad magic {magic!r}")
    if version != VERSION:
        raise IndexCorrupt(f"{path}: unsupported version {version}")
    expected = _HEADER.size + count * _RECORD.size
    if len(data) != expected:
        raise IndexCorrupt(
            f"{path}: size mismatch (have {len(data)} bytes, expect {expected})"
        )
    segments: list[Segment] = []
    offset = _HEADER.size
    prev_end = 0
    for _ in range(count):
        start, length, crc32 = _RECORD.unpack_from(data, offset)
        offset += _RECORD.size
        if length == 0:
            raise IndexCorrupt(f"{path}: zero-length segment at {start}")
        if segments and start < prev_end:
            raise IndexCorrupt(
                f"{path}: segments not strictly ascending/non-overlapping at {start}"
            )
        segments.append(Segment(start, length, crc32))
        prev_end = start + length
    return segments


def save_index(path: str, segments: list[Segment]) -> None:
    """Persist segments to the index file (must already be canonical)."""
    out = bytearray()
    out += _HEADER.pack(MAGIC, VERSION, len(segments))
    for seg in segments:
        out += _RECORD.pack(seg.start, seg.length, seg.crc32)
    with open(path, "wb") as fh:
        fh.write(out)


def _read_at(fh, offset: int, length: int) -> bytes:
    fh.seek(offset)
    return fh.read(length)


def write(target: str, offset: int, data: bytes) -> None:
    """Write ``data`` at ``offset`` in ``target``, merging the index.

    Existing segments that overlap or touch the new range are merged with
    it (new bytes win) so the index stays minimal: strictly ascending,
    non-overlapping, and non-adjacent.
    """
    if offset < 0:
        raise ValueError("offset must be non-negative")
    if len(data) == 0:
        raise ValueError("zero-length writes are forbidden")

    idx = index_path(target)
    segments = load_index(idx)
    end = offset + len(data)

    starts = [seg.start for seg in segments]
    # First segment whose end >= offset (i.e. overlapping or touching on
    # the left); then extend over all segments with start <= end.
    lo = bisect.bisect_left(starts, offset)
    if lo > 0 and segments[lo - 1].end >= offset:
        lo -= 1
    hi = lo
    while hi < len(segments) and segments[hi].start <= end:
        hi += 1

    merged_start = min(offset, segments[lo].start) if hi > lo else offset
    merged_end = max(end, segments[hi - 1].end) if hi > lo else end
    buf = bytearray(merged_end - merged_start)

    mode = "r+b" if os.path.exists(target) else "w+b"
    with open(target, mode) as fh:
        for seg in segments[lo:hi]:
            chunk = _read_at(fh, seg.start, seg.length)
            if len(chunk) != seg.length:
                raise IndexCorrupt(
                    f"{target}: segment at {seg.start} extends past end of data"
                )
            buf[seg.start - merged_start : seg.end - merged_start] = chunk
        buf[offset - merged_start : end - merged_start] = data
        fh.seek(offset)
        fh.write(data)

    merged = Segment(merged_start, merged_end - merged_start, zlib.crc32(buf))
    segments[lo:hi] = [merged]
    save_index(idx, segments)


def read(target: str, offset: int, length: int) -> bytes:
    """Read ``length`` bytes at ``offset``; holes return 0x00."""
    if offset < 0:
        raise ValueError("offset must be non-negative")
    if length < 0:
        raise ValueError("length must be non-negative")
    result = bytearray(length)
    if length == 0:
        return bytes(result)

    segments = load_index(index_path(target))
    if not segments:
        return bytes(result)

    end = offset + length
    starts = [seg.start for seg in segments]
    # Invariant (strictly ascending, non-overlapping) guarantees at most
    # one segment covers any given byte, so a linear sweep from the first
    # candidate collects every hit without ambiguity.
    i = bisect.bisect_right(starts, offset) - 1
    if i < 0:
        i = 0
    with open(target, "rb") as fh:
        while i < len(segments) and segments[i].start < end:
            seg = segments[i]
            lo = max(offset, seg.start)
            hi = min(end, seg.end)
            if lo < hi:
                chunk = _read_at(fh, lo, hi - lo)
                result[lo - offset : lo - offset + len(chunk)] = chunk
            i += 1
    return bytes(result)


def check(target: str) -> int:
    """Validate the index and every segment's crc32 against the data file.

    Returns the number of segments. Raises :class:`IndexCorrupt` on any
    inconsistency.
    """
    segments = load_index(index_path(target))
    with open(target, "rb") as fh:
        for seg in segments:
            chunk = _read_at(fh, seg.start, seg.length)
            if len(chunk) != seg.length:
                raise IndexCorrupt(
                    f"{target}: segment at {seg.start} extends past end of data"
                )
            if zlib.crc32(chunk) != seg.crc32:
                raise IndexCorrupt(f"{target}: crc32 mismatch at {seg.start}")
    return len(segments)

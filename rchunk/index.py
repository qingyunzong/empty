"""Chunk index (.chunk) format, validation and lookup.

Text format, one header line plus one line per chunk::

    RCHUNK1
    <offset> <length> <sha256-hex>
    ...

Offsets are 0-based byte positions in the data stream. A well-formed
index is sorted by ascending offset and tiles the data contiguously:
the first offset is 0 and every subsequent offset equals the previous
offset plus the previous length. Any gap or overlap is Corrupt.
"""

from __future__ import annotations

import bisect
import hashlib
from dataclasses import dataclass

MAGIC = "RCHUNK1"


class CorruptError(Exception):
    """Raised when an index or the data it describes is corrupt.

    ``offset`` is the smallest offset known to be bad, when applicable.
    """

    def __init__(self, message: str, offset: int | None = None) -> None:
        super().__init__(message)
        self.offset = offset


@dataclass(frozen=True)
class ChunkEntry:
    offset: int
    length: int
    sha256: bytes

    @property
    def end(self) -> int:
        return self.offset + self.length


def hash_chunk(data: bytes, offset: int, length: int) -> bytes:
    return hashlib.sha256(data[offset:offset + length]).digest()


def entries_from_data(data: bytes, chunks: list[tuple[int, int]]) -> list[ChunkEntry]:
    return [
        ChunkEntry(offset, length, hash_chunk(data, offset, length))
        for offset, length in chunks
    ]


def dumps(entries: list[ChunkEntry]) -> bytes:
    """Serialize an index. Entries must already be structurally valid."""
    _check_structure(entries)
    lines = [MAGIC]
    for entry in entries:
        lines.append(f"{entry.offset} {entry.length} {entry.sha256.hex()}")
    return ("\n".join(lines) + "\n").encode("ascii")


def loads(raw: bytes) -> list[ChunkEntry]:
    """Parse and structurally validate an index.

    Raises CorruptError on any malformed line, unsorted offsets, gaps
    or overlaps.
    """
    try:
        text = raw.decode("ascii")
    except UnicodeDecodeError as exc:
        raise CorruptError("index is not ASCII text") from exc
    lines = text.split("\n")
    if not lines or lines[0] != MAGIC:
        raise CorruptError("bad index header")
    entries: list[ChunkEntry] = []
    for lineno, line in enumerate(lines[1:], start=2):
        if line == "" and lineno == len(lines):
            continue  # single trailing newline
        parts = line.split(" ")
        if len(parts) != 3:
            raise CorruptError(f"line {lineno}: expected 3 fields")
        offset_s, length_s, digest_hex = parts
        try:
            offset = int(offset_s)
            length = int(length_s)
        except ValueError as exc:
            raise CorruptError(f"line {lineno}: non-integer offset/length") from exc
        if offset < 0 or length <= 0:
            raise CorruptError(
                f"line {lineno}: negative offset or non-positive length",
                offset=max(offset, 0),
            )
        if len(digest_hex) != 64:
            raise CorruptError(f"line {lineno}: sha256 must be 64 hex chars", offset=offset)
        try:
            digest = bytes.fromhex(digest_hex)
        except ValueError as exc:
            raise CorruptError(f"line {lineno}: bad sha256 hex", offset=offset) from exc
        entries.append(ChunkEntry(offset, length, digest))
    _check_structure(entries)
    return entries


def _check_structure(entries: list[ChunkEntry]) -> None:
    """Enforce ascending, contiguous, non-overlapping offsets."""
    expected = 0
    for entry in entries:
        if entry.offset != expected:
            kind = "overlap" if entry.offset < expected else "gap"
            raise CorruptError(
                f"index {kind} at offset {entry.offset} (expected {expected})",
                offset=min(entry.offset, expected),
            )
        if entry.length <= 0:
            raise CorruptError(
                f"non-positive length at offset {entry.offset}", offset=entry.offset
            )
        expected = entry.offset + entry.length


def verify(entries: list[ChunkEntry], data: bytes) -> None:
    """Verify *data* against the index.

    Checks that the index tiles the whole data exactly and that every
    chunk's sha256 matches. Raises CorruptError reporting the smallest
    offset of the first bad chunk.
    """
    _check_structure(entries)
    total = entries[-1].end if entries else 0
    if total != len(data):
        raise CorruptError(
            f"index covers {total} bytes but data has {len(data)}",
            offset=min(total, len(data)),
        )
    for entry in entries:
        actual = hash_chunk(data, entry.offset, entry.length)
        if actual != entry.sha256:
            raise CorruptError(
                f"sha256 mismatch at offset {entry.offset}", offset=entry.offset
            )


def locate(entries: list[ChunkEntry], position: int) -> ChunkEntry:
    """Return the (smallest) chunk covering byte *position*."""
    if not entries:
        raise CorruptError("empty index")
    if position < 0 or position >= entries[-1].end:
        raise CorruptError(
            f"position {position} out of range",
            offset=min(max(position, 0), entries[-1].end),
        )
    starts = [entry.offset for entry in entries]
    idx = bisect.bisect_right(starts, position) - 1
    return entries[idx]

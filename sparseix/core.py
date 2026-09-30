"""Core sparse-region index logic for sparseix."""

from __future__ import annotations

import bisect
import os
import struct
import zlib
from dataclasses import dataclass

MAGIC = b"SPIX"
VERSION = 1
HEADER = struct.Struct("<4sII")
RECORD = struct.Struct("<QQI")


class IndexCorrupt(Exception):
    """Raised when the on-disk index violates structural or checksum rules."""


@dataclass
class Segment:
    start: int
    length: int
    crc32: int

    @property
    def end(self) -> int:
        return self.start + self.length


class SparseFile:
    """A sparse data file plus its segment index (<path>.idx).

    Invariants maintained after every mutation:
      * segments sorted strictly ascending by start;
      * no two segments overlap or touch (adjacent ones are merged);
      * every segment has length > 0 and a crc32 matching its data bytes.
    """

    def __init__(self, path: str):
        self.path = path
        self.index_path = path + ".idx"
        self._segments: list[Segment] = []
        self._starts: list[int] = []
        if os.path.exists(self.index_path):
            self._segments = self._read_index(self.index_path)
            self._verify_crc(self._segments)
            self._starts = [s.start for s in self._segments]
        if not os.path.exists(self.path):
            open(self.path, "wb").close()

    # ------------------------------------------------------------------ index

    @staticmethod
    def _read_index(index_path: str) -> list[Segment]:
        with open(index_path, "rb") as fh:
            raw = fh.read()
        if len(raw) < HEADER.size:
            raise IndexCorrupt("truncated index header")
        magic, version, count = HEADER.unpack_from(raw, 0)
        if magic != MAGIC:
            raise IndexCorrupt(f"bad magic {magic!r}")
        if version != VERSION:
            raise IndexCorrupt(f"unsupported index version {version}")
        if len(raw) != HEADER.size + count * RECORD.size:
            raise IndexCorrupt("index size does not match record count")
        segments: list[Segment] = []
        offset = HEADER.size
        for _ in range(count):
            start, length, crc = RECORD.unpack_from(raw, offset)
            offset += RECORD.size
            if length == 0:
                raise IndexCorrupt("zero-length segment in index")
            if segments and start < segments[-1].end:
                raise IndexCorrupt(
                    "index records not strictly ascending or overlapping"
                )
            segments.append(Segment(start, length, crc))
        return segments

    def _verify_crc(self, segments: list[Segment]) -> None:
        if not segments:
            return
        if not os.path.exists(self.path):
            raise IndexCorrupt("index exists but data file is missing")
        with open(self.path, "rb") as fh:
            for seg in segments:
                fh.seek(seg.start)
                data = fh.read(seg.length)
                if len(data) != seg.length:
                    raise IndexCorrupt(
                        f"segment at {seg.start} extends past end of data file"
                    )
                if zlib.crc32(data) & 0xFFFFFFFF != seg.crc32:
                    raise IndexCorrupt(f"crc32 mismatch for segment at {seg.start}")

    def _save_index(self) -> None:
        tmp = self.index_path + ".tmp"
        with open(tmp, "wb") as fh:
            fh.write(HEADER.pack(MAGIC, VERSION, len(self._segments)))
            for seg in self._segments:
                fh.write(RECORD.pack(seg.start, seg.length, seg.crc32))
        os.replace(tmp, self.index_path)

    # ---------------------------------------------------------------- queries

    @property
    def segments(self) -> list[tuple[int, int]]:
        """Snapshot of (start, length) for every indexed segment."""
        return [(s.start, s.length) for s in self._segments]

    def check(self) -> bool:
        """Re-validate the on-disk index from scratch; raise IndexCorrupt."""
        segments = self._read_index(self.index_path)
        self._verify_crc(segments)
        return True

    def read(self, offset: int, length: int) -> bytes:
        """Read length bytes at offset; unwritten bytes are 0x00."""
        if offset < 0:
            raise ValueError("offset must be >= 0")
        if length < 0:
            raise ValueError("length must be >= 0")
        buf = bytearray(length)
        if length == 0:
            return bytes(buf)
        end = offset + length
        # Binary search: last segment with start <= offset may cover offset.
        i = bisect.bisect_right(self._starts, offset) - 1
        if i < 0:
            i = 0
        with open(self.path, "rb") as fh:
            while i < len(self._segments) and self._segments[i].start < end:
                seg = self._segments[i]
                lo = max(seg.start, offset)
                hi = min(seg.end, end)
                if lo < hi:
                    fh.seek(lo)
                    buf[lo - offset : hi - offset] = fh.read(hi - lo)
                i += 1
        return bytes(buf)

    # --------------------------------------------------------------- mutation

    def write(self, offset: int, data: bytes) -> None:
        """Write data at offset, merging overlapping/adjacent segments.

        New bytes override old ones; the resulting segment set stays minimal.
        """
        if offset < 0:
            raise ValueError("offset must be >= 0")
        data = bytes(data)
        if len(data) == 0:
            raise ValueError("zero-length writes are forbidden")
        new_start = offset
        new_end = offset + len(data)

        # Binary search for the merge window [left, right): every segment
        # with start <= new_end and end >= new_start overlaps or touches.
        right = bisect.bisect_right(self._starts, new_end)
        left = bisect.bisect_left(self._starts, new_start)
        if left > 0 and self._segments[left - 1].end >= new_start:
            left -= 1

        absorbed = self._segments[left:right]
        merged_start = min(new_start, absorbed[0].start if absorbed else new_start)
        merged_end = max(new_end, absorbed[-1].end if absorbed else new_end)

        merged = bytearray(merged_end - merged_start)
        with open(self.path, "rb") as fh:
            for seg in absorbed:
                fh.seek(seg.start)
                chunk = fh.read(seg.length)
                merged[seg.start - merged_start : seg.end - merged_start] = chunk
        merged[new_start - merged_start : new_end - merged_start] = data

        with open(self.path, "r+b") as fh:
            fh.seek(merged_start)
            fh.write(merged)

        record = Segment(merged_start, len(merged), zlib.crc32(merged) & 0xFFFFFFFF)
        self._segments[left:right] = [record]
        self._starts[left:right] = [record.start]
        self._save_index()

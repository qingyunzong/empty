"""Explicit, ordered UTC-offset transition tables.

A table is a contiguous, non-overlapping chain of segments.  Each segment
states the UTC offset (in seconds, arbitrary historical values such as
+08:05:43 are allowed) that applies to the half-open UTC range
``[utc_start, utc_end)``.  ``None`` means an open end (infinity).

Tables support atomic incremental revision: ``revise`` validates the whole
result before swapping anything in, so an illegal (overlapping / gapped)
revision is rejected without touching the live table, its version or its
cache.  ``snapshot`` freezes the current segments so historical queries keep
being answered under the old rules.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True)
class Segment:
    seg_id: str
    utc_start: Optional[int]   # None = -infinity
    utc_end: Optional[int]     # None = +infinity
    offset_seconds: int

    def local_start(self) -> Optional[int]:
        return None if self.utc_start is None else self.utc_start + self.offset_seconds

    def local_end(self) -> Optional[int]:
        return None if self.utc_end is None else self.utc_end + self.offset_seconds

    def contains_utc(self, instant: int) -> bool:
        if self.utc_start is not None and instant < self.utc_start:
            return False
        if self.utc_end is not None and instant >= self.utc_end:
            return False
        return True

    def contains_local(self, local: int) -> bool:
        ls, le = self.local_start(), self.local_end()
        if ls is not None and local < ls:
            return False
        if le is not None and local >= le:
            return False
        return True

    def to_json(self) -> dict:
        return {
            "id": self.seg_id,
            "utc_start": self.utc_start,
            "utc_end": self.utc_end,
            "offset_seconds": self.offset_seconds,
        }

    @staticmethod
    def from_json(obj: dict) -> "Segment":
        return Segment(
            seg_id=str(obj["id"]),
            utc_start=obj.get("utc_start"),
            utc_end=obj.get("utc_end"),
            offset_seconds=int(obj["offset_seconds"]),
        )


def _validate_chain(segments: list[Segment]) -> None:
    """Require strict ordering and exact contiguity (no overlap, no gap)."""
    if not segments:
        raise ValueError("table needs at least one segment")
    for prev, nxt in zip(segments, segments[1:]):
        if prev.utc_end is None:
            raise ValueError(f"segment {prev.seg_id!r} is open-ended but not last")
        if nxt.utc_start is None:
            raise ValueError(f"segment {nxt.seg_id!r} is open-started but not first")
        if prev.utc_end > nxt.utc_start:
            raise ValueError(
                f"segments {prev.seg_id!r} and {nxt.seg_id!r} overlap "
                f"({prev.utc_end} > {nxt.utc_start})"
            )
        if prev.utc_end < nxt.utc_start:
            raise ValueError(
                f"gap between segments {prev.seg_id!r} and {nxt.seg_id!r}"
            )
        if prev.utc_start is not None and prev.utc_end <= prev.utc_start:
            raise ValueError(f"segment {prev.seg_id!r} has empty range")
    first, last = segments[0], segments[-1]
    if first.utc_start is not None and first.utc_end is not None and first.utc_end <= first.utc_start:
        raise ValueError(f"segment {first.seg_id!r} has empty range")
    if last.utc_start is not None and last.utc_end is not None and last.utc_end <= last.utc_start:
        raise ValueError(f"segment {last.seg_id!r} has empty range")


class MappingCache:
    """Versioned memoisation of local->candidates results.

    Incremental revision invalidates only the wall-clock range that the
    changed UTC span can map to (under either the old or the new offsets);
    everything outside survives, which is what makes the recompute
    incremental rather than a full flush.
    """

    def __init__(self) -> None:
        self._store: dict[int, tuple] = {}
        self.hits = 0
        self.misses = 0

    def get(self, local_seconds: int):
        if local_seconds in self._store:
            self.hits += 1
            return self._store[local_seconds]
        self.misses += 1
        return None

    def put(self, local_seconds: int, value: tuple) -> None:
        self._store[local_seconds] = value

    def invalidate_range(self, lo: Optional[int], hi: Optional[int]) -> int:
        if lo is None or hi is None:
            n = len(self._store)
            self._store.clear()
            return n
        doomed = [k for k in self._store if lo <= k < hi]
        for k in doomed:
            del self._store[k]
        return len(doomed)

    def keys(self):
        return set(self._store)


class OffsetTable:
    """A live, revisable transition table with a versioned cache."""

    def __init__(self, segments: list[Segment], version: int = 1):
        _validate_chain(list(segments))
        self._segments = tuple(segments)
        self.version = version
        self.cache = MappingCache()

    @property
    def segments(self) -> tuple[Segment, ...]:
        return self._segments

    def snapshot(self) -> "Snapshot":
        """Freeze the current table; later revisions never affect it."""
        return Snapshot(self._segments, self.version)

    def revise(self, new_segments: list[Segment]) -> "OffsetTable":
        """Atomically splice ``new_segments`` into the table.

        The replacement span ``[lo, hi)`` must align with existing segment
        boundaries (or the open table ends).  Any overlap or gap inside the
        revision, or any misalignment, raises ValueError and leaves the
        table, version and cache completely untouched.
        """
        new = list(new_segments)
        _validate_chain(new)  # rejects overlapping revision segments
        lo, hi = new[0].utc_start, new[-1].utc_end

        kept_before, kept_after = [], []
        for seg in self._segments:
            seg_lo = seg.utc_start
            seg_hi = seg.utc_end
            overlaps_lo = lo is None or (seg_hi is None or seg_hi > lo)
            overlaps_hi = hi is None or seg_lo is None or seg_lo < hi
            if not overlaps_lo or not overlaps_hi:
                # entirely outside the replacement span
                if seg_hi is not None and lo is not None and seg_hi <= lo:
                    kept_before.append(seg)
                else:
                    kept_after.append(seg)
                continue
            # intersects the span: only exact boundary alignment is legal
            if seg_lo is not None and lo is not None and seg_lo < lo and (seg_hi is None or seg_hi > lo):
                raise ValueError(
                    f"revision start {lo} cuts through segment {seg.seg_id!r}"
                )
            if seg_hi is not None and hi is not None and seg_hi > hi and (seg_lo is None or seg_lo < hi):
                raise ValueError(
                    f"revision end {hi} cuts through segment {seg.seg_id!r}"
                )
            # fully covered by the span -> dropped
        merged = kept_before + new + kept_after
        _validate_chain(merged)  # final whole-table check

        # ---- everything below is the atomic commit ----
        old_span = [s for s in self._segments
                    if (lo is None or s.utc_end is None or s.utc_end > lo)
                    and (hi is None or s.utc_start is None or s.utc_start < hi)]
        offsets = [s.offset_seconds for s in old_span] + [s.offset_seconds for s in new]
        off_lo, off_hi = min(offsets), max(offsets)
        inv_lo = None if lo is None else lo + off_lo
        inv_hi = None if hi is None else hi + off_hi
        self._segments = tuple(merged)
        self.version += 1
        self.cache.invalidate_range(inv_lo, inv_hi)
        return self

    def to_json(self) -> dict:
        return {"version": self.version,
                "segments": [s.to_json() for s in self._segments]}

    @staticmethod
    def from_json(obj: dict) -> "OffsetTable":
        return OffsetTable([Segment.from_json(s) for s in obj["segments"]],
                           version=int(obj.get("version", 1)))


class Snapshot:
    """An immutable historical view of a table at one version."""

    def __init__(self, segments: tuple[Segment, ...], version: int):
        self._segments = tuple(segments)
        self.version = version
        self.cache = MappingCache()

    @property
    def segments(self) -> tuple[Segment, ...]:
        return self._segments

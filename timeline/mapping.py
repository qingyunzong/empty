"""Wall-clock <-> timeline mapping with candidate evidence.

``local_to_instant`` returns 0, 1 or 2 candidates for a wall-clock reading:

* 0 -- the wall-clock time falls in a forward-jump gap (never happened).
* 1 -- the normal case.
* 2 -- the wall-clock time falls in a backward-jump fold (happened twice).

Every candidate carries the transition segment it was derived from, so a
result is independently verifiable: ``instant + offset == local`` and the
instant must lie inside the segment's UTC range.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Sequence

from .table import OffsetTable, Segment, Snapshot


@dataclass(frozen=True)
class Candidate:
    instant: int            # epoch seconds on the UTC timeline
    segment: Segment

    def evidence(self) -> dict:
        return {
            "instant": self.instant,
            "segment_id": self.segment.seg_id,
            "offset_seconds": self.segment.offset_seconds,
            "utc_start": self.segment.utc_start,
            "utc_end": self.segment.utc_end,
        }


def _segments_of(table) -> tuple[Segment, ...]:
    if isinstance(table, (OffsetTable, Snapshot)):
        return table.segments
    return tuple(table)


def local_to_instant(table, local_seconds: int,
                     use_cache: bool = True) -> list[Candidate]:
    """Map a wall-clock reading to 0/1/2 instants, sorted by instant.

    Results are cached per table version; the cache is incrementally
    invalidated by ``OffsetTable.revise``.
    """
    cache = getattr(table, "cache", None) if use_cache else None
    if cache is not None:
        hit = cache.get(local_seconds)
        if hit is not None:
            cached_segments, cached_instants = hit
            segs = _segments_of(table)
            by_id = {s.seg_id: s for s in segs}
            return [Candidate(u, by_id[sid]) for sid, u in
                    zip(cached_segments, cached_instants)]
    found: list[Candidate] = []
    for seg in _segments_of(table):
        instant = local_seconds - seg.offset_seconds
        if seg.contains_utc(instant):
            found.append(Candidate(instant, seg))
    # Deterministic ordering: earlier instant first, then segment start.
    found.sort(key=lambda c: (c.instant,
                              c.segment.utc_start if c.segment.utc_start is not None
                              else -(1 << 62)))
    if cache is not None:
        cache.put(local_seconds,
                  (tuple(c.segment.seg_id for c in found),
                   tuple(c.instant for c in found)))
    return found


def instant_to_local(table, instant: int) -> tuple[int, Segment]:
    """Map an instant to (wall-clock seconds, segment).  Always unique."""
    for seg in _segments_of(table):
        if seg.contains_utc(instant):
            return instant + seg.offset_seconds, seg
    raise ValueError(f"instant {instant} is outside the transition table")


def verify_candidate(table, local_seconds: int, evidence: dict) -> bool:
    """Independently verify a piece of mapping evidence."""
    segs = {s.seg_id: s for s in _segments_of(table)}
    seg = segs.get(evidence["segment_id"])
    if seg is None:
        return False
    if seg.offset_seconds != evidence["offset_seconds"]:
        return False
    if seg.utc_start != evidence["utc_start"] or seg.utc_end != evidence["utc_end"]:
        return False
    instant = evidence["instant"]
    if instant + seg.offset_seconds != local_seconds:
        return False
    return seg.contains_utc(instant)

"""Exact conversion of wall-clock intervals into unions of UTC intervals.

A local interval is split at every transition boundary it spans.  Each
output piece records:

* its UTC range with preserved open/closed boundaries,
* the source wall-clock sub-range it came from,
* the segment it was mapped through,
* a ``duplicate`` flag: when a backward jump folds the wall clock, the same
  source sub-range produces two UTC pieces; both are kept and flagged so the
  duplicated origin is never lost.

Wall-clock sub-ranges that fall in a forward-jump gap map to nothing and
are reported in ``gaps``.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

from .table import Segment


@dataclass(frozen=True)
class LocalInterval:
    start: int                 # local (wall-clock) seconds
    end: int                   # local seconds, must be > start
    start_closed: bool = True
    end_closed: bool = False

    def __post_init__(self):
        if self.end <= self.start:
            raise ValueError("interval end must be after start")


@dataclass(frozen=True)
class UtcPiece:
    start: int
    end: int
    start_closed: bool
    end_closed: bool
    segment_id: str
    source_local_start: int
    source_local_end: int
    duplicate: bool = False    # same source range also produced another piece

    def evidence(self) -> dict:
        return {
            "utc": [self.start, self.end],
            "utc_closed": [self.start_closed, self.end_closed],
            "source_local": [self.source_local_start, self.source_local_end],
            "segment_id": self.segment_id,
            "duplicate": self.duplicate,
        }


@dataclass(frozen=True)
class LocalGap:
    start: int
    end: int


@dataclass(frozen=True)
class IntervalResult:
    pieces: tuple[UtcPiece, ...]
    gaps: tuple[LocalGap, ...]


def convert_interval(segments, interval: LocalInterval) -> IntervalResult:
    segs: list[Segment] = sorted(
        segments,
        key=lambda s: s.utc_start if s.utc_start is not None else -(1 << 62))
    pieces: list[UtcPiece] = []
    covered: list[tuple[int, int]] = []
    for seg in segs:
        ls = seg.local_start()
        le = seg.local_end()
        lo = interval.start if ls is None else max(ls, interval.start)
        hi = interval.end if le is None else min(le, interval.end)
        if lo >= hi:
            continue
        # start boundary: a cut at the segment's closed local start is
        # closed; otherwise the query's own start edge is binding
        start_closed = True if (ls is not None and ls > interval.start) \
            else interval.start_closed
        # end boundary: segment local end is always an open edge
        if hi == interval.end and (le is None or interval.end < le):
            end_closed = interval.end_closed
        else:
            end_closed = False
        pieces.append(UtcPiece(
            start=lo - seg.offset_seconds,
            end=hi - seg.offset_seconds,
            start_closed=start_closed,
            end_closed=end_closed,
            segment_id=seg.seg_id,
            source_local_start=lo,
            source_local_end=hi,
        ))
        covered.append((lo, hi))

    # flag pieces whose source wall-clock range is produced more than once
    flagged: list[UtcPiece] = []
    for piece in pieces:
        dup = sum(1 for other in pieces
                  if other.source_local_start < piece.source_local_end
                  and piece.source_local_start < other.source_local_end) > 1
        flagged.append(UtcPiece(**{**piece.__dict__, "duplicate": dup}))

    # wall-clock gaps: parts of the query no segment covers
    gaps: list[LocalGap] = []
    cursor = interval.start
    for lo, hi in sorted(covered):
        if lo > cursor:
            gaps.append(LocalGap(cursor, lo))
        cursor = max(cursor, hi)
    if cursor < interval.end:
        gaps.append(LocalGap(cursor, interval.end))

    return IntervalResult(tuple(flagged), tuple(gaps))

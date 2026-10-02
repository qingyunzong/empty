"""Interval set tracking verified coverage, gaps and source evidence.

Intervals are kept as a sorted list of disjoint ``[start, end)`` spans.
Every span records the fragment ids that vouch for it so conflicts can
be attributed and retractions recomputed.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterator, List, Optional, Tuple


@dataclass
class Span:
    start: int
    end: int
    evidence: List[str] = field(default_factory=list)

    def overlaps(self, start: int, end: int) -> bool:
        return self.start < end and start < self.end


class IntervalSet:
    """Sorted disjoint interval set with per-span evidence."""

    def __init__(self) -> None:
        self._spans: List[Span] = []

    @property
    def spans(self) -> List[Span]:
        return list(self._spans)

    def __iter__(self) -> Iterator[Span]:
        return iter(self._spans)

    def __len__(self) -> int:
        return len(self._spans)

    def covered_bytes(self) -> int:
        return sum(s.end - s.start for s in self._spans)

    def _index_of(self, pos: int) -> int:
        """Binary search: index of first span with end > pos."""
        lo, hi = 0, len(self._spans)
        while lo < hi:
            mid = (lo + hi) // 2
            if self._spans[mid].end <= pos:
                lo = mid + 1
            else:
                hi = mid
        return lo

    def add(self, start: int, end: int, frag_id: str) -> None:
        """Insert ``[start, end)`` merging overlaps, keeping evidence."""
        if start >= end:
            return
        i = self._index_of(start)
        if i > 0 and self._spans[i - 1].end >= start:
            # adjacent or overlapping span just before
            i -= 1
        new = Span(start, end, [frag_id])
        j = i
        while j < len(self._spans) and self._spans[j].start <= new.end:
            span = self._spans[j]
            new.start = min(new.start, span.start)
            new.end = max(new.end, span.end)
            for fid in span.evidence:
                if fid not in new.evidence:
                    new.evidence.append(fid)
            j += 1
        self._spans[i:j] = [new]

    def overlapping(self, start: int, end: int) -> List[Span]:
        """All spans intersecting ``[start, end)``."""
        if start >= end:
            return []
        i = self._index_of(start)
        out = []
        while i < len(self._spans) and self._spans[i].start < end:
            out.append(self._spans[i])
            i += 1
        return out

    def evidence_at(self, pos: int) -> Optional[Span]:
        """Span covering ``pos`` or ``None``."""
        i = self._index_of(pos)
        if i < len(self._spans) and self._spans[i].start <= pos:
            return self._spans[i]
        return None

    def gaps(self, start: int, end: int) -> List[Tuple[int, int]]:
        """Uncovered sub-intervals of ``[start, end)`` in order."""
        out: List[Tuple[int, int]] = []
        cur = start
        for span in self._spans:
            if span.end <= start:
                continue
            if span.start >= end:
                break
            if span.start > cur:
                out.append((cur, min(span.start, end)))
            cur = max(cur, span.end)
        if cur < end:
            out.append((cur, end))
        return out

    def is_complete(self, start: int, end: int) -> bool:
        if start >= end:
            return True
        return (
            len(self._spans) == 1
            and self._spans[0].start <= start
            and self._spans[0].end >= end
        )

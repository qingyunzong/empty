"""Sorted disjoint-interval coverage map with provenance evidence."""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class Interval:
    start: int
    end: int
    # ids of every fragment known to cover this exact byte range (evidence)
    sources: list[str] = field(default_factory=list)

    def overlaps(self, start: int, end: int) -> bool:
        return self.start < end and start < self.end


class Coverage:
    """Maintains disjoint sorted [start, end) intervals plus provenance."""

    def __init__(self) -> None:
        self._ivs: list[Interval] = []

    @property
    def intervals(self) -> list[Interval]:
        return self._ivs

    def overlapping(self, start: int, end: int) -> list[Interval]:
        return [iv for iv in self._ivs if iv.overlaps(start, end)]

    def covered_bytes(self) -> int:
        return sum(iv.end - iv.start for iv in self._ivs)

    def is_complete(self, total: int) -> bool:
        return (
            total >= 0
            and len(self._ivs) == 1
            and self._ivs[0].start == 0
            and self._ivs[0].end == total
        )

    def add(self, start: int, end: int, source: str) -> None:
        """Insert [start, end); merge with neighbours, recording provenance."""
        if start >= end:
            if source:
                self._record_source_on_touching(start, source)
            return
        new: list[Interval] = []
        cursor = start
        inserted = False
        for iv in self._ivs:
            if iv.end < start:
                new.append(iv)
            elif iv.start > end:
                if not inserted:
                    new.append(Interval(cursor, end, [source]))
                    inserted = True
                new.append(iv)
            else:
                # overlap or adjacency: union, carrying both provenance sets
                if iv.start <= cursor:
                    cursor = min(cursor, iv.start)
                merged_sources = list(iv.sources)
                if source not in merged_sources:
                    merged_sources.append(source)
                # absorb iv into the pending interval
                if inserted and new and new[-1].end >= iv.start:
                    prev = new[-1]
                    prev.end = max(prev.end, iv.end)
                    for s in merged_sources:
                        if s not in prev.sources:
                            prev.sources.append(s)
                    cursor = prev.end
                else:
                    if not inserted:
                        new.append(Interval(min(cursor, iv.start), max(end, iv.end), merged_sources))
                        inserted = True
                    else:
                        prev = new[-1]
                        prev.end = max(prev.end, iv.end)
                        for s in merged_sources:
                            if s not in prev.sources:
                                prev.sources.append(s)
                    cursor = new[-1].end
        if not inserted:
            new.append(Interval(cursor, end, [source]))
        # merge any adjacent intervals created above
        merged: list[Interval] = []
        for iv in sorted(new, key=lambda i: i.start):
            if merged and iv.start <= merged[-1].end:
                last = merged[-1]
                last.end = max(last.end, iv.end)
                for s in iv.sources:
                    if s not in last.sources:
                        last.sources.append(s)
            else:
                merged.append(Interval(iv.start, iv.end, list(iv.sources)))
        self._ivs = merged

    def _record_source_on_touching(self, pos: int, source: str) -> None:
        for iv in self._ivs:
            if iv.start <= pos < iv.end and source not in iv.sources:
                iv.sources.append(source)

    def gaps(self, total: int) -> list[tuple[int, int]]:
        """Missing [start, end) ranges within [0, total)."""
        out: list[tuple[int, int]] = []
        cursor = 0
        for iv in self._ivs:
            if iv.start > cursor:
                out.append((cursor, min(iv.start, total)))
            cursor = max(cursor, iv.end)
        if cursor < total:
            out.append((cursor, total))
        return [(s, e) for s, e in out if s < e]

    def rebuild(self, pieces: list[tuple[int, int, str]]) -> None:
        """Reset coverage from (start, end, source) triples (after withdrawal)."""
        self._ivs = []
        for start, end, source in pieces:
            self.add(start, end, source)

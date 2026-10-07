"""Mutable timeline with incremental revision, caching and snapshots.

A ``Timeline`` wraps a ``TransitionTable`` and caches local->instant
mappings.  ``revise`` installs a new table atomically: the replacement is
fully validated first, and only the cache entries whose wall-clock keys fall
inside the changed local ranges are recomputed.  ``Snapshot`` objects keep
interpreting history with the table that was in effect when taken.
"""
from __future__ import annotations

from .core import (
    Candidate,
    Duration,
    Instant,
    LocalDateTime,
    TransitionTable,
    UtcInterval,
    _dt_to_epoch,
)


def _changed_local_ranges(
    old: TransitionTable, new: TransitionTable
) -> list[tuple[int | None, int | None]]:
    """Local-epoch ranges whose mapping differs between two tables.

    Computed by splitting the UTC axis at every segment boundary of both
    tables and comparing the effective offset in each elementary interval.
    A changed UTC interval [a, b) invalidates both the old-offset and the
    new-offset projection of it onto the local axis.
    """
    points: set[int] = set()
    for table in (old, new):
        for seg in table.segments:
            if seg.utc_start is not None:
                points.add(seg.utc_start)
            if seg.utc_end is not None:
                points.add(seg.utc_end)
    ordered = sorted(points)
    intervals: list[tuple[int | None, int | None]] = []
    if not ordered:
        intervals.append((None, None))
    else:
        intervals.append((None, ordered[0]))
        intervals.extend(zip(ordered, ordered[1:]))
        intervals.append((ordered[-1], None))
    ranges: list[tuple[int | None, int | None]] = []
    for low, high in intervals:
        probe = low if low is not None else (high - 1 if high is not None else 0)
        old_offset = old.offset_or_none(probe)
        new_offset = new.offset_or_none(probe)
        if old_offset == new_offset:
            continue
        for offset in (old_offset, new_offset):
            if offset is None:
                continue
            rng = (
                None if low is None else low + offset,
                None if high is None else high + offset,
            )
            if rng not in ranges:
                ranges.append(rng)
    return ranges


class Timeline:
    """A revisable transition table with a local->instant mapping cache."""

    def __init__(self, table: TransitionTable):
        self._table = table
        self._revision = 0
        self._cache: dict[int, tuple[Candidate, ...]] = {}

    @property
    def table(self) -> TransitionTable:
        return self._table

    @property
    def revision(self) -> int:
        return self._revision

    def cache_keys(self) -> list[int]:
        return sorted(self._cache)

    def local_to_instant(self, local: LocalDateTime) -> list[Candidate]:
        key = _dt_to_epoch(local.dt)
        if key not in self._cache:
            self._cache[key] = tuple(self._table.local_to_instant(local))
        return list(self._cache[key])

    def instant_to_local(self, instant: Instant) -> LocalDateTime:
        return self._table.instant_to_local(instant)

    def local_interval_to_utc(self, start, end, start_closed=True, end_closed=False):
        return self._table.local_interval_to_utc(start, end, start_closed, end_closed)

    def revise(self, spec) -> int:
        """Atomically install a revised table and recompute affected mappings.

        The new table is fully validated before any state changes; a
        TableError (e.g. overlapping segments) leaves the timeline untouched.
        """
        new_table = TransitionTable.from_spec(spec)
        affected = _changed_local_ranges(self._table, new_table)
        self._table = new_table
        self._revision += 1
        for key in list(self._cache):
            if any(
                (low is None or key >= low) and (high is None or key < high)
                for low, high in affected
            ):
                del self._cache[key]
        return self._revision

    def snapshot(self) -> "Snapshot":
        """An immutable view pinned to the current table and revision."""
        return Snapshot(self._table, self._revision)


class Snapshot:
    """Historical view: always interprets wall-clock readings with its own table."""

    def __init__(self, table: TransitionTable, revision: int):
        self._table = table
        self.revision = revision

    @property
    def table(self) -> TransitionTable:
        return self._table

    def local_to_instant(self, local: LocalDateTime) -> list[Candidate]:
        return self._table.local_to_instant(local)

    def instant_to_local(self, instant: Instant) -> LocalDateTime:
        return self._table.instant_to_local(instant)

    def local_interval_to_utc(self, start, end, start_closed=True, end_closed=False) -> list[UtcInterval]:
        return self._table.local_interval_to_utc(start, end, start_closed, end_closed)

    def add_seconds(self, instant: Instant, seconds: int) -> Instant:
        return instant + Duration.from_seconds(seconds)

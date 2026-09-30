"""Mutable session over a persistent IntervalMap.

Provides nested transactions and named historical snapshots.  Because
the underlying map is fully persistent, a transaction is just a saved
reference: rollback restores the tree root, the source reference counts
and every cached aggregate (endpoint events / total lengths) together,
atomically, with zero recomputation.
"""
from __future__ import annotations

from contextlib import contextmanager

from .core import IntervalMap


class Workspace:
    def __init__(self, imap: IntervalMap | None = None):
        self.current = imap if imap is not None else IntervalMap()
        self._tx_stack: list[IntervalMap] = []
        self._snapshots: dict[str, IntervalMap] = {}

    # -- transactions ---------------------------------------------------
    @property
    def transaction_depth(self):
        return len(self._tx_stack)

    def begin(self):
        self._tx_stack.append(self.current)

    def commit(self):
        if not self._tx_stack:
            raise RuntimeError("commit without begin")
        self._tx_stack.pop()

    def rollback(self):
        if not self._tx_stack:
            raise RuntimeError("rollback without begin")
        self.current = self._tx_stack.pop()

    @contextmanager
    def transaction(self):
        """Nested transaction: rolls back on any exception, else commits."""
        self.begin()
        try:
            yield self
        except BaseException:
            self.rollback()
            raise
        else:
            self.commit()

    # -- historical snapshots -------------------------------------------
    def snapshot(self, name: str):
        if not name:
            raise ValueError("snapshot name must be non-empty")
        self._snapshots[name] = self.current

    def restore(self, name: str):
        """Restore a named snapshot.  Restoring an old snapshot and then
        modifying creates a divergent branch; other snapshots are kept."""
        if name not in self._snapshots:
            raise KeyError(f"unknown snapshot: {name!r}")
        self.current = self._snapshots[name]

    def snapshots(self):
        return sorted(self._snapshots)

    # -- mutating operations (delegate to the persistent map) ------------
    def add(self, lo, hi, source, count=1):
        self.current = self.current.add(lo, hi, source, count)

    def revoke(self, source, count=None):
        self.current = self.current.revoke(source, count)

    def union(self, other: IntervalMap):
        self.current = self.current.union(other)

    def intersection(self, other: IntervalMap):
        self.current = self.current.intersection(other)

    def difference(self, other: IntervalMap):
        self.current = self.current.difference(other)

"""Undirected integer-capacity multigraph.

Parallel edges are aggregated into a single capacity per unordered pair.
Self-loops are ignored.  Capacity 0 edges are accepted (and dropped from
the canonical aggregate, which is behaviourally identical).
"""

from __future__ import annotations


def _is_int(value) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


class Graph:
    """Undirected multigraph with non-negative integer capacities."""

    def __init__(self, n: int, edges=()):
        if not _is_int(n) or n < 1:
            raise ValueError("vertex count must be a positive integer")
        self.n = n
        self._caps = {}  # (u, v) with u < v -> aggregated capacity (> 0)
        for u, v, c in edges:
            self.add_edge(u, v, c)

    # -- validation -----------------------------------------------------
    def check_vertex(self, v: int) -> None:
        if not _is_int(v) or not 0 <= v < self.n:
            raise ValueError(f"invalid vertex: {v!r}")

    @staticmethod
    def check_capacity(c: int) -> None:
        if not _is_int(c) or c < 0:
            raise ValueError(f"capacity must be a non-negative integer: {c!r}")

    # -- mutation -------------------------------------------------------
    def add_edge(self, u: int, v: int, c: int) -> None:
        self.check_vertex(u)
        self.check_vertex(v)
        self.check_capacity(c)
        if u == v:
            return  # self-loops are ignored
        key = (u, v) if u < v else (v, u)
        total = self._caps.get(key, 0) + c
        if total:
            self._caps[key] = total
        else:
            self._caps.pop(key, None)

    def set_capacity(self, u: int, v: int, c: int) -> None:
        """Set the aggregated capacity of the unordered pair (u, v)."""
        self.check_vertex(u)
        self.check_vertex(v)
        self.check_capacity(c)
        if u == v:
            return  # self-loops are ignored
        key = (u, v) if u < v else (v, u)
        if c:
            self._caps[key] = c
        else:
            self._caps.pop(key, None)

    # -- access ---------------------------------------------------------
    def capacity(self, u: int, v: int) -> int:
        if u == v:
            return 0
        key = (u, v) if u < v else (v, u)
        return self._caps.get(key, 0)

    def capacities(self):
        """Return a copy of the aggregated capacity map {(u,v): c}, u < v."""
        return dict(self._caps)

    def edge_list(self):
        """Sorted [[u, v, c], ...] representation (canonical, JSON friendly)."""
        return [[u, v, c] for (u, v), c in sorted(self._caps.items())]


def cut_capacity(caps, side) -> int:
    """Total capacity of edges crossing the cut (side, V \\ side)."""
    side = set(side)
    total = 0
    for (u, v), c in caps.items():
        if (u in side) != (v in side):
            total += c
    return total

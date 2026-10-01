"""Incremental single-source shortest paths (directed, non-negative weights).

Maintains dist[] and the lexicographically smallest shortest node sequence
(over simple paths) under edge insertions and deletions, recomputing only
the affected subgraph instead of rerunning Dijkstra on the whole graph.
"""

from __future__ import annotations

import heapq

MAX_WEIGHT = 1_000_000


class IncrementalSSSP:
    def __init__(self) -> None:
        self._adj: dict[str, dict[str, int]] = {}
        self._rev: dict[str, dict[str, int]] = {}
        self._src: str | None = None
        self._dist: dict[str, int] = {}
        self._key: dict[str, tuple[str, ...]] = {}
        self._dirty = True
        # Number of nodes recomputed during the last update (for tests).
        self.recomputed = 0

    # ------------------------------------------------------------------
    # structure
    # ------------------------------------------------------------------
    def _node(self, x: str) -> None:
        if x not in self._adj:
            self._adj[x] = {}
            self._rev[x] = {}

    def nodes(self) -> list[str]:
        return sorted(self._adj)

    def has_edge(self, u: str, v: str) -> bool:
        return v in self._adj.get(u, ())

    def weight(self, u: str, v: str) -> int | None:
        return self._adj.get(u, {}).get(v)

    # ------------------------------------------------------------------
    # source
    # ------------------------------------------------------------------
    @property
    def source(self) -> str | None:
        return self._src

    def set_source(self, s: str) -> None:
        self._node(s)
        self.recomputed = 0
        if s != self._src:
            self._src = s
            self._dirty = True  # switching source invalidates the cache

    # ------------------------------------------------------------------
    # updates
    # ------------------------------------------------------------------
    def add_edge(self, u: str, v: str, w: int) -> bool:
        """Add edge u->v. Duplicate edges collapse to the minimum weight.

        Returns True when the logical edge changed (new edge or smaller
        weight than the stored minimum).
        """
        if not isinstance(w, int) or w < 0:
            raise ValueError(f"negative weight: {w!r}")
        if w > MAX_WEIGHT:
            raise ValueError(f"weight out of range 0..{MAX_WEIGHT}: {w}")
        self._node(u)
        self._node(v)
        self.recomputed = 0
        old = self._adj[u].get(v)
        if old is not None and w >= old:
            return False  # duplicate that does not lower the minimum
        self._adj[u][v] = w
        self._rev[v][u] = w
        self._ensure_fresh()
        du = self._dist.get(u)
        if du is None or v in self._key[u]:
            return True
        cand_d = du + w
        cand_k = self._key[u] + (v,)
        if self._better(cand_d, cand_k, v):
            self._dist[v] = cand_d
            self._key[v] = cand_k
            touched = {v}
            self._propagate([(cand_d, cand_k, v)], None, touched)
            self.recomputed = len(touched)
        return True

    def remove_edge(self, u: str, v: str) -> bool:
        """Remove the logical edge u->v. Returns True if it existed."""
        self._node(u)
        self._node(v)
        self.recomputed = 0
        old = self._adj[u].get(v)
        if old is None:
            return False
        del self._adj[u][v]
        del self._rev[v][u]
        self._ensure_fresh()
        du = self._dist.get(u)
        dv = self._dist.get(v)
        if du is None or dv is None or du + old != dv:
            return True  # edge was not tight: no distance depended on it
        # Affected subtree: nodes reachable from v via tight edges.
        affected = self._tight_closure(v)
        # Boundary seeds: best entry into the affected set from outside.
        seeds: dict[str, tuple[int, tuple[str, ...]]] = {}
        for x in affected:
            if x == self._src:
                seeds[x] = (0, (x,))
            for p, w in self._rev[x].items():
                if p in affected:
                    continue
                dp = self._dist.get(p)
                if dp is None:
                    continue
                cand = (dp + w, self._key[p] + (x,))
                if x not in seeds or cand < seeds[x]:
                    seeds[x] = cand
        for x in affected:
            self._dist.pop(x, None)
            self._key.pop(x, None)
        heap: list[tuple[int, tuple[str, ...], str]] = []
        for x, (d, k) in seeds.items():
            self._dist[x] = d
            self._key[x] = k
            heapq.heappush(heap, (d, k, x))
        self._propagate(heap, affected, None)
        self.recomputed = len(affected)
        return True

    # ------------------------------------------------------------------
    # queries
    # ------------------------------------------------------------------
    def dist(self, t: str) -> int | None:
        """Shortest distance to t, or None when unreachable."""
        self._ensure_fresh()
        return self._dist.get(t)

    def path(self, t: str) -> list[str] | None:
        """Lexicographically smallest shortest node sequence, or None."""
        self._ensure_fresh()
        k = self._key.get(t)
        return list(k) if k is not None else None

    # ------------------------------------------------------------------
    # internals
    # ------------------------------------------------------------------
    def _better(self, d: int, k: tuple[str, ...], x: str) -> bool:
        od = self._dist.get(x)
        return od is None or d < od or (d == od and k < self._key[x])

    def _propagate(self, heap, restrict, touched) -> None:
        """Dijkstra-style relaxation seeded with a (possibly lazy) heap.

        Only nodes in ``restrict`` are updated when it is not None; the
        loop terminates because keys strictly decrease and every adopted
        key is a simple path (cycles are skipped and never help).
        """
        while heap:
            d, k, x = heapq.heappop(heap)
            if self._dist.get(x) != d or self._key.get(x) != k:
                continue  # stale heap entry
            for y, w in self._adj[x].items():
                if restrict is not None and y not in restrict:
                    continue
                if y in k:
                    continue  # keep paths simple; cycles never improve
                nd = d + w
                nk = k + (y,)
                if self._better(nd, nk, y):
                    self._dist[y] = nd
                    self._key[y] = nk
                    if touched is not None:
                        touched.add(y)
                    heapq.heappush(heap, (nd, nk, y))

    def _tight_closure(self, start: str) -> set[str]:
        """Nodes reachable from start via tight edges (current dists)."""
        seen: set[str] = set()
        stack = [start]
        while stack:
            x = stack.pop()
            if x in seen:
                continue
            seen.add(x)
            dx = self._dist.get(x)
            if dx is None:
                continue
            for y, w in self._adj[x].items():
                if y in seen:
                    continue
                dy = self._dist.get(y)
                if dy is not None and dx + w == dy:
                    stack.append(y)
        return seen

    def _ensure_fresh(self) -> None:
        if not self._dirty:
            return
        self._dist = {}
        self._key = {}
        self._dirty = False
        self.recomputed = 0
        if self._src is None:
            return
        s = self._src
        self._dist[s] = 0
        self._key[s] = (s,)
        touched = {s}
        self._propagate([(0, (s,), s)], None, touched)
        self.recomputed = len(touched)

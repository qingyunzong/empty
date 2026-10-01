"""Incremental single-source shortest paths on a directed non-negative graph.

Distances are maintained differentially:
  * edge insert / weight decrease -> bounded decrease-only propagation
  * edge removal -> only the affected subtree (nodes that lost every
    tight in-edge from an unaffected node) is recomputed, via a mini
    Dijkstra seeded from the boundary of the affected set.

`last_recomputed` records how many vertices were re-finalized by the
most recent mutating operation (used by the tests to verify that updates
stay local instead of re-running a full Dijkstra).
"""

from __future__ import annotations

import heapq
from collections import deque

INF = float("inf")
MAX_WEIGHT = 1_000_000


class IncrementalGraph:
    def __init__(self):
        self.out = {}          # u -> {v: w}  (minimum weight kept per pair)
        self.inn = {}          # v -> {u: w}  (mirror of self.out)
        self.source = None
        self.dist = {}         # node -> distance from source (INF if unreachable)
        self.last_recomputed = 0

    # ------------------------------------------------------------------ nodes
    def _ensure(self, x):
        if x not in self.out:
            self.out[x] = {}
            self.inn[x] = {}
            self.dist[x] = INF

    @property
    def nodes(self):
        return self.out.keys()

    # ----------------------------------------------------------------- source
    def set_source(self, s):
        """Switch source; all cached distances are dropped and recomputed."""
        self._ensure(s)
        self.source = s
        self._full_dijkstra()

    def _full_dijkstra(self):
        for x in self.dist:
            self.dist[x] = INF
        s = self.source
        self.dist[s] = 0
        pq = [(0, s)]
        count = 0
        while pq:
            d, u = heapq.heappop(pq)
            if d != self.dist[u]:
                continue
            count += 1
            for v, w in self.out[u].items():
                nd = d + w
                if nd < self.dist[v]:
                    self.dist[v] = nd
                    heapq.heappush(pq, (nd, v))
        self.last_recomputed = count

    # ------------------------------------------------------------------- edge
    def add_edge(self, u, v, w):
        """Insert edge u->v; a duplicate keeps the minimum weight (one change).

        Returns True if the stored edge set changed.
        """
        self._ensure(u)
        self._ensure(v)
        old = self.out[u].get(v)
        if old is not None and w >= old:
            self.last_recomputed = 0
            return False
        self.out[u][v] = w
        self.inn[v][u] = w
        self.last_recomputed = 0
        if self.source is None:
            return True
        du = self.dist[u]
        if du == INF or du + w >= self.dist[v]:
            return True
        # Decrease-only propagation starting at v; touches only vertices
        # whose distance actually improves.
        self.dist[v] = du + w
        pq = [(du + w, v)]
        count = 0
        while pq:
            d, x = heapq.heappop(pq)
            if d != self.dist[x]:
                continue
            count += 1
            for y, wy in self.out[x].items():
                nd = d + wy
                if nd < self.dist[y]:
                    self.dist[y] = nd
                    heapq.heappush(pq, (nd, y))
        self.last_recomputed = count
        return True

    def remove_edge(self, u, v):
        """Remove edge u->v; only the affected subtree is recomputed."""
        self._ensure(u)
        self._ensure(v)
        old = self.out[u].get(v)
        self.last_recomputed = 0
        if old is None:
            return False
        del self.out[u][v]
        del self.inn[v][u]
        if self.source is None or u == v:
            return True
        # If the removed edge was not tight for v (or v was unreachable),
        # no distance can change.
        if (
            self.dist[v] == INF
            or self.dist[u] == INF
            or self.dist[u] + old != self.dist[v]
        ):
            return True
        affected = self._affected_set(v)
        if not affected:
            return True
        # Detach the affected subtree, then re-grow it from the boundary.
        for y in affected:
            self.dist[y] = INF
        pq = []
        for y in affected:
            best = None
            for z, w in self.inn[y].items():
                if z not in affected and self.dist[z] != INF:
                    cand = self.dist[z] + w
                    if best is None or cand < best:
                        best = cand
            if best is not None:
                self.dist[y] = best
                heapq.heappush(pq, (best, y))
        while pq:
            d, x = heapq.heappop(pq)
            if d != self.dist[x]:
                continue
            for y, w in self.out[x].items():
                if y not in affected:
                    continue
                nd = d + w
                if nd < self.dist[y]:
                    self.dist[y] = nd
                    heapq.heappush(pq, (nd, y))
        self.last_recomputed = len(affected)
        return True

    def _affected_set(self, v):
        """Vertices whose distance must increase after an edge removal.

        Computed locally: C = vertices reachable from v via tight out-edges
        (only they can be affected, since any unchanged vertex still has a
        shortest path avoiding the removed edge).  A member of C is *saved*
        iff it is still reachable from the source through tight edges, i.e.
        it is the source itself, has a tight in-edge from outside C, or is
        tightly reachable from another saved member of C.  Everything else
        in C lost every shortest path and must be recomputed.  Zero-weight
        cycles that only support each other are correctly detected as
        affected because support must be grounded outside C.
        """
        candidates = set()
        stack = [v]
        while stack:
            x = stack.pop()
            if x in candidates:
                continue
            candidates.add(x)
            dx = self.dist[x]
            if dx == INF:
                continue
            for y, w in self.out[x].items():
                if y != x and y not in candidates and dx + w == self.dist[y]:
                    stack.append(y)
        saved = set()
        dq = deque()
        if self.source in candidates:
            saved.add(self.source)
            dq.append(self.source)
        for y in candidates:
            if y in saved:
                continue
            dy = self.dist[y]
            for z, w in self.inn[y].items():
                if z not in candidates and z != y and self.dist[z] != INF \
                        and self.dist[z] + w == dy:
                    saved.add(y)
                    dq.append(y)
                    break
        while dq:
            x = dq.popleft()
            dx = self.dist[x]
            for y, w in self.out[x].items():
                if y in candidates and y not in saved and dx + w == self.dist[y]:
                    saved.add(y)
                    dq.append(y)
        return candidates - saved
    # ----------------------------------------------------------------- query
    def distance(self, t):
        return self.dist.get(t, INF)

    def path(self, t):
        """Lexicographically smallest node sequence among shortest paths."""
        if self.source is None or self.dist.get(t, INF) == INF:
            return []
        result = [self.source]
        visited = {self.source}
        cur = self.source
        while cur != t:
            best = None
            for x, w in self.out[cur].items():
                if x in visited:
                    continue
                if self.dist[cur] + w != self.dist[x]:
                    continue
                if best is not None and x >= best:
                    continue
                if self._reachable_tight(x, t, visited):
                    best = x
            if best is None:  # unreachable via tight edges; should not happen
                return []
            result.append(best)
            visited.add(best)
            cur = best
        return result

    def _reachable_tight(self, start, t, blocked):
        """BFS over tight edges (dist[a] + w == dist[b]) avoiding `blocked`."""
        if start == t:
            return True
        seen = set(blocked)
        seen.add(start)
        dq = deque([start])
        while dq:
            a = dq.popleft()
            da = self.dist[a]
            for b, w in self.out[a].items():
                if b in seen or da + w != self.dist[b]:
                    continue
                if b == t:
                    return True
                seen.add(b)
                dq.append(b)
        return False

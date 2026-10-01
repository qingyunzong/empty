"""Incremental topological orderer for a dynamic DAG.

The maintained order is level based:

    level(n) = 0                       if n has no predecessors
    level(n) = 1 + max(level(p) for p in preds(n))   otherwise

`order()` emits nodes level by level; within one level node ids are sorted
ascending.  This makes the emitted order a pure function of the graph, which
gives the required guarantees for free:

* determinism (no hash / insertion-order dependence),
* deleting an edge can only lower the level of the edge's descendants
  ("unlock successors"); the relative order of unrelated nodes never changes,
* idempotent re-insertion of an existing edge changes nothing.

Levels are maintained incrementally: `add_edge` only propagates level
increases through the descendants of the edge target, `del_edge` /
`del_node` only recompute the levels of the affected descendant set.
When an edge would close a cycle, the affected strongly connected component
(nodes lying on a cycle through the new edge) is computed as
``descendants*(v) & ancestors*(u)`` and reported via :class:`CycleError`;
the graph is left untouched, i.e. it keeps the last acyclic snapshot.
"""

from collections import deque
import heapq


class CycleError(Exception):
    """Raised when an edge insertion would create a cycle.

    ``nodes`` holds the lexicographically smallest representation of the
    affected cycle set: every node that lies on a cycle through the
    rejected edge, sorted ascending by node id.
    """

    def __init__(self, nodes):
        self.nodes = sorted(nodes)
        super().__init__("cycle detected involving nodes: %s" % (self.nodes,))


class UnknownNodeError(KeyError):
    """Raised when a command references a node that does not exist."""


class DynamicTopoGraph:
    """A mutable DAG maintaining an incremental, stable topological order."""

    def __init__(self):
        self._succ = {}   # node -> set of successors
        self._pred = {}   # node -> set of predecessors
        self._level = {}  # node -> int
        self._version = 0

    # ------------------------------------------------------------------
    # introspection
    # ------------------------------------------------------------------
    @property
    def version(self):
        """Number of effective mutations (idempotent no-ops do not count)."""
        return self._version

    @property
    def nodes(self):
        return set(self._succ)

    def has_edge(self, u, v):
        return u in self._succ and v in self._succ[u]

    def levels(self):
        """Return the order grouped by level: [[ids of level 0], ...]."""
        by_level = {}
        for node, lvl in self._level.items():
            by_level.setdefault(lvl, []).append(node)
        return [sorted(by_level[lvl]) for lvl in sorted(by_level)]

    def order(self):
        """Flat topological order: levels in order, ids ascending per level."""
        return [node for lvl in self.levels() for node in lvl]

    # ------------------------------------------------------------------
    # helpers
    # ------------------------------------------------------------------
    def _require(self, *ids):
        for node in ids:
            if node not in self._succ:
                raise UnknownNodeError(node)

    def _descendants(self, start):
        """Nodes reachable from ``start`` (including ``start``)."""
        seen = {start}
        stack = [start]
        while stack:
            node = stack.pop()
            for nxt in self._succ[node]:
                if nxt not in seen:
                    seen.add(nxt)
                    stack.append(nxt)
        return seen

    def _ancestors(self, start):
        """Nodes that can reach ``start`` (including ``start``)."""
        seen = {start}
        stack = [start]
        while stack:
            node = stack.pop()
            for prev in self._pred[node]:
                if prev not in seen:
                    seen.add(prev)
                    stack.append(prev)
        return seen

    # ------------------------------------------------------------------
    # mutations
    # ------------------------------------------------------------------
    def add_node(self, node):
        """Idempotently add ``node``.  Returns True if the graph changed."""
        if node in self._succ:
            return False
        self._succ[node] = set()
        self._pred[node] = set()
        self._level[node] = 0
        self._version += 1
        return True

    def add_edge(self, u, v):
        """Idempotently add edge ``u -> v``.

        Raises CycleError (graph untouched) if the edge would close a cycle,
        UnknownNodeError if either endpoint is missing.
        """
        self._require(u, v)
        if v in self._succ[u]:
            return False
        if u == v:
            raise CycleError([u])
        desc_v = self._descendants(v)
        if u in desc_v:
            # Nodes on a cycle through the new edge u->v: exactly the nodes
            # reachable from v that can still reach u (the affected SCC).
            raise CycleError(desc_v & self._ancestors(u))
        self._succ[u].add(v)
        self._pred[v].add(u)
        self._version += 1
        if self._level[v] < self._level[u] + 1:
            self._propagate_levels(v)
        return True

    def del_edge(self, u, v):
        """Idempotently remove edge ``u -> v``.  Only unlocks successors."""
        self._require(u, v)
        if v not in self._succ[u]:
            return False
        self._succ[u].discard(v)
        self._pred[v].discard(u)
        self._version += 1
        self._recompute_affected(v)
        return True

    def del_node(self, node):
        """Remove ``node`` and cascade-delete all of its incident edges."""
        self._require(node)
        succs = list(self._succ[node])
        for nxt in succs:
            self._pred[nxt].discard(node)
        for prev in list(self._pred[node]):
            self._succ[prev].discard(node)
        del self._succ[node]
        del self._pred[node]
        del self._level[node]
        self._version += 1
        for nxt in succs:
            self._recompute_affected(nxt)
        return True

    # ------------------------------------------------------------------
    # incremental level maintenance
    # ------------------------------------------------------------------
    def _propagate_levels(self, start):
        """Raise levels along descendants of ``start`` until consistent.

        Used after an edge insertion; levels only ever increase here.
        """
        queue = deque([start])
        queued = {start}
        while queue:
            node = queue.popleft()
            queued.discard(node)
            need = max((self._level[p] + 1 for p in self._pred[node]), default=0)
            if need > self._level[node]:
                self._level[node] = need
                for nxt in self._succ[node]:
                    if nxt not in queued:
                        queue.append(nxt)
                        queued.add(nxt)

    def _recompute_affected(self, start):
        """Recompute levels of ``start``'s descendant set after edge removal.

        Only the affected set (descendants of ``start``) is touched; every
        other node keeps its level, so unrelated nodes are never reordered.
        """
        affected = self._descendants(start)
        indeg = {node: 0 for node in affected}
        for node in affected:
            for prev in self._pred[node]:
                if prev in affected:
                    indeg[node] += 1
        heap = [node for node in affected if indeg[node] == 0]
        heapq.heapify(heap)
        while heap:
            node = heapq.heappop(heap)
            self._level[node] = max(
                (self._level[p] + 1 for p in self._pred[node]), default=0
            )
            for nxt in self._succ[node]:
                if nxt in affected:
                    indeg[nxt] -= 1
                    if indeg[nxt] == 0:
                        heapq.heappush(heap, nxt)

"""Incremental topological ordering library.

Maintains a directed graph under node/edge mutations and produces a
deterministic topological order (lexicographically smallest by node id,
i.e. Kahn's algorithm with a min-heap). Mutations that would introduce a
cycle are rejected atomically: the graph always remains at its last
acyclic snapshot.
"""

from __future__ import annotations

import heapq


class CycleError(Exception):
    """Raised when a mutation would introduce a cycle.

    ``nodes`` is the lexicographically smallest sorted node set among all
    strongly connected components that contain a cycle.
    """

    def __init__(self, nodes):
        super().__init__("cycle detected: %s" % (nodes,))
        self.nodes = list(nodes)


class UnknownNodeError(Exception):
    """Raised when a command references a node that does not exist."""

    def __init__(self, node):
        super().__init__("unknown node: %r" % (node,))
        self.node = node


class IncrementalTopo:
    def __init__(self):
        self._nodes = set()
        self._succ = {}
        self._pred = {}
        self._version = 0
        self._cached_order = None
        self._dirty = True

    @property
    def version(self):
        """Monotonic counter bumped only by mutations that change state."""
        return self._version

    @property
    def nodes(self):
        return set(self._nodes)

    @property
    def edges(self):
        return {(u, v) for u in self._nodes for v in self._succ[u]}

    def _touch(self):
        self._version += 1
        self._dirty = True

    def _require(self, node):
        if node not in self._nodes:
            raise UnknownNodeError(node)

    def add_node(self, node):
        """Idempotent: returns False (no version bump) if already present."""
        if node in self._nodes:
            return False
        self._nodes.add(node)
        self._succ[node] = set()
        self._pred[node] = set()
        self._touch()
        return True

    def add_edge(self, src, dst):
        """Idempotent: duplicate edges are a no-op.

        Raises CycleError (state unchanged) if the edge would close a cycle.
        """
        self._require(src)
        self._require(dst)
        if dst in self._succ[src]:
            return False
        if self._reachable(dst, src):
            raise CycleError(self._minimal_cycle_nodes(src, dst))
        self._succ[src].add(dst)
        self._pred[dst].add(src)
        self._touch()
        return True

    def del_edge(self, src, dst):
        """Idempotent: deleting a missing edge is a no-op."""
        self._require(src)
        self._require(dst)
        if dst not in self._succ[src]:
            return False
        self._succ[src].discard(dst)
        self._pred[dst].discard(src)
        self._touch()
        return True

    def del_node(self, node):
        """Removes a node and cascades deletion of all incident edges."""
        self._require(node)
        for p in list(self._pred[node]):
            self._succ[p].discard(node)
        for s in list(self._succ[node]):
            self._pred[s].discard(node)
        del self._succ[node]
        del self._pred[node]
        self._nodes.discard(node)
        self._touch()
        return True

    def order(self):
        """Deterministic topological order (lexicographically smallest).

        Recomputed only when the graph changed since the last call.
        """
        if self._dirty or self._cached_order is None:
            self._cached_order = self._kahn()
            self._dirty = False
        return list(self._cached_order)

    def _kahn(self):
        indeg = {n: len(self._pred[n]) for n in self._nodes}
        heap = [n for n in self._nodes if indeg[n] == 0]
        heapq.heapify(heap)
        out = []
        while heap:
            n = heapq.heappop(heap)
            out.append(n)
            for m in self._succ[n]:
                indeg[m] -= 1
                if indeg[m] == 0:
                    heapq.heappush(heap, m)
        if len(out) != len(self._nodes):
            raise CycleError(self._minimal_cycle_nodes(None, None))
        return out

    def _reachable(self, start, target):
        """True if ``target`` is reachable from ``start`` (start==target counts)."""
        if start == target:
            return True
        seen = {start}
        stack = [start]
        while stack:
            cur = stack.pop()
            for nxt in self._succ[cur]:
                if nxt == target:
                    return True
                if nxt not in seen:
                    seen.add(nxt)
                    stack.append(nxt)
        return False

    def _minimal_cycle_nodes(self, src, dst):
        """Lexicographically smallest node set among cyclic SCCs.

        Evaluated on the graph with the candidate edge (src, dst) included;
        the graph itself is not modified.
        """
        extra = (src, dst) if src is not None else None
        cyclic = []
        for comp in self._sccs(extra):
            if len(comp) > 1:
                cyclic.append(sorted(comp))
            else:
                (n,) = comp
                succ = self._succ[n] | ({dst} if extra and n == src else set())
                if n in succ:
                    cyclic.append([n])
        if not cyclic:
            return sorted([src, dst]) if extra else []
        return min(cyclic)

    def _sccs(self, extra_edge=None):
        """Iterative Tarjan SCC; ``extra_edge`` is a hypothetical (u, v) edge."""
        index_of = {}
        lowlink = {}
        on_stack = set()
        stack = []
        result = []
        counter = [0]

        def neighbors(u):
            ns = self._succ[u]
            if extra_edge and u == extra_edge[0]:
                ns = ns | {extra_edge[1]}
            return ns

        for root in sorted(self._nodes):
            if root in index_of:
                continue
            work = [(root, iter(sorted(neighbors(root))))]
            index_of[root] = lowlink[root] = counter[0]
            counter[0] += 1
            stack.append(root)
            on_stack.add(root)
            while work:
                node, it = work[-1]
                advanced = False
                for w in it:
                    if w not in index_of:
                        index_of[w] = lowlink[w] = counter[0]
                        counter[0] += 1
                        stack.append(w)
                        on_stack.add(w)
                        work.append((w, iter(sorted(neighbors(w)))))
                        advanced = True
                        break
                    elif w in on_stack:
                        lowlink[node] = min(lowlink[node], index_of[w])
                if advanced:
                    continue
                work.pop()
                if work:
                    parent = work[-1][0]
                    lowlink[parent] = min(lowlink[parent], lowlink[node])
                if lowlink[node] == index_of[node]:
                    comp = []
                    while True:
                        w = stack.pop()
                        on_stack.discard(w)
                        comp.append(w)
                        if w == node:
                            break
                    result.append(comp)
        return result

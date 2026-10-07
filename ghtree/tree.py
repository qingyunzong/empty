"""Gomory-Hu cut tree with certified edges, batch updates and rollback.

Every tree edge stores, for the graph state at build/repair time:

* ``value``  -- the min cut value between its endpoints,
* ``side``   -- a canonical cut side (sorted tuple, contains vertex 0),
* ``flow``   -- a feasible endpoint-to-endpoint flow of the same value
  (dual certificate).

A stored certificate is reused after a capacity update only when *both*
sides of the duality still check out against the updated graph: the cut
capacity of ``side`` still equals ``value`` *and* ``flow`` is still a
feasible flow of that value.  Otherwise the edge is re-solved.  After any
repair the whole tree is independently verified (every pair's tree-path
minimum is compared against a freshly computed max flow); if the topology
no longer certifies all pairs, the tree is rebuilt from scratch.
"""

from __future__ import annotations

from collections import deque
from typing import NamedTuple

from .graph import Graph, cut_capacity
from .maxflow import flow_ok, min_cut

STATE_FORMAT = "ghtree-state/1"


class UpdateError(ValueError):
    """Raised for illegal capacity updates; the tree is rolled back."""


class TreeEdge(NamedTuple):
    a: int        # endpoint, a < b
    b: int
    value: int    # min a-b cut value at certification time
    side: tuple   # canonical cut side: sorted tuple containing vertex 0
    source: int   # flow source (one of the endpoints)
    sink: int     # flow sink (the other endpoint)
    flow: tuple   # ((u, v, amount), ...) sorted, amount > 0

    @property
    def id(self):
        return (self.a, self.b)


def canonical_side(n: int, side) -> tuple:
    """Normalise a cut side: the side containing vertex 0, sorted.

    This makes the stored partition independent of how the cut was found
    or how sets happened to be iterated.
    """
    side = frozenset(side)
    if 0 in side:
        canon = side
    else:
        canon = frozenset(v for v in range(n) if v not in side)
    return tuple(sorted(canon))


def _gomory_hu_links(n: int, caps):
    """Gomory-Hu tree via component contraction.

    Returns a list of (u, v, value) links between original vertices.
    Deterministic: components, endpoints and neighbours are always
    processed in sorted order.
    """
    comps = [frozenset(range(n))]      # tree nodes = vertex sets
    adj = {0: {}}                      # component id -> {neighbour id: value}
    while True:
        xi = -1
        for i, comp in enumerate(comps):
            if len(comp) > 1:
                xi = i
                break
        if xi < 0:
            break
        members = sorted(comps[xi])
        s, t = members[0], members[1]

        # Contract every other component into a single supernode.
        super_of = {}
        supers = []
        for v in members:
            super_of[v] = len(supers)
            supers.append(("v", v))
        for ci, comp in enumerate(comps):
            if ci == xi:
                continue
            sid = len(supers)
            supers.append(("c", ci))
            for v in comp:
                super_of[v] = sid
        ccaps = {}
        for (u, v), c in caps.items():
            su, sv = super_of[u], super_of[v]
            if su == sv:
                continue
            key = (su, sv) if su < sv else (sv, su)
            ccaps[key] = ccaps.get(key, 0) + c
        value, side_supers, _ = min_cut(len(supers), ccaps,
                                        super_of[s], super_of[t])

        in_a = [False] * n
        for sid in side_supers:
            kind, ref = supers[sid]
            if kind == "v":
                in_a[ref] = True
            else:
                for v in comps[ref]:
                    in_a[v] = True

        xs = frozenset(v for v in comps[xi] if in_a[v])
        xt = comps[xi] - xs
        comps[xi] = xs
        ti = len(comps)
        comps.append(xt)
        adj[ti] = {}
        for y in sorted(adj[xi]):
            w = adj[xi][y]
            del adj[y][xi]
            if in_a[min(comps[y])]:
                adj[xi][y] = w
                adj[y][xi] = w
            else:
                del adj[xi][y]
                adj[ti][y] = w
                adj[y][ti] = w
        adj[xi][ti] = value
        adj[ti][xi] = value

    links = []
    for i in range(len(comps)):
        for j, w in adj[i].items():
            if i < j:
                links.append((min(comps[i]), min(comps[j]), w))
    return links


class CutTree:
    """Gomory-Hu cut tree over a :class:`ghtree.graph.Graph`."""

    def __init__(self, graph: Graph):
        self.graph = graph
        self.edges = []
        self._adj = []
        self._cache = {}
        self.build()

    # -- construction ---------------------------------------------------
    def _certify(self, u: int, v: int, expected=None) -> TreeEdge:
        caps = self.graph.capacities()
        value, side, flow = min_cut(self.graph.n, caps, u, v)
        if expected is not None and value != expected:
            raise RuntimeError(
                f"internal inconsistency: link value {expected} != "
                f"certified value {value} for ({u}, {v})")
        a, b = (u, v) if u < v else (v, u)
        return TreeEdge(a=a, b=b, value=value,
                        side=canonical_side(self.graph.n, side),
                        source=u, sink=v, flow=flow)

    def build(self) -> None:
        """(Re)build the tree from scratch for the current graph."""
        n = self.graph.n
        caps = self.graph.capacities()
        edges = []
        if n >= 2:
            for u, v, w in _gomory_hu_links(n, caps):
                edges.append(self._certify(u, v, expected=w))
        edges.sort(key=lambda e: (e.a, e.b))
        self.edges = edges
        self._rebuild_adj()
        self._cache = {}

    def _rebuild_adj(self) -> None:
        self._adj = [[] for _ in range(self.graph.n)]
        for e in self.edges:
            self._adj[e.a].append((e.b, e.value))
            self._adj[e.b].append((e.a, e.value))

    # -- queries --------------------------------------------------------
    def query(self, u: int, v: int):
        """Min-cut value between u and v (None for u == v)."""
        self.graph.check_vertex(u)
        self.graph.check_vertex(v)
        if u == v:
            return None
        key = (u, v) if u < v else (v, u)
        if key in self._cache:
            return self._cache[key]
        n = self.graph.n
        seen = [False] * n
        seen[u] = True
        best = [0] * n
        queue = deque([u])
        while queue:
            x = queue.popleft()
            for y, w in self._adj[x]:
                if not seen[y]:
                    seen[y] = True
                    best[y] = w if x == u else min(best[x], w)
                    queue.append(y)
        result = best[v]
        self._cache[key] = result
        return result

    def all_pairs(self):
        """{(u, v): value} for all u < v, keys sorted."""
        n = self.graph.n
        return {(u, v): self.query(u, v)
                for u in range(n) for v in range(u + 1, n)}

    # -- certificates ---------------------------------------------------
    def _cert_ok(self, e: TreeEdge) -> bool:
        """Dual evidence: cut capacity == value == feasible flow value."""
        caps = self.graph.capacities()
        if cut_capacity(caps, set(e.side)) != e.value:
            return False
        return flow_ok(caps, e.source, e.sink, e.flow, e.value)

    def verify(self):
        """Independent audit of the tree against the current graph.

        Returns a list of human-readable error strings; empty means the
        tree and all stored certificates are consistent.
        """
        errors = []
        n = self.graph.n
        caps = self.graph.capacities()

        if len(self.edges) != max(0, n - 1):
            errors.append(
                f"tree has {len(self.edges)} edges, expected {max(0, n - 1)}")

        parent = list(range(n))

        def find(x):
            while parent[x] != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x

        for e in self.edges:
            if not (0 <= e.a < e.b < n):
                errors.append(f"edge {e.id}: invalid endpoints")
                continue
            if find(e.a) == find(e.b):
                errors.append(f"edge {e.id}: creates a cycle")
            parent[find(e.a)] = find(e.b)
            side = set(e.side)
            if (not side or 0 not in side or len(side) >= n
                    or list(e.side) != sorted(side)):
                errors.append(f"edge {e.id}: cut side not canonical")
            if (e.a in side) == (e.b in side):
                errors.append(f"edge {e.id}: cut does not separate endpoints")
            if cut_capacity(caps, side) != e.value:
                errors.append(
                    f"edge {e.id}: cut capacity != value ({e.value})")
            if {e.source, e.sink} != {e.a, e.b}:
                errors.append(f"edge {e.id}: flow endpoints mismatch")
            if not flow_ok(caps, e.source, e.sink, e.flow, e.value):
                errors.append(f"edge {e.id}: flow certificate infeasible")
        if n >= 2 and len({find(v) for v in range(n)}) != 1:
            errors.append("tree is not spanning")

        for u in range(n):
            for v in range(u + 1, n):
                claimed = self.query(u, v)
                actual, _, _ = min_cut(n, caps, u, v)
                if claimed != actual:
                    errors.append(
                        f"pair ({u}, {v}): tree says {claimed}, "
                        f"max-flow says {actual}")
        return errors

    # -- updates --------------------------------------------------------
    def update(self, updates):
        """Apply a batch of (u, v, new_capacity) updates.

        Returns {"reused": [[a, b], ...], "resolved": [[a, b], ...],
                 "rebuilt": bool}.  Illegal updates raise UpdateError and
        leave the graph, tree and cache exactly as before.
        """
        updates = [tuple(item) for item in updates]
        for item in updates:
            if len(item) != 3:
                raise UpdateError(f"malformed update: {item!r}")
            u, v, c = item
            try:
                self.graph.check_vertex(u)
                self.graph.check_vertex(v)
                self.graph.check_capacity(c)
            except ValueError as exc:
                raise UpdateError(str(exc)) from exc

        snapshot = self.to_state()
        try:
            for u, v, c in updates:
                self.graph.set_capacity(u, v, c)

            reused, resolved = [], []
            new_edges = []
            for e in self.edges:
                if self._cert_ok(e):
                    reused.append(list(e.id))
                    new_edges.append(e)
                else:
                    new_edges.append(self._certify(e.a, e.b))
                    resolved.append(list(e.id))
            self.edges = new_edges
            self._rebuild_adj()
            self._cache = {}

            rebuilt = False
            if self.verify():
                # Topology no longer certifies all pairs: full rebuild.
                self.build()
                reused = []
                resolved = [list(e.id) for e in self.edges]
                rebuilt = True
            return {"reused": sorted(reused), "resolved": sorted(resolved),
                    "rebuilt": rebuilt}
        except Exception:
            self._load_state(snapshot)
            raise

    # -- serialisation --------------------------------------------------
    def to_state(self):
        return {
            "format": STATE_FORMAT,
            "n": self.graph.n,
            "capacities": self.graph.edge_list(),
            "tree": [
                {
                    "endpoints": [e.a, e.b],
                    "value": e.value,
                    "cut_side": list(e.side),
                    "source": e.source,
                    "sink": e.sink,
                    "flow": [[u, v, a] for u, v, a in e.flow],
                }
                for e in self.edges
            ],
        }

    @classmethod
    def from_state(cls, state) -> "CutTree":
        if state.get("format") != STATE_FORMAT:
            raise ValueError("unrecognised state format")
        tree = cls.__new__(cls)
        tree._load_state(state)
        return tree

    def _load_state(self, state) -> None:
        graph = Graph(state["n"], [tuple(e) for e in state["capacities"]])
        edges = []
        for item in state["tree"]:
            a, b = item["endpoints"]
            edges.append(TreeEdge(
                a=int(a), b=int(b),
                value=int(item["value"]),
                side=tuple(int(x) for x in item["cut_side"]),
                source=int(item["source"]),
                sink=int(item["sink"]),
                flow=tuple(tuple(int(x) for x in f) for f in item["flow"]),
            ))
        self.graph = graph
        self.edges = edges
        self._rebuild_adj()
        self._cache = {}

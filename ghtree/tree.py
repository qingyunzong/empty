"""Gomory-Hu cut trees for undirected integer-capacity multigraphs.

The tree answers min-cut queries between any pair of vertices: the value is
the minimum edge weight on the unique tree path.  Every tree edge stores the
*actual* cut side (vertex set) and capacity observed at build/repair time,
plus a feasible flow, so each edge carries "double evidence" (a cut and a
flow of equal value) for its weight.

A tree is a Gomory-Hu *cut* tree iff for every tree edge the bipartition
induced by removing that edge (its tree shores) is a minimum cut between
the edge's endpoints; only then does the path minimum equal the pairwise
min cut for *every* pair.  Both the construction (Gusfield's method) and
the update repair below maintain exactly this invariant, and ``verify``
independently re-checks it together with the per-edge certificates.
"""

from collections import deque
from itertools import combinations

from .maxflow import cut_capacity, maxflow, verify_flow


class TreeEdge:
    """One edge of the cut tree.

    ``cut`` is a sorted tuple of vertex indices: the side of a minimum
    u-v cut (in the graph state when the edge was (re)validated) that
    contains ``u`` and not ``v``.  ``flow`` maps ``(a, b)`` with ``a < b``
    to signed net flow, a feasible u->v flow of value ``w``.
    """

    __slots__ = ("u", "v", "w", "cut", "flow")

    def __init__(self, u, v, w, cut, flow):
        self.u = u
        self.v = v
        self.w = w
        self.cut = cut
        self.flow = flow


def _check_label(label):
    if not isinstance(label, str):
        raise TypeError("vertex labels must be strings, got %r" % (label,))
    return label


def _check_capacity(c):
    if not isinstance(c, int) or isinstance(c, bool):
        raise ValueError("capacity must be an integer, got %r" % (c,))
    if c < 0:
        raise ValueError("capacity must be non-negative, got %r" % (c,))
    return c


class GomoryHuTree:
    """Gomory-Hu cut tree over string-labelled vertices.

    Vertex order is the explicit sort rule ``sorted(labels)``; every
    partition emitted is normalised with it, so results never depend on
    set/dict iteration order.
    """

    def __init__(self, vertices, edges=()):
        labels = sorted({_check_label(v) for v in vertices})
        if not labels:
            raise ValueError("need at least one vertex")
        self.labels = labels
        self.index = {lab: i for i, lab in enumerate(labels)}
        self.cap = [dict() for _ in labels]
        for item in edges:
            a, b, c = item
            self._add_capacity(a, b, c)
        self.edges = []
        self._build()

    # ------------------------------------------------------------------
    # construction
    # ------------------------------------------------------------------
    def _idx(self, label):
        _check_label(label)
        try:
            return self.index[label]
        except KeyError:
            raise ValueError("unknown vertex %r" % (label,)) from None

    def _add_capacity(self, a, b, c):
        c = _check_capacity(c)
        i, j = self._idx(a), self._idx(b)
        if i == j:
            return  # self-loops are ignored
        self.cap[i][j] = self.cap[i].get(j, 0) + c
        self.cap[j][i] = self.cap[j].get(i, 0) + c

    def _build(self, flow_cache=None):
        """Gusfield's simplified Gomory-Hu construction (n-1 max-flows).

        ``flow_cache`` optionally maps an ordered pair ``(i, j)`` to a
        precomputed ``(value, flow, reach)`` with source ``i``; matching
        entries are reused instead of recomputing the max-flow.
        Returns ``(reused_flows, computed_flows)``.
        """
        n = len(self.labels)
        cache = flow_cache or {}
        reused = computed = 0
        parent = [0] * n
        self.edges = []
        for s in range(1, n):
            t = parent[s]
            hit = cache.get((s, t))
            if hit is not None:
                value, flow, reach = hit
                reused += 1
            else:
                value, flow, reach = maxflow(self.cap, s, t)
                computed += 1
            self.edges.append(TreeEdge(s, t, value, tuple(sorted(reach)), flow))
            for i in range(s + 1, n):
                if parent[i] == t and i in reach:
                    parent[i] = s
        return reused, computed

    # ------------------------------------------------------------------
    # queries
    # ------------------------------------------------------------------
    def _pair(self, a, b):
        i, j = self._idx(a), self._idx(b)
        if i == j:
            raise ValueError("need two distinct vertices, got %r twice" % (a,))
        return i, j

    def _tree_adj(self):
        adj = [[] for _ in self.labels]
        for k, e in enumerate(self.edges):
            adj[e.u].append((e.v, k))
            adj[e.v].append((e.u, k))
        return adj

    def _path_edges(self, i, j):
        adj = self._tree_adj()
        prev = [-2] * len(self.labels)
        prev[i] = -1
        edge_to = [-1] * len(self.labels)
        queue = deque([i])
        while queue:
            x = queue.popleft()
            if x == j:
                break
            for y, k in adj[x]:
                if prev[y] == -2:
                    prev[y] = x
                    edge_to[y] = k
                    queue.append(y)
        if prev[j] == -2:
            raise AssertionError("cut tree is not connected")
        path = []
        x = j
        while x != i:
            path.append(edge_to[x])
            x = prev[x]
        return path

    def query(self, a, b):
        """Min-cut value between vertices ``a`` and ``b``."""
        i, j = self._pair(a, b)
        return min(self.edges[k].w for k in self._path_edges(i, j))

    def query_cut(self, a, b):
        """Min-cut value plus a *verified* cut certificate for ``a``/``b``.

        The tree-edge cut sides are never trusted blindly: a stored side is
        only returned after checking that it separates ``a`` from ``b`` and
        that its capacity in the current graph equals the path value.
        Otherwise a fresh max-flow is computed for the certificate.
        """
        i, j = self._pair(a, b)
        path = self._path_edges(i, j)
        m = min(self.edges[k].w for k in path)
        side = None
        source = "tree"
        for k in path:
            e = self.edges[k]
            if e.w != m:
                continue
            cut_set = set(e.cut)
            if (i in cut_set) != (j in cut_set) and \
                    cut_capacity(self.cap, cut_set) == m:
                side = sorted(self.labels[x] for x in e.cut)
                break
        if side is None:
            value, _flow, reach = maxflow(self.cap, i, j)
            if value != m:
                raise AssertionError(
                    "tree path value %d contradicts max-flow %d" % (m, value))
            side = sorted(self.labels[x] for x in reach)
            source = "recomputed"
        side_set = set(side)
        other = sorted(lab for lab in self.labels if lab not in side_set)
        # explicit normalisation rule: the two sorted sides are ordered
        # lexicographically, so the partition is order-independent.
        first, second = sorted([side, other])
        return {"pair": [a, b], "value": m, "partition": [first, second],
                "certificate": source}

    # ------------------------------------------------------------------
    # batch capacity updates
    # ------------------------------------------------------------------
    def update(self, updates):
        """Apply a batch of ``(label_u, label_v, new_capacity)`` updates.

        The whole batch is validated first; any illegal update (negative or
        non-integer capacity, unknown vertex) rolls the graph, cache and
        tree back to the exact previous state and re-raises.

        Returns a report dict listing possibly-invalidated, reused and
        re-solved tree edges.
        """
        snapshot = self.to_dict()
        try:
            parsed = []
            for item in updates:
                a, b, c = item
                c = _check_capacity(c)
                i, j = self._idx(a), self._idx(b)
                if i != j:  # self-loop updates are ignored like self-loops
                    parsed.append((i, j, c))
            for i, j, c in parsed:
                if c == 0:
                    self.cap[i].pop(j, None)
                    self.cap[j].pop(i, None)
                else:
                    self.cap[i][j] = c
                    self.cap[j][i] = c
            report = self._repair(parsed)
        except Exception:
            self._restore(snapshot)
            raise
        return report

    def _repair(self, parsed):
        """Re-validate every stored cut against the new residual state.

        A stored cut is reused only with double evidence: its capacity in
        the updated graph equals the value of a feasible max-flow between
        the edge endpoints.  If every edge still verifies, the (still
        valid) cut tree is kept.  Otherwise the tree is rebuilt with
        Gusfield's method, reusing the certificates gathered during
        verification whenever the same vertex pair's min cut is needed.
        """
        n = len(self.labels)
        possibly = []
        reused = []
        failed = []
        flow_cache = {}
        for e in self.edges:
            old_w = e.w
            cut_set = set(e.cut)
            c_new = cut_capacity(self.cap, cut_set)
            touched = any(i in cut_set or j in cut_set for i, j, _c in parsed)
            if c_new != old_w or touched:
                possibly.append({"u": self.labels[e.u], "v": self.labels[e.v],
                                 "old_weight": old_w, "cut_capacity": c_new})
            value, flow, reach = maxflow(self.cap, e.u, e.v)
            flow_cache[(e.u, e.v)] = (value, flow, reach)
            if value == c_new:
                e.w = value
                e.flow = flow
                reused.append(e)
            else:
                failed.append({"u": self.labels[e.u], "v": self.labels[e.v],
                               "old_weight": old_w, "new_weight": value})
        if not failed:
            self.edges = reused
            return {"possibly_invalid": possibly,
                    "reused": [self._edge_info(e) for e in reused],
                    "recomputed": [],
                    "tree_rebuilt": False,
                    "verification_flows": n - 1,
                    "rebuild_flows_reused": 0,
                    "rebuild_flows_computed": 0}
        # Flip cached certificates so both orientations are available.
        for (i, j), (value, flow, reach) in list(flow_cache.items()):
            flow_cache[(j, i)] = (value,
                                  {k: -f for k, f in flow.items()},
                                  set(range(n)) - reach)
        flows_reused, flows_computed = self._build(flow_cache)
        return {"possibly_invalid": possibly,
                "reused": [self._edge_info(e) for e in reused],
                "recomputed": failed,
                "tree_rebuilt": True,
                "verification_flows": n - 1,
                "rebuild_flows_reused": flows_reused,
                "rebuild_flows_computed": flows_computed}

    def _edge_info(self, e):
        return {"u": self.labels[e.u], "v": self.labels[e.v], "weight": e.w}

    # ------------------------------------------------------------------
    # independent certificate verification
    # ------------------------------------------------------------------
    def verify(self):
        """Independently verify the tree against the current graph.

        Checks, per tree edge, that the stored cut separates the endpoints,
        that its capacity equals the edge weight, and that the stored flow
        is feasible with the same value (cut == flow: double evidence).
        Then checks every pair of vertices: the tree path value must be
        backed by a certificate cut on the path, or is confirmed by an
        independent max-flow recomputation.
        """
        n = len(self.labels)
        labels = self.labels
        errors = []
        edge_checks = []
        if len(self.edges) != max(0, n - 1):
            errors.append("tree has %d edges, expected %d"
                          % (len(self.edges), max(0, n - 1)))
        for e in self.edges:
            problems = []
            cut_set = set(e.cut)
            if e.u not in cut_set or e.v in cut_set:
                problems.append("cut side does not separate endpoints")
            c = cut_capacity(self.cap, cut_set)
            if c != e.w:
                problems.append("cut capacity %d != edge weight %d" % (c, e.w))
            problems.extend(verify_flow(self.cap, e.u, e.v, e.flow, e.w))
            edge_checks.append({"edge": [labels[e.u], labels[e.v]],
                                "ok": not problems, "problems": problems})
            errors.extend("edge (%s,%s): %s" % (labels[e.u], labels[e.v], p)
                          for p in problems)
        pair_checks = []
        for i, j in combinations(range(n), 2):
            path = self._path_edges(i, j)
            m = min(self.edges[k].w for k in path)
            certified = False
            for k in path:
                e = self.edges[k]
                cut_set = set(e.cut)
                if e.w == m and (i in cut_set) != (j in cut_set) and \
                        cut_capacity(self.cap, cut_set) == m:
                    certified = True
                    break
            method = "certificate"
            if not certified:
                value, _flow, _reach = maxflow(self.cap, i, j)
                method = "recomputed"
                if value != m:
                    errors.append(
                        "pair (%s,%s): path value %d != max-flow %d"
                        % (labels[i], labels[j], m, value))
            pair_checks.append({"pair": [labels[i], labels[j]], "value": m,
                                "method": method})
        return {"ok": not errors, "errors": errors,
                "edge_checks": edge_checks, "pair_checks": pair_checks}

    # ------------------------------------------------------------------
    # persistence
    # ------------------------------------------------------------------
    def to_dict(self):
        edges = []
        for i, lab_i in enumerate(self.labels):
            for j, c in sorted(self.cap[i].items()):
                if i < j and c > 0:
                    edges.append([lab_i, self.labels[j], c])
        tree = []
        for e in self.edges:
            flow = [[self.labels[a], self.labels[b], f]
                    for (a, b), f in sorted(e.flow.items())]
            tree.append({"u": self.labels[e.u], "v": self.labels[e.v],
                         "weight": e.w,
                         "cut_side": [self.labels[x] for x in e.cut],
                         "flow": flow})
        return {"vertices": list(self.labels), "edges": edges, "tree": tree}

    @classmethod
    def from_dict(cls, data):
        obj = cls.__new__(cls)
        labels = [_check_label(v) for v in data["vertices"]]
        if not labels:
            raise ValueError("state has no vertices")
        obj.labels = labels
        obj.index = {lab: i for i, lab in enumerate(labels)}
        obj.cap = [dict() for _ in labels]
        for a, b, c in data["edges"]:
            c = _check_capacity(c)
            i, j = obj._idx(a), obj._idx(b)
            if i == j:
                continue
            obj.cap[i][j] = obj.cap[i].get(j, 0) + c
            obj.cap[j][i] = obj.cap[j].get(i, 0) + c
        obj.edges = []
        for te in data["tree"]:
            u = obj._idx(te["u"])
            v = obj._idx(te["v"])
            w = _check_capacity(te["weight"])
            cut = tuple(sorted(obj._idx(x) for x in te["cut_side"]))
            flow = {}
            for a, b, f in te["flow"]:
                x, y = obj._idx(a), obj._idx(b)
                if x == y:
                    raise ValueError("flow on self-loop %r" % (a,))
                if x > y:
                    x, y, f = y, x, -f
                flow[(x, y)] = flow.get((x, y), 0) + f
            obj.edges.append(TreeEdge(u, v, w, cut, flow))
        return obj

    def _restore(self, snapshot):
        other = GomoryHuTree.from_dict(snapshot)
        self.labels = other.labels
        self.index = other.index
        self.cap = other.cap
        self.edges = other.edges

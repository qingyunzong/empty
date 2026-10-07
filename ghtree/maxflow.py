"""Dinic max-flow / min-cut on undirected integer capacity graphs."""

from __future__ import annotations

from collections import deque

_INF = 1 << 62


class Dinic:
    def __init__(self, n: int):
        self.n = n
        self.adj = [[] for _ in range(n)]
        self.to = []
        self.cap = []   # residual capacity
        self.base = []  # original capacity

    def add_directed(self, u: int, v: int, c: int) -> int:
        self.to.append(v)
        self.cap.append(c)
        self.base.append(c)
        self.adj[u].append(len(self.to) - 1)
        self.to.append(u)
        self.cap.append(0)
        self.base.append(0)
        self.adj[v].append(len(self.to) - 1)
        return len(self.to) - 2

    def reset(self) -> None:
        for i, b in enumerate(self.base):
            self.cap[i] = b

    def max_flow(self, s: int, t: int) -> int:
        if s == t:
            raise ValueError("source and sink must differ")
        total = 0
        n = self.n
        while True:
            level = [-1] * n
            level[s] = 0
            queue = deque([s])
            while queue:
                u = queue.popleft()
                for a in self.adj[u]:
                    w = self.to[a]
                    if self.cap[a] > 0 and level[w] < 0:
                        level[w] = level[u] + 1
                        queue.append(w)
            if level[t] < 0:
                return total
            it = [0] * n
            while True:
                pushed = self._dfs(s, t, level, it, _INF)
                if not pushed:
                    break
                total += pushed

    def _dfs(self, u, t, level, it, f):
        if u == t:
            return f
        adj = self.adj[u]
        while it[u] < len(adj):
            a = adj[it[u]]
            w = self.to[a]
            if self.cap[a] > 0 and level[w] == level[u] + 1:
                d = self._dfs(w, t, level, it, min(f, self.cap[a]))
                if d:
                    self.cap[a] -= d
                    self.cap[a ^ 1] += d
                    return d
            it[u] += 1
        return 0

    def reachable_from(self, s: int):
        seen = [False] * self.n
        seen[s] = True
        stack = [s]
        while stack:
            u = stack.pop()
            for a in self.adj[u]:
                w = self.to[a]
                if self.cap[a] > 0 and not seen[w]:
                    seen[w] = True
                    stack.append(w)
        return seen


def build_network(n: int, caps):
    """Build a Dinic network from an undirected capacity map.

    Returns (dinic, arcs) where arcs[(u, v)] = (forward_arc, backward_arc)
    for each unordered pair u < v.
    """
    din = Dinic(n)
    arcs = {}
    for (u, v) in sorted(caps):
        c = caps[(u, v)]
        a1 = din.add_directed(u, v, c)
        a2 = din.add_directed(v, u, c)
        arcs[(u, v)] = (a1, a2)
    return din, arcs


def min_cut(n: int, caps, s: int, t: int):
    """Min s-t cut in an undirected graph.

    Returns (value, side, flow) where ``side`` is the frozenset of vertices
    reachable from ``s`` in the residual graph (contains ``s``) and ``flow``
    is a tuple of (u, v, amount) net-flow entries, amount > 0, sorted --
    a feasible s-t flow of the same value (dual certificate).
    """
    din, arcs = build_network(n, caps)
    value = din.max_flow(s, t)
    reach = din.reachable_from(s)
    side = frozenset(v for v in range(n) if reach[v])
    flow = []
    for (u, v) in sorted(arcs):
        a1, a2 = arcs[(u, v)]
        net = (din.base[a1] - din.cap[a1]) - (din.base[a2] - din.cap[a2])
        if net > 0:
            flow.append((u, v, net))
        elif net < 0:
            flow.append((v, u, -net))
    return value, side, tuple(flow)


def flow_ok(caps, source: int, sink: int, flow, value: int) -> bool:
    """Check that ``flow`` is a feasible source->sink flow of ``value``.

    Feasibility is checked against the *current* capacity map ``caps``:
    every used arc must fit within the current capacity of its pair.
    """
    if not isinstance(value, int) or value < 0:
        return False
    seen = set()
    balance = {}
    for entry in flow:
        if len(entry) != 3:
            return False
        u, v, amount = entry
        if not (isinstance(u, int) and isinstance(v, int) and isinstance(amount, int)):
            return False
        if u == v or amount <= 0:
            return False
        key = (u, v) if u < v else (v, u)
        if key in seen:
            return False
        seen.add(key)
        if amount > caps.get(key, 0):
            return False
        balance[u] = balance.get(u, 0) + amount
        balance[v] = balance.get(v, 0) - amount
    for node, bal in balance.items():
        if node == source:
            if bal != value:
                return False
        elif node == sink:
            if bal != -value:
                return False
        elif bal != 0:
            return False
    if value and source not in balance:
        return False
    return True

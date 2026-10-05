"""Max-flow (Dinic) and cut/flow-certificate utilities.

Graphs are undirected integer-capacity multigraphs, stored in aggregated
form as ``cap``: a list of dicts where ``cap[u][v]`` is the total capacity
of the undirected edge ``{u, v}``.  Self-loops are meaningless for cuts and
are ignored everywhere.  Zero capacity is allowed (the edge simply carries
nothing).
"""

from collections import deque

_INF = None  # computed lazily inside maxflow


def cut_capacity(cap, side):
    """Total capacity of edges crossing (``side``, V \\ ``side``)."""
    total = 0
    for u in side:
        for v, c in cap[u].items():
            if v not in side:
                total += c
    return total


def maxflow(cap, s, t):
    """Dinic max-flow from ``s`` to ``t`` on the undirected graph ``cap``.

    Returns ``(value, flows, reach)`` where

    * ``value`` is the max-flow (= min s-t cut) value,
    * ``flows`` maps ``(u, v)`` with ``u < v`` to the signed net flow on the
      undirected edge ``{u, v}`` (positive means u -> v); only non-zero
      entries are stored,
    * ``reach`` is the set of vertices reachable from ``s`` in the residual
      graph, i.e. the source side of a minimum s-t cut (contains ``s``,
      never ``t``).

    Neighbours are processed in sorted order so the result is deterministic
    regardless of dict insertion order.
    """
    n = len(cap)
    graph = [[] for _ in range(n)]  # adjacency of [to, residual_cap, rev_idx]
    arcs = {}  # (u, v) with u < v -> ((u, idx_uv), (v, idx_vu))

    def add_arc(frm, to, c):
        graph[frm].append([to, c, len(graph[to])])
        graph[to].append([frm, 0, len(graph[frm]) - 1])

    for u in range(n):
        for v, c in sorted(cap[u].items()):
            if u < v:
                if c <= 0:
                    continue
                idx_uv = len(graph[u])
                add_arc(u, v, c)
                idx_vu = len(graph[v])
                add_arc(v, u, c)
                arcs[(u, v)] = ((u, idx_uv), (v, idx_vu))

    inf = sum(c for u in range(n) for c in cap[u].values()) + 1
    value = 0
    while True:
        level = [-1] * n
        level[s] = 0
        queue = deque([s])
        while queue:
            x = queue.popleft()
            for to, residual, _rev in graph[x]:
                if residual > 0 and level[to] < 0:
                    level[to] = level[x] + 1
                    queue.append(to)
        if level[t] < 0:
            break
        nxt = [0] * n

        def dfs(x, f):
            if x == t:
                return f
            adj = graph[x]
            while nxt[x] < len(adj):
                edge = adj[nxt[x]]
                if edge[1] > 0 and level[edge[0]] == level[x] + 1:
                    pushed = dfs(edge[0], min(f, edge[1]))
                    if pushed > 0:
                        edge[1] -= pushed
                        graph[edge[0]][edge[2]][1] += pushed
                        return pushed
                nxt[x] += 1
            return 0

        while True:
            pushed = dfs(s, inf)
            if pushed == 0:
                break
            value += pushed

    flows = {}
    for (u, v), ((fu, iu), (fv, iv)) in arcs.items():
        c = cap[u][v]
        net = (c - graph[fu][iu][1]) - (c - graph[fv][iv][1])
        if net:
            flows[(u, v)] = net

    reach = set()
    stack = [s]
    reach.add(s)
    while stack:
        x = stack.pop()
        for to, residual, _rev in graph[x]:
            if residual > 0 and to not in reach:
                reach.add(to)
                stack.append(to)
    return value, flows, reach


def verify_flow(cap, s, t, flows, value):
    """Check that ``flows`` is a feasible s-t flow of exactly ``value``.

    Returns a list of human-readable problems; empty means the certificate
    is valid.  ``flows`` maps ``(u, v)`` with ``u < v`` to signed net flow.
    """
    problems = []
    n = len(cap)
    balance = [0] * n
    for (u, v), f in sorted(flows.items()):
        if not (isinstance(u, int) and isinstance(v, int) and 0 <= u < v < n):
            problems.append("flow entry on invalid edge %r" % ((u, v),))
            continue
        if not isinstance(f, int) or isinstance(f, bool):
            problems.append("non-integer flow %r on edge (%d, %d)" % (f, u, v))
            continue
        c = cap[u].get(v, 0)
        if abs(f) > c:
            problems.append(
                "flow %d exceeds capacity %d on edge (%d, %d)" % (f, c, u, v))
        balance[u] -= f
        balance[v] += f
    for x in range(n):
        if x == s:
            if balance[x] != -value:
                problems.append(
                    "net outflow at source %d is %d, expected %d"
                    % (s, -balance[x], value))
        elif x == t:
            if balance[x] != value:
                problems.append(
                    "net inflow at sink %d is %d, expected %d"
                    % (t, balance[x], value))
        elif balance[x] != 0:
            problems.append("flow conservation violated at vertex %d" % x)
    return problems

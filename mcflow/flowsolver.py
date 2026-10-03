"""Low-level integral flow algorithms shared by the library.

Everything here works on plain residual graphs with integer capacities:
Edmonds-Karp max flow, Bellman-Ford negative-cycle detection and
cycle-cancelling min-cost flow.  These are verification-grade building
blocks, deliberately kept simple and exact (no floating point).
"""

from __future__ import annotations

from collections import deque


class _Arc:
    __slots__ = ("u", "v", "cap", "orig_cap", "cost", "rev", "tag")

    def __init__(self, u, v, cap, cost, rev, tag=None):
        self.u = u
        self.v = v
        self.cap = cap
        self.orig_cap = cap
        self.cost = cost
        self.rev = rev
        self.tag = tag


def _add_arc(graph, u, v, cap, cost, tag=None):
    fwd = _Arc(u, v, cap, cost, len(graph[v]), tag)
    bwd = _Arc(v, u, 0, -cost, len(graph[u]), None)
    graph[u].append(fwd)
    graph[v].append(bwd)
    return fwd


def _augment_to_max(graph, source, sink):
    total = 0
    n = len(graph)
    while True:
        prev = [None] * n
        prev[source] = (source, None)
        queue = deque([source])
        while queue and prev[sink] is None:
            u = queue.popleft()
            for arc in graph[u]:
                if arc.cap > 0 and prev[arc.v] is None:
                    prev[arc.v] = (u, arc)
                    queue.append(arc.v)
        if prev[sink] is None:
            return total
        bottleneck = None
        v = sink
        while v != source:
            u, arc = prev[v]
            bottleneck = arc.cap if bottleneck is None else min(bottleneck, arc.cap)
            v = u
        v = sink
        while v != source:
            u, arc = prev[v]
            arc.cap -= bottleneck
            graph[arc.v][arc.rev].cap += bottleneck
            v = u
        total += bottleneck


def max_flow(num_nodes, arcs, source, sink):
    """Return (value, reachable) where reachable marks residual-reachable nodes."""
    graph = [[] for _ in range(num_nodes)]
    for (u, v, cap) in arcs:
        _add_arc(graph, u, v, cap, 0)
    value = _augment_to_max(graph, source, sink)
    reachable = [False] * num_nodes
    reachable[source] = True
    stack = [source]
    while stack:
        u = stack.pop()
        for arc in graph[u]:
            if arc.cap > 0 and not reachable[arc.v]:
                reachable[arc.v] = True
                stack.append(arc.v)
    return value, reachable


def find_negative_cycle(graph):
    """Return a list of residual arcs forming a negative-cost cycle, or None."""
    arcs = [arc for node_arcs in graph for arc in node_arcs if arc.cap > 0]
    n = len(graph)
    dist = [0] * n
    parent = [None] * n
    last = None
    for _ in range(n):
        last = None
        for arc in arcs:
            if dist[arc.u] + arc.cost < dist[arc.v]:
                dist[arc.v] = dist[arc.u] + arc.cost
                parent[arc.v] = arc
                last = arc.v
    if last is None:
        return None
    y = last
    for _ in range(n):
        y = parent[y].u
    cycle = []
    v = y
    while True:
        arc = parent[v]
        cycle.append(arc)
        v = arc.u
        if v == y:
            break
    cycle.reverse()
    return cycle


def min_cost_flow(nodes, arcs, balances):
    """Min-cost flow satisfying balances (inflow - outflow == balances[v]).

    arcs: iterable of (tail, head, capacity, cost, tag).
    Returns {tag: flow} or None if the instance is infeasible.
    """
    if sum(balances.get(v, 0) for v in nodes) != 0:
        return None
    index = {v: i for i, v in enumerate(nodes)}
    n = len(nodes)
    source, sink = n, n + 1
    graph = [[] for _ in range(n + 2)]
    tagged = []
    for (tail, head, cap, cost, tag) in arcs:
        if cap > 0:
            tagged.append(_add_arc(graph, index[tail], index[head], cap, cost, tag))
        else:
            tagged.append(None)
    need = 0
    for v in nodes:
        d = balances.get(v, 0)
        if d > 0:
            _add_arc(graph, index[v], sink, d, 0)
            need += d
        elif d < 0:
            _add_arc(graph, source, index[v], -d, 0)
    if _augment_to_max(graph, source, sink) < need:
        return None
    while True:
        cycle = find_negative_cycle(graph)
        if cycle is None:
            break
        bottleneck = min(arc.cap for arc in cycle)
        for arc in cycle:
            arc.cap -= bottleneck
            graph[arc.v][arc.rev].cap += bottleneck
    result = {}
    for arc in tagged:
        if arc is not None:
            result[arc.tag] = arc.orig_cap - arc.cap
    return result

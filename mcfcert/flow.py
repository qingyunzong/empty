"""Small-scale network flow primitives (stdlib only).

Residual arcs are stored as ``[to, rev_index, capacity, cost]`` lists inside
per-node adjacency lists.  Correctness and clarity beat asymptotic
performance: the target networks are small.
"""

from collections import deque


def build_graph(num_nodes):
    return [[] for _ in range(num_nodes)]


def add_arc(graph, tail, head, capacity, cost=0):
    """Add a residual arc pair; returns ``(tail, index)`` of the forward arc."""
    forward = [head, len(graph[head]), capacity, cost]
    backward = [tail, len(graph[tail]), 0, -cost]
    graph[tail].append(forward)
    graph[head].append(backward)
    return (tail, len(graph[tail]) - 1)


def max_flow(graph, source, sink):
    """Edmonds-Karp max flow; mutates and returns the flow value."""
    total = 0
    while True:
        prev = [None] * len(graph)
        prev[source] = (source, -1)
        queue = deque([source])
        while queue and prev[sink] is None:
            u = queue.popleft()
            for i, arc in enumerate(graph[u]):
                if arc[2] > 0 and prev[arc[0]] is None:
                    prev[arc[0]] = (u, i)
                    queue.append(arc[0])
        if prev[sink] is None:
            return total
        delta = None
        v = sink
        while v != source:
            u, i = prev[v]
            cap = graph[u][i][2]
            delta = cap if delta is None else min(delta, cap)
            v = u
        v = sink
        while v != source:
            u, i = prev[v]
            arc = graph[u][i]
            arc[2] -= delta
            graph[arc[0]][arc[1]][2] += delta
            v = u
        total += delta


def reachable_from(graph, source):
    """Set of node indices reachable from ``source`` via positive-capacity arcs."""
    seen = [False] * len(graph)
    seen[source] = True
    queue = deque([source])
    while queue:
        u = queue.popleft()
        for arc in graph[u]:
            if arc[2] > 0 and not seen[arc[0]]:
                seen[arc[0]] = True
                queue.append(arc[0])
    return {i for i, ok in enumerate(seen) if ok}


def find_negative_cycle(graph):
    """Bellman-Ford negative-cycle detection on the residual graph.

    Returns a list of ``(node, arc_index)`` pairs forming the cycle in
    traversal order, or ``None`` when no negative cycle exists.
    """
    n = len(graph)
    dist = [0] * n  # virtual super-source with zero arcs to every node
    parent = [None] * n
    updated = -1
    for _ in range(n):
        updated = -1
        for u in range(n):
            du = dist[u]
            for i, arc in enumerate(graph[u]):
                if arc[2] > 0 and dist[arc[0]] > du + arc[3]:
                    dist[arc[0]] = du + arc[3]
                    parent[arc[0]] = (u, i)
                    updated = arc[0]
        if updated == -1:
            return None
    v = updated
    for _ in range(n):
        v = parent[v][0]
    cycle = []
    cur = v
    while True:
        u, i = parent[cur]
        cycle.append((u, i))
        cur = u
        if cur == v:
            break
    cycle.reverse()
    return cycle


def negative_cycle_from_arcs(num_nodes, arcs):
    """Find a negative cycle in a plain weighted digraph.

    ``arcs`` is a list of ``(tail, head, weight)``.  Returns the list of
    arc indices forming a negative cycle, or ``None``.
    """
    graph = build_graph(num_nodes)
    positions = [add_arc(graph, u, v, 1, w) for (u, v, w) in arcs]
    cycle = find_negative_cycle(graph)
    if cycle is None:
        return None
    index_of = {pos: k for k, pos in enumerate(positions)}
    return [index_of[pos] for pos in cycle]


def _layer_demands(num_nodes, arcs, balances, costs):
    """Shared super-graph construction for (min-cost) feasible flow.

    balances[v] is the required inflow - outflow at v.  Nodes with positive
    balance drain to the super sink; nodes with negative balance are fed by
    the super source.
    """
    n = num_nodes
    source, sink = n, n + 1
    graph = build_graph(n + 2)
    positions = []
    adjusted = list(balances)
    for k, (u, v, lo, hi) in enumerate(arcs):
        cost = costs[k] if costs is not None else 0
        positions.append(add_arc(graph, u, v, hi - lo, cost))
        adjusted[u] += lo
        adjusted[v] -= lo
    need = 0
    for v in range(n):
        if adjusted[v] > 0:
            add_arc(graph, v, sink, adjusted[v], 0)
            need += adjusted[v]
        elif adjusted[v] < 0:
            add_arc(graph, source, v, -adjusted[v], 0)
    return graph, positions, source, sink, need


def _recover(num_nodes, arcs, graph, positions):
    flows = []
    for (u, v, lo, hi), (arc_node, arc_index) in zip(arcs, positions):
        residual = graph[arc_node][arc_index][2]
        flows.append(lo + (hi - lo) - residual)
    return flows


def feasible_flow(num_nodes, arcs, balances):
    """Find any feasible flow.

    ``arcs``: list of ``(tail, head, lower, upper)``; ``balances[v]`` is the
    required inflow - outflow.  Returns ``(flows, reachable)`` where ``flows``
    aligns with ``arcs`` (or is ``None`` when infeasible) and ``reachable``
    is the set of original node indices reachable from the super source in
    the final residual graph (the complement is a violated cut).
    """
    arcs = list(arcs)
    graph, positions, source, sink, need = _layer_demands(
        num_nodes, arcs, balances, costs=None
    )
    got = max_flow(graph, source, sink)
    reach = {v for v in reachable_from(graph, source) if v < num_nodes}
    if got != need:
        return None, reach
    return _recover(num_nodes, arcs, graph, positions), reach


def min_cost_flow(num_nodes, arcs, balances):
    """Feasible flow of minimum total cost, or ``None`` if infeasible.

    ``arcs``: list of ``(tail, head, lower, upper, cost)``.  Uses max flow
    for feasibility plus cycle cancelling for optimality, which handles
    negative arc costs without any potential bootstrap.
    """
    arcs = list(arcs)
    costs = [a[4] for a in arcs]
    plain = [(u, v, lo, hi) for (u, v, lo, hi, c) in arcs]
    graph, positions, source, sink, need = _layer_demands(
        num_nodes, plain, balances, costs
    )
    got = max_flow(graph, source, sink)
    reach = {v for v in reachable_from(graph, source) if v < num_nodes}
    if got != need:
        return None, reach
    while True:
        cycle = find_negative_cycle(graph)
        if cycle is None:
            break
        delta = min(graph[u][i][2] for (u, i) in cycle)
        for (u, i) in cycle:
            arc = graph[u][i]
            arc[2] -= delta
            graph[arc[0]][arc[1]][2] += delta
    return _recover(num_nodes, plain, graph, positions), reach

"""Helper to derive node potentials certifying optimality of a flow."""

from __future__ import annotations

from .flowsolver import _add_arc, find_negative_cycle


def compute_potentials(network, flows):
    """Return potentials pi with nonnegative reduced costs on all residual
    arcs of the given feasible flow.  Raises ValueError if the flow is not
    optimal (a negative residual cycle exists)."""
    index = {v: i for i, v in enumerate(network.nodes)}
    graph = [[] for _ in range(len(network.nodes))]
    arcs = []
    for edge in network.edges:
        f = flows[edge.id]
        if f < edge.upper:
            arcs.append(_add_arc(graph, index[edge.tail], index[edge.head],
                                 edge.upper - f, edge.cost))
        if f > edge.lower:
            arcs.append(_add_arc(graph, index[edge.head], index[edge.tail],
                                 f - edge.lower, -edge.cost))
    if find_negative_cycle(graph) is not None:
        raise ValueError("flow is not optimal: negative residual cycle exists")
    n = len(network.nodes)
    dist = [0] * n
    for _ in range(n - 1):
        updated = False
        for arc in arcs:
            if dist[arc.u] + arc.cost < dist[arc.v]:
                dist[arc.v] = dist[arc.u] + arc.cost
                updated = True
        if not updated:
            break
    return {v: dist[index[v]] for v in network.nodes}

"""Independent exhaustive-enumeration checker for small networks.

This module intentionally shares nothing with the repairer beyond the
network model: it enumerates every integral flow within the edge bounds,
filters by conservation, and computes the exact lexicographic optimum of
(changed edges, L1 distance, cost).  Used to cross-check the repairer.
"""

from __future__ import annotations

from itertools import product

from .network import _is_int


def enumerate_optimal_repair(network, base_flow, max_combinations=200000):
    edges = network.edges
    base = {}
    forced_change = set()
    for edge in edges:
        value = base_flow.get(edge.id, 0) if isinstance(base_flow, dict) else 0
        if _is_int(value):
            base[edge.id] = value
        else:
            base[edge.id] = edge.lower
            forced_change.add(edge.id)

    total = 1
    for edge in edges:
        total *= edge.upper - edge.lower + 1
    if total > max_combinations:
        raise ValueError(f"enumeration space too large: {total} combinations")

    best = None
    ranges = [range(e.lower, e.upper + 1) for e in edges]
    for values in product(*ranges):
        balance = {v: 0 for v in network.nodes}
        cost = 0
        for edge, value in zip(edges, values):
            balance[edge.tail] -= value
            balance[edge.head] += value
            cost += edge.cost * value
        if any(balance[v] != network.demands[v] for v in network.nodes):
            continue
        changed = 0
        l1 = 0
        for edge, value in zip(edges, values):
            if edge.id in forced_change:
                changed += 1
                l1 += abs(value - base[edge.id])
            elif value != base[edge.id]:
                changed += 1
                l1 += abs(value - base[edge.id])
        key = (changed, l1, cost)
        if best is None or key < best[0]:
            best = (key, {e.id: v for e, v in zip(edges, values)})

    if best is None:
        return {"status": "infeasible", "flow": None, "changed_edges": None,
                "l1_distance": None, "cost": None}
    (changed, l1, cost), flow = best
    return {"status": "optimal", "flow": flow, "changed_edges": changed,
            "l1_distance": l1, "cost": cost}

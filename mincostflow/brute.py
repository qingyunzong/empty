"""Brute-force enumerator for small networks (used as a test oracle).

Enumerates every integer flow within the edge bounds and reports
feasibility and the minimum cost, independently of the solver.
"""

from __future__ import annotations

from itertools import product

from .model import normalize_edges


def brute_force(nodes, edges, demands):
    """Returns (feasible, min_cost, num_optimal_flows)."""
    nodes = [str(n) for n in nodes]
    edges = normalize_edges(edges)
    demands = {str(k): int(v) for k, v in (demands or {}).items()}
    ranges = [range(e.lo, e.hi + 1) for e in edges]
    best = None
    count = 0
    for combo in product(*ranges):
        balance = {v: -demands.get(v, 0) for v in nodes}
        cost = 0
        for e, f in zip(edges, combo):
            balance[e.tail] -= f
            balance[e.head] += f
            cost += f * e.cost
        if all(x == 0 for x in balance.values()):
            if best is None or cost < best:
                best = cost
                count = 1
            elif cost == best:
                count += 1
    return (best is not None), best, count

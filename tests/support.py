"""Shared helpers for the test-suite."""

import itertools

from mincostflow import MinCostCirculation


def make_solver(demands, edges):
    solver = MinCostCirculation()
    for node, demand in demands.items():
        solver.add_node(node, demand)
    for e in edges:
        solver.add_edge(e["id"], e["tail"], e["head"],
                        e.get("lower", 0), e.get("upper", 0), e.get("cost", 0))
    return solver


def brute_force(demands, edges):
    """Enumerate every integer flow; return (best_cost, best_flow)."""
    ids = [e["id"] for e in edges]
    ranges = [range(e["lower"], e["upper"] + 1) for e in edges]
    best_cost = None
    best_flow = None
    for combo in itertools.product(*ranges):
        bal = {v: -d for v, d in demands.items()}
        for e, f in zip(edges, combo):
            bal[e["head"]] += f
            bal[e["tail"]] -= f
        if any(b != 0 for b in bal.values()):
            continue
        cost = sum(e["cost"] * f for e, f in zip(edges, combo))
        if best_cost is None or cost < best_cost:
            best_cost = cost
            best_flow = dict(zip(ids, combo))
    return best_cost, best_flow


def random_model(rng):
    """Small random model (self loops and parallel edges allowed)."""
    n = rng.randint(2, 4)
    nodes = [f"n{i}" for i in range(n)]
    demands = {}
    total = 0
    for v in nodes[:-1]:
        d = rng.randint(-2, 2)
        demands[v] = d
        total += d
    demands[nodes[-1]] = -total
    edges = []
    for i in range(rng.randint(1, 5)):
        lower = rng.randint(0, 2)
        edges.append({
            "id": f"e{i}",
            "tail": rng.choice(nodes),
            "head": rng.choice(nodes),
            "lower": lower,
            "upper": lower + rng.randint(0, 3),
            "cost": rng.randint(-3, 3),
        })
    return demands, edges

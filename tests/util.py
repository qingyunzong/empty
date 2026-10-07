"""Shared helpers for the cut-tree test suite."""

import random

from ghtree import Graph


def brute_min_cut(n, caps, s, t):
    """Min s-t cut by enumerating every subset (feasible for small n)."""
    others = [v for v in range(n) if v != s and v != t]
    best = None
    for mask in range(1 << len(others)):
        side = {s}
        for i, v in enumerate(others):
            if mask >> i & 1:
                side.add(v)
        cap = 0
        for (u, v), c in caps.items():
            if (u in side) != (v in side):
                cap += c
        if best is None or cap < best:
            best = cap
    return best


def random_graph(rng: random.Random, n, max_cap=8, edge_prob=0.6,
                 allow_parallel=True):
    """Random multigraph as an edge list (may contain parallel edges,
    self-loops and zero-capacity edges)."""
    edges = []
    for u in range(n):
        for v in range(u + 1, n):
            if rng.random() < edge_prob:
                edges.append((u, v, rng.randint(0, max_cap)))
                if allow_parallel and rng.random() < 0.3:
                    edges.append((v, u, rng.randint(0, max_cap)))
            if rng.random() < 0.05:
                edges.append((u, u, rng.randint(0, max_cap)))  # self-loop
    rng.shuffle(edges)
    return Graph(n, edges)


def assert_tree_correct(case, tree):
    """Full audit: internal verifier + brute-force check of every pair."""
    case.assertEqual(tree.verify(), [])
    n = tree.graph.n
    caps = tree.graph.capacities()
    for u in range(n):
        for v in range(u + 1, n):
            case.assertEqual(
                tree.query(u, v), brute_min_cut(n, caps, u, v),
                msg=f"pair ({u}, {v})")

"""Shared helpers for the test-suite."""

import random

from symdfa import SymbolicDFA


def random_dfa(rng: random.Random, sigma: int, n: int) -> SymbolicDFA:
    """Random symbolic DFA; edges are random disjoint interval sets."""
    finals = [s for s in range(n) if rng.random() < 0.35]
    trans = []
    for _q in range(n):
        edges = []
        cur = 0
        while cur < sigma and rng.random() < 0.8:
            hi = min(sigma - 1, cur + rng.randint(0, 2))
            edges.append(([(cur, hi)], rng.randrange(n)))
            cur = hi + 1 + (1 if rng.random() < 0.3 else 0)
        trans.append(edges)
    return SymbolicDFA(sigma, n, 0, finals, trans)

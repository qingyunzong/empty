"""Bounded integer-time enumeration oracle for small instances.

Completely independent of the solver: plain nested enumeration of start
times in [0, horizon] with early partial-assignment pruning.  Used by the
test-suite to cross-check solver verdicts.
"""

from __future__ import annotations


def brute_force(n_tasks, durations, constraints, disjuncts, horizon):
    """constraints: iterable of (u, v, c) meaning x_v - x_u <= c.
    disjuncts: iterable of (i, j).
    Returns ("sat", {task: start}) or ("unsat", None)."""
    n = n_tasks
    starts = [0] * n

    def partial_ok(t):
        # constraints / disjuncts touching only tasks 0..t must hold
        for (u, v, c) in constraints:
            if u <= t and v <= t and starts[v] - starts[u] > c:
                return False
        for (i, j) in disjuncts:
            if i <= t and j <= t:
                if not (starts[i] + durations[i] <= starts[j]
                        or starts[j] + durations[j] <= starts[i]):
                    return False
        return True

    def rec(t):
        if t == n:
            return True
        for s in range(horizon + 1):
            starts[t] = s
            if partial_ok(t) and rec(t + 1):
                return True
        return False

    if rec(0):
        return "sat", {str(t): starts[t] for t in range(n)}
    return "unsat", None


def safe_horizon(durations, constraints):
    """A horizon within which some solution exists whenever the instance is
    feasible: no feasible solution needs a span larger than the sum of all
    positive edge weights (difference bounds plus durations)."""
    total = sum(durations)
    for (_, _, c) in constraints:
        total += abs(c)
    return total

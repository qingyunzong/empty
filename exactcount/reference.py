"""Naive exhaustive reference counter (used by the test-suite)."""

from __future__ import annotations

import itertools


def brute_force_count(problem):
    """Count all solutions of a problem dict by full enumeration."""
    variables = problem["variables"]
    names = sorted(variables)
    constraints = [
        ([str(s) for s in c["scope"]], {tuple(t) for t in c["tuples"]})
        for c in problem.get("constraints", [])
    ]
    count = 0
    for combo in itertools.product(*(list(variables[n]) for n in names)):
        assignment = dict(zip(names, combo))
        if all(
            tuple(assignment[s] for s in scope) in allowed
            for scope, allowed in constraints
        ):
            count += 1
    return count

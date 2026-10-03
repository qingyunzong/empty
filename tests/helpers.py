"""Shared test helpers: brute-force enumeration and random problems."""

import itertools
import random

from schcount import Constraint, Problem


def brute_force(problem):
    """Count all solutions by exhaustive enumeration."""
    vars_ = sorted(problem.domains)
    total = 0
    for vals in itertools.product(*(problem.domains[v] for v in vars_)):
        assign = dict(zip(vars_, vals))
        ok = True
        for c in problem.constraints.values():
            if tuple(assign[v] for v in c.scope) not in c.tuple_set:
                ok = False
                break
        if ok:
            total += 1
    return total


def random_problem(rng, max_vars=7, max_dom=3, max_cons=None):
    """Random problem: at most ``max_vars`` variables, each domain a
    non-empty subset of ``range(max_dom)``, with random table constraints
    whose allowed tuples are a non-empty subset of the domain product."""
    n = rng.randint(2, max_vars)
    vars_ = ["v%d" % i for i in range(n)]
    problem = Problem()
    for v in vars_:
        size = rng.randint(1, max_dom)
        domain = sorted(rng.sample(range(max_dom), size))
        problem.add_variable(v, domain)
    ncons = rng.randint(1, max_cons or n)
    for ci in range(ncons):
        k = rng.randint(1, min(3, n))
        scope = tuple(rng.sample(vars_, k))
        all_tuples = list(itertools.product(*(problem.domains[v] for v in scope)))
        rng.shuffle(all_tuples)
        take = rng.randint(1, max(1, len(all_tuples) // 2))
        problem.add_constraint(Constraint("c%d" % ci, scope, all_tuples[:take]))
    return problem

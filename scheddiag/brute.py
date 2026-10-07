"""Bounded integer-time enumeration, used to cross-check the solver.

For small instances this enumerates every integer assignment of task
start times in a window and checks all constraints directly.  The window
is sound: if the difference system (under any disjunct decision pattern)
is feasible, Bellman-Ford potentials give a solution with the zero
variable at 0 and every value within num_tasks * W of it, where W bounds
all constraint weights and durations.
"""

from __future__ import annotations

import itertools


def time_bound(inst):
    w_max = 1
    for (_u, _v, w) in inst.constraints:
        w_max = max(w_max, abs(w))
    for d in inst.durations:
        w_max = max(w_max, d)
    return inst.num_tasks * w_max


def brute_force(inst, bound=None):
    """Return ("sat", witness) or ("unsat", None)."""
    t_max = bound if bound is not None else time_bound(inst)
    n = inst.num_tasks
    for combo in itertools.product(range(-t_max, t_max + 1), repeat=n):
        times = list(combo) + [0]
        ok = True
        for (u, v, w) in inst.constraints:
            if times[v] - times[u] > w:
                ok = False
                break
        if ok:
            for (a, b) in inst.disjuncts:
                if not (times[a] + inst.durations[a] <= times[b]
                        or times[b] + inst.durations[b] <= times[a]):
                    ok = False
                    break
        if ok:
            return "sat", list(combo)
    return "unsat", None

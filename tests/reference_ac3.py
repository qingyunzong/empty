"""Naive AC-3 reference implementation with a full execution log.

This implementation is intentionally independent from ``csp_budget.solver``
and carries no notion of budget.  Every value-match check, domain pruning,
queue pop and queue push is recorded in the returned log so tests can
compare the budgeted implementation against an exact execution trace.
"""

from collections import deque


def run_ac3(variables, constraints):
    """Run plain AC-3 and return ``(status, domains, log)``.

    Log entries are tuples:
      ("enqueue", xi, xj)           arc pushed onto the queue
      ("dequeue", xi, xj)           arc popped from the queue
      ("check", xi, xj, v, w, hit)  single value-match check
      ("remove", xi, v)             value pruned from a domain
      ("empty", xi)                 domain wiped out
    """
    domains = {name: list(domain) for name, domain in variables.items()}
    log = []

    arc_map = {}
    arcs = []
    neighbors = {name: [] for name in variables}
    for constraint in constraints:
        var1 = constraint["var1"]
        var2 = constraint["var2"]
        forward = {(pair[0], pair[1]) for pair in constraint["allowed"]}
        arc_map[(var1, var2)] = forward
        arc_map[(var2, var1)] = {(w, v) for (v, w) in forward}
        arcs.append((var1, var2))
        arcs.append((var2, var1))
        neighbors[var1].append(var2)
        neighbors[var2].append(var1)

    queue = deque()
    for arc in arcs:
        queue.append(arc)
        log.append(("enqueue", arc[0], arc[1]))

    while queue:
        xi, xj = queue.popleft()
        log.append(("dequeue", xi, xj))
        allowed = arc_map[(xi, xj)]
        revised = False
        for value in list(domains[xi]):
            supported = False
            for other in domains[xj]:
                hit = (value, other) in allowed
                log.append(("check", xi, xj, value, other, hit))
                if hit:
                    supported = True
                    break
            if not supported:
                domains[xi].remove(value)
                log.append(("remove", xi, value))
                revised = True
        if not domains[xi]:
            log.append(("empty", xi))
            return "unsat", domains, log
        if revised:
            for xk in neighbors[xi]:
                if xk != xj:
                    queue.append((xk, xi))
                    log.append(("enqueue", xk, xi))

    return "complete", domains, log


def count_checks(log):
    """Number of value-match checks recorded in an execution log."""
    return sum(1 for entry in log if entry[0] == "check")


def truncate_at_check(variables, constraints, check_limit):
    """Replay the reference run, stopping right before check ``check_limit + 1``.

    Returns ``(domains, log_prefix)`` where ``log_prefix`` holds exactly the
    first ``check_limit`` check events (plus the surrounding queue/prune
    events) and ``domains`` is the manually truncated state.
    """
    domains = {name: list(domain) for name, domain in variables.items()}
    log_prefix = []

    arc_map = {}
    arcs = []
    neighbors = {name: [] for name in variables}
    for constraint in constraints:
        var1 = constraint["var1"]
        var2 = constraint["var2"]
        forward = {(pair[0], pair[1]) for pair in constraint["allowed"]}
        arc_map[(var1, var2)] = forward
        arc_map[(var2, var1)] = {(w, v) for (v, w) in forward}
        arcs.append((var1, var2))
        arcs.append((var2, var1))
        neighbors[var1].append(var2)
        neighbors[var2].append(var1)

    queue = deque()
    for arc in arcs:
        queue.append(arc)
        log_prefix.append(("enqueue", arc[0], arc[1]))

    checks_done = 0
    while queue:
        xi, xj = queue.popleft()
        log_prefix.append(("dequeue", xi, xj))
        allowed = arc_map[(xi, xj)]
        revised = False
        stop = False
        for value in list(domains[xi]):
            supported = False
            for other in domains[xj]:
                if checks_done >= check_limit:
                    stop = True
                    break
                hit = (value, other) in allowed
                log_prefix.append(("check", xi, xj, value, other, hit))
                checks_done += 1
                if hit:
                    supported = True
                    break
            if stop:
                break
            if not supported:
                domains[xi].remove(value)
                log_prefix.append(("remove", xi, value))
                revised = True
        if stop:
            break
        if not domains[xi]:
            log_prefix.append(("empty", xi))
            return domains, log_prefix
        if revised:
            for xk in neighbors[xi]:
                if xk != xj:
                    queue.append((xk, xi))
                    log_prefix.append(("enqueue", xk, xi))

    return domains, log_prefix

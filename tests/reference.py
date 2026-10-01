"""Naive reference implementations used to cross-check the library.

These implementations pre-generate all allowed value pairs and recompute
supports by brute-force pair enumeration.  They are intentionally simple
and independent from csp_arith.solver.
"""

from collections import deque

INVERSE_OP = {"lt": "gt", "le": "ge", "gt": "lt", "ge": "le", "eq": "eq", "ne": "ne"}


def check(op, a, b):
    if op == "lt":
        return a < b
    if op == "le":
        return a <= b
    if op == "eq":
        return a == b
    if op == "ne":
        return a != b
    if op == "gt":
        return a > b
    if op == "ge":
        return a >= b
    raise ValueError(op)


def allowed_tuples(op, domain_a, domain_b):
    """Pre-generate every allowed value pair for a constraint."""
    return {(a, b) for a in domain_a for b in domain_b if check(op, a, b)}


def ac3_with_tuples(variables, constraints):
    """Classic AC-3 over pre-generated allowed tuples.

    constraints: list of (cid, op, a, b).  Returns {var: sorted list}.
    """
    domains = {name: set(d) for name, d in variables.items()}
    allowed = {}
    for cid, op, a, b in constraints:
        allowed[(cid, True)] = allowed_tuples(op, domains[a], domains[b])
        allowed[(cid, False)] = {(w, v) for v, w in allowed[(cid, True)]}

    queue = deque()
    for cid, _op, a, b in constraints:
        queue.append((cid, a, b, True))
        queue.append((cid, b, a, False))

    while queue:
        cid, x, y, forward = queue.popleft()
        pairs = allowed[(cid, forward)]
        removed = {
            v for v in domains[x] if not any((v, w) in pairs for w in domains[y])
        }
        if not removed:
            continue
        domains[x] -= removed
        if not domains[x]:
            continue
        for cid2, _op2, a2, b2 in constraints:
            # re-enqueue every arc whose 'other' side is x, except the
            # exact arc just processed (self-constraints must re-enqueue
            # their reverse arc to reach the true fixpoint)
            if b2 == x and (cid2, a2, b2, True) != (cid, x, y, forward):
                queue.append((cid2, a2, b2, True))
            if a2 == x and (cid2, b2, a2, False) != (cid, x, y, forward):
                queue.append((cid2, b2, a2, False))

    return {name: sorted(d) for name, d in domains.items()}


def naive_traced_propagate(variables, constraints):
    """Naive propagation that enumerates every dependency chain.

    Supports are recomputed by brute-force pair enumeration over the
    current domains at every revision, and every revision that removes
    values is traced with its direct premises.  Uses the same queue
    discipline as the library so traces are comparable.

    Returns (domains, trace); trace entries are dicts of the form
    {"var": name, "removed": [explanation-like dict, ...]}.
    """
    domains = {name: sorted(set(d)) for name, d in variables.items()}
    trace = []

    def premise_for(op, other_var):
        other = domains[other_var]
        if op in ("lt", "le"):
            return {"var": other_var, "max": max(other)}
        if op in ("gt", "ge"):
            return {"var": other_var, "min": min(other)}
        if op == "eq":
            return {"var": other_var, "values": list(other)}
        if op == "ne":
            return {"var": other_var, "value": other[0]}
        raise ValueError(op)

    def arcs_into(var):
        arcs = []
        for cid, op, a, b in constraints:
            if b == var:
                arcs.append((cid, op, a, b))
            if a == var and not (a == var and b == var):
                arcs.append((cid, INVERSE_OP[op], b, a))
        return arcs

    def revise(cid, op, x, y):
        removed = []
        for v in domains[x]:
            # brute-force enumeration of all candidate pairs
            if not any(check(op, v, w) for w in domains[y]):
                removed.append(
                    {
                        "var": x,
                        "value": v,
                        "constraint": op,
                        "constraint_id": cid,
                        "other_var": y,
                        "premise": premise_for(op, y),
                    }
                )
        if removed:
            doomed = {e["value"] for e in removed}
            domains[x] = [v for v in domains[x] if v not in doomed]
            trace.append({"var": x, "removed": removed})
        return removed

    queue = deque()
    in_queue = set()
    for cid, op, a, b in constraints:
        for arc in ((cid, op, a, b), (cid, INVERSE_OP[op], b, a)):
            if arc not in in_queue:
                queue.append(arc)
                in_queue.add(arc)

    while queue:
        cid, op, x, y = queue.popleft()
        in_queue.discard((cid, op, x, y))
        removed = revise(cid, op, x, y)
        if not removed:
            continue
        if not domains[x]:
            return domains, trace
        for arc in arcs_into(x):
            if arc == (cid, INVERSE_OP[op], y, x):
                continue
            if arc not in in_queue:
                queue.append(arc)
                in_queue.add(arc)
    return domains, trace

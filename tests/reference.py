"""Naive reference implementations used to cross-check the library.

These implementations PREGENERATE all allowed value pairs per
constraint (the approach the library under test is forbidden to use)
and run a textbook AC-3 on top of the tuple tables.
"""

import itertools
from collections import deque

RELATIONS = {
    "lt": lambda a, b: a < b,
    "le": lambda a, b: a <= b,
    "eq": lambda a, b: a == b,
    "ne": lambda a, b: a != b,
}


def pregenerate_tuples(ctype, domain_a, domain_b):
    """Materialise every allowed (a, b) pair of a constraint."""
    rel = RELATIONS[ctype]
    return frozenset(
        pair
        for pair in itertools.product(domain_a, domain_b)
        if rel(pair[0], pair[1])
    )


def ac3_reference(domains, constraints):
    """Textbook AC-3 over pregenerated tuple tables.

    Returns (status, domains) where domains maps names to sorted lists.
    """
    dom = {name: set(values) for name, values in domains.items()}
    tables = {}
    queue = deque()
    for cid, (ctype, var_a, var_b) in enumerate(constraints):
        forward = pregenerate_tuples(ctype, sorted(dom[var_a]), sorted(dom[var_b]))
        tables[(cid, True)] = forward
        tables[(cid, False)] = frozenset((b, a) for (a, b) in forward)
        queue.append((var_a, cid, True))
        queue.append((var_b, cid, False))

    while queue:
        target, cid, forward = queue.popleft()
        _, var_a, var_b = constraints[cid]
        other = var_b if forward else var_a
        table = tables[(cid, forward)]
        # Self-constraints (var_a == var_b) relate the domain to itself:
        # revise until stable to reach the true fixpoint.
        removed_any = set()
        while True:
            removed = set()
            for value in dom[target]:
                if not any(first == value and second in dom[other]
                           for (first, second) in table):
                    removed.add(value)
            if not removed:
                break
            dom[target] -= removed
            removed_any |= removed
            if var_a != var_b or not dom[target]:
                break
        if not removed_any:
            continue
        if not dom[target]:
            return "inconsistent", {k: sorted(v) for k, v in dom.items()}
        for cid2, (_, va2, vb2) in enumerate(constraints):
            if va2 == target and vb2 != other:
                queue.append((vb2, cid2, False))
            if vb2 == target and va2 != other:
                queue.append((va2, cid2, True))
    return "consistent", {k: sorted(v) for k, v in dom.items()}


def naive_dependency_chain_explanations(domains, constraints):
    """Naively enumerate all propagation dependency chains.

    Re-runs propagation as a dumb fixed-point scan over every arc,
    recording the direct premise of every removed value.  On a domain
    wipe-out, returns (variable, explanations) collecting the chains of
    every value of the emptied domain.  Returns None if consistent.
    """
    dom = {name: sorted(set(values)) for name, values in domains.items()}
    arcs = []
    for ctype, var_a, var_b in constraints:
        arcs.append((var_a, ctype, var_b, (var_a, var_b), False))
        arcs.append((var_b, ctype, var_a, (var_a, var_b), True))
    pruned = {name: [] for name in dom}
    removed_once = {name: set() for name in dom}

    changed = True
    while changed:
        changed = False
        for target, ctype, other, decl, reversed_arc in arcs:
            other_domain = dom[other]
            kept = []
            for value in dom[target]:
                rel = RELATIONS[ctype]
                if reversed_arc:
                    supported = any(rel(w, value) for w in other_domain)
                else:
                    supported = any(rel(value, w) for w in other_domain)
                if supported:
                    kept.append(value)
                elif value not in removed_once[target]:
                    removed_once[target].add(value)
                    if ctype in ("lt", "le"):
                        premise = (
                            {"min": other_domain[0]}
                            if reversed_arc
                            else {"max": other_domain[-1]}
                        )
                    else:
                        premise = {"domain": list(other_domain)}
                    pruned[target].append(
                        {
                            "variable": target,
                            "value": value,
                            "constraint": ctype,
                            "vars": list(decl),
                            "premise": premise,
                        }
                    )
            if len(kept) != len(dom[target]):
                dom[target] = kept
                changed = True
                if not kept:
                    return target, pruned[target]
    return None

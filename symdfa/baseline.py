"""Independent cross-check implementations.

These exist only to validate the minimizer on small machines: a naive
pairwise-equivalence fixpoint (relation refinement over state pairs) and a
full-rebuild helper.  Neither is used by the minimizer itself.
"""
from __future__ import annotations

from .dfa import reachable


def _compatible(dfa, p, q, equivalent):
    rows_p = dfa.transitions[p]
    rows_q = dfa.transitions[q]
    i = j = 0
    while i < len(rows_p) and j < len(rows_q):
        lo1, hi1, t1 = rows_p[i]
        lo2, hi2, t2 = rows_q[j]
        lo = max(lo1, lo2)
        hi = min(hi1, hi2)
        if lo <= hi and t1 != t2:
            pair = (t1, t2) if t1 < t2 else (t2, t1)
            if pair not in equivalent:
                return False
        if hi1 < hi2:
            i += 1
        elif hi2 < hi1:
            j += 1
        else:
            i += 1
            j += 1
    return True


def pairwise_equivalence_classes(dfa):
    """Equivalence classes via a pairwise fixpoint over reachable states."""
    states = sorted(reachable(dfa))
    equivalent = set()
    for x, p in enumerate(states):
        for q in states[x:]:
            if (p in dfa.finals) == (q in dfa.finals):
                equivalent.add((p, q))
    changed = True
    while changed:
        changed = False
        for pair in sorted(equivalent):
            p, q = pair
            if p != q and not _compatible(dfa, p, q, equivalent):
                equivalent.discard(pair)
                changed = True
    parent = {s: s for s in states}

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    for p, q in equivalent:
        parent[find(p)] = find(q)
    classes = {}
    for state in states:
        classes.setdefault(find(state), []).append(state)
    return sorted(classes.values())


def full_rebuild(dfa):
    """Minimize from scratch; used as ground truth for incremental updates."""
    from .minimize import minimize

    return minimize(dfa)

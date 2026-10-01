"""Constraint solver for hierarchical budget allocation.

Budgets form a forest (each budget has at most one parent).  A hold placed
on a budget consumes capacity of that budget and of every ancestor, so the
feasibility constraints are *laminar*: for every budget ``a`` the sum of
allocations placed in the subtree rooted at ``a`` may not exceed
``quota(a) - used(a)``.

For laminar constraints a greedy fill achieves the maximum total, so
feasibility of a candidate subset is decided by a deterministic greedy
split in budget-id order.

Selection policy (deterministic):
  1. minimise the number of occupied budgets;
  2. break ties by the lexicographic order of the sorted budget-id tuple;
  3. the split inside the chosen subset fills budgets in id order, each
     taking as much as the ancestor constraints allow.
"""
from itertools import combinations


def ancestors_of(budgets, bid):
    """Return [bid, parent, grandparent, ...]."""
    chain = []
    cur = bid
    while cur is not None:
        chain.append(cur)
        cur = budgets[cur].parent
    return chain


def compute_used(budgets, counted_holds):
    """Aggregate per-budget usage from an iterable of hold dicts.

    A hold on budget ``b`` is charged to ``b`` and every ancestor exactly
    once, no matter how many descendant paths reach the ancestor.
    """
    used = {bid: 0 for bid in budgets}
    for holds in counted_holds:
        for bid, amount in holds.items():
            for ancestor in ancestors_of(budgets, bid):
                used[ancestor] += amount
    return used


def _split(budgets, used, subset, amount):
    """Greedy deterministic split.  Returns (holds, remaining)."""
    remaining = amount
    holds = {}
    allocated = {bid: 0 for bid in budgets}
    for bid in sorted(subset):
        effective = None
        for ancestor in ancestors_of(budgets, bid):
            room = (budgets[ancestor].quota - used[ancestor]
                    - allocated[ancestor])
            effective = room if effective is None else min(effective, room)
        take = min(remaining, effective)
        if take > 0:
            holds[bid] = take
            remaining -= take
            for ancestor in ancestors_of(budgets, bid):
                allocated[ancestor] += take
        if remaining == 0:
            break
    return holds, remaining


def greedy_split(budgets, used, subset, amount):
    """Return a hold dict covering ``amount`` or None if infeasible."""
    holds, remaining = _split(budgets, used, subset, amount)
    return holds if remaining == 0 else None


def max_allocatable(budgets, used, candidates):
    """Maximum total amount allocatable over the candidate budgets."""
    if not candidates:
        return 0
    huge = sum(b.quota for b in budgets.values()) + 1
    holds, _ = _split(budgets, used, candidates, huge)
    return sum(holds.values())


def allocate(budgets, used, candidates, amount):
    """Choose the deterministic best allocation or return None.

    Enumerates subsets in (size, lexicographic id) order and returns the
    greedy split of the first feasible subset.
    """
    ids = sorted(set(candidates))
    for size in range(1, len(ids) + 1):
        for subset in combinations(ids, size):
            holds = greedy_split(budgets, used, subset, amount)
            if holds is not None:
                return holds
    return None


def diagnose(budgets, used, candidates, amount):
    """Build a verifiable unsatisfiability certificate.

    The returned constraint subset is the ancestor closure of the
    candidate budgets with exact quota/used/available numbers; the
    ``allocatable`` figure is the maximum total the constraints admit,
    so ``requested > allocatable`` is the machine-checkable witness.
    """
    closure = set()
    for candidate in candidates:
        closure.update(ancestors_of(budgets, candidate))
    constraints = [
        {
            "budget": bid,
            "quota": budgets[bid].quota,
            "used": used[bid],
            "available": max(0, budgets[bid].quota - used[bid]),
        }
        for bid in sorted(closure)
    ]
    allocatable = max_allocatable(budgets, used, candidates)
    return {
        "requested": amount,
        "allocatable": allocatable,
        "deficit": amount - allocatable,
        "constraints": constraints,
    }

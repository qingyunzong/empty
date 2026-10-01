"""Independent reference implementation used by the acceptance tests.

Unlike the engine (which computes the compensation order directly with a
sort key), this module *enumerates* recovery strategies: across tie
classes the order is fixed by reverse completion order, while inside a
tie class (siblings with exactly equal cost and compensation cost) every
permutation is a tied optimal strategy and rule 4 selects the one with
lexicographically ascending action ids.
"""

from __future__ import annotations

import itertools

from .engine import COMMITTED, ROLLED_BACK, BUDGET_EXHAUSTED

_ENUMERATION_LIMIT = 8


def _recovery_order(children):
    if not children:
        return []
    class_pos = {}
    classes = {}
    for index, child in enumerate(children):
        key = (child.cost, child.compensation_cost)
        classes.setdefault(key, []).append(child)
        if key not in class_pos or index > class_pos[key]:
            class_pos[key] = index
    order = []
    for key in sorted(classes, key=lambda k: -class_pos[k]):
        members = classes[key]
        if len(members) <= _ENUMERATION_LIMIT:
            # Enumerate every tied strategy; keep the id-lexicographic one.
            best = min(
                itertools.permutations(members),
                key=lambda perm: tuple(a.id for a in perm),
            )
        else:
            best = tuple(sorted(members, key=lambda a: a.id))
        order.extend(best)
    return order


def reference_run(root, budget):
    """Return (state, compensations, budget_remaining, executed)."""
    compensations = []
    executed = []
    budget_left = budget
    exhausted = False

    def compensate_node(action):
        nonlocal budget_left, exhausted
        if exhausted:
            return
        if budget_left < action.compensation_cost:
            exhausted = True
            return
        budget_left -= action.compensation_cost
        compensations.append(action.id)

    def compensate_subtree(action):
        for child in _recovery_order(action.children):
            if exhausted:
                return
            compensate_subtree(child)
        compensate_node(action)

    def execute(action):
        nonlocal budget_left
        if action.outcome == "unsat":
            return False
        if budget_left < action.cost:
            return False
        budget_left -= action.cost
        if action.outcome == "fail":
            return False
        executed.append(action.id)
        completed = []
        for child in action.children:
            if execute(child):
                completed.append(child)
            else:
                for done in _recovery_order(completed):
                    if exhausted:
                        break
                    compensate_subtree(done)
                compensate_node(action)
                return False
        return True

    ok = execute(root)
    if ok:
        state = COMMITTED
    elif exhausted:
        state = BUDGET_EXHAUSTED
    else:
        state = ROLLED_BACK
    return state, compensations, budget_left, executed

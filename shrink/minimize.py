"""Budget-limited greedy test-case minimizer.

Transform classes (only these are ever attempted):
  1. deletion of a contiguous block of ops (length >= 2),
  2. deletion of a single op,
  3. replacement of one op's args by one of its declared candidates.

Budget semantics: every predicate evaluation ("check") consumes one unit of
budget.  A predicate that raises is treated as "not failing", so the
candidate that triggered the exception is never kept.
"""

import json
from dataclasses import dataclass


class BudgetExhausted(Exception):
    pass


class _Budget:
    def __init__(self, limit):
        self.limit = limit
        self.used = 0

    def evaluate(self, predicate, ops):
        if self.used >= self.limit:
            raise BudgetExhausted
        self.used += 1
        try:
            return bool(predicate(ops))
        except Exception:
            return False


def _sort_key(ops):
    """Tie-break order: length, then op names, then canonical args JSON."""
    return (
        len(ops),
        tuple(op["name"] for op in ops),
        tuple(json.dumps(op["args"], sort_keys=True, separators=(",", ":")) for op in ops),
    )


def _public(ops):
    return [{"name": op["name"], "args": op["args"]} for op in ops]


@dataclass
class Result:
    status: str        # "OK" | "BUDGET_EXCEEDED"
    ops: list
    checks: int
    reason: str
    minimality: str    # "1_MINIMAL" | "UNKNOWN_MINIMALITY"

    def to_dict(self):
        return {
            "status": self.status,
            "ops": self.ops,
            "checks": self.checks,
            "reason": self.reason,
            "minimality": self.minimality,
        }


def _best_deletion(ops, predicate, budget):
    """Best failing contiguous-block deletion (incl. single-op deletion).

    Shortest results are tried first; among failing candidates of the same
    length the lexicographically smallest (names, then args JSON) wins.
    """
    n = len(ops)
    for size in range(n, 0, -1):
        best = None
        for start in range(n - size + 1):
            cand = ops[:start] + ops[start + size:]
            if budget.evaluate(predicate, cand):
                if best is None or _sort_key(cand) < _sort_key(best):
                    best = cand
        if best is not None:
            return best
    return None


def _best_replacement(ops, predicate, budget):
    """Best failing args replacement, or None.

    Only replacements that strictly improve the tie-break order are
    considered, which guarantees the search descends and terminates.
    """
    current_key = _sort_key(ops)
    best = None
    for i, op in enumerate(ops):
        for cand_args in op["candidates"]:
            cand = ops[:i] + [
                {"name": op["name"], "args": cand_args, "candidates": op["candidates"]}
            ] + ops[i + 1:]
            if _sort_key(cand) >= current_key:
                continue
            if budget.evaluate(predicate, cand):
                if best is None or _sort_key(cand) < _sort_key(best):
                    best = cand
    return best


def minimize(ops, predicate, budget):
    """Minimize ``ops`` while ``predicate`` keeps failing.

    Returns a Result.  ``ops`` items must carry name/args/candidates keys
    (see shrink.case.parse_case).
    """
    budget_limit = budget
    budget = _Budget(budget_limit)
    current = list(ops)

    try:
        initial_fails = budget.evaluate(predicate, current)
    except BudgetExhausted:
        return Result("BUDGET_EXCEEDED", _public(current), budget.used,
                      "budget exhausted before the initial predicate check",
                      "UNKNOWN_MINIMALITY")
    if not initial_fails:
        return Result("OK", _public(current), budget.used,
                      "predicate does not fail on the input; nothing to minimize",
                      "UNKNOWN_MINIMALITY")

    while True:
        # Greedy descent to a fixpoint over the three transform classes.
        try:
            while True:
                nxt = _best_deletion(current, predicate, budget)
                if nxt is None:
                    nxt = _best_replacement(current, predicate, budget)
                if nxt is None:
                    break
                current = nxt
        except BudgetExhausted:
            return Result("BUDGET_EXCEEDED", _public(current), budget.used,
                          "budget exhausted during minimization; "
                          "result is the current best and is not proven minimal",
                          "UNKNOWN_MINIMALITY")

        # Explicit 1-minimality verification: no single-op deletion may fail.
        try:
            failing_index = None
            for i in range(len(current)):
                if budget.evaluate(predicate, current[:i] + current[i + 1:]):
                    failing_index = i
                    break
        except BudgetExhausted:
            return Result("OK", _public(current), budget.used,
                          "budget exhausted during 1-minimality verification",
                          "UNKNOWN_MINIMALITY")
        if failing_index is None:
            return Result("OK", _public(current), budget.used,
                          "verified: deleting any single op no longer fails",
                          "1_MINIMAL")
        # Defensive: a single deletion still fails; resume descent from it.
        current = current[:failing_index] + current[failing_index + 1:]

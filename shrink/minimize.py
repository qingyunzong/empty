"""Budget-aware greedy minimizer.

Semantics:

- Only three transformation types are supported: deleting a contiguous
  block, deleting a single op, and replacing an op's args with one of the
  candidates given in ``arg_candidates``.
- Every predicate evaluation of a (candidate) sequence costs 1 check against
  the budget, including the initial check of the original case.  When the
  budget is exhausted the minimizer stops and reports the current best
  without claiming minimality.
- A predicate that raises is treated as "not failing"; such candidates are
  never kept.
- Among failing candidates the ordering key is
  ``(length, [(name, canonical_json(args)), ...])``: shorter is better, ties
  are broken by op name and then by canonical JSON of args.  Ties beyond
  that are resolved stably (first candidate wins, current best is only
  replaced by a strictly smaller key).
"""

import json

from .errors import BudgetExhausted, CaseError
from .predicate import case_fails

STATUS_MINIMAL = "1_MINIMAL"
STATUS_UNKNOWN = "UNKNOWN_MINIMALITY"
STATUS_BUDGET = "BUDGET_EXCEEDED"


def order_key(ops):
    return (
        len(ops),
        [
            (op["name"], json.dumps(op["args"], sort_keys=True))
            for op in ops
        ],
    )


class _Checker:
    """Counts predicate evaluations against the budget."""

    def __init__(self, fail_when, budget):
        self._fail_when = fail_when
        self._budget = budget
        self.used = 0

    def fails(self, ops):
        if self.used >= self._budget:
            raise BudgetExhausted
        self.used += 1
        try:
            return bool(case_fails(ops, self._fail_when))
        except Exception:
            return False


def _result(status, ops, checks, reason):
    return {"status": status, "ops": ops, "checks": checks, "reason": reason}


def _improve_once(best, arg_candidates, checker):
    """Try each transformation type once; return (ops, improved)."""
    n = len(best)
    best_key = order_key(best)

    # 1. Contiguous block deletion, largest blocks first (ddmin-style).
    size = max(2, n // 2)
    while size >= 2:
        winner = None
        for start in range(0, n - size + 1):
            candidate = best[:start] + best[start + size:]
            if checker.fails(candidate) and (
                winner is None or order_key(candidate) < order_key(winner)
            ):
                winner = candidate
        if winner is not None:
            return winner, True
        size //= 2

    # 2. Single-op deletion.
    winner = None
    for index in range(n):
        candidate = best[:index] + best[index + 1:]
        if checker.fails(candidate) and (
            winner is None or order_key(candidate) < order_key(winner)
        ):
            winner = candidate
    if winner is not None:
        return winner, True

    # 3. Argument replacement with the given candidates (same length, so
    #    only strictly smaller keys are improvements).
    winner = None
    for index, op in enumerate(best):
        for candidate_args in arg_candidates.get(op["name"], ()):
            if candidate_args == op["args"]:
                continue
            candidate = (
                best[:index]
                + [{"name": op["name"], "args": candidate_args}]
                + best[index + 1:]
            )
            if not checker.fails(candidate):
                continue
            candidate_key = order_key(candidate)
            if candidate_key < best_key and (
                winner is None or candidate_key < order_key(winner)
            ):
                winner = candidate
    if winner is not None:
        return winner, True

    return best, False


def minimize_case(case, budget):
    """Minimize a validated case. Returns {status, ops, checks, reason}."""
    checker = _Checker(case["fail_when"], budget)
    arg_candidates = case["arg_candidates"]
    best = [dict(op) for op in case["ops"]]

    try:
        initial_fails = checker.fails(best)
    except BudgetExhausted:
        return _result(
            STATUS_BUDGET,
            best,
            checker.used,
            "budget exhausted before the initial check; returning input unchanged",
        )
    if not initial_fails:
        raise CaseError("initial case does not fail; nothing to minimize")

    while True:
        try:
            improved = True
            while improved:
                best, improved = _improve_once(best, arg_candidates, checker)
        except BudgetExhausted:
            return _result(
                STATUS_BUDGET,
                best,
                checker.used,
                "budget exhausted during minimization; returning current best "
                "(minimality not established)",
            )

        # Formal 1-minimality verification: deleting any single op must no
        # longer fail.  Each verification probe costs 1 check.
        restarted = False
        for index in range(len(best)):
            try:
                still_fails = checker.fails(best[:index] + best[index + 1:])
            except BudgetExhausted:
                return _result(
                    STATUS_UNKNOWN,
                    best,
                    checker.used,
                    "budget exhausted during 1-minimality verification",
                )
            if still_fails:
                best = best[:index] + best[index + 1:]
                restarted = True
                break
        if not restarted:
            return _result(
                STATUS_MINIMAL,
                best,
                checker.used,
                "fixpoint reached and every single-op deletion verified "
                "non-failing",
            )

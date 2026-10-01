"""Core AC-3 propagation with an explicit match-check budget.

Budget semantics:
  * Every single value-pair match check costs exactly 1 budget unit and the
    unit is deducted *before* the check is executed.
  * If the remaining budget is 0 when a check is about to run, propagation
    stops immediately, keeping every modification made so far, and the
    result status is ``timeout`` (never ``unsat``/``complete``).
  * If any domain becomes empty, propagation stops immediately with status
    ``unsat`` and the remaining budget is discarded.
  * If a fixpoint is reached with all domains non-empty, the status is
    ``complete`` and the remaining budget is reported.
"""

from __future__ import annotations


class CSPError(ValueError):
    """Raised for malformed problems, bad budgets, or dangling references."""


class BudgetExhausted(Exception):
    """Internal control-flow signal: budget hit zero before a match check."""


def validate_problem(problem):
    """Validate the decoded JSON problem. Returns (variables, constraints).

    variables: dict name -> list[int] (insertion ordered)
    constraints: list of (xi, xj, frozenset-of-(a, b))
    """
    if not isinstance(problem, dict):
        raise CSPError("problem must be a JSON object")

    raw_vars = problem.get("variables")
    if not isinstance(raw_vars, dict) or not raw_vars:
        raise CSPError("'variables' must be a non-empty object")
    variables = {}
    for name, domain in raw_vars.items():
        if not isinstance(name, str):
            raise CSPError("variable names must be strings")
        if (
            not isinstance(domain, list)
            or any(not isinstance(v, int) or isinstance(v, bool) for v in domain)
        ):
            raise CSPError(f"domain of variable {name!r} must be a list of integers")
        variables[name] = list(domain)

    raw_constraints = problem.get("constraints", [])
    if not isinstance(raw_constraints, list):
        raise CSPError("'constraints' must be a list")
    constraints = []
    for index, con in enumerate(raw_constraints):
        if not isinstance(con, dict):
            raise CSPError(f"constraint #{index} must be an object")
        scope = con.get("scope")
        if (
            not isinstance(scope, list)
            or len(scope) != 2
            or any(not isinstance(s, str) for s in scope)
        ):
            raise CSPError(f"constraint #{index} needs a 'scope' of two variable names")
        for var in scope:
            if var not in variables:
                raise CSPError(
                    f"constraint #{index} references unknown variable {var!r}"
                )
        allowed = con.get("allowed")
        if not isinstance(allowed, list):
            raise CSPError(f"constraint #{index} needs an 'allowed' list of pairs")
        pairs = set()
        for pair in allowed:
            if (
                not isinstance(pair, list)
                or len(pair) != 2
                or any(not isinstance(v, int) or isinstance(v, bool) for v in pair)
            ):
                raise CSPError(
                    f"constraint #{index} has a malformed allowed pair: {pair!r}"
                )
            pairs.add((pair[0], pair[1]))
        constraints.append((scope[0], scope[1], frozenset(pairs)))

    return variables, constraints


def _run_ac3(variables, constraints, budget, log):
    """Shared engine. budget=None means unlimited (reference implementation).

    Returns (status, domains, used_budget, log).
    """
    domains = {name: list(domain) for name, domain in variables.items()}

    # Empty initial domain -> unsat regardless of budget.
    if any(len(domain) == 0 for domain in domains.values()):
        return "unsat", domains, 0, log

    remaining = budget  # None means unlimited
    used = 0

    def spend_one():
        nonlocal remaining, used
        if remaining is not None:
            if remaining == 0:
                raise BudgetExhausted
            remaining -= 1
        used += 1

    # Correctly oriented allowed-pair sets per directed arc, plus neighbor
    # lists in constraint declaration order for deterministic re-queueing.
    arc_allowed = {}
    neighbors = {}
    for xi, xj, allowed in constraints:
        arc_allowed[xi, xj] = allowed
        arc_allowed[xj, xi] = frozenset((b, a) for a, b in allowed)
        neighbors.setdefault(xi, []).append(xj)
        neighbors.setdefault(xj, []).append(xi)

    queue = []
    for xi, xj, _allowed in constraints:
        queue.append((xi, xj))
        queue.append((xj, xi))

    try:
        head = 0
        while head < len(queue):
            xi, xj = queue[head]
            head += 1
            allowed = arc_allowed[xi, xj]
            revised = False
            kept = []
            for a in domains[xi]:
                supported = False
                for b in domains[xj]:
                    spend_one()
                    log.append(("check", xi, a, xj, b))
                    if (a, b) in allowed:
                        supported = True
                        break
                if supported:
                    kept.append(a)
                else:
                    log.append(("remove", xi, a))
                    revised = True
            if revised:
                domains[xi] = kept
                if not kept:
                    return "unsat", domains, used, log
                for xk in neighbors.get(xi, []):
                    if xk != xj:
                        queue.append((xk, xi))
    except BudgetExhausted:
        return "timeout", domains, used, log

    return "complete", domains, used, log


def propagate(problem, budget):
    """Run budget-limited AC-3.

    Returns dict with status/domains/used_budget/remaining_budget.
    """
    if isinstance(budget, bool) or not isinstance(budget, int):
        raise CSPError("budget must be an integer")
    if budget < 0:
        raise CSPError("budget must be non-negative")
    variables, constraints = validate_problem(problem)
    status, domains, used, _log = _run_ac3(variables, constraints, budget, [])
    return {
        "status": status,
        "domains": domains,
        "used_budget": used,
        "remaining_budget": budget - used,
    }


def reference_ac3(problem, max_checks=None):
    """Naive AC-3 with a full execution log and no real budget.

    ``max_checks`` optionally truncates execution right before the match
    check that would exceed the limit (used by tests to emulate a budget
    cut-off). Returns a dict with status, domains, used_budget (number of
    executed match checks) and the full execution log.
    """
    variables, constraints = validate_problem(problem)
    log = []
    status, domains, used, log = _run_ac3(variables, constraints, max_checks, log)
    return {
        "status": status,
        "domains": domains,
        "used_budget": used,
        "log": log,
    }

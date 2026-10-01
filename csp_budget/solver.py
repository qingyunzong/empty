"""Budget-limited AC-3 propagation.

Budget semantics:
- One unit of budget is charged per single value-match check, i.e. per
  evaluation of "is (v, w) an allowed pair" for one value v of the
  revised variable and one value w of the neighbor.
- The budget is consulted before every check; when it is exhausted the
  propagation stops immediately, keeping every modification completed
  so far, and the run is reported as ``timeout`` (undecided).
- If any domain becomes empty the run stops immediately as ``unsat``
  and the remaining budget is discarded.
- If a fixpoint is reached with all domains non-empty the run is
  ``complete`` and the unused budget is returned.
"""

from collections import deque

COMPLETE = "complete"
UNSAT = "unsat"
TIMEOUT = "timeout"


class InputError(ValueError):
    """Raised when a CSP problem description is malformed."""


def _is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def validate_problem(data):
    """Validate the decoded JSON problem description.

    Expected shape::

        {
          "variables": {"x": [1, 2], ...},
          "constraints": [
            {"var1": "x", "var2": "y", "allowed": [[1, 2], ...]},
            ...
          ]
        }

    Returns the validated ``(variables, constraints)`` pair.
    Raises :class:`InputError` on any malformed input.
    """
    if not isinstance(data, dict):
        raise InputError("problem must be a JSON object")
    variables = data.get("variables")
    constraints = data.get("constraints")
    if not isinstance(variables, dict) or not variables:
        raise InputError("'variables' must be a non-empty object")
    for name, domain in variables.items():
        if not isinstance(name, str):
            raise InputError("variable names must be strings")
        if not isinstance(domain, list) or any(not _is_int(v) for v in domain):
            raise InputError("domain of variable %r must be a list of integers" % name)
    if not isinstance(constraints, list):
        raise InputError("'constraints' must be a list")
    for index, constraint in enumerate(constraints):
        if not isinstance(constraint, dict):
            raise InputError("constraint %d must be an object" % index)
        var1 = constraint.get("var1")
        var2 = constraint.get("var2")
        if var1 not in variables or var2 not in variables:
            raise InputError(
                "constraint %d references unknown variable(s): %r, %r"
                % (index, var1, var2)
            )
        allowed = constraint.get("allowed")
        if not isinstance(allowed, list) or any(
            not (
                isinstance(pair, list)
                and len(pair) == 2
                and _is_int(pair[0])
                and _is_int(pair[1])
            )
            for pair in allowed
        ):
            raise InputError(
                "constraint %d 'allowed' must be a list of [int, int] pairs" % index
            )
    return variables, constraints


def _build_arcs(variables, constraints):
    arc_map = {}
    arcs = []
    neighbors = {name: [] for name in variables}
    for constraint in constraints:
        var1 = constraint["var1"]
        var2 = constraint["var2"]
        forward = {(pair[0], pair[1]) for pair in constraint["allowed"]}
        backward = {(w, v) for (v, w) in forward}
        arc_map[(var1, var2)] = forward
        arc_map[(var2, var1)] = backward
        arcs.append((var1, var2))
        arcs.append((var2, var1))
        neighbors[var1].append(var2)
        neighbors[var2].append(var1)
    return arcs, arc_map, neighbors


def propagate(variables, constraints, budget):
    """Run budget-limited AC-3.

    ``variables`` maps names to enumerated integer domains, ``constraints``
    is a list of ``{"var1", "var2", "allowed"}`` dicts, and ``budget`` is a
    non-negative integer counting value-match checks.

    Returns ``{"status": ..., "domains": ..., "used_budget": ...}``.
    """
    if not _is_int(budget) or budget < 0:
        raise InputError("budget must be a non-negative integer")

    domains = {name: list(domain) for name, domain in variables.items()}

    for name in domains:
        if not domains[name]:
            return {"status": UNSAT, "domains": domains, "used_budget": 0}

    arcs, arc_map, neighbors = _build_arcs(variables, constraints)
    queue = deque(arcs)
    used = 0
    exhausted = False

    while queue and not exhausted:
        xi, xj = queue.popleft()
        allowed = arc_map[(xi, xj)]
        revised = False
        for value in list(domains[xi]):
            supported = False
            for other in domains[xj]:
                if used >= budget:
                    exhausted = True
                    break
                used += 1
                if (value, other) in allowed:
                    supported = True
                    break
            if exhausted:
                break
            if not supported:
                domains[xi].remove(value)
                revised = True
        if exhausted:
            break
        if not domains[xi]:
            return {"status": UNSAT, "domains": domains, "used_budget": used}
        if revised:
            for xk in neighbors[xi]:
                if xk != xj:
                    queue.append((xk, xi))

    status = TIMEOUT if exhausted else COMPLETE
    return {"status": status, "domains": domains, "used_budget": used}

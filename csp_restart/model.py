"""CSP problem model: JSON parsing, validation, and constraints."""

OPS = {
    "==": lambda a, b: a == b,
    "!=": lambda a, b: a != b,
    "<=": lambda a, b: a <= b,
    ">=": lambda a, b: a >= b,
    "<": lambda a, b: a < b,
    ">": lambda a, b: a > b,
}

CONSTRAINT_TYPES = ("eq", "neq", "all_different", "table", "linear")


def _is_scalar(value):
    return value is None or isinstance(value, (str, int, float, bool))


def _is_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool)


class ProblemError(ValueError):
    """Raised when a CSP problem description is invalid."""


class Problem:
    def __init__(self, variables, domains, constraints):
        self.variables = variables
        self.domains = domains
        self.constraints = constraints


class Constraint:
    """A constraint over a fixed scope of variables.

    ``propagate`` performs forward-checking style pruning: it only revises
    domains when at most one variable of the scope is unassigned (except
    ``all_different``, which removes assigned values from every unassigned
    variable). It returns ``(ok, pruned)`` where ``ok`` is False when a
    domain wipeout (conflict) occurred.
    """

    def __init__(self, kind, variables, data=None):
        self.kind = kind
        self.variables = list(variables)
        self.data = data or {}

    def is_violated(self, assignment):
        values = [assignment[v] for v in self.variables]
        if self.kind == "eq":
            return values[0] != values[1]
        if self.kind == "neq":
            return values[0] == values[1]
        if self.kind == "all_different":
            return len(set(values)) != len(values)
        if self.kind == "table":
            return values not in self.data["allowed"]
        if self.kind == "linear":
            total = sum(c * v for c, v in zip(self.data["coeffs"], values))
            return not OPS[self.data["op"]](total, self.data["value"])
        raise ProblemError(f"unknown constraint type: {self.kind!r}")

    def propagate(self, assignment, domains):
        unassigned = [v for v in self.variables if v not in assignment]
        if not unassigned:
            return (not self.is_violated(assignment)), 0
        if self.kind == "all_different":
            return self._propagate_all_different(assignment, domains, unassigned)
        if len(unassigned) > 1:
            return True, 0
        var = unassigned[0]
        domain = domains[var]
        kept = [x for x in domain if self._satisfiable(var, x, assignment)]
        pruned = len(domain) - len(kept)
        if pruned:
            domains[var] = kept
            if not kept:
                return False, pruned
        return True, pruned

    def _propagate_all_different(self, assignment, domains, unassigned):
        assigned_values = [assignment[v] for v in self.variables if v in assignment]
        if len(set(assigned_values)) != len(assigned_values):
            return False, 0
        pruned = 0
        for var in unassigned:
            domain = domains[var]
            kept = [x for x in domain if x not in assigned_values]
            if len(kept) != len(domain):
                pruned += len(domain) - len(kept)
                domains[var] = kept
                if not kept:
                    return False, pruned
        return True, pruned

    def _satisfiable(self, var, value, assignment):
        values = {
            v: (value if v == var else assignment[v]) for v in self.variables
        }
        if self.kind == "eq":
            return values[self.variables[0]] == values[self.variables[1]]
        if self.kind == "neq":
            return values[self.variables[0]] != values[self.variables[1]]
        if self.kind == "table":
            row = [values[v] for v in self.variables]
            return row in self.data["allowed"]
        if self.kind == "linear":
            total = sum(c * values[v] for c, v in zip(self.data["coeffs"], self.variables))
            return OPS[self.data["op"]](total, self.data["value"])
        raise ProblemError(f"unknown constraint type: {self.kind!r}")


def load_problem(data):
    """Parse and validate a JSON-decoded CSP problem description."""
    if not isinstance(data, dict):
        raise ProblemError("problem must be a JSON object")
    variables = data.get("variables")
    if not isinstance(variables, list) or not variables:
        raise ProblemError("'variables' must be a non-empty list")
    names = []
    domains = {}
    for entry in variables:
        if not isinstance(entry, dict):
            raise ProblemError("each variable must be an object")
        name = entry.get("name")
        domain = entry.get("domain")
        if not isinstance(name, str) or not name:
            raise ProblemError("each variable needs a non-empty string 'name'")
        if name in domains:
            raise ProblemError(f"duplicate variable name: {name!r}")
        if not isinstance(domain, list):
            raise ProblemError(f"variable {name!r} needs a list 'domain'")
        for value in domain:
            if not _is_scalar(value):
                raise ProblemError(
                    f"domain of {name!r} must contain only JSON scalars"
                )
        names.append(name)
        domains[name] = list(domain)
    raw_constraints = data.get("constraints", [])
    if not isinstance(raw_constraints, list):
        raise ProblemError("'constraints' must be a list")
    constraints = [
        _parse_constraint(spec, domains) for spec in raw_constraints
    ]
    return Problem(names, domains, constraints)


def _parse_constraint(spec, known_domains):
    if not isinstance(spec, dict):
        raise ProblemError("each constraint must be an object")
    kind = spec.get("type")
    if kind not in CONSTRAINT_TYPES:
        raise ProblemError(f"unknown constraint type: {kind!r}")
    variables = spec.get("vars")
    if not isinstance(variables, list) or not variables:
        raise ProblemError(f"{kind} constraint needs a non-empty 'vars' list")
    for name in variables:
        if name not in known_domains:
            raise ProblemError(f"constraint references unknown variable: {name!r}")
    data = {}
    if kind in ("eq", "neq"):
        if len(variables) != 2:
            raise ProblemError(f"{kind} constraint needs exactly 2 variables")
    elif kind == "table":
        allowed = spec.get("allowed")
        if not isinstance(allowed, list):
            raise ProblemError("table constraint needs an 'allowed' list")
        rows = []
        for row in allowed:
            if not isinstance(row, list) or len(row) != len(variables):
                raise ProblemError("each table row must match the 'vars' length")
            for value in row:
                if not _is_scalar(value):
                    raise ProblemError("table rows must contain only JSON scalars")
            rows.append(list(row))
        data["allowed"] = rows
    elif kind == "linear":
        coeffs = spec.get("coeffs")
        if (
            not isinstance(coeffs, list)
            or len(coeffs) != len(variables)
            or not all(_is_number(c) for c in coeffs)
        ):
            raise ProblemError(
                "linear constraint 'coeffs' must be numbers matching 'vars'"
            )
        op = spec.get("op")
        if op not in OPS:
            raise ProblemError(f"unknown linear operator: {op!r}")
        value = spec.get("value")
        if not _is_number(value):
            raise ProblemError("linear constraint 'value' must be a number")
        data.update(coeffs=list(coeffs), op=op, value=value)
    return Constraint(kind, variables, data)

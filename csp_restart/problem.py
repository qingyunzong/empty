"""CSP problem model, JSON loading and validation."""

import json


class ProblemError(ValueError):
    """Raised when a CSP problem definition is invalid."""


_SCALAR_TYPES = (str, int, float, bool, type(None))
_CONSTRAINT_TYPES = ("eq", "neq", "all_different", "table")


class Constraint:
    """A constraint over an ordered list of variable names."""

    def __init__(self, ctype, variables, allowed=None):
        self.type = ctype
        self.variables = list(variables)
        self.allowed = [tuple(t) for t in allowed] if allowed is not None else None

    def is_consistent(self, assignment):
        """Check the constraint against a possibly partial assignment.

        Returns True when the assigned variables do not violate the
        constraint, i.e. the partial assignment can still be extended to
        a satisfying tuple.
        """
        if self.type == "eq":
            values = [assignment[v] for v in self.variables if v in assignment]
            return len(set(values)) <= 1
        if self.type in ("neq", "all_different"):
            values = [assignment[v] for v in self.variables if v in assignment]
            return len(set(values)) == len(values)
        if self.type == "table":
            assigned = {v: assignment[v] for v in self.variables if v in assignment}
            for tup in self.allowed:
                if all(
                    tup[i] == assigned[v]
                    for i, v in enumerate(self.variables)
                    if v in assigned
                ):
                    return True
            return False
        raise ProblemError(f"unknown constraint type: {self.type}")


class Problem:
    """A finite-domain CSP: ordered variables, domains and constraints."""

    def __init__(self, variables, domains, constraints):
        self.variables = list(variables)
        self.domains = {v: list(domains[v]) for v in self.variables}
        self.constraints = list(constraints)


def _check_scalar(value, where):
    if not isinstance(value, _SCALAR_TYPES):
        raise ProblemError(f"{where}: domain values must be JSON scalars, got {value!r}")


def problem_from_dict(data):
    """Validate a decoded JSON object and build a Problem."""
    if not isinstance(data, dict):
        raise ProblemError("problem must be a JSON object")
    for key in ("variables", "constraints"):
        if key not in data:
            raise ProblemError(f"missing required key: {key!r}")

    raw_variables = data["variables"]
    if not isinstance(raw_variables, list) or not raw_variables:
        raise ProblemError("'variables' must be a non-empty list")

    variables = []
    domains = {}
    for entry in raw_variables:
        if not isinstance(entry, dict) or "name" not in entry or "domain" not in entry:
            raise ProblemError("each variable must be an object with 'name' and 'domain'")
        name = entry["name"]
        domain = entry["domain"]
        if not isinstance(name, str) or not name:
            raise ProblemError(f"variable name must be a non-empty string, got {name!r}")
        if name in domains:
            raise ProblemError(f"duplicate variable name: {name!r}")
        if not isinstance(domain, list) or not domain:
            raise ProblemError(f"variable {name!r}: domain must be a non-empty list")
        for value in domain:
            _check_scalar(value, f"variable {name!r}")
        variables.append(name)
        domains[name] = domain

    raw_constraints = data["constraints"]
    if not isinstance(raw_constraints, list):
        raise ProblemError("'constraints' must be a list")

    constraints = []
    for index, entry in enumerate(raw_constraints):
        where = f"constraint #{index}"
        if not isinstance(entry, dict):
            raise ProblemError(f"{where}: must be an object")
        ctype = entry.get("type")
        if ctype not in _CONSTRAINT_TYPES:
            raise ProblemError(f"{where}: unknown constraint type: {ctype!r}")
        cvars = entry.get("vars")
        if not isinstance(cvars, list) or not cvars:
            raise ProblemError(f"{where}: 'vars' must be a non-empty list")
        for v in cvars:
            if v not in domains:
                raise ProblemError(f"{where}: unknown variable: {v!r}")
        if ctype in ("eq", "neq") and len(cvars) != 2:
            raise ProblemError(f"{where}: {ctype!r} requires exactly 2 variables")
        if ctype == "all_different" and len(cvars) < 2:
            raise ProblemError(f"{where}: 'all_different' requires at least 2 variables")
        allowed = None
        if ctype == "table":
            allowed = entry.get("allowed")
            if not isinstance(allowed, list):
                raise ProblemError(f"{where}: 'table' requires an 'allowed' list of tuples")
            for tup in allowed:
                if not isinstance(tup, list) or len(tup) != len(cvars):
                    raise ProblemError(
                        f"{where}: each allowed tuple must be a list of length {len(cvars)}"
                    )
                for value in tup:
                    _check_scalar(value, where)
        constraints.append(Constraint(ctype, cvars, allowed))

    return Problem(variables, domains, constraints)


def load_problem(path):
    """Load and validate a CSP problem from a JSON file."""
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    return problem_from_dict(data)

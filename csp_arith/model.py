"""Input parsing and validation for CSP problem files (JSON).

Expected input format::

    {
        "variables": {"x": [1, 2, 3], "y": [2, 3]},
        "constraints": [
            {"type": "lt", "vars": ["x", "y"]},
            {"type": "ne", "vars": ["x", "y"]}
        ]
    }

Validation errors raise :class:`ProblemError`; the CLI maps them to a
non-zero exit code.
"""

import json

from .core import CONSTRAINT_TYPES, ProblemError


def _is_int(value):
    # bool is a subclass of int but is not accepted as a domain value.
    return isinstance(value, int) and not isinstance(value, bool)


def validate_problem(data):
    """Validate a decoded JSON problem. Returns (domains, constraints)."""
    if not isinstance(data, dict):
        raise ProblemError("problem must be a JSON object")

    variables = data.get("variables")
    if not isinstance(variables, dict) or not variables:
        raise ProblemError("'variables' must be a non-empty object")

    domains = {}
    for name, domain in variables.items():
        if not isinstance(name, str) or not name:
            raise ProblemError("variable names must be non-empty strings")
        if not isinstance(domain, list) or not domain:
            raise ProblemError(
                "domain of variable %r must be a non-empty list of integers" % name
            )
        for value in domain:
            if not _is_int(value):
                raise ProblemError(
                    "domain of variable %r contains non-integer value: %r"
                    % (name, value)
                )
        domains[name] = list(domain)

    raw_constraints = data.get("constraints", [])
    if not isinstance(raw_constraints, list):
        raise ProblemError("'constraints' must be a list")

    constraints = []
    for index, raw in enumerate(raw_constraints):
        if not isinstance(raw, dict):
            raise ProblemError("constraint #%d must be an object" % index)
        ctype = raw.get("type")
        if ctype not in CONSTRAINT_TYPES:
            raise ProblemError(
                "unknown constraint type: %r (expected one of %s)"
                % (ctype, ", ".join(CONSTRAINT_TYPES))
            )
        var_names = raw.get("vars")
        if (
            not isinstance(var_names, list)
            or len(var_names) != 2
            or not all(isinstance(v, str) for v in var_names)
        ):
            raise ProblemError(
                "constraint #%d: 'vars' must be a list of two variable names" % index
            )
        for var_name in var_names:
            if var_name not in domains:
                raise ProblemError(
                    "constraint #%d references unknown variable: %r"
                    % (index, var_name)
                )
        constraints.append((ctype, var_names[0], var_names[1]))

    return domains, constraints


def load_problem(path):
    """Load and validate a problem from a JSON file."""
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except FileNotFoundError:
        raise ProblemError("input file not found: %s" % path)
    except json.JSONDecodeError as exc:
        raise ProblemError("invalid JSON in %s: %s" % (path, exc))
    return validate_problem(data)

"""Loading and validation of JSON-encoded CSP problems.

Accepted format:

{
  "variables": {"x": [1, 2, 3], "y": [1, 2, 3]},
  "constraints": [
    {"id": 0, "scope": ["x", "y"], "type": "allowed",
     "tuples": [[1, 1], [2, 2]]},
    {"id": 1, "scope": ["y", "z"], "type": "forbidden",
     "tuples": [[1, 1]]}
  ]
}

"variables" may also be a list of {"name": ..., "domain": [...]} objects.
Constraint ids may be omitted, in which case they are assigned by position.
"forbidden" constraints are normalised to allowed tuples over the product
of the initial domains of their scope.
"""

import itertools
import json

from .core import Constraint, DynamicCSP, ProblemError


def load_problem_file(path):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            text = handle.read()
    except OSError as exc:
        raise ProblemError(f"cannot read input file: {exc}") from exc
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ProblemError(f"invalid JSON: {exc}") from exc
    return parse_problem(data)


def parse_problem(data):
    """Validate the decoded JSON document and build a DynamicCSP."""
    if not isinstance(data, dict):
        raise ProblemError("problem must be a JSON object")
    variables = _parse_variables(data.get("variables"))
    raw_constraints = data.get("constraints", [])
    if not isinstance(raw_constraints, list):
        raise ProblemError('"constraints" must be a list')
    constraints = [
        _parse_constraint(raw, index, variables)
        for index, raw in enumerate(raw_constraints)
    ]
    return DynamicCSP(variables, constraints)


def _parse_variables(raw):
    if isinstance(raw, dict):
        items = list(raw.items())
    elif isinstance(raw, list):
        items = []
        for entry in raw:
            if (
                not isinstance(entry, dict)
                or "name" not in entry
                or "domain" not in entry
            ):
                raise ProblemError(
                    'variable entries must be {"name": ..., "domain": [...]}'
                )
            items.append((entry["name"], entry["domain"]))
    else:
        raise ProblemError('"variables" must be an object or a list')
    if not items:
        raise ProblemError("problem must define at least one variable")
    variables = {}
    for name, domain in items:
        if not isinstance(name, str) or not name:
            raise ProblemError("variable names must be non-empty strings")
        if name in variables:
            raise ProblemError(f"duplicate variable {name!r}")
        if not isinstance(domain, list) or not domain:
            raise ProblemError(f"domain of variable {name!r} must be a non-empty list")
        if len(set(map(_hashable, domain))) != len(domain):
            raise ProblemError(f"domain of variable {name!r} contains duplicates")
        variables[name] = list(domain)
    return variables


def _hashable(value):
    if isinstance(value, list):
        return tuple(value)
    if isinstance(value, dict):
        return tuple(sorted(value.items()))
    return value


def _parse_constraint(raw, index, variables):
    if not isinstance(raw, dict):
        raise ProblemError(f"constraint #{index} must be an object")
    cid = raw.get("id", index)
    if isinstance(cid, bool) or not isinstance(cid, int) or cid < 0:
        raise ProblemError(f"constraint #{index}: id must be a non-negative integer")
    scope = raw.get("scope")
    if (
        not isinstance(scope, list)
        or not scope
        or not all(isinstance(name, str) for name in scope)
    ):
        raise ProblemError(f"constraint {cid}: scope must be a non-empty list of names")
    if len(set(scope)) != len(scope):
        raise ProblemError(f"constraint {cid}: scope contains duplicate variables")
    for name in scope:
        if name not in variables:
            raise ProblemError(
                f"constraint {cid}: unknown variable {name!r} in scope"
            )
    ctype = raw.get("type", "allowed")
    if ctype not in ("allowed", "forbidden"):
        raise ProblemError(f"constraint {cid}: type must be 'allowed' or 'forbidden'")
    tuples = raw.get("tuples")
    if not isinstance(tuples, list):
        raise ProblemError(f"constraint {cid}: tuples must be a list")
    arity = len(scope)
    normalised = []
    for tup in tuples:
        if not isinstance(tup, list) or len(tup) != arity:
            raise ProblemError(
                f"constraint {cid}: every tuple must be a list of length {arity}"
            )
        normalised.append(tuple(tup))
    if ctype == "allowed":
        allowed = normalised
    else:
        forbidden = set(normalised)
        allowed = [
            tup
            for tup in itertools.product(*(variables[name] for name in scope))
            if tup not in forbidden
        ]
    return Constraint(cid, scope, allowed)

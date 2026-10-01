"""Loading and validation of JSON CSP problem definitions.

Expected input format::

    {
      "variables": [
        {"name": "x", "domain": [1, 2, 3]},
        ...
      ],
      "constraints": [
        {"id": 0, "scope": ["x", "y"], "relation": [[1, 1], [2, 2]]},
        ...
      ]
    }

``id`` is optional; when omitted the constraint's index is used.
``relation`` may also be named ``tuples``.  Tuples referencing values
outside a variable's domain are ignored.
"""

import json

from .core import Constraint, ProblemError


def _is_json_scalar(value):
    return value is None or isinstance(value, (str, int, float, bool))


def _value_key(value):
    return json.dumps(value, sort_keys=True)


def load_problem(path):
    """Load and validate a problem file.

    Returns (variables, domains, constraints) where constraints is a
    list of Constraint objects.  Raises ProblemError on any invalid
    input.
    """
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except OSError as exc:
        raise ProblemError("cannot read problem file: %s" % exc)
    except json.JSONDecodeError as exc:
        raise ProblemError("invalid JSON: %s" % exc)
    return parse_problem(data)


def parse_problem(data):
    if not isinstance(data, dict):
        raise ProblemError("problem must be a JSON object")

    raw_variables = data.get("variables")
    if not isinstance(raw_variables, list) or not raw_variables:
        raise ProblemError("'variables' must be a non-empty list")

    variables = []
    domains = {}
    for entry in raw_variables:
        if not isinstance(entry, dict):
            raise ProblemError("each variable must be an object")
        name = entry.get("name")
        domain = entry.get("domain")
        if not isinstance(name, str) or not name:
            raise ProblemError("each variable needs a non-empty string 'name'")
        if name in domains:
            raise ProblemError("duplicate variable name: %r" % name)
        if not isinstance(domain, list) or not domain:
            raise ProblemError("domain of %r must be a non-empty list" % name)
        seen = set()
        for value in domain:
            if not _is_json_scalar(value):
                raise ProblemError(
                    "domain of %r contains a non-scalar value" % name
                )
            key = _value_key(value)
            if key in seen:
                raise ProblemError("domain of %r contains duplicates" % name)
            seen.add(key)
        variables.append(name)
        domains[name] = list(domain)

    raw_constraints = data.get("constraints")
    if not isinstance(raw_constraints, list):
        raise ProblemError("'constraints' must be a list")

    constraints = []
    used_ids = set()
    for index, entry in enumerate(raw_constraints):
        if not isinstance(entry, dict):
            raise ProblemError("each constraint must be an object")
        cid = entry.get("id", index)
        if isinstance(cid, bool) or not isinstance(cid, int) or cid < 0:
            raise ProblemError("constraint id must be a non-negative integer")
        if cid in used_ids:
            raise ProblemError("duplicate constraint id: %r" % cid)
        used_ids.add(cid)

        scope = entry.get("scope")
        if (
            not isinstance(scope, list)
            or len(scope) != 2
            or scope[0] == scope[1]
            or any(var not in domains for var in scope)
        ):
            raise ProblemError(
                "constraint %d needs a 'scope' of two distinct known variables"
                % cid
            )

        relation = entry.get("relation", entry.get("tuples"))
        if not isinstance(relation, list):
            raise ProblemError("constraint %d needs a 'relation' list" % cid)
        first_domain = set(domains[scope[0]])
        second_domain = set(domains[scope[1]])
        pairs = []
        for pair in relation:
            if (
                not isinstance(pair, list)
                or len(pair) != 2
                or not _is_json_scalar(pair[0])
                or not _is_json_scalar(pair[1])
            ):
                raise ProblemError(
                    "constraint %d has an invalid relation tuple" % cid
                )
            if pair[0] in first_domain and pair[1] in second_domain:
                pairs.append((pair[0], pair[1]))
        constraints.append(Constraint(cid, scope, pairs))

    return variables, domains, constraints

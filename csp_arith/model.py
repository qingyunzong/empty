"""Problem loading and validation for csp_arith."""

from dataclasses import dataclass

OPS = ("lt", "le", "eq", "ne")


class ProblemError(Exception):
    """Raised when the input problem is invalid."""


@dataclass
class Problem:
    # variables: {name: [int, ...]} enumerated integer domains
    # constraints: list of (constraint_id, op, var_a, var_b) meaning a <op> b
    variables: dict
    constraints: list


def _validate_domain(name, domain):
    if not isinstance(domain, list):
        raise ProblemError(f"domain of variable {name!r} must be a list")
    for value in domain:
        # bool is a subclass of int but is not accepted as an integer value
        if isinstance(value, bool) or not isinstance(value, int):
            raise ProblemError(
                f"domain of variable {name!r} contains non-integer value {value!r}"
            )
    return sorted(set(domain))


def load_problem(data):
    """Validate a decoded JSON document and return a Problem."""
    if not isinstance(data, dict):
        raise ProblemError("problem must be a JSON object")

    variables = data.get("variables")
    if not isinstance(variables, dict):
        raise ProblemError("'variables' must be an object mapping names to domains")
    clean_variables = {}
    for name, domain in variables.items():
        if not isinstance(name, str):
            raise ProblemError("variable names must be strings")
        clean_variables[name] = _validate_domain(name, domain)

    raw_constraints = data.get("constraints", [])
    if not isinstance(raw_constraints, list):
        raise ProblemError("'constraints' must be a list")
    constraints = []
    for index, raw in enumerate(raw_constraints):
        if not isinstance(raw, dict):
            raise ProblemError(f"constraint {index} must be an object")
        op = raw.get("type")
        if op not in OPS:
            raise ProblemError(f"constraint {index}: unknown constraint type {op!r}")
        vars_ = raw.get("vars")
        if (
            not isinstance(vars_, list)
            or len(vars_) != 2
            or not all(isinstance(v, str) for v in vars_)
        ):
            raise ProblemError(
                f"constraint {index}: 'vars' must be a list of two variable names"
            )
        for var in vars_:
            if var not in clean_variables:
                raise ProblemError(
                    f"constraint {index}: reference to unknown variable {var!r}"
                )
        constraints.append((index, op, vars_[0], vars_[1]))

    return Problem(variables=clean_variables, constraints=constraints)

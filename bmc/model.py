"""Model loading and validation.

Model JSON schema:
{
  "variables": ["x", ...] or {"x": 0, ...},
  "init": {"x": 0, ...},
  "transitions": [
    {"name": "t", "guard": "x < 3", "assign": {"x": "x + 1"}}
  ],
  "invariant": "x >= 0"
}

Limits: at most 6 variables, at most 40 transitions, values in [-9, 9].
Any schema violation raises ModelError (CLI maps it to exit code 2).
"""

import json
from dataclasses import dataclass

MIN_VALUE = -9
MAX_VALUE = 9
MAX_VARIABLES = 6
MAX_TRANSITIONS = 40


class ModelError(Exception):
    """The model file is invalid."""

    code = "E_MODEL"


@dataclass(frozen=True)
class Transition:
    name: str
    guard: str
    assign: dict


@dataclass(frozen=True)
class Model:
    variables: tuple
    init: dict
    transitions: tuple
    invariant: str = "true"


def load_model(path):
    """Read and validate a model from a JSON file."""
    try:
        with open(path, "r", encoding="utf-8") as handle:
            text = handle.read()
    except OSError as exc:
        raise ModelError(f"cannot read model file: {exc}") from exc
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ModelError(f"invalid JSON: {exc}") from exc
    return parse_model(data)


def parse_model(data):
    if not isinstance(data, dict):
        raise ModelError("model must be a JSON object")

    variables, init = _parse_variables(data)
    transitions = _parse_transitions(data.get("transitions", []), variables)

    invariant = data.get("invariant", "true")
    if not isinstance(invariant, str):
        raise ModelError("invariant must be an expression string")

    return Model(
        variables=tuple(sorted(variables)),
        init=init,
        transitions=tuple(transitions),
        invariant=invariant,
    )


def _parse_variables(data):
    raw_vars = data.get("variables")
    raw_init = data.get("init", {})

    inline_init = {}
    if isinstance(raw_vars, dict):
        names = list(raw_vars)
        inline_init = raw_vars
    elif isinstance(raw_vars, list):
        names = raw_vars
    else:
        raise ModelError("variables must be a list of names or an object")

    if not names:
        raise ModelError("model must declare at least one variable")
    if len(names) > MAX_VARIABLES:
        raise ModelError(f"too many variables (max {MAX_VARIABLES})")
    for name in names:
        if not isinstance(name, str) or not name.isidentifier():
            raise ModelError(f"invalid variable name {name!r}")
    if len(set(names)) != len(names):
        raise ModelError("duplicate variable names")

    if not isinstance(raw_init, dict):
        raise ModelError("init must be an object mapping variables to integers")

    init = {}
    for name in names:
        value = raw_init.get(name, inline_init.get(name, 0))
        init[name] = _checked_int(value, f"initial value of {name!r}")
    for extra in set(raw_init) | set(inline_init):
        if extra not in init:
            raise ModelError(f"init given for undeclared variable {extra!r}")
    return names, init


def _parse_transitions(raw, variables):
    if not isinstance(raw, list):
        raise ModelError("transitions must be a list")
    if len(raw) > MAX_TRANSITIONS:
        raise ModelError(f"too many transitions (max {MAX_TRANSITIONS})")

    known = set(variables)
    transitions = []
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            raise ModelError(f"transition {index} must be an object")
        name = item.get("name", f"t{index}")
        if not isinstance(name, str):
            raise ModelError(f"transition {index}: name must be a string")
        guard = item.get("guard", "true")
        if not isinstance(guard, str):
            raise ModelError(f"transition {name!r}: guard must be a string")
        assign = item.get("assign", item.get("assignments", {}))
        if not isinstance(assign, dict):
            raise ModelError(f"transition {name!r}: assign must be an object")
        for target, expr in assign.items():
            if target not in known:
                raise ModelError(
                    f"transition {name!r}: assignment to undeclared "
                    f"variable {target!r}"
                )
            if not isinstance(expr, str):
                raise ModelError(
                    f"transition {name!r}: assignment for {target!r} "
                    "must be an expression string"
                )
        transitions.append(Transition(name=name, guard=guard, assign=dict(assign)))
    return transitions


def _checked_int(value, what):
    if isinstance(value, bool) or not isinstance(value, int):
        raise ModelError(f"{what} must be an integer")
    if not MIN_VALUE <= value <= MAX_VALUE:
        raise ModelError(
            f"{what} out of domain [{MIN_VALUE}, {MAX_VALUE}]"
        )
    return value

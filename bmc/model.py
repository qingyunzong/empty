"""Model loading and validation for bmc.

Model JSON schema::

    {
      "variables": ["x", "y"],            // optional, <= 6 names
      "init": {"x": 0},                   // required, values in [-9, 9]
      "transitions": [                    // required, <= 40 entries
        {"name": "t0",                    // optional
         "guard": "x < 9",                // required expression string
         "assign": {"x": "x + 1"}}        // required, simultaneous assignment
      ],
      "invariant": "x >= 0"               // optional, default "True"
    }

A declared variable that is not assigned in ``init`` starts *undefined*;
reading it at runtime raises the E_READ error.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field

from .expr import ExprSyntaxError, compile_expression

DOMAIN_MIN = -9
DOMAIN_MAX = 9
MAX_VARIABLES = 6
MAX_TRANSITIONS = 40


class ModelError(Exception):
    """The model file is invalid (CLI exits with code 2)."""


@dataclass
class Transition:
    name: str
    guard: object  # compiled expression
    assign: list  # list of (variable, compiled expression), applied simultaneously


@dataclass
class Model:
    variables: tuple
    init: dict
    transitions: list = field(default_factory=list)
    invariant: object = None


def _is_int(value) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _check_name(name, what: str) -> str:
    if not isinstance(name, str) or not name.isidentifier():
        raise ModelError(f"{what} must be a valid identifier string, got {name!r}")
    return name


def load_model(text: str) -> Model:
    """Parse and validate model JSON text; raise :class:`ModelError` if invalid."""
    try:
        raw = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ModelError(f"invalid JSON: {exc}") from exc
    if not isinstance(raw, dict):
        raise ModelError("model must be a JSON object")

    init_raw = raw.get("init")
    if not isinstance(init_raw, dict) or not init_raw:
        raise ModelError('"init" must be a non-empty object of variable: integer')
    init = {}
    for name, value in init_raw.items():
        _check_name(name, "init variable name")
        if not _is_int(value):
            raise ModelError(f'init value for "{name}" must be an integer')
        if not (DOMAIN_MIN <= value <= DOMAIN_MAX):
            raise ModelError(
                f'init value for "{name}" out of domain [{DOMAIN_MIN}, {DOMAIN_MAX}]'
            )
        init[name] = value

    transitions_raw = raw.get("transitions")
    if not isinstance(transitions_raw, list):
        raise ModelError('"transitions" must be a list')
    if len(transitions_raw) > MAX_TRANSITIONS:
        raise ModelError(
            f"too many transitions: {len(transitions_raw)} > {MAX_TRANSITIONS}"
        )

    assign_targets = []
    for index, entry in enumerate(transitions_raw):
        if not isinstance(entry, dict):
            raise ModelError(f"transition {index} must be an object")
        assign = entry.get("assign")
        if not isinstance(assign, dict) or not assign:
            raise ModelError(f'transition {index}: "assign" must be a non-empty object')
        for name in assign:
            assign_targets.append(_check_name(name, f"transition {index} assign target"))

    variables_raw = raw.get("variables")
    if variables_raw is None:
        declared = list(dict.fromkeys(list(init) + assign_targets))
    else:
        if not isinstance(variables_raw, list) or not variables_raw:
            raise ModelError('"variables" must be a non-empty list of names')
        declared = [_check_name(n, "variable name") for n in variables_raw]
        if len(set(declared)) != len(declared):
            raise ModelError('"variables" contains duplicates')
    if len(declared) > MAX_VARIABLES:
        raise ModelError(f"too many variables: {len(declared)} > {MAX_VARIABLES}")
    declared_set = frozenset(declared)
    for name in init:
        if name not in declared_set:
            raise ModelError(f'init variable "{name}" is not declared in "variables"')
    for name in assign_targets:
        if name not in declared_set:
            raise ModelError(f'assign target "{name}" is not declared in "variables"')

    transitions = []
    for index, entry in enumerate(transitions_raw):
        name = entry.get("name", f"t{index}")
        if not isinstance(name, str):
            raise ModelError(f'transition {index}: "name" must be a string')
        guard_src = entry.get("guard")
        if not isinstance(guard_src, str):
            raise ModelError(f'transition {index}: "guard" must be an expression string')
        try:
            guard = compile_expression(guard_src, declared_set)
        except ExprSyntaxError as exc:
            raise ModelError(f"transition {index} guard: {exc}") from exc
        assign = []
        for var, src in entry["assign"].items():
            if not isinstance(src, str):
                raise ModelError(
                    f'transition {index}: assign expression for "{var}" must be a string'
                )
            try:
                assign.append((var, compile_expression(src, declared_set)))
            except ExprSyntaxError as exc:
                raise ModelError(f'transition {index} assign "{var}": {exc}') from exc
        transitions.append(Transition(name=name, guard=guard, assign=assign))

    invariant_src = raw.get("invariant", "True")
    if not isinstance(invariant_src, str):
        raise ModelError('"invariant" must be an expression string')
    try:
        invariant = compile_expression(invariant_src, declared_set)
    except ExprSyntaxError as exc:
        raise ModelError(f"invariant: {exc}") from exc

    return Model(
        variables=tuple(declared),
        init=init,
        transitions=transitions,
        invariant=invariant,
    )

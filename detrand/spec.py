"""Spec loading and validation.

A spec is a JSON object:

{
  "states": ["idle", "running"],
  "initial": "idle",
  "vars": {"count": 0},
  "transitions": {"idle": ["start"], "running": ["bump"]},
  "ops": {
    "start": {"to": "running"},
    "bump": {
      "to": "running",
      "guard": "count < 100",
      "args": {"n": {"kind": "int", "lo": 1, "hi": 5}},
      "effect": "count += n"
    },
    "burst": {"to": "running", "fork": {"name": "sub", "draws": 3}}
  },
  "invariants": ["count >= 0"]
}
"""

import json

from .errors import SpecError

_ARG_KINDS = ("int", "choice")


def load_spec(path):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            spec = json.load(fh)
    except OSError as exc:
        raise SpecError(f"cannot read spec {path!r}: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise SpecError(f"invalid JSON in spec {path!r}: {exc}") from exc
    validate(spec)
    return spec


def validate(spec):
    if not isinstance(spec, dict):
        raise SpecError("spec must be a JSON object")
    for key in ("states", "initial", "transitions", "ops"):
        if key not in spec:
            raise SpecError(f"missing required key: {key!r}")

    states = spec["states"]
    if (
        not isinstance(states, list)
        or not states
        or not all(isinstance(s, str) for s in states)
    ):
        raise SpecError("'states' must be a non-empty list of strings")
    if len(set(states)) != len(states):
        raise SpecError("'states' contains duplicates")
    if spec["initial"] not in states:
        raise SpecError("'initial' must be one of 'states'")

    transitions = spec["transitions"]
    ops = spec["ops"]
    if not isinstance(transitions, dict):
        raise SpecError("'transitions' must be an object")
    if not isinstance(ops, dict) or not ops:
        raise SpecError("'ops' must be a non-empty object")

    for state, names in transitions.items():
        if state not in states:
            raise SpecError(f"transitions reference unknown state {state!r}")
        if not isinstance(names, list) or not all(isinstance(n, str) for n in names):
            raise SpecError(f"transitions for state {state!r} must be a list of op names")
        for name in names:
            if name not in ops:
                raise SpecError(f"transition references unknown op {name!r}")

    for name, op in ops.items():
        _validate_op(name, op, states)

    variables = spec.get("vars", {})
    if not isinstance(variables, dict):
        raise SpecError("'vars' must be an object")

    invariants = spec.get("invariants", [])
    if not isinstance(invariants, list) or not all(
        isinstance(inv, str) for inv in invariants
    ):
        raise SpecError("'invariants' must be a list of strings")


def _validate_op(name, op, states):
    if not isinstance(op, dict):
        raise SpecError(f"op {name!r} must be an object")
    to = op.get("to")
    if to is not None and to not in states:
        raise SpecError(f"op {name!r} targets unknown state {to!r}")
    if "guard" in op and not isinstance(op["guard"], str):
        raise SpecError(f"op {name!r}: 'guard' must be a string")
    if "effect" in op and not isinstance(op["effect"], str):
        raise SpecError(f"op {name!r}: 'effect' must be a string")

    args = op.get("args", {})
    if not isinstance(args, dict):
        raise SpecError(f"op {name!r}: 'args' must be an object")
    for arg_name, arg in args.items():
        if not isinstance(arg, dict):
            raise SpecError(f"op {name!r} arg {arg_name!r} must be an object")
        kind = arg.get("kind")
        if kind not in _ARG_KINDS:
            raise SpecError(
                f"op {name!r} arg {arg_name!r}: unknown kind {kind!r}"
            )
        if kind == "int":
            lo, hi = arg.get("lo"), arg.get("hi")
            if (
                not isinstance(lo, int)
                or not isinstance(hi, int)
                or isinstance(lo, bool)
                or isinstance(hi, bool)
                or lo > hi
            ):
                raise SpecError(
                    f"op {name!r} arg {arg_name!r}: invalid int range"
                )
        else:
            options = arg.get("options")
            if not isinstance(options, list) or not options:
                raise SpecError(
                    f"op {name!r} arg {arg_name!r}: 'options' must be a non-empty list"
                )

    fork = op.get("fork")
    if fork is not None:
        if not isinstance(fork, dict):
            raise SpecError(f"op {name!r}: 'fork' must be an object")
        if not isinstance(fork.get("name"), str) or not fork["name"]:
            raise SpecError(f"op {name!r}: fork requires a non-empty 'name'")
        draws = fork.get("draws")
        if not isinstance(draws, int) or isinstance(draws, bool) or draws < 1:
            raise SpecError(f"op {name!r}: fork 'draws' must be a positive int")

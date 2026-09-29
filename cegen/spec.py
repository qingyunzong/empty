"""Specification loading, validation and domain construction for cegen.

A spec is a JSON object of the form::

    {
      "variables": [
        {"name": "x",  "type": "int", "bound": 2},
        {"name": "ok", "type": "bool"},
        {"name": "xs", "type": "list", "max_len": 2,
         "elem": {"type": "int", "bound": 1}}
      ],
      "predicate": "x + len(xs) >= 1"
    }

The predicate is an invariant; a counterexample is an assignment on which
the predicate evaluates to False.
"""
from __future__ import annotations

import json
import keyword
from dataclasses import dataclass
from itertools import product
from typing import Any, Callable

from .errors import PolicyError

SAFE_FUNCS = {
    "abs": abs,
    "all": all,
    "any": any,
    "len": len,
    "max": max,
    "min": min,
    "sum": sum,
}


@dataclass(frozen=True)
class Domain:
    """A finite, explicitly ordered domain with a cost function."""

    kind: str
    values: tuple
    cost: Callable[[Any], int]


@dataclass(frozen=True)
class Variable:
    name: str
    domain: Domain


@dataclass(frozen=True)
class Spec:
    variables: tuple
    predicate: str
    code: Any
    default_bound: int


def _nonneg_int(value: Any, what: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise PolicyError(f"{what} must be a non-negative integer, got {value!r}")
    return value


def build_domain(node: Any, default_bound: int, path: str) -> Domain:
    """Build an ordered domain from a JSON node.

    Ordering rules (part of the cegen semantics):
      * int:  ascending from -bound to +bound
      * bool: (False, True)
      * list: all tuples of length 0..max_len, in natural tuple order
    """
    if not isinstance(node, dict):
        raise PolicyError(f"{path}: domain spec must be an object")
    kind = node.get("type")
    if kind == "int":
        bound = _nonneg_int(node.get("bound", default_bound), f"{path}.bound")
        return Domain("int", tuple(range(-bound, bound + 1)), lambda v: abs(v))
    if kind == "bool":
        return Domain("bool", (False, True), lambda v: int(v))
    if kind == "list":
        if "max_len" not in node:
            raise PolicyError(f"{path}: list domain requires 'max_len'")
        max_len = _nonneg_int(node["max_len"], f"{path}.max_len")
        if "elem" not in node:
            raise PolicyError(f"{path}: list domain requires 'elem'")
        elem = build_domain(node["elem"], default_bound, f"{path}.elem")
        values = []
        for length in range(max_len + 1):
            values.extend(product(elem.values, repeat=length))
        # Natural tuple order keeps the invariant that itertools.product
        # over the ordered domains enumerates assignments lexicographically.
        values.sort()
        return Domain(
            "list",
            tuple(values),
            lambda v: len(v) + sum(elem.cost(e) for e in v),
        )
    raise PolicyError(f"{path}: unknown domain type {kind!r}")


def parse_spec(data: Any, default_bound: int = 3) -> Spec:
    """Validate a decoded JSON spec and compile its predicate."""
    if not isinstance(data, dict):
        raise PolicyError("spec must be a JSON object")
    raw_vars = data.get("variables")
    if not isinstance(raw_vars, list):
        raise PolicyError("'variables' must be a list of variable objects")
    variables = []
    seen = set()
    for index, item in enumerate(raw_vars):
        path = f"variables[{index}]"
        if not isinstance(item, dict):
            raise PolicyError(f"{path}: variable spec must be an object")
        name = item.get("name")
        if (
            not isinstance(name, str)
            or not name.isidentifier()
            or keyword.iskeyword(name)
        ):
            raise PolicyError(f"{path}: invalid variable name {name!r}")
        if name in SAFE_FUNCS:
            raise PolicyError(f"{path}: name {name!r} shadows a safe builtin")
        if name in seen:
            raise PolicyError(f"{path}: duplicate variable name {name!r}")
        seen.add(name)
        domain = build_domain(item, default_bound, f"{path}({name})")
        variables.append(Variable(name, domain))
    predicate = data.get("predicate")
    if not isinstance(predicate, str) or not predicate.strip():
        raise PolicyError("'predicate' must be a non-empty string")
    try:
        code = compile(predicate, "<predicate>", "eval")
    except SyntaxError as exc:
        raise PolicyError(f"predicate does not compile: {exc}") from exc
    return Spec(tuple(variables), predicate, code, default_bound)


def load_spec(path: str, default_bound: int = 3) -> Spec:
    """Read a JSON spec file and validate it."""
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except OSError as exc:
        raise PolicyError(f"cannot read spec file {path!r}: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise PolicyError(f"invalid JSON in {path!r}: {exc}") from exc
    return parse_spec(data, default_bound)

"""Spec loading and validation. All failures raise PolicyError."""
from __future__ import annotations

import json

from .errors import PolicyError

VALID_TYPES = {"int", "bool", "list"}
DEFAULT_BOUND = 3
DEFAULT_MAX_LEN = 2


def load_spec(path):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            text = handle.read()
    except OSError as exc:
        raise PolicyError(f"cannot read spec file {path!r}: {exc}") from exc
    try:
        spec = json.loads(text)
    except json.JSONDecodeError as exc:
        raise PolicyError(f"invalid JSON in {path!r}: {exc}") from exc
    return validate_spec(spec)


def _check_non_neg_int(value, what):
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise PolicyError(f"{what} must be a non-negative integer, got {value!r}")


def _validate_elem(elem, owner):
    if not isinstance(elem, dict):
        raise PolicyError(f"elem of {owner!r} must be an object")
    kind = elem.get("type")
    if kind not in VALID_TYPES:
        raise PolicyError(f"unknown elem type {kind!r} for {owner!r}")
    if kind == "list":
        if "max_len" in elem:
            _check_non_neg_int(elem["max_len"], f"max_len of {owner!r}")
        _validate_elem(elem.get("elem", {"type": "int"}), owner)


def _validate_var(var, seen):
    if not isinstance(var, dict):
        raise PolicyError("each variable must be an object")
    name = var.get("name")
    if (not isinstance(name, str) or not name.isidentifier()
            or name.startswith("__")):
        raise PolicyError(f"invalid variable name {name!r}")
    if name in seen:
        raise PolicyError(f"duplicate variable name {name!r}")
    seen.add(name)
    kind = var.get("type")
    if kind not in VALID_TYPES:
        raise PolicyError(f"unknown type {kind!r} for variable {name!r}")
    if kind == "list":
        if "max_len" in var:
            _check_non_neg_int(var["max_len"], f"max_len of {name!r}")
        _validate_elem(var.get("elem", {"type": "int"}), name)


def validate_spec(spec):
    if not isinstance(spec, dict):
        raise PolicyError("spec must be a JSON object")
    variables = spec.get("variables")
    if not isinstance(variables, list):
        raise PolicyError("spec.variables must be a list")
    seen = set()
    for var in variables:
        _validate_var(var, seen)
    predicate = spec.get("predicate")
    if not isinstance(predicate, str) or not predicate.strip():
        raise PolicyError("spec.predicate must be a non-empty string")
    for key in ("bound", "max_len"):
        if key in spec:
            _check_non_neg_int(spec[key], f"spec.{key}")
    return spec


def resolve_bound(spec, override):
    bound = override if override is not None else spec.get("bound", DEFAULT_BOUND)
    _check_non_neg_int(bound, "bound")
    return bound


def resolve_max_len(spec, override):
    max_len = override if override is not None else spec.get("max_len", DEFAULT_MAX_LEN)
    _check_non_neg_int(max_len, "max_len")
    return max_len

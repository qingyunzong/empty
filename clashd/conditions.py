"""Tri-state condition evaluation with short-circuit semantics."""

from enum import Enum

from .errors import PolicyError


class Tri(Enum):
    FALSE = 0
    UNKNOWN = 1
    TRUE = 2


_MISSING = object()

_OPS = ("eq", "ne", "lt", "le", "gt", "ge", "in")


def _lookup(attrs, path):
    if not isinstance(path, str) or not path:
        raise PolicyError("E_INVALID_CONDITION", f"bad attribute path: {path!r}")
    cur = attrs
    for part in path.split("."):
        if isinstance(cur, dict) and part in cur:
            cur = cur[part]
        else:
            return _MISSING
    return cur


def _compare(op, left, right):
    try:
        if op == "eq":
            return Tri.TRUE if left == right else Tri.FALSE
        if op == "ne":
            return Tri.TRUE if left != right else Tri.FALSE
        if op == "lt":
            return Tri.TRUE if left < right else Tri.FALSE
        if op == "le":
            return Tri.TRUE if left <= right else Tri.FALSE
        if op == "gt":
            return Tri.TRUE if left > right else Tri.FALSE
        if op == "ge":
            return Tri.TRUE if left >= right else Tri.FALSE
        if op == "in":
            if not isinstance(right, (list, tuple)):
                return Tri.UNKNOWN
            return Tri.TRUE if left in right else Tri.FALSE
    except TypeError:
        return Tri.UNKNOWN
    raise PolicyError("E_INVALID_CONDITION", f"unknown operator: {op!r}")


def eval_condition(cond, attrs):
    """Evaluate a condition expression to a Tri value.

    Short-circuits: `and` stops at the first FALSE, `or` stops at the
    first TRUE. UNKNOWN propagates and is never equal to FALSE.
    """
    if cond is None:
        return Tri.TRUE
    if not isinstance(cond, dict) or not cond:
        raise PolicyError("E_INVALID_CONDITION", f"bad condition: {cond!r}")
    if "and" in cond:
        result = Tri.TRUE
        for sub in cond["and"]:
            value = eval_condition(sub, attrs)
            if value is Tri.FALSE:
                return Tri.FALSE
            if value is Tri.UNKNOWN:
                result = Tri.UNKNOWN
        return result
    if "or" in cond:
        result = Tri.FALSE
        for sub in cond["or"]:
            value = eval_condition(sub, attrs)
            if value is Tri.TRUE:
                return Tri.TRUE
            if value is Tri.UNKNOWN:
                result = Tri.UNKNOWN
        return result
    if "not" in cond:
        value = eval_condition(cond["not"], attrs)
        if value is Tri.TRUE:
            return Tri.FALSE
        if value is Tri.FALSE:
            return Tri.TRUE
        return Tri.UNKNOWN
    if "exists" in cond:
        return Tri.TRUE if _lookup(attrs, cond["exists"]) is not _MISSING else Tri.FALSE
    if "attr" in cond:
        op = cond.get("op", "eq")
        if op not in _OPS:
            raise PolicyError("E_INVALID_CONDITION", f"unknown operator: {op!r}")
        if "value" not in cond:
            raise PolicyError("E_INVALID_CONDITION", "comparison missing 'value'")
        left = _lookup(attrs, cond["attr"])
        if left is _MISSING:
            return Tri.UNKNOWN
        return _compare(op, left, cond["value"])
    raise PolicyError("E_INVALID_CONDITION", f"bad condition: {cond!r}")

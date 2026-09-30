"""budgetsync: budgeted one-way sync planning between two JSON objects.

Generates a sequence of set/delete operations that converges a JSON object
B toward a target JSON object A, selecting the maximum-benefit set of
operations that fits within a given operation budget.
"""

from __future__ import annotations

import copy
import json
from typing import Any, Iterable

OP_DELETE = "delete"
OP_SET = "set"

# Tie-break rank: delete sorts before set for the same key.
_OP_RANK = {OP_DELETE: 0, OP_SET: 1}

__all__ = [
    "OP_DELETE",
    "OP_SET",
    "canonical",
    "needed_ops",
    "select_ops",
    "build_plan",
    "apply_op",
    "apply_plan",
    "matched_fields",
]


def _canonize(value: Any) -> Any:
    """Recursively normalize a JSON value for comparison.

    Numbers are unified to float and -0.0 is normalized to 0.0 so that
    numerically equal values compare equal regardless of JSON spelling.
    Booleans stay booleans so they remain distinct from numbers.
    """
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        number = float(value)
        if number == 0:
            number = 0.0
        return number
    if isinstance(value, dict):
        return {str(key): _canonize(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_canonize(item) for item in value]
    return value


def canonical(value: Any) -> str:
    """Return the canonical JSON string used for value comparison."""
    return json.dumps(
        _canonize(value), sort_keys=True, separators=(",", ":"), ensure_ascii=False
    )


def _op_sort_key(op: dict) -> tuple:
    return (op["key"], _OP_RANK[op["op"]])


def needed_ops(a: dict, b: dict) -> list[dict]:
    """Return the ops that fully converge B to A, sorted deterministically.

    A field needs an op when it is missing on one side or its value differs
    under canonical JSON comparison. No partial sets are emitted: a set
    always writes A's exact value, a delete removes the key entirely.
    """
    ops: list[dict] = []
    for key in set(a) | set(b):
        in_a = key in a
        in_b = key in b
        if in_a and in_b:
            if canonical(a[key]) != canonical(b[key]):
                ops.append({"op": OP_SET, "key": key, "value": a[key]})
        elif in_a:
            ops.append({"op": OP_SET, "key": key, "value": a[key]})
        else:
            ops.append({"op": OP_DELETE, "key": key})
    ops.sort(key=_op_sort_key)
    return ops


def select_ops(ops: Iterable[dict], budget: int) -> list[dict]:
    """Select the optimal subset of ops within the budget.

    Every op costs 1 and yields 1 benefit (one matched field), so the
    maximum-benefit selection is the largest affordable prefix of the
    deterministic (key, op) ordering, which is also the lexicographically
    smallest max-benefit set as required by the tie-break rule.
    """
    ordered = sorted(ops, key=_op_sort_key)
    if budget <= 0:
        return []
    return ordered[:budget]


def build_plan(a: dict, b: dict, budget: int) -> list[dict]:
    """Compute the selected operation plan for converging B to A."""
    return select_ops(needed_ops(a, b), budget)


def apply_op(state: dict, op: dict) -> dict:
    """Return a new state with a single op applied."""
    result = copy.deepcopy(state)
    if op["op"] == OP_SET:
        result[op["key"]] = copy.deepcopy(op["value"])
    elif op["op"] == OP_DELETE:
        result.pop(op["key"], None)
    else:
        raise ValueError(f"unknown op: {op['op']!r}")
    return result


def apply_plan(state: dict, ops: Iterable[dict]) -> dict:
    """Return a new state with all ops applied in order.

    Application is idempotent: set writes an absolute value and delete is
    a no-op when the key is absent, so re-applying a plan is stable.
    """
    result = copy.deepcopy(state)
    for op in ops:
        result = apply_op(result, op)
    return result


def matched_fields(a: dict, state: dict, universe=None) -> int:
    """Count fields where state agrees with A over a fixed key universe.

    A field matches when it is absent from both sides, or present in both
    with canonically equal values. The universe defaults to the union of
    keys currently in A and state; callers evaluating a plan's benefit
    should pass ``set(a) | set(b)`` so that deleted keys (absent from
    both after repair) are counted as matched.
    """
    if universe is None:
        universe = set(a) | set(state)
    count = 0
    for key in universe:
        in_a = key in a
        in_state = key in state
        if in_a != in_state:
            continue
        if not in_a or canonical(a[key]) == canonical(state[key]):
            count += 1
    return count

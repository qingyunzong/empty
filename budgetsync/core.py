"""Core planning logic for budgetsync.

A "field" is a top-level key of the target/current JSON objects.  Field
values are compared after JSON-aware normalization so that, for example,
``-0.0`` equals ``0.0`` and values nested inside objects/arrays are compared
structurally.  A ``set`` always writes the whole normalized value; there is
no partial (sub-path) update.
"""

from __future__ import annotations

from typing import Any, List, Mapping, Sequence, Tuple

# Operation ordering weight used for tie breaking: delete < set.
_OP_ORDER = {"delete": 0, "set": 1}


class BudgetError(ValueError):
    """Raised when the budget is negative."""


class NotAnObjectError(TypeError):
    """Raised when either state is not a JSON object (mapping)."""


def canonicalize(value: Any) -> Any:
    """Return a JSON-normalized form of *value*.

    Containers are normalized recursively (mapping key order is ignored via
    plain dict comparison) and negative floating-point zero is collapsed to
    positive zero.  Booleans are preserved as booleans so that ``True`` does
    not compare equal to ``1``.
    """
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, Mapping):
        return {key: canonicalize(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [canonicalize(item) for item in value]
    if isinstance(value, float) and value == 0.0:
        # Collapse -0.0 and +0.0 (and any zero-valued float) to 0.0.
        return 0.0
    return value


def values_equal(left: Any, right: Any) -> bool:
    """Compare two values using JSON semantics.

    Numbers compare by numeric value (``0 == 0.0 == -0.0``), containers are
    compared structurally, while booleans remain distinct from integers.
    """
    if isinstance(left, bool) or isinstance(right, bool):
        return isinstance(left, bool) and isinstance(right, bool) and left == right
    if left is None or right is None:
        return left is None and right is None
    if isinstance(left, Mapping) or isinstance(right, Mapping):
        if not (isinstance(left, Mapping) and isinstance(right, Mapping)):
            return False
        if left.keys() != right.keys():
            return False
        return all(values_equal(left[key], right[key]) for key in left)
    if isinstance(left, (list, tuple)) or isinstance(right, (list, tuple)):
        if not (
            isinstance(left, (list, tuple)) and isinstance(right, (list, tuple))
        ):
            return False
        if len(left) != len(right):
            return False
        return all(values_equal(a, b) for a, b in zip(left, right))
    if isinstance(left, (int, float)) and isinstance(right, (int, float)):
        return float(left) == float(right)
    if isinstance(left, str) or isinstance(right, str):
        return isinstance(left, str) and isinstance(right, str) and left == right
    return left == right


def matching_field_count(target: Mapping[str, Any], state: Mapping[str, Any]) -> int:
    """Count top-level keys whose normalized values match in both objects."""
    count = 0
    for key in target:
        if key in state and values_equal(target[key], state[key]):
            count += 1
    return count


def matches(target: Mapping[str, Any], state: Mapping[str, Any]) -> bool:
    """Return True when *state* has fully converged to *target*.

    Convergence means every target key is present and equal, and no extra
    keys remain in *state*.
    """
    if set(target.keys()) != set(state.keys()):
        return False
    return matching_field_count(target, state) == len(target)


def _validate_objects(a: Any, b: Any) -> None:
    if not isinstance(a, Mapping) or not isinstance(b, Mapping):
        raise NotAnObjectError("both A and B must be JSON objects")


def candidate_ops(
    target: Mapping[str, Any], state: Mapping[str, Any]
) -> List[dict]:
    """Return all mismatched keys as candidate operations.

    The result is sorted by the deterministic tie-breaking order:
    ``(key, op)`` with ``delete`` ordering before ``set``.  Each candidate
    repairs exactly one top-level field, so each has gain 1 and cost 1.
    """
    ops: List[Tuple[str, int, dict]] = []
    for key in sorted(set(target) | set(state)):
        if key not in target:
            # Key exists only in state: it must be removed.
            ops.append((key, _OP_ORDER["delete"], {"op": "delete", "key": key}))
        elif key not in state:
            # Key exists only in target: it must be inserted wholesale.
            ops.append(
                (
                    key,
                    _OP_ORDER["set"],
                    {"op": "set", "key": key, "value": canonicalize(target[key])},
                )
            )
        elif not values_equal(target[key], state[key]):
            # Key differs: replace the whole value (never a partial set).
            ops.append(
                (
                    key,
                    _OP_ORDER["set"],
                    {"op": "set", "key": key, "value": canonicalize(target[key])},
                )
            )
    return [op for _, _, op in ops]


def build_plan(
    a: Mapping[str, Any],
    b: Mapping[str, Any],
    budget: int,
) -> Tuple[List[dict], dict]:
    """Build a plan converging *b* toward *a* within *budget* operations.

    Returns ``(plan, info)`` where ``plan`` is a list of operation objects
    and ``info`` reports ``selected``, ``budget`` and ``remaining``.

    Raises :class:`BudgetError` for a negative budget and
    :class:`NotAnObjectError` when either argument is not an object.
    """
    if not isinstance(budget, int) or isinstance(budget, bool):
        raise TypeError("budget must be an integer")
    if budget < 0:
        raise BudgetError("budget must be non-negative")
    _validate_objects(a, b)

    candidates = candidate_ops(a, b)
    # Every candidate has equal unit gain; the budget-limited optimum is the
    # prefix of the deterministically ordered candidate list, which is both
    # maximum-gain and the smallest set under the tie-breaking rule.
    chosen = candidates[:budget]
    info = {
        "selected": len(chosen),
        "budget": budget,
        "remaining": budget - len(chosen),
    }
    return chosen, info


def apply_plan(
    state: Mapping[str, Any],
    plan: Sequence[Mapping[str, Any]],
) -> dict:
    """Apply *plan* to a copy of *state* and return the resulting object.

    Applying a plan more than once yields the same state (the operations are
    idempotent), satisfying the convergence and repeatability requirements.
    """
    result = dict(state)
    for operation in plan:
        op = operation.get("op")
        key = operation.get("key")
        if not isinstance(key, str):
            raise ValueError("operation key must be a string")
        if op == "set":
            if "value" not in operation:
                raise ValueError("set operation requires a value")
            result[key] = canonicalize(operation["value"])
        elif op == "delete":
            result.pop(key, None)
        else:
            raise ValueError(f"unknown operation: {op!r}")
    return result

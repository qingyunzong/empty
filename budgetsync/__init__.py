"""budgetsync: produce a budgeted operation plan that converges dict B toward A.

Each operation is either ``{"op": "set", "key": k, "value": v}`` or
``{"op": "delete", "key": k}``.  Both operations cost 1.  The gain of a
plan is the number of top-level keys that match the target state after the
plan has been applied.  When the budget cannot repair every mismatch the
maximum-gain set is chosen; ties are broken first by key (lexicographic)
and then by operation (``delete`` < ``set``).
"""

from .core import (
    canonicalize,
    values_equal,
    build_plan,
    apply_plan,
    matches,
    matching_field_count,
    BudgetError,
    NotAnObjectError,
)

__all__ = [
    "canonicalize",
    "values_equal",
    "build_plan",
    "apply_plan",
    "matches",
    "matching_field_count",
    "BudgetError",
    "NotAnObjectError",
]

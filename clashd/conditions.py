"""Three-valued condition evaluation with short-circuiting.

Conditions are JSON objects with exactly one operator key:

  {"all": [cond, ...]}   conjunction, short-circuits on False
  {"any": [cond, ...]}   disjunction, short-circuits on True
  {"not": cond}          negation
  {"exists": "attr"}     attribute presence (never UNKNOWN)
  {"eq": ["attr", value]}  / "ne" / "gt" / "ge" / "lt" / "le"
  {"in": ["attr", [values]]}

Evaluation returns True, False, or the UNKNOWN singleton. UNKNOWN is
not False: a missing attribute yields UNKNOWN, and UNKNOWN propagates
through "all"/"any"/"not" per three-valued logic. Incomparable types
in ordering comparisons also yield UNKNOWN.
"""

from .errors import PolicyError


class _Unknown:
    _instance = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def __repr__(self):
        return "UNKNOWN"

    def __bool__(self):
        raise PolicyError("E_EVAL", "UNKNOWN has no boolean value")


UNKNOWN = _Unknown()

_COMPARISONS = ("eq", "ne", "gt", "ge", "lt", "le", "in")


def eval_condition(cond, attrs):
    """Evaluate ``cond`` against request attributes ``attrs``.

    Returns True, False, or UNKNOWN. ``cond`` may be None (no
    condition), which is always True.
    """
    if cond is None:
        return True
    if not isinstance(cond, dict) or len(cond) != 1:
        raise PolicyError("E_CONDITION", f"invalid condition: {cond!r}")
    (op, arg), = cond.items()

    if op == "all":
        result = True
        for sub in arg:
            value = eval_condition(sub, attrs)
            if value is False:
                return False
            if value is UNKNOWN:
                result = UNKNOWN
        return result

    if op == "any":
        result = False
        for sub in arg:
            value = eval_condition(sub, attrs)
            if value is True:
                return True
            if value is UNKNOWN:
                result = UNKNOWN
        return result

    if op == "not":
        value = eval_condition(arg, attrs)
        if value is UNKNOWN:
            return UNKNOWN
        return not value

    if op == "exists":
        return arg in attrs

    if op in _COMPARISONS:
        name, operand = arg
        if name not in attrs:
            return UNKNOWN
        value = attrs[name]
        try:
            if op == "eq":
                return value == operand
            if op == "ne":
                return value != operand
            if op == "gt":
                return value > operand
            if op == "ge":
                return value >= operand
            if op == "lt":
                return value < operand
            if op == "le":
                return value <= operand
            return value in operand
        except TypeError:
            return UNKNOWN

    raise PolicyError("E_CONDITION", f"unknown operator: {op!r}")

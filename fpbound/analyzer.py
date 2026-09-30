"""Expression-tree evaluation with exact binary64 rounding simulation and
conservative absolute error-bound propagation.

Every node records:
  exact   -- exact real value (Fraction), or None if undefined
  rounded -- the binary64 value actually computed (Fraction), or +/-INF / NAN
  bound   -- conservative upper bound on |rounded - exact| (Fraction or INF)
  status  -- "ok" | "overflow" | "div_zero" | "invalid"
"""

from fractions import Fraction

from .rounding import round_binary64, INF, NAN

_OPS = ("add", "sub", "mul", "div")


def _node(op, exact, rounded, bound, status, children=None):
    node = {
        "op": op,
        "status": status,
        "exact": exact,
        "rounded": rounded,
        "bound": bound,
    }
    if children:
        node["left"], node["right"] = children
    return node


def _propagate(child):
    """Build a node that simply propagates a child's non-ok status."""
    return child["status"]


def analyze(tree):
    """Analyze an expression tree given as nested dicts.

    Leaf: {"const": <number|Fraction|string>}
    Inner: {"op": "add"|"sub"|"mul"|"div", "left": ..., "right": ...}
    """
    if "const" in tree:
        value = tree["const"]
        if not isinstance(value, Fraction):
            value = Fraction(value)
        rounded = round_binary64(value)
        if rounded in (INF, -INF):
            return _node("const", value, rounded, INF, "overflow")
        return _node("const", value, rounded, abs(rounded - value), "ok")

    op = tree["op"]
    if op not in _OPS:
        raise ValueError(f"unknown op: {op!r}")
    left = analyze(tree["left"])
    right = analyze(tree["right"])

    for child in (left, right):
        if child["status"] != "ok":
            return _node(op, None, None, INF, _propagate(child),
                         (left, right))

    a_r, b_r = left["rounded"], right["rounded"]
    a_e, b_e = left["exact"], right["exact"]
    e_a, e_b = left["bound"], right["bound"]

    if op == "div" and (b_e == 0 or b_r == 0):
        # IEEE: x/0 -> +/-inf (x != 0), 0/0 -> nan. Exact value undefined
        # (or unreachable by the fp computation), so the bound is infinite.
        if a_r == 0:
            rounded = NAN
            status = "invalid"
        else:
            rounded = INF if a_r > 0 else -INF
            status = "div_zero"
        return _node(op, None if b_e == 0 else a_e / b_e, rounded, INF,
                     status, (left, right))

    if op == "add":
        exact = a_e + b_e
        v = a_r + b_r
        propagated = e_a + e_b
    elif op == "sub":
        exact = a_e - b_e
        v = a_r - b_r
        propagated = e_a + e_b
    elif op == "mul":
        exact = a_e * b_e
        v = a_r * b_r
        propagated = (abs(a_r) * e_b + abs(b_r) * e_a + e_a * e_b)
    else:  # div
        exact = a_e / b_e
        v = a_r / b_r
        propagated = (abs(b_r) * e_a + abs(a_r) * e_b) / (abs(b_r) * abs(b_e))

    rounded = round_binary64(v)
    if rounded in (INF, -INF):
        return _node(op, exact, rounded, INF, "overflow", (left, right))

    # Local rounding error is known exactly; the propagated part bounds
    # |v - exact|. Their sum conservatively bounds |rounded - exact|.
    bound = propagated + abs(rounded - v)
    return _node(op, exact, rounded, bound, "ok", (left, right))


def _fmt(value):
    if isinstance(value, Fraction):
        return str(value.numerator) if value.denominator == 1 else str(value)
    if value is None:
        return None
    if value == INF:
        return "inf"
    if value == -INF:
        return "-inf"
    if value != value:  # nan
        return "nan"
    return str(value)


def to_json(node):
    """Convert an analyzed tree into a JSON-serializable structure."""
    out = {
        "op": node["op"],
        "status": node["status"],
        "exact": _fmt(node["exact"]),
        "rounded": _fmt(node["rounded"]),
        "bound": _fmt(node["bound"]),
    }
    if "left" in node:
        out["left"] = to_json(node["left"])
        out["right"] = to_json(node["right"])
    return out

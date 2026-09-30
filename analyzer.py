"""Binary64 floating-point expression error-bound analyzer.

Reads a JSON expression tree (constants + add/sub/mul/div), simulates every
round-to-nearest-even rounding to binary64 exactly with Fraction, and
propagates a conservative absolute error bound through the tree.

Semantics per node:
  exact   -- value under exact real arithmetic (Fraction, or None if undefined)
  rounded -- value actually computed in binary64 (float, inf/nan on failure)
  bound   -- conservative upper bound on |rounded - exact| (Fraction or None
             meaning unbounded/infinite)
"""

from __future__ import annotations

import json
import math
import sys
from dataclasses import dataclass, field
from fractions import Fraction

STATUS_OK = "ok"
STATUS_DIV_BY_ZERO = "div_by_zero"
STATUS_OVERFLOW = "overflow"
STATUS_UNBOUNDED = "unbounded"

OPS = {"add", "sub", "mul", "div"}


@dataclass
class NodeResult:
    id: int
    op: str
    exact: Fraction | None
    rounded: float
    bound: Fraction | None  # None means unbounded (infinite)
    status: str = STATUS_OK


def round_binary64(value: Fraction) -> tuple[float, str]:
    """Round a Fraction to binary64 (round-to-nearest-even, exact via float)."""
    try:
        return float(value), STATUS_OK
    except OverflowError:
        return (math.inf if value > 0 else -math.inf), STATUS_OVERFLOW


def _apply_exact(op: str, a: Fraction, b: Fraction) -> Fraction | None:
    if op == "add":
        return a + b
    if op == "sub":
        return a - b
    if op == "mul":
        return a * b
    if b == 0:
        return None
    return a / b


def _apply_rounded(op: str, a: Fraction, b: Fraction) -> Fraction | None:
    """Exact pre-rounding value computed on the rounded child values."""
    return _apply_exact(op, a, b)


def _propagate_bound(
    op: str,
    r1: Fraction,
    r2: Fraction,
    b1: Fraction | None,
    b2: Fraction | None,
) -> Fraction | None:
    """Conservative bound on |op(r1,r2) - op(e1,e2)| given |ri-ei| <= bi."""
    if b1 is None or b2 is None:
        return None
    if op in ("add", "sub"):
        return b1 + b2
    m1 = abs(r1) + b1  # upper bound on |e1|
    m2 = abs(r2) + b2  # upper bound on |e2|
    if op == "mul":
        return abs(r1) * b2 + m2 * b1
    # div: |r1/r2 - e1/e2| <= (b1*|e2| + |e1|*b2) / (|r2|*|e2|)
    lower_e2 = abs(r2) - b2
    if r2 == 0 or lower_e2 <= 0:
        return None  # exact denominator may be zero: unbounded
    return (b1 * m2 + m1 * b2) / (abs(r2) * lower_e2)


class Analyzer:
    def __init__(self) -> None:
        self.nodes: list[NodeResult] = []

    def analyze(self, tree: dict) -> NodeResult:
        result = self._eval(tree)
        return result

    def _emit(self, **kwargs) -> NodeResult:
        node = NodeResult(id=len(self.nodes), **kwargs)
        self.nodes.append(node)
        return node

    def _eval(self, tree: dict) -> NodeResult:
        if "const" in tree:
            exact = _parse_const(tree["const"])
            rounded, status = round_binary64(exact)
            if status == STATUS_OVERFLOW:
                return self._emit(
                    op="const", exact=exact, rounded=rounded,
                    bound=None, status=STATUS_OVERFLOW,
                )
            bound = abs(Fraction(rounded) - exact)
            return self._emit(
                op="const", exact=exact, rounded=rounded,
                bound=bound, status=STATUS_OK,
            )

        op = tree.get("op")
        if op not in OPS:
            raise ValueError(f"unknown node: {tree!r}")
        left = self._eval(tree["left"])
        right = self._eval(tree["right"])

        exact = None
        if left.exact is not None and right.exact is not None:
            exact = _apply_exact(op, left.exact, right.exact)

        # If any child already failed, the failure propagates.
        for child in (left, right):
            if child.status != STATUS_OK:
                return self._emit(
                    op=op, exact=exact, rounded=child.rounded,
                    bound=None, status=child.status,
                )

        r1 = Fraction(left.rounded)
        r2 = Fraction(right.rounded)
        computed = _apply_rounded(op, r1, r2)

        if computed is None:
            # Division by a rounded-to-zero denominator.
            if r1 == 0:
                rounded = math.nan
            else:
                sign = math.copysign(1.0, float(r1)) * math.copysign(1.0, float(r2))
                rounded = math.copysign(math.inf, sign)
            return self._emit(
                op=op, exact=exact, rounded=rounded,
                bound=None, status=STATUS_DIV_BY_ZERO,
            )

        rounded, status = round_binary64(computed)
        if status == STATUS_OVERFLOW:
            return self._emit(
                op=op, exact=exact, rounded=rounded,
                bound=None, status=STATUS_OVERFLOW,
            )

        if exact is None:
            # Exact value undefined (e.g. exact division by zero): any finite
            # computed value may be arbitrarily wrong.
            return self._emit(
                op=op, exact=None, rounded=rounded,
                bound=None, status=STATUS_UNBOUNDED,
            )

        rounding_error = abs(Fraction(rounded) - computed)
        propagated = _propagate_bound(op, r1, r2, left.bound, right.bound)
        if propagated is None:
            return self._emit(
                op=op, exact=exact, rounded=rounded,
                bound=None, status=STATUS_UNBOUNDED,
            )
        return self._emit(
            op=op, exact=exact, rounded=rounded,
            bound=rounding_error + propagated, status=STATUS_OK,
        )


def _parse_const(value) -> Fraction:
    if isinstance(value, Fraction):
        return value
    if isinstance(value, bool):
        raise ValueError(f"invalid constant: {value!r}")
    if isinstance(value, int):
        return Fraction(value)
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError(f"non-finite constant: {value!r}")
        return Fraction(str(value))
    if isinstance(value, str):
        return Fraction(value)
    raise ValueError(f"invalid constant: {value!r}")


def _fraction_str(value: Fraction | None) -> str | None:
    if value is None:
        return None
    if value.denominator == 1:
        return str(value.numerator)
    return f"{value.numerator}/{value.denominator}"


def _rounded_json(value: float):
    if math.isnan(value):
        return "nan"
    if math.isinf(value):
        return "inf" if value > 0 else "-inf"
    return value


def result_to_json(analyzer: Analyzer, root: NodeResult) -> dict:
    nodes = []
    for node in analyzer.nodes:
        nodes.append({
            "id": node.id,
            "op": node.op,
            "exact": _fraction_str(node.exact),
            "rounded": _rounded_json(node.rounded),
            "bound": "inf" if node.bound is None else _fraction_str(node.bound),
            "status": node.status,
        })
    return {"root": root.id, "nodes": nodes}


def main(argv: list[str] | None = None) -> int:
    raw = sys.stdin.read()
    try:
        tree = json.loads(raw)
    except json.JSONDecodeError as exc:
        json.dump({"error": f"invalid JSON: {exc}"}, sys.stdout, indent=2)
        sys.stdout.write("\n")
        return 1
    analyzer = Analyzer()
    try:
        root = analyzer.analyze(tree)
    except (ValueError, KeyError, TypeError) as exc:
        json.dump({"error": str(exc)}, sys.stdout, indent=2)
        sys.stdout.write("\n")
        return 1
    json.dump(result_to_json(analyzer, root), sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

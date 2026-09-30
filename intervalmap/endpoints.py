"""Exact rational interval endpoints with optional infinite bounds.

Endpoints are exact ``fractions.Fraction`` values, or the singletons
``NEG_INF`` / ``POS_INF`` for open-ended infinite bounds.
"""
from __future__ import annotations

import math
from fractions import Fraction


class _NegInf:
    def __repr__(self):  # pragma: no cover - trivial
        return "-inf"


class _PosInf:
    def __repr__(self):  # pragma: no cover - trivial
        return "+inf"


NEG_INF = _NegInf()
POS_INF = _PosInf()


def normalize(value):
    """Normalize an endpoint to Fraction, NEG_INF or POS_INF."""
    if value is NEG_INF or value is POS_INF:
        return value
    if isinstance(value, Fraction):
        return value
    if isinstance(value, bool):
        raise TypeError("bool is not a valid endpoint")
    if isinstance(value, int):
        return Fraction(value)
    if isinstance(value, float):
        if math.isinf(value):
            return POS_INF if value > 0 else NEG_INF
        raise TypeError("non-integral floats are inexact; use Fraction or str")
    if isinstance(value, str):
        return parse(value)
    raise TypeError(f"unsupported endpoint: {value!r}")


def parse(text):
    """Parse an endpoint from its JSON string form."""
    t = text.strip().lower()
    if t in ("inf", "+inf", "infinity", "+infinity"):
        return POS_INF
    if t in ("-inf", "-infinity"):
        return NEG_INF
    return Fraction(text)


def cmp(a, b):
    """Total order over endpoints: -1, 0 or 1."""
    if a is NEG_INF:
        return 0 if b is NEG_INF else -1
    if a is POS_INF:
        return 0 if b is POS_INF else 1
    if b is NEG_INF:
        return 1
    if b is POS_INF:
        return -1
    return (a > b) - (a < b)


def eq(a, b):
    return cmp(a, b) == 0


def seg_length(lo, hi):
    """Length of [lo, hi); math.inf if either end is infinite."""
    if lo is NEG_INF or hi is POS_INF:
        return math.inf
    return hi - lo


def fmt(ep):
    """JSON string form of an endpoint."""
    if ep is NEG_INF:
        return "-inf"
    if ep is POS_INF:
        return "inf"
    return str(ep)


def fmt_length(value):
    if value == math.inf:
        return "inf"
    return str(value)

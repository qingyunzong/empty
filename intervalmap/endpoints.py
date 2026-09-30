"""Endpoint values: exact rationals (Fraction) plus signed infinity sentinels."""

from __future__ import annotations

from fractions import Fraction


class _Infinity:
    """Signed infinity, order-compatible with Fraction."""

    __slots__ = ("sign",)

    def __init__(self, sign: int):
        self.sign = 1 if sign > 0 else -1

    def __repr__(self) -> str:
        return "inf" if self.sign > 0 else "-inf"

    def __str__(self) -> str:
        return "+inf" if self.sign > 0 else "-inf"

    def __hash__(self) -> int:
        return hash(("__inf__", self.sign))

    def __eq__(self, other) -> bool:
        return isinstance(other, _Infinity) and other.sign == self.sign

    def __lt__(self, other):
        if isinstance(other, _Infinity):
            return self.sign < other.sign
        if isinstance(other, (Fraction, int)):
            return self.sign < 0
        return NotImplemented

    def __le__(self, other):
        if isinstance(other, _Infinity):
            return self.sign <= other.sign
        if isinstance(other, (Fraction, int)):
            return self.sign < 0
        return NotImplemented

    def __gt__(self, other):
        if isinstance(other, _Infinity):
            return self.sign > other.sign
        if isinstance(other, (Fraction, int)):
            return self.sign > 0
        return NotImplemented

    def __ge__(self, other):
        if isinstance(other, _Infinity):
            return self.sign >= other.sign
        if isinstance(other, (Fraction, int)):
            return self.sign > 0
        return NotImplemented

    def __sub__(self, other):
        if isinstance(other, _Infinity):
            if other.sign == self.sign:
                raise ArithmeticError("inf - inf is undefined")
            return self
        if isinstance(other, (Fraction, int)):
            return self
        return NotImplemented

    def __rsub__(self, other):
        if isinstance(other, (Fraction, int)):
            return NEG_INF if self.sign > 0 else POS_INF
        return NotImplemented

    def __add__(self, other):
        if isinstance(other, _Infinity):
            if other.sign != self.sign:
                raise ArithmeticError("inf + -inf is undefined")
            return self
        if isinstance(other, (Fraction, int)):
            return self
        return NotImplemented

    __radd__ = __add__


NEG_INF = _Infinity(-1)
POS_INF = _Infinity(1)

Endpoint = Fraction | _Infinity


def parse_endpoint(value) -> Endpoint:
    """Parse an endpoint from a JSON-friendly value.

    Accepts None (context dependent), the strings "+inf"/"inf"/"-inf",
    integers, and exact rationals given as "p/q" or decimal strings.
    """
    if isinstance(value, (_Infinity, Fraction)):
        return value
    if isinstance(value, bool):
        raise ValueError(f"invalid endpoint: {value!r}")
    if isinstance(value, int):
        return Fraction(value)
    if isinstance(value, float):
        # Reject non-exact floats; callers should pass strings for rationals.
        if value != value:  # NaN
            raise ValueError("NaN is not a valid endpoint")
        if value == float("inf"):
            return POS_INF
        if value == float("-inf"):
            return NEG_INF
        return Fraction(value).limit_denominator(10**12)
    if isinstance(value, str):
        text = value.strip().lower()
        if text in ("+inf", "inf", "infinity", "+infinity"):
            return POS_INF
        if text in ("-inf", "-infinity"):
            return NEG_INF
        try:
            return Fraction(text)
        except (ValueError, ZeroDivisionError) as exc:
            raise ValueError(f"invalid endpoint: {value!r}") from exc
    raise ValueError(f"invalid endpoint: {value!r}")


def format_endpoint(ep: Endpoint) -> str:
    """Canonical string form used by the CLI and tests."""
    if isinstance(ep, _Infinity):
        return "+inf" if ep.sign > 0 else "-inf"
    if ep.denominator == 1:
        return str(ep.numerator)
    return f"{ep.numerator}/{ep.denominator}"


def format_length(value) -> str:
    return format_endpoint(value) if isinstance(value, _Infinity) else format_endpoint(value)


def sort_key(ep: Endpoint):
    """Total-order key: -inf < every rational < +inf."""
    if isinstance(ep, _Infinity):
        return (1, 0) if ep.sign > 0 else (-1, 0)
    return (0, ep)

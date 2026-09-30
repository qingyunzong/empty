"""Exact interval arithmetic with Fraction endpoints."""
from fractions import Fraction


class Interval:
    __slots__ = ("lo", "hi")

    def __init__(self, lo, hi=None):
        self.lo = Fraction(lo)
        self.hi = self.lo if hi is None else Fraction(hi)
        if self.lo > self.hi:
            raise ValueError("empty interval")

    def __repr__(self):
        return f"Interval({self.lo}, {self.hi})"

    def __eq__(self, other):
        return isinstance(other, Interval) and (self.lo, self.hi) == (other.lo, other.hi)

    @property
    def width(self):
        return self.hi - self.lo

    def contains_zero(self):
        return self.lo <= 0 <= self.hi

    def __add__(self, other):
        other = _as_interval(other)
        return Interval(self.lo + other.lo, self.hi + other.hi)

    __radd__ = __add__

    def __neg__(self):
        return Interval(-self.hi, -self.lo)

    def __sub__(self, other):
        return self + (-_as_interval(other))

    def __rsub__(self, other):
        return _as_interval(other) + (-self)

    def __mul__(self, other):
        other = _as_interval(other)
        products = (self.lo * other.lo, self.lo * other.hi,
                    self.hi * other.lo, self.hi * other.hi)
        return Interval(min(products), max(products))

    __rmul__ = __mul__

    def reciprocal(self):
        if self.contains_zero():
            raise ZeroDivisionError("interval divisor contains zero")
        bounds = (Fraction(1) / self.lo, Fraction(1) / self.hi)
        return Interval(min(bounds), max(bounds))

    def __truediv__(self, other):
        return self * _as_interval(other).reciprocal()


def _as_interval(value):
    if isinstance(value, Interval):
        return value
    return Interval(value)


def horner_interval(coeffs, lo, hi):
    """Interval extension of a polynomial (ascending coeffs) over [lo, hi]."""
    x = Interval(lo, hi)
    acc = Interval(0)
    for c in reversed(coeffs):
        acc = acc * x + c
    return acc

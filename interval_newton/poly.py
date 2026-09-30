"""Exact polynomial arithmetic over the rationals (ascending coefficients)."""
from fractions import Fraction

_ZERO = Fraction(0)


def trim(p):
    p = [Fraction(c) for c in p]
    while len(p) > 1 and p[-1] == 0:
        p.pop()
    return p


def horner(p, x):
    x = Fraction(x)
    acc = _ZERO
    for c in reversed(p):
        acc = acc * x + c
    return acc


def derivative(p):
    if len(p) <= 1:
        return [_ZERO]
    return [Fraction(i) * p[i] for i in range(1, len(p))]


def poly_divmod(dividend, divisor):
    rem = trim(dividend)
    div = trim(divisor)
    if div == [_ZERO]:
        raise ZeroDivisionError("polynomial division by zero")
    quot = [_ZERO] * max(1, len(rem) - len(div) + 1)
    while rem != [_ZERO] and len(rem) >= len(div):
        coeff = rem[-1] / div[-1]
        shift = len(rem) - len(div)
        quot[shift] = coeff
        for i in range(len(div)):
            rem[shift + i] -= coeff * div[i]
        rem = trim(rem)
    return trim(quot), rem


def poly_gcd(a, b):
    a, b = trim(a), trim(b)
    while b != [_ZERO]:
        _, rem = poly_divmod(a, b)
        a, b = b, rem
    lead = a[-1]
    return [c / lead for c in a]


def deflate(p, r):
    """Return q with p(x) = (x - r) * q(x); requires p(r) == 0."""
    p = trim(p)
    r = Fraction(r)
    n = len(p) - 1
    if n < 1:
        raise ValueError("cannot deflate a constant polynomial")
    q = [_ZERO] * n
    q[n - 1] = p[n]
    for k in range(n - 1, 0, -1):
        q[k - 1] = p[k] + r * q[k]
    return q

"""Dense univariate polynomial arithmetic over ZZ and QQ.

Representation: a polynomial is a list of coefficients ordered from the
constant term upward, with no trailing zeros.  The zero polynomial is the
empty list ``[]`` and has degree -1.  Coefficients are ``int`` (ZZ[x]) or
``fractions.Fraction`` (QQ[x]); the helpers here are ring-agnostic except
where noted.
"""

from fractions import Fraction
from math import gcd as _igcd


def trim(a):
    """Return a copy of ``a`` with trailing (high-degree) zeros removed."""
    a = list(a)
    while a and a[-1] == 0:
        a.pop()
    return a


def is_zero(a):
    return len(a) == 0


def degree(a):
    """Degree of ``a``; the zero polynomial has degree -1."""
    return len(a) - 1


def lc(a):
    """Leading coefficient; undefined for the zero polynomial."""
    if not a:
        raise ValueError("zero polynomial has no leading coefficient")
    return a[-1]


def neg(a):
    return [-c for c in a]


def add(a, b):
    n = max(len(a), len(b))
    out = [0] * n
    for i in range(len(a)):
        out[i] = a[i]
    for i in range(len(b)):
        out[i] += b[i]
    return trim(out)


def sub(a, b):
    n = max(len(a), len(b))
    out = [0] * n
    for i in range(len(a)):
        out[i] = a[i]
    for i in range(len(b)):
        out[i] -= b[i]
    return trim(out)


def mul(a, b):
    if not a or not b:
        return []
    out = [0] * (len(a) + len(b) - 1)
    for i, ai in enumerate(a):
        if ai == 0:
            continue
        for j, bj in enumerate(b):
            if bj:
                out[i + j] += ai * bj
    return trim(out)


def scale(a, c):
    if c == 0 or not a:
        return []
    return trim([c * x for x in a])


def shift(a, k):
    """Multiply by x^k."""
    if not a:
        return []
    return [0] * k + a


def divmod_qq(a, b):
    """Polynomial division over QQ (or any field of coefficients).

    Returns (quotient, remainder) with deg(remainder) < deg(b).
    """
    if not b:
        raise ZeroDivisionError("polynomial division by zero")
    a = list(a)
    if len(a) < len(b):
        return [], trim(a)
    q = [0] * (len(a) - len(b) + 1)
    inv_lc = Fraction(1, 1) / b[-1]
    while len(a) >= len(b) and a:
        k = len(a) - len(b)
        c = a[-1] * inv_lc
        q[k] = c
        for j in range(len(b)):
            a[k + j] -= c * b[j]
        while a and a[-1] == 0:
            a.pop()
    return trim(q), trim(a)


def div_exact_zz(a, b):
    """Exact division in ZZ[x].

    Returns the quotient if ``b`` divides ``a`` in ZZ[x], else ``None``.
    Works when the exact quotient has integer coefficients (always the
    case when ``b`` is primitive and divides ``a`` over QQ, by Gauss).
    """
    if not b:
        raise ZeroDivisionError("polynomial division by zero")
    if not a:
        return []
    a = list(a)
    if len(a) < len(b):
        return None
    q = [0] * (len(a) - len(b) + 1)
    blc = b[-1]
    while len(a) >= len(b) and a:
        k = len(a) - len(b)
        c = a[-1]
        if c % blc != 0:
            return None
        c //= blc
        q[k] = c
        for j in range(len(b)):
            a[k + j] -= c * b[j]
        while a and a[-1] == 0:
            a.pop()
    if a:
        return None
    return trim(q)


def content(a):
    """Content of an integer polynomial: gcd of its coefficients (>= 0)."""
    c = 0
    for x in a:
        c = _igcd(c, x if x >= 0 else -x)
    return c


def primitive_part(a):
    """Primitive part of a nonzero integer polynomial (LC made positive)."""
    if not a:
        return []
    c = content(a)
    if c == 0:
        return []
    pp = [x // c for x in a]
    if pp[-1] < 0:
        pp = [-x for x in pp]
    return pp


def normalize_primitive(a):
    """Canonical form: primitive with positive leading coefficient."""
    return primitive_part(a)


def to_qq(a):
    return [Fraction(c) for c in a]


def monic_qq(a):
    """Make a QQ[x] polynomial monic; zero stays zero."""
    if not a:
        return []
    inv = Fraction(1, 1) / a[-1]
    return [c * inv for c in a]


def eq(a, b):
    return trim(list(a)) == trim(list(b))


def parse(poly):
    """Parse a JSON coefficient list (ints or decimal strings) to ints."""
    return trim([int(c) for c in poly])


def render(poly):
    """Render coefficients as decimal strings for JSON output."""
    return [str(c) for c in trim(list(poly))]

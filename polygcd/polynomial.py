"""Dense integer polynomials with little-endian coefficients.

A polynomial is a tuple of ints; the empty tuple is the zero polynomial.
All public constructors normalize by stripping trailing zeros.
"""

from math import gcd


def trim(p):
    coeffs = list(p)
    while coeffs and coeffs[-1] == 0:
        coeffs.pop()
    return tuple(coeffs)


def is_zero(p):
    return len(p) == 0


def degree(p):
    return len(p) - 1


def lc(p):
    if not p:
        raise ValueError("the zero polynomial has no leading coefficient")
    return p[-1]


def neg(p):
    return tuple(-c for c in p)


def add(a, b):
    n = max(len(a), len(b))
    out = []
    for i in range(n):
        x = a[i] if i < len(a) else 0
        y = b[i] if i < len(b) else 0
        out.append(x + y)
    return trim(out)


def sub(a, b):
    return add(a, neg(b))


def mul(a, b):
    if not a or not b:
        return ()
    out = [0] * (len(a) + len(b) - 1)
    for i, x in enumerate(a):
        if x:
            for j, y in enumerate(b):
                if y:
                    out[i + j] += x * y
    return trim(out)


def mul_scalar(p, k):
    if k == 0 or not p:
        return ()
    return tuple(c * k for c in p)


def content(p):
    """Greatest common divisor of the coefficients; content(0) = 0."""
    c = 0
    for x in p:
        c = gcd(c, x)
    return c


def primitive_part(p):
    """p divided by its content, normalized to positive leading coefficient."""
    if not p:
        return ()
    c = content(p)
    q = tuple(x // c for x in p)
    if q[-1] < 0:
        q = neg(q)
    return q


def content_pp(p):
    """Decompose p as (content, primitive part); p = content * primitive_part."""
    return content(p), primitive_part(p)


def exact_div(f, d):
    """Return q with f == q * d over Z, or None if d does not divide f."""
    if not d:
        raise ZeroDivisionError("division by the zero polynomial")
    rem = list(f)
    if len(rem) < len(d):
        return () if not rem else None
    q = [0] * (len(rem) - len(d) + 1)
    dl = d[-1]
    while rem and len(rem) >= len(d):
        c, r = divmod(rem[-1], dl)
        if r:
            return None
        shift = len(rem) - len(d)
        q[shift] = c
        for j in range(len(d)):
            rem[shift + j] -= c * d[j]
        while rem and rem[-1] == 0:
            rem.pop()
    return tuple(q) if not rem else None

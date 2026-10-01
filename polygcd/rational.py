"""Arithmetic over Q[x] plus Wang's rational reconstruction."""

from fractions import Fraction
from math import gcd, isqrt

from .polynomial import trim, primitive_part


def to_rational(p):
    return tuple(Fraction(c) for c in p)


def r_trim(p):
    coeffs = list(p)
    while coeffs and coeffs[-1] == 0:
        coeffs.pop()
    return tuple(coeffs)


def r_add(a, b):
    n = max(len(a), len(b))
    out = []
    for i in range(n):
        x = a[i] if i < len(a) else Fraction(0)
        y = b[i] if i < len(b) else Fraction(0)
        out.append(x + y)
    return r_trim(out)


def r_sub(a, b):
    return r_add(a, tuple(-c for c in b))


def r_mul(a, b):
    if not a or not b:
        return ()
    out = [Fraction(0)] * (len(a) + len(b) - 1)
    for i, x in enumerate(a):
        if x:
            for j, y in enumerate(b):
                if y:
                    out[i + j] += x * y
    return r_trim(out)


def r_divmod(a, b):
    if not b:
        raise ZeroDivisionError("division by the zero polynomial")
    rem = list(a)
    if len(rem) < len(b):
        return (), tuple(rem)
    q = [Fraction(0)] * (len(rem) - len(b) + 1)
    bl = b[-1]
    while rem and len(rem) >= len(b):
        c = rem[-1] / bl
        shift = len(rem) - len(b)
        q[shift] = c
        for j in range(len(b)):
            rem[shift + j] -= c * b[j]
        while rem and rem[-1] == 0:
            rem.pop()
    return r_trim(q), tuple(rem)


def rational_reconstruct(a, m):
    """Wang's algorithm: the unique r/s with r == a*s (mod m), s > 0,
    gcd(r, s) = 1 and |r|, s <= sqrt(m/2); None if no such fraction exists."""
    a %= m
    if a == 0:
        return Fraction(0)
    bound = isqrt(m // 2)
    if bound < 1:
        return None
    r0, r1 = m, a
    t0, t1 = 0, 1
    while r1 > bound:
        q = r0 // r1
        r0, r1 = r1, r0 - q * r1
        t0, t1 = t1, t0 - q * t1
    r, s = r1, t1
    if s == 0:
        return None
    if s < 0:
        r, s = -r, -s
    if s > bound or gcd(r, s) != 1:
        return None
    return Fraction(r, s)


def clear_denominators(q):
    """Map a rational polynomial to the primitive integer polynomial with
    positive leading coefficient generating the same Q[x] ideal."""
    q = r_trim(q)
    if not q:
        return ()
    L = 1
    for c in q:
        L = L // gcd(L, c.denominator) * c.denominator
    ints = tuple(int(c * L) for c in q)
    return primitive_part(ints)


def gcd_rational(f, g):
    """Monic gcd over Q via the classical Euclidean algorithm."""
    a, b = to_rational(trim(f)), to_rational(trim(g))
    while b:
        _, r = r_divmod(a, b)
        a, b = b, r
    if not a:
        return ()
    lead = a[-1]
    return tuple(c / lead for c in a)


def integer_gcd_rational(f, g):
    """Primitive integer gcd (positive lc) computed purely over Q.

    Independent of the modular engine; used to cross-check it.
    """
    f = trim(f)
    g = trim(g)
    if not f:
        return primitive_part(g)
    if not g:
        return primitive_part(f)
    return clear_denominators(gcd_rational(f, g))

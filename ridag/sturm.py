"""Sturm sequences: exact count of distinct real roots of a polynomial
with rational coefficients.  Used as an independent cross-check for the
root isolator."""

from fractions import Fraction

from .intervals import MINF, PINF


def trim(p):
    p = [Fraction(c) for c in p]
    while len(p) > 1 and p[-1] == 0:
        p.pop()
    return p


def pderiv(p):
    p = trim(p)
    if len(p) <= 1:
        return [Fraction(0)]
    return trim([i * p[i] for i in range(1, len(p))])


def pdivrem(a, b):
    a, b = trim(a), trim(b)
    if not any(b):
        raise ZeroDivisionError("polynomial division by zero")
    r = list(a)
    q = [Fraction(0)] * max(1, len(a) - len(b) + 1)
    while len(r) >= len(b) and any(r):
        k = len(r) - len(b)
        c = r[-1] / b[-1]
        q[k] = c
        for j in range(len(b)):
            r[j + k] -= c * b[j]
        r = trim(r)
    return trim(q), r


def sturm_sequence(p):
    p = trim(p)
    seq = [p, pderiv(p)]
    while any(seq[-1]):
        _, r = pdivrem(seq[-2], seq[-1])
        r = trim([-c for c in r])
        if not any(r):
            break
        seq.append(r)
    return seq


def _peval(p, x):
    acc = Fraction(0)
    for c in reversed(p):
        acc = acc * x + c
    return acc


def _sgn(v):
    return (v > 0) - (v < 0)


def _signs_at(seq, x):
    if x == "inf":
        return [_sgn(q[-1]) for q in seq]
    if x == "-inf":
        return [_sgn(q[-1]) * (-1 if (len(q) - 1) % 2 else 1) for q in seq]
    return [_sgn(_peval(q, x)) for q in seq]


def _variations(signs):
    vals = [s for s in signs if s != 0]
    return sum(1 for a, b in zip(vals, vals[1:]) if a != b)


def count_roots(p, a="-inf", b="inf"):
    """Number of distinct real roots in (a, b]; a, b are Fractions or the
    strings '-inf' / 'inf'."""
    seq = sturm_sequence(p)
    return _variations(_signs_at(seq, a)) - _variations(_signs_at(seq, b))


def roots_in_interval(p, iv):
    """Number of distinct real roots in the (possibly half-open) interval
    iv, respecting its endpoint openness."""
    lo = "-inf" if iv.lo is MINF else iv.lo
    hi = "inf" if iv.hi is PINF else iv.hi
    n = count_roots(p, lo, hi)
    if lo != "-inf" and iv.lc and _peval(trim(p), lo) == 0:
        n += 1
    if hi != "inf" and not iv.hc and _peval(trim(p), hi) == 0:
        n -= 1
    return n

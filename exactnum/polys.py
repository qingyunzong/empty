"""Exact polynomial utilities over the rationals.

Polynomials are represented as lists of ``fractions.Fraction`` coefficients
in ascending order of degree: ``p[i]`` is the coefficient of ``x**i``.
All arithmetic is exact; no floating point is ever used.
"""

from fractions import Fraction


def trim(p):
    """Strip leading (high-degree) zero coefficients in place; return p."""
    while len(p) > 1 and p[-1] == 0:
        p.pop()
    return p


def to_fractions(coeffs):
    out = []
    for c in coeffs:
        if isinstance(c, Fraction):
            out.append(c)
        elif isinstance(c, int):
            out.append(Fraction(c))
        elif isinstance(c, str):
            out.append(Fraction(c))
        else:
            raise TypeError(f"unsupported coefficient: {c!r}")
    return trim(out)


def is_zero(p):
    return len(p) == 1 and p[0] == 0


def degree(p):
    return len(p) - 1


def evaluate(p, x):
    """Exact Horner evaluation at a rational point."""
    x = Fraction(x)
    acc = Fraction(0)
    for c in reversed(p):
        acc = acc * x + c
    return acc


def sign_at(p, x):
    v = evaluate(p, x)
    return (v > 0) - (v < 0)


def derivative(p):
    if len(p) == 1:
        return [Fraction(0)]
    return trim([Fraction(i) * p[i] for i in range(1, len(p))])


def monic(p):
    lc = p[-1]
    return [c / lc for c in p]


def divmod_poly(a, b):
    """Polynomial division over Q; returns (quotient, remainder)."""
    if is_zero(b):
        raise ZeroDivisionError("polynomial division by zero")
    rem = list(a)
    quo_len = len(a) - len(b) + 1
    if quo_len <= 0:
        return [Fraction(0)], trim(rem)
    quo = [Fraction(0)] * quo_len
    while len(rem) >= len(b) and not is_zero(rem):
        shift = len(rem) - len(b)
        coeff = rem[-1] / b[-1]
        quo[shift] = coeff
        for i in range(len(b)):
            rem[shift + i] -= coeff * b[i]
        trim(rem)
    return trim(quo), trim(rem)


def gcd_poly(a, b):
    """Monic greatest common divisor of two polynomials over Q."""
    a = trim(list(a))
    b = trim(list(b))
    if is_zero(a):
        return monic(b)
    if is_zero(b):
        return monic(a)
    while not is_zero(b):
        _, r = divmod_poly(a, b)
        a, b = b, r
    return monic(a)


def squarefree_part(p):
    """Square-free kernel: p / gcd(p, p'), made monic. Same roots as p."""
    d = derivative(p)
    if is_zero(d):
        return monic(p)
    g = gcd_poly(p, d)
    q, _ = divmod_poly(p, g)
    return monic(q)


def sturm_sequence(p):
    """Sturm chain for a square-free polynomial p."""
    d = derivative(p)
    if is_zero(d):
        return [p]
    seq = [p, d]
    while True:
        _, r = divmod_poly(seq[-2], seq[-1])
        if is_zero(r):
            break
        seq.append(trim([-c for c in r]))
    return seq


def _sign_changes(seq, x):
    signs = []
    for q in seq:
        s = sign_at(q, x)
        if s != 0:
            signs.append(s)
    return sum(1 for i in range(1, len(signs)) if signs[i] != signs[i - 1])


def sturm_count(p, lo, hi):
    """Number of distinct real roots of square-free p in (lo, hi]."""
    seq = sturm_sequence(p)
    return _sign_changes(seq, lo) - _sign_changes(seq, hi)

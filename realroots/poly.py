"""Exact arithmetic on univariate polynomials with rational coefficients.

A polynomial is a tuple of ``fractions.Fraction`` coefficients, lowest
degree first, with no trailing zero coefficients.  The zero polynomial is
the empty tuple ``()``.  All arithmetic is exact; no floating point is
used anywhere.
"""

from fractions import Fraction


def trim(coeffs):
    coeffs = list(coeffs)
    while coeffs and coeffs[-1] == 0:
        coeffs.pop()
    return tuple(coeffs)


def normalize(coeffs):
    return trim(Fraction(c) for c in coeffs)


def is_zero(p):
    return len(p) == 0


def is_one(p):
    return len(p) == 1 and p[0] == 1


def is_constant(p):
    return len(p) <= 1


def degree(p):
    return len(p) - 1


def leading_coeff(p):
    if is_zero(p):
        raise ValueError("zero polynomial has no leading coefficient")
    return p[-1]


def add(a, b):
    n = max(len(a), len(b))
    return trim(
        (a[i] if i < len(a) else Fraction(0)) + (b[i] if i < len(b) else Fraction(0))
        for i in range(n)
    )


def neg(a):
    return tuple(-c for c in a)


def sub(a, b):
    return add(a, neg(b))


def mul(a, b):
    if is_zero(a) or is_zero(b):
        return ()
    out = [Fraction(0)] * (len(a) + len(b) - 1)
    for i, ai in enumerate(a):
        if ai:
            for j, bj in enumerate(b):
                if bj:
                    out[i + j] += ai * bj
    return trim(out)


def scale(a, s):
    s = Fraction(s)
    if s == 0:
        return ()
    return trim(c * s for c in a)


def pow_poly(p, n):
    if n < 0:
        raise ValueError("negative exponent")
    out = (Fraction(1),)
    base = p
    while n:
        if n & 1:
            out = mul(out, base)
        base = mul(base, base)
        n >>= 1
    return out


def divmod_poly(a, b):
    if is_zero(b):
        raise ZeroDivisionError("polynomial division by zero")
    r = list(a)
    q = [Fraction(0)] * max(1, len(a) - len(b) + 1)
    inv = 1 / b[-1]
    while r and len(r) >= len(b):
        k = len(r) - len(b)
        c = r[-1] * inv
        q[k] = c
        for j in range(len(b)):
            r[j + k] -= c * b[j]
        while r and r[-1] == 0:
            r.pop()
    return trim(q), trim(r)


def div_exact(a, b):
    q, r = divmod_poly(a, b)
    if r:
        raise ValueError("polynomial division is not exact")
    return q


def rem(a, b):
    return divmod_poly(a, b)[1]


def monic(p):
    if is_zero(p):
        raise ValueError("zero polynomial cannot be made monic")
    return scale(p, 1 / p[-1])


def gcd(a, b):
    """Monic greatest common divisor over QQ."""
    if is_zero(a) and is_zero(b):
        return ()
    if is_zero(a):
        return monic(b)
    if is_zero(b):
        return monic(a)
    while not is_zero(b):
        a, b = b, rem(a, b)
        if not is_zero(b):
            b = monic(b)
    return monic(a)


def deriv(p):
    return trim(Fraction(i) * p[i] for i in range(1, len(p)))


def evaluate(p, x):
    x = Fraction(x)
    r = Fraction(0)
    for c in reversed(p):
        r = r * x + c
    return r


def squarefree_factors(f):
    """Yun's squarefree factorization over QQ (characteristic 0).

    Returns ``(leading_coeff, [(monic_factor, multiplicity), ...])`` such
    that ``f == leading_coeff * prod(factor ** mult)`` and the factors are
    monic, nonconstant, squarefree and pairwise coprime.
    """
    if is_zero(f):
        raise ValueError("zero polynomial has no squarefree factorization")
    leading = leading_coeff(f)
    if is_constant(f):
        return leading, []
    fm = monic(f)
    result = []
    c = gcd(fm, deriv(fm))
    w = div_exact(fm, c)
    i = 1
    while not is_one(w):
        y = gcd(w, c)
        z = div_exact(w, y)
        if not is_one(z):
            result.append((z, i))
        w = y
        c = div_exact(c, y)
        i += 1
    return leading, result


def cauchy_bound(p):
    """A power-of-two bound B with |root| < B for every real root.

    Uses Cauchy's strict bound 1 + max|a_i / a_n|, rounded up to a power
    of two so that repeated bisection produces dyadic rationals.
    """
    n = degree(p)
    if n < 1:
        raise ValueError("constant polynomial has no roots")
    m = max((abs(p[i]) for i in range(n)), default=Fraction(0)) / abs(p[-1])
    bound = Fraction(1)
    while bound < 1 + m:
        bound *= 2
    return bound

"""Exact polynomial utilities over the rationals (standard library only).

Polynomials are coefficient lists in ascending order: ``p[i]`` is the
coefficient of ``x**i``.  All sign determinations are exact.
"""
from fractions import Fraction
from math import gcd


def trim(p):
    p = list(p)
    while len(p) > 1 and p[-1] == 0:
        p.pop()
    return p


def derivative(p):
    p = trim(p)
    if len(p) == 1:
        return [0]
    return trim([i * p[i] for i in range(1, len(p))])


def to_fractions(p):
    return [Fraction(c) for c in trim(p)]


def divmod_poly(a, b):
    """Polynomial division over Q; returns (quotient, remainder)."""
    a = to_fractions(a)
    b = to_fractions(b)
    if b == [Fraction(0)]:
        raise ZeroDivisionError("polynomial division by zero")
    q = [Fraction(0)] * max(1, len(a) - len(b) + 1)
    r = a[:]
    while r != [Fraction(0)] and len(r) >= len(b):
        coeff = r[-1] / b[-1]
        shift = len(r) - len(b)
        q[shift] = coeff
        for i in range(len(b)):
            r[shift + i] -= coeff * b[i]
        r = trim(r)
    return trim(q), trim(r)


def gcd_poly(a, b):
    """Monic greatest common divisor over Q (coefficients are Fractions)."""
    a = to_fractions(a)
    b = to_fractions(b)
    while b != [Fraction(0)]:
        _, r = divmod_poly(a, b)
        a, b = b, r
    lead = a[-1]
    return [c / lead for c in a]


def to_primitive(p):
    """Primitive integer polynomial: content 1, positive leading coeff."""
    p = trim(p)
    g = 0
    for c in p:
        g = gcd(g, abs(int(c)))
    if g == 0:
        g = 1
    p = [int(c) // g for c in p]
    if p[-1] < 0:
        p = [-c for c in p]
    return p


def squarefree_part(p):
    """Squarefree primitive integer polynomial with the same roots as ``p``."""
    p = to_primitive(p)
    if len(p) == 1:
        return p
    g = gcd_poly(p, derivative(p))
    q, r = divmod_poly(p, g)
    if r != [Fraction(0)]:
        raise ArithmeticError("internal error: gcd does not divide polynomial")
    dens = 1
    for c in q:
        dens = dens * c.denominator // gcd(dens, c.denominator)
    return to_primitive([int(c * dens) for c in q])


def eval_at_fraction(p, x):
    """Exact value of ``p`` at rational ``x`` as a Fraction."""
    x = Fraction(x)
    total = Fraction(0)
    power = Fraction(1)
    for c in trim(p):
        total += Fraction(c) * power
        power *= x
    return total


def sign_at_fraction(p, x):
    """Exact sign of ``p(x)`` for rational ``x`` using integer arithmetic.

    Coefficients must be integers.  Evaluates the integer
    ``sum(c_i * num**i * den**(d-i))`` whose sign matches ``p(x)``.
    """
    x = Fraction(x)
    num, den = x.numerator, x.denominator
    p = trim(p)
    d = len(p) - 1
    total = 0
    for i, c in enumerate(p):
        c = int(c)
        if c:
            total += c * num ** i * den ** (d - i)
    return (total > 0) - (total < 0)


def sturm_sequence(p):
    """Sturm chain of a squarefree polynomial (Fraction coefficients)."""
    p = to_fractions(p)
    if len(p) == 1:
        return [p]
    seq = [p, to_fractions(derivative(p))]
    while True:
        _, r = divmod_poly(seq[-2], seq[-1])
        r = trim(r)
        if r == [Fraction(0)]:
            break
        seq.append([-c for c in r])
    return seq


def _variations(signs):
    v = 0
    prev = 0
    for s in signs:
        if s == 0:
            continue
        if prev != 0 and s != prev:
            v += 1
        prev = s
    return v


def sturm_count(p, a, b):
    """Number of distinct real roots of squarefree ``p`` in ``(a, b]``."""
    p = trim(p)
    if len(p) == 1:
        return 0
    seq = sturm_sequence(p)

    def signs(x):
        return [
            (lambda v: (v > 0) - (v < 0))(eval_at_fraction(s, x)) for s in seq
        ]

    return _variations(signs(Fraction(a))) - _variations(signs(Fraction(b)))


def cauchy_bound(p):
    """Strict upper bound on the absolute value of every real root."""
    p = trim(p)
    lead = abs(int(p[-1]))
    m = max((abs(int(c)) for c in p[:-1]), default=0)
    return Fraction(m, lead) + 1


def isolate_real_roots(coeffs):
    """Isolate all real roots.

    Returns a sorted list of ``("exact", Fraction)`` or
    ``("interval", lo, hi)`` entries, each isolating exactly one root.
    """
    p = squarefree_part(coeffs)
    if len(p) == 1:
        return []
    if len(p) == 2:
        return [("exact", Fraction(-p[0], p[1]))]
    bound = cauchy_bound(p) + 1
    results = []
    stack = [(-bound, bound, sturm_count(p, -bound, bound))]
    while stack:
        a, b, cnt = stack.pop()
        if cnt == 0:
            continue
        a, b = Fraction(a), Fraction(b)
        if cnt == 1:
            # Shrink until neither endpoint is itself a root, so the
            # emitted open interval strictly isolates the root.
            while sign_at_fraction(p, a) == 0 or sign_at_fraction(p, b) == 0:
                m = (a + b) / 2
                if sign_at_fraction(p, m) == 0:
                    a = b = m
                    break
                if sturm_count(p, a, m) == 1:
                    b = m
                else:
                    a = m
            if a == b:
                results.append(("exact", a))
            else:
                results.append(("interval", a, b))
            continue
        m = (a + b) / 2
        if sign_at_fraction(p, m) == 0:
            results.append(("exact", m))
            left = sturm_count(p, a, m) - 1
            right = sturm_count(p, m, b)
        else:
            left = sturm_count(p, a, m)
            right = sturm_count(p, m, b)
        stack.append((a, m, left))
        stack.append((m, b, right))

    def sort_key(item):
        if item[0] == "exact":
            return item[1]
        return (item[1] + item[2]) / 2

    results.sort(key=sort_key)
    return results


def frac_floor(f):
    f = Fraction(f)
    return f.numerator // f.denominator


def frac_ceil(f):
    f = Fraction(f)
    return -((-f.numerator) // f.denominator)


def round_half_even_fraction(f):
    """Round a rational to the nearest integer, ties to even."""
    f = Fraction(f)
    fl = frac_floor(f)
    rem = f - fl
    half = Fraction(1, 2)
    if rem < half:
        return fl
    if rem > half:
        return fl + 1
    return fl if fl % 2 == 0 else fl + 1

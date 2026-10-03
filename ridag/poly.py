"""Exact rational-coefficient polynomials and Sturm root counting.

Polynomials are dense coefficient lists, lowest degree first, of Fractions.
``to_polynomial`` / ``to_rational`` extract exact polynomial (or rational
function) form from a DAG in one variable; cond nodes make extraction fail.
"""

from __future__ import annotations

from fractions import Fraction


# -- basic polynomial algebra --------------------------------------------

def trim(p):
    while len(p) > 1 and p[-1] == 0:
        p.pop()
    return p


def padd(a, b):
    n = max(len(a), len(b))
    return trim([(a[i] if i < len(a) else 0) + (b[i] if i < len(b) else 0)
                 for i in range(n)])


def psub(a, b):
    return padd(a, [-c for c in b])


def pmul(a, b):
    out = [Fraction(0)] * (len(a) + len(b) - 1)
    for i, x in enumerate(a):
        for j, y in enumerate(b):
            out[i + j] += x * y
    return trim(out)


def pscale(a, s):
    return trim([s * c for c in a])


def pdivmod(a, b):
    a = list(a)
    if len(b) == 1 and b[0] == 0:
        raise ZeroDivisionError("polynomial division by zero")
    q = [Fraction(0)] * max(1, len(a) - len(b) + 1)
    while len(a) >= len(b) and not (len(a) == 1 and a[0] == 0):
        k = len(a) - len(b)
        c = a[-1] / b[-1]
        q[k] = c
        for i in range(len(b)):
            a[k + i] -= c * b[i]
        trim(a)
    return trim(q), trim(a)


def pder(a):
    if len(a) == 1:
        return [Fraction(0)]
    return trim([a[i] * i for i in range(1, len(a))])


def peval(a, x):
    out = Fraction(0)
    for c in reversed(a):
        out = out * x + c
    return out


def deg(a):
    return len(a) - 1


# -- DAG -> polynomial / rational extraction ------------------------------

def to_polynomial(node, var_name):
    r = to_rational(node, var_name)
    if r is None:
        return None
    p, q = r
    if len(q) == 1:
        return pscale(p, 1 / q[0])
    return None


def to_rational(node, var_name):
    """Return (num, den) coefficient lists, or None if not rational."""
    memo = {}

    def conv(n):
        if n in memo:
            return memo[n]
        op = n.op
        r = None
        if op == "const":
            r = ([n.args[0]], [Fraction(1)])
        elif op == "var":
            if n.args[0] == var_name:
                r = ([Fraction(0), Fraction(1)], [Fraction(1)])
            else:
                r = None  # other variables are not rational constants
        elif op in ("add", "sub"):
            a, b = conv(n.args[0]), conv(n.args[1])
            if a and b:
                num = padd(pmul(a[0], b[1]), pmul(b[0], a[1]))
                if op == "sub":
                    num = psub(pmul(a[0], b[1]), pmul(b[0], a[1]))
                r = (trim(num), pmul(a[1], b[1]))
        elif op == "neg":
            a = conv(n.args[0])
            if a:
                r = (pscale(a[0], -1), a[1])
        elif op == "mul":
            a, b = conv(n.args[0]), conv(n.args[1])
            if a and b:
                r = (pmul(a[0], b[0]), pmul(a[1], b[1]))
        elif op == "div":
            a, b = conv(n.args[0]), conv(n.args[1])
            if a and b and not (len(b[0]) == 1 and b[0][0] == 0):
                r = (pmul(a[0], b[1]), pmul(a[1], b[0]))
        elif op == "pow":
            base, k = n.args
            a = conv(base)
            if a:
                if k >= 0:
                    r = (_ppow(a[0], k), _ppow(a[1], k))
                else:
                    r = (_ppow(a[1], -k), _ppow(a[0], -k))
        memo[n] = r
        return r

    return conv(node)


def _ppow(p, k):
    out = [Fraction(1)]
    for _ in range(k):
        out = pmul(out, p)
    return out


# -- Sturm sequence ---------------------------------------------------------

def sturm_sequence(p):
    p = trim(list(p))
    seq = [p, pder(p)]
    while not (len(seq[-1]) == 1 and seq[-1][0] == 0):
        _, r = pdivmod(seq[-2], seq[-1])
        seq.append(pscale(r, -1))
        if len(seq) > deg(p) + 2:
            break
    return seq[:-1] if len(seq[-1]) == 1 and seq[-1][0] == 0 else seq


def _sign_variations(signs):
    s = [x for x in signs if x != 0]
    return sum(1 for i in range(len(s) - 1) if s[i] * s[i + 1] < 0)


def _signs_at(seq, x):
    """Signs of the Sturm sequence at rational point x (None allowed)."""
    return [_psign(peval(f, x)) for f in seq]


def _psign(v):
    return (v > 0) - (v < 0)


def sturm_count(p, lo=None, hi=None):
    """Number of distinct real roots in (lo, hi]; None means -/+ infinity.

    Uses V(lo) - V(hi) on the Sturm sequence; zeros inside the sequence at
    the evaluation points are skipped, which yields the count of distinct
    roots in the half-open interval (lo, hi].
    """
    seq = sturm_sequence(p)
    if lo is None:
        s_lo = []
        for f in seq:
            c = f[-1]
            s_lo.append(_psign(c) * (-1 if deg(f) % 2 else 1))
    else:
        s_lo = _signs_at(seq, lo)
    if hi is None:
        s_hi = [_psign(f[-1]) for f in seq]
    else:
        s_hi = _signs_at(seq, hi)
    return _sign_variations(s_lo) - _sign_variations(s_hi)


def squarefree_count(p, lo=None, hi=None):
    """Distinct-root count wrapper used by tests (alias of sturm_count)."""
    return sturm_count(p, lo, hi)


def _divisors(n):
    n = abs(n)
    if n == 0:
        return {1}
    out = set()
    i = 1
    while i * i <= n:
        if n % i == 0:
            out.add(i)
            out.add(n // i)
        i += 1
    return out


def rational_roots(p):
    """All rational roots of a rational-coefficient polynomial, exactly.

    Uses the rational root theorem after clearing denominators.
    """
    from math import gcd
    from functools import reduce

    p = trim(list(p))
    if len(p) == 1:
        return []
    roots = []
    # deflate factors of x so the constant term is non-zero
    k = 0
    while k < len(p) and p[k] == 0:
        k += 1
    if k:
        roots.append(Fraction(0))
        p = p[k:]
    if len(p) == 1:
        return roots
    lcm = 1
    for c in p:
        lcm = lcm * c.denominator // gcd(lcm, c.denominator)
    ints = [c * lcm for c in p]
    g = reduce(gcd, [abs(c.numerator) for c in ints if c != 0])
    ints = [c.numerator // g for c in ints]
    a0, an = ints[0], ints[-1]
    cands = set()
    ps = _divisors(a0)
    qs = _divisors(an)
    for pv in ps:
        for qv in qs:
            cands.add(Fraction(pv, qv))
            cands.add(Fraction(-pv, qv))
    roots.extend(r for r in cands if peval(p, r) == 0)
    return sorted(set(roots))

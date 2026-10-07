"""Sturm sequences and exact real-root counting over the rationals."""

from fractions import Fraction

from . import poly as P


def _sign(v):
    return (v > 0) - (v < 0)


def sturm_sequence(f):
    """The Sturm sequence of a squarefree polynomial f.

    seq[0] = f, seq[1] = f', seq[i+1] = -rem(seq[i-1], seq[i]).
    """
    if P.is_zero(f) or P.is_constant(f):
        raise ValueError("Sturm sequence needs a nonconstant polynomial")
    seq = [f, P.deriv(f)]
    while True:
        r = P.rem(seq[-2], seq[-1])
        if P.is_zero(r):
            break
        seq.append(P.neg(r))
    return seq


def _variations_from_signs(signs):
    nz = [s for s in signs if s != 0]
    return sum(1 for x, y in zip(nz, nz[1:]) if x != y)


def sign_variations_at(seq, x):
    """Sign variations of the Sturm sequence evaluated at rational x.

    Zero values are skipped, per the classical Sturm theorem.
    """
    x = Fraction(x)
    return _variations_from_signs([_sign(P.evaluate(p, x)) for p in seq])


def sign_variations_at_infinity(seq, side):
    """Sign variations at +infinity (side=+1) or -infinity (side=-1)."""
    signs = []
    for p in seq:
        s = _sign(P.leading_coeff(p))
        if side < 0 and P.degree(p) % 2 == 1:
            s = -s
        signs.append(s)
    return _variations_from_signs(signs)


def count_roots_open(seq, f, lo, hi):
    """Exact number of real roots of f in the OPEN interval (lo, hi).

    V(lo) - V(hi) counts roots in (lo, hi]; subtract one if hi itself is
    a root.  Works for arbitrary rational endpoints (zeros are skipped in
    the variation count).
    """
    n = sign_variations_at(seq, lo) - sign_variations_at(seq, hi)
    if P.evaluate(f, hi) == 0:
        n -= 1
    return n


def total_real_roots(seq):
    """Total number of distinct real roots, from variations at +-infinity."""
    return sign_variations_at_infinity(seq, -1) - sign_variations_at_infinity(seq, +1)

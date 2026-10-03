"""Sturm sequences and exact real-root counting over the rationals."""
from __future__ import annotations

from fractions import Fraction

from .poly import Poly, parse_rational


def sturm_sequence(f, budget=None):
    """Signed Sturm sequence of a square-free polynomial.

    s_0 = f, s_1 = f', s_{k+1} = -rem(s_{k-1}, s_k).

    Each remainder computation consumes one ``remainders`` budget unit.
    """
    if f.is_zero:
        raise ValueError("Sturm sequence of the zero polynomial")
    seq = [f]
    if f.is_constant:
        return seq
    seq.append(f.derivative())
    while True:
        if budget is not None:
            budget.consume("remainders")
        r = seq[-2] % seq[-1]
        if r.is_zero:
            break
        seq.append(-r)
    return seq


def sign_variations(seq, x):
    """Number of sign variations of the Sturm sequence at rational ``x``.

    Zero entries are skipped, so with this convention, for a square-free
    ``f`` and any rationals ``a < b`` (roots or not):

        V(a) - V(b) == number of distinct real roots of f in (a, b].
    """
    x = parse_rational(x)
    signs = []
    for p in seq:
        v = p.evaluate(x)
        if v > 0:
            signs.append(1)
        elif v < 0:
            signs.append(-1)
    variations = 0
    for i in range(1, len(signs)):
        if signs[i] != signs[i - 1]:
            variations += 1
    return variations


def count_roots_open(f, seq, a, b):
    """Number of distinct real roots of ``f`` in the open interval (a, b)."""
    a = parse_rational(a)
    b = parse_rational(b)
    count = sign_variations(seq, a) - sign_variations(seq, b)
    if f.evaluate(b) == 0:
        count -= 1
    return count

"""Comparison of algebraic roots coming from different polynomials.

Equality is decided through the GCD of the two (square-free) factors plus
joint isolation of the GCD's square-free part -- never by comparing
interval midpoints.  If the GCD does not certify equality or inequality,
the isolating intervals are refined until they are disjoint.
"""
from __future__ import annotations

from .isolate import IsolationSession, Root, refine_step
from .sturm import sign_variations, sturm_sequence


def disjoint_order(r1, r2):
    """Return -1/0/1 if the two roots are provably ordered, else None.

    Intervals are open; a point equal to an interval endpoint lies strictly
    outside the interval.
    """
    if r1.is_point and r2.is_point:
        if r1.value < r2.value:
            return -1
        if r1.value > r2.value:
            return 1
        return 0
    if r1.is_point:
        if r1.value <= r2.lower:
            return -1
        if r1.value >= r2.upper:
            return 1
        return None
    if r2.is_point:
        if r2.value <= r1.lower:
            return 1
        if r2.value >= r1.upper:
            return -1
        return None
    if r1.upper <= r2.lower:
        return -1
    if r2.upper <= r1.lower:
        return 1
    return None


def _match(dsq, roots_d, root):
    """Find the root of ``dsq`` equal to ``root``'s root, or None."""
    if root.is_point:
        for rd in roots_d:
            if rd.is_point and rd.value == root.value:
                return rd
            if not rd.is_point and rd.lower < root.value < rd.upper:
                return rd
        return None
    seq = sturm_sequence(dsq)
    a, b = root.lower, root.upper
    # dsq divides the factor of `root`, whose endpoints are not roots,
    # so dsq has no roots at a or b.
    if sign_variations(seq, a) - sign_variations(seq, b) == 0:
        return None
    for rd in roots_d:
        if rd.is_point:
            if a < rd.value < b:
                return rd
            continue
        lo = max(a, rd.lower)
        hi = min(b, rd.upper)
        if lo >= hi:
            continue
        if sign_variations(seq, lo) - sign_variations(seq, hi) >= 1:
            return rd
    return None


def compare_roots(f1, r1, f2, r2):
    """Compare the root of ``f1`` isolated by ``r1`` with that of ``f2``.

    Returns -1, 0 or 1.  ``f1``/``f2`` should be the square-free factors
    owning the roots (any polynomials with exactly the isolated root in the
    given interval work).
    """
    while True:
        rel = disjoint_order(r1, r2)
        if rel is not None:
            return rel
        d = f1.gcd(f2)
        if d.degree > 0:
            dsq = d.squarefree_part()
            roots_d = IsolationSession(dsq).run().roots
            m1 = _match(dsq, roots_d, r1)
            m2 = _match(dsq, roots_d, r2)
            if m1 is not None and m2 is not None:
                if m1 is m2:
                    return 0
                return -1 if m1.sort_key() < m2.sort_key() else 1
        # Not certified equal: refine the coarser side and retry.
        if r1.is_point:
            r2 = refine_step(f2, r2)
        elif r2.is_point:
            r1 = refine_step(f1, r1)
        elif r1.width() >= r2.width():
            r1 = refine_step(f1, r1)
        else:
            r2 = refine_step(f2, r2)

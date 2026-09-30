"""Verified interval Newton method for real root isolation.

All arithmetic is exact (fractions.Fraction). Roots are isolated by combining
the interval Newton operator with bisection fallback; every returned
enclosure is certified to contain exactly one real root (strict sign change
at the endpoints plus a derivative interval that excludes zero).

Newton iterates are snapped outward onto a fixed rational grid (mesh eps/16)
so that stored interval endpoints keep bounded denominators; snapping only
ever widens an enclosure, so the verification properties are preserved.
"""
from fractions import Fraction

from .interval import Interval, horner_interval
from .poly import deflate, derivative, horner, poly_gcd, trim

_ZERO = Fraction(0)
_SHRINK_LIMIT = Fraction(9, 10)


class MultipleRootsError(Exception):
    """Raised when the input polynomial is not squarefree."""


def solve(coeffs, a, b, eps):
    """Isolate all real roots of a polynomial inside [a, b].

    coeffs: coefficients in descending degree order (leading term first),
            each convertible to Fraction.
    a, b:   rational search-interval bounds with a <= b.
    eps:    positive rational; every returned enclosure has width < eps.

    Returns a sorted list of (lo, hi) Fraction pairs. Each pair encloses
    exactly one real root, and together they cover every root in [a, b].
    An interval with no roots yields an empty list.

    Raises MultipleRootsError if the polynomial has a repeated root
    (the zero polynomial included), ValueError on bad interval/eps.
    """
    a = Fraction(a)
    b = Fraction(b)
    eps = Fraction(eps)
    if a > b:
        raise ValueError("invalid interval: a > b")
    if eps <= 0:
        raise ValueError("eps must be positive")
    p = trim([Fraction(c) for c in reversed(list(coeffs))])
    if p == [_ZERO]:
        raise MultipleRootsError("zero polynomial")
    if len(p) == 1:
        return []
    if len(poly_gcd(p, derivative(p))) > 1:
        raise MultipleRootsError("polynomial has a multiple root")

    grid = eps / 16  # snap mesh for Newton iterates (keeps rationals small)
    enclosures = []
    point_roots = set()  # exact roots already recorded as degenerate intervals
    stack = []

    def record_point(x):
        point_roots.add(x)
        enclosures.append((x, x))

    def push(poly, lo, hi):
        # Schedule the search of the open interval (lo, hi) for roots of
        # poly, recording exact rational hits at the boundary points.
        if lo > hi:
            return
        if lo == hi:
            if horner(poly, lo) == 0:
                record_point(lo)
            return
        if horner(poly, lo) == 0:
            record_point(lo)
            poly = deflate(poly, lo)
        if horner(poly, hi) == 0:
            record_point(hi)
            poly = deflate(poly, hi)
        if len(poly) > 1:
            stack.append((poly, lo, hi))

    push(p, a, b)

    while stack:
        poly, lo, hi = stack.pop()
        dp = derivative(poly)
        if not horner_interval(poly, lo, hi).contains_zero():
            continue  # verified exclusion: no root of poly in [lo, hi]
        width = hi - lo
        if width < eps:
            # Certify exactly one root of the original polynomial: strict
            # sign change (existence), derivative interval excluding zero
            # (uniqueness), and no already-recorded exact root sitting on
            # the enclosure boundary. Otherwise keep bisecting;
            # squarefreeness guarantees termination.
            if (lo not in point_roots and hi not in point_roots
                    and horner(poly, lo) * horner(poly, hi) < 0
                    and not horner_interval(dp, lo, hi).contains_zero()):
                enclosures.append((lo, hi))
                continue
            m = (lo + hi) / 2
            if horner(poly, m) == 0:
                record_point(m)
                q = deflate(poly, m)
                push(q, lo, m)
                push(q, m, hi)
            else:
                push(poly, lo, m)
                push(poly, m, hi)
            continue
        m = (lo + hi) / 2
        fm = horner(poly, m)
        if fm == 0:
            record_point(m)
            q = deflate(poly, m)
            push(q, lo, m)
            push(q, m, hi)
            continue
        dfx = horner_interval(dp, lo, hi)
        if dfx.contains_zero():
            # Interval Newton step undefined: bisect instead.
            push(poly, lo, m)
            push(poly, m, hi)
            continue
        # Newton operator N = m - p(m)/p'([lo,hi]); every root of poly in
        # [lo, hi] lies in N, so intersecting preserves all roots.
        newton = Interval(m) - Interval(fm) / dfx
        nlo = max(lo, newton.lo)
        nhi = min(hi, newton.hi)
        if nlo > nhi:
            continue  # verified exclusion via the Newton operator
        if nlo == nhi:
            push(poly, nlo, nhi)  # exact point candidate
            continue
        # Snap outward onto the grid; this only widens the enclosure.
        nlo = max(lo, (nlo // grid) * grid)
        nhi = min(hi, -((-nhi) // grid) * grid)
        if nhi - nlo > width * _SHRINK_LIMIT:
            # Insufficient contraction: bisect to guarantee termination.
            push(poly, lo, m)
            push(poly, m, hi)
        else:
            push(poly, nlo, nhi)

    enclosures.sort()
    return enclosures

"""Exact rational 2D geometry primitives and convex-chain merging.

All coordinates are ``fractions.Fraction`` (always in lowest terms); no
floating point is ever used, so every predicate is exact.
"""

from __future__ import annotations

from fractions import Fraction
from math import gcd, lcm


class Point:
    """An immutable point with a unique string id and rational coordinates."""

    __slots__ = ("id", "x", "y", "xn", "xd", "yn", "yd")

    def __init__(self, pid: str, x: Fraction, y: Fraction):
        if not isinstance(x, Fraction):
            x = Fraction(x)
        if not isinstance(y, Fraction):
            y = Fraction(y)
        self.id = pid
        self.x = x
        self.y = y
        # Cached numerator/denominator pairs for the hot exact predicates.
        self.xn = x.numerator
        self.xd = x.denominator
        self.yn = y.numerator
        self.yd = y.denominator

    def key(self):
        """Total order used by the balanced tree: (x, y, id)."""
        return (self.x, self.y, self.id)

    def coord(self):
        return (self.x, self.y)

    def __eq__(self, other):
        return (
            isinstance(other, Point)
            and self.id == other.id
            and self.x == other.x
            and self.y == other.y
        )

    def __hash__(self):
        return hash((self.id, self.x, self.y))

    def __repr__(self):
        return f"Point(id={self.id!r}, x={self.x}, y={self.y})"


def orient(a: Point, b: Point, c: Point) -> Fraction:
    """Exact signed area*2 of triangle (a, b, c).

    > 0 iff c lies strictly to the left of the directed line a -> b.
    """
    return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)


def orient_sign(a: Point, b: Point, c: Point) -> int:
    """Sign of ``orient(a, b, c)`` via exact integer arithmetic.

    Equivalent to ``sign(orient(a, b, c))`` but avoids constructing any
    intermediate ``Fraction`` (no gcd, no normalisation): every coordinate
    denominator is positive, so clearing denominators preserves the sign.
    This is the hot-path predicate used by chain merging.
    """
    axn, axd = a.xn, a.xd
    ayn, ayd = a.yn, a.yd
    bxn, bxd = b.xn, b.xd
    byn, byd = b.yn, b.yd
    cxn, cxd = c.xn, c.xd
    cyn, cyd = c.yn, c.yd
    dxb = bxn * axd - axn * bxd
    dxb_d = axd * bxd
    dyc = cyn * ayd - ayn * cyd
    dyc_d = ayd * cyd
    dyb = byn * ayd - ayn * byd
    dyb_d = ayd * byd
    dxc = cxn * axd - axn * cxd
    dxc_d = axd * cxd
    value = dxb * dyc * dyb_d * dxc_d - dyb * dxc * dxb_d * dyc_d
    return (value > 0) - (value < 0)


def dist2(a: Point, b: Point) -> Fraction:
    """Exact squared Euclidean distance between two points."""
    dx = a.x - b.x
    dy = a.y - b.y
    return dx * dx + dy * dy


def edge_coefficients(a: Point, b: Point):
    """Inward half-plane of the CCW hull edge a -> b.

    Returns coprime integers ``(A, B, C)`` such that every point ``p`` of the
    point set satisfies ``A*p.x + B*p.y + C >= 0`` (the polygon interior is on
    the left of the directed edge a -> b).  The triple is normalised by the
    gcd of its integer coefficients, so it is a canonical, checkable piece of
    evidence for the edge.
    """
    A = a.y - b.y
    B = b.x - a.x
    C = (b.y - a.y) * a.x - (b.x - a.x) * a.y
    den = lcm(lcm(A.denominator, B.denominator), C.denominator)
    ai = A.numerator * (den // A.denominator)
    bi = B.numerator * (den // B.denominator)
    ci = C.numerator * (den // C.denominator)
    g = gcd(gcd(abs(ai), abs(bi)), abs(ci))
    if g == 0:
        g = 1
    return (ai // g, bi // g, ci // g)


def _merge_boundary(U, V, keep_left):
    """Resolve the shared boundary column between two x-sorted chains.

    Every point of ``U`` has x <= every point of ``V``.  Only the extreme
    columns can share an x value; keep the representative chosen by
    ``keep_left(a, b)`` (True keeps ``a``).
    """
    while U and V and U[-1].x == V[0].x:
        a, b = U[-1], V[0]
        if keep_left(a, b):
            V.pop(0)
        else:
            U.pop()
    return U, V


def merge_upper(left, right, ctr=None):
    """Merge two upper chains (left set entirely left of right set).

    Each input chain goes from the top of its leftmost column to the top of
    its rightmost column with strictly increasing x and contains no collinear
    consecutive triple.  The result is the canonical upper chain of the
    union: a prefix of the left chain bridged to a suffix of the right
    chain.  Collinear bridge points are dropped so only edge endpoints
    remain.
    """
    U, V = _merge_boundary(
        list(left),
        list(right),
        lambda a, b: a.y > b.y or (a.y == b.y and a.id <= b.id),
    )
    if not U:
        return tuple(V)
    if not V:
        return tuple(U)
    i = len(U) - 1
    j = 0
    changed = True
    while changed:
        changed = False
        while i > 0:
            if ctr is not None:
                ctr.chain_steps += 1
            # U[i] stays iff U[i-1] is strictly below line U[i]->V[j].
            if orient_sign(U[i], V[j], U[i - 1]) >= 0:
                i -= 1
                changed = True
            else:
                break
        while j < len(V) - 1:
            if ctr is not None:
                ctr.chain_steps += 1
            # V[j] stays iff V[j+1] is strictly below line U[i]->V[j].
            if orient_sign(U[i], V[j], V[j + 1]) >= 0:
                j += 1
                changed = True
            else:
                break
    return tuple(U[: i + 1]) + tuple(V[j:])


def merge_lower(left, right, ctr=None):
    """Merge two lower chains; mirror image of :func:`merge_upper`."""
    U, V = _merge_boundary(
        list(left),
        list(right),
        lambda a, b: a.y < b.y or (a.y == b.y and a.id <= b.id),
    )
    if not U:
        return tuple(V)
    if not V:
        return tuple(U)
    i = len(U) - 1
    j = 0
    changed = True
    while changed:
        changed = False
        while i > 0:
            if ctr is not None:
                ctr.chain_steps += 1
            if orient_sign(U[i], V[j], U[i - 1]) <= 0:
                i -= 1
                changed = True
            else:
                break
        while j < len(V) - 1:
            if ctr is not None:
                ctr.chain_steps += 1
            if orient_sign(U[i], V[j], V[j + 1]) <= 0:
                j += 1
                changed = True
            else:
                break
    return tuple(U[: i + 1]) + tuple(V[j:])

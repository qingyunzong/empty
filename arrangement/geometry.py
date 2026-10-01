"""Exact planar geometry on rational coordinates.

All points are ``(Fraction, Fraction)`` tuples.  Every predicate in this
module is exact; no floating point arithmetic is used anywhere.
"""

from __future__ import annotations

from fractions import Fraction
from math import gcd

Point = tuple  # (Fraction, Fraction)


def to_fraction(value) -> Fraction:
    """Convert an int / float / str / Fraction to an exact Fraction.

    Strings accept "p/q", integers and finite decimals.  Floats are
    converted through their decimal repr so that 0.1 means 1/10.
    """
    if isinstance(value, Fraction):
        return value
    if isinstance(value, bool):
        raise TypeError("boolean is not a valid coordinate")
    if isinstance(value, int):
        return Fraction(value)
    if isinstance(value, float):
        return Fraction(str(value))
    if isinstance(value, str):
        text = value.strip()
        if "/" in text:
            num, den = text.split("/", 1)
            return Fraction(int(num.strip()), int(den.strip()))
        return Fraction(text)
    raise TypeError(f"cannot convert {value!r} to a rational")


def make_point(pair) -> Point:
    """Build an exact point from a 2-sequence of convertible values."""
    try:
        x_raw, y_raw = pair
    except (TypeError, ValueError) as exc:
        raise TypeError(f"invalid point {pair!r}") from exc
    return (to_fraction(x_raw), to_fraction(y_raw))


def sign(value) -> int:
    if value > 0:
        return 1
    if value < 0:
        return -1
    return 0


def cross_vec(a: Point, b: Point) -> Fraction:
    """Z-component of the 2D cross product a x b."""
    return a[0] * b[1] - a[1] * b[0]


def orient(a: Point, b: Point, c: Point) -> int:
    """Exact sign of the orientation of the triple (a, b, c).

    Returns +1 if c is strictly left of the directed line a->b,
    -1 if strictly right, 0 if collinear.
    """
    return sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]))


def _as_integers(fracs):
    """Scale a tuple of Fractions to ints clearing denominators, divided by gcd."""
    den = 1
    for f in fracs:
        den = den * f.denominator // gcd(den, f.denominator)
    ints = [int(f * den) for f in fracs]
    g = 0
    for v in ints:
        g = gcd(g, abs(v))
    if g > 1:
        ints = [v // g for v in ints]
    return ints


def norm_dir(p: Point, q: Point):
    """Canonical undirected integer direction of the line through p != q."""
    dx = q[0] - p[0]
    dy = q[1] - p[1]
    if dx == 0 and dy == 0:
        raise ValueError("zero-length segment has no direction")
    idx, idy = _as_integers((dx, dy))
    if idx < 0 or (idx == 0 and idy < 0):
        idx, idy = -idx, -idy
    return (idx, idy)


def line_key(p: Point, q: Point):
    """Canonical (A, B, C) integer triple with A*x + B*y == C on the line."""
    dx, dy = norm_dir(p, q)
    a, b = dy, -dx
    c = a * p[0] + b * p[1]
    ia, ib, ic = _as_integers((Fraction(a), Fraction(b), c))
    if ia < 0 or (ia == 0 and ib < 0):
        ia, ib, ic = -ia, -ib, -ic
    return (ia, ib, ic)


def on_segment(p: Point, a: Point, b: Point) -> bool:
    """Exact test: does p lie on the closed segment a-b?"""
    if orient(a, b, p) != 0:
        return False
    return (
        min(a[0], b[0]) <= p[0] <= max(a[0], b[0])
        and min(a[1], b[1]) <= p[1] <= max(a[1], b[1])
    )


def line_intersection(a: Point, b: Point, c: Point, d: Point):
    """Exact intersection point of lines a-b and c-d, or None if parallel."""
    den = (b[0] - a[0]) * (d[1] - c[1]) - (b[1] - a[1]) * (d[0] - c[0])
    if den == 0:
        return None
    t = ((c[0] - a[0]) * (d[1] - c[1]) - (c[1] - a[1]) * (d[0] - c[0])) / den
    return (a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]))


def segment_intersection_point(a: Point, b: Point, c: Point, d: Point):
    """Exact proper intersection point of two non-collinear segments.

    Returns the point if the two segments (assumed non-parallel) share a
    point inside both closed segments, else None.
    """
    pt = line_intersection(a, b, c, d)
    if pt is None:
        return None
    if on_segment(pt, a, b) and on_segment(pt, c, d):
        return pt
    return None


def angle_cmp(d1, d2) -> int:
    """Exact comparator ordering non-zero direction vectors by polar angle.

    Sorts counter-clockwise starting from the positive x-axis.  Uses only
    a half-plane test and an exact cross product -- never any floating
    point trigonometry.
    """
    h1 = 0 if (d1[1] > 0 or (d1[1] == 0 and d1[0] > 0)) else 1
    h2 = 0 if (d2[1] > 0 or (d2[1] == 0 and d2[0] > 0)) else 1
    if h1 != h2:
        return -1 if h1 < h2 else 1
    c = cross_vec(d1, d2)
    if c != 0:
        return -1 if c > 0 else 1
    return 0

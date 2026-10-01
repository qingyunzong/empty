"""Exact planar geometry on rational coordinates.

All coordinates are ``fractions.Fraction``.  Points are plain ``(x, y)``
tuples of Fractions.  No floating point is used anywhere: angular
ordering is done with an exact half-plane + cross-product predicate.
"""

from __future__ import annotations

from fractions import Fraction
from math import gcd


def to_frac(value) -> Fraction:
    """Coerce an int / str / Fraction to Fraction (rejects floats)."""
    if isinstance(value, Fraction):
        return value
    if isinstance(value, bool):
        raise ValueError(f"invalid coordinate: {value!r}")
    if isinstance(value, int):
        return Fraction(value)
    if isinstance(value, str):
        text = value.strip()
        try:
            return Fraction(text)
        except (ValueError, ZeroDivisionError) as exc:
            raise ValueError(f"invalid coordinate: {value!r}") from exc
    raise ValueError(f"invalid coordinate: {value!r}")


def to_point(pair) -> tuple[Fraction, Fraction]:
    """Coerce a ``[x, y]`` pair to an exact point."""
    try:
        x_raw, y_raw = pair
    except (TypeError, ValueError) as exc:
        raise ValueError(f"invalid point: {pair!r}") from exc
    return (to_frac(x_raw), to_frac(y_raw))


def cross(o, a, b):
    """Exact sign of the cross product of OA and OB as an int in {-1,0,1}."""
    v = (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    return (v > 0) - (v < 0)


def orient(a, b, c):
    """Exact orientation of the triple (a, b, c): +1 CCW, -1 CW, 0 collinear."""
    return cross(a, b, c)


def point_key(p):
    return (p[0], p[1])


def sub(a, b):
    return (a[0] - b[0], a[1] - b[1])


def seg_dir(p, q):
    """Direction vector of segment p->q."""
    return (q[0] - p[0], q[1] - p[1])


def cmp_angle(d1, d2):
    """Exact comparator of two direction vectors by polar angle.

    Returns -1 if d1 has a smaller polar angle than d2 (measuring
    counter-clockwise from the +x axis), +1 if larger, 0 if they are
    parallel and point the same way.  Uses only sign tests and one exact
    cross product -- never any floating point / atan.
    """
    def half(d):
        # 0 for directions in the upper half-plane (incl. +x axis),
        # 1 for the lower half-plane.
        if d[1] > 0 or (d[1] == 0 and d[0] > 0):
            return 0
        return 1

    h1, h2 = half(d1), half(d2)
    if h1 != h2:
        return -1 if h1 < h2 else 1
    c = d1[0] * d2[1] - d1[1] * d2[0]
    if c != 0:
        return -1 if c > 0 else 1
    return 0


def on_segment(p, a, b):
    """True iff point p lies on the closed segment a-b (exact)."""
    if orient(a, b, p) != 0:
        return False
    return (
        min(a[0], b[0]) <= p[0] <= max(a[0], b[0])
        and min(a[1], b[1]) <= p[1] <= max(a[1], b[1])
    )


def proper_intersection(p1, p2, p3, p4):
    """Intersection point of two non-parallel segments, or None.

    Returns the exact intersection point if the two segments (assumed
    non-parallel) share at least one point, else None.
    """
    r = sub(p2, p1)
    s = sub(p4, p3)
    den = r[0] * s[1] - r[1] * s[0]
    if den == 0:
        return None
    qp = sub(p3, p1)
    t_num = qp[0] * s[1] - qp[1] * s[0]
    u_num = qp[0] * r[1] - qp[1] * r[0]
    if den < 0:
        den, t_num, u_num = -den, -t_num, -u_num
    if not (0 <= t_num <= den and 0 <= u_num <= den):
        return None
    t = Fraction(t_num, den)
    return (p1[0] + t * r[0], p1[1] + t * r[1])


def line_key(p, q):
    """Canonical key of the supporting line of segment p-q.

    Returns (A, B, C) with A*x + B*y == C, normalised to coprime
    integers with a fixed sign, so two collinear segments share a key.
    """
    dx = q[0] - p[0]
    dy = q[1] - p[1]
    a, b = dy, -dx
    c = a * p[0] + b * p[1]
    den = a.denominator
    den = den * b.denominator // gcd(den, b.denominator)
    den = den * c.denominator // gcd(den, c.denominator)
    ai, bi, ci = a * den, b * den, c * den
    g = gcd(gcd(ai.numerator, bi.numerator), ci.numerator)
    ai, bi, ci = ai // g, bi // g, ci // g
    if ai < 0 or (ai == 0 and bi < 0):
        ai, bi, ci = -ai, -bi, -ci
    return (ai, bi, ci)


def param_t(line, p):
    """1D parameter of point p on a supporting line (monotone along it)."""
    a, b, _ = line
    # Direction of the line is (-B, A); project on the dominant axis.
    if b != 0:
        return p[0]
    return p[1]

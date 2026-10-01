"""Exact rational 2D geometry primitives.

All coordinates are ``fractions.Fraction``.  No float is ever constructed:
inputs that are floats (or JSON non-integer numbers) are rejected.
"""
from fractions import Fraction

__all__ = [
    "to_fraction",
    "cross",
    "dot",
    "upper_chain",
    "lower_chain",
    "ccw_vertices",
]


def to_fraction(value):
    """Convert ``value`` to an exact :class:`Fraction`.

    Accepted: Fraction, int, "p/q" or "p" strings, (num, den) pairs.
    Rejected: float and anything else (never silently convert to float).
    """
    if isinstance(value, Fraction):
        return value
    if isinstance(value, bool):
        raise TypeError("boolean is not a valid rational coordinate")
    if isinstance(value, int):
        return Fraction(value)
    if isinstance(value, float):
        raise TypeError("float coordinates are forbidden; use exact rationals")
    if isinstance(value, str):
        text = value.strip()
        if "/" in text:
            num, den = text.split("/", 1)
            return Fraction(int(num.strip()), int(den.strip()))
        return Fraction(int(text))
    if isinstance(value, (tuple, list)) and len(value) == 2:
        return Fraction(int(value[0]), int(value[1]))
    raise TypeError(f"cannot convert {value!r} to an exact rational")


def cross(a, b, c):
    """Exact signed area*2 of triangle (a, b, c); >0 iff c is left of a->b."""
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def dot(direction, key):
    return direction[0] * key[0] + direction[1] * key[1]


def _chain_pass(sorted_keys, upper):
    """Monotone-chain pass over keys sorted by (x, y, id).

    Strict popping keeps only endpoints of collinear runs.  When several
    keys share one coordinate (duplicated points with different ids), the
    largest id is kept as the canonical representative of that coordinate.
    """
    hull = []
    for key in sorted_keys:
        if hull and hull[-1][0] == key[0] and hull[-1][1] == key[1]:
            hull[-1] = key  # same coordinate: keep the larger id
            continue
        if upper:
            while len(hull) >= 2 and cross(hull[-2], hull[-1], key) >= 0:
                hull.pop()
        else:
            while len(hull) >= 2 and cross(hull[-2], hull[-1], key) <= 0:
                hull.pop()
        hull.append(key)
    return hull


def upper_chain(sorted_keys):
    """Upper hull, left to right, of sorted (x, y, id) keys."""
    return tuple(_chain_pass(sorted_keys, True))


def lower_chain(sorted_keys):
    """Lower hull, left to right, of sorted (x, y, id) keys."""
    return tuple(_chain_pass(sorted_keys, False))


def ccw_vertices(upper, lower):
    """Canonical CCW vertex cycle from the two chains.

    Starts at the smallest (x, y, id) key and runs counter-clockwise.
    Degenerate hulls: one point -> [p]; segment -> [a, b].
    """
    if not lower:
        return []
    verts = list(lower)
    verts.extend(reversed(upper[1:-1]))
    return verts

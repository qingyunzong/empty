"""Exact rational geometry for squared Euclidean distances.

All coordinates are ``fractions.Fraction`` values, so every distance and
every bounding-box comparison below is exact -- no floating point is ever
used in distance or bound computations.
"""

from fractions import Fraction
from typing import Sequence, Tuple

Point = Tuple[Fraction, ...]
Box = Tuple[Point, Point]  # (mins, maxs), componentwise


def to_point(coords: Sequence) -> Point:
    """Convert ints, strings like "3/4", Fractions or Decimals to a rational point."""
    return tuple(Fraction(c) for c in coords)


def dist2(a: Point, b: Point) -> Fraction:
    """Exact squared Euclidean distance between two rational points."""
    return sum((x - y) * (x - y) for x, y in zip(a, b))


def box_dist2(box: Box, q: Point) -> Fraction:
    """Exact lower bound of squared distance from ``q`` to any point inside ``box``.

    Zero when ``q`` lies inside the box; otherwise the squared distance to the
    closest face/corner.  This is the safe pruning bound used by the index.
    """
    mins, maxs = box
    total = Fraction(0)
    for lo, hi, x in zip(mins, maxs, q):
        if x < lo:
            d = lo - x
        elif x > hi:
            d = x - hi
        else:
            continue
        total += d * d
    return total


def point_box(p: Point) -> Box:
    return (p, p)


def box_union(a: Box, b: Box) -> Box:
    return (
        tuple(min(x, y) for x, y in zip(a[0], b[0])),
        tuple(max(x, y) for x, y in zip(a[1], b[1])),
    )


def box_contains_point(box: Box, p: Point) -> bool:
    return all(lo <= x <= hi for lo, hi, x in zip(box[0], box[1], p))


def box_contains_box(outer: Box, inner: Box) -> bool:
    return all(
        olo <= ilo and ihi <= ohi
        for olo, ilo, ihi, ohi in zip(outer[0], inner[0], inner[1], outer[1])
    )

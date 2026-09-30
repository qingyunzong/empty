"""Exact rational arithmetic helpers.

All coordinates, distances and bounding-box bounds are
``fractions.Fraction`` values so every comparison the index performs is
exact.  Floats are deliberately rejected on input: accepting them would
silently import binary floating point error into an exact index.
"""

from __future__ import annotations

from fractions import Fraction


def to_fraction(value) -> Fraction:
    """Parse an int, a ``"p/q"``/``"1.5"`` string, or a ``[num, den]`` pair."""
    if isinstance(value, Fraction):
        return value
    if isinstance(value, bool):
        raise TypeError("boolean is not a rational coordinate")
    if isinstance(value, int):
        return Fraction(value)
    if isinstance(value, str):
        try:
            return Fraction(value)
        except ValueError as exc:
            raise ValueError(f"invalid rational literal: {value!r}") from exc
    if isinstance(value, (list, tuple)) and len(value) == 2:
        num, den = value
        if isinstance(num, bool) or isinstance(den, bool):
            raise TypeError("numerator/denominator must be integers")
        if not isinstance(num, int) or not isinstance(den, int):
            raise TypeError("numerator/denominator must be integers")
        return Fraction(num, den)
    raise TypeError(f"cannot parse an exact rational from {value!r}")


def parse_vector(vector) -> tuple:
    return tuple(to_fraction(x) for x in vector)


def frac_str(value: Fraction) -> str:
    """Canonical exact string form, e.g. ``"3/2"`` or ``"4"``."""
    return str(value)


def idkey(pid):
    """Total order over point ids: ints first (numeric), then strings."""
    return (0, pid) if type(pid) is int else (1, str(pid))


def dist2(a: tuple, b: tuple) -> Fraction:
    """Exact squared Euclidean distance."""
    total = Fraction(0)
    for x, y in zip(a, b):
        d = x - y
        total += d * d
    return total


# A bounding box is a tuple of (lo, hi) Fraction pairs, one per dimension,
# or None for an empty node.

def bbox_from_points(vectors) -> tuple:
    it = iter(vectors)
    first = next(it)
    lo = list(first)
    hi = list(first)
    for v in it:
        for i, x in enumerate(v):
            if x < lo[i]:
                lo[i] = x
            if x > hi[i]:
                hi[i] = x
    return tuple(zip(lo, hi))


def bbox_union_point(bbox, vector) -> tuple:
    if bbox is None:
        return tuple((x, x) for x in vector)
    return tuple(
        (lo if lo < x else x, hi if hi > x else x)
        for (lo, hi), x in zip(bbox, vector)
    )


def bbox_union(a, b) -> tuple:
    return tuple(
        (alo if alo < blo else blo, ahi if ahi > bhi else bhi)
        for (alo, ahi), (blo, bhi) in zip(a, b)
    )


def bbox_volume(bbox) -> Fraction:
    vol = Fraction(1)
    for lo, hi in bbox:
        vol *= hi - lo
    return vol


def bbox_enlargement(bbox, vector) -> Fraction:
    return bbox_volume(bbox_union_point(bbox, vector)) - bbox_volume(bbox)


def bbox_mindist(bbox, q) -> Fraction:
    """Exact lower bound on dist2 between q and any point inside bbox."""
    total = Fraction(0)
    for (lo, hi), x in zip(bbox, q):
        if x < lo:
            d = lo - x
            total += d * d
        elif x > hi:
            d = x - hi
            total += d * d
    return total


def point_in_bbox(bbox, vector) -> bool:
    return all(lo <= x <= hi for (lo, hi), x in zip(bbox, vector))


def bbox_widest_dim(bbox) -> int:
    best_dim = 0
    best_width = None
    for i, (lo, hi) in enumerate(bbox):
        width = hi - lo
        if best_width is None or width > best_width:
            best_width = width
            best_dim = i
    return best_dim


def bbox_center(bbox) -> tuple:
    half = Fraction(1, 2)
    return tuple((lo + hi) * half for lo, hi in bbox)

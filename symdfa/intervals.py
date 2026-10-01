"""Integer character-interval sets with overlap rejection.

Characters are integers in ``[0, alphabet_size)``.  A symbol is a set of
disjoint, non-adjacent closed intervals ``(lo, hi)`` kept in sorted order.
No per-character expansion happens anywhere: all operations are interval
arithmetic.
"""

from __future__ import annotations

from typing import Iterable, List, Sequence, Tuple

Interval = Tuple[int, int]


class IntervalError(ValueError):
    """Raised when intervals are malformed or overlap."""


def normalize(intervals: Iterable[Interval], alphabet_size: int) -> Tuple[Interval, ...]:
    """Validate and normalize an interval list.

    Rejects out-of-range bounds, ``lo > hi``, and overlapping or adjacent
    intervals (adjacent ones must have been merged by the caller, so their
    presence signals ambiguous input).
    """
    if alphabet_size <= 0:
        raise IntervalError("alphabet_size must be positive")
    items: List[Interval] = [(int(lo), int(hi)) for lo, hi in intervals]
    items.sort()
    out: List[Interval] = []
    for lo, hi in items:
        if lo > hi:
            raise IntervalError(f"empty interval ({lo}, {hi})")
        if lo < 0 or hi >= alphabet_size:
            raise IntervalError(
                f"interval ({lo}, {hi}) outside [0, {alphabet_size})"
            )
        if out:
            plo, phi = out[-1]
            if lo <= phi + 1:
                raise IntervalError(
                    f"intervals ({plo}, {phi}) and ({lo}, {hi}) overlap or touch"
                )
        out.append((lo, hi))
    return tuple(out)


def merge(intervals: Iterable[Interval]) -> Tuple[Interval, ...]:
    """Sort and coalesce touching/overlapping intervals (internal use)."""
    items = sorted((int(lo), int(hi)) for lo, hi in intervals)
    out: List[Interval] = []
    for lo, hi in items:
        if out and lo <= out[-1][1] + 1:
            out[-1] = (out[-1][0], max(out[-1][1], hi))
        else:
            out.append((lo, hi))
    return tuple(out)


def union(a: Sequence[Interval], b: Sequence[Interval]) -> Tuple[Interval, ...]:
    return merge(tuple(a) + tuple(b))


def intersect(a: Sequence[Interval], b: Sequence[Interval]) -> Tuple[Interval, ...]:
    out: List[Interval] = []
    i = j = 0
    while i < len(a) and j < len(b):
        lo = max(a[i][0], b[j][0])
        hi = min(a[i][1], b[j][1])
        if lo <= hi:
            out.append((lo, hi))
        if a[i][1] < b[j][1]:
            i += 1
        else:
            j += 1
    return tuple(out)


def complement(a: Sequence[Interval], alphabet_size: int) -> Tuple[Interval, ...]:
    out: List[Interval] = []
    nxt = 0
    for lo, hi in a:
        if nxt < lo:
            out.append((nxt, lo - 1))
        nxt = hi + 1
    if nxt < alphabet_size:
        out.append((nxt, alphabet_size - 1))
    return tuple(out)


def subtract(a: Sequence[Interval], b: Sequence[Interval]) -> Tuple[Interval, ...]:
    if not a or not b:
        return tuple(a)
    return _sub(a, b)


def _sub(a: Sequence[Interval], b: Sequence[Interval]) -> Tuple[Interval, ...]:
    out: List[Interval] = []
    for lo, hi in a:
        cur = lo
        for blo, bhi in b:
            if bhi < cur:
                continue
            if blo > hi:
                break
            if blo > cur:
                out.append((cur, min(blo - 1, hi)))
            cur = max(cur, bhi + 1)
            if cur > hi:
                break
        if cur <= hi:
            out.append((cur, hi))
    return tuple(out)


def is_subset(a: Sequence[Interval], b: Sequence[Interval]) -> bool:
    return not _sub(a, b)


def size(a: Sequence[Interval]) -> int:
    return sum(hi - lo + 1 for lo, hi in a)


def is_empty(a: Sequence[Interval]) -> bool:
    return len(a) == 0


def pick_char(a: Sequence[Interval]) -> int:
    """Smallest character covered by the interval set."""
    if not a:
        raise IntervalError("cannot pick from empty interval set")
    return a[0][0]


def iter_chars(a: Sequence[Interval]):
    """Expand to characters.  Only used by the naive reference oracle."""
    for lo, hi in a:
        yield from range(lo, hi + 1)

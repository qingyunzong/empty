"""Brzozowski derivatives and symbolic (interval) partitioning."""
from __future__ import annotations

from .syntax import (
    EMPTY, EPS, Node, char_ranges, compl, concat, inter,
    nullable, star, union,
)


_memo: dict = {}


def derive(node, c):
    """Derivative of `node` with respect to the single code point `c`."""
    key = (node, c)
    r = _memo.get(key)
    if r is None:
        r = _derive(node, c)
        _memo[key] = r
    return r


def _derive(node, c):
    t = node.tag
    if t == "empty" or t == "eps":
        return EMPTY
    if t == "char":
        lo, hi = node.args
        return EPS if lo <= c <= hi else EMPTY
    if t == "concat":
        first = node.args[0]
        rest = concat(*node.args[1:])
        r = concat(derive(first, c), rest)
        if nullable(first):
            r = union(r, derive(rest, c))
        return r
    if t == "union":
        return union(*(derive(a, c) for a in node.args))
    if t == "inter":
        return inter(*(derive(a, c) for a in node.args))
    if t == "compl":
        return compl(derive(node.args[0], c))
    if t == "star":
        return concat(derive(node.args[0], c), node)
    raise AssertionError(t)  # pragma: no cover


def partition(alphabet, *nodes):
    """Split the alphabet into atomic intervals on which every derivative
    of every given node is uniform.

    Collects all char-range endpoints occurring in the nodes and cuts each
    alphabet range at those points.  Because every char node is uniform on
    the resulting atoms, `derive(node, c)` is identical for all c in one
    returned interval, so a single representative (the interval's `lo`)
    characterizes the whole interval.
    """
    extra = set()
    for n in nodes:
        extra |= char_ranges(n)
    out = []
    for alo, ahi in alphabet.intervals():
        cuts = {alo, ahi + 1}
        for lo, hi in extra:
            cuts.add(lo)
            cuts.add(hi + 1)
        pts = sorted(c for c in cuts if alo <= c <= ahi + 1)
        for a, b in zip(pts, pts[1:]):
            if a <= b - 1:
                out.append((a, b - 1))
    return out
